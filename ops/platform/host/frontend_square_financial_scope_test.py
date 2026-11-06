from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import threading
import unittest
from unittest.mock import patch
import urllib.parse

import frontend_square_financial_scope as component
import frontend_crm_shipping_retirement_test as existing_fixture
import vercel_test

TIME = "2026-05-10T10:00:00Z"
LATER = "2026-05-10T10:01:00Z"
BEGIN = "2020-01-01T00:00:00Z"
END = "2026-11-05T23:59:59Z"


def empty():
    return {name: [] for name in component.QUERIES}


def row(group, **values):
    result = {key: None for key in component.COLUMN_NAMES[group]}
    result.update({key: False for key in component.BOOLEAN_COLUMNS if key in result})
    result.update(id="owned-" + group, created_at=TIME)
    if "updated_at" in result:
        result["updated_at"] = TIME
    result.update(values)
    return result


def source():
    families = []
    for family in component.FAMILIES:
        families.append({"familyId": family, "sourceDisposition": "reachable",
            "configurationConditions": [{"requirementId": family + ".original-configuration"}],
            "sqlIntentRequirements": [{"requirementId": family + ".durable-intents"}],
            "untrackedPotentialRequests": [{"requirementId": family + ".accepted-request-completeness"}]})
    return {"version": 1, "status": "FRONTEND_HISTORICAL_SOURCE_VERIFIED", "sourceCommit": "b99d4f346696f897fa6a6729dfcc52d6503fe8d6",
        "sourceInventorySha256": "a" * 64, "requirementsSha256": "b" * 64,
        "providerFamilies": families, "sqlCredentialRequirements": [{"requirementId": "sql-credentials.DATABASE_URL"}], "capabilityClosures": []}


def closures(verified, except_families=()):
    verified["capabilityClosures"] = [{"familyId": family["familyId"], "disposition": "no-capability-observed",
        "requirementIds": [item["requirementId"] for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for item in family[key]] + ["sql-credentials.DATABASE_URL"],
        "evidenceIds": ["d" * 64]} for family in verified["providerFamilies"] if family["familyId"] not in except_families]
    return verified


def review(rows):
    return {"environment": "sandbox", "locationId": component.LOCATION, "apiVersion": component.API_VERSION,
        "merchantId": "owned-merchant", "applicationId": "sandbox-owned-application",
        "sourceBindingSha256": "c" * 64, "operationBeginTime": BEGIN, "observationEndTime": END,
        "operationLifetimeEvidenceIds": ["original-square-sandbox-capability-lifetime"],
        "databaseSnapshot": deepcopy(rows), "databaseSnapshotSha256": component.sha256(component.normalize_snapshot(rows))}


class MemoryClient:
    def __init__(self, provider=None):
        self.provider = provider or {name: {} for name in component.LISTS}
        self.calls, self.pages = [], {}
        self.mode = None
        self.payment_page_size = 100

    def request(self, method, path, body=None):
        self.calls.append((method, path, deepcopy(body)))
        url = urllib.parse.urlsplit(path)
        query = dict(urllib.parse.parse_qsl(url.query))
        if url.path == "/v2/locations/" + component.LOCATION:
            return {"location": {"id": component.LOCATION, "merchant_id": "owned-merchant", "currency": "CAD", "country": "CA", "status": "ACTIVE"}}
        if url.path == "/v2/orders/search":
            family = "orders"
            cursor = body.get("cursor")
        else:
            matches = [family for family, (root, _, _) in component.LISTS.items() if url.path == root]
            if not matches:
                for family, (root, _, _) in component.LISTS.items():
                    if family == "orders":
                        root = "/v2/orders"
                    if url.path.startswith(root + "/"):
                        identifier = urllib.parse.unquote(url.path[len(root) + 1:])
                        return {component.OBJECTS[family]: deepcopy(self.provider[family][identifier])}
                raise ValueError("OWNED_FIXTURE_UNKNOWN_REQUEST")
            family = matches[0]
            cursor = query.get("cursor")
        values = list(self.provider[family].values())
        page_size = self.payment_page_size if family == "payments" else component.LISTS[family][2]
        start = int(cursor or 0)
        selected = deepcopy(values[start:start + page_size])
        key = component.LISTS[family][1]
        result = {key: selected}
        if start + len(selected) < len(values):
            result["cursor"] = str(start + len(selected))
        if self.mode == "repeat-cursor" and selected:
            result["cursor"] = "0"
        elif self.mode == "duplicate" and selected:
            selected.append(selected[0])
        elif self.mode == "malformed-object":
            result[key] = [{"id": "private-email@example.test"}]
        elif self.mode == "empty-cursor":
            result = {key: [], "cursor": "private-cursor"}
        elif self.mode == "non-list":
            result[key] = {"private-email": "private-email@example.test"}
        return result


