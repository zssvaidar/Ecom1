#!/usr/bin/env bash
# deploy-ecs.sh <environment>
#
# Registers a new task definition revision for each service and rolls the ECS
# service over to it. This is the other half of the script infra/README.md refers
# to but that never existed in this repo until now — infra/infra.sh only
# provisions the ECS cluster, it does not create services or deploy application
# code.
#
# Inputs:
#   AWS credentials              - exported by deploy/lib/vault-env.sh before this runs
#   ECR_REGISTRY, GIT_SHA        - set by the Jenkinsfile
#   ECS_CLUSTER                  - default "medusa-twenty-${ENVIRONMENT}"
#   ECS_EXECUTION_ROLE_ARN
#   ECS_TASK_ROLE_ARN
#   SECURITY_GROUP_ID            - required. infra/infra.sh's create_vpc() makes
#                                   sg_web/sg_rds but no ECS security group - this
#                                   script needs one of its own (see this project's
#                                   README for the one-time `aws ec2
#                                   create-security-group` command to make it,
#                                   infra.sh being off-limits to edit here).
#   SUBNET_IDS                   - required, comma-separated. Use infra.sh's public
#                                   subnets (same ones create_ec2 uses):
#                                   aws ec2 ... | infra-state.json's subnet_public_a/_b
#   AWS_REGION                   - default us-east-1
#   TASK_CPU / TASK_MEMORY       - default 256 / 512 (Fargate minimum)
#
# On a failed `wait services-stable`, this re-points the service at the previous
# task definition revision (ECS retains old revisions) rather than leaving a
# half-rolled-out service running the new, broken one.

set -euo pipefail

ENVIRONMENT="${1:?usage: deploy-ecs.sh <staging|prod>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/../ecs/task-def.template.json"

AWS_REGION="${AWS_REGION:-us-east-1}"
ECS_CLUSTER="${ECS_CLUSTER:-medusa-twenty-${ENVIRONMENT}}"
TASK_CPU="${TASK_CPU:-256}"
TASK_MEMORY="${TASK_MEMORY:-512}"
LOG_GROUP="${LOG_GROUP:-/ecs/medusa-twenty-${ENVIRONMENT}}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:?SECURITY_GROUP_ID is required - see this project's README for how to create the ECS security group}"
SUBNET_IDS="${SUBNET_IDS:?SUBNET_IDS is required (comma-separated) - use infra.sh's public subnet IDs}"

# service -> container port
SERVICES=(
  "backend:9000"
  "storefront-a:8000"
  "storefront-b:8001"
  "notifier:8080"
)

deploy_service() {
  local name="$1" port="$2"
  local family="${name}-${ENVIRONMENT}"
  local image="${ECR_REGISTRY}/${name}:${GIT_SHA}"

  echo "== ${name}: registering task definition ${family} -> ${image}"

  local previous_revision
  previous_revision="$(aws ecs describe-task-definition --task-definition "$family" \
    --query 'taskDefinition.revision' --output text 2>/dev/null || echo "")"

  local rendered
  rendered="$(
    TASK_FAMILY="$family" IMAGE_URI="$image" CONTAINER_PORT="$port" \
    SERVICE_NAME="$name" ENVIRONMENT="$ENVIRONMENT" AWS_REGION="$AWS_REGION" \
    TASK_CPU="$TASK_CPU" TASK_MEMORY="$TASK_MEMORY" LOG_GROUP="$LOG_GROUP" \
    ECS_EXECUTION_ROLE_ARN="$ECS_EXECUTION_ROLE_ARN" ECS_TASK_ROLE_ARN="$ECS_TASK_ROLE_ARN" \
    envsubst < "$TEMPLATE"
  )"

  local new_revision
  new_revision="$(echo "$rendered" | aws ecs register-task-definition \
    --cli-input-json file:///dev/stdin \
    --query 'taskDefinition.revision' --output text)"

  # Idempotent: infra.sh only creates the cluster, never a service (see its own
  # "Task definitions and services are created by the deploy pipeline" log line).
  # First deploy ever for this service must create-service; every deploy after
  # that must update-service instead, or this errors with
  # "Creation of service was not idempotent" / "already exists".
  local subnets_json
  subnets_json="$(printf '%s' "$SUBNET_IDS" | tr ',' '\n' | jq -R . | jq -sc .)"
  local network_config
  network_config="{\"awsvpcConfiguration\":{\"subnets\":${subnets_json},\"securityGroups\":[\"${SECURITY_GROUP_ID}\"],\"assignPublicIp\":\"ENABLED\"}}"

  local service_status
  service_status="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$name" \
    --region "$AWS_REGION" --query 'services[0].status' --output text 2>/dev/null || echo "MISSING")"

  if [ "$service_status" = "ACTIVE" ] || [ "$service_status" = "DRAINING" ]; then
    echo "== ${name}: service already exists (${service_status}), updating to ${family}:${new_revision}"
    aws ecs update-service \
      --cluster "$ECS_CLUSTER" \
      --service "$name" \
      --task-definition "${family}:${new_revision}" \
      --force-new-deployment \
      --region "$AWS_REGION" >/dev/null
  else
    echo "== ${name}: no existing service, creating one on ${family}:${new_revision}"
    aws ecs create-service \
      --cluster "$ECS_CLUSTER" \
      --service-name "$name" \
      --task-definition "${family}:${new_revision}" \
      --desired-count 1 \
      --launch-type FARGATE \
      --network-configuration "$network_config" \
      --region "$AWS_REGION" >/dev/null
  fi

  echo "== ${name}: waiting for service to stabilize"
  if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$name" --region "$AWS_REGION"; then
    echo "!! ${name}: deploy did not stabilize" >&2
    if [ -n "$previous_revision" ]; then
      echo "!! ${name}: rolling back to ${family}:${previous_revision}" >&2
      aws ecs update-service \
        --cluster "$ECS_CLUSTER" \
        --service "$name" \
        --task-definition "${family}:${previous_revision}" \
        --force-new-deployment \
        --region "$AWS_REGION" >/dev/null
    fi
    return 1
  fi
}

status=0
for entry in "${SERVICES[@]}"; do
  IFS=':' read -r name port <<< "$entry"
  deploy_service "$name" "$port" || status=1
done

exit $status
