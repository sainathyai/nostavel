variable "project_id" {
  description = "The Google Cloud project. Created by hand; see docs/runbooks/bootstrap-uat.md."
  type        = string
  default     = "nostavel"
}

variable "project_number" {
  description = "The project's numeric id, which the budget filter needs (the string id will not do)."
  type        = string
}

variable "region" {
  description = "One region; there is nothing here worth running in two."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name. Also the prefix on every secret this environment owns."
  type        = string
  default     = "nostavel-uat"
}

variable "repository_id" {
  description = "Artifact Registry repository for this app's images."
  type        = string
  default     = "nostavel"
}

variable "app_env" {
  description = <<-EOT
    What the app calls itself. Anything other than "local" means a shared copy, so
    the password gate applies and every required secret is enforced
    (src/lib/deploy-config.ts). Never set this to "local" for a deployed service.
  EOT
  type        = string
  default     = "uat"

  validation {
    condition     = var.app_env != "local" && trimspace(var.app_env) != ""
    error_message = "app_env must not be \"local\" or empty: that is how a deployed copy ends up with a laptop's exemptions and no password gate (D-60.1)."
  }
}

variable "app_url" {
  description = <<-EOT
    The environment's own URL, used in links mailed to guests. Known only after the
    service exists, so the first apply leaves it at the placeholder and the second
    sets it: see docs/runbooks/bootstrap-uat.md. A wrong value here means dead
    links in guest email, with nothing erroring anywhere.
  EOT
  type        = string
  default     = "https://example.invalid"
}

variable "bootstrap_image" {
  description = <<-EOT
    What the service is created with, before the pipeline has ever deployed. Not
    this app on purpose: a service still serving this is visibly not the app,
    rather than an old version of it. Ignored after creation.
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "billing_account" {
  description = <<-EOT
    Billing account id, for the budget alarm only. Leave empty to skip the budget
    (for example if the account lacks billing permissions) and add it by hand from
    the runbook instead.
  EOT
  type        = string
  default     = ""
}
