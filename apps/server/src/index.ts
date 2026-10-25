import { parsePushEvent, verifyWebhookSignature } from "@zikaron/vault";
import { handleApi } from "./api.ts";
import { json, readUpTo } from "./http.ts";
import { type Client, type Clients, clientOf, type KeyFetcher, parseClients } from "./identity.ts";
import { handleMcp } from "./mcp.ts";
import { VAULT_NAME, type VaultEnv } from "./vault.ts";

export { replaceBackendForTesting, Vault } from "./vault.ts";

/** The GitHub webhook, outside Access, checked by the HMAC of the webhook secret (ADR-0001 §1). */
const WEBHOOK_PATH = "/webhooks/github";
/**
 * The deploy check, also outside Access: it tells only the published environment and commit, which
 * the deploy passes as `--var`, without reading the configuration or the vault.
 */
const HEALTH_PATH = "/health";
const API_PREFIX = "/v1/";

let fetcherForTesting: KeyFetcher | undefined;

/** Tests swap the Access key fetch for this one. Production never calls it. */
export function replaceKeyFetcherForTesting(fetcher: KeyFetcher | undefined): void {
  fetcherForTesting = fetcher;
}

/** An error's name for the logs, never its message. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * The largest body the webhook reads before checking the signature: GitHub caps deliveries at
 * 25 MB, and a vault push stays far below that.
 */
export const MAX_WEBHOOK_BYTES = 5_000_000;

/**
 * Receives a GitHub webhook delivery. Without a secret, or with the signature missing or wrong, it
 * answers 401 and syncs nothing. A `ping` answers 200; a `push` only requests the sync, reading or
 * writing nothing from the body beyond the ref; other events are ignored with 202.
 */
async function receiveWebhook(request: Request, env: VaultEnv): Promise<Response> {
  // The size is checked before the signature: whoever lacks the secret can't make the Worker read
  // megabytes. A declared `Content-Length` refuses up front; without it, reading stops at the cap.
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
 * The request's client by its credential (ADR-0001 §1), or the response that refuses it: 500 with a
 * code when the clients' configuration is invalid, 401 without a valid JWT from one of its clients,
 * 503 when the Access keys don't arrive.
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
    // Everything else goes through Access: the credential picks the client, never the request.
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
