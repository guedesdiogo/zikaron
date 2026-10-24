// Quem lê o quê (ADR-0001 §3 e §5), em cada caminho de leitura do índice.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { coreBlock, gitBlobSha, MemoryIndex, type ReaderPolicy, retrieve } from "../src/index.ts";
import { FakeVault } from "./vault.ts";

type Origin = Record<string, string>;

/** Uma nota fixada no escopo global, que fala de «Projeto Xis» e aponta para o hub. */
function note(title: string, origin: Origin | null): string {
  const block =
    origin === null
      ? ""
      : `origin:\n${Object.entries(origin)
          .map(([key, value]) => `  ${key}: ${value}`)
          .join("\n")}\n`;
  return `---\npinned: true\nentities:\n  - Projeto Xis\n${block}---\n\n# ${title}\n\nNota comum sobre o Projeto Xis. Ver [[memory/notes/hub]].\n`;
}

/** As notas de teste: o nome diz de onde cada uma veio; `authored` diz se o servidor a escreveu. */
const NOTES: Record<string, { origin: Origin | null; authored: boolean }> = {
  dono: { origin: null, authored: false },
  "dono-pendente": {
    origin: { client: "noah", channel: "tool", source: "external", review: "pending" },
    authored: false,
  },
  confirmada: { origin: { client: "noah", channel: "tool", source: "external" }, authored: false },
  "noah-externa": {
    origin: { client: "noah", channel: "tool", source: "external", review: "pending" },
    authored: true,
  },
  "noah-dono": { origin: { client: "noah", channel: "provider", source: "owner" }, authored: true },
  "noah-dono-ferramenta": {
    origin: { client: "noah", channel: "tool", source: "owner" },
    authored: true,
  },
  "alan-concluiu": {
    origin: { client: "alan", channel: "tool", source: "agent", review: "pending" },
    authored: true,
  },
  "alan-externa": {
    origin: { client: "alan", channel: "tool", source: "external", review: "pending" },
    authored: true,
  },
  "alan-herdada": {
    origin: { client: "alan", channel: "tool", source: "agent", taint: "inherited" },
    authored: true,
  },
  "sem-origem": { origin: null, authored: true },
  // Um cliente que saiu da configuração (ou nunca esteve nela) conta como `exposed`.
  "zeca-concluiu": {
    origin: { client: "zeca", channel: "tool", source: "agent", review: "pending" },
    authored: true,
  },
  // O dono editou uma nota pendente de fora e deixou o `origin` quebrado: não é um «sim».
  "dono-quebrou-origin": {
    origin: { client: "noah", channel: "tool", source: "external", extra: "x" },
    authored: false,
  },
};
const pathOf = (name: string) => `memory/notes/${name}.md`;
const HUB = pathOf("hub");
const ALL = Object.keys(NOTES).sort();

const policy = (
  client: string,
  mode: ReaderPolicy["mode"],
  ownerClaims: string[] = ["noah"],
): ReaderPolicy => ({ client, mode, trusted: ["alan", "kelpie"], ownerClaims });

const NOAH = policy("noah", "exposed");
const ALAN = policy("alan", "privileged");
const ALAN_SEM_CLAIMS = policy("alan", "privileged", []);
const KELPIE = policy("kelpie", "plain");

/** O que cada leitor deve ver. */
const EXPECTED: [string, ReaderPolicy, string[]][] = [
  ["exposed (noah)", NOAH, ALL],
  ["privileged (alan)", ALAN, ["alan-concluiu", "confirmada", "dono", "noah-dono"].sort()],
  ["privileged sem ownerClaims", ALAN_SEM_CLAIMS, ["alan-concluiu", "confirmada", "dono"].sort()],
  [
    "plain (kelpie)",
    KELPIE,
    ["alan-concluiu", "alan-externa", "alan-herdada", "confirmada", "dono", "noah-dono"].sort(),
  ],
];

async function withVault(name: string, run: (index: MemoryIndex) => Promise<void>) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    const files: Record<string, string> = {
      [HUB]: `# Hub\n\n${ALL.map((name) => `[[${pathOf(name).slice(0, -3)}]]`).join(" ")}\n`,
    };
    const authored: string[] = [];
    for (const [name, { origin, authored: byServer }] of Object.entries(NOTES)) {
      const text = note(name, origin);
      files[pathOf(name)] = text;
      if (byServer) authored.push(await gitBlobSha(text));
    }
    index.markAuthored(authored);
    await index.applyCommit(vault.commit(files));
    await run(index);
  });
}

const names = (paths: readonly string[]) =>
  paths
    .filter((path) => path !== HUB)
    .map((path) => path.slice("memory/notes/".length, -3))
    .sort();

