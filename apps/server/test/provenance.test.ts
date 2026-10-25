import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MemoryIndex } from "@zikaron/memory";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it } from "vitest";
import { replaceBackendForTesting } from "../src/index.ts";

const vault = (name: string) => env.VAULT.getByName(name);

function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

async function rows(stub: ReturnType<typeof vault>, sql: string) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(sql).toArray());
}

/** The paths whose version in the vault came from a commit by the server itself. */
async function byServer(stub: ReturnType<typeof vault>): Promise<string[]> {
  const found = (await rows(
    stub,
    `SELECT f.path AS path FROM files f JOIN authored a ON a.path = f.path AND a.blob_sha = f.blob_sha
     ORDER BY f.path`,
  )) as { path: string }[];
  return found.map((row) => row.path);
}

describe("Vault provenance", () => {
  const ana = "memory/people/ana.md";
  const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";

  it("tells the server's notes from the owner's, until the owner edits one", async () => {
    const backend = vaultWith({ [ana]: base });
    const stub = vault("provenance-writes");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [
        { path: "memory/notes/bolo-da-ana.md", content: "# Bolo da Ana\n\nTrês ovos.\n" },
        { path: "memory/sessions/2026/2026-10-06-conversa.md", content: "# Conversa\n\nBolo.\n" },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    expect(await byServer(stub)).toEqual([
      "memory/notes/bolo-da-ana.md",
      "memory/sessions/2026/2026-10-06-conversa.md",
    ]);

    // The owner edits the server's note in Obsidian: it is the owner's now.
    backend.push({ "memory/notes/bolo-da-ana.md": "# Bolo da Ana\n\nQuatro ovos.\n" });
    await runDurableObjectAlarm(stub);
    expect(await byServer(stub)).toEqual(["memory/sessions/2026/2026-10-06-conversa.md"]);

    // Forgetting a path forgets that the server wrote it.
    expect(await stub.forget(["memory/sessions/"])).toMatchObject({ ok: true });
    expect(await rows(stub, "SELECT path FROM authored ORDER BY path")).toEqual([
      { path: "memory/notes/bolo-da-ana.md" },
    ]);
  });

  it("counts a write merged into the owner's edit as the server's, holding the owner's lines", async () => {
    const backend = vaultWith({ [ana]: base });
    const stub = vault("provenance-merge");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: ana, content: base.replace("café", "chá") }], "x");
    backend.push({ [ana]: base.replace("Lisboa", "Braga") });
    await runDurableObjectAlarm(stub);
    const merged = base.replace("Lisboa", "Braga").replace("café", "chá");
    expect(backend.files()[ana]).toBe(merged);
    expect(await byServer(stub)).toEqual([ana]);
    expect(await rows(stub, "SELECT path, content FROM owner_merges")).toEqual([
      { path: ana, content: merged },
    ]);

    // A later write by the server replaces the merge, and the mark goes.
    await stub.write("alfa", [{ path: ana, content: `${merged}\nTem um gato.\n` }], "y");
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 0 }]);

    // A removal takes the mark away too.
    const current = (await stub.read(ana)) ?? "";
    await stub.write("alfa", [{ path: ana, content: current.replace("chá", "mate") }], "z");
    backend.push({ [ana]: current.replace("Braga", "Faro") });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 1 }]);
    await stub.write("alfa", [{ path: ana, content: null }], "w");
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM owner_merges")).toEqual([{ n: 0 }]);
    // The daily report, which lists the owner's changed note, is the server's.
    expect(
      await rows(stub, "SELECT count(*) AS n FROM authored WHERE path != 'memory/_lint/report.md'"),
    ).toEqual([{ n: 0 }]);
  });

  it("knows its own commit when GitHub's answer was lost, and forgets a file the owner removed", async () => {
    const backend = vaultWith({});
    const stub = vault("provenance-lost");
    await stub.read("README.md");
    const commit = backend.commit.bind(backend);
    let lose = true;
    backend.commit = async (request) => {
      const outcome = await commit(request);
      if (lose) {
        lose = false;
        throw new Error("GitHub commit answered 502");
      }
      return outcome;
    };
    const bolo = "memory/notes/bolo-da-ana.md";
    await stub.write("alfa", [{ path: bolo, content: "# Bolo da Ana\n\nTrês ovos.\n" }], "x");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await byServer(stub)).toEqual([bolo]);
    expect(await rows(stub, "SELECT count(*) AS n FROM queue")).toEqual([{ n: 0 }]);

    backend.push({ [bolo]: null });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM authored")).toEqual([{ n: 0 }]);
  });

  it("forgets what the server wrote when a force-push takes the file away", async () => {
    const backend = vaultWith({});
    const stub = vault("provenance-force-push");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A\n\nUm.\n" }], "x");
    await runDurableObjectAlarm(stub);
    backend.forcePush({ "README.md": "# Vault" });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT count(*) AS n FROM authored")).toEqual([{ n: 0 }]);
    expect(await stub.read("memory/notes/a.md")).toBeNull();
  });

  it("the index knows what the server wrote, and an owner's edit makes the note the owner's again", async () => {
    const backend = vaultWith({});
    const stub = vault("provenance-index");
    await stub.read("README.md");
    const path = "memory/notes/cafe.md";
    await stub.write(
      "alfa",
      [
        {
          path,
          content:
            "---\norigin:\n  client: alfa\n  channel: tool\n  source: agent\n---\n\n# Café\n\nSem açúcar.\n",
        },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    const trust = () =>
      runInDurableObject(stub, (_instance, state) =>
        new MemoryIndex(state.storage).trust(path, {
          client: "beta",
          mode: "privileged",
          trusted: ["beta"],
          ownerClaims: [],
        }),
      );
    expect(await trust()).toEqual({ ownerGrade: false, tainted: true });
    backend.push({ [path]: "# Café\n\nSem açúcar, confirmado.\n" });
    await runDurableObjectAlarm(stub);
    expect(await trust()).toEqual({ ownerGrade: true, tainted: false });
  });
});
