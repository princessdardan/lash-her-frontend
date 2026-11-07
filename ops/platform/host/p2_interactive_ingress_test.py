"""Owned provider/TLS fixtures; no staging or credential access."""
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import ssl
import stat
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

import p2_canonical_browser_origin as canonical
import p2_interactive_ingress as ingress
import p2_interactive_window as window
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

    def test_authoring_probes_only_reviewed_page_and_endpoint_on_both_origins(self):
        paths = ("/admin/courses", "/api/admin/courses")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            receipt = ingress.observe_authoring_protection(self.base.context, self.fixture.client, expected_profile=self.profile)
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertFalse(receipt["interactiveNewWorkAuthorized"])
        self.assertEqual(self.fixture.responses, [])

    def test_authoring_edit_probes_exact_protected_course_detail_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        paths = (f"/admin/courses/{course}", f"/api/admin/courses/{course}")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "AUTHORING_COURSE_ID_REQUIRED"):
                ingress.observe_authoring_protection(self.base.context, self.fixture.client,
                                                      expected_profile=self.profile, course_id=course + "/quiz")
            receipt = ingress.observe_authoring_protection(self.base.context, self.fixture.client,
                                                            expected_profile=self.profile, course_id=course)
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_publication_probes_reviewed_detail_and_readiness_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        detail = f"/api/admin/courses/{course}"
        paths = (f"/admin/courses/{course}", detail, f"{detail}/publication-readiness")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "READINESS_COURSE_REQUIRED"):
                ingress.observe_authoring_protection(self.base.context, self.fixture.client,
                                                      expected_profile=self.profile, publication_readiness=True)
            receipt = ingress.observe_authoring_protection(self.base.context, self.fixture.client, course_id=course,
                                                            expected_profile=self.profile, publication_readiness=True)
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], list(paths))
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_quiz_probes_reviewed_detail_and_lesson_quiz_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        paths = (f"/admin/courses/{course}", f"/api/admin/courses/{course}", f"/api/admin/lessons/{lesson}/quiz")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            for args in ({"quiz_lesson_id": lesson}, {"course_id": course, "quiz_lesson_id": lesson + "/attempts"}):
                with self.assertRaisesRegex(ValueError, "QUIZ_LESSON_REQUIRED"):
                    ingress.observe_authoring_protection(self.base.context, self.fixture.client, expected_profile=self.profile, **args)
            receipt = ingress.observe_authoring_protection(self.base.context, self.fixture.client, course_id=course,
                                                            expected_profile=self.profile, quiz_lesson_id=lesson)
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], list(paths))
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_learning_probes_exact_reviewed_public_and_academy_pages_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        paths = ("/courses/owned-course", f"/academy/courses/{course}")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            for changed in ({"course_id": course, "slug": "owned-course?extra=yes"},
                            {"course_id": course + "/lessons", "slug": "owned-course"}):
                with self.assertRaisesRegex(ValueError, "LEARNING_COURSE_REQUIRED"):
                    ingress.observe_learning_protection(self.base.context, self.fixture.client,
                                                        expected_profile=self.profile, **changed)
            receipt = ingress.observe_learning_protection(self.base.context, self.fixture.client, course_id=course,
                                                           expected_profile=self.profile, slug="owned-course")
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], list(paths))
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_paid_grant_probes_only_exact_reviewed_owner_page_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        path = f"/admin/courses/{course}/manual-grants"
        self.enqueue_selected_protection((path,))
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "PAID_GRANT_COURSE_REQUIRED"):
                ingress.observe_paid_grant_protection(self.base.context, self.fixture.client, course_id=course + "/foreign",
                                                       expected_profile=self.profile)
            receipt = ingress.observe_paid_grant_protection(self.base.context, self.fixture.client, course_id=course,
                                                             expected_profile=self.profile)
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], [path])
        self.assertEqual(urls, [origin + path for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
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


class InteractiveWindowTests(unittest.TestCase):
    def test_paid_grant_plan_binds_reviewed_reason_revision_and_exact_encoded_targets(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        user = "10000000-0000-4000-8000-000000000003"
        key = "10000000-0000-4000-8000-000000000004"
        entitlements = "/course/v1/admin/entitlements"
        query = f"idempotencyKey=owner-paid%3A{key}&limit=2"
        requests = [
            {"method": "GET", "target": f"/course/v1/admin/courses/{course}", "bodySha256": window._EMPTY, "uses": 3},
            {"method": "GET", "target": f"{entitlements}/commands?{query}", "bodySha256": window._EMPTY, "uses": 2},
            {"method": "POST", "target": f"{entitlements}/grants", "bodySha256": "b" * 64, "uses": 1},
            {"method": "GET", "target": f"{entitlements}/grants?userId={user}&courseId={course}&{query}", "bodySha256": window._EMPTY, "uses": 1}]
        selection = {"operation": "grant-paid-access", "courseId": course, "userId": user, "revision": 2_147_483_647,
                     "idempotencyKey": key, "reasonSha256": "d" * 64}
        action = {"stage": "paid-grant", "actorId": owner, "windowSeconds": 60, "requests": requests, "paidGrantAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, (owner + key).replace("-", ""))
        cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                       "8", "paid-grant", 1_794_009_600, 60, "c" * 32, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "paid-grant"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        with self.assertRaisesRegex(ValueError, "INTERACTIVE_ACTION_REQUIRED"):
            window.validate_interactive_action({name: value for name, value in action.items() if name != "paidGrantAction"})
        for change in ({"reasonSha256": window._EMPTY}, {"reasonSha256": "0" * 64}, {"revision": 0},
                       {"revision": True}, {"revision": 2_147_483_648}, {"userId": "wrong"}):
            with self.subTest(selection=change), self.assertRaisesRegex(ValueError, "PAID_GRANT_SELECTION_REQUIRED"):
                window.validate_interactive_action({**action, "paidGrantAction": {**selection, **change}})
        for index, change in ((0, {"uses": 2}), (1, {"target": requests[1]["target"].replace("%3A", "%3a")}),
                              (1, {"target": requests[1]["target"] + f"&commandId={course}"}),
                              (2, {"bodySha256": window._EMPTY}), (3, {"target": requests[3]["target"].replace(user, owner)})):
            changed = [*requests]
            changed[index] = {**changed[index], **change}
            with self.subTest(request=change), self.assertRaisesRegex(ValueError, "PAID_GRANT_REQUESTS_REQUIRED"):
                window.validate_interactive_action({**action, "requests": changed})

    def test_quiz_plan_binds_revision_lesson_document_and_exact_routes(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        lesson = "10000000-0000-4000-8000-000000000003"
        quiz = f"/course/v1/admin/lessons/{lesson}/quiz"
        requests = [
            {"method": "GET", "target": f"/course/v1/admin/courses/{course}", "bodySha256": window._EMPTY, "uses": 2},
            {"method": "GET", "target": quiz, "bodySha256": window._EMPTY, "uses": 1},
            {"method": "PUT", "target": quiz, "bodySha256": "b" * 64, "uses": 1}]
        for revision in (0, 2_147_483_646):
            selection = {"operation": "save-quiz-revision", "courseId": course, "slug": "owned-draft", "revision": 4,
                         "lessonId": lesson, "quizRevision": revision, "documentSha256": "d" * 64}
            action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = window._selection_sha(action)
            self.assertEqual(selector, "7032712d617574682d7175697a2d7631" + owner.replace("-", ""))
            cookie, key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                 "8", "authoring", 1_794_009_600, 60, "c" * 32, selector)
            self.assertEqual(cookie.split(".")[6], selector)
            self.assertEqual(len(key), 64)
            for change in ({"quizRevision": -1}, {"quizRevision": 2_147_483_647}, {"quizRevision": False},
                           {"documentSha256": window._EMPTY}, {"documentSha256": "0" * 64}, {"lessonId": "wrong"}):
                with self.subTest(revision=revision, change=change), self.assertRaisesRegex(ValueError, "QUIZ_SELECTION_REQUIRED"):
                    window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
            for change in ({"method": "POST"}, {"target": quiz + "/attempts"}, {"bodySha256": window._EMPTY}, {"uses": 2}):
                with self.subTest(revision=revision, request=change), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "requests": [*requests[:2], {**requests[2], **change}]})

    def test_publication_plan_binds_outcome_issue_codes_and_exact_patch_digest(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        detail = f"/course/v1/admin/courses/{course}"
        digest = hashlib.sha256(b'{"expectedRevision":4,"status":"published"}').hexdigest()
        patch = {"method": "PATCH", "target": detail, "bodySha256": digest, "uses": 1}
        for outcome, codes, prefix in (("published", [], "7032712d617574682d7075622d763100"),
                                       ("blocked", ["MISSING_COVER", "NO_LESSONS"], "7032712d617574682d7264792d763100")):
            published = outcome == "published"
            selection = {"operation": "qualify-publication", "courseId": course, "slug": "owned-draft",
                         "revision": 4, "outcome": outcome, "issueCodes": codes}
            requests = [{"method": "GET", "target": detail, "bodySha256": window._EMPTY, "uses": 2 if published else 1},
                        {"method": "GET", "target": f"{detail}/publication-readiness", "bodySha256": window._EMPTY, "uses": 1}]
            if published:
                requests.append(patch)
            action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = window._selection_sha(action)
            self.assertEqual(selector, prefix + owner.replace("-", ""))
            cookie, key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                 "8", "authoring", 1_794_009_600, 60, "c" * 32, selector)
            self.assertEqual(cookie.split(".")[6], selector)
            self.assertEqual(len(key), 64)
            invalid_codes = (["NO_LESSONS"],) if published else ([], ["NO_LESSONS", "MISSING_COVER"],
                                                                ["NO_LESSONS"] * 2, ["lowercase"], [f"ISSUE_{n:02d}" for n in range(17)])
            for invalid in invalid_codes:
                with self.subTest(outcome=outcome, codes=invalid), self.assertRaisesRegex(ValueError, "PUBLICATION_SELECTION_REQUIRED"):
                    window.validate_interactive_action({**action, "authoringAction": {**selection, "issueCodes": invalid}})
            if published:
                changed = [*requests[:2], {**patch, "bodySha256": "c" * 64}]
                with self.assertRaisesRegex(ValueError, "PUBLICATION_DIGEST_REQUIRED"):
                    window.validate_interactive_action({**action, "requests": changed})
            else:
                with self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "requests": [*requests, patch]})

    def test_curriculum_creation_plan_binds_child_slug_parent_and_exact_use_counts(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        module = "10000000-0000-4000-8000-000000000003"
        for kind, parent, route in (("module", course, f"courses/{course}/modules"), ("lesson", module, f"modules/{module}/lessons")):
            selection = {"operation": "create-curriculum", "slug": "owned-draft", "childSlug": "owned-child",
                         "courseId": course, "revision": 4, "kind": kind, "parentId": parent}
            requests = [{"method": "GET", "target": f"/course/v1/admin/courses/{course}", "bodySha256": window._EMPTY, "uses": 2},
                        {"method": "POST", "target": f"/course/v1/admin/{route}", "bodySha256": "b" * 64, "uses": 1}]
            action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = window._selection_sha(action)
            self.assertEqual(selector, "7032712d617574682d6e65772d763100" + owner.replace("-", ""))
            cookie, key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                 "8", "authoring", 1_794_009_600, 60, "c" * 32, selector)
            self.assertEqual(cookie.split(".")[6], selector)
            self.assertEqual(len(key), 64)
            for change in ({"childSlug": "not-canonical!"}, {"parentId": owner}, {"revision": True}, {"courseId": owner}):
                with self.subTest(kind=kind, change=change), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
            for changed in ([{**requests[0], "uses": 3}, requests[1]],
                            [requests[0], {**requests[1], "target": requests[1]["target"] + "/reorder"}],
                            [requests[0], {**requests[1], "bodySha256": window._EMPTY}]):
                with self.subTest(kind=kind, requests=changed), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "requests": changed})

    def test_curriculum_reorder_plan_binds_exact_parent_targets_and_separate_selector(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        module = "10000000-0000-4000-8000-000000000003"
        for kind, parent, route in (("module", course, f"courses/{course}/modules/reorder"),
                                    ("lesson", module, f"modules/{module}/lessons/reorder")):
            selection = {"operation": "reorder-and-stale-curriculum", "slug": "owned-draft", "courseId": course,
                         "revision": 4, "kind": kind, "parentId": parent}
            requests = [{"method": "GET", "target": f"/course/v1/admin/courses/{course}", "bodySha256": window._EMPTY, "uses": 3},
                        *[{"method": "POST", "target": f"/course/v1/admin/{route}", "bodySha256": digest * 64, "uses": 1}
                          for digest in ("b", "c")]]
            action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
            self.assertEqual(window.validate_interactive_action(action), action)
            self.assertEqual(window._selection_sha(action), "7032712d617574682d736f72742d7631" + owner.replace("-", ""))
            for change in ({"kind": "quiz"}, {"parentId": owner}, {"revision": 0}, {"courseId": owner}):
                with self.subTest(kind=kind, change=change), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
            for change in ({"method": "PATCH"}, {"target": f"/course/v1/admin/courses/{course}"},
                           {"bodySha256": requests[2]["bodySha256"]}, {"uses": 2}):
                with self.subTest(kind=kind, request=change), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "requests": [requests[0], {**requests[1], **change}, requests[2]]})

    def test_authoring_edit_admits_only_reviewed_revision_routes_and_owner_selector(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        target = f"/course/v1/admin/courses/{course}"
        requests = [{"method": method, "target": target, "bodySha256": digest, "uses": uses}
                    for method, digest, uses in (("GET", window._EMPTY, 3), ("PATCH", "b" * 64, 1), ("PATCH", "c" * 64, 1))]
        selection = {"operation": "edit-and-stale-draft", "slug": "owned-draft", "courseId": course, "revision": 2_147_483_646}
        action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        self.assertEqual(window._selection_sha(action), "7032712d617574682d656469742d7631" + owner.replace("-", ""))
        for change in ({"revision": 0}, {"revision": True}, {"revision": 2_147_483_647}, {"courseId": owner}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
        for changed in ([{**requests[0], "uses": 2}, *requests[1:]],
                        [*requests[:2], {**requests[2], "bodySha256": requests[1]["bodySha256"]}],
                        [*requests[:2], {**requests[2], "target": f"/course/v1/admin/courses/{owner}"}]):
            with self.subTest(requests=changed), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "requests": changed})

    def test_authoring_observation_refusal_preserves_fence_and_nonzero_drain(self):
        from p2_certification_parent import P2ProfiledCertificationBroker

        actor = "10000000-0000-4000-8000-000000000001"
        action = {"stage": "authoring", "actorId": actor, "windowSeconds": 60,
                  "authoringAction": {"operation": "create-draft", "slug": "owned-draft"},
                  "requests": [{"method": "GET", "target": "/course/v1/admin/courses?limit=100",
                                "bodySha256": window._EMPTY, "uses": 1},
                               {"method": "POST", "target": "/course/v1/admin/courses",
                                "bodySha256": "b" * 64, "uses": 1}]}
        window.validate_interactive_action(action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, "7032712d617574686f72696e672d763110000000000040008000000000000001")
        selected = window._selection_sha({**action, "actorId": "10000000-0000-4000-8000-000000000002"})
        self.assertNotEqual(selected, selector)
        secret = "fixture" * 8
        permit_args = (secret, "https://owned.vercel.app", "a" * 40, "b" * 64,
                       "8", "authoring", 1_794_009_600, 60, "c" * 32)
        with self.assertRaisesRegex(ValueError, "FRONTEND_BINDING_REQUIRED"):
            window._material(*permit_args)
        cookie, gateway_key, _, _ = window._material(*permit_args, selector)
        fields = cookie.split(".")
        self.assertEqual((fields[0], fields[2], fields[6]), ("v2", "authoring", selector))
        signed = "\n".join(("lash-her:p2q:interactive:browser:v1", "owned.vercel.app", "a" * 40, "b" * 64, ".".join(fields[:-1])))
        self.assertEqual(fields[7], hmac.digest(secret.encode(), signed.encode(), "sha256").hex())
        self.assertRegex(gateway_key, r"^[a-f0-9]{64}$")
        for changed in ({**action, "requests": list(reversed(action["requests"]))},
                        {**action, "authoringAction": {**action["authoringAction"], "slug": "non-Canonical"}},
                        {**action, "requests": [action["requests"][0], {**action["requests"][1], "uses": 2}]}):
            with self.assertRaisesRegex(ValueError, "AUTHORING_DRAFT_REQUIRED"):
                window.validate_interactive_action(changed)
        with tempfile.TemporaryDirectory() as directory:
            broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
            stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
            plan = {"mode": "interactive-browser", "initialEpoch": "7", "scopedAction": action, "certificationActionId": "owned-action",
                    "planSha256": "c" * 64, "qualificationTargetProfile": {}}
            broker.initial = {"certificationPlan": plan, "certificationActionId": "owned-action",
                              "candidateSha256": "d" * 64, "interactiveController": {"challenge": "e" * 64}}
            broker.scoped_stage, broker.directory, broker.scoped_gate_lock = stage, Path(directory), threading.RLock()
            broker.external_armed = broker.guard_arm_verified = True
            broker.gateway_observation_attempted = False
            broker.scoped_case = broker.closing_at = None
            broker.check, stage._check = lambda: None, lambda: None
            broker.selected = {"releaseId": "owned-release"}
            stage.broker, stage.plan, stage.action = broker, plan, action
            stage._state, stage._private_cookie, stage._permit_issued = "opened", None, True
            stage._expires = int(time.time()) + 60
            stage._original = (b"ordinary state", 0o644, 0)
            current = [(b"scoped state", 0o640, window._GATEWAY_GID)]
            stage._scoped_sha = window._hash(current[0][0])
            stage._read = lambda: current[0]
            stage._replace = lambda *args: current.__setitem__(0, args)
            uncertainty = {"newWork": 1, "recovery": 0}

            def gateway():
                scoped = current[0] != stage._original
                return {"version": 3 if scoped else 1, "valid": not scoped,
                        "interactiveActive": scoped, "newWork": None if scoped else False, "recovery": None if scoped else False,
                        "sha256": window._hash(current[0][0]), "actionId": "owned-action",
                        "releaseId": "owned-release", "candidateSha256": "d" * 64,
                        "active": window._ZERO, "uncertain": uncertainty,
                        "interactiveEvidence": {"admitted": 2, "acknowledged": []}}

            stage._gateway = gateway
            self.assertEqual(broker._verify_gateway_boundary()["version"], 3)
            request = {"id": 1, "controllerChallenge": "e" * 64}
            result = broker.interactive_operation("interactive-observe", {**request, "operation": "interactive-observe"})
            self.assertEqual(result["status"], "P2_INTERACTIVE_AUTHORING_GATEWAY_OBSERVATION_REFUSED")
            self.assertEqual(list(Path(directory).iterdir()), [])
            with self.assertRaisesRegex(ValueError, "GATEWAY_DRAIN_REQUIRED"):
                broker.interactive_operation("interactive-fence", {**request, "operation": "interactive-fence"})
            self.assertEqual(current[0], stage._original)
            self.assertEqual(gateway()["uncertain"], uncertainty)
            with self.assertRaisesRegex(ValueError, "ORDINARY_GATEWAY_CHANGED"):
                broker._verify_gateway_boundary()

    def test_identity_permit_signs_reviewed_selection_with_no_gateway_write(self):
        first = "10000000-0000-4000-8000-000000000001"
        second = "10000000-0000-4000-8000-000000000002"
        secret = "fixture" * 8
        email_digest = "b" * 62 + "d0"
        reviewed_nonce = "d" * 32
        selectors = {}
        raw = b'closed gateway fixture'
        gateway = {"version": 1, "valid": True, "newWork": False, "recovery": False, "active": window._ZERO,
                   "uncertain": window._ZERO, "releaseId": "owned", "candidateSha256": "a" * 64, "sha256": window._hash(raw)}
        cases = (("admin", first, None), ("customer", first, None), ("customer", second, None),
                 ("customer", None, "google"), ("customer", None, "resend"))
        for actor_kind, actor_id, provider in cases:
            with self.subTest(actor_kind=actor_kind, actor_id=actor_id, provider=provider):
                action = {"stage": "identity", "actorId": None, "windowSeconds": 60, "requests": []}
                actor = {"actorKind": actor_kind, "actorId": actor_id or first}
                invalid = [{**action, "actorId": first, "identityActor": actor},
                           {**action, "identityActor": {**actor, "actorKind": "owner"}},
                           {**action, "identityActor": {**actor, "other": True}}]
                if provider is None:
                    action["identityActor"] = actor
                else:
                    enrollment = {"provider": provider, "emailSha256": email_digest, "nonce": reviewed_nonce}
                    action["identityEnrollment"] = enrollment
                    invalid.extend(({**action, "identityActor": actor}, {**action, "actorId": first},
                                    {**action, "requests": [{}]}))
                    invalid.extend({**action, "identityEnrollment": {**enrollment, **change}} for change in (
                        {"provider": "unknown"}, {"emailSha256": email_digest.upper()}, {"emailSha256": "0" * 64},
                        {"nonce": "d" * 31}, {"nonce": "0" * 32},
                        {"email": "private@example.invalid"}))
                for changed in invalid:
                    with self.assertRaises(ValueError):
                        window.validate_interactive_action(changed)
                stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
                stage.action = window.validate_interactive_action(action)
                stage.plan = {"initialEpoch": "7", "maximumSeconds": 300, "sourceCommit": "b" * 40, "targetSha256": "c" * 64,
                              "nativePlan": {"deploymentUrl": "https://owned.vercel.app"}}
                frontend = {"epoch": "7", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
                stage.broker = SimpleNamespace(initial={"candidateSha256": "a" * 64, "scopedCronSecret": secret},
                    selected={"releaseId": "owned"}, certification_started=time.monotonic(), vercel=object(),
                    check=lambda: None, _native_context=lambda: {}, profile_arguments=lambda: {},
                    observer=SimpleNamespace(probe=lambda _: {"admission": frontend}))
                stage._check = lambda: None
                stage._state, stage._original, stage._scoped_sha = "prepared", (raw, 0o644, 0), None
                stage._read = lambda: stage._original
                stage._gateway = lambda: gateway
                with patch.object(stage, "_replace") as replace, \
                     patch.object(window.native, "observe_metadata", return_value={"nativeEnabled": False}), \
                     patch.object(window.time, "time", return_value=1_794_009_600):
                    self.assertEqual(stage.open_gateway(), {"stage": "identity", "epoch": "8",
                                     "expiresAt": "2026-11-07T00:01:00.000Z", "gatewayScoped": False})
                    with self.assertRaisesRegex(ValueError, "FRONTEND_WINDOW"):
                        stage.take_private_browser_permit()
                    frontend.update(epoch="8", newWork=True, recovery=True)
                    cookie = stage.take_private_browser_permit()["cookie"].split(".")
                    self.assertEqual(cookie[:5], ["v2", "8", "identity", "1794009600", "1794009660"])
                    if provider is not None:
                        self.assertEqual(cookie[5], reviewed_nonce)
                        selector = ("a1" if provider == "google" else "a2") + "b" * 62
                    elif actor_kind == "admin":
                        selector = hashlib.sha256(b'["identity","admin"]').hexdigest()
                    else:
                        selector = "7032712d637573746f6d65722d763100" + actor_id.replace("-", "")
                    self.assertEqual(cookie[6], selector)
                    self.assertEqual(len(cookie), 8)
                    signed = "\n".join(("lash-her:p2q:interactive:browser:v1", "owned.vercel.app", "b" * 40, "c" * 64,
                                         ".".join(cookie[:-1])))
                    self.assertEqual(cookie[7], hmac.digest(secret.encode(), signed.encode(), "sha256").hex())
                    selectors[actor_kind, actor_id, provider] = cookie[6]
                    stage.fence_gateway()
                    self.assertTrue(stage.verify_gateway_fenced()["gatewayAdmissionClosed"])
                    replace.assert_not_called()
        self.assertNotEqual(selectors["customer", first, None], selectors["customer", second, None])
        self.assertNotEqual(selectors["customer", None, "google"], selectors["customer", None, "resend"])

    def test_guarded_private_permit_and_exact_gateway_fence(self):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        actor = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        key = "10000000-0000-4000-8000-000000000003"
        target = f"/course/v1/student/courses/{course}"
        digest = hashlib.sha256(f'{{"idempotencyKey":"{key}"}}'.encode()).hexdigest()
        requests = [
            {"method": "GET", "target": "/course/v1/courses/owned-course", "bodySha256": window._EMPTY, "uses": 1},
            {"method": "GET", "target": target, "bodySha256": window._EMPTY, "uses": 2},
            {"method": "POST", "target": f"{target}/enrollments", "bodySha256": digest, "uses": 1},
            {"method": "GET", "target": f"/course/v1/student/progress?courseId={course}", "bodySha256": window._EMPTY, "uses": 1}]
        selected = {"operation": "enroll-free-course", "courseId": course, "slug": "owned-course", "idempotencyKey": key}
        action = {"stage": "learning", "actorId": actor, "windowSeconds": 90, "requests": requests, "learningAction": selected}
        self.assertEqual(window.validate_interactive_action(action), action)
        for change in ({"actorId": "wrong"}, {"windowSeconds": 301}, {"requests": action["requests"] * 2},
                       {"stage": "lifecycle"}, {"learningAction": {**selected, "idempotencyKey": course}},
                       {"requests": [*requests[:2], {**requests[2], "bodySha256": "b" * 64}, requests[3]]}):
            with self.assertRaises(ValueError):
                window.validate_interactive_action({**action, **change})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mount = root / "admission"
            mount.mkdir()
            path = mount / "state.json"
            ordinary = {"version": 1, "environment": "staging", "releaseId": "owned-release", "candidateSha256": "a" * 64,
                        "actionId": "owned-prior", "newWork": False, "recovery": False}
            raw = (json.dumps(ordinary, sort_keys=True) + "\n").encode()
            path.write_bytes(raw)
            path.chmod(0o644)
            fd = os.open(mount, os.O_RDONLY | os.O_DIRECTORY)
            try:
                scope = P2CertificationScope.__new__(P2CertificationScope)
                scope.require_frontend = lambda *_: None
                scope.require_configuration = lambda *_: None
                broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
                broker.scope, broker.external_armed, broker.guard_arm_verified = scope, True, True
                broker.certification_started = time.monotonic()
                broker.directory = root
                broker.admission_fd, broker.admission_identity, broker.configuration = fd, os.fstat(fd), root
                broker.jobs, broker.selected = {"frontend": {}}, {"releaseId": "owned-release"}
                broker.action_id, broker.check = lambda: "owned-action", lambda: None
                broker._native_context, broker.profile_arguments, broker.vercel = lambda: {}, lambda: {}, object()
                secret = "owned-browser-permit-fixture-key"
                broker.initial = {"candidateSha256": "a" * 64, "scopedCronSecret": secret,
                    "sourceSha256": {window._SOURCE_KEY: window._hash(window._SOURCE.read_bytes())},
                    "certificationPlan": {"mode": "interactive-browser", "startState": "already-closed", "maximumSeconds": 300,
                        "scopedAction": action, "initialEpoch": "7", "sourceCommit": "b" * 40, "targetSha256": "c" * 64,
                        "certificationActionId": "owned-action", "planSha256": "f" * 64, "qualificationTargetProfile": {},
                        "nativePlan": {"deploymentUrl": "https://owned.vercel.app"},
                        "gatewayProcessSha256": "d" * 64, "gatewayConfigurationSha256": "e" * 64}}
                frontend = {"epoch": "7", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
                operations = []
                broker.observer = SimpleNamespace(probe=lambda _operation: {
                    "admission": dict(frontend), "witness": {"operations": copy.deepcopy(operations)}})
                observed = []

                def gateway():
                    stored = json.loads(path.read_bytes())
                    admission = {**stored, "valid": True, "sha256": window._hash(path.read_bytes()),
                                 "active": dict(window._ZERO), "uncertain": dict(window._ZERO)}
                    if stored["version"] == 3:
                        admission.pop("interactive")
                        admission.update(valid=False, newWork=None, recovery=None, interactiveActive=True,
                                         interactiveEvidence={"admitted": len(observed), "acknowledged": copy.deepcopy(observed)})
                    return {"processSha256": "d" * 64, "gatewayConfigurationSha256": "e" * 64,
                            "admissionDirectory": {"device": str(broker.admission_identity.st_dev),
                                                   "inode": str(broker.admission_identity.st_ino)},
                            "faultLeasePresent": False, "admission": admission}

                broker._gateway_observation = gateway
                with patch.object(window.os, "geteuid", return_value=0):
                    stage = window.P2InteractiveWindow(broker)
                stage._mount = lambda: (fd, broker.admission_identity)

                def read_projecting_root_ownership():
                    mode = stat.S_IMODE(path.stat().st_mode)
                    return path.read_bytes(), mode, 65532 if mode == 0o640 else 0

                stage._read = read_projecting_root_ownership
                with patch.object(window.os, "fchown") as chown, \
                     patch.object(window.ingress, "observe_learning_protection", return_value={"status": "owned-protection"}) as protect, \
                     patch.object(window.native, "observe_metadata", return_value={"nativeEnabled": False}), \
                     patch.object(window.time, "time", return_value=1_794_009_600) as wall:
                    self.assertEqual(stage.prepare()["status"], "owned-protection")
                    self.assertEqual(protect.call_args.kwargs, {"course_id": course, "slug": "owned-course"})
                    opened = stage.open_gateway()
                    self.assertEqual(opened, {"stage": "learning", "epoch": "8", "expiresAt": "2026-11-07T00:01:30.000Z",
                                              "gatewayScoped": True})
                    installed = json.loads(path.read_bytes())["interactive"]
                    self.assertEqual(installed["actorId"], actor)
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
                    self.assertEqual(chown.call_args.args[1:], (0, 65532))
                    with self.assertRaisesRegex(ValueError, "FRONTEND_WINDOW"):
                        stage.take_private_browser_permit()
                    frontend.update(epoch="8", newWork=True, recovery=True)
                    permit = stage.take_private_browser_permit()
                    self.assertTrue(permit["cookie"].startswith("v2.8.learning.1794009600.1794009690."))
                    self.assertEqual(permit["cookie"].split(".")[6], (actor + key).replace("-", ""))
                    self.assertNotIn(permit["cookie"], path.read_text())
                    self.assertNotIn(installed["key"], repr(opened))
                    with self.assertRaisesRegex(ValueError, "PERMIT_NOT_AVAILABLE"):
                        stage.take_private_browser_permit()
                    with self.assertRaisesRegex(ValueError, "COMPLETE_GATEWAY_EFFECTS"):
                        stage.collect_gateway_effects()
                    observed.extend({"requestId": f"20000000-0000-4000-8000-{index:012d}",
                                     "proofRequestId": f"30000000-0000-4000-8000-{index:012d}",
                                     "requestIndex": request_index, "upstreamStatus": status}
                                    for index, (request_index, status) in enumerate(((0, 200), (1, 403), (2, 201), (1, 200), (3, 200)), 1))
                    self.assertEqual(stage.collect_gateway_effects(), observed)
                    receipt = stage.observe_browser_gateway()
                    self.assertEqual(receipt["status"], "P2_INTERACTIVE_LEARNING_GATEWAY_OBSERVED")
                    self.assertEqual(receipt["gatewayAcknowledgements"], observed)
                    wall.return_value = 1_794_009_691
                    with self.assertRaisesRegex(ValueError, "EFFECT_ORDER"):
                        stage.collect_gateway_effects()
                    stage.fence_gateway()
                    self.assertEqual(stage.verify_gateway_fenced(),
                                     {"gatewayAdmissionClosed": True, "gatewayActive": 0, "gatewayUncertain": 0})
                    with self.assertRaisesRegex(ValueError, "FRONTEND_DRAIN"):
                        stage.verify_fenced()
                    frontend.update(epoch="9", newWork=False, recovery=False, uncertain=1)
                    with self.assertRaisesRegex(ValueError, "FRONTEND_DRAIN"):
                        stage.verify_fenced()
                    frontend["uncertain"] = 0
                    operations.append({"state": "completed", "reconciliation_sha256": "f" * 64})
                    with self.assertRaisesRegex(ValueError, "FRONTEND_DRAIN"):
                        stage.verify_fenced()
                    operations[0]["reconciliation_sha256"] = None
                    self.assertEqual(stage.verify_fenced()["frontendAdmission"], frontend)
                    self.assertEqual(stage.verify_fenced()["frontendOperationCount"], 1)
                    self.assertEqual(path.read_bytes(), raw)
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
