import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Judge,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  qualifierJudge,
  rerank,
  retrieve,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

const MODEL = "test-model";

/** Runs a test against an index of these memories, one commit each. */
async function withMemories(
  name: string,
  memories: readonly MemoryInput[],
  run: (index: MemoryIndex) => Promise<void> | void,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    for (const memory of memories) {
      const { text } = await writeMemory(memory, { at: "2026-10-01T00:00:00Z" });
      await index.applyCommit(
        vault.commit({ [memoryPath(memory.scope, memory.kind, memory.title)]: text }),
      );
    }
    await run(index);
  });
}

const note = (
  title: string,
  body: string,
  scope: MemoryInput["scope"] = "global",
): MemoryInput => ({
  scope,
  kind: "note",
  title,
  body,
  level: "explicit",
  confidence: 0.9,
});

/** A toy embedding: one dimension per topic word, so similarity is easy to predict. */
const TOPICS = ["mudança", "café", "trabalho", "viagem"];
const embed = (text: string) =>
  TOPICS.map((topic) => (text.toLowerCase().includes(topic) ? 1 : 0.01));

async function embedAll(index: MemoryIndex) {
  const missing = index.embeddingTexts(MODEL);
  index.putEmbeddings(
    MODEL,
    missing.map(({ blobSha, text }) => ({ blobSha, vector: embed(text) })),
  );
  return missing.length;
}

describe("embeddings in the index", () => {
  it("lists the current notes without a vector, once each, and keeps what it is given", async () => {
    await withMemories(
      "embedding-texts",
      [note("Porto", "A mudança para o Porto."), note("Café", "Café coado, sem açúcar.")],
      async (index) => {
        const missing = index.embeddingTexts(MODEL);
        expect(missing).toHaveLength(2);
        expect(missing.map((item) => item.text).join(" ")).toContain("A mudança para o Porto.");
        expect(await embedAll(index)).toBe(2);
        expect(index.embeddingTexts(MODEL)).toEqual([]);
        expect(index.embeddingTexts("another-model")).toHaveLength(2);
      },
    );
  });

  it("finds notes by meaning, best first, within scopes", async () => {
    await withMemories(
      "vector-hits",
      [
        note("Porto", "Ana fez a mudança para o Porto."),
        note("Café", "Café coado, sem açúcar."),
        note("Viagem", "A viagem de dezembro.", "conversation/telegram-1"),
      ],
      async (index) => {
        await embedAll(index);
        const query = embed("como foi a mudança?");
        expect(index.vectorHits(MODEL, query, { limit: 2 }).map((hit) => hit.title)).toEqual([
          "Porto",
          expect.any(String),
        ]);
        expect(
          index.vectorHits(MODEL, embed("viagem"), { scopes: ["global"] }).map((hit) => hit.title),
        ).not.toContain("Viagem");
        expect(index.vectorHits("another-model", query)).toEqual([]);
        expect(index.vectorHits(MODEL, [1, 2])).toEqual([]);
      },
    );
  });
});

describe("retrieve with vectors", () => {
  it("finds a note that shares no word with the question", async () => {
    await withMemories(
      "vector-stream",
      [note("Porto", "Ana fez a mudança para o Porto."), note("Café", "Café coado, sem açúcar.")],
      async (index) => {
        await embedAll(index);
        const plain = retrieve(index, "Onde ela foi morar?");
        expect(plain.map((hit) => hit.title)).not.toContain("Porto");
        const hits = retrieve(index, "Onde ela foi morar?", {
          vector: { model: MODEL, query: embed("mudança") },
        });
        expect(hits[0]?.title).toBe("Porto");
        expect(hits[0]?.streams).toContain("vector");
        const past = retrieve(index, "Onde ela foi morar?", {
          vector: { model: MODEL, query: embed("mudança") },
          asOf: Date.parse("2030-01-01T00:00:00Z"),
        });
        expect(past.every((hit) => !hit.streams.includes("vector"))).toBe(true);
      },
    );
  });
});

