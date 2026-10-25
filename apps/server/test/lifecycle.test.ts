// The vault's daily routine (#17): archiving closed tasks and the memory report, with synthetic
// data. Each test runs the alarms by hand; "a day later" means zeroing `lifecycle_after`.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIFECYCLE_REPORT_PATH } from "@zikaron/memory";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it, vi } from "vitest";
import { replaceBackendForTesting } from "../src/index.ts";
import type { MemoryWriteInput, NoteClaim } from "../src/notes.ts";

const DAY = 86_400_000;
const vault = (name: string) => env.VAULT.getByName(name);
type Stub = ReturnType<typeof vault>;

function vaultWith(files: Record<string, string> = {}): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

async function rows(stub: Stub, sql: string, ...bindings: unknown[]) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec(sql, ...bindings).toArray(),
  );
}

/** The next routine is put off (`later`) or is due now, as a day later. */
async function dueIn(stub: Stub, later: boolean) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO state (key, value) VALUES ('lifecycle_after', ?)",
      later ? `${Date.now() + 10 * DAY}` : "0",
    );
  });
}

/** Two alarms: the one that runs the routine and queues, and the one that commits. */
async function twice(stub: Stub) {
  await runDurableObjectAlarm(stub);
  await runDurableObjectAlarm(stub);
}

const report = (backend: FakeVaultBackend) => backend.files()[LIFECYCLE_REPORT_PATH] ?? "";
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

const TOOL_EXTERNAL: NoteClaim = { channel: "tool", source: "external", evidence: "gmail:msg/1" };
const TOOL_AGENT: NoteClaim = { channel: "tool", source: "agent" };
const PROVIDER_OWNER: NoteClaim = {
  channel: "provider",
  source: "owner",
  evidence: "telegram:msg/7",
};

async function written(
  stub: Stub,
  client: string,
  claim: NoteClaim,
  input: MemoryWriteInput,
): Promise<string> {
  const result = await stub.writeNote(client, claim, input);
  if (!result.ok) throw new Error(`not written: ${result.reason}`);
  return result.path;
}

/** The file without `updated` or `archived`: what archiving must carry over. */
const carried = (text: string) =>
  text.replace(/^updated: .*\n/m, "").replace(/^archived: true\n/m, "");

