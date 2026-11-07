"""Owned filesystem/protocol tests; no Docker, database, provider, or live traffic."""

import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import p2_certification_parent as parent
import p2_scoped_mux as mux


ATTEMPT = "11111111-1111-4111-8111-111111111111"
PROFILE = {"version": 1, "id": "staging-current",
           "sha256": "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba"}


def action():
    return {"attemptId": ATTEMPT, "generation": 2, "environmentId": "env_owned",
            "assetId": "asset_owned", "uploadId": "upload_owned", "eventType": "video.asset.ready"}


def managed(suffix="before"):
    row = {"attemptId": ATTEMPT, "generation": 2, "managedByCourse": True,
           "environmentId": "env_owned", "uploadId": "upload_owned", "assetId": "asset_owned",
           "status": "ready", "isCurrent": True, "deletedAt": None, "observation": suffix}
    # The production row does not contain observation; it only differentiates
    # the owned fixture's two source-issued projections.
    digest = hashlib.sha256(mux._canonical(row)).hexdigest()
    row.pop("observation")
    return {"row": row, "rowSha256": digest, "databaseIdentitySha256": "d" * 64}


class Runner:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ["docker", "run"]:
            return SimpleNamespace(stdout=json.dumps(self.result), stderr="", returncode=0)
        return SimpleNamespace(stdout="", stderr="", returncode=0)


class ScopedMuxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-scoped-mux-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.admission = self.root / "admission"
        self.admission.mkdir(mode=0o700)
        self.original = {"version": 1, "environment": "staging", "releaseId": "release-owned",
                         "candidateSha256": "c" * 64, "actionId": "previous-closed",
                         "newWork": False, "recovery": False}
        (self.admission / "state.json").write_bytes(mux._canonical(self.original))
        self.fd = os.open(self.admission, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(lambda: os.close(self.fd))

    def typed_parent(self):
        scope = parent.P2CertificationScope.__new__(parent.P2CertificationScope)
        scope._expected_profile = PROFILE
        scope.require_frontend = lambda *_: None
        scope.require_configuration = lambda *_: None
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        broker.scope = scope
        broker.external_armed = True
        broker.initial = {"certificationActionId": "mux-owned-action", "candidateSha256": "c" * 64,
                          "sourceCommit": "2" * 40,
                          "sourceSha256": {mux._SOURCE_KEY: mux._hash(mux._SOURCE.read_bytes())},
                          "credentials": {"COURSE_STAGING_DATABASE_URL": "postgresql://private"},
                          "certificationPlan": {"mode": "mux-callback-recovery", "scopedAction": action(),
                                                "maximumSeconds": 300, "gatewayProcessSha256": "a" * 64,
                                                "gatewayConfigurationSha256": "b" * 64}}
        broker.selected = {"environment": "staging", "releaseId": "release-owned",
                           "sources": {"frontend": {"commit": "1" * 40}},
                           "artifacts": {"gateway": {"image": "gateway@sha256:" + "1" * 64},
                                         "courseMigration": {"image": "course@sha256:" + "2" * 64}}}
        broker.jobs = {"frontend": {}, "course": {"image": "course@sha256:" + "2" * 64,
            "job": {"target": {"user": "course_runtime", "database": "course", "serverMajor": 16}}}}
        broker.configuration = self.root
        broker.admission_fd = self.fd
        broker.admission_identity = os.fstat(self.fd)
        broker.runtime_current = [{"service": "gateway", "containerId": "gateway-one",
                                   "image": "gateway@sha256:" + "1" * 64, "health": "healthy"}]
        broker.process_snapshot = [{"service": "gateway", "containerId": "gateway-one", "pid": "7",
            "startedAt": "2026-11-07T00:00:00Z", "mounts": {"/admission": str(self.admission)}}]
        broker._runtime_processes = lambda: broker.process_snapshot
        broker._native_observe = lambda: {"nativeEnabled": False}
        broker.check = lambda: None
        broker.observer = SimpleNamespace(probe=lambda _operation: {"admission": {
            "epoch": "1", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}})
        return broker

    def manual_stage(self):
        stage = mux.P2ScopedMuxStage.__new__(mux.P2ScopedMuxStage)
        broker = self.typed_parent()
        stage.broker, stage.scope, stage.plan = broker, broker.scope, broker.initial["certificationPlan"]
        stage.action = action()
        stage._state, stage._opened_at, stage._deadline = "new", None, None
        stage._scoped_raw = stage._scoped_sha256 = stage._observed = None
        stage._original_raw = mux._canonical(self.original)
        stage._original_sha256 = mux._hash(stage._original_raw)
        stage._managed_before = managed()
        stage._initial_frontend = broker.observer.probe("witness")["admission"]
        stage._gateway_process_sha256 = "a" * 64
        stage._mount = {"device": str(os.fstat(self.fd).st_dev), "inode": str(os.fstat(self.fd).st_ino)}
        stage._admission_fd = os.dup(self.fd)
        self.addCleanup(lambda: os.close(stage._admission_fd) if stage._admission_fd is not None else None)
        stage._check = lambda: None
        stage._frontend_closed = lambda: stage._initial_frontend
        stage._storage_identity = lambda: os.fstat(stage._admission_fd)
        stage._read_state = lambda: (self.admission / "state.json").read_bytes()
        stage._managed_attempt = lambda _phase="current": managed("after")
        return stage

    def marker(self, stage, *, acknowledgments, admitted=None, active=0, uncertain=0):
        raw = (self.admission / "state.json").read_bytes()
        value = json.loads(raw)
        if value["version"] == 1:
            admission = {"valid": True, "sha256": mux._hash(raw), **value,
                         "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0}}
        else:
            admission = {"valid": False, "sha256": mux._hash(raw), "version": 2, "environment": "staging",
                         "releaseId": "release-owned", "candidateSha256": "c" * 64,
                         "actionId": "mux-owned-action", "newWork": None, "recovery": None,
                         "muxCallbackActive": True, "active": {"newWork": 0, "recovery": active},
                         "uncertain": {"newWork": 0, "recovery": uncertain},
                         "muxCallbackEvidence": {"admitted": len(acknowledgments) if admitted is None else admitted,
                                                 "managedAcks": acknowledgments}}
        return {"status": "P2_FAULT_GATEWAY_CURRENT", "processSha256": "a" * 64,
                "gatewayConfigurationSha256": "b" * 64,
                "admissionDirectory": stage._mount, "admission": admission}

    def test_constructor_requires_exact_typed_profiled_parent_mode_and_installed_source(self):
        broker = self.typed_parent()
        with patch.object(mux.os, "geteuid", return_value=0), patch.object(mux.P2ScopedMuxStage, "_preflight"):
            stage = mux.P2ScopedMuxStage(broker)
        self.addCleanup(stage.__del__)
        self.assertEqual(stage.action, action())
        broker.initial["certificationPlan"]["mode"] = "contain-native"
        with patch.object(mux.os, "geteuid", return_value=0), self.assertRaisesRegex(ValueError, "SOURCE_MODE"):
            mux.P2ScopedMuxStage(broker)
        broker.initial["certificationPlan"]["mode"] = "mux-callback-recovery"
        broker.initial["sourceSha256"][mux._SOURCE_KEY] = "0" * 64
        with patch.object(mux.os, "geteuid", return_value=0), self.assertRaisesRegex(ValueError, "INSTALLED_SOURCE"):
            mux.P2ScopedMuxStage(broker)

    def test_action_is_closed_and_event_specific(self):
        self.assertEqual(mux.P2ScopedMuxStage._validate_action(action()), action())
        for changed in ({**action(), "extra": True}, {**action(), "generation": True},
                        {**action(), "eventType": "video.asset.track.ready", "assetId": None},
                        {**action(), "eventType": "video.upload.asset_created", "uploadId": None}):
            with self.assertRaises(ValueError):
                mux.P2ScopedMuxStage._validate_action(changed)

    def test_atomic_replace_uses_compact_sorted_bytes_and_leaves_no_temporary(self):
        stage = self.manual_stage()
        raw = mux._canonical({"z": 1, "a": 2})
        stage._replace_state(raw, "owned")
        self.assertEqual((self.admission / "state.json").read_bytes(), b'{"a":2,"z":1}\n')
        self.assertEqual(list(self.admission.glob(".p2-scoped-mux-*")), [])

    def test_fixed_selected_course_query_binds_runtime_role_database_and_managed_row(self):
        stage = self.manual_stage()
        row = {"attemptId": ATTEMPT, "generation": 2, "managedByCourse": True,
               "environmentId": "env_owned", "uploadId": "upload_owned", "assetId": "asset_owned",
               "status": "ready", "isCurrent": True, "deletedAt": None}
        runner = Runner({"identity": {"user": "course_runtime", "database": "course", "server_version_num": 160011},
                         "rows": [row]})
        stage.scope = runner
        proof = mux.P2ScopedMuxStage._managed_attempt(stage, "before")
        self.assertEqual(proof["row"], row)
        command, options = runner.calls[0]
        self.assertEqual(command[:4], ["docker", "run", "--rm", "--name"])
        self.assertIn("BEGIN READ ONLY", command[-1])
        self.assertNotIn("postgresql://private", repr(command))
        self.assertEqual(options["env"]["STAGING_DATABASE_URL"], "postgresql://private")
        self.assertEqual(runner.calls[-1][0][:4], ["docker", "container", "ls", "--all"])
        runner.result["rows"][0]["managedByCourse"] = False
        with self.assertRaisesRegex(ValueError, "MANAGED_ATTEMPT"):
            mux.P2ScopedMuxStage._managed_attempt(stage, "before")

    def test_open_observe_close_requires_actual_ack_and_restores_exact_v1(self):
        stage = self.manual_stage()
        acknowledgments = []
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=acknowledgments)
        with patch.object(mux.time, "time", return_value=1_794_009_600.0), \
             patch.object(mux.time, "monotonic", side_effect=[10.0, 10.0, 11.0, 12.0, 13.0]):
            opened = stage.open()
            state = json.loads((self.admission / "state.json").read_bytes())
            self.assertEqual(state["muxCallback"]["expiresAt"], "2026-11-07T00:02:00.000Z")
            self.assertEqual(opened["status"], "P2_SCOPED_MUX_OPENED")
            waiting = stage.observe()
            self.assertEqual(waiting["status"], "P2_SCOPED_MUX_WAITING")
            self.assertFalse(waiting["effectObserved"])
            acknowledgments.append({"requestId": "request_owned", "eventId": "event_owned", "upstreamStatus": 200})
            observed = stage.observe()
            closed = stage.close()
        self.assertEqual(observed["status"], "P2_SCOPED_MUX_EFFECT_OBSERVED")
        self.assertEqual(closed["status"], "P2_SCOPED_MUX_CLOSED")
        self.assertEqual(closed["managedAckCount"], 1)
        self.assertEqual((self.admission / "state.json").read_bytes(), mux._canonical(self.original))

    def test_preflight_and_close_preserve_ordinary_operator_state_bytes(self):
        stage = self.manual_stage()
        original = (json.dumps(self.original, sort_keys=True) + "\n").encode()
        (self.admission / "state.json").write_bytes(original)
        acknowledgments = [{"requestId": "request_owned", "eventId": "event_owned", "upstreamStatus": 200}]
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=acknowledgments)
        stage._preflight()
        stage.open()
        stage.observe()
        stage.close()
        self.assertEqual((self.admission / "state.json").read_bytes(), original)

    def test_close_refuses_if_managed_effect_changes_after_observation(self):
        stage = self.manual_stage()
        acknowledgments = [{"requestId": "request_owned", "eventId": "event_owned", "upstreamStatus": 200}]
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=acknowledgments)
        stage.open()
        stage.observe()
        stage._managed_attempt = lambda _phase: {**managed("after"), "rowSha256": "9" * 64}
        with self.assertRaisesRegex(ValueError, "EFFECT_CHANGED_BEFORE_CLOSE"):
            stage.close()
        self.assertEqual((self.admission / "state.json").read_bytes(), mux._canonical(self.original))

    def test_close_fences_even_after_expiry_but_refuses_success_without_prior_effect(self):
        stage = self.manual_stage()
        acknowledgments = []
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=acknowledgments)
        with patch.object(mux.time, "time", return_value=1_794_009_600.0), \
             patch.object(mux.time, "monotonic", side_effect=[10.0, 10.0]):
            stage.open()
        with self.assertRaisesRegex(ValueError, "EFFECT_NOT_OBSERVED"):
            stage.close()
        self.assertEqual((self.admission / "state.json").read_bytes(), mux._canonical(self.original))
        self.assertEqual(stage._state, "closed")

    def test_immediate_callback_does_not_make_open_rollback_and_inflight_poll_is_waiting(self):
        stage = self.manual_stage()
        acknowledgments = [{"requestId": "request_early", "eventId": "event_early", "upstreamStatus": 200}]
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=acknowledgments)
        with patch.object(mux.time, "time", return_value=1_794_009_600.0), \
             patch.object(mux.time, "monotonic", side_effect=[10.0, 10.0, 11.0]):
            opened = stage.open()
            self.assertTrue(opened["effectAlreadyVisible"])
            self.assertEqual(opened["managedAckCount"], 1)
            self.assertEqual(stage.observe()["status"], "P2_SCOPED_MUX_EFFECT_OBSERVED")
        stage.close()

        stage = self.manual_stage()
        stage.broker._gateway_observation = lambda: self.marker(stage, acknowledgments=[], admitted=1, active=1)
        with patch.object(mux.time, "time", return_value=1_794_009_600.0), \
             patch.object(mux.time, "monotonic", side_effect=[20.0, 20.0, 21.0]):
            opened = stage.open()
            waiting = stage.observe()
        self.assertEqual(opened["admitted"], 1)
        self.assertEqual(waiting["status"], "P2_SCOPED_MUX_WAITING")
        self.assertEqual(waiting["active"]["recovery"], 1)
        with self.assertRaisesRegex(ValueError, "EFFECT_NOT_OBSERVED"):
            stage.close()

    def test_marker_rejects_uncertainty_duplicate_ack_and_unbound_sha(self):
        stage = self.manual_stage()
        stage._scoped_sha256 = "f" * 64
        ack = {"requestId": "request_owned", "eventId": "event_owned", "upstreamStatus": 200}
        value = {"valid": False, "sha256": "f" * 64, "version": 2, "environment": "staging",
                 "releaseId": "release-owned", "candidateSha256": "c" * 64, "actionId": "mux-owned-action",
                 "newWork": None, "recovery": None, "muxCallbackActive": True,
                 "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0},
                 "muxCallbackEvidence": {"admitted": 1, "managedAcks": [ack]}}
        stage.broker._gateway_observation = lambda: {"status": "P2_FAULT_GATEWAY_CURRENT",
            "processSha256": "a" * 64, "gatewayConfigurationSha256": "b" * 64,
            "admissionDirectory": stage._mount, "admission": value}
        marker = stage._scoped_marker()
        self.assertEqual(marker["muxCallbackEvidence"]["admitted"], 1)
        self.assertEqual(stage._marker_disposition(marker), "observed")
        value["uncertain"]["recovery"] = 1
        self.assertEqual(stage._marker_disposition(stage._scoped_marker()), "uncertain")
        value["uncertain"]["recovery"] = 0
        value["muxCallbackEvidence"] = {"admitted": 2, "managedAcks": [ack, ack]}
        with self.assertRaisesRegex(ValueError, "MANAGED_ACK_REQUIRED"):
            stage._scoped_marker()
        value["muxCallbackEvidence"] = {"admitted": 1, "managedAcks": [ack]}
        value["sha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "GATEWAY_MARKER"):
            stage._scoped_marker()

    def test_standalone_main_has_no_authority(self):
        source = mux._SOURCE.read_text()
        self.assertIn("P2_SCOPED_MUX_SOURCE_PARENT_REQUIRED", source)
        self.assertNotIn("argparse", source)


if __name__ == "__main__":
    unittest.main()
