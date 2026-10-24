import { diff3Merge } from "node-diff3";

/**
 * diff3 grows fast with a file's length, and it runs inside the sync's transaction: past this many
 * lines, the owner's edit wins whole.
 */
const MAX_MERGE_LINES = 500;

/**
 * The server's change merged into the owner's edit, line by line from the version both started
 * from (diff3). The server's lines that don't overlap the owner's stay; where both only added lines
 * at the same place, both stay, the owner's first; where they changed the same lines, the owner's
 * side wins (Kelpie's ADR-0020). `overlapped` tells whether any of the server's lines lost. Line
 * endings follow the owner's file. Null when there is nothing in common to merge from (an empty
 * base), or a file is too long: the owner's edit then wins whole.
 */
export function mergeOwnerWins(
  base: string,
  owner: string,
  server: string,
): { content: string; overlapped: boolean } | null {
  const [o, b, k] = [owner, base, server].map(linesOf) as [string[], string[], string[]];
  if (b.length === 0 || Math.max(o.length, b.length, k.length) > MAX_MERGE_LINES) return null;
  let overlapped = false;
  const lines = diff3Merge(o, b, k).flatMap((region) => {
    if (region.conflict) {
      if (region.conflict.o.length === 0) return [...region.conflict.a, ...region.conflict.b];
      overlapped = true;
      return region.conflict.a;
    }
    return region.ok ?? [];
  });
  // The owner's first line ending stands for the file's.
  const eol = /\r?\n/.exec(owner)?.[0] ?? "\n";
  const closed = owner === "" ? server.endsWith("\n") : owner.endsWith("\n");
  const content = lines.join(eol) + (closed && lines.length > 0 ? eol : "");
  return { content, overlapped };
}

/** A file's lines, whatever its line endings, without the empty one a final newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
