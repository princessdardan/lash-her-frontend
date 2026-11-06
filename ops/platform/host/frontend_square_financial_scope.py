"""Read-only, bounded Square sandbox financial scope reconciliation.

The caller owns the authenticated, fixed-origin LockedClient, original runtime
configuration/source proof, credential fencing, and database transaction. This
module never resolves credentials, opens a connection, or mutates a provider.
An empty/eventually consistent list is not proof against an untracked request.
"""
from datetime import datetime
import hashlib
import json
import re
import urllib.parse

import migrate

demand = migrate.demand
LOCATION = "LE2H76M5V90AM"
API_VERSION = "2026-05-20"
MAX_ROWS = 4096
MAX_PAGES = 128
FAMILIES = tuple("square." + name for name in (
    "payments", "refunds", "orders", "customers", "cards", "invoices", "checkout", "webhooks"))
ID = re.compile(r"[A-Za-z0-9_:-]{1,192}\Z")
SAFE = re.compile(r"[A-Za-z0-9_.:/-]{1,256}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")


def sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
        ensure_ascii=True, allow_nan=False).encode()).hexdigest()


snapshot_sha256 = sha256


def _time(value):
    demand(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+]00(?::00)?)", value), "SQUARE_TIMESTAMP_REFUSED")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    demand(parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0, "SQUARE_TIMESTAMP_REFUSED")
    return parsed


def _id(value):
    demand(isinstance(value, str) and ID.fullmatch(value), "SQUARE_IDENTIFIER_REFUSED")
    return value


def _safe(value):
    demand(isinstance(value, str) and SAFE.fullmatch(value), "SQUARE_SAFE_REFERENCE_REFUSED")
    return value


def _review(reviewed, principals=False):
    demand(isinstance(reviewed, dict) and reviewed.get("environment") == "sandbox" and
        reviewed.get("locationId") == LOCATION and reviewed.get("apiVersion") == API_VERSION,
        "SQUARE_SANDBOX_FINANCIAL_SCOPE_REQUIRED")
    for field in ("merchantId", "applicationId"):
        if principals or reviewed.get(field) is not None:
            _id(reviewed.get(field))
    for field in ("sourceBindingSha256", "databaseSnapshotSha256"):
        demand(isinstance(reviewed.get(field), str) and HASH.fullmatch(reviewed[field]), "SQUARE_REVIEW_DIGEST_REQUIRED")
    begin, end = _time(reviewed.get("operationBeginTime")), _time(reviewed.get("observationEndTime"))
    demand(begin < end, "SQUARE_EXPLICIT_OPERATION_LIFETIME_REQUIRED")
    evidence = reviewed.get("operationLifetimeEvidenceIds")
    demand(isinstance(evidence, list) and evidence and len(evidence) <= 128 and len(set(evidence)) == len(evidence),
        "SQUARE_OPERATION_LIFETIME_EVIDENCE_REQUIRED")
    for item in evidence:
        _safe(item)
    return begin, end


