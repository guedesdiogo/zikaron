# Zikaron

> *Zikaron* (זִכָּרוֹן) is Hebrew for "memory, memorial". In Malachi 3:16, a *sefer zikaron*, a book of remembrance, is written to keep what matters.

A shared memory server for agents, on Cloudflare, over a Markdown vault on GitHub.

- **The vault is the truth.** Markdown in a private repo, readable and editable in Obsidian or any editor. Every index derives from it and is rebuilt from it.
- **A single writer.** A Durable Object serializes every write to the vault, wherever it comes from. An edit made outside arrives through the push webhook and, in a conflict, the owner's wins.
- **Many clients, one memory.** Hermes agents, Claude Code and other MCP clients read and write through the same server, each with its own credential.
- **The server enforces the rules, not the persona.** Who wrote a note, where it came from and who may read it are decided on the server ([ADR-0001](docs/adr/0001-identidade-e-confianca.md)). What comes from outside never speaks for the owner.

## Status

Under construction: the v1 plan is [Epic 1](https://github.com/guedesdiogo/zikaron/issues/1).

## Where it came from

The format, the index, the search and the single writer come from [Kelpie](https://github.com/guedesdiogo/kelpie), which in turn follows the design of [ai-memory](https://github.com/akitaonrails/ai-memory). [ADR-0002](docs/adr/0002-extracao-do-kelpie.md) says what came over and what stayed behind.

## Personal data

The vault may hold third-party data, for personal use. Truly deleting a piece of data means rewriting the vault's git history by hand and then rebuilding the index; the server never does that on its own. The responsibility lies with whoever runs the server.

## License

MIT. The files translated from ai-memory carry its MIT notice (© 2026 Fabio Akita).
