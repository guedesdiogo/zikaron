import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type IndexDump,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  SCHEMA_VERSION,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

/** Runs a test against a fresh index in its own Durable Object. */
async function withIndex(
  name: string,
  run: (index: MemoryIndex, storage: DurableObjectStorage) => Promise<void>,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    await run(new MemoryIndex(state.storage), state.storage);
  });
}

const ANA: MemoryInput = {
  scope: "global",
  kind: "person",
  title: "Ana Souza",
  body: "Irmã do owner. Mora em [[Lisboa]], trabalha com design.",
  level: "explicit",
  confidence: 0.9,
  entities: ["Ana Souza", "Lisboa"],
};
const ANA_PATH = memoryPath("global", "person", "Ana Souza");

describe("schema", () => {
  it("is created once, and an index from another schema version starts over", async () => {
    await withIndex("schema", async (_index, storage) => {
      const tables = storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "commits",
          "embeddings",
          "entities",
          "links",
          "meta",
          "versions",
          "versions_fts",
        ]),
      );
      // Opening it again keeps what is there.
      storage.sql.exec(
        "INSERT INTO commits (sha, seq, committed_at, recorded_at) VALUES ('x', 1, 0, 0)",
      );
      storage.sql.exec("INSERT INTO embeddings VALUES ('b', 'm', 1, ?)", new ArrayBuffer(4));
      expect(new MemoryIndex(storage).lastCommit()).toEqual({ sha: "x", committedAt: 0 });
      // Another schema: the derived rows go, so the caller replays the vault from the start.
      storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
      expect(new MemoryIndex(storage).lastCommit()).toBeNull();
      expect(
        storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
          .one().value,
      ).toBe(`${SCHEMA_VERSION}`);
      expect(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM embeddings").one().n).toBe(
        1,
      );
    });
  });
});

