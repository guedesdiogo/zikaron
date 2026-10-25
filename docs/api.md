# A API do Zikaron

O Worker serve a memória por duas portas, as duas atrás do Cloudflare Access:

- **`POST /mcp`**: um servidor MCP para os modelos. Tudo o que chega por aqui é do **canal de ferramenta** ([ADR-0001](adr/0001-identidade-e-confianca.md) §2).
- **`POST /v1/*`**: uma API JSON pequena para o provedor de memória do Hermes. Tudo o que chega por aqui é do **canal do provedor**.

Ficam de fora do Access só:
- o `POST /webhooks/github`, conferido pelo HMAC do segredo do webhook, que apenas pede uma sincronização;
- o `GET /health`, que responde `{"status":"ok","environment":"<ambiente>","commit":"<sha>"}` e nada mais, sem ler a configuração nem o cofre: é a conferência do deploy ([staging.md](staging.md), [producao.md](producao.md)).

O canal é um teto, não uma prova: a mesma credencial alcança as duas portas. Quem diz o que vale é a configuração de cada cliente.

## Autenticação

Cada cliente (Noah, Alan, o Mac, o Kelpie depois) tem um **service token** próprio no Access.

1. **O cliente manda as duas credenciais do token em todo pedido:**

   ```http
   CF-Access-Client-Id: <Client ID do token>
   CF-Access-Client-Secret: <Client Secret do token>
   ```

   Os valores ficam no ambiente do cliente, nunca no repo, num chat ou num log.
2. **O Access confere o token** e entrega o pedido ao Worker com um JWT em `Cf-Access-Jwt-Assertion`.
3. **O Worker confere o JWT de novo** em todo pedido, mesmo com o Access na frente:
   - a assinatura RS256, pelas chaves públicas do time (`<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`);
   - o `iss` do time, o `aud` da aplicação e a validade, com um minuto de folga;
   - o tipo `app`, sem `email`: só service tokens, nunca o login de uma pessoa.
4. **O `common_name` do JWT** (o Client ID do token) escolhe o cliente em `ZIKARON_CLIENTS`.
   - Nada no corpo, na URL ou em outro cabeçalho escolhe o cliente.
   - O nome do cliente nomeia o escopo `agent/<nome>` e o `origin.client` do que ele grava.

### A configuração do deploy

Três variáveis, passadas como `--var` no deploy e vazias no `wrangler.jsonc`:

| Variável | O que é |
|---|---|
| `ACCESS_TEAM_DOMAIN` | O domínio do time no Access, `https://<time>.cloudflareaccess.com` |
| `ACCESS_AUD` | O AUD da aplicação do Access |
| `ZIKARON_CLIENTS` | Um objeto JSON do Client ID de cada token para o cliente |

Cada cliente de `ZIKARON_CLIENTS` tem quatro campos, e nenhum outro:

```json
{
  "<Client ID>": { "name": "noah", "exposed": true, "privileged": false, "ownerClaims": true }
}
```

