#!/usr/bin/env bash
# Sourced (not executed) by the other deploy scripts and by the Jenkinsfile's sh
# steps: `. deploy/lib/vault-env.sh`. Provides vault_aws_creds, which pulls
# short-lived AWS credentials from Vault's AWS secrets engine and exports them for
# the rest of the shell session — same pattern as awscli-vault-jenkins-cd-stack:
# Jenkins never holds a long-lived AWS key, and the credentials expire on their own.
#
# Requires VAULT_ADDR set in the environment and either VAULT_TOKEN, or
# VAULT_ROLE_ID/VAULT_SECRET_ID for AppRole login (the Jenkinsfile supplies the
# latter via withCredentials).

set -euo pipefail

vault_login_if_needed() {
  if [ -n "${VAULT_TOKEN:-}" ]; then
    return 0
  fi
  if [ -z "${VAULT_ROLE_ID:-}" ] || [ -z "${VAULT_SECRET_ID:-}" ]; then
    echo "vault-env: need VAULT_TOKEN or VAULT_ROLE_ID+VAULT_SECRET_ID" >&2
    return 1
  fi
  VAULT_TOKEN="$(vault write -field=token auth/approle/login \
    role_id="$VAULT_ROLE_ID" secret_id="$VAULT_SECRET_ID")"
  export VAULT_TOKEN
}

# vault_aws_creds <role-name>
# Reads aws/creds/<role-name>, exports AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
# AWS_SESSION_TOKEN for the rest of the current shell. The Vault policy attached to
# each role is read-only credential retrieval, scoped to what that pipeline stage
# needs (ECR push, EC2 deploy, ECS deploy) — see project-9 README for the mapping.
vault_aws_creds() {
  local role="$1"
  vault_login_if_needed

  local creds
  creds="$(vault read -format=json "aws/creds/${role}")"

  AWS_ACCESS_KEY_ID="$(echo "$creds" | jq -r '.data.access_key')"
  AWS_SECRET_ACCESS_KEY="$(echo "$creds" | jq -r '.data.secret_key')"
  AWS_SESSION_TOKEN="$(echo "$creds" | jq -r '.data.security_token')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

  if [ "$AWS_ACCESS_KEY_ID" = "null" ] || [ -z "$AWS_ACCESS_KEY_ID" ]; then
    echo "vault-env: no credentials returned for role '${role}'" >&2
    return 1
  fi
}

# vault_kv <path> <field>
# Reads a single field out of a KV v2 secret, e.g.
#   TELEGRAM_BOT_TOKEN="$(vault_kv secret/medusa-twenty/${ENVIRONMENT}/telegram-bot-token token)"
vault_kv() {
  local path="$1" field="$2"
  vault_login_if_needed
  vault kv get -field="$field" "$path"
}
