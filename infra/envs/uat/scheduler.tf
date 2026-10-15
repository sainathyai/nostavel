# Cloud Scheduler for the two money-safety jobs (NOS-65).
#
# WHY THIS FILE EXISTS, AS A MEASUREMENT RATHER THAN AN OPINION. These jobs ran
# from GitHub Actions' `schedule` event, and over 67.3 hours it fired the sweeper
# **13 times against an expected 808**: 1.6 percent delivery, worst observed gap
# 9 hours 41 minutes, against a supplier prebook hold that expires at 15 minutes.
# Every one of those runs reported success, so nothing anywhere reported a
# problem. The sweeper is the only automatic rescue for a guest charged with no
# booking, so it had effectively never had a working trigger.
#
# WHY OIDC AND NOT THE SHARED SECRET. Cloud Scheduler can only carry a secret in
# the job's headers, and no secret value may pass through Terraform (ADR 0005) -
# not as a variable, not as a resource argument, and not read back through a
# `google_secret_manager_secret_version` data source, which would write it into
# state. Creating the job by hand with `gcloud` would "work" and would move a
# money credential out of Secret Manager into a job description readable with
# `cloudscheduler.jobs.get`, with no `secretAccessor` boundary and no access
# audit, and would make the only working trigger an undocumented hand artifact.
# An identity is not a secret, so this file satisfies the rule by construction.

# ---------------------------------------------------------------------------
# One identity per job
# ---------------------------------------------------------------------------
# TWO, not one. The jobs have different blast radii: the sweeper expires holds
# and calls the supplier's `book()`, while the reconciler makes one read per
# finalized row. Separate accounts mean per-job audit lines in the request log,
# either invoker can be disabled without killing the other during an incident,
# and the audience pinning in `cron-identity.ts` is meaningful rather than
# decorative.
#
# Neither account is granted any IAM role. They exist to BE an identity. The
# service is public (see the `public` member in main.tf), so authorisation is the
# app's job, which is why nothing here needs `roles/run.invoker`.
resource "google_service_account" "cron_invoker" {
  for_each = toset(["sweep", "reconcile"])

  account_id   = "${var.service_name}-${each.key}-inv"
  display_name = "Cloud Scheduler invoker for the ${each.key} job"
  description  = "Identity only. Holds no role. Pinned by sub in src/lib/cron-identity.ts."
}

# ---------------------------------------------------------------------------
# The jobs
# ---------------------------------------------------------------------------
locals {
  # Deliberately derived from `var.app_url`, the same variable the application
  # builds its expected audience from (`expectedCronCaller` in cron-auth.ts).
  # Two copies of a URL drift, and NOS-67 was exactly that: a sign-in link
  # pointing at the container's own bind address because one place said APP_URL
  # and another did not.
  #
  # No trailing slash. The proxy's exemption list is exact-match, and although
  # `isExemptPath` now tolerates one trailing slash so that getting this wrong is
  # a 401 from the route rather than a silent Basic challenge from the proxy, the
  # URL should still be right.
  cron_base = replace(var.app_url, "/\\/$/", "")

  cron_jobs = {
    sweep = {
      # Every 5 minutes against a 15-minute hold. The interval was never the
      # problem - `*/5` was already configured in Actions and still delivered
      # 1.6 percent - but it is the right interval, and now something will
      # actually honour it.
      schedule    = "*/5 * * * *"
      description = "Rescues a guest charged with no booking. The only automatic path for that."
    }
    reconcile = {
      # Nightly, low traffic, ~02:00 US Central.
      schedule    = "0 2 * * *"
      description = "Compares our ledger against the supplier's and writes mismatches."
    }
  }
}

resource "google_cloud_scheduler_job" "cron" {
  for_each = local.cron_jobs

  name        = "${var.service_name}-${each.key}"
  region      = var.region
  description = each.value.description
  schedule    = each.value.schedule
  time_zone   = "America/Chicago"

  # One attempt and then wait for the next tick, for the sweeper's sake: a retry
  # storm against the supplier is how a rate limit becomes silence, and silence
  # read as fact is the NOS-5 harm. The next run is 5 minutes away.
  retry_config {
    retry_count = 1
  }

  # A pass that has not answered in 10 minutes is not going to; the next tick is
  # a better bet than a hung request holding a container open.
  attempt_deadline = "600s"

  http_target {
    uri         = "${local.cron_base}/api/cron/${each.key}"
    http_method = "POST"

    oidc_token {
      service_account_email = google_service_account.cron_invoker[each.key].email
      # EXPLICIT, never defaulted. The app compares this against its own derived
      # value, and a token minted for one job must not be replayable against the
      # other.
      audience = "${local.cron_base}/api/cron/${each.key}"
    }
  }
}

