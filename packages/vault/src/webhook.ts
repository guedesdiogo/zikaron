// GitHub's push webhook: the way edits made outside Kelpie (GitHub, Obsidian through obsidian-git)
// reach the Context Store (ADR-0005).

const encoder = new TextEncoder();

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/**
 * Checks `X-Hub-Signature-256` (`sha256=<hex>`, an HMAC of the raw body with the webhook's secret).
 * WebCrypto's verify compares in constant time. An empty secret never matches.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (secret === "" || header === null || !header.startsWith("sha256=")) return false;
  const signature = fromHex(header.slice("sha256=".length));
  if (signature === null || signature.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

export interface PushEvent {
  /** `refs/heads/<branch>`. */
  ref: string;
  /** The head after the push; all zeros when the branch was deleted. */
  after: string;
}

/** The fields of a push event the Context Store reads, or null for anything else. */
export function parsePushEvent(payload: unknown): PushEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { ref, after } = payload as { ref?: unknown; after?: unknown };
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null;
  if (typeof after !== "string" || !/^[0-9a-f]{40}$/.test(after)) return null;
  return { ref, after };
}
