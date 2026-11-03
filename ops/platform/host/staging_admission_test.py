import copy
import fcntl
import json
import os
import unittest
from unittest.mock import patch

import migrate
import release_test
import staging_admission as admission
import staging_state
import vercel


class Clock:
    def __init__(self):
        self.now = 0

    def monotonic(self):
        return self.now

    def time(self):
        return 1793740000 + self.now

    def sleep(self, value):
        self.now += value


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.r = release_test.RuntimeReleaseTests(methodName="runTest"); self.r.setUp()
        for name in ("root", "bundle", "configuration", "compose"):
            setattr(self.r, name, getattr(self.r, name).resolve())
        self.r.fixture.add_frontend()
        self.r.fixture.jobs["frontend"]["target"]["approvedPendingTags"] = []
        self.r.fixture.release["workload"] = {"environment": "production", "projectId": vercel.PROJECTS["staging"]}
        self.r.fixture.save()
        self.candidate_hash = migrate.file_hash((self.r.bundle / "release.candidate.json").read_bytes())
        self.r.gateway.update(projectId=vercel.PROJECTS["staging"], admission={"file": "/admission/state.json",
            "candidateSha256": self.candidate_hash, "releaseId": "test-release"})
        self.r.save("gateway.json", self.r.gateway)
        (self.r.configuration / "admission").mkdir(mode=0o755)
        self.evidence = self.r.root / "evidence"; self.evidence.mkdir(mode=0o700)
        self.receipt = {"path": "original-fixture.json", "sha256": migrate.file_hash(b'{"fixture":true}')}
        (self.evidence / self.receipt["path"]).write_bytes(b'{"fixture":true}')
        binding = {"environment": "staging", "releaseId": "test-release", "candidateSha256": self.candidate_hash,
                   "hostMachineId": self.r.target["hostMachineId"], "frontendProjectId": vercel.PROJECTS["staging"],
                   "frontendSourceCommit": "a" * 40, "frontendDeploymentId": "dpl_fixture",
                   "configurationSha256": staging_state.configuration_hashes(self.r.configuration),
                   "images": {key: self.r.fixture.release["artifacts"][key]["image"] for key in ("gateway", "courseRuntime", "communityRuntime")}}
        self.value = {"version": 1, "actionId": "p1-admit-fixture", "binding": binding,
                      "producers": {"runningWorkers": list(admission.WORKERS), "nativeSchedulesEnabled": False,
                                    "maintenanceTimers": list(admission.staging_retire.TIMERS)},
                      "features": dict.fromkeys(admission.FEATURES, False), "maintenanceInvocationId": "c" * 32,
                      "admission": {"newWork": False, "recovery": True}, "criteria": {}}
        for criterion, checks in admission.CHECKS.items():
            self.value["criteria"][criterion] = {}
            for name, evidence_class in checks.items():
                applicability = copy.deepcopy(binding)
                if evidence_class == "exact-image":
                    applicability = {key: binding[key] for key in ("candidateSha256", "images")}
                self.value["criteria"][criterion][name] = {"outcome": "passed", "evidenceClass": evidence_class,
                    "applicability": applicability, "receipts": [copy.deepcopy(self.receipt)]}
        self.save()
        self.output, self.lock = self.r.root / "admission-result", self.r.root / "admission.lock"
        self.clock = Clock()
        self.events, self.active = [], {"newWork": 0, "recovery": 0}
        self.fail_timer = False
        self.fail_ack = False
        self.fail_cleanup = False
        self.interrupt = False
        self.tamper = False
        self.admitted_once = False

    def tearDown(self):
        self.r.tearDown()

    def save(self):
        (self.evidence / "acceptance.json").write_text(json.dumps(self.value))

    def snapshot(self, plan):
        self.events.append("snapshot")

    def preflight(self, plan):
        self.events.append("preflight")
        with self.lock.open() as stream:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def maintenance_preflight(self, plan):
        self.events.append("maintenance-preflight")

    def timer(self, name, enabled):
        self.events.append((name, enabled))
        if enabled:
            self.assertEqual(self.state()["newWork"], False)
            self.assertEqual(self.state()["recovery"], False)
            if self.tamper:
                (self.evidence / self.receipt["path"]).write_bytes(b'changed')
            if self.interrupt:
                raise SystemExit(143)
            if self.fail_timer:
                raise ValueError("OWNED_TIMER_ACK_LOST")
        elif self.fail_cleanup:
            raise ValueError("OWNED_DISABLE_ACK_LOST")

    def state(self):
        raw = (self.r.configuration / "admission/state.json").read_bytes()
        state = json.loads(raw)
        if state["recovery"]:
            self.admitted_once = True
        if self.fail_ack and self.admitted_once:
            raise ValueError("OWNED_GATEWAY_ACK_LOST")
        return {**state, "valid": True, "sha256": migrate.file_hash(raw), "active": self.active,
                "uncertain": {"newWork": 0, "recovery": 0}}

    def execute(self, apply=True, confirmation="staging/test-release/p1-admit-fixture"):
        return admission.execute(self.r.bundle, self.r.configuration, self.r.compose, self.evidence, self.output,
            apply, confirmation, self, self.lock, self.clock)

    def outcome(self):
        return json.loads((self.output / "admission-outcome.json").read_text())

    def test_offline_plan_reads_no_private_files_and_contacts_nothing(self):
        for name in (*admission.runtime.ENV_FILES,):
            (self.r.configuration / (name + ".env")).unlink()
        for name in admission.runtime.TLS_FILES:
            (self.r.configuration / name).unlink()
        with patch.object(admission.vercel, "Client", side_effect=AssertionError("provider")), \
                patch.object(admission.runtime, "command", side_effect=AssertionError("process")):
            result = self.execute(False)
        self.assertFalse(result["releaseAccepted"])
        self.assertFalse(self.output.exists()); self.assertEqual(self.events, [])
        self.assertFalse((self.r.configuration / "admission/state.json").exists())

    def test_acceptance_retains_lock_and_original_evidence_and_only_admits_recovery(self):
        before = (self.evidence / self.receipt["path"]).read_bytes()
        result = self.execute()
        self.assertTrue(result["releaseAccepted"]); self.assertTrue(result["recoveryAuthorized"])
        self.assertFalse(result["newWorkAuthorized"])
        self.assertEqual(len(result["criteria"]), sum(map(len, admission.CHECKS.values())))
        self.assertEqual(self.state()["newWork"], False); self.assertTrue(self.state()["recovery"])
        self.assertEqual(before, (self.evidence / self.receipt["path"]).read_bytes())
        self.assertEqual(self.outcome(), result)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        with self.assertRaisesRegex(ValueError, "FRESH_OUTPUT"):
            self.execute()

    def test_incomplete_or_wrong_source_host_frontend_or_evidence_refuses_before_mutation(self):
        baseline = copy.deepcopy(self.value)
        changes = [lambda v: v["criteria"].pop("P1-C04"),
                   lambda v: v["binding"].update(hostMachineId="2" * 32),
                   lambda v: v["binding"].update(frontendSourceCommit="b" * 40),
                   lambda v: v["binding"].update(candidateSha256="b" * 64),
                   lambda v: v["admission"].update(newWork=True),
                   lambda v: v["features"].update(checkout=True),
                   lambda v: v["producers"].update(nativeSchedulesEnabled=True)]
        for change in changes:
            self.value = copy.deepcopy(baseline); change(self.value); self.save()
            with self.assertRaises(ValueError):
                self.execute()
            self.assertEqual(self.events, []); self.assertFalse(self.output.exists())

    def test_live_requirement_cannot_be_replaced_with_owned_image_pass(self):
        record = next(iter(self.value["criteria"]["P1-C04"].values()))
        record["evidenceClass"] = "exact-image"; self.save()
        with self.assertRaisesRegex(ValueError, "APPLICABILITY"):
            self.execute()
        self.assertEqual(self.events, [])

    def test_changed_or_missing_original_receipt_and_symlink_refuse(self):
        receipt = self.evidence / self.receipt["path"]
        receipt.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            self.execute()
        receipt.unlink(); receipt.symlink_to(self.r.compose)
        with self.assertRaisesRegex(ValueError, "SYMLINK"):
            self.execute()
        self.assertEqual(self.events, [])

    def test_drain_timeout_keeps_transport_closed_and_never_restores_timers(self):
        self.active["newWork"] = 1
        with self.assertRaisesRegex(ValueError, "DRAIN_TIMEOUT"):
            self.execute()
        self.assertFalse(any(isinstance(e, tuple) for e in self.events))
        self.assertFalse(self.state()["recovery"])
        self.assertTrue(self.outcome()["stateRequiresInspection"])
        self.assertFalse(self.outcome()["releaseAccepted"])

    def test_uncertain_timer_and_interrupt_disable_even_possibly_enabled_unit(self):
        for mode in ("fail_timer", "interrupt"):
            setattr(self, mode, True)
            with self.assertRaises(ValueError):
                self.execute()
            self.assertFalse(self.outcome()["releaseAccepted"])
            self.assertIn((admission.staging_retire.TIMERS[0], False), self.events)
            self.assertFalse(self.state()["recovery"])
            setattr(self, mode, False)
            self.output = self.output.with_name("second-attempt")

    def test_lost_admission_ack_refences_transport_and_marks_uncertain_observation(self):
        self.fail_ack = True
        with self.assertRaisesRegex(ValueError, "ACK_LOST"):
            self.execute()
        self.assertFalse(json.loads((self.r.configuration / "admission/state.json").read_text())["recovery"])
        self.assertFalse(self.outcome()["releaseAccepted"])
        self.assertTrue(self.outcome()["stateRequiresInspection"])
        self.assertEqual(len([e for e in self.events if isinstance(e, tuple) and not e[1]]), 2)

    def test_evidence_changed_during_restoration_refuses_final_admission(self):
        self.tamper = True
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            self.execute()
        self.assertFalse(self.admitted_once); self.assertFalse(self.outcome()["releaseAccepted"])

    def test_wrong_confirmation_refuses_before_host_and_credential_access(self):
        with self.assertRaisesRegex(ValueError, "EXPLICIT_ACTION"):
            self.execute(confirmation="production/test-release/p1-admit-fixture")
        self.assertEqual(self.events, [])

    def test_abrupt_process_death_retains_intent_and_fence_without_success(self):
        child = os.fork()
        if child == 0:
            self.timer = lambda *_: os._exit(23)
            self.execute()
            os._exit(0)
        _, status = os.waitpid(child, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 23)
        self.assertTrue((self.output / "admission-started.json").exists())
        self.assertFalse((self.output / "admission-outcome.json").exists())
        self.assertFalse(self.state()["newWork"]); self.assertFalse(self.state()["recovery"])
        with self.assertRaisesRegex(ValueError, "FRESH_OUTPUT"):
            self.execute()

    def test_zero_active_requests_does_not_erase_upstream_uncertainty(self):
        original = self.state
        self.state = lambda: {**original(), "uncertain": {"newWork": 1, "recovery": 0}}
        with self.assertRaisesRegex(ValueError, "RECONCILIATION"):
            self.execute()
        self.assertFalse(self.outcome()["releaseAccepted"])

    def test_host_driver_checks_real_bindings_and_never_uses_provider_writes(self):
        selected, plan = admission.make_plan(self.r.bundle, self.r.configuration, self.r.compose, self.evidence)
        driver = admission.Host(selected, self.r.configuration, object())
        containers = [{"service": name, "containerId": str(i + 1) * 64} for i, name in enumerate(admission.runtime.SERVICES)]
        with patch.object(admission.runtime, "assert_host") as machine, \
                patch.object(admission.runtime, "check_containers", return_value=containers), \
                patch.object(admission.staging_retire, "provider_state") as provider:
            driver.snapshot(plan); driver.preflight(plan)
            machine.assert_called_with(plan["binding"])
            provider.assert_called_once()
            changed = self.r.configuration / "course-api.env"
            changed.write_bytes(changed.read_bytes() + b"# drift\n")
            with self.assertRaisesRegex(ValueError, "CONFIGURATION_CHANGED"):
                driver.preflight(plan)

    def test_host_driver_requires_current_gateway_ack_and_exact_timer_result(self):
        selected, _plan = admission.make_plan(self.r.bundle, self.r.configuration, self.r.compose, self.evidence)
        driver = admission.Host(selected, self.r.configuration, object())
        state = {"valid": True, "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0}}
        with patch.object(admission.runtime, "command", return_value=json.dumps(state)) as command:
            self.assertEqual(driver.state(), state)
            self.assertIn("http://127.0.0.1:9100/admission", command.call_args.args[0][-1])
        with patch.object(admission.runtime, "command", return_value='{"valid":false}'):
            with self.assertRaisesRegex(ValueError, "GATEWAY_ACK"):
                driver.state()
        with patch.object(admission.runtime, "command"), patch.object(admission.staging_retire, "unit_state",
                return_value={"ActiveState": "inactive", "UnitFileState": "enabled"}):
            with self.assertRaisesRegex(ValueError, "TIMER_CHANGE_UNVERIFIED"):
                driver.timer(admission.staging_retire.TIMERS[0], True)


if __name__ == "__main__":
    unittest.main()
