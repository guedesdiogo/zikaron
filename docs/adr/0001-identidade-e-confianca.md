# ADR-0001: A identidade vem da credencial, a confiança vem do canal, e o servidor aplica as regras

- Estado: Aceito
- Data: 2026-10-24
- Issue: [#1](https://github.com/guedesdiogo/zikaron/issues/1)
- Aceito pelo Diogo na conversa de 2026-10-24 (as respostas estão citadas no #1)
- Emendado por: [ADR-0003](0003-corrija-pela-palavra-do-dono.md), uma nota do dono muda pela palavra do dono, também pelo provedor

## Contexto

Vários clientes gravam e leem a mesma memória: o Noah (assistente pessoal, lê Gmail e páginas de fora), o Alan (abre e digita em sessões do Claude Code), o Mac do Diogo (sessões do Claude Code) e, depois, o Kelpie. O Diogo edita o cofre no Obsidian.

As regras do Diogo (entrevista de 2026-10-24, no #1):
- **Q3:** o que o Diogo disse entra sozinho; o que um agente deduziu, ou leu num e-mail, página ou documento, só entra com o «sim» dele, e até lá fica marcado como inferido; rotinas agendadas nunca gravam.
- **Q24:** a regra de recall vale por identidade, e quem aplica é o servidor, não a persona. Cada agente recebe o que o Diogo disse ou editou e as notas próprias; o Alan nunca recebe notas do Noah vindas de e-mail ou página, nem as que o Noah deduziu; o Noah recebe as do Alan.

O motivo do Q24: o Noah lê conteúdo de fora, e o Alan digita em sessões que tomam o texto dele como se fosse do Diogo. Uma memória plantada por e-mail no Noah que chegasse ao Alan viraria uma ordem do Diogo numa sessão com terminal.

O que não ajuda:
- **O Hermes não protege a memória sozinho.** O recall não é sanitizado e os provedores gravam sem aprovação (issues 136997 e 67546 de `NousResearch/hermes-agent`, abertas em 2026-10-24).
- **A injeção por e-mail existe de verdade.** O MemGhost (arXiv 2607.05189, julho de 2026) planta memória com um único e-mail, e o artigo diz que funciona no Hermes.
- **No Cloudflare não há uid Unix.** Cada cliente precisa de uma credencial própria.
- **A credencial de um agente está ao alcance do próprio agente.** O terminal do Noah lê o `.env` dele («Known limits» do `profiles/README.md` do `hermes-agents`). Uma gravação por `curl` com essa credencial é igual a uma chamada do provedor.

## Decisão

### 1. A identidade vem da credencial

- **O Cloudflare Access fica na frente do Worker,** com um service token por cliente.
- **O Worker valida o `Cf-Access-Jwt-Assertion` em todo pedido,** mesmo com o Access na frente: a assinatura, pelas chaves públicas do time no Access; o `aud` da aplicação; o `iss` e a validade. Depois mapeia o `common_name` do token (o Client ID do service token) para um cliente da configuração do deploy.
- **Sem JWT válido, ou com um cliente fora da configuração, a resposta é 401,** e nada é lido nem gravado.
- **O cliente nunca diz quem é.** Nenhum campo do pedido escolhe o cliente, o escopo `agent/<cliente>` ou o `origin.client`.
- **O webhook do GitHub fica num caminho fora do Access,** conferido pelo HMAC do segredo do webhook, e só dispara uma sincronização: não lê nem grava nada pedido no corpo.
- **A configuração de cada cliente** fica no deploy, fora do repo, e diz:
  - `name`: o nome do cliente (`noah`, `alan`, `mac`…), que nomeia o escopo `agent/<name>`;
  - `exposed`: o cliente lê conteúdo de fora;
  - `privileged`: o cliente age com a autoridade do Diogo;
  - `ownerClaims`: o que ele grava como dito pelo Diogo vale como do Diogo para os outros clientes.

### 2. A confiança vem do canal

Uma credencial por agente não prova «dito pelo Diogo». Por isso a confiança de uma nota vem do canal por onde ela entrou:

1. **Canal do dono:** um commit no cofre que não foi o servidor que fez (Obsidian, GitHub, qualquer editor). O servidor sabe o que gravou porque guarda o SHA de cada blob que escreveu, como o `authored` do Kelpie; um blob que ele não escreveu é do dono, chegue pelo commit que chegar.
2. **Canal do provedor** (`/v1/*`): o provedor do Hermes grava o que o Diogo disse com a evidência, o id da mensagem do usuário que ele vê no `sync_turn`.
3. **Canal de ferramenta** (`/mcp`): tudo o que o modelo chama.

O canal é um teto, não uma prova: a mesma credencial alcança os dois endpoints. Por isso o `ownerClaims` é por cliente, e não por endpoint.

### 3. A proveniência é do servidor

Cada versão que o servidor grava leva no frontmatter um bloco `origin`, preenchido só por ele:

```yaml
origin:
  client: noah            # da credencial
  channel: provider       # provider | tool
  source: owner           # owner | agent | external
  evidence: "telegram:msg/123"   # opcional: o id da mensagem ou a referência da fonte
  review: pending         # presente enquanto espera o «sim»
  taint: inherited        # presente quando a versão herdou a contaminação da anterior
```

O que o pedido pode dizer e o servidor limita:
- `source` vem do cliente, com teto pelo canal: pelo canal de ferramenta, `owner` vira `agent`.
- `level` (`explicit`, `deduced`, `inferred`, do Kelpie) acompanha o `source`: só `owner` pelo provedor pode ser `explicit`.
- `evidence` é guardada como veio, uma linha, sem segredos.

**A confiança de uma versão é calculada na leitura,** a partir do `origin`, de quem escreveu o blob e da configuração atual do cliente. Assim, desligar o `ownerClaims` de um cliente vale na hora, sem reescrever o cofre. Uma versão **vale como do Diogo** quando:
- o blob é do dono, não tem `review: pending` e o `origin`, se havia, pôde ser lido (uma nota que o Diogo escreveu, ou uma nota pendente que ele confirmou tirando o `review`; uma edição que quebra o bloco não confirma nada); ou
- o blob é do servidor, com `source: owner`, `channel: provider`, e o cliente que gravou tem `ownerClaims`.

### 4. A regra de gravação (Q3)

- `source: owner` pelo canal do provedor, de um cliente com `ownerClaims`, entra direto, com `level: explicit` e a evidência. De um cliente sem `ownerClaims`, entra com `review: pending` e `level: inferred`, como uma conclusão: a palavra dele não vale como do Diogo, e o «sim» no cofre é o que a confirma.
- `agent` e `external` entram com `review: pending` e `level: inferred`. O «sim» do Diogo é tirar o `review: pending` no cofre (Obsidian ou GitHub). Uma página de confirmação atrás do Access, com o login dele, fica para depois.
- **Rotinas agendadas não gravam.** Uma gravação, um arquivamento ou um «esqueça» com `context: cron` é recusado sem commit. Quem marca o contexto é o provedor ou o cliente MCP; o servidor recusa.
- **Nenhum agente reescreve** uma nota que vale como do Diogo, uma nota do núcleo (pinned, ou em `profile/`) ou uma nota arquivada. A exceção, só para a nota do Diogo, é a palavra do próprio Diogo pelo provedor ([ADR-0003](0003-corrija-pela-palavra-do-dono.md)). São as regras guedesdiogo/kelpie#149 e guedesdiogo/kelpie#168, agora pelo servidor.
- **«Esqueça» vindo de um agente** só alcança as notas do próprio cliente e as pendentes. Uma nota do Diogo sai pelo cofre. O git guarda tudo.
- **Nenhum agente pina uma nota.** O `pinned` só vem do cofre.

### 5. A regra de leitura (Q24) e a contaminação

Uma versão é **contaminada** quando não vale como do Diogo e:
- o `source` é `external`; ou
- quem gravou é um cliente `exposed`, ou um cliente que não está na configuração: a lista é de permissão, para que tirar um cliente comprometido da configuração não limpe a marca das notas dele; ou
- tem `taint: inherited`; ou
- tem um `origin` que não pôde ser lido (um bloco quebrado, ou um frontmatter ignorado que tinha `origin`).

**A marca acompanha a nota.** Quando um cliente grava por cima de uma nota cuja versão atual está contaminada, o servidor põe `taint: inherited` na nova versão. Só o canal do dono tira a marca. Um resultado futuro que combine notas (os resumos e os merges do Dream) herda a marca de qualquer nota que leu.

**Um cliente `privileged` nunca recebe uma nota contaminada,** em nenhum caminho:
- o recall e o núcleo;
- a busca e a leitura por caminho;
- os vizinhos do grafo e os links resolvidos de uma nota;
- as listas (pendentes, arquivadas).

Para ele, a nota contaminada responde como inexistente, com a mesma resposta de uma nota que não existe, e não pode ser gravada por cima. Isso vale também para as notas dele: um cliente `privileged` que grava algo lido de fora só o recebe de volta depois do «sim». É a leitura mais estrita do Q24, cujo motivo é que nada lido de fora chegue como ordem às sessões do Alan.

O que cada cliente recebe:

| Cliente | Recebe |
|---|---|
| `exposed` (o Noah) | tudo, inclusive as notas do Alan e as contaminadas |
| `privileged` (o Alan, o Mac) | o que vale como do Diogo e as notas não contaminadas, as próprias e as de quem não é `exposed` |
| nenhum dos dois | o que vale como do Diogo, as notas próprias e as de quem não é `exposed` |

### 6. O que o recall entrega é dado, não instrução

O recall e o núcleo saem com o cercado do Kelpie (`docs/memory-format.md`, «Packing»):
- as tags do bloco levam um id aleatório, novo a cada bloco, e o cabeçalho de cada nota leva o mesmo id;
- `<memory` é escapado dentro das notas, e título e caminho ocupam uma linha só;
- cada nota diz a origem e se está pendente;
- o bloco diz que é referência, não instrução.

### 7. A configuração de partida

Decisão do Diogo em 2026-10-24 sobre o Q24 («Sim, já vale»):

| Cliente | `exposed` | `privileged` | `ownerClaims` |
|---|---|---|---|
| `noah` | sim | não | **sim** |
| `alan` | não | sim | não |
| `mac` | não | sim | não |

O Noah começa com `ownerClaims`, mesmo com a credencial ao alcance do terminal dele: o que ele grava como dito pelo Diogo, com a evidência, vale para o Alan desde já.

## Consequências

- **O cofre só pode ter um escritor automático: o Zikaron.** Os commits de outro servidor no mesmo cofre, como o context-store do Kelpie, contariam como do dono. Por isso o Zikaron só entra num cofre depois que o outro escritor parar (Story 1.9 do #1).
- **O canal do dono é tão forte quanto quem pode dar push no cofre.** Uma credencial do GitHub do Diogo numa máquina onde um agente tem terminal vira «edição do Diogo». O relatório diário lista as notas que mudaram; fechar essas credenciais é trabalho do `hermes-agents`.
- **O `ownerClaims` do Noah é um risco aceito.** Um Noah induzido por um e-mail pode gravar algo como dito pelo Diogo, com um id de mensagem forjado, e o Alan recebe. O que reduz o risco:
  - a evidência fica na nota;
  - o relatório diário lista as notas `owner` gravadas pelo provedor;
  - desligar o `ownerClaims` é uma linha de configuração e vale na hora.

  Ele cai quando a credencial do Noah sair do alcance do terminal dele.
- **O Diogo cuida da borda:** a aplicação do Access, um service token por cliente e a entrega de cada segredo ao seu cliente. Os segredos nunca passam pelo chat.
- **Uma edição acidental no Obsidian não confirma uma nota pendente:** só tirar o `review: pending` confirma.
- **As regras valem para qualquer cliente novo** pela configuração dele, sem mudança de código.

## Alternativas consideradas

- **Um token bearer por cliente, guardado com hash no Worker,** como faz o ai-memory. Mais simples, mas perde a camada de borda (um pedido sem token nem chega ao Worker) e a rotação e expiração pelo painel.
- **OAuth 2.1 do MCP.** Os clientes do Hermes e do Claude Code têm suporte desigual, e um agente não tem quem faça o login interativo.
- **Confiar no `level` que o agente declara,** como o Kelpie v1. O rótulo é do próprio modelo: uma instrução injetada consegue declarar `explicit` (guedesdiogo/kelpie#149).
- **Aplicar a regra do Q24 na persona ou no provedor.** É exatamente o que o Diogo descartou: quem aplica é o servidor.

## Referências

- [#1](https://github.com/guedesdiogo/zikaron/issues/1): o plano e as decisões do Diogo.
- ADRs 0005, 0016, 0020 e 0021 do [Kelpie](https://github.com/guedesdiogo/kelpie/tree/f033cf3/docs/adr) e o `docs/memory-format.md` dele.
- Cloudflare Access: [validar o JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) e os [campos do token de aplicação](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) (`common_name` é o Client ID do service token).
- MemGhost, arXiv 2607.05189.
