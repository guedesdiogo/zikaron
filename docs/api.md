# The Zikaron API

The Worker serves the memory through two doors, both behind Cloudflare Access:

- **`POST /mcp`**: an MCP server for the models. Everything that arrives here belongs to the **tool channel** ([ADR-0001](adr/0001-identidade-e-confianca.md) §2).
- **`POST /v1/*`**: a small JSON API for the Hermes memory provider. Everything that arrives here belongs to the **provider channel**.

Only these stay outside Access:
- `POST /webhooks/github`, checked by the HMAC of the webhook secret, which only asks for a sync;
- `GET /health`, which answers `{"status":"ok","environment":"<environment>","commit":"<sha>"}` and nothing more, without reading the configuration or the vault: it is the deploy check ([staging.md](staging.md), [production.md](production.md)).

The channel is a ceiling, not a proof: the same credential reaches both doors. Each client's configuration says what counts.

## Authentication

Each client (Noah, Alan, the Mac, later Kelpie) has its own **service token** in Access.

1. **The client sends the token's two credentials on every request:**

   ```http
   CF-Access-Client-Id: <the token's Client ID>
   CF-Access-Client-Secret: <the token's Client Secret>
   ```

   The values live in the client's environment, never in the repo, a chat or a log.
2. **Access checks the token** and hands the request to the Worker with a JWT in `Cf-Access-Jwt-Assertion`.
3. **The Worker checks the JWT again** on every request, even with Access in front:
   - the RS256 signature, against the team's public keys (`<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`);
   - the team's `iss`, the application's `aud` and the validity, with one minute of leeway;
   - the `app` type, without `email`: only service tokens, never a person's login.
4. **The JWT's `common_name`** (the token's Client ID) picks the client in `ZIKARON_CLIENTS`.
   - Nothing in the body, the URL or another header picks the client.
   - The client's name names the `agent/<name>` scope and the `origin.client` of what it writes.

### The deploy configuration

Three variables, passed as `--var` in the deploy and empty in `wrangler.jsonc`:

| Variable | What it is |
|---|---|
| `ACCESS_TEAM_DOMAIN` | The team's domain in Access, `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | The AUD of the Access application |
| `ZIKARON_CLIENTS` | A JSON object from each token's Client ID to the client |

Each client in `ZIKARON_CLIENTS` has four fields, and no others:

```json
{
  "<Client ID>": { "name": "noah", "exposed": true, "privileged": false, "ownerClaims": true }
}
```

