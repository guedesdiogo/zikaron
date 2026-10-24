// A conversation's session page (#109): built by rule, with no model call, from the messages of
// one stretch of conversation. Its shape follows ai-memory's rule-based session pages at fc4da03
// (`crates/ai-memory-hooks/src/synth.rs`): a title from the first message, a metadata line, then
// the messages, with the first and last kept when there are too many.
import { memoryPath, type Scope, slugify } from "./layout.ts";
import { type Sanitized, sanitizeSecrets, visibleText } from "./sanitize.ts";
import { writeMemory } from "./write.ts";

export interface SessionLine {
  role: "user" | "assistant";
  /** Who said it: a user id, or the agent's id. */
  speaker: string;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface SessionInput {
  /** Names this session in the page's path, so two sessions never share a file: a history row id. */
  key: string;
  channel: string;
  threadId: string;
  /** The IANA time zone a person in the conversation last gave, or null for UTC. */
  timeZone: string | null;
  lines: readonly SessionLine[];
  /** The private keys left open by the previous session: `openKeys` from its page. */
  openKeys?: OpenKeys;
}

/**
 * Who began pasting a private key and hasn't ended it, with the time of their last message that
 * held it.
 */
export type OpenKeys = Readonly<Record<string, number>>;

export interface SessionPage {
  path: string;
  text: string;
  /** How many secrets the sanitizer replaced on the page. */
  redactions: number;
  /** The private keys still open when the session ended, for the next one. */
  openKeys: OpenKeys;
}

/**
 * Each message is cut to this many characters, after its secrets are replaced. #297 measured 280
 * losing every answer past the cut; this keeps most replies whole (#326).
 */
const EXCERPT_CHARS = 2_000;
/**
 * Only a message's start is read, cut back to a space: the page shows at most its first
 * EXCERPT_CHARS characters, and the cut can't leave a secret's first characters behind. It bounds
 * the sanitizer's work on long messages.
 */
const READ_CHARS = 8_192;
const BEGIN_KEY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const END_KEY = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
/**
 * A private key someone began is redacted in their messages up to its end, as when one is pasted
 * in parts, but only this long after their last message that held it: a header quoted in passing
 * doesn't blank everything they say after.
 */
const KEY_CARRY_MS = 10 * 60_000;
/** A longer session keeps its first and last messages. */
const HEAD_LINES = 100;
const TAIL_LINES = 100;
/**
 * A page's messages stay under this many characters, so the index, which reads a body's first
 * 262,144, searches a long day whole (#326).
 */
const MAX_PAGE_CHARS = 60_000;
/**
 * How much of a stretch of conversation its page keeps. Pages use `SESSION_LIMITS`; the session
 * recall evaluation (#297) measures others. A message is read up to READ_CHARS whatever the cut.
 */
export interface SessionLimits {
  /** Each message is cut to this many characters, after its secrets are replaced. */
  excerptChars: number;
  /** A session longer than both keeps only its first `headLines` and last `tailLines` messages. */
  headLines: number;
  tailLines: number;
  /** The messages a page shows stay under this many characters; the middle ones go first. */
  maxChars: number;
}

export const SESSION_LIMITS: SessionLimits = {
  excerptChars: EXCERPT_CHARS,
  headLines: HEAD_LINES,
  tailLines: TAIL_LINES,
  maxChars: MAX_PAGE_CHARS,
};

/** How sure a session page is: what the owner said alone, or with others in a group (#109). */
const PRIVATE_CONFIDENCE = 0.9;
const GROUP_CONFIDENCE = 0.6;

function zoneOf(timeZone: string | null): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DD` and `HH:MM` of an instant in a time zone. */
function clock(at: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * A conversation as its session pages name it in their sources: its channel and thread, as visible
 * text on one line, at most `max` characters. The memory tools (#126) name it the same way.
 */
export function conversationSource(channel: string, threadId: string, max = 300): string {
  return excerpt(visibleText(`${channel}:${threadId}`), max);
}

/**
 * A conversation's own scope, where its session pages go and the most a turn outside the owner's
 * direct chats may see (#131). A group's thread id starts with `-` on Telegram, written `g`.
 */
export function conversationScope(channel: string, threadId: string): Scope {
  return `conversation/${slugify(`${channel}-${threadId.replace(/^-/, "g")}`)}` as Scope;
}

/**
 * One line of text, at most `max` characters. `[[` is broken, so a message doesn't add links to
 * the vault's graph.
 */
function excerpt(text: string, max: number): string {
  const line = text
    .replace(/\s+/g, " ")
    .replace(/\[(?=\[)/g, "[ ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A message made inert where Obsidian would act on it: no HTML, no embedded images, no inline code
 * (which plugins such as Dataview run), and no comments, which hide text from the owner but not
 * from the agent.
 */
function inert(text: string): string {
  return text
    .replace(/[\\`<]/g, "\\$&")
    .replace(/!\[/g, "!\\[")
    .replace(/%(?=%)/g, "%\\");
}

/** A title is cut to this before it is made inert; `writeMemory` takes one of 200 at most. */
const TITLE_CHARS = 120;
const TITLE_MAX_CHARS = 200;

/**
 * A title made inert within `writeMemory`'s 200 characters (#330). Escaping can double a mark, so
 * the excerpt shrinks by what overflows until the escaped title fits, and no escape is ever cut in
 * two. Escaping at most doubles a title, so this ends above 80 characters.
 */
function inertTitle(text: string): string {
  let max = TITLE_CHARS;
  let title = inert(excerpt(text, max));
  while (title.length > TITLE_MAX_CHARS) {
    max -= title.length - TITLE_MAX_CHARS;
    title = inert(excerpt(text, max));
  }
  return title;
}

/** Whether the text leaves a private key open: its last header has no end after it. */
function opensKey(text: string): boolean {
  const last = (pattern: RegExp) =>
    Math.max(-1, ...[...text.matchAll(pattern)].map((m) => m.index));
  return last(BEGIN_KEY) > last(END_KEY);
}

/** The start of a message that is read, cut back to a space so no word is cut in two. */
function readable(text: string): string {
  if (text.length <= READ_CHARS) return text;
  const cut = text.slice(0, READ_CHARS);
  return cut.slice(0, Math.max(0, cut.search(/\s\S*$/)));
}

/**
 * Each message as it shows, with what continues a private key its speaker began replaced, and the
 * keys still open after the last one.
 */
function carryKeys(
  lines: readonly SessionLine[],
  openKeys: OpenKeys,
): { texts: string[]; carried: number; openKeys: OpenKeys } {
  const open = new Map(Object.entries(openKeys));
  let carried = 0;
  const texts = lines.map((line) => {
    let text = visibleText(line.text);
    const since = open.get(line.speaker);
    if (since !== undefined && line.at - since <= KEY_CARRY_MS) {
      const end = [...text.matchAll(END_KEY)][0];
      text = `[REDACTED:private_key]${end === undefined ? "" : text.slice(end.index + end[0].length)}`;
      carried += 1;
      if (end === undefined) open.set(line.speaker, line.at);
      else open.delete(line.speaker);
    } else {
      open.delete(line.speaker);
    }
    if (opensKey(text)) open.set(line.speaker, line.at);
    return readable(text);
  });
  const last = lines.at(-1)?.at ?? 0;
  for (const [speaker, since] of open) if (last - since > KEY_CARRY_MS) open.delete(speaker);
  return { texts, carried, openKeys: Object.fromEntries(open) };
}

/** A speaker as plain text: nothing that Markdown would read as structure. */
function plainName(name: string): string {
  return excerpt(name.replace(/[*_#`[\]()<>|\\]/g, " "), 64) || "someone";
}

/**
 * The session page for a stretch of conversation, or null when no person spoke in it. Secrets are
 * replaced before anything is cut, so a cut can't split one past the sanitizer. Only the messages
 * the page shows, and the first one past its size, are sanitized, and only those it shows count.
 */
export async function sessionPage(
  input: SessionInput,
  limits: SessionLimits = SESSION_LIMITS,
): Promise<SessionPage | null> {
  const lines = [...input.lines].sort((a, b) => a.at - b.at);
  const firstUser = lines.find((line) => line.role === "user");
  const first = lines[0];
  const last = lines.at(-1);
  if (!firstUser || !first || !last) return null;

  const timeZone = zoneOf(input.timeZone);
  const { texts, carried, openKeys } = carryKeys(lines, input.openKeys ?? {});
  const sanitized = new Map<SessionLine, Sanitized>();
  const cleanText = (line: SessionLine) => {
    let result = sanitized.get(line);
    if (result === undefined) {
      result = sanitizeSecrets(texts[lines.indexOf(line)] ?? "");
      sanitized.set(line, result);
    }
    return result.text;
  };

  const start = clock(first.at, timeZone);
  const end = clock(last.at, timeZone);
  const opening = excerpt(cleanText(firstUser), 200);
  const title = inertTitle(`${clock(firstUser.at, timeZone).time} ${opening}`);
  const source = conversationSource(input.channel, input.threadId);
  const scope = conversationScope(input.channel, input.threadId);
  const speakers = new Set(
    lines.filter((line) => line.role === "user").map((line) => line.speaker),
  );

  const row = (line: SessionLine) =>
    `- **${clock(line.at, timeZone).time} ${plainName(line.speaker)}:** ${inert(excerpt(cleanText(line), limits.excerptChars))}`;
  // The first and last messages, taken in turn from both ends until the page's size, so a long
  // page loses its middle; a session within the line limits splits at its middle. The first
  // message always stays, so a page is never empty.
  const cut = lines.length > limits.headLines + limits.tailLines;
  const headMax = cut ? limits.headLines : Math.ceil(lines.length / 2);
  const tailMax = cut ? limits.tailLines : lines.length - headMax;
  const head: string[] = [];
  const tail: string[] = [];
  // The first person's message names the page, so its secrets count too.
  const shownLines = new Set<SessionLine>([firstUser]);
  let size = 0;
  while (head.length < headMax || tail.length < tailMax) {
    const fromTail = tail.length < tailMax && (head.length >= headMax || tail.length < head.length);
    const line = lines[fromTail ? lines.length - 1 - tail.length : head.length] as SessionLine;
    const shown = row(line);
    if (size + shown.length + 1 > limits.maxChars && head.length > 0) break;
    size += shown.length + 1;
    shownLines.add(line);
    if (fromTail) tail.unshift(shown);
    else head.push(shown);
  }
  let redactions = carried;
  for (const [line, result] of sanitized) if (shownLines.has(line)) redactions += result.redactions;
  const omitted = lines.length - head.length - tail.length;
  const body = [
    `${input.channel} · ${start.date} ${start.time}–${end.time} (${timeZone}) · ${lines.length} messages`,
    "",
    ...head,
    ...(omitted > 0 ? [`- … ${omitted} messages omitted …`] : []),
    ...tail,
  ].join("\n");

  const { text } = await writeMemory(
    {
      scope,
      kind: "session",
      title,
      body,
      level: "explicit",
      confidence: speakers.size > 1 ? GROUP_CONFIDENCE : PRIVATE_CONFIDENCE,
      sources: [source],
      // A first message with nothing left once sanitized has no abstract.
      ...(opening === "" ? {} : { abstract: opening }),
    },
    { at: new Date(last.at).toISOString().replace(/\.\d{3}Z$/, "Z") },
  );
  // The key goes after the title's slug is cut, so a long title can't cut it off.
  const name = `${slugify(title).slice(0, 60)} ${input.key}`;
  return { path: memoryPath(scope, "session", name, start.date), text, redactions, openKeys };
}
