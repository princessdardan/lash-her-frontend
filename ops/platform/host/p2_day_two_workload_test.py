"""The provider and selected deployment are served by the owned TLS fixture."""

import copy
import json
import os
import ssl
import unittest
import urllib.request
from unittest.mock import patch

import frontend_probe
from frontend_release_adapters import LockedClient
import p2_canonical_browser_origin as canonical
import p2_day_two_workload as workload
import p2_lifecycle_native_test as native_fixture


class DayTwoWorkloadTests(unittest.TestCase):
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
        self.profile = self.base.profiled()
        self.context = self.base.context
        del self.context["privateProbeDirectory"]
        binding = self.base.plan["writerAdmissionBinding"]
        self.base.plan.update(targetSha256=binding["targetSha256"],
            producer={"producerSha256": binding["producerSha256"], "role": {"name": binding["roleName"]}})
        self.fixture = self.base.fixture
        self.guard_checks = 0
        self.guard_failure_at = None
        self.client = LockedClient(self.fixture.client, self.verify)
        self.requests = []
        self.bearer = "fixture-day-two-bearer"
        self.challenge = "1" * 64
        self.headers = {"Content-Type": "application/json", "Cache-Control": "private, no-store"}
        self.canonical_origin = False
        self.probe = self.probe_client()

    def verify(self):
        self.guard_checks += 1
        if self.guard_checks == self.guard_failure_at:
            raise ValueError("OWNED_GUARD_LOST")

    def probe_client(self, *, trust_fixture=True):
        if trust_fixture:
            ca = ssl.create_default_context(cafile=str(self.fixture.cert))
            with patch.object(workload.ssl, "create_default_context", return_value=ca):
                probe = workload._WorkloadProbe()
        else:
            probe = workload._WorkloadProbe()
        opener = probe._opener
        owner = self

        class OwnedTransport:
            def open(self, request, timeout):
                origin = canonical.ORIGIN if owner.canonical_origin else owner.base.plan["deploymentUrl"]
                owner.assertEqual(request.full_url, origin + workload._PATH)
                owner.assertEqual(request.get_method(), "GET")
                headers = {key.lower(): value for key, value in request.header_items()}
                owner.requests.append(headers)
                return opener.open(urllib.request.Request(owner.fixture.origin + workload._PATH,
                    method="GET", headers=dict(request.header_items())), timeout=timeout)

        probe._opener = OwnedTransport()
        return probe

    def alias(self):
        return {"alias": canonical.HOST, "projectId": canonical.PROJECT, "deploymentId": "dpl_fixture",
            "deployment": {"id": "dpl_fixture", "url": "owned-fixture.vercel.app"}}

    def response(self):
        value = {**copy.deepcopy(self.base.response()), "gatewayOrigin": "https://api-staging.lashher.com", "durationMs": 2}
        if self.canonical_origin:
            value.update(authenticationOrigins=dict(canonical.AUTHENTICATION_ORIGINS),
                deploymentUrl=self.base.plan["deploymentUrl"].removeprefix("https://"))
        return value

    def enqueue(self, *, body=None, status=200, headers=None, alias_before=None, alias_after=None,
                native_after=False, deployment_after=None):
        self.base.enqueue_metadata()
        self.fixture.enqueue(self.base.project(), self.alias() if alias_before is None else alias_before)
        self.fixture.responses.append((status, self.response() if body is None else body,
            self.headers if headers is None else headers))
        self.fixture.enqueue(self.alias() if alias_after is None else alias_after)
        self.fixture.enqueue(self.fixture.deployment() if deployment_after is None else deployment_after,
            self.base.project(enabled=native_after))

    def observe(self, **overrides):
        inputs = {"context": self.context, "client": self.client, "cron_secret": "  " + self.bearer + "  ",
            "expected_profile": self.profile}
        inputs.update(overrides)
        with patch.object(workload, "_WorkloadProbe", return_value=self.probe), \
                patch.object(frontend_probe, "_private_input", side_effect=AssertionError("legacy probe file read")):
            observe = workload.observe_browser_origin if self.canonical_origin else workload.observe
            return observe(**inputs)

    def test_selected_https_has_one_fresh_challenge_and_bracketed_provider_reads(self):
        self.enqueue()
        with patch.dict(os.environ, {"HTTPS_PROXY": "https://127.0.0.1:1", "NO_PROXY": ""}):
            self.probe = self.probe_client()
            result = self.observe()
        self.assertEqual(result["status"], "P2_DAY_TWO_WORKLOAD_OBSERVED")
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["qualificationTargetProfile"], self.profile)
        self.assertEqual(result["candidateSha256"], self.base.plan["candidateSha256"])
        self.assertEqual(result["phase2ContractManifestSha256"], self.base.release["phase2ContractManifestSha256"])
        self.assertEqual(result["featureControls"], self.base.plan["featureControls"])
        self.assertEqual(result["writerAdmissionBinding"], self.base.plan["writerAdmissionBinding"])
        self.assertFalse(result["nativeEnabled"])
        self.assertTrue(result["workloadChallengeVerified"])
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["aliasReadbacks"], 2)
        self.assertEqual(self.guard_checks, 16)
        self.assertEqual([call["method"] for call in self.fixture.calls], ["GET"] * 8)
        self.assertEqual([call["path"].split("?", 1)[0] for call in self.fixture.calls], [
            "/v13/deployments/dpl_fixture", "/v9/projects/" + canonical.PROJECT, "/v9/projects/" + canonical.PROJECT,
            "/v4/aliases/" + canonical.HOST, workload._PATH, "/v4/aliases/" + canonical.HOST,
            "/v13/deployments/dpl_fixture", "/v9/projects/" + canonical.PROJECT,
        ])
        self.assertEqual(self.requests, [{"authorization": "Bearer " + self.bearer,
            "x-vercel-protection-bypass": "fixture-private-bypass", "x-lash-release-mode": "phase2-day-two-workload",
            "x-lash-release-challenge": self.challenge, "accept": "application/json", "cache-control": "no-cache"}])
        serialized = json.dumps(result)
        for value in (self.bearer, self.challenge, "fixture-private-bypass", "fixture-private-token", "provider-secret-must-not-escape",
                      "authenticationOrigins", "browserOrigin", "actionAuthority", "expiresAt"):
            self.assertNotIn(value, serialized)

    def test_canonical_request_binds_actual_auth_origins_and_runtime_deployment(self):
        self.canonical_origin = True
        response = self.response()
        self.enqueue(body=response)
        result = self.observe()
        self.assertEqual(result["status"], "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED")
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["qualificationTargetProfile"], self.profile)
        self.assertEqual(result["candidateSha256"], self.base.plan["candidateSha256"])
        self.assertEqual(result["phase2ContractManifestSha256"], self.base.release["phase2ContractManifestSha256"])
        self.assertEqual(result["browserOrigin"], canonical.ORIGIN)
        self.assertEqual(result["authenticationOrigins"], canonical.AUTHENTICATION_ORIGINS)
        self.assertEqual(result["deploymentUrl"], self.base.plan["deploymentUrl"])
        self.assertEqual(result["releaseId"], self.base.release["releaseId"])
        self.assertEqual(result["protectedWorkloadSha256"], canonical._digest(response))
        self.assertEqual(result["aliasReadbacks"], 2)
        self.assertFalse(result["aliasRedirect"])
        self.assertFalse(result["probeExpiryExtended"])
        self.assertFalse(result["releaseAccepted"])
        self.assertEqual(self.guard_checks, 16)
        self.assertEqual([call["path"].split("?", 1)[0] for call in self.fixture.calls], [
            "/v13/deployments/dpl_fixture", "/v9/projects/" + canonical.PROJECT, "/v9/projects/" + canonical.PROJECT,
            "/v4/aliases/" + canonical.HOST, workload._PATH, "/v4/aliases/" + canonical.HOST,
            "/v13/deployments/dpl_fixture", "/v9/projects/" + canonical.PROJECT,
        ])
        self.assertEqual(self.requests[0]["x-lash-release-mode"], "phase2-day-two-canonical-workload")
        for secret in (self.bearer, self.challenge, "fixture-private-bypass", "fixture-private-token"):
            self.assertNotIn(secret, json.dumps(result))

    def test_canonical_refuses_wrong_deployment_auth_origins_and_provider_drift(self):
        self.canonical_origin = True
        for key, value in (
                ("deploymentUrl", "other-fixture.vercel.app"),
                ("deploymentUrl", self.base.plan["deploymentUrl"]),
                ("authenticationOrigins", {**canonical.AUTHENTICATION_ORIGINS, "adminOrigin": "https://other.invalid"}),
                ("authenticationOrigins", {**canonical.AUTHENTICATION_ORIGINS, "customerRedirectProxyEnabled": 0}),
                ("authenticationOrigins", {**canonical.AUTHENTICATION_ORIGINS, "adminRedirectProxyOrigin": canonical.ORIGIN})):
            with self.subTest(key=key, value=value):
                self.enqueue(body={**self.response(), key: value})
                with self.assertRaisesRegex(ValueError, "CANONICAL_BINDING_REFUSED"):
                    self.observe()
                self.fixture.responses.clear()
        for variant in ({"alias_after": {**self.alias(), "redirect": canonical.ORIGIN}},
                        {"deployment_after": {**self.fixture.deployment(), "url": "other-fixture.vercel.app"}},
                        {"deployment_after": {**self.fixture.deployment(), "meta": {"lashReleaseId": "other-release"}}},
                        {"native_after": True}):
            with self.subTest(variant=variant):
                self.enqueue(**variant)
                with self.assertRaises(ValueError):
                    self.observe()
                self.fixture.responses.clear()

    def test_canonical_and_immutable_request_targets_cannot_be_swapped(self):
        for url, canonical_origin in ((canonical.ORIGIN, False), (self.base.plan["deploymentUrl"], True),
                                      ("https://staging.lashher.com/other", True), ("https://other.invalid", True)):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "FIXED_ORIGIN_REQUIRED"):
                self.probe.request(url, self.bearer, "owned-bypass", self.challenge, canonical_origin=canonical_origin)
        self.assertEqual(self.fixture.calls, [])

    def test_old_challenge_refuses_the_next_observation_without_retry(self):
        with patch.object(workload.secrets, "token_hex", side_effect=[self.challenge, "2" * 64]) as nonce:
            self.enqueue()
            self.observe()
            self.enqueue()
            with self.assertRaisesRegex(ValueError, "WORKLOAD_BINDING_REFUSED"):
                self.observe()
        self.assertEqual(nonce.call_count, 2)
        self.assertEqual([row["x-lash-release-challenge"] for row in self.requests], [self.challenge, "2" * 64])

    def test_invalid_profile_bearer_or_plan_refuses_before_provider_reads(self):
        for inputs in ({"expected_profile": None}, {"client": self.fixture.client}, {"cron_secret": " "},
                       {"cron_secret": "fixture\r\nX-Other: injected"}):
            with self.subTest(fields=list(inputs)), self.assertRaises(ValueError):
                self.observe(**inputs)
        changed = copy.deepcopy(self.context)
        changed["plan"]["deploymentUrl"] = "https://foreign.invalid"
        with self.assertRaisesRegex(ValueError, "WORKLOAD_PLAN_REFUSED"):
            self.observe(context=changed)
        changed = copy.deepcopy(self.context)
        changed["plan"]["writerAdmissionBinding"]["sourceCommit"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "WORKLOAD_PLAN_REFUSED"):
            self.observe(context=changed)
        self.assertEqual(self.fixture.calls, [])

    def test_guard_loss_on_either_side_of_protected_https_refuses(self):
        for boundary, expected_requests in ((9, 0), (10, 1)):
            with self.subTest(boundary=boundary):
                self.guard_checks = 0
                self.guard_failure_at = boundary
                self.enqueue()
                with self.assertRaisesRegex(ValueError, "OWNED_GUARD_LOST"):
                    self.observe()
                self.assertEqual(len(self.requests), expected_requests)
                self.fixture.responses.clear()

    def test_alias_or_native_drift_refuses_the_observation(self):
        for variant in ({"alias_before": {**self.alias(), "redirect": "owned.invalid"}},
                        {"alias_after": {**self.alias(), "deploymentId": "dpl_other"}}, {"native_after": True}):
            with self.subTest(fields=list(variant)):
                self.enqueue(**variant)
                with self.assertRaises(ValueError):
                    self.observe()
                self.fixture.responses.clear()
        self.assertEqual(len(self.requests), 2)

    def test_wrong_workload_identity_or_projection_refuses(self):
        for drift in ({"gatewayOrigin": "https://foreign.invalid"}, {"sourceCommit": "b" * 40}, {"contractPhase": "p1"},
                      {"writerAdmissionBinding": {**self.base.plan["writerAdmissionBinding"], "generation": 2}},
                      {"featureControls": {**self.base.plan["featureControls"], "CUSTOMER_AUTH_ENABLED": False}},
                      {"durationMs": True}, {"releaseAccepted": True}):
            with self.subTest(fields=list(drift)):
                self.enqueue(body={**self.response(), **drift})
                with self.assertRaisesRegex(ValueError, "WORKLOAD_BINDING_REFUSED"):
                    self.observe()
                self.fixture.responses.clear()

    def test_cache_cookie_duplicate_json_and_body_bounds_refuse(self):
        duplicate = b'{"version":1,' + json.dumps(self.response()).encode()[1:]
        for variant in ({"headers": {**self.headers, "Cache-Control": "not-private, no-store"}},
                        {"headers": {**self.headers, "Cache-Control": "private, no-store, public"}},
                        {"headers": {**self.headers, "Set-Cookie": "fixture=owned"}},
                        {"headers": {**self.headers, "Content-Type": "text/html"}},
                        {"body": duplicate}, {"body": b"x" * 65_537}):
            with self.subTest(fields=list(variant)):
                self.enqueue(**variant)
                with self.assertRaisesRegex(ValueError, "WORKLOAD_REQUEST_FAILED"):
                    self.observe()
                self.fixture.responses.clear()

    def test_redirect_and_untrusted_tls_never_reach_another_endpoint(self):
        self.enqueue(status=302, headers={"Location": self.fixture.origin + "/would-leak"})
        with self.assertRaisesRegex(ValueError, "WORKLOAD_REQUEST_FAILED"):
            self.observe()
        self.assertEqual([call["path"] for call in self.fixture.calls if call["path"].startswith("/would-leak")], [])
        self.fixture.responses.clear()
        self.probe = self.probe_client(trust_fixture=False)
        self.enqueue()
        with self.assertRaisesRegex(ValueError, "WORKLOAD_REQUEST_FAILED"):
            self.observe()
        self.assertEqual(sum(call["path"] == workload._PATH for call in self.fixture.calls), 1)


if __name__ == "__main__":
    unittest.main()
