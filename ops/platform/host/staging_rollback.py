"""Same-host compatible runtime rollback, then restore current, with no SQL apply.

The parent owns publication, private injection and later VM recreation. Original
candidate/migration/failure receipts remain immutable. Plan is read-only.
"""
import json
from pathlib import Path
import re

import current_databases
import migrate
import native_qualification
import release as runtime
import runtime_actions
import staging_restore
import staging_retire
import staging_state

demand = migrate.demand
RUNTIME_KEYS = ("gateway", "courseRuntime", "communityRuntime")
RECOVERY_STAGES = [runtime.STAGES[0], runtime.STAGES[1], ("course-publisher",), runtime.STAGES[2], runtime.STAGES[4]]
COMPATIBILITY_CHECKS = {"frontend-sdk-oidc-catalog-tls", *runtime.PROBE_CHECKS, "signed-project-and-public-route-boundaries",
    "authenticated-idempotent-enrollment", "private-peer-spoofing-and-direct-backend-denial", "signed-mux-only-exception",
    "publisher-projection-and-worker-loop", "actual-community-authority-client", "worker-restart-requested",
    "worker-recovered-after-restart", "maintenance-holds-application-writes"}


def compatibility(directory, previous_sha256, proof_sha256, selected):
    staging_state.outside_checkout(directory)
    previous_raw = migrate.read_input(directory, "compatible.candidate.json", 2_000_000)
    proof_raw = migrate.read_input(directory, "compatibility-proof.json", 2_000_000)
    demand(migrate.file_hash(previous_raw) == previous_sha256 and migrate.file_hash(proof_raw) == proof_sha256,
           "ROLLBACK_REVIEWED_COMPATIBILITY_HASHES_REQUIRED")
    previous, proof = json.loads(previous_raw), json.loads(proof_raw)
    images = {key: info["image"] for key, info in selected["artifacts"].items()}
    demand(proof.get("status") == "PUBLISHED_APPLICATION_ROLLBACK_AND_DURABLE_RECOVERY_PASS"
           and proof.get("cleanupPassed") is True and proof.get("actualStagingChanged") is False
           and proof.get("images") == images and proof.get("rollbackImages") == previous.get("images")
           and proof.get("currentRelease") == selected["releaseId"] and proof.get("rollbackRelease") == previous.get("releaseId")
           and proof.get("applicationVersionOverlapped") is False, "ROLLBACK_ACTUAL_OWNED_COMPATIBILITY_REQUIRED")
    rounds = proof.get("rounds", [])
    demand(len(rounds) == 3 and [r.get("phase") for r in rounds] == ["current", "compatible-rollback", "restore-current"]
           and all(len(r.get("records", [])) == 15 and {c.get("name") for c in r["records"]} == COMPATIBILITY_CHECKS
                   and all(c.get("passed") is True for c in r["records"])
                   and r.get("preservedPriorBusinessRows") is True and len(r.get("gracefulStop", {}).get("processes", [])) == 8
                   and all(c.get("running") is False and c.get("exitCode") == 0 and c.get("oomKilled") is False
                           for c in r["gracefulStop"]["processes"]) for r in rounds), "ROLLBACK_COMPLETE_OWNED_ROUNDS_REQUIRED")
    for index, round_value in enumerate(rounds):
        refs = previous["images"] if index == 1 else images
        actual = round_value.get("runningImages", [])
        demand(len(actual) == 8 and {c.get("service") for c in actual} == set(runtime.SERVICES)
               and len({c.get("containerId") for c in actual}) == 8
               and all(c.get("reference") == refs[runtime.IMAGE_KEYS[c["service"]]] for c in actual)
               and (index == 0 or round_value.get("recoveredPendingEvents") == 2), "ROLLBACK_ACTUAL_IMAGE_AND_RECOVERY_PROOF_REQUIRED")
    fixture = rounds[0].get("ordinaryAdminFixture", {})
    demand(fixture.get("status") == "STAGING_FIXTURE_TWO_GRANTS_CREATED" and fixture.get("coursePublished") is False
           and fixture.get("retainedWork", {}).get("status") == "STAGING_DURABLE_WORK_RETAINED"
           and fixture.get("recoveredWork", {}).get("status") == "STAGING_DURABLE_WORK_RECOVERED"
           and fixture.get("recoveredWork", {}).get("eventsRecovered") == 2, "ROLLBACK_ACTUAL_FIXTURE_COORDINATOR_PROOF_REQUIRED")
    for key in RUNTIME_KEYS:
        reference = previous["images"].get(key)
        demand(isinstance(reference, str) and re.fullmatch(re.escape(images[key].split("@")[0]) + r"@sha256:[a-f0-9]{64}", reference)
               and reference != images[key], "ROLLBACK_EXACT_PREVIOUS_RUNTIME_IMAGES_REQUIRED")
    # This is only an execution selection for existing Compose/check functions,
    # not a fabricated candidate or a reuse of the current images' attestations.
    execution = {"environment": "staging", "releaseId": selected["releaseId"], "artifacts": {
        key: {"image": previous["images"][key] if key in RUNTIME_KEYS else image} for key, image in images.items()}}
    return previous, execution


