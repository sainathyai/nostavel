#!/usr/bin/env bash
#
# Put the test environment's ten secret values into Secret Manager.
#
#   bash scripts/seed-uat-secrets.sh
#
# WHY THIS EXISTS. The bootstrap runbook used to ask the owner to type all ten
# into a hidden prompt, one after another. The first real run of that (2026-10-07)
# stored a 300-character DATABASE_URL, which is the pooled Neon string pasted
# twice, and a 144-character AUTH_SECRET. Neither would have been noticed until
# the deployed app could not reach its database, and a hidden prompt gives you
# nothing to check against. The fix is not a better prompt. It is to take the
# values that already exist from where they already are, generate the ones that
# should be new, and REFUSE ANY VALUE WHOSE SHAPE IS WRONG.
#
# What this script does NOT do: it never prints a secret value, never writes one
# to a file, and never puts one on a command line where the process table or the
# shell history could keep it. Values reach gcloud on stdin only.
#
# Re-running is safe. Secret Manager keeps versions, the service reads `latest`,
# and a wrong earlier version stays until you disable it (see the end).
set -euo pipefail

PROJECT="${PROJECT:-nostavel}"
SERVICE="${SERVICE:-nostavel-uat}"
ENV_FILE="${ENV_FILE:-.env.local}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf 'project %s, service %s, reading reusable values from %s\n\n' \
  "$PROJECT" "$SERVICE" "$ENV_FILE"

# ---------------------------------------------------------------------------
# Reading one name out of .env.local
# ---------------------------------------------------------------------------
# Deliberately NOT `source`: that would execute whatever is in the file, and it
# mangles values containing spaces or `$`. Takes everything after the first `=`
# and strips one layer of surrounding quotes.
read_env_file() {
  local name="$1"
  [ -f "$ENV_FILE" ] || return 1
  local line
  line=$(grep -m1 "^${name}=" "$ENV_FILE" 2>/dev/null) || return 1
  local value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# The shape each value must have
# ---------------------------------------------------------------------------
# One case per secret, because "it is a string and it is not empty" is the check
# that let a doubled connection string through. Every rule here is one a wrong
# value actually breaks, not a guess.
check_shape() {
  local name="$1" value="$2" len=${#2}
  case "$name" in
    DATABASE_URL)
      [[ "$value" == postgres://* || "$value" == postgresql://* ]] ||
        { echo "must start postgres:// or postgresql://"; return 1; }
      [[ "$value" == *neon.tech* ]] ||
        { echo "does not look like a Neon host"; return 1; }
      (( len >= 80 && len <= 260 )) ||
        { echo "$len characters is outside 80-260; a doubled paste lands here"; return 1; }
      [[ "$(grep -o 'postgres' <<<"$value" | wc -l)" -eq 1 ]] ||
        { echo "contains the scheme more than once, so it was pasted twice"; return 1; }
      ;;
    LITEAPI_KEY)
      # The repository-wide rule, enforced at every point it can be: the app
      # refuses to serve on a live key and the deploy refuses to promote one.
      [[ "$value" == sand_* ]] ||
        { echo "must start sand_ - this environment never holds a live key"; return 1; }
      ;;
    ANTHROPIC_API_KEY)
      [[ "$value" == sk-ant-* ]] || { echo "should start sk-ant-"; return 1; } ;;
    RESEND_API_KEY)
      [[ "$value" == re_* ]] || { echo "should start re_"; return 1; } ;;
    AUTH_GOOGLE_ID)
      [[ "$value" == *.apps.googleusercontent.com ]] ||
        { echo "should end .apps.googleusercontent.com"; return 1; } ;;
    AUTH_GOOGLE_SECRET)
      [[ "$value" == GOCSPX-* ]] || { echo "should start GOCSPX-"; return 1; } ;;
    ACCESS_PASSWORD)
      (( len >= 16 )) || { echo "under the 16-character minimum the app enforces"; return 1; } ;;
    AUTH_SECRET|CRON_SECRET)
      (( len >= 16 )) || { echo "$len characters is too short to be the real value"; return 1; } ;;
    LITEAPI_WEBHOOK_SECRET)
      # Theirs, not ours, so the floor is only "not obviously a placeholder".
      (( len >= 8 )) || { echo "$len characters looks like a placeholder"; return 1; } ;;
  esac
  # Catches a trailing newline or a stray quote from a copy-paste, for every name.
  [[ "$value" != *$'\n'* ]] || { echo "contains a newline"; return 1; }
  [[ "$value" != *' '* ]] || { echo "contains a space"; return 1; }
  return 0
}

