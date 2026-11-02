import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import migrate


class MigrationDriverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bundle, self.results = self.root / "bundle", self.root / "results"
        self.bundle.mkdir(mode=0o700); self.results.mkdir(mode=0o700)
        (self.bundle / "jobs").mkdir(); (self.bundle / "schema").mkdir()
        self.release = {"version": 2, "environment": "staging", "releaseId": "test-release", "sources": {}, "artifacts": {},
                        "contractManifestSha256": "sha256:" + "d" * 64, "integration": {"state": "passed"},
                        "sourceApproval": {"mode": "single-operator-dispatch", "operatorGithubUserId": "8996309"}}
        for name, repository in (("frontend", "lash-her-frontend"), ("course", "lash-her-course-api"), ("community", "lash-her-community-api")):
            self.release["sources"][name] = {"repository": f"https://github.com/princessdardan/{repository}.git", "commit": "a" * 40, "requiredChecks": "passed"}
        self.jobs = {}
        for name, (service, migration_key, runtime_key) in migrate.SERVICES.items():
            for key, suffix, digit in ((migration_key, "migration", "b"), (runtime_key, "runtime", "c")):
                self.release["artifacts"][key] = {"image": f"ghcr.io/princessdardan/lash-her-platform-{name}-{suffix}@sha256:{digit * 64}",
                    "scan": "passed", "sbomSha256": "sha256:" + "d" * 64, "provenanceSha256": "sha256:" + "e" * 64}
            schema = b'{"schema":"owned-fixture"}'
            (self.bundle / f"schema/{name}.json").write_bytes(schema)
            self.jobs[name] = {"schemaVersion": 1, "kind": "operator-migration", "operator": "Dardan", "releaseId": "test-release", "environment": "staging",
                "sourceCommit": "a" * 40, "migrationImageDigest": "sha256:" + "b" * 64, "runtimeImageDigest": "sha256:" + "c" * 64,
                "contractSha256": "d" * 64, "schemaBaselineSha256": hashlib.sha256(schema).hexdigest(), "stagingVerification": None,
                "target": {"service": service, "environment": "staging", "host": f"{name}.example.invalid", "database": f"{name}_test", "user": "migration_role", "artifactSha256": "f" * 64,
                           "approvedPendingTags": ["0000_test"]}}
        self.save()

    def tearDown(self):
        self.temporary.cleanup()

    def save(self):
        (self.bundle / "release.candidate.json").write_text(json.dumps(self.release))
        for name, job in self.jobs.items():
            (self.bundle / f"jobs/{name}.json").write_text(json.dumps(job))

    def execute(self, confirmation="staging/test-release"):
        return migrate.execute(self.bundle, self.results, True, confirmation, self.root / "release.lock")

    def add_frontend(self):
        baseline = {"version": 1, "serverMajor": 18, "sqlArtifactSha256": "f" * 64, "catalog": {}}
        schema_hash = hashlib.sha256(json.dumps(baseline, separators=(",", ":")).encode()).hexdigest()
        self.release["artifacts"]["frontendMigration"] = {"image": "ghcr.io/princessdardan/lash-her-platform-frontend-migration@sha256:" + "b" * 64,
            "scan": "passed", "sbomSha256": "sha256:" + "d" * 64, "provenanceSha256": "sha256:" + "e" * 64}
        self.release["frontendMigration"] = {"sourceCommit": "a" * 40, "sqlArtifactSha256": "f" * 64,
            "contractManifestSha256": self.release["contractManifestSha256"], "schemaBaselines": {"18": schema_hash}}
        self.release["workload"] = {"projectId": "prj_fixture"}
        self.jobs["frontend"] = {"version": 1, "operator": "Dardan", "releaseId": "test-release", "environment": "staging", "sourceCommit": "a" * 40,
            "migrationImageDigest": "sha256:" + "b" * 64, "sqlArtifactSha256": "f" * 64, "schemaBaselineSha256": schema_hash,
            "contractManifestSha256": self.release["contractManifestSha256"], "recoveryRef": "owned/recovery",
            "target": {"host": "frontend.example.invalid", "port": 5432, "database": "frontend_test", "user": "migration_role", "runtimeRole": "runtime_role",
                       "serverMajor": 18, "allowEmptyBootstrap": True, "approvedPendingTags": ["0000_test"]}}
        (self.bundle / "schema/frontend.json").write_text(json.dumps(baseline, indent=2))
        self.save()

    def fake_docker(self, args, **kwargs):
        env = kwargs.get("env", {})
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("COMMUNITY_STAGING_DATABASE_URL", env)
        self.assertNotIn("COURSE_STAGING_DATABASE_URL", env)
        if "--execute" in args:
            if "ops/platform/frontend-image.mjs" in args:
                self.assertNotIn("DATABASE_TARGET", env); self.assertNotIn("STAGING_DATABASE_URL", env)
                self.assertEqual(env.get("FRONTEND_STAGING_MIGRATION_DATABASE_URL"), "owned-frontend-url")
                mount = next(value for value in args if isinstance(value, str) and value.endswith("dst=/run/release-receipts"))
                receipts = Path(mount.split(",src=")[1].split(",dst=")[0])
                receipt = {**self.jobs["frontend"], "service": "frontend", "status": "DATABASE_VERIFIED", "schemaVerified": True, "runtimeRoleVerified": True}
                if self.jobs["frontend"]["target"]["approvedPendingTags"] == []:
                    receipt.update(migrationMode="verify-current-only", readOnlyVerified=True, applied=[])
                for file in ("database-receipt.json", "job-outcome.json"):
                    (receipts / file).write_text(json.dumps(receipt))
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            self.assertEqual(env.get("DATABASE_TARGET"), "staging")
            self.assertEqual(env.get("STAGING_DATABASE_URL"), "owned-fixture-url")
            self.assertNotIn("PROD_DATABASE_URL", env)
            name = "course" if "lash-migrate-course-test-release" in args else "community"
            mount = next(value for value in args if isinstance(value, str) and value.endswith("dst=/run/release-receipts"))
            receipts = Path(mount.split(",src=")[1].split(",dst=")[0])
            job = self.jobs[name]
            receipt = {**job, "service": migrate.SERVICES[name][0], "status": "DATABASE_VERIFIED", "failureCode": None}
            (receipts / "database-receipt.json").write_text(json.dumps(receipt))
            (receipts / "job-outcome.json").write_text('{"status":"DATABASE_VERIFIED"}')
        else:
            self.assertNotIn("STAGING_DATABASE_URL", env)
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    def test_three_databases_share_preflight_credential_checks_and_the_release_lock(self):
        self.add_frontend()
        def continuation(attempt, selected, result):
            with (self.root / "release.lock").open() as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(set(result["databaseReceiptSha256"]), {"course", "community", "frontend"})
            return result
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                   "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}), patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            result = migrate.execute(self.bundle, self.results, True, "staging/test-release", self.root / "release.lock", after_migrations=continuation,
                                     before_frontend_migration=lambda selected, attempt: {"status": "FRONTEND_PRODUCERS_SUSPENDED", "environment": "staging", "projectId": "prj_fixture"})
        self.assertEqual(result["status"], "DATABASES_VERIFIED")
        calls = [call.args[0] for call in commands.call_args_list]
        self.assertLess(max(i for i, args in enumerate(calls) if "--check" in args), min(i for i, args in enumerate(calls) if "--execute" in args))
        frontend = next(args for args in calls if "--execute" in args and "ops/platform/frontend-image.mjs" in args)
        self.assertIn("/run/release-input/candidate.json", frontend)

    def test_missing_frontend_credential_stops_every_database_before_suspension(self):
        self.add_frontend()
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url"}, clear=True), \
             patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            with self.assertRaisesRegex(ValueError, "NAMED_MIGRATION_CREDENTIAL_REQUIRED"):
                self.execute()
        self.assertFalse(any("--execute" in call.args[0] or "ps" in call.args[0] for call in commands.call_args_list))

    def test_frontend_manifest_schema_and_terminal_mismatch_refuse(self):
        self.add_frontend()
        self.jobs["frontend"]["sourceCommit"] = "b" * 40; self.save()
        with self.assertRaisesRegex(ValueError, "FRONTEND_JOB_CANDIDATE_MISMATCH"):
            migrate.make_plan(self.bundle)
        self.jobs["frontend"]["sourceCommit"] = "a" * 40; self.save()
        def mismatch(args, **kwargs):
            result = self.fake_docker(args, **kwargs)
            if "--execute" in args and "ops/platform/frontend-image.mjs" in args:
                file = self.results / "test-release/frontend/job-outcome.json"
                value = json.loads(file.read_text()); value["migrationImageDigest"] = "sha256:" + "c" * 64; file.write_text(json.dumps(value))
            return result
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                   "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}), patch.object(subprocess, "run", side_effect=mismatch):
            with self.assertRaisesRegex(ValueError, "FRONTEND_TERMINAL_BINDING_REFUSED"):
                migrate.execute(self.bundle, self.results, True, "staging/test-release", self.root / "release.lock",
                                before_frontend_migration=lambda selected, attempt: {"status": "FRONTEND_PRODUCERS_SUSPENDED", "environment": "staging", "projectId": "prj_fixture"})

    def test_full_bundle_cannot_migrate_without_the_frontend_quiescence_coordinator(self):
        self.add_frontend()
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                   "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}), patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            with self.assertRaisesRegex(ValueError, "FRONTEND_QUIESCENCE_COORDINATOR_REQUIRED"):
                self.execute()
        self.assertFalse(any("--execute" in call.args[0] or "ps" in call.args[0] for call in commands.call_args_list))

    def test_current_frontend_is_verified_read_only_before_any_api_database_apply(self):
        self.add_frontend(); self.jobs["frontend"]["target"]["approvedPendingTags"] = []; self.save()
        plan = migrate.execute(self.bundle, self.results)
        self.assertEqual(plan["frontendMigrationMode"], "verify-current-only")
        self.assertFalse(plan["frontendProducerSuspensionRequired"])
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                   "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}), patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            result = self.execute()
        executions = [call.args[0] for call in commands.call_args_list if "--execute" in call.args[0]]
        self.assertEqual(len(executions), 3)
        self.assertIn("ops/platform/frontend-image.mjs", executions[0])
        self.assertTrue(result["frontendReadOnlyVerified"])
        self.assertFalse((self.results / "test-release/frontend-quiescence.json").exists())

    def test_current_frontend_missing_read_only_proof_stops_all_api_database_changes(self):
        self.add_frontend(); self.jobs["frontend"]["target"]["approvedPendingTags"] = []; self.save()
        def unverified(args, **kwargs):
            result = self.fake_docker(args, **kwargs)
            if "--execute" in args and "ops/platform/frontend-image.mjs" in args:
                file = self.results / "test-release/frontend/job-outcome.json"
                value = json.loads(file.read_text()); value["readOnlyVerified"] = False; file.write_text(json.dumps(value))
            return result
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                   "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}), patch.object(subprocess, "run", side_effect=unverified) as commands:
            with self.assertRaisesRegex(ValueError, "FRONTEND_READ_ONLY_VERIFICATION_REQUIRED"):
                self.execute()
        executions = [call.args[0] for call in commands.call_args_list if "--execute" in call.args[0]]
        self.assertEqual(len(executions), 1)
        self.assertIn("ops/platform/frontend-image.mjs", executions[0])

    def test_plan_reads_no_credentials_and_executes_no_commands(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("Plan executed")):
            plan = migrate.execute(self.bundle, self.results)
        self.assertFalse(plan["trafficAuthorized"])
        self.assertFalse(plan["credentialsRead"])
        self.assertEqual(len(plan["targets"]), 2)

    def test_changed_source_image_or_schema_fails_before_execution(self):
        for mutate in (lambda: self.jobs["course"].update(sourceCommit="f" * 40),
                       lambda: self.jobs["community"].update(runtimeImageDigest="sha256:" + "f" * 64),
                       lambda: self.jobs["course"].update(schemaBaselineSha256="0" * 64)):
            original = copy.deepcopy(self.jobs)
            mutate(); self.save()
            with self.assertRaises(ValueError):
                migrate.make_plan(self.bundle)
            self.jobs = original; self.save()

    def test_confirmation_and_shared_lock_precede_all_mutation(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("Unconfirmed command")):
            with self.assertRaises(ValueError):
                self.execute("production/test-release")
            with (self.root / "release.lock").open("w") as locked:
                fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    self.execute()
        self.assertEqual(list(self.results.iterdir()), [])

    def test_private_schema_outputs_cannot_be_written_into_a_checkout(self):
        (self.root / ".git").mkdir()
        with patch.object(subprocess, "run", side_effect=AssertionError("Checkout received private schema")):
            with self.assertRaisesRegex(ValueError, "RELEASE_ARTIFACTS_OUTSIDE_CHECKOUT_REQUIRED"):
                self.execute()
        self.assertEqual(list(self.results.iterdir()), [])

    def test_container_command_has_only_selected_credential_name_and_hardening(self):
        args = migrate.docker_arguments("image@sha256:fixture", Path("/owned/input"), Path("/owned/receipts"), "staging", "release", "501:20", "owned")
        self.assertIn("--read-only", args); self.assertIn("no-new-privileges:true", args)
        self.assertIn("ALL", args); self.assertIn("501:20", args)
        self.assertIn("STAGING_DATABASE_URL", args); self.assertNotIn("PROD_DATABASE_URL", args)
        self.assertNotIn("--privileged", args); self.assertNotIn("docker.sock", " ".join(args))

    def test_both_jobs_are_checked_before_apply_and_terminal_receipts_retained(self):
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url", "AWS_SECRET_ACCESS_KEY": "must-not-inherit"}), \
             patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            result = self.execute()
        self.assertEqual(result["status"], "DATABASES_VERIFIED")
        self.assertFalse(result["runtimeResumed"])
        calls = [call.args[0] for call in commands.call_args_list]
        checks = [i for i, args in enumerate(calls) if "--check" in args]
        applies = [i for i, args in enumerate(calls) if "--execute" in args]
        self.assertEqual(len(checks), 2); self.assertEqual(len(applies), 2)
        self.assertLess(max(checks), min(applies))
        stored = json.loads((self.results / "test-release/migration-outcome.json").read_text())
        self.assertEqual(stored["status"], "DATABASES_VERIFIED")
        self.assertEqual(len(stored["databaseReceiptSha256"]), 2)
        with patch.object(subprocess, "run", side_effect=AssertionError("Attempt overwritten")):
            with self.assertRaises(FileExistsError):
                self.execute()

    def test_missing_second_credential_prevents_both_database_operations(self):
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url"}, clear=True), \
             patch.object(subprocess, "run", side_effect=self.fake_docker) as commands:
            with self.assertRaises(ValueError):
                self.execute()
        self.assertFalse(any("--execute" in call.args[0] for call in commands.call_args_list))

    def test_failed_first_database_stops_second_and_records_failure(self):
        def fail(args, **kwargs):
            if "--execute" in args:
                raise subprocess.CalledProcessError(1, args)
            return self.fake_docker(args, **kwargs)
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url"}), \
             patch.object(subprocess, "run", side_effect=fail) as commands:
            with self.assertRaises(subprocess.CalledProcessError):
                self.execute()
        self.assertEqual(sum("--execute" in call.args[0] for call in commands.call_args_list), 1)
        self.assertEqual(json.loads((self.results / "test-release/migration-outcome.json").read_text())["status"], "FAILED_REQUIRES_REVIEW")
        self.assertTrue(any(call.args[0][1:3] == ["rm", "--force"] for call in commands.call_args_list))

    def test_receipt_retention_failure_cannot_leave_a_success_outcome(self):
        original = migrate.file_hash
        calls = 0
        def fail_retention(value):
            nonlocal calls
            calls += 1
            if calls > 2:
                raise ValueError("RETENTION_FAILURE")
            return original(value)
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url"}), \
             patch.object(subprocess, "run", side_effect=self.fake_docker), patch.object(migrate, "file_hash", side_effect=fail_retention):
            with self.assertRaises(ValueError):
                self.execute()
        outcome = json.loads((self.results / "test-release/migration-outcome.json").read_text())
        self.assertEqual(outcome["status"], "FAILED_REQUIRES_REVIEW")
        self.assertEqual(outcome["failureCode"], "RETENTION_FAILURE")

    def test_unverified_container_cleanup_cannot_report_success(self):
        def unverified(args, **kwargs):
            result = self.fake_docker(args, **kwargs)
            if args[1:3] == ["container", "ls"]:
                result.stdout = "a" * 12
            return result
        with patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url"}), \
             patch.object(subprocess, "run", side_effect=unverified):
            with self.assertRaises(ValueError):
                self.execute()
        stored = json.loads((self.results / "test-release/migration-outcome.json").read_text())
        self.assertEqual(stored["status"], "FAILED_REQUIRES_REVIEW")

    def test_production_requires_actual_staging_receipts_smokes_and_target_recovery(self):
        self.release["environment"] = "production"
        self.release["artifacts"]["gateway"] = {"image": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "e" * 64}
        (self.bundle / "staging").mkdir()
        for name, job in self.jobs.items():
            job["environment"] = "production"; job["target"]["environment"] = "production"
            fields = {key: job[key] for key in ("sourceCommit", "migrationImageDigest", "runtimeImageDigest", "contractSha256")}
            job["stagingVerification"] = {**fields, "artifactSha256": job["target"]["artifactSha256"], "receiptRef": f"staging/{name}"}
            receipts = self.bundle / f"staging/{name}"; receipts.mkdir()
            previous = {**fields, "artifactSha256": job["target"]["artifactSha256"], "service": migrate.SERVICES[name][0],
                        "environment": "staging", "status": "DATABASE_VERIFIED", "failureCode": None}
            (receipts / "database-receipt.json").write_text(json.dumps(previous))
            (receipts / "job-outcome.json").write_text('{"status":"DATABASE_VERIFIED"}')
        self.save()
        with self.assertRaises(FileNotFoundError):
            migrate.make_plan(self.bundle)
        acceptance = {"status": "STAGING_VERIFIED", "environment": "staging", "contractManifestSha256": self.release["contractManifestSha256"],
                      "sources": self.release["sources"], "artifacts": self.release["artifacts"],
                      "checks": {name: "passed" for name in ("application-smoke", "workload-oidc", "worker-recovery", "database-lineage")}}
        recovery = {"environment": "production", "operator": "Dardan", "databases": {name: {
            "host": job["target"]["host"], "database": job["target"]["database"], "backupRef": "verified/provider-point",
            "restoreRehearsalRef": "owned/restore-rehearsal"} for name, job in self.jobs.items()}}
        (self.bundle / "staging/acceptance.json").write_text(json.dumps(acceptance))
        (self.bundle / "recovery.json").write_text(json.dumps(recovery))
        self.assertEqual(migrate.make_plan(self.bundle)[0]["environment"], "production")
        acceptance["checks"]["workload-oidc"] = "pending"
        (self.bundle / "staging/acceptance.json").write_text(json.dumps(acceptance))
        with self.assertRaises(ValueError):
            migrate.make_plan(self.bundle)
        acceptance["checks"]["workload-oidc"] = "passed"
        (self.bundle / "staging/acceptance.json").write_text(json.dumps(acceptance))
        recovery["databases"]["course"]["host"] = "other.example.invalid"
        (self.bundle / "recovery.json").write_text(json.dumps(recovery))
        with self.assertRaises(ValueError):
            migrate.make_plan(self.bundle)

    def test_unexpected_runtime_or_unverified_cleanup_blocks(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="a" * 12 + " unexpected\n")):
            with self.assertRaises(ValueError):
                migrate.suspend_runtime("staging", {})


if __name__ == "__main__":
    unittest.main()
