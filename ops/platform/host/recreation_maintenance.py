"""Restore existing certificate state and rebind maintenance on a new host.

Only the already-held private copies are used. Installation leaves timers
disabled. Activation verifies the new runtime, disabled native schedule and
actual current-certificate systemd invocation before enabling maintenance.
"""
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import certificates
import certificate_invocation
import migrate
import native_qualification
import recreation_files
import recreation_prepare
import release as runtime
import runtime_actions
import staging_restore
import staging_retire
import staging_state
import vercel

demand = migrate.demand
DATA = Path("/var/lib/lash-her")
CONFIG = Path("/etc/lash-her/certificates-staging.json")
UNITS = Path("/etc/systemd/system")
CANONICAL_OPS = Path("/opt/lash-her/ops")
SOURCE_ROOT = Path("/opt/lash-her/operators")
LEGO_VERSION = "4.9.1-2ubuntu0.24.04.3"


def save(path, raw, mode=0o600):
    demand(not any(p.is_symlink() for p in (path, *path.parents)), "RECREATION_MAINTENANCE_SYMLINK_REFUSED")
    recreation_files.private_parents(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)


def validate_recovery_material(config, ca, key, values, runtime_ca, runtime_certificate, runtime_key, machine):
    """Validate retained recovery bytes without filesystem or provider writes."""
    certificates.plan(config)
    demand(config["hostMachineId"] == recreation_prepare.ORIGINAL_MACHINE, "RECREATION_ORIGINAL_CERTIFICATE_BINDING_REQUIRED")
    demand(ca == runtime_ca, "RECREATION_RECOVERY_CA_MISMATCH")
    demand(len(values) == 7 and all(Path(name).suffix in (".key", ".crt", ".json", ".pem") for name in values)
           and any(Path(name).suffix == ".json" and "accounts" in Path(name).parts for name in values),
           "RECREATION_EXISTING_ACME_ACCOUNT_STATE_REQUIRED")
    for ending, raw in ((".crt", runtime_certificate), (".key", runtime_key)):
        demand(values.get("certificates/" + certificates.HOST + ending) == raw,
               "RECREATION_ACME_AND_RUNTIME_PAIR_MISMATCH")
    updated = {**config, "hostMachineId": machine}
    certificates.plan(updated)
    return updated, ca, key, values


def recovery_material(inputs, machine):
    directory = inputs / "maintenance"
    config = migrate.read_json(directory, "certificates-staging.json")
    ca = migrate.read_input(directory / "private-ca", "ca.pem", 65_536)
    key = migrate.read_input(directory / "private-ca", "ca.key", 65_536)
    acme = directory / "acme-staging"
    staging_state.outside_checkout(acme)
    paths = list(acme.rglob("*"))
    demand(not any(p.is_symlink() for p in paths), "RECREATION_ACME_SYMLINK_REFUSED")
    files = [p for p in paths if p.is_file()]
    demand(len(files) == 7, "RECREATION_EXISTING_ACME_ACCOUNT_STATE_REQUIRED")
    values = {str(p.relative_to(acme)): migrate.read_input(acme, str(p.relative_to(acme)), 65_536) for p in files}
    return validate_recovery_material(config, ca, key, values,
        migrate.read_input(inputs / "configuration", "tls/ca.pem", 65_536),
        migrate.read_input(inputs / "configuration", "tls/gateway/cert.pem", 65_536),
        migrate.read_input(inputs / "configuration", "tls/gateway/key.pem", 65_536), machine)


