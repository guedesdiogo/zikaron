import { DurableObject } from "cloudflare:workers";
import { MemoryIndex } from "@zikaron/memory";
import {
  type FileChange,
  GitHubVaultBackend,
  gitBlobSha,
  type VaultBackend,
  type VaultFile,
} from "@zikaron/vault";
import { hasConflictMarkers } from "./conflicts.ts";
import { mergeOwnerWins } from "./merge.ts";
import { isClientName, isWritable } from "./paths.ts";

/** Set by the owner at deploy, as Worker secrets (Kelpie's ADR-0021). */
export interface VaultSecrets {
  /** The GitHub App's private key, converted to PKCS#8. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

export type VaultEnv = Env & VaultSecrets;

/** O que uma gravação responde: aceita na fila, ou o motivo da recusa. */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "vault_off" | "invalid_path" | "too_large" };

/**
 * Um arquivo empurrado com marcadores de conflito, fora das gravações do servidor até o dono
 * empurrar uma versão sem marcadores. Nenhum modelo o resolve.
 */
export interface HeldFile {
  path: string;
  at: number;
}

/**
 * What `forget` did: how many of the vault's rows named the paths, now gone, and which of the paths
 * the vault still has, as when the rewritten history wasn't pushed.
 */
export type ForgetResult =
  | { ok: true; forgotten: number; stillInVault: string[] }
  | { ok: false; reason: "vault_off" | "invalid_input" | "unavailable" };

/** The one Vault object: the single writer (Kelpie's ADR-0020 §3). */
export const VAULT_NAME = "vault";