describe("the task archive", () => {
  it("archives the done task and the one past 90 days, with everything else and the origin as it was", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-arquiva");
    await dueIn(stub, true);
    const done = await written(stub, "noah", TOOL_EXTERNAL, {
      title: "Pagar a conta de luz",
      body: "Pagar a conta de luz pelo app do banco.",
      kind: "task",
      status: "done",
      entities: ["Conta de luz"],
      abstract: "A conta de luz de outubro.",
    });
    const old = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Trocar o filtro da água",
      body: "Pedir ao zelador que troque o filtro.",
      kind: "delegation",
      status: "open",
      validFrom: daysAgo(120),
    });
    const fresh = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Comprar pilhas",
      body: "Pilhas para o controle remoto.",
      kind: "task",
      status: "open",
      validFrom: daysAgo(10),
    });
    const undated = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Ligar para o seguro",
      body: "Perguntar sobre a renovação.",
      kind: "task",
      status: "open",
    });
    await runDurableObjectAlarm(stub);
    const before = backend.files();
    // Without a date, the task counts from the day it was written, never after the commit.
    await rows(
      stub,
      "UPDATE versions SET recorded_at = ? WHERE path = ? AND is_current = 1",
      Date.now() - 100 * DAY,
      undated,
    );

    await dueIn(stub, false);
    await twice(stub);
    const after = backend.files();
    for (const path of [done, old, undated]) {
      expect(after[path], path).toContain("archived: true");
      expect(carried(after[path] ?? ""), path).toBe(carried(before[path] ?? ""));
    }
    expect(after[fresh]).toBe(before[fresh]);
    // The origin is the note's: Noah's, from outside, pending; nothing was deleted.
    expect(after[done]).toContain(
      "origin:\n  client: noah\n  channel: tool\n  source: external\n  evidence: gmail:msg/1\n  review: pending\n",
    );
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before), LIFECYCLE_REPORT_PATH].sort(),
    );
    expect(backend.commitRequests.flatMap((request) => request.deletions)).toEqual([]);
    const archive = backend.commitRequests.at(-1);
    expect(archive?.headline).toBe("Arquiva tarefas encerradas");
    expect(archive?.body).toBe("Zikaron-Client: zikaron");
    expect(archive?.writes.map((write) => write.path).sort()).toEqual(
      [done, old, undated, LIFECYCLE_REPORT_PATH].sort(),
    );

    // Trust doesn't change: Alan still can't see the outside note; Noah sees it as it was.
    expect(await stub.readNote("alan", done)).toEqual({ ok: false, reason: "not_found" });
    const page = await stub.readNote("noah", done);
    expect(page.ok && page.text).toContain("origem: noah, de fora, pendente");
    expect(page.ok && page.text).toContain(" · archived · ");
    // Out of search, readable by path.
    const found = await stub.search("noah", "conta de luz", { k: 10 });
    expect(found.ok && found.notes.map((note) => note.path)).not.toContain(done);

    const page2 = report(backend);
    expect(page2).toContain("## Tarefas arquivadas");
    for (const path of [done, old, undated]) {
      expect(page2).toContain(`[[${path.slice(0, -3)}|`);
    }
    // Once archived, they no longer wait for the "yes" in the report; the one left still does.
    const waiting = page2.slice(
      page2.indexOf("## Esperam o «sim»"),
      page2.indexOf("## Tarefas arquivadas"),
    );
    expect(waiting).toContain(fresh.slice(0, -3));
    for (const path of [done, old, undated]) expect(waiting).not.toContain(path.slice(0, -3));

    // The next day, with the archive committed, the same findings: no commit.
    const commits = backend.commitRequests.length;
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.commitRequests).toHaveLength(commits);
  });

  it("doesn't change the owner's task, nor one said by the owner, nor one the core carries", async () => {
    const owners = "memory/tasks/renovar-o-passaporte.md";
    const edited = "memory/tasks/consertar-a-pia.md";
    const backend = vaultWith({
      [owners]: "---\nstatus: done\n---\n\n# Renovar o passaporte\n\nFeito em outubro.\n",
      // The owner edited a pending task and didn't remove the `review`: it's still the owner's.
      [edited]:
        "---\nstatus: done\norigin:\n  client: noah\n  channel: tool\n  source: agent\n  review: pending\n---\n\n# Consertar a pia\n\nO encanador veio.\n",
    });
    const stub = vault("ciclo-nao-arquiva");
    await dueIn(stub, true);
    const claimed = await written(stub, "noah", PROVIDER_OWNER, {
      title: "Marcar o dentista",
      body: "O Diogo marcou o dentista para terça.",
      kind: "task",
      status: "done",
    });
    const pending =
      "origin:\n  client: noah\n  channel: tool\n  source: agent\n  review: pending\n";
    const pinned = "agents/noah/memory/tasks/lembrete-fixo.md";
    const profile = "memory/profile/agenda-da-semana.md";
    await stub.write(
      "noah",
      [
        {
          path: pinned,
          content: `---\nkind: task\nstatus: done\npinned: true\n${pending}---\n\n# Lembrete fixo\n\nSempre à vista.\n`,
        },
        {
          path: profile,
          content: `---\nkind: task\nstatus: done\n${pending}---\n\n# Agenda da semana\n\nDo perfil.\n`,
        },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    const before = backend.files();
    const commits = backend.commitRequests.length;

    await dueIn(stub, false);
    await twice(stub);
    const after = backend.files();
    for (const path of [owners, edited, claimed, pinned, profile]) {
      expect(after[path], path).toBe(before[path]);
    }
    // Only the report was written, with its summary.
    expect(backend.commitRequests.slice(commits).map((request) => request.headline)).toEqual([
      "Atualiza o relatório da memória",
    ]);
    const page = report(backend);
    expect(page).toContain("## Tarefas do dono para arquivar");
    const listed = page
      .slice(page.indexOf("## Tarefas do dono para arquivar"))
      .split("\n\n")[2]
      ?.trim();
    expect(listed).toBe(
      [
        `- [[${edited.slice(0, -3)}|Consertar a pia]]`,
        `- [[${claimed.slice(0, -3)}|Marcar o dentista]]`,
        `- [[${owners.slice(0, -3)}|Renovar o passaporte]]`,
      ].join("\n"),
    );
    expect(page).not.toContain("## Tarefas arquivadas");
  });

  it('archiving a task "said by the owner" doesn\'t count as a new write by the client', async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-arquivo-nao-e-claim");
    await dueIn(stub, true);
    // Alan has no `ownerClaims`: the task isn't owner-grade, and the routine archives it.
    const done = await written(stub, "alan", PROVIDER_OWNER, {
      title: "Enviar o relatório do condomínio",
      body: "Enviar até sexta.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    // Alan's write is from more than a week ago.
    await rows(
      stub,
      "UPDATE versions SET recorded_at = ? WHERE path = ? AND is_current = 1",
      Date.now() - 10 * DAY,
      done,
    );
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()[done]).toContain("archived: true");
    expect(backend.files()[done]).toContain(
      "origin:\n  client: alan\n  channel: provider\n  source: owner\n",
    );
    // And the next day, with the archive already in the index, the report stays the same.
    const page = report(backend);
    await dueIn(stub, false);
    await twice(stub);
    expect(report(backend)).toBe(page);
    expect(page).toContain("## Tarefas arquivadas");
    expect(page).not.toContain("## Ditas pelo dono, pelo provedor");
  });

  it("a note that can't be rewritten stays as it is, and the others go on", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-falha-nota");
    await dueIn(stub, true);
    const empty = "memory/tasks/vazia.md";
    await stub.write(
      "kelpie",
      [
        {
          path: empty,
          content:
            "---\nkind: task\nstatus: done\norigin:\n  client: kelpie\n  channel: tool\n  source: agent\n  review: pending\n---\n\n# Vazia\n",
        },
      ],
      "x",
    );
    const done = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Devolver o livro",
      body: "Devolver o livro à biblioteca.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    const logged = vi.spyOn(console, "log");
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()[empty]).not.toContain("archived");
    expect(backend.files()[done]).toContain("archived: true");
    expect(logged).toHaveBeenCalledWith("Vault: the daily routine looked at the tasks", {
      archived: 1,
      owners: 0,
      failed: 1,
    });
    logged.mockRestore();
  });

  it("the owner's edit while the archive waits in the queue wins whole, with no conflict", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-corrida");
    await dueIn(stub, true);
    const done = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Lavar o carro",
      body: "Lavar o carro no sábado.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    await dueIn(stub, false);
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT path FROM archived_tasks")).toEqual([{ path: done }]);
    const edit = (backend.files()[done] ?? "").replace("no sábado", "no domingo");
    backend.push({ [done]: edit });
    await runDurableObjectAlarm(stub);
    expect(backend.files()[done]).toBe(edit);
    expect(await rows(stub, "SELECT count(*) AS n FROM conflicts")).toEqual([{ n: 0 }]);
    expect(await rows(stub, "SELECT count(*) AS n FROM archived_tasks")).toEqual([{ n: 0 }]);
    expect(await rows(stub, "SELECT count(*) AS n FROM queue")).toEqual([{ n: 0 }]);
  });
});

