#!/usr/bin/env bash
# Produção por release (prumo AMB-05, KAN-14 e D21). Do exemplo do prumo (forma do play-x9), com o
# workflow de produção em PRUMO_PRODUCAO_WORKFLOW (padrão producao.yml).
#
#   .github/scripts/producao.sh release <patch|minor|major|vX.Y.Z> [--alvo <sha>] [--rascunho|--publicar]
#       Sem --rascunho nem --publicar, só imprime a tag e as notas. --publicar é deploy de
#       produção: só com a ordem do dono.
#   .github/scripts/producao.sh notas <alvo> [<tag anterior>]
#   .github/scripts/producao.sh trava <tag> <sha>            (CI) falha se o <sha> leva à produção uma issue `critico` sem «Aceite»
#   .github/scripts/producao.sh forcar <tag> <sha> <motivo>  (CI) registra o aceite forçado e abre a revisão retroativa
#       O <sha> é o commit da tag como o gate o leu: ele fecha o intervalo; a tag só aparece.
#
# Precisa do git com as tags, do gh autenticado, do jq e do bash 4.4 ou mais novo. GH_REPO escolhe
# o repositório (padrão: o do checkout).
set -euo pipefail
# Uma falha dentro de $(…) também para o script: senão, uma chamada ao GitHub que falha vira «nenhuma issue».
shopt -s inherit_errexit

# O CI da main: o staging.yml publica o staging depois de cada run verde dele, e o último run verde
# é o alvo padrão de uma release. A conferência é a do CI; a do staging fica com o staging.yml.
STAGING_WORKFLOW="${PRUMO_STAGING_WORKFLOW:-ci.yml}"
# Publicado por uma release; os nomes dos runs dizem que tag está em produção.
PRODUCAO_WORKFLOW="${PRUMO_PRODUCAO_WORKFLOW:-producao.yml}"
MENTOR="${PRUMO_MENTOR:-guedesdiogo}"
REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
SEMVER='^v[0-9]+\.[0-9]+\.[0-9]+$'

die() { echo "producao.sh: $*" >&2; exit 1; }

# A tag semver estável antes de <ref> (vazia na primeira release). Uma pré-release nunca chega à
# produção, então a tag dela não encurta o intervalo.
tag_anterior() {
  git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$1^" 2>/dev/null || true
}

# A tag que está em produção: a do nome («Produção vX.Y.Z») do último run verde do workflow de
# produção. Sem esse run, vazia: o histórico inteiro, porque nada chegou à produção ainda. A trava
# começa aqui, não na tag anterior: uma release que parou continua parando as seguintes, a primeira
# também. Só dois tipos de run contam, nunca o de um workflow mudado em outra branch: um Run
# workflow da main, e um run de release cuja branch é a tag do nome e cujo commit é o da tag. Uma
# tag que falta no checkout não pode começar um intervalo: de novo o histórico inteiro.
base_producao() {
  local runs evento titulo sha tag re='^Produção (v[0-9]+\.[0-9]+\.[0-9]+)$'
  runs="$(gh run list -R "$REPO" --workflow "$PRODUCAO_WORKFLOW" --status success --limit 50 --json displayTitle,headBranch,event,headSha \
    -q '.[] | select((.event == "workflow_dispatch" and .headBranch == "main")
                     or (.event == "release" and .displayTitle == "Produção " + .headBranch))
            | [.event, .displayTitle, .headSha] | @tsv')"
  while IFS=$'\t' read -r evento titulo sha; do
    [[ "$titulo" =~ $re ]] || continue
    tag="${BASH_REMATCH[1]}"
    git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || return 0
    if [[ "$evento" == release && "$(git rev-parse "refs/tags/$tag^{commit}")" != "$sha" ]]; then continue; fi
    echo "$tag"
    return 0
  done <<<"$runs"
}

