"""Source-selected staging CRM/shipping observations and dashboard retirement.

No CLI, ambient credential discovery, production origin, business mutation,
cancel-all, token-revocation fiction, provider replay, or database writes.
The locked host worker supplies actual fixed-query database snapshots privately.
"""
import hashlib
from datetime import datetime
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

import migrate
import vercel

demand = migrate.demand
ID = r"[A-Za-z0-9_-]{1,192}"
SHA = r"[a-f0-9]{64}"
PRODUCTION_HIGHLEVEL_LOCATION = "vd09FLBpPLXuHb5Tnhn4"
HIGHLEVEL_ORIGIN = "https://services.leadconnectorhq.com"
CHITCHATS_ORIGIN = "https://staging.chitchats.com"
MAXIMUM_ROWS = 4096
# These acknowledged provider states describe purchased physical shipments,
# rather than an API operation still executing. Match the existing application
# normalization without authorizing any future polling or carrier action.
ACKNOWLEDGED_SHIPMENT_STATES = {
    "ready": "label_ready", "received": "accepted", "released": "in_transit",
    "inducted": "in_transit", "in_transit": "in_transit", "delivered": "delivered", "voided": "voided",
}


class AuthenticationDenied(ValueError):
    pass


def identifier(value):
    return isinstance(value, str) and re.fullmatch(ID, value) is not None


def digest(value):
    return isinstance(value, str) and re.fullmatch(SHA, value) is not None and value != "0" * 64


