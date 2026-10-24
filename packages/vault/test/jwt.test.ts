import { describe, expect, it } from "vitest";
import { importPrivateKey, signAppJwt } from "../src/github/jwt.ts";
import { decodeBase64, decodeBase64Text, generateAppKey } from "./helpers.ts";

const APP_ID = "5181584";
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;

async function verify(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

describe("signAppJwt", () => {
  it("signs an RS256 JWT that verifies with the App's public key", async () => {
    const { pem, publicKey } = await generateAppKey();

    const jwt = await signAppJwt(await importPrivateKey(pem), APP_ID, NOW);

    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(decodeBase64Text(segments[0] ?? ""))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(await verify(jwt, publicKey)).toBe(true);
  });

  it("backdates iat by 60 s, expires within 10 minutes and names the App as issuer", async () => {
    const { pem } = await generateAppKey();

    const jwt = await signAppJwt(await importPrivateKey(pem), APP_ID, NOW);
    const claims = JSON.parse(decodeBase64Text(jwt.split(".")[1] ?? ""));

    expect(claims).toEqual({ iat: NOW_SECONDS - 60, exp: expect.any(Number), iss: APP_ID });
    expect(claims.exp).toBeGreaterThan(NOW_SECONDS);
    expect(claims.exp).toBeLessThanOrEqual(NOW_SECONDS + 600);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("does not verify with another key", async () => {
    const signer = await generateAppKey();
    const other = await generateAppKey();

    const jwt = await signAppJwt(await importPrivateKey(signer.pem), APP_ID, NOW);

    expect(await verify(jwt, other.publicKey)).toBe(false);
  });
});

describe("importPrivateKey", () => {
  it("accepts a PEM whose line breaks arrived as literal \\n", async () => {
    const { pem, publicKey } = await generateAppKey();

    const key = await importPrivateKey(pem.trim().replaceAll("\n", "\\n"));

    expect(await verify(await signAppJwt(key, APP_ID, NOW), publicKey)).toBe(true);
  });

  it("refuses GitHub's PKCS#1 PEM and points to the openssl conversion", async () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";

    await expect(importPrivateKey(pkcs1)).rejects.toThrow(/openssl pkcs8 -topk8 -nocrypt/);
  });

  it("refuses a value that isn't a PEM", async () => {
    await expect(importPrivateKey("not a key")).rejects.toThrow(/not a PKCS#8 PEM/);
  });
});
