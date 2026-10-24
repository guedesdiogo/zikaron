// O formato do Zikaron (#6): o bloco `origin`, os tipos novos e o arquivo.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  coreBlock,
  MemoryFormatError,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  type Origin,
  parseOrigin,
  readNote,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

const AT = "2026-10-24T12:00:00Z";

const NOAH: Origin = {
  client: "noah",
  channel: "provider",
  source: "owner",
  evidence: "telegram:msg/123",
  review: null,
  taint: null,
};

const CAFE: MemoryInput = {
  scope: "global",
  kind: "preference",
  title: "Café sem açúcar",
  body: "Prefere café sem açúcar.",
  level: "explicit",
  confidence: 0.9,
  entities: ["Café"],
  origin: NOAH,
};

async function withIndex(name: string, run: (index: MemoryIndex) => Promise<void>) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    await run(new MemoryIndex(state.storage));
  });
}

describe("o bloco origin", () => {
  it("é escrito pelo escritor e lido de volta inteiro", async () => {
    const { text } = await writeMemory(
      { ...CAFE, origin: { ...NOAH, review: "pending", taint: "inherited" } },
      { at: AT },
    );
    expect(text).toContain(
      "origin:\n  client: noah\n  channel: provider\n  source: owner\n  evidence: telegram:msg/123\n  review: pending\n  taint: inherited\n",
    );
    const note = readNote(memoryPath("global", "preference", CAFE.title), text);
    expect(note?.origin).toEqual({ ...NOAH, review: "pending", taint: "inherited" });
    expect(note?.warnings).toEqual([]);
  });

  it("omite as chaves vazias", async () => {
    const { text } = await writeMemory(
      { ...CAFE, origin: { ...NOAH, evidence: null } },
      { at: AT },
    );
    expect(text).toContain(
      "origin:\n  client: noah\n  channel: provider\n  source: owner\nupdated:",
    );
  });

  it.each([
    ["uma chave desconhecida", { ...NOAH, trusted: true }],
    ["um cliente fora do padrão", { ...NOAH, client: "Noah Bot" }],
    ["um canal desconhecido", { ...NOAH, channel: "git" }],
    ["uma fonte desconhecida", { ...NOAH, source: "diogo" }],
    ["um review que não é pending", { ...NOAH, review: "approved" }],
    ["um taint que não é inherited", { ...NOAH, taint: "yes" }],
    ["uma evidência em duas linhas", { ...NOAH, evidence: "a\nb" }],
    ["uma evidência longa demais", { ...NOAH, evidence: "x".repeat(301) }],
    ["uma lista", [NOAH]],
  ])("é ignorado inteiro com %s, e a nota continua indexável", (_label, origin) => {
    expect(parseOrigin(origin)).toBeNull();
    const note = readNote(
      "memory/notes/cafe.md",
      `---\norigin: ${JSON.stringify(origin)}\n---\n\n# Café\n\nx\n`,
    );
    expect(note?.origin).toBeNull();
    expect(note?.warnings).toContain("`origin` is invalid; ignored");
  });

  it("o escritor recusa um origin inválido", async () => {
    await expect(
      writeMemory({ ...CAFE, origin: { ...NOAH, client: "" } }, { at: AT }),
    ).rejects.toThrow(MemoryFormatError);
  });
});

describe("os tipos novos", () => {
  it("têm pasta e tier padrão próprios", async () => {
    expect(memoryPath("global", "task", "Renovar o passaporte")).toBe(
      "memory/tasks/renovar-o-passaporte.md",
    );
    expect(memoryPath("agent/noah", "delegation", "Revisar o PR")).toBe(
      "agents/noah/memory/delegations/revisar-o-pr.md",
    );
    expect(memoryPath("global", "document", "Contrato")).toBe("memory/documents/contrato.md");
    const task = readNote("memory/tasks/x.md", "# X\n\ny");
    const document = readNote("memory/documents/x.md", "# X\n\ny");
    expect([task?.kind, task?.tier]).toEqual(["task", "episodic"]);
    expect([document?.kind, document?.tier]).toEqual(["document", "semantic"]);
  });

  it("uma tarefa e uma delegação levam status", async () => {
    const { text } = await writeMemory(
      { ...CAFE, kind: "task", title: "Renovar o passaporte", status: "open" },
      { at: AT },
    );
    expect(readNote("memory/tasks/renovar-o-passaporte.md", text)?.status).toBe("open");
    await expect(writeMemory({ ...CAFE, status: "done" }, { at: AT })).rejects.toThrow(
      "`status` is only for a task or a delegation",
    );
  });

  it("um documento guarda o link e o assunto, nunca o conteúdo", async () => {
    const document: MemoryInput = {
      ...CAFE,
      kind: "document",
      title: "Contrato de aluguel",
      body: "Contrato do apartamento, assinado em outubro.",
      link: "https://drive.example.com/file/d/abc",
    };
    const { text } = await writeMemory(document, { at: AT });
    expect(readNote("memory/documents/contrato-de-aluguel.md", text)?.link).toBe(document.link);
    const { link: _link, ...withoutLink } = document;
    await expect(writeMemory(withoutLink, { at: AT })).rejects.toThrow(
      "a document needs its `link`",
    );
    await expect(writeMemory({ ...document, body: "x".repeat(2_001) }, { at: AT })).rejects.toThrow(
      "never its content",
    );
    await expect(
      writeMemory({ ...document, link: "javascript:alert(1)" }, { at: AT }),
    ).rejects.toThrow("`link` must be one http(s) URL");
  });

  it("o leitor ignora um status ou um link inválido, com aviso", () => {
    const note = readNote(
      "memory/tasks/x.md",
      "---\nstatus: maybe\nlink: ftp://x\narchived: sim\n---\n\n# X\n\ny\n",
    );
    expect(note).toMatchObject({ status: null, link: null, archived: false });
    expect(note?.warnings).toEqual([
      "`archived` is invalid; ignored",
      "`status` is invalid; ignored",
      "`link` is invalid; ignored",
    ]);
  });
});

