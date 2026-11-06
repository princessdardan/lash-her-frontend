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

    def test_frontend_target_hash_matches_actual_node_insertion_order_contract(self):
        target = {"host": "127.0.0.1", "port": 5432, "database": "owned", "user": "owned_operator", "serverMajor": 16,
            "approvedPendingTags": ["owned-extra-field-excluded"]}
        node = "/Users/dardan/.nvm/versions/node/v24.18.0/bin/node" if sys.platform == "darwin" else "node"
        module = (Path(fault.__file__).parents[1] / "frontend-admission-bootstrap.mjs").as_uri()
        script = "import{frontendAdmissionTargetSha256 as h}from" + json.dumps(module) + ";let s='';for await(const x of process.stdin)s+=x;console.log(h('staging',JSON.parse(s)))"
        actual = subprocess.check_output([node, "--input-type=module", "--eval", script], input=json.dumps(target).encode()).decode().strip()
        self.assertEqual(fault.frontend_target_sha256(target), actual)

    def test_scope_receipt_and_frontend_job_target_are_both_required(self):
        target = {"host": "127.0.0.1", "port": 5432, "database": "owned", "user": "owned_operator", "serverMajor": 16, "approvedPendingTags": ["owned-pending"]}
        selected = {"environment": "staging", "contractPhase": "p2", "sources": {"frontend": {"commit": "a" * 40}}}
        job = {"environment": "staging", "releaseId": "owned", "sourceCommit": "a" * 40, "migrationImageDigest": "b" * 64,
            "sqlArtifactSha256": "c" * 64, "contractManifestSha256": "d" * 64, "schemaBaselineSha256": "e" * 64,
            "contractPhase": "p2", "phase2ContractManifestSha256": "f" * 64, "target": target}
        jobs = {"frontend": {"job": job}}
        receipt = {key: value for key, value in job.items() if key != "target"}
        receipt.update(status="DATABASE_VERIFIED", service="frontend", schemaVerified=True, runtimeRoleVerified=True,
            trafficAuthorized=False, migrationMode="apply-forward", target={key: target[key] for key in ("host", "port", "database", "user", "serverMajor")},
            failureCode=None, after=[{"tag": "owned-applied"}], applied=[{"tag": "owned-pending"}])
        scope = P2ReleaseScope(self.lock, self.lock_path, self.scope.verify_frontend, receipt, "1" * 64, release=selected, jobs=jobs)
        plan = {"sourceCommit": "a" * 40, "targetSha256": fault.frontend_target_sha256(target)}
        self.assertEqual(fault.bind_frontend_scope(scope, selected, jobs, plan)["status"], "DATABASE_VERIFIED")
        with self.assertRaisesRegex(ValueError, "P2_FAULT_FE_PHYSICAL_SCOPE_PLAN_MISMATCH"):
            fault.bind_frontend_scope(scope, selected, jobs, {**plan, "targetSha256": "0" * 64})
        scope.receipt = {}
        with self.assertRaisesRegex(ValueError, "P2_LIVE_FRONTEND_RECEIPT_BINDING_REFUSED"):
            fault.bind_frontend_scope(scope, selected, jobs, plan)

    def test_gateway_security_mount_check_is_repeated_at_verification_boundaries(self):
        stage = self.stage
        stage.configuration, stage.source, stage.source_initial = self.root, self.root, {}
        stage.admission_identity = os.fstat(stage.admission_fd)
        stage.initial_inventory, stage.gateway, stage.module_sha256 = [], {"service": "gateway"}, fault._hash(b"module")
        stage._inventory = lambda: []
        with patch.object(fault, "bind_frontend_scope"), patch.object(fault, "verify_source_closure"), \
                patch.object(fault.identity, "_configuration_hash", return_value=stage.plan["configurationSha256"]), \
                patch.object(fault.migrate, "read_input", return_value=b"module"), patch.object(fault.identity, "_one_container") as mounted:
            fault.P2CertificationFaultStage.verify(stage)
            mounted.assert_called_once_with(stage.gateway, stage.configuration, stage.scope)
            mounted.side_effect = ValueError("OWNED_MOUNT_DRIFT")
            with self.assertRaisesRegex(ValueError, "OWNED_MOUNT_DRIFT"):
                fault.P2CertificationFaultStage.verify(stage)


if __name__ == "__main__":
    unittest.main()
