// Quem lê o quê (ADR-0001 §3 e §5). A confiança de uma versão é calculada na leitura, a partir do
// bloco `origin`, de quem escreveu o blob (`authored_blobs`) e da configuração atual dos clientes,
// para que desligar o `ownerClaims` de um cliente valha na hora, sem reescrever o cofre. Tudo aqui
// vira SQL sobre `v`, uma linha de `versions`, e toda comparação aceita NULL sem virar NULL.
import type { SqlValue } from "./memory-index.ts";

export const READER_MODES = ["exposed", "privileged", "plain"] as const;
/**
 * `exposed`: lê conteúdo de fora e recebe tudo. `privileged`: age com a autoridade do dono e nunca
 * recebe nota contaminada. `plain`: recebe o que vale como do dono, as próprias e as de quem não é
 * `exposed`.
 */
export type ReaderMode = (typeof READER_MODES)[number];

export interface ReaderPolicy {
  /** O cliente que lê. */
  client: string;
  mode: ReaderMode;
  /** Os clientes que leem conteúdo de fora. */
  exposed: readonly string[];
  /** Os clientes cujo «o dono disse», pelo provedor, vale como do dono. */
  ownerClaims: readonly string[];
}

/** O blob da versão foi escrito pelo servidor. */
const AUTHORED = "EXISTS (SELECT 1 FROM authored_blobs a WHERE a.blob_sha = v.blob_sha)";

/**
 * Vale como do dono: um blob que o servidor não escreveu e que não espera o «sim»; ou um blob do
 * servidor com `source: owner` pelo provedor, de um cliente com `ownerClaims`, sem pendência nem
 * contaminação herdada.
 */
export function ownerGradeSql(policy: ReaderPolicy): [string, SqlValue[]] {
  return [
    `((NOT ${AUTHORED} AND v.origin_review IS NULL)
      OR (${AUTHORED} AND v.origin_source IS 'owner' AND v.origin_channel IS 'provider'
          AND v.origin_review IS NULL AND v.origin_taint IS NULL
          AND coalesce(v.origin_client, '') IN (SELECT value FROM json_each(?))))`,
    [JSON.stringify(policy.ownerClaims)],
  ];
}

/**
 * Contaminada: não vale como do dono e veio de fora, ou foi gravada por um cliente `exposed`, ou
 * herdou a marca. Um blob do servidor sem `origin` também conta: na dúvida, fica de fora.
 */
export function taintedSql(policy: ReaderPolicy): [string, SqlValue[]] {
  const [owner, bindings] = ownerGradeSql(policy);
  return [
    `(NOT ${owner} AND (v.origin_source IS 'external' OR v.origin_taint IS 'inherited'
      OR coalesce(v.origin_client, '') IN (SELECT value FROM json_each(?))
      OR (${AUTHORED} AND v.origin_client IS NULL)))`,
    [...bindings, JSON.stringify(policy.exposed)],
  ];
}

/** As versões que o leitor vê, como SQL sobre `v`. */
export function visibleSql(policy: ReaderPolicy): [string, SqlValue[]] {
  if (policy.mode === "exposed") return ["1", []];
  if (policy.mode === "privileged") {
    const [tainted, bindings] = taintedSql(policy);
    return [`NOT ${tainted}`, bindings];
  }
  const [owner, bindings] = ownerGradeSql(policy);
  return [
    `(${owner} OR v.origin_client IS ?
      OR (v.origin_client IS NOT NULL
          AND v.origin_client NOT IN (SELECT value FROM json_each(?))))`,
    [...bindings, policy.client, JSON.stringify(policy.exposed)],
  ];
}
