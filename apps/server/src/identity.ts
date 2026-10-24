// A identidade vem da credencial (ADR-0001 §1): o Cloudflare Access na frente do Worker, com um
// service token por cliente, e o Worker validando o JWT que o Access põe em
// `Cf-Access-Jwt-Assertion`, mesmo com o Access na frente. O `common_name` do token (o Client ID do
// service token) escolhe o cliente na configuração do deploy; nada no pedido escolhe o cliente.
import { CLIENT_NAME, type ReaderPolicy } from "@zikaron/memory";

/** Um cliente da configuração do deploy (`ZIKARON_CLIENTS`). */
export interface Client {
  /** Nomeia o escopo `agent/<nome>` e o `origin.client` das versões que ele grava. */
  name: string;
  /** Lê conteúdo de fora. */
  exposed: boolean;
  /** Age com a autoridade do dono. */
  privileged: boolean;
  /** O que ele grava como dito pelo dono, pelo provedor, vale como do dono para os outros. */
  ownerClaims: boolean;
}

/** Os clientes, pelo Client ID do service token de cada um. */
export type Clients = ReadonlyMap<string, Client>;

/**
 * Lê `ZIKARON_CLIENTS`: um objeto JSON do Client ID de cada service token para o cliente. Recusa a
 * configuração inteira quando algo não vale, para um erro de digitação não abrir uma porta.
 */
export function parseClients(json: string | undefined): Clients {
  if (json === undefined || json.trim() === "") throw new Error("ZIKARON_CLIENTS is empty");
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ZIKARON_CLIENTS must be an object");
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
    // Quem lê conteúdo de fora não pode agir com a autoridade do dono.
    if (client.exposed && client.privileged) {
      throw new Error("ZIKARON_CLIENTS has a client both exposed and privileged");
    }
    if (names.has(client.name)) throw new Error("ZIKARON_CLIENTS repeats a client name");
    names.add(client.name);
    clients.set(id, client as Client);
  }
  return clients;
}

/** A política de leitura de um cliente (ADR-0001 §5), com a configuração de todos. */
export function readerPolicy(client: Client, clients: Clients): ReaderPolicy {
  const all = [...clients.values()];
  return {
    client: client.name,
    mode: client.exposed ? "exposed" : client.privileged ? "privileged" : "plain",
    exposed: all.filter((each) => each.exposed).map((each) => each.name),
    ownerClaims: all.filter((each) => each.ownerClaims).map((each) => each.name),
  };
}

/** A aplicação do Access: o domínio do time (`https://<time>.cloudflareaccess.com`) e o AUD. */
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

/** Busca as chaves públicas do time; trocável nos testes. */
export type KeyFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const fetchKeys: KeyFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Access certs: ${response.status}`);
  return (await response.json()) as { keys: Jwk[] };
};

/** As chaves ficam em cache por isolate; um `kid` desconhecido força uma busca nova. */
const KEYS_TTL_MS = 60 * 60_000;
/** Uma folga para relógios que não batem. */
const CLOCK_SKEW_S = 60;
const keyCache = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

async function keysOf(
  teamDomain: string,
  fetcher: KeyFetcher,
  now: number,
  fresh: boolean,
): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(teamDomain);
  if (!fresh && cached !== undefined && now - cached.at < KEYS_TTL_MS) return cached.keys;
  const { keys } = await fetcher(`${teamDomain}/cdn-cgi/access/certs`);
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || jwk.kid === undefined) continue;
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
  }
  keyCache.set(teamDomain, { at: now, keys: imported });
  return imported;
}

/** Esquece as chaves em cache (testes). */
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
 * O Client ID de um JWT de service token do Access válido para a aplicação, ou null: assinatura
 * RS256 por uma chave do time, `iss` do time, o `aud` da aplicação, dentro da validade, do tipo
 * `app` e com `common_name`. Um JWT de login de pessoa (com `email`) não serve: só service tokens.
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

/** O cliente de um pedido, ou null (401): a credencial decide, nunca o corpo do pedido. */
export async function clientOf(
  request: Request,
  app: AccessApp,
  clients: Clients,
  options: { now?: number; fetcher?: KeyFetcher } = {},
): Promise<Client | null> {
  const id = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), app, options);
  return id === null ? null : (clients.get(id) ?? null);
}