# Every SELECT projects a closed, non-PII schema; no free-form metadata, request
# token, address, buyer name, card details, callback URL, or error is selected.
# LIMIT is a refusal sentinel, never a claim that the first N rows are complete.
QUERIES = {
    "orders": """SELECT id::text, order_id AS reference_id, status::text, initialization_status::text,
      provider_checkout_id, provider_order_id, provider_payment_id, provider_status,
      square_payment_link_id, square_location_id, amount_cents, currency,
      provider_metadata->>'flow' AS flow,
      provider_metadata->>'correlationId' AS correlation_id,
      provider_metadata->>'squareCustomerId' AS customer_id,
      provider_metadata->>'squareInvoiceVersion' AS invoice_version,
      provider_metadata->'splitPayment'->>'stage' AS split_stage,
      provider_metadata->'splitPayment'->>'cardPaymentId' AS split_card_payment_id,
      provider_metadata->'splitPayment'->>'afterpayPaymentId' AS split_afterpay_payment_id,
      provider_metadata->'splitPayment'->>'squareOrderId' AS split_order_id,
      provider_metadata->'splitPayment'->>'cardAmountCents' AS split_card_amount_cents,
      provider_metadata->'splitPayment'->>'afterpayAmountCents' AS split_afterpay_amount_cents,
      created_at::text, updated_at::text FROM checkout_orders WHERE payment_provider='square' ORDER BY id LIMIT 4097""",
    "obligations": """SELECT p.id::text, p.order_id::text, p.status::text, p.initialization_status::text,
      p.provider_checkout_id, p.total_amount_cents AS amount_cents, p.currency,
      encode(sha256(convert_to(p.idempotency_key,'UTF8')),'hex') AS idempotency_sha256,
      p.initialization_payload_hash AS intent_sha256, p.initialization_outcome,
      (p.initialization_lease_owner IS NOT NULL OR p.initialization_lease_expires_at IS NOT NULL) AS lease_held,
      p.initialization_attempt_count AS attempt_count, p.source_workflow,
      p.created_at::text,p.updated_at::text FROM order_payment_obligations p
      WHERE p.payment_provider='square' ORDER BY p.id LIMIT 4097""",
    "transactions": """SELECT t.id::text,t.obligation_id::text,t.provider_transaction_id AS provider_payment_id,
      t.amount_cents,t.currency,t.provider_status,t.provider_type,t.created_at::text,
      t.captured_at::text FROM order_payment_transactions t WHERE t.provider='square' ORDER BY t.id LIMIT 4097""",
    "refunds": """SELECT r.id::text,r.order_id::text,r.status::text,r.provider_refund_id,
      r.original_transaction_id AS provider_payment_id,r.amount_cents,o.currency,
      encode(sha256(convert_to(r.idempotency_key::text,'UTF8')),'hex') AS idempotency_sha256,
      (r.lease_owner IS NOT NULL OR r.lease_expires_at IS NOT NULL) AS lease_held,
      (r.unknown_outcome_at IS NOT NULL) AS outcome_unknown,r.attempt_count,
      r.created_at::text,r.updated_at::text,r.succeeded_at::text
      FROM product_order_refunds r JOIN checkout_orders o ON o.id=r.order_id
      WHERE o.payment_provider='square' ORDER BY r.id LIMIT 4097""",
    "holds": """SELECT id::text,public_reference AS reference_id,status::text,
      checkout_order_id::text,booking_model_version,square_payment_id AS provider_payment_id,
      square_order_id AS provider_order_id,square_payment_link_id,square_checkout_id,
      square_customer_id AS customer_id,square_card_id AS card_id,card_on_file_status,
      no_show_invoice_id AS invoice_id,no_show_invoice_order_id AS invoice_order_id,no_show_invoice_status,
      (capture_lease_id IS NOT NULL OR capture_lease_expires_at IS NOT NULL) AS lease_held,
      (coalesce(jsonb_typeof(reconciliation_metadata->'cardOnFileInProgress')='object',false)
        OR coalesce(jsonb_typeof(reconciliation_metadata->'chargeAndStoreInProgress')='object',false)) AS confirmation_in_progress,
      reconciliation_metadata->'cardOnFileProgress'->>'squareCustomerId' AS checkpoint_customer_id,
      reconciliation_metadata->'cardOnFileProgress'->>'squareCardId' AS checkpoint_card_id,
      created_at::text,updated_at::text FROM appointment_holds WHERE payment_provider='square' ORDER BY id LIMIT 4097""",
    "attempts": """SELECT a.id::text,a.hold_id::text,a.checkout_order_id::text,a.operation,a.status::text,
      encode(sha256(convert_to(a.idempotency_key,'UTF8')),'hex') AS idempotency_sha256,
      a.provider_payment_id,a.provider_order_id,a.amount_cents,a.currency,
      a.provider_metadata->'squareRequestIntent'->>'requestBodyHash' AS intent_sha256,
      a.provider_metadata->'squareRequestIntent'->>'referenceId' AS intent_reference_id,
      a.provider_metadata->'squareRequestIntent'->>'squareCustomerId' AS intent_customer_id,
      h.public_reference AS reference_id,a.created_at::text,a.updated_at::text,a.captured_at::text
      FROM booking_payment_attempts a LEFT JOIN appointment_holds h ON h.id=a.hold_id
      WHERE a.payment_provider='square' ORDER BY a.id LIMIT 4097""",
    "customers": """SELECT id::text,square_customer_id AS provider_customer_id,
      encode(sha256(convert_to(lower(trim(email_normalized)),'UTF8')),'hex') AS email_sha256,
      created_at::text,updated_at::text FROM booking_square_customers ORDER BY id LIMIT 4097""",
    "cards": """SELECT c.id::text,c.square_card_id AS provider_card_id,
      b.square_customer_id AS customer_id,c.status::text,c.created_at::text,c.updated_at::text
      FROM booking_saved_payment_methods c JOIN booking_square_customers b ON b.id=c.customer_id
      ORDER BY c.id LIMIT 4097""",
    "noShowRecords": """SELECT id::text,hold_id::text,status::text,provider_status,
      square_customer_id AS customer_id,square_card_id AS card_id,square_invoice_id AS invoice_id,
      square_order_id AS provider_order_id,square_payment_id AS provider_payment_id,
      coalesce((provider_metadata->'amountSnapshot'->>'remainingBalanceWithTaxCents')::bigint,
        (provider_metadata->'amountSnapshot'->>'remainingBalanceCents')::bigint,max_charge_cents) AS amount_cents,currency,
      provider_metadata->>'squareInvoiceVersion' AS invoice_version,
      created_at::text,updated_at::text FROM booking_no_show_charge_records ORDER BY id LIMIT 4097""",
    "noShowAttempts": """SELECT id::text,no_show_charge_record_id::text,status,
      encode(sha256(convert_to(idempotency_key,'UTF8')),'hex') AS idempotency_sha256,
      amount_cents,currency,square_payment_id AS provider_payment_id,square_invoice_id AS invoice_id,
      created_at::text,processed_at::text FROM booking_no_show_charge_attempts ORDER BY id LIMIT 4097""",
    "events": """SELECT id::text,order_id::text,no_show_charge_record_id::text,event_type,
      provider_event_id,provider_checkout_id,provider_order_id,provider_payment_id,
      status,provider_status,amount_cents,currency,payload_hash,
      encode(sha256(convert_to(idempotency_key,'UTF8')),'hex') AS idempotency_sha256,
      processing_status::text,created_at::text,processed_at::text
      FROM checkout_payment_events WHERE payment_provider='square' ORDER BY id LIMIT 4097""",
    "refundEvents": """SELECT id::text,provider_event_id,square_refund_id AS provider_refund_id,
      square_payment_id AS provider_payment_id,status,amount_cents,currency,
      occurred_at::text,created_at::text FROM square_payment_refund_events ORDER BY id LIMIT 4097""",
}


def database_queries(reviewed):
    _review(reviewed)
    return [(name, sql, []) for name, sql in QUERIES.items()]


def normalize_snapshot(rows):
    demand(isinstance(rows, dict) and set(rows) == set(QUERIES), "SQUARE_COMPLETE_DATABASE_PROJECTIONS_REQUIRED")
    result = {}
    for name, items in rows.items():
        demand(isinstance(items, list) and len(items) <= MAX_ROWS, "SQUARE_DATABASE_SCOPE_BOUND_EXCEEDED")
        seen, clean = set(), []
        for item in items:
            demand(isinstance(item, dict), "SQUARE_DATABASE_ROW_REFUSED")
            # Column names are extracted from the same fixed SELECT in tests;
            # reject unknown columns here rather than publishing their values.
            allowed = COLUMN_NAMES[name]
            demand(set(item) == allowed, "SQUARE_DATABASE_COLUMNS_REFUSED")
            row = {}
            for key, value in item.items():
                demand(value is not None or key not in REQUIRED_COLUMNS[name], "SQUARE_DATABASE_REQUIRED_COLUMN_NULL")
                if key in BOOLEAN_COLUMNS:
                    demand(type(value) is bool, "SQUARE_DATABASE_BOOLEAN_REFUSED")
                elif value is None:
                    pass
                elif key.endswith("_sha256") or key == "payload_hash":
                    demand(isinstance(value, str) and HASH.fullmatch(value), "SQUARE_DATABASE_DIGEST_REFUSED")
                elif key.endswith("_at"):
                    _time(value)
                elif key in INTEGER_COLUMNS:
                    demand(type(value) is int and 0 <= value <= 9_007_199_254_740_991, "SQUARE_DATABASE_INTEGER_REFUSED")
                elif key in TEXT_INTEGER_COLUMNS:
                    demand(isinstance(value, str) and re.fullmatch(r"\d{1,16}", value), "SQUARE_DATABASE_INTEGER_REFUSED")
                else:
                    _safe(value)
                row[key] = value
            _id(row.get("id"))
            demand(row["id"] not in seen, "SQUARE_DATABASE_DUPLICATE_REFUSED")
            seen.add(row["id"])
            clean.append(row)
        result[name] = sorted(clean, key=lambda row: row["id"])
    return result


