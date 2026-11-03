import fcntl
import hashlib
import json
from pathlib import Path
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import migrate
import staging_restore as restore
import staging_state
import staging_state_test


class StagingRestoreTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests()
        self.fixture.setUp()
        self.runtime = self.fixture.runtime
        # The retained receipt fixture models the retired machine; the new
        # machine starts with no running containers and a fresh command log.
        self.runtime.running.clear()
        self.runtime.calls.clear()
        self.selected, self.jobs, self.plan, self.compose = self.fixture.bind()
        self.retirement = self.runtime.root / "retirement"
        self.retirement.mkdir(mode=0o700)
        self.output = self.runtime.root / "restore-action"
        self.retired = {"status": "STAGING_RUNTIME_QUIESCED_FOR_RECREATION", "environment": "staging",
            "releaseId": "test-release", "originalHostMachineId": "1" * 32,
            "candidateSha256": self.fixture.candidate_hash, "migrationOutcomeSha256": self.plan["migrationOutcomeSha256"],
            "runtimeReceiptSha256": self.plan["runtimeReceiptSha256"], "frontendDeploymentId": "dpl_fixture",
            "nativeSchedulesDisabled": True, "externalProducersSuspended": True, "publicIngressStopped": True,
            "hostTimersStopped": True, "trafficAuthorized": False,
            "configurationSha256": staging_state.configuration_hashes(self.runtime.configuration),
            "stoppedContainers": [{**c, "running": False, "exitCode": 0, "oomKilled": False} for c in self.plan["originalContainers"]]}
        self.save_retirement()
        self.values = {"bundle": self.runtime.bundle, "configuration": self.runtime.configuration,
            "database_receipts": self.fixture.database, "runtime_receipts": self.fixture.receipts,
            "compose_file": self.runtime.compose, "candidate_sha256": self.fixture.candidate_hash,
            "retirement_directory": self.retirement, "retirement_sha256": self.retirement_hash,
            "new_machine": "2" * 32, "action": "restore-test-release", "expected_deployment": "dpl_fixture"}
        self.events = []
        self.new_containers = [{**c, "containerId": hashlib.sha256(c["containerId"].encode()).hexdigest()}
                               for c in self.plan["originalContainers"]]

    def tearDown(self):
        self.fixture.tearDown()

    def save_retirement(self):
        file = self.retirement / "retirement-outcome.json"
        file.write_text(json.dumps(self.retired)); file.chmod(0o600)
        self.retirement_hash = hashlib.sha256(file.read_bytes()).hexdigest()

    def assert_locked(self):
        with (self.runtime.root / "release.lock").open() as stream:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def current(self, selected, jobs, output, *_args):
        self.events.append("current-databases")
        self.assert_locked()
        self.assertEqual(selected, self.selected)
        self.assertEqual(set(jobs), {"frontend", "course", "community"})
        self.assertEqual(self.runtime.running, set())
        output.mkdir(mode=0o700)
        result = {"status": "CURRENT_DATABASES_READ_ONLY_VERIFIED", "databases": {name: {} for name in jobs}}
        migrate.write_json(output, "current-databases-outcome.json", result)
        return result

    def command(self, args, env, timeout=30):
        self.assert_locked()
        if "up" in args:
            self.assertIn("current-databases", self.events)
            self.events.append("start")
        return self.runtime.docker(args, env=env).stdout.strip()

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(restore, "check_fresh_host", return_value={"status": "RESTORE_FRESH_BOOTSTRAP_VERIFIED"}))
        stack.enter_context(patch.object(restore, "check_provider", side_effect=lambda *_: self.assert_locked()))
        stack.enter_context(patch.object(restore.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(restore.runtime, "configuration_container"))
        stack.enter_context(patch.object(restore.runtime, "check_containers", return_value=self.new_containers))
        stack.enter_context(patch.object(restore.current_databases, "check_all", side_effect=self.current))
        stack.enter_context(patch.object(restore.migrate, "suspend_runtime"))
        return stack

    def execute(self, **changes):
        checker = Path(restore.__file__).with_name("database_current.mjs")
        values = {**self.values, "output": self.output, "checker_sha256": hashlib.sha256(checker.read_bytes()).hexdigest(),
            "apply": True, "confirmation": "staging/test-release/restore-test-release",
            "credentials": {name: name + "-private-fixture" for name in self.jobs}, "client": object(),
            "lock_path": self.runtime.root / "release.lock"}
        values.update(changes)
        return restore.execute(**values)

    def test_plan_binds_retirement_and_new_machine_without_process_or_credential_access(self):
        for service in restore.runtime.ENV_FILES:
            (self.runtime.configuration / (service + ".env")).unlink()
        with patch.object(restore.runtime, "command", side_effect=AssertionError("process invoked")):
            result = self.execute(apply=False, credentials=None, client=None)
        self.assertEqual(result["newHostMachineId"], "2" * 32)
        self.assertTrue(result["runtimeOnly"])
        self.assertFalse(result["migrationsExecuted"])
        self.assertFalse(result["finalAdmissionIncluded"])
        self.assertFalse(self.output.exists())

    def test_missing_quiescence_wrong_hash_or_old_machine_cannot_start_restore(self):
        for name in ("nativeSchedulesDisabled", "externalProducersSuspended", "publicIngressStopped", "hostTimersStopped"):
            self.retired[name] = False; self.save_retirement()
            with self.assertRaisesRegex(ValueError, "COMPLETE_QUIESCENCE"):
                self.execute(retirement_sha256=self.retirement_hash)
            self.retired[name] = True
        self.save_retirement()
        with self.assertRaisesRegex(ValueError, "RETIREMENT_HASH"):
            self.execute(retirement_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "DIFFERENT_EXACT_MACHINE"):
            self.execute(retirement_sha256=self.retirement_hash, new_machine="1" * 32)
        self.assertFalse(self.output.exists())

    def test_nonzero_exit_or_running_original_container_refuses(self):
        for key, value in (("running", True), ("exitCode", 137), ("oomKilled", True)):
            original = self.retired["stoppedContainers"][0][key]
            self.retired["stoppedContainers"][0][key] = value; self.save_retirement()
            with self.assertRaisesRegex(ValueError, "ALL_ORIGINAL_PROCESSES_STOPPED"):
                self.execute(retirement_sha256=self.retirement_hash)
            self.retired["stoppedContainers"][0][key] = original
        self.assertFalse(self.output.exists())

    def test_confirmation_client_and_checker_are_required_before_host_operations(self):
        with patch.object(restore, "check_fresh_host", side_effect=AssertionError("host touched")):
            for changes, marker in (({"confirmation": "production/test-release"}, "CONFIRMATION"),
                                    ({"client": None}, "READ_ONLY_CLIENT"),
                                    ({"checker_sha256": "0" * 64}, "CHECKER_SOURCE_HASH"),
                                    ({"after_publisher_ready": {}}, "TRUSTED_PUBLISHER_CHECKPOINT")):
                with self.assertRaisesRegex(ValueError, marker):
                    self.execute(**changes)

    def test_restore_runs_current_checks_before_dependency_ordered_starts_under_one_lock(self):
        original = staging_state.configuration_hashes(self.runtime.configuration)
        with self.patches():
            result = self.execute()
        self.assertEqual(result["status"], "API_RUNTIME_RESTORED_FOR_QUALIFICATION")
        self.assertEqual(result["phase"], "completed")
        self.assertEqual(result["containers"], self.new_containers)
        self.assertEqual(result["hostMachineId"], "2" * 32)
        self.assertFalse(result["durableRecoveryVerified"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertFalse(result["trafficAuthorized"])
        self.assertEqual(staging_state.configuration_hashes(self.runtime.configuration), original)
        calls = self.runtime.calls
        self.assertFalse(any("pull" in args or "--execute" in args for args in calls))
        self.assertEqual([tuple(a[a.index("90") + 1:]) for a in calls if "up" in a], restore.runtime.STAGES)
        self.assertNotIn("private-fixture", (self.output / "restore-outcome.json").read_text())
        with self.patches(), self.assertRaisesRegex(ValueError, "EXCLUSIVE_OUTPUT"):
            self.execute()

    def test_read_only_database_failure_stops_runtime_and_cannot_be_retried(self):
        with self.patches(), patch.object(restore.current_databases, "check_all", side_effect=ValueError("CURRENT_DATABASES_REQUIRES_REVIEW")), \
                patch.object(restore.migrate, "suspend_runtime") as stop:
            with self.assertRaisesRegex(ValueError, "CURRENT_DATABASES_REQUIRES_REVIEW"):
                self.execute()
        stop.assert_called_once_with("staging", restore.runtime.SAFE_ENV)
        self.assertNotIn("start", self.events)
        failure = migrate.read_json(self.output, "restore-outcome.json")
        self.assertTrue(failure["runtimeStopped"])
        self.assertFalse((self.output / "runtime-outcome.json").exists())

    def test_continuation_owns_separate_proof_and_cannot_mutate_ready_receipt(self):
        def continuation(selected, plan, snapshot, output, ready):
            self.assert_locked()
            self.assertEqual(ready["phase"], "completed")
            self.assertEqual(ready, migrate.read_json(output, "runtime-outcome.json"))
            self.assertEqual(migrate.read_json(snapshot, "runtime.json")["hostMachineId"], "2" * 32)
            ready["trafficAuthorized"] = True
            selected["environment"] = "production"
            plan["newHostMachineId"] = "3" * 32
        with self.patches():
            result = self.execute(after_runtime_ready=continuation)
        self.assertFalse(result["trafficAuthorized"])
        self.assertEqual(result["environment"], "staging")
        self.assertEqual(result["newHostMachineId"], "2" * 32)

    def test_failed_post_restore_qualification_preserves_ready_receipt_and_healthy_maintenance_runtime(self):
        def fail(*_args):
            raise ValueError("POST_RESTORE_QUALIFICATION_FAILED")
        with self.patches(), patch.object(restore.migrate, "suspend_runtime") as stop:
            with self.assertRaisesRegex(ValueError, "POST_RESTORE_QUALIFICATION_FAILED"):
                self.execute(after_runtime_ready=fail)
        stop.assert_not_called()
        self.assertEqual(migrate.read_json(self.output, "runtime-outcome.json")["status"], "API_RUNTIME_RESTORED_FOR_QUALIFICATION")
        failure = migrate.read_json(self.output, "restore-outcome.json")
        self.assertEqual(failure["status"], "STAGING_RESTORE_REQUIRES_REVIEW")
        self.assertTrue(failure["runtimeRetainedInMaintenance"])
        self.assertFalse(failure["trafficAuthorized"])

    def test_reusing_original_container_identity_cannot_qualify_new_host(self):
        with self.patches(), patch.object(restore.runtime, "check_containers", return_value=self.plan["originalContainers"]):
            with self.assertRaisesRegex(ValueError, "NEW_CONTAINER_IDENTITIES"):
                self.execute()
        self.assertFalse((self.output / "runtime-outcome.json").exists())
        self.assertTrue(migrate.read_json(self.output, "restore-outcome.json")["runtimeStopped"])

    def test_post_restore_failure_stops_runtime_if_its_health_cannot_be_reconfirmed(self):
        def fail(*_args):
            raise ValueError("POST_RESTORE_QUALIFICATION_FAILED")
        with self.patches(), patch.object(restore.runtime, "check_containers", side_effect=[self.new_containers, ValueError("UNHEALTHY")]), \
                patch.object(restore.migrate, "suspend_runtime") as stop:
            with self.assertRaisesRegex(ValueError, "POST_RESTORE_QUALIFICATION_FAILED"):
                self.execute(after_runtime_ready=fail)
        stop.assert_called_once()
        failure = migrate.read_json(self.output, "restore-outcome.json")
        self.assertTrue(failure["runtimeStopped"])
        self.assertTrue(failure["runtimeStateRequiresInspection"])

    def test_durable_checkpoint_observes_publisher_before_reconciliation_or_gateway_under_one_lock(self):
        seen = []
        def checkpoint(selected, plan, snapshot, output):
            self.assert_locked()
            self.assertEqual(self.runtime.running, {"course-api", "community-api", "course-tls", "community-tls", "course-publisher"})
            self.assertFalse((output / "runtime-outcome.json").exists())
            self.assertEqual(migrate.read_json(snapshot, "runtime.json")["hostMachineId"], "2" * 32)
            selected["environment"] = "changed"; plan["trafficAuthorized"] = True
            seen.append(True)
            return {"durableRecoveryVerified": True}
        with self.patches():
            result = self.execute(after_publisher_ready=checkpoint)
        self.assertEqual(seen, [True])
        self.assertFalse(result["durableRecoveryVerified"])
        self.assertFalse(result["trafficAuthorized"])
        self.assertEqual(result["environment"], "staging")
        self.assertEqual([tuple(a[a.index("90") + 1:]) for a in self.runtime.calls if "up" in a],
            [restore.runtime.STAGES[0], restore.runtime.STAGES[1], ("course-publisher",), restore.runtime.STAGES[2], restore.runtime.STAGES[4]])

    def test_failed_durable_checkpoint_stops_partial_runtime_before_reconciliation_or_gateway(self):
        def fail(*_args):
            raise ValueError("STAGING_WORK_ACTUAL_PUBLICATION_REQUIRED")
        with self.patches(), patch.object(restore.migrate, "suspend_runtime") as stop:
            with self.assertRaisesRegex(ValueError, "STAGING_WORK_ACTUAL_PUBLICATION_REQUIRED"):
                self.execute(after_publisher_ready=fail)
        stop.assert_called_once()
        self.assertNotIn("community-worker", self.runtime.running)
        self.assertNotIn("gateway", self.runtime.running)
        failure = migrate.read_json(self.output, "restore-outcome.json")
        self.assertEqual(failure["phase"], "publisher-durable-recovery-checkpoint")
        self.assertTrue(failure["runtimeStopped"])
        self.assertFalse((self.output / "runtime-outcome.json").exists())

    def test_actual_parent_descriptor_remains_locked_across_restore_and_qualification(self):
        lock_path = self.runtime.root / "release.lock"
        with lock_path.open("a+") as parent:
            fcntl.flock(parent.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.patches():
                self.execute(lock_handle=parent, after_runtime_ready=lambda *_: self.assert_locked())
            self.assertFalse(parent.closed)
            self.assert_locked()

    def test_unrelated_parent_descriptor_refuses_before_fresh_host_inspection(self):
        (self.runtime.root / "release.lock").touch()
        with self.runtime.root.joinpath("wrong.lock").open("a+") as wrong, \
                patch.object(restore, "check_fresh_host", side_effect=AssertionError("host touched")):
            with self.assertRaisesRegex(ValueError, "EXACT_PARENT_LOCK_HANDLE"):
                self.execute(lock_handle=wrong)


class FreshHostTests(unittest.TestCase):
    def setUp(self):
        self.lock, self.sha = restore.bootstrap.load_lock(Path(restore.__file__).with_name("packages.lock.json"))
        self.bootstrap = restore.bootstrap.make_plan(self.lock, self.sha, "ens5")
        self.packages = {p["name"]: p["version"] for p in self.lock["packages"]}
        self.receipt = {"lockSha256": self.sha, "forwardingSha256": self.bootstrap["forwardingSha256"],
            "packages": self.packages, "applicationDeployed": False, "publicInterface": "ens5",
            "rules": {"ipv4": "owned-v4-rules", "ipv6": "owned-v6-rules"}}
        self.files = {"/usr/lib/os-release": b'ID=ubuntu\nVERSION_ID="24.04"\n',
            "/etc/docker/daemon.json": json.dumps(restore.bootstrap.DAEMON).encode(),
            restore.bootstrap.EXECUTABLE: self.bootstrap["forwardingScript"].encode(),
            restore.bootstrap.DROPIN: self.bootstrap["systemdDropIn"].encode()}
        self.commands = []
        self.responses = {("docker", "ps", "--all", "--quiet"): "",
            ("ip", "-json", "route", "show", "default"): '[{"dev":"ens5"}]',
            ("ip", "-6", "-json", "route", "show", "default"): '[]'}
        for name, value in self.packages.items():
            self.responses[("dpkg-query", "-W", "-f=${Version}", name)] = value
        for family, binary, chain in (("ipv4", "iptables", "DOCKER-USER"), ("ipv6", "ip6tables", "FORWARD")):
            self.responses[(binary, "--wait", "10", "-S", "LASH-HER-INGRESS")] = self.receipt["rules"][family]
            self.responses[(binary, "--wait", "10", "-S", chain)] = f"-P {chain} ACCEPT\n-A {chain} -j LASH-HER-INGRESS"

    def command(self, args, env):
        self.commands.append(args)
        self.assertEqual(env, restore.runtime.SAFE_ENV)
        return self.responses[tuple(args)]

    def check(self):
        with patch.object(restore.runtime, "assert_host") as identity, \
                patch.object(restore.migrate, "read_json", return_value=self.receipt), \
                patch.object(restore, "host_file", side_effect=lambda path: self.files[path]), \
                patch.object(restore.runtime, "command", side_effect=self.command):
            result = restore.check_fresh_host({"newHostMachineId": "2" * 32})
        identity.assert_called_once_with({"hostMachineId": "2" * 32})
        return result

    def test_actual_package_os_routes_rules_and_first_hooks_are_read_without_mutation(self):
        result = self.check()
        self.assertEqual(result["status"], "RESTORE_FRESH_BOOTSTRAP_VERIFIED")
        self.assertEqual(len([a for a in self.commands if a[0] == "dpkg-query"]), 5)
        self.assertEqual({a[0] for a in self.commands}, {"docker", "dpkg-query", "ip", "iptables", "ip6tables"})

    def test_occupied_engine_or_unpinned_installed_packages_refuse(self):
        self.responses[("docker", "ps", "--all", "--quiet")] = "existing-container"
        with self.assertRaisesRegex(ValueError, "FRESH_EMPTY_ENGINE"):
            self.check()
        self.responses[("docker", "ps", "--all", "--quiet")] = ""
        self.responses[("dpkg-query", "-W", "-f=${Version}", "docker-ce")] = "different-version"
        with self.assertRaisesRegex(ValueError, "INSTALLED_PACKAGE_VERSION"):
            self.check()

    def test_alternate_route_or_late_ipv6_ingress_hook_refuses(self):
        key = ("ip", "-6", "-json", "route", "show", "default")
        self.responses[key] = '[{"dev":"ens6"}]'
        with self.assertRaisesRegex(ValueError, "Every IPv4/IPv6 default route"):
            self.check()
        self.responses[key] = "[]"
        self.responses[("ip6tables", "--wait", "10", "-S", "FORWARD")] = "-A FORWARD -j ACCEPT\n-A FORWARD -j LASH-HER-INGRESS"
        with self.assertRaisesRegex(ValueError, "FIRST_INGRESS_HOOK"):
            self.check()

    def test_changed_forwarding_daemon_os_or_bootstrap_receipt_refuses(self):
        for path, value, code in ((restore.bootstrap.EXECUTABLE, b"changed", "FORWARDING_MISMATCH"),
                ("/etc/docker/daemon.json", b'{}', "DAEMON_MISMATCH"),
                ("/usr/lib/os-release", b'ID=ubuntu\nVERSION_ID="22.04"', "UBUNTU_24_REQUIRED")):
            original = self.files[path]; self.files[path] = value
            with self.assertRaisesRegex(ValueError, code):
                self.check()
            self.files[path] = original
        self.receipt["applicationDeployed"] = True
        with self.assertRaisesRegex(ValueError, "PINNED_FRESH_BOOTSTRAP"):
            self.check()


if __name__ == "__main__":
    unittest.main()
