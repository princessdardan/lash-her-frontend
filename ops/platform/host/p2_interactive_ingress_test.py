"""Owned provider/TLS fixtures; no staging or credential access."""
import copy
import json
import ssl
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

import p2_canonical_browser_origin as canonical
import p2_interactive_ingress as ingress
import p2_lifecycle_native_test as native_fixture
import vercel


class InteractiveIngressTests(unittest.TestCase):
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
        self.fixture = self.base.fixture
        ca = ssl.create_default_context(cafile=str(self.fixture.cert))
        with patch.object(canonical.ssl, "create_default_context", return_value=ca):
            self.canonical_probe = canonical.CanonicalBrowserProbeClient()
        owned = self.base.probe._opener
        fixture = self.fixture

        class ExactCanonicalTransport:
            def open(inner, request, timeout):
                self.assertEqual(request.full_url, canonical.ORIGIN + "/api/internal/release-probe")
                self.assertEqual(request.get_header("X-vercel-protection-bypass"), "fixture-private-bypass")
                mapped = urllib.request.Request(fixture.origin + "/api/internal/release-probe",
                                                headers=dict(request.header_items()), method=request.method)
                return owned.open(mapped, timeout=timeout)

        self.canonical_probe._opener = ExactCanonicalTransport()
        self.challenge = patch.object(canonical.secrets, "token_hex", return_value="2" * 64)
        self.challenge.start()
        self.addCleanup(self.challenge.stop)

    def project(self):
        value = self.base.project()
        value["ssoProtection"] = {"deploymentType": "all"}
        value["protectionBypass"] = {
            "fixture-private-bypass": {"createdAt": 1794000000000, "createdBy": "usr_fixture", "scope": "automation-bypass"}}
        return value

    def alias(self):
        return {"alias": canonical.HOST, "projectId": canonical.PROJECT,
                "deploymentId": "dpl_fixture", "deployment": {"id": "dpl_fixture", "url": "owned-fixture.vercel.app"},
                "deletedAt": None, "redirect": None, "redirectStatusCode": None, "microfrontends": None}

    def enqueue_observation(self, after=None):
        project = self.project()
        response = {**self.base.response(), "challenge": "2" * 64,
                    "authenticationOrigins": canonical.AUTHENTICATION_ORIGINS}
        self.fixture.enqueue(project, self.fixture.deployment(), project, self.alias(), project)
        self.fixture.responses.append((200, response, {"Content-Type": "application/json", "Cache-Control": "private, no-store"}))
        self.fixture.enqueue(self.alias(), self.fixture.deployment(), project, after or project)

    def enqueue_selected_protection(self, paths, *, after=None, final_alias=None, fail_request=None):
        project = self.project()
        self.fixture.enqueue(self.fixture.deployment(), project, self.alias(), project)
        for index in range(2 * len(paths)):
            if index == fail_request:
                self.fixture.responses.append((302, b"", {"Location": "https://foreign.invalid/"}))
                return
            self.fixture.responses.append((401 if index % 2 == 0 else 403, b"owned-denial",
                                           {"Content-Type": "text/html"}))
        self.fixture.enqueue(after or project, final_alias or self.alias(), self.fixture.deployment(), after or project)

    def owned_unauthenticated_requester(self):
        ca = ssl.create_default_context(cafile=str(self.fixture.cert))
        with patch.object(ingress.ssl, "create_default_context", return_value=ca):
            requester = ingress.UnauthenticatedIngressClient()
        owned = requester._opener
        urls = []

        class ExactTransport:
            def open(inner, request, timeout):
                url = urllib.parse.urlsplit(request.full_url)
                self.assertIn(url.netloc, (canonical.HOST, "owned-fixture.vercel.app"))
                self.assertEqual(url.scheme, "https")
                self.assertEqual(url.query, "")
                self.assertEqual(url.fragment, "")
                self.assertEqual(request.method, "GET")
                self.assertIsNone(request.data)
                self.assertEqual({name.lower() for name, _ in request.header_items()}, {"accept", "cache-control"})
                urls.append(request.full_url)
                mapped = urllib.request.Request(self.fixture.origin + url.path, headers=dict(request.header_items()), method="GET")
                try:
                    return owned.open(mapped, timeout=timeout)
                except urllib.error.HTTPError as error:
                    error.url = request.full_url
                    raise

        requester._opener = ExactTransport()
        return requester, urls

    class Denied:
        def __init__(self, alias=401, deployment=403):
            self.statuses = [alias, deployment]
            self.origins = []

        def request(self, origin):
            self.origins.append(origin)
            return {"status": self.statuses.pop(0), "redirected": False}

    def test_profiled_read_only_leaf_joins_provider_canonical_and_two_unauthenticated_denials(self):
        self.enqueue_observation()
        denied = self.Denied()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=denied):
            result = ingress.observe(self.base.context, self.fixture.client, self.canonical_probe,
                                     expected_profile=self.profile)
        self.assertEqual(result["status"], "P2_INTERACTIVE_INGRESS_READ_ONLY_VERIFIED")
        self.assertEqual(result["qualificationTargetProfile"], self.profile)
        self.assertEqual(result["teamId"], vercel.TEAM)
        self.assertEqual(result["projectId"], canonical.PROJECT)
        self.assertEqual(result["deploymentId"], "dpl_fixture")
        self.assertEqual(result["scope"], "all-deployments")
        self.assertEqual(result["automationBypassCount"], 1)
        self.assertEqual(denied.origins, [canonical.ORIGIN, self.base.plan["deploymentUrl"]])
        self.assertFalse(result["interactiveNewWorkAuthorized"])
        self.assertFalse(result["automationBypassCustodyVerified"])
        serialized = json.dumps(result)
        for private in ("fixture-private-token", "fixture-private-bypass", "f" * 64):
            self.assertNotIn(private, serialized)
        self.assertTrue(all(call["method"] == "GET" for call in self.fixture.calls))

    def test_missing_profile_or_non_all_protection_refuses_before_canonical_or_unauthenticated_http(self):
        denied = self.Denied()
        with self.assertRaisesRegex(ValueError, "QUALIFICATION_TARGET_PROFILE_REQUIRED"):
            ingress.observe(self.base.context, self.fixture.client, self.canonical_probe)
        self.assertEqual(self.fixture.calls, [])
        for protection in (None, {"deploymentType": "prod_deployment_urls_and_all_previews"},
                           {"deploymentType": "all", "unknown": True}):
            with self.subTest(protection=protection):
                project = self.project()
                project["ssoProtection"] = protection
                self.fixture.enqueue(project)
                with self.assertRaisesRegex(ValueError, "ALL_DEPLOYMENTS_PROTECTION_REQUIRED"):
                    ingress.observe(self.base.context, self.fixture.client, self.canonical_probe,
                                    expected_profile=self.profile)
                self.fixture.responses.clear()
        self.assertEqual(denied.origins, [])

    def test_unknown_integration_or_malformed_bypass_scope_refuses_without_returning_keys(self):
        variants = (
            {"integration-secret": {"createdAt": 1, "createdBy": "integration", "scope": "integration-automation-bypass"}},
            {"normal-secret": {"scope": "automation-bypass"}},
            {},
        )
        for bypasses in variants:
            with self.subTest(bypasses=list(bypasses)):
                project = self.project()
                project["protectionBypass"] = bypasses
                self.fixture.enqueue(project)
                with self.assertRaisesRegex(ValueError, "AUTOMATION_BYPASS_REQUIRED|PROTECTION_BYPASS_SCOPE_REFUSED"):
                    ingress.observe(self.base.context, self.fixture.client, self.canonical_probe,
                                    expected_profile=self.profile)
                self.fixture.responses.clear()

    def test_public_exception_redirect_or_protection_drift_refuses(self):
        self.enqueue_observation()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=self.Denied(alias=302)), \
             self.assertRaisesRegex(ValueError, "UNAUTHENTICATED_INGRESS_NOT_DENIED"):
            ingress.observe(self.base.context, self.fixture.client, self.canonical_probe,
                            expected_profile=self.profile)
        self.fixture.responses.clear()
        changed = self.project()
        changed["protectionBypass"] = {
            "replacement-secret": {"createdAt": 1794000000001, "createdBy": "usr_fixture", "scope": "automation-bypass"}}
        self.enqueue_observation(after=changed)
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=self.Denied()), \
             self.assertRaisesRegex(ValueError, "PROTECTION_CHANGED"):
            ingress.observe(self.base.context, self.fixture.client, self.canonical_probe,
                            expected_profile=self.profile)

    def test_actual_tls_transport_sends_no_credentials_and_accepts_only_direct_401_or_403(self):
        ca = ssl.create_default_context(cafile=str(self.fixture.cert))
        with patch.object(ingress.ssl, "create_default_context", return_value=ca):
            requester = ingress.UnauthenticatedIngressClient()
        owned = requester._opener
        fixture = self.fixture

        class ExactTransport:
            def open(inner, request, timeout):
                self.assertEqual(request.full_url, canonical.ORIGIN + "/")
                for name in ("Authorization", "Cookie", "X-vercel-protection-bypass", "Host"):
                    self.assertIsNone(request.get_header(name))
                mapped = urllib.request.Request(fixture.origin + "/", headers=dict(request.header_items()), method="GET")
                try:
                    return owned.open(mapped, timeout=timeout)
                except urllib.error.HTTPError as error:
                    error.url = request.full_url
                    raise

        requester._opener = ExactTransport()
        for status in (401, 403):
            with self.subTest(status=status):
                self.fixture.responses.append((status, b"credential-free-denial", {"Content-Type": "text/html"}))
                self.assertEqual(requester.request(canonical.ORIGIN), {"status": status, "redirected": False})
                self.assertIsNone(self.fixture.calls[-1]["authorization"])
        self.fixture.responses.append((302, b"", {"Location": "https://foreign.invalid/"}))
        with self.assertRaisesRegex(ValueError, "NOT_DENIED"):
            requester.request(canonical.ORIGIN)
        self.fixture.responses.append((200, b"public application response", {"Content-Type": "text/html"}))
        with self.assertRaisesRegex(ValueError, "NOT_DENIED"):
            requester.request(canonical.ORIGIN)

    def test_browser_matrix_checks_fixed_routes_over_actual_tls_and_rejoins_provider_identity(self):
        paths = ("/", "/sign-in", "/admin/sign-in", "/api/customer-auth/session", "/api/auth/session",
                 "/api/customer-auth/callback/google", "/api/customer-auth/callback/resend", "/api/auth/callback/google")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            receipt = ingress.observe_browser_protection(self.base.context, self.fixture.client, expected_profile=self.profile)
        self.assertEqual(receipt["status"], "P2_BROWSER_PROTECTION_OBSERVED")
        self.assertEqual(receipt["qualificationTargetProfile"], self.profile)
        self.assertEqual(receipt["candidateSha256"], self.base.plan["candidateSha256"])
        self.assertEqual(receipt["deploymentId"], self.base.plan["deploymentId"])
        self.assertEqual(receipt["sourceCommit"], self.base.plan["sourceCommit"])
        self.assertEqual(receipt["requestMethod"], "GET")
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertFalse(receipt["nativeEnabled"])
        self.assertFalse(receipt["automationBypassCustodyVerified"])
        self.assertFalse(receipt["interactiveNewWorkAuthorized"])
        self.assertFalse(receipt["redirectFollowed"])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        for request in self.fixture.calls[4:20]:
            self.assertEqual(request["method"], "GET")
            self.assertIsNone(request["authorization"])
            self.assertIsNone(request["body"])
        self.assertEqual(sum("/v4/aliases/" in request["path"] for request in self.fixture.calls), 2)
        self.assertEqual(self.fixture.responses, [])
        for private in ("fixture-private-token", "fixture-private-bypass", "owned-denial"):
            self.assertNotIn(private, json.dumps(receipt))

    def test_browser_callback_redirect_refuses_without_followup_or_success(self):
        self.enqueue_selected_protection(ingress._BROWSER_PATHS, fail_request=10)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester), \
             self.assertRaisesRegex(ValueError, "UNAUTHENTICATED_INGRESS_NOT_DENIED"):
            ingress.observe_browser_protection(self.base.context, self.fixture.client, expected_profile=self.profile)
        self.assertEqual(urls[-1], canonical.ORIGIN + "/api/customer-auth/callback/google")
        self.assertEqual(len(urls), 11)
        self.assertEqual(self.fixture.responses, [])

    def test_browser_matrix_refuses_alias_drift_after_denials(self):
        self.enqueue_selected_protection(ingress._BROWSER_PATHS,
                                         final_alias={**self.alias(), "deploymentId": "dpl_foreign"})
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester), \
             self.assertRaisesRegex(ValueError, "ALIAS_BINDING_REFUSED"):
            ingress.observe_browser_protection(self.base.context, self.fixture.client, expected_profile=self.profile)
        self.assertEqual(len(urls), 16)

    def test_export_observation_retains_root_only_and_legacy_receipt(self):
        self.enqueue_selected_protection(("/",))
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            receipt = ingress.observe_selected_protection(self.base.context, self.fixture.client, expected_profile=self.profile)
        self.assertEqual(receipt["status"], "P2_SELECTED_PROTECTION_OBSERVED")
        self.assertEqual(receipt["aliasUnauthenticatedStatus"], 401)
        self.assertEqual(receipt["deploymentUnauthenticatedStatus"], 403)
        self.assertNotIn("endpointDenials", receipt)
        self.assertEqual(urls, [canonical.ORIGIN + "/", self.base.plan["deploymentUrl"] + "/"])

    def test_requester_refuses_query_redirect_target_and_arbitrary_paths_before_transport(self):
        requester, urls = self.owned_unauthenticated_requester()
        for path in ("/api/customer-auth/callback/google?code=fixture", "/api/auth/session#fragment",
                     "/api/cron/account-lifecycle", "//foreign.invalid/"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "INGRESS_PATH_REFUSED"):
                requester.request(canonical.ORIGIN, path)
        self.assertEqual(urls, [])


if __name__ == "__main__":
    unittest.main()