def snapshot_sha256(value):
    """Canonical safe DB snapshot: recursive sorted keys, compact ASCII JSON."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def retirement_binding_sha256(reviewed):
    # Accepted business/provider receipts may legitimately arrive during the
    # operator's console step (notably AppUninstall). Preserve the original
    # receipt, bind the same principals/scope/source, and qualify the *current*
    # fixed-query snapshot; never require accepted records to be rolled back.
    observations = {"databaseSnapshotSha256"}
    return snapshot_sha256({key: value for key, value in reviewed.items() if key not in observations})


def review(provider, value):
    demand(provider in ("highlevel", "chitchats") and isinstance(value, dict) and value.get("environment") == "staging",
        "CRM_SHIPPING_STAGING_SCOPE_REQUIRED")
    for field in ("sourceBindingSha256", "databaseSnapshotSha256", "retiredCredentialBindingSha256", "replacementCredentialBindingSha256"):
        demand(digest(value.get(field)), "CRM_SHIPPING_REVIEW_BINDING_REQUIRED")
    demand(value["retiredCredentialBindingSha256"] != value["replacementCredentialBindingSha256"], "CRM_SHIPPING_DISTINCT_CREDENTIAL_BINDINGS_REQUIRED")
    fields = ("expectedProviderShipmentIds",) if provider == "chitchats" else ("expectedProviderContactIds", "expectedWorkflowIds")
    for field in fields:
        rows = value.get(field)
        demand(isinstance(rows, list) and len(rows) <= MAXIMUM_ROWS and all(identifier(row) for row in rows) and rows == sorted(set(rows)),
            "CRM_SHIPPING_REVIEWED_INVENTORY_REQUIRED")
    if provider == "chitchats":
        demand(identifier(value.get("clientId")) and value.get("credentialKind") == "personal-access-token", "CHITCHATS_CLIENT_BINDING_REQUIRED")
    else:
        demand(identifier(value.get("locationId")) and value["locationId"] != PRODUCTION_HIGHLEVEL_LOCATION and identifier(value.get("companyId")) and
            value.get("credentialKind") in ("private-integration-token", "oauth-installation"), "HIGHLEVEL_LOCATION_BINDING_REQUIRED")
        demand(identifier(value.get("appId") if value["credentialKind"] == "oauth-installation" else value.get("retiredIntegrationId")),
            "HIGHLEVEL_CREDENTIAL_PROVENANCE_REQUIRED")
        if value["credentialKind"] == "oauth-installation":
            demand(identifier(value.get("oauthClientId")), "HIGHLEVEL_OAUTH_CLIENT_BINDING_REQUIRED")
    return value


class Client:
    def __init__(self, provider, token, reviewed, refresh_credentials=None):
        self.provider = provider
        self.reviewed = json.loads(json.dumps(review(provider, reviewed)))
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token), "CRM_SHIPPING_PRIVATE_CREDENTIAL_REQUIRED")
        self._token = token
        self._refresh = None
        self._refresh_started = False
        if refresh_credentials is not None:
            demand(provider == "highlevel" and reviewed["credentialKind"] == "oauth-installation" and isinstance(refresh_credentials, dict) and
                set(refresh_credentials) == {"client_id", "client_secret", "refresh_token"} and
                refresh_credentials.get("client_id") == reviewed["oauthClientId"] and
                all(isinstance(v, str) and 0 < len(v) <= 8192 and all(32 < ord(c) < 127 for c in v) for v in refresh_credentials.values()),
                "HIGHLEVEL_PRIVATE_REFRESH_BINDING_REQUIRED")
            self._refresh = {**refresh_credentials, "grant_type": "refresh_token", "user_type": "Location"}
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        selected = self.reviewed
        refresh = self.provider == "highlevel" and method == "POST" and path == "/oauth/token" and body is None and self._refresh is not None
        if self.provider == "chitchats":
            prefix = "/api/v1/clients/" + selected["clientId"]
            read = method == "GET" and body is None and (path == prefix + "/shipments/count" or
                re.fullmatch(re.escape(prefix) + r"/shipments\?limit=100&page=([1-9][0-9]{0,2})", path) or
                path in (prefix + "/shipments/" + item for item in selected["expectedProviderShipmentIds"]))
            origin, headers = CHITCHATS_ORIGIN, {"Authorization": self._token}
        else:
            contacts = selected["expectedProviderContactIds"]
            read = method == "GET" and body is None and (path == "/locations/" + selected["locationId"] or
                path in ("/contacts/" + item for item in contacts) or
                any(re.fullmatch(re.escape("/contacts/" + item) + rf"/(notes|tasks)/{ID}", path) for item in contacts) or
                re.fullmatch(rf"/opportunities/{ID}", path))
            search = (method == "POST" and path == "/contacts/search" and isinstance(body, dict) and set(body) == {"locationId", "pageLimit", "page"} and
                body.get("locationId") == selected["locationId"] and body.get("pageLimit") == 100 and type(body.get("page")) is int and 1 <= body["page"] <= 100)
            workflow_search = (method == "POST" and path == "/workflows/search?locationId=" + selected["locationId"] and isinstance(body, dict) and
                body.get("limit") == 100 and body.get("sort") == [{"field": "workflowId", "direction": "asc"}] and
                (set(body) == {"limit", "sort", "offset"} and body.get("offset") == 0 or
                 set(body) == {"limit", "sort", "searchAfter"} and isinstance(body.get("searchAfter"), list) and 0 < len(body["searchAfter"]) <= 8 and
                 all(isinstance(item, str) and 0 < len(item) <= 256 for item in body["searchAfter"])))
            read = read or search or workflow_search
            origin, headers = HIGHLEVEL_ORIGIN, {"Authorization": "Bearer " + self._token, "Version": "v3"}
        demand(read or refresh, "CRM_SHIPPING_REQUEST_SCOPE_REFUSED")
        if refresh:
            demand(not self._refresh_started, "HIGHLEVEL_REFRESH_PROBE_REPLAY_REFUSED")
            self._refresh_started = True
            data = urllib.parse.urlencode(self._refresh).encode()
            headers = {"Content-Type": "application/x-www-form-urlencoded", "Version": "2021-07-28"}
        else:
            data = None if body is None else json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(origin + path, method=method, data=data, headers={**headers, "Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                demand(200 <= response.status < 300 and len(raw) <= 2_000_000, "CRM_SHIPPING_RESPONSE_REFUSED")
                value = json.loads(raw)
                demand(isinstance(value, (dict, list)), "CRM_SHIPPING_RESPONSE_REFUSED")
                if refresh:
                    # A usable refresh may rotate a single-use credential. Never
                    # return tokens or replay it; retain an unresolved attempt.
                    return {"refreshDenied": False}
                return value
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = error.read(65_537)
                value = json.loads(raw) if len(raw) <= 65_536 else None
                refresh_denied = refresh and status in (400, 401) and isinstance(value, dict) and value.get("error") == "invalid_grant"
            except (ValueError, TypeError):
                refresh_denied = False
            finally:
                error.close()
            if refresh_denied:
                return {"refreshDenied": True}
            if status == 401 and not refresh:
                raise AuthenticationDenied("CRM_SHIPPING_AUTHENTICATION_DENIED") from None
            raise ValueError("CRM_SHIPPING_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("CRM_SHIPPING_REQUEST_FAILED_REQUIRES_REVIEW") from None


def database_queries(provider, reviewed):
    """Fixed read-only SQL; no credential/ciphertext, message or PII columns.

    Host bridge must read *every* query in one read-only repeatable-read
    transaction, then perform the same reads after provider observation.
    Unscoped CRM outbox/marketing rows conservatively remain in the inventory.
    """
    review(provider, reviewed)
    if provider == "chitchats":
        return [
            ("shipments", "SELECT id::text, public_reference, provider_shipment_id, provider_status, status::text, state_version, selected_postage_type, actual_purchase_total_cents, provider_cost_currency, purchased_at::text, delivered_at::text FROM product_shipments WHERE provider='chitchats' ORDER BY id", []),
            ("jobs", "SELECT j.id::text, j.shipment_id::text, j.type::text, j.status::text, j.state_version, encode(sha256(convert_to(j.idempotency_key,'UTF8')),'hex') AS idempotency_sha256, j.operation_payload_hash, j.outcome_unknown, (j.lease_owner IS NOT NULL OR j.lease_expires_at IS NOT NULL) AS lease_held, j.completed_at::text FROM product_shipment_jobs j JOIN product_shipments s ON s.id=j.shipment_id WHERE s.provider='chitchats' ORDER BY j.id", [])
        ]
    location = [reviewed["locationId"]]
    return [
        ("contacts", "SELECT id::text, location_id, provider_id, encode(sha256(convert_to(email_normalized,'UTF8')),'hex') AS email_sha256, deleted_at::text, last_synced_at::text FROM highlevel_contacts WHERE location_id=$1 ORDER BY id", location),
        ("effects", "SELECT e.key, e.contact_id::text, e.kind, e.provider_id, e.state, jsonb_build_object('workflow',e.data->>'workflow','journey',e.data->>'journey') AS data FROM highlevel_effects e JOIN highlevel_contacts c ON c.id=e.contact_id WHERE c.location_id=$1 ORDER BY e.key", location),
        ("outbox", "SELECT id::text, encode(sha256(convert_to(event_key,'UTF8')),'hex') AS idempotency_sha256, entity_type, entity_id, status, (locked_by IS NOT NULL OR locked_until IS NOT NULL) AS lease_held, completed_at::text FROM highlevel_outbox ORDER BY id", []),
        ("connections", "SELECT location_id, installed_by::text, refresh_state, (credentials_ciphertext='[revoked]') AS credentials_revoked, expires_at::text, updated_at::text FROM highlevel_connections WHERE location_id=$1 ORDER BY location_id", location),
        ("webhookReceipts", "SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS receipt_sha256, location_id, event_type, provider_contact_id, received_at::text FROM highlevel_webhook_receipts WHERE location_id=$1 ORDER BY key", location),
        ("marketingDeliveries", "SELECT id::text, status, provider_message_id, sent_at::text FROM customer_email_outbox WHERE delivery_provider='highlevel' ORDER BY id", [])
    ]


def database_snapshot(provider, reviewed, actual):
    keys = [name for name, _sql, _params in database_queries(provider, reviewed)]
    demand(isinstance(actual, dict) and set(actual) == set(keys) and all(isinstance(actual[name], list) and len(actual[name]) <= MAXIMUM_ROWS and
        all(isinstance(row, dict) for row in actual[name]) for name in keys), "CRM_SHIPPING_ACTUAL_DATABASE_SNAPSHOT_REQUIRED")
    demand(snapshot_sha256(actual) == reviewed["databaseSnapshotSha256"], "CRM_SHIPPING_DATABASE_SNAPSHOT_CHANGED")
    return actual


def _safe_before_snapshot(provider, reviewed, actual):
    database_snapshot(provider, reviewed, actual)
    columns = {
        "shipments": "id public_reference provider_shipment_id provider_status status state_version selected_postage_type actual_purchase_total_cents provider_cost_currency purchased_at delivered_at",
        "jobs": "id shipment_id type status state_version idempotency_sha256 operation_payload_hash outcome_unknown lease_held completed_at",
        "contacts": "id location_id provider_id email_sha256 deleted_at last_synced_at",
        "effects": "key contact_id kind provider_id state data",
        "outbox": "id idempotency_sha256 entity_type entity_id status lease_held completed_at",
        "connections": "location_id installed_by refresh_state credentials_revoked expires_at updated_at",
        "webhookReceipts": "receipt_sha256 location_id event_type provider_contact_id received_at",
        "marketingDeliveries": "id status provider_message_id sent_at",
    }
    for kind, rows in actual.items():
        demand(all(set(row) == set(columns[kind].split()) for row in rows), "CRM_SHIPPING_BEFORE_SNAPSHOT_COLUMN_REFUSED")
        if kind == "effects":
            demand(all(isinstance(row["data"], dict) and set(row["data"]) <= {"workflow", "journey"} and
                all(value is None or identifier(value) for value in row["data"].values()) for row in rows), "HIGHLEVEL_BEFORE_EFFECT_DATA_REFUSED")
    return json.loads(json.dumps(actual))


def _instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        demand(parsed.tzinfo is not None, "CRM_SHIPPING_TIMESTAMP_REQUIRED")
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise ValueError("CRM_SHIPPING_TIMESTAMP_REQUIRED") from None


def _current_review(provider, reviewed, actual, before):
    """Only the source's declared AppUninstall persistence may advance PREstate.

    This reducer accepts concrete rows and provider denial still follows. It
    never accepts caller completion flags, a new reviewed artifact or a rebase.
    """
    original = before.get("databaseSnapshot")
    demand(isinstance(original, dict) and snapshot_sha256(original) == before.get("beforeDatabaseSnapshotSha256") == reviewed["databaseSnapshotSha256"],
        "CRM_SHIPPING_ORIGINAL_DATABASE_RECEIPT_REQUIRED")
    if snapshot_sha256(actual) == reviewed["databaseSnapshotSha256"]:
        return reviewed, None
    demand(provider == "highlevel" and reviewed["credentialKind"] == "oauth-installation" and isinstance(actual, dict) and set(actual) == set(original),
        "CRM_SHIPPING_UNDECLARED_DATABASE_TRANSITION")
    for kind in original:
        if kind not in ("connections", "webhookReceipts"):
            demand(actual[kind] == original[kind], "CRM_SHIPPING_UNDECLARED_DATABASE_TRANSITION")
    old_connections, new_connections = original["connections"], actual["connections"]
    demand(isinstance(new_connections, list) and len(old_connections) == len(new_connections) == 1, "HIGHLEVEL_UNINSTALL_CONNECTION_RECEIPT_REQUIRED")
    old, new = old_connections[0], new_connections[0]
    demand(isinstance(new, dict) and set(new) == set(old) and old.get("location_id") == new.get("location_id") == reviewed["locationId"] and
        old.get("refresh_state") in ("ready", "refreshing", "reconnect") and old.get("credentials_revoked") is False and
        new.get("refresh_state") == "revoked" and new.get("credentials_revoked") is True and
        all(new[key] == value for key, value in old.items() if key not in ("refresh_state", "credentials_revoked", "updated_at")),
        "HIGHLEVEL_UNINSTALL_CONNECTION_RECEIPT_REQUIRED")
    previous = {row["receipt_sha256"]: row for row in original["webhookReceipts"]}
    current = actual["webhookReceipts"]
    demand(isinstance(current, list) and len(current) == len(previous) + 1 and all(isinstance(row, dict) and digest(row.get("receipt_sha256")) for row in current),
        "HIGHLEVEL_UNINSTALL_WEBHOOK_RECEIPT_REQUIRED")
    indexed = {row["receipt_sha256"]: row for row in current}
    demand(len(indexed) == len(current) and all(indexed.get(key) == value for key, value in previous.items()), "HIGHLEVEL_UNINSTALL_EXISTING_RECEIPT_CHANGED")
    added = [row for key, row in indexed.items() if key not in previous]
    receipt = added[0]
    demand(set(receipt) == {"receipt_sha256", "location_id", "event_type", "provider_contact_id", "received_at"} and
        receipt["location_id"] == reviewed["locationId"] and receipt["event_type"] in ("AppUninstall", "UNINSTALL") and
        receipt["provider_contact_id"] in (None, reviewed["appId"]) and
        _instant(new["updated_at"]) == _instant(receipt["received_at"]) >= _instant(old["updated_at"]),
        "HIGHLEVEL_UNINSTALL_WEBHOOK_RECEIPT_REQUIRED")
    observed = {**reviewed, "databaseSnapshotSha256": snapshot_sha256(actual)}
    _safe_before_snapshot(provider, observed, actual)
    return observed, {"kind": "source-AppUninstall-persistence", "receiptSha256": receipt["receipt_sha256"],
        "beforeDatabaseSnapshotSha256": reviewed["databaseSnapshotSha256"], "currentDatabaseSnapshotSha256": observed["databaseSnapshotSha256"]}


def highlevel_binding(client, reviewed):
    value = client.request("GET", "/locations/" + reviewed["locationId"])
    row = value.get("location") if isinstance(value, dict) else None
    demand(isinstance(row, dict) and row.get("id") == reviewed["locationId"] and row.get("companyId") == reviewed["companyId"],
        "HIGHLEVEL_ACTUAL_TENANT_BINDING_REFUSED")
    return {"locationId": row["id"], "companyId": row["companyId"]}


def highlevel_inventory(client, reviewed):
    binding = highlevel_binding(client, reviewed)
    rows, seen, total = [], set(), None
    for page in range(1, 43):
        value = client.request("POST", "/contacts/search", {"locationId": reviewed["locationId"], "pageLimit": 100, "page": page})
        data = value.get("contacts") if isinstance(value, dict) else None
        count = value.get("total") if isinstance(value, dict) else None
        demand(type(count) is int and 0 <= count <= MAXIMUM_ROWS and isinstance(data, list) and len(data) <= 100 and
            (total is None or total == count), "HIGHLEVEL_CONTACT_PAGE_INCOMPLETE")
        total = count
        for row in data:
            item = row.get("id") if isinstance(row, dict) else None
            demand(identifier(item) and item not in seen and row.get("locationId") == reviewed["locationId"], "HIGHLEVEL_CONTACT_INVENTORY_REFUSED")
            seen.add(item); rows.append(item)
        if len(data) < 100:
            demand(len(rows) == total, "HIGHLEVEL_CONTACT_COUNT_MISMATCH")
            break
    else:
        raise ValueError("HIGHLEVEL_CONTACT_INVENTORY_LIMIT")
    safe, workflow_ids, cursors, workflow_total = [], set(), set(), None
    body = {"limit": 100, "sort": [{"field": "workflowId", "direction": "asc"}], "offset": 0}
    for _page in range(42):
        value = client.request("POST", "/workflows/search?locationId=" + reviewed["locationId"], body)
        workflows = value.get("workflows") if isinstance(value, dict) else None
        count, total_count = (value.get("count"), value.get("total")) if isinstance(value, dict) else (None, None)
        demand(isinstance(workflows, list) and len(workflows) <= 100 and type(count) is int and count == len(workflows) and
            type(total_count) is int and 0 <= total_count <= MAXIMUM_ROWS and (workflow_total is None or workflow_total == total_count),
            "HIGHLEVEL_WORKFLOW_PAGE_INCOMPLETE")
        workflow_total = total_count
        for row in workflows:
            demand(isinstance(row, dict) and identifier(row.get("id")) and row["id"] not in workflow_ids and
                row.get("status") in ("draft", "published"), "HIGHLEVEL_WORKFLOW_SCOPE_REFUSED")
            workflow_ids.add(row["id"])
            safe.append({"workflowId": row["id"], "status": row["status"]})
        cursor = value.get("searchAfter")
        if cursor is None:
            demand(len(safe) == workflow_total, "HIGHLEVEL_WORKFLOW_COUNT_MISMATCH")
            break
        demand(workflows and isinstance(cursor, list) and 0 < len(cursor) <= 8 and all(isinstance(item, str) and 0 < len(item) <= 256 for item in cursor) and
            json.dumps(cursor) not in cursors, "HIGHLEVEL_WORKFLOW_CURSOR_REFUSED")
        cursors.add(json.dumps(cursor))
        body = {"limit": 100, "sort": [{"field": "workflowId", "direction": "asc"}], "searchAfter": cursor}
    else:
        raise ValueError("HIGHLEVEL_WORKFLOW_INVENTORY_LIMIT")
    ids = sorted(row["workflowId"] for row in safe)
    demand(sorted(rows) == reviewed["expectedProviderContactIds"] and ids == sorted(set(ids)) == reviewed["expectedWorkflowIds"],
        "HIGHLEVEL_REVIEWED_INVENTORY_CHANGED")
    return {**binding, "providerContactIds": sorted(rows), "workflows": sorted(safe, key=lambda row: row["workflowId"])}


def _shipment_summary(row):
    demand(isinstance(row, dict) and identifier(row.get("id")) and isinstance(row.get("status"), str) and re.fullmatch(r"[a-z_]{1,40}", row["status"]),
        "CHITCHATS_SHIPMENT_RESPONSE_REFUSED")
    return {key: row.get(key) for key in ("id", "status", "order_id", "postage_type", "purchase_amount")}


def chitchats_inventory(client, reviewed):
    prefix = "/api/v1/clients/" + reviewed["clientId"] + "/shipments"
    before = client.request("GET", prefix + "/count")
    count = before.get("count") if isinstance(before, dict) else None
    demand(type(count) is int and 0 <= count <= MAXIMUM_ROWS, "CHITCHATS_COUNT_REFUSED")
    rows, seen = [], set()
    for page in range(1, 43):
        value = client.request("GET", prefix + "?limit=100&page=" + str(page))
        data = value if isinstance(value, list) else value.get("shipments") if isinstance(value, dict) else None
        demand(isinstance(data, list) and len(data) <= 100, "CHITCHATS_SHIPMENT_PAGE_REFUSED")
        for row in data:
            safe = _shipment_summary(row)
            demand(safe["id"] not in seen and len(rows) < MAXIMUM_ROWS, "CHITCHATS_SHIPMENT_INVENTORY_DUPLICATE_OR_LIMIT")
            rows.append(safe); seen.add(safe["id"])
        if len(data) < 100:
            break
    else:
        raise ValueError("CHITCHATS_SHIPMENT_INVENTORY_LIMIT")
    demand(client.request("GET", prefix + "/count") == before and len(rows) == count, "CHITCHATS_SHIPMENT_COUNT_MISMATCH")
    demand(sorted(seen) == reviewed["expectedProviderShipmentIds"], "CHITCHATS_REVIEWED_INVENTORY_CHANGED")
    return {"clientId": reviewed["clientId"], "shipments": sorted(rows, key=lambda row: row["id"])}


def _money(value):
    if not isinstance(value, (str, int)) or isinstance(value, bool) or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?", str(value)):
        return None
    whole, _, fraction = str(value).partition(".")
    return int(whole) * 100 + int((fraction + "00")[:2])


def _denied(client, task):
    try:
        task(client)
    except AuthenticationDenied:
        return True
    return False


def observe_chitchats(replacement, retired, reviewed, actual_rows):
    review("chitchats", reviewed)
    actual = database_snapshot("chitchats", reviewed, actual_rows)
    first = chitchats_inventory(replacement, reviewed)
    old_denied = _denied(retired, lambda client: client.request("GET", "/api/v1/clients/" + reviewed["clientId"] + "/shipments/count"))
    providers = {row["id"]: row for row in first["shipments"]}
    seen, effects = set(), []
    shipment_ids = set()
    for row in actual["shipments"]:
        item = row.get("provider_shipment_id")
        demand(identifier(row.get("id")) and row["id"] not in shipment_ids and identifier(row.get("public_reference")) and (item is None or identifier(item)), "CHITCHATS_DATABASE_SHIPMENT_REFUSED")
        shipment_ids.add(row["id"])
        result = {"recordId": row["id"], "databaseRowSha256": snapshot_sha256(row), "providerId": item,
            "databaseStatus": row.get("status"), "immutableMatch": False, "storedOutcomeConsistent": False}
        if item in providers:
            demand(item not in seen, "CHITCHATS_DATABASE_PROVIDER_ID_DUPLICATE")
            seen.add(item)
            value = replacement.request("GET", "/api/v1/clients/" + reviewed["clientId"] + "/shipments/" + item)
            remote = _shipment_summary(value.get("shipment") if isinstance(value, dict) else None)
            demand(remote == providers[item], "CHITCHATS_SHIPMENT_CHANGED_DURING_READBACK")
            matches = (remote["id"] == item and remote["order_id"] == row["public_reference"] and
                row.get("selected_postage_type") is not None and remote["postage_type"] == row["selected_postage_type"] and
                type(row.get("actual_purchase_total_cents")) is int and _money(remote["purchase_amount"]) == row["actual_purchase_total_cents"] and
                row.get("provider_cost_currency") == "CAD")
            normalized = ACKNOWLEDGED_SHIPMENT_STATES.get(remote["status"])
            acknowledged = normalized is not None and row.get("status") == normalized and ACKNOWLEDGED_SHIPMENT_STATES.get(row.get("provider_status")) == normalized
            result.update(providerStatus=remote["status"], immutableMatch=matches, storedOutcomeConsistent=matches and acknowledged)
        if not result["storedOutcomeConsistent"]:
            result["unresolvedReason"] = "missing-or-mismatched-provider-object-or-unreconciled-provider-state"
        effects.append(result)
    jobs, job_ids, shipment_receipts = [], set(), {}
    for row in actual["jobs"]:
        demand(identifier(row.get("id")) and row["id"] not in job_ids and row.get("shipment_id") in shipment_ids and digest(row.get("idempotency_sha256")),
            "CHITCHATS_DATABASE_JOB_BINDING_REFUSED")
        job_ids.add(row["id"])
        settled = (row.get("status") == "succeeded" and row.get("type") in ("create", "quote_refresh", "purchase", "tracking", "refund", "delete", "cleanup") and
            row.get("outcome_unknown") is False and row.get("lease_held") is False and row.get("completed_at") is not None and digest(row.get("operation_payload_hash")))
        jobs.append({"recordId": row["id"], "databaseRowSha256": snapshot_sha256(row), "idempotencySha256": row["idempotency_sha256"],
            "databaseStatus": row.get("status"), "storedOutcomeConsistent": bool(settled)})
        shipment_receipts.setdefault(row["shipment_id"], []).append((row.get("type"), bool(settled)))
    deferred = []
    for effect in effects:
        receipts = shipment_receipts.get(effect["recordId"], [])
        known = receipts and all(settled for _kind, settled in receipts) and any(kind in ("purchase", "tracking", "refund") for kind, _settled in receipts)
        if not known:
            effect.update(storedOutcomeConsistent=False, unresolvedReason="missing-or-unsettled-operation-receipt")
        elif effect["storedOutcomeConsistent"] and effect["providerStatus"] not in ("delivered", "voided"):
            deferred.append(effect["providerId"])
    second = chitchats_inventory(replacement, reviewed)
    demand(first == second, "CHITCHATS_INVENTORY_CHANGED_DURING_OBSERVATION")
    unknown = len(set(providers) - seen)
    unresolved = sum(not row["storedOutcomeConsistent"] for row in effects + jobs) + unknown
    # Numeric zero is scoped to the fully enumerated staging client + source
    # database snapshot. It is never a historical-writer or financial drain.
    return {"provider": "chitchats", "status": "STAGING_CHITCHATS_CLIENT_EFFECTS_OBSERVED", "clientId": reviewed["clientId"],
        "sourceBindingSha256": reviewed["sourceBindingSha256"], "databaseSnapshotSha256": reviewed["databaseSnapshotSha256"],
        "retiredCredentialDenied": old_denied, "replacementReadVerified": True, "providerInventoryComplete": True,
        "providerShipmentIds": sorted(providers), "knownEffects": effects, "knownJobs": jobs, "unmappedProviderShipments": unknown,
        "knownUnresolvedEffects": unresolved, "activeExecutions": sum(row.get("status") == "processing" for row in actual["jobs"]), "uncertainEffects": unresolved,
        "deferredPhysicalShipmentIds": sorted(deferred), "compatiblePollingRequired": bool(deferred), "futurePollingAuthorized": False,
        "historicalWritersFenced": False, "inboundWebhooksQualified": False, "runtimeReplacementBindingVerified": False, "trafficAuthorized": False}


def observe_highlevel(replacement, retired, reviewed, actual_rows):
    review("highlevel", reviewed)
    actual = database_snapshot("highlevel", reviewed, actual_rows)
    first = highlevel_inventory(replacement, reviewed)
    old_denied = _denied(retired, lambda client: highlevel_binding(client, reviewed))
    contacts, safe = {}, []
    for row in actual["contacts"]:
        demand(identifier(row.get("id")) and row.get("location_id") == reviewed["locationId"] and digest(row.get("email_sha256")), "HIGHLEVEL_DATABASE_CONTACT_REFUSED")
        item = row.get("provider_id")
        remote = None
        if item in first["providerContactIds"]:
            value = replacement.request("GET", "/contacts/" + item)
            remote = value.get("contact") if isinstance(value, dict) else None
        match = (isinstance(remote, dict) and remote.get("id") == item and remote.get("locationId") == reviewed["locationId"] and
            isinstance(remote.get("email"), str) and hashlib.sha256(remote["email"].strip().lower().encode()).hexdigest() == row["email_sha256"] and row.get("deleted_at") is None)
        contacts[row["id"]] = (row, bool(match))
        safe.append({"recordId": row["id"], "providerId": item, "databaseRowSha256": snapshot_sha256(row), "immutableMatch": bool(match)})
    effects = []
    for row in actual["effects"]:
        demand(isinstance(row.get("key"), str) and row.get("contact_id") in contacts, "HIGHLEVEL_DATABASE_EFFECT_REFUSED")
        contact, matched = contacts[row["contact_id"]]
        result = {"idempotencySha256": hashlib.sha256(row["key"].encode()).hexdigest(), "databaseRowSha256": snapshot_sha256(row),
            "kind": row.get("kind"), "databaseStatus": row.get("state"), "storedOutcomeConsistent": False}
        if matched and row.get("kind") == "entity" and row.get("state") == "recorded":
            result["storedOutcomeConsistent"] = True
        elif matched and row.get("state") == "succeeded" and row.get("kind") in ("note", "task", "opportunity") and identifier(row.get("provider_id")):
            kind, item = row["kind"], row["provider_id"]
            path = "/opportunities/" + item if kind == "opportunity" else "/contacts/" + contact["provider_id"] + "/" + kind + "s/" + item
            value = replacement.request("GET", path)
            remote = value.get(kind) if isinstance(value, dict) else None
            match = isinstance(remote, dict) and remote.get("id") == item and remote.get("contactId") == contact["provider_id"]
            if kind == "opportunity":
                key = row["key"].split(":")
                match = (match and len(key) == 4 and key[0] == "opportunity" and key[1] == contact["id"] and
                    remote.get("pipelineId") == key[2] and remote.get("locationId") == reviewed["locationId"] and remote.get("status") in ("won", "lost", "abandoned"))
            elif kind == "note":
                match = match and row["key"].startswith("note:") and isinstance(remote.get("body"), str) and remote["body"].startswith("[LH submission " + row["key"][5:] + "]\n")
            else:
                match = match and remote.get("completed") is True
            result["storedOutcomeConsistent"] = bool(match)
        if not result["storedOutcomeConsistent"]:
            result["unresolvedReason"] = "workflow-or-missing-immutable-receipt-or-nonterminal-outcome"
        effects.append(result)
    demand(first == highlevel_inventory(replacement, reviewed), "HIGHLEVEL_INVENTORY_CHANGED_DURING_OBSERVATION")
    unbound = len(set(first["providerContactIds"]) - {row.get("provider_id") for row in actual["contacts"]})
    pending = sum(row.get("status") not in ("succeeded", "skipped") or row.get("lease_held") is not False or row.get("completed_at") is None for row in actual["outbox"])
    deliveries = sum(row.get("status") not in ("sent", "suppressed") for row in actual["marketingDeliveries"])
    return {"provider": "highlevel", "status": "STAGING_HIGHLEVEL_KNOWN_EFFECTS_OBSERVED", **{key: first[key] for key in ("locationId", "companyId", "providerContactIds", "workflows")},
        "sourceBindingSha256": reviewed["sourceBindingSha256"], "databaseSnapshotSha256": reviewed["databaseSnapshotSha256"],
        "credentialKind": reviewed["credentialKind"], "retiredCredentialDenied": old_denied, "retiredRefreshDenied": None if reviewed["credentialKind"] == "oauth-installation" else True,
        "replacementReadVerified": True, "knownContacts": safe, "knownEffects": effects, "unmappedProviderContacts": unbound,
        "knownUnresolvedEffects": unbound + pending + deliveries + sum(not row["immutableMatch"] for row in safe) + sum(not row["storedOutcomeConsistent"] for row in effects),
        "workflowExecutionInventoryComplete": False, "inboundWebhooksQualified": False, "activeExecutions": None, "uncertainEffects": None,
        "historicalWritersFenced": False, "runtimeReplacementBindingVerified": False, "trafficAuthorized": False}


def suspend(provider, replacement, retired, reviewed, actual_rows, selected, attempt):
    """Read both principals before the existing operator's console action."""
    review(provider, reviewed)
    migrate.private_directory(attempt)
    database = _safe_before_snapshot(provider, reviewed, actual_rows)
    inventory = highlevel_inventory if provider == "highlevel" else chitchats_inventory
    before = inventory(replacement, reviewed)
    demand(inventory(retired, reviewed) == before == inventory(replacement, reviewed), "CRM_SHIPPING_OLD_PRINCIPAL_SCOPE_UNVERIFIED")
    receipt = {**selected, "provider": provider, "status": "CONSOLE_RETIREMENT_PENDING", "retirementBindingSha256": retirement_binding_sha256(reviewed),
        "beforeInventorySha256": snapshot_sha256(before), "beforeDatabaseSnapshotSha256": reviewed["databaseSnapshotSha256"], "databaseSnapshot": database,
        "sourceBindingSha256": reviewed["sourceBindingSha256"], "retiredCredentialBindingSha256": reviewed["retiredCredentialBindingSha256"],
        "replacementCredentialBindingSha256": reviewed["replacementCredentialBindingSha256"], "retiredCredentialWasUsable": True,
        "scopeIds": {key: before[key] for key in ("clientId",) if key in before} or {key: before[key] for key in ("locationId", "companyId")},
        "activeExecutions": None, "uncertainEffects": None, "trafficAuthorized": False}
    migrate.write_json(attempt, provider + "-retirement-before.json", receipt)
    return receipt


