"""Qualify a newly restored staging runtime under the parent's held lock.

Original runtime/native receipts remain immutable. This continuation accepts
only the new restore receipt and actual publisher observations, never a claimed
callback success. Provider request records are still required after the window.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import time

import frontend_probe
import migrate
import native_qualification as native
import release as runtime
import runtime_actions
import staging_state
import vercel

demand = migrate.demand


def held_lock(lock, path):
    actual, expected = os.fstat(lock.fileno()), path.stat()
    demand((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), "RESTORE_NATIVE_EXACT_PARENT_LOCK_REQUIRED")
    with path.open("a+") as independent:
        try:
            fcntl.flock(independent.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(independent.fileno(), fcntl.LOCK_UN)
            raise ValueError("RESTORE_NATIVE_PARENT_LOCK_NOT_HELD")
    # Also prove this descriptor owns the lock, rather than a different process.
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise ValueError("RESTORE_NATIVE_PARENT_LOCK_NOT_HELD") from None


def make_plan(selected, restore_plan, configuration, restored, expected_ready_sha256,
              programs, action, window_seconds=180):
    for directory in (configuration, restored):
        staging_state.outside_checkout(directory)
    environment, project, commit = vercel.release_identity(selected)
    demand(environment == "staging" and restore_plan.get("environment") == "staging"
           and restore_plan.get("releaseId") == selected["releaseId"], "RESTORE_NATIVE_STAGING_BINDING_REQUIRED")
    demand(isinstance(action, str) and re.fullmatch(r"native-restore-[a-z0-9][a-z0-9-]{0,65}", action), "RESTORE_NATIVE_ACTION_REQUIRED")
    demand(type(window_seconds) is int and 60 <= window_seconds <= 180, "NATIVE_WINDOW_BOUND_REQUIRED")
    raw = migrate.read_input(restored, "runtime-outcome.json")
    demand(migrate.file_hash(raw) == expected_ready_sha256, "RESTORE_NATIVE_EXACT_READY_RECEIPT_REQUIRED")
    ready = json.loads(raw)
    demand(ready.get("status") == "API_RUNTIME_RESTORED_FOR_QUALIFICATION" and ready.get("phase") == "completed"
           and all(ready.get(key) == restore_plan[key] for key in
                   ("environment", "releaseId", "candidateSha256", "migrationOutcomeSha256", "retirementOutcomeSha256"))
           and ready.get("hostMachineId") == restore_plan.get("newHostMachineId")
           and ready.get("hostMachineId") != restore_plan.get("originalHostMachineId")
           and ready.get("trafficAuthorized") is False and ready.get("releaseAccepted") is False
           and ready.get("migrationsExecuted") is False, "RESTORE_NATIVE_FRESH_RUNTIME_REQUIRED")
    target = migrate.read_json(configuration, "runtime.json")
    demand(target.get("hostMachineId") == ready["hostMachineId"] and target.get("environment") == "staging"
           and target.get("releaseId") == selected["releaseId"], "RESTORE_NATIVE_CONFIGURATION_BINDING_REQUIRED")
    containers = ready.get("containers", [])
    demand(len(containers) == 8 and {c.get("service") for c in containers} == set(runtime.SERVICES)
           and len({c.get("containerId") for c in containers}) == 8
           and all(isinstance(c.get("containerId"), str) and re.fullmatch(r"[a-f0-9]{64}", c["containerId"])
                   and c.get("image") == selected["artifacts"][runtime.IMAGE_KEYS[c["service"]]]["image"] for c in containers)
           and not ({c["containerId"] for c in containers} & {c["containerId"] for c in restore_plan["originalContainers"]}),
           "RESTORE_NATIVE_NEW_PINNED_CONTAINERS_REQUIRED")
    current_raw = migrate.read_input(restored / "database-current", "current-databases-outcome.json")
    current = json.loads(current_raw)
    demand(migrate.file_hash(current_raw) == ready.get("databaseCurrentOutcomeSha256")
           and current.get("status") == "CURRENT_DATABASES_READ_ONLY_VERIFIED" and current.get("migrationsExecuted") is False
           and current.get("releaseId") == selected["releaseId"] and current.get("environment") == "staging"
           and set(current.get("databases", {})) == {"frontend", "course", "community"}, "RESTORE_NATIVE_THREE_CURRENT_CHECKS_REQUIRED")
    for name, info in current["databases"].items():
        receipt = migrate.read_input(restored / "database-current" / name, "database-receipt.json")
        demand(migrate.file_hash(receipt) == info.get("receiptSha256")
               and info.get("image") == selected["artifacts"][name + "Migration"]["image"], "RESTORE_NATIVE_CURRENT_RECEIPT_CHAIN_REQUIRED")
    recovery_raw = migrate.read_input(restored / "publisher-checkpoint", "durable-recovery.json")
    recovery = json.loads(recovery_raw)
    apis = [next(c for c in containers if c["service"] == name + "-api") for name in ("course", "community")]
    demand(set(programs) == {"fixture", "work"}
           and recovery.get("apiContainers") == apis
           and recovery.get("operatorProgramsSha256") == {key: info["sha256"] for key, info in programs.items()},
           "RESTORE_NATIVE_ACTUAL_NEW_PUBLISHER_REQUIRED")
    runtime_actions.recovered(recovery["retained"], recovery["outbox"], recovery["inbox"])
    return {"operation": "restored-staging-frontend-native-qualification", "action": action,
            "environment": environment, "releaseId": selected["releaseId"], "hostMachineId": ready["hostMachineId"],
            "candidateSha256": ready["candidateSha256"], "restoredRuntimeReceiptSha256": expected_ready_sha256,
            "durableRecoveryReceiptSha256": migrate.file_hash(recovery_raw), "databaseCurrentOutcomeSha256": migrate.file_hash(current_raw),
            "frontendProjectId": project, "frontendSourceCommit": commit,
            "expectedCurrentDeploymentId": restore_plan["frontendDeploymentId"], "publicHost": restore_plan["publicHost"],
            "nativeWindowSeconds": window_seconds, "nativeSchedulerVerified": False, "releaseAccepted": False,
            "migrationsExecuted": False, "apiContainersReplaced": False, "gatewayWritesEnabled": False,
            "businessSchedulesEnabled": False}, containers


def execute(selected, restore_plan, configuration, restored, expected_ready_sha256, programs,
            action, output, lock_handle, client, apply=False, confirmation=None,
            lock_path=Path("/run/lock/lash-her-release.lock"), window_seconds=180, clock=time):
    plan, containers = make_plan(selected, restore_plan, configuration, restored, expected_ready_sha256,
                                 programs, action, window_seconds)
    if not apply:
        return plan
    demand(confirmation == "staging/" + selected["releaseId"] + "/" + action, "EXPLICIT_RESTORED_NATIVE_CONFIRMATION_REQUIRED")
    demand(client is not None and lock_handle is not None, "RESTORE_NATIVE_TRUSTED_LOCKED_PARENT_REQUIRED")
    held_lock(lock_handle, lock_path)
    runtime.assert_host(plan)
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and not output.resolve().is_relative_to(configuration.resolve()), "RESTORE_NATIVE_FRESH_PRIVATE_OUTPUT_REQUIRED")
    demand(runtime.check_containers(selected, configuration) == containers, "RESTORE_NATIVE_ACTUAL_RUNTIME_CHANGED")
    current = vercel.project_state(client, plan["frontendProjectId"])
    demand(current == {"projectId": plan["frontendProjectId"], "productionDeploymentId": plan["expectedCurrentDeploymentId"], "cronsEnabled": False},
           "RESTORE_NATIVE_PROVIDER_CHANGED")
    frontend_probe._automation_bypass(vercel._project(client, plan["frontendProjectId"]))
    output.mkdir(mode=0o700)
    migrate.write_json(output, "qualification-started.json", plan)
    outcome = {**plan, "status": "RESTORED_NATIVE_QUALIFICATION_REQUIRES_REVIEW", "phase": "cron-binding"}
    frontend, private = output / "frontend", output / "private"
    frontend.mkdir(mode=0o700); private.mkdir(mode=0o700)
    try:
        native.restrict_cron_binding(client, selected, output)
        demand(vercel.project_state(client, plan["frontendProjectId"]) == current, "RESTORE_NATIVE_PROVIDER_CHANGED")
        outcome["phase"] = "fresh-private-probe"
        frontend_probe.prepare(client, selected, private, frontend, plan["publicHost"], scheduler_qualification=True)
        outcome["phase"] = "exact-source-build"
        vercel.stage_frontend(client, selected, frontend)
        demand(vercel._staged_identity(selected, frontend)["previousDeploymentId"] == plan["expectedCurrentDeploymentId"],
               "RESTORE_NATIVE_BUILD_BASE_CHANGED")
        demand(runtime.check_containers(selected, configuration) == containers, "RESTORE_NATIVE_ACTUAL_RUNTIME_CHANGED")
        outcome["phase"] = "server-verification-and-promotion"
        promotion = vercel.promote_frontend(client, selected, frontend,
            lambda release, _deployment: frontend_probe.verify(client, release, frontend, private))
        demand(promotion.get("frontendDomainsPromoted") is True, "RESTORE_NATIVE_FRONTEND_PROMOTION_REQUIRED")
        outcome["frontendDeploymentId"] = promotion["deploymentId"]
        outcome["phase"] = "bounded-native-window"
        window = native.native_window(client, selected, frontend, output, private, window_seconds, clock)
        demand(window.get("disabledAndDrained") is True
               and window.get("status") == "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE", "RESTORE_NATIVE_DISABLE_AND_DRAIN_REQUIRED")
        demand(runtime.check_containers(selected, configuration) == containers, "RESTORE_NATIVE_ACTUAL_RUNTIME_CHANGED")
        outcome.update(status=window["status"], phase="provider-evidence", nativeWindow=window,
                       frontendServerWorkloadVerified=True, frontendDomainsPromoted=True, nativeSchedulesDisabled=True)
        return outcome
    except BaseException as error:
        outcome["failureCode"] = runtime_actions.safe_code(error)
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "qualification-outcome.json", outcome)
