import copy
import fcntl
import json
import os
import subprocess
import unittest
from unittest.mock import patch

import frontend_probe
import frontend_probe_test
import release_test
import staging_release
import vercel


class StagingReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frontend_probe_test.FrontendProbeTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        frontend_probe_test.FrontendProbeTests.tearDownClass()

    def setUp(self):
        self.runtime = release_test.RuntimeReleaseTests(methodName="runTest")
        self.runtime.setUp()
        self.runtime.fixture.add_frontend()
        self.runtime.fixture.jobs["frontend"]["target"]["approvedPendingTags"] = []
        self.runtime.fixture.release["workload"] = {"environment": "production", "projectId": vercel.PROJECTS["staging"]}
        self.runtime.gateway["projectId"] = vercel.PROJECTS["staging"]
        self.runtime.save("gateway.json", self.runtime.gateway)
        self.runtime.fixture.save()
        self.probe = frontend_probe_test.FrontendProbeTests(methodName="runTest")
        self.probe.setUp()
        self.probe.release = self.runtime.fixture.release

    def tearDown(self):
        self.probe.tearDown()
        self.runtime.tearDown()

    def execute(self, apply=True, confirmation="staging/test-release"):
        r = self.runtime
        return staging_release.execute(r.bundle, r.configuration, r.results, r.compose, apply, confirmation, r.root / "release.lock")

    def deployment(self):
        value = self.probe.fixture.deployment()
        value["meta"]["lashReleaseId"] = "test-release"
        return value

    def enqueue(self):
        p, f, d = self.probe, self.probe.fixture, self.deployment
        # Read-only provider access/protection preflight, before database work.
        f.enqueue(p.project(enabled=True), p.project(enabled=True))
        # Locked state check, native schedule disable/readback and final check.
        f.enqueue(p.project(enabled=True), p.project(enabled=True), {}, p.project(), p.project())
        # Existing build guards receive the exact completed frontend source pin.
        keys = ("STAGING_RELEASE_COMMIT", "STAGING_MIGRATION_VERIFIED_COMMIT")
        variables = [{"key": key, "value": "a" * 40, "target": ["production"], "type": "plain"} for key in keys]
        f.enqueue(*({"created": item, "failed": []} for item in variables), {"envs": variables})
        # Expiring probe preparation and exact-source staged remote build.
        p.prepared_responses()
        f.enqueue(p.project(), {"id": "dpl_fixture"}, d(), p.project())
        # Promotion verification invokes the real owned HTTPS workload caller.
        f.enqueue(p.project(), d(), d(), p.project(), p.project(), {})
        promoted = p.project(deployment="dpl_fixture")
        promoted["lastAliasRequest"] = {"jobStatus": "succeeded", "requestedAt": 456, "toDeploymentId": "dpl_fixture", "type": "promote"}
        f.enqueue(d(), promoted)

    def patches(self):
        stack = self.runtime.patches()
        stack.enter_context(patch.dict(os.environ, {"VERCEL_TOKEN": "fixture-private-token", "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}))
        stack.enter_context(patch.object(staging_release.vercel, "Client", return_value=self.probe.client))
        stack.enter_context(patch.object(frontend_probe, "ProbeClient", return_value=self.probe.mapped_http()))
        def docker(args, **kwargs):
            self.assertNotIn("VERCEL_TOKEN", kwargs["env"])
            return self.runtime.docker(args, **kwargs)
        stack.enter_context(patch.object(subprocess, "run", side_effect=docker))
        return stack

    def test_plan_contacts_no_provider_or_process_and_reads_no_runtime_secret_files(self):
        for service in staging_release.runtime.ENV_FILES:
            (self.runtime.configuration / f"{service}.env").unlink()
        with patch.object(vercel, "Client", side_effect=AssertionError("Credential read")), patch.object(subprocess, "run", side_effect=AssertionError("Process run")):
            plan = self.execute(False)
        self.assertEqual(plan["operation"], "initial-staging-qualification")
        self.assertFalse(plan["credentialsRead"])
        self.assertFalse(plan["frontendProducerSuspensionRequired"])
        self.assertFalse(plan["releaseAccepted"])
        self.assertEqual(list(self.runtime.results.iterdir()), [])

    def source_pin_receipts(self, label):
        parent = self.runtime.root / ("source-pins-" + label)
        parent.mkdir(mode=0o700)
        (parent / "frontend").mkdir(mode=0o700)
        job = self.runtime.fixture.jobs["frontend"]
        database = {**copy.deepcopy(job), "service": "frontend", "status": "DATABASE_VERIFIED", "schemaVerified": True,
                    "runtimeRoleVerified": True, "migrationMode": "verify-current-only", "readOnlyVerified": True, "applied": []}
        terminal = {**copy.deepcopy(database)}
        return parent, database, terminal

    def write_source_pin_receipts(self, parent, database, terminal):
        from migrate import write_json, file_hash, read_input
        write_json(parent / "frontend", "database-receipt.json", database)
        write_json(parent / "frontend", "job-outcome.json", terminal)
        write_json(parent, "migration-outcome.json", {"status": "DATABASES_VERIFIED", "environment": "staging", "releaseId": "test-release",
                   "databaseReceiptSha256": {"frontend": file_hash(read_input(parent / "frontend", "database-receipt.json"))}})

    def test_source_pin_gate_rejects_incomplete_stale_or_mismatched_database_proof_before_provider_calls(self):
        cases = [
            ("wrong-source", lambda db, end: db.update(sourceCommit="b" * 40)),
            ("wrong-image", lambda db, end: db.update(migrationImageDigest="sha256:" + "c" * 64)),
            ("missing-read-only", lambda db, end: db.update(readOnlyVerified=False)),
            ("missing-schema", lambda db, end: db.update(schemaVerified=False)),
            ("missing-role", lambda db, end: db.update(runtimeRoleVerified=False)),
            ("terminal-failure", lambda db, end: end.update(status="FAILED_REQUIRES_REVIEW")),
            ("applied-sql", lambda db, end: db.update(applied=["unexpected-sql"])),
            ("wrong-target", lambda db, end: db["target"].update(host="different.example.invalid")),
        ]
        for label, change in cases:
            with self.subTest(label=label):
                parent, database, terminal = self.source_pin_receipts(label)
                change(database, terminal)
                self.write_source_pin_receipts(parent, database, terminal)
                attempt = parent / "attempt"; attempt.mkdir(mode=0o700)
                with patch.object(self.probe.client, "request", side_effect=AssertionError("Provider called")):
                    with self.assertRaises(ValueError):
                        staging_release.configure_source_pins(self.probe.client, self.runtime.fixture.release,
                            {name: {"job": job} for name, job in self.runtime.fixture.jobs.items()}, parent, attempt)
                self.assertEqual(list(attempt.iterdir()), [])

    def test_source_pin_readback_mismatch_retains_failure_and_never_marks_configured(self):
        parent, database, terminal = self.source_pin_receipts("readback")
        self.write_source_pin_receipts(parent, database, terminal)
        attempt = parent / "attempt"; attempt.mkdir(mode=0o700)
        variables = [{"key": key, "value": "b" * 40, "type": "plain", "target": ["production"]}
                     for key in ("STAGING_RELEASE_COMMIT", "STAGING_MIGRATION_VERIFIED_COMMIT")]
        self.probe.fixture.enqueue(*({"created": item, "failed": []} for item in variables), {"envs": variables})
        with self.assertRaisesRegex(ValueError, "SOURCE_PIN_READBACK_UNVERIFIED"):
            staging_release.configure_source_pins(self.probe.client, self.runtime.fixture.release,
                {name: {"job": job} for name, job in self.runtime.fixture.jobs.items()}, parent, attempt)
        result = json.loads((attempt / "source-pins-outcome.json").read_text())
        self.assertEqual(result["status"], "SOURCE_PINS_FAILED_REQUIRES_REVIEW")
        self.assertEqual(len([call for call in self.probe.fixture.calls if call["method"] == "POST"]), 2)

    def test_confirmation_pending_frontend_and_production_are_refused_before_credentials(self):
        with patch.object(vercel, "Client", side_effect=AssertionError("Credential read")), patch.object(staging_release.runtime, "assert_host", side_effect=AssertionError("Host checked")):
            with self.assertRaisesRegex(ValueError, "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED"):
                self.execute(confirmation="production/test-release")
            self.runtime.fixture.jobs["frontend"]["target"]["approvedPendingTags"] = ["0000_test"]
            self.runtime.fixture.save()
            with self.assertRaisesRegex(ValueError, "PENDING_FRONTEND_SQL_REQUIRES_QUIESCENCE_COORDINATOR"):
                self.execute()
        selected = copy.deepcopy(self.runtime.fixture.release)
        selected["environment"] = "production"; selected["workload"]["projectId"] = vercel.PROJECTS["production"]
        with patch.object(staging_release.runtime, "make_plan", return_value=(selected, {}, {}, b"")), self.assertRaisesRegex(ValueError, "INITIAL_QUALIFICATION_REQUIRES_STAGING"):
            self.execute(False)
        self.assertEqual(list(self.runtime.results.iterdir()), [])

    def test_missing_provider_token_refuses_before_api_configuration_or_database_commands(self):
        with self.runtime.patches(), patch.dict(os.environ, {"VERCEL_TOKEN": ""}), self.assertRaisesRegex(ValueError, "VERCEL_PRIVATE_TOKEN_REQUIRED"):
            self.execute()
        self.assertEqual(self.runtime.calls, [])
        self.assertEqual(self.probe.fixture.calls, [])

    def test_three_databases_api_startup_http_workload_and_promotion_share_the_actual_lock(self):
        self.enqueue()
        original = self.probe.client.request
        def request(method, path, body=None):
            if method != "GET":
                r = self.runtime
                self.assertEqual(json.loads((r.results / "runtime-test-release/runtime-outcome.json").read_text())["status"], "API_RUNTIME_READY")
                self.assertTrue(json.loads((r.results / "test-release/frontend/job-outcome.json").read_text())["readOnlyVerified"])
                with (r.root / "release.lock").open() as stream:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return original(method, path, body)
        with self.patches(), patch.object(self.probe.client, "request", side_effect=request):
            result = self.execute()
        self.assertEqual(result["status"], "STAGING_READY_FOR_LIVE_QUALIFICATION")
        self.assertTrue(result["frontendDomainsPromoted"])
        self.assertTrue(result["frontendServerWorkloadVerified"])
        self.assertTrue(result["nativeSchedulesDisabled"])
        for key in ("trafficAuthorized", "gatewayTrafficAuthorized", "releaseAccepted", "nativeSchedulerVerified", "externalIngressVerified"):
            self.assertFalse(result[key])
        calls = self.probe.fixture.calls
        self.assertEqual(len([c for c in calls if "/promote/" in c["path"]]), 1)
        self.assertEqual([c["body"] for c in calls if "/crons?" in c["path"]], [{"enabled": False}])
        self.assertEqual(len(self.probe.probes), 1)
        self.assertEqual(self.probe.fixture.responses, [])
        attempt = self.runtime.results / "runtime-test-release/frontend"
        private = json.loads((self.runtime.results / "runtime-test-release/configuration/frontend-probe-private.json").read_text())
        records = "".join(p.read_text() for p in attempt.iterdir())
        for value in (private["secret"], "fixture-private-token", "fixture-protection-bypass"):
            self.assertNotIn(value, records)
        self.assertTrue((attempt / "staging-outcome.json").exists())

    def test_deployed_probe_failure_stops_runtime_preserves_database_results_and_never_promotes(self):
        self.enqueue(); self.probe.probe_status = 503
        with self.patches(), self.assertRaisesRegex(ValueError, "FRONTEND_LIVE_VERIFICATION_FAILED"):
            self.execute()
        self.assertEqual(self.runtime.running, set())
        self.assertFalse(any("/promote/" in c["path"] for c in self.probe.fixture.calls))
        root = self.runtime.results
        self.assertEqual(json.loads((root / "test-release/migration-outcome.json").read_text())["status"], "DATABASES_VERIFIED")
        self.assertTrue(json.loads((root / "runtime-test-release/runtime-failure.json").read_text())["runtimeStopped"])
        outcome = json.loads((root / "runtime-test-release/frontend/staging-outcome.json").read_text())
        self.assertEqual(outcome["status"], "FAILED_REQUIRES_REVIEW")
        self.assertFalse(outcome["releaseAccepted"])

    def test_uncertain_promotion_is_not_repeated_or_rolled_back_and_runtime_stops(self):
        self.enqueue()
        original = self.probe.client.request
        def request(method, path, body=None):
            if method == "POST" and "/promote/" in path:
                self.probe.fixture.responses[0] = (500, {"error": "private-provider-credential"}, {})
            return original(method, path, body)
        with self.patches(), patch.object(self.probe.client, "request", side_effect=request), self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            self.execute()
        self.assertEqual(self.runtime.running, set())
        calls = self.probe.fixture.calls
        self.assertEqual(len([c for c in calls if "/promote/" in c["path"]]), 1)
        self.assertFalse(any("rollback" in c["path"].split("?", 1)[0] for c in calls))
        outcome = (self.runtime.results / "runtime-test-release/frontend/staging-outcome.json").read_text()
        self.assertIsNone(json.loads(outcome)["frontendDomainsPromoted"])
        self.assertNotIn("private-provider-credential", outcome)

    def test_provider_drift_after_preflight_stops_before_any_provider_mutation(self):
        self.probe.fixture.enqueue(self.probe.project(enabled=True), self.probe.project(enabled=True), self.probe.project(deployment="dpl_unrelated"))
        with self.patches(), self.assertRaisesRegex(ValueError, "VERCEL_PROJECT_CHANGED_BEFORE_STAGING"):
            self.execute()
        self.assertFalse(any(c["method"] != "GET" for c in self.probe.fixture.calls))
        self.assertEqual(self.runtime.running, set())
