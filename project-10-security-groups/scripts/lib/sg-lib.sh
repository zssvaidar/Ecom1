#!/usr/bin/env bash
# sg-lib.sh - sourced by every script in this project. Every mutating function
# here checks current AWS state before acting: create-or-reuse instead of
# create-or-fail, add-rule-if-missing instead of authorize-and-hope, and
# attach-by-merging instead of attach-by-overwriting (modify-instance-attribute
# --groups REPLACES the instance's security groups wholesale - the naive
# version of "attach a security group" silently detaches every other one).
#
# Not meant to be run directly: `source lib/sg-lib.sh` from a script that sets
# AWS_REGION first.
#
# Deliberately does NOT `set -euo pipefail` itself, even though every script
# in this project that sources it does. `source` runs in the SAME shell as
# the caller, not a subshell - a `set -e` here would silently change the
# caller's own error-handling the instant it sources this file, whether or
# not that's what the caller wanted (confirmed while testing this file: a
# test harness that deliberately ran without -e died mid-script with no
# trace the moment it sourced this file, purely from that side effect). A
# library meant to be sourced sets its callers up to make that choice
# themselves; it doesn't make the choice for them by mutating shell options
# as a side effect of being loaded.

log()  { echo "[sg] $*" >&2; }
die()  { echo "[sg][ERROR] $*" >&2; exit 1; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
require_cmd aws
require_cmd jq

AWS_REGION="${AWS_REGION:-us-east-1}"
_aws() { aws --region "$AWS_REGION" "$@"; }

# ---------------------------------------------------------------------------
# Lookup / create
# ---------------------------------------------------------------------------

# sg_id_by_name <vpc-id> <name> - empty stdout (not an error) if not found, so
# callers can tell "doesn't exist yet" (create it) apart from "AWS API call
# failed" (abort). group-name is unique per VPC, so this is a safe lookup key
# - never guess an ID from a naming pattern instead of asking AWS for it.
sg_id_by_name() {
    local vpc_id="$1" name="$2"
    _aws ec2 describe-security-groups \
        --filters "Name=vpc-id,Values=${vpc_id}" "Name=group-name,Values=${name}" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null \
        | grep -v '^None$' || true
}

# ensure_security_group <vpc-id> <name> <description> [project-tag] - returns
# the group ID on stdout either way. Re-running this with the same name is
# always safe: create-security-group errors on a duplicate group-name, so this
# checks first rather than create-then-catch, which also means a plain `set
# -e` script composed from these functions never needs its own try/catch for
# "already exists".
ensure_security_group() {
    local vpc_id="$1" name="$2" description="$3" project="${4:-}"
    local existing
    existing="$(sg_id_by_name "$vpc_id" "$name")"
    if [ -n "$existing" ]; then
        log "security group '${name}' already exists (${existing}), reusing"
        echo "$existing"
        return 0
    fi

    log "creating security group '${name}'"
    local tag_spec="ResourceType=security-group,Tags=[{Key=Name,Value=${name}}"
    [ -n "$project" ] && tag_spec="${tag_spec},{Key=Project,Value=${project}}"
    tag_spec="${tag_spec}]"

    local sg_id
    sg_id="$(_aws ec2 create-security-group \
        --group-name "$name" --description "$description" --vpc-id "$vpc_id" \
        --tag-specifications "$tag_spec" \
        --query 'GroupId' --output text)"

    # AWS gives every new security group an implicit "allow all outbound"
    # egress rule - not something this script added, but worth knowing about
    # before writing egress rules of your own (see ensure_egress_rule and
    # docs/best-practices.md's "default egress" section).
    log "created ${sg_id} (default all-outbound egress rule is present until you remove it explicitly)"
    echo "$sg_id"
}

# ---------------------------------------------------------------------------
# Rules - idempotent add/remove, one direction at a time
# ---------------------------------------------------------------------------

# _rule_json <protocol> <from_port> <to_port> <source-type> <source-value> <description>
# source-type is one of: cidr | cidr6 | sg | prefix-list
#
# from/to of the literal string "null" (this project's sentinel for "AWS
# returned/expects no port restriction here", used for a protocol -1 rule -
# see the comment above _rule_exists) omits FromPort/ToPort from the built
# JSON entirely, rather than setting them to a JSON `null`. AWS's API wants
# those keys absent for an all-traffic permission, not null-valued -
# `--argjson f "null"` would technically still produce valid JSON (`null` is
# valid JSON), so this would silently send a request AWS may reject instead
# of failing loudly at rule-construction time.
_rule_json() {
    local proto="$1" from="$2" to="$3" stype="$4" sval="$5" desc="$6"

    local ports="{}"
    if [ "$from" != "null" ] && [ "$to" != "null" ]; then
        ports="$(jq -nc --argjson f "$from" --argjson t "$to" '{FromPort:$f, ToPort:$t}')"
    fi

    local source_field
    case "$stype" in
        cidr)        source_field="$(jq -nc --arg c "$sval" --arg d "$desc" '{IpRanges:[{CidrIp:$c, Description:$d}]}')" ;;
        cidr6)       source_field="$(jq -nc --arg c "$sval" --arg d "$desc" '{Ipv6Ranges:[{CidrIpv6:$c, Description:$d}]}')" ;;
        sg)          source_field="$(jq -nc --arg g "$sval" --arg d "$desc" '{UserIdGroupPairs:[{GroupId:$g, Description:$d}]}')" ;;
        prefix-list) source_field="$(jq -nc --arg pl "$sval" --arg d "$desc" '{PrefixListIds:[{PrefixListId:$pl, Description:$d}]}')" ;;
        *) die "unknown source type '$stype' (expected cidr, cidr6, sg, or prefix-list)" ;;
    esac

    jq -nc --arg p "$proto" --argjson ports "$ports" --argjson src "$source_field" \
        '{IpProtocol:$p} + $ports + $src'
}

