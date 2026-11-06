"""Read-only, source-bound HighLevel history observations for the locked worker.

No credential discovery, live CLI, provider mutation, message bodies in receipts,
or inference of all-time absence from a retained database/API window. The parent
must execute every fixed query before and after these observations under its
existing lock and must verify original configuration/source proofs separately.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from urllib.parse import parse_qsl, urlencode, urlsplit

import migrate

demand = migrate.demand
MAXIMUM = 4096
PRODUCTION_LOCATION = "vd09FLBpPLXuHb5Tnhn4"
FAMILIES = tuple("highlevel." + item for item in
    ("contacts", "workflows", "tasks", "opportunities", "conversations", "messages", "webhooks", "oauth"))
ACTIVE_WORKFLOW = {"added_to_workflow", "waiting", "retry", "drip_queued", "processing", "paused_due_to_draft_mode"}
OTHER_WORKFLOW = {"success", "error", "failed", "failed_retry_limit_reached", "skipped", "wait_finished",
    "finished", "contact_merged", "drip_resume", "winner_declared"}
ACTIVE_MESSAGE = {"pending", "scheduled"}
DELIVERED_MESSAGE = {"delivered", "opened", "read", "clicked"}
OBSERVATIONS = {
    "workflow-intent-execution-and-downstream-join": {
        "supportedSurface": "Automations > Workflows > selected workflow > Enrollment History > selected enrollment > Execution Details; Conversations > message details > Workflow",
        "positiveEvidence": "Original execution receipt must identify the exact source intent, workflow, contact and execution; explicit execution exit plus every downstream message outcome must match. Workflow acceptance/removal alone is insufficient."},
    "workflow-history-outside-retained-window": {
        "supportedSurface": "Selected workflow Enrollment History and Execution Logs with every page and all statuses for each source period; original retained per-execution records for expired periods",
        "positiveEvidence": "Observed current waiting/running/retry state and terminal execution/message receipts for the complete source scope. Console contact tracing also has 60-day retention; unavailable older records remain unknown."},
    "original-webhook-configuration-caller-and-retry-state": {
        "supportedSurface": "Selected Marketplace app Webhooks settings; Developer Portal > Insights > Logs > Webhook Logs; selected deployment ingress and caller observations",
        "positiveEvidence": "Exact app/location/source endpoint and event subscriptions, all relevant delivery/retry attempts and matching SQL persistence, plus actual caller/ingress fence receipts. The 30-day dashboard cannot certify older absence."},
    "original-oauth-and-static-credential-capability-scope": {
        "supportedSurface": "Original deployment configuration and selected sub-account integration/installation records",
        "positiveEvidence": "Source-bound original configuration and complete credential/intent observations. Current switches, uninstall or connected-account lists alone do not establish absence."},
    "source-reachable-untracked-provider-requests": {
        "supportedSurface": "Original source/configuration records and supported provider object/execution readbacks",
        "positiveEvidence": "Source-specific immutable request/outcome evidence, including direct contact updates/removals and callbacks. Missing source intent/execution identity remains unresolved."},
}


def sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
        ensure_ascii=True, allow_nan=False).encode()).hexdigest()


snapshot_sha256 = sha256


def _digest(value, length=64):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", value) is not None and value != "0" * length


def _id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,192}", value) is not None


def _requirement_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_.-]{0,191}", value) is not None


def _instant(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        demand(result.utcoffset() == timedelta(0), "HIGHLEVEL_HISTORY_UTC_REQUIRED")
        return result
    except (ValueError, TypeError, AttributeError):
        raise ValueError("HIGHLEVEL_HISTORY_UTC_REQUIRED") from None


def _review(reviewed):
    demand(isinstance(reviewed, dict) and reviewed.get("environment") == "staging" and
        _id(reviewed.get("locationId")) and reviewed["locationId"] != PRODUCTION_LOCATION and
        _id(reviewed.get("companyId")) and _digest(reviewed.get("sourceBindingSha256")),
        "HIGHLEVEL_HISTORY_STAGING_SCOPE_REQUIRED")
    for field in ("expectedProviderContactIds", "expectedWorkflowIds"):
        rows = reviewed.get(field)
        demand(isinstance(rows, list) and len(rows) <= MAXIMUM and all(_id(item) for item in rows) and rows == sorted(set(rows)),
            "HIGHLEVEL_HISTORY_REVIEWED_INVENTORY_REQUIRED")
    return reviewed


def read_only_request(method, path, body, reviewed):
    """Closed documented transport surface, used by the parent's fixed-origin client."""
    try:
        _review(reviewed)
        if method != "GET" or body is not None or not isinstance(path, str) or len(path) > 4096:
            return False
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.fragment or not path.startswith("/"):
            return False
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        query = dict(pairs)
        if len(query) != len(pairs) or urlencode(query) != parsed.query:
            return False
        contacts, workflows = reviewed["expectedProviderContactIds"], reviewed["expectedWorkflowIds"]
        if not query:
            return parsed.path == "/locations/" + reviewed["locationId"] or parsed.path in ("/contacts/" + item for item in contacts) or \
                any(re.fullmatch(re.escape("/contacts/" + item) + r"/(?:notes|tasks)/[A-Za-z0-9_-]{1,192}", parsed.path) for item in contacts) or \
                re.fullmatch(r"/(?:opportunities|conversations/messages)/[A-Za-z0-9_-]{1,192}", parsed.path) is not None
        if parsed.path == "/conversations/search":
            return set(query) == {"locationId", "contactId", "limit", "sort", "sortBy", "status"} and \
                query == {"locationId": reviewed["locationId"], "contactId": query["contactId"], "limit": "100", "sort": "asc",
                    "sortBy": "last_message_date", "status": "all"} and query["contactId"] in contacts
        if re.fullmatch(r"/conversations/[A-Za-z0-9_-]{1,192}/messages", parsed.path):
            return set(query) in ({"limit"}, {"limit", "lastMessageId"}) and query.get("limit") == "100" and \
                ("lastMessageId" not in query or _id(query["lastMessageId"]))
        if parsed.path not in ("/workflows/" + item + "/logs" for item in workflows):
            return False
        history = reviewed.get("history", {})
        fixed = {"locationId": reviewed["locationId"], "limit": "100", "startDate": history.get("windowStart"), "endDate": history.get("windowEnd")}
        if any(query.get(key) != value for key, value in fixed.items()):
            return False
        if query.get("action") == "first":
            return set(query) == set(fixed) | {"action"}
        return query.get("action") == "next" and set(query) == set(fixed) | {"action", "referenceId", "referenceCreatedAt"} and \
            _id(query["referenceId"]) and _instant(fixed["startDate"]) <= _instant(query["referenceCreatedAt"]) <= _instant(fixed["endDate"])
    except (ValueError, TypeError, KeyError):
        return False


