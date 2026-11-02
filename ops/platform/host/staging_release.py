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


def configure_source_pins(client, selected, jobs, migration_attempt, attempt):
    """Bind existing staging build guards only to the completed database stage."""
    environment, project_id, commit = vercel.release_identity(selected)
    demand(environment == "staging", "SOURCE_PINS_REQUIRE_STAGING")
    job = jobs["frontend"]["job"]
    database_raw = migrate.read_input(migration_attempt / "frontend", "database-receipt.json")
    database = json.loads(database_raw)
    terminal = migrate.read_json(migration_attempt / "frontend", "job-outcome.json")
    migration = migrate.read_json(migration_attempt, "migration-outcome.json")
    demand(migration.get("status") == "DATABASES_VERIFIED" and migration.get("environment") == environment
           and migration.get("releaseId") == selected["releaseId"]
           and migration.get("databaseReceiptSha256", {}).get("frontend") == migrate.file_hash(database_raw),
           "DURABLE_FRONTEND_DATABASE_BINDING_REQUIRED")
    common = ("environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
              "contractManifestSha256", "schemaBaselineSha256")
    demand(job.get("sourceCommit") == commit and job["target"]["approvedPendingTags"] == []
           and all(database.get(key) == terminal.get(key) == job.get(key) for key in common)
           and all(database.get(key) is not None for key in common)
           and database.get("status") == terminal.get("status") == "DATABASE_VERIFIED"
           and database.get("service") == terminal.get("service") == "frontend"
           and database.get("migrationMode") == terminal.get("migrationMode") == "verify-current-only"
           and database.get("readOnlyVerified") is True and terminal.get("readOnlyVerified") is True
           and database.get("schemaVerified") is True and database.get("runtimeRoleVerified") is True
           and database.get("applied") == [] and not database.get("failureCode") and not terminal.get("failureCode")
           and database.get("target") == terminal.get("target")
           and all(database.get("target", {}).get(key) == job["target"].get(key)
                   for key in ("host", "port", "database", "user", "serverMajor")),
           "VERIFIED_CURRENT_FRONTEND_SOURCE_REQUIRED")
    keys = ("STAGING_RELEASE_COMMIT", "STAGING_MIGRATION_VERIFIED_COMMIT")
    outcome = {"status": "SOURCE_PINS_FAILED_REQUIRES_REVIEW", "projectId": project_id, "sourceCommit": commit,
               "releaseId": selected["releaseId"], "configuredKeys": [], "trafficAuthorized": False}
    migrate.write_json(attempt, "source-pins-started.json", outcome)
    try:
        for key in keys:
            value = client.request("POST", f"/v10/projects/{project_id}/env?upsert=true", {
                "key": key, "value": commit, "type": "plain", "target": ["production"],
                "gitBranch": None, "customEnvironmentIds": [], "comment": "Verified staging release " + selected["releaseId"],
            })
            created = value.get("created")
            demand(value.get("failed") == [] and isinstance(created, dict) and created.get("key") == key
                   and created.get("target") == ["production"] and created.get("type") == "plain"
                   and not created.get("gitBranch") and not created.get("customEnvironmentIds"), "SOURCE_PIN_WRITE_UNVERIFIED")
        readback = client.request("GET", f"/v10/projects/{project_id}/env?decrypt=false")
        variables = readback.get("envs")
        demand(isinstance(variables, list), "SOURCE_PIN_READBACK_UNVERIFIED")
        for key in keys:
            matches = [item for item in variables if item.get("key") == key and "production" in item.get("target", [])
                       and not item.get("gitBranch") and not item.get("customEnvironmentIds")]
            demand(len(matches) == 1 and matches[0].get("type") == "plain" and matches[0].get("value") == commit,
                   "SOURCE_PIN_READBACK_UNVERIFIED")
        outcome.update(status="SOURCE_PINS_CONFIGURED", configuredKeys=list(keys))
        return outcome
    finally:
        migrate.write_json(attempt, "source-pins-outcome.json", outcome)


def make_plan(bundle, configuration, compose_file):
    selected, jobs, api_plan, _compose = runtime.make_plan(bundle, configuration, compose_file)
    environment, project_id, commit = vercel.release_identity(selected)
    demand(environment == "staging", "INITIAL_QUALIFICATION_REQUIRES_STAGING")
    demand("frontend" in jobs, "THREE_DATABASE_STAGING_BUNDLE_REQUIRED")
    plan = {**api_plan, "operation": "initial-staging-qualification", "frontendProjectId": project_id, "frontendSourceCommit": commit,
            "frontendProducerSuspensionRequired": jobs["frontend"]["job"]["target"]["approvedPendingTags"] != [],
            "frontendStages": ["disable-native-schedules", "bind-verified-source-pins", "configure-expiring-probe", "build-pinned-frontend", "verify-server-workload", "promote-staging-domains"],
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
            outcome["phase"] = "verified-source-pins"
            configure_source_pins(client, selected, jobs, migration_attempt, attempt)
            outcome["phase"] = "probe-configuration"
            frontend_probe.prepare(client, selected, snapshot, attempt, plan["publicHost"], scheduler_qualification=True)
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