# _rule_exists <sg-id> <direction> <protocol> <from> <to> <source-type> <source-value>
# direction is "ingress" or "egress". Compares against AWS's own view of the
# group, not a local record of what this script thinks it already did -
# someone else's manual console change is still correctly detected as
# "already present", so this stays idempotent under drift too.
_rule_exists() {
    local sg_id="$1" direction="$2" proto="$3" from="$4" to="$5" stype="$6" sval="$7"
    local field; [ "$direction" = "ingress" ] && field="IpPermissions" || field="IpPermissionsEgress"

    local source_filter
    case "$stype" in
        cidr)        source_filter=".IpRanges[]?.CidrIp == \$sval" ;;
        cidr6)       source_filter=".Ipv6Ranges[]?.CidrIpv6 == \$sval" ;;
        sg)          source_filter=".UserIdGroupPairs[]?.GroupId == \$sval" ;;
        prefix-list) source_filter=".PrefixListIds[]?.PrefixListId == \$sval" ;;
        *) die "unknown source type '$stype'" ;;
    esac

    # from/to are compared as strings, both sides coalesced through `// "null"`
    # first: a protocol "-1" (all traffic) rule - which is exactly what a
    # freshly created group's default egress rule is (see
    # ensure_security_group's log line) - has no FromPort/ToPort at all, so
    # AWS returns JSON null for both. --argjson chokes on an empty string
    # outright, and a bare numeric comparison would need `from`/`to` to
    # always be real integers, which they aren't for that rule. Passing both
    # sides through as plain strings side-steps both problems.
    local match
    match="$(_aws ec2 describe-security-groups --group-ids "$sg_id" \
        --query "SecurityGroups[0].${field}" \
        | jq --arg proto "$proto" --arg from "$from" --arg to "$to" --arg sval "$sval" \
            "[.[] | select(.IpProtocol == \$proto and ((.FromPort // \"null\") | tostring) == \$from and ((.ToPort // \"null\") | tostring) == \$to and (${source_filter}))] | length")"
    [ "$match" -gt 0 ]
}

# ensure_ingress_rule / ensure_egress_rule <sg-id> <protocol> <from> <to> <source-type> <source-value> <description>
# Safe to call every run: skips (not errors) when the exact rule is already
# there instead of relying on AWS's InvalidPermission.Duplicate error as the
# "already exists" signal - that error string isn't a stable API contract to
# script against, and this way the log output says WHY nothing changed.
ensure_ingress_rule() { _ensure_rule ingress "$@"; }
ensure_egress_rule()  { _ensure_rule egress "$@"; }

_ensure_rule() {
    local direction="$1" sg_id="$2" proto="$3" from="$4" to="$5" stype="$6" sval="$7" desc="${8:-}"

    if _rule_exists "$sg_id" "$direction" "$proto" "$from" "$to" "$stype" "$sval"; then
        log "${direction} ${proto}/${from}-${to} from ${sval} already present on ${sg_id}, skipping"
        return 0
    fi

    log "adding ${direction} ${proto}/${from}-${to} from ${sval} to ${sg_id}"
    local rule; rule="$(_rule_json "$proto" "$from" "$to" "$stype" "$sval" "$desc")"
    local action="authorize-security-group-${direction}"
    _aws ec2 "$action" --group-id "$sg_id" --ip-permissions "[$rule]" >/dev/null
}

# revoke_ingress_rule / revoke_egress_rule - the mirror image: a no-op (not an
# error) when the rule is already gone, so a "remove this legacy rule" step
# can be re-run (or run against a group that was already cleaned up) safely.
revoke_ingress_rule() { _revoke_rule ingress "$@"; }
revoke_egress_rule()  { _revoke_rule egress "$@"; }

_revoke_rule() {
    local direction="$1" sg_id="$2" proto="$3" from="$4" to="$5" stype="$6" sval="$7"

    if ! _rule_exists "$sg_id" "$direction" "$proto" "$from" "$to" "$stype" "$sval"; then
        log "${direction} ${proto}/${from}-${to} from ${sval} not present on ${sg_id}, nothing to revoke"
        return 0
    fi

    log "revoking ${direction} ${proto}/${from}-${to} from ${sval} on ${sg_id}"
    local rule; rule="$(_rule_json "$proto" "$from" "$to" "$stype" "$sval" "")"
    local action="revoke-security-group-${direction}"
    _aws ec2 "$action" --group-id "$sg_id" --ip-permissions "[$rule]" >/dev/null
}

# ---------------------------------------------------------------------------
# Attach / detach - EC2 instance, ENI, RDS. Merge, don't overwrite.
# ---------------------------------------------------------------------------

# _instance_primary_eni <instance-id>
_instance_primary_eni() {
    _aws ec2 describe-instances --instance-ids "$1" \
        --query 'Reservations[0].Instances[0].NetworkInterfaces[0].NetworkInterfaceId' --output text
}

# attach_sg_to_instance <instance-id> <sg-id> - adds sg-id to whatever
# security groups the instance's primary ENI already has. Never use
# `modify-instance-attribute --groups <one-id>` directly for "attach one more
# group" - that call SETS the group list, so it silently detaches every group
# not named in the same call. This reads the current set first and only ever
# grows it.
attach_sg_to_instance() {
    local instance_id="$1" sg_id="$2"
    local eni_id; eni_id="$(_instance_primary_eni "$instance_id")"
    attach_sg_to_eni "$eni_id" "$sg_id"
}

# detach_sg_from_instance <instance-id> <sg-id> - same merge logic, in reverse.
# Refuses to remove the last remaining security group: an ENI must always
# have at least one, and AWS's own error for zero groups is far less clear
# about why than this early check is.
detach_sg_from_instance() {
    local instance_id="$1" sg_id="$2"
    local eni_id; eni_id="$(_instance_primary_eni "$instance_id")"
    detach_sg_from_eni "$eni_id" "$sg_id"
}

# attach_sg_to_eni <eni-id> <sg-id>
attach_sg_to_eni() {
    local eni_id="$1" sg_id="$2"
    local current; current="$(_aws ec2 describe-network-interfaces --network-interface-ids "$eni_id" \
        --query 'NetworkInterfaces[0].Groups[].GroupId' --output json)"

    if echo "$current" | jq -e --arg sg "$sg_id" 'index($sg)' >/dev/null; then
        log "${sg_id} already attached to ${eni_id}, skipping"
        return 0
    fi

    local count; count="$(echo "$current" | jq 'length')"
    # AWS's default quota is 5 security groups per network interface - this
    # is raisable per-account/region, but the script should say exactly why
    # it stopped instead of forwarding AWS's generic "cannot exceed" error.
    if [ "$count" -ge 5 ]; then
        die "${eni_id} already has ${count} security groups (default AWS quota is 5 per ENI) - request a quota increase or detach one first"
    fi

    local merged; merged="$(echo "$current" | jq -c --arg sg "$sg_id" '. + [$sg]')"
    log "attaching ${sg_id} to ${eni_id} (now $((count + 1)) groups)"
    _aws ec2 modify-network-interface-attribute --network-interface-id "$eni_id" \
        --groups $(echo "$merged" | jq -r '.[]') >/dev/null
}

# detach_sg_from_eni <eni-id> <sg-id>
detach_sg_from_eni() {
    local eni_id="$1" sg_id="$2"
    local current; current="$(_aws ec2 describe-network-interfaces --network-interface-ids "$eni_id" \
        --query 'NetworkInterfaces[0].Groups[].GroupId' --output json)"

    if ! echo "$current" | jq -e --arg sg "$sg_id" 'index($sg)' >/dev/null; then
        log "${sg_id} not attached to ${eni_id}, nothing to detach"
        return 0
    fi

    local remaining; remaining="$(echo "$current" | jq -c --arg sg "$sg_id" 'map(select(. != $sg))')"
    if [ "$(echo "$remaining" | jq 'length')" -eq 0 ]; then
        die "refusing to detach ${sg_id} from ${eni_id} - it's the last security group on this interface, and an ENI can't have zero"
    fi

    log "detaching ${sg_id} from ${eni_id}"
    _aws ec2 modify-network-interface-attribute --network-interface-id "$eni_id" \
        --groups $(echo "$remaining" | jq -r '.[]') >/dev/null
}

# attach_sg_to_rds <db-instance-id> <sg-id> - RDS's own API IS additive-safe
# in one sense (modify-db-instance --vpc-security-group-ids also SETS the
# whole list, same footgun as EC2), so this merges the same way as the EC2
# path rather than trusting the API to be additive.
attach_sg_to_rds() {
    local db_id="$1" sg_id="$2"
    local current; current="$(_aws rds describe-db-instances --db-instance-identifier "$db_id" \
        --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId' --output json)"

    if echo "$current" | jq -e --arg sg "$sg_id" 'index($sg)' >/dev/null; then
        log "${sg_id} already attached to RDS instance ${db_id}, skipping"
        return 0
    fi

    local merged; merged="$(echo "$current" | jq -c --arg sg "$sg_id" '. + [$sg]')"
    log "attaching ${sg_id} to RDS instance ${db_id}"
    _aws rds modify-db-instance --db-instance-identifier "$db_id" \
        --vpc-security-group-ids $(echo "$merged" | jq -r '.[]') \
        --apply-immediately >/dev/null
}

# attach_sg_to_alb <load-balancer-arn> <sg-id> - same merge-not-set pattern
# again for an ALB/NLB (elbv2 set-security-groups also replaces the list).
attach_sg_to_alb() {
    local lb_arn="$1" sg_id="$2"
    local current; current="$(_aws elbv2 describe-load-balancers --load-balancer-arns "$lb_arn" \
        --query 'LoadBalancers[0].SecurityGroups' --output json)"

    if echo "$current" | jq -e --arg sg "$sg_id" 'index($sg)' >/dev/null; then
        log "${sg_id} already attached to load balancer, skipping"
        return 0
    fi

    local merged; merged="$(echo "$current" | jq -c --arg sg "$sg_id" '. + [$sg]')"
    log "attaching ${sg_id} to load balancer"
    _aws elbv2 set-security-groups --load-balancer-arn "$lb_arn" \
        --security-groups $(echo "$merged" | jq -r '.[]') >/dev/null
}
