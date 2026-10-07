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
environment is essentially the images the pipeline pushes, which is why step 6
sets a cleanup policy and a budget.

## 2. Enable the APIs

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
created by Terraform in step 6 and can read secrets but cannot deploy anything.

**This step must come before step 6.** Terraform grants this account permission
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
  --display-name="sainathyai/nostavel deploy-uat on main" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.job_workflow_ref == '${GITHUB_REPO}/.github/workflows/deploy-uat.yml@refs/heads/main'"

# Allow that repository to act as the deploy identity.
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${GITHUB_REPO}"
```

Print the provider's full name, which GitHub needs in step 10:

```bash
gcloud iam workload-identity-pools providers describe nostavel-repo \
  --project="$PROJECT" --location=global --workload-identity-pool=github \
  --format="value(name)"
```

## 6. Create the environment itself

```bash
cd infra/envs/uat

# Written from the variables set at the top of this runbook. terraform.tfvars is
# git-ignored, which is why these values go here rather than into a committed
# file. app_url is left out for now on purpose - the service has to exist before
# its URL does, which is why there are two applies below.
cat > terraform.tfvars <<VARS
project_number  = "${PROJECT_NUMBER}"
billing_account = "${BILLING}"
VARS
cat terraform.tfvars
```

Then:

```bash
terraform init
terraform plan      # read it before applying
terraform apply
```

This creates the image repository **with a cleanup policy** (keep the last 10,
delete anything else older than a week), the runtime identity, ten empty secret
containers, the Cloud Run service running a placeholder image, and the budget
alarm at $5 and $15.

> If the budget fails to apply because the account lacks billing permissions,
> everything else still applies. Set `billing_account = ""` and add the budget by
> hand in the Console under Billing → Budgets & alerts.

Now get the service's URL and do a second apply, because links in guest email
need it and it does not exist until the service does:

```bash
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format="value(status.url)"
```

Add it to `terraform.tfvars` and apply once more:

```bash
echo "app_url = \"https://THE-URL-FROM-ABOVE\"" >> terraform.tfvars
terraform apply
```

Keep that URL to hand: steps 9, 10 and 11 all need it.

## 7. Create this environment's own database

Its own, not the one you develop against (decision D-5.3): test bookings and
development bookings must not mix, and the hold sweeper runs every three minutes.

1. In the Neon console, create a branch of the Nostavel project called `uat`.
2. Copy its pooled connection string.

Nothing is migrated yet. The first deploy will ask you to approve that.

## 8. Create the Google sign-in client

Out of order on purpose: step 9 asks for its two values, and a runbook that says
"stop if a step fails" should not then send you forward.

In the Google Cloud Console, under **APIs & Services → Credentials**, create (or
reuse) an **OAuth 2.0 Client ID** of type *Web application*, and add this
redirect URI, using the URL from step 6:

```
https://THE-SERVICE-URL/api/auth/callback/google
```

Keep the client id and client secret for the next step.

## 9. Put the secret values in, by hand

**No agent does this step, and no secret value goes through Terraform** — see
`infra/README.md` for why.

Generate the two secrets that are ours to invent:

```bash
# The password for the environment. GENERATED, not memorable: the app enforces a
# 16-character minimum, and a length check cannot tell "nostavel-uat-pwd" from a
# real password. That distinction is this instruction's job (NOS-62).
openssl rand -base64 24

# The operations secret the scheduled jobs and the deploy's health check use.
openssl rand -hex 32
```

Then add a version to each secret. Using a file and deleting it afterwards keeps
the value out of your shell history:

```bash
for NAME in DATABASE_URL AUTH_SECRET LITEAPI_KEY LITEAPI_WEBHOOK_SECRET \
            ANTHROPIC_API_KEY RESEND_API_KEY CRON_SECRET ACCESS_PASSWORD \
            AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET; do
  # -p so there is a visible prompt (-rs alone echoes nothing at all, which looks
  # like a hung terminal), and the length is confirmed afterwards because an empty
  # entry creates an empty secret version that only surfaces as a fatal problem
  # three steps later.
  read -rsp "${NAME}: " VALUE; echo
  if [ -z "$VALUE" ]; then echo "  empty - skipped, set it before deploying"; continue; fi
  printf '%s' "$VALUE" | gcloud secrets versions add "${SERVICE}-${NAME}" \
    --project="$PROJECT" --data-file=- >/dev/null
  echo "  stored ${#VALUE} characters"
