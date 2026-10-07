# Runbook: put the previous version back

**Use this when the test environment is broken and you want it working again
now.** It needs no build, no merge, and no knowledge of what went wrong.

Cloud Run keeps every revision that has ever been deployed. Rolling back means
pointing traffic at an earlier one. Nothing is rebuilt and nothing is deleted, so
this is reversible in both directions.

```bash
export PROJECT=nostavel REGION=us-central1 SERVICE=nostavel-uat
```

## 1. See what is there

```bash
gcloud run revisions list --project="$PROJECT" --region="$REGION" --service="$SERVICE" \
  --format="table(metadata.name,metadata.creationTimestamp.date('%Y-%m-%d %H:%M'),spec.containers[0].image)"
```

The newest is at the top. The one you want is usually the second.

## 2. Send traffic to it

```bash
gcloud run services update-traffic "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --to-revisions=REVISION_NAME=100
```

That takes effect in seconds.

## 3. Check it took

```bash
curl -s "$(gcloud run services describe "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --format='value(status.url)')/api/health"
```

The `sha` in the answer is the commit now serving. If it is not the one you
expected, traffic went somewhere else: check the revision name in step 2.

## What this does NOT fix

**A database change is not rolled back by this.** Migrations in this repository
are additive only (`docs/conventions.md`), which is exactly what makes a code
rollback safe: the older code keeps working against a wider schema, because
nothing it reads has been removed or renamed. So roll the code back freely and
leave the database alone.

If a migration itself is the problem, that is not a rollback, it is a new
migration. Write one that undoes what the bad one did and let the pipeline apply
it with the usual approval. Do **not** hand-edit the test environment's database:
the incident behind decision D-5.4 was a migration run by hand against the wrong
database.

## When traffic is stuck on an old revision

The pipeline deploys with `--to-latest`, so an ordinary deploy moves traffic back
on its own. But a rollback done with `--to-revisions` **pins** traffic, and a
later deploy then starts a new revision that receives nothing. The symptom is a
green deploy where `/api/health` keeps reporting the old commit.

Unpin it:

```bash
gcloud run services update-traffic "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --to-latest
```

`terraform apply` will neither fix this nor undo it: `infra/` ignores the traffic
split on purpose, precisely so an apply cannot undo a rollback someone did during
an incident.

## If a rollback target will not start

Its image may have been deleted. The repository keeps the last ten
(`infra/envs/uat/main.tf`), so this only happens for a revision older than that.
There is no recovering the image. Deploy forward from a known-good commit
instead:

```bash
gh workflow run deploy-uat.yml --repo sainathyai/nostavel --ref COMMIT_OR_BRANCH
```