def install(inputs, machine, source_ops, output):
    config, ca, key, acme = recovery_material(inputs, machine)
    source_root = source_ops.parent
    demand(source_ops == SOURCE_ROOT / source_root.name / "ops"
           and re.fullmatch(r"[a-f0-9]{40}", source_root.name), "RECREATION_EXACT_MAINTENANCE_SOURCE_REQUIRED")
    demand(not any(path.exists() or path.is_symlink() for path in
        (CANONICAL_OPS, CONFIG, DATA / "acme-staging", DATA / "private-tls-staging")), "RECREATION_FRESH_MAINTENANCE_DESTINATIONS_REQUIRED")
    source_units = {name: migrate.read_input(source_ops / "platform", name, 65_536)
                    for name in (*staging_retire.TIMERS, *staging_retire.SERVICES)}
    demand(not any((UNITS / name).exists() or (UNITS / name).is_symlink() for name in source_units),
           "RECREATION_FRESH_MAINTENANCE_UNITS_REQUIRED")
    migrate.write_json(output, "maintenance-install-started.json", {"hostMachineId": machine, "sourceCommit": source_root.name,
        "existingAcmeFiles": len(acme), "timersEnabled": False, "newAccountCreated": False})
    for relative, raw in acme.items():
        save(DATA / "acme-staging" / relative, raw)
    save(DATA / "private-tls-staging/ca.pem", ca); save(DATA / "private-tls-staging/ca.key", key)
    save(CONFIG, (json.dumps(config) + "\n").encode())
    runtime.command(["apt-get", "install", "-y", "--no-install-recommends", "lego=" + LEGO_VERSION],
                    {**runtime.SAFE_ENV, "DEBIAN_FRONTEND": "noninteractive"}, 300)
    demand(runtime.command(["dpkg-query", "-W", "-f=${Version}", "lego"], runtime.SAFE_ENV) == LEGO_VERSION,
           "RECREATION_INSTALLED_ACME_VERSION_REQUIRED")
    ca_public = certificates.command(["openssl", "x509", "-in", str(DATA / "private-tls-staging/ca.pem"), "-pubkey", "-noout"])
    key_public = certificates.command(["openssl", "pkey", "-in", str(DATA / "private-tls-staging/ca.key"), "-pubout"])
    demand(ca_public == key_public, "RECREATION_PRIVATE_CA_KEY_MISMATCH")
    CANONICAL_OPS.symlink_to(source_ops, target_is_directory=True)
    for name, raw in source_units.items():
        save(UNITS / name, raw, 0o644)
    runtime.command(["systemd-analyze", "verify", *(str(UNITS / name) for name in source_units)], runtime.SAFE_ENV, 60)
    runtime.command(["systemctl", "daemon-reload"], runtime.SAFE_ENV)
    for unit in (*staging_retire.TIMERS, *staging_retire.SERVICES):
        state = staging_retire.unit_state(unit)
        demand(state["ActiveState"] == "inactive"
               and state["UnitFileState"] in ("disabled", "static"), "RECREATION_MAINTENANCE_MUST_REMAIN_DISABLED")
    return {"status": "RECREATION_MAINTENANCE_INSTALLED_DISABLED", "hostMachineId": machine,
            "sourceCommit": source_root.name, "existingAcmeFilesRestored": len(acme), "newAccountCreated": False,
            "legoVersion": LEGO_VERSION, "timersEnabled": False, "privateValuesDisplayed": False}


def current_certificate_check(config):
    ca = Path(config["privateCaState"]) / "ca.pem"
    selected = certificates.inventory(config)
    demand(certificates.expiry(ca) > time.time() + 30 * 86400 + 600, "RECREATION_EXISTING_CA_LIFETIME_REQUIRED")
    for service, hostname in certificates.SERVICES.items():
        directory = selected[service]["directory"]
        certificates.verify_pair(directory / "cert.pem", directory / "key.pem", hostname, None if service == "gateway" else ca)
        demand(certificates.expiry(directory / "cert.pem") > time.time() + 30 * 86400 + 600,
               "RECREATION_CURRENT_CERTIFICATES_REQUIRED")
        certificates.verify_served(service, directory / "cert.pem", ca)


