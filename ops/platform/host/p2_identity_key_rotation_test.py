import json
from copy import deepcopy
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p2_identity_key_rotation as rotation
import p2_identity_negative_probe as identity


class IdentityKeyRotationPlanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-p2-key-rotation-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.installed = self.root / "operators"
        self.commit = "a" * 40
        self.source = self.installed / self.commit
        actual = Path(rotation.__file__).resolve().parents[3]
        for name in (*rotation.FILES, rotation.IDENTITY):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(actual / name, target)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        candidate = b'{"owned":"rotation"}\n'
        (self.bundle / "release.candidate.json").write_bytes(candidate)
        source_files = identity.source_closure(actual)
        self.identity = {
            "version": 1, "environment": "staging", "probeId": "owned-rotation-identity", "releaseId": "owned-release",
            "candidateSha256": rotation._hash(candidate), "hostMachineId": "1" * 32, "configurationSha256": "2" * 64,
            "sources": {name: self.commit for name in ("frontend", "course", "community")},
            "containers": [{"service": service, "containerId": format(index + 1, "064x"),
                "image": "ghcr.io/princessdardan/lash-her-platform-" + suffix + "@sha256:" + format(index + 7, "064x")}
                for index, (service, suffix) in enumerate((("gateway", "gateway"), ("course-api", "course-runtime"),
                    ("community-api", "community-runtime")))],
            "subjects": {name: str(uuid.UUID(int=index + 1, version=4)) for index, name in enumerate(("learnerA", "learnerB", "admin"))},
            "resources": {name: str(uuid.UUID(int=index + 10, version=4)) for index, name in enumerate(("courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"))},
            "programSha256": "3" * 64, "previousProfiles": [], "operatorSourceFiles": source_files,
            "operatorSourceSha256": identity._hash(identity._canonical(source_files)),
            "priorEvidence": {"originalReleaseReceiptSha256": "4" * 64, "frontendDeploymentRecordSha256": "5" * 64},
        }
        configurations = {}
        for phase in ("baseline", "overlap", "currentOnly"):
            directory = self.root / "configuration" / phase
            directory.mkdir(parents=True)
            configurations[phase] = {"directory": str(directory), "configurationRecordSha256": rotation._hash(phase)}
        configurations["restoration"] = {**configurations["baseline"]}
        self.reviewed = {"version": 1, "environment": "staging", "actionId": "p2-key-rotation-owned", "identity": self.identity,
            "phaseConfigurations": configurations, "restorationPhase": "baseline", "operatorFiles": rotation.operator_hashes(self.source),
            "programSha256": rotation._hash(rotation.private_program(self.source)), "parentSourceSha256": "6" * 64}

    def patches(self):
        return patch.multiple(rotation, ROOT=self.root, OPERATOR_ROOT=self.installed)

    def test_closed_reviewed_contract_requires_current_only_baseline_and_fixed_restoration_target(self):
        with self.patches():
            self.assertIs(rotation.validate_reviewed(self.reviewed), self.reviewed)
            for mutate in (lambda value: value.update(environment="production"),
                    lambda value: value["identity"].update(previousProfiles=["course-learner"]),
                    lambda value: value["phaseConfigurations"]["restoration"].update(directory=str(self.root / "other")),
                    lambda value: value["phaseConfigurations"]["restoration"].update(configurationRecordSha256="f" * 64),
                    lambda value: value.update(command=["sh"])):
                changed = deepcopy(self.reviewed); mutate(changed)
                with self.assertRaises(ValueError):
                    rotation.validate_reviewed(changed)

    def test_plan_binds_source_candidate_four_profiles_and_remains_live_ineligible(self):
        with self.patches():
            value = rotation.make_plan(self.bundle, self.reviewed, self.source)
        self.assertEqual(value["status"], "P2_IDENTITY_KEY_ROTATION_PLAN")
        self.assertEqual(set(value["profiles"]), set(rotation.PROFILES))
        self.assertFalse(value["parentAdapterReady"])
        self.assertFalse(value["liveEligible"])
        self.assertFalse(value["keyRemovalVerified"])
        self.assertFalse(value["credentialValuesRead"])
        self.assertEqual(value["evidenceClasses"]["community-member"], "deployed-private-community-verifier")

    def test_program_embeds_exact_existing_identity_helper_and_changes_with_either_source(self):
        original = rotation.private_program(self.source)
        self.assertNotIn(b'./p2-identity-negative-probe.mjs', original)
        self.assertIn(b"runPrivateRotationFromStdin", original)
        with (self.source / rotation.IDENTITY).open("ab") as handle:
            handle.write(b"\n// changed\n")
        self.assertNotEqual(original, rotation.private_program(self.source))

    def test_execute_refuses_every_nonplan_operation_before_parent_or_network(self):
        with self.patches():
            for operation in ("overlap", "current-only", "restore", "qualify", "shell"):
                with self.assertRaises(ValueError):
                    rotation.execute(self.bundle, self.reviewed, self.source, operation)

    def test_cli_malformed_or_activation_packets_return_one_nonsecret_refusal(self):
        entry = Path(rotation.__file__)
        for raw in (b"not-json-private-key", json.dumps({"version": 1, "operation": "overlap", "token": "private"}).encode()):
            result = subprocess.run([sys.executable, "-I", "-B", str(entry)], input=raw, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"")
            self.assertNotIn(b"private", result.stdout)
            self.assertFalse(json.loads(result.stdout)["keyRemovalVerified"])


if __name__ == "__main__":
    unittest.main()
