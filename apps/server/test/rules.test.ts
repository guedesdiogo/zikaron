// A regra de gravação (ADR-0001 §4 e ADR-0003).
import { describe, expect, it } from "vitest";
import type { Client } from "../src/identity.ts";
import { decideWrite, mayForget, type Previous } from "../src/rules.ts";

const NOAH: Client = { name: "noah", exposed: true, privileged: false, ownerClaims: true };
const ALAN: Client = { name: "alan", exposed: false, privileged: true, ownerClaims: false };

const PLAIN: Previous = {
  ownerGrade: false,
  tainted: false,
  archived: false,
  inCore: false,
  pending: false,
  client: "alan",
};

describe("decideWrite", () => {
  it("o dono disse, pelo provedor: entra direto, explicit, com a evidência", () => {
    expect(
      decideWrite(NOAH, { channel: "provider", source: "owner", evidence: "telegram:msg/1" }, null),
    ).toEqual({
      ok: true,
      level: "explicit",
      origin: {
        client: "noah",
        channel: "provider",
        source: "owner",
        evidence: "telegram:msg/1",
        review: null,
        taint: null,
      },
    });
  });

  it("um canal que não é o provedor nunca diz que o dono disse", () => {
    const decision = decideWrite(
      NOAH,
      { channel: "mcp" as unknown as "tool", source: "owner" },
      null,
    );
    expect(decision).toMatchObject({ ok: true, level: "inferred", origin: { source: "agent" } });
  });

  it("para um cliente privileged, a nota contaminada não existe", () => {
    expect(
      decideWrite(ALAN, { channel: "tool", source: "agent" }, { ...PLAIN, tainted: true }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("o «o dono disse» de um cliente sem ownerClaims fica pendente e inferido", () => {
    expect(decideWrite(ALAN, { channel: "provider", source: "owner" }, null)).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source: "owner", review: "pending" },
    });
  });

  it("pelo canal de ferramenta, nada é do dono nem explicit", () => {
    const decision = decideWrite(ALAN, { channel: "tool", source: "owner" }, null);
    expect(decision).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source: "agent", review: "pending" },
    });
  });

  it.each(["agent", "external"] as const)("%s entra pendente e inferido", (source) => {
    expect(decideWrite(NOAH, { channel: "provider", source }, null)).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source, review: "pending" },
    });
  });

  it("uma rotina agendada não grava", () => {
    expect(
      decideWrite(NOAH, { channel: "provider", source: "owner", context: "cron" }, null),
    ).toEqual({ ok: false, reason: "cron" });
  });

  it("nenhum agente fixa uma nota", () => {
    expect(decideWrite(NOAH, { channel: "provider", source: "owner", pinned: true }, null)).toEqual(
      {
        ok: false,
        reason: "pinned",
      },
    );
  });

  it("não substitui nota arquivada nem do núcleo, nem pela palavra do dono", () => {
    const owner = { channel: "provider", source: "owner" } as const;
    expect(decideWrite(NOAH, owner, { ...PLAIN, archived: true })).toEqual({
      ok: false,
      reason: "archived",
    });
    expect(decideWrite(NOAH, owner, { ...PLAIN, inCore: true })).toEqual({
      ok: false,
      reason: "core_note",
    });
  });

  it("uma nota do dono só muda pela palavra do dono, de um cliente com ownerClaims", () => {
    const ownersNote = { ...PLAIN, ownerGrade: true, client: null };
    expect(decideWrite(NOAH, { channel: "provider", source: "owner" }, ownersNote)).toMatchObject({
      ok: true,
    });
    expect(decideWrite(NOAH, { channel: "provider", source: "agent" }, ownersNote)).toEqual({
      ok: false,
      reason: "owners_note",
    });
    expect(decideWrite(NOAH, { channel: "tool", source: "owner" }, ownersNote)).toEqual({
      ok: false,
      reason: "owners_note",
    });
    expect(decideWrite(ALAN, { channel: "provider", source: "owner" }, ownersNote)).toEqual({
      ok: false,
      reason: "owners_note",
    });
  });

  it("por cima de uma versão contaminada, a nova herda a marca", () => {
    const KELPIE: Client = {
      name: "kelpie",
      exposed: false,
      privileged: false,
      ownerClaims: false,
    };
    expect(
      decideWrite(KELPIE, { channel: "tool", source: "agent" }, { ...PLAIN, tainted: true }),
    ).toMatchObject({ ok: true, origin: { taint: "inherited" } });
    expect(decideWrite(ALAN, { channel: "tool", source: "agent" }, PLAIN)).toMatchObject({
      ok: true,
      origin: { taint: null },
    });
  });

  it("a evidência vira uma linha, sem controles, de até 300 caracteres", () => {
    const decision = decideWrite(
      NOAH,
      { channel: "provider", source: "owner", evidence: `a\nb\u202Ec ${"x".repeat(400)}` },
      null,
    );
    const evidence = decision.ok ? decision.origin.evidence : null;
    expect(evidence?.startsWith("a b c ")).toBe(true);
    expect(evidence?.length).toBeLessThanOrEqual(300);
    expect(
      decideWrite(NOAH, { channel: "provider", source: "owner", evidence: "\n\t" }, null),
    ).toMatchObject({ ok: true, origin: { evidence: null } });
  });
});

describe("mayForget", () => {
  it("um agente esquece as próprias e as pendentes", () => {
    expect(mayForget(ALAN, PLAIN)).toBe(true);
    expect(mayForget(NOAH, { ...PLAIN, pending: true })).toBe(true);
    expect(mayForget(NOAH, PLAIN)).toBe(false);
  });

  it("nunca uma nota do dono ou do núcleo", () => {
    expect(mayForget(ALAN, { ...PLAIN, ownerGrade: true })).toBe(false);
    expect(mayForget(ALAN, { ...PLAIN, inCore: true })).toBe(false);
  });
});
