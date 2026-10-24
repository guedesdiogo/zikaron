// The memory index: derived from the vault, and rebuilt from it at any time (ADR-0020 §2). The
// schema follows ai-memory's at fc4da03 (versioned pages, external-content FTS5, entities, links),
// with every row derived from commits so a rebuild reproduces it exactly.
import { foldKey } from "./entities.ts";
import { gitBlobSha } from "./hash.ts";
import type { Kind, Scope, Tier } from "./layout.ts";
import type { LinkBy, LinkKind } from "./markdown.ts";
import { type Level, readNote } from "./note.ts";
import { instantOf } from "./time.ts";

export type SqlValue = ArrayBuffer | string | number | null;

/** The part of a SQLite Durable Object's storage the index uses; `ctx.storage` satisfies it. */
export interface IndexStorage {
  sql: {
    /** A cursor: read whole, or row by row so a large result isn't held at once. */
    exec<T extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): { toArray(): T[] } & Iterable<T>;
  };
  transactionSync<T>(closure: () => T): T;
}

/** One file a commit added, changed (`content`) or removed (`content: null`). */
export interface VaultChange {
  path: string;
  content: string | null;
  /**
   * Git's blob SHA, when the caller has it, as GitHub's trees give it. Otherwise it is computed
   * from `content`, which matches git only if the text was decoded without dropping a BOM.
   */
  blobSha?: string;
}

export interface VaultCommit {
  sha: string;
  /** Committer time, in epoch milliseconds. */
  committedAt: number;
  changes: readonly VaultChange[];
}

/** One version of a note, current or superseded. */
export interface IndexedVersion {
  path: string;
  /** The commit that wrote this version. */
  commit: string;
  blobSha: string;
  /** The commit of the version it replaced at the same path. */
  supersedes: string | null;
  current: boolean;
  /**
   * Ingestion time: when the vault started and stopped holding this version. These are commit
   * times, kept moving forward: a commit is recorded at least a millisecond after the one before.
   */
  recordedAt: number;
  replacedAt: number | null;
  /** The commit that replaced or removed it. */
  replacedBy: string | null;
  id: string | null;
  scope: Scope;
  kind: Kind;
  tier: Tier;
  level: Level | null;
  confidence: number | null;
  evergreen: boolean;
  pinned: boolean;
  /** World time, in epoch milliseconds. */
  validFrom: number | null;
  invalidAt: number | null;
  title: string;
  abstract: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  warnings: string[];
}

export interface ApplyResult {
  /** False when the commit had already been applied. */
  applied: boolean;
  /** Paths that got a new version. */
  written: string[];
  /** Paths whose current version was removed. */
  removed: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Only memories in these scopes; all of them when left out. */
  scopes?: readonly Scope[];
  /** Ingestion time: search the versions the vault held then, instead of the current ones. */
  asOf?: number;
  /** World time: keep only memories valid at this instant. */
  validAt?: number;
  /**
   * World time now: leave out memories whose `invalid_at` has passed (#111). A memory without one
   * never expires, and one that becomes valid later stays.
   */
  notExpiredAt?: number;
}

export interface SearchHit {
  path: string;
  commit: string;
  title: string;
  abstract: string | null;
  current: boolean;
  kind: Kind;
  tier: Tier;
  pinned: boolean;
}

export interface ResolvedLink {
  kind: LinkKind;
  by: LinkBy;
  target: string;
  /** The current note it points at, or null when nothing in the vault matches. */
  path: string | null;
}

/** Every derived row, ordered, without SQLite's row ids: two equal dumps are the same index. */
export interface IndexDump {
  commits: { sha: string; seq: number; committedAt: number; recordedAt: number }[];
  versions: IndexedVersion[];
  entities: { path: string; commit: string; key: string; name: string }[];
  links: { path: string; commit: string; kind: string; by: string; target: string }[];
}

export const SCHEMA_VERSION = 3;

