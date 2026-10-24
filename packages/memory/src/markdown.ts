// Frontmatter fences and link extraction, translated from ai-memory's `markdown.rs` at fc4da03
// (https://github.com/akitaonrails/ai-memory/blob/fc4da03/crates/ai-memory-wiki/src/markdown.rs)
// and adapted to Obsidian's wikilinks, which resolve by file name as well as by path.
//
// ai-memory is MIT licensed:
// Copyright (c) 2026 Fabio Akita
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

export interface Split {
  /** The YAML between the fences, or null when the file doesn't open with a frontmatter block. */
  yaml: string | null;
  body: string;
}

/**
 * Splits a leading `---` block from the body. A BOM is dropped, and CRLF fences are accepted:
 * that is what a Windows editor, or a clone with `core.autocrlf`, saves.
 */
export function splitFrontmatter(text: string): Split {
  const input = text.startsWith("\u{FEFF}") ? text.slice(1) : text;
  const firstEnd = input.indexOf("\n");
  if (firstEnd === -1 || input.slice(0, firstEnd).replace(/\r$/, "") !== "---") {
    return { yaml: null, body: input };
  }
  let start = firstEnd + 1;
  while (start <= input.length) {
    const end = input.indexOf("\n", start);
    const line = input.slice(start, end === -1 ? input.length : end).replace(/\r$/, "");
    if (line === "---") {
      const yaml = input.slice(firstEnd + 1, start).replace(/\r?\n$/, "");
      return { yaml, body: end === -1 ? "" : input.slice(end + 1) };
    }
    if (end === -1) break;
    start = end + 1;
  }
  return { yaml: null, body: input };
}

/** Whether each line of a body is code, or a fence, as the reader sees it when it finds a title. */
export function codeLines(body: string): boolean[] {
  let fence: Fence | null = null;
  return body.split("\n").map((line) => {
    const [next, isCode] = stepFence(fence, line);
    fence = next;
    return isCode;
  });
}

/** Title from the frontmatter, then the first `# ` heading, then the file name. */
export function deriveTitle(frontmatterTitle: unknown, body: string, path: string): string {
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim() !== "") {
    return frontmatterTitle.trim();
  }
  let fence: Fence | null = null;
  for (const line of body.split("\n")) {
    const [next, isCode] = stepFence(fence, line);
    fence = next;
    if (!isCode && line.startsWith("# ") && line.slice(2).trim() !== "")
      return line.slice(2).trim();
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** How a link names its target: a vault path, or a file name that Obsidian resolves anywhere. */
export type LinkBy = "path" | "name";
export type LinkKind = "link" | "embed" | "source" | "contradicts" | "merged_into";

export interface LinkTarget {
  by: LinkBy;
  /** Lowercase, without `.md`: `memory/people/ana-souza` by path, `ana-souza` by name. */
  target: string;
}

export interface NoteLink extends LinkTarget {
  kind: LinkKind;
}

interface Fence {
  glyph: string;
  length: number;
}

/** List and quote markers before a fence: `- ```sh`, `1. ```, `> ````. */
const CONTAINER_MARKERS = /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+))*/;

/** Updates the code-fence state for a line; reports whether the line is code or a fence. */
function stepFence(current: Fence | null, line: string): [Fence | null, boolean] {
  const trimmed = line.replace(CONTAINER_MARKERS, "").trimStart();
  const glyph = trimmed[0];
  if (glyph !== "`" && glyph !== "~") return [current, current !== null];
  let length = 0;
  while (trimmed[length] === glyph) length += 1;
  if (length < 3) return [current, current !== null];
  const info = trimmed.slice(length);
  if (current === null) {
    // A backtick fence's info string can't hold a backtick: ```code``` is an inline span.
    if (glyph === "`" && info.includes("`")) return [null, false];
    return [{ glyph, length }, true];
  }
  if (current.glyph === glyph && length >= current.length && info.trim() === "")
    return [null, true];
  return [current, true];
}

/** The line with each inline code span, backticks included, blanked: code shows links as text. */
function blankInlineCode(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      out += line[index];
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") run += 1;
    const ticks = "`".repeat(run);
    let close = line.indexOf(ticks, index + run);
    // A closing run must be exactly as long as the opening one.
    while (close !== -1 && line[close + run] === "`") {
      let skip = close;
      while (line[skip] === "`") skip += 1;
      close = line.indexOf(ticks, skip);
    }
    if (close === -1) {
      out += ticks;
      index += run;
      continue;
    }
    out += " ".repeat(close + run - index);
    index = close + run;
  }
  return out;
}

