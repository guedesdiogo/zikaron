// O que as rotas do Worker compartilham: o corpo JSON de um pedido, com teto, e as respostas JSON.

/** O maior corpo que uma rota lê: uma nota tem 1 MiB no máximo, e o pedido leva a nota e pouco mais. */
export const MAX_REQUEST_BYTES = 1_100_000;

/** Uma resposta JSON. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

/** O corpo de um pedido como JSON, ou o porquê de não ser: grande demais, ou JSON que não vale. */
export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "invalid_json" }> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) return { ok: false, reason: "too_large" };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** Um objeto JSON (não lista, não nulo). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
