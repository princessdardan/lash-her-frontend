#!/usr/bin/env python3
"""Fixed supervised parent for the staging application-user key rotation.

This module has no standalone executor. The shared supervisor must select its
exact broker, observer, source program and layout. No caller command, callback
or JSON flag can substitute for that source selection.
"""
import base64
import copy
import hashlib
import json
from pathlib import Path
import re
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
from p2_release_broker import Broker, LOCK, MAXIMUM, decode
from p2_recovery_broker import P2RecoveryPhysicalObserver
from p2_identity_key_rotation_adapter import P2IdentityRotationHostAdapter, P2IdentityRotationScope
from uuid import uuid4

require = migrate.demand
PHASES = ("baseline", "overlap", "current-only")
WINDOWS = {"authentication": 300, "signer-read": 60}
OBSERVER_SOURCE = "ops/platform/p2-recovery-current-probe.mjs"


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
    def action_id(self):
        return self.initial["rotationActionId"]

    def directory_name(self):
        return "p2-identity-key-rotation-" + self.action_id()

    def terminal_filename(self):
        return "p2-identity-key-rotation-outcome.json"

    def select_release(self, initial):
        selected, jobs, plan, compose = runtime.make_plan(Path(initial["bundle"]), Path(initial["configuration"]),
                                                           self.source / "ops/platform/compose.yaml")
        rotation = initial.get("rotationPlan")
        require(selected == initial.get("candidate") and selected.get("contractPhase") == "p2"
                and selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"}
                and rotation.get("version") == 1 and rotation.get("environment") == "staging"
                and rotation.get("actionId") == initial.get("rotationActionId")
                and rotation.get("sourceCommit") == initial.get("sourceCommit")
                and rotation.get("candidateSha256") == initial.get("candidateSha256")
                and rotation.get("hostMachineId") == plan.get("hostMachineId"),
                "P2_ROTATION_REVIEWED_CANDIDATE_REQUIRED")
        return selected, jobs, plan, compose

    def initialize(self):
        super().initialize()
        p, rotation = self.initial, self.initial["rotationPlan"]
        require(p.get("mode") == "p2-identity-key-rotation"
                and p.get("confirmation") == "staging/" + self.action_id()
                and p.get("rotationActionId") == rotation["actionId"]
                and p.get("sourceSha256", {}).get(OBSERVER_SOURCE) == migrate.file_hash(
                    migrate.read_input(self.source, OBSERVER_SOURCE))
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
                and native_plan.get("configurationRecordSha256") == p.get("baselineConfigurationRecordSha256")
                and isinstance(private_probe, dict)
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
        self.mutation_unresolved = False
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

    def _canonical_private_directory(self, phase):
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
        if phase == "baseline":
            plan = copy.deepcopy(self.initial["nativePlan"])
        else:
            deployment = self.adapter.frontend_deployment(phase)
            plan = copy.deepcopy(self.initial["nativePlan"])
            plan.update(deploymentId=deployment["deploymentId"], deploymentUrl=deployment["deploymentUrl"],
                        configurationRecordSha256=deployment["workloadReceiptSha256"],
                        featureControls=copy.deepcopy(self.initial["expectedFeatureControls"]),
                        writerAdmissionBinding=copy.deepcopy(self.initial["expectedWriterAdmissionBinding"]))
        return {"candidate": self.selected, "plan": plan,
                "configurationRecordSha256": plan["configurationRecordSha256"],
                "privateProbeDirectory": str(self._canonical_private_directory(phase))}

    def _observe_canonical(self, phase, *, force=False):
        if not force and phase in self.canonical_observations and time.monotonic() - self.canonical_last_verified < 20:
            return copy.deepcopy(self.canonical_observations[phase])
        context = self._canonical_context(phase)
        value = canonical_origin.observe(context, LockedClient(self.vercel, self.check))
        require(value.get("browserOrigin") == canonical_origin.ORIGIN
                and value.get("deploymentId") == context["plan"]["deploymentId"],
                "P2_ROTATION_CANONICAL_ORIGIN_REFUSED")
        self.canonical_observations[phase] = copy.deepcopy(value)
        self.canonical_last_verified = time.monotonic()
        return copy.deepcopy(value)

    def _issue_canonical_window_authority(self, phase):
        require(phase in ("overlap", "current-only") and phase not in self.canonical_window_authority,
                "P2_ROTATION_CANONICAL_WINDOW_AUTHORITY_EXISTS")
        value = self._observe_canonical(phase, force=True)
        self.canonical_window_authority[phase] = {"value": copy.deepcopy(value), "completedKinds": set()}
        return value

    def arm(self, request):
        self.check()
        require(self.observer is None and self.scope is None, "P2_ROTATION_ALREADY_ARMED")
        raw, receipt = decode(request.get("receipt"))
        probe, rotation = request.get("probe"), self.initial["rotationPlan"]
        require(isinstance(probe, dict) and probe.get("job") == self.jobs["frontend"]["job"]
                and probe.get("baseline") == json.loads(self.jobs["frontend"]["schema"])
                and probe.get("receipt") == receipt and probe.get("owner") == self.initial.get("owner")
                and probe.get("targetSha256") == self.initial.get("targetSha256")
                and receipt.get("status") == "P2_RECOVERY_DATABASE_CURRENT"
                and receipt.get("sourceCommit") == rotation["sourceCommit"]
                and receipt.get("candidateSha256") == rotation["candidateSha256"]
                and receipt.get("trafficAuthorized") is False,
                "P2_ROTATION_CURRENT_FRONTEND_PROOF_REQUIRED")
        self.frontend_raw = raw
        self.safety({"operation": "armed", "probe": probe})
        self.observer = P2IdentityRotationPhysicalObserver(self.selected, probe, self.source,
            self.initial["credentials"]["FRONTEND_STAGING_MIGRATION_DATABASE_URL"], program=self.observer_program,
            program_sha256=self.initial["sourceSha256"][OBSERVER_SOURCE])
        self.observer.start(self.abort)
        public = {phase: rotation["configuration"][phase]["sha256"] for phase in PHASES}
        private = self.initial.get("privateRotationConfigurationSha256")
        self.scope = P2IdentityRotationScope(self.lock_fd, LOCK,
            self.check, receipt, rotation["candidateSha256"], action_id=self.action_id(),
            binding_sha256=rotation["bindingSha256"], source_commit=rotation["sourceCommit"],
            browser_program_sha256=self.browser_program_sha256,
            release=self.selected, jobs=self.jobs, configuration_sha256=public,
            private_configuration_sha256=private)
        self.adapter = P2IdentityRotationHostAdapter(self.scope, self.selected, self.jobs,
            self.rotation_configuration, self.configuration, self.directory, self.source / "ops/platform/compose.yaml", self.vercel,
            self.initial["gatewayHost"], self.source, self.initial["operatorProgramSha256"])
        self.armed_probe = copy.deepcopy(probe)
        self.guard_last_verified = time.monotonic()
        boundary = self.adapter.observe_runtime_boundary("baseline")
        self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
        self._observe_canonical("baseline", force=True)
        self._guard_external()
        self._start_rotation_guard()
        return {"status": "P2_IDENTITY_ROTATION_PARENT_ARMED", "actionId": self.action_id(),
                "bindingSha256": rotation["bindingSha256"], "sourceCommit": rotation["sourceCommit"],
                "candidateSha256": rotation["candidateSha256"], "trafficAuthorized": False}

    def _guard_external(self):
        with self.guard_mutex:
            self.guard_in_progress = True
            try:
                self.adapter.observe_continuous_runtime(self.runtime_phase, self.runtime_containers)
                value = self.adapter.observe_closed_gateway_and_native(self.runtime_phase)
                require(value.get("gatewayAdmissionClosed") is True and value.get("gatewayActive") == 0
                        and value.get("gatewayUncertain") == 0 and value.get("nativeSchedulesEnabled") is False,
                        "P2_ROTATION_EXTERNAL_GUARD_REFUSED")
                self._observe_canonical(self.frontend_phase)
                self.guard_last_verified = time.monotonic()
                return value
            finally:
                self.guard_in_progress = False

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
        if hasattr(self, "adapter"):
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
                and window.get("phase") in ("overlap", "current-only")
                and window.get("kind") in WINDOWS and window.get("maximumSeconds") == WINDOWS[window["kind"]]
                and window.get("sourceCommit") == rotation["sourceCommit"]
                and window.get("candidateSha256") == rotation["candidateSha256"]
                and window.get("configurationSha256") == rotation["configuration"][window["phase"]]["sha256"]
                and isinstance(window.get("source"), dict)
                and set(window["source"]) == {"challenge", "bindingSha256", "browserProgramSha256"}
                and re.fullmatch(r"[a-f0-9]{64}", window["source"].get("challenge", ""))
                and window["source"].get("bindingSha256") == rotation["bindingSha256"],
                "P2_ROTATION_BROWSER_WINDOW_BINDING_REFUSED")
        require(window["source"].get("browserProgramSha256") == self.browser_program_sha256,
                "P2_ROTATION_BROWSER_SOURCE_CHANGED")
        deployment = self.adapter.frontend_deployment(window["phase"])
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
        proof = self.observer.probe("observe")
        epoch = proof["admission"]["epoch"]
        require(proof["admission"] == {"epoch": epoch, "newWork": False, "recovery": False,
                                      "active": 0, "uncertain": 0},
                "P2_ROTATION_BROWSER_WINDOW_NOT_CLOSED")
        expected = self.observer.transition(epoch, True, window["maximumSeconds"])
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
        require(proof["admission"].get("epoch") == self.window["open"]
                and proof["admission"].get("newWork") is True and proof["admission"].get("recovery") is False,
                "P2_ROTATION_BROWSER_WINDOW_NOT_OPEN")
        self.observer.exact(self.window["open"], True, window["maximumSeconds"])
        self.window["stage"] = "open"
        return {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_OPENED", "epoch": self.window["open"],
                "phase": window["phase"], "kind": window["kind"], "bindingSha256": window["bindingSha256"]}

    def _closing_window(self, value):
        require(self.window is not None and self.window["stage"] == "open", "P2_ROTATION_BROWSER_WINDOW_STAGE_REFUSED")
        window = self._window_value(value)
        require(window == self.window["value"] and value.get("window", {}).get("epoch") == self.window["open"],
                "P2_ROTATION_BROWSER_CLOSE_EPOCH_REFUSED")
        self.window["closed"] = self.observer.transition(self.window["open"], False)
        self.window["stage"] = "closing"
        return {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSING", "epoch": self.window["open"],
                "phase": window["phase"], "kind": window["kind"]}

    def _end_window(self, value):
        require(self.window is not None and self.window["stage"] == "closing", "P2_ROTATION_BROWSER_WINDOW_STAGE_REFUSED")
        window, supplied = self._window_value(value), value.get("window")
        drain = supplied.get("drain")
        require(all(supplied.get(key) == item for key, item in self.window["value"].items())
                and supplied.get("epoch") == self.window["closed"]
                and isinstance(drain, dict) and drain.get("epoch") == self.window["closed"]
                and drain.get("newWork") is False and drain.get("recovery") is False
                and drain.get("active") == 0 and drain.get("uncertain") == 0 and drain.get("ledgerDrained") is True,
                "P2_ROTATION_BROWSER_WINDOW_DRAIN_REFUSED")
        proof = self.observer.probe("observe")
        require(proof["admission"] == {"epoch": self.window["closed"], "newWork": False, "recovery": False,
                                      "active": 0, "uncertain": 0},
                "P2_ROTATION_BROWSER_WINDOW_NOT_CLOSED")
        self.observer.exact(self.window["closed"], False)
        self._guard_external()
        result = {"status": "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSED", "epoch": self.window["closed"],
                  "phase": window["phase"], "kind": window["kind"], "active": 0, "uncertain": 0}
        migrate.write_json(self.directory, f"browser-{window['phase']}-{window['kind']}-closed.json", result)
        authority = self.canonical_window_authority[window["phase"]]
        authority["completedKinds"].add(window["kind"])
        if window["kind"] == "signer-read":
            require(authority["completedKinds"] == {"authentication", "signer-read"},
                    "P2_ROTATION_BROWSER_CANONICAL_WINDOW_INCOMPLETE")
            del self.canonical_window_authority[window["phase"]]
        self.window = None
        return result

    def _finish(self, outcome):
        rotation = self.initial["rotationPlan"]
        require(self.window is None and outcome.get("status") == "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED"
                and outcome.get("sourceMechanicsQualified") is True and outcome.get("keyRemovalVerified") is False
                and outcome.get("actionId") == self.action_id() and outcome.get("bindingSha256") == rotation["bindingSha256"]
                and outcome.get("sourceCommit") == rotation["sourceCommit"]
                and outcome.get("candidateSha256") == rotation["candidateSha256"]
                and outcome.get("lastFullyQualifiedPhase") == "current-only"
                and all(outcome.get(key) is False for key in ("sqlExecuted", "rolesPrepared", "loginChanged", "trafficAuthorized")),
                "P2_ROTATION_CONTROLLER_OUTCOME_REFUSED")
        self.observer.probe("observe")
        self._guard_external()
        signer = {"overlap": self.adapter.retained_frontend_signer("overlap"),
                  "current-only": self.adapter.observe_frontend_signer("current-only")}
        self.adapter.observe_api_configuration("current-only")
        profile_receipts = self.adapter.qualified_profile_evidence()
        profile_classes = {"course-learner": "actual-protected-course-http",
                           "course-admin": "actual-protected-course-http",
                           "community-member": "deployed-private-community-verifier",
                           "community-admin": "deployed-private-community-verifier"}
        result = {"version": 1, "status": "P2_IDENTITY_KEY_ROTATION_QUALIFIED", "environment": "staging",
                  "actionId": self.action_id(), "bindingSha256": rotation["bindingSha256"],
                  "sourceCommit": rotation["sourceCommit"], "candidateSha256": rotation["candidateSha256"],
                  "configurationSha256": rotation["configuration"]["current-only"]["sha256"],
                  "profileEvidenceClass": profile_classes,
                  "profileReceiptSha256": profile_receipts,
                  "frontendSignerReceiptSha256": {phase: value["receiptSha256"] for phase, value in signer.items()},
                  "keyRemovalVerified": True, "sourceParentDispatchIntegrated": True,
                  "sqlExecuted": False, "rolesPrepared": False, "loginChanged": False,
                  "nativeSchedulesEnabled": False, "trafficAuthorized": False,
                  "tokenBytesOutput": False, "credentialHashesOutput": False,
                  "communityMemberFeatureAdded": False, "newPublicEndpoint": False,
                  "releaseAccepted": False, "g2Accepted": False}
        migrate.write_json(self.directory, "p2-identity-key-rotation-qualified.json", result)
        self.closing_at = time.monotonic()
        self.observer.stop()
        self.guard_stop.set()
        if self.rotation_guard is not threading.current_thread():
            self.rotation_guard.join(35)
        require(not self.rotation_guard.is_alive(), "P2_ROTATION_GUARD_CLEANUP_UNVERIFIED")
        self.frontend_close_prepared = True
        self.safety({"operation": "prepareClose", "probe": self.armed_probe})
        self.prepared_join = copy.deepcopy(result)
        self.outcome.update(result)
        return result

    def _verify_frontend_session_closed(self):
        require(self.frontend_close_prepared and not self.finished and hasattr(self, "prepared_join"),
                "P2_ROTATION_CLOSE_NOT_PREPARED")
        require(self.closing_at is not None and time.monotonic() - self.closing_at < 10,
                "P2_ROTATION_CLOSE_TIMEOUT")
        program = self.source / "ops/platform/p2-identity-key-rotation-session-closed.mjs"
        expected = self.initial["sourceSha256"]["ops/platform/p2-identity-key-rotation-session-closed.mjs"]
        require(migrate.file_hash(program.read_bytes()) == expected, "P2_ROTATION_CLOSE_SOURCE_CHANGED")
        image = self.selected["artifacts"]["frontendMigration"]["image"]
        credential = self.initial["credentials"]["FRONTEND_STAGING_MIGRATION_DATABASE_URL"]
        container = "lash-p2-rotation-close-" + uuid4().hex
        args = ["docker", "run", "--rm", "--name", container, "--interactive", "--network", "host", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
                "--env", "FRONTEND_STAGING_MIGRATION_DATABASE_URL", "--mount",
                f"type=bind,src={program},dst=/app/ops/platform/p2-identity-key-rotation-session-closed.mjs,readonly",
                "--entrypoint", "node", image, "ops/platform/p2-identity-key-rotation-session-closed.mjs"]
        try:
            raw = self.scope.run(args, env={**runtime.SAFE_ENV, "FRONTEND_STAGING_MIGRATION_DATABASE_URL": credential},
                                 input=json.dumps({"version": 1, "operation": "verify-closed", "actionId": self.action_id(),
                                                   "probe": self.armed_probe}), timeout=8, check=True,
                                 capture_output=True, text=True).stdout.strip()
            require(len(raw.encode()) <= 16_384, "P2_ROTATION_CLOSE_RECEIPT_BOUNDS")
            value = json.loads(raw)
            require(value.get("status") == "P2_IDENTITY_ROTATION_FRONTEND_SESSION_CLOSED"
                    and value.get("actionId") == self.action_id()
                    and value.get("sourceCommit") == self.initial["rotationPlan"]["sourceCommit"]
                    and value.get("candidateSha256") == self.initial["rotationPlan"]["candidateSha256"]
                    and value.get("backendPid") == self.armed_probe["backendPid"]
                    and value.get("backendStart") == self.armed_probe["backendStart"]
                    and all(value.get(key) is expected_value for key, expected_value in {
                        "backendAbsent": True, "migrationLockReleased": True, "nonceLockReleased": True,
                        "newWork": False, "recovery": False, "sqlExecuted": False, "rolesPrepared": False,
                        "loginChanged": False, "trafficAuthorized": False}.items())
                    and value.get("active") == 0 and value.get("uncertain") == 0,
                    "P2_ROTATION_FRONTEND_SESSION_CLOSE_UNVERIFIED")
        finally:
            self.scope.run(["docker", "rm", "--force", container], env=runtime.SAFE_ENV, timeout=2,
                           check=False, capture_output=True, text=True)
        self.finished = True
        self.joined = copy.deepcopy(self.prepared_join)
        self.joined["frontendSessionCloseReceiptSha256"] = migrate.file_hash(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode())
        return self.joined

    def _restore(self, value):
        phase = value.get("phase")
        require(self.window is None and self.mutation_unresolved is False
                and phase == self.last_fully_qualified_phase and phase in ("baseline", "overlap"),
                "P2_ROTATION_RESTORATION_AUTHORITY_REFUSED")
        with self.guard_mutex:
            self.guard_in_progress = True
            try:
                receipt = self.adapter.restore_qualified(phase, value.get("configuration", {}).get("sha256"),
                    self.initial["expectedFeatureControls"], self.initial["expectedWriterAdmissionBinding"])
                self.runtime_phase = self.frontend_phase = phase
                boundary = self.adapter.observe_runtime_boundary(phase)
                self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
                if phase == "overlap":
                    require("overlap" in self.qualified_signers and "overlap" in self.qualified_profiles,
                            "P2_ROTATION_RESTORATION_AUTHORITY_REFUSED")
                    self.adapter.retained_frontend_signer("overlap")
                    self.adapter.retained_profile_evidence("overlap")
                self._guard_external()
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
        if operation == "check":
            self.send(identity, "HELD")
        elif operation == "rotation-arm":
            self.send(identity, "ROTATION_ARMED", receipt=self.arm(value))
        elif operation == "rotation-observe-runtime":
            self.send(identity, "ROTATION_OBSERVED", receipt=self.adapter.observe_runtime_boundary(self.runtime_phase))
        elif operation == "rotation-observe-frontend":
            self.send(identity, "ROTATION_OBSERVED", receipt=self.adapter.observe_frontend_configuration(self.frontend_phase))
        elif operation in ("rotation-apply-mutation", "rotation-reconcile-mutation"):
            intent = value.get("intent")
            method = self.adapter.apply_mutation if operation == "rotation-apply-mutation" else self.adapter.reconcile_mutation
            self.mutation_unresolved = True
            with self.guard_mutex:
                self.guard_in_progress = True
                try:
                    if operation == "rotation-apply-mutation":
                        receipt = method(intent, self.initial["expectedFeatureControls"], self.initial["expectedWriterAdmissionBinding"])
                    else:
                        receipt = method(intent)
                    self.mutation_unresolved = False
                    if intent["kind"] == "api": self.runtime_phase = intent["phase"]
                    else: self.frontend_phase = intent["phase"]
                    boundary = self.adapter.observe_runtime_boundary(self.runtime_phase)
                    self.runtime_containers = self.adapter.runtime_guard_containers(boundary["containers"])
                    self._guard_external()
                finally:
                    self.guard_in_progress = False
            self.send(identity, "ROTATION_MUTATION", receipt=receipt)
        elif operation == "rotation-capture":
            rotation = self.initial["rotationPlan"]
            self.send(identity, "ROTATION_CAPTURED", receipt=self.adapter.capture_tokens(
                rotation["subjects"], rotation["courseId"], rotation["bindingSha256"]))
        elif operation == "rotation-observe-profiles":
            rotation, phase = self.initial["rotationPlan"], value.get("phase")
            receipt = self.adapter.observe_profiles(phase, rotation["subjects"], rotation["courseId"])
            self.qualified_profiles.add(phase)
            if phase in self.qualified_signers:
                self.last_fully_qualified_phase = phase
            self.send(identity, "ROTATION_PROFILES_OBSERVED", receipt=receipt)
        elif operation == "rotation-frontend-deployment":
            self.send(identity, "ROTATION_FRONTEND_DEPLOYMENT", receipt=self.adapter.frontend_deployment(value.get("phase")))
        elif operation == "rotation-observe-canonical-origin":
            self.send(identity, "ROTATION_CANONICAL_ORIGIN", receipt=self._issue_canonical_window_authority(value.get("phase")))
        elif operation == "rotation-browser-window-begin":
            self.send(identity, "ROTATION_BROWSER_WINDOW_INTENT", receipt=self._begin_window(value))
        elif operation == "rotation-browser-window-opened":
            self.send(identity, "ROTATION_BROWSER_WINDOW_OPENED", receipt=self._opened_window(value))
        elif operation == "rotation-browser-window-closing":
            self.send(identity, "ROTATION_BROWSER_WINDOW_CLOSING", receipt=self._closing_window(value))
        elif operation == "rotation-browser-window-end":
            self.send(identity, "ROTATION_BROWSER_WINDOW_CLOSED", receipt=self._end_window(value))
        elif operation == "rotation-retain-signer":
            phase = value.get("phase")
            receipt = self.adapter.retain_frontend_signer(phase, value.get("record"))
            self.qualified_signers.add(phase)
            if phase in self.qualified_profiles:
                self.last_fully_qualified_phase = phase
            self.send(identity, "ROTATION_SIGNER_RETAINED", receipt=receipt)
        elif operation == "rotation-observe-signer":
            self.send(identity, "ROTATION_SIGNER_OBSERVED", receipt=self.adapter.observe_frontend_signer(value.get("phase")))
        elif operation == "rotation-fail-closed":
            state = value.get("state")
            receipt = self._containment_receipt(state)
            self.observer.probe("fence")
            proof = P2RecoveryPhysicalObserver.probe(self.observer, "observe")
            self.observer.exact(proof["admission"]["epoch"], False)
            self.window = None
            self.canonical_window_authority.clear()
            self._guard_external()
            self.send(identity, "ROTATION_CONTAINED", receipt=receipt)
        elif operation == "rotation-restore":
            self.send(identity, "ROTATION_RESTORED", receipt=self._restore(value))
        elif operation == "rotation-prepare-close":
            self.send(identity, "ROTATION_CLOSE_PREPARED", receipt=self._finish(value.get("outcome")))
        elif operation == "rotation-session-closed":
            self.send(identity, "ROTATION_JOINED", receipt=self._verify_frontend_session_closed())
        elif operation == "commit":
            require(self.finished and not self.failed.is_set(), "P2_ROTATION_JOIN_REQUIRED")
            self._guard_external()
            require(self.joined.get("status") == "P2_IDENTITY_KEY_ROTATION_QUALIFIED", "P2_ROTATION_JOIN_REQUIRED")
            migrate.write_json(self.directory, self.terminal_filename(), self.joined)
            self.safety({"operation": "committed", "sha256": migrate.file_hash(
                migrate.read_input(self.directory, self.terminal_filename()))})
            self.committed.set(); self.send(identity, "COMMITTED", receipt=self.joined)
            return False
        else:
            raise ValueError("P2_ROTATION_PROTOCOL_OPERATION_REFUSED")
        return True

    def close(self, committed=False):
        self.guard_stop.set()
        if hasattr(self, "rotation_guard") and self.rotation_guard is not threading.current_thread():
            self.rotation_guard.join(35)
        super().close(committed)


def main():
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b"\n"), "P2_ROTATION_INITIAL_INPUT_REFUSED")
    initial = json.loads(raw)
    require(initial.get("mode") == "p2-identity-key-rotation", "P2_ROTATION_FIXED_MODE_REQUIRED")
    # The shared supervisor must explicitly register ROTATION_LAYOUT and these
    # exact types before this source can become live-eligible.
    from p2_release_supervisor import supervise, ROTATION_LAYOUT
    supervise(initial, broker_type=P2IdentityRotationBroker, observer_type=P2IdentityRotationPhysicalObserver,
              observer_source=OBSERVER_SOURCE, layout=ROTATION_LAYOUT)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print("P2_IDENTITY_KEY_ROTATION_FAILED_REQUIRES_REVIEW", file=sys.stderr)
        raise SystemExit(1)
