import fcntl
import base64
import hashlib
import io
import json
import signal
import time
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import migrate
import recreation_host as host
import staging_rollback
import staging_state_test


class HostRecreationPhases(unittest.TestCase):
    def setUp(self):
        self.fixture = staging_state_test.StagingStateTests(); self.fixture.setUp()
        self.runtime = self.fixture.runtime
        self.selected, self.jobs, self.plan, _ = self.fixture.bind()
        self.paths = {"bundle": self.runtime.bundle, "configuration": self.runtime.configuration,
            "database_receipts": self.fixture.database, "runtime_receipts": self.fixture.receipts,
            "compose_file": self.runtime.compose, "output": self.runtime.root / "action-output"}
        for name in ("programs_directory", "compatibility_directory", "inventory_directory", "retirement_directory"):
            self.paths[name] = self.runtime.root / name; self.paths[name].mkdir(mode=0o700)
        self.paths = {name: path.resolve() for name, path in self.paths.items()}
        self.value = {"version": 1, "environment": "staging", "operation": "rollback", "action": "p1-recreate-owned",
            "releaseId": "test-release", "paths": {k: str(v) for k, v in self.paths.items()},
            "privateFingerprintKey": "f" * 64, "databaseCredentials": {name: "private-" + name for name in self.jobs},
            **{name: "a" * 64 for name in ("checker_sha256", "inventory_sha256", "previous_sha256", "proof_sha256")},
            "candidate_sha256": self.fixture.candidate_hash, "expected_deployment": "dpl_fixture",
            "configuration_sha256": host.staging_state.configuration_hashes(self.runtime.configuration),
            "programs": {name: {"sha256": name + "-hash"} for name in ("fixture", "work")},
            "vercelToken": "owned-private-token", "new_machine": "2" * 32, "retirement_sha256": "a" * 64}
        self.value["confirmation"] = "staging/test-release/rollback-p1-recreate-owned"
        self.root_patch = patch.object(host, "ROOT", self.runtime.root.resolve()); self.root_patch.start()

    def tearDown(self):
        self.root_patch.stop(); self.fixture.tearDown()

    def operation(self, name):
        self.value["operation"] = name
        self.value["confirmation"] = "staging/test-release/" + {"retire": "retire-", "restore": "restore-", "rollback": "rollback-"}[name] + self.value["action"]

    def execute(self):
        with patch.object(host.os, "geteuid", return_value=0), patch.object(host.sys, "platform", "linux"), \
                patch.object(host.vercel, "Client", return_value=object()):
            return host.execute(self.value, lock_path=self.runtime.root / "release.lock")

    def test_paths_and_explicit_phase_confirmation_refuse_before_root_or_provider_access(self):
        with patch.object(host.vercel, "Client", side_effect=AssertionError("provider touched")):
            self.value["confirmation"] = "production/test-release/rollback-p1-recreate-owned"
            with self.assertRaisesRegex(ValueError, "PHASE_CONFIRMATION"):
                self.execute()
            self.operation("rollback"); self.value["paths"]["output"] = "/etc/unsafe"
            with self.assertRaisesRegex(ValueError, "PRIVATE_ROOT"):
                self.execute()

    def test_symlink_ancestor_and_unknown_phase_refuse(self):
        alias = self.runtime.root / "alias"; alias.symlink_to(self.runtime.configuration, target_is_directory=True)
        self.value["paths"]["configuration"] = str(alias.parent.resolve() / alias.name)
        with self.assertRaisesRegex(ValueError, "PRIVATE_ROOT"):
            self.execute()
        self.value["paths"]["configuration"] = str(self.runtime.configuration.resolve())
        self.value["operation"] = "migrate"
        with self.assertRaisesRegex(ValueError, "FIXED_STAGING_PHASE"):
            self.execute()

    def test_rollback_routes_only_to_exact_compatible_controller_with_private_inputs(self):
        with patch.object(host.staging_rollback, "execute", return_value={"status": "owned"}) as rollback, \
                patch.object(host.staging_retire, "execute", side_effect=AssertionError("retired twice")), \
                patch.object(host.staging_restore, "execute", side_effect=AssertionError("new host invoked")):
            self.assertEqual(self.execute()["status"], "owned")
        values = rollback.call_args.kwargs
        self.assertEqual(values["action"], "rollback-p1-recreate-owned")
        self.assertEqual(values["private_fingerprint_key"], self.value["privateFingerprintKey"])
        self.assertEqual(values["credentials"], self.value["databaseCredentials"])
        self.assertTrue(values["apply"])

    def external_inventory(self, observed=None):
        action_root = self.runtime.root.resolve() / self.value["action"]
        action_root.mkdir(mode=0o700, exist_ok=True)
        directory = action_root / "inventory-rollback"
        self.value["paths"]["inventory_directory"] = str(directory)
        value = {"status": "MUX_DEV_DASHBOARD_INVENTORY_VERIFIED", "observedAt": observed or int(time.time() * 1000),
            "environmentId": "7j65e8", "organizationId": "4g1uhq", "environmentName": "Lash Her Academy [DEV]",
            "sourceUrl": host.staging_retire.MUX_PAGE, "inventoryComplete": True, "settingsChanged": False,
            "webhooks": [{"address": "http://localhost:4000/v1/webhooks/mux", "enabled": True}], "stagingGatewayWebhookCount": 0,
            "maskedAccessibilitySha256": "a" * 64, "maskedScreenshotSha256": "b" * 64}
        raw = (json.dumps(value, indent=2) + "\n").encode()
        self.value["externalInventory"] = base64.b64encode(raw).decode()
        self.value["inventory_sha256"] = hashlib.sha256(raw).hexdigest()
        return directory, raw

    def test_fresh_inventory_handoff_preserves_reviewed_raw_bytes_and_scope_before_rollback(self):
        directory, raw = self.external_inventory()
        with patch.object(host.staging_rollback, "execute", return_value={"status": "owned"}) as rollback:
            self.execute()
        self.assertEqual((directory / "mux-inventory.json").read_bytes(), raw)
        self.assertEqual((directory / "mux-inventory.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(rollback.call_args.kwargs["inventory_directory"], directory)

    def test_wrong_inventory_hash_or_path_refuses_before_backend_and_does_not_write(self):
        directory, _raw = self.external_inventory()
        correct = self.value["inventory_sha256"]
        with patch.object(host.staging_rollback, "execute", side_effect=AssertionError("backend touched")):
            self.value["inventory_sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "FRESH_INVENTORY_HANDOFF"):
                self.execute()
            self.value["inventory_sha256"] = correct
            self.value["paths"]["inventory_directory"] = str(directory.parent / "other-directory")
            with self.assertRaisesRegex(ValueError, "FRESH_INVENTORY_HANDOFF"):
                self.execute()
        self.assertFalse(directory.exists())

    def test_stale_handed_off_inventory_cannot_reach_runtime_mutation(self):
        self.external_inventory(int(time.time() * 1000) - 901_000)
        with patch.object(host.staging_rollback, "execute", side_effect=AssertionError("backend touched")), \
                self.assertRaisesRegex(ValueError, "FRESH_REVIEWED_DEV_INVENTORY"):
            self.execute()

    def test_final_retirement_creates_pending_fixture_and_private_baseline_before_stop(self):
        self.operation("retire")
        retained = {"environment": "staging", "events": ["owned-event"]}
        operator = SimpleNamespace(prepare_retained=lambda action: retained, fingerprint=lambda key: {"owned": "keyed-summary"})
        def retire(**kwargs):
            output = kwargs["output"]; output.mkdir(mode=0o700)
            kwargs["before_stop"](self.selected, self.plan, self.runtime.configuration, output)
            baseline = migrate.read_json(output / "pending-work", "business-baseline.json")
            self.assertEqual(baseline, {"owned": "keyed-summary"})
            self.assertEqual((output / "pending-work/business-baseline.json").stat().st_mode & 0o777, 0o600)
            return {"status": "STAGING_RUNTIME_QUIESCED_FOR_RECREATION"}
        with patch.object(host.staging_retire, "execute", side_effect=retire), \
                patch.object(host.runtime_actions, "RuntimeOperator", return_value=operator):
            self.assertEqual(self.execute()["status"], "STAGING_RUNTIME_QUIESCED_FOR_RECREATION")

    def test_restore_holds_one_lock_and_verifies_actual_publisher_before_frontend(self):
        self.operation("restore")
        work = self.paths["retirement_directory"] / "pending-work"; work.mkdir(mode=0o700)
        retained = {"status": "STAGING_DURABLE_WORK_RETAINED", "environment": "staging",
            "actionId": "recovery-fixture-host-p1-recreate-owned", "events": [
                {"eventId": str(i), "canonicalDigest": str(i) * 64, "notBefore": "2026-11-03T00:00:00Z", "attemptsInCycle": i} for i in (1, 2)]}
        baseline = {name: {"status": "STAGING_BUSINESS_FINGERPRINT_READ_ONLY", "service": name,
            "algorithm": "HMAC-SHA256/private-action-key", "tables": {}} for name in ("course", "community")}
        migrate.write_json(work, "retained-work.json", retained); migrate.write_json(work, "business-baseline.json", baseline)
        events = []
        apis = [{"service": name + "-api", "containerId": str(i) * 64, "image": "owned"} for i, name in enumerate(("course", "community"), 1)]
        owner = self
        def locked():
            with self.runtime.root.joinpath("release.lock").open("a+") as independent:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(independent.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        class Operator:
            def __init__(self, execution, jobs, config, actual, programs_dir, programs, output, api_only=False):
                self.output, self.actual = output, actual
                self.api_only = api_only
            def verify_recovery(self, actual_retained):
                locked(); owner.assertTrue(self.api_only); owner.assertEqual(actual_retained, retained); events.append("publisher")
                outbox = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "course", "mode": "outbox", "readOnly": True, "authenticatedTls": True,
                    "rows": [{**e, "state": "delivered", "leaseOwner": None, "leaseExpiresAt": None, "deliveredAt": "2026-11-03T00:01:00Z"} for e in retained["events"]]}
                inbox = {"status": "STAGING_WORK_ROWS_READ_ONLY", "service": "community", "mode": "inbox", "readOnly": True, "authenticatedTls": True,
                    "rows": [{"eventId": e["eventId"], "canonicalDigest": e["canonicalDigest"], "status": "applied"} for e in retained["events"]]}
                migrate.write_json(self.output, "durable-recovery.json", {"retained": retained, "apiContainers": apis, "outbox": outbox, "inbox": inbox})
            def fingerprint(self, key):
                locked(); owner.assertFalse(self.api_only); events.append("business"); return baseline
        def restore(**kwargs):
            locked(); output = kwargs["output"]; output.mkdir(mode=0o700)
            kwargs["after_publisher_ready"](self.selected, self.plan, self.runtime.configuration, output)
            ready = {"containers": self.plan["originalContainers"]}; migrate.write_json(output, "runtime-outcome.json", ready)
            kwargs["after_runtime_ready"](self.selected, self.plan, self.runtime.configuration, output, ready)
            locked(); return {"status": "API_RUNTIME_RESTORED_FOR_QUALIFICATION"}
        def native(*args, **kwargs):
            locked(); events.append("frontend"); self.assertEqual(kwargs["lock_path"], self.runtime.root / "release.lock")
        with patch.object(host.staging_restore, "execute", side_effect=restore), \
                patch.object(staging_rollback, "api_containers", return_value=apis), \
                patch.object(host.runtime_actions, "RuntimeOperator", Operator), \
                patch.object(host.staging_frontend_restore, "execute", side_effect=native):
            self.assertEqual(self.execute()["status"], "API_RUNTIME_RESTORED_FOR_QUALIFICATION")
        self.assertEqual(events, ["publisher", "business", "frontend"])

    def test_common_stdout_cannot_export_private_summary_or_token(self):
        payload = io.TextIOWrapper(io.BytesIO(json.dumps(self.value).encode()))
        output = io.StringIO()
        with patch.object(host.sys, "stdin", payload), patch.object(host.sys, "stdout", output), \
                patch.object(host, "execute", return_value={"status": "owned", "private": "must-remain-private"}):
            host.main()
        common = json.loads(output.getvalue())
        self.assertEqual(common["status"], "owned")
        self.assertFalse(common["privateReceiptValuesDisplayed"])
        self.assertNotIn("must-remain-private", output.getvalue())
        self.assertNotIn(self.value["vercelToken"], output.getvalue())
        self.assertNotIn(self.value["privateFingerprintKey"], output.getvalue())

    def test_remote_termination_raises_through_phase_finally_and_restores_signal_handlers(self):
        payload = io.TextIOWrapper(io.BytesIO(json.dumps(self.value).encode()))
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        cleanup = []
        def phase(_value):
            try:
                signal.getsignal(signal.SIGHUP)(signal.SIGHUP, None)
            finally:
                cleanup.append(True)
        with patch.object(host.sys, "stdin", payload), patch.object(host.sys, "stderr", io.StringIO()), \
                patch.object(host, "execute", side_effect=phase), self.assertRaises(SystemExit):
            host.main()
        self.assertEqual(cleanup, [True])
        self.assertEqual({sig: signal.getsignal(sig) for sig in before}, before)


if __name__ == "__main__":
    unittest.main()
