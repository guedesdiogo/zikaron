// Memory's lifecycle (#111): what a daily look at the index finds, written as one report page.
// The retention score follows ai-memory's decay (crates/ai-memory-store/src/decay.rs at
// akitaonrails/ai-memory `b8e839f`, MIT, © 2026 Fabio Akita): it decides what to report, never how
// notes rank.
import type { MemoryIndex } from "./memory-index.ts";
import { instantOf, isDate } from "./time.ts";

/** Where the report lives: a `memory/_` folder, which memory never indexes (`placeOf`). */
export const LIFECYCLE_REPORT_PATH = "memory/_lint/report.md";
/** Dream's page while it runs dry (#112): what it would write, as that spans lines. */
export const DREAM_PAGE_PATH = "memory/_lint/dream.md";

/** ai-memory's defaults: a 35-day half-life for age, recalls that wear off over about 25 days. */
const AGE_DECAY = 0.02;
const RECALL_WEIGHT = 0.6;
const RECALL_DECAY = 0.04;
/** Below this retention, a session or an event is cold. */
const COLD_BELOW = 0.2;
const DAY = 86_400_000;
/** The contradiction band reads this many notes at most: the latest semantic and procedural ones. */
const BAND_NOTES = 60;
/** And reports this many pairs at most. */
const BAND_PAIRS = 25;
/** Each list in the report shows this many entries at most, and each entry this many notes. */
const REPORT_ENTRIES = 200;
/** Each list on Dream's page: its texts are longer than the report's lines. */
const DREAM_PAGE_ENTRIES = 50;
const GROUP_NOTES = 10;
/** A link's title and path are cut to these many characters. */
const TITLE_CHARS = 120;
const PATH_CHARS = 200;
/** The writer's limit for an abstract. */
const ABSTRACT_CHARS = 300;

/**
 * The cosine band in which two notes about one entity may contradict each other, per embedding
 * model: close, but not the same note. A model without a band has the check off.
 *
 * Measured on #108's vault (`eval:models`, #111): pairs that disagree (a question's answer against
 * the memories that would answer it wrongly, and each fact's consecutive versions, 16 pairs)
 * against other pairs of notes sharing an entity (54). Unlike ai-memory's [0.4, 0.75), these
 * updates sit high: [0.70, 0.95) caught 56% of them with bge-m3, flagging 6% of the other pairs,
 * and 63% with OpenAI's model, flagging 13%. Above 0.95 a pair is close to a duplicate.
 */
export const CONTRADICTION_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  "@cf/baai/bge-m3": [0.7, 0.95],
  "text-embedding-3-small": [0.7, 0.95],
};

export interface NoteRef {
  path: string;
  title: string;
}

export interface LifecycleFindings {
  /** Sessions and events nobody recalls any more, with when they were written and how often read. */
  cold: (NoteRef & { writtenAt: number; recalled: number })[];
  /** The same content at several paths, or the same title on several notes of one scope. */
  duplicates: { kind: "content" | "title"; notes: NoteRef[] }[];
  /** Pairs of notes about one entity, close enough to be about the same thing, not the same. */
  contradictions: { notes: [NoteRef, NoteRef]; entity: string }[];
  /** The owner's notes Kelpie changed lately (#160): each one's latest change, newest first. */
  changed: (NoteRef & { changedAt: number; removed: boolean })[];
  /**
   * Dream's abstracts (#112), by path: those it would give each note, and, `written`, those it wrote
   * lately.
   */
  dream: (NoteRef & { abstract: string; written?: boolean })[];
}

export interface LifecycleOptions {
  now: number;
  /** How often each path was packed for a turn, and when last (the Context Store's `recall_counts`). */
  uses: ReadonlyMap<string, { count: number; lastAt: number }>;
  /** The embedding model whose vectors the index holds. */
  model?: string;
  bands?: Readonly<Record<string, readonly [number, number]>>;
  /** When Kelpie changed a note it hadn't written (the Context Store's record), in the window shown. */
  changed?: readonly { path: string; at: number; removed?: boolean }[];
  /** Dream's proposals (the Context Store's), each for the note's current version, and its writes. */
  dream?: readonly { path: string; abstract: string; written?: boolean }[];
}

