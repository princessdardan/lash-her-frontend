"""Owned evidence and timing tests for the S05 replacement observation."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import migrate
import p2_certification_parent as parent
import p2_release_supervisor as supervisor
import p2_scoped_mux_replacement as replacement
from p2_scoped_mux import _PROFILE, _canonical, _hash
from p2_scoped_mux_readiness import _ready_row
from p2_scoped_mux_readiness_test import ACTION as OLD, fixture as held_fixture


NEW = {**OLD, "attemptId": "10000000-0000-4000-8000-000000000004", "generation": 3,
       "assetId": "new-asset", "uploadId": "new-upload", "playbackIdSha256": "b" * 64}
EXPIRY = "2026-11-09T20:10:00.000Z"
DATABASE = "d" * 64
PLAN = {**{key: "owned-binding" for key in parent._RESUME_RELEASE_PINS}, "environment": "staging",
        "mode": replacement.MODE, "initialEpoch": "9", "certificationActionId": "owned-replacement",
        "planSha256": "a" * 64, "nativePlan": {key: "owned-binding" for key in parent._RESUME_DEPLOYMENT_PINS}}
LAYOUT = supervisor.PROFILED_CERTIFICATION_LAYOUT


def observation():
    return {**{key: OLD[key] for key in replacement._OLD_FIELDS}, "successor": _ready_row(NEW),
            "observedAt": "2026-11-09T20:08:00.000000Z", "supersededAt": "2026-11-09T20:07:00.000000Z",
            "lastTokenExpiresAt": "2026-11-09T20:10:00.000000Z", "deletedAt": None,
            "leasePresent": False, "lastErrorCode": None, "isCurrent": False, "managedByCourse": True}


def cleanup_row():
    return {**observation(), "observedAt": "2026-11-09T20:11:00.000000Z",
            "deletedAt": "2026-11-09T20:10:01.000000Z"}


class ReplacementTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.results = Path(temporary.name).resolve()
        self.playback = {"courseId": OLD["courseId"], "lessonId": OLD["lessonId"], "playbackIdSha256": OLD["playbackIdSha256"],
                         "playbackExpiresAt": EXPIRY}
        self.upload = {**{key: NEW[key] for key in ("attemptId", "generation", "environmentId", "uploadId", "courseId", "lessonId")},
                       "operation": "upload-video-and-observe-callback", "currentVideoAssetId": OLD["attemptId"],
                       "uploadSent": True, "upload": {"assetId": NEW["assetId"], "callbackReceiptSha256": "c" * 64}}
        self.action = {"stage": replacement.BEFORE, "predecessor": OLD, "successor": NEW, "beforeExpiry": None,
                       "playback": self.prior("owned-playback", replacement._PLAYBACK, self.playback),
                       "predecessorReady": self.prior("owned-ready", replacement._READY,
                                                     {"scopedAction": OLD, "databaseIdentitySha256": DATABASE}),
                       "replacementUpload": self.prior("owned-upload", replacement._UPLOAD, self.upload)}
        self.plan = {**PLAN, "scopedAction": self.action}

    def prior(self, action_id, status, fields, *, marker=True):
        directory = self.results / (LAYOUT["receiptPrefix"] + action_id)
        directory.mkdir(mode=0o700)
        plan = {**PLAN, "certificationActionId": action_id}
        joined = {"version": 2, "qualificationTargetProfile": _PROFILE, "status": status,
                  "certificationActionId": action_id, "planSha256": plan["planSha256"], **fields}
        terminal = {"version": 2, "qualificationTargetProfile": _PROFILE, "status": LAYOUT["terminalStatus"],
                    "certificationActionId": action_id, "caseStatus": status, "planSha256": plan["planSha256"],
                    "caseOutcomeSha256": _hash(_canonical(joined))}
        migrate.write_json(directory, "p2-scoped-case-joined.json", joined)
        migrate.write_json(directory, LAYOUT["terminalName"], terminal)
        digest = _hash((directory / LAYOUT["terminalName"]).read_bytes())
        if marker:
            if status == replacement._PLAYBACK:
                migrate.write_json(directory, parent._RESUME_GUARD_RECEIPT, {
                    **replacement._guard_receipt(plan, terminal, digest),
                    "status": "P2_INTERACTIVE_LESSON_RESUME_GUARD_VERIFIED", "planSha256": plan["planSha256"]})
            else:
                migrate.write_json(directory, replacement.MARKER, replacement._guard_receipt(plan, terminal, digest))
        return {"actionId": action_id, "hostTerminalSha256": digest}

    def after(self):
        return {**self.action, "stage": replacement.AFTER, "beforeExpiry": self.prior(
            "owned-pre-expiry", replacement.STATUS[replacement.BEFORE],
            {"scopedAction": self.action, "observation": observation(), "databaseIdentitySha256": DATABASE})}

    def test_actual_owned_prior_files_join_both_observations(self):
        before = replacement.prior_evidence(self.plan, self.results)
        self.assertEqual(before[1:], (DATABASE, None))
        replacement.validate_observation(self.action, observation(), before[0], before[2])
        after = self.after()
        retained = replacement.prior_evidence({**self.plan, "scopedAction": after}, self.results)
        self.assertEqual(retained[2], observation())
        replacement.validate_observation(after, cleanup_row(), retained[0], retained[2])

    def test_held_stage_reads_only_once_with_reviewed_worker_and_unchanged_fences(self):
        broker, scope_plan, _, gateway = held_fixture()
        plan = {**self.plan, "initialEpoch": scope_plan["initialEpoch"], "startState": scope_plan["startState"]}
        plan["planSha256"] = parent._profiled_plan_hash(plan)
        gateway.update(processSha256=plan["gatewayProcessSha256"], gatewayConfigurationSha256=plan["gatewayConfigurationSha256"])
        broker.initial["certificationPlan"] = plan
        broker.scope.certification_plan = deepcopy(plan)
        broker.initial["sourceSha256"][replacement._SOURCE_KEY] = _hash(replacement._SOURCE.read_bytes())
        broker.results = self.results
        proof = {"courseMigrationImage": "owned/course@sha256:" + "e" * 64,
                 "courseDatabaseReceiptSha256": "f" * 64, "databaseIdentitySha256": DATABASE}
        worker = {"MUX_ENVIRONMENT_ID": OLD["environmentId"], "MUX_MEDIA_RECOVERY_ENABLED": "true",
                  "MUX_MEDIA_CLEANUP_ENABLED": "true"}
        with patch.object(replacement.P2ScopedMuxReplacementStage, "_query", return_value=(observation(), proof)) as query, \
             patch.object(replacement.P2ScopedMuxReplacementStage, "_environment", return_value=worker):
            stage = replacement.P2ScopedMuxReplacementStage(broker)
            self.assertEqual(stage.observe()["status"], replacement.STATUS[replacement.BEFORE])
            self.assertEqual(broker._gateway_current.call_count, 2)
            self.assertEqual(broker.require_scoped_native_off.call_count, 2)
            self.assertEqual(query.call_args.args[1][-1], OLD["attemptId"])
            self.assertNotIn(OLD["playbackIdSha256"], query.call_args.args[1])
            with self.assertRaisesRegex(ValueError, "ALREADY_ATTEMPTED"):
                stage.observe()
        with patch.object(replacement.P2ScopedMuxReplacementStage, "_query") as query, \
             patch.object(replacement.P2ScopedMuxReplacementStage, "_environment",
                          return_value={**worker, "MUX_MEDIA_CLEANUP_ENABLED": "false"}):
            stage = replacement.P2ScopedMuxReplacementStage(broker)
            with self.assertRaisesRegex(ValueError, "CLEANUP_WORKER_REQUIRED"):
                stage.observe()
            query.assert_not_called()

    def test_uncommitted_tampered_and_wrong_predecessor_upload_refuse(self):
        for suffix, upload, marker, error in (
            ("uncommitted", self.upload, False, FileNotFoundError),
            ("wrong-predecessor", {**self.upload, "currentVideoAssetId": NEW["attemptId"]}, True, ValueError),
            ("wrong-successor", {**self.upload, "upload": {**self.upload["upload"], "assetId": "other-asset"}}, True, ValueError),
        ):
            ref = self.prior(suffix, replacement._UPLOAD, upload, marker=marker)
            with self.subTest(suffix=suffix), self.assertRaises(error):
                replacement.prior_evidence({**self.plan, "scopedAction": {**self.action, "replacementUpload": ref}}, self.results)
        ref = {**self.action["replacementUpload"], "hostTerminalSha256": "e" * 64}
        with self.assertRaisesRegex(ValueError, "PRIOR_GUARD"):
            replacement.prior_evidence({**self.plan, "scopedAction": {**self.action, "replacementUpload": ref}}, self.results)
        record = self.results / (LAYOUT["receiptPrefix"] + self.action["replacementUpload"]["actionId"]) / "p2-scoped-case-joined.json"
        edited = json.loads(record.read_bytes())
        edited["upload"]["callbackReceiptSha256"] = "f" * 64
        record.write_text(json.dumps(edited))
        with self.assertRaisesRegex(ValueError, "PRIOR_GUARD"):
            replacement.prior_evidence(self.plan, self.results)

    def test_refuses_early_cleanup_later_issuance_and_wrong_successor(self):
        expires = replacement._instant(EXPIRY)
        for changed in (
            {"deletedAt": "2026-11-09T20:08:01.000000Z"},
            {"observedAt": "2026-11-09T20:10:00.000000Z"},
            {"lastTokenExpiresAt": "2026-11-09T20:10:30.000000Z"},
            {"supersededAt": "2026-11-09T20:09:00.000000Z"},
            {"successor": {**_ready_row(NEW), "status": "processing"}}, {"isCurrent": True},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                replacement.validate_observation(self.action, {**observation(), **changed}, expires, None)
        after = self.after()
        for changed in (
            {"deletedAt": None}, {"deletedAt": "2026-11-09T20:09:59.999000Z"}, {"leasePresent": True},
            {"lastTokenExpiresAt": "2026-11-09T20:11:00.000000Z"},
            {"supersededAt": "2026-11-09T20:07:01.000000Z"},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                replacement.validate_observation(after, {**cleanup_row(), **changed}, expires, observation())

    def test_after_requires_the_same_before_selection_and_database(self):
        after = self.after()
        changed = deepcopy(after)
        changed["successor"]["playbackIdSha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "BEFORE_BINDING"):
            replacement.prior_evidence({**self.plan, "scopedAction": changed}, self.results)
        before = replacement.prior_evidence(self.plan, self.results)
        receipt = {"version": 2, "qualificationTargetProfile": _PROFILE, "status": replacement.STATUS[replacement.BEFORE],
                   "scopedAction": self.action, "observation": observation(), "frontendEpoch": self.plan["initialEpoch"],
                   **{key: self.plan[key] for key in ("environment", "planSha256", "certificationActionId",
                                                     "candidateSha256", "gatewayProcessSha256")},
                   "gatewayStateSha256": "f" * 64, "courseMigrationImage": "owned/course@sha256:" + "e" * 64,
                   "courseDatabaseReceiptSha256": "f" * 64, "databaseIdentitySha256": DATABASE,
                   "readOnly": True, "nativeEnabled": False, "muxProviderTouched": False, "trafficAuthorized": False,
                   "releaseAccepted": False}
        replacement.require_receipt(self.plan, receipt, before)
        with self.assertRaisesRegex(ValueError, "DATABASE_CHANGED"):
            replacement.require_receipt(self.plan, {**receipt, "databaseIdentitySha256": "e" * 64}, before)


if __name__ == "__main__":
    unittest.main()
