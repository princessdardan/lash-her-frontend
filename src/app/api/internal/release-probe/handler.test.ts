import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createReleaseProbeHandler, readReleaseProbeConfiguration } from "./handler";
import type { FrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";

const now = 1_794_000_000_000;
const secret = "b".repeat(64), challenge = "c".repeat(64);
function environment() {
  return { VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_ENV: "staging",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40), LASH_RELEASE_PROBE_SECRET: secret,
    API_GATEWAY_STAGING_ORIGIN: "https://gateway.example.invalid",
    LASH_RELEASE_PROBE_EXPIRES_AT: String(now + 60_000) };
}
const request = (headers: Record<string, string> = {}) => new Request("https://fixture.vercel.app/api/internal/release-probe", {
  headers: { authorization: `Bearer ${secret}`, "x-lash-release-challenge": challenge, ...headers },
});

test("release probe requires a live bounded credential and the reviewed Production-target project/source", () => {
  assert.equal(readReleaseProbeConfiguration(environment(), now)?.environment, "staging");
  const production = { ...environment(), APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId,
    API_GATEWAY_PRODUCTION_ORIGIN: "https://production-gateway.example.invalid" };
  assert.equal(readReleaseProbeConfiguration(production, now)?.environment, "production");
  for (const changed of [
    { LASH_RELEASE_PROBE_SECRET: "" }, { LASH_RELEASE_PROBE_SECRET: "short" },
    { LASH_RELEASE_PROBE_EXPIRES_AT: String(now) }, { LASH_RELEASE_PROBE_EXPIRES_AT: String(now + 3_600_001) },
    { LASH_RELEASE_PROBE_EXPIRES_AT: "NaN" }, { VERCEL_GIT_COMMIT_SHA: "0".repeat(40) },
    { VERCEL_GIT_COMMIT_SHA: "wrong" }, { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { VERCEL_ENV: "development" }, { APP_ENV: "local" }, { APP_ENV: "production" },
    { VERCEL_PROJECT_ID: "prj_other" }, { APP_VERCEL_TEAM_ID: "team_other" },
    { API_GATEWAY_STAGING_ORIGIN: "http://gateway.example.invalid" }, { API_GATEWAY_STAGING_ORIGIN: "https://user:pass@gateway.example.invalid" },
    { API_GATEWAY_STAGING_ORIGIN: "https://gateway.example.invalid/path" }, { API_GATEWAY_STAGING_ORIGIN: "" },
  ]) assert.equal(readReleaseProbeConfiguration({ ...environment(), ...changed }, now), null);
});

test("missing configuration, wrong bearer and malformed challenge cannot trigger outbound work", async () => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  assert.equal((await createReleaseProbeHandler({ configuration: () => null, run })(request())).status, 404);
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(environment(), now), run });
  for (const auth of ["", "Bearer wrong", `Basic ${secret}`]) assert.equal((await handler(request({ authorization: auth }))).status, 401);
  for (const value of ["", "short", "x".repeat(64)]) assert.equal((await handler(request({ "x-lash-release-challenge": value }))).status, 400);
  assert.equal(calls, 0);
});

test("successful probe binds a fresh challenge and hosted source without relaying incoming tokens or private data", async () => {
  let calls = 0;
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(environment(), now),
    run: async (...args) => { assert.deepEqual(args, ["https://gateway.example.invalid"]); calls++; return { ok: true, service: "course", durationMs: 3 }; } });
  const response = await handler(request({ "x-lash-workload-token": "forged-incoming-proof", cookie: "private-cookie" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge, environment: "staging",
    projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, sourceCommit: "a".repeat(40), gatewayOrigin: "https://gateway.example.invalid",
    checks: ["gateway-course-catalog"], durationMs: 3 });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(body).includes(secret));
});

test("SDK, gateway and configuration errors return non-success without leaking diagnostics", async () => {
  for (const mode of ["configuration", "upstream"]) {
    const handler = createReleaseProbeHandler({
      configuration: () => { if (mode === "configuration") throw new Error("private-credential"); return readReleaseProbeConfiguration(environment(), now); },
      run: async () => { throw new Error("private-credential"); },
    });
    const response = await handler(request());
    assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes("private-credential"));
  }
});

test("bootstrap mode is staging-only, requires its real admission reader and rejects unknown modes before outbound work", async () => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  const configuration = () => readReleaseProbeConfiguration(environment(), now);
  const missing = createReleaseProbeHandler({ configuration, run });
  assert.equal((await missing(request({ "x-lash-release-mode": "admission-bootstrap" }))).status, 503);
  assert.equal((await missing(request({ "x-lash-release-mode": "other" }))).status, 400);
  const production = createReleaseProbeHandler({ configuration: () => ({ ...configuration()!, environment: "production" }), run,
    admission: async () => { throw new Error("must-not-read-production"); } });
  assert.equal((await production(request({ "x-lash-release-mode": "admission-bootstrap" }))).status, 503);
  assert.equal(calls, 0);
});

test("bootstrap response binds the ordinary workload proof and actual read-only admission observation to one challenge", async () => {
  const observation: FrontendBootstrapProbe = { admission: { environment: "staging", targetSha256: "a".repeat(64), producerSha256: "b".repeat(64), sourceCommit: "a".repeat(40), epoch: "1", newWork: false, recovery: false }, schemaCatalogSha256: "d".repeat(64), featureControls: {} as FrontendBootstrapProbe["featureControls"] };
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(environment(), now),
    run: async () => ({ ok: true, service: "course", durationMs: 1 }),
    admission: async source => { assert.deepEqual(source, { environment: "staging", sourceCommit: "a".repeat(40) }); return observation; } });
  const response = await handler(request({ "x-lash-release-mode": "admission-bootstrap" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.challenge, challenge);
  assert.deepEqual(body.checks, ["gateway-course-catalog", "frontend-admission-bootstrap"]);
  assert.deepEqual(body.admission, observation.admission); assert.equal(body.schemaCatalogSha256, observation.schemaCatalogSha256);
  assert.equal("appliedLineageSha256" in body, false);
});
