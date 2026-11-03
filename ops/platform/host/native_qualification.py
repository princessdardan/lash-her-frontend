#!/usr/bin/env python3
"""Frontend-only staging qualification; native success needs provider evidence.

Never runs SQL, starts/replaces API containers, enables business schedules or
admits gateway writes. A fresh explicit action creates the probe at execution.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import frontend_probe
import migrate
import release as runtime
import staging_recovery
import vercel

PATH = "/api/internal/release-scheduler-probe"
SCHEDULE = "* * * * *"
demand = migrate.demand


def acquire_release_lock(lock, clock=time):
    """Wait for brief watchdog work before any provider access or action intent."""
    deadline = clock.monotonic() + 30
    while True:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - clock.monotonic()
            demand(remaining > 0, "NATIVE_RELEASE_LOCK_BUSY")
            clock.sleep(min(0.25, remaining))


def safe_failure(error):
    """Retain useful preflight errors without arbitrary exception payloads."""
    known = {"ValueError", "BlockingIOError", "FileExistsError", "PermissionError",
             "TimeoutError", "KeyboardInterrupt", "SystemExit"}
    code = str(error)
    return {"errorClass": type(error).__name__ if type(error).__name__ in known else "Exception",
            "failureCode": code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code)
            else "NATIVE_QUALIFICATION_EXECUTION_FAILED"}


def cron_binding(client, selected):
    environment, project, _commit = vercel.release_identity(selected)
    demand(environment == "staging", "NATIVE_QUALIFICATION_REQUIRES_STAGING")
    values = client.request("GET", f"/v10/projects/{project}/env?decrypt=false").get("envs")
    demand(isinstance(values, list), "NATIVE_CRON_BINDING_METADATA_REQUIRED")
    matches = [v for v in values if v.get("key") == "CRON_SECRET"]
    demand(len(matches) == 1, "NATIVE_SINGLE_CRON_BINDING_REQUIRED")
    value = matches[0]
    targets = value.get("target")
    demand(value.get("type") == "sensitive" and not value.get("gitBranch") and not value.get("customEnvironmentIds")
           and isinstance(value.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value["id"])
           and isinstance(targets, list) and (sorted(targets) == ["production"] or sorted(targets) == ["preview", "production"]),
           "NATIVE_CRON_BINDING_SCOPE_REFUSED")
    # No read, hash, copy or common-record export of the credential value.
    return {"id": value["id"], "key": "CRON_SECRET", "type": "sensitive", "targets": sorted(targets)}


def restrict_cron_binding(client, selected, output):
    before = cron_binding(client, selected)
    intent = {"key": "CRON_SECRET", "bindingId": before["id"], "previousTargets": before["targets"],
              "target": ["production"], "secretValueRequested": False, "secretValueSubmitted": False}
    outcome = {**intent, "status": "CRON_SCOPE_REQUIRES_REVIEW", "scopeChanged": False, "scopeChangeRequested": False}
    try:
        if before["targets"] != ["production"]:
            migrate.write_json(output, "cron-scope-started.json", intent)
            project = vercel.PROJECTS["staging"]
            outcome.update(scopeChangeRequested=True, scopeChanged=None)
            client.request("PATCH", f"/v9/projects/{project}/env/{before['id']}", {"target": ["production"]})
        after = cron_binding(client, selected)
        demand(after == {**before, "targets": ["production"]}, "NATIVE_CRON_SCOPE_CHANGE_UNVERIFIED")
        outcome["scopeChanged"] = outcome["scopeChangeRequested"]
        outcome["status"] = "CRON_SECRET_RESTRICTED_TO_STAGING_PRODUCTION_TARGET"
        return outcome
    finally:
        migrate.write_json(output, "cron-scope-outcome.json", outcome)


def schedule_state(client, selected, deployment_id, enabled):
    environment, project, commit = vercel.release_identity(selected)
    demand(environment == "staging", "NATIVE_QUALIFICATION_REQUIRES_STAGING")
    deployment = vercel.deployment_state(client, deployment_id, project, commit, selected["releaseId"])
    project_value = vercel._project(client, project)
    cron = project_value.get("crons") or {}
    definitions = cron.get("definitions")
    demand(deployment["readyState"] == "READY"
           and (project_value.get("targets") or {}).get("production", {}).get("id") == deployment_id
           and cron.get("deploymentId") == deployment_id
           and (cron.get("disabledAt") is None) is enabled
           and isinstance(definitions, list) and len(definitions) == 1
           and definitions[0].get("path") == PATH and definitions[0].get("schedule") == SCHEDULE
           and definitions[0].get("host") == deployment["url"].removeprefix("https://"),
           "NATIVE_EXACT_DEPLOYMENT_AND_SINGLE_SMOKE_REQUIRED")
    return {"projectId": project, "deploymentId": deployment_id, "sourceCommit": commit,
            "enabled": enabled, "path": PATH, "schedule": SCHEDULE, "host": definitions[0]["host"]}


def native_window(client, selected, frontend, output, private, window_seconds=180, clock=time):
    demand(type(window_seconds) is int and 60 <= window_seconds <= 180, "NATIVE_WINDOW_BOUND_REQUIRED")
    identity = vercel._staged_identity(selected, frontend)
    deployment_id, project = identity["deploymentId"], identity["projectId"]
    credential = frontend_probe._private_input(private, identity)
    demand(credential["expiresAt"] > int(clock.time() * 1000) + (window_seconds + 100) * 1000,
           "NATIVE_LIVE_QUALIFICATION_WINDOW_REQUIRED")
    before = schedule_state(client, selected, deployment_id, False)
    intent = {**before, "releaseId": selected["releaseId"], "windowSeconds": window_seconds,
              "maximumFunctionSeconds": 15, "drainSeconds": 16, "cancellationObservationSeconds": 60,
              "manualCronInvocation": False, "cronSecretRead": False, "nativeSchedulerVerified": False}
    migrate.write_json(output, "native-window-started.json", intent)
    outcome = {**intent, "status": "NATIVE_WINDOW_REQUIRES_REVIEW", "phase": "enable",
               "enableRequestStartedAt": int(clock.time() * 1000), "disabledAndDrained": False}
    # An ambiguous enable may have succeeded: always disable in finally. Never
    # repeat an uncertain enable and never use a caller-supplied success receipt.
    enable_requested = False
    deadline = clock.monotonic() + window_seconds
    try:
        enable_requested = True
        client.request("PATCH", f"/v1/projects/{project}/crons", {"enabled": True})
        schedule_state(client, selected, deployment_id, True)
        outcome.update(phase="native-observation", enabledConfirmedAt=int(clock.time() * 1000))
        while clock.monotonic() < deadline:
            clock.sleep(max(0, min(15, deadline - clock.monotonic())))
            # Do not put provider reads in front of the cancellation deadline.
            # The shared release lock prevents another reviewed host release;
            # exact provider identity/definitions are checked again on disable.
        outcome["windowElapsed"] = True
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "NATIVE_WINDOW_INTERRUPTED"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        if enable_requested:
            try:
                outcome["phase"] = "disable-and-drain"
                client.request("PATCH", f"/v1/projects/{project}/crons", {"enabled": False})
                schedule_state(client, selected, deployment_id, False)
                outcome["disabledConfirmedAt"] = int(clock.time() * 1000)
                clock.sleep(16)
                schedule_state(client, selected, deployment_id, False)
                outcome["drainCompletedAt"] = int(clock.time() * 1000)
                clock.sleep(60)
                schedule_state(client, selected, deployment_id, False)
                outcome["cancellationObservationCompletedAt"] = int(clock.time() * 1000)
                outcome["disabledAndDrained"] = True
                if outcome.get("windowElapsed") is True and not outcome.get("failureCode"):
                    outcome.update(status="NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE", phase="provider-evidence")
            except BaseException:
                outcome.update(status="NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW", phase="disable-or-drain-failed")
                raise ValueError("NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW") from None
            finally:
                migrate.write_json(output, "native-window-outcome.json", outcome)
    return outcome


def execute(prior, database_attempt, output, expected_deployment, apply=False, confirmation=None,
            client=None, lock_path=Path("/run/lock/lash-her-release.lock"), window_seconds=180, clock=time):
    selected, original = staging_recovery.make_plan(prior, database_attempt)
    demand(isinstance(expected_deployment, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", expected_deployment),
           "NATIVE_EXPECTED_CURRENT_DEPLOYMENT_REQUIRED")
    plan = {"operation": "frontend-only-native-qualification", "releaseId": selected["releaseId"],
            "environment": "staging", "hostMachineId": original["hostMachineId"],
            "frontendSourceCommit": original["frontend"]["sourceCommit"], "frontendProjectId": original["frontend"]["projectId"],
            "expectedCurrentDeploymentId": expected_deployment, "candidateSha256": original["candidateSha256"],
            "migrationOutcomeSha256": original["migrationOutcomeSha256"], "nativeWindowSeconds": window_seconds,
            "migrationsExecuted": False, "apiContainersReplaced": False, "gatewayWritesEnabled": False,
            "businessSchedulesEnabled": False, "nativeSchedulerVerified": False, "releaseAccepted": False}
    plan["existingCronSecretScope"] = "restrict existing sensitive binding to staging project's Production target; omit value"
    demand(type(window_seconds) is int and 60 <= window_seconds <= 180, "NATIVE_WINDOW_BOUND_REQUIRED")
    if not apply:
        return plan
    demand(confirmation == "staging/" + selected["releaseId"] + "/native-qualification-1", "EXPLICIT_NATIVE_QUALIFICATION_CONFIRMATION_REQUIRED")
    runtime.assert_host(plan)
    migrate.private_directory(output.parent)
    demand(not any((p / ".git").exists() for p in (output.parent.resolve(), *output.parent.resolve().parents))
           and not output.resolve().is_relative_to(prior.resolve()) and not output.resolve().is_relative_to(database_attempt.resolve()),
           "NATIVE_SEPARATE_PRIVATE_OUTPUT_REQUIRED")
    client = client or vercel.Client(os.environ.get("VERCEL_TOKEN"))
    outcome = {**plan, "status": "FRONTEND_NATIVE_QUALIFICATION_REQUIRES_REVIEW", "phase": "preflight"}
    with lock_path.open("a+") as lock:
        acquire_release_lock(lock, clock)
        current = vercel.project_state(client, plan["frontendProjectId"])
        demand(current == {"projectId": plan["frontendProjectId"], "productionDeploymentId": expected_deployment, "cronsEnabled": False},
               "NATIVE_CURRENT_PROJECT_CHANGED")
        actual = runtime.check_containers(selected, prior / "configuration")
        demand({c["containerId"] for c in actual} == {c["containerId"] for c in original["containers"]}, "NATIVE_ORIGINAL_RUNTIME_REQUIRED")
        frontend_probe._automation_bypass(vercel._project(client, plan["frontendProjectId"]))
        output.mkdir(mode=0o700)
        migrate.write_json(output, "qualification-started.json", plan)
        frontend, private = output / "frontend", output / "private"
        frontend.mkdir(mode=0o700)
        private.mkdir(mode=0o700)
        try:
            outcome["phase"] = "restrict-cron-binding-metadata"
            restrict_cron_binding(client, selected, output)
            demand(vercel.project_state(client, plan["frontendProjectId"]) == current, "NATIVE_CURRENT_PROJECT_CHANGED")
            outcome["phase"] = "new-expiring-probe"
            frontend_probe.prepare(client, selected, private, frontend, original["publicHost"], scheduler_qualification=True)
            outcome["phase"] = "exact-source-build"
            vercel.stage_frontend(client, selected, frontend)
            demand(vercel._staged_identity(selected, frontend)["previousDeploymentId"] == expected_deployment,
                   "NATIVE_BUILD_PREVIOUS_DEPLOYMENT_CHANGED")
            outcome["phase"] = "server-verification-and-promotion"
            promotion = vercel.promote_frontend(client, selected, frontend,
                lambda release, _deployment: frontend_probe.verify(client, release, frontend, private))
            demand(promotion.get("frontendDomainsPromoted") is True, "NATIVE_FRONTEND_PROMOTION_REQUIRED")
            outcome["frontendDeploymentId"] = promotion["deploymentId"]
            outcome["phase"] = "native-window"
            window = native_window(client, selected, frontend, output, private, window_seconds, clock)
            outcome.update(status=window["status"], phase="provider-evidence", nativeWindow=window,
                           frontendServerWorkloadVerified=True, frontendDomainsPromoted=True,
                           nativeSchedulesDisabled=True)
            return outcome
        except BaseException as error:
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "NATIVE_QUALIFICATION_EXECUTION_FAILED"
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "qualification-outcome.json", outcome)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prior", type=Path)
    parser.add_argument("database_attempt", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-deployment", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        print(json.dumps(execute(args.prior, args.database_attempt, args.output, args.expected_deployment, args.apply, args.confirm)))
    except BaseException as error:
        print(json.dumps({"status": "FRONTEND_NATIVE_QUALIFICATION_REFUSED", "reviewRequired": True,
                          **safe_failure(error)}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
