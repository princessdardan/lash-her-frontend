import copy
import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import p2_scoped_export_cleanup as cleanup
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE


PROFILE = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
COMMAND = "00000000-0000-4000-8000-000000000001"
OPERATION = "00000000-0000-4000-8000-000000000002"
REAL_DIRECT_CLIENT = cleanup.DirectCleanupClient


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self.body = json.dumps(body).encode()
        self.headers = Message()
        self.headers["content-type"] = "application/json"
        self.headers["cache-control"] = "private, no-store"
        if body.get("requestId"):
            self.headers["x-request-id"] = body["requestId"]

    def read(self, _bound):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeDirectClient:
    def __init__(self):
        self.calls = []
        self.responses = [
            {"status": 401, "requestId": None, "body": {"error": "unauthorized"}},
            {"status": 503, "requestId": None, "body": {"error": "temporarily_unavailable"}},
            {"status": 200, "requestId": OPERATION, "body": {"operation": "expire-export", "commandId": COMMAND,
                "outcome": "scrubbed", "status": "expired", "dataCleared": True, "frontendCleared": True,
                "requestId": OPERATION}},
        ]

    def request(self, deployment_url, command_id, secret, bypass):
        self.calls.append((deployment_url, command_id, secret, bypass))
        value = copy.deepcopy(self.responses.pop(0))
        value.update(startedAt="2026-11-07T00:00:00.000Z", completedAt="2026-11-07T00:00:01.000Z")
        return value


