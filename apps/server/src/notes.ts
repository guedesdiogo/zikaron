// O que as operações de memória do cofre recebem e respondem (#126 do Kelpie, sem os modelos), e as
// peças puras com que o escritor monta uma nova versão. O cofre aplica as regras do ADR-0001; aqui
// ficam os formatos e as contas que não leem o cofre.
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

/** O que o pedido diz de uma gravação: o canal vem da rota; o resto, do corpo do pedido. */
export interface NoteClaim {
  channel: Channel;
  source: Source;
  /** O id da mensagem do dono, ou a referência da fonte. */
  evidence?: string;
  /** `cron` quando quem grava é uma rotina agendada, que nunca grava. */
  context?: string;
}

/**
 * Uma memória como um cliente a manda gravar: o `MemoryWriteInput` do Kelpie, sem `level` (o
 * servidor o decide pela origem) e sem `pinned` (nenhum agente fixa uma nota), mais `status` e
 * `link` (#6). Campos em null contam como ausentes.
 */
export interface MemoryWriteInput {
  title: string;
  /** Markdown, sem o cabeçalho do título. */
  body: string;
  kind: string;
  /** 0 a 1; 0,8 quando ausente. */
  confidence?: number | null;
  /** `global` quando ausente: `global`, `agent/<o próprio>`, `area/*` ou `project/*`. */
  scope?: string | null;
  entities?: string[] | null;
  validFrom?: string | null;
  invalidAt?: string | null;
  abstract?: string | null;
  /** Uma nota encontrada: a memória vira a nova versão dela. */
  path?: string | null;
  /** Obrigatória com `path`: a versão que a leitura ou a busca mostrou (#297 do Kelpie). */
  version?: string | null;
  /** Só numa `task` ou `delegation`. */
  status?: string | null;
  /** Obrigatório num `document`. */
  link?: string | null;
  /** Recusado: o `pinned` só vem do cofre. */
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

/** Uma nota que a busca achou, a melhor primeiro. */
export interface NoteHit {
  path: string;
  title: string;
  abstract: string | null;
  kind: string;
  scope: string;
  validFrom: number | null;
  invalidAt: number | null;
  archived: boolean;
  /** A linha de proveniência do ADR-0001 §6. */
  origin: string;
  /** A versão que uma gravação devolve, ou null quando uma gravação ainda espera o commit. */
  version: string | null;
}

/** Uma nota que espera o «sim» do dono. */
export interface PendingNote {
  path: string;
  title: string;
  client: string | null;
  source: Source | null;
}

/** Recusas que não dependem da nota. */
type Failure = { ok: false; reason: "unauthorized" | "vault_off" | "unavailable" };
type Invalid = { ok: false; reason: "invalid"; problems: string[] };

export type SearchResult = { ok: true; text: string; notes: NoteHit[] } | Failure | Invalid;

export type ReadResult =
  | { ok: true; path: string; text: string; nextOffset: number | null; version: string }
  | { ok: false; reason: "not_found" }
  | Failure;

export type PendingResult = { ok: true; text: string; notes: PendingNote[] } | Failure;

/** O que uma gravação ou um arquivamento respondem. */
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
        | "not_found"
        | "changed"
        | "scope_not_allowed"
        | "owners_note"
        | "core_note"
        | "not_own";
    };

/** Recall (#110): a pergunta lida, o orçamento padrão e o teto. */
export const MAX_QUESTION_CHARS = 2_000;
export const RECALL_TOKENS = 1_000;
export const MAX_RECALL_TOKENS = 8_000;
export const RECALL_LIMIT = 10;
/** O núcleo (#112): o orçamento padrão e o teto. */
export const CORE_TOKENS = 1_000;
export const MAX_CORE_TOKENS = 4_000;
/** A busca do agente (#126): poucas notas, como o `session_search` do Hermes. */
export const SEARCH_K = 3;
export const MAX_SEARCH_K = 10;
/** As pendentes que uma lista mostra, as mais recentes primeiro. */
export const PENDING_LIMIT = 100;
/** Uma memória gravada sem confiança. */
export const DEFAULT_CONFIDENCE = 0.8;
/** O nome de uma nota nova ganha número até isto quando o caminho do título está tomado. */
export const MAX_PATH_NUMBER = 50;
export const MAX_PATH_CHARS = 300;
/** Uma evidência maior que isto é recusada antes de ser cortada a uma linha. */
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 100;

/** Um orçamento de tokens: o padrão quando ausente, inteiro, entre 0 e o teto. */
export function budgetOf(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(Math.floor(Number(value)) || 0, 0), max);
}

/** Os problemas de um claim que chega pelo RPC; nenhum quando ele vale. */
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

/** O claim como a regra de gravação o lê, a evidência já sem segredos. */
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

/** Duas versões de uma nota que só diferem no `updated` do frontmatter. */
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

/** Uma nota que já diz esta memória: o título, o corpo e a validade. */
export function saysTheSame(note: Note, memory: MemoryInput): boolean {
  return (
    foldKey(words(note.title)) === foldKey(words(memory.title)) &&
    words(bodyWithoutHeading(note.title, note.body)) === words(memory.body) &&
    instant(note.validFrom) === instant(memory.validFrom) &&
    instant(note.invalidAt) === instant(memory.invalidAt)
  );
}

/** O que o escritor aceita como uma linha: imprimível, sem marcas bidirecionais. */
function writable(value: string, max: number): boolean {
  return (
    value.trim() !== "" && value.length <= max && !/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(value)
  );
}

/** Um campo em null conta como ausente: um modelo costuma mandar null no que deixa de fora. */
export const given = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value;

const clean = (text: unknown) => (typeof text === "string" ? sanitizeSecrets(text).text : text);

/**
 * A memória como vai ser gravada: o que o cliente deu, sem segredos, e, de uma nota encontrada, o
 * que ela tem e o cliente deixou de fora, como o escritor consegue regravar: o id e as chaves do dono
 * (pelo `writeMemory`), tier, confiança, fontes, entidades, validade, resumo, os `contradicts`, o
 * pin e o evergreen, e `status` e `link` (#6). O `level` e a `origin` vêm da regra de gravação.
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

/** A memória que arquiva uma nota: ela inteira, com `archived: true`. */
export function archivedInput(before: Note): MemoryWriteInput {
  return {
    title: before.title,
    body: bodyWithoutHeading(before.title, before.body),
    kind: before.kind,
  };
}

/** Onde um cliente cria uma nota nova (ADR-0001 §1): global, a própria pasta, áreas e projetos. */
export function mayCreateIn(client: string, scope: string): boolean {
  return (
    scope === "global" ||
    scope === `agent/${client}` ||
    scope.startsWith("area/") ||
    scope.startsWith("project/")
  );
}