describe("versions", () => {
  it("a superseding version keeps only the current text in the file and the old one in the index", async () => {
    await withIndex("supersede", async (index) => {
      const vault = new FakeVault();
      const v1 = await writeMemory(ANA, { at: "2026-10-01T01:00:00Z" });
      const c1 = vault.commit({ [ANA_PATH]: v1.text });
      await index.applyCommit(c1);
      const v2 = await writeMemory(
        {
          ...ANA,
          body: "Irmã do owner. Mudou-se para o [[Porto]] em outubro.",
          entities: ["Ana Souza", "Porto"],
        },
        { at: "2026-10-01T02:00:00Z", existing: v1.text },
      );
      const c2 = vault.commit({ [ANA_PATH]: v2.text });
      await index.applyCommit(c2);

      // The file holds the current version only.
      expect(vault.files.get(ANA_PATH)).toBe(v2.text);
      expect(vault.files.get(ANA_PATH)).not.toContain("Lisboa");

      // The index holds both, chained, each with its commit.
      const [old, current] = index.history(ANA_PATH);
      expect(old).toMatchObject({
        commit: c1.sha,
        current: false,
        supersedes: null,
        recordedAt: c1.committedAt,
        replacedAt: c2.committedAt,
        replacedBy: c2.sha,
        id: v1.id,
      });
      expect(old?.body).toContain("Lisboa");
      expect(current).toMatchObject({
        commit: c2.sha,
        current: true,
        supersedes: c1.sha,
        replacedAt: null,
        id: v1.id,
      });
      expect(index.current(ANA_PATH)?.commit).toBe(c2.sha);

      // "Current only" by default; "as of" reaches the superseded version.
      expect(index.search("Lisboa")).toEqual([]);
      expect(index.search("Lisboa", { asOf: c1.committedAt + 1 })).toEqual([
        {
          path: ANA_PATH,
          commit: c1.sha,
          title: "Ana Souza",
          abstract: null,
          current: false,
          kind: "person",
          tier: "semantic",
          pinned: false,
        },
      ]);
      expect(index.search("Porto").map((hit) => hit.commit)).toEqual([c2.sha]);
      expect(index.versionAt(ANA_PATH, c1.committedAt)?.commit).toBe(c1.sha);
      expect(index.versionAt(ANA_PATH, c2.committedAt)?.commit).toBe(c2.sha);
      expect(index.versionAt(ANA_PATH, c1.committedAt - 1)).toBeNull();
    });
  });

  it("removing a file ends its chain; writing it again continues the chain", async () => {
    await withIndex("remove", async (index) => {
      const vault = new FakeVault();
      const c1 = vault.commit({ "knowledge/ideia.md": "# Ideia\n\nPrimeira." });
      const c2 = vault.commit({ "knowledge/ideia.md": null });
      const c3 = vault.commit({ "knowledge/ideia.md": "# Ideia\n\nDe volta." });
      await index.applyCommit(c1);
      expect(await index.applyCommit(c2)).toEqual({
        applied: true,
        written: [],
        removed: ["knowledge/ideia.md"],
      });
      expect(index.current("knowledge/ideia.md")).toBeNull();
      expect(index.search("Primeira")).toEqual([]);
      await index.applyCommit(c3);
      expect(
        index
          .history("knowledge/ideia.md")
          .map((v) => [v.commit, v.supersedes, v.replacedBy, v.current]),
      ).toEqual([
        [c1.sha, null, c2.sha, false],
        [c3.sha, c1.sha, null, true],
      ]);
    });
  });

  it("skips replays, unchanged content and files outside the index", async () => {
    await withIndex("idempotent", async (index) => {
      const vault = new FakeVault();
      const c1 = vault.commit({ "memory/notes/a.md": "# A\n\nx" });
      expect((await index.applyCommit(c1)).written).toEqual(["memory/notes/a.md"]);
      expect(await index.applyCommit(c1)).toEqual({ applied: false, written: [], removed: [] });
      const c2 = vault.commit({
        "memory/notes/a.md": "# A\n\nx",
        "agents/kelpie/SOUL.md": "# Persona",
        "skills/x/SKILL.md": "# Skill",
        "memory/notes/photo.png": "binary",
      });
      expect(await index.applyCommit(c2)).toEqual({ applied: true, written: [], removed: [] });
      expect(index.history("memory/notes/a.md")).toHaveLength(1);
      expect(index.dump().versions.map((v) => v.path)).toEqual(["memory/notes/a.md"]);
      expect(index.lastCommit()).toEqual({ sha: c2.sha, committedAt: c2.committedAt });
    });
  });

  it("indexes what the note says: fields, entities and warnings", async () => {
    await withIndex("fields", async (index) => {
      const vault = new FakeVault();
      const written = await writeMemory(
        {
          ...ANA,
          validFrom: "2026-01-01",
          invalidAt: "2026-10-15",
          pinned: true,
          abstract: "A irmã.",
        },
        { at: "2026-10-01T01:00:00Z" },
      );
      await index.applyCommit(vault.commit({ [ANA_PATH]: written.text }));
      expect(index.current(ANA_PATH)).toMatchObject({
        id: written.id,
        scope: "global",
        kind: "person",
        tier: "semantic",
        level: "explicit",
        confidence: 0.9,
        evergreen: false,
        pinned: true,
        validFrom: Date.parse("2026-01-01T00:00:00Z"),
        invalidAt: Date.parse("2026-10-15T00:00:00Z"),
        title: "Ana Souza",
        abstract: "A irmã.",
        warnings: [],
      });
      expect(index.dump().entities).toEqual([
        {
          path: ANA_PATH,
          commit: index.current(ANA_PATH)?.commit,
          key: "ana souza",
          name: "Ana Souza",
        },
        { path: ANA_PATH, commit: index.current(ANA_PATH)?.commit, key: "lisboa", name: "Lisboa" },
      ]);
    });
  });
});

