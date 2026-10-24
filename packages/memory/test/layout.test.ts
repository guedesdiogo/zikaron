import { describe, expect, it } from "vitest";
import { isScope, memoryPath, placeOf, slugify } from "../src/index.ts";

describe("placeOf", () => {
  it.each([
    ["memory/people/ana-souza.md", "global", "person"],
    ["memory/sessions/2026/2026-10-06-family.md", "global", "session"],
    ["memory/loose-note.md", "global", null],
    ["memory/recipes/bolo.md", "global", null],
    ["knowledge/people/someone.md", "global", null],
    ["knowledge/ideas.md", "global", null],
    ["agents/kelpie/memory/preferences/coffee.md", "agent/kelpie", "preference"],
    ["areas/work/decisions/vendor.md", "area/work", "decision"],
    ["areas/work/meeting-notes.md", "area/work", null],
    ["projects/kelpie/procedures/release.md", "project/kelpie", "procedure"],
    ["conversations/family/events/2026/2026-12-24-dinner.md", "conversation/family", "event"],
  ])("%s is %s, kind %s", (path, scope, kind) => {
    expect(placeOf(path)).toEqual({ scope, kind });
  });

  it.each([
    "README.md",
    "AGENTS.md",
    "USER.md",
    "index.md",
    "skills/writing/brief/SKILL.md",
    "agents/kelpie/SOUL.md",
    "agents/kelpie/AGENTS.md",
    "agents/kelpie/memories/MEMORY.md",
    ".obsidian/workspace.md",
    "memory/.trash/old.md",
    "memory/people/photo.png",
    "areas/work.md",
    "memory//double.md",
  ])("%s is outside the index", (path) => {
    expect(placeOf(path)).toBeNull();
  });
});

describe("paths Kelpie writes", () => {
  it("folds diacritics and punctuation into a readable slug", () => {
    expect(slugify("João Café, São Paulo!")).toBe("joao-cafe-sao-paulo");
    expect(slugify("???")).toBe("untitled");
    expect(slugify("a".repeat(100))).toHaveLength(80);
  });

  it("puts a memory under its scope and kind folder", () => {
    expect(memoryPath("global", "person", "Ana Souza")).toBe("memory/people/ana-souza.md");
    expect(memoryPath("agent/kelpie", "preference", "Café sem açúcar")).toBe(
      "agents/kelpie/memory/preferences/cafe-sem-acucar.md",
    );
    expect(memoryPath("area/work", "decision", "Vendor")).toBe("areas/work/decisions/vendor.md");
  });

  it("files a dated memory under its year, date first", () => {
    expect(memoryPath("conversation/family", "session", "Natal", "2026-12-24")).toBe(
      "conversations/family/sessions/2026/2026-12-24-natal.md",
    );
    expect(() => memoryPath("global", "event", "x", "24/12/2026")).toThrow(RangeError);
    expect(() => memoryPath("global", "event", "x", "2026-99-99")).toThrow(RangeError);
    expect(() => memoryPath("area/.." as never, "note", "x")).toThrow(RangeError);
    expect(() => memoryPath("global", "thing" as never, "x")).toThrow(RangeError);
  });

  it("every path it writes is in the index, with the same scope and kind", () => {
    for (const [scope, kind] of [
      ["global", "note"],
      ["agent/kelpie", "commitment"],
      ["project/kelpie", "place"],
    ] as const) {
      expect(placeOf(memoryPath(scope, kind, "Something"))).toEqual({ scope, kind });
    }
  });

  it("knows a scope when it sees one", () => {
    expect(isScope("global")).toBe(true);
    expect(isScope("area/work")).toBe(true);
    expect(isScope("global/x")).toBe(false);
    expect(isScope("team/x")).toBe(false);
    expect(isScope("area/")).toBe(false);
    expect(isScope("area/a/b")).toBe(false);
    expect(isScope("area/.hidden")).toBe(false);
    expect(isScope("area/x\ny")).toBe(false);
    expect(isScope("area/a\\b")).toBe(false);
    expect(isScope("area/trailing.")).toBe(false);
    expect(isScope("area/\u202Eevil")).toBe(false);
    expect(isScope("area/Saúde & Bem-estar")).toBe(true);
  });
});
