"""Root-side phases of the explicitly reviewed staging recreation action.

The local parent owns AWS, SSH trust and private transfer. Payloads and receipts
remain private; this entrypoint prints only a status and its output directory.
No phase can invoke migration application, alter AWS or admit gateway writes.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import migrate
import native_qualification
import release as runtime
import runtime_actions
import staging_frontend_restore
import staging_restore
import staging_retire
import staging_rollback
import staging_state
import vercel

demand = migrate.demand
ROOT = Path("/var/lib/lash-her/releases/staging")
LOCK = Path("/run/lock/lash-her-release.lock")
COMMON = ("bundle", "configuration", "database_receipts", "runtime_receipts", "compose_file", "candidate_sha256")


def private_path(value):
    demand(isinstance(value, str), "RECREATION_PRIVATE_PATH_REQUIRED")
    path = Path(value)
    demand(path.is_absolute() and ".." not in path.parts and path.is_relative_to(ROOT)
           and path != ROOT and not any(p.is_symlink() for p in (path, *path.parents)), "RECREATION_STAGING_PRIVATE_ROOT_REQUIRED")
    return path


def request_inputs(value):
    demand(isinstance(value, dict) and value.get("version") == 1 and value.get("environment") == "staging"
           and value.get("operation") in ("rollback", "retire", "restore"), "RECREATION_FIXED_STAGING_PHASE_REQUIRED")
    demand(isinstance(value.get("action"), str) and re.fullmatch(r"p1-recreate-[a-z0-9][a-z0-9-]{0,24}", value["action"]),
           "RECREATION_REVIEWED_ACTION_REQUIRED")
    paths = value.get("paths")
    demand(isinstance(paths, dict) and set(paths) == {"bundle", "configuration", "database_receipts", "runtime_receipts",
        "compose_file", "programs_directory", "output", "compatibility_directory", "inventory_directory", "retirement_directory"},
        "RECREATION_EXACT_PATH_BINDINGS_REQUIRED")
    paths = {name: private_path(path) for name, path in paths.items()}
    demand(isinstance(value.get("privateFingerprintKey"), str) and re.fullmatch(r"[a-f0-9]{64}", value["privateFingerprintKey"]),
           "RECREATION_PRIVATE_ACTION_KEY_REQUIRED")
    # Read-only DB credentials are required only in phases that start runtimes.
    if value["operation"] != "retire":
        demand(isinstance(value.get("databaseCredentials"), dict) and set(value["databaseCredentials"]) == {"frontend", "course", "community"},
               "RECREATION_THREE_PRIVATE_DATABASE_BINDINGS_REQUIRED")
    for name in ("candidate_sha256", "checker_sha256", "inventory_sha256", "previous_sha256", "proof_sha256"):
        demand(isinstance(value.get(name), str) and re.fullmatch(r"[a-f0-9]{64}", value[name]), "RECREATION_REVIEWED_HASHES_REQUIRED")
    phase_action = {"rollback": "rollback-", "retire": "retire-", "restore": "restore-"}[value["operation"]] + value["action"]
    demand(value.get("confirmation") == "staging/" + value.get("releaseId", "") + "/" + phase_action,
           "RECREATION_EXPLICIT_PHASE_CONFIRMATION_REQUIRED")
    return paths, phase_action


def execute(value, lock_path=LOCK):
    paths, action = request_inputs(value)
    demand(os.geteuid() == 0 and sys.platform == "linux", "RECREATION_ROOT_LINUX_REQUIRED")
    selected, jobs, plan, _compose = staging_state.retained_state(
        *(paths[name] if name != "candidate_sha256" else value[name] for name in COMMON))
    demand(selected["releaseId"] == value["releaseId"], "RECREATION_EXACT_RELEASE_REQUIRED")
    if value.get("externalInventory") is not None:
        demand(value["operation"] in ("rollback", "retire"), "RECREATION_EXTERNAL_INVENTORY_PHASE_REQUIRED")
        expected = ROOT / value["action"] / ("inventory-rollback" if value["operation"] == "rollback" else "inventory-retirement")
        raw = base64.b64decode(value["externalInventory"], validate=True)
        demand(len(raw) <= 100_000 and migrate.file_hash(raw) == value["inventory_sha256"]
               and paths["inventory_directory"] == expected and not expected.exists(), "RECREATION_FRESH_INVENTORY_HANDOFF_REQUIRED")
        expected.mkdir(mode=0o700)
        fd = os.open(expected / "mux-inventory.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        staging_retire.external_inventory(expected, value["inventory_sha256"], int(time.time() * 1000))
    client = vercel.Client(value["vercelToken"])
    common = {name: paths[name] if name != "candidate_sha256" else value[name] for name in COMMON}
    options = {"apply": True, "confirmation": value["confirmation"], "client": client, "lock_path": lock_path}
    operation = value["operation"]
    if operation == "rollback":
        return staging_rollback.execute(**common, compatibility_directory=paths["compatibility_directory"],
            previous_sha256=value["previous_sha256"], proof_sha256=value["proof_sha256"], expected_deployment=value["expected_deployment"],
            action=action, output=paths["output"], inventory_directory=paths["inventory_directory"], inventory_sha256=value["inventory_sha256"],
            configuration_sha256=value["configuration_sha256"], programs_directory=paths["programs_directory"], programs=value["programs"],
            checker_sha256=value["checker_sha256"], credentials=value["databaseCredentials"],
            private_fingerprint_key=value["privateFingerprintKey"], **options)
    if operation == "retire":
        def pending(_selected, _plan, configuration, output):
            work = output / "pending-work"; work.mkdir(mode=0o700)
            operator = runtime_actions.RuntimeOperator(selected, jobs, configuration, plan["originalContainers"],
                paths["programs_directory"], value["programs"], work)
            retained = operator.prepare_retained("recovery-fixture-host-" + value["action"])
            baseline = operator.fingerprint(value["privateFingerprintKey"])
            migrate.write_json(work, "business-baseline.json", baseline)
            demand(retained["environment"] == "staging", "RECREATION_ACTUAL_PENDING_WORK_REQUIRED")
        return staging_retire.execute(**common, inventory_directory=paths["inventory_directory"], inventory_sha256=value["inventory_sha256"],
            expected_configuration_sha256=value["configuration_sha256"], expected_deployment=value["expected_deployment"], action=action,
            output=paths["output"], before_stop=pending, **options)
    retirement = paths["retirement_directory"]
    retained = migrate.read_json(retirement / "pending-work", "retained-work.json")
    baseline = migrate.read_json(retirement / "pending-work", "business-baseline.json")
    demand(retained.get("actionId") == "recovery-fixture-host-" + value["action"], "RECREATION_EXACT_RETAINED_FIXTURE_REQUIRED")
    with lock_path.open("a+") as lock:
        native_qualification.acquire_release_lock(lock)
        def publisher(execution, _plan, snapshot, output):
            directory = output / "publisher-checkpoint"; directory.mkdir(mode=0o700)
            apis = staging_rollback.api_containers(execution, snapshot)
            operator = runtime_actions.RuntimeOperator(execution, jobs, snapshot, apis, paths["programs_directory"],
                value["programs"], directory, api_only=True)
            operator.verify_recovery(retained)
            actual = migrate.read_json(directory, "durable-recovery.json")
            demand(actual.get("retained") == retained and actual.get("apiContainers") == apis, "RECREATION_ACTUAL_PUBLISHER_BINDING_REQUIRED")
            runtime_actions.recovered(actual["retained"], actual["outbox"], actual["inbox"])
        def qualify(execution, restored_plan, snapshot, output, ready):
            directory = output / "business-inspection"; directory.mkdir(mode=0o700)
            operator = runtime_actions.RuntimeOperator(execution, jobs, snapshot, ready["containers"], paths["programs_directory"],
                value["programs"], directory)
            after = operator.fingerprint(value["privateFingerprintKey"])
            preserved = {name: runtime_actions.business_preserved(baseline[name], after[name]) for name in ("course", "community")}
            migrate.write_json(output, "business-preservation.json", {"before": baseline, "after": after, "verified": preserved})
            ready_hash = hashlib.sha256(migrate.read_input(output, "runtime-outcome.json")).hexdigest()
            staging_frontend_restore.execute(execution, restored_plan, snapshot, output, ready_hash, value["programs"],
                "native-restore-" + value["action"], output / "native-qualification", lock, client, apply=True,
                confirmation="staging/" + execution["releaseId"] + "/native-restore-" + value["action"], lock_path=lock_path)
        return staging_restore.execute(**common, retirement_directory=retirement, retirement_sha256=value["retirement_sha256"],
            new_machine=value["new_machine"], action=action, expected_deployment=value["expected_deployment"],
            output=paths["output"], checker_sha256=value["checker_sha256"], credentials=value["databaseCredentials"],
            after_publisher_ready=publisher, after_runtime_ready=qualify, lock_handle=lock, **options)


def main():
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    previous_signals = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        demand(len(raw) <= 2_000_000, "RECREATION_PRIVATE_INPUT_TOO_LARGE")
        value = json.loads(raw)
        result = execute(value)
        print(json.dumps({"status": result["status"], "output": value["paths"]["output"],
                          "trafficAuthorized": False, "releaseAccepted": False, "privateReceiptValuesDisplayed": False}))
    except BaseException as error:
        print(json.dumps({"status": "RECREATION_HOST_PHASE_REQUIRES_REVIEW", "failureCode": runtime_actions.safe_code(error),
                          "privateReceiptValuesDisplayed": False}), file=sys.stderr)
        raise SystemExit(1) from None
    finally:
        for sig, previous in previous_signals.items():
            signal.signal(sig, previous)


if __name__ == "__main__":
    main()
