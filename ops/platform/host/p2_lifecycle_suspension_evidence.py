"""Retain fixed source-parent browser/pending artifacts under its actual lease.

No standalone activation, browser JSON import, database writer, or worker runner.
The Node parent must pass bytes from its process-issued browser capability. This
retainer independently binds the held host/FE scope, immutable source and runtime;
it does not turn a schema-valid caller record into browser authority.
"""
import copy
import datetime
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

import migrate
import release as runtime
import p2_identity_negative_probe as identity
import p2_lifecycle_persistence_probe as persistence
import p2_lifecycle_authority_timing as timing
from p2_certification_fault import bind_frontend_scope
from p2_release_scope import P2ReleaseScope
from p2_canonical_browser_origin import ORIGIN as BROWSER_ORIGIN

ROOT = Path("/var/lib/lash-her/releases/staging")
PRIVATE_ROOT = Path("/run/lash-her-p2-suspension-private")
LOCK = Path("/run/lock/lash-her-release.lock")
SHA = re.compile(r"^[a-f0-9]{64}$")
BROWSER_LAUNCHER = b"\nawait runP2LifecycleBrowserChild();\n"
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
demand = migrate.demand
READY_FILES = ("frontend-build-started.json", "frontend-build-created.json", "frontend-build-outcome.json",
    "frontend-workload-outcome.json", "frontend-promotion-started.json", "frontend-promotion-outcome.json")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _release_evidence(scope, reviewed, plan, release_evidence, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    if expected is None:
        demand(release_evidence is None, "P2_SUSPENSION_RELEASE_EVIDENCE_REFUSED")
        return None
    demand(isinstance(release_evidence, dict) and set(release_evidence) == {"originalReleaseReceipt", "readyReceipts"}
        and isinstance(release_evidence["readyReceipts"], dict)
        and set(release_evidence["readyReceipts"]) == set(READY_FILES), "P2_SUSPENSION_RELEASE_EVIDENCE_REQUIRED")
    certification = scope.certification_plan
    pins = certification.get("readyReceiptSha256")
    demand(isinstance(pins, dict) and set(pins) == set(READY_FILES)
        and certification.get("originalReleaseReceiptSha256") == reviewed["plan"]["originalReleaseSha256"],
        "P2_SUSPENSION_RELEASE_EVIDENCE_PINS_REQUIRED")
    raw, values = {}, {}
    from qualification_target_profile import decode_qualification_target_json
    for name, encoded in release_evidence["readyReceipts"].items():
        demand(isinstance(encoded, str), "P2_SUSPENSION_RELEASE_EVIDENCE_REQUIRED")
        value = base64.b64decode(encoded, validate=True)
        demand(0 < len(value) <= 262144 and digest(value) == pins[name], "P2_SUSPENSION_RELEASE_EVIDENCE_CHANGED")
        parsed = decode_qualification_target_json(value, "carrier")
        migrate.require_profile(expected, parsed)
        demand(parsed.get("version") == 2 and parsed.get("environment") == "staging"
            and parsed.get("releaseId") == plan.get("releaseId") and parsed.get("sourceCommit") == plan.get("sourceCommit"),
            "P2_SUSPENSION_RELEASE_EVIDENCE_CONTEXT_CHANGED")
        raw[name], values[name] = value, parsed
    original = release_evidence["originalReleaseReceipt"]
    demand(isinstance(original, str), "P2_SUSPENSION_RELEASE_EVIDENCE_REQUIRED")
    original_raw = base64.b64decode(original, validate=True)
    demand(0 < len(original_raw) <= 262144 and digest(original_raw) == certification["originalReleaseReceiptSha256"],
        "P2_SUSPENSION_RELEASE_EVIDENCE_CHANGED")
    original_value = decode_qualification_target_json(original_raw, "carrier")
    migrate.require_profile(expected, original_value)
    persistence_evidence = {"originalReleaseReceipt": original,
        "frontendDeploymentRecord": release_evidence["readyReceipts"]["frontend-promotion-outcome.json"]}
    if "replacementRelease" in certification:
        suspension_sha = digest(canonical(plan))
        demand((certification.get("mode") == "browser-pending" and certification.get("browserPlanSha256") == suspension_sha) or
            (certification.get("mode") == "direct-worker" and certification.get("workerPlan", {}).get("suspensionPlanSha256") == suspension_sha),
            "P2_SUSPENSION_REPLACEMENT_HELD_PLAN_REQUIRED")
        persistence.HeldCertificationPersistenceScope._replacement_release_evidence(scope, reviewed, persistence_evidence, expected)
    else:
        persistence._release_evidence(reviewed, persistence_evidence, expected)
    workload = values["frontend-workload-outcome.json"]
    promotion = values["frontend-promotion-outcome.json"]
    demand(digest(raw["frontend-workload-outcome.json"]) == plan.get("configurationRecordSha256")
        and original_value.get("frontendWorkloadReceiptSha256") == digest(raw["frontend-workload-outcome.json"])
        and digest(raw["frontend-promotion-outcome.json"]) == reviewed["plan"]["frontendDeploymentSha256"]
        and workload.get("status") == "FRONTEND_VERIFIED" and workload.get("deploymentId") == plan.get("deploymentId")
        and workload.get("featureControls") == plan.get("featureControls")
        and workload.get("writerAdmissionBinding") == plan.get("writerAdmissionBinding")
        and workload.get("trafficAuthorized") is False and workload.get("nativeSchedulerVerified") is False
        and promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED" and promotion.get("deploymentId") == plan.get("deploymentId")
        and promotion.get("phase") == "completed" and promotion.get("frontendDomainsPromoted") is True
        and promotion.get("trafficAuthorized") is False,
        "P2_SUSPENSION_RELEASE_EVIDENCE_SEMANTICS_REQUIRED")
    return {"originalReleaseReceiptSha256": digest(original_raw),
        "frontendWorkloadReceiptSha256": digest(raw["frontend-workload-outcome.json"]),
        "frontendPromotionReceiptSha256": digest(raw["frontend-promotion-outcome.json"])}


def _milliseconds(value):
    demand(isinstance(value, str) and value.endswith("Z"), "P2_SUSPENSION_OBSERVED_TIME_REQUIRED")
    return round(datetime.datetime.fromisoformat(value.removesuffix("Z") + "+00:00").timestamp() * 1000)


def private_record(directory, name, record):
    """Exclusive/fsynced source-owned record; originals are never overwritten."""
    info = directory.lstat()
    demand(not directory.is_symlink() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
        and stat.S_IMODE(info.st_mode) == 0o700 and name in (
            "browser-parent-intent.json", "browser-suspension-accepted.json", "p2-lifecycle-browser-source.json", "p2-lifecycle-suspension-pending.json",
            "controlled-capture-intent.json", "controlled-capture.json", "controlled-capture-public.json", "controlled-user-window.json", "controlled-mux-window.json"),
        "P2_SUSPENSION_PRIVATE_RECORD_REQUIRED")
    raw = canonical(record) + b"\n"
    demand(0 < len(raw) <= 262144, "P2_SUSPENSION_RECORD_BOUND")
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        remaining = raw
        while remaining:
            written = os.write(descriptor, remaining)
            demand(written > 0, "P2_SUSPENSION_DURABLE_WRITE_REQUIRED")
            remaining = remaining[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {"recordSha256": digest(raw), "recordBytes": len(raw)}


class P2LifecycleSuspensionEvidenceStage:
    def __init__(self, scope, selected, jobs, configuration, source, plan, persistence_reviewed, resources, *, expected_profile=None, release_evidence=None):
        expected = migrate.profile_context(expected_profile)
        demand(isinstance(scope, P2ReleaseScope) and scope.path == LOCK and scope.release is not None and scope.jobs is not None,
            "P2_SUSPENSION_ACTUAL_PHYSICAL_PARENT_SCOPE_REQUIRED")
        if expected is not None:
            from p2_certification_parent import P2CertificationScope
            demand(type(scope) is P2CertificationScope, "P2_SUSPENSION_CERTIFICATION_SCOPE_REQUIRED")
            migrate.candidate_profile(selected, expected)
            for info in jobs.values():
                migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
        migrate.require_profile(expected, plan)
        demand(os.geteuid() == 0 and plan.get("version") == (2 if expected is not None else 1) and plan.get("environment") == "staging"
            and plan.get("browserOrigin") == BROWSER_ORIGIN and plan.get("profile") == "normal-ui-suspension-pending-v1" and plan.get("windowSeconds") == 840
            and plan.get("initialAdmission") == {"newWork": True, "recovery": False}
            and plan.get("finalDisposition") == "native-off-and-admission-closed"
            and plan.get("workerInvocationAuthorized") is False and plan.get("automaticReplayAllowed") is False,
            "P2_SUSPENSION_FIXED_PLAN_REQUIRED")
        self.scope, self.selected, self.jobs, self.plan = scope, copy.deepcopy(selected), copy.deepcopy(jobs), copy.deepcopy(plan)
        self.expected_profile = expected
        self.configuration, self.source = Path(configuration), Path(source)
        demand(isinstance(resources, dict) and set(resources) == {"userId", "courseId", "lessonId"}
            and all(UUID.fullmatch(value or "") for value in resources.values())
            and resources["courseId"] != resources["lessonId"] and digest(canonical(resources)) == plan.get("resourceBindingSha256"),
            "P2_SUSPENSION_PRIVATE_RESOURCES_REQUIRED")
        self.resources = copy.deepcopy(resources)
        self.reviewed = copy.deepcopy(persistence._reviewed(persistence_reviewed, expected))
        runtime_plan = {"hostMachineId": plan.get("hostMachineId"), **({"qualificationTargetProfile": expected} if expected is not None else {})}
        persistence._join_selected(self.reviewed, self.selected, self.jobs, runtime_plan, expected)
        self.release_evidence = _release_evidence(scope, self.reviewed, plan, release_evidence, expected)
        demand(self.reviewed["plan"]["candidateSha256"] == plan.get("candidateSha256")
            and self.reviewed["plan"]["configurationSha256"] == plan.get("configurationSha256"), "P2_SUSPENSION_REVIEWED_CONTEXT_CHANGED")
        demand(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan.get("actionId", "")) and selected.get("releaseId") == plan.get("releaseId")
            and selected.get("environment") == "staging" and selected.get("contractPhase") == "p2"
            and selected["sources"]["frontend"]["commit"] == plan.get("sourceCommit") == plan.get("operatorSourceCommit")
            and self.source == Path("/opt/lash-her/operators") / plan["sourceCommit"]
            and scope.candidate_sha256 == plan.get("candidateSha256") and digest(canonical(selected)) == plan.get("candidateObjectSha256"),
            "P2_SUSPENSION_SAME_SOURCE_CANDIDATE_REQUIRED")
        demand(self.configuration.is_absolute() and self.configuration.is_relative_to(ROOT)
            and self.configuration.resolve() == self.configuration and ".." not in self.configuration.parts
            and not any(path.is_symlink() for path in (*self.configuration.parents, self.configuration, *self.source.parents, self.source)),
            "P2_SUSPENSION_REVIEWED_PATH_REQUIRED")
        self.challenge = None
        self.capture_attempted = self.expiry_attempted = False
        self.verify()
        self.inventory = self._inventory()
        self.directory = ROOT / ("p2-suspension-" + plan["actionId"])
        parent = self.directory.parent.lstat()
        demand(not self.directory.parent.is_symlink() and parent.st_uid == 0 and stat.S_IMODE(parent.st_mode) == 0o700,
            "P2_SUSPENSION_PRIVATE_PARENT_REQUIRED")
        self.directory.mkdir(mode=0o700, exist_ok=False)
        demand(PRIVATE_ROOT.parent.is_dir() and PRIVATE_ROOT.parent.stat().st_uid == 0
            and not any(path.is_symlink() for path in (PRIVATE_ROOT, *PRIVATE_ROOT.parents)), "P2_SUSPENSION_PRIVATE_RUNTIME_ROOT_REQUIRED")
        PRIVATE_ROOT.mkdir(mode=0o700, exist_ok=True)
        private_info = PRIVATE_ROOT.lstat()
        demand(private_info.st_uid == 0 and stat.S_IMODE(private_info.st_mode) == 0o700, "P2_SUSPENSION_PRIVATE_RUNTIME_ROOT_MODE")
        self.credentials_directory = PRIVATE_ROOT / plan["actionId"]
        self.credentials_directory.mkdir(mode=0o700, exist_ok=False)

    def _carrier(self, status, **fields):
        expected = getattr(self, "expected_profile", None)
        return {"version": 2 if expected is not None else 1,
            **({"qualificationTargetProfile": expected} if expected is not None else {}),
            "status": status, **fields}

    def _inventory(self):
        self.scope.verify()
        token = runtime._command_scope.set(self.scope)
        try:
            observed = runtime.check_containers(self.selected, self.configuration, expected_profile=getattr(self, "expected_profile", None))
        finally:
            runtime._command_scope.reset(token)
        demand(observed == self.reviewed["containers"], "P2_SUSPENSION_REVIEWED_RUNTIME_CHANGED")
        for service in ("gateway", "course-api", "community-api"):
            identity._one_container(next(row for row in observed if row["service"] == service), self.configuration, self.scope)
        return observed

    def verify(self):
        bind_frontend_scope(self.scope, self.selected, self.jobs, self.plan)
        self.scope.require_configuration(self.configuration)
        demand(Path("/etc/machine-id").read_text().strip() == self.plan["hostMachineId"]
            and identity._configuration_hash(self.configuration) == self.plan["configurationSha256"]
            and persistence._source_closure(self.source, self.reviewed, self.expected_profile) == self.reviewed["operatorSourceFiles"]
            and digest(json.dumps(self.reviewed["operatorSourceFiles"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode())
                == self.reviewed["plan"]["operatorSourceSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/p2-lifecycle-browser-recorder.mjs")+BROWSER_LAUNCHER) == self.plan["browserProgramSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/p2-lifecycle-pending-probe.mjs")) == self.plan["pendingProgramSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/p2-lifecycle-suspension-evidence.mjs")) == self.plan["parentProgramSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/host/p2_lifecycle_suspension_evidence.py")) == self.plan["hostProgramSha256"],
            "P2_SUSPENSION_SOURCE_CONFIGURATION_OR_MACHINE_CHANGED")
        observed = self._inventory()
        if hasattr(self, "inventory"):
            demand(observed == self.inventory, "P2_SUSPENSION_RUNTIME_CHANGED")

    def register_source_parent(self, challenge):
        self.verify()
        demand(self.challenge is None and SHA.fullmatch(challenge or ""), "P2_SUSPENSION_ONE_SOURCE_CHILD_REQUIRED")
        self.challenge = challenge
        record = self._carrier("P2_SUSPENSION_SOURCE_PARENT_REGISTERED", planSha256=digest(canonical(self.plan)), challenge=challenge,
            browserProgramSha256=self.plan["browserProgramSha256"], sourceChildProcessVerificationRequired=True)
        retained = private_record(self.directory, "browser-parent-intent.json", record)
        if self.expected_profile is None:
            return retained
        return self._carrier("P2_SUSPENSION_SOURCE_PARENT_REGISTERED", **retained, sourceChildProcessVerificationRequired=True)

    def _timing(self, payload):
        self.verify()
        gateway = next(row["containerId"] for row in self.inventory if row["service"] == "gateway")
        program = timing.private_program(self.source)
        result = self.scope.run(["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", gateway, "node", "--input-type=module", "--eval", program.decode()],
            input=canonical(payload), env=runtime.SAFE_ENV, capture_output=True, timeout=30)
        demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 65536, "P2_SUSPENSION_CONTROLLED_CHILD_REFUSED")
        value = json.loads(result.stdout)
        demand(value.get("bindingSha256") == digest(canonical(self.plan)), "P2_SUSPENSION_CONTROLLED_CHILD_CONTEXT_CHANGED")
        self.verify()
        return value

    def _course_runtime(self):
        self.verify()
        path = self.configuration / "course-api.env"
        info = path.lstat()
        demand(not path.is_symlink() and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600,
            "P2_SUSPENSION_PRIVATE_COURSE_RUNTIME_REQUIRED")
        values = runtime.environment_values(migrate.read_input(self.configuration, path.name, 65536), "staging", "course-api", self.jobs,
            expected_profile=getattr(self, "expected_profile", None))
        program = """import{readFileSync}from'node:fs';try{const raw=readFileSync(0);if(raw.length>65536)throw Error();const input=JSON.parse(raw);
const excluded=new Set(['NODE_ENV','NODE_OPTIONS','PORT','HTTP_BIND_ADDRESS','INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS','INTERNAL_SERVICE_ALLOWED_IPS','COURSE_COMMUNITY_READ_ALLOWED_IPS','INTERNAL_TRUSTED_PROXY_CIDRS']);
if(process.env.NODE_ENV!=='production'||process.env.DATABASE_TARGET!=='staging'||!Object.entries(input).every(([k,v])=>excluded.has(k)||process.env[k]===v)||typeof input.COURSE_LEARNER_JWT_CURRENT_SECRET!=='string'||input.COURSE_LEARNER_JWT_CURRENT_SECRET.length<32)throw Error();
console.log(JSON.stringify({status:'P2_SUSPENSION_COURSE_RUNTIME_BOUND'}))}catch{console.log(JSON.stringify({status:'P2_SUSPENSION_RUNTIME_REFUSED'}));process.exitCode=1}"""
        api = next(row["containerId"] for row in self.inventory if row["service"] == "course-api")
        result = self.scope.run(["docker", "exec", "-i", "--workdir", "/app", api, "node", "--input-type=module", "--eval", program],
            input=canonical(values), env=runtime.SAFE_ENV, capture_output=True, timeout=15)
        demand(result.returncode == 0 and not result.stderr and json.loads(result.stdout) == {"status": "P2_SUSPENSION_COURSE_RUNTIME_BOUND"},
            "P2_SUSPENSION_COURSE_RUNTIME_NOT_BOUND")
        self.verify()
        return values

    def capture_controlled(self):
        self.verify()
        demand(self.challenge is not None and not self.capture_attempted, "P2_SUSPENSION_ONE_CONTROLLED_CAPTURE_REQUIRED")
        self.capture_attempted = True
        private_record(self.directory, "controlled-capture-intent.json", self._carrier("P2_SUSPENSION_CONTROLLED_CAPTURE_STARTED",
            planSha256=digest(canonical(self.plan)), captureAttempted=True))
        values = self._course_runtime()
        ca = migrate.read_input(self.configuration, "tls/gateway/ca.pem", 65536)
        payload = {"version": 1, "mode": "s13-capture", "environment": "staging", "bindingSha256": digest(canonical(self.plan)),
            "subject": self.resources["userId"], "courseId": self.resources["courseId"], "lessonId": self.resources["lessonId"],
            "currentKey": values["COURSE_LEARNER_JWT_CURRENT_SECRET"], "gatewayCaSha256": digest(ca)}
        captured = self._timing(payload)
        demand(captured.get("status") == "P2_S13_PRIVATE_CAPTURED" and captured["controlledUser"]["exp"]-captured["controlledUser"]["iat"] == 300,
            "P2_SUSPENSION_CONTROLLED_CAPTURE_REFUSED")
        # This credential-bearing record and its digest are NEVER common output.
        self.capture, self.ca_sha256 = captured, digest(ca)
        private_record(self.credentials_directory, "controlled-capture.json", captured)
        public = {"controlledUser": {key: captured["controlledUser"][key] for key in ("iat", "exp", "baseline")},
            "playback": {key: captured["playback"][key] for key in ("exp", "courseAuthorization", "initialProviderAccess")}, "labels": captured["labels"]}
        record = self._carrier("P2_SUSPENSION_CONTROLLED_CAPTURED", bindingSha256=digest(canonical(self.plan)),
            capturePublic=public, controlledCaptureMetadataSha256=digest(canonical(public)), tokenBytesOutput=False, credentialHashesOutput=False)
        private_record(self.directory, "controlled-capture-public.json", record)
        return record

    def _natural_window(self, kind, boundary, payload):
        # Fixed real time only. A provider/service error is not a denial. Polls
        # are bounded around the known expiry and never regenerate the token.
        deadline = time.monotonic() + max(0, boundary/1000-time.time()) + 15
        while time.time()*1000 < boundary-1500:
            self.scope.verify()
            time.sleep(min(0.2, max(0.001, (boundary-1500-time.time()*1000)/1000)))
            demand(time.monotonic() < deadline, "P2_SUSPENSION_NATURAL_EXPIRY_TIMEOUT")
        last = None
        while time.monotonic() < deadline:
            value = self._timing(payload)
            expected = "P2_S13_PRIVATE_USER_OBSERVED" if kind == "user" else "P2_S13_PRIVATE_MUX_OBSERVED"
            demand(value.get("status") == expected, "P2_SUSPENSION_EXPIRY_CHILD_REFUSED")
            row = value["observation"]
            start = _milliseconds(row["requestStartedAt"])
            if row["status"] in (200, 206):
                last = row
            else:
                demand(row["status"] in ((401,) if kind == "user" else (401, 403)) and last is not None
                    and _milliseconds(last["requestStartedAt"]) < boundary <= start <= boundary+2000,
                    "P2_SUSPENSION_NATURAL_BOUNDARY_NOT_PROVED")
                result = {"lastAccepted": last, "firstDenied": row, "pollResolutionMs": 2000}
                private_record(self.directory, "controlled-" + kind + "-window.json", result)
                return result
            time.sleep(0.5)
        raise ValueError("P2_SUSPENSION_NATURAL_EXPIRY_NOT_OBSERVED")

    def capture_natural_expiry(self, ui_event):
        self.verify()
        demand(hasattr(self, "capture") and not self.expiry_attempted and isinstance(ui_event, dict)
            and ui_event.get("type") == "ordinary-owner-suspension-accepted" and ui_event.get("action") == "suspend"
            and ui_event.get("status") == "pending" and UUID.fullmatch(ui_event.get("commandId", ""))
            and UUID.fullmatch(ui_event.get("requestId", "")) and type(ui_event.get("accountVersion")) is int and ui_event["accountVersion"] >= 1,
            "P2_SUSPENSION_ACTUAL_UI_EVENT_REQUIRED")
        self.expiry_attempted = True
        accepted = ({"version": 1, "planSha256": digest(canonical(self.plan)), "event": ui_event}
            if self.expected_profile is None else self._carrier("P2_SUSPENSION_BROWSER_ACCEPTED",
                planSha256=digest(canonical(self.plan)), event=ui_event))
        private_record(self.directory, "browser-suspension-accepted.json", accepted)
        user, playback = self.capture["controlledUser"], self.capture["playback"]
        demand(_milliseconds(user["baseline"]["responseEndedAt"]) <= _milliseconds(ui_event["observedAt"])
            < (user["exp"]+30)*1000-2000, "P2_SUSPENSION_CAPTURE_MUST_PRECEDE_UI_AND_NATURAL_BOUNDARY")
        self._course_runtime()
        user_window = self._natural_window("user", (user["exp"]+30)*1000, {"version": 1, "mode": "s13-user-observe", "environment": "staging",
            "bindingSha256": digest(canonical(self.plan)), "subject": self.resources["userId"], "courseId": self.resources["courseId"],
            "userToken": user["token"], "iat": user["iat"], "exp": user["exp"], "gatewayCaSha256": self.ca_sha256})
        mux_window = self._natural_window("mux", playback["exp"]*1000, {"version": 1, "mode": "s13-mux-observe", "environment": "staging",
            "bindingSha256": digest(canonical(self.plan)), "requestUrl": playback["requestUrl"], "playbackId": playback["playbackId"], "exp": playback["exp"]})
        self.natural = {"user": user_window, "mux": mux_window}
        return self._carrier("P2_SUSPENSION_NATURAL_EXPIRY_OBSERVED", bindingSha256=digest(canonical(self.plan)),
            user=user_window, mux=mux_window, userWindowSha256=digest(canonical(user_window)), muxWindowSha256=digest(canonical(mux_window)),
            tokenBytesOutput=False, credentialHashesOutput=False)

    def scrub_controlled_credentials(self):
        # Remove only this source instance's exact private capture, outside the
        # common receipt tree. A lost source/PG verifier cannot skip cleanup.
        if getattr(self, "credentials_scrubbed", False) or not hasattr(self, "capture"):
            return {"controlledCredentialsRemoved": True}
        path = self.credentials_directory / "controlled-capture.json"
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            demand(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600
                and os.read(descriptor, 262145) == canonical(self.capture)+b"\n", "P2_SUSPENSION_PRIVATE_CAPTURE_CHANGED")
        finally:
            os.close(descriptor)
        path.unlink()
        descriptor = os.open(self.credentials_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.capture["controlledUser"]["token"] = ""
        self.capture["playback"]["requestUrl"] = ""
        self.credentials_scrubbed = True
        return {"controlledCredentialsRemoved": True}

    def retain_browser_from_source_parent(self, raw):
        self.verify()
        demand(self.challenge is not None and isinstance(raw, bytes) and 0 < len(raw) <= 262144, "P2_SUSPENSION_SOURCE_CHILD_BYTES_REQUIRED")
        record = json.loads(raw)
        demand(record.get("status") == "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED" and record.get("challenge") == self.challenge
            and record.get("bindingSha256") == digest(canonical(self.plan)) and record.get("sourceCommit") == self.plan["sourceCommit"]
            and record.get("actionId") == self.plan["actionId"] and record.get("deploymentId") == self.plan["deploymentId"]
            and record.get("deploymentUrl") == self.plan["deploymentUrl"] and record.get("browserOrigin") == BROWSER_ORIGIN and record.get("contextsIsolated") is True
            and all(record.get(name) is False for name in ("sessionsFabricated", "clockChanged", "requestsIntercepted", "tokensRetained", "rawHarRetained", "releaseAccepted")),
            "P2_SUSPENSION_SOURCE_CHILD_CONTEXT_REQUIRED")
        result = private_record(self.directory, "p2-lifecycle-browser-source.json", record)
        self.browser = record
        self.verify()
        return self._carrier("P2_SUSPENSION_BROWSER_RETAINED", **result, browserProcessAuthority="fixed-source-parent-child",
            sourceChildProcessVerificationRequired=True, releaseAccepted=False)

    def retain_pending_from_source_parent(self, record):
        self.verify()
        demand(hasattr(self, "browser") and record.get("status") == "P2_LIFECYCLE_SUSPENSION_PENDING_OBSERVED", "P2_SUSPENSION_BROWSER_REQUIRED")
        event = next(row for row in self.browser["events"] if row["type"] == "ordinary-owner-suspension-accepted")
        command = record.get("command", {})
        demand(command.get("commandId") == event["commandId"] and command.get("accountVersion") == event["accountVersion"]
            and command.get("userId") == self.browser["userId"] and command.get("action") == "suspend" and UUID.fullmatch(record.get("requestedByAdminId", ""))
            and record.get("uiRequestId") == event["requestId"] and record.get("uiResponseObservedAt") == event["observedAt"]
            and record.get("sessions") == 0 and record.get("laterCommandCount") == 0 and record.get("pendingOrDeliveringCount") == 2
            and record.get("workerInvoked") is False and record.get("readOnly") is True
            and [row.get("receiver") for row in record.get("deliveries", [])] == ["course", "community"]
            and all(row.get("status") == "pending" and type(row.get("attempts")) is int and row["attempts"] == 0
                and all(row.get(name) is None for name in ("lease_id", "lease_until", "acknowledged_at")) for row in record["deliveries"]),
            "P2_SUSPENSION_PENDING_SOURCE_JOIN_REQUIRED")
        envelope = self._carrier("P2_SUSPENSION_PENDING_SOURCE_RETAINED", planSha256=digest(canonical(self.plan)),
            candidateSha256=self.plan["candidateSha256"], configurationSha256=self.plan["configurationSha256"],
            sourceCommit=self.plan["sourceCommit"], targetSha256=self.plan["targetSha256"],
            pendingProgramSha256=self.plan["pendingProgramSha256"], pending=record, workerInvoked=False)
        result = private_record(self.directory, "p2-lifecycle-suspension-pending.json", envelope)
        self.verify()
        return self._carrier("P2_SUSPENSION_PENDING_RETAINED", **result, pendingDeliveries=2,
            attempts=0, workerInvoked=False, releaseAccepted=False)


def load_retained_suspension(scope, selected, jobs, configuration, source, plan, persistence_reviewed, expected_pending_sha256, *, expected_profile=None, release_evidence=None):
    """Fixed private provenance for a later bounded worker/native action.

    Reads source-created files only. No copied JSON, arbitrary path or old SQL
    receipt can substitute for the fresh actual parent scope and source joins.
    """
    expected = migrate.profile_context(expected_profile)
    demand(isinstance(scope, P2ReleaseScope) and scope.path == LOCK and os.geteuid() == 0,
        "P2_SUSPENSION_ACTUAL_PHYSICAL_PARENT_SCOPE_REQUIRED")
    if expected is not None:
        from p2_certification_parent import P2CertificationScope
        demand(type(scope) is P2CertificationScope, "P2_SUSPENSION_CERTIFICATION_SCOPE_REQUIRED")
        migrate.candidate_profile(selected, expected)
        for info in jobs.values():
            migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    migrate.require_profile(expected, plan)
    demand(plan.get("version") == (2 if expected is not None else 1) and plan.get("environment") == "staging"
        and plan.get("browserOrigin") == BROWSER_ORIGIN and plan.get("profile") == "normal-ui-suspension-pending-v1"
        and plan.get("windowSeconds") == 840 and plan.get("initialAdmission") == {"newWork": True, "recovery": False}
        and plan.get("finalDisposition") == "native-off-and-admission-closed"
        and plan.get("workerInvocationAuthorized") is False and plan.get("automaticReplayAllowed") is False,
        "P2_SUSPENSION_FIXED_PLAN_REQUIRED")
    bind_frontend_scope(scope, selected, jobs, plan)
    scope.require_configuration(configuration)
    source, configuration = Path(source), Path(configuration)
    reviewed = persistence._reviewed(persistence_reviewed, expected)
    runtime_plan = {"hostMachineId": plan.get("hostMachineId"), **({"qualificationTargetProfile": expected} if expected is not None else {})}
    persistence._join_selected(reviewed, selected, jobs, runtime_plan, expected)
    source_release_evidence = _release_evidence(scope, reviewed, plan, release_evidence, expected)
    demand(SHA.fullmatch(expected_pending_sha256 or "") and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan.get("actionId", ""))
        and source == Path("/opt/lash-her/operators") / plan["sourceCommit"]
        and plan.get("operatorSourceCommit") == plan["sourceCommit"] == selected["sources"]["frontend"]["commit"]
        and scope.candidate_sha256 == plan.get("candidateSha256") == reviewed["plan"]["candidateSha256"]
        and digest(canonical(selected)) == plan.get("candidateObjectSha256")
        and identity._configuration_hash(configuration) == plan.get("configurationSha256") == reviewed["plan"]["configurationSha256"]
        and Path("/etc/machine-id").read_text().strip() == plan.get("hostMachineId")
        and persistence._source_closure(source, reviewed, expected) == reviewed["operatorSourceFiles"]
        and digest(migrate.read_input(source, "ops/platform/p2-lifecycle-browser-recorder.mjs")+BROWSER_LAUNCHER) == plan["browserProgramSha256"]
        and digest(migrate.read_input(source, "ops/platform/p2-lifecycle-pending-probe.mjs")) == plan["pendingProgramSha256"]
        and digest(migrate.read_input(source, "ops/platform/p2-lifecycle-suspension-evidence.mjs")) == plan["parentProgramSha256"]
        and digest(migrate.read_input(source, "ops/platform/host/p2_lifecycle_suspension_evidence.py")) == plan["hostProgramSha256"],
        "P2_SUSPENSION_RETAINED_CONTEXT_REQUIRED")
    directory = ROOT / ("p2-suspension-" + plan["actionId"])
    info = directory.lstat()
    demand(not any(path.is_symlink() for path in (directory, *directory.parents)) and stat.S_ISDIR(info.st_mode)
        and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, "P2_SUSPENSION_PRIVATE_RETAINED_DIRECTORY_REQUIRED")
    def retained(name, carrier=False):
        descriptor = os.open(directory/name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 262144,
                "P2_SUSPENSION_PRIVATE_RETAINED_RECORD_REQUIRED")
            raw = os.read(descriptor, 262145)
            demand(len(raw) == info.st_size, "P2_SUSPENSION_RETAINED_RECORD_CHANGED")
            if expected is not None and carrier:
                from qualification_target_profile import decode_qualification_target_json
                value = decode_qualification_target_json(raw, "carrier")
                migrate.require_profile(expected, value)
                demand(value.get("version") == 2, "P2_SUSPENSION_RETAINED_PROFILE_REQUIRED")
            else:
                value = json.loads(raw)
            return value, digest(raw)
        finally:
            os.close(descriptor)
    pending, pending_sha = retained("p2-lifecycle-suspension-pending.json", carrier=True)
    browser, browser_sha = retained("p2-lifecycle-browser-source.json")
    public, _public_sha = retained("controlled-capture-public.json", carrier=True)
    user, _user_sha = retained("controlled-user-window.json")
    mux, _mux_sha = retained("controlled-mux-window.json")
    demand(pending_sha == expected_pending_sha256 and pending.get("status") == "P2_SUSPENSION_PENDING_SOURCE_RETAINED"
        and pending.get("planSha256") == digest(canonical(plan)) == public.get("bindingSha256")
        and all(pending.get(name) == plan[name] for name in ("candidateSha256", "configurationSha256", "sourceCommit", "targetSha256", "pendingProgramSha256"))
        and public.get("controlledCaptureMetadataSha256") == digest(canonical(public["capturePublic"]))
        and browser.get("status") == "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED" and browser.get("bindingSha256") == pending["planSha256"]
        and browser.get("sourceCommit") == plan["sourceCommit"] and browser.get("deploymentId") == plan["deploymentId"]
        and browser.get("deploymentUrl") == plan["deploymentUrl"] and browser.get("browserOrigin") == plan.get("browserOrigin") == BROWSER_ORIGIN,
        "P2_SUSPENSION_RETAINED_SOURCE_AUTHORITY_REFUSED")
    accepted = next(row for row in browser["events"] if row["type"] == "ordinary-owner-suspension-accepted")
    command = pending["pending"]["command"]
    demand(command["commandId"] == accepted["commandId"] and command["accountVersion"] == accepted["accountVersion"]
        and command["userId"] == browser["userId"] and command["action"] == "suspend"
        and pending["pending"]["controlledDenialObservedAt"] == user["firstDenied"]["responseEndedAt"]
        and pending["pending"]["workerInvoked"] is False, "P2_SUSPENSION_RETAINED_CANONICAL_JOIN_REQUIRED")
    bind_frontend_scope(scope, selected, jobs, plan)
    scope.require_configuration(configuration)
    return {**({"version": 2, "qualificationTargetProfile": expected,
            "releaseEvidence": source_release_evidence} if expected is not None else {}),
        "pendingRecord": pending, "pendingRecordSha256": pending_sha, "browserRecord": browser, "browserRecordSha256": browser_sha,
        "capturePublic": public["capturePublic"], "user": user, "mux": mux}


if __name__ == "__main__":
    print(json.dumps({"version": 1, "status": "P2_SUSPENSION_SOURCE_PARENT_REQUIRED", "standaloneEligible": False,
        "browserCalled": False, "workerInvoked": False, "sqlApplied": False, "releaseAccepted": False}))
