"""Owned protocol/filesystem/FD tests; actual API/PG fixture is separate."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import p2_lifecycle_worker_evidence as worker
from p2_release_scope import P2ReleaseScope
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE


class WorkerEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-worker-evidence-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name); self.directory.chmod(0o700)
        self.stage = worker.P2LifecycleWorkerEvidenceStage.__new__(worker.P2LifecycleWorkerEvidenceStage)
        self.stage.directory = self.directory
        self.stage.plan = {"version": 1, "profile": "direct-known-suspension-v1", "canonicalCommandSha256": "a"*64}
        self.stage.preflight_done = self.stage.invocation_attempted = False
        self.boundaries = []
        self.stage._boundary = lambda recovery: self.boundaries.append(recovery)
        self.stage.prior = {"user": {"firstDenied": {"responseEndedAt": "2026-11-06T12:05:30.000Z"}}}

    def test_fake_json_scope_cannot_enable_fixed_worker(self):
        with self.assertRaisesRegex(ValueError, "P2_WORKER_ACTUAL_FIXED_PARENT_REQUIRED"):
            worker.P2LifecycleWorkerEvidenceStage({"held": True}, {}, {}, self.directory, self.directory, {}, {}, {}, native_context={}, provider_client=None, observe_frontend=lambda: {})

    def test_credential_proof_requires_bad401_then_validclosed503_without_admitted_id(self):
        calls = []
        def request(secret):
            calls.append(secret)
            return {"status": 401 if len(calls) == 1 else 503, "requestId": None, "body": {"error": "unauthorized" if len(calls) == 1 else "temporarily_unavailable"}}
        self.stage._request = request
        secret = "OWNED-SYNTHETIC-PRIVATE-CRON"
        result = self.stage.preflight_credential(secret)
        self.assertEqual(self.boundaries, [False, False]); self.assertEqual(calls[1], secret)
        self.assertFalse(result["operationIdIssued"])
        self.assertNotIn(secret, (self.directory/"credential-preflight.json").read_text())

    def test_unexpected_admitted_id_while_closed_cannot_qualify_private_secret(self):
        responses = iter([{"status": 401, "requestId": None, "body": {"error": "unauthorized"}},
            {"status": 503, "requestId": "00000000-0000-4000-8000-000000000001", "body": {"error": "temporarily_unavailable"}}])
        self.stage._request = lambda _secret: next(responses)
        with self.assertRaisesRegex(ValueError, "P2_WORKER_VALID_CREDENTIAL_CLOSED_GATE_REQUIRED"):
            self.stage.preflight_credential("owned-private")
        self.assertFalse(self.stage.preflight_done)
        self.assertFalse((self.directory/"credential-preflight.json").exists())

    def test_admitted503_is_preserved_as_review_and_never_retried(self):
        self.stage.preflight_done = True
        self.stage._request = lambda _secret: {"status": 503, "requestId": "00000000-0000-4000-8000-000000000001",
            "startedAt": "2026-11-06T12:10:00.000Z", "body": {"acknowledged": 1, "retrying": 1, "blocked": 0, "exportsReady": 0, "expired": 0}}
        with self.assertRaises(ValueError):
            self.stage.invoke_direct("owned-private")
        retained = json.loads((self.directory/"worker-invocation.json").read_bytes())
        self.assertEqual(retained["status"], "P2_DIRECT_WORKER_INVOCATION_REQUIRES_REVIEW")
        self.assertEqual(retained["httpStatus"], 503); self.assertFalse(retained["nativeInvocationQualified"])
        with self.assertRaisesRegex(ValueError, "P2_WORKER_ONE_SOURCE_INVOCATION_REQUIRED"):
            self.stage.invoke_direct("owned-private")

    def test_lost_http_response_has_durable_intent_and_unknown_receipt(self):
        self.stage.preflight_done = True
        self.stage._request = lambda _secret: (_ for _ in ()).throw(TimeoutError())
        with self.assertRaises(TimeoutError):
            self.stage.invoke_direct("owned-private")
        self.assertTrue((self.directory/"worker-invocation-intent.json").exists())
        retained = json.loads((self.directory/"worker-invocation.json").read_bytes())
        self.assertIsNone(retained["httpStatus"]); self.assertIsNone(retained["operationId"])
        self.assertEqual(retained["status"], "P2_DIRECT_WORKER_INVOCATION_REQUIRES_REVIEW")

    def test_held_reader_reuses_actual_fd_and_cannot_close_or_run_arbitrary_child(self):
        path = self.directory/"release.lock"
        descriptor = os.open(path, os.O_RDWR|os.O_CREAT, 0o600); self.addCleanup(lambda: os.close(descriptor))
        fcntl.flock(descriptor, fcntl.LOCK_EX|fcntl.LOCK_NB)
        parent = P2ReleaseScope(descriptor, path, lambda: None, {})
        stage = type("OwnedStage", (), {})()
        stage.scope, stage.selected, stage.configuration = parent, {}, self.directory
        stage.reviewed = {"containers": [{"service": "course-api", "containerId": "1"*64}]}
        stage.source = Path(worker.__file__).parents[3]
        stage.verify = parent.verify
        reader = worker.HeldWorkerPersistenceScope(stage)
        calls = []
        parent.run = lambda args, **options: (calls.append((args, options)), subprocess.CompletedProcess(args, 0, b"{}", b""))[1]
        args = reader._persistence_command("frontend")
        payload = json.dumps({"mode": "frontend", "environment": "staging"}).encode()
        reader.run(args, timeout=30, input=payload, env=worker.runtime.SAFE_ENV)
        with self.assertRaises(ValueError):
            reader.run([*args[:-1], args[-1] + "changed"], timeout=30, input=payload, env=worker.runtime.SAFE_ENV)
        with self.assertRaises(ValueError):
            reader.run([*args, "foreign"], timeout=30, input=payload, env=worker.runtime.SAFE_ENV)
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(ValueError, "P2_WORKER_PARENT_LOCK_NOT_OWNED_BY_READER"):
            reader.close()
        code = "import fcntl,sys;f=open(sys.argv[1],'a+');\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('OPEN')\nexcept BlockingIOError:print('HELD')"
        self.assertEqual(subprocess.check_output([sys.executable, "-I", "-c", code, str(path)], text=True).strip(), "HELD")

    def test_profiled_witness_uses_parent_proof_and_the_existing_retained_reader(self):
        stage = self.stage
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        fields = {"version": 2, "qualificationTargetProfile": ref}
        command = {"commandId": "00000000-0000-4000-8000-000000000001", "accountVersion": 1,
            "userId": "00000000-0000-4000-8000-000000000002"}
        stage.expected_profile, stage.invocation = ref, {"observed": True}
        stage.prior["pendingRecord"] = {"pending": {"command": command}}
        stage.bundle, stage.configuration, stage.source = self.directory, self.directory, self.directory
        stage.scope, stage.database_proof = object(), object()
        stage.reviewed = {"plan": {**fields, "scope": "owned"}, "programSha256": "b" * 64}
        stage.release_evidence = {"originalReleaseReceipt": "original-terminal-raw",
            "readyReceipts": {"frontend-workload-outcome.json": "original-workload-raw",
                "frontend-promotion-outcome.json": "original-promotion-raw"}}
        witness = {"command": {"commandId": command["commandId"], "canonicalSha256": stage.plan["canonicalCommandSha256"]},
            "receivers": {name: {"status": "suspended"} for name in ("course", "community")},
            "frontend": {"laterCommandCount": 0, "pendingOrDeliveringCount": 0,
                "deliveries": [{"status": "acknowledged", "attempts": 1, "leaseId": None, "leaseUntil": None,
                    "acknowledgedAt": "2026-11-06T12:10:01.000Z"} for _ in range(2)]}}

        def owned_execution(bundle, configuration, reviewed, source, private, release_evidence, scope, proof, *, expected_profile):
            self.assertEqual((bundle, configuration, reviewed, source), (stage.bundle, stage.configuration, stage.reviewed, stage.source))
            self.assertIs(scope, stage.scope)
            self.assertIs(proof, stage.database_proof)
            self.assertEqual(expected_profile, ref)
            self.assertEqual(release_evidence, {"originalReleaseReceipt": "original-terminal-raw", "frontendDeploymentRecord": "original-promotion-raw"})
            private["frontendRuntimeDatabaseUrl"] = ""
            artifact = {**fields, "stage": "lifecycle-account", "subjectBindingSha256": worker.persistence._subject_binding(private["witness"]),
                "contextSha256": worker.persistence._context_binding(reviewed["plan"]), "witness": witness,
                "privateEvidence": None, "receipt": {}, "priorRecordSha256": None}
            digest = worker.write_record(stage.directory, "lifecycle-account.json", artifact)
            return {**fields, "status": "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED",
                "privateRecordSha256": digest, "operatorProgramSha256": stage.reviewed["programSha256"]}

        with patch.object(worker.persistence, "execute_profiled", side_effect=owned_execution) as execute, \
                patch.object(worker.persistence, "observe_with_scope") as legacy:
            result = stage.observe_lifecycle_witness("owned-private-runtime-url")
            execute.assert_called_once()
            legacy.assert_not_called()
        self.assertEqual(result["qualificationTargetProfile"], ref)
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["privateRecordSha256"], worker.digest((stage.directory / "lifecycle-account.json").read_bytes()))
        self.assertNotIn("owned-private-runtime-url", (stage.directory / "lifecycle-account.json").read_text())
        with self.assertRaisesRegex(ValueError, "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED"):
            worker.persistence.load_retained_capture({**stage.reviewed["plan"]}, stage.directory, "lifecycle-account")

        from p2_certification_parent import P2CertificationScope
        stage.scope = object.__new__(P2CertificationScope)
        stage.scope.certification_plan = {"replacementRelease": {}}
        with patch.object(worker.persistence, "execute_profiled", side_effect=ValueError("owned-stop-before-reader")) as replacement:
            with self.assertRaisesRegex(ValueError, "owned-stop-before-reader"):
                stage.observe_lifecycle_witness("owned-private-runtime-url")
            self.assertIs(replacement.call_args.kwargs["_worker_stage"], stage)
            self.assertIs(replacement.call_args.args[6], stage.scope)

    def test_profiled_native_boundary_requires_both_source_selected_readbacks(self):
        stage = self.stage
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        fields = {"version": 2, "qualificationTargetProfile": ref}
        candidate = "a" * 64
        stage.plan["candidateObjectSha256"] = candidate
        stage.expected_profile = ref
        stage.verify = lambda: None
        stage.native_context, stage.provider = {}, object()
        admission = {"newWork": False, "recovery": False, "active": 0, "uncertain": 0}
        stage.observe_frontend = lambda: {**fields, "status": "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED", "admission": admission}
        stage._gateway = lambda recovery: None
        readback = {**fields, "candidateSha256": candidate, "nativeEnabled": False, "projectId": "owned"}
        with patch.object(worker.native, "observe", return_value=readback) as observed, \
                patch.object(worker.native, "observe_metadata", return_value=readback) as metadata:
            self.assertEqual(worker.P2LifecycleWorkerEvidenceStage._boundary(stage, False), admission)
            observed.assert_called_once_with(stage.native_context, stage.provider, expected_profile=ref)
            metadata.assert_called_once_with(stage.native_context, stage.provider, expected_profile=ref)
            metadata.return_value = {key: value for key, value in readback.items() if key != "qualificationTargetProfile"}
            with self.assertRaises(ValueError):
                worker.P2LifecycleWorkerEvidenceStage._boundary(stage, False)


if __name__ == "__main__":
    unittest.main()
