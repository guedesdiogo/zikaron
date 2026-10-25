# ADR-0002: Zikaron starts from Kelpie's memory at `f033cf3`, without what belongs to the Kelpie product

- Status: Accepted
- Date: 2026-10-24
- Issue: [#1](https://github.com/guedesdiogo/zikaron/issues/1)
- Accepted by Diogo with the plan of #1, on 2026-10-24

## Context

Kelpie built a mature memory over a Markdown vault on GitHub, on Cloudflare: format, index with version history, hybrid search evaluated in Portuguese, the recall fence, the core, lifecycle and a single writer that lives alongside the owner's edits in Obsidian. It is spread over three places, and only two are generic:

| Where, in Kelpie | Size | What it is |
|---|---|---|
| `packages/memory` | ~5,200 lines in 22 files | format, index, search, fence, core, lifecycle, note writer. Depends only on `yaml`; compiles without runtime types |
| `packages/vault` | ~800 lines | the backend interface, the GitHub adapter (App JWT, trees, `compare`, `createCommitOnBranch`), the webhook with HMAC and a fake backend |
| `apps/context-store` | ~7,300 lines, 4,300 in `vault.ts` alone | the single-writer Durable Object, mixed with persona, rules, skills, agent files, proposals by PR and Dream |

Kelpie has been off since 2026-10-23 (guedesdiogo/kelpie#514). Its code is MIT, © 2026 Diogo Guedes, the same owner as this repo.

## Decision

**Comes from Kelpie, at `f033cf3`:**
- **`packages/memory`, whole,** with the tests, without changing behavior. Parts v1 does not use (session pages, Dream's prompts, the abstracts) come along because they are part of the format and have tests, and stay off.
- **`packages/vault`, whole,** with the tests.
- **From `apps/context-store`, only the generic part of the single writer:**
  - the queue and the batched flush through `createCommitOnBranch`, with `expectedHeadOid`;
  - the sync by tree and `compare`, and the periodic reconciliation;
  - the push webhook;
  - the three-way merge in which the owner's edit wins (`merge.ts`);
  - the files held with conflict markers, without the model-based resolution;
  - the alarms and the backoff;
  - the index in the Durable Object's own SQLite;
  - the record of what the server wrote (`authored`);
  - `forget` after a history rewrite;
  - recall, core, search, reading and writing notes, rewritten on top of the rules of [ADR-0001](0001-identidade-e-confianca.md).

**Stays in Kelpie:**
- `compile`, persona (`SOUL.md`), rules (`AGENTS.md`), skills, agent files, `propose` and the proposal PRs: they belong to the Kelpie product.
- Hermes's memory files (`MEMORY.md` and `USER.md` with the `§` separator): Hermes moves to Zikaron through a provider (guedesdiogo/hermes-agents#21).
- The `Kelpie-Agent`, `Kelpie-Via` and `Kelpie-Skill` trailers. Zikaron uses `Zikaron-Client: <client>`.
- The llm-gateway, the qualifier (Clef, Jev) and everything that calls a model: rerank, embeddings, the model-based write decision, the model-based conflict resolution and Dream. The package code stays, switched off; a model only comes back by Diogo's decision, as a paid option.
- The eval (`packages/memory/eval`): it depends on Kelpie's qualifier and gateway. The results stay as reference in Kelpie.

**Layout:** a bun monorepo like Kelpie's (`packages/*`, `apps/*`), with the same TypeScript, Biome and Vitest in workerd, so the port changes as little as possible. The packages are named `@zikaron/memory` and `@zikaron/vault`.

**License:** MIT. The files translated from [ai-memory](https://github.com/akitaonrails/ai-memory) keep its MIT notice (© 2026 Fabio Akita), and the credits in `docs/memory-format.md` come along.

## Consequences

- **The vault format stays Kelpie's,** with the extensions of #1 (`origin`, the new kinds, `archived`). A vault Kelpie wrote is read without migration.
- **Improvements diverge.** A fix made here does not reach Kelpie on its own. If Kelpie comes back, it becomes a client of Zikaron instead of keeping a copy.
- **v1 search uses neither vectors nor rerank.** It scores 77% within the top 5 results on a 100-thousand-note vault, against 94% with vectors and rerank on a thousand-note vault (Kelpie's `docs/spikes/memory-eval.md`).

## Alternatives considered

- **Rewrite from scratch.** It would lose the evaluation, the tests and the edge cases Kelpie already paid to find (merge with Obsidian, BOM, Obsidian links, conflict markers).
- **Import Kelpie's packages as a dependency.** Kelpie's packages are marked `private` and were never published, and Kelpie is off; publishing and versioning the packages just for this would cost more than the port.
- **Bring the whole `apps/context-store` and switch off what does not fit.** `vault.ts` mixes the two in 4,300 lines; leaving persona, skills and proposals dead inside the single writer widens the surface the rules of ADR-0001 have to cover.

## References

- [Kelpie at `f033cf3`](https://github.com/guedesdiogo/kelpie/tree/f033cf3): `packages/memory`, `packages/vault`, `apps/context-store`, `docs/memory-format.md`, `docs/context-store.md`, ADRs 0005, 0016, 0020 and 0021.
- [ai-memory at `fc4da03`](https://github.com/akitaonrails/ai-memory/tree/fc4da03), MIT.
