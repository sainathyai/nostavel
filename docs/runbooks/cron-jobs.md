# Runbook: the money-safety jobs have stopped

Written to be followed at 2am without reading any code.

**What is at stake.** The **sweeper** is the only automatic rescue for a guest who
was charged and whose browser never came back. While it is not running, that
rescue is not happening, and a guest who paid can end up with no booking and
nobody alerted. The **reconciler** is the only automatic comparison of our ledger
against the supplier's. The sweeper is the urgent one.

**You do not need a secret for anything in this runbook.** Every command uses your
own Google account.

---

## 1. Run the job by hand, first

Do this before diagnosing anything. It takes one command and it is the thing that
helps a guest.

```
gcloud scheduler jobs run nostavel-uat-sweep --location us-central1
gcloud scheduler jobs run nostavel-uat-reconcile --location us-central1
```

Then confirm it actually ran, rather than trusting the command's silence:

```
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="cron.sweep.authorized"' \
  --limit 5 --format 'value(timestamp, jsonPayload.via)'
```

- A line with `via=oidc` means Cloud Scheduler's identity worked.
- A line with `via=shared-secret` means it was authorised by the legacy secret,
  which is what GitHub's `workflow_dispatch` uses. If you ran the `gcloud` command
  above and see this, something is routing through the old path.
- **No line at all** means the job did not reach the route. Go to section 3.

---

## 2. Is it actually stopped, or did one tick get missed?

The sweeper should appear every 5 minutes, the reconciler once a night.

```
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="cron.sweep.authorized"' \
  --freshness 2h --limit 50 --format 'value(timestamp)'
```

Count them. Two hours should hold about 24. If you see a handful, the job is being
dropped rather than stopped, and that is the failure this whole ticket was about:
**do not** conclude it is fine because some runs are present. The old GitHub
trigger delivered 1.6 percent of its runs and reported success every time.

---

## 3. The job runs but nothing arrives: the three causes, in order

The route's 401 names which check failed. **Read it before changing anything.**

```
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="cron.sweep.unauthorized"' \
  --limit 5 --format 'value(timestamp, jsonPayload.reason)'
```

| What the reason says | What it means | What to do |
|---|---|---|
| `sub is not the expected caller` | The service's `CRON_SWEEP_INVOKER_SUB` does not match the invoker account's real id | Section 4 |
| `aud is not this route` | Scheduler's audience and the app's `APP_URL` disagree | Section 5 |
| `identity is not configured` | One of the two env vars is missing on the service | Section 4 |
| `token signature or required claims rejected` | Either Google's key server was unreachable, or the token lacks `exp`, `iat` or `sub` | Retry once; if it persists, section 6 |
| `credential not accepted` | Something reached the route with a non-token credential | Not Scheduler. Check who is calling |

**If you see no `cron.sweep.unauthorized` line either,** the request never reached
the route. Look for the proxy refusing it first:

```
gcloud logging read 'resource.type="cloud_run_revision" AND textPayload:"[gate] refused"' \
  --limit 5 --format 'value(timestamp, textPayload)'
```

A `[gate] refused` line means the password gate answered before the route did.
The usual cause is a job URL with a **trailing slash** or the wrong host. Fix the
job URL. Knowing which of these two log lines you are looking at is the whole
diagnosis.

---

## 4. The identity does not match

Print what the invoker account actually is:

```
gcloud iam service-accounts describe \
  nostavel-uat-sweep-inv@<project>.iam.gserviceaccount.com \
  --format 'value(uniqueId, email)'
```

Compare against what the service believes:

```
gcloud run services describe nostavel-uat --region us-central1 \
  --format 'value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep CRON_
```

If they differ, re-apply the infrastructure: these values come from Terraform
outputs, so they drift only if an apply was partial.

**A partial configuration does not take the environment down**, deliberately: the
app warns rather than refusing, because a 503 over a cron misconfiguration trades
a dead job for a dead site. The warning is visible here:

```
curl -u "<the environment password>" "https://<the app url>/api/health?deep=1"
```

Look for `cron-sweep-invoker-partial` or `cron-sweep-invoker-missing` in the
problem list. While either is present, that job is running only from the shared
secret, which any GitHub workflow on any merged branch can read.

---

## 5. The audience disagrees

Scheduler's audience must equal exactly `<APP_URL>/api/cron/<job>`, with no
trailing slash. Both sides derive from the same Terraform variable, so a mismatch
means `app_url` changed without an apply, or the job was edited by hand.

```
gcloud scheduler jobs describe nostavel-uat-sweep --location us-central1 \
  --format 'value(httpTarget.uri, httpTarget.oidcToken.audience)'
```

---

## 6. Last resort: the jobs are not the problem

GitHub's `workflow_dispatch` triggers still exist and still work, using the shared
secret. Use them to rescue guests while you fix the scheduler:

**Actions → cron-sweep → Run workflow.**

Do not delete the Scheduler jobs to "clean up". Until the five preconditions on
NOS-65 are met, both paths are deliberately present, and the GitHub `schedule:`
blocks are kept precisely so that removing a broken trigger cannot leave none.

---

## What to write down afterwards

Add what you found to NOS-65 as a comment, even if the fix was obvious. The reason
this runbook exists at all is that the previous trigger failed silently for its
entire life while reporting success, and nobody wrote down that nobody had checked.
