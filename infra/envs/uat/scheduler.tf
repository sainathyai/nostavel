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
# The APIs this file needs
# ---------------------------------------------------------------------------
# Without these the apply fails part-way through, leaving the environment half
# configured (part 3 review, L2). Enabling Cloud Scheduler also creates its
# service agent, which must keep `roles/cloudscheduler.serviceAgent` or every job
# returns 403 regardless of which invoker account it uses - that is a project-level
# grant made at enablement, not something this file should fight over, but it is
# the first thing to check if every job 403s at once.
#
# `disable_on_destroy = false`: destroying this environment must not switch off an
# API another thing in the project might rely on.
resource "google_project_service" "scheduler_stack" {
  for_each = toset([
    "cloudscheduler.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ])

  service            = each.key
  disable_on_destroy = false
}

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

  depends_on = [google_project_service.scheduler_stack]

  name        = "${var.service_name}-${each.key}"
  region      = var.region
  description = each.value.description
  schedule    = each.value.schedule
  time_zone   = "America/Chicago"

  # ZERO RETRIES: wait for the next tick. `retry_count` counts RETRIES, so the
  # 1 this used to say meant two attempts and contradicted its own rationale
  # (NOS-65 part 3 review, M3). The rationale is the real one: a retry storm
  # against the supplier is how a rate limit becomes silence, and silence read as
  # fact is the NOS-5 harm. The next sweep is 5 minutes away.
  retry_config {
    retry_count = 0
  }

  # 300s, matching Cloud Run's own default request timeout, which this service
  # does not override. This used to say 600s with a comment about a pass that has
  # not answered in 10 minutes - unreachable, because the platform kills the
  # request at 5 minutes first. Same class of defect as the clock tolerance in
  # part 2: a documented property that did not exist.
  attempt_deadline = "300s"

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

# The app logs one structured line per COMPLETED pass, carrying which credential
# authorised it. Two deliberate choices here, both from the part 3 review:
#
#   - `completed`, not `authorized`. The authorised line is emitted before a
#     single row is read, so a job that authenticates and then throws on its
#     first query would feed this metric every 5 minutes while rescuing nobody.
#   - `via="oidc"`, so a GitHub `workflow_dispatch` run cannot keep the metric
#     alive and hide a dead Scheduler job. That is also what makes NOS-65's
#     "72 hours of Scheduler delivery" precondition answerable at all: while both
#     triggers coexist, an unfiltered metric cannot tell them apart.
resource "google_logging_metric" "cron_completed" {
  for_each = local.cron_jobs

  name   = "${var.service_name}-cron-${each.key}-completed"
  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${var.service_name}"
    jsonPayload.event="cron.${each.key}.completed"
    jsonPayload.via="oidc"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# THE SWEEPER'S ALARM: absence of a completed pass.
#
# Absence is the right mechanism here and only here. The sweeper runs every 5
# minutes, so a 20-minute window is three missed ticks and sits comfortably inside
# Google's documented 23.5 hour maximum for an absence condition.
#
# GROUPED ACROSS REVISIONS, which the first version was not, and that was a
# defect worth more than the feature (part 3 review, C2). A log-based metric's
# series carries the log entry's resource, and `cloud_run_revision` includes
# `revision_name` - so without a cross-series reducer there is one series per
# revision, Monitoring opens an incident per violating series, and EVERY DEPLOY
# would fire "the sweep job has stopped running" twenty minutes later as the old
# revision stopped logging. With `auto_close` at a week, those stale incidents
# would pile up, and the alarm that has to be believed at 3am becomes the one
# that always cries wolf. Reducing across revisions asks the question actually
# being asked: did ANY revision complete a pass?
resource "google_monitoring_alert_policy" "sweep_absent" {
  display_name = "${var.service_name}: the sweep job has stopped running"
  combiner     = "OR"

  documentation {
    content = join(" ", [
      "No sweep pass has completed in 20 minutes.",
      "The sweeper is the only automatic rescue for a guest who was charged and never came back, so while this is firing that rescue is not happening.",
      "Run it by hand first: gcloud scheduler jobs run ${var.service_name}-sweep --location ${var.region}.",
      "Then follow docs/runbooks/cron-jobs.md, which maps each 401 reason to one action.",
      "NOTE: this policy only watches passes authorised by Cloud Scheduler (via=oidc). A GitHub workflow_dispatch run will not clear it.",
    ])
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "no completed sweep pass in 20 minutes"

    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cron_completed["sweep"].name}\" AND resource.type=\"cloud_run_revision\""
      duration = "1200s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_COUNT"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.owner_email.id]

  alert_strategy {
    auto_close = "604800s"
  }
}

# THE RECONCILER'S ALARM: a threshold, because absence cannot express a daily job.
#
# This was `condition_absent` with a 36 hour window, and that was wrong twice over
# (part 3 review, C1). Google documents the maximum absence window as 23.5 hours,
# so either the apply fails or the condition is never satisfiable and the alarm is
# decorative - and a policy that exists, looks green, and cannot fire is worse than
# none, because it stops anyone looking again. Worse still, the normal gap between
# nightly runs is about 24 hours, which EXCEEDS that maximum: any legal absence
# window would have fired every morning shortly before the next run, and after
# four nights of false alarms the owner would mute the only alarm the reconciler
# has. That is this ticket's own defect wearing a new hat.
#
# So: a threshold on the same metric. A 24 hour rolling count below 1, sustained
# for 12 hours, means roughly 36 hours without a completed pass - one missed night
# is noise, two are not, which is what the design intended all along and could not
# say in the previous form. `EVALUATION_MISSING_DATA_ACTIVE` is the part that makes
# it work at all: a log-based counter writes NOTHING when no entry matches, not a
# zero, so without this the condition would simply have no data to compare.
resource "google_monitoring_alert_policy" "reconcile_stalled" {
  display_name = "${var.service_name}: the reconcile job has stopped running"
  combiner     = "OR"

  documentation {
    content = join(" ", [
      "No reconcile pass has completed in roughly 36 hours, so one missed night has become two.",
      "The reconciler is the only automatic comparison of our ledger against the supplier's.",
      "Run it by hand: gcloud scheduler jobs run ${var.service_name}-reconcile --location ${var.region}.",
      "Then follow docs/runbooks/cron-jobs.md.",
    ])
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "fewer than one completed reconcile pass per day"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.cron_completed["reconcile"].name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "43200s"

      aggregations {
        alignment_period     = "86400s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }

      trigger {
        count = 1
      }

      # Treat "no data at all" as the alarm condition. Without this a metric with
      # no matching entries has no series to evaluate and the policy stays quiet
      # in precisely the case it exists for.
      evaluation_missing_data = "EVALUATION_MISSING_DATA_ACTIVE"
    }
  }

  notification_channels = [google_monitoring_notification_channel.owner_email.id]

  alert_strategy {
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
