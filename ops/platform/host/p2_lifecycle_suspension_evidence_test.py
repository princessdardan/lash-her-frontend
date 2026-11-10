"""Owned filesystem/authority guards only. No staging, Docker, or browser claims."""
import json
import base64
import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import p2_lifecycle_suspension_evidence as evidence


class SuspensionEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-suspension-records-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)

    def test_serialized_held_assertion_cannot_construct_real_parent_scope(self):
        with self.assertRaisesRegex(ValueError, "P2_SUSPENSION_ACTUAL_PHYSICAL_PARENT_SCOPE_REQUIRED"):
            evidence.P2LifecycleSuspensionEvidenceStage({"held": True}, {}, {}, self.directory, self.directory, {}, {}, {})

    def test_profiled_carriers_are_explicit_while_legacy_carriers_remain_version_one(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        self.assertEqual(stage._carrier('OWNED'), {'version': 1, 'status': 'OWNED'})
        stage.expected_profile = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        self.assertEqual(stage._carrier('OWNED'), {'version': 2,
            'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE), 'status': 'OWNED'})

    def test_held_stage_verifies_profiled_source_entries_and_legacy_source_object(self):
        from p2_source_closure import REQUIRED, PROFILED_CURRENT_REQUIRED, PROFILED_CERTIFICATION_REQUIRED
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE

        program_names = {
            "browserProgramSha256": "ops/platform/p2-lifecycle-browser-recorder.mjs",
            "pendingProgramSha256": "ops/platform/p2-lifecycle-pending-probe.mjs",
            "parentProgramSha256": "ops/platform/p2-lifecycle-suspension-evidence.mjs",
            "hostProgramSha256": "ops/platform/host/p2_lifecycle_suspension_evidence.py",
        }
        files = REQUIRED | PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED | evidence.identity.SOURCE_ANCHORS | set(program_names.values())
        manifest = {}
        for name in sorted(files, reverse=True):
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            raw = ("owned-source:" + name + "\n").encode()
            path.write_bytes(raw)
            manifest[name] = evidence.digest(raw)

        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.source = stage.configuration = self.directory
        stage.selected = stage.jobs = {}
        stage.scope = SimpleNamespace(require_configuration=Mock())
        stage._inventory = Mock(return_value=[])
        stage.inventory = []
        stage.plan = {"hostMachineId": "a" * 32, "configurationSha256": "b" * 64}
        for field, name in program_names.items():
            raw = (self.directory / name).read_bytes()
            stage.plan[field] = evidence.digest(raw + (evidence.BROWSER_LAUNCHER if field == "browserProgramSha256" else b""))

        object_sha = evidence.digest(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
        entries_sha = evidence.digest(json.dumps(sorted(manifest.items()), separators=(",", ":")).encode())
        self.assertNotEqual(entries_sha, object_sha)
        stage.reviewed = {"operatorSourceFiles": manifest, "plan": {}}
        with patch.object(evidence, "bind_frontend_scope"), \
                patch.object(evidence.identity, "_configuration_hash", return_value=stage.plan["configurationSha256"]), \
                patch.object(Path, "read_text", return_value=stage.plan["hostMachineId"]):
            for profile, accepted, refused in ((None, object_sha, entries_sha),
                    (dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE), entries_sha, object_sha)):
                with self.subTest(profile=profile):
                    stage.expected_profile = profile
                    stage.reviewed["plan"]["operatorSourceSha256"] = accepted
                    stage.verify()
                    stage.reviewed["plan"]["operatorSourceSha256"] = refused
                    with self.assertRaisesRegex(ValueError, "P2_SUSPENSION_SOURCE_CONFIGURATION_OR_MACHINE_CHANGED"):
                        stage.verify()

    def test_legacy_source_parent_registration_return_shape_remains_exact(self):
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.expected_profile = None; stage.challenge = None; stage.directory = self.directory
        stage.plan = {'browserProgramSha256': 'b' * 64}
        stage.verify = Mock()
        result = stage.register_source_parent('a' * 64)
        self.assertEqual(set(result), {'recordSha256', 'recordBytes'})
        record = json.loads((self.directory / 'browser-parent-intent.json').read_bytes())
        self.assertEqual(record['version'], 1); self.assertNotIn('qualificationTargetProfile', record)

    def test_profiled_release_evidence_binds_terminal_all_ready_bytes_workload_and_promotion(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        release_id, source, deployment = 'owned-release', 'a' * 40, 'dpl_Owned'
        common = {'version': 2, 'qualificationTargetProfile': ref, 'environment': 'staging',
                  'releaseId': release_id, 'sourceCommit': source, 'previousDeploymentId': 'dpl_Prior'}
        feature = {'INTEGRATION_CHECKOUT_ENABLED': False}
        writer = {'mode': 'enforce', 'targetSha256': '1' * 64, 'producerSha256': '2' * 64,
                  'sourceCommit': source, 'roleName': 'runtime_role'}
        records = {
            'frontend-build-started.json': {**common, 'trafficAuthorized': False, 'promotionAuthorized': False},
            'frontend-build-created.json': {**common, 'deploymentId': deployment, 'trafficAuthorized': False, 'promotionAuthorized': False},
            'frontend-build-outcome.json': {**common, 'deploymentId': deployment, 'trafficAuthorized': False,
                'promotionAuthorized': False, 'status': 'FRONTEND_STAGED'},
            'frontend-workload-outcome.json': {**common, 'deploymentId': deployment, 'status': 'FRONTEND_VERIFIED',
                'featureControls': feature, 'writerAdmissionBinding': writer, 'trafficAuthorized': False, 'nativeSchedulerVerified': False},
            'frontend-promotion-started.json': {**common, 'deploymentId': deployment},
            'frontend-promotion-outcome.json': {**common, 'deploymentId': deployment, 'status': 'FRONTEND_DOMAINS_PROMOTED',
                'phase': 'completed', 'frontendDomainsPromoted': True, 'trafficAuthorized': False},
        }
        raw = {name: (json.dumps(value, separators=(',', ':')) + '\n').encode() for name, value in records.items()}
        workload_sha = evidence.digest(raw['frontend-workload-outcome.json'])
        promotion_sha = evidence.digest(raw['frontend-promotion-outcome.json'])
        original = (json.dumps({**common, 'status': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
            'candidateSha256': '3' * 64, 'frontendWorkloadReceiptSha256': workload_sha,
            'trafficAuthorized': False, 'releaseAccepted': False}, separators=(',', ':')) + '\n').encode()
        scope = type('Scope', (), {})()
        scope.certification_plan = {'originalReleaseReceiptSha256': evidence.digest(original),
            'readyReceiptSha256': {name: evidence.digest(value) for name, value in raw.items()}}
        reviewed = {'plan': {'originalReleaseSha256': evidence.digest(original),
            'frontendDeploymentSha256': promotion_sha, 'candidateSha256': '3' * 64,
            'releaseId': release_id, 'sources': {'frontend': source}}}
        plan = {'releaseId': release_id, 'sourceCommit': source, 'deploymentId': deployment,
            'configurationRecordSha256': workload_sha, 'featureControls': feature, 'writerAdmissionBinding': writer}
        carrier = {'originalReleaseReceipt': base64.b64encode(original).decode(),
            'readyReceipts': {name: base64.b64encode(value).decode() for name, value in raw.items()}}
        result = evidence._release_evidence(scope, reviewed, plan, carrier, ref)
        self.assertEqual(result['frontendWorkloadReceiptSha256'], workload_sha)
        changed = copy.deepcopy(carrier)
        wrong = {**records['frontend-workload-outcome.json'], 'nativeSchedulerVerified': True}
        wrong_raw = (json.dumps(wrong, separators=(',', ':')) + '\n').encode()
        changed['readyReceipts']['frontend-workload-outcome.json'] = base64.b64encode(wrong_raw).decode()
        scope.certification_plan['readyReceiptSha256']['frontend-workload-outcome.json'] = evidence.digest(wrong_raw)
        changed_plan = {**plan, 'configurationRecordSha256': evidence.digest(wrong_raw)}
        with self.assertRaisesRegex(ValueError, 'RELEASE_EVIDENCE_SEMANTICS_REQUIRED'):
            evidence._release_evidence(scope, reviewed, changed_plan, changed, ref)
        with self.assertRaisesRegex(ValueError, 'RELEASE_EVIDENCE_REFUSED'):
            evidence._release_evidence(scope, reviewed, plan, carrier)

    def test_exclusive_private_file_is_hashed_and_cannot_be_replaced(self):
        value = {"version": 1, "status": "OWNED_RECORD"}
        result = evidence.private_record(self.directory, "browser-parent-intent.json", value)
        path = self.directory / "browser-parent-intent.json"
        self.assertEqual(result["recordSha256"], evidence.digest(path.read_bytes()))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            evidence.private_record(self.directory, "browser-parent-intent.json", {"changed": True})
        self.assertEqual(json.loads(path.read_bytes()), value)

    def test_arbitrary_filename_symlink_or_nonprivate_directory_refuses(self):
        with self.assertRaises(ValueError):
            evidence.private_record(self.directory, "foreign.json", {})
        destination = self.directory / "destination"; destination.write_text("original")
        (self.directory / "p2-lifecycle-browser-source.json").symlink_to(destination)
        with self.assertRaises(OSError):
            evidence.private_record(self.directory, "p2-lifecycle-browser-source.json", {})
        self.assertEqual(destination.read_text(), "original")
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            evidence.private_record(self.directory, "browser-parent-intent.json", {})

    def test_record_failure_never_becomes_a_standalone_browser_import_path(self):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", "import sys;sys.path.insert(0,sys.argv[1]);import runpy;runpy.run_module('p2_lifecycle_suspension_evidence',run_name='__main__')", str(Path(evidence.__file__).parent)],
            input=b'{"browserCalled":true}', capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout)
        self.assertFalse(record["standaloneEligible"]); self.assertFalse(record["browserCalled"]); self.assertFalse(record["workerInvoked"])

    def test_natural_expiry_requires_real_accepted_and_denied_order_with_fixed_original_payload(self):
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.directory = self.directory
        stage.scope = type("OwnedScope", (), {"verify": lambda self: None})()
        def observation(status, timestamp):
            return {"status": "P2_S13_PRIVATE_USER_OBSERVED", "observation": {"status": status, "requestStartedAt": timestamp, "responseEndedAt": timestamp}}
        payload = {"owned-token": "OWNED-SYNTHETIC-NOT-A-LIVE-CREDENTIAL"}
        values = iter([observation(200, "1970-01-01T00:16:39.500Z"), observation(401, "1970-01-01T00:16:40.000Z")])
        seen = []
        stage._timing = lambda actual: (seen.append(actual), next(values))[1]
        with patch.object(evidence.time, "time", return_value=1000), patch.object(evidence.time, "monotonic", return_value=0), patch.object(evidence.time, "sleep"):
            result = stage._natural_window("user", 1000000, payload)
        self.assertEqual([row["status"] for row in (result["lastAccepted"], result["firstDenied"])], [200, 401])
        self.assertTrue(all(row is payload for row in seen))
        self.assertNotIn(payload["owned-token"], (self.directory / "controlled-user-window.json").read_text())
        for rejected in (observation(503, "1970-01-01T00:16:40.000Z"), observation(401, "1970-01-01T00:16:39.999Z")):
            rows = iter([observation(200, "1970-01-01T00:16:39.500Z"), rejected])
            stage._timing = lambda _payload: next(rows)
            with patch.object(evidence.time, "time", return_value=1000), patch.object(evidence.time, "monotonic", return_value=0), patch.object(evidence.time, "sleep"):
                with self.assertRaises(ValueError):
                    stage._natural_window("user", 1000000, payload)

    def test_private_credentials_are_outside_artifact_tree_and_scrubbed_without_pg_or_provider(self):
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.credentials_directory = self.directory
        stage.capture = {"controlledUser": {"token": "OWNED-SYNTHETIC-TOKEN"}, "playback": {"requestUrl": "OWNED-SYNTHETIC-URL"}}
        evidence.private_record(self.directory, "controlled-capture.json", stage.capture)
        stage.verify = lambda: (_ for _ in ()).throw(ValueError("OWNED_BACKEND_LOST"))
        self.assertNotEqual(evidence.PRIVATE_ROOT, evidence.ROOT)
        self.assertTrue(stage.scrub_controlled_credentials()["controlledCredentialsRemoved"])
        self.assertFalse((self.directory / "controlled-capture.json").exists())
        self.assertEqual(stage.capture["controlledUser"]["token"], "")
        self.assertTrue(stage.scrub_controlled_credentials()["controlledCredentialsRemoved"])

    def test_course_runtime_parser_receives_only_the_source_selected_current_profile(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.expected_profile = ref; stage.configuration = self.directory; stage.jobs = {'course': {'job': {}}}
        stage.inventory = [{'service': 'course-api', 'containerId': 'a' * 64}]
        stage.scope = SimpleNamespace(run=Mock(return_value=subprocess.CompletedProcess([], 0,
            b'{"status":"P2_SUSPENSION_COURSE_RUNTIME_BOUND"}\n', b'')))
        stage.verify = Mock()
        values = {'COURSE_LEARNER_JWT_CURRENT_SECRET': 'x' * 32}
        info = SimpleNamespace(st_mode=0o100600, st_uid=0)
        with patch.object(Path, 'lstat', return_value=info), \
                patch.object(evidence.migrate, 'read_input', return_value=b'owned'), \
                patch.object(evidence.runtime, 'environment_values', return_value=values) as parser:
            self.assertEqual(stage._course_runtime(), values)
        parser.assert_called_once_with(b'owned', 'staging', 'course-api', stage.jobs, expected_profile=ref)


if __name__ == "__main__":
    unittest.main()
