import base64
import io
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
import os
import tempfile
import types
import sys

sys.path.insert(0, str(Path(__file__).parent))
import p2_identity_key_rotation_parent as parent
import p2_identity_key_rotation as rotation_source
import migrate
import p2_release_supervisor as supervisor
from p2_recovery_broker import P2RecoveryPhysicalObserver


class ObserverTest(unittest.TestCase):
    def observer(self):
        value = parent.P2IdentityRotationPhysicalObserver.__new__(parent.P2IdentityRotationPhysicalObserver)
        value.expectation_lock = threading.Lock()
        value.allowed = {("7", False, False)}
        value.window_deadline = None
        return value

    @staticmethod
    def proof(epoch, new_work, active=0, uncertain=0):
        return {"status": "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED",
                "admission": {"epoch": epoch, "newWork": new_work, "recovery": False,
                              "active": active, "uncertain": uncertain}}

    def test_exact_source_window_allows_only_one_active_writer_and_no_uncertain_operation(self):
        observer = self.observer()
        self.assertEqual(observer.transition("7", True, 60), "8")
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("8", True, active=1)):
            self.assertEqual(observer.probe("observe")["admission"]["active"], 1)
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("8", True, active=2)):
            with self.assertRaises(ValueError): observer.probe("observe")
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("8", True, uncertain=1)):
            with self.assertRaises(ValueError): observer.probe("observe")

    def test_window_expiry_and_closed_epoch_are_fail_closed(self):
        observer = self.observer()
        observer.allowed = {("8", True, False)}
        observer.window_deadline = time.monotonic() - 1
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("8", True)):
            with self.assertRaises(ValueError): observer.probe("observe")
        observer.allowed = {("9", False, False)}; observer.window_deadline = None
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("9", False)):
            self.assertFalse(observer.probe("observe")["admission"]["newWork"])
        with patch.object(P2RecoveryPhysicalObserver, "probe", return_value=self.proof("9", True)):
            with self.assertRaises(ValueError): observer.probe("observe")

    def test_closing_transition_does_not_extend_or_clear_the_open_window_deadline(self):
        observer = self.observer()
        observer.transition("7", True, 60)
        deadline = observer.window_deadline
        self.assertEqual(observer.transition("8", False), "9")
        self.assertEqual(observer.window_deadline, deadline)
        observer.exact("9", False)
        self.assertIsNone(observer.window_deadline)


