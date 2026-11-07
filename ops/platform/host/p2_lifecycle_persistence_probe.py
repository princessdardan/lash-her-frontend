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
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_state
import p2_identity_negative_probe as identity_probe
import current_databases
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope

ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
PROGRAM_FILES = ("ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
    "ops/platform/host/p2_lifecycle_persistence_scope.py", "ops/platform/host/p2_lifecycle_persistence_probe.py")
SCOPED_PERSISTENCE_STATUS = {
    "capture-export-ready": "P2_LIFECYCLE_EXPORT_READY_CAPTURED",
    "capture-delete-baseline": "P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED",
    "verify-delete": "P2_LIFECYCLE_DELETE_PERSISTENCE_VERIFIED",
}
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


def _source_manifest_digest(manifest, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    raw = (_canonical(manifest) if expected is None else
        json.dumps(sorted(manifest.items()), separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode())
    return _hash(raw)


def _closed(value, fields):
    return isinstance(value, dict) and sorted(value) == sorted(fields)


def _read(source, name, bound=524_288):
    return migrate.read_input(source, name, bound)


def operator_hashes(source):
    """Compatibility helper only; execution authority is the full source closure."""
    return {name: _hash(_read(source, name)) for name in PROGRAM_FILES}


def private_program(source, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    witness = base64.b64encode(_read(source, PROGRAM_FILES[0])).decode()
    probe = _read(source, PROGRAM_FILES[1]).decode().replace("./p2-lifecycle-state-witness.mjs", "data:text/javascript;base64," + witness)
    profile = _read(source, "ops/platform/qualification-target-profile.mjs").decode()
    registry = "const registry = loadSourceRegistry();"
    demand(profile.count(registry) == 1 and probe.count('"./qualification-target-profile.mjs"') == 1,
        "P2_PERSISTENCE_PRIVATE_PROFILE_SOURCE_REQUIRED")
    profile = profile.replace(registry,
        'const registry = new Map([["staging-current",Object.freeze({body:CURRENT_CANONICAL_BODY,sha256:CURRENT_SHA256})]]);')
    profile_module = base64.b64encode(profile.encode()).decode()
    probe = probe.replace('"./qualification-target-profile.mjs"', '"data:text/javascript;base64,' + profile_module + '"')
    module = base64.b64encode(probe.encode()).decode()
    argument = "" if expected is None else json.dumps(expected, sort_keys=True, separators=(",", ":"))
    return (f'import("data:text/javascript;base64,{module}")'
        f'.then(module=>module.runPrivatePersistenceProbeFromStdin({argument}))'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_LIFECYCLE_PERSISTENCE_PRIVATE_REFUSED",check:"private-observation-failed",readOnly:true})+"\\n");process.exitCode=1})').encode()


def _reviewed(value, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    migrate.require_profile(expected, value, value.get("plan") if isinstance(value, dict) else None,
        *(value.get("plan", {}).get("targets", {}).values() if isinstance(value, dict) and isinstance(value.get("plan"), dict)
          and isinstance(value["plan"].get("targets"), dict) else ()))
    profile_fields = ("qualificationTargetProfile",) if expected is not None else ()
    demand(_closed(value, ("version", *profile_fields, "environment", "probeId", "plan", "containers", "operatorSourceFiles", "programSha256", "privateDirectory"))
        and value["version"] == (2 if expected is not None else 1) and value["environment"] == "staging" and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value["probeId"]),
        "P2_PERSISTENCE_REVIEWED_INPUT_REQUIRED")
    plan = value["plan"]
    plan_fields = ("version", *profile_fields, "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
        "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations", "operation", "stages", "finalDisposition",
        "mutationsAuthorized", "credentialsRead", "networkCalled")
    demand(_closed(plan, plan_fields) and plan["version"] == (2 if expected is not None else 1) and plan["environment"] == "staging"
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
        and 1 <= len(value["operatorSourceFiles"]) <= (544 if expected is not None else 512)
        and all(identity_probe._source_path(name) and SHA.fullmatch(item) for name, item in value["operatorSourceFiles"].items())
        and _source_manifest_digest(value["operatorSourceFiles"], expected) == plan["operatorSourceSha256"]
        and SHA.fullmatch(value["programSha256"]),
        "P2_PERSISTENCE_SOURCE_BINDING_REQUIRED")
    directory = Path(value["privateDirectory"])
    demand(directory.is_absolute() and directory.is_relative_to(ROOT) and ".." not in directory.parts and not any(path.is_symlink() for path in directory.parents if path.exists()),
        "P2_PERSISTENCE_PRIVATE_DIRECTORY_REQUIRED")
    return value


def _target_hash(service, target):
    fields = {name: target[name] for name in ("host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor")}
    return _hash(_canonical({"version": 1, "environment": "staging", "service": service, **fields}))


def _source_closure(source, reviewed, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    if expected is None:
        return identity_probe.source_closure(source)
    from p2_source_closure import verify_profiled_current_source_closure
    manifest = reviewed["operatorSourceFiles"]
    closure = _source_manifest_digest(manifest, expected)
    selected = {"mode": "p2-bounded-certification-profiled-current", "qualificationTargetProfile": expected,
        "sourceSha256": manifest, "sourceClosureSha256": closure}
    demand(verify_profiled_current_source_closure(selected, Path(source)) == closure,
        "P2_PERSISTENCE_PROFILED_SOURCE_CLOSURE_CHANGED")
    return manifest


def _join_selected(reviewed, selected, jobs, runtime_plan, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    plan = reviewed["plan"]
    if expected is not None:
        migrate.candidate_profile(selected, expected)
        migrate.require_profile(expected, runtime_plan)
        for info in jobs.values():
            migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    demand(selected.get("environment") == "staging" and selected.get("contractPhase") == "p2" and selected.get("releaseId") == plan["releaseId"]
        and set(jobs) == {"frontend", "course", "community"} and runtime_plan.get("hostMachineId") == plan["hostMachineId"]
        and all(selected["sources"][name]["commit"] == commit for name, commit in plan["sources"].items()), "P2_PERSISTENCE_RELEASE_CHANGED")
    for service in ("frontend", "course", "community"):
        target, job = plan["targets"][service], jobs[service]["job"]
        demand(_closed(target, ("targetSha256", "host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor",
            *(("qualificationTargetProfile",) if expected is not None else ())))
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


def _make_plan_details(bundle, configuration, reviewed, source, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    reviewed = _reviewed(reviewed, expected)
    demand(source == OPERATOR_ROOT / reviewed["plan"]["sources"]["frontend"] and _source_closure(source, reviewed, expected) == reviewed["operatorSourceFiles"]
        and _hash(private_program(source, expected)) == reviewed["programSha256"], "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
    selected, jobs, runtime_plan, _compose = runtime.make_plan(Path(bundle), Path(configuration), source / "ops/platform/compose.yaml", expected_profile=expected)
    _join_selected(reviewed, selected, jobs, runtime_plan, expected)
    demand(_hash(_read(Path(bundle), "release.candidate.json")) == reviewed["plan"]["candidateSha256"]
        and identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
        "P2_PERSISTENCE_RELEASE_BINDING_CHANGED")
    for path in (Path(bundle), Path(configuration)):
        staging_state.outside_checkout(path)
        demand(path.is_absolute() and path.is_relative_to(ROOT) and path.resolve() == path
            and not any(item.is_symlink() for item in (path, *path.parents)), "P2_PERSISTENCE_RUNTIME_PATH_REQUIRED")
    return {"version": 2 if expected is not None else 1, **({"qualificationTargetProfile": expected} if expected is not None else {}),
        "status": "P2_LIFECYCLE_PERSISTENCE_PLAN", "environment": "staging", "probeId": reviewed["probeId"],
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


def _parse_child(result, expected_status, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    demand(result.returncode == 0 and not result.stderr and len(result.stdout) <= 65_536, "P2_PERSISTENCE_PRIVATE_CHILD_REFUSED")
    value = json.loads(result.stdout)
    migrate.require_profile(expected, value)
    demand(value.get("version") == (2 if expected is not None else 1)
        and value.get("status") == expected_status and value.get("readOnly") is True, "P2_PERSISTENCE_PRIVATE_CHILD_REFUSED")
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


def _load_record(directory, stage, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
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
    migrate.require_profile(expected, record)
    demand(_closed(record, ("version", *(("qualificationTargetProfile",) if expected is not None else ()), "stage", "subjectBindingSha256", "contextSha256", "witness", "privateEvidence", "receipt", "priorRecordSha256"))
        and record["version"] == (2 if expected is not None else 1) and record["stage"] == stage and SHA.fullmatch(record["subjectBindingSha256"])
        and SHA.fullmatch(record["contextSha256"]) and (record["priorRecordSha256"] is None or SHA.fullmatch(record["priorRecordSha256"])),
        "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
    return record, _hash(raw)


def _context_binding(plan):
    return _hash(_canonical(plan))


def load_retained_capture(reviewed_plan, private_directory, stage, expected_subject_binding_sha256=None, *, expected_profile=None):
    """Private in-process adapter for S12/S13; never emits record bytes."""
    demand(isinstance(reviewed_plan, dict) and stage in ("capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account")
        and (expected_subject_binding_sha256 is None or SHA.fullmatch(expected_subject_binding_sha256)),
        "P2_PERSISTENCE_RETAINED_CAPTURE_REQUIRED")
    expected = migrate.profile_context(expected_profile)
    migrate.require_profile(expected, reviewed_plan)
    record, record_sha256 = _load_record(Path(private_directory), stage, expected)
    demand(record["contextSha256"] == _context_binding(reviewed_plan)
        and (expected_subject_binding_sha256 is None or record["subjectBindingSha256"] == expected_subject_binding_sha256),
        "P2_PERSISTENCE_RETAINED_CAPTURE_REQUIRED")
    return {"record": record, "recordSha256": record_sha256}


def observe_with_scope(reviewed_plan, private_witness, scope, frontend_runtime_database_url, prior_witness=None, prior_capture=None, *, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    demand(isinstance(scope, CurrentLifecyclePersistenceScope) and isinstance(reviewed_plan, dict)
        and isinstance(private_witness, dict) and isinstance(frontend_runtime_database_url, str), "P2_PERSISTENCE_OWNED_SCOPE_REQUIRED")
    migrate.require_profile(expected, reviewed_plan, *reviewed_plan.get("targets", {}).values())
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
            payload = {"version": 2 if expected is not None else 1, **({"qualificationTargetProfile": expected} if expected is not None else {}),
                "mode": service, "environment": "staging", "target": reviewed_plan["targets"][service],
                "witness": private_witness, "connectionUrl": credential if service == "frontend" else None}
            value = _parse_child(scope.run_persistence(service, payload), "P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION", expected)
            demand(value.get("service") == service and isinstance(value.get("observation"), dict), "P2_PERSISTENCE_OBSERVATION_REQUIRED")
            observations[service] = value["observation"]
            scope.verify()
        # Bound the two receiver snapshots by an unchanged frontend read. The
        # database clock is intentionally excluded; every selected state row,
        # delivery, export and count must remain identical.
        payload = {"version": 2 if expected is not None else 1, **({"qualificationTargetProfile": expected} if expected is not None else {}),
            "mode": "frontend", "environment": "staging", "target": reviewed_plan["targets"]["frontend"],
            "witness": private_witness, "connectionUrl": credential}
        final_frontend = _parse_child(scope.run_persistence("frontend", payload), "P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION", expected)
        demand(final_frontend.get("service") == "frontend" and _stable_observation(final_frontend.get("observation", {})) == _stable_observation(observations["frontend"]),
            "P2_PERSISTENCE_FRONTEND_CHANGED_DURING_READ")
        scope.verify()
        combined = _parse_child(scope.run_persistence("combine", {"version": 2 if expected is not None else 1,
            **({"qualificationTargetProfile": expected} if expected is not None else {}), "mode": "combine", "environment": "staging",
            "plan": reviewed_plan, "witness": private_witness, "observations": observations, "priorCapture": prior_capture}),
            "P2_LIFECYCLE_PERSISTENCE_PRIVATE_COMBINED", expected)
        # Observations remain private in-process for the S12 owner to prove its
        # freshly generated command IDs absent. Standalone persistence records
        # intentionally retain only the exact witness and sanitized receipt.
        return {**combined, "observations": observations}
    finally:
        credential = None
        scope.verify_runtime()


def _release_evidence(reviewed, release_evidence, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    demand(_closed(release_evidence, ("originalReleaseReceipt", "frontendDeploymentRecord")), "P2_PERSISTENCE_RELEASE_EVIDENCE_REQUIRED")
    evidence = {}
    for name, encoded in release_evidence.items():
        raw = base64.b64decode(encoded, validate=True)
        expected_sha = reviewed["plan"]["originalReleaseSha256" if name == "originalReleaseReceipt" else "frontendDeploymentSha256"]
        demand(0 < len(raw) <= 65_536 and _hash(raw) == expected_sha, "P2_PERSISTENCE_RELEASE_EVIDENCE_CHANGED")
        if expected is None:
            value = json.loads(raw)
        else:
            from qualification_target_profile import decode_qualification_target_json
            value = decode_qualification_target_json(raw, "carrier")
            migrate.require_profile(expected, value)
            demand(value.get("version") == 2, "P2_PERSISTENCE_RELEASE_EVIDENCE_CHANGED")
            plan = reviewed["plan"]
            common = value.get("environment") == "staging" and value.get("releaseId") == plan["releaseId"] \
                and value.get("sourceCommit") == plan["sources"]["frontend"]
            if name == "originalReleaseReceipt":
                demand(common and value.get("status") == "P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION"
                    and value.get("candidateSha256") == plan["candidateSha256"]
                    and SHA.fullmatch(value.get("frontendWorkloadReceiptSha256", ""))
                    and value.get("trafficAuthorized") is False and value.get("releaseAccepted") is False,
                    "P2_PERSISTENCE_ORIGINAL_RELEASE_RECEIPT_REQUIRED")
            else:
                demand(common and value.get("status") == "FRONTEND_DOMAINS_PROMOTED" and value.get("phase") == "completed"
                    and value.get("frontendDomainsPromoted") is True and value.get("trafficAuthorized") is False,
                    "P2_PERSISTENCE_FRONTEND_PROMOTION_RECEIPT_REQUIRED")
        demand(isinstance(value, dict), "P2_PERSISTENCE_RELEASE_EVIDENCE_CHANGED")
        evidence[name] = raw
    if expected is not None:
        demand(reviewed["plan"]["originalReleaseSha256"] != reviewed["plan"]["frontendDeploymentSha256"],
            "P2_PERSISTENCE_RELEASE_EVIDENCE_IDENTITIES_REQUIRED")
    return evidence


class HeldCertificationPersistenceScope(CurrentLifecyclePersistenceScope):
    """Fixed reader under the original certification scope; owns no lock."""
    def __init__(self, parent, selected, jobs, reviewed, configuration, source, database_proof, expected_profile, verify_inputs):
        from p2_certification_parent import P2CertificationScope
        expected = migrate.profile_context(expected_profile)
        demand(expected is not None and type(parent) is P2CertificationScope, "P2_PERSISTENCE_CERTIFICATION_SCOPE_REQUIRED")
        self.parent, self.selected, self.jobs = parent, selected, jobs
        self.reviewed, self.configuration = reviewed, Path(configuration)
        self.expected_profile, self.database_proof = expected, database_proof
        self.verify_inputs = verify_inputs
        self.program = self.persistence_program = private_program(source, expected)
        self.runtime_bound = False
        self.ids = {row["containerId"] for row in reviewed["containers"]}
        self.verify()

    def verify(self):
        self.parent.require_release(self.selected, self.jobs)
        self.parent.require_frontend(self.selected, self.jobs["frontend"])
        self.parent.require_configuration(self.configuration)
        current_databases.read_certification_api_proof(self.database_proof, self.parent, self.selected, self.jobs,
            expected_profile=self.expected_profile)
        self.verify_inputs()

    def _actual_runtime(self):
        self.verify()
        token = runtime._command_scope.set(self.parent)
        try:
            actual = runtime.check_containers(self.selected, self.configuration, expected_profile=self.expected_profile)
        finally:
            runtime._command_scope.reset(token)
        demand(actual == self.reviewed["containers"], "P2_PERSISTENCE_RUNTIME_CHANGED")
        self.verify()

    def run(self, args, *, timeout, input=None, env=None, capture_output=True, check=False, text=False):
        demand(capture_output is True and check is False and text is False and 0 < timeout <= 30,
            "P2_PERSISTENCE_FIXED_READER_CHILD_REQUIRED")
        self.verify(); self._allowed(args, input, env)
        result = self.parent.run(args, timeout=timeout, input=input, env=env, capture_output=True)
        demand(len(result.stdout or b"") <= 65_536 and len(result.stderr or b"") <= 8192,
            "P2_PERSISTENCE_PRIVATE_CHILD_REFUSED")
        self.verify(); return result

    def close(self):
        raise ValueError("P2_PERSISTENCE_PARENT_LOCK_NOT_OWNED_BY_READER")

    def revoke(self):
        raise ValueError("P2_PERSISTENCE_PARENT_LOCK_NOT_OWNED_BY_READER")


class P2ScopedLifecyclePersistenceStage:
    """One source-selected persistence observation under the armed certification parent."""
    def __init__(self, broker):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE

        expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        demand(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope
            and broker.scope._expected_profile == expected, "P2_PERSISTENCE_SCOPED_PARENT_REQUIRED")
        self._broker, self._scope, self._expected = broker, broker.scope, expected
        self._plan = self._scope.certification_plan
        self._plan_hash = self._plan.get("planSha256")
        action = self._plan.get("scopedAction")
        demand(self._plan.get("mode") == "lifecycle-persistence" and self._plan.get("startState") == "already-closed"
            and _closed(action, ("stage", "subjectBindingSha256")) and isinstance(action["stage"], str)
            and action["stage"] in SCOPED_PERSISTENCE_STATUS
            and isinstance(action["subjectBindingSha256"], str) and SHA.fullmatch(action["subjectBindingSha256"])
            and action["subjectBindingSha256"] != "0" * 64, "P2_PERSISTENCE_SCOPED_ACTION_REQUIRED")
        self._stage, self._subject = action["stage"], action["subjectBindingSha256"]
        self._lock = threading.Lock()
        self._attempted = self._observing = False

    def _verify_binding(self, scope):
        from p2_certification_parent import _profiled_plan_hash

        broker = self._broker
        demand(self._observing and broker.external_armed is True and broker.guard_arm_verified is True
            and scope is broker.scope is self._scope and broker.observer is scope._physical_observer
            and broker.initial.get("certificationPlan") == self._plan == scope.certification_plan
            and self._plan_hash == _profiled_plan_hash(self._plan), "P2_PERSISTENCE_SCOPED_PARENT_CHANGED")

    def _require_scope(self, scope):
        self._verify_binding(scope)
        broker = self._broker
        broker.check()
        scope.require_release(broker.selected, broker.jobs)
        scope.require_configuration(broker.configuration)
        return scope.require_frontend(broker.selected, broker.jobs["frontend"])

    def _require_closed(self, scope):
        self._require_scope(scope)
        broker = self._broker
        frontend = broker.observer.probe("observe")["admission"]
        gateway = broker._gateway_current()
        admission = gateway["admission"]
        demand(frontend.get("epoch") == self._plan["initialEpoch"]
            and all(value.get("newWork") is False and value.get("recovery") is False for value in (frontend, admission))
            and all(type(frontend.get(key)) is int and frontend[key] == 0 for key in ("active", "uncertain"))
            and all(_closed(admission.get(key), ("newWork", "recovery"))
                and all(type(value) is int and value == 0 for value in admission[key].values())
                for key in ("active", "uncertain"))
            and admission.get("valid") is True and gateway.get("faultLeasePresent") is False,
            "P2_PERSISTENCE_SCOPED_CLOSED_ZERO_REQUIRED")
        broker.require_scoped_native_off()
        self._require_scope(scope)

    def _review(self):
        from p2_certification_parent import _canonical as canonical_certification

        broker, cert = self._broker, self._plan
        expected = self._expected
        initial = broker.initial
        reviewed = _reviewed(initial["persistenceReviewed"], expected)
        plan = reviewed["plan"]
        current = self._require_scope(self._scope)
        source = plan["sources"]["frontend"]
        demand(cert["persistenceReaderEligible"] is True and cert["persistenceReviewedSha256"] == _hash(canonical_certification(reviewed))
            and cert["sourceCommit"] == cert["operatorSourceCommit"] == source
            and initial["sourceClosureSha256"] == cert["operatorSourceClosureSha256"] == plan["operatorSourceSha256"]
            and initial["sourceSha256"] == reviewed["operatorSourceFiles"]
            and initial["candidateSha256"] == cert["candidateSha256"] == self._scope.candidate_sha256 == plan["candidateSha256"]
            and cert["configurationCanonicalSha256"] == plan["configurationSha256"]
            and cert["originalReleaseId"] == plan["releaseId"]
            and initial["hostMachineId"] == plan["hostMachineId"]
            and broker.runtime_current == reviewed["containers"]
            and _hash(canonical_certification(reviewed["containers"])) == cert["runtimeInventorySha256"]
            and all(target["serverMajor"] == broker.jobs[name]["job"]["target"]["serverMajor"]
                for name, target in plan["targets"].items())
            and current["runtime"] == {"name": plan["targets"]["frontend"]["runtimeRole"],
                "oid": plan["targets"]["frontend"]["runtimeRoleOid"]},
            "P2_PERSISTENCE_SCOPED_REVIEW_CHANGED")
        promotion_name = "frontend-promotion-outcome.json"
        demand(cert["originalReleaseReceiptSha256"] == plan["originalReleaseSha256"]
            and cert["readyReceiptSha256"][promotion_name] == plan["frontendDeploymentSha256"],
            "P2_PERSISTENCE_SCOPED_RELEASE_PINS_CHANGED")
        evidence = {"originalReleaseReceipt": initial["originalReleaseReceipt"],
            "frontendDeploymentRecord": initial["readyReceipts"][promotion_name]}
        _release_evidence(reviewed, evidence, expected)
        return reviewed, evidence

    def observe(self):
        with self._lock:
            if self._attempted:
                raise PersistenceFailure("persistence-scoped-stage-already-attempted")
            self._attempted = True
            private = self._broker.initial.pop("persistencePrivate", None)
        self._observing = True
        try:
            _private(private, self._stage)
            demand(bool(private["frontendRuntimeDatabaseUrl"]) and _subject_binding(private["witness"]) == self._subject,
                "P2_PERSISTENCE_SCOPED_SUBJECT_REQUIRED")
            reviewed, evidence = self._review()
            self._require_closed(self._scope)
            broker = self._broker
            proof = broker.api_proof
            current_databases.read_certification_api_proof(proof, self._scope, broker.selected, broker.jobs,
                expected_profile=self._expected)
            result = execute_profiled(broker.bundle, broker.configuration, reviewed, broker.source, private, evidence,
                self._scope, proof, expected_profile=self._expected, _scoped_stage=self)
            migrate.require_profile(self._expected, result)
            demand(type(result["version"]) is int and result["version"] == 2
                and result["status"] == SCOPED_PERSISTENCE_STATUS[self._stage] and result["readOnly"] is True
                and result["providerTouched"] is False and result["releaseAccepted"] is False,
                "P2_PERSISTENCE_SCOPED_RESULT_REQUIRED")
            return result
        except Exception:
            raise PersistenceFailure("persistence-scoped-stage-refused") from None
        finally:
            self._observing = False
            if isinstance(private, dict):
                private.clear()


def execute(bundle, configuration, reviewed, source, private, release_evidence):
    reviewed = _reviewed(reviewed); operation = private["witness"].get("stage"); _private(private, operation)
    plan_receipt, selected, jobs, runtime_plan = _make_plan_details(bundle, configuration, reviewed, source)
    _release_evidence(reviewed, release_evidence)
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


def _execute_profiled(bundle, configuration, reviewed, source, private, release_evidence,
                      certification_scope, database_proof, *, expected_profile, _scoped_stage=None):
    """Read through the existing certification scope; never acquires or closes authority."""
    expected = migrate.profile_context(expected_profile)
    demand(expected is not None, "P2_PERSISTENCE_PROFILE_REQUIRED")
    if _scoped_stage is not None:
        demand(type(_scoped_stage) is P2ScopedLifecyclePersistenceStage and _scoped_stage._expected == expected,
            "P2_PERSISTENCE_SCOPED_PARENT_REQUIRED")
        _scoped_stage._verify_binding(certification_scope)
    reviewed = _reviewed(reviewed, expected); operation = private["witness"].get("stage"); _private(private, operation)
    credential = private["frontendRuntimeDatabaseUrl"]
    private["frontendRuntimeDatabaseUrl"] = ""
    _plan_receipt, selected, jobs, runtime_plan = _make_plan_details(bundle, configuration, reviewed, source, expected)
    _release_evidence(reviewed, release_evidence, expected)
    certification_scope.require_release(selected, jobs)
    certification_scope.require_frontend(selected, jobs["frontend"])
    certification_scope.require_configuration(Path(configuration))
    current_databases.read_certification_api_proof(database_proof, certification_scope, selected, jobs,
        expected_profile=expected)
    runtime.assert_host(runtime_plan)
    program = private_program(source, expected)

    def verify_inputs():
        if _scoped_stage is not None:
            _scoped_stage._verify_binding(certification_scope)
        certification_scope.require_release(selected, jobs)
        certification_scope.require_frontend(selected, jobs["frontend"])
        certification_scope.require_configuration(Path(configuration))
        current_databases.read_certification_api_proof(database_proof, certification_scope, selected, jobs,
            expected_profile=expected)
        demand(Path("/etc/machine-id").read_text().strip() == reviewed["plan"]["hostMachineId"]
            and _source_closure(source, reviewed, expected) == reviewed["operatorSourceFiles"]
            and _hash(private_program(source, expected)) == reviewed["programSha256"],
            "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
        demand(identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
            "P2_PERSISTENCE_CONFIGURATION_CHANGED")
        _receipt, fresh, fresh_jobs, fresh_runtime = _make_plan_details(bundle, configuration, reviewed, source, expected)
        demand(fresh == selected and fresh_jobs == jobs and fresh_runtime == runtime_plan, "P2_PERSISTENCE_RELEASE_CHANGED")

    scope = HeldCertificationPersistenceScope(certification_scope, selected, jobs, reviewed, configuration, source,
        database_proof, expected, verify_inputs)
    try:
        scope.bind_runtime(); verify_inputs()
        directory, prior_capture, prior_sha = Path(reviewed["privateDirectory"]), None, None
        subject_binding = _subject_binding(private["witness"])
        if operation == "capture-delete-baseline":
            retained = load_retained_capture(reviewed["plan"], directory, "capture-export-ready", subject_binding,
                expected_profile=expected)
            prior_record, prior_sha = retained["record"], retained["recordSha256"]
            prior_capture = {"witness": prior_record["witness"], "privateEvidence": prior_record["privateEvidence"]}
        elif operation == "verify-delete":
            retained = load_retained_capture(reviewed["plan"], directory, "capture-delete-baseline", subject_binding,
                expected_profile=expected)
            prior_record, prior_sha = retained["record"], retained["recordSha256"]
            ready = load_retained_capture(reviewed["plan"], directory, "capture-export-ready", subject_binding,
                expected_profile=expected)
            ready_sha = ready["recordSha256"]
            demand(prior_record["priorRecordSha256"] == ready_sha, "P2_PERSISTENCE_PRIOR_CHAIN_REQUIRED")
            prior_capture = {"witness": prior_record["witness"], "privateEvidence": prior_record["privateEvidence"]}
        if prior_capture is not None:
            demand(prior_record["subjectBindingSha256"] == subject_binding, "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
        combined = observe_with_scope(reviewed["plan"], private["witness"], scope, credential,
            prior_capture=prior_capture, expected_profile=expected)
        if _scoped_stage is not None:
            _scoped_stage._require_closed(certification_scope)
        record = {"version": 2, "qualificationTargetProfile": expected, "stage": operation,
            "subjectBindingSha256": subject_binding, "contextSha256": _context_binding(reviewed["plan"]),
            "witness": combined["witness"], "privateEvidence": combined["privateEvidence"],
            "receipt": combined["receipt"], "priorRecordSha256": prior_sha}
        private_sha = _retain(directory, operation, record)
        result = dict(combined["receipt"]); result.update({"version": 2, "qualificationTargetProfile": expected,
            "privateRecordSha256": private_sha, "operatorProgramSha256": reviewed["programSha256"],
            "readOnly": True, "providerTouched": False, "releaseAccepted": False})
        original_email = private["witness"].get("originalEmail")
        demand(original_email is None or original_email not in json.dumps(result), "P2_PERSISTENCE_PRIVATE_OUTPUT_REFUSED")
        scope.verify_runtime(); verify_inputs()
        return result
    except BaseException:
        raise PersistenceFailure("persistence-profiled-current-stage-refused") from None
    finally:
        private["frontendRuntimeDatabaseUrl"] = ""


def execute_profiled(bundle, configuration, reviewed, source, private, release_evidence,
                     certification_scope, database_proof, *, expected_profile, _scoped_stage=None):
    try:
        return _execute_profiled(bundle, configuration, reviewed, source, private, release_evidence,
            certification_scope, database_proof, expected_profile=expected_profile, _scoped_stage=_scoped_stage)
    except PersistenceFailure:
        raise
    except BaseException:
        raise PersistenceFailure("persistence-profiled-current-stage-refused") from None
    finally:
        if isinstance(private, dict) and "frontendRuntimeDatabaseUrl" in private:
            private["frontendRuntimeDatabaseUrl"] = ""


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
