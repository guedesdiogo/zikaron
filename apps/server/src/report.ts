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
    : [...lines.slice(0, REPORT_ENTRIES), `- …e mais ${lines.length - REPORT_ENTRIES}.`];
}

/** A group's notes as links, the first GROUP_NOTES of them. */
function links(notes: readonly NoteRef[]): string {
  const shown = notes.slice(0, GROUP_NOTES).map(noteLink).join(", ");
  return notes.length > GROUP_NOTES ? `${shown} e mais ${notes.length - GROUP_NOTES}` : shown;
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
        "## Notas do dono que um cliente mudou",
        "",
        "Notas que valiam como do dono e que a gravação de um cliente substituiu ou removeu na última semana. As mais recentes primeiro, com o último dia e quem mudou. O git guarda cada versão anterior.",
        "",
        ...capped(
          [...findings.changed]
            .sort((a, b) => b.at - a.at || byPath(a, b))
            .map((note) => {
              const who = [...note.clients].sort().join(", ");
              return note.removed
                ? `- ${pathCode(note.path)}: removida por ${who} em ${day(note.at)}`
                : `- ${noteLink(note)}: mudada por ${who} em ${day(note.at)}`;
            }),
        ),
      ].join("\n"),
    );
  }
  if (findings.ownerClaims.length > 0) {
    sections.push(
      [
        "## Ditas pelo dono, pelo provedor",
        "",
        "O que cada cliente gravou na última semana como dito pelo dono, pelo provedor, com o dia. A evidência fica na nota. Desligar o `ownerClaims` de um cliente vale na hora.",
        ...byClient(findings.ownerClaims, (note) => `- ${noteLink(note)}: ${day(note.at)}`),
      ].join("\n"),
    );
  }
  if (findings.pending.length > 0) {
    sections.push(
      [
        "## Esperam o «sim»",
        "",
        "Notas que esperam o «sim» do dono, pelo cliente que as gravou. O «sim» é tirar o `review: pending` da nota.",
        ...byClient(findings.pending, (note) => `- ${noteLink(note)}`),
      ].join("\n"),
    );
  }
  if (findings.archived.length > 0) {
    sections.push(
      [
        "## Tarefas arquivadas",
        "",
        "Tarefas e delegações que a rotina arquivou na última semana: concluídas, ou com a data passada de 90 dias. Nada foi apagado; desarquivar é tirar o `archived`.",
        "",
        ...capped(
          [...findings.archived]
            .sort(byPath)
            .map((note) => `- ${noteLink(note)}: arquivada em ${day(note.at)}`),
        ),
      ].join("\n"),
    );
  }
  if (findings.ownersTasks.length > 0) {
    sections.push(
      [
        "## Tarefas do dono para arquivar",
        "",
        "Tarefas e delegações do dono concluídas, ou com a data passada de 90 dias. A rotina não muda uma nota do dono: arquivar é pôr `archived: true`.",
        "",
        ...capped([...findings.ownersTasks].sort(byPath).map((note) => `- ${noteLink(note)}`)),
      ].join("\n"),
    );
  }
  if (findings.cold.length > 0) {
    sections.push(
      [
        "## Notas frias",
        "",
        "Notas episódicas, como sessões, eventos e tarefas, que o tempo esfriou. Ficam onde estão.",
        "",
        ...capped(
          findings.cold.map((note) => `- ${noteLink(note)}: escrita em ${day(note.writtenAt)}`),
        ),
      ].join("\n"),
    );
  }
  if (findings.duplicates.length > 0) {
    sections.push(
      [
        "## Duplicadas",
        "",
        ...capped(
          findings.duplicates.map(
            (group) =>
              `- ${group.kind === "content" ? "O mesmo conteúdo" : "O mesmo título"}: ${links(group.notes)}`,
          ),
        ),
      ].join("\n"),
    );
  }
  if (sections.length === 0) return null;
  return `# Relatório da memória\n\nO Zikaron escreve esta página todo dia a partir do índice da memória, só com links. Nada listado foi apagado, e ela some quando todas as listas ficam vazias.\n\n${sections.join("\n\n")}\n`;
}
