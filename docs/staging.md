# O staging

O `zikaron-staging` é publicado pela CI a cada merge na `main` (`.github/workflows/staging.yml`, que chama o `deploy.yml`), contra o cofre de teste `guedesdiogo/zikaron-cofre-teste`, só com dados sintéticos. Nada é publicado da máquina. Depois de publicar, o deploy espera o `GET /health` responder `{"status":"ok","environment":"staging","commit":"<sha>"}` com o commit publicado; a produção é igual, por release ([producao.md](producao.md)).

## O que precisa existir

Nenhum valor abaixo vai para o repo nem passa por um chat. O repo é público, e o log de cada passo do Actions mostra as variáveis sem máscara: por isso tudo o que identifica a conta, o Access, os clientes ou o endereço do Worker fica como **segredo** do environment `staging`, mesmo não sendo uma senha. Só o nome do cofre de teste, que já está nos docs, é variável.

| Onde | Nome | O que é |
|---|---|---|
| Segredo do environment `staging` | `CLOUDFLARE_API_TOKEN` | O token da CI (abaixo) |
| Segredo | `CLOUDFLARE_ACCOUNT_ID` | A conta do Zikaron |
| Segredo | `ZIKARON_GITHUB_APP_ID`, `ZIKARON_GITHUB_INSTALLATION_ID` | O GitHub App `zikaron` e a instalação dele no cofre de teste |
| Segredo | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | O time e a aplicação do Access |
| Segredo | `ZIKARON_CLIENTS` | O JSON dos clientes de teste ([api.md](api.md#a-configuração-do-deploy)) |
| Segredo | `STAGING_URL` | O endereço do Worker, `https://zikaron-staging.<subdomínio>.workers.dev`, exatamente como o wrangler o imprime, sem barra no fim: assim o log o mascara. Se o token existe e ele não, o deploy falha antes de publicar, para o endereço não sair sem máscara |
| Segredo | `E2E_NOAH_CLIENT_ID`, `E2E_ALAN_CLIENT_ID`, `E2E_OUTRO_CLIENT_ID` e os três `E2E_*_CLIENT_SECRET` | Os três tokens de teste |
| Segredo | `E2E_VAULT_TOKEN` | Token fino do GitHub, *Contents: Read and write* só no cofre de teste |
| Variável do environment `staging` | `VAULT_REPOSITORY` | `guedesdiogo/zikaron-cofre-teste` |
| Segredo do Worker | `GITHUB_APP_PRIVATE_KEY` | A chave do App, em PKCS#8 |
| Segredo do Worker | `GITHUB_WEBHOOK_SECRET` | Gerado pelo `scripts/webhook-staging.sh` |

Os segredos do environment entram pelo `prumo-segredos aplicar`, que lê os nomes do `segredos.json` e pede cada valor num prompt oculto.

**O token da CI** é um token próprio, só com *Account › Workers Scripts › Edit* e *Account › Account Settings › Read* na conta do Zikaron, sem permissão de zona. Mesmo assim, ele vale para a conta inteira: o token do staging conseguiria publicar por cima do Worker de produção da mesma conta. É um risco aceito enquanto produção e staging dividem a conta; separá-los pede outra conta.

Os três clientes de teste em `ZIKARON_CLIENTS`: `noah` (`exposed`, `ownerClaims`), `alan` (`privileged`) e `outro` (nenhum dos dois).

## Passo a passo

1. **Token da CI, conta e endereço:** `prumo-segredos aplicar` grava o `CLOUDFLARE_API_TOKEN`, o `CLOUDFLARE_ACCOUNT_ID` e o `STAGING_URL` (os outros nomes do manifesto podem esperar: o comando pede um de cada vez, e um Enter vazio pula). O subdomínio `workers.dev` da conta aparece em *Workers & Pages*, no painel.
2. **GitHub App `zikaron`:**
   - criar em github.com/settings/apps/new, com o webhook desligado e as permissões de repositório *Contents: Read and write* e *Metadata: Read-only*;
   - instalar só no cofre de teste, nunca no `kelpie-vault` (a produção tem um App próprio, `docs/producao.md`);
   - gravar o App ID e o installation ID como segredos (`prumo-segredos aplicar`).
3. **Primeiro deploy:** um merge na `main` publica o Worker e confere o `/health`. Sem o App e o Access, o cofre fica desligado e toda rota além do `/health` e do webhook é recusada: 401, ou 500 sem a configuração dos clientes.
4. **Chave do App no Worker,** num terminal, no diretório do repo:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in <arquivo .pem> | (cd apps/server && npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging)
   ```

   Depois, apagar o `.pem`.
5. **Access:**
   - ligar o Access no `workers.dev` do `zikaron-staging`;
   - criar os service tokens `noah-teste`, `alan-teste` e `outro-teste` e uma política *Service Auth* com eles;
   - criar uma aplicação de *bypass* para o caminho `/webhooks/github` e outra para o `/health`, que só diz o ambiente e o commit. Sem a do `/health`, o deploy publica, mas a conferência dele falha e o run fica vermelho;
   - gravar `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ZIKARON_CLIENTS` e os três Client IDs como segredos (`prumo-segredos aplicar`).
6. **Webhook:** `CLOUDFLARE_ACCOUNT_ID=<conta> scripts/webhook-staging.sh guedesdiogo/zikaron-cofre-teste <STAGING_URL>`. O script gera o segredo e o grava no Worker e no webhook do repositório, sem imprimir.
7. **Segredos do roteiro:** `prumo-segredos aplicar`.
8. **Roteiro ponta a ponta:** `gh workflow run e2e-staging.yml --ref main`.

## O roteiro

O `scripts/e2e-staging.mjs` usa um marcador novo a cada rodada e confere:
- sem credencial, a borda recusa;
- o `noah` grava uma nota de fora e algo que o dono disse;
- uma gravação com `context: cron` é recusada;
- o `alan` não vê a nota de fora pela leitura, busca, recall, pendentes nem MCP, e o `outro` também não; o `noah` vê;
- o `alan` vê o que o dono disse, pelo `ownerClaims` do `noah`;
- tirar o `review: pending` no GitHub mostra a nota de fora para o `alan`, pelo webhook;
- uma nota escrita direto no GitHub chega ao recall do `alan`.

O cofre de teste é descartável: as notas do roteiro ficam lá, com o marcador da rodada no título.
