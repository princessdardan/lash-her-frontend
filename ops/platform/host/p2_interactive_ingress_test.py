"""Owned provider/TLS fixtures; no staging or credential access."""
import copy
import hashlib
import json
import os
from pathlib import Path
import ssl
import stat
import tempfile
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
    def test_identity_permit_selects_authentication_family_with_no_gateway_write(self):
        actor_id = "10000000-0000-4000-8000-000000000001"
        raw = b'closed gateway fixture'
        gateway = {"version": 1, "valid": True, "newWork": False, "recovery": False, "active": window._ZERO,
                   "uncertain": window._ZERO, "releaseId": "owned", "candidateSha256": "a" * 64, "sha256": window._hash(raw)}
        for actor_kind in ("admin", "customer"):
            with self.subTest(actor_kind=actor_kind):
                action = {"stage": "identity", "actorId": None, "identityActor": {"actorKind": actor_kind, "actorId": actor_id},
                          "windowSeconds": 60, "requests": []}
                for changed in ({**action, "actorId": actor_id}, {**action, "identityActor": {"actorKind": "owner", "actorId": actor_id}},
                                {**action, "identityActor": {"actorKind": actor_kind, "actorId": actor_id, "other": True}}):
                    with self.assertRaises(ValueError):
                        window.validate_interactive_action(changed)
                stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
                stage.action = window.validate_interactive_action(action)
                stage.plan = {"initialEpoch": "7", "maximumSeconds": 300, "sourceCommit": "b" * 40, "targetSha256": "c" * 64,
                              "nativePlan": {"deploymentUrl": "https://owned.vercel.app"}}
                frontend = {"epoch": "7", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
                stage.broker = SimpleNamespace(initial={"candidateSha256": "a" * 64, "scopedCronSecret": "fixture" * 8},
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
                    selector = hashlib.sha256(f'["identity","{actor_kind}"]'.encode()).hexdigest()
                    self.assertEqual(cookie[6], selector)
                    self.assertEqual(len(cookie), 8)
                    stage.fence_gateway()
                    self.assertTrue(stage.verify_gateway_fenced()["gatewayAdmissionClosed"])
                    replace.assert_not_called()

    def test_guarded_private_permit_and_exact_gateway_fence(self):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        actor = "10000000-0000-4000-8000-000000000001"
        action = {"stage": "learning", "actorId": actor, "windowSeconds": 90,
                  "requests": [{"method": "GET", "target": "/course/v1/courses?limit=1",
                                "bodySha256": window._EMPTY, "uses": 1}]}
        self.assertEqual(window.validate_interactive_action(action), action)
        for change in ({"actorId": "wrong"}, {"windowSeconds": 301}, {"requests": action["requests"] * 2},
                       {"stage": "lifecycle"}, {"requests": [{**action["requests"][0], "bodySha256": "b" * 64}]}):
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
                broker.admission_fd, broker.admission_identity, broker.configuration = fd, os.fstat(fd), root
                broker.jobs, broker.selected = {"frontend": {}}, {"releaseId": "owned-release"}
                broker.action_id, broker.check = lambda: "owned-action", lambda: None
                broker._native_context, broker.profile_arguments, broker.vercel = lambda: {}, lambda: {}, object()
                secret = "owned-browser-permit-fixture-key"
                broker.initial = {"candidateSha256": "a" * 64, "scopedCronSecret": secret,
                    "sourceSha256": {window._SOURCE_KEY: window._hash(window._SOURCE.read_bytes())},
                    "certificationPlan": {"mode": "interactive-browser", "startState": "already-closed", "maximumSeconds": 300,
                        "scopedAction": action, "initialEpoch": "7", "sourceCommit": "b" * 40, "targetSha256": "c" * 64,
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
                     patch.object(window.ingress, "observe_browser_protection", return_value={"status": "owned-protection"}), \
                     patch.object(window.native, "observe_metadata", return_value={"nativeEnabled": False}), \
                     patch.object(window.time, "time", return_value=1_794_009_600) as wall:
                    self.assertEqual(stage.prepare()["status"], "owned-protection")
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
                    self.assertTrue(permit["cookie"].startswith("v1.8.learning.1794009600.1794009690."))
                    self.assertNotIn(permit["cookie"], path.read_text())
                    self.assertNotIn(installed["key"], repr(opened))
                    with self.assertRaisesRegex(ValueError, "PERMIT_NOT_AVAILABLE"):
                        stage.take_private_browser_permit()
                    with self.assertRaisesRegex(ValueError, "COMPLETE_GATEWAY_EFFECTS"):
                        stage.collect_gateway_effects()
                    observed.append({"requestId": "10000000-0000-4000-8000-000000000002",
                                     "proofRequestId": "10000000-0000-4000-8000-000000000003",
                                     "requestIndex": 0, "upstreamStatus": 200})
                    self.assertEqual(stage.collect_gateway_effects(), observed)
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