const DERIVED_SCHEMA = `
CREATE TABLE commits (
  sha TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE versions (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_seq INTEGER NOT NULL,
  blob_sha TEXT NOT NULL,
  supersedes_commit TEXT,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  recorded_at INTEGER NOT NULL,
  replaced_at INTEGER,
  replaced_by_commit TEXT,
  memory_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  level TEXT,
  confidence REAL,
  evergreen INTEGER NOT NULL,
  pinned INTEGER NOT NULL,
  valid_from INTEGER,
  invalid_at INTEGER,
  title TEXT NOT NULL,
  abstract TEXT,
  body TEXT NOT NULL,
  path_search TEXT NOT NULL,
  link_path TEXT NOT NULL,
  link_name TEXT NOT NULL,
  title_key TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  warnings TEXT NOT NULL,
  UNIQUE (path, commit_sha)
);
CREATE UNIQUE INDEX versions_current_path ON versions (path) WHERE is_current = 1;
CREATE INDEX versions_path_seq ON versions (path, commit_seq);
CREATE INDEX versions_link_path ON versions (link_path) WHERE is_current = 1;
CREATE INDEX versions_link_name ON versions (link_name) WHERE is_current = 1;
CREATE INDEX versions_title_key ON versions (title_key) WHERE is_current = 1;
CREATE INDEX versions_memory_id ON versions (memory_id) WHERE memory_id IS NOT NULL;
CREATE VIRTUAL TABLE versions_fts USING fts5(
  title, abstract, body, path_search,
  content = 'versions', content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER versions_fts_ai AFTER INSERT ON versions BEGIN
  INSERT INTO versions_fts (rowid, title, abstract, body, path_search)
    VALUES (new.rowid, new.title, new.abstract, new.body, new.path_search);
END;
CREATE TRIGGER versions_fts_ad AFTER DELETE ON versions BEGIN
  INSERT INTO versions_fts (versions_fts, rowid, title, abstract, body, path_search)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.body, old.path_search);
END;
CREATE TRIGGER versions_fts_au AFTER UPDATE OF title, abstract, body, path_search ON versions BEGIN
  INSERT INTO versions_fts (versions_fts, rowid, title, abstract, body, path_search)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.body, old.path_search);
  INSERT INTO versions_fts (rowid, title, abstract, body, path_search)
    VALUES (new.rowid, new.title, new.abstract, new.body, new.path_search);
END;
CREATE TABLE entities (
  version INTEGER NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (version, key)
) WITHOUT ROWID;
CREATE INDEX entities_key ON entities (key);
CREATE TABLE links (
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'embed', 'source', 'contradicts', 'merged_into')),
  by TEXT NOT NULL CHECK (by IN ('path', 'name')),
  target TEXT NOT NULL,
  PRIMARY KEY (version, kind, by, target)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (by, target);
`;

const DERIVED_OBJECTS = [
  "TRIGGER IF EXISTS versions_fts_ai",
  "TRIGGER IF EXISTS versions_fts_ad",
  "TRIGGER IF EXISTS versions_fts_au",
  "TABLE IF EXISTS versions_fts",
  "TABLE IF EXISTS links",
  "TABLE IF EXISTS entities",
  "TABLE IF EXISTS versions",
  "TABLE IF EXISTS commits",
];

