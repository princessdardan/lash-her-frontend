"""Quiesce the reviewed staging runtime. Never calls AWS or deletes a machine.

The local parent supplies the independently reviewed, fresh, masked Mux
dashboard inventory. This component cannot disable Mux webhooks or accept an
operator's unverified claim that an external producer has been suspended.
"""
import copy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import re
import time

import migrate
import native_qualification
import release as runtime
import staging_restore
import staging_state
import vercel

demand = migrate.demand
TIMERS = ("lash-her-watchdog.timer", "lash-her-certificates-staging.timer")
SERVICES = ("lash-her-watchdog.service", "lash-her-certificates-staging.service")
MUX_PAGE = "https://dashboard.mux.com/organizations/4g1uhq/environments/7j65e8/settings/webhooks?page=1&limit=25&create=false"


def external_inventory(directory, expected_hash, now):
    staging_state.outside_checkout(directory)
    raw = migrate.read_input(directory, "mux-inventory.json")
    demand(migrate.file_hash(raw) == expected_hash, "RETIRE_REVIEWED_EXTERNAL_INVENTORY_HASH_REQUIRED")
    value = json.loads(raw)
    demand(value.get("status") == "MUX_DEV_DASHBOARD_INVENTORY_VERIFIED"
           and value.get("environmentId") == "7j65e8" and value.get("organizationId") == "4g1uhq"
           and value.get("environmentName") == "Lash Her Academy [DEV]" and value.get("sourceUrl") == MUX_PAGE
           and value.get("inventoryComplete") is True and value.get("settingsChanged") is False
           and value.get("webhooks") == [{"address": "http://localhost:4000/v1/webhooks/mux", "enabled": True}]
           and value.get("stagingGatewayWebhookCount") == 0
           and type(value.get("observedAt")) is int and 0 <= now - value["observedAt"] <= 900_000
           and isinstance(value.get("maskedAccessibilitySha256"), str)
           and re.fullmatch(r"[a-f0-9]{64}", value["maskedAccessibilitySha256"])
           and isinstance(value.get("maskedScreenshotSha256"), str)
           and re.fullmatch(r"[a-f0-9]{64}", value["maskedScreenshotSha256"]), "RETIRE_FRESH_REVIEWED_DEV_INVENTORY_REQUIRED")
    return {"inventorySha256": expected_hash, "observedAt": value["observedAt"],
            "disposition": "no-staging-gateway-webhook-configured", "providerSettingsChanged": False}


def unit_state(unit):
    demand(unit in (*TIMERS, *SERVICES), "RETIRE_FIXED_MAINTENANCE_UNIT_REQUIRED")
    raw = runtime.command(["systemctl", "show", "--property=LoadState,ActiveState,UnitFileState", unit], runtime.SAFE_ENV)
    value = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    demand(set(value) == {"LoadState", "ActiveState", "UnitFileState"} and value["LoadState"] == "loaded",
           "RETIRE_KNOWN_MAINTENANCE_UNITS_REQUIRED")
    return value


def provider_state(client, selected, plan, now):
    state = staging_restore.check_provider(client, selected, plan)
    # Read the timestamp rather than merely assuming a disabled schedule's
    # previous invocation has finished. The selected function has a 15s cap.
    project = vercel._project(client, state["projectId"])
    crons = project.get("crons") or {}
    disabled = crons.get("disabledAt")
    demand(crons.get("deploymentId") == plan["frontendDeploymentId"] and type(disabled) is int
           and 16_000 <= now - disabled, "RETIRE_NATIVE_DISABLED_AND_DRAINED_REQUIRED")
    return {**state, "disabledAt": disabled, "drainVerifiedAt": now}


def stopped_container(container):
    fields = '{{.Id}}|{{.Config.Image}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
    actual = runtime.command(["docker", "inspect", "--format", fields, container["containerId"]], runtime.SAFE_ENV).split("|")
    demand(actual == [container["containerId"], container["image"], "false", "0", "false", "lash-her-staging", container["service"]],
           "RETIRE_GRACEFUL_EXACT_CONTAINER_STOP_REQUIRED")
    return {**container, "running": False, "exitCode": 0, "oomKilled": False}


