#!/usr/bin/env bash
# Liga o webhook de push do cofre de teste ao zikaron-staging (Story 1.8). Gera o segredo do
# webhook e o grava, no mesmo pipeline, no webhook do repositório (API do GitHub, pelo stdin) e no
# Worker (`wrangler secret put`). O valor fica numa variável deste processo e nunca é impresso.
# Rodar de novo troca o segredo dos dois lados: o webhook que já existe para esse endereço é
# atualizado, não duplicado.
#
#   CLOUDFLARE_ACCOUNT_ID=<conta> scripts/webhook-staging.sh <owner/cofre> <URL do zikaron-staging>
set -euo pipefail

repo="${1:?uso: webhook-staging.sh <owner/cofre> <URL do zikaron-staging>}"
url="${2:?uso: webhook-staging.sh <owner/cofre> <URL do zikaron-staging>}"
: "${CLOUDFLARE_ACCOUNT_ID:?defina CLOUDFLARE_ACCOUNT_ID com a conta do Zikaron}"
cd "$(dirname "$0")/../apps/server"

hook_url="${url%/}/webhooks/github"
existing="$(HOOK_URL="$hook_url" gh api "repos/$repo/hooks" --jq '.[] | select(.config.url == env.HOOK_URL) | .id' | head -1)"

secret="$(openssl rand -hex 32)"
body="$(SECRET="$secret" HOOK_URL="$hook_url" jq -n \
  '{active: true, events: ["push"],
    config: {url: env.HOOK_URL, content_type: "json", insecure_ssl: "0", secret: env.SECRET}}')"
if [ -n "$existing" ]; then
  printf %s "$body" | gh api -X PATCH "repos/$repo/hooks/$existing" --input - --jq '"webhook \(.id) atualizado"'
else
  printf %s "$body" | jq '. + {name: "web"}' |
    gh api -X POST "repos/$repo/hooks" --input - --jq '"webhook \(.id) criado"'
fi
# Se o wrangler falhar aqui, o webhook já tem o segredo novo: rode o script de novo.
printf %s "$secret" | ./node_modules/.bin/wrangler secret put GITHUB_WEBHOOK_SECRET --env staging >/dev/null
unset secret body
echo "segredo do webhook gravado no Worker"
