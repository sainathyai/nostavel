# Runbook: change a secret in the test environment

Do this when a value leaks, when a key is rotated at its source, or when you
simply want to change the site password.

```bash
export PROJECT=nostavel SERVICE=nostavel-uat REGION=us-central1
```

## The ordinary case: one value

Secret Manager keeps versions and the service reads `latest`, so adding a version
is the change. The old version stays available until you disable it.

```bash
# READ, NEVER TYPED ON THE COMMAND LINE. An earlier version of this runbook put
# the new value straight into the command - so rotating a LEAKED secret wrote its
# replacement into ~/.bash_history, moving the exposure rather than ending it.
# Raised by the NOS-61 security review; the bootstrap runbook always did this
# correctly and this one had regressed.
read -rsp "new ACCESS_PASSWORD: " VALUE; echo
printf '%s' "$VALUE" | \
  gcloud secrets versions add "${SERVICE}-ACCESS_PASSWORD" --project="$PROJECT" --data-file=-
```

`printf` rather than `echo`: `echo` appends a newline, and a newline inside a
password or a bearer token is the kind of thing that costs an afternoon. The app
trims the access password for exactly this reason, but not every value is
trimmed.

**A running container does not pick this up.** Secrets are read when an instance
starts, so existing instances keep the old value until they are replaced. Force
that:

```bash
gcloud run services update "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --update-labels="secret-rotated-at=$(date +%s)"
```

That starts a new revision with the same image, which reads the new value.
Check it:

```bash
# The credential goes in a file, never in an argument: an argument is visible
# in the process table to every other process on the box. PROCESS SUBSTITUTION
# (`--config <(...)`) DOES NOT WORK HERE - curl on Windows cannot open a
# /dev/fd path and fails with "error encountered when reading a file".
# Measured 2026-10-10, on the command this runbook used to prescribe.
CFG="$(mktemp)"
printf 'user = "owner:%s"\n' "$VALUE" > "$CFG"
curl -s --config "$CFG" -o /dev/null -w '%{http_code}\n' "https://THE_SERVICE_URL/"
rm -f "$CFG"
# 200
```

Then disable the old version, once you are satisfied:

```bash
gcloud secrets versions list "${SERVICE}-ACCESS_PASSWORD" --project="$PROJECT"
gcloud secrets versions disable OLD_VERSION \
  --secret="${SERVICE}-ACCESS_PASSWORD" --project="$PROJECT"
```

Disable rather than destroy until the next deploy is green. A destroyed version
cannot be brought back, and a wrong new value plus a destroyed old one means
setting a third before anything works.

## The two values that exist in two places

Changing one copy alone breaks something quietly.

| Secret | Second home | What breaks if they drift |
|---|---|---|
| `CRON_SECRET` | GitHub Actions secret of the same name | The deploy's health check fails with "the detailed health route did not return an object", and the sweeper and reconciler answer 401 - which silently switches off guest-money recovery |
| `DATABASE_URL` | GitHub Actions secret `UAT_DATABASE_URL` | The pipeline plans and applies migrations against a different database than the app reads. **They are not the same string:** the app gets Neon's POOLED host, the pipeline gets the DIRECT one (the same URL with `-pooler` removed), because `drizzle-kit migrate` connects over TCP and runs every pending migration in one transaction |
| `APP_URL` (not secret, but it drifts the same way) | Terraform `app_url`, the GitHub `APP_URL` variable, and the Google OAuth redirect URI | Dead links in guest email, a scheduled job calling nothing, and sign-in failing - all three silent |

Change both in the same sitting:

```bash
read -rsp "new CRON_SECRET: " VALUE; echo
printf '%s' "$VALUE" | \
  gcloud secrets versions add "${SERVICE}-CRON_SECRET" --project="$PROJECT" --data-file=-
# gh prompts for the value, so nothing reaches history here either.
gh secret set CRON_SECRET --repo sainathyai/nostavel
unset VALUE
```

## Resetting the database password invalidates BOTH copies

Neon's "reset password" changes the role's password, so every connection string
holding the old one stops working at once - the app's and the pipeline's. The
first symptom is a deploy failing in the plan job with `password authentication
failed for user 'neondb_owner'`, which reads like a pipeline fault rather than
something you did in another tab twenty minutes earlier. Seen on the first real
deploy, 2026-10-10.

Both copies, from one new value:

```bash
# Neon console -> branch `uat` -> Roles -> reset -> copy the POOLED string
bash scripts/seed-uat-secrets.sh DATABASE_URL

U=$(gcloud secrets versions access latest --secret="${SERVICE}-DATABASE_URL" --project="$PROJECT")
printf '%s' "${U/-pooler/}" | gh secret set UAT_DATABASE_URL --repo sainathyai/nostavel
unset U
```

### Prove both are live before spending a deploy on it

A deploy is a slow way to find out a credential is wrong, and the failure lands
in the job that reports what is pending - so it looks like the plan is broken.

```bash
U=$(gcloud secrets versions access latest --secret="${SERVICE}-DATABASE_URL" --project="$PROJECT")
for V in "$U" "${U/-pooler/}"; do
  DATABASE_URL="$V" node -e "
  import('@neondatabase/serverless').then(async ({ neon }) => {
    try { await neon(process.env.DATABASE_URL).query('select 1'); console.log('OK'); }
    catch (e) { console.log('FAILED -', e.message); }
  });"
done
unset U
```

Two `OK` lines. Both failing means the password was reset and neither copy was
updated. One failing means only that copy is wrong - and if it is the unpooled
one, take the direct string from Neon's console rather than deriving it.

## The supplier key

It must start with `sand_`. The app refuses to serve a single request with
anything else, and the pipeline refuses to promote a revision holding one. Both
are deliberate and neither should be overridden. Moving to a live key is the
live-money gate, which is a separate segment and a reviewed change, not a secret
rotation.

## If you lock yourself out

Getting the site password wrong locks you out of very little:

- `/api/health` is not behind it, so you can still see whether the copy is alive.
- The scheduled jobs are not behind it, so guest-money recovery keeps working.
- Secret Manager and Cloud Run are reached with your Google login, not the site
  password.

So add a new version and restart the service, as above.

## After any rotation

Confirm the environment still reports itself healthy, which also proves the new
value was actually readable by the service:

```bash
read -rsp "CRON_SECRET: " VALUE; echo
HDR="$(mktemp)"
printf 'Authorization: Bearer %s\n' "$VALUE" > "$HDR"
curl -s -H @"$HDR" "https://THE_SERVICE_URL/api/health?deep=1"; echo
rm -f "$HDR"
unset VALUE
```

`ok: true`, `supplier: "sandbox"`, `database: "ok"`, and an empty `problems`
list.
