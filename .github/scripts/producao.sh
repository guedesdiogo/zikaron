#!/usr/bin/env bash
# Production by release (prumo AMB-05, KAN-14 and D21). From the prumo example (the play-x9 shape),
# with the production workflow in PRUMO_PRODUCAO_WORKFLOW (default producao.yml).
#
#   .github/scripts/producao.sh release <patch|minor|major|vX.Y.Z> [--alvo <sha>] [--rascunho|--publicar]
#       Without --rascunho or --publicar, it only prints the tag and the notes. --publicar is a
#       production deploy: only with the owner's order.
#   .github/scripts/producao.sh notas <target> [<previous tag>]
#   .github/scripts/producao.sh trava <tag> <sha>            (CI) fails if <sha> takes a `critico` issue without «Aceite» to production
#   .github/scripts/producao.sh forcar <tag> <sha> <reason>  (CI) records the forced acceptance and opens the retroactive review
#       <sha> is the tag's commit as the gate read it: it closes the range; the tag only shows up.
#
# Needs git with the tags, an authenticated gh, jq and bash 4.4 or newer. GH_REPO picks the
# repository (default: the checkout's).
set -euo pipefail
# A failure inside $(…) also stops the script: otherwise a failing GitHub call becomes "no issue".
shopt -s inherit_errexit

# The main CI: staging.yml publishes staging after each of its green runs, and the last green run
# is a release's default target. The check is CI's; staging's stays with staging.yml.
STAGING_WORKFLOW="${PRUMO_STAGING_WORKFLOW:-ci.yml}"
# Published by a release; the runs' names say which tag is in production.
PRODUCAO_WORKFLOW="${PRUMO_PRODUCAO_WORKFLOW:-producao.yml}"
MENTOR="${PRUMO_MENTOR:-guedesdiogo}"
REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
SEMVER='^v[0-9]+\.[0-9]+\.[0-9]+$'

die() { echo "producao.sh: $*" >&2; exit 1; }

# The stable semver tag before <ref> (empty on the first release). A pre-release never reaches
# production, so its tag does not shorten the range.
tag_anterior() {
  git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$1^" 2>/dev/null || true
}

# The tag in production: the one in the name («Produção vX.Y.Z») of the production workflow's last
# green run. Without that run, empty: the whole history, because nothing has reached production yet.
# The lock starts here, not at the previous tag: a release that stopped keeps stopping the following
# ones, the first one too. Only two kinds of run count, never one of a workflow changed on another
# branch: a Run workflow from main, and a release run whose branch is the tag in the name and whose
# commit is the tag's. A tag missing from the checkout cannot start a range: the whole history again.
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

# The PRs that went into main between <previous> and <target>, with the issues each one closes, as JSON:
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
    # A list cut at the query's limit would hide a PR, an issue or the `critico` label: fail.
    ( .[].data.repository | to_entries[] | select(.key | startswith("c")) | .value.associatedPullRequests
      | ., .nodes[].closingIssuesReferences, .nodes[].closingIssuesReferences.nodes[].labels
      | select(.totalCount != (.nodes | length))
      | error("a GraphQL list came cut (PRs, issues or labels beyond the query limit)") ),
    ( [ .[].data.repository as $r | $r | to_entries[] | select(.key | startswith("c")) | .value.associatedPullRequests.nodes[]
        | select(.merged and .baseRefName == $r.defaultBranchRef.name)
        | { pr: .number, titulo: .title, autor: .author.login,
            issues: [ .closingIssuesReferences.nodes[] | { repo: .repository.nameWithOwner, numero: .number, titulo: .title, url,
                      critico: ([.labels.nodes[].name] | index("critico") != null) } ] } ]
      | unique_by(.pr) | sort_by(.pr) )'
}

# The link of the mentor's «Aceite» on the issue, or empty.
aceite() {
  gh api --paginate "repos/$1/issues/$2/comments" |
    jq -r --arg mentor "$MENTOR" '.[] | select(.user.login == $mentor and (.body | startswith("**Aceite** ·"))) | .html_url' |
    tail -n 1
}

# The `critico` issues without «Aceite», one per line: repo<TAB>number<TAB>title. In this repo, every
# PR comes from the mentor's account, including the ones an agent opens: a PR opened from it does not
# count as acceptance. Only the «Aceite» comment counts (a difference from the prumo example).
criticas_sem_aceite() {
  jq -r '
    [.[] | .issues[] | select(.critico)]
    | group_by(.repo, .numero)[] | .[0]
    | [.repo, (.numero | tostring), .titulo] | @tsv' <<<"$1" |
    while IFS=$'\t' read -r repo numero titulo; do
      if [[ -z "$(aceite "$repo" "$numero")" ]]; then printf '%s\t%s\t%s\n' "$repo" "$numero" "$titulo"; fi
    done
}

