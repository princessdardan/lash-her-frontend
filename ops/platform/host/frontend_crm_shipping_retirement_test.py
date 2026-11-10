from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import frontend_crm_shipping_retirement as component
import migrate
import vercel_test


class RetirementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.calls = []
        self.denied = False
        self.denial_status = 401
        self.refresh_error = "invalid_grant"
        self.refresh_malformed = False
        self.response_mode = None
        self.wrong_tenant = False
        self.count_delta = 0
        self.duplicate = False
        self.changed_order = False
        self.changed_postage = False
        self.changed_amount = False
        self.drift = False
        self.reads = 0
        self.private_markers = ["owned-retired-token", "owned-replacement-token", "private-email@example.test", "private-provider-error", "private-refresh-token", "private-client-secret", "private-note-body"]
        self.shipments = [{"id": "ownedShipment", "status": "delivered", "order_id": "owned-public-reference", "postage_type": "canada_post_tracked", "purchase_amount": "1.00", "to_email": "private-email@example.test"}]
        self.contacts = [{"id": "ownedContact", "locationId": "ownedLocation", "email": "private-email@example.test"}]
        self.workflows = []
        self.workflow_total_delta = 0
        self.workflow_cursor_repeat = False
        self.rows = {"shipments": [{"id": "11111111-1111-4111-8111-111111111111", "public_reference": "owned-public-reference", "provider_shipment_id": "ownedShipment", "provider_status": "delivered", "status": "delivered", "state_version": 2,
            "selected_postage_type": "canada_post_tracked", "actual_purchase_total_cents": 100, "provider_cost_currency": "CAD", "purchased_at": "2026-11-05 10:00:00+00", "delivered_at": "2026-11-05 11:00:00+00"}],
            "jobs": [{"id": "22222222-2222-4222-8222-222222222222", "shipment_id": "11111111-1111-4111-8111-111111111111", "type": "purchase", "status": "succeeded", "state_version": 2,
                "idempotency_sha256": "d" * 64, "operation_payload_hash": "e" * 64, "outcome_unknown": False, "lease_held": False, "completed_at": "2026-11-05 10:00:00+00"}]}
        self.crm_rows = {"contacts": [{"id": "33333333-3333-4333-8333-333333333333", "provider_id": "ownedContact", "location_id": "ownedLocation", "email_sha256": hashlib.sha256(b"private-email@example.test").hexdigest(), "deleted_at": None, "last_synced_at": "2026-11-05"}],
            "effects": [{"key": "entity:submission:ownedSubmission", "contact_id": "33333333-3333-4333-8333-333333333333", "kind": "entity", "provider_id": None, "state": "recorded", "data": {}}],
            "outbox": [], "connections": [], "webhookReceipts": [], "marketingDeliveries": []}
        common = {"environment": "staging", "sourceBindingSha256": "a" * 64, "retiredCredentialBindingSha256": "b" * 64, "replacementCredentialBindingSha256": "c" * 64}
        self.shipping = {**common, "clientId": "ownedClient", "credentialKind": "personal-access-token", "expectedProviderShipmentIds": ["ownedShipment"], "databaseSnapshotSha256": component.snapshot_sha256(self.rows)}
        self.crm = {**common, "locationId": "ownedLocation", "companyId": "ownedCompany", "credentialKind": "private-integration-token", "retiredIntegrationId": "ownedIntegration",
            "expectedProviderContactIds": ["ownedContact"], "expectedWorkflowIds": [], "databaseSnapshotSha256": component.snapshot_sha256(self.crm_rows)}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                # Credentials and bodies stay only in owned fixture memory.
                owner.calls.append((self.command, self.path))
                old = self.headers.get("Authorization", "").endswith("owned-retired-token")
                if self.path == "/oauth/token":
                    values = dict(component.urllib.parse.parse_qsl(raw.decode()))
                    owner.assertEqual(values, {"client_id": "ownedOAuthClient", "client_secret": "private-client-secret", "refresh_token": "private-refresh-token", "grant_type": "refresh_token", "user_type": "Location"})
                    if owner.refresh_malformed:
                        self.send_response(200); self.end_headers(); self.wfile.write(b"incomplete-private-provider-error")
                    elif owner.refresh_error is None:
                        self.reply(200, {"access_token": "do-not-publish-rotated-token", "refresh_token": "do-not-publish-rotated-refresh"})
                    else:
                        self.reply(400, {"error": owner.refresh_error, "error_description": "private-provider-error"})
                    return
                if owner.response_mode is not None:
                    if owner.response_mode == "redirect":
                        self.send_response(302); self.send_header("Location", "/unreviewed"); self.end_headers()
                    else:
                        self.send_response(200); self.end_headers()
                        self.wfile.write(b"x" * 2_000_001 if owner.response_mode == "oversized" else b"private-provider-error")
                    return
                if old and owner.denied:
                    self.reply(owner.denial_status, {"statusCode": owner.denial_status, "error": {"message": "private-provider-error"}})
                    return
                if self.path.endswith("/shipments/count"):
                    self.reply(200, {"count": len(owner.shipments) + owner.count_delta})
                elif "/shipments?" in self.path:
                    owner.reads += 1
                    page = int(component.urllib.parse.parse_qs(component.urllib.parse.urlsplit(self.path).query)["page"][0])
                    data = deepcopy(owner.shipments[(page - 1) * 100:page * 100])
                    if owner.duplicate and data:
                        data.append(data[0])
                    if owner.drift and owner.reads > 1 and data:
                        data[0]["status"] = "in_transit"
                    self.reply(200, data)
                elif "/shipments/" in self.path:
                    item = self.path.rsplit("/", 1)[1]
                    data = deepcopy(next(row for row in owner.shipments if row["id"] == item))
                    if owner.changed_order:
                        data["order_id"] = "another-order"
                    self.reply(200, {"shipment": data})
                elif self.path == "/locations/ownedLocation":
                    self.reply(200, {"location": {"id": "production-location" if owner.wrong_tenant else "ownedLocation", "companyId": "ownedCompany", "name": "private-business-name"}})
                elif self.path == "/contacts/search":
                    body = json.loads(raw)
                    owner.assertEqual(body["locationId"], "ownedLocation")
                    page = body["page"]
                    self.reply(200, {"contacts": owner.contacts[(page - 1) * 100:page * 100], "total": len(owner.contacts)})
                elif self.path == "/workflows/search?locationId=ownedLocation":
                    body = json.loads(raw)
                    start = int(body["searchAfter"][0]) if "searchAfter" in body else 0
                    rows = owner.workflows[start:start + 100]
                    value = {"workflows": rows, "count": len(rows), "total": len(owner.workflows) + owner.workflow_total_delta}
                    if start + len(rows) < len(owner.workflows):
                        value["searchAfter"] = [str(start + len(rows))]
                    elif owner.workflow_cursor_repeat:
                        value["searchAfter"] = body.get("searchAfter", ["100"])
                    self.reply(200, value)
                elif self.path == "/contacts/ownedContact":
                    self.reply(200, {"contact": owner.contacts[0]})
                elif self.path == "/contacts/ownedContact/notes/ownedNote":
                    self.reply(200, {"note": {"id": "ownedNote", "contactId": "ownedContact", "body": "[LH submission ownedSubmission]\nprivate-note-body"}})
                else:
                    self.reply(500, {"message": "private-provider-error"})

            def reply(self, status, value):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())

            do_POST = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.patches = [patch.object(component, name, f"https://127.0.0.1:{self.server.server_port}") for name in ("HIGHLEVEL_ORIGIN", "CHITCHATS_ORIGIN")]
        tls_client = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        self.patches.append(patch.object(component.ssl, "create_default_context", return_value=tls_client))
        for item in self.patches:
            item.start()
        self.directory = tempfile.TemporaryDirectory()
        self.attempt = Path(self.directory.name)
        self.attempt.chmod(0o700)
        self.selected = {"actionId": "owned-retirement", "sourceCommit": "f" * 40, "targetSha256": "a" * 64}

    def tearDown(self):
        self.directory.cleanup()
        for item in reversed(self.patches):
            item.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def clients(self, provider, reviewed, refresh=False):
        private = {"client_id": "ownedOAuthClient", "client_secret": "private-client-secret", "refresh_token": "private-refresh-token"} if refresh else None
        return component.Client(provider, "owned-replacement-token", reviewed), component.Client(provider, "owned-retired-token", reviewed, private)

    def observe_shipping(self):
        self.shipping["databaseSnapshotSha256"] = component.snapshot_sha256(self.rows)
        return component.observe_chitchats(*self.clients("chitchats", self.shipping), self.shipping, self.rows)

    def test_full_nonempty_terminal_shipping_scope_has_concrete_zero_without_global_authorization(self):
        self.denied = True
        result = self.observe_shipping()
        self.assertTrue(result["retiredCredentialDenied"])
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertTrue(result["knownEffects"][0]["immutableMatch"])
        self.assertEqual(result["knownJobs"][0]["idempotencySha256"], "d" * 64)
        self.assertFalse(result["historicalWritersFenced"])
        self.assertFalse(result["trafficAuthorized"])
        raw = json.dumps(result)
        for marker in self.private_markers:
            self.assertNotIn(marker, raw)

    def test_pending_refund_tracking_unknown_database_job_and_orphans_remain_unresolved(self):
        for status in ("pending", "refund_requested", "ready", "in_transit", "resolved", "future_unknown"):
            with self.subTest(status=status):
                self.shipments[0]["status"] = status
                self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
        self.shipments[0]["status"] = "delivered"
        for field, value in (("outcome_unknown", True), ("status", "retryable_failed"), ("lease_held", True), ("completed_at", None), ("operation_payload_hash", None), ("type", "notification")):
            row = deepcopy(self.rows["jobs"][0])
            self.rows["jobs"][0][field] = value
            self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
            self.rows["jobs"][0] = row
        self.rows["shipments"] = []
        self.rows["jobs"] = []
        result = self.observe_shipping()
        self.assertEqual(result["unmappedProviderShipments"], 1)
        self.assertGreater(result["uncertainEffects"], 0)

    def test_acknowledged_carrier_states_are_reconciled_effects_with_future_polling_held(self):
        self.denied = True
        for provider, stored in (("ready", "label_ready"), ("received", "accepted"), ("released", "in_transit"), ("inducted", "in_transit"), ("in_transit", "in_transit")):
            with self.subTest(provider=provider):
                self.shipments[0]["status"] = provider
                self.rows["shipments"][0].update(status=stored, provider_status=provider)
                result = self.observe_shipping()
                self.assertTrue(result["retiredCredentialDenied"])
                self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
                self.assertEqual(result["deferredPhysicalShipmentIds"], ["ownedShipment"])
                self.assertTrue(result["compatiblePollingRequired"])
                self.assertFalse(result["futurePollingAuthorized"])
                self.assertFalse(result["historicalWritersFenced"])
        self.rows["shipments"][0]["provider_status"] = "released"
        self.shipments[0]["status"] = "inducted"
        self.assertEqual(self.observe_shipping()["uncertainEffects"], 0, "equivalent recognized carrier observations normalize to the same persisted state")

    def test_acknowledged_shipping_requires_operation_receipts_and_no_pending_or_changed_effects(self):
        self.shipments[0]["status"] = "ready"
        self.rows["shipments"][0].update(status="label_ready", provider_status="ready")
        original = deepcopy(self.rows)
        for field, value in (("status", "processing"), ("lease_held", True), ("outcome_unknown", True), ("operation_payload_hash", None)):
            self.rows["jobs"][0][field] = value
            result = self.observe_shipping()
            self.assertGreater(result["uncertainEffects"], 0)
            if value == "processing":
                self.assertEqual(result["activeExecutions"], 1)
            self.rows = deepcopy(original)
        self.rows["jobs"] = []
        self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
        self.rows = deepcopy(original)
        self.rows["shipments"][0]["provider_status"] = "pending"
        self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
        self.rows = deepcopy(original)
        self.rows["shipments"][0]["status"] = "purchase_pending"
        self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)

    def test_pagination_count_duplicates_scope_drift_and_changed_immutable_readback_refuse(self):
        for flag in ("count_delta", "duplicate", "changed_order", "drift"):
            with self.subTest(flag=flag):
                self.reads = 0
                setattr(self, flag, True)
                with self.assertRaises(ValueError):
                    self.observe_shipping()
                setattr(self, flag, False)

    def test_complete_shipping_pagination_reads_exact_multiple_and_bound_limits(self):
        self.shipments = [{**self.shipments[0], "id": f"shipment{index:03}"} for index in range(100)]
        self.shipping["expectedProviderShipmentIds"] = sorted(row["id"] for row in self.shipments)
        result = component.chitchats_inventory(self.clients("chitchats", self.shipping)[0], self.shipping)
        self.assertEqual(len(result["shipments"]), 100)
        self.assertTrue(any(path.endswith("page=2") for _method, path in self.calls))
        self.shipping["expectedProviderShipmentIds"] = []
        with self.assertRaisesRegex(ValueError, "REVIEWED_INVENTORY_CHANGED"):
            component.chitchats_inventory(self.clients("chitchats", self.shipping)[0], self.shipping)

    def test_database_snapshot_binding_and_full_shape_cannot_be_replaced_by_completion_flags(self):
        replacement, retired = self.clients("chitchats", self.shipping)
        with self.assertRaisesRegex(ValueError, "ACTUAL_DATABASE_SNAPSHOT_REQUIRED"):
            component.observe_chitchats(replacement, retired, self.shipping, {"complete": True})
        self.rows["jobs"][0]["state_version"] += 1
        with self.assertRaisesRegex(ValueError, "DATABASE_SNAPSHOT_CHANGED"):
            component.observe_chitchats(replacement, retired, self.shipping, self.rows)
        self.assertFalse(self.calls)

    def test_highlevel_contact_and_current_workflow_search_pagination_require_complete_totals(self):
        self.contacts = [{"id": f"contact{index:03}", "locationId": "ownedLocation"} for index in range(150)]
        self.workflows = [{"id": f"workflow{index:03}", "status": "draft"} for index in range(101)]
        self.crm["expectedProviderContactIds"] = sorted(row["id"] for row in self.contacts)
        self.crm["expectedWorkflowIds"] = sorted(row["id"] for row in self.workflows)
        clients = self.clients("highlevel", self.crm)
        result = component.highlevel_inventory(clients[0], self.crm)
        self.assertEqual(len(result["providerContactIds"]), 150)
        self.assertEqual(len(result["workflows"]), 101)
        self.workflow_total_delta = 1
        with self.assertRaisesRegex(ValueError, "COUNT_MISMATCH"):
            component.highlevel_inventory(clients[0], self.crm)
        self.workflow_total_delta = 0
        self.workflow_cursor_repeat = True
        with self.assertRaisesRegex(ValueError, "CURSOR_REFUSED"):
            component.highlevel_inventory(clients[0], self.crm)

    def test_dashboard_retirement_requires_real_denial_and_immutable_original_receipts(self):
        clients = self.clients("chitchats", self.shipping)
        component.suspend("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        original = (self.attempt / "chitchats-retirement-before.json").read_bytes()
        self.denied = True
        result = component.verify_retirement("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        self.assertTrue(result["retiredCredentialDenied"])
        self.assertEqual(original, (self.attempt / "chitchats-retirement-before.json").read_bytes())
        self.assertEqual(result["uncertainEffects"], 0)
        for marker in self.private_markers:
            self.assertNotIn(marker, "".join(p.read_text() for p in self.attempt.glob("*.json")))
        calls = len(self.calls)
        with self.assertRaises(FileExistsError):
            component.verify_retirement("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        self.assertEqual(len(self.calls), calls)

    def test_preretirement_receipts_require_private_owned_directory_before_provider_reads(self):
        self.attempt.chmod(0o755)
        try:
            with self.assertRaisesRegex(ValueError, "PRIVATE_DIRECTORY_REQUIRED"):
                component.suspend("chitchats", *self.clients("chitchats", self.shipping), self.shipping, self.rows, self.selected, self.attempt)
        finally:
            self.attempt.chmod(0o700)
        self.assertFalse(self.calls)

    def test_403_missing_preretirement_or_stillusable_never_proves_retirement(self):
        clients = self.clients("chitchats", self.shipping)
        with self.assertRaises(FileNotFoundError):
            component.verify_retirement("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        self.denied = True
        self.denial_status = 403
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED"):
            self.observe_shipping()
        self.denied = False
        component.suspend("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        with self.assertRaisesRegex(ValueError, "STILL_USABLE"):
            component.verify_retirement("chitchats", *clients, self.shipping, self.rows, self.selected, self.attempt)
        saved = migrate.read_json(self.attempt, "chitchats-retirement-outcome.json")
        self.assertFalse(saved["retiredCredentialDenied"])

    def test_highlevel_known_records_reconcile_without_inventing_workflow_or_ingress_zero(self):
        self.crm_rows["effects"].append({"key": "note:ownedSubmission", "contact_id": self.crm_rows["contacts"][0]["id"], "kind": "note", "provider_id": "ownedNote", "state": "succeeded", "data": {}})
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        self.denied = True
        result = component.observe_highlevel(*self.clients("highlevel", self.crm), self.crm, self.crm_rows)
        self.assertEqual(result["knownUnresolvedEffects"], 0)
        self.assertIsNone(result["activeExecutions"])
        self.assertIsNone(result["uncertainEffects"])
        self.assertFalse(result["workflowExecutionInventoryComplete"])
        self.assertFalse(result["inboundWebhooksQualified"])
        for marker in self.private_markers:
            self.assertNotIn(marker, json.dumps(result))

    def test_highlevel_wrong_tenant_pending_journey_outbox_and_accepted_delivery_remain_unresolved(self):
        self.wrong_tenant = True
        with self.assertRaisesRegex(ValueError, "ACTUAL_TENANT_BINDING_REFUSED"):
            component.observe_highlevel(*self.clients("highlevel", self.crm), self.crm, self.crm_rows)
        self.wrong_tenant = False
        self.crm_rows["effects"].append({"key": "journey:owned", "contact_id": self.crm_rows["contacts"][0]["id"], "kind": "workflow", "state": "succeeded", "provider_id": None, "data": {"workflow": "ownedWorkflow"}})
        self.crm_rows["outbox"] = [{"status": "processing", "lease_held": True, "completed_at": None}]
        self.crm_rows["marketingDeliveries"] = [{"status": "queued"}]
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        result = component.observe_highlevel(*self.clients("highlevel", self.crm), self.crm, self.crm_rows)
        self.assertEqual(result["knownUnresolvedEffects"], 3)
        self.assertIsNone(result["uncertainEffects"])

    def test_oauth_refresh_denial_is_actual_one_shot_and_invalid_client_or_success_never_qualifies(self):
        self.crm.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        clients = self.clients("highlevel", self.crm, refresh=True)
        component.suspend("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.denied = True
        result = component.verify_retirement("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.assertTrue(result["retiredRefreshDenied"])
        self.assertEqual(sum(path == "/oauth/token" for _method, path in self.calls), 1)
        with self.assertRaises(FileExistsError):
            component.verify_retirement("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.assertEqual(sum(path == "/oauth/token" for _method, path in self.calls), 1)
        self.refresh_error = "invalid_client"
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED"):
            self.clients("highlevel", self.crm, refresh=True)[1].request("POST", "/oauth/token")
        self.refresh_error = None
        fresh = self.clients("highlevel", self.crm, refresh=True)[1]
        self.assertEqual(fresh.request("POST", "/oauth/token"), {"refreshDenied": False})
        with self.assertRaisesRegex(ValueError, "REPLAY_REFUSED"):
            fresh.request("POST", "/oauth/token")
        for marker in self.private_markers + ["do-not-publish-rotated-token", "do-not-publish-rotated-refresh"]:
            self.assertNotIn(marker, "".join(p.read_text() for p in self.attempt.glob("*.json")))

    def test_transport_forbids_other_accounts_mutations_revoke_token_introspection_and_production(self):
        shipping, _old = self.clients("chitchats", self.shipping)
        crm, _old = self.clients("highlevel", self.crm)
        for client, method, path, body in [(shipping, "DELETE", "/api/v1/clients/ownedClient/shipments/ownedShipment", None),
            (shipping, "GET", "/api/v1/clients/production/shipments/count", None), (shipping, "GET", "/api/v1/clients/ownedClient/shipments/unknown", None),
            (crm, "POST", "/oauth/revoke", {}), (crm, "POST", "/oauth/token", None), (crm, "DELETE", "/contacts/ownedContact", None),
            (crm, "GET", "/contacts/productionContact", None), (crm, "POST", "/contacts/search", {"locationId": "production", "page": 1, "pageLimit": 100}),
            (crm, "GET", "//external.invalid/contacts", None)]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "REQUEST_SCOPE_REFUSED"):
                client.request(method, path, body)
        production = {**self.crm, "locationId": component.PRODUCTION_HIGHLEVEL_LOCATION}
        with self.assertRaisesRegex(ValueError, "LOCATION_BINDING_REQUIRED"):
            component.Client("highlevel", "owned-token", production)
        self.assertFalse(self.calls)

    def test_immutable_money_postage_and_order_mismatch_are_never_settled(self):
        original = deepcopy(self.shipments[0])
        for field, value in (("purchase_amount", "2.00"), ("purchase_amount", None), ("postage_type", "another-postage"), ("order_id", "another-order")):
            self.shipments[0][field] = value
            self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
            self.shipments[0] = deepcopy(original)

    def test_malformed_oversized_and_redirect_responses_are_sanitized_and_never_followed(self):
        client = self.clients("chitchats", self.shipping)[0]
        for mode in ("redirect", "oversized", "malformed"):
            self.response_mode = mode
            before = len(self.calls)
            with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW") as failure:
                client.request("GET", "/api/v1/clients/ownedClient/shipments/count")
            self.assertEqual(len(self.calls), before + 1)
            self.assertNotIn("private-provider-error", str(failure.exception))

    def test_lost_refresh_response_retains_failed_receipt_and_never_replays(self):
        self.crm.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        clients = self.clients("highlevel", self.crm, refresh=True)
        component.suspend("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.denied = True
        self.refresh_malformed = True
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED"):
            component.verify_retirement("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        receipt = migrate.read_json(self.attempt, "highlevel-retirement-outcome.json")
        self.assertEqual(receipt["status"], "RETIREMENT_VERIFICATION_UNRESOLVED")
        self.assertIsNone(receipt["retiredRefreshDenied"])
        calls = len(self.calls)
        with self.assertRaises(FileExistsError):
            component.verify_retirement("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.assertEqual(calls, len(self.calls))

    def test_oauth_uninstall_receipts_can_commit_without_rewriting_before_evidence(self):
        self.crm.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        self.crm_rows["connections"] = [{"location_id": "ownedLocation", "installed_by": "44444444-4444-4444-8444-444444444444", "refresh_state": "ready", "credentials_revoked": False,
            "expires_at": "2026-11-06T10:00:00Z", "updated_at": "2026-11-05T10:00:00Z"}]
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        clients = self.clients("highlevel", self.crm, refresh=True)
        component.suspend("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        original = (self.attempt / "highlevel-retirement-before.json").read_bytes()
        self.crm_rows["connections"][0].update(refresh_state="revoked", credentials_revoked=True, updated_at="2026-11-05T11:00:00Z")
        self.crm_rows["webhookReceipts"] = [{"receipt_sha256": "e" * 64, "location_id": "ownedLocation", "event_type": "AppUninstall", "provider_contact_id": None, "received_at": "2026-11-05T11:00:00Z"}]
        self.denied = True
        result = component.verify_retirement("highlevel", *self.clients("highlevel", self.crm, refresh=True), self.crm, self.crm_rows, self.selected, self.attempt)
        self.assertTrue(result["retiredRefreshDenied"])
        self.assertEqual(original, (self.attempt / "highlevel-retirement-before.json").read_bytes())
        self.assertIsNone(result["uncertainEffects"])
        self.assertEqual(result["reviewedDatabaseSnapshotSha256"], self.crm["databaseSnapshotSha256"])
        self.assertEqual(result["expectedDatabaseTransition"]["kind"], "source-AppUninstall-persistence")
        self.assertNotEqual(result["databaseSnapshotSha256"], self.crm["databaseSnapshotSha256"])
        outcome = (self.attempt / "highlevel-retirement-outcome.json").read_bytes()
        observed = component.observe_retirement("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        self.assertTrue(observed["retiredRefreshDenied"])
        self.assertFalse(observed["refreshProbed"])
        self.assertEqual(sum(path == "/oauth/token" for _method, path in self.calls), 1)
        self.assertEqual(original, (self.attempt / "highlevel-retirement-before.json").read_bytes())
        self.assertEqual(outcome, (self.attempt / "highlevel-retirement-outcome.json").read_bytes())

    def test_uninstall_transition_needs_exact_receipt_and_revocation_and_preserves_unrelated_effects(self):
        self.crm.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        self.crm_rows["connections"] = [{"location_id": "ownedLocation", "installed_by": "44444444-4444-4444-8444-444444444444", "refresh_state": "ready", "credentials_revoked": False,
            "expires_at": "2026-11-06T10:00:00Z", "updated_at": "2026-11-05T10:00:00Z"}]
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        clients = self.clients("highlevel", self.crm, refresh=True)
        component.suspend("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        expected = deepcopy(self.crm_rows)
        expected["connections"][0].update(refresh_state="revoked", credentials_revoked=True, updated_at="2026-11-05T11:00:00Z")
        expected["webhookReceipts"] = [{"receipt_sha256": "e" * 64, "location_id": "ownedLocation", "event_type": "AppUninstall", "provider_contact_id": None, "received_at": "2026-11-05T11:00:00Z"}]
        cases = []
        changed = deepcopy(expected); changed["connections"][0]["credentials_revoked"] = False; cases.append(changed)
        changed = deepcopy(expected); changed["connections"][0]["expires_at"] = "2026-11-07T10:00:00Z"; cases.append(changed)
        changed = deepcopy(expected); changed["connections"][0]["installed_by"] = "another-installer"; cases.append(changed)
        changed = deepcopy(expected); changed["webhookReceipts"][0]["event_type"] = "ContactDndUpdate"; cases.append(changed)
        changed = deepcopy(expected); changed["webhookReceipts"][0]["location_id"] = "production"; cases.append(changed)
        changed = deepcopy(expected); changed["webhookReceipts"][0]["received_at"] = "2026-11-05T11:00:01Z"; cases.append(changed)
        changed = deepcopy(expected); changed["effects"][0]["state"] = "cancelled"; cases.append(changed)
        changed = deepcopy(expected); changed["contacts"].append(deepcopy(changed["contacts"][0])); cases.append(changed)
        self.denied = True
        for changed in cases:
            original = deepcopy(changed)
            with self.assertRaises(ValueError):
                component.verify_retirement("highlevel", *clients, self.crm, changed, self.selected, self.attempt)
            self.assertEqual(changed, original)
        self.assertFalse((self.attempt / "highlevel-retirement-verification-started.json").exists())


@unittest.skipUnless(os.environ.get("FRONTEND_CRM_SHIPPING_POSTGRES_TEST") == "true", "explicit owned disposable PostgreSQL fixture only")
class DatabaseRetirementTests(unittest.TestCase):
    """Actual 83-migration schema + fixed source SQL, verified TLS/SCRAM."""
    @classmethod
    def setUpClass(cls):
        RetirementTests.setUpClass()
        cls.addClassCleanup(RetirementTests.tearDownClass)
        cls.cluster = tempfile.TemporaryDirectory(prefix="frontend-crm-shipping-owned-")
        cls.root = Path(cls.cluster.name)
        cls.data = cls.root / "data"
        cls.started = False
        cls.addClassCleanup(cls.cleanup_cluster)
        cls.bin = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@16/bin"))
        version = subprocess.check_output([str(cls.bin / "postgres"), "--version"], text=True)
        if "PostgreSQL) 16." not in version:
            raise ValueError("OWNED_POSTGRES16_REQUIRED")
        cls.password = "owned-" + str(uuid.uuid4())
        password_file = cls.root / "password"
        password_file.write_text(cls.password)
        password_file.chmod(0o600)
        subprocess.run([str(cls.bin / "initdb"), "-D", str(cls.data), "-U", "frontend_provider_fixture", "-A", "scram-sha-256", "--pwfile", str(password_file), "--locale=C", "-E", "UTF8"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        cls.port = probe.getsockname()[1]
        probe.close()
        cert, key = vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key
        (cls.data / "postgresql.conf").write_text(f"listen_addresses='127.0.0.1'\nport={cls.port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='{cert}'\nssl_key_file='{key}'\npassword_encryption='scram-sha-256'\n")
        (cls.data / "pg_hba.conf").write_text("hostssl all all 127.0.0.1/32 scram-sha-256\n")
        subprocess.run([str(cls.bin / "pg_ctl"), "-D", str(cls.data), "-l", str(cls.root / "postgres.log"), "-w", "start"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        cls.started = True
        cls.environment = {"PATH": os.environ.get("PATH", ""), "PGPASSWORD": cls.password, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(cert)}
        cls.repository = Path(__file__).resolve().parents[3]
        journal = json.loads((cls.repository / "drizzle/meta/_journal.json").read_text())
        for entry in journal["entries"]:
            sql = (cls.repository / "drizzle" / (entry["tag"] + ".sql")).read_text()
            cls.sql("BEGIN;\n" + sql + "\nCOMMIT;")
        cls.migration_count = len(journal["entries"])

    @classmethod
    def sql(cls, value):
        result = subprocess.run([str(cls.bin / "psql"), "-X", "-h", "127.0.0.1", "-p", str(cls.port), "-U", "frontend_provider_fixture", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-A", "-t"],
            input=value, text=True, env=cls.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise AssertionError("OWNED_POSTGRES_QUERY_FAILED")
        return result.stdout.strip()

    @classmethod
    def cleanup_cluster(cls):
        try:
            if cls.started:
                subprocess.run([str(cls.bin / "pg_ctl"), "-D", str(cls.data), "-m", "immediate", "-w", "stop"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        finally:
            cls.cluster.cleanup()

    setUp = RetirementTests.setUp
    tearDown = RetirementTests.tearDown
    clients = RetirementTests.clients
    observe_shipping = RetirementTests.observe_shipping

    def actual(self, provider, reviewed):
        selected = []
        for name, sql, params in component.database_queries(provider, reviewed):
            for index, value in enumerate(params, 1):
                self.assertTrue(component.identifier(value))
                sql = sql.replace("$" + str(index), "'" + value + "'")
            selected.append(f"'{name}', (SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM ({sql}) r)")
        raw = self.sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object(" + ",".join(selected) + ");\nCOMMIT;")
        return json.loads(next(line for line in raw.splitlines() if line.startswith("{")))

    def test_fixed_sql_runs_against_migrated_schema_and_actual_terminal_receipt_joins(self):
        self.assertEqual(self.migration_count, 83)
        self.sql("""INSERT INTO product_shipments(id,public_reference,quote_token_hash,quote_fingerprint,status,destination,package_snapshot,customs_lines,rates,quote_expires_at,
          provider_shipment_id,provider_status,selected_postage_type,actual_purchase_total_cents,purchased_at,delivered_at)
          VALUES ('11111111-1111-4111-8111-111111111111','owned-public-reference','owned-token-hash','owned-fingerprint','delivered','{}','{}','[]','[]',now(),
          'ownedShipment','delivered','canada_post_tracked',100,now(),now()) ON CONFLICT(id) DO NOTHING;
          INSERT INTO product_shipment_jobs(id,shipment_id,type,status,idempotency_key,operation_payload_hash,outcome_unknown,completed_at)
          VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','purchase','succeeded','owned-purchase-operation',repeat('e',64),false,now()) ON CONFLICT(id) DO NOTHING;
          INSERT INTO highlevel_contacts(id,location_id,email_normalized,provider_id,last_synced_at)
          VALUES ('33333333-3333-4333-8333-333333333333','ownedLocation','private-email@example.test','ownedContact',now()) ON CONFLICT(id) DO NOTHING;
          INSERT INTO highlevel_effects(key,contact_id,kind,state) VALUES ('entity:submission:ownedSubmission','33333333-3333-4333-8333-333333333333','entity','recorded') ON CONFLICT DO NOTHING;""")
        self.rows = self.actual("chitchats", self.shipping)
        self.shipping["databaseSnapshotSha256"] = component.snapshot_sha256(self.rows)
        self.denied = True
        result = self.observe_shipping()
        self.assertEqual(result["uncertainEffects"], 0)
        self.assertEqual(result["knownJobs"][0]["idempotencySha256"], hashlib.sha256(b"owned-purchase-operation").hexdigest())
        self.sql("UPDATE product_shipments SET status='label_ready',provider_status='ready',delivered_at=null WHERE id='11111111-1111-4111-8111-111111111111';")
        self.shipments[0]["status"] = "ready"
        self.rows = self.actual("chitchats", self.shipping)
        accepted = self.observe_shipping()
        self.assertEqual((accepted["activeExecutions"], accepted["uncertainEffects"]), (0, 0))
        self.assertEqual(accepted["deferredPhysicalShipmentIds"], ["ownedShipment"])
        self.assertFalse(accepted["futurePollingAuthorized"])
        self.sql("UPDATE product_shipments SET status='delivered',provider_status='delivered',delivered_at=now() WHERE id='11111111-1111-4111-8111-111111111111';")
        self.shipments[0]["status"] = "delivered"
        self.rows = self.actual("chitchats", self.shipping)
        self.shipping["databaseSnapshotSha256"] = component.snapshot_sha256(self.rows)
        self.crm_rows = self.actual("highlevel", self.crm)
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        self.assertNotIn("private-email", json.dumps(self.crm_rows))
        self.assertNotIn("credentials_ciphertext", json.dumps(self.crm_rows))
        result = component.observe_highlevel(*self.clients("highlevel", self.crm), self.crm, self.crm_rows)
        self.assertEqual(result["knownUnresolvedEffects"], 0)
        self.assertIsNone(result["uncertainEffects"])
        self.sql("UPDATE product_shipment_jobs SET outcome_unknown=true, status='retryable_failed' WHERE id='22222222-2222-4222-8222-222222222222';")
        changed = self.actual("chitchats", self.shipping)
        with self.assertRaisesRegex(ValueError, "DATABASE_SNAPSHOT_CHANGED"):
            component.observe_chitchats(*self.clients("chitchats", self.shipping), self.shipping, changed)
        self.rows = changed
        self.assertGreater(self.observe_shipping()["uncertainEffects"], 0)
        # Execute the source webhook's exact receipt/update transaction in the
        # migrated database. The initial reviewed artifact stays unchanged.
        self.sql("INSERT INTO highlevel_connections(location_id,credentials_ciphertext,expires_at,installed_by) VALUES ('ownedLocation','owned-fixture-ciphertext',now()+interval '1 day','44444444-4444-4444-8444-444444444444');")
        self.crm.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        self.crm_rows = self.actual("highlevel", self.crm)
        self.crm["databaseSnapshotSha256"] = component.snapshot_sha256(self.crm_rows)
        initial_review = deepcopy(self.crm)
        self.denied = False
        clients = self.clients("highlevel", self.crm, refresh=True)
        component.suspend("highlevel", *clients, self.crm, self.crm_rows, self.selected, self.attempt)
        original = (self.attempt / "highlevel-retirement-before.json").read_bytes()
        self.sql("BEGIN; INSERT INTO highlevel_webhook_receipts(key,location_id,event_type) VALUES ('owned-uninstall-receipt','ownedLocation','AppUninstall'); UPDATE highlevel_connections SET refresh_state='revoked', credentials_ciphertext='[revoked]', updated_at=now() WHERE location_id='ownedLocation'; COMMIT;")
        current = self.actual("highlevel", self.crm)
        self.assertTrue(current["connections"][0]["credentials_revoked"])
        self.denied = True
        verified = component.verify_retirement("highlevel", *clients, self.crm, current, self.selected, self.attempt)
        self.assertTrue(verified["retiredRefreshDenied"])
        self.assertEqual(verified["expectedDatabaseTransition"]["kind"], "source-AppUninstall-persistence")
        self.assertEqual(initial_review, self.crm)
        self.assertEqual(original, (self.attempt / "highlevel-retirement-before.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
