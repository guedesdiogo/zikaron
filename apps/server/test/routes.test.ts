// The routes behind Access (ADR-0001 §1): identity, the `/v1/*` API and the MCP protocol.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES } from "../src/http.ts";
import { replaceBackendForTesting, replaceKeyFetcherForTesting } from "../src/index.ts";
import { PROTOCOL_VERSION, type TOOLS } from "../src/mcp.ts";
import { mcp, send, tool, useAccess, v1, vaultStub, vaultWith } from "./access.ts";

beforeEach(async () => {
  await useAccess();
  vaultWith();
});

describe("identity", () => {
  it("answers 401, without reading or writing, to a request with no JWT or from a client outside the configuration", async () => {
    for (const [method, path] of [
      ["POST", "/mcp"],
      ["GET", "/mcp"],
      ["POST", "/v1/search"],
      ["POST", "/v1/nada"],
      ["GET", "/"],
    ] as const) {
      const response = await send(null, path, {
        method,
        body: method === "GET" ? undefined : "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    // A body that claims to be another client changes nothing: only the credential chooses.
    const spoofed = await send(null, "/v1/search", {
      body: JSON.stringify({ query: "café", client: "alan" }),
      headers: { "X-Client": "alan", "Cf-Access-Authenticated-User-Email": "alan@example.com" },
    });
    expect(spoofed.status).toBe(401);
  });

  it("answers 500 with only a code when the client configuration isn't valid", async () => {
    for (const broken of ["", "{", JSON.stringify({ x: { name: "Noah" } })]) {
      const response = await send(
        "noah",
        "/v1/pending",
        { body: "{}" },
        {
          ...env,
          ZIKARON_CLIENTS: broken as "",
        },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "clients_config" });
    }
  });

  it("answers 503 when the Access keys don't come", async () => {
    replaceKeyFetcherForTesting(async () => {
      throw new Error("Access certs: 502");
    });
    const response = await send("noah", "/v1/pending", { body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("a client the vault doesn't know neither reads nor writes", async () => {
    const stub = vaultStub();
    expect(await stub.search("ninguem", "café")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await stub.readNote("ninguem", "memory/notes/a.md")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(
      await stub.writeNote(
        "ninguem",
        { channel: "tool", source: "agent" },
        { title: "A", body: "B", kind: "note" },
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });
    expect(await stub.forgetNote("ninguem", "memory/notes/a.md")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(
      await stub.archiveNote(
        "ninguem",
        { channel: "tool", source: "agent" },
        "memory/notes/a.md",
        "0123456789ab",
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });
    expect(await stub.pending("ninguem")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await stub.core("ninguem")).toEqual({ text: "", tokens: 0, paths: [], omitted: 0 });
    expect(await stub.recall("ninguem", "onde mora a Ana?")).toEqual({
      text: "",
      tokens: 0,
      paths: [],
    });
  });
});

describe("the /v1 API", () => {
  it("only accepts POST with a JSON object, on routes that exist", async () => {
    expect((await send("alan", "/v1/nada", { body: "{}" })).status).toBe(404);
    expect((await send("alan", "/", { method: "GET" })).status).toBe(404);
    const get = await send("alan", "/v1/search", { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    const broken = await send("alan", "/v1/search", { body: "{" });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ ok: false, reason: "invalid_json" });
    const list = await send("alan", "/v1/search", { body: "[]" });
    expect(list.status).toBe(400);
    const huge = await send("alan", "/v1/write", {
      body: JSON.stringify({ body: "x".repeat(MAX_REQUEST_BYTES) }),
    });
    expect(huge.status).toBe(413);
    const declared = await send("alan", "/v1/write", {
      body: "{}",
      headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
  });

  it.each([
    ["recall", {}, "`question` is required"],
    ["recall", { question: 1 }, "`question` must be a string"],
    ["core", { budgetTokens: "mil" }, "`budgetTokens` must be a number"],
    ["search", { query: "café", includeArchived: "sim" }, "`includeArchived` must be a boolean"],
    ["search", {}, "`query` is required"],
    ["read", { path: "memory/notes/a.md", offset: "0" }, "`offset` must be a number"],
    ["write", { title: "A", body: "B", kind: "note" }, "`source` is required"],
    ["write", { source: "dono", title: "A", body: "B", kind: "note" }, "`source` must be owner"],
    ["forget", {}, "`path` is required"],
    ["archive", { path: "memory/notes/a.md" }, "`version` is required"],
  ])("refuses, with 400, a %s with %j", async (route, body, problem) => {
    const { status, body: answer } = await v1("alan", route, body);
    expect(status).toBe(400);
    expect(answer.reason).toBe("invalid");
    expect((answer.problems as string[]).join("; ")).toContain(problem);
  });

  it("answers 503 with the memory off, and an empty block for the core and the recall", async () => {
    replaceBackendForTesting(null);
    expect(await v1("alan", "search", { query: "café" })).toEqual({
      status: 503,
      body: { ok: false, reason: "vault_off" },
    });
    for (const route of ["read", "forget"]) {
      expect((await v1("alan", route, { path: "memory/notes/a.md" })).status).toBe(503);
    }
    expect(
      (await v1("alan", "write", { source: "agent", title: "A", body: "B", kind: "note" })).status,
    ).toBe(503);
    expect(
      (await v1("alan", "archive", { path: "memory/notes/a.md", version: "0123456789ab" })).status,
    ).toBe(503);
    expect((await v1("alan", "pending")).status).toBe(503);
    expect((await v1("alan", "core")).body).toEqual({ text: "", tokens: 0, paths: [], omitted: 0 });
    expect((await v1("alan", "recall", { question: "onde mora a Ana?" })).body).toEqual({
      text: "",
      tokens: 0,
      paths: [],
    });
  });
});

describe("MCP", () => {
  it("initializes without state, with the protocol version and the tools", async () => {
    const init = await mcp("alan", {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
    });
    expect(init.status).toBe(200);
    expect(init.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "zikaron", version: expect.any(String) },
      },
    });
    const initialized = await mcp("alan", { method: "notifications/initialized" });
    expect(initialized).toEqual({ status: 202, body: null });
    expect(await mcp("alan", { id: "p", method: "ping" })).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: "p", result: {} },
    });
    const list = await mcp("alan", { id: 2, method: "tools/list" });
    const tools = (list.body?.result as { tools: typeof TOOLS } | undefined)?.tools ?? [];
    expect(tools.map((each) => each.name)).toEqual([
      "memory_search",
      "memory_read",
      "memory_write",
      "memory_forget",
      "memory_archive",
      "memory_pending",
    ]);
    for (const each of tools) {
      expect(each.inputSchema.type).toBe("object");
      expect(each.description.length).toBeGreaterThan(40);
    }
    // They all say the result is data, not instructions.
    for (const each of tools) {
      expect(each.description, each.name).toMatch(/nunca instruções/i);
    }
  });

  it("answers the JSON-RPC errors", async () => {
    const raw = async (body: string) => {
      const response = await send("alan", "/mcp", { body });
      return {
        status: response.status,
        body: (await response.json()) as { error: { code: number } },
      };
    };
    expect(await raw("{")).toEqual({
      status: 400,
      body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    });
    const batch = await raw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.status).toBe(400);
    expect(batch.body.error.code).toBe(-32600);
    for (const message of [
      { id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: 7 },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" },
      "texto",
    ]) {
      const answer = await raw(JSON.stringify(message));
      expect(answer.status, JSON.stringify(message)).toBe(400);
      expect(answer.body).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: expect.any(String) },
      });
    }
    expect(await mcp("alan", { id: 3, method: "resources/list" })).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } },
    });
    const unknown = await mcp("alan", {
      id: 4,
      method: "tools/call",
      params: { name: "shell", arguments: {} },
    });
    expect(unknown.body?.error).toEqual({ code: -32602, message: "Unknown tool" });
    const prototype = await mcp("alan", {
      id: 5,
      method: "tools/call",
      params: { name: "constructor" },
    });
    expect(prototype.body?.error).toEqual({ code: -32602, message: "Unknown tool" });
    // A client's response, and any notification, get no reply.
    expect(await mcp("alan", { id: 9, result: {} })).toEqual({ status: 202, body: null });
    expect(await mcp("alan", { method: "notifications/cancelled", params: {} })).toEqual({
      status: 202,
      body: null,
    });
    const huge = await send("alan", "/mcp", { body: "x".repeat(MAX_REQUEST_BYTES + 1) });
    expect(huge.status).toBe(413);
  });

  it("returns a tool's failure as isError, with a short text", async () => {
    const notObject = await mcp("alan", {
      id: 6,
      method: "tools/call",
      params: { name: "memory_search", arguments: "café" },
    });
    expect(notObject.body?.result).toEqual({
      content: [{ type: "text", text: "Recusada (invalid): `arguments` must be an object" }],
      isError: true,
    });
    for (const [name, args, problem] of [
      ["memory_search", {}, "`query` is required"],
      ["memory_read", { path: 3 }, "`path` must be a string"],
      ["memory_write", { title: "A", body: "B", kind: "note" }, "`source` is required"],
      ["memory_forget", {}, "`path` is required"],
      ["memory_archive", { path: "memory/notes/a.md" }, "`version` is required"],
    ] as const) {
      const result = await tool("alan", name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text).toContain(problem);
    }
    replaceBackendForTesting(null);
    for (const [name, args] of [
      ["memory_search", { query: "café" }],
      ["memory_read", { path: "memory/notes/a.md" }],
      ["memory_write", { title: "A", body: "B", kind: "note", source: "agent" }],
      ["memory_forget", { path: "memory/notes/a.md" }],
      ["memory_archive", { path: "memory/notes/a.md", version: "0123456789ab" }],
      ["memory_pending", {}],
    ] as const) {
      expect(await tool("alan", name, args)).toEqual({
        text: "Recusada (vault_off): A memória está desligada.",
        isError: true,
      });
    }
  });
});
