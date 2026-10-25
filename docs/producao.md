# A produção

O `zikaron` de produção escreve no cofre de verdade, o `guedesdiogo/kelpie-vault`. Ele só é publicado por uma release do GitHub, por ordem do Diogo (`.github/workflows/producao.yml`, que chama o mesmo `deploy.yml` do staging). Nada é publicado da máquina.

## Antes de tudo: um escritor só

O ADR-0001 admite um escritor automático por cofre. O context-store do Kelpie ainda grava no `kelpie-vault`, e os commits dele contariam como do dono. Por isso, nesta ordem:

1. O Diogo para o context-store do Kelpie, no Cloudflare.
2. Ele confere que nenhum commit novo do bot do Kelpie aparece no `kelpie-vault`.
3. Só então o GitHub App `zikaron` é instalado no `kelpie-vault`.

Sem a instalação, o Worker de produção pode existir, mas com o cofre desligado.

## O que precisa existir

Nenhum valor abaixo vai para o repo nem passa por um chat. O repo é público, e o log do Actions mostra as variáveis sem máscara. Por isso tudo o que identifica a conta, o Access, os clientes, o App ou o endereço do Worker é **segredo** do environment `producao`, como no staging. Só o nome do cofre é variável.

| Onde | Nome | O que é |
|---|---|---|
| Segredo do environment `producao` | `CLOUDFLARE_API_TOKEN` | Um token próprio da produção, com as permissões do token do staging ([staging.md](staging.md)) |
| Segredo | `CLOUDFLARE_ACCOUNT_ID` | A conta do Zikaron |
| Segredo | `ZIKARON_GITHUB_APP_ID`, `ZIKARON_GITHUB_INSTALLATION_ID` | O App `zikaron` e a instalação dele no `kelpie-vault` |
| Segredo | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | O time e a aplicação do Access do `zikaron` |
| Segredo | `ZIKARON_CLIENTS` | O JSON dos clientes reais, `noah`, `alan` e `mac`, com as flags do [ADR-0001](adr/0001-identidade-e-confianca.md) §7 ([api.md](api.md#a-configuração-do-deploy)) |
| Segredo | `PRODUCAO_URL` | `https://zikaron.<subdomínio>.workers.dev`, exatamente como o wrangler o imprime, sem barra no fim (detalhes abaixo) |
| Variável do environment `producao` | `VAULT_REPOSITORY` | `guedesdiogo/kelpie-vault` |
| Variáveis do repo | `PRUMO_DONOS`, `PRUMO_MENTOR` | Quem pede a produção e quem dá o «Aceite». As duas já existem |
| Segredo do Worker `zikaron` | `GITHUB_APP_PRIVATE_KEY` | A chave do App, em PKCS#8 |
| Segredo do Worker | `GITHUB_WEBHOOK_SECRET` | O segredo do webhook de push do `kelpie-vault` |

**O `PRODUCAO_URL`** precisa existir antes da primeira release. Sem ele, o deploy falha antes de publicar, para o endereço não sair sem máscara no log.

**O token da CI** vale para a conta inteira. O token do staging, na mesma conta, também alcança este Worker: é o risco aceito do [staging.md](staging.md).

**O environment `producao`** aceita deploy só da `main` e das tags `v*`.

**Os segredos do environment** entram pelo `prumo-segredos aplicar`. Ele lê os nomes do `segredos.json`, com o `ambiente` de cada um, e pede cada valor num prompt oculto. Um Enter vazio pula um nome.

## Passo a passo

1. **Um escritor só.** O Diogo para o context-store do Kelpie e confere o `kelpie-vault`, como na seção acima.
2. **Token, conta e endereço.** `prumo-segredos aplicar` grava o `CLOUDFLARE_API_TOKEN`, o `CLOUDFLARE_ACCOUNT_ID` e o `PRODUCAO_URL` do environment `producao`.
   - O subdomínio `workers.dev` da conta aparece em *Workers & Pages*, no painel.
   - A variável do cofre: `gh variable set VAULT_REPOSITORY --env producao --body guedesdiogo/kelpie-vault`.
3. **GitHub App.** Instalar o `zikaron` no `kelpie-vault`, só depois do passo 1. Gravar o App ID e o installation ID como segredos (`prumo-segredos aplicar`).
4. **Primeira release:** a `v0.1.0`, por ordem do Diogo (abaixo).
   - Ela publica o Worker e confere o `/health`.
   - Sem a chave do App, o cofre fica desligado.
   - Sem o Access e os clientes, toda rota além do `/health` e do webhook é recusada: 401, ou 500 sem a configuração dos clientes.
5. **Chave do App no Worker.** Num terminal, no diretório do repo:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in <arquivo .pem> | (cd apps/server && npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env producao)
   ```

   Depois, apagar o `.pem`. A partir daqui o cofre liga, e a primeira sincronização indexa o `kelpie-vault`.
6. **Access:**
   - ligar o Access no `workers.dev` do `zikaron`;
   - criar os service tokens reais `noah`, `alan` e `mac` e uma política *Service Auth* com eles;
   - criar uma aplicação de *bypass* para o caminho `/health` e outra para o `/webhooks/github`. Sem a do `/health`, o deploy publica, mas a conferência dele falha e o run fica vermelho;
   - gravar `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` e `ZIKARON_CLIENTS` como segredos (`prumo-segredos aplicar`);
   - entregar o Client ID e o Client Secret de cada token ao seu cliente, fora do repo e do chat.
7. **Publicar de novo a mesma tag.** As vars só entram num deploy. Por isso, por ordem do Diogo: `gh workflow run producao.yml --ref main -f tag=v0.1.0`. O intervalo da trava vem vazio, e nada para.
8. **Webhook de push do `kelpie-vault` para o `zikaron`.** O desenho é o do `scripts/webhook-staging.sh`: o segredo é gerado e gravado nos dois lados, sem imprimir. O script de hoje grava só no `zikaron-staging`; a versão da produção é o passo 4 da Story 1.9 (#21).

## Como sai uma release

Só por ordem do Diogo. O agente, com essa ordem no turno:

```bash
.github/scripts/producao.sh release v0.1.0              # prévia: a tag e as notas, nada é criado
.github/scripts/producao.sh release v0.1.0 --publicar   # cria a release publicada, que dispara a produção
```

- **Depois da primeira:** `patch`, `minor` ou `major` no lugar da versão.
- **O alvo padrão** é o último commit da `main` com o CI verde num push.
- **`--rascunho`** cria a release como rascunho, que não publica nada até o Diogo publicá-la.
- **Uma pré-release** nunca publica.
- **O Diogo** também pode publicar a release direto no GitHub.

O `producao.yml` confere tudo antes de publicar, e falha em vez de pular, para um pedido recusado nunca parecer um deploy:

1. **Quem pediu é dono:** quem publicou a release ou clicou em *Run workflow* está em `PRUMO_DONOS`. Um *Run workflow* só vale da `main`.
2. **A release:**
   - a tag é `vX.Y.Z` de uma release publicada, nem rascunho nem pré-release;
   - o commit dela está na `main`;
   - o CI desse commit passou num push na `main`.
3. **A trava do `critico`** (abaixo).
4. **O deploy** (`deploy.yml`, environment `producao`):
   - confere de novo o dono e o commit da tag, porque um *Re-run failed jobs* roda o deploy sem o gate;
   - publica com `wrangler deploy --env producao`, com os segredos do environment como `--var` e o `PRODUCAO_URL` mascarado;
   - espera o `/health` responder `{"status":"ok","environment":"producao","commit":"<sha da tag>"}`.

Um run de produção sai por vez, e o que está rodando sempre termina.

**Sem o token e a conta no environment,** o run termina verde com um aviso e não publica nada. Mesmo assim ele conta como «Produção vX.Y.Z» para a trava seguinte.

**A conferência do staging é só a do CI.** Aqui o staging é outro workflow (`staging.yml`), que publica depois de cada CI verde na `main`. O `producao.yml` confere que o CI do commit passou, não que o staging o recebeu.

## A trava do «Aceite»

Uma issue com o label `critico` só vai para a produção com o «Aceite» do mentor (`PRUMO_MENTOR`, padrão `guedesdiogo`). O «Aceite» é um comentário dele na issue que começa com `**Aceite** ·`, por exemplo `**Aceite** · produção · <link>`.

- **O intervalo** vai da tag que está em produção (o nome do último run verde, «Produção vX.Y.Z») até o commit da tag nova. Um run que parou não conta como produção: a issue continua parando as releases seguintes.
- **Entram as issues** que os PRs do intervalo fecham. Conta como aceita a issue cujo PR o próprio mentor abriu.
- **Sem o «Aceite»,** o job «Trava do critico» falha, e o resumo do run lista as issues. O `release --publicar` confere o mesmo antes de criar a release.
- **Forçar** é só de um dono, com o motivo:

  ```bash
  gh workflow run producao.yml --ref main -f tag=vX.Y.Z -f forcar=true -f motivo="<por quê>"
  ```

  Cada issue recebe o comentário «Aceite forçado». O mentor recebe a issue «Revisão retroativa · vX.Y.Z · aceite forçado».

## Voltar atrás

Por ordem do Diogo, o mesmo workflow com uma tag mais velha:

```bash
gh workflow run producao.yml --ref main -f tag=<tag mais velha>
```

- **O gate é o mesmo:** a release publicada, na `main`, com o CI verde.
- **A trava não para:** o intervalo de uma tag mais velha que a da produção vem vazio.
- **O resultado:** o deploy publica o commit da tag antiga, e o `/health` mostra o commit.
- **O cofre não muda:** ele é a verdade, e voltar o código não desfaz nenhum commit nele.
- **As migrações:** hoje o Durable Object só tem a `v1`. Uma release que trouxer outra precisa dizer como se volta atrás dela.

Para tirar o Zikaron do `kelpie-vault` de vez:
- desinstalar o App do `kelpie-vault`;
- apagar o webhook.

Nada do Zikaron fica no cofre além dos commits que ele fez e do relatório.
