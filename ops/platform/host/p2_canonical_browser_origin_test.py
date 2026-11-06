"""Owned HTTPS/provider fixtures only; no real alias/provider invocation."""
import copy
import json
import os
from pathlib import Path
import subprocess
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
        owned = self.base.probe._opener
        class ExactCanonicalTransport:
            def open(inner, request, timeout):
                self.assertEqual(request.full_url, origin.ORIGIN+"/api/internal/release-probe")
                self.assertEqual(request.get_header("X-lash-release-mode"), "phase2-auth-origins")
                self.assertIsNone(request.get_header("Host"))
                return owned.open(request, timeout)
        self.probe._opener = ExactCanonicalTransport()

    def alias(self):
        return {"alias": origin.HOST, "projectId": origin.PROJECT, "deploymentId": "dpl_fixture",
            "deployment": {"id": "dpl_fixture", "url": "owned-fixture.vercel.app"}, "uid": "owned-alias"}

    def enqueue(self, first_alias=None, last_alias=None, response=None):
        self.base.enqueue_metadata()
        self.fixture.enqueue(first_alias or self.alias(), self.base.project())
        self.fixture.responses.append((200, response or {**self.base.response(), "authenticationOrigins": origin.AUTHENTICATION_ORIGINS}, {"Content-Type": "application/json", "Cache-Control": "private, no-store"}))
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
        response = {**copy.deepcopy(self.base.response()), "authenticationOrigins": origin.AUTHENTICATION_ORIGINS}; response["writerAdmissionBinding"]["targetSha256"] = "9"*64
        self.enqueue(response=response)
        with self.assertRaisesRegex(ValueError, "WORKLOAD_BINDING"):
            origin.observe(self.context, self.fixture.client, self.probe)

    def test_missing_foreign_or_extra_auth_origin_projection_refuses(self):
        for origins in (None, {**origin.AUTHENTICATION_ORIGINS, "customerOrigin": "https://foreign.invalid"},
                {**origin.AUTHENTICATION_ORIGINS, "extra": True}, {**origin.AUTHENTICATION_ORIGINS, "customerRedirectProxyEnabled": 0}, {**origin.AUTHENTICATION_ORIGINS, "customerRedirectProxyEnabled": True}):
            with self.subTest(origins=origins):
                response = {**self.base.response(), "authenticationOrigins": origins}
                self.enqueue(response=response)
                with self.assertRaisesRegex(ValueError, "WORKLOAD_BINDING"):
                    origin.observe(self.context, self.fixture.client, self.probe)
                self.fixture.responses.clear()

    def test_actual_source_handler_produces_the_owned_https_alias_workload_proof(self):
        # The child imports actual TS configuration/handler code. Only its Course
        # catalog dependency and the alias/provider metadata remain owned models.
        program = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReleaseProbeHandler, readReleaseProbeConfiguration } from './src/app/api/internal/release-probe/handler.ts';
assert.equal(process.versions.node.split('.')[0], '24');
const input = JSON.parse(readFileSync(0, 'utf8'));
const env = { VERCEL:'1', VERCEL_ENV:'production', VERCEL_TARGET_ENV:'production', APP_ENV:'staging',
  APP_VERCEL_TEAM_ID:'team_2Hrn5eMZyZxfAWdmYvyKi9t3', VERCEL_PROJECT_ID:input.projectId, VERCEL_GIT_COMMIT_SHA:input.sourceCommit,
  LASH_RELEASE_PROBE_SECRET:input.secret, LASH_RELEASE_PROBE_EXPIRES_AT:String(Date.now()+600000),
  API_GATEWAY_STAGING_ORIGIN:'https://gateway.owned.invalid', AUTH_URL:'https://staging.lashher.com/api/auth',
  CUSTOMER_AUTH_URL:'https://staging.lashher.com', CUSTOMER_AUTH_SECRET:'OWNED_CUSTOMER_SECRET_DISTINCT_32_BYTES_MINIMUM',
  CUSTOMER_AUTH_GOOGLE_ID:'owned-customer-client', CUSTOMER_AUTH_GOOGLE_SECRET:'owned-customer-google-secret',
  CUSTOMER_AUTH_RESEND_KEY:'owned-customer-resend', CUSTOMER_AUTH_EMAIL_FROM:'owned@example.invalid',
  FRONTEND_WRITER_ADMISSION_MODE:'enforce', FRONTEND_WRITER_PRODUCER_SHA256:input.binding.producerSha256,
  FRONTEND_WRITER_ADMISSION_TARGET_JSON:JSON.stringify({environment:'staging',host:'owned-db.example.invalid',port:5432,database:'owned',
    user:input.binding.roleName,serverMajor:16,targetSha256:input.binding.targetSha256}),
  FRONTEND_WRITER_ADMISSION_DATABASE_URL:'postgresql://frontend_runtime:OWNED_NEVER_LIVE@owned-db.example.invalid/owned?sslmode=verify-full',
  DATABASE_URL:'postgresql://frontend_runtime:OWNED_NEVER_LIVE@owned-db.example.invalid/owned?sslmode=verify-full',
  ...Object.fromEntries(Object.entries(input.flags).map(([key,value])=>[key,String(value)])) };
