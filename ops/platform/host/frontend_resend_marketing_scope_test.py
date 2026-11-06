"""Owned TLS/SQL qualification. No live Resend request or private fixture output."""
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
import urllib.error
import urllib.request
from unittest.mock import patch

import frontend_scoped_provider_client as transport
import uuid

import frontend_release_adapters as adapters
import frontend_resend_marketing_scope as component
import vercel
import vercel_test

TIME = "2026-11-05 10:00:00+00:00"
LATER = "2026-11-05 11:00:00+00:00"
CONTACT = "11111111-1111-4111-8111-111111111111"
PROVIDER = "22222222-2222-4222-8222-222222222222"
JOB = "33333333-3333-4333-8333-333333333333"
SEGMENT = "44444444-4444-4444-8444-444444444444"
TOPIC = "55555555-5555-4555-8555-555555555555"
CAMPAIGN = "66666666-6666-4666-8666-666666666666"
BROADCAST = "77777777-7777-4777-8777-777777777777"
CONSENT = "88888888-8888-4888-8888-888888888888"
OFFER = "99999999-9999-4999-8999-999999999999"
EMAIL = "private-owned-recipient@example.test"
EMAIL_SHA = hashlib.sha256(EMAIL.encode()).hexdigest()


def empty():
    return {key: [] for key in component.COLUMNS}


def contact():
    return {"id": CONTACT, "email_sha256": EMAIL_SHA, "source": "contact_popup", "unsubscribed_at": LATER,
        "last_consented_at": TIME, "updated_at": LATER}


def job():
    return {"id": JOB, "contact_id": CONTACT, "submission_id": None, "consent_event_id": None, "email_sha256": EMAIL_SHA,
        "source": "contact_popup", "kind": "unsubscribe_sync", "status": "succeeded", "attempts": 1, "max_attempts": 5, "lease_held": False,
        "succeeded_at": LATER, "skipped_at": None, "updated_at": LATER}


def consent():
    return {"id": CONSENT, "contact_id": CONTACT, "submission_id": None, "email_sha256": EMAIL_SHA,
        "event_type": "unsubscribe", "source": "resend", "provider_contact_id": PROVIDER, "occurred_at": LATER}


def offer():
    return {"id": OFFER, "submission_id": None, "email_sha256": EMAIL_SHA, "status": "sent", "provider_message_id": BROADCAST,
        "attempt_count": 1, "lease_held": False, "redacted": False, "sent_at": LATER, "updated_at": LATER}


def requirements():
    return {"status": "FRONTEND_HISTORICAL_SOURCE_VERIFIED", "sourceCommit": "a" * 40,
        "sourceInventorySha256": "b" * 64, "requirementsSha256": "c" * 64,
        "surfaceSha256": "e" * 64, "configurationRecordSha256": "d" * 64, "provenanceSha256": "f" * 64,
        "sqlCredentialRequirements": [{"requirementId": "sql-credentials." + key} for key in
            ("BACKUP_RESTORE_DATABASE_URL", "DATABASE_URL", "STAGING_DATABASE_URL", "TEST_DATABASE_URL")],
        "providerFamilies": [{"familyId": key, "sourceDisposition": "reachable", "configurationConditions": [], "sqlIntentRequirements":
            [{"requirementId": key + ".durable-intent"}], "untrackedPotentialRequests": []} for key in component.FAMILIES],
        "capabilityClosures": []}


def reviewed(rows):
    return {"environment": "staging", "sourceCommit": "a" * 40, "surfaceSha256": "e" * 64,
        "databaseSnapshotSha256": component.snapshot_sha256(rows), "sourceInventorySha256": "b" * 64,
        "requirementsSha256": "c" * 64, "configurationSha256": "d" * 64,
        "segmentIdsBySource": {key: [SEGMENT] for key in component.SOURCES},
        "topicIdsBySource": {key: [TOPIC] for key in component.SOURCES}}


def source_closure(source, family):
    ids = {row["requirementId"] for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for row in family[key]}
    ids.update(row["requirementId"] for row in source["sqlCredentialRequirements"])
    return {"familyId": family["familyId"], **{key: source[key] for key in
        ("sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256")},
        "disposition": "absent-from-verified-source" if family["sourceDisposition"] == "absent-from-verified-source" else "no-capability-observed",
        "requirementIds": sorted(ids), "evidenceIds": sorted({source[key] for key in
            ("sourceInventorySha256", "requirementsSha256", "configurationRecordSha256", "provenanceSha256")} | {"1" * 64})}


class MarketingScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.rows, self.source = empty(), requirements()
        self.plan = reviewed(self.rows)
        self.provider_contacts = []
        self.broadcasts = []
        self.segments = [{"id": SEGMENT}]
        self.topics = [{"id": TOPIC, "subscription": "opt_in"}]
        self.calls, self.checkpoints = [], []
        self.response_mode = None
        self.page_repeat, self.drift, self.read_count = False, False, 0
        self.email_state = "delivered"
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                owner.calls.append((self.command, self.path))
                owner.assertEqual(self.headers.get("Authorization"), "Bearer owned-fixture-only")
                if owner.response_mode:
                    if owner.response_mode == "redirect":
                        self.send_response(302); self.send_header("Location", "/unapproved"); self.end_headers(); return
                    if owner.response_mode == "denied":
                        self.send_response(403); self.end_headers(); self.wfile.write(b'private-provider-error'); return
                    self.send_response(200); self.end_headers()
                    self.wfile.write(b'x' * 2_000_001 if owner.response_mode == "oversized" else b'private-malformed-provider-error'); return
                path, _, query = self.path.partition("?")
                if path == "/contacts":
                    owner.read_count += 1
                    rows = deepcopy(owner.provider_contacts)
                    if owner.drift and owner.read_count > 1 and rows: rows[0]["unsubscribed"] = not rows[0]["unsubscribed"]
                    value = self.page(rows, query)
                elif path.startswith("/contacts/") and path.endswith("/segments"):
                    value = self.page(owner.segments, query)
                elif path.startswith("/contacts/") and path.endswith("/topics"):
                    value = self.page(owner.topics, query)
                elif path.startswith("/contacts/"):
                    value = next(deepcopy(row) for row in owner.provider_contacts if row["id"] == path.split("/")[2])
                    value.update(first_name="private-name", private_body="private-profile-marker")
                elif path == "/broadcasts":
                    value = self.page(owner.broadcasts, query)
                elif path.startswith("/broadcasts/"):
                    value = next(deepcopy(row) for row in owner.broadcasts if row["id"] == path.split("/")[2])
                    value.update(subject="private-subject", html="private-message")
                elif path.startswith("/emails/"):
                    value = {"id": path.split("/")[2], "last_event": owner.email_state, "to": [EMAIL], "html": "private-message"}
                else:
                    self.send_response(500); self.end_headers(); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(json.dumps(value).encode())
            def page(self, rows, query):
                cursor = query.split("after=", 1)[1] if "after=" in query else None
                if cursor and not owner.page_repeat:
                    rows = rows[next(i for i, row in enumerate(rows) if row["id"] == cursor) + 1:]
                return {"object": "list", "has_more": len(rows) > 100, "data": rows[:100]}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        origin = f"https://127.0.0.1:{self.server.server_port}"
        tls_client = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        self.origin_patch = patch.dict(transport.ORIGINS, {"resend": origin}); self.origin_patch.start()
        with patch.object(transport.ssl, "create_default_context", return_value=tls_client):
            real_client = transport.Client("resend", "owned-fixture-only", self.plan, component.read_only_request)
        self.client = adapters.LockedClient(real_client, lambda: self.checkpoints.append("checked"))

    def tearDown(self):
        self.origin_patch.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(all(method == "GET" for method, _path in self.calls))
        self.assertEqual(len(self.checkpoints), 2 * len(self.calls))

    def observe(self, before=None):
        self.plan.update(databaseSnapshotSha256=component.snapshot_sha256(before if before is not None else self.rows))
        return component.observe_scoped_effects(self.client, {"resendMarketing": self.plan}, self.rows, self.source, before)

    def populated(self):
        self.rows["contacts"] = [contact()]
        self.rows["syncJobs"] = [job()]
        self.provider_contacts = [{"id": PROVIDER, "email": EMAIL.upper(), "unsubscribed": True}]

    def test_empty_actual_inventory_and_zero_intents_settles_supported_scope(self):
        receipt = self.observe()
        self.assertTrue(receipt["complete"])
        self.assertEqual(receipt["uncertainEffects"], 0)
        self.assertEqual(len(receipt["coveredRequirementIds"]), 5)

    def test_subscribed_contact_needs_exact_membership_and_topics_and_event_is_still_unknown(self):
        self.populated(); self.rows["contacts"][0]["unsubscribed_at"] = None
        self.rows["syncJobs"][0]["kind"] = "opt_in_sync"; self.provider_contacts[0]["unsubscribed"] = False
        receipt = self.observe()
        self.assertFalse(receipt["complete"])
        self.assertEqual(receipt["uncertainEffects"], 1)
        self.assertEqual(receipt["missingRequirementIds"], ["resend.events.durable-intent"])
        self.topics[0]["subscription"] = "opt_out"; self.segments = []
        changed = self.observe()
        self.assertGreater(changed["uncertainEffects"], receipt["uncertainEffects"])

    def test_unsubscribe_success_privately_matches_normalized_email_and_sanitizes_receipt(self):
        self.populated(); receipt = self.observe()
        self.assertTrue(receipt["complete"])
        raw = json.dumps(receipt)
        for marker in (EMAIL, EMAIL_SHA, "private-", "owned-fixture-only", "subject", "html"):
            self.assertNotIn(marker, raw)

    def test_unmatched_contact_is_unknown_and_never_deleted(self):
        self.populated(); self.rows = empty()
        self.assertGreater(self.observe()["uncertainEffects"], 0)

    def test_pending_deadletter_lost_ack_and_any_lease_stay_unknown(self):
        self.populated()
        for state in ("queued", "processing", "retryable_failed", "dead_letter", "skipped_unconfigured"):
            with self.subTest(state=state):
                self.rows["syncJobs"][0].update(status=state, succeeded_at=None)
                self.assertFalse(self.observe()["complete"])
        self.rows["syncJobs"][0] = job(); self.rows["syncJobs"][0]["lease_held"] = True
        self.assertEqual(self.observe()["activeExecutions"], 1)

    def test_complete_pagination_including_second_page_contacts_segments_and_topics(self):
        self.provider_contacts = [{"id": f"{i:08x}-1111-4111-8111-111111111111", "email": f"private-{i}@example.test", "unsubscribed": True} for i in range(101)]
        self.segments = [{"id": f"{i:08x}-2222-4222-8222-222222222222"} for i in range(101)]
        self.topics = [{"id": f"{i:08x}-3333-4333-8333-333333333333", "subscription": "opt_in"} for i in range(101)]
        receipt = self.observe()
        self.assertEqual(receipt["contactCount"], 101)
        self.assertTrue(any("/contacts?limit=100&after=" in path for _method, path in self.calls))
        self.assertTrue(any("/topics?limit=100&after=" in path for _method, path in self.calls))

    def test_repeated_cursor_and_drift_are_refused(self):
        self.provider_contacts = [{"id": f"{i:08x}-1111-4111-8111-111111111111", "email": f"private-{i}@example.test", "unsubscribed": True} for i in range(101)]
        self.page_repeat = True
        with self.assertRaisesRegex(ValueError, "CURSOR_REFUSED"): self.observe()
        self.page_repeat = False; self.populated(); self.drift = True; self.read_count = 0
        with self.assertRaises(ValueError): self.observe()

    def test_http_denial_redirect_oversized_and_malformed_never_settle(self):
        for mode in ("denied", "redirect", "oversized", "malformed"):
            with self.subTest(mode=mode):
                self.response_mode = mode
                with self.assertRaisesRegex(ValueError, "SCOPED_PROVIDER"): self.observe()

    def test_read_scope_rejects_mutations_unreviewed_ids_queries_and_email_addresses(self):
        for method, path, body in (("POST", "/contacts", {}), ("DELETE", "/contacts/" + PROVIDER, None),
            ("GET", "/contacts?limit=100&after=../../", None), ("GET", "/contacts/" + EMAIL, None),
            ("GET", "/broadcasts?limit=101", None), ("GET", "https://evil.test/contacts", None)):
            self.assertFalse(component.read_only_request(method, path, body, self.plan))

    def test_broadcast_terminal_dispatch_requires_durable_provider_binding_and_name(self):
        self.rows["campaigns"] = [{"id": CAMPAIGN, "status": "sent", "provider_broadcast_id": BROADCAST,
            "provider_segment_id": SEGMENT, "scheduled_at": None, "sent_at": TIME, "updated_at": TIME}]
        self.broadcasts = [{"id": BROADCAST, "name": "campaign:" + CAMPAIGN, "segment_id": SEGMENT, "status": "sent"}]
        self.assertTrue(self.observe()["complete"])
        for state in ("draft", "scheduled", "queued", "sending", "unknown"):
            self.broadcasts[0]["status"] = state
            self.assertFalse(self.observe()["complete"])
        self.broadcasts[0]["status"] = "sent"; self.rows["campaigns"][0]["provider_broadcast_id"] = None
        self.assertFalse(self.observe()["complete"])

    def test_broadcast_source_closure_needs_bound_source_proof_not_false_flags(self):
        family = next(row for row in self.source["providerFamilies"] if row["familyId"] == "resend.broadcasts")
        family["untrackedPotentialRequests"] = [{"requirementId": "resend.broadcasts.untracked"}]
        self.assertFalse(self.observe()["complete"])
        self.plan["flagsEnabled"] = False
        self.assertFalse(self.observe()["complete"])
        self.source["capabilityClosures"] = [source_closure(self.source, family)]
        before_calls = len(self.calls)
        self.assertTrue(self.observe()["complete"])
        self.assertTrue(any(path.startswith("/broadcasts") for _method, path in self.calls[before_calls:]))
        self.source["sourceInventorySha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "VERIFIED_SOURCE_REQUIRED"): self.observe()

    def close_all(self):
        self.source["capabilityClosures"] = [source_closure(self.source, family) for family in self.source["providerFamilies"]]

    def test_exact_all_source_closures_and_empty_sql_require_no_provider_credential_or_request(self):
        self.close_all()
        self.plan["databaseSnapshotSha256"] = component.snapshot_sha256(self.rows)
        receipt = component.observe_scoped_effects(None, self.plan, self.rows, self.source)
        self.assertTrue(receipt["complete"])
        self.assertFalse(receipt["providerRequestsRequired"])
        self.assertEqual(receipt["disposition"], "source-inapplicable-and-effects-reconciled")
        self.assertEqual(receipt["uncertainEffects"], 0)
        self.assertEqual(len(receipt["coveredRequirementIds"]), 9)
        self.assertEqual(self.calls, [])

    def test_partial_closure_or_source_disposition_without_closure_cannot_skip_provider_reads(self):
        self.close_all(); self.source["capabilityClosures"].pop()
        self.source["providerFamilies"][-1]["sourceDisposition"] = "absent-from-verified-source"
        receipt = self.observe()
        self.assertTrue(receipt["providerRequestsRequired"])
        self.assertTrue(self.calls)

    def test_nonempty_sql_contradicts_all_source_closures_and_remains_unknown(self):
        self.populated(); self.close_all()
        receipt = self.observe()
        self.assertFalse(receipt["complete"])
        self.assertTrue(receipt["sourceClosureContradiction"])
        self.assertTrue(self.calls)
        self.assertTrue(receipt["missingRequirementIds"])

    def test_campaign_rows_contradicting_closure_require_real_broadcast_observation(self):
        self.close_all()
        self.rows["campaigns"] = [{"id": CAMPAIGN, "status": "sent", "provider_broadcast_id": BROADCAST,
            "provider_segment_id": SEGMENT, "scheduled_at": None, "sent_at": TIME, "updated_at": TIME}]
        self.broadcasts = [{"id": BROADCAST, "name": "campaign:" + CAMPAIGN, "segment_id": SEGMENT, "status": "sent"}]
        result = self.observe()
        self.assertFalse(result["complete"])
        self.assertTrue(any(path.startswith("/broadcasts") for _method, path in self.calls))
        with self.assertRaisesRegex(ValueError, "PROVIDER_CLIENT_REQUIRED"):
            component.observe_scoped_effects(None, self.plan, self.rows, self.source)

    def test_global_sql_requirements_cannot_be_omitted_from_any_closure(self):
        self.close_all()
        self.source["capabilityClosures"][0]["requirementIds"].remove("sql-credentials.DATABASE_URL")
        with self.assertRaisesRegex(ValueError, "CAPABILITY_CLOSURE_REFUSED"): self.observe()
        self.assertEqual(self.calls, [])

    def test_absent_disposition_cannot_close_reachable_source(self):
        self.close_all(); self.source["capabilityClosures"][0]["disposition"] = "absent-from-verified-source"
        with self.assertRaisesRegex(ValueError, "CAPABILITY_CLOSURE_REFUSED"): self.observe()
        self.assertEqual(self.calls, [])

    def test_duplicate_closures_and_noncanonical_requirements_or_evidence_are_refused(self):
        self.close_all(); valid = deepcopy(self.source["capabilityClosures"])
        variants = [valid + [deepcopy(valid[0])]]
        for key in ("requirementIds", "evidenceIds"):
            bad = deepcopy(valid); bad[0][key].append(bad[0][key][0]); variants.append(bad)
            bad = deepcopy(valid); bad[0][key].reverse(); variants.append(bad)
        bad = deepcopy(valid); bad[0]["evidenceIds"] = ["1" * 64]; variants.append(bad)
        for variant in variants:
            self.source["capabilityClosures"] = variant
            with self.assertRaisesRegex(ValueError, "CAPABILITY_CLOSURE"): self.observe()
        self.assertEqual(self.calls, [])

    def test_actual_source_context_must_match_reviewed_surface_and_each_closure(self):
        self.close_all(); valid = deepcopy(self.source)
        for key, wrong in (("sourceCommit", "0" * 40), ("surfaceSha256", "0" * 64), ("configurationRecordSha256", "0" * 64)):
            self.source = deepcopy(valid); self.source[key] = wrong
            with self.assertRaisesRegex(ValueError, "VERIFIED_(SOURCE|SURFACE)_REQUIRED"): self.observe()
        for key, wrong in (("sourceCommit", "0" * 40), ("surfaceSha256", "0" * 64),
            ("configurationRecordSha256", "0" * 64), ("provenanceSha256", "0" * 64)):
            self.source = deepcopy(valid); self.source["capabilityClosures"][0][key] = wrong
            with self.assertRaisesRegex(ValueError, "CAPABILITY_CLOSURE_REFUSED"): self.observe()
        self.assertEqual(self.calls, [])

    def test_partial_broadcast_closure_cannot_erase_actual_sql_and_provider_mismatch(self):
        family = next(row for row in self.source["providerFamilies"] if row["familyId"] == "resend.broadcasts")
        self.source["capabilityClosures"] = [source_closure(self.source, family)]
        self.rows["campaigns"] = [{"id": CAMPAIGN, "status": "sent", "provider_broadcast_id": BROADCAST,
            "provider_segment_id": SEGMENT, "scheduled_at": None, "sent_at": TIME, "updated_at": TIME}]
        self.broadcasts = [{"id": BROADCAST, "name": "campaign:" + CAMPAIGN, "segment_id": SEGMENT, "status": "draft"}]
        result = self.observe(); observed = next(row for row in result["families"] if row["familyId"] == family["familyId"])
        self.assertFalse(result["complete"]); self.assertGreater(observed["unresolvedEffects"], 0)
        self.assertTrue(observed["sourceClosureContradiction"]); self.assertFalse(observed["sourceClosed"])
        self.assertIn("resend.broadcasts.durable-intent", observed["missingRequirementIds"])
        self.assertFalse(observed["coveredRequirementIds"])

    def test_partial_broadcast_closure_does_not_hide_unmatched_provider_objects_without_sql(self):
        family = next(row for row in self.source["providerFamilies"] if row["familyId"] == "resend.broadcasts")
        self.source["capabilityClosures"] = [source_closure(self.source, family)]
        self.broadcasts = [{"id": BROADCAST, "name": "owned-unmatched", "segment_id": SEGMENT, "status": "queued"}]
        result = self.observe(); observed = next(row for row in result["families"] if row["familyId"] == family["familyId"])
        self.assertTrue(any(path.startswith("/broadcasts") for _method, path in self.calls))
        self.assertFalse(result["complete"]); self.assertGreater(observed["unresolvedEffects"], 0)
        self.assertTrue(result["sourceClosureContradiction"])

    def test_partial_contact_closure_cannot_erase_pending_intent_or_unmatched_provider(self):
        self.populated(); self.rows["syncJobs"][0].update(status="queued", succeeded_at=None)
        family = next(row for row in self.source["providerFamilies"] if row["familyId"] == "resend.contacts")
        self.source["capabilityClosures"] = [source_closure(self.source, family)]
        for rows in (deepcopy(self.rows), empty()):
            self.rows = rows; result = self.observe()
            observed = next(row for row in result["families"] if row["familyId"] == family["familyId"])
            self.assertFalse(result["complete"]); self.assertGreater(observed["unresolvedEffects"], 0)
            self.assertTrue(observed["sourceClosureContradiction"])

    def test_partial_event_closure_cannot_erase_an_attempted_optin(self):
        self.populated(); self.rows["syncJobs"][0]["kind"] = "opt_in_sync"
        family = next(row for row in self.source["providerFamilies"] if row["familyId"] == "resend.events")
        self.source["capabilityClosures"] = [source_closure(self.source, family)]
        result = self.observe(); observed = next(row for row in result["families"] if row["familyId"] == family["familyId"])
        self.assertFalse(result["complete"]); self.assertGreater(observed["unresolvedEffects"], 0)
        self.assertTrue(observed["sourceClosureContradiction"]); self.assertFalse(observed["paginationComplete"])

    def test_original_snapshot_cannot_be_ignored_on_unchanged_current_hash(self):
        self.close_all(); before = empty(); before["contacts"] = [contact()]
        with self.assertRaisesRegex(ValueError, "ORIGINAL_SNAPSHOT_REQUIRED"):
            component.observe_scoped_effects(None, self.plan, self.rows, self.source, before)

    def test_untracked_event_requirement_cannot_be_settled_by_empty_provider_list(self):
        self.source["providerFamilies"][-1]["untrackedPotentialRequests"] = [{"requirementId": "resend.events.untracked-send"}]
        receipt = self.observe()
        self.assertFalse(receipt["complete"])
        self.assertIn("resend.events.untracked-send", receipt["missingRequirementIds"])

    def test_marketing_offer_needs_actual_matching_terminal_email_outcome(self):
        self.rows["outbox"] = [offer()]
        self.assertTrue(self.observe()["complete"])
        self.email_state = "scheduled"
        self.assertFalse(self.observe()["complete"])
        self.rows["outbox"][0].update(status="dead_letter", redacted=True, provider_message_id=None, email_sha256=None)
        self.assertFalse(self.observe()["complete"])

    def test_normal_job_completion_uses_same_original_prestate_without_reapproval(self):
        self.populated(); before = deepcopy(self.rows)
        before["syncJobs"][0].update(status="processing", lease_held=True, succeeded_at=None, updated_at=TIME)
        self.rows["syncJobs"][0]["attempts"] = 4
        result = self.observe(before)
        self.assertTrue(result["complete"])
        self.assertNotEqual(result["originalDatabaseSnapshotSha256"], result["observedDatabaseSnapshotSha256"])
        self.assertEqual(result["databaseTransition"]["changedJobs"], 1)
        self.rows["syncJobs"][0]["email_sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "UNDECLARED_DATABASE_TRANSITION"): self.observe(before)

    def test_completion_cannot_expand_original_retry_budget_or_decrease_attempts(self):
        self.populated(); before = deepcopy(self.rows)
        before["syncJobs"][0].update(status="processing", attempts=2, succeeded_at=None, updated_at=TIME)
        self.rows["syncJobs"][0].update(attempts=4, max_attempts=6)
        with self.assertRaisesRegex(ValueError, "UNDECLARED_DATABASE_TRANSITION"): self.observe(before)
        self.rows["syncJobs"][0].update(attempts=1, max_attempts=5)
        with self.assertRaisesRegex(ValueError, "UNDECLARED_DATABASE_TRANSITION"): self.observe(before)
        self.rows["syncJobs"][0]["attempts"] = 6
        with self.assertRaisesRegex(ValueError, "RETRY_BUDGET_REFUSED"): component.normalize_snapshot(self.rows)

    def test_source_callback_unsubscribe_reduces_only_owned_contact_and_cancels_matching_optin(self):
        self.populated(); before = deepcopy(self.rows)
        before["contacts"][0].update(unsubscribed_at=None, updated_at=TIME)
        before["syncJobs"][0].update(kind="opt_in_sync", status="queued", attempts=0, succeeded_at=None, updated_at=TIME)
        self.rows["syncJobs"][0].update(kind="opt_in_sync", status="skipped_unconfigured", attempts=0, succeeded_at=None, skipped_at=LATER)
        self.rows["consents"] = [consent()]
        result = self.observe(before)
        self.assertTrue(result["complete"])
        self.assertEqual(result["databaseTransition"]["unsubscribeCallbacks"], 1)
        self.rows["consents"][0]["provider_contact_id"] = BROADCAST
        with self.assertRaisesRegex(ValueError, "CALLBACK_PROVIDER_UNVERIFIED"): self.observe(before)

    def test_callback_redaction_preserves_unknown_send_and_retained_consent_history(self):
        self.populated(); before = deepcopy(self.rows)
        before["contacts"][0].update(unsubscribed_at=None, updated_at=TIME)
        before["outbox"] = [offer()]; before["outbox"][0].update(status="sending", lease_held=True, sent_at=None, updated_at=TIME)
        self.rows["consents"] = [consent()]
        self.rows["outbox"] = [dict(before["outbox"][0], status="dead_letter", lease_held=False, redacted=True,
            provider_message_id=None, email_sha256=None, updated_at=LATER)]
        self.assertFalse(self.observe(before)["complete"])
        before["consents"] = [consent()]; self.rows["consents"] = []
        with self.assertRaisesRegex(ValueError, "CONSENT_HISTORY_CHANGED"): self.observe(before)

    def test_callback_can_settle_never_claimed_offer_from_its_same_original_intent(self):
        self.populated(); before = deepcopy(self.rows)
        before["contacts"][0].update(unsubscribed_at=None, updated_at=TIME)
        before["outbox"] = [offer()]; before["outbox"][0].update(status="queued", attempt_count=0,
            provider_message_id=None, sent_at=None, updated_at=TIME)
        self.rows["consents"] = [consent()]
        self.rows["outbox"] = [dict(before["outbox"][0], status="dead_letter", redacted=True, email_sha256=None, updated_at=LATER)]
        self.assertTrue(self.observe(before)["complete"])

    def test_original_snapshot_required_and_new_campaign_or_intent_not_accepted(self):
        self.populated(); before = deepcopy(self.rows); self.rows["contacts"][0]["source"] = "booking"
        with self.assertRaisesRegex(ValueError, "UNDECLARED_DATABASE_TRANSITION"): self.observe(before)
        self.plan["databaseSnapshotSha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "ORIGINAL_SNAPSHOT_REQUIRED"):
            component.observe_scoped_effects(self.client, self.plan, self.rows, self.source)

    def test_opted_in_submission_without_its_durable_job_cannot_settle(self):
        self.rows["submissions"] = [{"id": CONSENT, "email_sha256": EMAIL_SHA, "submission_type": "contact_popup",
            "consent_choice": "opted_in", "submitted_at": TIME}]
        self.assertFalse(self.observe()["complete"])

    def test_unknown_job_kind_cannot_bypass_event_outcome_tracking(self):
        self.populated(); self.rows["syncJobs"][0]["kind"] = "unrecognized"
        with self.assertRaisesRegex(ValueError, "STATE_REFUSED"): component.normalize_snapshot(self.rows)

    def test_normalizer_rejects_pii_columns_duplicate_ids_and_unbounded_rows(self):
        self.rows["contacts"] = [dict(contact(), email=EMAIL)]
        with self.assertRaisesRegex(ValueError, "COLUMNS_REFUSED"): component.normalize_snapshot(self.rows)
        self.rows["contacts"] = [contact(), contact()]
        with self.assertRaisesRegex(ValueError, "DUPLICATE"): component.normalize_snapshot(self.rows)
        self.rows["contacts"] = [contact()] * 4097
        with self.assertRaisesRegex(ValueError, "DATABASE_LIMIT"): component.normalize_snapshot(self.rows)


@unittest.skipUnless(os.environ.get("FRONTEND_RESEND_MARKETING_POSTGRES_TEST") == "true", "explicit owned disposable PG fixture only")
class MarketingDatabaseTests(unittest.TestCase):
    """Use actual migrations and literal verifier SQL with TLS/SCRAM."""
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass(); cls.addClassCleanup(vercel_test.VercelControlTests.tearDownClass)
        cls.cluster = tempfile.TemporaryDirectory(prefix="resend-marketing-owned-")
        cls.root = Path(cls.cluster.name); cls.data = cls.root / "data"; cls.started = False
        cls.addClassCleanup(cls.cleanup_cluster)
        cls.bin = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@16/bin"))
        version = subprocess.check_output([str(cls.bin / "postgres"), "--version"], text=True)
        if not any(f"PostgreSQL) {major}." in version for major in (16, 18)): raise ValueError("OWNED_POSTGRES_REQUIRED")
        cls.password = "owned-" + str(uuid.uuid4()); pwfile = cls.root / "password"; pwfile.write_text(cls.password); pwfile.chmod(0o600)
        subprocess.run([str(cls.bin / "initdb"), "-D", str(cls.data), "-U", "resend_marketing_fixture", "-A", "scram-sha-256", "--pwfile", str(pwfile), "--locale=C", "-E", "UTF8"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        with socket.socket() as probe: probe.bind(("127.0.0.1", 0)); cls.port = probe.getsockname()[1]
        cert, key = vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key
        (cls.data / "postgresql.conf").write_text(f"listen_addresses='127.0.0.1'\nport={cls.port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='{cert}'\nssl_key_file='{key}'\npassword_encryption='scram-sha-256'\n")
        (cls.data / "pg_hba.conf").write_text("hostssl all all 127.0.0.1/32 scram-sha-256\n")
        subprocess.run([str(cls.bin / "pg_ctl"), "-D", str(cls.data), "-l", str(cls.root / "postgres.log"), "-w", "start"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE); cls.started = True
        cls.environment = {"PATH": os.environ.get("PATH", ""), "PGPASSWORD": cls.password, "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(cert)}
        cls.repository = Path(__file__).resolve().parents[3]
        journal = json.loads((cls.repository / "drizzle/meta/_journal.json").read_text())
        for entry in journal["entries"]: cls.sql("BEGIN;\n" + (cls.repository / "drizzle" / (entry["tag"] + ".sql")).read_text() + "\nCOMMIT;")
        cls.migration_count = len(journal["entries"])

    @classmethod
    def tearDownClass(cls): pass  # registered class cleanups also handle failed setup

    @classmethod
    def sql(cls, value):
        result = subprocess.run([str(cls.bin / "psql"), "-X", "-h", "127.0.0.1", "-p", str(cls.port), "-U", "resend_marketing_fixture", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-A", "-t"], input=value, text=True, env=cls.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode: raise AssertionError("OWNED_POSTGRES_QUERY_FAILED")
        return result.stdout.strip()

    @classmethod
    def cleanup_cluster(cls):
        try:
            if cls.started: subprocess.run([str(cls.bin / "pg_ctl"), "-D", str(cls.data), "-m", "immediate", "-w", "stop"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        finally: cls.cluster.cleanup()

    setUp = MarketingScopeTests.setUp
    tearDown = MarketingScopeTests.tearDown
    observe = MarketingScopeTests.observe
    populated = MarketingScopeTests.populated

    def actual(self):
        pieces = []
        for name, sql, params in component.database_queries(self.plan):
            self.assertEqual(params, [])
            pieces.append("'" + name + "', (SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM (" + sql + ") r)")
        raw = self.sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object(" + ",".join(pieces) + ");\nCOMMIT;")
        return component.normalize_snapshot(json.loads(next(line for line in raw.splitlines() if line.startswith("{"))))

    def test_fixed_sql_against_actual_schema_normalizes_hashes_and_joins_provider_state(self):
        self.assertEqual(self.migration_count, 83)
        self.sql("DELETE FROM marketing_contact_sync_jobs; DELETE FROM marketing_consent_events; DELETE FROM marketing_contacts;")
        self.sql(f"""INSERT INTO marketing_contacts(id,email,email_normalized,source,first_consented_at,last_consented_at,unsubscribed_at)
            VALUES ('{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','{TIME}','{TIME}','{LATER}');
          INSERT INTO marketing_contact_sync_jobs(id,idempotency_key,contact_id,email,email_normalized,source,kind,payload,status,attempts,succeeded_at)
            VALUES ('{JOB}','owned-sync','{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','unsubscribe_sync','{{}}','succeeded',1,'{LATER}');""")
        self.rows = self.actual(); self.provider_contacts = [{"id": PROVIDER, "email": EMAIL.upper(), "unsubscribed": True}]
        self.assertEqual(self.rows["contacts"][0]["email_sha256"], EMAIL_SHA)
        self.assertTrue(self.observe()["complete"])
        self.sql(f"UPDATE marketing_contact_sync_jobs SET locked_by='owned-live-worker',locked_until=now()+interval '1 hour' WHERE id='{JOB}'")
        self.rows = self.actual(); self.assertEqual(self.observe()["activeExecutions"], 1)
        self.assertNotIn(EMAIL, json.dumps(self.rows))

    def test_actual_job_completion_uses_original_snapshot_and_preserves_intent(self):
        self.sql("DELETE FROM marketing_contact_sync_jobs; DELETE FROM marketing_consent_events; DELETE FROM marketing_contacts;")
        self.sql(f"""INSERT INTO marketing_contacts(id,email,email_normalized,source,first_consented_at,last_consented_at,unsubscribed_at,updated_at)
          VALUES ('{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','{TIME}','{TIME}','{LATER}','{TIME}');
          INSERT INTO marketing_contact_sync_jobs(id,idempotency_key,contact_id,email,email_normalized,source,kind,payload,status,attempts,locked_by,locked_until,updated_at)
          VALUES ('{JOB}','owned-sync','{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','unsubscribe_sync','{{}}','processing',1,'owned-worker','{LATER}','{TIME}');""")
        before = self.actual()
        self.sql(f"UPDATE marketing_contact_sync_jobs SET status='succeeded',attempts=3,locked_by=NULL,locked_until=NULL,succeeded_at='{LATER}',updated_at='{LATER}' WHERE id='{JOB}'")
        self.rows = self.actual(); self.provider_contacts = [{"id": PROVIDER, "email": EMAIL, "unsubscribed": True}]
        result = self.observe(before)
        self.assertTrue(result["complete"])
        self.assertEqual(result["databaseTransition"]["changedJobs"], 1)

    def test_actual_unsubscribe_callback_is_source_bounded_and_history_is_retained(self):
        self.sql("DELETE FROM marketing_contact_sync_jobs; DELETE FROM marketing_consent_events; DELETE FROM marketing_contacts;")
        self.sql(f"""INSERT INTO marketing_contacts(id,email,email_normalized,source,first_consented_at,last_consented_at,updated_at)
          VALUES ('{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','{TIME}','{TIME}','{TIME}');
          INSERT INTO marketing_contact_sync_jobs(id,idempotency_key,contact_id,email,email_normalized,source,kind,payload,status,attempts,updated_at)
          VALUES ('{JOB}','owned-sync','{CONTACT}','{EMAIL}','{EMAIL}','contact_popup','opt_in_sync','{{}}','queued',0,'{TIME}');""")
        before = self.actual()
        self.sql(f"""BEGIN;
          UPDATE marketing_contacts SET unsubscribed_at='{LATER}',updated_at='{LATER}' WHERE id='{CONTACT}';
          INSERT INTO marketing_consent_events(id,contact_id,event_type,email,email_normalized,source,metadata,occurred_at)
          VALUES ('{CONSENT}','{CONTACT}','unsubscribe','{EMAIL}','{EMAIL}','resend','{{"resendContactId":"{PROVIDER}"}}','{LATER}');
          UPDATE marketing_contact_sync_jobs SET status='skipped_unconfigured',skipped_at='{LATER}',updated_at='{LATER}' WHERE id='{JOB}';
          COMMIT;""")
        self.rows = self.actual(); self.provider_contacts = [{"id": PROVIDER, "email": EMAIL, "unsubscribed": True}]
        self.assertTrue(self.observe(before)["complete"])
        self.assertEqual(len(self.actual()["consents"]), 1)
        self.sql(f"DELETE FROM marketing_consent_events WHERE id='{CONSENT}'")
        removed = self.actual()
        self.plan["databaseSnapshotSha256"] = component.snapshot_sha256(self.rows)
        with self.assertRaisesRegex(ValueError, "CONSENT_HISTORY_CHANGED"):
            component.observe_scoped_effects(self.client, self.plan, removed, self.source, self.rows)