# Os PRs que entraram na main entre <anterior> e <alvo>, com as issues que cada um fecha, em JSON:
# [{pr, titulo, autor, issues: [{repo, numero, titulo, url, critico}]}]
prs_e_issues() {
  local anterior="$1" alvo="$2" range lista sha q i
  local -a shas=()
  range="$alvo"
  if [[ -n "$anterior" ]]; then range="$anterior..$alvo"; fi
  lista="$(git rev-list --first-parent "$range")"
  if [[ -n "$lista" ]]; then mapfile -t shas <<<"$lista"; fi
  for ((i = 0; i < ${#shas[@]}; i += 50)); do
    q=""
    for sha in "${shas[@]:i:50}"; do
      q+=" c$sha: object(oid: \"$sha\") { ... on Commit { associatedPullRequests(first: 3) { totalCount nodes {
        number title merged baseRefName author { login }
        closingIssuesReferences(first: 25) { totalCount nodes { number title url repository { nameWithOwner }
          labels(first: 30) { totalCount nodes { name } } } } } } } }"
    done
    gh api graphql -f owner="${REPO%/*}" -f name="${REPO#*/}" \
      -f query="query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) { defaultBranchRef { name } $q } }"
  done | jq -s '
    # Uma lista cortada no limite da consulta esconderia um PR, uma issue ou o label `critico`: falha.
    ( .[].data.repository | to_entries[] | select(.key | startswith("c")) | .value.associatedPullRequests
      | ., .nodes[].closingIssuesReferences, .nodes[].closingIssuesReferences.nodes[].labels
      | select(.totalCount != (.nodes | length))
      | error("uma lista do GraphQL veio cortada (PRs, issues ou labels além do limite da consulta)") ),
    ( [ .[].data.repository as $r | $r | to_entries[] | select(.key | startswith("c")) | .value.associatedPullRequests.nodes[]
        | select(.merged and .baseRefName == $r.defaultBranchRef.name)
        | { pr: .number, titulo: .title, autor: .author.login,
            issues: [ .closingIssuesReferences.nodes[] | { repo: .repository.nameWithOwner, numero: .number, titulo: .title, url,
                      critico: ([.labels.nodes[].name] | index("critico") != null) } ] } ]
      | unique_by(.pr) | sort_by(.pr) )'
}

# O link do «Aceite» do mentor na issue, ou vazio.
aceite() {
  gh api --paginate "repos/$1/issues/$2/comments" |
    jq -r --arg mentor "$MENTOR" '.[] | select(.user.login == $mentor and (.body | startswith("**Aceite** ·"))) | .html_url' |
    tail -n 1
}

# As issues `critico` sem «Aceite», uma por linha: repo<TAB>número<TAB>título. Uma issue fechada por
# um PR que o mentor abriu conta como aceita: ele mesmo a abriu.
criticas_sem_aceite() {
  jq -r --arg mentor "$MENTOR" '
    [.[] | .autor as $autor | .issues[] | select(.critico) | . + {autor: $autor}]
    | group_by(.repo, .numero)[] | select(all(.autor != $mentor)) | .[0]
    | [.repo, (.numero | tostring), .titulo] | @tsv' <<<"$1" |
    while IFS=$'\t' read -r repo numero titulo; do
      if [[ -z "$(aceite "$repo" "$numero")" ]]; then printf '%s\t%s\t%s\n' "$repo" "$numero" "$titulo"; fi
    done
}

