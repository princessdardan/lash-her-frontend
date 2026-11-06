"""Owned controller/scope tests; no live provider or staging call."""
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

import p2_identity_negative_probe as identity
import p2_identity_probe_scope as identity_scope
import p2_lifecycle_authority_timing as timing
import p2_lifecycle_authority_timing_scope as timing_scope


class AuthorityTimingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-p2-s13-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = Path(timing.__file__).resolve().parents[3]
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
        with self.assertRaises(timing.AuthorityTimingFailure) as caught:
            timing._finalize(None, None, self.reviewed, self.source, {})
        self.assertEqual(caught.exception.public_receipt["check"], "source-authoritative-artifact-adapters-required")


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
