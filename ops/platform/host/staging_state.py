"""Bind retained successful staging state without executing any migration."""
import json
from pathlib import Path
import re

import migrate
import release as runtime

demand = migrate.demand
CONFIGURATION_FILES = ("runtime.json", *runtime.CONFIG_FILES, *runtime.TLS_FILES,
                       *(service + ".env" for service in runtime.ENV_FILES))


def outside_checkout(directory):
    migrate.private_directory(directory)
    demand(not any((p / ".git").exists() for p in (directory.resolve(), *directory.resolve().parents)),
           "RESTORE_PRIVATE_INPUTS_OUTSIDE_CHECKOUT_REQUIRED")


def retained_state(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256):
    """Offline plan. The caller supplies the independently reviewed candidate hash."""
    for directory in (bundle, configuration, database_receipts, runtime_receipts):
        outside_checkout(directory)
    demand(isinstance(candidate_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", candidate_sha256),
           "RESTORE_REVIEWED_CANDIDATE_HASH_REQUIRED")
    selected, jobs, original, compose = runtime.make_plan(bundle, configuration, compose_file)
    demand(selected["environment"] == "staging" and set(jobs) == {"frontend", "course", "community"},
           "RESTORE_THREE_STAGING_DATABASES_REQUIRED")
    raw_candidate = migrate.read_input(database_receipts, "candidate.json")
    demand(migrate.file_hash(raw_candidate) == candidate_sha256 and json.loads(raw_candidate) == selected,
           "RESTORE_CANDIDATE_BINDING_MISMATCH")
    raw_database = migrate.read_input(database_receipts, "migration-outcome.json")
    database = json.loads(raw_database)
    demand(database.get("status") == "DATABASES_VERIFIED" and database.get("environment") == "staging"
           and database.get("releaseId") == selected["releaseId"] and database.get("candidateSha256") == candidate_sha256
           and database.get("trafficAuthorized") is False and database.get("frontendReadOnlyVerified") is True
           and set(database.get("databaseReceiptSha256", {})) == set(jobs), "RESTORE_COMPLETED_DATABASE_STAGE_REQUIRED")
    counts = {}
    for name, info in jobs.items():
        raw = migrate.read_input(database_receipts, name + "/database-receipt.json")
        receipt = json.loads(raw)
        terminal = migrate.read_json(database_receipts, name + "/job-outcome.json")
        job = info["job"]
        demand(migrate.file_hash(raw) == database["databaseReceiptSha256"][name]
               and receipt.get("status") == terminal.get("status") == "DATABASE_VERIFIED"
               and receipt.get("environment") == "staging" and receipt.get("releaseId") == selected["releaseId"]
               and receipt.get("service") == info["service"] and receipt.get("trafficAuthorized") is False
               and receipt.get("schemaBaselineSha256") == job["schemaBaselineSha256"]
               and all(receipt.get(key) == job[key] for key in ("sourceCommit", "migrationImageDigest"))
               and receipt.get("target") == {key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")},
               "RESTORE_DATABASE_RECEIPT_MISMATCH")
        if name == "frontend":
            demand(receipt.get("readOnlyVerified") is True and terminal.get("readOnlyVerified") is True
                   and receipt.get("schemaVerified") is True and receipt.get("runtimeRoleVerified") is True
                   and receipt.get("applied") == [], "RESTORE_FRONTEND_READ_ONLY_RECEIPT_REQUIRED")
            counts[name] = {"mode": "read-only-current", "appliedDuringRelease": 0}
        else:
            demand(receipt.get("failureCode") is None and receipt.get("applyCompleted") is True
                   and all(receipt.get(key) == job[key] for key in ("runtimeImageDigest", "contractSha256"))
                   and receipt.get("artifactSha256") == job["target"]["artifactSha256"]
                   and type(receipt.get("postAppliedCount")) is int and receipt["postAppliedCount"] > 0,
                   "RESTORE_API_MIGRATION_COMPLETION_REQUIRED")
            counts[name] = {"mode": "already-applied", "appliedCount": receipt["postAppliedCount"]}
    ready = migrate.read_json(runtime_receipts, "runtime-outcome.json")
    demand(ready.get("status") in ("API_RUNTIME_READY", "API_RUNTIME_RESTORED_FOR_QUALIFICATION")
           and ready.get("phase") == "completed" and ready.get("environment") == "staging"
           and ready.get("releaseId") == selected["releaseId"] and ready.get("trafficAuthorized") is False
           and ready.get("releaseAccepted") is False and ready.get("candidateSha256") == candidate_sha256
           and ready.get("migrationOutcomeSha256") == migrate.file_hash(raw_database),
           "RESTORE_SUCCESSFUL_RUNTIME_BINDING_REQUIRED")
    containers = ready.get("containers")
    demand(isinstance(containers, list) and len(containers) == len(runtime.SERVICES)
           and {c.get("service") for c in containers} == set(runtime.SERVICES)
           and len({c.get("containerId") for c in containers}) == len(containers)
           and all(isinstance(c.get("containerId"), str) and re.fullmatch(r"[a-f0-9]{64}", c["containerId"])
                   and c.get("image") == selected["artifacts"][runtime.IMAGE_KEYS[c["service"]]]["image"] for c in containers),
           "RESTORE_EXACT_RUNTIME_CONTAINER_RECEIPTS_REQUIRED")
    plan = {"operation": "restore-current-staging-runtime-without-migrations", "releaseId": selected["releaseId"],
            "environment": "staging", "originalHostMachineId": original["hostMachineId"],
            "candidateSha256": candidate_sha256, "migrationOutcomeSha256": migrate.file_hash(raw_database),
            "runtimeReceiptSha256": migrate.file_hash(migrate.read_input(runtime_receipts, "runtime-outcome.json")),
            "publicHost": original["publicHost"], "images": original["images"], "originalContainers": containers,
            "completedDatabaseStages": counts,
            "currentDatabaseChecksRequired": ["frontend-read-only-current", "course-read-only-current", "community-read-only-current"],
            "newMachineBindingRequired": True, "migrationsExecuted": False, "trafficAuthorized": False,
            "businessSchedulesEnabled": False, "releaseAccepted": False}
    return selected, jobs, plan, compose


def configuration_hashes(configuration):
    outside_checkout(configuration)
    return {name: migrate.file_hash(migrate.read_input(configuration, name, 65_536)) for name in CONFIGURATION_FILES}


def restored_configuration(source, destination, selected, jobs, compose, expected_hashes, original_machine, new_machine, action):
    """Build a new private input; preserve every original byte except the machine binding.

    This does not start containers or change the existing runtime. The fresh-host
    executor must independently assert the actual new machine before calling it.
    """
    outside_checkout(source)
    outside_checkout(destination.parent)
    demand(isinstance(action, str) and re.fullmatch(r"restore-[a-z0-9][a-z0-9-]{0,80}", action), "RESTORE_ACTION_ID_REQUIRED")
    demand(all(isinstance(v, str) and re.fullmatch(r"[a-f0-9]{32}", v) and v != "0" * 32
               for v in (original_machine, new_machine)) and original_machine != new_machine,
           "RESTORE_DIFFERENT_EXACT_MACHINE_REQUIRED")
    demand(set(expected_hashes) == set(CONFIGURATION_FILES) and not destination.exists(), "RESTORE_FRESH_CONFIGURATION_REQUIRED")
    values = {}
    for name in CONFIGURATION_FILES:
        raw = migrate.read_input(source, name, 65_536)
        demand(migrate.file_hash(raw) == expected_hashes[name], "RESTORE_CONFIGURATION_HASH_MISMATCH")
        if name.endswith(".env"):
            runtime.environment_values(raw, "staging", name[:-4], jobs)
        values[name] = raw
    target = json.loads(values["runtime.json"])
    demand(target.get("hostMachineId") == original_machine and target.get("environment") == "staging"
           and target.get("releaseId") == selected["releaseId"], "RESTORE_ORIGINAL_MACHINE_BINDING_REQUIRED")
    updated = {**target, "hostMachineId": new_machine, "maintenanceRef": "staging/" + action}
    values["runtime.json"] = (json.dumps(updated) + "\n").encode()
    destination.mkdir(mode=0o700)
    for name, raw in values.items():
        file = destination / name
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with file.open("xb") as stream:
            stream.write(raw)
        file.chmod(0o600)
    with (destination / "compose.yaml").open("xb") as stream:
        stream.write(compose)
    (destination / "compose.yaml").chmod(0o600)
    return {"status": "RESTORE_CONFIGURATION_BOUND_TO_NEW_MACHINE", "originalHostMachineId": original_machine,
            "newHostMachineId": new_machine, "sourceSha256": expected_hashes,
            "restoredSha256": configuration_hashes(destination),
            "composeSha256": migrate.file_hash(compose), "originalConfigurationChanged": False,
            "migrationsExecuted": False, "containersStarted": False}
