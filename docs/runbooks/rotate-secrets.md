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
printf '%s' 'THE_NEW_VALUE' | \
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
curl -s -u "owner:THE_NEW_VALUE" -o /dev/null -w '%{http_code}\n' "https://THE_SERVICE_URL/"
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
| `DATABASE_URL` | GitHub Actions secret `UAT_DATABASE_URL` | The pipeline plans and applies migrations against a different database than the app reads |

Change both in the same sitting:

```bash
printf '%s' 'THE_NEW_VALUE' | \
  gcloud secrets versions add "${SERVICE}-CRON_SECRET" --project="$PROJECT" --data-file=-
gh secret set CRON_SECRET --repo sainathyai/nostavel
```

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
curl -s -H "Authorization: Bearer THE_CRON_SECRET" \
  "https://THE_SERVICE_URL/api/health?deep=1"
```

`ok: true`, `supplier: "sandbox"`, `database: "ok"`, and an empty `problems`
list.
