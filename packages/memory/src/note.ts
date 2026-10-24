import { parseDocument } from "yaml";
import { type Entity, normalizeEntities } from "./entities.ts";
import {
  defaultTier,
  isScope,
  KINDS,
  type Kind,
  placeOf,
  type Scope,
  TIERS,
  type Tier,
} from "./layout.ts";
import {
  deriveTitle,
  extractLinks,
  type NoteLink,
  splitFrontmatter,
  valueLinks,
} from "./markdown.ts";
import { instantOf, isDateTime } from "./time.ts";

/** How a memory was reached: said by the owner, deduced from what was said, or guessed. */
export const LEVELS = ["explicit", "deduced", "inferred"] as const;
export type Level = (typeof LEVELS)[number];

/** Larger frontmatter is ignored: it is a note's metadata, not its content. */
export const MAX_FRONTMATTER_LENGTH = 16_384;
export const MAX_SOURCES = 20;
const MAX_SOURCE_LENGTH = 300;
const MAX_ABSTRACT_LENGTH = 300;
/** What one note may cost the index: a larger body is indexed in part, and extra links dropped. */
export const MAX_BODY_LENGTH = 262_144;
export const MAX_LINKS = 500;
/** Keys that would stand in for an object's prototype when a caller copies the frontmatter. */
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];

const MEMORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID.test(value);
}

/** A vault Markdown file as the memory index reads it. */
export interface Note {
  path: string;
  /** From the path, always. */
  scope: Scope;
  /** From the kind folder, then the frontmatter, then `note`. */
  kind: Kind;
  tier: Tier;
  title: string;
  /** Minted once from the first version's content; stays the same across versions. */
  id: string | null;
  level: Level | null;
  confidence: number | null;
  sources: string[];
  entities: Entity[];
  /** World time: when the fact starts and stops being true. ISO dates or date-times. */
  validFrom: string | null;
  invalidAt: string | null;
  /** Exempt from decay. */
  evergreen: boolean;
  /** Always loaded into the agent's core context, and exempt from decay. */
  pinned: boolean;
  abstract: string | null;
  updated: string | null;
  /** Every key, unknown ones included, as parsed. */
  frontmatter: Record<string, unknown>;
  body: string;
  links: NoteLink[];
  /** What was ignored or overridden, for lint. A note is never dropped for a bad value. */
  warnings: string[];
}

type Frontmatter = Record<string, unknown>;

function parseFrontmatter(yaml: string | null, warnings: string[]): Frontmatter {
  if (yaml === null) return {};
  if (yaml.length > MAX_FRONTMATTER_LENGTH) {
    warnings.push(`frontmatter is longer than ${MAX_FRONTMATTER_LENGTH} characters; ignored`);
    return {};
  }
  const doc = parseDocument(yaml, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    warnings.push("frontmatter isn't valid YAML; ignored");
    return {};
  }
  let value: unknown;
  try {
    // Aliases are refused outright: they are how a small YAML document expands into a huge one.
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    warnings.push("frontmatter uses YAML aliases; ignored");
    return {};
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push("frontmatter isn't a map of keys; ignored");
    return {};
  }
  const frontmatter = value as Frontmatter;
  if (RESERVED_KEYS.some((key) => Object.hasOwn(frontmatter, key))) {
    for (const key of RESERVED_KEYS) delete frontmatter[key];
    warnings.push("`__proto__`, `constructor` and `prototype` are reserved; ignored");
  }
  return frontmatter;
}

/** Reads one field: missing is null, invalid is null plus a warning. */
function field<T>(
  frontmatter: Frontmatter,
  key: string,
  warnings: string[],
  read: (value: unknown) => T | null,
): T | null {
  const value = frontmatter[key];
  if (value === undefined || value === null) return null;
  const parsed = read(value);
  if (parsed === null) warnings.push(`\`${key}\` is invalid; ignored`);
  return parsed;
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): T | null =>
    values.includes(value as T) ? (value as T) : null;

const dateString = (value: unknown): string | null =>
  typeof value === "string" && instantOf(value) !== null ? value : null;

const stringList =
  (maxItems: number, maxLength: number) =>
  (value: unknown): string[] | null =>
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (item) => typeof item === "string" && item.trim() !== "" && item.length <= maxLength,
    )
      ? (value as string[])
      : null;