describe("the task archive: what the PR #18 review asked for", () => {
  it("a task whose version is a merge with the owner's edit isn't archived", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-merge-dono");
    await dueIn(stub, true);
    const path = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Trocar o filtro",
      body: "Trocar o filtro da água.\n\nComprar o filtro novo.",
      kind: "task",
      status: "open",
    });
    await runDurableObjectAlarm(stub);
    const version = ((await stub.readNote("kelpie", path, {})) as { version: string }).version;
    // Kelpie closes the task while the owner, in Obsidian, adds a line at the end.
    const closed = await stub.writeNote("kelpie", TOOL_AGENT, {
      title: "Trocar o filtro",
      body: "Trocar o filtro da água.\n\nComprar o filtro novo.",
      kind: "task",
      status: "done",
      path,
      version,
    });
    expect(closed).toMatchObject({ ok: true });
    backend.push({ [path]: `${backend.files()[path] ?? ""}\nO filtro é o de 10 polegadas.\n` });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 1 }]);
    const merged = backend.files()[path] ?? "";
    expect(merged).toContain("status: done");
    expect(merged).toContain("10 polegadas");
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()[path]).toBe(merged);
    expect(await rows(stub, "SELECT count(*) AS n FROM archived_tasks")).toEqual([{ n: 0 }]);
    expect(report(backend)).toContain("Tarefas do dono para arquivar");
  });

  it("archiving carries the level over, also the explicit one of a client that lost ownerClaims", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-level");
    await dueIn(stub, true);
    const path = await written(stub, "noah", PROVIDER_OWNER, {
      title: "Pagar a conta de luz",
      body: "Pagar a conta de luz.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    expect(backend.files()[path]).toContain("level: explicit");
    const original = env.ZIKARON_CLIENTS;
    const revoked = JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(original) as Record<string, Record<string, unknown>>).map(
          ([id, client]) => [
            id,
            client.name === "noah" ? { ...client, ownerClaims: false } : client,
          ],
        ),
      ),
    );
    try {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: { ZIKARON_CLIENTS: string } }).env.ZIKARON_CLIENTS = revoked;
      });
      await dueIn(stub, false);
      await twice(stub);
      const archived = backend.files()[path] ?? "";
      expect(archived).toContain("archived: true");
      expect(archived).toContain("level: explicit");
      expect(archived).toContain("source: owner");
    } finally {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: { ZIKARON_CLIENTS: string } }).env.ZIKARON_CLIENTS =
          original;
      });
    }
  });
});

