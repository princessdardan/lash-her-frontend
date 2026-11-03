#!/usr/bin/env python3
"""Final P1 staging acceptance. Offline plan by default; never runs SQL/builds."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time

import migrate
import native_qualification
import release as runtime
import staging_retire
import staging_state
import vercel

# This finite inventory refines C01-C06, not later customer/commerce gates.
# Each check references original evidence bytes with an explicit applicability
# binding. The operator reviews its meaning; a hash alone cannot prove behavior.
CHECKS = {
    "P1-C01": {
        "oidc-claims-signature-time-jwks": "exact-image",
        "routes-hosts-headers-application-auth": "exact-image",
        "private-tls-ca-peers-proxy-spoofing": "exact-image",
        "independent-quotas-429-retry-after": "exact-image",
        "recreated-host-frontend-workload": "live-deployment",
        "external-ipv4-ipv6-published-unpublished-ports": "live-deployment",
    },
    "P1-C02": {"three-app-gateway-worker-harness-env01e": "exact-image"},
    "P1-C03": {"artifacts-migrations-roles-lineage-runtime": "live-deployment"},
    "P1-C04": {"durable-lease-retry-publication-before-repair-business-audit-preserved": "live-deployment"},
    "P1-C05": {"compatible-live-nonoverlap-rollback-and-return-business-preserved": "live-deployment"},
    "P1-C06": {
        "native-provenance-disable-drain-cancellation": "provider-record",
        "changed-host-producers-and-transport": "live-deployment",
        "certificate-watchdog-current-noop-units": "live-deployment",
        "six-feature-controls-off": "live-deployment",
    },
}
FEATURES = ("customerAccess", "courseReads", "checkout", "entitlementRecovery", "communityReads", "communityWrites")
WORKERS = ("course-publisher", "course-snapshot", "community-worker")
DRAIN_SECONDS = 13  # gateway request hard deadline: 12 seconds, plus observation margin
DEMAND = migrate.demand


def require(condition, code):
    DEMAND(condition, "ADMISSION_" + code)


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64


def make_plan(bundle, configuration, compose_file, evidence):
    """Local file reads only. No credentials, Docker, provider or DB calls."""
    selected, jobs, runtime_plan, _compose = runtime.make_plan(bundle, configuration, compose_file)
    require(selected["environment"] == "staging" and set(jobs) == {"frontend", "course", "community"}, "THREE_APP_STAGING_REQUIRED")
    require(jobs["frontend"]["job"]["target"]["approvedPendingTags"] == [], "PENDING_FRONTEND_SQL_REQUIRES_P2_COORDINATOR")
    value = migrate.read_json(evidence, "acceptance.json")
    environment, project, commit = vercel.release_identity(selected)
    candidate_hash = migrate.file_hash(migrate.read_input(bundle, "release.candidate.json"))
    gateway = migrate.read_json(configuration, "gateway.json")
    require(gateway.get("admission") == {"file": "/admission/state.json", "releaseId": selected["releaseId"],
            "candidateSha256": candidate_hash}, "DYNAMIC_GATEWAY_SOURCE_AND_BINDING_REQUIRED")
    expected_hashes = value.get("binding", {}).get("configurationSha256")
    require(isinstance(expected_hashes, dict) and set(expected_hashes) == set(staging_state.CONFIGURATION_FILES)
            and all(digest(h) for h in expected_hashes.values()), "REVIEWED_CONFIGURATION_HASHES_REQUIRED")
    # Private env/key bytes are inspected only by apply's private host driver.
    for name in ("runtime.json", *runtime.CONFIG_FILES):
        require(migrate.file_hash(migrate.read_input(configuration, name)) == expected_hashes[name], "PUBLIC_CONFIGURATION_CHANGED")
    binding = {"environment": environment, "releaseId": selected["releaseId"], "candidateSha256": candidate_hash,
               "hostMachineId": runtime_plan["hostMachineId"], "frontendProjectId": project,
               "frontendSourceCommit": commit, "frontendDeploymentId": value.get("binding", {}).get("frontendDeploymentId"),
               "configurationSha256": expected_hashes, "images": runtime_plan["images"]}
    require(isinstance(binding["frontendDeploymentId"], str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", binding["frontendDeploymentId"]),
            "EXACT_FRONTEND_DEPLOYMENT_REQUIRED")
    require(type(value.get("version")) is int and value["version"] == 1 and value.get("binding") == binding, "EVIDENCE_BINDING_MISMATCH")
    require(isinstance(value.get("actionId"), str) and re.fullmatch(r"p1-admit-[a-z0-9][a-z0-9-]{0,50}", value["actionId"]), "ACTION_ID_REQUIRED")
    # Native definitions are presently an expiring qualification probe, not an
    # eligible persistent business schedule. Its existing evidence is reused;
    # enabling ordinary schedules needs the feature stages and another profile.
    expected_producers = {"runningWorkers": list(WORKERS), "nativeSchedulesEnabled": False,
                          "maintenanceTimers": list(staging_retire.TIMERS)}
    require(value.get("producers") == expected_producers, "ONLY_QUALIFIED_P1_PRODUCERS_ALLOWED")
    require(value.get("features") == dict.fromkeys(FEATURES, False)
            and all(v is False for v in value["features"].values()), "UNFINISHED_FEATURES_MUST_STAY_OFF")
    require(value.get("admission") == {"newWork": False, "recovery": True}
            and value["admission"]["newWork"] is False and value["admission"]["recovery"] is True, "P1_RECOVERY_ONLY_PROFILE_REQUIRED")
    require(isinstance(value.get("maintenanceInvocationId"), str) and re.fullmatch(r"[a-f0-9]{32}", value["maintenanceInvocationId"]),
            "ACTUAL_CERTIFICATE_INVOCATION_REQUIRED")
    criteria = value.get("criteria")
    require(isinstance(criteria, dict) and set(criteria) == set(CHECKS), "COMPLETE_CRITERIA_REQUIRED")
    references = []
    for criterion, checks in CHECKS.items():
        records = criteria[criterion]
        require(isinstance(records, dict) and set(records) == set(checks), "COMPLETE_CHECK_MATRIX_REQUIRED")
        for name, evidence_class in checks.items():
            record = records[name]
            applicability = copy.deepcopy(binding)
            if evidence_class == "exact-image":
                applicability = {key: binding[key] for key in ("candidateSha256", "images")}
            require(isinstance(record, dict) and record.get("outcome") == "passed" and record.get("evidenceClass") == evidence_class
                    and record.get("applicability") == applicability, "CHECK_EVIDENCE_OR_APPLICABILITY_MISMATCH")
            receipts = record.get("receipts")
            require(isinstance(receipts, list) and 1 <= len(receipts) <= 20, "ORIGINAL_RECEIPTS_REQUIRED")
            for receipt in receipts:
                require(isinstance(receipt, dict) and set(receipt) == {"path", "sha256"} and digest(receipt["sha256"])
                        and isinstance(receipt["path"], str) and receipt["path"] != "acceptance.json", "RECEIPT_REFERENCE_REQUIRED")
                raw = migrate.read_input(evidence, receipt["path"])
                require(migrate.file_hash(raw) == receipt["sha256"], "ORIGINAL_RECEIPT_HASH_MISMATCH")
                references.append({"criterion": criterion, "check": name, **receipt})
    return selected, {"operation": "final-p1-staging-admission", "actionId": value["actionId"], "binding": binding,
                      "operatorSourceSha256": {name: migrate.file_hash(migrate.read_input(Path(__file__).parent, name))
                          for name in ("staging_admission.py", "release.py", "migrate.py", "staging_state.py", "staging_retire.py",
                                       "staging_restore.py", "native_qualification.py", "vercel.py", "certificates.py", "recreation_maintenance.py")},
                      "criteria": references, "acceptanceInputSha256": migrate.file_hash(migrate.read_input(evidence, "acceptance.json")),
                      "producers": expected_producers, "features": value["features"], "admission": value["admission"],
                      "maintenanceInvocationId": value["maintenanceInvocationId"], "drainSeconds": DRAIN_SECONDS,
                      "migrationsExecuted": False, "releaseAccepted": False}


def persist_state(configuration, binding, action, new_work=False, recovery=False):
    """Atomic, durable directory-bind update; no application/container restart."""
    directory = configuration / "admission"
    require(directory.is_dir() and not any(p.is_symlink() for p in (directory, *directory.parents)), "CANONICAL_ADMISSION_DIRECTORY_REQUIRED")
    require(directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o022 == 0, "HOST_OWNED_ADMISSION_DIRECTORY_REQUIRED")
    state = {"version": 1, "environment": "staging", "releaseId": binding["releaseId"],
             "candidateSha256": binding["candidateSha256"], "actionId": action, "newWork": new_work, "recovery": recovery}
    raw = (json.dumps(state, sort_keys=True) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=".admission-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o644)  # public state, read-only in gateway
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, directory / "state.json")
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return migrate.file_hash(raw)


class Host:
    """Fixed host/provider operations. No shell commands or caller programs."""
    def __init__(self, selected, configuration, client):
        self.selected, self.configuration, self.client = selected, configuration, client

    def preflight(self, plan):
        runtime.assert_host(plan["binding"])
        require(runtime.check_containers(self.selected, self.configuration) == self.containers, "RUNTIME_IDENTITIES_CHANGED")
        binding = plan["binding"]
        require(staging_state.configuration_hashes(self.configuration) == binding["configurationSha256"], "CONFIGURATION_CHANGED")
        # Existing helper proves selected source, alias and disabled single
        # native definition. It also checks a full 16s admitted-function drain.
        staging_retire.provider_state(self.client, self.selected, {"frontendDeploymentId": binding["frontendDeploymentId"]}, int(time.time() * 1000))

    def snapshot(self, plan):
        runtime.assert_host(plan["binding"])
        self.containers = runtime.check_containers(self.selected, self.configuration)

    def state(self):
        value = json.loads(runtime.command([*runtime.compose_command(self.configuration, "staging"), "exec", "-T", "gateway",
            "node", "--input-type=module", "--eval",
            'const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(1);process.stdout.write(await r.text())'],
            runtime.runtime_environment(self.selected, self.configuration), 5))
        require(value.get("valid") is True and all(isinstance(value.get(field), dict)
                and all(type(value[field].get(key)) is int and value[field][key] >= 0 for key in ("newWork", "recovery"))
                for field in ("active", "uncertain")),
                "GATEWAY_ACK_REQUIRED")
        return value

    def maintenance_preflight(self, plan):
        import certificates
        import recreation_maintenance
        config = migrate.read_json(recreation_maintenance.CONFIG.parent, recreation_maintenance.CONFIG.name)
        require(config.get("hostMachineId") == plan["binding"]["hostMachineId"], "MAINTENANCE_MACHINE_MISMATCH")
        certificates.plan(config)
        recreation_maintenance.current_certificate_check(config)
        for name in (*staging_retire.TIMERS, *staging_retire.SERVICES):
            installed = migrate.read_input(recreation_maintenance.UNITS, name, 65_536)
            require(installed == migrate.read_input(Path(__file__).parents[1], name, 65_536), "MAINTENANCE_UNIT_SOURCE_MISMATCH")
            state = staging_retire.unit_state(name)
            require(state["ActiveState"] == "inactive" and state["UnitFileState"] in ("disabled", "static"), "MAINTENANCE_MUST_BE_IDLE_DISABLED")
        fields = runtime.command(["systemctl", "show", "--property=InvocationID,Result,ExecMainStatus", "lash-her-certificates-staging.service"], runtime.SAFE_ENV)
        actual = dict(line.split("=", 1) for line in fields.splitlines() if "=" in line)
        require(actual == {"InvocationID": plan["maintenanceInvocationId"], "Result": "success", "ExecMainStatus": "0"}, "ACTUAL_CERTIFICATE_UNIT_REQUIRED")
        logs = runtime.command(["journalctl", "--no-pager", "--output=cat", "_SYSTEMD_INVOCATION_ID=" + actual["InvocationID"]], runtime.SAFE_ENV)
        result = json.loads(logs)
        require(result.get("status") == "TLS_CERTIFICATES_CURRENT" and result.get("renewed") == [] and result.get("servicesStopped") is False,
                "ACTUAL_CURRENT_CERTIFICATE_NOOP_REQUIRED")
        runtime.command(["systemd-analyze", "verify", *(str(recreation_maintenance.UNITS / name)
            for name in (*staging_retire.TIMERS, *staging_retire.SERVICES))], runtime.SAFE_ENV, 60)

    def timer(self, name, enabled):
        require(name in staging_retire.TIMERS and type(enabled) is bool, "FIXED_TIMER_REQUIRED")
        runtime.command(["systemctl", "enable" if enabled else "disable", "--now", name], runtime.SAFE_ENV, 90)
        state = staging_retire.unit_state(name)
        require(state["ActiveState"] == ("active" if enabled else "inactive") and state["UnitFileState"] == ("enabled" if enabled else "disabled"),
                "TIMER_CHANGE_UNVERIFIED")


def drain(host, expected_hash, clock, recovery=False):
    deadline = clock.monotonic() + DRAIN_SECONDS
    while True:
        state = host.state()
        require(state.get("sha256") == expected_hash and state.get("newWork") is False and state.get("recovery") is recovery,
                "GATEWAY_FENCE_CHANGED")
        require(state["uncertain"]["newWork"] == 0 and (recovery or state["uncertain"]["recovery"] == 0),
                "UPSTREAM_MUTATION_REQUIRES_RECONCILIATION")
        if state["active"]["newWork"] == 0 and (recovery or state["active"]["recovery"] == 0):
            return
        require(clock.monotonic() < deadline, "DRAIN_TIMEOUT")
        clock.sleep(min(0.25, max(0, deadline - clock.monotonic())))


def execute(bundle, configuration, compose_file, evidence, output, apply=False, confirmation=None,
            host=None, lock_path=Path("/run/lock/lash-her-release.lock"), clock=time):
    selected, plan = make_plan(bundle, configuration, compose_file, evidence)
    if not apply:
        return plan
    require(confirmation == "staging/" + selected["releaseId"] + "/" + plan["actionId"], "EXPLICIT_ACTION_REQUIRED")
    staging_state.outside_checkout(output.parent)
    require(not output.exists() and not any(output.resolve().is_relative_to(p.resolve()) for p in (bundle, configuration, evidence)), "SEPARATE_FRESH_OUTPUT_REQUIRED")
    # Instantiate provider client only after --apply and explicit action checks.
    host = host or Host(selected, configuration, vercel.Client(os.environ.get("VERCEL_TOKEN")))
    with lock_path.open("a+") as lock:
        native_qualification.acquire_release_lock(lock, clock)
        # Incomplete previous actions leave their exclusive output and fenced
        # state intact. A deliberate new action must inspect actual state first.
        host.snapshot(plan)
        host.preflight(plan)
        host.maintenance_preflight(plan)
        output.mkdir(mode=0o700)
        migrate.write_json(output, "admission-started.json", plan)
        outcome = {**plan, "status": "STAGING_ADMISSION_REQUIRES_REVIEW", "phase": "fence-and-drain",
                   "newWorkAuthorized": False, "recoveryAuthorized": False, "timersEnabled": [], "stateRequiresInspection": False}
        requested = []
        try:
            fenced = persist_state(configuration, plan["binding"], plan["actionId"])
            drain(host, fenced, clock)
            outcome["phase"] = "restore-qualified-maintenance"
            for timer in plan["producers"]["maintenanceTimers"]:
                requested.append(timer)  # intent before possibly ambiguous enable
                host.timer(timer, True)
                outcome["timersEnabled"].append(timer)
            host.preflight(plan)
            # Re-read original evidence and identities before the final action.
            _, current = make_plan(bundle, configuration, compose_file, evidence)
            require(current == plan, "EVIDENCE_CHANGED_DURING_ACTION")
            outcome["phase"] = "admit-recovery"
            admitted = persist_state(configuration, plan["binding"], plan["actionId"], recovery=True)
            drain(host, admitted, clock, recovery=True)
            host.preflight(plan)
            outcome.update(status="STAGING_P1_ACCEPTED_RECOVERY_ADMITTED", phase="completed", releaseAccepted=True,
                           recoveryAuthorized=True, admissionStateSha256=admitted, completedAt=int(clock.time() * 1000))
            return outcome
        except BaseException as error:
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", code) else "ADMISSION_EXECUTION_FAILED"
            outcome.update(releaseAccepted=False, recoveryAuthorized=False)
            # Stop only implicated transport/maintenance. Never replay SQL,
            # restart APIs or cancel independent durable financial workers.
            try:
                fenced = persist_state(configuration, plan["binding"], plan["actionId"])
                drain(host, fenced, clock)
            except BaseException:
                outcome["stateRequiresInspection"] = True
            for timer in reversed(requested):
                try:
                    host.timer(timer, False)
                    if timer in outcome["timersEnabled"]:
                        outcome["timersEnabled"].remove(timer)
                except BaseException:
                    outcome["stateRequiresInspection"] = True
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "admission-outcome.json", outcome)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("bundle", "configuration", "evidence", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: (_ for _ in ()).throw(SystemExit(130)))
    try:
        result = execute(args.bundle, args.configuration, Path(__file__).parents[1] / "compose.yaml", args.evidence, args.output, args.apply, args.confirm)
        print(json.dumps(result))
    except BaseException:
        print('{"status":"STAGING_ADMISSION_REFUSED","reviewRequired":true}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
