#!/usr/bin/env bash
#
# infra.sh — single entrypoint to create/destroy AWS infra for the
# Medusa + Twenty project. Supports EC2 and ECS as alternate compute
# targets on top of a shared VPC/RDS foundation.
#
# Usage:
#   ./infra.sh create vpc
#   ./infra.sh create rds
#   ./infra.sh create ec2
#   ./infra.sh create ecs
#   ./infra.sh create all          # vpc -> rds -> ec2 -> ecs
#   ./infra.sh destroy ecs
#   ./infra.sh destroy ec2
#   ./infra.sh destroy rds
#   ./infra.sh destroy vpc
#   ./infra.sh destroy all         # reverse order
#   ./infra.sh status
#
# All created resource IDs are tracked in ./infra-state.json so destroy
# knows exactly what to tear down. Nothing is inferred by name-guessing.
#
# Requires: awscli v2, jq

set -euo pipefail

# ---------------------------------------------------------------------------
# Config — override any of these via environment variables before running
# ---------------------------------------------------------------------------
export AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT:-medusa-twenty}"
STATE_FILE="${STATE_FILE:-$(dirname "$0")/infra-state.json}"

VPC_CIDR="${VPC_CIDR:-10.0.0.0/16}"
PUBLIC_SUBNET_A_CIDR="${PUBLIC_SUBNET_A_CIDR:-10.0.1.0/24}"
PUBLIC_SUBNET_B_CIDR="${PUBLIC_SUBNET_B_CIDR:-10.0.2.0/24}"
PRIVATE_SUBNET_A_CIDR="${PRIVATE_SUBNET_A_CIDR:-10.0.11.0/24}"
PRIVATE_SUBNET_B_CIDR="${PRIVATE_SUBNET_B_CIDR:-10.0.12.0/24}"

RDS_INSTANCE_CLASS="${RDS_INSTANCE_CLASS:-db.t4g.micro}"
RDS_ENGINE_VERSION="${RDS_ENGINE_VERSION:-16.3}"
RDS_ALLOCATED_STORAGE="${RDS_ALLOCATED_STORAGE:-20}"
RDS_DB_NAME="${RDS_DB_NAME:-medusa}"
RDS_MASTER_USER="${RDS_MASTER_USER:-medusa_admin}"
# RDS_MASTER_PASSWORD must be exported by the caller (or pulled from Vault
# before invoking this script) — never hardcode it here.

EC2_INSTANCE_TYPE="${EC2_INSTANCE_TYPE:-t3.small}"
EC2_KEY_NAME="${EC2_KEY_NAME:?Set EC2_KEY_NAME to an existing EC2 key pair name}"
EC2_AMI_ID="${EC2_AMI_ID:-}"   # auto-resolved to latest Ubuntu 24.04 if unset