notas() {
  local alvo="$1" anterior dados ref
  if (($# > 1)); then anterior="$2"; else anterior="$(tag_anterior "$alvo")"; fi
  dados="$(prs_e_issues "$anterior" "$alvo")"
  echo "Target \`$(git rev-parse --short "$alvo")\`${anterior:+ · since $anterior}"
  echo
  echo "## PRs"
  jq -r 'if length == 0 then "None." else .[] | "- #\(.pr) \(.titulo)" end' <<<"$dados"
  echo
  echo "## Issues"
  jq -r '[.[].issues[]] | unique_by(.repo, .numero) | if length == 0 then "None." else .[] |
    "- \(.url) \(.titulo)\(if .critico then " · `critico`" else "" end)" end' <<<"$dados"
  if jq -e '[.[].issues[] | select(.critico)] | length > 0' <<<"$dados" >/dev/null; then
    echo
    echo "## The mentor's Aceite"
    jq -r '
      [.[].issues[] | select(.critico)]
      | group_by(.repo, .numero)[]
      | [.[0].repo, (.[0].numero | tostring)] | @tsv' <<<"$dados" |
      while IFS=$'\t' read -r repo numero; do
        ref="$(aceite "$repo" "$numero")"
        echo "- $repo#$numero: ${ref:-missing (the production deploy stops)}"
      done
  fi
}

release() {
  local versao="${1:-}" alvo="" modo="previa" anterior tag x y z corpo base dados faltam verdes workflow
  shift || true
  while (($#)); do
    case "$1" in
      --alvo) alvo="${2:?--alvo takes the sha}"; shift 2 ;;
      --rascunho) modo="rascunho"; shift ;;
      --publicar) modo="publicar"; shift ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [[ -n "$versao" ]] || die "usage: producao.sh release <patch|minor|major|vX.Y.Z> [--alvo <sha>] [--rascunho|--publicar]"
  git fetch -q origin --tags
  if [[ -z "$alvo" ]]; then
    alvo="$(gh run list -R "$REPO" --workflow "$STAGING_WORKFLOW" --branch main --event push --status success --limit 1 --json headSha -q '.[0].headSha')"
    [[ -n "$alvo" ]] || die "no green $STAGING_WORKFLOW run on main; pass --alvo"
  fi
  alvo="$(git rev-parse --verify "$alvo^{commit}")"
  anterior="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$alvo" 2>/dev/null || true)"
  if [[ -n "$anterior" && "$(git rev-parse "$anterior^{commit}")" == "$alvo" ]]; then die "$alvo is already $anterior"; fi
  case "$versao" in
    patch | minor | major)
      [[ -n "$anterior" ]] || die "first release: give the version (the first one is v0.1.0)"
      IFS=. read -r x y z <<<"${anterior#v}"
      case "$versao" in
        patch) tag="v$x.$y.$((z + 1))" ;;
        minor) tag="v$x.$((y + 1)).0" ;;
        major) tag="v$((x + 1)).0.0" ;;
      esac ;;
    *)
      [[ "$versao" =~ $SEMVER ]] || die "invalid version: $versao (use patch, minor, major or vX.Y.Z)"
      tag="$versao" ;;
  esac
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then die "the tag $tag already exists"; fi

  corpo="$(notas "$alvo" "$anterior")"
  printf '# %s\n\n%s\n' "$tag" "$corpo"
  [[ "$modo" != "previa" ]] || return 0
  # Publishing deploys: what the gate checks, the trigger and the lock, before the release exists.
  if [[ "$modo" == "publicar" ]]; then
    git merge-base --is-ancestor "$alvo" origin/main || die "the target ${alvo:0:7} is not on origin/main"
    verdes="$(gh api "repos/$REPO/actions/workflows/$STAGING_WORKFLOW/runs?head_sha=$alvo&branch=main&event=push&status=success&per_page=1" --jq .total_count)"
    [ "${verdes:-0}" -ge 1 ] 2>/dev/null || die "$STAGING_WORKFLOW did not pass on the target ${alvo:0:7} on main: the gate would stop"
    workflow="$(git show "$alvo:.github/workflows/$PRODUCAO_WORKFLOW" 2>/dev/null || true)"
    grep -qE '^[[:space:]]+release:[[:space:]]*$' <<<"$workflow" ||
      die "the $PRODUCAO_WORKFLOW of the target ${alvo:0:7} has no release trigger: the release would publish nothing. Use a target with production by release"
    # The same range as the lock, which may start before the previous tag.
    base="$(base_producao)"
    dados="$(prs_e_issues "$base" "$alvo")"
    faltam="$(criticas_sem_aceite "$dados")"
    if [[ -n "$faltam" ]]; then
      # awk, not the example's `cut --output-delimiter`, which macOS's cut lacks.
      die "there is a \`critico\` issue without the mentor's «Aceite» since ${base:-the start}: the deploy would stop." \
        "Create it as --rascunho, or the owner forces it through Run workflow with the reason." \
        "Issues: $(awk -F'\t' '{print $1 "#" $2}' <<<"$faltam" | paste -sd ' ' -)"
    fi
  fi
  local rascunho=()
  if [[ "$modo" == "rascunho" ]]; then rascunho=(--draft); fi
  gh release create "$tag" -R "$REPO" --target "$alvo" --title "$tag" --notes "$corpo" "${rascunho[@]}"
}

