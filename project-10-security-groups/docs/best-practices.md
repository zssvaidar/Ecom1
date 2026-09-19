# Security group best practices - and where this project enforces each one

Each point below is a rule; the parenthetical says which script in this project
enforces or embodies it, so this isn't just a checklist that lives apart from the code.

## 1. Security groups are allow-only and stateful - design around both

- **Allow-only**: every rule is a permit; there is no explicit "deny" rule type. To
  block something, you don't add a rule - you remove or never add the permit. If you
  need an explicit deny (e.g. block one specific bad IP while allowing a broader
  range), that's a **network ACL** (subnet-level, stateless, evaluated in numbered
  order, supports deny) - a different AWS resource, not a security group. This
  project deliberately only touches security groups; layering NACLs on top is a
  separate, later decision, not something `apply-rules.sh` does for you.
- **Stateful**: an allowed inbound request's response traffic is automatically
  allowed back out, regardless of your egress rules - you never write an egress rule
  just to let responses leave. `examples/rules-db-tier.json`'s empty `egress: []`
  works precisely because of this: the DB tier still successfully responds to the
  app tier's queries even with zero egress rules, because those responses are
  return traffic for an already-permitted inbound connection, not a new outbound one.

## 2. One security group per role/tier, never one big group for everything

A single SG shared by your web servers, app servers, and database means every rule
addition has to be reasoned about against everyone's traffic patterns at once, and a
mistake in one tier's rule is a mistake in every tier's blast radius. `infra.sh`
already does this (`sg_web` vs `sg_rds`); `examples/rules-{web,app,db}-tier.json`
extend the same split one tier further. `create-sg.sh` takes a `<name>` specifically
so each tier gets its own group with its own lifecycle, not a shared one nothing
owns.

## 3. Reference security groups, not CIDR blocks, for anything inside the VPC

`--source-group sg-xxx` (a `UserIdGroupPairs` entry) ties a rule to "whatever's in
that group," which stays correct automatically as instances scale in/out, change IP,
or get replaced - a CIDR-based rule has to be hand-updated every time the source's
address range changes, and is usually wider than necessary because subnet CIDRs
cover more than just the resources that should be allowed. `rules-db-tier.json` and
`rules-app-tier.json`'s ingress both reference a security group ID
(`"source_type": "sg"`), never a subnet CIDR - CIDR sourcing (`rules-web-tier.json`)
is reserved for the one case where the source is genuinely outside your control: the
public internet.

## 4. Least privilege on ports, protocols, AND source

Three axes to narrow, not one:
- **Port**: a single port (`443`), not a range, unless the service genuinely needs a
  range (ephemeral ports for a passive-mode protocol, for example).
- **Protocol**: `tcp`/`udp` explicitly, never `-1` ("all protocols") unless you
  really mean "everything can reach this on every port," which is almost never true
  even for a bastion.
- **Source**: the narrowest thing that's actually correct - a single security group
  (best, see #3), a `/32` for one known host, a real admin CIDR, and 0.0.0.0/0 only
  for what's genuinely meant to be public (`rules-web-tier.json`'s 80/443 - not its
  22, which is scoped to an admin CIDR placeholder instead).

`audit-sgs.sh`'s first check exists because this is the rule most commonly broken by
accident - a debugging session that opened port 22 (or a database port) to
0.0.0.0/0 "just for now" and was never narrowed back down.

## 5. Never let "attach a security group" mean "replace the security groups"

`aws ec2 modify-instance-attribute --groups sg-xxx`, `aws rds modify-db-instance
--vpc-security-group-ids sg-xxx`, and `aws elbv2 set-security-groups
--security-groups sg-xxx` all **set** the resource's group list - they don't append.
Run any of those with just the one new group ID and every other group the resource
had is silently detached, often invisibly (the resource keeps running - it just stops
being reachable how it used to be, or worse, starts allowing traffic a now-missing
group used to restrict). Every attach path in `lib/sg-lib.sh`
(`attach_sg_to_instance`/`_eni`/`_rds`/`_alb`) reads the current group list first and
only ever adds to it - see that file's own header comment, which also notes this was
confirmed the hard way while testing this project, not just asserted: a test harness
bug this project's own library exposed (documented in `lib/sg-lib.sh`'s top comment)
was a `set -e` leaking from a sourced file, a reminder that "confirmed by actually
running it" catches things "should work" doesn't.

## 6. Rule count and per-resource attachment have hard quotas - know them before you hit them