def verify_retirement(provider, replacement, retired, reviewed, actual_rows, selected, attempt):
    review(provider, reviewed)
    migrate.private_directory(attempt)
    before = migrate.read_json(attempt, provider + "-retirement-before.json")
    demand(before.get("retirementBindingSha256") == retirement_binding_sha256(reviewed) and before.get("retiredCredentialWasUsable") is True and
        all(before.get(key) == value for key, value in selected.items()), "CRM_SHIPPING_PRE_RETIREMENT_RECEIPT_REQUIRED")
    current_review, transition = _current_review(provider, reviewed, actual_rows, before)
    outcome = {**selected, "provider": provider, "status": "RETIREMENT_VERIFICATION_UNRESOLVED", "retiredCredentialDenied": False,
        "retiredRefreshDenied": None, "activeExecutions": None, "uncertainEffects": None, "trafficAuthorized": False}
    migrate.write_json(attempt, provider + "-retirement-verification-started.json", outcome)
    try:
        observe = observe_highlevel if provider == "highlevel" else observe_chitchats
        observed = observe(replacement, retired, current_review, actual_rows)
        outcome.update(observed)
        outcome["status"] = "RETIREMENT_VERIFICATION_UNRESOLVED"
        outcome["expectedDatabaseTransition"] = transition
        outcome["reviewedDatabaseSnapshotSha256"] = reviewed["databaseSnapshotSha256"]
        demand(observed["retiredCredentialDenied"] is True, "CRM_SHIPPING_RETIRED_CREDENTIAL_STILL_USABLE")
        if provider == "highlevel" and reviewed["credentialKind"] == "oauth-installation":
            # One source-locked refresh probe only. A lost response or usable
            # refresh consumes this attempt and never authorizes a replay.
            refreshed = retired.request("POST", "/oauth/token")
            outcome["retiredRefreshDenied"] = refreshed.get("refreshDenied") is True
            demand(outcome["retiredRefreshDenied"], "HIGHLEVEL_RETIRED_REFRESH_CHAIN_UNRESOLVED")
        outcome["status"] = "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED"
        return outcome
    finally:
        migrate.write_json(attempt, provider + "-retirement-outcome.json", outcome)


