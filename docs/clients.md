# How each client uses Zikaron

Every client talks to the same Worker. What sets them apart is each one's configuration in `ZIKARON_CLIENTS` ([api.md](api.md#the-deploy-configuration)) and the door it uses: `/mcp` is the tool channel, and `/v1/*` is the provider channel ([ADR-0001](adr/0001-identidade-e-confianca.md) §2).

| Client | Door | `exposed` | `privileged` | `ownerClaims` |
|---|---|---|---|---|
| Noah (Hermes) | `/v1/*` through the provider, `/mcp` through the tools | yes | no | yes |
| Alan (Hermes) | `/v1/*` through the provider, `/mcp` through the tools | no | yes | no |
| Diogo's Mac (Claude Code) | `/mcp` | no | yes | no |
| Obsidian | none: git and the webhook | — | — | — |

Each client has its own service token in Access. The Client ID and the Client Secret live in the client's environment, never in the repo or in a chat.

## The Mac: Claude Code over MCP

An HTTP MCP server, with the two Access headers taken from the environment:

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

- **Tools:** `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_archive` and `memory_pending` ([api.md](api.md#the-tools)).
- **Over MCP, nothing counts as the owner's:** a write goes in as a pending conclusion, until the "yes" in the vault.
- **The Mac is `privileged`:** it never receives a tainted note, not even one it wrote itself from something read outside.

## Hermes: the memory provider contract

For guedesdiogo/hermes-agents#21. Hermes v0.22.5 has a single external provider active at a time. Its methods (`website/docs/developer-guide/memory-provider-plugin.md`, at tag v0.22.5) map like this:

| Provider method | Call | What to do |
|---|---|---|
| `system_prompt_block()` | `POST /v1/core` | The core, in up to 1,000 tokens: the block goes as it is, already fenced. |
| `prefetch(query)` and `queue_prefetch` | `POST /v1/recall` | The turn's recall, with `question` and `budgetTokens`. The block goes after the user's last message, never in the system prompt. |
| `sync_turn(...)` | nothing in v1 | Keep the id of the user's last message: it is the evidence for "the owner said". Automatic turn capture is out of v1. |
| `on_memory_write(...)` | `POST /v1/write` | Hermes's own memory tool is the model deciding: write with `source: agent`. |
| `on_session_end()` | nothing | — |
| its own tools | `POST /v1/*` | Search, read, forget, archive and pending, with `source: agent` on the writes. |

**"The owner said" needs evidence** (ADR-0001 §2):
- The provider sends `source: owner` only when the text to write is in the user's last message that `sync_turn` saw. It checks that in the provider itself, not in the model.
- `evidence` carries that message's id (`telegram:<chat>/<message>` or the channel's format).
- For Alan, that write only counts as the owner's if Noah has `ownerClaims` (today it does, by Diogo's decision).

**Scheduled routines do not write** (Q3): in a cron session (`skip_memory=False`), the provider refuses every write. If it sends one anyway, it must send `context: "cron"`, and the server refuses.

**The recall is data, not instruction:** the provider does not reformat the block or strip the fence. Hermes does not sanitize what the provider returns (issue 136997 of `NousResearch/hermes-agent`).

**Credentials:** the service token's Client ID and Client Secret live in the profile's `.env`. Today Noah's terminal reads that file ("Known limits" in the `profiles/README.md` of `hermes-agents`); the risk is accepted in ADR-0001, §7.

## Obsidian: through git

Obsidian does not call the API. It edits a clone of the vault, and obsidian-git pushes. The repository's push webhook notifies the Worker, which syncs and reindexes.

- **In a conflict with a queued write, the owner's edit wins:** the merge is three-way, and what the server loses is kept aside.
- **To give a pending note the "yes",** delete the `review: pending` line from the `origin` block and save. An edit that breaks the block confirms nothing.
- **To archive,** set `archived: true`; to unarchive, remove it.
- **To forget,** delete the file. It leaves the recall and stays in the git history.
- **A file saved with conflict markers** is held: the Worker keeps showing the previous version until a push without markers.