INTEGER_COLUMNS = {"amount_cents", "attempt_count", "booking_model_version"}
TEXT_INTEGER_COLUMNS = {"invoice_version", "split_card_amount_cents", "split_afterpay_amount_cents"}
BOOLEAN_COLUMNS = {"lease_held", "outcome_unknown", "confirmation_in_progress"}
COLUMN_NAMES = {
    "orders": set("id reference_id status initialization_status provider_checkout_id provider_order_id provider_payment_id provider_status square_payment_link_id square_location_id amount_cents currency flow correlation_id customer_id invoice_version split_stage split_card_payment_id split_afterpay_payment_id split_order_id split_card_amount_cents split_afterpay_amount_cents created_at updated_at".split()),
    "obligations": set("id order_id status initialization_status provider_checkout_id amount_cents currency idempotency_sha256 intent_sha256 initialization_outcome lease_held attempt_count source_workflow created_at updated_at".split()),
    "transactions": set("id obligation_id provider_payment_id amount_cents currency provider_status provider_type created_at captured_at".split()),
    "refunds": set("id order_id status provider_refund_id provider_payment_id amount_cents currency idempotency_sha256 lease_held outcome_unknown attempt_count created_at updated_at succeeded_at".split()),
    "holds": set("id reference_id status checkout_order_id booking_model_version provider_payment_id provider_order_id square_payment_link_id square_checkout_id customer_id card_id card_on_file_status invoice_id invoice_order_id no_show_invoice_status lease_held confirmation_in_progress checkpoint_customer_id checkpoint_card_id created_at updated_at".split()),
    "attempts": set("id hold_id checkout_order_id operation status idempotency_sha256 provider_payment_id provider_order_id amount_cents currency intent_sha256 intent_reference_id intent_customer_id reference_id created_at updated_at captured_at".split()),
    "customers": set("id provider_customer_id email_sha256 created_at updated_at".split()),
    "cards": set("id provider_card_id customer_id status created_at updated_at".split()),
    "noShowRecords": set("id hold_id status provider_status customer_id card_id invoice_id provider_order_id provider_payment_id amount_cents currency invoice_version created_at updated_at".split()),
    "noShowAttempts": set("id no_show_charge_record_id status idempotency_sha256 amount_cents currency provider_payment_id invoice_id created_at processed_at".split()),
    "events": set("id order_id no_show_charge_record_id event_type provider_event_id provider_checkout_id provider_order_id provider_payment_id status provider_status amount_cents currency payload_hash idempotency_sha256 processing_status created_at processed_at".split()),
    "refundEvents": set("id provider_event_id provider_refund_id provider_payment_id status amount_cents currency occurred_at created_at".split()),
}
REQUIRED_COLUMNS = {name: {"id", "created_at"} for name in QUERIES}
for _group, _fields in {
        "orders": "reference_id status initialization_status amount_cents currency",
        "obligations": "order_id status initialization_status amount_cents currency idempotency_sha256 lease_held attempt_count source_workflow",
        "transactions": "obligation_id provider_payment_id amount_cents currency provider_status provider_type captured_at",
        "refunds": "order_id status provider_payment_id amount_cents currency idempotency_sha256 lease_held outcome_unknown attempt_count",
        "holds": "reference_id status booking_model_version lease_held confirmation_in_progress",
        "attempts": "operation status idempotency_sha256 amount_cents currency",
        "customers": "provider_customer_id email_sha256",
        "cards": "provider_card_id customer_id status",
        "noShowRecords": "hold_id status amount_cents currency",
        "noShowAttempts": "no_show_charge_record_id amount_cents currency",
        "events": "event_type processing_status",
        "refundEvents": "provider_event_id provider_refund_id provider_payment_id status amount_cents currency occurred_at"}.items():
    REQUIRED_COLUMNS[_group].update(_fields.split())


def read_only_request(method, path, body, reviewed):
    """Closed request allowlist consumed by the parent's fixed sandbox transport."""
    try:
        _review(reviewed, principals=True)
        demand(isinstance(path, str) and path.startswith("/v2/") and len(path) <= 8192, "SQUARE_PATH_REFUSED")
        url = urllib.parse.urlsplit(path)
        demand(not url.scheme and not url.netloc and not url.fragment, "SQUARE_PATH_REFUSED")
        pairs = urllib.parse.parse_qsl(url.query, keep_blank_values=True, strict_parsing=True)
        query = dict(pairs)
        demand(len(query) == len(pairs), "SQUARE_QUERY_REFUSED")
        if method == "POST":
            return url.path == "/v2/orders/search" and not query and isinstance(body, dict) and \
                set(body) <= {"location_ids", "query", "cursor", "limit", "return_entries"} and \
                body.get("location_ids") == [LOCATION] and body.get("limit") == 1000 and body.get("return_entries") is False and \
                body.get("query") == {"filter": {"date_time_filter": {"created_at": {
                    "start_at": reviewed["operationBeginTime"], "end_at": reviewed["observationEndTime"]}}},
                    "sort": {"sort_field": "CREATED_AT", "sort_order": "ASC"}} and \
                ("cursor" not in body or _cursor(body["cursor"]))
        if method != "GET" or body is not None:
            return False
        if url.path == "/v2/locations/" + LOCATION:
            return not query
        if re.fullmatch(r"/v2/(payments|refunds|orders|customers|cards|invoices|online-checkout/payment-links)/[A-Za-z0-9_%:-]{1,576}", url.path):
            value = urllib.parse.unquote(url.path.rsplit("/", 1)[1])
            return not query and ID.fullmatch(value) is not None and urllib.parse.quote(value, safe="") == url.path.rsplit("/", 1)[1]
        fixed = {}
        if url.path in ("/v2/payments", "/v2/refunds"):
            fixed = {"location_id": LOCATION, "begin_time": reviewed["operationBeginTime"],
                "end_time": reviewed["observationEndTime"], "sort_order": "ASC", "limit": "100"}
        elif url.path == "/v2/customers":
            fixed = {"limit": "100", "sort_field": "CREATED_AT", "sort_order": "ASC"}
        elif url.path == "/v2/cards":
            fixed = {"include_disabled": "true", "sort_order": "ASC"}
        elif url.path == "/v2/invoices":
            fixed = {"location_id": LOCATION, "limit": "200"}
        elif url.path == "/v2/online-checkout/payment-links":
            fixed = {"limit": "1000"}
        return bool(fixed) and set(query) in (set(fixed), set(fixed) | {"cursor"}) and \
            all(query.get(key) == value for key, value in fixed.items()) and ("cursor" not in query or _cursor(query["cursor"]))
    except (ValueError, TypeError, KeyError, AttributeError):
        return False


def _cursor(value):
    return isinstance(value, str) and 0 < len(value) <= 4096 and all(32 < ord(char) < 127 for char in value)


def _request(client, reviewed, method, path, body=None):
    demand(read_only_request(method, path, body, reviewed), "SQUARE_READ_ONLY_REQUEST_REFUSED")
    value = client.request(method, path, body)
    demand(isinstance(value, dict) and not value.get("errors"), "SQUARE_PROVIDER_RESPONSE_REFUSED")
    return value


