# Zikaron: instruções para agentes de código

O Zikaron é o servidor de memória compartilhada do Diogo: um Worker no Cloudflare, único escritor de um cofre Markdown num repo privado do GitHub, servido por MCP e por uma API HTTP pequena a vários clientes (Hermes, o Mac do Diogo, o Kelpie depois). O Obsidian chega pelo git e pelo webhook de push, sem API. O plano da v1 é o [Epic 1](https://github.com/guedesdiogo/zikaron/issues/1).

Projeto: `guedesdiogo/5`

## Idioma

- Prosa em pt-BR: docs, ADRs, issues, PRs, commits e comentários de código novo.
- O código portado do Kelpie fica com os comentários em inglês, como na origem. Identificadores em inglês.

## Fluxo

Vale o padrão prumo, com estas particularidades:

- **Registro:** o [Project Zikaron](https://github.com/users/guedesdiogo/projects/5). Títulos `[Epic N]`, `[Story N.M]`, `[Task N.M.K]`, `[Follow-up N.M]`; labels `tipo:*`, `epic:N`, `seguranca`, `critico`, `merge:manual`.
- **Plano na issue,** nas sete seções (Contexto, Objetivo, Fora de escopo, Plano, Critérios de aceite, Verificação prevista, Riscos e rollback).
- **PR:** uma linha `Closes #N` por issue e a seção «Verificação» (residuais primeiro, o que rodou com números, o que não rodou e por quê, risco, como desfazer). A mesma Verificação vai comentada na issue.
- **Commits** convencionais, citando `issue #N` sem palavra-chave.
- **Merge** squash, pelas condições do prumo, depois da revisão (`/prumo:revisar`) aprovada na issue.
- **Decisões** em `docs/adr/`. Mudar uma decisão aceita pede um ADR novo.

## Gates

Rodam na CI (`.github/workflows/ci.yml`, job `CI passed`) e localmente:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:coverage
```

- Cada workspace mantém ao menos 80% de statements, branches, functions e lines (o piso vem do Kelpie).
- Os testes rodam no workerd (`@cloudflare/vitest-plugin`), para o índice usar o SQLite e o FTS5 de verdade.
- Toda regra de confiança (identidade, gravação, leitura, contaminação, cercado) tem teste.

## Limites

- **A CI roda só em runners do GitHub.** O repo é público: nada de runner self-hosted, nada de `pull_request_target`, `permissions` mínimas e ações fixadas por SHA.
- **O `kelpie-vault` só é tocado na Story 1.9,** depois de o Diogo parar o context-store do Kelpie. Até lá, só o cofre de teste.
- **Só dados sintéticos fora da produção:** testes, fixtures, o cofre de teste, issues e PRs. Nenhum dado pessoal em logs, issues, PRs ou commits.
- **Logs só com contagens e códigos,** nunca texto, título ou caminho de nota.
- **Segredos nunca passam pelo chat** nem pelo contexto do agente. O gerado por máquina vai por pipeline (`openssl rand -base64 32 | wrangler secret put NOME`); o de terceiro (a chave do GitHub App, o token do Cloudflare), pelo `prumo-segredos`.
- **Nenhum identificador de infraestrutura no repo:** IPs, ids de instância, contas, zonas, handles de bot.
- **Deploy só pela CI.** Produção só por release, por ordem do Diogo.
- **O servidor nunca faz force-push** e nunca reescreve o histórico do cofre. Apagar de verdade é do Diogo, à mão.

## Onde está o quê

- `docs/adr/`: decisões. O [ADR-0001](docs/adr/0001-identidade-e-confianca.md) é o modelo de confiança; o [ADR-0002](docs/adr/0002-extracao-do-kelpie.md) diz o que veio do Kelpie.
- `packages/memory`: formato, índice e busca (do Kelpie).
- `packages/vault`: o backend do GitHub (do Kelpie).
- `apps/server`: o Worker e o Durable Object escritor único.

## Projetos de referência

- [Kelpie](https://github.com/guedesdiogo/kelpie) em `f033cf3`: a origem do código. `docs/memory-format.md` e os ADRs 0005, 0016, 0020 e 0021 dele explicam o desenho.
- [ai-memory](https://github.com/akitaonrails/ai-memory) (MIT): o modelo do formato e da busca. Arquivos traduzidos dele levam o aviso.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent): o cliente principal; o contrato do provedor de memória está em `website/docs/developer-guide/memory-provider-plugin.md`.
