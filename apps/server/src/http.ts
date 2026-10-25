// What the Worker's routes share: a request's JSON body, with a cap, and the JSON responses.

/** The largest body a route reads: a note is 1 MiB at most; a request, the note and a bit more. */
export const MAX_REQUEST_BYTES = 1_100_000;

/** A JSON response. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

/**
 * The body as text, or null when it exceeds `max` bytes. Reads in chunks and stops at the limit, so
 * a body without `Content-Length` doesn't get into memory whole.
 */
export async function readUpTo(request: Request, max: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A request's body as JSON, or why it isn't: too large, or invalid JSON. */
export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid_json" }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) return { ok: false, reason: "too_large" };
  const text = await readUpTo(request, MAX_REQUEST_BYTES);
  if (text === null) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** A JSON object (not an array, not null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
