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
        self.assertEqual(writes[0]["body"]["gitSource"]["ref"], "a" * 40)
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


if __name__ == "__main__":
    unittest.main()
