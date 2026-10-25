// What the vault's memory operations take and answer (Kelpie's #126, without the models), and the
// pure pieces the writer builds a new version from. The vault applies ADR-0001's rules; here live
// the formats and the computations that don't read the vault.
import {
  bodyWithoutHeading,
  CHANNELS,
  type Channel,
  foldKey,
  instantOf,
  type Kind,
  type MemoryInput,
  type Note,
  type Scope,
  SOURCES,
  type Source,
  type Status,
  sanitizeSecrets,
} from "@zikaron/memory";
import type { WriteClaim } from "./rules.ts";

/** What a request says about a write: the channel comes from the route; the rest, from the body. */
export interface NoteClaim {
  channel: Channel;
  source: Source;
  /** The owner's message id, or the source's reference. */
  evidence?: string;
  /** `cron` when the writer is a scheduled routine, which never writes. */
  context?: string;
}

/**
 * A memory as a client sends it to be written: Kelpie's `MemoryWriteInput`, without `level` (the
 * server decides it from the origin) and without `pinned` (no agent pins a note), plus `status` and
 * `link` (#6). Null fields count as absent.
 */
export interface MemoryWriteInput {
  title: string;
  /** Markdown, without the title heading. */
  body: string;
  kind: string;
  /** 0 to 1; 0.8 when absent. */
  confidence?: number | null;
  /** `global` when absent: `global`, `agent/<its own>`, `area/*` or `project/*`. */
  scope?: string | null;
  entities?: string[] | null;
  validFrom?: string | null;
  invalidAt?: string | null;
  abstract?: string | null;
  /** A found note: the memory becomes its new version. */
  path?: string | null;
  /** Required with `path`: the version the read or the search showed (Kelpie's #297). */
  version?: string | null;
  /** Only on a `task` or `delegation`. */
  status?: string | null;
  /** Required on a `document`. */
  link?: string | null;
  /** Refused: `pinned` only comes from the vault. */
  pinned?: unknown;
}

export interface CoreResult {
  text: string;
  tokens: number;
  paths: string[];
  omitted: number;
}

export interface RecallResult {
  text: string;
  tokens: number;
  paths: string[];
}

/** A note the search found, the best first. */
export interface NoteHit {
  path: string;
  title: string;
  abstract: string | null;
  kind: string;
  scope: string;
  validFrom: number | null;
  invalidAt: number | null;
  archived: boolean;
  /** The provenance line of ADR-0001 §6. */
  origin: string;
  /** The version a write returns, or null when a write still waits for its commit. */
  version: string | null;
}

/** A note that waits for the owner's "yes". */
export interface PendingNote {
  path: string;
  title: string;
  client: string | null;
  source: Source | null;
}

/** Refusals that don't depend on the note. */
type Failure = { ok: false; reason: "unauthorized" | "vault_off" | "unavailable" };
type Invalid = { ok: false; reason: "invalid"; problems: string[] };

export type SearchResult = { ok: true; text: string; notes: NoteHit[] } | Failure | Invalid;

export type ReadResult =
  | { ok: true; path: string; text: string; nextOffset: number | null; version: string }
  | { ok: false; reason: "not_found" }
  | Failure;

export type PendingResult = { ok: true; text: string; notes: PendingNote[] } | Failure;

/** What a write or an archive answers. */
export type WriteNoteResult =
  | { ok: true; action: "written" | "unchanged"; path: string; version: string }
  | Invalid
  | Failure
  | {
      ok: false;
      reason:
        | "not_found"
        | "changed"
        | "scope_not_allowed"
        | "too_large"
        | "cron"
        | "pinned"
        | "owners_note"
        | "core_note"
        | "archived";
    };

export type ForgetNoteResult =
  | { ok: true; path: string }
  | Failure
  | {
      ok: false;
      reason:
        | "cron"
        | "not_found"
        | "changed"
        | "scope_not_allowed"
        | "owners_note"
        | "core_note"
        | "not_own";
    };

/** Recall (#110): the question read, the default budget and the ceiling. */
export const MAX_QUESTION_CHARS = 2_000;
export const RECALL_TOKENS = 1_000;
export const MAX_RECALL_TOKENS = 8_000;
export const RECALL_LIMIT = 10;
/** The core (#112): the default budget and the ceiling. */
export const CORE_TOKENS = 1_000;
export const MAX_CORE_TOKENS = 4_000;
/** The agent's search (#126): few notes, like Hermes's `session_search`. */
export const SEARCH_K = 3;
export const MAX_SEARCH_K = 10;
/** The pending notes a list shows, most recent first. */
export const PENDING_LIMIT = 100;
/** A memory written without a confidence. */
export const DEFAULT_CONFIDENCE = 0.8;
/** A new note's name gets a number up to this when the title's path is taken. */
export const MAX_PATH_NUMBER = 50;
export const MAX_PATH_CHARS = 300;
/** Evidence longer than this is refused before being cut to one line. */
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 100;

/** A token budget: the default when absent, an integer, between 0 and the ceiling. */
export function budgetOf(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Math.floor(Number(value)) || 0, 0), max);
}

