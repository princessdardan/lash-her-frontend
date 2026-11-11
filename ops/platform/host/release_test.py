import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import migrate
import migrate_test
import release


def historical_runtime_fixture():
    """Explicit original eight-service P1 evidence, never the current topology."""
    from contextlib import ExitStack
    import staging_state
    import staging_rollback
    stages = [("community-api", "course-api"), ("community-tls", "course-tls"),
        ("course-snapshot", "community-worker"), ("course-publisher",), ("gateway",)]
    stack = ExitStack()
    stack.enter_context(patch.object(release, "STAGES", stages))
    stack.enter_context(patch.object(release, "SERVICES", tuple(service for stage in stages for service in stage)))
    stack.enter_context(patch.object(release, "ENV_FILES", ("course-api", "course-publisher", "course-snapshot", "community-api", "community-worker")))
    stack.enter_context(patch.object(staging_state, "CONFIGURATION_FILES", ("runtime.json", *release.CONFIG_FILES, *release.TLS_FILES,
        *(service + ".env" for service in release.ENV_FILES))))
    stack.enter_context(patch.object(staging_rollback, "RECOVERY_STAGES", [stages[0], stages[1], ("course-publisher",), stages[2], stages[4]]))
    return stack


class RuntimeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.fixture = migrate_test.MigrationDriverTests()
        self.fixture.setUp()
        self.root, self.bundle, self.results = self.fixture.root, self.fixture.bundle, self.fixture.results
        self.configuration = self.root / "runtime"
        self.configuration.mkdir(mode=0o700)
        self.compose = self.root / "compose.yaml"
        self.compose.write_text("owned-fixture-compose")
        self.target = {"version": 1, "environment": "staging", "releaseId": "test-release", "hostMachineId": "1" * 32,
                       "previousReleaseRef": "initial/none", "maintenanceRef": "operator/maintenance"}
        self.gateway = {"appEnv": "staging", "environment": "production", "projectId": "prj_fixture", "publicHost": "gateway.example.invalid", "maintenance": True,
                        "courseOrigin": "https://course-tls:8443", "tlsKeyFile": "/tls/key.pem", "tlsCertFile": "/tls/cert.pem", "upstreamCaFile": "/tls/ca.pem"}
        policy = {name: {"owned": name} for name in ("course", "community")}
        self.fixture.release["runtime"] = {"composeSha256": "sha256:" + hashlib.sha256(self.compose.read_bytes()).hexdigest(), "privateTlsPolicies": policy}
        self.fixture.release["workload"] = {"projectId": "prj_fixture"}
        self.fixture.release["artifacts"]["gateway"] = {"image": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "f" * 64,
                "scan": "passed", "sbomSha256": "sha256:" + "d" * 64, "provenanceSha256": "sha256:" + "e" * 64}
        for job in self.fixture.jobs.values():
            job["runtimeRole"] = "runtime_role"
            job["target"]["port"] = 5432
        self.fixture.save()
        self.save("runtime.json", self.target)
        self.save("gateway.json", self.gateway)
        for name in ("course", "community"):
            self.save(f"{name}-tls.json", policy[name])
        for name in release.TLS_FILES:
            self.save(name, "owned-fixture-certificate")
        for service in release.ENV_FILES:
            name = service.split("-")[0]
            self.save(f"{service}.env", f"DATABASE_TARGET=staging\nSTAGING_DATABASE_URL=postgresql://runtime_role:private-fixture@{name}.example.invalid:5432/{name}_test?sslmode=verify-full\n" + ("" if service in ("course-media", "course-export-cleanup") else "INTERNAL_SERVICE_JWT_SECRET=literal$VALUE\n"))
        self.running, self.calls = set(), []

    def test_new_workers_have_closed_credential_scopes_and_independent_config_parsers(self):
        jobs = {name: {"job": job} for name, job in self.fixture.jobs.items()}
        for service in ("course-media", "course-export-cleanup"):
            raw = (self.configuration / (service + ".env")).read_bytes()
            self.assertEqual(release.environment_values(raw, "staging", service, jobs)["DATABASE_TARGET"], "staging")
            for field in ("INTERNAL_SERVICE_JWT_SECRET", "COURSE_USER_JWT_PRIVATE_KEY", "COMMUNITY_SIGNING_KEY", "MUX_WEBHOOK_SIGNING_SECRET", "RESEND_API_KEY"):
                with self.assertRaisesRegex(ValueError, "WORKER_CREDENTIAL_SCOPE_REFUSED"):
                    release.environment_values(raw + (field + "=private-fixture\n").encode(), "staging", service, jobs)
        self.assertIn("parseMuxMediaProcessEnv()", release.NODE_CONFIG_CHECKS["course-media"])
        self.assertIn("parseAccountExportProcessEnv()", release.NODE_CONFIG_CHECKS["course-export-cleanup"])
        self.assertIn("course-media", release.STAGES[2]); self.assertIn("course-export-cleanup", release.STAGES[2])

    def tearDown(self):
        self.fixture.tearDown()

    def test_profiled_runtime_wrapper_plans_without_changing_configuration_file_inventory(self):
        import staging_state
        original_files = staging_state.CONFIGURATION_FILES
        original_gateway = (self.configuration / "gateway.json").read_bytes()
        ref = self.fixture.profiled()
        self.target.update(version=2, qualificationTargetProfile=ref)
        self.gateway.update(ownerId="team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId="prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
                            publicHost="api-staging.lashher.com")
        self.save("runtime.json", self.target); self.save("gateway.json", self.gateway)
        gateway = (self.configuration / "gateway.json").read_bytes()
        with patch.object(subprocess, "run", side_effect=AssertionError("external IO")):
            plan = release.execute(self.bundle, self.configuration, self.results, self.compose, expected_profile=ref)
        self.assertEqual(plan["version"], 2); self.assertEqual(plan["qualificationTargetProfile"], ref)
        self.assertEqual(staging_state.CONFIGURATION_FILES, original_files)
        self.assertEqual(len(original_files), 19)
        self.assertNotEqual(gateway, original_gateway)  # Only this owned fixture's public identity was selected.
        self.assertNotIn(b"qualificationTargetProfile", gateway)
        self.assertEqual((self.configuration / "gateway.json").read_bytes(), gateway)
        selected, jobs, _, compose = release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)
        # The release hash binds original bytes, including their serialization.
        # Normalizing a valid reviewed candidate here would break the host join.
        candidate_raw = (json.dumps(selected, indent=2) + "\n").encode()
        (self.bundle / "release.candidate.json").write_bytes(candidate_raw)
        raw_jobs = {name: (json.dumps(info["job"], indent=2) + "\n").encode() for name, info in jobs.items()}
        for name, raw in raw_jobs.items():
            (self.bundle / f"jobs/{name}.json").write_bytes(raw)
        migration_snapshot = self.root / "profiled-migration-snapshot"
        release.snapshot_bundle(self.bundle, migration_snapshot, selected, jobs, expected_profile=ref)
        self.assertEqual((migration_snapshot / "release.candidate.json").read_bytes(), candidate_raw)
        for name, raw in raw_jobs.items():
            self.assertEqual((migration_snapshot / f"jobs/{name}.json").read_bytes(), raw)
        snapshot = self.root / "profiled-snapshot"
        release.snapshot_configuration(self.configuration, snapshot, selected, jobs, compose, expected_profile=ref)
        for name in original_files:
            self.assertEqual((snapshot / name).read_bytes(), (self.configuration / name).read_bytes())
        self.target["graphComplete"] = True; self.save("runtime.json", self.target)
        with self.assertRaisesRegex(ValueError, "REQUIRED"):
            release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)
        self.target.pop("graphComplete")
        self.target.pop("qualificationTargetProfile"); self.save("runtime.json", self.target)
        with self.assertRaisesRegex(ValueError, "REQUIRED"):
            release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)

    def test_profiled_runtime_apply_and_invalid_context_refuse_before_input_or_scope_hooks(self):
        ref = self.fixture.profiled()
        with patch.object(migrate, "read_input", side_effect=AssertionError("read input")), \
             patch.object(release, "assert_host", side_effect=AssertionError("host IO")):
            with self.assertRaisesRegex(ValueError, "POLICY_REFUSED"):
                release.execute(self.bundle, self.configuration, self.results, self.compose, True,
                                _p2_scope=object(), expected_profile=ref)
            with self.assertRaisesRegex(ValueError, "UNKNOWN"):
                release.make_plan(self.bundle, self.configuration, self.compose, expected_profile={**ref, "id": "p2q-20261106"})
        self.assertEqual(list(self.results.iterdir()), [])

    def test_profiled_current_restore_rejects_missing_or_serialized_proof_before_io(self):
        ref = self.fixture.profiled()
        with patch.object(migrate, "read_input", side_effect=AssertionError("read input")), \
             patch.object(migrate, "execute", side_effect=AssertionError("migration executor")):
            for forged in (None, {"status": "CURRENT_DATABASES_READ_ONLY_VERIFIED", "migrationsExecuted": False}):
                with self.assertRaisesRegex(ValueError, "PROFILED_CURRENT_DATABASE_PROOF_REQUIRED"):
                    release.restore_profiled_current_runtime(self.bundle, self.configuration, self.results, self.compose,
                        forged, expected_profile=ref, _profiled_current_scope=object())
        self.assertEqual(list(self.results.iterdir()), [])

    def test_current_restore_composes_real_readonly_proof_and_runtime_without_migration(self):
        import current_databases as checks
        from current_databases_test import CurrentDatabasesTests
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker
        from p2_profiled_current_scope import COMMON, TARGET, P2ProfiledCurrentScope
        from staging_state import configuration_hashes
        from unittest.mock import Mock

        self.root = self.fixture.root = self.root.resolve()
        self.bundle = self.fixture.bundle = self.bundle.resolve()
        self.results = self.fixture.results = self.results.resolve()
        self.configuration, self.compose = self.configuration.resolve(), self.compose.resolve()
        self.fixture.add_frontend()
        ref = self.fixture.profiled()
        self.fixture.jobs["frontend"]["target"].update(approvedPendingTags=[], allowEmptyBootstrap=False)
        for name in ("course", "community"):
            self.fixture.jobs[name]["target"]["serverMajor"] = 18
        for carrier in (self.fixture.release, self.fixture.release["frontendMigration"], *self.fixture.jobs.values()):
            carrier.update(contractPhase="p2", phase2ContractManifestSha256="sha256:" + "e" * 64)
        self.fixture.save()
        self.target.update(version=2, qualificationTargetProfile=ref)
        self.gateway.update(ownerId="team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId="prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
                            publicHost="api-staging.lashher.com")
        self.save("runtime.json", self.target); self.save("gateway.json", self.gateway)
        selected, jobs, _, _ = release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)
        self.assertTrue(all(jobs[name]["job"]["target"]["approvedPendingTags"] for name in ("course", "community")))
        candidate_sha = migrate.file_hash(migrate.read_input(self.bundle, "release.candidate.json"))
        job = jobs["frontend"]["job"]
        journal = [{"hash": "b" * 64, "created_at": "1"}]
        receipt = {**{key: job[key] for key in COMMON}, "version": 2, "qualificationTargetProfile": ref,
                   "target": {key: job["target"][key] for key in TARGET}, "status": "DATABASE_VERIFIED", "service": "frontend",
                   "migrationMode": "verify-current-only", "readOnlyVerified": True, "schemaVerified": True,
                   "runtimeRoleVerified": True, "trafficAuthorized": False, "before": journal, "after": journal, "applied": []}
        self.gateway["admission"] = {"file": "/admission/state.json", "releaseId": selected["releaseId"], "candidateSha256": candidate_sha}
        self.save("gateway.json", self.gateway)
        parent = object.__new__(P2ProfiledCurrentRecoveryBroker)
        parent.bundle, parent.selected, parent.jobs = self.bundle, selected, jobs
        parent.initial = {"recoveryActionId": "owned-current-restore", "disposition": "restore-current-runtime",
                          "apiJobSha256": migrate.profiled_current_job_hashes(self.bundle)}
        parent.directory = self.root / "parent"
        parent.directory.mkdir(mode=0o700)
        parent.frontend_raw = json.dumps(receipt).encode()
        parent.continuation_started_raw = b'{"status":"FRONTEND_CONTINUATION_STARTED"}\n'
        migrate.write_exact_bytes(parent.directory, "frontend-original-database-receipt.json", parent.frontend_raw)
        migrate.write_exact_bytes(parent.directory, "frontend-continuation-started.json", parent.continuation_started_raw)
        # Project the container and gateway boundaries. The real checker
        # produces the in-process proof that the runtime consumer must adopt.
        db = CurrentDatabasesTests()
        db.selected, db.jobs, db.output = selected, jobs, self.root / "read-only-result"
        db.checker = self.root / "checker.mjs"
        db.checker.write_text("// owned fixture\n")
        db.checker_hash = migrate.file_hash(db.checker.read_bytes())
        db.credentials = {name: name + "-private-fixture" for name in ("course", "community")}
        db.calls, db.bad_frontend, db.bad_api, db.bad_cleanup = [], False, False, False
        lock_path = self.root / "release.lock"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        scope = P2ProfiledCurrentScope(fd, lock_path, lambda: None, receipt, candidate_sha, release=selected, jobs=jobs,
            configuration_sha256=configuration_hashes(self.configuration), recovery_action_id=parent.action_id())
        parent.lock_fd, parent.scope = fd, scope
        scope.bind_runtime_parent(parent)
        def docker(args, **kwargs):
            if args[1] == "compose" and "up" in args:
                self.calls.append(args)
                self.running.update(args[args.index("90") + 1:])
                self.assertEqual(migrate.read_json(db.output, "current-databases-outcome.json")["status"],
                                 "CURRENT_DATABASES_READ_ONLY_VERIFIED")
                with lock_path.open() as lock, self.assertRaises(BlockingIOError):
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return subprocess.CompletedProcess(args, 0, "", "")
            return self.docker(args, **kwargs)
        try:
            with patch.object(scope, "run", side_effect=lambda args, *, env, input=None, **opts: db.run_child(args, env, input)):
                proof = checks.check_all(selected, jobs, db.output, db.credentials, db.checker, db.checker_hash,
                                         expected_profile=ref, _profiled_current_scope=scope)
            boundary = Mock(api_suspension_started=False, api_suspension_finished=False, stopped=False)
            boundary.before_api_suspension.side_effect = lambda: setattr(boundary, "api_suspension_started", True)
            boundary.after_api_suspension.side_effect = lambda: setattr(boundary, "api_suspension_finished", True)
            scope.prior_gateway = boundary
            with patch.object(scope, "run", side_effect=docker), patch.object(release, "assert_host"), \
                    patch.object(P2ProfiledCurrentRecoveryBroker, "runtime_ready") as ready, \
                    patch.object(migrate, "execute", side_effect=AssertionError("recovery invoked the migration executor")):
                outcome = release.restore_profiled_current_runtime(self.bundle, self.configuration, self.results, self.compose,
                    proof, expected_profile=ref, _profiled_current_scope=scope)
            self.assertEqual(outcome["status"], "API_RUNTIME_READY")
            self.assertFalse(outcome["migrationsExecuted"])
            self.assertEqual(outcome["currentDatabasesOutcomeSha256"],
                             migrate.file_hash(migrate.read_input(db.output, "current-databases-outcome.json")))
            self.assertEqual(ready.call_args.args[2], db.output)
            self.assertEqual(self.running, set(release.SERVICES))
            self.assertEqual(len([args for args, _, _ in db.calls if args[1] == "run"]), 2)
        finally:
            scope.revoke()
            os.close(fd)

    def test_replacement_continuation_runs_only_pinned_api_jobs_and_retains_original_frontend_bytes(self):
        self._assert_replacement_continuation(supplemented=False)

    def test_replacement_recovery_role_supplement_checks_both_roles_before_apply(self):
        self._assert_replacement_continuation(supplemented=True)

    def test_replacement_recovery_refuses_before_apply_when_either_role_preflight_fails(self):
        self._assert_replacement_continuation(supplemented=True, refuse_role=True)

    def _assert_replacement_continuation(self, *, supplemented, refuse_role=False):
        from unittest.mock import Mock
        import p2_frontend_replacement_parent as replacement
        from p2_profiled_current_scope import COMMON, TARGET, P2ProfiledReplacementScope, _replacement_producer_bytes
        from p2_replacement_runtime_containment import INTENT, REVIEW, replacement_write_label
        from staging_state import configuration_hashes

        self.root = self.fixture.root = self.root.resolve()
        self.bundle = self.fixture.bundle = self.bundle.resolve()
        self.results, self.configuration, self.compose = self.results.resolve(), self.configuration.resolve(), self.compose.resolve()
        self.fixture.add_frontend()
        ref = self.fixture.profiled()
        for carrier in (self.fixture.release, self.fixture.release["frontendMigration"], *self.fixture.jobs.values()):
            carrier.update(contractPhase="p2", phase2ContractManifestSha256="sha256:" + "e" * 64)
        runtime_role = {"name": "lash_her_frontend_staging_runtime_p2", "oid": "18"}
        owner = {"name": "lash_her_frontend_staging_admission_owner_p2", "oid": "17"}
        self.fixture.jobs["frontend"]["target"].update(runtimeRole=runtime_role["name"],
                                                      approvedPendingTags=["0000_test", "0001_test"])
        if supplemented:
            for name in migrate.SERVICES:
                self.fixture.jobs[name]["target"]["allowEmptyBootstrap"] = False
        self.fixture.save()
        self.target.update(version=2, qualificationTargetProfile=ref)
        self.gateway.update(ownerId="team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId="prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
                            publicHost="api-staging.lashher.com")
        self.save("runtime.json", self.target)
        candidate_raw = migrate.read_input(self.bundle, "release.candidate.json")
        candidate_sha = migrate.file_hash(candidate_raw)
        self.gateway["admission"] = {"file": "/admission/state.json", "releaseId": "test-release", "candidateSha256": candidate_sha}
        self.save("gateway.json", self.gateway)
        selected, jobs, _, _ = release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)
        job, schema = jobs["frontend"]["job"], jobs["frontend"]["schema"]
        probe = {"version": 1, "qualificationTargetProfile": ref, "operation": "verify-pre-bootstrap-lock",
                 "targetSha256": "d" * 64, "databaseOid": "11", "migrationRoleOid": "16", "marker": "a" * 64,
                 "backendPid": 123, "backendStart": "2026-11-09T12:30:01.123456Z"}
        physical_fields = {**probe, "status": "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", "environment": "staging",
                           "releaseId": "test-release", "sourceCommit": job["sourceCommit"], "readOnlyVerified": True,
                           "authorityIssued": False, "trafficAuthorized": False}
        raw = lambda value: (json.dumps(value, indent=2) + "\n").encode()
        physical = raw(physical_fields)
        probe.update(job=job, candidate=selected, baseline=json.loads(schema))
        base = {**{key: job[key] for key in COMMON}, "version": 2, "qualificationTargetProfile": ref, "service": "frontend",
                "operator": "Dardan", "migrationMode": "apply-forward", "target": {key: job["target"][key] for key in TARGET},
                "recoveryRef": job["recoveryRef"], "trafficAuthorized": False}
        rows = [{"hash": char * 64, "created_at": stamp} for char, stamp in (("b", "1000"), ("c", "1001"))]
        database = {**base, "status": "DATABASE_VERIFIED", "before": [], "after": rows,
                    "applied": [{"tag": tag, "hash": row["hash"]} for tag, row in zip(job["target"]["approvedPendingTags"], rows)],
                    "schemaVerified": True, "runtimeRoleVerified": True, "readOnlyVerified": False}
        database_raw = raw(database)
        started_raw = raw({**base, "status": "FRONTEND_CONTINUATION_STARTED", "databaseVerified": True})
        administrative_logins = [{"name": "reviewed_provider_admin", "oid": "21"}]
        readback = {**physical_fields, "status": "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED",
                    "operation": "verify-replacement-written", "physicalObservationSha256": migrate.file_hash(physical),
                    "databaseReceiptSha256": migrate.file_hash(database_raw), "continuationStartedSha256": migrate.file_hash(started_raw),
                    "owner": owner, "runtime": runtime_role, "producerSha256": "a" * 64, "appliedMigrationCount": 2,
                    "epoch": "1", "newWork": False, "recovery": False, "active": 0, "uncertain": 0,
                    "schemaVerified": True, "runtimeRoleVerified": True, "administrativeLogins": administrative_logins,
                    "effectiveLoginBoundaryVerified": True}
        readback_raw = raw(readback)
        for changed, code in (({**database, "sourceCommit": "c" * 40}, "DATABASE_RECEIPT"),
                              ({**database, "after": rows[::-1]}, "JOURNAL_RECEIPT"),
                              ({**database, "before": rows}, "DATABASE_RECEIPT")):
            altered = raw(changed)
            with self.assertRaisesRegex(ValueError, code):
                _replacement_producer_bytes(probe, physical, altered, started_raw,
                    raw({**readback, "databaseReceiptSha256": migrate.file_hash(altered)}), owner, runtime_role,
                    "a" * 64, administrative_logins)
        for altered in ({"active": False}, {"administrativeLogins": []}, {"effectiveLoginBoundaryVerified": False}):
            with self.assertRaisesRegex(ValueError, "INDEPENDENT_POSTFLIGHT"):
                _replacement_producer_bytes(probe, physical, database_raw, started_raw, raw({**readback, **altered}),
                                            owner, runtime_role, "a" * 64, administrative_logins)

        broker = object.__new__(replacement.ReplacementWriteBroker)
        broker.initial = {"mode": replacement.WRITE_MODE, "bundle": str(self.bundle), "candidateSha256": candidate_sha,
                          "sourceCommit": job["sourceCommit"], "environment": "staging", "qualificationTargetProfile": ref,
                          "reviewedPlanSha256": "e" * 64, "runtimeReviewSha256": "f" * 64}
        supplement_pins = {}
        if supplemented:
            action = "owned-role-recovery"
            self.results = self.results / action
            self.results.mkdir(mode=0o700)
            broker.initial["results"] = str(self.results)
            supplement_directory = self.results.parent / (action + "-role-policy")
            supplement_directory.mkdir(mode=0o700)
            for name in migrate.SERVICES:
                compiled = ("// owned supplement for " + name + "\n").encode()
                migrate.write_exact_bytes(supplement_directory, name + ".js", compiled)
                supplement_pins[name] = {"baseSourceCommit": jobs[name]["job"]["sourceCommit"],
                    "sourceCommit": "b" * 40, "sourceSha256": "c" * 64, "compiledSha256": migrate.file_hash(compiled)}
            broker.recovery = {"actionId": action, "rolePolicySupplement": supplement_pins}
            self.running.clear()
        broker.plan = {"candidateSha256": candidate_sha, "sourceCommit": job["sourceCommit"], "targetSha256": probe["targetSha256"],
                       "environment": "staging", "releaseId": job["releaseId"], "qualificationTargetProfile": ref,
                       "schemaBaselineFileSha256": migrate.file_hash(schema),
                       "replacement": {"administrativeLogins": administrative_logins},
                       "frontendJobSha256": migrate.file_hash(migrate.read_input(self.bundle, "jobs/frontend.json"))}
        broker.directory, broker.probe, broker.write_observation = self.root / "broker", probe, physical
        broker.directory.mkdir(mode=0o700)
        guard_readback = broker.directory / "p2-frontend-replacement-written-observation.json"
        migrate.write_exact_bytes(broker.directory, guard_readback.name, readback_raw)
        lock = self.root / "release.lock"
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        broker.lock_fd = fd
        api_pins = migrate.profiled_current_job_hashes(self.bundle)
        config_pins = configuration_hashes(self.configuration)
        raw_review = raw({"apiJobSha256": api_pins, "configurationSha256": config_pins,
                          "configuration": str(self.configuration)})
        broker.initial["runtimeReviewSha256"] = migrate.file_hash(raw_review)
        migrate.write_exact_bytes(broker.directory, REVIEW, raw_review)
        intent = {"version": 1, "qualificationTargetProfile": ref, "environment": "staging",
                  "releaseId": job["releaseId"], "sourceCommit": job["sourceCommit"], "candidateSha256": candidate_sha,
                  "targetSha256": probe["targetSha256"], "reviewedPlanSha256": broker.initial["reviewedPlanSha256"],
                  "runtimeReviewSha256": broker.initial["runtimeReviewSha256"], "status": "P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED",
                  "apiJobSha256": api_pins, "configurationSha256": config_pins, "postflightSha256": migrate.file_hash(readback_raw),
                  "trafficAuthorized": False}
        migrate.write_json(broker.directory, INTENT, intent)
        credentials = {f"{name.upper()}_STAGING_DATABASE_URL": f"owned-{name}-private" for name in migrate.SERVICES}
        applied_apis = []
        proved_roles = []
        attempt = self.results / "migration-profiled-frontend-replacement-test-release"
        runtime_images = [selected["artifacts"][key]["image"] for key in ("gateway", "courseRuntime", "communityRuntime")]
        migration_images = [jobs[name]["image"] for name in migrate.SERVICES]

        def docker(args, *, env, **kwargs):
            self.assertNotIn("ops/platform/frontend-image.mjs", args)
            self.assertNotIn(jobs["frontend"]["image"], args)
            self.assertNotIn(replacement.CREDENTIAL, env)
            self.assertNotEqual(args[:2], ["docker", "pull"])
            if args[1] == "run":
                self.assertEqual(args[args.index("--label") + 1], replacement_write_label(broker.initial["reviewedPlanSha256"]))
            if supplemented and any(mode in args for mode in ("--check-profiled-current", "--eval", "--execute-profiled-current")):
                # Runtime preflight also uses --eval; it must never carry an API overlay.
                image = args[args.index("--entrypoint") + 2]
                if image in migration_images:
                    name = next(name for name in migrate.SERVICES if image == jobs[name]["image"])
                    self.assertIn(f"type=bind,src={attempt / (name + '-role-policy.js')},dst={migrate._ROLE_POLICY_MODULE},readonly", args)
                    self.assertEqual(args[args.index("--pull") + 1], "never")
                    if "--eval" in args:
                        self.assertFalse(applied_apis)
                        self.assertEqual(args[args.index("--eval") + 1], migrate._ROLE_POLICY_PREFLIGHT)
                        self.assertEqual(env["STAGING_DATABASE_URL"], credentials[f"{name.upper()}_STAGING_DATABASE_URL"])
                        proved_roles.append(name)
                        if refuse_role and name == "community":
                            return subprocess.CompletedProcess(args, 1, b"", b"private-diagnostic")
                        proof = {"status": "REPLACEMENT_API_ROLE_PREFLIGHT_PASS", "environment": "staging",
                                 "service": jobs[name]["service"], "releaseId": job["releaseId"],
                                 "sourceCommit": jobs[name]["job"]["sourceCommit"],
                                 "migrationImageDigest": jobs[name]["job"]["migrationImageDigest"],
                                 "qualificationTargetProfile": ref, "compiledSha256": supplement_pins[name]["compiledSha256"],
                                 "readOnlyVerified": True, "tlsVerified": True, "runtimeRoleVerified": True,
                                 "migrationAuthorized": False}
                        return subprocess.CompletedProcess(args, 0, raw(proof), b"")
                else:
                    self.assertFalse(any(migrate._ROLE_POLICY_MODULE in item for item in args))
            if "--target-file-profiled-current" in args:
                image = args[args.index("--entrypoint") + 2]
                name = next(name for name in migrate.SERVICES if image == jobs[name]["image"])
                target = jobs[name]["job"]["target"]
                proof = {"schemaVersion": 2, "qualificationTargetProfile": ref, "status": "READ_ONLY_PREFLIGHT_PASS",
                         "service": jobs[name]["service"], "environment": "staging", "appliedCount": 7,
                         "pendingTags": target["approvedPendingTags"], "artifactSha256": target["artifactSha256"],
                         "databaseIdentityMatched": True, "tlsVerified": True, "migrationAuthorized": False}
                return subprocess.CompletedProcess(args, 0, raw(proof), b"")
            if "--execute-profiled-current" in args:
                self.assertEqual(proved_roles, list(migrate.SERVICES) if supplemented else [])
                for image in migration_images:
                    self.assertIn(["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image], self.calls)
                name = next(name for name in migrate.SERVICES if f"lash-migrate-{name}-test-release" in args)
                applied_apis.append(name)
                self.assertEqual(env["STAGING_DATABASE_URL"], credentials[f"{name.upper()}_STAGING_DATABASE_URL"])
                mount = next(value for value in args if value.endswith("dst=/run/release-receipts"))
                receipts = Path(mount.split(",src=")[1].split(",dst=")[0])
                info = jobs[name]
                receipt = {**info["job"], "service": info["service"], "status": "DATABASE_VERIFIED"}
                terminal = {**migrate.contract_identity(selected), "status": "DATABASE_VERIFIED", "qualificationTargetProfile": ref}
                if name == "community":
                    terminal["schemaVersion"] = 2
                (receipts / "database-receipt.json").write_bytes(raw(receipt))
                (receipts / "job-outcome.json").write_bytes(raw(terminal))
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[1] == "compose" and "up" in args:
                self.calls.append(args)
                self.running.update(args[args.index("90") + 1:])
                with lock.open() as contender, self.assertRaises(BlockingIOError):
                    fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(migrate.read_json(attempt, "migration-outcome.json", expected_profile=ref)["status"],
                                 "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN")
                return subprocess.CompletedProcess(args, 0, "", "")
            return self.docker(args, env=env, **kwargs)

        def scope_for_replacement():
            return P2ProfiledReplacementScope(broker, postflight_raw=readback_raw, database_raw=database_raw,
                started_raw=started_raw, owner=owner, runtime=runtime_role, producer_sha256="a" * 64,
                api_job_sha256=api_pins, configuration_sha256=config_pins)

        with (patch.object(replacement, "LOCK", lock),
              patch.object(replacement.ReplacementWriteBroker, "verify_replacement_runtime", create=True),
              patch.object(replacement.ReplacementWriteBroker, "verify_replacement_mutation") as fresh,
              patch.object(replacement.ReplacementWriteBroker, "replacement_runtime_ready", create=True) as ready):
            candidate_path = self.bundle / "release.candidate.json"
            candidate_path.write_bytes(candidate_raw + b" ")
            with self.assertRaisesRegex(ValueError, replacement.REFUSED):
                scope_for_replacement()
            candidate_path.write_bytes(candidate_raw)
            guard_readback.write_bytes(readback_raw + b" ")
            with self.assertRaisesRegex(ValueError, "GUARD_READBACK_CHANGED"):
                scope_for_replacement()
            guard_readback.write_bytes(readback_raw)
            (broker.directory / INTENT).write_bytes(raw({**intent, "runtimeReviewSha256": "b" * 64}))
            with self.assertRaisesRegex(ValueError, "RUNTIME_CONTAINMENT_REFUSED"):
                scope_for_replacement()
            (broker.directory / INTENT).write_bytes(raw(intent))
            scope = broker.scope = scope_for_replacement()
            self.addCleanup(scope.revoke)
            scope.prior_gateway = Mock(stopped=supplemented, api_suspension_started=False, api_suspension_finished=False)
            scope.prior_gateway.before_api_suspension.side_effect = lambda: setattr(scope.prior_gateway, "api_suspension_started", True)
            scope.prior_gateway.after_api_suspension.side_effect = lambda: setattr(scope.prior_gateway, "api_suspension_finished", True)
            from p2_release_scope import P2ReleaseScope
            with patch.object(P2ReleaseScope, "run") as run:
                fresh.side_effect = ValueError("OWNED_FRESH_LOCK_LOST")
                with self.assertRaisesRegex(ValueError, "OWNED_FRESH_LOCK_LOST"):
                    scope.run(["docker", "run", "owned-image"], timeout=1)
                run.assert_not_called()
                scope.run(["docker", "inspect", "owned-image"], timeout=1)
                run.assert_called_once()
                fresh.side_effect = None
            with patch.object(release, "make_plan", side_effect=AssertionError("wrong mode reached I/O")):
                with self.assertRaisesRegex(ValueError, "CURRENT_PROCESS_LOCAL_SCOPE_REQUIRED"):
                    release.execute(self.bundle, self.configuration, self.results, self.compose, True,
                                    expected_profile=ref, _profiled_current_scope=scope)
                with self.assertRaisesRegex(ValueError, "REPLACEMENT_PROCESS_LOCAL_SCOPE_REQUIRED"):
                    release.execute(self.bundle, self.configuration, self.results, self.compose, True, _p2_scope=scope)
            with patch.object(migrate, "make_plan", side_effect=AssertionError("direct migration reached I/O")):
                with self.assertRaisesRegex(ValueError, "FIXED_RUNTIME_CONTINUATION_REQUIRED"):
                    migrate.execute(self.bundle, self.results, True, expected_profile=ref, _profiled_replacement_scope=scope)
            course = self.bundle / "jobs/course.json"
            original_course = course.read_bytes()
            course.write_bytes(original_course + b" ")
            with self.assertRaisesRegex(ValueError, "API_JOB_BYTES_CHANGED"):
                scope.api_job_bytes("course")
            course.write_bytes(original_course)
            with (patch.object(scope, "run", side_effect=docker), patch.object(release, "assert_host"),
                  patch.dict(os.environ, credentials, clear=True)):
                if refuse_role:
                    with self.assertRaisesRegex(ValueError, "REPLACEMENT_RECOVERY_ROLE_POLICY_REFUSED"):
                        release.execute_profiled_replacement_runtime(self.bundle, self.configuration, self.results,
                            self.compose, expected_profile=ref, _profiled_replacement_scope=scope)
                    self.assertEqual(proved_roles, list(migrate.SERVICES))
                    self.assertFalse(applied_apis or self.running or scope.runtime_suspension_started)
                    self.assertTrue((attempt / "course-recovery-role-preflight.json").is_file())
                    self.assertFalse((attempt / "community-recovery-role-preflight.json").exists())
                    migration = migrate.read_json(attempt, "migration-outcome.json", expected_profile=ref)
                    self.assertEqual(migration["phase"], "replacement-recovery-api-roles")
                    ready.assert_not_called()
                    return
                outcome = release.execute_profiled_replacement_runtime(self.bundle, self.configuration, self.results,
                    self.compose, expected_profile=ref, _profiled_replacement_scope=scope)
            self.assertEqual(ready.call_args.args[2], attempt)
            if supplemented:
                scope.prior_gateway.before_api_suspension.assert_not_called()
        self.assertEqual(self.calls[:len(runtime_images)], [
            ["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image]
            for image in runtime_images
        ])
        self.assertEqual(applied_apis, ["course", "community"])
        self.assertEqual(self.running, set(release.SERVICES))
        self.assertEqual((attempt / "candidate.json").read_bytes(), candidate_raw)
        self.assertEqual(tuple((attempt / "frontend" / name).read_bytes() for name in (
            "database-receipt.json", "frontend-continuation-started.json", "frontend-replacement-written-observation.json")),
            (database_raw, started_raw, readback_raw))
        self.assertFalse((attempt / "frontend-input").exists())
        self.assertTrue(outcome["frontendSqlApplied"])
        self.assertFalse(outcome["frontendSqlReplayed"])
        self.assertFalse(outcome["frontendReadOnlyVerified"])
        self.assertFalse(outcome["releaseAccepted"])
        self.assertEqual(outcome["frontendReplacementReadbackSha256"], migrate.file_hash(readback_raw))
        migration = migrate.read_json(attempt, "migration-outcome.json", expected_profile=ref)
        if supplemented:
            self.assertEqual(migration["apiRolePolicySupplement"], {
                name: {**pin, "readOnlyPreflightSha256": migrate.file_hash((attempt / f"{name}-recovery-role-preflight.json").read_bytes())}
                for name, pin in supplement_pins.items()})
        else:
            self.assertNotIn("apiRolePolicySupplement", migration)

    def test_profiled_runtime_requires_the_registered_project_and_gateway_origin(self):
        ref = self.fixture.profiled()
        self.target.update(version=2, qualificationTargetProfile=ref); self.save("runtime.json", self.target)
        with self.assertRaisesRegex(ValueError, "OBSERVATION_MISMATCH"):
            release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=ref)

    def test_actual_isolated_profiled_cli_can_only_plan_and_does_not_dispatch_a_scope(self):
        ref = self.fixture.profiled()
        self.target.update(version=2, qualificationTargetProfile=ref); self.save("runtime.json", self.target)
        self.gateway.update(ownerId="team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId="prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
                            publicHost="api-staging.lashher.com"); self.save("gateway.json", self.gateway)
        real_compose = Path(release.__file__).parents[1] / "compose.yaml"
        self.fixture.release["runtime"]["composeSha256"] = "sha256:" + hashlib.sha256(real_compose.read_bytes()).hexdigest()
        self.fixture.save()
        command = [sys.executable, "-I", str(Path(release.__file__)), str(self.bundle), str(self.configuration), str(self.results), "--profiled-current"]
        result = subprocess.run(command, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["qualificationTargetProfile"], ref)
        self.assertFalse(json.loads(result.stdout)["credentialsRead"])
        refused = subprocess.run([*command, "--apply"], capture_output=True)
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(json.loads(refused.stderr)["status"], "API_RELEASE_REFUSED")
        self.assertEqual(list(self.results.iterdir()), [])

    def save(self, relative, value):
        file = self.configuration / relative
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file.write_text(json.dumps(value) if isinstance(value, dict) else value)
        file.chmod(0o600)

    def execute(self, apply=True, confirmation="staging/test-release"):
        return release.execute(self.bundle, self.configuration, self.results, self.compose, apply, confirmation, self.root / "release.lock")

    def docker(self, args, **kwargs):
        self.calls.append(args)
        env = kwargs["env"]
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("COURSE_STAGING_DATABASE_URL", env)
        self.assertNotIn("COMPOSE_FILE", env)
        self.assertEqual(env.get("DOCKER_CONTEXT"), "default")
        output = ""
        if args[1] == "compose":
            if "config" in args:
                environment = {service: ({"NODE_ENV": "production", "PORT": "4003" if service == "course-media" else "4004", "NODE_OPTIONS": "--max-old-space-size=128"} if service in ("course-media", "course-export-cleanup") else {"DATABASE_TARGET": "staging", "INTERNAL_SERVICE_JWT_SECRET": "literal$VALUE"}) for service in release.ENV_FILES}
                output = json.dumps({"services": {service: {"image": self.fixture.release["artifacts"][release.IMAGE_KEYS[service]]["image"],
                                "environment": environment.get(service, {})} for service in release.SERVICES}})
            elif "up" in args:
                self.assertIn("--no-deps", args)
                self.assertEqual(args[args.index("--pull") + 1], "never")
                self.running.update(args[args.index("90") + 1:])
                with (self.root / "release.lock").open() as stream:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(json.loads((self.results / "test-release/migration-outcome.json").read_text())["status"], "DATABASES_VERIFIED")
            elif "exec" in args:
                output = json.dumps({"status": "API_RUNTIME_BOUNDARIES_PASS", "checks": sorted(release.PROBE_CHECKS)})
            elif "ps" in args:
                output = format(release.SERVICES.index(args[-1]) + 1, "064x")
        elif args[1:3] == ["image", "inspect"]:
            output = args[-1].split("@")[1]
        elif args[1] == "inspect":
            service = release.SERVICES[int(args[-1], 16) - 1]
            image = self.fixture.release["artifacts"][release.IMAGE_KEYS[service]]["image"].split("@")[1]
            output = f'{image}|true|{"none" if service.endswith("-tls") else "healthy"}|lash-her-staging|{service}'
        elif args[1] == "ps":
            if "--format" in args:
                output = "\n".join(f'{format(release.SERVICES.index(service)+1, "064x")} {service}' for service in self.running)
            else:
                output = "\n".join(format(release.SERVICES.index(service)+1, "064x") for service in self.running)
        elif args[1] == "stop":
            self.running.clear()
        elif "--execute" in args:
            return self.fixture.fake_docker(args, **kwargs)
        return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

    def patches(self):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(release, "assert_host"))
        stack.enter_context(patch.object(subprocess, "run", side_effect=self.docker))
        stack.enter_context(patch.dict(os.environ, {"COURSE_STAGING_DATABASE_URL": "owned-fixture-url", "COMMUNITY_STAGING_DATABASE_URL": "owned-fixture-url",
                                                 "AWS_SECRET_ACCESS_KEY": "must-not-inherit", "COMPOSE_FILE": "untrusted"}))
        return stack

    def test_plan_never_reads_runtime_credentials_or_starts_processes(self):
        for service in release.ENV_FILES:
            (self.configuration / f"{service}.env").unlink()
        with patch.object(subprocess, "run", side_effect=AssertionError("Plan executed")):
            plan = self.execute(False)
        self.assertFalse(plan["credentialsRead"])
        self.assertFalse(plan["trafficAuthorized"])
        self.assertEqual(list(self.results.iterdir()), [])

    def test_optional_community_origin_is_exactly_the_private_tls_receiver(self):
        self.save("gateway.json", {**self.gateway, "communityOrigin": "https://community-tls:8443"})
        release.make_plan(self.bundle, self.configuration, self.compose)
        self.save("gateway.json", {**self.gateway, "communityOrigin": "https://unreviewed.example.invalid"})
        with self.assertRaisesRegex(ValueError, "GATEWAY_TARGET"):
            release.make_plan(self.bundle, self.configuration, self.compose)

    def test_confirmation_and_host_checks_precede_private_reads(self):
        with patch.object(release, "assert_host", side_effect=ValueError("WRONG_HOST")), patch.object(release, "snapshot_configuration", side_effect=AssertionError("Credentials read")):
            with self.assertRaisesRegex(ValueError, "EXPLICIT_OPERATOR"):
                self.execute(confirmation="production/test-release")
            with self.assertRaisesRegex(ValueError, "WRONG_HOST"):
                self.execute()
        self.assertEqual(list(self.results.iterdir()), [])

    def test_wrong_source_policy_gateway_or_immutable_image_is_refused(self):
        self.compose.write_text("changed-compose")
        with self.assertRaisesRegex(ValueError, "PINNED_COMPOSE"):
            self.execute(False)
        self.compose.write_text("owned-fixture-compose")
        self.gateway["projectId"] = "prj_other"; self.save("gateway.json", self.gateway)
        with self.assertRaisesRegex(ValueError, "GATEWAY_TARGET"):
            self.execute(False)
        self.gateway["projectId"] = "prj_fixture"; self.gateway["maintenance"] = False; self.save("gateway.json", self.gateway)
        with self.assertRaisesRegex(ValueError, "GATEWAY_TARGET"):
            self.execute(False)
        self.gateway["maintenance"] = True; self.save("gateway.json", self.gateway)
        self.save("course-tls.json", {"owned": "changed-peer"})
        with self.assertRaisesRegex(ValueError, "PINNED_PRIVATE_POLICY"):
            self.execute(False)

    def test_runtime_credentials_cannot_use_migration_role_other_target_or_weak_tls(self):
        raw = (self.configuration / "course-api.env").read_bytes()
        for changed in (raw.replace(b"runtime_role", b"migration_role"), raw.replace(b"course.example", b"other.example"),
                        raw.replace(b"verify-full", b"disable"), raw + b"AWS_SECRET_ACCESS_KEY=forbidden\n", raw.replace(b"staging\n", b"test\n")):
            with self.assertRaises(ValueError) as failure:
                release.environment_values(changed, "staging", "course-api", {name: {"job": job} for name, job in self.fixture.jobs.items()})
            self.assertNotIn("private-fixture", str(failure.exception))
        self.assertEqual(release.environment_values(raw, "staging", "course-api", {name: {"job": job} for name, job in self.fixture.jobs.items()})["INTERNAL_SERVICE_JWT_SECRET"], "literal$VALUE")

    def test_cached_preflight_cannot_pull_and_requires_valid_local_image_identity(self):
        selected, jobs, _, _ = release.make_plan(self.bundle, self.configuration, self.compose)
        snapshot = self.root / "preflight-snapshot"
        release.snapshot_configuration(self.configuration, snapshot, selected, jobs, self.compose.read_bytes())
        with self.patches():
            release.preflight(selected, snapshot, jobs, pull=False)
        self.assertFalse(any(args[1] == "pull" for args in self.calls))
        image_reads = [args for args in self.calls if args[1:3] == ["image", "inspect"]]
        self.assertEqual(len(image_reads), 3)
        self.assertTrue(all(args[args.index("--platform") + 1] == "linux/amd64" for args in image_reads))
        with patch.object(release, "command", return_value="not-an-image"), self.assertRaisesRegex(ValueError, "CACHED_RUNTIME_IMAGE"):
            release.preflight(selected, snapshot, jobs, pull=False)
        failure = subprocess.CalledProcessError(1, ["docker", "image", "inspect"], stderr="private diagnostic")
        with patch.object(release, "command", side_effect=failure), self.assertRaisesRegex(ValueError, "^CACHED_RUNTIME_IMAGE_REQUIRED$"):
            release.preflight(selected, snapshot, jobs, pull=False)
        with patch.object(release, "command", side_effect=AssertionError("process invoked")), self.assertRaisesRegex(ValueError, "EXPLICIT_IMAGE_PREFLIGHT_MODE"):
            release.preflight(selected, snapshot, jobs, pull="false")

    def test_full_control_flow_holds_the_lock_starts_dependencies_first_and_leaves_traffic_unapproved(self):
        with self.patches():
            result = self.execute()
        self.assertEqual(result["status"], "API_RUNTIME_READY")
        self.assertFalse(result["trafficAuthorized"])
        self.assertFalse(result["frontendPromotionAuthorized"])
        self.assertFalse(result["realVercelOidcVerified"])
        self.assertEqual(len(result["containers"]), len(release.SERVICES))
        starts = [tuple(args[args.index("90")+1:]) for args in self.calls if "up" in args]
        self.assertEqual(starts, release.STAGES)
        check_indices = [index for index, args in enumerate(self.calls) if "--eval" in args]
        apply_indices = [index for index, args in enumerate(self.calls) if "--execute" in args]
        self.assertEqual(len(check_indices), len(release.SERVICES))
        self.assertLess(max(check_indices), min(apply_indices))
        stored = (self.results / "runtime-test-release/runtime-outcome.json").read_text()
        self.assertNotIn("private-fixture", stored)
        with self.patches(), self.assertRaises(FileExistsError):
            self.execute()

    def test_frontend_migration_precedes_runtime_startup_under_the_same_lock(self):
        self.fixture.add_frontend()
        def quiesce(selected, attempt):
            with (self.root / "release.lock").open() as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(any("--execute" in args for args in self.calls))
            return {"status": "FRONTEND_PRODUCERS_SUSPENDED", "environment": "staging", "projectId": "prj_fixture"}
        with self.patches(), patch.dict(os.environ, {"FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}):
            result = release.execute(self.bundle, self.configuration, self.results, self.compose, True, "staging/test-release",
                                     self.root / "release.lock", before_frontend_migration=quiesce)
        self.assertEqual(result["status"], "API_RUNTIME_READY")
        frontend_apply = next(i for i, args in enumerate(self.calls) if "--execute" in args and "ops/platform/frontend-image.mjs" in args)
        self.assertLess(frontend_apply, min(i for i, args in enumerate(self.calls) if "up" in args))
        self.assertTrue((self.results / "test-release/frontend/database-receipt.json").exists())
        self.assertFalse(result["frontendPromotionAuthorized"])

    def test_frontend_quiescence_is_required_before_any_database_write(self):
        self.fixture.add_frontend()
        with self.patches(), patch.dict(os.environ, {"FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}):
            with self.assertRaisesRegex(ValueError, "FRONTEND_QUIESCENCE_COORDINATOR_REQUIRED"):
                self.execute()
        self.assertFalse(any("--execute" in args or "up" in args for args in self.calls))

    def test_parent_continuation_runs_after_durable_runtime_success_under_the_same_lock(self):
        self.fixture.add_frontend()
        self.fixture.jobs["frontend"]["target"]["approvedPendingTags"] = []
        self.fixture.save()
        observed = []
        def coordinate(attempt, migration_attempt, snapshot, selected, runtime):
            with (self.root / "release.lock").open() as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.running, set(release.SERVICES))
            retained = json.loads((attempt / "runtime-outcome.json").read_text())
            self.assertEqual(retained["status"], "API_RUNTIME_READY")
            self.assertEqual(runtime, retained)
            self.assertEqual(json.loads((migration_attempt / "migration-outcome.json").read_text())["status"], "DATABASES_VERIFIED")
            self.assertTrue(json.loads((migration_attempt / "frontend/job-outcome.json").read_text())["readOnlyVerified"])
            self.assertTrue(json.loads((snapshot / "gateway.json").read_text())["maintenance"])
            self.assertEqual(selected, self.fixture.release)
            self.assertEqual(runtime["status"], "API_RUNTIME_READY")
            self.assertFalse(runtime["releaseAccepted"])
            observed.append(True)
            # Callback values cannot alter the retained/returned API receipt.
            runtime["trafficAuthorized"] = True
            selected["environment"] = "changed"
        with self.patches(), patch.dict(os.environ, {"FRONTEND_STAGING_MIGRATION_DATABASE_URL": "owned-frontend-url"}):
            result = release.execute(self.bundle, self.configuration, self.results, self.compose, True, "staging/test-release",
                                     self.root / "release.lock", after_runtime_ready=coordinate)
        self.assertEqual(observed, [True])
        self.assertEqual(result["phase"], "completed")
        self.assertFalse(result["trafficAuthorized"])
        self.assertFalse(result["releaseAccepted"])

    def test_parent_continuation_failure_stops_runtime_and_keeps_database_success_for_review(self):
        def fail(*_args):
            raise ValueError("FRONTEND_VERIFICATION_FAILED")
        with self.patches(), self.assertRaisesRegex(ValueError, "FRONTEND_VERIFICATION_FAILED"):
            release.execute(self.bundle, self.configuration, self.results, self.compose, True, "staging/test-release",
                            self.root / "release.lock", after_runtime_ready=fail)
        self.assertFalse(self.running)
        retained = json.loads((self.results / "runtime-test-release/runtime-outcome.json").read_text())
        self.assertEqual(retained["status"], "API_RUNTIME_READY")
        failure = json.loads((self.results / "runtime-test-release/runtime-failure.json").read_text())
        self.assertEqual(failure["phase"], "frontend-coordination")
        self.assertEqual(failure["status"], "FAILED_REQUIRES_REVIEW")
        self.assertTrue(failure["runtimeStopped"])
        self.assertFalse(failure["trafficAuthorized"])
        self.assertFalse(failure["releaseAccepted"])
        self.assertEqual(json.loads((self.results / "test-release/migration-outcome.json").read_text())["status"], "DATABASES_VERIFIED")

    def test_invalid_parent_continuation_is_refused_before_private_reads(self):
        with patch.object(release, "assert_host", side_effect=AssertionError("Host checked")), self.assertRaisesRegex(ValueError, "RUNTIME_CONTINUATION_REQUIRED"):
            release.execute(self.bundle, self.configuration, self.results, self.compose, True, "staging/test-release",
                            self.root / "release.lock", after_runtime_ready={"status": "pretend-success"})
        self.assertEqual(list(self.results.iterdir()), [])

    def test_parent_continuation_is_not_called_when_runtime_verification_fails(self):
        original = self.docker
        def fail(args, **kwargs):
            if "exec" in args and "release-probe.mjs" in args:
                return subprocess.CompletedProcess(args, 0, stdout='{"status":"API_RUNTIME_BOUNDARIES_PASS","checks":[]}', stderr="")
            return original(args, **kwargs)
        def must_not_run(*_args):
            self.fail("Parent continuation ran before verified API runtime")
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaisesRegex(ValueError, "RUNTIME_BOUNDARY"):
            release.execute(self.bundle, self.configuration, self.results, self.compose, True, "staging/test-release",
                            self.root / "release.lock", after_runtime_ready=must_not_run)
        self.assertFalse(self.running)

    def test_credential_or_config_preflight_failure_does_not_migrate_or_stop_existing_runtime(self):
        original = self.docker
        self.running.add("gateway")
        def fail(args, **kwargs):
            if "--eval" in args:
                raise subprocess.CalledProcessError(1, args)
            return original(args, **kwargs)
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaises(subprocess.CalledProcessError):
            self.execute()
        self.assertEqual(self.running, {"gateway"})
        self.assertFalse(any("--execute" in args or args[1] == "stop" for args in self.calls))

    def test_runtime_startup_failure_stops_all_writers_preserves_database_success_and_never_starts_gateway(self):
        original = self.docker
        def fail(args, **kwargs):
            if "up" in args and "course-publisher" in args:
                raise subprocess.CalledProcessError(1, args)
            return original(args, **kwargs)
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaises(subprocess.CalledProcessError):
            self.execute()
        self.assertFalse(self.running)
        outcome = json.loads((self.results / "runtime-test-release/runtime-outcome.json").read_text())
        self.assertEqual(outcome["status"], "FAILED_REQUIRES_REVIEW")
        self.assertTrue(outcome["runtimeStopped"])
        self.assertFalse(any("up" in args and args[-1] == "gateway" for args in self.calls))
        self.assertEqual(json.loads((self.results / "test-release/migration-outcome.json").read_text())["status"], "DATABASES_VERIFIED")

    def test_missing_boundary_checks_stop_the_runtime(self):
        original = self.docker
        def fail(args, **kwargs):
            if "exec" in args and "release-probe.mjs" in args:
                return subprocess.CompletedProcess(args, 0, stdout='{"status":"API_RUNTIME_BOUNDARIES_PASS","checks":[]}', stderr="")
            return original(args, **kwargs)
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaisesRegex(ValueError, "RUNTIME_BOUNDARY"):
            self.execute()
        self.assertFalse(self.running)

    def test_new_worker_compose_cannot_override_loop_flags_or_inject_api_credentials(self):
        original = self.docker
        for key, value in (("MUX_MEDIA_RECOVERY_ENABLED", "true"), ("INTERNAL_SERVICE_JWT_SECRET", "private-fixture")):
            def changed(args, **kwargs):
                result = original(args, **kwargs)
                if args[1] == "compose" and "config" in args:
                    model = json.loads(result.stdout); model["services"]["course-media"]["environment"][key] = value
                    result.stdout = json.dumps(model)
                return result
            with self.patches(), patch.object(subprocess, "run", side_effect=changed), self.assertRaisesRegex(ValueError, "WORKER_PUBLIC_OVERRIDES_REFUSED"):
                release.preflight(self.fixture.release, self.configuration, {name: {"job": job} for name, job in self.fixture.jobs.items()}, pull=False)
            for file in self.configuration.glob("*.resolved.env"): file.unlink()
        self.assertFalse(any("--execute" in args for args in self.calls))

    def test_unverified_configuration_container_cleanup_prevents_migration(self):
        original = self.docker
        self.running.add("gateway")
        def fail(args, **kwargs):
            if args[1:3] == ["container", "ls"] and any("lash-config-" in str(value) for value in args):
                return subprocess.CompletedProcess(args, 0, stdout="a" * 12, stderr="")
            return original(args, **kwargs)
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaisesRegex(ValueError, "CONFIGURATION_CONTAINER_CLEANUP"):
            self.execute()
        self.assertEqual(self.running, {"gateway"})
        self.assertFalse(any("--execute" in args for args in self.calls))

    def test_wrong_actual_container_image_stops_runtime(self):
        original = self.docker
        def fail(args, **kwargs):
            result = original(args, **kwargs)
            if args[1] == "inspect":
                result.stdout = "sha256:" + "0" * 64 + result.stdout[result.stdout.index("|"):]
            return result
        with self.patches(), patch.object(subprocess, "run", side_effect=fail), self.assertRaisesRegex(ValueError, "RUNTIME_HEALTH_OR_IDENTITY"):
            self.execute()
        self.assertFalse(self.running)

    def test_success_receipt_write_failure_stops_runtime_and_leaves_a_failed_outcome(self):
        write = migrate.write_json
        def fail(directory, name, value):
            if name == "runtime-outcome.json" and value["status"] == "API_RUNTIME_READY":
                raise OSError("owned retention failure")
            return write(directory, name, value)
        with self.patches(), patch.object(migrate, "write_json", side_effect=fail), self.assertRaises(OSError):
            self.execute()
        self.assertFalse(self.running)
        self.assertEqual(json.loads((self.results / "runtime-test-release/runtime-outcome.json").read_text())["status"], "FAILED_REQUIRES_REVIEW")


class DurableMigrationRecordTests(unittest.TestCase):
    def test_failed_directory_sync_does_not_publish_success_and_existing_records_are_never_overwritten(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sync = os.fsync
            calls = 0
            def fail(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("directory sync failed")
                return sync(fd)
            with patch.object(os, "fsync", side_effect=fail), self.assertRaises(OSError):
                migrate.write_json(root, "outcome.json", {"status": "success"})
            self.assertEqual(list(root.iterdir()), [])
            migrate.write_json(root, "outcome.json", {"status": "first"})
            with self.assertRaises(FileExistsError):
                migrate.write_json(root, "outcome.json", {"status": "second"})
            self.assertEqual(json.loads((root / "outcome.json").read_text())["status"], "first")


if __name__ == "__main__":
    unittest.main()
