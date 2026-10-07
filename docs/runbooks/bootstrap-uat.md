# Runbook: set up the test environment, once

Everything in here is done **once**, by the owner, by hand, and then never again
(decision D-5.5 in [ADR 0005](../adr/0005-deployment-and-environments.md)). After
this, a merge to `main` deploys itself.

Written to be followed start to finish without reading any code. Every command is
copy-pasteable. If a step fails, stop there: later steps depend on earlier ones.

| | |
|---|---|
| Google project | `nostavel` |
| Region | `us-central1` |
| Cloud Run service | `nostavel-uat` |
| Image repository | `nostavel` |
| GitHub repository | `sainathyai/nostavel` |

## Before you start

```bash
gcloud --version          # Google Cloud SDK
terraform -version        # 1.9 or newer
gh --version              # GitHub CLI, authenticated
docker --version          # only needed if you want to build the image by hand
```

Two separate logins, and the second is the one that is easy to miss:

```bash
gcloud auth login                      # for the gcloud commands below
gcloud auth application-default login  # for Terraform
```

`gcloud auth login` does **not** produce the credentials Terraform reads. Without
the second command, step 6's `terraform init` fails with *"could not find default
credentials"* - at the step that creates everything, with nothing in the error
pointing here. Raised by the NOS-61 security review.

Then point both at this project, because the second login takes its quota project
from whatever was active and says so only in a line that is easy to read past:

```bash
gcloud auth application-default set-quota-project nostavel
gcloud config set project nostavel
gcloud config get-value project                      # nostavel
```

On an account with several projects this is not cosmetic: Terraform's API calls
would be attributed to the other project, and fail outright if `serviceusage` is
not permitted there. Hit on the first real run, 2026-10-07.

Set these once per shell so the commands below can be pasted as they are:

```bash
export PROJECT=nostavel
export REGION=us-central1
export SERVICE=nostavel-uat
export REPO=nostavel
export GITHUB_REPO=sainathyai/nostavel

# Looked up rather than written down: this repository is public, and an account
# identifier is the owner's, not the project's. Neither is a credential, and
# neither belongs in a public file either.
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
```

The billing account is not guessed at, because picking the wrong one is a
billing mistake nobody notices for a month:

```bash
gcloud billing accounts list
export BILLING=<the ACCOUNT_ID column, e.g. 0X0X0X-0X0X0X-0X0X0X>
```

Check all three came back with something before continuing:

```bash
echo "project number:  ${PROJECT_NUMBER:?not found}"
echo "billing account: ${BILLING:?not set - see the command above}"
echo "repo id:         $(gh api repos/$GITHUB_REPO -q .id)"
```

## A red cross on `main` before you finish is expected

Merging anything to `main` runs the pipeline, and until step 10 it has no
credentials, so it fails. Observed on the first merge (2026-10-07), and it failed
in the right order:

```
plan:    failure   migrate-plan: DATABASE_URL is not set.
migrate: skipped
deploy:  refusing to deploy because the database plan did not succeed.
         Without a plan, nobody knows whether this deploy contains a migration.
```

No image was built and no traffic moved. **The shape of that is the point:** the
deploy did not reason that a skipped migration meant there was nothing to apply.
If you ever see the opposite, a failed or skipped plan followed by a deploy that
proceeded, stop and treat it as a defect in `scripts/deploy-gate.mjs`.

---

## 1. Turn on billing

Nothing below works without it: Cloud Run, Artifact Registry and Secret Manager
all refuse to be enabled on a project with no billing account.

```bash
gcloud billing projects link "$PROJECT" --billing-account="$BILLING"
gcloud billing projects describe "$PROJECT"      # billingEnabled: true
```

**What this costs.** Based on the owner's own September bill, measured
2026-10-07: four always-available Cloud Run services across two projects cost
**$0.0007** for the month, because they scale to zero and nothing was calling
them. The entire bill was container image storage. So the cost of this
environment is essentially the images the pipeline pushes, which is why step 10
sets a cleanup policy and a budget.

