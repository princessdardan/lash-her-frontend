"""Owned filesystem/authority guards only. No staging, Docker, or browser claims."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import p2_lifecycle_suspension_evidence as evidence


class SuspensionEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-suspension-records-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)

    def test_serialized_held_assertion_cannot_construct_real_parent_scope(self):
        with self.assertRaisesRegex(ValueError, "P2_SUSPENSION_ACTUAL_PHYSICAL_PARENT_SCOPE_REQUIRED"):
            evidence.P2LifecycleSuspensionEvidenceStage({"held": True}, {}, {}, self.directory, self.directory, {}, {}, {})

    def test_exclusive_private_file_is_hashed_and_cannot_be_replaced(self):
        value = {"version": 1, "status": "OWNED_RECORD"}
        result = evidence.private_record(self.directory, "browser-parent-intent.json", value)
        path = self.directory / "browser-parent-intent.json"
        self.assertEqual(result["recordSha256"], evidence.digest(path.read_bytes()))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            evidence.private_record(self.directory, "browser-parent-intent.json", {"changed": True})
        self.assertEqual(json.loads(path.read_bytes()), value)

    def test_arbitrary_filename_symlink_or_nonprivate_directory_refuses(self):
        with self.assertRaises(ValueError):
            evidence.private_record(self.directory, "foreign.json", {})
        destination = self.directory / "destination"; destination.write_text("original")
        (self.directory / "p2-lifecycle-browser-source.json").symlink_to(destination)
        with self.assertRaises(OSError):
            evidence.private_record(self.directory, "p2-lifecycle-browser-source.json", {})
        self.assertEqual(destination.read_text(), "original")
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            evidence.private_record(self.directory, "browser-parent-intent.json", {})

    def test_record_failure_never_becomes_a_standalone_browser_import_path(self):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", "import sys;sys.path.insert(0,sys.argv[1]);import runpy;runpy.run_module('p2_lifecycle_suspension_evidence',run_name='__main__')", str(Path(evidence.__file__).parent)],
            input=b'{"browserCalled":true}', capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout)
        self.assertFalse(record["standaloneEligible"]); self.assertFalse(record["browserCalled"]); self.assertFalse(record["workerInvoked"])

    def test_natural_expiry_requires_real_accepted_and_denied_order_with_fixed_original_payload(self):
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.directory = self.directory
        stage.scope = type("OwnedScope", (), {"verify": lambda self: None})()
        def observation(status, timestamp):
            return {"status": "P2_S13_PRIVATE_USER_OBSERVED", "observation": {"status": status, "requestStartedAt": timestamp, "responseEndedAt": timestamp}}
        payload = {"owned-token": "OWNED-SYNTHETIC-NOT-A-LIVE-CREDENTIAL"}
        values = iter([observation(200, "1970-01-01T00:16:39.500Z"), observation(401, "1970-01-01T00:16:40.000Z")])
        seen = []
        stage._timing = lambda actual: (seen.append(actual), next(values))[1]
        with patch.object(evidence.time, "time", return_value=1000), patch.object(evidence.time, "monotonic", return_value=0), patch.object(evidence.time, "sleep"):
            result = stage._natural_window("user", 1000000, payload)
        self.assertEqual([row["status"] for row in (result["lastAccepted"], result["firstDenied"])], [200, 401])
        self.assertTrue(all(row is payload for row in seen))
        self.assertNotIn(payload["owned-token"], (self.directory / "controlled-user-window.json").read_text())
        for rejected in (observation(503, "1970-01-01T00:16:40.000Z"), observation(401, "1970-01-01T00:16:39.999Z")):
            rows = iter([observation(200, "1970-01-01T00:16:39.500Z"), rejected])
            stage._timing = lambda _payload: next(rows)
            with patch.object(evidence.time, "time", return_value=1000), patch.object(evidence.time, "monotonic", return_value=0), patch.object(evidence.time, "sleep"):
                with self.assertRaises(ValueError):
                    stage._natural_window("user", 1000000, payload)

    def test_private_credentials_are_outside_artifact_tree_and_scrubbed_without_pg_or_provider(self):
        stage = evidence.P2LifecycleSuspensionEvidenceStage.__new__(evidence.P2LifecycleSuspensionEvidenceStage)
        stage.credentials_directory = self.directory
        stage.capture = {"controlledUser": {"token": "OWNED-SYNTHETIC-TOKEN"}, "playback": {"requestUrl": "OWNED-SYNTHETIC-URL"}}
        evidence.private_record(self.directory, "controlled-capture.json", stage.capture)
        stage.verify = lambda: (_ for _ in ()).throw(ValueError("OWNED_BACKEND_LOST"))
        self.assertNotEqual(evidence.PRIVATE_ROOT, evidence.ROOT)
        self.assertTrue(stage.scrub_controlled_credentials()["controlledCredentialsRemoved"])
        self.assertFalse((self.directory / "controlled-capture.json").exists())
        self.assertEqual(stage.capture["controlledUser"]["token"], "")
        self.assertTrue(stage.scrub_controlled_credentials()["controlledCredentialsRemoved"])


if __name__ == "__main__":
    unittest.main()