describe.each(EXPECTED)("o leitor %s", (_label, reader, expected) => {
  it("vê o mesmo conjunto em todo caminho de leitura do índice", async () => {
    await withVault(
      `visivel-${reader.client}-${reader.mode}-${reader.ownerClaims.length}`,
      async (index) => {
        const paths = (hits: { path: string }[]) => names(hits.map((hit) => hit.path));
        expect(paths(index.search("comum", { reader, limit: 100 }))).toEqual(expected);
        expect(paths(index.entityHits(["projeto xis"], { reader, limit: 100 }))).toEqual(expected);
        expect(
          names(ALL.filter((name) => index.titled(name, { reader }).length > 0).map(pathOf)),
        ).toEqual(expected);
        expect(
          names(ALL.map(pathOf).filter((path) => index.current(path, { reader }) !== null)),
        ).toEqual(expected);
        expect(paths(index.neighbours(HUB, { reader, limit: 100 }))).toEqual(expected);
        expect(
          names(
            index
              .links(HUB, { reader })
              .map((link) => link.path)
              .filter((path): path is string => path !== null),
          ),
        ).toEqual(expected);
        expect(names(index.backlinks(HUB, { reader }))).toEqual(expected);
        const core = coreBlock(index, {
          agentId: reader.client,
          budgetTokens: 10_000,
          now: Date.parse("2026-10-24T00:00:00Z"),
          reader,
        });
        expect(names(core.paths)).toEqual(expected);
        const recalled = await retrieve(index, "Projeto Xis comum", { reader, limit: 100 });
        expect(paths(recalled)).toEqual(expected);
      },
    );
  });
});

describe("sem leitor", () => {
  it("o índice vê tudo, como antes", async () => {
    await withVault("visivel-todos", async (index) => {
      expect(names(index.search("comum", { limit: 100 }).map((hit) => hit.path))).toEqual(ALL);
    });
  });
});

describe("a confiança de uma nota", () => {
  it("diz se ela vale como do dono e se está contaminada, pela configuração atual", async () => {
    await withVault("confianca", async (index) => {
      const trust = (name: string, reader: ReaderPolicy) => index.trust(pathOf(name), reader);
      expect(trust("dono", ALAN)).toEqual({ ownerGrade: true, tainted: false });
      expect(trust("confirmada", ALAN)).toEqual({ ownerGrade: true, tainted: false });
      expect(trust("noah-dono", ALAN)).toEqual({ ownerGrade: true, tainted: false });
      expect(trust("noah-dono", ALAN_SEM_CLAIMS)).toEqual({ ownerGrade: false, tainted: true });
      expect(trust("noah-externa", ALAN)).toEqual({ ownerGrade: false, tainted: true });
      expect(trust("alan-concluiu", ALAN)).toEqual({ ownerGrade: false, tainted: false });
      expect(trust("alan-herdada", ALAN)).toEqual({ ownerGrade: false, tainted: true });
      expect(trust("sem-origem", ALAN)).toEqual({ ownerGrade: false, tainted: true });
      expect(index.trust("memory/notes/nada.md", ALAN)).toBeNull();
    });
  });

  it("o registro do que o servidor escreveu sobrevive a um rebuild", async () => {
    await withVault("confianca-rebuild", async (index) => {
      await index.rebuild([]);
      expect(index.trust(pathOf("noah-externa"), ALAN)).toBeNull();
      const vault = new FakeVault();
      await index.applyCommit(
        vault.commit({
          [pathOf("noah-externa")]: note("noah-externa", NOTES["noah-externa"]?.origin ?? null),
        }),
      );
      expect(index.trust(pathOf("noah-externa"), ALAN)).toEqual({
        ownerGrade: false,
        tainted: true,
      });
    });
  });
});

describe("as falhas que a revisão do PR #11 achou", () => {
  it("um frontmatter quebrado com `origin` não vale como do dono; sem `origin`, vale", async () => {
    await runInDurableObject(
      env.INDEX_HOST.getByName("frontmatter-quebrado"),
      async (_i, state) => {
        const index = new MemoryIndex(state.storage);
        const comOrigin =
          "---\norigin:\n  client: noah\n  source: external\ntags: [a\n---\n\n# A\n\nx\n";
        const semOrigin = "---\ntags: [a\n---\n\n# B\n\nx\n";
        await index.applyCommit(
          new FakeVault().commit({ [pathOf("a")]: comOrigin, [pathOf("b")]: semOrigin }),
        );
        expect(index.current(pathOf("a"), { reader: ALAN })).toBeNull();
        expect(index.trust(pathOf("a"), ALAN)).toEqual({ ownerGrade: false, tainted: true });
        expect(index.current(pathOf("b"), { reader: ALAN })).not.toBeNull();
        expect(index.trust(pathOf("b"), ALAN)).toEqual({ ownerGrade: true, tainted: false });
      },
    );
  });

  it("os links de uma nota que o leitor não vê não aparecem", async () => {
    await withVault("links-invisiveis", async (index) => {
      expect(index.links(pathOf("noah-externa"), { reader: ALAN })).toEqual([]);
      expect(index.links(pathOf("noah-externa"), { reader: NOAH })).not.toEqual([]);
    });
  });
});
