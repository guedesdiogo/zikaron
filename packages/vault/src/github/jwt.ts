import { base64url } from "./encoding.ts";

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const PKCS8_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PKCS8_END = "-----END PRIVATE KEY-----";

/**
 * Imports the App's private key from a PKCS#8 PEM. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE
 * KEY`), which WebCrypto can't import; the owner converts it once with `openssl pkcs8`. Error
 * messages never include key material.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt` (see docs/context-store.md)",
    );
  }
  const begin = pem.indexOf(PKCS8_BEGIN);
  const end = pem.indexOf(PKCS8_END);
  if (begin === -1 || end < begin) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)");
  }
  // Drops line breaks, including literal `\n` left by an unquoted .dev.vars value.
  const body = pem.slice(begin + PKCS8_BEGIN.length, end).replace(/\\n|\s/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, ALGORITHM, false, ["sign"]);
}

export interface AppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

/**
 * GitHub's rules: `iat` backdated 60 s against clock drift, `exp` at most 10 minutes ahead, `iss`
 * the App ID. `exp` is counted from the backdated `iat`, so it stays within 10 minutes either way.
 */
export function appJwtClaims(appId: string, nowSeconds: number): AppJwtClaims {
  const iat = nowSeconds - 60;
  return { iat, exp: iat + 600, iss: appId };
}

/** Signs a GitHub App JWT (RS256) with WebCrypto. */
export async function signAppJwt(key: CryptoKey, appId: string, now = Date.now()): Promise<string> {
  const claims = appJwtClaims(appId, Math.floor(now / 1000));
  const signingInput = `${segment({ alg: "RS256", typ: "JWT" })}.${segment(claims)}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function segment(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}
