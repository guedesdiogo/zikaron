import { Document, isMap, parseDocument } from "yaml";
import { MAX_ENTITIES, normalizeEntities } from "./entities.ts";
import { shortSha256 } from "./hash.ts";
import { defaultTier, isScope, KINDS, type Kind, type Scope, TIERS, type Tier } from "./layout.ts";
import { splitFrontmatter } from "./markdown.ts";
import { isMemoryId, LEVELS, type Level, MAX_FRONTMATTER_LENGTH, MAX_SOURCES } from "./note.ts";
import { instantOf, isDateTime } from "./time.ts";

/** A memory as Kelpie writes it. Every field is checked: Kelpie's own writes are strict. */
export interface MemoryInput {
  scope: Scope;
  kind: Kind;
  title: string;
  /** Markdown, without the title heading. */
  body: string;
  level: Level;
  /** 0 to 1. */
  confidence: number;
  /** Defaults to the kind's tier; written either way. */
  tier?: Tier;
  /** Where it came from: `"[[2026-10-06-family-chat]]"`, or any reference such as a message id. */
  sources?: string[];
  entities?: string[];
  validFrom?: string;
  invalidAt?: string;
  evergreen?: boolean;
  pinned?: boolean;
  /** One line. */
  abstract?: string;
  /** Notes this one contradicts, by name or vault path, written as wikilinks. */
  contradicts?: string[];
}

