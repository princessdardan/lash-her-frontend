#!/usr/bin/env python3
"""Bounded unhealthy-process recovery under the shared host release lock."""
import argparse
import fcntl
import json
import docker_inspect
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

RECOVERABLE = {"course-api", "community-api", "course-publisher", "course-snapshot", "community-worker"}


def recent(values, now):
    if not isinstance(values, list):
        raise ValueError("Invalid watchdog history")
    return [value for value in values if isinstance(value, (float, int)) and math.isfinite(value) and now - value < 3600]


def recovery_actions(containers, history, now):
    if not isinstance(history, dict):
        raise ValueError("Invalid watchdog history")
    planned = {service: recent(values, now) for service, values in history.items() if service in RECOVERABLE}
    actions = []
    for item in containers:
        service = item.get("service")
        if service not in RECOVERABLE or item.get("health") != "unhealthy" or not re.fullmatch(r"[a-f0-9]{12,64}", item.get("id", "")):
            continue
        previous = planned.get(service, [])
        if len(previous) >= 3 or any(now - value < 300 for value in previous):
            continue
        actions.append(item)
        # Update the plan too: two overlapping replicas cannot multiply one
        # service's allowance within the same watchdog invocation.
        planned[service] = previous + [now]
    return actions


def command(args, timeout=5):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def persist_intent(path, history):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", prefix="watchdog-", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            os.fchmod(stream.fileno(), 0o600)
            json.dump(history, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def recover(project, history_path, execute=False):
    if not re.fullmatch(r"lash-her-(staging|production)", project) or not history_path.resolve().is_relative_to(Path("/var/lib/lash-her")):
        raise ValueError("Invalid watchdog target")
    if history_path.exists() and history_path.stat().st_size > 1024 * 1024:
        raise ValueError("Watchdog history exceeds bound")
    history = json.loads(history_path.read_text()) if history_path.exists() else {}
    ids = command(["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"]).split()
    if len(ids) > 64 or any(not re.fullmatch(r"[a-f0-9]{12,64}", item) for item in ids):
        raise ValueError("Unexpected project container inventory")
    containers = []
    for item in ids:
        labels, health = command(["docker", "inspect", "--format", docker_inspect.WATCHDOG_FIELDS, item]).rsplit("|", 1)
        containers.append({"id": item, "service": json.loads(labels).get("com.docker.compose.service"), "health": health})
    now = time.time()
    for item in recovery_actions(containers, history, now):
        if execute:
            history[item["service"]] = recent(history.get(item["service"], []), now) + [now]
            # A timed-out restart is ambiguous. Commit intent first so a later
            # timer cannot repeat an uncounted operation after a process crash.
            persist_intent(history_path, history)
            command(["docker", "restart", "--timeout", "30", item["id"]], timeout=40)
        print(("restarted" if execute else "proposed") + " " + item["service"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project")
    parser.add_argument("history", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    # The executor and watchdog use this same flock. Taking it here also makes
    # direct CLI invocations safe; systemd does not need a separate wrapper.
    with open("/run/lock/lash-her-release.lock", "a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("watchdog skipped while the release lock is held")
            return
        recover(args.project, args.history, args.apply)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit("Watchdog refused or failed; inspect the host locally") from None
