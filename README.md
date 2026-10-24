# Zikaron

> *Zikaron* (זִכָּרוֹן) é «memória, memorial» em hebraico. Em Malaquias 3:16, um *sefer zikaron*, um livro de memória, é escrito para guardar o que importa.

Um servidor de memória compartilhada para agentes, no Cloudflare, sobre um cofre Markdown no GitHub.

- **O cofre é a verdade.** Markdown num repo privado, legível e editável no Obsidian ou em qualquer editor. Todo índice é derivado dele e se refaz a partir dele.
- **Um escritor só.** Um Durable Object serializa toda gravação no cofre, venha de onde vier. Uma edição feita por fora chega pelo webhook de push e, num conflito, vale a do dono.
- **Vários clientes, uma memória.** Agentes do Hermes, o Claude Code e outros clientes MCP leem e gravam pelo mesmo servidor, cada um com a sua credencial.
- **O servidor aplica as regras, não a persona.** Quem gravou, de onde veio e quem pode ler são decididos no servidor ([ADR-0001](docs/adr/0001-identidade-e-confianca.md)). O que vem de fora nunca fala pelo dono.

## Estado

Em construção: o plano da v1 é o [Epic 1](https://github.com/guedesdiogo/zikaron/issues/1).

## De onde veio

O formato, o índice, a busca e o escritor único vêm do [Kelpie](https://github.com/guedesdiogo/kelpie), que por sua vez segue o desenho do [ai-memory](https://github.com/akitaonrails/ai-memory). O [ADR-0002](docs/adr/0002-extracao-do-kelpie.md) diz o que veio e o que ficou.

## Dados pessoais

O cofre pode guardar dados de terceiros, para uso pessoal. Apagar um dado de verdade é reescrever o histórico do git do cofre, à mão, e depois refazer o índice; o servidor nunca faz isso sozinho. A responsabilidade é de quem roda o servidor.

## Licença

MIT. Os arquivos traduzidos do ai-memory levam o aviso MIT dele (© 2026 Fabio Akita).
