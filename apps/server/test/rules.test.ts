// The write rule (ADR-0001 §4 and ADR-0003).
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
  it("the owner said it, through the provider: goes straight in, explicit, with the evidence", () => {
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

  it("a channel that isn't the provider never says the owner said it", () => {
    const decision = decideWrite(
      NOAH,
      { channel: "mcp" as unknown as "tool", source: "owner" },
      null,
    );
    expect(decision).toMatchObject({ ok: true, level: "inferred", origin: { source: "agent" } });
  });

  it("for a privileged client, the tainted note doesn't exist", () => {
    expect(
      decideWrite(ALAN, { channel: "tool", source: "agent" }, { ...PLAIN, tainted: true }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it('an "owner said" from a client without ownerClaims stays pending and inferred', () => {
    expect(decideWrite(ALAN, { channel: "provider", source: "owner" }, null)).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source: "owner", review: "pending" },
    });
  });

  it("through the tool channel, nothing is the owner's or explicit", () => {
    const decision = decideWrite(ALAN, { channel: "tool", source: "owner" }, null);
    expect(decision).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source: "agent", review: "pending" },
    });
  });

  it.each(["agent", "external"] as const)("%s goes in pending and inferred", (source) => {
    expect(decideWrite(NOAH, { channel: "provider", source }, null)).toMatchObject({
      ok: true,
      level: "inferred",
      origin: { source, review: "pending" },
    });
  });

  it("a scheduled routine doesn't write", () => {
    expect(
      decideWrite(NOAH, { channel: "provider", source: "owner", context: "cron" }, null),
    ).toEqual({ ok: false, reason: "cron" });
  });

  it("no agent pins a note", () => {
    expect(decideWrite(NOAH, { channel: "provider", source: "owner", pinned: true }, null)).toEqual(
      {
        ok: false,
        reason: "pinned",
      },
    );
  });

  it("doesn't replace an archived or core note, not even on the owner's word", () => {
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

  it("an owner's note only changes on the owner's word, from a client with ownerClaims", () => {
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

  it("over a tainted version, the new one inherits the mark", () => {
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

  it("the evidence becomes one line, without control characters, of up to 300 characters", () => {
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
  it("an agent forgets its own notes and the pending ones", () => {
    expect(mayForget(ALAN, PLAIN)).toBe(true);
    expect(mayForget(NOAH, { ...PLAIN, pending: true })).toBe(true);
    expect(mayForget(NOAH, PLAIN)).toBe(false);
  });

  it("never an owner's note or a core note", () => {
    expect(mayForget(ALAN, { ...PLAIN, ownerGrade: true })).toBe(false);
    expect(mayForget(ALAN, { ...PLAIN, inCore: true })).toBe(false);
  });
});