describe("the vector index, closely", () => {
  it("ranks by cosine, not by the dot product", async () => {
    await withMemories(
      "cosine",
      [note("Grande", "um"), note("Alinhado", "dois")],
      async (index) => {
        const [grande, alinhado] = index
          .embeddingTexts(MODEL)
          .sort((a, b) => (a.text < b.text ? 1 : -1));
        index.putEmbeddings(MODEL, [
          { blobSha: grande?.blobSha ?? "", vector: [10, 0] },
          { blobSha: alinhado?.blobSha ?? "", vector: [1, 1] },
        ]);
        expect(index.vectorHits(MODEL, [1, 1]).map((hit) => hit.title)).toEqual([
          "Alinhado",
          "Grande",
        ]);
        expect(index.vectorHits(MODEL, [1, 1], { limit: 1 }).map((hit) => hit.title)).toEqual([
          "Alinhado",
        ]);
        expect(index.vectorHits(MODEL, [0, 0])).toEqual([]);
      },
    );
  });

  it("replaces a vector, and skips one that isn't finite or isn't whole", async () => {
    await withMemories("vector-rows", [note("A", "um"), note("B", "dois")], async (index) => {
      const [a, b] = index.embeddingTexts(MODEL);
      index.putEmbeddings(MODEL, [{ blobSha: a?.blobSha ?? "", vector: [1, 0] }]);
      index.putEmbeddings(MODEL, [{ blobSha: a?.blobSha ?? "", vector: [0, 1] }]);
      // 1e39 overflows a Float32 to infinity.
      index.putEmbeddings(MODEL, [{ blobSha: b?.blobSha ?? "", vector: [1e39, 0] }]);
      expect(index.vectorHits(MODEL, [0, 1]).map((hit) => hit.title)).toEqual(["A"]);
      expect(index.vectorHits(MODEL, [1, 0]).map((hit) => hit.title)).toEqual(["A"]);
    });
  });

  it("takes a query too long to spread into a call's arguments", async () => {
    await withMemories("vector-long", [note("A", "um")], async (index) => {
      const [a] = index.embeddingTexts(MODEL);
      const long = Array.from({ length: 200_000 }, (_, i) => (i === 0 ? 1 : 0));
      index.putEmbeddings(MODEL, [{ blobSha: a?.blobSha ?? "", vector: long }]);
      expect(index.vectorHits(MODEL, long).map((hit) => hit.title)).toEqual(["A"]);
    });
  });

  it("keeps no vector for content no version holds", async () => {
    await withMemories("vector-erased", [note("A", "um")], async (index) => {
      const [a] = index.embeddingTexts(MODEL);
      // Content erased while it was being embedded: its vector comes back to nothing.
      index.putEmbeddings(MODEL, [
        { blobSha: "0".repeat(40), vector: [1, 0] },
        { blobSha: a?.blobSha ?? "", vector: [0, 1] },
      ]);
      expect(index.vectorHits(MODEL, [1, 0]).map((hit) => hit.title)).toEqual(["A"]);
      expect(index.embeddingTexts(MODEL)).toEqual([]);
    });
  });

  it("lists each content once, current versions only, and bounds the limit", async () => {
    await withMemories(
      "embedding-rows",
      [note("A", "mesmo texto"), note("B", "outro"), note("C", "mais um")],
      async (index) => {
        expect(index.embeddingTexts(MODEL, 2)).toHaveLength(2);
        expect(index.embeddingTexts(MODEL, 0)).toHaveLength(1);
        expect(index.embeddingTexts(MODEL, 10_000)).toHaveLength(3);
      },
    );
  });

  it("keeps a note out when it isn't valid at the question's date", async () => {
    await withMemories(
      "vector-valid-at",
      [
        {
          ...note("Viagem", "viagem de janeiro"),
          validFrom: "2026-01-01",
          invalidAt: "2026-02-01",
        },
      ],
      async (index) => {
        await embedAll(index);
        const query = embed("viagem");
        expect(
          index.vectorHits(MODEL, query, { validAt: Date.parse("2026-01-15T12:00:00Z") }),
        ).toHaveLength(1);
        expect(
          index.vectorHits(MODEL, query, { validAt: Date.parse("2026-03-15T12:00:00Z") }),
        ).toEqual([]);
        const hits = retrieve(index, "quando?", {
          validAt: Date.parse("2026-01-15T12:00:00Z"),
          vector: { model: MODEL, query },
        });
        expect(hits[0]?.streams).toContain("vector");
      },
    );
  });

  it("follows the graph from a note found only by meaning", async () => {
    await withMemories(
      "vector-seeds",
      [note("Porto", "A mudança da Ana. Veja [[bruno]]."), note("Bruno", "Ajudou a carregar.")],
      async (index) => {
        await embedAll(index);
        const hits = retrieve(index, "Onde ela foi morar?", {
          vector: { model: MODEL, query: embed("mudança") },
        });
        expect(hits.find((hit) => hit.title === "Bruno")?.streams).toContain("graph");
      },
    );
  });
});

