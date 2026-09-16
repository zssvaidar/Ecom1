"""Always-on service status notifier.

Polls a configured set of HTTP targets (and, optionally, ECS services and EC2
instances) on an interval, and posts to Telegram only when a target's state
*changes* (up -> down or down -> up), after FAILURE_THRESHOLD consecutive bad
checks. This is a long-running process, not a Jenkins pipeline step — see
deploy/lib/telegram-notify.sh in this same project for the one-shot deploy
notification Jenkins sends instead.

All configuration comes from environment variables (see .env.example). No
secrets are hardcoded, no state is checked into the repo.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field

import requests

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("status_notifier")


@dataclass
class Target:
    name: str
    url: str
    timeout_seconds: float = 5.0


@dataclass
class ServiceState:
    consecutive_failures: int = 0
    is_down: bool = False


def load_http_targets() -> list[Target]:
    """TARGETS="backend=http://host:9000/health,storefront-a=http://host:8000/"."""
    raw = os.environ.get("TARGETS", "")
    targets = []
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        name, _, url = entry.partition("=")
        if not name or not url:
            log.warning("skipping malformed TARGETS entry: %r", entry)
            continue
        targets.append(Target(name=name, url=url))
    return targets


def check_http(target: Target) -> bool:
    try:
        resp = requests.get(target.url, timeout=target.timeout_seconds)
        return resp.status_code < 500
    except requests.RequestException as exc:
        log.debug("%s: request failed: %s", target.name, exc)
        return False


def check_ecs_services(cluster: str, service_names: list[str]) -> dict[str, bool]:
    import boto3

    client = boto3.client("ecs", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    result: dict[str, bool] = {}
    if not service_names:
        return result
    resp = client.describe_services(cluster=cluster, services=service_names)
    for svc in resp.get("services", []):
        healthy = svc["runningCount"] == svc["desiredCount"] and svc["desiredCount"] > 0
        result[f"ecs:{svc['serviceName']}"] = healthy
    for missing in resp.get("failures", []):
        result[f"ecs:{missing.get('arn', missing)}"] = False
    return result


def check_ec2_instances(instance_ids: list[str]) -> dict[str, bool]:
    import boto3

    client = boto3.client("ec2", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    result: dict[str, bool] = {}
    if not instance_ids:
        return result
    resp = client.describe_instance_status(InstanceIds=instance_ids, IncludeAllInstances=True)
    for status in resp.get("InstanceStatuses", []):
        healthy = (
            status["InstanceState"]["Name"] == "running"
            and status.get("InstanceStatus", {}).get("Status") == "ok"
            and status.get("SystemStatus", {}).get("Status") == "ok"
        )
        result[f"ec2:{status['InstanceId']}"] = healthy
    return result


def send_telegram(bot_token: str, chat_id: str, text: str) -> None:
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            data={"chat_id": chat_id, "text": text},
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        log.error("failed to send Telegram notification: %s", exc)


def load_state(path: str) -> dict[str, ServiceState]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            raw = json.load(f)
        return {k: ServiceState(**v) for k, v in raw.items()}
    except (json.JSONDecodeError, TypeError, OSError) as exc:
        log.warning("could not load state file %s, starting fresh: %s", path, exc)
        return {}


def save_state(path: str, state: dict[str, ServiceState]) -> None:
    try:
        with open(path, "w") as f:
            json.dump({k: v.__dict__ for k, v in state.items()}, f)
    except OSError as exc:
        log.error("could not persist state file %s: %s", path, exc)


def run_once(
    http_targets: list[Target],
    ecs_cluster: str | None,
    ecs_services: list[str],
    ec2_instance_ids: list[str],
    state: dict[str, ServiceState],
    failure_threshold: int,
    bot_token: str,
    chat_id: str,
) -> None:
    checks: dict[str, bool] = {t.name: check_http(t) for t in http_targets}

    if ecs_cluster and ecs_services:
        try:
            checks.update(check_ecs_services(ecs_cluster, ecs_services))
        except Exception as exc:  # boto3 errors, network errors, etc.
            log.error("ECS status check failed: %s", exc)

    if ec2_instance_ids:
        try:
            checks.update(check_ec2_instances(ec2_instance_ids))
        except Exception as exc:
            log.error("EC2 status check failed: %s", exc)

    for name, is_up in checks.items():
        svc_state = state.setdefault(name, ServiceState())

        if is_up:
            if svc_state.is_down:
                send_telegram(bot_token, chat_id, f"[UP] {name} is back online")
                log.info("%s: recovered", name)
            svc_state.consecutive_failures = 0
            svc_state.is_down = False
            continue

        svc_state.consecutive_failures += 1
        log.info("%s: check failed (%d/%d)", name, svc_state.consecutive_failures, failure_threshold)
        if svc_state.consecutive_failures >= failure_threshold and not svc_state.is_down:
            svc_state.is_down = True
            send_telegram(bot_token, chat_id, f"[DOWN] {name} is not responding")
            log.warning("%s: marked down", name)


def main() -> None:
    bot_token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]

    http_targets = load_http_targets()
    ecs_cluster = os.environ.get("ECS_CLUSTER") or None
    ecs_services = [s for s in os.environ.get("ECS_SERVICES", "").split(",") if s]
    ec2_instance_ids = [i for i in os.environ.get("EC2_INSTANCE_IDS", "").split(",") if i]

    if not http_targets and not ecs_services and not ec2_instance_ids:
        raise SystemExit("no targets configured: set TARGETS, ECS_SERVICES, or EC2_INSTANCE_IDS")

    interval = float(os.environ.get("CHECK_INTERVAL_SECONDS", "60"))
    failure_threshold = int(os.environ.get("FAILURE_THRESHOLD", "3"))
    state_path = os.environ.get("STATE_FILE", "/data/state.json")

    state = load_state(state_path)
    log.info(
        "starting: %d http target(s), ecs_cluster=%s, %d ec2 instance(s), interval=%ss",
        len(http_targets), ecs_cluster, len(ec2_instance_ids), interval,
    )

    while True:
        run_once(
            http_targets, ecs_cluster, ecs_services, ec2_instance_ids,
            state, failure_threshold, bot_token, chat_id,
        )
        save_state(state_path, state)
        time.sleep(interval)


if __name__ == "__main__":
    main()
