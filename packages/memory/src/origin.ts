// A version's provenance (ADR-0001 §3): who wrote it, through which channel, where it came from,
// whether it waits for the owner's "yes", and whether it inherited the previous version's taint.
// Only the server writes it; the reader is lenient as in the rest of the format, and an invalid
// block is ignored whole.

export const CHANNELS = ["provider", "tool"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The owner said it, an agent concluded it, or it came from outside (email, page, document). */
export const SOURCES = ["owner", "agent", "external"] as const;
export type Source = (typeof SOURCES)[number];

export interface Origin {
  /** The credential's client, which also names the scope `agent/<client>`. */
  client: string;
  channel: Channel;
  source: Source;
  /** The id of the owner's message, or the source's reference. */
  evidence: string | null;
  /** Present while the version waits for the owner's "yes". */
  review: "pending" | null;
  /** Present when the version was written over a tainted version. */
  taint: "inherited" | null;
}

/** A client's name: lowercase letters, digits and hyphens, like a folder's name. */
export const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_EVIDENCE_LENGTH = 300;
const ORIGIN_KEYS = ["client", "channel", "source", "evidence", "review", "taint"];
/** Controls, line separators and bidirectional marks, as in the writer's `printableLine`. */
export const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

const absent = (value: unknown) => value === undefined || value === null;

/** Reads the frontmatter's `origin` block; null when it is invalid. The vocabulary is closed. */
export function parseOrigin(value: unknown): Origin | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const map = value as Record<string, unknown>;
  if (Object.keys(map).some((key) => !ORIGIN_KEYS.includes(key))) return null;
  const { client, channel, source, evidence, review, taint } = map;
  if (typeof client !== "string" || !CLIENT_NAME.test(client)) return null;
  if (!CHANNELS.includes(channel as Channel) || !SOURCES.includes(source as Source)) return null;
  if (
    !absent(evidence) &&
    !(
      typeof evidence === "string" &&
      evidence.trim() !== "" &&
      evidence.length <= MAX_EVIDENCE_LENGTH &&
      !UNPRINTABLE.test(evidence)
    )
  ) {
    return null;
  }
  if (!absent(review) && review !== "pending") return null;
  if (!absent(taint) && taint !== "inherited") return null;
  return {
    client,
    channel: channel as Channel,
    source: source as Source,
    evidence: absent(evidence) ? null : (evidence as string),
    review: absent(review) ? null : "pending",
    taint: absent(taint) ? null : "inherited",
  };
}

const SOURCE_LABELS: Record<Source, string> = {
  owner: "claims to be the owner's",
  agent: "conclusion",
  external: "from outside",
};

/**
 * A note's provenance line in recall, the core, reads and search (ADR-0001 §6): `origin: owner`
 * when the version counts as the owner's; otherwise the client, where it came from, and whether it
 * waits for the "yes". Only closed vocabulary and the client's name, which follows CLIENT_NAME: the
 * evidence, free text, stays out, so nothing from a note gets into the fence this way.
 */
export function provenance(origin: Origin | null, ownerGrade: boolean): string {
  if (ownerGrade) return "origin: owner";
  if (origin === null) return "origin: unknown";
  const client = CLIENT_NAME.test(origin.client) ? origin.client : "?";
  const parts = [client, SOURCE_LABELS[origin.source]];
  if (origin.review !== null) parts.push("pending");
  if (origin.taint !== null) parts.push("inherited taint");
  return `origin: ${parts.join(", ")}`;
}

/** The block as it goes into the frontmatter, without the empty keys, in a fixed order. */
export function originFields(origin: Origin): Record<string, string> {
  const fields: Record<string, string> = {
    client: origin.client,
    channel: origin.channel,
    source: origin.source,
  };
  if (origin.evidence !== null) fields.evidence = origin.evidence;
  if (origin.review !== null) fields.review = origin.review;
  if (origin.taint !== null) fields.taint = origin.taint;
  return fields;
}
