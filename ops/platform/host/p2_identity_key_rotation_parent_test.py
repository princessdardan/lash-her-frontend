import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import p2_identity_key_rotation_parent as parent
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
    def test_window_binding_is_exact_and_deployment_backed(self):
        broker = parent.P2IdentityRotationBroker.__new__(parent.P2IdentityRotationBroker)
        broker.initial = {"rotationActionId": "p2-key-rotation-owned", "rotationPlan": {"actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64,
            "candidateSha256": "c" * 64, "sourceCommit": "a" * 40,
            "configuration": {"overlap": {"sha256": "d" * 64}, "current-only": {"sha256": "e" * 64}}}}
        broker.adapter = type("Adapter", (), {"frontend_deployment": lambda _self, phase: {
            "deploymentId": "dpl_owned", "configurationSha256": "d" * 64 if phase == "overlap" else "e" * 64}})()
        window = {"version": 1, "actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64,
            "phase": "overlap", "kind": "signer-read", "maximumSeconds": 60,
            "source": {"challenge": "f" * 64, "bindingSha256": "b" * 64}, "deploymentId": "dpl_owned",
            "configurationSha256": "d" * 64, "sourceCommit": "a" * 40, "candidateSha256": "c" * 64}
        self.assertEqual(broker._window_value({"window": window}), window)
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "maximumSeconds": 61}})
        with self.assertRaises(ValueError):
            broker._window_value({"window": {**window, "deploymentId": "dpl_other"}})


if __name__ == "__main__":
    unittest.main()