def observe_retirement(provider, replacement, retired, reviewed, actual_rows, selected, original_attempt):
    """Recovery readback; original receipts remain immutable, refresh not replayed."""
    review(provider, reviewed)
    migrate.private_directory(original_attempt)
    before = migrate.read_json(original_attempt, provider + "-retirement-before.json")
    demand(before.get("retirementBindingSha256") == retirement_binding_sha256(reviewed) and before.get("retiredCredentialWasUsable") is True and
        all(before.get(key) == value for key, value in selected.items()), "CRM_SHIPPING_PRE_RETIREMENT_RECEIPT_REQUIRED")
    current_review, transition = _current_review(provider, reviewed, actual_rows, before)
    observe = observe_highlevel if provider == "highlevel" else observe_chitchats
    result = observe(replacement, retired, current_review, actual_rows)
    try:
        original = migrate.read_json(original_attempt, provider + "-retirement-outcome.json")
    except FileNotFoundError:
        original = None
    if original is not None:
        demand(original.get("provider") == provider and all(original.get(key) == value for key, value in selected.items()),
            "CRM_SHIPPING_ORIGINAL_RETIREMENT_IDENTITY_REFUSED")
    if provider == "highlevel" and reviewed["credentialKind"] == "oauth-installation":
        result["retiredRefreshDenied"] = (True if result["retiredCredentialDenied"] is True and isinstance(original, dict) and
            original.get("status") == "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED" and original.get("retiredRefreshDenied") is True else None)
    return {**result, "expectedDatabaseTransition": transition, "reviewedDatabaseSnapshotSha256": reviewed["databaseSnapshotSha256"],
        "refreshProbed": False, "originalRetirementObservationSha256": snapshot_sha256(original) if original is not None else None}