type LifecycleNote = ReturnType<MemoryIndex["lifecycleNotes"]>[number] & { writtenAt: number };

/**
 * When a note was written: Kelpie's `updated`, else the date its file name starts with (a session's,
 * an event's), else when the index first saw it. The index's time alone would make a vault synced
 * for the first time, or rebuilt, look new.
 */
export function writtenAt(note: ReturnType<MemoryIndex["lifecycleNotes"]>[number]): number {
  const updated = typeof note.updated === "string" ? instantOf(note.updated) : null;
  // Kelpie writes `updated` before it commits, so a later one can't be right.
  if (updated !== null) return Math.min(updated, note.recordedAt);
  const dated = /^(\d{4}-\d{2}-\d{2})(?=[-_ .])/.exec(
    note.path.slice(note.path.lastIndexOf("/") + 1),
  )?.[1];
  return dated !== undefined && isDate(dated)
    ? (instantOf(dated) ?? note.recordedAt)
    : note.recordedAt;
}

/** What a daily look at the index finds. It reads only; nothing changes. */
export function lifecycleFindings(
  index: MemoryIndex,
  options: LifecycleOptions,
): LifecycleFindings {
  const notes: LifecycleNote[] = index
    .lifecycleNotes()
    .map((note) => ({ ...note, writtenAt: writtenAt(note) }));
  const byPath = (a: NoteRef, b: NoteRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const cold = notes
    .filter((note) => note.tier === "episodic" && !note.pinned && !note.evergreen)
    .flatMap((note) => {
      const use = options.uses.get(note.path);
      // An event ages from its own date, so one that is still ahead isn't cold.
      const from =
        note.kind === "event"
          ? (note.invalidAt ?? note.validFrom ?? note.writtenAt)
          : note.writtenAt;
      const age = Math.max(0, (options.now - from) / DAY);
      const sinceRead = use ? Math.max(0, (options.now - use.lastAt) / DAY) : 0;
      const retention =
        Math.exp(-AGE_DECAY * age) +
        (use ? RECALL_WEIGHT * Math.log(1 + use.count) * Math.exp(-RECALL_DECAY * sinceRead) : 0);
      return retention < COLD_BELOW
        ? [
            {
              path: note.path,
              title: note.title,
              writtenAt: note.writtenAt,
              recalled: use?.count ?? 0,
            },
          ]
        : [];
    })
    .sort(byPath);

  const groups = (key: (note: (typeof notes)[number]) => string) => {
    const by = new Map<string, NoteRef[]>();
    for (const note of notes) {
      const list = by.get(key(note)) ?? [];
      list.push({ path: note.path, title: note.title });
      by.set(key(note), list);
    }
    return [...by.values()].filter((list) => list.length > 1).map((list) => list.sort(byPath));
  };
  const sameContent = groups((note) => note.blobSha);
  const listed = new Set(sameContent.map((list) => list.map((note) => note.path).join("\n")));
  // Within a scope: projects' READMEs share a title, and that is no duplicate.
  const sameTitle = groups((note) => `${note.scope}\n${note.titleKey}`).filter(
    (list) => !listed.has(list.map((note) => note.path).join("\n")),
  );
  const firstPath = (a: { notes: NoteRef[] }, b: { notes: NoteRef[] }) =>
    byPath(a.notes[0] as NoteRef, b.notes[0] as NoteRef);
  const duplicates = [
    ...sameContent.map((list) => ({ kind: "content" as const, notes: list })),
    ...sameTitle.map((list) => ({ kind: "title" as const, notes: list })),
  ].sort((a, b) => (a.kind === b.kind ? firstPath(a, b) : a.kind === "content" ? -1 : 1));

  const latest = new Map<string, { at: number; removed: boolean }>();
  for (const { path, at, removed } of options.changed ?? []) {
    if (at >= (latest.get(path)?.at ?? -Infinity)) latest.set(path, { at, removed: !!removed });
  }
  // Newest first, so a long list keeps the latest changes.
  const changed = [...latest]
    .map(([path, { at, removed }]) => ({
      path,
      title:
        index.current(path)?.title ?? path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      changedAt: at,
      removed,
    }))
    .sort((a, b) => b.changedAt - a.changedAt || byPath(a, b));

  const dream = (options.dream ?? [])
    .flatMap(({ path, abstract, written }) => {
      const current = index.current(path);
      return current === null
        ? []
        : [{ path, title: current.title, abstract, ...(written ? { written } : {}) }];
    })
    .sort(byPath);

  return {
    cold,
    duplicates,
    contradictions: contradictions(index, notes, options),
    changed,
    dream,
  };
}

/**
 * Pairs of notes about one entity inside the model's band. An expired note is history, not a
 * contradiction, and a pair a `contradicts` link already joins has been seen to.
 */
function contradictions(
  index: MemoryIndex,
  notes: readonly LifecycleNote[],
  options: LifecycleOptions,
): LifecycleFindings["contradictions"] {
  const bands = options.bands ?? CONTRADICTION_BANDS;
  if (options.model === undefined || !Object.hasOwn(bands, options.model)) return [];
  const [low, high] = bands[options.model] as readonly [number, number];
  const candidates = notes
    .filter(
      (note) =>
        note.tier !== "episodic" && (note.invalidAt === null || note.invalidAt > options.now),
    )
    .sort((a, b) => b.writtenAt - a.writtenAt || (a.path < b.path ? -1 : 1))
    .slice(0, BAND_NOTES)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const joined = new Set(
    candidates.flatMap((note) =>
      index
        .links(note.path)
        .filter((link) => link.kind === "contradicts" && link.path !== null)
        .flatMap((link) => [`${note.path}\n${link.path}`, `${link.path}\n${note.path}`]),
    ),
  );
  const vectors = index.vectorsOf(
    options.model,
    candidates.map((note) => note.blobSha),
  );
  const entities = index.entitiesOf(candidates.map((note) => note.path));
  const found: LifecycleFindings["contradictions"] = [];
  for (let i = 0; i < candidates.length && found.length < BAND_PAIRS; i += 1) {
    const a = candidates[i] as (typeof candidates)[number];
    const va = vectors.get(a.blobSha);
    const ea = entities.get(a.path);
    if (va === undefined || ea === undefined) continue;
    for (let j = i + 1; j < candidates.length && found.length < BAND_PAIRS; j += 1) {
      const b = candidates[j] as (typeof candidates)[number];
      const vb = vectors.get(b.blobSha);
      const shared = [...ea].find(([key]) => entities.get(b.path)?.has(key));
      if (vb === undefined || shared === undefined || a.blobSha === b.blobSha) continue;
      if (joined.has(`${a.path}\n${b.path}`)) continue;
      const similarity = cosine(va, vb);
      if (similarity >= low && similarity < high) {
        found.push({
          notes: [
            { path: a.path, title: a.title },
            { path: b.path, title: b.title },
          ],
          entity: shared[1],
        });
      }
    }
  }
  return found;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : Number.NaN;
}

/**
 * What a title or an entity may not hold: controls, invisible and bidirectional characters, and
 * what Markdown, Obsidian or HTML read as syntax there (links, embeds, code, escapes, comments).
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}[\]|<>!`\\%]/u;
/**
 * What a link's path may not hold. `!` is no embed there, and some file names have one; `#` and `^`
 * would aim at a heading or a block.
 */
const UNSAFE_PATH = /[\p{Cc}\p{Cf}[\]|<>`\\%#^]/u;
/** In a code span, only a backtick or a line break could end it. */
const UNSAFE_CODE = /[\p{Cc}\p{Cf}`]/u;
/** Invisible, but they hold emoji and some scripts together. */
const JOINERS = new Set(["\u200c", "\u200d"]);

/** Text from a note, safe inside a link or a code span, cut to `max` characters. */
function plain(text: string, max: number, unsafe: RegExp = UNSAFE_TEXT): string {
  const safe = text.replace(new RegExp(unsafe.source, "gu"), (char) =>
    JOINERS.has(char) ? char : " ",
  );
  return Array.from(safe.replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();
}

/** A wikilink to a note, from the vault's root, that a title or a path can't break out of. */
function link(note: NoteRef): string {
  const target = note.path.replace(/\.md$/, "");
  // A path no link can name, or too long to show whole, is shown as code: nothing in it is syntax.
  if (UNSAFE_PATH.test(target) || Array.from(target).length > PATH_CHARS) {
    return `\`${plain(note.path, PATH_CHARS, UNSAFE_CODE)}\``;
  }
  return `[[${target}|${plain(note.title, TITLE_CHARS) || target}]]`;
}

/** A group's notes as links, the first GROUP_NOTES of them. */
function links(notes: readonly NoteRef[]): string {
  const shown = notes.slice(0, GROUP_NOTES).map(link).join(", ");
  return notes.length > GROUP_NOTES ? `${shown}, and ${notes.length - GROUP_NOTES} more` : shown;
}

function capped(lines: string[]): string[] {
  return lines.length <= REPORT_ENTRIES
    ? lines
    : [...lines.slice(0, REPORT_ENTRIES), `- …and ${lines.length - REPORT_ENTRIES} more.`];
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * The findings as one Markdown page, or null when there is nothing to report. The same findings
 * give the same page, so a day without news changes nothing in the vault.
 */
export function lifecycleReport(findings: LifecycleFindings): string | null {
  const sections: string[] = [];
  if (findings.changed.length > 0) {
    sections.push(
      [
        "## Your notes Kelpie changed",
        "",
        "Notes whose version Kelpie hadn't written, such as yours, that it changed in the last week. Newest first, with the last day it changed each. Git keeps every earlier version.",
        "",
        ...capped(
          findings.changed.map((note) =>
            note.removed
              ? `- \`${plain(note.path, PATH_CHARS, UNSAFE_CODE)}\`: removed ${day(note.changedAt)}`
              : `- ${link(note)}: changed ${day(note.changedAt)}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (findings.cold.length > 0) {
    sections.push(
      [
        "## Cold notes",
        "",
        "Sessions and events nobody has recalled in a while. They stay where they are; Dream, or you, may fold them away.",
        "",
        ...capped(
          findings.cold.map(
            (note) =>
              `- ${link(note)}: written ${day(note.writtenAt)}, recalled ${note.recalled === 1 ? "once" : `${note.recalled} times`}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (findings.duplicates.length > 0) {
    sections.push(
      [
        "## Duplicates",
        "",
        ...capped(
          findings.duplicates.map(
            (group) =>
              `- ${group.kind === "content" ? "The same content" : "The same title"}: ${links(group.notes)}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (findings.contradictions.length > 0) {
    sections.push(
      [
        "## Possible contradictions",
        "",
        "Notes about the same entity that say similar but not the same things. Dream looks at them.",
        "",
        ...capped(
          findings.contradictions.map(
            (pair) =>
              `- ${link(pair.notes[0])} and ${link(pair.notes[1])}, both about \`${plain(pair.entity, TITLE_CHARS) || "?"}\``,
          ),
        ),
      ].join("\n"),
    );
  }
  // A model wrote the abstracts: as code, no link, tag or markup in them renders.
  const abstracts = (notes: typeof findings.dream) =>
    capped(
      notes.map(
        (note) => `- ${link(note)}: \`${plain(note.abstract, ABSTRACT_CHARS, UNSAFE_CODE)}\``,
      ),
    );
  const planned = findings.dream.filter((note) => !note.written);
  const written = findings.dream.filter((note) => note.written);
  if (planned.length > 0) {
    sections.push(
      [
        "## Dream's plan",
        "",
        "The abstract Dream proposes for each note, shown as code. Nothing was written.",
        "",
        ...abstracts(planned),
      ].join("\n"),
    );
  }
  if (written.length > 0) {
    sections.push(
      [
        "## Dream wrote",
        "",
        "The abstracts Dream wrote in the last week, shown as code. Git keeps every earlier version.",
        "",
        ...abstracts(written),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return null;
  return `# Memory report\n\nKelpie writes this page every day from memory's index. Nothing listed under cold notes, duplicates or possible contradictions was changed. It goes away when every list is empty.\n\n${sections.join("\n\n")}\n`;
}

/** A day summary Dream proposes (#112): the day, its scope, the pages it sums up, and the text. */
export interface DreamSummary {
  date: string;
  scope: string;
  sources: readonly NoteRef[];
  summary: string;
}

/**
 * A merge Dream proposes (#112): the note that stays, the notes marked as merged into it, and its
 * new body, or null when they hold the same content and only the marks change.
 */
export interface DreamMerge {
  survivor: NoteRef;
  merged: readonly NoteRef[];
  body: string | null;
}

/** What a list on Dream's page leaves out. */
const more = (count: number) =>
  count > DREAM_PAGE_ENTRIES ? [`…and ${count - DREAM_PAGE_ENTRIES} more.`] : [];

/** Text a model wrote, as code: fenced by more backticks than it holds in a row, so it can't close. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * What Dream would write while it runs dry, as one page, or null when there is nothing in it: the day
 * summaries, newest day first, each naming the session pages it sums up; then the merges, by the
 * survivor's path. What a model wrote is shown as code, so nothing in it renders.
 */
export function dreamPage(plan: {
  summaries: readonly DreamSummary[];
  merges: readonly DreamMerge[];
}): string | null {
  const parts: string[] = [];
  if (plan.summaries.length > 0) {
    const sorted = [...plan.summaries].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.scope < b.scope ? -1 : 1,
    );
    parts.push(
      [
        "## Day summaries",
        ...sorted
          .slice(0, DREAM_PAGE_ENTRIES)
          .map((entry) =>
            [
              `### ${plain(entry.date, 10)} · ${plain(entry.scope, PATH_CHARS, UNSAFE_PATH)}`,
              "",
              `Sums up: ${links([...entry.sources])}`,
              "",
              code(entry.summary),
            ].join("\n"),
          ),
        ...more(sorted.length),
      ].join("\n\n"),
    );
  }
  if (plan.merges.length > 0) {
    const sorted = [...plan.merges].sort((a, b) => (a.survivor.path < b.survivor.path ? -1 : 1));
    parts.push(
      [
        "## Merges",
        ...sorted
          .slice(0, DREAM_PAGE_ENTRIES)
          .map((entry) =>
            [
              `### ${plain(entry.survivor.title, TITLE_CHARS) || plain(entry.survivor.path, PATH_CHARS, UNSAFE_PATH)}`,
              "",
              `Keeps ${link(entry.survivor)}, and marks ${links([...entry.merged])} as merged into it.`,
              "",
              entry.body === null ? "The same content: only the marks change." : code(entry.body),
            ].join("\n"),
          ),
        ...more(sorted.length),
      ].join("\n\n"),
    );
  }
  if (parts.length === 0) return null;
  return `# What Dream would write\n\nA dry run: what Dream would write, shown as code. Nothing was written.\n\n${parts.join("\n\n")}\n`;
}
