#!/usr/bin/env bash
# deploy-ec2.sh <environment>
#
# Rolls the newly-built images out to every EC2 target for <environment>. This is
# the script infra/README.md refers to ("that's the CI/CD pipeline's job
# (deploy-ec2.sh / deploy-ecs.sh, called from Jenkins per docs-specs/15-cicd.md)")
# but that never existed in this repo until now.
#
# Per host, per service: pull the new image tag, start it on a swap port, poll its
# health check, then flip traffic and stop the old container. If the health check
# never passes, the old container is left running and this script exits non-zero —
# no automatic rollback beyond that (portfolio scope, single environment per infra/
# README.md, no blue-green / load balancer in front of EC2 yet).
#
# Inputs:
#   AWS credentials         - exported by deploy/lib/vault-env.sh before this runs
#   ECR_REGISTRY, GIT_SHA   - set by the Jenkinsfile
#   EC2_HOSTS               - comma-separated hostnames/IPs; if unset, resolved from
#                              infra-state.json (written by infra/infra.sh) via the
#                              "deploy" tag
#   EC2_SSH_USER            - default "ec2-user"
#   EC2_SSH_KEY             - path to the private key matching infra.sh's
#                              EC2_KEY_NAME; default ~/.ssh/id_rsa
#   HEALTH_CHECK_RETRIES    - default 20 (with 3s between attempts, so ~60s budget)

set -euo pipefail

ENVIRONMENT="${1:?usage: deploy-ec2.sh <staging|prod>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EC2_SSH_USER="${EC2_SSH_USER:-ec2-user}"
EC2_SSH_KEY="${EC2_SSH_KEY:-$HOME/.ssh/id_rsa}"
HEALTH_CHECK_RETRIES="${HEALTH_CHECK_RETRIES:-20}"

# services: name -> (host container port, health path)
SERVICES=(
  "backend:9000:/health"
  "storefront-a:8000:/"
  "storefront-b:8001:/"
)

resolve_hosts() {
  if [ -n "${EC2_HOSTS:-}" ]; then
    echo "$EC2_HOSTS" | tr ',' '\n'
    return
  fi
  local state_file="${SCRIPT_DIR}/../../infra/infra-state.json"
  if [ ! -f "$state_file" ]; then
    echo "deploy-ec2: EC2_HOSTS not set and no infra-state.json at $state_file" >&2
    exit 1
  fi
  jq -r --arg env "$ENVIRONMENT" \
    '.ec2_instances[] | select(.environment == $env) | .public_ip' \
    "$state_file"
}

deploy_service_on_host() {
  local host="$1" name="$2" port="$3" health_path="$4"
  local image="${ECR_REGISTRY}/${name}:${GIT_SHA}"
  local swap_port=$((port + 10000))

  echo "== ${host}: ${name} -> ${image}"

  ssh -i "$EC2_SSH_KEY" -o StrictHostKeyChecking=accept-new "${EC2_SSH_USER}@${host}" bash -s <<EOF
    set -euo pipefail
    aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
    docker pull "${image}"
    docker rm -f "${name}-next" >/dev/null 2>&1 || true
    docker run -d --name "${name}-next" --restart unless-stopped \
      -p ${swap_port}:${port} \
      -e NODE_ENV=production \
      "${image}"
EOF

  echo "== ${host}: waiting for ${name} health check on :${swap_port}${health_path}"
  local attempt=0
  until curl -sf "http://${host}:${swap_port}${health_path}" >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$HEALTH_CHECK_RETRIES" ]; then
      echo "!! ${host}: ${name} failed health check after ${HEALTH_CHECK_RETRIES} attempts, leaving old container running" >&2
      ssh -i "$EC2_SSH_KEY" -o StrictHostKeyChecking=accept-new "${EC2_SSH_USER}@${host}" \
        docker rm -f "${name}-next" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 3
  done

  echo "== ${host}: ${name} healthy, flipping traffic"
  ssh -i "$EC2_SSH_KEY" -o StrictHostKeyChecking=accept-new "${EC2_SSH_USER}@${host}" bash -s <<EOF
    set -euo pipefail
    docker rm -f "${name}" >/dev/null 2>&1 || true
    docker rm -f "${name}-next"
    docker run -d --name "${name}" --restart unless-stopped \
      -p ${port}:${port} \
      -e NODE_ENV=production \
      "${image}"
EOF
}

hosts="$(resolve_hosts)"
if [ -z "$hosts" ]; then
  echo "deploy-ec2: no EC2 hosts resolved for environment '${ENVIRONMENT}'" >&2
  exit 1
fi

status=0
while IFS= read -r host; do
  [ -z "$host" ] && continue
  for entry in "${SERVICES[@]}"; do
    IFS=':' read -r name port health_path <<< "$entry"
    deploy_service_on_host "$host" "$name" "$port" "$health_path" || status=1
  done
done <<< "$hosts"

exit $status
