# Memory format

> **Origem.** Esta especificação veio do Kelpie em [`f033cf3`](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/memory-format.md), em inglês, como o código que ela descreve. Onde ela diz «Kelpie», leia o servidor que escreve no cofre; os links relativos apontam para o repo do Kelpie. O que o Zikaron muda está no [ADR-0001](adr/0001-identidade-e-confianca.md), no [ADR-0002](adr/0002-extracao-do-kelpie.md) e entra aqui pela Story 1.3 do #1.

Kelpie's memory lives in the owner's vault: Markdown files in a private git repository ([ADR-0016](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0016-vault-second-brain.md)), in a format of Kelpie's own ([ADR-0020](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0020-shared-memory-engine.md)). This page is the spec for that format and for the index Kelpie derives from it. The code is in [`packages/memory`](https://github.com/guedesdiogo/kelpie/tree/f033cf3/packages/memory).

The rules that shape everything below:
- **The vault is the truth.** Every index is derived from it and can be rebuilt from it. Deleting the index loses nothing.
- **A file holds only the current version of a memory.** Git keeps every earlier version, and the index keeps them too, each pointing at its commit.
- **People read and edit these files,** in Obsidian or any editor. Kelpie's own writes are strict; its reads are lenient, and never drop a note for a bad value.
- **The format is Kelpie's own.** It borrows ideas from ai-memory, but isn't compatible with it.

## Where memory lives

The path decides a note's scope. A note's kind comes from its kind folder when it has one.

| Scope | Folder | Example |
|---|---|---|
| `global` | `memory/` | `memory/people/ana-souza.md` |
| `global`, the owner's free notes | `knowledge/` | `knowledge/receitas.md` |
| `agent/<agent-id>` | `agents/<agent-id>/memory/` | `agents/kelpie/memory/preferences/tone.md` |
| `area/<name>`, an area of life or work | `areas/<name>/` | `areas/work/decisions/vendor.md` |
| `project/<name>`, kept for coding later | `projects/<name>/` | `projects/kelpie/procedures/release.md` |
| `conversation/<name>` | `conversations/<name>/` | `conversations/family/sessions/2026/2026-12-24-natal.md` |

Under a scope's folder, the first folder may name a kind:

| Kind | Folder | Default tier |
|---|---|---|
| `preference` | `preferences/` | semantic |
| `commitment` | `commitments/` | semantic |
| `event` | `events/` | episodic |
| `person` | `people/` | semantic |
| `place` | `places/` | semantic |
| `decision` | `decisions/` | semantic |
| `procedure` | `procedures/` | procedural |
| `note` | `notes/` | semantic |
| `session` | `sessions/` | episodic |

Rules for paths:
- **A scope's name is its folder's name,** such as `areas/Saúde & Bem-estar/`. It can't hold a slash, a backslash, or a control or bidirectional character, and can't start or end with a dot or a space; notes in such a folder are outside the index.
- **Under `knowledge/`, folders are the owner's own** and never name a kind. A note there takes its kind from its frontmatter, or is a `note`.
- **A note outside a kind folder** takes its kind from the frontmatter, or is a `note`. Examples: `areas/work/meeting-notes.md`, `memory/loose-note.md`.
- **Kind folders may have subfolders.** Kelpie files dated memories (sessions, events) under their year, date first: `sessions/2026/2026-10-06-family-chat.md`.
- **File names are readable.** Kelpie writes the title in lowercase ASCII, diacritics folded, with words joined by hyphens: "Café sem açúcar" becomes `cafe-sem-acucar.md`. The owner's own notes keep whatever names they have.
- **Outside the memory index:**
  - root files (`README.md`, `AGENTS.md`, `USER.md`, `index.md`, `log.md`);
  - skills (`skills/`) and each agent's `SOUL.md`, `AGENTS.md` and `skills/`, which the Context Store loads separately;
  - hidden folders (`.obsidian/`, `.trash/`);
  - folders under `memory/` whose name starts with `_`, which hold Kelpie's own files, such as the [lifecycle report](#lifecycle) at `memory/_lint/report.md`. No agent may write there. A file directly under `memory/`, such as `memory/_inbox.md`, is still a note;
  - anything that isn't `.md`;
  - symbolic links, even named `.md`: git keeps the target's path as the file's content, not a note.

## A memory file

YAML frontmatter, then a `# Title` heading, then the body. This is a person, as Kelpie writes it:

```markdown
---
id: 3f9a1c2b7d4e5f60
kind: person
scope: global
tier: semantic
level: explicit
confidence: 0.9
sources:
  - "[[2026-10-06-family-chat]]"
  - telegram:-100123/456
entities:
  - Ana Souza
  - Lisboa
valid_from: 2026-01-01
evergreen: true
abstract: The owner's sister; she lives in Lisbon.
updated: 2026-10-06T12:00:00Z
---

# Ana Souza

The owner's sister. Lives in [[Lisboa]] and works in design.
```

A commitment that holds for a while, with a contradiction it resolves:

```markdown
---
id: 9c0d5e4f3a2b1c8d
kind: commitment
scope: area/work
tier: semantic
level: deduced
confidence: 0.8
sources:
  - "[[2026-10-06-weekly-sync]]"
valid_from: 2026-11-01
invalid_at: 2026-12-01
relations:
  contradicts:
    - "[[report-due-in-october]]"
updated: 2026-10-06T15:20:00Z
---

# Monthly report due on the 5th

From November, the monthly report is due on the 5th of each month, not the 30th.
```

The owner's own note, which needs no frontmatter at all:

```markdown
# Bolo de fubá

Receita da avó: milho, ovos, leite. Ver [[Receitas]].
```

## Frontmatter

Every key is optional when reading. When Kelpie writes, it always sets `id`, `kind`, `scope`, `tier`, `level`, `confidence` and `updated`, and it sets the others only when they have a value.

