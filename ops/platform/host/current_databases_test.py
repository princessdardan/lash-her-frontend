import hashlib
import copy
import json
import subprocess
import unittest
from unittest.mock import patch

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
                record.update(version=2, qualificationTargetProfile=job["qualificationTargetProfile"])
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
