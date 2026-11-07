"""Pinned staging S13 authority timing controller.

The controller has no arbitrary URL, endpoint, command, clock, token, key or
output-path input. Capture privately retains short-lived credentials only until
finalization; common stdout never contains credential bytes or their digests.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate
import release as runtime
import staging_state
import p2_identity_negative_probe as identity
from p2_lifecycle_authority_timing_scope import CurrentAuthorityTimingScope

ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
TIMING = "ops/platform/p2-lifecycle-authority-timing.mjs"
IDENTITY = "ops/platform/p2-identity-negative-probe.mjs"
FILES = (TIMING, "ops/platform/p2-lifecycle-authority-timing.test.mjs",
    "ops/platform/host/p2_lifecycle_authority_timing_scope.py", "ops/platform/host/p2_lifecycle_authority_timing.py",
    "ops/platform/host/p2_lifecycle_authority_timing_test.py", "ops/platform/p2-lifecycle-authority-timing.md")
AUTHORITY_ADAPTERS_READY = False
SHA = re.compile(r"^[a-f0-9]{64}$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
demand = migrate.demand


class AuthorityTimingFailure(Exception):
    def __init__(self, check="authority-timing-refused"):
        super().__init__("P2_S13_AUTHORITY_TIMING_REFUSED")
        self.public_receipt = {"version": 1, "status": "P2_S13_AUTHORITY_TIMING_REFUSED", "check": check,
            "tokenBytesOutput": False, "credentialHashesOutput": False, "releaseAccepted": False}


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
    timing = _read(source, TIMING, 131_072).decode().replace(
        "./p2-identity-negative-probe.mjs", "data:text/javascript;base64," + identity_module)
    timing_module = base64.b64encode(timing.encode()).decode()
    return (f'import("data:text/javascript;base64,{timing_module}")'
        '.then(module=>module.runPrivateAuthorityTimingFromStdin())'
        '.catch(()=>{process.stdout.write(JSON.stringify({version:1,status:"P2_S13_PRIVATE_REFUSED",check:"private-observation-failed",readOnlyObservation:true,releaseAccepted:false})+"\\n");process.exitCode=1})').encode()


def validate_reviewed(value):
    fields = ("version", "environment", "actionId", "identity", "fixture", "privateDirectory", "operatorFiles", "programSha256",
        "browserObserverSourceSha256", "pendingObserverSourceSha256", "lifecycleWitnessSourceSha256", "s12SourceSha256")
    demand(_closed(value, fields) and value["version"] == 1 and value["environment"] == "staging" and
        isinstance(value["actionId"], str) and re.fullmatch(r"p2-s13-[a-z0-9-]{1,48}", value["actionId"]),
        "P2_S13_REVIEWED_INPUT_REQUIRED")
    identity.validate_reviewed(value["identity"])
    demand(_closed(value["fixture"], ("courseId", "lessonId", "freeGrantReceiptSha256")) and
        UUID.fullmatch(value["fixture"]["courseId"]) and UUID.fullmatch(value["fixture"]["lessonId"]) and
        value["fixture"]["courseId"] != value["fixture"]["lessonId"] and SHA.fullmatch(value["fixture"]["freeGrantReceiptSha256"]),
        "P2_S13_OWNED_FREE_GRANT_FIXTURE_REQUIRED")
    demand(_closed(value["operatorFiles"], FILES) and all(SHA.fullmatch(item) for item in value["operatorFiles"].values()) and
        SHA.fullmatch(value["programSha256"]) and all(SHA.fullmatch(value[name]) for name in
            ("browserObserverSourceSha256", "pendingObserverSourceSha256", "lifecycleWitnessSourceSha256", "s12SourceSha256")),
        "P2_S13_SOURCE_BINDING_REQUIRED")
    directory = Path(value["privateDirectory"])
    demand(directory.is_absolute() and directory.is_relative_to(ROOT) and directory.name == value["actionId"] and
        ".." not in directory.parts and not any(path.is_symlink() for path in directory.parents if path.exists()),
        "P2_S13_PRIVATE_DIRECTORY_REQUIRED")
    return value


def make_plan(bundle, configuration, reviewed, source):
    reviewed = validate_reviewed(reviewed)
    demand(Path(source) == OPERATOR_ROOT / reviewed["identity"]["sources"]["frontend"] and
        operator_hashes(source) == reviewed["operatorFiles"] and _hash(private_program(source)) == reviewed["programSha256"],
        "P2_S13_OPERATOR_SOURCE_CHANGED")
    identity_plan, selected, jobs, runtime_plan = identity.make_plan(bundle, configuration, reviewed["identity"], source)
    return {"version": 1, "status": "P2_S13_AUTHORITY_TIMING_PLAN", "environment": "staging", "actionId": reviewed["actionId"],
        "candidateSha256": identity_plan["candidateSha256"], "configurationSha256": identity_plan["configurationSha256"],
        "sources": identity_plan["sources"], "programSha256": reviewed["programSha256"],
        "evidenceSources": {name: reviewed[name] for name in
            ("browserObserverSourceSha256", "pendingObserverSourceSha256", "lifecycleWitnessSourceSha256", "s12SourceSha256")},
        "operations": ["capture", "observe-user", "observe-playback", "finalize"],
        "userProfile": "operator-controlled-source-signed-course-learner", "frontendUserJwtCaptured": False,
        "actualCoursePlaybackGet": True, "actualMuxProviderRead": True, "newPublicEndpoint": False,
        "authorizationQuotaImpact": "owned-learner-low-frequency", "businessDomainStateChanged": False,
        "playbackCleanupFenceExtended": True, "credentialsRead": False, "networkCalled": False,
        "businessMutationsAuthorized": False, "playbackCleanupFenceWriteAuthorized": True,
        "authorityAdaptersReady": AUTHORITY_ADAPTERS_READY, "liveEligible": False, "releaseAccepted": False}, selected, jobs, runtime_plan


def _private_directory(reviewed, create=False):
    directory = Path(reviewed["privateDirectory"])
    parent = directory.parent
    demand(parent.is_dir() and not parent.is_symlink() and parent.stat().st_uid == os.getuid() and
        stat.S_IMODE(parent.stat().st_mode) == 0o700, "P2_S13_PRIVATE_PARENT_REQUIRED")
    if create:
        directory.mkdir(mode=0o700, exist_ok=False)
    demand(directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == os.getuid() and
        stat.S_IMODE(directory.stat().st_mode) == 0o700, "P2_S13_PRIVATE_DIRECTORY_MODE")
    return directory


def _retain(directory, name, value):
    path = directory / name
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        body = _canonical(value) + b"\n"
        written = 0
        while written < len(body):
            count = os.write(descriptor, body[written:])
            demand(count > 0, "P2_S13_PRIVATE_RECORD_WRITE")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return path


def _read_private(directory, name):
    path = directory / name
    info = path.lstat()
    demand(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid() and
        stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 65_536, "P2_S13_PRIVATE_RECORD_REQUIRED")
    return json.loads(path.read_bytes())


def _capture_record(directory, reviewed):
    value = _read_private(directory, "capture.json")
    demand(_closed(value, ("version", "actionId", "bindingSha256", "candidateSha256", "configurationSha256", "capture")) and
        value["version"] == 1 and value["actionId"] == reviewed["actionId"] and value["bindingSha256"] == _binding(reviewed) and
        value["candidateSha256"] == reviewed["identity"]["candidateSha256"] and
        value["configurationSha256"] == reviewed["identity"]["configurationSha256"] and isinstance(value["capture"], dict) and
        value["capture"].get("bindingSha256") == _binding(reviewed), "P2_S13_CAPTURE_RECORD_BINDING_REQUIRED")
    return value["capture"]


def _window_record(directory, reviewed, name, status):
    value = _read_private(directory, name)
    demand(_closed(value, ("version", "status", "actionId", "bindingSha256", "candidateSha256", "configurationSha256", "suspension", "window")) and
        value["version"] == 1 and value["status"] == status and value["actionId"] == reviewed["actionId"] and
        value["bindingSha256"] == _binding(reviewed) and value["candidateSha256"] == reviewed["identity"]["candidateSha256"] and
        value["configurationSha256"] == reviewed["identity"]["configurationSha256"] and
        isinstance(value["suspension"], dict) and isinstance(value["window"], dict), "P2_S13_WINDOW_RECORD_BINDING_REQUIRED")
    return value


def _public_http(value):
    fields = ("status", "serverDate", "requestStartedAt", "responseEndedAt", "elapsedMs", "requestId")
    demand(_closed(value, fields), "P2_S13_HTTP_OBSERVATION_REQUIRED")
    return {name: value[name] for name in fields}


def _capture_public(capture):
    return {"controlledUser": {"iat": capture["controlledUser"]["iat"], "exp": capture["controlledUser"]["exp"],
        "baseline": _public_http(capture["controlledUser"]["baseline"])},
        "playback": {"exp": capture["playback"]["exp"], "courseAuthorization": _public_http(capture["playback"]["courseAuthorization"]),
            "initialProviderAccess": _public_http(capture["playback"]["initialProviderAccess"])}, "labels": capture["labels"]}


def _phase_check(scope, phase):
    scope.verify()
    bundle, configuration, reviewed, source, selected, jobs = phase
    fresh, fresh_selected, fresh_jobs, _runtime = make_plan(bundle, configuration, reviewed, source)
    demand(fresh["candidateSha256"] == reviewed["identity"]["candidateSha256"] and
        fresh_selected == selected and fresh_jobs == jobs, "P2_S13_RELEASE_CHANGED")
    identity._containers(selected, Path(configuration), reviewed["identity"], scope)
    gateway = next(row for row in reviewed["identity"]["containers"] if row["service"] == "gateway")
    identity._one_container(gateway, Path(configuration), scope)
    scope.verify()


def _child(scope, payload, expected, phase=None):
    if phase is not None:
        _phase_check(scope, phase)
    else:
        scope.verify()
    result = scope.run_s13(payload)
    scope.verify()
    if phase is not None:
        _phase_check(scope, phase)
    demand(len(result.stdout) <= 65_536 and not result.stderr, "P2_S13_PRIVATE_CHILD_REFUSED")
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError, UnicodeError):
        raise ValueError("P2_S13_PRIVATE_CHILD_REFUSED") from None
    demand(result.returncode == 0 and value.get("status") == expected, "P2_S13_PRIVATE_CHILD_REFUSED")
    return value


def _wait_until(scope, target_ms):
    while time.time() * 1000 < target_ms:
        scope.verify()
        remaining = target_ms - time.time() * 1000
        time.sleep(max(0.001, min(1.0, remaining / 1000)))
    scope.verify()


def _scope(bundle, configuration, reviewed, source):
    plan, selected, jobs, runtime_plan = make_plan(bundle, configuration, reviewed, source)
    runtime.assert_host(runtime_plan)
    program = private_program(source)
    candidate = _hash(_read(Path(bundle), "release.candidate.json"))
    def verify_inputs():
        demand(Path("/etc/machine-id").read_text().strip() == reviewed["identity"]["hostMachineId"],
            "P2_S13_SELECTED_HOST_CHANGED")
        demand(operator_hashes(source) == reviewed["operatorFiles"] and private_program(source) == program,
            "P2_S13_OPERATOR_SOURCE_CHANGED")
        demand(identity._configuration_hash(Path(configuration)) == reviewed["identity"]["configurationSha256"],
            "P2_S13_CONFIGURATION_CHANGED")
        demand(_hash(_read(Path(bundle), "release.candidate.json")) == candidate == reviewed["identity"]["candidateSha256"],
            "P2_S13_RELEASE_CHANGED")
    scope = CurrentAuthorityTimingScope(selected, reviewed["identity"], configuration, program, verify_inputs)
    identity._containers(selected, Path(configuration), reviewed["identity"], scope)
    keys, _service_keys, _environments = identity._keys(Path(configuration), jobs, reviewed["identity"], scope)
    return plan, scope, keys, (Path(bundle), Path(configuration), reviewed, Path(source), selected, jobs)


def _binding(reviewed):
    # Excludes the private directory path but binds exact source, release,
    # fixture subjects/resources and witness implementation.
    return _hash(_canonical({name: reviewed[name] for name in ("actionId", "identity", "fixture", "operatorFiles", "programSha256",
        "browserObserverSourceSha256", "pendingObserverSourceSha256", "lifecycleWitnessSourceSha256", "s12SourceSha256")}))


def _capture(bundle, configuration, reviewed, source):
    directory = _private_directory(reviewed, create=True)
    plan, scope, keys, phase = _scope(bundle, configuration, reviewed, source)
    try:
        identity_reviewed = reviewed["identity"]
        payload = {"version": 1, "mode": "s13-capture", "environment": "staging", "bindingSha256": _binding(reviewed),
            "subject": identity_reviewed["subjects"]["learnerA"], "courseId": reviewed["fixture"]["courseId"],
            "lessonId": reviewed["fixture"]["lessonId"], "currentKey": keys["course-learner"]["current"],
            "gatewayCaSha256": _hash(_read(Path(configuration), "tls/gateway/ca.pem", 65_536))}
        capture = _child(scope, payload, "P2_S13_PRIVATE_CAPTURED", phase)
        demand(capture.get("bindingSha256") == _binding(reviewed), "P2_S13_CAPTURE_BINDING_REQUIRED")
        _retain(directory, "capture.json", {"version": 1, "actionId": reviewed["actionId"], "bindingSha256": _binding(reviewed),
            "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"], "capture": capture})
        result = {"version": 1, "status": "P2_S13_CAPTURE_ARMED", "environment": "staging", "actionId": reviewed["actionId"],
            "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"], "bindingSha256": _binding(reviewed),
            "capturePublic": _capture_public(capture), "controlledUserIssuer": "operator-controlled-source-signed-course-learner",
            "frontendUserJwtCaptured": False, "privateCredentialRetained": True, "credentialHashOutput": False,
            "authorizationQuotaConsumed": True, "businessDomainStateChanged": False, "playbackCleanupFenceExtended": True,
            "releaseAccepted": False}
        return result
    finally:
        if not scope.closed:
            scope.close()
        keys = None


def _validate_suspension(value):
    demand(_closed(value, ("commandId", "accountVersion", "issuedAt", "requestId", "httpStatus")) and
        UUID.fullmatch(value["commandId"]) and isinstance(value["accountVersion"], int) and value["accountVersion"] >= 1 and
        ISO.fullmatch(value["issuedAt"]) and isinstance(value["requestId"], str) and value["httpStatus"] == 202,
        "P2_S13_SUSPENSION_RECEIPT_REQUIRED")
    return value


def _observe_user(bundle, configuration, reviewed, source, private):
    demand(_closed(private, ("suspension",)) and _validate_suspension(private["suspension"]), "P2_S13_USER_INPUT_REQUIRED")
    directory = _private_directory(reviewed)
    capture = _capture_record(directory, reviewed)
    plan, scope, _keys, phase = _scope(bundle, configuration, reviewed, source)
    try:
        controlled = capture["controlledUser"]
        boundary = controlled["exp"] * 1000 + 30_000
        demand(time.time() * 1000 <= boundary - 3_000 and boundary - time.time() * 1000 <= 330_000,
            "P2_S13_USER_WINDOW_UNAVAILABLE")
        base = {"version": 1, "mode": "s13-user-observe", "environment": "staging", "bindingSha256": _binding(reviewed),
            "subject": reviewed["identity"]["subjects"]["learnerA"], "courseId": reviewed["fixture"]["courseId"],
            "userToken": controlled["token"], "iat": controlled["iat"], "exp": controlled["exp"],
            "gatewayCaSha256": _hash(_read(Path(configuration), "tls/gateway/ca.pem", 65_536))}
        _phase_check(scope, phase)
        _wait_until(scope, boundary - 1_500)
        accepted = _child(scope, base, "P2_S13_PRIVATE_USER_OBSERVED", phase)["observation"]
        demand(accepted["status"] == 200, "P2_S13_USER_NOT_ACCEPTED_BEFORE_BOUNDARY")
        _wait_until(scope, boundary)
        denied = _child(scope, base, "P2_S13_PRIVATE_USER_OBSERVED", phase)["observation"]
        demand(denied["status"] == 401, "P2_S13_USER_NOT_DENIED_AT_BOUNDARY")
        resolution = max(1, int(round((time.time() * 1000) - boundary)))
        demand(resolution <= 2_000, "P2_S13_USER_POLL_RESOLUTION")
        _phase_check(scope, phase)
        record = {"version": 1, "status": "P2_S13_PRIVATE_USER_WINDOW", "actionId": reviewed["actionId"],
            "bindingSha256": _binding(reviewed), "candidateSha256": plan["candidateSha256"],
            "configurationSha256": plan["configurationSha256"], "suspension": private["suspension"],
            "window": {"lastAccepted": accepted, "firstDenied": denied, "pollResolutionMs": resolution}}
        path = _retain(directory, "user-window.json", record)
        return {"version": 1, "status": "P2_S13_USER_WINDOW_OBSERVED", "environment": "staging", "actionId": reviewed["actionId"],
            "bindingSha256": _binding(reviewed), "lastAccepted": _public_http(accepted), "firstDenied": _public_http(denied),
            "pollResolutionMs": resolution, "observationRecordSha256": _hash(path.read_bytes()), "pendingStateRequired": True,
            "workerInvocationAuthorized": False, "releaseAccepted": False}
    finally:
        if not scope.closed:
            scope.close()


def _observe_playback(bundle, configuration, reviewed, source, private):
    demand(_closed(private, ("s12ReceiptSha256", "lifecycleWitnessSha256")) and
        SHA.fullmatch(private["s12ReceiptSha256"]) and SHA.fullmatch(private["lifecycleWitnessSha256"]),
        "P2_S13_PLAYBACK_INPUT_REQUIRED")
    directory = _private_directory(reviewed)
    capture = _capture_record(directory, reviewed)
    user_record = _window_record(directory, reviewed, "user-window.json", "P2_S13_PRIVATE_USER_WINDOW")
    plan, scope, _keys, phase = _scope(bundle, configuration, reviewed, source)
    try:
        playback = capture["playback"]
        boundary = playback["exp"] * 1000
        remaining = boundary - time.time() * 1000
        demand(30_000 < remaining <= 540_000, "P2_S13_PLAYBACK_REMAINING_TTL")
        payload = {"version": 1, "mode": "s13-mux-observe", "environment": "staging", "bindingSha256": _binding(reviewed),
            "requestUrl": playback["requestUrl"], "playbackId": playback["playbackId"], "exp": playback["exp"]}
        _phase_check(scope, phase)
        _wait_until(scope, boundary - 1_500)
        accepted = _child(scope, payload, "P2_S13_PRIVATE_MUX_OBSERVED", phase)["observation"]
        demand(accepted["status"] in (200, 206), "P2_S13_MUX_NOT_ACCEPTED_BEFORE_BOUNDARY")
        _wait_until(scope, boundary)
        denied = _child(scope, payload, "P2_S13_PRIVATE_MUX_OBSERVED", phase)["observation"]
        demand(denied["status"] in (401, 403), "P2_S13_MUX_NOT_DENIED_AT_BOUNDARY")
        resolution = max(1, int(round((time.time() * 1000) - boundary)))
        demand(resolution <= 2_000, "P2_S13_MUX_POLL_RESOLUTION")
        _phase_check(scope, phase)
        record = {"version": 1, "status": "P2_S13_PRIVATE_MUX_WINDOW", "actionId": reviewed["actionId"],
            "bindingSha256": _binding(reviewed), "candidateSha256": plan["candidateSha256"],
            "configurationSha256": plan["configurationSha256"], "suspension": user_record["suspension"],
            "window": {"lastAccepted": accepted, "firstDenied": denied, "pollResolutionMs": resolution}}
        path = _retain(directory, "mux-window.json", record)
        return {"version": 1, "status": "P2_S13_PLAYBACK_WINDOW_OBSERVED", "environment": "staging", "actionId": reviewed["actionId"],
            "bindingSha256": _binding(reviewed), "lastAccepted": _public_http(accepted), "firstDenied": _public_http(denied),
            "pollResolutionMs": resolution, "observationRecordSha256": _hash(path.read_bytes()), "actualMuxProviderRead": True,
            "credentialHashOutput": False, "releaseAccepted": False}
    finally:
        if not scope.closed:
            scope.close()


def _finalize(bundle, configuration, reviewed, source, private):
    if not AUTHORITY_ADAPTERS_READY:
        raise AuthorityTimingFailure("source-authoritative-artifact-adapters-required")
    demand(_closed(private, ("pending", "browser", "lifecycle", "s12")), "P2_S13_FINAL_INPUT_REQUIRED")
    directory = _private_directory(reviewed)
    capture_path = directory / "capture.json"
    capture = _read_private(directory, "capture.json")["capture"]
    user = _read_private(directory, "user-window.json")
    mux = _read_private(directory, "mux-window.json")
    demand(user["suspension"] == private["browser"].get("suspension") and
        mux["s12ReceiptSha256"] == private["s12"].get("receiptSha256") and
        mux["lifecycleWitnessSha256"] == private["lifecycle"].get("witnessSha256") and
        private["pending"].get("configurationSha256") == reviewed["identity"]["configurationSha256"] and
        private["pending"].get("sourceSha256") == reviewed["pendingObserverSourceSha256"] and
        private["browser"].get("sourceSha256") == reviewed["browserObserverSourceSha256"] and
        private["lifecycle"].get("operatorProgramSha256") == reviewed["lifecycleWitnessSourceSha256"] and
        private["s12"].get("sourceSha256") == reviewed["s12SourceSha256"] and
        private["lifecycle"].get("configurationSha256") == reviewed["identity"]["configurationSha256"] and
        private["lifecycle"].get("candidateSha256") == reviewed["identity"]["candidateSha256"] and
        private["s12"].get("configurationSha256") == reviewed["identity"]["configurationSha256"],
        "P2_S13_CROSS_PHASE_BINDING")
    qualification = {"version": 1, "environment": "staging", "bindingSha256": _binding(reviewed),
        "capturePublic": _capture_public(capture), "user": user["window"], "mux": mux["window"],
        "pending": private["pending"], "browser": private["browser"], "lifecycle": private["lifecycle"], "s12": private["s12"]}
    plan, scope, _keys, phase = _scope(bundle, configuration, reviewed, source)
    try:
        result = _child(scope, {"version": 1, "mode": "s13-qualify", "environment": "staging", "qualification": qualification},
            "P2_S13_AUTHORITY_TIMING_QUALIFIED", phase)
        final_path = _retain(directory, "final.json", {"version": 1, "actionId": reviewed["actionId"], "qualification": qualification, "receipt": result})
        # The expiring JWT and Mux URL are no longer needed. Unlinking is not a
        # secure-erasure claim; both credentials have already expired.
        capture_path.unlink()
        result.update({"actionId": reviewed["actionId"], "candidateSha256": plan["candidateSha256"],
            "configurationSha256": plan["configurationSha256"], "finalRecordSha256": _hash(final_path.read_bytes()),
            "privateCredentialFileRemoved": True, "secureEraseClaimed": False})
        return result
    finally:
        if not scope.closed:
            scope.close()


def execute(bundle, configuration, reviewed, source, operation, private):
    reviewed = validate_reviewed(reviewed)
    bundle, configuration, source = Path(bundle), Path(configuration), Path(source)
    demand(source == OPERATOR_ROOT / reviewed["identity"]["sources"]["frontend"] and
        not any(path.is_symlink() for path in (source, *source.parents)), "P2_S13_PINNED_SOURCE_REQUIRED")
    for path in (bundle, configuration):
        demand(path.is_absolute() and path.is_relative_to(ROOT) and path.resolve() == path and ".." not in path.parts and
            not any(item.is_symlink() for item in (path, *path.parents)), "P2_S13_STAGING_PATH_REQUIRED")
        staging_state.outside_checkout(path)
    if operation == "plan":
        demand(private is None, "P2_S13_PLAN_PRIVATE_INPUT")
        return make_plan(bundle, configuration, reviewed, source)[0]
    if not AUTHORITY_ADAPTERS_READY:
        raise AuthorityTimingFailure("source-authoritative-artifact-adapters-required")
    if operation == "capture":
        demand(private is None, "P2_S13_CAPTURE_PRIVATE_INPUT")
        return _capture(bundle, configuration, reviewed, source)
    if operation == "observe-user":
        return _observe_user(bundle, configuration, reviewed, source, private)
    if operation == "observe-playback":
        return _observe_playback(bundle, configuration, reviewed, source, private)
    if operation == "finalize":
        return _finalize(bundle, configuration, reviewed, source, private)
    raise AuthorityTimingFailure("operation-refused")


def main():
    try:
        raw = sys.stdin.buffer.read(1_048_577)
        demand(0 < len(raw) <= 1_048_576, "P2_S13_PACKET_BOUND")
        value = json.loads(raw)
        demand(_closed(value, ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "private")) and
            value["version"] == 1 and value["operation"] in ("plan", "capture", "observe-user", "observe-playback", "finalize"),
            "P2_S13_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        result = execute(Path(value["bundleDirectory"]), Path(value["configurationDirectory"]), value["reviewed"], source,
            value["operation"], value["private"])
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        return 0
    except BaseException as error:
        if isinstance(error, AuthorityTimingFailure):
            result = error.public_receipt
        else:
            result = {"version": 1, "status": "P2_S13_AUTHORITY_TIMING_REFUSED", "check": "fixed-action-refused",
                "tokenBytesOutput": False, "credentialHashesOutput": False, "releaseAccepted": False}
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
