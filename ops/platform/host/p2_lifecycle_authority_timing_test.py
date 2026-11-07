"""Owned controller/scope tests; no live provider or staging call."""
from copy import deepcopy
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import p2_identity_negative_probe as identity
import p2_identity_probe_scope as identity_scope
import p2_lifecycle_authority_timing as timing
import p2_lifecycle_authority_timing_scope as timing_scope
import p2_lifecycle_persistence_probe as persistence
import p2_lifecycle_suspension_evidence as suspension
import p2_lifecycle_worker_evidence as worker
from p2_certification_fault import frontend_target_sha256
from p2_certification_parent import P2CertificationScope
from p2_release_scope import P2ReleaseScope


class AuthorityTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(directory.cleanup)
        cls.source = Path(directory.name).resolve()
        actual = Path(timing.__file__).resolve().parents[3]
        # These controller tests exercise input and program binding without
        # constructing a deployable copy of the installed source closure.
        for name in set(timing.FILES) | identity.SOURCE_ANCHORS:
            path = cls.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / name, path)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-p2-s13-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.private_parent = self.root / "private"
        self.private_parent.mkdir(mode=0o700)
        self.action = "p2-s13-owned"
        self.identifier = "1" * 64
        self.image = "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "2" * 64
        self.identity = {
            "version": 1, "environment": "staging", "probeId": "owned-s13-identity", "releaseId": "owned-release",
            "candidateSha256": "3" * 64, "hostMachineId": "4" * 32, "configurationSha256": "5" * 64,
            "sources": {name: "6" * 40 for name in ("frontend", "course", "community")},
            "containers": [{"service": service, "containerId": format(index + 1, "064x"),
                "image": "ghcr.io/princessdardan/lash-her-platform-" + suffix + "@sha256:" + format(index + 7, "064x")}
                for index, (service, suffix) in enumerate((("gateway", "gateway"), ("course-api", "course-runtime"), ("community-api", "community-runtime")))],
            "subjects": {name: str(uuid.UUID(int=index + 1, version=4)) for index, name in enumerate(("learnerA", "learnerB", "admin"))},
            "resources": {name: str(uuid.UUID(int=index + 10, version=4)) for index, name in enumerate(("courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"))},
            "programSha256": "7" * 64, "previousProfiles": sorted(identity.PROFILES),
            "operatorSourceFiles": identity.source_closure(self.source), "operatorSourceSha256": "0" * 64,
            "priorEvidence": {"originalReleaseReceiptSha256": "8" * 64, "frontendDeploymentRecordSha256": "9" * 64},
        }
        self.identity["operatorSourceSha256"] = identity._hash(identity._canonical(self.identity["operatorSourceFiles"]))
        self.reviewed = {"version": 1, "environment": "staging", "actionId": self.action, "identity": self.identity,
            "fixture": {"courseId": str(uuid.UUID(int=30, version=4)), "lessonId": str(uuid.UUID(int=31, version=4)),
                "freeGrantReceiptSha256": "b" * 64},
            "privateDirectory": str(self.private_parent / self.action), "operatorFiles": timing.operator_hashes(self.source),
            "programSha256": timing._hash(timing.private_program(self.source)),
            "browserObserverSourceSha256": "c" * 64, "pendingObserverSourceSha256": "d" * 64,
            "lifecycleWitnessSourceSha256": "a" * 64, "s12SourceSha256": "e" * 64}

    def test_reviewed_contract_is_closed_staging_and_binds_all_six_owned_files(self):
        with patch.object(timing, "ROOT", self.root):
            self.assertIs(timing.validate_reviewed(self.reviewed), self.reviewed)
            self.assertEqual(set(self.reviewed["operatorFiles"]), set(timing.FILES))
            for field, value in (("environment", "production"), ("token", "private"), ("url", "https://foreign.invalid"),
                    ("command", ["sh"]), ("clockOffset", 300)):
                changed = deepcopy(self.reviewed)
                changed[field] = value
                with self.assertRaises(ValueError):
                    timing.validate_reviewed(changed)
            for field in ("browserObserverSourceSha256", "pendingObserverSourceSha256", "lifecycleWitnessSourceSha256", "s12SourceSha256"):
                changed = deepcopy(self.reviewed)
                changed[field] = "not-a-source"
                with self.assertRaises(ValueError):
                    timing.validate_reviewed(changed)

    def test_program_embeds_exact_identity_helper_and_has_no_runtime_relative_import(self):
        value = timing.private_program(self.source)
        self.assertIn(b"runPrivateAuthorityTimingFromStdin", value)
        self.assertNotIn(b'./p2-identity-negative-probe.mjs', value)
        self.assertNotIn(b"course-learner-key", value)
        changed = self.root / "source"
        for name in (timing.IDENTITY, timing.TIMING):
            target = changed / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((self.source / name).read_bytes())
        original = timing.private_program(changed)
        with (changed / timing.IDENTITY).open("ab") as handle:
            handle.write(b"\n// drift\n")
        self.assertNotEqual(original, timing.private_program(changed))

    def test_private_records_require_owned_nonsymlink_modes_and_never_overwrite(self):
        with patch.object(timing, "ROOT", self.root):
            directory = timing._private_directory(self.reviewed, create=True)
        path = timing._retain(directory, "capture.json", {"token": "private-marker"})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(timing._read_private(directory, "capture.json")["token"], "private-marker")
        with self.assertRaises(FileExistsError):
            timing._retain(directory, "capture.json", {})
        path.unlink()
        path.symlink_to(self.source / timing.TIMING)
        with self.assertRaises((OSError, ValueError)):
            timing._read_private(directory, "capture.json")

    def test_retained_capture_and_window_records_bind_action_candidate_configuration_and_review(self):
        with patch.object(timing, "ROOT", self.root):
            directory = timing._private_directory(self.reviewed, create=True)
        binding = timing._binding(self.reviewed)
        capture = {"bindingSha256": binding}
        timing._retain(directory, "capture.json", {"version": 1, "actionId": self.action, "bindingSha256": binding,
            "candidateSha256": self.identity["candidateSha256"], "configurationSha256": self.identity["configurationSha256"],
            "capture": capture})
        self.assertEqual(timing._capture_record(directory, self.reviewed), capture)
        suspension = {"commandId": str(uuid.uuid4())}
        timing._retain(directory, "user-window.json", {"version": 1, "status": "P2_S13_PRIVATE_USER_WINDOW", "actionId": self.action,
            "bindingSha256": binding, "candidateSha256": self.identity["candidateSha256"],
            "configurationSha256": self.identity["configurationSha256"], "suspension": suspension, "window": {}})
        self.assertEqual(timing._window_record(directory, self.reviewed, "user-window.json", "P2_S13_PRIVATE_USER_WINDOW")["suspension"], suspension)
        changed = deepcopy(self.reviewed)
        changed["identity"]["candidateSha256"] = "f" * 64
        with self.assertRaises(ValueError):
            timing._capture_record(directory, changed)

    def test_capture_public_strips_user_jwt_mux_url_playback_id_and_jti(self):
        observation = {"status": 200, "serverDate": "2026-11-06T12:00:00.000Z", "requestStartedAt": "2026-11-06T12:00:00.000Z",
            "responseEndedAt": "2026-11-06T12:00:00.100Z", "elapsedMs": 100, "requestId": str(uuid.uuid4())}
        capture = {"controlledUser": {"token": "private.jwt.bytes", "iat": 1, "exp": 301, "jti": str(uuid.uuid4()), "baseline": observation},
            "playback": {"requestUrl": "https://stream.mux.com/id.m3u8?token=private", "playbackId": "id", "exp": 601,
                "courseAuthorization": observation, "initialProviderAccess": observation},
            "labels": {"userIssuer": "operator-controlled-source-signed-course-learner"}}
        public = timing._capture_public(capture)
        serialized = json.dumps(public)
        for private in ("private.jwt.bytes", "stream.mux.com", "requestUrl", "playbackId", "jti"):
            self.assertNotIn(private, serialized)

    def test_wait_rechecks_scope_without_one_long_sleep_or_clock_mutation(self):
        class Scope:
            checks = 0
            def verify(self): self.checks += 1
        scope = Scope()
        values = iter((0.0, 0.0, 0.4, 0.4, 0.8, 0.8, 1.1))
        sleeps = []
        with patch.object(timing.time, "time", side_effect=lambda: next(values)), patch.object(timing.time, "sleep", side_effect=sleeps.append):
            timing._wait_until(scope, 1000)
        self.assertGreaterEqual(scope.checks, 3)
        self.assertTrue(sleeps)
        self.assertTrue(all(0 < value <= 1 for value in sleeps))

    def test_malformed_host_packets_return_one_fixed_nonsecret_refusal(self):
        entry = Path(timing.__file__)
        for raw in (b"private-token-not-json", json.dumps({"version": 1, "operation": "shell", "token": "private-token"}).encode(), b"x" * 1_048_577):
            result = subprocess.run([sys.executable, "-I", "-B", str(entry)], input=raw, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"")
            self.assertNotIn(b"private-token", result.stdout)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["status"], "P2_S13_AUTHORITY_TIMING_REFUSED")
            self.assertFalse(receipt["credentialHashesOutput"])

    def test_live_finalize_refuses_until_source_authoritative_artifact_adapters_are_wired(self):
        self.assertFalse(timing.AUTHORITY_ADAPTERS_READY)
        source = self.root / self.identity["sources"]["frontend"]
        with patch.object(timing, "ROOT", self.root), patch.object(timing, "OPERATOR_ROOT", self.root), \
                self.assertRaises(timing.AuthorityTimingFailure) as caught:
            timing.execute(self.root, self.root, self.reviewed, source, "finalize",
                {name: {"forged": True} for name in ("pending", "browser", "lifecycle", "s12")})
        self.assertEqual(caught.exception.public_receipt["check"], "source-authoritative-artifact-adapters-required")


