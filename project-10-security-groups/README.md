# project-10 — Security groups: create, rule management, attach to instances, audit

Answers the question that came up finishing `project-9-jenkins-ec2-ecs-telegram`
("what about `SECURITY_GROUP_ID` - how do I configure one?") properly: not a
one-off `aws ec2 create-security-group` copy-pasted into a README, but a small
reusable toolkit for the whole lifecycle - create, declare rules, attach to a
resource, audit for drift/mistakes - built on the same idempotent, check-before-act
pattern as this repo's other deploy tooling.

Nothing outside this directory is modified. `infra/infra.sh` still owns `sg_web`/
`sg_rds`; this project's scripts work with those (and with the ECS security group
`project-9-jenkins-ec2-ecs-telegram` needs, per its own README) the same way they'd
work with any security group.

## Layout

```
scripts/
  lib/sg-lib.sh        # the actual logic - see its header for the library-design note
  create-sg.sh          # idempotent create-or-reuse, prints the group ID
  apply-rules.sh         # reconcile a group's rules against a JSON file (+ --prune)
  attach-sg.sh            # attach/detach on an EC2 instance, ENI, RDS instance, or ALB
  audit-sgs.sh             # read-only scan for common mistakes, non-zero exit on HIGH findings
examples/
  rules-web-tier.json    # public tier - only place 0.0.0.0/0 shows up
  rules-app-tier.json     # ingress only from the web tier's SG, not a CIDR
  rules-db-tier.json       # ingress only from the app tier's SG; egress locked to nothing
docs/
  best-practices.md      # 13 rules, each one pointing at the script/line that enforces it
```

## Quickstart

```bash
export AWS_REGION=us-east-1   # matches infra.sh's default

VPC_ID=$(jq -r .vpc_id ../infra/infra-state.json)   # infra.sh already created the VPC

WEB_SG=$(./scripts/create-sg.sh "$VPC_ID" medusa-twenty-app-web  "Web tier"  medusa-twenty)
APP_SG=$(./scripts/create-sg.sh "$VPC_ID" medusa-twenty-app-app  "App tier"  medusa-twenty)
DB_SG=$( ./scripts/create-sg.sh "$VPC_ID" medusa-twenty-app-db   "DB tier"   medusa-twenty)

# Fill in the real IDs before applying - see each example file's header comment
sed -i "s/sg-WEB_TIER_ID/$WEB_SG/" examples/rules-app-tier.json
sed -i "s/sg-APP_TIER_ID/$APP_SG/" examples/rules-db-tier.json
sed -i "s/sg-DB_TIER_ID/$DB_SG/"   examples/rules-app-tier.json

./scripts/apply-rules.sh "$WEB_SG" examples/rules-web-tier.json
./scripts/apply-rules.sh "$APP_SG" examples/rules-app-tier.json
./scripts/apply-rules.sh "$DB_SG"  examples/rules-db-tier.json --prune   # removes default all-outbound egress

# Attach to a running instance - merges with whatever groups it already has,
# never overwrites (see docs/best-practices.md #5)
./scripts/attach-sg.sh instance attach i-0123456789abcdef0 "$WEB_SG"

# Same group, an RDS instance instead
./scripts/attach-sg.sh rds attach my-db-instance "$DB_SG"

# Read-only scan; exits 1 if it finds anything HIGH-severity
./scripts/audit-sgs.sh "$VPC_ID"
```

## The specific `SECURITY_GROUP_ID` question this project started from

Short version (long version in `docs/best-practices.md` and the Jenkins-side note
already added to `project-9-jenkins-ec2-ecs-telegram/README.md`'s "ECS rollout"
section): a security group ID is a **network** resource, created during
infrastructure provisioning (`infra.sh create vpc`, or now, `create-sg.sh` for
anything `infra.sh` doesn't cover like the ECS tier) - it is not part of the Jenkins
IAM user/role/permission setup in `awscli-vault-jenkins-cd-stack/project-8`. Jenkins
just needs the ID handed to it (a job parameter or a non-secret Vault path, per
`docs/specs/14-env-secrets.md`'s secret-vs-config distinction) to pass through to
whatever API call needs it - it doesn't need permission to create or modify security
groups for a normal deploy.

## Testing note

This environment has no live AWS account or Docker daemon, so every script here was
verified against a fake `aws` CLI shim returning canned JSON (`describe-security-groups`,
`describe-network-interfaces`, etc.) rather than skipped as "can't verify" - this
caught two real bugs before they shipped: `audit-sgs.sh`'s finding counters silently
staying at zero (piped `while` loops run in a subshell; fixed with process
substitution) and `lib/sg-lib.sh`'s own `set -euo pipefail` leaking into any script
that sources it (removed from the library; every script that needs it sets it
itself). Neither was visible from reading the code - both only showed up by actually
running it.
