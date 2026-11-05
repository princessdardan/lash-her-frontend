from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ssl
import threading
import unittest
from unittest.mock import patch

import frontend_sanity_fencing as sanity
import migrate
import vercel_test


class SanityFencingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.disabled, self.denied, self.forbidden, self.ignore_disable = False, False, False, False
        self.production, self.extra_hook, self.queued, self.active = False, False, False, False
        self.message_status, self.prior_success = "success", False
        self.repeated, self.changed, self.calls = False, False, []
        self.count = 1
        self.reviewed = {"projectId": sanity.PROJECT, "dataset": sanity.DATASET,
            "hooks": [{"hookId": "owned_hook", "path": "/api/webhooks/sanity/inventory-sync"}]}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.calls.append((self.command, self.path))
                if self.headers.get("Authorization") == "Bearer owned-old" and owner.denied:
                    self.send_response(403 if owner.forbidden else 401)
                    self.end_headers()
                    self.wfile.write(b'private-provider-error-marker')
                    return
                if self.command == "PATCH":
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    owner.assertEqual(body, {"isDisabledByUser": True})
                    if not owner.ignore_disable:
                        owner.disabled = True
                row = {"id": "owned_hook", "projectId": sanity.PROJECT,
                    "dataset": "production" if owner.production else sanity.DATASET, "type": "document", "httpMethod": "POST",
                    "isDisabled": owner.disabled, "isDisabledByUser": owner.disabled,
                    "url": "https://staging.lashher.com/api/webhooks/sanity/inventory-sync?x-vercel-protection-bypass=private-bypass-marker",
                    "secret": "private-hook-secret-marker"}
                if self.path == sanity.PREFIX:
                    value = [row] + ([{**row, "id": "unexpected_hook"}] if owner.extra_hook else [])
                elif self.path == sanity.PREFIX + "/owned_hook":
                    value = row
                elif "/attempts?" in self.path:
                    value = [{"id": "attempt_1", "projectId": sanity.PROJECT, "hookId": "owned_hook", "inProgress": owner.active,
                        "resultBody": "private-delivery-body-marker"}]
                elif "/messages?" in self.path:
                    offset = int(self.path.rsplit("=", 1)[1])
                    if owner.repeated:
                        offset = 0
                    value = [{"id": "message_" + str(i), "projectId": sanity.PROJECT, "hookId": "owned_hook", "dataset": sanity.DATASET,
                        "status": "queued" if owner.queued else owner.message_status, "resultCode": None if owner.queued and not owner.prior_success else 200,
                        "payload": "private-product-payload-marker"} for i in range(offset, min(owner.count, offset + 25))]
                    if owner.changed and owner.calls.count(("GET", self.path)) > 1:
                        value = []
                else:
                    self.send_response(500)
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
            do_PATCH = do_GET
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin_patch = patch.object(sanity, "ORIGIN", f"https://127.0.0.1:{self.server.server_port}")
        self.origin_patch.start()
        self.tls_patch = patch.object(sanity.ssl, "create_default_context", return_value=ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert)))
        self.tls_patch.start()
        self.client, self.old = sanity.Client("owned-new"), sanity.Client("owned-old")
        self.directory = vercel_test.tempfile.TemporaryDirectory()
        self.attempt = vercel_test.Path(self.directory.name)
        self.attempt.chmod(0o700)

    def tearDown(self):
        self.origin_patch.stop()
        self.tls_patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def test_https_suspension_reads_actual_disabled_state_and_does_not_claim_token_retirement(self):
        result = sanity.suspend(self.client, self.old, self.reviewed, {"actionId": "owned"}, self.attempt)
        self.assertEqual(result["status"], "SANITY_HOOKS_DISABLED_CREDENTIAL_RETIREMENT_PENDING")
        self.assertTrue(result["hooks"][0]["disabled"])
        self.denied = True
        observed = sanity.observe(self.client, self.old, self.reviewed)
        self.assertTrue(observed["retiredCredentialDenied"])
        self.assertEqual(observed["activeExecutions"], 0)
        self.assertEqual(observed["uncertainEffects"], 0)
        self.assertNotIn("private-", json.dumps(observed))
        self.assertNotIn("private-", "".join(path.read_text() for path in self.attempt.glob("*.json")))

    def test_disabled_hook_does_not_turn_queued_or_running_deliveries_into_zero(self):
        self.disabled, self.denied, self.queued, self.active = True, True, True, True
        observed = sanity.observe(self.client, self.old, self.reviewed)
        self.assertEqual(observed["activeExecutions"], 1)
        self.assertEqual(observed["uncertainEffects"], 1)
        self.prior_success = True
        self.assertEqual(sanity.observe(self.client, self.old, self.reviewed)["uncertainEffects"], 1)
        self.queued, self.message_status = False, "unknown"
        self.assertEqual(sanity.observe(self.client, self.old, self.reviewed)["uncertainEffects"], 1)

    def test_full_offset_pagination_and_repeated_page_refusal(self):
        self.count = 26
        self.assertEqual(len(sanity.deliveries(self.client, self.reviewed)[0]["messages"]), 26)
        self.assertIn(("GET", sanity.PREFIX + "/owned_hook/messages?limit=25&offset=25"), self.calls)
        self.repeated = True
        with self.assertRaisesRegex(ValueError, "DELIVERY_ID_REFUSED"):
            sanity.deliveries(self.client, self.reviewed)

    def test_unreviewed_hook_or_production_dataset_refuses_before_mutation(self):
        for attribute in ("extra_hook", "production"):
            setattr(self, attribute, True)
            with self.assertRaises(ValueError):
                sanity.suspend(self.client, self.old, self.reviewed, {}, self.attempt)
            self.assertFalse(any(method == "PATCH" for method, _path in self.calls))
            setattr(self, attribute, False)

    def test_failed_disable_readback_retains_uncertain_exact_hook(self):
        self.ignore_disable = True
        with self.assertRaisesRegex(ValueError, "DISABLE_READBACK_UNVERIFIED"):
            sanity.suspend(self.client, self.old, self.reviewed, {}, self.attempt)
        self.assertEqual(migrate.read_json(self.attempt, "sanity-hook-suspension-outcome.json")["uncertainHookId"], "owned_hook")

    def test403_is_not_token_denial_and_inventory_drift_refuses(self):
        self.denied, self.forbidden = True, True
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED_REQUIRES_REVIEW"):
            sanity.observe(self.client, self.old, self.reviewed)
        self.denied, self.changed = False, True
        self.calls = []
        with self.assertRaisesRegex(ValueError, "INVENTORY_CHANGED"):
            sanity.observe(self.client, self.old, self.reviewed)

    def test_transport_refuses_production_enabling_content_writes_replay_and_aliases(self):
        for method, path, body in [("GET", sanity.PREFIX.replace(sanity.PROJECT, "3auncj84"), None),
                ("PATCH", sanity.PREFIX + "/owned_hook", {"isDisabledByUser": False}),
                ("POST", sanity.PREFIX + "/owned_hook/messages/message/retry", {}),
                ("POST", "/v2026-03-24/data/mutate/" + sanity.DATASET, {}),
                ("GET", sanity.PREFIX + "/../production", None)]:
            with self.assertRaisesRegex(ValueError, "REQUEST_SCOPE_REFUSED"):
                self.client.request(method, path, body)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