done
unset VALUE
```

| Secret | Where it comes from |
|---|---|
| `DATABASE_URL` | the Neon `uat` branch, step 7 |
| `AUTH_SECRET` | `npx auth secret`, or reuse nothing - generate a new one |
| `LITEAPI_KEY` | the LiteAPI **sandbox** key. Must start `sand_`, or the app refuses to serve |
| `LITEAPI_WEBHOOK_SECRET` | LiteAPI dashboard |
| `ANTHROPIC_API_KEY` | console.anthropic.com. Spend-capped |
| `RESEND_API_KEY` | resend.com |
| `CRON_SECRET` | generated above. **Also needed in step 10** |
| `ACCESS_PASSWORD` | generated above. This is what you type to open the site |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | the Google OAuth client, step 8 |

> `printf '%s'` rather than `echo`: `echo` appends a newline, and a newline inside
> `ACCESS_PASSWORD` or `CRON_SECRET` is the kind of thing that costs an hour. The
> app trims the access password for exactly this reason, but not every value is
> trimmed.

## 10. Tell GitHub how to deploy

```bash
gh variable set APP_URL --repo "$GITHUB_REPO" --body "https://<the service url>"

gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$GITHUB_REPO" --body "<from step 5>"
gh secret set GCP_DEPLOY_SERVICE_ACCOUNT --repo "$GITHUB_REPO" --body "$DEPLOY_SA"
gh secret set UAT_DATABASE_URL --repo "$GITHUB_REPO"     # paste the Neon uat string
gh secret set CRON_SECRET --repo "$GITHUB_REPO"          # the SAME value as step 8
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

## 11. Check the sign-in redirect

Already added in step 8. Confirm it is exactly the service URL from step 6, with
no trailing slash:

```
https://THE-SERVICE-URL/api/auth/callback/google
```

## 12. Deploy for the first time

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
`ACCESS_PASSWORD` from step 8.

## 13. Switch the money-safety jobs back on

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

They read `APP_URL` and `CRON_SECRET`, both set in step 10.

---

## If something fails

| What you see | What it means |
|---|---|
| `PERMISSION_DENIED ... iam.serviceaccounts.actAs` on the deploy | Step 6 has not been applied since step 4 created the account, so the deploy identity cannot act as the runtime one. Re-run `terraform apply` |
| `terraform apply` fails on `deployer_may_act_as_runtime` | Step 4 was skipped or the account has a different name. Check `gcloud iam service-accounts list --project="$PROJECT"` |
| The deploy's health check says `the detailed health route did not return an object` | `CRON_SECRET` in GitHub does not match the one in Secret Manager. They are two copies of one value (step 9 and step 10) |
| `this copy says it is "unconfigured"` | The service has no `APP_ENV`. The image defaults to refusing for exactly this reason; `terraform apply` sets it |
| `the supplier key is "live", not "sandbox"` | A non-sandbox `LITEAPI_KEY` is in Secret Manager. Replace it; do not override the check |
| The browser never asks for a password | `APP_ENV` is missing or `local` on the service. Same fix as above |
| A deploy run sits at "Waiting for approval" and later merges do not deploy | One deploy runs at a time, and an unanswered approval holds the queue. Approve it, reject it, or `gh run cancel <id>` to release the queue |

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
  which is why step 8 says so.
- **The map basemap is down** for unrelated reasons (public Protomaps builds
  stopped allowing browser access), so map views will be blank.
- **No error tracking or uptime alerting yet.** `payment.unresolved` still writes
  to a table nobody reads (NOS-56).
