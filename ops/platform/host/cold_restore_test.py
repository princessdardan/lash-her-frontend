from contextlib import ExitStack
import copy
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import time
import unittest
from unittest.mock import patch

import cold_restore as cold
import migrate
import staging_state_test


class ColdRestoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests()
        self.fixture.setUp()
        self.runtime = self.fixture.runtime
        self.runtime.root = self.runtime.root.resolve()
        self.selected, self.jobs, self.prior, _ = self.fixture.bind()
        self.action = "p1-recreate-access-owned"
        self.root = self.runtime.root / self.action
        self.root.mkdir(mode=0o700)
        inputs = self.root / "inputs"
        inputs.mkdir(mode=0o700)
        for name, source in (("bundle", self.runtime.bundle), ("configuration", self.runtime.configuration),
                             ("database-receipts", self.fixture.database), ("runtime-receipts", self.fixture.receipts)):
            shutil.copytree(source, inputs / name)
        shutil.copy2(self.runtime.compose, inputs / "compose.yaml")
        self.constants = ExitStack()
        for name, value in {"RELEASE": "test-release", "CANDIDATE": self.fixture.candidate_hash,
            "MIGRATION": self.prior["migrationOutcomeSha256"], "ORIGINAL_MACHINE": self.prior["originalHostMachineId"]}.items():
            self.constants.enter_context(patch.object(cold, name, value))
        self.constants.enter_context(patch.object(cold.recreation_files, "ROOT", self.runtime.root))
        self.new_arn = "arn:aws:lightsail:us-east-1:691588646557:Instance/22222222-2222-4222-8222-222222222222"
        self.value = {"version": 1, "environment": "staging", "operation": "cold-restore", "action": self.action,
            "newMachineId": "2" * 32, "configurationSha256": cold.staging_state.configuration_hashes(inputs / "configuration"),
            "checkerSha256": hashlib.sha256(Path(cold.__file__).with_name("database_current.mjs").read_bytes()).hexdigest(),
            "databaseCredentials": {name: "owned-private-credential" for name in self.jobs},
            "originalStop": {"status": "STAGING_ORIGINAL_INSTANCE_STOPPED_FOR_ACCESS_RECOVERY", "environment": "staging",
                "accountId": "691588646557", "region": "us-east-1", "stackId": cold.STACK,
                "instanceArn": cold.ORIGINAL_ARN, "hostMachineId": cold.ORIGINAL_MACHINE, "instanceState": "stopped",
                "forcedStop": False, "perContainerGracefulExitObserved": False},
            "newInfrastructure": {"status": "STAGING_INFRASTRUCTURE_STATE_VERIFIED", "accessRecoveryPhase": "ready",
                "stackId": cold.STACK, "instanceArn": self.new_arn, "instanceState": "running", "browserSshEnabled": True,
                "allocationPreserved": True, "address": "184.196.129.231"},
            "browserTrust": {"method": "authenticated-aws-browser", "accountId": "691588646557", "instanceArn": self.new_arn,
                "address": "184.196.129.231", "hostMachineId": "2" * 32, "browserAccountVerified": True,
                "keyPinnedBeforePrivateTransfer": True, "fingerprint": "SHA256:" + "a" * 43},
            "recoverySnapshot": {"status": "STAGING_STOPPED_HOST_RECOVERY_SNAPSHOT_AVAILABLE", "fromInstanceArn": cold.ORIGINAL_ARN,
                "privateRootDiskIncluded": True, "snapshotContentsFetched": False,
                "snapshotArn": "arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/33333333-3333-4333-8333-333333333333"},
            "muxInventory": {"status": "MUX_DEV_DASHBOARD_INVENTORY_VERIFIED", "organizationId": "4g1uhq", "environmentId": "7j65e8",
                "environmentName": "Lash Her Academy [DEV]", "sourceUrl": cold.staging_retire.MUX_PAGE,
                "inventoryComplete": True, "settingsChanged": False, "webhooks": [{"address": "http://localhost:4000/v1/webhooks/mux", "enabled": True}],
                "stagingGatewayWebhookCount": 0, "observedAt": int(time.time() * 1000),
                "maskedAccessibilitySha256": "a" * 64, "maskedScreenshotSha256": "b" * 64}}
        self.output = self.root / "cold-restore"
        self.events = []
        self.new_containers = [{**c, "containerId": hashlib.sha256((c["containerId"] + "new").encode()).hexdigest()}
                               for c in self.prior["originalContainers"]]

    def tearDown(self):
        self.constants.close()
        self.fixture.tearDown()

    def locked(self):
        with (self.runtime.root / "release.lock").open() as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def current(self, selected, jobs, output, credentials, *_):
        self.locked()
        self.assertEqual(set(jobs), {"frontend", "course", "community"})
        self.assertEqual(credentials, self.value["databaseCredentials"])
        self.assertNotIn("start", self.events)
        self.events.append("read-only-current")
        output.mkdir(mode=0o700)
        result = {"status": "CURRENT_DATABASES_READ_ONLY_VERIFIED", "databases": {name: {} for name in jobs}}
        migrate.write_json(output, "current-databases-outcome.json", result)
        return result

    def command(self, args, environment, timeout=30):
        self.locked()
        self.assertFalse(any("owned-private-credential" in arg for arg in args))
        self.assertNotIn("VERCEL_TOKEN", environment)
        if "up" in args:
            self.assertIn("read-only-current", self.events)
            self.assertIn("--no-deps", args)
            self.assertEqual(args[args.index("--pull") + 1], "never")
            self.events.append("start")
            return ""
        if "release-probe.mjs" in args:
            return json.dumps({"status": "API_RUNTIME_BOUNDARIES_PASS", "checks": sorted(cold.runtime.PROBE_CHECKS)})
        self.fail("Unexpected command")

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(cold.runtime, "assert_host"))
        stack.enter_context(patch.object(cold.staging_restore, "check_fresh_host", side_effect=lambda *_: self.locked()))
        stack.enter_context(patch.object(cold.recreation_prepare, "initialization", side_effect=lambda **kw: self.assertEqual(kw["ssh_access_policy"], cold.ssh_access.POLICY)))
        stack.enter_context(patch.object(cold.staging_restore, "check_provider", side_effect=lambda *_: self.locked()))
        stack.enter_context(patch.object(cold.runtime, "preflight", side_effect=lambda *_, **kw: self.assertFalse(kw["pull"])))
        stack.enter_context(patch.object(cold.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(cold.runtime, "check_containers", return_value=self.new_containers))
        stack.enter_context(patch.object(cold.current_databases, "check_all", side_effect=self.current))
        stack.enter_context(patch.object(cold.migrate, "execute", side_effect=AssertionError("Migration application forbidden")))
        stack.enter_context(patch.object(cold.migrate, "suspend_runtime"))
        return stack

    def execute(self, **changes):
        return cold.execute(self.value, apply=True, confirmation="staging/test-release/cold-restore-" + self.action,
            lock_path=self.runtime.root / "release.lock", client=object(), **changes)

    def test_plan_requires_exact_held_state_without_any_command_or_credential_access(self):
        value = {key: item for key, item in self.value.items() if key not in ("databaseCredentials", "originalStop", "newInfrastructure", "browserTrust")}
        with patch.object(cold.runtime, "command", side_effect=AssertionError("Command during plan")):
            result = cold.execute(value)
        self.assertFalse(result["p1RecreationQualified"])
        self.assertFalse(result["originalGracefulExitsObserved"])
        self.assertFalse(result["migrationsExecuted"])
        self.assertFalse(self.output.exists())

    def test_stop_managed_browser_recovery_and_independent_trust_must_precede_host_work(self):
        for key, field, bad in (("originalStop", "instanceState", "running"), ("originalStop", "forcedStop", True),
            ("newInfrastructure", "browserSshEnabled", False), ("newInfrastructure", "instanceArn", cold.ORIGINAL_ARN),
            ("browserTrust", "browserAccountVerified", False), ("browserTrust", "keyPinnedBeforePrivateTransfer", False)):
            saved = self.value[key][field]
            self.value[key][field] = bad
            with patch.object(cold.runtime, "assert_host", side_effect=AssertionError("Host touched")):
                with self.assertRaises(ValueError):
                    self.execute()
            self.value[key][field] = saved
        self.assertFalse(self.output.exists())

    def test_success_checks_all_current_databases_under_lock_before_eight_runtime_services(self):
        original = cold.staging_state.configuration_hashes(self.root / "inputs/configuration")
        with self.patches():
            outcome = self.execute()
        self.assertEqual(outcome["status"], "STAGING_COLD_RUNTIME_RESTORED_FOR_QUALIFICATION")
        self.assertEqual(self.events, ["read-only-current", *["start"] * len(cold.runtime.STAGES)])
        self.assertEqual(cold.staging_state.configuration_hashes(self.root / "inputs/configuration"), original)
        ready = migrate.read_json(self.output, "runtime-outcome.json")
        self.assertEqual(ready["hostMachineId"], "2" * 32)
        self.assertEqual(ready["containers"], self.new_containers)
        self.assertFalse(ready["trafficAuthorized"])
        self.assertFalse(ready["releaseAccepted"])
        self.assertNotIn("owned-private-credential", (self.output / "cold-restore-outcome.json").read_text())

    def test_read_only_failure_starts_nothing_and_cannot_be_retried_implicitly(self):
        with self.patches(), patch.object(cold.current_databases, "check_all", side_effect=ValueError("owned failure")), \
                patch.object(cold.migrate, "suspend_runtime") as stop:
            with self.assertRaisesRegex(ValueError, "FAILED_REQUIRES_REVIEW"):
                self.execute()
            stop.assert_called_once()
            with self.assertRaisesRegex(ValueError, "EXCLUSIVE_OUTPUT"):
                self.execute()
        self.assertNotIn("start", self.events)
        result = migrate.read_json(self.output, "cold-restore-outcome.json")
        self.assertEqual(result["phase"], "actual-read-only-database-checks")
        self.assertTrue(result["runtimeStoppedAfterFailure"])
        self.assertFalse(result["releaseAccepted"])

    def test_old_container_identity_or_changed_held_input_fails(self):
        with self.patches(), patch.object(cold.runtime, "check_containers", return_value=self.prior["originalContainers"]):
            with self.assertRaisesRegex(ValueError, "FAILED_REQUIRES_REVIEW"):
                self.execute()
        self.assertFalse((self.output / "runtime-outcome.json").exists())

    def test_wrong_new_machine_and_changed_configuration_refuse_before_execution(self):
        for machine in (cold.ORIGINAL_MACHINE, "0" * 32, "not-a-machine"):
            value = {**self.value, "newMachineId": machine}
            with self.assertRaisesRegex(ValueError, "NEW_MACHINE"):
                cold.execute(value)
        value = copy.deepcopy(self.value)
        value["configurationSha256"]["course-api.env"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "HELD_CONFIGURATION_HASH"):
            cold.execute(value)


if __name__ == "__main__":
    unittest.main()
