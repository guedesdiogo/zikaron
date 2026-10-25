#!/usr/bin/env bash
# Espera o /health responder com o ambiente e o commit recém-publicados (prumo AMB-03). Do exemplo
# do prumo (forma do play-x9). No primeiro deploy de um Worker, o workers.dev pode levar alguns
# minutos para responder: a espera padrão é de 5 min.
#
# O repo é público, e o log do Actions também. Ao contrário do exemplo, o script nunca imprime o
# endereço, o corpo de uma resposta que não confere nem o erro do curl, que trariam o subdomínio da
# conta ou a página do Access: só o status HTTP e os três campos do /health.
#
#   .github/scripts/check-health.sh <url> <ambiente> <commit> [segundos]
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
  # Sem -S e com o stderr fora: a mensagem de erro do curl diz o host.
  code=$(curl -s -o "$body" -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)
  got=$(jq -c '{status, environment, commit}' "$body" 2>/dev/null || true)
  if [ "$got" = "$expected" ]; then
    echo "/health → $got"
    exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep 5
done

# Uma linha só: o runner lê as linhas «::» do log como comandos.
echo "Em $wait s, o /health não respondeu $expected. Última resposta: HTTP ${code:-000}${got:+, $got}." >&2
exit 1
