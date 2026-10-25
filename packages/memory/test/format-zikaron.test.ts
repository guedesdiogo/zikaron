// Zikaron's format (#6): the `origin` block, the new kinds and the archive.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  coreBlock,
  gitBlobSha,
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

describe("the origin block", () => {
  it("is written by the writer and read back whole", async () => {
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

  it("omits the empty keys", async () => {
    const { text } = await writeMemory(
      { ...CAFE, origin: { ...NOAH, evidence: null } },
      { at: AT },
    );
    expect(text).toContain(
      "origin:\n  client: noah\n  channel: provider\n  source: owner\nupdated:",
    );
  });

  it.each([
    ["an unknown key", { ...NOAH, trusted: true }],
    ["a client outside the pattern", { ...NOAH, client: "Noah Bot" }],
    ["an unknown channel", { ...NOAH, channel: "git" }],
    ["an unknown source", { ...NOAH, source: "diogo" }],
    ["a review that isn't pending", { ...NOAH, review: "approved" }],
    ["a taint that isn't inherited", { ...NOAH, taint: "yes" }],
    ["evidence on two lines", { ...NOAH, evidence: "a\nb" }],
    ["evidence that is too long", { ...NOAH, evidence: "x".repeat(301) }],
    ["a list", [NOAH]],
  ])("is ignored whole with %s, and the note stays indexable", (_label, origin) => {
    expect(parseOrigin(origin)).toBeNull();
    const note = readNote(
      "memory/notes/cafe.md",
      `---\norigin: ${JSON.stringify(origin)}\n---\n\n# Café\n\nx\n`,
    );
    expect(note?.origin).toBeNull();
    expect(note?.warnings).toContain("`origin` is invalid; ignored");
  });

  it("the writer refuses an invalid origin", async () => {
    await expect(
      writeMemory({ ...CAFE, origin: { ...NOAH, client: "" } }, { at: AT }),
    ).rejects.toThrow(MemoryFormatError);
  });
});

describe("the new kinds", () => {
  it("have their own folder and default tier", async () => {
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

  it("a task and a delegation carry a status", async () => {
    const { text } = await writeMemory(
      { ...CAFE, kind: "task", title: "Renovar o passaporte", status: "open" },
      { at: AT },
    );
    expect(readNote("memory/tasks/renovar-o-passaporte.md", text)?.status).toBe("open");
    await expect(writeMemory({ ...CAFE, status: "done" }, { at: AT })).rejects.toThrow(
      "`status` is only for a task or a delegation",
    );
  });

  it("a document keeps the link and the subject, never the content", async () => {
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

  it("the reader ignores an invalid status or link, with a warning", () => {
    const task = readNote(
      "memory/tasks/x.md",
      "---\nstatus: maybe\narchived: sim\n---\n\n# X\n\ny\n",
    );
    expect(task).toMatchObject({ status: null, archived: false });
    expect(task?.warnings).toEqual([
      "`archived` is invalid; ignored",
      "`status` is invalid; ignored",
    ]);
    const document = readNote("memory/documents/x.md", "---\nlink: ftp://x\n---\n\n# X\n\ny\n");
    expect(document?.link).toBeNull();
    expect(document?.warnings).toEqual(["`link` is invalid; ignored"]);
    expect(readNote("memory/documents/y.md", "# Y\n\nz")?.warnings).toEqual([
      "a document has no `link`",
    ]);
  });

  it("a link with a control or a bidirectional mark is invalid", async () => {
    const spoofed = "https://example.com/\u202Egpj.exe";
    expect(
      readNote("memory/documents/x.md", `---\nlink: ${JSON.stringify(spoofed)}\n---\n\n# X\n\ny\n`)
        ?.link,
    ).toBeNull();
    await expect(
      writeMemory({ ...CAFE, kind: "document", body: "x", link: spoofed }, { at: AT }),
    ).rejects.toThrow("`link` must be one http(s) URL");
  });

  it("in other kinds, status and link are the owner's keys: not read, not removed", async () => {
    const owners = "---\nstatus: rascunho\nlink: algum lugar\n---\n\n# Ideia\n\nx\n";
    const note = readNote("memory/notes/ideia.md", owners);
    expect(note).toMatchObject({ status: null, link: null, warnings: [] });
    const { text } = await writeMemory(
      { ...CAFE, kind: "note", title: "Ideia", body: "y" },
      { at: AT, existing: owners },
    );
    expect(text).toContain("status: rascunho");
    expect(text).toContain("link: algum lugar");
    await expect(writeMemory({ ...CAFE, link: "https://example.com" }, { at: AT })).rejects.toThrow(
      "`link` is only for a document",
    );
  });
});

describe("the archive", () => {
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

  it("takes the note out of search, titles, entities and neighbours", async () => {
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

  it("shows up when asked for directly: includeArchived, the path and the links", async () => {
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

  it("leaves the core and the lifecycle jobs, even when pinned", async () => {
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

  it("a note archived today doesn't come back in a search of the past", async () => {
    await withIndex("arquivo-passado", async (index) => {
      const vault = new FakeVault();
      const before = await writeMemory(CAFE, { at: AT });
      const path = memoryPath("global", "preference", CAFE.title);
      const c1 = vault.commit({ [path]: before.text });
      await index.applyCommit(c1);
      const after = await writeMemory(
        { ...CAFE, archived: true },
        { at: AT, existing: before.text },
      );
      await index.applyCommit(vault.commit({ [path]: after.text }));
      const asOf = { asOf: c1.committedAt };
      expect(index.search("café açúcar", asOf)).toEqual([]);
      expect(index.titled(CAFE.title, asOf)).toEqual([]);
      expect(index.search("café açúcar", { ...asOf, includeArchived: true })).toHaveLength(1);
    });
  });

  it("with includeArchived, the archived note has neighbours", async () => {
    await withIndex("arquivo-vizinhos", async (index) => {
      const vault = new FakeVault();
      const archived = await writeMemory(
        { ...ARCHIVED, body: "Antes preferia café com leite. Ver [[cafes]]." },
        { at: AT },
      );
      await index.applyCommit(
        vault.commit({ [ARCHIVED_PATH]: archived.text, [LINKING_PATH]: "# Cafés\n\nx" }),
      );
      expect(index.neighbours(ARCHIVED_PATH)).toEqual([]);
      expect(
        index.neighbours(ARCHIVED_PATH, { includeArchived: true }).map((hit) => hit.path),
      ).toEqual([LINKING_PATH]);
    });
  });

  it("the rebuild reproduces the new columns", async () => {
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

describe("Zikaron's lifecycle (#17)", () => {
  const TASK: MemoryInput = {
    scope: "global",
    kind: "task",
    title: "Renovar o passaporte",
    body: "Renovar o passaporte antes da viagem.",
    level: "inferred",
    confidence: 0.8,
    status: "done",
    origin: { ...NOAH, channel: "tool", source: "agent", evidence: null, review: "pending" },
  };

  it("lifecycle notes give the status, the origin's client and whether it's pending", async () => {
    await withIndex("ciclo-notas", async (index) => {
      const task = await writeMemory(TASK, { at: AT });
      await index.applyCommit(
        new FakeVault().commit({
          "memory/tasks/renovar-o-passaporte.md": task.text,
          "memory/notes/solta.md": "# Solta\n\nUma nota do dono.\n",
        }),
      );
      expect(
        index.lifecycleNotes().map(({ path, status, originClient, pending }) => ({
          path,
          status,
          originClient,
          pending,
        })),
      ).toEqual([
        { path: "memory/notes/solta.md", status: null, originClient: null, pending: false },
        {
          path: "memory/tasks/renovar-o-passaporte.md",
          status: "done",
          originClient: "noah",
          pending: true,
        },
      ]);
    });
  });

  it("lists what the server wrote as said by the owner, through the provider, since an instant", async () => {
    await withIndex("ciclo-donos", async (index) => {
      const vault = new FakeVault();
      const said = (title: string, origin: Origin, at = AT) =>
        writeMemory({ ...CAFE, title, origin }, { at });
      const first = await said("Café sem açúcar", NOAH);
      const second = await said("Café sem açúcar, de novo", NOAH);
      // The routine's archive carries the `origin` forward: with `except`, it isn't a new write.
      const archived = await said("Café sem açúcar, arquivada", NOAH);
      // An `updated` from before the instant: a rebuilt index doesn't make it new.
      const old = await said("Chá verde", NOAH, "2026-09-01T00:00:00Z");
      const tool = await said("Pão integral", { ...NOAH, channel: "tool" });
      const agent = await said("Bolo de fubá", { ...NOAH, source: "agent", review: "pending" });
      const alan = await said("Água com gás", { ...NOAH, client: "alan", evidence: null });
      // The same block in an owner's blob: the owner wrote it, not the provider.
      const owners = await said("Suco de laranja", NOAH);
      index.markAuthored(
        await Promise.all(
          [first, second, archived, old, tool, agent, alan].map((note) => gitBlobSha(note.text)),
        ),
      );
      // 2026-10-01T01:00: before the instant.
      await index.applyCommit(vault.commit({ "memory/preferences/cafe.md": first.text }));
      const since = Date.parse("2026-10-01T01:30:00Z");
      await index.applyCommit(
        vault.commit({
          "memory/preferences/cafe.md": second.text,
          "memory/preferences/cha.md": old.text,
          "memory/preferences/pao.md": tool.text,
          "memory/preferences/bolo.md": agent.text,
          "memory/preferences/agua.md": alan.text,
          "memory/preferences/suco.md": owners.text,
        }),
      );
      // A new version, no longer the owner's, doesn't erase the one that was.
      await index.applyCommit(vault.commit({ "memory/preferences/agua.md": agent.text }));
      await index.applyCommit(vault.commit({ "memory/preferences/cafe.md": archived.text }));
      const at = Date.parse("2026-10-01T02:00:00Z");
      const last = Date.parse("2026-10-01T04:00:00Z");
      const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);
      const agua = {
        path: "memory/preferences/agua.md",
        title: "Água com gás",
        client: "alan",
        at,
      };
      expect(index.ownerClaimsSince(since).sort(byPath)).toEqual([
        agua,
        {
          path: "memory/preferences/cafe.md",
          title: "Café sem açúcar, arquivada",
          client: "noah",
          at: last,
        },
      ]);
      expect(index.ownerClaimsSince(since, [await gitBlobSha(archived.text)]).sort(byPath)).toEqual(
        [
          agua,
          {
            path: "memory/preferences/cafe.md",
            title: "Café sem açúcar, de novo",
            client: "noah",
            at,
          },
        ],
      );
      expect(index.ownerClaimsSince(last + 1)).toEqual([]);
    });
  });
});
