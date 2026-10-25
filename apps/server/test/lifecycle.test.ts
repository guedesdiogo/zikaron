// A rotina diária do cofre (#17): o arquivo das tarefas encerradas e o relatório da memória, com
// dados sintéticos. Cada teste roda os alarmes à mão; «um dia depois» é zerar o `lifecycle_after`.
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

/** A próxima rotina fica para depois (`later`) ou vence agora, como um dia depois. */
async function dueIn(stub: Stub, later: boolean) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO state (key, value) VALUES ('lifecycle_after', ?)",
      later ? `${Date.now() + 10 * DAY}` : "0",
    );
  });
}

/** Dois alarmes: o que roda a rotina e põe na fila, e o que comita. */
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

/** O arquivo sem o `updated` nem o `archived`: o que o arquivo deve levar adiante. */
const carried = (text: string) =>
  text.replace(/^updated: .*\n/m, "").replace(/^archived: true\n/m, "");

describe("o arquivo das tarefas", () => {
  it("arquiva a concluída e a de 90 dias, com tudo o mais e a origem como estava", async () => {
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
    // Sem data, a tarefa vale pelo dia em que foi escrita, nunca depois do commit.
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
    // A origem é a da nota: a do Noah, de fora, pendente; nada se apagou.
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

    // A confiança não muda: o Alan continua sem ver a nota de fora; o Noah a vê como era.
    expect(await stub.readNote("alan", done)).toEqual({ ok: false, reason: "not_found" });
    const page = await stub.readNote("noah", done);
    expect(page.ok && page.text).toContain("origem: noah, de fora, pendente");
    expect(page.ok && page.text).toContain(" · archived · ");
    // Fora da busca, legível pelo caminho.
    const found = await stub.search("noah", "conta de luz", { k: 10 });
    expect(found.ok && found.notes.map((note) => note.path)).not.toContain(done);

    const page2 = report(backend);
    expect(page2).toContain("## Tarefas arquivadas");
    for (const path of [done, old, undated]) {
      expect(page2).toContain(`[[${path.slice(0, -3)}|`);
    }
    // Arquivadas, já não esperam o «sim» no relatório; a que ficou, sim.
    const waiting = page2.slice(
      page2.indexOf("## Esperam o «sim»"),
      page2.indexOf("## Tarefas arquivadas"),
    );
    expect(waiting).toContain(fresh.slice(0, -3));
    for (const path of [done, old, undated]) expect(waiting).not.toContain(path.slice(0, -3));

    // No dia seguinte, com o arquivo comitado, os mesmos achados: nenhum commit.
    const commits = backend.commitRequests.length;
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.commitRequests).toHaveLength(commits);
  });

  it("não muda a tarefa do dono, nem a dita pelo dono, nem a que o núcleo carrega", async () => {
    const owners = "memory/tasks/renovar-o-passaporte.md";
    const edited = "memory/tasks/consertar-a-pia.md";
    const backend = vaultWith({
      [owners]: "---\nstatus: done\n---\n\n# Renovar o passaporte\n\nFeito em outubro.\n",
      // O dono editou uma tarefa pendente e não tirou o `review`: continua dele.
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
    // Só o relatório foi escrito, com o seu resumo.
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

  it("o arquivo de uma tarefa «dita pelo dono» não conta como gravação nova do cliente", async () => {
    const backend = vaultWith();
    const stub = vault("ciclo-arquivo-nao-e-claim");
    await dueIn(stub, true);
    // O Alan não tem `ownerClaims`: a tarefa não vale como do dono, e a rotina a arquiva.
    const done = await written(stub, "alan", PROVIDER_OWNER, {
      title: "Enviar o relatório do condomínio",
      body: "Enviar até sexta.",
      kind: "task",
      status: "done",
    });
    await runDurableObjectAlarm(stub);
    // A gravação do Alan é de mais de uma semana atrás.
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
    // E no dia seguinte, com o arquivo já no índice, o relatório continua o mesmo.
    const page = report(backend);
    await dueIn(stub, false);
    await twice(stub);
    expect(report(backend)).toBe(page);
    expect(page).toContain("## Tarefas arquivadas");
    expect(page).not.toContain("## Ditas pelo dono, pelo provedor");
  });

  it("uma nota que não se regrava fica como está, e as outras seguem", async () => {
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

  it("a edição do dono enquanto o arquivo espera na fila ganha inteira, sem conflito", async () => {
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

describe("o arquivo das tarefas: o que a revisão do PR #18 pediu", () => {
  it("uma tarefa cuja versão é um merge com a edição do dono não é arquivada", async () => {
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
    // O Kelpie encerra a tarefa enquanto o dono, no Obsidian, acrescenta uma linha no fim.
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

  it("o arquivo leva o level adiante, também o explicit de quem perdeu o ownerClaims", async () => {
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

describe("o relatório", () => {
  it("lista o que o plano diz, só com links, e nada de nota nos logs", async () => {
    const ana = "memory/people/ana.md";
    const velho = "memory/notes/velho.md";
    const proprio = "memory/notes/proprio.md";
    const backend = vaultWith({
      [ana]: "# Ana\n\nMora em Lisboa.\n",
      [velho]: "# Velho\n\nApagar.\n",
      "memory/notes/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
      "knowledge/cozinha/receita.md": "# Receita de bolo\n\nTrês ovos.\n",
      "memory/sessions/2020/2020-01-05-conversa.md": "# Conversa antiga\n\nSobre o bolo.\n",
      // A edição do dono no próprio relatório não é uma nota do dono mudada.
      [LIFECYCLE_REPORT_PATH]: "# Relatório\n\nEditado à mão.\n",
    });
    const stub = vault("ciclo-relatorio");
    await dueIn(stub, true);
    const logs = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    await stub.write("kelpie", [{ path: proprio, content: "# Próprio\n\nUm.\n" }], "x");
    await runDurableObjectAlarm(stub);
    // O «corrija» pela conversa (ADR-0003): o Noah troca a nota do dono.
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
    // Uma remoção de uma nota do dono, e uma nova versão de uma nota do próprio servidor.
    await stub.write("kelpie", [{ path: velho, content: null }], "x");
    await stub.write("kelpie", [{ path: proprio, content: "# Próprio\n\nDois.\n" }], "x");
    // Uma mudança de mais de uma semana sai do relatório e da tabela.
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
    // A evidência, texto livre, nunca entra.
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
    // O relatório não é memória: nenhuma leitura o alcança.
    expect(await stub.readNote("noah", LIFECYCLE_REPORT_PATH)).toEqual({
      ok: false,
      reason: "not_found",
    });

    // Os logs só têm contagens e códigos.
    const lines = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    for (const secret of ["Ana", "ana.md", "Café", "Recado", "Velho", "velho", "receita", "bolo"]) {
      expect(lines).not.toContain(secret);
    }
    for (const spy of logs) spy.mockRestore();
  });

  it("os mesmos achados dão a mesma página, sem commit, e a página sai sem achados", async () => {
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

    // No mesmo dia, a rotina não roda de novo; um dia depois, os mesmos achados não mudam nada.
    await twice(stub);
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.commitRequests).toHaveLength(commits);
    expect(report(backend)).toBe(page);

    backend.push({ "knowledge/cozinha/receita.md": null });
    await twice(stub);
    // Ainda não é o dia seguinte: a página fica.
    expect(backend.files()).toHaveProperty(LIFECYCLE_REPORT_PATH);
    await dueIn(stub, false);
    await twice(stub);
    expect(backend.files()).not.toHaveProperty(LIFECYCLE_REPORT_PATH);
    expect(backend.commitRequests.at(-1)?.deletions).toEqual([LIFECYCLE_REPORT_PATH]);
  });

  it("roda no máximo uma vez por dia", async () => {
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

describe("a rotina falha sozinha", () => {
  it("uma falha deixa só o nome do erro no log, espera o dia seguinte e não segura as gravações", async () => {
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
    // O relatório não consegue gravar o que arquivou.
    await rows(stub, "DROP TABLE archived_tasks");
    const errors = vi.spyOn(console, "error");
    const write = await written(stub, "alan", TOOL_AGENT, {
      title: "Comprar café",
      body: "Café em grão.",
      kind: "task",
    });
    await dueIn(stub, false);
    await runDurableObjectAlarm(stub);
    // A gravação do cliente saiu no mesmo alarme, antes da rotina.
    expect(backend.files()).toHaveProperty(write);
    const failed = errors.mock.calls.find(([line]) => line === "Vault: the daily routine failed");
    expect(failed).toHaveLength(2);
    expect(failed?.[1]).toMatch(/^\w+$/);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("condom");
    errors.mockRestore();
    // A próxima tentativa é amanhã, e o alarme continua armado.
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

  it("sem a configuração dos clientes, nada é arquivado, e o relatório sai assim mesmo", async () => {
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

  it("espera o índice que não alcança o head, e tenta de novo no próximo alarme", async () => {
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

describe("as mudanças nas notas do dono", () => {
  it("contam um commit cuja resposta se perdeu, quando a sincronização o acha", async () => {
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
        // A nota do próprio servidor: trocar a versão dele não é mudança do dono.
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

  it("o «esqueça» do dono tira o relatório da fila e faz a rotina rodar de novo", async () => {
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