describe("ordering", () => {
  it("applies concurrent commits one at a time, in call order", async () => {
    await withIndex("concurrent", async (index) => {
      const vault = new FakeVault();
      const c1 = vault.commit({ "memory/notes/p.md": "# P\n\none" });
      const c2 = vault.commit({ "memory/notes/p.md": "# P\n\ntwo" });
      const c3 = vault.commit({ "memory/notes/p.md": null });
      await index.applyCommit(c1);
      // c3 has nothing to hash, so without serialization it would overtake c2.
      await Promise.all([index.applyCommit(c2), index.applyCommit(c3)]);
      expect(index.current("memory/notes/p.md")).toBeNull();
      expect(index.dump().commits.map((c) => c.sha)).toEqual([c1.sha, c2.sha, c3.sha]);
    });
  });

  it("finishes a rebuild before a commit that arrives during it", async () => {
    await withIndex("rebuild-race", async (index) => {
      const vault = new FakeVault();
      const c1 = vault.commit({ "memory/notes/a.md": "# A" });
      const c2 = vault.commit({ "memory/notes/b.md": "# B" });
      const c3 = vault.commit({ "memory/notes/a.md": null });
      await Promise.all([index.rebuild([c1, c2]), index.applyCommit(c3)]);
      expect(index.dump().commits.map((c) => c.sha)).toEqual([c1.sha, c2.sha, c3.sha]);
      expect(index.current("memory/notes/a.md")).toBeNull();
      expect(index.lastCommit()?.sha).toBe(c3.sha);
    });
  });

  it("keeps ingestion time moving forward when commit times don't", async () => {
    await withIndex("clock", async (index) => {
      const at = (sha: string, committedAt: number, changes: Record<string, string | null>) =>
        index.applyCommit({
          sha,
          committedAt,
          changes: Object.entries(changes).map(([path, content]) => ({ path, content })),
        });
      await at("c1", 10_000, { "memory/notes/p.md": "# P\n\nalpha" });
      await at("c2", 30_000, { "memory/notes/p.md": null });
      await at("c3", 20_000, { "memory/notes/p.md": "# P\n\nalpha again" });
      expect(index.current("memory/notes/p.md")?.recordedAt).toBe(30_001);
      expect(index.search("alpha", { asOf: 25_000 }).map((hit) => hit.commit)).toEqual(["c1"]);
      // Two commits in the same millisecond: the first stays visible at its own time.
      await at("c4", 40_000, { "memory/notes/q.md": "# Q\n\nbeta" });
      await at("c5", 40_000, { "memory/notes/q.md": "# Q\n\ngamma" });
      expect(index.versionAt("memory/notes/q.md", 40_000)?.commit).toBe("c4");
      expect(index.versionAt("memory/notes/q.md", 40_001)?.commit).toBe("c5");
    });
  });

  it("takes the blob SHA from the caller when it has git's", async () => {
    await withIndex("blob-sha", async (index) => {
      const content = "\u{FEFF}# BOM\n";
      await index.applyCommit({
        sha: "c1",
        committedAt: 1,
        changes: [{ path: "memory/notes/bom.md", content, blobSha: "a".repeat(40) }],
      });
      expect(index.current("memory/notes/bom.md")?.blobSha).toBe("a".repeat(40));
      await index.applyCommit({
        sha: "c2",
        committedAt: 2,
        changes: [{ path: "memory/notes/plain.md", content: "# Plain\n" }],
      });
      // `git hash-object` of "# Plain\n".
      expect(index.current("memory/notes/plain.md")?.blobSha).toBe(
        "adf3919bcec218dd4aabbca517159195c3d04d3f",
      );
    });
  });
});

describe("search", () => {
  it("matches Portuguese with or without accents, and the path's words", async () => {
    await withIndex("search", async (index) => {
      const vault = new FakeVault();
      await index.applyCommit(
        vault.commit({
          "memory/preferences/cafe.md": "# Café\n\nPrefere café sem açúcar, de manhã.",
          "memory/places/sao-joao-del-rei.md": "# Cidade natal\n\nOnde a família passa o Natal.",
          "memory/notes/outra.md": "# Outra\n\nNada a ver.",
        }),
      );
      expect(index.search("acucar").map((hit) => hit.path)).toEqual(["memory/preferences/cafe.md"]);
      expect(index.search("Açúcar no CAFÉ?").map((hit) => hit.path)).toEqual([
        "memory/preferences/cafe.md",
      ]);
      expect(index.search("joão").map((hit) => hit.path)).toEqual([
        "memory/places/sao-joao-del-rei.md",
      ]);
      expect(index.search('" OR * NEAR(').length).toBe(0);
      expect(index.search("")).toEqual([]);
      expect(index.search("natal café", { limit: 1 })).toHaveLength(1);
      expect(index.search("natal café", { limit: -1 })).toHaveLength(1);
      // The path's words are searchable, its extension isn't.
      expect(index.search("md")).toEqual([]);
    });
  });

  it("filters by world time when asked", async () => {
    await withIndex("valid-at", async (index) => {
      const vault = new FakeVault();
      await index.applyCommit(
        vault.commit({
          "memory/commitments/viagem.md":
            "---\nvalid_from: 2026-11-01\ninvalid_at: 2026-11-10\n---\n# Viagem a Lisboa",
          "memory/commitments/consulta.md": "# Consulta em Lisboa",
        }),
      );
      const at = (date: string) =>
        index
          .search("Lisboa", { validAt: Date.parse(date) })
          .map((hit) => hit.path)
          .sort();
      expect(at("2026-10-31T23:59:59Z")).toEqual(["memory/commitments/consulta.md"]);
      expect(at("2026-11-05T00:00:00Z")).toEqual([
        "memory/commitments/consulta.md",
        "memory/commitments/viagem.md",
      ]);
      expect(at("2026-11-10T00:00:00Z")).toEqual(["memory/commitments/consulta.md"]);
    });
  });
});

