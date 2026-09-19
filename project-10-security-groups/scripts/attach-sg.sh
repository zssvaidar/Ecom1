#!/usr/bin/env bash
# attach-sg.sh <target-type> <attach|detach> <target-id> <sg-id>
#
# target-type: instance | eni | rds | alb
#
# Every path here reads the target's CURRENT security groups first and merges
# in (or removes) just the one requested - never a bare `--groups <sg-id>`,
# which on EC2/RDS/ELB APIs alike REPLACES the whole list and silently
# detaches everything else. See lib/sg-lib.sh's attach_sg_to_* functions for
# the actual merge logic; this script is just the CLI over them.
#
#   ./attach-sg.sh instance attach i-0123456789abcdef0 sg-0123456789abcdef0
#   ./attach-sg.sh instance detach i-0123456789abcdef0 sg-0123456789abcdef0
#   ./attach-sg.sh eni      attach eni-0123456789abcdef0 sg-0123456789abcdef0
#   ./attach-sg.sh rds      attach my-db-instance sg-0123456789abcdef0
#   ./attach-sg.sh alb      attach arn:aws:elasticloadbalancing:...:loadbalancer/app/my-lb/... sg-0123456789abcdef0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sg-lib.sh
source "$SCRIPT_DIR/lib/sg-lib.sh"

TARGET_TYPE="${1:?usage: attach-sg.sh <instance|eni|rds|alb> <attach|detach> <target-id> <sg-id>}"
ACTION="${2:?usage: attach-sg.sh <instance|eni|rds|alb> <attach|detach> <target-id> <sg-id>}"
TARGET_ID="${3:?usage: attach-sg.sh <instance|eni|rds|alb> <attach|detach> <target-id> <sg-id>}"
SG_ID="${4:?usage: attach-sg.sh <instance|eni|rds|alb> <attach|detach> <target-id> <sg-id>}"

# Fail fast on the most common mistake: passing a security group ID that
# doesn't exist in the region you're pointed at (wrong AWS_REGION, typo, or a
# group from a different VPC - AWS itself will refuse the attach with a much
# less specific error if this check is skipped).
_aws ec2 describe-security-groups --group-ids "$SG_ID" >/dev/null \
    || die "security group ${SG_ID} not found in region ${AWS_REGION} - check AWS_REGION and the ID"

case "${TARGET_TYPE}:${ACTION}" in
    instance:attach) attach_sg_to_instance "$TARGET_ID" "$SG_ID" ;;
    instance:detach) detach_sg_from_instance "$TARGET_ID" "$SG_ID" ;;
    eni:attach)       attach_sg_to_eni "$TARGET_ID" "$SG_ID" ;;
    eni:detach)       detach_sg_from_eni "$TARGET_ID" "$SG_ID" ;;
    rds:attach)       attach_sg_to_rds "$TARGET_ID" "$SG_ID" ;;
    alb:attach)       attach_sg_to_alb "$TARGET_ID" "$SG_ID" ;;
    rds:detach|alb:detach)
        die "detach for ${TARGET_TYPE} isn't implemented - RDS/ALB security groups are typically managed as a fixed set via apply-rules.sh + re-attach, not detached individually. Use the AWS CLI directly with the merged list if you really need this." ;;
    *)
        die "unknown target-type '${TARGET_TYPE}' or action '${ACTION}' (target-type: instance|eni|rds|alb, action: attach|detach)" ;;
esac
