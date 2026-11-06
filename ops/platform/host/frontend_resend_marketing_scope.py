"""Read-only Resend marketing effect inventory for the locked host worker.

No credentials, recipient addresses, content, caller SQL, replay, or mutation.
The caller validates source/config capability closures and obtains both SQL
snapshots under its lock. A family is complete only when its intents and actual
provider state agree; a successful contact job is not an event delivery receipt.
"""
from datetime import datetime
import hashlib
import json
import re

import migrate

MAXIMUM = 4096
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
SOURCES = ("booking", "course_signup", "contact_popup", "general_inquiry", "sanity_backfill", "training_contact")
FAMILIES = ("resend.contacts", "resend.segments", "resend.topics", "resend.broadcasts", "resend.events")
demand = migrate.demand
COLUMNS = {
    "contacts": "id email_sha256 source unsubscribed_at last_consented_at updated_at",
    "submissions": "id email_sha256 submission_type consent_choice submitted_at",
    "consents": "id contact_id submission_id email_sha256 event_type source provider_contact_id occurred_at",
    "syncJobs": "id contact_id submission_id consent_event_id email_sha256 source kind status attempts lease_held succeeded_at skipped_at updated_at",
    "campaigns": "id status provider_broadcast_id provider_segment_id scheduled_at sent_at updated_at",
    "outbox": "id submission_id email_sha256 status provider_message_id attempt_count lease_held redacted sent_at updated_at",
}


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def identifier(value):
    return isinstance(value, str) and re.fullmatch(UUID, value) is not None


def _instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        demand(parsed.tzinfo is not None, "RESEND_MARKETING_TIMESTAMP_REFUSED")
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise ValueError("RESEND_MARKETING_TIMESTAMP_REFUSED") from None


def review(reviewed):
    value = reviewed.get("resendMarketing", reviewed) if isinstance(reviewed, dict) else None
    demand(isinstance(value, dict) and value.get("environment") == "staging" and
        all(digest(value.get(key)) for key in ("databaseSnapshotSha256", "sourceInventorySha256", "requirementsSha256", "configurationSha256")),
        "RESEND_MARKETING_REVIEW_REQUIRED")
    for key in ("segmentIdsBySource", "topicIdsBySource"):
        mapping = value.get(key)
        demand(isinstance(mapping, dict) and set(mapping) == set(SOURCES) and all(isinstance(ids, list) and len(ids) <= 8 and
            all(identifier(item) for item in ids) and len(set(ids)) == len(ids) for ids in mapping.values()), "RESEND_MARKETING_SOURCE_CONFIGURATION_REQUIRED")
    return value


def read_only_request(method, path, body, reviewed):
    review(reviewed)
    return method == "GET" and body is None and isinstance(path, str) and bool(
        re.fullmatch(rf"/(contacts|broadcasts)\?limit=100(&after={UUID})?", path) or
        re.fullmatch(rf"/(contacts|broadcasts|emails)/{UUID}", path) or
        re.fullmatch(rf"/contacts/{UUID}/(segments|topics)\?limit=100(&after={UUID})?", path))