LISTS = {
    "payments": ("/v2/payments", "payments", 100),
    "refunds": ("/v2/refunds", "refunds", 100),
    "orders": ("/v2/orders/search", "orders", 1000),
    "customers": ("/v2/customers", "customers", 100),
    "cards": ("/v2/cards", "cards", 25),
    "invoices": ("/v2/invoices", "invoices", 200),
    "checkout": ("/v2/online-checkout/payment-links", "payment_links", 1000),
}
OBJECTS = {"payments": "payment", "refunds": "refund", "orders": "order", "customers": "customer",
    "cards": "card", "invoices": "invoice", "checkout": "payment_link"}


def _enumerate(client, reviewed, family):
    path, key, page_size = LISTS[family]
    cursor, seen_cursors, result = None, set(), {}
    for _ in range(MAX_PAGES):
        if family == "orders":
            body = {"location_ids": [LOCATION], "limit": 1000, "return_entries": False,
                "query": {"filter": {"date_time_filter": {"created_at": {
                    "start_at": reviewed["operationBeginTime"], "end_at": reviewed["observationEndTime"]}}},
                    "sort": {"sort_field": "CREATED_AT", "sort_order": "ASC"}}}
            if cursor is not None:
                body["cursor"] = cursor
            value = _request(client, reviewed, "POST", path, body)
        else:
            query = {}
            if family in ("payments", "refunds"):
                query.update(location_id=LOCATION, begin_time=reviewed["operationBeginTime"], end_time=reviewed["observationEndTime"], sort_order="ASC", limit="100")
            elif family == "customers":
                query.update(limit="100", sort_field="CREATED_AT", sort_order="ASC")
            elif family == "cards":
                query.update(include_disabled="true", sort_order="ASC")
            elif family == "invoices":
                query.update(location_id=LOCATION, limit="200")
            else:
                query.update(limit="1000")
            if cursor is not None:
                query["cursor"] = cursor
            value = _request(client, reviewed, "GET", path + "?" + urllib.parse.urlencode(query))
        items = value.get(key, [])
        demand(isinstance(items, list) and len(items) <= page_size, "SQUARE_PROVIDER_PAGE_REFUSED")
        for item in items:
            demand(isinstance(item, dict), "SQUARE_PROVIDER_OBJECT_REFUSED")
            identifier = _id(item.get("id"))
            demand(identifier not in result, "SQUARE_PROVIDER_DUPLICATE_REFUSED")
            result[identifier] = item
            demand(len(result) <= MAX_ROWS, "SQUARE_PROVIDER_SCOPE_BOUND_EXCEEDED")
        cursor = value.get("cursor")
        if cursor is None:
            return result
        demand(_cursor(cursor) and cursor not in seen_cursors and items, "SQUARE_PROVIDER_CURSOR_REFUSED")
        seen_cursors.add(cursor)
    raise ValueError("SQUARE_PROVIDER_PAGINATION_BOUND_EXCEEDED")


def _money(value):
    demand(isinstance(value, dict) and type(value.get("amount")) is int and value["amount"] >= 0 and value.get("currency") == "CAD", "SQUARE_CAD_MONEY_REQUIRED")
    return value["amount"]


def _provider_summary(family, value, reviewed):
    identifier = _id(value.get("id"))
    result = {"providerId": identifier}
    for name in ("reference_id", "order_id", "customer_id", "payment_id", "location_id"):
        if value.get(name) is not None:
            result[name] = _safe(value[name])
    for name in ("created_at", "updated_at"):
        if value.get(name) is not None:
            _time(value[name])
            result[name] = value[name]
    if family in ("payments", "refunds", "orders", "invoices"):
        demand(value.get("location_id") == LOCATION, "SQUARE_PROVIDER_LOCATION_REFUSED")
    if family in ("payments", "refunds"):
        result["amountCents"] = _money(value.get("amount_money"))
    if family == "payments":
        demand(value.get("application_details", {}).get("application_id") == reviewed["applicationId"], "SQUARE_PROVIDER_APPLICATION_REFUSED")
        result["applicationId"] = reviewed["applicationId"]
    if family == "orders":
        result["amountCents"] = _money(value.get("total_money"))
        result["status"] = _safe(value.get("state"))
        demand(result["status"] in ("OPEN", "COMPLETED", "CANCELED", "DRAFT"), "SQUARE_PROVIDER_ORDER_STATE_REFUSED")
    elif family in ("payments", "refunds", "invoices"):
        result["status"] = _safe(value.get("status"))
    elif family == "cards":
        demand(type(value.get("enabled")) is bool and value.get("customer_id"), "SQUARE_PROVIDER_CARD_REFUSED")
        demand(value.get("merchant_id", reviewed["merchantId"]) == reviewed["merchantId"], "SQUARE_PROVIDER_CARD_MERCHANT_REFUSED")
        result["enabled"] = value["enabled"]
    elif family == "customers":
        if value.get("email_address") is not None:
            email = value["email_address"]
            demand(isinstance(email, str) and len(email) <= 320, "SQUARE_PROVIDER_CUSTOMER_REFUSED")
            result["emailSha256"] = hashlib.sha256(email.strip().lower().encode()).hexdigest()
    elif family == "checkout":
        demand(value.get("order_id"), "SQUARE_PROVIDER_CHECKOUT_REFUSED")
        # A URL is bearer capability / PII context. Neither retain nor publish.
        result["acceptsFuturePaymentUnknown"] = True
    if family == "invoices":
        recipient = value.get("primary_recipient")
        demand(isinstance(recipient, dict), "SQUARE_PROVIDER_INVOICE_REFUSED")
        result["customer_id"] = _id(recipient.get("customer_id"))
        demand(type(value.get("version")) is int and value["version"] >= 0, "SQUARE_PROVIDER_INVOICE_VERSION_REFUSED")
        result["version"] = value["version"]
    return result


def _effect_refs(rows):
    """All persisted provider references, including checkpoints and webhooks."""
    refs = {name: {} for name in LISTS}
    mapping = {"payments": ("provider_payment_id", "split_card_payment_id", "split_afterpay_payment_id"),
        "refunds": ("provider_refund_id",), "orders": ("provider_order_id", "invoice_order_id", "split_order_id"),
        "customers": ("provider_customer_id", "customer_id", "checkpoint_customer_id", "intent_customer_id"),
        "cards": ("provider_card_id", "card_id", "checkpoint_card_id"), "invoices": ("invoice_id",),
        "checkout": ("square_payment_link_id", "square_checkout_id")}
    for group, items in rows.items():
        for row in items:
            for family, fields in mapping.items():
                for field in fields:
                    value = row.get(field)
                    if value:
                        _id(value)
                        refs[family].setdefault(value, []).append((group, row, field))
            if group == "orders" and row.get("flow") == "training_square_invoice" and row.get("provider_checkout_id"):
                refs["invoices"].setdefault(_id(row["provider_checkout_id"]), []).append((group, row, "provider_checkout_id"))
    return refs


