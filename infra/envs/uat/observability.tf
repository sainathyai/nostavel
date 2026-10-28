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