def execute(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256,
            inventory_directory, inventory_sha256, expected_configuration_sha256, expected_deployment,
            action, output, apply=False, confirmation=None, client=None,
            lock_path=Path("/run/lock/lash-her-release.lock"), before_stop=None, clock=time, lock_handle=None):
    selected, jobs, plan, _compose = staging_state.retained_state(bundle, configuration, database_receipts,
        runtime_receipts, compose_file, candidate_sha256)
    demand(isinstance(action, str) and re.fullmatch(r"retire-[a-z0-9][a-z0-9-]{0,80}", action), "RETIRE_ACTION_REQUIRED")
    demand(isinstance(expected_deployment, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", expected_deployment), "RETIRE_DEPLOYMENT_REQUIRED")
    demand(isinstance(expected_configuration_sha256, dict) and set(expected_configuration_sha256) == set(staging_state.CONFIGURATION_FILES)
           and all(isinstance(h, str) and re.fullmatch(r"[a-f0-9]{64}", h) for h in expected_configuration_sha256.values()),
           "RETIRE_REVIEWED_OFFHOST_CONFIGURATION_HASHES_REQUIRED")
    external = external_inventory(inventory_directory, inventory_sha256, int(clock.time() * 1000))
    plan.update(operation="quiesce-current-staging-runtime-for-recreation", action=action,
                frontendDeploymentId=expected_deployment, externalProducerInventory=external,
                configurationSha256=expected_configuration_sha256, infrastructureOperationIncluded=False,
                hostRetired=False, migrationsExecuted=False)
    if not apply:
        return plan
    demand(confirmation == "staging/" + selected["releaseId"] + "/" + action, "EXPLICIT_STAGING_RETIRE_CONFIRMATION_REQUIRED")
    demand(client is not None and (before_stop is None or callable(before_stop)), "RETIRE_TRUSTED_PARENT_REQUIRED")
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and not any(output.resolve().is_relative_to(p.resolve()) for p in
        (bundle, configuration, database_receipts, runtime_receipts, inventory_directory)), "RETIRE_SEPARATE_EXCLUSIVE_OUTPUT_REQUIRED")
    outcome = {**plan, "status": "STAGING_QUIESCENCE_REQUIRES_REVIEW", "phase": "read-only-preflight"}
    with (lock_path.open("a+") if lock_handle is None else nullcontext(lock_handle)) as lock:
        if lock_handle is not None:
            actual, expected = os.fstat(lock.fileno()), lock_path.stat()
            demand((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), "RETIRE_EXACT_PARENT_LOCK_HANDLE_REQUIRED")
        native_qualification.acquire_release_lock(lock)
        runtime.assert_host({"hostMachineId": plan["originalHostMachineId"]})
        actual = runtime.check_containers(selected, configuration)
        demand({c["containerId"] for c in actual} == {c["containerId"] for c in plan["originalContainers"]}, "RETIRE_ORIGINAL_CONTAINER_IDENTITIES_REQUIRED")
        all_ids = runtime.command(["docker", "ps", "--all", "--quiet", "--no-trunc"], runtime.SAFE_ENV).splitlines()
        demand(set(all_ids) == {c["containerId"] for c in actual}, "RETIRE_NO_UNREVIEWED_CONTAINERS_REQUIRED")
        demand(staging_state.configuration_hashes(configuration) == expected_configuration_sha256, "RETIRE_OFFHOST_CONFIGURATION_MISMATCH")
        provider_state(client, selected, plan, int(clock.time() * 1000))
        for unit in SERVICES:
            demand(unit_state(unit)["ActiveState"] == "inactive", "RETIRE_MAINTENANCE_SERVICE_MUST_BE_IDLE")
        output.mkdir(mode=0o700)
        migrate.write_json(output, "retirement-started.json", plan)
        try:
            outcome.update(phase="pause-maintenance-timers", pausedTimers=[])
            for unit in TIMERS:
                runtime.command(["systemctl", "disable", "--now", unit], runtime.SAFE_ENV, 90)
                state = unit_state(unit)
                demand(state["ActiveState"] == "inactive" and state["UnitFileState"] == "disabled", "RETIRE_TIMER_PAUSE_UNVERIFIED")
                outcome["pausedTimers"].append(unit)
            # Never kill a certificate rotation that raced timer disablement.
            for unit in SERVICES:
                demand(unit_state(unit)["ActiveState"] == "inactive", "RETIRE_MAINTENANCE_SERVICE_MUST_BE_IDLE")
            outcome["hostTimersStopped"] = True
            outcome["phase"] = "retained-work-preparation"
            if before_stop is not None:
                before_stop(copy.deepcopy(selected), copy.deepcopy(plan), configuration, output)
            external_inventory(inventory_directory, inventory_sha256, int(clock.time() * 1000))
            provider = provider_state(client, selected, plan, int(clock.time() * 1000))
            outcome["phase"] = "drain-original-runtime"
            by_service = {c["service"]: c for c in plan["originalContainers"]}
            stopped = []
            outcome["stoppedContainers"] = stopped
            # Public gateway first, then publishers/workers, then receivers.
            for stage in reversed(runtime.STAGES):
                for service in stage:
                    container = by_service[service]
                    returned = runtime.command(["docker", "stop", "--timeout", "90", container["containerId"]], runtime.SAFE_ENV, 110)
                    demand(returned == container["containerId"], "RETIRE_EXACT_STOP_ACK_REQUIRED")
                    stopped.append(stopped_container(container))
            demand(not runtime.command(["docker", "ps", "--quiet"], runtime.SAFE_ENV), "RETIRE_ZERO_RUNNING_CONTAINERS_REQUIRED")
            demand(not runtime.command(["ss", "-H", "-ltn", "sport = :443"], runtime.SAFE_ENV), "RETIRE_NO_PUBLIC_TLS_LISTENER_REQUIRED")
            for unit in (*TIMERS, *SERVICES):
                demand(unit_state(unit)["ActiveState"] == "inactive", "RETIRE_MAINTENANCE_RESTARTED")
            provider_state(client, selected, plan, int(clock.time() * 1000))
            outcome.update(status="STAGING_RUNTIME_QUIESCED_FOR_RECREATION", phase="completed", stoppedContainers=stopped,
                nativeSchedulesDisabled=True, nativeSchedule=provider, externalProducersSuspended=True,
                publicIngressStopped=True, hostTimersStopped=True, completedAt=int(clock.time() * 1000))
            return outcome
        except BaseException as error:
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", code) else "STAGING_QUIESCENCE_EXECUTION_FAILED"
            outcome["partialChangesRequireInspection"] = True
            # No restart, provider write, SQL retry, detach or deletion occurs
            # after a failure. Preserve actual partial progress for review.
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "retirement-outcome.json", outcome)
