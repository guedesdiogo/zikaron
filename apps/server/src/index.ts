import { parsePushEvent, verifyWebhookSignature } from "@zikaron/vault";
import { VAULT_NAME, type VaultEnv } from "./vault.ts";

export { replaceBackendForTesting, Vault } from "./vault.ts";

/** O webhook do GitHub, fora do Access, conferido pelo HMAC do segredo do webhook (ADR-0001 §1). */
const WEBHOOK_PATH = "/webhooks/github";

/**
 * Recebe uma entrega do webhook do GitHub. Sem segredo, ou com a assinatura ausente ou errada,
 * responde 401 e não sincroniza nada. Um `ping` responde 200; um `push` só pede a sincronização,
 * sem ler nem gravar nada do corpo além do ref; os outros eventos são ignorados com 202.
 */
async function receiveWebhook(request: Request, env: VaultEnv): Promise<Response> {
  const body = await request.text();
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === WEBHOOK_PATH) return receiveWebhook(request, env);
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<VaultEnv>;
