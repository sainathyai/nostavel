# Infrastructure

One environment, defined here, applied by hand (decision D-5.5 in
[ADR 0005](../docs/adr/0005-deployment-and-environments.md)).

| | |
|---|---|
| What is here | the shape of the test environment: the service, how it scales, which secrets it may read, where images live and how long they are kept, the cost alarm |
| What is **not** here | which image is running. The delivery pipeline owns that, and `main.tf` ignores changes to it so an `apply` after a deploy cannot roll the environment back |
| What is **never** here | any secret value. See below |
| What is done by hand once | the project, billing, the APIs, the state bucket, and federated identity for the pipeline: [`docs/runbooks/bootstrap-uat.md`](../docs/runbooks/bootstrap-uat.md) |

## Secrets are not in Terraform, on purpose

Terraform writes its state to a bucket **in plain text**, including every
attribute of every resource it manages. So this configuration creates empty
secret *containers* in Secret Manager and stops there; the owner adds the values
by hand with `gcloud secrets versions add`. A secret passed through Terraform is
a secret stored twice, and the second copy is the one nobody remembers to rotate.

There is deliberately no `google_secret_manager_secret_version` resource
anywhere in `infra/`.

## Usage

```bash
cd infra/envs/uat
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform plan                                  # read it
terraform apply
```

`terraform plan` on a clean tree should report **no changes** after an apply,
even if the pipeline has deployed since. If it wants to change the container
image or the traffic split, something has gone wrong with the `ignore_changes`
block rather than with the deploy.

## Why it is applied by hand and not by CI

One service does not justify a Terraform pipeline, and a CI identity able to
rewrite the environment is a much larger credential than one able to deploy an
image into it. The pipeline's service account can deploy a revision and move
traffic; it cannot change who the service runs as, what it may read, or how far
it may scale.
