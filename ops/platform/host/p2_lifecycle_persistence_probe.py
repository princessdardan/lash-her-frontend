"""Pinned-source, SELECT-only S14/S15 persistence qualification entry."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

import migrate
import release as runtime
import staging_state
import p2_identity_negative_probe as identity_probe
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope

ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
FILES = ("ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
    "ops/platform/host/p2_lifecycle_persistence_scope.py", "ops/platform/host/p2_lifecycle_persistence_probe.py")
demand = migrate.demand


class PersistenceFailure(Exception):
    def __init__(self, check):
        super().__init__(check)
        self.public_receipt = {"version": 1, "status": "P2_LIFECYCLE_PERSISTENCE_REFUSED", "check": check,
            "readOnly": True, "providerTouched": False, "releaseAccepted": False}


def _hash(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def _closed(value, fields):
    return isinstance(value, dict) and sorted(value) == sorted(fields)


def _read(source, name, bound=524_288):
    return migrate.read_input(source, name, bound)


def operator_hashes(source):
    return {name: _hash(_read(source, name)) for name in FILES}


def private_program(source):
    witness = base64.b64encode(_read(source, FILES[0])).decode()
    probe = _read(source, FILES[1]).decode().replace("./p2-lifecycle-state-witness.mjs", "data:text/javascript;base64," + witness)
    module = base64.b64encode(probe.encode()).decode()
    return (f'import("data:text/javascript;base64,{module}")'
        '.then(module=>module.runPrivatePersistenceProbeFromStdin())'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_LIFECYCLE_PERSISTENCE_PRIVATE_REFUSED",check:"private-observation-failed",readOnly:true})+"\\n");process.exitCode=1})').encode()


def _reviewed(value):
    demand(_closed(value, ("version", "environment", "probeId", "plan", "containers", "operatorFiles", "programSha256", "privateDirectory"))
        and value["version"] == 1 and value["environment"] == "staging" and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value["probeId"]),
        "P2_PERSISTENCE_REVIEWED_INPUT_REQUIRED")
    plan = value["plan"]
    demand(isinstance(plan, dict) and plan.get("environment") == "staging" and re.fullmatch(r"[a-f0-9]{40}", plan.get("sources", {}).get("frontend", ""))
        and all(SHA.fullmatch(plan.get(name, "")) for name in ("candidateSha256", "configurationSha256")), "P2_PERSISTENCE_PLAN_REQUIRED")
    demand(isinstance(value["containers"], list) and {row.get("service") for row in value["containers"]} == set(runtime.SERVICES)
        and all(_closed(row, ("service", "containerId", "image", "health")) and re.fullmatch(r"[a-f0-9]{64}", row["containerId"])
            for row in value["containers"]), "P2_PERSISTENCE_CONTAINERS_REQUIRED")
    demand(_closed(value["operatorFiles"], FILES) and all(SHA.fullmatch(item) for item in value["operatorFiles"].values())
        and SHA.fullmatch(value["programSha256"]), "P2_PERSISTENCE_SOURCE_BINDING_REQUIRED")
    directory = Path(value["privateDirectory"])
    demand(directory.is_absolute() and directory.is_relative_to(ROOT) and ".." not in directory.parts and not any(path.is_symlink() for path in directory.parents if path.exists()),
        "P2_PERSISTENCE_PRIVATE_DIRECTORY_REQUIRED")
    return value


def make_plan(bundle, configuration, reviewed, source):
    reviewed = _reviewed(reviewed)
    demand(source == OPERATOR_ROOT / reviewed["plan"]["sources"]["frontend"] and operator_hashes(source) == reviewed["operatorFiles"]
        and _hash(private_program(source)) == reviewed["programSha256"], "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
    selected, jobs, plan, _compose = runtime.make_plan(Path(bundle), Path(configuration), source / "ops/platform/compose.yaml")
    demand(selected["environment"] == "staging" and selected["releaseId"] == reviewed["plan"]["releaseId"]
        and all(selected["sources"][name]["commit"] == commit for name, commit in reviewed["plan"]["sources"].items()), "P2_PERSISTENCE_RELEASE_CHANGED")
    demand(_hash(_read(Path(bundle), "release.candidate.json")) == reviewed["plan"]["candidateSha256"]
        and identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
        "P2_PERSISTENCE_RELEASE_BINDING_CHANGED")
    staging_state.outside_checkout(Path(configuration))
    demand(not any(path.is_symlink() for path in (Path(configuration), *Path(configuration).parents)), "P2_PERSISTENCE_CONFIGURATION_PATH_REQUIRED")
    return {"version": 1, "status": "P2_LIFECYCLE_PERSISTENCE_PLAN", "environment": "staging", "probeId": reviewed["probeId"],
        "candidateSha256": reviewed["plan"]["candidateSha256"], "configurationSha256": reviewed["plan"]["configurationSha256"],
        "programSha256": reviewed["programSha256"], "stages": ["capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"],
        "credentialsRead": False, "networkCalled": False, "readOnly": True, "releaseAccepted": False}, selected


def _private(value, operation):
    fields = ("frontendRuntimeDatabaseUrl", "witness", "priorRecord")
    demand(_closed(value, fields) and isinstance(value["frontendRuntimeDatabaseUrl"], str) and len(value["frontendRuntimeDatabaseUrl"]) <= 8192
        and isinstance(value["witness"], dict) and value["witness"].get("stage") == operation
        and (value["priorRecord"] is None or isinstance(value["priorRecord"], str)), "P2_PERSISTENCE_PRIVATE_INPUT_REQUIRED")
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


def _retain(directory, stage, record):
    demand(directory.parent.is_dir() and not directory.parent.is_symlink() and stat.S_IMODE(directory.parent.stat().st_mode) == 0o700,
        "P2_PERSISTENCE_PRIVATE_PARENT_MODE")
    directory.mkdir(mode=0o700, exist_ok=False)
    demand(not directory.is_symlink() and stat.S_IMODE(directory.stat().st_mode) == 0o700, "P2_PERSISTENCE_PRIVATE_DIRECTORY_MODE")
    path = directory / (stage + ".json")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        body = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        os.write(descriptor, body); os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return _hash(body)


def observe_with_scope(reviewed_plan, private_witness, scope, frontend_runtime_database_url, prior_witness=None):
    demand(isinstance(scope, CurrentLifecyclePersistenceScope) and isinstance(reviewed_plan, dict)
        and isinstance(private_witness, dict) and isinstance(frontend_runtime_database_url, str), "P2_PERSISTENCE_OWNED_SCOPE_REQUIRED")
    scope.verify()
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
            "plan": reviewed_plan, "witness": private_witness, "observations": observations, "priorWitness": prior_witness}),
            "P2_LIFECYCLE_PERSISTENCE_PRIVATE_COMBINED")
        scope.verify()
        # Observations remain private in-process for the S12 owner to prove its
        # freshly generated command IDs absent. Standalone persistence records
        # intentionally retain only the exact witness and sanitized receipt.
        return {**combined, "observations": observations}
    finally:
        credential = None


def execute(bundle, configuration, reviewed, source, private):
    reviewed = _reviewed(reviewed); operation = private["witness"].get("stage"); _private(private, operation)
    plan_receipt, selected = make_plan(bundle, configuration, reviewed, source)
    program = private_program(source)
    def verify_inputs():
        demand(operator_hashes(source) == reviewed["operatorFiles"] and _hash(private_program(source)) == reviewed["programSha256"],
            "P2_PERSISTENCE_OPERATOR_SOURCE_CHANGED")
        demand(identity_probe._configuration_hash(Path(configuration)) == reviewed["plan"]["configurationSha256"],
            "P2_PERSISTENCE_CONFIGURATION_CHANGED")
    scope = CurrentLifecyclePersistenceScope(selected, reviewed, configuration, program, verify_inputs)
    try:
        actual = scope.inventory(selected, configuration)
        demand(actual == reviewed["containers"], "P2_PERSISTENCE_RUNTIME_CHANGED")
        prior = None
        if private["priorRecord"] is not None:
            raw = base64.b64decode(private["priorRecord"], validate=True); prior_record = json.loads(raw)
            demand(_closed(prior_record, ("version", "stage", "subjectBindingSha256", "witness", "receipt"))
                and prior_record["version"] == 1 and prior_record["subjectBindingSha256"] == _subject_binding(private["witness"]),
                "P2_PERSISTENCE_PRIOR_RECORD_REQUIRED")
            prior = prior_record["witness"]
        combined = observe_with_scope(reviewed["plan"], private["witness"], scope, private["frontendRuntimeDatabaseUrl"], prior)
        record = {"version": 1, "stage": operation, "subjectBindingSha256": _subject_binding(private["witness"]),
            "witness": combined["witness"], "receipt": combined["receipt"]}
        private_sha = _retain(Path(reviewed["privateDirectory"]), operation, record)
        result = dict(combined["receipt"]); result.update({"privateRecordSha256": private_sha, "operatorProgramSha256": reviewed["programSha256"],
            "readOnly": True, "providerTouched": False, "releaseAccepted": False})
        scope.verify()
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
        demand(_closed(value, ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "private"))
            and value["version"] == 1 and value["operation"] in ("plan", "capture-export-ready", "capture-delete-baseline", "verify-delete", "lifecycle-account"),
            "P2_PERSISTENCE_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        if value["operation"] == "plan":
            demand(value["private"] is None, "P2_PERSISTENCE_PLAN_NO_PRIVATE_INPUT")
            result = make_plan(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source)[0]
        else:
            result = execute(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source, value["private"])
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
