// Identity comes from the credential (ADR-0001 §1): Cloudflare Access in front of the Worker, with
// one service token per client, and the Worker validating the JWT that Access puts in
// `Cf-Access-Jwt-Assertion`, even with Access in front. The token's `common_name` (the service
// token's Client ID) picks the client in the deploy's configuration; nothing in the request does.
import { CLIENT_NAME, type ReaderPolicy } from "@zikaron/memory";

/** A client in the deploy's configuration (`ZIKARON_CLIENTS`). */
export interface Client {
  /** Names the `agent/<name>` scope and the `origin.client` of the versions it writes. */
  name: string;
  /** Reads outside content. */
  exposed: boolean;
  /** Acts with the owner's authority. */
  privileged: boolean;
  /** What it writes as said by the owner, via the provider, counts as the owner's for others. */
  ownerClaims: boolean;
}

/** The clients, by each one's service token Client ID. */
export type Clients = ReadonlyMap<string, Client>;

/**
 * The server itself, as the writer of the daily routine (#17): the task archive and the report. No
 * client in the configuration has this name, so the `Zikaron-Client` trailer and the queue never
 * mistake the routine for a client.
 */
export const SERVER_CLIENT = "zikaron";

/**
 * Reads `ZIKARON_CLIENTS`: a JSON object from each service token's Client ID to the client. Refuses
 * the whole configuration when anything is invalid, so a typo doesn't open a door.
 */
export function parseClients(json: string | undefined): Clients {
  if (json === undefined || json.trim() === "") throw new Error("ZIKARON_CLIENTS is empty");
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ZIKARON_CLIENTS must be an object");
  }
  // JSON.parse keeps only the last of two equal Client IDs: the repeat is refused separately.
  for (const id of Object.keys(value)) {
    const quoted = JSON.stringify(id);
    let count = 0;
    for (let at = json.indexOf(quoted); at !== -1; at = json.indexOf(quoted, at + 1)) {
      if (/^\s*:/.test(json.slice(at + quoted.length))) count += 1;
    }
    if (count > 1) throw new Error("ZIKARON_CLIENTS repeats a client id");
  }
  const clients = new Map<string, Client>();
  const names = new Set<string>();
  for (const [id, entry] of Object.entries(value)) {
    const client = entry as Partial<Client> | null;
    const flags = [client?.exposed, client?.privileged, client?.ownerClaims];
    if (
      id.trim() === "" ||
      typeof client?.name !== "string" ||
      !CLIENT_NAME.test(client.name) ||
      !flags.every((flag) => typeof flag === "boolean") ||
      Object.keys(client).some(
        (key) => !["name", "exposed", "privileged", "ownerClaims"].includes(key),
      )
    ) {
      throw new Error("ZIKARON_CLIENTS has an invalid client");
    }
    // A client that reads outside content can't act with the owner's authority.
    if (client.exposed && client.privileged) {
      throw new Error("ZIKARON_CLIENTS has a client both exposed and privileged");
    }
    if (names.has(client.name)) throw new Error("ZIKARON_CLIENTS repeats a client name");
    if (client.name === SERVER_CLIENT) throw new Error("ZIKARON_CLIENTS names the server itself");
    names.add(client.name);
    clients.set(id, client as Client);
  }
  return clients;
}

/** A client's read policy (ADR-0001 §5), with everyone's configuration. */
export function readerPolicy(client: Client, clients: Clients): ReaderPolicy {
  const all = [...clients.values()];
  return {
    client: client.name,
    mode: client.exposed ? "exposed" : client.privileged ? "privileged" : "plain",
    trusted: all.filter((each) => !each.exposed).map((each) => each.name),
    ownerClaims: all.filter((each) => each.ownerClaims).map((each) => each.name),
  };
}

/** The Access application: the team domain (`https://<team>.cloudflareaccess.com`) and the AUD. */
export interface AccessApp {
  teamDomain: string;
  aud: string;
}

interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

/** Fetches the team's public keys; swappable in tests. */
export type KeyFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const fetchKeys: KeyFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Access certs: ${response.status}`);
  return (await response.json()) as { keys: Jwk[] };
};

/**
 * The keys are cached per isolate. An unknown `kid` forces a new fetch, at most one per minute, so
 * a forged token doesn't turn into a flood of fetches.
 */
const KEYS_TTL_MS = 60 * 60_000;
const REFETCH_MS = 60_000;
/** Leeway for clocks that disagree. */
const CLOCK_SKEW_S = 60;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

async function keysOf(
  teamDomain: string,
  fetcher: KeyFetcher,
  now: number,
  fresh: boolean,
): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(teamDomain);
  if (cached !== undefined) {
    const age = now - cached.at;
    if ((!fresh && age < KEYS_TTL_MS) || (fresh && age < REFETCH_MS)) return cached.keys;
  }
  const { keys } = await fetcher(`${teamDomain}/cdn-cgi/access/certs`);
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || jwk.kid === undefined) continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    try {
      imported.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          jwk as JsonWebKey,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      // A key that fails to import doesn't bring down the others.
    }
  }
  keyCache.set(teamDomain, { at: now, keys: imported });
  return imported;
}

/** Forgets the cached keys (tests). */
export function clearKeyCache(): void {
  keyCache.clear();
}

function base64UrlBytes(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function jsonPart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The Client ID of an Access service token JWT valid for the application, or null: an RS256
 * signature by a team key, the team's `iss`, the application's `aud`, within its validity, of
 * type `app` and with a `common_name`. A person's login JWT (with `email`) won't do: service
 * tokens only.
 */
export async function verifyAccessJwt(
  token: string | null,
  app: AccessApp,
  options: { now?: number; fetcher?: KeyFetcher } = {},
): Promise<string | null> {
  if (token === null || app.teamDomain === "" || app.aud === "") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = jsonPart(headerPart);
  const payload = jsonPart(payloadPart);
  if (header === null || payload === null || header.alg !== "RS256") return null;
  if (typeof header.kid !== "string") return null;
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetchKeys;
  let key = (await keysOf(app.teamDomain, fetcher, now, false)).get(header.kid);
  if (key === undefined) key = (await keysOf(app.teamDomain, fetcher, now, true)).get(header.kid);
  if (key === undefined) return null;
  let signature: Uint8Array;
  try {
    signature = base64UrlBytes(signaturePart);
  } catch {
    return null;
  }
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) return null;

  const seconds = now / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== app.teamDomain || !audiences.includes(app.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > seconds) return null;
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_S > seconds) return null;
  if (payload.type !== "app" || payload.email !== undefined) return null;
  const commonName = payload.common_name;
  return typeof commonName === "string" && commonName !== "" ? commonName : null;
}

/** A request's client, or null (401): the credential decides, never the request's body. */
export async function clientOf(
  request: Request,
  app: AccessApp,
  clients: Clients,
  options: { now?: number; fetcher?: KeyFetcher } = {},
): Promise<Client | null> {
  const id = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), app, options);
  return id === null ? null : (clients.get(id) ?? null);
}
