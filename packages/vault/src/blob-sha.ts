const encoder = new TextEncoder();

/**
 * Git's blob SHA-1 of a file, text as UTF-8 or a binary file's bytes: what `git hash-object` and
 * GitHub's trees report.
 */
export async function gitBlobSha(content: string | Uint8Array): Promise<string> {
  const body = typeof content === "string" ? encoder.encode(content) : content;
  const header = encoder.encode(`blob ${body.byteLength}\u0000`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
