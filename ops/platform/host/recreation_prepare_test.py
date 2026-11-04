import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import migrate
import recreation_prepare as prepare


class FreshPreparationTests(unittest.TestCase):
    def initialization(self, firewall=None, ssh=None):
        values = {("cloud-init", "status", "--wait"): "status: done",
            ("/usr/sbin/sshd", "-T"): ssh or "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no",
            ("ufw", "status", "numbered"): firewall or "Status: active\n\n[ 1] 22/tcp ALLOW IN 99.239.200.211\n[ 2] 443/tcp ALLOW IN Anywhere\n"}
        files = {"/opt/lash-her/host-prepared": prepare.MARKER,
                 "/etc/ssh/sshd_config.d/00-lash-her.conf": prepare.SSH_POLICY}
        return prepare.initialization(lambda args, *_: values[tuple(args)], lambda name: files[name])

    def test_exact_cloud_init_marker_ssh_and_operator_only_firewall_are_required(self):
        self.assertEqual(self.initialization()["status"], "RECREATION_INITIALIZATION_VERIFIED")
        for firewall in ("Status: inactive\n", "Status: active\n[1] 22/tcp ALLOW IN Anywhere\n[2] 443/tcp ALLOW IN Anywhere\n",
                         "Status: active\n[1] 22/tcp ALLOW IN 99.239.200.211\n[2] 443/tcp ALLOW IN Anywhere\n[3] 22/tcp ALLOW IN Anywhere (v6)\n"):
            with self.assertRaisesRegex(ValueError, "HOST_FIREWALL"):
                self.initialization(firewall=firewall)
        with self.assertRaisesRegex(ValueError, "EFFECTIVE_SSH"):
            self.initialization(ssh="passwordauthentication yes\nkbdinteractiveauthentication no\npermitrootlogin no")

    def test_bootstrap_refuses_original_machine_before_command_or_file_changes(self):
        with patch.object(prepare.runtime, "assert_host", side_effect=AssertionError("host touched")):
            with self.assertRaisesRegex(ValueError, "NEW_MACHINE"):
                prepare.bootstrap_fresh(prepare.ORIGINAL_MACHINE, Path("/unused"), "a" * 64)

    def test_fresh_machine_identity_does_not_require_a_preinstalled_docker_engine(self):
        with patch.object(prepare.sys, "platform", "linux"), patch.object(prepare.platform, "machine", return_value="x86_64"), \
                patch.object(prepare.os, "geteuid", return_value=0), \
                patch.object(prepare.staging_restore, "host_file", return_value=("2" * 32 + "\n").encode()), \
                patch.object(prepare.runtime, "command", side_effect=AssertionError("Docker before install")):
            prepare.assert_fresh_machine("2" * 32)
            with self.assertRaisesRegex(ValueError, "MACHINE_MISMATCH"):
                prepare.assert_fresh_machine("3" * 32)

    def test_fresh_bootstrap_records_exact_package_lock_before_invoking_existing_executor(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp); output.chmod(0o700)
            _lock, digest = prepare.bootstrap.load_lock(Path(prepare.__file__).with_name("packages.lock.json"))
            def apply(plan, reviewed):
                started = migrate.read_json(output, "bootstrap-started.json")
                self.assertEqual(started["lockSha256"], digest)
                self.assertEqual(reviewed, digest)
                return {"lockSha256": digest, "applicationDeployed": False, "forwardingSha256": plan["forwardingSha256"]}
            with patch.object(prepare, "assert_fresh_machine"), patch.object(prepare, "initialization", return_value={"status": "owned"}), \
                    patch.object(prepare.runtime, "command", return_value='[{"dev":"ens5"}]'), \
                    patch.object(prepare.bootstrap, "apply", side_effect=apply):
                result = prepare.bootstrap_fresh("2" * 32, output, digest)
            self.assertEqual(result["status"], "RECREATION_FRESH_BOOTSTRAP_COMPLETE")
            self.assertFalse(result["applicationStarted"])

    def test_preparation_failure_retains_exclusive_outcome_and_cannot_be_repeated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.chmod(0o700)
            action = "p1-recreate-owned"; (root / action).mkdir(mode=0o700)
            value = {"version": 1, "environment": "staging", "operation": "bootstrap", "action": action,
                     "expectedMachineId": "2" * 32, "confirmation": "staging/" + action + "/bootstrap", "packageLockSha256": "a" * 64}
            with patch.object(prepare.recreation_files, "ROOT", root), patch.object(prepare.os, "geteuid", return_value=0), \
                    patch.object(prepare.sys, "platform", "linux"), patch.object(prepare, "assert_fresh_machine"), \
                    patch.object(prepare, "bootstrap_fresh", side_effect=ValueError("OWNED_BOOTSTRAP_INTERRUPTED")) as apply:
                with self.assertRaisesRegex(ValueError, "OWNED_BOOTSTRAP_INTERRUPTED"):
                    prepare.execute(value, root / "release.lock")
                with self.assertRaisesRegex(ValueError, "EXCLUSIVE_OUTPUT"):
                    prepare.execute(value, root / "release.lock")
            self.assertEqual(apply.call_count, 1)
            receipt = migrate.read_json(root / action / "prepare-bootstrap", "preparation-outcome.json")
            self.assertEqual(receipt["failureCode"], "OWNED_BOOTSTRAP_INTERRUPTED")
            self.assertFalse(receipt["applicationStarted"])


class CachePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name).resolve(); self.output.chmod(0o700)
        self.refs = {name: "ghcr.io/princessdardan/lash-her-platform-" + name.lower() + "@sha256:" + hashlib.sha256(name.encode()).hexdigest()
                     for name in prepare.CURRENT_IMAGE_KEYS}
        self.cached = set(self.refs.values())
        self.calls = []
        self.fail_pull = False

    def tearDown(self):
        self.temp.cleanup()

    def engine(self, args, environment, payload=None, timeout=60):
        self.calls.append((args, dict(environment), payload))
        self.assertNotIn("registryReadToken", environment)
        self.assertNotIn("VERCEL_TOKEN", environment)
        if args[1] == "info":
            return SimpleNamespace(returncode=0, stdout=b"linux|x86_64\n", stderr=b"")
        if args[1:3] == ["image", "inspect"]:
            reference = args[-1]
            if reference not in self.cached:
                return SimpleNamespace(returncode=1, stdout=b"[]\n", stderr=("Error response from daemon: No such image: " + reference).encode())
            return SimpleNamespace(returncode=0, stderr=b"", stdout=json.dumps({"os": "linux", "architecture": "amd64",
                "id": "sha256:" + hashlib.sha256(reference.encode()).hexdigest(), "repoDigests": [reference]}).encode())
        if args[1] == "login":
            self.assertEqual(payload, b"synthetic-private-ghcr-token")
            directory = Path(environment["DOCKER_CONFIG"])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            (directory / "config.json").write_text("synthetic-authentication-file")
        if args[1] == "pull":
            if self.fail_pull:
                return SimpleNamespace(returncode=1, stdout=b"", stderr=b"private registry diagnostics")
            self.cached.add(args[-1])
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def execute(self):
        with patch.object(prepare, "_run", side_effect=self.engine):
            return prepare.cache_images(self.refs, self.output, "princessdardan", "synthetic-private-ghcr-token")

    def test_fully_cached_exact_images_require_no_authentication_or_pull(self):
        result = self.execute()
        self.assertEqual(result["status"], "RECREATION_EXACT_IMAGES_CACHED")
        self.assertFalse(any(c[0][1] in ("login", "pull", "run") for c in self.calls))
        self.assertEqual(len(result["actualImages"]), 6)

    def test_missing_image_uses_private_stdin_and_removes_auth_configuration_before_success(self):
        self.cached.remove(self.refs["gateway"])
        result = self.execute()
        self.assertTrue(result["registryConfigurationRemoved"])
        login = next(c for c in self.calls if c[0][1] == "login")
        self.assertNotIn("synthetic-private-ghcr-token", json.dumps(login[:2]))
        self.assertFalse(Path(login[1]["DOCKER_CONFIG"]).exists())
        self.assertEqual(sum(c[0][1] == "pull" for c in self.calls), 1)
        self.assertFalse(any("synthetic-private-ghcr-token" in p.read_text() for p in self.output.glob("*.json")))

    def test_uncertain_pull_is_not_retried_and_auth_file_is_removed_on_failure(self):
        self.cached.remove(self.refs["gateway"]); self.fail_pull = True
        with self.assertRaisesRegex(ValueError, "EXACT_IMAGE_PULL"):
            self.execute()
        self.assertEqual(sum(c[0][1] == "pull" for c in self.calls), 1)
        self.assertFalse(any(self.output.glob("lash-ghcr-read-*")))
        result = migrate.read_json(self.output, "image-cache-outcome.json")
        self.assertTrue(result["registryConfigurationRemoved"])
        self.assertNotIn("private registry diagnostics", json.dumps(result))

    def test_mutable_or_foreign_registry_refuses_before_any_docker_or_auth_operation(self):
        self.refs["gateway"] = "docker.io/foreign/image:latest"
        with self.assertRaisesRegex(ValueError, "FIXED_IMAGE_SET"):
            self.execute()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
