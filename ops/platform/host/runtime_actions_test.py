import base64
import hashlib
import hmac
import json
import subprocess
import unittest
from unittest.mock import patch
from uuid import uuid4

import migrate
import runtime_actions as actions
import staging_state_test


class RuntimeActionsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests(); self.fixture.setUp()
        self.runtime = self.fixture.runtime
        self.selected, self.jobs, self.plan, _ = self.fixture.bind()
        self.programs_dir = self.runtime.root / "operator-programs"; self.programs_dir.mkdir(mode=0o700)
        self.output = self.runtime.root / "operator-results"; self.output.mkdir(mode=0o700)
        self.programs = {}
        for name in ("fixture", "work"):
            file = self.programs_dir / ("staging-" + name + "-operator.mjs")
            file.write_text("owned-program-" + name); file.chmod(0o600)
            self.programs[name] = {"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
        self.secret = "owned-private-signing-secret-" + uuid4().hex
        file = self.runtime.configuration / "course-api.env"
        file.write_text(file.read_text() + "FIRST_PARTY_AUTH_SECRET=" + self.secret + "\nFIRST_PARTY_AUTH_ISSUER=owned-issuer\nFIRST_PARTY_AUTH_AUDIENCE=owned-audience\n")
        self.calls, self.tokens = [], []
        self.rows, self.retained = None, None
        self.fail_fixture = False

    def tearDown(self):
        self.fixture.tearDown()

    def operator(self):
        return actions.RuntimeOperator(self.selected, self.jobs, self.runtime.configuration, self.plan["originalContainers"],
            self.programs_dir, self.programs, self.output)

    def command(self, args, env, timeout=30):
        self.assertEqual(env, actions.runtime.SAFE_ENV)
        if args[1] == "stop":
            return args[-1]
        container = next(c for c in self.plan["originalContainers"] if c["containerId"] == args[-1])
        if args[3].startswith("{{.Config.Image}}"):
            return container["image"] + "|true|healthy|" + container["service"]
        return "|".join((container["containerId"], container["image"], "false", "0", "false", "lash-her-staging", container["service"]))

    def child(self, args, **kwargs):
        payload = json.loads(kwargs["input"]); self.calls.append((args, payload))
        self.assertEqual(kwargs["env"], actions.runtime.SAFE_ENV)
        self.assertNotIn("--env-file", args)
        if "applicationToken" in payload:
            token = payload["applicationToken"]; self.tokens.append(token)
            header, body, signature = token.split(".")
            self.assertEqual(signature, base64.urlsafe_b64encode(hmac.new(self.secret.encode(), (header + "." + body).encode(), hashlib.sha256).digest()).rstrip(b"=").decode())
            claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            self.assertEqual(claims["sub"], payload["actorUserId"])
            if payload["version"] == 2:
                self.assertEqual(set(claims), {"version", "iss", "aud", "sub", "iat", "exp", "jti", "capabilities"})
                self.assertEqual(claims["version"], 1)
                self.assertEqual(claims["iss"], "lash-her-frontend"); self.assertEqual(claims["aud"], "lash-her-course-api:admin")
                self.assertEqual(claims["capabilities"], ["course-editor", "course-support"])
            else:
                self.assertEqual(claims["role"], "courseAdmin")
                self.assertEqual(claims["iss"], "owned-issuer"); self.assertEqual(claims["aud"], "owned-audience")
            self.assertEqual(claims["exp"] - claims["iat"], 300)
            course = str(uuid4())
            base = {"actionId": payload["actionId"], "environment": "staging", "courseId": course, "courseSlug": "p1-recovery-" + payload["nonce"]}
            grants = [{"userId": user, "grantId": str(uuid4()), "commandId": str(uuid4())} for user in payload["userIds"]]
            rows = [{**base, "status": "STAGING_FIXTURE_DRAFT_CREATED"}, *[{**base, **grant, "status": "STAGING_FIXTURE_GRANT_CREATED"} for grant in grants],
                {**base, "status": "STAGING_FIXTURE_TWO_GRANTS_CREATED", "grants": grants, "coursePublished": False, "syntheticIdentitiesOnly": True}]
            if self.fail_fixture:
                return subprocess.CompletedProcess(args, 1, (json.dumps(rows[0]) + "\n").encode(), b"private-error-fixture")
            self.rows = rows
            return subprocess.CompletedProcess(args, 0, ("\n".join(json.dumps(row) for row in rows) + "\n").encode(), b"")
        self.assertEqual(payload["mode"], "retain")
        self.assertEqual(payload["target"]["user"], self.jobs["course"]["job"]["runtimeRole"])
        fixture = payload["fixture"]
        self.retained = {"status": "STAGING_DURABLE_WORK_RETAINED", "environment": "staging", "actionId": fixture["actionId"], "courseId": fixture["courseId"], "recovered": False,
            "events": [{"eventId": str(uuid4()), "canonicalDigest": str(index + 1) * 64, "notBefore": "2026-11-03T00:00:00Z", "attemptsInCycle": index} for index in (0, 1)]}
        return subprocess.CompletedProcess(args, 0, json.dumps(self.retained).encode(), b"")

    def test_reviewed_program_hash_is_required_before_subprocess_or_private_configuration_reads(self):
        file = self.programs_dir / self.programs["fixture"]["file"]; file.write_text("changed")
        with patch.object(actions.subprocess, "run", side_effect=AssertionError("subprocess called")), self.assertRaisesRegex(ValueError, "PROGRAM_HASH"):
            self.operator()

    def test_private_bounded_token_reaches_only_gateway_stdin_and_is_not_recorded(self):
        operator = self.operator()
        with patch.object(actions.runtime, "command", side_effect=self.command), patch.object(actions.subprocess, "run", side_effect=self.child):
            result = operator.prepare_retained("recovery-fixture-owned")
        self.assertEqual(result["status"], "STAGING_DURABLE_WORK_RETAINED")
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn(self.tokens[0], " ".join(self.calls[0][0]))
        for file in self.output.iterdir():
            raw = file.read_text()
            self.assertNotIn(self.secret, raw)
            self.assertNotIn(self.tokens[0], raw)
        with self.assertRaises(FileExistsError):
            operator.prepare_retained("recovery-fixture-owned")

    def test_failed_api_call_preserves_safe_partial_progress_and_never_starts_retention(self):
        self.fail_fixture = True; operator = self.operator()
        with patch.object(actions.runtime, "command", side_effect=self.command), patch.object(actions.subprocess, "run", side_effect=self.child):
            with self.assertRaisesRegex(ValueError, "CHILD_REQUIRES_REVIEW"):
                operator.prepare_retained("recovery-fixture-owned")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(migrate.read_json(self.output, "fixture-observed-progress.json")), 1)
        self.assertEqual((self.output / "private-child-1-stderr.bin").stat().st_mode & 0o777, 0o600)
        outcome = migrate.read_json(self.output, "retained-work-outcome.json")
        self.assertEqual(outcome["status"], "STAGING_RETAINED_WORK_REQUIRES_REVIEW")
        self.assertNotIn("private-error-fixture", json.dumps(outcome))

    def test_phase2_uses_only_the_current_admin_key_and_closed_capability_profile(self):
        self.selected["contractPhase"] = "p2"
        file = self.runtime.configuration / "course-api.env"
        file.write_text(file.read_text() + "COURSE_ADMIN_JWT_CURRENT_SECRET=" + self.secret + "\n")
        operator = self.operator()
        with patch.object(actions.runtime, "command", side_effect=self.command), patch.object(actions.subprocess, "run", side_effect=self.child):
            self.assertEqual(operator.prepare_retained("recovery-fixture-owned")["status"], "STAGING_DURABLE_WORK_RETAINED")
        self.assertEqual(self.calls[0][1]["version"], 2)
        for file in self.output.iterdir():
            self.assertNotIn(self.tokens[0], file.read_text())

    def test_phase2_never_falls_back_to_the_retired_first_party_key(self):
        self.selected["contractPhase"] = "p2"
        operator = self.operator()
        with patch.object(actions.runtime, "command", side_effect=self.command), patch.object(actions.subprocess, "run", side_effect=AssertionError("child ran")):
            with self.assertRaisesRegex(ValueError, "APPLICATION_SECRET_REQUIRED"):
                operator.prepare_retained("recovery-fixture-owned")

    def test_changed_live_container_prevents_child_execution(self):
        operator = self.operator()
        with patch.object(actions.runtime, "command", return_value="different-container"), patch.object(actions.subprocess, "run", side_effect=AssertionError("child ran")):
            with self.assertRaisesRegex(ValueError, "LIVE_CONTAINER_CHANGED"):
                operator.api("course", "preflight")

    def test_business_baseline_allows_new_rows_but_requires_every_original_value(self):
        before = {"status": "STAGING_BUSINESS_FINGERPRINT_READ_ONLY", "service": "course", "algorithm": "HMAC-SHA256/private-action-key",
            "tables": {"users": {"count": 1, "rows": [{"key": "a" * 64, "value": "b" * 64}]}}}
        after = json.loads(json.dumps(before)); after["tables"]["users"]["rows"].append({"key": "c" * 64, "value": "d" * 64}); after["tables"]["users"]["count"] = 2
        self.assertEqual(actions.business_preserved(before, after)["preservedRows"], 1)
        after["tables"]["users"]["rows"][0]["value"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "BUSINESS_ROWS_CHANGED"):
            actions.business_preserved(before, after)

    def test_receiver_checkpoint_capability_cannot_stop_processes_create_grants_or_claim_work(self):
        apis = [c for c in self.plan["originalContainers"] if c["service"] in ("course-api", "community-api")]
        operator = actions.RuntimeOperator(self.selected, self.jobs, self.runtime.configuration, apis,
            self.programs_dir, self.programs, self.output, api_only=True)
        with patch.object(actions.subprocess, "run", side_effect=AssertionError("child ran")):
            for call in (lambda: operator.stop(["course-api"]), lambda: operator.prepare_retained("recovery-fixture-owned"),
                         lambda: operator.api("course", "retain", fixture={})):
                with self.assertRaisesRegex(ValueError, "READ_ONLY_CAPABILITY"):
                    call()

    def test_recovery_requires_actual_tls_read_only_receivers_and_retained_retry_count(self):
        events = [{"eventId": str(uuid4()), "canonicalDigest": str(index + 1) * 64, "notBefore": "2026-11-03T00:00:00Z", "attemptsInCycle": index} for index in (0, 1)]
        retained = {"status": "STAGING_DURABLE_WORK_RETAINED", "environment": "staging", "events": events}
        source = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "course", "mode": "outbox", "authenticatedTls": True, "readOnly": True,
            "rows": [{"eventId": e["eventId"], "canonicalDigest": e["canonicalDigest"], "state": "delivered", "leaseOwner": None,
                      "leaseExpiresAt": None, "deliveredAt": "2026-11-03T00:00:01Z", "attemptsInCycle": e["attemptsInCycle"]} for e in events]}
        receiver = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "community", "mode": "inbox", "authenticatedTls": True, "readOnly": True,
            "rows": [{"eventId": e["eventId"], "canonicalDigest": e["canonicalDigest"], "status": "applied"} for e in events]}
        self.assertEqual(actions.recovered(retained, source, receiver)["eventsRecovered"], 2)
        source["rows"][1]["attemptsInCycle"] = 0
        with self.assertRaisesRegex(ValueError, "ACTUAL_PENDING_EVENT_PUBLICATION"):
            actions.recovered(retained, source, receiver)
        source["rows"][1]["attemptsInCycle"] = 1; receiver["authenticatedTls"] = False
        with self.assertRaisesRegex(ValueError, "RECOVERY_SCOPE"):
            actions.recovered(retained, source, receiver)


if __name__ == "__main__":
    unittest.main()
