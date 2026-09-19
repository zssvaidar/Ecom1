#!/usr/bin/env bash
# apply-rules.sh <sg-id> <rules-file.json> [--prune]
#
# Reconciles a security group's rules against a declarative JSON file instead
# of a one-off `authorize-security-group-ingress` call per rule - the file is
# the source of truth, this script is safe to re-run on every deploy, and
# with --prune it also removes rules that are present on the group but no
# longer in the file (drift back to "only what's declared", including
# catching a rule someone added by hand in the console).
#
# Rules file shape (see ../examples/*.json):
#   {
#     "ingress": [
#       {"protocol":"tcp","from_port":443,"to_port":443,"source_type":"cidr","source":"0.0.0.0/0","description":"HTTPS from internet"},
#       {"protocol":"tcp","from_port":5432,"to_port":5432,"source_type":"sg","source":"sg-0123...","description":"Postgres from app tier"}
#     ],
#     "egress": [ ... same shape ... ]
#   }
# source_type is one of: cidr | cidr6 | sg | prefix-list (see sg-lib.sh's _rule_json)
#
#   ./apply-rules.sh sg-0123 ../examples/rules-web-tier.json
#   ./apply-rules.sh sg-0123 ../examples/rules-db-tier.json --prune

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sg-lib.sh
source "$SCRIPT_DIR/lib/sg-lib.sh"

SG_ID="${1:?usage: apply-rules.sh <sg-id> <rules-file.json> [--prune]}"
RULES_FILE="${2:?usage: apply-rules.sh <sg-id> <rules-file.json> [--prune]}"
PRUNE=0
[ "${3:-}" = "--prune" ] && PRUNE=1

[ -f "$RULES_FILE" ] || die "rules file not found: $RULES_FILE"
jq empty "$RULES_FILE" || die "rules file is not valid JSON: $RULES_FILE"

apply_direction() {
    local direction="$1" jq_key="$2" ensure_fn="$3"
    local n; n="$(jq --arg k "$jq_key" '(.[$k] // []) | length' "$RULES_FILE")"
    log "${direction}: ${n} declared rule(s) in ${RULES_FILE}"

    for i in $(seq 0 $((n - 1))); do
        local rule; rule="$(jq -c --arg k "$jq_key" --argjson i "$i" '.[$k][$i]' "$RULES_FILE")"
        local proto from to stype sval desc
        proto="$(echo "$rule" | jq -r '.protocol')"
        from="$(echo "$rule" | jq -r '.from_port')"
        to="$(echo "$rule" | jq -r '.to_port')"
        stype="$(echo "$rule" | jq -r '.source_type')"
        sval="$(echo "$rule" | jq -r '.source')"
        desc="$(echo "$rule" | jq -r '.description // ""')"
        "$ensure_fn" "$SG_ID" "$proto" "$from" "$to" "$stype" "$sval" "$desc"
    done
}

# _flatten_existing <sg-id> <direction> - one line per (protocol, from, to,
# source-type, source-value), used to find rules present on the group but
# NOT in the rules file (candidates for --prune). A single IpPermissions
# entry can carry several sources (e.g. two CidrIps) - flatten each source
# into its own comparable row rather than comparing whole permission blocks.
_flatten_existing() {
    local sg_id="$1" direction="$2"
    local field; [ "$direction" = "ingress" ] && field="IpPermissions" || field="IpPermissionsEgress"
    # FromPort/ToPort are coalesced to the string "null" here, not left as
    # JSON null - a protocol "-1" rule (AWS's own default egress rule on a
    # freshly created group, see ensure_security_group) has no ports at all,
    # and a raw null surviving into @tsv/downstream --argjson comparisons is
    # exactly what broke this the first time it was tested end-to-end
    # against that exact rule (see sg-lib.sh's header comment).
    _aws ec2 describe-security-groups --group-ids "$sg_id" --query "SecurityGroups[0].${field}" \
        | jq -r '
            .[] as $perm
            | ($perm.FromPort // "null") as $from | ($perm.ToPort // "null") as $to
            | ( ($perm.IpRanges // [])[]        | [$perm.IpProtocol, $from, $to, "cidr", .CidrIp] ),
              ( ($perm.Ipv6Ranges // [])[]       | [$perm.IpProtocol, $from, $to, "cidr6", .CidrIpv6] ),
              ( ($perm.UserIdGroupPairs // [])[] | [$perm.IpProtocol, $from, $to, "sg", .GroupId] ),
              ( ($perm.PrefixListIds // [])[]    | [$perm.IpProtocol, $from, $to, "prefix-list", .PrefixListId] )
            | @tsv
          '
}

prune_direction() {
    local direction="$1" jq_key="$2" revoke_fn="$3"
    # Declared from_port/to_port are coalesced to string "null" the same way
    # (this project's schema always requires real ports when DECLARING a
    # rule, but the comparison below has to line up with _flatten_existing's
    # string-typed output regardless of which side happens to be null).
    local declared; declared="$(jq -c --arg k "$jq_key" \
        '[(.[$k] // [])[] | [.protocol, ((.from_port // "null") | tostring), ((.to_port // "null") | tostring), .source_type, .source]]' \
        "$RULES_FILE")"

    while IFS=$'\t' read -r proto from to stype sval; do
        [ -z "$proto" ] && continue
        local is_declared
        is_declared="$(echo "$declared" | jq --arg p "$proto" --arg f "$from" --arg t "$to" --arg st "$stype" --arg sv "$sval" \
            'map(select(.[0]==$p and .[1]==$f and .[2]==$t and .[3]==$st and .[4]==$sv)) | length > 0')"
        if [ "$is_declared" = "false" ]; then
            log "pruning undeclared ${direction} rule: ${proto}/${from}-${to} from ${sval}"
            "$revoke_fn" "$SG_ID" "$proto" "$from" "$to" "$stype" "$sval"
        fi
    done < <(_flatten_existing "$SG_ID" "$direction")
}

apply_direction "ingress" "ingress" ensure_ingress_rule
apply_direction "egress"  "egress"  ensure_egress_rule

if [ "$PRUNE" -eq 1 ]; then
    log "--prune: removing rules present on ${SG_ID} but not declared in ${RULES_FILE}"
    prune_direction "ingress" "ingress" revoke_ingress_rule
    prune_direction "egress"  "egress"  revoke_egress_rule
fi

log "done reconciling ${SG_ID} against ${RULES_FILE}"
