// Where memory lives in the vault (ADR-0016's layout, extended by ADR-0020). The path decides a
// note's scope and, under a kind folder, its kind; docs/memory-format.md is the written spec.
import { isDate } from "./time.ts";

export const KINDS = [
  "preference",
  "commitment",
  "event",
  "person",
  "place",
  "decision",
  "procedure",
  "note",
  "session",
] as const;
export type Kind = (typeof KINDS)[number];

/** Each kind's folder: plural, so a folder of people reads `people/ana-souza.md`. */
export const KIND_FOLDERS: Record<Kind, string> = {
  preference: "preferences",
  commitment: "commitments",
  event: "events",
  person: "people",
  place: "places",
  decision: "decisions",
  procedure: "procedures",
  note: "notes",
  session: "sessions",
};

const KIND_BY_FOLDER = new Map<string, Kind>(
  Object.entries(KIND_FOLDERS).map(([kind, folder]) => [folder, kind as Kind]),
);

/** How long a memory is expected to stay relevant; decay (#111) reads it. */
export const TIERS = ["episodic", "semantic", "procedural"] as const;
export type Tier = (typeof TIERS)[number];

export function defaultTier(kind: Kind): Tier {
  if (kind === "session" || kind === "event") return "episodic";
  if (kind === "procedure") return "procedural";
  return "semantic";
}

export const SCOPE_TYPES = ["global", "agent", "area", "project", "conversation"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** `global`, or a scope type and a name: `agent/kelpie`, `area/work`, `conversation/family`. */
export type Scope = "global" | `${Exclude<ScopeType, "global">}/${string}`;

/**
 * A segment that names an agent, area, project or conversation in a path: any folder name the owner
 * might use, but no slash, backslash, control or bidirectional character, and no leading or
 * trailing dot or space.
 */
const SCOPE_NAME = /^(?![.\s])[^/\\\p{Cc}\p{Cf}]{1,80}(?<![.\s])$/u;

export function isScope(value: unknown): value is Scope {
  if (value === "global") return true;
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  const type = value.slice(0, slash);
  return (
    slash > 0 &&
    type !== "global" &&
    (SCOPE_TYPES as readonly string[]).includes(type) &&
    SCOPE_NAME.test(value.slice(slash + 1))
  );
}

/** The folder a scope's notes live under. */
export function scopeRoot(scope: Scope): string {
  if (scope === "global") return "memory";
  const [type, name] = scope.split("/") as [ScopeType, string];
  switch (type) {
    case "agent":
      return `agents/${name}/memory`;
    case "area":
      return `areas/${name}`;
    case "project":
      return `projects/${name}`;
    default:
      return `conversations/${name}`;
  }
}

export interface PathPlace {
  scope: Scope;
  /** The kind its folder names, or null for a note outside a kind folder. */
  kind: Kind | null;
}

/**
 * Where a vault path sits, or null when the memory index doesn't cover it: persona, rules, skills,
 * root files, hidden folders (`.obsidian/`, `.trash/`) and anything that isn't Markdown.
 */
export function placeOf(path: string): PathPlace | null {
  if (!path.endsWith(".md")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;
  if (isReservedPath(path)) return null;
  const [top, second, third] = segments;
  let scope: Scope;
  let rest: string[];
  if (top === "memory" || top === "knowledge") {
    scope = "global";
    rest = segments.slice(1);
  } else if (top === "agents" && third === "memory") {
    scope = `agent/${second}`;
    rest = segments.slice(3);
  } else if (top === "areas" || top === "projects" || top === "conversations") {
    const type = top === "areas" ? "area" : top === "projects" ? "project" : "conversation";
    scope = `${type}/${second}`;
    rest = segments.slice(2);
  } else {
    return null;
  }
  if (rest.length === 0 || !isScope(scope)) return null;
  // `knowledge/` holds the owner's free-form notes (ADR-0016): its folders are the owner's own.
  const kind =
    top !== "knowledge" && rest.length > 1 ? (KIND_BY_FOLDER.get(rest[0] ?? "") ?? null) : null;
  return { scope, kind };
}

/**
 * Whether a path is in a `memory/_…/` folder, which holds Kelpie's own files, such as the lifecycle
 * report: never notes, and never an agent's to write. A file directly under `memory/` is a note.
 */
export function isReservedPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length > 2 && segments[0] === "memory" && (segments[1] ?? "").startsWith("_");
}

/** A readable file name: lowercase ASCII, diacritics folded, words joined by hyphens. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug === "" ? "untitled" : slug;
}

/**
 * The path Kelpie gives a new memory. A dated memory (a session, an event) goes under its year with
 * the date first, so a folder lists in order. The caller resolves a collision with an existing file.
 */
export function memoryPath(scope: Scope, kind: Kind, title: string, date?: string): string {
  if (!isScope(scope)) throw new RangeError(`not a scope: ${scope}`);
  if (!KINDS.includes(kind)) throw new RangeError(`not a kind: ${kind}`);
  const folder = `${scopeRoot(scope)}/${KIND_FOLDERS[kind]}`;
  if (date === undefined) return `${folder}/${slugify(title)}.md`;
  if (!isDate(date)) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  return `${folder}/${date.slice(0, 4)}/${date}-${slugify(title)}.md`;
}
