# ---------------------------------------------------------------------------
# Watching the application itself
# ---------------------------------------------------------------------------
# The alarms in scheduler.tf watch the two scheduled jobs: whether they ran at
# all. This file is for the other question - what the running app is telling us -
# and it starts with the API that reads it.
#
# NOTHING IN THE APPLICATION DEPENDS ON THIS RESOURCE. Error Reporting groups
# from entries that are already in Cloud Logging, which every line this app
# writes already reaches (NOS-70 puts the `ReportedErrorEvent` type and the
# stack in the payload). Enabling the API is what makes the grouped view and its
# notifications available to a person; with it off, the entries are still
# written and still searchable, they just have no console to be counted in.
#
# So this needs a `terraform apply` to take effect, and until that apply the app
# is no worse off than it was. That is deliberate: a reporting path that only
# works once somebody has run a Terraform apply would be a reporting path that
# does not work.
#
# `disable_on_destroy = false`, as in scheduler.tf: tearing this environment
# down must not switch off an API something else in the project relies on.
resource "google_project_service" "error_reporting" {
  service            = "clouderrorreporting.googleapis.com"
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# THE ONE ALARM ABOUT A GUEST'S MONEY (NOS-56)
# ---------------------------------------------------------------------------
# The sweeper's safety net ends in "alert a person": when the supplier's hold
# lapsed while a payment was in flight, the booking keeps its status on purpose
# and a `payment.unresolved` event is appended, because that event is the only
# record saying a guest may have been charged with no booking. Nothing read it.
# This is the half of decision D-4.2 that was never built.
#
# A MATCHED-LOG CONDITION, NOT A METRIC AND A THRESHOLD, which is the opposite
# choice to `sweep_absent` next door - and for a reason worth stating, because
# the two look inconsistent otherwise:
#
#   - `sweep_absent` asks about ABSENCE. Absence cannot be observed without a
#     metric to be absent from, so it needs a log metric, an alignment period
#     and a reducer.
#   - this asks about PRESENCE of a single line, and a matched-log condition
#     fires on the entry itself. Fewer moving parts, no 5-minute alignment
#     delay on something involving a guest's money, and - the real prize - the
#     notification carries the LOG ENTRY, so the email already contains the
#     booking reference, the amount, the supplier transaction and what the
#     sweeper tried. That is most of what the runbook's first step would have
#     been.
#
# AC 4 (nothing is sent when there is nothing wrong) is therefore structural
# rather than configured: with no matching entry there is no evaluation at all.
# Contrast `reconcile_stalled`, which needs
# `EVALUATION_MISSING_DATA_ACTIVE` precisely because there, no data IS the alarm.
#
# ONE NOTIFICATION PER FIVE MINUTES, which is Google's own minimum period and
# also one sweep interval. Two different bookings going unresolved inside the
# same window would produce one email, so the email is a doorbell and not a
# list: step 1 of the runbook is the query that returns EVERY unresolved
# booking, and that query is the authoritative answer.
resource "google_monitoring_alert_policy" "payment_unresolved" {
  display_name = "${var.service_name}: a guest may have been charged with no booking"
  combiner     = "OR"

  documentation {
    content = join(" ", [
      "The sweeper could not establish whether a guest paid, and the supplier's hold has lapsed.",
      "The booking deliberately keeps its status, because that row is the only record saying a person still has to look.",
      "The log entry attached to this notification carries the booking reference, the amount, the supplier transaction and what the sweeper already tried.",
      "Follow docs/runbooks/unresolved-payment.md, which starts with the query that lists every unresolved booking - this notification is rate limited to one per five minutes, so it is a doorbell and not a list.",
      "NOT URGENT IN THE MONEY SENSE: the supplier releases an unfinalized charge itself within 1-2 business days (NOS-45), so the guest's money is not lost even when the booking is.",
      "DO NOT mark the booking expired or cancelled to tidy it up: that closes the only record that a human has not finished with it.",
    ])
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "an unresolved payment was recorded"

    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        resource.labels.service_name="${var.service_name}"
        jsonPayload.event="payment.unresolved"
      EOT
    }
  }

  # The same channel as the cron alarms (scheduler.tf). One person, one inbox:
  # a second channel to configure is a second thing to get wrong, and this is
  # not the alarm to discover was pointing at nobody.
  notification_channels = [google_monitoring_notification_channel.owner_email.id]

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "604800s"
  }
}