describe("merged notes (#112)", () => {
  it("are left out of every lookup, and a link to one leads where it went", async () => {
    await withIndex("merged", async (index) => {
      const vault = new FakeVault();
      const ana = await writeMemory(ANA, { at: "2026-10-01T01:00:00Z" });
      const stub = "memory/notes/ana-souza.md";
      const linking = "memory/notes/familia.md";
      await index.applyCommit(
        vault.commit({
          [ANA_PATH]: ana.text,
          [stub]: [
            "---",
            "entities:",
            "  - Ana Souza",
            "relations:",
            "  merged_into:",
            `    - "[[${ANA_PATH.slice(0, -3)}]]"`,
            "---",
            "# Ana Souza",
            "",
            `Merged into [[${ANA_PATH.slice(0, -3)}]]. Ana desenha capas de livros.`,
          ].join("\n"),
          [linking]: "# Família\n\nVer [[memory/notes/ana-souza]].",
          // Outside the scopes below, its mark has no say there.
          "areas/health/notes/terapia.md":
            '---\nrelations:\n  merged_into:\n    - "[[areas/health/notes/sessoes]]"\n---\n# Terapia\n',
          "areas/health/notes/sessoes.md": "# Sessões\n",
          "memory/notes/visita.md": "---\nentities:\n  - Terapia\n---\n# Visita\n",
          // A mark that leads nowhere, to the note itself, to another scope, or by name, hides
          // nothing.
          "memory/notes/sem-destino.md":
            '---\nrelations:\n  merged_into:\n    - "[[memory/notes/nenhum]]"\n---\n# Sem destino\n\nNinguém sabe.\n',
          "memory/notes/eu-mesmo.md":
            '---\nrelations:\n  merged_into:\n    - "[[memory/notes/eu-mesmo]]"\n---\n# Eu mesmo\n\nSó eu.\n',
          "memory/notes/alem.md":
            '---\nrelations:\n  merged_into:\n    - "[[areas/health/notes/sessoes]]"\n---\n# Além\n',
          // Its own name, which namesakes share, in another scope and in its own.
          "memory/notes/sessoes.md":
            '---\nrelations:\n  merged_into:\n    - "[[sessoes]]"\n---\n# Sessões aqui\n',
          "memory/people/sessoes.md": "# Sessões, a pessoa\n",
          // The first mark leads nowhere; the second counts.
          "memory/notes/gama.md": `---\nrelations:\n  merged_into:\n    - "[[memory/notes/aaa]]"\n    - "[[${ANA_PATH.slice(0, -3)}]]"\n---\n# Gama\n`,
          "memory/notes/liga-gama.md": "# Liga\n\nVer [[memory/notes/gama]].",
          // Past the link cap, the mark still counts.
          "memory/notes/muitos-links.md": `---\nrelations:\n  merged_into:\n    - "[[${ANA_PATH.slice(0, -3)}]]"\n---\n# Muitos links\n\n${Array.from({ length: 520 }, (_, i) => `[[n${i}]]`).join(" ")}\n`,
        }),
      );
      const paths = (hits: readonly { path: string }[]) => hits.map((hit) => hit.path);
      expect(paths(index.search("capas de livros"))).toEqual([]);
      expect(paths(index.titled("Ana Souza"))).toEqual([ANA_PATH]);
      expect(paths(index.entityHits(["ana souza"]))).toEqual([ANA_PATH]);
      expect(paths(index.lifecycleNotes())).not.toContain(stub);
      const blob = index.current(stub)?.blobSha ?? "";
      expect(index.embeddingTexts("m").map((item) => item.blobSha)).not.toContain(blob);
      index.putEmbeddings("m", [
        { blobSha: blob, vector: [1, 0] },
        { blobSha: index.current(ANA_PATH)?.blobSha ?? "", vector: [1, 0] },
      ]);
      expect(paths(index.vectorHits("m", [1, 0]))).toEqual([ANA_PATH]);
      expect(index.mergedInto(stub)).toBe(ANA_PATH);
      for (const path of [
        "memory/notes/sem-destino.md",
        "memory/notes/eu-mesmo.md",
        "memory/notes/alem.md",
        "memory/notes/sessoes.md",
      ]) {
        expect(index.mergedInto(path)).toBeNull();
        expect(paths(index.lifecycleNotes())).toContain(path);
      }
      expect(paths(index.search("Ninguém sabe"))).toEqual(["memory/notes/sem-destino.md"]);
      expect(paths(index.titled("Muitos links"))).toEqual([]);
      // A note to read by its path still, and one step away it's the note it went into.
      expect(index.current(stub)?.title).toBe("Ana Souza");
      expect(paths(index.neighbours(linking))).toEqual([ANA_PATH]);
      expect(index.neighbours(stub)).toEqual([]);
      expect(index.mergedInto("memory/notes/gama.md")).toBe(ANA_PATH);
      // The other way: the notes whose mark counts and leads to a note.
      expect(index.mergedFrom(ANA_PATH)).toEqual([
        stub,
        "memory/notes/gama.md",
        "memory/notes/muitos-links.md",
      ]);
      expect(index.mergedFrom("areas/health/notes/sessoes.md")).toEqual([
        "areas/health/notes/terapia.md",
      ]);
      expect(index.mergedFrom("memory/notes/eu-mesmo.md")).toEqual([]);
      expect(paths(index.neighbours("memory/notes/liga-gama.md"))).toEqual([ANA_PATH]);
      expect(paths(index.neighbours("memory/notes/visita.md"))).toEqual([
        "areas/health/notes/sessoes.md",
      ]);
      expect(index.neighbours("memory/notes/visita.md", { scopes: ["global"] })).toEqual([]);
    });
  });
});