def make_plan(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256,
              compatibility_directory, previous_sha256, proof_sha256, expected_deployment, action):
    selected, jobs, plan, compose = staging_state.retained_state(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256)
    previous, execution = compatibility(compatibility_directory, previous_sha256, proof_sha256, selected)
    demand(isinstance(action, str) and re.fullmatch(r"rollback-[a-z0-9][a-z0-9-]{0,70}", action), "ROLLBACK_ACTION_REQUIRED")
    demand(isinstance(expected_deployment, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", expected_deployment), "ROLLBACK_CURRENT_DEPLOYMENT_REQUIRED")
    plan.update(operation="compatible-runtime-rollback-and-restore-current", action=action,
        frontendDeploymentId=expected_deployment, compatibilityProofSha256=proof_sha256, previousBuildSha256=previous_sha256,
        previousRuntimeReleaseId=previous["releaseId"], previousRuntimeImages={key: previous["images"][key] for key in RUNTIME_KEYS},
        databaseSchemaReleaseId=selected["releaseId"], existingHostOnly=True, vmRecreationIncluded=False,
        providerMutations=False, nativeSchedulesEnabled=False, finalAdmissionIncluded=False)
    return selected, jobs, plan, compose, execution


def api_containers(execution, snapshot):
    prefix, env = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(execution, snapshot)
    result = []
    for service in ("course-api", "community-api"):
        identity = runtime.command([*prefix, "ps", "--all", "--quiet", service], env)
        demand(re.fullmatch(r"[a-f0-9]{64}", identity), "ROLLBACK_EXACT_API_IDENTITY_REQUIRED")
        result.append({"service": service, "containerId": identity,
                       "image": execution["artifacts"][runtime.IMAGE_KEYS[service]]["image"]})
    return result


def start_round(selected, execution, jobs, configuration, compose, bundle, output, retained, baseline,
                private_fingerprint_key, programs_directory, programs, credentials, checker_sha256, check_provider):
    demand(not output.exists() and not runtime.command(["docker", "ps", "--quiet"], runtime.SAFE_ENV), "ROLLBACK_NONOVERLAPPING_FRESH_ROUND_REQUIRED")
    output.mkdir(mode=0o700)
    snapshot = output / "configuration"
    outcome = {"status": "STAGING_RUNTIME_ROUND_REQUIRES_REVIEW", "phase": "snapshot", "environment": "staging",
               "releaseId": selected["releaseId"], "trafficAuthorized": False, "releaseAccepted": False, "migrationsExecuted": False}
    try:
        runtime.snapshot_configuration(configuration, snapshot, selected, jobs, compose)
        runtime.snapshot_bundle(bundle, output / "migration-input", selected, jobs)
        outcome["phase"] = "cached-private-configuration-preflight"
        runtime.preflight(execution, snapshot, jobs, pull=False)
        outcome["phase"] = "actual-read-only-database-checks"
        checker = Path(__file__).with_name("database_current.mjs")
        current = current_databases.check_all(selected, jobs, output / "database-current", credentials, checker, checker_sha256)
        demand(current.get("status") == "CURRENT_DATABASES_READ_ONLY_VERIFIED" and set(current.get("databases", {})) == set(jobs),
               "ROLLBACK_THREE_CURRENT_DATABASES_REQUIRED")
        prefix, env = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(execution, snapshot)
        for stage in RECOVERY_STAGES:
            check_provider()
            outcome["phase"] = "start-" + "+".join(stage)
            runtime.command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "90", *stage], env, 120)
            if stage == ("course-publisher",):
                outcome["phase"] = "actual-publisher-recovery-before-reconciliation"
                checkpoint = output / "publisher-checkpoint"; checkpoint.mkdir(mode=0o700)
                apis = api_containers(execution, snapshot)
                operator = runtime_actions.RuntimeOperator(execution, jobs, snapshot, apis,
                    programs_directory, programs, checkpoint, api_only=True)
                operator.verify_recovery(retained)
                recovery_raw = migrate.read_input(checkpoint, "durable-recovery.json")
                recovery = json.loads(recovery_raw)
                demand(recovery.get("apiContainers") == apis and recovery.get("retained") == retained
                       and recovery.get("operatorProgramsSha256") == {key: info["sha256"] for key, info in programs.items()},
                       "ROLLBACK_ACTUAL_RECOVERY_RECEIPT_BINDING_REQUIRED")
                runtime_actions.recovered(retained, recovery["outbox"], recovery["inbox"])
                outcome["durableRecoveryReceiptSha256"] = migrate.file_hash(recovery_raw)
        actual = runtime.check_containers(execution, snapshot)
        probe = json.loads(runtime.command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], env, 30))
        demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and set(probe.get("checks", [])) == runtime.PROBE_CHECKS,
               "ROLLBACK_ACTUAL_RUNTIME_BOUNDARIES_REQUIRED")
        inspection = output / "business-inspection"; inspection.mkdir(mode=0o700)
        operator = runtime_actions.RuntimeOperator(execution, jobs, snapshot, actual, programs_directory, programs, inspection)
        after = operator.fingerprint(private_fingerprint_key)
        preserved = {name: runtime_actions.business_preserved(baseline[name], after[name]) for name in ("course", "community")}
        migrate.write_json(output, "business-preservation.json", {"before": baseline, "after": after, "verified": preserved})
        check_provider()
        outcome.update(status="STAGING_RUNTIME_ROUND_VERIFIED", phase="completed", containers=actual,
                       boundaryChecks=probe["checks"], priorBusinessRowsPreserved=preserved,
                       databaseCurrentOutcomeSha256=migrate.file_hash(migrate.read_input(output / "database-current", "current-databases-outcome.json")))
        return outcome, snapshot, operator
    except BaseException as error:
        outcome["failureCode"] = runtime_actions.safe_code(error)
        try:
            migrate.suspend_runtime("staging", runtime.SAFE_ENV); outcome["runtimeStopped"] = True
        except BaseException:
            outcome["runtimeStateRequiresInspection"] = True
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "round-outcome.json", outcome)