## 2. Enable the APIs

**Do not skip this one.** Only `artifactregistry` is on by default, and the
failures that follow do not name a missing API: `terraform apply` fails part way
through having already created real resources. Skipped on the first real run
(2026-10-07) and caught by checking rather than by an error.

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  billingbudgets.googleapis.com \
  --project="$PROJECT"
```

## 3. Create the bucket Terraform keeps its state in

Versioned, so a bad apply can be recovered from, and private.

```bash
gcloud storage buckets create "gs://${PROJECT}-tfstate" \
  --project="$PROJECT" --location="$REGION" \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${PROJECT}-tfstate" --versioning
```

> The bucket name is already in `infra/envs/uat/backend.tf`. If you change it
> here, change it there too.

## 4. Create the identity the pipeline deploys as

Two things, and the separation matters: this is the identity that **deploys**,
and it deliberately cannot read any secret. The identity the app **runs** as is
created by Terraform in step 10 and can read secrets but cannot deploy anything.

**This step must come before step 10.** Terraform grants this account permission
to act as the runtime identity, and that grant needs the account to already
exist. If you run them the other way round, `terraform apply` fails on
`google_service_account_iam_member.deployer_may_act_as_runtime`; run step 4, then
apply again.

```bash
gcloud iam service-accounts create github-deploy \
  --project="$PROJECT" \
  --display-name="GitHub Actions deployer" \
  --description="Pushes images and deploys revisions. Reads no secrets."

export DEPLOY_SA="github-deploy@${PROJECT}.iam.gserviceaccount.com"
```

**That is all this step does: create the account, with no permissions.** Its two
grants are in `infra/` instead, scoped to the one service and the one image
repository that Terraform creates - a project-wide grant would have carried
`run.services.delete` on every Cloud Run service in the project and version
deletion on every repository, including the ten images the rollback runbook
depends on. Raised by the NOS-61 security review.

## 5. Let GitHub Actions use that identity, with no key file

A service-account key file is a credential that can be copied, pasted and
leaked, and this repository is public. Workload Identity Federation replaces it:
GitHub mints a short-lived token for a specific workflow run, and Google
exchanges it. Nothing long-lived exists to steal.

```bash
gcloud iam workload-identity-pools create github \
  --project="$PROJECT" --location=global --display-name="GitHub Actions"

# THE ATTRIBUTE CONDITION IS THE SECURITY BOUNDARY, and the obvious version of
# it is not tight enough. `assertion.ref == 'refs/heads/main'` reads like "code
# that was reviewed and merged", but GitHub reports the DEFAULT BRANCH as the ref
# for `pull_request_target` and `workflow_run` - so that clause really means "a
# workflow file that lives on main", which a fork's pull request can trigger.
# Nothing in this repository uses either trigger today, which is exactly what
# makes it dangerous: the boundary is one future labeller workflow away from
# opening, silently. Raised by the NOS-61 security review.
#
# `job_workflow_ref` is the clause that means what we want: only THIS file, on
# main, may mint this token. The numeric repository id is there as well, because
# a repository or account name can be renamed and then claimed by someone else.
export REPO_ID=$(gh api "repos/${GITHUB_REPO}" -q .id)
echo "repo id: ${REPO_ID:?could not read it - check gh auth status}"

gcloud iam workload-identity-pools providers create-oidc nostavel-repo \
  --project="$PROJECT" --location=global --workload-identity-pool=github \
  --display-name="nostavel deploy-uat on main" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.job_workflow_ref == '${GITHUB_REPO}/.github/workflows/deploy-uat.yml@refs/heads/main'"

# Allow that repository to act as the deploy identity.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}"
```

Print the provider's full name, which GitHub needs in step 11:

```bash
gcloud iam workload-identity-pools providers describe nostavel-repo \
  --project="$PROJECT" --location=global --workload-identity-pool=github \
  --format="value(name)"
