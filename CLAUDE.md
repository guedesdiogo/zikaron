# Zikaron: instructions for coding agents

Zikaron is Diogo's shared memory server: a Worker on Cloudflare, the single writer of a Markdown vault in a private GitHub repo, served over MCP and a small HTTP API to several clients (Hermes, Diogo's Mac, later Kelpie). Obsidian reaches it through git and the push webhook, with no API. The v1 plan is [Epic 1](https://github.com/guedesdiogo/zikaron/issues/1).

Project: `guedesdiogo/5`

## Language

Language: en (owner's decision of 2026-10-25: public repos under `guedesdiogo` are written in English unless Diogo asks otherwise).

- All prose in English: docs, ADRs, issues, PRs, commits and code comments. Identifiers in English.
- The prumo protocol markers stay as the tooling reads them: the «**Revisão**» comment with `Resultado:` and `Pendentes:`, «**Aceite** ·», and the `run-name` «Produção vX.Y.Z» of `producao.yml`.
- Test fixtures may hold Portuguese text: the search, merge and summary tests exercise it.

## Flow

The prumo standard applies, with these particulars:

- **Record:** the [Zikaron Project](https://github.com/users/guedesdiogo/projects/5). Titles `[Epic N]`, `[Story N.M]`, `[Task N.M.K]`, `[Follow-up N.M]`; labels `tipo:*`, `epic:N`, `seguranca`, `critico`, `merge:manual`.
- **Plan in the issue,** in the seven sections (Context, Objective, Out of scope, Plan, Acceptance criteria, Expected verification, Risks and rollback).
- **PR:** one `Closes #N` line per issue and the «Verification» section (residuals first, what ran with numbers, what did not run and why, risk, how to undo). The same Verification is commented on the issue.
- **Commits** conventional, citing `issue #N` without a keyword.
- **Merge** squash, under the prumo conditions, after the review (`/prumo:revisar`) is approved on the issue.
- **Decisions** in `docs/adr/`. Changing an accepted decision takes a new ADR.

## Gates

They run in CI (`.github/workflows/ci.yml`, job `CI passed`) and locally:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:coverage
```

- Each workspace keeps at least 80% of statements, branches, functions and lines (the floor comes from Kelpie).
- The tests run in workerd (`@cloudflare/vitest-plugin`), so the index uses the real SQLite and FTS5.
- Every trust rule (identity, write, read, taint, fence) has a test.

## Limits

- **CI runs only on GitHub runners.** The repo is public: no self-hosted runner, no `pull_request_target`, minimal `permissions` and actions pinned by SHA.
- **The `kelpie-vault` is touched only in Story 1.9,** after Diogo stops Kelpie's context-store. Until then, only the test vault.
- **Only synthetic data outside production:** tests, fixtures, the test vault, issues and PRs. No personal data in logs, issues, PRs or commits.
- **Logs carry only counts and codes,** never a note's text, title or path.
- **Secrets never go through the chat** or the agent's context. A machine-generated one goes through a pipeline (`openssl rand -base64 32 | wrangler secret put NAME`); a third-party one (the GitHub App key, the Cloudflare token) through `prumo-secrets`.
- **No infrastructure identifier in the repo:** IPs, instance ids, accounts, zones, bot handles.
- **Deploy only through CI.** Production only by release, on Diogo's order.
- **The server never force-pushes** and never rewrites the vault's history. Truly deleting is Diogo's job, by hand.

## Where things are

- `docs/adr/`: decisions. [ADR-0001](docs/adr/0001-identidade-e-confianca.md) is the trust model; [ADR-0002](docs/adr/0002-extracao-do-kelpie.md) says what came from Kelpie.
- `packages/memory`: format, index and search (from Kelpie).
- `packages/vault`: the GitHub backend (from Kelpie).
- `apps/server`: the Worker and the single-writer Durable Object.

## Reference projects

- [Kelpie](https://github.com/guedesdiogo/kelpie) at `f033cf3`: the origin of the code. Its `docs/memory-format.md` and ADRs 0005, 0016, 0020 and 0021 explain the design.
- [ai-memory](https://github.com/akitaonrails/ai-memory) (MIT): the model for the format and the search. Files translated from it carry the notice.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent): the main client; the memory provider contract is in `website/docs/developer-guide/memory-provider-plugin.md`.
