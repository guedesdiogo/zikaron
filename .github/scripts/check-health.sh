#!/usr/bin/env bash
# Waits for /health to answer with the environment and the commit just published (prumo AMB-03).
# From the prumo example (the play-x9 shape). On a Worker's first deploy, workers.dev can take a
# few minutes to answer: the default wait is 5 min.
#
# The repo is public, and so is the Actions log. Unlike the example, the script never prints the
# address, the body of a response that does not match or curl's error, which would carry the
# account's subdomain or the Access page: only the HTTP status and the three /health fields.
#
#   .github/scripts/check-health.sh <url> <environment> <commit> [seconds]
set -euo pipefail

url=$1
environment=$2
commit=$3
wait=${4:-300}
deadline=$((SECONDS + wait))
expected=$(jq -cn --arg e "$environment" --arg c "$commit" '{status: "ok", environment: $e, commit: $c}')
body=$(mktemp)
trap 'rm -f "$body"' EXIT

while :; do
  : >"$body"
  # Without -S and with stderr dropped: curl's error message names the host.
  code=$(curl -s -o "$body" -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)
  got=$(jq -c '{status, environment, commit}' "$body" 2>/dev/null || true)
  if [ "$got" = "$expected" ]; then
    echo "/health → $got"
    exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep 5
done

# A single line: the runner reads «::» lines in the log as commands.
echo "In $wait s, /health did not answer $expected. Last response: HTTP ${code:-000}${got:+, $got}." >&2
exit 1