# Returns non-zero when it refused, so a caller can fall back to asking. That
# matters for the reused group: a stale AUTH_GOOGLE_ID in .env.local from before
# the real OAuth client existed should send you to a prompt, not leave you
# re-running the script wondering why nothing changed.
store() {
  local name="$1" value="$2" source="$3" problem
  if ! problem=$(check_shape "$name" "$value"); then
    printf '  %-24s REFUSED (%s): %s\n' "$name" "$source" "$problem"
    return 1
  fi
  printf '%s' "$value" |
    gcloud secrets versions add "${SERVICE}-${name}" \
      --project="$PROJECT" --data-file=- >/dev/null
  printf '  %-24s stored %3d chars  (%s)\n' "$name" "${#value}" "$source"
}

FAILED=()
MISSING=()

# ---------------------------------------------------------------------------
# 1. Generated here, because these should not be shared with anywhere else
# ---------------------------------------------------------------------------
# A shared environment gets its own. Reusing development's CRON_SECRET would mean
# one leaked value unlocks the scheduled jobs in both, and reusing its AUTH_SECRET
# would make a session cookie from one valid in the other.
echo "generated for this environment only:"
store AUTH_SECRET     "$(openssl rand -base64 32 | tr -d '\n=' )" generated
store CRON_SECRET     "$(openssl rand -hex 32)"                   generated
store ACCESS_PASSWORD "$(openssl rand -base64 24 | tr -d '\n=/+')" generated
echo

# ---------------------------------------------------------------------------
# 2. Taken from .env.local, because they are the same account
# ---------------------------------------------------------------------------
# The same sandbox supplier, the same Anthropic and Resend accounts, the same
# OAuth client. DATABASE_URL is deliberately NOT in this list: this environment
# has its own database (D-5.3), and development's string must never reach it.
echo "reused from ${ENV_FILE}:"
for NAME in LITEAPI_KEY LITEAPI_WEBHOOK_SECRET ANTHROPIC_API_KEY RESEND_API_KEY \
            AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET; do
  if VALUE=$(read_env_file "$NAME") && store "$NAME" "$VALUE" "$ENV_FILE"; then
    :
  else
    printf '  %-24s will ask below\n' "$NAME"
    MISSING+=("$NAME")
  fi
done
unset VALUE
echo

# ---------------------------------------------------------------------------
# 3. Asked for, VISIBLY
# ---------------------------------------------------------------------------
# Shown rather than hidden on purpose. A hidden prompt is why a doubled paste got
# through, and `read` input never enters shell history, so the only exposure is
# your own screen. The shape check runs before anything is uploaded.
echo "paste these (they are shown, so you can see what arrived):"
for NAME in DATABASE_URL ${MISSING+"${MISSING[@]}"}; do
  printf '\n  %s\n  > ' "$NAME"
  IFS= read -r VALUE || true
  if [ -z "$VALUE" ]; then
    printf '  %-24s skipped - the service cannot start without it\n' "$NAME"
    FAILED+=("$NAME")
    continue
  fi
  store "$NAME" "$VALUE" typed || FAILED+=("$NAME")
done
unset VALUE
echo

# ---------------------------------------------------------------------------
# What to do next, and what is still wrong
# ---------------------------------------------------------------------------
echo "every secret, by enabled version count:"
ALL=(DATABASE_URL AUTH_SECRET LITEAPI_KEY LITEAPI_WEBHOOK_SECRET ANTHROPIC_API_KEY
     RESEND_API_KEY CRON_SECRET ACCESS_PASSWORD AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET)
EMPTY=0
for NAME in "${ALL[@]}"; do
  COUNT=$(gcloud secrets versions list "${SERVICE}-${NAME}" --project="$PROJECT" \
    --filter='state:ENABLED' --format='value(name)' 2>/dev/null | wc -l | tr -d ' ')
  printf '  %-24s %s\n' "$NAME" "$COUNT"
  [ "$COUNT" = "0" ] && EMPTY=$((EMPTY + 1))
done
echo

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'REFUSED OR SKIPPED: %s\n' "${FAILED[*]}"
  echo "Nothing was uploaded for those. Fix and re-run; re-running is safe."
fi
if [ "$EMPTY" -gt 0 ]; then
  echo "$EMPTY secret(s) still hold no value. \`terraform apply\` will fail on the"
  echo "Cloud Run service until every one of them does."
  exit 1
fi

cat <<'NEXT'
All ten hold a value. Two things read back out of Secret Manager rather than
being written down anywhere:

  # the site password, which you type into the browser
  gcloud secrets versions access latest --secret=nostavel-uat-ACCESS_PASSWORD \
    --project=nostavel; echo

  # the operations secret, piped straight into GitHub without being displayed
  gcloud secrets versions access latest --secret=nostavel-uat-CRON_SECRET \
    --project=nostavel | gh secret set CRON_SECRET --repo sainathyai/nostavel

If an earlier run stored a wrong value, the service reads `latest` so the newest
one wins. Tidy the old ones up afterwards:

  gcloud secrets versions list nostavel-uat-DATABASE_URL --project=nostavel
  gcloud secrets versions disable N --secret=nostavel-uat-DATABASE_URL --project=nostavel
NEXT
