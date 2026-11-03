"""Read completed oneshot evidence from trusted journal fields, after unit GC."""
import json
from pathlib import Path
import re

UNIT = "lash-her-certificates-staging.service"
STARTED = "7d4958e842da4a758f6c1cdc7b36dcc5"
FINISHED = "39f53479d3a045ac8e11786248231fbf"
HEX = re.compile(r"[a-f0-9]{32}")


def require(value, code):
    if not value:
        raise ValueError("CERTIFICATE_INVOCATION_" + code)


def current_boot_id():
    value = Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")
    require(HEX.fullmatch(value), "BOOT_REQUIRED")
    return value


def validate(records, boot, expected_id=None, minimum_started_usec=0):
    require(isinstance(boot, str) and HEX.fullmatch(boot) and isinstance(records, list) and 1 <= len(records) <= 256
            and all(isinstance(r, dict) for r in records), "BOUNDED_JOURNAL_REQUIRED")
    require(type(minimum_started_usec) is int and minimum_started_usec >= 0, "START_BOUND_REQUIRED")
    require(expected_id is None or isinstance(expected_id, str) and HEX.fullmatch(expected_id), "ID_REQUIRED")
    manager = [r for r in records if r.get("_BOOT_ID") == boot and r.get("UNIT") == UNIT
               and r.get("_SYSTEMD_UNIT") == "init.scope" and isinstance(r.get("INVOCATION_ID"), str)
               and HEX.fullmatch(r["INVOCATION_ID"])]
    require(manager, "ACTUAL_CERTIFICATE_UNIT_REQUIRED")

    def stamp(record):
        value = record.get("__MONOTONIC_TIMESTAMP")
        require(isinstance(value, str) and value.isdecimal() and int(value) > 0, "MONOTONIC_TIME_REQUIRED")
        return int(value)

    invocation = max(manager, key=stamp)["INVOCATION_ID"]
    require(expected_id is None or invocation == expected_id, "LATEST_INVOCATION_REQUIRED")
    selected = [r for r in manager if r["INVOCATION_ID"] == invocation]
    starts = [r for r in selected if r.get("MESSAGE_ID") == STARTED and r.get("JOB_TYPE") == "start"]
    ends = [r for r in selected if r.get("MESSAGE_ID") == FINISHED and r.get("JOB_TYPE") == "start"
            and r.get("JOB_RESULT") == "done"]
    require(len(starts) == len(ends) == 1 and stamp(starts[0]) >= minimum_started_usec
            and stamp(ends[0]) > stamp(starts[0]), "ACTUAL_CERTIFICATE_UNIT_REQUIRED")
    messages = [r for r in records if r.get("_BOOT_ID") == boot and r.get("_SYSTEMD_UNIT") == UNIT
                and r.get("_SYSTEMD_INVOCATION_ID") == invocation]
    require(len(messages) == 1 and stamp(starts[0]) <= stamp(messages[0]) <= stamp(ends[0]),
            "CORRELATED_APPLICATION_RESULT_REQUIRED")
    try:
        result = json.loads(messages[0]["MESSAGE"])
    except (KeyError, TypeError, ValueError):
        result = None
    require(isinstance(result, dict) and result.get("status") == "TLS_CERTIFICATES_CURRENT"
            and result.get("renewed") == [] and result.get("servicesStopped") is False,
            "CURRENT_CERTIFICATE_NOOP_REQUIRED")
    return {"invocationId": invocation, "bootId": boot, "startedMonotonicUsec": stamp(starts[0]),
            "completedMonotonicUsec": stamp(ends[0]), "status": result["status"],
            "renewed": [], "servicesStopped": False}


def read(command, expected_id=None, minimum_started_usec=0):
    # Inactive oneshots can be garbage collected: InvocationID and even the
    # process timestamps reset. The manager's completed job and trusted process
    # journal retain the same boot/invocation and establish actual completion.
    raw = command(["systemctl", "show", "--property=Result,ExecMainStatus,ActiveState", UNIT])
    state = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    require(state == {"Result": "success", "ExecMainStatus": "0", "ActiveState": "inactive"},
            "ACTUAL_CERTIFICATE_UNIT_REQUIRED")
    raw = command(["journalctl", "--boot=0", "--no-pager", "--output=json", "--unit", UNIT, "--lines=256"])
    require(len(raw.encode()) <= 262_144, "BOUNDED_JOURNAL_REQUIRED")
    try:
        records = [json.loads(line) for line in raw.splitlines()]
    except ValueError:
        raise ValueError("CERTIFICATE_INVOCATION_JOURNAL_JSON_REQUIRED") from None
    return validate(records, current_boot_id(), expected_id, minimum_started_usec)