def activate(inputs, machine, root, output, client):
    selected, _jobs, plan, _compose = staging_state.retained_state(inputs / "bundle", inputs / "configuration",
        inputs / "database-receipts", inputs / "runtime-receipts", inputs / "compose.yaml",
        migrate.file_hash(migrate.read_input(inputs / "database-receipts", "candidate.json")))
    restored = root / "restore"
    ready_raw = migrate.read_input(restored, "runtime-outcome.json")
    ready = json.loads(ready_raw)
    qualification = migrate.read_json(restored / "native-qualification", "qualification-outcome.json")
    demand(ready.get("status") == "API_RUNTIME_RESTORED_FOR_QUALIFICATION" and ready.get("hostMachineId") == machine
           and ready.get("phase") == "completed" and ready.get("candidateSha256") == plan["candidateSha256"]
           and ready.get("migrationOutcomeSha256") == plan["migrationOutcomeSha256"]
           and machine != plan["originalHostMachineId"] and len(ready.get("containers", [])) == 8
           and not ({c["containerId"] for c in ready["containers"]} & {c["containerId"] for c in plan["originalContainers"]})
           and ready.get("environment") == "staging" and ready.get("releaseId") == selected["releaseId"]
           and ready.get("trafficAuthorized") is False and ready.get("releaseAccepted") is False
           and qualification.get("status") == "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE"
           and qualification.get("hostMachineId") == machine and qualification.get("releaseId") == selected["releaseId"]
           and qualification.get("restoredRuntimeReceiptSha256") == migrate.file_hash(ready_raw)
           and qualification.get("nativeSchedulesDisabled") is True
           and qualification.get("nativeWindow", {}).get("disabledAndDrained") is True,
           "RECREATION_ACTUAL_RESTORED_QUALIFICATION_REQUIRED")
    demand(runtime.check_containers(selected, restored / "configuration") == ready.get("containers"), "RECREATION_MAINTENANCE_RUNTIME_CHANGED")
    staging_restore.check_provider(client, selected, {"frontendDeploymentId": qualification["frontendDeploymentId"]})
    config = migrate.read_json(CONFIG.parent, CONFIG.name)
    certificates.plan(config)
    demand(config["hostMachineId"] == machine, "RECREATION_NEW_CERTIFICATE_CONFIGURATION_REQUIRED")
    current_certificate_check(config)
    for unit in (*staging_retire.TIMERS, *staging_retire.SERVICES):
        demand(staging_retire.unit_state(unit)["ActiveState"] == "inactive", "RECREATION_MAINTENANCE_UNITS_MUST_BE_IDLE")
    migrate.write_json(output, "maintenance-activation-started.json", {"hostMachineId": machine,
        "runtimeReceiptSha256": migrate.file_hash(ready_raw), "frontendDeploymentId": qualification["frontendDeploymentId"]})
    enabled = []
    try:
        # The caller deliberately holds no release lock here: the actual
        # systemd invocation must acquire that same lock and cannot report busy.
        minimum_started_usec = time.monotonic_ns() // 1000
        runtime.command(["systemctl", "start", "lash-her-certificates-staging.service"], runtime.SAFE_ENV, 120)
        result = certificate_invocation.read(lambda args: runtime.command(args, runtime.SAFE_ENV),
                                             minimum_started_usec=minimum_started_usec)
        for timer in staging_retire.TIMERS:
            enabled.append(timer)
            runtime.command(["systemctl", "enable", "--now", timer], runtime.SAFE_ENV)
            actual = staging_retire.unit_state(timer)
            demand(actual["ActiveState"] == "active" and actual["UnitFileState"] == "enabled", "RECREATION_TIMER_ENABLE_UNVERIFIED")
        demand(runtime.check_containers(selected, restored / "configuration") == ready["containers"], "RECREATION_MAINTENANCE_RUNTIME_CHANGED")
        staging_restore.check_provider(client, selected, {"frontendDeploymentId": qualification["frontendDeploymentId"]})
        return {"status": "RECREATION_MAINTENANCE_ACTIVE", "hostMachineId": machine, "timersEnabled": enabled,
                "certificateUnitInvocationId": result["invocationId"], "certificateStatus": result["status"],
                "renewalPerformed": False, "newAccountCreated": False, "trafficAuthorized": False, "releaseAccepted": False}
    except BaseException:
        for timer in reversed(enabled):
            try:
                runtime.command(["systemctl", "disable", "--now", timer], runtime.SAFE_ENV, 90)
            except BaseException:
                pass
        raise


def execute(value, source_ops=Path(__file__).resolve().parents[2], lock_path=Path("/run/lock/lash-her-release.lock")):
    demand(value.get("version") == 1 and value.get("environment") == "staging" and value.get("operation") in ("install", "activate"),
           "RECREATION_FIXED_MAINTENANCE_OPERATION_REQUIRED")
    root = recreation_files.action_root(value.get("action"))
    machine = value.get("expectedMachineId")
    demand(isinstance(machine, str) and re.fullmatch(r"[a-f0-9]{32}", machine) and machine != recreation_prepare.ORIGINAL_MACHINE,
           "RECREATION_MAINTENANCE_NEW_MACHINE_REQUIRED")
    demand(value.get("confirmation") == "staging/" + value["action"] + "/maintenance-" + value["operation"],
           "EXPLICIT_RECREATION_MAINTENANCE_CONFIRMATION_REQUIRED")
    demand(os.geteuid() == 0 and sys.platform == "linux", "RECREATION_MAINTENANCE_ROOT_LINUX_REQUIRED")
    runtime.assert_host({"hostMachineId": machine})
    output = root / ("maintenance-" + value["operation"])
    staging_state.outside_checkout(root)
    demand(not output.exists(), "RECREATION_EXCLUSIVE_MAINTENANCE_ACTION_REQUIRED")
    output.mkdir(mode=0o700)
    outcome = {"status": "RECREATION_MAINTENANCE_REQUIRES_REVIEW", "hostMachineId": machine,
               "operation": value["operation"], "trafficAuthorized": False, "releaseAccepted": False}
    try:
        if value["operation"] == "install":
            with lock_path.open("a+") as lock:
                native_qualification.acquire_release_lock(lock)
                result = install(root / "inputs", machine, source_ops, output)
        else:
            result = activate(root / "inputs", machine, root, output, vercel.Client(value["vercelToken"]))
        outcome.update(result)
        return outcome
    except BaseException as error:
        outcome["failureCode"] = runtime_actions.safe_code(error)
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "maintenance-outcome.json", outcome)


def main():
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        raw = sys.stdin.buffer.read(100_001)
        demand(len(raw) <= 100_000, "RECREATION_MAINTENANCE_INPUT_BOUND_REQUIRED")
        result = execute(json.loads(raw))
        print(json.dumps({"status": result["status"], "trafficAuthorized": False, "releaseAccepted": False, "privateValuesDisplayed": False}))
    except BaseException as error:
        print(json.dumps({"status": "RECREATION_MAINTENANCE_REQUIRES_REVIEW", "failureCode": runtime_actions.safe_code(error)}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
