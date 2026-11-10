"""Owned POSIX flock/process tests, with test-only Docker command execution seam."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import migrate
import p2_identity_probe_scope as current
import p2_identity_negative_probe as probe
from p2_certification_parent_test import legacy_source_fixture


class CurrentIdentityProbeScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-current-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = self.root / "release.lock"
        self.identifier = "1" * 64
        self.image = "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "2" * 64
        self.selected = {"environment": "staging", "artifacts": {key: {"image": self.image} for key in
            ("gateway", "courseRuntime", "courseMigration", "communityRuntime", "communityMigration")}}
        self.reviewed = {"containers": [{"service": "gateway", "containerId": self.identifier, "image": self.image}]}
        self.program = b"// fixed source-owned test program"
        self.initial = b"bound original input"
        self.input_file = self.root / "observed"
        self.input_file.write_bytes(self.initial)
        self.patchers = [patch.object(current, "LOCK", self.lock), patch.object(current.sys, "platform", "linux"),
            patch.object(current.os, "geteuid", return_value=0)]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.scopes = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for scope in self.scopes:
            if not scope.closed:
                scope.close()

    def scope(self):
        def verify():
            if self.input_file.read_bytes() != self.initial:
                raise ValueError("OWNED_CURRENT_INPUT_CHANGED")
        scope = current.CurrentIdentityProbeScope(self.selected, self.reviewed, self.root, self.program, verify)
        self.scopes.append(scope)
        return scope

    def args(self):
        return ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
            self.identifier, "node", "--input-type=module", "--eval", self.program.decode()]

    def test_real_independent_process_cannot_take_held_flock_and_can_after_close(self):
        scope = self.scope()
        code = "import fcntl,sys; f=open(sys.argv[1],'a+');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('ACQUIRED')\nexcept BlockingIOError: print('HELD')"
        def other():
            return subprocess.check_output([sys.executable, "-I", "-c", code, str(self.lock)], text=True).strip()
        self.assertEqual(other(), "HELD")
        scope.close()
        self.assertEqual(other(), "ACQUIRED")

    def test_actual_lock_contention_symlink_permissions_and_changed_inode_refuse(self):
        with self.lock.open("w") as locked:
            os.chmod(self.lock, 0o600)
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.scope()
        self.lock.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "PRIVATE_HOST_LOCK"):
            self.scope()
        self.lock.unlink()
        self.lock.symlink_to(self.input_file)
        with self.assertRaises(OSError):
            self.scope()
        self.lock.unlink()
        scope = self.scope()
        self.lock.rename(self.root / "old-lock")
        self.lock.write_text("replacement")
        self.lock.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "HOST_LOCK_CHANGED"):
            scope.verify()

    def test_current_input_drift_and_closed_scope_block_new_children(self):
        scope = self.scope()
        self.input_file.write_bytes(b"changed")
        with patch.object(current.subprocess, "Popen") as spawn, self.assertRaisesRegex(ValueError, "CURRENT_INPUT_CHANGED"):
            scope.run(self.args(), env=current.runtime.SAFE_ENV, input=b'{}', timeout=1)
        spawn.assert_not_called()
        scope.close()
        with self.assertRaisesRegex(ValueError, "SCOPE_CLOSED"):
            scope.verify()

    def test_no_mutation_sql_restart_admission_arbitrary_program_or_container_command(self):
        scope = self.scope()
        examples = [["docker", "restart", self.identifier], ["docker", "compose", "up"], ["psql", "-c", "SELECT 1"],
            ["docker", "exec", self.identifier, "sh", "-c", "arbitrary"], self.args()[:-1] + ["arbitrary-code"]]
        for args in examples:
            with self.subTest(args=args[:2]), patch.object(current.subprocess, "Popen") as spawn, self.assertRaises(ValueError):
                scope.run(args, env=current.runtime.SAFE_ENV, input=b'{"mode":"course-http","environment":"staging"}', timeout=1)
            spawn.assert_not_called()
        self.assertFalse(any(hasattr(scope, name) for name in ("require_frontend", "migrate", "restart", "admit", "apply")))

    def test_real_child_stdin_is_private_and_registered_then_reaped(self):
        scope, real_spawn = self.scope(), subprocess.Popen
        payload = b'{"mode":"course-http","environment":"staging","privateSyntheticMarker":"never-output"}'
        seen = []
        def owned_spawn(args, **options):
            seen.append(args)
            return real_spawn([sys.executable, "-I", "-c", "import sys; print(len(sys.stdin.buffer.read()))"], **options)
        with patch.object(current.subprocess, "Popen", side_effect=owned_spawn):
            result = scope.run(self.args(), env=current.runtime.SAFE_ENV, input=payload, timeout=5)
        self.assertEqual(result.stdout.strip(), str(len(payload)).encode())
        self.assertNotIn("never-output", str(seen))
        self.assertEqual(scope.processes, set())
        scope.verify()

    def test_real_child_scope_revocation_prevents_further_children(self):
        scope, real_spawn = self.scope(), subprocess.Popen
        created = threading.Event()
        processes = []
        def owned_spawn(args, **options):
            process = real_spawn([sys.executable, "-I", "-c", "import time; time.sleep(20)"], **options)
            processes.append(process)
            created.set()
            return process
        errors = []
        def work():
            try:
                scope.run(self.args(), env=current.runtime.SAFE_ENV, input=b'{"mode":"course-http","environment":"staging"}', timeout=5)
            except Exception as error:
                errors.append(type(error).__name__)
        with patch.object(current.subprocess, "Popen", side_effect=owned_spawn):
            thread = threading.Thread(target=work)
            thread.start()
            self.assertTrue(created.wait(5))
            scope.revoke()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertTrue(all(process.poll() is not None for process in processes))
        with patch.object(current.subprocess, "Popen") as spawn, self.assertRaises(ValueError):
            scope.run(self.args(), env=current.runtime.SAFE_ENV, input=b'{}', timeout=1)
        spawn.assert_not_called()
        scope.close()

    def test_real_child_timeout_reaps_its_owned_process_group(self):
        scope, real_spawn = self.scope(), subprocess.Popen
        processes = []
        def owned_spawn(args, **options):
            process = real_spawn([sys.executable, "-I", "-c", "import time; time.sleep(20)"], **options)
            processes.append(process)
            return process
        with patch.object(current.subprocess, "Popen", side_effect=owned_spawn), self.assertRaises(subprocess.TimeoutExpired):
            scope.run(self.args(), env=current.runtime.SAFE_ENV, input=b'{"mode":"course-http","environment":"staging"}', timeout=0.05)
        self.assertTrue(all(process.poll() is not None for process in processes))
        self.assertEqual(scope.processes, set())

    def test_source_closure_is_exact_and_contains_all_fixed_transitive_host_imports(self):
        source = Path(probe.__file__).resolve().parents[3]
        destination = self.root / "installed-legacy"
        legacy_source_fixture(source, destination)
        files = probe.source_closure(destination)
        self.assertTrue(probe.SOURCE_ANCHORS.issubset(files))
        self.assertGreater(len(files), len(probe.SOURCE_ANCHORS))
        self.assertIn("ops/platform/host/p2_identity_probe_current.py", files)
        self.assertIn("ops/platform/host/docker_inspect.py", files)
        self.assertTrue(all(len(value) == 64 for value in files.values()))

    def test_fixed_execution_budget_blocks_new_children_without_extending_approval(self):
        scope = self.scope()
        with patch.object(current.time, "monotonic", return_value=scope.deadline), patch.object(current.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(ValueError, "EXECUTION_TIMEOUT"):
                scope.run(self.args(), env=current.runtime.SAFE_ENV, input=b'{}', timeout=1)
            spawn.assert_not_called()

    def test_source_inventory_detects_new_imported_helpers_and_refuses_symlink_omissions(self):
        source = Path(probe.__file__).resolve().parents[3]
        destination = self.root / "source"
        import shutil
        for name in probe.SOURCE_ANCHORS:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        first = probe.source_closure(destination)
        helper = destination / "ops/platform/host/new_supervisor_dependency.py"
        helper.write_text("# future shared release/migrate dependency\n")
        second = probe.source_closure(destination)
        self.assertNotEqual(first, second)
        self.assertIn("ops/platform/host/new_supervisor_dependency.py", second)
        helper.unlink()
        helper.symlink_to(self.input_file)
        with self.assertRaisesRegex(ValueError, "OPERATOR_SYMLINK_REFUSED"):
            probe.source_closure(destination)

    def test_fixed_current_stage_entry_malformed_private_packet_never_prints_input(self):
        entry = Path(probe.__file__).with_name("p2_identity_probe_current.py")
        for value in (b"private-marker-not-json", json.dumps({"operation": "exec", "key": "private-marker"}).encode(), b"x" * 262_145):
            result = subprocess.run([sys.executable, "-I", "-B", str(entry)], input=value, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"")
            self.assertNotIn(b"private-marker", result.stdout)
            self.assertFalse(json.loads(result.stdout)["releaseAccepted"])


class ReplacementIdentityProbeScopeTests(unittest.TestCase):
    def setUp(self):
        from p2_certification_fault import MODULE
        from release_test import RuntimeReleaseTests
        fixture = RuntimeReleaseTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        fixture.fixture.add_frontend()
        self.profile = fixture.fixture.profiled()
        self.selected = fixture.fixture.release
        self.jobs = {service: {"job": job} for service, job in fixture.fixture.jobs.items()}
        self.configuration = fixture.configuration
        self.root = fixture.root.resolve()
        (self.configuration / "admission").mkdir(mode=0o700)
        self.source = self.root / "source"
        fault = self.source / MODULE
        fault.parent.mkdir(parents=True)
        fault.write_bytes(b"owned-fault-module")
        self.program = b"// fixed owned identity child"
        self.rows = [{"service": service, "containerId": f"{index + 1:064x}",
                      "image": self.selected["artifacts"][current.runtime.IMAGE_KEYS[service]]["image"],
                      "health": "none" if service.endswith("-tls") else "healthy"}
                     for index, service in enumerate(current.runtime.SERVICES)]
        self.reviewed = {"version": 2, "qualificationTargetProfile": self.profile, "candidateSha256": "a" * 64,
            "programSha256": migrate.file_hash(self.program), "gatewayProcessSha256": "b" * 64,
            "runtimeInventorySha256": migrate.file_hash(probe._canonical(self.rows)),
            "containers": [{key: row[key] for key in ("service", "containerId", "image")}
                           for row in self.rows if row["service"] in probe.SERVICES]}
        admission = self.configuration / "admission"
        mount = admission.stat()
        self.gateway = {"version": 1, "status": "P2_FAULT_GATEWAY_CURRENT", "processSha256": "b" * 64,
            "gatewayConfigurationSha256": migrate.file_hash((self.configuration / "gateway.json").read_bytes()),
            "faultModuleSha256": migrate.file_hash(fault.read_bytes()), "faultLeasePresent": False,
            "admissionDirectory": {"device": str(mount.st_dev), "inode": str(mount.st_ino)},
            "admission": {"version": 1, "environment": "staging", "releaseId": self.selected["releaseId"],
                "candidateSha256": self.reviewed["candidateSha256"], "valid": True, "newWork": False, "recovery": False,
                "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0}}}
        self.state = admission / "state.json"
        state = {key: self.gateway["admission"][key] for key in ("version", "environment", "releaseId", "candidateSha256", "newWork", "recovery")}
        self.state.write_bytes(probe._canonical({**state, "actionId": "owned-closed"}) + b"\n")
        self.gateway["admission"]["sha256"] = migrate.file_hash(self.state.read_bytes())
        self.altered_mount, self.unknown_container = None, False
        self.lock = self.root / "owned-flock"
        for active in (patch.object(current, "LOCK", self.lock), patch.object(current.sys, "platform", "linux"),
                       patch.object(current.os, "geteuid", return_value=0)):
            active.start()
            self.addCleanup(active.stop)
        self.scope = current.ReplacementIdentityProbeScope(self.selected, self.jobs, self.reviewed, self.configuration,
                                                           self.source, self.program, lambda: None)
        self.addCleanup(self.scope.close)

    def projected_docker(self, args, *, env, input=None, **options):
        self.scope.verify()
        self.scope._allowed(args, input, env)
        self.assertIsNone(input)
        if args[:2] == ["docker", "compose"]:
            output = next(row["containerId"] for row in self.rows if row["service"] == args[-1])
        elif args[:3] == ["docker", "image", "inspect"]:
            output = args[-1].split("@")[1]
        elif args == current.PROJECT_INVENTORY:
            output = "\n".join([row["containerId"] for row in self.rows] + (["f" * 64] if self.unknown_container else []))
        elif args == self.scope._gateway_command():
            output = json.dumps(self.gateway)
        else:
            row = next(row for row in self.rows if row["containerId"] == args[-1])
            field = args[-2]
            if field == current.docker_inspect.RUNTIME_FIELDS:
                output = "|".join((row["image"].split("@")[1], "true", row["health"], "lash-her-staging", row["service"]))
            elif field == current.COMPOSE_MOUNT_FIELDS:
                output = str(self.configuration) + "|" + str(self.configuration / "compose.yaml")
            elif field == current.IDENTITY_FIELDS:
                output = "|".join((row["image"], "true", "healthy", "lash-her-staging", row["service"]))
            else:
                self.assertEqual(field, current.SECURITY_FIELDS)
                mounts = [{"Destination": mount, "Source": str(self.altered_mount or path), "Type": "bind", "RW": False}
                          for mount, path in self.scope.required_mounts(row["service"]).items()]
                output = "true|" + json.dumps(mounts)
        return subprocess.CompletedProcess(args, 0, output.encode(), b"")

    def test_exact_replacement_live_inventory_mounts_gateway_and_closed_zero_are_rechecked(self):
        with patch.object(self.scope, "run", side_effect=self.projected_docker):
            self.scope.bind_runtime()
            self.assertEqual(self.scope.required_mounts("community-api"), {"/tls/ca.pem": self.configuration / "tls/ca.pem"})
            self.assertEqual(self.scope.required_mounts("course-api"), {})
            self.scope.verify_runtime()
            self.gateway["processSha256"] = "e" * 64
            with self.assertRaisesRegex(ValueError, "GATEWAY_NOT_CLOSED_ZERO"):
                self.scope.verify_runtime()
            self.gateway["processSha256"] = "b" * 64
            self.gateway["admission"]["uncertain"]["recovery"] = 1
            with self.assertRaisesRegex(ValueError, "GATEWAY_NOT_CLOSED_ZERO"):
                self.scope.verify_runtime()
            self.gateway["admission"]["uncertain"]["recovery"] = 0
            self.gateway["faultLeasePresent"] = True
            with self.assertRaisesRegex(ValueError, "GATEWAY_NOT_CLOSED_ZERO"):
                self.scope.verify_runtime()
            self.gateway["faultLeasePresent"] = False
            state = self.state.read_bytes()
            self.state.write_bytes(state + b" ")
            with self.assertRaisesRegex(ValueError, "GATEWAY_NOT_CLOSED_ZERO"):
                self.scope.verify_runtime()
            self.state.write_bytes(state)
            self.unknown_container = True
            with self.assertRaisesRegex(ValueError, "RUNTIME_INVENTORY_CHANGED"):
                self.scope.verify_runtime()
            self.unknown_container = False
            self.altered_mount = self.root / "foreign-ca.pem"
            community = next(row for row in self.reviewed["containers"] if row["service"] == "community-api")
            with self.assertRaisesRegex(ValueError, "MOUNTS_REFUSED"):
                probe._one_container(community, self.configuration, self.scope)

    def test_unbound_or_revoked_scope_never_starts_private_child_and_readback_is_fixed(self):
        container = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == "community-api")
        child = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
                 "--env", "DOTENV_CONFIG_QUIET=true", container, "node", "--input-type=module", "--eval", self.program.decode()]
        private = b'{"mode":"community-verifier","environment":"staging","key":"owned-private"}'
        with patch.object(current.subprocess, "Popen") as spawn, self.assertRaisesRegex(ValueError, "RUNTIME_NOT_BOUND"):
            self.scope.run(child, env=current.runtime.SAFE_ENV, input=private, timeout=1)
        spawn.assert_not_called()
        with patch.object(self.scope, "run", side_effect=self.projected_docker):
            self.scope.bind_runtime()
        with patch.object(current.subprocess, "Popen") as spawn, self.assertRaisesRegex(ValueError, "READONLY_COMMAND_REQUIRED"):
            self.scope.run(self.scope._gateway_command()[:-1] + ["process.exit()"], env=current.runtime.SAFE_ENV, timeout=1)
        spawn.assert_not_called()
        self.scope.revoke()
        with patch.object(current.subprocess, "Popen") as spawn, self.assertRaisesRegex(ValueError, "SCOPE_CLOSED"):
            self.scope.run(child, env=current.runtime.SAFE_ENV, input=private, timeout=1)
        spawn.assert_not_called()

    def test_revocation_reaps_actual_private_child_process_before_close(self):
        with patch.object(self.scope, "run", side_effect=self.projected_docker):
            self.scope.bind_runtime()
        container = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == "community-api")
        child = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
                 "--env", "DOTENV_CONFIG_QUIET=true", container, "node", "--input-type=module", "--eval", self.program.decode()]
        real_spawn = subprocess.Popen
        spawned = threading.Event()
        processes, failures = [], []

        def owned_spawn(args, **options):
            self.assertNotIn("owned-private", str(args))
            process = real_spawn([sys.executable, "-I", "-c", "import time; time.sleep(15)"], **options)
            processes.append(process)
            spawned.set()
            return process

        def invoke():
            try:
                self.scope.run(child, env=current.runtime.SAFE_ENV,
                    input=b'{"mode":"community-verifier","environment":"staging","key":"owned-private"}', timeout=5)
            except ValueError as error:
                failures.append(str(error))

        with patch.object(current.subprocess, "Popen", side_effect=owned_spawn):
            runner = threading.Thread(target=invoke)
            runner.start()
            try:
                self.assertTrue(spawned.wait(3))
            finally:
                self.scope.revoke()
                runner.join(5)
        self.assertFalse(runner.is_alive())
        self.assertEqual(failures, ["P2_IDENTITY_READONLY_SCOPE_CLOSED"])
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertEqual(self.scope.processes, set())


class ReplacementIdentityProvenanceTests(unittest.TestCase):
    def test_rejoins_actual_original_guardian_bytes_and_refuses_stale_mount_or_promotion(self):
        import p2_prior_gateway as prior
        from p2_identity_replacement_provenance import require_replacement_identity_provenance
        from p2_replacement_certification_test import ReplacementCertificationTests
        from p2_replacement_terminal import TERMINAL
        from shutil import copytree

        fixture = ReplacementCertificationTests()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        fixture.bundle.chmod(0o700)
        source = Path(probe.__file__).resolve().parents[3]
        expected = current._replacement_profile()
        evidence = {"originalReleaseReceipt": (fixture.write_directory / TERMINAL).read_bytes(),
                    "frontendDeploymentRecord": fixture.provider_raw[2]}
        pins = {name + "Sha256": migrate.file_hash(raw) for name, raw in evidence.items()}
        pins["originalReleasePlanSha256"] = fixture.cert_plan["originalReleasePlanSha256"]
        reviewed = {"version": 2, "qualificationTargetProfile": expected,
            "releaseId": fixture.release_id, "probeId": "owned-s06", "hostMachineId": fixture.initial["hostMachineId"],
            "apiJobSha256": fixture.review["apiJobSha256"], "candidateSha256": fixture.plan["candidateSha256"],
            "configurationSha256": migrate.file_hash(probe._canonical(fixture.review["configurationSha256"])),
            "targetSha256": fixture.target_sha, "sources": {"frontend": fixture.commit}, "replacementRelease": fixture.descriptor,
            "priorEvidence": pins, "successorRuntime": None}
        jobs = {"frontend": {"job": fixture.job, "schema": fixture.raw_baseline}}

        def join(configuration, supplied=evidence):
            return require_replacement_identity_provenance(fixture.bundle, configuration, fixture.results, source,
                fixture.candidate, jobs, reviewed, supplied)

        # The preexisting terminal fixture uses a minimal candidate DTO.
        with patch.object(prior, "ROOT", fixture.root), patch.object(migrate, "candidate_profile", return_value=expected), \
             patch.object(current.subprocess, "run", side_effect=AssertionError("external I/O")):
            self.assertEqual(join(fixture.snapshot), fixture.snapshot)
            alternate = copytree(fixture.snapshot, fixture.root / "stale-configuration")
            with self.assertRaisesRegex(ValueError, "PROVENANCE_REFUSED"):
                join(alternate)
            with self.assertRaisesRegex(ValueError, "PROVENANCE_REFUSED"):
                join(fixture.snapshot, {**evidence, "frontendDeploymentRecord": evidence["frontendDeploymentRecord"] + b" "})
            with patch.dict(fixture.descriptor, databaseOid="923"), self.assertRaisesRegex(ValueError, "TARGET_CHANGED"):
                join(fixture.snapshot)