def payment(identifier="owned-payment", amount=100):
    return {"id": identifier, "location_id": component.LOCATION, "status": "COMPLETED", "created_at": TIME, "updated_at": TIME,
        "application_details": {"application_id": "sandbox-owned-application"},
        "amount_money": {"amount": amount, "currency": "CAD"}, "reference_id": "owned-hold-reference", "customer_id": "owned-customer"}


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.rows = empty()
        self.rows["attempts"] = [row("attempts", status="captured", operation="square_charge_and_store", provider_payment_id="owned-payment",
            amount_cents=100, currency="CAD", reference_id="owned-hold-reference", intent_reference_id="owned-hold-reference",
            intent_customer_id="owned-customer", intent_sha256="e" * 64, idempotency_sha256="f" * 64, captured_at=TIME)]
        self.rows["customers"] = [row("customers", provider_customer_id="owned-customer", email_sha256=hashlib.sha256(b"private-email@example.test").hexdigest())]
        self.client = MemoryClient()
        self.client.provider["payments"]["owned-payment"] = payment()
        self.client.provider["customers"]["owned-customer"] = {"id": "owned-customer", "created_at": TIME, "email_address": "private-email@example.test", "given_name": "private-buyer"}
        self.reviewed = review(self.rows)
        self.verified = closures(source())

    def observe(self):
        return component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)

    def test_nonempty_exact_join_and_source_principal_receipts(self):
        result = self.observe()
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertEqual(result["sourceInventorySha256"], "a" * 64)
        self.assertEqual(result["requirementsSha256"], "b" * 64)
        effect = next(item for item in result["effects"] if item["familyId"] == "square.payments")
        self.assertEqual(effect["sqlReceipts"][0]["intentSha256"], "e" * 64)
        self.assertEqual(effect["sqlReceipts"][0]["idempotencySha256"], "f" * 64)
        self.assertTrue(effect["immutableMatch"])
        self.assertEqual(result["beforeDatabaseSnapshotSha256"], self.reviewed["databaseSnapshotSha256"])
        self.assertNotIn("private-email", json.dumps(result))
        self.assertNotIn("private-buyer", json.dumps(result))
        self.assertFalse(result["trafficAuthorized"])

    def test_empty_lists_never_close_reachable_lost_ack_requirements(self):
        self.rows = empty()
        self.reviewed = review(self.rows)
        self.client = MemoryClient()
        self.verified = source()
        first, second = self.observe(), self.observe()
        for result in (first, second):
            self.assertIsNone(result["activeExecutions"])
            self.assertIsNone(result["uncertainEffects"])
            self.assertIn("square.customers.accepted-request-completeness", result["missingRequirementIds"])
            self.assertIn("square.payments.durable-intents", result["coveredRequirementIds"])
            self.assertIn("square.webhooks.durable-intents", result["missingRequirementIds"])
        self.assertEqual(first, second)

    def test_original_source_and_complete_sql_absence_need_no_square_client(self):
        self.rows = empty()
        self.reviewed = review(self.rows)
        self.reviewed.pop("merchantId")
        self.reviewed.pop("applicationId")
        self.verified = closures(source())
        self.assertTrue(component.source_inapplicable(self.reviewed, self.rows, self.verified))
        result = component.observe_scoped_effects(None, self.reviewed, self.rows, self.verified)
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertFalse(result["providerReadRequired"])
        self.assertIsNone(result["merchantId"])
        self.assertIsNone(result["applicationId"])
        self.assertEqual(result["effects"], [])
        self.verified["capabilityClosures"][0]["requirementIds"].remove("sql-credentials.DATABASE_URL")
        with self.assertRaisesRegex(ValueError, "COMPLETE_SOURCE_AND_CREDENTIAL"):
            component.source_inapplicable(self.reviewed, self.rows, self.verified)

    def test_lost_ack_sql_intent_is_uncertain_with_empty_provider_list(self):
        self.rows["attempts"][0].update(status="failed", provider_payment_id=None, captured_at=None)
        self.reviewed = review(self.rows)
        self.client.provider["payments"] = {}
        result = self.observe()
        self.assertEqual(result["knownUncertainEffects"], 1)
        self.assertEqual(result["unresolvedSql"][0]["recordKind"], "attempts")

    def test_money_reference_customer_status_and_original_payment_tampering(self):
        for field, value in (("amount_money", {"amount": 101, "currency": "CAD"}), ("reference_id", "another-reference"),
                ("customer_id", "another-customer"), ("status", "FAILED")):
            with self.subTest(field=field):
                previous = self.client.provider["payments"]["owned-payment"]
                self.client.provider["payments"]["owned-payment"] = {**payment(), field: value}
                result = self.observe()
                self.assertGreater(result["knownUncertainEffects"], 0)
                self.client.provider["payments"]["owned-payment"] = previous
        self.rows["refunds"] = [row("refunds", order_id="owned-order-record", status="succeeded", provider_refund_id="owned-refund", provider_payment_id="owned-payment",
            amount_cents=100, currency="CAD", idempotency_sha256="f" * 64, lease_held=False, outcome_unknown=False, attempt_count=1, succeeded_at=TIME)]
        self.client.provider["refunds"]["owned-refund"] = {"id": "owned-refund", "location_id": component.LOCATION,
            "payment_id": "wrong-payment", "status": "COMPLETED", "created_at": TIME, "amount_money": {"amount": 100, "currency": "CAD"}}
        self.reviewed = review(self.rows)
        result = self.observe()
        self.assertIn("original-payment-mismatch", next(item for item in result["effects"] if item["familyId"] == "square.refunds")["unresolvedReasons"])

    def test_partial_refund_matches_original_payment_without_comparing_different_amounts(self):
        self.rows["refunds"] = [row("refunds", order_id="owned-order-record", status="succeeded", provider_refund_id="owned-refund", provider_payment_id="owned-payment",
            amount_cents=25, currency="CAD", idempotency_sha256="f" * 64, lease_held=False, outcome_unknown=False, attempt_count=1, succeeded_at=TIME)]
        self.client.provider["refunds"]["owned-refund"] = {"id": "owned-refund", "location_id": component.LOCATION,
            "payment_id": "owned-payment", "status": "COMPLETED", "created_at": TIME, "amount_money": {"amount": 25, "currency": "CAD"}}
        self.reviewed = review(self.rows)
        result = self.observe()
        self.assertEqual(result["knownUncertainEffects"], 0)
        self.assertEqual(len([item for item in result["effects"] if item["familyId"] == "square.refunds"]), 1)

    def test_application_location_and_currency_are_exact_sandbox_boundaries(self):
        for field, value, error in (("location_id", "production-location", "LOCATION"), ("application_details", {"application_id": "wrong-app"}, "APPLICATION"),
                ("amount_money", {"amount": 100, "currency": "USD"}, "CAD")):
            with self.subTest(field=field):
                self.client.provider["payments"]["owned-payment"] = {**payment(), field: value}
                with self.assertRaisesRegex(ValueError, error):
                    self.observe()

    def test_unmatched_provider_objects_and_nonterminal_money_remain_uncertain(self):
        self.client.provider["payments"]["untracked-payment"] = payment("untracked-payment")
        self.client.provider["payments"]["owned-payment"]["status"] = "APPROVED"
        result = self.observe()
        self.assertEqual(result["knownActiveExecutions"], 1)
        self.assertGreaterEqual(result["knownUncertainEffects"], 2)
        self.assertIn("provider-object-without-durable-source-receipt", next(item for item in result["effects"] if item["providerId"] == "untracked-payment")["unresolvedReasons"])

    def test_exact_reads_include_stored_id_absent_from_eventually_consistent_list(self):
        original = self.client.request
        def request(method, path, body=None):
            result = original(method, path, body)
            if path.startswith("/v2/payments?"):
                return {"payments": []}
            return result
        self.client.request = request
        result = self.observe()
        self.assertEqual(result["knownUncertainEffects"], 0)
        self.assertTrue(any(call[1] == "/v2/payments/owned-payment" for call in self.client.calls))

    def test_complete_pagination_has_explicit_full_lifetime(self):
        self.client.payment_page_size = 1
        self.client.provider["payments"]["untracked-payment"] = payment("untracked-payment")
        self.observe()
        calls = [call for call in self.client.calls if call[1].startswith("/v2/payments?")]
        self.assertEqual(len(calls), 2)
        for call in calls:
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(call[1]).query))
            self.assertEqual((query["begin_time"], query["end_time"]), (BEGIN, END))
        self.assertEqual(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(calls[-1][1]).query))["cursor"], "1")

    def test_duplicate_malformed_and_truncated_pagination_fail_closed(self):
        for mode in ("repeat-cursor", "duplicate", "malformed-object", "empty-cursor", "non-list"):
            with self.subTest(mode=mode):
                self.client.mode = mode
                with self.assertRaises(ValueError):
                    self.observe()
        self.client.mode = None
        self.client.payment_page_size = 1
        self.client.provider["payments"]["another-payment"] = payment("another-payment")
        with patch.object(component, "MAX_PAGES", 1), self.assertRaisesRegex(ValueError, "PAGINATION_BOUND"):
            component._enumerate(self.client, self.reviewed, "payments")

    def test_sql_and_provider_times_cannot_escape_lifetime(self):
        self.reviewed["operationBeginTime"] = LATER
        with self.assertRaisesRegex(ValueError, "LIFETIME_EXCLUDES_SQL"):
            self.observe()
        self.reviewed["operationBeginTime"] = BEGIN
        self.client.provider["payments"]["owned-payment"]["created_at"] = "2019-01-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "LIFETIME_EXCLUDES_PROVIDER"):
            self.observe()

    def test_all_optional_families_have_exact_reads_and_safe_private_projections(self):
        self.rows["orders"] = [row("orders", reference_id="owned-public-order-reference", status="paid", initialization_status="ready", provider_checkout_id="owned-invoice",
            provider_order_id="owned-order", amount_cents=100, currency="CAD", flow="training_square_invoice", correlation_id="owned-correlation",
            customer_id="owned-customer", provider_status="paid", invoice_version="1")]
        self.rows["cards"] = [row("cards", provider_card_id="ccof:owned-card", customer_id="owned-customer", status="active")]
        self.rows["holds"] = [row("holds", reference_id="owned-hold-reference", status="booked", booking_model_version=1,
            square_payment_link_id="owned-link", provider_order_id="owned-order", lease_held=False)]
        self.client.provider["cards"]["ccof:owned-card"] = {"id": "ccof:owned-card", "customer_id": "owned-customer", "enabled": True, "last_4": "1234", "cardholder_name": "private-cardholder"}
        self.client.provider["orders"]["owned-order"] = {"id": "owned-order", "location_id": component.LOCATION, "reference_id": "owned-correlation",
            "state": "COMPLETED", "created_at": TIME, "total_money": {"amount": 100, "currency": "CAD"}}
        self.client.provider["invoices"]["owned-invoice"] = {"id": "owned-invoice", "location_id": component.LOCATION, "order_id": "owned-order",
            "status": "PAID", "version": 1, "primary_recipient": {"customer_id": "owned-customer", "email_address": "private-email@example.test"}, "public_url": "https://private.example.test/bearer"}
        self.client.provider["checkout"]["owned-link"] = {"id": "owned-link", "order_id": "owned-order", "url": "https://private.example.test/bearer"}
        self.reviewed = review(self.rows)
        result = self.observe()
        self.assertTrue(any(call[1] == "/v2/cards/ccof%3Aowned-card" for call in self.client.calls))
        self.assertTrue(any(call[0] == "POST" and call[1] == "/v2/orders/search" for call in self.client.calls))
        self.assertIn("hosted-checkout-acceptance-capability-unresolved", next(item for item in result["effects"] if item["familyId"] == "square.checkout")["unresolvedReasons"])
        output = json.dumps(result)
        for marker in ("private-cardholder", "private-email", "private.example", "1234"):
            self.assertNotIn(marker, output)

    def test_source_forgery_missing_families_and_receipt_flags_are_refused(self):
        for mutate in (lambda value: value.update(status="verified-by-caller"), lambda value: value["providerFamilies"].pop(),
                lambda value: value["capabilityClosures"][0].update(evidenceIds=[])):
            original = deepcopy(self.verified)
            mutate(self.verified)
            with self.assertRaises(ValueError):
                self.observe()
            self.verified = original
        self.verified = source()
        self.reviewed["complete"] = True
        result = self.observe()
        self.assertIsNone(result["uncertainEffects"])

    def test_prestate_and_unreceipted_state_changes_remain_visible(self):
        original = self.reviewed["databaseSnapshotSha256"]
        self.rows["attempts"][0]["updated_at"] = LATER
        result = self.observe()
        self.assertTrue(result["databaseSnapshotChangedWithoutReceipt"])
        self.assertEqual(result["beforeDatabaseSnapshotSha256"], original)
        self.assertGreater(result["knownUncertainEffects"], 0)
        self.reviewed["databaseSnapshot"]["attempts"][0]["amount_cents"] = 101
        with self.assertRaisesRegex(ValueError, "IMMUTABLE_PRESTATE"):
            self.observe()

    def test_bounded_callback_advance_requires_exact_sql_and_provider_receipts(self):
        self.reviewed["databaseSnapshot"]["attempts"][0].update(status="pending", provider_payment_id=None, captured_at=None)
        self.reviewed["databaseSnapshotSha256"] = component.sha256(self.reviewed["databaseSnapshot"])
        self.rows["events"] = [row("events", provider_event_id="owned-event", provider_payment_id="owned-payment", provider_status="COMPLETED",
            amount_cents=100, currency="CAD", event_type="payment.updated", payload_hash="d" * 64, processing_status="processed", processed_at=LATER)]
        result = self.observe()
        self.assertTrue(result["callbackAdvanceVerified"])
        self.assertFalse(result["databaseSnapshotChangedWithoutReceipt"])
        self.rows["events"][0]["amount_cents"] = 101
        result = self.observe()
        self.assertFalse(result["callbackAdvanceVerified"])
        self.assertTrue(result["databaseSnapshotChangedWithoutReceipt"])

    def test_existing_received_callback_can_finish_without_replacing_original_prestate(self):
        self.rows["events"] = [row("events", provider_event_id="owned-event", provider_payment_id="owned-payment", provider_status="COMPLETED",
            amount_cents=100, currency="CAD", event_type="payment.updated", payload_hash="d" * 64, processing_status="received")]
        self.reviewed = review(self.rows)
        original = self.reviewed["databaseSnapshotSha256"]
        self.rows["events"][0].update(processing_status="processed", processed_at=LATER)
        result = self.observe()
        self.assertTrue(result["callbackAdvanceVerified"])
        self.assertEqual(result["beforeDatabaseSnapshotSha256"], original)
        self.assertEqual(result["knownUncertainEffects"], 0)
        self.rows["events"][0]["payload_hash"] = "e" * 64
        result = self.observe()
        self.assertFalse(result["callbackAdvanceVerified"])

    def test_fixed_selects_closed_columns_bounds_and_pii_refusal(self):
        for _, sql, params in component.database_queries(self.reviewed):
            self.assertTrue(sql.startswith("SELECT "))
            self.assertTrue(sql.endswith("LIMIT 4097"))
            self.assertEqual(params, [])
            self.assertNotIn("SELECT *", sql)
        self.rows["attempts"][0]["private_token"] = "private-token"
        with self.assertRaisesRegex(ValueError, "COLUMNS"):
            component.normalize_snapshot(self.rows)
        self.rows["attempts"][0].pop("private_token")
        self.rows["attempts"] *= 4097
        with self.assertRaisesRegex(ValueError, "BOUND"):
            component.normalize_snapshot(self.rows)

    def test_new_webhook_pending_and_split_work_remain_uncertain(self):
        self.rows["events"] = [row("events", event_type="payment.updated", provider_event_id="owned-event", processing_status="received")]
        self.rows["holds"] = [row("holds", reference_id="owned-stale-hold", status="held", booking_model_version=1,
            confirmation_in_progress=True)]
        self.reviewed = review(self.rows)
        result = self.observe()
        self.assertEqual({item["recordKind"] for item in result["unresolvedSql"]}, {"holds", "events"})
        self.assertGreaterEqual(result["knownUncertainEffects"], 2)

    def test_database_null_boolean_money_and_duplicate_rows_are_refused(self):
        for field, value in (("amount_cents", True), ("amount_cents", None), ("idempotency_sha256", "private-token")):
            with self.subTest(field=field, value=value):
                selected = deepcopy(self.rows)
                selected["attempts"][0][field] = value
                with self.assertRaises(ValueError):
                    component.normalize_snapshot(selected)
        self.rows["customers"].append(deepcopy(self.rows["customers"][0]))
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            component.normalize_snapshot(self.rows)

    def test_read_only_allowlist_refuses_mutations_wrong_scope_and_search_additions(self):
        self.assertTrue(component.read_only_request("GET", "/v2/cards/ccof%3Aowned-card", None, self.reviewed))
        self.assertFalse(component.read_only_request("GET", "/v2/cards/ccof:owned-card", None, self.reviewed))
        for method, path, body in (("POST", "/v2/payments", {}), ("PUT", "/v2/invoices/owned-invoice", {}),
                ("DELETE", "/v2/online-checkout/payment-links/owned-link", None), ("GET", "https://connect.squareup.com/v2/payments", None),
                ("GET", "/v2/payments?limit=100", None), ("GET", "/v2/cards?include_disabled=false&sort_order=ASC", None)):
            self.assertFalse(component.read_only_request(method, path, body, self.reviewed))
        component._enumerate(self.client, self.reviewed, "orders")
        body = next(call[2] for call in self.client.calls if call[0] == "POST")
        self.assertTrue(component.read_only_request("POST", "/v2/orders/search", body, self.reviewed))
        body["location_ids"].append("production-location")
        self.assertFalse(component.read_only_request("POST", "/v2/orders/search", body, self.reviewed))
        self.reviewed["environment"] = "production"
        self.assertFalse(component.read_only_request("GET", "/v2/cards/ccof%3Aowned-card", None, self.reviewed))