export class MemoryFormatError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid memory: ${problems.join("; ")}`);
    this.name = "MemoryFormatError";
    this.problems = problems;
  }
}

/**
 * One line of text: no control characters, line breaks included, no line or paragraph separators,
 * which a YAML 1.1 reader takes as breaks, and no bidirectional overrides, which can make a title
 * read differently from what it holds. Emoji and their joiners are fine.
 */
export const printableLine = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= max &&
  !/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(value);

const dateOf = (value: unknown) => (typeof value === "string" ? instantOf(value) : null);

function check(input: MemoryInput, at: string): string[] {
  const problems: string[] = [];
  if (!isScope(input.scope)) problems.push("`scope` is invalid");
  if (!KINDS.includes(input.kind)) problems.push("`kind` is invalid");
  if (!printableLine(input.title, 200))
    problems.push("`title` must be one line of 1-200 characters");
  if (typeof input.body !== "string" || input.body.trim() === "") problems.push("`body` is empty");
  if (!LEVELS.includes(input.level)) problems.push("`level` is invalid");
  if (typeof input.confidence !== "number" || !(input.confidence >= 0 && input.confidence <= 1)) {
    problems.push("`confidence` must be 0-1");
  }
  if (input.tier !== undefined && !TIERS.includes(input.tier)) problems.push("`tier` is invalid");
  const sources = input.sources ?? [];
  if (
    !Array.isArray(sources) ||
    sources.length > MAX_SOURCES ||
    !sources.every((source) => printableLine(source, 300))
  ) {
    problems.push(`\`sources\` must be up to ${MAX_SOURCES} lines of 1-300 characters`);
  }
  const entities = input.entities ?? [];
  if (
    !Array.isArray(entities) ||
    !entities.every((entity) => typeof entity === "string") ||
    normalizeEntities(entities).length !== entities.length ||
    entities.length > MAX_ENTITIES
  ) {
    problems.push(`\`entities\` must be up to ${MAX_ENTITIES} distinct names of 1-64 characters`);
  }
  const from = input.validFrom === undefined ? undefined : dateOf(input.validFrom);
  const to = input.invalidAt === undefined ? undefined : dateOf(input.invalidAt);
  if (from === null) problems.push("`validFrom` must be a date or a date-time with an offset");
  if (to === null) problems.push("`invalidAt` must be a date or a date-time with an offset");
  if (typeof from === "number" && typeof to === "number" && to <= from) {
    problems.push("`invalidAt` must be after `validFrom`");
  }
  if (input.abstract !== undefined && !printableLine(input.abstract, 300)) {
    problems.push("`abstract` must be one line of 1-300 characters");
  }
  const contradicts = input.contradicts ?? [];
  if (
    !Array.isArray(contradicts) ||
    !contradicts.every((target) => printableLine(target, 200) && !/[[\]|#]/.test(target))
  ) {
    problems.push("`contradicts` must name notes, without brackets");
  }
  if (
    ![input.evergreen, input.pinned].every(
      (flag) => flag === undefined || typeof flag === "boolean",
    )
  ) {
    problems.push("`evergreen` and `pinned` must be true or false");
  }
  if (typeof at !== "string" || !isDateTime(at) || !at.endsWith("Z")) {
    problems.push("`at` must be a UTC date-time");
  }
  return problems;
}

export interface WriteOptions {
  /** When this version is written, as a UTC date-time; the package reads no clock. */
  at: string;
  /** The file's current text, when this version supersedes it. */
  existing?: string;
}

export interface WrittenMemory {
  id: string;
  /** The whole file: it holds this version only, and git keeps the earlier ones. */
  text: string;
}

/**
 * Renders a memory file. A new memory gets an `id` minted from its content, so writing the same
 * memory twice yields the same file.
 *
 * A superseding version keeps the existing file's `id`, and the keys and comments Kelpie doesn't
 * manage, in their places. The input is the whole new version: a managed field it leaves out is
 * removed, and the body is replaced. A caller that keeps a field, such as a `pinned` the owner set,
 * reads the existing note first. An existing frontmatter that can't be read is refused rather than
 * dropped with the owner's keys.
 */
export async function writeMemory(
  input: MemoryInput,
  options: WriteOptions,
): Promise<WrittenMemory> {
  const problems = check(input, options.at);
  if (problems.length > 0) throw new MemoryFormatError(problems);

  const title = input.title.trim();
  const body = input.body.trim();
  const existingYaml =
    options.existing === undefined ? null : splitFrontmatter(options.existing).yaml;
  let doc = new Document({});
  if (existingYaml !== null && existingYaml.trim() !== "") {
    // The reader's limits apply: past them, or with aliases, the reader would ignore the result.
    doc =
      existingYaml.length > MAX_FRONTMATTER_LENGTH
        ? new Document([])
        : parseDocument(existingYaml, { uniqueKeys: true });
    if (doc.errors.length > 0 || !isMap(doc.contents) || hasAliases(doc)) {
      throw new MemoryFormatError([
        "the existing file's frontmatter can't be read; fix it before writing a new version",
      ]);
    }
  }
  const existingId = doc.get("id");
  const id = isMemoryId(existingId)
    ? existingId
    : await shortSha256(`${input.scope}\n${input.kind}\n${title}\n${body}`);

  const fields: [string, unknown][] = [
    ["id", id],
    ["kind", input.kind],
    ["scope", input.scope],
    ["tier", input.tier ?? defaultTier(input.kind)],
    ["level", input.level],
    ["confidence", input.confidence],
    ["sources", input.sources?.length ? input.sources : undefined],
    ["entities", input.entities?.length ? input.entities.map((name) => name.trim()) : undefined],
    ["valid_from", input.validFrom],
    ["invalid_at", input.invalidAt],
    ["evergreen", input.evergreen || undefined],
    ["pinned", input.pinned || undefined],
    ["abstract", input.abstract?.trim()],
    [
      "relations",
      input.contradicts?.length
        ? { contradicts: input.contradicts.map((target) => `[[${target.trim()}]]`) }
        : undefined,
    ],
    ["updated", options.at],
  ];
  for (const [key, value] of fields) {
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }
  // A `title` key would win over the heading, so it follows the new title.
  if (doc.has("title")) doc.set("title", title);

  return {
    id,
    text: `---\n${doc.toString({ lineWidth: 0, flowCollectionPadding: false })}---\n\n# ${title}\n\n${body}\n`,
  };
}

function hasAliases(doc: Document): boolean {
  try {
    doc.toJS({ maxAliasCount: 0 });
    return false;
  } catch {
    return true;
  }
}
