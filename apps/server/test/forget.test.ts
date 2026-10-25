import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it, vi } from "vitest";
import { replaceBackendForTesting } from "../src/index.ts";

const vault = (name: string) => env.VAULT.getByName(name);

describe("Vault forget", () => {
  const ana = "memory/people/ana.md";
  const bia = "memory/people/bia.md";
  const leaked = "# Ana\n\nMora em Lisboa. Senha do wifi: girassol-42.\n";
  const clean = "# Ana\n\nMora em Lisboa.\n";

  it("drops old versions and the rows that name the paths, and keeps the rest", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      [ana]: leaked,
      [bia]: "# Bia\n",
    });
    replaceBackendForTesting(backend);
    const stub = vault("forget");
    await stub.read("README.md");
    await runDurableObjectAlarm(stub);
    backend.push({ [ana]: clean });
    await runDurableObjectAlarm(stub);
    await stub.write("alfa", [{ path: ana, content: `${clean}\nGosta de café.\n` }], "x");
    const sql = (query: string) =>
      runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(query).toArray());
    await runInDurableObject(stub, (_instance, state) => {
      for (const path of [ana, bia]) {
        state.storage.sql.exec(
          "INSERT INTO conflicts (client, path, content, reason, at) VALUES ('alfa', ?, 'x', 'owner_won', 1)",
          path,
        );
        // The mark with the file's text after the push: the sync's pruning only takes stale marks.
        state.storage.sql.exec(
          "INSERT INTO owner_merges (path, content) VALUES (?, ?)",
          path,
          path === bia ? "# Bia\n\nNova.\n" : "x",
        );
        state.storage.sql.exec("INSERT INTO authored (path, blob_sha) VALUES (?, 'sha')", path);
      }
      // A hold whose file has already changed: nothing shows it anymore.
      state.storage.sql.exec(
        "INSERT INTO held (path, content, previous, at) VALUES (?, 'x', NULL, 1)",
        ana,
      );
    });
    expect(await sql(`SELECT count(*) AS n FROM versions WHERE path = '${ana}'`)).toEqual([
      { n: 2 },
    ]);

    // The owner rewrote the history, so the leaked version is gone from git.
    // Its current files changed too: forgetting syncs before it rebuilds.
    backend.forcePush({ "README.md": "# Vault", [ana]: clean, [bia]: "# Bia\n\nNova.\n" });
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await stub.forget([ana])).toEqual({ ok: true, forgotten: 5, stillInVault: [ana] });
    const lines = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    // The log carries only counts, never the paths.
    expect(lines).toContain("forgot erased content");
    expect(lines).not.toContain("ana");

    expect(await sql("SELECT path FROM versions ORDER BY path")).toEqual([
      { path: ana },
      { path: bia },
    ]);
    expect(await sql(`SELECT body FROM versions WHERE path = '${ana}'`)).toEqual([
      { body: expect.not.stringContaining("girassol") },
    ]);
    for (const table of ["queue", "conflicts", "held", "authored", "owner_merges"]) {
      expect(await sql(`SELECT count(*) AS n FROM ${table} WHERE path = '${ana}'`)).toEqual([
        { n: 0 },
      ]);
    }
    for (const table of ["conflicts", "authored", "owner_merges"]) {
      expect(await sql(`SELECT path FROM ${table}`)).toEqual([{ path: bia }]);
    }
    expect(await sql(`SELECT body FROM versions WHERE path = '${bia}'`)).toEqual([
      { body: expect.stringContaining("Nova.") },
    ]);
    // The queued write that named the path went with it.
    expect(await stub.read(ana)).toBe(clean);
    // The rebuilt index stands at the head, so the next alarm doesn't index it all over again.
    await runDurableObjectAlarm(stub);
    expect(await sql(`SELECT count(*) AS n FROM versions WHERE path = '${ana}'`)).toEqual([
      { n: 1 },
    ]);
  });

  it("forgets a folder, and names what the vault still has", async () => {
    const backend = new FakeVaultBackend({
      "README.md": "# Vault",
      "memory/people/ana.md": "# Ana\n",
      "memory/people/bia.md": "# Bia\n",
      "memory/notes/caio.md": "# Caio\n",
    });
    replaceBackendForTesting(backend);
    const stub = vault("forget-folder");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [
        { path: "memory/people/ana.md", content: "# Ana\n\nNova.\n" },
        { path: "memory/notes/caio.md", content: "# Caio\n\nNovo.\n" },
      ],
      "x",
    );
    // The rewrite dropped the people folder, but it wasn't pushed for Caio.
    backend.forcePush({ "README.md": "# Vault", "memory/notes/caio.md": "# Caio\n" });
    // A path names that file only, not every path it begins.
    expect(await stub.forget(["memory/notes/cai"])).toMatchObject({ forgotten: 0 });
    expect(await stub.forget(["memory/people/", "memory/notes/caio.md"])).toEqual({
      ok: true,
      forgotten: 2,
      stillInVault: ["memory/notes/caio.md"],
    });
    const left = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT path FROM queue").toArray(),
    );
    expect(left).toEqual([]);
  });

  it("keeps the hold of a file the vault still has with markers", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n";
    const backend = new FakeVaultBackend({ "README.md": "# Vault", "memory/people/ana.md": base });
    replaceBackendForTesting(backend);
    const stub = vault("forget-held");
    await stub.read("README.md");
    backend.push({
      "memory/people/ana.md":
        "# Ana\n\n<<<<<<< HEAD\nMora no Porto.\n=======\nMora em Braga.\n>>>>>>> main\n",
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.forget(["memory/people/ana.md"])).toMatchObject({ ok: true });
    expect(await stub.read("memory/people/ana.md")).toBe(base);
    expect(await stub.held()).toHaveLength(1);
  });

  it("refuses paths it can't name, and does nothing with the vault off", async () => {
    replaceBackendForTesting(new FakeVaultBackend({ "README.md": "# Vault" }));
    const stub = vault("forget-input");
    for (const paths of [[], "memory/a.md", [42], ["x".repeat(301)], Array(1_001).fill("a.md")]) {
      expect(await stub.forget(paths as string[])).toEqual({ ok: false, reason: "invalid_input" });
    }
    // At the limits, it goes through.
    const edge = await stub.forget([
      ...Array(999).fill("memory/a.md"),
      `memory/${"a".repeat(290)}.md`,
    ]);
    expect(edge).toMatchObject({ ok: true });

    const failing = new FakeVaultBackend({ "README.md": "# Vault" });
    failing.branchHead = async () => {
      throw new Error("GitHub answered 502");
    };
    replaceBackendForTesting(failing);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await vault("forget-down").forget(["memory/a.md"])).toEqual({
      ok: false,
      reason: "unavailable",
    });
    logged.mockRestore();

    replaceBackendForTesting(null);
    expect(await vault("forget-off").forget(["memory/a.md"])).toEqual({
      ok: false,
      reason: "vault_off",
    });
  });
});
