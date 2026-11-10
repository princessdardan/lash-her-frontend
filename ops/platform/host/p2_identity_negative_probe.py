"""Staging-only read-only S06 observer; CLI is plan-only.

Execution requires the broker's actual process-local release scope. Existing
runtime keys are consumed privately in this process and over child stdin only.
No Secrets Manager/credential-store lookup, public signing endpoint or mutation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

import certificates
import migrate
import release as runtime
import staging_state

demand = migrate.demand
PROGRAM = "ops/platform/p2-identity-negative-probe.mjs"
LAUNCHER = b"\nawait runPrivateProbeFromStdin();\n"
STAGING_ROOT = Path("/var/lib/lash-her/releases/staging")
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
PROFILES = {"course-learner": "COURSE_LEARNER", "course-admin": "COURSE_ADMIN",
    "community-member": "COMMUNITY_MEMBER", "community-admin": "COMMUNITY_ADMIN"}
SERVICES = ("gateway", "course-api", "community-api")
SOURCE_SUFFIXES = frozenset((".py", ".mjs", ".json", ".yaml", ".yml", ".service", ".timer", ".sh", ".guard"))
SOURCE_ANCHORS = frozenset((PROGRAM, "ops/platform/compose.yaml", *("ops/platform/host/" + name for name in (
    "p2_identity_negative_probe.py", "p2_identity_probe_scope.py", "p2_identity_probe_current.py", "certificates.py", "migrate.py",
    "release.py", "staging_state.py", "docker_inspect.py"))))
REPLACEMENT_SOURCE_ANCHORS = SOURCE_ANCHORS | {"ops/platform/host/p2_identity_replacement_provenance.py"}
NEGATIVES = ("missing-token", "wrong-issuer", "wrong-audience", "array-audience", "wrong-profile", "invalid-subject", "uppercase-subject",
    "invalid-jti", "wrong-version", "overlong-lifetime", "nonpositive-lifetime", "expired-outside-skew", "future-iat-outside-skew", "fractional-iat", "extra-pii-claim",
    "wrong-signature", "cross-profile-key", "cross-service-key", "wrong-algorithm", "unsigned-token", "missing-iss", "missing-aud", "missing-sub",
    "missing-iat", "missing-exp", "missing-jti", "missing-version")
SERVICE_KEYS = {
    "course": ("INTERNAL_SERVICE_JWT_SECRET", "COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COURSE_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET",
        "COURSE_COMMUNITY_READ_JWT_CURRENT_SECRET", "COURSE_COMMUNITY_READ_JWT_PREVIOUS_SECRET", "COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET"),
    "community": ("COURSE_PUBLISHER_JWT_CURRENT_SECRET", "COURSE_PUBLISHER_JWT_PREVIOUS_SECRET", "COMMUNITY_READER_JWT_CURRENT_SECRET",
        "COMMUNITY_READER_JWT_PREVIOUS_SECRET", "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET"),
}
REVIEW_FIELDS = ("version", "environment", "probeId", "releaseId", "candidateSha256", "hostMachineId", "configurationSha256",
    "sources", "containers", "subjects", "resources", "programSha256", "previousProfiles", "operatorSourceFiles", "operatorSourceSha256", "priorEvidence")
REPLACEMENT_FIELDS = ("targetSha256", "apiJobSha256", "runtimeInventorySha256", "gatewayProcessSha256",
    "replacementRelease", "successorRuntime")


class NegativeProbeFailure(ValueError):
    """Caller may persist public_receipt; the exception text is always fixed."""
    def __init__(self, check="private-probe-failed", mode=None):
        super().__init__("P2_IDENTITY_NEGATIVE_PROBE_FAILED")
        self.public_receipt = {"version": 1, "status": "P2_STAGING_IDENTITY_NEGATIVE_PROBES_FAILED", "check": check,
            "readOnly": True, "oidcVerified": False, "releaseAccepted": False}
        if mode in ("course-verifier", "community-verifier", "course-http-plan", "course-http"):
            self.public_receipt["scope"] = mode


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def _digest(value, length=64):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", value) and value != "0" * length


def _closed(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def validate_reviewed(value, *, expected_profile=None):
    profiled = expected_profile is not None
    fields = (*REVIEW_FIELDS, "qualificationTargetProfile", *REPLACEMENT_FIELDS) if profiled else REVIEW_FIELDS
    demand(_closed(value, fields) and type(value["version"]) is int and value["version"] == (2 if profiled else 1)
        and value["environment"] == "staging", "P2_IDENTITY_REVIEWED_SCOPE_REQUIRED")
    if profiled:
        from p2_certification_parent import _profiled_context, require_certification_replacement_release
        from p2_replacement_successor import BINDING_FIELDS
        demand(expected_profile == _profiled_context() and value["qualificationTargetProfile"] == expected_profile,
            "P2_IDENTITY_REPLACEMENT_PROFILE_REQUIRED")
        demand(all(_digest(value[name]) for name in ("targetSha256", "runtimeInventorySha256", "gatewayProcessSha256"))
            and _closed(value["apiJobSha256"], ("course", "community"))
            and all(_digest(item) for item in value["apiJobSha256"].values()), "P2_IDENTITY_EXACT_BINDINGS_REQUIRED")
        require_certification_replacement_release(value["replacementRelease"], expected_profile)
        successor = value["successorRuntime"]
        if successor is not None:
            demand(_closed(successor, BINDING_FIELDS) and successor["kind"] in ("known-ack", "interrupted-known-ack")
                and all(isinstance(successor[name], str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", successor[name])
                    for name in ("actionId", "runtimeActionId")) and _digest(successor["receiptSha256"])
                and (successor["actionId"] == successor["runtimeActionId"]) is (successor["kind"] == "interrupted-known-ack"),
                "P2_IDENTITY_REPLACEMENT_SUCCESSOR_REQUIRED")
    demand(all(isinstance(value[name], str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value[name]) for name in ("probeId", "releaseId")),
        "P2_IDENTITY_ACTION_ID_REQUIRED")
    demand(all(_digest(value[name]) for name in ("candidateSha256", "configurationSha256", "programSha256")) and
        _digest(value["hostMachineId"], 32), "P2_IDENTITY_EXACT_BINDINGS_REQUIRED")
    anchors = REPLACEMENT_SOURCE_ANCHORS if profiled else SOURCE_ANCHORS
    demand(isinstance(value["operatorSourceFiles"], dict) and 1 <= len(value["operatorSourceFiles"]) <= (544 if profiled else 512) and
        anchors.issubset(value["operatorSourceFiles"]) and all(_source_path(name) and _digest(item) for name, item in value["operatorSourceFiles"].items()) and
        value["operatorSourceSha256"] == _hash(_canonical(value["operatorSourceFiles"])), "P2_IDENTITY_SOURCE_CLOSURE_REQUIRED")
    prior_fields = ("originalReleaseReceiptSha256", "frontendDeploymentRecordSha256")
    if profiled:
        prior_fields += ("originalReleasePlanSha256",)
    demand(_closed(value["priorEvidence"], prior_fields) and
        all(_digest(item) for item in value["priorEvidence"].values()), "P2_IDENTITY_ORIGINAL_EVIDENCE_REFERENCES_REQUIRED")
    if profiled:
        demand(value["priorEvidence"]["originalReleasePlanSha256"] == value["replacementRelease"]["reviewedPlanSha256"],
            "P2_IDENTITY_REPLACEMENT_PLAN_SHA_REQUIRED")
    demand(_closed(value["sources"], ("frontend", "course", "community")) and all(_digest(commit, 40) for commit in value["sources"].values()),
        "P2_IDENTITY_EXACT_SOURCES_REQUIRED")
    demand(_closed(value["subjects"], ("learnerA", "learnerB", "admin")) and
        all(isinstance(item, str) and re.fullmatch(UUID, item) for item in value["subjects"].values()) and len(set(value["subjects"].values())) == 3,
        "P2_IDENTITY_DEDICATED_SUBJECTS_REQUIRED")
    demand(_closed(value["resources"], ("courseA", "courseB", "sharedCourse", "lesson", "completedAttempt")) and
        all(isinstance(item, str) and re.fullmatch(UUID, item) for item in value["resources"].values()) and len(set(value["resources"].values())) == 5,
        "P2_IDENTITY_EXISTING_ENROLLED_ASSESSMENT_RESOURCES_REQUIRED")
    profiles = value["previousProfiles"]
    demand(isinstance(profiles, list) and all(item in PROFILES for item in profiles) and profiles == sorted(set(profiles)),
        "P2_IDENTITY_REVIEWED_KEY_OVERLAP_REQUIRED")
    rows = value["containers"]
    demand(isinstance(rows, list) and len(rows) == 3 and all(_closed(row, ("service", "containerId", "image")) for row in rows) and
        {row["service"] for row in rows} == set(SERVICES) and all(_digest(row["containerId"]) for row in rows) and
        len({row["containerId"] for row in rows}) == 3, "P2_IDENTITY_REVIEWED_CONTAINERS_REQUIRED")
    for row in rows:
        suffix = {"gateway": "gateway", "course-api": "course-runtime", "community-api": "community-runtime"}[row["service"]]
        prefix = "ghcr.io/princessdardan/lash-her-platform-" + suffix + "@"
        demand(isinstance(row["image"], str) and row["image"].startswith(prefix) and migrate.digest(row["image"][len(prefix):]),
            "P2_IDENTITY_IMMUTABLE_IMAGE_REQUIRED")
    return value


def program_bytes(operator_source=None):
    source = Path(operator_source) if operator_source is not None else Path(__file__).resolve().parents[3]
    return migrate.read_input(source, PROGRAM, 65_536) + LAUNCHER


def _source_path(name):
    return (isinstance(name, str) and name.startswith("ops/") and len(name) <= 250 and ".." not in Path(name).parts and
        not name.startswith("ops/platform/evidence/") and Path(name).suffix in SOURCE_SUFFIXES and re.fullmatch(r"[A-Za-z0-9_./-]+", name))


def source_closure(source, *, expected_profile=None):
    # Conservative closure, including lazy/dynamic local imports: every public
    # operator code/config file installed from the exact committed ops tree.
    # Evidence records are never imported/executed by this fixed observer.
    source = Path(source)
    entries = list((source / "ops").rglob("*"))
    demand(not any(file.is_symlink() for file in entries), "P2_IDENTITY_OPERATOR_SYMLINK_REFUSED")
    paths = sorted(file.relative_to(source).as_posix() for file in entries if file.is_file() and
        file.suffix in SOURCE_SUFFIXES and not file.relative_to(source).as_posix().startswith("ops/platform/evidence/") and
        (expected_profile is None or not file.name.endswith((".test.mjs", "_test.py"))))
    limit = 512 if expected_profile is None else 544
    anchors = SOURCE_ANCHORS if expected_profile is None else REPLACEMENT_SOURCE_ANCHORS
    demand(1 <= len(paths) <= limit and anchors.issubset(paths) and all(_source_path(name) for name in paths), "P2_IDENTITY_SOURCE_CLOSURE_REQUIRED")
    return {name: _hash(migrate.read_input(source, name)) for name in paths}


def _replacement_bindings(reviewed, expected_profile):
    if expected_profile is None:
        return {}
    return {"version": 2, "qualificationTargetProfile": expected_profile,
        **{name: reviewed[name] for name in REPLACEMENT_FIELDS}}


def make_plan(bundle, configuration, reviewed, operator_source=None, *, expected_profile=None):
    validate_reviewed(reviewed, expected_profile=expected_profile)
    source = Path(operator_source) if operator_source is not None else Path(__file__).resolve().parents[3]
    profile = {} if expected_profile is None else {"expected_profile": expected_profile}
    demand(source_closure(source, **profile) == reviewed["operatorSourceFiles"], "P2_IDENTITY_OPERATOR_SOURCE_CHANGED")
    selected, jobs, plan, _compose = runtime.make_plan(Path(bundle), Path(configuration), source / "ops/platform/compose.yaml", **profile)
    demand(selected.get("environment") == "staging" and selected.get("contractPhase") == "p2" and
        set(jobs) == {"frontend", "course", "community"} and
        plan["publicHost"] == certificates.HOST and plan["hostMachineId"] == reviewed["hostMachineId"] and
        selected["releaseId"] == reviewed["releaseId"] and all(selected["sources"][name]["commit"] == commit for name, commit in reviewed["sources"].items()),
        "P2_IDENTITY_SELECTED_STAGING_RELEASE_REQUIRED")
    demand(_hash(migrate.read_input(Path(bundle), "release.candidate.json")) == reviewed["candidateSha256"], "P2_IDENTITY_CANDIDATE_BYTES_CHANGED")
    if expected_profile is not None:
        from p2_certification_parent import frontend_target_sha256
        demand(migrate.profiled_current_job_hashes(Path(bundle)) == reviewed["apiJobSha256"],
            "P2_IDENTITY_API_JOB_BYTES_CHANGED")
        demand(frontend_target_sha256(jobs["frontend"]["job"]["target"]) == reviewed["targetSha256"],
            "P2_IDENTITY_REPLACEMENT_TARGET_CHANGED")
    for row in reviewed["containers"]:
        demand(row["image"] == selected["artifacts"][runtime.IMAGE_KEYS[row["service"]]]["image"], "P2_IDENTITY_SELECTED_IMAGE_REQUIRED")
    demand(_hash(program_bytes(source)) == reviewed["programSha256"], "P2_IDENTITY_OPERATOR_PROGRAM_CHANGED")
    return {"version": 1, "status": "P2_IDENTITY_NEGATIVE_PROBE_PLAN", "environment": "staging", "probeId": reviewed["probeId"],
        "releaseId": reviewed["releaseId"], "candidateSha256": reviewed["candidateSha256"], "hostMachineId": reviewed["hostMachineId"],
        "sources": reviewed["sources"], "programSha256": reviewed["programSha256"], "configurationSha256": reviewed["configurationSha256"],
        "operatorSourceSha256": reviewed["operatorSourceSha256"], "priorEvidence": reviewed["priorEvidence"], "frontendSqlVerified": False,
        "prerequisites": ["existing-active-test-subjects", "published-course-a-only-enrolled-by-a", "published-course-b-only-enrolled-by-b",
            "shared-published-course-enrolled-by-a-and-b", "actual-completed-attempt-owned-by-a-on-shared-lesson", "configured-current-user-profile-keys"],
        "credentialsRead": False, "networkCalled": False, "readOnly": True, "oidcVerified": False, "releaseAccepted": False,
        **_replacement_bindings(reviewed, expected_profile)}, selected, jobs, plan


def _guard(lease, work):
    lease.verify()
    try:
        return work()
    finally:
        lease.verify()


def _configuration_hash(configuration, lease=None):
    hashes = {name: _hash(migrate.read_input(configuration, name, 65_536) if lease is None else
        _guard(lease, lambda name=name: migrate.read_input(configuration, name, 65_536)))
        for name in staging_state.CONFIGURATION_FILES}
    return _hash(_canonical(hashes))


def _keys(configuration, jobs, reviewed, lease):
    expected_profile = reviewed.get("qualificationTargetProfile")
    profile = {} if expected_profile is None else {"expected_profile": expected_profile}
    values = {}
    for service in ("course", "community"):
        file = configuration / (service + "-api.env")
        info = _guard(lease, file.stat)
        demand(info.st_uid == os.getuid() and not info.st_mode & 0o077, "P2_IDENTITY_PRIVATE_RUNTIME_FILE_REQUIRED")
        raw = _guard(lease, lambda file=file: migrate.read_input(configuration, file.name, 65_536))
        values[service] = _guard(lease, lambda raw=raw, service=service: runtime.environment_values(raw, "staging", service + "-api", jobs, **profile))
    keys = {}
    for profile, prefix in PROFILES.items():
        environment = values[profile.split("-")[0]]
        current, previous = environment.get(prefix + "_JWT_CURRENT_SECRET"), environment.get(prefix + "_JWT_PREVIOUS_SECRET")
        demand(isinstance(current, str) and 32 <= len(current.encode()) <= 8192, "P2_IDENTITY_VALID_PROFILE_BASELINE_UNCONFIGURED")
        demand((previous is not None) == (profile in reviewed["previousProfiles"]), "P2_IDENTITY_KEY_OVERLAP_CHANGED")
        keys[profile] = {"current": current, **({"previous": previous} if previous is not None else {})}
    service_keys = [environment[name] for service, environment in values.items() for name in SERVICE_KEYS[service] if environment.get(name)]
    service_keys += [item.strip() for item in values["course"].get("INTERNAL_SERVICE_JWT_SECRETS", "").split(",") if item.strip()]
    service_keys = sorted(set(service_keys))
    demand(service_keys and all(isinstance(item, str) and 32 <= len(item.encode()) <= 8192 for item in service_keys), "P2_IDENTITY_SERVICE_KEYS_REQUIRED")
    return keys, service_keys, values


def _containers(selected, configuration, reviewed, lease):
    from p2_identity_probe_scope import CurrentIdentityProbeScope
    actual = _guard(lease, lambda: lease.inventory(selected, configuration) if isinstance(lease, CurrentIdentityProbeScope) else
        runtime.check_containers(selected, configuration))
    fixed = [{key: row[key] for key in ("service", "containerId", "image")} for row in actual if row["service"] in SERVICES]
    demand(sorted(fixed, key=lambda row: row["service"]) == sorted(reviewed["containers"], key=lambda row: row["service"]),
        "P2_IDENTITY_RUNNING_CONTAINER_CHANGED")
    return actual


def _one_container(container, configuration, lease):
    from p2_identity_probe_scope import ReplacementIdentityProbeScope
    fields = '{{.Config.Image}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
    value = lease.run(["docker", "inspect", "--format", fields, container["containerId"]], env=runtime.SAFE_ENV,
        capture_output=True, timeout=15)
    demand(value.returncode == 0 and value.stdout.strip() == (container["image"] + "|true|healthy|lash-her-staging|" + container["service"]).encode(),
        "P2_IDENTITY_RUNNING_CONTAINER_CHANGED")
    security = lease.run(["docker", "inspect", "--format", '{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}', container["containerId"]],
        env=runtime.SAFE_ENV, capture_output=True, timeout=15)
    demand(security.returncode == 0 and len(security.stdout) <= 8192 and security.stdout.startswith(b"true|"), "P2_IDENTITY_IMMUTABLE_CONTAINER_REQUIRED")
    try:
        mounts = json.loads(security.stdout.split(b"|", 1)[1])
    except (ValueError, TypeError):
        raise ValueError("P2_IDENTITY_CONTAINER_MOUNTS_REFUSED") from None
    expected = {"/config/gateway.json": configuration / "gateway.json", "/admission": configuration / "admission", "/tls": configuration / "tls/gateway"} \
        if container["service"] == "gateway" else {}
    if isinstance(lease, ReplacementIdentityProbeScope):
        expected = lease.required_mounts(container["service"])
    demand(isinstance(mounts, list), "P2_IDENTITY_CONTAINER_MOUNTS_REFUSED")
    seen = set()
    for row in mounts:
        destination = row.get("Destination") if isinstance(row, dict) else None
        demand(isinstance(destination, str) and destination not in seen, "P2_IDENTITY_CONTAINER_MOUNTS_REFUSED")
        seen.add(destination)
        if row.get("Type") == "tmpfs" and destination == "/tmp":
            continue
        demand(destination in expected and row.get("Type") == "bind" and row.get("RW") is False and row.get("Source") == str(expected[destination]),
            "P2_IDENTITY_CONTAINER_MOUNTS_REFUSED")
    demand(set(expected).issubset(seen), "P2_IDENTITY_CONTAINER_MOUNTS_REFUSED")


def _expected_checks(mode, previous_profiles, service_key_count):
    service = "community" if mode == "community-verifier" else "course"
    selected = [name for name in PROFILES if name.startswith(service + "-")]
    expected = {}
    if mode.startswith("course-http"):
        for profile, suffixes in (("course-learner", ("learner-a-baseline", "learner-b-baseline")), ("course-admin", ("admin-baseline",))):
            for slot in ("current", "previous") if profile in previous_profiles else ("current",):
                for suffix in suffixes:
                    expected["course-http." + slot + "." + suffix] = 200
    for profile in selected:
        prefix = "course-http." + profile if mode.startswith("course-http") else profile
        if not mode.startswith("course-http"):
            for slot in ("current", "previous") if profile in previous_profiles else ("current",):
                expected[profile + "." + slot + ".valid-baseline"] = None
            for name in ("fixed-clock-expired-29-baseline", "fixed-clock-expired-31", "fixed-clock-future-31"):
                expected[profile + "." + name] = None
        extra = ("missing-capability", "unknown-capability", "duplicate-capability") if profile.endswith("-admin") else ("unexpected-capability",)
        for name in (*NEGATIVES, *("service-key-" + str(index) for index in range(service_key_count)), *extra):
            expected[prefix + "." + name] = 401 if mode.startswith("course-http") else None
    if mode.startswith("course-http"):
        for name, status in (("customer-cannot-administer", 403), ("admin-cannot-impersonate-learner", 401), ("support-cannot-edit", 403),
                ("account-a-cannot-read-b", 403), ("account-b-cannot-read-a", 403), ("shared-course-a-baseline", 200), ("shared-course-b-baseline", 200),
                ("completed-attempt-a-baseline", 200), ("completed-attempt-isolated-from-b", 200), ("final-valid-baseline", 200)):
            expected["course-http." + name] = status
    return expected


def _validate_receipt(value, binding, mode, check=None, previous_profiles=(), service_key_count=1):
    if mode == "course-http-plan":
        demand(_closed(value, ("version", "status", "bindingSha256", "checks", "networkCalled")) and value["version"] == 1 and
            value["status"] == "P2_IDENTITY_HTTP_CHECK_PLAN" and value["bindingSha256"] == binding and value["networkCalled"] is False and
            isinstance(value["checks"], list) and 60 <= len(value["checks"]) <= 150 and
            all(_closed(row, ("name", "expectedStatus")) and isinstance(row["name"], str) and re.fullmatch(r"course-http\.[a-z0-9.-]{1,110}", row["name"]) and
                row["expectedStatus"] in (200, 401, 403) for row in value["checks"]) and
            len({row["name"] for row in value["checks"]}) == len(value["checks"]), "P2_IDENTITY_CHECK_PLAN_REFUSED")
        demand(value["checks"][0] == {"name": "course-http.current.learner-a-baseline", "expectedStatus": 200} and
            value["checks"][-1] == {"name": "course-http.final-valid-baseline", "expectedStatus": 200}, "P2_IDENTITY_POSITIVE_BASELINES_REQUIRED")
        demand({row["name"]: row["expectedStatus"] for row in value["checks"]} == _expected_checks(mode, previous_profiles, service_key_count),
            "P2_IDENTITY_COMPLETE_CHECK_PLAN_REQUIRED")
        return value
    extra = ("completeHttpSuite", "gatewayConfigurationBindingVerified", "workloadOidcVerified") if mode == "course-http" else ("moduleSha256", "runtimeConfigurationBindingVerified")
    fields = ("version", "status", "environment", "bindingSha256", "scope", "checks", "readOnly", "oidcVerified", "keyRemovalVerified", "releaseAccepted", *extra)
    scope = "actual-course-private-tls-readonly-http" if mode == "course-http" else "actual-" + mode.split("-")[0] + "-image-verifier-only"
    demand(_closed(value, fields) and value["version"] == 1 and value["status"] == "P2_IDENTITY_NEGATIVE_PROBE_PASS" and
        value["environment"] == "staging" and value["bindingSha256"] == binding and value["scope"] == scope and value["readOnly"] is True and
        all(value[field] is False for field in ("oidcVerified", "keyRemovalVerified", "releaseAccepted")) and isinstance(value["checks"], list),
        "P2_IDENTITY_CHILD_RECEIPT_REFUSED")
    for row in value["checks"]:
        expected = ("name", "status", "httpStatus") if mode == "course-http" else ("name", "status")
        demand(_closed(row, expected) and row["status"] == "passed" and isinstance(row["name"], str) and re.fullmatch(r"[a-z0-9.-]{1,120}", row["name"]),
            "P2_IDENTITY_NAMED_CHECK_REQUIRED")
    if mode == "course-http":
        demand(len(value["checks"]) == 1 and value["checks"][0]["name"] == check["name"] and value["checks"][0]["httpStatus"] == check["expectedStatus"] and
            value["workloadOidcVerified"] is False and value["completeHttpSuite"] is False and value["gatewayConfigurationBindingVerified"] is True,
            "P2_IDENTITY_EXACT_HTTP_RECEIPT_REQUIRED")
    else:
        files = {"dist/auth/first-party.js", "dist/auth/jwt-profile.js", "dist/config/env.js"} if mode == "course-verifier" else {
            "dist/auth/community-user-auth.js", "dist/config/runtime.js", "dist/config/env.js"}
        demand(60 <= len(value["checks"]) <= 150 and value["runtimeConfigurationBindingVerified"] is True and isinstance(value["moduleSha256"], dict) and
            set(value["moduleSha256"]) == files and all(_digest(item) for item in value["moduleSha256"].values()), "P2_IDENTITY_ACTUAL_VERIFIER_RECEIPT_REQUIRED")
        demand(len({row["name"] for row in value["checks"]}) == len(value["checks"]) and
            {row["name"]: None for row in value["checks"]} == _expected_checks(mode, previous_profiles, service_key_count),
            "P2_IDENTITY_COMPLETE_VERIFIER_CHECKS_REQUIRED")
    return value


def _execute_scoped(bundle, configuration, reviewed_probe, operator_source, lease):
    """Only called by the existing reviewed broker under its actual live scope."""
    from p2_identity_probe_scope import CurrentIdentityProbeScope, ReplacementIdentityProbeScope
    demand(isinstance(lease, CurrentIdentityProbeScope), "P2_IDENTITY_ACTUAL_RELEASE_SCOPE_REQUIRED")
    lease.verify()
    expected_profile = lease.expected_profile if isinstance(lease, ReplacementIdentityProbeScope) else None
    reviewed = validate_reviewed(reviewed_probe, expected_profile=expected_profile)
    demand(lease.candidate_sha256 == reviewed["candidateSha256"], "P2_IDENTITY_LIVE_CANDIDATE_SCOPE_REQUIRED")
    source, configuration = Path(operator_source), Path(configuration)
    demand(source == Path("/opt/lash-her/operators") / reviewed["sources"]["frontend"] and
        not any(path.is_symlink() for path in (source, *source.parents)), "P2_IDENTITY_PINNED_OPERATOR_SOURCE_REQUIRED")
    demand(configuration.is_absolute() and configuration.is_relative_to(STAGING_ROOT) and
        ".." not in configuration.parts and configuration.resolve() == configuration and
        not any(path.is_symlink() for path in (configuration, *configuration.parents)), "P2_IDENTITY_STAGING_RUNTIME_PATH_REQUIRED")
    _guard(lease, lambda: staging_state.outside_checkout(configuration))
    profile = {} if expected_profile is None else {"expected_profile": expected_profile}
    plan, selected, jobs, runtime_plan = _guard(lease, lambda: make_plan(bundle, configuration, reviewed, source, **profile))
    code = _guard(lease, lambda: program_bytes(source))
    keys, service_keys, environments = _keys(configuration, jobs, reviewed, lease)
    _containers(selected, configuration, reviewed, lease)
    binding = _hash(_canonical(reviewed))
    containers = {row["service"]: row for row in reviewed["containers"]}

    def configuration_digest():
        if expected_profile is not None:
            return _guard(lease, lambda: _configuration_hash(configuration))
        return _configuration_hash(configuration, lease)

    def child(mode, check=None):
        demand(configuration_digest() == reviewed["configurationSha256"], "P2_IDENTITY_CONFIGURATION_CHANGED")
        service = "gateway" if mode.startswith("course-http") else mode.split("-")[0] + "-api"
        _one_container(containers[service], configuration, lease)
        demand(_guard(lease, lambda: program_bytes(source)) == code, "P2_IDENTITY_PROGRAM_CHANGED")
        payload = {"version": 1, "mode": mode, "environment": "staging", "bindingSha256": binding, "subjects": reviewed["subjects"],
            "resources": reviewed["resources"], "keys": keys, "serviceKeys": service_keys, "previousProfiles": reviewed["previousProfiles"],
            "httpCheck": None if check is None else check["name"],
            "runtimeEnvironment": environments[mode.split("-")[0]] if mode.endswith("-verifier") else None,
            "gatewayConfigurationSha256": _hash(_guard(lease, lambda: migrate.read_input(configuration, "gateway.json", 65_536))),
            "gatewayCaSha256": _hash(_guard(lease, lambda: migrate.read_input(configuration, "tls/gateway/ca.pem", 65_536)))}
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
            containers[service]["containerId"], "node", "--input-type=module", "--eval", code.decode()]
        # P2ReleaseScope registers/kills the actual CLI child on revocation. One
        # HTTP operation per child permits no subsequent request after loss.
        result = lease.run(args, input=_canonical(payload), env=runtime.SAFE_ENV, capture_output=True, timeout=30)
        lease.verify()
        demand(len(result.stdout) <= 65_536 and len(result.stderr) == 0, "P2_IDENTITY_PRIVATE_CHILD_REFUSED")
        try:
            value = json.loads(result.stdout)
        except (ValueError, TypeError, UnicodeError):
            raise ValueError("P2_IDENTITY_PRIVATE_CHILD_REFUSED") from None
        if result.returncode != 0:
            demand(_closed(value, ("version", "status", "check", "readOnly", "oidcVerified", "releaseAccepted")) and
                value["version"] == 1 and value["status"] == "P2_IDENTITY_NEGATIVE_PROBE_FAILED" and value["readOnly"] is True and
                value["oidcVerified"] is False and value["releaseAccepted"] is False and isinstance(value["check"], str) and
                re.fullmatch(r"[a-z0-9.-]{1,120}", value["check"]), "P2_IDENTITY_PRIVATE_CHILD_REFUSED")
            raise NegativeProbeFailure(value["check"], mode)
        value = _validate_receipt(value, binding, mode, check, reviewed["previousProfiles"], len(service_keys))
        _one_container(containers[service], configuration, lease)
        demand(configuration_digest() == reviewed["configurationSha256"], "P2_IDENTITY_CONFIGURATION_CHANGED")
        return value

    try:
        verifiers = [child("course-verifier"), child("community-verifier")]
        checklist = child("course-http-plan")["checks"]
        http = [child("course-http", check)["checks"][0] for check in checklist]
        _containers(selected, configuration, reviewed, lease)
        return {"version": 1, "status": "P2_STAGING_IDENTITY_NEGATIVE_PROBES_PASS", "environment": "staging", "probeId": reviewed["probeId"],
            "releaseId": reviewed["releaseId"], "candidateSha256": reviewed["candidateSha256"], "hostMachineId": reviewed["hostMachineId"],
            "sources": reviewed["sources"], "containers": reviewed["containers"], "configurationSha256": reviewed["configurationSha256"],
            "programSha256": reviewed["programSha256"], "reviewedScopeSha256": binding, "verifiers": verifiers, "httpChecks": http,
            "operatorSourceSha256": reviewed["operatorSourceSha256"], "priorEvidence": reviewed["priorEvidence"], "frontendSqlVerified": False,
            "previousProfiles": reviewed["previousProfiles"], "readOnly": True, "oidcVerified": False, "keyRemovalVerified": False,
            "crossAccountIsolationVerified": True, "completedAttemptIsolationVerified": True, "newFixturesCreated": False, "releaseAccepted": False,
            **_replacement_bindings(reviewed, expected_profile)}
    finally:
        lease.verify()


def execute(bundle, configuration, reviewed_probe, operator_source, lease):
    try:
        return _execute_scoped(bundle, configuration, reviewed_probe, operator_source, lease)
    except NegativeProbeFailure:
        raise
    except Exception as error:
        # Never propagate subprocess args/output, URLs, configuration values or
        # arbitrary exception text into the broker's common failure receipt.
        code = str(error)
        if not isinstance(error, ValueError) or not re.fullmatch(r"P2_(?:IDENTITY|RELEASE|ENVIRONMENT|FRONTEND)_[A-Z_]{1,90}", code):
            code = "private-probe-failed"
        raise NegativeProbeFailure(code) from None


def execute_current_stage(bundle, configuration, reviewed_probe, operator_source, prior_evidence):
    """Explicit later-stage read-only API. Never applies SQL or restarts work."""
    from p2_identity_probe_scope import CurrentIdentityProbeScope
    scope = None
    try:
        reviewed = json.loads(_canonical(reviewed_probe))
        validate_reviewed(reviewed)
        source, bundle, configuration = Path(operator_source), Path(bundle), Path(configuration)
        demand(source == Path("/opt/lash-her/operators") / reviewed["sources"]["frontend"] and
            not any(path.is_symlink() for path in (source, *source.parents)), "P2_IDENTITY_PINNED_OPERATOR_SOURCE_REQUIRED")
        for path in (bundle, configuration):
            demand(path.is_absolute() and path.is_relative_to(STAGING_ROOT) and path.resolve() == path and
                not any(item.is_symlink() for item in (path, *path.parents)), "P2_IDENTITY_STAGING_RUNTIME_PATH_REQUIRED")
            staging_state.outside_checkout(path)
        _plan, selected, jobs, runtime_plan = make_plan(bundle, configuration, reviewed, source)
        demand(_closed(prior_evidence, ("originalReleaseReceipt", "frontendDeploymentRecord")), "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_REQUIRED")
        for name, raw in prior_evidence.items():
            demand(isinstance(raw, bytes) and 0 < len(raw) <= 65_536 and isinstance(json.loads(raw), dict) and
                _hash(raw) == reviewed["priorEvidence"][name + "Sha256"], "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_CHANGED")
        runtime.assert_host(runtime_plan)
        program = program_bytes(source)
        def verify_inputs():
            demand(Path("/etc/machine-id").read_text().strip() == reviewed["hostMachineId"], "P2_IDENTITY_SELECTED_HOST_CHANGED")
            demand(source_closure(source) == reviewed["operatorSourceFiles"] and program_bytes(source) == program,
                "P2_IDENTITY_OPERATOR_SOURCE_CHANGED")
            demand(_configuration_hash(configuration) == reviewed["configurationSha256"], "P2_IDENTITY_CONFIGURATION_CHANGED")
            _fresh_plan, fresh, fresh_jobs, _runtime = make_plan(bundle, configuration, reviewed, source)
            demand(fresh == selected and fresh_jobs == jobs, "P2_IDENTITY_CANDIDATE_BYTES_CHANGED")
        scope = CurrentIdentityProbeScope(selected, reviewed, configuration, program, verify_inputs)
        scope.candidate_sha256 = reviewed["candidateSha256"]
        result = execute(bundle, configuration, reviewed, source, scope)
        result["leaseProfile"] = "fresh-host-flock-readonly-identity-no-sql"
        result["priorEvidenceBytesBound"] = True
        scope.verify()
        scope.close()
        return result
    except NegativeProbeFailure:
        raise
    except Exception:
        raise NegativeProbeFailure("current-stage-readonly-refused") from None
    finally:
        if scope is not None and not scope.closed:
            try:
                scope.close()
            except Exception:
                raise NegativeProbeFailure("readonly-child-cleanup-uncertain") from None


def execute_replacement_stage(bundle, configuration, results, reviewed_probe, operator_source, prior_evidence):
    """Rejoin a replacement release and inspect its actual runtime under the host flock."""
    from p2_certification_parent import _profiled_context
    from p2_identity_probe_scope import ReplacementIdentityProbeScope
    from p2_identity_replacement_provenance import require_replacement_identity_provenance
    expected = _profiled_context()
    scope = None
    try:
        reviewed = validate_reviewed(json.loads(_canonical(reviewed_probe)), expected_profile=expected)
        source, bundle, configuration, results = map(Path, (operator_source, bundle, configuration, results))
        demand(source == Path("/opt/lash-her/operators") / reviewed["sources"]["frontend"] and
            not any(path.is_symlink() for path in (source, *source.parents)), "P2_IDENTITY_PINNED_OPERATOR_SOURCE_REQUIRED")
        for path in (bundle, configuration, results):
            demand(path.is_absolute() and STAGING_ROOT in path.parents and path.resolve() == path and
                not any(item.is_symlink() for item in (path, *path.parents)), "P2_IDENTITY_STAGING_RUNTIME_PATH_REQUIRED")
            staging_state.outside_checkout(path)
        _plan, selected, jobs, runtime_plan = make_plan(bundle, configuration, reviewed, source, expected_profile=expected)
        demand(_closed(prior_evidence, ("originalReleaseReceipt", "frontendDeploymentRecord")),
            "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_REQUIRED")
        evidence = dict(prior_evidence)
        for name, raw in evidence.items():
            demand(isinstance(raw, bytes) and 0 < len(raw) <= 65_536 and
                _hash(raw) == reviewed["priorEvidence"][name + "Sha256"], "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_CHANGED")
        runtime.assert_host(runtime_plan)
        program = program_bytes(source)

        def verify_inputs():
            demand(Path("/etc/machine-id").read_text().strip() == reviewed["hostMachineId"], "P2_IDENTITY_SELECTED_HOST_CHANGED")
            demand(program_bytes(source) == program and _configuration_hash(configuration) == reviewed["configurationSha256"],
                "P2_IDENTITY_CONFIGURATION_CHANGED")
            _fresh_plan, fresh, fresh_jobs, _runtime = make_plan(bundle, configuration, reviewed, source, expected_profile=expected)
            demand(fresh == selected and fresh_jobs == jobs, "P2_IDENTITY_CANDIDATE_BYTES_CHANGED")

        scope = ReplacementIdentityProbeScope(selected, jobs, reviewed, configuration, source, program, verify_inputs)
        scope.candidate_sha256 = reviewed["candidateSha256"]

        def verify_provenance():
            actual = require_replacement_identity_provenance(bundle, configuration, results, source, selected, jobs, reviewed, evidence)
            demand(actual == configuration, "P2_IDENTITY_REPLACEMENT_RUNTIME_PATH_CHANGED")

        _guard(scope, verify_provenance)
        scope.bind_runtime()
        result = execute(bundle, configuration, reviewed, source, scope)
        _guard(scope, verify_provenance)
        scope.verify_runtime()
        scope.close()
        return {**result, "leaseProfile": "fresh-host-flock-readonly-identity-no-sql", "priorEvidenceBytesBound": True}
    except NegativeProbeFailure:
        raise
    except Exception:
        raise NegativeProbeFailure("replacement-stage-readonly-refused") from None
    finally:
        if scope is not None and not scope.closed:
            try:
                scope.close()
            except Exception:
                raise NegativeProbeFailure("readonly-child-cleanup-uncertain") from None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Plan staging identity negative probes; execution belongs to the existing live scoped broker")
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--configuration", required=True, type=Path)
    parser.add_argument("--reviewed", required=True, type=Path)
    args = parser.parse_args()
    try:
        reviewed = migrate.read_json(args.reviewed.parent, args.reviewed.name)
        print(json.dumps(make_plan(args.bundle, args.configuration, reviewed)[0]))
    except BaseException:
        print(json.dumps({"status": "P2_IDENTITY_NEGATIVE_PROBE_PLAN_REFUSED", "credentialsRead": False, "networkCalled": False}))
        raise SystemExit(1) from None
