# Runbook: the money-safety jobs have stopped

Written to be followed at 2am without reading any code.

**What is at stake.** The **sweeper** is the only automatic rescue for a guest who
was charged and whose browser never came back. While it is not running, that
rescue is not happening, and a guest who paid can end up with no booking and
nobody alerted. The **reconciler** is the only automatic comparison of our ledger
against the supplier's. The sweeper is the urgent one.

**Most of this needs no secret.** Running the jobs, reading logs and inspecting
configuration all use your own Google account. One optional check in section 4
reads `/api/health?deep=1`, which needs the operations secret; it is marked, and a
secret-free alternative sits beside it.

---

## 0. The first apply, once

Terraform here is applied **by hand** (D-5.5): the delivery pipeline plans and
applies database changes only, never infrastructure. So these steps are a person's,
and they are in this order for a reason.

1. `alert_email` must be set in the untracked `infra/envs/uat/terraform.tfvars`.
   Use a personal address. A Google Group silently drops alerting mail unless it is
   configured to accept it from `alerting-noreply@google.com`, and an alarm nobody
   receives is this runbook's whole subject.
2. `terraform apply`. It enables three APIs, creates two role-less invoker
   identities, two Scheduler jobs, two log-based metrics and three alert policies.
3. **Promote traffic.** The apply creates a revision with **zero traffic**, so the
   four `CRON_*_INVOKER_*` values are on the template and not on the copy serving
   requests. This is measured, not theoretical: see section 4.
   ```
   gcloud run services update-traffic nostavel-uat --region us-central1 --to-latest
   ```
4. Confirm the serving revision actually has them, using section 4's commands. Not
   the template.
5. **Watch the first invocation**, within 5 minutes. Section 1 tells you whether it
   completed and which credential authorised it. If it 401s, section 3's table maps
   each reason to one action.
6. **Prove the alarm**, because an unfired alert is an untested alert:
   - disable the GitHub `cron-sweep` workflow, so the metric cannot be fed from the
     old trigger;
   - `gcloud scheduler jobs pause nostavel-uat-sweep --location us-central1`;
   - wait ~25 minutes and confirm the email arrives;
   - resume the job and re-enable the workflow, and confirm the alert clears.
7. **Watch one deploy afterwards** and confirm no spurious "has stopped running"
   arrives 20 minutes later. The alert is grouped across revisions so that a
   retired revision going quiet is not reported as a stopped job, and that grouping
   has not been observed working.

Only when 5, 6 and 7 have all been seen should the `schedule:` blocks come out of
`cron-sweep.yml` and `cron-reconcile.yml`. Removing a broken trigger before its
replacement is proven leaves none.

---

## 1. Run the job by hand, first

Do this before diagnosing anything. One command, and it is the thing that helps a
guest.

```
gcloud scheduler jobs run nostavel-uat-sweep --location us-central1
gcloud scheduler jobs run nostavel-uat-reconcile --location us-central1
```

Then confirm it actually ran, rather than trusting the command's silence:

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="nostavel-uat" AND jsonPayload.event="cron.sweep.completed"' --freshness 15m --limit 5 --format 'value(timestamp, jsonPayload.via, jsonPayload.holdsExpired, jsonPayload.recovered)'
```

Note **`completed`**, not `authorized`. The authorised line is written before any
row is read, so it proves the credential worked and nothing more: a job that
authenticates and then fails on its first database query writes `authorized` every
single time while rescuing nobody.

- A `completed` line with `via=oidc` means Cloud Scheduler's identity worked and
  the pass finished. This is the only line that means the job is doing its job.
- `via=shared-secret` means the legacy path authorised it, which is what GitHub's
  `workflow_dispatch` uses. If you ran the `gcloud` command above and see this,
  something is routing through the old path.
- An `authorized` line with **no** matching `completed` line means the pass started
  and died. Find the error:
  ```
  gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' --freshness 15m --limit 5
  ```
- **No line at all** means the job never reached the route. Go to section 3.

---

## 2. Is it actually stopped, or did one tick get missed?

The sweeper should appear every 5 minutes, the reconciler once a night.

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="nostavel-uat" AND jsonPayload.event="cron.sweep.completed"' --freshness 2h --limit 50 --format 'value(timestamp)'
```

Count them. Two hours should hold about 24. If you see a handful, the job is being
**dropped rather than stopped**, and that is the failure this whole ticket was
about: do not conclude it is fine because some runs are present. The old GitHub
trigger delivered 1.6 percent of its runs and reported success every time.

---

## 3. The job runs but nothing arrives: the causes, in order

