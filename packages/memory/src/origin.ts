// A proveniência de uma versão (ADR-0001 §3): quem gravou, por qual canal, de onde veio, se espera
// o «sim» do dono e se herdou a contaminação da versão anterior. Só o servidor a escreve; o leitor
// é leniente como no resto do formato, e um bloco que não vale é ignorado inteiro.

export const CHANNELS = ["provider", "tool"] as const;
export type Channel = (typeof CHANNELS)[number];

/** O dono disse, um agente concluiu, ou veio de fora (e-mail, página, documento). */
export const SOURCES = ["owner", "agent", "external"] as const;
export type Source = (typeof SOURCES)[number];

export interface Origin {
  /** O cliente da credencial, que também nomeia o escopo `agent/<cliente>`. */
  client: string;
  channel: Channel;
  source: Source;
  /** O id da mensagem do dono, ou a referência da fonte. */
  evidence: string | null;
  /** Presente enquanto a versão espera o «sim» do dono. */
  review: "pending" | null;
  /** Presente quando a versão foi gravada por cima de uma versão contaminada. */
  taint: "inherited" | null;
}

/** O nome de um cliente: minúsculas, dígitos e hífen, como um nome de pasta. */
export const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_EVIDENCE_LENGTH = 300;
const ORIGIN_KEYS = ["client", "channel", "source", "evidence", "review", "taint"];
/** Controles, separadores de linha e marcas bidirecionais, como o `printableLine` do escritor. */
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

const absent = (value: unknown) => value === undefined || value === null;

/** Lê o bloco `origin` do frontmatter; null quando ele não vale. O vocabulário é fechado. */
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

/** O bloco como ele vai para o frontmatter, sem as chaves vazias, numa ordem fixa. */
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
