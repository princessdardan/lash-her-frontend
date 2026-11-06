from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ssl
import threading
import unittest
from unittest.mock import patch

import frontend_release_adapters
import frontend_scoped_provider_client as client
import vercel_test


class ScopedProviderClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.calls, self.status, self.raw = [], 200, None
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.calls.append((self.command, self.path, body, self.headers.get("Square-Version")))
                owner.assertEqual(self.headers.get("Authorization"), "Bearer owned-private-token")
                self.send_response(owner.status)
                self.end_headers()
                raw = owner.raw if owner.raw is not None else json.dumps({"status": "owned", "privateBody": "private-provider-marker"}).encode()
                self.wfile.write(raw)

            do_POST = do_GET
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "https://127.0.0.1:" + str(self.server.server_port)
        self.tls = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def make(self, provider="square", classifier=None):
        reviewed = {"environment": "sandbox" if provider == "square" else "staging", "apiVersion": "2026-05-20", "locationId": "ownedLocation"}
        classifier = classifier or (lambda method, path, body, scope: path == "/owned-read" or method == "POST" and path == "/v2/orders/search" and body == {"location_ids": ["ownedLocation"]})
        with patch.dict(client.ORIGINS, {provider: self.origin}), patch.object(client.ssl, "create_default_context", return_value=self.tls):
            return client.Client(provider, "owned-private-token", reviewed, classifier)

    def test_verified_tls_read_and_exact_readonly_search_use_the_source_classifier(self):
        scoped = self.make()
        # ORIGINS is source-fixed in production; this patch selects only an
        # owned fixture after verified TLS construction, never a JSON override.
        with patch.dict(client.ORIGINS, {"square": self.origin}):
            self.assertEqual(scoped.request("GET", "/owned-read")["status"], "owned")
            self.assertEqual(scoped.request("POST", "/v2/orders/search", {"location_ids": ["ownedLocation"]})["status"], "owned")
        self.assertEqual(self.calls[0][3], "2026-05-20")
        self.assertEqual(len(self.calls), 2)

    def test_even_a_permissive_classifier_cannot_enable_financial_mutations_or_cross_origin_requests(self):
        scoped = self.make(classifier=lambda *_args: True)
        for method, path, body in [("DELETE", "/v2/payments/owned", None), ("POST", "/v2/payments", {}),
            ("GET", "//production.invalid/owned", None), ("GET", "/owned-read#private", None),
            ("GET", "/x/%2e%2e/y", None), ("GET", "/owned-read", {})]:
            with self.assertRaises(client.ScopedProviderReadError):
                scoped.request(method, path, body)
        self.assertEqual(self.calls, [])

    def test_401_and_permission_rate_limit_malformed_or_oversized_bodies_remain_distinct_sanitized_unknowns(self):
        scoped = self.make()
        with patch.dict(client.ORIGINS, {"square": self.origin}):
            for status in (401, 403, 429, 500):
                self.status, self.raw = status, b"private-provider-error-owned-private-token"
                with self.assertRaises(client.ScopedProviderReadError) as caught:
                    scoped.request("GET", "/owned-read")
                self.assertEqual(caught.exception.http_status, status)
                self.assertNotIn("private", str(caught.exception))
                self.assertEqual(isinstance(caught.exception, client.AuthenticationDenied), status == 401)
            self.status = 200
            for raw in (b"private-not-json", b"x" * 2_000_001, b"true"):
                self.raw = raw
                with self.assertRaises(client.ScopedProviderReadError) as caught:
                    scoped.request("GET", "/owned-read")
                self.assertNotIn("private", str(caught.exception))

    def test_expected_denial_still_checkpoints_parent_after_the_actual_response(self):
        self.status = 401
        checkpoints = []
        def verify():
            checkpoints.append(True)
            if len(checkpoints) == 2:
                raise ValueError("OWNED_PARENT_LOST")
        with patch.dict(client.ORIGINS, {"square": self.origin}), self.assertRaisesRegex(ValueError, "OWNED_PARENT_LOST"):
            frontend_release_adapters.LockedClient(self.make(), verify).request("GET", "/owned-read")
        self.assertEqual(len(checkpoints), 2)


if __name__ == "__main__":
    unittest.main()
