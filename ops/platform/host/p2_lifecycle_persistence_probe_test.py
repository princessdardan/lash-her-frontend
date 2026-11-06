import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import p2_lifecycle_persistence_probe as probe
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope


class PersistenceProbeTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[3]

    def test_private_program_is_exact_source_bound_and_has_fixed_entry(self):
        program = probe.private_program(self.source)
        self.assertLess(len(program), 131_072)
        self.assertIn(b"runPrivatePersistenceProbeFromStdin", program)
        self.assertEqual(program, probe.private_program(self.source))
        changed = dict(probe.operator_hashes(self.source))
        changed[probe.FILES[0]] = "0" * 64
        self.assertNotEqual(changed, probe.operator_hashes(self.source))

    def test_subject_binding_covers_private_original_email_without_emitting_it(self):
        base = {"stage": "capture-delete-baseline", "userId": "00000000-0000-4000-8000-000000000001",
            "originalEmail": "owned@example.invalid", "exportCommand": {"commandId": "00000000-0000-4000-8000-000000000002", "accountVersion": 1},
            "attemptIds": ["00000000-0000-4000-8000-000000000003"], "grantIds": ["00000000-0000-4000-8000-000000000004"],
            "streamIds": ["00000000-0000-4000-8000-000000000005"], "inboxEventIds": ["00000000-0000-4000-8000-000000000006"]}
        first = probe._subject_binding(base)
        changed = dict(base, originalEmail="wrong@example.invalid")
        self.assertNotEqual(first, probe._subject_binding(changed))
        self.assertNotIn(base["originalEmail"], first)

    def test_scope_accepts_only_exact_selected_container_program_and_private_stdin(self):
        scope = object.__new__(CurrentLifecyclePersistenceScope)
        scope.reviewed = {"containers": [
            {"service": "course-api", "containerId": "1" * 64, "image": "sha256:" + "1" * 64, "health": "healthy"},
            {"service": "community-api", "containerId": "2" * 64, "image": "sha256:" + "2" * 64, "health": "healthy"}]}
        scope.persistence_program = b"fixed-program"
        payload = json.dumps({"version": 1, "mode": "frontend", "environment": "staging"}).encode()
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=128",
            "--env", "DOTENV_CONFIG_QUIET=true", "1" * 64, "node", "--input-type=module", "--eval", "fixed-program"]
        scope._allowed(args, payload, runtime.SAFE_ENV)
        with self.assertRaises(Exception):
            scope._allowed(args[:-1] + ["changed"], payload, runtime.SAFE_ENV)
        with self.assertRaises(Exception):
            scope._allowed(args, json.dumps({"mode": "shell", "environment": "staging"}).encode(), runtime.SAFE_ENV)

    def test_common_failure_contains_no_private_child_details(self):
        failure = probe.PersistenceFailure("persistence-current-stage-refused").public_receipt
        self.assertEqual(sorted(failure), sorted(["version", "status", "check", "readOnly", "providerTouched", "releaseAccepted"]))
        self.assertNotIn("database", json.dumps(failure).lower())

    def test_owned_scope_brackets_receiver_reads_with_stable_frontend(self):
        scope = object.__new__(CurrentLifecyclePersistenceScope)
        modes = []
        scope.verify = lambda: None
        scope.run_persistence = lambda mode, _payload: modes.append(mode) or object()
        values = [
            {"service": "frontend", "observation": {"now": "2026-11-06T00:00:00.000Z", "state": "fixed"}},
            {"service": "course", "observation": {"state": "fixed"}},
            {"service": "community", "observation": {"state": "fixed"}},
            {"service": "frontend", "observation": {"now": "2026-11-06T00:00:01.000Z", "state": "fixed"}},
            {"witness": {"private": True}, "receipt": {"status": "fixed"}},
        ]
        plan = {"targets": {name: {} for name in ("frontend", "course", "community")}}
        with mock.patch.object(probe, "_parse_child", side_effect=values):
            result = probe.observe_with_scope(plan, {}, scope, "private-url")
        self.assertEqual(modes, ["frontend", "course", "community", "frontend", "combine"])
        self.assertEqual(result["observations"]["frontend"]["state"], "fixed")

        changed = list(values)
        changed[3] = {"service": "frontend", "observation": {"now": "2026-11-06T00:00:01.000Z", "state": "changed"}}
        modes.clear()
        with mock.patch.object(probe, "_parse_child", side_effect=changed), self.assertRaises(Exception):
            probe.observe_with_scope(plan, {}, scope, "private-url")


if __name__ == "__main__":
    unittest.main()
