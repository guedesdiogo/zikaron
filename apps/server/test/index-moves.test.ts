// The index moves along with each sync and each commit, without relying on the catch-up; it follows
// a head that went back; and the two fixes from the PR #10 review.
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

/** The vault's head and the head the index has reached. */
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

describe("the index follows the vault", () => {
  it("moves with each commit and each sync, before any catch-up", async () => {
    const backend = vaultWith({ "memory/people/ana.md": "# Ana\n\nLisboa.\n" });
    const stub = vault("indice-anda");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [{ path: "memory/people/bruno.md", content: "# Bruno\n\nSócio.\n" }],
      "x",
    );
    // The alarm catches up before the GitHub work; after that, only the commit moves the index.
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

  it("follows a head that changed after the index started over", async () => {
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

  it("forgets a note when the owner moves the branch back to before it", async () => {
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

describe("the review fixes", () => {
  it("a write made before the first sync starts from the file already in the vault", async () => {
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

  it("a merge mark goes with its version", async () => {
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
