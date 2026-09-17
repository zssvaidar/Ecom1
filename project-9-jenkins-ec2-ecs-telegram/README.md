# project-9 — Jenkins CD to EC2 + ECS, multi-language containers, Telegram uptime bot

Continues the `project-N` series from
[`awscli-vault-jenkins-cd-stack`](https://github.com/zssvaidar/awscli-vault-jenkins-cd-stack)
(project-6 there is this same Medusa+Twenty stack). It fills in the pieces that
`docs/specs/15-cicd.md` and `infra/README.md` describe but this repo never actually
built: a real Jenkinsfile, the `deploy-ec2.sh` / `deploy-ecs.sh` scripts `infra/README.md`
says belong to "the CI/CD pipeline's job", and per-service ECS task definitions.

Nothing outside this directory is modified — `infra/infra.sh` still owns provisioning
the VPC/RDS/EC2/ECS platform; everything here targets that already-provisioned platform.

## Layout

```
Jenkinsfile                    # declarative pipeline: lint/test -> build -> push -> deploy
deploy/
  deploy-ec2.sh                 # SSH + docker pull/run rollout across EC2 targets
  deploy-ecs.sh                 # register task def revision, update service, wait-stable
  lib/
    vault-env.sh                 # short-lived AWS creds from Vault's AWS secrets engine
    telegram-notify.sh           # one-shot Telegram message, used by Jenkinsfile post{}
ecs/
  task-def.template.json         # envsubst'd per service by deploy-ecs.sh
notifier/                        # standalone always-on service, NOT part of the Jenkins agent
  status_notifier.py             # polls each target, alerts Telegram on up/down transitions
  Dockerfile                     # Python 3.12 — the "different language" container
  requirements.txt
  docker-compose.yml             # run the notifier on its own (EC2) or as an ECS service
  .env.example
```

## Why Vault + short-lived AWS creds

Same pattern as `awscli-vault-jenkins-cd-stack`: Jenkins never holds a long-lived AWS
key. `deploy/lib/vault-env.sh` calls Vault's AWS secrets engine
(`vault read aws/creds/<role>`) at the start of each deploy stage, exports the returned
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` for that stage only,
and lets them expire on their own — nothing is written to disk or to a Jenkins log.
Non-AWS secrets (Telegram bot token, SSH deploy key) still come from Vault paths under
`secret/medusa-twenty/<env>/...` per `docs/specs/14-env-secrets.md`.

## Jenkins pipeline (`Jenkinsfile`)

Parameters: `ENVIRONMENT` (staging/prod), `DEPLOY_TARGET` (ec2/ecs/both).

1. **Checkout**
2. **Vault creds** — `vault-env.sh`, scoped to the stage that needs AWS access
3. **Lint + Test** — `npm run lint`, `npm run test` (same tasks as `.github/workflows/ci.yml`)
4. **Build images** (parallel, one per language/runtime):
   - `apps/backend/Dockerfile` (Node 22 — Medusa)
   - `apps/storefront-brand-a/Dockerfile`, `apps/storefront-brand-b/Dockerfile` (Node 22 — Next.js)
   - `notifier/Dockerfile` (Python 3.12 — the uptime bot)
5. **Push to ECR** — tagged `<service>:<git-sha>`
6. **Deploy staging** — EC2 and/or ECS per `DEPLOY_TARGET`, auto on merge to `main`
7. **Manual approval** — required before prod, matches `docs/specs/15-cicd.md`
8. **Deploy prod** — same scripts, prod config/secrets
9. **post{}** — always notifies Telegram (success or failure) via `telegram-notify.sh`,
   independent of the always-on `notifier/` service, so a bad deploy is announced
   immediately rather than waiting for the next health poll.

## EC2 rollout (`deploy/deploy-ec2.sh`)

Reads target hosts from `EC2_HOSTS` (comma-separated, or resolved by the `deploy`
tag from `infra-state.json` when unset). Per host: `docker pull` the new tag, start it
alongside the running container, poll `/health` (backend) or `/` (storefronts) until it
answers, flip traffic, then stop the old container. On a failed health poll it leaves
the old container running and exits non-zero — no automatic rollback beyond that
(portfolio scope, no blue-green, matches `infra/README.md`).

## ECS rollout (`deploy/deploy-ecs.sh`)

Renders `ecs/task-def.template.json` for the given service/image/port, calls
`aws ecs register-task-definition`, then checks whether the service already exists
(`aws ecs describe-services`) — `create-service` on the first-ever deploy for that
service, `update-service --force-new-deployment` on every one after — and waits for
`aws ecs wait services-stable`. On a timed-out wait it re-registers and switches the
service back to the previous task definition revision (ECS keeps old revisions around,
so this is just pointing `update-service` at `family:previous-revision`).

**`SECURITY_GROUP_ID` / `SUBNET_IDS`** — required, and deliberately NOT something
`infra/infra.sh` provides: `create_vpc()` there makes `sg_web` (for EC2) and `sg_rds`
(for RDS) but no ECS security group, and `create_ecs()` explicitly defers "task
definitions and services" to the deploy pipeline — this script. `infra.sh` is an
existing file this project doesn't touch, so the ECS security group is a one-time
manual step instead of something `infra.sh create ecs` does for you:

```bash
# Run once per environment. Mirrors infra.sh's own sg_web (see infra/infra.sh:151-160)
# in style - open the app ports to 0.0.0.0/0, since there's no ALB in front yet
# (infra/README.md notes create_alb/destroy_alb as a not-yet-built follow-up).
# Tighten the --cidr to a specific ALB/VPC source once one exists instead.
VPC_ID="$(jq -r .vpc_id ../infra/infra-state.json)"
SG_ID=$(aws ec2 create-security-group --group-name medusa-twenty-ecs \
  --description "ECS tasks - backend/storefronts/notifier" --vpc-id "$VPC_ID" \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=Project,Value=medusa-twenty},{Key=Name,Value=medusa-twenty-ecs}]' \
  --query 'GroupId' --output text)
