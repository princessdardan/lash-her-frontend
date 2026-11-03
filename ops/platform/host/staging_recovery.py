#!/usr/bin/env python3
"""Recover stopped staging containers after a reconciled frontend promotion.

No migration, build, promotion, container replacement or schedule mutation.
The original failure receipts remain immutable. Plan and check are read-only.
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
import docker_inspect
import vercel

demand = migrate.demand


class ReadOnlyClient(vercel.Client):
    def request(self, method, path, body=None):
        demand(method == "GET" and body is None, "RECOVERY_PROVIDER_MUTATION_REFUSED")
        return super().request(method, path, body)


def make_plan(prior, database_attempt):
    for directory in (prior, database_attempt):
        migrate.private_directory(directory)
        demand(not any((p / ".git").exists() for p in (directory.resolve(), *directory.resolve().parents)),
               "RECOVERY_PRIVATE_INPUTS_OUTSIDE_CHECKOUT_REQUIRED")
    snapshot = prior / "configuration"
    selected, jobs, plan, _compose = runtime.make_plan(prior / "migration-input", snapshot, snapshot / "compose.yaml")
    environment, project, commit = vercel.release_identity(selected)
    demand(environment == "staging", "RECOVERY_REQUIRES_STAGING")
    ready = migrate.read_json(prior, "runtime-outcome.json")
    failure = migrate.read_json(prior, "runtime-failure.json")
    frontend = prior / "frontend"
    identity = vercel._staged_identity(selected, frontend)
    intent = migrate.read_json(frontend, "frontend-promotion-started.json")
    workload = migrate.read_json(frontend, "frontend-workload-outcome.json")
    failed_frontend = migrate.read_json(frontend, "staging-outcome.json")
    demand(ready.get("status") == "API_RUNTIME_READY" and ready.get("phase") == "completed" and ready.get("releaseAccepted") is False
           and ready.get("trafficAuthorized") is False and ready.get("environment") == environment
           and ready.get("releaseId") == selected["releaseId"], "RECOVERY_RUNTIME_RECEIPT_REQUIRED")
    demand(failure.get("status") == "FAILED_REQUIRES_REVIEW" and failure.get("runtimeStopped") is True
           and failure.get("phase") == "frontend-coordination"
           and failure.get("failureCode") == "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"
           and all(failure.get(k) == ready.get(k) for k in ("releaseId", "environment", "candidateSha256", "migrationOutcomeSha256", "containers")),
           "RECOVERY_STOPPED_PROMOTION_FAILURE_REQUIRED")
    demand(failed_frontend.get("status") == "FAILED_REQUIRES_REVIEW"
           and failed_frontend.get("phase") == "frontend-verification-and-promotion"
           and failed_frontend.get("failureCode") == failure["failureCode"]
           and all(workload.get(k) == identity[k] == intent.get(k)
                   for k in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId"))
           and workload.get("status") == "FRONTEND_VERIFIED"
           and type(intent.get("previousAliasRequestedAt")) is int and intent["previousAliasRequestedAt"] >= 0,
           "RECOVERY_FRONTEND_RECEIPTS_REQUIRED")
    migration_raw = migrate.read_input(database_attempt, "migration-outcome.json")
    migration = json.loads(migration_raw)
    demand(migrate.file_hash(migration_raw) == ready["migrationOutcomeSha256"]
           and migration.get("status") == "DATABASES_VERIFIED"
           and migration.get("environment") == environment and migration.get("releaseId") == selected["releaseId"]
           and migration.get("candidateSha256") == ready["candidateSha256"]
           == migrate.file_hash(migrate.read_input(database_attempt, "candidate.json"))
           and migrate.read_json(database_attempt, "candidate.json") == selected
           and set(migration.get("databaseReceiptSha256", {})) == set(jobs) == {"frontend", "course", "community"},
           "RECOVERY_DATABASE_BINDING_REQUIRED")
    for name in jobs:
        raw = migrate.read_input(database_attempt / name, "database-receipt.json")
        receipt = json.loads(raw)
        demand(migrate.file_hash(raw) == migration["databaseReceiptSha256"][name]
               and receipt.get("status") == "DATABASE_VERIFIED"
               and receipt.get("environment") == environment and receipt.get("releaseId") == selected["releaseId"]
               and migrate.read_json(database_attempt / name, "job-outcome.json").get("status") == "DATABASE_VERIFIED",
               "RECOVERY_DATABASE_RECEIPT_REQUIRED")
    containers = ready.get("containers")
    demand(isinstance(containers, list) and len(containers) == len(runtime.SERVICES)
           and {c.get("service") for c in containers} == set(runtime.SERVICES)
           and len({c.get("containerId") for c in containers}) == len(containers)
           and all(isinstance(c.get("containerId"), str) and re.fullmatch(r"[a-f0-9]{64}", c["containerId"])
                   and c.get("image") == selected["artifacts"][runtime.IMAGE_KEYS[c["service"]]]["image"] for c in containers),
           "RECOVERY_PINNED_CONTAINER_RECEIPTS_REQUIRED")
    return selected, {**plan, "operation": "recover-promoted-staging-runtime", "frontend": identity,
                      "previousAliasRequestedAt": intent["previousAliasRequestedAt"], "containers": containers,
                      "migrationOutcomeSha256": ready["migrationOutcomeSha256"], "candidateSha256": ready["candidateSha256"],
                      "migrationsRepeated": False, "providerMutations": False, "containerReplacement": False,
                      "nativeSchedulesEnabled": False, "releaseAccepted": False}


def provider_check(client, selected, plan):
    identity = plan["frontend"]
    deployment = vercel.deployment_state(client, identity["deploymentId"], identity["projectId"], identity["sourceCommit"], identity["releaseId"])
    state = vercel.promotion_state(client, identity["projectId"])
    job = state["aliasJob"]
    demand(deployment["readyState"] == "READY" and state["cronsEnabled"] is False
           and state["productionDeploymentId"] == identity["deploymentId"] and job is not None
           and job["jobStatus"] == "succeeded" and job["type"] == "promote"
           and job["toDeploymentId"] == identity["deploymentId"]
           and job["requestedAt"] > plan["previousAliasRequestedAt"], "RECOVERY_COMPLETED_PROMOTION_REQUIRED")
    alias = client.request("GET", "/v4/aliases/staging.lashher.com")
    demand(alias.get("alias") == "staging.lashher.com" and alias.get("projectId") == identity["projectId"]
           and alias.get("deploymentId") == identity["deploymentId"], "RECOVERY_STAGING_ALIAS_REQUIRED")
    return state


def stopped_containers(plan):
    ids = runtime.command(["docker", "ps", "--all", "--no-trunc", "--quiet", "--filter", "label=com.docker.compose.project=lash-her-staging"], runtime.SAFE_ENV).split()
    demand(set(ids) == {c["containerId"] for c in plan["containers"]} and len(ids) == 8, "RECOVERY_EXACT_EXISTING_CONTAINERS_REQUIRED")
    for container in plan["containers"]:
        fields = '{{.Config.Image}}|{{.State.Status}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
        actual = runtime.command(["docker", "inspect", "--format", fields, container["containerId"]], runtime.SAFE_ENV).split("|")
        demand(actual == [container["image"], "exited", "lash-her-staging", container["service"]], "RECOVERY_EXISTING_CONTAINER_CHANGED")


def wait_stage(stage, by_service):
    deadline = time.monotonic() + 90
    while True:
        healthy = True
        for service in stage:
            fields = docker_inspect.RECOVERY_FIELDS
            value = runtime.command(["docker", "inspect", "--format", fields, by_service[service]], runtime.SAFE_ENV, 5)
            demand(value.startswith("true|"), "RECOVERY_CONTAINER_EXITED")
            healthy = healthy and value == ("true|none" if service.endswith("-tls") else "true|healthy")
        if healthy:
            return
        demand(time.monotonic() < deadline, "RECOVERY_READINESS_TIMEOUT")
        time.sleep(1)


def recheck_frontend(client, selected, plan, prior, output, probe_client=None):
    identity = plan["frontend"]
    # The original server proof is retained. Expiry cannot be extended in an
    # immutable deployment; an expired native probe needs later qualification.
    private_meta = migrate.read_json(prior / "configuration", frontend_probe.PRIVATE_FILE)
    if type(private_meta.get("expiresAt")) is int and private_meta["expiresAt"] <= int(time.time() * 1000):
        return {"status": "PRIOR_SERVER_PROOF_RETAINED_PROBE_EXPIRED", "frontendServerWorkloadReverified": False,
                "nativeSchedulerVerified": False}
    private = frontend_probe._private_input(prior / "configuration", identity)
    before = provider_check(client, selected, plan)
    bypass = frontend_probe._automation_bypass(vercel._project(client, identity["projectId"]))
    state = vercel.deployment_state(client, identity["deploymentId"], identity["projectId"], identity["sourceCommit"], identity["releaseId"])
    challenge = frontend_probe.secrets.token_hex(32)
    result = (probe_client or frontend_probe.ProbeClient()).request(state["url"], private["secret"], bypass, challenge)
    demand(type(result.get("version")) is int and result["version"] == 1
           and result.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and result.get("challenge") == challenge
           and result.get("gatewayOrigin") == private["gatewayOrigin"] and result.get("checks") == ["gateway-course-catalog"]
           and all(result.get(k) == identity[k] for k in ("environment", "projectId", "sourceCommit"))
           and int(time.time() * 1000) < private["expiresAt"]
           and provider_check(client, selected, plan) == before, "RECOVERY_FRONTEND_RECHECK_REQUIRED")
    receipt = {**identity, "status": "FRONTEND_VERIFIED", "frontendServerWorkloadReverified": True,
               "nativeSchedulerVerified": False}
    migrate.write_json(output, "frontend-workload-recheck.json", receipt)
    return receipt


def execute(prior, database_attempt, output, apply=False, confirmation=None, check=False,
            lock_path=Path("/run/lock/lash-her-release.lock"), client=None, probe_client=None):
    selected, plan = make_plan(prior, database_attempt)
    if not apply and not check:
        return plan
    demand(not (apply and check), "RECOVERY_MODE_REFUSED")
    demand(not apply or confirmation == "staging/" + selected["releaseId"] + "/recover", "EXPLICIT_OPERATOR_RECOVERY_CONFIRMATION_REQUIRED")
    runtime.assert_host(plan)
    client = client or ReadOnlyClient(os.environ.get("VERCEL_TOKEN"))
    outcome = {"status": "RECOVERY_REQUIRES_REVIEW", "releaseId": selected["releaseId"], "environment": "staging",
               "candidateSha256": plan["candidateSha256"], "migrationOutcomeSha256": plan["migrationOutcomeSha256"],
               "frontendDeploymentId": plan["frontend"]["deploymentId"], "trafficAuthorized": False,
               "gatewayTrafficAuthorized": False, "releaseAccepted": False, "migrationsRepeated": False,
               "providerMutations": False, "containerReplacement": False, "nativeSchedulesEnabled": False}
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = provider_check(client, selected, plan)
        stopped_containers(plan)
        if check:
            return {**outcome, "status": "RECOVERY_READ_ONLY_PREFLIGHT_PASS", "containers": len(plan["containers"]), "promotionState": state}
        migrate.private_directory(output.parent)
        demand(not any((p / ".git").exists() for p in (output.parent.resolve(), *output.parent.resolve().parents))
               and not output.resolve().is_relative_to(prior.resolve())
               and not output.resolve().is_relative_to(database_attempt.resolve()), "RECOVERY_SEPARATE_PRIVATE_OUTPUT_REQUIRED")
        output.mkdir(mode=0o700)
        migrate.write_json(output, "recovery-started.json", plan)
        try:
            by_service = {c["service"]: c["containerId"] for c in plan["containers"]}
            outcome["phase"] = "restart-existing-containers"
            for stage in runtime.STAGES:
                runtime.command(["docker", "start", *[by_service[s] for s in stage]], runtime.SAFE_ENV, 30)
                wait_stage(stage, by_service)
            snapshot = prior / "configuration"
            outcome["phase"] = "runtime-boundary-checks"
            probe = json.loads(runtime.command([*runtime.compose_command(snapshot, "staging"), "exec", "-T", "gateway", "node", "release-probe.mjs"], runtime.runtime_environment(selected, snapshot), 30))
            demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and isinstance(probe.get("checks"), list)
                   and len(probe["checks"]) == len(runtime.PROBE_CHECKS) and set(probe["checks"]) == runtime.PROBE_CHECKS,
                   "RECOVERY_BOUNDARY_CHECKS_REQUIRED")
            actual = runtime.check_containers(selected, snapshot)
            demand({c["containerId"] for c in actual} == set(by_service.values()), "RECOVERY_CONTAINER_IDENTITY_CHANGED")
            outcome["phase"] = "frontend-recheck"
            rechecked = recheck_frontend(client, selected, plan, prior, output, probe_client)
            demand(provider_check(client, selected, plan) == state, "RECOVERY_PROVIDER_CHANGED")
            outcome.update(status="RUNTIME_RECOVERED_FOR_QUALIFICATION", phase="completed", containers=actual,
                           boundaryChecks=probe["checks"], frontendRecheck=rechecked, frontendDomainsPromoted=True)
            return outcome
        except BaseException as error:
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "RECOVERY_EXECUTION_FAILED"
            try:
                migrate.suspend_runtime("staging", runtime.SAFE_ENV)
                outcome["runtimeStopped"] = True
            except BaseException:
                outcome["runtimeStopped"] = False
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "recovery-outcome.json", outcome)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prior", type=Path)
    parser.add_argument("database_attempt", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        print(json.dumps(execute(args.prior, args.database_attempt, args.output, args.apply, args.confirm, args.check)))
    except BaseException:
        print('{"status":"STAGING_RECOVERY_REFUSED","reviewRequired":true}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
