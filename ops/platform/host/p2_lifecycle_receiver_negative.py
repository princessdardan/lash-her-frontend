"""Fixed S12 account-state-preserving receiver action; never applies SQL."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import p2_identity_negative_probe as identity
import p2_lifecycle_persistence_probe as persistence
from p2_lifecycle_receiver_scope import CurrentLifecycleReceiverScope, CASES

demand = migrate.demand
PROGRAM = "ops/platform/p2-lifecycle-receiver-post.mjs"
PROFILE = "suspended-head-negatives-v1"
SCOPED_REFUSAL = "P2_SCOPED_RECEIVER_NEGATIVES_REFUSED"
WITNESS_PROGRAM = "ops/platform/p2-lifecycle-state-witness.mjs"
TARGET_PROFILE_PROGRAM = "ops/platform/qualification-target-profile.mjs"
SHA = re.compile(r"^[a-f0-9]{64}$")


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _closed(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def private_program(source, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    witness = base64.b64encode(migrate.read_input(source, WITNESS_PROGRAM, 524288)).decode()
    source_bytes = migrate.read_input(source, PROGRAM, 524288)
    module = source_bytes.decode().replace("./p2-lifecycle-state-witness.mjs", "data:text/javascript;base64," + witness)
    argument = ""
    if expected is not None:
        profile = migrate.read_input(source, TARGET_PROFILE_PROGRAM, 524288).decode()
        registry, specifier = "const registry = loadSourceRegistry();", '"./qualification-target-profile.mjs"'
        demand(profile.count(registry) == 1 and module.count(specifier) == 1, SCOPED_REFUSAL)
        profile = profile.replace(registry,
            'const registry = new Map([["staging-current",Object.freeze({body:CURRENT_CANONICAL_BODY,sha256:CURRENT_SHA256})]]);')
        profile_module = base64.b64encode(profile.encode()).decode()
        module = module.replace(specifier, '"data:text/javascript;base64,' + profile_module + '"')
        argument = _canonical(expected).decode()
    encoded = base64.b64encode(module.encode()).decode()
    program = (f'import("data:text/javascript;base64,{encoded}").then(module=>module.runPrivateReceiverPostFromStdin({argument}))'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_LIFECYCLE_RECEIVER_CASE_FAILED",'
        'check:"private-receiver-case-failed",globallyReadOnly:false,oidcVerified:false,releaseAccepted:false})+"\\n");process.exitCode=1})').encode()
    if expected is not None:
        demand(len(program) <= persistence.PERSISTENCE_PROGRAM_MAXIMUM, SCOPED_REFUSAL)
    return program


def validate_reviewed(value):
    demand(_closed(value, ("version", "environment", "profile", "actionId", "persistence", "programSha256", "operatorSourceFiles", "privateDirectory"))
        and value["version"] == 1 and value["environment"] == "staging" and value["profile"] == PROFILE
        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value["actionId"]) and SHA.fullmatch(value["programSha256"]),
        "P2_RECEIVER_REVIEWED_PROFILE_REQUIRED")
    persistence._reviewed(value["persistence"])
    directory = Path(value["privateDirectory"])
    demand(directory.is_absolute() and directory.is_relative_to(persistence.ROOT) and ".." not in directory.parts
        and not any(path.is_symlink() for path in (directory, *directory.parents) if path.exists()), "P2_RECEIVER_PRIVATE_DIRECTORY_REQUIRED")
    demand(isinstance(value["operatorSourceFiles"], dict) and value["operatorSourceFiles"], "P2_RECEIVER_SOURCE_CLOSURE_REQUIRED")
    return value


def open_cases():
    return [{"service": service, "case": "future-gap", "status": "OPEN", "reason": "current-quiescence-not-positively-proved"}
        for service in ("course", "community")]


def make_plan(bundle, configuration, reviewed, source):
    reviewed = validate_reviewed(reviewed)
    _plan, selected = persistence.make_plan(bundle, configuration, reviewed["persistence"], source)
    demand(identity.source_closure(source) == reviewed["operatorSourceFiles"] and _hash(private_program(source)) == reviewed["programSha256"],
        "P2_RECEIVER_SOURCE_CHANGED")
    return {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_NEGATIVE_PLAN", "environment": "staging", "profile": PROFILE,
        "actionId": reviewed["actionId"], "candidateSha256": reviewed["persistence"]["plan"]["candidateSha256"],
        "cases": [{"service": service, "case": case, "expectedHttpStatus": 200 if case == "exact-replay" else 409}
            for service in ("course", "community") for case in CASES], "openCases": open_cases(),
        "credentialsRead": False, "networkCalled": False, "globallyReadOnly": False, "releaseAccepted": False}, selected


def _baseline(witness, observations):
    command, front = witness["command"], witness["frontend"]
    demand(witness["profile"] == "lifecycle-account-v1" and command["action"] == "suspend" and front["status"] == "suspended"
        and front["latestCommandId"] == command["commandId"] and front["laterCommandCount"] == 0 and front["pendingOrDeliveringCount"] == 0
        and all(row["status"] == "acknowledged" and row["leaseId"] is None and row["leaseUntil"] is None and row["acknowledgedAt"] is not None
            for row in front["deliveries"])
        and all(row["status"] == "suspended" and row["latestCommandId"] == command["commandId"] for row in witness["receivers"].values()),
        "P2_RECEIVER_SUSPENDED_HEAD_REQUIRED")
    original = observations["frontend"]["command"][0]["command"]
    expected = {"version": 1, "commandId": command["commandId"], "userId": witness["userId"], "accountVersion": command["accountVersion"],
        "action": command["action"], "issuedAt": command["issuedAt"]}
    demand(original == expected and _hash(_canonical(original)) == command["canonicalSha256"], "P2_RECEIVER_ORIGINAL_CANONICAL_COMMAND_REQUIRED")


def _fresh_id(observations):
    identifier = str(uuid.uuid4())
    demand(all(not any(row["command_id"] == identifier for row in observation["commands"]) for observation in observations.values()),
        "P2_RECEIVER_FRESH_ID_COLLISION")
    return identifier


def _write_private(directory, name, value):
    demand(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == os.getuid()
        and stat.S_IMODE(directory.stat().st_mode) == 0o700, "P2_RECEIVER_PRIVATE_DIRECTORY_MODE")
    raw = _canonical(value) + b"\n"
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    finally:
        pass
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return _hash(raw)


def _parse_child(result, status):
    demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 65536, "P2_RECEIVER_PRIVATE_CHILD_REFUSED")
    value = json.loads(result.stdout)
    demand(isinstance(value, dict) and value.get("status") == status, "P2_RECEIVER_PRIVATE_CHILD_REFUSED")
    return value


def execute(bundle, configuration, reviewed, source, private, confirmation):
    validate_reviewed(reviewed)
    demand(confirmation == "staging/" + reviewed["actionId"] and _closed(private, ("frontendRuntimeDatabaseUrl", "witness"))
        and isinstance(private["frontendRuntimeDatabaseUrl"], str) and 0 < len(private["frontendRuntimeDatabaseUrl"]) <= 8192
        and isinstance(private["witness"], dict) and private["witness"].get("stage") == "lifecycle-account", "P2_RECEIVER_PRIVATE_INPUT_REQUIRED")
    _receipt, selected = make_plan(bundle, configuration, reviewed, source)
    _selected, jobs, runtime_plan, _compose = runtime.make_plan(bundle, configuration, source / "ops/platform/compose.yaml")
    demand(Path("/etc/machine-id").read_text().strip() == runtime_plan["hostMachineId"], "P2_RECEIVER_HOST_CHANGED")
    code = private_program(source)
    def verify_inputs():
        make_plan(bundle, configuration, reviewed, source)
    scope = CurrentLifecycleReceiverScope(selected, reviewed["persistence"], configuration, persistence.private_program(source), code, verify_inputs)
    directory = Path(reviewed["privateDirectory"])
    try:
        demand(directory.parent.is_dir() and not directory.parent.is_symlink() and directory.parent.stat().st_uid == os.getuid()
            and stat.S_IMODE(directory.parent.stat().st_mode) == 0o700, "P2_RECEIVER_PRIVATE_PARENT_MODE")
        directory.mkdir(mode=0o700, exist_ok=False)
        for args, expected in ((["docker", "context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'], b"unix:///var/run/docker.sock"),
                (["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], b"linux/amd64")):
            result = scope.run(args, timeout=15, env=runtime.SAFE_ENV, capture_output=True)
            demand(result.returncode == 0 and not result.stderr and result.stdout.strip() == expected, "P2_RECEIVER_LOCAL_DOCKER_REQUIRED")
        demand(scope.inventory(selected, configuration) == reviewed["persistence"]["containers"], "P2_RECEIVER_RUNTIME_CHANGED")
        containers = {row["service"]: row for row in reviewed["persistence"]["containers"]}
        for service in ("gateway", "course-api", "community-api"):
            identity._one_container(containers[service], configuration, scope)
        environments = {}
        for service in ("course", "community"):
            file = configuration / (service + "-api.env")
            info = file.stat()
            demand(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, "P2_RECEIVER_PRIVATE_RUNTIME_FILE_REQUIRED")
            environments[service] = runtime.environment_values(migrate.read_input(configuration, file.name, 65536), "staging", service + "-api", jobs)
        binding = _hash(_canonical(reviewed))
        def runtime_bound(service):
            scope.verify()
            value = _parse_child(scope.run_receiver({"version": 1, "mode": "runtime-binding", "environment": "staging", "service": service,
                "bindingSha256": binding, "runtimeEnvironment": environments[service]}), "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND")
            demand(value == {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", "service": service, "bindingSha256": binding,
                "runtimeConfigurationVerified": True, "globallyReadOnly": True, "releaseAccepted": False}, "P2_RECEIVER_RUNTIME_BINDING_REQUIRED")
            scope.verify()
        cases = []
        for service in ("course", "community"):
            for case in CASES:
                scope.verify(); runtime_bound(service)
                before = persistence.observe_with_scope(reviewed["persistence"]["plan"], private["witness"], scope,
                    frontend_runtime_database_url=private["frontendRuntimeDatabaseUrl"])
                _baseline(before["witness"], before["observations"])
                fresh = _fresh_id(before["observations"]) if case == "stale-restore" else None
                name = service + "-" + case
                _write_private(directory, name + "-intent.json", {"version": 1, "service": service, "case": case, "bindingSha256": binding,
                    "freshCommandId": fresh, "before": {key: before[key] for key in ("witness", "receipt")}})
                payload = {"version": 1, "mode": "post", "environment": "staging", "service": service, "case": case, "bindingSha256": binding,
                    "witness": before["witness"], "freshCommandId": fresh,
                    "secret": environments[service].get(service.upper() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET"),
                    "gatewayConfigurationSha256": _hash(migrate.read_input(configuration, "gateway.json", 65536)),
                    "gatewayCaSha256": _hash(migrate.read_input(configuration, "tls/gateway/ca.pem", 65536))}
                scope.verify()
                receipt = _parse_child(scope.run_receiver(payload), "P2_LIFECYCLE_RECEIVER_CASE_PASS")
                payload["secret"] = ""
                expected_status = 200 if case == "exact-replay" else 409
                expected_result = "duplicate" if case == "exact-replay" else "idempotency_conflict" if case == "changed-replay" else "account_version_conflict"
                demand(receipt == {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_CASE_PASS", "service": service, "case": case,
                    "bindingSha256": binding, "witnessSha256": before["receipt"]["witnessSha256"], "httpStatus": expected_status,
                    "result": expected_result, "domainStatePreservationRequiresReadback": True,
                    "globallyReadOnly": False, "oidcVerified": False, "releaseAccepted": False}, "P2_RECEIVER_EXACT_CASE_RECEIPT_REQUIRED")
                _write_private(directory, name + "-http.json", receipt)
                after = persistence.observe_with_scope(reviewed["persistence"]["plan"], private["witness"], scope,
                    frontend_runtime_database_url=private["frontendRuntimeDatabaseUrl"])
                demand(before["witness"] == after["witness"], "P2_RECEIVER_DOMAIN_STATE_CHANGED")
                if fresh is not None:
                    demand(all(not any(row["command_id"] == fresh for row in observation["commands"]) for observation in after["observations"].values()),
                        "P2_RECEIVER_REFUSED_COMMAND_PERSISTED")
                runtime_bound(service)
                retained = _write_private(directory, name + "-readback.json", {"version": 1, "http": receipt,
                    "before": {key: before[key] for key in ("witness", "receipt")}, "after": {key: after[key] for key in ("witness", "receipt")}})
                cases.append({"service": service, "case": case, "httpStatus": expected_status, "status": "passed",
                    "beforeWitnessSha256": before["receipt"]["witnessSha256"], "afterWitnessSha256": after["receipt"]["witnessSha256"],
                    "privateRecordSha256": retained, "accountAndDomainStateUnchanged": True, "quotaWritesExcluded": True})
        demand(scope.inventory(selected, configuration) == reviewed["persistence"]["containers"], "P2_RECEIVER_RUNTIME_CHANGED")
        scope.verify()
        plan = reviewed["persistence"]["plan"]
        outcome = {"version": 1, "status": "P2_STAGING_LIFECYCLE_RECEIVER_NEGATIVES_PARTIAL", "environment": "staging", "profile": PROFILE,
            "actionId": reviewed["actionId"], "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"],
            "programSha256": reviewed["programSha256"], "cases": cases, "openCases": open_cases(), "domainStatePreserving": True,
            "globallyReadOnly": False, "quotaWritesExcluded": True, "oidcVerified": False, "frontendSqlVerified": False, "releaseAccepted": False}
        _write_private(directory, "outcome.json", outcome)
        return outcome
    finally:
        private["frontendRuntimeDatabaseUrl"] = ""
        scope.close()


def main():
    try:
        raw = sys.stdin.buffer.read(262145)
        demand(0 < len(raw) <= 262144, "P2_RECEIVER_PRIVATE_PACKET_BOUND")
        value = json.loads(raw)
        demand(_closed(value, ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "confirmation", "private"))
            and value["version"] == 1 and value["operation"] in ("plan", "execute-account-state-preserving"), "P2_RECEIVER_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        bundle, configuration = Path(value["bundleDirectory"]), Path(value["configurationDirectory"])
        if value["operation"] == "plan":
            demand(value["private"] is None and value["confirmation"] is None, "P2_RECEIVER_PLAN_NO_PRIVATE_INPUT")
            result = make_plan(bundle, configuration, value["reviewed"], source)[0]
        else:
            result = execute(bundle, configuration, value["reviewed"], source, value["private"], value["confirmation"])
        sys.stdout.write(json.dumps(result) + "\n")
        return 0
    except BaseException:
        sys.stdout.write(json.dumps({"version": 1, "status": "P2_LIFECYCLE_RECEIVER_ACTION_REFUSED", "globallyReadOnly": False,
            "credentialsExposed": False, "releaseAccepted": False}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
