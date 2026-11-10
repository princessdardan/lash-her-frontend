import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
import os
import tempfile
import types
import sys

sys.path.insert(0, str(Path(__file__).parent))
import p2_identity_key_rotation_parent as parent
import p2_identity_key_rotation as rotation_source
import migrate
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
                 patch("p2_release_broker.verify_source_closure"), \
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

    def test_restoration_requires_the_source_derived_last_qualified_phase_and_no_open_or_uncertain_work(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.window = None; broker.mutation_unresolved = False; broker.last_fully_qualified_phase = "overlap"
        broker.qualified_signers = {"overlap"}; broker.qualified_profiles = {"overlap"}
        broker.guard_mutex = threading.RLock(); broker.guard_in_progress = False
        broker.initial = {"expectedFeatureControls": {"identity": True},
                          "expectedWriterAdmissionBinding": {"sourceCommit": "a" * 40}}
        calls = []
        broker.adapter = type("Adapter", (), {
            "restore_qualified": lambda _self, *args: calls.append(("restore", *args)) or {"status": "restored"},
            "observe_runtime_boundary": lambda _self, phase: {"containers": [{"service": phase}]},
            "runtime_guard_containers": lambda _self, rows: rows,
            "retained_frontend_signer": lambda _self, phase: calls.append(("signer", phase)) or {},
            "retained_profile_evidence": lambda _self, phase: calls.append(("profiles", phase)) or {},
        })()
        broker._guard_external = lambda: calls.append(("guard",))
        result = broker._restore({"phase": "overlap", "configuration": {"sha256": "b" * 64}})
        self.assertEqual(result, {"status": "restored"})
        self.assertEqual(calls[-3:], [("signer", "overlap"), ("profiles", "overlap"), ("guard",)])
        for changes in ({"window": {}}, {"mutation_unresolved": True}, {"last_fully_qualified_phase": "baseline"}):
            broker.window = None; broker.mutation_unresolved = False; broker.last_fully_qualified_phase = "overlap"
            for key, value in changes.items(): setattr(broker, key, value)
            with self.assertRaises(ValueError):
                broker._restore({"phase": "overlap", "configuration": {"sha256": "b" * 64}})

    def test_capture_rpc_requires_the_verified_split_and_emits_metadata_only(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        rotation = {"subjects": {}, "courseId": "fixture-course", "bindingSha256": "a" * 64}
        broker.initial = {"rotationPlan": rotation}
        broker.runtime_phase, broker.frontend_phase = "overlap", "current-only"
        broker.window, broker.mutation_unresolved = None, False
        broker.qualified_signers = {"overlap", "current-only"}
        broker.output_lock = threading.Lock()
        capture_calls, wire, checks = [], [], []
        broker.check = lambda: checks.append(True)
        broker.emit = wire.append
        metadata = [{"status": "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", "profile": profile,
                     "tokenIssuedAt": "2027-01-15T07:02:30.000Z", "tokenExpiresAt": "2027-01-15T07:07:30.000Z"}
                    for profile in ("community-admin", "community-member", "course-admin", "course-learner")]
        broker.adapter = types.SimpleNamespace(capture_tokens=lambda *args: capture_calls.append(args) or metadata)
        request = {"id": 2, "operation": "rotation-capture"}
        broker.command(request)
        self.assertEqual(capture_calls, [(rotation["subjects"], rotation["courseId"], rotation["bindingSha256"])])
        self.assertEqual(wire, [{"id": 2, "status": "ROTATION_CAPTURED", "receipt": metadata}])
        self.assertEqual(len(checks), 2)
        for field, invalid in (("runtime_phase", "current-only"), ("frontend_phase", "overlap"),
                               ("window", {}), ("mutation_unresolved", True), ("qualified_signers", {"overlap"})):
            with self.subTest(field=field), patch.object(broker, field, invalid):
                with self.assertRaisesRegex(ValueError, "P2_ROTATION_CAPTURE_SPLIT_STATE_REQUIRED"):
                    broker.command(request)
        with self.assertRaisesRegex(ValueError, "P2_ROTATION_CAPTURE_SPLIT_STATE_REQUIRED"):
            broker.command({**request, "profile": "course-admin"})
        self.assertEqual(len(capture_calls), 1)
        self.assertEqual(len(wire), 1)

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


if __name__ == "__main__":
    unittest.main()