class ScopedCleanupTests(unittest.TestCase):
    def setUp(self):
        from p2_certification_parent import P2CertificationPhysicalObserver, P2CertificationScope, P2ProfiledCertificationBroker
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.native_plan = {"version": 2, "qualificationTargetProfile": PROFILE, "actionId": "owned-release",
            "projectId": "prj_owned", "deploymentId": "dpl_owned", "deploymentUrl": "https://owned.vercel.app",
            "sourceCommit": "a" * 40, "schedule": {"path": cleanup.PATH, "schedule": "* * * * *"},
            "producer": {"producerSha256": "b" * 64, "role": {"oid": "1001"}}}
        self.plan = {"version": 2, "qualificationTargetProfile": PROFILE, "mode": "export-cleanup", "initialEpoch": "10",
            "certificationActionId": "cleanup-owned", "candidateSha256": "c" * 64, "planSha256": "d" * 64,
            "nativePlan": self.native_plan,
            "scopedAction": {"commandId": COMMAND, "readyRecordSha256": "e" * 64}}
        self.reviewed = {"version": 2, "qualificationTargetProfile": PROFILE, "plan": {"version": 2,
            "qualificationTargetProfile": PROFILE}, "privateDirectory": str(self.directory / "retained")}
        self.plan["persistenceReviewedSha256"] = cleanup._digest(self.reviewed)
        self.record = {"version": 2, "qualificationTargetProfile": PROFILE, "stage": "capture-export-ready",
            "witness": {"profile": "export-ready-v1", "readOnly": True,
                "command": {"commandId": COMMAND, "action": "export"}},
            "privateEvidence": {"version": 1, "stage": "capture-export-ready", "export": {
                "frontend": {"readyAt": "2026-11-05T00:00:00.000Z", "expiresAt": "2026-11-06T00:00:00.000Z"},
                "course": {"readyAt": "2026-11-05T00:01:00.000Z", "expiresAt": "2026-11-06T00:01:00.000Z"},
                "community": {"readyAt": "2026-11-05T00:02:00.000Z", "expiresAt": "2026-11-06T00:02:00.000Z"}}},
            "receipt": {"status": "P2_LIFECYCLE_EXPORT_READY_CAPTURED", "readOnly": True,
                "providerTouched": False, "releaseAccepted": False}}
        self.retained_digest = "e" * 64
        scope = P2CertificationScope.__new__(P2CertificationScope)
        scope._expected_profile = PROFILE
        observer = P2CertificationPhysicalObserver.__new__(P2CertificationPhysicalObserver)
        broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
        broker.scope, broker.observer, broker.selected = scope, observer, {"releaseId": "owned-release"}
        broker.initial = {"certificationPlan": self.plan, "persistenceReviewed": self.reviewed,
                          "scopedCronSecret": "owned-runtime-bearer"}
        broker.directory, broker.vercel = self.directory, object()
        self.broker = broker
        self.admissions = [self.admission("10", False), self.admission("10", False), self.admission("10", False),
            self.admission("11", True), self.admission("11", True), self.admission("12", False)]
        self.direct = FakeDirectClient()
        self.operation_mutation = None
        self.patches = [
            mock.patch.object(cleanup.persistence, "_reviewed", side_effect=lambda value, _expected: value),
            mock.patch.object(cleanup.persistence, "load_retained_capture", side_effect=self.load_retained),
            mock.patch("p2_certification_parent.P2ProfiledCertificationBroker.check", autospec=True),
            mock.patch("p2_certification_parent.P2ProfiledCertificationBroker._native_context", autospec=True,
                return_value={"candidate": broker.selected, "plan": self.native_plan}),
            mock.patch("p2_certification_parent.P2ProfiledCertificationBroker._gateway_current", autospec=True,
                return_value={"admission": {"valid": True, "newWork": False, "recovery": False,
                    "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0}}}),
            mock.patch("p2_certification_parent.P2CertificationPhysicalObserver.probe", autospec=True,
                side_effect=self.probe),
            mock.patch.object(cleanup.native, "observe", side_effect=AssertionError("expired private probe used")),
            mock.patch("p2_day_two_workload.observe", side_effect=self.day_two),
            mock.patch.object(cleanup.native, "observe_metadata", side_effect=self.native),
            mock.patch.object(cleanup.vercel, "_project", return_value={"protectionBypass": "private"}),
            mock.patch.object(cleanup.frontend_probe, "_automation_bypass", return_value="owned-bypass"),
            mock.patch.object(cleanup, "DirectCleanupClient", return_value=self.direct),
        ]
        for patcher in self.patches:
            patcher.start(); self.addCleanup(patcher.stop)

    @staticmethod
    def admission(epoch, recovery):
        return {"epoch": epoch, "newWork": False, "recovery": recovery, "active": 0, "uncertain": 0}

    def load_retained(self, *_args, **_kwargs):
        return {"record": copy.deepcopy(self.record), "recordSha256": self.retained_digest}

    def native(self, context, _client, **_kwargs):
        plan = context["plan"]
        return {key: plan[key] for key in ("projectId", "deploymentId", "sourceCommit", "deploymentUrl", "schedule")} | {"nativeEnabled": False}

    def day_two(self, context, client, bearer, *, expected_profile):
        self.assertEqual(bearer, self.broker.initial["scopedCronSecret"])
        self.assertEqual(expected_profile, PROFILE)
        self.assertIsInstance(client, cleanup.LockedClient)
        return self.native(context, client)

    def probe(self, _observer, operation):
        admission = self.admissions.pop(0)
        result = {"status": "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED", "admission": admission}
        if operation == "witness":
            result["witness"] = {"operations": [{"id": OPERATION, "epoch": "11", "kind": "recovery", "state": "completed",
                "completed_at": "2026-11-07T00:00:01.000Z", "reconciliation_sha256": None,
                "producer_sha256": self.native_plan["producer"]["producerSha256"], "source_sha": self.native_plan["sourceCommit"],
                "role_oid": self.native_plan["producer"]["role"]["oid"]}]}
            if self.operation_mutation == "extra":
                result["witness"]["operations"].append(copy.deepcopy(result["witness"]["operations"][0]))
            elif self.operation_mutation == "wrong-producer":
                result["witness"]["operations"][0]["producer_sha256"] = "f" * 64
        return result

    def stage(self):
        return cleanup.P2ScopedExportCleanupStage(self.broker)

    def test_closed_preflight_one_invocation_and_exact_completed_join(self):
        stage = self.stage()
        preflight = stage.preflight("owned-secret")
        invoked = stage.invoke("owned-secret")
        joined = stage.join()
        self.assertEqual(preflight["status"], "P2_SCOPED_EXPORT_CLEANUP_PREFLIGHT_VERIFIED")
        self.assertEqual(invoked["status"], "P2_SCOPED_EXPORT_CLEANUP_INVOKED")
        self.assertEqual(invoked["cleanupReceipt"]["requestId"], OPERATION)
        self.assertEqual(joined["status"], "P2_SCOPED_EXPORT_CLEANUP_JOINED")
        self.assertEqual(joined["operationId"], OPERATION)
        self.assertEqual(joined["completedRecoveryOperations"], 1)
        self.assertEqual(joined["persistenceReviewedSha256"], cleanup._digest(self.reviewed))
        self.assertEqual(len(self.direct.calls), 3)
        self.assertNotEqual(self.direct.calls[0][2], "owned-secret")
        self.assertEqual([row[2] for row in self.direct.calls[1:]], ["owned-secret", "owned-secret"])
        retained = "".join(path.read_text() for path in self.directory.glob("p2-scoped-export-cleanup-*.json"))
        self.assertNotIn("owned-secret", retained)
        self.assertEqual(sorted(path.name for path in self.directory.glob("p2-scoped-export-cleanup-*.json")), [
            "p2-scoped-export-cleanup-intent.json", "p2-scoped-export-cleanup-invocation.json",
            "p2-scoped-export-cleanup-joined.json", "p2-scoped-export-cleanup-preflight.json"])

    def test_ready_digest_command_and_all_expiry_evidence_refuse_before_http(self):
        cases = ("digest", "command", "frontend-clock", "course-duration", "missing-service")
        for case in cases:
            with self.subTest(case=case):
                original_record, original_digest = copy.deepcopy(self.record), self.plan["scopedAction"]["readyRecordSha256"]
                try:
                    if case == "digest":
                        self.plan["scopedAction"]["readyRecordSha256"] = "f" * 64
                    elif case == "command":
                        self.record["witness"]["command"]["commandId"] = "00000000-0000-4000-8000-000000000099"
                    elif case == "frontend-clock":
                        self.record["privateEvidence"]["export"]["frontend"]["expiresAt"] = "2999-11-06T00:00:00.000Z"
                    elif case == "course-duration":
                        self.record["privateEvidence"]["export"]["course"]["expiresAt"] = "2026-11-05T12:01:00.000Z"
                    else:
                        del self.record["privateEvidence"]["export"]["community"]
                    with self.assertRaises(ValueError):
                        self.stage()
                    self.assertEqual(self.direct.calls, [])
                finally:
                    self.record = original_record
                    self.plan["scopedAction"]["readyRecordSha256"] = original_digest

    def test_changed_day_two_deployment_refuses_before_cleanup_request(self):
        stage = self.stage()
        other = {**self.native({"plan": self.native_plan}, None), "deploymentId": "dpl_foreign"}
        with mock.patch("p2_day_two_workload.observe", return_value=other) as observed:
            with self.assertRaisesRegex(ValueError, "NATIVE_OFF_REQUIRED"):
                stage.preflight("owned-secret")
        observed.assert_called_once()
        cleanup.native.observe.assert_not_called()
        self.assertEqual(self.direct.calls, [])

    def test_persistence_review_digest_refuses_before_retained_read_or_http(self):
        self.plan["persistenceReviewedSha256"] = "f" * 64
        with mock.patch.object(cleanup.persistence, "load_retained_capture") as retained:
            with self.assertRaises(ValueError):
                self.stage()
        retained.assert_not_called()
        self.assertEqual(self.direct.calls, [])

    def test_ambiguous_invocation_is_retained_once_and_never_retried(self):
        stage = self.stage()
        stage.preflight("owned-secret")
        self.direct.responses[0] = {"status": 200, "requestId": OPERATION,
            "body": {"operation": "expire-export", "commandId": COMMAND, "outcome": "already-scrubbed",
                "status": "expired", "dataCleared": True, "frontendCleared": True, "requestId": OPERATION}}
        with self.assertRaisesRegex(cleanup.ScopedCleanupUncertain, "P2_SCOPED_EXPORT_CLEANUP_UNCERTAIN"):
            stage.invoke("owned-secret")
        receipt = json.loads((self.directory / "p2-scoped-export-cleanup-invocation.json").read_text())
        self.assertEqual(receipt["status"], "P2_SCOPED_EXPORT_CLEANUP_REQUIRES_REVIEW")
        self.assertEqual(receipt["operationId"], OPERATION)
        self.assertFalse(receipt["automaticRetryAttempted"])
        with self.assertRaises(ValueError):
            stage.invoke("owned-secret")
        self.assertEqual(len(self.direct.calls), 3)

    def test_join_rejects_extra_or_wrong_completed_operation(self):
        stage = self.stage(); stage.preflight("owned-secret"); stage.invoke("owned-secret")
        for case in ("extra", "wrong-producer"):
            self.admissions[:] = [self.admission("12", False)]
            self.operation_mutation = case
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    stage.join()
        self.operation_mutation = None

    def test_fixed_client_uses_only_canonical_query_and_private_response(self):
        client = REAL_DIRECT_CLIENT.__new__(REAL_DIRECT_CLIENT)
        response = FakeResponse(200, {"requestId": OPERATION})
        opener = mock.Mock(); opener.open.return_value = response; client._opener = opener
        actual = client.request("https://owned.vercel.app", COMMAND, "owned-secret", "owned-bypass")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://owned.vercel.app/api/cron/account-lifecycle?operation=expire-export&commandId=" + COMMAND)
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.headers["Authorization"], "Bearer owned-secret")
        self.assertEqual(actual["requestId"], OPERATION)

        response.body = b'{"requestId":"first","requestId":"second"}'
        with self.assertRaisesRegex(ValueError, "P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED"):
            client.request("https://owned.vercel.app", COMMAND, "owned-secret", "owned-bypass")


if __name__ == "__main__":
    unittest.main()