/** Resolves `.` and `..` against a directory; null when the path climbs out of the vault. */
function resolvePath(dir: string[], target: string): string | null {
  const parts = [...dir];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** Files Obsidian links to that aren't notes. A name with any other dot is a note's name. */
const ATTACHMENTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "webp",
  "avif",
  "heic",
  "tif",
  "tiff",
  "ico",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "3gp",
  "webm",
  "mp4",
  "mov",
  "mkv",
  "ogv",
  "avi",
  "pdf",
  "canvas",
  "base",
  "txt",
  "csv",
  "json",
  "html",
  "htm",
  "zip",
  "epub",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
]);

/**
 * A link's target as an index key; null for anything that isn't another note. Wikilinks are
 * vault-rooted unless they start with `./` or `../`; Markdown links are relative to the note and
 * must name a `.md` file.
 */
function toTarget(raw: string, sourcePath: string, markdown: boolean): LinkTarget | null {
  let target = raw.normalize("NFC").trim();
  if (target === "" || target.includes("://") || target.includes("\\")) return null;
  if (/^(mailto|data|javascript|tel):/i.test(target)) return null;
  const hash = target.indexOf("#");
  if (hash !== -1) target = target.slice(0, hash).trim();
  const lastSegment = target.slice(target.lastIndexOf("/") + 1);
  if (lastSegment === "") return null;
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment)?.[1]?.toLowerCase();
  if (extension === "md") {
    target = target.slice(0, -3);
  } else if (markdown || (extension !== undefined && ATTACHMENTS.has(extension))) {
    return null;
  }
  if (!markdown && !target.includes("/")) return { by: "name", target: target.toLowerCase() };
  const relative = target.startsWith("./") || target.startsWith("../");
  const dir =
    relative || (markdown && !target.startsWith("/")) ? sourcePath.split("/").slice(0, -1) : [];
  const resolved = resolvePath(dir, target);
  return resolved === null ? null : { by: "path", target: resolved.toLowerCase() };
}

/** The target of one `[[...]]` body: `\|` is a table's escaped pipe, then label and heading go. */
export function wikilinkTarget(inner: string, sourcePath: string): LinkTarget | null {
  const unescaped = inner.replace(/\\\|/g, "|");
  const pipe = unescaped.indexOf("|");
  return toTarget(pipe === -1 ? unescaped : unescaped.slice(0, pipe), sourcePath, false);
}

// Neither a note name nor a destination holds brackets or parentheses here, which keeps both
// patterns linear on lines built to make them backtrack.
const WIKILINK = /(!?)\[\[([^[\]\n]+)\]\]/g;
const MARKDOWN_LINK = /(!?)\[[^[\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/**
 * Links in a body: Obsidian wikilinks and embeds (`[[a]]`, `[[a|label]]`, `[[a#heading]]`,
 * `![[a]]`) and Markdown links to `.md` files. Links in code, external URLs and links to anything
 * but a note are skipped. Results are deduplicated, in document order.
 */
export function extractLinks(body: string, sourcePath: string): NoteLink[] {
  const seen = new Set<string>();
  const out: NoteLink[] = [];
  const add = (kind: LinkKind, target: LinkTarget | null) => {
    if (target === null) return;
    const key = `${kind}\u0000${target.by}\u0000${target.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, ...target });
  };
  let fence: Fence | null = null;
  for (const raw of body.split("\n")) {
    const [next, isCode] = stepFence(fence, raw);
    fence = next;
    if (isCode) continue;
    const line = blankInlineCode(raw);
    for (const match of line.matchAll(WIKILINK)) {
      add(match[1] === "!" ? "embed" : "link", wikilinkTarget(match[2] ?? "", sourcePath));
    }
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      if (match[1] === "!") continue;
      let destination = (match[2] ?? "").replace(/^<|>$/g, "");
      try {
        destination = decodeURIComponent(destination);
      } catch {
        continue;
      }
      add("link", toTarget(destination, sourcePath, true));
    }
  }
  return out;
}

/** Wikilinks in a frontmatter value, such as a source or a relation written as `"[[a]]"`. */
export function valueLinks(value: string, sourcePath: string): LinkTarget[] {
  return [...value.matchAll(WIKILINK)]
    .map((match) => wikilinkTarget(match[2] ?? "", sourcePath))
    .filter((target) => target !== null);
}
