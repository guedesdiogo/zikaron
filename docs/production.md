# Production

The production `zikaron` writes to the real vault, `guedesdiogo/kelpie-vault`. It is published only by a GitHub release, on Diogo's order (`.github/workflows/producao.yml`, which calls the same `deploy.yml` as staging). Nothing is published from a machine.

## First of all: a single writer

ADR-0001 allows one automatic writer per vault. Kelpie's context-store still writes to `kelpie-vault`, and its commits would count as the owner's. So, in this order:

1. Diogo stops Kelpie's context-store, on Cloudflare.
2. Diogo checks that no new commit from Kelpie's bot shows up in `kelpie-vault`.
3. Only then is the production GitHub App, `zikaron-producao`, installed on `kelpie-vault`.

Without the installation, the production Worker can exist, but with the vault off.

## What has to exist

No value below goes into the repo or through a chat. The repo is public, and the Actions log shows the variables unmasked. So everything that identifies the account, Access, the clients, the App or the Worker's address is a **secret** of the `producao` environment, as in staging. Only the vault's name is a variable.

| Where | Name | What it is |
|---|---|---|
| Secret of the `producao` environment | `CLOUDFLARE_API_TOKEN` | A token of production's own, with the same permissions as the staging token ([staging.md](staging.md)) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Zikaron's account |
| Secret | `ZIKARON_GITHUB_APP_ID`, `ZIKARON_GITHUB_INSTALLATION_ID` | The `zikaron-producao` App and its installation on `kelpie-vault` |
| Secret | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | The Access team and application of `zikaron` |
| Secret | `ZIKARON_CLIENTS` | The JSON of the real clients, `noah`, `alan` and `mac`, with the flags of [ADR-0001](adr/0001-identidade-e-confianca.md) §7 ([api.md](api.md#the-deploy-configuration)) |
| Secret | `PRODUCAO_URL` | `https://zikaron.<subdomain>.workers.dev`, exactly as wrangler prints it, with no trailing slash (details below) |
| Variable of the `producao` environment | `VAULT_REPOSITORY` | `guedesdiogo/kelpie-vault` |
| Repo variables | `PRUMO_DONOS`, `PRUMO_MENTOR` | Who requests production and who gives the «Aceite». Both already exist |
| Secret of the `zikaron` Worker | `GITHUB_APP_PRIVATE_KEY` | The key of the `zikaron-producao` App, in PKCS#8 |
| Worker secret | `GITHUB_WEBHOOK_SECRET` | The secret of `kelpie-vault`'s push webhook |

**`PRODUCAO_URL`** has to exist before the first release. Without it, the deploy fails before publishing, so the address does not go out unmasked in the log.

**The CI token** is valid for the whole account. The staging token, in the same account, also reaches this Worker: it is the accepted risk in [staging.md](staging.md).

**The `producao` environment** accepts deploys only from `main` and the `v*` tags.

**The environment secrets** go in through `prumo-secrets aplicar`. It reads the names from `segredos.json`, with each one's `ambiente`, and asks for each value in a hidden prompt. An empty Enter skips a name.

## Step by step

1. **A single writer.** Diogo stops Kelpie's context-store and checks `kelpie-vault`, as in the section above.
2. **Token, account and address.** `prumo-secrets aplicar` writes `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `PRODUCAO_URL` of the `producao` environment.
   - The account's `workers.dev` subdomain shows up under *Workers & Pages*, in the dashboard.
   - The vault variable: `gh variable set VAULT_REPOSITORY --env producao --body guedesdiogo/kelpie-vault`.
3. **Production GitHub App.** Create a **separate** App, `zikaron-producao`, with the same permissions as the staging one (no webhook, *Contents: Read and write*, *Metadata: Read-only*), and install it **only** on `kelpie-vault`, only after step 1. Write the App ID and the installation ID as secrets (`prumo-secrets aplicar`).
   - **Never install the `zikaron` App (the staging one) on `kelpie-vault`.** Staging publishes on every merge, with no lock and no «Aceite», and holds that App's key: with it installed on the real vault, staging would become a second writer to it, which ADR-0001 forbids.
4. **First release:** `v0.1.0`, on Diogo's order (below).
   - It publishes the Worker and checks `/health`.
   - Without the App's key, the vault stays off.
   - Without Access and the clients, every route besides `/health` and the webhook is refused: 401, or 500 without the clients' configuration.
5. **The App's key in the Worker.** In a terminal, in the repo's directory:

   ```bash
   openssl pkcs8 -topk8 -nocrypt -in <.pem file> | (cd apps/server && npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env producao)
   ```

   Then delete the `.pem`. From here on the vault is on, and the first sync indexes `kelpie-vault`.
6. **Access:**
   - turn on Access for the `workers.dev` of `zikaron`;
   - create the real service tokens `noah`, `alan` and `mac` and a *Service Auth* policy with them;
   - create a *bypass* application for the `/health` path and another for `/webhooks/github`. Without the `/health` one, the deploy publishes, but its check fails and the run goes red;
   - write `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ZIKARON_CLIENTS` as secrets (`prumo-secrets aplicar`);
   - hand each token's Client ID and Client Secret to its client, outside the repo and the chat.
7. **Publish the same tag again.** The vars only go in with a deploy. So, on Diogo's order: `gh workflow run producao.yml --ref main -f tag=v0.1.0`. The lock's range comes out empty, and nothing stops.
8. **Push webhook from `kelpie-vault` to `zikaron`.** The design is that of `scripts/webhook-staging.sh`: the secret is generated and written on both sides, without printing it. Today's script writes only to `zikaron-staging`; the production version is step 4 of Story 1.9 (#21).

## How a release goes out

Only on Diogo's order. The agent, with that order in the turn:

```bash
.github/scripts/producao.sh release v0.1.0              # preview: the tag and the notes, nothing is created
.github/scripts/producao.sh release v0.1.0 --publicar   # creates the published release, which triggers production
```

- **After the first one:** `patch`, `minor` or `major` instead of the version.
- **The default target** is the last `main` commit with green CI on a push.
- **`--rascunho`** creates the release as a draft, which publishes nothing until Diogo publishes it.
- **A pre-release** never publishes.
- **Diogo** can also publish the release directly on GitHub.

`producao.yml` checks everything before publishing, and fails instead of skipping, so a refused request never looks like a deploy:

1. **The requester is an owner:** whoever published the release or clicked *Run workflow* is in `PRUMO_DONOS`. A *Run workflow* only counts from `main`.
2. **The release:**
   - the tag is `vX.Y.Z` of a published release, neither a draft nor a pre-release;
   - its commit is on `main`;
   - that commit's CI passed on a push to `main`.
3. **The `critico` lock** (below).
4. **The deploy** (`deploy.yml`, environment `producao`):
   - checks the owner and the tag's commit again, because a *Re-run failed jobs* runs the deploy without the gate;
   - publishes with `wrangler deploy --env producao`, with the environment secrets as `--var` and `PRODUCAO_URL` masked;
   - waits for `/health` to answer `{"status":"ok","environment":"producao","commit":"<tag sha>"}`.

One production run goes out at a time, and the one running always finishes.

**Without the token and the account in the environment,** the run ends green with a warning and publishes nothing. Even so, it counts as «Produção vX.Y.Z» for the next lock.

**The staging check is CI's only.** Here staging is another workflow (`staging.yml`), which publishes after each green CI on `main`. `producao.yml` checks that the commit's CI passed, not that staging received it.

## The «Aceite» lock

An issue with the `critico` label only goes to production with the mentor's «Aceite» (`PRUMO_MENTOR`, default `guedesdiogo`). The «Aceite» is a comment of the mentor's on the issue that starts with `**Aceite** ·`, for example `**Aceite** · produção · <link>`.

**Difference from the prumo example:** there, an issue closed by a PR the mentor opened counts as accepted. Here every PR comes from the mentor's account, including the ones an agent opens, so that exception was removed: only the comment counts. For the same reason, an agent never writes the «Aceite», even with access to the account: it is Diogo's, after checking on staging.

**Recommended:** a *required reviewer* (Diogo) on the `producao` environment, under Settings › Environments. It puts a human click before every production deploy, and also stops a `v*` tag created on a commit that did not go through review: on a release, the workflow runs the files of the tag's own commit.

- **The range** goes from the tag that is in production (the name of the last green run, «Produção vX.Y.Z») to the new tag's commit. A run that stopped does not count as production: the issue keeps stopping the following releases.
- **The issues that count** are the ones the PRs in the range close. An issue whose PR the mentor opened counts as accepted.
- **Without the «Aceite»,** the "Critico lock" job fails, and the run summary lists the issues. `release --publicar` checks the same before creating the release.
- **Forcing** is an owner's call only, with the reason:

  ```bash
  gh workflow run producao.yml --ref main -f tag=vX.Y.Z -f forcar=true -f motivo="<why>"
  ```

  Each issue gets the «Aceite forçado» comment. The mentor gets the issue «Revisão retroativa · vX.Y.Z · aceite forçado».

## Rolling back

On Diogo's order, the same workflow with an older tag:

```bash
gh workflow run producao.yml --ref main -f tag=<older tag>
```

- **The gate is the same:** the published release, on `main`, with green CI.
- **The lock does not stop:** the range of a tag older than production's comes out empty.
- **The result:** the deploy publishes the old tag's commit, and `/health` shows the commit.
- **The vault does not change:** it is the truth, and rolling the code back undoes no commit in it.
- **The migrations:** today the Durable Object has only `v1`. A release that brings another one has to say how to roll it back.

To take Zikaron off `kelpie-vault` for good:
- uninstall the App from `kelpie-vault`;
- delete the webhook.

Nothing of Zikaron stays in the vault besides the commits it made and the report.
