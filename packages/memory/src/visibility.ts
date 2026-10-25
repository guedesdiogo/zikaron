// Who reads what (ADR-0001 §3 and §5). A version's trust is computed at read time, from the
// `origin` block, from who wrote the blob (`authored_blobs`) and from the clients' current
// settings, so that turning off a client's `ownerClaims` takes effect at once, without rewriting
// the vault. Everything here becomes SQL over `v`, a row of `versions`, and every comparison
// accepts NULL without turning NULL.
import type { SqlValue } from "./memory-index.ts";

export const READER_MODES = ["exposed", "privileged", "plain"] as const;
/**
 * `exposed`: reads outside content and gets everything. `privileged`: acts with the owner's
 * authority and never gets a tainted note. `plain`: gets what counts as the owner's, its own notes,
 * and those of clients that aren't `exposed`.
 */
export type ReaderMode = (typeof READER_MODES)[number];

export interface ReaderPolicy {
  /** The client that reads. */
  client: string;
  mode: ReaderMode;
  /**
   * The configured clients that don't read outside content. It is an allowlist: a client that left
   * the configuration, or was never in it, counts as `exposed`, so that taking a compromised client
   * out of the configuration doesn't clear the mark on its notes.
   */
  trusted: readonly string[];
  /** The clients whose "the owner said", through the provider, counts as the owner's. */
  ownerClaims: readonly string[];
}

/** The server wrote the version's blob. */
const AUTHORED = "EXISTS (SELECT 1 FROM authored_blobs a WHERE a.blob_sha = v.blob_sha)";

/**
 * Counts as the owner's: a blob the server didn't write, that doesn't wait for the "yes" and whose
 * `origin`, if it had one, could be read; or a server blob with `source: owner` through the
 * provider, from a client with `ownerClaims`, neither pending nor with inherited taint.
 */
export function ownerGradeSql(policy: ReaderPolicy): [string, SqlValue[]] {
  return [
    `((NOT ${AUTHORED} AND v.origin_review IS NULL AND v.origin_invalid = 0)
      OR (${AUTHORED} AND v.origin_source IS 'owner' AND v.origin_channel IS 'provider'
          AND v.origin_review IS NULL AND v.origin_taint IS NULL
          AND coalesce(v.origin_client, '') IN (SELECT value FROM json_each(?))))`,
    [JSON.stringify(policy.ownerClaims)],
  ];
}

/**
 * Tainted: doesn't count as the owner's and came from outside, or inherited the mark, or has an
 * `origin` that couldn't be read, or was written by a client outside the trusted list. When in
 * doubt, it stays out: a server blob without `origin` counts too.
 */
export function taintedSql(policy: ReaderPolicy): [string, SqlValue[]] {
  const [owner, bindings] = ownerGradeSql(policy);
  return [
    `(NOT ${owner} AND (v.origin_source IS 'external' OR v.origin_taint IS 'inherited'
      OR v.origin_invalid = 1
      OR (${AUTHORED} AND v.origin_client IS NULL)
      OR (v.origin_client IS NOT NULL
          AND v.origin_client NOT IN (SELECT value FROM json_each(?)))))`,
    [...bindings, JSON.stringify(policy.trusted)],
  ];
}

/** The versions the reader sees, as SQL over `v`. */
export function visibleSql(policy: ReaderPolicy): [string, SqlValue[]] {
  if (policy.mode === "exposed") return ["1", []];
  if (policy.mode === "privileged") {
    const [tainted, bindings] = taintedSql(policy);
    return [`NOT ${tainted}`, bindings];
  }
  const [owner, bindings] = ownerGradeSql(policy);
  return [
    `(${owner} OR (v.origin_invalid = 0 AND v.origin_client IS ?)
      OR (v.origin_invalid = 0 AND v.origin_client IN (SELECT value FROM json_each(?))))`,
    [...bindings, policy.client, JSON.stringify(policy.trusted)],
  ];
}
