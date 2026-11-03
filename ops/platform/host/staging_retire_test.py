import fcntl
import hashlib
import json
from contextlib import ExitStack
import unittest
from unittest.mock import patch

import migrate
import staging_restore
import staging_retire as retire
import staging_state
import staging_state_test


class StagingRetireTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests(); self.fixture.setUp()
        self.runtime = self.fixture.runtime
        self.selected, self.jobs, self.plan, self.compose = self.fixture.bind()
        self.inventory = self.runtime.root / "external-inventory"; self.inventory.mkdir(mode=0o700)
        self.now = 1_800_000_000_000
        self.external = {"status": "MUX_DEV_DASHBOARD_INVENTORY_VERIFIED", "observedAt": self.now - 10_000,
            "environmentId": "7j65e8", "organizationId": "4g1uhq", "environmentName": "Lash Her Academy [DEV]",
            "sourceUrl": retire.MUX_PAGE, "inventoryComplete": True, "settingsChanged": False,
            "webhooks": [{"address": "http://localhost:4000/v1/webhooks/mux", "enabled": True}],
            "stagingGatewayWebhookCount": 0, "maskedAccessibilitySha256": "a" * 64, "maskedScreenshotSha256": "b" * 64}
        self.inventory_hash = self.save_inventory()
        self.output = self.runtime.root / "retire-action"
        self.clock = unittest.mock.Mock(); self.clock.time.return_value = self.now / 1000
        self.args = {"bundle": self.runtime.bundle, "configuration": self.runtime.configuration,
            "database_receipts": self.fixture.database, "runtime_receipts": self.fixture.receipts,
            "compose_file": self.runtime.compose, "candidate_sha256": self.fixture.candidate_hash,
            "inventory_directory": self.inventory, "inventory_sha256": self.inventory_hash,
            "expected_configuration_sha256": staging_state.configuration_hashes(self.runtime.configuration),
            "expected_deployment": "dpl_fixture", "action": "retire-test-release", "output": self.output,
            "clock": self.clock}
        self.stopped = []
        self.paused = set()
        self.calls = []
        self.bad_exit = False

    def tearDown(self):
        self.fixture.tearDown()

    def save_inventory(self):
        file = self.inventory / "mux-inventory.json"
        file.write_text(json.dumps(self.external)); file.chmod(0o600)
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def locked(self):
        with (self.runtime.root / "release.lock").open() as stream:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def units(self, unit):
        return {"LoadState": "loaded", "ActiveState": "inactive" if unit in retire.SERVICES or unit in self.paused else "active",
                "UnitFileState": "disabled" if unit in self.paused else "enabled"}

    def command(self, args, env, timeout=30):
        self.locked(); self.calls.append(args)
        self.assertEqual(env, retire.runtime.SAFE_ENV)
        if args[0] == "systemctl":
            self.assertEqual(args[1:3], ["disable", "--now"])
            self.assertIn(args[-1], retire.TIMERS); self.paused.add(args[-1]); return ""
        if args[:3] == ["docker", "ps", "--all"]:
            return "\n".join(c["containerId"] for c in self.plan["originalContainers"])
        if args[:2] == ["docker", "stop"]:
            self.assertEqual(self.paused, set(retire.TIMERS))
            self.stopped.append(args[-1]); return args[-1]
        if args[:2] == ["docker", "inspect"]:
            c = next(c for c in self.plan["originalContainers"] if c["containerId"] == args[-1])
            self.assertIn(c["containerId"], self.stopped)
            return "|".join((c["containerId"], c["image"], "false", "137" if self.bad_exit else "0", "false", "lash-her-staging", c["service"]))
        if args[:2] == ["docker", "ps"] or args[0] == "ss":
            self.assertEqual(len(self.stopped), 8); return ""
        self.fail("Unexpected command: " + repr(args))

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(retire.runtime, "assert_host"))
        stack.enter_context(patch.object(retire.runtime, "check_containers", return_value=self.plan["originalContainers"]))
        stack.enter_context(patch.object(retire.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(retire, "unit_state", side_effect=self.units))
        stack.enter_context(patch.object(retire, "provider_state", side_effect=lambda *_: self.locked() or {"enabled": False}))
        return stack

    def execute(self, **changes):
        args = {**self.args, "apply": True, "confirmation": "staging/test-release/retire-test-release", "client": object(),
                "lock_path": self.runtime.root / "release.lock"}
        args.update(changes)
        return retire.execute(**args)

    def test_plan_uses_reviewed_external_inventory_without_reading_runtime_secrets_or_touching_host(self):
        for service in retire.runtime.ENV_FILES:
            (self.runtime.configuration / (service + ".env")).unlink()
        with patch.object(retire.runtime, "command", side_effect=AssertionError("host touched")):
            plan = self.execute(apply=False, client=None)
        self.assertFalse(plan["hostRetired"])
        self.assertFalse(plan["infrastructureOperationIncluded"])
        self.assertEqual(plan["externalProducerInventory"]["disposition"], "no-staging-gateway-webhook-configured")
        self.assertFalse(self.output.exists())

    def test_stale_incomplete_changed_environment_or_added_webhook_refuses(self):
        for key, value in (("observedAt", self.now - 900_001), ("observedAt", self.now + 1),
                ("environmentId", "mpbbkt"), ("inventoryComplete", False), ("stagingGatewayWebhookCount", 1),
                ("webhooks", [{"address": "https://api-staging.lashher.com/v1/webhooks/mux", "enabled": True}])):
            original = self.external[key]; self.external[key] = value; digest = self.save_inventory()
            with self.assertRaisesRegex(ValueError, "FRESH_REVIEWED_DEV_INVENTORY"):
                self.execute(inventory_sha256=digest)
            self.external[key] = original
        self.assertEqual(self.calls, [])

    def test_hash_and_explicit_confirmation_are_required_before_host_mutations(self):
        for changes, marker in (({"inventory_sha256": "0" * 64}, "INVENTORY_HASH"),
                ({"confirmation": "production/test-release"}, "CONFIRMATION"),
                ({"client": None}, "TRUSTED_PARENT")):
            with self.assertRaisesRegex(ValueError, marker):
                self.execute(**changes)
        self.assertEqual(self.calls, [])

    def test_actual_graceful_stops_produce_restorable_retirement_record_under_one_lock(self):
        def prepare(selected, plan, configuration, output):
            self.locked()
            self.assertEqual(self.paused, set(retire.TIMERS))
            self.assertEqual(self.stopped, [])
            selected["environment"] = "production"; plan["trafficAuthorized"] = True
        with self.patches():
            result = self.execute(before_stop=prepare)
        self.assertEqual(result["status"], "STAGING_RUNTIME_QUIESCED_FOR_RECREATION")
        self.assertFalse(result["trafficAuthorized"])
        self.assertFalse(result["hostRetired"])
        self.assertEqual(len(result["stoppedContainers"]), 8)
        self.assertEqual([c["service"] for c in result["stoppedContainers"]], [s for stage in reversed(retire.runtime.STAGES) for s in stage])
        self.assertNotIn("private-fixture", (self.output / "retirement-outcome.json").read_text())
        raw_hash = hashlib.sha256((self.output / "retirement-outcome.json").read_bytes()).hexdigest()
        *_, restore_plan, _ = staging_restore.make_plan(*self.fixture.args, self.output, raw_hash, "2" * 32,
                                                      "restore-test-release", "dpl_fixture")
        self.assertEqual(restore_plan["retirementOutcomeSha256"], raw_hash)
        with self.patches(), self.assertRaisesRegex(ValueError, "EXCLUSIVE_OUTPUT"):
            self.execute()

    def test_changed_private_copy_or_provider_refusal_prevents_timer_or_container_mutations(self):
        with self.patches(), patch.object(retire, "provider_state", side_effect=ValueError("PROVIDER_CHANGED")):
            with self.assertRaisesRegex(ValueError, "PROVIDER_CHANGED"):
                self.execute()
        self.assertEqual(self.paused, set()); self.assertEqual(self.stopped, [])
        hashes = dict(self.args["expected_configuration_sha256"]); hashes["course-api.env"] = "0" * 64
        with self.patches(), self.assertRaisesRegex(ValueError, "OFFHOST_CONFIGURATION_MISMATCH"):
            self.execute(expected_configuration_sha256=hashes)
        self.assertFalse(self.output.exists())

    def test_nonzero_exit_cannot_authorize_deletion_and_partial_progress_is_retained(self):
        self.bad_exit = True
        with self.patches(), self.assertRaisesRegex(ValueError, "GRACEFUL_EXACT_CONTAINER_STOP"):
            self.execute()
        failure = migrate.read_json(self.output, "retirement-outcome.json")
        self.assertEqual(failure["status"], "STAGING_QUIESCENCE_REQUIRES_REVIEW")
        self.assertEqual(set(failure["pausedTimers"]), set(retire.TIMERS))
        self.assertTrue(failure["partialChangesRequireInspection"])
        self.assertFalse(failure["hostRetired"])
        self.assertEqual(len(self.stopped), 1)
        self.assertNotIn("start", [a[1] for a in self.calls])

    def test_sensitive_raw_failure_is_sanitized_and_never_retried(self):
        def fail(*_args):
            raise RuntimeError("private-fixture")
        with self.patches(), self.assertRaisesRegex(ValueError, "STAGING_QUIESCENCE_EXECUTION_FAILED"):
            self.execute(before_stop=fail)
        self.assertEqual(self.stopped, [])
        self.assertEqual(self.paused, set(retire.TIMERS))
        self.assertNotIn("private-fixture", (self.output / "retirement-outcome.json").read_text())

    def test_native_schedule_timestamp_must_prove_drain(self):
        state = {"projectId": "prj_fixture", "enabled": False}
        project = {"crons": {"deploymentId": "dpl_fixture", "disabledAt": self.now - 16_000}}
        with patch.object(retire.staging_restore, "check_provider", return_value=state), patch.object(retire.vercel, "_project", return_value=project):
            result = retire.provider_state(object(), self.selected, {"frontendDeploymentId": "dpl_fixture"}, self.now)
            self.assertEqual(result["disabledAt"], self.now - 16_000)
            for disabled in (None, self.now - 15_999, self.now + 1, True):
                project["crons"]["disabledAt"] = disabled
                with self.assertRaisesRegex(ValueError, "DISABLED_AND_DRAINED"):
                    retire.provider_state(object(), self.selected, {"frontendDeploymentId": "dpl_fixture"}, self.now)

    def test_parent_lock_is_retained_across_retirement_for_following_runtime_rounds(self):
        with (self.runtime.root / "release.lock").open("a+") as owner:
            fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.patches():
                result = self.execute(lock_handle=owner)
            self.assertFalse(owner.closed)
            self.locked()
        self.assertEqual(result["status"], "STAGING_RUNTIME_QUIESCED_FOR_RECREATION")

    def test_unrelated_parent_lock_cannot_substitute_for_the_shared_release_lock(self):
        with (self.runtime.root / "other.lock").open("a+") as other, self.patches():
            with self.assertRaisesRegex(ValueError, "EXACT_PARENT_LOCK_HANDLE"):
                self.execute(lock_handle=other)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.paused, set()); self.assertEqual(self.stopped, [])


if __name__ == "__main__":
    unittest.main()
