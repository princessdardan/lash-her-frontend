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
                payload = "shared-ca\n" if relative in ("tls/ca.pem", "tls/gateway/ca.pem") else relative + "\n"
                path.write_bytes(payload.encode()); path.chmod(0o600)
            for service in runtime.ENV_FILES:
                name = "course" if service.startswith("course-") else "community"
                values = {"NODE_ENV": "production", "DATABASE_TARGET": "staging",
                          "STAGING_DATABASE_URL": f"postgresql://{name}_runtime:password@db/{name}?sslmode=verify-full"}
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

    def test_actual_runtime_snapshot_uses_reviewed_runtime_subset_and_keeps_frontend_separate(self):
        selected = rotation.RotationConfigurationSet(self.temp.name, self.fixture.hashes,
                                                     self.fixture.private_hashes, fixture=True)
        output = Path(tempfile.mkdtemp()); os.chmod(output, 0o700)
        compose = output / "compose.yaml"; compose.write_text("services: {}\n"); compose.chmod(0o600)
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.configurations, adapter.output, adapter.compose_file = selected, output, compose
        adapter.selected = {"environment": "staging"}
        adapter.jobs = {name: {"job": {"target": {"host": "db", "port": 5432, "database": name,
            "user": f"{name}_owner"}, "runtimeRole": f"{name}_runtime"}} for name in ("course", "community")}
        snapshot = adapter._snapshot("overlap")
        self.assertFalse((snapshot / "frontend.env").exists())
        self.assertEqual(rotation._runtime_phase_hash(snapshot), selected.runtime_private_hashes["overlap"])


class Scope:
    action_id = "p2-key-rotation-owned"
    def __init__(self): self.calls = []; self.verifications = 0
    def verify(self): self.verifications += 1
    def run(self, args, **options):
        self.calls.append((args, options))
        return types.SimpleNamespace(stdout="")


