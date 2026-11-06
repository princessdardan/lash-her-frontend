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

import p2_identity_probe_scope as current
import p2_identity_negative_probe as probe


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
        files = probe.source_closure(source)
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
