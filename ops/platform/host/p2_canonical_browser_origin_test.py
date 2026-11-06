"""Owned HTTPS/provider fixtures only; no real alias/provider invocation."""
import copy
import json
import unittest
from unittest.mock import patch

import frontend_probe
import p2_canonical_browser_origin as origin
import p2_lifecycle_native_test as native_fixture


class CanonicalBrowserOriginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        native_fixture.LifecycleNativeControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        native_fixture.LifecycleNativeControlTests.tearDownClass()

    def setUp(self):
        self.base = native_fixture.LifecycleNativeControlTests(methodName="runTest")
        self.base.setUp()
        self.addCleanup(self.base.tearDown)
        self.context, self.fixture = self.base.context, self.base.fixture
        self.probe = origin.CanonicalBrowserProbeClient()
        self.probe._opener = self.base.probe._opener

    def alias(self):
        return {"alias": origin.HOST, "projectId": origin.PROJECT, "deploymentId": "dpl_fixture",
            "deployment": {"id": "dpl_fixture", "url": "owned-fixture.vercel.app"}, "uid": "owned-alias"}

    def enqueue(self, first_alias=None, last_alias=None, response=None):
        self.base.enqueue_metadata()
        self.fixture.enqueue(first_alias or self.alias(), self.base.project())
        self.fixture.responses.append((200, response or self.base.response(), {"Content-Type": "application/json", "Cache-Control": "private, no-store"}))
        self.fixture.enqueue(last_alias or self.alias())
        self.base.enqueue_metadata()

    def test_owned_actual_https_brackets_exact_alias_and_immutable_ready_deployment(self):
        self.enqueue()
        result = origin.observe(self.context, self.fixture.client, self.probe)
        self.assertEqual(result["browserOrigin"], "https://staging.lashher.com")
        self.assertEqual(result["deploymentUrl"], "https://owned-fixture.vercel.app")
        paths = [call["path"] for call in self.fixture.calls]
        self.assertEqual(paths.count("/v4/aliases/staging.lashher.com?projectId="+origin.PROJECT+"&teamId="+__import__("vercel").TEAM), 2)
        self.assertFalse(any(call["method"] != "GET" for call in self.fixture.calls))
        self.assertEqual(paths[4], "/api/internal/release-probe")
        for value in ("fixture-private-token", "fixture-private-bypass", "f"*64):
            self.assertNotIn(value, json.dumps(result))

    def test_fixed_probe_refuses_arbitrary_origin_before_any_network(self):
        with patch.object(self.probe._opener, "open", side_effect=AssertionError("network forbidden")):
            with self.assertRaisesRegex(ValueError, "FIXED_ORIGIN"):
                self.probe.request("https://owned-fixture.vercel.app", "f"*64, "owned", "1"*64)

    def test_wrong_project_deployment_redirect_deleted_or_microfrontend_alias_refuses(self):
        for fields in ({"projectId": "prj_foreign"}, {"deploymentId": "dpl_foreign"}, {"alias": "foreign.invalid"},
                {"redirect": "foreign.invalid"}, {"deletedAt": 1}, {"microfrontends": {"applications": []}}):
            with self.subTest(fields=fields):
                selected = {**self.alias(), **fields}
                self.fixture.enqueue(selected)
                with self.assertRaises(ValueError):
                    origin._alias(self.fixture.client, self.base.plan)

    def test_alias_drift_after_workload_and_wrong_runtime_binding_refuse(self):
        last = self.alias(); last["deploymentId"] = "dpl_foreign"
        self.enqueue(last_alias=last)
        with self.assertRaises(ValueError):
            origin.observe(self.context, self.fixture.client, self.probe)
        # Discard only this owned fixture's unused final readbacks.
        self.fixture.responses.clear()
        response = copy.deepcopy(self.base.response()); response["writerAdmissionBinding"]["targetSha256"] = "9"*64
        self.enqueue(response=response)
        with self.assertRaisesRegex(ValueError, "WORKLOAD_BINDING"):
            origin.observe(self.context, self.fixture.client, self.probe)

    def test_expired_existing_probe_is_not_extended_or_reconfigured(self):
        self.base.enqueue_metadata(); self.fixture.enqueue(self.alias())
        path = self.base.private/frontend_probe.PRIVATE_FILE
        private = json.loads(path.read_bytes()); private["expiresAt"] = 1
        path.write_text(json.dumps(private))
        with self.assertRaises(ValueError):
            origin.observe(self.context, self.fixture.client, self.probe)
        self.assertTrue(all(call["method"] == "GET" for call in self.fixture.calls))
        self.assertEqual(json.loads(path.read_bytes())["expiresAt"], 1)


if __name__ == "__main__":
    unittest.main()
