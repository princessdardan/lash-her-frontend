#!/usr/bin/env python3
"""Prepare initial staging qualification: three databases, APIs and frontend."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

import frontend_probe
import migrate
import release as runtime
import vercel

demand = migrate.demand


def make_plan(bundle, configuration, compose_file):
    selected, jobs, api_plan, _compose = runtime.make_plan(bundle, configuration, compose_file)
    environment, project_id, commit = vercel.release_identity(selected)
    demand(environment == "staging", "INITIAL_QUALIFICATION_REQUIRES_STAGING")
    demand("frontend" in jobs, "THREE_DATABASE_STAGING_BUNDLE_REQUIRED")
    plan = {**api_plan, "operation": "initial-staging-qualification", "frontendProjectId": project_id, "frontendSourceCommit": commit,
            "frontendProducerSuspensionRequired": jobs["frontend"]["job"]["target"]["approvedPendingTags"] != [],
            "frontendStages": ["disable-native-schedules", "configure-expiring-probe", "build-pinned-frontend", "verify-server-workload", "promote-staging-domains"],
            "nativeSchedulerVerified": False, "releaseAccepted": False, "gatewayTrafficAuthorized": False}
    return selected, jobs, plan


def execute(bundle, configuration, results, compose_file, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock")):
    selected, jobs, plan = make_plan(bundle, configuration, compose_file)
    if not apply:
        return plan
    demand(confirmation == f'staging/{selected["releaseId"]}', "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
    # The known initial target is already current. Pending frontend SQL needs
    # the actual producer-drain coordinator, not a suspension-looking input.
    demand(not plan["frontendProducerSuspensionRequired"], "PENDING_FRONTEND_SQL_REQUIRES_QUIESCENCE_COORDINATOR")
    runtime.assert_host(plan)
    migrate.private_directory(results)
    client = vercel.Client(os.environ.get("VERCEL_TOKEN"))
    frontend_probe._automation_bypass(vercel._project(client, plan["frontendProjectId"]))
    before = vercel.promotion_state(client, plan["frontendProjectId"])
    demand(before["aliasJob"] is None or before["aliasJob"]["jobStatus"] in ("succeeded", "failed", "skipped"), "VERCEL_ALIAS_JOB_ALREADY_ACTIVE")
    expected = {key: before[key] for key in ("projectId", "productionDeploymentId", "cronsEnabled")}
    final = None

    def frontend(runtime_attempt, migration_attempt, snapshot, verified_release, api_outcome):
        nonlocal final
        demand(verified_release == selected and api_outcome.get("status") == "API_RUNTIME_READY"
               and api_outcome.get("trafficAuthorized") is False and api_outcome.get("releaseAccepted") is False,
               "STAGING_RUNTIME_BINDING_REFUSED")
        demand(migrate.read_json(runtime_attempt, "runtime-outcome.json") == api_outcome
               and migrate.file_hash(migrate.read_input(migration_attempt, "migration-outcome.json")) == api_outcome["migrationOutcomeSha256"],
               "STAGING_DURABLE_RUNTIME_RECEIPT_REQUIRED")
        current = migrate.read_json(migration_attempt / "frontend", "job-outcome.json")
        demand(current.get("status") == "DATABASE_VERIFIED" and current.get("readOnlyVerified") is True
               and current.get("migrationMode") == "verify-current-only", "STAGING_CURRENT_FRONTEND_VERIFICATION_REQUIRED")
        attempt = runtime_attempt / "frontend"
        attempt.mkdir(mode=0o700)
        outcome = {"environment": "staging", "releaseId": selected["releaseId"], "projectId": plan["frontendProjectId"],
                   "sourceCommit": plan["frontendSourceCommit"], "status": "FAILED_REQUIRES_REVIEW", "phase": "provider-state",
                   "trafficAuthorized": False, "gatewayTrafficAuthorized": False, "releaseAccepted": False,
                   "nativeSchedulerVerified": False, "externalIngressVerified": False, "frontendDomainsPromoted": False,
                   "candidateSha256": api_outcome["candidateSha256"], "migrationOutcomeSha256": api_outcome["migrationOutcomeSha256"],
                   "apiRuntimeReceiptSha256": migrate.file_hash(migrate.read_input(runtime_attempt, "runtime-outcome.json"))}
        migrate.write_json(attempt, "staging-started.json", outcome)
        try:
            demand(vercel.project_state(client, plan["frontendProjectId"]) == expected, "VERCEL_PROJECT_CHANGED_BEFORE_STAGING")
            outcome["phase"] = "native-schedule-suspension"
            schedules = vercel.disable_schedules(client, selected)
            migrate.write_json(attempt, "native-schedules.json", schedules)
            demand(vercel.project_state(client, plan["frontendProjectId"]) == {**expected, "cronsEnabled": False}, "VERCEL_PROJECT_CHANGED_BEFORE_STAGING")
            outcome["phase"] = "probe-configuration"
            frontend_probe.prepare(client, selected, snapshot, attempt, plan["publicHost"])
            outcome["phase"] = "frontend-build"
            vercel.stage_frontend(client, selected, attempt)
            outcome["phase"] = "frontend-verification-and-promotion"
            outcome["frontendDomainsPromoted"] = None
            promoted = vercel.promote_frontend(client, selected, attempt,
                lambda release, _deployment: frontend_probe.verify(client, release, attempt, snapshot))
            demand(promoted.get("status") == "FRONTEND_DOMAINS_PROMOTED" and promoted.get("frontendDomainsPromoted") is True,
                   "STAGING_FRONTEND_PROMOTION_UNVERIFIED")
            outcome.update(status="STAGING_READY_FOR_LIVE_QUALIFICATION", phase="completed", frontendDomainsPromoted=True,
                           frontendServerWorkloadVerified=True, nativeSchedulesDisabled=True,
                           frontendWorkloadReceiptSha256=migrate.file_hash(migrate.read_input(attempt, "frontend-workload-outcome.json")),
                           frontendPromotionReceiptSha256=migrate.file_hash(migrate.read_input(attempt, "frontend-promotion-outcome.json")))
            final = outcome
        except BaseException as error:
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "STAGING_FRONTEND_STAGE_FAILED"
            raise
        finally:
            migrate.write_json(attempt, "staging-outcome.json", outcome)

    runtime.execute(bundle, configuration, results, compose_file, True, confirmation, lock_path, after_runtime_ready=frontend)
    demand(final is not None, "STAGING_FRONTEND_CONTINUATION_UNVERIFIED")
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(signum, _frame):
        raise SystemExit(130 if signum == signal.SIGINT else 143)
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        print(json.dumps(execute(args.bundle, args.configuration, args.results, Path(__file__).parents[1] / "compose.yaml", args.apply, args.confirm)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print('{"status":"STAGING_RELEASE_REFUSED","trafficAuthorized":false,"reviewRequired":true}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
