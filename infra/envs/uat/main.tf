# The test environment, defined in code (decision D-5.5).
#
# WHAT THIS FILE OWNS AND WHAT IT DOES NOT. It owns the shape of the
# environment: the service and how it scales, which secrets it may read, where
# images live and how long they are kept, and the budget alarm. It does NOT own
# which image is running - the delivery pipeline owns that, and the
# `ignore_changes` below is what keeps the two from fighting over it. Running
# `terraform apply` after a deploy must not roll the service back to whatever
# image was current when this file was last edited.
#
# IT ALSO DOES NOT OWN ANY SECRET VALUE. Terraform writes its state to a bucket,
# in plain text, including every attribute of every resource it manages. So this
# creates the secret *containers* and leaves them empty; the owner adds versions
# by hand (docs/runbooks/bootstrap-uat.md). A secret passed through Terraform is
# a secret stored twice, and the second copy is the one nobody remembers.
#
# APPLIED BY HAND, not by CI. One service does not justify a Terraform pipeline,
# and a CI identity able to rewrite the environment is a bigger credential than
# one able to deploy an image to it.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# WHY THE CLEANUP POLICY IS NOT OPTIONAL. Reviewing the owner's September Google
# bill (2026-10-07) showed the entire charge was container image storage:
# Cloud Run itself cost $0.0007 across four services, while one older project's
# registry had grown to 2,007 MB and accounted for 85% of the bill. This
# pipeline pushes an image on every merge to main, forever, so without a policy
# this repository is on exactly that trajectory - and it would be the largest
# line on the bill while Cloud Run stayed free.
resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = var.repository_id
  description   = "Container images for the Nostavel test environment (NOS-61)."
  format        = "DOCKER"

  # Keep the ten most recent, so a rollback target always exists: the rollback
  # runbook works by sending traffic to an earlier revision, and a revision
  # whose image has been deleted cannot serve.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  # Anything that is not one of those ten and is older than a week goes. A week
  # rather than a day so an image is still around while a problem is being
  # diagnosed.
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "604800s" # 7 days
    }
  }
}

# ---------------------------------------------------------------------------
# Who the service runs as
# ---------------------------------------------------------------------------

# Its own identity, with nothing but the ability to read the secrets below.
# Without this the service would run as the project's default Compute identity,
# which holds Editor on the whole project - so a flaw in the app would be a flaw
# with permission to rewrite the environment it runs in.
resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-run"
  display_name = "Runtime identity for ${var.service_name}"
  description  = "Reads this environment's secrets. Nothing else."
}

# ---------------------------------------------------------------------------
# Secrets: containers only, never values
# ---------------------------------------------------------------------------

locals {
  # Every value the app needs that must not appear in code, a log, or this
  # Terraform state. src/lib/deploy-config.ts decides which of these are fatal
  # to be missing; a shared copy refuses to serve without them.
  secret_ids = [
    "DATABASE_URL",
    "AUTH_SECRET",
    "LITEAPI_KEY",
    "LITEAPI_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "RESEND_API_KEY",
    "CRON_SECRET",
    "ACCESS_PASSWORD",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secret_ids)
  secret_id = "${var.service_name}-${each.key}"

  replication {
    auto {}
  }

  # Deliberately no `google_secret_manager_secret_version` anywhere in this
  # configuration. See the header: a value added here would be written to the
  # state bucket in plain text.
}

resource "google_secret_manager_secret_iam_member" "runtime_reads" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region

  # The app's own password gate is the lock (src/lib/access-gate.ts), not the
  # platform's: the supplier's webhook and the two scheduled jobs have to be
  # able to reach it with only their own shared secret, and an
  # IAM-authenticated service would make them unreachable without a proxy. The
  # scheduled jobs are the ones that rescue a guest who was charged and whose
  # browser never came back, so locking them out would be the expensive choice.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      # Scales to nothing when idle, which is why Cloud Run costs essentially
      # zero here: measured on the owner's own account, four always-available
      # services with no minimum instance cost $0.0007 for a month.
      min_instance_count = 0
      # Two is enough for one person accepting changes, and it is a ceiling on
      # how much a runaway loop or a stranger can spend before anyone notices.
      max_instance_count = 2
    }

    containers {
      # A placeholder, replaced on the first deploy and ignored thereafter: see
      # `lifecycle` below. Terraform has to be given something to create the
      # service with, and this image is Google's own hello-world rather than
      # ours, so a service that somehow serves this is obviously not the app.
      image = var.bootstrap_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU is only billed while a request is being served. The alternative
        # (always-allocated) is what turns a scale-to-zero service into a
        # monthly charge.
        cpu_idle = true
      }

      env {
        name  = "APP_ENV"
        value = var.app_env
      }

      # Required in a shared environment, because src/lib/email.ts otherwise
      # falls back to localhost and every link mailed to a guest is dead.
      env {
        name  = "APP_URL"
        value = var.app_url
      }

      dynamic "env" {
        for_each = google_secret_manager_secret.app
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      # The pipeline owns the image and the traffic split. Without this, an
      # apply run after a deploy would quietly roll the environment back to the
      # bootstrap image - and a rollback performed through the runbook (which
      # pins traffic to an earlier revision) would be undone by the next apply.
      template[0].containers[0].image,
      traffic,
      client,
      client_version,
    ]
  }

  depends_on = [google_secret_manager_secret_iam_member.runtime_reads]
}

# Anyone may reach it; the app decides who gets past the front door. See the
# `ingress` comment above for why this is not IAM-gated.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# Cost alarm
# ---------------------------------------------------------------------------

# The decision said $2-5 a month. This is what makes that a fact rather than an
# expectation: $5 is "look at it", $15 is "something is wrong". Needs billing
# permissions the project's own roles do not include - if an apply fails here,
# the rest still applies and the runbook says how to add it by hand.
resource "google_billing_budget" "monthly" {
  count = var.billing_account == "" ? 0 : 1

  billing_account = var.billing_account
  display_name    = "Nostavel test environment"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "15"
    }
  }

  # A third of the alarm, so the first warning arrives while the bill is still
  # a rounding error.
  threshold_rules {
    threshold_percent = 0.33
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    # Forecast, not actual: the useful warning about a runaway cost arrives
    # before the month ends, not after.
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}
