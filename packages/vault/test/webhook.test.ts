import { describe, expect, it } from "vitest";
import { FakeVaultBackend } from "../src/fake.ts";
import { parsePushEvent, verifyWebhookSignature } from "../src/index.ts";

async function sign(secret: string, body: string): Promise<string> {
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

describe("verifyWebhookSignature", () => {
  it("matches GitHub's documented example", async () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    expect(
      await verifyWebhookSignature(
        "It's a Secret to Everybody",
        "Hello, World!",
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      ),
    ).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a malformed header and an empty secret", async () => {
    const header = await sign("secret", "{}");
    expect(await verifyWebhookSignature("secret", "{}", header)).toBe(true);
    expect(await verifyWebhookSignature("other", "{}", header)).toBe(false);
    expect(await verifyWebhookSignature("secret", "{ }", header)).toBe(false);
    expect(await verifyWebhookSignature("secret", "{}", header.replace("sha256=", "sha1="))).toBe(
      false,
    );
    expect(await verifyWebhookSignature("secret", "{}", "sha256=zz")).toBe(false);
    expect(await verifyWebhookSignature("secret", "{}", null)).toBe(false);
    expect(await verifyWebhookSignature("", "{}", header)).toBe(false);
  });
});

describe("parsePushEvent", () => {
  it("reads a branch push and nothing else", () => {
    const after = "f".repeat(40);
    expect(parsePushEvent({ ref: "refs/heads/main", after, commits: [] })).toEqual({
      ref: "refs/heads/main",
      after,
    });
    expect(parsePushEvent({ ref: "refs/tags/v1", after })).toBeNull();
    expect(parsePushEvent({ ref: "refs/heads/main", after: "nope" })).toBeNull();
    expect(parsePushEvent({ zen: "Keep it logically awesome." })).toBeNull();
    expect(parsePushEvent(null)).toBeNull();
  });
});

describe("FakeVaultBackend", () => {
  it("behaves like the repository the Context Store expects", async () => {
    const vault = new FakeVaultBackend({ "AGENTS.md": "# Rules", ".obsidian/x.md": "x" });
    const first = (await vault.branchHead("main")) ?? "";
    expect((await vault.snapshot(first)).files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    const pushed = vault.push({ "knowledge/a.md": "# A", "AGENTS.md": null });
    expect((await vault.diff(first, pushed))?.changes.map((c) => [c.path, c.content])).toEqual([
      ["AGENTS.md", null],
      ["knowledge/a.md", "# A"],
    ]);
    expect(await vault.diff(pushed, first)).toBeNull();
    const stale = await vault.commit({
      branch: "main",
      expectedHead: first,
      headline: "x",
      writes: [],
      deletions: [],
    });
    expect(stale).toEqual({ kind: "stale" });
    const done = await vault.commit({
      branch: "main",
      expectedHead: pushed,
      headline: "x",
      writes: [{ path: "knowledge/b.md", content: "# B" }],
      deletions: [],
    });
    expect(done.kind).toBe("committed");
    expect(vault.files()).toEqual({
      ".obsidian/x.md": "x",
      "knowledge/a.md": "# A",
      "knowledge/b.md": "# B",
    });
  });
});
