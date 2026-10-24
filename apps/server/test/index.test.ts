import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it } from "vitest";
import worker, { MAX_WEBHOOK_BYTES, replaceBackendForTesting } from "../src/index.ts";
import { VAULT_NAME, type VaultEnv } from "../src/vault.ts";

/** Um pedido como o Worker o recebe, com as propriedades `cf` do Cloudflare. */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SECRET = "webhook-secret-for-tests";
const URL_BASE = "https://zikaron.test";

async function signed(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Uma entrega do webhook do GitHub; `signature` nula deixa o cabeçalho de fora. */
function delivery(event: string | null, signature: string | null, body: string) {
  const headers = new Headers();
  if (event !== null) headers.set("X-GitHub-Event", event);
  if (signature !== null) headers.set("X-Hub-Signature-256", signature);
  return new IncomingRequest(`${URL_BASE}/webhooks/github`, { method: "POST", headers, body });
}

const stub = () => env.VAULT.getByName(VAULT_NAME);
const alarmAt = () => runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());

/** Um cofre configurado, sincronizado uma vez, cujo próximo alarme é a reconciliação, a minutos. */
async function syncedVault(): Promise<number> {
  replaceBackendForTesting(new FakeVaultBackend({ "README.md": "# Vault" }));
  await stub().read("README.md");
  const reconcile = (await alarmAt()) ?? 0;
  expect(reconcile - Date.now()).toBeGreaterThan(60_000);
  return reconcile;
}

const push = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), commits: [] });

describe("the Worker's webhook route", () => {
  it("answers 401, and syncs nothing, for a bad or missing signature or a missing secret", async () => {
    const reconcile = await syncedVault();
    for (const signature of [null, "sha256=00", await signed(push, "another-secret")]) {
      const response = await worker.fetch(delivery("push", signature, push), env);
      expect(response.status, String(signature)).toBe(401);
    }
    // Um corpo mudado depois de assinado.
    const tampered = await worker.fetch(delivery("push", await signed(push), `${push} `), env);
    expect(tampered.status).toBe(401);
    // Sem o segredo, nenhuma assinatura confere.
    const { GITHUB_WEBHOOK_SECRET: _secret, ...unset } = env as VaultEnv;
    const missing = await worker.fetch(delivery("push", await signed(push), push), unset);
    expect(missing.status).toBe(401);
    expect(await alarmAt()).toBe(reconcile);
  });

  it("answers a ping with 200", async () => {
    const ping = "{}";
    const response = await worker.fetch(delivery("ping", await signed(ping), ping), env);
    expect(response.status).toBe(200);
  });

  it("asks the vault to sync on a signed push, with 202", async () => {
    await syncedVault();
    const response = await worker.fetch(delivery("push", await signed(push), push), env);
    expect(response.status).toBe(202);
    // A sincronização vem a um segundo, no máximo.
    expect(((await alarmAt()) ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThanOrEqual(1_000);
  });

  it("ignores other events, and pushes it can't read, with 202 and no sync", async () => {
    const reconcile = await syncedVault();
    const issue = JSON.stringify({ action: "opened" });
    for (const event of ["issues", null]) {
      const response = await worker.fetch(delivery(event, await signed(issue), issue), env);
      expect(response.status).toBe(202);
    }
    const tag = JSON.stringify({ ref: "refs/tags/v1", after: "a".repeat(40) });
    expect((await worker.fetch(delivery("push", await signed(tag), tag), env)).status).toBe(202);
    expect(await alarmAt()).toBe(reconcile);
  });

  it("answers 400 to a signed push whose body isn't JSON", async () => {
    const body = "not json";
    const response = await worker.fetch(delivery("push", await signed(body), body), env);
    expect(response.status).toBe(400);
  });

  it("leaves any other method or path to the Access identity, which a request without it fails", async () => {
    for (const request of [
      new IncomingRequest(`${URL_BASE}/webhooks/github`),
      new IncomingRequest(`${URL_BASE}/webhooks/github`, { method: "PUT", body: push }),
      new IncomingRequest(`${URL_BASE}/`),
      new IncomingRequest(`${URL_BASE}/webhooks/github/x`, { method: "POST", body: push }),
      new IncomingRequest(`${URL_BASE}/v1/read`, { method: "POST", body: "{}" }),
    ]) {
      const response = await worker.fetch(request, env);
      expect(response.status, `${request.method} ${request.url}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});

describe("o limite do corpo do webhook", () => {
  it("recusa um corpo grande demais antes de conferir a assinatura", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const declared = new IncomingRequest(`${URL_BASE}/webhooks/github`, {
      method: "POST",
      headers: { "X-GitHub-Event": "push", "Content-Length": String(big.length) },
      body: big,
    });
    expect((await worker.fetch(declared, env as VaultEnv)).status).toBe(413);
    // Sem Content-Length, a leitura para no limite.
    const streamed = delivery("push", await signed(big), big);
    streamed.headers.delete("Content-Length");
    expect((await worker.fetch(streamed, env as VaultEnv)).status).toBe(413);
  });
});