ECS_TASK_CPU="${ECS_TASK_CPU:-512}"
ECS_TASK_MEMORY="${ECS_TASK_MEMORY:-1024}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[infra] $*" >&2; }
die()  { echo "[infra][ERROR] $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}
require_cmd aws
require_cmd jq

state_init() {
  [ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"
}

state_get() {
  jq -r --arg k "$1" '.[$k] // empty' "$STATE_FILE"
}

state_set() {
  local tmp
  tmp="$(mktemp)"
  jq --arg k "$1" --arg v "$2" '.[$k] = $v' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

state_unset() {
  local tmp
  tmp="$(mktemp)"
  jq --arg k "$1" 'del(.[$k])' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

tag_spec() {
  # Usage: tag_spec <resource-type> <name-suffix>
  echo "ResourceType=$1,Tags=[{Key=Project,Value=$PROJECT},{Key=Name,Value=$PROJECT-$2}]"
}

state_init

# ---------------------------------------------------------------------------
# VPC + subnets + IGW + route table + security groups
# ---------------------------------------------------------------------------
create_vpc() {
  if [ -n "$(state_get vpc_id)" ]; then
    log "VPC already exists ($(state_get vpc_id)), skipping"
    return
  fi

  log "Creating VPC..."
  local vpc_id
  vpc_id=$(aws ec2 create-vpc --cidr-block "$VPC_CIDR" \
    --tag-specifications "$(tag_spec vpc vpc)" \
    --query 'Vpc.VpcId' --output text)
  aws ec2 modify-vpc-attribute --vpc-id "$vpc_id" --enable-dns-hostnames
  state_set vpc_id "$vpc_id"

  log "Creating subnets..."
  local azs
  azs=($(aws ec2 describe-availability-zones --query 'AvailabilityZones[].ZoneName' --output text))

  local pub_a pub_b priv_a priv_b
  pub_a=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$PUBLIC_SUBNET_A_CIDR" \
    --availability-zone "${azs[0]}" --tag-specifications "$(tag_spec subnet public-a)" \
    --query 'Subnet.SubnetId' --output text)
  pub_b=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$PUBLIC_SUBNET_B_CIDR" \
    --availability-zone "${azs[1]}" --tag-specifications "$(tag_spec subnet public-b)" \
    --query 'Subnet.SubnetId' --output text)
  priv_a=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$PRIVATE_SUBNET_A_CIDR" \
    --availability-zone "${azs[0]}" --tag-specifications "$(tag_spec subnet private-a)" \
    --query 'Subnet.SubnetId' --output text)
  priv_b=$(aws ec2 create-subnet --vpc-id "$vpc_id" --cidr-block "$PRIVATE_SUBNET_B_CIDR" \
    --availability-zone "${azs[1]}" --tag-specifications "$(tag_spec subnet private-b)" \
    --query 'Subnet.SubnetId' --output text)

  state_set subnet_public_a "$pub_a"
  state_set subnet_public_b "$pub_b"
  state_set subnet_private_a "$priv_a"
  state_set subnet_private_b "$priv_b"

  log "Creating internet gateway + routing..."
  local igw_id rt_id
  igw_id=$(aws ec2 create-internet-gateway --tag-specifications "$(tag_spec internet-gateway igw)" \
    --query 'InternetGateway.InternetGatewayId' --output text)
  aws ec2 attach-internet-gateway --vpc-id "$vpc_id" --internet-gateway-id "$igw_id"
  state_set igw_id "$igw_id"

  rt_id=$(aws ec2 create-route-table --vpc-id "$vpc_id" --tag-specifications "$(tag_spec route-table public-rt)" \
    --query 'RouteTable.RouteTableId' --output text)
  aws ec2 create-route --route-table-id "$rt_id" --destination-cidr-block 0.0.0.0/0 --gateway-id "$igw_id" >/dev/null
  aws ec2 associate-route-table --route-table-id "$rt_id" --subnet-id "$pub_a" >/dev/null
  aws ec2 associate-route-table --route-table-id "$rt_id" --subnet-id "$pub_b" >/dev/null
  state_set route_table_id "$rt_id"

  aws ec2 modify-subnet-attribute --subnet-id "$pub_a" --map-public-ip-on-launch
  aws ec2 modify-subnet-attribute --subnet-id "$pub_b" --map-public-ip-on-launch

  log "Creating security groups..."
  local sg_web sg_rds
  sg_web=$(aws ec2 create-security-group --group-name "$PROJECT-web" \
    --description "Web/app tier — HTTP/HTTPS/SSH" --vpc-id "$vpc_id" \
    --tag-specifications "$(tag_spec security-group web)" \
    --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$sg_web" --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$sg_web" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$sg_web" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  state_set sg_web "$sg_web"

  sg_rds=$(aws ec2 create-security-group --group-name "$PROJECT-rds" \
    --description "Postgres — only from web tier" --vpc-id "$vpc_id" \
    --tag-specifications "$(tag_spec security-group rds)" \
    --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$sg_rds" --protocol tcp --port 5432 \
    --source-group "$sg_web" >/dev/null
  state_set sg_rds "$sg_rds"

  log "VPC stack created."
}

destroy_vpc() {
  local vpc_id
  vpc_id="$(state_get vpc_id)"
  [ -z "$vpc_id" ] && { log "No VPC in state, skipping"; return; }

  log "Deleting security groups..."
  for key in sg_rds sg_web; do
    local sg
    sg="$(state_get "$key")"
    [ -n "$sg" ] && aws ec2 delete-security-group --group-id "$sg" && state_unset "$key"
  done

  log "Deleting route table associations and route table..."
  local rt_id
  rt_id="$(state_get route_table_id)"
  if [ -n "$rt_id" ]; then
    for assoc in $(aws ec2 describe-route-tables --route-table-ids "$rt_id" \
        --query 'RouteTables[0].Associations[?Main==`false`].RouteTableAssociationId' --output text); do
      aws ec2 disassociate-route-table --association-id "$assoc" || true
    done
    aws ec2 delete-route-table --route-table-id "$rt_id"
    state_unset route_table_id
  fi

  log "Detaching and deleting internet gateway..."
  local igw_id
  igw_id="$(state_get igw_id)"
  if [ -n "$igw_id" ]; then
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw_id" --vpc-id "$vpc_id" || true
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw_id"
    state_unset igw_id
  fi

  log "Deleting subnets..."
  for key in subnet_public_a subnet_public_b subnet_private_a subnet_private_b; do
    local sn
    sn="$(state_get "$key")"
    [ -n "$sn" ] && aws ec2 delete-subnet --subnet-id "$sn" && state_unset "$key"
  done

  log "Deleting VPC..."
  aws ec2 delete-vpc --vpc-id "$vpc_id"
  state_unset vpc_id

  log "VPC stack destroyed."
}

# ---------------------------------------------------------------------------
# RDS (Postgres)
# ---------------------------------------------------------------------------
create_rds() {
  [ -n "$(state_get vpc_id)" ] || die "Run 'create vpc' first"
  [ -n "${RDS_MASTER_PASSWORD:-}" ] || die "Export RDS_MASTER_PASSWORD before running (pull from Vault)"

  if [ -n "$(state_get rds_instance_id)" ]; then
    log "RDS instance already exists, skipping"
    return
  fi

  log "Creating DB subnet group..."
  local subnet_group="$PROJECT-db-subnets"
  aws rds create-db-subnet-group \
    --db-subnet-group-name "$subnet_group" \
    --db-subnet-group-description "$PROJECT private subnets" \
    --subnet-ids "$(state_get subnet_private_a)" "$(state_get subnet_private_b)" \
    --tags "Key=Project,Value=$PROJECT" >/dev/null
  state_set rds_subnet_group "$subnet_group"

  log "Creating RDS instance (this takes several minutes)..."
  local instance_id="$PROJECT-postgres"
  aws rds create-db-instance \
    --db-instance-identifier "$instance_id" \
    --db-instance-class "$RDS_INSTANCE_CLASS" \
    --engine postgres \
    --engine-version "$RDS_ENGINE_VERSION" \
    --allocated-storage "$RDS_ALLOCATED_STORAGE" \
    --db-name "$RDS_DB_NAME" \
    --master-username "$RDS_MASTER_USER" \
    --master-user-password "$RDS_MASTER_PASSWORD" \
    --vpc-security-group-ids "$(state_get sg_rds)" \
    --db-subnet-group-name "$subnet_group" \
    --backup-retention-period 7 \
    --no-publicly-accessible \
    --tags "Key=Project,Value=$PROJECT" >/dev/null
  state_set rds_instance_id "$instance_id"

  log "Waiting for RDS to become available..."
  aws rds wait db-instance-available --db-instance-identifier "$instance_id"

  local endpoint
  endpoint=$(aws rds describe-db-instances --db-instance-identifier "$instance_id" \
    --query 'DBInstances[0].Endpoint.Address' --output text)
  state_set rds_endpoint "$endpoint"

  log "RDS available at: $endpoint (store the full DATABASE_URL in Vault, not here)"
}

destroy_rds() {
  local instance_id
  instance_id="$(state_get rds_instance_id)"
  if [ -n "$instance_id" ]; then
    log "Deleting RDS instance (final snapshot skipped — portfolio scope; add --final-db-snapshot-identifier for prod)..."
    aws rds delete-db-instance --db-instance-identifier "$instance_id" --skip-final-snapshot >/dev/null
    aws rds wait db-instance-deleted --db-instance-identifier "$instance_id"
    state_unset rds_instance_id
    state_unset rds_endpoint
  fi

  local subnet_group
  subnet_group="$(state_get rds_subnet_group)"
  if [ -n "$subnet_group" ]; then
    aws rds delete-db-subnet-group --db-subnet-group-name "$subnet_group"
    state_unset rds_subnet_group
  fi

  log "RDS destroyed."
}

# ---------------------------------------------------------------------------
# EC2 (simple Docker host — one instance, docker-compose pulled/run via user-data)
# ---------------------------------------------------------------------------
resolve_ami() {
  [ -n "$EC2_AMI_ID" ] && { echo "$EC2_AMI_ID"; return; }
  aws ec2 describe-images \
    --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
               "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text
}

create_ec2() {
  [ -n "$(state_get vpc_id)" ] || die "Run 'create vpc' first"

  if [ -n "$(state_get ec2_instance_id)" ]; then
    log "EC2 instance already exists, skipping"
    return
  fi

  local ami
  ami=$(resolve_ami)
  log "Using AMI: $ami"

  local user_data
  user_data=$(cat <<'EOF'
#!/bin/bash
apt-get update -y
apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker
EOF
)

  log "Launching EC2 instance..."
  local instance_id
  instance_id=$(aws ec2 run-instances \
    --image-id "$ami" \
    --instance-type "$EC2_INSTANCE_TYPE" \
    --key-name "$EC2_KEY_NAME" \
    --subnet-id "$(state_get subnet_public_a)" \
    --security-group-ids "$(state_get sg_web)" \
    --user-data "$user_data" \
    --tag-specifications "$(tag_spec instance docker-host)" \
    --query 'Instances[0].InstanceId' --output text)
  state_set ec2_instance_id "$instance_id"

  log "Waiting for instance to be running..."
  aws ec2 wait instance-running --instance-ids "$instance_id"

  local public_ip
  public_ip=$(aws ec2 describe-instances --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  state_set ec2_public_ip "$public_ip"

  log "EC2 instance running at $public_ip (Docker installed via user-data)."
}

destroy_ec2() {
  local instance_id
  instance_id="$(state_get ec2_instance_id)"
  [ -z "$instance_id" ] && { log "No EC2 instance in state, skipping"; return; }

  log "Terminating EC2 instance..."
  aws ec2 terminate-instances --instance-ids "$instance_id" >/dev/null
  aws ec2 wait instance-terminated --instance-ids "$instance_id"
  state_unset ec2_instance_id
  state_unset ec2_public_ip

  log "EC2 destroyed."
}

# ---------------------------------------------------------------------------
# ECS (Fargate cluster + task execution role — service/task-def creation is
# handled by the CI deploy script, not here; this only provisions the
# platform the deploy step targets)
# ---------------------------------------------------------------------------
create_ecs() {
  [ -n "$(state_get vpc_id)" ] || die "Run 'create vpc' first"

  if [ -n "$(state_get ecs_cluster_name)" ]; then
    log "ECS cluster already exists, skipping"
    return
  fi

  log "Creating ECS cluster..."
  local cluster_name="$PROJECT-cluster"
  aws ecs create-cluster --cluster-name "$cluster_name" \
    --tags "key=Project,value=$PROJECT" >/dev/null
  state_set ecs_cluster_name "$cluster_name"

  log "Creating task execution IAM role (if not already present)..."
  local role_name="$PROJECT-ecs-execution-role"
  if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role_name" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": {"Service": "ecs-tasks.amazonaws.com"},
          "Action": "sts:AssumeRole"
        }]
      }' >/dev/null
    aws iam attach-role-policy --role-name "$role_name" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
  fi
  state_set ecs_execution_role "$role_name"

  log "ECS platform ready. Task definitions and services are created by the deploy pipeline, not this script."
}

destroy_ecs() {
  local cluster_name
  cluster_name="$(state_get ecs_cluster_name)"

  if [ -n "$cluster_name" ]; then
    log "Stopping any running services/tasks in cluster (if present)..."
    for svc in $(aws ecs list-services --cluster "$cluster_name" --query 'serviceArns[]' --output text); do
      aws ecs update-service --cluster "$cluster_name" --service "$svc" --desired-count 0 >/dev/null
      aws ecs delete-service --cluster "$cluster_name" --service "$svc" --force >/dev/null
    done
    aws ecs delete-cluster --cluster "$cluster_name" >/dev/null
    state_unset ecs_cluster_name
  fi

  local role_name
  role_name="$(state_get ecs_execution_role)"
  if [ -n "$role_name" ]; then
    aws iam detach-role-policy --role-name "$role_name" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy || true
    aws iam delete-role --role-name "$role_name" || true
    state_unset ecs_execution_role
  fi

  log "ECS destroyed."
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
create_all() {
  create_vpc
  create_rds
  create_ec2
  create_ecs
}

destroy_all() {
  destroy_ecs
  destroy_ec2
  destroy_rds
  destroy_vpc
}

status() {
  log "Current infra state ($STATE_FILE):"
  jq . "$STATE_FILE"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
ACTION="${1:-}"
TARGET="${2:-}"

case "$ACTION" in
  create)
    case "$TARGET" in
      vpc) create_vpc ;;
      rds) create_rds ;;
      ec2) create_ec2 ;;
      ecs) create_ecs ;;
      all) create_all ;;
      *) die "Unknown create target: $TARGET (vpc|rds|ec2|ecs|all)" ;;
    esac
    ;;
  destroy)
    case "$TARGET" in
      vpc) destroy_vpc ;;
      rds) destroy_rds ;;
      ec2) destroy_ec2 ;;
      ecs) destroy_ecs ;;
      all) destroy_all ;;
      *) die "Unknown destroy target: $TARGET (vpc|rds|ec2|ecs|all)" ;;
    esac
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {create|destroy} {vpc|rds|ec2|ecs|all}"
    echo "       $0 status"
    exit 1
    ;;
esac
