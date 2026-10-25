import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeVaultBackend } from "@zikaron/vault/fake";
import { describe, expect, it } from "vitest";
import worker, { MAX_WEBHOOK_BYTES, replaceBackendForTesting } from "../src/index.ts";
import { VAULT_NAME, type VaultEnv } from "../src/vault.ts";

/** A request as the Worker receives it, with Cloudflare's `cf` properties. */
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

/** A GitHub webhook delivery; a null `signature` leaves the header out. */
function delivery(event: string | null, signature: string | null, body: string) {
  const headers = new Headers();
  if (event !== null) headers.set("X-GitHub-Event", event);
  if (signature !== null) headers.set("X-Hub-Signature-256", signature);
  return new IncomingRequest(`${URL_BASE}/webhooks/github`, { method: "POST", headers, body });
}

const stub = () => env.VAULT.getByName(VAULT_NAME);
const alarmAt = () => runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());

/** A configured vault, synced once, whose next alarm is the reconciliation, minutes away. */
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
    // A body changed after it was signed.
    const tampered = await worker.fetch(delivery("push", await signed(push), `${push} `), env);
    expect(tampered.status).toBe(401);
    // Without the secret, no signature matches.
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
    // The sync comes within a second, at most.
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

describe("the /health route", () => {
  const health = (method = "GET", path = "/health") =>
    new IncomingRequest(`${URL_BASE}${path}`, method === "GET" ? {} : { method, body: "{}" });

  it("answers, with no credential, only the status and the deployed environment and commit", async () => {
    // Outside a deploy, both come empty from wrangler.jsonc.
    const local = await worker.fetch(health(), env);
    expect(local.status).toBe(200);
    expect(local.headers.get("Content-Type")).toContain("application/json");
    expect(await local.json()).toStrictEqual({ status: "ok", environment: "", commit: "" });

    const commit = "b".repeat(40);
    const deployed = { ...env, ZIKARON_ENV: "producao" as "", ZIKARON_COMMIT: commit as "" };
    const response = await worker.fetch(health(), deployed);
    expect(await response.json()).toStrictEqual({
      status: "ok",
      environment: "producao",
      commit,
    });
  });

  it("reads neither the client configuration, nor Access, nor the vault", async () => {
    const { VAULT: _vault, ...rest } = env as VaultEnv;
    const broken = {
      ...rest,
      ZIKARON_CLIENTS: "{",
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_AUD: "",
    } as unknown as VaultEnv;
    const response = await worker.fetch(health(), broken);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "ok", environment: "", commit: "" });
  });

  it("leaves other methods and look-alike paths to Access, which refuses them without a credential", async () => {
    for (const request of [
      health("POST"),
      health("PUT"),
      health("GET", "/health/"),
      health("GET", "/health/x"),
      health("GET", "/healthz"),
      health("GET", "/v1/health"),
    ]) {
      const response = await worker.fetch(request, env);
      expect(response.status, `${request.method} ${request.url}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });
});

describe("the webhook body limit", () => {
  it("refuses a body that is too big before checking the signature", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const declared = new IncomingRequest(`${URL_BASE}/webhooks/github`, {
      method: "POST",
      headers: { "X-GitHub-Event": "push", "Content-Length": String(big.length) },
      body: big,
    });
    expect((await worker.fetch(declared, env as VaultEnv)).status).toBe(413);
    // Without Content-Length, reading stops at the limit.
    const streamed = delivery("push", await signed(big), big);
    streamed.headers.delete("Content-Length");
    expect((await worker.fetch(streamed, env as VaultEnv)).status).toBe(413);
  });
});