```

## 6. Create the ten secret containers, and nothing else yet

**Read this before running it, because the order is not the obvious one.** A
Cloud Run service whose template reads `secrets/.../versions/latest` cannot be
created until each of those secrets actually holds a version. Terraform creates
the containers, you put the values in by hand, and only then can the service
exist. So this step creates the containers, steps 7 to 9 fill them, and step 10
creates everything else.

The first real run of this runbook did it in the obvious order and `terraform
apply` failed on the service with ten lines of `Secret ... versions/latest was
not found`, after creating 26 of 28 resources. Nothing was damaged, because an
apply is resumable, but the ordering was wrong and this is the fix.

```bash
cd infra/envs/uat

# Written from the variables set at the top of this runbook. terraform.tfvars is
# git-ignored, which is why these values go here rather than into a committed
# file. app_url is left out for now on purpose - the service has to exist before
# its URL does, which is why step 10 applies twice.
cat > terraform.tfvars <<VARS
project_number  = "${PROJECT_NUMBER}"
billing_account = "${BILLING}"
VARS
cat terraform.tfvars
```

```bash
terraform init
terraform apply -target='google_secret_manager_secret.app'
```

`-target` is Terraform's own escape hatch and it warns you about it. This is the
exceptional case it is for: a one-off bootstrap with a real dependency Terraform
cannot express, because the thing in between is a human pasting a secret.

That creates ten **empty** secret containers and nothing else.

## 7. Create this environment's own database

Its own, not the one you develop against (decision D-5.3): test bookings and
development bookings must not mix, and the hold sweeper runs every three minutes.

1. In the Neon console, create a branch of the Nostavel project called `uat`.
2. Copy its pooled connection string.

Nothing is migrated yet. The first deploy will ask you to approve that.

## 8. Create the Google sign-in client

In the Google Cloud Console, under **APIs & Services → Credentials**, create (or
reuse) an **OAuth 2.0 Client ID** of type *Web application*.

Leave the redirect URI for now: it needs the service URL, and the service does
not exist until step 10. Step 12 comes back and adds it. Keep the client id and
client secret for the next step.

## 9. Put the secret values in

**No agent does this step, and no secret value goes through Terraform** - see
`infra/README.md` for why.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/seed-uat-secrets.sh
```

That script does three different things to three groups of values, because they
are not the same kind of thing:

| | Secrets | Why |
|---|---|---|
| **Generated** | `AUTH_SECRET`, `CRON_SECRET`, `ACCESS_PASSWORD` | This environment gets its own. A shared `CRON_SECRET` means one leaked value unlocks the scheduled jobs everywhere, and a shared `AUTH_SECRET` makes a session cookie from development valid here |
| **Reused from `.env.local`** | `LITEAPI_KEY`, `LITEAPI_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Same sandbox supplier, same accounts, same OAuth client. Nothing to retype |
| **Asked for, and shown as you type** | `DATABASE_URL` | This environment's own database (D-5.3). Development's string must never reach it, so it cannot be read from a file |

**It refuses a value whose shape is wrong, before uploading it.** That is the
point of the script rather than a prompt. The first real run typed all ten into a
hidden prompt and stored a **300-character `DATABASE_URL`** - the pooled Neon
string pasted twice - and a 144-character `AUTH_SECRET`. Neither would have
surfaced until the deployed app could not reach its database, because a hidden
prompt gives you nothing to check against. The script checks the scheme, the
host, the length, a repeated scheme, a stray newline or space, the `sand_` prefix
on the supplier key, and the recognisable prefix of every API key.

It prints a name, a length and a source. It never prints a value, never writes
one to a file, and never puts one on a command line.

### Two of the ten are optional

`ANTHROPIC_API_KEY` and `RESEND_API_KEY` are **warnings, not fatal problems**
(`src/lib/deploy-config.ts`): no AI key means natural-language search is
unavailable, no email key means guest email is logged rather than sent. Neither
refuses a deploy. Press Enter at the prompt and the script switches the feature
off, and `/api/health?deep=1` then reports it.

Leaving the AI key out costs nothing today: `interpretQuery` has no caller, so
nothing in the app reaches it. Choosing a model belongs to Segment 5, which
starts with the eval harness that makes the choice measurable.

"Off" means a version the app reads as absent, not a missing version: the Cloud
Run service names all ten secrets and will not start if any has no version at
all. It is deliberately **not** a word like `unset`, because a non-empty value
reads as configured, stops the health route warning, and turns a clear "not set"
into an authentication error for whoever uses the feature first.

Re-running it is safe: Secret Manager keeps versions and the service reads
`latest`, so a corrected value wins. Tidy up afterwards:

```bash
gcloud secrets versions list "${SERVICE}-DATABASE_URL" --project="$PROJECT"
gcloud secrets versions disable N --secret="${SERVICE}-DATABASE_URL" --project="$PROJECT"
```

Disable rather than destroy until the first deploy is green.

### The two you need again later

Read them back out of Secret Manager rather than writing them down:

```bash
# the site password, which you type into the browser
gcloud secrets versions access latest --secret="${SERVICE}-ACCESS_PASSWORD" \
  --project="$PROJECT"; echo