describe("o arquivo", () => {
  const ARCHIVED: MemoryInput = {
    ...CAFE,
    title: "Café com leite",
    body: "Antes preferia café com leite.",
    archived: true,
    pinned: true,
  };
  const ARCHIVED_PATH = memoryPath("global", "preference", ARCHIVED.title);
  const LINKING_PATH = "memory/notes/cafes.md";

  async function seed(index: MemoryIndex) {
    const vault = new FakeVault();
    const archived = await writeMemory(ARCHIVED, { at: AT });
    const current = await writeMemory(CAFE, { at: AT });
    await index.applyCommit(
      vault.commit({
        [ARCHIVED_PATH]: archived.text,
        [memoryPath("global", "preference", CAFE.title)]: current.text,
        [LINKING_PATH]: "# Cafés\n\nVer [[cafe-com-leite]].",
      }),
    );
  }

  it("tira a nota da busca, dos títulos, das entidades e dos vizinhos", async () => {
    await withIndex("arquivo-busca", async (index) => {
      await seed(index);
      const paths = (hits: { path: string }[]) => hits.map((hit) => hit.path);
      expect(paths(index.search("café leite"))).not.toContain(ARCHIVED_PATH);
      expect(paths(index.titled(ARCHIVED.title))).toEqual([]);
      expect(paths(index.entityHits(["cafe"]))).not.toContain(ARCHIVED_PATH);
      expect(paths(index.neighbours(LINKING_PATH))).not.toContain(ARCHIVED_PATH);
      expect(index.neighbours(ARCHIVED_PATH)).toEqual([]);
    });
  });

  it("aparece quando pedida diretamente: includeArchived, o caminho e os links", async () => {
    await withIndex("arquivo-direto", async (index) => {
      await seed(index);
      expect(
        index.search("café leite", { includeArchived: true }).map((hit) => hit.path),
      ).toContain(ARCHIVED_PATH);
      expect(index.current(ARCHIVED_PATH)).toMatchObject({ archived: true, origin: NOAH });
      const link = index.links(LINKING_PATH).find((each) => each.kind === "link");
      expect(link?.path).toBe(ARCHIVED_PATH);
      expect(index.resolve(LINKING_PATH, "name", link?.target ?? "")).toBe(ARCHIVED_PATH);
    });
  });

  it("sai do núcleo e dos jobs do ciclo de vida, mesmo pinned", async () => {
    await withIndex("arquivo-nucleo", async (index) => {
      await seed(index);
      expect(index.lifecycleNotes().map((note) => note.path)).not.toContain(ARCHIVED_PATH);
      const core = coreBlock(index, { agentId: "noah", budgetTokens: 1_000, now: Date.parse(AT) });
      expect(core.paths).not.toContain(ARCHIVED_PATH);
      expect(index.embeddingTexts("m").map((item) => item.text)).not.toContainEqual(
        expect.stringContaining("café com leite"),
      );
    });
  });

  it("o rebuild reproduz as colunas novas", async () => {
    await withIndex("arquivo-rebuild", async (index) => {
      const vault = new FakeVault();
      const archived = await writeMemory(ARCHIVED, { at: AT });
      await index.applyCommit(vault.commit({ [ARCHIVED_PATH]: archived.text }));
      const before = index.dump();
      await index.rebuild(vault.history);
      expect(index.dump()).toEqual(before);
      expect(before.versions[0]).toMatchObject({ archived: true, origin: NOAH, status: null });
    });
  });
});
