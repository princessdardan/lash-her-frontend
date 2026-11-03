"""Fresh-machine API restoration component; never applies or repairs SQL.

The reviewed local recreation coordinator owns CloudFormation, authenticated SSH,
producer suspension and credential delivery. This component cannot retire a VM
or admit gateway writes, and does not accept a claimed database-success file.
"""
import copy
from contextlib import nullcontext
import json
import os
from pathlib import Path
import re

import bootstrap
import current_databases
import migrate
import native_qualification
import release as runtime
import staging_state

demand = migrate.demand


def make_plan(bundle, configuration, database_receipts, runtime_receipts, compose_file,
              candidate_sha256, retirement_directory, retirement_sha256, new_machine, action, expected_deployment):
    selected, jobs, plan, compose = staging_state.retained_state(bundle, configuration, database_receipts, runtime_receipts,
                                                               compose_file, candidate_sha256)
    staging_state.outside_checkout(retirement_directory)
    raw = migrate.read_input(retirement_directory, "retirement-outcome.json")
    demand(migrate.file_hash(raw) == retirement_sha256, "RESTORE_REVIEWED_RETIREMENT_HASH_REQUIRED")
    retired = json.loads(raw)
    demand(isinstance(new_machine, str) and re.fullmatch(r"[a-f0-9]{32}", new_machine) and new_machine != "0" * 32
           and new_machine != plan["originalHostMachineId"], "RESTORE_DIFFERENT_EXACT_MACHINE_REQUIRED")
    demand(isinstance(action, str) and re.fullmatch(r"restore-[a-z0-9][a-z0-9-]{0,80}", action), "RESTORE_ACTION_ID_REQUIRED")
    demand(isinstance(expected_deployment, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", expected_deployment),
           "RESTORE_CURRENT_DEPLOYMENT_REQUIRED")
    demand(retired.get("status") == "STAGING_RUNTIME_QUIESCED_FOR_RECREATION"
           and retired.get("environment") == "staging" and retired.get("releaseId") == selected["releaseId"]
           and retired.get("originalHostMachineId") == plan["originalHostMachineId"]
           and retired.get("candidateSha256") == candidate_sha256
           and retired.get("migrationOutcomeSha256") == plan["migrationOutcomeSha256"]
           and retired.get("runtimeReceiptSha256") == plan["runtimeReceiptSha256"]
           and retired.get("frontendDeploymentId") == expected_deployment
           and all(retired.get(key) is True for key in ("nativeSchedulesDisabled", "externalProducersSuspended", "publicIngressStopped", "hostTimersStopped"))
           and retired.get("trafficAuthorized") is False, "RESTORE_COMPLETE_QUIESCENCE_REQUIRED")
    expected_containers = {c["containerId"]: c for c in plan["originalContainers"]}
    stopped = retired.get("stoppedContainers")
    demand(isinstance(stopped, list) and len(stopped) == 8 and {c.get("containerId") for c in stopped} == set(expected_containers)
           and all(c.get("running") is False and c.get("exitCode") == 0 and c.get("oomKilled") is False
                   and c.get("service") == expected_containers[c["containerId"]]["service"] for c in stopped),
           "RESTORE_ALL_ORIGINAL_PROCESSES_STOPPED_REQUIRED")
    hashes = retired.get("configurationSha256")
    demand(isinstance(hashes, dict) and set(hashes) == set(staging_state.CONFIGURATION_FILES)
           and all(isinstance(h, str) and re.fullmatch(r"[a-f0-9]{64}", h) for h in hashes.values()),
           "RESTORE_VERIFIED_CONFIGURATION_COPY_REQUIRED")
    plan.update(action=action, newHostMachineId=new_machine, retirementOutcomeSha256=retirement_sha256,
                frontendDeploymentId=expected_deployment, configurationSha256=hashes,
                infrastructureOperationIncluded=False, runtimeOnly=True, durableRecoveryVerified=False,
                nativeSchedulerVerified=False, finalAdmissionIncluded=False)
    return selected, jobs, plan, compose


def host_file(path):
    target = Path(path)
    return migrate.read_input(target.parent, target.name, 65_536)


def check_fresh_host(plan, lock_file=Path(__file__).with_name("packages.lock.json")):
    runtime.assert_host({"hostMachineId": plan["newHostMachineId"]})
    demand(not runtime.command(["docker", "ps", "--all", "--quiet"], runtime.SAFE_ENV), "RESTORE_FRESH_EMPTY_ENGINE_REQUIRED")
    lock, lock_hash = bootstrap.load_lock(lock_file)
    receipt_path = Path(bootstrap.RECEIPT)
    receipt = migrate.read_json(receipt_path.parent, receipt_path.name)
    expected = bootstrap.make_plan(lock, lock_hash, receipt.get("publicInterface", ""))
    demand(receipt.get("lockSha256") == lock_hash and receipt.get("forwardingSha256") == expected["forwardingSha256"]
           and receipt.get("packages") == {p["name"]: p["version"] for p in lock["packages"]}
           and receipt.get("applicationDeployed") is False, "RESTORE_PINNED_FRESH_BOOTSTRAP_REQUIRED")
    # Ubuntu's /etc/os-release is a symlink. Read the canonical packaged file
    # through the same bounded, non-symlink input reader as the other checks.
    os_release = dict(line.split("=", 1) for line in host_file("/usr/lib/os-release").decode().splitlines() if "=" in line)
    demand(os_release.get("ID", "").strip('"') == "ubuntu" and os_release.get("VERSION_ID", "").strip('"') == "24.04",
           "RESTORE_UBUNTU_24_REQUIRED")
    installed = {p["name"]: runtime.command(["dpkg-query", "-W", "-f=${Version}", p["name"]], runtime.SAFE_ENV) for p in lock["packages"]}
    demand(installed == receipt["packages"], "RESTORE_INSTALLED_PACKAGE_VERSION_MISMATCH")
    bootstrap.validate_routes(json.loads(runtime.command(["ip", "-json", "route", "show", "default"], runtime.SAFE_ENV)),
                              json.loads(runtime.command(["ip", "-6", "-json", "route", "show", "default"], runtime.SAFE_ENV)),
                              receipt["publicInterface"])
    demand(host_file(bootstrap.EXECUTABLE) == expected["forwardingScript"].encode()
           and host_file(bootstrap.DROPIN) == expected["systemdDropIn"].encode(), "RESTORE_INSTALLED_FORWARDING_MISMATCH")
    daemon = json.loads(host_file("/etc/docker/daemon.json"))
    demand(daemon == bootstrap.DAEMON, "RESTORE_DOCKER_DAEMON_MISMATCH")
    for family, binary in (("ipv4", "iptables"), ("ipv6", "ip6tables")):
        policy = runtime.command([binary, "--wait", "10", "-S", "LASH-HER-INGRESS"], runtime.SAFE_ENV)
        demand(policy == receipt.get("rules", {}).get(family), "RESTORE_ACTIVE_INGRESS_RULE_MISMATCH")
        chain = "DOCKER-USER" if family == "ipv4" else "FORWARD"
        jumps = [line for line in runtime.command([binary, "--wait", "10", "-S", chain], runtime.SAFE_ENV).splitlines() if line.startswith("-A ")]
        demand(jumps and jumps[0] == f"-A {chain} -j LASH-HER-INGRESS", "RESTORE_FIRST_INGRESS_HOOK_REQUIRED")
    return {"status": "RESTORE_FRESH_BOOTSTRAP_VERIFIED", "lockSha256": lock_hash,
            "newHostMachineId": plan["newHostMachineId"], "publicInterface": receipt["publicInterface"]}


def check_provider(client, selected, plan):
    state = native_qualification.schedule_state(client, selected, plan["frontendDeploymentId"], False)
    alias = client.request("GET", "/v4/aliases/staging.lashher.com")
    demand(alias.get("projectId") == state["projectId"] and alias.get("alias") == "staging.lashher.com"
           and alias.get("deploymentId") == state["deploymentId"], "RESTORE_CURRENT_STAGING_ALIAS_REQUIRED")
    return state


def execute(bundle, configuration, database_receipts, runtime_receipts, compose_file, candidate_sha256,
            retirement_directory, retirement_sha256, new_machine, action, expected_deployment, output,
            checker_sha256, apply=False, confirmation=None, credentials=None, client=None,
            lock_path=Path("/run/lock/lash-her-release.lock"), after_runtime_ready=None, after_publisher_ready=None, lock_handle=None):
    selected, jobs, plan, compose = make_plan(bundle, configuration, database_receipts, runtime_receipts, compose_file,
        candidate_sha256, retirement_directory, retirement_sha256, new_machine, action, expected_deployment)
    if not apply:
        return plan
    demand(confirmation == "staging/" + selected["releaseId"] + "/" + action, "EXPLICIT_STAGING_RESTORE_CONFIRMATION_REQUIRED")
    demand(after_runtime_ready is None or callable(after_runtime_ready), "RESTORE_TRUSTED_CONTINUATION_REQUIRED")
    demand(after_publisher_ready is None or callable(after_publisher_ready), "RESTORE_TRUSTED_PUBLISHER_CHECKPOINT_REQUIRED")
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and not any(output.resolve().is_relative_to(p.resolve()) for p in
           (bundle, configuration, database_receipts, runtime_receipts, retirement_directory)), "RESTORE_SEPARATE_EXCLUSIVE_OUTPUT_REQUIRED")
    demand(client is not None, "RESTORE_AUTHENTICATED_READ_ONLY_CLIENT_REQUIRED")
    checker = Path(__file__).with_name("database_current.mjs")
    demand(migrate.file_hash(migrate.read_input(checker.parent, checker.name, 65_536)) == checker_sha256,
           "RESTORE_CHECKER_SOURCE_HASH_REQUIRED")
    # The parent injects only these one-shot credentials. They are never put in
    # runtime files or passed to the runtime Compose environment.
    demand(isinstance(credentials, dict) and set(credentials) == set(jobs), "RESTORE_PRIVATE_CURRENT_CHECK_CREDENTIALS_REQUIRED")
    outcome = {**plan, "status": "STAGING_RESTORE_REQUIRES_REVIEW", "phase": "fresh-host-preflight"}
    with (lock_path.open("a+") if lock_handle is None else nullcontext(lock_handle)) as lock:
        if lock_handle is not None:
            actual, expected = os.fstat(lock.fileno()), lock_path.stat()
            demand((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), "RESTORE_EXACT_PARENT_LOCK_HANDLE_REQUIRED")
        native_qualification.acquire_release_lock(lock)
        bootstrap_result = check_fresh_host(plan)
        check_provider(client, selected, plan)
        output.mkdir(mode=0o700)
        migrate.write_json(output, "restore-started.json", plan)
        runtime_ready = False
        try:
            outcome["phase"] = "bind-new-machine-configuration"
            input_config, snapshot = output / "configuration-input", output / "configuration"
            binding = staging_state.restored_configuration(configuration, input_config, selected, jobs, compose,
                plan["configurationSha256"], plan["originalHostMachineId"], new_machine, action)
            migrate.write_json(output, "configuration-binding.json", binding)
            runtime.snapshot_configuration(input_config, snapshot, selected, jobs, compose)
            runtime.snapshot_bundle(bundle, output / "migration-input", selected, jobs)
            rebound, _, rebound_plan, _ = runtime.make_plan(output / "migration-input", snapshot, snapshot / "compose.yaml")
            demand(rebound == selected and rebound_plan["hostMachineId"] == new_machine, "RESTORE_NEW_CONFIGURATION_BINDING_MISMATCH")
            outcome["phase"] = "cached-image-private-configuration-checks"
            runtime.preflight(selected, snapshot, jobs, pull=False)
            outcome["phase"] = "actual-read-only-database-checks"
            current = current_databases.check_all(selected, jobs, output / "database-current", credentials, checker, checker_sha256)
            demand(current.get("status") == "CURRENT_DATABASES_READ_ONLY_VERIFIED" and set(current.get("databases", {})) == set(jobs),
                   "RESTORE_CURRENT_DATABASES_REQUIRED")
            prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(selected, snapshot)
            # The controlled recovery exercise must observe real publication
            # before reconciliation can independently repair the projection.
            # Ordinary API readiness keeps the existing startup order.
            stages = runtime.STAGES if after_publisher_ready is None else [runtime.STAGES[0], runtime.STAGES[1],
                ("course-publisher",), runtime.STAGES[2], runtime.STAGES[4]]
            for stage in stages:
                check_provider(client, selected, plan)
                outcome["phase"] = "start-" + "+".join(stage)
                runtime.command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "90", *stage], environment, 120)
                if stage == ("course-publisher",) and after_publisher_ready is not None:
                    outcome["phase"] = "publisher-durable-recovery-checkpoint"
                    # The parent owns separate receipts of actual DB reads;
                    # a callback's return value cannot assert recovery here.
                    after_publisher_ready(copy.deepcopy(selected), copy.deepcopy(plan), snapshot, output)
            probe = json.loads(runtime.command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], environment, 30))
            demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and set(probe.get("checks", [])) == runtime.PROBE_CHECKS,
                   "RESTORE_RUNTIME_BOUNDARIES_REQUIRED")
            actual = runtime.check_containers(selected, snapshot)
            demand(not ({c["containerId"] for c in actual} & {c["containerId"] for c in plan["originalContainers"]}),
                   "RESTORE_NEW_CONTAINER_IDENTITIES_REQUIRED")
            check_provider(client, selected, plan)
            outcome.update(status="API_RUNTIME_RESTORED_FOR_QUALIFICATION", phase="completed", containers=actual,
                           boundaryChecks=probe["checks"], hostMachineId=new_machine, bootstrap=bootstrap_result,
                           databaseCurrentOutcomeSha256=migrate.file_hash(migrate.read_input(output / "database-current", "current-databases-outcome.json")))
            migrate.write_json(output, "runtime-outcome.json", outcome)
            runtime_ready = True
            if after_runtime_ready is not None:
                # The trusted parent may use the existing locked frontend/native
                # components, and owns its separate qualification outcome.
                ready_receipt = copy.deepcopy(outcome)
                outcome["phase"] = "post-restore-qualification"
                after_runtime_ready(copy.deepcopy(selected), copy.deepcopy(plan), snapshot, output, ready_receipt)
                outcome["phase"] = "completed"
            return outcome
        except BaseException as error:
            code = str(error)
            outcome.update(status="STAGING_RESTORE_REQUIRES_REVIEW",
                           failureCode=code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", code) else "STAGING_RESTORE_EXECUTION_FAILED")
            # Before readiness, stop partial startup. A later qualification
            # failure preserves a healthy maintenance runtime and its immutable
            # ready receipt, as with the independent native qualifier.
            try:
                if runtime_ready:
                    runtime.check_containers(selected, snapshot)
                    outcome["runtimeRetainedInMaintenance"] = True
                else:
                    migrate.suspend_runtime("staging", runtime.SAFE_ENV)
                    outcome["runtimeStopped"] = True
            except BaseException:
                outcome["runtimeStateRequiresInspection"] = True
                # A failed qualification may also reveal an unhealthy runtime.
                # Stop it rather than treating the earlier ready receipt as
                # evidence that the processes are still safe to retain.
                if runtime_ready:
                    try:
                        migrate.suspend_runtime("staging", runtime.SAFE_ENV)
                        outcome["runtimeStopped"] = True
                    except BaseException:
                        pass
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "restore-outcome.json", outcome)
