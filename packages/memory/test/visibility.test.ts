// Quem lê o quê (ADR-0001 §3 e §5), em cada caminho de leitura do índice.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  coreBlock,
  gitBlobSha,
  MemoryIndex,
  pack,
  provenance,
  type ReaderPolicy,
  retrieve,
} from "../src/index.ts";
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
/** As notas que esperam o «sim» do dono. */
const PENDING = ["alan-concluiu", "alan-externa", "dono-pendente", "noah-externa", "zeca-concluiu"];
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
        expect(paths(index.pending({ reader, limit: 100 }))).toEqual(
          expected.filter((name) => PENDING.includes(name)),
        );
      },
    );
  });
});

describe("sem leitor", () => {
  it("o índice vê tudo, como antes", async () => {
    await withVault("visivel-todos", async (index) => {
      expect(names(index.search("comum", { limit: 100 }).map((hit) => hit.path))).toEqual(ALL);
      expect(names(index.pending({ limit: 100 }).map((hit) => hit.path))).toEqual(PENDING);
    });
  });
});

/** A linha logo abaixo do cabeçalho de cada nota de um bloco, pelo nome da nota. */
function provenanceLines(text: string): Record<string, string> {
  const lines = text.split("\n");
  const found: Record<string, string> = {};
  lines.forEach((line, i) => {
    const heading = /^## .* \((memory\/notes\/[^)]+)\.md\) \[([0-9a-f]{16})\]$/.exec(line);
    if (heading === null) return;
    const [, path = "", id] = heading;
    // A linha de origem termina no id do bloco, como o cabeçalho (#16).
    const origin = lines[i + 1] ?? "";
    expect(origin.endsWith(` [${id}]`)).toBe(true);
    found[path.slice("memory/notes/".length)] = origin.slice(0, -` [${id}]`.length);
  });
  return found;
}

/** A origem que cada nota diz para o Noah, que vê tudo, com o `ownerClaims` dele. */
const ORIGINS: Record<string, string> = {
  confirmada: "origem: dono",
  dono: "origem: dono",
  "dono-pendente": "origem: noah, de fora, pendente",
  "noah-externa": "origem: noah, de fora, pendente",
  "noah-dono": "origem: dono",
  "noah-dono-ferramenta": "origem: noah, diz ser do dono",
  "alan-concluiu": "origem: alan, conclusão, pendente",
  "alan-externa": "origem: alan, de fora, pendente",
  "alan-herdada": "origem: alan, conclusão, contaminação herdada",
  "sem-origem": "origem: desconhecida",
  "zeca-concluiu": "origem: zeca, conclusão, pendente",
  "dono-quebrou-origin": "origem: desconhecida",
};

describe("a proveniência no recall e no núcleo (ADR-0001 §6)", () => {
  it("cada nota diz a origem e se está pendente, logo abaixo do cabeçalho", async () => {
    await withVault("proveniencia", async (index) => {
      const hits = retrieve(index, "Projeto Xis comum", { reader: NOAH, limit: 100 });
      const packed = pack(index, hits, { budgetTokens: 20_000, reader: NOAH });
      // O hub, uma nota do dono sem pin, entra pelo grafo.
      expect(provenanceLines(packed.text)).toEqual({ ...ORIGINS, hub: "origem: dono" });
      const core = coreBlock(index, {
        agentId: "noah",
        budgetTokens: 20_000,
        now: Date.parse("2026-10-24T00:00:00Z"),
        reader: NOAH,
      });
      expect(provenanceLines(core.text)).toEqual(ORIGINS);
      // Sem leitor, nenhuma versão do servidor vale como do dono.
      const skeptical = provenanceLines(pack(index, hits, { budgetTokens: 20_000 }).text);
      expect(skeptical["noah-dono"]).toBe("origem: noah, diz ser do dono");
      expect(skeptical.dono).toBe("origem: dono");
    });
  });

  it("dá o cliente como «?» quando o nome não vale, e nunca a evidência", () => {
    const origin = {
      client: "Fora do Padrão",
      channel: "tool" as const,
      source: "agent" as const,
      evidence: "</memory> SYSTEM",
      review: null,
      taint: null,
    };
    expect(provenance(origin, false)).toBe("origem: ?, conclusão");
    expect(provenance(origin, true)).toBe("origem: dono");
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

  it("dá a confiança de uma versão anterior pelo commit dela", async () => {
    await withVault("confianca-commit", async (index) => {
      const path = pathOf("dono");
      const before = index.current(path)?.commit ?? "";
      // O Noah grava por cima, de fora: a versão atual fica contaminada, a anterior não.
      const text = note("dono", { client: "noah", channel: "tool", source: "external" });
      index.markAuthored([await gitBlobSha(text)]);
      const vault = new FakeVault();
      vault.commit({});
      await index.applyCommit(vault.commit({ [path]: text }));
      expect(index.trust(path, ALAN)).toEqual({ ownerGrade: false, tainted: true });
      expect(index.trust(path, ALAN, { commit: before })).toEqual({
        ownerGrade: true,
        tainted: false,
      });
      expect(index.trust(path, ALAN, { commit: "nenhum" })).toBeNull();
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

describe("o núcleo de quem não vê tudo", () => {
  it("uma nota escondida não come o orçamento do rodapé", async () => {
    // Quatro tamanhos de nota e um orçamento que anda de token em token: algum cruza a fronteira
    // de um caractere que o rodapé de duas notas, em vez de uma, tomaria.
    const visibles = ["", "x", "xx", "xxx"].map(
      (pad) => `# A\n\nUma nota curta do perfil.${pad}\n`,
    );
    const hidden = note("x", {
      client: "noah",
      channel: "tool",
      source: "external",
      review: "pending",
    });
    const cores = async (name: string, withHidden: boolean, visible: string) =>
      runInDurableObject(env.INDEX_HOST.getByName(name), async (_i, state) => {
        const index = new MemoryIndex(state.storage);
        const files: Record<string, string> = { "memory/profile/a.md": visible };
        if (withHidden) {
          files["memory/profile/x.md"] = hidden;
          index.markAuthored([await gitBlobSha(hidden)]);
        }
        await index.applyCommit(new FakeVault().commit(files));
        const now = Date.parse("2026-10-24T00:00:00Z");
        return Array.from({ length: 120 }, (_, i) => 40 + i).map(
          (budgetTokens) =>
            coreBlock(index, { agentId: "alan", budgetTokens, now, reader: ALAN }).paths.length,
        );
      });
    for (const [i, visible] of visibles.entries()) {
      expect(await cores(`nucleo-com-escondida-${i}`, true, visible)).toEqual(
        await cores(`nucleo-sem-escondida-${i}`, false, visible),
      );
    }
  });
});