def database_queries(reviewed):
    """Literal bounded SELECTs, one repeatable-read read-only transaction.

    Read all rows, not only current provider ownership or active consent. SQL
    hashes the same lower/trimmed address that private provider matching hashes.
    No consent text, message body, credentials, payloads, or plaintext addresses.
    """
    review(reviewed)
    return [
        ("contacts", "SELECT id::text, encode(sha256(convert_to(lower(trim(email_normalized)),'UTF8')),'hex') AS email_sha256, source, unsubscribed_at::text, last_consented_at::text, updated_at::text FROM public.marketing_contacts ORDER BY id LIMIT 4097", []),
        ("submissions", "SELECT id::text, encode(sha256(convert_to(lower(trim(email_normalized)),'UTF8')),'hex') AS email_sha256, submission_type::text, consent_choice, submitted_at::text FROM public.marketing_contact_submissions ORDER BY id LIMIT 4097", []),
        ("consents", "SELECT id::text, contact_id::text, submission_id::text, encode(sha256(convert_to(lower(trim(email_normalized)),'UTF8')),'hex') AS email_sha256, event_type::text, source, metadata->>'resendContactId' AS provider_contact_id, occurred_at::text FROM public.marketing_consent_events ORDER BY id LIMIT 4097", []),
        ("syncJobs", "SELECT id::text, contact_id::text, submission_id::text, consent_event_id::text, encode(sha256(convert_to(lower(trim(email_normalized)),'UTF8')),'hex') AS email_sha256, source, kind::text, status::text, attempts, (locked_by IS NOT NULL OR locked_until IS NOT NULL) AS lease_held, succeeded_at::text, skipped_at::text, updated_at::text FROM public.marketing_contact_sync_jobs ORDER BY id LIMIT 4097", []),
        ("campaigns", "SELECT id::text, status::text, resend_broadcast_id AS provider_broadcast_id, resend_segment_id AS provider_segment_id, scheduled_at::text, sent_at::text, updated_at::text FROM public.marketing_campaigns ORDER BY id LIMIT 4097", []),
        ("outbox", "SELECT id::text, submission_id::text, CASE WHEN recipient_email_normalized IS NULL THEN NULL ELSE encode(sha256(convert_to(lower(trim(recipient_email_normalized)),'UTF8')),'hex') END AS email_sha256, status, provider_message_id, attempt_count, (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL) AS lease_held, redacted_at IS NOT NULL AS redacted, sent_at::text, updated_at::text FROM public.customer_email_outbox WHERE delivery_provider='resend' AND kind='contact_popup_offer' ORDER BY id LIMIT 4097", []),
    ]


def normalize_snapshot(actual):
    demand(isinstance(actual, dict) and set(actual) == set(COLUMNS), "RESEND_MARKETING_DATABASE_SNAPSHOT_REQUIRED")
    result = {}
    uuid_fields = {"id", "contact_id", "submission_id", "consent_event_id", "provider_contact_id", "provider_broadcast_id", "provider_segment_id", "provider_message_id"}
    for kind, columns in COLUMNS.items():
        rows = actual[kind]
        demand(isinstance(rows, list) and len(rows) <= MAXIMUM, "RESEND_MARKETING_DATABASE_LIMIT")
        for row in rows:
            demand(isinstance(row, dict) and set(row) == set(columns.split()), "RESEND_MARKETING_DATABASE_COLUMNS_REFUSED")
            states = {
                ("syncJobs", "kind"): ("opt_in_sync", "unsubscribe_sync"),
                ("syncJobs", "status"): ("queued", "processing", "succeeded", "retryable_failed", "dead_letter", "skipped_unconfigured"),
                ("campaigns", "status"): ("draft", "scheduled", "sending", "sent", "failed", "canceled"),
                ("outbox", "status"): ("queued", "sending", "failed", "dead_letter", "sent"),
                ("consents", "event_type"): ("opt_in", "no_opt_in", "unsubscribe", "backfill_consent"),
                ("submissions", "consent_choice"): ("opted_in", "not_opted_in", "unsubscribed"),
                ("submissions", "submission_type"): ("course_signup", "general_inquiry", "training_contact", "contact_popup", "booking_marketing_choice", "sanity_backfill"),
            }
            for key, value in row.items():
                if (kind, key) in states:
                    demand(value in states[(kind, key)], "RESEND_MARKETING_DATABASE_STATE_REFUSED")
                if key in uuid_fields:
                    demand(identifier(value) or key != "id" and value is None, "RESEND_MARKETING_DATABASE_ID_REFUSED")
                elif key == "email_sha256":
                    demand(digest(value) or kind == "outbox" and value is None, "RESEND_MARKETING_EMAIL_HASH_REQUIRED")
                elif key in ("lease_held", "redacted"):
                    demand(type(value) is bool, "RESEND_MARKETING_DATABASE_BOOLEAN_REQUIRED")
                elif key in ("attempts", "attempt_count"):
                    demand(type(value) is int and 0 <= value <= 1_000_000, "RESEND_MARKETING_ATTEMPT_COUNT_REFUSED")
                elif key.endswith("_at"):
                    if value is not None:
                        _instant(value)
                else:
                    demand(isinstance(value, str) and re.fullmatch(r"[a-z_]{1,64}", value), "RESEND_MARKETING_DATABASE_STATE_REFUSED")
        demand(len({row["id"] for row in rows}) == len(rows), "RESEND_MARKETING_DATABASE_DUPLICATE")
        result[kind] = sorted((dict(row) for row in rows), key=lambda row: row["id"])
    return result


