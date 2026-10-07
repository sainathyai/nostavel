# State lives in a bucket in the same project, created by hand before the first
# apply (docs/runbooks/bootstrap-uat.md).
#
# IT IS NOT A PLACE FOR SECRETS, AND THAT IS WHY THIS CONFIGURATION HAS NONE.
# Terraform writes every attribute of every managed resource here in plain text.
# The bucket is private and versioned, but the right protection is not storing
# the values at all: main.tf creates empty secret containers and the owner adds
# versions by hand.
terraform {
  backend "gcs" {
    bucket = "nostavel-tfstate"
    prefix = "envs/uat"
  }
}