def database_queries(reviewed):
    """Literal SELECT triples; global unscoped callers cannot disappear by tenant filtering."""
    _review(reviewed)
    location = [reviewed["locationId"]]
    return [
        ("historyContacts", "SELECT id::text, location_id, provider_id, encode(sha256(convert_to(email_normalized,'UTF8')),'hex') AS email_sha256, deleted_at::text, created_at::text, updated_at::text FROM highlevel_contacts WHERE location_id=$1 ORDER BY id", location),
        ("historyEffects", "SELECT e.key, e.contact_id::text, e.kind, e.provider_id, e.state, jsonb_build_object('workflow',e.data->>'workflow','journey',e.data->>'journey','pipeline',e.data->>'pipeline') AS data, e.created_at::text, e.updated_at::text FROM highlevel_effects e JOIN highlevel_contacts c ON c.id=e.contact_id WHERE c.location_id=$1 ORDER BY e.key", location),
        ("historyOutbox", "SELECT id::text, encode(sha256(convert_to(event_key,'UTF8')),'hex') AS idempotency_sha256, entity_type, entity_id, event_type, historical, status, (locked_by IS NOT NULL OR locked_until IS NOT NULL) AS lease_held, occurred_at::text, created_at::text, completed_at::text FROM highlevel_outbox ORDER BY id", []),
        ("historyConnections", "SELECT location_id, refresh_state, (credentials_ciphertext='[revoked]') AS credentials_revoked, expires_at::text, updated_at::text FROM highlevel_connections WHERE location_id=$1 ORDER BY location_id", location),
        ("historyWebhooks", "SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS receipt_sha256, location_id, event_type, provider_contact_id, received_at::text FROM highlevel_webhook_receipts WHERE location_id=$1 ORDER BY key", location),
        ("historyDeliveries", "SELECT id::text, encode(sha256(convert_to(provider_idempotency_key,'UTF8')),'hex') AS idempotency_sha256, kind, status, provider_message_id, (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL) AS lease_held, created_at::text, sent_at::text, redacted_at::text FROM customer_email_outbox WHERE delivery_provider='highlevel' ORDER BY id", []),
        ("historyMarketingJobs", "SELECT id::text, encode(sha256(convert_to(idempotency_key,'UTF8')),'hex') AS idempotency_sha256, source, kind::text, status::text, (locked_by IS NOT NULL OR locked_until IS NOT NULL) AS lease_held, created_at::text, succeeded_at::text, skipped_at::text FROM marketing_contact_sync_jobs ORDER BY id", []),
        ("historyOauthStates", "SELECT hash AS state_sha256, expires_at::text FROM highlevel_oauth_states ORDER BY hash", []),
        ("historyGlobalScope", "SELECT (SELECT count(*)::int FROM highlevel_contacts) AS contacts, (SELECT count(*)::int FROM highlevel_effects) AS effects, (SELECT count(*)::int FROM highlevel_connections) AS connections, (SELECT count(*)::int FROM highlevel_webhook_receipts) AS webhooks", []),
    ]


