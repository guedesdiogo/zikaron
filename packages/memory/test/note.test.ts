import { describe, expect, it } from "vitest";
import { readNote } from "../src/index.ts";

const KELPIE_NOTE = `---
id: 3f9a1c2b7d4e5f60
kind: person
scope: global
tier: semantic
level: explicit
confidence: 0.9
sources:
  - "[[2026-10-06-family-chat]]"
  - telegram:-100123/456
entities:
  - Ana Souza
  - " ana  souza "
  - Lisboa
valid_from: 2026-01-01
evergreen: true
abstract: Ana is the owner's sister; she lives in Lisbon.
relations:
  contradicts:
    - "[[memory/people/ana-old]]"
updated: 2026-10-06T12:00:00Z
---

# Ana Souza

Sister. Lives in [[Lisboa]].
`;

describe("readNote", () => {
  it("reads every field Kelpie writes", () => {
    const note = readNote("memory/people/ana-souza.md", KELPIE_NOTE);
    expect(note).toMatchObject({
      scope: "global",
      kind: "person",
      tier: "semantic",
      title: "Ana Souza",
      id: "3f9a1c2b7d4e5f60",
      level: "explicit",
      confidence: 0.9,
      sources: ["[[2026-10-06-family-chat]]", "telegram:-100123/456"],
      entities: [
        { name: "Ana Souza", key: "ana souza" },
        { name: "Lisboa", key: "lisboa" },
      ],
      validFrom: "2026-01-01",
      invalidAt: null,
      evergreen: true,
      pinned: false,
      abstract: "Ana is the owner's sister; she lives in Lisbon.",
      updated: "2026-10-06T12:00:00Z",
      // The frontmatter's links first.
      links: [
        { kind: "contradicts", by: "path", target: "memory/people/ana-old" },
        { kind: "source", by: "name", target: "2026-10-06-family-chat" },
        { kind: "link", by: "name", target: "lisboa" },
      ],
    });
    // The duplicate entity is reported; nothing else is.
    expect(note?.warnings).toEqual([
      "some `entities` were duplicates, invalid or over the limit; dropped",
    ]);
  });

  it("keeps YAML 1.2 types: dates stay strings, and `yes` isn't a boolean", () => {
    const note = readNote(
      "memory/notes/x.md",
      "---\nvalid_from: 2026-10-06\nevergreen: yes\npinned: true\n---\nbody",
    );
    expect(note?.validFrom).toBe("2026-10-06");
    expect(note?.evergreen).toBe(false);
    expect(note?.pinned).toBe(true);
    expect(note?.warnings).toEqual(["`evergreen` is invalid; ignored"]);
  });

  it("indexes the owner's free notes with defaults", () => {
    const note = readNote("knowledge/Receitas da avó.md", "# Bolo de fubá\n\nMilho, ovos.\n");
    expect(note).toMatchObject({
      scope: "global",
      kind: "note",
      tier: "semantic",
      title: "Bolo de fubá",
      id: null,
      level: null,
      confidence: null,
      frontmatter: {},
      warnings: [],
    });
    expect(readNote("knowledge/sem-titulo.md", "text")?.title).toBe("sem-titulo");
  });

  it("never drops a note for bad frontmatter", () => {
    const broken = readNote("memory/notes/x.md", "---\nkind: [unclosed\n---\n# Still here\n");
    expect(broken).toMatchObject({ title: "Still here", frontmatter: {} });
    expect(broken?.warnings).toEqual(["frontmatter isn't valid YAML; ignored"]);

    const duplicate = readNote("memory/notes/x.md", "---\nkind: note\nkind: event\n---\nx");
    expect(duplicate?.warnings).toEqual(["frontmatter isn't valid YAML; ignored"]);

    const aliased = readNote("memory/notes/x.md", "---\na: &x [1, 2]\nb: *x\n---\nx");
    expect(aliased?.warnings).toEqual(["frontmatter uses YAML aliases; ignored"]);

    const list = readNote("memory/notes/x.md", "---\n- a\n- b\n---\nx");
    expect(list?.warnings).toEqual(["frontmatter isn't a map of keys; ignored"]);
  });

  it("lets the folder win over the frontmatter, and says so", () => {
    const note = readNote(
      "areas/work/decisions/vendor.md",
      "---\nkind: person\nscope: global\n---\nx",
    );
    expect(note).toMatchObject({ kind: "decision", scope: "area/work" });
    expect(note?.warnings).toEqual([
      "`kind` says person but the folder says decision; the folder wins",
      "`scope` says global but the path says area/work; the path wins",
    ]);
    expect(readNote("knowledge/x.md", "---\nkind: procedure\n---\nx")?.kind).toBe("procedure");
  });

  it("ignores invalid values one by one", () => {
    const note = readNote(
      "memory/events/x.md",
      [
        "---",
        "confidence: 1.5",
        "level: certain",
        "tier: forever",
        "valid_from: 2026-10-06",
        "invalid_at: 2026-10-01",
        "updated: yesterday",
        "abstract: |",
        "  two",
        "  lines",
        "relations:",
        "  causes: ['[[x]]']",
        "---",
        "x",
      ].join("\n"),
    );
    expect(note).toMatchObject({
      confidence: null,
      level: null,
      tier: "episodic",
      validFrom: "2026-10-06",
      invalidAt: null,
      updated: null,
      abstract: null,
    });
    expect(note?.warnings).toEqual([
      "`invalid_at` isn't after `valid_from`; ignored",
      "`relations` is invalid; ignored",
      "`tier` is invalid; ignored",
      "`level` is invalid; ignored",
      "`confidence` is invalid; ignored",
      "`abstract` is invalid; ignored",
      "`updated` is invalid; ignored",
    ]);
  });

  it("reads where a merged note went (#112)", () => {
    const note = readNote(
      "memory/notes/cafe-2.md",
      [
        "---",
        "relations:",
        "  contradicts:",
        '    - "[[cha]]"',
        "  merged_into:",
        '    - "[[memory/notes/cafe]]"',
        "---",
        "# Café",
        "",
        "Merged into [[memory/notes/cafe]].",
      ].join("\n"),
    );
    expect(note?.links).toContainEqual({
      kind: "merged_into",
      by: "path",
      target: "memory/notes/cafe",
    });
    expect(note?.links).toContainEqual({ kind: "contradicts", by: "name", target: "cha" });
    expect(note?.warnings).toEqual([]);
    // By name, it merges nothing, and the note says so.
    const named = readNote(
      "memory/notes/cafe-3.md",
      '---\nrelations:\n  merged_into:\n    - "[[cafe]]"\n---\n# Café\n',
    );
    expect(named?.warnings).toEqual([
      "`relations.merged_into` names a note by name: name it by its path, or it merges nothing",
    ]);
  });

  it("returns null outside the index", () => {
    expect(readNote("agents/kelpie/SOUL.md", "# Persona")).toBeNull();
  });

  it("drops entities one by one, and rejects impossible dates", () => {
    const many = Array.from({ length: 60 }, (_, i) => `E${i}`);
    const note = readNote(
      "memory/notes/x.md",
      `---\nentities: [${[...many, "x".repeat(300)].join(", ")}]\nvalid_from: 2026-02-30\ninvalid_at: 2026-10-06T24:00:00Z\n---\nx`,
    );
    expect(note?.entities.map((entity) => entity.name)).toEqual(many.slice(0, 10));
    expect(note?.validFrom).toBeNull();
    expect(note?.invalidAt).toBeNull();
  });

  it("bounds what one note costs to index", () => {
    const long = readNote("memory/notes/x.md", `# Long\n\n${"palavra ".repeat(40_000)}`);
    expect(long?.body.length).toBe(262_144);
    expect(long?.warnings).toEqual([
      "the body is longer than 262,144 characters; only its start is indexed",
    ]);
    const links = Array.from({ length: 600 }, (_, i) => `[[n${i}]]`).join(" ");
    const linked = readNote("memory/notes/y.md", links);
    expect(linked?.links).toHaveLength(500);
    expect(linked?.warnings).toEqual(["more than 500 links; the rest are not indexed"]);
  });

  it("drops keys that could stand in for an object's prototype", () => {
    const note = readNote(
      "memory/notes/x.md",
      "---\n__proto__: {pinned: true}\nconstructor: x\nprototype: y\nkind: note\n---\nx",
    );
    expect(Object.keys(note?.frontmatter ?? {})).toEqual(["kind"]);
    expect(Object.getPrototypeOf(note?.frontmatter)).toBe(Object.prototype);
    expect(note?.warnings).toEqual([
      "`__proto__`, `constructor` and `prototype` are reserved; ignored",
    ]);
  });
});
