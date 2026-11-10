from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import ssl
import threading
import unittest
from unittest.mock import patch

import frontend_release_adapters as adapter
import frontend_release_adapters_test as adapter_tests
import frontend_resend_retirement as resend
import migrate
import vercel_test


class ResendRetirementTests(unittest.TestCase):
    DOMAIN = "d7371c9b-b16d-41d8-b9e8-3286b58eb432"
    OLD = "c133ba26-4f99-4450-beab-49912e586d3a"
    NEW = "b133ba26-4f99-4450-beab-49912e586d3b"
    HOOK = "333dea10-e8c3-44a5-bb93-bf2d4c604811"
    EMAIL = "a133ba26-4f99-4450-beab-49912e586d3a"

    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.keys, self.hook_status, self.calls = sorted([self.OLD, self.NEW]), "enabled", []
        self.lost_delete, self.old_still_works, self.ignore_hook, self.production_domain, self.old_forbidden = False, False, False, False, False
        self.after_delete = None
        self.paginate_keys, self.repeat_page = False, False
        self.email_states = [{"id": self.EMAIL, "last_event": "queued"}]
        self.repeat_email_page = False
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                path = self.path.split("?", 1)[0]
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw) if raw else None
                owner.calls.append({"method": self.command, "path": self.path, "body": body})
                token = self.headers.get("Authorization")
                if token == "Bearer owned-resend-old" and owner.OLD not in owner.keys and not owner.old_still_works:
                    self.send_response(403 if owner.old_forbidden else 401); self.end_headers(); self.wfile.write(b'private-provider-error-marker'); return
                if token not in ("Bearer owned-resend-new", "Bearer owned-resend-old"):
                    self.send_response(401); self.end_headers(); return
                if path == "/domains/" + owner.DOMAIN:
                    value = {"id": owner.DOMAIN, "name": "mail.lashher.com" if owner.production_domain else "mail.staging.lashher.com",
                        "status": "verified", "private": "domain-private-marker"}
                elif path == "/api-keys":
                    selected, more = owner.keys, False
                    if owner.paginate_keys and len(owner.keys) > 1:
                        selected, more = (owner.keys[-1:], True) if "after=" not in self.path or owner.repeat_page else (owner.keys[:-1], False)
                    value = {"object": "list", "has_more": more, "data": [{"id": key, "name": "private-key-name-marker"} for key in selected]}
                elif path == "/webhooks":
                    value = {"object": "list", "has_more": False, "data": [{"id": owner.HOOK}]}
                elif path == "/webhooks/" + owner.HOOK:
                    if self.command == "PATCH" and not owner.ignore_hook:
                        owner.assertEqual(body, {"status": "disabled"}); owner.hook_status = "disabled"
                    value = {"id": owner.HOOK, "status": owner.hook_status, "events": ["contact.updated"],
                        "endpoint": "https://staging.lashher.com/api/webhooks/resend?x-vercel-protection-bypass=private-url-marker"}
                elif path == "/api-keys/" + owner.OLD and self.command == "DELETE":
                    owner.keys.remove(owner.OLD)
                    if owner.after_delete: owner.after_delete()
                    if owner.lost_delete:
                        self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                    value = {"object": "api_key", "id": owner.OLD, "deleted": True}
                elif path == "/emails/" + owner.EMAIL:
                    value = {"id": owner.EMAIL, "last_event": "queued", "to": ["private-recipient-marker"], "html": "private-content-marker"}
                elif path == "/emails":
                    selected = owner.email_states
                    if "after=" in self.path and not owner.repeat_email_page:
                        cursor = self.path.split("after=", 1)[1]
                        selected = selected[next(i for i, row in enumerate(selected) if row["id"] == cursor) + 1:]
                    value = {"object": "list", "has_more": len(selected) > 100,
                        "data": [{**row, "to": ["private-recipient-marker"], "subject": "private-content-marker"} for row in selected[:100]]}
                else:
                    self.send_response(500); self.end_headers(); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(value).encode())
            do_PATCH = do_GET
            do_DELETE = do_GET
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.origin_patch = patch.object(resend, "ORIGIN", f"https://127.0.0.1:{self.server.server_port}"); self.origin_patch.start()
        tls_client = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        self.tls_patch = patch.object(resend.ssl, "create_default_context", return_value=tls_client); self.tls_patch.start()
        self.client, self.old = resend.Client("owned-resend-new"), resend.Client("owned-resend-old")
        self.fixture = adapter_tests.ConcreteFrontendAdapterTests(methodName="runTest"); self.fixture.setUp(); self.fixture.bootstrap_context()
        self.plan = {"domainId": self.DOMAIN, "domainName": "mail.staging.lashher.com", "retiredKeyId": self.OLD, "replacementKeyId": self.NEW,
            "expectedKeyIds": sorted(self.keys), "webhookIds": [self.HOOK], "knownEmailIds": [self.EMAIL]}
        self.fixture.context["bindings"]["resendRetirement"] = self.plan
        self.fixture.context.update(resendReplacementToken="owned-resend-new", resendRetiredToken="owned-resend-old")

    def tearDown(self):
        self.fixture.tearDown(); self.tls_patch.stop(); self.origin_patch.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def mutate_calls(self):
        return [row for row in self.calls if row["method"] != "GET"]

    def test_account_email_pagination_captures_unrecorded_sends_without_recipient_or_content_data(self):
        self.email_states = [{"id": f"{i:08x}-1111-4111-8111-111111111111", "last_event": "delivered"} for i in range(101)]
        self.email_states[0] = {"id": self.EMAIL, "last_event": "delivered"}
        observed = resend.accepted_email_effects(self.client, self.plan)
        self.assertTrue(observed["accountEmailPaginationComplete"])
        self.assertEqual(len(observed["acceptedEmails"]), 101)
        self.assertEqual(observed["unresolvedEffects"], 0)
        self.assertNotIn("private-", json.dumps(observed))
        self.assertEqual(self.mutate_calls(), [])

    def test_scheduled_sent_unknown_and_queued_emails_remain_unresolved_after_old_key_retirement(self):
        for state in ("scheduled", "sent", "queued", "delivery_delayed", "unknown"):
            self.email_states[0]["last_event"] = state
            self.assertEqual(resend.accepted_email_effects(self.client, self.plan)["unresolvedEffects"], 1)

    def test_repeated_email_page_and_missing_known_email_refuse_account_coverage(self):
        self.email_states = [{"id": f"{i:08x}-1111-4111-8111-111111111111", "last_event": "delivered"} for i in range(101)]
        self.email_states[0] = {"id": self.EMAIL, "last_event": "delivered"}
        self.repeat_email_page = True
        with self.assertRaisesRegex(ValueError, "INVENTORY_ID_REFUSED"):
            resend.accepted_email_effects(self.client, self.plan)
        self.repeat_email_page = False
        self.email_states = []
        with self.assertRaisesRegex(ValueError, "KNOWN_EMAIL_ABSENT"):
            resend.accepted_email_effects(self.client, self.plan)

    def test_actual_key_delete_webhook_disable_and_runtime_readback_keep_unknown_effects_unresolved(self):
        self.fixture.execute("deploy-admission")
        self.assertEqual(self.fixture.variables["RESEND_API_KEY"]["value"], "owned-resend-new")
        result = self.fixture.execute("retire-resend")
        self.assertEqual(result["status"], "STAGING_RESEND_CREDENTIAL_RETIRED_EFFECTS_UNRESOLVED")
        self.assertTrue(result["runtimeReplacementBindingVerified"]); self.assertTrue(result["retiredCredentialDenied"])
        self.assertFalse(result["historicalWritersFenced"]); self.assertIsNone(result["uncertainEffects"])
        self.assertEqual(result["observation"]["knownEmails"], [{"emailId": self.EMAIL, "lastEvent": "queued"}])
        self.assertEqual([row["method"] for row in self.mutate_calls()], ["PATCH", "DELETE"])
        receipts = "".join(path.read_text() for path in self.fixture.parent.rglob("*.json"))
        for private in ("owned-resend-new", "owned-resend-old", "private-url-marker", "private-recipient-marker", "private-content-marker", "private-key-name-marker"):
            self.assertNotIn(private, receipts)
        original = {str(path): path.read_bytes() for path in self.fixture.parent.rglob("*.json")}
        recovery = self.fixture.parent.parent / "recovery"; recovery.mkdir(mode=0o700)
        self.fixture.context.update(originalDirectory=str(self.fixture.parent), directory=str(recovery))
        writes = len(self.mutate_calls()); observed = self.fixture.execute("observe-resend")
        self.assertTrue(observed["retiredCredentialDenied"]); self.assertEqual(writes, len(self.mutate_calls()))
        for path, raw in original.items(): self.assertEqual(Path(path).read_bytes(), raw)

    def test_wrong_domain_or_unreviewed_key_refuses_before_mutation(self):
        self.production_domain = True
        with self.assertRaisesRegex(ValueError, "RESEND_DEDICATED_STAGING_DOMAIN_REFUSED"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.production_domain = False; self.keys.append("e133ba26-4f99-4450-beab-49912e586d3a"); self.keys.sort()
        with self.assertRaisesRegex(ValueError, "RESEND_REVIEWED_INVENTORY_CHANGED"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertFalse(self.mutate_calls())

    def test_webhook_disable_failure_stops_before_key_delete(self):
        self.ignore_hook = True
        with self.assertRaisesRegex(ValueError, "RESEND_WEBHOOK_DISABLE_UNVERIFIED"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertEqual([row["method"] for row in self.mutate_calls()], ["PATCH"])
        self.assertIn(self.OLD, self.keys)

    def test_lost_key_delete_ack_is_not_repeated_or_converted_into_success_by_absence(self):
        self.lost_delete = True
        with self.assertRaises(ValueError):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        outcome = migrate.read_json(self.fixture.parent, "resend-retirement-outcome.json")
        self.assertFalse(outcome["keyDeletionAcknowledged"]); self.assertEqual(outcome["uncertainMutation"], "delete-key:" + self.OLD)
        self.assertNotIn(self.OLD, self.keys); writes = len(self.mutate_calls())
        with self.assertRaises(ValueError):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertEqual(writes, len(self.mutate_calls())); self.assertEqual(migrate.read_json(self.fixture.parent, "resend-retirement-outcome.json"), outcome)
        self.assertTrue(resend.observe(self.client, self.old, self.plan)["retiredCredentialDenied"])

    def test_provider_absence_without_actual_old_token_denial_refuses(self):
        self.old_still_works = True
        with self.assertRaisesRegex(ValueError, "RESEND_KEY_RETIREMENT_READBACK_UNVERIFIED"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertFalse(migrate.read_json(self.fixture.parent, "resend-retirement-outcome.json")["retiredCredentialDenied"])

    def test_old_token403_is_not_proof_of_revocation(self):
        self.old_forbidden = True
        with self.assertRaisesRegex(ValueError, "RESEND_REQUEST_FAILED_REQUIRES_REVIEW"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)

    def test_runtime_still_using_retired_key_cannot_qualify_even_after_acknowledged_deletion(self):
        self.fixture.execute("deploy-admission")
        self.after_delete = lambda: self.fixture.variables["RESEND_API_KEY"].update(value="owned-resend-old")
        with self.assertRaises(ValueError):
            self.fixture.execute("retire-resend")
        self.assertNotIn(self.OLD, self.keys)
        self.assertTrue(migrate.read_json(self.fixture.parent / "vercel", "resend-retirement-outcome.json")["keyDeletionAcknowledged"])
        self.assertFalse((self.fixture.parent / "vercel" / "resend-runtime-binding-verified.json").exists())

    def test_runtime_policy_epoch_mismatch_refuses_before_provider_retirement(self):
        self.fixture.execute("deploy-admission")
        self.fixture.context["admissionObservation"]["epoch"] = "2"
        with self.assertRaisesRegex(ValueError, "RESEND_RUNTIME_REPLACEMENT_BINDING_UNVERIFIED"):
            self.fixture.execute("retire-resend")
        self.assertFalse(self.mutate_calls()); self.assertIn(self.OLD, self.keys)

    def test_transport_forbids_sends_creation_enablement_and_url_aliases(self):
        for method, path, body in [("POST", "/emails", {}), ("POST", "/api-keys", {}), ("PATCH", "/webhooks/" + self.HOOK, {"status": "enabled"}),
            ("DELETE", "/domains/" + self.DOMAIN, None), ("GET", "/domains/" + self.DOMAIN + "?token=private", None)]:
            with self.assertRaisesRegex(ValueError, "RESEND_REQUEST_SCOPE_REFUSED"): self.client.request(method, path, body)
        self.assertFalse(self.calls)

    def test_actual_key_pagination_is_exhaustive_before_and_after_retirement(self):
        self.paginate_keys = True
        result = resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertTrue(result["retiredCredentialDenied"])
        self.assertTrue(any("after=" + self.OLD in row["path"] for row in self.calls))

    def test_repeated_provider_page_refuses_before_webhook_or_key_mutation(self):
        self.paginate_keys = True; self.repeat_page = True
        with self.assertRaisesRegex(ValueError, "RESEND_INVENTORY_ID_REFUSED"):
            resend.retire(self.client, self.old, self.plan, adapter.identity(self.fixture.context), self.fixture.parent)
        self.assertFalse(self.mutate_calls())


if __name__ == "__main__": unittest.main()