COLUMNS = {
    "historyContacts": "id location_id provider_id email_sha256 deleted_at created_at updated_at",
    "historyEffects": "key contact_id kind provider_id state data created_at updated_at",
    "historyOutbox": "id idempotency_sha256 entity_type entity_id event_type historical status lease_held occurred_at created_at completed_at",
    "historyConnections": "location_id refresh_state credentials_revoked expires_at updated_at",
    "historyWebhooks": "receipt_sha256 location_id event_type provider_contact_id received_at",
    "historyDeliveries": "id idempotency_sha256 kind status provider_message_id lease_held created_at sent_at redacted_at",
    "historyMarketingJobs": "id idempotency_sha256 source kind status lease_held created_at succeeded_at skipped_at",
    "historyOauthStates": "state_sha256 expires_at",
    "historyGlobalScope": "contacts effects connections webhooks",
}
IDENTITY = {name: next(iter(columns.split())) for name, columns in COLUMNS.items()}


def normalize_snapshot(actual):
    demand(isinstance(actual, dict) and set(actual) == set(COLUMNS), "HIGHLEVEL_HISTORY_FIXED_SNAPSHOT_REQUIRED")
    normalized = {}
    for name, columns in COLUMNS.items():
        rows = actual[name]
        demand(isinstance(rows, list) and len(rows) <= MAXIMUM, "HIGHLEVEL_HISTORY_SNAPSHOT_LIMIT")
        ids = set()
        for row in rows:
            demand(isinstance(row, dict) and set(row) == set(columns.split()), "HIGHLEVEL_HISTORY_SNAPSHOT_COLUMNS_REFUSED")
            if name == "historyGlobalScope":
                demand(all(type(value) is int and 0 <= value <= MAXIMUM for value in row.values()), "HIGHLEVEL_HISTORY_SCOPE_COUNTS_REFUSED")
                continue
            identity = row[IDENTITY[name]]
            demand(isinstance(identity, str) and 0 < len(identity) <= 512 and identity not in ids, "HIGHLEVEL_HISTORY_ROW_ID_REFUSED")
            if name in ("historyContacts", "historyOutbox", "historyDeliveries", "historyMarketingJobs", "historyConnections"):
                demand(_id(identity), "HIGHLEVEL_HISTORY_ROW_ID_REFUSED")
            if name == "historyContacts":
                demand(row["provider_id"] is None or _id(row["provider_id"]), "HIGHLEVEL_HISTORY_PROVIDER_ID_REFUSED")
            ids.add(identity)
            for key, value in row.items():
                if key == "data":
                    demand(isinstance(value, dict) and set(value) == {"workflow", "journey", "pipeline"} and
                        all(item is None or _id(item) for item in value.values()), "HIGHLEVEL_HISTORY_EFFECT_DATA_REFUSED")
                elif key in ("lease_held", "historical", "credentials_revoked"):
                    demand(type(value) is bool, "HIGHLEVEL_HISTORY_BOOLEAN_REQUIRED")
                else:
                    demand(value is None or isinstance(value, str) and 0 < len(value) <= 512 and all(ord(c) >= 32 for c in value),
                        "HIGHLEVEL_HISTORY_SCALAR_REFUSED")
                if key.endswith("_sha256"):
                    demand(_digest(value), "HIGHLEVEL_HISTORY_DATABASE_DIGEST_REQUIRED")
                if key.endswith("_at") and value is not None:
                    _instant(value)
        normalized[name] = sorted(json.loads(json.dumps(rows)), key=lambda row: str(row[IDENTITY[name]]))
    demand(len(normalized["historyGlobalScope"]) == 1, "HIGHLEVEL_HISTORY_GLOBAL_SCOPE_REQUIRED")
    return normalized


def _source(reviewed, requirements):
    demand(isinstance(requirements, dict) and requirements.get("version") == 1 and
        requirements.get("status") == "FRONTEND_HISTORICAL_SOURCE_VERIFIED" and
        _digest(requirements.get("sourceCommit"), 40) and _digest(requirements.get("treeOid"), 40) and
        all(_digest(requirements.get(key)) for key in ("sourceInventorySha256", "requirementsSha256")) and
        requirements["sourceCommit"] == reviewed.get("historicalSourceCommit"), "HIGHLEVEL_HISTORY_CHECKED_SOURCE_REQUIRED")
    families = requirements.get("providerFamilies")
    demand(isinstance(families, list) and isinstance(requirements.get("sqlCredentialRequirements"), list),
        "HIGHLEVEL_HISTORY_SOURCE_FAMILIES_REQUIRED")
    selected = [row for row in families if isinstance(row, dict) and row.get("provider") == "highlevel"]
    demand(sorted(row.get("familyId", "") for row in selected) == sorted(FAMILIES) and
        all(row.get("sourceDisposition") in ("reachable", "absent-from-verified-source") and
            all(isinstance(row.get(key), list) for key in ("configurationConditions", "untrackedPotentialRequests", "sqlIntentRequirements")) for row in selected),
        "HIGHLEVEL_HISTORY_SOURCE_FAMILIES_REQUIRED")
    return {row["familyId"]: row for row in selected}


