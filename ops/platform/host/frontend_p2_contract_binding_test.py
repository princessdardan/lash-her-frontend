"""P2 additive identity cannot be dropped, relabeled or inherited by P1."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import migrate
import migrate_test
import frontend_release_adapters as adapter
import vercel

P2 = {"contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "9" * 64}


class Phase2ContractBindingTests(unittest.TestCase):
    def test_atomic_pair_and_exact_equality_preserve_unmodified_p1(self):
        self.assertEqual(migrate.contract_identity({"contractManifestSha256": "sha256:" + "a" * 64}), {})
        self.assertEqual(migrate.require_contract_identity({}, {}), {})
        self.assertEqual(migrate.require_contract_identity(P2, dict(P2)), P2)
        for changed in ({"contractPhase": "p2"}, {"phase2ContractManifestSha256": P2["phase2ContractManifestSha256"]},
                {**P2, "contractPhase": "p1"}, {**P2, "phase2ContractManifestSha256": "9" * 64},
                {**P2, "phase2ContractManifestSha256": "sha256:" + "0" * 64}):
            with self.assertRaises(ValueError):
                migrate.contract_identity(changed)
        for expected, actual in ((P2, {}), ({}, P2), (P2, {**P2, "phase2ContractManifestSha256": "sha256:" + "8" * 64})):
            with self.assertRaisesRegex(ValueError, "P2_CONTRACT_BINDING_MISMATCH"):
                migrate.require_contract_identity(expected, actual)

    def setUp(self):
        self.fixture = migrate_test.MigrationDriverTests(methodName="runTest")
        self.fixture.setUp()
        self.fixture.add_frontend()

    def tearDown(self):
        self.fixture.tearDown()

    def p2(self):
        f = self.fixture
        f.release.update(P2)
        f.release["frontendMigration"].update(P2)
        for job in f.jobs.values():
            job.update(P2)
        f.save()

    def test_candidate_api_jobs_and_frontend_source_job_bind_new_manifest_without_repurposing_v1(self):
        self.p2()
        selected, jobs = migrate.make_plan(self.fixture.bundle)
        self.assertEqual(selected["contractManifestSha256"], "sha256:" + "d" * 64)
        self.assertEqual(jobs["course"]["job"]["contractSha256"], "d" * 64)
        self.assertEqual(migrate.contract_identity(jobs["frontend"]["job"]), P2)
        # SQL-only baseline catalogs retain their original shape/hash.
        self.assertNotIn("contractPhase", json.loads(jobs["frontend"]["schema"]))
        for selected in [self.fixture.release["frontendMigration"], *self.fixture.jobs.values()]:
            original = dict(selected)
            selected.pop("contractPhase")
            self.fixture.save()
            with patch.object(migrate.subprocess, "run") as subprocess:
                with self.assertRaisesRegex(ValueError, "P2_CONTRACT_IDENTITY_REQUIRED"):
                    migrate.make_plan(self.fixture.bundle)
                subprocess.assert_not_called()
            selected.clear(); selected.update(original)
        self.fixture.save()

    def test_new_p2_container_receipt_and_terminal_must_both_carry_exact_pair(self):
        self.p2()
        f = self.fixture
        credentials = {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
            "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}
        def docker(args, **kwargs):
            result = f.fake_docker(args, **kwargs)
            if "--execute" in args:
                mount = next(value for value in args if isinstance(value, str) and value.endswith("dst=/run/release-receipts"))
                directory = Path(mount.split(",src=")[1].split(",dst=")[0])
                file = directory / "job-outcome.json"
                value = json.loads(file.read_text()); value.update(P2); file.write_text(json.dumps(value))
            return result
        with patch.dict(os.environ, credentials), patch.object(migrate.subprocess, "run", side_effect=docker):
            result = migrate.execute(f.bundle, f.results, True, "staging/test-release", f.root / "release.lock",
                before_frontend_migration=lambda _selected, _attempt: {"status": "FRONTEND_PRODUCERS_SUSPENDED", "environment": "staging", "projectId": "prj_fixture"})
        self.assertEqual(migrate.contract_identity(result), P2)
        self.assertEqual(result["status"], "DATABASES_VERIFIED")

    def test_new_p2_refuses_legacy_minimal_terminal_after_first_api_job_without_continuing(self):
        self.p2()
        f = self.fixture
        credentials = {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
            "FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}
        with patch.dict(os.environ, credentials), patch.object(migrate.subprocess, "run", side_effect=f.fake_docker) as commands:
            with self.assertRaisesRegex(ValueError, "P2_CONTRACT_BINDING_MISMATCH"):
                migrate.execute(f.bundle, f.results, True, "staging/test-release", f.root / "release.lock",
                    before_frontend_migration=lambda _selected, _attempt: {"status": "FRONTEND_PRODUCERS_SUSPENDED", "environment": "staging", "projectId": "prj_fixture"})
        self.assertEqual(sum("--execute" in call.args[0] for call in commands.call_args_list), 1)
        outcome = migrate.read_json(f.results / "test-release", "migration-outcome.json")
        self.assertEqual(outcome["status"], "FAILED_REQUIRES_REVIEW")
        self.assertEqual(migrate.contract_identity(outcome), P2)

    def test_adapter_identity_keeps_p2_fields_and_partial_pair_refuses(self):
        context = {"plan": {"environment": "staging", "actionId": "owned-p2", "sourceCommit": "a" * 40, "targetSha256": "b" * 64},
            "candidate": {"version": 2, "environment": "staging", "releaseId": "owned-p2", **P2,
                "sources": {"frontend": {"repository": "https://github.com/princessdardan/lash-her-frontend.git", "commit": "a" * 40, "requiredChecks": "passed"}},
                "workload": {"projectId": vercel.PROJECTS["staging"], "environment": "production"}},
            "bindings": {"environment": "staging", "actionId": "owned-p2", "sourceCommit": "a" * 40, "targetSha256": "b" * 64,
                "projectId": vercel.PROJECTS["staging"], "teamId": vercel.TEAM, "repositoryId": vercel.REPOSITORY_ID}}
        self.assertEqual(migrate.contract_identity(adapter.identity(context)), P2)
        context["candidate"].pop("phase2ContractManifestSha256")
        with self.assertRaisesRegex(ValueError, "P2_CONTRACT_IDENTITY_REQUIRED"):
            adapter.identity(context)


if __name__ == "__main__":
    unittest.main()
