from copy import deepcopy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

import p2_identity_negative_probe as probe
import release_test


class Observer:
    """Private helper seam only; not a deployed P2ReleaseScope receipt."""
    def __init__(self):
        self.checks = 0
        self.failure = False
        self.outputs = []
        self.args = []

    def verify(self):
        self.checks += 1
        if self.failure:
            raise ValueError("OWNED_OBSERVER_LOST")

    def run(self, args, **options):
        self.verify()
        self.args.append((args, options))
        return subprocess.CompletedProcess(args, 0, self.outputs.pop(0), b"")


class IdentityNegativeProbeTests(unittest.TestCase):
    def setUp(self):
        self.parent = release_test.RuntimeReleaseTests()
        self.parent.setUp()
        self.addCleanup(self.parent.tearDown)
        self.fixture = self.parent.fixture
        self.fixture.add_frontend()
        pair = {"contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "e" * 64}
        self.fixture.release.update(pair)
        self.fixture.release["frontendMigration"].update(pair)
        for job in self.fixture.jobs.values():
            job.update(pair)
        self.source = Path(probe.__file__).resolve().parents[3]
        self.fixture.release["runtime"]["composeSha256"] = "sha256:" + probe._hash((self.source / "ops/platform/compose.yaml").read_bytes())
        self.fixture.save()
        self.parent.gateway["publicHost"] = probe.certificates.HOST
        self.parent.save("gateway.json", self.parent.gateway)
        self.configuration = self.parent.configuration
        self.bundle = self.parent.bundle
        self.reviewed = {"version": 1, "environment": "staging", "probeId": "owned-s06", "releaseId": "test-release",
            "candidateSha256": probe._hash((self.bundle / "release.candidate.json").read_bytes()), "hostMachineId": "1" * 32,
            "configurationSha256": "d" * 64, "sources": {name: "a" * 40 for name in ("frontend", "course", "community")},
            "containers": [{"service": name, "containerId": format(index + 1, "064x"),
                "image": self.fixture.release["artifacts"][probe.runtime.IMAGE_KEYS[name]]["image"]} for index, name in enumerate(probe.SERVICES)],
            "subjects": {name: str(uuid.UUID(int=index + 1, version=4)) for index, name in enumerate(("learnerA", "learnerB", "admin"))},
            "resources": {name: str(uuid.UUID(int=index + 10, version=4)) for index, name in enumerate(("courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"))},
            "programSha256": probe._hash(probe.program_bytes(self.source)), "previousProfiles": sorted(probe.PROFILES)}
        self.reviewed["operatorSourceFiles"] = probe.source_closure(self.source)
        self.reviewed["operatorSourceSha256"] = probe._hash(probe._canonical(self.reviewed["operatorSourceFiles"]))
        self.reviewed["priorEvidence"] = {"originalReleaseReceiptSha256": "6" * 64, "frontendDeploymentRecordSha256": "7" * 64}
        self.observer = Observer()

    def plan(self):
        return probe.make_plan(self.bundle, self.configuration, self.reviewed, self.source)[0]

    def test_actual_release_plan_is_staging_only_and_never_parses_credentials_or_calls_docker(self):
        with patch.object(probe.runtime, "command", side_effect=AssertionError("PLAN_MUST_NOT_EXECUTE")), \
                patch.object(probe.runtime, "environment_values", side_effect=AssertionError("PLAN_MUST_NOT_CONSUME_CREDENTIALS")):
            result = self.plan()
        self.assertEqual(result["status"], "P2_IDENTITY_NEGATIVE_PROBE_PLAN")
        self.assertFalse(result["credentialsRead"])
        self.assertFalse(result["networkCalled"])
        self.assertFalse(result["releaseAccepted"])
        self.assertIn("actual-completed-attempt-owned-by-a-on-shared-lesson", result["prerequisites"])

    def test_public_scope_rejects_production_unknown_key_paths_commands_and_wrong_subjects(self):
        for field, value in (("environment", "production"), ("url", "https://foreign.example.invalid"), ("token", "private-token"),
                ("command", ["docker", "exec"]), ("key", "private-signing-key")):
            reviewed = deepcopy(self.reviewed)
            reviewed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                probe.validate_reviewed(reviewed)
        for group, field in (("subjects", "learnerA"), ("resources", "completedAttempt")):
            reviewed = deepcopy(self.reviewed)
            reviewed[group][field] = "not-a-uuid"
            with self.assertRaises(ValueError):
                probe.validate_reviewed(reviewed)

    def test_wrong_candidate_source_host_image_or_program_pin_refuses(self):
        for change in ("candidate", "source", "host", "image", "program", "foreign-public-host"):
            value = deepcopy(self.reviewed)
            if change == "candidate":
                self.reviewed["candidateSha256"] = "b" * 64
            elif change == "source":
                self.reviewed["sources"]["community"] = "b" * 40
            elif change == "host":
                self.reviewed["hostMachineId"] = "2" * 32
            elif change == "image":
                self.reviewed["containers"][0]["image"] = "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "1" * 64
            elif change == "program":
                self.reviewed["programSha256"] = "b" * 64
            else:
                self.parent.gateway["publicHost"] = "api-production.lashher.com"
                self.parent.save("gateway.json", self.parent.gateway)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.plan()
            self.reviewed = value

    def test_no_plaintext_or_json_completion_flag_can_construct_the_execute_scope(self):
        for lease in (None, {}, {"held": True, "candidateSha256": self.reviewed["candidateSha256"]}, self.observer):
            with self.subTest(lease=type(lease).__name__), self.assertRaises(probe.NegativeProbeFailure) as failure:
                probe.execute(self.bundle, self.configuration, self.reviewed, self.source, lease)
            self.assertEqual(failure.exception.public_receipt["check"], "P2_IDENTITY_ACTUAL_RELEASE_SCOPE_REQUIRED")

    def test_unfiltered_failure_details_never_escape_the_broker_api(self):
        with patch.object(probe, "_execute_scoped", side_effect=RuntimeError("private-token-in-raw-upstream-body")):
            with self.assertRaises(probe.NegativeProbeFailure) as failure:
                probe.execute(self.bundle, self.configuration, self.reviewed, self.source, None)
        self.assertNotIn("private-token", str(failure.exception))
        self.assertNotIn("private-token", json.dumps(failure.exception.public_receipt))

    def test_guard_checks_observer_after_success_and_failure(self):
        self.assertEqual(probe._guard(self.observer, lambda: "read-only"), "read-only")
        self.assertEqual(self.observer.checks, 2)
        def lost():
            self.observer.failure = True
            raise ValueError("PRIVATE_ERROR_MUST_NOT_REPLACE_LEASE_LOSS")
        with self.assertRaisesRegex(ValueError, "OWNED_OBSERVER_LOST"):
            probe._guard(self.observer, lost)

    def configure_keys(self):
        for service in ("course", "community"):
            file = self.configuration / (service + "-api.env")
            text = file.read_text().replace("literal$VALUE", "owned-service-" + "s" * 48)
            for index, (profile, prefix) in enumerate(probe.PROFILES.items()):
                if profile.startswith(service + "-"):
                    text += prefix + "_JWT_CURRENT_SECRET=owned-current-" + str(index) * 48 + "\n"
                    text += prefix + "_JWT_PREVIOUS_SECRET=owned-previous-" + str(index) * 48 + "\n"
            file.write_text(text)

    def test_keys_are_read_only_from_existing_validated_private_runtime_files(self):
        self.configure_keys()
        jobs = {name: {"job": value} for name, value in self.fixture.jobs.items()}
        keys, service_keys, environments = probe._keys(self.configuration, jobs, self.reviewed, self.observer)
        self.assertEqual(set(keys), set(probe.PROFILES))
        self.assertEqual(len(service_keys), 1)
        self.assertEqual(environments["course"]["DATABASE_TARGET"], "staging")
        self.assertGreater(self.observer.checks, 8)
        self.assertEqual(self.observer.args, [])
        self.reviewed["previousProfiles"] = []
        with self.assertRaisesRegex(ValueError, "KEY_OVERLAP_CHANGED"):
            probe._keys(self.configuration, jobs, self.reviewed, self.observer)

    def test_missing_valid_key_baseline_and_world_readable_private_files_refuse(self):
        jobs = {name: {"job": value} for name, value in self.fixture.jobs.items()}
        with self.assertRaisesRegex(ValueError, "BASELINE_UNCONFIGURED"):
            probe._keys(self.configuration, jobs, self.reviewed, self.observer)
        self.configure_keys()
        file = self.configuration / "course-api.env"
        file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "PRIVATE_RUNTIME_FILE"):
            probe._keys(self.configuration, jobs, self.reviewed, self.observer)

    def inspect_outputs(self, container, mounts, root_readonly=True):
        self.observer.outputs = [(container["image"] + "|true|healthy|lash-her-staging|" + container["service"]).encode(),
            (("true" if root_readonly else "false") + "|" + json.dumps(mounts)).encode()]

    def test_exact_container_checks_refuse_module_overlays_and_unpinned_config_sources(self):
        container = next(row for row in self.reviewed["containers"] if row["service"] == "course-api")
        self.inspect_outputs(container, [])
        probe._one_container(container, self.configuration, self.observer)
        self.assertTrue(all(".Config.Env" not in str(args) for args, _options in self.observer.args))
        for mount in ({"Type": "bind", "Destination": "/app/dist", "Source": "/foreign", "RW": False},
                {"Type": "bind", "Destination": "/var/run/docker.sock", "Source": "/var/run/docker.sock", "RW": True}):
            self.inspect_outputs(container, [mount])
            with self.assertRaisesRegex(ValueError, "MOUNTS_REFUSED"):
                probe._one_container(container, self.configuration, self.observer)
        self.inspect_outputs(container, [], False)
        with self.assertRaisesRegex(ValueError, "IMMUTABLE_CONTAINER"):
            probe._one_container(container, self.configuration, self.observer)

    def test_gateway_requires_exact_private_readonly_mounts(self):
        container = next(row for row in self.reviewed["containers"] if row["service"] == "gateway")
        mounts = [{"Type": "bind", "Destination": target, "Source": str(self.configuration / source), "RW": False} for target, source in
            (("/config/gateway.json", "gateway.json"), ("/admission", "admission"), ("/tls", "tls/gateway"))]
        self.inspect_outputs(container, mounts)
        probe._one_container(container, self.configuration, self.observer)
        mounts[0]["Source"] = "/production/gateway.json"
        self.inspect_outputs(container, mounts)
        with self.assertRaisesRegex(ValueError, "MOUNTS_REFUSED"):
            probe._one_container(container, self.configuration, self.observer)

    def test_complete_protocol_checklists_require_positive_and_attempt_baselines(self):
        expected = probe._expected_checks("course-http-plan", self.reviewed["previousProfiles"], 1)
        rows = [{"name": name, "expectedStatus": status} for name, status in expected.items()]
        value = {"version": 1, "status": "P2_IDENTITY_HTTP_CHECK_PLAN", "bindingSha256": "a" * 64, "checks": rows, "networkCalled": False}
        probe._validate_receipt(value, "a" * 64, "course-http-plan", previous_profiles=self.reviewed["previousProfiles"])
        value["checks"] = [row for row in rows if row["name"] != "course-http.completed-attempt-a-baseline"]
        with self.assertRaisesRegex(ValueError, "COMPLETE_CHECK_PLAN"):
            probe._validate_receipt(value, "a" * 64, "course-http-plan", previous_profiles=self.reviewed["previousProfiles"])

    def test_receipts_refuse_missing_checks_duplicates_unreviewed_fields_and_module_hashes(self):
        names = probe._expected_checks("community-verifier", self.reviewed["previousProfiles"], 1)
        value = {"version": 1, "status": "P2_IDENTITY_NEGATIVE_PROBE_PASS", "environment": "staging", "bindingSha256": "a" * 64,
            "scope": "actual-community-image-verifier-only", "checks": [{"name": name, "status": "passed"} for name in names],
            "moduleSha256": {"dist/auth/community-user-auth.js": "b" * 64, "dist/config/runtime.js": "c" * 64, "dist/config/env.js": "d" * 64},
            "runtimeConfigurationBindingVerified": True, "readOnly": True, "oidcVerified": False, "keyRemovalVerified": False, "releaseAccepted": False}
        probe._validate_receipt(value, "a" * 64, "community-verifier", previous_profiles=self.reviewed["previousProfiles"])
        for mutation in (lambda row: row.update(token="private-token"), lambda row: row["checks"].pop(),
                lambda row: row["checks"].append(row["checks"][0]), lambda row: row.update(moduleSha256={}), lambda row: row.update(oidcVerified=True)):
            changed = deepcopy(value)
            mutation(changed)
            with self.assertRaises(ValueError):
                probe._validate_receipt(changed, "a" * 64, "community-verifier", previous_profiles=self.reviewed["previousProfiles"])

    def test_configuration_digest_binds_every_original_file_without_returning_values(self):
        first = probe._configuration_hash(self.configuration, self.observer)
        file = self.configuration / "course-api.env"
        file.write_text(file.read_text() + "SAFE_NONSECRET_CHANGE=owned\n")
        self.assertNotEqual(first, probe._configuration_hash(self.configuration, self.observer))
        self.assertRegex(first, r"^[a-f0-9]{64}$")

    def test_current_stage_cli_defaults_to_actual_plan_without_runtime_or_sql_execution(self):
        packet = {"version": 1, "operation": "plan", "bundleDirectory": str(self.bundle), "configurationDirectory": str(self.configuration),
            "reviewed": self.reviewed, "priorEvidence": None}
        result = subprocess.run(["python3", "-I", "-B", str(Path(probe.__file__).with_name("p2_identity_probe_current.py"))],
            input=json.dumps(packet).encode(), capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["status"], "P2_IDENTITY_NEGATIVE_PROBE_PLAN")
        self.assertFalse(value["credentialsRead"])
        self.assertFalse(value["networkCalled"])
        self.assertFalse(value["frontendSqlVerified"])
        self.assertEqual(value["priorEvidence"], self.reviewed["priorEvidence"])

    def test_operator_closure_and_original_evidence_are_closed_exact_bindings(self):
        original = deepcopy(self.reviewed)
        for name in ("operatorSourceFiles", "priorEvidence"):
            for mutation in ("missing", "extra"):
                self.reviewed = deepcopy(original)
                if mutation == "missing":
                    self.reviewed[name].pop(next(iter(self.reviewed[name])))
                else:
                    self.reviewed[name]["unreviewed"] = "f" * 64
                with self.assertRaises(ValueError):
                    self.plan()
        self.reviewed = deepcopy(original)
        self.reviewed["operatorSourceFiles"][probe.PROGRAM] = "f" * 64
        self.reviewed["operatorSourceSha256"] = probe._hash(probe._canonical(self.reviewed["operatorSourceFiles"]))
        with self.assertRaisesRegex(ValueError, "OPERATOR_SOURCE_CHANGED"):
            self.plan()

    def test_source_closure_count_bound_agrees_for_reviewed_and_installed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            for name in probe.SOURCE_ANCHORS:
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes((self.source / name).read_bytes())
            for index in range(448 - len(probe.SOURCE_ANCHORS)):
                (source / "ops" / f"owned-source-{index}.mjs").write_text("// owned fixture\n")
            files = probe.source_closure(source)
            self.assertEqual(len(files), 448)
            reviewed = deepcopy(self.reviewed)
            reviewed["operatorSourceFiles"] = files
            reviewed["operatorSourceSha256"] = probe._hash(probe._canonical(files))
            probe.validate_reviewed(reviewed)
            (source / "ops" / "overflow.mjs").write_text("// owned fixture\n")
            with self.assertRaisesRegex(ValueError, "SOURCE_CLOSURE_REQUIRED"):
                probe.source_closure(source)
            files["ops/overflow.mjs"] = probe._hash(b"// owned fixture\n")
            reviewed["operatorSourceSha256"] = probe._hash(probe._canonical(files))
            with self.assertRaisesRegex(ValueError, "SOURCE_CLOSURE_REQUIRED"):
                probe.validate_reviewed(reviewed)
