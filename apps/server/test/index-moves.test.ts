// O índice anda junto com cada sync e cada commit, sem depender do catch-up; segue um head que
// voltou atrás; e as duas correções da revisão do PR #10.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it } from "vitest";
import { replaceBackendForTesting } from "../src/index.ts";

const vault = (name: string) => env.VAULT.getByName(name);

function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Cofre", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

async function rows(stub: ReturnType<typeof vault>, sql: string) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(sql).toArray());
}

/** O head do cofre e o head a que o índice chegou. */
async function heads(stub: ReturnType<typeof vault>) {
  return runInDurableObject(stub, (_instance, state) => {
    const value = (key: string) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
        .toArray()[0]?.value;
    return { index: value("index_head"), head: value("head") };
  });
}

async function currentPaths(stub: ReturnType<typeof vault>): Promise<string[]> {
  const found = (await rows(
    stub,
    "SELECT path FROM versions WHERE is_current = 1 ORDER BY path",
  )) as { path: string }[];
  return found.map((row) => row.path);
}

describe("o índice segue o cofre", () => {
  it("anda com cada commit e cada sync, antes de qualquer catch-up", async () => {
    const backend = vaultWith({ "memory/people/ana.md": "# Ana\n\nLisboa.\n" });
    const stub = vault("indice-anda");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [{ path: "memory/people/bruno.md", content: "# Bruno\n\nSócio.\n" }],
      "x",
    );
    // O alarme faz o catch-up antes do trabalho do GitHub; depois dele, só o commit move o índice.
    await runDurableObjectAlarm(stub);
    let at = await heads(stub);
    expect(at.index).toBe(at.head);
    expect(await currentPaths(stub)).toContain("memory/people/bruno.md");

    backend.push({ "memory/people/ana.md": null });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    at = await heads(stub);
    expect(at.index).toBe(at.head);
    expect(await currentPaths(stub)).not.toContain("memory/people/ana.md");
  });

  it("segue um head que mudou depois de o índice recomeçar", async () => {
    const backend = vaultWith({ "memory/people/ana.md": "# Ana\n" });
    const stub = vault("indice-recomeca");
    await stub.read("README.md");
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    });
    backend.push({ "memory/people/carla.md": "# Carla\n" });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    const at = await heads(stub);
    expect(at.index).toBe(await backend.branchHead("main"));
    expect(await currentPaths(stub)).toEqual(["memory/people/ana.md", "memory/people/carla.md"]);
  });

  it("esquece uma nota quando o dono volta o branch para antes dela", async () => {
    const backend = vaultWith({ "memory/people/ana.md": "# Ana\n" });
    const stub = vault("indice-rewind");
    await stub.read("README.md");
    const before = (await backend.branchHead("main")) ?? "";
    backend.push({ "memory/people/carla.md": "# Carla\n" });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect(await currentPaths(stub)).toContain("memory/people/carla.md");
    await backend.deleteBranch("main");
    await backend.createBranch("main", before);
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect(await stub.read("memory/people/carla.md")).toBeNull();
    expect(await currentPaths(stub)).not.toContain("memory/people/carla.md");
  });
});

describe("as correções da revisão", () => {
  it("uma gravação feita antes do primeiro sync parte do arquivo que já está no cofre", async () => {
    const backend = vaultWith({ "memory/people/ana.md": "# Ana\n\nLisboa.\n" });
    const stub = vault("grava-antes-do-sync");
    expect(
      await stub.write(
        "alfa",
        [{ path: "memory/people/ana.md", content: "# Ana\n\nLisboa.\n\nCafé.\n" }],
        "x",
      ),
    ).toEqual({ ok: true });
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe("# Ana\n\nLisboa.\n\nCafé.\n");
    expect(await rows(stub, "SELECT count(*) AS n FROM conflicts")).toEqual([{ n: 0 }]);
  });

  it("a marca de merge sai com a versão dela", async () => {
    const ana = "memory/people/ana.md";
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ [ana]: base });
    const stub = vault("marca-de-merge");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: ana, content: base.replace("café", "chá") }], "x");
    backend.push({ [ana]: base.replace("Lisboa", "Braga") });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 1 }]);
    backend.push({ [ana]: null });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect(await stub.read(ana)).toBeNull();
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 0 }]);
  });
});
