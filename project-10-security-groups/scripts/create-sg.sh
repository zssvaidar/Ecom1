#!/usr/bin/env bash
# create-sg.sh <vpc-id> <name> <description> [project-tag]
#
# Idempotently create-or-reuse a security group and print its ID on stdout
# (only the ID - safe to capture with $(...) in another script). Re-running
# this with the same <vpc-id>/<name> never fails and never creates a
# duplicate; see ensure_security_group in lib/sg-lib.sh for why.
#
#   SG_ID=$(./create-sg.sh vpc-0123 medusa-twenty-app "App tier - backend/storefronts" medusa-twenty)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sg-lib.sh
source "$SCRIPT_DIR/lib/sg-lib.sh"

VPC_ID="${1:?usage: create-sg.sh <vpc-id> <name> <description> [project-tag]}"
NAME="${2:?usage: create-sg.sh <vpc-id> <name> <description> [project-tag]}"
DESCRIPTION="${3:?usage: create-sg.sh <vpc-id> <name> <description> [project-tag]}"
PROJECT_TAG="${4:-}"

ensure_security_group "$VPC_ID" "$NAME" "$DESCRIPTION" "$PROJECT_TAG"