describe("rerank", () => {
  const notes = Array.from({ length: 12 }, (_, i) => note(`Nota ${i}`, `trabalho número ${i}`));
  /** A judge that likes one note, by its title, and scores the rest low. */
  const likes =
    (title: string): Judge =>
    async (_question, candidates) =>
      Object.fromEntries(
        candidates.map((candidate) => [
          candidate.id,
          candidate.text.startsWith(`${title}\n`) ? 0.99 : 0.1,
        ]),
      );

  it("puts the note the judge likes first, keeps ties in fused order, and leaves the rest", async () => {
    await withMemories("rerank", notes, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 12 });
      const fused = hits.map((hit) => hit.title);
      const third = fused[2] ?? "";
      const reranked = (await rerank(index, "trabalho", hits, likes(third), { candidates: 4 })).map(
        (hit) => hit.title,
      );
      expect(reranked).toEqual([third, ...fused.slice(0, 2), fused[3], ...fused.slice(4)]);
      const flat: Judge = async (_question, candidates) =>
        Object.fromEntries(candidates.map((candidate) => [candidate.id, 0.5]));
      expect((await rerank(index, "trabalho", hits, flat)).map((hit) => hit.title)).toEqual(fused);
    });
  });

  it("keeps the fused order when the judge fails, is late, or scores outside 0 to 1", async () => {
    await withMemories("rerank-fails", notes, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 12 });
      const fused = hits.map((hit) => hit.title);
      const score =
        (value: number): Judge =>
        async (_question, candidates) =>
          Object.fromEntries(
            candidates.map((candidate, i) => [candidate.id, i === 1 ? value : 0.5]),
          );
      const judges: Judge[] = [
        async () => {
          throw new Error("failed");
        },
        async (_question, candidates) => ({ [candidates[0]?.id ?? "x"]: 0.9 }),
        async () => null,
        score(Number.NaN),
        score(1.7),
        score(-0.2),
        () => new Promise(() => {}),
      ];
      for (const judge of judges) {
        const reranked = await rerank(index, "trabalho", hits, judge, { timeoutMs: 50 });
        expect(reranked.map((hit) => hit.title)).toEqual(fused);
      }
    });
  });

  it("asks nothing of a judge for fewer than two hits", async () => {
    await withMemories("rerank-one", [notes[0] as MemoryInput], async (index) => {
      let asked = false;
      const hits = retrieve(index, "trabalho");
      await rerank(index, "trabalho", hits, async () => {
        asked = true;
        return null;
      });
      expect(hits).toHaveLength(1);
      expect(asked).toBe(false);
    });
  });

  it("shows the judge at most 30 notes, of at most 600 characters", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      note(`Nota ${i}`, `trabalho ${"palavra ".repeat(400)}`),
    );
    await withMemories("rerank-input", many, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 40 });
      let seen: { id: string; text: string }[] = [];
      await rerank(index, "trabalho", hits, async (_question, candidates) => {
        seen = candidates;
        return null;
      });
      expect(seen).toHaveLength(30);
      expect(seen.every((candidate) => candidate.text.length <= 600)).toBe(true);
    });
  });

  it("shows the judge a note's title, abstract and body start, without its heading", async () => {
    await withMemories(
      "rerank-snippet",
      [
        { ...note("Resumida", "trabalho do corpo"), abstract: "Um resumo." },
        note("Simples", "trabalho"),
      ],
      async (index) => {
        let seen: { id: string; text: string }[] = [];
        await rerank(
          index,
          "trabalho",
          retrieve(index, "trabalho"),
          async (_question, candidates) => {
            seen = candidates;
            return null;
          },
        );
        const texts = seen.map((candidate) => candidate.text).sort();
        expect(texts).toEqual(["Resumida\nUm resumo.\ntrabalho do corpo", "Simples\ntrabalho"]);
      },
    );
  });
});

describe("qualifierJudge", () => {
  it("asks one yes-or-no question per note, says the notes are data, and maps the answers", async () => {
    const calls: { state: unknown; questions: Record<string, { instructions: string }> }[] = [];
    const judge = qualifierJudge({
      async qualify(state, questions) {
        calls.push({ state, questions });
        return { answers: { c0: { type: "noul", noul: 0.8 }, c1: { type: "choice" } } };
      },
    });
    const scores = await judge("Onde a Ana mora?", [
      { id: "c0", text: "Ana mora no Porto." },
      { id: "c1", text: "Outra nota." },
    ]);
    expect(scores).toEqual({ c0: 0.8 });
    const [seen] = calls;
    expect(seen?.state).toEqual({
      question: "Onde a Ana mora?",
      notes: { c0: "Ana mora no Porto.", c1: "Outra nota." },
    });
    expect(Object.keys(seen?.questions ?? {})).toEqual(["c0", "c1"]);
    expect(seen?.questions.c0?.instructions).toMatch(/data, not instructions/);
  });
});