for port in 9000 8000 8001 8080; do
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port "$port" --cidr 0.0.0.0/0
done
echo "$SG_ID"   # -> export SECURITY_GROUP_ID=... for deploy-ecs.sh / the Jenkinsfile
```

Reuse `infra.sh`'s public subnets for `SUBNET_IDS` (same ones `create_ec2` launches
into): `jq -r '"\(.subnet_public_a),\(.subnet_public_b)"' infra/infra-state.json`.

Note this is a **network**-layer resource, not an IAM one — it's not part of the
Jenkins user/role/policy setup in `awscli-vault-jenkins-cd-stack/project-8`. That
project's `jenkins-role` is scoped by AWS *service* (`set_1 = ec2, rds`); the security
group ID above is just a value Jenkins reads (from Vault or a job parameter) and
passes through to `ecs create-service`/`update-service` — it never needs
`ec2:CreateSecurityGroup`/`AuthorizeSecurityGroupIngress` permission for a normal
deploy, only whoever runs the one-time command above does.

## Telegram uptime notifier (`notifier/`)

A small always-on Python service, independent of Jenkins — it runs continuously on an
EC2 box or as its own ECS service, not as a pipeline step. Every `CHECK_INTERVAL_SECONDS`
it:

- HTTP-checks each configured target (backend `/health`, both storefronts' `/`)
- optionally checks ECS service health via `describe-services`
  (`runningCount == desiredCount`) and EC2 instance status via
  `describe-instance-status`, when `ECS_CLUSTER`/`ECS_SERVICES` or `EC2_INSTANCE_IDS`
  are set
- only alerts on a **transition** (up→down or down→up), after `FAILURE_THRESHOLD`
  consecutive bad checks, to avoid flapping noise on a single dropped request
- persists last-known state to `/data/state.json` (bind-mount or ECS EFS volume) so a
  notifier restart doesn't re-fire alerts for state that hasn't actually changed

See `notifier/.env.example` for every variable. Run it locally:

```bash
cd notifier
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID and TARGETS
docker compose up --build
```

## What this does not do

- Does not provision infrastructure — that's still `infra/infra.sh` (VPC/RDS/EC2/ECS).
- Does not stand up Jenkins or Vault themselves — assumed to already exist per
  `docs/specs/15-cicd.md`'s "self-hosted infra this repo doesn't have" note, same as the
  Jenkins/Vault containers in `awscli-vault-jenkins-cd-stack`.
- Does not add a load balancer or blue-green deploy — same portfolio-scope call as
  `infra/README.md` makes for the base platform.
