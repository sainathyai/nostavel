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
```

**Only `main` deploys, and the workflow refuses anything else.** Not a
convenience limit: the deploy reads the migration journal from the ref it runs
on, so a run from a branch would ask you to approve that branch's migrations and
apply them to the shared database. To ship a particular commit, get it onto
`main`.

**No deploy possible because the database is unreachable?** The plan job asks the
database what is applied, so a Neon outage blocks every deploy - including a
code-only fix, which is when you most want one. There is deliberately no
automated way round it. By hand, asserting that the change needs no schema
change:

```bash
gcloud run deploy nostavel-uat --project=nostavel --region=us-central1   --image=us-central1-docker.pkg.dev/nostavel/nostavel/app:FULL_COMMIT_SHA
```

Check that assertion before running it, and note it on the ticket afterwards:
the pipeline has no record of a deploy it did not make.

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

**You rolled back by hand, and the next merge undid it.** Expected, and worth
knowing before it surprises you: every successful deploy ends with
`update-traffic --to-latest`, which un-pins traffic and points it at the newest
revision. So a manual rollback holds only until the next deploy. If you need it
to stick, revert the commit on `main` as well - the rollback buys time, the
revert is the fix. See `rollback.md`.

**"refusing to deploy ... the approval was never given".** The migration job was
skipped while migrations were pending. Re-run the deploy and approve it.

**A run is waiting for approval and nothing else can deploy.** Raised by the
NOS-61 devops review, and it is the real cost of running one deploy at a time:
only one deploy runs at a time, and a job waiting on an approval has not started,
so its timeout has not started either. An unanswered approval therefore holds the
queue indefinitely - including a one-line hotfix with no migration in it.

Two ways out:

```bash
# 1. Deal with it: approve or reject on the run page. Rejecting is safe and
#    applies nothing.
gh run list --workflow=deploy-uat.yml --repo sainathyai/nostavel --limit 3

# 2. Release the queue without approving a migration you have not read.
gh run cancel RUN_ID --repo sainathyai/nostavel
```

Cancelling is safe by design: the next deploy's gate sees a cancelled migration
job and refuses rather than deploying code against an un-migrated database. The
migration is still pending, so the next run will ask again.

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
- **It does not change the environment's shape across the project.** The deploy
  identity holds `run.developer` on this one service and `artifactregistry.writer`
  on this one repository, and nothing else - no other service, no other
  repository, no IAM. Within this service it CAN change the revision template,
  and anything able to deploy an image can read what the runtime identity reads,
  which is every secret here. That is inherent to deploying; `infra/README.md`
  says so plainly rather than claiming otherwise.