describe("the report", () => {
  it("lists what the plan says, only with links, and nothing from a note in the logs", async () => {
    const ana = "memory/people/ana.md";
    const velho = "memory/notes/velho.md";
    const proprio = "memory/notes/proprio.md";
    const backend = vaultWith({
      [ana]: "# Ana\n\nMora em Lisboa.\n",
      [velho]: "# Velho\n\nApagar.\n",
      "memory/notes/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
      "knowledge/cozinha/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
      "memory/sessions/2020/2020-01-05-conversa.md": "# Conversa antiga\n\nSobre o bolo.\n",
      // The owner's edit to the report itself isn't a changed owner's note.
      [LIFECYCLE_REPORT_PATH]: "# Relatório\n\nEditado à mão.\n",
    });
    const stub = vault("ciclo-relatorio");
    await dueIn(stub, true);
    const logs = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    await stub.write("kelpie", [{ path: proprio, content: "# Próprio\n\nUm.\n" }], "x");
    await runDurableObjectAlarm(stub);
    // The "fix it" through the conversation (ADR-0003): Noah replaces the owner's note.
    const version = (await stub.readNote("noah", ana)) as { version: string };
    await written(stub, "noah", PROVIDER_OWNER, {
      path: ana,
      version: version.version,
      title: "Ana",
      body: "Mora no Porto.",
      kind: "person",
    });
    const cafe = await written(stub, "noah", PROVIDER_OWNER, {
      title: "Café sem açúcar",
      body: "O Diogo toma café sem açúcar.",
      kind: "preference",
    });
    const recado = await written(stub, "noah", TOOL_EXTERNAL, {
      title: "Recado [[da]] | Ana",
      body: "Um recado lido num e-mail.",
      kind: "note",
    });
    const conclusao = await written(stub, "alan", TOOL_AGENT, {
      title: "A Ana prefere chá",
      body: "Ela pediu chá duas vezes.",
      kind: "preference",
    });
    // A removal of an owner's note, and a new version of a note by the server itself.
    await stub.write("kelpie", [{ path: velho, content: null }], "x");
    await stub.write("kelpie", [{ path: proprio, content: "# Próprio\n\nDois.\n" }], "x");
    // A change from more than a week ago leaves the report and the table.
    await rows(
      stub,
      "INSERT INTO owner_changes (path, at, removed, client) VALUES ('memory/notes/antiga.md', 1, 0, 'noah')",
    );
    await dueIn(stub, false);
    await twice(stub);

    const page = report(backend);
    const today = new Date().toISOString().slice(0, 10);
    expect(page).toContain("# Relatório da memória");
    expect(page).toContain(
      `## Notas do dono que um cliente mudou\n\nNotas que valiam como do dono e que a gravação de um cliente substituiu ou removeu na última semana. As mais recentes primeiro, com o último dia e quem mudou. O git guarda cada versão anterior.\n\n`,
    );
    expect(page).toContain(`- [[memory/people/ana|Ana]]: mudada por noah em ${today}`);
    expect(page).toContain(`- \`${velho}\`: removida por kelpie em ${today}`);
    expect(page).not.toContain("notes/antiga");
    expect(page).not.toContain(proprio.slice(0, -3));
    expect(page).toContain(
      `## Ditas pelo dono, pelo provedor\n\nO que cada cliente gravou na última semana como dito pelo dono, pelo provedor, com o dia. A evidência fica na nota. Desligar o \`ownerClaims\` de um cliente vale na hora.\n\n### noah\n\n- [[memory/people/ana|Ana]]: ${today}\n- [[${cafe.slice(0, -3)}|Café sem açúcar]]: ${today}`,
    );
    // The evidence, free text, never goes in.
    expect(page).not.toContain("telegram:msg/7");
    expect(page).not.toContain("gmail:msg/1");
    expect(page).toContain(
      `### alan\n\n- [[${conclusao.slice(0, -3)}|A Ana prefere chá]]\n\n### noah\n\n- [[${recado.slice(0, -3)}|Recado da Ana]]`,
    );
    expect(page).toContain(
      "## Notas frias\n\nNotas episódicas, como sessões, eventos e tarefas, que o tempo esfriou. Ficam onde estão.\n\n- [[memory/sessions/2020/2020-01-05-conversa|Conversa antiga]]: escrita em 2020-01-05",
    );
    expect(page).toContain(
      "## Duplicadas\n\n- O mesmo conteúdo: [[knowledge/cozinha/receita|Receita de bolo]], [[memory/notes/receita|Receita de bolo]]",
    );
    expect(
      await rows(stub, "SELECT path, removed, client FROM owner_changes ORDER BY path"),
    ).toEqual([
      { path: velho, removed: 1, client: "kelpie" },
      { path: ana, removed: 0, client: "noah" },
    ]);
    // The report isn't memory: no read reaches it.
    expect(await stub.readNote("noah", LIFECYCLE_REPORT_PATH)).toEqual({
      ok: false,
      reason: "not_found",
    });

    // The logs only have counts and codes.
    const lines = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    for (const secret of ["Ana", "ana.md", "Café", "Recado", "Velho", "velho", "receita", "bolo"]) {
      expect(lines).not.toContain(secret);
    }
    for (const spy of logs) spy.mockRestore();
  });

  it("the same findings give the same page, with no commit, and the page goes away without findings", async () => {
    const backend = vaultWith({
      "memory/notes/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
      "knowledge/cozinha/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
    });
    const stub = vault("ciclo-idempotente");
    await stub.read("README.md");
    await twice(stub);
    const page = report(backend);
    expect(page).toContain("## Duplicadas");
    expect(backend.commitRequests.at(-1)?.headline).toBe("Atualiza o relatório da memória");
    const commits = backend.commitRequests.length;

    // The same day, the routine doesn't run again; a day later, the same findings change nothing.
    await twice(stub);
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.commitRequests).toHaveLength(commits);
    expect(report(backend)).toBe(page);

    backend.push({ "knowledge/cozinha/receita.md": null });
    await twice(stub);
    // It isn't the next day yet: the page stays.
    expect(backend.files()).toHaveProperty(LIFECYCLE_REPORT_PATH);
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()).not.toHaveProperty(LIFECYCLE_REPORT_PATH);
    expect(backend.commitRequests.at(-1)?.deletions).toEqual([LIFECYCLE_REPORT_PATH]);
  });

  it("runs at most once a day", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-uma-vez");
    await stub.read("README.md");
    await twice(stub);
    const after = Number(
      (
        (await rows(stub, "SELECT value FROM state WHERE key = 'lifecycle_after'"))[0] as {
          value: string;
        }
      ).value,
    );
    expect(after).toBeGreaterThan(Date.now() + DAY - 60_000);
    const done = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Regar as plantas",
      body: "Regar as plantas da varanda.",
      kind: "task",
      status: "done",
    });
    await twice(stub);
    expect(backend.files()[done]).not.toContain("archived");
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()[done]).toContain("archived: true");
  });
});