/** Writes wait this long, so the ones made close together share a commit (Kelpie's ADR-0005). */
const FLUSH_DELAY_MS = 5_000;
/** A push syncs this long after its webhook, so a burst of pushes shares one sync. */
const SYNC_DELAY_MS = 1_000;
/** How often the vault checks for pushes a webhook didn't announce: GitHub doesn't redeliver. */
const RECONCILE_MS = 15 * 60_000;
/** A failed GitHub call is retried after a minute, then twice as long each time, up to an hour. */
const RETRY_MS = 60_000;
const MAX_RETRY_MS = 3_600_000;
const MAX_COMMIT_ATTEMPTS = 3;
/** What one `write` may hold: the vault keeps no file over 1 MiB. */
const MAX_CHANGES = 50;
const MAX_FILE_BYTES = 1_048_576;
const MAX_WRITE_BYTES = 2_000_000;
/** What one commit may hold; a longer queue is committed in several. */
const MAX_BATCH_ROWS = 100;
const MAX_BATCH_BYTES = 2_000_000;
/** The paths held with conflict markers. */
const HELD = "SELECT path FROM held";
/** The most paths one `forget` names, and the longest path it takes. */
const MAX_FORGET_PATHS = 1_000;
const MAX_PATH_CHARS = 300;
/** The vault's own rows that can name a vault path, and so hold a copy of what it was. */
const PATH_TABLES = ["queue", "conflicts", "held", "authored", "owner_merges"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  blob_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  client TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  summary TEXT NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY,
  client TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('owner_won', 'refused')),
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS held (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  previous TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authored (
  path TEXT PRIMARY KEY NOT NULL,
  blob_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_merges (
  path TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL
);
`;

const encoder = new TextEncoder();
const bytes = (text: string | null) => (text === null ? 0 : encoder.encode(text).byteLength);

let backendForTesting: VaultBackend | null | undefined;

/** Tests run in the Worker's isolate and swap the backend with this. Production never calls it. */
export function replaceBackendForTesting(backend: VaultBackend | null | undefined): void {
  backendForTesting = backend;
}

/** The GitHub backend, or null while the vault isn't configured. */
function backendFor(env: VaultEnv): VaultBackend | null {
  const { GITHUB_APP_ID, GITHUB_INSTALLATION_ID, VAULT_REPOSITORY, GITHUB_APP_PRIVATE_KEY } = env;
  if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !VAULT_REPOSITORY || !GITHUB_APP_PRIVATE_KEY) {
    return null;
  }
  return new GitHubVaultBackend({
    appId: GITHUB_APP_ID,
    installationId: GITHUB_INSTALLATION_ID,
    repository: VAULT_REPOSITORY,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    fetch: (input, init) => fetch(input, init),
  });
}

/** An error's name for the logs, never its message: GitHub's and memory's can quote a note. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

interface QueuedRow extends Record<string, SqlStorageValue> {
  id: number;
  client: string;
  path: string;
  content: string | null;
  summary: string;
}

/**
 * The vault's working copy and its single writer (Kelpie's ADR-0005, ADR-0020 §3). It keeps the
 * files of the synced head in SQLite and queues the clients' writes, which reads see at once and an
 * alarm commits in batches. Pushes arrive through the webhook and a periodic reconcile.
 *
 * When a sync brings a change to a file with queued writes:
 * - if the change is one of the server's own queued writes, whose commit landed though GitHub's
 *   answer was lost, the writes up to it are done;
 * - otherwise it is the owner's edit: the server's latest write is merged into it line by line, the
 *   owner's side winning where they overlap, and the writes that lost are kept as conflicts.
 *
 * A file pushed with conflict markers is held: reads and the index see its version from before the
 * conflict, and queued writes to it wait until the owner pushes a version without markers.
 */
export class Vault extends DurableObject<VaultEnv> {
  /** GitHub calls are asynchronous; syncs, flushes and forgets run one at a time. */
  #work: Promise<unknown> = Promise.resolve();
  /** One backend per object, so its installation token is reused until it expires. */
  #cachedBackend: VaultBackend | null | undefined;
  /** Memory's index, derived from the files: it follows every move of `head`. */
  readonly #memory: MemoryIndex;

  constructor(ctx: DurableObjectState, env: VaultEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
    this.#memory = new MemoryIndex(ctx.storage);
  }

  /** Whether the index holds exactly the files at `head`, and hasn't started over since. */
  #indexedAt(head: string): boolean {
    return (
      this.#get("index_head") === head &&
      this.#memory.lastCommit()?.sha === this.#get("index_commit")
    );
  }

  /**
   * Applies changes to the index as one step toward `head`. Each step gets a fresh id: a head can
   * come back after a rewind, and the index must apply it again rather than skip a known commit.
   */
  async #applyToIndex(head: string, changes: ReadonlyMap<string, string | null>): Promise<void> {
    const seq = Number(this.#get("index_seq") ?? "0") + 1;
    this.#set("index_seq", `${seq}`);
    const id = `${head}#${seq}`;
    await this.#memory.applyCommit({
      sha: id,
      committedAt: Date.now(),
      changes: [...changes].map(([path, content]) => ({ path, content })),
    });
    this.#set("index_head", head);
    this.#set("index_commit", id);
  }

  /**
   * Follows a move of `head` from `previous`: the changes alone when the index was exactly at
   * `previous`, else everything from the working copy, which the move already updated.
   */
  async #index(
    previous: string | null,
    head: string,
    changes: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    if (previous !== null && this.#indexedAt(previous)) await this.#applyToIndex(head, changes);
    else await this.#reindex(head);
  }

  /** The index brought to `head` from the working copy; unchanged notes are skipped. */
  async #reindex(head: string): Promise<void> {
    const changes = new Map<string, string | null>(
      this.#memory.currentPaths().map((path) => [path, null]),
    );
    for (const { path, content } of this.#indexable()) changes.set(path, content);
    await this.#applyToIndex(head, changes);
  }

  /** The working copy as memory indexes it: a held file as it was before its conflict. */
  #indexable(): { path: string; content: string }[] {
    return this.#exec<{ path: string; content: string | null }>(
      `SELECT files.path AS path,
              CASE WHEN held.path IS NULL THEN files.content ELSE held.previous END AS content
       FROM files LEFT JOIN held ON held.path = files.path AND held.content = files.content`,
    ).filter((file): file is { path: string; content: string } => file.content !== null);
  }

  /** Changes as memory indexes them: a held file as it was before its conflict. */
  #indexed(changes: ReadonlyMap<string, string | null>): Map<string, string | null> {
    const held = new Map(
      this.#exec<{ path: string; previous: string | null }>(
        `SELECT held.path AS path, held.previous AS previous FROM held
         JOIN files ON files.path = held.path AND files.content = held.content`,
      ).map((row) => [row.path, row.previous]),
    );
    return new Map(
      [...changes].map(([path, content]) => [
        path,
        held.has(path) ? (held.get(path) ?? null) : content,
      ]),
    );
  }

  /**
   * Brings the index to `head` when it isn't there: after a crash between a move of `head` and its
   * indexing, after a new schema started it over, or when this code first runs on a synced vault.
   */
  async #catchUp(): Promise<void> {
    const head = this.#get("head");
    if (head === null || this.#indexedAt(head)) return;
    await this.#reindex(head);
  }

  #backend(): VaultBackend | null {
    if (backendForTesting !== undefined) return backendForTesting;
    if (this.#cachedBackend === undefined) this.#cachedBackend = backendFor(this.env);
    return this.#cachedBackend;
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  #get(key: string): string | null {
    return (
      this.#exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)[0]?.value ?? null
    );
  }

  #set(key: string, value: string): void {
    this.#exec("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", key, value);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#work.then(task);
    this.#work = run.catch(() => undefined);
    return run;
  }

  /** A file's latest queued write, if one waits: its content, null for a removal. */
  #queuedWrite(path: string): { content: string | null } | undefined {
    return this.#exec<{ content: string | null }>(
      "SELECT content FROM queue WHERE path = ? ORDER BY id DESC LIMIT 1",
      path,
    )[0];
  }

  /** A file as the clients see it: its latest queued write, else the synced head's. */
  #visible(path: string): string | null {
    const queued = this.#queuedWrite(path);
    if (queued !== undefined) return queued.content;
    // A held file shows its version from before the conflict, never the markers.
    const held = this.#exec<{ previous: string | null }>(
      `SELECT held.previous AS previous FROM held
       JOIN files ON files.path = held.path AND files.content = held.content
       WHERE held.path = ?`,
      path,
    )[0];
    if (held !== undefined) return held.previous;
    return (
      this.#exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path)[0]
        ?.content ?? null
    );
  }

  /** Syncs a vault never synced, and makes sure the reconcile is armed. */
  async #ready(): Promise<void> {
    if (this.#get("head") === null) await this.#serialize(() => this.#sync());
    await this.#alarmBy(Date.now() + RECONCILE_MS);
  }

  async read(path: string): Promise<string | null> {
    if (this.#backend() === null) return null;
    await this.#ready();
    return this.#visible(path);
  }

  /**
   * Enfileira as gravações de um cliente, que a leitura vê na hora e o alarme comita segundos depois,
   * cada commit com um trailer `Zikaron-Client` por cliente. Só memória e conhecimento são graváveis,
   * e a pasta de memória do próprio cliente.
   */
  async write(
    client: string,
    changes: { path: string; content: string | null }[],
    summary: string,
  ): Promise<WriteResult> {
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    // Uma gravação num cofre nunca sincronizado precisa da base: sem ela, o merge com o que já está
    // no cofre toma a versão do cofre inteira e põe a gravação de lado.
    await this.#ready();
    const valid =
      isClientName(client) &&
      Array.isArray(changes) &&
      changes.length > 0 &&
      changes.every(
        ({ path, content }) =>
          isWritable(client, path) && (content === null || typeof content === "string"),
      );
    if (!valid) return { ok: false, reason: "invalid_path" };
    const sizes = changes.map(({ content }) => bytes(content));
    if (
      changes.length > MAX_CHANGES ||
      sizes.some((size) => size > MAX_FILE_BYTES) ||
      sizes.reduce((sum, size) => sum + size, 0) > MAX_WRITE_BYTES
    ) {
      return { ok: false, reason: "too_large" };
    }
    const now = Date.now();
    const line = oneLine(summary, `Update memory from ${client}`);
    this.ctx.storage.transactionSync(() => {
      for (const { path, content } of changes) {
        this.#exec(
          "INSERT INTO queue (client, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
          client,
          path,
          content,
          line,
          now,
        );
      }
    });
    await this.#alarmBy(now + FLUSH_DELAY_MS);
    return { ok: true };
  }

  /** The webhook's call: a push reached `ref`. The alarm syncs a moment later, once per burst. */
  async requestSync(ref: string): Promise<void> {
    if (this.#backend() === null) return;
    const branch = this.#get("branch");
    if (branch !== null && ref !== `refs/heads/${branch}`) return;
    await this.#alarmBy(Date.now() + SYNC_DELAY_MS);
  }

  override async alarm(): Promise<void> {
    if (this.#backend() === null) return;
    // O índice alcança o head quando um esquema novo o recomeçou ou uma queda o deixou atrás. Vem
    // antes do trabalho do GitHub, que move o índice sozinho, e falha sem atrasar as gravações.
    try {
      await this.#serialize(() => this.#catchUp());
    } catch (error) {
      console.error("Vault: the index couldn't catch up", errorName(error));
    }
    try {
      await this.#serialize(() => this.#flush());
      await this.#serialize(() => this.#sync());
      this.#set("failures", "0");
      this.#set("retry_at", "0");
    } catch (error) {
      const failures = Number(this.#get("failures") ?? "0") + 1;
      const retryAt = Date.now() + Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
      this.#set("failures", `${failures}`);
      this.#set("retry_at", `${retryAt}`);
      console.error("Vault: a GitHub call failed; retrying", { failures, error: errorName(error) });
      // The retry replaces any sooner alarm: while GitHub fails, writes and pushes wait for it.
      await this.ctx.storage.setAlarm(retryAt);
      return;
    }
    const queued =
      this.#exec<{ n: number }>(`SELECT count(*) AS n FROM queue WHERE path NOT IN (${HELD})`)[0]
        ?.n ?? 0;
    await this.#alarmBy(Date.now() + (queued > 0 ? FLUSH_DELAY_MS : RECONCILE_MS));
  }

  /**
   * Forgets erased content, once the owner rewrote the vault's history: it syncs to the rewritten
   * head, rebuilds memory's index from the working copy alone, which drops every old version, and
   * deletes the rows that name `paths`. A path ending in `/` names a folder. It answers which named
   * files the vault still has. Git is never touched.
   */
  async forget(paths: unknown): Promise<ForgetResult> {
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const valid =
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.length <= MAX_FORGET_PATHS &&
      paths.every(
        (path) => typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_CHARS,
      );
    if (!valid) return { ok: false, reason: "invalid_input" };
    const named = JSON.stringify(paths);
    // A path, or a folder's whole content when it ends in `/`. The table's column is named in full:
    // json_each has a `path` column of its own.
    const matches = (table: string) => `EXISTS (SELECT 1 FROM json_each(?) AS named
      WHERE ${table}.path = named.value
        OR (substr(named.value, -1) = '/' AND substr(${table}.path, 1, length(named.value)) = named.value))`;
    return this.#serialize(async (): Promise<ForgetResult> => {
      try {
        await this.#sync();
      } catch (error) {
        console.error("Vault: forgetting couldn't sync", errorName(error));
        return { ok: false, reason: "unavailable" };
      }
      const forgotten = this.ctx.storage.transactionSync(() => {
        let rows = 0;
        for (const table of PATH_TABLES) {
          // A file the vault still holds with markers keeps its hold, or reads would show them.
          const keep =
            table === "held"
              ? " AND NOT EXISTS (SELECT 1 FROM files WHERE files.path = held.path AND files.content = held.content)"
              : "";
          const where = `FROM ${table} WHERE ${matches(table)}${keep}`;
          rows += this.#exec<{ n: number }>(`SELECT count(*) AS n ${where}`, named)[0]?.n ?? 0;
          this.#exec(`DELETE ${where}`, named);
        }
        return rows;
      });
      const stillInVault = this.#exec<{ path: string }>(
        `SELECT path FROM files WHERE ${matches("files")} ORDER BY path`,
        named,
      ).map((row) => row.path);
      const head = this.#get("head") ?? "";
      const files = this.#indexable();
      const seq = Number(this.#get("index_seq") ?? "0") + 1;
      this.#set("index_seq", `${seq}`);
      const id = `${head}#${seq}`;
      await this.#memory.rebuild([{ sha: id, committedAt: Date.now(), changes: files }]);
      this.#set("index_head", head);
      this.#set("index_commit", id);
      await this.#alarmBy(Date.now() + FLUSH_DELAY_MS);
      // The paths may name people, so the log holds only counts.
      console.log("Vault: forgot erased content", {
        paths: paths.length,
        rows: forgotten,
        stillInVault: stillInVault.length,
      });
      return { ok: true, forgotten, stillInVault };
    });
  }

  /** Files held with conflict markers, which wait for the owner to push them without markers. */
  async held(): Promise<HeldFile[]> {
    if (this.#backend() === null) return [];
    return this.#exec<{ path: string; at: number }>("SELECT path, at FROM held ORDER BY at");
  }

  /** Sets the alarm to `at`, unless one is due sooner; never before a pending retry. */
  async #alarmBy(at: number): Promise<void> {
    const when = Math.max(at, Number(this.#get("retry_at") ?? "0"));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }

  async #branch(backend: VaultBackend): Promise<string> {
    const known = this.#get("branch");
    if (known !== null) return known;
    const branch = await backend.defaultBranch();
    this.#set("branch", branch);
    return branch;
  }

  /** Brings the working copy to the remote head. Runs inside `#serialize`. */
  async #sync(): Promise<void> {
    const backend = this.#backend();
    if (backend === null) return;
    let branch = await this.#branch(backend);
    let remote = await backend.branchHead(branch);
    if (remote === null) {
      // The default branch was renamed: read it again.
      branch = await backend.defaultBranch();
      this.#set("branch", branch);
      remote = await backend.branchHead(branch);
    }
    if (remote === null) throw new Error(`the vault has no branch ${branch}`);
    const head = this.#get("head");
    if (remote !== head) {
      const diff = head === null ? null : await backend.diff(head, remote);
      const snapshot = diff === null ? await backend.snapshot(remote) : null;
      const previous = head;
      const changed = this.ctx.storage.transactionSync(() => {
        const bases = this.#queuedBases();
        const incoming: readonly { path: string; content: string | null }[] =
          snapshot?.files ?? diff?.changes ?? [];
        // What the vault had before a push that brings conflict markers, shown while they wait.
        const before = new Map(
          incoming
            .filter((file) => file.content !== null && hasConflictMarkers(file.content))
            .map((file) => [file.path, this.#fileContent(file.path)] as const),
        );
        const changed = snapshot
          ? this.#replaceFiles(snapshot.files)
          : this.#apply(diff?.changes ?? []);
        for (const [path, content] of changed) {
          if (content !== null && hasConflictMarkers(content)) {
            // Held as pushed: queued writes would carry the markers, or overwrite the push.
            this.#hold(path, content, before.get(path) ?? null);
            continue;
          }
          // The owner pushed it without markers: the hold ends, and queued writes merge into it.
          this.#exec("DELETE FROM held WHERE path = ?", path);
          this.#settleQueued(path, content, bases.get(path) ?? null);
        }
        this.#set("head", remote);
        // A merge's mark, and the note text it keeps, go with its version, unless it waits to
        // commit (Kelpie ran this in its daily lifecycle).
        this.#exec(
          `DELETE FROM owner_merges WHERE path NOT IN (SELECT path FROM queue) AND NOT EXISTS
             (SELECT 1 FROM files f WHERE f.path = owner_merges.path AND f.content = owner_merges.content)`,
        );
        return changed;
      });
      await this.#index(previous, remote, this.#indexed(changed));
    }
    await this.#alarmBy(Date.now() + RECONCILE_MS);
  }

  /** Applies a diff to the files; returns each changed path with its new content. */
  #apply(changes: readonly FileChange[]): Map<string, string | null> {
    for (const change of changes) {
      if (change.content === null) {
        this.#exec("DELETE FROM files WHERE path = ?", change.path);
        this.#exec("DELETE FROM authored WHERE path = ?", change.path);
      } else {
        this.#exec(
          "INSERT OR REPLACE INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
          change.path,
          change.content,
          change.blobSha ?? "",
        );
      }
    }
    return new Map(changes.map((change) => [change.path, change.content]));
  }

  /** Replaces every file with a snapshot's; returns each changed path with its new content. */
  #replaceFiles(files: readonly VaultFile[]): Map<string, string | null> {
    const before = new Map(
      this.#exec<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM files").map(
        (row) => [row.path, row.blob_sha],
      ),
    );
    this.#exec("DELETE FROM files");
    const changed = new Map<string, string | null>([...before.keys()].map((path) => [path, null]));
    for (const file of files) {
      this.#exec(
        "INSERT INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
        file.path,
        file.content,
        file.blobSha,
      );
      if (before.get(file.path) === file.blobSha) changed.delete(file.path);
      else changed.set(file.path, file.content);
    }
    // A file the vault no longer has leaves no provenance behind.
    this.#exec("DELETE FROM authored WHERE path NOT IN (SELECT path FROM files)");
    return changed;
  }

  /**
   * Holds a file pushed with conflict markers. A file pushed again still unresolved keeps the
   * version from before its first conflict, which is what reads show while it waits.
   */
  #hold(path: string, content: string, before: string | null): void {
    const earlier = this.#exec<{ previous: string | null }>(
      "SELECT previous FROM held WHERE path = ?",
      path,
    )[0];
    const previous =
      before !== null && hasConflictMarkers(before) ? (earlier?.previous ?? null) : before;
    this.#exec(
      "INSERT OR REPLACE INTO held (path, content, previous, at) VALUES (?, ?, ?, ?)",
      path,
      content,
      previous,
      Date.now(),
    );
  }

  /**
   * The working copy of every path with queued writes, read before a sync replaces it: what those
   * writes were built on, since a write is made on what a read shows, queued writes included.
   */
  #queuedBases(): Map<string, string | null> {
    return new Map(
      this.#exec<{ path: string; content: string | null }>(
        `SELECT files.path AS path,
                CASE WHEN held.path IS NULL THEN files.content ELSE held.previous END AS content
         FROM files LEFT JOIN held ON held.path = files.path AND held.content = files.content
         WHERE files.path IN (SELECT path FROM queue)`,
      ).map((row) => [row.path, row.content]),
    );
  }

  /**
   * Reconciles the writes queued for a path with the content a sync brought for it: the owner's
   * edit, merged with the server's latest write line by line from `base`, the owner's side winning
   * where they overlap. Without a common version, or when either side removed the file, the owner's
   * edit wins whole. Writes that lost lines are set aside in `conflicts`.
   */
  #settleQueued(path: string, incoming: string | null, base: string | null): void {
    const queued = this.#exec<{
      id: number;
      client: string;
      content: string | null;
      summary: string;
      queued_at: number;
    }>(
      "SELECT id, client, content, summary, queued_at FROM queue WHERE path = ? ORDER BY id",
      path,
    );
    const last = queued.at(-1);
    if (last === undefined) return;
    const landed = queued.findLastIndex((row) => row.content === incoming);
    if (landed !== -1) {
      // The server's own commit, whose answer was lost: those writes are done, later ones wait.
      this.#exec("DELETE FROM queue WHERE path = ? AND id <= ?", path, queued[landed]?.id ?? 0);
      // And the version is the server's.
      if (incoming !== null) {
        this.#exec(
          "INSERT OR REPLACE INTO authored (path, blob_sha) SELECT path, blob_sha FROM files WHERE path = ?",
          path,
        );
      }
      return;
    }
    const result =
      incoming !== null && base !== null && last.content !== null
        ? mergeOwnerWins(base, incoming, last.content)
        : null;
    // A merge that still holds conflict markers is never committed: the owner's edit wins whole.
    const merged = result !== null && !hasConflictMarkers(result.content) ? result : null;
    this.#exec("DELETE FROM queue WHERE path = ?", path);
    this.#exec("DELETE FROM owner_merges WHERE path = ?", path);
    if (merged !== null && merged.content !== incoming) {
      // One write, on top of the owner's edit.
      this.#exec(
        "INSERT INTO queue (client, path, content, summary, queued_at) VALUES (?, ?, ?, ?, ?)",
        last.client,
        path,
        merged.content,
        last.summary,
        last.queued_at,
      );
      // Once committed it is the server's version, but it holds the owner's lines.
      this.#exec("INSERT INTO owner_merges (path, content) VALUES (?, ?)", path, merged.content);
    }
    if (merged !== null && !merged.overlapped) return;
    for (const { client, content } of queued) {
      this.#exec(
        "INSERT INTO conflicts (client, path, content, reason, at) VALUES (?, ?, ?, 'owner_won', ?)",
        client,
        path,
        content,
        Date.now(),
      );
    }
    // The path may name a person, so the log holds only how many writes yielded.
    console.warn("Vault: the owner's edit won over queued writes", { writes: queued.length });
  }

  /** The oldest queued writes that fit in one commit, at most `limit`, without `skip`. */
  #nextBatch(limit: number, skip: number | null): QueuedRow[] {
    const rows = this.#exec<QueuedRow>(
      `SELECT id, client, path, content, summary FROM queue
       WHERE id != ? AND path NOT IN (${HELD}) ORDER BY id LIMIT ?`,
      skip ?? -1,
      limit,
    );
    const batch: QueuedRow[] = [];
    let total = 0;
    for (const row of rows) {
      total += bytes(row.content);
      if (batch.length > 0 && total > MAX_BATCH_BYTES) break;
      batch.push(row);
    }
    return batch;
  }

  /**
   * Commits the queued writes, a batch per commit. Runs inside `#serialize`.
   * - A batch GitHub refuses is split in half until one write is refused alone. That write is set
   *   aside in `conflicts` only once the next write, also alone, goes through: then the refusal was
   *   its own. If that one is refused too, GitHub is refusing everything, and nothing is set aside.
   * - A batch whose commit fails is retried at half its size next time, in case it was too large;
   *   the size grows back after a flush that commits everything.
   * - A failed call throws, and the alarm retries later. Writes wait, and stay readable.
   */
  async #flush(): Promise<void> {
    const backend = this.#backend();
    if (backend === null) return;
    const base = Number(this.#get("batch_rows") ?? `${MAX_BATCH_ROWS}`);
    let limit = base;
    let stale = 0;
    let needsSync = true;
    /** A write refused alone, waiting for proof that the refusal was its own. */
    let suspect: QueuedRow | null = null;
    for (;;) {
      if (needsSync) await this.#sync();
      needsSync = false;
      // A sync may have settled the suspect: an owner's edit, or the server's own lost commit.
      if (suspect && !this.#queued(suspect.id)) suspect = null;
      const rows = this.#nextBatch(suspect ? 1 : limit, suspect?.id ?? null);
      const last = rows.at(-1);
      if (last === undefined) {
        if (suspect) throw new Error("GitHub refused a write, and no other write can show why");
        this.#set("batch_rows", `${Math.min(base * 2, MAX_BATCH_ROWS)}`);
        return;
      }
      const latest = new Map(rows.map((row) => [row.path, row.content]));
      // A write equal to the vault's file, or the removal of a file it doesn't have, is nothing to
      // commit; GitHub would refuse such a removal.
      const writes = [...latest]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .filter(([path, content]) => this.#fileContent(path) !== content)
        .map(([path, content]) => ({ path, content }));
      const deletions = [...latest]
        .filter(([path, content]) => content === null && this.#fileContent(path) !== null)
        .map(([path]) => path);
      // Writes to a held file were left out of the batch, and stay.
      const done = () =>
        this.#exec(
          `DELETE FROM queue WHERE id <= ? AND id != ? AND path NOT IN (${HELD})`,
          last.id,
          suspect?.id ?? -1,
        );
      if (writes.length === 0 && deletions.length === 0) {
        done();
        continue;
      }
      const clients = [...new Set(rows.map((row) => row.client))].sort();
      const summaries = [...new Set(rows.map((row) => row.summary))];
      const headline =
        summaries.length === 1
          ? (summaries[0] ?? "")
          : `Update ${latest.size} files from ${clients.join(", ")}`;
      const shas = await Promise.all(writes.map(({ content }) => gitBlobSha(content)));
      const previousHead = this.#get("head");
      let outcome: Awaited<ReturnType<VaultBackend["commit"]>>;
      // Sempre sobre o head sincronizado: se ele andou, o GitHub responde `stale` e o lote é refeito
      // depois de um sync. O servidor nunca faz force-push.
      try {
        outcome = await backend.commit({
          branch: await this.#branch(backend),
          expectedHead: this.#get("head") ?? "",
          headline,
          body: clients.map((client) => `Zikaron-Client: ${client}`).join("\n"),
          writes,
          deletions,
        });
      } catch (error) {
        if (rows.length > 1) this.#set("batch_rows", `${Math.floor(rows.length / 2)}`);
        throw error;
      }
      if (outcome.kind === "stale") {
        stale += 1;
        if (stale >= MAX_COMMIT_ATTEMPTS) throw new Error("the vault kept moving while committing");
        needsSync = true;
        continue;
      }
      stale = 0;
      if (outcome.kind === "refused") {
        if (rows.length > 1) {
          limit = Math.max(1, Math.floor(rows.length / 2));
        } else if (suspect === null) {
          suspect = last;
        } else {
          throw new Error(`GitHub refuses every commit (${outcome.reason})`);
        }
        continue;
      }
      const commit = outcome.commit;
      this.ctx.storage.transactionSync(() => {
        writes.forEach(({ path, content }, i) => {
          this.#exec(
            "INSERT OR REPLACE INTO files (path, content, blob_sha) VALUES (?, ?, ?)",
            path,
            content,
            shas[i] ?? "",
          );
          // Provenance: this version is the server's.
          this.#exec(
            "INSERT OR REPLACE INTO authored (path, blob_sha) VALUES (?, ?)",
            path,
            shas[i] ?? "",
          );
        });
        for (const path of deletions) {
          this.#exec("DELETE FROM files WHERE path = ?", path);
          this.#exec("DELETE FROM authored WHERE path = ?", path);
          this.#exec("DELETE FROM owner_merges WHERE path = ?", path);
        }
        // A merge's mark lasts while its version does.
        for (const { path, content } of writes) {
          this.#exec("DELETE FROM owner_merges WHERE path = ? AND content != ?", path, content);
        }
        // Writes queued while the commit was in flight have larger ids, and stay.
        done();
        this.#set("head", commit);
      });
      await this.#index(
        previousHead,
        commit,
        new Map<string, string | null>([
          ...writes.map(({ path, content }) => [path, content] as const),
          ...deletions.map((path) => [path, null] as const),
        ]),
      );
      if (suspect) {
        this.#setAside(suspect);
        suspect = null;
      }
      limit = base;
    }
  }

  #queued(id: number): boolean {
    return this.#exec("SELECT 1 AS one FROM queue WHERE id = ?", id).length > 0;
  }

  #fileContent(path: string): string | null {
    return (
      this.#exec<{ content: string }>("SELECT content FROM files WHERE path = ?", path)[0]
        ?.content ?? null
    );
  }

  /** Sets aside one write GitHub refused on its own, so the writes after it go through. */
  #setAside(row: QueuedRow): void {
    this.ctx.storage.transactionSync(() => {
      this.#exec(
        "INSERT INTO conflicts (client, path, content, reason, at) VALUES (?, ?, ?, 'refused', ?)",
        row.client,
        row.path,
        row.content,
        Date.now(),
      );
      this.#exec("DELETE FROM queue WHERE id = ?", row.id);
    });
    console.error("Vault: GitHub refused a write; it was set aside");
  }
}

/** One line of at most 200 characters, for a commit headline. */
function oneLine(text: unknown, fallback: string): string {
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return line === "" ? fallback : line;
}
