// A regra de gravação (ADR-0001 §4), aplicada pelo servidor e não pela persona: o canal põe o teto
// do que uma gravação diz ser, e a versão anterior decide se ela pode ser substituída. Funções
// puras: quem grava passa a versão atual e a confiança dela, e recebe o `origin` e o `level`.
import type { Channel, Level, Origin, Source } from "@zikaron/memory";
import type { Client } from "./identity.ts";

/** O que o pedido diz de uma gravação; o servidor limita cada campo pelo canal. */
export interface WriteClaim {
  channel: Channel;
  source: Source;
  /** O id da mensagem do dono, ou a referência da fonte; uma linha. */
  evidence?: string;
  /** `cron` quando quem grava é uma rotina agendada, que nunca grava (Q3). */
  context?: string;
  /** Um agente nunca fixa uma nota: o `pinned` só vem do cofre. */
  pinned?: boolean;
}

/** A versão atual do caminho, quando a gravação a substitui. */
export interface Previous {
  /** Do índice (`MemoryIndex.trust`), com a configuração atual dos clientes. */
  ownerGrade: boolean;
  tainted: boolean;
  archived: boolean;
  /** O núcleo a carrega: pinned no escopo global ou de um agente, ou em `profile/` (#168). */
  inCore: boolean;
  /** Ela espera o «sim» do dono. */
  pending: boolean;
  /** O cliente que a gravou, quando foi o servidor. */
  client: string | null;
}

export type WriteRefusal = "cron" | "pinned" | "owners_note" | "core_note" | "archived";

export type WriteDecision =
  | { ok: true; origin: Origin; level: Level }
  | { ok: false; reason: WriteRefusal };

/** Uma linha de evidência: sem quebras, controles nem marcas bidirecionais, até 300 caracteres. */
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
 * Decide o `origin` e o `level` de uma nova versão, ou a recusa:
 * - uma rotina agendada não grava, e nenhum agente fixa uma nota;
 * - pelo canal de ferramenta, nada é `owner` nem `explicit`;
 * - `agent` e `external` entram com `review: pending` e `level: inferred`, até o «sim»;
 * - nenhuma gravação substitui uma nota arquivada ou do núcleo;
 * - uma nota que vale como do dono só é substituída pela palavra do dono, isto é, `source: owner`
 *   pelo provedor de um cliente com `ownerClaims` (o «corrija» do Q6, ADR-0003);
 * - por cima de uma versão contaminada, a nova herda a marca (`taint: inherited`).
 */
export function decideWrite(
  client: Client,
  claim: WriteClaim,
  previous: Previous | null,
): WriteDecision {
  if (claim.context === "cron") return { ok: false, reason: "cron" };
  if (claim.pinned === true) return { ok: false, reason: "pinned" };
  const source: Source =
    claim.channel === "tool" && claim.source === "owner" ? "agent" : claim.source;
  const ownersWord = source === "owner" && claim.channel === "provider" && client.ownerClaims;
  if (previous !== null) {
    if (previous.archived) return { ok: false, reason: "archived" };
    if (previous.inCore) return { ok: false, reason: "core_note" };
    if (previous.ownerGrade && !ownersWord) return { ok: false, reason: "owners_note" };
  }
  const saidByOwner = source === "owner";
  return {
    ok: true,
    level: saidByOwner ? "explicit" : "inferred",
    origin: {
      client: client.name,
      channel: claim.channel,
      source,
      evidence: evidenceLine(claim.evidence),
      review: saidByOwner ? null : "pending",
      taint: previous?.tainted ? "inherited" : null,
    },
  };
}

/**
 * «Esqueça» vindo de um agente (ADR-0001 §4): só as notas que o próprio cliente gravou e as que
 * esperam o «sim». Uma nota do dono sai pelo cofre; tudo continua no git.
 */
export function mayForget(client: Client, previous: Previous): boolean {
  if (previous.ownerGrade || previous.inCore) return false;
  return previous.client === client.name || previous.pending;
}