class BrokerBindingTest(unittest.TestCase):
    def test_raw_rotation_source_and_embedded_private_program_have_distinct_bound_hashes(self):
        source = Path(__file__).resolve().parents[3]
        raw = migrate.file_hash(migrate.read_input(source, "ops/platform/p2-identity-key-rotation.mjs"))
        embedded = migrate.file_hash(rotation_source.private_program(source))
        self.assertNotEqual(raw, embedded)
        self.assertRegex(raw, r"^[a-f0-9]{64}$")
        self.assertRegex(embedded, r"^[a-f0-9]{64}$")

    def test_prepared_close_enters_bounded_closing_mode_before_inherited_check_can_touch_stopped_observer(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        directory = Path(tempfile.mkdtemp()); lock = directory / "release.lock"
        lock.write_bytes(b""); lock.chmod(0o600)
        descriptor = os.open(lock, os.O_RDWR)
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"alive")
            broker.failed = threading.Event(); broker.source = directory; broker.initial = {}
            broker.guard_read = read_fd; os.set_blocking(read_fd, False)
            broker.guard_alive = True; broker.last_guard = time.monotonic()
            broker.lock_fd = descriptor; broker.lock_info = os.fstat(descriptor)
            broker.observer = type("Stopped", (), {"verify": lambda _self: self.fail("stopped observer was queried")})()
            broker.closing_at = time.monotonic(); broker.finished = False
            broker.adapter = object(); broker.frontend_close_prepared = True
            broker.guard_stop = threading.Event(); broker.guard_stop.set()
            broker.guard_in_progress = False; broker.guard_last_verified = time.monotonic()
            info = os.fstat(descriptor)
            root_owned = types.SimpleNamespace(st_ino=info.st_ino, st_dev=info.st_dev,
                                               st_mode=info.st_mode, st_uid=0)
            with patch.object(parent, "LOCK", lock), \
                 patch("p2_release_broker.LOCK", lock), \
                 patch.object(parent, "verify_rotation_source_closure"), \
                 patch("p2_release_broker.os.lstat", return_value=root_owned):
                broker.check()
        finally:
            os.close(read_fd); os.close(write_fd); os.close(descriptor)

    def test_window_binding_is_exact_and_deployment_backed(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.initial = {"rotationActionId": "p2-key-rotation-owned", "rotationPlan": {"actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64,
            "candidateSha256": "c" * 64, "sourceCommit": "a" * 40,
            "configuration": {"overlap": {"sha256": "d" * 64}, "current-only": {"sha256": "e" * 64}}}}
        broker.adapter = type("Adapter", (), {"frontend_deployment": lambda _self, phase: {
            "deploymentId": "dpl_owned", "configurationSha256": "d" * 64 if phase == "overlap" else "e" * 64}})()
        broker.browser_program_sha256 = "9" * 64
        broker.canonical_window_authority = {"overlap": {"value": {
            "browserOrigin": "https://staging.lashher.com", "aliasReadbackSha256": "7" * 64,
            "protectedWorkloadSha256": "6" * 64}, "completedKinds": {"authentication"}}}
        window = {"version": 1, "actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64,
            "phase": "overlap", "kind": "signer-read", "maximumSeconds": 60,
            "source": {"challenge": "f" * 64, "bindingSha256": "b" * 64, "browserProgramSha256": "9" * 64}, "deploymentId": "dpl_owned",
            "configurationSha256": "d" * 64, "sourceCommit": "a" * 40, "candidateSha256": "c" * 64,
            "browserOrigin": "https://staging.lashher.com", "canonicalAliasReadbackSha256": "7" * 64,
            "canonicalProtectedWorkloadSha256": "6" * 64}
        self.assertEqual(broker._window_value({"window": window}), window)
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "maximumSeconds": 61}})
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "deploymentId": "dpl_other"}})
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "source": {**window["source"], "browserProgramSha256": "8" * 64}}})
        # A continuous observation has a fresh random workload challenge and
        # therefore a different digest. It must not invalidate the exact
        # source-issued window authority returned to the controller.
        broker.canonical_observations = {"overlap": {"protectedWorkloadSha256": "5" * 64}}
        self.assertEqual(broker._window_value({"window": window}), window)
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "canonicalProtectedWorkloadSha256": "5" * 64}})

    def test_containment_cannot_clear_a_host_recorded_unknown_mutation(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.mutation_unresolved = True
        receipt = broker._containment_receipt({"phase": "baseline", "mutationUncertain": False})
        self.assertTrue(receipt["mutationUncertain"])
        self.assertTrue(broker.mutation_unresolved)
        broker.mutation_unresolved = False
        receipt = broker._containment_receipt({"phase": "overlap", "mutationUncertain": True})
        self.assertTrue(receipt["mutationUncertain"])
        with self.assertRaises(ValueError):
            broker._containment_receipt({"phase": "baseline", "mutationUncertain": 0})


class TransitionGateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.broker = broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.directory = Path(self.directory.name)
        broker.initial = {"rotationActionId": "owned-rotation", "expectedFeatureControls": {},
                          "expectedWriterAdmissionBinding": {}, "rotationPlan": {
            "subjects": {}, "courseId": "owned-course", "bindingSha256": "b" * 64, "sourceCommit": "a" * 40,
            "candidateSha256": "c" * 64, "configuration": {
                phase: {"sha256": char * 64} for phase, char in zip(parent.PHASES, "def")}}}
        broker.runtime_phase = broker.frontend_phase = "baseline"
        broker.last_fully_qualified_phase = "baseline"
        broker.qualified_signers, broker.qualified_profiles = set(), set()
        broker.guard_mutex, broker.output_lock = threading.RLock(), threading.Lock()
        broker.guard_in_progress = False
        broker.window, broker.canonical_window_authority = None, {}
        broker.browser_program_sha256 = "7" * 64
        broker._initialize_transition_gate()
        self.now, self.monotonic = 1_800_000_000, 1_000
        wall = patch.object(parent.time, "time", side_effect=lambda: self.now)
        monotonic = patch.object(parent.time, "monotonic", side_effect=lambda: self.monotonic)
        wall.start()
        monotonic.start()
        self.addCleanup(wall.stop)
        self.addCleanup(monotonic.stop)
        self.admission = {"epoch": "7", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
        broker.observer = types.SimpleNamespace(probe=lambda operation: {"admission": dict(self.admission)},
                                                transition=lambda epoch, *_: str(int(epoch) + 1), exact=lambda *_: None)
        self.browser_permits = []
        broker.browser_scope = types.SimpleNamespace(prepare=self.prepare_writer_window, retain_closed=self.close_writer_window,
            take_private_authentication_permits=self.take_writer_permit, take_private_signer_permit=self.take_writer_permit)
        self.calls, self.wire, self.signers, self.profiles = [], [], {}, {}
        self.apply_error = False
        broker.check = lambda: None
        broker.emit = self.wire.append
        broker._guard_external = lambda **_: self.calls.append(("guard", broker.runtime_phase, broker.frontend_phase))
        broker._observe_canonical = lambda phase, **_: {"browserOrigin": parent.canonical_origin.ORIGIN,
            "aliasReadbackSha256": "8" * 64, "protectedWorkloadSha256": "9" * 64}
        broker.adapter = types.SimpleNamespace(
            output=broker.directory, _intent=lambda intent: intent, _result=parent.P2IdentityRotationHostAdapter._result,
            apply_mutation=self.apply, reconcile_mutation=self.reconcile,
            observe_runtime_boundary=lambda phase: {"containers": [phase]},
            observe_closed_gateway_and_native=lambda phase: {"gatewayAdmissionClosed": True, "gatewayActive": 0,
                                                               "gatewayUncertain": 0, "nativeSchedulesEnabled": False},
            runtime_guard_containers=lambda containers: containers,
            frontend_deployment=lambda phase: {"deploymentId": "dpl_" + phase.replace("-", ""), "configurationSha256": self.configuration(phase)},
            retain_frontend_signer=self.retain_signer, retained_frontend_signer=lambda phase: self.signers[phase],
            observe_frontend_signer=lambda phase: self.signers[phase],
            capture_tokens=self.capture, observe_profiles=self.observe_profiles, retained_profile_evidence=self.profile_digests,
            restore_qualified=lambda phase, *_: self.calls.append(("restore", phase)) or {"status": "restored"})

    def configuration(self, phase):
        return self.broker.initial["rotationPlan"]["configuration"][phase]["sha256"]

    def stamp(self, seconds):
        return parent.datetime.fromtimestamp(seconds, parent.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def advance_time(self, seconds):
        self.now += seconds
        self.monotonic += seconds

    def command(self, operation, **value):
        self.broker.command({"id": 2, "operation": operation, **value})
        return self.wire[-1].get("receipt")

    def intent(self, phase, kind):
        return {"phase": phase, "kind": kind, "actionId": "owned-rotation",
                "fromConfigurationSha256": self.configuration("baseline" if phase == "overlap" else "overlap"),
                "toConfigurationSha256": self.configuration(phase)}

    def mutation(self, phase, kind, *, reconcile=False, **changes):
        return self.command("rotation-reconcile-mutation" if reconcile else "rotation-apply-mutation",
                            intent={**self.intent(phase, kind), **changes})

    def apply(self, intent, *_):
        self.calls.append(("apply", intent["phase"], intent["kind"]))
        stem = "runtime" if intent["kind"] == "api" else "frontend"
        (self.broker.directory / f"{stem}-{intent['phase']}").mkdir(mode=0o700)
        if self.apply_error:
            raise ValueError("owned-unknown-ack")
        return self.broker.adapter._result(intent, False)

    def reconcile(self, intent):
        self.calls.append(("reconcile", intent["phase"], intent["kind"]))
        return self.broker.adapter._result(intent, True)

    def retain_signer(self, phase, record):
        self.calls.append(("retain", phase))
        receipt = {"issuanceCutoffAt": record["windowCompletedAt"], "receiptSha256": "a" * 64}
        self.signers[phase] = receipt
        return dict(receipt)

    def capture(self, *_):
        self.calls.append(("capture",))
        return [{"status": parent.CAPTURE_STATUS, "profile": profile, "tokenIssuedAt": self.stamp(self.now),
                 "tokenExpiresAt": self.stamp(self.now + 300)} for profile in parent.CAPTURE_PROFILES]

    def observe_profiles(self, phase, *_):
        self.calls.append(("profiles", phase))
        self.profiles[phase] = [{"profile": profile, "oldTokenIssuedAt": row["tokenIssuedAt"],
                                 "oldTokenExpiresAt": row["tokenExpiresAt"]}
                                for profile, row in self.broker.capture_metadata.items()]
        return self.profiles[phase]

    def profile_digests(self, phase):
        return {row["profile"]: migrate.file_hash(parent.json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
                for row in self.profiles[phase]}

    def prepare_writer_window(self, window):
        epoch = self.admission["epoch"]
        increments = (1, 2) if window["kind"] == "authentication" else (0, 0)
        return {"beforeEpoch": epoch, "permitEpoch": str(int(epoch) + increments[0]), "closedEpoch": str(int(epoch) + increments[1])}

    def close_writer_window(self, window):
        epoch = self.admission["epoch"]
        permit_epoch = str(int(epoch) - 1) if window["kind"] == "authentication" else epoch
        receipt = {"closedEpoch": epoch, "permitEpoch": permit_epoch}
        migrate.write_json(self.broker.directory, f"browser-{window['phase']}-{window['kind']}-writer-scope.json", receipt)
        return receipt

    def take_writer_permit(self, window):
        self.browser_permits.append((window["phase"], window["kind"], dict(self.admission)))
        return {"epoch": self.admission["epoch"]}

    def close_windows(self, phase):
        canonical = self.command("rotation-observe-canonical-origin", phase=phase)
        rotation = self.broker.initial["rotationPlan"]
        common = {"version": 1, "actionId": "owned-rotation", "phase": phase,
                  **{key: rotation[key] for key in ("bindingSha256", "sourceCommit", "candidateSha256")},
                  **self.broker.adapter.frontend_deployment(parent.signer_configuration_phase(phase)),
                  "source": {"challenge": "5" * 64, "bindingSha256": rotation["bindingSha256"],
                             "browserProgramSha256": self.broker.browser_program_sha256},
                  "browserOrigin": canonical["browserOrigin"], "canonicalAliasReadbackSha256": canonical["aliasReadbackSha256"],
                  "canonicalProtectedWorkloadSha256": canonical["protectedWorkloadSha256"]}
        for kind, maximum in parent.WINDOWS.items():
            window = {**common, "kind": kind, "maximumSeconds": maximum}
            intent = self.command("rotation-browser-window-begin", window=window)
            writing = kind == "authentication"
            self.admission.update(epoch=intent["expectedOpenEpoch"], newWork=writing, recovery=writing)
            opened = {**window, "epoch": self.admission["epoch"]}
            self.command("rotation-browser-window-opened", window=opened)
            self.command("rotation-browser-window-permit", window=opened)
            with self.assertRaisesRegex(ValueError, "PRIVATE_PERMIT_REFUSED"):
                self.command("rotation-browser-window-permit", window=opened)
            self.command("rotation-browser-window-closing", window=opened)
            self.admission.update(epoch=str(int(self.admission["epoch"]) + int(writing)), newWork=False, recovery=False)
            self.command("rotation-browser-window-end", window={**window, "epoch": self.admission["epoch"],
                         "drain": {**self.admission, "ledgerDrained": True}})
        return {key: common[key] for key in ("phase", "bindingSha256", "deploymentId", "configurationSha256",
                "browserOrigin", "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256")} | {
                "challenge": common["source"]["challenge"], "browserProgramSha256": self.broker.browser_program_sha256, "windowStartedAt": self.stamp(self.now),
                "windowCompletedAt": self.stamp(self.now)}

    def qualify_signer(self, phase):
        record = self.close_windows(phase)
        self.command("rotation-retain-signer", phase=phase, record=record)
        return self.command("rotation-observe-signer", phase=phase)

    def test_rotation_requires_exact_order_closed_windows_drain_and_fresh_token_evidence(self):
        for phase, kind in (("overlap", "frontend"), ("current-only", "frontend"), ("current-only", "api")):
            with self.assertRaisesRegex(ValueError, "MUTATION_ORDER"):
                self.mutation(phase, kind)
        self.admission["active"] = 1
        with self.assertRaisesRegex(ValueError, "FRONTEND_NOT_CLOSED"):
            self.mutation("overlap", "api")
        self.admission["active"] = 0
        self.assertFalse(any(call[0] == "apply" for call in self.calls))
        self.mutation("overlap", "api")
        with self.assertRaisesRegex(ValueError, "MUTATION_ORDER"):
            self.mutation("overlap", "api")
        with self.assertRaisesRegex(ValueError, "SIGNER_SPLIT"):
            self.command("rotation-observe-canonical-origin", phase="overlap")
        self.mutation("overlap", "frontend")
        with self.assertRaisesRegex(ValueError, "HOST_SIGNER_WINDOW_REQUIRED"):
            self.command("rotation-retain-signer", phase="overlap", record={})
        record = self.close_windows("overlap")
        with self.assertRaisesRegex(ValueError, "HOST_SIGNER_WINDOW_BINDING"):
            self.command("rotation-retain-signer", phase="overlap", record={**record, "canonicalAliasReadbackSha256": "4" * 64})
        self.command("rotation-retain-signer", phase="overlap", record=record)
        with self.assertRaisesRegex(ValueError, "OVERLAP_SIGNER_REQUIRED"):
            self.mutation("current-only", "frontend")
        self.command("rotation-observe-signer", phase="overlap")
        self.advance_time(329)
        with self.assertRaisesRegex(ValueError, "OVERLAP_DRAIN_INCOMPLETE"):
            self.mutation("current-only", "frontend")
        self.now += 10  # UTC advancing alone cannot shorten the monotonic drain.
        with self.assertRaisesRegex(ValueError, "OVERLAP_DRAIN_INCOMPLETE"):
            self.mutation("current-only", "frontend")
        self.advance_time(1)
        self.now -= 11
        with self.assertRaisesRegex(ValueError, "OVERLAP_DRAIN_INCOMPLETE"):
            self.mutation("current-only", "frontend")
        self.now += 1
        self.mutation("current-only", "frontend")
        with self.assertRaisesRegex(ValueError, "CAPTURE_SPLIT_STATE"):
            self.command("rotation-capture")
        self.qualify_signer("current-only")
        with self.assertRaisesRegex(ValueError, "PRE_REMOVAL_EVIDENCE"):
            self.mutation("current-only", "api")
        captures = self.command("rotation-capture")
        self.assertEqual({key for row in captures for key in row}, set(parent.CAPTURE_METADATA_FIELDS))
        with self.assertRaisesRegex(ValueError, "CAPTURE_SPLIT_STATE"):
            self.command("rotation-capture")
        with self.assertRaisesRegex(ValueError, "PROFILE_SPLIT_STATE"):
            self.command("rotation-observe-profiles", phase="current-only")
        self.command("rotation-observe-profiles", phase="overlap")
        with self.assertRaisesRegex(ValueError, "PROFILE_SPLIT_STATE"):
            self.command("rotation-observe-profiles", phase="overlap")
        with patch.object(self.broker.adapter, "retained_profile_evidence", return_value={}):
            with self.assertRaisesRegex(ValueError, "PRE_REMOVAL_EVIDENCE"):
                self.mutation("current-only", "api")
        self.now += 300
        with self.assertRaisesRegex(ValueError, "HELD_CAPTURE_REQUIRED"):
            self.mutation("current-only", "api")
        self.now -= 300
        self.mutation("current-only", "api")
        with self.assertRaisesRegex(ValueError, "SIGNER_SPLIT_STATE"):
            self.command("rotation-observe-canonical-origin", phase="post-removal")
        self.command("rotation-observe-profiles", phase="current-only")
        self.assertEqual(self.broker.last_fully_qualified_phase, "overlap")
        self.qualify_signer("post-removal")
        self.assertEqual(self.broker.last_fully_qualified_phase, "current-only")
        for phase, kind, admission in self.browser_permits:
            self.assertEqual(admission["newWork"], kind == "authentication", phase)
            self.assertEqual(admission["recovery"], kind == "authentication", phase)
        self.assertEqual([call for call in self.calls if call[0] == "apply"],
                         [("apply", phase, kind) for phase, kind, _ in parent.MUTATIONS])
        self.assertEqual(self.calls.count(("capture",)), 1)

    def test_unknown_ack_keeps_exact_attempt_and_only_allows_matching_reconciliation_once(self):
        with self.assertRaisesRegex(ValueError, "RECONCILIATION_AUTHORITY"):
            self.mutation("overlap", "api", reconcile=True)
        self.apply_error = True
        with self.assertRaisesRegex(ValueError, "owned-unknown-ack"):
            self.mutation("overlap", "api")
        self.assertTrue(self.broker.mutation_unresolved)
        self.assertEqual(self.broker.mutation_step, 0)
        with self.assertRaisesRegex(ValueError, "MUTATION_ORDER"):
            self.mutation("overlap", "api")
        with self.assertRaisesRegex(ValueError, "RECONCILIATION_AUTHORITY"):
            self.mutation("overlap", "api", reconcile=True, toConfigurationSha256="9" * 64)
        attempt = self.broker.directory / "host-overlap-api-attempted.json"
        original = attempt.read_bytes()
        attempt.write_text("{}")
        with self.assertRaisesRegex(ValueError, "RECONCILIATION_AUTHORITY"):
            self.mutation("overlap", "api", reconcile=True)
        attempt.write_bytes(original)
        self.mutation("overlap", "api", reconcile=True)
        self.assertFalse(self.broker.mutation_unresolved)
        self.assertEqual(self.broker.mutation_step, 1)
        with self.assertRaisesRegex(ValueError, "MUTATION_ORDER"):
            self.mutation("overlap", "api", reconcile=True)
        self.assertEqual([call for call in self.calls if call[0] in ("apply", "reconcile")],
                         [("apply", "overlap", "api"), ("reconcile", "overlap", "api")])

    def test_failed_reconciliation_keeps_uncertainty_without_a_second_attempt(self):
        self.apply_error = True
        with self.assertRaisesRegex(ValueError, "owned-unknown-ack"):
            self.mutation("overlap", "api")
        with patch.object(self.broker.adapter, "reconcile_mutation", side_effect=ValueError("owned-unverified")) as reconcile:
            with self.assertRaisesRegex(ValueError, "owned-unverified"):
                self.mutation("overlap", "api", reconcile=True)
            with self.assertRaisesRegex(ValueError, "RECONCILIATION_AUTHORITY"):
                self.mutation("overlap", "api", reconcile=True)
        reconcile.assert_called_once()
        self.assertTrue(self.broker.mutation_unresolved)

    def test_wire_ack_failure_keeps_the_transition_uncertain(self):
        with patch.object(self.broker, "emit", side_effect=BrokenPipeError):
            with self.assertRaises(BrokenPipeError):
                self.mutation("overlap", "api")
        self.assertTrue(self.broker.mutation_unresolved)
        self.assertEqual(self.broker.pending_mutation["intent"], self.intent("overlap", "api"))
        self.assertEqual(self.broker.mutation_step, 0)
        self.assertEqual(migrate.read_json(self.broker.directory, "host-overlap-api-observed.json"),
                         self.broker.adapter._result(self.intent("overlap", "api"), False))

    def test_restoration_requires_contained_split_and_cannot_repeat(self):
        self.mutation("overlap", "api")
        configuration = {"sha256": self.configuration("baseline")}
        with self.assertRaisesRegex(ValueError, "RESTORATION_AUTHORITY"):
            self.command("rotation-restore", phase="baseline", configuration=configuration)
        self.broker.contained = True
        with self.assertRaisesRegex(ValueError, "RESTORATION_AUTHORITY"):
            self.command("rotation-restore", phase="overlap", configuration=configuration)
        self.command("rotation-restore", phase="baseline", configuration=configuration)
        self.assertEqual((self.broker.runtime_phase, self.broker.frontend_phase), ("baseline", "baseline"))
        self.assertFalse(self.broker.mutation_unresolved)
        with self.assertRaisesRegex(ValueError, "RESTORATION_AUTHORITY"):
            self.command("rotation-restore", phase="baseline", configuration=configuration)
        self.assertEqual(self.calls.count(("restore", "baseline")), 1)
        self.assertEqual(self.broker.restored_frontend_phase, "baseline")

    def test_baseline_canonical_context_requires_the_exact_provider_inventory(self):
        broker = self.broker
        broker.selected = {"releaseId": "owned-release"}
        broker.initial["nativePlan"] = {"deploymentId": "dpl_baseline", "configurationRecordSha256": "a" * 64}
        directory = broker.directory / "baseline"
        with patch.object(broker, "_canonical_private_directory", return_value=directory), \
                patch.object(broker.adapter, "observe_frontend_configuration", create=True) as provider:
            provider.return_value = {"deploymentId": "dpl_baseline", "configurationSha256": self.configuration("baseline")}
            self.assertEqual(broker._canonical_context("baseline")["privateProbeDirectory"], str(directory))
            for field, value in (("deploymentId", "dpl_changed"), ("configurationSha256", "b" * 64)):
                with self.subTest(field=field):
                    original = provider.return_value
                    provider.return_value = {**original, field: value}
                    with self.assertRaisesRegex(ValueError, "BASELINE_FRONTEND_CONFIGURATION_UNVERIFIED"):
                        broker._canonical_context("baseline")
                    provider.return_value = original

    def test_managed_canonical_observation_uses_day_two_workload_without_old_probe_directory(self):
        broker = self.broker
        del broker._observe_canonical
        profile = dict(parent.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        broker.selected = {"qualificationTargetProfile": profile}
        broker.initial.update(version=2, qualificationTargetProfile=profile, scopedCronSecret="owned-fixture",
            nativePlan={"qualificationTargetProfile": profile, "deploymentId": "dpl_baseline", "configurationRecordSha256": "a" * 64})
        broker.canonical_observations = {}
        broker.vercel = object()
        observed = {"browserOrigin": parent.canonical_origin.ORIGIN, "deploymentId": "dpl_baseline"}
        with patch.object(broker.adapter, "observe_frontend_configuration", create=True) as provider, \
                patch.object(parent.canonical_origin, "observe", side_effect=AssertionError("legacy probe refused")), \
                patch.object(parent.day_two_workload, "observe_browser_origin", return_value=observed) as day_two:
            provider.return_value = {"deploymentId": "dpl_baseline", "configurationSha256": self.configuration("baseline")}
            self.assertEqual(broker._observe_canonical("baseline", force=True), observed)
            self.assertNotIn("privateProbeDirectory", day_two.call_args.args[0])
            self.assertEqual(day_two.call_args.kwargs["expected_profile"], parent.migrate.profile_context(profile))

    def test_restoration_canonical_context_joins_the_new_deployment_and_private_probe(self):
        broker = self.broker
        broker.selected = {"releaseId": "owned-release"}
        broker.initial["nativePlan"] = {"deploymentId": "dpl_original"}
        broker.restored_frontend_phase = "baseline"
        attempt = broker.directory / "frontend-restoration-baseline"
        private = broker.directory / "frontend-restoration-baseline-private"
        for directory in (attempt, private):
            directory.mkdir(mode=0o700)
        deployment_id = "dpl_restored"
        url = "https://owned-restore.vercel.app"
        migrate.write_json(attempt, "frontend-build-outcome.json", {"url": url})
        migrate.write_json(attempt, "frontend-promotion-outcome.json", {
            "status": "FRONTEND_DOMAINS_PROMOTED", "frontendDomainsPromoted": True, "deploymentId": deployment_id})
        migrate.write_json(attempt, "frontend-workload-outcome.json", {
            "status": "FRONTEND_VERIFIED", "deploymentId": deployment_id})
        with patch.object(parent.vercel, "_staged_identity", return_value={"deploymentId": deployment_id}), \
                patch.object(broker.adapter, "observe_frontend_configuration", create=True) as provider:
            provider.return_value = {"deploymentId": deployment_id}
            context = broker._canonical_context("baseline")
            self.assertEqual(context["privateProbeDirectory"], str(private))
            self.assertEqual(context["plan"]["deploymentId"], deployment_id)
            self.assertEqual(context["plan"]["deploymentUrl"], url)
            self.assertEqual(context["configurationRecordSha256"],
                             migrate.file_hash(migrate.read_input(attempt, "frontend-workload-outcome.json")))
            provider.return_value = {"deploymentId": "dpl_original"}
            with self.assertRaisesRegex(ValueError, "RESTORED_FRONTEND_DEPLOYMENT_UNVERIFIED"):
                broker._canonical_context("baseline")


class ManagedRotationBrokerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.receipt = {"version": 2, "status": "P2_CERTIFICATION_DATABASE_CURRENT",
                        "admission": {"epoch": "5", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}}
        self.probe = {"receipt": self.receipt, "backendPid": 31, "producers": []}
        initial = {"version": 2, "rotationActionId": "p2-key-rotation-owned", "scopedCronSecret": "x" * 32,
                   "rotationConfiguration": str(self.directory), "gatewayHost": "owned.invalid", "operatorProgramSha256": "a" * 64,
                   "rotationPlan": {"actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64,
                       "candidateSha256": "c" * 64, "sourceCommit": "d" * 40, "finalEpoch": "11",
                       "frontendCustodyPlanSha256": "e" * 64,
                       "configuration": {phase: {"sha256": "f" * 64} for phase in parent.PHASES}}}
        self.broker = parent.P2IdentityRotationBroker(initial, Mock())
        self.broker.check = Mock()
        self.broker.safety = Mock()
        self.broker.directory = self.broker.configuration = self.broker.source = self.directory
        self.broker.lock_fd = 9
        self.broker.browser_program_sha256 = "2" * 64
        self.broker.selected, self.broker.jobs = {"releaseId": "original"}, {}
        self.broker.rotation_configuration = self.directory
        self.broker.vercel = Mock()
        self.broker.guard_stop = threading.Event()
        self.broker.rotation_guard = Mock()
        self.broker.rotation_guard.is_alive.return_value = False
        self.broker._observe_canonical = Mock()
        self.broker._canonical_profile = Mock(return_value={"id": "selected", "sha256": "3" * 64})
        self.broker._guard_external = Mock()
        self.broker._record_managed_inventory = Mock()
        self.broker._start_rotation_guard = Mock()
        self.broker.frontend_close_prepared = False
        self.broker.managed_close_prepare_started = self.broker.managed_close_started = None
        self.broker.contained = False
        self.broker.mutation_unresolved = False
        self.broker.profiled_scope = None
        self.broker.replacement_custody = Mock()
        self.observer = Mock()
        self.broker.replacement_custody.scope_observer = self.observer
        self.broker.replacement_custody.open_scope.return_value = Mock()
        self.request = {"id": 1, "operation": "rotation-arm", "probe": self.probe,
                        "receipt": base64.b64encode(json.dumps(self.receipt).encode()).decode()}

    def test_managed_arm_waits_for_independent_marker_before_typed_scope(self):
        import p2_identity_rotation_browser_scope as browser

        broker = self.broker
        adapter = Mock()
        adapter.observe_runtime_boundary.return_value = {"containers": []}
        order = Mock()
        order.attach_mock(broker.safety, "send_arm")
        order.attach_mock(broker.replacement_custody.open_scope, "open_scope")
        with (patch.object(supervisor, "require_managed_rotation_guard_arm", create=True,
                          side_effect=(FileNotFoundError, None)) as marker,
              patch.object(parent.time, "sleep"),
              patch.object(parent, "P2IdentityRotationScope") as typed,
              patch.object(parent, "P2IdentityRotationHostAdapter", return_value=adapter),
              patch.object(browser, "P2IdentityRotationBrowserScope") as browser_scope):
            order.attach_mock(marker, "guard_marker")
            result = broker.arm(self.request)
        self.assertEqual([row[0] for row in order.mock_calls], ["send_arm", "guard_marker", "guard_marker", "open_scope"])
        broker.replacement_custody.validate_arm_probe.assert_called_once_with(self.probe)
        self.assertEqual(typed.call_args.args[3], self.receipt)
        self.assertIs(typed.call_args.kwargs["replacement_custody"], broker.replacement_custody)
        self.assertIs(typed.call_args.kwargs["profiled_scope"], broker.profiled_scope)
        self.assertEqual(broker.armed_probe, self.probe)
        browser_scope.assert_called_once_with(broker, broker.initial["scopedCronSecret"])
        broker._record_managed_inventory.assert_called_once_with("baseline")
        self.assertEqual(result["status"], "P2_IDENTITY_ROTATION_PARENT_ARMED")
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["qualificationTargetProfile"], broker._canonical_profile())
        self.assertIs(result["trafficAuthorized"], False)
        proof = {"admission": self.receipt["admission"], "producers": [], "operations": []}
        broker.replacement_custody.observe_writer_scope.return_value = proof
        self.assertEqual(broker.observe_rotation_browser_writer_scope("6"), proof)
        broker.replacement_custody.observe_writer_scope.assert_called_once_with(self.probe, "6")

    def test_bad_guard_marker_cannot_start_scope_or_adapter(self):
        broker = self.broker
        with (patch.object(supervisor, "require_managed_rotation_guard_arm", create=True, side_effect=ValueError("marker mismatch")),
              patch.object(parent, "P2IdentityRotationHostAdapter") as adapter,
              self.assertRaisesRegex(ValueError, "marker mismatch")):
            broker.arm(self.request)
        broker.replacement_custody.open_scope.assert_not_called()
        adapter.assert_not_called()

    def test_managed_prepare_waits_for_final_inventory_and_local_observer_stop(self):
        broker = self.broker
        rotation = broker.initial["rotationPlan"]
        broker.window = None
        broker.mutation_step = len(parent.MUTATIONS)
        broker.runtime_phase = broker.frontend_phase = "current-only"
        broker.profile_evidence = {
            phase: {profile: "4" * 64 for profile in parent.CAPTURE_PROFILES}
            for phase in ("overlap", "current-only")}
        broker.qualified_signers = set(parent.SIGNER_PHASES)
        broker.retained_signers = {phase: {"receiptSha256": "5" * 64} for phase in parent.SIGNER_PHASES}
        broker.adapter = Mock()
        broker.adapter.retained_frontend_signer.side_effect = broker.retained_signers.__getitem__
        broker.adapter.observe_frontend_signer.side_effect = broker.retained_signers.__getitem__
        broker.adapter.qualified_profile_evidence.return_value = {
            profile: {phase: broker.profile_evidence[phase][profile] for phase in broker.profile_evidence}
            for profile in parent.CAPTURE_PROFILES}
        broker.runtime_containers = [{"service": "course"}]
        broker.adapter.observe_runtime_boundary.return_value = {"containers": [], "courseCurrent": True, "communityCurrent": True}
        broker.observer = self.observer
        broker.observer.probe.return_value = {"admission": {**self.receipt["admission"], "epoch": rotation["finalEpoch"]}}
        broker.profiled_scope = Mock()
        broker.browser_scope = types.SimpleNamespace(closed_epoch=rotation["finalEpoch"], completed=[None] * 6)
        outcome = {key: rotation[key] for key in ("actionId", "bindingSha256", "sourceCommit", "candidateSha256")}
        outcome.update(status="P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED", sourceMechanicsQualified=True,
                       keyRemovalVerified=False, lastFullyQualifiedPhase="current-only",
                       postRemovalFrontendSignerReceiptSha256=broker.retained_signers["post-removal"]["receiptSha256"],
                       sqlExecuted=False, rolesPrepared=False, loginChanged=False, trafficAuthorized=False)
        receipt_path = self.directory / parent.PREPARED_RECEIPT
        broker.adapter.runtime_guard_containers.return_value = [{"service": "foreign"}]
        with self.assertRaisesRegex(ValueError, "MANAGED_FINAL_RUNTIME_CHANGED"):
            broker._finish(outcome)
        self.observer.stop.assert_not_called()
        self.assertFalse(receipt_path.exists())

        def stopping():
            self.assertTrue(broker.frontend_close_prepared)
            self.assertIsNone(broker.managed_close_started)
            self.assertIsNone(broker.observer)
            self.assertFalse(receipt_path.exists())

        broker.adapter.runtime_guard_containers.return_value = broker.runtime_containers
        self.observer.stop.side_effect = stopping
        prepared = broker._finish(outcome)
        self.observer.stop.assert_called_once_with()
        self.assertTrue(broker.profiled_scope.closed)
        self.assertEqual(prepared["version"], 2)
        self.assertEqual(prepared["frontendFinalEpoch"], rotation["finalEpoch"])
        self.assertEqual(prepared["frontendCustodyPlanSha256"], rotation["frontendCustodyPlanSha256"])
        self.assertEqual(migrate.read_json(self.directory, parent.PREPARED_RECEIPT), prepared)
        self.assertGreaterEqual(broker.managed_close_started, broker.managed_close_prepare_started)
        self.assertFalse((self.directory / parent.SESSION_CLOSED_RECEIPT).exists())

    def test_managed_terminal_requires_exact_node_and_host_closure_and_skips_provider_after_close(self):
        broker = self.broker
        broker.armed_probe = self.probe
        broker.frontend_close_prepared = True
        broker.managed_close_started = time.monotonic()
        broker.prepared_join = {"version": 2, "status": "P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED", "keyRemovalVerified": False,
                                "frontendFinalEpoch": "11"}
        migrate.write_json(self.directory, parent.PREPARED_RECEIPT, broker.prepared_join)
        proof = {"version": 2, "status": "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED",
                 "admission": {"epoch": "11", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}}
        broker.replacement_custody.verify_closed.return_value = proof
        request = {"id": 3, "operation": "rotation-session-closed"}
        with self.assertRaisesRegex(ValueError, "MANAGED_SESSION_CLOSE_REQUIRED"):
            broker.command(request)
        with self.assertRaisesRegex(ValueError, "MANAGED_SESSION_CLOSE_CHANGED"):
            broker.command({**request, "frontendSessionClosed": {**proof, "version": 1}})
        self.assertFalse((self.directory / parent.SESSION_CLOSED_RECEIPT).exists())
        broker.command({**request, "frontendSessionClosed": proof})
        broker.replacement_custody.verify_closed.assert_called_with(self.probe, "11")
        self.assertEqual(migrate.read_json(self.directory, parent.SESSION_CLOSED_RECEIPT), proof)
        with self.assertRaisesRegex(ValueError, "MANAGED_CLOSE_ONLY"):
            broker.command({"id": 4, "operation": "rotation-observe-frontend"})
        self.assertFalse(broker.command({"id": 5, "operation": "commit"}))
        broker._guard_external.assert_not_called()
        self.assertTrue(broker.committed.is_set())
        self.assertEqual(migrate.read_json(self.directory, parent.JOINED_RECEIPT), broker.joined)
        self.assertFalse((self.directory / broker.terminal_filename()).exists())

    def test_managed_failure_defers_to_guard_and_cannot_restore_or_call_legacy_fence(self):
        broker = self.broker
        broker.observer = self.observer
        broker.profiled_scope = Mock()
        broker.scope = Mock()
        broker._restore = Mock()
        with self.assertRaisesRegex(ValueError, "MANAGED_GUARD_CONTAINMENT_REQUIRED"):
            broker.command({"id": 1, "operation": "rotation-restore"})
        broker._restore.assert_not_called()
        with patch.object(broker, "abort") as abort, self.assertRaisesRegex(ValueError, "MANAGED_GUARD_CONTAINMENT_REQUIRED"):
            broker.command({"id": 2, "operation": "rotation-fail-closed",
                            "state": {"phase": "overlap", "mutationUncertain": True}})
            abort.assert_called_once()
        self.observer.probe.assert_not_called()
        self.assertTrue(broker.mutation_unresolved)
        self.assertFalse(broker.contain_failure_without_guard())
        broker.scope.revoke.assert_called_once()
        broker.profiled_scope.revoke.assert_called_once()
        self.assertIsNone(broker.outcome["frontendAdmissionClosedOnFailure"])


class TerminalCustodyTest(unittest.TestCase):
    def test_child_reuses_the_guard_compact_source_verifier(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.source = Path("/owned")
        broker.initial = {"mode": "p2-identity-key-rotation"}
        with patch.object(parent, "verify_rotation_source_closure", return_value="owned-digest") as verify:
            self.assertEqual(broker.require_source_closure(), "owned-digest")
            verify.assert_called_once_with(broker.initial, broker.source)

    def test_fixed_entry_and_direct_supervisor_refuse_before_reading_live_inputs(self):
        with (patch.object(sys, "argv", ["rotation", "--supervisor"]), patch.object(sys, "stdin", None),
              patch.object(parent, "MANAGED_LIVE_ELIGIBLE", False)):
            with self.assertRaisesRegex(ValueError, "LIVE_EXECUTION_UNQUALIFIED"):
                parent.main()
        for version in (1, True, 2.0):
            raw = (json.dumps({"version": version, "mode": "p2-identity-key-rotation"}) + "\n").encode()
            with (patch.object(sys, "argv", ["rotation", "--supervisor"]),
                  patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(raw))),
                  patch.object(supervisor, "supervise", side_effect=AssertionError("unqualified dispatch reached"))):
                with self.subTest(version=version), self.assertRaisesRegex(ValueError, "LIVE_EXECUTION_UNQUALIFIED"):
                    parent.main()
        with self.assertRaisesRegex(ValueError, "LIVE_EXECUTION_UNQUALIFIED"):
            supervisor.supervise({"mode": "p2-identity-key-rotation"}, broker_type=parent.P2IdentityRotationBroker,
                                 observer_type=parent.P2IdentityRotationPhysicalObserver,
                                 observer_source=parent.OBSERVER_SOURCE, layout=supervisor.ROTATION_LAYOUT)

    def test_terminal_requires_independent_closed_observation_after_broker_join(self):
        action = "p2-key-rotation-owned"
        plan = {"actionId": action, "sourceCommit": "a" * 40, "candidateSha256": "b" * 64, "bindingSha256": "c" * 64,
                "configuration": {"current-only": {"sha256": "d" * 64}}}
        prepared = {key: plan[key] for key in ("actionId", "sourceCommit", "candidateSha256", "bindingSha256")}
        prepared.update(status="P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED", environment="staging",
                        keyRemovalVerified=False, configurationSha256="d" * 64)
        post_removal = {"phase": "post-removal", "status": "owned-observation"}
        prepared["frontendSignerReceiptSha256"] = {"overlap": "e" * 64, "current-only": "f" * 64,
                                                    "post-removal": supervisor._canonical_sha(post_removal)}
        prepared.update({key: False for key in ("sqlExecuted", "rolesPrepared", "loginChanged",
            "nativeSchedulesEnabled", "trafficAuthorized", "tokenBytesOutput", "credentialHashesOutput",
            "communityMemberFeatureAdded", "newPublicEndpoint", "releaseAccepted", "g2Accepted")})
        closed = {"backendAbsent": True, "admissionEpoch": "9"}
        with tempfile.TemporaryDirectory() as results:
            directory = Path(results) / (supervisor.ROTATION_LAYOUT["receiptPrefix"] + action)
            directory.mkdir(mode=0o700)
            terminal = directory / supervisor.ROTATION_LAYOUT["terminalName"]
            initial = {"results": results, "rotationActionId": action, "rotationPlan": plan}
            armed = {"backendPid": 42}
            signer_dir = directory / "frontend-post-removal"
            signer_dir.mkdir(mode=0o700)
            migrate.write_json(signer_dir, "rotation-frontend-browser-source.json", post_removal)
            migrate.write_json(directory, parent.PREPARED_RECEIPT, prepared)
            migrate.write_json(directory, parent.SESSION_CLOSED_RECEIPT, closed)
            joined = {**prepared, "status": supervisor.ROTATION_LAYOUT["terminalStatus"], "keyRemovalVerified": True,
                      "frontendSessionCloseReceiptSha256": migrate.file_hash(migrate.read_input(directory, parent.SESSION_CLOSED_RECEIPT))}
            migrate.write_json(directory, parent.JOINED_RECEIPT, joined)
            commit = migrate.file_hash(migrate.read_input(directory, parent.JOINED_RECEIPT))
            with patch.object(supervisor, "verify_guard_boundary"), patch.object(supervisor, "cleanup_rotation_readonly_containers"), \
                    patch.object(parent, "observe_rotation_session_closed") as observe:
                with self.assertRaisesRegex(ValueError, "ROTATION_TERMINAL_REFUSED"):
                    supervisor._publish_rotation_terminal(initial, Path("/owned"), armed, "0" * 64)
                observe.assert_not_called()
                observe.return_value = {**closed, "admissionEpoch": "10"}
                with self.assertRaisesRegex(ValueError, "ROTATION_SESSION_CLOSE_CHANGED"):
                    supervisor._publish_rotation_terminal(initial, Path("/owned"), armed, commit)
                self.assertFalse(terminal.exists())
                observe.return_value = closed
                supervisor._publish_rotation_terminal(initial, Path("/owned"), armed, commit)
            self.assertEqual(migrate.read_json(directory, terminal.name), joined)


if __name__ == "__main__":
    unittest.main()
