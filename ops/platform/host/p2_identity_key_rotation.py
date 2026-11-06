"""Plan-only staging P2 application-user JWT rotation source package.

Live execution is intentionally unavailable until the fixed config-only
certification parent supplies its held host and frontend physical scopes.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate
import p2_identity_negative_probe as identity
import staging_state

ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
PROGRAM = "ops/platform/p2-identity-key-rotation.mjs"
IDENTITY = "ops/platform/p2-identity-negative-probe.mjs"
FILES = (PROGRAM, "ops/platform/p2-identity-key-rotation.test.mjs", "ops/platform/host/p2_identity_key_rotation.py",
    "ops/platform/host/p2_identity_key_rotation_test.py", "ops/platform/p2-identity-key-rotation-controller.mjs",
    "ops/platform/p2-identity-key-rotation-controller.test.mjs", "ops/platform/p2-identity-key-rotation-observer.mjs",
    "ops/platform/host/p2_identity_key_rotation_adapter.py", "ops/platform/host/p2_identity_key_rotation_adapter_test.py",
    "ops/platform/p2-identity-key-rotation-parent.mjs", "ops/platform/p2-identity-key-rotation-parent.test.mjs",
    "ops/platform/p2-identity-key-rotation-transport.mjs", "ops/platform/p2-identity-key-rotation-browser-recorder.mjs",
    "ops/platform/p2-identity-key-rotation-browser-recorder.test.mjs",
    "ops/platform/p2-identity-key-rotation-session-closed.mjs",
    "ops/platform/p2-identity-key-rotation-session-closed.test.mjs",
    "ops/platform/p2-identity-key-rotation-operator.mjs",
    "ops/platform/p2-identity-key-rotation-operator.test.mjs",
    "ops/platform/p2-canonical-browser-origin.mjs",
    "ops/platform/p2-canonical-browser-origin.test.mjs",
    "ops/platform/host/p2_canonical_browser_origin.py",
    "ops/platform/host/p2_canonical_browser_origin_test.py",
    "ops/platform/p2-recovery-api-current-probe.mjs",
    "ops/platform/host/p2_identity_key_rotation_parent.py", "ops/platform/host/p2_identity_key_rotation_parent_test.py",
    "ops/platform/p2-identity-key-rotation.md")
PHASES = ("baseline", "overlap", "currentOnly", "restoration")
PROFILES = ("course-learner", "course-admin", "community-member", "community-admin")
PARENT_ADAPTER_READY = True
SHA = re.compile(r"^[a-f0-9]{64}$")
demand = migrate.demand


class RotationPlanFailure(Exception):
    def __init__(self, check="rotation-parent-adapter-required"):
        super().__init__("P2_IDENTITY_KEY_ROTATION_REFUSED")
        self.public_receipt = {"version": 1, "status": "P2_IDENTITY_KEY_ROTATION_REFUSED", "check": check,
            "parentAdapterReady": False, "keyRemovalVerified": False, "tokenBytesOutput": False,
            "credentialHashesOutput": False, "releaseAccepted": False}


def _hash(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _closed(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def _read(source, name, bound=524_288):
    return migrate.read_input(Path(source), name, bound)


def operator_hashes(source):
    return {name: _hash(_read(source, name)) for name in FILES}


def private_program(source):
    identity_module = base64.b64encode(_read(source, IDENTITY, 131_072)).decode()
    raw = _read(source, PROGRAM, 196_608).decode()
    demand(raw.count('./p2-identity-negative-probe.mjs') == 1, "P2_ROTATION_IDENTITY_IMPORT_REQUIRED")
    module = raw.replace("./p2-identity-negative-probe.mjs", "data:text/javascript;base64," + identity_module)
    encoded = base64.b64encode(module.encode()).decode()
    return (f'import("data:text/javascript;base64,{encoded}")'
        '.then(module=>module.runPrivateRotationFromStdin())'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_IDENTITY_ROTATION_PRIVATE_REFUSED",check:"private-rotation-failed",tokenBytesOutput:false,credentialHashesOutput:false,releaseAccepted:false})+"\\n");process.exitCode=1})').encode()


def validate_reviewed(value):
    fields = ("version", "environment", "actionId", "identity", "phaseConfigurations", "restorationPhase", "operatorFiles",
        "programSha256", "parentSourceSha256")
    demand(_closed(value, fields) and value["version"] == 1 and value["environment"] == "staging" and
        isinstance(value["actionId"], str) and re.fullmatch(r"p2-key-rotation-[a-z0-9-]{1,40}", value["actionId"]),
        "P2_ROTATION_REVIEWED_INPUT_REQUIRED")
    identity.validate_reviewed(value["identity"])
    demand(value["identity"]["previousProfiles"] == [], "P2_ROTATION_BASELINE_CURRENT_ONLY_REQUIRED")
    demand(_closed(value["phaseConfigurations"], PHASES) and value["restorationPhase"] in ("baseline", "overlap") and
        _closed(value["operatorFiles"], FILES) and all(SHA.fullmatch(item) for item in value["operatorFiles"].values()) and
        SHA.fullmatch(value["programSha256"]) and SHA.fullmatch(value["parentSourceSha256"]), "P2_ROTATION_SOURCE_BINDING_REQUIRED")
    directories = []
    for phase in PHASES:
        item = value["phaseConfigurations"][phase]
        demand(_closed(item, ("directory", "configurationRecordSha256", "privateConfigurationSha256"))
            and SHA.fullmatch(item["configurationRecordSha256"]) and SHA.fullmatch(item["privateConfigurationSha256"])
            and item["configurationRecordSha256"] != item["privateConfigurationSha256"],
            "P2_ROTATION_CONFIGURATION_REFERENCE_REQUIRED")
        directory = Path(item["directory"])
        demand(directory.is_absolute() and directory.is_relative_to(ROOT) and directory.resolve() == directory and ".." not in directory.parts and
            not any(parent.is_symlink() for parent in (directory, *directory.parents) if parent.exists()),
            "P2_ROTATION_CONFIGURATION_REFERENCE_REQUIRED")
        directories.append(str(directory))
    demand(len(set(directories[:3])) == 3 and
        value["phaseConfigurations"]["restoration"] == value["phaseConfigurations"][value["restorationPhase"]],
        "P2_ROTATION_RESTORATION_TARGET_REQUIRED")
    return value


def binding(reviewed):
    return _hash(_canonical(reviewed))


def make_plan(bundle, reviewed, source):
    reviewed = validate_reviewed(reviewed)
    source = Path(source)
    demand(source == OPERATOR_ROOT / reviewed["identity"]["sources"]["frontend"] and
        not any(path.is_symlink() for path in (source, *source.parents)) and
        operator_hashes(source) == reviewed["operatorFiles"] and _hash(private_program(source)) == reviewed["programSha256"],
        "P2_ROTATION_OPERATOR_SOURCE_CHANGED")
    candidate = _hash(_read(Path(bundle), "release.candidate.json"))
    demand(candidate == reviewed["identity"]["candidateSha256"], "P2_ROTATION_CANDIDATE_CHANGED")
    return {"version": 1, "status": "P2_IDENTITY_KEY_ROTATION_PLAN", "environment": "staging", "actionId": reviewed["actionId"],
        "bindingSha256": binding(reviewed), "candidateSha256": candidate, "hostMachineId": reviewed["identity"]["hostMachineId"],
        "sourceCommit": reviewed["identity"]["sources"]["frontend"], "configurationRecordSha256":
            {phase: reviewed["phaseConfigurations"][phase]["configurationRecordSha256"] for phase in PHASES},
        "restorationPhase": reviewed["restorationPhase"], "profiles": list(PROFILES),
        "evidenceClasses": {"course-learner": "actual-protected-course-http", "course-admin": "actual-protected-course-http",
            "community-member": "deployed-private-community-verifier", "community-admin": "deployed-private-community-verifier"},
        "stages": ["api-overlap", "frontend-overlap", "overlap-drain-330-seconds", "frontend-current-only", "api-current-only",
            "four-profile-removal-proof", "qualified-restoration-readiness"],
        "parentAdapterReady": PARENT_ADAPTER_READY, "liveEligible": False, "keyRemovalVerified": False,
        "communityMemberFeatureAdded": False, "newPublicEndpoint": False, "sqlAuthorized": False, "rolesAuthorized": False,
        "loginChangeAuthorized": False, "providerCalled": False, "credentialValuesRead": False, "credentialHashesOutput": False,
        "releaseAccepted": False}


def execute(bundle, reviewed, source, operation):
    demand(operation == "plan", "P2_ROTATION_PARENT_ADAPTER_REQUIRED")
    bundle, source = Path(bundle), Path(source)
    demand(bundle.is_absolute() and bundle.is_relative_to(ROOT) and bundle.resolve() == bundle and
        not any(path.is_symlink() for path in (bundle, *bundle.parents)), "P2_ROTATION_STAGING_BUNDLE_REQUIRED")
    staging_state.outside_checkout(bundle)
    return make_plan(bundle, reviewed, source)


def main():
    try:
        raw = sys.stdin.buffer.read(1_048_577)
        demand(0 < len(raw) <= 1_048_576, "P2_ROTATION_PACKET_BOUND")
        value = json.loads(raw)
        demand(_closed(value, ("version", "operation", "bundleDirectory", "reviewed")) and value["version"] == 1,
            "P2_ROTATION_PACKET_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        result = execute(value["bundleDirectory"], value["reviewed"], source, value["operation"])
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except BaseException as error:
        result = error.public_receipt if isinstance(error, RotationPlanFailure) else {
            "version": 1, "status": "P2_IDENTITY_KEY_ROTATION_REFUSED", "check": "fixed-plan-refused",
            "parentAdapterReady": False, "keyRemovalVerified": False, "tokenBytesOutput": False,
            "credentialHashesOutput": False, "releaseAccepted": False}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
