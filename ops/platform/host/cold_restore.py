"""Fresh-host restoration after provider-controlled recovery from SSH lockout.

This is access recovery, not the pending live rollback/recreation qualification.
The local operator owns AWS stop/snapshot/replacement and independent SSH trust.
No migration application, provider mutation, fixture write or traffic admission
is implemented here. All three current database checks execute read-only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import current_databases
import migrate
import native_qualification
import recreation_files
import recreation_prepare
import release as runtime
import ssh_access
import staging_restore
import staging_state
import staging_retire
import vercel

demand = migrate.demand
RELEASE = "p1-41541683416-1"
CANDIDATE = "b086558ed575cbdd0ceea8a3267e178e7ac390b77db9d2361cb721f750792900"
MIGRATION = "500707409055bc6787cc756eb26f663aeeb4be1405591692e7942f05473187a9"
ORIGINAL_MACHINE = "ec265c34b9fbf4d051aecfa185362c0a"
ORIGINAL_ARN = "arn:aws:lightsail:us-east-1:691588646557:Instance/2e608d2c-a88f-416f-a23f-209d20e042f4"
STACK = "arn:aws:cloudformation:us-east-1:691588646557:stack/lash-her-api-staging/43564e90-d6f4-11f1-825b-12ffd9c5e733"
DEPLOYMENT = "dpl_CdhFqwVANweysVe9cCTNpmHfduiy"


def make_plan(value):
    demand(isinstance(value, dict) and value.get("version") == 1 and value.get("environment") == "staging"
           and value.get("operation") == "cold-restore", "COLD_RESTORE_FIXED_STAGING_OPERATION_REQUIRED")
    action = value.get("action")
    demand(isinstance(action, str) and re.fullmatch(r"p1-recreate-access-[a-z0-9-]{1,20}", action),
           "COLD_RESTORE_EXACT_ACTION_REQUIRED")
    root = recreation_files.action_root(action)
    inputs = root / "inputs"
    selected, jobs, prior, compose = staging_state.retained_state(inputs / "bundle", inputs / "configuration",
        inputs / "database-receipts", inputs / "runtime-receipts", inputs / "compose.yaml", CANDIDATE)
    demand(selected["releaseId"] == RELEASE and prior["migrationOutcomeSha256"] == MIGRATION
           and prior["originalHostMachineId"] == ORIGINAL_MACHINE, "COLD_RESTORE_ORIGINAL_RELEASE_REQUIRED")
    machine = value.get("newMachineId")
    demand(isinstance(machine, str) and re.fullmatch(r"[a-f0-9]{32}", machine)
           and machine not in ("0" * 32, ORIGINAL_MACHINE), "COLD_RESTORE_NEW_MACHINE_REQUIRED")
    hashes = staging_state.configuration_hashes(inputs / "configuration")
    demand(value.get("configurationSha256") == hashes, "COLD_RESTORE_HELD_CONFIGURATION_HASH_REQUIRED")
    checker = Path(__file__).with_name("database_current.mjs")
    demand(value.get("checkerSha256") == migrate.file_hash(migrate.read_input(checker.parent, checker.name, 65_536)),
           "COLD_RESTORE_EXACT_READ_ONLY_CHECKER_REQUIRED")
    plan = {"operation": "staging-cold-access-recovery", "action": action, "environment": "staging", "releaseId": RELEASE,
        "originalHostMachineId": ORIGINAL_MACHINE, "newHostMachineId": machine, "candidateSha256": CANDIDATE,
        "migrationOutcomeSha256": MIGRATION, "configurationSha256": hashes, "frontendDeploymentId": DEPLOYMENT,
        "originalProviderStopRequired": True, "newProviderBrowserTrustRequired": True,
        "authenticatedBrowserRecoveryAccessRetained": True, "currentDatabaseChecksRequired": ["frontend", "course", "community"],
        "sshAccessPolicy": ssh_access.POLICY, "migrationsExecuted": False, "fixtureWritesIncluded": False,
        "providerMutationsIncluded": False, "frontendBuildIncluded": False, "originalGracefulExitsObserved": False,
        "liveRollbackQualified": False, "p1RecreationQualified": False, "trafficAuthorized": False, "releaseAccepted": False}
    return selected, jobs, prior, compose, root, plan


def provider_evidence(value):
    stop, ready, trust = value.get("originalStop"), value.get("newInfrastructure"), value.get("browserTrust")
    demand(isinstance(stop, dict) and stop.get("status") == "STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY"
           and stop.get("environment") == "staging" and stop.get("accountId") == "691588646557"
           and stop.get("region") == "us-east-1" and stop.get("stackId") == STACK and stop.get("instanceArn") == ORIGINAL_ARN
           and stop.get("hostMachineId") == ORIGINAL_MACHINE and stop.get("instanceState") == "stopped"
           and stop.get("forcedStop") is False and stop.get("perContainerGracefulExitObserved") is False,
           "COLD_RESTORE_PROVIDER_STOP_EVIDENCE_REQUIRED")
    demand(isinstance(ready, dict) and ready.get("status") == "STAGING_INFRASTRUCTURE_STATE_VERIFIED"
           and ready.get("accessRecoveryPhase") == "ready" and ready.get("stackId") == STACK
           and ready.get("instanceState") == "running" and ready.get("browserSshEnabled") is True
           and ready.get("allocationPreserved") is True and ready.get("address") == "184.196.129.231"
           and isinstance(ready.get("instanceArn"), str)
           and re.fullmatch(r"arn:aws:lightsail:us-east-1:691588646557:Instance/[a-f0-9-]{36}", ready["instanceArn"])
           and ready["instanceArn"] != ORIGINAL_ARN, "COLD_RESTORE_NEW_PROVIDER_IDENTITY_REQUIRED")
    demand(isinstance(trust, dict) and trust.get("method") == "authenticated-aws-browser"
           and trust.get("instanceArn") == ready["instanceArn"] and trust.get("address") == ready["address"]
           and trust.get("hostMachineId") == value.get("newMachineId")
           and trust.get("accountId") == "691588646557" and trust.get("browserAccountVerified") is True
           and trust.get("keyPinnedBeforePrivateTransfer") is True
           and isinstance(trust.get("fingerprint"), str) and re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", trust["fingerprint"]),
           "COLD_RESTORE_INDEPENDENT_BROWSER_TRUST_REQUIRED")
    snapshot = value.get("recoverySnapshot")
    demand(isinstance(snapshot, dict) and snapshot.get("status") == "STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE"
           and snapshot.get("fromInstanceArn") == ORIGINAL_ARN and snapshot.get("privateRootDiskIncluded") is True
           and snapshot.get("snapshotContentsFetched") is False and isinstance(snapshot.get("snapshotArn"), str)
           and re.fullmatch(r"arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/[a-f0-9-]{36}", snapshot["snapshotArn"]),
           "COLD_RESTORE_VERIFIED_SOURCE_SNAPSHOT_REQUIRED")
    return {"originalStop": stop, "newInfrastructure": ready, "browserTrust": trust, "recoverySnapshot": snapshot}


def execute(value, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock"), client=None):
    selected, jobs, prior, compose, root, plan = make_plan(value)
    if not apply:
        return plan
    demand(confirmation == "staging/" + RELEASE + "/cold-restore-" + plan["action"], "EXPLICIT_COLD_RESTORE_CONFIRMATION_REQUIRED")
    evidence = provider_evidence(value)
    credentials = value.get("databaseCredentials")
    demand(isinstance(credentials, dict) and set(credentials) == set(jobs)
           and all(isinstance(url, str) and 0 < len(url) <= 16384 for url in credentials.values()),
           "COLD_RESTORE_SCOPED_DATABASE_CREDENTIALS_REQUIRED")
    runtime.assert_host({"hostMachineId": plan["newHostMachineId"]})
    output, inputs = root / "cold-restore", root / "inputs"
    demand(not output.exists(), "COLD_RESTORE_EXCLUSIVE_OUTPUT_REQUIRED")
    if client is None:
        client = vercel.Client(value.get("vercelToken"))
    outcome = {**plan, "status": "COLD_RESTORE_REQUIRES_REVIEW", "phase": "fresh-host-preflight"}
    with lock_path.open("a+") as lock:
        native_qualification.acquire_release_lock(lock)
        staging_restore.check_fresh_host(plan)
        recreation_prepare.initialization(ssh_access_policy=ssh_access.POLICY)
        staging_restore.check_provider(client, selected, plan)
        output.mkdir(mode=0o700)
        migrate.write_json(output, "cold-restore-started.json", {**plan, "providerEvidence": evidence})
        try:
            inventory = output / "producer-inventory"
            inventory.mkdir(mode=0o700)
            migrate.write_json(inventory, "mux-inventory.json", value.get("muxInventory"))
            staging_retire.external_inventory(inventory, migrate.file_hash(migrate.read_input(inventory, "mux-inventory.json")), int(time.time() * 1000))
            outcome["phase"] = "bind-new-machine"
            rebound, snapshot = output / "configuration-input", output / "configuration"
            binding = staging_state.restored_configuration(inputs / "configuration", rebound, selected, jobs, compose,
                plan["configurationSha256"], ORIGINAL_MACHINE, plan["newHostMachineId"], "restore-" + plan["action"])
            migrate.write_json(output, "configuration-binding.json", binding)
            metadata = migrate.read_json(rebound, "runtime.json")
            demand(set(metadata) == {"version", "environment", "releaseId", "hostMachineId", "previousReleaseRef", "maintenanceRef"},
                   "COLD_RESTORE_BOUNDED_RUNTIME_METADATA_REQUIRED")
            (output / "runtime-binding.json").write_bytes(migrate.read_input(rebound, "runtime.json", 16384))
            (output / "runtime-binding.json").chmod(0o600)
            runtime.snapshot_configuration(rebound, snapshot, selected, jobs, compose)
            runtime.snapshot_bundle(inputs / "bundle", output / "migration-input", selected, jobs)
            outcome["phase"] = "cached-configuration-preflight"
            runtime.preflight(selected, snapshot, jobs, pull=False)
            outcome["phase"] = "actual-read-only-database-checks"
            checker = Path(__file__).with_name("database_current.mjs")
            current = current_databases.check_all(selected, jobs, output / "database-current", credentials,
                checker, value["checkerSha256"])
            demand(current.get("status") == "CURRENT_DATABASES_READ_ONLY_VERIFIED"
                   and set(current.get("databases", {})) == set(jobs), "COLD_RESTORE_THREE_CURRENT_DATABASES_REQUIRED")
            prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(selected, snapshot)
            for stage in runtime.STAGES:
                staging_restore.check_provider(client, selected, plan)
                outcome["phase"] = "start-" + "+".join(stage)
                runtime.command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate",
                                 "--wait", "--wait-timeout", "90", *stage], environment, 120)
            actual = runtime.check_containers(selected, snapshot)
            old_ids = {item["containerId"] for item in prior["originalContainers"]}
            demand(len(actual) == 8 and len({item["containerId"] for item in actual}) == 8
                   and not old_ids.intersection(item["containerId"] for item in actual), "COLD_RESTORE_NEW_CONTAINERS_REQUIRED")
            probe = json.loads(runtime.command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], environment, 30))
            demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS"
                   and len(probe.get("checks", [])) == 5 and set(probe["checks"]) == runtime.PROBE_CHECKS,
                   "COLD_RESTORE_ACTUAL_BOUNDARIES_REQUIRED")
            staging_restore.check_provider(client, selected, plan)
            ready = {"status": "API_RUNTIME_RESTORED_FOR_QUALIFICATION", "phase": "completed", "environment": "staging",
                "releaseId": RELEASE, "hostMachineId": plan["newHostMachineId"], "candidateSha256": CANDIDATE,
                "migrationOutcomeSha256": MIGRATION, "containers": actual, "boundaryChecks": probe["checks"],
                "trafficAuthorized": False, "releaseAccepted": False, "coldAccessRecovery": True,
                "migrationsExecuted": False, "originalGracefulExitsObserved": False}
            migrate.write_json(output, "runtime-outcome.json", ready)
            outcome.update(status="STAGING_COLD_RUNTIME_RESTORED_FOR_QUALIFICATION", phase="completed",
                runtimeReceiptSha256=hashlib.sha256(migrate.read_input(output, "runtime-outcome.json")).hexdigest(),
                currentDatabaseOutcomeSha256=migrate.file_hash(migrate.read_input(output / "database-current", "current-databases-outcome.json")),
                actualContainerCount=len(actual), boundaryChecks=probe["checks"], currentConfigurationDirectory=str(snapshot))
            return outcome
        except BaseException:
            try:
                migrate.suspend_runtime("staging", runtime.SAFE_ENV)
                outcome["runtimeStoppedAfterFailure"] = True
            except BaseException:
                outcome["runtimeStateRequiresInspection"] = True
            raise ValueError("COLD_RESTORE_FAILED_REQUIRES_REVIEW") from None
        finally:
            migrate.write_json(output, "cold-restore-outcome.json", outcome)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    raw = sys.stdin.buffer.read(200001)
    demand(len(raw) <= 200000, "COLD_RESTORE_BOUNDED_PRIVATE_INPUT_REQUIRED")
    result = execute(json.loads(raw), args.apply, args.confirm)
    print(json.dumps({"status": result.get("status", "COLD_RESTORE_PLAN"), "migrationsExecuted": False,
                      "trafficAuthorized": False, "releaseAccepted": False, "privateValuesDisplayed": False}))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print('{"status":"COLD_RESTORE_REFUSED_OR_REQUIRES_REVIEW","privateValuesDisplayed":false}', file=sys.stderr)
        raise SystemExit(1) from None