| Key | Value | Meaning | When missing or invalid |
|---|---|---|---|
| `id` | 1–64 of `A-Z a-z 0-9 . _ : -`, starting with a letter or digit; Kelpie writes 16 hex digits | The memory's stable id (see below) | none |
| `kind` | a kind from the table above | What the memory is | the kind folder, else `note` |
| `scope` | `global`, or `agent/…`, `area/…`, `project/…`, `conversation/…` | Who the memory belongs to | the path's scope |
| `tier` | `episodic`, `semantic`, `procedural` | How long it is expected to matter; decay reads it (#111) | the kind's default |
| `level` | `explicit`, `deduced`, `inferred` | Said by the owner, deduced from what was said, or guessed | none |
| `confidence` | a number from 0 to 1 | How sure the writer was | none |
| `sources` | up to 20 strings, each one line of up to 300 characters | Where it came from: a wikilink to a vault note (`"[[2026-10-06-family-chat]]"`) or any reference, such as a message id | none |
| `entities` | names of up to 64 characters; at most 10 are kept | What the memory is about | none; a bad name drops that name only |
| `valid_from`, `invalid_at` | `YYYY-MM-DD`, or a date-time with an offset; a real calendar date, so `2026-02-30` is invalid | When the fact starts and stops being true in the world. A date is the start of that day in UTC, and `invalid_at` must come after `valid_from` | always valid |
| `evergreen` | `true` or `false` | Exempt from decay | `false` |
| `pinned` | `true` or `false` | Loaded into the agent's always-loaded core, when the agent has it on and the note is in the global scope or the agent's own; and exempt from decay | `false` |
| `abstract` | one line of up to 300 characters | A summary that retrieval can show before the whole note | none |
| `relations` | `contradicts:` or `merged_into:`, each with a list of wikilinks | `contradicts` names the notes this one contradicts. `merged_into` names the note this one was merged into (#112): see "Merged notes" below. The vocabulary is closed: any other key makes the whole field invalid | none |
| `updated` | a date-time with an offset | When this version was written | none |
| `title` | a string | Overrides the heading; Kelpie keeps it in step with the title when it is present | the first `# ` heading, else the file name |

How a file is read:
- **YAML 1.2.** Dates stay strings, and `yes`/`no` are strings, not booleans. Duplicate keys and aliases (`&a`/`*a`) make the frontmatter invalid. A frontmatter block longer than 16 KB is ignored, and so are the keys `__proto__`, `constructor` and `prototype`.
- **What one note may cost the index:** the first 262,144 characters of its body and its first 500 links are indexed, with a warning past either.
- **A BOM before the fence is dropped, and CRLF fences are accepted.**
- **Leniency.** An invalid value is ignored and noted as a warning, which the index keeps for lint. Invalid YAML leaves the note indexed with no frontmatter. A note is never dropped.
- **The path wins.** If `kind` disagrees with the kind folder, or `scope` with the path, the folder and the path win, with a warning: moving a file in Obsidian is how the owner reclassifies it.
- **Unknown keys are kept,** such as Obsidian's `aliases` and `tags`. Kelpie never removes them, and when it writes a new version it keeps them, with their comments, in their places.

How Kelpie writes a new version:
- **The input is the whole version.** A field Kelpie manages and the input leaves out is removed, and the body is replaced. A writer that keeps a field, such as a `pinned` the owner set in Obsidian, reads the note first and carries it over.
- **A file whose frontmatter can't be read is refused,** rather than rewritten without the owner's keys. Examples: a half-saved edit, a duplicate key, aliases, or more than 16 KB. The owner fixes it first.
- **Text fields are one line,** with no control characters and no bidirectional overrides, which can make a title read differently from what it holds.

### Identity and versions

- **A memory's identity is its path.** Each version written at a path supersedes the one before it, and removing the file ends the chain. Writing the path again continues the chain.
- **`id` is a content hash, taken once.** Kelpie mints it from the first version's scope, kind, title and body: the first 16 hex digits of a SHA-256.
  - Later versions keep it, so sources and relations can point at a memory whatever it says now.
  - Writing the same new memory twice produces the same file and the same id.
- **The index never trusts a hash stored in a file,** because an edit in Obsidian doesn't recompute one. It keys each version by its git blob SHA: the value GitHub's trees report, which is what lets the sync skip Kelpie's own commits (#41). The sync passes the SHA from the tree. Without it, the index computes it from the text, which matches git as long as the text was decoded without dropping a BOM.
- **A rename is a new chain in the index.** Git still has the history.

### Two kinds of time

- **World time** is `valid_from` and `invalid_at`: when a fact is true. Retrieval can ask for the memories valid at an instant.
- **Ingestion time** is when the vault started and stopped holding a version: the commit that wrote it and the commit that replaced it. "As of" questions use ingestion time. They answer what memory said then, not what was true then.
  - Committer times can go backwards, after a rebase or with a skewed clock, and two commits can share a millisecond. The index records each commit at least a millisecond after the one before, so every version's window has a start and an end in order.

## Session pages

Every conversation's history becomes session pages (#109), with no model call:
- **When:** a session ends when the conversation stays quiet for 30 minutes, or when a summary checkpoint is written ([ADR-0017](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0017-history-compaction.md)). The next message starts a new session.
  - While a turn runs or a message waits for one, the session goes on, and its close is tried again 10 minutes later. A checkpoint written during a turn therefore leaves the session to the quiet timer.
  - When the Context Store can't be reached, or doesn't answer within 10 seconds, the close is tried again 10 minutes later, with the messages that came since.
  - A page that can't be built, or that the vault refuses, is skipped with an error logged, so the sessions after it still get written. Its messages stay in the conversation's history.
- **Where:** `conversations/<channel>-<chat>/sessions/<year>/<date>-<time>-<first words>-<id>.md`, where `<id>` is the number of the session's first message in the conversation's history, so two sessions never share a file. A group's chat id, which starts with `-`, becomes `g`.
- **What:**
  - a title, from the time and the first message from a person;
  - a line with the channel, the date, the times and the number of messages;
  - each message as one line, with its time and speaker, up to 2,000 characters;
  - a session of more than 200 messages keeps the first 100 and the last 100;
  - the messages take at most 60,000 characters in all, the metadata line aside: past that, the ones nearest the middle go first, so a long day keeps its start and its end. Full-text search covers every message a page keeps; the embedder reads a page's first 6,000 characters.
  - **Why these limits (#326):** #297's measurement found that a page of 280 characters a message, keeping the first and last 30, lost every answer past its cut, and that these limits reach most of them ([memory-eval.md](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#session-recall-297)).
- **Time zone:** the latest one a person in the conversation gave, or UTC.
- **Inert in Obsidian:** a message can't act when the owner opens the page. HTML, embedded images, inline code (which plugins such as Dataview run) and `%%` comments (which hide text from the owner but not from the agent) are escaped, and `[[` is broken, so a message adds no links to the vault.
- **Secrets:** each message is normalized to NFC and stripped of invisible characters: terminal escapes, controls, Unicode's default-ignorable characters (zero-width spaces and joiners, bidirectional controls, variation selectors, tag characters) and the Braille blank. Emoji joined by a zero-width joiner come apart. Only the first 8,192 characters are read, cut back to a space. Secrets are replaced with `[REDACTED:<kind>]` before each message is cut to 2,000 characters. Nothing else is filtered: other people's data stays (ADR-0020 §4).
  - **Covered:**
    - API keys and tokens with a known prefix: OpenAI, Anthropic, xAI, Groq, Stripe, GitHub, GitLab, AWS, Google, Meta, npm, Hugging Face, SendGrid, Slack, Cloudflare, DigitalOcean, Shopify, PyPI, Supabase, Linear, Notion, Postman, Twilio, GoHighLevel, and webhook secrets;
    - Telegram bot tokens, JWTs, and Slack and Discord webhook URLs;
    - private keys, with or without their header. A key one person pastes across several messages stays out until it ends, for up to 10 minutes after their last message that held it, also across sessions;
    - credentials in URLs, curl commands and long command-line flags, signed URLs' signatures, cookies, auth headers and secret environment assignments;
    - passwords named in a field (`senha: x`, `"password": "x"`, `senha do wifi: x`), with a quoted value taken whole;
    - passwords named in prose, in English, Portuguese and Spanish (`a senha nova é x`, `my password is: x`), when the value holds a digit or a symbol;
    - tokens, secrets and keys named in a field or in prose, when the value holds a digit or a symbol (in prose, eight or more characters with a digit);
    - 40-character keys in a message that names AWS or Cloudflare, and Cloudflare's 37-character global key.
  - **Not covered:**
    - a secret with no known shape and no name next to it;
    - a password made only of letters, given in prose;
    - a short flag such as `mysql -pX`, since `-p` is also a port;
    - look-alike characters, and secrets wrapped in base64 or hex.
- **Trust:** `level: explicit`, since it is what was said, and `confidence: 0.9` for a private chat, `0.6` when more than one person spoke.
- **History:** stays in the conversation's Durable Object; nothing is deleted once it is in a page. Whether to prune it, and when, is an open decision.

## Links

- **Wikilinks:** `[[Ana Souza]]`, `[[Ana Souza|Ana]]`, `[[Ana Souza#Contact]]`, `[[Ana Souza#^block]]`, with `\|` inside tables.
  - A link without a `/` names a file, which Obsidian finds anywhere in the vault. Names may hold dots (`[[Node.js]]`, `[[Meeting 2026.10.06]]`).
  - A link with a `/` is a path from the vault's root, or from the note's folder when it starts with `./` or `../`.
- **Embeds:** `![[Recipe]]` is a link of its own kind. Links and embeds of attachments are skipped. An attachment is a file with an image, audio, video, PDF, canvas, base, office or archive extension, such as `![[photo.png]]` or `[[doc.pdf]]`.
- **Markdown links:** `[text](../places/lisboa.md)` must name a `.md` file and resolves from the note's folder. URLs, `mailto:` and images are skipped.
- **What else is skipped:** links in fenced code blocks and inline code, and same-note links (`[[#Heading]]`).
  - A fence may open on a list item or in a quote (``- ```sh``, ``> ```  ``).
  - Inline code that spans lines isn't seen as code.
- **Frontmatter links:** wikilinks in `sources`, `relations.contradicts` and `relations.merged_into` become links of those kinds.
- **Resolution** follows Obsidian, against the vault's current notes, with names and paths compared in Unicode NFC:
  - a path names one note;
  - a file name matches case-insensitively;
  - when two notes share a name, the one in the linking note's folder wins, then the shorter path;
  - a link that matches nothing stays unresolved until a note with that name appears;
  - a lookup limited to a set of scopes resolves a link among the notes in them only, so a note in another scope can't take the link from one in them (#150).

### Merged notes

A note merged into another (#112) stays at its path. It is never deleted.
- **Its mark:** `relations.merged_into` names the note it went into, and its body says so. The owner can mark a note by hand the same way.
  - **The mark counts** while it names, with a path link (`[[memory/notes/cafe]]`, or one relative to the note's folder), another current note of its own scope, as Dream writes it. A mark by name gets a warning on the note, since it merges nothing.
    - A mark by name hides nothing, since a name may resolve to the note itself or to a namesake elsewhere. So does a mark that leads nowhere, to the note itself or to another scope.
    - A mark is read against the vault as it is now, as a link resolves. A lookup as of an earlier time leaves out a version whose mark counts today.
  - **The body Dream writes** is one line: the note it went into, and the commit that still holds what it said ("Dream" below).
  - Removing the mark makes it a note again.
- **What it still is:** a file to read by its path, and a link to it still resolves to it, as in Obsidian.
- **What it no longer is:**
  - **Found:** search, title and entity lookups, vectors, the lifecycle report and the always-loaded core leave it out, even when it is pinned.
  - **Embedded:** it gets no vector.
  - **Dream's:** no Dream operation picks it.
  - **A neighbour:** one step from a note that links to it is the note it went into, in its own scope, when the lookup sees it. That is one step only: a link to a note merged into one that was merged in turn leads nowhere.
- **Writing to it:** the agent's `memory_write` refuses it while the mark counts, so the mark isn't lost, and names the note to write to: the turn sees that one, as it's in the same scope.

## Entities

Names are trimmed and their whitespace collapsed. A name that is empty, longer than 64 characters or holds control characters is dropped. Lookups use a key that is lowercase with diacritics folded, so "João" and "joao" are one entity. A note keeps at most 10, and duplicates by key are dropped.

## The index

The index is one SQLite database inside the Context Store's Durable Object ([ADR-0005](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0005-context-store.md)). It is built from commits, in order.

| Table | Holds |
|---|---|
| `commits` | Every commit applied, with its order and time |
| `versions` | One row per version of every indexed note: the commit that wrote it, its blob SHA, the commit it superseded, whether it is current, its ingestion window, and the parsed frontmatter and body. At most one current version per path |
| `versions_fts` | FTS5 over title, abstract, body and the path's words. It uses `unicode61 remove_diacritics 2`, so "acucar" finds "açúcar" |
| `entities` | Each version's entities. A version's title is also kept folded, so an entity's own page, the note titled with its name, can be found |
| `links` | Each version's links, unresolved: they are resolved when read |
| `embeddings` | Vectors keyed by blob SHA and model; filled by retrieval (#110) |
| `meta` | The schema version |

- **Applying a commit:**
  - each changed file outside the index is skipped;
  - a file whose content is unchanged adds nothing;
  - a changed file adds a version and closes the previous one;
  - a removed file closes its current version.

  A commit applied twice is skipped, so a repeated webhook is harmless. Commits apply one at a time, in the order they arrive, and a rebuild runs alone: a commit that arrives during a rebuild waits for it. That holds within one index instance, so a Durable Object keeps one.
- **Rebuild:** dropping every derived table and replaying the vault's history gives the same index, row for row. That is tested.
  - Rebuilding from the head alone gives the same current notes, without their history.
  - Embeddings of content still in the history survive a rebuild: they are keyed by content, so they stay valid, and recomputing them costs model calls. Embeddings of content no longer in the history are deleted.
- **Erasure** is the operator's job (ADR-0020 §4): rewrite the vault's git history, then rebuild the index. The rebuild drops every version, link and embedding of the erased text. Conversations keep the memory blocks their answered turns were sent with (#137), as they keep their history. They also keep the always-loaded core until it loads again; [context-store.md](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/context-store.md#erasing-content) says how to make it load again.
- **Search:** current versions only by default. With `asOf`, it searches the versions the vault held at that instant. With `validAt`, it keeps only memories valid in the world at that instant. It returns 1 to 100 results, 10 by default.
- **Entity lookup:** the notes that name any of a set of entity keys, current or as of an instant. An entity's own page, a note titled with the name that lists it, comes first, a global one before a scoped one. Each key weighs one over the number of notes that name it, so a rarer name says more. A name on more than 50 of the versions the lookup sees is left out: it singles nothing out. The weight and the cap count those versions only, so notes in other scopes, and a note's past versions, don't switch a name off (#146).
- **Neighbours:** the current notes one step from a note: the notes it links to, then the pages of the entities it names, global ones first. A note it contradicts is what it replaced, so it isn't a neighbour. A link to a merged note leads to the note it went into.
- **Scopes:** search, entity lookup, neighbours and a note's links can be limited to a set of scopes. Without one they see every scope. With one, links resolve among the notes in it, and a note outside it has no neighbours (#150).
  - **Residual, full-text ranking:** search ranks with bm25 statistics from the whole index, other scopes and past versions included, so notes outside the scopes can reorder the hits inside them. Since #131 a turn other than the owner's direct chat sees only its own conversation, but only the owner is admitted, so the hits it ranks are the owner's own. Revisit when someone else is admitted (#60), such as a group with outsiders ([#152](https://github.com/guedesdiogo/kelpie/issues/152)).
  - **Residual, unscoped reads:** backlinks, history, a path's current version, a version by commit and a note's entities take no scopes, and a note's links given scopes don't check the note itself. Recall and the memory tools pass them only notes they already found within the scopes; the lifecycle report reads the whole vault on purpose.
- **A new schema version** drops the derived tables and starts empty, keeping the embeddings. The index then reports no last commit, which tells the sync to replay the vault from the start. Version 2 added the folded title. Version 3 added `merged_into` links.

## Retrieval

What a turn sees of memory (#110), built on the index. It follows ai-memory's hybrid search, with four changes compared on half of the evaluation's questions ([spike](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#retrieval-110)).
- **The gate:** a message that is empty, a command (`/start`), only emoji, or a bare acknowledgement or greeting skips retrieval. Examples: "ok", "valeu!", "obrigado :)", "kkkk", "bom dia", "thanks". The list is in Portuguese and English. No model is called.
- **Streams:**
  - **full text:** the question's words, folded, with function words kept, since bm25 already weighs them down. When the question's date was already resolved into `asOf` or `validAt`, month and weekday names and years are dropped;
  - **entities:** runs of one to four words, at most 64, that don't end in a function word, looked up as entity keys. A name may start with one ("São Paulo", "Will Smith");
    - **vectors:** when the question's vector is given, the notes nearest it by cosine, among the current ones. Vectors are kept per content and model in the index's embeddings table, which survives a rebuild. The search reads them row by row;
  - **graph:** the three best hits of each stream above, then their neighbours. A seed ranks above its own neighbours, so a neighbour can't pass it.

  Each stream fetches max(4 × limit, 20) hits, as ai-memory does, up to the index's 100. A question about the past (`asOf`) searches the versions memory held then, by text and entities only. Only the first 2,000 characters of a question are read.
- **Scopes:** given a set of scopes, every stream stays inside it, the graph included, so a link in one conversation's page can't bring in a note from elsewhere. Which scopes a turn may see is the caller's decision. A turn in a group must pass its own.
- **Fusion:** reciprocal rank fusion with k = 60, every stream weighing the same. Then an authority factor, between 0.55 and 1.5:
  - a conversation's page ×0.77, below curated notes: ai-memory's session and episodic penalties together;
  - a pinned note ×1.08.

  A question about a past conversation ("da última vez", "a gente falou", "ontem", "last time") lifts sessions to ×1.25 instead. ai-memory's boosts for decisions and procedures are left out: they suit an agent's rules, and they cost answers on a person's life.
- **Packing:** the hits as one block within a token budget, at four characters to a token:
  - each note appears once, under its title and path, best first;
  - each shows its abstract first, or the first 400 characters of its body;
  - the budget left over then goes to the best notes' bodies.

  The block is fenced as reference, not instructions: a conversation's page is what someone said, whoever said it. A note can't step out of it or pass for another note:
  - the block's tags and every note's heading carry a random id, new for each block;
  - anything in a note that reads like the block's tags (`<memory`, `</memory`) is escaped;
  - a heading is one line, without controls, with at most 120 characters of the title and 300 of the path.

  The budget holds by construction; the evaluation checks it on every question. The slice's starting budget is 1,000 tokens.
- **Rerank,** on ai-memory's contract:
  - a judge scores the 30 best hits at most, from each note's title, abstract and body start, 600 characters;
  - only those are reordered, and the caller keeps its limit after, so notes can rise from below it;
  - the fused order stays when the judge fails, doesn't answer in time (5 s by default; a turn's recall allows 3.5 s), or gives any score that is missing or outside 0 to 1.

  Kelpie's judge is the agent's qualifier, asked one yes-or-no question per note in one call, with the notes marked as data, not instructions.
- **In a turn:** the conversation runtime asks once per turn, when the person has finished.
  - **The question** is the lines of every message since the last reply, even a partial one, without their time stamps. Lines the gate skips, such as a bare acknowledgement, are left out, and a turn with nothing else left skips the lookup. Only the newest 2,000 characters go.
  - **Scopes** come from who wrote and where (#131):
    - **The owner in a direct chat** sees every scope ([ADR-0015](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0015-single-player-first.md)).
    - **Any other turn** sees only its own conversation's scope, where its session pages go: the memory every participant may see ([ADR-0004](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/adr/0004-access-control.md)). That is a group, a role other than owner, or a role or chat type that ingress didn't name or the runtime doesn't know.
    - **A turn with several authors** gets the least privileged of them, and keeps it for its retries. That includes the authors of an interrupted turn whose messages it answers, since its question reads every line since the last reply the person saw.
    - **Today** ingress admits only the owner's direct chats, so the narrow set is reached only when a role is missing:
      - a message pending, or a turn running, when migration 0009 runs, for that one turn;
      - a webchat socket that an ingress from before #131 admitted, until the page reconnects. Deploying the runtime disconnects every socket ([Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)), so this lasts only while ingress runs an older version than the runtime.
  - **Budget:** the slice's 1,000 tokens, and the agent's qualifier reranks.
  - **Expired notes** (#111) are left out: those whose `invalid_at` has passed.
    - A note without `invalid_at` never expires, and one that becomes valid later stays, so future plans are still found.
    - A question that gives a date (`asOf`, `validAt`) or asks how things were brings them back. The cues are whole words, in Portuguese and English: "antes", "costumava", "morava", "ex", "used to", "back then", and the past-conversation cues above.
    - Nothing is written: no note is marked expired.
  - **Where the block goes:** in that request's context, after the turn's last user message. An answer longer than the budget is refused.
    - **Afterwards:** once the turn is answered, its block is kept with the turn, and every later request sends it again, unchanged and in the same place.
      - Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 bind a reply's thinking to everything sent before it, and reject a request whose earlier turns changed ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking), #137).
      - A turn without a reply sends its block no more.
    - **What never holds the block:** history rows, so not the webchat's transcript, session pages or checkpoints, nor the system prompt.
    - **The cost:** each answered turn adds its block, at most 1,000 tokens and about 540 on average, to later requests until a checkpoint summarizes them.
    - **Caching:** Anthropic writes the cache only at a breakpoint, so the adapter puts one on the last block before the new context. The next request reads the conversation from the cache up to that breakpoint. OpenAI caches the longest prefix.
    - **Where it's kept:** on the turn's row in the conversation's Durable Object, and only once the turn has a reply. `history()`, the conversation as the model sees it next, shows it.
    - **The system prompt** tells the model, on every turn, that the block is the vault's notes, not the person's words or instructions.
  - **Waiting:** the person waits for it while "typing" shows. Embedding the question takes up to 2 s, and the rerank 1.4 s at p50 and up to 2.5 s at p95 ([spike](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#with-models)), with its own 3.5 s cap.
  - **Failure:** a Context Store that fails, or doesn't answer in 6 s, leaves the turn without memory. A message that arrives meanwhile interrupts the turn before its model call, and the next turn asks again.
  - It logs the time, the number of notes and their tokens, never text.
- **The agent's tools** (#126): beyond the turn's block, the agent can search memory and read a note, inside the turn's tool loop (#141).
  - **`memory_search(query, k)`:** the same retrieval as a turn's, with the vector and the agent's qualifier's rerank.
    - It lists the hits in #110's fence: title and path, then kind, scope, validity, whether Kelpie wrote the note and its version, then its abstract or its body's first 240 characters. "Not written by Kelpie" isn't "written by the owner": Kelpie records its own commits only from #126 on, and other clients write to the vault too.
    - A hit gives a version only while the note's file is still the text the hit shows (#297). A version the vault has replaced, a queued write, or a change while retrieval waited on its rerank gives none: the note must be read first.
    - It returns 3 hits by default and 10 at most, best first, with no score, within 9,500 characters; hits that don't fit are counted.
    - Memory that is off or failing says so, rather than finding nothing.
  - **`memory_read(path, offset)`:** a note of memory's index, a page at a time, each page under 9,500 characters, fence included.
    - A page is never cut inside an emoji, and says where the next one starts.
    - **It shows the note as a write would find it** (#297): its file now, a write still queued for its commit included, and that version. A note whose removal is queued is "not found".
    - **Each page names the version it was read at.** Two pages of one note with different versions mean the note changed between them: it must be read again from the start.
    - The first page also lists the note's links, resolved among the notes the scopes allow, up to 50 within 2,000 characters, and counts as one access.
  - **Scopes and the qualifier** come from the turn, never from the model: the same scopes as its recall. The calls act for the turn's latest author with the turn's role, and a turn without one acts as a member. A note outside the scopes, or outside memory's index (persona, rules, skills, root files), gets the same "not found" as a missing one.
  - **`memory_write(title, body, kind, level, …)`:** saves one memory through the Context Store's single writer.
    - **A new memory** goes where its title puts it, an event under its `validFrom` date, which it needs. The path gets a number when another note holds it.
    - **The owner's word stays** (#149): a `deduced` or `inferred` memory can't change a note the person stated: one with `level: explicit`, or one whose current version Kelpie didn't write, whatever its level, since the owner wrote or edited it. The tool asks the model to save it as a new note.
    - **The core's notes stay the owner's** (#168): no memory, at any level, changes a note the always-loaded core carries, whether or not the core is on. Those are the notes pinned in the global scope or the agent's own, and the notes in the owner's or the agent's `profile/` folder. The tool asks the model to save a new note.
      - **A merge counts as the owner's** (#160): when Kelpie's queued write merges into an edit the owner made meanwhile, the version is Kelpie's commit, and its links get no preview (#126), but it holds the owner's lines, so the rule guards it until Kelpie writes the note anew.
      - **What the rule guards against:** an honest model labelling its own conclusion as such.
      - **What it doesn't guard against:** the label is the model's own. An instruction injected into what the model reads could have it claim `explicit` and overwrite the note. The owner accepted that for v1 (#149): git keeps the old version, and the daily report lists every note of the owner's that Kelpie changed.
    - **A found note's `path`** makes the memory that note's new version, of the same kind, unless it is another agent's or removed. It keeps what the model left out, as far as Kelpie can write it back:
      - the note's id and the owner's keys;
      - its tier, confidence, entities, validity and abstract;
      - its `contradicts` links, by note name (a heading or alias in the link is dropped);
      - its pin and evergreen flag.

      The turn's source joins the note's sources, 20 at most. A carried value the writer can't take, such as a source with a tab, is dropped rather than refusing the update. A carried `invalid_at` can't be cleared, only replaced.
    - **A found note changes only from the version the model read** (#297, after ai-memory 3.0's `expected_page_id`):
      - **The version** is the first 12 hex digits of the file's git blob SHA. `memory_read` and `memory_search` show it, and every save, or "already in memory", gives the note's version now.
      - **`version` is required with `path`.** When the note changed since that version, the write is refused and nothing is written: an edit the owner made in Obsidian, another conversation's write or a Dream merge stays. The tool asks the model to read the note again, keep what still holds and save with the version it shows now. A value that can't be a version, not 12 hex digits as shown, is refused as invalid, so the model fixes it without reading again.
      - **It guards against lost updates, not against the model:** a model that reads the note gets its version. The owner's-word and core rules above stay the guards.
      - **Why:** the body is the model's, written from what it read. Without the check, a write rendered on the current version's metadata would still replace a body written since.
      - **No news stays safe:** the same memory again is "already in memory", whatever version it names.
    - **Where it can write:** any note the turn sees, for a new version. A new memory goes to the owner's global memory by default, or to the agent's own scope, when the turn sees every scope. When the turn lists its scopes, a new memory goes only to those. A turn that sees only its own conversation (#131) saves a new memory there unless the model names a scope, and a refusal says where it can save.
    - **No news changes nothing,** so a retried call is safe:
      - a new version that differs only in its `updated` stamp;
      - a new memory whose title, body and validity a note at its path, or a numbered one, already holds, queued or committed;
      - an exact twin elsewhere in the index.

      The path is chosen and the write queued without a pause, so concurrent writes can't share a path.
    - **What it carries:** secrets are removed from the title, body, abstract and entities. `sources` is the conversation, named as its session pages name it, and the day in its time zone, from the turn.
    - **What it refuses:** `session`, since conversation pages are written for it, and bodies with merge conflict markers. The commit's headline never names the memory, since a headline outlives a `forget` in git.
    - **Bounds:** a turn, across its rounds, saves 5 memories at most and stops after 3 failures. A store that fails or times out counts as a failure. The counts live in the Worker's isolate, so a turn resumed elsewhere after an eviction starts them again.
    - **Fields sent as null** count as left out.
  - **A note written in this turn** shows up only after the vault's next commit.
- **The always-loaded core** (#112): what the agent carries into every turn, beside the slice a question recalls.
  - **Off by default:** the owner turns `memoryCore` on per agent ([admin-api.md](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/admin-api.md)). gbrain's held-out evaluation found that a core costs one model's instruction following, so #108's evaluation decides per model.
  - **Who gets it:** only a turn that sees every scope, which is the owner's turn in a direct chat (#131). Any other conversation, such as a group's, goes without it, and the Context Store isn't asked.
  - **What goes in,** in this order, each note once and whole:
    1. **Pinned notes:** the notes the owner pinned (`pinned: true`) in the global scope or the agent's own. A note pinned in another agent's scope, or in an area's, a project's or a conversation's, stays out.
    2. **The owner's profile:** notes under `memory/profile/`.
    3. **The agent's self-model:** notes under `agents/<agent-id>/memory/profile/`.

    Within each group they go by path. Expired notes stay out, as recall leaves them out.
  - **The budget** is 1,000 tokens, or 4,000 characters. A note that doesn't fit is skipped and the next one is tried. The block ends by saying how many didn't fit.
  - **The fence** is recall's: a random id on the block's tags and on every heading, and tags escaped inside notes. The block's own note says it is for reference, not instructions.
  - **When it loads:** at the first request under a prompt version and checkpoint. It is kept as sent, and every later request under the same pair sends it byte for byte, since a reply's thinking is bound to everything sent before it (#137).
    - **What loads it again:**
      - a checkpoint;
      - a change to the persona, rules or skills, or a configured change to the agent's system prompt;
      - turning `memoryCore` on or off, or a deploy that flips its built-in default for an agent that follows it (#224). Each starts a new prompt version. An agent notes the default at its first turn after #224 without a new version, so a flip that comes before that turn reaches it at its next checkpoint instead.
    - **What doesn't:** a deploy that edits built-in text, the default system prompt included (#220). The turn's prompt key still drops earlier replies' native output when the text the model gets changes, and the core waits for one of the events above.
    - A note edited meanwhile shows from the next load.
  - **Where it goes:** first in the first message the model sees, ahead of a checkpoint's summary.
    - The system prompt stays the agent's own, the same in every conversation.
    - History rows never hold the core, so the checkpoint summarizer never reads it.
  - **Failure:** if the Context Store fails, or doesn't answer in 5 s, the conversation goes without the core until the next load. Asking again would change what an earlier reply was sent with.
  - **The Context Store** builds it from memory's index and counts no access, so carrying it into every conversation doesn't keep its notes from going cold.
  - **Logging:** the runtime logs how many notes went in, how many didn't fit and the tokens, never text.
  - **What the model can change:**
    - **It can't add a note to the core.** `memory_write` takes no `pinned`, and it puts a new memory in a kind folder, never in `profile/`.
    - **It can't rewrite a note already in the core** (#168): `memory_write` refuses a pinned note or a profile note at any level. An injected instruction can't put text into every later conversation's core that way.
  - **Not yet:**
    - previews of links in core notes (#130);
    - notes pinned in a conversation's, area's or project's scope.

## Lifecycle

What keeps memory clean as it grows (#111), without touching how notes rank.

### The daily report

Once a day, the Context Store's alarm looks at the index, after GitHub's work and the held files. It writes what it finds to one page, `memory/_lint/report.md`, as links to the notes.
- **Your notes Kelpie changed** (#149): every note whose version Kelpie's commit replaced or removed in the last week, when Kelpie hadn't written that version, or had merged its write into the owner's edit. Git keeps every earlier version.
  - That is the owner's notes, and also notes from before Kelpie recorded what it wrote (#126) or from another app writing to the vault.
  - Each line gives the last day Kelpie made such a change, newest first. Kelpie's later edits of its own version aren't listed. A changed note is a link; a removed one is shown by its path.
  - A commit whose answer was lost counts too, once the next sync finds it landed. Resolving a held file doesn't count, and neither does the report page itself.
- **Cold notes:** sessions and events nobody recalls any more. Facts don't decay, and pinned or evergreen notes are exempt.
  - A note's retention is e^(−0.02 × days old), plus 0.6 × ln(1 + recalls) × e^(−0.04 × days since the last recall). A note is cold below 0.2: about 80 days after it was written, if nobody recalled it.
  - **When it was written:** its `updated`, never later than its commit; else the date its file name starts with (`2026-03-04-standup.md`, `2026-03-04.md`); else when the index first saw it. So a vault synced for the first time, or an index rebuilt, doesn't look new.
  - An event ages from its end (`invalid_at`), then its start, then when it was written, so one still ahead isn't cold.
  - A recall is a turn that packed the note: the Context Store's access counts.
- **Duplicates:** the same content at several paths, and the same title on several notes of one scope, compared as titles are. Projects' READMEs share a title, and that is no duplicate.
- **Possible contradictions:** pairs of notes that share an entity and whose vectors are close, but not the same note.
  - It reads the 60 newest semantic and procedural notes that haven't expired, and lists 25 pairs at most.
  - A pair a `contradicts` link already joins has been seen to, and isn't listed.
  - "Close" is a band per embedding model: [0.70, 0.95) for bge-m3 and OpenAI's `text-embedding-3-small`, measured on the evaluation's outdated memories ([spike](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#contradiction-band-111)). A model without a band has the check off.
  - Dream (#112) is the one to look at them.

How the page behaves:
- **Report only.** In v1 it is the lifecycle's only write: nothing listed is changed, merged or removed. The retention score never reaches retrieval.
- **The same findings write the same page,** sorted and without a time stamp, so a day without news makes no commit. The page is removed when every list is empty.
- **Notes can't write Markdown into the page:**
  - Titles can't break out of their links. Controls, invisible and bidirectional characters are dropped, and so are brackets, pipes, angle brackets, exclamation marks, backticks, backslashes and percent signs. The joiners that hold emoji and some scripts together stay.
  - A path is linked as it is, `!` included. A path that holds any of those characters, or `#` or `^`, or is longer than 200 characters, is shown as code instead.
  - An entity, outside any link, goes in a code span.
  - Titles are cut to 120 characters, paths to 200, and a line lists 10 notes, then how many more.
- **Never memory.** `placeOf` leaves `memory/_…/` out of the index, so recall, the jobs and link previews never read it.
- **A failed run** waits for the next day.

### Dream

Memory's consolidation (#112), off the hot path, on the Context Store's alarm. Each operation runs dry until the owner lets it write: it only proposes, and the daily report shows the plan.
- **When it runs:** only when there is a note to work on, and:
  - at most once every 6 hours;
  - once no turn has touched memory for 30 minutes. A recall, a search, a read or a write counts as a touch.
- **How a run proceeds:**
  - **One step per wake:** each time the alarm wakes, a run takes one step, after GitHub's work, the held files and the report, so it never holds them back. A step makes at most one model call; a merge of the same content makes none. The run's state is kept, so an eviction doesn't start it over.
  - **Cancellation:** memory used since a run started ends it before its next step.
  - **The cap:** at most 8 calls a run.
- **Its operation: abstracts.**
  - **Which notes:** notes whose current version Kelpie wrote (#126) in the last 7 days, dated as the report dates notes, so a rebuilt index doesn't make old notes new. They are either session pages, whose abstract is their first message, or conclusions (`deduced`, `inferred`) without an abstract. Each gets a proposed abstract, with secrets removed. A fact the person stated keeps its own words. The owner's notes never do, nor a version Kelpie merged into the owner's edit (#160).
  - **The model:**
    - the cheap tier, through llm-gateway;
    - the note goes as data, up to 6,000 characters, between `BEGIN NOTE` and `END NOTE` lines that carry a random id for each call, so the note can't close the block;
    - its answer must be JSON with one key, `abstract`: one printable line, with no control or bidirectional mark, of at most 300 characters once its secrets are replaced, the writer's rule. A redaction can lengthen it, and nothing cuts it after. Any other answer is kept as no answer, so that version isn't asked about again.
  - **One proposal per version:** a proposal is kept with the version it was made from. A note gets one proposal per version, and a newer version drops it.
- **The plan:** the report's "Dream's plan" section lists each proposed abstract beside its note.
  - A model wrote the abstract, so it is shown as code: no link, tag or markup in it renders.
  - When a run ends, the report is written again on the next alarm.
- **Cost:** each call's usage is kept with its run for 30 days. The logs count calls and output tokens, never text.
  - **A failed call ends the run** (#112), in every operation.
    - **A failure another try may clear** leaves the version for a later run, three tries in all. That is a model error the gateway marks retryable, such as a rate limit, a provider's 5xx, a 408 or 425, a provider out of credits, or a dropped connection, or a call that ran out of time.
    - **Any other failure is kept as no answer,** and so is the third try, so one item can't fail every run. That covers an answer cut at its output budget, a refusal, or a key the provider refused.
    - **The logs** give a model error's code and whether it may clear, never its text.
  - With nothing to do, Dream looks again after another 30 minutes of quiet, not on every wake.
- **The switch:** `/commands/setDream` takes `off`, or `dry`, the default ([admin-api.md](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/admin-api.md)).
  - **`writes`** names the operations that may write, such as `["abstracts"]`. An operation not named only proposes, so one deployed later is dry until the owner names it.
  - **When it's off:**
    - no run starts;
    - a run in progress ends;
    - what Dream proposed is deleted;
    - the list of operations that may write is forgotten;
    - the report is written again without the plan.
- **Writing an abstract:** this is what happens when `abstracts` is named.
  - **The way in:** the abstract goes into the queue, as the report does, so Dream's own write doesn't count as memory activity.
  - **When it goes:** only while the note is as it was proposed for:
    - the same version;
    - Kelpie's;
    - not merged into the owner's edit;
    - not held;
    - with no write waiting.
  - **What changes:** only the frontmatter's `abstract`. For a file Kelpie's writer produced, every other key, comment and the body stay byte for byte. The commit's headline never names the note.
  - **An edit before the commit:** if the owner edits the note after Dream queued its write but before the commit, the owner's edit wins whole and Dream's write is dropped. A line merge there could leave two abstracts in the frontmatter.
  - **A plan the owner already read:** once `abstracts` is named, the proposals Dream made while dry are written for the versions the vault still holds, with no new model call. A write that didn't land isn't tried again for that version.
  - **After it:** the version Dream wrote stays Kelpie's (#126), and it isn't proposed for again. The report's "Dream wrote" section lists the last week's abstracts, shown as code.
  - **Measured first:** #108's evaluation doesn't regress with the cheap tier's abstracts ([memory-eval.md](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#dreams-abstracts-112)).
- **Writing a day summary or a merge:** Dream's own commit, one per summary or merge, outside the queue, so a merge lands whole or not at all.
  - **When:** as for abstracts, a plan made while dry is written once its operation may write, with no new model call. A plan made with writes on is written at the next step.
  - **Checked right before the commit:**
    - every note it read is at the version it read;
    - every note it writes over is Kelpie's version, not merged into the owner's edit, not held, and has no write waiting;
    - a new note's path is still free, with nothing waiting to be written there;
    - Dream isn't off, the operation may still write, and its plan still stands.
  - **Checked again:** the summary or merged body is put through the rules for a model's answer once more, since it may have been kept under older ones.
  - **If the vault moved,** the commit is refused. Dream syncs and checks again. It writes nothing if what it read, or what it writes over, changed, and otherwise commits on the new head.
  - **What can't be written,** such as a note past its `sources` limit, or what GitHub refuses, is kept as no answer, so it isn't tried again.
  - **A write that writes nothing** counts as a call of its run, so one that keeps finding the vault changed ends with the run.
  - **A write queued during the commit:** an agent's write to one of those notes was made on what it held before, so it goes on top of Dream's, as on the owner's edit, and stays Kelpie's. Lines that overlap are set aside in `conflicts`.
  - **After it:** each version is Kelpie's (#126), even when the commit lands and its answer is lost: the next sync recognizes the versions it wrote, keeps a write queued over them Kelpie's, and remembers a summary as written. The commit's headline never names a note.
- **Day summaries** (#112): proposed as a dry run, and written once `summaries` may write. `setDream` can't name it until #182's measurement is in.
  - **What a summary covers:** one day of one conversation, from the session pages in that conversation's own scope (`conversation/…`). Two conversations are never mixed (#131). A day is summed up once it has ended in every time zone, and only within the last 7 days. That is 14 hours after the next UTC midnight: 12 for the last time zone, and 2 for a conversation still going at midnight.
  - **Kept only while its pages are:** a summary is kept, and shown, only while every page it read is still in the vault at that version. A page that's forgotten takes the summary with it right away. A page changed or removed in the vault takes it at the next daily report.
  - **Where it goes:** `<scope>/sessions/YYYY/YYYY-MM-DD.md`, next to the session pages, as a `session` note at `level: deduced`, titled `Summary of YYYY-MM-DD`.
    - Its `sources` name the session pages by path. A day of more than 20 pages, the most `sources` names, isn't written.
    - Its confidence is the lowest of its pages'.
    - No session page can take that name, since theirs add a slug after the date.
    - It gets no abstract when written. Dream's abstracts may propose one, as for any conclusion.
    - **Not refreshed:** once written, a summary stays as it is, even if a page of its day changes.
    - **Removed by the owner:** it isn't written again, even once a page of its day changes. Forgetting the summary's path forgets that it was written too, so forget its pages as well, or it may be written again.
  - **When it's proposed again:** the proposal is kept with the versions of the day's pages. A new page that day proposes it again, and nothing else does. A day whose summary the vault already shows, or whose place holds a file, isn't proposed.
  - **The model:** the cheap tier, within the same 8 calls a run. Abstracts, days and merges take turns; a merge of the same content counts no call, and neither does writing a plan, unless the write writes nothing.
    - The day's pages share 12,000 characters of input, each under a heading with its title and path. A day whose headings alone would take half of that isn't summed up, since its summary would come from titles only.
    - The pages go between a `BEGIN PAGES` line and an `END PAGES` line that carry a random id for each call, and each page's heading ends in that id, so a page can't close the block or pass for another page.
    - The answer must be JSON with one key, `summary`.
    - The summary must be plain lines within 2,000 characters. Windows line ends become line ends. Any other control character, line separator or bidirectional control is refused, at the edges too.
    - Secrets are removed from it next.
    - Then nothing in it may read as Markdown structure:
      - no heading (a run of `#` and a space), quote (a line starting with `>`), fence, rule, HTML block (a line starting with a tag, which needs no `>`), title underline, frontmatter fence or conflict marker at a line's start, behind a list or quote marker or a task's checkbox too;
      - no link, link reference, wikilink, image, HTML tag, autolink (mail too), code or plugin template tag (`<%`, `%>`) anywhere. A bare URL, a hashtag or a `<` before a space or a digit in prose stays as text.
  - **The page:** Dream's page, `memory/_lint/dream.md`, lists each proposed summary, newest day first, each with the pages it sums up (see "Dream's page" below).
  - **Erasing:** forgetting a session page forgets its day's summary. Turning Dream off deletes the summaries too, drops any copy of the page waiting to be written, and the next report removes the page; the vault's git history still holds its earlier versions. A call that ends after Dream was turned off, or after its note changed or was forgotten, keeps nothing, for abstracts too.
- **Duplicates** (#112): proposed as a dry run, and merged once `merges` may write. `setDream` can't name it until #182's measurement is in.
  - **Which notes:** Kelpie's own notes of one scope and kind that share a title, two or more.
  - **Left out**, as for abstracts:
    - a fact the person stated;
    - a version Kelpie didn't write, or one merged into the owner's edit;
    - a note with a write waiting, or one held.
  - **Also left out:**
    - a pinned note, or one the always-loaded core carries;
    - a session or an event, since the same title on another day is no duplicate;
    - an expired note;
    - a merged note.
  - **The owner's notes in a group** aren't touched. Only Kelpie's merge, and the report keeps listing the rest.
  - **Content duplicates** with different titles, scopes or kinds are listed only.
  - **The survivor:** the note most others link to, then the earliest written, then the shorter path, since a later one is numbered.
  - **The same content:** no model call. Only the marks would change.
  - **Different content:** one call on the cheap tier, with the notes whole.
    - A group whose notes pass 16,000 characters, each under a heading with its title and path, isn't merged, since a cut would lose what it held. It stays on the report's list.
    - The model first says whether the notes are about the same thing. The answer is JSON, either `{"verdict": "distinct"}` or `{"verdict": "merge", "body"}`.
    - The notes go between `BEGIN NOTES` and `END NOTES` lines with a random id, each note's heading ending in it, as a day's pages do.
    - The body must be within 8,000 characters, with the same rule on control characters as a summary's.
    - Secrets are removed from it next.
    - **Anywhere, fenced or inline code included,** it may hold:
      - no frontmatter fence or conflict marker;
      - no image or link reference;
      - no HTML, and no HTML block's opener;
      - no link or link definition but to a web or mail URL, or to a plain relative path, and no autolink but to the web or mail, however spelled. Wikilinks are kept;
      - no plugin template tag (`<%`, `%>`) and no inline query (`` `= `` or `` `$= ``);
      - no fence but of a language Obsidian shows as text: none, plain text, or a common programming language. A diagram's fence, such as Mermaid's, renders, and can fetch an image with no click. Every fence counts, wherever it is, a task's checkbox included.

      An image split across lines, spelled with entities, or named by a reference behind a list marker would get past a rule that reads Markdown. So would a fence an HTML block swallows. These rules don't read Markdown at all.
    - **Outside code,** it may hold no title heading, behind a list or quote marker or a task's checkbox too. In code, a `#` line is a comment.
    - Any other answer is kept as no answer, so those versions aren't asked about again. A failed or late call ends the run, and is tried again or kept as no answer as "Cost" says above.
    - **The cost of these rules:** a body the rules refuse is kept as no answer too, so the group isn't merged, and isn't asked about again until one of its notes changes. A note with a `<` right before a letter, `!`, `?` or `/` in its code, such as `List<String>`, can't merge; the report keeps listing its group.
  - **Kept only while its notes are:** a proposal is kept with the versions of its notes, and a change to any of them proposes the group again.
    - A forgotten note takes the proposal with it right away. A note changed or removed in the vault takes it at the next daily report.
    - A group that grew, or has a new survivor, replaces what was proposed for its notes.
    - A note that expires, or is merged into another since, takes the proposal with it at the next daily report.
  - **Erasing:** turning Dream off deletes the proposals. A call that ends after that keeps nothing.
  - **Writing a merge,** in one commit:
    - **The survivor:**
      - it keeps its title, frontmatter and `id`, and takes the merged body;
      - its `sources` gain the notes it took in, by path, and never lose one. Past 20, the merge isn't written. Each note it took in keeps its own `sources`;
      - entities and what the notes contradict are unioned, with at most 10 entities, as a note keeps. Past 20 contradictions, or one written with a label or a heading, the merge isn't written;
      - notes valid at other times (`valid_from`, `invalid_at`), or of which only some are `evergreen`, aren't merged, since a fact would hold for longer or for less than it did, or start or stop decaying;
      - it takes the lowest level and confidence among the notes, so a merge never makes a note surer;
      - its abstract is removed, so Dream's abstracts propose a new one.
    - **Each other note** keeps its frontmatter and gets `relations.merged_into` naming the survivor by path, and a new `updated`. Its body becomes one line that names the survivor and the commit that still holds what the note said: the commit the merge lands on.
    - **The same content:** only the other notes are written. The survivor stays as it is.
    - **Chains:** Kelpie's own notes that were merged into one of the merged notes are pointed at the survivor, in the same commit, since a mark is followed one step only. A note the owner marked by hand, or one waiting or held, keeps its mark.
- **Dream's page:** `memory/_lint/dream.md`, outside the index, shows what Dream would write: the day summaries, then the merges, at most 50 of each, with a count of the rest.
  - Each merge names the note that stays and the notes it would mark as merged into it, with the merged body, or "the same content".
  - Whatever a model wrote is shown as code, fenced by more backticks than it holds in a row.
  - It is written with the report, and removed when nothing is proposed.
- **Not yet:**
  - naming `summaries` and `merges` in `writes`, until #182's measurement;
  - contradictions;
  - roll-ups, and people and places;
  - week and month summaries.

### The write decision

Before a new memory is written, `decideWrite` says whether it is news (#111). A conclusion (`deduced`, `inferred`) never replaces or refines what the person said: the qualifier's answer about such a note counts as unrelated (#149). `memory_write` (#126) calls it without the qualifier: ADR-0009 wants the qualifier's answers measured on a labeled PT-BR set before they act. So only the rules decide: an exact twin is a `NOOP`, and anything else is an `ADD`.
- **In the shadow** (#149): after the rules add a memory, the agent's qualifier makes the same decision, unawaited. Its action is logged next to the rules' `ADD`, actions only, never text or paths, and nothing acts on it.
- **Measured:** on #149's set of 80 pairs, Clef chose right 92.5% of the time, with no wrong `SUPERSEDE` and one wrong `NOOP` ([spike](https://github.com/guedesdiogo/kelpie/blob/f033cf3/docs/spikes/memory-eval.md#write-decision-149)). Whether and above which probability it may act is the owner's call.
- **The outcome:**
  - `ADD`: a new note, at `memoryPath`; the writer resolves a collision with an existing file;
  - `UPDATE`: the note at `path` stays true and the memory adds detail, so its new version holds both;
  - `SUPERSEDE`: the memory says the note at `path` is no longer true, so the memory becomes its new version, and the index keeps the old one for "as of";
  - `NOOP`: the note at `path` already says it.
- **Candidates, without a model:** current notes in the memory's scope and of its kind that haven't expired at the `now` the writer gives, so a decision never points at another scope's note. Three lookups find them, taken in turn, five at most:
  1. the same title;
  2. a shared entity;
  3. a vector at or above the low end of the model's contradiction band, when the writer embedded the memory.
- **Its exact twin is a `NOOP` with no question:** a note of its scope and kind with the same title, body and validity, looked for first among every note with its title, expired ones too.
- **Otherwise the agent's qualifier** (Clef, or Jev) answers one `choice` per candidate in one call: duplicate, refines, replaces or unrelated. The memory and the notes are in its state, marked as data, not instructions, at 1,200 characters each.
  - A duplicate anywhere is a `NOOP`. A duplicate judged on text cut to fit counts as refining the note, so a new tail isn't dropped.
  - Then the first note the memory replaces is superseded.
  - Then the first note it refines is updated.
- **It adds** when there is no candidate, no qualifier, a failure, no answer within 5 s, or an answer off the list. Nothing is lost, and the daily report lists duplicates.
- **What the writer owes it:**
  - an input that passed `writeMemory`'s checks;
  - a scope that is the turn's, never a model's choice;
  - on `UPDATE` and `SUPERSEDE`, the note's `pinned` and `evergreen` carried over. The rule's `NOOP` compares title, body and validity only.

## Zikaron: origem, tipos novos e arquivo

O que o Zikaron acrescenta ao formato (#6), além do que vem do Kelpie acima.

### O bloco `origin`

A proveniência de cada versão que o servidor grava ([ADR-0001](adr/0001-identidade-e-confianca.md) §3). Só o servidor o escreve.

```yaml
origin:
  client: noah            # o cliente da credencial; nomeia o escopo agent/<cliente>
  channel: provider       # provider | tool
  source: owner           # owner | agent | external
  evidence: "telegram:msg/123"   # opcional, uma linha de até 300 caracteres
  review: pending         # opcional: espera o «sim» do dono
  taint: inherited        # opcional: gravada por cima de uma versão contaminada
```

- **O vocabulário é fechado.** Uma chave desconhecida, um valor fora da lista, um `client` fora do padrão (minúsculas, dígitos e hífen, até 40) ou uma evidência com quebra de linha invalidam o bloco inteiro, com aviso. A nota continua indexada.
- **O índice guarda o bloco em colunas** (`origin_client`, `origin_channel`, `origin_source`, `origin_evidence`, `origin_review`, `origin_taint`), para as regras de leitura do ADR-0001 virarem SQL.
- **O arquivo não decide a confiança sozinho:** quem escreveu o blob conta mais que o bloco (ADR-0001 §3).

### Tipos novos

| Tipo | Pasta | Tier padrão | Campos próprios |
|---|---|---|---|
| `task`: pendência sem hora | `tasks/` | episodic | `status: open\|done` |
| `document`: um documento guardado por nome, link e assunto | `documents/` | semantic | `link`, obrigatório |
| `delegation`: o que está com o Alan | `delegations/` | episodic | `status: open\|done` |

- **`status`** só vale em `task` e `delegation`, e **`link`** só em `document`. O escritor os recusa nos outros tipos. Neles, uma chave `status` ou `link` é do dono: o leitor não a lê e o escritor não a apaga.
- **`link`** é uma URL http(s), sem espaços, controles nem marcas bidirecionais, de até 2.000 caracteres. Um `document` sem ela é recusado pelo escritor; o leitor o indexa com um aviso.
- **O corpo de um `document` é o assunto,** até 2.000 caracteres, nunca o conteúdo: a verdade é o Drive ou o Gmail.
- **`commitment`** continua, para o contexto de um evento cuja verdade é a Agenda.

### O arquivo

`archived: true` arquiva a nota: «arquivados devem ser acessados apenas quando solicitado diretamente» (o Diogo, Q5).
- **Sai de:** a busca por texto, por título, por entidade e por vetor; os vizinhos do grafo (a nota arquivada também não tem vizinhos); o núcleo, mesmo pinned; os jobs do ciclo de vida.
- **Também no passado:** uma busca com `asOf` deixa de fora a nota arquivada hoje, como uma marca de merge é lida como está hoje.
- **Continua em:** o mesmo caminho e a mesma cadeia de versões; a leitura pelo caminho; a resolução de links, para um link não passar a apontar para um homônimo; uma busca, ou os vizinhos de uma nota, que peçam `includeArchived`.
- **Dito de novo:** um fato igual a uma nota arquivada não é «já na memória»; vira uma nota nova, viva, num caminho numerado.
- **Por que uma flag e não uma pasta:** mover o arquivo mudaria o caminho, e o caminho é a identidade da nota.
- **Uma nova versão leva o que a anterior tinha:** como `pinned` e `evergreen`, quem grava por cima de uma nota lê a versão atual e repassa `status`, `link`, `archived` e `origin`. O escritor trata a entrada como a versão inteira e apaga o que ela deixa de fora. Quem grava calcula também o `taint: inherited` (ADR-0001 §5).
- **O schema do índice passou para 4:** um índice de antes recomeça vazio e se refaz do cofre.

## Credits

The design follows [ai-memory](https://github.com/akitaonrails/ai-memory) at [`fc4da03`](https://github.com/akitaonrails/ai-memory/tree/fc4da03) (MIT, © 2026 Fabio Akita): versioned pages, FTS5 with diacritics folded, entity normalization, typed edges with a closed vocabulary, link extraction that skips code, and hybrid retrieval. Files translated from it carry its notice. The reference checks are on [#107](https://github.com/guedesdiogo/kelpie/issues/107#issuecomment-6010168197) and [#110](https://github.com/guedesdiogo/kelpie/issues/110#issuecomment-6012868696). The retrieval gate follows [hermes-agent](https://github.com/NousResearch/hermes-agent) at `86bdb75` (MIT). The lifecycle's retention score follows ai-memory's decay at [`b8e839f`](https://github.com/akitaonrails/ai-memory/blob/b8e839f6a9aee3e58f49dbc588e9107f8820e695/crates/ai-memory-store/src/decay.rs); its reference check is on [#111](https://github.com/guedesdiogo/kelpie/issues/111#issuecomment-6022538685).

The always-loaded core follows [gbrain](https://github.com/garrytan/gbrain)'s core memory at [`9dbc00c`](https://github.com/garrytan/gbrain/blob/9dbc00c7c025420a7c2846ac55b56b937f09bceb/src/core/core-memory.ts) (MIT): whole notes within 4,000 characters, the ones left out counted, and off by default. It also follows ai-memory's profile digest at [`a63986b`](https://github.com/akitaonrails/ai-memory/blob/a63986bc6ba5a6b1ed62e405c86a7ddf7f70a03e/crates/ai-memory-core/src/profile.rs): fenced, in a fixed order and byte-stable. The reference checks are on [#112](https://github.com/guedesdiogo/kelpie/issues/112#issuecomment-6025770228).
