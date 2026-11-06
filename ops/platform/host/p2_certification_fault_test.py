"""Owned FD/filesystem cleanup tests; Docker/Linux-root/PG observation is separate."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import p2_certification_fault as fault
from p2_release_scope import P2ReleaseScope


class FaultStageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-certification-fault-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name); self.root.chmod(0o700)
        self.lock_path = self.root / "release.lock"
        self.lock = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(lambda: os.close(self.lock))
        self.alive, self.verifications = True, 0
        def physical():
            self.verifications += 1
            if not self.alive:
                raise ValueError("OWNED_FRONTEND_BACKEND_LOST")
        self.scope = P2ReleaseScope(self.lock, self.lock_path, physical, {}, "1" * 64, release={}, jobs={})
        self.admission = self.root / "admission"; self.admission.mkdir(mode=0o755)
        self.private = self.root / "private"; self.private.mkdir(mode=0o700)
        stage = fault.P2CertificationFaultStage.__new__(fault.P2CertificationFaultStage)
        stage.scope, stage.selected, stage.jobs = self.scope, {"releaseId": "owned-release"}, {}
        stage.plan = {"version": 1, "environment": "staging", "profile": "lifecycle-known-command-v1", "stageId": "owned-one-record",
            "candidateSha256": "1" * 64, "configurationSha256": "2" * 64, "gatewayConfigurationSha256": "3" * 64,
            "gatewayProcessSha256": "4" * 64, "gatewayImageSha256": "5" * 64, "mode": "drop-after-ack", "receiver": "course", "commandSha256": "6" * 64}
        stage.directory, stage.arm_called, stage.lease_sha256, stage.issued_at, stage.closed = self.private, False, None, None, False
        stage.admission_fd = os.open(self.admission, os.O_RDONLY | os.O_DIRECTORY)
        stage.verify = self.scope.verify
        def observe():
            self.scope.verify()
            value = json.loads((self.admission / "state.json").read_text()) if (self.admission / "state.json").exists() else {}
            return {"faultLeasePresent": (self.admission / fault.LEASE).exists(), "admission": {"valid": True, **value,
                "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 1}}}
        stage._gateway_current = observe
        self.stage = stage
        self.addCleanup(lambda: None if stage.closed else stage.close())
        self.record = {"commandId": "00000000-0000-4000-8000-000000000001", "accountVersion": 1, "canonicalSha256": "6" * 64}

    def arm(self):
        # Root/group ownership requires Linux root. The actual requested IDs are
        # asserted here; all writes/link/fsync/modes/flock operations remain real.
        with patch.object(fault.os, "fchown") as owner:
            result = self.stage.arm(self.record)
        self.assertEqual(owner.call_args.args[1:], (0, 65532))
        return result

    def other_lock(self):
        code = "import fcntl,sys;f=open(sys.argv[1],'a+');\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('OPEN')\nexcept BlockingIOError:print('HELD')"
        return subprocess.check_output([sys.executable, "-I", "-c", code, str(self.lock_path)], text=True).strip()

    def test_received_json_cannot_substitute_for_actual_physical_parent_scope(self):
        with self.assertRaisesRegex(ValueError, "P2_FAULT_ACTUAL_FE_BOUND_PARENT_SCOPE_REQUIRED"):
            fault.P2CertificationFaultStage({"held": True}, {}, {}, self.root, self.root, {}, self.private, source_files={})
        self.assertFalse((self.admission / fault.LEASE).exists())

    def test_atomic_exclusive_arm_is_120_seconds_one_match_and_never_replayed(self):
        receipt = self.arm(); raw = (self.admission / fault.LEASE).read_bytes(); lease = json.loads(raw)
        self.assertEqual(receipt["leaseSha256"], fault._hash(raw)); self.assertEqual(lease["maxMatches"], 1)
        self.assertEqual((self.admission / fault.LEASE).stat().st_mode & 0o777, 0o640)
        issued = fault.datetime.datetime.fromisoformat(lease["issuedAt"].replace("Z", "+00:00"))
        expires = fault.datetime.datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00"))
        self.assertEqual((expires - issued).total_seconds(), 120)
        with self.assertRaises(ValueError):
            self.arm()
        self.assertEqual((self.admission / fault.LEASE).read_bytes(), raw)
        self.assertEqual(self.other_lock(), "HELD")

    def test_failed_arm_readback_remains_sticky_and_cleanup_removes_own_lease(self):
        self.stage._gateway_current = lambda: (_ for _ in ()).throw(ValueError("OWNED_READBACK_LOST"))
        with self.assertRaises(ValueError):
            self.arm()
        self.assertTrue((self.admission / fault.LEASE).exists()); self.assertTrue(self.stage.arm_called)
        self.assertTrue(self.stage.disarm()["faultDisabled"])
        self.assertFalse((self.admission / fault.LEASE).exists())

    def test_lost_pg_and_input_directory_name_cannot_skip_cached_fd_fence(self):
        self.arm(); moved = self.root / "admission-moved"; self.admission.rename(moved)
        self.alive = False
        self.assertTrue(self.stage.disarm()["faultDisabled"])
        closed = self.stage.close_gateway()
        self.assertEqual(closed["gatewayAdmissionClosed"], None); self.assertTrue(closed["fileFencePersisted"])
        persisted = json.loads((moved / "state.json").read_text())
        self.assertFalse(persisted["newWork"]); self.assertFalse(persisted["recovery"])
        self.assertFalse((moved / fault.LEASE).exists()); self.assertEqual(self.other_lock(), "HELD")

    def test_gateway_uncertainty_is_read_back_and_never_reset(self):
        self.arm(); self.stage.disarm()
        closed = self.stage.close_gateway()
        self.assertTrue(closed["gatewayAdmissionClosed"]); self.assertEqual(closed["uncertain"]["recovery"], 1)
        self.assertEqual(self.other_lock(), "HELD")

    def test_unrelated_lease_is_preserved_but_close_still_fences_and_retains_parent_lock(self):
        self.arm(); (self.admission / fault.LEASE).write_text('{"unrelated":"source-owned-other-action"}')
        with self.assertRaisesRegex(ValueError, "P2_FAULT_HOST_CLEANUP_REQUIRES_REVIEW"):
            self.stage.close()
        self.assertTrue(self.stage.closed)
        self.assertIn("unrelated", (self.admission / fault.LEASE).read_text())
        persisted = json.loads((self.admission / "state.json").read_text())
        self.assertFalse(persisted["newWork"]); self.assertFalse(persisted["recovery"]); self.assertEqual(self.other_lock(), "HELD")

    def test_default_entry_is_ineligible_and_performs_no_activation(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(Path(fault.__file__))], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout); self.assertFalse(value["standaloneActivationEligible"])
        self.assertFalse(value["networkCalled"]); self.assertFalse(value["mutationsPerformed"])


if __name__ == "__main__":
    unittest.main()