def snapshot_sha256(actual):
    return hashlib.sha256(json.dumps(normalize_snapshot(actual), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def _source(reviewed, requirements):
    demand(isinstance(requirements, dict) and requirements.get("status") == "FRONTEND_HISTORICAL_SOURCE_VERIFIED" and
        isinstance(requirements.get("sourceCommit"), str) and re.fullmatch(r"[a-f0-9]{40}", requirements["sourceCommit"]) and
        all(requirements.get(key) == reviewed[key] for key in ("sourceInventorySha256", "requirementsSha256")), "RESEND_MARKETING_VERIFIED_SOURCE_REQUIRED")
    rows = requirements.get("providerFamilies")
    demand(isinstance(rows, list), "RESEND_MARKETING_SOURCE_FAMILIES_REQUIRED")
    selected = {row.get("familyId"): row for row in rows if isinstance(row, dict) and row.get("familyId") in FAMILIES}
    demand(set(selected) == set(FAMILIES) and len([row for row in rows if isinstance(row, dict) and row.get("familyId") in FAMILIES]) == len(FAMILIES),
        "RESEND_MARKETING_SOURCE_FAMILIES_REQUIRED")
    closures = requirements.get("capabilityClosures", [])
    demand(isinstance(closures, list), "RESEND_MARKETING_CAPABILITY_CLOSURES_REFUSED")
    return selected, closures


def _requirements(family):
    result = []
    for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests"):
        rows = family.get(key)
        demand(isinstance(rows, list), "RESEND_MARKETING_SOURCE_REQUIREMENTS_REQUIRED")
        for item in rows:
            key_id = item.get("requirementId") if isinstance(item, dict) else None
            demand(isinstance(key_id, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", key_id), "RESEND_MARKETING_REQUIREMENT_ID_REFUSED")
            result.append(key_id)
    demand(len(result) == len(set(result)), "RESEND_MARKETING_DUPLICATE_REQUIREMENT")
    demand(result or family.get("sourceDisposition") == "absent-from-verified-source", "RESEND_MARKETING_SOURCE_REQUIREMENTS_REQUIRED")
    return result


def _closed(family_id, ids, family, closures, sql_ids):
    demand(family.get("sourceDisposition") in ("reachable", "absent-from-verified-source"), "RESEND_MARKETING_SOURCE_DISPOSITION_REFUSED")
    covered = set()
    for row in closures:
        if isinstance(row, dict) and row.get("familyId") == family_id:
            demand(row.get("disposition") in ("no-capability-observed", "absent-from-verified-source") and
                isinstance(row.get("requirementIds"), list) and isinstance(row.get("evidenceIds"), list) and row["evidenceIds"] and
                all(digest(item) for item in row["evidenceIds"]) and
                set(row["requirementIds"]) <= set(ids) | sql_ids, "RESEND_MARKETING_CAPABILITY_CLOSURE_REFUSED")
            covered.update(row["requirementIds"])
    return bool(ids) and set(ids) <= covered


def _pagination(client, path):
    seen, rows, cursor = set(), [], None
    for _ in range(42):
        value = client.request("GET", path + "?limit=100" + ("&after=" + cursor if cursor else ""))
        data = value.get("data") if isinstance(value, dict) else None
        demand(isinstance(value, dict) and value.get("object") == "list" and type(value.get("has_more")) is bool and
            isinstance(data, list) and len(data) <= 100, "RESEND_MARKETING_PROVIDER_PAGE_REFUSED")
        for row in data:
            item = row.get("id") if isinstance(row, dict) else None
            demand(identifier(item) and item not in seen and len(rows) < MAXIMUM, "RESEND_MARKETING_PROVIDER_CURSOR_REFUSED")
            seen.add(item); rows.append(row)
        if not value["has_more"]:
            return rows
        demand(data, "RESEND_MARKETING_PROVIDER_CURSOR_REFUSED")
        cursor = data[-1]["id"]
    raise ValueError("RESEND_MARKETING_PROVIDER_LIMIT")


def _email_hash(value):
    demand(isinstance(value, str) and len(value) <= 320 and re.fullmatch(r"[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+", value.strip()),
        "RESEND_MARKETING_PROVIDER_EMAIL_REFUSED")
    return hashlib.sha256(value.strip().lower().encode()).hexdigest()


def _provider_snapshot(client, broadcasts):
    contacts, emails = [], set()
    for row in _pagination(client, "/contacts"):
        detail = client.request("GET", "/contacts/" + row["id"])
        demand(isinstance(detail, dict) and detail.get("id") == row["id"] and type(detail.get("unsubscribed")) is bool and
            _email_hash(detail.get("email")) == _email_hash(row.get("email")) and row.get("unsubscribed") == detail["unsubscribed"],
            "RESEND_MARKETING_CONTACT_DETAIL_REFUSED")
        email = _email_hash(detail["email"])
        demand(email not in emails, "RESEND_MARKETING_PROVIDER_EMAIL_DUPLICATE")
        emails.add(email)
        segments = sorted(item["id"] for item in _pagination(client, "/contacts/" + row["id"] + "/segments"))
        topics = []
        for item in _pagination(client, "/contacts/" + row["id"] + "/topics"):
            demand(item.get("subscription") in ("opt_in", "opt_out"), "RESEND_MARKETING_TOPIC_STATE_REFUSED")
            topics.append({"id": item["id"], "subscription": item["subscription"]})
        contacts.append({"providerContactId": row["id"], "emailSha256": email, "unsubscribed": detail["unsubscribed"],
            "segments": segments, "topics": sorted(topics, key=lambda item: item["id"])})
    campaign_rows = []
    if broadcasts:
        for row in _pagination(client, "/broadcasts"):
            detail = client.request("GET", "/broadcasts/" + row["id"])
            demand(isinstance(detail, dict) and detail.get("id") == row["id"] and detail.get("status") == row.get("status") and
                isinstance(detail.get("status"), str) and re.fullmatch(r"[a-z_]{1,40}", detail["status"]), "RESEND_MARKETING_BROADCAST_DETAIL_REFUSED")
            segment = detail.get("segment_id", detail.get("audience_id"))
            demand(identifier(segment), "RESEND_MARKETING_BROADCAST_SEGMENT_REFUSED")
            name = detail.get("name")
            campaign_id = name[9:] if isinstance(name, str) and name.startswith("campaign:") and identifier(name[9:]) else None
            campaign_rows.append({"providerBroadcastId": row["id"], "campaignId": campaign_id, "providerSegmentId": segment,
                "status": detail["status"]})
    return {"contacts": sorted(contacts, key=lambda item: item["providerContactId"]),
        "broadcasts": sorted(campaign_rows, key=lambda item: item["providerBroadcastId"])}


def _reduce(reviewed, actual, before):
    """Only existing durable sync jobs may complete; no new recipient/intents.

    The source unsubscribe callback may append its consent receipt, suppress
    an existing contact, cancel matching opt-in jobs and redact its unsent offer.
    All changed business state is retained in original/observed safe receipts.
    """
    current_hash = snapshot_sha256(actual)
    if current_hash == reviewed["databaseSnapshotSha256"]:
        return None
    demand(before is not None, "RESEND_MARKETING_ORIGINAL_SNAPSHOT_REQUIRED")
    original = normalize_snapshot(before.get("databaseSnapshot", before))
    demand(snapshot_sha256(original) == reviewed["databaseSnapshotSha256"], "RESEND_MARKETING_ORIGINAL_SNAPSHOT_REQUIRED")
    demand(actual["submissions"] == original["submissions"] and actual["campaigns"] == original["campaigns"],
        "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    old_consents = {row["id"]: row for row in original["consents"]}
    new_consents = {row["id"]: row for row in actual["consents"]}
    demand(all(new_consents.get(key) == row for key, row in old_consents.items()), "RESEND_MARKETING_CONSENT_HISTORY_CHANGED")
    callbacks = [row for key, row in new_consents.items() if key not in old_consents]
    old_contacts = {row["id"]: row for row in original["contacts"]}
    demand(all(row["event_type"] == "unsubscribe" and row["source"] == "resend" and identifier(row["provider_contact_id"]) and
        row["submission_id"] is None and row["contact_id"] in old_contacts and
        old_contacts[row["contact_id"]]["email_sha256"] == row["email_sha256"] for row in callbacks),
        "RESEND_MARKETING_UNDECLARED_CALLBACK")
    callback_emails = {row["email_sha256"]: row for row in callbacks}
    demand(len(callback_emails) == len(callbacks) and set(old_contacts) == {row["id"] for row in actual["contacts"]},
        "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    for new in actual["contacts"]:
        old = old_contacts[new["id"]]
        if new == old:
            continue
        callback = callback_emails.get(new["email_sha256"])
        demand(callback is not None and old["unsubscribed_at"] is None and new["unsubscribed_at"] == callback["occurred_at"] and
            _instant(new["updated_at"]) >= _instant(old["updated_at"]) and
            all(new[key] == value for key, value in old.items() if key not in ("unsubscribed_at", "updated_at")),
            "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    old_jobs = {row["id"]: row for row in original["syncJobs"]}
    demand(set(old_jobs) == {row["id"] for row in actual["syncJobs"]}, "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    changed = 0
    for new in actual["syncJobs"]:
        old = old_jobs[new["id"]]
        if new == old:
            continue
        complete = (old["status"] in ("queued", "processing", "retryable_failed") and new["status"] == "succeeded" and
            new["lease_held"] is False and old["attempts"] <= new["attempts"] <= old["attempts"] + 1 and
            new["attempts"] > 0 and new["succeeded_at"] is not None and
            _instant(new["succeeded_at"]) >= _instant(old["updated_at"]))
        cancel = (new["email_sha256"] in callback_emails and new["kind"] == "opt_in_sync" and
            old["status"] in ("queued", "processing", "retryable_failed") and new["status"] == "skipped_unconfigured" and
            new["lease_held"] is False and new["attempts"] == old["attempts"] and
            new["skipped_at"] == callback_emails[new["email_sha256"]]["occurred_at"])
        mutable = {"status", "attempts", "lease_held", "succeeded_at", "skipped_at", "updated_at"}
        demand((complete or cancel) and all(new[key] == value for key, value in old.items() if key not in mutable) and
            (cancel or new["skipped_at"] == old["skipped_at"]) and (complete or new["succeeded_at"] == old["succeeded_at"]) and
            _instant(new["updated_at"]) >= _instant(old["updated_at"]), "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
        changed += 1
    old_outbox = {row["id"]: row for row in original["outbox"]}
    demand(set(old_outbox) == {row["id"] for row in actual["outbox"]}, "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    for new in actual["outbox"]:
        old = old_outbox[new["id"]]
        if new == old:
            continue
        demand(old["email_sha256"] in callback_emails and old["status"] in ("queued", "sending", "failed", "dead_letter") and
            old["redacted"] is False and new["status"] == "dead_letter" and new["redacted"] is True and
            new["email_sha256"] is None and new["provider_message_id"] is None and new["lease_held"] is False and
            all(new[key] == value for key, value in old.items() if key not in
                ("status", "redacted", "email_sha256", "provider_message_id", "lease_held", "updated_at")) and
            _instant(new["updated_at"]) >= _instant(old["updated_at"]), "RESEND_MARKETING_UNDECLARED_DATABASE_TRANSITION")
    return {"kind": "source-durable-sync-or-unsubscribe-callback", "changedJobs": changed, "unsubscribeCallbacks": len(callbacks),
        "originalDatabaseSnapshotSha256": reviewed["databaseSnapshotSha256"], "observedDatabaseSnapshotSha256": current_hash}


def observe_scoped_effects(client, reviewed, actualRows, verifiedSourceRequirements, before=None):
    selected = review(reviewed)
    source, closures = _source(selected, verifiedSourceRequirements)
    actual = normalize_snapshot(actualRows)
    reducer = _reduce(selected, actual, before)
    ids = {key: _requirements(value) for key, value in source.items()}
    sql_rows = verifiedSourceRequirements.get("sqlCredentialRequirements", [])
    demand(isinstance(sql_rows, list), "RESEND_MARKETING_SQL_SOURCE_REQUIREMENTS_REFUSED")
    sql_ids = {row.get("requirementId") for row in sql_rows if isinstance(row, dict)}
    demand(all(isinstance(item, str) for item in sql_ids), "RESEND_MARKETING_SQL_SOURCE_REQUIREMENTS_REFUSED")
    closed = {key: _closed(key, ids[key], value, closures, sql_ids) for key, value in source.items()}
    # Original source/config closures plus complete empty SQL can prove that
    # this historical caller had no capability or effects, without obtaining an
    # unrelated replacement API key. No flag or caller-completion field selects it.
    source_closed = all(closed.values())
    sql_empty = all(not rows for rows in actual.values())
    if source_closed and sql_empty:
        covered = sorted(item for values in ids.values() for item in values)
        return {"provider": "resend", "status": "RESEND_MARKETING_EFFECTS_OBSERVED",
            "disposition": "source-inapplicable-and-effects-reconciled", "sourceInapplicable": True,
            "sourceCommit": verifiedSourceRequirements["sourceCommit"], "sourceInventorySha256": selected["sourceInventorySha256"],
            "requirementsSha256": selected["requirementsSha256"], "configurationSha256": selected["configurationSha256"],
            "originalDatabaseSnapshotSha256": selected["databaseSnapshotSha256"], "observedDatabaseSnapshotSha256": snapshot_sha256(actual),
            "databaseTransition": reducer, "families": [{"familyId": family, "sourceClosed": True, "unresolvedEffects": 0,
                "paginationComplete": False, "coveredRequirementIds": ids[family], "missingRequirementIds": []} for family in FAMILIES],
            "coveredRequirementIds": covered, "missingRequirementIds": [], "effects": [], "contactCount": 0,
            "broadcastCount": 0, "marketingOfferCount": 0, "activeExecutions": 0, "unresolvedEffects": 0, "uncertainEffects": 0,
            "providerRequestsRequired": False, "sourceClosureContradiction": False, "complete": True}
    # Provider GET failures throw a sanitized error: they never produce zero.
    demand(client is not None and callable(getattr(client, "request", None)), "RESEND_MARKETING_PROVIDER_CLIENT_REQUIRED")
    read_broadcasts = not closed["resend.broadcasts"] or bool(actual["campaigns"])
    first = _provider_snapshot(client, read_broadcasts)
    second = _provider_snapshot(client, read_broadcasts)
    demand(first == second, "RESEND_MARKETING_PROVIDER_CHANGED_DURING_OBSERVATION")
    contacts = {row["email_sha256"]: row for row in actual["contacts"]}
    demand(len(contacts) == len(actual["contacts"]), "RESEND_MARKETING_DATABASE_EMAIL_DUPLICATE")
    provider_contacts = {row["emailSha256"]: row for row in first["contacts"]}
    unknown = {key: 0 for key in FAMILIES}
    receipts = []
    for email in sorted(set(contacts) | set(provider_contacts)):
        row, provider = contacts.get(email), provider_contacts.get(email)
        jobs = [job for job in actual["syncJobs"] if job["email_sha256"] == email]
        consent = [event for event in actual["consents"] if event["email_sha256"] == email]
        suppression = row is not None and row["unsubscribed_at"] is not None
        settled = row is not None and provider is not None and provider["unsubscribed"] == suppression
        durable = any(job["status"] == "succeeded" and job["succeeded_at"] is not None and not job["lease_held"] for job in jobs)
        durable = durable or suppression and provider is not None and any(event["event_type"] == "unsubscribe" and
            event["source"] == "resend" and event["provider_contact_id"] == provider["providerContactId"] for event in consent)
        settled = settled and durable
        if not settled:
            unknown["resend.contacts"] += 1
        segment_ok, topic_ok = settled, settled
        if settled and not suppression:
            origins = {row["source"]} | {job["source"] for job in jobs if job["kind"] == "opt_in_sync" and job["attempts"] > 0}
            segment_ok = origins <= set(SOURCES) and all(set(selected["segmentIdsBySource"][origin]) <= set(provider["segments"]) for origin in origins)
            topics = {topic["id"]: topic["subscription"] for topic in provider["topics"]}
            topic_ok = origins <= set(SOURCES) and all(topics.get(item) == "opt_in" for origin in origins for item in selected["topicIdsBySource"][origin])
        unknown["resend.segments"] += not segment_ok
        unknown["resend.topics"] += not topic_ok
        receipts.append({"scope": "contact", "recordId": row["id"] if row else None,
            "providerId": provider["providerContactId"] if provider else None, "contactSettled": bool(settled),
            "membershipSettled": bool(segment_ok), "topicsSettled": bool(topic_ok)})
    # An accepted callback receipt is constrained to the observed provider contact.
    if reducer is not None:
        for event in actual["consents"]:
            if event["event_type"] == "unsubscribe" and event["source"] == "resend":
                provider = provider_contacts.get(event["email_sha256"])
                demand(provider is not None and provider["unsubscribed"] and provider["providerContactId"] == event["provider_contact_id"],
                    "RESEND_MARKETING_CALLBACK_PROVIDER_UNVERIFIED")
    leases = sum(row["lease_held"] for key in ("syncJobs", "outbox") for row in actual[key])
    def job_settled(row):
        if row["lease_held"]:
            return False
        if row["status"] == "succeeded" and row["succeeded_at"] is not None:
            return True
        # Source webhook cancels only opt-in work, after recording suppression.
        provider = provider_contacts.get(row["email_sha256"])
        return (row["kind"] == "opt_in_sync" and row["status"] == "skipped_unconfigured" and row["skipped_at"] is not None and
            provider is not None and provider["unsubscribed"] and any(event["email_sha256"] == row["email_sha256"] and
                event["event_type"] == "unsubscribe" and event["source"] == "resend" and
                event["provider_contact_id"] == provider["providerContactId"] for event in actual["consents"]))
    pending_jobs = sum(not job_settled(row) for row in actual["syncJobs"])
    unknown["resend.contacts"] += pending_jobs
    # Intent rows must remain linked even when no provider object was created.
    for intent in actual["submissions"]:
        if intent["consent_choice"] == "opted_in" and not any(
            job["submission_id"] == intent["id"] and job["email_sha256"] == intent["email_sha256"] for job in actual["syncJobs"]):
            unknown["resend.contacts"] += 1
    for event in actual["consents"]:
        if event["event_type"] in ("opt_in", "backfill_consent") and not any(
            job["consent_event_id"] == event["id"] and job["email_sha256"] == event["email_sha256"] for job in actual["syncJobs"]):
            unknown["resend.contacts"] += 1
    # Every attempted opt-in can issue a best-effort event whose result the
    # source does not persist. Do not infer that outcome from contact state.
    event_attempts = sum(row["kind"] == "opt_in_sync" and row["attempts"] > 0 for row in actual["syncJobs"])
    unknown["resend.events"] += event_attempts
    campaigns = {row["id"]: row for row in actual["campaigns"]}
    seen_campaigns = set()
    for provider in first["broadcasts"]:
        row = campaigns.get(provider["campaignId"])
        matched = row is not None and row["provider_broadcast_id"] == provider["providerBroadcastId"] and row["provider_segment_id"] == provider["providerSegmentId"]
        settled = matched and ((row["status"] == "sent" and row["sent_at"] is not None and provider["status"] == "sent") or
            row["status"] == provider["status"] == "canceled")
        if row:
            seen_campaigns.add(row["id"])
        unknown["resend.broadcasts"] += not settled
        receipts.append({"scope": "broadcast", "recordId": row["id"] if row else None, "providerId": provider["providerBroadcastId"],
            "dispatchSettled": bool(settled)})
    for row in actual["campaigns"]:
        if row["id"] not in seen_campaigns and (row["status"] != "draft" or row["provider_broadcast_id"] is not None):
            unknown["resend.broadcasts"] += 1
    # Marketing offer messages are durable intents too. Read provider outcomes;
    # redaction/dead-letter status alone cannot settle a lost send acknowledgement.
    offer_unknown = 0
    original_outbox = {}
    if reducer is not None:
        original_snapshot = normalize_snapshot(before.get("databaseSnapshot", before))
        original_outbox = {row["id"]: row for row in original_snapshot["outbox"]}
    for row in actual["outbox"]:
        old = original_outbox.get(row["id"])
        terminal = bool(old is not None and old["status"] == "queued" and old["attempt_count"] == 0 and
            old["lease_held"] is False and old["provider_message_id"] is None and row["status"] == "dead_letter" and
            row["redacted"] is True and row["attempt_count"] == 0 and row["lease_held"] is False)
        if row["provider_message_id"] is not None and row["status"] == "sent" and row["sent_at"] is not None and not row["lease_held"]:
            value = client.request("GET", "/emails/" + row["provider_message_id"])
            terminal = isinstance(value, dict) and value.get("id") == row["provider_message_id"] and value.get("last_event") in (
                "delivered", "opened", "clicked", "bounced", "complained", "failed", "canceled", "suppressed")
            recipients = value.get("to") if isinstance(value, dict) else None
            terminal = terminal and isinstance(recipients, list) and len(recipients) == 1 and row["email_sha256"] is not None and _email_hash(recipients[0]) == row["email_sha256"]
        offer_unknown += not terminal
    families, covered, missing = [], [], []
    for family in FAMILIES:
        # Untracked requests are not implicitly settled by an empty list. Only
        # original source/config proof may close such a requirement.
        untracked = source[family]["untrackedPotentialRequests"]
        count = 0 if closed[family] else unknown[family] + len(untracked)
        if family == "resend.contacts" and not closed[family]:
            count += offer_unknown
        if family == "resend.contacts" and source_closed and not sql_empty:
            # A source-wide no-capability closure cannot erase retained intents.
            count += 1
        families.append({"familyId": family, "sourceClosed": closed[family], "unresolvedEffects": count,
            "paginationComplete": True, "coveredRequirementIds": ids[family] if count == 0 else [],
            "missingRequirementIds": [] if count == 0 else ids[family]})
        (covered if count == 0 else missing).extend(ids[family])
    total = sum(row["unresolvedEffects"] for row in families)
    return {"provider": "resend", "status": "RESEND_MARKETING_EFFECTS_OBSERVED", "sourceCommit": verifiedSourceRequirements["sourceCommit"],
        "sourceInventorySha256": selected["sourceInventorySha256"], "requirementsSha256": selected["requirementsSha256"],
        "configurationSha256": selected["configurationSha256"], "originalDatabaseSnapshotSha256": selected["databaseSnapshotSha256"],
        "observedDatabaseSnapshotSha256": snapshot_sha256(actual), "databaseTransition": reducer,
        "families": families, "coveredRequirementIds": sorted(covered), "missingRequirementIds": sorted(missing),
        "effects": receipts, "contactCount": len(first["contacts"]), "broadcastCount": len(first["broadcasts"]),
        "marketingOfferCount": len(actual["outbox"]), "activeExecutions": leases, "unresolvedEffects": total,
        "providerRequestsRequired": True, "sourceInapplicable": False, "sourceClosureContradiction": source_closed and not sql_empty,
        "uncertainEffects": total, "complete": total == 0 and leases == 0}
