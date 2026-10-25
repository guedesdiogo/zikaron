# ADR-0003: An owner's note changes on the owner's word, through the provider as well

- Status: Accepted
- Date: 2026-10-24
- Issue: [#9](https://github.com/guedesdiogo/zikaron/issues/9)
- Amends: [ADR-0001](0001-identidade-e-confianca.md) §4
- Follows from Diogo's decisions already approved in [#1](https://github.com/guedesdiogo/zikaron/issues/1): Q6 ("correct" creates a new version, and the old one stays in the history) and Q24 (Noah's `ownerClaims`, «Sim, já vale», "Yes, it applies now")

## Context

ADR-0001 §4 says no agent rewrites a note that counts as Diogo's. The rule comes from Kelpie (guedesdiogo/kelpie#149): an agent's conclusion must not erase what the owner said.

Read literally, it also blocks the "correct" of Q6 when it arrives through the conversation. Diogo tells Noah "correct: Ana moved to Porto", and Noah writes through the provider, with `source: owner` and the message id. That write already counts as Diogo's for every client, because Noah has `ownerClaims` (the Q24 decision). Refusing it would force Noah to create a new note next to the old one, and Q6's chain of versions would be lost.

## Decision

**A note that counts as the owner's can get a new version when the write itself counts as the owner's:** `source: owner`, through the provider channel, from a client with `ownerClaims`. What ADR-0001 §4 forbids stays forbidden for everything else:
- a conclusion (`agent`) or something read from outside (`external`);
- anything through the tool channel;
- a client without `ownerClaims`.

**Unchanged:**
- no write replaces a core note (pinned or in `profile/`) or an archived note, not even on the owner's word: the core goes into every conversation, and the archive is read only when asked for;
- "forget" from an agent still applies only to the client's own notes and the pending ones.

## Consequences

- The "correct" through the conversation keeps the chain of versions, and git keeps the previous version.
- **The risk is the same as `ownerClaims`, a little larger:** a Noah induced by an email could already write something as said by Diogo; now it can also replace a note of Diogo's. Git keeps the previous one, and the daily report (Story 1.7) lists the owner's notes that changed. Turning off Noah's `ownerClaims` closes both doors at once.

## Alternatives considered

- **Keep the rule literally.** Each correction through the conversation would become a new note next to the old one, against Q6.
- **Let any `owner` write replace, without looking at `ownerClaims`.** A client whose word does not count as the owner's would start replacing the owner's notes.