# ---------------------------------------------------------------------------
# The part that matters most: making a stopped job loud
# ---------------------------------------------------------------------------
# Authorisation fails CLOSED, which means a misconfiguration stops the job
# silently - and a silently stopped money-safety job is exactly today's harm with
# a new cause. So the acceptance criterion for NOS-65 is not "it runs", it is
# "its absence shouts".
#
# ALERT ON ABSENCE, NEVER ON FAILURE. The old trigger reported success 13 times
# out of 808 expected: a failure alert would have stayed quiet through the whole
# thing. These policies watch for the absence of a COMPLETED pass, which is the
# only signal that distinguishes "working" from "not being invoked".
#
# Monitoring lives outside both the app and Scheduler on purpose. A check that
# shares fate with the thing it checks is not a check.
resource "google_monitoring_notification_channel" "owner_email" {
  display_name = "Nostavel owner email"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# The app logs one structured line per authorised run
# (`cron.<job>.authorized`, added in NOS-65 part 2 for exactly this). A
# log-based metric turns that into something an absence condition can watch.
resource "google_logging_metric" "cron_authorized" {
  for_each = local.cron_jobs

  name   = "${var.service_name}-cron-${each.key}-authorized"
  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.service_name}"
    jsonPayload.event="cron.${each.key}.authorized"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "cron_absent" {
  for_each = local.cron_jobs

  display_name = "${var.service_name}: the ${each.key} job has stopped running"
  combiner     = "OR"

  documentation {
    content = join(" ", [
      "The ${each.key} job has not completed a pass within its window.",
      each.key == "sweep"
      ? "The sweeper is the only automatic rescue for a guest who was charged and never came back, so while this is firing that rescue is not happening."
      : "The reconciler is the only automatic comparison of our ledger against the supplier's.",
      "Run it by hand with: gcloud scheduler jobs run ${var.service_name}-${each.key} --location ${var.region}.",
      "That uses your own identity and no secret. See docs/runbooks/cron-jobs.md.",
    ])
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "no completed ${each.key} pass"

    condition_absent {
      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cron_authorized[each.key].name}\" AND resource.type=\"cloud_run_revision\""
      # Sweep: 20 minutes, which is three missed 5-minute ticks and still inside
      # a fresh 15-minute hold's successor. Reconcile: 36 hours, so one missed
      # nightly run is noise and two are not.
      duration = each.key == "sweep" ? "1200s" : "129600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.owner_email.id]

  alert_strategy {
    # Closes itself once passes resume, so a recovered job does not need a human
    # to tidy up after it.
    auto_close = "604800s"
  }
}

# Scheduler's own view, which catches the case the app-side metric cannot: a job
# whose invocations never arrive at all, because the identity is wrong or the URL
# is. That shows up here within one tick and nowhere else.
resource "google_monitoring_alert_policy" "cron_attempt_failed" {
  display_name = "${var.service_name}: a scheduled job attempt failed"
  combiner     = "OR"

  documentation {
    content = join(" ", [
      "Cloud Scheduler could not deliver a job. The usual causes, in order:",
      "the invoker identity is wrong or its CRON_*_INVOKER_SUB env var does not match the service account's unique_id;",
      "the job URL has a trailing slash or the wrong host, so the proxy answered with a Basic challenge before the route saw it;",
      "or the audience does not match what the app derives from APP_URL.",
      "The route's 401 names which claim failed - read it before changing anything.",
    ])
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "scheduler attempt failed"

    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_scheduler_job"
        severity>=ERROR
      EOT
    }
  }

  notification_channels = [google_monitoring_notification_channel.owner_email.id]

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "604800s"
  }
}

# ---------------------------------------------------------------------------
# What the application needs to know
# ---------------------------------------------------------------------------
# The service reads these as plain environment values. Neither is a secret: a
# service-account email and that account's immutable numeric id.
#
# The SUBJECT is what pins the caller. Checked against Google's documentation on
# 2026-10-14: `sub` is in the documented claim table for a service-account ID
# token and is what Google's own guidance says to key identity on, while `email`
# and `email_verified` are added only when an include-email option is requested -
# and Cloud Scheduler's job configuration has no such option. A verifier that
# required an email would have denied every token here and failed both jobs closed
# on day one.
output "cron_invoker_env" {
  description = "Set these on the Cloud Run service. See main.tf's env block."
  value = {
    CRON_SWEEP_INVOKER_EMAIL     = google_service_account.cron_invoker["sweep"].email
    CRON_SWEEP_INVOKER_SUB       = google_service_account.cron_invoker["sweep"].unique_id
    CRON_RECONCILE_INVOKER_EMAIL = google_service_account.cron_invoker["reconcile"].email
    CRON_RECONCILE_INVOKER_SUB   = google_service_account.cron_invoker["reconcile"].unique_id
  }
}
