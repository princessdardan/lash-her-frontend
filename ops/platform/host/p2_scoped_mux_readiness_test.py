"""Owned host protocol tests for the held Mux readiness observation."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import current_databases
import p2_certification_parent as parent
import p2_scoped_mux as mux
import p2_scoped_mux_readiness as readiness


ACTION = {
    "attemptId": "10000000-0000-4000-8000-000000000001",
    "courseId": "10000000-0000-4000-8000-000000000002",
    "lessonId": "10000000-0000-4000-8000-000000000003",
    "generation": 2, "environmentId": "owned-environment", "uploadId": "owned-upload",
    "assetId": "owned-asset", "playbackIdSha256": hashlib.sha256(b"owned-playback-id").hexdigest(),
}
IMAGE = "owned/course-migration@sha256:" + "a" * 64
TARGET = {"host": "owned.test", "database": "owned", "user": "owned_migration", "serverMajor": 17}
IDENTITY = {"user": TARGET["user"], "database": TARGET["database"], "server_version_num": 170002,
            "read_only": "on", "search_path": "pg_catalog"}
CONFIGURATION = b"MUX_ENVIRONMENT_ID=owned-environment\n"


def fixture():
    broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
    scope = parent.P2CertificationScope.__new__(parent.P2CertificationScope)
    plan = {"mode": "mux-readiness", "startState": "already-closed", "maximumSeconds": 300,
            "initialEpoch": "5", "environment": "staging", "certificationActionId": "owned-readiness",
            "candidateSha256": "a" * 64, "gatewayProcessSha256": "b" * 64,
            "gatewayConfigurationSha256": "c" * 64, "scopedAction": deepcopy(ACTION)}
    plan["planSha256"] = parent._profiled_plan_hash(plan)
    scope.certification_plan, scope._expected_profile = deepcopy(plan), mux._PROFILE
    scope.require_release = Mock()
    scope.require_configuration = Mock()
    scope.require_frontend = Mock()
    broker.scope, broker.certification_profile, broker.check = scope, Mock(return_value=mux._PROFILE), Mock()
    broker.guard_arm_verified = broker.external_armed = True
    broker.configuration = Path("/owned")
    broker.jobs = {"course": {"image": IMAGE, "job": {"target": TARGET}}, "frontend": {}}
    broker.selected = {"artifacts": {"courseMigration": {"image": IMAGE}}}
    broker.initial = {"certificationPlan": plan, "sourceSha256": {readiness._SOURCE_KEY: mux._hash(readiness._SOURCE.read_bytes())},
                      "configurationSha256": {"course-api.env": mux._hash(CONFIGURATION)},
                      "credentials": {"COURSE_STAGING_DATABASE_URL": "postgresql://owned-fixture"}}
    broker.api_proof = object()
    broker.process_snapshot = {"runtime": "held"}
    broker._runtime_processes = Mock(return_value=broker.process_snapshot.copy())
    broker.require_scoped_native_off = Mock(return_value={"nativeEnabled": False})
    frontend = {"epoch": "5", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
    gateway = {"processSha256": plan["gatewayProcessSha256"], "gatewayConfigurationSha256": plan["gatewayConfigurationSha256"],
               "faultLeasePresent": False, "admission": {"version": 1, "valid": True, "sha256": "d" * 64,
               "newWork": False, "recovery": False, "active": {"newWork": 0, "recovery": 0},
               "uncertain": {"newWork": 0, "recovery": 0}}}
    broker._gateway_current = Mock(return_value=gateway)
    broker.observer = scope._physical_observer = SimpleNamespace(probe=Mock(return_value={"admission": frontend}))
    return broker, plan, frontend, gateway


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.broker, self.plan, self.frontend, self.gateway = fixture()
        self.database = {"identity": IDENTITY.copy(), "rows": [readiness._ready_row(ACTION)]}
        patches = [patch.object(readiness.migrate, "read_input", return_value=CONFIGURATION),
                   patch.object(readiness.runtime, "environment_values", return_value={"MUX_ENVIRONMENT_ID": ACTION["environmentId"]}),
                   patch.object(current_databases, "read_certification_api_proof", return_value=(Path("/owned"),
                                {"databases": {"course": {"image": IMAGE, "receiptSha256": "e" * 64}}})),
                   patch.object(readiness, "run_profiled_course_query", return_value=self.database)]
        self.read_configuration, self.environment, self.proof, self.query = [p.start() for p in patches]
        for item in patches:
            self.addCleanup(item.stop)

    def test_observes_only_the_reviewed_generation_and_closes_with_same_fences(self):
        stage = readiness.P2ScopedMuxReadinessStage(self.broker)
        result = stage.observe()
        readiness.require_receipt(self.plan, result, self.gateway["admission"])
        self.assertEqual(result["status"], "P2_SCOPED_MUX_READY_OBSERVED")
        self.assertEqual(result["scopedAction"], ACTION)
        self.assertEqual(self.query.call_args.args[-1], [ACTION[key] for key in ("attemptId", "generation",
            "environmentId", "uploadId", "assetId", "courseId", "lessonId")])
        self.assertEqual(self.broker.observer.probe.call_count, 2)
        self.assertEqual(self.broker.require_scoped_native_off.call_count, 2)
        self.assertEqual(self.broker._gateway_current.call_count, 2)
        self.assertFalse(result["muxProviderTouched"])
        self.assertNotIn("owned-playback-id", json.dumps(result))
        self.assertNotIn("postgresql://", json.dumps(result))
        with self.assertRaisesRegex(ValueError, "ALREADY_ATTEMPTED"):
            stage.observe()

    def test_unarmed_open_uncertain_and_enabled_native_refuse_before_query(self):
        for change in (
            lambda: setattr(self.broker, "guard_arm_verified", False),
            lambda: self.frontend.update(active=1),
            lambda: self.gateway["admission"]["uncertain"].update(recovery=1),
            lambda: self.gateway.update(faultLeasePresent=True),
            lambda: self.broker.require_scoped_native_off.configure_mock(return_value={"nativeEnabled": True}),
        ):
            self.broker, self.plan, self.frontend, self.gateway = fixture()
            change()
            with self.assertRaisesRegex(ValueError, "(PARENT_CHANGED|CLOSED_ZERO|NATIVE_OFF)"):
                readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.query.assert_not_called()

    def test_environment_and_image_drift_refuse_before_query(self):
        self.environment.return_value = {"MUX_ENVIRONMENT_ID": "wrong-environment"}
        with self.assertRaisesRegex(ValueError, "ENVIRONMENT_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.environment.return_value = {"MUX_ENVIRONMENT_ID": ACTION["environmentId"]}
        self.broker.jobs["course"]["image"] = "wrong-image"
        with self.assertRaisesRegex(ValueError, "COURSE_IMAGE_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.query.assert_not_called()

    def test_row_and_database_drift_refuse(self):
        for changed in ({"status": "processing"}, {"isCurrent": False}, {"managedByCourse": False},
                        {"generation": 3}, {"playbackIdSha256": "f" * 64}, {"assetId": "wrong-asset"},
                        {"uploadId": "wrong-upload"}, {"lessonId": ACTION["courseId"]}):
            with self.subTest(changed=changed):
                self.database["rows"] = [{**readiness._ready_row(ACTION), **changed}]
                with self.assertRaisesRegex(ValueError, "READY_ROW_REQUIRED"):
                    readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.database["rows"] = []
        with self.assertRaisesRegex(ValueError, "COURSE_DATABASE_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.database["rows"] = [readiness._ready_row(ACTION)]
        self.database["identity"]["user"] = "wrong_migration"
        with self.assertRaisesRegex(ValueError, "COURSE_DATABASE_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(self.broker).observe()

    def test_fence_change_after_query_and_terminal_receipt_tampering_refuse(self):
        changed = deepcopy(self.gateway)
        changed["admission"]["sha256"] = "f" * 64
        self.broker._gateway_current.side_effect = [self.gateway, changed]
        with self.assertRaisesRegex(ValueError, "FENCE_CHANGED"):
            readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        self.broker._gateway_current.side_effect = None
        result = readiness.P2ScopedMuxReadinessStage(self.broker).observe()
        for modified in ({"scopedAction": {**ACTION, "assetId": "other"}}, {"readyRowSha256": "f" * 64},
                         {"gatewayStateSha256": "f" * 64}, {"readOnly": False}, {"frontendEpoch": "6"}):
            with self.subTest(modified=modified), self.assertRaisesRegex(ValueError, "RECEIPT_REQUIRED"):
                readiness.require_receipt(self.plan, {**result, **modified}, self.gateway["admission"])

    def test_proof_requires_source_owned_fixed_profile_parent(self):
        with self.assertRaisesRegex(ValueError, "PARENT_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(SimpleNamespace())
        self.broker.initial["sourceSha256"][readiness._SOURCE_KEY] = "f" * 64
        with self.assertRaisesRegex(ValueError, "PARENT_REQUIRED"):
            readiness.P2ScopedMuxReadinessStage(self.broker)


if __name__ == "__main__":
    unittest.main()
