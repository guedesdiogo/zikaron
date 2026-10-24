/** Standard base64 (with `+`, `/` and padding), the encoding GraphQL's `Base64String` expects. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Unpadded base64url, the encoding of JWT segments (RFC 7515). */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