notas() {
  local alvo="$1" anterior dados ref
  if (($# > 1)); then anterior="$2"; else anterior="$(tag_anterior "$alvo")"; fi
  dados="$(prs_e_issues "$anterior" "$alvo")"
  echo "Alvo \`$(git rev-parse --short "$alvo")\`${anterior:+ · desde $anterior}"
  echo
  echo "## PRs"
  jq -r 'if length == 0 then "Nenhum." else .[] | "- #\(.pr) \(.titulo)" end' <<<"$dados"
  echo
  echo "## Issues"
  jq -r '[.[].issues[]] | unique_by(.repo, .numero) | if length == 0 then "Nenhuma." else .[] |
    "- \(.url) \(.titulo)\(if .critico then " · `critico`" else "" end)" end' <<<"$dados"
  if jq -e '[.[].issues[] | select(.critico)] | length > 0' <<<"$dados" >/dev/null; then
    echo
    echo "## Aceite do mentor"
    jq -r --arg mentor "$MENTOR" '
      [.[] | .pr as $pr | .autor as $autor | .issues[] | select(.critico) | . + {pr: $pr, autor: $autor}]
      | group_by(.repo, .numero)[]
      | [.[0].repo, (.[0].numero | tostring), ([.[] | select(.autor == $mentor) | .pr] | first // "" | tostring)] | @tsv' <<<"$dados" |
      while IFS=$'\t' read -r repo numero pr_mentor; do
        if [[ -n "$pr_mentor" ]]; then ref="PR #$pr_mentor aberto pelo mentor"; else ref="$(aceite "$repo" "$numero")"; fi
        echo "- $repo#$numero: ${ref:-falta (o deploy de produção para)}"
      done
  fi
}

release() {
  local versao="${1:-}" alvo="" modo="previa" anterior tag x y z corpo base dados faltam verdes workflow
  shift || true
  while (($#)); do
    case "$1" in
      --alvo) alvo="${2:?--alvo pede o sha}"; shift 2 ;;
      --rascunho) modo="rascunho"; shift ;;
      --publicar) modo="publicar"; shift ;;
      *) die "argumento desconhecido: $1" ;;
    esac
  done
  [[ -n "$versao" ]] || die "uso: producao.sh release <patch|minor|major|vX.Y.Z> [--alvo <sha>] [--rascunho|--publicar]"
  git fetch -q origin --tags
  if [[ -z "$alvo" ]]; then
    alvo="$(gh run list -R "$REPO" --workflow "$STAGING_WORKFLOW" --branch main --event push --status success --limit 1 --json headSha -q '.[0].headSha')"
    [[ -n "$alvo" ]] || die "nenhum run verde do $STAGING_WORKFLOW na main; passe --alvo"
  fi
  alvo="$(git rev-parse --verify "$alvo^{commit}")"
  anterior="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$alvo" 2>/dev/null || true)"
  if [[ -n "$anterior" && "$(git rev-parse "$anterior^{commit}")" == "$alvo" ]]; then die "$alvo já é a $anterior"; fi
  case "$versao" in
    patch | minor | major)
      [[ -n "$anterior" ]] || die "primeira release: diga a versão (a primeira é a v0.1.0)"
      IFS=. read -r x y z <<<"${anterior#v}"
      case "$versao" in
        patch) tag="v$x.$y.$((z + 1))" ;;
        minor) tag="v$x.$((y + 1)).0" ;;
        major) tag="v$((x + 1)).0.0" ;;
      esac ;;
    *)
      [[ "$versao" =~ $SEMVER ]] || die "versão inválida: $versao (use patch, minor, major ou vX.Y.Z)"
      tag="$versao" ;;
  esac
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then die "a tag $tag já existe"; fi

  corpo="$(notas "$alvo" "$anterior")"
  printf '# %s\n\n%s\n' "$tag" "$corpo"
  [[ "$modo" != "previa" ]] || return 0
  # Publicar faz o deploy: o que o gate confere, o gatilho e a trava, antes de a release existir.
  if [[ "$modo" == "publicar" ]]; then
    git merge-base --is-ancestor "$alvo" origin/main || die "o alvo ${alvo:0:7} não está na origin/main"
    verdes="$(gh api "repos/$REPO/actions/workflows/$STAGING_WORKFLOW/runs?head_sha=$alvo&branch=main&event=push&status=success&per_page=1" --jq .total_count)"
    [ "${verdes:-0}" -ge 1 ] 2>/dev/null || die "o $STAGING_WORKFLOW não passou no alvo ${alvo:0:7} na main: o gate pararia"
    workflow="$(git show "$alvo:.github/workflows/$PRODUCAO_WORKFLOW" 2>/dev/null || true)"
    grep -qE '^[[:space:]]+release:[[:space:]]*$' <<<"$workflow" ||
      die "o $PRODUCAO_WORKFLOW do alvo ${alvo:0:7} não tem o gatilho release: a release não publicaria nada. Use um alvo com a produção por release"
    # O mesmo intervalo da trava, que pode começar antes da tag anterior.
    base="$(base_producao)"
    dados="$(prs_e_issues "$base" "$alvo")"
    faltam="$(criticas_sem_aceite "$dados")"
    if [[ -n "$faltam" ]]; then
      # O awk, não o `cut --output-delimiter` do exemplo, que o cut do macOS não tem.
      die "há issue \`critico\` sem o «Aceite» do mentor desde ${base:-o início}: o deploy pararia." \
        "Crie como --rascunho, ou o dono força pelo Run workflow com o motivo." \
        "Issues: $(awk -F'\t' '{print $1 "#" $2}' <<<"$faltam" | paste -sd ' ' -)"
    fi
  fi
  local rascunho=()
  if [[ "$modo" == "rascunho" ]]; then rascunho=(--draft); fi
  gh release create "$tag" -R "$REPO" --target "$alvo" --title "$tag" --notes "$corpo" "${rascunho[@]}"
}

