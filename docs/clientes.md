# Como cada cliente usa o Zikaron

Todo cliente fala com o mesmo Worker. A diferença entre eles está na configuração de cada um em `ZIKARON_CLIENTS` ([api.md](api.md#a-configuração-do-deploy)) e na porta que usa: `/mcp` é o canal de ferramenta, e `/v1/*` é o canal do provedor ([ADR-0001](adr/0001-identidade-e-confianca.md) §2).

| Cliente | Porta | `exposed` | `privileged` | `ownerClaims` |
|---|---|---|---|---|
| Noah (Hermes) | `/v1/*` pelo provedor, `/mcp` pelas ferramentas | sim | não | sim |
| Alan (Hermes) | `/v1/*` pelo provedor, `/mcp` pelas ferramentas | não | sim | não |
| O Mac do Diogo (Claude Code) | `/mcp` | não | sim | não |
| Obsidian | nenhuma: o git e o webhook | — | — | — |

Cada cliente tem um service token próprio no Access. O Client ID e o Client Secret ficam no ambiente do cliente, nunca no repo nem num chat.

## O Mac: Claude Code por MCP

Um servidor MCP HTTP, com os dois cabeçalhos do Access tirados do ambiente:

```json
{
  "mcpServers": {
    "zikaron": {
      "type": "http",
      "url": "https://<Worker>/mcp",
      "headers": {
        "CF-Access-Client-Id": "${ZIKARON_CLIENT_ID}",
        "CF-Access-Client-Secret": "${ZIKARON_CLIENT_SECRET}"
      }
    }
  }
}
```

- **Ferramentas:** `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_archive` e `memory_pending` ([api.md](api.md#as-ferramentas)).
- **Pelo MCP, nada vale como do dono:** uma gravação entra como conclusão pendente, até o «sim» no cofre.
- **O Mac é `privileged`:** nunca recebe nota contaminada, nem a que ele mesmo gravou a partir de algo lido de fora.

## O Hermes: o contrato do provedor de memória

Para guedesdiogo/hermes-agents#21. O Hermes v0.22.5 tem um só provedor externo ativo por vez. Os métodos dele (`website/docs/developer-guide/memory-provider-plugin.md`, na tag v0.22.5) mapeiam assim:

| Método do provedor | Chamada | O que fazer |
|---|---|---|
| `system_prompt_block()` | `POST /v1/core` | O núcleo, em até 1.000 tokens: o bloco vai como está, já cercado. |
| `prefetch(query)` e `queue_prefetch` | `POST /v1/recall` | O recall do turno, com `question` e `budgetTokens`. O bloco vai depois da última mensagem do usuário, nunca no prompt de sistema. |
| `sync_turn(...)` | nada na v1 | Guardar o id da última mensagem do usuário: é a evidência de «o dono disse». A captura automática de turnos está fora da v1. |
| `on_memory_write(...)` | `POST /v1/write` | A ferramenta de memória do próprio Hermes é o modelo decidindo: grava com `source: agent`. |
| `on_session_end()` | nada | — |
| ferramentas próprias | `POST /v1/*` | Busca, leitura, esquecer, arquivar e pendentes, com `source: agent` nas gravações. |

**«O dono disse» precisa de evidência** (ADR-0001 §2):
- O provedor só manda `source: owner` quando o texto a gravar está na última mensagem do usuário que o `sync_turn` viu. Ele confere isso no próprio provedor, não no modelo.
- `evidence` leva o id dessa mensagem (`telegram:<chat>/<mensagem>` ou o formato do canal).
- Para o Alan, essa gravação só vale como do dono se o Noah tiver `ownerClaims` (hoje tem, por decisão do Diogo).

**Rotinas agendadas não gravam** (Q3): numa sessão de cron (`skip_memory=False`), o provedor recusa toda gravação. Se mandar mesmo assim, deve mandar `context: "cron"`, e o servidor recusa.

**O recall é dado, não instrução:** o provedor não reformata o bloco nem tira o cercado. O Hermes não sanitiza o que o provedor devolve (issue 136997 de `NousResearch/hermes-agent`).

**Credenciais:** o Client ID e o Client Secret do service token ficam no `.env` do perfil. Hoje o terminal do Noah lê esse arquivo («Known limits» do `profiles/README.md` do `hermes-agents`); o risco está aceito no ADR-0001, §7.

## O Obsidian: pelo git

O Obsidian não chama a API. Ele edita um clone do cofre, e o obsidian-git faz o push. O webhook de push do repositório avisa o Worker, que sincroniza e reindexa.

- **Num conflito com uma gravação na fila, vale a edição do dono:** o merge é de três vias, e o que o servidor perde fica guardado à parte.
- **Para dar o «sim» a uma nota pendente,** apague a linha `review: pending` do bloco `origin` e salve. Uma edição que quebra o bloco não confirma nada.
- **Para arquivar,** ponha `archived: true`; para desarquivar, tire.
- **Para esquecer,** apague o arquivo. Ele some do recall e continua no histórico do git.
- **Um arquivo salvo com marcadores de conflito** fica retido: o Worker continua mostrando a versão anterior até um push sem marcadores.
