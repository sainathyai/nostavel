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

## A rollback is temporary. Know this before it surprises you.

Both a rollback and a deploy **pin** traffic to a named revision: the pipeline
promotes exactly the revision it just checked, rather than "whatever is newest"
(tightened by the NOS-61 security review, so a revision nothing looked at can
never receive traffic).

So **the next merge to `main` rolls you forward again**, automatically, whether
or not the thing you rolled back from has been fixed. That is usually what you
want - it stops a rollback quietly becoming a permanent state everyone forgets
about - but it means a rollback buys time, it does not fix anything.

**If the broken change must stay out, revert it on `main`.** Then the next deploy
carries the reverted code and the two agree.

An earlier version of this runbook warned instead about traffic being stranded on
an old revision after a green deploy. That was wrong, and the review said so:
nothing strands it, because every deploy names the revision it promotes. Nobody
has executed either behaviour against real Cloud Run, so **check it on your first
rollback.**

To hand traffic back to whatever is newest, without deploying:

```bash
gcloud run services update-traffic "$SERVICE"   --project="$PROJECT" --region="$REGION" --to-latest
```

`terraform apply` will neither pin nor un-pin: `infra/` ignores the traffic split
on purpose, precisely so an apply cannot undo a rollback someone did during an
incident.

## If a rollback target will not start

Its image may have been deleted. The repository keeps the last ten
(`infra/envs/uat/main.tf`), so this only happens for a revision older than that.
There is no recovering the image. Deploy forward instead, from `main`:

```bash
git revert <the bad commit>   # then open a PR and merge it
```

**Do not reach for `gh workflow run --ref <branch>`.** It is refused: the deploy
reads the migration journal from whatever ref it runs on, so a run from a branch
would ask you to approve that branch's migrations - showing a perfectly ordinary
list - and apply them to the shared database before failing. The workflow now
stops on any ref but `main`, and an earlier version of this runbook told you to
do exactly that (NOS-61 security review). `--ref` with a commit SHA never worked
either: the dispatch API takes a branch or tag only.
