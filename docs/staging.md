# O staging

O `zikaron-staging` é publicado pela CI a cada merge na `main` (`.github/workflows/staging.yml`), contra o cofre de teste `guedesdiogo/zikaron-cofre-teste`, só com dados sintéticos. Nada é publicado da máquina.

## O que precisa existir

Nenhum valor abaixo vai para o repo nem passa por um chat. Os IDs não são segredos, mas são da conta e ficam nas variáveis do environment `staging` do GitHub.

| Onde | Nome | O que é |
|---|---|---|
| Segredo do environment `staging` | `CLOUDFLARE_API_TOKEN` | Token com o modelo «Edit Cloudflare Workers», só na conta do Zikaron |
| Variável do environment `staging` | `CLOUDFLARE_ACCOUNT_ID` | A conta do Zikaron |
| Variável | `ZIKARON_GITHUB_APP_ID`, `ZIKARON_GITHUB_INSTALLATION_ID` | O GitHub App `zikaron` e a instalação dele no cofre de teste |
| Variável | `VAULT_REPOSITORY` | `guedesdiogo/zikaron-cofre-teste` |
| Variável | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | O time e a aplicação do Access |
| Variável | `ZIKARON_CLIENTS` | O JSON dos clientes de teste ([api.md](api.md#a-configuração-do-deploy)) |
| Segredo do Worker | `GITHUB_APP_PRIVATE_KEY` | A chave do App, em PKCS#8 |
| Segredo do Worker | `GITHUB_WEBHOOK_SECRET` | Gerado pelo `scripts/webhook-staging.sh` |
| Variáveis do roteiro | `STAGING_URL`, `E2E_NOAH_CLIENT_ID`, `E2E_ALAN_CLIENT_ID`, `E2E_OUTRO_CLIENT_ID` | O endereço do Worker e os três tokens de teste |
| Segredos do roteiro | `E2E_*_CLIENT_SECRET`, `E2E_VAULT_TOKEN` | Pelo `prumo-segredos aplicar` (`segredos.json`) |

Os três clientes de teste em `ZIKARON_CLIENTS`: `noah` (`exposed`, `ownerClaims`), `alan` (`privileged`) e `outro` (nenhum dos dois).

## Passo a passo

1. **Token da CI:** `prumo-segredos gravar CLOUDFLARE_API_TOKEN --destino gh --ambiente staging --repo guedesdiogo/zikaron`, e a variável `CLOUDFLARE_ACCOUNT_ID`.
2. **GitHub App `zikaron`:**
   - criar em github.com/settings/apps/new, com o webhook desligado e as permissões de repositório *Contents: Read and write* e *Metadata: Read-only*;
   - instalar só no cofre de teste;
   - gravar o App ID e o installation ID nas variáveis.
3. **Primeiro deploy:** um merge na `main` publica o Worker. Sem o App e o Access, o cofre fica desligado e toda rota responde 401.
4. **Chave do App no Worker,** num terminal, no diretório do repo:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in <arquivo .pem> | (cd apps/server && npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging)
   ```

   Depois, apagar o `.pem`.
5. **Access:**
   - ligar o Access no `workers.dev` do `zikaron-staging`;
   - criar os service tokens `noah-teste`, `alan-teste` e `outro-teste` e uma política *Service Auth* com eles;
   - criar uma aplicação de *bypass* para o caminho `/webhooks/github`;
   - gravar `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ZIKARON_CLIENTS`, `STAGING_URL` e os três Client IDs nas variáveis.
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