def _family_bindings(source, families, actual):
    """Consume only the parent's source/config/SQL reducer, never public flags.

    A closure references every concrete requirement and privately checked
    evidence record. Contradictory present SQL cannot turn into global zero.
    """
    closures = source.get("capabilityClosures", [])
    known_families = {row["familyId"] for row in source["providerFamilies"] if isinstance(row, dict) and isinstance(row.get("familyId"), str)}
    demand(isinstance(closures, list) and all(isinstance(row, dict) and row.get("familyId") in known_families for row in closures),
        "HIGHLEVEL_HISTORY_CAPABILITY_CLOSURES_REFUSED")
    selected = [row for row in closures if isinstance(row, dict) and row.get("familyId") in FAMILIES]
    demand(len({row["familyId"] for row in selected}) == len(selected), "HIGHLEVEL_HISTORY_DUPLICATE_CAPABILITY_CLOSURE")
    known = {row["familyId"]: row for row in selected}
    database_empty = all(not rows for name, rows in actual.items() if name != "historyGlobalScope") and \
        all(count == 0 for count in actual["historyGlobalScope"][0].values())
    result = []
    for family_id, family in sorted(families.items()):
        requirements = []
        for category in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests"):
            for item in family.get(category, []):
                if isinstance(item, dict) and "requirementId" in item:
                    demand(_requirement_id(item["requirementId"]) and item.get("familyId") == family_id,
                        "HIGHLEVEL_HISTORY_SOURCE_REQUIREMENT_ID_REFUSED")
                    requirements.append(item["requirementId"])
                else:
                    raise ValueError("HIGHLEVEL_HISTORY_SOURCE_REQUIREMENT_ID_REQUIRED")
        # Credential requirements apply to all families unless their source
        # profile explicitly selects a narrower familyId.
        for item in source.get("sqlCredentialRequirements", []):
            demand(isinstance(item, dict) and _requirement_id(item.get("requirementId")), "HIGHLEVEL_HISTORY_CREDENTIAL_REQUIREMENT_ID_REQUIRED")
            requirements.append(item["requirementId"])
        demand(len(requirements) == len(set(requirements)), "HIGHLEVEL_HISTORY_DUPLICATE_SOURCE_REQUIREMENT")
        requirements = sorted(requirements)
        closure = known.get(family_id)
        valid = False
        evidence = []
        if closure is not None:
            demand(set(closure) == {"familyId", "disposition", "requirementIds", "evidenceIds"} and
                closure["disposition"] in ("no-capability-observed", "absent-from-verified-source") and
                isinstance(closure["requirementIds"], list) and closure["requirementIds"] == requirements and
                isinstance(closure["evidenceIds"], list) and closure["evidenceIds"] == sorted(set(closure["evidenceIds"])) and
                closure["evidenceIds"] and all(_digest(value) for value in closure["evidenceIds"]) and
                (closure["disposition"] != "absent-from-verified-source" or family["sourceDisposition"] == "absent-from-verified-source"),
                "HIGHLEVEL_HISTORY_CAPABILITY_REQUIREMENT_BINDING_REFUSED")
            valid, evidence = database_empty, closure["evidenceIds"]
        result.append({"familyId": family_id, "disposition": closure["disposition"] if valid else "current-state-incomplete",
            "coveredRequirementIds": requirements if valid else [], "missingRequirementIds": [] if valid else requirements,
            "evidenceIds": evidence if valid else [], "activeExecutions": 0 if valid else None, "uncertainEffects": 0 if valid else None})
    return result


def _call(client, path):
    """Only the private checkpointed transport may issue these reads."""
    try:
        value = client.request("GET", path)
    except (ValueError, OSError, TimeoutError):
        # No HTTP status, body, token, URL or PII escapes. Lock loss is also
        # unresolved and the parent must fail its mandatory final checkpoint.
        return None
    demand(isinstance(value, dict), "HIGHLEVEL_HISTORY_PROVIDER_RESPONSE_REFUSED")
    return value