def execute(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256,
            compatibility_directory, previous_sha256, proof_sha256, expected_deployment, action, output,
            inventory_directory, inventory_sha256, configuration_sha256, programs_directory, programs, checker_sha256,
            apply=False, confirmation=None, credentials=None, client=None, private_fingerprint_key=None,
            lock_path=Path("/run/lock/lash-her-release.lock")):
    selected, jobs, plan, compose, previous_execution = make_plan(bundle, configuration, database_receipts, runtime_receipts,
        compose_file, candidate_sha256, compatibility_directory, previous_sha256, proof_sha256, expected_deployment, action)
    if not apply:
        return plan
    demand(confirmation == "staging/" + selected["releaseId"] + "/" + action, "EXPLICIT_STAGING_ROLLBACK_CONFIRMATION_REQUIRED")
    demand(client is not None and isinstance(credentials, dict) and set(credentials) == set(jobs)
           and isinstance(private_fingerprint_key, str) and re.fullmatch(r"[a-f0-9]{64}", private_fingerprint_key), "ROLLBACK_PRIVATE_PARENT_INPUTS_REQUIRED")
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and not any(output.resolve().is_relative_to(p.resolve()) for p in
           (bundle, configuration, database_receipts, runtime_receipts, compatibility_directory, inventory_directory)), "ROLLBACK_SEPARATE_EXCLUSIVE_OUTPUT_REQUIRED")
    runtime.assert_host({"hostMachineId": plan["originalHostMachineId"]})
    checker = Path(__file__).with_name("database_current.mjs")
    demand(migrate.file_hash(migrate.read_input(checker.parent, checker.name, 65_536)) == checker_sha256, "ROLLBACK_REVIEWED_CHECKER_REQUIRED")
    # A runtime snapshot deliberately gives TLS/config ownership to containers.
    # Refuse it before fixtures or publisher stops, rather than after retirement.
    runtime.validate_snapshot_source(configuration, selected, jobs)
    output.mkdir(mode=0o700)
    migrate.write_json(output, "rollback-started.json", plan)
    outcome = {**plan, "status": "STAGING_COMPATIBLE_ROLLBACK_REQUIRES_REVIEW", "phase": "retire-current"}
    try:
        with lock_path.open("a+") as lock:
            native_qualification.acquire_release_lock(lock)
            def provider():
                return staging_restore.check_provider(client, selected, plan)
            first = {}
            def prepare_first(_selected, _plan, config, _retirement):
                work = output / "current-pending-work"; work.mkdir(mode=0o700)
                operator = runtime_actions.RuntimeOperator(selected, jobs, config, plan["originalContainers"], programs_directory, programs, work)
                first["retained"] = operator.prepare_retained("recovery-fixture-rollback-previous-" + action.removeprefix("rollback-"))
                first["baseline"] = operator.fingerprint(private_fingerprint_key)
                migrate.write_json(work, "business-baseline.json", first["baseline"])
            retired = staging_retire.execute(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256,
                inventory_directory, inventory_sha256, configuration_sha256, expected_deployment, "retire-" + action,
                output / "initial-retirement", apply=True, confirmation="staging/" + selected["releaseId"] + "/retire-" + action,
                client=client, lock_path=lock_path, before_stop=prepare_first, lock_handle=lock)
            demand(retired.get("status") == "STAGING_RUNTIME_QUIESCED_FOR_RECREATION", "ROLLBACK_ACTUAL_INITIAL_RETIREMENT_REQUIRED")
            outcome["phase"] = "start-compatible-previous"
            previous, _previous_configuration, previous_operator = start_round(selected, previous_execution, jobs, configuration, compose, bundle,
                output / "compatible-previous", first["retained"], first["baseline"], private_fingerprint_key,
                programs_directory, programs, credentials, checker_sha256, provider)
            migrate.write_json(output / "compatible-previous", "compatible-runtime-outcome.json", {**previous,
                "status": "COMPATIBLE_PREVIOUS_RUNTIME_QUALIFIED", "previousRuntimeReleaseId": plan["previousRuntimeReleaseId"],
                "previousBuildSha256": previous_sha256, "databaseSchemaReleaseId": selected["releaseId"]})
            outcome["phase"] = "prepare-restore-current-work"
            second = previous_operator.prepare_retained("recovery-fixture-rollback-current-" + action.removeprefix("rollback-"))
            baseline = previous_operator.fingerprint(private_fingerprint_key)
            migrate.write_json(output / "compatible-previous", "next-business-baseline.json", baseline)
            provider()
            stopped = previous_operator.stop([service for stage in reversed(runtime.STAGES) for service in stage])
            demand(len(stopped) == 8 and not runtime.command(["docker", "ps", "--quiet"], runtime.SAFE_ENV), "ROLLBACK_ZERO_OVERLAPPING_PROCESSES_REQUIRED")
            migrate.write_json(output / "compatible-previous", "graceful-stop.json", {"processes": stopped})
            outcome["phase"] = "restore-current-runtime"
            # Runtime TLS copies belong to the non-root containers. Reuse the
            # unchanged root-owned input for the next round; do not weaken the
            # configuration-owner check or modify a retained runtime snapshot.
            current, snapshot, _operator = start_round(selected, selected, jobs, configuration, compose, bundle,
                output / "restored-current", second, baseline, private_fingerprint_key,
                programs_directory, programs, credentials, checker_sha256, provider)
            ready = {**current, "status": "API_RUNTIME_RESTORED_FOR_QUALIFICATION", "hostMachineId": plan["originalHostMachineId"],
                "candidateSha256": candidate_sha256, "migrationOutcomeSha256": plan["migrationOutcomeSha256"],
                "compatibleRollbackVerified": True, "runtimeOnly": True}
            migrate.write_json(output / "restored-current", "runtime-outcome.json", ready)
            outcome.update(status="STAGING_COMPATIBLE_ROLLBACK_AND_CURRENT_RESTORE_VERIFIED", phase="completed",
                currentRuntimeReceiptSha256=migrate.file_hash(migrate.read_input(output / "restored-current", "runtime-outcome.json")),
                currentConfigurationDirectory=str(snapshot), currentRuntimeDirectory=str(output / "restored-current"),
                containers=ready["containers"], compatibleRollbackVerified=True)
            return outcome
    except BaseException as error:
        outcome["failureCode"] = runtime_actions.safe_code(error)
        try:
            migrate.suspend_runtime("staging", runtime.SAFE_ENV); outcome["runtimeStopped"] = True
        except BaseException:
            outcome["runtimeStateRequiresInspection"] = True
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "rollback-outcome.json", outcome)
