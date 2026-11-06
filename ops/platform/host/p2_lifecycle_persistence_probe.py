#!/usr/bin/env python3
"""Pinned-source, SELECT-only S14/S15 persistence qualification entry."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_state
import p2_identity_negative_probe as identity_probe
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope

ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
PROGRAM_FILES = ("ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
    "ops/platform/host/p2_lifecycle_persistence_scope.py", "ops/platform/host/p2_lifecycle_persistence_probe.py")
demand = migrate.demand


class PersistenceFailure(Exception):
    def __init__(self, check):
        super().__init__(check)
        self.public_receipt = {"version": 1, "status": "P2_LIFECYCLE_PERSISTENCE_REFUSED", "check": check,
            "readOnly": True, "providerTouched": False, "releaseAccepted": False}


def _hash(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _closed(value, fields):
    return isinstance(value, dict) and sorted(value) == sorted(fields)


def _read(source, name, bound=524_288):
    return migrate.read_input(source, name, bound)


def operator_hashes(source):
    """Compatibility helper only; execution authority is the full source closure."""
    return {name: _hash(_read(source, name)) for name in PROGRAM_FILES}


def private_program(source):
    witness = base64.b64encode(_read(source, PROGRAM_FILES[0])).decode()
    probe = _read(source, PROGRAM_FILES[1]).decode().replace("./p2-lifecycle-state-witness.mjs", "data:text/javascript;base64," + witness)
    module = base64.b64encode(probe.encode()).decode()
    return (f'import("data:text/javascript;base64,{module}")'
        '.then(module=>module.runPrivatePersistenceProbeFromStdin())'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_LIFECYCLE_PERSISTENCE_PRIVATE_REFUSED",check:"private-observation-failed",readOnly:true})+"\\n");process.exitCode=1})').encode()


def _reviewed(value):
    demand(_closed(value, ("version", "environment", "probeId", "plan", "containers", "operatorSourceFiles", "programSha256", "privateDirectory"))
        and value["version"] == 1 and value["environment"] == "staging" and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value["probeId"]),
        "P2_PERSISTENCE_REVIEWED_INPUT_REQUIRED")
    plan = value["plan"]
    plan_fields = ("version", "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
        "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations", "operation", "stages", "finalDisposition",
        "mutationsAuthorized", "credentialsRead", "networkCalled")
    demand(_closed(plan, plan_fields) and plan["version"] == 1 and plan["environment"] == "staging"
        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan["releaseId"])
        and re.fullmatch(r"[a-f0-9]{32}", plan["hostMachineId"]) and plan["hostMachineId"] != "0" * 32
        and all(SHA.fullmatch(plan.get(name, "")) for name in ("candidateSha256", "configurationSha256", "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256"))
        and _closed(plan["sources"], ("frontend", "course", "community")) and all(re.fullmatch(r"[a-f0-9]{40}", commit) for commit in plan["sources"].values())
        and _closed(plan["targets"], ("frontend", "course", "community"))
        and _closed(plan["containerImages"], ("course", "community"))
        and plan["expectedMigrations"] == {"frontend": 83, "course": 22, "community": 11}
        and plan["operation"] == "p2-lifecycle-persistence-readonly"
        and plan["stages"] == ["capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"]
        and plan["finalDisposition"] == "observed-only" and plan["mutationsAuthorized"] is False
        and plan["credentialsRead"] is False and plan["networkCalled"] is False, "P2_PERSISTENCE_PLAN_REQUIRED")
    demand(isinstance(value["containers"], list) and len(value["containers"]) == len(runtime.SERVICES)
        and {row.get("service") for row in value["containers"]} == set(runtime.SERVICES)
        and all(_closed(row, ("service", "containerId", "image", "health")) and re.fullmatch(r"[a-f0-9]{64}", row["containerId"])
            and isinstance(row["image"], str) and re.fullmatch(r"sha256:[a-f0-9]{64}", row["image"].split("@")[-1])
            and row["health"] in ("healthy", "none") for row in value["containers"])
        and len({row["containerId"] for row in value["containers"]}) == len(runtime.SERVICES), "P2_PERSISTENCE_CONTAINERS_REQUIRED")
    demand(isinstance(value["operatorSourceFiles"], dict) and identity_probe.SOURCE_ANCHORS.issubset(value["operatorSourceFiles"])
        and 1 <= len(value["operatorSourceFiles"]) <= 448 and all(identity_probe._source_path(name) and SHA.fullmatch(item) for name, item in value["operatorSourceFiles"].items())
        and _hash(_canonical(value["operatorSourceFiles"])) == plan["operatorSourceSha256"] and SHA.fullmatch(value["programSha256"]),
        "P2_PERSISTENCE_SOURCE_BINDING_REQUIRED")
    directory = Path(value["privateDirectory"])
    demand(directory.is_absolute() and directory.is_relative_to(ROOT) and ".." not in directory.parts and not any(path.is_symlink() for path in directory.parents if path.exists()),
        "P2_PERSISTENCE_PRIVATE_DIRECTORY_REQUIRED")
    return value


def _target_hash(service, target):
    fields = {name: target[name] for name in ("host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor")}
    return _hash(_canonical({"version": 1, "environment": "staging", "service": service, **fields}))


def _join_selected(reviewed, selected, jobs, runtime_plan):
    plan = reviewed["plan"]
    demand(selected.get("environment") == "staging" and selected.get("contractPhase") == "p2" and selected.get("releaseId") == plan["releaseId"]
        and set(jobs) == {"frontend", "course", "community"} and runtime_plan.get("hostMachineId") == plan["hostMachineId"]
        and all(selected["sources"][name]["commit"] == commit for name, commit in plan["sources"].items()), "P2_PERSISTENCE_RELEASE_CHANGED")
    for service in ("frontend", "course", "community"):
        target, job = plan["targets"][service], jobs[service]["job"]
        demand(_closed(target, ("targetSha256", "host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor"))
            and target["targetSha256"] == _target_hash(service, target), "P2_PERSISTENCE_TARGET_BINDING_REQUIRED")
        selected_target = job["target"]
        selected_role = selected_target.get("runtimeRole") if service == "frontend" else job.get("runtimeRole")
        selected_fields = ("host", "port", "database", "serverMajor") if service == "frontend" else ("host", "port", "database")
        demand(all(target[name] == selected_target.get(name, 5432 if name == "port" else None) for name in selected_fields)
            and target["runtimeRole"] == selected_role, "P2_PERSISTENCE_TARGET_BINDING_REQUIRED")
    demand(plan["containerImages"] == {"course": selected["artifacts"]["courseRuntime"]["image"],
        "community": selected["artifacts"]["communityRuntime"]["image"]}, "P2_PERSISTENCE_IMAGE_BINDING_REQUIRED")
    expected = {row["service"]: selected["artifacts"][runtime.IMAGE_KEYS[row["service"]]]["image"] for row in reviewed["containers"]}
    demand(all(row["image"] == expected[row["service"]] for row in reviewed["containers"]), "P2_PERSISTENCE_IMAGE_BINDING_REQUIRED")


def _make_plan_details(bundle, configuration, reviewed, source):
    reviewed = _reviewed(reviewed)
    demand(source == OPERATOR_ROOT / reviewed["plan"]["sources"]["frontend"] and identity_probe.source_closure(source) == reviewed["operatorSourceFiles"]
        and _hash(private_program(source)) == reviewed["programSha256"], "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
    selected, jobs, runtime_plan, _compose = runtime.make_plan(Path(bundle), Path(configuration), source / "ops/platform/compose.yaml")
    _join_selected(reviewed, selected, jobs, runtime_plan)
    demand(_hash(_read(Path(bundle), "release.candidate.json")) == reviewed["plan"]["candidateSha256"]
        and identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
        "P2_PERSISTENCE_RELEASE_BINDING_CHANGED")
    for path in (Path(bundle), Path(configuration)):
        staging_state.outside_checkout(path)
        demand(path.is_absolute() and path.is_relative_to(ROOT) and path.resolve() == path
            and not any(item.is_symlink() for item in (path, *path.parents)), "P2_PERSISTENCE_RUNTIME_PATH_REQUIRED")
    return {"version": 1, "status": "P2_LIFECYCLE_PERSISTENCE_PLAN", "environment": "staging", "probeId": reviewed["probeId"],
        "candidateSha256": reviewed["plan"]["candidateSha256"], "configurationSha256": reviewed["plan"]["configurationSha256"],
        "programSha256": reviewed["programSha256"], "stages": ["capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"],
        "credentialsRead": False, "networkCalled": False, "readOnly": True, "releaseAccepted": False}, selected, jobs, runtime_plan


def make_plan(bundle, configuration, reviewed, source):
    receipt, selected, _jobs, _runtime_plan = _make_plan_details(bundle, configuration, reviewed, source)
    return receipt, selected


def _private(value, operation):
    fields = ("frontendRuntimeDatabaseUrl", "witness")
    demand(_closed(value, fields) and isinstance(value["frontendRuntimeDatabaseUrl"], str) and len(value["frontendRuntimeDatabaseUrl"]) <= 8192
        and isinstance(value["witness"], dict) and value["witness"].get("stage") == operation, "P2_PERSISTENCE_PRIVATE_INPUT_REQUIRED")
    return value


def _subject_binding(witness):
    if witness["stage"] == "lifecycle-account":
        return _hash(json.dumps({name: witness[name] for name in ("userId", "selectedCommand")}, sort_keys=True, separators=(",", ":")))
    names = ("userId", "originalEmail", "exportCommand", "attemptIds", "grantIds", "streamIds", "inboxEventIds")
    return _hash(json.dumps({name: witness[name] for name in names}, sort_keys=True, separators=(",", ":")))


def _parse_child(result, expected_status):
    demand(result.returncode == 0 and not result.stderr and len(result.stdout) <= 65_536, "P2_PERSISTENCE_PRIVATE_CHILD_REFUSED")
    value = json.loads(result.stdout)
    demand(value.get("status") == expected_status and value.get("readOnly") is True, "P2_PERSISTENCE_PRIVATE_CHILD_REFUSED")
    return value


def _stable_observation(value):
    return {name: child for name, child in value.items() if name != "now"}


def _private_directory(directory, create=False):
    demand(directory.parent.is_dir() and not directory.parent.is_symlink() and directory.parent.stat().st_uid == os.getuid()
        and stat.S_IMODE(directory.parent.stat().st_mode) == 0o700,
        "P2_PERSISTENCE_PRIVATE_PARENT_MODE")
    if create:
        directory.mkdir(mode=0o700, exist_ok=False)
    demand(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == os.getuid()
        and stat.S_IMODE(directory.stat().st_mode) == 0o700, "P2_PERSISTENCE_PRIVATE_DIRECTORY_MODE")


def _retain(directory, stage, record):
    _private_directory(directory, create=not directory.exists())
    path = directory / (stage + ".json")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        body = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        demand(os.write(descriptor, body) == len(body), "P2_PERSISTENCE_PRIVATE_RECORD_WRITE")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return _hash(body)


def _load_record(directory, stage):
    _private_directory(directory)
    descriptor = os.open(directory / (stage + ".json"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600
            and 0 < info.st_size <= 524_288, "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
        raw = os.read(descriptor, info.st_size + 1)
    finally:
        os.close(descriptor)
    demand(len(raw) == info.st_size, "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
    record = json.loads(raw)
    demand(_closed(record, ("version", "stage", "subjectBindingSha256", "contextSha256", "witness", "privateEvidence", "receipt", "priorRecordSha256"))
        and record["version"] == 1 and record["stage"] == stage and SHA.fullmatch(record["subjectBindingSha256"])
        and SHA.fullmatch(record["contextSha256"]) and (record["priorRecordSha256"] is None or SHA.fullmatch(record["priorRecordSha256"])),
        "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
    return record, _hash(raw)


def _context_binding(plan):
    return _hash(_canonical(plan))


def load_retained_capture(reviewed_plan, private_directory, stage, expected_subject_binding_sha256=None):
    """Private in-process adapter for S12/S13; never emits record bytes."""
    demand(isinstance(reviewed_plan, dict) and stage in ("capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account")
        and (expected_subject_binding_sha256 is None or SHA.fullmatch(expected_subject_binding_sha256)),
        "P2_PERSISTENCE_RETAINED_CAPTURE_REQUIRED")
    record, record_sha256 = _load_record(Path(private_directory), stage)
    demand(record["contextSha256"] == _context_binding(reviewed_plan)
        and (expected_subject_binding_sha256 is None or record["subjectBindingSha256"] == expected_subject_binding_sha256),
        "P2_PERSISTENCE_RETAINED_CAPTURE_REQUIRED")
    return {"record": record, "recordSha256": record_sha256}


def observe_with_scope(reviewed_plan, private_witness, scope, frontend_runtime_database_url, prior_witness=None, prior_capture=None):
    demand(isinstance(scope, CurrentLifecyclePersistenceScope) and isinstance(reviewed_plan, dict)
        and isinstance(private_witness, dict) and isinstance(frontend_runtime_database_url, str), "P2_PERSISTENCE_OWNED_SCOPE_REQUIRED")
    demand(not (prior_witness is not None and prior_capture is not None), "P2_PERSISTENCE_PRIOR_CAPTURE_REQUIRED")
    if prior_witness is not None:
        prior_capture = {"witness": prior_witness, "privateEvidence": None}
    if not scope.runtime_bound:
        scope.bind_runtime()
    else:
        scope.verify_runtime()
    observations = {}
    credential = frontend_runtime_database_url
    try:
        for service in ("frontend", "course", "community"):
            scope.verify()
            payload = {"version": 1, "mode": service, "environment": "staging", "target": reviewed_plan["targets"][service],
                "witness": private_witness, "connectionUrl": credential if service == "frontend" else None}
            value = _parse_child(scope.run_persistence(service, payload), "P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION")
            demand(value.get("service") == service and isinstance(value.get("observation"), dict), "P2_PERSISTENCE_OBSERVATION_REQUIRED")
            observations[service] = value["observation"]
            scope.verify()
        # Bound the two receiver snapshots by an unchanged frontend read. The
        # database clock is intentionally excluded; every selected state row,
        # delivery, export and count must remain identical.
        payload = {"version": 1, "mode": "frontend", "environment": "staging", "target": reviewed_plan["targets"]["frontend"],
            "witness": private_witness, "connectionUrl": credential}
        final_frontend = _parse_child(scope.run_persistence("frontend", payload), "P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION")
        demand(final_frontend.get("service") == "frontend" and _stable_observation(final_frontend.get("observation", {})) == _stable_observation(observations["frontend"]),
            "P2_PERSISTENCE_FRONTEND_CHANGED_DURING_READ")
        scope.verify()
        combined = _parse_child(scope.run_persistence("combine", {"version": 1, "mode": "combine", "environment": "staging",
            "plan": reviewed_plan, "witness": private_witness, "observations": observations, "priorCapture": prior_capture}),
            "P2_LIFECYCLE_PERSISTENCE_PRIVATE_COMBINED")
        # Observations remain private in-process for the S12 owner to prove its
        # freshly generated command IDs absent. Standalone persistence records
        # intentionally retain only the exact witness and sanitized receipt.
        return {**combined, "observations": observations}
    finally:
        credential = None
        scope.verify_runtime()


def execute(bundle, configuration, reviewed, source, private, release_evidence):
    reviewed = _reviewed(reviewed); operation = private["witness"].get("stage"); _private(private, operation)
    plan_receipt, selected, jobs, runtime_plan = _make_plan_details(bundle, configuration, reviewed, source)
    demand(_closed(release_evidence, ("originalReleaseReceipt", "frontendDeploymentRecord")), "P2_PERSISTENCE_RELEASE_EVIDENCE_REQUIRED")
    evidence = {}
    for name, encoded in release_evidence.items():
        raw = base64.b64decode(encoded, validate=True)
        expected = reviewed["plan"]["originalReleaseSha256" if name == "originalReleaseReceipt" else "frontendDeploymentSha256"]
        demand(0 < len(raw) <= 65_536 and _hash(raw) == expected and isinstance(json.loads(raw), dict), "P2_PERSISTENCE_RELEASE_EVIDENCE_CHANGED")
        evidence[name] = raw
    runtime.assert_host(runtime_plan)
    program = private_program(source)
    def verify_inputs():
        demand(Path("/etc/machine-id").read_text().strip() == reviewed["plan"]["hostMachineId"]
            and identity_probe.source_closure(source) == reviewed["operatorSourceFiles"] and _hash(private_program(source)) == reviewed["programSha256"],
            "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
        demand(identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
            "P2_PERSISTENCE_CONFIGURATION_CHANGED")
        _receipt, fresh, fresh_jobs, fresh_runtime = _make_plan_details(bundle, configuration, reviewed, source)
        demand(fresh == selected and fresh_jobs == jobs and fresh_runtime == runtime_plan, "P2_PERSISTENCE_RELEASE_CHANGED")
    scope = CurrentLifecyclePersistenceScope(selected, reviewed, configuration, program, verify_inputs)
    try:
        scope.bind_runtime()
        directory, prior_capture, prior_sha = Path(reviewed["privateDirectory"]), None, None
        subject_binding = _subject_binding(private["witness"])
        if operation == "capture-delete-baseline":
            retained = load_retained_capture(reviewed["plan"], directory, "capture-export-ready", subject_binding)
            prior_record, prior_sha = retained["record"], retained["recordSha256"]
            prior_capture = {"witness": prior_record["witness"], "privateEvidence": prior_record["privateEvidence"]}
        elif operation == "verify-delete":
            retained = load_retained_capture(reviewed["plan"], directory, "capture-delete-baseline", subject_binding)
            prior_record, prior_sha = retained["record"], retained["recordSha256"]
            ready = load_retained_capture(reviewed["plan"], directory, "capture-export-ready", subject_binding)
            ready_sha = ready["recordSha256"]
            demand(prior_record["priorRecordSha256"] == ready_sha, "P2_PERSISTENCE_PRIOR_CHAIN_REQUIRED")
            prior_capture = {"witness": prior_record["witness"], "privateEvidence": prior_record["privateEvidence"]}
        if prior_capture is not None:
            demand(prior_record["subjectBindingSha256"] == subject_binding, "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
        combined = observe_with_scope(reviewed["plan"], private["witness"], scope, private["frontendRuntimeDatabaseUrl"], prior_capture=prior_capture)
        record = {"version": 1, "stage": operation, "subjectBindingSha256": subject_binding,
            "contextSha256": _context_binding(reviewed["plan"]), "witness": combined["witness"], "privateEvidence": combined["privateEvidence"],
            "receipt": combined["receipt"], "priorRecordSha256": prior_sha}
        private_sha = _retain(directory, operation, record)
        result = dict(combined["receipt"]); result.update({"privateRecordSha256": private_sha, "operatorProgramSha256": reviewed["programSha256"],
            "readOnly": True, "providerTouched": False, "releaseAccepted": False})
        scope.verify_runtime()
        return result
    except BaseException:
        raise PersistenceFailure("persistence-current-stage-refused") from None
    finally:
        private["frontendRuntimeDatabaseUrl"] = ""
        if not scope.closed:
            scope.close()


def main():
    try:
        raw = sys.stdin.buffer.read(1_048_577)
        demand(0 < len(raw) <= 1_048_576, "P2_PERSISTENCE_PACKET_BOUND")
        value = json.loads(raw)
        demand(_closed(value, ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "private", "releaseEvidence"))
            and value["version"] == 1 and value["operation"] in ("plan", "capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"),
            "P2_PERSISTENCE_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        if value["operation"] == "plan":
            demand(value["private"] is None and value["releaseEvidence"] is None, "P2_PERSISTENCE_PLAN_NO_PRIVATE_INPUT")
            result = make_plan(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source)[0]
        else:
            result = execute(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source, value["private"], value["releaseEvidence"])
        sys.stdout.write(json.dumps(result) + "\n")
        return 0
    except BaseException as failure:
        result = failure.public_receipt if isinstance(failure, PersistenceFailure) else {
            "version": 1, "status": "P2_LIFECYCLE_PERSISTENCE_REFUSED", "check": "current-stage-packet-refused",
            "readOnly": True, "providerTouched": False, "releaseAccepted": False}
        sys.stdout.write(json.dumps(result) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