/** The problems of a claim that arrives over RPC; none when it is valid. */
export function claimProblems(claim: unknown): string[] {
  if (typeof claim !== "object" || claim === null) return ["the claim isn't valid"];
  const { channel, source, evidence, context } = claim as Record<string, unknown>;
  const problems: string[] = [];
  if (!CHANNELS.includes(channel as Channel)) problems.push("`channel` is invalid");
  if (!SOURCES.includes(source as Source))
    problems.push("`source` must be owner, agent or external");
  if (
    evidence !== undefined &&
    evidence !== null &&
    (typeof evidence !== "string" || evidence.length > MAX_EVIDENCE_CHARS)
  ) {
    problems.push(`\`evidence\` must be text of up to ${MAX_EVIDENCE_CHARS} characters`);
  }
  if (
    context !== undefined &&
    context !== null &&
    (typeof context !== "string" || context.length > MAX_CONTEXT_CHARS)
  ) {
    problems.push(`\`context\` must be text of up to ${MAX_CONTEXT_CHARS} characters`);
  }
  return problems;
}

/** The claim as the write rule reads it, the evidence already stripped of secrets. */
export function writeClaim(claim: NoteClaim, pinned: boolean): WriteClaim {
  const evidence =
    typeof claim.evidence === "string" ? sanitizeSecrets(claim.evidence).text : undefined;
  return {
    channel: claim.channel,
    source: claim.source,
    ...(evidence === undefined ? {} : { evidence }),
    ...(typeof claim.context === "string" ? { context: claim.context } : {}),
    ...(pinned ? { pinned: true } : {}),
  };
}

/** Two versions of a note that differ only in the frontmatter's `updated`. */
export function sameVersion(a: string, b: string): boolean {
  const unstamped = (text: string) => {
    const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
    return end === -1
      ? text
      : `${text.slice(0, end).replace(/\nupdated: [^\n]*/, "")}${text.slice(end)}`;
  };
  return unstamped(a) === unstamped(b);
}

const words = (text: string) => text.trim().split(/\s+/u).join(" ");
const instant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : instantOf(value);

/** A note that already says this memory: the title, the body and the validity. */
export function saysTheSame(note: Note, memory: MemoryInput): boolean {
  return (
    foldKey(words(note.title)) === foldKey(words(memory.title)) &&
    words(bodyWithoutHeading(note.title, note.body)) === words(memory.body) &&
    instant(note.validFrom) === instant(memory.validFrom) &&
    instant(note.invalidAt) === instant(memory.invalidAt)
  );
}

/** What the writer accepts as one line: printable, without bidirectional marks. */
function writable(value: string, max: number): boolean {
  return (
    value.trim() !== "" && value.length <= max && !/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)
  );
}

/** A null field counts as absent: a model often sends null for what it leaves out. */
export const given = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value;

const clean = (text: unknown) => (typeof text === "string" ? sanitizeSecrets(text).text : text);

/**
 * The memory as it will be written: what the client gave, without secrets, and, from a found note,
 * what it has and the client left out, as far as the writer can rewrite it: the id and the owner's
 * keys (through `writeMemory`), tier, confidence, sources, entities, validity, summary, the
 * `contradicts`, the pin and the evergreen, and `status` and `link` (#6). The `level` and the
 * `origin` come from the write rule.
 */
export function buildMemory(
  input: MemoryWriteInput,
  before: Note | null,
  decided: Pick<MemoryInput, "level" | "origin">,
): MemoryInput {
  const contradicts =
    (before?.frontmatter.relations as { contradicts?: unknown } | undefined)?.contradicts ?? [];
  const targets = (Array.isArray(contradicts) ? contradicts : [])
    .map((link) =>
      typeof link === "string" ? /^\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() : undefined,
    )
    .filter((name): name is string => !!name && writable(name, 200));
  const sources = (before?.sources ?? []).filter((one) => writable(one, 300));
  const entitiesGiven = given(input.entities);
  const entities =
    entitiesGiven === undefined
      ? before?.entities.map((entity) => entity.name)
      : (entitiesGiven as unknown[]).map((entity) => clean(entity) as string);
  const abstract =
    given(input.abstract) === undefined
      ? before?.abstract && writable(before.abstract, 300)
        ? before.abstract
        : undefined
      : clean(input.abstract);
  const validFrom = given(input.validFrom) ?? before?.validFrom ?? undefined;
  const invalidAt = given(input.invalidAt) ?? before?.invalidAt ?? undefined;
  const status = given(input.status) ?? before?.status ?? undefined;
  const link = given(input.link) ?? before?.link ?? undefined;
  return {
    scope: (before?.scope ?? given(input.scope) ?? "global") as Scope,
    kind: input.kind as Kind,
    title: clean(input.title) as string,
    body: clean(input.body) as string,
    level: decided.level,
    confidence: given(input.confidence) ?? before?.confidence ?? DEFAULT_CONFIDENCE,
    ...(before === null ? {} : { tier: before.tier }),
    ...(sources.length > 0 ? { sources } : {}),
    ...(entities?.length ? { entities } : {}),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(invalidAt === undefined ? {} : { invalidAt }),
    ...(abstract ? { abstract: abstract as string } : {}),
    ...(targets.length > 0 ? { contradicts: targets } : {}),
    ...(before?.pinned ? { pinned: true } : {}),
    ...(before?.evergreen ? { evergreen: true } : {}),
    ...(status === undefined ? {} : { status: status as Status }),
    ...(link === undefined ? {} : { link }),
    ...(decided.origin === undefined ? {} : { origin: decided.origin }),
  };
}

/** The memory that archives a note: the whole note, with `archived: true`. */
export function archivedInput(before: Note): MemoryWriteInput {
  return {
    title: before.title,
    body: bodyWithoutHeading(before.title, before.body),
    kind: before.kind,
  };
}

/** Where a client creates a new note (ADR-0001 §1): global, its own folder, areas and projects. */
export function mayCreateIn(client: string, scope: string): boolean {
  return (
    scope === "global" ||
    scope === `agent/${client}` ||
    scope.startsWith("area/") ||
    scope.startsWith("project/")
  );
}
