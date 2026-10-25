import { parsePushEvent, verifyWebhookSignature } from "@zikaron/vault";
import { handleApi } from "./api.ts";
import { json, readUpTo } from "./http.ts";
import { type Client, type Clients, clientOf, type KeyFetcher, parseClients } from "./identity.ts";
import { handleMcp } from "./mcp.ts";
import { VAULT_NAME, type VaultEnv } from "./vault.ts";

export { replaceBackendForTesting, Vault } from "./vault.ts";

/** O webhook do GitHub, fora do Access, conferido pelo HMAC do segredo do webhook (ADR-0001 §1). */
const WEBHOOK_PATH = "/webhooks/github";
/**
 * A conferência do deploy, também fora do Access: diz só o ambiente e o commit publicados, que o
 * deploy passa como `--var`, sem ler a configuração nem o cofre.
 */
const HEALTH_PATH = "/health";
const API_PREFIX = "/v1/";

let fetcherForTesting: KeyFetcher | undefined;

/** Os testes trocam a busca das chaves do Access por esta. A produção nunca a chama. */
export function replaceKeyFetcherForTesting(fetcher: KeyFetcher | undefined): void {
  fetcherForTesting = fetcher;
}

/** O nome de um erro para os logs, nunca a mensagem. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * O maior corpo que o webhook lê antes de conferir a assinatura: o GitHub limita as entregas a
 * 25 MB, e um push do cofre fica muito abaixo disso.
 */
export const MAX_WEBHOOK_BYTES = 5_000_000;

/**
 * Recebe uma entrega do webhook do GitHub. Sem segredo, ou com a assinatura ausente ou errada,
 * responde 401 e não sincroniza nada. Um `ping` responde 200; um `push` só pede a sincronização,
 * sem ler nem gravar nada do corpo além do ref; os outros eventos são ignorados com 202.
 */
async function receiveWebhook(request: Request, env: VaultEnv): Promise<Response> {
  // O tamanho é conferido antes da assinatura: quem não tem o segredo não faz o Worker ler
  // megabytes. O `Content-Length` declarado barra antes de ler; sem ele, a leitura para no limite.
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  const body = await readUpTo(request, MAX_WEBHOOK_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  const verified = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET ?? "",
    body,
    request.headers.get("X-Hub-Signature-256"),
  );
  if (!verified) return new Response(null, { status: 401 });
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response(null, { status: 200 });
  if (event !== "push") return new Response(null, { status: 202 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const push = parsePushEvent(payload);
  if (push) await env.VAULT.getByName(VAULT_NAME).requestSync(push.ref);
  return new Response(null, { status: 202 });
}

/**
 * O cliente do pedido pela credencial (ADR-0001 §1), ou a resposta que o recusa: 500 com um código
 * quando a configuração dos clientes não vale, 401 sem um JWT válido de um cliente dela, 503 quando
 * as chaves do Access não vêm.
 */
async function authenticate(request: Request, env: VaultEnv): Promise<Client | Response> {
  let clients: Clients;
  try {
    clients = parseClients(env.ZIKARON_CLIENTS);
  } catch {
    console.error("Zikaron: ZIKARON_CLIENTS is invalid");
    return json(500, { error: "clients_config" });
  }
  try {
    const client = await clientOf(
      request,
      { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD },
      clients,
      fetcherForTesting === undefined ? {} : { fetcher: fetcherForTesting },
    );
    return client ?? json(401, { error: "unauthorized" });
  } catch (error) {
    console.error("Zikaron: the Access keys couldn't be read", errorName(error));
    return json(503, { error: "unavailable" });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === WEBHOOK_PATH) return receiveWebhook(request, env);
    if (request.method === "GET" && pathname === HEALTH_PATH) {
      return json(200, { status: "ok", environment: env.ZIKARON_ENV, commit: env.ZIKARON_COMMIT });
    }
    // Tudo o mais passa pelo Access: a credencial escolhe o cliente, nunca o pedido.
    const client = await authenticate(request, env);
    if (client instanceof Response) return client;
    const vault = env.VAULT.getByName(VAULT_NAME);
    if (pathname === "/mcp") {
      if (request.method !== "POST") {
        return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
      }
      return handleMcp(request, vault, client);
    }
    if (pathname.startsWith(API_PREFIX)) {
      return handleApi(request, pathname.slice(API_PREFIX.length), vault, client);
    }
    return json(404, { error: "not_found" });
  },
} satisfies ExportedHandler<VaultEnv>;
