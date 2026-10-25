#!/usr/bin/env bash
# Connects the test vault's push webhook to zikaron-staging (Story 1.8). Generates the webhook
# secret and writes it, in the same pipeline, to the repository's webhook (GitHub API, over stdin)
# and to the Worker (`wrangler secret put`). The value stays in a variable of this process and is
# never printed. Running it again replaces the secret on both sides: the webhook that already exists
# for that address is updated, not duplicated.
#
#   CLOUDFLARE_ACCOUNT_ID=<account> scripts/webhook-staging.sh <owner/vault> <zikaron-staging URL>
set -euo pipefail

repo="${1:?usage: webhook-staging.sh <owner/vault> <zikaron-staging URL>}"
url="${2:?usage: webhook-staging.sh <owner/vault> <zikaron-staging URL>}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the Zikaron account}"
cd "$(dirname "$0")/../apps/server"

hook_url="${url%/}/webhooks/github"
existing="$(HOOK_URL="$hook_url" gh api "repos/$repo/hooks" --jq '.[] | select(.config.url == env.HOOK_URL) | .id' | head -1)"

secret="$(openssl rand -hex 32)"
body="$(SECRET="$secret" HOOK_URL="$hook_url" jq -n \
  '{active: true, events: ["push"],
    config: {url: env.HOOK_URL, content_type: "json", insecure_ssl: "0", secret: env.SECRET}}')"
if [ -n "$existing" ]; then
  printf %s "$body" | gh api -X PATCH "repos/$repo/hooks/$existing" --input - --jq '"webhook \(.id) updated"'
else
  printf %s "$body" | jq '. + {name: "web"}' |
    gh api -X POST "repos/$repo/hooks" --input - --jq '"webhook \(.id) created"'
fi
# If wrangler fails here, the webhook already has the new secret: run the script again.
printf %s "$secret" | ./node_modules/.bin/wrangler secret put GITHUB_WEBHOOK_SECRET --env staging >/dev/null
unset secret body
echo "webhook secret written to the Worker"
