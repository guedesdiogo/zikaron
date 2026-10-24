// A API HTTP pequena (`/v1/*`), pelo canal do provedor (ADR-0001 §2): o que o provedor de memória do
// Hermes chama. O `system_prompt_block` pede o núcleo, o `prefetch` o recall, e as gravações levam o
// `context` e a evidência. JSON entra e sai; docs/api.md é o contrato escrito.

import { isObject, json, readJson } from "./http.ts";
import type { Client } from "./identity.ts";
import type { MemoryWriteInput, NoteClaim } from "./notes.ts";
import type { Vault } from "./vault.ts";

type VaultStub = DurableObjectStub<Vault>;
type Body = Record<string, unknown>;

/** O status HTTP de uma resposta do cofre: as recusas da regra são respostas, com 200. */
const STATUS: Record<string, number> = {
  invalid: 400,
  unauthorized: 401,
  too_large: 413,
  vault_off: 503,
  unavailable: 503,
};

function answer(result: { ok: boolean; reason?: string }): Response {
  return json(result.ok ? 200 : (STATUS[result.reason ?? ""] ?? 200), result);
}

const invalid = (...problems: string[]) => json(400, { ok: false, reason: "invalid", problems });

/** Os problemas de tipo dos campos de um pedido; o cofre confere o resto. */
function fieldProblems(
  body: Body,
  fields: Record<string, "string" | "number" | "boolean">,
  required: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  for (const [key, type] of Object.entries(fields)) {
    const value = body[key];
    if (value === undefined || value === null) {
      if (required.includes(key)) problems.push(`\`${key}\` is required`);
      continue;
    }
    if (typeof value !== type) problems.push(`\`${key}\` must be a ${type}`);
  }
  return problems;
}

/** O claim de uma gravação pelo provedor: o canal é da rota; `source`, do pedido. */
function claimOf(body: Body, fallback?: string): NoteClaim {
  return {
    channel: "provider",
    source: (body.source ?? fallback) as NoteClaim["source"],
    ...(typeof body.evidence === "string" ? { evidence: body.evidence } : {}),
    ...(typeof body.context === "string" ? { context: body.context } : {}),
  };
}

const CLAIM_FIELDS = { source: "string", evidence: "string", context: "string" } as const;

const ROUTES: Record<string, (body: Body, vault: VaultStub, client: string) => Promise<Response>> =
  {
    async core(body, vault, client) {
      const problems = fieldProblems(body, { budgetTokens: "number" });
      if (problems.length > 0) return invalid(...problems);
      return json(200, await vault.core(client, body.budgetTokens as number | undefined));
    },
    async recall(body, vault, client) {
      const problems = fieldProblems(
        body,
        { question: "string", budgetTokens: "number", includeArchived: "boolean" },
        ["question"],
      );
      if (problems.length > 0) return invalid(...problems);
      return json(
        200,
        await vault.recall(client, body.question as string, {
          budgetTokens: body.budgetTokens as number | undefined,
          includeArchived: body.includeArchived as boolean | undefined,
        }),
      );
    },
    async search(body, vault, client) {
      const problems = fieldProblems(
        body,
        { query: "string", k: "number", includeArchived: "boolean" },
        ["query"],
      );
      if (problems.length > 0) return invalid(...problems);
      return answer(
        await vault.search(client, body.query as string, {
          k: body.k as number | undefined,
          includeArchived: body.includeArchived as boolean | undefined,
        }),
      );
    },
    async read(body, vault, client) {
      const problems = fieldProblems(body, { path: "string", offset: "number" }, ["path"]);
      if (problems.length > 0) return invalid(...problems);
      return answer(
        await vault.readNote(client, body.path as string, {
          offset: body.offset as number | undefined,
        }),
      );
    },
    async write(body, vault, client) {
      const problems = fieldProblems(body, CLAIM_FIELDS, ["source"]);
      if (problems.length > 0) return invalid(...problems);
      const { source: _source, evidence: _evidence, context: _context, ...memory } = body;
      return answer(
        await vault.writeNote(client, claimOf(body), memory as unknown as MemoryWriteInput),
      );
    },
    async forget(body, vault, client) {
      const problems = fieldProblems(body, { path: "string" }, ["path"]);
      if (problems.length > 0) return invalid(...problems);
      return answer(await vault.forgetNote(client, body.path as string));
    },
    async archive(body, vault, client) {
      const problems = fieldProblems(body, { path: "string", version: "string", ...CLAIM_FIELDS }, [
        "path",
        "version",
      ]);
      if (problems.length > 0) return invalid(...problems);
      return answer(
        await vault.archiveNote(
          client,
          claimOf(body, "agent"),
          body.path as string,
          body.version as string,
        ),
      );
    },
    async pending(_body, vault, client) {
      return answer(await vault.pending(client));
    },
  };

/** Uma rota `/v1/<nome>`: só POST, com um objeto JSON no corpo. */
export async function handleApi(
  request: Request,
  name: string,
  vault: VaultStub,
  client: Client,
): Promise<Response> {
  const route = Object.hasOwn(ROUTES, name) ? ROUTES[name] : undefined;
  if (route === undefined) return json(404, { error: "not_found" });
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
  }
  const body = await readJson(request);
  if (!body.ok) {
    return json(body.reason === "too_large" ? 413 : 400, { ok: false, reason: body.reason });
  }
  if (!isObject(body.value)) return invalid("the body must be a JSON object");
  return route(body.value, vault, client.name);
}
