import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import migrate
import recreation_files as files


class RecreationPrivateFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.patch = patch.object(files, "ROOT", self.root); self.patch.start()
        self.action = "p1-recreate-owned"
        self.value = {"action": self.action, "files": []}
        self.add("configuration/course-api.env", b"PRIVATE_OWNED_TEST_VALUE=synthetic\n")
        self.add("compose.yaml", b"owned reviewed compose")

    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()

    def add(self, name, raw):
        self.value["files"].append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()})
        self.manifest()

    def manifest(self):
        value = {f["path"]: f["sha256"] for f in self.value["files"]}
        self.value["manifestSha256"] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def test_hash_checked_private_handoff_is_exclusive_and_does_not_export_values(self):
        self.add("maintenance/acme-staging/accounts/owned/account.json", b'{"owned":"synthetic-account"}')
        result = files.stage(self.value)
        target = self.root / self.action / "inputs/configuration/course-api.env"
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(target.read_bytes(), base64.b64decode(self.value["files"][0]["data"]))
        self.assertNotIn("synthetic", json.dumps(result))
        self.assertNotIn("data", result)
        for name in ("maintenance", "maintenance/acme-staging", "maintenance/acme-staging/accounts", "maintenance/acme-staging/accounts/owned"):
            self.assertEqual((self.root / self.action / "inputs" / name).stat().st_mode & 0o777, 0o700)
        with self.assertRaisesRegex(ValueError, "EXCLUSIVE_ACTION"):
            files.stage(self.value)

    def test_traversal_duplicate_unreviewed_hash_or_host_bootstrap_restoration_refuses_before_write(self):
        original = json.loads(json.dumps(self.value))
        for name in ("../../etc/passwd", "/etc/passwd", "configuration/../runtime.json", "host-bootstrap.json", "unexpected.pem"):
            self.value = json.loads(json.dumps(original)); self.value["files"][0]["path"] = name; self.manifest()
            with self.assertRaises(ValueError):
                files.stage(self.value)
            self.assertFalse(self.root.joinpath(self.action).exists())
        self.value = json.loads(json.dumps(original)); self.value["files"].append(self.value["files"][0]); self.manifest()
        with self.assertRaises(ValueError):
            files.stage(self.value)
        self.value = original; self.value["manifestSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "REVIEWED_MANIFEST"):
            files.stage(self.value)
        self.assertFalse(self.root.joinpath(self.action).exists())

    def test_fresh_host_missing_release_parents_are_created_privately_only_after_validation(self):
        missing = self.root / "fresh" / "releases" / "staging"
        self.add("maintenance/acme-staging/initial-issuance.log", b"owned diagnostic log")
        with patch.object(files, "ROOT", missing):
            with self.assertRaisesRegex(ValueError, "ACME_SCOPE"):
                files.stage(self.value)
            self.assertFalse(missing.parent.parent.exists())
            self.value["files"].pop(); self.manifest()
            files.validate_inputs(self.value)
            self.assertFalse(missing.parent.parent.exists())
            files.stage(self.value)
            for path in [missing.parent.parent, missing.parent, missing, missing / self.action]:
                self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertTrue((missing / self.action / "inputs/configuration/course-api.env").is_file())

    def test_existing_action_symlink_cannot_redirect_private_configuration(self):
        alias = self.root / self.action; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "SYMLINK"):
            files.stage(self.value)
        self.assertFalse(self.root.joinpath("inputs").exists())

    def test_export_reads_only_fixed_json_receipts_and_excludes_keys_env_and_child_errors(self):
        directory = self.root / self.action / "retirement"
        directory.mkdir(parents=True, mode=0o700)
        migrate.write_json(directory, "retirement-outcome.json", {"status": "owned"})
        for name in ("course-api.env", "private-child-stderr.bin", "ca.key"):
            (directory / name).write_text("do-not-export-this")
        value = files.receipts({"action": self.action, "phase": "retirement"})
        self.assertEqual([f["path"] for f in value["files"]], ["retirement-outcome.json"])
        self.assertNotIn("do-not-export-this", json.dumps(value))
        with self.assertRaisesRegex(ValueError, "FIXED_RECEIPT_PHASE"):
            files.receipts({"action": self.action, "phase": "inputs"})

    def test_receipt_symlink_and_absent_terminal_outcome_cannot_authorize_deletion(self):
        directory = self.root / self.action / "retirement"; directory.mkdir(parents=True, mode=0o700)
        with self.assertRaisesRegex(ValueError, "TERMINAL_OUTCOME"):
            files.receipts({"action": self.action, "phase": "retirement"})
        (directory / "retirement-outcome.json").symlink_to(self.root / "private.json")
        with self.assertRaisesRegex(ValueError, "RECEIPT_SYMLINK"):
            files.receipts({"action": self.action, "phase": "retirement"})


if __name__ == "__main__":
    unittest.main()
