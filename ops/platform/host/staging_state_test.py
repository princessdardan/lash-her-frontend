import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import migrate
import release_test
import staging_state as state


class StagingStateTests(unittest.TestCase):
    def setUp(self):
        self.legacy_runtime = release_test.historical_runtime_fixture()
        self.runtime = release_test.RuntimeReleaseTests()
        self.runtime.setUp()
        fixture = self.runtime.fixture
        fixture.add_frontend()
        for name in ("course", "community"):
            fixture.jobs[name]["target"]["serverMajor"] = 18
            fixture.jobs[name]["target"]["artifactSha256"] = "1" * 64
        fixture.jobs["frontend"]["target"]["approvedPendingTags"] = []
        fixture.save()
        with self.runtime.patches(), patch.dict(os.environ, {"FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}):
            self.runtime.execute()
        self.database = self.runtime.results / "test-release"
        self.receipts = self.runtime.results / "runtime-test-release"
        self.destination = self.runtime.root / "restored-input"
        self.database_value = migrate.read_json(self.database, "migration-outcome.json")
        # The older shared driver intentionally emits minimal database receipts.
        # Complete this fixture with the fields emitted by the actual CLI.
        for name, job in fixture.jobs.items():
            file = self.database / name / "database-receipt.json"
            receipt = json.loads(file.read_text())
            receipt.update(target={key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")},
                           trafficAuthorized=False)
            if name != "frontend":
                receipt.update(applyStarted=True, applyCompleted=True, postAppliedCount=1,
                               artifactSha256=job["target"]["artifactSha256"])
            file.write_text(json.dumps(receipt))
            self.database_value["databaseReceiptSha256"][name] = hashlib.sha256(file.read_bytes()).hexdigest()
        (self.database / "migration-outcome.json").write_text(json.dumps(self.database_value))
        ready = migrate.read_json(self.receipts, "runtime-outcome.json")
        ready["migrationOutcomeSha256"] = hashlib.sha256((self.database / "migration-outcome.json").read_bytes()).hexdigest()
        (self.receipts / "runtime-outcome.json").write_text(json.dumps(ready))
        self.candidate_hash = hashlib.sha256((self.database / "candidate.json").read_bytes()).hexdigest()
        self.args = (self.runtime.bundle, self.runtime.configuration, self.database, self.receipts, self.runtime.compose, self.candidate_hash)

    def tearDown(self):
        self.runtime.tearDown(); self.legacy_runtime.close()

    def bind(self):
        return state.retained_state(*self.args)

    def restore(self, **changes):
        selected, jobs, plan, compose = self.bind()
        values = {"source": self.runtime.configuration, "destination": self.destination,
                  "selected": selected, "jobs": jobs, "compose": compose,
                  "expected_hashes": state.configuration_hashes(self.runtime.configuration),
                  "original_machine": plan["originalHostMachineId"], "new_machine": "2" * 32,
                  "action": "restore-test-release"}
        values.update(changes)
        return state.restored_configuration(**values)

    def test_actual_receipt_chain_binds_all_three_databases_without_reading_credentials_or_running_commands(self):
        for service in state.runtime.ENV_FILES:
            (self.runtime.configuration / (service + ".env")).unlink()
        with patch.object(state.runtime, "command", side_effect=AssertionError("Command invoked")):
            _, _, plan, _ = self.bind()
        self.assertEqual(set(plan["completedDatabaseStages"]), {"frontend", "course", "community"})
        self.assertEqual(len(plan["originalContainers"]), 8)
        self.assertFalse(plan["migrationsExecuted"])
        self.assertTrue(plan["newMachineBindingRequired"])
        self.assertEqual(plan["currentDatabaseChecksRequired"], ["frontend-read-only-current", "course-read-only-current", "community-read-only-current"])

    def test_changed_candidate_or_leaf_database_receipt_refuses(self):
        with self.assertRaisesRegex(ValueError, "CANDIDATE_BINDING"):
            state.retained_state(*self.args[:-1], "a" * 64)
        file = self.database / "course/database-receipt.json"
        file.write_bytes(file.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "DATABASE_RECEIPT"):
            self.bind()

    def test_changed_terminal_status_or_runtime_binding_refuses(self):
        file = self.database / "community/job-outcome.json"
        original = file.read_bytes()
        file.write_text('{"status":"FAILED_REQUIRES_REVIEW"}')
        with self.assertRaisesRegex(ValueError, "DATABASE_RECEIPT"):
            self.bind()
        file.write_bytes(original)
        ready = migrate.read_json(self.receipts, "runtime-outcome.json")
        ready["migrationOutcomeSha256"] = "0" * 64
        (self.receipts / "runtime-outcome.json").write_text(json.dumps(ready))
        with self.assertRaisesRegex(ValueError, "RUNTIME_BINDING"):
            self.bind()

    def test_configuration_copy_changes_only_new_machine_metadata_and_preserves_original_inputs(self):
        original = state.configuration_hashes(self.runtime.configuration)
        result = self.restore()
        self.assertEqual(state.configuration_hashes(self.runtime.configuration), original)
        for name, digest in original.items():
            if name != "runtime.json":
                self.assertEqual(result["restoredSha256"][name], digest)
            self.assertEqual((self.destination / name).stat().st_mode & 0o777, 0o600)
        target = migrate.read_json(self.destination, "runtime.json")
        self.assertEqual(target["hostMachineId"], "2" * 32)
        self.assertEqual(target["maintenanceRef"], "staging/restore-test-release")
        self.assertEqual((self.destination / "compose.yaml").read_bytes(), self.runtime.compose.read_bytes())
        self.assertFalse(result["containersStarted"])
        self.assertFalse(result["migrationsExecuted"])
        self.assertNotIn("private-fixture", json.dumps(result))
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)
        with self.assertRaisesRegex(ValueError, "FRESH_CONFIGURATION"):
            self.restore()

    def test_new_machine_must_differ_and_be_exact_before_copying_private_material(self):
        for identity in ("1" * 32, "0" * 32, "", "other-machine", "A" * 32):
            with self.assertRaisesRegex(ValueError, "DIFFERENT_EXACT_MACHINE"):
                self.restore(new_machine=identity)
            self.assertFalse(self.destination.exists())

    def test_changed_private_material_or_input_symlink_cannot_be_restored(self):
        original = state.configuration_hashes(self.runtime.configuration)
        file = self.runtime.configuration / "course-api.env"
        original_bytes = file.read_bytes()
        file.write_bytes(original_bytes + b"EXTRA=value\n")
        with self.assertRaisesRegex(ValueError, "CONFIGURATION_HASH"):
            self.restore(expected_hashes=original)
        self.assertFalse(self.destination.exists())
        file.unlink(); file.symlink_to(self.runtime.configuration / "course-publisher.env")
        with self.assertRaisesRegex(ValueError, "INPUT_SYMLINK"):
            self.restore(expected_hashes=original)
        self.assertFalse(self.destination.exists())

    def test_wrong_runtime_database_identity_refuses_even_with_matching_file_hash(self):
        file = self.runtime.configuration / "course-api.env"
        file.write_bytes(file.read_bytes().replace(b"runtime_role", b"migration_role"))
        with self.assertRaisesRegex(ValueError, "RUNTIME_DATABASE_TARGET"):
            self.restore()
        self.assertFalse(self.destination.exists())

    def test_private_configuration_is_not_written_into_a_checkout(self):
        (self.runtime.root / ".git").mkdir()
        with self.assertRaisesRegex(ValueError, "OUTSIDE_CHECKOUT"):
            self.restore()
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
