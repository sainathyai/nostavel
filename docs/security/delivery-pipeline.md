# Threat model: the delivery pipeline and the test environment

- **Author:** security-architect review of NOS-61, recorded by the devops-sre role
- **Date:** 2026-10-07
- **In scope:**
  - `.github/workflows/deploy-uat.yml` (the only workflow holding cloud credentials)
  - `scripts/migrate-plan.mjs`, `scripts/deploy-gate.mjs`, `scripts/deploy-smoke.mjs`
  - `infra/envs/uat/` (Artifact Registry, Secret Manager containers, the Cloud Run service, IAM)
  - `docs/runbooks/bootstrap-uat.md`, `deploy.md`, `rollback.md`, `rotate-secrets.md`
  - `Dockerfile`, and the NOS-60 refusals it inherits (`src/proxy.ts`, `src/lib/deploy-config.ts`)
- **Out of scope:** the real-money production environment, which gets its own
  pipeline and its own threat model (D-5.2). Nothing here should be grown into it.
- **Status:** current, and **unexecuted**. See "What nobody has observed" below.

## Summary

The pipeline builds an image on a merge to `main`, plans database changes, stops
for the owner's approval when and only when there is something to apply, deploys
a revision with no traffic, checks that revision on its own URL, and promotes it.
It authenticates to Google with Workload Identity Federation, so there is no key
file to steal from a public repository.

Two findings were bypasses of the approval gate itself, which is the control this
whole segment exists to provide. Both are closed. Five residual risks are
accepted and recorded; three of them are inherent to deploying at all.

## Assets

| Asset | Why it matters |
|---|---|
| Ten secret values in Secret Manager | Database URL, auth secret, supplier key, webhook secret, three API keys, operations secret, site password, OAuth client secret |
| The shared test database | Real booking rows. A migration applied to the wrong one is the incident behind D-5.4 |
| The federated deploy identity | Can deploy an arbitrary image into the one service, and so can read everything the runtime identity reads |
| `UAT_DATABASE_URL` as a GitHub Actions secret | A direct database credential, reachable by workflow code |
| The owner's approval | The only thing standing between a merge and a schema change |

## Entry points

| Entry point | Who can reach it | Control |
|---|---|---|
| Merge to `main` | The owner only (branch protection, the owner merges) | Review, then this pipeline |
| `workflow_dispatch` | Anyone with write access | First step refuses any ref but `main` |
| OIDC token exchange | Any GitHub workflow in the world, before the attribute condition | `assertion.repository_id` and `assertion.job_workflow_ref` pinned to this file on `main` |
| The deployed service's URL | The public internet | Site password in `src/proxy.ts`; `/api/health` and the cron and webhook routes exempt by design |
| A per-revision tag URL | The public internet, if one is left behind | Removed after promotion |

## Threats, and what closes each

| # | Threat | Closed by |
|---|---|---|
| H2 | A dispatch from a branch reads that branch's migration journal, shows the owner an ordinary list, and applies it to the shared database before failing. **Two runbooks instructed exactly this.** | The workflow refuses any ref but `main`; both runbooks rewritten to explain why rather than to do it |
| H4 | Every deploy left a permanent, publicly addressable tag URL serving that commit with current secrets, including the password-exempt cron and webhook routes. Shipping a fix did not take the old one offline | `--remove-tags` after promotion |
| M4a | A migration tag containing a newline injects a line into `$GITHUB_OUTPUT`; a later `pending=0` wins. The owner sees a pending migration in the summary while the pipeline is told there are none, skips the approval, and logs "proceeding with no database changes" | `SAFE_TAG` validation, fail closed, plus a random delimiter per block |
| M4b | The same value reached a shell string in the summary step | `env:` plus `printf` |
| M2 | `assertion.ref == 'refs/heads/main'` reads like "reviewed and merged", but GitHub reports the default branch as the ref for `pull_request_target` and `workflow_run`, which a fork's pull request can trigger | `job_workflow_ref` and the numeric `repository_id` |
| M1 | `--to-latest` promotes whatever is newest, not the revision that was checked | `--to-revisions=<name>=100`, read back by name |
| M3 | Project-level grants carried delete rights on every service and every repository, including the ten images a rollback depends on | Both grants scoped in `infra/` to the one service and the one repository |
| M5 | `rotate-secrets.md` put every new value on a command line, so the runbook used *when a value leaks* wrote the replacement into shell history | `read -rsp`, then `--config` and `-H @<(...)` file descriptors |
| M6 | `always()` deployed a run the owner had cancelled | `!cancelled()` |
| M7 | A missing `problems` field read as "no fatal problems", the same shape as an unchecked expiry reading as "not expired" | Refuse any non-array; `EXPECT_SHA` required unless `--any-commit` |
| M8 | A deploy identity with no `actAs` on the runtime identity cannot deploy at all, and the first run would have failed after the approval was given | `google_service_account_iam_member`, `roles/iam.serviceAccountUser` |

A live supplier key is refused by the environment on every request (NOS-60) and
again by the thing that moves traffic (`deploy-smoke.mjs`). Neither should ever
be overridden; opening the live-money gate is a separate, reviewed segment.

## Accepted residual risk

| Risk | Why it is accepted |
|---|---|
| The deploy identity can read all ten secrets, transitively | Anything that can deploy an image running as the runtime identity can read what that identity reads. That is what deploying means. The control is the federated identity, not the role |
| `UAT_DATABASE_URL` is repository-scoped, so any workflow on any merged branch can read it | The approval environment protects the deploy job, not the credential. No other workflow needs it; if one ever does, move it into the `uat-database` environment first |
| Nothing enforces additive-only migrations | No check reads the SQL. A destructive migration would be planned, approved and applied like any other. The owner's approval is the only place it is caught, and `docs/runbooks/rollback.md` says so |
| An edited migration is invisible to the plan and the migrator | Pending work is decided by timestamp, never by content. The rule "never edit a merged migration" is the whole control |
| The site password has no rate limit and no lockout | NOS-62. A refusal is logged, which is the floor, not the fix |

## What has been observed, and what still has not

**Observed on 2026-10-07**, the first time any of this ran against Google Cloud:

- The account setup through Workload Identity Federation, including the attribute
  condition, which was read back and checked rather than assumed.
- `terraform apply`, which created 26 of its 28 resources and failed on two. Both
  failures were ordering and configuration defects in this repository, not in the
  threat model: a Cloud Run service cannot be created before its secret values
  exist, and the budget needs `user_project_override` on the provider. Fixed.
- **The gate refusing a deploy**, which is the one behaviour most worth seeing.
  Merging the pipeline to `main` ran it with no credentials: the plan failed, the
  migration was skipped, and the deploy **refused**, because a skipped migration
  is not evidence that there was nothing to apply. No image was built and no
  traffic moved.

**Still not observed**, and therefore still assumption: that `--no-traffic --tag`
creates an addressable target and `--remove-tags` removes it, that
`gcloud run deploy --image` preserves secret references, that drizzle records
`folderMillis` in `created_at` the way its source says, and that a rollback holds
until the next merge rolls it forward. `docs/runbooks/rollback.md` flags its own
unverified claim. The first green deploy is the test of all of these.

The one thing measured on this account (2026-10-07): four scale-to-zero Cloud Run
services cost $0.0007 for a month, and container image storage was the entire
bill. That is why the image cleanup policy is a requirement here and not a
tidy-up.

## Reporting

Suspected vulnerabilities go through private vulnerability reporting
(`SECURITY.md`), never a public issue or pull request description. The findings
above marked H2, H4, M2 and M4 were fixed before this document or any pull
request existed, which is why they can be described here at all.
