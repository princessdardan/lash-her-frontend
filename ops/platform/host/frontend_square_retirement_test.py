from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import threading
import unittest
from unittest.mock import patch

import frontend_square_retirement as square
import frontend_release_adapters_test as adapter_tests
import migrate
import vercel_test


class SquareRetirementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): vercel_test.VercelControlTests.setUpClass()
    @classmethod
    def tearDownClass(cls): vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.denied, self.forbidden, self.enabled, self.wrong_location, self.mismatch, self.pending, self.fail_disable = False, False, True, False, False, False, False
        self.calls = []
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw) if raw else None
                owner.calls.append({"method": self.command, "path": self.path, "body": body})
                owner.assertEqual(self.headers.get("Square-Version"), square.API_VERSION)
                if self.headers.get("Authorization") == "Bearer owned-square-old" and owner.denied:
                    self.send_response(403 if owner.forbidden else 401); self.end_headers()
                    self.wfile.write(json.dumps({"errors": [{"category": "AUTHENTICATION_ERROR", "code": "UNAUTHORIZED", "detail": "provider-private-marker"}]}).encode()); return
                if self.path.startswith("/v2/locations/"):
                    value = {"location": {"id": "production-location" if owner.wrong_location else square.LOCATION, "merchant_id": "ownedMerchant", "currency": "CAD", "country": "CA", "status": "ACTIVE", "name": "private-business-name"}}
                elif self.path.startswith("/v2/webhooks/subscriptions/"):
                    if self.command == "PUT" and not owner.fail_disable:
                        owner.assertEqual(body, {"subscription": {"enabled": False}}); owner.enabled = False
                    value = {"subscription": {"id": square.WEBHOOK, "enabled": owner.enabled, "api_version": square.API_VERSION,
                        "notification_url": "https://staging.lashher.com/api/webhooks/square?x-vercel-protection-bypass=private-url-marker", "event_types": ["payment.updated"], "signature_key": "private-hook-marker"}}
                elif self.path == "/v2/payments/owned-payment":
                    value = {"payment": {"id": "owned-payment", "status": "APPROVED" if owner.pending else "COMPLETED", "location_id": square.LOCATION,
                        "amount_money": {"amount": 999 if owner.mismatch else 100, "currency": "CAD"}, "reference_id": "owned-public-ref", "order_id": "owned-order",
                        "application_details": {"application_id": "sandbox-sq0idb-owned"}, "buyer_email_address": "private-buyer-marker"}}
                elif self.path == "/v2/refunds/owned-refund":
                    value = {"refund": {"id": "owned-refund", "status": "COMPLETED", "location_id": square.LOCATION, "payment_id": "owned-payment",
                        "amount_money": {"amount": 100, "currency": "CAD"}, "reason": "private-refund-reason"}}
                else:
                    self.send_response(500); self.end_headers(); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(value).encode())
            do_PUT = do_GET
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.origin_patch = patch.object(square, "ORIGIN", f"https://127.0.0.1:{self.server.server_port}"); self.origin_patch.start()
        tls_client = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        self.tls_patch = patch.object(square.ssl, "create_default_context", return_value=tls_client); self.tls_patch.start()
        self.client, self.old = square.Client("owned-square-new"), square.Client("owned-square-old")
        self.fixture = adapter_tests.ConcreteFrontendAdapterTests(methodName="runTest"); self.fixture.setUp(); self.fixture.bootstrap_context()
        self.rows = [{"recordKind": "booking-payment-attempt", "recordId": "11111111-1111-4111-8111-111111111111", "databaseRowSha256": "a" * 64,
            "idempotencySha256": "b" * 64, "providerId": "owned-payment", "providerKind": "payment", "databaseStatus": "captured", "amountCents": 100,
            "referenceId": "owned-public-ref", "providerOrderId": "owned-order"},
            {"recordKind": "product-refund", "recordId": "22222222-2222-4222-8222-222222222222", "databaseRowSha256": "c" * 64,
            "idempotencySha256": "d" * 64, "providerId": "owned-refund", "providerKind": "refund", "databaseStatus": "succeeded", "amountCents": 100, "originalPaymentId": "owned-payment"}]
        self.plan = {"environment": "sandbox", "credentialKind": "personal-access-token", "locationId": square.LOCATION, "merchantId": "ownedMerchant",
            "applicationId": "sandbox-sq0idb-owned", "apiVersion": square.API_VERSION, "webhookIds": [square.WEBHOOK],
            "effects": [{key: row[key] for key in ("recordKind", "recordId", "databaseRowSha256")} for row in self.rows]}
        self.fixture.context["bindings"]["squareRetirement"] = self.plan
        self.fixture.context.update(squareReplacementToken="owned-square-new", squareRetiredToken="owned-square-old", squareEffects=self.rows)

    def tearDown(self):
        self.fixture.tearDown(); self.tls_patch.stop(); self.origin_patch.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def test_actual_sandbox_disable_dashboard_denial_runtime_and_exact_effect_readback(self):
        self.fixture.execute("deploy-admission")
        before = self.fixture.execute("suspend-square")
        self.assertFalse(before["enabled"]); self.assertEqual(self.fixture.variables["SQUARE_ENVIRONMENT"]["value"], "sandbox")
        self.denied = True  # owned provider's existing dashboard action fixture
        result = self.fixture.execute("verify-square")
        self.assertTrue(result["retiredCredentialDenied"]); self.assertTrue(result["runtimeReplacementBindingVerified"])
        self.assertEqual(result["knownUnresolvedEffects"], 0); self.assertIsNone(result["uncertainEffects"])
        self.assertFalse(result["historicalWritersFenced"])
        self.assertEqual([row["method"] for row in self.calls if row["method"] != "GET"], ["PUT"])
        common = "".join(p.read_text() for p in self.fixture.parent.rglob("*.json"))
        for marker in ("owned-square-new", "owned-square-old", "private-url-marker", "private-hook-marker", "private-buyer-marker", "private-refund-reason", "private-business-name"):
            self.assertNotIn(marker, common)
        original = {str(p): p.read_bytes() for p in self.fixture.parent.rglob("*.json")}
        target = self.fixture.parent.parent / "recovery"; target.mkdir(mode=0o700)
        self.fixture.context.update(originalDirectory=str(self.fixture.parent), directory=str(target))
        observed = self.fixture.execute("observe-square"); self.assertTrue(observed["retiredCredentialDenied"])
        for name, raw in original.items(): self.assertEqual(Path(name).read_bytes(), raw)

    def test_not_retired_or403_or_wrong_scope_never_qualifies(self):
        self.fixture.execute("deploy-admission"); self.fixture.execute("suspend-square")
        with self.assertRaises((ValueError, OSError)): self.fixture.execute("verify-square")
        self.denied = True; self.forbidden = True
        with self.assertRaises(ValueError): square.observe(self.client, self.old, self.plan, self.rows)
        self.forbidden = False; self.wrong_location = True
        with self.assertRaisesRegex(ValueError, "SQUARE_SANDBOX_LOCATION_REFUSED"): square.observe(self.client, self.old, self.plan, self.rows)

    def test_missing_id_mismatch_pending_and_unsettled_database_are_not_reconciled(self):
        self.rows[0]["providerId"] = None
        result = square.effects(self.client, self.plan, self.rows); self.assertFalse(result[0]["storedOutcomeConsistent"])
        self.assertFalse(any(row["path"] == "/v2/payments/owned-payment" for row in self.calls))
        self.rows[0]["providerId"] = "owned-payment"; self.mismatch = True
        self.assertEqual(square.effects(self.client, self.plan, self.rows)[0]["unresolvedReason"], "immutable-effect-mismatch")
        self.mismatch = False; self.pending = True
        self.assertFalse(square.effects(self.client, self.plan, self.rows)[0]["storedOutcomeConsistent"])
        self.pending = False; self.rows[0]["databaseStatus"] = "pending"
        self.assertFalse(square.effects(self.client, self.plan, self.rows)[0]["storedOutcomeConsistent"])

    def test_missing_preretirement_or_wrong_runtime_epoch_refuses(self):
        self.fixture.execute("deploy-admission"); self.denied = True
        with self.assertRaises((ValueError, OSError)): self.fixture.execute("verify-square")
        self.assertFalse((self.fixture.parent / "vercel" / "square-runtime-binding-verified.json").exists())
        self.fixture.context["admissionObservation"]["epoch"] = "2"
        with self.assertRaisesRegex(ValueError, "SQUARE_RUNTIME_REPLACEMENT_BINDING_UNVERIFIED"): self.fixture.execute("verify-square")

    def test_callback_lost_or_ignored_write_never_synthesizes_verified_retirement(self):
        self.fixture.execute("deploy-admission"); self.fail_disable = True
        with self.assertRaisesRegex(ValueError, "SQUARE_CALLBACK_DISABLE_READBACK_UNVERIFIED"): self.fixture.execute("suspend-square")
        self.assertFalse((self.fixture.parent / "vercel" / "square-callback-suspension-verified.json").exists())
        mutations = len(self.calls)
        with self.assertRaises((ValueError, OSError)): self.fixture.execute("suspend-square")
        self.assertLess(len(self.calls) - mutations, 20)  # existing intent refuses before PUT replay
        self.assertEqual(len([row for row in self.calls if row["method"] == "PUT"]), 1)

    def test_transport_forbids_production_revoke_introspection_charge_refund_enable_and_other_hooks(self):
        for method, path, body in [("POST", "/oauth2/revoke", {}), ("POST", "/oauth2/token/status", None), ("POST", "/v2/payments", {}),
            ("POST", "/v2/refunds", {}), ("PUT", "/v2/webhooks/subscriptions/" + square.WEBHOOK, {"subscription": {"enabled": True}}),
            ("GET", "/v2/locations/production", None), ("GET", "/v2/webhooks/subscriptions/wbhk_7059795d5bdc460fb9333430fa70c0ec", None),
            ("GET", "/v2/payments/../locations/production", None)]:
            with self.assertRaisesRegex(ValueError, "SQUARE_SANDBOX_REQUEST_SCOPE_REFUSED"): self.client.request(method, path, body)
        self.assertFalse(self.calls)

if __name__ == "__main__": unittest.main()