# the operations secret, piped into GitHub without ever being displayed (step 11)
gcloud secrets versions access latest --secret="${SERVICE}-CRON_SECRET" \
  --project="$PROJECT" | gh secret set CRON_SECRET --repo "$GITHUB_REPO"
```

## 10. Create the environment itself

```bash
terraform plan      # read it before applying
terraform apply
```

This creates the image repository **with a cleanup policy** (keep the last 10,
delete anything else older than a week), the runtime identity, the Cloud Run
service running a placeholder image, the read grants, and the budget alarm.

> If the budget alone fails, everything else still applied. Set
> `billing_account = ""` and add it by hand in the Console under
> Billing → Budgets & alerts.

Now get the service's URL and apply a second time, because links in guest email
need it and it does not exist until the service does:

```bash
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format="value(status.url)"

echo "app_url = \"https://THE-URL-FROM-ABOVE\"" >> terraform.tfvars
terraform apply
```

Keep that URL to hand: steps 11, 12 and 13 all need it.

## 11. Tell GitHub how to deploy

```bash
gh variable set APP_URL --repo "$GITHUB_REPO" --body "https://<the service url>"

gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$GITHUB_REPO" --body "<from step 5>"
gh secret set GCP_DEPLOY_SERVICE_ACCOUNT --repo "$GITHUB_REPO" --body "$DEPLOY_SA"
# THE UNPOOLED STRING HERE, not the pooled one in Secret Manager: the same URL
# with `-pooler` dropped from the host. `scripts/migrate-plan.mjs` talks HTTP and
# does not care, but `drizzle-kit migrate` connects over TCP and runs every
# pending migration in ONE transaction, which is what Neon's direct endpoint is
# for.
gh secret set UAT_DATABASE_URL --repo "$GITHUB_REPO"
# Piped out of Secret Manager, so the two copies cannot differ by a typo.
gcloud secrets versions access latest --secret="${SERVICE}-CRON_SECRET" \
  --project="$PROJECT" | gh secret set CRON_SECRET --repo "$GITHUB_REPO"
```

> `CRON_SECRET` exists in two places and they must match. If they drift, the
> deploy's own health check fails with "the detailed health route did not return
> an object", and the scheduled jobs start answering 401.

**Then create the approval gate**, which is what makes D-5.4 real:

1. Repository → Settings → Environments → **New environment** → `uat-database`.
2. Tick **Required reviewers** and add yourself.
3. Save.

Without this, database changes apply with no approval. With it, the pipeline
stops and waits - and only when there is actually something to apply.

## 12. Add the sign-in redirect

Back to the OAuth client from step 8. Add this redirect URI, using the service
URL from step 10, with no trailing slash:

```
https://THE-SERVICE-URL/api/auth/callback/google
```

## 13. Deploy for the first time

```bash
gh workflow run deploy-uat.yml --repo "$GITHUB_REPO"
gh run watch --repo "$GITHUB_REPO"
```

The first run **will** ask for approval, because the database is empty and all
five migrations are pending. The run summary lists them before you approve.

Then check it yourself:

```bash
curl -s "https://<the service url>/api/health"
# {"ok":true,"env":"uat","sha":"..."}
```

Open the site in a browser. It will ask for a password: any username, and the
`ACCESS_PASSWORD` from step 9.

## 14. Switch the money-safety jobs back on

These have been written, tested and disabled since they were built, because there
was nothing to call. The sweeper is the only thing that rescues a guest who was
charged and whose browser never came back.

```bash
gh workflow enable cron-sweep.yml --repo "$GITHUB_REPO"
gh workflow enable cron-reconcile.yml --repo "$GITHUB_REPO"