let catalogCalls=0;
const execute = async changes => {
  const configuration = () => readReleaseProbeConfiguration({...env,...changes});
  return createReleaseProbeHandler({configuration,run:async()=>{throw Error('wrong mode');},phase2:async origin=>{
    assert.equal(origin,'https://gateway.owned.invalid');catalogCalls++;return {ok:true,service:'course',durationMs:1};
  }})(new Request('https://staging.lashher.com/api/internal/release-probe',{headers:{authorization:'Bearer '+input.secret,
    'x-lash-release-challenge':input.challenge,'x-lash-release-mode':'phase2-auth-origins'}}));
};
const positive=await execute({});assert.equal(positive.status,200);assert.equal(catalogCalls,1);
for(const changes of [{CUSTOMER_AUTH_URL:'https://foreign.invalid'},{AUTH_URL:'https://foreign.invalid'},
  {AUTH_REDIRECT_PROXY_URL:'https://staging.lashher.com/api/auth'}]) {
  const refused=await execute(changes);assert.equal(refused.status,503);assert.equal(catalogCalls,1);
}
process.stdout.write(JSON.stringify({status:positive.status,cacheControl:positive.headers.get('cache-control'),body:await positive.json(),
  actualSourceHandler:true,catalogCalls,wrongOriginAndProxyRefusedBeforeCatalog:true}));
"""
        packet = {"projectId": origin.PROJECT, "sourceCommit": self.base.plan["sourceCommit"], "secret": "f"*64, "challenge": "1"*64,
            "flags": self.base.plan["featureControls"], "binding": self.base.plan["writerAdmissionBinding"]}
        child = subprocess.run(["node", "--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", program],
            cwd=Path(__file__).parents[3], input=json.dumps(packet), text=True, capture_output=True, timeout=30,
            env={key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ})
        self.assertEqual(child.returncode, 0, "actual source handler child refused; private stdout/stderr withheld")
        produced = json.loads(child.stdout)
        self.assertTrue(produced["actualSourceHandler"]); self.assertTrue(produced["wrongOriginAndProxyRefusedBeforeCatalog"])
        self.assertEqual(produced["catalogCalls"], 1); self.assertEqual(produced["cacheControl"], "private, no-store")
        self.enqueue(response=produced["body"])
        result = origin.observe(self.context, self.fixture.client, self.probe)
        self.assertEqual(result["authenticationOrigins"], origin.AUTHENTICATION_ORIGINS)

    def test_private_credential_gateway_or_expiry_replacement_refuses(self):
        path = self.base.private/frontend_probe.PRIVATE_FILE
        original = json.loads(path.read_bytes())
        transport = self.probe._opener
        for field, changed in (("secret", "e"*64), ("gatewayOrigin", "https://different.owned.invalid"), ("expiresAt", original["expiresAt"]+1000)):
            with self.subTest(field=field):
                path.write_text(json.dumps(original))
                self.enqueue()
                class ChangedPrivateInput:
                    def open(inner, request, timeout):
                        response = transport.open(request, timeout)
                        path.write_text(json.dumps({**original, field: changed}))
                        return response
                self.probe._opener = ChangedPrivateInput()
                try:
                    with self.assertRaisesRegex(ValueError, "PRIVATE_INPUT_CHANGED"):
                        origin.observe(self.context, self.fixture.client, self.probe)
                finally:
                    self.probe._opener = transport
                    path.write_text(json.dumps(original))

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
