import hashlib
import copy
import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import current_databases as checks
import migrate
import staging_state_test


class CurrentDatabasesTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests()
        self.fixture.setUp()
        self.selected, self.jobs, _, _ = self.fixture.bind()
        self.output = self.fixture.runtime.root / "current-databases"
        self.checker = self.fixture.runtime.root / "checker.mjs"
        self.checker.write_text("owned-checker")
        self.checker_hash = hashlib.sha256(self.checker.read_bytes()).hexdigest()
        self.credentials = {name: name + "-private-fixture" for name in self.jobs}
        self.calls = []
        self.bad_frontend, self.bad_api, self.bad_cleanup = False, False, False

    def profiled(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, resolve_qualification_target_profile
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        definition = resolve_qualification_target_profile(ref)
        self.selected.update(version=3, workload={"projectId": definition["frontend"]["projectId"], "environment": "production"}, approval={})
        for carrier in (self.selected, self.selected["sourceApproval"], self.selected["integration"], self.selected["workload"],
                        self.selected["approval"], self.selected["frontendMigration"], *self.selected["sources"].values()):
            carrier["qualificationTargetProfile"] = copy.deepcopy(ref)
        for name, info in self.jobs.items():
            job = info["job"]
            job["version" if name == "frontend" else "schemaVersion"] = 2
            job["qualificationTargetProfile"] = copy.deepcopy(ref)
            job["target"]["qualificationTargetProfile"] = copy.deepcopy(ref)
            if name != "frontend": job["target"]["schemaVersion"] = 2
        return ref

    def tearDown(self):
        self.fixture.tearDown()

    def run_child(self, args, environment, payload=None, timeout=120):
        self.calls.append((args, environment, payload))
        self.assertNotIn("COURSE_STAGING_DATABASE_URL", environment)
        self.assertNotIn("COMMUNITY_STAGING_DATABASE_URL", environment)
        if args[1] == "run":
            self.assertIn("--read-only", args)
            self.assertEqual(args[args.index("--pull") + 1], "never")
            self.assertEqual(args[args.index("--platform") + 1], "linux/amd64")
            self.assertNotIn("dist-migration/scripts/run-operator-migration.js", args)
            if "ops/platform/frontend-image.mjs" in args:
                self.assertIsNone(payload)
                self.assertEqual(environment["FRONTEND_STAGING_MIGRATION_DATABASE_URL"], self.credentials["frontend"])
                mount = next(x for x in args if isinstance(x, str) and x.endswith("dst=/run/release-receipts"))
                receipts = checks.Path(mount.split(",src=")[1].split(",dst=")[0])
                job = self.jobs["frontend"]["job"]
                record = {**job, "status": "DATABASE_VERIFIED", "schemaVerified": True, "runtimeRoleVerified": True,
                          "target": {key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")},
                          "migrationMode": "verify-current-only", "readOnlyVerified": not self.bad_frontend, "applied": []}
                for file in ("database-receipt.json", "job-outcome.json"):
                    (receipts / file).write_text(json.dumps(record))
                return subprocess.CompletedProcess(args, 0, b"", b"")
            self.assertNotIn("FRONTEND_STAGING_MIGRATION_DATABASE_URL", environment)
            mount = next(x for x in args if isinstance(x, str) and x.endswith("dst=/check/input,readonly"))
            inputs = checks.Path(mount.split("src=")[1].split(",dst=")[0])
            job = migrate.read_json(inputs, "job.json")
            name = "course" if "courseMigration" in self.selected["artifacts"] and job["target"]["database"] == "course_test" else "community"
            self.assertEqual(json.loads(payload), {"connectionUrl": self.credentials[name]})
            self.assertEqual((inputs / "current.mjs").read_bytes(), self.checker.read_bytes())
            record = {"status": "CURRENT_API_DATABASE_READ_ONLY_PASS", "environment": "staging", "pendingTags": [], "appliedCount": 1,
                      "service": self.jobs[name]["service"], "migrationsExecuted": False, "checkerSha256": self.checker_hash,
                      "manifestSha256": hashlib.sha256((inputs / "job.json").read_bytes()).hexdigest(),
                      "schemaBaselineSha256": job["schemaBaselineSha256"], "artifactSha256": job["target"]["artifactSha256"],
                      "transportVerifier": "selected-image/hasVerifiedMigrationTransport",
                      "target": {key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")}}
            if "qualificationTargetProfile" in job:
                record.update(version=2, qualificationTargetProfile=job["qualificationTargetProfile"],
                              checks=["selected-image-operator-role-policy"])
            record.update(migrate.contract_identity(job))
            if self.bad_api:
                record["target"]["host"] = "other.invalid"
            return subprocess.CompletedProcess(args, 0, json.dumps(record).encode(), b"")
        if args[1:3] == ["container", "ls"]:
            return subprocess.CompletedProcess(args, 0, b"remaining" if self.bad_cleanup else b"", b"")
        self.assertEqual(args[1:3], ["rm", "--force"])
        return subprocess.CompletedProcess(args, 0, b"", b"")

    def execute(self, **changes):
        values = {"selected": self.selected, "jobs": self.jobs, "output": self.output, "credentials": self.credentials,
                  "checker": self.checker, "checker_sha256": self.checker_hash}
        values.update(changes)
        with patch.object(checks, "_run", side_effect=self.run_child):
            return checks.check_all(**values)

    def certification_scope(self, ref):
        from p2_certification_parent import P2CertificationScope
        scope = object.__new__(P2CertificationScope)
        scope.candidate_sha256 = "c" * 64
        scope.verify = Mock()
        scope.require_release = Mock()
        scope.require_frontend = Mock()
        raw = {name: (json.dumps(self.jobs[name]["job"], indent=2) + "\n").encode()
               for name in ("course", "community")}
        scope.certification_plan = {
            "certificationActionId": "certification-current-api-fixture",
            "apiJobSha256": {name: hashlib.sha256(value).hexdigest() for name, value in raw.items()},
        }
        scope.run = Mock(side_effect=lambda args, *, env, input=None, capture_output=True, timeout=120:
                         self.run_child(args, env, input, timeout))
        return scope, raw

    def execute_certification(self, scope, raw, ref, **changes):
        values = {
            "selected": self.selected,
            "jobs": self.jobs,
            "output": self.output,
            "credentials": {name: self.credentials[name] for name in ("course", "community")},
            "checker": self.checker,
            "checker_sha256": self.checker_hash,
            "api_job_bytes": raw,
            "expected_profile": ref,
            "_certification_scope": scope,
        }
        values.update(changes)
        return checks.check_certification_apis(**values)

    def test_three_real_entrypoint_commands_have_scoped_credentials_and_cannot_run_api_migrations(self):
        result = self.execute()
        self.assertEqual(result["status"], "CURRENT_DATABASES_READ_ONLY_VERIFIED")
        self.assertEqual(set(result["databases"]), {"frontend", "course", "community"})
        runs = [args for args, _, _ in self.calls if args[1] == "run"]
        self.assertEqual(len(runs), 3)
        self.assertIn("ops/platform/frontend-image.mjs", runs[0])
        self.assertTrue(all("/check/input/current.mjs" in args for args in runs[1:]))
        self.assertNotIn("private-fixture", json.dumps(result))
        self.assertFalse(result["migrationsExecuted"])
        with self.assertRaisesRegex(ValueError, "FRESH_PRIVATE_OUTPUT"):
            self.execute()

    def test_profiled_current_leaf_commands_and_actual_receipt_join_are_explicit(self):
        ref = self.profiled()
        result = self.execute(expected_profile=ref)
        self.assertEqual(result["version"], 2); self.assertEqual(result["qualificationTargetProfile"], ref)
        runs = [args for args, _, _ in self.calls if args[1] == "run"]
        self.assertIn("--execute-profiled-current", runs[0])
        self.assertTrue(all("--profiled-current" in args for args in runs[1:]))
        self.assertFalse(result["migrationsExecuted"])

    def test_profiled_held_frontend_proof_never_reopens_a_frontend_runner(self):
        from p2_profiled_current_scope import P2ProfiledCurrentScope
        from unittest.mock import Mock
        ref = self.profiled()
        # Own the process/Docker boundary in this fixture; the actual TLS/FE
        # backend and child-reap behavior have separate real-process tests.
        scope = object.__new__(P2ProfiledCurrentScope)
        scope.candidate_sha256 = "b" * 64
        scope.verify = Mock()
        scope.require_release = Mock()
        scope.require_frontend = Mock()
        frontend_raw = b'{ "owned": "original held database proof" }\n'
        started_raw = b'{ "owned": "original continuation-started" }\n'
        scope.frontend_current_receipt_bytes = Mock(return_value=(frontend_raw, started_raw))
        original_jobs = {name: (json.dumps(self.jobs[name]["job"], indent=2) + "\n").encode()
                         for name in ("course", "community")}
        scope.api_job_bytes = Mock(side_effect=lambda name: original_jobs[name])
        scope.run = Mock(side_effect=lambda args, *, env, input=None, capture_output=True, timeout=120:
                         self.run_child(args, env, input, timeout))
        # Project Linux root's ownership decisions while running the same host
        # producer on an unprivileged development machine.
        changed_owners = set()
        original_write = migrate.write_exact_bytes
        def retain(directory, name, raw):
            self.assertNotIn(directory, changed_owners, "host receipt directory was given to a container")
            original_write(directory, name, raw)
        linux_os = Mock(wraps=checks.os)
        linux_os.getuid.return_value = 0
        linux_os.chown.side_effect = lambda path, *_: changed_owners.add(path)
        with patch.object(checks, "os", linux_os), \
                patch.object(migrate, "write_exact_bytes", side_effect=retain):
            proof = self.execute(credentials={name: self.credentials[name] for name in original_jobs},
                                 expected_profile=ref, _profiled_current_scope=scope)
        self.assertTrue({self.output / f"{name}-input" for name in original_jobs}.issubset(changed_owners))
        path, result = checks.read_profiled_current_proof(proof, scope, self.selected, self.jobs, expected_profile=ref)
        self.assertEqual(path, self.output)
        self.assertFalse(result["migrationsExecuted"])
        self.assertEqual((path / "frontend/database-receipt.json").read_bytes(), frontend_raw)
        self.assertEqual((path / "frontend/frontend-continuation-started.json").read_bytes(), started_raw)
        self.assertFalse((path / "frontend/job-outcome.json").exists())
        self.assertEqual(len([args for args, _, _ in self.calls if args[1] == "run"]), 2)
        for name, original in original_jobs.items():
            self.assertEqual((path / f"{name}-input/job.json").read_bytes(), original)
        (path / "community/database-receipt.json").write_text('{}')
        with self.assertRaisesRegex(ValueError, "PROFILED_CURRENT_DATABASE_RECEIPT_CHANGED"):
            checks.read_profiled_current_proof(proof, scope, self.selected, self.jobs, expected_profile=ref)

    def test_certification_scope_runs_only_two_pinned_native_api_checks(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        proof = self.execute_certification(scope, raw, ref)
        path, result = checks.read_certification_api_proof(
            proof, scope, self.selected, self.jobs, expected_profile=ref)
        self.assertEqual(path, self.output)
        self.assertEqual(result["status"], "P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED")
        self.assertEqual(set(result["databases"]), {"course", "community"})
        self.assertFalse(result["migrationsExecuted"])
        runs = [args for args, _, _ in self.calls if args[1] == "run"]
        self.assertEqual(len(runs), 2)
        self.assertTrue(all("/check/input/current.mjs" in args and "--profiled-current" in args for args in runs))
        self.assertTrue(all("ops/platform/frontend-image.mjs" not in args for args in runs))
        self.assertTrue(all("run-operator-migration" not in " ".join(args) for args in runs))
        self.assertGreaterEqual(scope.require_frontend.call_count, 4)
        for name, value in raw.items():
            self.assertEqual((path / f"{name}-input/job.json").read_bytes(), value)

    def test_first_owner_policy_is_scoped_to_the_retained_candidate_and_exact_module_bytes(self):
        ref = self.profiled()
        scope, _ = self.certification_scope(ref)
        scope.certification_plan.update(mode="interactive-browser", supplementalOperatorCommit="a" * 40,
            scopedAction={"stage": "identity", "firstOwnerDiscovery": {}}, replacementRelease={})
        scope.candidate_sha256 = "eefe3d6e41d94a1d885a1d9198bfbac381d4227ee7dbd5a6dbe7ee74602280ba"
        scope._profiled_broker = SimpleNamespace(results=self.fixture.runtime.root)
        directory = scope._profiled_broker.results / "certification-readonly-api-role-policy"
        directory.mkdir(mode=0o700)
        selected = {"releaseId": "p1-43067769975-1", "environment": "staging", "sources": {}}
        pins = {}
        for name, (image_source, policy_source, _) in checks._FIRST_OWNER_ROLE_POLICIES.items():
            self.jobs[name]["job"]["sourceCommit"] = image_source
            selected["sources"][name] = {"commit": image_source}
            raw = name.encode()
            (directory / (name + ".mjs")).write_bytes(raw)
            pins[name] = (image_source, policy_source, migrate.file_hash(raw))
        with patch.object(checks, "_FIRST_OWNER_ROLE_POLICIES", pins):
            policies = checks._first_owner_role_policies(scope, selected, self.jobs)
            self.assertEqual(set(policies), {"course", "community"})
            self.assertEqual(policies["course"][0], b"course")
            (directory / "course.mjs").write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "ROLE_POLICY_BYTES_CHANGED"):
                checks._first_owner_role_policies(scope, selected, self.jobs)
            self.assertEqual(checks._first_owner_role_policies(scope, {**selected, "releaseId": "other"}, self.jobs), {})

    def test_certification_binds_role_policy_only_in_the_read_only_check_and_retains_its_pin(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        data = b"owned-role-policy"
        pin = {"sourceCommit": "a" * 40, "sha256": migrate.file_hash(data)}
        with patch.object(checks, "_first_owner_role_policies", return_value={"course": (data, pin)}):
            proof = self.execute_certification(scope, raw, ref)
            path, result = checks.read_certification_api_proof(
                proof, scope, self.selected, self.jobs, expected_profile=ref)
            self.assertEqual(result["databases"]["course"]["readOnlyRolePolicy"], pin)
            self.assertNotIn("readOnlyRolePolicy", result["databases"]["community"])
            runs = [args for args, _, _ in self.calls if args[1] == "run"]
            self.assertIn(f"type=bind,src={path}/course-input/operator-role-policy.mjs,"
                "dst=/app/dist-migration/src/db/operator-migration.js,readonly", runs[0])
            self.assertIn("--read-only", runs[0])
            self.assertFalse(any("operator-role-policy.mjs" in arg for arg in runs[1]))
            policy_path = path / "course-input/operator-role-policy.mjs"
            policy_path.chmod(0o600)
            policy_path.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "ROLE_POLICY_BYTES_CHANGED"):
                checks.read_certification_api_proof(proof, scope, self.selected, self.jobs, expected_profile=ref)

    def test_certification_job_bytes_and_scope_refuse_before_process_or_output(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        changed = dict(raw)
        changed["course"] = raw["course"] + b" "
        with self.assertRaisesRegex(ValueError, "API_JOB_BYTES_CHANGED"):
            self.execute_certification(scope, changed, ref)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())
        with self.assertRaisesRegex(ValueError, "API_SCOPE_REQUIRED"):
            self.execute_certification(object(), raw, ref)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())

    def test_certification_api_check_preserves_original_replacement_frontend_job(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        frontend = self.jobs["frontend"]
        original = ["0000_original_forward"]
        frontend["job"]["target"].update(approvedPendingTags=original, allowEmptyBootstrap=True)
        with self.assertRaisesRegex(ValueError, "FRONTEND_CURRENT_ONLY_REQUIRED"):
            self.execute_certification(scope, raw, ref)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.calls, [])
        scope.certification_plan["replacementRelease"] = {"kind": "frontend-replacement"}
        frontend["job"]["target"]["approvedPendingTags"] = []
        with self.assertRaisesRegex(ValueError, "FRONTEND_REPLACEMENT_JOB_REQUIRED"):
            self.execute_certification(scope, raw, ref)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.calls, [])
        frontend["job"]["target"]["approvedPendingTags"] = original
        proof = self.execute_certification(scope, raw, ref)
        _, outcome = checks.read_certification_api_proof(proof, scope, self.selected, self.jobs, expected_profile=ref)
        self.assertFalse(outcome["frontendSqlApplied"])
        self.assertFalse(outcome["migrationsExecuted"])
        self.assertEqual(frontend["job"]["target"]["approvedPendingTags"], ["0000_original_forward"])
        runs = [args for args, _, _ in self.calls if args[1] == "run"]
        self.assertEqual(len(runs), 2)
        self.assertTrue(all("/check/input/current.mjs" in args for args in runs))

    def test_certification_native_role_policy_is_mandatory(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        original = self.run_child

        def missing_role(args, environment, payload=None, timeout=120):
            result = original(args, environment, payload, timeout)
            if args[1] == "run":
                value = json.loads(result.stdout)
                value["checks"] = []
                return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b"")
            return result

        scope.run.side_effect = lambda args, *, env, input=None, capture_output=True, timeout=120: missing_role(
            args, env, input, timeout)
        with self.assertRaisesRegex(ValueError, "NATIVE_ROLE_POLICY"):
            self.execute_certification(scope, raw, ref)
        self.assertEqual(migrate.read_json(self.output, "certification-current-databases-outcome.json")["status"],
                         "P2_CERTIFICATION_API_DATABASES_REQUIRES_REVIEW")

    def test_certification_proof_is_immutable_and_cleanup_is_mandatory(self):
        ref = self.profiled()
        scope, raw = self.certification_scope(ref)
        proof = self.execute_certification(scope, raw, ref)
        (self.output / "community/database-receipt.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "API_RECEIPT_CHANGED"):
            checks.read_certification_api_proof(proof, scope, self.selected, self.jobs, expected_profile=ref)

        self.tearDown(); self.setUp()
        ref = self.profiled(); scope, raw = self.certification_scope(ref)
        self.bad_cleanup = True
        with self.assertRaisesRegex(ValueError, "CLEANUP_UNVERIFIED"):
            self.execute_certification(scope, raw, ref)
        self.assertEqual(sum(args[1] == "run" for args, _, _ in self.calls), 1)

    def test_mixed_and_unknown_profile_inputs_refuse_before_checker_or_child_access(self):
        ref = self.profiled()
        with patch.object(migrate, "read_input", side_effect=AssertionError("checker read")):
            with self.assertRaisesRegex(ValueError, "POLICY_REFUSED"):
                self.execute()
            with self.assertRaisesRegex(ValueError, "UNKNOWN"):
                self.execute(expected_profile={**ref, "id": "p2q-20261106"})
            self.jobs["community"]["job"]["target"].pop("qualificationTargetProfile")
            with self.assertRaisesRegex(ValueError, "REQUIRED"):
                self.execute(expected_profile=ref)
        self.assertEqual(self.calls, []); self.assertFalse(self.output.exists())

    def test_a_legacy_current_receipt_cannot_be_adopted_by_a_profiled_action(self):
        ref = self.profiled()
        def changed(args, environment, payload=None, timeout=120):
            result = self.run_child(args, environment, payload, timeout)
            if args[1] == "run" and "/check/input/current.mjs" in args:
                value = json.loads(result.stdout); value.pop("qualificationTargetProfile")
                return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b"")
            return result
        with patch.object(checks, "_run", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "REQUIRED"):
                checks.check_all(self.selected, self.jobs, self.output, self.credentials, self.checker, self.checker_hash, expected_profile=ref)
        self.assertEqual(sum(args[1] == "run" for args, _, _ in self.calls), 2)
        self.assertEqual(migrate.read_json(self.output, "current-databases-outcome.json")["qualificationTargetProfile"], ref)

    def test_frontend_pending_sql_missing_credential_or_changed_checker_stops_before_process_access(self):
        self.jobs["frontend"]["job"]["target"]["approvedPendingTags"] = ["0000_test"]
        with self.assertRaisesRegex(ValueError, "CURRENT_ONLY_REQUIRED"):
            self.execute()
        self.jobs["frontend"]["job"]["target"]["approvedPendingTags"] = []
        with self.assertRaisesRegex(ValueError, "NAMED_PRIVATE_CREDENTIALS"):
            self.execute(credentials={"course": "fixture"})
        with self.assertRaisesRegex(ValueError, "CHECKER_HASH"):
            self.execute(checker_sha256="0" * 64)
        self.assertEqual(self.calls, [])

    def test_frontend_read_only_failure_prevents_all_api_checks_and_is_retained(self):
        self.bad_frontend = True
        with self.assertRaisesRegex(ValueError, "FRONTEND_READ_ONLY_PROOF"):
            self.execute()
        self.assertEqual(sum(args[1] == "run" for args, _, _ in self.calls), 1)
        outcome = migrate.read_json(self.output, "current-databases-outcome.json")
        self.assertEqual(outcome["status"], "CURRENT_DATABASES_REQUIRES_REVIEW")
        self.assertFalse(outcome["migrationsExecuted"])

    def test_mismatched_api_target_and_failed_cleanup_cannot_produce_success(self):
        self.bad_api = True
        with self.assertRaisesRegex(ValueError, "API_READ_ONLY_PROOF"):
            self.execute()
        self.assertEqual(sum(args[1] == "run" for args, _, _ in self.calls), 2)
        self.assertEqual(migrate.read_json(self.output, "current-databases-outcome.json")["status"], "CURRENT_DATABASES_REQUIRES_REVIEW")

    def test_remaining_one_shot_container_blocks_success(self):
        self.bad_cleanup = True
        with self.assertRaisesRegex(ValueError, "CLEANUP_UNVERIFIED"):
            self.execute()
        self.assertEqual(sum(args[1] == "run" for args, _, _ in self.calls), 1)

    def test_remote_docker_or_ambient_credentials_are_refused(self):
        for environment in ({"DOCKER_HOST": "tcp://remote.invalid:2375"}, {"AWS_SECRET_ACCESS_KEY": "must-not-inherit"}):
            with self.assertRaisesRegex(ValueError, "LOCAL_ENGINE"):
                self.execute(environment=environment)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())

    def test_diagnostics_export_only_allowlisted_markers_and_keep_raw_failures_private(self):
        result = subprocess.CompletedProcess([], 125,
            b'private-fixture\n{"status":"CURRENT_DATABASES_FAILED","password":"private-fixture"}\n',
            b'postgresql://private-fixture\n{"code":"FRONTEND_TARGET_REFUSED"}\n{"code":"OTHER_PRIVATE_DATA"}')
        self.assertEqual(checks.safe_diagnostics(result), {"exitCode": 125,
            "markers": ["CURRENT_DATABASES_FAILED", "FRONTEND_TARGET_REFUSED"]})
        with patch.object(checks, "_run", side_effect=lambda args, *a, **kw: result if args[1] == "run"
                          else subprocess.CompletedProcess(args, 0, b"", b"")):
            with self.assertRaisesRegex(ValueError, "CONTAINER_CHECK_FAILED"):
                checks.check_all(self.selected, self.jobs, self.output, self.credentials, self.checker, self.checker_hash)
        stored = (self.output / "current-databases-outcome.json").read_text()
        self.assertNotIn("private-fixture", stored)
        self.assertNotIn("OTHER_PRIVATE_DATA", stored)
        raw = self.output / "frontend/private-stderr.bin"
        self.assertEqual(raw.read_bytes(), result.stderr)
        self.assertEqual(raw.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
