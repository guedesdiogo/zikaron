/** A file split around git's conflict blocks: the text outside them, and each block's sides. */
export interface ConflictedFile {
  /** One more than `blocks`: the lines before, between and after the blocks. */
  stable: string[][];
  blocks: { ours: string[]; base: string[]; theirs: string[] }[];
}

const OPEN = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const CLOSE = /^>{7}(?: |$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A file's lines, whatever its line endings. */
const linesOf = (text: string) => text.split(/\r?\n/);

/**
 * Which lines sit inside a fenced code block that closes. A fence left open protects nothing: its
 * lines are text, so a conflict after it is still found.
 */
function fenced(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; at: number } | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const marker = FENCE.exec(lines[at] as string)?.[1];
    if (marker === undefined) continue;
    if (open === null) {
      open = { marker, at };
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      for (let line = open.at; line <= at; line += 1) inside[line] = true;
      open = null;
    }
  }
  return inside;
}

/**
 * The file's conflict blocks, found line by line in one pass: `<<<<<<<`, an optional `|||||||`,
 * `=======`, then `>>>>>>>`, at line starts. Lines inside a closed fenced code block are text, and
 * a block left unfinished isn't one. Null when the file holds no complete block.
 */
export function conflictsOf(text: string): ConflictedFile | null {
  const lines = linesOf(text);
  const inside = fenced(lines);
  const stable: string[][] = [[]];
  const blocks: ConflictedFile["blocks"] = [];
  let open: { ours: string[]; base: string[]; theirs: string[]; at: number } | null = null;
  let side: "ours" | "base" | "theirs" = "ours";
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (open === null) {
      if (!inside[at] && OPEN.test(line)) {
        open = { ours: [], base: [], theirs: [], at };
        side = "ours";
      } else {
        (stable.at(-1) as string[]).push(line);
      }
      continue;
    }
    if (side === "ours" && BASE.test(line)) {
      side = "base";
    } else if (side !== "theirs" && SPLIT.test(line)) {
      side = "theirs";
    } else if (side === "theirs" && CLOSE.test(line)) {
      blocks.push({ ours: open.ours, base: open.base, theirs: open.theirs });
      stable.push([]);
      open = null;
    } else {
      open[side].push(line);
    }
  }
  if (open !== null) {
    // Unfinished: its lines are text after all. One at a time, however many there are.
    const tail = stable.at(-1) as string[];
    for (let at = open.at; at < lines.length; at += 1) tail.push(lines[at] as string);
  }
  return blocks.length === 0 ? null : { stable, blocks };
}

/** Whether a file still holds a merge conflict that someone committed unresolved. */
export function hasConflictMarkers(text: string): boolean {
  return conflictsOf(text) !== null;
}
