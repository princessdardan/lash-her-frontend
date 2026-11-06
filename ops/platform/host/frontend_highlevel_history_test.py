from copy import deepcopy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
import ssl
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import frontend_highlevel_history as history
import frontend_scoped_provider_client as transport
import frontend_crm_shipping_retirement_test as database_fixture
import frontend_release_adapters
import vercel_test


def utc(value):
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def empty_snapshot():
    return {name: ([{"contacts": 0, "effects": 0, "connections": 0, "webhooks": 0}] if name == "historyGlobalScope" else [])
        for name in history.COLUMNS}


def source_proof(absent=False):
    families = []
    for family in history.FAMILIES:
        record = {"familyId": family, "provider": "highlevel", "sourceDisposition": "absent-from-verified-source" if absent else "reachable"}
        for field, suffix in (("configurationConditions", "original-configuration"), ("sqlIntentRequirements", "durable-intents"),
                ("untrackedPotentialRequests", "accepted-request-completeness")):
            record[field] = [] if absent else [{"familyId": family, "requirementId": family + "." + suffix}]
        families.append(record)
    return {"version": 1, "status": "FRONTEND_HISTORICAL_SOURCE_VERIFIED", "sourceCommit": "b" * 40, "treeOid": "c" * 40,
        "sourceInventorySha256": "d" * 64, "requirementsSha256": "e" * 64, "providerFamilies": families,
        "surfaceSha256": "1" * 64, "configurationRecordSha256": "2" * 64, "provenanceSha256": "3" * 64,
        "sqlCredentialRequirements": [{"requirementId": "sql-credentials.DATABASE_URL"}], "capabilityClosures": []}


def complete_closures(source):
    global_ids = [row["requirementId"] for row in source["sqlCredentialRequirements"]]
    source["capabilityClosures"] = [{**{key: source[key] for key in ("sourceCommit", "surfaceSha256",
        "configurationRecordSha256", "provenanceSha256")}, "familyId": row["familyId"], "disposition": row["sourceDisposition"] if row["sourceDisposition"] ==
        "absent-from-verified-source" else "no-capability-observed", "evidenceIds": ["f" * 64],
        "requirementIds": sorted(global_ids + [item["requirementId"] for key in
            ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for item in row[key]])}
        for row in source["providerFamilies"]]


class HistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.calls, self.checkpoints = [], 0
        self.time = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.rows = empty_snapshot()
        self.source = source_proof()
        self.reviewed = {"environment": "staging", "locationId": "ownedLocation", "companyId": "ownedCompany", "sourceBindingSha256": "a" * 64,
            "historicalSourceCommit": "b" * 40, "expectedProviderContactIds": ["ownedContact"], "expectedWorkflowIds": ["ownedWorkflow"],
            "history": {"observedAt": utc(self.time), "windowStart": utc(self.time - timedelta(days=1)), "windowEnd": utc(self.time)}}
        self.logs, self.messages = [], []
        self.workflow_status, self.conversation_status = 200, 200
        self.count_delta, self.conversation_total_delta = 0, 0
        self.workflow_cursor, self.message_next = None, False
        self.end_workflow_cursor, self.end_message_cursor = False, False
        self.readback_drift, self.wrong_location, self.wrong_company = False, False, False
        self.provider_objects = {}
        self.contact = {"id": "ownedContact", "locationId": "ownedLocation", "email": "private-history-email@example.test"}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.calls.append((self.command, self.path))
                owner.assertEqual(self.headers.get("Authorization"), "Bearer owned-history-fixture-private-token")
                owner.assertEqual(self.headers.get("Version"), "v3")
                path, query = urlsplit(self.path).path, parse_qs(urlsplit(self.path).query)
                if path == "/locations/ownedLocation":
                    self.reply(200, {"location": {"id": "wrongLocation" if owner.wrong_location else "ownedLocation",
                        "companyId": "wrongCompany" if owner.wrong_company else "ownedCompany", "name": "private-history-name"}})
                elif path == "/contacts/ownedContact":
                    self.reply(200, {"contact": owner.contact})
                elif path == "/workflows/ownedWorkflow/logs":
                    reference = query.get("referenceId", [None])[0]
                    rows = owner.logs if reference is None else []
                    self.reply(owner.workflow_status, {"logs": rows, "count": len(rows) + owner.count_delta,
                        "nextCursor": None if reference is not None and owner.end_workflow_cursor else owner.workflow_cursor})
                elif path == "/conversations/search":
                    self.reply(owner.conversation_status, {"conversations": [{"id": "ownedConversation", "locationId": "ownedLocation",
                        "contactId": "ownedContact", "lastMessageBody": "private-history-body"}], "total": 1 + owner.conversation_total_delta})
                elif path == "/conversations/ownedConversation/messages":
                    rows = owner.messages if "lastMessageId" not in query else []
                    self.reply(200, {"messages": {"messages": rows, "nextPage": False if not rows and owner.end_message_cursor else owner.message_next,
                        "lastMessageId": rows[-1]["id"] if rows else "ownedMessage"}})
                elif path.startswith("/conversations/messages/"):
                    row = deepcopy(next(row for row in owner.messages if row["id"] == path.rsplit("/", 1)[1]))
                    if owner.readback_drift:
                        row["status"] = "scheduled"
                    self.reply(200, row)
                elif path in owner.provider_objects:
                    self.reply(200, owner.provider_objects[path])
                else:
                    self.reply(404, {"error": "private-history-provider-error"})

            def reply(self, status, value):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = server_tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.patches = [patch.dict(transport.ORIGINS, {"highlevel": f"https://127.0.0.1:{self.server.server_port}"})]
        for item in self.patches:
            item.start()
        context = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        with patch.object(transport.ssl, "create_default_context", return_value=context):
            self.client = transport.Client("highlevel", "owned-history-fixture-private-token", self.reviewed, history.read_only_request)
        self.locked = frontend_release_adapters.LockedClient(self.client, self.checkpoint)

    def checkpoint(self):
        self.checkpoints += 1

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def observe(self):
        self.reviewed["historyDatabaseSnapshotSha256"] = history.snapshot_sha256(history.normalize_snapshot(self.rows))
        return history.observe_scoped_effects(self.locked, self.reviewed, self.rows, self.source)

    def log(self, status="waiting", execution="ownedExecution", minute=5):
        return {"id": "log" + str(minute), "locationId": "ownedLocation", "workflowId": "ownedWorkflow", "contactId": "ownedContact",
            "workflowStatusId": execution, "stepId": "ownedStep", "type": "wait_time", "status": status,
            "createdAt": utc(self.time - timedelta(minutes=minute)), "meta": {"msg": "private-history-message"},
            "contactEmail": "private-history-email@example.test", "contactName": "private-history-name"}

    def message(self, status="delivered", identity="ownedMessage"):
        return {"id": identity, "locationId": "ownedLocation", "contactId": "ownedContact", "conversationId": "ownedConversation",
            "direction": "outbound", "status": status, "source": "workflow", "dateAdded": utc(self.time - timedelta(minutes=4)),
            "body": "private-history-body", "to": "+15550001111", "from": "private-history-sender"}

    def contact_row(self):
        row = {"id": "11111111-1111-4111-8111-111111111111", "location_id": "ownedLocation", "provider_id": "ownedContact",
            "email_sha256": hashlib.sha256(self.contact["email"].encode()).hexdigest(), "deleted_at": None,
            "created_at": utc(self.time - timedelta(days=2)), "updated_at": utc(self.time - timedelta(days=1))}
        self.rows["historyContacts"].append(row)
        self.rows["historyGlobalScope"][0]["contacts"] += 1
        return row

    def effect_row(self, kind="workflow", state="succeeded"):
        contact = self.rows["historyContacts"][0] if self.rows["historyContacts"] else self.contact_row()
        row = {"key": "journey:welcome:submission:ownedSubmission" if kind == "workflow" else "note:ownedSubmission",
            "contact_id": contact["id"], "kind": kind, "provider_id": "ownedWorkflow" if kind == "workflow" else "ownedNote", "state": state,
            "data": {"workflow": "ownedWorkflow" if kind == "workflow" else None, "journey": "welcome" if kind == "workflow" else None, "pipeline": None},
            "created_at": utc(self.time - timedelta(minutes=10)), "updated_at": utc(self.time - timedelta(minutes=8))}
        self.rows["historyEffects"].append(row)
        self.rows["historyGlobalScope"][0]["effects"] += 1
        return row

    def test_empty_retained_window_and_current_flags_never_prove_zero(self):
        self.reviewed.update(HIGHLEVEL_MARKETING_ENABLED=False, workflowExecutionInventoryComplete=True)
        result = self.observe()
        self.assertIsNone(result["activeExecutions"])
        self.assertIsNone(result["uncertainEffects"])
        self.assertFalse(result["workflowExecutionInventoryComplete"])
        self.assertFalse(result["inboundWebhooksQualified"])
        self.assertTrue(result["missingRequirementIds"])
        self.assertEqual(self.checkpoints, len(self.calls) * 2)

    def test_closure_context_cannot_be_transplanted_from_another_original_surface(self):
        complete_closures(self.source)
        original = deepcopy(self.source)
        for field, value in (("sourceCommit", "9" * 40), ("surfaceSha256", "9" * 64),
                ("configurationRecordSha256", "9" * 64), ("provenanceSha256", "9" * 64)):
            with self.subTest(field=field):
                self.source = deepcopy(original)
                self.source["capabilityClosures"][0][field] = value
                with self.assertRaisesRegex(ValueError, "CAPABILITY_REQUIREMENT_BINDING_REFUSED"):
                    self.observe()
        self.source = original

    def test_checked_complete_original_no_capability_closure_has_source_specific_zero(self):
        complete_closures(self.source)
        result = self.observe()
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertEqual(result["missingRequirementIds"], [])
        self.assertEqual(len(result["coveredRequirementIds"]), 25)
        self.assertTrue(result["workflowExecutionInventoryComplete"])
        self.assertTrue(result["inboundWebhooksQualified"])
        self.assertFalse(result["historicalWritersFenced"])
        self.assertFalse(result["trafficAuthorized"])
        self.assertEqual(self.calls, [])

    def test_verified_absence_needs_no_fabricated_principal_or_irrelevant_log_window(self):
        complete_closures(self.source)
        reviewed = {key: value for key, value in self.reviewed.items() if key not in
            ("locationId", "companyId", "expectedProviderContactIds", "expectedWorkflowIds", "history")}
        reviewed["historyDatabaseSnapshotSha256"] = history.snapshot_sha256(self.rows)
        queries = history.database_queries(reviewed)
        self.assertEqual(len(queries), 9)
        self.assertTrue(all(sql.endswith("LIMIT 4097") for _name, sql, _params in queries))
        result = history.observe_scoped_effects(None, reviewed, self.rows, self.source)
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        self.assertIsNone(result["locationId"])
        self.assertIsNone(result["companyId"])
        self.assertIsNone(result["window"])
        self.assertFalse(history.read_only_request("GET", "/locations/ownedLocation", None, reviewed))
        self.source["capabilityClosures"].pop()
        with self.assertRaisesRegex(ValueError, "PRINCIPAL_REQUIRED"):
            history.observe_scoped_effects(None, reviewed, self.rows, self.source)

    def test_source_absent_families_still_require_global_sql_credential_closure(self):
        self.source = source_proof(absent=True)
        complete_closures(self.source)
        self.assertEqual(self.observe()["uncertainEffects"], 0)
        self.source["capabilityClosures"][0]["requirementIds"] = []
        with self.assertRaisesRegex(ValueError, "CAPABILITY_REQUIREMENT_BINDING"):
            self.observe()

    def test_provider_log_retention_does_not_expire_an_original_absence_proof_without_api_reads(self):
        complete_closures(self.source)
        self.reviewed["history"] = {"observedAt": utc(self.time - timedelta(days=100)),
            "windowStart": utc(self.time - timedelta(days=110)), "windowEnd": utc(self.time - timedelta(days=100))}
        self.assertEqual(self.observe()["uncertainEffects"], 0)
        self.assertEqual(self.calls, [])

    def test_missing_family_closure_cannot_relabel_all_scopes_absent(self):
        complete_closures(self.source)
        self.source["capabilityClosures"].pop()
        self.assertIsNone(self.observe()["uncertainEffects"])

    def test_extra_missing_or_forged_closure_requirement_or_evidence_is_refused(self):
        for key, value in (("requirementIds", []), ("requirementIds", ["unknown.requirement"]), ("evidenceIds", []),
                ("evidenceIds", ["owner-approved"]), ("disposition", "complete")):
            with self.subTest(key=key, value=value):
                complete_closures(self.source)
                self.source["capabilityClosures"][0][key] = value
                with self.assertRaisesRegex(ValueError, "CAPABILITY_REQUIREMENT_BINDING"):
                    self.observe()

    def test_no_capability_closure_contradicted_by_actual_global_sql_does_not_close(self):
        complete_closures(self.source)
        self.rows["historyGlobalScope"][0]["connections"] = 1
        self.assertIsNone(self.observe()["activeExecutions"])

    def test_wrong_source_missing_family_and_duplicate_closure_refuse(self):
        for change in ("source", "family", "duplicate", "credential-requirements", "unknown-closure"):
            with self.subTest(change=change):
                self.source = source_proof()
                if change == "source":
                    self.source["sourceCommit"] = "f" * 40
                elif change == "family":
                    self.source["providerFamilies"].pop()
                elif change == "duplicate":
                    complete_closures(self.source)
                    self.source["capabilityClosures"].append(self.source["capabilityClosures"][0])
                elif change == "credential-requirements":
                    self.source.pop("sqlCredentialRequirements")
                else:
                    self.source["capabilityClosures"] = [{"familyId": "highlevel.unreviewed"}]
                with self.assertRaises(ValueError):
                    self.observe()

    def test_documented_exact_workflow_and_message_cursors_complete_real_https_pages(self):
        self.logs = [self.log("finished")]
        self.workflow_cursor = {"referenceId": "ownedCursor", "referenceCreatedAt": self.logs[0]["createdAt"]}
        self.end_workflow_cursor = True
        self.messages = [self.message(identity="ownedMessage" + str(index)) for index in range(100)]
        self.message_next, self.end_message_cursor = True, True
        result = self.observe()
        self.assertEqual(len(result["knownMessages"]), 100)
        self.assertEqual(len(result["knownExecutions"]), 1)
        self.assertEqual(self.checkpoints, len(self.calls) * 2)
        self.assertTrue(any("action=next" in path and "referenceId=ownedCursor" in path for _, path in self.calls))
        self.assertTrue(any("lastMessageId=ownedMessage99" in path for _, path in self.calls))
        self.assertTrue(all(history.read_only_request(method, path, None, self.reviewed) for method, path in self.calls))

    def test_pending_workflow_and_scheduled_message_counts_are_actual(self):
        self.logs = [self.log()]
        self.messages = [self.message("scheduled")]
        result = self.observe()
        self.assertEqual(result["knownActiveExecutions"], 2)
        self.assertTrue(result["knownExecutions"][0]["knownActive"])
        self.assertFalse(result["knownMessages"][0]["deliveryObserved"])
        self.assertIsNone(result["activeExecutions"])

    def test_draft_paused_and_retry_are_active_while_success_is_not_an_exit(self):
        for status in ("paused_due_to_draft_mode", "retry", "processing", "drip_queued"):
            with self.subTest(status=status):
                self.logs = [self.log(status)]
                self.assertEqual(self.observe()["knownActiveExecutions"], 1)
        self.logs = [self.log("success")]
        result = self.observe()
        self.assertFalse(result["knownExecutions"][0]["providerExecutionExitObserved"])
        self.assertGreater(result["knownUnknownEffects"], 0)

    def test_finished_provider_execution_does_not_invent_source_journey_or_downstream_join(self):
        self.effect_row()
        self.logs = [self.log("processing", minute=5), self.log("finished", minute=2)]
        self.messages = [self.message()]
        result = self.observe()
        self.assertTrue(result["knownExecutions"][0]["providerExecutionExitObserved"])
        self.assertTrue(result["knownMessages"][0]["deliveryObserved"])
        self.assertFalse(result["knownEffects"][0]["storedOutcomeConsistent"])
        self.assertEqual(result["knownEffects"][0]["candidateExecutionIds"], ["ownedExecution"])
        self.assertIn("workflow-intent-execution-and-downstream-join", [row["kind"] for row in result["requiredObservations"]])
        self.assertIsNone(result["uncertainEffects"])

    def test_cancelled_or_redacted_enrollment_is_not_provider_execution_exit(self):
        row = self.effect_row(state="cancelled")
        row["provider_id"], row["data"] = None, {"workflow": None, "journey": None, "pipeline": None}
        self.assertFalse(self.observe()["knownEffects"][0]["storedOutcomeConsistent"])

    def test_provider_permission_unavailable_and_rate_limit_are_unknown(self):
        for status in (401, 403, 404, 429, 500):
            with self.subTest(status=status):
                self.workflow_status, self.conversation_status = status, status
                result = self.observe()
                self.assertEqual(result["unavailableWorkflowIds"], ["ownedWorkflow"])
                self.assertEqual(result["unavailableContactIds"], ["ownedContact"])
                self.assertGreaterEqual(result["knownUnknownEffects"], 2)
                self.assertIsNone(result["activeExecutions"])

    def test_wrong_provider_location_or_company_refuses(self):
        for field in ("wrong_location", "wrong_company"):
            with self.subTest(field=field):
                setattr(self, field, True)
                with self.assertRaisesRegex(ValueError, "ACTUAL_LOCATION"):
                    self.observe()
                setattr(self, field, False)

    def test_workflow_wrong_tenant_duplicate_id_count_and_repeated_cursor_refuse(self):
        self.logs = [self.log()]
        self.logs[0]["locationId"] = "anotherLocation"
        with self.assertRaisesRegex(ValueError, "WORKFLOW_ROW"):
            self.observe()
        self.logs = [self.log(), self.log()]
        with self.assertRaisesRegex(ValueError, "WORKFLOW_ROW"):
            self.observe()
        self.logs, self.count_delta = [self.log()], 1
        with self.assertRaisesRegex(ValueError, "WORKFLOW_PAGE"):
            self.observe()
        self.count_delta = 0
        self.workflow_cursor = {"referenceId": "ownedCursor", "referenceCreatedAt": utc(self.time - timedelta(minutes=5))}
        with self.assertRaisesRegex(ValueError, "WORKFLOW_CURSOR"):
            self.observe()

    def test_unknown_workflow_status_is_counted_without_exposing_provider_text(self):
        self.logs = [self.log("private-history-new-status")]
        result = self.observe()
        self.assertGreater(result["knownUnknownEffects"], 0)
        self.assertNotIn("private-history-new-status", json.dumps(result))

    def test_conversation_truncation_is_unknown_and_message_cursor_cannot_loop(self):
        self.conversation_total_delta = 1
        self.assertEqual(self.observe()["unavailableContactIds"], ["ownedContact"])
        self.conversation_total_delta = 0
        self.messages, self.message_next = [self.message()], True
        with self.assertRaisesRegex(ValueError, "MESSAGE_CURSOR"):
            self.observe()

    def test_message_readback_change_and_wrong_tenant_are_refused(self):
        self.messages = [self.message()]
        self.readback_drift = True
        with self.assertRaisesRegex(ValueError, "MESSAGE_READBACK_CHANGED"):
            self.observe()
        self.readback_drift = False
        self.messages[0]["locationId"] = "anotherLocation"
        with self.assertRaisesRegex(ValueError, "MESSAGE_SCOPE"):
            self.observe()

    def test_actual_contact_note_task_and_terminal_opportunity_receipts(self):
        note = self.effect_row(kind="note")
        self.provider_objects["/contacts/ownedContact/notes/ownedNote"] = {"note": {"id": "ownedNote", "contactId": "ownedContact",
            "body": "[LH submission ownedSubmission]\nprivate-history-note-body"}}
        self.assertTrue(self.observe()["knownEffects"][0]["storedOutcomeConsistent"])
        task = deepcopy(note)
        task.update(key="task:" + note["contact_id"] + ":ownedOpportunity", kind="task", provider_id="ownedTask")
        self.rows["historyEffects"] = [task]
        self.provider_objects["/contacts/ownedContact/tasks/ownedTask"] = {"task": {"id": "ownedTask", "contactId": "ownedContact", "completed": True}}
        self.assertTrue(self.observe()["knownEffects"][0]["storedOutcomeConsistent"])
        opportunity = deepcopy(note)
        opportunity.update(key="opportunity:" + note["contact_id"] + ":ownedPipeline:ownedSubmission", kind="opportunity", provider_id="ownedOpportunity")
        opportunity["data"]["pipeline"] = "ownedPipeline"
        self.rows["historyEffects"] = [opportunity]
        self.provider_objects["/opportunities/ownedOpportunity"] = {"opportunity": {"id": "ownedOpportunity", "contactId": "ownedContact", "locationId": "ownedLocation",
            "pipelineId": "ownedPipeline", "status": "won"}}
        self.assertTrue(self.observe()["knownEffects"][0]["storedOutcomeConsistent"])
        self.provider_objects["/opportunities/ownedOpportunity"]["opportunity"]["status"] = "open"
        self.assertFalse(self.observe()["knownEffects"][0]["storedOutcomeConsistent"])

    def test_accepted_marketing_workflow_is_unknown_even_with_sent_timestamp(self):
        self.rows["historyDeliveries"] = [{"id": "ownedDelivery", "idempotency_sha256": "a" * 64, "kind": "contact_popup_offer", "status": "sent",
            "provider_message_id": "workflow:ownedWorkflow", "lease_held": False, "created_at": utc(self.time - timedelta(days=1)),
            "sent_at": utc(self.time - timedelta(minutes=10)), "redacted_at": None}]
        self.assertGreater(self.observe()["knownUnknownEffects"], 0)

    def test_output_contains_no_credentials_recipient_message_note_body_or_provider_errors(self):
        self.logs, self.messages = [self.log()], [self.message()]
        self.effect_row(kind="note")
        self.provider_objects["/contacts/ownedContact/notes/ownedNote"] = {"note": {"id": "ownedNote", "contactId": "ownedContact",
            "body": "[LH submission ownedSubmission]\nprivate-history-note-body"}}
        raw = json.dumps(self.observe())
        for marker in ("private-history-", "+15550001111", "owned-history-fixture-private-token", "[LH submission"):
            self.assertNotIn(marker, raw)

    def test_exact_database_digest_missing_query_extra_private_column_and_duplicate_row_refuse(self):
        self.reviewed["historyDatabaseSnapshotSha256"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "DATABASE_SNAPSHOT_CHANGED"):
            history.observe_scoped_effects(self.locked, self.reviewed, self.rows, self.source)
        for mutate in (lambda rows: rows.pop("historyOauthStates"), lambda rows: rows["historyGlobalScope"][0].update(credentials_ciphertext="private")):
            rows = deepcopy(self.rows)
            mutate(rows)
            with self.assertRaises(ValueError):
                history.normalize_snapshot(rows)
        self.contact_row()
        self.rows["historyContacts"].append(self.rows["historyContacts"][0])
        with self.assertRaisesRegex(ValueError, "ROW_ID"):
            history.normalize_snapshot(self.rows)

    def test_retention_window_limits_and_production_location_are_refused(self):
        for duration in (31, 61):
            self.reviewed["history"]["windowStart"] = utc(self.time - timedelta(days=duration))
            with self.assertRaisesRegex(ValueError, "RETAINED_WINDOW"):
                self.observe()
        self.reviewed["locationId"] = history.PRODUCTION_LOCATION
        with self.assertRaisesRegex(ValueError, "STAGING_SCOPE"):
            self.observe()

    def test_closed_allowlist_denies_mutations_unknown_filters_absolute_urls_and_duplicate_queries(self):
        for method, path, body in (("DELETE", "/contacts/ownedContact/workflow/ownedWorkflow", None),
                ("POST", "/contacts/search", {}), ("GET", "https://evil.test/contacts/ownedContact", None),
                ("GET", "/contacts/ownedContact?unreviewed=true", None), ("GET", "/contacts/notReviewed", None),
                ("GET", "/conversations/ownedConversation/messages?limit=100&limit=100", None),
                ("GET", "/workflows/notReviewed/logs", None)):
            with self.subTest(method=method, path=path):
                self.assertFalse(history.read_only_request(method, path, body, self.reviewed))
        self.observe()
        self.assertTrue(all(history.read_only_request(method, path, None, self.reviewed) for method, path in self.calls))


