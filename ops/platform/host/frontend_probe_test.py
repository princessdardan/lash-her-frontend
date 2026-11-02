from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import ssl
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import frontend_probe
import migrate
import vercel_test
import vercel


class FrontendProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.fixture = vercel_test.VercelControlTests(methodName="runTest")
        self.fixture.setUp()
        self.client, self.release = self.fixture.client, self.fixture.release
        self.private_root = tempfile.TemporaryDirectory()
        self.private = Path(self.private_root.name)
        self.probes, self.probe_status, self.probe_body = [], 200, None
        self.probe_headers = {"Content-Type": "application/json", "Cache-Control": "no-store"}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.probes.append({"path": self.path, "headers": dict(self.headers)})
                challenge = self.headers.get("x-lash-release-challenge")
                body = {"version": 1, "status": "FRONTEND_WORKLOAD_PROBE_PASS", "challenge": challenge,
                        "environment": "staging", "projectId": owner.release["workload"]["projectId"],
                        "sourceCommit": "a" * 40, "gatewayOrigin": "https://gateway.example.invalid",
                        "checks": ["gateway-course-catalog"], "durationMs": 2}
                if isinstance(owner.probe_body, dict):
                    body.update(owner.probe_body)
                elif owner.probe_body is not None:
                    body = owner.probe_body
                self.send_response(owner.probe_status)
                for name, value in owner.probe_headers.items():
                    self.send_header(name, value)
                self.end_headers()
                try:
                    self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())
                except (BrokenPipeError, ssl.SSLError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.fixture.cert, self.fixture.key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"https://127.0.0.1:{self.server.server_port}"
        context = ssl.create_default_context(cafile=str(self.fixture.cert))
        with patch.object(frontend_probe.ssl, "create_default_context", return_value=context):
            self.http = frontend_probe.ProbeClient()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.private_root.cleanup()
        self.fixture.tearDown()

    def project(self, **kwargs):
        value = self.fixture.project(**kwargs)
        value["protectionBypass"] = {"fixture-protection-bypass": {"scope": "automation-bypass"}}
        return value

    def attempt(self, name="probe"):
        path = self.fixture.attempt / name
        path.mkdir(mode=0o700)
        migrate.write_json(path, "frontend-build-outcome.json", {"status": "FRONTEND_STAGED", "readyState": "READY", "environment": "staging",
            "projectId": self.release["workload"]["projectId"], "sourceCommit": "a" * 40, "releaseId": self.release["releaseId"],
            "deploymentId": "dpl_fixture", "previousDeploymentId": "dpl_previous", "trafficAuthorized": False, "promotionAuthorized": False})
        return path

    def credential(self, directory=None, **overrides):
        directory = directory or self.private
        value = {"environment": "staging", "projectId": self.release["workload"]["projectId"], "sourceCommit": "a" * 40,
                 "releaseId": self.release["releaseId"], "secret": "b" * 64,
                 "expiresAt": int(frontend_probe.time.time() * 1000) + 60_000, "gatewayOrigin": "https://gateway.example.invalid", **overrides}
        migrate.write_json(directory, frontend_probe.PRIVATE_FILE, value)
        return value

    def mapped_http(self):
        owner = self
        class Mapped:
            def request(self, url, secret, bypass, challenge):
                owner.assertEqual(url, "https://owned-fixture.vercel.app")
                # Test-only mapping to owned TLS. Production has no URL/CA flag.
                with patch.object(frontend_probe, "DEPLOYMENT_URL", re.compile(re.escape(owner.origin))):
                    return owner.http.request(owner.origin, secret, bypass, challenge)
        return Mapped()

    def prepared_responses(self):
        self.fixture.enqueue(self.project())
        for key, kind in (("LASH_RELEASE_PROBE_SECRET", "sensitive"), ("LASH_RELEASE_PROBE_EXPIRES_AT", "plain"),
                          ("LASH_RELEASE_SCHEDULER_QUALIFICATION", "plain"), ("API_GATEWAY_STAGING_ORIGIN", "plain")):
            self.fixture.enqueue({"created": {"key": key, "type": kind, "target": ["production"]}, "failed": []})
        self.fixture.enqueue(self.project())

    def test_preparation_uses_existing_project_scopes_secret_and_keeps_private_value_out_of_receipts(self):
        self.prepared_responses()
        attempt = self.attempt()
        request = self.client.request
        def check(method, path, body=None):
            if method == "POST":
                self.assertTrue((self.private / frontend_probe.PRIVATE_FILE).exists())
                self.assertTrue((attempt / "frontend-probe-started.json").exists())
            return request(method, path, body)
        with patch.object(self.client, "request", side_effect=check):
            result = frontend_probe.prepare(self.client, self.release, self.private, attempt, "gateway.example.invalid")
        self.assertEqual(result["status"], "FRONTEND_PROBE_CONFIGURED")
        private = json.loads((self.private / frontend_probe.PRIVATE_FILE).read_text())
        self.assertRegex(private["secret"], r"^[a-f0-9]{64}$")
        self.assertEqual((self.private / frontend_probe.PRIVATE_FILE).stat().st_mode & 0o777, 0o600)
        posts = [call for call in self.fixture.calls if call["method"] == "POST"]
        self.assertEqual(len(posts), 4)
        self.assertEqual(posts[0]["body"]["type"], "sensitive")
        self.assertEqual(posts[2]["body"]["value"], "false")
        self.assertTrue(all(call["body"]["target"] == ["production"] for call in posts))
        self.assertTrue(all("CRON_SECRET" not in call["body"]["key"] for call in posts))
        records = "".join(path.read_text() for path in attempt.iterdir())
        for secret in (private["secret"], "fixture-private-token", "fixture-protection-bypass", "provider-secret-must-not-escape"):
            self.assertNotIn(secret, records)

    def test_staging_qualification_is_explicit_and_production_cannot_select_it(self):
        self.prepared_responses()
        frontend_probe.prepare(self.client, self.release, self.private, self.attempt(), "gateway.example.invalid", scheduler_qualification=True)
        posts = [call for call in self.fixture.calls if call["method"] == "POST"]
        self.assertEqual(posts[2]["body"]["key"], "LASH_RELEASE_SCHEDULER_QUALIFICATION")
        self.assertEqual(posts[2]["body"]["value"], "true")
        self.fixture.calls.clear()
        self.release["environment"] = "production"
        self.release["workload"]["projectId"] = vercel.PROJECTS["production"]
        with self.assertRaisesRegex(ValueError, "SCHEDULER_QUALIFICATION_REQUIRES_STAGING"):
            frontend_probe.prepare(self.client, self.release, self.private, self.fixture.attempt, "gateway.example.invalid", scheduler_qualification=True)
        self.assertEqual(self.fixture.calls, [])

    def test_invalid_gateway_or_cross_environment_refuses_before_network_or_private_input(self):
        for host in ("https://gateway.example.invalid", "gateway.example.invalid/path", "localhost"):
            with self.assertRaises(ValueError):
                frontend_probe.prepare(self.client, self.release, self.private, self.fixture.attempt, host)
        self.release["environment"] = "production"
        with self.assertRaises(ValueError):
            frontend_probe.prepare(self.client, self.release, self.private, self.fixture.attempt, "gateway.example.invalid")
        self.assertEqual(self.fixture.calls, [])
        self.assertEqual(list(self.private.iterdir()), [])

    def test_enabled_crons_refuse_preparation_before_private_or_provider_changes(self):
        self.fixture.enqueue(self.project(enabled=True))
        with self.assertRaisesRegex(ValueError, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED"):
            frontend_probe.prepare(self.client, self.release, self.private, self.attempt(), "gateway.example.invalid")
        self.assertEqual(list(self.private.iterdir()), [])
        self.assertFalse(any(call["method"] == "POST" for call in self.fixture.calls))

    def test_failed_environment_entry_is_not_retried_and_private_input_is_retained(self):
        self.fixture.enqueue(self.project(), {"created": {"key": "wrong"}, "failed": [{"error": "private-provider-credential"}]})
        attempt = self.attempt()
        with self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_PREPARATION_FAILED_REVIEW_REQUIRED"):
            frontend_probe.prepare(self.client, self.release, self.private, attempt, "gateway.example.invalid")
        self.assertEqual(len([call for call in self.fixture.calls if call["method"] == "POST"]), 1)
        self.assertTrue((self.private / frontend_probe.PRIVATE_FILE).exists())
        body = (attempt / "frontend-probe-preparation.json").read_text()
        self.assertNotIn("private-provider-credential", body)
        self.assertIn("REQUIRES_REVIEW", body)

    def test_preparation_detects_production_target_drift_without_promotion(self):
        self.prepared_responses()
        self.fixture.responses[-1] = (200, self.project(deployment="dpl_unrelated"), {})
        with self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_PREPARATION_FAILED_REVIEW_REQUIRED"):
            frontend_probe.prepare(self.client, self.release, self.private, self.attempt(), "gateway.example.invalid")
        self.assertFalse(any("/promote/" in call["path"] for call in self.fixture.calls))

    def test_production_preparation_selects_only_the_production_project_and_origin_binding(self):
        self.release["environment"] = "production"
        self.release["workload"]["projectId"] = vercel.PROJECTS["production"]
        project = {**self.project(), "id": vercel.PROJECTS["production"]}
        self.fixture.enqueue(project)
        for key, kind in (("LASH_RELEASE_PROBE_SECRET", "sensitive"), ("LASH_RELEASE_PROBE_EXPIRES_AT", "plain"),
                          ("LASH_RELEASE_SCHEDULER_QUALIFICATION", "plain"), ("API_GATEWAY_PRODUCTION_ORIGIN", "plain")):
            self.fixture.enqueue({"created": {"key": key, "type": kind, "target": ["production"]}, "failed": []})
        self.fixture.enqueue(project)
        result = frontend_probe.prepare(self.client, self.release, self.private, self.fixture.attempt, "gateway.example.invalid")
        self.assertEqual(result["environment"], "production")
        self.assertTrue(all(vercel.PROJECTS["production"] in call["path"] for call in self.fixture.calls))
        self.assertTrue(all("STAGING" not in call["body"]["key"] for call in self.fixture.calls if call["method"] == "POST"))

    def test_real_https_probe_checks_pinned_deployment_and_does_not_forward_provider_api_credentials(self):
        self.credential(); attempt = self.attempt()
        self.fixture.enqueue(self.fixture.deployment(), self.project())
        result = frontend_probe.verify(self.client, self.release, attempt, self.private, self.mapped_http())
        self.assertEqual(result["status"], "FRONTEND_VERIFIED")
        self.assertFalse(result["trafficAuthorized"])
        self.assertFalse(result["nativeSchedulerVerified"])
        self.assertEqual(len(self.probes), 1)
        request = self.probes[0]
        self.assertEqual(request["path"], "/api/internal/release-probe")
        headers = {key.lower(): value for key, value in request["headers"].items()}
        self.assertEqual(headers["authorization"], "Bearer " + "b" * 64)
        self.assertEqual(headers["x-vercel-protection-bypass"], "fixture-protection-bypass")
        self.assertNotIn("fixture-private-token", str(headers))
        retained = (attempt / "frontend-workload-outcome.json").read_text()
        for secret in ("b" * 64, "fixture-protection-bypass", "fixture-private-token", headers["x-lash-release-challenge"]):
            self.assertNotIn(secret, retained)

    def test_substituted_source_or_unready_deployment_refuses_before_probe(self):
        self.credential()
        for index, change in enumerate(({"readyState": "BUILDING"}, {"gitSource": {"type": "github", "repoId": "wrong", "sha": "a" * 40}})):
            self.fixture.enqueue({**self.fixture.deployment(), **change})
            with self.assertRaisesRegex(ValueError, "FRONTEND_WORKLOAD_VERIFICATION_FAILED"):
                frontend_probe.verify(self.client, self.release, self.attempt(str(index)), self.private, self.mapped_http())
        self.assertEqual(self.probes, [])

    def test_expired_wrong_binding_or_public_private_file_refuses_before_probe(self):
        for index, (change, mode) in enumerate((({"expiresAt": 1}, 0o600), ({"sourceCommit": "d" * 40}, 0o600), ({"gatewayOrigin": None}, 0o600), ({}, 0o644))):
            private = self.private / str(index); private.mkdir(mode=0o700)
            self.credential(private, **change); (private / frontend_probe.PRIVATE_FILE).chmod(mode)
            self.fixture.enqueue(self.fixture.deployment())
            with self.assertRaisesRegex(ValueError, "FRONTEND_WORKLOAD_VERIFICATION_FAILED"):
                frontend_probe.verify(self.client, self.release, self.attempt(str(index)), private, self.mapped_http())
        self.assertEqual(self.probes, [])

    def test_changed_project_crons_or_missing_protection_access_refuses_probe(self):
        self.credential()
        missing = self.project(); missing["protectionBypass"] = {}
        for index, project in enumerate((self.project(enabled=True), self.project(deployment="dpl_unrelated"), missing)):
            self.fixture.enqueue(self.fixture.deployment(), project)
            with self.assertRaisesRegex(ValueError, "FRONTEND_WORKLOAD_VERIFICATION_FAILED"):
                frontend_probe.verify(self.client, self.release, self.attempt(str(index)), self.private, self.mapped_http())
        self.assertEqual(self.probes, [])

    def test_stale_or_substituted_http_success_cannot_qualify_frontend(self):
        self.credential()
        for index, changed in enumerate(({"challenge": "stale"}, {"projectId": "prj_wrong"}, {"sourceCommit": "d" * 40},
                                         {"environment": "production"}, {"gatewayOrigin": "https://other-gateway.example.invalid"},
                                         {"checks": []}, {"status": "wrong"}, {"version": True})):
            self.probe_body = changed
            self.fixture.enqueue(self.fixture.deployment(), self.project())
            with self.assertRaisesRegex(ValueError, "FRONTEND_WORKLOAD_VERIFICATION_FAILED"):
                frontend_probe.verify(self.client, self.release, self.attempt(str(index)), self.private, self.mapped_http())

    def test_probe_expiring_during_the_request_cannot_qualify_frontend(self):
        private = self.credential(); attempt = self.attempt()
        clock = SimpleNamespace(value=(private["expiresAt"] - 30_000) / 1000)
        mapped = self.mapped_http()
        class Expiring:
            def request(self, *args):
                value = mapped.request(*args)
                clock.value = private["expiresAt"] / 1000
                return value
        self.fixture.enqueue(self.fixture.deployment(), self.project())
        with patch.object(frontend_probe, "time", SimpleNamespace(time=lambda: clock.value)), self.assertRaisesRegex(ValueError, "FRONTEND_WORKLOAD_VERIFICATION_FAILED"):
            frontend_probe.verify(self.client, self.release, attempt, self.private, Expiring())
        self.assertEqual(len(self.probes), 1)

    def test_real_https_client_refuses_redirect_error_html_cacheable_and_oversized_responses(self):
        cases = [(302, {}, {"Location": "https://attacker.example.invalid"}), (503, b"private-provider-error", {}),
                 (200, b"<html>login</html>", {"Content-Type": "text/html"}), (200, {}, {"Cache-Control": "public"}),
                 (200, b"x" * 65_537, {}), (200, b"invalid-json", {})]
        for status, body, headers in cases:
            self.probe_status, self.probe_body = status, body
            self.probe_headers = {"Content-Type": "application/json", "Cache-Control": "no-store", **headers}
            with patch.object(frontend_probe, "DEPLOYMENT_URL", re.compile(re.escape(self.origin))), self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_REQUEST_FAILED"):
                self.http.request(self.origin, "b" * 64, "fixture-protection-bypass", "c" * 64)
        self.assertEqual(len(self.probes), len(cases))

    def test_real_tls_client_refuses_untrusted_certificate_and_non_deployment_origins(self):
        untrusted = frontend_probe.ProbeClient()
        with patch.object(frontend_probe, "DEPLOYMENT_URL", re.compile(re.escape(self.origin))), self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_REQUEST_FAILED"):
            untrusted.request(self.origin, "b" * 64, "fixture-protection-bypass", "c" * 64)
        for url in ("http://owned-fixture.vercel.app", "https://attacker.example.invalid", "https://owned-fixture.vercel.app/path", "https://user@owned-fixture.vercel.app"):
            with self.assertRaisesRegex(ValueError, "FRONTEND_PROBE_ORIGIN_REFUSED"):
                self.http.request(url, "b" * 64, "fixture-protection-bypass", "c" * 64)
        self.assertEqual(self.probes, [])