TRANSPORT_PATH = Path(os.environ.get("FRONTEND_SCOPED_PROVIDER_CLIENT_PATH", str(Path(__file__).with_name("frontend_scoped_provider_client.py"))))


@unittest.skipUnless(TRANSPORT_PATH.is_file(), "integration owner's fixed read-only transport required")
class HttpsScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()
        spec = importlib.util.spec_from_file_location("square_financial_owned_transport", TRANSPORT_PATH)
        cls.transport = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.transport)

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.rows, self.calls, self.mode = empty(), [], None
        self.reviewed = review(self.rows)
        self.verified = source()
        self.memory = MemoryClient()
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.calls.append((self.command, self.path))
                owner.assertEqual(self.headers.get("Square-Version"), component.API_VERSION)
                if owner.mode in ("401", "403", "429"):
                    self.send_response(int(owner.mode)); self.end_headers(); self.wfile.write(b"private-error-token"); return
                if owner.mode == "redirect":
                    self.send_response(302); self.send_header("Location", "https://connect.squareup.com/v2/payments"); self.end_headers(); return
                if owner.mode == "invalid":
                    self.send_response(200); self.end_headers(); self.wfile.write(b"private-provider-body"); return
                body = json.loads(raw) if raw else None
                if self.path == "/v2/orders/search":
                    owner.assertEqual(body["location_ids"], [component.LOCATION])
                value = owner.memory.request(self.command, self.path, body)
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(value).encode())

            do_POST = do_GET
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        ca = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        self.patches = [patch.dict(self.transport.ORIGINS, {"square": f"https://127.0.0.1:{self.server.server_port}"}),
            patch.object(self.transport.ssl, "create_default_context", return_value=ca)]
        for item in self.patches:
            item.start()
        self.client = self.transport.Client("square", "owned-private-token", self.reviewed, component.read_only_request)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def test_actual_https_owned_primary_routes_and_readonly_search(self):
        result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
        self.assertIsNone(result["uncertainEffects"])
        self.assertEqual(len(self.calls), 8)
        self.assertEqual([call for call in self.calls if call[0] != "GET"], [("POST", "/v2/orders/search")])
        before = len(self.calls)
        with self.assertRaises(ValueError):
            self.client.request("POST", "/v2/payments", {})
        self.assertEqual(len(self.calls), before)

    def test_actual_https_errors_and_redirects_are_sanitized_unknowns(self):
        for mode in ("401", "403", "429", "redirect", "invalid"):
            with self.subTest(mode=mode):
                self.mode = mode
                with self.assertRaises(ValueError) as caught:
                    component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
                self.assertNotIn("private-", str(caught.exception))

    def invoice_scope(self):
        self.rows = empty()
        self.rows["orders"] = [row("orders", reference_id="owned-public-order-reference", status="paid", provider_status="paid",
            initialization_status="ready", provider_checkout_id="owned-invoice", provider_order_id="owned-order", amount_cents=100,
            currency="CAD", flow="training_square_invoice", correlation_id="owned-correlation", customer_id="owned-customer", invoice_version="1")]
        self.memory.provider["customers"]["owned-customer"] = {"id": "owned-customer"}
        self.memory.provider["orders"]["owned-order"] = {"id": "owned-order", "location_id": component.LOCATION,
            "reference_id": "owned-correlation", "state": "COMPLETED", "created_at": TIME, "total_money": {"amount": 100, "currency": "CAD"}}
        self.memory.provider["invoices"]["owned-invoice"] = {"id": "owned-invoice", "location_id": component.LOCATION,
            "order_id": "owned-order", "status": "PAID", "version": 1, "primary_recipient": {"customer_id": "owned-customer"}}
        self.reviewed, self.verified = review(self.rows), closures(source())
        self.client.reviewed = self.reviewed

    def test_actual_https_paid_invoice_receipt_cannot_match_draft_unpaid_or_pending_provider_state(self):
        self.invoice_scope()
        baseline = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
        self.assertEqual((baseline["activeExecutions"], baseline["uncertainEffects"]), (0, 0))
        for state in ("DRAFT", "UNPAID", "SCHEDULED", "PAYMENT_PENDING", "PARTIALLY_PAID"):
            with self.subTest(state=state):
                self.memory.provider["invoices"]["owned-invoice"]["status"] = state
                result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
                invoice = next(item for item in result["effects"] if item["familyId"] == "square.invoices")
                self.assertFalse(invoice["immutableMatch"])
                self.assertIn("database-invoice-provider-status-mismatch", invoice["unresolvedReasons"])
                self.assertIn("database-invoice-order-status-mismatch", invoice["unresolvedReasons"])
                self.assertGreater(result["activeExecutions"], 0)
                self.assertGreater(result["uncertainEffects"], 0)

    def test_actual_https_paid_or_cancelled_order_and_invoice_status_mismatches_refuse_zero(self):
        self.invoice_scope()
        for state in ("OPEN", "DRAFT", "CANCELED"):
            with self.subTest(state=state):
                self.memory.provider["orders"]["owned-order"]["state"] = state
                result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
                order = next(item for item in result["effects"] if item["familyId"] == "square.orders")
                self.assertIn("database-provider-order-status-mismatch", order["unresolvedReasons"])
                self.assertGreater(result["uncertainEffects"], 0)
        self.memory.provider["orders"]["owned-order"]["state"] = "COMPLETED"
        self.rows["orders"][0].update(status="cancelled", provider_status="cancelled")
        self.reviewed = review(self.rows); self.client.reviewed = self.reviewed
        result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
        self.assertGreater(result["uncertainEffects"], 0)

    def test_actual_https_no_show_payment_and_invoice_webhook_success_both_reconcile(self):
        for event_type, stored_status in (("payment.updated", "COMPLETED"), ("invoice.payment_made", "PAID")):
            with self.subTest(event_type=event_type):
                self.rows = empty()
                self.rows["noShowRecords"] = [row("noShowRecords", hold_id="owned-hold", status="charged",
                    provider_status=stored_status, invoice_id="owned-invoice", provider_order_id="owned-order",
                    provider_payment_id="owned-payment", amount_cents=100, currency="CAD", customer_id="owned-customer")]
                self.rows["noShowAttempts"] = [row("noShowAttempts", no_show_charge_record_id="owned-noShowRecords",
                    status="charged", provider_payment_id="owned-payment", invoice_id="owned-invoice",
                    amount_cents=100, currency="CAD", processed_at=TIME)]
                self.memory.provider["customers"]["owned-customer"] = {"id": "owned-customer"}
                self.memory.provider["orders"]["owned-order"] = {"id": "owned-order", "location_id": component.LOCATION,
                    "reference_id": "owned-hold", "state": "COMPLETED", "created_at": TIME,
                    "total_money": {"amount": 100, "currency": "CAD"}}
                self.memory.provider["payments"]["owned-payment"] = {"id": "owned-payment", "location_id": component.LOCATION,
                    "order_id": "owned-order", "customer_id": "owned-customer", "status": "COMPLETED", "created_at": TIME,
                    "application_details": {"application_id": "sandbox-owned-application"},
                    "amount_money": {"amount": 100, "currency": "CAD"}}
                self.memory.provider["invoices"]["owned-invoice"] = {"id": "owned-invoice", "location_id": component.LOCATION,
                    "order_id": "owned-order", "status": "PAID", "version": 1, "primary_recipient": {"customer_id": "owned-customer"}}
                self.reviewed, self.verified = review(self.rows), closures(source())
                self.client.reviewed = self.reviewed
                result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
                self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0), result)
                self.assertTrue(all(effect["immutableMatch"] for effect in result["effects"]))
                for denied_status in ("FAILED", "CANCELED"):
                    self.memory.provider["payments"]["owned-payment"]["status"] = denied_status
                    refused = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
                    payment = next(effect for effect in refused["effects"] if effect["familyId"] == "square.payments")
                    self.assertIn("database-provider-outcome-mismatch", payment["unresolvedReasons"])
                    self.assertGreater(refused["uncertainEffects"], 0)
                self.memory.provider["payments"]["owned-payment"]["status"] = "COMPLETED"

    def test_stored_legacy_and_no_show_invoice_states_are_compared_with_the_actual_provider(self):
        self.invoice_scope()
        provider = component._provider_summary("invoices", self.memory.provider["invoices"]["owned-invoice"], self.reviewed)
        for group, values in (("holds", {"reference_id": "owned-hold", "status": "booked", "booking_model_version": 1,
                "invoice_id": "owned-invoice", "invoice_order_id": "owned-order", "no_show_invoice_status": "CANCELED"}),
            ("noShowRecords", {"hold_id": "owned-hold", "status": "charge_failed", "provider_status": "FAILED", "amount_cents": 100,
                "currency": "CAD", "invoice_id": "owned-invoice", "provider_order_id": "owned-order"})):
            with self.subTest(group=group):
                stored = row(group, **values)
                _joins, reasons = component._join("invoices", provider, [(group, stored, "invoice_id")], self.rows)
                self.assertIn("database-invoice-provider-status-mismatch", reasons)

    def test_actual_https_nonempty_financial_and_private_customer_receipts(self):
        self.rows["attempts"] = [row("attempts", status="captured", operation="square_charge_and_store", provider_payment_id="owned-payment",
            amount_cents=100, currency="CAD", intent_reference_id="owned-hold-reference", intent_customer_id="owned-customer",
            intent_sha256="e" * 64, idempotency_sha256="f" * 64, captured_at=TIME)]
        self.rows["customers"] = [row("customers", provider_customer_id="owned-customer", email_sha256=hashlib.sha256(b"private-email@example.test").hexdigest())]
        self.memory.provider["payments"]["owned-payment"] = payment()
        self.memory.provider["customers"]["owned-customer"] = {"id": "owned-customer", "email_address": "private-email@example.test", "given_name": "private-name"}
        self.reviewed = review(self.rows)
        self.client.reviewed = self.reviewed
        result = component.observe_scoped_effects(self.client, self.reviewed, self.rows, self.verified)
        self.assertEqual(result["knownUncertainEffects"], 0)
        self.assertIsNone(result["uncertainEffects"])
        self.assertIn(("GET", "/v2/payments/owned-payment"), self.calls)
        self.assertIn(("GET", "/v2/customers/owned-customer"), self.calls)
        self.assertNotIn("private-email", json.dumps(result))
        self.assertNotIn("private-name", json.dumps(result))