describe("links", () => {
  it("resolve as Obsidian does, and backlinks follow them", async () => {
    await withIndex("links", async (index) => {
      const vault = new FakeVault();
      await index.applyCommit(
        vault.commit({
          "memory/people/ana.md":
            "# Ana\n\nMora em [[Lisboa]]; ver [[memory/places/Porto]] e [[Ninguém]].",
          "memory/places/lisboa.md": "# Lisboa",
          "knowledge/viagens/lisboa.md": "# Lisboa (notas)\n\nCom [[ana]] e [[Lisboa]].",
          "memory/places/porto.md": "---\nsources: ['[[ana]]']\n---\n# Porto",
        }),
      );
      expect(index.links("memory/people/ana.md")).toEqual([
        { kind: "link", by: "name", target: "lisboa", path: "memory/places/lisboa.md" },
        { kind: "link", by: "name", target: "ninguém", path: null },
        { kind: "link", by: "path", target: "memory/places/porto", path: "memory/places/porto.md" },
      ]);
      // Two notes are named lisboa: each note's own folder wins, then the shorter path.
      expect(index.resolve("knowledge/viagens/lisboa.md", "name", "lisboa")).toBe(
        "knowledge/viagens/lisboa.md",
      );
      expect(index.resolve("memory/people/ana.md", "name", "lisboa")).toBe(
        "memory/places/lisboa.md",
      );
      expect(index.backlinks("memory/people/ana.md")).toEqual([
        "knowledge/viagens/lisboa.md",
        "memory/places/porto.md",
      ]);
      expect(index.backlinks("memory/places/lisboa.md")).toEqual(["memory/people/ana.md"]);
      expect(index.backlinks("knowledge/viagens/lisboa.md")).toEqual([
        "knowledge/viagens/lisboa.md",
      ]);
    });
  });
});