The route's 401 names which check failed. **Read it before changing anything.**

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="nostavel-uat" AND jsonPayload.event="cron.sweep.unauthorized"' --freshness 30m --limit 5 --format 'value(timestamp, jsonPayload.reason)'
```

| Reason | What it means | What to do |
|---|---|---|
| `identity is not configured` | One of the two invoker env vars is missing on the serving revision | Section 4 |
| `sub is not the expected caller` | `CRON_*_INVOKER_SUB` does not match the invoker account's real id | Section 4 |
| `email is not the expected caller` | The token came from a different service account | Section 4 |
| `email_verified is not true` | A token carrying an unverified email. Should not happen for a service account | Section 4 |
| `aud is not this route` | Scheduler's audience and the app's `APP_URL` disagree | Section 5 |
| `iss is not Google` / `iss is missing or not a string` | Not a Google-issued token. Something other than Scheduler is calling | Find the caller |
| `token has expired` | Usually **container clock skew**, not a stale token: Scheduler mints a fresh one per attempt | Section 6, then redeploy to get a new container |
| `token was issued in the future` | The same clock skew, in the other direction | As above |
| `token expires before it was issued` | A malformed token. Not Scheduler | Find the caller |
| `exp is missing or not a finite number` | A token with no expiry. Not Scheduler | Find the caller |
| `token signature or required claims rejected` | Google's key server was unreachable, or the token lacks `exp`, `iat` or `sub` | Retry once; if it persists, section 6 |
| `no authorization header` | Something reached the route with no credential at all | Not Scheduler |
| `credential not accepted` | A non-token credential that is not the shared secret | Find the caller |

**If you see no `cron.sweep.unauthorized` line either,** the request never reached
the route, and the app cannot tell you why because it never saw it. Read **Cloud
Scheduler's own log**, which is the only place this appears:

```
gcloud logging read 'resource.type="cloud_scheduler_job"' --freshness 30m --limit 10 --format 'value(timestamp, severity, httpRequest.status)'
```

| What Scheduler recorded | What it means |
|---|---|
| **308** | The job URL has a **trailing slash**. Measured 2026-10-14: Next redirects it before anything in the app runs, so nothing appears in our logs at all. Remove the slash |
| **401** with no app log line | A host mismatch, so the request went somewhere else entirely. Check the job URI against `APP_URL` |
| **403** on every job at once | The Cloud Scheduler service agent has lost `roles/cloudscheduler.serviceAgent`. That is a project-level grant made when the API was enabled, not something in our Terraform |
| **5xx** | The app is up but failing. Use section 1's error query |
| Nothing at all | The job is paused or missing: `gcloud scheduler jobs describe nostavel-uat-sweep --location us-central1` |

A password-gate refusal is **not** a likely cause here. The two cron paths are
exempt from the gate by exact match, and the one spelling that would miss that
list, a trailing slash, never reaches the gate because Next redirects it first.

---

## 4. The identity does not match

What the invoker account actually is:

```
gcloud iam service-accounts describe nostavel-uat-sweep-inv@PROJECT.iam.gserviceaccount.com --format 'value(uniqueId, email)'
```

Now compare against what the **revision actually serving traffic** believes. This
is the step that matters, and the obvious command is the wrong one:

```
# WRONG: prints the latest template, which may be serving nothing.
#   gcloud run services describe nostavel-uat --format 'value(spec.template...)'

# RIGHT: find the revision serving traffic, then read ITS environment.
REV=$(gcloud run services describe nostavel-uat --region us-central1 --format 'value(status.traffic[0].revisionName)')
echo "serving: $REV"
gcloud run revisions describe "$REV" --region us-central1 --format 'value(spec.containers[0].env)' | tr ',' '\n' | grep CRON_
```

**Why that distinction is the whole section.** A `terraform apply` creates a new
revision with **zero traffic**, because the pipeline owns the traffic split and the
infrastructure config ignores it on purpose so that an apply cannot undo a
rollback. That is measured, and it is written into
[deploy.md](../../.agents/rules/deploy.md) (2026-10-11: it is how a correct
`AUTH_URL` fix reached nobody). So after an apply that changes these values, the
template has them and the serving revision does not.

If the serving revision is missing them, **do not re-apply.** The apply already
succeeded and did nothing visible. Promote traffic instead:

```
gcloud run services update-traffic nostavel-uat --region us-central1 --to-latest
```

**A partial configuration does not take the environment down**, deliberately: the
app warns rather than refusing, because a 503 over a cron misconfiguration trades a
dead job for a dead site. The codes are `cron-sweep-invoker-partial` or
`-missing`, and the reconcile equivalents. While either is present, that job runs
only from the shared secret, which any GitHub workflow on any merged branch can
read.

**Secret-free way to see them:** the deploy smoke step prints the warning codes as
a non-blocking line. Open the most recent `deploy-uat` run in Actions and read the
smoke output.

**With the operations secret**, if you have it to hand:

```
curl -H "Authorization: Bearer $CRON_SECRET" "https://THE-APP-URL/api/health?deep=1"
```

Note the header. `?deep=1` is gated on the **operations secret**, not on the
environment password, and `/api/health` itself is not behind the password at all,
so `curl -u` does not apply. (`curl -u "password"` would send the password as a
*username* in any case.)

---

## 5. The audience disagrees

Scheduler's audience must equal exactly `APP_URL` + `/api/cron/<job>`, with no
trailing slash. Both sides derive from the same Terraform variable, so a mismatch
means `app_url` changed without an apply, or the job was edited by hand.

```
gcloud scheduler jobs describe nostavel-uat-sweep --location us-central1 --format 'value(httpTarget.uri, httpTarget.oidcToken.audience)'
```

---

## 6. Last resort: keep rescuing guests while you fix it

GitHub's `workflow_dispatch` triggers still exist and still work, using the shared
secret:

**Actions → cron-sweep → Run workflow.**

Do not delete the Scheduler jobs to "clean up". Until the preconditions on NOS-65
are met both paths are deliberately present, and the GitHub `schedule:` blocks are
kept precisely so that removing a broken trigger cannot leave none.

**One thing to know about the alarms while you are here.** The sweep alarm only
counts passes authorised by Cloud Scheduler (`via=oidc`), so running the GitHub
workflow will **not** clear it. That is deliberate: otherwise a dead Scheduler job
could be masked by the trigger it was meant to replace. And both alarms arm only
after the metric has seen one matching pass since the policy was created, so
silence on the day of a fresh apply is not evidence of health.

---

## What to write down afterwards

Add what you found to NOS-65 as a comment, even if the fix was obvious. The reason
this runbook exists is that the previous trigger failed silently for its entire
life while reporting success, and nobody wrote down that nobody had checked.
