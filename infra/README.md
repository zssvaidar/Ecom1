# infra.sh — one-place create/destroy for AWS infra

Single bash + awscli script to stand up and tear down the AWS side of the project:
VPC/subnets/security groups, RDS (Postgres), and both compute targets (EC2 and ECS)
side by side, so you can use either now and the other later without re-provisioning
the network layer.

## Requires
- `awscli` v2, configured (`aws configure` or an assumed role) with permissions for
  EC2, RDS, ECS, IAM
- `jq`
- An existing EC2 key pair (for SSH access to the EC2 target)

## State tracking
Every resource ID created is written to `infra-state.json` next to the script. Destroy
commands read from this file — nothing is name-guessed. **Keep this file** (or check it
into a private location, not committed publicly since it reveals resource IDs) between
create and destroy runs.

## Usage

```bash
# One-time: pull the RDS master password from Vault and export it
export RDS_MASTER_PASSWORD="$(vault kv get -field=password secret/medusa-twenty/prod/rds-master)"
export EC2_KEY_NAME="your-existing-keypair-name"

# Bring up everything
./infra.sh create all

# Or bring up pieces individually, in order
./infra.sh create vpc
./infra.sh create rds
./infra.sh create ec2
./infra.sh create ecs

# Check what's currently provisioned
./infra.sh status

# Tear down everything (reverse order, RDS uses skip-final-snapshot — portfolio scope)
./infra.sh destroy all

# Or tear down one piece
./infra.sh destroy ec2
```

## What this script does NOT do
- Does not deploy application code or create ECS services/task definitions — that's
  the CI/CD pipeline's job (`deploy-ec2.sh` / `deploy-ecs.sh`, called from Jenkins per
  `docs-specs/15-cicd.md`). This script only provisions the platform those deploy
  scripts target.
- Does not create an Application Load Balancer — add `create_alb`/`destroy_alb`
  functions following the same state-file pattern if/when you front EC2 or ECS with
  one.
- Does not manage Twenty, Vault, or Jenkins infra — those are assumed to already exist
  per your self-hosted setup.

## Config overrides
All defaults (region, CIDR ranges, instance sizes, etc.) are environment variables at
the top of `infra.sh` — override any of them by exporting before running, e.g.:

```bash
AWS_REGION=ap-northeast-1 RDS_INSTANCE_CLASS=db.t4g.small ./infra.sh create rds
```
