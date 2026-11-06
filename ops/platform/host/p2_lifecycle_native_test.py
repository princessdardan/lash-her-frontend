import copy
import json
from pathlib import Path
import ssl
import time
import unittest
from unittest.mock import patch
import urllib.request

import frontend_probe
import migrate
import p2_lifecycle_native as native
import vercel
import vercel_test


class LifecycleNativeControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.fixture = vercel_test.VercelControlTests(methodName="runTest")
        self.fixture.setUp()
        self.release = copy.deepcopy(self.fixture.release)
        self.release.update(contractPhase="p2", phase2ContractManifestSha256="sha256:" + "d" * 64)
        flags = {key: key != "INTEGRATION_CHECKOUT_ENABLED" for key in frontend_probe.FEATURE_CONTROL_NAMES}
        self.plan = {"version": 1, "environment": "staging", "actionId": self.release["releaseId"], "projectId": vercel.PROJECTS["staging"],
                     "sourceCommit": "a" * 40, "phase2ContractManifestSha256": self.release["phase2ContractManifestSha256"], "deploymentId": "dpl_fixture",
                     "deploymentUrl": "https://owned-fixture.vercel.app", "schedule": {"path": native.PATH, "schedule": native.SCHEDULE},
                     "configurationRecordSha256": "e" * 64, "featureControls": flags, "finalDisposition": "disabled-and-admission-closed", "planSha256": "c" * 64,
                     "writerAdmissionBinding": {"mode": "enforce", "targetSha256": "a" * 64, "producerSha256": "b" * 64, "sourceCommit": "a" * 40, "roleName": "frontend_runtime"}}
        self.private = self.fixture.attempt / "private"
        self.private.mkdir(mode=0o700)
        migrate.write_json(self.private, frontend_probe.PRIVATE_FILE, {"environment": "staging", "projectId": vercel.PROJECTS["staging"], "sourceCommit": "a" * 40,
            "releaseId": self.release["releaseId"], "expiresAt": int(time.time() * 1000) + 600_000, "secret": "f" * 64, "gatewayOrigin": "https://gateway.owned.invalid"})
        self.context = {"candidate": self.release, "plan": self.plan, "configurationRecordSha256": "e" * 64, "privateProbeDirectory": str(self.private)}
        ca = ssl.create_default_context(cafile=str(self.fixture.cert))
        with patch.object(frontend_probe.ssl, "create_default_context", return_value=ca):
            self.probe = frontend_probe.ProbeClient()
        original = self.probe._opener
        fixture = self.fixture

        class OwnedProbeTransport:
            def open(self, request, timeout):
                # Only this fixture rewrites the guarded deployment URL to its
                # own TLS peer. Source URL/header validation still executes.
                return original.open(urllib.request.Request(fixture.origin + "/api/internal/release-probe", headers=dict(request.header_items()), method=request.method), timeout=timeout)

        self.probe._opener = OwnedProbeTransport()
        self.challenge = patch.object(native.secrets, "token_hex", return_value="1" * 64)
        self.challenge.start()

    def tearDown(self):
        self.challenge.stop()
        self.fixture.tearDown()

    def project(self, enabled=False):
        value = self.fixture.project(enabled, "dpl_fixture")
        value["crons"].update(deploymentId="dpl_fixture", definitions=[{"path": native.PATH, "schedule": native.SCHEDULE, "host": "owned-fixture.vercel.app"}])
        value["protectionBypass"] = {"fixture-private-bypass": {"scope": "automation-bypass"}}
        return value

    def response(self):
        return {"version": 1, "status": "FRONTEND_WORKLOAD_PROBE_PASS", "challenge": "1" * 64, "environment": "staging", "projectId": vercel.PROJECTS["staging"],
                "sourceCommit": "a" * 40, "gatewayOrigin": "https://gateway.owned.invalid", "contractPhase": "p2", "checks": ["gateway-course-catalog-p2"],
                "featureControls": self.plan["featureControls"], "writerAdmissionBinding": self.plan["writerAdmissionBinding"]}

    def enqueue_metadata(self, enabled=False):
        self.fixture.enqueue(self.fixture.deployment(), self.project(enabled))

    def enqueue_observe(self, enabled=False, response=None):
        self.enqueue_metadata(enabled)
        self.fixture.enqueue(self.project(enabled))
        self.fixture.responses.append((200, response or self.response(), {"Content-Type": "application/json", "Cache-Control": "private, no-store"}))

    def test_actual_https_p2_profile_observes_ten_controls_and_immutable_writer_binding(self):
        self.enqueue_observe()
        result = native.observe(self.context, self.fixture.client, self.probe)
        self.assertFalse(result["nativeEnabled"])
        self.assertEqual(result["featureControls"], self.plan["featureControls"])
        self.assertEqual(result["writerAdmissionBinding"], self.plan["writerAdmissionBinding"])
        serialized = json.dumps(result)
        for secret in ("fixture-private-token", "fixture-private-bypass", "f" * 64, "provider-secret-must-not-escape"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(self.fixture.calls[-1]["path"], "/api/internal/release-probe")

    def test_production_and_wrong_schedule_are_refused(self):
        self.context["candidate"]["environment"] = "production"
        with self.assertRaises(ValueError):
            native.observe(self.context, self.fixture.client, self.probe)
        self.assertEqual(self.fixture.calls, [])
        self.context["candidate"]["environment"] = "staging"
        project = self.project()
        project["crons"]["definitions"].append({"path": "/api/cron/business", "schedule": "* * * * *", "host": "owned-fixture.vercel.app"})
        self.fixture.enqueue(self.fixture.deployment(), project)
        with self.assertRaisesRegex(ValueError, "EXACT_DEFINITION"):
            native.observe_metadata(self.context, self.fixture.client)

    def test_off_profile_or_missing_admission_binding_is_not_p2_configuration_proof(self):
        response = self.response()
        response["featureControls"] = {key: False for key in frontend_probe.FEATURE_CONTROL_NAMES}
        self.enqueue_observe(response=response)
        with self.assertRaisesRegex(ValueError, "RUNTIME_PROFILE"):
            native.observe(self.context, self.fixture.client, self.probe)
        response = self.response()
        response["writerAdmissionBinding"] = None
        self.enqueue_observe(response=response)
        with self.assertRaisesRegex(ValueError, "ADMISSION_BINDING"):
            native.observe(self.context, self.fixture.client, self.probe)

    def test_actual_https_enable_toggle_retains_intent_and_exact_readback_once(self):
        self.enqueue_observe(False)
        self.fixture.enqueue({})
        self.enqueue_observe(True)
        result = native.set_enabled(self.context, self.fixture.client, True, self.fixture.attempt, lambda: None, self.probe)
        self.assertEqual(result["mutationOutcome"], "observed")
        toggles = [call for call in self.fixture.calls if call["method"] == "PATCH"]
        self.assertEqual([call["body"] for call in toggles], [{"enabled": True}])
        self.assertEqual(toggles[0]["path"], f'/v1/projects/{vercel.PROJECTS["staging"]}/crons?teamId={vercel.TEAM}')
        self.assertTrue((self.fixture.attempt / "p2-native-enable-intent.json").exists())

    def test_disable_is_metadata_only_and_does_not_depend_on_probe_or_cron_secret(self):
        self.enqueue_metadata(True)
        self.fixture.enqueue({})
        self.enqueue_metadata(False)
        (self.private / frontend_probe.PRIVATE_FILE).unlink()
        with patch.object(self.probe, "request", side_effect=AssertionError("probe must not run")):
            result = native.set_enabled(self.context, self.fixture.client, False, self.fixture.attempt, lambda: None, self.probe)
        self.assertFalse(result["observation"]["nativeEnabled"])
        self.assertIsNone(result["observation"]["providerQueuedInvocations"])
        self.assertFalse(result["observation"]["cancellationVerified"])

    def test_lost_enable_ack_keeps_unknown_and_does_not_retry(self):
        self.enqueue_observe(False)
        self.fixture.responses.append((500, {"error": "fixture-private-provider-body"}, {}))
        with self.assertRaises(ValueError):
            native.set_enabled(self.context, self.fixture.client, True, self.fixture.attempt, lambda: None, self.probe)
        outcome = migrate.read_json(self.fixture.attempt, "p2-native-enable-outcome.json")
        self.assertEqual(outcome["mutationOutcome"], "unknown")
        self.assertEqual(len([call for call in self.fixture.calls if call["method"] == "PATCH"]), 1)
        self.assertNotIn("fixture-private-provider-body", json.dumps(outcome))

    def test_disable_record_loss_still_removes_temporary_native_capability(self):
        self.enqueue_metadata(True)
        self.fixture.enqueue({})
        self.enqueue_metadata(False)
        with patch.object(native.migrate, "write_json", side_effect=OSError("owned-storage-loss")):
            with self.assertRaises(OSError):
                native.set_enabled(self.context, self.fixture.client, False, self.fixture.attempt, lambda: None, self.probe)
        self.assertEqual([call["body"] for call in self.fixture.calls if call["method"] == "PATCH"], [{"enabled": False}])


if __name__ == "__main__":
    unittest.main()