def _workflow_logs(client, reviewed, workflow, start, end):
    query = {"locationId": reviewed["locationId"], "limit": 100, "action": "first", "startDate": start, "endDate": end}
    rows, seen, cursors = [], set(), set()
    for _page in range(42):
        value = _call(client, "/workflows/" + workflow + "/logs?" + urlencode(query))
        if value is None:
            return None
        data, cursor = value.get("logs"), value.get("nextCursor")
        demand(isinstance(data, list) and len(data) <= 100 and type(value.get("count")) is int and value["count"] == len(data) and
            "nextCursor" in value, "HIGHLEVEL_HISTORY_WORKFLOW_PAGE_REFUSED")
        for row in data:
            demand(isinstance(row, dict) and _id(row.get("id")) and row["id"] not in seen and len(rows) < MAXIMUM and
                row.get("locationId") == reviewed["locationId"] and row.get("workflowId") == workflow and
                isinstance(row.get("status"), str) and isinstance(row.get("type"), str) and isinstance(row.get("meta"), dict) and
                _instant(start) <= _instant(row.get("createdAt")) <= _instant(end), "HIGHLEVEL_HISTORY_WORKFLOW_ROW_REFUSED")
            seen.add(row["id"])
            # Names, email, step text and meta messages never leave memory.
            rows.append({"id": row["id"], "workflowId": workflow, "contactId": row.get("contactId") or None,
                "executionId": row.get("workflowStatusId"), "stepId": row.get("stepId"), "status": row["status"],
                "type": row["type"], "createdAt": row["createdAt"]})
        if cursor is None:
            return rows
        demand(data and isinstance(cursor, dict) and set(cursor) == {"referenceId", "referenceCreatedAt"} and
            _id(cursor["referenceId"]) and _instant(start) <= _instant(cursor["referenceCreatedAt"]) <= _instant(end) and
            sha256(cursor) not in cursors, "HIGHLEVEL_HISTORY_WORKFLOW_CURSOR_REFUSED")
        cursors.add(sha256(cursor))
        query.update(action="next", **cursor)
    raise ValueError("HIGHLEVEL_HISTORY_WORKFLOW_PAGE_LIMIT")


def _messages(client, reviewed, contact):
    value = _call(client, "/conversations/search?" + urlencode({"locationId": reviewed["locationId"], "contactId": contact,
        "limit": 100, "sort": "asc", "sortBy": "last_message_date", "status": "all"}))
    if value is None:
        return None
    conversations = value.get("conversations")
    demand(isinstance(conversations, list) and type(value.get("total")) is int and 0 <= value["total"] <= MAXIMUM and
        len(conversations) <= 100, "HIGHLEVEL_HISTORY_CONVERSATION_RESPONSE_REFUSED")
    # Documentation supplies startAfterDate but does not expose a required sort
    # cursor in response. Never fabricate it or use an implicit partial list.
    if value["total"] != len(conversations):
        return None
    rows, conversation_ids, message_ids = [], set(), set()
    for conversation in conversations:
        item = conversation.get("id") if isinstance(conversation, dict) else None
        demand(_id(item) and item not in conversation_ids and conversation.get("locationId") == reviewed["locationId"] and
            conversation.get("contactId") == contact, "HIGHLEVEL_HISTORY_CONVERSATION_SCOPE_REFUSED")
        conversation_ids.add(item)
        cursor, cursors = None, set()
        for _page in range(42):
            query = {"limit": 100, **({"lastMessageId": cursor} if cursor is not None else {})}
            page = _call(client, "/conversations/" + item + "/messages?" + urlencode(query))
            if page is None:
                return None
            data = page.get("messages")
            demand(isinstance(data, dict) and isinstance(data.get("messages"), list) and len(data["messages"]) <= 100 and
                type(data.get("nextPage")) is bool, "HIGHLEVEL_HISTORY_MESSAGE_PAGE_REFUSED")
            for row in data["messages"]:
                demand(isinstance(row, dict) and _id(row.get("id")) and row["id"] not in message_ids and len(rows) < MAXIMUM and
                    row.get("locationId") == reviewed["locationId"] and row.get("contactId") == contact and
                    row.get("conversationId") == item and row.get("direction") in ("inbound", "outbound"), "HIGHLEVEL_HISTORY_MESSAGE_SCOPE_REFUSED")
                message_ids.add(row["id"])
                selected = {key: row.get(key) for key in ("id", "locationId", "contactId", "conversationId", "direction", "status", "source", "dateAdded")}
                _instant(selected["dateAdded"])
                readback = _call(client, "/conversations/messages/" + row["id"])
                if readback is None:
                    return None
                demand(selected == {key: readback.get(key) for key in selected}, "HIGHLEVEL_HISTORY_MESSAGE_READBACK_CHANGED")
                rows.append(selected)
            if data["nextPage"] is False:
                break
            cursor = data.get("lastMessageId")
            demand(data["messages"] and _id(cursor) and cursor == data["messages"][-1]["id"] and cursor not in cursors,
                "HIGHLEVEL_HISTORY_MESSAGE_CURSOR_REFUSED")
            cursors.add(cursor)
        else:
            raise ValueError("HIGHLEVEL_HISTORY_MESSAGE_PAGE_LIMIT")
    return rows