/** Reads a vault file into a note; null when the path is outside the memory index. */
export function readNote(path: string, text: string): Note | null {
  const place = placeOf(path);
  if (place === null) return null;
  const warnings: string[] = [];
  const split = splitFrontmatter(text);
  let body = split.body;
  const yaml = split.yaml;
  const frontmatter = parseFrontmatter(yaml, warnings);
  if (body.length > MAX_BODY_LENGTH) {
    body = body.slice(0, MAX_BODY_LENGTH);
    warnings.push("the body is longer than 262,144 characters; only its start is indexed");
  }

  const declaredKind = field(frontmatter, "kind", warnings, oneOf(KINDS));
  if (place.kind !== null && declaredKind !== null && declaredKind !== place.kind) {
    warnings.push(
      `\`kind\` says ${declaredKind} but the folder says ${place.kind}; the folder wins`,
    );
  }
  const kind = place.kind ?? declaredKind ?? "note";
  const declaredScope = field(frontmatter, "scope", warnings, (value) =>
    isScope(value) ? value : null,
  );
  if (declaredScope !== null && declaredScope !== place.scope) {
    warnings.push(
      `\`scope\` says ${declaredScope} but the path says ${place.scope}; the path wins`,
    );
  }

  const validFrom = field(frontmatter, "valid_from", warnings, dateString);
  let invalidAt = field(frontmatter, "invalid_at", warnings, dateString);
  if (
    validFrom !== null &&
    invalidAt !== null &&
    (instantOf(invalidAt) ?? 0) <= (instantOf(validFrom) ?? 0)
  ) {
    warnings.push("`invalid_at` isn't after `valid_from`; ignored");
    invalidAt = null;
  }
  // A bad name drops that name, not the list.
  const rawEntities =
    field(frontmatter, "entities", warnings, (value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").slice(0, 100)
        : null,
    ) ?? [];
  const entities = normalizeEntities(rawEntities);
  if (entities.length < rawEntities.length) {
    warnings.push("some `entities` were duplicates, invalid or over the limit; dropped");
  }
  const sources = field(
    frontmatter,
    "sources",
    warnings,
    stringList(MAX_SOURCES, MAX_SOURCE_LENGTH),
  );
  // A closed vocabulary: what a note contradicts, and where a merged note went (#112).
  const relations = field(frontmatter, "relations", warnings, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "contradicts" && key !== "merged_into")) return null;
    const list = stringList(MAX_SOURCES, MAX_SOURCE_LENGTH);
    const contradicts = list((value as Frontmatter).contradicts ?? []);
    const mergedInto = list((value as Frontmatter).merged_into ?? []);
    return contradicts === null || mergedInto === null ? null : { contradicts, mergedInto };
  });

  // The frontmatter's links first: the cap below must never drop where a merged note went.
  let links: NoteLink[] = [];
  for (const survivor of relations?.mergedInto ?? []) {
    for (const target of valueLinks(survivor, path)) links.push({ kind: "merged_into", ...target });
  }
  if (links.some((link) => link.kind === "merged_into" && link.by === "name")) {
    warnings.push(
      "`relations.merged_into` names a note by name: name it by its path, or it merges nothing",
    );
  }
  for (const contradicted of relations?.contradicts ?? []) {
    for (const target of valueLinks(contradicted, path))
      links.push({ kind: "contradicts", ...target });
  }
  for (const source of sources ?? []) {
    for (const target of valueLinks(source, path)) links.push({ kind: "source", ...target });
  }
  links.push(...extractLinks(body, path));
  if (links.length > MAX_LINKS) {
    links = links.slice(0, MAX_LINKS);
    warnings.push(`more than ${MAX_LINKS} links; the rest are not indexed`);
  }

  const flag = (key: string) =>
    field(frontmatter, key, warnings, (value) => (typeof value === "boolean" ? value : null)) ??
    false;

  return {
    path,
    scope: place.scope,
    kind,
    tier: field(frontmatter, "tier", warnings, oneOf(TIERS)) ?? defaultTier(kind),
    title: deriveTitle(frontmatter.title, body, path),
    id: field(frontmatter, "id", warnings, (value) => (isMemoryId(value) ? value : null)),
    level: field(frontmatter, "level", warnings, oneOf(LEVELS)),
    confidence: field(frontmatter, "confidence", warnings, (value) =>
      typeof value === "number" && value >= 0 && value <= 1 ? value : null,
    ),
    sources: sources ?? [],
    entities,
    validFrom,
    invalidAt,
    evergreen: flag("evergreen"),
    pinned: flag("pinned"),
    abstract: field(frontmatter, "abstract", warnings, (value) =>
      typeof value === "string" &&
      value.trim() !== "" &&
      value.length <= MAX_ABSTRACT_LENGTH &&
      !value.includes("\n")
        ? value.trim()
        : null,
    ),
    updated: field(frontmatter, "updated", warnings, (value) =>
      typeof value === "string" && isDateTime(value) ? value : null,
    ),
    frontmatter,
    body,
    links,
    warnings,
  };
}
