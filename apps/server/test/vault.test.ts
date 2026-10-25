import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it, vi } from "vitest";
import worker, { replaceBackendForTesting } from "../src/index.ts";
import { VAULT_NAME } from "../src/vault.ts";

/** A request as the Worker receives it, with Cloudflare's `cf` properties. */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = "webhook-secret-for-tests";

/** A vault with a README, like a real one. */
function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

const vault = (name: string) => env.VAULT.getByName(name);

/** When the vault's alarm is next due. */
const alarmAt = (stub: ReturnType<typeof vault>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

async function rows(stub: ReturnType<typeof vault>, sql: string) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(sql).toArray());
}

/** The body of each current note in the memory index, by path. */
async function indexed(stub: ReturnType<typeof vault>) {
  const current = (await rows(
    stub,
    "SELECT path, body FROM versions WHERE is_current = 1 ORDER BY path",
  )) as { path: string; body: string }[];
  return Object.fromEntries(current.map((row) => [row.path, row.body]));
}

async function signed(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A GitHub webhook delivery to the Worker. */
function delivery(event: string, signature: string, body: string) {
  return new IncomingRequest("https://zikaron.test/webhooks/github", {
    method: "POST",
    headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": signature },
    body,
  });
}

/** A file as a device committed it, with a conflict left in. */
function marked(mine: string, theirs: string): string {
  return [
    "# Ana",
    "",
    "<<<<<<< HEAD",
    mine,
    "=======",
    theirs,
    ">>>>>>> origin/main",
    "",
    "Gosta de café.",
    "",
  ].join("\n");
}

describe("Vault", () => {
  it("is off until the vault is configured", async () => {
    replaceBackendForTesting(null);
    const stub = vault("off");
    expect(await stub.read("README.md")).toBeNull();
    expect(await stub.write("alfa", [{ path: "memory/notes/a.md", content: "a" }], "x")).toEqual({
      ok: false,
      reason: "vault_off",
    });
    expect(await stub.held()).toEqual([]);
    await stub.requestSync("refs/heads/main");
    expect(await alarmAt(stub)).toBeNull();
  });

  it("brings an edit made outside the server to reads and the index, through the signed webhook", async () => {
    const path = "memory/people/ana.md";
    const backend = vaultWith({ [path]: "# Ana\n\nMora em Lisboa.\n" });
    // The vault the webhook reaches.
    const stub = vault(VAULT_NAME);
    expect(await stub.read(path)).toBe("# Ana\n\nMora em Lisboa.\n");
    // Until a push comes, the next sync is the reconcile, minutes away: every alarm syncs, so only
    // the alarm's time shows what the webhook did.
    const reconcile = (await alarmAt(stub)) ?? 0;
    expect(reconcile - Date.now()).toBeGreaterThan(60_000);

    const after = backend.push({ [path]: "# Ana\n\nMora no Porto, edited in Obsidian.\n" });
    const body = JSON.stringify({ ref: "refs/heads/main", after, commits: [] });
    const refused = await worker.fetch(delivery("push", "sha256=00", body), env);
    expect(refused.status).toBe(401);
    expect(await alarmAt(stub)).toBe(reconcile);
    expect(await stub.read(path)).toBe("# Ana\n\nMora em Lisboa.\n");
    const accepted = await worker.fetch(delivery("push", await signed(body), body), env);
    expect(accepted.status).toBe(202);
    // The signed push brings the sync forward, to a second away at most.
    expect(((await alarmAt(stub)) ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThanOrEqual(
      1_000,
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.read(path)).toBe("# Ana\n\nMora no Porto, edited in Obsidian.\n");
    expect((await indexed(stub))[path]).toContain("Mora no Porto");
  });

  it("brings an edit no webhook announced at the reconcile, and indexes it", async () => {
    const path = "knowledge/trip.md";
    const backend = vaultWith({ [path]: "# Trip\n\nIn May.\n" });
    const stub = vault("reconcile");
    expect(await stub.read(path)).toBe("# Trip\n\nIn May.\n");
    backend.push({ [path]: "# Trip\n\nIn June.\n" });
    // The reconcile is the alarm already set, fifteen minutes away.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.read(path)).toBe("# Trip\n\nIn June.\n");
    expect((await indexed(stub))[path]).toContain("In June.");
    expect(((await alarmAt(stub)) ?? 0) - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("ignores a push to another branch", async () => {
    vaultWith({});
    const stub = vault("other-branch");
    await stub.read("README.md");
    const reconcile = await alarmAt(stub);
    await stub.requestSync("refs/heads/feature");
    expect(await alarmAt(stub)).toBe(reconcile);
  });

  it("shows writes at once and commits them together, attributed to their clients", async () => {
    const backend = vaultWith({});
    const stub = vault("writes");
    expect(
      await stub.write(
        "alfa",
        [{ path: "memory/people/ana.md", content: "# Ana" }],
        "Remember Ana",
      ),
    ).toEqual({ ok: true });
    expect(
      await stub.write(
        "beta",
        [
          { path: "knowledge/trip.md", content: "# Trip" },
          { path: "README.md", content: null },
        ],
        "Plan the trip",
      ),
    ).toEqual({ ok: false, reason: "invalid_path" });
    await stub.write("beta", [{ path: "knowledge/trip.md", content: "# Trip" }], "Plan the trip");
    expect(await stub.read("memory/people/ana.md")).toBe("# Ana");
    expect(backend.commitRequests).toHaveLength(0);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(backend.commitRequests).toHaveLength(1);
    expect(backend.commitRequests[0]).toMatchObject({
      branch: "main",
      expectedHead: expect.stringMatching(/^[0-9a-f]{40}$/),
      headline: "Update 2 files from alfa, beta",
      body: "Zikaron-Client: alfa\nZikaron-Client: beta",
      deletions: [],
    });
    expect(backend.files()).toMatchObject({
      "memory/people/ana.md": "# Ana",
      "knowledge/trip.md": "# Trip",
    });
    // Its own commit comes back through the webhook and changes nothing.
    expect(await rows(stub, "SELECT * FROM queue")).toEqual([]);
    expect(await stub.read("memory/people/ana.md")).toBe("# Ana");
    // The index sees what was committed.
    expect(await indexed(stub)).toMatchObject({
      "memory/people/ana.md": expect.any(String),
      "knowledge/trip.md": expect.any(String),
    });
  });

  it("names one client's commit by its summary, or a default one", async () => {
    const backend = vaultWith({});
    const stub = vault("summary");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "  Remember\n A  ");
    await runDurableObjectAlarm(stub);
    await stub.write("alfa", [{ path: "memory/notes/b.md", content: "# B" }], "   ");
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests.map((request) => [request.headline, request.body])).toEqual([
      ["Remember A", "Zikaron-Client: alfa"],
      ["Update memory from alfa", "Zikaron-Client: alfa"],
    ]);
  });

  it("refuses writes outside memory and knowledge, and clients without a valid name", async () => {
    vaultWith({});
    const stub = vault("refusals");
    for (const path of [
      "agents/alfa/SOUL.md",
      "AGENTS.md",
      "skills/x/SKILL.md",
      "agents/beta/memory/notes/a.md",
      "memory/../AGENTS.md",
      "memory/notes/photo.png",
      ".obsidian/workspace.md",
      "/memory/a.md",
      "memory/notes/what?.md",
      "memory/notes/trailing./a.md",
      "memory/notes/\u202Eevil.md",
      "memory/notes/CON.md",
      `memory/${"a".repeat(300)}.md`,
      // The server's own files, such as the memory report.
      "memory/_lint/report.md",
    ]) {
      expect(await stub.write("alfa", [{ path, content: "x" }], "x"), path).toEqual({
        ok: false,
        reason: "invalid_path",
      });
    }
    for (const client of ["", "Alfa", "-alfa", "a".repeat(41), "al fa", "../alfa"]) {
      expect(
        await stub.write(client, [{ path: "memory/notes/a.md", content: "x" }], "x"),
        client,
      ).toEqual({ ok: false, reason: "invalid_path" });
    }
    expect(await stub.write("alfa", [], "x")).toEqual({ ok: false, reason: "invalid_path" });
    expect(
      await stub.write(
        "alfa",
        [{ path: "memory/notes/a.md", content: 42 as unknown as string }],
        "x",
      ),
    ).toEqual({ ok: false, reason: "invalid_path" });
    expect(
      await stub.write("alfa", [{ path: "agents/alfa/memory/notes/a.md", content: "x" }], "x"),
    ).toEqual({ ok: true });
    expect(
      await stub.write("a".repeat(40), [{ path: "areas/casa/a.md", content: "x" }], "x"),
    ).toEqual({ ok: true });
  });

  it("commits on the owner's newer head, and lets the owner win on the same file", async () => {
    const backend = vaultWith({ "knowledge/shared.md": "# Shared" });
    const stub = vault("stale");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [{ path: "knowledge/shared.md", content: "# The server's version" }],
      "x",
    );
    await stub.write("alfa", [{ path: "memory/notes/mine.md", content: "# Mine" }], "x");
    backend.push({
      "knowledge/shared.md": "# The owner's version",
      "knowledge/other.md": "# Other",
    });

    await runDurableObjectAlarm(stub);
    expect(backend.files()).toMatchObject({
      "knowledge/shared.md": "# The owner's version",
      "knowledge/other.md": "# Other",
      "memory/notes/mine.md": "# Mine",
    });
    expect(await stub.read("knowledge/shared.md")).toBe("# The owner's version");
    expect(await rows(stub, "SELECT client, path, content FROM conflicts")).toEqual([
      { client: "alfa", path: "knowledge/shared.md", content: "# The server's version" },
    ]);
  });

  it("makes a batch again on the new head when the owner pushes while it commits, and never forces", async () => {
    const backend = vaultWith({ "knowledge/owner.md": "# Owner" });
    const stub = vault("moving-head");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "x");
    const commit = backend.commit.bind(backend);
    let pushes = 1;
    backend.commit = async (request) => {
      // The owner pushes between the server's sync and its commit.
      if (pushes > 0) {
        pushes -= 1;
        backend.push({ "knowledge/owner.md": "# Owner, edited" });
      }
      return commit(request);
    };
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests).toHaveLength(2);
    expect(backend.commitRequests[1]?.expectedHead).not.toBe(
      backend.commitRequests[0]?.expectedHead,
    );
    expect(backend.files()).toMatchObject({
      "knowledge/owner.md": "# Owner, edited",
      "memory/notes/a.md": "# A",
    });
  });

  it("gives up for now when the head keeps moving, and keeps the writes", async () => {
    const backend = vaultWith({});
    const stub = vault("always-moving");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "x");
    backend.commit = async () => ({ kind: "stale" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDurableObjectAlarm(stub);
    logged.mockRestore();
    expect(await stub.read("memory/notes/a.md")).toBe("# A");
    expect(await rows(stub, "SELECT path FROM queue")).toEqual([{ path: "memory/notes/a.md" }]);
  });

  it("merges a queued write with the owner's edit, line by line, the owner winning overlaps", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n\nTem um gato.\n";
    const backend = vaultWith({ "memory/people/ana.md": base, "memory/people/bia.md": base });
    const stub = vault("three-way");
    await stub.read("README.md");
    // Two writes to one file: the second builds on the first, as a read shows it.
    const first = base.replace("um gato", "dois gatos");
    await stub.write("alfa", [{ path: "memory/people/ana.md", content: first }], "x");
    expect(await stub.read("memory/people/ana.md")).toBe(first);
    await stub.write(
      "alfa",
      [{ path: "memory/people/ana.md", content: first.replace("café", "chá") }],
      "y",
    );
    await stub.write(
      "alfa",
      [{ path: "memory/people/bia.md", content: base.replace("Lisboa", "Braga") }],
      "z",
    );
    backend.push({
      "memory/people/ana.md": base.replace("Lisboa", "Porto"),
      "memory/people/bia.md": base.replace("Lisboa", "Faro"),
    });

    await runDurableObjectAlarm(stub);
    expect(backend.files()).toMatchObject({
      // Nothing overlaps: both sides' changes stay.
      "memory/people/ana.md": base
        .replace("Lisboa", "Porto")
        .replace("café", "chá")
        .replace("um gato", "dois gatos"),
      // The same line: the owner's side wins.
      "memory/people/bia.md": base.replace("Lisboa", "Faro"),
    });
    // The owner's file is left as it is, without a commit of its own.
    const committed = backend.commitRequests.flatMap((request) => request.writes);
    expect(committed.map((write) => write.path)).toEqual(["memory/people/ana.md"]);
    // Only the daily report waits, the server's own routine.
    expect(await rows(stub, "SELECT count(*) AS n FROM queue WHERE client != 'zikaron'")).toEqual([
      { n: 0 },
    ]);
    // Only what lost to the owner is set aside.
    expect(await rows(stub, "SELECT client, path, content, reason FROM conflicts")).toEqual([
      {
        client: "alfa",
        path: "memory/people/bia.md",
        content: base.replace("Lisboa", "Braga"),
        reason: "owner_won",
      },
    ]);
  });

  it("lets the owner win a file without a common version, or one either side removed", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n";
    const backend = vaultWith({ "memory/people/ana.md": base, "memory/people/bia.md": base });
    const stub = vault("three-way-none");
    await stub.read("README.md");
    await stub.write(
      "alfa",
      [
        { path: "memory/people/ana.md", content: `${base}\nTem um gato.\n` },
        { path: "memory/people/bia.md", content: null },
        { path: "memory/people/caio.md", content: "# Caio\n" },
      ],
      "x",
    );
    backend.push({
      "memory/people/ana.md": null,
      "memory/people/bia.md": `${base}\nTem um cão.\n`,
      "memory/people/caio.md": "# Caio, by the owner\n",
    });

    await runDurableObjectAlarm(stub);
    const files = backend.files();
    expect(files["memory/people/ana.md"]).toBeUndefined();
    expect(files["memory/people/bia.md"]).toBe(`${base}\nTem um cão.\n`);
    expect(files["memory/people/caio.md"]).toBe("# Caio, by the owner\n");
    expect(await rows(stub, "SELECT path, reason FROM conflicts ORDER BY path")).toEqual([
      { path: "memory/people/ana.md", reason: "owner_won" },
      { path: "memory/people/bia.md", reason: "owner_won" },
      { path: "memory/people/caio.md", reason: "owner_won" },
    ]);
  });

  it("holds a file pushed with conflict markers, and keeps queued writes off it until it is clean", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("markers");
    await stub.read("README.md");
    const server = base.replace("café", "chá");
    await stub.write("alfa", [{ path: "memory/people/ana.md", content: server }], "x");
    const pushed = marked("Mora no Porto.", "Mora em Braga.");
    // A line of equals signs under text is a Markdown heading, not a conflict.
    const heading = "Planos\n=======\n\nViajar em maio.\n";
    backend.push({ "memory/people/ana.md": pushed, "memory/notes/planos.md": heading });
    // A later write to another file commits, and leaves the held file's write queued.
    await stub.write("alfa", [{ path: "memory/notes/outra.md", content: "# Outra\n" }], "y");

    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(pushed);
    expect(
      backend.commitRequests.flatMap((request) => request.writes.map((write) => write.path)),
    ).toEqual(["memory/notes/outra.md"]);
    expect(await rows(stub, "SELECT path, content, previous FROM held")).toEqual([
      { path: "memory/people/ana.md", content: pushed, previous: base },
    ]);
    expect(await stub.held()).toEqual([{ path: "memory/people/ana.md", at: expect.any(Number) }]);
    expect(await rows(stub, "SELECT path, content FROM queue")).toEqual([
      { path: "memory/people/ana.md", content: server },
    ]);
    // A held write doesn't keep the alarm flushing every few seconds.
    expect(await alarmAt(stub)).toBeGreaterThan(Date.now() + 60_000);
    // The index keeps the version from before the conflict, never the markers.
    expect((await indexed(stub))["memory/people/ana.md"]).toContain("Mora em Lisboa.");

    // The owner cleans it up: the hold ends, and the queued write merges into the clean file.
    const clean = base.replace("Lisboa", "Porto");
    backend.push({ "memory/people/ana.md": clean });
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(clean.replace("café", "chá"));
    expect(await stub.held()).toEqual([]);
  });

  it("shows a held file as it was before, and never commits the markers", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("held-visible");
    await stub.read("README.md");
    backend.push({ "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);

    // Reads see the version before the conflict.
    expect(await stub.read("memory/people/ana.md")).toBe(base);
    // A client's write, made on what it read, waits for the owner.
    const added = `${base}\nTem um gato.\n`;
    await stub.write("alfa", [{ path: "memory/people/ana.md", content: added }], "x");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests).toEqual([]);
    expect(await stub.held()).toHaveLength(1);

    // The owner resolves it: the write goes in on top of the resolution.
    backend.push({ "memory/people/ana.md": "# Ana\n\nMora no Porto.\n\nGosta de café.\n" });
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(
      "# Ana\n\nMora no Porto.\n\nGosta de café.\n\nTem um gato.\n",
    );
  });

  it("keeps the version from before the first conflict when another one is pushed", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("held-again");
    await stub.read("README.md");
    backend.push({ "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    backend.push({ "memory/people/ana.md": marked("Mora em Faro.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT previous FROM held")).toEqual([{ previous: base }]);
    expect(await stub.read("memory/people/ana.md")).toBe(base);
  });

  it("takes no marked file as the version before a conflict, and holds a new file with none", async () => {
    const backend = vaultWith({});
    const stub = vault("held-none");
    await stub.read("README.md");
    // A file the server itself wrote marked, then pushed marked again: no version before is known.
    await stub.write("alfa", [{ path: "memory/people/bia.md", content: marked("a", "b") }], "x");
    await runDurableObjectAlarm(stub);
    backend.push({
      "memory/people/bia.md": marked("c", "d"),
      "memory/people/caio.md": marked("e", "f"),
    });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT path, previous FROM held ORDER BY path")).toEqual([
      { path: "memory/people/bia.md", previous: null },
      { path: "memory/people/caio.md", previous: null },
    ]);
    expect(await stub.read("memory/people/caio.md")).toBeNull();
  });

  it("merges a write queued before a hold against the version from before it", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("held-base");
    await stub.read("README.md");
    const server = base.replace("Mora em Lisboa.", "Mora em Lisboa, perto do rio.");
    await stub.write("alfa", [{ path: "memory/people/ana.md", content: server }], "x");
    backend.push({ "memory/people/ana.md": marked("Mora em Lisboa.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    // The owner keeps the line as it was, and changes another.
    backend.push({ "memory/people/ana.md": base.replace("café", "chá") });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(server.replace("café", "chá"));
  });

  it("never commits a write that would put markers back", async () => {
    const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("no-markers");
    await stub.read("README.md");
    // A write that holds a conflict block of its own.
    const block = "<<<<<<< HEAD\nMora no Porto.\n=======\nMora em Braga.\n>>>>>>> main\n";
    await stub.write("alfa", [{ path: "memory/people/ana.md", content: `${base}\n${block}` }], "x");
    // The owner's edit is far from it, so the two would merge cleanly.
    backend.push({ "memory/people/ana.md": base.replace("Lisboa", "Porto") });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(base.replace("Lisboa", "Porto"));
    expect(await rows(stub, "SELECT path, reason FROM conflicts")).toEqual([
      { path: "memory/people/ana.md", reason: "owner_won" },
    ]);
  });

  it("keeps queued writes and retries when GitHub fails", async () => {
    const backend = vaultWith({});
    const stub = vault("retry");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "x");
    const commit = backend.commit.bind(backend);
    backend.commit = async () => {
      throw new Error("GitHub commit answered 502");
    };
    await runDurableObjectAlarm(stub);
    expect(await stub.read("memory/notes/a.md")).toBe("# A");
    expect(await alarmAt(stub)).not.toBeNull();
    backend.commit = commit;
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/a.md"]).toBe("# A");
  });

  it("logs a failed GitHub call by its error's name, never its message", async () => {
    const backend = vaultWith({});
    const stub = vault("retry-log");
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "# A" }], "x");
    backend.commit = async () => {
      throw new TypeError("GitHub refused: the note says marker-3c4d");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDurableObjectAlarm(stub);
    const lines = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(lines).toContain("a GitHub call failed");
    expect(lines).toContain("TypeError");
    expect(lines).not.toContain("marker-3c4d");
  });

  it("arms the reconcile once synced, and keeps an earlier alarm set during a run", async () => {
    const backend = vaultWith({});
    const stub = vault("alarms");
    await stub.read("README.md");
    expect(await alarmAt(stub)).toBeGreaterThan(Date.now() + 14 * 60_000);

    // A push arrives while an alarm is running: its sync must not wait for the next reconcile.
    let release = false;
    const branchHead = backend.branchHead.bind(backend);
    backend.branchHead = async (branch) => {
      while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
      return branchHead(branch);
    };
    const run = runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stub.requestSync("refs/heads/main");
    release = true;
    await run;
    expect(await alarmAt(stub)).toBeLessThan(Date.now() + 5_000);
  });

  it("recognizes its own commit when GitHub's answer was lost", async () => {
    const backend = vaultWith({});
    const stub = vault("lost-answer");
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
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "v1" }], "x");
    await runDurableObjectAlarm(stub);
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "v2" }], "x");
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/a.md"]).toBe("v2");
    expect(await rows(stub, "SELECT * FROM conflicts")).toEqual([]);
    expect(await rows(stub, "SELECT * FROM queue")).toEqual([]);
  });

  it("drops the removal of a file the vault doesn't have, and bounds a write", async () => {
    const backend = vaultWith({ "knowledge/kept.md": "# Kept" });
    const stub = vault("bounds");
    await stub.read("README.md");
    await stub.write("alfa", [{ path: "knowledge/never-was.md", content: null }], "x");
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests).toEqual([]);
    await stub.write("alfa", [{ path: "knowledge/kept.md", content: null }], "x");
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests.at(-1)?.deletions).toEqual(["knowledge/kept.md"]);
    expect(await stub.read("knowledge/kept.md")).toBeNull();
    const many = Array.from({ length: 51 }, (_, i) => ({
      path: `memory/notes/${i}.md`,
      content: "x",
    }));
    expect(await stub.write("alfa", many, "x")).toEqual({ ok: false, reason: "too_large" });
    expect(
      await stub.write(
        "alfa",
        [{ path: "memory/notes/big.md", content: "x".repeat(1_100_000) }],
        "x",
      ),
    ).toEqual({ ok: false, reason: "too_large" });
    const halves = [0, 1, 2].map((i) => ({
      path: `memory/notes/half-${i}.md`,
      content: "x".repeat(700_000),
    }));
    expect(await stub.write("alfa", halves, "x")).toEqual({ ok: false, reason: "too_large" });
  });

  it("follows a renamed default branch", async () => {
    const backend = vaultWith({ "knowledge/rules.md": "# Rules" });
    const stub = vault("renamed");
    await stub.read("README.md");
    const head = (await backend.branchHead("main")) ?? "";
    await backend.createBranch("trunk", head);
    await backend.deleteBranch("main");
    backend.defaultBranch = async () => "trunk";
    backend.push({ "knowledge/rules.md": "# Rules, renamed branch" }, "trunk");
    await stub.requestSync("refs/heads/trunk");
    await runDurableObjectAlarm(stub);
    expect(await stub.read("knowledge/rules.md")).toBe("# Rules, renamed branch");
  });

  it("fails the sync, and retries, when the vault has no branch to follow", async () => {
    const backend = vaultWith({});
    const stub = vault("no-branch");
    await stub.read("README.md");
    backend.branchHead = async () => null;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDurableObjectAlarm(stub);
    logged.mockRestore();
    expect(await rows(stub, "SELECT value FROM state WHERE key = 'failures'")).toEqual([
      { value: "1" },
    ]);
  });

  it("commits a long queue in batches", async () => {
    const backend = vaultWith({});
    const stub = vault("batches");
    await stub.read("README.md");
    for (let start = 0; start < 250; start += 50) {
      const changes = Array.from({ length: 50 }, (_, i) => ({
        path: `memory/notes/n${start + i}.md`,
        content: `# ${start + i}`,
      }));
      expect(await stub.write("alfa", changes, "x")).toEqual({ ok: true });
    }
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests.map((request) => request.writes.length)).toEqual([100, 100, 50]);
    expect(Object.keys(backend.files())).toHaveLength(251);
  });

  it("commits large writes in several batches, by size", async () => {
    const backend = vaultWith({});
    const stub = vault("batch-bytes");
    await stub.read("README.md");
    for (let i = 0; i < 3; i += 1) {
      const content = `# ${i}\n${"x".repeat(900_000)}`;
      await stub.write("alfa", [{ path: `memory/notes/big-${i}.md`, content }], "x");
    }
    await runDurableObjectAlarm(stub);
    expect(backend.commitRequests.map((request) => request.writes.length)).toEqual([2, 1]);
  });

  it("sets aside only the write GitHub refuses, and keeps writes through transient failures", async () => {
    const backend = vaultWith({});
    const stub = vault("refusals-only");
    await stub.read("README.md");
    const commit = backend.commit.bind(backend);
    let transient = 3;
    backend.commit = async (request) => {
      if (transient > 0) {
        transient -= 1;
        throw new Error("GitHub commit answered 502");
      }
      if (request.writes.some((write) => write.path.endsWith("bad.md"))) {
        return { kind: "refused", reason: "UNPROCESSABLE" };
      }
      return commit(request);
    };
    const notes = ["a", "b", "bad", "c"].map((name) => ({
      path: `memory/notes/${name}.md`,
      content: `# ${name}`,
    }));
    await stub.write("alfa", notes, "x");
    for (let run = 0; run < 3; run += 1) await runDurableObjectAlarm(stub);
    // Transient failures set nothing aside: the writes are all still there.
    expect(await stub.read("memory/notes/bad.md")).toBe("# bad");
    for (let run = 0; run < 12; run += 1) await runDurableObjectAlarm(stub);
    expect(backend.files()).toMatchObject({
      "memory/notes/a.md": "# a",
      "memory/notes/b.md": "# b",
      "memory/notes/c.md": "# c",
    });
    expect(backend.files()).not.toHaveProperty("memory/notes/bad.md");
    expect(await rows(stub, "SELECT path, reason FROM conflicts")).toEqual([
      { path: "memory/notes/bad.md", reason: "refused" },
    ]);
  });

  it("backs off while GitHub fails, and new writes wait for the retry", async () => {
    const backend = vaultWith({});
    const stub = vault("backoff");
    await stub.read("README.md");
    backend.commit = async () => {
      throw new Error("GitHub commit answered 503");
    };
    await stub.write("alfa", [{ path: "memory/notes/a.md", content: "a" }], "x");
    const delays: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      await runDurableObjectAlarm(stub);
      await stub.write("alfa", [{ path: "memory/notes/a.md", content: `a${run}` }], "x");
      const at = await alarmAt(stub);
      delays.push(Math.round(((at ?? 0) - Date.now()) / 60_000));
    }
    expect(delays).toEqual([1, 2, 4]);
  });

  it("drops a file the owner grew past the size the vault keeps", async () => {
    const backend = vaultWith({ "knowledge/growing.md": "# Small" });
    const stub = vault("grown");
    await stub.read("README.md");
    const diff = backend.diff.bind(backend);
    backend.diff = async (from, to) => {
      const result = await diff(from, to);
      // As GitHub's adapter does for a file past 1 MiB: it reports the file gone.
      return (
        result && {
          ...result,
          changes: result.changes.map((change) =>
            change.path === "knowledge/growing.md" ? { path: change.path, content: null } : change,
          ),
        }
      );
    };
    backend.push({ "knowledge/growing.md": "# Now huge" });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect(await stub.read("knowledge/growing.md")).toBeNull();
  });

  it("sets nothing aside when GitHub refuses every commit", async () => {
    const backend = vaultWith({});
    const stub = vault("refuse-all");
    await stub.read("README.md");
    backend.commit = async () => ({ kind: "refused", reason: "FORBIDDEN" });
    const notes = Array.from({ length: 6 }, (_, i) => ({
      path: `memory/notes/${i}.md`,
      content: `# ${i}`,
    }));
    await stub.write("alfa", notes, "x");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await stub.read("memory/notes/0.md")).toBe("# 0");
    expect(await rows(stub, "SELECT * FROM conflicts")).toEqual([]);
    expect(await rows(stub, "SELECT count(*) AS n FROM queue")).toEqual([{ n: 6 }]);
  });

  it("isolates several refused writes anywhere in the queue", async () => {
    const backend = vaultWith({});
    const stub = vault("refuse-some");
    await stub.read("README.md");
    const commit = backend.commit.bind(backend);
    backend.commit = async (request) =>
      request.writes.some((write) => write.path.includes("bad"))
        ? { kind: "refused", reason: "UNPROCESSABLE" }
        : commit(request);
    const names = ["a", "bad1", "b", "bad2", "c", "d", "e", "bad3", "f"];
    await stub.write(
      "alfa",
      names.map((name) => ({ path: `memory/notes/${name}.md`, content: `# ${name}` })),
      "x",
    );
    await runDurableObjectAlarm(stub);
    expect(Object.keys(backend.files()).sort()).toEqual(
      [
        "README.md",
        ...["a", "b", "c", "d", "e", "f"].map((name) => `memory/notes/${name}.md`),
      ].sort(),
    );
    expect(await rows(stub, "SELECT path FROM conflicts ORDER BY path")).toEqual([
      { path: "memory/notes/bad1.md" },
      { path: "memory/notes/bad2.md" },
      { path: "memory/notes/bad3.md" },
    ]);
  });

  it("splits a batch whose commit keeps failing, so a smaller one can go through", async () => {
    const backend = vaultWith({});
    const stub = vault("too-big");
    await stub.read("README.md");
    const commit = backend.commit.bind(backend);
    backend.commit = async (request) => {
      if (request.writes.length > 2) throw new Error("GitHub commit answered 502");
      return commit(request);
    };
    const notes = Array.from({ length: 8 }, (_, i) => ({
      path: `memory/notes/${i}.md`,
      content: `# ${i}`,
    }));
    await stub.write("alfa", notes, "x");
    for (let run = 0; run < 4; run += 1) await runDurableObjectAlarm(stub);
    expect(Object.keys(backend.files())).toHaveLength(9);
  });

  it("brings the index back to the head when it fell behind", async () => {
    vaultWith({ "memory/people/ana.md": "# Ana\n\nMora em Lisboa.\n" });
    const stub = vault("catch-up");
    await stub.read("README.md");
    // As after a crash between a head move and the indexing.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM state WHERE key = 'index_head'");
    });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT value FROM state WHERE key = 'index_head'")).toHaveLength(1);
    expect((await indexed(stub))["memory/people/ana.md"]).toContain("Mora em Lisboa.");
  });

  it("logs an index that can't catch up by its error's name, and keeps the vault's work", async () => {
    vaultWith({ "memory/people/ana.md": "# Ana\n" });
    const stub = vault("catch-up-fails");
    await stub.read("README.md");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM state WHERE key = 'index_head'");
      // Without the index tables, the rebuild fails.
      state.storage.sql.exec("DROP TABLE versions");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await runDurableObjectAlarm(stub);
    const lines = JSON.stringify(logged.mock.calls);
    logged.mockRestore();
    expect(lines).toContain("the index couldn't catch up");
    expect(lines).not.toContain("Ana");
    expect(await rows(stub, "SELECT value FROM state WHERE key = 'failures'")).toEqual([
      { value: "0" },
    ]);
  });
});