- **5 security groups per network interface** (default, raisable). `attach_sg_to_eni`
  checks this and refuses with a clear message instead of forwarding AWS's generic
  error once you're at the limit.
- **60 inbound + 60 outbound rules per security group** (default, raisable).
  `audit-sgs.sh` flags any group at 45+ rules in either direction - a group
  approaching this is usually a sign it's absorbed responsibilities that belong in a
  second, more specific group (see #2), not just a number to raise.
- A rule that references a security group as its source counts as ONE rule
  regardless of how many instances are in that group - this is part of why #3 (SG
  references over CIDRs) also helps you stay under the rule-count quota, not just
  the "stays correct as things scale" argument.

## 7. Tag and describe everything - a rule with no description is a rule nobody can audit

Six months later, "why is 8443 open" is only answerable if something recorded the
answer at the time. Every `ensure_ingress_rule`/`ensure_egress_rule` call takes a
`description` argument, and `_rule_json` always attaches it to the AWS-side rule (not
just a code comment near the script that added it). `audit-sgs.sh`'s last check flags
any rule with none.

## 8. Leave the VPC's default security group alone

Every VPC gets one default SG, and by default it allows all traffic from anything
else in the same default SG plus all outbound - a shared, unnamed, easy-to-forget
group that instances land in automatically if nothing else is specified at launch.
Best practice: never add rules to it, and never let something depend on being in it
- give every resource an explicit, purpose-named group instead (`create-sg.sh`
+ `attach-sg.sh`, every time, for every resource). `audit-sgs.sh` checks the default
group still has zero rules.

## 9. Egress isn't automatically safe just because it's default-open

A newly created security group gets an implicit allow-all outbound rule
(`ensure_security_group`'s log line calls this out explicitly so it's never a
surprise). That's a reasonable default for a web or app tier that needs to reach
arbitrary external APIs, package registries, and AWS endpoints - but a database tier
has no legitimate reason to *initiate* an outbound connection at all, and "the
database's credentials get exfiltrated somewhere by a compromised dependency" is
exactly the scenario unrestricted egress makes worse. `rules-db-tier.json` sets
`egress: []` and expects `apply-rules.sh --prune` to remove the default allow-all
rule, not just leave it alongside an empty declared list.

## 10. Manage rules declaratively and idempotently, not as one-off CLI calls

A rule added by a single ad-hoc `aws ec2 authorize-security-group-ingress` during an
incident is a rule nobody removes later because nothing tracks that it should be
temporary. `apply-rules.sh` takes a rules file as the source of truth and reconciles
the live group to match it - re-running it is always safe (`ensure_*` skips rules
already present instead of erroring), and `--prune` actively removes what's no
longer declared, including anything added by hand outside this tooling. This is the
same "always check current state before acting" discipline as this repo's other
deploy scripts (`project-9-jenkins-ec2-ecs-telegram/scripts/lib/idempotent.sh` and
`project-9-php-laravel-cd/scripts/lib/idempotent.sh`) applied to network config
specifically.

## 11. Audit regularly, and wire it into CI, not just memory

`audit-sgs.sh` exits non-zero if it finds any HIGH-severity issue (world-open
sensitive port, `-1` protocol, or a full 0-65535 range to the world) - drop it into
a Jenkins stage (this repo already has the infrastructure for that in
`project-9-jenkins-ec2-ecs-telegram/Jenkinsfile`) as a gate before a prod deploy, not
just a script someone remembers to run occasionally.

## 12. Verify what's actually used before tightening - don't guess

Before narrowing a broad rule, turn on **VPC Flow Logs** for the ENI/subnet/VPC in
question and look at what source IPs/ports actually appear in real traffic over a
representative window. Tightening a rule based on what you assume connects to it,
rather than what the flow logs show actually does, is how a "least privilege"
change turns into an outage. This project doesn't set up Flow Logs (out of scope -
it's a VPC-level logging concern, not a security-group one) but treat it as the
step immediately before running `apply-rules.sh` with a narrower rules file, not
optional polish after.

## 13. Prefer managed prefix lists over hand-copied AWS IP ranges

If a rule needs to allow traffic from an AWS-managed service (S3, CloudFront,
another region's ranges, etc.) rather than a specific security group, use AWS's
managed prefix lists (`source_type: "prefix-list"` in this project's rules
schema, `pl-xxx` IDs) instead of copying a CIDR list out of AWS's published IP
ranges JSON by hand - the managed list updates itself when AWS's ranges change,
a hand-copied list silently goes stale.