def _requirement(kind, reviewed, source, **details):
    return {"kind": kind, "provider": "highlevel", "locationId": reviewed["locationId"],
        "sourceCommit": source["sourceCommit"], "sourceInventorySha256": source["sourceInventorySha256"],
        "requirementsSha256": source["requirementsSha256"], "observedAt": reviewed["history"]["observedAt"],
        **OBSERVATIONS[kind], **details}


def observe_scoped_effects(client, reviewed, actual_rows, verified_source_requirements):
    """Observe known current state; retained windows never certify all-time drain."""
    _review(reviewed)
    source = verified_source_requirements
    families = _source(reviewed, source)
    actual = normalize_snapshot(actual_rows)
    demand(_digest(reviewed.get("historyDatabaseSnapshotSha256")) and sha256(actual) == reviewed["historyDatabaseSnapshotSha256"],
        "HIGHLEVEL_HISTORY_DATABASE_SNAPSHOT_CHANGED")
    history = reviewed.get("history")
    demand(isinstance(history, dict) and set(history) == {"observedAt", "windowStart", "windowEnd"}, "HIGHLEVEL_HISTORY_WINDOW_REQUIRED")
    now, start, end = (_instant(history[key]) for key in ("observedAt", "windowStart", "windowEnd"))
    actual_time = datetime.now(timezone.utc)
    demand(timedelta(0) < end - start <= timedelta(days=30) and start < end <= now <= actual_time,
        "HIGHLEVEL_HISTORY_RETAINED_WINDOW_REQUIRED")
    family_receipts = _family_bindings(source, families, actual)
    scope = {"version": 1, "provider": "highlevel", "locationId": reviewed["locationId"], "companyId": reviewed["companyId"],
        "sourceBindingSha256": reviewed["sourceBindingSha256"], "sourceCommit": source["sourceCommit"],
        "sourceInventorySha256": source["sourceInventorySha256"], "requirementsSha256": source["requirementsSha256"],
        "historyDatabaseSnapshotSha256": reviewed["historyDatabaseSnapshotSha256"], "window": history,
        "coveredRequirementIds": sorted({key for row in family_receipts for key in row["coveredRequirementIds"]}),
        "missingRequirementIds": sorted({key for row in family_receipts for key in row["missingRequirementIds"]}),
        "families": family_receipts, "historicalWritersFenced": False, "trafficAuthorized": False}
    if all(row["disposition"] != "current-state-incomplete" for row in family_receipts):
        return {**scope, "status": "STAGING_HIGHLEVEL_SOURCE_CAPABILITY_ABSENCE_OBSERVED", "knownActiveExecutions": 0,
            "knownUnknownEffects": 0, "knownExecutions": [], "knownMessages": [], "knownEffects": [],
            "knownContacts": [], "knownJobs": [], "knownDeliveries": [], "knownWebhookReceipts": [], "knownConnections": [], "knownOauthStates": [],
            "unavailableWorkflowIds": [], "unavailableContactIds": [], "requiredObservations": [],
            "workflowExecutionInventoryComplete": True, "inboundWebhooksQualified": True, "activeExecutions": 0, "uncertainEffects": 0}
    # Provider retention constrains API reads, not the validity/approval lifetime
    # of an original-configuration absence proof with newly read actual SQL.
    demand(actual_time - timedelta(days=60) <= start, "HIGHLEVEL_HISTORY_RETAINED_WINDOW_REQUIRED")
    contacts = {row["id"]: row for row in actual["historyContacts"]}
    demand(all(row["location_id"] == reviewed["locationId"] for row in contacts.values()) and
        all(row["contact_id"] in contacts for row in actual["historyEffects"]), "HIGHLEVEL_HISTORY_DATABASE_CONTACT_SCOPE_REFUSED")
    binding = _call(client, "/locations/" + reviewed["locationId"])
    demand(binding is not None and isinstance(binding.get("location"), dict) and
        binding["location"].get("id") == reviewed["locationId"] and binding["location"].get("companyId") == reviewed["companyId"],
        "HIGHLEVEL_HISTORY_ACTUAL_LOCATION_REQUIRED")
    safe_contacts, contact_matches = [], {}
    for row in actual["historyContacts"]:
        remote = _call(client, "/contacts/" + row["provider_id"]) if row["provider_id"] in reviewed["expectedProviderContactIds"] else None
        remote = remote.get("contact") if remote is not None else None
        matched = (isinstance(remote, dict) and remote.get("id") == row["provider_id"] and remote.get("locationId") == reviewed["locationId"] and
            isinstance(remote.get("email"), str) and hashlib.sha256(remote["email"].strip().lower().encode()).hexdigest() == row["email_sha256"] and
            row["deleted_at"] is None)
        contact_matches[row["id"]] = matched
        safe_contacts.append({"recordId": row["id"], "providerId": row["provider_id"], "databaseRowSha256": sha256(row), "immutableMatch": matched})
    required, logs, messages = [], [], []
    unavailable_workflows = []
    for workflow in reviewed["expectedWorkflowIds"]:
        page = _workflow_logs(client, reviewed, workflow, history["windowStart"], history["windowEnd"])
        if page is None:
            unavailable_workflows.append(workflow)
        else:
            logs.extend(page)
    unavailable_contacts = []
    for contact in reviewed["expectedProviderContactIds"]:
        page = _messages(client, reviewed, contact)
        if page is None:
            unavailable_contacts.append(contact)
        else:
            messages.extend(page)
    executions = {}
    unknown_log = 0
    for row in logs:
        execution = row["executionId"]
        if not _id(execution) or row["contactId"] not in reviewed["expectedProviderContactIds"] or row["status"] not in ACTIVE_WORKFLOW | OTHER_WORKFLOW:
            unknown_log += 1
            continue
        key = (row["workflowId"], execution)
        executions.setdefault(key, []).append(row)
    safe_executions = []
    for (workflow, execution), rows in sorted(executions.items()):
        # A later finished step cannot be inferred from a success/skip/draft or
        # from DB cancelled; explicit provider execution exit is required.
        latest = max(rows, key=lambda row: _instant(row["createdAt"]))
        demand(len({row["contactId"] for row in rows}) == 1, "HIGHLEVEL_HISTORY_EXECUTION_CONTACT_CHANGED")
        terminal = latest["status"] == "finished"
        active = not terminal and latest["status"] in ACTIVE_WORKFLOW
        unknown_log += not terminal and not active
        safe_executions.append({"workflowId": workflow, "executionId": execution, "contactId": latest["contactId"],
            "providerExecutionExitObserved": terminal, "knownActive": active, "logRowsSha256": sha256(rows)})
    safe_messages = [{"providerId": row["id"], "conversationId": row["conversationId"], "contactId": row["contactId"],
        "direction": row["direction"], "source": row["source"] if row["source"] in ("workflow", "bulk_actions", "campaign", "api", "app") else "unknown",
        "deliveryObserved": row["status"] in DELIVERED_MESSAGE, "knownActive": row["status"] in ACTIVE_MESSAGE,
        "providerReceiptSha256": sha256(row)} for row in messages if row["direction"] == "outbound"]
    safe_effects = []
    for row in actual["historyEffects"]:
        contact = contacts[row["contact_id"]]
        result = {"intentSha256": hashlib.sha256(row["key"].encode()).hexdigest(), "databaseRowSha256": sha256(row),
            "familyId": "highlevel." + {"workflow": "workflows", "task": "tasks", "opportunity": "opportunities"}.get(row["kind"], "contacts"),
            "kind": row["kind"] if row["kind"] in ("workflow", "task", "opportunity", "note", "entity") else "unknown",
            "storedOutcomeConsistent": False}
        if row["kind"] == "workflow":
            workflow = row["data"]["workflow"]
            candidates = [item["executionId"] for item in safe_executions if item["workflowId"] == workflow and item["contactId"] == contact["provider_id"]]
            result["candidateExecutionIds"] = candidates
            # Neither the application receipt nor documented logs contain the
            # same immutable journey key: do not invent the missing join.
            required.append(_requirement("workflow-intent-execution-and-downstream-join", reviewed, source,
                familyId="highlevel.workflows", intentSha256=result["intentSha256"], workflowId=workflow,
                providerContactId=contact["provider_id"], candidateExecutionIds=candidates))
        elif row["kind"] == "entity" and row["state"] == "recorded" and contact_matches[row["contact_id"]] and row["key"].startswith("entity:"):
            result["storedOutcomeConsistent"] = True
        elif contact_matches[row["contact_id"]] and row["state"] == "succeeded" and row["kind"] in ("note", "task", "opportunity") and _id(row["provider_id"]) and _id(contact["provider_id"]):
            kind, item = row["kind"], row["provider_id"]
            path = "/opportunities/" + item if kind == "opportunity" else "/contacts/" + contact["provider_id"] + "/" + kind + "s/" + item
            value = _call(client, path)
            remote = value.get(kind) if value is not None else None
            match = isinstance(remote, dict) and remote.get("id") == item and remote.get("contactId") == contact["provider_id"]
            if kind == "task":
                match = match and remote.get("completed") is True and row["key"].startswith("task:" + contact["id"] + ":")
            elif kind == "opportunity":
                match = (match and remote.get("locationId") == reviewed["locationId"] and remote.get("pipelineId") == row["data"]["pipeline"] and
                    remote.get("status") in ("won", "lost", "abandoned") and row["key"].startswith("opportunity:" + contact["id"] + ":"))
            else:
                match = (match and row["key"].startswith("note:") and isinstance(remote.get("body"), str) and
                    remote["body"].startswith("[LH submission " + row["key"][5:] + "]\n"))
            result["storedOutcomeConsistent"] = bool(match)
        safe_effects.append(result)
    known_active = sum(item["knownActive"] for item in safe_executions + safe_messages)
    known_active += sum(row["lease_held"] or row["status"] == "processing" for row in actual["historyOutbox"] + actual["historyMarketingJobs"])
    known_active += sum(row["lease_held"] or row["status"] == "sending" for row in actual["historyDeliveries"])
    known_unknown = unknown_log + len(unavailable_workflows) + len(unavailable_contacts)
    known_unknown += sum(not row["immutableMatch"] for row in safe_contacts)
    known_unknown += len(set(reviewed["expectedProviderContactIds"]) - {row["provider_id"] for row in actual["historyContacts"]})
    known_unknown += sum(not item["storedOutcomeConsistent"] for item in safe_effects)
    known_unknown += sum(not item["deliveryObserved"] for item in safe_messages)
    known_unknown += sum(row["status"] not in ("succeeded", "skipped") or row["lease_held"] or row["completed_at"] is None for row in actual["historyOutbox"])
    known_unknown += sum(row["status"] not in ("succeeded", "skipped_unconfigured") or row["lease_held"] or
        (row["succeeded_at"] is None if row["status"] == "succeeded" else row["skipped_at"] is None) for row in actual["historyMarketingJobs"])
    known_unknown += sum(row["status"] != "sent" or row["lease_held"] or row["sent_at"] is None or
        not isinstance(row["provider_message_id"], str) or row["provider_message_id"].startswith("workflow:") for row in actual["historyDeliveries"])
    jobs = []
    for name in ("historyOutbox", "historyMarketingJobs"):
        for row in actual[name]:
            jobs.append({"familyId": "highlevel.contacts", "recordId": row["id"], "idempotencySha256": row["idempotency_sha256"],
                "databaseRowSha256": sha256(row), "leaseHeld": row["lease_held"],
                "databaseStatus": row["status"] if row["status"] in ("queued", "processing", "retry", "retryable_failed", "succeeded", "skipped", "skipped_unconfigured", "review", "dead_letter") else "unknown"})
    deliveries = [{"familyId": "highlevel.messages", "recordId": row["id"], "idempotencySha256": row["idempotency_sha256"],
        "databaseRowSha256": sha256(row), "leaseHeld": row["lease_held"],
        "enrollmentOnlyReceipt": isinstance(row["provider_message_id"], str) and row["provider_message_id"].startswith("workflow:"),
        "downstreamDeliveryVerified": False} for row in actual["historyDeliveries"]]
    webhooks = [{"familyId": "highlevel.webhooks", "receiptSha256": row["receipt_sha256"], "databaseRowSha256": sha256(row),
        "eventType": row["event_type"] if row["event_type"] in ("UNINSTALL", "AppUninstall", "ContactDndUpdate", "ContactDelete") else "unknown",
        "receivedAt": row["received_at"]} for row in actual["historyWebhooks"]]
    connections = [{"familyId": "highlevel.oauth", "databaseRowSha256": sha256(row), "storedCredentialRevoked": row["credentials_revoked"],
        "refreshState": row["refresh_state"] if row["refresh_state"] in ("ready", "refreshing", "reconnect", "revoked") else "unknown"} for row in actual["historyConnections"]]
    for kind, family in (("workflow-history-outside-retained-window", "workflows"), ("original-webhook-configuration-caller-and-retry-state", "webhooks"),
            ("original-oauth-and-static-credential-capability-scope", "oauth")):
        required.append(_requirement(kind, reviewed, source, familyId="highlevel." + family))
    for family in families.values():
        if family["sourceDisposition"] == "reachable" and family["untrackedPotentialRequests"]:
            required.append(_requirement("source-reachable-untracked-provider-requests", reviewed, source, familyId=family["familyId"],
                requirementsSha256=sha256(family["untrackedPotentialRequests"])))
    return {**scope, "status": "STAGING_HIGHLEVEL_HISTORY_OBSERVED",
        "knownActiveExecutions": known_active, "knownUnknownEffects": known_unknown, "knownExecutions": safe_executions,
        "knownMessages": safe_messages, "knownContacts": safe_contacts, "knownEffects": safe_effects, "unavailableWorkflowIds": unavailable_workflows,
        "knownJobs": jobs, "knownDeliveries": deliveries, "knownWebhookReceipts": webhooks, "knownConnections": connections,
        "knownOauthStates": [{"familyId": "highlevel.oauth", "stateSha256": row["state_sha256"], "databaseRowSha256": sha256(row),
            "expiresAt": row["expires_at"]} for row in actual["historyOauthStates"]],
        "unavailableContactIds": unavailable_contacts, "requiredObservations": required,
        "workflowExecutionInventoryComplete": False, "inboundWebhooksQualified": False, "activeExecutions": None, "uncertainEffects": None,
        "historicalWritersFenced": False, "trafficAuthorized": False}
