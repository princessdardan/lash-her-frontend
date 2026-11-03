import json
import time
import unittest
from unittest.mock import patch
import fcntl
import tempfile
from pathlib import Path
import threading

import frontend_probe
import migrate
import native_qualification as native
import vercel_test
import staging_recovery_test
import release


class Clock:
    def __init__(self):
        self.elapsed, self.base, self.sleeps = 0, time.time(), []

    def time(self):
        return self.base + self.elapsed

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.elapsed += seconds


class ReleaseLockTests(unittest.TestCase):
    def test_real_brief_contention_waits_and_acquires_without_provider_access(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.lock"
            with path.open("a+") as owner, path.open("a+") as contender:
                fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                release_owner = threading.Timer(0.05, lambda: fcntl.flock(owner.fileno(), fcntl.LOCK_UN))
                release_owner.start()
                try:
                    native.acquire_release_lock(contender)
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    release_owner.join()

    def test_permanent_contention_is_bounded_and_classified(self):
        clock = Clock()
        with tempfile.TemporaryFile() as lock, patch.object(native.fcntl, "flock", side_effect=BlockingIOError):
            with self.assertRaisesRegex(ValueError, "NATIVE_RELEASE_LOCK_BUSY"):
                native.acquire_release_lock(lock, clock)
        self.assertEqual(clock.elapsed, 30)
        self.assertTrue(all(0 < value <= 0.25 for value in clock.sleeps))

    def test_permission_failure_and_interruption_are_not_retried(self):
        with tempfile.TemporaryFile() as lock, patch.object(native.fcntl, "flock", side_effect=PermissionError) as flock:
            with self.assertRaises(PermissionError):
                native.acquire_release_lock(lock, Clock())
            self.assertEqual(flock.call_count, 1)
        clock = Clock()
        with tempfile.TemporaryFile() as lock, patch.object(native.fcntl, "flock", side_effect=BlockingIOError), \
                patch.object(clock, "sleep", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                native.acquire_release_lock(lock, clock)

    def test_safe_failure_classifies_without_exception_payloads(self):
        self.assertEqual(native.safe_failure(ValueError("NATIVE_RELEASE_LOCK_BUSY")),
                         {"errorClass": "ValueError", "failureCode": "NATIVE_RELEASE_LOCK_BUSY"})
        for error in [ValueError("postgresql://private-user:private-password@private-host/db"),
                      RuntimeError("provider-token-private"), FileExistsError("private-path")]:
            result = native.safe_failure(error)
            self.assertEqual(result["failureCode"], "NATIVE_QUALIFICATION_EXECUTION_FAILED")
            self.assertNotIn("private", json.dumps(result))


class NativeWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.fixture = vercel_test.VercelControlTests(methodName="runTest")
        self.fixture.setUp()
        self.frontend = self.fixture.attempt
        self.identity = self.fixture.staged()
        self.private = self.frontend / "private"
        self.private.mkdir(mode=0o700)
        self.output = self.frontend / "window"
        self.output.mkdir(mode=0o700)
        self.clock = Clock()
        migrate.write_json(self.private, frontend_probe.PRIVATE_FILE,
            {**{k: self.identity[k] for k in ("environment", "projectId", "sourceCommit", "releaseId")},
             "expiresAt": int(time.time() * 1000) + 3_600_000, "secret": "b" * 64,
             "gatewayOrigin": "https://gateway.example.invalid"})

    def tearDown(self):
        self.fixture.tearDown()

    def project(self, enabled):
        value = self.fixture.project(enabled=enabled, deployment="dpl_fixture")
        value["crons"].update(deploymentId="dpl_fixture", definitions=[
            {"host": "owned-fixture.vercel.app", "path": native.PATH, "schedule": native.SCHEDULE}])
        return value

    def state(self, enabled, project=None):
        self.fixture.enqueue(self.fixture.deployment(), project or self.project(enabled))

    def start(self):
        self.state(False)
        self.fixture.enqueue({})
        self.state(True)

    def finish(self):
        self.fixture.enqueue({})
        for _ in range(3):
            self.state(False)

    def execute(self, **kwargs):
        return native.native_window(self.fixture.client, self.fixture.release, self.frontend,
            self.output, self.private, clock=self.clock, **{"window_seconds": 60, **kwargs})

    def test_real_https_fixed_window_disables_drains_and_requires_provider_evidence(self):
        self.start()
        self.finish()
        result = self.execute()
        self.assertEqual(result["status"], "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE")
        self.assertTrue(result["disabledAndDrained"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertFalse(result["manualCronInvocation"])
        self.assertFalse(result["cronSecretRead"])
        self.assertEqual(result["drainCompletedAt"] - result["disabledConfirmedAt"], 16_000)
        self.assertEqual(result["cancellationObservationCompletedAt"] - result["drainCompletedAt"], 60_000)
        writes = [c for c in self.fixture.calls if c["method"] != "GET"]
        self.assertEqual([c["body"] for c in writes], [{"enabled": True}, {"enabled": False}])
        self.assertTrue(all("/crons?" in c["path"] for c in writes))
        self.assertFalse(any(native.PATH in c["path"] for c in self.fixture.calls))
        records = "".join(p.read_text() for p in self.output.iterdir())
        for value in ("fixture-private-token", "provider-secret-must-not-escape", "private-provider-bypass", "b" * 64):
            self.assertNotIn(value, records)

    def test_business_schedule_or_wrong_deployment_refuses_before_enable(self):
        project = self.project(False)
        project["crons"]["definitions"].append({"path": "/api/cron/highlevel-sync", "schedule": "* * * * *"})
        self.state(False, project)
        with self.assertRaisesRegex(ValueError, "NATIVE_EXACT_DEPLOYMENT_AND_SINGLE_SMOKE_REQUIRED"):
            self.execute()
        self.assertTrue(all(c["method"] == "GET" for c in self.fixture.calls))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_enable_latency_does_not_extend_cancellation_deadline(self):
        self.start()
        self.finish()
        original = self.fixture.client.request
        def delayed(method, path, body=None):
            if method == "PATCH" and body == {"enabled": True}:
                self.clock.sleep(45)
            return original(method, path, body)
        with patch.object(self.fixture.client, "request", side_effect=delayed):
            result = self.execute()
        self.assertEqual(result["disabledConfirmedAt"] - result["enableRequestStartedAt"], 60_000)
        self.assertTrue(result["disabledAndDrained"])

    def test_near_expiry_refuses_before_provider_access(self):
        p = self.private / frontend_probe.PRIVATE_FILE
        value = json.loads(p.read_text())
        value["expiresAt"] = int(time.time() * 1000) + 1000
        p.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "NATIVE_LIVE_QUALIFICATION_WINDOW_REQUIRED"):
            self.execute()
        self.assertEqual(self.fixture.calls, [])

    def test_ambiguous_enable_is_not_repeated_and_still_disables(self):
        self.state(False)
        self.fixture.responses.append((503, {"error": "fixture-private-token"}, {}))
        self.finish()
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            self.execute()
        result = migrate.read_json(self.output, "native-window-outcome.json")
        self.assertTrue(result["disabledAndDrained"])
        self.assertEqual(result["status"], "NATIVE_WINDOW_REQUIRES_REVIEW")
        self.assertEqual([c["body"] for c in self.fixture.calls if c["method"] == "PATCH"], [{"enabled": True}, {"enabled": False}])

    def test_disable_failure_preserves_uncertainty_and_does_not_repeat(self):
        self.start()
        self.fixture.responses.append((503, {}, {}))
        with self.assertRaisesRegex(ValueError, "NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW"):
            self.execute()
        result = migrate.read_json(self.output, "native-window-outcome.json")
        self.assertFalse(result["disabledAndDrained"])
        self.assertEqual(result["status"], "NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW")
        self.assertEqual(sum(c["method"] == "PATCH" for c in self.fixture.calls), 2)

    def test_provider_drift_during_window_still_disables_and_never_claims_success(self):
        self.start()
        changed = self.project(False)
        changed["crons"]["definitions"][0]["path"] = "/api/cron/highlevel-sync"
        self.fixture.enqueue({})
        self.state(False, changed)
        with self.assertRaisesRegex(ValueError, "NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW"):
            self.execute()
        result = migrate.read_json(self.output, "native-window-outcome.json")
        self.assertFalse(result["disabledAndDrained"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertEqual([c["body"] for c in self.fixture.calls if c["method"] == "PATCH"], [{"enabled": True}, {"enabled": False}])

    def test_failed_cancellation_observation_does_not_claim_drained(self):
        self.start()
        self.fixture.enqueue({})
        self.state(False)
        self.state(False)
        self.state(True)
        with self.assertRaisesRegex(ValueError, "NATIVE_DISABLE_OR_DRAIN_REQUIRES_REVIEW"):
            self.execute()
        self.assertFalse(migrate.read_json(self.output, "native-window-outcome.json")["disabledAndDrained"])

    def test_attempt_cannot_repeat_enable(self):
        self.start()
        self.finish()
        self.execute()
        self.state(False)
        with self.assertRaises(FileExistsError):
            self.execute()
        self.assertEqual(sum(c["method"] == "PATCH" for c in self.fixture.calls), 2)

    def test_window_bounds_refuse_before_provider_access(self):
        for value in (0, 59, 181, True):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "NATIVE_WINDOW_BOUND_REQUIRED"):
                self.execute(window_seconds=value)
        self.assertEqual(self.fixture.calls, [])


class FrontendQualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        staging_recovery_test.StagingRecoveryTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        staging_recovery_test.StagingRecoveryTests.tearDownClass()

    def setUp(self):
        self.r = staging_recovery_test.StagingRecoveryTests(methodName="runTest")
        self.r.setUp()
        self.r.runtime.running.update(release.SERVICES)
        self.r.runtime.calls.clear()
        self.output = self.r.runtime.results / "native-qualification"
        self.provider = self.r.fixture.probe.fixture
        self.provider.calls.clear()
        self.provider.responses.clear()
        self.clock = Clock()

    def tearDown(self):
        self.r.tearDown()

    def project(self, enabled=False, promoted=False):
        project = self.r.fixture.probe.project(enabled=enabled, deployment="dpl_second" if promoted else "dpl_fixture")
        if promoted:
            project["lastAliasRequest"] = {"jobStatus": "succeeded", "requestedAt": 999,
                "toDeploymentId": "dpl_second", "type": "promote"}
            project["crons"].update(deploymentId="dpl_second", definitions=[{
                "host": "owned-fixture.vercel.app", "path": native.PATH, "schedule": native.SCHEDULE}])
        return project

    def deployment(self):
        value = self.r.fixture.deployment()
        value["id"] = "dpl_second"
        return value

    def enqueue(self, promotion_error=False):
        f, project, deployment = self.provider, self.project, self.deployment
        # Preflight, preparation, four scoped env upserts and unchanged pointer.
        f.enqueue(project(), project())
        cron = {"id": "env_fixture_cron", "key": "CRON_SECRET", "type": "sensitive", "target": ["production", "preview"]}
        f.enqueue({"envs": [cron]}, {}, {"envs": [{**cron, "target": ["production"]}]}, project(), project())
        for key, kind in [("LASH_RELEASE_PROBE_SECRET", "sensitive"), ("LASH_RELEASE_PROBE_EXPIRES_AT", "plain"),
                          ("LASH_RELEASE_SCHEDULER_QUALIFICATION", "plain"), ("API_GATEWAY_STAGING_ORIGIN", "plain")]:
            f.enqueue({"created": {"key": key, "type": kind, "target": ["production"]}, "failed": []})
        f.enqueue(project())
        # Build and the actual owned HTTPS server verification callback.
        f.enqueue(project(), {"id": "dpl_second"}, deployment(), project(),
                  project(), deployment(), deployment(), project(), project())
        f.responses.append((503 if promotion_error else 201, b"" if not promotion_error else {}, {}))
        if promotion_error:
            return
        f.enqueue(deployment(), project(promoted=True))
        f.enqueue(deployment(), project(promoted=True), {}, deployment(), project(enabled=True, promoted=True))
        f.enqueue({})
        for _ in range(3):
            f.enqueue(deployment(), project(promoted=True))

    def execute(self, **kwargs):
        with self.r.runtime.patches(), patch.object(frontend_probe, "ProbeClient", return_value=self.r.fixture.probe.mapped_http()):
            return native.execute(self.r.prior, self.r.database, self.output, "dpl_fixture",
                client=self.r.fixture.probe.client, lock_path=self.r.lock, clock=self.clock,
                **{"apply": True, "confirmation": "staging/test-release/native-qualification-1", "window_seconds": 60, **kwargs})

    def test_full_frontend_only_flow_holds_lock_and_never_runs_sql_or_restarts_runtime(self):
        self.enqueue()
        request = self.r.fixture.probe.client.request
        def locked(method, path, body=None):
            with self.r.lock.open() as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return request(method, path, body)
        with patch.object(self.r.fixture.probe.client, "request", side_effect=locked):
            result = self.execute()
        self.assertEqual(result["status"], "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE")
        self.assertTrue(result["frontendServerWorkloadVerified"])
        self.assertTrue(result["nativeSchedulesDisabled"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertFalse(result["releaseAccepted"])
        self.assertEqual(self.r.runtime.running, set(release.SERVICES))
        self.assertFalse(any("--execute" in a or "up" in a or "start" in a or "stop" in a or "pull" in a for a in self.r.runtime.calls))
        self.assertEqual(sum(c["method"] == "POST" and "/promote/" in c["path"] for c in self.provider.calls), 1)
        self.assertEqual([c["body"] for c in self.provider.calls if c["method"] == "PATCH"], [{"target": ["production"]}, {"enabled": True}, {"enabled": False}])
        self.assertFalse(any("CRON_SECRET" in c["path"] or native.PATH in c["path"] for c in self.provider.calls))
        # Reuse cannot create another deployment or overwrite the first attempt.
        writes = sum(c["method"] != "GET" for c in self.provider.calls)
        self.provider.enqueue(self.project())
        self.provider.enqueue(self.project())
        with self.assertRaises(FileExistsError):
            self.execute()
        self.assertEqual(sum(c["method"] != "GET" for c in self.provider.calls), writes)

    def test_ambiguous_promotion_leaves_runtime_running_and_never_enables_cron(self):
        self.enqueue(promotion_error=True)
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            self.execute()
        self.assertEqual(self.r.runtime.running, set(release.SERVICES))
        self.assertFalse(any(c["method"] == "PATCH" and "/crons?" in c["path"] for c in self.provider.calls))
        self.assertIsNone(migrate.read_json(self.output / "frontend", "frontend-promotion-outcome.json")["frontendDomainsPromoted"])

    def test_plan_and_confirmation_do_not_access_provider(self):
        plan = self.execute(apply=False)
        self.assertEqual(plan["operation"], "frontend-only-native-qualification")
        self.assertFalse(plan["migrationsExecuted"])
        with self.assertRaisesRegex(ValueError, "EXPLICIT_NATIVE_QUALIFICATION_CONFIRMATION_REQUIRED"):
            self.execute(confirmation="production/test-release/native-qualification-1")
        self.assertEqual(self.provider.calls, [])
        self.assertFalse(self.output.exists())

    def test_provider_drift_refuses_before_creating_probe_or_build(self):
        changed = self.project()
        changed["targets"]["production"]["id"] = "dpl_unrelated"
        self.provider.enqueue(changed)
        with self.assertRaisesRegex(ValueError, "NATIVE_CURRENT_PROJECT_CHANGED"):
            self.execute()
        self.assertEqual(len(self.provider.calls), 1)
        self.assertFalse(self.output.exists())

    def test_busy_lock_times_out_before_action_intent_or_provider_access(self):
        with patch.object(native.fcntl, "flock", side_effect=BlockingIOError):
            with self.assertRaisesRegex(ValueError, "NATIVE_RELEASE_LOCK_BUSY"):
                self.execute()
        self.assertEqual(self.clock.elapsed, 30)
        self.assertEqual(self.provider.calls, [])
        self.assertFalse(self.output.exists())


class CronScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.fixture = vercel_test.VercelControlTests(methodName="runTest")
        self.fixture.setUp()
        self.binding = {"id": "env_fixture_cron", "key": "CRON_SECRET", "type": "sensitive",
                        "target": ["production", "preview"], "value": "private-credential-must-not-escape"}

    def tearDown(self):
        self.fixture.tearDown()

    def execute(self):
        return native.restrict_cron_binding(self.fixture.client, self.fixture.release, self.fixture.attempt)

    def test_scoping_only_changes_target_and_never_copies_or_prints_value(self):
        self.fixture.enqueue({"envs": [self.binding]}, self.binding,
                             {"envs": [{**self.binding, "target": ["production"]}]})
        result = self.execute()
        self.assertTrue(result["scopeChanged"])
        writes = [c for c in self.fixture.calls if c["method"] != "GET"]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]["body"], {"target": ["production"]})
        self.assertIn("/env/env_fixture_cron?", writes[0]["path"])
        self.assertTrue(all("decrypt=false" in c["path"] for c in self.fixture.calls if c["method"] == "GET"))
        self.assertNotIn(self.binding["value"], "".join(p.read_text() for p in self.fixture.attempt.iterdir()))

    def test_already_restricted_binding_is_not_mutated(self):
        self.binding["target"] = ["production"]
        self.fixture.enqueue({"envs": [self.binding]}, {"envs": [self.binding]})
        self.assertFalse(self.execute()["scopeChanged"])
        self.assertTrue(all(c["method"] == "GET" for c in self.fixture.calls))

    def test_other_scope_type_duplicate_or_branch_refuses_before_write(self):
        cases = [[{**self.binding, "target": ["development", "production"]}],
                 [{**self.binding, "type": "plain"}], [{**self.binding, "gitBranch": "feature"}],
                 [self.binding, self.binding], []]
        for bindings in cases:
            self.fixture.enqueue({"envs": bindings})
            with self.assertRaises(ValueError):
                self.execute()
        self.assertTrue(all(c["method"] == "GET" for c in self.fixture.calls))

    def test_ambiguous_scope_write_is_not_repeated_and_preserves_uncertainty(self):
        self.fixture.enqueue({"envs": [self.binding]})
        self.fixture.responses.append((503, {}, {}))
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            self.execute()
        outcome = migrate.read_json(self.fixture.attempt, "cron-scope-outcome.json")
        self.assertIsNone(outcome["scopeChanged"])
        self.assertTrue(outcome["scopeChangeRequested"])
        self.assertEqual(sum(c["method"] == "PATCH" for c in self.fixture.calls), 1)

    def test_ignored_target_change_cannot_be_reported_as_success(self):
        self.fixture.enqueue({"envs": [self.binding]}, {}, {"envs": [self.binding]})
        with self.assertRaisesRegex(ValueError, "NATIVE_CRON_SCOPE_CHANGE_UNVERIFIED"):
            self.execute()
        self.assertIsNone(migrate.read_json(self.fixture.attempt, "cron-scope-outcome.json")["scopeChanged"])


if __name__ == "__main__":
    unittest.main()