# CI: o que o <sha> leva à produção. Escreve o resumo do job e imprime as issues sem «Aceite». Num
# rollback para uma tag mais velha que a da produção, o intervalo é vazio e nada para.
trava() {
  local tag="$1" sha="$2" base dados faltam
  base="$(base_producao)"
  dados="$(prs_e_issues "$base" "$sha")"
  faltam="$(criticas_sem_aceite "$dados")"
  {
    echo "### Trava do \`critico\` · $tag (\`${sha:0:7}\`)"
    echo "Desde ${base:-o início do histórico}."
    if [[ -z "$faltam" ]]; then
      echo "Nenhuma issue \`critico\` sem o «Aceite» do mentor."
    else
      echo "Sem o «Aceite» do mentor ($MENTOR):"
      while IFS=$'\t' read -r repo numero titulo; do echo "- $repo#$numero $titulo"; done <<<"$faltam"
    fi
  } >>"${GITHUB_STEP_SUMMARY:-/dev/stderr}"
  printf '%s' "$faltam"
}

# A issue aberta «Revisão retroativa · <tag> · aceite forçado», ou vazio.
revisao_aberta() {
  gh issue list -R "$REPO" --state open --label critico --limit 200 --json title,url |
    jq -r --arg titulo "Revisão retroativa · $1 · aceite forçado" '[.[] | select(.title == $titulo) | .url] | first // empty'
}

# Quantos comentários «Aceite forçado» da <tag> a issue já tem.
forcadas() {
  gh api --paginate "repos/$1/issues/$2/comments" |
    jq -s -r --arg inicio "**Aceite forçado** · produção · $3 ·" '[.[][] | select(.body | startswith($inicio))] | length'
}

# Rodar de novo (um re-run) reaproveita a revisão aberta e não comenta duas vezes numa issue.
forcar() {
  local tag="$1" sha="$2" motivo="$3" dono faltam run retro lista n
  [[ -n "${motivo// /}" ]] || die "forçar exige o motivo"
  dono="${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-?}}"
  faltam="$(trava "$tag" "$sha")"
  [[ -n "$faltam" ]] || return 0
  run="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-local}"
  lista="$(while IFS=$'\t' read -r repo numero titulo; do echo "- $repo#$numero $titulo"; done <<<"$faltam")"
  retro="$(revisao_aberta "$tag")"
  if [[ -z "$retro" ]]; then
    retro="$(gh issue create -R "$REPO" --assignee "$MENTOR" --label critico \
      --title "Revisão retroativa · $tag · aceite forçado" \
      --body "$(printf 'O dono forçou a produção da %s sem o «Aceite» do mentor.\n\nDono: %s\nMotivo: %s\nRun: %s\n\nIssues:\n%s\n\nRevise no ambiente e comente «**Aceite** · produção · <link>» em cada issue, ou abra a correção.' \
        "$tag" "$dono" "$motivo" "$run" "$lista")")"
  fi
  while IFS=$'\t' read -r repo numero _; do
    n="$(forcadas "$repo" "$numero" "$tag")"
    if [[ "$n" == 0 ]]; then
      gh issue comment "$numero" -R "$repo" --body "$(printf '**Aceite forçado** · produção · %s · %s\n\nDono: %s\nMotivo: %s\nRevisão retroativa: %s' \
        "$tag" "$run" "$dono" "$motivo" "$retro")"
    fi
  done <<<"$faltam"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  release) release "$@" ;;
  notas) notas "${1:?uso: producao.sh notas <alvo> [<tag anterior>]}" "${@:2}" ;;
  trava)
    faltam="$(trava "${1:?uso: producao.sh trava <tag> <sha>}" "${2:?uso: producao.sh trava <tag> <sha>}")"
    [[ -z "$faltam" ]] || die "release com issue \`critico\` sem o «Aceite» do mentor; o dono pode forçar pelo Run workflow, com o motivo"
    ;;
  forcar) forcar "${1:?uso: producao.sh forcar <tag> <sha> <motivo>}" "${2:?uso: producao.sh forcar <tag> <sha> <motivo>}" "${3-}" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
