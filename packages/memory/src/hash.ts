const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Git's blob SHA-1 of a file's content: the same value GitHub's trees report for it. */
export async function gitBlobSha(content: string): Promise<string> {
  const body = encoder.encode(content);
  const header = encoder.encode(`blob ${body.byteLength}\u0000`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

/**
 * A note's version as the memory tools show it (#297): the first 12 hex digits of its file's git
 * blob SHA. `memory_write` takes it back to change the note, so a version written since isn't lost.
 */
export async function noteVersion(content: string): Promise<string> {
  return (await gitBlobSha(content)).slice(0, 12);
}

/** The first 16 hex digits of the SHA-256 of `text`. */
export async function shortSha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text))).slice(0, 16);
}
