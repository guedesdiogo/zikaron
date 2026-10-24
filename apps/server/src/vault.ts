import { DurableObject } from "cloudflare:workers";
import {
  bodyWithoutHeading,
  coreBlock,
  coreCarries,
  type IndexedVersion,
  MemoryFormatError,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  needsMemory,
  noteVersion,
  pack,
  readNote as parseNote,
  provenanceLine,
  type ReaderPolicy,
  readPage,
  renderHits,
  retrieve,
  writeMemory,
} from "@zikaron/memory";
import {
  type FileChange,
  GitHubVaultBackend,
  gitBlobSha,
  type VaultBackend,
  type VaultFile,
} from "@zikaron/vault";
import { hasConflictMarkers } from "./conflicts.ts";
import { type Client, type Clients, parseClients, readerPolicy } from "./identity.ts";
import { mergeOwnerWins } from "./merge.ts";
import {
  archivedInput,
  budgetOf,
  buildMemory,
  CORE_TOKENS,
  type CoreResult,
  claimProblems,
  type ForgetNoteResult,
  given,
  MAX_CORE_TOKENS,
  MAX_PATH_NUMBER,
  MAX_QUESTION_CHARS,
  MAX_RECALL_TOKENS,
  MAX_SEARCH_K,
  type MemoryWriteInput,
  mayCreateIn,
  type NoteClaim,
  type NoteHit,
  PENDING_LIMIT,
  type PendingResult,
  RECALL_LIMIT,
  RECALL_TOKENS,
  type ReadResult,
  type RecallResult,
  SEARCH_K,
  type SearchResult,
  sameVersion,
  saysTheSame,
  type WriteNoteResult,
  writeClaim,
} from "./notes.ts";
import { isClientName, isWritable } from "./paths.ts";
import { decideWrite, mayForget, type Previous, type WriteClaim } from "./rules.ts";

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

  // As operações de memória (#126 do Kelpie, sem modelos), por cliente. Cada uma recebe o nome do
  // cliente que a rota autenticou e lê a configuração dele aqui. Toda leitura passa pela política
  // de leitura do ADR-0001 §5: uma nota que o leitor não vê responde como uma nota que não existe.
  // As leituras mostram só o que o índice tem, nunca uma gravação ainda na fila, que o leitor talvez
  // não pudesse ver; uma gravação por cima de uma nota com outra gravação na fila é `changed`.

  /** O cliente pelo nome, com a política de leitura dele; null quando a configuração não o tem. */
  #who(name: unknown): { client: Client; policy: ReaderPolicy } | null {
    if (typeof name !== "string") return null;
    let clients: Clients;
    try {
      clients = parseClients(this.env.ZIKARON_CLIENTS);
    } catch {
      return null;
    }
    const client = [...clients.values()].find((each) => each.name === name);
    return client === undefined ? null : { client, policy: readerPolicy(client, clients) };
  }

  /** O índice no head, para as operações de memória. */
  async #memoryReady(): Promise<void> {
    await this.#ready();
    await this.#catchUp();
  }

  /** O arquivo mostra exatamente a versão do índice: nenhuma gravação dele espera na fila. */
  async #synced(text: string | null, version: IndexedVersion): Promise<boolean> {
    return text !== null && (await gitBlobSha(text)) === version.blobSha;
  }

  /**
   * A versão atual de um caminho como a regra de gravação a lê (ADR-0001 §4): a confiança vem do
   * índice, com a configuração de todos os clientes. Um merge da gravação do servidor com a edição
   * do dono guarda as linhas do dono e conta como do dono, como no Kelpie (#160).
   */
  #previous(found: IndexedVersion, client: Client, policy: ReaderPolicy): Previous {
    const trust = this.#memory.trust(found.path, policy) ?? { ownerGrade: false, tainted: true };
    const merged =
      this.#exec(
        `SELECT 1 AS one FROM files f JOIN owner_merges m ON m.path = f.path AND m.content = f.content
         WHERE f.path = ?`,
        found.path,
      ).length > 0;
    return {
      ownerGrade: trust.ownerGrade || merged,
      tainted: trust.tainted,
      archived: found.archived,
      inCore: coreCarries(
        { path: found.path, scope: found.scope, pinned: found.pinned },
        client.name,
      ),
      pending: found.origin?.review === "pending",
      client: found.origin?.client ?? null,
    };
  }

  /** O cliente da última gravação na fila de um caminho, se alguma espera. */
  #queuedBy(path: string): string | null {
    return (
      this.#exec<{ client: string }>(
        "SELECT client FROM queue WHERE path = ? ORDER BY id DESC LIMIT 1",
        path,
      )[0]?.client ?? null
    );
  }

  /**
   * O núcleo (#112) para o cliente: as notas fixadas no escopo global ou no dele, o perfil do dono e
   * o dele, só as que ele pode ver, cada uma com a origem. 1.000 tokens por padrão, 4.000 no máximo.
   * Uma falha responde um bloco vazio, e a conversa segue sem ele.
   */
  async core(name: string, budgetTokens?: number | null): Promise<CoreResult> {
    const empty: CoreResult = { text: "", tokens: 0, paths: [], omitted: 0 };
    const who = this.#who(name);
    const budget = budgetOf(budgetTokens, CORE_TOKENS, MAX_CORE_TOKENS);
    if (who === null || budget === 0 || this.#backend() === null) return empty;
    try {
      await this.#memoryReady();
      return coreBlock(this.#memory, {
        agentId: who.client.name,
        budgetTokens: budget,
        now: Date.now(),
        reader: who.policy,
      });
    } catch (error) {
      console.error("Vault: the core failed", errorName(error));
      return empty;
    }
  }

  /**
   * As memórias que respondem uma pergunta, no cercado (#110), sem vetores nem rerank: o portão do
   * `needsMemory`, a busca com a política do leitor, sem as vencidas, e o empacotamento no orçamento
   * (1.000 tokens por padrão, 8.000 no máximo). Uma falha responde um bloco vazio.
   */
  async recall(
    name: string,
    question: string,
    options: {
      budgetTokens?: number | null | undefined;
      includeArchived?: boolean | null | undefined;
    } = {},
  ): Promise<RecallResult> {
    const empty: RecallResult = { text: "", tokens: 0, paths: [] };
    const who = this.#who(name);
    const budget = budgetOf(options?.budgetTokens, RECALL_TOKENS, MAX_RECALL_TOKENS);
    const text = typeof question === "string" ? question.slice(0, MAX_QUESTION_CHARS).trim() : "";
    if (who === null || budget === 0 || !needsMemory(text) || this.#backend() === null) {
      return empty;
    }
    try {
      await this.#memoryReady();
      const hits = retrieve(this.#memory, text, {
        limit: RECALL_LIMIT,
        notExpiredAt: Date.now(),
        reader: who.policy,
        includeArchived: options?.includeArchived === true,
      });
      return pack(this.#memory, hits, { budgetTokens: budget, reader: who.policy });
    } catch (error) {
      console.error("Vault: recall failed", errorName(error));
      return empty;
    }
  }

  /**
   * As notas que respondem uma busca, para o `memory_search`: a mesma busca do recall, como lista
   * no cercado. 3 por padrão, 10 no máximo. Uma nota com uma gravação na fila não dá versão.
   */
  async search(
    name: string,
    query: string,
    options: { k?: number | null | undefined; includeArchived?: boolean | null | undefined } = {},
  ): Promise<SearchResult> {
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const k = Math.min(
      Math.max(Math.floor(Number(options?.k ?? SEARCH_K)) || SEARCH_K, 1),
      MAX_SEARCH_K,
    );
    const text = typeof query === "string" ? query.slice(0, MAX_QUESTION_CHARS).trim() : "";
    try {
      await this.#memoryReady();
      const hits =
        text === ""
          ? []
          : retrieve(this.#memory, text, {
              limit: RECALL_LIMIT,
              notExpiredAt: Date.now(),
              reader: who.policy,
              includeArchived: options?.includeArchived === true,
            }).slice(0, k);
      const found = (
        await Promise.all(
          hits.map(async (hit) => {
            const version = this.#memory.versionOf(hit.path, hit.commit);
            if (version === null) return [];
            const synced = await this.#synced(this.#visible(hit.path), version);
            const note: NoteHit = {
              path: hit.path,
              title: hit.title,
              abstract: hit.abstract,
              kind: hit.kind,
              scope: version.scope,
              validFrom: version.validFrom,
              invalidAt: version.invalidAt,
              archived: version.archived,
              origin: provenanceLine(this.#memory, version, who.policy),
              version: hit.current && synced ? version.blobSha.slice(0, 12) : null,
            };
            return [{ note, start: bodyWithoutHeading(version.title, version.body).slice(0, 400) }];
          }),
        )
      ).flat();
      return {
        ok: true,
        text: renderHits(
          found.map(({ note, start }) => ({
            ...note,
            current: true,
            start,
            provenance: note.origin,
          })),
        ),
        notes: found.map(({ note }) => note),
      };
    } catch (error) {
      console.error("Vault: search failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Uma nota, uma página por vez, para o `memory_read`: a versão do índice que o leitor pode ver,
   * arquivada também, e na primeira página os links que ele pode seguir. Qualquer outra coisa é
   * «not found», exista ou não.
   */
  async readNote(
    name: string,
    path: string,
    options: { offset?: number | null | undefined } = {},
  ): Promise<ReadResult> {
    const notFound: ReadResult = { ok: false, reason: "not_found" };
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    if (typeof path !== "string" || path.length > MAX_PATH_CHARS) return notFound;
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const reader = who.policy;
    try {
      await this.#memoryReady();
      const version = this.#memory.current(path, { reader });
      // Uma remoção na fila já tirou a nota.
      if (version === null || this.#visible(path) === null) return notFound;
      const offset = Math.max(Math.floor(Number(options?.offset ?? 0)) || 0, 0);
      const links: { title: string; path: string }[] = [];
      if (offset === 0) {
        const seen = new Set([path]);
        for (const link of this.#memory.links(path, { reader })) {
          if (link.path === null || seen.has(link.path)) continue;
          seen.add(link.path);
          const target = this.#memory.current(link.path, { reader });
          if (target !== null) links.push({ title: target.title, path: link.path });
        }
      }
      const shown = version.blobSha.slice(0, 12);
      const page = readPage(version, {
        offset,
        links,
        version: shown,
        provenance: provenanceLine(this.#memory, version, reader),
      });
      return { ok: true, path, text: page.text, nextOffset: page.nextOffset, version: shown };
    } catch (error) {
      console.error("Vault: reading a note failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * O escritor por trás do `memory_write` e do `/v1/write`, com a regra de gravação do ADR-0001 §4.
   * - **Onde:** com `path`, uma nota que o leitor vê ganha a memória como nova versão, do mesmo tipo
   *   e escopo, e guarda o que a memória deixou de fora. Sem `path`, a memória vai aonde o título a
   *   põe, numerada quando o caminho está tomado, no escopo `global` por padrão, ou no do próprio
   *   cliente, numa área ou num projeto.
   * - **Versões (#297 do Kelpie):** `path` pede a versão que o leitor viu; uma versão gravada depois,
   *   ou uma gravação ainda na fila, é `changed`, e nada é gravado.
   * - **A regra decide** a origem e o nível, e recusa: rotina agendada (`cron`), `pinned`, nota do
   *   dono, do núcleo ou arquivada. Por cima de uma versão contaminada, a nova herda a marca.
   * - **Sem novidade:** a mesma versão de novo, ou uma nota que já diz o mesmo e o leitor vê, é
   *   `unchanged`, e nada é gravado.
   * Título, corpo, resumo, entidades e evidência perdem os segredos antes. O resumo do commit nunca
   * nomeia a nota.
   */
  async writeNote(
    name: string,
    claim: NoteClaim,
    input: MemoryWriteInput,
  ): Promise<WriteNoteResult> {
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    const { client, policy } = who;
    const claimed = claimProblems(claim);
    if (claimed.length > 0) return { ok: false, reason: "invalid", problems: claimed };
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, reason: "invalid", problems: ["the memory isn't valid"] };
    }
    // Uma rotina agendada, ou um pin, é recusado antes de tudo, sem commit.
    const rule = writeClaim(claim, given(input.pinned) !== undefined);
    const early = decideWrite(client, rule, null);
    if (!early.ok) return { ok: false, reason: early.reason };
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const notFound: WriteNoteResult = { ok: false, reason: "not_found" };
    const path = given(input.path);
    try {
      await this.#memoryReady();
      if (path !== undefined && (typeof path !== "string" || path.length > MAX_PATH_CHARS)) {
        return notFound;
      }
      const found = path === undefined ? null : this.#memory.current(path, { reader: policy });
      if (path !== undefined && found === null) return notFound;
      if (found !== null && !isWritable(client.name, found.path)) {
        return { ok: false, reason: "scope_not_allowed" };
      }
      // A nota como o arquivo a mostra agora; uma remoção na fila já a tirou.
      const text = found === null ? null : this.#visible(found.path);
      if (found !== null && text === null) return notFound;
      const before = found === null || text === null ? null : parseNote(found.path, text);
      const problems = this.#writeProblems(input, found, policy);
      if (problems.length > 0) return { ok: false, reason: "invalid", problems };
      const at = new Date().toISOString();
      // Confere todos os campos antes de qualquer leitura deles; o nível certo vem da regra.
      await writeMemory(buildMemory(input, before, { level: "inferred" }), { at });
      if (found === null || text === null) {
        return await this.#writeNew(client, policy, rule, input, at);
      }

      const decision = decideWrite(client, rule, this.#previous(found, client, policy));
      if (!decision.ok) return { ok: false, reason: decision.reason };
      const memory = buildMemory(input, before, decision);
      const written = (await writeMemory(memory, { at, existing: text })).text;
      if (sameVersion(text, written)) {
        return {
          ok: true,
          action: "unchanged",
          path: found.path,
          version: await noteVersion(text),
        };
      }
      const expected = this.#versionProblem(input.version);
      if (expected.problem !== null) {
        return { ok: false, reason: "invalid", problems: [expected.problem] };
      }
      if (
        !(await this.#synced(text, found)) ||
        expected.version !== (await noteVersion(text)) ||
        this.#visible(found.path) !== text
      ) {
        return { ok: false, reason: "changed" };
      }
      return await this.#queueNote(client.name, found.path, written, "Grava uma nota");
    } catch (error) {
      if (error instanceof MemoryFormatError) {
        return { ok: false, reason: "invalid", problems: [...error.problems] };
      }
      console.error("Vault: writing a memory failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /** O que uma memória tem de errado antes da regra, como o Kelpie confere. */
  #writeProblems(
    input: MemoryWriteInput,
    found: IndexedVersion | null,
    policy: ReaderPolicy,
  ): string[] {
    const problems: string[] = [];
    // Uma nota fundida em outra do escopo dela (#112): o que ela tinha está lá, e a próxima versão
    // também. Uma nota que o leitor não vê não é nomeada.
    const into = found === null ? null : this.#memory.mergedInto(found.path);
    if (into !== null) {
      problems.push(
        this.#memory.current(into, { reader: policy }) === null
          ? "the note was merged into another note"
          : `the note was merged into ${into}: write to that one`,
      );
    }
    if (found !== null && given(input.scope) !== undefined && input.scope !== found.scope) {
      problems.push(`\`scope\` must be the note's own, ${found.scope}`);
    }
    if (found !== null && input.kind !== found.kind) {
      problems.push(`\`kind\` must be the note's own, ${found.kind}`);
    }
    if (input.kind === "session") {
      problems.push("`kind` can't be session: a conversation's pages are written for it");
    }
    if (typeof input.body === "string" && hasConflictMarkers(input.body)) {
      problems.push("`body` holds merge conflict markers");
    }
    const entities = given(input.entities);
    if (entities !== undefined && !Array.isArray(entities)) {
      problems.push("`entities` must be a list of names");
    }
    if (input.kind === "event" && given(input.validFrom) === undefined && found === null) {
      problems.push("an event needs `validFrom`, its date");
    }
    return problems;
  }

  /** A versão que uma gravação sobre uma nota encontrada nomeia, ou o que há de errado nela. */
  #versionProblem(value: unknown): { version: string; problem: null } | { problem: string } {
    const version = given(value);
    if (typeof version !== "string" || version === "") {
      return {
        problem:
          "`version` is required with `path`: pass the version memory_read or memory_search showed for the note",
      };
    }
    if (!/^[0-9a-f]{12}$/.test(version)) {
      return {
        problem:
          "`version` must be the 12 letters and digits memory_read or memory_search showed, as shown",
      };
    }
    return { version, problem: null };
  }

  /**
   * Uma nota nova: aonde o título a põe, numerada quando outra nota tem o caminho. Uma nota que já
   * diz o mesmo é `unchanged` só quando o leitor a vê, ou quando é a gravação dele ainda na fila:
   * nunca se revela uma nota que ele não vê.
   */
  async #writeNew(
    client: Client,
    policy: ReaderPolicy,
    rule: WriteClaim,
    input: MemoryWriteInput,
    at: string,
  ): Promise<WriteNoteResult> {
    const decision = decideWrite(client, rule, null);
    if (!decision.ok) return { ok: false, reason: decision.reason };
    const memory = buildMemory(input, null, decision);
    if (!mayCreateIn(client.name, memory.scope)) return { ok: false, reason: "scope_not_allowed" };
    const text = (await writeMemory(memory, { at })).text;
    const version = await noteVersion(text);
    const twin = await this.#sameNote(
      this.#memory
        .titled(memory.title, { scopes: [memory.scope], reader: policy, limit: 20 })
        .filter((hit) => hit.kind === memory.kind)
        .map((hit) => hit.path),
      memory,
      client,
      policy,
    );
    if (twin !== null) return { ok: true, action: "unchanged", ...twin };
    const date = memory.kind === "event" ? memory.validFrom?.slice(0, 10) : undefined;
    const own = memoryPath(memory.scope, memory.kind, memory.title, date);
    for (let n = 1; n <= MAX_PATH_NUMBER; n += 1) {
      const candidate = n === 1 ? own : own.replace(/\.md$/, `-${n}.md`);
      // Daqui até a fila, nada espera: outra gravação não toma o caminho no meio.
      if (this.#visible(candidate) === null) {
        return await this.#queueNote(client.name, candidate, text, "Grava uma nota", version);
      }
      const same = await this.#sameNote([candidate], memory, client, policy);
      if (same !== null) return { ok: true, action: "unchanged", ...same };
    }
    return {
      ok: false,
      reason: "invalid",
      problems: ["too many notes share this title; choose another"],
    };
  }

  /**
   * A primeira destas notas que já diz a memória e que o leitor pode saber que existe: uma que ele
   * vê, sem gravação na fila, ou a gravação dele mesmo ainda na fila.
   */
  async #sameNote(
    paths: readonly string[],
    memory: MemoryInput,
    client: Client,
    policy: ReaderPolicy,
  ): Promise<{ path: string; version: string } | null> {
    for (const path of paths) {
      const text = this.#visible(path);
      const note = text === null ? null : parseNote(path, text);
      if (text === null || note === null || !saysTheSame(note, memory)) continue;
      const indexed = this.#memory.current(path, { reader: policy });
      const queuedBy = this.#queuedBy(path);
      const known =
        queuedBy === null
          ? indexed !== null && (await this.#synced(text, indexed))
          : queuedBy === client.name;
      if (known) return { path, version: await noteVersion(text) };
    }
    return null;
  }

  /** Enfileira uma versão; o resumo do commit nunca nomeia a nota. */
  async #queueNote(
    client: string,
    path: string,
    content: string,
    summary: string,
    version?: string,
  ): Promise<WriteNoteResult> {
    const written = await this.write(client, [{ path, content }], summary);
    if (written.ok) {
      return {
        ok: true,
        action: "written",
        path,
        version: version ?? (await noteVersion(content)),
      };
    }
    if (written.reason === "invalid_path") {
      return { ok: false, reason: "invalid", problems: ["the note's path can't be written"] };
    }
    return { ok: false, reason: written.reason };
  }

  /**
   * «Esqueça» vindo de um cliente (ADR-0001 §4): só uma nota que ele vê, gravada por ele ou à espera
   * do «sim», fora do núcleo e que não vale como do dono. O git guarda a versão anterior.
   */
  async forgetNote(name: string, path: string): Promise<ForgetNoteResult> {
    const notFound: ForgetNoteResult = { ok: false, reason: "not_found" };
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    if (typeof path !== "string" || path.length > MAX_PATH_CHARS) return notFound;
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const { client, policy } = who;
    try {
      await this.#memoryReady();
      const found = this.#memory.current(path, { reader: policy });
      const text = this.#visible(path);
      if (found === null || text === null) return notFound;
      if (!isWritable(client.name, path)) return { ok: false, reason: "scope_not_allowed" };
      const previous = this.#previous(found, client, policy);
      if (!mayForget(client, previous)) {
        const reason = previous.ownerGrade
          ? "owners_note"
          : previous.inCore
            ? "core_note"
            : "not_own";
        return { ok: false, reason };
      }
      if (!(await this.#synced(text, found)) || this.#visible(path) !== text) {
        return { ok: false, reason: "changed" };
      }
      const written = await this.write(client.name, [{ path, content: null }], "Remove uma nota");
      if (written.ok) return { ok: true, path };
      return { ok: false, reason: written.reason === "vault_off" ? "vault_off" : "unavailable" };
    } catch (error) {
      console.error("Vault: forgetting a note failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Arquiva uma nota (#6): uma nova versão dela inteira com `archived: true`, pela mesma regra de
   * gravação, a partir da versão que o leitor viu. Ela sai da busca, do recall e do núcleo, e
   * continua legível pelo caminho.
   */
  async archiveNote(
    name: string,
    claim: NoteClaim,
    path: string,
    version: string,
  ): Promise<WriteNoteResult> {
    const notFound: WriteNoteResult = { ok: false, reason: "not_found" };
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    const claimed = claimProblems(claim);
    if (claimed.length > 0) return { ok: false, reason: "invalid", problems: claimed };
    const rule = writeClaim(claim, false);
    const early = decideWrite(who.client, rule, null);
    if (!early.ok) return { ok: false, reason: early.reason };
    if (typeof path !== "string" || path.length > MAX_PATH_CHARS) return notFound;
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    const { client, policy } = who;
    try {
      await this.#memoryReady();
      const found = this.#memory.current(path, { reader: policy });
      const text = this.#visible(path);
      if (found === null || text === null) return notFound;
      if (!isWritable(client.name, path)) return { ok: false, reason: "scope_not_allowed" };
      const decision = decideWrite(client, rule, this.#previous(found, client, policy));
      if (!decision.ok) return { ok: false, reason: decision.reason };
      const expected = this.#versionProblem(version);
      if (expected.problem !== null) {
        return { ok: false, reason: "invalid", problems: [expected.problem] };
      }
      const before = parseNote(path, text);
      if (
        before === null ||
        !(await this.#synced(text, found)) ||
        expected.version !== (await noteVersion(text))
      ) {
        return { ok: false, reason: "changed" };
      }
      const memory = { ...buildMemory(archivedInput(before), before, decision), archived: true };
      const written = (await writeMemory(memory, { at: new Date().toISOString(), existing: text }))
        .text;
      if (this.#visible(path) !== text) return { ok: false, reason: "changed" };
      return await this.#queueNote(client.name, path, written, "Arquiva uma nota");
    } catch (error) {
      if (error instanceof MemoryFormatError) {
        return { ok: false, reason: "invalid", problems: [...error.problems] };
      }
      console.error("Vault: archiving a note failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
  }

  /** As notas que esperam o «sim» do dono e que o cliente pode ver, as mais recentes primeiro. */
  async pending(name: string): Promise<PendingResult> {
    const who = this.#who(name);
    if (who === null) return { ok: false, reason: "unauthorized" };
    if (this.#backend() === null) return { ok: false, reason: "vault_off" };
    try {
      await this.#memoryReady();
      const versions = this.#memory
        .pending({ reader: who.policy, limit: PENDING_LIMIT })
        .map((hit) => this.#memory.versionOf(hit.path, hit.commit))
        .filter((version): version is IndexedVersion => version !== null);
      return {
        ok: true,
        text: renderHits(
          versions.map((version) => ({
            path: version.path,
            title: version.title,
            abstract: version.abstract,
            start: bodyWithoutHeading(version.title, version.body).slice(0, 400),
            kind: version.kind,
            scope: version.scope,
            validFrom: version.validFrom,
            invalidAt: version.invalidAt,
            current: true,
            provenance: provenanceLine(this.#memory, version, who.policy),
            version: null,
          })),
        ),
        notes: versions.map((version) => ({
          path: version.path,
          title: version.title,
          client: version.origin?.client ?? null,
          source: version.origin?.source ?? null,
        })),
      };
    } catch (error) {
      console.error("Vault: listing pending notes failed", errorName(error));
      return { ok: false, reason: "unavailable" };
    }
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
        // O índice também precisa saber, para não tomar a versão pela do dono (ADR-0001 §2).
        this.#memory.markAuthored(
          this.#exec<{ blob_sha: string }>("SELECT blob_sha FROM files WHERE path = ?", path).map(
            (row) => row.blob_sha,
          ),
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
        // E o índice o registra, para não tomar a versão pela do dono (ADR-0001 §2).
        this.#memory.markAuthored(
          shas.filter((sha): sha is string => sha !== undefined && sha !== ""),
        );
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