describe("the routine fails in isolation", () => {
  it("a failure leaves only the error's name in the log, waits for the next day and doesn't hold up writes", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-falha");
    await dueIn(stub, true);
    const done = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Pagar o condomínio",
      body: "Pagar o condomínio de outubro.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    // The report can't write down what it archived.
    await rows(stub, "DROP TABLE archived_tasks");
    const errors = vi.spyOn(console, "error");
    const write = await written(stub, "alan", TOOL_AGENT, {
      title: "Comprar café",
      body: "Café em grão.",
      kind: "task",
    });
    await dueIn(stub, false);
    await runDurableObjectAlarm(stub);
    // The client's write went out in the same alarm, before the routine.
    expect(backend.files()).toHaveProperty(write);
    const failed = errors.mock.calls.find(([line]) => line === "Vault: the daily routine failed");
    expect(failed).toHaveLength(2);
    expect(failed?.[1]).toMatch(/^\w+$/);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("condom");
    errors.mockRestore();
    // The next try is tomorrow, and the alarm stays set.
    const after = (
      await rows(stub, "SELECT value FROM state WHERE key = 'lifecycle_after'")
    )[0] as {
      value: string;
    };
    expect(Number(after.value)).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
    expect(backend.files()[done]).not.toContain("archived");
  });

  it("without the client configuration, nothing is archived, and the report goes out anyway", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-sem-configuracao");
    await dueIn(stub, true);
    const done = await written(stub, "kelpie", TOOL_AGENT, {
      title: "Buscar a encomenda",
      body: "Buscar a encomenda na portaria.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: { ZIKARON_CLIENTS: string } }).env.ZIKARON_CLIENTS = "{";
    });
    const errors = vi.spyOn(console, "error");
    await dueIn(stub, false);
    await twice(stub);
    expect(errors).toHaveBeenCalledWith(
      "Vault: the daily routine can't read the clients; it archives nothing",
    );
    errors.mockRestore();
    expect(backend.files()[done]).not.toContain("archived");
    expect(report(backend)).toContain(`[[${done.slice(0, -3)}|Buscar a encomenda]]`);
  });

  it("waits for an index that doesn't reach the head, and tries again on the next alarm", async () => {
    vaultWith({ "memory/notes/a.md": "# A\n\nUm.\n", "knowledge/a.md": "# A\n\nUm.\n" });
    const stub = vault("ciclo-indice");
    await dueIn(stub, true);
    await stub.read("README.md");
    const errors = vi.spyOn(console, "error");
    await rows(stub, "UPDATE state SET value = 'outro' WHERE key = 'index_commit'");
    await rows(stub, "DROP TABLE versions");
    await dueIn(stub, false);
    await runDurableObjectAlarm(stub);
    expect(errors).toHaveBeenCalledWith(
      "Vault: the daily routine waits for the index",
      expect.any(String),
    );
    errors.mockRestore();
    expect(await rows(stub, "SELECT value FROM state WHERE key = 'lifecycle_after'")).toEqual([
      { value: "0" },
    ]);
  });
});

