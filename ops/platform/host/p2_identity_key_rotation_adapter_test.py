import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import p2_identity_key_rotation_adapter as rotation
import release as runtime


class ConfigurationFixture:
    def __init__(self, root):
        self.root = Path(root)
        self.old = {prefix: f"old-{index}-" + "a" * 40 for index, prefix in enumerate(rotation.PROFILE_PREFIXES)}
        self.new = {prefix: f"new-{index}-" + "b" * 40 for index, prefix in enumerate(rotation.PROFILE_PREFIXES)}
        for phase in rotation.PHASES:
            directory = self.root / phase
            directory.mkdir(mode=0o700)
            for relative in (*runtime.CONFIG_FILES, *runtime.TLS_FILES, "runtime.json"):
                path = directory / relative; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                path.write_bytes((relative + "\n").encode()); path.chmod(0o600)
            for service in runtime.ENV_FILES:
                values = {"NODE_ENV": "production", "DATABASE_TARGET": "staging", "STAGING_DATABASE_URL": "postgresql://runtime:password@db/course?sslmode=verify-full"}
                prefixes = {"course-api": rotation.PROFILE_PREFIXES[:2], "community-api": rotation.PROFILE_PREFIXES[2:]}.get(service, ())
                values.update(self.profile_values(prefixes, phase))
                self.write_env(directory / f"{service}.env", values)
            frontend = {"APP_ENV": "staging", "AUTH_SECRET": "base-auth-" + "c" * 40,
                        **self.profile_values(rotation.PROFILE_PREFIXES, phase)}
            self.write_env(directory / "frontend.env", frontend)
        self.private_hashes = {phase: rotation._phase_hash(self.root / phase) for phase in rotation.PHASES}
        self.hashes = {phase: hashlib.sha256(f"public-record-{phase}".encode()).hexdigest() for phase in rotation.PHASES}

    def profile_values(self, prefixes, phase):
        values = {}
        for prefix in prefixes:
            values[f"{prefix}_JWT_CURRENT_SECRET"] = self.old[prefix] if phase == "baseline" else self.new[prefix]
            if phase == "overlap":
                values[f"{prefix}_JWT_PREVIOUS_SECRET"] = self.old[prefix]
        return values

    @staticmethod
    def write_env(path, values):
        path.write_text("".join(f"{key}={value}\n" for key, value in sorted(values.items())))
        path.chmod(0o600)


class RotationConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.fixture = ConfigurationFixture(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_three_configs_allow_only_exact_profile_transitions(self):
        selected = rotation.RotationConfigurationSet(self.temp.name, self.fixture.hashes, self.fixture.private_hashes, fixture=True)
        self.assertEqual(selected.hashes, self.fixture.hashes)
        self.assertNotIn("COURSE_LEARNER_JWT_PREVIOUS_SECRET", selected.frontend["current-only"])

    def test_nonprofile_drift_probe_overlay_and_wrong_previous_refuse(self):
        cases = (
            ("overlap/frontend.env", "UNRELATED=value\n"),
            ("overlap/frontend.env", "LASH_RELEASE_PROBE_SECRET=caller-value\n"),
            ("overlap/frontend.env", "COURSE_LEARNER_JWT_PREVIOUS_SECRET=wrong-value-long-enough-aaaaaaaa\n"),
            ("overlap/course-api.env", "COMMUNITY_MEMBER_JWT_CURRENT_SECRET=wrong-scope-value-aaaaaaaaaaaaaaaa\n"),
        )
        for relative, appended in cases:
            with self.subTest(relative=relative, appended=appended.split("=", 1)[0]):
                import shutil
                with tempfile.TemporaryDirectory() as copied:
                    copy_root = Path(copied) / "configs"
                    shutil.copytree(self.temp.name, copy_root)
                    path = copy_root / relative; path.write_text(path.read_text() + appended); path.chmod(0o600)
                    private_hashes = {phase: rotation._phase_hash(copy_root / phase) for phase in rotation.PHASES}
                    with self.assertRaises(ValueError):
                        rotation.RotationConfigurationSet(copy_root, self.fixture.hashes, private_hashes, fixture=True)

    def test_configuration_bytes_cannot_change_after_reviewed_set_is_constructed(self):
        selected = rotation.RotationConfigurationSet(self.temp.name, self.fixture.hashes,
                                                     self.fixture.private_hashes, fixture=True)
        path = Path(self.temp.name) / "overlap" / "course-api.env"
        path.write_text(path.read_text() + "POST_REVIEW_DRIFT=refused\n"); path.chmod(0o600)
        with self.assertRaises(ValueError):
            selected.directory("overlap")


class Scope:
    action_id = "p2-key-rotation-owned"
    def __init__(self): self.calls = []; self.verifications = 0
    def verify(self): self.verifications += 1
    def run(self, args, **options):
        self.calls.append((args, options))
        return types.SimpleNamespace(stdout="")


class AdapterTest(unittest.TestCase):
    def test_frontend_inventory_never_requests_secret_values(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        calls = []
        adapter.selected = {}
        adapter.client = types.SimpleNamespace(request=lambda method, path: (
            calls.append((method, path)) or {"envs": [
                {"key": "COURSE_LEARNER_JWT_CURRENT_SECRET", "id": "env_current", "type": "sensitive",
                 "target": ["production"], "gitBranch": None, "customEnvironmentIds": [], "value": "opaque"},
                {"key": "IGNORED_PREVIEW", "id": "env_preview", "type": "plain",
                 "target": ["preview"], "gitBranch": None, "customEnvironmentIds": []}]}) )
        with patch.object(rotation.vercel, "release_identity", return_value=("staging", "project", "a" * 40)):
            project, rows = adapter._frontend_environment()
        self.assertEqual(project, "project")
        self.assertEqual(set(rows), {"COURSE_LEARNER_JWT_CURRENT_SECRET"})
        self.assertNotIn("value", rows["COURSE_LEARNER_JWT_CURRENT_SECRET"])
        self.assertEqual(calls, [("GET", "/v10/projects/project/env?decrypt=false")])

    def test_frontend_overlap_writes_every_fixed_secret_and_retains_ack_without_secret_readback(self):
        output = Path(tempfile.mkdtemp()); os.chmod(output, 0o700)
        attempt = output / "attempt"; attempt.mkdir(mode=0o700)
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.output = output; adapter.scope = types.SimpleNamespace(action_id="p2-key-rotation-owned")
        old = {f"{prefix}_JWT_CURRENT_SECRET": f"old-{index}-" + "a" * 40
               for index, prefix in enumerate(rotation.PROFILE_PREFIXES)}
        overlap = {f"{prefix}_JWT_CURRENT_SECRET": f"new-{index}-" + "b" * 40
                   for index, prefix in enumerate(rotation.PROFILE_PREFIXES)}
        overlap.update({f"{prefix}_JWT_PREVIOUS_SECRET": old[f"{prefix}_JWT_CURRENT_SECRET"]
                        for prefix in rotation.PROFILE_PREFIXES})
        adapter.configurations = types.SimpleNamespace(frontend={"baseline": {"APP_ENV": "staging", **old},
            "overlap": {"APP_ENV": "staging", **overlap}}, hashes={"overlap": "a" * 64}, directory=lambda _phase: output)
        def metadata(values):
            return {"APP_ENV": {"id": "env_app", "type": "plain", "target": ["production"], "updatedAt": 1},
                    **{key: {"id": "env_" + str(index), "type": "sensitive", "target": ["production"], "updatedAt": 1}
                       for index, key in enumerate(values)}}
        inventories = iter([("project", metadata(old)), ("project", metadata(overlap))])
        adapter._frontend_environment = lambda: next(inventories)
        calls = []
        adapter.client = types.SimpleNamespace(request=lambda method, path, body: (
            calls.append((method, path, body["key"])) or {"failed": [], "created": {"key": body["key"],
                "target": ["production"], "type": "sensitive", "gitBranch": None, "customEnvironmentIds": []}}))
        adapter._configure_frontend("overlap", attempt)
        self.assertEqual(len(calls), 8)
        self.assertTrue(all(method == "POST" and "?upsert=true" in path for method, path, _key in calls))
        receipt = json.loads((attempt / "rotation-frontend-configuration.json").read_text())
        self.assertFalse(receipt["secretValuesReadBack"])
        self.assertEqual(len(receipt["acknowledgements"]), 8)

    def test_capture_and_both_phase_observers_reuse_exact_retained_token_bytes(self):
        directory = Path(tempfile.mkdtemp()); os.chmod(directory, 0o700)
        snapshot = directory / "snapshot"; (snapshot / "tls").mkdir(parents=True)
        (snapshot / "tls/ca.pem").write_bytes(b"owned-ca")
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope = types.SimpleNamespace(action_id="p2-key-rotation-owned", binding_sha256="a" * 64)
        adapter.output = directory
        values = {}
        for index, prefix in enumerate(rotation.PROFILE_PREFIXES):
            values[f"{prefix}_JWT_CURRENT_SECRET"] = f"new-{index}-" + "b" * 40
            values[f"{prefix}_JWT_PREVIOUS_SECRET"] = f"old-{index}-" + "a" * 40
        course = {**values, "DATABASE_TARGET": "staging"}
        community = {**values, "DATABASE_TARGET": "staging"}
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "b" * 64, "current-only": "c" * 64},
            frontend={"overlap": values}, api={"overlap": {"course-api": course, "community-api": community},
            "current-only": {"course-api": course, "community-api": community}}, directory=lambda _phase: directory)
        adapter._snapshot = lambda _phase: snapshot
        captured = {}
        def child(_phase, _service, payload):
            profile = payload["profile"]
            if payload["mode"] == "rotation-capture":
                old, new = "old.token." + str(len(captured)), "new.token." + str(len(captured))
                captured[profile] = (old, new)
                return {"status": "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", "bindingSha256": "a" * 64,
                    "profile": profile, "configurationSha256": "b" * 64, "privateCredentialBytes": True,
                    "commonTokenBytesOutput": False,
                    "oldToken": old, "newToken": new, "tokenIssuedAt": "2027-01-15T07:02:30.000Z",
                    "tokenExpiresAt": "2027-01-15T07:07:30.000Z"}
            self.assertEqual((payload["oldToken"], payload["newToken"]), captured[profile])
            return {"status": "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED", "profile": profile, "phase": payload["phase"],
                "bindingSha256": "a" * 64, "configurationSha256": payload["configurationSha256"],
                "retainedTokenContinuityVerified": True, "tokenBytesOutput": False,
                "oldTokenIssuedAt": payload["tokenIssuedAt"], "oldTokenExpiresAt": payload["tokenExpiresAt"],
                "observedAt": "2027-01-15T07:06:00.000Z", "releaseAccepted": False}
        adapter._private_child = child
        subjects = {profile: f"{index + 1}" * 8 + "-1111-4111-8111-111111111111" for index, profile in enumerate(
            ("community-admin", "community-member", "course-admin", "course-learner"))}
        # Normalize the first UUID group to exactly eight characters.
        subjects = {profile: value[:36] for profile, value in subjects.items()}
        captures = adapter.capture_tokens(subjects, "99999999-1111-4111-8111-111111111111", "a" * 64)
        self.assertEqual(len(captures), 4)
        self.assertEqual(len(adapter.observe_profiles("overlap", subjects, "99999999-1111-4111-8111-111111111111")), 4)
        self.assertEqual(len(adapter.observe_profiles("current-only", subjects, "99999999-1111-4111-8111-111111111111")), 4)

    def test_api_observer_passes_expected_secrets_only_over_stdin_and_checks_all_ten(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope, adapter.selected, adapter.jobs = Scope(), {}, {}
        adapter.configurations = types.SimpleNamespace(
            api={"overlap": {"course-api": {"COURSE_LEARNER_JWT_CURRENT_SECRET": "x" * 40},
                              "community-api": {"COMMUNITY_MEMBER_JWT_CURRENT_SECRET": "y" * 40}}},
            hashes={"overlap": "a" * 64})
        adapter._snapshot = lambda _phase: Path("/private/snapshot")
        containers = [{"service": service} for service in runtime.SERVICES]
        with patch.object(runtime, "compose_command", return_value=["docker", "compose"]), \
             patch.object(runtime, "runtime_environment", return_value={}), \
             patch.object(runtime, "check_containers", return_value=containers):
            observed = adapter.observe_api_configuration("overlap")
        self.assertEqual(observed["containers"], containers)
        self.assertEqual(len(adapter.scope.calls), 2)
        for args, options in adapter.scope.calls:
            self.assertNotIn("x" * 40, " ".join(args)); self.assertNotIn("y" * 40, " ".join(args))
            self.assertIn("_JWT_CURRENT_SECRET", options["input"])

    def test_api_recreation_is_one_registered_compose_mutation_without_sql_or_roles(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope, adapter.selected, adapter.jobs = Scope(), {}, {}
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "a" * 64}, directory=lambda _phase: Path("/private/snapshot"))
        adapter._snapshot = lambda _phase: Path("/private/snapshot")
        adapter.observe_api_configuration = lambda _phase: {"containers": [], "runtimeVerified": True}
        with patch.object(runtime, "preflight"), patch.object(runtime, "compose_command", return_value=["docker", "compose"]), \
             patch.object(runtime, "runtime_environment", return_value={}):
            result = adapter.recreate_apis("overlap")
        mutations = [call for call in adapter.scope.calls if "up" in call[0]]
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][0][-2:], ["course-api", "community-api"])
        self.assertFalse(result["sqlExecuted"]); self.assertFalse(result["rolesPrepared"]); self.assertFalse(result["loginChanged"])

    def test_frontend_rollout_calls_one_build_and_one_promotion(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope = Scope(); adapter.scope.binding_sha256 = "b" * 64; adapter.scope.candidate_sha256 = "c" * 64
        adapter.scope.source_commit = "a" * 40
        adapter.selected = {"releaseId": "release"}; adapter.client = object(); adapter.gateway_host = "gateway.example.com"
        adapter.output = Path(tempfile.mkdtemp()); os.chmod(adapter.output, 0o700)
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "a" * 64})
        adapter._configure_frontend = lambda _phase, _attempt: None
        adapter.frontend_signer_verifier = lambda phase, _release, _attempt, deployment: {
            "version": 1, "status": "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED", "phase": phase,
            "bindingSha256": "b" * 64, "candidateSha256": "c" * 64, "sourceCommit": "a" * 40,
            "configurationSha256": "a" * 64, "deploymentId": deployment["deploymentId"],
            "issuanceCutoffAt": "2027-01-15T07:00:00.000Z", "receiptSha256": "d" * 64,
            "profiles": [{"profile": "course-learner", "status": 200, "requestId": "owned-learner"},
                         {"profile": "course-admin", "status": 200, "requestId": "owned-admin"}],
            "evidenceClass": "actual-frontend-normal-course-signer-protected-http",
            "tokenBytesOutput": False, "releaseAccepted": False}
        adapter.observe_frontend_configuration = lambda _phase: {"deploymentId": "dpl_owned"}
        calls = []
        def promote(_client, selected, attempt, verify):
            calls.append("promote"); verify(selected, {"deploymentId": "dpl_owned"})
            return {"frontendDomainsPromoted": True, "deploymentId": "dpl_owned"}
        with patch.object(frontend_probe := rotation.frontend_probe, "prepare", side_effect=lambda *args, **kwargs: calls.append("prepare")), \
             patch.object(frontend_probe, "verify", return_value={"status": "FRONTEND_VERIFIED", "environment": "staging",
                 "projectId": "project", "sourceCommit": "a" * 40, "releaseId": "release", "deploymentId": "dpl_owned"}), \
             patch.object(rotation.vercel, "stage_frontend", side_effect=lambda *args: calls.append("stage")), \
             patch.object(rotation.vercel, "promote_frontend", side_effect=promote):
            result = adapter.rollout_frontend("overlap", {}, {})
        self.assertEqual(calls, ["prepare", "stage", "promote"])
        self.assertEqual(result["mutationCount"], 1)

    def test_missing_local_promotion_outcome_uses_read_only_provider_reconciliation(self):
        output = Path(tempfile.mkdtemp()); os.chmod(output, 0o700)
        attempt = output / "frontend-overlap"; attempt.mkdir(mode=0o700)
        for name, value in {
            "frontend-workload-outcome.json": {"status": "FRONTEND_VERIFIED", "deploymentId": "dpl_owned"},
            "rotation-frontend-signer.json": {"owned": True},
            "rotation-frontend-configuration.json": {"owned": True},
        }.items():
            (attempt / name).write_text(json.dumps(value)); (attempt / name).chmod(0o600)
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.output = output; adapter.selected = {}; adapter.client = object()
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "a" * 64})
        adapter._intent = lambda intent: intent
        adapter._validate_frontend_signer = lambda value, phase, deployment: True
        adapter._validate_frontend_configuration_receipt = lambda value, phase: value
        adapter.observe_frontend_configuration = lambda phase: {
            "configurationSha256": "a" * 64, "deploymentId": "dpl_owned"}
        observed = []
        with patch.object(rotation.vercel, "_staged_identity", return_value={"deploymentId": "dpl_owned"}), \
             patch.object(rotation.vercel, "observe_frontend_promotion", side_effect=lambda *_args: (
                 observed.append(True) or {"status": "FRONTEND_DOMAINS_PROMOTED", "frontendDomainsPromoted": True,
                                           "deploymentId": "dpl_owned"})):
            result = adapter.reconcile_mutation({"actionId": "p2-key-rotation-owned", "phase": "overlap", "kind": "frontend",
                "fromConfigurationSha256": "b" * 64, "toConfigurationSha256": "a" * 64})
        self.assertTrue(result["getFirstReconciled"])
        self.assertEqual(observed, [True])


if __name__ == "__main__":
    unittest.main()