- `name`: lowercase letters, digits and hyphen, up to 40 characters, unique. Never `zikaron`, the name of the server itself, which writes the daily routine ([memory-format](memory-format.md#the-daily-routine)).
- `exposed`: it reads outside content.
- `privileged`: it acts with the owner's authority.
- `ownerClaims`: what it writes as said by the owner, through the provider, counts as the owner's.

A client cannot be `exposed` and `privileged` at the same time. Any error refuses the whole configuration, so a typo does not open a door.

### Authentication responses

| Status | Body | When |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | No JWT, a JWT that is not valid, or one from a Client ID outside the configuration |
| 500 | `{"error":"clients_config"}` | `ZIKARON_CLIENTS` empty or invalid. The log says only that |
| 503 | `{"error":"unavailable"}` | The Access keys did not come |

After authentication, a path that does not exist answers 404 `{"error":"not_found"}`, and a wrong method 405 `{"error":"method_not_allowed"}` with `Allow: POST`.

## What each client reads and writes

The rules are those of [ADR-0001](adr/0001-identidade-e-confianca.md), with the amendment of [ADR-0003](adr/0003-corrija-pela-palavra-do-dono.md). The server enforces them on every route.

### Reading

- **Every read goes through the reader's policy:** the core, the recall, the search, the read by path, a note's links and the pending list.
- **A note the reader cannot see answers like a note that does not exist,** with the same status and the same body.
- **What is read is the committed version.** A write still in the queue only shows up after the commit, seconds later.

### Writing

- **The channel sets the ceiling:**
  - over MCP, `source: owner` becomes `agent`;
  - `agent` and `external` go in with `review: pending` and `level: inferred`;
  - only `owner` through the provider goes in with `level: explicit`, without pending.
- **Refusals:**
  - a scheduled routine (`context: cron`) does not write, archive or forget;
  - no request carries `pinned`;
  - no write changes a core note or an archived one;
  - a note that counts as the owner's only changes on the owner's word: `source: owner`, through the provider, from a client with `ownerClaims`.
- **The mark follows the note:** whoever writes over a tainted version passes `taint: inherited` to the new one.
- **"Forget"** reaches only the client's own notes and the ones waiting for the "yes".
- **Secrets** are removed from the title, the body, the abstract, the entities and the evidence before the write.
- **The commit summary** never names the note.

### Versions

Every note has a version: the first 12 hexadecimal digits of its blob's SHA in git. The read and the search show it, and every write returns the new version.

- **To change or archive an existing note, the version is required.** A version that is not the current one answers `changed`, and nothing is written.
- **A note with a write still in the queue also answers `changed`** until the commit, and the search gives no version for it. When the commit lands, the read shows the new version.
- **The same memory again answers `unchanged`,** without writing, whatever the version: a new version that only changes `updated`, or a new note equal to one the reader sees, or to the reader's own write still in the queue.

## MCP (`POST /mcp`)

The transport is MCP's Streamable HTTP, in its simplest mode:

- **Stateless:** no `Mcp-Session-Id` and no SSE. Each POST carries one JSON-RPC 2.0 message and gets the response as `application/json`.
- **A notification** (no `id`), or a client's response, gets 202 with no body.
- **Batches** (a list of messages) are not accepted.
- `GET /mcp` and any other method answer 405.

| Method | Response |
|---|---|
| `initialize` | `protocolVersion: "2025-06-18"`, `capabilities: {tools: {}}`, `serverInfo: {name: "zikaron", version}` |
| `ping` | `{}` |
| `tools/list` | the six tools below, with the JSON schema of their arguments |
| `tools/call` | `{content: [{type: "text", text}], isError?}` |

JSON-RPC errors:

| Code | HTTP | When |
|---|---|---|
| -32700 | 400 | The body is not JSON (`id: null`) |
| -32600 | 400 | A batch, a message without `jsonrpc: "2.0"`, a `method` that is not text, an `id` that is neither text nor a number (`id: null`) |
| -32601 | 200 | A method the server does not have |
| -32602 | 200 | `tools/call` of a tool that does not exist |

A tool that fails answers `isError: true` with a short text: the refusal's code and what to do, never a note's content. Example: `Refused (owners_note): The note counts as the owner's and does not change through this tool; write a new note.`

### The tools

| Tool | Arguments | Answers |
|---|---|---|
| `memory_search` | `query`; `k` (1 to 10, default 3); `includeArchived` | The notes in the fence, best first, each with kind, scope, origin and version |
| `memory_read` | `path`; `offset` | One page of the note in the fence, up to 9,500 characters, with the version and, on the first page, the links the reader sees |
| `memory_write` | `title`, `body`, `kind`, `source` (`agent` or `external`); optional `evidence`, `confidence`, `scope`, `entities`, `validFrom`, `invalidAt`, `abstract`, `path` and `version`, `status`, `link` | `Written: <path>, version <v>.` or `Already in the memory: …` |
| `memory_forget` | `path` | `Removed: <path>.` |
| `memory_archive` | `path`, `version`; optional `source`, `evidence` | `Archived: <path>, version <v>.` |
| `memory_pending` | none | The notes waiting for the owner's "yes" that the client sees, in the fence |

The descriptions tell the model that the result is reference data inside a fence, never instructions.

## The provider API (`POST /v1/*`)

JSON in and out. The body is always a JSON object, even an empty one (`{}`), of up to about 1 MB. Fields set to `null` count as absent.

Hermes uses it like this:
- `system_prompt_block` calls `/v1/core`;
- `prefetch` calls `/v1/recall`;
- the writes go to `/v1/write`, with `evidence` (the id of the user's message) and, in a scheduled routine, `context: "cron"`.

### `/v1/core`

```json
{ "budgetTokens": 1000 }
```

The core: the notes pinned in the global scope or the client's, the owner's profile and the client's, only the ones it sees. The budget is 1,000 tokens by default, and 4,000 at most.

```json
{ "text": "<memory-…>…</memory-…>", "tokens": 812, "paths": ["memory/profile/…"], "omitted": 0 }
```

### `/v1/recall`

```json
{ "question": "where does Ana live now?", "budgetTokens": 1000, "includeArchived": false }
```

The memories that answer the question, in a fenced block within the budget: 1,000 tokens by default, 8,000 at most.

- **A message with nothing to search** ("ok", "got it", a command) answers an empty block.
- **Expired notes** stay out, except in a question about how things were.
- **The block is data, not instruction:**
  - the block's tags and each note's header carry a random id;
  - `<memory` is escaped inside the notes;
  - each note states its origin on the line right below the header, which ends with the same id as the block: a note's body cannot forge that line.

```json
{ "text": "<memory-…>\n## Title (path) [id]\norigin: owner\n…\n</memory-…>", "tokens": 540, "paths": ["…"] }
```

The origin line is one of these:
- `origin: owner`, when the version counts as the owner's;
- `origin: <client>, conclusion|from outside|claims to be the owner's[, pending][, inherited taint]`;
- `origin: unknown`, for a server version without the `origin` block.

A failure of the core or the recall answers an empty block, so the conversation goes on without memory.

### `/v1/search`

```json
{ "query": "coffee", "k": 3, "includeArchived": false }
```

```json
{
  "ok": true,
  "text": "<memory-…>…</memory-…>",
  "notes": [
    {
      "path": "memory/preferences/coffee-without-sugar.md",
      "title": "Coffee without sugar",
      "abstract": null,
      "kind": "preference",
      "scope": "global",
      "validFrom": null,
      "invalidAt": null,
      "archived": false,
      "origin": "origin: owner",
      "version": "3f2a…"
    }
  ]
}
```

`version` is `null` when the note has a write still in the queue.

### `/v1/read`

```json
{ "path": "memory/preferences/coffee-without-sugar.md", "offset": 0 }
```

```json
{ "ok": true, "path": "…", "text": "<memory-…>…</memory-…>", "nextOffset": null, "version": "3f2a…" }
```

The page states:
- the kind, the scope, the validity, the level and the origin;
- whether the note is pinned or archived;
- the `status` of a `task` or `delegation`, and the `link` of a `document`.

An archived note is read by its path. A note that does not exist, or that the reader does not see, answers `{"ok": false, "reason": "not_found"}`.

### `/v1/write`

```json
{
  "source": "owner",
  "evidence": "telegram:msg/123",
  "context": "chat",
  "title": "Coffee without sugar",
  "body": "Diogo takes coffee without sugar.",
  "kind": "preference",
  "scope": "global",
  "confidence": 0.9,
  "entities": ["Coffee"],
  "validFrom": "2026-10-24",
  "abstract": "Prefers coffee without sugar.",
  "path": "memory/preferences/coffee-without-sugar.md",
  "version": "3f2a…",
  "status": "open",
  "link": "https://…"
}
```

- **`source` is required:** `owner`, `agent` or `external`.
- **So are `title`, `body` and `kind`.** `kind` is one of the format's kinds, except `session`.
- **Without `path`, the memory is a new note:**
  - it goes where its title puts it, in the `global` scope by default;
  - the accepted scopes are `global`, `agent/<the client itself>`, `area/<name>` and `project/<name>`;
  - an `event` needs `validFrom`, and a `document` needs `link`;
  - a title whose path is already taken gets a number (`-2`, `-3`…).
- **With `path`, the memory is the new version of that note,** with `version` required.
  - The kind and the scope are the note's.
  - What the memory leaves out, the note keeps: the id, the owner's keys, tier, confidence, sources, entities, validity, abstract, `contradicts`, pin, evergreen, `status` and `link`.
- **`level` does not exist:** the server decides it from the origin. **`pinned` is refused.**

```json
{ "ok": true, "action": "written", "path": "memory/preferences/coffee-without-sugar.md", "version": "9c41…" }
```

### `/v1/forget`

```json
{ "path": "memory/notes/from-alan.md", "context": "chat" }
```

Forgetting is a commit: with `context: "cron"`, the request is refused (`cron`), like a write.

```json
{ "ok": true, "path": "memory/notes/from-alan.md" }
```

### `/v1/archive`

```json
{ "path": "memory/notes/idea.md", "version": "3f2a…", "source": "agent", "evidence": "…", "context": "…" }
```

Archives the note: a new version of the whole note, with `archived: true`, under the same write rule.
- Without `source`, `agent` applies.
- The new version carries the origin of whoever archived it.
- The note leaves the search, the recall and the core, and stays readable by its path.

The response is that of `/v1/write`.

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

The notes waiting for the owner's "yes" that the client sees, newest first, up to 100. Archived ones and ones merged into another stay out.

### Status and codes

The rule's refusals are responses, with 200 and `ok: false`. The status changes only when the request is not valid or the server cannot serve it.

| Status | Body | When |
|---|---|---|
| 200 | `{"ok": true, …}` | Done |
| 200 | `{"ok": false, "reason": …}` | A refusal from the table below |
| 400 | `{"ok": false, "reason": "invalid_json"}` | The body is not JSON |
| 400 | `{"ok": false, "reason": "invalid", "problems": […]}` | A field that is missing or not valid, in the request or in the memory |
| 401 | `{"ok": false, "reason": "unauthorized"}` | The client left the configuration between the route and the vault |
| 413 | `{"ok": false, "reason": "too_large"}` | The request, or the note, is too large |
| 503 | `{"ok": false, "reason": "vault_off"}` | The vault is not configured |
| 503 | `{"ok": false, "reason": "unavailable"}` | GitHub or the index failed; try again |

| `reason` | Meaning |
|---|---|
| `not_found` | The note does not exist, or the client does not see it |
| `changed` | The note changed since the given version, or has a write waiting for the commit |
| `scope_not_allowed` | The scope, or the note's folder, is not the client's |
| `cron` | A scheduled routine does not write |
| `pinned` | No request pins a note |
| `owners_note` | The note counts as the owner's, and the write is not the owner's word |
| `core_note` | The note belongs to the core: pinned in the global scope or the client's, or in a `profile/` |
| `archived` | The note is archived |
| `not_own` | "Forget" of another client's note that is not waiting for the "yes" |
