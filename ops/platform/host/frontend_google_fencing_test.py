from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import copy
import socket
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.parse

import frontend_google_fencing as google
import frontend_release_adapters_test as adapter_tests
import frontend_release_adapters as adapter
import migrate
import vercel_test


class GoogleFencingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.calls, self.old_denied, self.revoked, self.forbidden = [], False, False, False
        self.owner, self.event_etag, self.repeat_page, self.paginate = "123456789", '"owned-etag"', False, False
        self.state_keys = [google.STATE_PREFIX + "owned_state_" + "a" * 20]
        self.bad_cursor, self.ignore_delete, self.ignore_revoke = False, False, False
        self.lost_revoke = False
        self.orphan_event = False
        self.empty_calendar = True
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                owner.calls.append((self.command, self.path))
                status = 200
                if self.path == "/token":
                    form = urllib.parse.parse_qs(raw.decode())
                    owner.assertEqual(form["grant_type"], ["refresh_token"])
                    owner.assertIn(form["client_id"][0], google.CLIENTS.values())
                    secret, token = form["client_secret"][0], form["refresh_token"][0]
                    if secret.startswith("old-") and owner.old_denied:
                        status, value = (403 if owner.forbidden else 401), {"error": "invalid_client", "error_description": "private-provider-error-marker"}
                    elif owner.revoked and not token.endswith("fresh") and token != "preserved-grant":
                        status, value = 400, {"error": "invalid_grant", "error_description": "private-grant-marker"}
                    else:
                        value = {"access_token": "access:" + token, "token_type": "Bearer", "scope": "openid calendar.events", "private": "private-token-response-marker"}
                elif self.path == "/v1/userinfo":
                    token = self.headers["Authorization"].removeprefix("Bearer access:")
                    value = {"sub": "987654321" if token == "preserved-grant" else owner.owner, "email": "private-address@example.invalid", "name": "private-profile-marker"}
                elif self.path == "/revoke":
                    form = urllib.parse.parse_qs(raw.decode())
                    owner.assertEqual(form["token"], ["legacy-grant"])
                    owner.revoked = not owner.ignore_revoke
                    if owner.lost_revoke:
                        self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                    value = {}
                elif self.path.startswith("/calendar/v3/calendars/owned-calendar/events?"):
                    row = {"id": "event_1", "etag": owner.event_etag, "status": "confirmed", "summary": "private-title-marker",
                        "description": "private-content-marker", "attendees": [{"email": "private-person@example.invalid"}]}
                    value = {"items": [row]}
                    if owner.empty_calendar:
                        value["items"] = []
                    if owner.orphan_event:
                        value["items"].append({**row, "id": "orphan_event", "extendedProperties": {"private": {"lashHerBookingHoldId": "orphan-hold"}}})
                    if owner.paginate:
                        if "pageToken=" not in self.path:
                            value["nextPageToken"] = "owned-next"
                        elif not owner.repeat_page:
                            value["items"] = [{**row, "id": "event_2"}]
                elif self.path == "/":
                    command = json.loads(raw)
                    if command[0] == "GET":
                        value = {"result": "legacy-grant" if command[1] == google.LEGACY_KEYS[0] else None}
                    elif command[0] == "SCAN":
                        value = {"result": ["1" if owner.bad_cursor else "0", owner.state_keys]}
                    elif command[0] == "DEL":
                        if not owner.ignore_delete:
                            owner.state_keys.remove(command[1])
                        value = {"result": 1}
                    else:
                        status, value = 500, {}
                else:
                    status, value = 500, {"private": "unexpected-private-response"}
                self.send_response(status); self.end_headers(); self.wfile.write(json.dumps(value).encode())
            do_GET = handle_request
            do_POST = handle_request
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        origin = f"https://127.0.0.1:{self.server.server_port}"
        self.patches = [patch.object(google, key, origin) for key in ("OAUTH", "USERINFO", "CALENDAR", "REDIS")]
        self.patches.append(patch.object(google.ssl, "create_default_context", return_value=ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))))
        for item in self.patches: item.start()
        self.verified = 0
        def verify(): self.verified += 1
        self.replacement = {kind: google.Client(kind, "replacement-" + kind, verify) for kind in google.CLIENTS}
        self.retired = {kind: google.Client(kind, "old-" + kind, verify) for kind in google.CLIENTS}
        self.redis = google.LegacyRedis("owned-redis-private-token", verify)
        self.private = {"verificationGrants": {"identity": "identity-verification", "calendar": "calendar-verification"}}
        calendar_sha = google.sha("owned-calendar")
        self.actual = {"snapshot": {"connections": [], "assignments": [], "events": []}, "grants": [], "calendars": {calendar_sha: "owned-calendar"}, "events": []}
        self.reviewed = {"projectId": "lash-her-staging-20261022", "projectNumber": "185770842371", "sourceBindingSha256": "a" * 64,
            "databaseSnapshotSha256": google.canonical(self.actual["snapshot"]), "clients": [
                {"kind": kind, "clientId": client, "verificationOwnerSha256": google.sha("123456789")} for kind, client in google.CLIENTS.items()],
            "grants": [{"grantId": google.LEGACY_KEYS[0], "ownerSha256": google.sha("123456789"), "disposition": "retire"}],
            "legacyCalendarSha256": calendar_sha, "calendars": [{"calendarSha256": calendar_sha, "grantId": "verification:calendar"}]}
        self.reviewed["databaseBeforeSnapshot"] = copy.deepcopy(self.actual["snapshot"])
        self.reviewed["redisBeforeSnapshot"] = {"grants": [
            {"grantId": google.LEGACY_KEYS[0], "present": True}, {"grantId": google.LEGACY_KEYS[1], "present": False}],
            "stateKeySha256": [google.sha(self.state_keys[0])]}
        self.reviewed["redisSnapshotSha256"] = google.canonical(self.reviewed["redisBeforeSnapshot"])
        self.directory = tempfile.TemporaryDirectory(); self.attempt = Path(self.directory.name); self.attempt.chmod(0o700)

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2); self.directory.cleanup()

    def retire(self):
        def console_action(_seconds): self.old_denied = True
        with patch.object(google.time, "sleep", side_effect=console_action):
            return google.retire_grants(self.replacement, self.retired, self.redis, self.reviewed, self.private, self.actual, {"actionId": "owned-google"}, self.attempt)

    def test_actual_console_secret_denial_grant_revoke_and_legacy_continuation_close_keep_private_data_out(self):
        result = self.retire()
        self.assertEqual(result["status"], "GOOGLE_SELECTED_GRANTS_RETIRED_CONTINUATIONS_CLOSED")
        self.assertEqual(result["pendingOAuthContinuations"], 0)
        self.assertIsNone(result["activeExecutions"])
        self.assertGreater(self.verified, 20)
        self.assertTrue(all(row["retiredSecretDenied"] for row in result["clients"]))
        self.assertEqual(sum(path == "/revoke" for _method, path in self.calls), 1)
        self.assertNotIn("private-", json.dumps(result))
        self.assertNotIn("private-", "".join(path.read_text() for path in self.attempt.glob("*.json")))
        self.assertEqual(self.state_keys, [])
        self.private["verificationGrants"] = {kind: kind + "-fresh" for kind in google.CLIENTS}
        observed = google.observe(self.replacement, self.retired, self.redis, self.reviewed, self.private, self.actual)
        self.assertEqual(observed["uncertainEffects"], 0)
        self.assertTrue(observed["grants"][0]["stateVerified"])

    def test_actual_protected_frontend_runtime_equality_is_required_before_google_mutation(self):
        fixture = adapter_tests.ConcreteFrontendAdapterTests(methodName="runTest")
        fixture.setUp()
        try:
            fixture.bootstrap_context()
            fixture.context["bindings"]["googleRetirement"] = self.reviewed
            fixture.context.update(googleIdentityReplacementSecret="replacement-identity", googleCalendarReplacementSecret="replacement-calendar", googleLegacyCalendarId="owned-calendar")
            fixture.execute("deploy-admission")
            runtime = adapter.verify_google_runtime(fixture.context, fixture.client, fixture.parent / "vercel", fixture.mapped_probe())
            self.assertTrue(runtime["runtimeReplacementBindingVerified"])
            self.assertFalse(runtime["customerIdentityBindingVerified"])
            self.assertNotIn("proof", json.dumps(runtime))
            self.assertNotIn("replacement-", json.dumps(runtime))
            fixture.variables["AUTH_GOOGLE_SECRET"]["value"] = "wrong-runtime-secret"
            with self.assertRaisesRegex(ValueError, "PRIVATE_EQUALITY_UNVERIFIED"):
                adapter.verify_google_runtime(fixture.context, fixture.client, fixture.parent / "vercel", fixture.mapped_probe())
            self.assertFalse(any(path == "/revoke" for _method, path in self.calls))
        finally:
            fixture.tearDown()

    def test_preserved_owner_refuses_project_wide_revocation_before_any_mutation(self):
        self.actual["grants"] = [{"grantId": "connection:owned", "refreshToken": "another-same-owner-grant"}]
        self.reviewed["grants"].append({"grantId": "connection:owned", "ownerSha256": google.sha("123456789"), "disposition": "preserve"})
        with self.assertRaisesRegex(ValueError, "WOULD_AFFECT_PRESERVED_GRANT"):
            self.retire()
        self.assertFalse(any(path == "/revoke" for _method, path in self.calls))
        self.assertTrue(self.state_keys)

    def test_independent_preserved_owner_keeps_its_actual_grant_usable(self):
        self.actual["grants"] = [{"grantId": "connection:owned", "refreshToken": "preserved-grant"}]
        self.reviewed["grants"].append({"grantId": "connection:owned", "ownerSha256": google.sha("987654321"), "disposition": "preserve"})
        result = self.retire()
        self.assertEqual(result["preservedGrantIds"], ["connection:owned"])
        self.assertEqual(google.access(self.replacement["calendar"], "preserved-grant", google.sha("987654321")), "access:preserved-grant")
        self.assertEqual(sum(path == "/revoke" for _method, path in self.calls), 1)

    def test_original_oauth_state_may_expire_or_finish_during_approved_drain_without_replacing_prestate(self):
        original = copy.deepcopy(self.reviewed["redisBeforeSnapshot"])
        self.state_keys = []
        result = self.retire()
        self.assertEqual(result["pendingOAuthContinuations"], 0)
        self.assertEqual(self.reviewed["redisBeforeSnapshot"], original)

    def test_actual_grant_owner_mismatch_and_database_snapshot_change_refuse_before_revoke(self):
        self.owner = "111111111"
        with self.assertRaisesRegex(ValueError, "OWNER_UNVERIFIED"):
            self.retire()
        self.assertFalse(any(path == "/revoke" for _method, path in self.calls))
        self.reviewed["databaseSnapshotSha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "DATABASE_BINDING_CHANGED"):
            self.retire()

    def test_approved_pending_event_drain_keeps_original_snapshot_and_requires_positive_provider_outcome(self):
        self.empty_calendar = False
        calendar_sha = google.sha("owned-calendar")
        before = {"recordKind": "appointment-hold", "recordId": "owned-hold", "calendarSha256": calendar_sha,
            "eventId": None, "etag": None, "status": "paid_calendar_pending"}
        self.reviewed["databaseBeforeSnapshot"]["events"] = [before]
        original = copy.deepcopy(self.reviewed["databaseBeforeSnapshot"])
        self.reviewed["databaseSnapshotSha256"] = google.canonical(original)
        after = {**before, "eventId": "event_1", "status": "booked"}
        self.actual["snapshot"]["events"] = [after]
        self.actual["events"] = [after]
        self.actual["calendars"] = {calendar_sha: "owned-calendar"}
        self.reviewed["calendars"] = [{"calendarSha256": calendar_sha, "grantId": "verification:calendar"}]
        transition = google.database_transition(self.reviewed, self.actual)
        self.assertEqual(len(transition["declaredTransitions"]), 1)
        self.assertEqual(self.reviewed["databaseBeforeSnapshot"], original)
        # Provider event lacks the exact hold binding, so this approved state
        # transition cannot become a successful reconciliation from SQL alone.
        self.assertEqual(google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)[0]["unresolvedEffects"], 1)
        unknown = {**after, "recordId": "undeclared-hold"}
        self.actual["snapshot"]["events"].append(unknown)
        self.actual["events"].append(unknown)
        with self.assertRaisesRegex(ValueError, "NEW_UNDECLARED_EFFECT_REFUSED"):
            google.database_transition(self.reviewed, self.actual)

    def test_401_invalid_client_is_required_and_403_is_not_retirement(self):
        self.old_denied, self.forbidden = True, True
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED_REQUIRES_REVIEW"):
            google.secret_denied(self.retired["identity"], "identity-verification")
        self.forbidden = False
        self.assertTrue(google.secret_denied(self.retired["identity"], "identity-verification"))

    def test_revoke_ack_without_actual_refresh_denial_retains_exact_uncertain_grant(self):
        self.ignore_revoke = True
        with self.assertRaisesRegex(ValueError, "GRANT_DENIAL_UNVERIFIED"):
            self.retire()
        result = migrate.read_json(self.attempt, "google-retirement-outcome.json")
        self.assertEqual(result["uncertainGrantId"], google.LEGACY_KEYS[0])
        self.assertTrue(self.state_keys)

    def test_lost_revoke_acknowledgement_preserves_uncertainty_and_does_not_delete_states_or_retry(self):
        self.lost_revoke = True
        with self.assertRaisesRegex(ValueError, "REQUEST_FAILED_REQUIRES_REVIEW"):
            self.retire()
        outcome = migrate.read_json(self.attempt, "google-retirement-outcome.json")
        self.assertEqual(outcome["uncertainGrantId"], google.LEGACY_KEYS[0])
        self.assertEqual(sum(path == "/revoke" for _method, path in self.calls), 1)
        self.assertTrue(self.state_keys)

    def test_redis_command_scope_repeated_cursor_and_ignored_delete_cannot_close_continuations(self):
        for command in (["GET", "unrelated-key"], ["FLUSHDB"], ["DEL", google.LEGACY_KEYS[0]], ["SCAN", "0", "MATCH", "*", "COUNT", "100"]):
            with self.assertRaisesRegex(ValueError, "COMMAND_SCOPE_REFUSED"):
                self.redis.command(command)
        self.bad_cursor = True
        with self.assertRaisesRegex(ValueError, "CURSOR_REPEATED"):
            self.redis.snapshot()
        self.bad_cursor, self.ignore_delete = False, True
        with self.assertRaisesRegex(ValueError, "CONTINUATION_OR_LEGACY_GRANT_DRIFT"):
            self.retire()

    def test_calendar_full_pagination_binds_stored_ids_etags_and_detects_orphans(self):
        self.empty_calendar = False
        calendar_sha = google.sha("owned-calendar")
        self.reviewed["calendars"] = [{"calendarSha256": calendar_sha, "grantId": "verification:calendar"}]
        self.actual["calendars"] = {calendar_sha: "owned-calendar"}
        self.actual["events"] = [{"recordKind": "appointment-calendar-event", "calendarSha256": calendar_sha,
            "eventId": "event_1", "etag": '"owned-etag"', "status": "synced"}]
        rows = google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)
        self.assertEqual(rows[0]["unresolvedEffects"], 0)
        self.orphan_event = True
        self.assertEqual(google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)[0]["unresolvedEffects"], 1)
        self.orphan_event = False
        self.event_etag = '"changed"'
        self.assertEqual(google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)[0]["unresolvedEffects"], 1)
        self.event_etag, self.paginate = '"owned-etag"', True
        self.actual["events"].append({**self.actual["events"][0], "eventId": "event_2"})
        self.assertEqual(google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)[0]["unresolvedEffects"], 0)
        self.repeat_page = True
        with self.assertRaisesRegex(ValueError, "EVENT_ID_REFUSED"):
            google.reconcile_events(self.replacement["calendar"], self.private, self.reviewed, self.actual)


if __name__ == "__main__": unittest.main()
