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

# Indirect so the whole flow can be exercised against a stub. The first version
# of this script was handed to the owner having never been run end to end, and
# it failed twice on them for reasons a single stubbed run would have caught.
GCLOUD="${GCLOUD:-gcloud}"

# Where the prompts read from. /dev/tty is the person's actual terminal, which
# nothing in a pipeline can consume; TTY can be overridden so a stubbed run can
# feed answers on stdin.
if [ -n "${TTY:-}" ]; then
  :
elif [ -r /dev/tty ]; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# With no arguments, all ten. With names, only those - so correcting one value
# does not add a pointless new version to the other nine, and so this doubles as
# the rotation tool. `bash scripts/seed-uat-secrets.sh DATABASE_URL`
WANTED=" $* "
wanted() {
  [ "$WANTED" = "  " ] && return 0
  case "$WANTED" in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

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
  # EVERY name, and every kind of whitespace. A carriage return is the one that
  # got through: it is invisible in output, it survives command substitution, and
  # Windows tooling produces it by default. Checking only for a newline is how a
  # generated secret ended up one character longer than it should have been.
  [[ "$value" != *$'\n'* ]] || { echo "contains a newline"; return 1; }
  [[ "$value" != *$'\r'* ]] || { echo "contains a carriage return"; return 1; }
  [[ "$value" != *$'\t'* ]] || { echo "contains a tab"; return 1; }
  [[ "$value" != *' '* ]] || { echo "contains a space"; return 1; }
  return 0
}

# Returns non-zero when it refused, so a caller can fall back to asking. That
# matters for the reused group: a stale AUTH_GOOGLE_ID in .env.local from before
# the real OAuth client existed should send you to a prompt, not leave you
# re-running the script wondering why nothing changed.
store() {
  local name="$1" value="$2" source="$3" problem
  wanted "$name" || return 0
  if ! problem=$(check_shape "$name" "$value"); then
    printf '  %-24s REFUSED (%s): %s\n' "$name" "$source" "$problem"
    return 1
  fi
  printf '%s' "$value" |
    "$GCLOUD" secrets versions add "${SERVICE}-${name}" \
      --project="$PROJECT" --data-file=- >/dev/null
  printf '  %-24s stored %3d chars  (%s)\n' "$name" "${#value}" "$source"
}

FAILED=()
MISSING=()

# The two the app is designed to run without. `deploy-config.ts` reports each as
# a WARNING, not a fatal problem: no AI key means natural-language search is
# unavailable, no email key means guest email is logged instead of sent. A
# deploy is not refused for either.
OPTIONAL="ANTHROPIC_API_KEY RESEND_API_KEY"

# The Cloud Run service still needs a VERSION to exist for every secret it
# names, so "off" cannot mean "no version". It has to mean a version the app
# reads as absent, and every check in the app trims before testing, so
# whitespace is exactly that. An empty payload would be better still, and
# whether Secret Manager accepts one is not worth guessing about - so try it
# and fall back. Deliberately NOT a word like "unset": a non-empty value reads
# as configured, the health route stops warning, and the first person to use
# the feature gets an authentication error instead of a clear "not set".
store_off() {
  local name="$1"
  wanted "$name" || return 0
  if printf %s "" |
    "$GCLOUD" secrets versions add "${SERVICE}-${name}" \
      --project="$PROJECT" --data-file=- >/dev/null 2>&1; then
    printf '  %-24s OFF (empty version)\n' "$name"
  elif printf %s " " |
    "$GCLOUD" secrets versions add "${SERVICE}-${name}" \
      --project="$PROJECT" --data-file=- >/dev/null; then
    printf '  %-24s OFF (blank version; an empty one was refused)\n' "$name"
  else
    printf '  %-24s could not be set to off\n' "$name"
    FAILED+=("$name")
  fi
}

is_optional() {
  case " $OPTIONAL " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# 1. Generated here, because these should not be shared with anywhere else
# ---------------------------------------------------------------------------
# A shared environment gets its own. Reusing development's CRON_SECRET would mean
# one leaked value unlocks the scheduled jobs in both, and reusing its AUTH_SECRET
# would make a session cookie from one valid in the other.
echo "generated for this environment only:"
# `tr -d` MUST INCLUDE \r. On Windows openssl emits CRLF, command substitution
# strips the trailing newline but not the carriage return, and the first real run
# stored an AUTH_SECRET 44 characters long where a clean one is 43. Low impact in
# that case, because the value was consistent within the service, but a value you
# later copy by hand differs invisibly from the one in use - and the shape check
# below tested for \n and spaces, not \r, which is why it got through.
store AUTH_SECRET     "$(openssl rand -base64 32 | tr -d '\r\n=')" generated || FAILED+=(AUTH_SECRET)
store CRON_SECRET     "$(openssl rand -hex 32   | tr -d '\r\n')"  generated || FAILED+=(CRON_SECRET)
store ACCESS_PASSWORD "$(openssl rand -base64 24 | tr -d '\r\n=/+')" generated || FAILED+=(ACCESS_PASSWORD)
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
    if wanted "$NAME"; then
      printf '  %-24s will ask below\n' "$NAME"
    fi
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
echo "paste these (they are shown, so you can see what arrived)."
echo "ANTHROPIC_API_KEY and RESEND_API_KEY may be left empty: press Enter and the"
echo "feature is switched off and reported as a warning by /api/health."

for NAME in DATABASE_URL ${MISSING+"${MISSING[@]}"}; do
  wanted "$NAME" || continue
  printf '\n  %s\n  > ' "$NAME"
  # FROM THE TERMINAL, NOT STDIN. On the owner's second run the prompt did not
  # wait: something earlier in the script had consumed stdin to EOF, so `read`
  # returned immediately with nothing and DATABASE_URL was reported "skipped"
  # without ever being asked for. /dev/tty is the input the person is actually
  # sitting at, and it cannot be eaten by anything in the pipeline above.
  IFS= read -r VALUE < "$TTY" || true
  if [ -z "$VALUE" ]; then
    if is_optional "$NAME"; then
      store_off "$NAME"
    else
      printf '  %-24s skipped - the service cannot start without it\n' "$NAME"
      FAILED+=("$NAME")
    fi
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
  COUNT=$("$GCLOUD" secrets versions list "${SERVICE}-${NAME}" --project="$PROJECT" \
    --filter='state:ENABLED' --format='value(name)' 2>/dev/null | wc -l | tr -d ' ')
  printf '  %-24s %s\n' "$NAME" "$COUNT"
  if [ "$COUNT" = "0" ]; then EMPTY=$((EMPTY + 1)); fi
done
echo

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf 'REFUSED OR SKIPPED: %s\n' "${FAILED[*]}"
  echo "Nothing was uploaded for those. Fix and re-run; re-running is safe."
  # EXIT NON-ZERO EVEN IF EVERY SECRET HAS A VERSION. A refusal plus an older
  # version from a previous run counts as "1" above, so the version table alone
  # would report success while the value you just corrected was the one rejected.
  # Seen in testing, 2026-10-07.
  exit 1
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