def _join(family, provider, references, rows):
    """Match exact stored IDs plus all available immutable financial context."""
    reasons, joins = [], []
    for group, row, field in references:
        joins.append({"recordKind": group, "recordId": row["id"], "field": field,
            "databaseRowSha256": sha256(row), "idempotencySha256": row.get("idempotency_sha256"),
            "intentSha256": row.get("intent_sha256")})
        if family in ("payments", "refunds"):
            # Hold/order aggregate totals must not be mistaken for a split's
            # individual payment amount. Primary attempt/transaction rows are
            # the financial receipts; webhook-only IDs remain insufficient.
            money_groups = ("attempts", "transactions", "noShowAttempts") if family == "payments" else ("refunds", "refundEvents")
            amount = row.get("amount_cents") if group in money_groups else None
            if group == "orders" and field.startswith("split_"):
                amount = row.get("split_card_amount_cents" if field == "split_card_payment_id" else "split_afterpay_amount_cents")
                amount = int(amount) if amount is not None else None
            if amount is not None and (provider.get("amountCents") != amount or row.get("currency") != "CAD"):
                reasons.append("money-mismatch")
            if family == "refunds" and row.get("provider_payment_id") != provider.get("payment_id"):
                reasons.append("original-payment-mismatch")
            if family == "payments":
                reference = row.get("intent_reference_id") or (row.get("reference_id") if group != "holds" or row.get("booking_model_version") == 2 else None)
                if reference and provider.get("reference_id") != reference:
                    reasons.append("reference-mismatch")
                if row.get("provider_order_id") and provider.get("order_id") != row["provider_order_id"]:
                    reasons.append("order-mismatch")
                if row.get("intent_customer_id") and provider.get("customer_id") != row["intent_customer_id"]:
                    reasons.append("customer-mismatch")
                statuses = {"captured": "COMPLETED", "failed": "FAILED", "cancelled": "CANCELED"}
                if group == "attempts" and statuses.get(row.get("status")) != provider.get("status"):
                    reasons.append("database-provider-outcome-mismatch")
                if group == "transactions" and row.get("provider_status") != provider.get("status"):
                    reasons.append("database-provider-outcome-mismatch")
            elif group == "refunds":
                statuses = {"succeeded": ("COMPLETED",), "failed": ("FAILED", "REJECTED")}
                if provider.get("status") not in statuses.get(row.get("status"), ()):
                    reasons.append("database-provider-outcome-mismatch")
        elif family == "customers" and row.get("email_sha256") and provider.get("emailSha256") != row["email_sha256"]:
            reasons.append("customer-fingerprint-mismatch")
        elif family in ("cards", "invoices"):
            context = row
            if group == "noShowAttempts":
                parents = [item for item in rows["noShowRecords"] if item["id"] == row["no_show_charge_record_id"]]
                if len(parents) != 1:
                    reasons.append("no-show-parent-intent-missing")
                else:
                    context = parents[0]
                    joins.append({"recordKind": "noShowRecords", "recordId": context["id"], "field": "no_show_charge_record_id",
                        "databaseRowSha256": sha256(context), "idempotencySha256": None, "intentSha256": None})
            customer = context.get("customer_id") or context.get("checkpoint_customer_id")
            if customer and provider.get("customer_id") != customer:
                reasons.append("customer-mismatch")
            if family == "invoices":
                order_id = context.get("invoice_order_id") if group == "holds" else context.get("provider_order_id")
                if order_id and provider.get("order_id") != order_id:
                    reasons.append("order-mismatch")
                if row.get("invoice_version") is not None and int(row["invoice_version"]) > provider["version"]:
                    reasons.append("invoice-version-regressed")
                state = provider.get("status")
                if group == "holds":
                    stored = context.get("no_show_invoice_status")
                    if not isinstance(stored, str) or stored.upper() != state:
                        reasons.append("database-invoice-provider-status-mismatch")
                elif group == "orders":
                    # These are the source's normalized invoice lifecycle
                    # labels, not literal Square invoice status strings.
                    expected = {"draft": {"DRAFT"}, "published": {"UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"},
                        "paid": {"PAID", "PARTIALLY_REFUNDED", "REFUNDED"}, "cancelled": {"CANCELED"}, "canceled": {"CANCELED"},
                        "refunded": {"REFUNDED"}}
                    if state not in expected.get(context.get("provider_status"), set()):
                        reasons.append("database-invoice-provider-status-mismatch")
                    business = {"paid": {"PAID", "PARTIALLY_REFUNDED"}, "refunded": {"REFUNDED"}, "cancelled": {"CANCELED"},
                        "pending": {"DRAFT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"}}
                    if state not in business.get(context.get("status"), set()):
                        reasons.append("database-invoice-order-status-mismatch")
                elif group in ("noShowRecords", "noShowAttempts"):
                    # The source stores the provider status of the triggering
                    # webhook: payment.updated uses COMPLETED, whereas
                    # invoice.payment_made uses PAID for the same paid invoice.
                    stored = context.get("provider_status")
                    payment_completed = context.get("status") == "charged" and stored == "COMPLETED" and state == "PAID"
                    if stored != state and not payment_completed:
                        reasons.append("database-invoice-provider-status-mismatch")
                    expected = {"charged": {"PAID"}, "charge_failed": {"CANCELED", "FAILED"}, "voided": {"CANCELED"},
                        "provider_draft_created": {"DRAFT"}, "charge_pending": {"DRAFT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"}}
                    if state not in expected.get(context.get("status"), set()):
                        reasons.append("database-invoice-business-status-mismatch")
            elif group == "cards" and ((row["status"] == "active" and not provider["enabled"]) or
                    (row["status"] in ("disabled", "deleted") and provider["enabled"])):
                reasons.append("card-state-mismatch")
        elif family == "orders":
            reference = row.get("hold_id") if group == "noShowRecords" else (row["id"] if field == "invoice_order_id" else
                (None if group == "holds" else row.get("correlation_id") or row.get("reference_id")))
            if reference and provider.get("reference_id") != reference:
                reasons.append("reference-mismatch")
            if group in ("orders", "noShowRecords") and (provider.get("amountCents") != row["amount_cents"] or row["currency"] != "CAD"):
                reasons.append("money-mismatch")
            expected = None
            if group == "orders":
                expected = {"paid": {"COMPLETED"}, "refunded": {"COMPLETED"}, "cancelled": {"CANCELED"},
                    "pending": {"DRAFT", "OPEN"}}.get(row.get("status"), set())
            elif group == "noShowRecords":
                expected = {"charged": {"COMPLETED"}, "charge_failed": {"CANCELED"}, "voided": {"CANCELED"},
                    "provider_draft_created": {"DRAFT", "OPEN"}, "charge_pending": {"DRAFT", "OPEN"}}.get(row.get("status"), set())
            elif group == "holds" and field == "invoice_order_id":
                expected = {"PAID": {"COMPLETED"}, "CANCELED": {"CANCELED"}, "DRAFT": {"DRAFT", "OPEN"},
                    "UNPAID": {"OPEN"}, "SCHEDULED": {"OPEN"}, "PAYMENT_PENDING": {"OPEN"}}.get(row.get("no_show_invoice_status"), set())
            if expected is not None and provider.get("status") not in expected:
                reasons.append("database-provider-order-status-mismatch")
        elif family == "checkout":
            if row.get("provider_order_id") and provider.get("order_id") != row["provider_order_id"]:
                reasons.append("order-mismatch")
    if family in ("payments", "refunds") and not any(
            group in (("attempts", "transactions", "noShowAttempts") if family == "payments" else ("refunds", "refundEvents")) or
            (family == "payments" and group == "orders" and field.startswith("split_")) for group, _, field in references):
        reasons.append("durable-financial-intent-or-receipt-missing")
    if not references:
        reasons.append("provider-object-without-durable-source-receipt")
    return joins, sorted(set(reasons))


