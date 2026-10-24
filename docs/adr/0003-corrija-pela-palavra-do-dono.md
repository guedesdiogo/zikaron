# ADR-0003: Uma nota do dono muda pela palavra do dono, também pelo provedor

- Estado: Aceito
- Data: 2026-10-24
- Issue: [#9](https://github.com/guedesdiogo/zikaron/issues/9)
- Emenda: [ADR-0001](0001-identidade-e-confianca.md) §4
- Decorre de decisões do Diogo já aprovadas no [#1](https://github.com/guedesdiogo/zikaron/issues/1): o Q6 («corrija» cria uma versão nova, e a antiga fica no histórico) e o Q24 (o `ownerClaims` do Noah, «Sim, já vale»)

## Contexto

O ADR-0001 §4 diz que nenhum agente reescreve uma nota que vale como do Diogo. A regra vem do Kelpie (guedesdiogo/kelpie#149): uma conclusão de um agente não pode apagar o que o dono disse.

Lida ao pé da letra, ela também barra o «corrija» do Q6 quando ele chega pela conversa. O Diogo diz ao Noah «corrija: a Ana mudou para o Porto», e o Noah grava pelo provedor, com `source: owner` e o id da mensagem. Essa gravação já vale como do Diogo para todos os clientes, porque o Noah tem `ownerClaims` (decisão do Q24). Recusá-la obrigaria o Noah a criar uma nota nova ao lado da antiga, e a cadeia de versões do Q6 se perderia.

## Decisão

**Uma nota que vale como do dono pode ganhar uma nova versão quando a própria gravação vale como do dono:** `source: owner`, pelo canal do provedor, de um cliente com `ownerClaims`. O que o ADR-0001 §4 proíbe continua proibido para todo o resto:
- uma conclusão (`agent`) ou algo lido de fora (`external`);
- qualquer coisa pelo canal de ferramenta;
- um cliente sem `ownerClaims`.

**Não mudam:**
- nenhuma gravação substitui uma nota do núcleo (pinned ou em `profile/`) nem uma nota arquivada, nem pela palavra do dono: o núcleo entra em toda conversa, e o arquivo só se lê quando pedido;
- «esqueça» vindo de um agente continua só nas notas do próprio cliente e nas pendentes.

## Consequências

- O «corrija» pela conversa mantém a cadeia de versões, e o git guarda a versão anterior.
- **O risco é o mesmo do `ownerClaims`, um pouco maior:** um Noah induzido por um e-mail já podia gravar algo como dito pelo Diogo; agora pode também trocar uma nota do Diogo. O git guarda a anterior, e o relatório diário (Story 1.7) lista as notas do dono que mudaram. Desligar o `ownerClaims` do Noah fecha as duas portas de uma vez.

## Alternativas consideradas

- **Manter a regra ao pé da letra.** Cada correção pela conversa viraria uma nota nova ao lado da antiga, contra o Q6.
- **Deixar qualquer gravação `owner` substituir, sem olhar o `ownerClaims`.** Um cliente cuja palavra não vale como do dono passaria a trocar as notas do dono.