@unittest.skipUnless(os.environ.get("FRONTEND_HIGHLEVEL_HISTORY_POSTGRES_TEST") == "true", "explicit owned disposable PostgreSQL fixture only")
class DatabaseHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        database_fixture.DatabaseRetirementTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        # Existing fixture registered its owned cluster and certificate cleanup.
        pass

    sql = database_fixture.DatabaseRetirementTests.__dict__["sql"]
    cleanup_cluster = database_fixture.DatabaseRetirementTests.__dict__["cleanup_cluster"]
    setUp = HistoryTests.setUp
    tearDown = HistoryTests.tearDown
    checkpoint = HistoryTests.checkpoint
    observe = HistoryTests.observe

    def actual(self):
        selected = []
        for name, sql, params in history.database_queries(self.reviewed):
            for index, value in enumerate(params, 1):
                self.assertTrue(history._id(value))
                sql = sql.replace("$" + str(index), "'" + value + "'")
            selected.append(f"'{name}', (SELECT coalesce(json_agg(row_to_json(r)), '[]'::json) FROM ({sql}) r)")
        raw = self.sql("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object(" + ",".join(selected) + ");\nCOMMIT;")
        return json.loads(next(row for row in raw.splitlines() if row.startswith("{")))

    def test_database_literal_queries_execute_on_actual_migrated_schema_and_empty_scope_closes_only_with_proof(self):
        self.assertEqual(self.migration_count, 83)
        self.rows = self.actual()
        self.assertEqual(history.normalize_snapshot(self.rows), empty_snapshot())
        self.assertIsNone(self.observe()["activeExecutions"])
        complete_closures(self.source)
        self.assertEqual((self.observe()["activeExecutions"], self.observe()["uncertainEffects"]), (0, 0))

    def test_database_pending_accepted_enrollment_webhook_and_oauth_receipts_remain_observable(self):
        self.sql("""INSERT INTO highlevel_contacts(id,location_id,email_normalized,provider_id) VALUES
            ('11111111-1111-4111-8111-111111111111','ownedLocation','private-history-email@example.test','ownedContact');
            INSERT INTO highlevel_effects(key,contact_id,kind,provider_id,state,data) VALUES
            ('journey:welcome:submission:ownedSubmission','11111111-1111-4111-8111-111111111111','workflow','ownedWorkflow','succeeded','{"journey":"welcome","workflow":"ownedWorkflow"}');
            INSERT INTO highlevel_outbox(event_key,entity_type,entity_id,event_type,status,locked_by) VALUES
            ('owned-history-intent','submission','ownedSubmission','welcome_requested','processing','owned-worker');
            INSERT INTO highlevel_webhook_receipts(key,location_id,event_type,provider_contact_id) VALUES
            ('owned-history-webhook','ownedLocation','ContactDndUpdate','ownedContact');
            INSERT INTO highlevel_connections(location_id,credentials_ciphertext,expires_at,installed_by) VALUES
            ('ownedLocation','private-fixture-ciphertext',now()+interval '1 day','44444444-4444-4444-8444-444444444444');
            INSERT INTO highlevel_oauth_states(hash,actor_id,expires_at) VALUES
            (repeat('a',64),'44444444-4444-4444-8444-444444444444',now()+interval '10 minutes');""")
        self.rows = self.actual()
        result = self.observe()
        self.assertEqual(result["knownActiveExecutions"], 1)
        self.assertGreater(result["knownUnknownEffects"], 0)
        self.assertIsNone(result["uncertainEffects"])
        self.assertEqual(len(self.rows["historyWebhooks"]), 1)
        self.assertEqual(len(self.rows["historyOauthStates"]), 1)
        self.assertNotIn("private-fixture-ciphertext", json.dumps(self.rows))
        self.assertNotIn("private-history-email", json.dumps(self.rows))
        self.sql("DELETE FROM highlevel_effects; DELETE FROM highlevel_contacts; DELETE FROM highlevel_outbox; DELETE FROM highlevel_webhook_receipts; DELETE FROM highlevel_connections; DELETE FROM highlevel_oauth_states;")
