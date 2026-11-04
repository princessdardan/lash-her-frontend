import hashlib
import json
import fcntl
import os
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import migrate
import staging_rollback as rollback
import staging_state_test


class StagingRollbackTests(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests(); self.fixture.setUp()
        self.runtime = self.fixture.runtime
        self.selected, self.jobs, self.plan, self.compose = self.fixture.bind()
        self.compatibility = self.runtime.root / "compatibility"; self.compatibility.mkdir(mode=0o700)
        current = {key: value["image"] for key, value in self.selected["artifacts"].items()}
        previous_images = {key: value.split("@")[0] + "@sha256:" + "9" * 64 if key in rollback.RUNTIME_KEYS else value for key, value in current.items()}
        self.previous = {"releaseId": "previous-test-release", "images": previous_images}
        rounds = []
        for index, phase in enumerate(("current", "compatible-rollback", "restore-current")):
            images = previous_images if index == 1 else current
            containers = [{"service": service, "containerId": hashlib.sha256((phase + service).encode()).hexdigest(),
                           "reference": images[rollback.runtime.IMAGE_KEYS[service]]} for service in rollback.runtime.SERVICES]
            rounds.append({"phase": phase, "records": [{"name": name, "passed": True} for name in rollback.COMPATIBILITY_CHECKS],
                "preservedPriorBusinessRows": True, "runningImages": containers, "recoveredPendingEvents": 0 if index == 0 else 2,
                "gracefulStop": {"processes": [{**c, "running": False, "exitCode": 0, "oomKilled": False} for c in containers]}})
        rounds[0]["ordinaryAdminFixture"] = {"status": "STAGING_FIXTURE_TWO_GRANTS_CREATED", "coursePublished": False,
            "retainedWork": {"status": "STAGING_DURABLE_WORK_RETAINED"}, "recoveredWork": {"status": "STAGING_DURABLE_WORK_RECOVERED", "eventsRecovered": 2}}
        self.proof = {"status": "PUBLISHED_APPLICATION_ROLLBACK_AND_DURABLE_RECOVERY_PASS", "cleanupPassed": True,
            "actualStagingChanged": False, "images": current, "rollbackImages": previous_images,
            "currentRelease": "test-release", "rollbackRelease": "previous-test-release", "applicationVersionOverlapped": False, "rounds": rounds}
        self.save()
        self.args = (*self.fixture.args, self.compatibility, self.previous_hash, self.proof_hash, "dpl_fixture", "rollback-test-release")

    def tearDown(self):
        self.fixture.tearDown()

    def save(self):
        for name, value in (("compatible.candidate.json", self.previous), ("compatibility-proof.json", self.proof)):
            file = self.compatibility / name; file.write_text(json.dumps(value)); file.chmod(0o600)
        self.previous_hash = hashlib.sha256((self.compatibility / "compatible.candidate.json").read_bytes()).hexdigest()
        self.proof_hash = hashlib.sha256((self.compatibility / "compatibility-proof.json").read_bytes()).hexdigest()

    def plan_only(self):
        return rollback.make_plan(*self.args)

    def test_offline_plan_binds_actual_image_compatibility_and_never_reads_runtime_credentials(self):
        for service in rollback.runtime.ENV_FILES:
            (self.runtime.configuration / (service + ".env")).unlink()
        with patch.object(rollback.runtime, "command", side_effect=AssertionError("process invoked")):
            selected, _, plan, _, execution = self.plan_only()
        self.assertEqual(selected, self.selected)
        self.assertEqual(plan["previousRuntimeReleaseId"], "previous-test-release")
        self.assertFalse(plan["migrationsExecuted"])
        self.assertFalse(plan["vmRecreationIncluded"])
        self.assertFalse(plan["finalAdmissionIncluded"])
        self.assertNotIn("sources", execution)
        self.assertTrue(all(set(value) == {"image"} for value in execution["artifacts"].values()))

    def test_changed_independently_reviewed_proof_or_candidate_hash_refuses(self):
        file = self.compatibility / "compatible.candidate.json"; file.write_bytes(file.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "COMPATIBILITY_HASHES"):
            self.plan_only()

    def test_counts_and_passing_booleans_cannot_replace_named_checks_actual_images_and_recovered_events(self):
        for change in (lambda p: p["rounds"][0]["records"][0].update(name="unrelated"),
                       lambda p: p["rounds"][1]["runningImages"][0].update(reference="other-image"),
                       lambda p: p["rounds"][1].update(recoveredPendingEvents=0),
                       lambda p: p["rounds"][0]["ordinaryAdminFixture"].update(coursePublished=True)):
            original = json.loads(json.dumps(self.proof)); change(self.proof); self.save()
            with self.assertRaises(ValueError):
                rollback.compatibility(self.compatibility, self.previous_hash, self.proof_hash, self.selected)
            self.proof = original

    def test_wrong_previous_registry_or_current_migration_substitution_refuses(self):
        self.previous["images"]["courseRuntime"] = "ghcr.io/other/other@sha256:" + "9" * 64
        self.proof["rollbackImages"] = self.previous["images"]; self.save()
        with self.assertRaises(ValueError):
            rollback.compatibility(self.compatibility, self.previous_hash, self.proof_hash, self.selected)

    def test_restore_order_places_actual_publication_before_reconciliation_and_gateway(self):
        self.assertEqual(rollback.RECOVERY_STAGES[2], ("course-publisher",))
        self.assertEqual(rollback.RECOVERY_STAGES[3], ("course-snapshot", "community-worker"))
        self.assertEqual(rollback.RECOVERY_STAGES[-1], ("gateway",))

    def execution_fixture(self):
        self.running = set(rollback.runtime.SERVICES)
        self.identities, self.starts, self.recoveries, self.database_calls = {}, [], [], []
        self.output = self.runtime.root / "rollback-action"
        self.programs_dir = self.runtime.root / "programs"; self.programs_dir.mkdir(mode=0o700)
        self.inventory_dir = self.runtime.root / "inventory"; self.inventory_dir.mkdir(mode=0o700)
        self.programs = {name: {"file": "staging-" + name + "-operator.mjs", "sha256": "a" * 64} for name in ("fixture", "work")}
        self.bad_database, self.bad_recovery = False, False

        def locked():
            with (self.runtime.root / "release.lock").open() as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        owner = self
        self.locked = locked
        class Operator:
            def __init__(self, selected, jobs, config, containers, programs_dir, programs, output, api_only=False):
                self.containers, self.output, self.api_only, self.programs = containers, output, api_only, programs
            def prepare_retained(self, action):
                locked(); owner.running.discard("course-publisher"); owner.running.discard("community-worker")
                return {"status": "STAGING_DURABLE_WORK_RETAINED", "environment": "staging", "actionId": action,
                    "events": [{"eventId": hashlib.sha256((action + str(index)).encode()).hexdigest(), "canonicalDigest": str(index + 1) * 64,
                                "notBefore": "2026-11-03T00:00:00Z", "attemptsInCycle": index} for index in (0, 1)]}
            def fingerprint(self, private_key):
                locked()
                return {service: {"status": "STAGING_BUSINESS_FINGERPRINT_READ_ONLY", "service": service,
                    "algorithm": "HMAC-SHA256/private-action-key", "tables": {"owned": {"count": 1, "rows": [{"key": "a" * 64, "value": "b" * 64}]}}}
                    for service in ("course", "community")}
            def verify_recovery(self, retained):
                locked(); owner.recoveries.append(True)
                owner.assertTrue(self.api_only)
                owner.assertEqual(owner.running, {"course-api", "community-api", "course-tls", "community-tls", "course-publisher"})
                outbox = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "course", "mode": "outbox", "readOnly": True, "authenticatedTls": True,
                    "rows": [{"eventId": event["eventId"], "canonicalDigest": event["canonicalDigest"], "state": "delivered", "leaseOwner": None,
                              "leaseExpiresAt": None, "deliveredAt": "2026-11-03T00:01:00Z", "attemptsInCycle": event["attemptsInCycle"]} for event in retained["events"]]}
                inbox = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "community", "mode": "inbox", "readOnly": True, "authenticatedTls": True,
                    "rows": [{"eventId": event["eventId"], "canonicalDigest": event["canonicalDigest"], "status": "applied"} for event in retained["events"]]}
                if owner.bad_recovery:
                    outbox["rows"][0]["canonicalDigest"] = "0" * 64
                migrate.write_json(self.output, "durable-recovery.json", {"retained": retained, "outbox": outbox, "inbox": inbox,
                    "apiContainers": self.containers, "operatorProgramsSha256": {key: value["sha256"] for key, value in self.programs.items()}})
            def stop(self, services):
                locked(); owner.running.difference_update(services)
                return [{**c, "running": False, "exitCode": 0, "oomKilled": False} for c in self.containers]
        self.operator_class = Operator

    def execute(self):
        return rollback.execute(*self.args, self.output, self.inventory_dir, "a" * 64,
            {name: "a" * 64 for name in rollback.staging_state.CONFIGURATION_FILES}, self.programs_dir, self.programs,
            hashlib.sha256(rollback.Path(rollback.__file__).with_name("database_current.mjs").read_bytes()).hexdigest(),
            apply=True, confirmation="staging/test-release/rollback-test-release", credentials={name: "owned-private-url" for name in self.jobs},
            client=object(), private_fingerprint_key="f" * 64, lock_path=self.runtime.root / "release.lock")

    def command(self, args, env, timeout=30):
        self.locked()
        if args[:3] == ["docker", "ps", "--quiet"]:
            return "\n".join(self.identities.get(service, service) for service in self.running)
        if "up" in args:
            stage = args[args.index("90") + 1:]; self.starts.append(stage)
            self.running.update(stage)
            for service in stage:
                self.identities[service] = hashlib.sha256((env["RELEASE_DIR"] + service).encode()).hexdigest()
            return ""
        if "ps" in args:
            return self.identities[args[-1]]
        if "exec" in args:
            return json.dumps({"status": "API_RUNTIME_BOUNDARIES_PASS", "checks": sorted(rollback.runtime.PROBE_CHECKS)})
        self.fail("Unexpected command: " + repr(args))

    def patches(self):
        def retirement(*args, **kwargs):
            self.locked(); self.assertIsNotNone(kwargs.get("lock_handle"))
            kwargs["before_stop"](self.selected, self.plan, self.runtime.configuration, self.output / "initial-retirement")
            self.running.clear()
            return {"status": "STAGING_RUNTIME_QUIESCED_FOR_RECREATION"}
        def current(selected, jobs, output, *_args):
            self.locked(); self.assertEqual(self.running, set()); self.database_calls.append(True)
            output.mkdir(mode=0o700)
            result = {"status": "REFUSED" if self.bad_database else "CURRENT_DATABASES_READ_ONLY_VERIFIED", "databases": {name: {} for name in jobs}}
            migrate.write_json(output, "current-databases-outcome.json", result); return result
        def checked(execution, snapshot):
            self.locked(); self.assertEqual(self.running, set(rollback.runtime.SERVICES))
            return [{"service": service, "containerId": self.identities[service], "image": execution["artifacts"][rollback.runtime.IMAGE_KEYS[service]]["image"]}
                    for service in rollback.runtime.SERVICES]
        stack = ExitStack()
        stack.enter_context(patch.object(rollback.runtime, "assert_host"))
        stack.enter_context(patch.object(rollback.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(rollback.runtime, "preflight"))
        stack.enter_context(patch.object(rollback.runtime, "check_containers", side_effect=checked))
        stack.enter_context(patch.object(rollback.staging_retire, "execute", side_effect=retirement))
        stack.enter_context(patch.object(rollback.staging_restore, "check_provider", side_effect=lambda *_: self.locked()))
        stack.enter_context(patch.object(rollback.current_databases, "check_all", side_effect=current))
        stack.enter_context(patch.object(rollback.runtime_actions, "RuntimeOperator", self.operator_class))
        stack.enter_context(patch.object(rollback.migrate, "suspend_runtime", side_effect=lambda *_: self.running.clear()))
        return stack

    def test_complete_control_flow_keeps_lock_and_preserves_original_evidence_then_rebinds_actual_current_runtime(self):
        self.execution_fixture()
        original = (self.fixture.receipts / "runtime-outcome.json").read_bytes()
        with self.patches():
            result = self.execute()
        self.assertEqual(result["status"], "STAGING_COMPATIBLE_ROLLBACK_AND_CURRENT_RESTORE_VERIFIED")
        self.assertEqual(len(self.recoveries), 2); self.assertEqual(len(self.database_calls), 2)
        self.assertEqual(self.starts, [list(stage) for stage in rollback.RECOVERY_STAGES] * 2)
        self.assertEqual((self.fixture.receipts / "runtime-outcome.json").read_bytes(), original)
        self.assertFalse(result["trafficAuthorized"]); self.assertFalse(result["vmRecreationIncluded"])
        self.assertEqual(migrate.read_json(self.output / "compatible-previous", "compatible-runtime-outcome.json")["status"], "COMPATIBLE_PREVIOUS_RUNTIME_QUALIFIED")
        # The current record comes from actual current round identities, rather
        # than editing/relabeling the retained original receipt.
        _, _, restored, _ = rollback.staging_state.retained_state(self.runtime.bundle, self.output / "restored-current/configuration",
            self.fixture.database, self.output / "restored-current", self.runtime.compose, self.fixture.candidate_hash)
        self.assertNotEqual(restored["originalContainers"], self.plan["originalContainers"])
        self.assertNotIn("owned-private-url", (self.output / "rollback-outcome.json").read_text())

    def test_failed_read_only_stage_prevents_every_start_and_retains_failure(self):
        self.execution_fixture(); self.bad_database = True
        with self.patches(), self.assertRaisesRegex(ValueError, "THREE_CURRENT_DATABASES"):
            self.execute()
        self.assertEqual(self.starts, [])
        self.assertEqual(self.running, set())
        self.assertTrue(migrate.read_json(self.output, "rollback-outcome.json")["runtimeStopped"])

    def test_container_owned_input_refuses_before_fixture_writes_or_any_runtime_stop(self):
        self.execution_fixture()
        target = self.runtime.configuration / "gateway.json"
        actual_stat = rollback.Path.stat
        def container_owned(path, *args, **kwargs):
            value = actual_stat(path, *args, **kwargs)
            if path == target:
                fields = list(value); fields[4] = os.getuid() + 1
                return os.stat_result(fields)
            return value
        with self.patches(), patch.object(rollback.Path, "stat", new=container_owned), \
                patch.object(self.operator_class, "prepare_retained", side_effect=AssertionError("fixture invoked")), \
                patch.object(rollback.staging_retire, "execute", side_effect=AssertionError("runtime stop invoked")), \
                self.assertRaisesRegex(ValueError, "CONFIGURATION_OWNER_REQUIRED"):
            self.execute()
        self.assertEqual(self.running, set(rollback.runtime.SERVICES))
        self.assertEqual(self.starts, [])
        self.assertEqual(self.database_calls, [])
        self.assertFalse(self.output.exists())

    def test_changed_actual_recovery_digest_stops_before_reconciliation_and_cannot_publish_current_success(self):
        self.execution_fixture(); self.bad_recovery = True
        with self.patches(), self.assertRaisesRegex(ValueError, "ACTUAL_PENDING_EVENT_PUBLICATION"):
            self.execute()
        self.assertEqual(self.starts, [list(stage) for stage in rollback.RECOVERY_STAGES[:3]])
        self.assertEqual(self.running, set())
        self.assertFalse((self.output / "restored-current/runtime-outcome.json").exists())


if __name__ == "__main__":
    unittest.main()