describe("rebuild", () => {
  /** A vault's life: Kelpie's writes, the owner's edits in Obsidian, removals and a replay. */
  async function live(index: MemoryIndex): Promise<FakeVault> {
    const vault = new FakeVault();
    const apply = async (changes: Record<string, string | null>) =>
      index.applyCommit(vault.commit(changes));
    const v1 = await writeMemory(ANA, { at: "2026-10-01T01:00:00Z" });
    await apply({
      [ANA_PATH]: v1.text,
      "memory/places/lisboa.md": "# Lisboa\n\nCidade da [[Ana Souza]].",
      "knowledge/receitas.md": "# Receitas\n\nBolo de fubá.",
      "agents/kelpie/SOUL.md": "# Persona",
    });
    const v2 = await writeMemory(
      { ...ANA, body: "Mudou-se para o [[Porto]].", entities: ["Ana Souza", "Porto"] },
      { at: "2026-10-01T02:00:00Z", existing: v1.text },
    );
    await apply({ [ANA_PATH]: v2.text, "memory/places/porto.md": "# Porto" });
    // The owner edits in Obsidian: a comment in the frontmatter, a new note, a removal.
    await apply({
      [ANA_PATH]: v2.text.replace("kind: person\n", "kind: person # checked\n"),
      "areas/work/decisions/fornecedor.md":
        "---\nkind: decision\nconfidence: 2\n---\nFornecedor X.",
      "knowledge/receitas.md": null,
    });
    // A webhook delivered twice, and a commit that changes nothing indexed.
    const last = vault.history.at(-1);
    if (last) await index.applyCommit(last);
    await apply({ "README.md": "# Vault" });
    await apply({ "knowledge/receitas.md": "# Receitas\n\nPão de queijo." });
    return vault;
  }

  it("replaying the vault's history gives the same index", async () => {
    let incremental: IndexDump | undefined;
    let vault: FakeVault | undefined;
    await withIndex("rebuild-live", async (index) => {
      vault = await live(index);
      incremental = index.dump();
    });
    if (!incremental || !vault) throw new Error("setup failed");
    // Ana three times, Lisboa, Porto, the decision, and the recipes twice.
    expect(incremental.versions.length).toBe(8);
    const history = vault.history;
    await withIndex("rebuild-fresh", async (index) => {
      await index.rebuild(history);
      expect(index.dump()).toEqual(incremental);
    });
  });

  it("rebuilding in place gives the same index and keeps only the embeddings still in use", async () => {
    await withIndex("rebuild-in-place", async (index, storage) => {
      const vault = await live(index);
      const before = index.dump();
      storage.sql.exec(
        "INSERT INTO embeddings (blob_sha, model, dims, vector) VALUES (?, ?, ?, ?)",
        before.versions[0]?.blobSha ?? "",
        "bge-m3",
        3,
        new Float32Array([0.5, -1, 2]).buffer,
      );
      // A vector of content no version holds any more, such as text erased from git's history.
      storage.sql.exec(
        "INSERT INTO embeddings (blob_sha, model, dims, vector) VALUES ('gone', 'bge-m3', 1, ?)",
        new ArrayBuffer(4),
      );
      await index.rebuild(vault.history);
      expect(index.dump()).toEqual(before);
      expect(
        storage.sql.exec<{ blob_sha: string }>("SELECT blob_sha FROM embeddings").toArray(),
      ).toEqual([{ blob_sha: before.versions[0]?.blobSha }]);
      const vector = storage.sql
        .exec<{ vector: ArrayBuffer }>("SELECT vector FROM embeddings")
        .one().vector;
      expect(Array.from(new Float32Array(vector))).toEqual([0.5, -1, 2]);
      // The full-text index was rebuilt with the rows: superseded text is found "as of", not now.
      expect(index.search("Lisboa").map((hit) => hit.path)).toEqual(["memory/places/lisboa.md"]);
      expect(
        index.search("design", { asOf: vault.history[0]?.committedAt ?? 0 }).map((hit) => hit.path),
      ).toEqual([ANA_PATH]);
    });
  });

  it("rebuilding from the head alone gives the same current notes", async () => {
    let current: unknown;
    let vault: FakeVault | undefined;
    const strip = (dump: IndexDump) =>
      dump.versions
        .filter((v) => v.current)
        .map(({ commit, supersedes, recordedAt, ...rest }) => rest);
    await withIndex("head-live", async (index) => {
      vault = await live(index);
      current = strip(index.dump());
    });
    if (!vault) throw new Error("setup failed");
    const snapshot = vault.snapshot();
    await withIndex("head-fresh", async (index) => {
      await index.rebuild([snapshot]);
      expect(strip(index.dump())).toEqual(current);
    });
  });
});
