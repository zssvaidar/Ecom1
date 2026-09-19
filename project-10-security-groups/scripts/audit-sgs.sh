#!/usr/bin/env bash
# audit-sgs.sh <vpc-id>
#
# Read-only. Reports the same handful of security-group mistakes every AWS
# account accumulates over time, so they get caught by a script instead of a
# breach report. Exits non-zero if any HIGH-severity finding was reported -
# safe to wire into a CI gate (e.g. before a Jenkins prod deploy) without
# rewriting this script.
#
#   ./audit-sgs.sh vpc-0123456789abcdef0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sg-lib.sh
source "$SCRIPT_DIR/lib/sg-lib.sh"

VPC_ID="${1:?usage: audit-sgs.sh <vpc-id>}"

# Ports where "open to the world" is almost always a mistake rather than a
# deliberate choice - a public web tier legitimately opens 80/443 to
# 0.0.0.0/0, so those are NOT in this list.
SENSITIVE_PORTS=(22 23 3389 3306 5432 1433 6379 27017 9200 9300 5984 11211 2379 2380)

FINDINGS_HIGH=0
FINDINGS_MEDIUM=0
report() {
    local severity="$1"; shift
    if [ "$severity" = "HIGH" ]; then FINDINGS_HIGH=$((FINDINGS_HIGH + 1)); else FINDINGS_MEDIUM=$((FINDINGS_MEDIUM + 1)); fi
    printf '[%s] %s\n' "$severity" "$*"
}

log "auditing security groups in ${VPC_ID}"
all_sgs="$(_aws ec2 describe-security-groups --filters "Name=vpc-id,Values=${VPC_ID}" --output json)"

# --- 1. World-open sensitive ports, and any rule with no upper bound on
#        scope (protocol -1 = all protocols/ports, or the full 0-65535 range) ---
#
# Every loop below reads from `< <(...)` process substitution, not `cmd |
# while read` - a piped while's body runs in a subshell, so FINDINGS_HIGH/
# FINDINGS_MEDIUM incremented inside it would vanish the instant the loop
# ends and the final summary would always print 0 regardless of what was
# found. Process substitution keeps the loop body in this shell instead.
echo
echo "== Overly permissive ingress (world-open) =="
while IFS=$'\t' read -r sg_id sg_name proto from to; do
    [ -z "$sg_id" ] && continue
    if [ "$proto" = "-1" ]; then
        report HIGH "${sg_id} (${sg_name}): ALL protocols/ports open to the world (protocol=-1)"
        continue
    fi
    if [ "$from" = "0" ] && [ "$to" = "65535" ]; then
        report HIGH "${sg_id} (${sg_name}): full port range 0-65535/${proto} open to the world"
        continue
    fi
    for p in "${SENSITIVE_PORTS[@]}"; do
        if [ "$from" != "null" ] && [ "$p" -ge "$from" ] 2>/dev/null && [ "$p" -le "$to" ] 2>/dev/null; then
            report HIGH "${sg_id} (${sg_name}): sensitive port ${p} (within ${from}-${to}/${proto}) open to the world"
        fi
    done
done < <(echo "$all_sgs" | jq -r '
    .SecurityGroups[] | . as $sg | $sg.IpPermissions[] as $perm |
    select( ([($perm.IpRanges // [])[]?.CidrIp, ($perm.Ipv6Ranges // [])[]?.CidrIpv6]) | any(. == "0.0.0.0/0" or . == "::/0") ) |
    [$sg.GroupId, $sg.GroupName, $perm.IpProtocol, ($perm.FromPort // "null"), ($perm.ToPort // "null")] | @tsv
')

# --- 2. Unused security groups - not attached to any ENI, so not doing
#        anything except accumulating as clutter (and audit noise) ---
echo
echo "== Unused security groups (not attached to any network interface) =="
in_use="$(_aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query 'NetworkInterfaces[].Groups[].GroupId' --output json)"
while IFS= read -r line; do
    [ -n "$line" ] && report MEDIUM "unused: ${line}"
done < <(echo "$all_sgs" | jq -r --argjson in_use "$in_use" \
    '.SecurityGroups[] | select(.GroupName != "default") | select(.GroupId as $id | $in_use | index($id) | not) | "\(.GroupId) (\(.GroupName))"')

# --- 3. Default security group still has rules - best practice is to leave
#        it empty (no ingress, no egress) and put everything into
#        purpose-named groups instead, so "what can talk to what" is never
#        answered by "whatever's in the group nobody remembers configuring" ---
echo
echo "== Default security group hygiene =="
default_rules="$(echo "$all_sgs" | jq '[.SecurityGroups[] | select(.GroupName == "default") | (.IpPermissions | length) + (.IpPermissionsEgress | length)] | add // 0')"
if [ "$default_rules" -gt 0 ]; then
    report MEDIUM "the VPC's default security group has ${default_rules} rule(s) - move anything relying on it into a purpose-named group instead"
else
    echo "default security group has no rules - good"
fi

# --- 4. Rule-count quota - default is 60 inbound + 60 outbound per group
#        (raisable, but a group creeping toward it is usually a sign it's
#        doing too many unrelated things and should split by tier/role) ---
echo
echo "== Rule count vs. default quota (60 in / 60 out) =="
while IFS=$'\t' read -r sg_id sg_name in_count out_count; do
    [ -z "$sg_id" ] && continue
    if [ "$in_count" -ge 45 ] || [ "$out_count" -ge 45 ]; then
        report MEDIUM "approaching default 60-rule quota: ${sg_id} (${sg_name}): ${in_count} in, ${out_count} out"
    fi
done < <(echo "$all_sgs" | jq -r '.SecurityGroups[] | [.GroupId, .GroupName, (.IpPermissions | length), (.IpPermissionsEgress | length)] | @tsv')

# --- 5. Rules with no description - not wrong, just harder to audit six
#        months from now when nobody remembers why port 8443 is open ---
echo
echo "== Rules missing a description =="
while IFS= read -r line; do
    [ -n "$line" ] && report MEDIUM "no description: ${line}"
done < <(echo "$all_sgs" | jq -r '
    .SecurityGroups[] | .GroupId as $id |
    (.IpPermissions[]?, .IpPermissionsEgress[]?) as $perm |
    (($perm.IpRanges // [])[], ($perm.Ipv6Ranges // [])[], ($perm.UserIdGroupPairs // [])[], ($perm.PrefixListIds // [])[]) |
    select((.Description // "") == "") |
    "\($id): \($perm.IpProtocol)/\($perm.FromPort // "?")-\($perm.ToPort // "?")"
' 2>/dev/null | sort -u)

echo
echo "== Summary =="
echo "HIGH findings:   ${FINDINGS_HIGH}"
echo "MEDIUM findings: ${FINDINGS_MEDIUM}"

[ "$FINDINGS_HIGH" -eq 0 ]
