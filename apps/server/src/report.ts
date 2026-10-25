// The daily memory report (#17), at `memory/_lint/report.md`, outside the index: what the vault's
// routine finds, written as links to the notes. It follows the rules of Kelpie's report
// (docs/memory-format.md, "The daily report"): only links and a closed vocabulary, titles and paths
// that stay inside the link, the same page for the same findings, and no page without findings.
import { type NoteRef, noteLink, pathCode } from "@zikaron/memory";

/** Each list shows up to this, and each duplicates line up to that many notes, as in Kelpie. */
const REPORT_ENTRIES = 200;
const GROUP_NOTES = 10;

/** What the daily routine finds. The clients follow the client name pattern. */
export interface ReportFindings {
  /** The owner's notes that a client's write replaced or removed in the last week. */
  changed: (NoteRef & { at: number; removed: boolean; clients: readonly string[] })[];
  /** What a client wrote in the last week as said by the owner, through the provider. */
  ownerClaims: (NoteRef & { client: string; at: number })[];
  /** The notes that wait for the owner's "yes", with the origin's client. */
  pending: (NoteRef & { client: string })[];
  /** The tasks and delegations the routine archived in the last week. */
  archived: (NoteRef & { at: number })[];
  /** The owner's tasks and delegations that the routine would archive, and doesn't change. */
  ownersTasks: NoteRef[];
  /** Kelpie's cold notes and duplicates (`lifecycleFindings`), already in order. */
  cold: (NoteRef & { writtenAt: number })[];
  duplicates: { kind: "content" | "title"; notes: NoteRef[] }[];
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const byPath = (a: NoteRef, b: NoteRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function capped(lines: string[]): string[] {
  return lines.length <= REPORT_ENTRIES
    ? lines
    : [...lines.slice(0, REPORT_ENTRIES), `- …and ${lines.length - REPORT_ENTRIES} more.`];
}

/** A group's notes as links, the first GROUP_NOTES of them. */
function links(notes: readonly NoteRef[]): string {
  const shown = notes.slice(0, GROUP_NOTES).map(noteLink).join(", ");
  return notes.length > GROUP_NOTES ? `${shown} and ${notes.length - GROUP_NOTES} more` : shown;
}

/** One list per client, each with its own subheading, the clients and the notes in order. */
function byClient<T extends NoteRef & { client: string }>(
  notes: readonly T[],
  line: (note: T) => string,
): string[] {
  return [...new Set(notes.map((note) => note.client))].sort().flatMap((client) => [
    "",
    `### ${client}`,
    "",
    ...capped(
      notes
        .filter((note) => note.client === client)
        .sort(byPath)
        .map(line),
    ),
  ]);
}

/**
 * The findings as a Markdown page, or null when there are none. The same findings give the same
 * page, with no time of day, so a day with nothing new makes no commit.
 */
export function memoryReport(findings: ReportFindings): string | null {
  const sections: string[] = [];
  if (findings.changed.length > 0) {
    sections.push(
      [
        "## The owner's notes a client changed",
        "",
        "Notes that counted as the owner's and that a client's write replaced or removed in the last week. Newest first, with the last day and who changed them. Git keeps every previous version.",
        "",
        ...capped(
          [...findings.changed]
            .sort((a, b) => b.at - a.at || byPath(a, b))
            .map((note) => {
              const who = [...note.clients].sort().join(", ");
              return note.removed
                ? `- ${pathCode(note.path)}: removed by ${who} on ${day(note.at)}`
                : `- ${noteLink(note)}: changed by ${who} on ${day(note.at)}`;
            }),
        ),
      ].join("\n"),
    );
  }
  if (findings.ownerClaims.length > 0) {
    sections.push(
      [
        "## Said by the owner, through the provider",
        "",
        "What each client wrote in the last week as said by the owner, through the provider, with the day. The evidence stays in the note. Turning off a client's `ownerClaims` takes effect at once.",
        ...byClient(findings.ownerClaims, (note) => `- ${noteLink(note)}: ${day(note.at)}`),
      ].join("\n"),
    );
  }
  if (findings.pending.length > 0) {
    sections.push(
      [
        '## Waiting for the "yes"',
        "",
        'Notes waiting for the owner\'s "yes", by the client that wrote them. The "yes" is removing the `review: pending` from the note.',
        ...byClient(findings.pending, (note) => `- ${noteLink(note)}`),
      ].join("\n"),
    );
  }
  if (findings.archived.length > 0) {
    sections.push(
      [
        "## Archived tasks",
        "",
        "Tasks and delegations the routine archived in the last week: done, or with a date more than 90 days past. Nothing was deleted; to unarchive, remove the `archived`.",
        "",
        ...capped(
          [...findings.archived]
            .sort(byPath)
            .map((note) => `- ${noteLink(note)}: archived on ${day(note.at)}`),
        ),
      ].join("\n"),
    );
  }
  if (findings.ownersTasks.length > 0) {
    sections.push(
      [
        "## The owner's tasks to archive",
        "",
        "The owner's tasks and delegations that are done, or with a date more than 90 days past. The routine does not change an owner's note: archiving is setting `archived: true`.",
        "",
        ...capped([...findings.ownersTasks].sort(byPath).map((note) => `- ${noteLink(note)}`)),
      ].join("\n"),
    );
  }
  if (findings.cold.length > 0) {
    sections.push(
      [
        "## Cold notes",
        "",
        "Episodic notes, such as sessions, events and tasks, that time has cooled. They stay where they are.",
        "",
        ...capped(
          findings.cold.map((note) => `- ${noteLink(note)}: written on ${day(note.writtenAt)}`),
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
              `- ${group.kind === "content" ? "Same content" : "Same title"}: ${links(group.notes)}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return null;
  return `# Memory report\n\nZikaron writes this page every day from the memory index, with links only. Nothing listed was deleted, and the page goes away when every list is empty.\n\n${sections.join("\n\n")}\n`;
}
