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

## When the approval is for a constraint, check before you approve

Most migrations add a table or a column, and the approval is the formality above:
read the summary, approve. A migration that adds a **constraint to a table that
already holds rows** is the one case where approving is a decision, because
whether it can succeed depends on what is in the database at that moment and
nothing in the run can ask. The first was NOS-16's unique index on
`cancellations.booking_id`. It will not be the last.

1. **Find out whether this is one of those.** The run summary names every
   migration it will apply. For each name, on `main`:

   ```bash
   grep -nEi 'create unique index|add constraint|set not null|alter column' src/db/migrations/0006_colorful_starfox.sql
   ```

   - **Nothing printed** - nothing to pre-check. Approve as normal.
   - **A line printed** - go to step 2.

   A `CREATE TABLE` full of `NOT NULL` and a `PRIMARY KEY` is **not** a
   constraint migration: the table is new and empty, so no existing row can
   violate it. Migration `0007` is exactly that shape and the grep above is
   silent on it, which is the point of matching those four phrases rather than
   the words `unique` or `constraint`.

   The pull request is also required to say what the constraint is and what the
   running code does about it (`.agents/rules/database.md`). If it says nothing,
   reject and ask rather than reading the SQL yourself.

2. **Ask the environment's own database whether the violating rows exist.** For a
   unique index, that is a `group by ... having count(*) > 1` on the column being
   made unique:

   ```bash
   export PROJECT=nostavel SERVICE=nostavel-uat
   U=$(gcloud secrets versions access latest --secret="${SERVICE}-DATABASE_URL" --project="$PROJECT")
   DATABASE_URL="$U" node -e "
   import('@neondatabase/serverless').then(async ({ neon }) => {
     const sql = neon(process.env.DATABASE_URL);
     console.log(JSON.stringify(await sql.query(
       \"select booking_id, count(*)::int as n from cancellations group by booking_id having count(*) > 1\")));
   });"
   ```

   - **Healthy: `[]`.** Nothing else is a pass, including two rows that look like
     test data.
   - **Any rows: step 4.**

   **Run it immediately before you click approve, not when the pull request
   opened.** A guest cancelling a booking can create the duplicate in between,
   and the approval is the only moment the answer is still true.

3. **Run the same query against development too.** The same migration has to
   apply there eventually, and any new Neon branch is a copy of its parent, so
   development's duplicates become the next environment's duplicates:

   ```bash
   node -e "
   process.loadEnvFile('.env.local');
   import('@neondatabase/serverless').then(async ({ neon }) => {
     const sql = neon(process.env.DATABASE_URL);
     console.log(JSON.stringify(await sql.query(
       \"select booking_id, count(*)::int as n from cancellations group by booking_id having count(*) > 1\")));
   });"
   ```

   Rows here do not block the approval, because this is not the database being
   migrated. They do mean `npm run db:migrate` will fail on your machine next,
   so say so on the ticket.

4. **If either query returned rows: reject, and leave the rows alone.** Reject on
   the run page and say what the query returned. **Do not `DELETE` the
   duplicates.** The losing row holds a number somebody computed - in the NOS-16
   case, a refund amount read from the supplier - and deleting it loses that
   silently, which is the exact harm the constraint exists to prevent. The fix is
   a repair migration that keeps one row per key and records the others as
   `booking_events`, written and reviewed like any other change.

**Approving without checking is not a catastrophe**, and it is worth knowing
which way it fails so the choice is informed rather than feared: the
`CREATE UNIQUE INDEX` is refused by Postgres, the apply step fails, the deploy
stops, and traffic never moves because a new revision starts with none. You end
up at step 4 anyway, with a red run and no damage. The check exists to save the
run, not to save the database.

### What the live copy does between the apply and the traffic switch

In that window the revision serving visitors is the **old** one, written before
the constraint existed. If it tries to write a row the new index refuses, that
write fails instead of succeeding. Its whole `db.batch` rolls back (NOS-7), so
there is no half-written record, the caller sees an error, and a retry after the
traffic switch is handled by the new code's conflict branch.

Short window, and it fails in the safe direction. But it is a real behaviour
change to code that is already running, which is why this approval is read
rather than waved through.

**Rehearsed:** steps 1 and 3 run for real on 2026-10-26 (the grep discriminates
`0006` from `0007`; the development query returns `[]`). Step 2 is the same query
through the connection string that `bootstrap-uat.md` step 7 and
`rotate-secrets.md` already use, and has not been run against `uat` by anyone but
the owner.

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