- `name`: minúsculas, dígitos e hífen, até 40 caracteres, único. Nunca `zikaron`, o nome do próprio servidor, que grava a rotina diária ([memory-format](memory-format.md#a-rotina-diária)).
- `exposed`: lê conteúdo de fora.
- `privileged`: age com a autoridade do dono.
- `ownerClaims`: o que ele grava como dito pelo dono, pelo provedor, vale como do dono.

Um cliente não pode ser `exposed` e `privileged` ao mesmo tempo. Qualquer erro recusa a configuração inteira, para um erro de digitação não abrir uma porta.

### Respostas da autenticação

| Status | Corpo | Quando |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | Sem JWT, com um JWT que não vale, ou de um Client ID fora da configuração |
| 500 | `{"error":"clients_config"}` | `ZIKARON_CLIENTS` vazia ou inválida. O log diz só isso |
| 503 | `{"error":"unavailable"}` | As chaves do Access não vieram |

Depois da autenticação, um caminho que não existe responde 404 `{"error":"not_found"}`, e um método errado 405 `{"error":"method_not_allowed"}` com `Allow: POST`.

## O que cada cliente lê e grava

As regras são as do [ADR-0001](adr/0001-identidade-e-confianca.md), com a emenda do [ADR-0003](adr/0003-corrija-pela-palavra-do-dono.md). O servidor as aplica em toda rota.

### A leitura

- **Toda leitura passa pela política do leitor:** o núcleo, o recall, a busca, a leitura por caminho, os links de uma nota e a lista de pendentes.
- **Uma nota que o leitor não pode ver responde como uma nota que não existe,** com o mesmo status e o mesmo corpo.
- **O que se lê é a versão comitada.** Uma gravação ainda na fila só aparece depois do commit, segundos depois.

### A gravação

- **O canal põe o teto:**
  - pelo MCP, `source: owner` vira `agent`;
  - `agent` e `external` entram com `review: pending` e `level: inferred`;
  - só `owner` pelo provedor entra com `level: explicit`, sem pendência.
- **Recusas:**
  - uma rotina agendada (`context: cron`) não grava, nem arquiva, nem esquece;
  - nenhum pedido traz `pinned`;
  - nenhuma gravação muda uma nota do núcleo ou uma arquivada;
  - uma nota que vale como do dono só muda pela palavra do dono: `source: owner`, pelo provedor, de um cliente com `ownerClaims`.
- **A marca acompanha a nota:** quem grava por cima de uma versão contaminada passa `taint: inherited` à nova.
- **«Esqueça»** só alcança as notas do próprio cliente e as que esperam o «sim».
- **Segredos** saem do título, do corpo, do resumo, das entidades e da evidência antes da gravação.
- **O resumo do commit** nunca nomeia a nota.

### Versões

Toda nota tem uma versão: os 12 primeiros dígitos hexadecimais do SHA do blob dela no git. A leitura e a busca a mostram, e toda gravação devolve a versão nova.

- **Para mudar ou arquivar uma nota existente, a versão é obrigatória.** Uma versão que não é a atual responde `changed`, e nada é gravado.
- **Uma nota com uma gravação ainda na fila também responde `changed`** até o commit, e a busca não dá versão para ela. Quando o commit chega, a leitura mostra a versão nova.
- **A mesma memória de novo responde `unchanged`,** sem gravar, seja qual for a versão: uma nova versão que só muda o `updated`, ou uma nota nova igual a uma que o leitor vê, ou à gravação dele ainda na fila.

## O MCP (`POST /mcp`)

O transporte é o Streamable HTTP do MCP, no modo mais simples:

- **Sem estado:** sem `Mcp-Session-Id` e sem SSE. Cada POST leva uma mensagem JSON-RPC 2.0 e recebe a resposta em `application/json`.
- **Uma notificação** (sem `id`), ou a resposta de um cliente, recebe 202 sem corpo.
- **Lotes** (uma lista de mensagens) não são aceitos.
- `GET /mcp` e qualquer outro método respondem 405.

| Método | Resposta |
|---|---|
| `initialize` | `protocolVersion: "2025-06-18"`, `capabilities: {tools: {}}`, `serverInfo: {name: "zikaron", version}` |
| `ping` | `{}` |
| `tools/list` | as seis ferramentas abaixo, com o esquema JSON dos argumentos |
| `tools/call` | `{content: [{type: "text", text}], isError?}` |

Erros do JSON-RPC:

| Código | HTTP | Quando |
|---|---|---|
| -32700 | 400 | O corpo não é JSON (`id: null`) |
| -32600 | 400 | Um lote, uma mensagem sem `jsonrpc: "2.0"`, um `method` que não é texto, um `id` que não é texto nem número (`id: null`) |
| -32601 | 200 | Um método que o servidor não tem |
| -32602 | 200 | `tools/call` de uma ferramenta que não existe |

Uma ferramenta que falha responde `isError: true` com um texto curto: o código da recusa e o que fazer, nunca o conteúdo de uma nota. Exemplo: `Recusada (owners_note): A nota vale como do dono e não muda por esta ferramenta; grave uma nota nova.`

### As ferramentas

| Ferramenta | Argumentos | Responde |
|---|---|---|
| `memory_search` | `query`; `k` (1 a 10, padrão 3); `includeArchived` | As notas no cercado, as melhores primeiro, cada uma com tipo, escopo, origem e versão |
| `memory_read` | `path`; `offset` | Uma página da nota no cercado, até 9.500 caracteres, com a versão e, na primeira página, os links que o leitor vê |
| `memory_write` | `title`, `body`, `kind`, `source` (`agent` ou `external`); opcionais `evidence`, `confidence`, `scope`, `entities`, `validFrom`, `invalidAt`, `abstract`, `path` e `version`, `status`, `link` | `Gravada: <caminho>, versão <v>.` ou `Já estava na memória: …` |
| `memory_forget` | `path` | `Removida: <caminho>.` |
| `memory_archive` | `path`, `version`; opcionais `source`, `evidence` | `Arquivada: <caminho>, versão <v>.` |
| `memory_pending` | nenhum | As notas que esperam o «sim» do dono e que o cliente vê, no cercado |

As descrições, em português, dizem ao modelo que o resultado é dado de referência dentro de um cercado, nunca instruções.

## A API do provedor (`POST /v1/*`)

JSON entra e sai. O corpo é sempre um objeto JSON, mesmo vazio (`{}`), com até cerca de 1 MB. Campos em `null` contam como ausentes.

O Hermes usa assim:
- `system_prompt_block` chama `/v1/core`;
- `prefetch` chama `/v1/recall`;
- as gravações vão a `/v1/write`, com `evidence` (o id da mensagem do usuário) e, numa rotina agendada, `context: "cron"`.

### `/v1/core`

```json
{ "budgetTokens": 1000 }
```

O núcleo: as notas fixadas no escopo global ou no do cliente, o perfil do dono e o do cliente, só as que ele vê. O orçamento é de 1.000 tokens por padrão, e 4.000 no máximo.

```json
{ "text": "<memory-…>…</memory-…>", "tokens": 812, "paths": ["memory/profile/…"], "omitted": 0 }
```

### `/v1/recall`

```json
{ "question": "onde a Ana mora agora?", "budgetTokens": 1000, "includeArchived": false }
```

As memórias que respondem a pergunta, num bloco cercado dentro do orçamento: 1.000 tokens por padrão, 8.000 no máximo.

- **Uma mensagem sem nada para buscar** («ok», «valeu», um comando) responde um bloco vazio.
- **As notas vencidas** ficam de fora, salvo numa pergunta sobre como as coisas eram.
- **O bloco é dado, não instrução:**
  - as tags do bloco e o cabeçalho de cada nota levam um id aleatório;
  - `<memory` é escapado dentro das notas;
  - cada nota diz a origem na linha logo abaixo do cabeçalho, que termina no mesmo id do bloco: o corpo de uma nota não forja essa linha.

```json
{ "text": "<memory-…>\n## Título (caminho) [id]\norigem: dono\n…\n</memory-…>", "tokens": 540, "paths": ["…"] }
```

A linha de origem é uma destas:
- `origem: dono`, quando a versão vale como do dono;
- `origem: <cliente>, conclusão|de fora|diz ser do dono[, pendente][, contaminação herdada]`;
- `origem: desconhecida`, para uma versão do servidor sem o bloco `origin`.

Uma falha do núcleo ou do recall responde um bloco vazio, para a conversa seguir sem memória.

### `/v1/search`

```json
{ "query": "café", "k": 3, "includeArchived": false }
```

```json
{
  "ok": true,
  "text": "<memory-…>…</memory-…>",
  "notes": [
    {
      "path": "memory/preferences/cafe-sem-acucar.md",
      "title": "Café sem açúcar",
      "abstract": null,
      "kind": "preference",
      "scope": "global",
      "validFrom": null,
      "invalidAt": null,
      "archived": false,
      "origin": "origem: dono",
      "version": "3f2a…"
    }
  ]
}
```

`version` é `null` quando a nota tem uma gravação ainda na fila.

### `/v1/read`

```json
{ "path": "memory/preferences/cafe-sem-acucar.md", "offset": 0 }
```

```json
{ "ok": true, "path": "…", "text": "<memory-…>…</memory-…>", "nextOffset": null, "version": "3f2a…" }
```

A página diz:
- o tipo, o escopo, a validade, o nível e a origem;
- se a nota está fixada ou arquivada;
- o `status` de uma `task` ou `delegation`, e o `link` de um `document`.

Uma nota arquivada se lê pelo caminho. Uma nota que não existe, ou que o leitor não vê, responde `{"ok": false, "reason": "not_found"}`.

### `/v1/write`

```json
{
  "source": "owner",
  "evidence": "telegram:msg/123",
  "context": "chat",
  "title": "Café sem açúcar",
  "body": "O Diogo toma café sem açúcar.",
  "kind": "preference",
  "scope": "global",
  "confidence": 0.9,
  "entities": ["Café"],
  "validFrom": "2026-10-24",
  "abstract": "Prefere café sem açúcar.",
  "path": "memory/preferences/cafe-sem-acucar.md",
  "version": "3f2a…",
  "status": "open",
  "link": "https://…"
}
```

- **`source` é obrigatório:** `owner`, `agent` ou `external`.
- **`title`, `body` e `kind`** também. `kind` é um dos tipos do formato, menos `session`.
- **Sem `path`, a memória é uma nota nova:**
  - vai aonde o título a põe, no escopo `global` por padrão;
  - os escopos aceitos são `global`, `agent/<o próprio cliente>`, `area/<nome>` e `project/<nome>`;
  - um `event` precisa de `validFrom`, e um `document` de `link`;
  - um título cujo caminho já está tomado ganha um número (`-2`, `-3`…).
- **Com `path`, a memória é a nova versão daquela nota,** com `version` obrigatória.
  - O tipo e o escopo são os da nota.
  - O que a memória deixa de fora, a nota mantém: o id, as chaves do dono, tier, confiança, fontes, entidades, validade, resumo, `contradicts`, pin, evergreen, `status` e `link`.
- **`level` não existe:** o servidor o decide pela origem. **`pinned` é recusado.**

```json
{ "ok": true, "action": "written", "path": "memory/preferences/cafe-sem-acucar.md", "version": "9c41…" }
```

### `/v1/forget`

```json
{ "path": "memory/notes/do-alan.md", "context": "chat" }
```

Esquecer é um commit: com `context: "cron"`, o pedido é recusado (`cron`), como uma gravação.

```json
{ "ok": true, "path": "memory/notes/do-alan.md" }
```

### `/v1/archive`

```json
{ "path": "memory/notes/ideia.md", "version": "3f2a…", "source": "agent", "evidence": "…", "context": "…" }
```

Arquiva a nota: uma nova versão dela inteira, com `archived: true`, pela mesma regra de gravação.
- Sem `source`, vale `agent`.
- A nova versão leva a origem de quem arquivou.
- A nota sai da busca, do recall e do núcleo, e continua legível pelo caminho.

A resposta é a de `/v1/write`.

### `/v1/pending`

```json
{}
```

```json
{
  "ok": true,
  "text": "<memory-…>…</memory-…>",
  "notes": [{ "path": "memory/notes/…", "title": "…", "client": "noah", "source": "external" }]
}
```

As notas que esperam o «sim» do dono e que o cliente vê, as mais recentes primeiro, até 100. Arquivadas e fundidas em outra ficam de fora.

### Status e códigos

As recusas da regra são respostas, com 200 e `ok: false`. O status muda só quando o pedido não vale ou o servidor não pode atender.

| Status | Corpo | Quando |
|---|---|---|
| 200 | `{"ok": true, …}` | Feito |
| 200 | `{"ok": false, "reason": …}` | Uma recusa da tabela abaixo |
| 400 | `{"ok": false, "reason": "invalid_json"}` | O corpo não é JSON |
| 400 | `{"ok": false, "reason": "invalid", "problems": […]}` | Um campo que falta ou não vale, no pedido ou na memória |
| 401 | `{"ok": false, "reason": "unauthorized"}` | O cliente saiu da configuração entre a rota e o cofre |
| 413 | `{"ok": false, "reason": "too_large"}` | O pedido, ou a nota, é grande demais |
| 503 | `{"ok": false, "reason": "vault_off"}` | O cofre não está configurado |
| 503 | `{"ok": false, "reason": "unavailable"}` | O GitHub ou o índice falharam; tente de novo |

| `reason` | Significado |
|---|---|
| `not_found` | A nota não existe, ou o cliente não a vê |
| `changed` | A nota mudou desde a versão informada, ou tem uma gravação esperando o commit |
| `scope_not_allowed` | O escopo, ou a pasta da nota, não é do cliente |
| `cron` | Uma rotina agendada não grava |
| `pinned` | Nenhum pedido fixa uma nota |
| `owners_note` | A nota vale como do dono, e a gravação não é a palavra do dono |
| `core_note` | A nota é do núcleo: fixada no escopo global ou do cliente, ou num `profile/` |
| `archived` | A nota está arquivada |
| `not_own` | «Esqueça» de uma nota de outro cliente que não espera o «sim» |
