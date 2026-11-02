import fcntl
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import frontend_probe
import migrate
import release
import staging_recovery as recovery
import staging_release_test
import vercel


class StagingRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        staging_release_test.StagingReleaseTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        staging_release_test.StagingReleaseTests.tearDownClass()

    def setUp(self):
        self.fixture = staging_release_test.StagingReleaseTests(methodName="runTest")
        self.fixture.setUp()
        self.fixture.test_uncertain_promotion_is_not_repeated_or_rolled_back_and_runtime_stops()
        self.runtime = self.fixture.runtime
        self.prior = self.runtime.results / "runtime-test-release"
        self.database = self.runtime.results / "test-release"
        self.output = self.runtime.results / "recovery-test-release"
        self.lock = self.runtime.root / "release.lock"
        self.plan = recovery.make_plan(self.prior, self.database)[1]
        self.calls, self.provider_calls = [], []
        self.alias = "dpl_fixture"
        self.missing = False
        self.bad_boundary = False
        self.project = self.fixture.probe.project(deployment="dpl_fixture")
        self.project["lastAliasRequest"] = {"jobStatus": "succeeded", "requestedAt": 456, "toDeploymentId": "dpl_fixture", "type": "promote"}
        self.client = SimpleNamespace(request=self.provider)

    def tearDown(self):
        self.fixture.tearDown()

    def provider(self, method, path, body=None):
        self.provider_calls.append((method, path))
        self.assertEqual(method, "GET")
        self.assertIsNone(body)
        if path.startswith("/v13/deployments/"):
            return self.fixture.deployment()
        if path.startswith("/v9/projects/"):
            return self.project
        if path == "/v4/aliases/staging.lashher.com":
            return {"alias": "staging.lashher.com", "projectId": vercel.PROJECTS["staging"], "deploymentId": self.alias}
        raise AssertionError("Unexpected provider call")

    def docker(self, args, env, timeout=30):
        self.calls.append(args)
        self.assertNotIn("VERCEL_TOKEN", env)
        self.assertNotIn("COURSE_STAGING_DATABASE_URL", env)
        if args[1] == "ps" and "--all" in args:
            values = [c["containerId"] for c in self.plan["containers"]]
            return "\n".join(values[1:] if self.missing else values)
        if args[1] == "inspect":
            container = next(c for c in self.plan["containers"] if c["containerId"] == args[-1])
            service = container["service"]
            if ".Config.Image" in args[3]:
                status = "running" if service in self.runtime.running else "exited"
                return f'{container["image"]}|{status}|lash-her-staging|{service}'
            if args[3].startswith("{{.State.Running}}"):
                return "true|" + ("none" if service.endswith("-tls") else "healthy")
        if args[1] == "start":
            with self.lock.open() as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            for identity in args[2:]:
                self.runtime.running.add(next(c["service"] for c in self.plan["containers"] if c["containerId"] == identity))
            return "\n".join(args[2:])
        if "exec" in args and self.bad_boundary:
            return json.dumps({"status": "API_RUNTIME_BOUNDARIES_PASS", "checks": []})
        return self.runtime.docker(args, env=env, timeout=timeout).stdout.strip()

    def execute(self, **kwargs):
        with patch.object(release, "assert_host"), patch.object(release, "command", side_effect=self.docker), self.runtime.patches():
            return recovery.execute(self.prior, self.database, self.output, client=self.client,
                probe_client=self.fixture.probe.mapped_http(), lock_path=self.lock,
                **{"apply": True, "confirmation": "staging/test-release/recover", **kwargs})

    def test_plan_is_offline_and_check_is_read_only(self):
        with patch.object(release, "command", side_effect=AssertionError("Process run")):
            plan = recovery.execute(self.prior, self.database, self.output)
        self.assertFalse(plan["migrationsRepeated"])
        self.assertEqual(self.provider_calls, [])
        checked = self.execute(apply=False, confirmation=None, check=True)
        self.assertEqual(checked["status"], "RECOVERY_READ_ONLY_PREFLIGHT_PASS")
        self.assertFalse(self.output.exists())
        self.assertFalse(any(a[1] == "start" for a in self.calls))

    def test_success_preserves_container_ids_original_failure_and_database_receipts(self):
        failure = (self.prior / "runtime-failure.json").read_bytes()
        database = (self.database / "migration-outcome.json").read_bytes()
        result = self.execute()
        self.assertEqual(result["status"], "RUNTIME_RECOVERED_FOR_QUALIFICATION")
        self.assertFalse(result["releaseAccepted"])
        self.assertFalse(result["gatewayTrafficAuthorized"])
        self.assertTrue(result["frontendRecheck"]["frontendServerWorkloadReverified"])
        starts = [a for a in self.calls if a[1] == "start"]
        self.assertEqual(len(starts), len(release.STAGES))
        self.assertEqual({i for a in starts for i in a[2:]}, {c["containerId"] for c in self.plan["containers"]})
        self.assertFalse(any("--execute" in a or "up" in a or "pull" in a or "--force-recreate" in a for a in self.calls))
        self.assertEqual((self.prior / "runtime-failure.json").read_bytes(), failure)
        self.assertEqual((self.database / "migration-outcome.json").read_bytes(), database)
        for file in self.output.iterdir():
            self.assertNotIn("fixture-protection-bypass", file.read_text())
            self.assertNotIn('"secret"', file.read_text())

    def test_confirmation_precedes_provider_and_process_access(self):
        with self.assertRaisesRegex(ValueError, "EXPLICIT_OPERATOR_RECOVERY_CONFIRMATION_REQUIRED"):
            self.execute(confirmation="production/test-release/recover")
        self.assertEqual(self.provider_calls, [])
        self.assertEqual(self.calls, [])

    def test_changed_database_receipt_refuses_before_provider_access(self):
        path = self.database / "course/database-receipt.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "RECOVERY_DATABASE_RECEIPT_REQUIRED"):
            self.execute()
        self.assertEqual(self.provider_calls, [])
        self.assertEqual(self.calls, [])

    def test_changed_alias_or_enabled_schedules_refuses_before_start(self):
        self.alias = "dpl_unrelated"
        with self.assertRaisesRegex(ValueError, "RECOVERY_STAGING_ALIAS_REQUIRED"):
            self.execute()
        self.alias = "dpl_fixture"
        self.project["crons"]["disabledAt"] = None
        with self.assertRaisesRegex(ValueError, "RECOVERY_COMPLETED_PROMOTION_REQUIRED"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_missing_container_refuses_without_replacement(self):
        self.missing = True
        with self.assertRaisesRegex(ValueError, "RECOVERY_EXACT_EXISTING_CONTAINERS_REQUIRED"):
            self.execute()
        self.assertFalse(self.output.exists())
        self.assertFalse(any(a[1] == "start" for a in self.calls))

    def test_boundary_failure_stops_runtime_and_retains_failure(self):
        self.bad_boundary = True
        with self.assertRaisesRegex(ValueError, "RECOVERY_BOUNDARY_CHECKS_REQUIRED"):
            self.execute()
        outcome = migrate.read_json(self.output, "recovery-outcome.json")
        self.assertTrue(outcome["runtimeStopped"])
        self.assertEqual(self.runtime.running, set())
        self.assertFalse(outcome["releaseAccepted"])

    def test_readiness_timeout_stops_runtime_without_retrying_start(self):
        with patch.object(recovery, "wait_stage", side_effect=ValueError("RECOVERY_READINESS_TIMEOUT")):
            with self.assertRaisesRegex(ValueError, "RECOVERY_READINESS_TIMEOUT"):
                self.execute()
        self.assertEqual(sum(a[1] == "start" for a in self.calls), 1)
        self.assertEqual(self.runtime.running, set())
        self.assertTrue(migrate.read_json(self.output, "recovery-outcome.json")["runtimeStopped"])

    def test_real_https_frontend_failure_stops_runtime(self):
        self.fixture.probe.probe_status = 503
        with self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_REQUEST_FAILED"):
            self.execute()
        self.assertEqual(self.runtime.running, set())
        self.assertTrue(migrate.read_json(self.output, "recovery-outcome.json")["runtimeStopped"])

    def test_busy_lock_refuses_before_provider_and_start(self):
        with self.lock.open("a+") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.execute()
        self.assertEqual(self.provider_calls, [])
        self.assertEqual(self.calls, [])

    def test_expired_probe_does_not_extend_credentials_or_claim_reverification(self):
        path = self.prior / "configuration" / frontend_probe.PRIVATE_FILE
        value = json.loads(path.read_text())
        value["expiresAt"] = 1
        path.write_text(json.dumps(value))
        result = self.execute()
        self.assertFalse(result["frontendRecheck"]["frontendServerWorkloadReverified"])
        self.assertFalse(result["frontendRecheck"]["nativeSchedulerVerified"])
        self.assertEqual(json.loads(path.read_text())["expiresAt"], 1)

    def test_same_recovery_cannot_restart_or_overwrite_an_attempt(self):
        self.execute()
        before = (self.output / "recovery-outcome.json").read_bytes()
        starts = sum(a[1] == "start" for a in self.calls)
        with self.assertRaisesRegex(ValueError, "RECOVERY_EXISTING_CONTAINER_CHANGED"):
            self.execute()
        self.assertEqual(sum(a[1] == "start" for a in self.calls), starts)
        self.assertEqual((self.output / "recovery-outcome.json").read_bytes(), before)

    def test_provider_client_refuses_mutations_before_network(self):
        client = recovery.ReadOnlyClient("fixture-token")
        for method in ("POST", "PATCH"):
            with self.assertRaisesRegex(ValueError, "RECOVERY_PROVIDER_MUTATION_REFUSED"):
                client.request(method, "/v10/projects/test/promote/dpl_test", {})


if __name__ == "__main__":
    unittest.main()
