import fcntl
import hashlib
import json
import unittest
from unittest.mock import patch

import migrate
import native_qualification_test
import staging_frontend_restore as frontend


class RestoredFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        native_qualification_test.FrontendQualificationTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        native_qualification_test.FrontendQualificationTests.tearDownClass()

    def setUp(self):
        self.fixture = native_qualification_test.FrontendQualificationTests(methodName="runTest")
        self.fixture.setUp()
        self.runtime = self.fixture.r.runtime
        self.selected = self.runtime.fixture.release
        self.configuration = self.fixture.r.prior / "configuration"
        self.restored = self.runtime.root / "new-machine-restore"; self.restored.mkdir(mode=0o700)
        self.output = self.runtime.root / "new-machine-native"
        self.lock_path = self.fixture.r.lock
        old = self.fixture.r.plan["containers"]
        self.containers = [{**c, "containerId": hashlib.sha256(c["containerId"].encode()).hexdigest()} for c in old]
        self.plan = {"environment": "staging", "releaseId": "test-release", "candidateSha256": "a" * 64,
            "migrationOutcomeSha256": "b" * 64, "retirementOutcomeSha256": "c" * 64,
            "newHostMachineId": "2" * 32, "originalHostMachineId": "1" * 32,
            "originalContainers": old, "frontendDeploymentId": "dpl_fixture", "publicHost": "gateway.example.invalid"}
        target = migrate.read_json(self.configuration, "runtime.json"); target["hostMachineId"] = "2" * 32
        file = self.configuration / "runtime.json"; file.write_text(json.dumps(target))
        current_dir = self.restored / "database-current"; current_dir.mkdir(mode=0o700)
        current = {"status": "CURRENT_DATABASES_READ_ONLY_VERIFIED", "environment": "staging", "releaseId": "test-release",
                   "migrationsExecuted": False, "databases": {}}
        for name in ("frontend", "course", "community"):
            directory = current_dir / name; directory.mkdir(mode=0o700)
            migrate.write_json(directory, "database-receipt.json", {"owned": name})
            current["databases"][name] = {"receiptSha256": self.sha(directory / "database-receipt.json"),
                "image": self.selected["artifacts"][name + "Migration"]["image"]}
        migrate.write_json(current_dir, "current-databases-outcome.json", current)
        self.ready = {**self.plan, "status": "API_RUNTIME_RESTORED_FOR_QUALIFICATION", "phase": "completed",
            "hostMachineId": "2" * 32, "trafficAuthorized": False, "releaseAccepted": False, "migrationsExecuted": False,
            "containers": self.containers, "databaseCurrentOutcomeSha256": self.sha(current_dir / "current-databases-outcome.json")}
        migrate.write_json(self.restored, "runtime-outcome.json", self.ready)
        self.ready_sha = self.sha(self.restored / "runtime-outcome.json")
        self.programs = {name: {"sha256": name + "-reviewed-source"} for name in ("fixture", "work")}
        events = [{"eventId": str(i), "canonicalDigest": str(i) * 64,
                   "notBefore": "2026-11-03T00:00:00Z", "attemptsInCycle": i} for i in (1, 2)]
        self.recovery = {"retained": {"status": "STAGING_DURABLE_WORK_RETAINED", "environment": "staging", "events": events},
            "outbox": {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "course", "mode": "outbox", "readOnly": True, "authenticatedTls": True,
                "rows": [{**e, "state": "delivered", "leaseOwner": None, "leaseExpiresAt": None, "deliveredAt": "2026-11-03T00:01:00Z"} for e in events]},
            "inbox": {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "community", "mode": "inbox", "readOnly": True, "authenticatedTls": True,
                "rows": [{"eventId": e["eventId"], "canonicalDigest": e["canonicalDigest"], "status": "applied"} for e in events]},
            "apiContainers": [next(c for c in self.containers if c["service"] == name + "-api") for name in ("course", "community")],
            "operatorProgramsSha256": {key: info["sha256"] for key, info in self.programs.items()}}
        checkpoint = self.restored / "publisher-checkpoint"; checkpoint.mkdir(mode=0o700)
        migrate.write_json(checkpoint, "durable-recovery.json", self.recovery)

    def tearDown(self):
        self.fixture.tearDown()

    @staticmethod
    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def execute(self, lock=None, **changes):
        kwargs = {"apply": True, "confirmation": "staging/test-release/native-restore-test", "lock_path": self.lock_path,
                  "window_seconds": 60, "clock": self.fixture.clock, **changes}
        return frontend.execute(self.selected, self.plan, self.configuration, self.restored, self.ready_sha, self.programs,
            "native-restore-test", self.output, lock, self.fixture.r.fixture.probe.client, **kwargs)

    def test_offline_plan_reads_new_receipt_chain_without_process_provider_or_credential_access(self):
        with patch.object(frontend.runtime, "command", side_effect=AssertionError("process invoked")):
            plan = self.execute(apply=False)
        self.assertEqual(plan["hostMachineId"], "2" * 32)
        self.assertFalse(plan["nativeSchedulerVerified"])
        self.assertFalse(plan["releaseAccepted"])
        self.assertEqual(self.fixture.provider.calls, [])
        self.assertFalse(self.output.exists())

    def test_original_machine_or_original_process_cannot_qualify_new_machine(self):
        self.plan["newHostMachineId"] = "1" * 32
        with self.assertRaisesRegex(ValueError, "FRESH_RUNTIME"):
            self.execute(apply=False)
        self.plan["newHostMachineId"] = "2" * 32
        self.ready["containers"][0] = self.plan["originalContainers"][0]
        file = self.restored / "runtime-outcome.json"; file.write_text(json.dumps(self.ready)); self.ready_sha = self.sha(file)
        with self.assertRaisesRegex(ValueError, "NEW_PINNED_CONTAINERS"):
            self.execute(apply=False)

    def test_changed_readonly_receipt_or_fabricated_publisher_digest_refuses_before_provider(self):
        file = self.restored / "database-current/course/database-receipt.json"
        raw = file.read_bytes(); file.write_bytes(raw + b" ")
        with self.assertRaisesRegex(ValueError, "CURRENT_RECEIPT_CHAIN"):
            self.execute()
        file.write_bytes(raw)
        self.recovery["inbox"]["rows"][0]["canonicalDigest"] = "0" * 64
        file = self.restored / "publisher-checkpoint/durable-recovery.json"; file.write_text(json.dumps(self.recovery))
        with self.assertRaisesRegex(ValueError, "ACTUAL_PENDING_EVENT_PUBLICATION"):
            self.execute()
        self.assertEqual(self.fixture.provider.calls, [])

    def test_confirmation_and_actual_parent_lock_required_before_any_provider_access(self):
        with self.assertRaisesRegex(ValueError, "CONFIRMATION"):
            self.execute(confirmation="production/test-release/native-restore-test")
        with self.lock_path.open("a+") as lock:
            with self.assertRaisesRegex(ValueError, "PARENT_LOCK_NOT_HELD"):
                self.execute(lock)
            with self.runtime.root.joinpath("wrong.lock").open("a+") as wrong:
                with self.assertRaisesRegex(ValueError, "EXACT_PARENT_LOCK"):
                    self.execute(wrong)
        self.assertEqual(self.fixture.provider.calls, [])

    def test_real_owned_https_build_verify_promote_window_disables_and_remains_pending_provider_proof(self):
        self.fixture.enqueue()
        provider = self.fixture.r.fixture.probe.client
        request = provider.request
        def locked(*args, **kwargs):
            with self.lock_path.open("a+") as independent:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(independent.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return request(*args, **kwargs)
        with self.lock_path.open("a+") as lock, \
                patch.object(provider, "request", side_effect=locked), \
                patch.object(frontend.runtime, "assert_host"), \
                patch.object(frontend.runtime, "check_containers", return_value=self.containers), \
                patch.object(frontend.frontend_probe, "ProbeClient", return_value=self.fixture.r.fixture.probe.mapped_http()):
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.execute(lock)
            frontend.held_lock(lock, self.lock_path)
            writes = sum(c["method"] != "GET" for c in self.fixture.provider.calls)
            with self.assertRaisesRegex(ValueError, "FRESH_PRIVATE_OUTPUT"):
                self.execute(lock)
            self.assertEqual(writes, sum(c["method"] != "GET" for c in self.fixture.provider.calls))
        self.assertEqual(result["status"], "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE")
        self.assertTrue(result["frontendServerWorkloadVerified"])
        self.assertTrue(result["nativeSchedulesDisabled"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertFalse(result["releaseAccepted"])
        self.assertEqual(self.sha(self.restored / "runtime-outcome.json"), self.ready_sha)
        self.assertEqual([c["body"] for c in self.fixture.provider.calls if c["method"] == "PATCH"],
                         [{"target": ["production"]}, {"enabled": True}, {"enabled": False}])

    def test_provider_failure_does_not_enable_schedule_and_keeps_new_runtime_receipt(self):
        self.fixture.enqueue(promotion_error=True)
        with self.lock_path.open("a+") as lock, patch.object(frontend.runtime, "assert_host"), \
                patch.object(frontend.runtime, "check_containers", return_value=self.containers), \
                patch.object(frontend.frontend_probe, "ProbeClient", return_value=self.fixture.r.fixture.probe.mapped_http()):
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
                self.execute(lock)
        self.assertFalse(any(c["method"] == "PATCH" and c["body"] == {"enabled": True} for c in self.fixture.provider.calls))
        self.assertEqual(self.sha(self.restored / "runtime-outcome.json"), self.ready_sha)
        self.assertFalse(migrate.read_json(self.output, "qualification-outcome.json")["releaseAccepted"])


if __name__ == "__main__":
    unittest.main()
