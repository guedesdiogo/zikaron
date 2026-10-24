#!/usr/bin/env bash
# Liga o webhook de push do cofre de teste ao zikaron-staging (Story 1.8). Gera o segredo do
# webhook e o grava, no mesmo pipeline, no Worker (`wrangler secret put`) e no webhook do
# repositório (API do GitHub). O valor fica numa variável deste processo e nunca é impresso.
#
#   CLOUDFLARE_ACCOUNT_ID=<conta> scripts/webhook-staging.sh <owner/cofre> <URL do zikaron-staging>
set -euo pipefail

repo="${1:?uso: webhook-staging.sh <owner/cofre> <URL do zikaron-staging>}"
url="${2:?uso: webhook-staging.sh <owner/cofre> <URL do zikaron-staging>}"
: "${CLOUDFLARE_ACCOUNT_ID:?defina CLOUDFLARE_ACCOUNT_ID com a conta do Zikaron}"
cd "$(dirname "$0")/../apps/server"

secret="$(openssl rand -hex 32)"
printf %s "$secret" | ./node_modules/.bin/wrangler secret put GITHUB_WEBHOOK_SECRET --env staging >/dev/null
SECRET="$secret" HOOK_URL="${url%/}/webhooks/github" jq -n \
  '{name: "web", active: true, events: ["push"],
    config: {url: env.HOOK_URL, content_type: "json", insecure_ssl: "0", secret: env.SECRET}}' |
  gh api -X POST "repos/$repo/hooks" --input - --jq '"webhook \(.id) criado para \(.config.url)"'
unset secret
