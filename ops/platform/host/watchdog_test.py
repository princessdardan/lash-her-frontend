from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import watchdog


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = 10000
        self.worker = {"id": "a" * 64, "service": "community-worker", "health": "unhealthy"}

    def test_migrations_unknown_and_healthy_processes_are_excluded(self):
        items = [self.worker, {**self.worker, "service": "course-migration"}, {**self.worker, "service": "unknown"}, {**self.worker, "health": "healthy"}, {**self.worker, "id": "invalid"}]
        self.assertEqual(watchdog.recovery_actions(items, {}, self.now), [self.worker])

    def test_hourly_backoff_and_overlapping_replicas_share_one_budget(self):
        self.assertEqual(watchdog.recovery_actions([self.worker, {**self.worker, "id": "b" * 64}], {}, self.now), [self.worker])
        for history in [[self.now - 1], [self.now - 400, self.now - 800, self.now - 1200], [self.now + 60]]:
            self.assertEqual(watchdog.recovery_actions([self.worker], {"community-worker": history}, self.now), [])
        self.assertEqual(watchdog.recovery_actions([self.worker], {"community-worker": [self.now - 4000]}, self.now), [self.worker])

    def test_intent_is_written_atomically_with_private_mode(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "watchdog.json")
            watchdog.persist_intent(path, {"community-worker": [self.now]})
            self.assertEqual(json.loads(path.read_text()), {"community-worker": [self.now]})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_invalid_target_refuses_before_docker(self):
        with patch.object(watchdog, "command", side_effect=AssertionError("Unexpected Docker call")):
            for project, path in [("unknown", "/var/lib/lash-her/watchdog.json"), ("lash-her-staging", "/var/lib/lash-her/../../tmp/state")]:
                with self.assertRaises(ValueError):
                    watchdog.recover(project, Path(path), True)


if __name__ == "__main__":
    unittest.main()
