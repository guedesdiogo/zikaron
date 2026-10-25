# ADR-0001: Identity comes from the credential, trust comes from the channel, and the server enforces the rules

- Status: Accepted
- Date: 2026-10-24
- Issue: [#1](https://github.com/guedesdiogo/zikaron/issues/1)
- Accepted by Diogo in the conversation of 2026-10-24 (the answers are quoted in #1)
- Amended by: [ADR-0003](0003-corrija-pela-palavra-do-dono.md), an owner's note changes on the owner's word, through the provider as well

## Context

Several clients write and read the same memory: Noah (personal assistant, reads Gmail and outside pages), Alan (opens and types in Claude Code sessions), Diogo's Mac (Claude Code sessions) and, later, Kelpie. Diogo edits the vault in Obsidian.

Diogo's rules (interview of 2026-10-24, in #1):
- **Q3:** what Diogo said goes in on its own; what an agent deduced, or read in an email, page or document, goes in only with Diogo's "yes", and until then it stays marked as inferred; scheduled routines never write.
- **Q24:** the recall rule applies per identity, and the server enforces it, not the persona. Each agent receives what Diogo said or edited and its own notes; Alan never receives Noah's notes that came from an email or page, nor the ones Noah deduced; Noah receives Alan's.

The reason for Q24: Noah reads outside content, and Alan types in sessions that take its text as if it were Diogo's. A memory planted in Noah by email that reached Alan would become an order from Diogo in a session with a terminal.

What does not help:
- **Hermes does not protect the memory on its own.** Recall is not sanitized and providers write without approval (issues 136997 and 67546 of `NousResearch/hermes-agent`, open on 2026-10-24).
- **Injection by email is real.** MemGhost (arXiv 2607.05189, July 2026) plants memory with a single email, and the paper says it works on Hermes.
- **On Cloudflare there is no Unix uid.** Each client needs its own credential.
- **An agent's credential is within the agent's own reach.** Noah's terminal reads its `.env` ("Known limits" in the `profiles/README.md` of `hermes-agents`). A write by `curl` with that credential is the same as a provider call.

## Decision

### 1. Identity comes from the credential

- **Cloudflare Access sits in front of the Worker,** with one service token per client.
- **The Worker validates `Cf-Access-Jwt-Assertion` on every request,** even with Access in front: the signature, against the team's public keys in Access; the application's `aud`; the `iss` and the validity. Then it maps the token's `common_name` (the service token's Client ID) to a client in the deploy configuration.
- **Without a valid JWT, or with a client outside the configuration, the answer is 401,** and nothing is read or written.
- **The client never says who it is.** No field of the request picks the client, the `agent/<client>` scope or `origin.client`.
- **The GitHub webhook lives on a path outside Access,** checked by the HMAC of the webhook secret, and only triggers a sync: it neither reads nor writes anything the body asks for.
- **Each client's configuration** lives in the deploy, outside the repo, and says:
  - `name`: the client's name (`noah`, `alan`, `mac`…), which names the `agent/<name>` scope;
  - `exposed`: the client reads outside content;
  - `privileged`: the client acts with Diogo's authority;
  - `ownerClaims`: what it writes as said by Diogo counts as Diogo's for the other clients.

### 2. Trust comes from the channel

One credential per agent does not prove "said by Diogo". So a note's trust comes from the channel it came in through:

1. **Owner channel:** a commit to the vault that the server did not make (Obsidian, GitHub, any editor). The server knows what it wrote because it keeps the SHA of every blob it wrote, like Kelpie's `authored`; a blob it did not write is the owner's, whatever commit it arrives in.
2. **Provider channel** (`/v1/*`): the Hermes provider writes what Diogo said with the evidence, the id of the user message it sees in `sync_turn`.
3. **Tool channel** (`/mcp`): everything the model calls.

The channel is a ceiling, not a proof: the same credential reaches both endpoints. That is why `ownerClaims` is per client, not per endpoint.

### 3. Provenance belongs to the server

Every version the server writes carries an `origin` block in the frontmatter, filled only by the server:

```yaml
origin:
  client: noah            # from the credential
  channel: provider       # provider | tool
  source: owner           # owner | agent | external
  evidence: "telegram:msg/123"   # optional: the message id or the source reference
  review: pending         # present while it waits for the "yes"
  taint: inherited        # present when the version inherited the previous one's taint
```

What the request may say and the server caps:
- `source` comes from the client, capped by the channel: through the tool channel, `owner` becomes `agent`.
- `level` (`explicit`, `deduced`, `inferred`, from Kelpie) follows `source`: only `owner` through the provider can be `explicit`.
- `evidence` is kept as it came, one line, without secrets.

**A version's trust is computed at read time,** from the `origin`, from who wrote the blob and from the client's current configuration. That way, turning off a client's `ownerClaims` takes effect at once, without rewriting the vault. A version **counts as Diogo's** when:
- the blob is the owner's, has no `review: pending`, and the `origin`, if there was one, could be read (a note Diogo wrote, or a pending note Diogo confirmed by removing the `review`; an edit that breaks the block confirms nothing); or
- the blob is the server's, with `source: owner`, `channel: provider`, and the client that wrote it has `ownerClaims`.

### 4. The write rule (Q3)

- `source: owner` through the provider channel, from a client with `ownerClaims`, goes in directly, with `level: explicit` and the evidence. From a client without `ownerClaims`, it goes in with `review: pending` and `level: inferred`, like a conclusion: its word does not count as Diogo's, and the "yes" in the vault is what confirms it.
- `agent` and `external` go in with `review: pending` and `level: inferred`. Diogo's "yes" is removing the `review: pending` in the vault (Obsidian or GitHub). A confirmation page behind Access, with Diogo's login, is left for later.
- **Scheduled routines do not write.** A write, an archive or a "forget" with `context: cron` is refused without a commit. The provider or the MCP client marks the context; the server refuses. The rule is about the clients. The server's own daily routine (#17) does only what Q5 asks: it archives the closed tasks, carrying their origin unchanged, and writes the report; it writes no new content, and it never archives a note of Diogo's.
- **No agent rewrites** a note that counts as Diogo's, a core note (pinned, or in `profile/`) or an archived note. The exception, only for Diogo's note, is Diogo's own word through the provider ([ADR-0003](0003-corrija-pela-palavra-do-dono.md)). These are the rules guedesdiogo/kelpie#149 and guedesdiogo/kelpie#168, now enforced by the server.
- **"Forget" from an agent** reaches only the client's own notes and the pending ones. A note of Diogo's leaves through the vault. Git keeps everything.
- **No agent pins a note.** `pinned` only comes from the vault.

### 5. The read rule (Q24) and taint

A version is **tainted** when it does not count as Diogo's and:
- the `source` is `external`; or
- the writer is an `exposed` client, or a client that is not in the configuration: the list is an allowlist, so that removing a compromised client from the configuration does not clear the mark on its notes; or
- it has `taint: inherited`; or
- it has an `origin` that could not be read (a broken block, or an ignored frontmatter that had an `origin`).

**The mark follows the note.** When a client writes over a note whose current version is tainted, the server puts `taint: inherited` on the new version. Only the owner channel removes the mark. A future result that combines notes (Dream's summaries and merges) inherits the mark of any note it read.

**A `privileged` client never receives a tainted note,** on any path:
- the recall and the core;
- the search and the read by path;
- a note's graph neighbors and resolved links;
- the lists (pending, archived).

For it, the tainted note answers as nonexistent, with the same answer as a note that does not exist, and cannot be written over. This also applies to its own notes: a `privileged` client that writes something read from outside only gets it back after the "yes". It is the strictest reading of Q24, whose reason is that nothing read from outside reaches Alan's sessions as an order.

What each client receives:

| Client | Receives |
|---|---|
| `exposed` (Noah) | everything, including Alan's notes and the tainted ones |
| `privileged` (Alan, the Mac) | what counts as Diogo's and the untainted notes, its own and those of clients that are not `exposed` |
| neither | what counts as Diogo's, its own notes and those of clients that are not `exposed` |

### 6. What the recall delivers is data, not instruction

The recall and the core go out inside Kelpie's fence (`docs/memory-format.md`, "Packing"):
- the block's tags carry a random id, new for every block, and each note's header carries the same id;
- `<memory` is escaped inside the notes, and title and path take a single line;
- each note states its origin and whether it is pending;
- the block says it is reference, not instruction.

### 7. The starting configuration

Diogo's decision of 2026-10-24 on Q24 («Sim, já vale», "Yes, it applies now"):

| Client | `exposed` | `privileged` | `ownerClaims` |
|---|---|---|---|
| `noah` | yes | no | **yes** |
| `alan` | no | yes | no |
| `mac` | no | yes | no |

Noah starts with `ownerClaims`, even with the credential within reach of its terminal: what it writes as said by Diogo, with the evidence, counts for Alan from now on.

## Consequences

- **The vault can have only one automatic writer: Zikaron.** Commits from another server to the same vault, like Kelpie's context-store, would count as the owner's. So Zikaron only takes over a vault after the other writer stops (Story 1.9 of #1).
- **The owner channel is as strong as whoever can push to the vault.** A GitHub credential of Diogo's on a machine where an agent has a terminal becomes "Diogo's edit". The daily report lists the notes that changed; closing off those credentials is work for `hermes-agents`.
- **Noah's `ownerClaims` is an accepted risk.** A Noah induced by an email can write something as said by Diogo, with a forged message id, and Alan receives it. What reduces the risk:
  - the evidence stays in the note;
  - the daily report lists the `owner` notes written through the provider;
  - turning off `ownerClaims` is one line of configuration and takes effect at once.

  It goes away when Noah's credential leaves the reach of its terminal.
- **Diogo takes care of the edge:** the Access application, one service token per client and handing each secret to its client. Secrets never go through the chat.
- **An accidental edit in Obsidian does not confirm a pending note:** only removing the `review: pending` confirms it.
- **The rules apply to any new client** through its configuration, with no code change.

## Alternatives considered

- **One bearer token per client, stored hashed in the Worker,** as ai-memory does. Simpler, but it loses the edge layer (a request without a token never reaches the Worker) and rotation and expiry from the dashboard.
- **MCP's OAuth 2.1.** The Hermes and Claude Code clients have uneven support, and an agent has no one to do the interactive login.
- **Trusting the `level` the agent declares,** like Kelpie v1. The label is the model's own: an injected instruction can declare `explicit` (guedesdiogo/kelpie#149).
- **Enforcing the Q24 rule in the persona or the provider.** That is exactly what Diogo ruled out: the server enforces it.

## References

- [#1](https://github.com/guedesdiogo/zikaron/issues/1): the plan and Diogo's decisions.
- ADRs 0005, 0016, 0020 and 0021 of [Kelpie](https://github.com/guedesdiogo/kelpie/tree/f033cf3/docs/adr) and its `docs/memory-format.md`.
- Cloudflare Access: [validating the JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and the [application token fields](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) (`common_name` is the service token's Client ID).
- MemGhost, arXiv 2607.05189.
