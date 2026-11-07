"""Owned HTTPS tests for shared coordinator retirement and continuation seams."""
from copy import deepcopy
import json
import threading
import unittest

import frontend_crm_shipping_retirement_test as fixtures
import frontend_release_adapters as adapter
import vercel


class ProviderControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.RetirementTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        fixtures.RetirementTests.tearDownClass()

    def setUp(self):
        self.fixture = fixtures.RetirementTests(methodName="runTest")
        self.fixture.setUp()
        self.parent = self.fixture.attempt / "action"
        self.parent.mkdir(mode=0o700)
        self.context = {"directory": str(self.parent), "operation": "suspend-chitchats",
            "plan": {"environment": "staging", "actionId": "owned-control", "sourceCommit": "f" * 40, "targetSha256": "a" * 64},
            "candidate": {"version": 2, "environment": "staging", "releaseId": "owned-control",
                "workload": {"projectId": vercel.PROJECTS["staging"], "environment": "production"},
                "sources": {"frontend": {"repository": "https://github.com/princessdardan/lash-her-frontend.git", "commit": "f" * 40, "requiredChecks": "passed"}}},
            "bindings": {"environment": "staging", "actionId": "owned-control", "sourceCommit": "f" * 40, "targetSha256": "a" * 64,
                "projectId": vercel.PROJECTS["staging"], "teamId": vercel.TEAM, "repositoryId": vercel.REPOSITORY_ID,
                "chitchatsRetirement": self.fixture.shipping},
            "chitchatsReplacementToken": "owned-replacement-token", "chitchatsRetiredToken": "owned-retired-token",
            "crmShippingActual": self.fixture.rows, "retirementObservationSeconds": 2,
            "admissionObservation": {"newWork": False, "recovery": False, "ledgerDrained": True}}
        self.checkpoints = 0

    def tearDown(self):
        self.fixture.tearDown()

    def verify(self):
        self.checkpoints += 1

    def execute(self, operation):
        self.context["operation"] = operation
        return adapter.execute(self.context, None, self.verify)

    def test_same_reviewed_action_observes_supported_console_denial_then_actual_complete_shipping_effects(self):
        before = self.execute("suspend-chitchats")
        self.assertTrue(before["retiredCredentialWasUsable"])
        timer = threading.Timer(0.05, lambda: setattr(self.fixture, "denied", True))
        timer.start()
        try:
            result = self.execute("retire-chitchats")
        finally:
            timer.join()
        self.assertEqual(result["status"], "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED")
        self.assertEqual((result["activeExecutions"], result["uncertainEffects"]), (0, 0))
        calls = len(self.fixture.calls)
        with self.assertRaises(FileExistsError):
            self.execute("retire-chitchats")
        self.assertEqual(len(self.fixture.calls), calls)
        current = self.execute("observe-chitchats")
        self.assertTrue(current["retiredCredentialDenied"])
        self.assertFalse(current["refreshProbed"])
        self.assertGreater(self.checkpoints, 20)
        raw = json.dumps(result)
        for marker in self.fixture.private_markers:
            self.assertNotIn(marker, raw)

    def test_current_replacement_shipments_do_not_reopen_the_already_retired_historical_capability(self):
        self.execute("suspend-chitchats")
        self.fixture.denied = True
        self.execute("retire-chitchats")
        extra = deepcopy(self.fixture.shipments[0]); extra["id"] = "new-current-shipment"
        self.fixture.shipments.append(extra)
        result = self.execute("observe-retired-capabilities")
        observed = result["providers"]["chitchats"]
        self.assertTrue(observed["historicalCapabilitiesDenied"])
        self.assertEqual(observed["currentProviderObjectCount"], 2)
        self.assertIsNone(observed["rawInvocationCount"])
        self.assertNotIn("activeExecutions", observed)

    def test_actual_expected_401_still_requires_the_parent_checkpoint_after_the_response(self):
        self.fixture.denied = True
        _replacement, retired = self.fixture.clients("chitchats", self.fixture.shipping)
        calls = []
        def checkpoint():
            calls.append(True)
            if len(calls) == 2:
                raise ValueError("OWNED_LOCK_LOST")
        with self.assertRaisesRegex(ValueError, "OWNED_LOCK_LOST"):
            adapter.LockedClient(retired, checkpoint).request("GET", "/api/v1/clients/ownedClient/shipments/count")
        self.assertEqual(len(calls), 2)

    def test_highlevel_supported_access_denial_precedes_exactly_one_refresh_probe_and_recovery_never_replays_it(self):
        self.context["bindings"].pop("chitchatsRetirement")
        reviewed = deepcopy(self.fixture.crm)
        reviewed.update(credentialKind="oauth-installation", appId="ownedApp", oauthClientId="ownedOAuthClient")
        reviewed.pop("retiredIntegrationId")
        self.context["bindings"]["highlevelRetirement"] = reviewed
        self.context.update(highlevelReplacementToken="owned-replacement-token", highlevelRetiredToken="owned-retired-token",
            highlevelRetiredRefreshCredentials={"client_id": "ownedOAuthClient", "client_secret": "private-client-secret", "refresh_token": "private-refresh-token"},
            crmShippingActual=self.fixture.crm_rows)
        self.execute("suspend-highlevel")
        self.fixture.denied = True
        result = self.execute("retire-highlevel")
        self.assertTrue(result["retiredRefreshDenied"])
        self.assertIsNone(result["uncertainEffects"])
        self.execute("observe-highlevel")
        self.assertEqual(sum(path == "/oauth/token" for _method, path in self.fixture.calls), 1)


if __name__ == "__main__":
    unittest.main()