def _source_requirements(verified):
    demand(isinstance(verified, dict) and verified.get("version") == 1 and verified.get("status") == "FRONTEND_HISTORICAL_SOURCE_VERIFIED" and
        isinstance(verified.get("sourceCommit"), str) and COMMIT.fullmatch(verified["sourceCommit"]), "SQUARE_VERIFIED_HISTORICAL_SOURCE_REQUIRED")
    for key in ("sourceInventorySha256", "requirementsSha256"):
        demand(isinstance(verified.get(key), str) and HASH.fullmatch(verified[key]), "SQUARE_SOURCE_DIGEST_REQUIRED")
    families = verified.get("providerFamilies")
    demand(isinstance(families, list) and all(isinstance(item, dict) for item in families), "SQUARE_SOURCE_FAMILIES_REQUIRED")
    chosen = {item.get("familyId"): item for item in families if isinstance(item, dict) and item.get("familyId") in FAMILIES}
    demand(set(chosen) == set(FAMILIES) and len([item for item in families if item.get("familyId") in FAMILIES]) == len(FAMILIES), "SQUARE_COMPLETE_SOURCE_FAMILIES_REQUIRED")
    seen = set()
    for item in chosen.values():
        demand(item.get("sourceDisposition") in ("reachable", "absent-from-verified-source"), "SQUARE_SOURCE_DISPOSITION_REFUSED")
        for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests"):
            demand(isinstance(item.get(key), list), "SQUARE_SOURCE_REQUIREMENT_IDS_REQUIRED")
            for requirement in item[key]:
                demand(isinstance(requirement, dict), "SQUARE_SOURCE_REQUIREMENT_REFUSED")
                identifier = _safe(requirement.get("requirementId"))
                demand(identifier not in seen, "SQUARE_SOURCE_REQUIREMENT_DUPLICATE")
                seen.add(identifier)
    closures = verified.get("capabilityClosures", [])
    demand(isinstance(closures, list) and all(isinstance(item, dict) for item in closures), "SQUARE_SOURCE_CLOSURES_REFUSED")
    credential_requirements = verified.get("sqlCredentialRequirements")
    demand(isinstance(credential_requirements, list), "SQUARE_SOURCE_SQL_CREDENTIAL_REQUIREMENTS_REQUIRED")
    credential_ids = set()
    for item in credential_requirements:
        demand(isinstance(item, dict), "SQUARE_SOURCE_SQL_CREDENTIAL_REQUIREMENT_REFUSED")
        identifier = _safe(item.get("requirementId"))
        demand(identifier.startswith("sql-credentials.") and identifier not in credential_ids, "SQUARE_SOURCE_SQL_CREDENTIAL_REQUIREMENT_REFUSED")
        credential_ids.add(identifier)
    return chosen, closures, credential_ids


def _closure_ids(family, source, closures, credential_ids):
    closed = set()
    allowed = {item["requirementId"] for kind in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for item in source[kind]}
    for item in closures:
        if item.get("familyId") != family:
            continue
        demand(item.get("disposition") in ("no-capability-observed", "absent-from-verified-source") and
            isinstance(item.get("requirementIds"), list) and isinstance(item.get("evidenceIds"), list) and 0 < len(item["evidenceIds"]) <= 128,
            "SQUARE_SOURCE_CLOSURE_EVIDENCE_REQUIRED")
        demand(item["evidenceIds"] == sorted(set(item["evidenceIds"])), "SQUARE_SOURCE_CLOSURE_EVIDENCE_ORDER_REQUIRED")
        demand(len(item["requirementIds"]) == len(set(item["requirementIds"])) and
            set(item["requirementIds"]) == allowed | credential_ids, "SQUARE_COMPLETE_SOURCE_AND_CREDENTIAL_CLOSURE_REQUIRED")
        if item["disposition"] == "absent-from-verified-source":
            demand(source["sourceDisposition"] == "absent-from-verified-source", "SQUARE_REACHABLE_SOURCE_CANNOT_BE_ABSENT")
        for identifier in item["requirementIds"]:
            if identifier in allowed:
                closed.add(identifier)
        for identifier in item["evidenceIds"]:
            demand(isinstance(identifier, str) and HASH.fullmatch(identifier), "SQUARE_CLOSURE_EVIDENCE_DIGEST_REQUIRED")
    return closed


def source_inapplicable(reviewed, actual_rows, verified_source_requirements):
    """Parent can call before resolving any Square credential.

    This consumes source-owned, independently observed original configuration
    and complete SQL-credential closures. A caller flag is never consulted.
    """
    _review(reviewed)
    source, closures, credential_ids = _source_requirements(verified_source_requirements)
    rows, before = normalize_snapshot(actual_rows), normalize_snapshot(reviewed.get("databaseSnapshot"))
    demand(sha256(before) == reviewed["databaseSnapshotSha256"], "SQUARE_IMMUTABLE_PRESTATE_DIGEST_REFUSED")
    if any(rows.values()) or any(before.values()):
        return False
    return all(_closure_ids(family, item, closures, credential_ids) == {
        requirement["requirementId"] for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for requirement in item[key]}
        and any(closure.get("familyId") == family for closure in closures)
        for family, item in source.items())


