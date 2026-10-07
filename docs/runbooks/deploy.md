# Runbook: how a change reaches the test environment

Normally: **you merge, and that is all.** This exists for the times it does not
go that way.

## What happens on a merge to `main`

| Step | What it does | If it fails |
|---|---|---|
| 1. Plan | Asks the database which migrations are not yet applied | The deploy stops. Nothing is built or applied |
| 2. Approve | **Only if there is a migration.** The run waits for you, having listed exactly what it will apply | Nothing is applied, and the deploy stops rather than running new code against an old schema |
| 3. Apply | Runs those migrations against this environment's own database | The deploy stops; traffic is untouched |
| 4. Build | Builds the image, tagged with the commit | - |
| 5. Start | Starts the new copy with **no traffic**, on its own URL | Visitors keep being served the old copy |
| 6. Check | Asks the new copy whether it is healthy, on the sandbox, reaching its database, and running the commit just built | **No traffic moves.** The old copy keeps serving |
| 7. Promote | Moves traffic, then checks the live URL too | See `rollback.md` |

The point of steps 5 and 6: a broken build never becomes the live one.

## The approval

You get a notification on the run. Open it, read the **run summary** (it lists
every migration by name and when it was generated), then approve or reject the
`uat-database` environment.

**Rejecting is safe.** Nothing is applied and nothing is deployed. The code stays
on `main`, and the next run offers the same approval again.

You are only asked when there is something to apply. A merge with no migration in
it never stops.

## Watching a run

```bash
gh run watch --repo sainathyai/nostavel
gh run list --workflow=deploy-uat.yml --repo sainathyai/nostavel --limit 5
```

## Deploying without a merge

```bash
gh workflow run deploy-uat.yml --repo sainathyai/nostavel
gh workflow run deploy-uat.yml --repo sainathyai/nostavel --ref COMMIT
```

## When something looks wrong

**"Refusing to continue rather than checking an empty URL."** The new revision
started but Cloud Run reported no URL for its tag. Re-run the deploy; if it
repeats, the service is in a bad state and `rollback.md` applies.

**"the supplier key is ... not sandbox".** Someone put a live LiteAPI key in
Secret Manager. The environment is already refusing every request by itself, and
the pipeline is refusing to send traffic to it. Replace the secret
(`rotate-secrets.md`) and re-run. Do not override this.

**"this copy says it is ... but the deploy is for uat".** `APP_ENV` is missing or
wrong on the service. The image defaults to refusing for exactly this reason. Fix
it with `terraform apply` in `infra/envs/uat`, which sets it.

**"the detailed health route did not return an object".** Almost always
`CRON_SECRET` in GitHub not matching the one in Secret Manager. They are two
copies of one value: see `bootstrap-uat.md` step 9.

**The deploy is green but `/api/health` reports the old commit.** Traffic is
pinned to an old revision by a previous rollback. See the end of `rollback.md`.

**"refusing to deploy ... the approval was never given".** The migration job was
skipped while migrations were pending. Re-run the deploy and approve it.

**The deploy says nothing is pending, but you wrote a migration.** The plan reads
`src/db/migrations/meta/_journal.json`. A migration file added without running
`npm run db:generate` is not in the journal, so nothing will apply it.

## What this pipeline deliberately does not do

- **It does not deploy a pull request.** This repository is public; a fork's pull
  request must never receive a deployment credential.
- **It does not deploy anything real.** There is one environment and it runs on
  the supplier's sandbox. A production environment gets its own separate pipeline
  (decision D-5.2), designed when the live-money gate is ready to be considered.
- **It does not roll the database back.** See `rollback.md`.
- **It does not change the environment's shape** - who it runs as, what it may
  read, how far it scales. That is `infra/`, applied by hand. The deploy identity
  cannot do it even if asked.
