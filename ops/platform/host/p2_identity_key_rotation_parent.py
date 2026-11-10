#!/usr/bin/env python3
"""Fixed supervised parent for the staging application-user key rotation.

This module has no standalone executor. The shared supervisor must select its
exact broker, observer, source program and layout. No caller command, callback
or JSON flag can substitute for that source selection.
"""
import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
from math import ceil
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.modules.setdefault("p2_identity_key_rotation_parent", sys.modules[__name__])
import migrate
import p2_identity_key_rotation as rotation_source
import release as runtime
import vercel
import frontend_probe
from frontend_release_adapters import LockedClient
import p2_canonical_browser_origin as canonical_origin
import p2_day_two_workload as day_two_workload
from p2_certification_profile import RUNTIME_FLAGS, require_profile as require_runtime_profile
from p2_identity_rotation_replacement import (MANAGED_INITIAL_FIELDS, ReplacementRotationPhysicalObserver,
                                              prepare_replacement_rotation_custody,
                                              validate_managed_rotation_initial)
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
from p2_release_broker import Broker, LOCK, MAXIMUM, decode
from p2_recovery_broker import P2RecoveryPhysicalObserver
from p2_source_closure import CERTIFICATION_OBSERVER, verify_rotation_source_closure
from p2_identity_key_rotation_adapter import (CAPTURE_METADATA_FIELDS, CAPTURE_PROFILES, CAPTURE_STATUS,
                                               SIGNER_PHASES, P2IdentityRotationHostAdapter, P2IdentityRotationScope,
                                               signer_configuration_phase)
from uuid import uuid4

require = migrate.demand
PHASES = ("baseline", "overlap", "current-only")
WINDOWS = {"authentication": 300, "signer-read": 60}
MUTATIONS = (("overlap", "api", ("baseline", "baseline")),
             ("overlap", "frontend", ("overlap", "baseline")),
             ("current-only", "frontend", ("overlap", "overlap")),
             ("current-only", "api", ("overlap", "current-only")))
OVERLAP_DRAIN_SECONDS = 330
MANAGED_ARM_SECONDS = 90
MANAGED_CLOSE_PREPARE_SECONDS = 75
MANAGED_CLOSE_SECONDS = 90
LIVE_ELIGIBLE = False
OBSERVER_SOURCE = "ops/platform/p2-recovery-current-probe.mjs"
PREPARED_RECEIPT = "p2-identity-key-rotation-close-prepared.json"
SESSION_CLOSED_RECEIPT = "p2-identity-key-rotation-frontend-session-closed.json"
JOINED_RECEIPT = "p2-identity-key-rotation-joined.json"


def _receipt_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def utc_seconds(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", value),
            "P2_ROTATION_EVIDENCE_TIME_REFUSED")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def observe_rotation_session_closed(initial, probe, source, run):
    program = source / "ops/platform/p2-identity-key-rotation-session-closed.mjs"
    expected = initial["sourceSha256"]["ops/platform/p2-identity-key-rotation-session-closed.mjs"]
    require(migrate.file_hash(program.read_bytes()) == expected, "P2_ROTATION_CLOSE_SOURCE_CHANGED")
    image = initial["candidate"]["artifacts"]["frontendMigration"]["image"]
    credential = initial["credentials"]["FRONTEND_STAGING_MIGRATION_DATABASE_URL"]
    container = "lash-p2-rotation-close-" + uuid4().hex
    args = ["docker", "run", "--rm", "--name", container, "--interactive", "--network", "host", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
            "--env", "FRONTEND_STAGING_MIGRATION_DATABASE_URL", "--mount",
            f"type=bind,src={program},dst=/app/ops/platform/p2-identity-key-rotation-session-closed.mjs,readonly",
            "--entrypoint", "node", image, "ops/platform/p2-identity-key-rotation-session-closed.mjs"]
    try:
        raw = run(args, env={**runtime.SAFE_ENV, "FRONTEND_STAGING_MIGRATION_DATABASE_URL": credential},
                  input=json.dumps({"version": 1, "operation": "verify-closed", "actionId": initial["rotationActionId"],
                                    "probe": probe}), timeout=8, check=True, capture_output=True, text=True).stdout.strip()
        require(len(raw.encode()) <= 16_384, "P2_ROTATION_CLOSE_RECEIPT_BOUNDS")
        value = json.loads(raw)
        require(type(value.get("version")) is int and value["version"] == 1 and value.get("environment") == "staging"
                and value.get("status") == "P2_IDENTITY_ROTATION_FRONTEND_SESSION_CLOSED"
                and value.get("actionId") == initial["rotationActionId"]
                and value.get("sourceCommit") == initial["rotationPlan"]["sourceCommit"]
                and value.get("candidateSha256") == initial["rotationPlan"]["candidateSha256"]
                and value.get("backendPid") == probe["backendPid"]
                and value.get("backendStart") == probe["backendStart"]
                and all(value.get(key) is expected_value for key, expected_value in {
                    "backendAbsent": True, "migrationLockReleased": True, "nonceLockReleased": True,
                    "newWork": False, "recovery": False, "sqlExecuted": False, "rolesPrepared": False,
                    "loginChanged": False, "trafficAuthorized": False}.items())
                and type(value.get("admissionEpoch")) is str and re.fullmatch(r"[1-9][0-9]{0,17}", value["admissionEpoch"])
                and type(value.get("active")) is int and value["active"] == 0
                and type(value.get("uncertain")) is int and value["uncertain"] == 0,
                "P2_ROTATION_FRONTEND_SESSION_CLOSE_UNVERIFIED")
    finally:
        run(["docker", "rm", "--force", container], env=runtime.SAFE_ENV, timeout=2,
            check=False, capture_output=True, text=True)
    return value


class P2IdentityRotationPhysicalObserver(P2RecoveryPhysicalObserver):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        epoch = self.request.get("receipt", {}).get("admissionEpoch")
        require(isinstance(epoch, str) and re.fullmatch(r"[1-9][0-9]{0,17}", epoch),
                "ROTATION_ADMISSION_EPOCH_REQUIRED")
        self.expectation_lock = threading.Lock()
        self.allowed = {(epoch, False, False)}
        self.window_deadline = None

    def transition(self, before_epoch, opening, maximum_seconds=None):
        require(isinstance(before_epoch, str) and re.fullmatch(r"[1-9][0-9]{0,17}", before_epoch),
                "ROTATION_WINDOW_EPOCH_REQUIRED")
        after = str(int(before_epoch) + 1)
        with self.expectation_lock:
            self.allowed = {(before_epoch, opening is False, False), (after, opening is True, False)}
            if opening:
                self.window_deadline = time.monotonic() + maximum_seconds
        return after

    def exact(self, epoch, new_work, maximum_seconds=None):
        with self.expectation_lock:
            self.allowed = {(epoch, new_work, False)}
            if new_work:
                require(type(maximum_seconds) is int and maximum_seconds in WINDOWS.values(),
                        "ROTATION_WINDOW_DURATION_REFUSED")
                deadline = time.monotonic() + maximum_seconds
                self.window_deadline = deadline if self.window_deadline is None else min(self.window_deadline, deadline)
            else:
                self.window_deadline = None

    def probe(self, operation):
        value = super().probe(operation)
        if operation == "fence":
            return value
        admission = value.get("admission", {})
        actual = (admission.get("epoch"), admission.get("newWork"), admission.get("recovery"))
        with self.expectation_lock:
            require(actual in self.allowed and admission.get("uncertain") == 0
                    and (admission.get("active") in (0, 1) if actual[1] is True else admission.get("active") == 0),
                    "ROTATION_FRONTEND_ADMISSION_WINDOW_CHANGED")
            if actual[1] is True:
                require(self.window_deadline is not None and time.monotonic() <= self.window_deadline,
                        "ROTATION_FRONTEND_ADMISSION_WINDOW_EXPIRED")
        return value


