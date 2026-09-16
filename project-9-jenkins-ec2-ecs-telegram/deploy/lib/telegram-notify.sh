#!/usr/bin/env bash
# One-shot Telegram message, used by the Jenkinsfile's post{} block to announce a
# deploy's outcome immediately (separate from notifier/status_notifier.py, which is
# the always-on service uptime bot, not a Jenkins pipeline step).
#
# Usage: telegram-notify.sh "message text"
# Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment, pulled from
# Vault via vault-env.sh's vault_kv before calling this script:
#   TELEGRAM_BOT_TOKEN="$(vault_kv secret/medusa-twenty/${ENVIRONMENT}/telegram-bot-token token)"
#   TELEGRAM_CHAT_ID="$(vault_kv secret/medusa-twenty/${ENVIRONMENT}/telegram-chat-id chat_id)"

set -euo pipefail

message="${1:?usage: telegram-notify.sh <message>}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "telegram-notify: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set, skipping notification" >&2
  exit 0
fi

curl -sS --fail-with-body \
  --max-time 10 \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_CHAT_ID}" \
  --data-urlencode text="${message}" \
  -o /dev/null
