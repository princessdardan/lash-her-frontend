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