class RetainedTimingFinalizerTests(unittest.TestCase):
    """Actual fixed readers, POSIX lease and pure Node qualifier; no Docker/provider."""

    @staticmethod
    def utc(seconds):
        return datetime.fromtimestamp(1_800_000_000 + seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def http(self, status, seconds):
        return {"status": status, "serverDate": self.utc(seconds), "requestStartedAt": self.utc(seconds),
            "responseEndedAt": self.utc(seconds + 0.1), "elapsedMs": 100, "requestId": None}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="owned-s13-finalizer-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        commit = "1" * 40
        self.source = root / "operators" / commit
        files = (timing.TIMING, timing.IDENTITY, worker.DENIAL, "ops/platform/p2-lifecycle-browser-recorder.mjs",
            "ops/platform/p2-lifecycle-pending-probe.mjs", "ops/platform/p2-lifecycle-suspension-evidence.mjs",
            "ops/platform/host/p2_lifecycle_suspension_evidence.py", "ops/platform/p2-lifecycle-worker-evidence.mjs",
            "ops/platform/host/p2_lifecycle_worker_evidence.py", *persistence.PROGRAM_FILES[:2])
        actual = Path(timing.__file__).resolve().parents[3]
        for name in files:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / name, path)
        source_files = {name: timing._hash((self.source / name).read_bytes()) for name in files}
        browser_program = timing._hash((self.source / files[3]).read_bytes() + suspension.BROWSER_LAUNCHER)
        target = {"host": "owned.invalid", "port": 5432, "database": "owned", "user": "owned_migrate",
            "serverMajor": 18, "approvedPendingTags": []}
        phase2 = "sha256:" + "2" * 64
        job = {"environment": "staging", "releaseId": "owned-release", "sourceCommit": commit, "contractPhase": "p2",
            "phase2ContractManifestSha256": phase2,
            **{name: "2" * 64 for name in ("migrationImageDigest", "sqlArtifactSha256", "contractManifestSha256",
                "schemaBaselineSha256")}}
        certification_plan = {"certificationActionId": "owned-worker", "candidateSha256": "3" * 64,
            "planSha256": "a" * 64, "targetSha256": frontend_target_sha256(target)}
        frontend_receipt = {**job, "target": {key: target[key] for key in ("host", "port", "database", "user", "serverMajor")},
            **certification_plan, "status": "P2_CERTIFICATION_DATABASE_CURRENT", "schemaVerified": True, "sqlReplayed": False,
            "oldLoginsDenied": True, "oldRoleSessions": 0, "runtimeRoleVerified": True, "trafficAuthorized": False, "after": [{"owned": "lineage"}]}
        self.selected = {"environment": "staging", "contractPhase": "p2", "releaseId": "owned-release",
            "phase2ContractManifestSha256": phase2, "sources": {"frontend": {"commit": commit}}}
        self.jobs = {"frontend": {"job": {**job, "target": target}}}
        lock = root / "release.lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        machine = root / "machine-id"
        machine.write_text("owned-machine")
        self.configuration = root / "configuration"
        self.configuration.mkdir(mode=0o700)
        root.chmod(0o700)

        # Project only host placement/root identity; the descriptors and bytes
        # opened by both retained readers are real owned fixture files.
        class OwnedPath(type(Path())):
            def lstat(self):
                actual = super().lstat()
                return SimpleNamespace(st_uid=0, st_mode=actual.st_mode, st_size=actual.st_size)
        class OwnedHostOs:
            def __getattr__(self, name):
                return getattr(os, name)
            def geteuid(self):
                return 0
            def fstat(self, descriptor):
                actual = os.fstat(descriptor)
                return SimpleNamespace(st_uid=0, st_mode=actual.st_mode, st_size=actual.st_size)
        def path(value):
            return {"/etc/machine-id": machine, "/opt/lash-her/operators": self.source.parent}.get(value, Path(value))
        gateway = {"service": "gateway", "containerId": "4" * 64}
        reviewed_sources = {key: commit for key in ("frontend", "course", "community")}
        reviewed_targets = {key: {"targetSha256": "5" * 64} for key in reviewed_sources}
        self.reviewed = {"plan": {"hostMachineId": "owned-machine", "candidateSha256": "3" * 64, "configurationSha256": "6" * 64,
            "sources": reviewed_sources, "targets": reviewed_targets}, "operatorSourceFiles": source_files,
            "programSha256": timing._hash(persistence.private_program(self.source)),
            "containers": [gateway]}
        resources = {key: str(uuid.UUID(int=index, version=4)) for index, key in enumerate(("userId", "courseId", "lessonId"), 1)}
        self.suspension_plan = {"actionId": "owned-suspension", "sourceCommit": commit, "operatorSourceCommit": commit,
            "candidateSha256": "3" * 64, "candidateObjectSha256": suspension.digest(suspension.canonical(self.selected)),
            "configurationSha256": "6" * 64, "targetSha256": frontend_target_sha256(target), "hostMachineId": "owned-machine",
            "browserProgramSha256": browser_program, "pendingProgramSha256": source_files[files[4]], "parentProgramSha256": source_files[files[5]],
            "hostProgramSha256": source_files[files[6]], "deploymentId": "owned-deployment", "deploymentUrl": "https://owned.invalid",
            "browserOrigin": suspension.BROWSER_ORIGIN, "resourceBindingSha256": timing._hash(timing._canonical(resources))}
        self.suspension_dir = root / "p2-suspension-owned-suspension"
        self.worker_dir = root / "p2-worker-owned-worker"
        self.suspension_dir.mkdir(mode=0o700)
        self.worker_dir.mkdir(mode=0o700)
        binding = suspension.digest(suspension.canonical(self.suspension_plan))
        uid = lambda n: str(uuid.UUID(int=n, version=4))
        command = {"version": 1, "commandId": uid(4), "userId": resources["userId"], "accountVersion": 1,
            "action": "suspend", "issuedAt": self.utc(10)}
        self.browser = {"version": 1, "status": "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED", "environment": "staging",
            **resources, **{key: self.suspension_plan[key] for key in ("actionId", "sourceCommit", "deploymentId", "deploymentUrl", "browserOrigin")},
            "bindingSha256": binding, "contextsIsolated": True, "playbackRemovalAfterSuspensionMs": 559_000,
            **{key: False for key in ("sessionsFabricated", "clockChanged", "requestsIntercepted", "tokensRetained", "rawHarRetained",
                "nativeInvocationQualified", "releaseAccepted")}, "events": []}
        for kind, seconds, fields in (
                ("ordinary-playback-authorized", 0, {"httpStatus": 200, "privateNoStore": True, "lifetimeMs": 600_000,
                    "expiresAt": self.utc(600), "thumbnailExpiresAt": self.utc(600)}),
                ("player-present", 1, {"muxPlayerCount": 1}),
                ("ordinary-owner-suspension-accepted", 12, {"commandId": command["commandId"], "requestId": uid(5), "accountVersion": 1,
                    "action": "suspend", "status": "pending"}),
                ("ordinary-renewal-denied", 570, {"httpStatus": 401, "requestId": uid(6), "privateNoStore": True, "errorCode": "sign_in_required"}),
                ("player-removed", 571, {"muxPlayerCount": 0, "sessionEndedAlert": True})):
            self.browser["events"].append({"type": kind, "observedAt": self.utc(seconds), "elapsedMs": seconds * 1000, **fields})
        pending_rows = [{"receiver": service, "status": "pending", "attempts": 0, "lease_id": None, "lease_until": None,
            "acknowledged_at": None} for service in ("course", "community")]
        pending = {"version": 1, "status": "P2_LIFECYCLE_SUSPENSION_PENDING_OBSERVED", "command": command,
            "requestedByAdminId": uid(7), "uiRequestId": uid(5), "uiResponseObservedAt": self.utc(12),
            "controlledDenialObservedAt": self.utc(332.1), "observedAt": self.utc(604), "frontendStatus": "suspended", "sessions": 0,
            "deliveries": pending_rows, "laterCommandCount": 0, "pendingOrDeliveringCount": 2, "readOnly": True, "workerInvoked": False}
        self.pending = {"version": 1, "status": "P2_SUSPENSION_PENDING_SOURCE_RETAINED", "planSha256": binding,
            **{key: self.suspension_plan[key] for key in ("candidateSha256", "configurationSha256", "sourceCommit", "targetSha256", "pendingProgramSha256")},
            "pending": pending, "workerInvoked": False}
        self.mux = {"lastAccepted": self.http(206, 601), "firstDenied": self.http(403, 602), "pollResolutionMs": 2000}
        self.capture = {"controlledUser": {"iat": 1_800_000_002, "exp": 1_800_000_302, "baseline": self.http(200, 2)},
            "playback": {"exp": 1_800_000_602, "courseAuthorization": self.http(200, 2), "initialProviderAccess": self.http(200, 3)},
            "labels": {"userIssuer": "operator-controlled-source-signed-course-learner", "frontendUserJwtCaptured": False,
                "playbackIssuer": "actual-course-mux-signer", "authorizationQuotaConsumed": True, "domainStateEffect": "video-asset-last-token-expires-at-only"}}
        self.put_public_capture(binding)
        suspension.private_record(self.suspension_dir, "p2-lifecycle-browser-source.json", self.browser)
        suspension.private_record(self.suspension_dir, "controlled-user-window.json",
            {"lastAccepted": self.http(200, 331), "firstDenied": self.http(401, 332), "pollResolutionMs": 2000})
        suspension.private_record(self.suspension_dir, "controlled-mux-window.json", self.mux)
        pending_sha = suspension.private_record(self.suspension_dir, "p2-lifecycle-suspension-pending.json", self.pending)["recordSha256"]
        self.worker_plan = {**{key: self.suspension_plan[key] for key in ("candidateSha256", "candidateObjectSha256", "sourceCommit", "configurationSha256", "targetSha256")},
            "actionId": "owned-worker", "profile": "direct-known-suspension-v1", "pendingRecordSha256": pending_sha,
            "suspensionPlanSha256": binding, "canonicalCommandSha256": suspension.digest(suspension.canonical(command)),
            "sourceProgramSha256": source_files[files[7]], "hostProgramSha256": source_files[files[8]],
            "denialProgramSha256": timing._hash(worker.denial_program(self.source))}
        canonical_digest = self.worker_plan["canonicalCommandSha256"]
        worker_binding = suspension.digest(suspension.canonical(self.worker_plan))
        self.scope = P2CertificationScope(fd, lock, lambda: None, frontend_receipt, "3" * 64, release=self.selected, jobs=self.jobs,
            certification_plan={**certification_plan, "mode": "direct-worker", "workerPlanSha256": worker_binding})
        witness = {"command": {**{key: command[key] for key in ("commandId", "accountVersion", "action", "issuedAt")}, "canonicalSha256": canonical_digest},
            "candidateSha256": "3" * 64, "configurationSha256": "6" * 64,
            "userId": resources["userId"], "sources": reviewed_sources, "targetSha256": {key: "5" * 64 for key in reviewed_sources},
            "frontend": {"status": "suspended", "latestCommandId": uid(4), "laterCommandCount": 0, "pendingOrDeliveringCount": 0, "deliveries": []},
            "receivers": {}}
        denials = {}
        for service in ("course", "community"):
            witness["frontend"]["deliveries"].append({"receiver": service, "status": "acknowledged", "attempts": 1,
                "leaseId": None, "leaseUntil": None, "acknowledgedAt": self.utc(607)})
            witness["receivers"][service] = {"status": "suspended", "latestCommandId": uid(4), "accountVersion": 1,
                "knownCommand": {"id": uid(4), "version": 1, "action": "suspend", "canonicalDigest": canonical_digest, "acceptedAt": self.utc(606)}}
            denials[service] = {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED", "bindingSha256": worker_binding,
                "service": service, "evidenceClass": "actual-protected-course-http" if service == "course" else "deployed-private-community-account-access-guard",
                "httpStatus": 403 if service == "course" else None, "denialStatusCode": 403, "observedAt": self.utc(608),
                "freshCurrentToken": True, "accountRestrictionVerified": True, "tokenBytesOutput": False,
                "actualRepositoryRead": True, "actualGuardInvoked": True, "readOnlyDatabase": True}
        lifecycle = {"version": 1, "status": "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED", "profile": "lifecycle-account-v1",
            "candidateSha256": "3" * 64, "configurationSha256": "6" * 64,
            "sourceSha256": timing._hash(timing._canonical(witness["sources"])), "targetSha256": timing._hash(timing._canonical(witness["targetSha256"])),
            "witnessSha256": timing._hash(timing._canonical(witness)), "commandCount": 1, "pendingOrDeliveringCount": 0, "receiverAcknowledgedCount": 2,
            "rowCounts": {"frontend": 5, "course": 3, "community": 3}, "readOnly": True, "providerTouched": False, "releaseAccepted": False}
        witness_sha = worker.write_record(self.worker_dir, "lifecycle-account.json", {"version": 1, "stage": "lifecycle-account",
            "subjectBindingSha256": "b" * 64, "contextSha256": persistence._context_binding(self.reviewed["plan"]),
            "witness": witness, "privateEvidence": None, "receipt": lifecycle, "priorRecordSha256": None})
        joined = {**{key: self.worker_plan[key] for key in ("candidateSha256", "configurationSha256", "sourceCommit", "targetSha256", "pendingRecordSha256")},
            "version": 1, "status": "P2_DIRECT_LIFECYCLE_WORKER_JOINED", "bindingSha256": worker_binding,
            "commandId": uid(4), "accountVersion": 1, "action": "suspend", "workerInvokedAt": self.utc(605),
            "invocationClass": "direct-source-authenticated-cron", "nativeScheduleEnabled": False, "nativeInvocationQualified": False,
            "invocation": {"status": "P2_DIRECT_WORKER_HTTP_OBSERVED", "httpStatus": 200, "operationId": uid(8), "workerInvokedAt": self.utc(605),
                "bindingSha256": worker_binding, "nativeInvocationQualified": False}, "lifecyclePrivateRecordSha256": witness_sha,
            "receiverDenials": denials, "receiverDeniedCount": 2, "receiverDeniedHttpCount": 1, "frontendActive": 0, "frontendUncertain": 0,
            "releaseAccepted": False}
        self.worker_sha = worker.write_record(self.worker_dir, "joined-worker.json",
            {"version": 1, "status": "P2_DIRECT_WORKER_MACHINE_ARTIFACT", "planSha256": worker_binding, "record": joined,
             **{key: self.worker_plan[key] for key in ("sourceProgramSha256", "hostProgramSha256")}})
        self.calls = []
        self.after_child = lambda: None
        node = shutil.which("node")
        self.assertIsNotNone(node, "The repository's Node toolchain is required for the fixed qualifier")
        run = self.scope.run
        def owned_child(args, **options):
            self.calls.append(args)
            self.assertEqual(args[:10], ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
                "--env", "DOTENV_CONFIG_QUIET=true", gateway["containerId"]])
            result = run([node, *args[11:]], **options)
            self.after_child()
            return result
        patchers = [patch.object(timing, "os", OwnedHostOs()), patch.object(suspension, "os", OwnedHostOs()),
            patch.object(worker, "os", OwnedHostOs()), patch.object(suspension, "Path", path),
            patch.object(suspension, "ROOT", OwnedPath(root)), patch.object(worker, "ROOT", OwnedPath(root)),
            patch.object(suspension, "LOCK", lock), patch.object(persistence, "_reviewed", side_effect=lambda value: value),
            patch.object(persistence, "_join_selected"), patch.object(identity, "source_closure", return_value=source_files),
            patch.object(identity, "_configuration_hash", return_value="6" * 64), patch.object(identity, "_one_container"),
            patch.object(timing.runtime, "check_containers", return_value=[gateway]), patch.object(self.scope, "run", side_effect=owned_child)]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def put_public_capture(self, binding):
        (self.suspension_dir / "controlled-capture-public.json").unlink(missing_ok=True)
        suspension.private_record(self.suspension_dir, "controlled-capture-public.json", {"version": 1, "bindingSha256": binding,
            "capturePublic": self.capture, "controlledCaptureMetadataSha256": timing._hash(timing._canonical(self.capture)),
            "tokenBytesOutput": False, "credentialHashesOutput": False})

    def finalize(self, scope=None, expected_sha=None):
        return timing.finalize_retained_authority_timing(self.scope if scope is None else scope, self.selected, self.jobs,
            self.configuration, self.source, self.worker_plan, self.suspension_plan, self.reviewed,
            self.worker_sha if expected_sha is None else expected_sha)

    def test_real_retained_readers_and_fixed_qualifier_preserve_pre_worker_mux_order(self):
        result = self.finalize()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result["status"], "P2_S13_AUTHORITY_TIMING_QUALIFIED")
        self.assertEqual(result["s12ReceiptSha256"], self.worker_sha)
        self.assertLess(result["muxFirstDeniedAt"], result["workerInvokedAt"])
        self.assertTrue(result["muxExpiryObservedBeforeWorker"])
        self.assertFalse(result["postAckMuxAccessObserved"])
        self.assertFalse(result["stalledRenewalQualified"])
        self.assertFalse(result["s12CaseQualified"])
        self.assertFalse(result["releaseAccepted"])
        self.assertEqual(result["receiverEvidence"]["course"]["httpStatus"], 403)
        self.assertIsNone(result["receiverEvidence"]["community"]["httpStatus"])

    def test_claimed_digests_and_json_cannot_replace_fixed_files_or_the_live_scope(self):
        with self.assertRaisesRegex(ValueError, "ACTUAL_PARENT_REQUIRED"):
            self.finalize(scope={"held": True})
        ordinary = P2ReleaseScope(self.scope.descriptor, self.scope.path, lambda: None, self.scope.receipt)
        with self.assertRaisesRegex(ValueError, "ACTUAL_PARENT_REQUIRED"):
            self.finalize(scope=ordinary)
        for change in ({"mode": "native-window"}, {"certificationActionId": "foreign"}, {"workerPlanSha256": "0" * 64}):
            parent_plan = {**self.scope.certification_plan, **change}
            foreign = P2CertificationScope(self.scope.descriptor, self.scope.path, lambda: None,
                {**self.scope.receipt, "certificationActionId": parent_plan["certificationActionId"]}, "3" * 64,
                release=self.selected, jobs=self.jobs, certification_plan=parent_plan)
            with self.assertRaisesRegex(ValueError, "DIRECT_WORKER_PARENT_BINDING_REQUIRED"):
                self.finalize(scope=foreign)
        with self.assertRaisesRegex(ValueError, "RETAINED_BYTES_CHANGED"):
            self.finalize(expected_sha="f" * 64)
        path = self.suspension_dir / "controlled-mux-window.json"
        path.unlink()
        path.symlink_to(self.suspension_dir / "controlled-user-window.json")
        with self.assertRaises(OSError):
            self.finalize()
        self.assertEqual(self.calls, [])

    def test_post_worker_mux_observation_and_secret_bearing_public_capture_refuse(self):
        path = self.suspension_dir / "controlled-mux-window.json"
        path.unlink()
        suspension.private_record(self.suspension_dir, path.name, {**self.mux, "firstDenied": self.http(403, 609)})
        with self.assertRaisesRegex(ValueError, "PRE_WORKER_MUX_EXPIRY_REQUIRED"):
            self.finalize()
        path.unlink()
        suspension.private_record(self.suspension_dir, path.name, self.mux)
        self.capture["labels"]["token"] = "private-canary"
        self.put_public_capture(self.pending["planSha256"])
        with self.assertRaisesRegex(ValueError, "RETAINED_CAPTURE_PUBLIC_REQUIRED") as caught:
            self.finalize()
        self.assertNotIn("private-canary", str(caught.exception))
        self.assertEqual(self.calls, [])

    def test_changed_retained_input_after_child_cannot_finalize(self):
        path = self.suspension_dir / "controlled-mux-window.json"
        def replace():
            path.unlink()
            suspension.private_record(self.suspension_dir, path.name, {**self.mux, "pollResolutionMs": 1500})
        self.after_child = replace
        with self.assertRaisesRegex(ValueError, "RETAINED_EVIDENCE_CHANGED"):
            self.finalize()


class AuthorityTimingScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-p2-s13-scope-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.lock = self.root / "release.lock"
        self.identifier = "1" * 64
        self.image = "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "2" * 64
        self.selected = {"environment": "staging", "artifacts": {key: {"image": self.image} for key in
            ("gateway", "courseRuntime", "courseMigration", "communityRuntime", "communityMigration")}}
        self.reviewed = {"containers": [{"service": "gateway", "containerId": self.identifier, "image": self.image}]}
        self.program = b"// exact s13 program"
        self.patchers = [patch.object(identity_scope, "LOCK", self.lock), patch.object(identity_scope.sys, "platform", "linux"),
            patch.object(identity_scope.os, "geteuid", return_value=0)]
        for patcher in self.patchers:
            patcher.start(); self.addCleanup(patcher.stop)
        self.scope = timing_scope.CurrentAuthorityTimingScope(self.selected, self.reviewed, self.root, self.program, lambda: None)
        self.addCleanup(lambda: None if self.scope.closed else self.scope.close())

    def args(self):
        return ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
            self.identifier, "node", "--input-type=module", "--eval", self.program.decode()]

    def test_scope_allows_only_fixed_s13_modes_in_gateway_and_keeps_real_flock(self):
        for mode in ("s13-capture", "s13-user-observe", "s13-mux-observe"):
            self.scope._allowed(self.args(), json.dumps({"mode": mode, "environment": "staging"}).encode(), timing_scope.runtime.SAFE_ENV)
        for payload in ({"mode": "shell", "environment": "staging"}, {"mode": "s13-qualify", "environment": "staging"},
                {"mode": "s13-capture", "environment": "production"}):
            with self.assertRaises(ValueError):
                self.scope._allowed(self.args(), json.dumps(payload).encode(), timing_scope.runtime.SAFE_ENV)
        with self.lock.open("a+") as contender:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_scope_refuses_changed_program_container_command_environment_and_oversized_input(self):
        valid = json.dumps({"mode": "s13-capture", "environment": "staging"}).encode()
        examples = [(self.args()[:-1] + ["arbitrary"], valid, timing_scope.runtime.SAFE_ENV),
            (self.args(), valid, {"PATH": "/tmp"}), (self.args(), b"x" * 65_537, timing_scope.runtime.SAFE_ENV)]
        for args, payload, environment in examples:
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                self.scope._allowed(args, payload, environment)


if __name__ == "__main__":
    unittest.main()
