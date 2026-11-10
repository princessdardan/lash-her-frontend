"""Owned provider/TLS fixtures; no staging or credential access."""
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import ssl
import stat
import subprocess
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


class FirstOwnerWindowTests(unittest.TestCase):
    def test_first_owner_selection_never_opens_the_gateway(self):
        owner = {"nonce": "9" * 32, "identitySha256": "6" * 64}
        action = {"stage": "identity", "actorId": None, "requests": [], "windowSeconds": 120, "firstOwner": owner}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        cookie, gateway_key, _, _ = window._material("s" * 40, "https://owned.vercel.app", "a" * 40,
            "b" * 64, "8", "identity", 1794009600, 120, owner["nonce"], selector)
        self.assertIsNone(gateway_key)
        self.assertEqual(cookie.split(".")[5:7], [owner["nonce"], "a3" + "6" * 62])
        for rejected in ({**action, "actorId": "12345678-1234-4123-8123-000000000001"},
                         {**action, "identityActor": {"actorKind": "admin"}},
                         {**action, "firstOwner": {**owner, "nonce": "0" * 32}},
                         {**action, "requests": [{}]}):
            with self.assertRaises(ValueError):
                window.validate_interactive_action(rejected)

    def test_first_owner_join_requires_exact_actor_and_completed_sign_in_and_materialization(self):
        actor = {"actorKind": "admin", "actorId": "12345678-1234-4123-8123-000000000001"}
        plan = {"mode": "interactive-browser", "sourceCommit": "a" * 40, "targetSha256": "b" * 64,
                "initialEpoch": "7", "nativePlan": {"producer": {"role": {"oid": "42"}}},
                "scopedAction": {"stage": "identity", "actorId": None, "requests": [], "windowSeconds": 120,
                                 "firstOwner": {"nonce": "9" * 32, "identitySha256": "6" * 64}}}
        evidence = {"browserIdentity": {**actor, "sessionVerified": True},
                    "identityWitness": {**actor, "actorActive": True, "ownerMappingVerified": True, "firstOwnerVerified": True}}
        self.assertEqual(window.browser_case_evidence(plan, evidence)["actorId"], actor["actorId"])
        for fields in ({"firstOwnerVerified": False}, {"actorKind": "customer"}, {"actorId": "foreign"}):
            with self.assertRaises(ValueError):
                window.browser_case_evidence(plan, {**evidence, "identityWitness": {**evidence["identityWitness"], **fields}})
        producer = hashlib.sha256(("lash-her:p2q:interactive-producer:v1\n" + "a" * 40 + "\n" + "b" * 64).encode()).hexdigest()
        ledger = {"commands": [], "deliveries": [], "orderViolations": [], "operations": [
            {"id": f"12345678-1234-4123-8123-{index:012d}", "epoch": "8", "kind": kind, "state": "completed",
             "producer_sha256": producer, "source_sha": "a" * 40, "role_oid": "42", "completed_at": "owned",
             "reconciliation_sha256": None}
            for index, kind in enumerate(("new-work", "recovery", "recovery", "new-work"), start=1)]}
        self.assertEqual(window.require_browser_ledger(plan, ledger), 4)
        with self.assertRaisesRegex(ValueError, "FIRST_OWNER_OPERATIONS_REQUIRED"):
            window.require_browser_ledger(plan, {**ledger, "operations": ledger["operations"][:-1]})


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

    def owned_unauthenticated_requester(self, *, progress_lesson_id=None, flight_paths=()):
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
                flight = url.path in flight_paths and url.query == "_rsc"
                expected_query = f"lessonId={progress_lesson_id}" if progress_lesson_id and url.path == "/api/academy/progress" else ""
                self.assertEqual(url.query, "_rsc" if flight else expected_query)
                self.assertEqual(url.fragment, "")
                self.assertEqual(request.method, "GET")
                self.assertIsNone(request.data)
                expected_headers = {"accept", "cache-control"}
                if flight:
                    expected_headers.add("rsc")
                    self.assertEqual(request.get_header("Rsc"), "1")
                    self.assertEqual(request.get_header("Accept"), "text/x-component")
                self.assertEqual({name.lower() for name, _ in request.header_items()}, expected_headers)
                urls.append(request.full_url)
                target = url.path + (f"?{url.query}" if url.query else "")
                mapped = urllib.request.Request(self.fixture.origin + target, headers=dict(request.header_items()), method="GET")
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

    def test_media_probes_only_reviewed_course_status_and_reservation_paths(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        paths = (f"/admin/courses/{course}", f"/api/admin/lessons/{lesson}/video", f"/api/admin/lessons/{lesson}/video-upload")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "MEDIA_PROTECTION_SELECTION_REQUIRED"):
                ingress.observe_media_protection(self.base.context, self.fixture.client, expected_profile=self.profile,
                                                 course_id=course, lesson_id=lesson + "/refresh")
            receipt = ingress.observe_media_protection(self.base.context, self.fixture.client, expected_profile=self.profile,
                                                       course_id=course, lesson_id=lesson)
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], list(paths))
        self.assertEqual(receipt["requestMethod"], "GET")
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

    def test_learner_access_probes_exact_course_and_lesson_paths_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        path = f"/api/academy/lessons/{lesson}"
        paths = (f"/academy/courses/{course}", f"/api/academy/courses/{course}", path, f"{path}/playback",
                 f"/api/academy/progress?lessonId={lesson}", f"{path}/quiz", f"{path}/quiz/attempts")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester(progress_lesson_id=lesson)
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LEARNER_ACCESS_TARGET_REQUIRED"):
                ingress.observe_learner_access_protection(self.base.context, self.fixture.client, course_id=course,
                    lesson_id=f"{lesson}?unreviewed=yes", expected_profile=self.profile)
            receipt = ingress.observe_learner_access_protection(self.base.context, self.fixture.client, course_id=course,
                                                                lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual([row["path"] for row in receipt["endpointDenials"]], list(paths))
        self.assertEqual(urls, [origin + target for target in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_lesson_denial_probes_exact_document_flight_and_api_paths_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        document = f"/academy/courses/{course}/lessons/{lesson}"
        api_lesson = f"/api/academy/lessons/{lesson}"
        progress = f"/api/academy/progress?lessonId={lesson}"
        paths = (document, f"{document}?_rsc", api_lesson, f"{api_lesson}/playback", progress,
                 f"{api_lesson}/quiz", f"{api_lesson}/quiz/attempts")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester(progress_lesson_id=lesson, flight_paths=(document,))
        for path in (f"{document}?_rsc=unused", f"{document}?_rsc&other=1", f"{api_lesson}?_rsc", f"{progress}&_rsc"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "INGRESS_PATH_REFUSED"):
                requester.request(canonical.ORIGIN, path)
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LESSON_DENIAL_TARGET_REQUIRED"):
                ingress.observe_lesson_denial_protection(self.base.context, self.fixture.client, course_id=course,
                                                         lesson_id=f"{lesson}?_rsc", expected_profile=self.profile)
            receipt = ingress.observe_lesson_denial_protection(self.base.context, self.fixture.client, course_id=course,
                                                                 lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_assessment_probes_only_exact_document_and_api_paths_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        api = f"/api/academy/lessons/{lesson}"
        paths = (f"/academy/courses/{course}/lessons/{lesson}", f"{api}/playback", f"/api/academy/progress?lessonId={lesson}",
                 f"{api}/progress", f"{api}/quiz/attempts")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester(progress_lesson_id=lesson)
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LESSON_ASSESSMENT_TARGET_REQUIRED"):
                ingress.observe_lesson_assessment_protection(self.base.context, self.fixture.client, course_id=course,
                                                             lesson_id=f"{lesson}?other=1", expected_profile=self.profile)
            receipt = ingress.observe_lesson_assessment_protection(self.base.context, self.fixture.client, course_id=course,
                                                                     lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual(receipt["requestMethod"], "GET")
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + target for target in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_restore_probes_the_selected_document_flight_and_api_routes_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        document = f"/academy/courses/{course}/lessons/{lesson}"
        api = f"/api/academy/lessons/{lesson}"
        paths = (document, f"{document}?_rsc", api, f"{api}/playback", f"/api/academy/progress?lessonId={lesson}",
                 f"{api}/progress", f"{api}/quiz", f"{api}/quiz/attempts")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester(progress_lesson_id=lesson, flight_paths=(document,))
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LESSON_RESTORE_TARGET_REQUIRED"):
                ingress.observe_lesson_restore_protection(self.base.context, self.fixture.client, course_id=course,
                                                           lesson_id=f"{lesson}?other=1", expected_profile=self.profile)
            receipt = ingress.observe_lesson_restore_protection(self.base.context, self.fixture.client, course_id=course,
                                                                 lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_exit_save_probes_both_documents_and_flights_with_get_only(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        outline = f"/academy/courses/{course}"
        document = f"{outline}/lessons/{lesson}"
        api = f"/api/academy/lessons/{lesson}"
        paths = (outline, f"{outline}?_rsc", document, f"{document}?_rsc", api, f"{api}/playback",
                 f"/api/academy/progress?lessonId={lesson}", f"{api}/progress", f"{api}/quiz", f"{api}/quiz/attempts")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester(progress_lesson_id=lesson, flight_paths=(outline, document))
        for path in (f"{outline}?_rsc=unused", f"{outline}?_rsc&other=1"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "INGRESS_PATH_REFUSED"):
                requester.request(canonical.ORIGIN, path)
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LESSON_EXIT_SAVE_TARGET_REQUIRED"):
                ingress.observe_lesson_exit_save_protection(self.base.context, self.fixture.client, course_id=f"{course}?_rsc",
                                                           lesson_id=lesson, expected_profile=self.profile)
            receipt = ingress.observe_lesson_exit_save_protection(self.base.context, self.fixture.client, course_id=course,
                                                                 lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual(receipt["requestMethod"], "GET")
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + path for path in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
        self.assertEqual(self.fixture.responses, [])

    def test_resume_probes_only_selected_document_playback_and_progress_on_both_origins(self):
        course = "10000000-0000-4000-8000-000000000001"
        lesson = "10000000-0000-4000-8000-000000000002"
        api = f"/api/academy/lessons/{lesson}"
        paths = (f"/academy/courses/{course}/lessons/{lesson}", f"{api}/playback", f"{api}/progress")
        self.enqueue_selected_protection(paths)
        requester, urls = self.owned_unauthenticated_requester()
        with patch.object(ingress, "UnauthenticatedIngressClient", return_value=requester):
            with self.assertRaisesRegex(ValueError, "LESSON_RESUME_TARGET_REQUIRED"):
                ingress.observe_lesson_resume_protection(self.base.context, self.fixture.client, course_id=course,
                                                         lesson_id=f"{lesson}?other=1", expected_profile=self.profile)
            receipt = ingress.observe_lesson_resume_protection(self.base.context, self.fixture.client, course_id=course,
                                                               lesson_id=lesson, expected_profile=self.profile)
        self.assertEqual(receipt["requestMethod"], "GET")
        self.assertEqual(receipt["endpointDenials"], [
            {"path": path, "aliasUnauthenticatedStatus": 401, "deploymentUnauthenticatedStatus": 403} for path in paths
        ])
        self.assertEqual(urls, [origin + target for target in paths for origin in (canonical.ORIGIN, self.base.plan["deploymentUrl"])])
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


class MediaReservationWindowTests(unittest.TestCase):
    def fixture(self, *, replaces=False):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile

        def uuid(index):
            return f"10000000-0000-4000-8000-{index:012d}"

        actor, course, lesson, attempt, current = [uuid(index) for index in range(1, 6)]
        prior = current if replaces else None
        selected = {"operation": "reserve-video-upload", "courseId": course, "lessonId": lesson, "revision": 6,
                    "currentVideoAssetId": prior, "fileSha256": "f" * 64, "fileBytes": 1200, "contentType": "video/mp4"}
        body = json.dumps({"expectedCourseRevision": 6, "expectedCurrentVideoAssetId": prior}, separators=(",", ":")).encode()
        path = f"/course/v1/admin/lessons/{lesson}"
        requests = [
            {"method": "GET", "target": f"/course/v1/admin/courses/{course}", "uses": 1, "bodySha256": window._EMPTY},
            {"method": "GET", "target": f"{path}/video", "uses": 1, "bodySha256": window._EMPTY},
            {"method": "POST", "target": f"{path}/video-upload", "uses": 1, "bodySha256": window._hash(body)},
        ]
        plan = {"qualificationTargetProfile": dict(profile), "planSha256": "c" * 64, "certificationActionId": "owned-media",
                "initialEpoch": "7", "sourceCommit": "a" * 40, "targetSha256": "b" * 64,
                "nativePlan": {"producer": {"role": {"oid": "42"}}},
                "scopedAction": {"stage": "media", "actorId": actor, "windowSeconds": 60, "requests": requests,
                                 "mediaAction": selected}}
        gateway = {**window.browser_receipt(plan, "GATEWAY_OBSERVED"), "epoch": "8", "gatewayStateSha256": "d" * 64,
                   "gatewayActive": 0, "gatewayUncertain": 0,
                   "gatewayAcknowledgements": [{"requestIndex": index, "upstreamStatus": status, "requestId": uuid(10 + index),
                                                "proofRequestId": uuid(20 + index)} for index, status in enumerate((200, 200, 201))]}
        evidence = {
            "browserResponse": {
                "page": {"pathname": f"/admin/courses/{course}", "status": 200},
                "read": {"requestId": uuid(11), "courseRevision": 6, "currentVideoAssetId": prior},
                "reservation": {"requestId": uuid(12), "status": 200, "assetId": attempt, "lessonId": lesson,
                                "uploadId": "owned-upload", "uploadTimeoutSeconds": 3600, "assetStatus": "uploading"},
                "outbound": {"intercepted": True, "sent": False, **{key: selected[key] for key in ("fileSha256", "fileBytes", "contentType")}},
            },
            "courseWitness": {"courseId": course, "lessonId": lesson, "courseRevision": 7, "attemptId": attempt,
                              "uploadId": "owned-upload", "generation": 2 if replaces else 1, "environmentId": "owned-environment",
                              "status": "uploading", "isCurrent": not replaces, "readOnly": True},
        }
        return plan, gateway, evidence

    def test_exact_scope_signs_selected_actor_course_and_lesson(self):
        for replaces in (False, True):
            with self.subTest(replaces=replaces):
                plan, _, _ = self.fixture(replaces=replaces)
                action = plan["scopedAction"]
                self.assertEqual(window.validate_interactive_plan_action(plan), action)
                selected = action["mediaAction"]
                selector = window._selection_sha(action)
                self.assertEqual(selector, (action["actorId"] + selected["courseId"] + selected["lessonId"]).replace("-", ""))
                cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40,
                    "b" * 64, "8", "media", 1_794_009_600, 60, "c" * 32, selector)
                self.assertEqual(cookie.split(".")[:3], ["v2", "8", "media"])
                self.assertEqual(cookie.split(".")[6], selector)
                self.assertEqual(len(gateway_key), 64)
                for change in ({"revision": True}, {"fileBytes": 8 * 1024 * 1024 + 1}, {"contentType": "video/webm"},
                               {"fileSha256": "0" * 64}, {"currentVideoAssetId": ""}):
                    with self.assertRaisesRegex(ValueError, "MEDIA_SELECTION_REQUIRED"):
                        window.validate_interactive_action({**action, "mediaAction": {**selected, **change}})
                for index, change in ((0, {"uses": 2}), (1, {"target": action["requests"][1]["target"] + "/refresh"}),
                                      (2, {"bodySha256": window._EMPTY})):
                    requests = copy.deepcopy(action["requests"])
                    requests[index].update(change)
                    with self.assertRaisesRegex(ValueError, "MEDIA_REQUESTS_REQUIRED"):
                        window.validate_interactive_action({**action, "requests": requests})

    def test_media_evidence_joins_two_gateway_ids_and_managed_course_row(self):
        for replaces in (False, True):
            with self.subTest(replaces=replaces):
                plan, gateway, evidence = self.fixture(replaces=replaces)
                joined = window.browser_case_evidence(plan, evidence, gateway_artifact=gateway)
                self.assertEqual(joined["courseRevision"], 7)
                self.assertIs(joined["isCurrent"], not replaces)
                self.assertIs(joined["uploadSent"], False)
                self.assertEqual(joined["gatewayPostRequestId"], gateway["gatewayAcknowledgements"][2]["requestId"])
                for key, changes, error in (
                    ("read", {"requestId": gateway["gatewayAcknowledgements"][0]["requestId"]}, "MEDIA_REQUEST_JOIN_REQUIRED"),
                    ("reservation", {"status": 201}, "MEDIA_RESERVATION_REQUIRED"),
                    ("reservation", {"uploadUrl": "fixture-forbidden"}, "MEDIA_RESERVATION_REQUIRED"),
                    ("outbound", {"sent": True}, "MEDIA_INTERCEPTION_REQUIRED"),
                    ("outbound", {"fileBytes": True}, "MEDIA_INTERCEPTION_REQUIRED"),
                ):
                    changed = copy.deepcopy(evidence)
                    changed["browserResponse"][key].update(changes)
                    with self.assertRaisesRegex(ValueError, error):
                        window.browser_case_evidence(plan, changed, gateway_artifact=gateway)
                for change in ({"courseRevision": 6}, {"uploadId": "foreign"}, {"isCurrent": replaces},
                               {"environmentId": "foreign.invalid"}, {"generation": True}, {"readOnly": 1}):
                    changed = {**evidence, "courseWitness": {**evidence["courseWitness"], **change}}
                    with self.assertRaisesRegex(ValueError, "MEDIA_COURSE_WITNESS_REQUIRED"):
                        window.browser_case_evidence(plan, changed, gateway_artifact=gateway)
                altered = copy.deepcopy(gateway)
                altered["gatewayAcknowledgements"][2]["upstreamStatus"] = 200
                with self.assertRaisesRegex(ValueError, "MEDIA_ACKNOWLEDGEMENTS_REQUIRED"):
                    window.browser_case_evidence(plan, evidence, gateway_artifact=altered)

    def test_media_ledger_requires_exact_three_completed_new_work_operations(self):
        plan, _, _ = self.fixture()
        producer = hashlib.sha256(("lash-her:p2q:interactive-producer:v1\n" + "a" * 40 + "\n" + "b" * 64).encode()).hexdigest()
        ledger = {"commands": [], "deliveries": [], "orderViolations": [], "operations": [
            {"id": f"10000000-0000-4000-8000-{index:012d}", "epoch": "8", "kind": kind, "state": "completed",
             "producer_sha256": producer, "source_sha": "a" * 40, "role_oid": "42", "completed_at": "owned",
             "reconciliation_sha256": None}
            for index, kind in enumerate(("recovery", "new-work", "new-work", "new-work"), start=1)]}
        self.assertEqual(window.require_browser_ledger(plan, ledger), 4)
        with self.assertRaisesRegex(ValueError, "MEDIA_THREE_NEW_WORK_REQUIRED"):
            window.require_browser_ledger(plan, {**ledger, "operations": ledger["operations"][:-1]})

    def test_host_reads_selected_course_only_after_fencing_and_refuses_environment_drift(self):
        plan, _, evidence = self.fixture(replaces=True)
        stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
        stage.action, stage._state, stage._permit_issued = plan["scopedAction"], "opened", True
        browser, witness = evidence["browserResponse"], evidence["courseWitness"]
        image = "owned-course-image"
        target = {"host": "owned.invalid", "port": 5432, "database": "owned_course", "user": "owned_migration", "serverMajor": 18}
        events = []
        stage.verify_gateway_fenced = lambda: events.append("closed")

        def run(args, **kwargs):
            events.append(args[1])
            self.assertNotIn("owned-credential", " ".join(args))
            self.assertNotIn("owned-credential", kwargs["env"].values())
            if args[1] == "run":
                self.assertEqual(args[-4:], [image, "--input-type=module", "--eval", window._MEDIA_COURSE_READ])
                self.assertIn("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", args[-1])
                self.assertEqual(json.loads(kwargs["input"]), {"connectionUrl": "owned-credential", "target": target,
                    "courseId": witness["courseId"], "lessonId": witness["lessonId"], "attemptId": witness["attemptId"],
                    "priorCurrentId": browser["read"]["currentVideoAssetId"]})
                return subprocess.CompletedProcess(args, 0, json.dumps(witness).encode(), b"")
            return subprocess.CompletedProcess(args, 0, b"", b"")

        with tempfile.TemporaryDirectory() as temporary:
            configuration = Path(temporary)
            config = b"MUX_ENVIRONMENT_ID=owned-environment\n"
            (configuration / "course-api.env").write_bytes(config)
            stage.broker = SimpleNamespace(configuration=configuration, api_proof=object(),
                selected={"artifacts": {"courseMigration": {"image": image}}}, scope=SimpleNamespace(run=run),
                jobs={"course": {"job": {"target": target}, "image": image}},
                certification_profile=lambda: plan["qualificationTargetProfile"],
                initial={"configurationSha256": {"course-api.env": window._hash(config)},
                         "credentials": {"COURSE_STAGING_DATABASE_URL": "owned-credential"}})
            with (patch("current_databases.read_certification_api_proof") as proof,
                  patch.object(window.runtime, "environment_values", return_value={"MUX_ENVIRONMENT_ID": "owned-environment"}) as environment):
                with self.assertRaisesRegex(ValueError, "MEDIA_FENCED_OBSERVATION_REQUIRED"):
                    stage.observe_media_reservation(browser)
                self.assertEqual(events, [])
                proof.assert_not_called()
                stage._state = "fenced"
                self.assertEqual(stage.observe_media_reservation(browser), witness)
                self.assertEqual(events, ["closed", "run", "rm", "container", "closed"])
                proof.assert_called_once()
                witness["environmentId"] = "foreign-environment"
                with self.assertRaisesRegex(ValueError, "MEDIA_COURSE_ENVIRONMENT_CHANGED"):
                    stage.observe_media_reservation(browser)
                environment.return_value = {}
                before = len(events)
                with self.assertRaisesRegex(ValueError, "MEDIA_COURSE_ENVIRONMENT_REQUIRED"):
                    stage.observe_media_reservation(browser)
                self.assertEqual(events[before:], ["closed"])


class InteractiveWindowTests(unittest.TestCase):
    def test_paid_revoke_plan_binds_exact_scope_and_uses_normal_owner_preflight(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        user = "10000000-0000-4000-8000-000000000003"
        grant = "10000000-0000-4000-8000-000000000004"
        key = "10000000-0000-4000-8000-000000000005"
        entitlements = "/course/v1/admin/entitlements"
        requests = [
            {"method": "GET", "target": f"/course/v1/admin/courses/{course}", "bodySha256": window._EMPTY, "uses": 3},
            {"method": "GET", "target": f"{entitlements}/commands?idempotencyKey=owner-paid-revoke%3A{key}&limit=2",
             "bodySha256": window._EMPTY, "uses": 2},
            {"method": "GET", "target": f"{entitlements}/grants?grantId={grant}&userId={user}&courseId={course}&limit=2",
             "bodySha256": window._EMPTY, "uses": 2},
            {"method": "POST", "target": f"{entitlements}/revocations", "bodySha256": "b" * 64, "uses": 1}]
        selection = {"operation": "revoke-paid-grant", "courseId": course, "userId": user, "grantId": grant,
                     "revision": 2_147_483_647, "idempotencyKey": key, "reasonSha256": "d" * 64, "remainingAccess": True}
        action = {"stage": "paid-revoke", "actorId": owner, "windowSeconds": 60, "requests": requests, "paidRevokeAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, (owner + key).replace("-", ""))
        cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                       "8", "paid-revoke", 1_794_009_600, 60, "c" * 32, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "paid-revoke"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        for change in ({"remainingAccess": 1}, {"reasonSha256": window._EMPTY}, {"grantId": "bad"},
                       {"revision": True}, {"revision": 2_147_483_648}):
            with self.subTest(selection=change), self.assertRaisesRegex(ValueError, "PAID_REVOKE_SELECTION_REQUIRED"):
                window.validate_interactive_action({**action, "paidRevokeAction": {**selection, **change}})
        for index, change in ((0, {"uses": 2}), (1, {"target": requests[1]["target"].replace("%3A", "%3a")}),
                              (2, {"target": requests[2]["target"].replace(grant, owner)}), (3, {"bodySha256": window._EMPTY})):
            changed = [*requests]
            changed[index] = {**changed[index], **change}
            with self.subTest(request=change), self.assertRaisesRegex(ValueError, "PAID_REVOKE_REQUESTS_REQUIRED"):
                window.validate_interactive_action({**action, "requests": changed})
        stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
        stage.action, stage.plan, stage._state, stage._check = action, {"initialEpoch": "7"}, "new", lambda: None
        raw = b"owned ordinary state"
        stage._read = lambda: (raw, 0o644, 0)
        stage._gateway = lambda: {"version": 1, "valid": True, "newWork": False, "recovery": False,
                                  "active": window._ZERO, "uncertain": window._ZERO, "sha256": window._hash(raw),
                                  "releaseId": "owned-release", "candidateSha256": "a" * 64}
        stage.broker = SimpleNamespace(
            observer=SimpleNamespace(probe=lambda _: {"admission": {"epoch": "7", "newWork": False, "recovery": False,
                                                                        "active": 0, "uncertain": 0}}),
            _native_context=lambda: {}, vercel=object(), check=lambda: None, profile_arguments=lambda: {},
            selected={"releaseId": "owned-release"}, initial={"candidateSha256": "a" * 64})
        with patch.object(ingress, "observe_paid_grant_protection", return_value={"status": "owned-owner-protection"}) as protection:
            self.assertEqual(stage.prepare()["status"], "owned-owner-protection")
        self.assertEqual(protection.call_args.kwargs, {"course_id": course})

    def test_learner_access_plan_signs_only_the_exact_reviewed_get_scope(self):
        actor = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        lesson = "10000000-0000-4000-8000-000000000003"
        grant = "10000000-0000-4000-8000-000000000004"
        path = f"/course/v1/student/lessons/{lesson}"
        targets = (f"/course/v1/student/courses/{course}", f"/course/v1/student/progress?courseId={course}",
                   path, f"{path}/playback", f"/course/v1/student/progress?lessonId={lesson}", f"{path}/quiz", f"{path}/quiz/attempts")
        requests = [{"method": "GET", "target": target, "bodySha256": window._EMPTY, "uses": 2 if index == 0 else 1}
                    for index, target in enumerate(targets)]
        selection = {"operation": "observe-paid-access", "courseId": course, "lessonId": lesson, "grantId": grant,
                     "revision": 2_147_483_647, "outcome": "restricted"}
        action = {"stage": "learner-access", "actorId": actor, "windowSeconds": 60, "requests": requests, "learnerAccessAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, (actor + lesson).replace("-", ""))
        cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                       "8", "learner-access", 1_794_009_600, 60, "c" * 32, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "learner-access"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        for change in ({"outcome": "published"}, {"outcome": []}, {"grantId": "bad"}, {"revision": True}, {"revision": 2_147_483_648}):
            with self.subTest(selection=change), self.assertRaisesRegex(ValueError, "LEARNER_ACCESS_SELECTION_REQUIRED"):
                window.validate_interactive_action({**action, "learnerAccessAction": {**selection, **change}})
        for index, change in ((0, {"uses": 1}), (4, {"target": targets[4] + "&limit=2"}),
                              (6, {"method": "POST"}), (3, {"bodySha256": "b" * 64})):
            changed = [*requests]
            changed[index] = {**changed[index], **change}
            with self.subTest(request=change), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "requests": changed})

    def test_lesson_entry_binds_course_lesson_and_exact_progress_write(self):
        actor, course, lesson, grant = (f"10000000-0000-4000-8000-{index:012d}" for index in range(1, 5))
        student = "/course/v1/student"
        lesson_path = f"{student}/lessons/{lesson}"
        targets = (f"{student}/courses/{course}", f"{student}/progress?courseId={course}", lesson_path,
                   f"{student}/progress?lessonId={lesson}", f"{lesson_path}/quiz", f"{lesson_path}/quiz/attempts",
                   f"{lesson_path}/playback")
        requests = [{"method": "GET", "target": target, "bodySha256": window._EMPTY, "uses": 2 if index == 0 else 1}
                    for index, target in enumerate(targets)]
        requests.append({"method": "POST", "target": f"{lesson_path}/progress",
                         "bodySha256": window._hash(b'{"event":"lesson_started","expectedProgressRevision":0}'), "uses": 1})
        selection = {"operation": "open-lesson", "courseId": course, "lessonId": lesson, "grantId": grant}
        action = {"stage": "lesson-entry", "actorId": actor, "windowSeconds": 60, "requests": requests,
                  "lessonEntryAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, (actor + course + lesson).replace("-", ""))
        material = ("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                    "8", "lesson-entry", 1_794_009_600, 60, "c" * 32)
        cookie, gateway_key, _, _ = window._material(*material, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "lesson-entry"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        with self.assertRaisesRegex(ValueError, "FRONTEND_BINDING_REQUIRED"):
            window._material(*material, selector[:64])
        for index, change in ((0, {"uses": 1}), (3, {"target": f"{student}/progress?courseId={lesson}"}),
                              (6, {"target": f"{lesson_path}/playback/renew"}), (7, {"bodySha256": "f" * 64})):
            changed = [*requests]
            changed[index] = {**changed[index], **change}
            with self.subTest(request=change), self.assertRaisesRegex(ValueError, "LESSON_ENTRY_REQUESTS_REQUIRED"):
                window.validate_interactive_action({**action, "requests": changed})
        for change in ({"operation": "record-progress"}, {"lessonId": actor}, {"grantId": "bad"}):
            with self.subTest(selection=change), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "lessonEntryAction": {**selection, **change}})

    def test_lesson_entry_ingress_checks_only_reviewed_paths(self):
        course, lesson = (f"10000000-0000-4000-8000-{index:012d}" for index in range(1, 3))
        context, client, profile = object(), object(), object()
        with patch.object(ingress, "_observe_selected_protection", return_value={"status": "guarded"}) as protect:
            self.assertEqual(ingress.observe_lesson_entry_protection(context, client, expected_profile=profile,
                                                                     course_id=course, lesson_id=lesson), {"status": "guarded"})
        academy = f"/academy/courses/{course}"
        api_lesson = f"/api/academy/lessons/{lesson}"
        protect.assert_called_once_with(context, client, profile, browser=True, paths=(
            academy, f"{academy}/lessons/{lesson}", f"/api{academy}", f"/api/academy/progress?courseId={course}",
            api_lesson, f"/api/academy/progress?lessonId={lesson}", f"{api_lesson}/quiz", f"{api_lesson}/quiz/attempts",
            f"{api_lesson}/playback", f"{api_lesson}/progress",
        ))
        with self.assertRaisesRegex(ValueError, "LESSON_ENTRY_TARGET_REQUIRED"):
            ingress.observe_lesson_entry_protection(context, client, expected_profile=profile, course_id=course,
                                                    lesson_id=f"{lesson}/quiz")

    def test_paid_republish_plan_binds_two_reviewed_transition_digests_and_dispositions(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        user = "10000000-0000-4000-8000-000000000003"
        grant = "10000000-0000-4000-8000-000000000004"
        detail = f"/course/v1/admin/courses/{course}"
        draft = {"method": "PATCH", "target": detail, "uses": 1,
                 "bodySha256": hashlib.sha256(b'{"expectedRevision":2147483645,"status":"draft"}').hexdigest()}
        publish = {"method": "PATCH", "target": detail, "uses": 1,
                   "bodySha256": hashlib.sha256(b'{"expectedRevision":2147483646,"status":"published"}').hexdigest()}
        for outcome, codes, prefix in (("published", [], "7032712d617574682d7265702d763100"),
                                       ("blocked", ["MISSING_COVER", "NO_LESSONS"], "7032712d617574682d72626c2d763100")):
            published = outcome == "published"
            requests = [{"method": "GET", "target": detail, "bodySha256": window._EMPTY, "uses": 3 if published else 2},
                        draft, {"method": "GET", "target": f"{detail}/publication-readiness", "bodySha256": window._EMPTY, "uses": 1}]
            if published:
                requests.append(publish)
            selection = {"operation": "republish-paid-course", "courseId": course, "slug": "owned-course",
                         "revision": 2_147_483_645, "userId": user, "grantId": grant, "outcome": outcome,
                         "issueCodes": codes, "expectedAccess": True}
            action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": requests, "authoringAction": selection}
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = window._selection_sha(action)
            self.assertEqual(selector, prefix + owner.replace("-", ""))
            cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                         "8", "authoring", 1_794_009_600, 60, "c" * 32, selector)
            self.assertEqual(cookie.split(".")[6], selector)
            self.assertEqual(len(gateway_key), 64)
            for change in ({"expectedAccess": 1}, {"revision": 2_147_483_646}, {"userId": "bad"},
                           {"grantId": "bad"}, {"issueCodes": ["bad"]}):
                with self.subTest(outcome=outcome, selection=change), self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
            bad_draft = [requests[0], {**draft, "bodySha256": "c" * 64}, *requests[2:]]
            with self.assertRaisesRegex(ValueError, "REPUBLISH_DIGEST_REQUIRED"):
                window.validate_interactive_action({**action, "requests": bad_draft})
            if published:
                bad_publish = [*requests[:3], {**publish, "bodySha256": "c" * 64}]
                with self.assertRaisesRegex(ValueError, "REPUBLISH_DIGEST_REQUIRED"):
                    window.validate_interactive_action({**action, "requests": bad_publish})
            else:
                with self.assertRaises(ValueError):
                    window.validate_interactive_action({**action, "requests": [*requests, publish]})

    def test_paid_archive_plan_binds_selected_grant_and_exact_archive_patch(self):
        owner = "10000000-0000-4000-8000-000000000001"
        course = "10000000-0000-4000-8000-000000000002"
        user = "10000000-0000-4000-8000-000000000003"
        grant = "10000000-0000-4000-8000-000000000004"
        path = f"/course/v1/admin/courses/{course}"
        digest = hashlib.sha256(b'{"expectedRevision":2147483646,"status":"archived"}').hexdigest()
        read = {"method": "GET", "target": path, "bodySha256": window._EMPTY, "uses": 2}
        patch = {"method": "PATCH", "target": path, "bodySha256": digest, "uses": 1}
        selection = {"operation": "archive-paid-course", "courseId": course, "slug": "owned-course",
                     "revision": 2_147_483_646, "userId": user, "grantId": grant}
        action = {"stage": "authoring", "actorId": owner, "windowSeconds": 60, "requests": [read, patch], "authoringAction": selection}
        self.assertEqual(window.validate_interactive_action(action), action)
        selector = window._selection_sha(action)
        self.assertEqual(selector, "7032712d617574682d6172632d763100" + owner.replace("-", ""))
        cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                       "8", "authoring", 1_794_009_600, 60, "c" * 32, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "authoring"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        for change in ({"grantId": "invalid"}, {"userId": "invalid"}, {"revision": False}, {"revision": 2_147_483_647}):
            with self.subTest(selection=change), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "authoringAction": {**selection, **change}})
        for changed in ([{**read, "uses": 3}, patch], [read, {**patch, "method": "POST"}], [read, {**patch, "uses": 2}]):
            with self.subTest(requests=changed), self.assertRaises(ValueError):
                window.validate_interactive_action({**action, "requests": changed})
        wrong = hashlib.sha256(b'{"expectedRevision":2147483646,"status":"published"}').hexdigest()
        with self.assertRaisesRegex(ValueError, "ARCHIVE_DIGEST_REQUIRED"):
            window.validate_interactive_action({**action, "requests": [read, {**patch, "bodySha256": wrong}]})

    def test_free_replay_plan_preserves_key_selector_and_exact_request_budget(self):
        actor, course, key, grant, enrollment, event, stream = [
            f"10000000-0000-4000-8000-{index:012d}" for index in range(1, 8)]
        detail = f"/course/v1/student/courses/{course}"
        requests = [
            {"method": "GET", "target": detail, "bodySha256": window._EMPTY, "uses": 1},
            {"method": "GET", "target": f"/course/v1/student/progress?courseId={course}", "bodySha256": window._EMPTY, "uses": 1},
            {"method": "POST", "target": f"{detail}/enrollments", "bodySha256": window._receipt_sha({"idempotencyKey": key}), "uses": 1},
        ]
        prior = {"grantId": grant, "enrollmentId": enrollment, "eventId": event, "streamId": stream, "canonicalDigest": "5" * 64}
        selection = {"operation": "replay-free-enrollment", "courseId": course, "slug": "owned-course", "idempotencyKey": key, "prior": prior}
        action = {"stage": "learning", "actorId": actor, "windowSeconds": 60, "learningAction": selection, "requests": requests}
        self.assertEqual(window.validate_interactive_action(action), action)
        self.assertEqual(window._selection_sha(action), (actor + key).replace("-", ""))
        for change in ({"streamId": "invalid"}, {"canonicalDigest": "0" * 64}, {"streamVersion": 1}, {"grantId": None}):
            with self.subTest(prior=change), self.assertRaisesRegex(ValueError, "LEARNING_REPLAY_PRIOR_REQUIRED"):
                window.validate_interactive_action({**action, "learningAction": {**selection, "prior": {**prior, **change}}})
        for changed in (requests[::-1], [{**requests[0], "uses": 2}, *requests[1:]],
                        [*requests[:2], {**requests[2], "bodySha256": "4" * 64}]):
            with self.subTest(requests=changed), self.assertRaisesRegex(ValueError, "LEARNING_ENROLLMENT_REQUESTS_REQUIRED"):
                window.validate_interactive_action({**action, "requests": changed})

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
        second = {**action, "paidGrantAction": {**selection, "priorGrantId": "10000000-0000-4000-8000-000000000005"}}
        self.assertEqual(window.validate_interactive_action(second), second)
        self.assertEqual(window._selection_sha(second), selector)
        cookie, gateway_key, _, _ = window._material("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                                                       "8", "paid-grant", 1_794_009_600, 60, "c" * 32, selector)
        self.assertEqual(cookie.split(".")[:3], ["v2", "8", "paid-grant"])
        self.assertEqual(cookie.split(".")[6], selector)
        self.assertEqual(len(gateway_key), 64)
        with self.assertRaisesRegex(ValueError, "INTERACTIVE_ACTION_REQUIRED"):
            window.validate_interactive_action({name: value for name, value in action.items() if name != "paidGrantAction"})
        for change in ({"priorGrantId": "invalid"}, {"priorGrantId": None},
                       {"reasonSha256": window._EMPTY}, {"reasonSha256": "0" * 64}, {"revision": 0},
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