class P2IdentityRotationBroker(Broker):
    def require_source_closure(self, initial=None):
        return verify_rotation_source_closure(self.initial if initial is None else initial, self.source)

    def action_id(self):
        return self.initial["rotationActionId"]

    def directory_name(self):
        return "p2-identity-key-rotation-" + self.action_id()

    def terminal_filename(self):
        return "p2-identity-key-rotation-outcome.json"

    def _managed(self):
        return type(self.initial.get("version")) is int and self.initial["version"] == 2

    def _initialize_managed_replacement(self):
        from p2_release_supervisor import ROTATION_LAYOUT, fixed_layout, verify_guard_lock

        p = self.initial
        expected = validate_managed_rotation_initial(p)
        require(sys.platform == "linux" and os.geteuid() == 0 and fixed_layout(p) == ROTATION_LAYOUT
                and self.observer_type is ReplacementRotationPhysicalObserver and self.observer_source == CERTIFICATION_OBSERVER
                and self.shared_lock_fd is not None and self.shared_lock_fd == p.get("_guardLockDescriptor")
                and self.safety_write is not None and self.guard_read is not None,
                "P2_ROTATION_MANAGED_FIXED_SUPERVISOR_REQUIRED")
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, "P2_INDEPENDENT_GUARD_HANDSHAKE_REQUIRED")
        self.source = Path(__file__).resolve().parents[3]
        require(str(self.source) == "/opt/lash-her/operators/" + p["sourceCommit"] and self.source == self.source.resolve(),
                "P2_INSTALLED_SOURCE_REQUIRED")
        self.require_source_closure()
        self.bundle, self.configuration, self.results = (Path(p[key]) for key in ("bundle", "configuration", "results"))
        for path in (self.bundle, self.configuration, self.results):
            require(path.is_absolute() and path == path.resolve() and
                    Path("/var/lib/lash-her/releases/staging") in path.parents and "," not in str(path),
                    "P2_PRIVATE_HOST_PATH_REFUSED")
            migrate.private_directory(path)
        self.selected, self.jobs, self.plan, _ = self.select_release(p)
        require(migrate.file_hash(migrate.read_input(self.bundle, "release.candidate.json")) == p["candidateSha256"]
                and p["gatewayHost"] == self.plan["publicHost"] and self.plan["hostMachineId"] == p["hostMachineId"],
                "P2_ROTATION_REVIEWED_CANDIDATE_REQUIRED")
        runtime.assert_host(self.plan)
        require_runtime_profile(p["certification"])
        for service, flags in RUNTIME_FLAGS.items():
            raw = migrate.read_input(self.configuration, service + ".env", 65_536)
            values = runtime.environment_values(raw, "staging", service, self.jobs, expected_profile=expected)
            require(all(values.get(key) == value for key, value in flags.items()), "P2_CERTIFICATION_RUNTIME_FLAGS_REQUIRED")
        self.lock_fd = self.shared_lock_fd
        self.lock_info = os.fstat(self.lock_fd)
        require(stat.S_ISREG(self.lock_info.st_mode) and self.lock_info.st_uid == 0 and not self.lock_info.st_mode & 0o077,
                "P2_ACTUAL_HOST_LOCK_REQUIRED")
        verify_guard_lock(p)
        self.directory = self.results / self.directory_name()
        self.replacement_custody = prepare_replacement_rotation_custody(p, self.source, lock_fd=self.lock_fd,
                                                                      directory=self.directory)
        self.directory.mkdir(mode=0o700)
        self.profiled_scope = None
        self.managed_close_prepare_started = self.managed_close_started = None
        self.vercel = vercel.Client(p["vercelToken"])
        self.outcome.update(version=2, qualificationTargetProfile=expected, environment="staging",
                            releaseId=self.selected["releaseId"], sourceCommit=p["sourceCommit"],
                            candidateSha256=p["candidateSha256"], **migrate.contract_identity(self.selected))

    def select_release(self, initial):
        expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE) if self._managed() else None
        selected, jobs, plan, compose = runtime.make_plan(Path(initial["bundle"]), Path(initial["configuration"]),
                                                           self.source / "ops/platform/compose.yaml", expected_profile=expected)
        rotation = initial.get("rotationPlan")
        require(selected == initial.get("candidate") and selected.get("contractPhase") == "p2"
                and selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"}
                and rotation.get("version") == (2 if expected is not None else 1) and rotation.get("environment") == "staging"
                and rotation.get("actionId") == initial.get("rotationActionId")
                and rotation.get("sourceCommit") == initial.get("sourceCommit")
                and rotation.get("candidateSha256") == initial.get("candidateSha256")
                and rotation.get("hostMachineId") == plan.get("hostMachineId"),
                "P2_ROTATION_REVIEWED_CANDIDATE_REQUIRED")
        return selected, jobs, plan, compose

    def initialize(self):
        if self._managed():
            self._initialize_managed_replacement()
        else:
            super().initialize()
        p, rotation = self.initial, self.initial["rotationPlan"]
        require(p.get("mode") == "p2-identity-key-rotation"
                and p.get("confirmation") == "staging/" + self.action_id()
                and p.get("rotationActionId") == rotation["actionId"]
                and p.get("sourceSha256", {}).get(self.observer_source) == migrate.file_hash(
                    migrate.read_input(self.source, self.observer_source))
                and p.get("sourceSha256", {}).get("ops/platform/p2-identity-key-rotation.mjs") == migrate.file_hash(
                    migrate.read_input(self.source, "ops/platform/p2-identity-key-rotation.mjs"))
                and p.get("operatorProgramSha256") == migrate.file_hash(rotation_source.private_program(self.source)),
                "P2_ROTATION_FIXED_SOURCE_REQUIRED")
        browser_source = migrate.read_input(self.source, "ops/platform/p2-identity-key-rotation-browser-recorder.mjs")
        self.browser_program_sha256 = hashlib.sha256(
            browser_source + b"\nawait runP2IdentityRotationBrowserChild();\n").hexdigest()
        require(p.get("rotationBrowserProgramSha256") == self.browser_program_sha256,
                "P2_ROTATION_BROWSER_SOURCE_REQUIRED")
        require(p.get("expectedFeatureControls") == p.get("certification", {}).get("featureControls")
                and frontend_probe.valid_writer_admission_binding(p.get("expectedWriterAdmissionBinding"))
                and p["expectedWriterAdmissionBinding"].get("sourceCommit") == rotation["sourceCommit"],
                "P2_ROTATION_WORKLOAD_EXPECTATION_REFUSED")
        native_plan, private_probe = p.get("nativePlan"), p.get("privateProbe")
        require(isinstance(native_plan, dict) and native_plan.get("actionId") == self.selected["releaseId"]
                and native_plan.get("sourceCommit") == rotation["sourceCommit"]
                and native_plan.get("featureControls") == p["expectedFeatureControls"]
                and native_plan.get("writerAdmissionBinding") == p["expectedWriterAdmissionBinding"]
                and native_plan.get("configurationRecordSha256") == p.get("baselineConfigurationRecordSha256"),
                "P2_ROTATION_CANONICAL_BASELINE_REQUIRED")
        if not self._managed():
            require(isinstance(private_probe, dict)
                    and set(private_probe) == {"environment", "projectId", "sourceCommit", "releaseId", "secret", "expiresAt", "gatewayOrigin"}
                    and private_probe.get("environment") == "staging"
                    and private_probe.get("projectId") == native_plan.get("projectId")
                    and private_probe.get("sourceCommit") == native_plan.get("sourceCommit")
                    and private_probe.get("releaseId") == native_plan.get("actionId"),
                    "P2_ROTATION_CANONICAL_BASELINE_REQUIRED")
        root = Path(p.get("rotationConfiguration", ""))
        require(root.is_absolute() and root.resolve() == root
                and root.is_relative_to(Path("/var/lib/lash-her/releases/staging")),
                "P2_ROTATION_CONFIGURATION_ROOT_REQUIRED")
        self.rotation_configuration = root
        self.runtime_phase = self.frontend_phase = "baseline"
        self.window = None
        self._initialize_transition_gate()
        self.last_fully_qualified_phase = "baseline"
        self.qualified_signers = set()
        self.qualified_profiles = set()
        self.guard_last_verified = 0
        self.guard_in_progress = False
        self.guard_mutex = threading.RLock()
        self.guard_stop = threading.Event()
        self.frontend_close_prepared = False
        self.canonical_observations = {}
        self.canonical_window_authority = {}
        self.canonical_last_verified = 0
        self.outcome.update(status="P2_IDENTITY_KEY_ROTATION_FAILED_REQUIRES_REVIEW",
                            actionId=self.action_id(), bindingSha256=rotation["bindingSha256"],
                            keyRemovalVerified=False, trafficAuthorized=False,
                            sqlExecuted=False, rolesPrepared=False, loginChanged=False)
        if self._managed():
            migrate.write_json(self.directory, "p2-release-started.json", self.outcome)
            self.check()
            self.start_parent_watch()

    def _initialize_transition_gate(self):
        self.mutation_unresolved = False
        self.mutation_step = 0
        self.pending_mutation = None
        self.closed_signer_windows = {}
        self.retained_signers = {}
        self.capture_attempted = False
        self.capture_metadata = {}
        self.profile_observation_attempts = set()
        self.profile_evidence = {}
        self.contained = False
        self.restoration_attempted = False
        self.restored_frontend_phase = None

    def _canonical_private_directory(self, phase):
        if phase == self.restored_frontend_phase:
            directory = self.adapter.output / f"frontend-restoration-{phase}-private"
            migrate.private_directory(directory)
            return directory
        if phase == "baseline":
            directory = self.directory / "canonical-baseline-private"
            if not directory.exists():
                directory.mkdir(mode=0o700)
                migrate.write_json(directory, frontend_probe.PRIVATE_FILE, self.initial["privateProbe"])
            frontend_probe._private_input(directory, {"environment": "staging",
                "projectId": self.initial["nativePlan"]["projectId"],
                "sourceCommit": self.initial["nativePlan"]["sourceCommit"],
                "releaseId": self.initial["nativePlan"]["actionId"]})
            return directory
        directory = self.adapter.output / f"frontend-{phase}-private"
        migrate.private_directory(directory)
        return directory

    def _canonical_context(self, phase):
        require(phase in PHASES and phase == self.frontend_phase, "P2_ROTATION_CANONICAL_PHASE_REFUSED")
        plan = copy.deepcopy(self.initial["nativePlan"])
        if phase != "baseline" or phase == self.restored_frontend_phase:
            deployment = (self._restored_frontend_deployment(phase) if phase == self.restored_frontend_phase
                          else self.adapter.frontend_deployment(phase))
            plan.update(deploymentId=deployment["deploymentId"], deploymentUrl=deployment["deploymentUrl"],
                        configurationRecordSha256=deployment["workloadReceiptSha256"],
                        featureControls=copy.deepcopy(self.initial["expectedFeatureControls"]),
                        writerAdmissionBinding=copy.deepcopy(self.initial["expectedWriterAdmissionBinding"]))
        else:
            provider = self.adapter.observe_frontend_configuration(phase)
            require(provider.get("deploymentId") == plan["deploymentId"]
                    and provider.get("configurationSha256") == self.initial["rotationPlan"]["configuration"][phase]["sha256"],
                    "P2_ROTATION_BASELINE_FRONTEND_CONFIGURATION_UNVERIFIED")
        context = {"candidate": self.selected, "plan": plan, "configurationRecordSha256": plan["configurationRecordSha256"]}
        if self.initial.get("version") != 2:
            context["privateProbeDirectory"] = str(self._canonical_private_directory(phase))
        return context

    def _restored_frontend_deployment(self, phase):
        attempt = self.adapter.output / f"frontend-restoration-{phase}"
        if self.initial.get("version") == 2:
            staged = vercel._staged_identity(self.selected, attempt, expected_profile=self._canonical_profile())
        else:
            staged = vercel._staged_identity(self.selected, attempt)
        promotion = migrate.read_json(attempt, "frontend-promotion-outcome.json")
        workload_raw = migrate.read_input(attempt, "frontend-workload-outcome.json")
        workload = json.loads(workload_raw)
        url = migrate.read_json(attempt, "frontend-build-outcome.json").get("url")
        provider = self.adapter.observe_frontend_configuration(phase)
        require(promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED" and promotion.get("frontendDomainsPromoted") is True
                and workload.get("status") == "FRONTEND_VERIFIED"
                and staged["deploymentId"] == promotion.get("deploymentId") == workload.get("deploymentId") == provider.get("deploymentId")
                and isinstance(url, str) and re.fullmatch(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app", url),
                "P2_ROTATION_RESTORED_FRONTEND_DEPLOYMENT_UNVERIFIED")
        return {"deploymentId": staged["deploymentId"], "deploymentUrl": url,
                "workloadReceiptSha256": migrate.file_hash(workload_raw)}

    def _canonical_profile(self):
        expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        migrate.require_profile(expected, self.initial, self.selected, self.initial["nativePlan"])
        return expected

    def _observe_canonical(self, phase, *, force=False):
        if not force and phase in self.canonical_observations and time.monotonic() - self.canonical_last_verified < 20:
            return copy.deepcopy(self.canonical_observations[phase])
        context = self._canonical_context(phase)
        client = LockedClient(self.vercel, self.check)
        if self.initial.get("version") == 2:
            value = day_two_workload.observe_browser_origin(context, client, self.initial.get("scopedCronSecret"),
                                                            expected_profile=self._canonical_profile())
        else:
            value = canonical_origin.observe(context, client)
        require(value.get("browserOrigin") == canonical_origin.ORIGIN
                and value.get("deploymentId") == context["plan"]["deploymentId"],
                "P2_ROTATION_CANONICAL_ORIGIN_REFUSED")
        self.canonical_observations[phase] = copy.deepcopy(value)
        self.canonical_last_verified = time.monotonic()
        return copy.deepcopy(value)

    def _issue_canonical_window_authority(self, phase):
        self._require_signer_split(phase)
        require(self.window is None and phase not in self.canonical_window_authority and phase not in self.closed_signer_windows,
                "P2_ROTATION_CANONICAL_WINDOW_AUTHORITY_EXISTS")
        value = self._observe_canonical(signer_configuration_phase(phase), force=True)
        self.canonical_window_authority[phase] = {"value": copy.deepcopy(value), "completedKinds": set()}
        return value

    def arm(self, request):
        self.check()
        require(self.observer is None and self.scope is None, "P2_ROTATION_ALREADY_ARMED")
        raw, receipt = decode(request.get("receipt"))
        probe, rotation = request.get("probe"), self.initial["rotationPlan"]
        scope_arguments = {}
        if self._managed():
            require(type(request) is dict and set(request) == {"id", "operation", "receipt", "probe"} and
                    base64.b64encode(raw).decode() == request.get("receipt") and
                    isinstance(probe, dict) and probe.get("receipt") == receipt,
                    "P2_ROTATION_CURRENT_FRONTEND_PROOF_REQUIRED")
            self.replacement_custody.validate_arm_probe(probe)
            self._await_managed_guard_arm(probe)
            self.profiled_scope = self.replacement_custody.open_scope(probe, self.abort)
            self.observer = self.replacement_custody.scope_observer
            scope_arguments = {"replacement_custody": self.replacement_custody, "profiled_scope": self.profiled_scope}
        else:
            require(isinstance(probe, dict) and probe.get("job") == self.jobs["frontend"]["job"]
                    and probe.get("baseline") == json.loads(self.jobs["frontend"]["schema"])
                    and probe.get("receipt") == receipt and probe.get("owner") == self.initial.get("owner")
                    and probe.get("targetSha256") == self.initial.get("targetSha256")
                    and receipt.get("status") == "P2_RECOVERY_DATABASE_CURRENT"
                    and receipt.get("sourceCommit") == rotation["sourceCommit"]
                    and receipt.get("candidateSha256") == rotation["candidateSha256"]
                    and receipt.get("trafficAuthorized") is False,
                    "P2_ROTATION_CURRENT_FRONTEND_PROOF_REQUIRED")
            self.safety({"operation": "armed", "probe": probe})
            self.observer = P2IdentityRotationPhysicalObserver(self.selected, probe, self.source,
                self.initial["credentials"]["FRONTEND_STAGING_MIGRATION_DATABASE_URL"], program=self.observer_program,
                program_sha256=self.initial["sourceSha256"][OBSERVER_SOURCE])
            self.observer.start(self.abort)
        self.frontend_raw = raw
        self.armed_probe = copy.deepcopy(probe)
        public = {phase: rotation["configuration"][phase]["sha256"] for phase in PHASES}
        private = self.initial.get("privateRotationConfigurationSha256")
        self.scope = P2IdentityRotationScope(self.lock_fd, LOCK,
            self.check, receipt, rotation["candidateSha256"], action_id=self.action_id(),
            binding_sha256=rotation["bindingSha256"], source_commit=rotation["sourceCommit"],
            browser_program_sha256=self.browser_program_sha256,
            release=self.selected, jobs=self.jobs, configuration_sha256=public,
            private_configuration_sha256=private, **scope_arguments)
        self.adapter = P2IdentityRotationHostAdapter(self.scope, self.selected, self.jobs,
            self.rotation_configuration, self.configuration, self.directory, self.source / "ops/platform/compose.yaml", self.vercel,
            self.initial["gatewayHost"], self.source, self.initial["operatorProgramSha256"])
        self.guard_last_verified = time.monotonic()
        if self._managed():
            from p2_identity_rotation_browser_scope import P2IdentityRotationBrowserScope
            self.browser_scope = P2IdentityRotationBrowserScope(self, self.initial["scopedCronSecret"])
        boundary = self.adapter.observe_runtime_boundary("baseline")
        self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
        self._observe_canonical("baseline", force=True)
        self._guard_external()
        if self._managed():
            self._record_managed_inventory("baseline")
        self._start_rotation_guard()
        armed = {"status": "P2_IDENTITY_ROTATION_PARENT_ARMED", "actionId": self.action_id(),
                 "bindingSha256": rotation["bindingSha256"], "sourceCommit": rotation["sourceCommit"],
                 "candidateSha256": rotation["candidateSha256"], "trafficAuthorized": False}
        if self._managed():
            armed.update(version=2, qualificationTargetProfile=self._canonical_profile())
        return armed

    def _await_managed_guard_arm(self, probe):
        from p2_release_supervisor import require_managed_rotation_guard_arm

        deadline = time.monotonic() + MANAGED_ARM_SECONDS
        self.safety({"operation": "armed", "probe": probe})
        while True:
            self.check()
            require(time.monotonic() < deadline, "P2_ROTATION_MANAGED_GUARD_ARM_REQUIRED")
            try:
                require_managed_rotation_guard_arm(self.initial, probe)
                return
            except FileNotFoundError:
                time.sleep(0.05)

    def observe_rotation_browser_writer_scope(self, operation_epoch):
        require(self._managed() and self.profiled_scope is not None and self.observer is self.replacement_custody.scope_observer
                and not self.frontend_close_prepared and not self.contained,
                "P2_ROTATION_MANAGED_WRITER_SCOPE_REQUIRED")
        self.check()
        observed = self.replacement_custody.observe_writer_scope(self.armed_probe, operation_epoch)
        self.check()
        return observed

    def _record_managed_inventory(self, phase):
        from p2_identity_rotation_successor import record_rotation_runtime_inventory

        self._require_closed_frontend()
        record_rotation_runtime_inventory(self, phase, self.runtime_containers)

    def _guard_external(self, *, force_canonical=False):
        with self.guard_mutex:
            previously_in_progress = self.guard_in_progress
            self.guard_in_progress = True
            try:
                self.adapter.observe_continuous_runtime(self.runtime_phase, self.runtime_containers)
                value = self._require_closed_gateway_and_native()
                self._observe_canonical(self.frontend_phase, force=force_canonical)
                self.guard_last_verified = time.monotonic()
                return value
            finally:
                self.guard_in_progress = previously_in_progress

    def _require_closed_gateway_and_native(self):
        value = self.adapter.observe_closed_gateway_and_native(self.runtime_phase)
        require(value.get("gatewayAdmissionClosed") is True and type(value.get("gatewayActive")) is int
                and value["gatewayActive"] == 0 and type(value.get("gatewayUncertain")) is int
                and value["gatewayUncertain"] == 0 and value.get("nativeSchedulesEnabled") is False,
                "P2_ROTATION_EXTERNAL_GUARD_REFUSED")
        return value

    def _start_rotation_guard(self):
        def guard():
            while not self.guard_stop.wait(2):
                try:
                    if not self.frontend_close_prepared:
                        self.observer.probe("observe")
                    self._guard_external()
                except BaseException:
                    self.abort()
                    return
        self.rotation_guard = threading.Thread(target=guard, daemon=True)
        self.rotation_guard.start()

    def check(self):
        super().check()
        if self._managed() and getattr(self, "managed_close_prepare_started", None) is not None:
            started = self.managed_close_started
            cutoff = (self.managed_close_prepare_started + MANAGED_CLOSE_PREPARE_SECONDS if started is None
                      else started + MANAGED_CLOSE_SECONDS)
            require(time.monotonic() < cutoff, "P2_ROTATION_CLOSE_TIMEOUT")
        elif hasattr(self, "adapter"):
            require((not self.frontend_close_prepared and not self.guard_stop.is_set()
                     or self.frontend_close_prepared and self.guard_stop.is_set())
                    and (self.guard_in_progress or time.monotonic() - self.guard_last_verified < 35),
                    "P2_ROTATION_CONTINUOUS_GUARD_LOST")

    def _window_value(self, value):
        rotation, window = self.initial["rotationPlan"], value.get("window")
        fields = {"version", "actionId", "bindingSha256", "phase", "kind", "maximumSeconds", "source",
                  "deploymentId", "configurationSha256", "sourceCommit", "candidateSha256", "browserOrigin",
                  "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256"}
        require(isinstance(window, dict) and fields.issubset(window) and set(window).issubset(fields | {"epoch", "drain"})
                and window.get("version") == 1
                and window.get("actionId") == self.action_id() and window.get("bindingSha256") == rotation["bindingSha256"]
                and window.get("phase") in SIGNER_PHASES
                and window.get("kind") in WINDOWS and window.get("maximumSeconds") == WINDOWS[window["kind"]]
                and window.get("sourceCommit") == rotation["sourceCommit"]
                and window.get("candidateSha256") == rotation["candidateSha256"]
                and window.get("configurationSha256") == rotation["configuration"][signer_configuration_phase(window["phase"])]["sha256"]
                and isinstance(window.get("source"), dict)
                and set(window["source"]) == {"challenge", "bindingSha256", "browserProgramSha256"}
                and re.fullmatch(r"[a-f0-9]{64}", window["source"].get("challenge", ""))
                and window["source"].get("bindingSha256") == rotation["bindingSha256"],
                "P2_ROTATION_BROWSER_WINDOW_BINDING_REFUSED")
        require(window["source"].get("browserProgramSha256") == self.browser_program_sha256,
                "P2_ROTATION_BROWSER_SOURCE_CHANGED")
        deployment = self.adapter.frontend_deployment(signer_configuration_phase(window["phase"]))
        require(all(window.get(key) == deployment.get(key) for key in ("deploymentId", "configurationSha256")),
                "P2_ROTATION_BROWSER_DEPLOYMENT_CHANGED")
        authority = self.canonical_window_authority.get(window["phase"])
        canonical = authority.get("value") if isinstance(authority, dict) else None
        require(isinstance(canonical, dict)
                and window.get("browserOrigin") == canonical.get("browserOrigin") == canonical_origin.ORIGIN
                and window.get("canonicalAliasReadbackSha256") == canonical.get("aliasReadbackSha256")
                and window.get("canonicalProtectedWorkloadSha256") == canonical.get("protectedWorkloadSha256"),
                "P2_ROTATION_BROWSER_CANONICAL_ORIGIN_CHANGED")
        completed = authority["completedKinds"]
        require(window["kind"] not in completed
                and (window["kind"] == "authentication" or "authentication" in completed),
                "P2_ROTATION_BROWSER_CANONICAL_WINDOW_ORDER_REFUSED")
        return {key: copy.deepcopy(window[key]) for key in fields}

    def _begin_window(self, value):
        require(self.window is None, "P2_ROTATION_BROWSER_WINDOW_ALREADY_ACTIVE")
        window = self._window_value(value)
        self._require_signer_split(window["phase"])
        authority = self.canonical_window_authority[window["phase"]]
        if window["kind"] == "authentication":
            authority["sourceChallenge"] = window["source"]["challenge"]
        else:
            require(authority.get("sourceChallenge") == window["source"]["challenge"], "P2_ROTATION_BROWSER_SOURCE_CHANGED")
        proof = self.observer.probe("observe")
        epoch = proof["admission"]["epoch"]
        require(proof["admission"] == {"epoch": epoch, "newWork": False, "recovery": False,
                                      "active": 0, "uncertain": 0},
                "P2_ROTATION_BROWSER_WINDOW_NOT_CLOSED")
        selection = self.browser_scope.prepare(window)
        authentication = window["kind"] == "authentication"
        expected = self.observer.transition(epoch, True, window["maximumSeconds"]) if authentication else epoch
        require(selection == {"beforeEpoch": epoch, "permitEpoch": expected,
                              "closedEpoch": str(int(expected) + 1) if authentication else epoch},
                "P2_ROTATION_BROWSER_SCOPE_EPOCH_CHANGED")
        record = {**copy.deepcopy(window), "status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_INTENT",
                  "beforeEpoch": epoch, "expectedOpenEpoch": expected}
        migrate.write_json(self.directory, f"browser-{window['phase']}-{window['kind']}-intent.json", record)
        self.window = {"value": window, "before": epoch, "open": expected, "stage": "opening"}
        return record

    def _opened_window(self, value):
        require(self.window is not None and self.window["stage"] == "opening", "P2_ROTATION_BROWSER_WINDOW_STAGE_REFUSED")
        window = self._window_value(value)
        require(window == self.window["value"] and value.get("window", {}).get("epoch") == self.window["open"],
                "P2_ROTATION_BROWSER_OPEN_EPOCH_REFUSED")
        proof = self.observer.probe("observe")
        authentication = window["kind"] == "authentication"
        require(proof["admission"] == {"epoch": self.window["open"], "newWork": authentication,
                                      "recovery": authentication, "active": 0, "uncertain": 0},
                "P2_ROTATION_BROWSER_WINDOW_NOT_OPEN")
        if authentication:
            self.observer.exact(self.window["open"], True, window["maximumSeconds"])
        self.window["stage"] = "open"
        self.window["openedAt"] = time.time()
        return {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_OPENED", "epoch": self.window["open"],
                "phase": window["phase"], "kind": window["kind"], "bindingSha256": window["bindingSha256"]}

    def _take_window_permit(self, value):
        require(self.window is not None and self.window["stage"] == "open" and not self.window.get("permitTaken"),
                "P2_ROTATION_BROWSER_PRIVATE_PERMIT_REFUSED")
        window = self._window_value(value)
        require(window == self.window["value"] and value["window"].get("epoch") == self.window["open"],
                "P2_ROTATION_BROWSER_PRIVATE_PERMIT_REFUSED")
        self.window["permitTaken"] = True
        if window["kind"] == "authentication":
            return self.browser_scope.take_private_authentication_permits(window)
        return self.browser_scope.take_private_signer_permit(window)

    def _closing_window(self, value):
        require(self.window is not None and self.window["stage"] == "open", "P2_ROTATION_BROWSER_WINDOW_STAGE_REFUSED")
        window = self._window_value(value)
        require(window == self.window["value"] and value.get("window", {}).get("epoch") == self.window["open"],
                "P2_ROTATION_BROWSER_CLOSE_EPOCH_REFUSED")
        self.window["closed"] = (self.observer.transition(self.window["open"], False)
                                 if window["kind"] == "authentication" else self.window["open"])
        self.window["stage"] = "closing"
        return {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSING", "epoch": self.window["open"],
                "phase": window["phase"], "kind": window["kind"]}

    def _end_window(self, value):
        require(self.window is not None and self.window["stage"] == "closing", "P2_ROTATION_BROWSER_WINDOW_STAGE_REFUSED")
        window, supplied = self._window_value(value), value.get("window")
        drain = supplied.get("drain")
        require(self.window.get("permitTaken") is True and all(supplied.get(key) == item for key, item in self.window["value"].items())
                and supplied.get("epoch") == self.window["closed"]
                and isinstance(drain, dict) and drain.get("epoch") == self.window["closed"]
                and drain.get("newWork") is False and drain.get("recovery") is False
                and drain.get("active") == 0 and drain.get("uncertain") == 0 and drain.get("ledgerDrained") is True,
                "P2_ROTATION_BROWSER_WINDOW_DRAIN_REFUSED")
        proof = self.observer.probe("observe")
        require(proof["admission"] == {"epoch": self.window["closed"], "newWork": False, "recovery": False,
                                      "active": 0, "uncertain": 0},
                "P2_ROTATION_BROWSER_WINDOW_NOT_CLOSED")
        closed_wall, closed_monotonic = time.time(), time.monotonic()
        self.observer.exact(self.window["closed"], False)
        self._guard_external()
        scope = self.browser_scope.retain_closed(window)
        scope_raw = migrate.read_input(self.directory, f"browser-{window['phase']}-{window['kind']}-writer-scope.json", 16_384)
        require(scope == json.loads(scope_raw) and scope["closedEpoch"] == self.window["closed"]
                and scope["permitEpoch"] == self.window["open"], "P2_ROTATION_BROWSER_SCOPE_RECEIPT_CHANGED")
        result = {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSED", "epoch": self.window["closed"],
                  "phase": window["phase"], "kind": window["kind"], "active": 0, "uncertain": 0,
                  "writerScopeSha256": migrate.file_hash(scope_raw)}
        migrate.write_json(self.directory, f"browser-{window['phase']}-{window['kind']}-closed.json", result)
        authority = self.canonical_window_authority[window["phase"]]
        authority["completedKinds"].add(window["kind"])
        if window["kind"] == "authentication":
            authority["authenticationReceipt"] = result
        if window["kind"] == "signer-read":
            require(authority["completedKinds"] == {"authentication", "signer-read"},
                    "P2_ROTATION_BROWSER_CANONICAL_WINDOW_INCOMPLETE")
            self.closed_signer_windows[window["phase"]] = {
                "window": copy.deepcopy(window), "receipt": result, "openedAt": self.window["openedAt"],
                "authenticationReceipt": authority["authenticationReceipt"],
                "closedAt": closed_wall, "closedMonotonic": closed_monotonic,
            }
            del self.canonical_window_authority[window["phase"]]
        self.window = None
        return result

    def _require_closed_frontend(self):
        require(self.window is None, "P2_ROTATION_BROWSER_WINDOW_ALREADY_ACTIVE")
        admission = self.observer.probe("observe").get("admission", {})
        epoch = admission.get("epoch")
        require(isinstance(epoch, str) and re.fullmatch(r"[1-9][0-9]{0,17}", epoch)
                and admission.get("newWork") is False and admission.get("recovery") is False
                and type(admission.get("active")) is int and type(admission.get("uncertain")) is int
                and admission == {"epoch": epoch, "newWork": False, "recovery": False, "active": 0, "uncertain": 0},
                "P2_ROTATION_MUTATION_FRONTEND_NOT_CLOSED")

    def _require_signer_split(self, phase):
        expected = {"overlap": (2, "overlap", "overlap"), "current-only": (3, "overlap", "current-only"),
                    "post-removal": (4, "current-only", "current-only")}
        require(isinstance(phase, str) and phase in expected and not self.contained and not self.mutation_unresolved
                and (phase != "post-removal" or "current-only" in self.qualified_profiles)
                and expected[phase] == (self.mutation_step, self.runtime_phase, self.frontend_phase),
                "P2_ROTATION_SIGNER_SPLIT_STATE_REQUIRED")

    def _retained_window(self, phase):
        closed = self.closed_signer_windows.get(phase)
        require(closed is not None, "P2_ROTATION_HOST_SIGNER_WINDOW_REQUIRED")
        receipt = closed["receipt"]
        authentication = closed["authenticationReceipt"]
        require(receipt["epoch"] == authentication["epoch"], "P2_ROTATION_HOST_SIGNER_WINDOW_CHANGED")
        for kind, retained in (("authentication", authentication), ("signer-read", receipt)):
            require(migrate.read_json(self.directory, f"browser-{phase}-{kind}-closed.json") == retained
                    and migrate.file_hash(migrate.read_input(self.directory, f"browser-{phase}-{kind}-writer-scope.json", 16_384))
                    == retained["writerScopeSha256"], "P2_ROTATION_HOST_SIGNER_WINDOW_CHANGED")
        return closed

    def _retain_signer(self, value):
        phase, record = value.get("phase"), value.get("record")
        self._require_signer_split(phase)
        self._require_closed_frontend()
        closed = self._retained_window(phase)
        window = closed["window"]
        require(set(value) == {"id", "operation", "phase", "record"} and phase not in self.retained_signers
                and isinstance(record, dict)
                and all(record.get(key) == window[key] for key in ("phase", "bindingSha256", "deploymentId", "configurationSha256",
                        "browserOrigin", "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256"))
                and record.get("challenge") == window["source"]["challenge"]
                and record.get("browserProgramSha256") == window["source"]["browserProgramSha256"]
                and closed["openedAt"] - 2 <= utc_seconds(record.get("windowStartedAt"))
                <= utc_seconds(record.get("windowCompletedAt")) <= closed["closedAt"] + 2,
                "P2_ROTATION_HOST_SIGNER_WINDOW_BINDING_REQUIRED")
        receipt = self.adapter.retain_frontend_signer(phase, record)
        require(receipt == self.adapter.retained_frontend_signer(phase), "P2_ROTATION_RETAINED_SIGNER_CHANGED")
        self.retained_signers[phase] = copy.deepcopy(receipt)
        return receipt

    def _observe_signer(self, phase):
        self._require_signer_split(phase)
        self._require_closed_frontend()
        closed = self._retained_window(phase)
        receipt = self.adapter.observe_frontend_signer(phase)
        require(receipt == self.retained_signers.get(phase) == self.adapter.retained_frontend_signer(phase),
                "P2_ROTATION_RETAINED_SIGNER_CHANGED")
        self.qualified_signers.add(phase)
        if phase == "post-removal":
            self.last_fully_qualified_phase = "current-only"
        if phase == "overlap":
            # The controller's wait uses the conservative host-observed close
            # cutoff. The adapter retains the original browser receipt bytes.
            cutoff = max(closed["closedAt"], utc_seconds(receipt["issuanceCutoffAt"]))
            instant = datetime.fromtimestamp(ceil(cutoff * 1000) / 1000, timezone.utc)
            return {**receipt, "issuanceCutoffAt": instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        return receipt

    def _require_overlap_drain(self):
        require("overlap" in self.qualified_signers, "P2_ROTATION_OVERLAP_SIGNER_REQUIRED")
        closed = self._retained_window("overlap")
        signer = self.adapter.retained_frontend_signer("overlap")
        require(signer == self.retained_signers.get("overlap"), "P2_ROTATION_RETAINED_SIGNER_CHANGED")
        cutoff = max(closed["closedAt"], utc_seconds(signer["issuanceCutoffAt"]))
        difference = cutoff - closed["closedAt"]
        require(time.monotonic() >= closed["closedMonotonic"] + difference + OVERLAP_DRAIN_SECONDS
                and time.time() >= cutoff + OVERLAP_DRAIN_SECONDS,
                "P2_ROTATION_OVERLAP_DRAIN_INCOMPLETE")

    def _require_unexpired_capture(self):
        now = time.time()
        require(set(self.capture_metadata) == set(CAPTURE_PROFILES)
                and all(now < utc_seconds(row["tokenExpiresAt"]) for row in self.capture_metadata.values()),
                "P2_ROTATION_HELD_CAPTURE_REQUIRED")

    def _capture(self, identity, value):
        require(set(value) == {"id", "operation"} and self.mutation_step == 3 and self.runtime_phase == "overlap"
                and self.frontend_phase == "current-only" and self.window is None and not self.contained
                and not self.mutation_unresolved and not self.capture_attempted
                and {"overlap", "current-only"}.issubset(self.qualified_signers),
                "P2_ROTATION_CAPTURE_SPLIT_STATE_REQUIRED")
        self._require_closed_frontend()
        self._guard_external(force_canonical=True)
        self._require_overlap_drain()
        require(self.adapter.retained_frontend_signer("current-only") == self.retained_signers["current-only"],
                "P2_ROTATION_RETAINED_SIGNER_CHANGED")
        started = time.time()
        self.capture_attempted = self.mutation_unresolved = True
        rotation = self.initial["rotationPlan"]
        metadata = self.adapter.capture_tokens(rotation["subjects"], rotation["courseId"], rotation["bindingSha256"])
        now = time.time()
        require(isinstance(metadata, list) and len(metadata) == len(CAPTURE_PROFILES)
                and all(isinstance(row, dict) and set(row) == set(CAPTURE_METADATA_FIELDS) for row in metadata)
                and {row["profile"] for row in metadata} == set(CAPTURE_PROFILES), "P2_ROTATION_CAPTURE_METADATA_REFUSED")
        for row in metadata:
            issued, expires = utc_seconds(row["tokenIssuedAt"]), utc_seconds(row["tokenExpiresAt"])
            require(row["status"] == CAPTURE_STATUS and int(started) <= issued <= now < expires and expires - issued == 300,
                    "P2_ROTATION_CAPTURE_METADATA_REFUSED")
        self.check()
        self.send(identity, "ROTATION_CAPTURED", receipt=metadata)
        self.capture_metadata = {row["profile"]: copy.deepcopy(row) for row in metadata}
        self.mutation_unresolved = False

    def _observe_profiles(self, value):
        phase = value.get("phase")
        expected = {"overlap": (3, "overlap"), "current-only": (4, "current-only")}
        require(set(value) == {"id", "operation", "phase"} and isinstance(phase, str) and phase in expected
                and expected[phase] == (self.mutation_step, self.runtime_phase) and self.frontend_phase == "current-only"
                and not self.contained and not self.mutation_unresolved and phase not in self.profile_observation_attempts
                and {"overlap", "current-only"}.issubset(self.qualified_signers), "P2_ROTATION_PROFILE_SPLIT_STATE_REQUIRED")
        self._require_closed_frontend()
        self._guard_external(force_canonical=True)
        self._require_unexpired_capture()
        self.profile_observation_attempts.add(phase)
        rotation = self.initial["rotationPlan"]
        rows = self.adapter.observe_profiles(phase, rotation["subjects"], rotation["courseId"])
        require(isinstance(rows, list) and len(rows) == len(CAPTURE_PROFILES)
                and all(isinstance(row, dict) and isinstance(row.get("profile"), str) for row in rows)
                and {row.get("profile") for row in rows} == set(CAPTURE_PROFILES), "P2_ROTATION_PROFILE_CAPTURE_BINDING_REQUIRED")
        for row in rows:
            capture = self.capture_metadata[row["profile"]]
            require(row.get("oldTokenIssuedAt") == capture["tokenIssuedAt"]
                    and row.get("oldTokenExpiresAt") == capture["tokenExpiresAt"], "P2_ROTATION_PROFILE_CAPTURE_BINDING_REQUIRED")
        digests = {row["profile"]: migrate.file_hash(json.dumps(row, sort_keys=True, separators=(",", ":")).encode()) for row in rows}
        require(digests == self.adapter.retained_profile_evidence(phase), "P2_ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
        self.profile_evidence[phase] = digests
        self.qualified_profiles.add(phase)
        if phase == "overlap":
            self.last_fully_qualified_phase = phase
        return rows

    def _require_mutation_evidence(self, phase, kind):
        if phase == "current-only":
            self._require_overlap_drain()
        if (phase, kind) == ("current-only", "api"):
            require("current-only" in self.qualified_signers and "overlap" in self.qualified_profiles
                    and self.adapter.retained_frontend_signer("current-only") == self.retained_signers.get("current-only")
                    and self.adapter.retained_profile_evidence("overlap") == self.profile_evidence.get("overlap"),
                    "P2_ROTATION_PRE_REMOVAL_EVIDENCE_REQUIRED")
            self._require_unexpired_capture()

    def _mutate(self, identity, value):
        require(set(value) == {"id", "operation", "intent"} and not self.contained and self.mutation_step < len(MUTATIONS),
                "P2_ROTATION_MUTATION_ORDER_REFUSED")
        phase, kind, before = MUTATIONS[self.mutation_step]
        after = (phase, before[1]) if kind == "api" else (before[0], phase)
        intent = self.adapter._intent(value.get("intent"))
        require((intent["phase"], intent["kind"]) == (phase, kind), "P2_ROTATION_MUTATION_ORDER_REFUSED")
        reconcile = value["operation"] == "rotation-reconcile-mutation"
        current = (self.runtime_phase, self.frontend_phase)
        pending = self.pending_mutation
        attempt_name = f"host-{phase}-{kind}-attempted.json"
        attempted = {"version": 1, "status": "P2_ROTATION_HOST_MUTATION_ATTEMPTED", "intent": intent}
        if reconcile:
            require(pending is not None and self.mutation_unresolved and pending["intent"] == intent
                    and not pending["reconcileAttempted"] and current in (before, after)
                    and migrate.read_json(self.directory, attempt_name) == attempted,
                    "P2_ROTATION_RECONCILIATION_AUTHORITY_REFUSED")
            attempt = "runtime" if kind == "api" else "frontend"
            migrate.private_directory(self.adapter.output / f"{attempt}-{phase}")
        else:
            require(pending is None and not self.mutation_unresolved and current == before, "P2_ROTATION_MUTATION_ORDER_REFUSED")
        with self.guard_mutex:
            self.guard_in_progress = True
            try:
                self._require_closed_frontend()
                if reconcile:
                    self._require_closed_gateway_and_native()
                else:
                    self._guard_external(force_canonical=True)
                self._require_mutation_evidence(phase, kind)
                if reconcile:
                    pending["reconcileAttempted"] = True
                    receipt = self.adapter.reconcile_mutation(intent)
                else:
                    migrate.write_json(self.directory, attempt_name, attempted)
                    self.pending_mutation = {"intent": copy.deepcopy(intent), "reconcileAttempted": False}
                    self.mutation_unresolved = True
                    receipt = self.adapter.apply_mutation(intent, self.initial["expectedFeatureControls"],
                                                          self.initial["expectedWriterAdmissionBinding"])
                require(receipt == self.adapter._result(intent, reconcile), "P2_ROTATION_MUTATION_RECEIPT_CHANGED")
                self.runtime_phase, self.frontend_phase = after
                boundary = self.adapter.observe_runtime_boundary(self.runtime_phase)
                self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
                self._require_closed_frontend()
                self._guard_external(force_canonical=True)
                self._require_mutation_evidence(phase, kind)
                if self._managed() and kind == "api":
                    self._record_managed_inventory(phase)
                suffix = "reconciled" if reconcile else "observed"
                migrate.write_json(self.directory, f"host-{phase}-{kind}-{suffix}.json", receipt)
                self.send(identity, "ROTATION_MUTATION", receipt=receipt)
                self.mutation_step += 1
                self.pending_mutation = None
                self.mutation_unresolved = False
            finally:
                self.guard_in_progress = False

    def _finish(self, outcome):
        rotation = self.initial["rotationPlan"]
        require(self.window is None and not self.contained and not self.mutation_unresolved
                and self.mutation_step == len(MUTATIONS) and (self.runtime_phase, self.frontend_phase) == ("current-only", "current-only")
                and set(self.profile_evidence) == {"overlap", "current-only"}
                and self.qualified_signers == set(SIGNER_PHASES)
                and outcome.get("status") == "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED"
                and outcome.get("sourceMechanicsQualified") is True and outcome.get("keyRemovalVerified") is False
                and outcome.get("actionId") == self.action_id() and outcome.get("bindingSha256") == rotation["bindingSha256"]
                and outcome.get("sourceCommit") == rotation["sourceCommit"]
                and outcome.get("candidateSha256") == rotation["candidateSha256"]
                and outcome.get("lastFullyQualifiedPhase") == "current-only"
                and outcome.get("postRemovalFrontendSignerReceiptSha256") == self.retained_signers["post-removal"]["receiptSha256"]
                and all(outcome.get(key) is False for key in ("sqlExecuted", "rolesPrepared", "loginChanged", "trafficAuthorized")),
                "P2_ROTATION_CONTROLLER_OUTCOME_REFUSED")
        observed = self.observer.probe("observe")
        self._guard_external()
        if self._managed():
            final_epoch = rotation["finalEpoch"]
            require(self.browser_scope.closed_epoch == final_epoch and len(self.browser_scope.completed) == 6 and
                    observed["admission"] == {"epoch": final_epoch, "newWork": False, "recovery": False,
                                              "active": 0, "uncertain": 0},
                    "P2_ROTATION_MANAGED_FINAL_EPOCH_REQUIRED")
            boundary = self.adapter.observe_runtime_boundary("current-only")
            require(self.adapter.runtime_guard_containers(boundary["containers"]) == self.runtime_containers and
                    boundary.get("courseCurrent") is True and boundary.get("communityCurrent") is True,
                    "P2_ROTATION_MANAGED_FINAL_RUNTIME_CHANGED")
        signer = {"overlap": self.adapter.retained_frontend_signer("overlap"),
                  "current-only": self.adapter.retained_frontend_signer("current-only"),
                  "post-removal": self.adapter.observe_frontend_signer("post-removal")}
        self.adapter.observe_api_configuration("current-only")
        profile_receipts = self.adapter.qualified_profile_evidence()
        require(signer == self.retained_signers and profile_receipts == {
            profile: {phase: self.profile_evidence[phase][profile] for phase in ("overlap", "current-only")}
            for profile in CAPTURE_PROFILES}, "P2_ROTATION_TERMINAL_EVIDENCE_CHANGED")
        profile_classes = {"course-learner": "actual-protected-course-http",
                           "course-admin": "actual-protected-course-http",
                           "community-member": "deployed-private-community-verifier",
                           "community-admin": "deployed-private-community-verifier"}
        result = {"version": 1, "status": "P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED", "environment": "staging",
                  "actionId": self.action_id(), "bindingSha256": rotation["bindingSha256"],
                  "sourceCommit": rotation["sourceCommit"], "candidateSha256": rotation["candidateSha256"],
                  "configurationSha256": rotation["configuration"]["current-only"]["sha256"],
                  "profileEvidenceClass": profile_classes,
                  "profileReceiptSha256": profile_receipts,
                  "frontendSignerReceiptSha256": {phase: value["receiptSha256"] for phase, value in signer.items()},
                  "keyRemovalVerified": False, "sourceParentDispatchIntegrated": True,
                  "sqlExecuted": False, "rolesPrepared": False, "loginChanged": False,
                  "nativeSchedulesEnabled": False, "trafficAuthorized": False,
                  "tokenBytesOutput": False, "credentialHashesOutput": False,
                  "communityMemberFeatureAdded": False, "newPublicEndpoint": False,
                  "releaseAccepted": False, "g2Accepted": False}
        if self._managed():
            result.update(version=2, qualificationTargetProfile=self._canonical_profile(), frontendFinalEpoch=final_epoch,
                          frontendCustodyPlanSha256=rotation["frontendCustodyPlanSha256"])
            require(self.observer.probe("observe")["admission"] == observed["admission"],
                    "P2_ROTATION_MANAGED_FINAL_EPOCH_REQUIRED")
            self.managed_close_prepare_started = time.monotonic()
            self.frontend_close_prepared = True
            self.guard_stop.set()
        else:
            self.closing_at = time.monotonic()
            self.observer.stop()
            self.guard_stop.set()
        if self.rotation_guard is not threading.current_thread():
            self.rotation_guard.join(35)
        require(not self.rotation_guard.is_alive(), "P2_ROTATION_GUARD_CLEANUP_UNVERIFIED")
        if self._managed():
            observer, self.observer = self.observer, None
            try:
                observer.stop()
            except BaseException:
                self.observer = observer
                raise
            self.profiled_scope.closed = True
        else:
            self.frontend_close_prepared = True
        migrate.write_json(self.directory, PREPARED_RECEIPT, result)
        self.prepared_join = copy.deepcopy(result)
        if self._managed():
            self.check()
            self.managed_close_started = time.monotonic()
        self.outcome.update(result)
        return result

    def _verify_frontend_session_closed(self, request=None):
        require(self.frontend_close_prepared and not self.finished and hasattr(self, "prepared_join"),
                "P2_ROTATION_CLOSE_NOT_PREPARED")
        if self._managed():
            require(type(request) is dict and set(request) == {"id", "operation", "frontendSessionClosed"}
                    and self.observer is None and self.managed_close_started is not None
                    and self.prepared_join["frontendFinalEpoch"] == self.initial["rotationPlan"]["finalEpoch"]
                    and time.monotonic() - self.managed_close_started < MANAGED_CLOSE_SECONDS,
                    "P2_ROTATION_MANAGED_SESSION_CLOSE_REQUIRED")
            value = self.replacement_custody.verify_closed(self.armed_probe, self.prepared_join["frontendFinalEpoch"])
            require(type(request["frontendSessionClosed"]) is dict and
                    _receipt_bytes(request["frontendSessionClosed"]) == _receipt_bytes(value),
                    "P2_ROTATION_MANAGED_SESSION_CLOSE_CHANGED")
            self.check()
        else:
            require(self.closing_at is not None and time.monotonic() - self.closing_at < 10,
                    "P2_ROTATION_CLOSE_TIMEOUT")
            value = observe_rotation_session_closed(self.initial, self.armed_probe, self.source, self.scope.run)
        migrate.write_json(self.directory, SESSION_CLOSED_RECEIPT, value)
        self.finished = True
        self.joined = copy.deepcopy(self.prepared_join)
        self.joined.update(status="P2_IDENTITY_KEY_ROTATION_QUALIFIED", keyRemovalVerified=True,
                           frontendSessionCloseReceiptSha256=migrate.file_hash(
                               migrate.read_input(self.directory, SESSION_CLOSED_RECEIPT, 16_384)))
        return self.joined

    def _restore(self, value):
        phase, configuration = value.get("phase"), value.get("configuration")
        require(set(value) == {"id", "operation", "phase", "configuration"} and self.contained and not self.restoration_attempted
                and self.window is None and self.mutation_unresolved is False and self.pending_mutation is None
                and phase == self.last_fully_qualified_phase and phase in ("baseline", "overlap")
                and isinstance(configuration, dict) and configuration == self.initial["rotationPlan"]["configuration"][phase]
                and self.frontend_phase in (("baseline", "overlap") if phase == "baseline" else ("overlap", "current-only"))
                and (self.runtime_phase, self.frontend_phase) != (phase, phase),
                "P2_ROTATION_RESTORATION_AUTHORITY_REFUSED")
        with self.guard_mutex:
            self.guard_in_progress = True
            try:
                self._require_closed_frontend()
                self._guard_external(force_canonical=True)
                if phase == "overlap":
                    require("overlap" in self.qualified_signers and "overlap" in self.qualified_profiles
                            and self.adapter.retained_frontend_signer("overlap") == self.retained_signers.get("overlap")
                            and self.adapter.retained_profile_evidence("overlap") == self.profile_evidence.get("overlap"),
                            "P2_ROTATION_RESTORATION_AUTHORITY_REFUSED")
                migrate.write_json(self.directory, "host-restoration-attempted.json", {
                    "version": 1, "status": "P2_ROTATION_HOST_RESTORATION_ATTEMPTED",
                    "phase": phase, "configurationSha256": configuration["sha256"]})
                self.restoration_attempted = self.mutation_unresolved = True
                receipt = self.adapter.restore_qualified(phase, configuration["sha256"],
                    self.initial["expectedFeatureControls"], self.initial["expectedWriterAdmissionBinding"])
                self.runtime_phase = self.frontend_phase = self.restored_frontend_phase = phase
                boundary = self.adapter.observe_runtime_boundary(phase)
                self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
                self._require_closed_frontend()
                self._guard_external(force_canonical=True)
                migrate.write_json(self.directory, "host-restoration-observed.json", receipt)
                return receipt
            finally:
                self.guard_in_progress = False

    def _containment_receipt(self, state):
        require(isinstance(state, dict) and set(state) == {"phase", "mutationUncertain"}
                and state.get("phase") in ("baseline", "overlap", "current-only")
                and type(state.get("mutationUncertain")) is bool,
                "P2_ROTATION_CONTAINMENT_STATE_REFUSED")
        self.mutation_unresolved = self.mutation_unresolved or state["mutationUncertain"]
        return {"status": "P2_IDENTITY_ROTATION_CONTAINED", "phase": state["phase"],
                "mutationUncertain": self.mutation_unresolved,
                "newWork": False, "recovery": False, "active": 0, "uncertain": 0}

    def command(self, value):
        identity, operation = value.get("id"), value.get("operation")
        require(type(identity) is int and 0 < identity < 1_000_000, "P2_PROTOCOL_ID_REFUSED")
        self.check(); self.last_command = time.monotonic()
        if self._managed() and getattr(self, "frontend_close_prepared", False):
            require(operation in ("check", "rotation-session-closed", "commit"), "P2_ROTATION_MANAGED_CLOSE_ONLY")
        if operation == "check":
            self.send(identity, "HELD")
        elif operation == "rotation-arm":
            self.send(identity, "ROTATION_ARMED", receipt=self.arm(value))
        elif operation == "rotation-observe-runtime":
            self.send(identity, "ROTATION_OBSERVED", receipt=self.adapter.observe_runtime_boundary(self.runtime_phase))
        elif operation == "rotation-observe-frontend":
            self.send(identity, "ROTATION_OBSERVED", receipt=self.adapter.observe_frontend_configuration(self.frontend_phase))
        elif operation in ("rotation-apply-mutation", "rotation-reconcile-mutation"):
            self._mutate(identity, value)
        elif operation == "rotation-capture":
            self._capture(identity, value)
        elif operation == "rotation-observe-profiles":
            self.send(identity, "ROTATION_PROFILES_OBSERVED", receipt=self._observe_profiles(value))
        elif operation == "rotation-frontend-deployment":
            phase = value.get("phase")
            self._require_signer_split(phase)
            self.send(identity, "ROTATION_FRONTEND_DEPLOYMENT", receipt=self.adapter.frontend_deployment(signer_configuration_phase(phase)))
        elif operation == "rotation-observe-canonical-origin":
            self.send(identity, "ROTATION_CANONICAL_ORIGIN", receipt=self._issue_canonical_window_authority(value.get("phase")))
        elif operation == "rotation-browser-window-begin":
            self.send(identity, "ROTATION_BROWSER_WINDOW_INTENT", receipt=self._begin_window(value))
        elif operation == "rotation-browser-window-opened":
            self.send(identity, "ROTATION_BROWSER_WINDOW_OPENED", receipt=self._opened_window(value))
        elif operation == "rotation-browser-window-permit":
            self.send(identity, "ROTATION_BROWSER_WINDOW_PRIVATE_PERMIT", receipt=self._take_window_permit(value))
        elif operation == "rotation-browser-window-closing":
            self.send(identity, "ROTATION_BROWSER_WINDOW_CLOSING", receipt=self._closing_window(value))
        elif operation == "rotation-browser-window-end":
            self.send(identity, "ROTATION_BROWSER_WINDOW_CLOSED", receipt=self._end_window(value))
        elif operation == "rotation-retain-signer":
            self.send(identity, "ROTATION_SIGNER_RETAINED", receipt=self._retain_signer(value))
        elif operation == "rotation-observe-signer":
            require(set(value) == {"id", "operation", "phase"}, "P2_ROTATION_SIGNER_SPLIT_STATE_REQUIRED")
            self.send(identity, "ROTATION_SIGNER_OBSERVED", receipt=self._observe_signer(value.get("phase")))
        elif operation == "rotation-fail-closed":
            state = value.get("state")
            if self._managed():
                require(set(value) == {"id", "operation", "state"}, "P2_ROTATION_CONTAINMENT_STATE_REFUSED")
            receipt = self._containment_receipt(state)
            if self._managed():
                self.abort()
                raise ValueError("P2_ROTATION_MANAGED_GUARD_CONTAINMENT_REQUIRED")
            self.observer.probe("fence")
            proof = P2RecoveryPhysicalObserver.probe(self.observer, "observe")
            self.observer.exact(proof["admission"]["epoch"], False)
            self.window = None
            self.canonical_window_authority.clear()
            self._guard_external()
            self.contained = True
            self.send(identity, "ROTATION_CONTAINED", receipt=receipt)
        elif operation == "rotation-restore":
            require(not self._managed(), "P2_ROTATION_MANAGED_GUARD_CONTAINMENT_REQUIRED")
            self.send(identity, "ROTATION_RESTORED", receipt=self._restore(value))
            self.mutation_unresolved = False
        elif operation == "rotation-prepare-close":
            if self._managed():
                require(set(value) == {"id", "operation", "outcome"}, "P2_ROTATION_MANAGED_SESSION_CLOSE_REQUIRED")
            self.send(identity, "ROTATION_CLOSE_PREPARED", receipt=self._finish(value.get("outcome")))
        elif operation == "rotation-session-closed":
            self.send(identity, "ROTATION_JOINED", receipt=self._verify_frontend_session_closed(value))
        elif operation == "commit":
            require(self.finished and not self.failed.is_set(), "P2_ROTATION_JOIN_REQUIRED")
            if self._managed():
                require(set(value) == {"id", "operation"} and self.frontend_close_prepared and self.observer is None
                        and _receipt_bytes(migrate.read_json(self.directory, PREPARED_RECEIPT)) ==
                            _receipt_bytes(self.prepared_join)
                        and self.joined["frontendSessionCloseReceiptSha256"] == migrate.file_hash(
                            migrate.read_input(self.directory, SESSION_CLOSED_RECEIPT, 16_384)),
                        "P2_ROTATION_MANAGED_SESSION_CLOSE_CHANGED")
            else:
                self._guard_external()
            require(self.joined.get("status") == "P2_IDENTITY_KEY_ROTATION_QUALIFIED", "P2_ROTATION_JOIN_REQUIRED")
            migrate.write_json(self.directory, JOINED_RECEIPT, self.joined)
            self.safety({"operation": "committed", "sha256": migrate.file_hash(
                migrate.read_input(self.directory, JOINED_RECEIPT))})
            self.committed.set(); self.send(identity, "COMMITTED", receipt=self.joined)
            return False
        else:
            raise ValueError("P2_ROTATION_PROTOCOL_OPERATION_REFUSED")
        return True

    def abort(self):
        if self._managed() and getattr(self, "profiled_scope", None) is not None:
            self.profiled_scope.revoked.set()
        return super().abort()

    def contain_failure_without_guard(self):
        if not self._managed():
            return super().contain_failure_without_guard()
        for scope in (self.scope, getattr(self, "profiled_scope", None)):
            if scope is not None:
                try:
                    scope.revoke()
                except Exception:
                    self.outcome["workerProcessCleanupUncertain"] = True
        self.outcome.update(frontendAdmissionClosedOnFailure=None, independentGuardContainmentRequired=True)
        return False

    def close(self, committed=False):
        if hasattr(self, "guard_stop"):
            self.guard_stop.set()
        if hasattr(self, "rotation_guard") and self.rotation_guard is not threading.current_thread():
            self.rotation_guard.join(35)
        if not committed and getattr(self, "mutation_unresolved", False):
            self.outcome["mutationUncertain"] = True
            if self.pending_mutation is not None:
                intent = self.pending_mutation["intent"]
                self.outcome["unresolvedMutation"] = {key: intent[key] for key in ("phase", "kind")}
        if getattr(self, "profiled_scope", None) is not None:
            self.profiled_scope.closed = True
        super().close(committed)


def main():
    require(sys.argv[1:] == ["--supervisor"] and LIVE_ELIGIBLE, "P2_ROTATION_LIVE_EXECUTION_UNQUALIFIED")
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b"\n"), "P2_ROTATION_INITIAL_INPUT_REFUSED")
    initial = json.loads(raw)
    require(initial.get("mode") == "p2-identity-key-rotation", "P2_ROTATION_FIXED_MODE_REQUIRED")
    managed = type(initial.get("version")) is int and initial["version"] == 2
    if managed:
        from qualification_target_profile import decode_qualification_target_json
        initial = decode_qualification_target_json(raw, "private-packet")
        require(set(initial) == MANAGED_INITIAL_FIELDS, "P2_ROTATION_MANAGED_PRIVATE_PACKET_REQUIRED")
        validate_managed_rotation_initial(initial)
    # The shared supervisor must explicitly register ROTATION_LAYOUT and these
    # exact types before this source can become live-eligible.
    from p2_release_supervisor import supervise, ROTATION_LAYOUT
    supervise(initial, broker_type=P2IdentityRotationBroker,
              observer_type=ReplacementRotationPhysicalObserver if managed else P2IdentityRotationPhysicalObserver,
              observer_source=CERTIFICATION_OBSERVER if managed else OBSERVER_SOURCE, layout=ROTATION_LAYOUT)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print("P2_IDENTITY_KEY_ROTATION_FAILED_REQUIRES_REVIEW", file=sys.stderr)
        raise SystemExit(1)