describe("the changes to the owner's notes", () => {
  it("count a commit whose answer was lost, when the sync finds it", async () => {
    const cha = "memory/notes/cha.md";
    const velho = "memory/notes/velho.md";
    const pao = "memory/notes/pao.md";
    const backend = vaultWith({ [cha]: "# Chá\n\nVerde.\n", [velho]: "# Velho\n\nApagar.\n" });
    const stub = vault("ciclo-resposta-perdida");
    await dueIn(stub, true);
    const commit = backend.commit.bind(backend);
    let lose = false;
    backend.commit = async (request) => {
      const outcome = await commit(request);
      if (lose) {
        lose = false;
        throw new Error("GitHub commit answered 502");
      }
      return outcome;
    };
    await stub.write("kelpie", [{ path: pao, content: "# Pão\n\nIntegral.\n" }], "x");
    await runDurableObjectAlarm(stub);
    lose = true;
    await stub.write(
      "kelpie",
      [
        { path: cha, content: "# Chá\n\nPreto.\n" },
        { path: velho, content: null },
        // The server's own note: replacing its version isn't an owner's change.
        { path: pao, content: "# Pão\n\nCom sal.\n" },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()[cha]).toBe("# Chá\n\nPreto.\n");
    expect(backend.files()[velho]).toBeUndefined();
    expect(
      await rows(stub, "SELECT path, removed, client FROM owner_changes ORDER BY path"),
    ).toEqual([
      { path: cha, removed: 0, client: "kelpie" },
      { path: velho, removed: 1, client: "kelpie" },
    ]);
  });

  it('the owner\'s "forget" takes the report out of the queue and makes the routine run again', async () => {
    const backend = vaultWith({ "memory/notes/a.md": "# A\n\nUm.\n" });
    const stub = vault("ciclo-esqueca");
    await dueIn(stub, true);
    await stub.read("README.md");
    await rows(
      stub,
      "INSERT INTO queue (client, path, content, summary, queued_at) VALUES ('zikaron', ?, '[[memory/notes/a|A]]', 'x', 1)",
      LIFECYCLE_REPORT_PATH,
    );
    await rows(
      stub,
      "INSERT INTO conflicts (client, path, content, reason, at) VALUES ('zikaron', ?, '[[memory/notes/a|A]]', 'owner_won', 1)",
      LIFECYCLE_REPORT_PATH,
    );
    await rows(
      stub,
      "INSERT INTO owner_changes (path, at, removed, client) VALUES ('memory/notes/a.md', ?, 0, 'noah')",
      Date.now(),
    );
    backend.forcePush({ "README.md": "# Vault" });
    expect(await stub.forget(["memory/notes/a.md"])).toMatchObject({ ok: true });
    expect(
      await rows(
        stub,
        `SELECT (SELECT count(*) FROM queue WHERE path = ?1) + (SELECT count(*) FROM conflicts WHERE path = ?1)
           + (SELECT count(*) FROM owner_changes) AS n`,
        LIFECYCLE_REPORT_PATH,
      ),
    ).toEqual([{ n: 0 }]);
    expect(await rows(stub, "SELECT value FROM state WHERE key = 'lifecycle_after'")).toEqual([
      { value: "0" },
    ]);
  });
});
