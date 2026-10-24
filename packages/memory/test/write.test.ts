import { describe, expect, it } from "vitest";
import { MemoryFormatError, type MemoryInput, readNote, writeMemory } from "../src/index.ts";

const AT = "2026-10-06T12:00:00Z";

const ANA: MemoryInput = {
  scope: "global",
  kind: "person",
  title: "Ana Souza",
  body: "Sister. Lives in [[Lisboa]].",
  level: "explicit",
  confidence: 0.9,
  sources: ["[[2026-10-06-family-chat]]"],
  entities: ["Ana Souza", "Lisboa"],
  validFrom: "2026-01-01",
  evergreen: true,
  abstract: "The owner's sister, in Lisbon.",
};

describe("writeMemory", () => {
  it("writes a readable file, keys in a fixed order", async () => {
    const { id, text } = await writeMemory(ANA, { at: AT });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(text).toBe(`---
id: ${id}
kind: person
scope: global
tier: semantic
level: explicit
confidence: 0.9
sources:
  - "[[2026-10-06-family-chat]]"
entities:
  - Ana Souza
  - Lisboa
valid_from: 2026-01-01
evergreen: true
abstract: The owner's sister, in Lisbon.
updated: 2026-10-06T12:00:00Z
---

# Ana Souza

Sister. Lives in [[Lisboa]].
`);
  });

  it("reads back what it wrote, with no warnings", async () => {
    const { id, text } = await writeMemory({ ...ANA, contradicts: ["Ana in Porto"] }, { at: AT });
    const note = readNote("memory/people/ana-souza.md", text);
    expect(note).toMatchObject({
      id,
      kind: "person",
      scope: "global",
      title: "Ana Souza",
      level: "explicit",
      confidence: 0.9,
      validFrom: "2026-01-01",
      evergreen: true,
      updated: AT,
      warnings: [],
    });
    expect(note?.links).toContainEqual({ kind: "contradicts", by: "name", target: "ana in porto" });
  });

  it("is deterministic: the same memory is the same file and the same id", async () => {
    const first = await writeMemory(ANA, { at: AT });
    const second = await writeMemory({ ...ANA, entities: [...(ANA.entities ?? [])] }, { at: AT });
    expect(second).toEqual(first);
    const other = await writeMemory({ ...ANA, body: "Sister. Lives in Porto." }, { at: AT });
    expect(other.id).not.toBe(first.id);
  });

  it("keeps the id, the owner's keys and comments when it supersedes a version", async () => {
    const v1 = await writeMemory(ANA, { at: AT });
    const edited = v1.text.replace(
      "kind: person\n",
      "kind: person\naliases: [Aninha] # added in Obsidian\n",
    );
    const v2 = await writeMemory(
      { ...ANA, body: "Sister. Moved to [[Porto]].", entities: ["Ana Souza", "Porto"] },
      { at: "2026-11-01T09:30:00Z", existing: edited },
    );
    expect(v2.id).toBe(v1.id);
    expect(v2.text).toContain("aliases: [Aninha] # added in Obsidian\n");
    expect(v2.text.indexOf("aliases")).toBeLessThan(v2.text.indexOf("tier"));
    expect(v2.text).toContain("Moved to [[Porto]].");
    expect(v2.text).not.toContain("Lisboa");
    expect(v2.text).toContain("updated: 2026-11-01T09:30:00Z");
    expect(readNote("memory/people/ana-souza.md", v2.text)?.warnings).toEqual([]);
  });

  it("drops fields the new version doesn't have, and follows a `title` key", async () => {
    const v1 = await writeMemory(ANA, { at: AT });
    const withTitle = v1.text.replace("kind: person\n", "kind: person\ntitle: Old title\n");
    const { abstract: _abstract, validFrom: _validFrom, ...rest } = ANA;
    const v2 = await writeMemory(
      { ...rest, title: "Ana S.", evergreen: false },
      { at: AT, existing: withTitle },
    );
    expect(v2.text).toContain("title: Ana S.\n");
    expect(v2.text).toContain("# Ana S.\n");
    expect(v2.text).not.toMatch(/evergreen|abstract|valid_from/);
  });

  it("mints an id when the existing file has none", async () => {
    const plain = await writeMemory(ANA, { at: AT, existing: "# Ana\n\nOwner's own note." });
    const invalidId = await writeMemory(ANA, { at: AT, existing: "---\nid: -x\n---\nx" });
    const fresh = await writeMemory(ANA, { at: AT });
    expect(plain.id).toBe(fresh.id);
    expect(invalidId.id).toBe(fresh.id);
  });

  it("refuses an invalid memory and lists every problem", async () => {
    const error = await writeMemory(
      {
        ...ANA,
        scope: "team/x" as never,
        title: "two\nlines",
        confidence: 2,
        entities: ["a", "A"],
        validFrom: "2026-10-06",
        invalidAt: "2026-10-01",
        contradicts: ["[[x]]"],
      },
      { at: "2026-10-06 12:00" },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryFormatError);
    expect((error as MemoryFormatError).problems).toEqual([
      "`scope` is invalid",
      "`title` must be one line of 1-200 characters",
      "`confidence` must be 0-1",
      "`entities` must be up to 10 distinct names of 1-64 characters",
      "`invalidAt` must be after `validFrom`",
      "`contradicts` must name notes, without brackets",
      "`at` must be a UTC date-time",
    ]);
  });

  it("refuses to supersede a file whose frontmatter it can't read, instead of dropping it", async () => {
    for (const existing of [
      "---\ntags: [a, b\n---\nx",
      "---\nlevel: a\nlevel: b\n---\nx",
      "---\n- a\n---\nx",
    ]) {
      const error = await writeMemory(ANA, { at: AT, existing }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MemoryFormatError);
      expect((error as MemoryFormatError).problems).toEqual([
        "the existing file's frontmatter can't be read; fix it before writing a new version",
      ]);
    }
    // An empty block is fine.
    expect((await writeMemory(ANA, { at: AT, existing: "---\n---\nx" })).text).toContain("id: ");
  });

  it("accepts emoji and joiners in a title, and refuses impossible dates", async () => {
    const { text } = await writeMemory({ ...ANA, title: "👩‍💻 Ana, dev" }, { at: AT });
    expect(text).toContain("# 👩‍💻 Ana, dev");
    const error = await writeMemory({ ...ANA, validFrom: "2026-02-30" }, { at: AT }).catch(
      (caught: unknown) => caught,
    );
    expect((error as MemoryFormatError).problems).toEqual([
      "`validFrom` must be a date or a date-time with an offset",
    ]);
  });

  it("refuses an existing frontmatter that is too long or uses aliases", async () => {
    const huge = `---\n${Array.from({ length: 2_000 }, (_, i) => `k${i}: value`).join("\n")}\n---\nx`;
    const aliased = "---\nx: &a [1, 2]\ny: *a\n---\nx";
    for (const existing of [huge, aliased]) {
      const error = await writeMemory(ANA, { at: AT, existing }).catch((caught: unknown) => caught);
      expect((error as MemoryFormatError).problems).toEqual([
        "the existing file's frontmatter can't be read; fix it before writing a new version",
      ]);
    }
  });

  it("refuses wrong types and bidirectional controls from a caller that isn't typed", async () => {
    const error = await writeMemory(
      {
        ...ANA,
        title: 123,
        confidence: "0.5",
        pinned: "false",
        abstract: "safe\u202Etxt.exe",
      } as never,
      { at: AT },
    ).catch((caught: unknown) => caught);
    expect((error as MemoryFormatError).problems).toEqual([
      "`title` must be one line of 1-200 characters",
      "`confidence` must be 0-1",
      "`abstract` must be one line of 1-300 characters",
      "`evergreen` and `pinned` must be true or false",
    ]);
  });
});