# CI: what <sha> takes to production. Writes the job summary and prints the issues without «Aceite».
# On a rollback to a tag older than production's, the range is empty and nothing stops.
trava() {
  local tag="$1" sha="$2" base dados faltam
  base="$(base_producao)"
  dados="$(prs_e_issues "$base" "$sha")"
  faltam="$(criticas_sem_aceite "$dados")"
  {
    echo "### \`critico\` lock · $tag (\`${sha:0:7}\`)"
    echo "Since ${base:-the start of the history}."
    if [[ -z "$faltam" ]]; then
      echo "No \`critico\` issue without the mentor's «Aceite»."
    else
      echo "Without the mentor's «Aceite» ($MENTOR):"
      while IFS=$'\t' read -r repo numero titulo; do echo "- $repo#$numero $titulo"; done <<<"$faltam"
    fi
  } >>"${GITHUB_STEP_SUMMARY:-/dev/stderr}"
  printf '%s' "$faltam"
}

# The open issue «Revisão retroativa · <tag> · aceite forçado», or empty. The title is the prumo
# protocol's, and finding it again keeps a re-run from opening a second one.
revisao_aberta() {
  gh issue list -R "$REPO" --state open --label critico --limit 200 --json title,url |
    jq -r --arg titulo "Revisão retroativa · $1 · aceite forçado" '[.[] | select(.title == $titulo) | .url] | first // empty'
}

# How many «Aceite forçado» comments for <tag> the issue already has.
forcadas() {
  gh api --paginate "repos/$1/issues/$2/comments" |
    jq -s -r --arg inicio "**Aceite forçado** · produção · $3 ·" '[.[][] | select(.body | startswith($inicio))] | length'
}

# Running again (a re-run) reuses the open review and does not comment twice on an issue.
forcar() {
  local tag="$1" sha="$2" motivo="$3" dono faltam run retro lista n
  [[ -n "${motivo// /}" ]] || die "forcing requires the reason"
  dono="${GITHUB_TRIGGERING_ACTOR:-${GITHUB_ACTOR:-?}}"
  faltam="$(trava "$tag" "$sha")"
  [[ -n "$faltam" ]] || return 0
  run="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-local}"
  lista="$(while IFS=$'\t' read -r repo numero titulo; do echo "- $repo#$numero $titulo"; done <<<"$faltam")"
  retro="$(revisao_aberta "$tag")"
  if [[ -z "$retro" ]]; then
    retro="$(gh issue create -R "$REPO" --assignee "$MENTOR" --label critico \
      --title "Revisão retroativa · $tag · aceite forçado" \
      --body "$(printf 'The owner forced %s into production without the «Aceite» from the mentor.\n\nOwner: %s\nReason: %s\nRun: %s\n\nIssues:\n%s\n\nReview it in the environment and comment «**Aceite** · produção · <link>» on each issue, or open the fix.' \
        "$tag" "$dono" "$motivo" "$run" "$lista")")"
  fi
  while IFS=$'\t' read -r repo numero _; do
    n="$(forcadas "$repo" "$numero" "$tag")"
    if [[ "$n" == 0 ]]; then
      gh issue comment "$numero" -R "$repo" --body "$(printf '**Aceite forçado** · produção · %s · %s\n\nOwner: %s\nReason: %s\nRetroactive review: %s' \
        "$tag" "$run" "$dono" "$motivo" "$retro")"
    fi
  done <<<"$faltam"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  release) release "$@" ;;
  notas) notas "${1:?usage: producao.sh notas <target> [<previous tag>]}" "${@:2}" ;;
  trava)
    faltam="$(trava "${1:?usage: producao.sh trava <tag> <sha>}" "${2:?usage: producao.sh trava <tag> <sha>}")"
    [[ -z "$faltam" ]] || die "a release with a \`critico\` issue without the mentor's «Aceite»; the owner can force it through Run workflow, with the reason"
    ;;
  forcar) forcar "${1:?usage: producao.sh forcar <tag> <sha> <reason>}" "${2:?usage: producao.sh forcar <tag> <sha> <reason>}" "${3-}" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
