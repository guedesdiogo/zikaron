# ADR-0002: O Zikaron começa pela memória do Kelpie em `f033cf3`, sem o que é do produto Kelpie

- Estado: Aceito
- Data: 2026-10-24
- Issue: [#1](https://github.com/guedesdiogo/zikaron/issues/1)
- Aceito pelo Diogo com o plano do #1, em 2026-10-24

## Contexto

O Kelpie construiu uma memória madura sobre um cofre Markdown no GitHub, no Cloudflare: formato, índice com histórico de versões, busca híbrida avaliada em português, cercado do recall, núcleo, ciclo de vida e um escritor único que convive com as edições do dono no Obsidian. Ela está espalhada em três lugares, e só dois são genéricos:

| Onde, no Kelpie | Tamanho | O que é |
|---|---|---|
| `packages/memory` | ~5.200 linhas em 22 arquivos | formato, índice, busca, cercado, núcleo, ciclo de vida, escritor de notas. Só depende de `yaml`; compila sem tipos de runtime |
| `packages/vault` | ~800 linhas | a interface do backend, o adaptador do GitHub (JWT do App, árvores, `compare`, `createCommitOnBranch`), o webhook com HMAC e um backend falso |
| `apps/context-store` | ~7.500 linhas, 4.300 só no `vault.ts` | o Durable Object escritor único, misturado com persona, regras, skills, agent files, propostas por PR e o Dream |

O Kelpie está desligado desde 2026-10-23 (guedesdiogo/kelpie#514). O código dele é MIT, © 2026 Diogo Guedes, o mesmo dono deste repo.

## Decisão

**Vem do Kelpie, em `f033cf3`:**
- **`packages/memory`, inteiro,** com os testes, sem mudar comportamento. Partes que a v1 não usa (páginas de sessão, os prompts do Dream, os abstracts) vêm junto porque fazem parte do formato e têm testes, e ficam desligadas.
- **`packages/vault`, inteiro,** com os testes.
- **Do `apps/context-store`, só a parte genérica do escritor único:**
  - a fila e o flush em lotes por `createCommitOnBranch`, com `expectedHeadOid`;
  - o sync por árvore e `compare`, e a reconciliação periódica;
  - o webhook de push;
  - o merge de três vias em que vale a edição do dono (`merge.ts`);
  - os arquivos retidos com marcadores de conflito, sem a resolução por modelo;
  - os alarmes e o backoff;
  - o índice no mesmo SQLite do Durable Object;
  - o registro do que o servidor escreveu (`authored`);
  - o `forget` depois de uma reescrita do histórico;
  - o recall, o núcleo, a busca, a leitura e a gravação de notas, reescritos sobre as regras do [ADR-0001](0001-identidade-e-confianca.md).

**Fica no Kelpie:**
- `compile`, persona (`SOUL.md`), regras (`AGENTS.md`), skills, agent files, `propose` e os PRs de proposta: são do produto Kelpie.
- Os arquivos de memória do Hermes (`MEMORY.md` e `USER.md` com o separador `§`): o Hermes passa a usar o Zikaron por um provedor (guedesdiogo/hermes-agents#21).
- Os trailers `Kelpie-Agent`, `Kelpie-Via` e `Kelpie-Skill`. O Zikaron usa `Zikaron-Client: <cliente>`.
- O llm-gateway, o qualificador (Clef, Jev) e tudo o que chama modelo: rerank, embeddings, a decisão de gravação por modelo, a resolução de conflito por modelo e o Dream. O código do pacote continua, desligado; um modelo só volta por decisão do Diogo, como opção paga.
- O eval (`packages/memory/eval`): depende do qualificador e do gateway do Kelpie. Os resultados ficam como referência no Kelpie.

**Organização:** monorepo bun como o do Kelpie (`packages/*`, `apps/*`), com o mesmo TypeScript, Biome e Vitest no workerd, para o porte mudar o mínimo. Os pacotes se chamam `@zikaron/memory` e `@zikaron/vault`.

**Licença:** MIT. Os arquivos traduzidos do [ai-memory](https://github.com/akitaonrails/ai-memory) mantêm o aviso MIT dele (© 2026 Fabio Akita), e os créditos do `docs/memory-format.md` vêm junto.

## Consequências

- **O formato do cofre continua o do Kelpie,** com as extensões do #1 (`origin`, os tipos novos, `archived`). Um cofre que o Kelpie escreveu é lido sem migração.
- **As melhorias divergem.** Uma correção feita aqui não chega ao Kelpie sozinha. Se o Kelpie voltar, ele passa a ser cliente do Zikaron, em vez de manter uma cópia.
- **A busca da v1 não usa vetores nem rerank.** Mede 77% entre os 5 primeiros resultados num cofre de 100 mil notas, contra 94% com vetores e rerank num cofre de mil (`docs/spikes/memory-eval.md` do Kelpie).

## Alternativas consideradas

- **Reescrever do zero.** Perderia a avaliação, os testes e os casos de borda que o Kelpie já pagou para achar (merge com o Obsidian, BOM, links do Obsidian, marcadores de conflito).
- **Importar os pacotes do Kelpie como dependência.** Os pacotes do Kelpie são marcados `private` e nunca foram publicados, e o Kelpie está desligado; publicar e versionar os pacotes só para isso custaria mais do que o porte.
- **Trazer o `apps/context-store` inteiro e desligar o que não serve.** O `vault.ts` mistura as duas coisas em 4.300 linhas; deixar persona, skills e propostas mortos dentro do escritor único aumenta a superfície que as regras do ADR-0001 precisam cobrir.

## Referências

- [Kelpie em `f033cf3`](https://github.com/guedesdiogo/kelpie/tree/f033cf3): `packages/memory`, `packages/vault`, `apps/context-store`, `docs/memory-format.md`, `docs/context-store.md`, ADRs 0005, 0016, 0020 e 0021.
- [ai-memory em `fc4da03`](https://github.com/akitaonrails/ai-memory/tree/fc4da03), MIT.
