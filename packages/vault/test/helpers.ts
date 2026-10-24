import { base64 } from "../src/github/encoding.ts";

/** A fresh RSA key pair for each test; the private half as a PKCS#8 PEM, like the converted App key. */
export async function generateAppKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const lines = base64(der).match(/.{1,64}/g) ?? [];
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

/** Decodes standard or url-safe base64, padded or not. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeBase64Text(text: string): string {
  return new TextDecoder().decode(decodeBase64(text));
}
