#!/usr/bin/env python3
"""Exercise the real Docker Go formatter on owned, network-none containers.

The supplied locally cached image must contain Python3 and /bin/sh. No registry
pull, published port, host mount, application environment or database is used.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
import docker_inspect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image_id) or args.output.exists():
        raise ValueError("Fresh output and immutable cached image ID required")
    environment = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    environment["DOCKER_CONTEXT"] = "default"
    def command(values, timeout=20):
        return subprocess.run(["docker", *values], env=environment, capture_output=True, text=True, check=True, timeout=timeout).stdout.strip()
    endpoint = command(["context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'])
    if not endpoint.startswith("unix://"):
        raise ValueError("Local Docker engine required")
    command(["image", "inspect", "--platform", "linux/amd64", args.image_id, "--format", "{{.Id}}"])
    nonce, records = uuid4().hex, []
    label = "lash-her.owned-inspection=" + nonce
    project = "lash-owned-inspection-" + nonce
    def ids():
        return command(["ps", "--all", "--quiet", "--no-trunc", "--filter", "label=" + label]).split()
    if ids():
        raise ValueError("Fresh owned label required")
    try:
        for health in (False, True):
            create = ["create", "--pull", "never", "--platform", "linux/amd64", "--name", project + ("-health" if health else "-none"),
                "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--user", "65532:65532", "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32",
                "--label", label, "--label", "com.docker.compose.project=" + project,
                "--label", "com.docker.compose.service=owned-process", "--entrypoint", "python3"]
            create += (["--health-cmd", 'python3 -c "raise SystemExit(0)"', "--health-interval", "1s", "--health-timeout", "2s", "--health-retries", "1"]
                       if health else ["--no-healthcheck"])
            identity = command([*create, args.image_id, "-c", "import time; time.sleep(60)"])
            if not re.fullmatch(r"[a-f0-9]{64}", identity):
                raise ValueError("Exact owned container ID required")
            if health:
                command(["start", identity])
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if command(["inspect", "--format", docker_inspect.HEALTH_STATUS, identity]) == "healthy":
                        break
                    time.sleep(0.5)
                else:
                    raise ValueError("Owned health fixture did not become healthy")
            expected = "healthy" if health else "none"
            for name, fields in (("runtime", docker_inspect.RUNTIME_FIELDS), ("recovery", docker_inspect.RECOVERY_FIELDS),
                                 ("watchdog", docker_inspect.WATCHDOG_FIELDS)):
                output = command(["inspect", "--format", fields, identity])
                if name == "runtime":
                    image, running, actual, observed_project, service = output.split("|")
                    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image) or observed_project != project or service != "owned-process":
                        raise ValueError("Owned runtime fields changed")
                    if running != ("true" if health else "false"):
                        raise ValueError("Owned running state changed")
                elif name == "recovery":
                    running, actual = output.split("|")
                    if running != ("true" if health else "false"):
                        raise ValueError("Owned recovery running state changed")
                else:
                    labels, actual = output.rsplit("|", 1)
                    if json.loads(labels).get("lash-her.owned-inspection") != nonce:
                        raise ValueError("Owned watchdog labels changed")
                if actual != expected:
                    raise ValueError("Optional health status not preserved")
                records.append({"reader": name, "healthcheckPresent": health, "health": actual, "passed": True})
    finally:
        for identity in ids():
            if not re.fullmatch(r"[a-f0-9]{64}", identity):
                raise ValueError("Owned cleanup ID refused")
            command(["rm", "--force", identity])
        if ids():
            raise ValueError("Owned cleanup incomplete")
    value = {"status": "OWNED_DOCKER_OPTIONAL_HEALTH_INSPECTION_PASS", "imageId": args.image_id, "checks": records,
             "cleanupPassed": True, "network": "none", "applicationCredentialsUsed": False, "awsContacted": False,
             "actualStagingChanged": False}
    descriptor = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
    print(json.dumps({"status": value["status"], "checks": len(records), "cleanupPassed": True}))


if __name__ == "__main__":
    main()