# Prove they work rather than waiting for the schedule.
gh workflow run cron-sweep.yml --repo "$GITHUB_REPO"
gh run watch --repo "$GITHUB_REPO"
```

They read `APP_URL` and `CRON_SECRET`, both set in step 11.

---

## If something fails

| What you see | What it means |
|---|---|
| `PERMISSION_DENIED ... iam.serviceaccounts.actAs` on the deploy | Step 10 has not been applied since step 4 created the account, so the deploy identity cannot act as the runtime one. Re-run `terraform apply` |
| `terraform apply` fails on `deployer_may_act_as_runtime` | Step 4 was skipped or the account has a different name. Check `gcloud iam service-accounts list --project="$PROJECT"` |
| The deploy's health check says `the detailed health route did not return an object` | `CRON_SECRET` in GitHub does not match the one in Secret Manager. They are two copies of one value (step 9 and step 11) |
| `this copy says it is "unconfigured"` | The service has no `APP_ENV`. The image defaults to refusing for exactly this reason; `terraform apply` sets it |
| `the supplier key is "live", not "sandbox"` | A non-sandbox `LITEAPI_KEY` is in Secret Manager. Replace it; do not override the check |
| The browser never asks for a password | `APP_ENV` is missing or `local` on the service. Same fix as above |
| A deploy run sits at "Waiting for approval" and later merges do not deploy | One deploy runs at a time, and an unanswered approval holds the queue. Approve it, reject it, or `gh run cancel <id>` to release the queue |
| `INVALID_ARGUMENT: The WorkloadIdentityPoolProvider's display name must be less than or equal to 32 characters` | Step 5's `--display-name` is too long. The pool and the binding around it still succeeded, so re-run only the `create-oidc` command |
| `Secret projects/.../versions/latest was not found`, ten times, on the Cloud Run service | The secret values are not in yet. Do steps 7 to 9, then `terraform apply` again. Everything else in the apply already succeeded |
| `Error creating Budget: ... SERVICE_DISABLED` naming a project number you do not recognise | The provider sent no quota project. `infra/envs/uat/main.tf` sets `user_project_override`; if you are on an older copy, add it, or set `billing_account = ""` and create the budget by hand |
| `SERVICE_DISABLED`, or `terraform apply` failing on a resource type that was fine a moment ago | Step 2 was skipped or did not finish. Run it, then `terraform apply` again: it is safe to re-run |
| Anything mentioning a project you have never heard of | ADC's quota project. See "Before you start" |

## When it is done

- [ ] `curl .../api/health` returns `ok: true` and `env: uat`
- [ ] The browser asks for the password, and the site loads after it
- [ ] `gh workflow run cron-sweep.yml` goes green
- [ ] A merge to `main` deploys on its own
- [ ] A merge containing a migration stops and asks you first

## Known gaps, written down rather than discovered later

- **Guest email only reaches you.** Resend rejects every recipient but the account
  owner until a sending domain is verified (NOS-12). A booking made for any other
  address will not get a confirmation.
- **The access gate has no rate limit** (NOS-62). The password must be generated,
  which is why step 9 says so.
- **The map basemap is down** for unrelated reasons (public Protomaps builds
  stopped allowing browser access), so map views will be blank.
- **No error tracking or uptime alerting yet.** `payment.unresolved` still writes
  to a table nobody reads (NOS-56).