class AdapterTest(unittest.TestCase):
    def test_browser_source_record_is_bound_to_current_deployment_and_retained_as_signer_receipt(self):
        output = Path(tempfile.mkdtemp()); os.chmod(output, 0o700)
        attempt = output / "frontend-overlap"; attempt.mkdir(mode=0o700)
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.output = output
        adapter.scope = types.SimpleNamespace(action_id="p2-key-rotation-owned", binding_sha256="b" * 64,
            candidate_sha256="c" * 64, source_commit="a" * 40, browser_program_sha256="f" * 64)
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "d" * 64})
        adapter.frontend_deployment = lambda _phase: {"phase": "overlap", "deploymentId": "dpl_owned",
            "deploymentUrl": "https://owned.vercel.app", "sourceCommit": "a" * 40,
            "configurationSha256": "d" * 64, "workloadReceiptSha256": "e" * 64}
        source = {"version": 1, "status": "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED", "environment": "staging",
            "actionId": "p2-key-rotation-owned", "bindingSha256": "b" * 64, "sourceCommit": "a" * 40,
            "candidateSha256": "c" * 64, "phase": "overlap", "configurationSha256": "d" * 64,
            "deploymentId": "dpl_owned", "deploymentUrl": "https://owned.vercel.app",
            "browserOrigin": "https://staging.lashher.com", "canonicalAliasReadbackSha256": "7" * 64,
            "canonicalProtectedWorkloadSha256": "6" * 64, "workloadReceiptSha256": "e" * 64,
            "browserProgramSha256": "f" * 64,
            "windowStartedAt": "2027-01-15T07:00:00.000Z", "windowCompletedAt": "2027-01-15T07:00:30.000Z",
            "evidenceClass": "actual-frontend-normal-course-signer-protected-http",
            "profiles": [{"profile": profile, "httpStatus": 200,
                "requestId": f"{index}" * 8 + "-1111-4111-8111-111111111111",
                "observedAt": f"2027-01-15T07:00:{10 + index:02d}.000Z", "privateNoStore": True,
                "courseBindingVerified": True} for index, profile in enumerate(("course-learner", "course-admin"), 1)],
            "contextsIsolated": True, "sessionsFabricated": False, "requestsIntercepted": False,
            "storageInjected": False, "tokenBytesOutput": False, "credentialHashesOutput": False,
            "releaseAccepted": False}
        signer = adapter.retain_frontend_signer("overlap", source)
        self.assertEqual(signer["issuanceCutoffAt"], source["windowCompletedAt"])
        self.assertEqual(signer["deploymentId"], "dpl_owned")
        self.assertEqual(adapter.observe_frontend_signer("overlap"), signer)
        with self.assertRaises(ValueError):
            adapter.retain_frontend_signer("overlap", {**source, "deploymentId": "dpl_other"})
        adapter.frontend_deployment = lambda _phase: (_ for _ in ()).throw(AssertionError("historical signer queried current provider"))
        self.assertEqual(adapter.retained_frontend_signer("overlap"), signer)

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
        adapter._configure_frontend("overlap", attempt, ("baseline",))
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
                return {"version": 1, "environment": "staging", "releaseAccepted": False,
                    "status": "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", "bindingSha256": "a" * 64,
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
        course_id = "99999999-1111-4111-8111-111111111111"
        metadata = adapter.capture_tokens(subjects, course_id, "a" * 64)
        self.assertEqual(metadata, [{"status": rotation.CAPTURE_STATUS, "profile": profile,
            "tokenIssuedAt": "2027-01-15T07:02:30.000Z", "tokenExpiresAt": "2027-01-15T07:07:30.000Z"}
            for profile in rotation.CAPTURE_PROFILES])
        record = directory / rotation.CAPTURE_RECORD
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        original = record.read_bytes()
        retained = json.loads(original)["captures"]
        self.assertEqual({row["profile"]: (row["oldToken"], row["newToken"]) for row in retained}, captured)
        self.assertEqual(adapter.capture_tokens(subjects, course_id, "a" * 64), metadata)
        self.assertEqual(record.read_bytes(), original)
        self.assertEqual(len(adapter.observe_profiles("overlap", subjects, course_id)), 4)
        self.assertEqual(len(adapter.observe_profiles("current-only", subjects, course_id)), 4)
        record.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "ROTATION_PRIVATE_CAPTURE_RECORD_REQUIRED"):
            adapter.capture_tokens(subjects, course_id, "a" * 64)
        record.chmod(0o600)
        retained[0]["tokenExpiresAt"] = "2027-01-15T07:07:31.000Z"
        record.write_text(json.dumps({**json.loads(original), "captures": retained}))
        with self.assertRaisesRegex(ValueError, "ROTATION_PRIVATE_CAPTURE_REFUSED"):
            adapter.capture_tokens(subjects, course_id, "a" * 64)

    def test_api_observer_passes_expected_secrets_only_over_stdin_and_checks_all_ten(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope, adapter.selected, adapter.jobs = Scope(), {}, {}
        adapter.configurations = types.SimpleNamespace(
            api={"overlap": {"course-api": {"COURSE_LEARNER_JWT_CURRENT_SECRET": "x" * 40},
                              "community-api": {"COMMUNITY_MEMBER_JWT_CURRENT_SECRET": "y" * 40}}},
            hashes={"overlap": "a" * 64})
        adapter._snapshot = lambda _phase: Path("/private/snapshot")
        adapter._verify_original_runtime_configuration = lambda: None
        containers = [{"service": service} for service in runtime.SERVICES]
        with patch.object(runtime, "compose_command", return_value=["docker", "compose"]), \
             patch.object(runtime, "runtime_environment", return_value={}), \
             patch.object(runtime, "check_containers", return_value=containers), \
             patch.object(adapter, "_validate_runtime_mounts") as mounts:
            observed = adapter.observe_api_configuration("overlap")
        self.assertEqual(observed["containers"], containers)
        mounts.assert_called_once_with(Path("/private/snapshot"), containers)
        self.assertEqual(len(adapter.scope.calls), 2)
        for args, options in adapter.scope.calls:
            self.assertNotIn("x" * 40, " ".join(args)); self.assertNotIn("y" * 40, " ".join(args))
            self.assertIn("_JWT_CURRENT_SECRET", options["input"])

    def test_continuous_runtime_rejects_replaced_container_identity(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        expected = [{"service": service, "containerId": str(index)} for index, service in enumerate(runtime.SERVICES)]
        adapter.observe_api_configuration = lambda _phase: {"containers": expected, "runtimeVerified": True}
        self.assertEqual(adapter.observe_continuous_runtime("overlap", expected)["containers"], expected)
        adapter.observe_api_configuration = lambda _phase: {"containers": [{**expected[0], "containerId": "other"}, *expected[1:]],
                                                               "runtimeVerified": True}
        with self.assertRaises(ValueError):
            adapter.observe_continuous_runtime("overlap", expected)

    def test_runtime_mount_guard_requires_exact_readonly_snapshot_sources(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.scope = Scope(); snapshot = Path("/private/runtime-overlap"); original = Path("/private/original-runtime")
        adapter.unchanged_runtime_configuration = original; adapter.api_mount_configuration = original
        adapter.configurations = types.SimpleNamespace(runtime_private_hashes={"baseline": "a" * 64})
        containers = [{"service": service, "containerId": str(index)} for index, service in enumerate(runtime.SERVICES)]
        expected = {
            "gateway": [("/config/gateway.json", original / "gateway.json"), ("/admission", original / "admission"),
                        ("/tls", original / "tls/gateway")],
            "course-tls": [("/config/course-tls.json", original / "course-tls.json"), ("/tls", original / "tls/course")],
            "course-publisher": [("/tls/ca.pem", original / "tls/ca.pem")],
            "community-api": [("/tls/ca.pem", original / "tls/ca.pem")],
            "community-tls": [("/config/community-tls.json", original / "community-tls.json"), ("/tls", original / "tls/community")],
            "community-worker": [("/tls/ca.pem", original / "tls/ca.pem")],
        }
        by_id = {row["containerId"]: row["service"] for row in containers}
        def command(arguments, _environment, _timeout=15, _input=None):
            service = by_id[arguments[-1]]
            mounts = [{"Type": "tmpfs", "Destination": "/tmp", "RW": True},
                      *({"Type": "bind", "Destination": destination, "Source": str(source), "RW": False}
                        for destination, source in expected.get(service, []))]
            return "true|" + json.dumps(mounts)
        with patch.object(rotation, "_runtime_phase_hash", return_value="a" * 64):
            adapter._command = command
            adapter._validate_runtime_mounts(snapshot, containers)
            adapter.api_mount_configuration = snapshot
            expected["community-api"] = [("/tls/ca.pem", snapshot / "tls/ca.pem")]
            adapter._validate_runtime_mounts(snapshot, containers)
            def changed(arguments, environment, timeout=15, input=None):
                raw = command(arguments, environment, timeout, input)
                return raw.replace(str(original), "/foreign", 1) if by_id[arguments[-1]] == "gateway" else raw
            adapter._command = changed
            with self.assertRaises(ValueError):
                adapter._validate_runtime_mounts(snapshot, containers)
        with patch.object(rotation, "_runtime_phase_hash", return_value="b" * 64):
            with self.assertRaises(ValueError):
                adapter._verify_original_runtime_configuration()

    def test_runtime_boundary_joins_exact_containers_api_current_proofs_release_probe_and_disabled_schedules(self):
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.selected = {}; adapter.client = object(); adapter.scope = Scope()
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "a" * 64})
        containers = [{"service": service, "containerId": f"{index + 1:064x}",
            "image": "ghcr.io/princessdardan/lash-her-platform-test@sha256:" + "b" * 64, "health": "healthy"}
            for index, service in enumerate(runtime.SERVICES)]
        adapter.observe_api_configuration = lambda _phase: {"configurationSha256": "a" * 64,
            "containers": containers, "runtimeVerified": True}
        adapter._observe_api_database_current = lambda name: {"status": "P2_RECOVERY_API_DATABASE_CURRENT", "service": name}
        adapter._snapshot = lambda _phase: Path("/private/runtime")
        calls = []
        def command(arguments, _environment, _timeout=30, _input=None):
            calls.append(arguments)
            if arguments[0] == "systemctl":
                return "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n"
            return json.dumps({"status": "API_RUNTIME_BOUNDARIES_PASS", "checks": sorted(runtime.PROBE_CHECKS)})
        adapter._command = command
        with patch.object(runtime, "compose_command", return_value=["docker", "compose"]), \
             patch.object(runtime, "runtime_environment", return_value={}), \
             patch.object(rotation.vercel, "release_identity", return_value=("staging", "project", "a" * 40)), \
             patch.object(rotation.vercel, "promotion_state", return_value={"cronsEnabled": False}):
            result = adapter.observe_runtime_boundary("overlap")
        self.assertEqual(set(result), {"configurationSha256", "nativeSchedulesEnabled", "businessSchedulesEnabled",
            "containers", "courseCurrent", "communityCurrent", "boundaryChecks"})
        self.assertTrue(result["courseCurrent"]); self.assertTrue(result["communityCurrent"])
        self.assertFalse(result["nativeSchedulesEnabled"]); self.assertFalse(result["businessSchedulesEnabled"])
        self.assertTrue(all(set(row) == {"service", "containerId", "image"} for row in result["containers"]))
        self.assertEqual(adapter.runtime_guard_containers(result["containers"]), containers)
        self.assertEqual(len([call for call in calls if call[0] == "systemctl"]), 2)

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
        adapter._configure_frontend = lambda _phase, _attempt, _before: None
        adapter.observe_frontend_configuration = lambda _phase: {"deploymentId": "dpl_owned"}
        calls = []
        def promote(_client, selected, attempt, verify):
            calls.append("promote"); verify(selected, {"deploymentId": "dpl_owned", "url": "https://owned.vercel.app"})
            return {"frontendDomainsPromoted": True, "deploymentId": "dpl_owned"}
        def verify_workload(*_args, **_kwargs):
            value = {"status": "FRONTEND_VERIFIED", "environment": "staging", "projectId": "project",
                     "sourceCommit": "a" * 40, "releaseId": "release", "deploymentId": "dpl_owned"}
            (adapter.output / "frontend-overlap" / "frontend-workload-outcome.json").write_text(json.dumps(value))
            return value
        with patch.object(frontend_probe := rotation.frontend_probe, "prepare", side_effect=lambda *args, **kwargs: calls.append("prepare")), \
             patch.object(frontend_probe, "verify", side_effect=verify_workload), \
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
            "rotation-frontend-configuration.json": {"owned": True},
        }.items():
            (attempt / name).write_text(json.dumps(value)); (attempt / name).chmod(0o600)
        adapter = rotation.P2IdentityRotationHostAdapter.__new__(rotation.P2IdentityRotationHostAdapter)
        adapter.output = output; adapter.selected = {}; adapter.client = object()
        adapter.configurations = types.SimpleNamespace(hashes={"overlap": "a" * 64})
        adapter._intent = lambda intent: intent
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