@unittest.skipUnless(os.environ.get("FRONTEND_SQUARE_FINANCIAL_POSTGRES_TEST") == "true", "explicit owned disposable PostgreSQL16 fixture only")
class DatabaseScopeTests(unittest.TestCase):
    """Reuse fixture infrastructure only; apply every repository migration."""
    setUpClass = classmethod(existing_fixture.DatabaseRetirementTests.setUpClass.__func__)
    cleanup_cluster = classmethod(existing_fixture.DatabaseRetirementTests.cleanup_cluster.__func__)
    sql = classmethod(existing_fixture.DatabaseRetirementTests.sql.__func__)

    def actual(self):
        statements = []
        for name, sql, params in component.database_queries(review(empty())):
            self.assertEqual(params, [])
            statements.append(f"'{name}',(SELECT coalesce(json_agg(row_to_json(r)),'[]'::json) FROM ({sql}) r)")
        output = self.sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object(" + ",".join(statements) + ");\nCOMMIT;")
        return component.normalize_snapshot(json.loads(next(line for line in output.splitlines() if line.startswith("{"))))

    def test_all_migrations_actual_fixed_sql_and_nonempty_financial_joins(self):
        self.assertEqual(self.migration_count, 83)
        actual = self.actual()
        self.assertEqual(actual, empty())
        self.sql("""INSERT INTO booking_payment_attempts(id,operation,status,payment_provider,idempotency_key,provider_payment_id,amount_cents,currency,provider_metadata,created_at,updated_at,captured_at)
          VALUES ('11111111-1111-4111-8111-111111111111','square_charge_and_store','captured','square','private-idempotency','owned-payment',100,'CAD',
          '{"squareRequestIntent":{"referenceId":"owned-hold-reference","requestBodyHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","squareCustomerId":"owned-customer"}}',
          '2026-05-10T10:00:00Z','2026-05-10T10:00:00Z','2026-05-10T10:00:00Z');
          INSERT INTO booking_square_customers(id,email_normalized,customer_name,square_customer_id,created_at,updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222','private-email@example.test','private-buyer','owned-customer','2026-05-10T10:00:00Z','2026-05-10T10:00:00Z');
          INSERT INTO booking_saved_payment_methods(id,customer_id,square_card_id,card_last4,created_at,updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','ccof:owned-card','1234','2026-05-10T10:00:00Z','2026-05-10T10:00:00Z');""")
        actual = self.actual()
        self.assertEqual(len(actual["attempts"]), 1)
        self.assertEqual(actual["attempts"][0]["intent_sha256"], "e" * 64)
        self.assertEqual(actual["attempts"][0]["idempotency_sha256"], hashlib.sha256(b"private-idempotency").hexdigest())
        output = json.dumps(actual)
        for marker in ("private-idempotency", "private-email", "private-buyer", "1234"):
            self.assertNotIn(marker, output)
        client = MemoryClient()
        client.provider["payments"]["owned-payment"] = payment()
        client.provider["customers"]["owned-customer"] = {"id": "owned-customer", "email_address": "private-email@example.test"}
        client.provider["cards"]["ccof:owned-card"] = {"id": "ccof:owned-card", "customer_id": "owned-customer", "enabled": True}
        reviewed = review(actual)
        result = component.observe_scoped_effects(client, reviewed, actual, closures(source()))
        self.assertEqual(result["uncertainEffects"], 0)
        self.sql("UPDATE booking_payment_attempts SET status='failed' WHERE provider_payment_id='owned-payment';")
        changed = self.actual()
        result = component.observe_scoped_effects(client, reviewed, changed, closures(source()))
        self.assertGreater(result["knownUncertainEffects"], 0)
        self.assertTrue(result["databaseSnapshotChangedWithoutReceipt"])
        self.sql("UPDATE booking_payment_attempts SET status='pending',provider_payment_id=null,captured_at=null;")
        before_callback = self.actual()
        original_review = review(before_callback)
        self.sql("""UPDATE booking_payment_attempts SET status='captured',provider_payment_id='owned-payment',captured_at='2026-05-10T10:01:00Z',updated_at='2026-05-10T10:01:00Z';
          INSERT INTO checkout_payment_events(id,payment_provider,event_type,provider_event_id,provider_payment_id,provider_status,amount_cents,currency,payload_hash,processing_status,processed_at,created_at)
          VALUES ('44444444-4444-4444-8444-444444444444','square','payment.updated','owned-event','owned-payment','COMPLETED',100,'CAD',repeat('d',64),'processed','2026-05-10T10:01:00Z','2026-05-10T10:01:00Z');""")
        result = component.observe_scoped_effects(client, original_review, self.actual(), closures(source()))
        self.assertTrue(result["callbackAdvanceVerified"])
        self.assertEqual(result["beforeDatabaseSnapshotSha256"], original_review["databaseSnapshotSha256"])
        self.assertEqual(result["knownUncertainEffects"], 0)


if __name__ == "__main__":
    unittest.main()
