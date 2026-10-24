// O escritor de notas: o que uma nova versão leva da anterior (#6, e o que o Kelpie leva), e o que o
// cofre confere de um pedido que chega pelo RPC.
import { beforeEach, describe, expect, it } from "vitest";
import { flush, tool, useAccess, v1, vaultStub, vaultWith } from "./access.ts";

beforeEach(async () => {
  await useAccess();
});

describe("uma nova versão", () => {
  it("leva o que a anterior tinha e a memória deixou de fora", async () => {
    const path = "areas/casa/tasks/presente-da-ana.md";
    const backend = vaultWith({
      [path]: [
        "---",
        "id: tarefa-fixa",
        "tier: semantic",
        "confidence: 0.6",
        "sources:",
        '  - "[[2026-10-01-conversa]]"',
        "entities:",
        "  - Ana Souza",
        "valid_from: 2026-10-01",
        "evergreen: true",
        "pinned: true",
        "abstract: Comprar o presente da Ana.",
        "relations:",
        "  contradicts:",
        '    - "[[presente-antigo]]"',
        "status: open",
        "cor: azul",
        "---",
        "",
        "# Presente da Ana",
        "",
        "Comprar um livro.",
        "",
      ].join("\n"),
    });
    const version = (await v1("noah", "read", { path })).body.version as string;
    const written = await v1("noah", "write", {
      source: "owner",
      evidence: "telegram:msg/77",
      path,
      version,
      title: "Presente da Ana",
      body: "Comprar um livro de receitas.",
      kind: "task",
    });
    expect(written.body).toMatchObject({ ok: true, action: "written", path });
    await flush();
    const file = backend.files()[path] ?? "";
    for (const kept of [
      "id: tarefa-fixa",
      "tier: semantic",
      "confidence: 0.6",
      "[[2026-10-01-conversa]]",
      "  - Ana Souza",
      "valid_from: 2026-10-01",
      "evergreen: true",
      "pinned: true",
      "abstract: Comprar o presente da Ana.",
      "[[presente-antigo]]",
      "status: open",
      "cor: azul",
      "Comprar um livro de receitas.",
    ]) {
      expect(file, kept).toContain(kept);
    }
    // A página de uma task diz o status dela, e a origem.
    const page = (await v1("alan", "read", { path })).body;
    expect(page.text).toContain(" · pinned · status open · origem: dono · ");
    const done = await v1("noah", "write", {
      source: "owner",
      path,
      version: page.version,
      title: "Presente da Ana",
      body: "Comprar um livro de receitas.",
      kind: "task",
      status: "done",
      entities: ["Ana Souza", "Livraria"],
      abstract: "Presente comprado.",
      confidence: 0.9,
    });
    expect(done.body).toMatchObject({ ok: true, action: "written" });
    await flush();
    const after = backend.files()[path] ?? "";
    expect(after).toContain("status: done");
    expect(after).toContain("  - Livraria");
    expect(after).toContain("abstract: Presente comprado.");
    expect(after).toContain("confidence: 0.9");
  });

  it("arquiva um documento com o link dele, que a página mostra", async () => {
    const backend = vaultWith();
    const written = await tool("alan", "memory_write", {
      source: "agent",
      title: "Contrato do apartamento",
      body: "O contrato de aluguel do apartamento.",
      kind: "document",
      link: "https://example.com/contrato",
    });
    expect(written.isError).toBe(false);
    const path = "memory/documents/contrato-do-apartamento.md";
    await flush();
    const version = (await v1("alan", "read", { path })).body.version as string;
    expect((await v1("alan", "archive", { path, version })).body).toMatchObject({
      ok: true,
      action: "written",
    });
    await flush();
    expect(backend.files()[path]).toContain("archived: true");
    expect(backend.files()[path]).toContain("link: https://example.com/contrato");
    const page = (await v1("alan", "read", { path })).body.text as string;
    expect(page).toContain("\nlink https://example.com/contrato\n");
    expect(page).toContain(" · archived · ");
  });
});

describe("o que chega pelo RPC", () => {
  const memory = { title: "A", body: "B", kind: "note" };

  it("recusa um claim ou uma memória que não valem, sem ler nem gravar", async () => {
    const backend = vaultWith();
    const stub = vaultStub();
    for (const [claim, problem] of [
      [null, "the claim isn't valid"],
      [{ channel: "email", source: "agent" }, "`channel` is invalid"],
      [{ channel: "tool", source: "agent", evidence: 5 }, "`evidence` must be text"],
      [
        { channel: "tool", source: "agent", evidence: "x".repeat(2_001) },
        "`evidence` must be text",
      ],
      [{ channel: "tool", source: "agent", context: "x".repeat(101) }, "`context` must be text"],
    ] as const) {
      const answer = await stub.writeNote("alan", claim as never, memory);
      expect(answer).toEqual({
        ok: false,
        reason: "invalid",
        problems: [expect.stringContaining(problem)],
      });
      expect(await stub.archiveNote("alan", claim as never, "memory/notes/a.md", "0")).toEqual(
        answer,
      );
    }
    const claim = { channel: "tool", source: "agent" } as const;
    expect(await stub.writeNote("alan", claim, null as never)).toEqual({
      ok: false,
      reason: "invalid",
      problems: ["the memory isn't valid"],
    });
    const long = `memory/notes/${"x".repeat(300)}.md`;
    expect(await stub.writeNote("alan", claim, { ...memory, path: long })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await stub.readNote("alan", long)).toEqual({ ok: false, reason: "not_found" });
    expect(await stub.forgetNote("alan", long)).toEqual({ ok: false, reason: "not_found" });
    expect(await stub.archiveNote("alan", claim, long, "0123456789ab")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect((await stub.writeNote("alan", claim, { ...memory, title: 7 as never })).ok).toBe(false);
    await flush();
    expect(backend.commitRequests).toHaveLength(0);
  });

  it("um orçamento nulo é o padrão, e um caminho que o escopo não aceita é recusado", async () => {
    vaultWith();
    expect((await v1("alan", "core", { budgetTokens: null })).status).toBe(200);
    expect(
      (await v1("alan", "write", { source: "agent", ...memory, scope: "area/a:b" })).body,
    ).toEqual({ ok: false, reason: "invalid", problems: ["the note's path can't be written"] });
  });
});
