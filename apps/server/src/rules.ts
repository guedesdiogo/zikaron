// The write rule (ADR-0001 §4), applied by the server and not by the persona: the channel caps what
// a write claims to be, and the previous version decides whether it can be replaced. Pure
// functions: the writer passes the current version and its trust, and gets `origin` and `level`.
import type { Channel, Level, Origin, Source } from "@zikaron/memory";
import type { Client } from "./identity.ts";

/** What the request says about a write; the server limits each field by the channel. */
export interface WriteClaim {
  channel: Channel;
  source: Source;
  /** The owner's message id, or the source's reference; one line. */
  evidence?: string;
  /** `cron` when the writer is a scheduled routine, which never writes (Q3). */
  context?: string;
  /** An agent never pins a note: `pinned` only comes from the vault. */
  pinned?: boolean;
}

/** The path's current version, when the write replaces it. */
export interface Previous {
  /** From the index (`MemoryIndex.trust`), with the clients' current configuration. */
  ownerGrade: boolean;
  tainted: boolean;
  archived: boolean;
  /** The core loads it: pinned in the global scope or an agent's, or in `profile/` (#168). */
  inCore: boolean;
  /** It waits for the owner's "yes". */
  pending: boolean;
  /** The client that wrote it, when the server did. */
  client: string | null;
}

export type WriteRefusal =
  | "cron"
  | "pinned"
  | "owners_note"
  | "core_note"
  | "archived"
  | "not_found";

export type WriteDecision =
  | { ok: true; origin: Origin; level: Level }
  | { ok: false; reason: WriteRefusal };

/** One line of evidence: no breaks, controls or bidirectional marks, up to 300 characters. */
function evidenceLine(value: string | undefined): string | null {
  if (value === undefined) return null;
  const line = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .trim();
  return line === "" ? null : line;
}

/**
 * Decides the `origin` and `level` of a new version, or the refusal:
 * - a scheduled routine doesn't write, and no agent pins a note;
 * - through the tool channel, nothing is `owner` or `explicit`;
 * - `agent` and `external` come in with `review: pending` and `level: inferred`, until the "yes";
 * - for a `privileged` client, a tainted note answers as nonexistent;
 * - no write replaces an archived note or a core note;
 * - an owner-grade note is replaced only by the owner's word, that is, `source: owner` through
 *   the provider of a client with `ownerClaims` (Q6's "correct it", ADR-0003);
 * - over a tainted version, the new one inherits the mark (`taint: inherited`).
 */
export function decideWrite(
  client: Client,
  claim: WriteClaim,
  previous: Previous | null,
): WriteDecision {
  if (claim.context === "cron") return { ok: false, reason: "cron" };
  if (claim.pinned === true) return { ok: false, reason: "pinned" };
  // The ceiling is an allowlist: only the provider can say the owner said it.
  const source: Source =
    claim.channel !== "provider" && claim.source === "owner" ? "agent" : claim.source;
  const ownersWord = source === "owner" && claim.channel === "provider" && client.ownerClaims;
  if (previous !== null) {
    // For a `privileged` client, the tainted note doesn't exist: not to read, not to write.
    if (client.privileged && previous.tainted) return { ok: false, reason: "not_found" };
    if (previous.archived) return { ok: false, reason: "archived" };
    if (previous.inCore) return { ok: false, reason: "core_note" };
    if (previous.ownerGrade && !ownersWord) return { ok: false, reason: "owners_note" };
  }
  // Only the owner's word that counts as the owner's goes straight in. That of a client without
  // `ownerClaims` stays pending and inferred, like a conclusion, until the "yes" in the vault (Q3).
  return {
    ok: true,
    level: ownersWord ? "explicit" : "inferred",
    origin: {
      client: client.name,
      channel: claim.channel,
      source,
      evidence: evidenceLine(claim.evidence),
      review: ownersWord ? null : "pending",
      taint: previous?.tainted ? "inherited" : null,
    },
  };
}

/**
 * "Forget" from an agent (ADR-0001 §4): only the notes the client itself wrote and the ones waiting
 * for the "yes". An owner's note leaves through the vault; everything stays in git.
 */
export function mayForget(client: Client, previous: Previous): boolean {
  if (previous.ownerGrade || previous.inCore) return false;
  return previous.client === client.name || previous.pending;
}