// Embeddings are keyed by content and model, so they stay valid across a rebuild and are kept as a
// cache: computing them costs a model call. Retrieval (#110) fills and reads them.
const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeddings (
  blob_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  vector BLOB NOT NULL,
  PRIMARY KEY (blob_sha, model)
) WITHOUT ROWID;
`;

/** The path's words for full-text search, without `.md`: the tokenizer splits `-` and `_`. */
function pathSearch(path: string): string {
  return path.slice(0, -3).replaceAll("/", " ");
}

function linkKeys(path: string): { linkPath: string; linkName: string } {
  const linkPath = path.slice(0, -3).normalize("NFC").toLowerCase();
  return { linkPath, linkName: linkPath.slice(linkPath.lastIndexOf("/") + 1) };
}

/** A title as entity keys are: whitespace collapsed, lowercase, diacritics folded. */
function titleKey(title: string): string {
  return foldKey(title.trim().split(/\s+/u).join(" "));
}

/** At most this many entity keys are looked up at once. */
const MAX_KEYS = 64;
/**
 * A name on more of the versions a lookup sees than this singles nothing out: its notes would all
 * weigh the same and come in path order. It is left out of that lookup, as a function word is left
 * out of names.
 */
const MAX_ENTITY_VERSIONS = 50;

/** 1 to 100 results, 10 when the limit isn't a number. */
function limitOf(options: { limit?: number }): number {
  const limit = Math.trunc(options.limit ?? 10);
  return Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
}

/**
 * Where a version's merge mark leads (#112): another current note of its own scope, named by its
 * path, as Dream writes it. A name is no mark, since it may resolve to the note itself or to a
 * namesake elsewhere; nor is a path that leads nowhere, to the note itself or to another scope. The
 * mark is read against the vault as it is now, as a link resolves.
 */
const MERGED_INTO = `FROM links m JOIN versions t
  ON t.is_current = 1 AND t.link_path = m.target AND t.path <> v.path AND t.scope = v.scope
  WHERE m.version = v.rowid AND m.kind = 'merged_into' AND m.by = 'path'`;

/** A version that isn't a note merged into another (#112): what went into it is found there. */
const NOT_MERGED = `NOT EXISTS (SELECT 1 ${MERGED_INTO})`;

/**
 * The versions a lookup sees, as SQL over `v`: current ones, or those of `asOf`, valid at
 * `validAt`, in `scopes`, and not merged into another note unless `includeMerged`.
 */
function versionFilter(options: SearchOptions, includeMerged = false): [string, SqlValue[]] {
  const filters: string[] = [];
  const bindings: SqlValue[] = [];
  if (options.scopes !== undefined) {
    const scopes = [...new Set(options.scopes)].slice(0, MAX_KEYS);
    filters.push(scopes.length === 0 ? "0" : `v.scope IN (${scopes.map(() => "?").join(", ")})`);
    bindings.push(...scopes);
  }
  if (options.asOf === undefined) {
    filters.push("v.is_current = 1");
  } else {
    filters.push("v.recorded_at <= ? AND (v.replaced_at IS NULL OR v.replaced_at > ?)");
    bindings.push(options.asOf, options.asOf);
  }
  if (options.validAt !== undefined) {
    filters.push("(v.valid_from IS NULL OR v.valid_from <= ?)");
    filters.push("(v.invalid_at IS NULL OR v.invalid_at > ?)");
    bindings.push(options.validAt, options.validAt);
  }
  if (options.notExpiredAt !== undefined) {
    filters.push("(v.invalid_at IS NULL OR v.invalid_at > ?)");
    bindings.push(options.notExpiredAt);
  }
  if (!includeMerged) filters.push(NOT_MERGED);
  return [filters.join(" AND "), bindings];
}

type HitRow = {
  path: string;
  commit_sha: string;
  title: string;
  abstract: string | null;
  is_current: number;
  kind: string;
  tier: string;
  pinned: number;
};

const HIT_COLUMNS =
  "v.path, v.commit_sha, v.title, v.abstract, v.is_current, v.kind, v.tier, v.pinned";

function toHit(row: HitRow): SearchHit {
  return {
    path: row.path,
    commit: row.commit_sha,
    title: row.title,
    abstract: row.abstract,
    current: row.is_current === 1,
    kind: row.kind as Kind,
    tier: row.tier as Tier,
    pinned: row.pinned === 1,
  };
}

/** Words of a query, each quoted, so no user text is read as FTS5 syntax. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(foldKey(text).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((word) => word.length >= 2)
    .slice(0, 32);
  return words.length === 0 ? null : words.map((word) => `"${word}"`).join(" OR ");
}

type VersionRow = {
  path: string;
  commit_sha: string;
  blob_sha: string;
  supersedes_commit: string | null;
  is_current: number;
  recorded_at: number;
  replaced_at: number | null;
  replaced_by_commit: string | null;
  memory_id: string | null;
  scope: string;
  kind: string;
  tier: string;
  level: string | null;
  confidence: number | null;
  evergreen: number;
  pinned: number;
  valid_from: number | null;
  invalid_at: number | null;
  title: string;
  abstract: string | null;
  body: string;
  frontmatter: string;
  warnings: string;
};

const VERSION_COLUMNS = `v.path, v.commit_sha, v.blob_sha, v.supersedes_commit, v.is_current, v.recorded_at,
  v.replaced_at, v.replaced_by_commit, v.memory_id, v.scope, v.kind, v.tier, v.level, v.confidence,
  v.evergreen, v.pinned, v.valid_from, v.invalid_at, v.title, v.abstract, v.body, v.frontmatter,
  v.warnings`;

function toVersion(row: VersionRow): IndexedVersion {
  return {
    path: row.path,
    commit: row.commit_sha,
    blobSha: row.blob_sha,
    supersedes: row.supersedes_commit,
    current: row.is_current === 1,
    recordedAt: row.recorded_at,
    replacedAt: row.replaced_at,
    replacedBy: row.replaced_by_commit,
    id: row.memory_id,
    scope: row.scope as Scope,
    kind: row.kind as Kind,
    tier: row.tier as Tier,
    level: row.level as Level | null,
    confidence: row.confidence,
    evergreen: row.evergreen === 1,
    pinned: row.pinned === 1,
    validFrom: row.valid_from,
    invalidAt: row.invalid_at,
    title: row.title,
    abstract: row.abstract,
    body: row.body,
    frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
    warnings: JSON.parse(row.warnings) as string[],
  };
}

/**
 * The index over one vault, in a SQLite Durable Object. It applies commits one at a time, in the
 * order they are handed to it, and a rebuild runs alone; one instance per storage keeps that true.
 * An index from another schema version starts empty, and `lastCommit()` then tells the caller to
 * replay the vault from the start.
 */
export class MemoryIndex {
  readonly #storage: IndexStorage;
  /** The tail of the work queue: hashing is asynchronous, so two calls could otherwise interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(storage: IndexStorage) {
    this.#storage = storage;
    this.#storage.transactionSync(() => {
      this.#exec(CACHE_SCHEMA);
      const version = this.#exec<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      )[0]?.value;
      if (version === `${SCHEMA_VERSION}`) return;
      for (const object of DERIVED_OBJECTS) this.#exec(`DROP ${object}`);
      this.#exec(DERIVED_SCHEMA);
      this.#exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
        `${SCHEMA_VERSION}`,
      );
    });
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): T[] {
    return this.#storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** Applies one commit, after any still running. A commit applied before is skipped. */
  applyCommit(commit: VaultCommit): Promise<ApplyResult> {
    return this.#serialize(() => this.#apply(commit));
  }

  async #apply(commit: VaultCommit): Promise<ApplyResult> {
    // Hashing is asynchronous and SQLite work is synchronous, so the hashes come first.
    const changes = await Promise.all(
      [...commit.changes]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(async (change) => ({
          ...change,
          blobSha:
            change.content === null ? null : (change.blobSha ?? (await gitBlobSha(change.content))),
        })),
    );
    return this.#storage.transactionSync(() => {
      const result: ApplyResult = { applied: false, written: [], removed: [] };
      if (this.#exec("SELECT 1 AS one FROM commits WHERE sha = ?", commit.sha).length > 0) {
        return result;
      }
      result.applied = true;
      const last = this.#exec<{ seq: number; recorded_at: number }>(
        "SELECT seq, recorded_at FROM commits ORDER BY seq DESC LIMIT 1",
      )[0];
      const seq = (last?.seq ?? 0) + 1;
      // Committer times can go backwards (a rebase, a skewed clock) or repeat within a
      // millisecond; ingestion windows need them to move forward.
      const recordedAt = Math.max(commit.committedAt, (last?.recorded_at ?? -Infinity) + 1);
      this.#exec(
        "INSERT INTO commits (sha, seq, committed_at, recorded_at) VALUES (?, ?, ?, ?)",
        commit.sha,
        seq,
        commit.committedAt,
        recordedAt,
      );
      for (const change of changes) {
        const current = this.#exec<{ rowid: number; blob_sha: string; commit_sha: string }>(
          "SELECT rowid, blob_sha, commit_sha FROM versions WHERE path = ? AND is_current = 1",
          change.path,
        )[0];
        if (current !== undefined && current.blob_sha === change.blobSha) continue;
        const note = change.content === null ? null : readNote(change.path, change.content);
        // Outside the index: persona, rules, skills, root files, anything but Markdown.
        if (change.content !== null && note === null) continue;
        if (current !== undefined) {
          this.#exec(
            `UPDATE versions SET is_current = 0, replaced_at = ?, replaced_by_commit = ?
             WHERE rowid = ?`,
            recordedAt,
            commit.sha,
            current.rowid,
          );
          if (note === null) result.removed.push(change.path);
        }
        if (note === null || change.blobSha === null) continue;
        // A path removed and written again continues its chain, as ai-memory resurrects a
        // tombstone instead of orphaning it.
        const previous =
          current?.commit_sha ??
          this.#exec<{ commit_sha: string }>(
            "SELECT commit_sha FROM versions WHERE path = ? ORDER BY commit_seq DESC LIMIT 1",
            change.path,
          )[0]?.commit_sha ??
          null;
        const { linkPath, linkName } = linkKeys(change.path);
        const rowid = this.#exec<{ rowid: number }>(
          `INSERT INTO versions (path, commit_sha, commit_seq, blob_sha, supersedes_commit, is_current,
             recorded_at, memory_id, scope, kind, tier, level, confidence, evergreen, pinned,
             valid_from, invalid_at, title, abstract, body, path_search, link_path, link_name,
             title_key, frontmatter, warnings)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING rowid`,
          change.path,
          commit.sha,
          seq,
          change.blobSha,
          previous,
          recordedAt,
          note.id,
          note.scope,
          note.kind,
          note.tier,
          note.level,
          note.confidence,
          note.evergreen ? 1 : 0,
          note.pinned ? 1 : 0,
          note.validFrom === null ? null : instantOf(note.validFrom),
          note.invalidAt === null ? null : instantOf(note.invalidAt),
          note.title,
          note.abstract,
          note.body,
          pathSearch(change.path),
          linkPath,
          linkName,
          titleKey(note.title),
          JSON.stringify(note.frontmatter),
          JSON.stringify(note.warnings),
        )[0]?.rowid;
        if (rowid === undefined) throw new Error("the version insert returned no row id");
        for (const entity of note.entities) {
          this.#exec(
            "INSERT INTO entities (version, key, name) VALUES (?, ?, ?)",
            rowid,
            entity.key,
            entity.name,
          );
        }
        for (const link of note.links) {
          this.#exec(
            "INSERT OR IGNORE INTO links (version, kind, by, target) VALUES (?, ?, ?, ?)",
            rowid,
            link.kind,
            link.by,
            link.target,
          );
        }
        result.written.push(change.path);
      }
      return result;
    });
  }

  /**
   * Drops every derived row and replays the vault's history, oldest commit first. Embeddings of
   * content still in the history are kept: they are keyed by content, so they stay valid.
   */
  rebuild(history: Iterable<VaultCommit> | AsyncIterable<VaultCommit>): Promise<void> {
    return this.#serialize(async () => {
      this.#storage.transactionSync(() => {
        for (const object of DERIVED_OBJECTS) this.#exec(`DROP ${object}`);
        this.#exec(DERIVED_SCHEMA);
      });
      for await (const commit of history) await this.#apply(commit);
      // A vector of content no version holds, such as text erased from git's history, goes too.
      this.#exec("DELETE FROM embeddings WHERE blob_sha NOT IN (SELECT blob_sha FROM versions)");
    });
  }

  /** The last commit applied, which is where the next sync starts. */
  lastCommit(): { sha: string; committedAt: number } | null {
    const row = this.#exec<{ sha: string; committed_at: number }>(
      "SELECT sha, committed_at FROM commits ORDER BY seq DESC LIMIT 1",
    )[0];
    return row === undefined ? null : { sha: row.sha, committedAt: row.committed_at };
  }

  current(path: string): IndexedVersion | null {
    const row = this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.path = ? AND v.is_current = 1`,
      path,
    )[0];
    return row === undefined ? null : toVersion(row);
  }

  /** Every version written at a path, oldest first, the current one last. */
  history(path: string): IndexedVersion[] {
    return this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.path = ? ORDER BY v.commit_seq`,
      path,
    ).map(toVersion);
  }

  /** The version the vault held at a path at an instant (ingestion time), if any. */
  versionAt(path: string, at: number): IndexedVersion | null {
    const row = this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v
       WHERE v.path = ? AND v.recorded_at <= ? AND (v.replaced_at IS NULL OR v.replaced_at > ?)
       ORDER BY v.commit_seq DESC LIMIT 1`,
      path,
      at,
      at,
    )[0];
    return row === undefined ? null : toVersion(row);
  }

  /**
   * Current notes with no vector from `model` yet, once per content: what to embed next. A
   * note's text is its title, abstract and body.
   */
  embeddingTexts(model: string, limit = 256): { blobSha: string; text: string }[] {
    return this.#exec<{ blob_sha: string; title: string; abstract: string | null; body: string }>(
      `SELECT v.blob_sha, v.title, v.abstract, v.body FROM versions v
       WHERE v.is_current = 1 AND ${NOT_MERGED}
         AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.blob_sha = v.blob_sha AND e.model = ?)
       GROUP BY v.blob_sha ORDER BY v.blob_sha LIMIT ?`,
      model,
      Math.min(Math.max(Math.trunc(limit) || 1, 1), 1_000),
    ).map((row) => ({
      blobSha: row.blob_sha,
      text: [row.title, row.abstract, row.body].filter((part) => part).join("\n\n"),
    }));
  }

  /**
   * Keeps vectors by content and model; they survive a rebuild, as embeddings are a cache. A vector
   * for content no version holds is dropped: its note was erased while it was being embedded.
   */
  putEmbeddings(model: string, items: readonly { blobSha: string; vector: readonly number[] }[]) {
    this.#storage.transactionSync(() => {
      for (const { blobSha, vector } of items) {
        if (vector.length === 0) continue;
        this.#exec(
          `INSERT OR REPLACE INTO embeddings (blob_sha, model, dims, vector)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM versions WHERE blob_sha = ?)`,
          blobSha,
          model,
          vector.length,
          new Float32Array(vector).buffer,
          blobSha,
        );
      }
    });
  }

  /**
   * Notes nearest a query vector by cosine similarity, best first, among the versions `options`
   * selects. The vectors are read row by row, so memory stays flat as the vault grows.
   */
  vectorHits(model: string, query: readonly number[], options: SearchOptions = {}): SearchHit[] {
    // A loop, not Math.hypot(...query): a long vector spread into arguments overflows the stack.
    let squaredNorm = 0;
    for (const value of query) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (query.length === 0 || !(norm > 0)) return [];
    const limit = limitOf(options);
    const [filter, bindings] = versionFilter(options);
    const best: { score: number; row: HitRow }[] = [];
    const rows = this.#storage.sql.exec<HitRow & { vector: ArrayBuffer; dims: number }>(
      `SELECT ${HIT_COLUMNS}, e.vector, e.dims
       FROM versions v JOIN embeddings e ON e.blob_sha = v.blob_sha AND e.model = ?
       WHERE ${filter}`,
      model,
      ...bindings,
    );
    for (const row of rows) {
      // A vector of another length, or a blob that isn't whole floats, can't be compared.
      if (row.dims !== query.length || row.vector.byteLength !== query.length * 4) continue;
      const vector = new Float32Array(row.vector);
      let dot = 0;
      let squares = 0;
      for (let i = 0; i < vector.length; i += 1) {
        const value = vector[i] ?? 0;
        dot += value * (query[i] ?? 0);
        squares += value * value;
      }
      const score = squares > 0 ? dot / (Math.sqrt(squares) * norm) : 0;
      if (!Number.isFinite(score)) continue;
      if (best.length === limit && score <= (best.at(-1)?.score ?? -Infinity)) continue;
      const at = best.findIndex((entry) => score > entry.score);
      best.splice(at === -1 ? best.length : at, 0, { score, row });
      if (best.length > limit) best.pop();
    }
    return best.map(({ row }) => toHit(row));
  }

  /** Every current note, with what the lifecycle jobs (#111) score and group them by. */
  lifecycleNotes(): {
    path: string;
    scope: string;
    title: string;
    titleKey: string;
    kind: string;
    tier: string;
    pinned: boolean;
    evergreen: boolean;
    recordedAt: number;
    validFrom: number | null;
    invalidAt: number | null;
    /** The frontmatter's `updated`, as written: Kelpie's last write, when it wrote the note. */
    updated: unknown;
    blobSha: string;
  }[] {
    return this.#exec<{
      path: string;
      scope: string;
      title: string;
      title_key: string;
      kind: string;
      tier: string;
      pinned: number;
      evergreen: number;
      recorded_at: number;
      valid_from: number | null;
      invalid_at: number | null;
      updated: SqlValue;
      blob_sha: string;
    }>(
      `SELECT path, scope, title, title_key, kind, tier, pinned, evergreen, recorded_at, valid_from,
              invalid_at,
              -- Too deep for SQLite's JSON functions: no 'updated', rather than no report.
              CASE WHEN json_valid(frontmatter) THEN json_extract(frontmatter, '$.updated') END AS updated,
              blob_sha
       FROM versions v WHERE is_current = 1 AND ${NOT_MERGED} ORDER BY path`,
    ).map((row) => ({
      path: row.path,
      scope: row.scope,
      title: row.title,
      titleKey: row.title_key,
      kind: row.kind,
      tier: row.tier,
      pinned: row.pinned === 1,
      evergreen: row.evergreen === 1,
      recordedAt: row.recorded_at,
      validFrom: row.valid_from,
      invalidAt: row.invalid_at,
      updated: row.updated,
      blobSha: row.blob_sha,
    }));
  }

  /** The vectors `model` gave these contents, those that are whole floats. */
  vectorsOf(model: string, blobShas: readonly string[]): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>();
    for (const blobSha of new Set(blobShas)) {
      const row = this.#storage.sql
        .exec<{ vector: ArrayBuffer; dims: number }>(
          "SELECT vector, dims FROM embeddings WHERE blob_sha = ? AND model = ?",
          blobSha,
          model,
        )
        .toArray()[0];
      if (row !== undefined && row.vector.byteLength === row.dims * 4) {
        found.set(blobSha, new Float32Array(row.vector));
      }
    }
    return found;
  }

  /** Each current note's entities, by key with their names, for these paths. */
  entitiesOf(paths: readonly string[]): Map<string, Map<string, string>> {
    const found = new Map<string, Map<string, string>>();
    for (const path of new Set(paths)) {
      const rows = this.#exec<{ key: string; name: string }>(
        `SELECT e.key, e.name FROM entities e JOIN versions v ON v.rowid = e.version
         WHERE v.path = ? AND v.is_current = 1 ORDER BY e.key`,
        path,
      );
      if (rows.length > 0) found.set(path, new Map(rows.map((row) => [row.key, row.name])));
    }
    return found;
  }

  /** The paths of every current note, in order. */
  currentPaths(): string[] {
    return this.#exec<{ path: string }>(
      "SELECT path FROM versions WHERE is_current = 1 ORDER BY path",
    ).map((row) => row.path);
  }

  /** One version, by its path and the commit that wrote it. */
  versionOf(path: string, commit: string): IndexedVersion | null {
    const row = this.#exec<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM versions v WHERE v.path = ? AND v.commit_sha = ?`,
      path,
      commit,
    )[0];
    return row === undefined ? null : toVersion(row);
  }

  /**
   * Full-text search, best first. Current versions only, unless `asOf` asks for the past. bm25 takes
   * its statistics from the whole table, other scopes and past versions included, so they can
   * reorder the hits in `scopes`: a residual the owner accepted until someone other than the owner is
   * admitted (#60, #152).
   */
  search(text: string, options: SearchOptions = {}): SearchHit[] {
    const query = ftsQuery(text);
    if (query === null) return [];
    const [filter, bindings] = versionFilter(options);
    return this.#exec<HitRow>(
      `SELECT ${HIT_COLUMNS}
       FROM versions_fts JOIN versions v ON v.rowid = versions_fts.rowid
       WHERE versions_fts MATCH ? AND ${filter}
       ORDER BY bm25(versions_fts, 4.0, 2.0, 1.0, 2.0), v.path
       LIMIT ?`,
      query,
      ...bindings,
      limitOf(options),
    ).map(toHit);
  }

  /** The notes with this title, in path order: titles compare without case, diacritics or extra spaces. */
  titled(title: string, options: SearchOptions = {}): SearchHit[] {
    const [filter, bindings] = versionFilter(options);
    return this.#exec<HitRow>(
      `SELECT ${HIT_COLUMNS} FROM versions v WHERE v.title_key = ? AND ${filter} ORDER BY v.path LIMIT ?`,
      titleKey(title),
      ...bindings,
      limitOf(options),
    ).map(toHit);
  }

  /**
   * The notes that name any of these entity keys, best first. An entity's own page, the note titled
   * with its name, comes before the notes that mention it, and a global page before a scoped one.
   * A name on fewer notes says more, so each key weighs one over the number of notes that name it,
   * as ai-memory weighs its entity stream, and a key on more than `MAX_ENTITY_VERSIONS` is left out.
   * Both count only the versions this lookup sees, so notes in other scopes, and a note's past
   * versions, don't switch a name off. Current versions only, unless `asOf` asks for the past.
   */
  entityHits(keys: readonly string[], options: SearchOptions = {}): SearchHit[] {
    const asked = [...new Set(keys)].slice(0, MAX_KEYS);
    if (asked.length === 0) return [];
    const [filter, bindings] = versionFilter(options);
    // The keys go as one JSON array: 64 keys and 64 scopes as placeholders would pass the 100
    // parameters a Durable Object's SQL statement may bind.
    return this.#exec<HitRow>(
      `WITH named AS (
         SELECT e.version, e.key FROM entities e JOIN versions v ON v.rowid = e.version
         WHERE e.key IN (SELECT value FROM json_each(?)) AND ${filter}
       ),
       pages AS (SELECT key, count(*) AS n FROM named GROUP BY key HAVING count(*) <= ?)
       SELECT ${HIT_COLUMNS}
       FROM named JOIN pages ON pages.key = named.key JOIN versions v ON v.rowid = named.version
       GROUP BY v.rowid
       ORDER BY max(CASE WHEN v.title_key <> named.key THEN 0 WHEN v.scope = 'global' THEN 2 ELSE 1 END) DESC,
         sum(1.0 / pages.n) DESC, v.path
       LIMIT ?`,
      JSON.stringify(asked),
      ...bindings,
      MAX_ENTITY_VERSIONS,
      limitOf(options),
    ).map(toHit);
  }

  /**
   * Current notes one step from this one: the notes it links to, then the pages of the entities it
   * names, notes titled with that name, as if it linked to them, global ones first. With `scopes`,
   * only notes in them, its links resolve among them, and a note outside them has no neighbours.
   */
  neighbours(
    path: string,
    options: {
      limit?: number;
      validAt?: number;
      notExpiredAt?: number;
      scopes?: readonly Scope[];
    } = {},
  ): SearchHit[] {
    const scoped = options.scopes === undefined ? {} : { scopes: options.scopes };
    const [inScopes, scopeBindings] = versionFilter(scoped);
    const exists = this.#exec(
      `SELECT 1 AS one FROM versions v WHERE v.path = ? AND ${inScopes}`,
      path,
      ...scopeBindings,
    ).length;
    if (exists === 0) return [];
    const limit = limitOf(options);
    const [filter, bindings] = versionFilter({
      ...(options.validAt === undefined ? {} : { validAt: options.validAt }),
      ...(options.notExpiredAt === undefined ? {} : { notExpiredAt: options.notExpiredAt }),
      ...scoped,
    });
    const hits: SearchHit[] = [];
    const seen = new Set([path]);
    const take = (other: string | null) => {
      if (other === null || seen.has(other) || hits.length >= limit) return;
      seen.add(other);
      const row = this.#exec<HitRow>(
        `SELECT ${HIT_COLUMNS} FROM versions v WHERE v.path = ? AND ${filter}`,
        other,
        ...bindings,
      )[0];
      if (row !== undefined) {
        hits.push(toHit(row));
        return;
      }
      // A note merged into another (#112) leads to it, one step only. It went into a note of its
      // own scope, so a note outside the scopes leads nowhere the lookup sees.
      const into = this.mergedInto(other);
      if (into === null || seen.has(into)) return;
      seen.add(into);
      const merged = this.#exec<HitRow>(
        `SELECT ${HIT_COLUMNS} FROM versions v WHERE v.path = ? AND ${filter}`,
        into,
        ...bindings,
      )[0];
      if (merged !== undefined) hits.push(toHit(merged));
    };
    // Links are resolved one at a time, so a note with many costs only what is taken. A note it
    // contradicts is what it replaced, not a neighbour.
    const links = this.#exec<{ by: string; target: string }>(
      `SELECT l.by, l.target FROM links l JOIN versions v ON v.rowid = l.version
       WHERE v.path = ? AND v.is_current = 1 AND l.kind <> 'contradicts'
       ORDER BY l.kind, l.by, l.target`,
      path,
    );
    for (const link of links) {
      if (hits.length >= limit) return hits;
      take(this.resolve(path, link.by as LinkBy, link.target, scoped));
    }
    const keys = this.#exec<{ key: string }>(
      `SELECT e.key FROM entities e JOIN versions v ON v.rowid = e.version
       WHERE v.path = ? AND v.is_current = 1`,
      path,
    ).map((row) => row.key);
    if (keys.length === 0) return hits;
    const named = this.#exec<{ path: string }>(
      `SELECT path FROM versions WHERE is_current = 1 AND title_key IN (${keys.map(() => "?").join(", ")})
       ORDER BY scope <> 'global', path`,
      ...keys,
    );
    for (const row of named) take(row.path);
    return hits;
  }

  /**
   * Resolves a link as Obsidian does: a path names one note; a file name is searched vault-wide,
   * preferring the linking note's folder, then the shortest path. With `scopes`, only notes in them
   * are candidates, so a note in another scope can't take the link from one in them.
   */
  resolve(
    from: string,
    by: LinkBy,
    target: string,
    options: { scopes?: readonly Scope[] } = {},
  ): string | null {
    // A link names a file, as in Obsidian, merged into another or not.
    const [filter, bindings] = versionFilter(
      options.scopes === undefined ? {} : { scopes: options.scopes },
      true,
    );
    const candidates = this.#exec<{ path: string }>(
      `SELECT v.path FROM versions v WHERE v.${by === "path" ? "link_path" : "link_name"} = ? AND ${filter}`,
      target,
      ...bindings,
    ).map((row) => row.path);
    if (candidates.length <= 1) return candidates[0] ?? null;
    const folder = from.slice(0, from.lastIndexOf("/") + 1);
    const rank = (path: string) => [
      path.slice(0, path.lastIndexOf("/") + 1) === folder ? 0 : 1,
      path.split("/").length,
      path.length,
    ];
    return (
      candidates.sort((a, b) => {
        const [ra, rb] = [rank(a), rank(b)];
        for (let i = 0; i < ra.length; i += 1) {
          const diff = (ra[i] ?? 0) - (rb[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return a < b ? -1 : 1;
      })[0] ?? null
    );
  }

  /**
   * The note a merged note went into (#112): another current note of its scope, which its mark
   * names by path, or null when no mark of it counts. Exactly the notes lookups leave out have one.
   */
  mergedInto(path: string): string | null {
    return (
      this.#exec<{ path: string | null }>(
        `SELECT (SELECT t.path ${MERGED_INTO} ORDER BY t.path LIMIT 1) AS path
         FROM versions v WHERE v.path = ? AND v.is_current = 1`,
        path,
      )[0]?.path ?? null
    );
  }

  /** The notes merged into this one (#112): those whose mark counts and names it. */
  mergedFrom(path: string): string[] {
    return this.#exec<{ path: string }>(
      `SELECT v.path FROM versions v
       WHERE v.is_current = 1 AND EXISTS (SELECT 1 ${MERGED_INTO} AND t.path = ?)
       ORDER BY v.path`,
      path,
    ).map((row) => row.path);
  }

  /**
   * The current version's links, each resolved against the current vault, or among the notes in
   * `scopes` when given.
   */
  links(path: string, options: { scopes?: readonly Scope[] } = {}): ResolvedLink[] {
    return this.#exec<{ kind: string; by: string; target: string }>(
      `SELECT l.kind, l.by, l.target FROM links l JOIN versions v ON v.rowid = l.version
       WHERE v.path = ? AND v.is_current = 1 ORDER BY l.kind, l.by, l.target`,
      path,
    ).map((row) => ({
      kind: row.kind as LinkKind,
      by: row.by as LinkBy,
      target: row.target,
      path: this.resolve(path, row.by as LinkBy, row.target, options),
    }));
  }

  /** Current notes whose links resolve to this path. */
  backlinks(path: string): string[] {
    const { linkPath, linkName } = linkKeys(path);
    const rows = this.#exec<{ path: string; by: string; target: string }>(
      `SELECT DISTINCT v.path, l.by, l.target FROM links l JOIN versions v ON v.rowid = l.version
       WHERE v.is_current = 1
         AND ((l.by = 'path' AND l.target = ?) OR (l.by = 'name' AND l.target = ?))
       ORDER BY v.path`,
      linkPath,
      linkName,
    );
    const sources = rows
      .filter((row) => this.resolve(row.path, row.by as LinkBy, row.target) === path)
      .map((row) => row.path);
    return [...new Set(sources)];
  }

  dump(): IndexDump {
    return {
      commits: this.#exec<{ sha: string; seq: number; committed_at: number; recorded_at: number }>(
        "SELECT sha, seq, committed_at, recorded_at FROM commits ORDER BY seq",
      ).map((row) => ({
        sha: row.sha,
        seq: row.seq,
        committedAt: row.committed_at,
        recordedAt: row.recorded_at,
      })),
      versions: this.#exec<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM versions v ORDER BY v.path, v.commit_seq`,
      ).map(toVersion),
      entities: this.#exec<{ path: string; commit: string; key: string; name: string }>(
        `SELECT v.path, v.commit_sha AS "commit", e.key, e.name
         FROM entities e JOIN versions v ON v.rowid = e.version
         ORDER BY v.path, v.commit_seq, e.key`,
      ),
      links: this.#exec<{ path: string; commit: string; kind: string; by: string; target: string }>(
        `SELECT v.path, v.commit_sha AS "commit", l.kind, l.by, l.target
         FROM links l JOIN versions v ON v.rowid = l.version
         ORDER BY v.path, v.commit_seq, l.kind, l.by, l.target`,
      ),
    };
  }
}