def observe_scoped_effects(client, reviewed, actual_rows, verified_source_requirements):
    begin, end = _review(reviewed)
    source, closures, credential_ids = _source_requirements(verified_source_requirements)
    rows = normalize_snapshot(actual_rows)
    baseline = normalize_snapshot(reviewed.get("databaseSnapshot"))
    demand(sha256(baseline) == reviewed["databaseSnapshotSha256"], "SQUARE_IMMUTABLE_PRESTATE_DIGEST_REFUSED")
    if source_inapplicable(reviewed, rows, verified_source_requirements):
        family_receipts = []
        covered = set()
        for family, item in source.items():
            selected = _closure_ids(family, item, closures, credential_ids)
            covered.update(selected)
            family_receipts.append({"familyId": family, "sourceDisposition": item["sourceDisposition"],
                "observedObjectCount": 0, "sourceCapabilityExcluded": True, "coveredRequirementIds": sorted(selected),
                "missingRequirementIds": [], "capabilityEvidenceIds": sorted({evidence for closure in closures if closure.get("familyId") == family for evidence in closure["evidenceIds"]})})
        result = _result(reviewed, verified_source_requirements, baseline, rows, [], family_receipts, covered, set(), [], 0, 0, False)
        result["providerReadRequired"] = False
        return result
    for items in rows.values():
        for row in items:
            demand(begin <= _time(row["created_at"]) <= end, "SQUARE_OPERATION_LIFETIME_EXCLUDES_SQL_INTENT")
    _review(reviewed, principals=True)
    demand(callable(getattr(client, "request", None)), "SQUARE_PRIVATE_LOCKED_CLIENT_REQUIRED")
    location = _request(client, reviewed, "GET", "/v2/locations/" + LOCATION).get("location")
    demand(isinstance(location, dict) and location.get("merchant_id") == reviewed["merchantId"] and location.get("id") == LOCATION and
        location.get("currency") == "CAD" and location.get("country") == "CA" and location.get("status") == "ACTIVE", "SQUARE_SANDBOX_PRINCIPAL_REFUSED")
    refs = _effect_refs(rows)
    observations, family_receipts, covered, missing = [], [], set(), set()
    active = uncertain = 0
    for full_id in FAMILIES:
        family = full_id.removeprefix("square.")
        requirements = source[full_id]
        closed = _closure_ids(full_id, requirements, closures, credential_ids)
        all_ids = {item["requirementId"] for kind in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for item in requirements[kind]}
        # A source absence/config closure with contradictory actual SQL refs is
        # not usable. All account-wide families are otherwise read in full.
        actual_refs = refs.get(family, {})
        excluded = bool(closed == all_ids) and (bool(all_ids) or requirements["sourceDisposition"] == "absent-from-verified-source")
        start = len(observations)
        if family != "webhooks" and (not excluded or actual_refs):
            objects = _enumerate(client, reviewed, family)
            # Exact stored IDs are read even if an eventually consistent list
            # has not exposed them. This does not close a request with no ID.
            for identifier in sorted(set(objects) | set(actual_refs)):
                singular = OBJECTS[family]
                path = LISTS[family][0] if family != "orders" else "/v2/orders"
                if family == "orders":
                    path = "/v2/orders"
                value = _request(client, reviewed, "GET", path + "/" + urllib.parse.quote(identifier, safe="")).get(singular)
                demand(isinstance(value, dict) and value.get("id") == identifier, "SQUARE_EXACT_PROVIDER_READBACK_REFUSED")
                summary = _provider_summary(family, value, reviewed)
                if family in ("payments", "refunds", "orders"):
                    demand(summary.get("created_at") is not None and begin <= _time(summary["created_at"]) <= end, "SQUARE_OPERATION_LIFETIME_EXCLUDES_PROVIDER_EFFECT")
                joins, reasons = _join(family, summary, actual_refs.get(identifier, []), rows)
                if identifier in objects:
                    listed = _provider_summary(family, objects[identifier], reviewed)
                    if listed != summary:
                        reasons.append("provider-object-changed-since-list")
                if family == "payments" and summary["status"] not in ("COMPLETED", "FAILED", "CANCELED"):
                    active += 1
                    reasons.append("payment-not-terminal")
                if family == "refunds" and summary["status"] not in ("COMPLETED", "FAILED", "REJECTED"):
                    active += 1
                    reasons.append("refund-not-terminal")
                if family == "invoices" and summary["status"] not in ("PAID", "CANCELED", "REFUNDED", "PARTIALLY_REFUNDED", "FAILED"):
                    active += 1
                    reasons.append("invoice-can-create-future-payment")
                if family == "orders" and summary["status"] not in ("COMPLETED", "CANCELED"):
                    active += 1
                    reasons.append("order-can-create-future-payment")
                if family == "checkout":
                    reasons.append("hosted-checkout-acceptance-capability-unresolved")
                result = {"familyId": full_id, **summary, "sqlReceipts": joins, "immutableMatch": not reasons,
                    "unresolvedReasons": sorted(set(reasons)), "providerReceiptSha256": sha256(summary)}
                observations.append(result)
                uncertain += bool(reasons)
        family_observations = observations[start:]
        # Inventory coverage is a source-level requirement, not proof from an
        # arbitrary nonempty row set. Untracked request requirements are only
        # closable by source-owned positive capability/request evidence.
        # This proves discovery/readback of *durable* intents, independently of
        # the capability and accepted-request completeness requirements. Empty
        # SQL can cover the durable inventory only, never a lost ACK gap.
        durable_ids = {item["requirementId"] for item in requirements["sqlIntentRequirements"]}
        durable_covered = durable_ids if family != "webhooks" and not any(item["unresolvedReasons"] for item in family_observations) else set()
        family_covered = closed | durable_covered
        family_missing = all_ids - family_covered
        missing.update(family_missing)
        covered.update(family_covered)
        family_receipts.append({"familyId": full_id, "sourceDisposition": requirements["sourceDisposition"],
            "observedObjectCount": len(family_observations), "sourceCapabilityExcluded": excluded,
            "coveredRequirementIds": sorted(family_covered), "missingRequirementIds": sorted(family_missing),
            "capabilityEvidenceIds": sorted({evidence for closure in closures if closure.get("familyId") == full_id for evidence in closure["evidenceIds"]})})
    # Pending SQL without a recorded provider ID remains uncertain even when
    # the API returned no objects. No clock/settling/list repetition clears it.
    unresolved_sql = []
    for name in ("attempts", "refunds", "noShowAttempts", "obligations", "holds", "orders", "noShowRecords", "events"):
        for row in rows[name]:
            pending = row.get("lease_held") or row.get("outcome_unknown") or row.get("confirmation_in_progress") or \
                (name in ("attempts", "refunds") and not row.get("provider_payment_id" if name == "attempts" else "provider_refund_id")) or \
                (name == "attempts" and row["status"] not in ("captured", "failed", "cancelled")) or \
                (name == "refunds" and row["status"] not in ("succeeded", "failed")) or \
                (name == "noShowAttempts" and (not row.get("processed_at") or row.get("status") not in ("charged", "charge_failed"))) or \
                (name == "obligations" and row["initialization_status"] != "ready") or \
                (name == "orders" and (row["initialization_status"] != "ready" or row.get("split_stage") not in (None, "reserved", "canceled", "paid"))) or \
                (name == "noShowRecords" and row["status"] == "charge_pending") or \
                (name == "events" and row["processing_status"] not in ("processed", "duplicate", "ignored"))
            if pending:
                unresolved_sql.append({"recordKind": name, "recordId": row["id"], "databaseRowSha256": sha256(row)})
    uncertain += len(unresolved_sql)
    changed = rows != baseline
    # Parent may continue existing admitted callbacks. Exact source-backed
    # transitions are accepted by the narrow reducer below; original prestate
    # and its digest remain immutable in every receipt.
    advanced = changed and _callback_advance(baseline, rows, observations)
    if changed and not advanced:
        uncertain += 1
    if unresolved_sql:
        active += sum(bool(row.get("lease_held")) for name in QUERIES for row in rows[name])
    return _result(reviewed, verified_source_requirements, baseline, rows, observations, family_receipts, covered, missing, unresolved_sql, active, uncertain, advanced)


