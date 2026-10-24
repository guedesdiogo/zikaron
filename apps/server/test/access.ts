// O Access de teste: uma chave RSA gerada aqui, a busca das chaves trocada pela do teste, e JWTs de
// service token emitidos para os Client IDs sintéticos de vitest.config.ts. Nada vem de fora.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { expect } from "vitest";
import worker, { replaceBackendForTesting, replaceKeyFetcherForTesting } from "../src/index.ts";
import { VAULT_NAME, type VaultEnv } from "../src/vault.ts";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export const TEAM_DOMAIN = "https://time-teste.cloudflareaccess.com";
export const AUD = "aud-teste";
export const URL_BASE = "https://zikaron.test";

/** O Client ID do service token de cada cliente da configuração de teste. */
export const IDS = {
  noah: "id-do-noah.access",
  alan: "id-do-alan.access",
  mac: "id-do-mac.access",
  kelpie: "id-do-kelpie.access",
} as const;
export type ClientName = keyof typeof IDS;

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jsonPart = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

let pair: CryptoKeyPair | undefined;

async function signingPair(): Promise<CryptoKeyPair> {
  pair ??= (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return pair;
}

/** Põe a chave pública do teste no lugar das chaves do time. `setup.ts` desfaz depois de cada teste. */
export async function useAccess(): Promise<void> {
  const jwk = (await crypto.subtle.exportKey("jwk", (await signingPair()).publicKey)) as JsonWebKey;
  replaceKeyFetcherForTesting(async (url) => {
    expect(url).toBe(`${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const key = { ...jwk, kid: "k1", kty: "RSA", alg: "RS256" };
    return { keys: [key] };
  });
}

/** Um JWT de service token do Access para um Client ID, válido agora. */
export async function tokenFor(clientId: string): Promise<string> {
  const seconds = Math.floor(Date.now() / 1000);
  const header = jsonPart({ alg: "RS256", kid: "k1", typ: "JWT" });
  const payload = jsonPart({
    type: "app",
    aud: [AUD],
    iss: TEAM_DOMAIN,
    iat: seconds - 10,
    exp: seconds + 3600,
    sub: "",
    common_name: clientId,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (await signingPair()).privateKey,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

/** Um pedido ao Worker, como o Access o entrega: com o JWT do cliente, ou sem nenhum. */
export async function send(
  client: ClientName | null,
  path: string,
  init: { method?: string; body?: string | undefined; headers?: Record<string, string> } = {},
  workerEnv: VaultEnv = env,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (client !== null) headers["Cf-Access-Jwt-Assertion"] = await tokenFor(IDS[client]);
  const request = new IncomingRequest(`${URL_BASE}${path}`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return worker.fetch(request, workerEnv);
}

/** Uma chamada a `/v1/<rota>`: o status e o corpo JSON. */
export async function v1(
  client: ClientName,
  route: string,
  body: unknown = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await send(client, `/v1/${route}`, { body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let rpcId = 0;

/** Uma mensagem JSON-RPC a `/mcp`. */
export async function mcp(
  client: ClientName,
  message: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await send(client, "/mcp", {
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    headers: { Accept: "application/json, text/event-stream" },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** Uma ferramenta pelo MCP: o texto do resultado e se ela falhou. */
export async function tool(
  client: ClientName,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  rpcId += 1;
  const { status, body } = await mcp(client, {
    id: rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(status).toBe(200);
  const result = body?.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
}

/** Um cofre de teste com estes arquivos, atrás do Worker. */
export function vaultWith(files: Record<string, string> = {}): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

/** Comita o que está na fila e sincroniza: o índice passa a ver as gravações. */
export async function flush(): Promise<void> {
  await runDurableObjectAlarm(env.VAULT.getByName(VAULT_NAME));
}

/** O stub do cofre que as rotas usam. */
export const vaultStub = () => env.VAULT.getByName(VAULT_NAME);
