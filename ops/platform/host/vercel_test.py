from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import vercel


class VercelControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certificates = tempfile.TemporaryDirectory()
        root = Path(cls.certificates.name)
        cls.cert, cls.key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(cls.key), "-out", str(cls.cert)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @classmethod
    def tearDownClass(cls):
        cls.certificates.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.attempt = Path(self.directory.name)
        self.attempt.chmod(0o700)
        self.calls = []
        self.responses = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                owner.calls.append({"method": self.command, "path": self.path, "authorization": self.headers.get("Authorization"),
                                    "body": json.loads(raw) if raw else None})
                if not owner.responses:
                    self.send_error(500)
                    return
                status, body, headers = owner.responses.pop(0)
                # Match the provider: promotion-job metadata is opt-in.
                if (self.path.startswith("/v9/projects/") and "rollbackInfo=true" not in self.path
                        and isinstance(body, dict)):
                    body = {key: value for key, value in body.items() if key != "lastAliasRequest"}
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())
                except (BrokenPipeError, ssl.SSLError):
                    pass

            do_POST = do_GET
            do_PATCH = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, self.key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"https://127.0.0.1:{self.server.server_port}"
        self.api_patch = patch.object(vercel, "API_ORIGIN", self.origin)
        self.api_patch.start()
        # Trust only the owned fixture CA for this client's real TLS requests.
        context = ssl.create_default_context(cafile=str(self.cert))
        with patch.object(vercel.ssl, "create_default_context", return_value=context):
            self.client = vercel.Client("fixture-private-token")
        self.release = {"version": 2, "environment": "staging", "releaseId": "staging-fixture",
                        "workload": {"environment": "production", "projectId": vercel.PROJECTS["staging"]},
                        "sources": {"frontend": {"repository": "https://github.com/princessdardan/lash-her-frontend.git",
                                     "commit": "a" * 40, "requiredChecks": "passed"}}}

    def tearDown(self):
        self.api_patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def project(self, enabled=False, deployment="dpl_previous"):
        return {"id": vercel.PROJECTS["staging"], "accountId": vercel.TEAM,
                "link": {"type": "github", "repoId": vercel.REPOSITORY_ID},
                "targets": {"production": {"id": deployment}}, "crons": {"disabledAt": None if enabled else 123},
                "env": [{"value": "provider-secret-must-not-escape"}], "protectionBypass": "private-provider-bypass"}

    def deployment(self, state="READY"):
        return {"id": "dpl_fixture", "projectId": vercel.PROJECTS["staging"], "target": "production",
                "url": "owned-fixture.vercel.app", "readyState": state,
                "gitSource": {"type": "github", "repoId": vercel.REPOSITORY_ID, "sha": "a" * 40},
                "meta": {"lashReleaseId": "staging-fixture"}, "env": {"DATABASE_URL": "provider-secret-must-not-escape"}}

    def enqueue(self, *bodies):
        self.responses.extend((200, body, {}) for body in bodies)

    def staged(self):
        value = {"status": "FRONTEND_STAGED", "readyState": "READY", "environment": "staging",
                 "projectId": vercel.PROJECTS["staging"], "sourceCommit": "a" * 40,
                 "releaseId": "staging-fixture", "deploymentId": "dpl_fixture", "previousDeploymentId": "dpl_previous",
                 "trafficAuthorized": False, "promotionAuthorized": False}
        vercel.migrate.write_json(self.attempt, "frontend-build-outcome.json", value)
        return value

    def verified(self, release, deployment):
        return {"status": "FRONTEND_VERIFIED", "environment": release["environment"], "releaseId": release["releaseId"],
                **{key: deployment[key] for key in ("projectId", "sourceCommit", "deploymentId")}}

    def promotion_project(self, status=None, deployment="dpl_previous", requested=456, to="dpl_fixture"):
        value = self.project(deployment=deployment)
        if status is not None:
            value["lastAliasRequest"] = {"jobStatus": status, "requestedAt": requested, "toDeploymentId": to, "type": "promote"}
        return value

    def test_real_https_build_stages_exact_source_without_changing_production(self):
        self.enqueue(self.project(), {"id": "dpl_fixture"}, self.deployment("BUILDING"), self.project(), self.deployment(), self.project())
        with patch.object(vercel.time, "sleep"):
            result = vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertEqual(result["status"], "FRONTEND_STAGED")
        self.assertFalse(result["trafficAuthorized"])
        self.assertFalse(result["promotionAuthorized"])
        writes = [call for call in self.calls if call["method"] != "GET"]
        self.assertEqual(len(writes), 1)
        self.assertFalse(writes[0]["body"]["autoAssignCustomDomains"])
        self.assertEqual(writes[0]["body"]["gitSource"]["sha"], "a" * 40)
        self.assertEqual(writes[0]["body"]["gitSource"]["ref"], "staging")
        self.assertEqual(writes[0]["body"]["gitSource"]["sha"], "a" * 40)
        self.assertTrue(all("teamId=" + vercel.TEAM in call["path"] for call in self.calls))
        self.assertTrue(all(call["authorization"] == "Bearer fixture-private-token" for call in self.calls))
        receipts = "".join(path.read_text() for path in self.attempt.iterdir())
        for secret in ("fixture-private-token", "provider-secret-must-not-escape", "private-provider-bypass"):
            self.assertNotIn(secret, receipts)

    def test_cron_disable_has_readback_but_does_not_claim_writer_quiescence(self):
        self.enqueue(self.project(True), self.project(), self.project())
        result = vercel.disable_schedules(self.client, self.release)
        self.assertEqual(result["status"], "NATIVE_SCHEDULES_DISABLED")
        self.assertFalse(result["frontendQuiescenceVerified"])
        self.assertEqual(self.calls[1]["method"], "PATCH")
        self.assertEqual(self.calls[1]["body"], {"enabled": False})

    def test_ignored_cron_disable_is_refused(self):
        self.enqueue(self.project(True), {}, self.project(True))
        with self.assertRaisesRegex(ValueError, "VERCEL_CRON_DISABLE_UNVERIFIED"):
            vercel.disable_schedules(self.client, self.release)

    def test_cross_environment_target_refuses_before_network(self):
        self.release["environment"] = "production"
        with self.assertRaisesRegex(ValueError, "VERCEL_RELEASE_TARGET_REFUSED"):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertEqual(self.calls, [])

    def test_wrong_project_owner_or_repository_refuses_before_post(self):
        for field in ("accountId", "link"):
            with self.subTest(field=field):
                bad = self.project()
                bad[field] = "another-team" if field == "accountId" else {"type": "github", "repoId": "999"}
                self.enqueue(bad)
                with self.assertRaisesRegex(ValueError, "VERCEL_PROJECT_IDENTITY_REFUSED"):
                    vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertTrue(all(call["method"] == "GET" for call in self.calls))

    def test_enabled_schedules_refuse_build(self):
        self.enqueue(self.project(True))
        with self.assertRaisesRegex(ValueError, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED"):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertEqual(len(self.calls), 1)

    def test_changed_production_target_stops_without_promotion_or_rollback(self):
        self.enqueue(self.project(), {"id": "dpl_fixture"}, self.deployment(), self.project(deployment="dpl_unrelated"))
        with self.assertRaisesRegex(ValueError, "VERCEL_PROJECT_CHANGED_DURING_BUILD"):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertEqual([c["method"] for c in self.calls], ["GET", "POST", "GET", "GET"])

    def test_deployment_source_and_identity_substitutions_are_refused(self):
        for field, replacement in (("gitSource", {"type": "github", "repoId": vercel.REPOSITORY_ID, "sha": "b" * 40}),
                                   ("projectId", vercel.PROJECTS["production"]), ("target", "preview"),
                                   ("url", "attacker.example.invalid/path"), ("meta", {"lashReleaseId": "different"})):
            with self.subTest(field=field):
                value = self.deployment()
                value[field] = replacement
                self.enqueue(value)
                with self.assertRaisesRegex(ValueError, "VERCEL_DEPLOYMENT_BINDING_REFUSED"):
                    vercel.deployment_state(self.client, "dpl_fixture", vercel.PROJECTS["staging"], "a" * 40, "staging-fixture")

    def test_ambiguous_post_error_preserves_intent_and_never_retries(self):
        self.enqueue(self.project())
        self.responses.append((503, {"error": "fixture-private-token provider-secret-must-not-escape"}, {}))
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertTrue((self.attempt / "frontend-build-started.json").exists())
        self.assertFalse((self.attempt / "frontend-build-created.json").exists())
        self.enqueue(self.project())
        with self.assertRaises(FileExistsError):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)

    def test_observation_timeout_keeps_created_handle_without_restarting(self):
        self.enqueue(self.project(), {"id": "dpl_fixture"}, self.deployment("BUILDING"), self.project())
        with patch.object(vercel.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(ValueError, "VERCEL_BUILD_OBSERVATION_TIMED_OUT"):
                vercel.stage_frontend(self.client, self.release, self.attempt, timeout=1)
        handle = json.loads((self.attempt / "frontend-build-created.json").read_text())
        self.assertEqual(handle["deploymentId"], "dpl_fixture")
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)

    def test_redirect_does_not_forward_token(self):
        self.responses.append((307, {}, {"Location": self.origin + "/credential-sink"}))
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            self.client.request("GET", "/v9/projects/test")
        self.assertEqual(len(self.calls), 1)

    def test_untrusted_tls_is_refused_without_http_request(self):
        client = vercel.Client("fixture-private-token")
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            client.request("GET", "/v9/projects/test")
        self.assertEqual(self.calls, [])

    def test_failed_remote_build_preserves_handle_and_does_not_promote(self):
        self.enqueue(self.project(), {"id": "dpl_fixture"}, self.deployment("ERROR"))
        with self.assertRaisesRegex(ValueError, "VERCEL_BUILD_FAILED_REQUIRES_REVIEW"):
            vercel.stage_frontend(self.client, self.release, self.attempt)
        outcome = json.loads((self.attempt / "frontend-build-outcome.json").read_text())
        self.assertEqual(outcome["deploymentId"], "dpl_fixture")
        self.assertFalse(outcome["trafficAuthorized"])
        self.assertFalse(outcome["promotionAuthorized"])
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)

    def test_malformed_or_oversized_provider_response_is_sanitized(self):
        for value in (b"not-json fixture-private-token", b"x" * (vercel.MAX_RESPONSE + 1), ["not-an-object"]):
            self.responses.append((200, value, {}))
            with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
                self.client.request("GET", "/v9/projects/test")

    def test_promotion_waits_for_exact_alias_job_and_target_after_live_verification(self):
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project())
        # The provider acknowledges promotion without a JSON response body.
        self.responses.append((201, b"", {}))
        self.enqueue(self.deployment(), self.promotion_project("in-progress"),
                     self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture"))
        verified_calls = []

        def verify(release, deployment):
            verified_calls.append((release["releaseId"], deployment["deploymentId"]))
            self.assertTrue(all(c["method"] == "GET" for c in self.calls))
            return self.verified(release, deployment)

        with patch.object(vercel.time, "sleep"):
            result = vercel.promote_frontend(self.client, self.release, self.attempt, verify)
        self.assertEqual(verified_calls, [("staging-fixture", "dpl_fixture")])
        self.assertEqual(result["status"], "FRONTEND_DOMAINS_PROMOTED")
        self.assertTrue(result["frontendDomainsPromoted"])
        self.assertFalse(result["gatewayTrafficAuthorized"])
        self.assertFalse(result["trafficAuthorized"])
        writes = [c for c in self.calls if c["method"] != "GET"]
        self.assertEqual(len(writes), 1)
        self.assertIn("/promote/dpl_fixture?", writes[0]["path"])
        self.assertEqual(writes[0]["body"], {})
        project_reads = [c for c in self.calls if c["path"].startswith("/v9/projects/")]
        self.assertTrue(project_reads)
        self.assertTrue(all("rollbackInfo=true" in c["path"] for c in project_reads))
        receipts = "".join(p.read_text() for p in self.attempt.iterdir())
        for secret in ("fixture-private-token", "provider-secret-must-not-escape", "private-provider-bypass"):
            self.assertNotIn(secret, receipts)

    def test_queued_empty_promotion_response_still_requires_observed_completion(self):
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project())
        self.responses.append((202, b"", {}))
        self.enqueue(self.deployment(), self.promotion_project("pending"))
        with patch.object(vercel.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(ValueError, "VERCEL_PROMOTION_OBSERVATION_TIMED_OUT"):
                vercel.promote_frontend(self.client, self.release, self.attempt, self.verified, timeout=1)
        outcome = json.loads((self.attempt / "frontend-promotion-outcome.json").read_text())
        self.assertIsNone(outcome["frontendDomainsPromoted"])
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)
        self.enqueue(self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture"))
        observed = vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertTrue(observed["frontendDomainsPromoted"])
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)

    def test_empty_response_exception_is_limited_to_documented_promotion_acknowledgements(self):
        promotion = f"/v10/projects/{vercel.PROJECTS['staging']}/promote/dpl_fixture"
        cases = [
            ("GET", promotion, 201, b""),
            ("PATCH", promotion, 201, b""),
            ("POST", "/v13/deployments", 201, b""),
            ("POST", "/v10/projects/prj_unreviewed/promote/dpl_fixture", 201, b""),
            ("POST", promotion, 200, b""),
            ("POST", promotion, 204, b""),
            ("POST", promotion, 201, b"provider-secret-must-not-escape"),
            ("POST", promotion, 202, []),
        ]
        for method, path, status, body in cases:
            with self.subTest(method=method, path=path, status=status, body=body):
                self.responses.append((status, body, {}))
                with self.assertRaisesRegex(ValueError, "^VERCEL_REQUEST_FAILED_REQUIRES_REVIEW$"):
                    self.client.request(method, path, {} if method != "GET" else None)

    def test_missing_or_wrong_live_verification_never_promotes(self):
        with self.assertRaisesRegex(ValueError, "FRONTEND_LIVE_VERIFICATION_REQUIRED"):
            vercel.promote_frontend(self.client, self.release, self.attempt, None)
        self.assertEqual(self.calls, [])
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment())
        with self.assertRaisesRegex(ValueError, "FRONTEND_LIVE_VERIFICATION_REQUIRED"):
            vercel.promote_frontend(self.client, self.release, self.attempt, lambda *_: {"status": "FRONTEND_VERIFIED"})
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))
        self.assertFalse((self.attempt / "frontend-promotion-started.json").exists())

    def test_changed_project_or_active_alias_job_refuses_before_promotion(self):
        self.staged()
        for value, code in ((self.promotion_project(deployment="dpl_unrelated"), "VERCEL_PROJECT_CHANGED_BEFORE_PROMOTION"),
                            (self.promotion_project("pending"), "VERCEL_ALIAS_JOB_ALREADY_ACTIVE")):
            with self.subTest(code=code):
                self.enqueue(value)
                with self.assertRaisesRegex(ValueError, code):
                    vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project(deployment="dpl_unrelated"))
        with self.assertRaisesRegex(ValueError, "VERCEL_PROJECT_CHANGED_BEFORE_PROMOTION"):
            vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))

    def test_live_verification_failure_is_sanitized_before_promotion(self):
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment())

        def fail(*_):
            raise RuntimeError("fixture-private-token provider-secret-must-not-escape")

        with self.assertRaisesRegex(ValueError, "^FRONTEND_LIVE_VERIFICATION_FAILED$"):
            vercel.promote_frontend(self.client, self.release, self.attempt, fail)
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))
        self.assertFalse((self.attempt / "frontend-promotion-started.json").exists())

    def test_rolling_release_is_not_silently_accepted_as_full_promotion(self):
        self.staged()
        value = self.promotion_project()
        value["rollingRelease"] = {"enabled": True}
        self.enqueue(value)
        with self.assertRaisesRegex(ValueError, "VERCEL_ROLLING_RELEASE_REQUIRES_REVIEW"):
            vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))

    def test_wrong_or_unready_deployment_refuses_promotion(self):
        self.staged()
        for value, code in ((self.deployment("BUILDING"), "VERCEL_PROMOTION_DEPLOYMENT_NOT_READY"),
                            ({**self.deployment(), "target": "preview"}, "VERCEL_DEPLOYMENT_BINDING_REFUSED")):
            with self.subTest(code=code):
                self.enqueue(self.promotion_project(), value)
                with self.assertRaisesRegex(ValueError, code):
                    vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))

    def test_ambiguous_promotion_is_not_retried_and_can_be_observed_read_only(self):
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project())
        self.responses.append((503, {"error": "fixture-private-token provider-secret-must-not-escape"}, {}))
        with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"):
            vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        failed = json.loads((self.attempt / "frontend-promotion-outcome.json").read_text())
        self.assertIsNone(failed["frontendDomainsPromoted"])
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project())
        with self.assertRaises(FileExistsError):
            vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.enqueue(self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture"))
        result = vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertEqual(result["status"], "FRONTEND_DOMAINS_PROMOTED")
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)
        self.assertEqual(json.loads((self.attempt / "frontend-promotion-outcome.json").read_text()), failed)

    def test_queued_promotion_timeout_retains_handle_and_continues_without_post(self):
        self.staged()
        self.enqueue(self.promotion_project("succeeded", requested=100, to="dpl_previous"), self.deployment(),
                     self.promotion_project("succeeded", requested=100, to="dpl_previous"))
        self.responses.append((202, {}, {}))
        # An old successful alias job, even with the target updated, is not
        # evidence that the new promotion completed.
        self.enqueue(self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture", requested=100))
        with patch.object(vercel.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(ValueError, "VERCEL_PROMOTION_OBSERVATION_TIMED_OUT"):
                vercel.promote_frontend(self.client, self.release, self.attempt, self.verified, timeout=1)
        self.enqueue(self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture", requested=456))
        result = vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertEqual(result["deploymentId"], "dpl_fixture")
        self.assertEqual(sum(c["method"] == "POST" for c in self.calls), 1)
        observations = sorted(self.attempt.glob("frontend-promotion-observation-*.json"))
        self.assertEqual(len(observations), 2)
        self.assertEqual(json.loads(observations[0].read_text())["failureCode"], "VERCEL_PROMOTION_OBSERVATION_TIMED_OUT")

    def test_failed_alias_mapping_never_rolls_back_or_resumes_producers(self):
        self.staged()
        self.enqueue(self.promotion_project(), self.deployment(), self.promotion_project(), {},
                     self.deployment(), self.promotion_project("failed"))
        with self.assertRaisesRegex(ValueError, "VERCEL_PROMOTION_FAILED_REQUIRES_REVIEW"):
            vercel.promote_frontend(self.client, self.release, self.attempt, self.verified)
        self.enqueue(self.deployment(), self.promotion_project("skipped"))
        with self.assertRaisesRegex(ValueError, "VERCEL_PROMOTION_FAILED_REQUIRES_REVIEW"):
            vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertEqual(sum(c["method"] != "GET" for c in self.calls), 1)
        self.assertTrue(all("rollback" not in c["path"].split("?", 1)[0] and "/crons" not in c["path"] for c in self.calls))

    def test_unrelated_alias_job_and_reenabled_schedules_stop_observation(self):
        self.staged()
        intent = {key: value for key, value in self.staged_value().items()}
        vercel.migrate.write_json(self.attempt, "frontend-promotion-started.json", {**intent, "previousAliasRequestedAt": 0})
        unrelated = self.promotion_project("succeeded", to="dpl_unrelated")
        enabled = self.promotion_project("succeeded", deployment="dpl_fixture")
        enabled["crons"]["disabledAt"] = None
        for value, code in ((unrelated, "VERCEL_UNRELATED_ALIAS_JOB"), (enabled, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")):
            with self.subTest(code=code):
                self.enqueue(self.deployment(), value)
                with self.assertRaisesRegex(ValueError, code):
                    vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))

    def staged_value(self):
        return {key: value for key, value in json.loads((self.attempt / "frontend-build-outcome.json").read_text()).items()
                if key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId", "previousDeploymentId")}

    def test_observation_refuses_substituted_intent_without_network(self):
        self.staged()
        intent = {**self.staged_value(), "deploymentId": "dpl_unrelated", "previousAliasRequestedAt": 0}
        vercel.migrate.write_json(self.attempt, "frontend-promotion-started.json", intent)
        with self.assertRaisesRegex(ValueError, "VERCEL_PROMOTION_INTENT_REFUSED"):
            vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertEqual(self.calls, [])

    def test_read_only_observation_does_not_copy_unselected_intent_fields(self):
        self.staged()
        intent = {**self.staged_value(), "previousAliasRequestedAt": 0, "private": "provider-secret-must-not-escape"}
        vercel.migrate.write_json(self.attempt, "frontend-promotion-started.json", intent)
        self.enqueue(self.deployment(), self.promotion_project("succeeded", deployment="dpl_fixture"))
        result = vercel.observe_frontend_promotion(self.client, self.release, self.attempt)
        self.assertNotIn("private", result)
        self.assertNotIn("provider-secret-must-not-escape", (self.attempt / "frontend-promotion-observation-0.json").read_text())
        self.assertTrue(all(c["method"] == "GET" for c in self.calls))


if __name__ == "__main__":
    unittest.main()
