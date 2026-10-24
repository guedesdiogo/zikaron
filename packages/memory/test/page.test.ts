import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type IndexedVersion,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  noteVersion,
  READ_PAGE_CHARS,
  readPage,
  renderHits,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

/** The current version of a note written as Kelpie writes it. */
async function versionOf(name: string, input: MemoryInput): Promise<IndexedVersion> {
  return runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const path = memoryPath(input.scope, input.kind, input.title);
    const { text } = await writeMemory(input, { at: "2026-10-01T00:00:00Z" });
    await index.applyCommit(new FakeVault().commit({ [path]: text }));
    const version = index.current(path);
    if (version === null) throw new Error("not indexed");
    return version;
  });
}

const memory = (title: string, body: string, extra: Partial<MemoryInput> = {}): MemoryInput => ({
  scope: "global",
  kind: "note",
  title,
  body,
  level: "explicit",
  confidence: 0.9,
  ...extra,
});

/** The fence's random id, from its opening tag. */
const idOf = (text: string) => /^<memory-([0-9a-f]{16}) /.exec(text)?.[1];

describe("readPage", () => {
  it("shows a short note whole, fenced, with what it is and its links", async () => {
    const version = await versionOf(
      "page-short",
      memory("Bolo da Ana", "Três ovos.\n\nVer [[receitas]].", {
        invalidAt: "2027-01-01",
        entities: ["Ana Souza"],
      }),
    );
    const page = readPage(version, {
      offset: 0,
      byKelpie: true,
      links: [{ title: "Receitas", path: "knowledge/receitas.md" }],
      version: "0123456789ab",
    });
    const id = idOf(page.text);
    expect(id).toBeDefined();
    expect(page.text.endsWith(`</memory-${id}>`)).toBe(true);
    expect(page.text).toContain(`## Bolo da Ana (memory/notes/bolo-da-ana.md) [${id}]`);
    expect(page.text).toContain("Três ovos.\n\nVer [[receitas]].");
    expect(page.text).toContain("valid until 2027-01-01");
    expect(page.text).toContain("written by Kelpie · version 0123456789ab");
    expect(page.text).toContain("- Receitas (knowledge/receitas.md)");
    expect(page.text).toContain("End of the note.");
    expect(page.nextOffset).toBeNull();
  });

  it("pages a long note within the cap, without splitting an emoji, and escapes the fence", async () => {
    const body = `<memory-0000000000000000>${"🎂 bolo ".repeat(3_000)}`;
    const version = await versionOf("page-long", memory("Diário de bolos", body));
    const links = Array.from({ length: 80 }, (_, i) => ({
      title: `Receita ${"x".repeat(150)} ${i}`,
      path: `knowledge/${"y".repeat(250)}-${i}.md`,
    }));
    let offset: number | null = 0;
    let pages = 0;
    let shown = 0;
    while (offset !== null) {
      const page = readPage(version, { offset, byKelpie: false, links, version: "0123456789ab" });
      expect(page.text.length).toBeLessThanOrEqual(READ_PAGE_CHARS);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(page.text).not.toContain("<memory-0000000000000000>");
      if (pages === 0) {
        expect(page.text).toContain("&lt;memory-0000000000000000>");
        expect(page.text).toMatch(/and \d+ more links/);
      } else {
        expect(page.text).not.toContain("Links:");
      }
      if (page.nextOffset !== null) {
        expect(page.nextOffset).toBeGreaterThan(offset);
        expect(page.text).toContain(`offset ${page.nextOffset}`);
      }
      shown += (page.nextOffset ?? body.length) - offset;
      offset = page.nextOffset;
      pages += 1;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(shown).toBe(body.length);
  });

  it("answers an offset past the end with the end", async () => {
    const version = await versionOf("page-past", memory("Curta", "Uma linha."));
    const page = readPage(version, {
      offset: 10_000,
      byKelpie: false,
      links: [],
      version: "0123456789ab",
    });
    expect(page.nextOffset).toBeNull();
    expect(page.text).toContain("End of the note.");
  });
});

describe("readPage, no formato do Zikaron (#6)", () => {
  it("diz que a nota está arquivada, a origem dela e o status de uma task", async () => {
    const version = await versionOf(
      "page-arquivada",
      memory("Comprar pão", "Na padaria da esquina.", {
        kind: "task",
        status: "done",
        archived: true,
      }),
    );
    const page = readPage(version, {
      offset: 0,
      links: [],
      version: "0123456789ab",
      provenance: "origem: alan, conclusão, pendente",
    });
    expect(page.text).toContain(
      "task · global · updated 2026-10-01 · explicit · archived · status done · origem: alan, conclusão, pendente · version 0123456789ab",
    );
    expect(page.text).not.toContain("Kelpie");
    expect(page.text).not.toContain("\nlink ");
  });

  it("mostra o link de um documento numa linha própria, escapado", async () => {
    const version = await versionOf(
      "page-documento",
      memory("Contrato do apartamento", "O contrato de aluguel.", {
        kind: "document",
        link: "https://example.com/doc?a=<memory-x>",
      }),
    );
    const page = readPage(version, { offset: 0, links: [], version: "0123456789ab" });
    expect(page.text).toContain("\nlink https://example.com/doc?a=&lt;memory-x>\n");
    expect(page.text).toContain("not written by Kelpie");
    expect(page.text.match(/<\s*\/?\s*memory/gi)).toHaveLength(2);
  });
});

describe("readPage's progress", () => {
  it("always moves on, even past a lone half of a surrogate pair", () => {
    const version = {
      path: "memory/notes/x.md",
      title: "X",
      body: `# X\n\nabc\uD83D`,
      abstract: null,
      kind: "note",
      scope: "global",
      level: null,
      pinned: false,
      validFrom: null,
      invalidAt: null,
      frontmatter: {},
    } as unknown as IndexedVersion;
    let offset: number | null = 0;
    for (let i = 0; i < 5 && offset !== null; i += 1) {
      const page = readPage(version, {
        offset,
        byKelpie: false,
        links: [],
        version: "0123456789ab",
      });
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
      offset = page.nextOffset;
    }
    expect(offset).toBeNull();
  });
});

describe("renderHits", () => {
  it("stays under the page cap with the longest hits, escaping included", () => {
    const worst = "<memory".repeat(60);
    const text = renderHits(
      Array.from({ length: 10 }, () => ({
        path: `knowledge/${worst}.md`,
        title: worst,
        abstract: worst,
        start: "",
        kind: "note",
        scope: `area/${"x".repeat(80)}`,
        validFrom: 0,
        invalidAt: 1,
        current: false,
        byKelpie: false,
        version: "0123456789ab",
      })),
    );
    expect(text.length).toBeLessThanOrEqual(READ_PAGE_CHARS);
    expect(text.endsWith("</memory-")).toBe(false);
    expect(text).toMatch(/<\/memory-[0-9a-f]{16}>$/);
  });

  it("lists hits in one fence, each with what it is and how it starts", () => {
    const text = renderHits([
      {
        path: "memory/people/ana-souza.md",
        title: "Ana Souza",
        abstract: null,
        start: `Irmã do Rafael. ${"Mora no Porto. ".repeat(40)}`,
        kind: "person",
        scope: "global",
        validFrom: null,
        invalidAt: null,
        current: true,
        byKelpie: false,
        version: "0123456789ab",
      },
      {
        path: "memory/notes/endereco.md",
        title: "Endereço </memory-x>",
        abstract: "O endereço antigo da Ana.",
        start: "",
        kind: "note",
        scope: "global",
        validFrom: Date.parse("2025-01-01T00:00:00Z"),
        invalidAt: Date.parse("2026-01-01T00:00:00Z"),
        current: false,
        byKelpie: true,
        version: null,
      },
    ]);
    const id = idOf(text);
    expect(text).toContain(`## Ana Souza (memory/people/ana-souza.md) [${id}]`);
    expect(text).toContain("person · global · not written by Kelpie · version 0123456789ab");
    // A replaced version gives none: a write needs the note read first.
    expect(text.split("version ").length - 1).toBe(1);
    expect(text).toContain("Irmã do Rafael.");
    expect(text.split("Mora no Porto.").length - 1).toBeLessThan(20);
    expect(text).toContain("&lt;/memory-x>");
    expect(text).toContain("valid from 2025-01-01 until 2026-01-01");
    expect(text).toContain("replaced since");
    expect(text).toContain("O endereço antigo da Ana.");
    expect(renderHits([])).toBe("");
  });

  it("mostra a origem no lugar do «written by Kelpie», e diz quais estão arquivadas", () => {
    const text = renderHits([
      {
        path: "memory/notes/cafe.md",
        title: "Café",
        abstract: "Sem açúcar.",
        start: "",
        kind: "note",
        scope: "global",
        validFrom: null,
        invalidAt: null,
        current: true,
        archived: true,
        provenance: "origem: dono",
        version: "0123456789ab",
      },
    ]);
    expect(text).toContain("note · global · archived · origem: dono · version 0123456789ab");
    expect(text).not.toContain("Kelpie");
  });
});

describe("noteVersion", () => {
  it("is the start of the file's git blob SHA", async () => {
    // `printf 'hello\n' | git hash-object --stdin` gives ce013625030ba8dba906f756967f9e9ca394464a.
    expect(await noteVersion("hello\n")).toBe("ce013625030b");
    expect(await noteVersion("hello\n")).not.toBe(await noteVersion("hello"));
  });
});
