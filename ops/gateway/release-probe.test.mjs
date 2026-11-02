import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntime } from "./release-probe.mjs";
const config = { issuer: "https://oidc.vercel.com/test-team", audience: "https://vercel.com/test-team",
  subject: "owner:test-team:project:test-project:environment:production", ownerId: "team_test", projectId: "prj_test",
  environment: "production", appEnv: "staging", publicHost: "gateway.example.test", courseOrigin: "https://course-tls:8443",
  tlsKeyFile: "/tls/key.pem", tlsCertFile: "/tls/cert.pem", upstreamCaFile: "/tls/ca.pem" };

test("runtime probes check public auth and both private boundaries without claiming external or Vercel proof", async () => {
  const calls = [];
  const result = await checkRuntime(config, { ca: "fixture-ca", request: async (spec) => { calls.push(spec); return spec.expected; } });
  assert.equal(result.checks.length, 5);
  assert.equal(result.realVercelOidcVerified, false);
  assert.equal(result.externalIngressVerified, false);
  assert.equal(calls.filter((call) => call.loopback).length, 2);
  assert.ok(calls.filter((call) => !call.loopback).every((call) => call.ca === "fixture-ca"));
  assert.ok(calls.every((call) => !call.authorization && !call.body));
});

test("any unexpected public or private status stops the boundary qualification", async () => {
  for (let index = 0; index < 5; index++) {
    let calls = 0;
    await assert.rejects(checkRuntime(config, { ca: "fixture-ca", request: async (spec) => calls++ === index ? 503 : spec.expected }));
    assert.equal(calls, index + 1);
  }
});