def _result(reviewed, verified_source_requirements, baseline, rows, observations, family_receipts, covered, missing, unresolved_sql, active, uncertain, advanced):
    source_complete, changed = not missing, rows != baseline
    return {"version": 1, "status": "SQUARE_SANDBOX_FINANCIAL_SCOPE_OBSERVED",
        "sourceCommit": verified_source_requirements["sourceCommit"],
        "sourceInventorySha256": verified_source_requirements["sourceInventorySha256"],
        "requirementsSha256": verified_source_requirements["requirementsSha256"],
        "sourceBindingSha256": reviewed["sourceBindingSha256"],
        "merchantId": reviewed.get("merchantId"), "locationId": LOCATION, "applicationId": reviewed.get("applicationId"),
        "apiVersion": API_VERSION, "operationBeginTime": reviewed["operationBeginTime"], "observationEndTime": reviewed["observationEndTime"],
        "operationLifetimeEvidenceIds": reviewed["operationLifetimeEvidenceIds"],
        "beforeDatabaseSnapshotSha256": sha256(baseline), "currentDatabaseSnapshotSha256": sha256(rows),
        "callbackAdvanceVerified": advanced, "databaseSnapshotChangedWithoutReceipt": changed and not advanced,
        "coveredRequirementIds": sorted(covered), "missingRequirementIds": sorted(missing),
        "coveredFamilyIds": [item["familyId"] for item in family_receipts if not item["missingRequirementIds"]],
        "families": family_receipts, "effects": observations, "unresolvedSql": unresolved_sql,
        "knownActiveExecutions": active, "knownUncertainEffects": uncertain,
        "activeExecutions": active if source_complete else None, "uncertainEffects": uncertain if source_complete else None,
        "providerReadRequired": True, "trafficAuthorized": False}


def _callback_advance(before, current, effects):
    """Only terminal existing attempts/refunds plus exact appended webhooks.

    This intentionally does not admit new operations, new orders, intent edits,
    deleting history, manual overrides, or arbitrary status changes.
    """
    mutable = {"attempts": {"status", "provider_payment_id", "provider_order_id", "updated_at", "captured_at"},
        "refunds": {"status", "provider_refund_id", "updated_at", "succeeded_at", "outcome_unknown", "lease_held"}}
    receipts = current["events"] + current["refundEvents"]
    advanced = False
    for group in QUERIES:
        old, new = {row["id"]: row for row in before[group]}, {row["id"]: row for row in current[group]}
        if group in ("events", "refundEvents"):
            if not set(old) <= set(new):
                return False
            for key, previous in old.items():
                row = new[key]
                if previous == row:
                    continue
                if group != "events" or previous.get("processing_status") not in ("received", "retryable_failed") or \
                        row.get("processing_status") != "processed" or any(row[field] != previous[field] for field in COLUMN_NAMES[group] - {"processing_status", "processed_at"}) or \
                        not _terminal_event(row, effects):
                    return False
                advanced = True
            for key in set(new) - set(old):
                row = new[key]
                if not _terminal_event(row, effects):
                    return False
                advanced = True
            continue
        if set(old) != set(new):
            return False
        for key, previous in old.items():
            row = new[key]
            if row == previous:
                continue
            if group not in mutable or any(row.get(field) != previous.get(field) for field in COLUMN_NAMES[group] - mutable[group]):
                return False
            provider_field = "provider_payment_id" if group == "attempts" else "provider_refund_id"
            statuses = {"captured": "COMPLETED", "failed": "FAILED", "cancelled": "CANCELED"} if group == "attempts" else {"succeeded": "COMPLETED", "failed": "FAILED"}
            if row.get("status") not in statuses or previous.get("status") in statuses or previous.get(provider_field) not in (None, row.get(provider_field)):
                return False
            candidates = [effect for effect in effects if effect["familyId"] == ("square.payments" if group == "attempts" else "square.refunds") and
                effect["providerId"] == row.get(provider_field) and not effect["unresolvedReasons"] and effect.get("status") == statuses[row["status"]]]
            matching = [receipt for receipt in receipts if receipt.get(provider_field) == row.get(provider_field) and
                receipt.get("provider_event_id") and receipt.get("amount_cents") == row.get("amount_cents") and receipt.get("currency") == "CAD" and
                receipt.get("provider_status", receipt.get("status")) == statuses[row["status"]]]
            if len(candidates) != 1 or not matching:
                return False
            advanced = True
    return advanced


def _terminal_event(row, effects):
    if not row.get("provider_event_id") or row.get("currency") != "CAD" or row.get("amount_cents") is None:
        return False
    if "processing_status" in row and (row.get("processing_status") != "processed" or not row.get("payload_hash") or not row.get("processed_at")):
        return False
    field, family = ("provider_refund_id", "square.refunds") if row.get("provider_refund_id") else ("provider_payment_id", "square.payments")
    status = row.get("provider_status") or row.get("status")
    return any(effect["familyId"] == family and effect["providerId"] == row.get(field) and not effect["unresolvedReasons"] and
        effect.get("status") == status and effect.get("amountCents") == row["amount_cents"] for effect in effects)
