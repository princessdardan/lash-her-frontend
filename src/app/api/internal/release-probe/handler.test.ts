import assert from "node:assert/strict";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createPhase2DayTwoWorkloadHandler, createReleaseProbeHandler, PHASE2_DAY_TWO_CANONICAL_WORKLOAD_MODE, PHASE2_DAY_TWO_WORKLOAD_MODE,
  readPhase2DayTwoWorkloadConfiguration, readReleaseProbeConfiguration } from "./handler";
import type { FrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";
import { createFrontendGoogleBindingProbe } from "@/lib/writer-admission/google-binding-probe";
import { RELEASE_FEATURE_CONTROL_NAMES, readReleaseFeatureControls } from "@/lib/api-integration/release-feature-controls";

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
const cronSecret = "synthetic-day-two-cron-credential";
const stagingGateway = "https://api-staging.lashher.com";
function dayTwoEnvironment() {
  return { ...environment(), CRON_SECRET: cronSecret, LASH_RELEASE_PROBE_EXPIRES_AT: "1", API_GATEWAY_STAGING_ORIGIN: stagingGateway,
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432,
      database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "d".repeat(64) }),
    DATABASE_URL: "postgresql://protocol_runtime:synthetic-business-key@db.owned.invalid/owned?sslmode=verify-full",
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: "postgresql://protocol_runtime:synthetic-ledger-key@db.owned.invalid/owned?sslmode=verify-full" };
}
function dayTwoRequest(headers: Record<string, string> = {}, method = "GET") {
  return new Request("https://fixture.vercel.app/api/internal/release-probe", { method,
    headers: { authorization: `Bearer ${cronSecret}`, "x-lash-release-challenge": challenge,
      "x-lash-release-mode": PHASE2_DAY_TWO_WORKLOAD_MODE, ...headers } });
}

test("day-two configuration requires the dedicated hosted staging runtime and enforce binding without reading the old probe credential", () => {
  const env = dayTwoEnvironment();
  const withoutOldProbe = new Proxy(env, { get(value, key) {
    assert.notEqual(key, "LASH_RELEASE_PROBE_SECRET"); assert.notEqual(key, "LASH_RELEASE_PROBE_EXPIRES_AT");
    return Reflect.get(value, key);
  } });
  const config = readPhase2DayTwoWorkloadConfiguration(withoutOldProbe);
  assert.ok(config);
  assert.equal(config.sourceCommit, env.VERCEL_GIT_COMMIT_SHA);
  assert.equal(config.writerAdmissionBinding.mode, "enforce");
  assert.equal(readPhase2DayTwoWorkloadConfiguration({ ...env, API_GATEWAY_STAGING_ORIGIN: stagingGateway + "/" })?.gatewayOrigin, stagingGateway);
  assert.equal(readReleaseProbeConfiguration(env, now), null);
  for (const changed of [
    { CRON_SECRET: "" }, { CRON_SECRET: "   " }, { VERCEL: undefined }, { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { VERCEL_TARGET_ENV: "preview" }, { APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
    { APP_VERCEL_TEAM_ID: "team_other" }, { VERCEL_PROJECT_ID: "prj_other" }, { VERCEL_GIT_COMMIT_SHA: "0".repeat(40) },
    { API_GATEWAY_STAGING_ORIGIN: "https://foreign.example.invalid" }, { FRONTEND_WRITER_ADMISSION_MODE: "off" },
    { FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}" }, { FRONTEND_WRITER_PRODUCER_SHA256: undefined },
    { FRONTEND_WRITER_ADMISSION_DATABASE_URL: env.FRONTEND_WRITER_ADMISSION_DATABASE_URL.replace("verify-full", "require") },
    { DATABASE_URL: env.DATABASE_URL.replace("db.owned.invalid", "foreign.example.invalid") },
  ]) assert.equal(readPhase2DayTwoWorkloadConfiguration({ ...env, ...changed }), null);
});

test("day-two handler only accepts GET, exact mode, cron bearer and a valid challenge before its single smoke call", async () => {
  let calls = 0;
  const handler = createPhase2DayTwoWorkloadHandler({ configuration: () => readPhase2DayTwoWorkloadConfiguration(dayTwoEnvironment()),
    phase2: async origin => { assert.equal(origin, stagingGateway); calls++; throw new Error("private-smoke-failure"); } });
  for (const method of ["HEAD", "POST"]) {
    const denied = await handler(dayTwoRequest({}, method));
    assert.equal(denied.status, 405); assert.equal(denied.headers.get("allow"), "GET");
  }
  assert.equal((await handler(dayTwoRequest({ "x-lash-release-mode": `${PHASE2_DAY_TWO_WORKLOAD_MODE}, phase2` }))).status, 400);
  for (const auth of ["", `Basic ${cronSecret}`, `Bearer ${secret}`, `Bearer ${"x".repeat(cronSecret.length)}`]) {
    assert.equal((await handler(dayTwoRequest({ authorization: auth }))).status, 401);
  }
  for (const value of ["", "short", "A".repeat(64)]) {
    assert.equal((await handler(dayTwoRequest({ "x-lash-release-challenge": value }))).status, 400);
  }
  assert.equal(calls, 0);
  const failed = await handler(dayTwoRequest());
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "Release probe failed" });
  assert.equal(calls, 1);
});

test("actual route dispatch confines the cron credential to the current P2 catalog GET", async t => {
  const { GET, HEAD } = await import("./route");
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.owned`;
  const env = { ...dayTwoEnvironment(), NODE_ENV: "test" as const, VERCEL_OIDC_TOKEN: token, CUSTOMER_AUTH_ENABLED: "true" };
  t.mock.property(process, "env", env);
  const outbound = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), `${stagingGateway}/course/v1/courses`);
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-lash-workload-token"), token);
    assert.equal(headers.has("authorization"), false); assert.equal(headers.has("cookie"), false);
    return Response.json({ courses: [], nextCursor: null });
  });

  assert.equal(HEAD().status, 405);
  assert.equal((await GET(dayTwoRequest({ "x-lash-release-mode": "phase2" }))).status, 404);
  const fresh = await GET(dayTwoRequest({ "x-lash-workload-token": "forged", cookie: "private-cookie" }));
  assert.equal(fresh.status, 200); assert.equal(fresh.headers.get("cache-control"), "private, no-store");
  const { durationMs, ...body } = await fresh.json();
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
  assert.deepEqual(body, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge, environment: "staging",
    projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, sourceCommit: env.VERCEL_GIT_COMMIT_SHA, gatewayOrigin: stagingGateway,
    checks: ["gateway-course-catalog-p2"], contractPhase: "p2", featureControls: readReleaseFeatureControls(env),
    writerAdmissionBinding: { mode: "enforce", targetSha256: "d".repeat(64), producerSha256: "b".repeat(64),
      sourceCommit: env.VERCEL_GIT_COMMIT_SHA, roleName: "protocol_runtime" } });

  env.LASH_RELEASE_PROBE_EXPIRES_AT = String(Date.now() + 60_000);
  for (const mode of ["", "phase2", "phase2-auth-origins", "admission-bootstrap", "google-binding", "square-binding", "resend-binding"]) {
    assert.equal((await GET(dayTwoRequest({ "x-lash-release-mode": mode }))).status, 401);
  }
  assert.equal((await GET(dayTwoRequest({ authorization: `Bearer ${secret}` }))).status, 401);
  assert.equal(outbound.mock.callCount(), 1);
});

test("canonical day-two route challenges only the canonical alias and binds the actual deployment hostname", async t => {
  const { GET } = await import("./route");
  const canonical = "https://staging.lashher.com", path = "/api/internal/release-probe";
  const exp = Math.floor(Date.now() / 1000) + 1800;
  const token = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.owned`;
  const env: NodeJS.ProcessEnv = { ...dayTwoEnvironment(), NODE_ENV: "test", VERCEL_OIDC_TOKEN: token,
    VERCEL_URL: "owned-immutable-deployment.vercel.app",
    LASH_RELEASE_PROBE_EXPIRES_AT: String(Date.now() + 60_000),
    CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true", AUTH_URL: canonical, CUSTOMER_AUTH_URL: canonical,
    CUSTOMER_AUTH_SECRET: "customer-private-secret-value-32-characters", CUSTOMER_AUTH_GOOGLE_ID: "customer-google-id",
    CUSTOMER_AUTH_GOOGLE_SECRET: "customer-google-private-value", CUSTOMER_AUTH_RESEND_KEY: "customer-private-resend-value",
    CUSTOMER_AUTH_EMAIL_FROM: "academy@example.invalid",
  };
  t.mock.property(process, "env", env);
  const outbound = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), `${stagingGateway}/course/v1/courses`);
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-lash-workload-token"), token);
    assert.equal(headers.has("authorization"), false); assert.equal(headers.has("cookie"), false);
    return Response.json({ courses: [], nextCursor: null });
  });
  const get = (headers: Record<string, string> = {}, url = canonical + path) => GET(new Request(url, { headers: {
    authorization: `Bearer ${cronSecret}`, "x-lash-release-challenge": challenge,
    "x-lash-release-mode": PHASE2_DAY_TWO_CANONICAL_WORKLOAD_MODE, ...headers,
  } }));
  for (const url of [`https://${env.VERCEL_URL}${path}`, `${canonical}${path}?attempt=1`, `http://staging.lashher.com${path}`,
    `https://staging.lashher.com.example.invalid${path}`, canonical + "/api/internal/other"]) {
    assert.equal((await get({ host: "staging.lashher.com", "x-forwarded-host": "staging.lashher.com" }, url)).status, 404);
  }
  assert.equal((await get({ host: env.VERCEL_URL! })).status, 404);
  assert.equal((await get({ authorization: `Bearer ${secret}` })).status, 401);
  assert.equal((await get({ "x-lash-release-challenge": "invalid" })).status, 400);
  for (const [key, value] of [
    ["VERCEL_URL", undefined], ["VERCEL_URL", "https://owned-immutable-deployment.vercel.app"],
    ["VERCEL_URL", "owned-immutable-deployment.vercel.app/private"], ["VERCEL_URL", "other.example.invalid"],
    ["VERCEL_URL", "owned-immutable-deployment-.vercel.app"], ["AUTH_URL", "https://other.example.invalid"],
    ["AUTH_REDIRECT_PROXY_URL", canonical], ["CUSTOMER_AUTH_ENABLED", "false"], ["VERCEL_TARGET_ENV", "preview"],
  ] as const) {
    const saved = env[key];
    env[key] = value;
    assert.equal((await get()).status, 404, key);
    env[key] = saved;
  }
  assert.equal(outbound.mock.callCount(), 0);

  const response = await get({ host: "staging.lashher.com", "x-vercel-deployment-url": "forged.vercel.app", cookie: "private-cookie" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const { durationMs, ...receipt } = await response.json();
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
  assert.deepEqual(receipt, {
    version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge, environment: "staging",
    projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, sourceCommit: env.VERCEL_GIT_COMMIT_SHA, gatewayOrigin: stagingGateway,
    checks: ["gateway-course-catalog-p2"], contractPhase: "p2", featureControls: readReleaseFeatureControls(env),
    writerAdmissionBinding: { mode: "enforce", targetSha256: "d".repeat(64), producerSha256: "b".repeat(64),
      sourceCommit: env.VERCEL_GIT_COMMIT_SHA, roleName: "protocol_runtime" },
    authenticationOrigins: { customerOrigin: canonical, adminOrigin: canonical, adminRedirectProxyOrigin: null, customerRedirectProxyEnabled: false },
    deploymentUrl: env.VERCEL_URL,
  });
  const ordinary = await (await GET(dayTwoRequest())).json();
  assert.equal(Object.hasOwn(ordinary, "deploymentUrl"), false);
  assert.equal(Object.hasOwn(ordinary, "authenticationOrigins"), false);
  assert.equal(outbound.mock.callCount(), 2);
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

test("private Resend mode retains bootstrap checks, staging scope and challenge without forwarding incoming credentials", async () => {
  const observation: FrontendBootstrapProbe = { admission: { environment: "staging", targetSha256: "a".repeat(64), producerSha256: "b".repeat(64), sourceCommit: "a".repeat(40), epoch: "1", newWork: false, recovery: false }, schemaCatalogSha256: "d".repeat(64), featureControls: {} as FrontendBootstrapProbe["featureControls"] };
  const domain = { resendBinding: { domainId: "d7371c9b-b16d-41d8-b9e8-3286b58eb432", domainName: "mail.staging.lashher.com" as const, domainStatus: "verified" as const } };
  let calls = 0;
  const dependencies = { configuration: () => readReleaseProbeConfiguration(environment(), now),
    run: async () => ({ ok: true as const, service: "course" as const, durationMs: 1 }), admission: async () => observation,
    resend: async (...args: unknown[]) => { assert.deepEqual(args, [{ environment: "staging", sourceCommit: "a".repeat(40) }]); calls++; return domain; } };
  const handler = createReleaseProbeHandler(dependencies);
  assert.equal((await handler(request({ "x-lash-release-mode": "resend-binding", authorization: "Bearer invalid" }))).status, 401);
  const response = await handler(request({ "x-lash-release-mode": "resend-binding", cookie: "private-cookie" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.equal(body.challenge, challenge); assert.deepEqual(body.resendBinding, domain.resendBinding);
  assert.deepEqual(body.checks, ["gateway-course-catalog", "frontend-admission-bootstrap", "resend-binding"]); assert.deepEqual(body.admission, observation.admission);
  assert.equal(calls, 1); assert.equal(JSON.stringify(body).includes("private-cookie"), false);
  assert.equal((await createReleaseProbeHandler({ ...dependencies, resend: undefined })(request({ "x-lash-release-mode": "resend-binding" }))).status, 503);
  assert.equal((await createReleaseProbeHandler({ ...dependencies, configuration: () => ({ ...dependencies.configuration()!, environment: "production" }) })(request({ "x-lash-release-mode": "resend-binding" }))).status, 503);
  assert.equal(calls, 1);
});

test("Square mode requires staging admission plus deployed sandbox reader and retains challenge", async () => {
  const configuration = () => readReleaseProbeConfiguration(environment(), now);
  const run = async () => ({ ok: true as const, service: "course" as const, durationMs: 1 });
  assert.equal((await createReleaseProbeHandler({ configuration, run })(request({ "x-lash-release-mode": "square-binding" }))).status, 503);
  const square = async () => ({ squareBinding: { environment: "sandbox" as const, locationId: "LE2H76M5V90AM" as const, merchantId: "ownedMerchant",
    applicationId: "sandbox-sq0idb-owned", currency: "CAD" as const, country: "CA" as const, locationStatus: "ACTIVE" as const } });
  const admission = async (): Promise<FrontendBootstrapProbe> => ({ admission: { environment: "staging" as const, targetSha256: "a".repeat(64), producerSha256: "b".repeat(64), sourceCommit: "a".repeat(40), epoch: "1", newWork: false, recovery: false }, schemaCatalogSha256: "d".repeat(64), featureControls: {} as FrontendBootstrapProbe["featureControls"] });
  const handler = createReleaseProbeHandler({ configuration, run, admission, square });
  const response = await handler(request({ "x-lash-release-mode": "square-binding", "x-square-token": "forged" }));
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.challenge, challenge); assert.deepEqual(body.checks, ["gateway-course-catalog", "frontend-admission-bootstrap", "square-binding"]);
  assert.deepEqual(body.squareBinding, (await square()).squareBinding);
  assert.equal((await createReleaseProbeHandler({ configuration: () => ({ ...configuration()!, environment: "production" }), run, admission, square })(request({ "x-lash-release-mode": "square-binding" }))).status, 503);
});

test("explicit P2 mode uses only its current catalog parser and requires no bootstrap or disabled feature controls", async () => {
  let calls = 0;
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(environment(), now),
    run: async () => assert.fail("legacy parser called"), admission: async () => assert.fail("bootstrap called"),
    square: async () => assert.fail("Square called"), resend: async () => assert.fail("Resend called"),
    phase2: async (...args) => { assert.deepEqual(args, ["https://gateway.example.invalid"]); calls++; return { ok: true, service: "course", durationMs: 2 }; } });
  const response = await handler(request({ "x-lash-release-mode": "phase2", "x-lash-workload-token": "forged", cookie: "private-cookie" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge, environment: "staging",
    projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, sourceCommit: "a".repeat(40), gatewayOrigin: "https://gateway.example.invalid",
    checks: ["gateway-course-catalog-p2"], contractPhase: "p2", featureControls: readReleaseFeatureControls(environment()), writerAdmissionBinding: null, durationMs: 2 });
  assert.equal(calls, 1);
});

test("P2 probe reports only actual runtime feature booleans and ignores caller feature claims", async () => {
  const env: Record<string, string | undefined> = { ...environment(), PRIVATE_ENV_CREDENTIAL: "private-value" };
  for (const name of RELEASE_FEATURE_CONTROL_NAMES) env[name] = "false";
  for (const name of ["INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_LEARNING_ROUTES_ENABLED",
    "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED"]) env[name] = "true";
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(env, now),
    run: async () => assert.fail("legacy parser called"), phase2: async () => ({ ok: true, service: "course", durationMs: 1 }) });
  const response = await handler(request({ "x-lash-release-mode": "phase2", "x-lash-feature-controls": "all-enabled" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body.featureControls, readReleaseFeatureControls(env));
  assert.equal(Object.values(body.featureControls).filter(Boolean).length, 6);
  assert.equal(JSON.stringify(body).includes("private-value"), false);
  env.CUSTOMER_AUTH_ENABLED = "TRUE";
  delete env.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED;
  const changed = await (await handler(request({ "x-lash-release-mode": "phase2" }))).json();
  assert.equal(changed.featureControls.CUSTOMER_AUTH_ENABLED, false);
  assert.equal(changed.featureControls.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED, false);
});

test("P2 admission binding comes only from actual validated runtime configuration without credentials", async () => {
  const env = { ...environment(), FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432,
      database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "d".repeat(64) }),
    DATABASE_URL: "postgresql://protocol_runtime:private-business-password@db.owned.invalid/owned?sslmode=verify-full",
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: "postgresql://protocol_runtime:private-ledger-password@db.owned.invalid/owned?sslmode=verify-full" };
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(env, now),
    run: async () => assert.fail("legacy parser called"), phase2: async () => ({ ok: true, service: "course", durationMs: 1 }) });
  const response = await handler(request({ "x-lash-release-mode": "phase2", "x-lash-writer-admission-binding": "forged" }));
  const body = await response.json(); assert.equal(response.status, 200);
  assert.deepEqual(body.writerAdmissionBinding, { mode: "enforce", targetSha256: "d".repeat(64), producerSha256: "b".repeat(64),
    sourceCommit: "a".repeat(40), roleName: "protocol_runtime" });
  for (const privateValue of ["private-business-password", "private-ledger-password", "db.owned.invalid", "postgresql:", "forged"]) {
    assert.equal(JSON.stringify(body).includes(privateValue), false);
  }
  assert.equal(readReleaseProbeConfiguration({ ...env, FRONTEND_WRITER_ADMISSION_DATABASE_URL: env.FRONTEND_WRITER_ADMISSION_DATABASE_URL.replace("verify-full", "require") }, now), null);
});

test("P2 mode authenticates before work, refuses missing/production configuration and never falls back after parser failure", async () => {
  let calls = 0;
  const configuration = () => readReleaseProbeConfiguration(environment(), now);
  const run = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  const phase2 = async () => { calls++; throw new Error("private-parser-diagnostic"); };
  assert.equal((await createReleaseProbeHandler({ configuration, run })(request({ "x-lash-release-mode": "phase2" }))).status, 503);
  const handler = createReleaseProbeHandler({ configuration, run, phase2 });
  assert.equal((await handler(request({ "x-lash-release-mode": "phase2", authorization: "Bearer wrong" }))).status, 401);
  assert.equal((await handler(request({ "x-lash-release-mode": "phase2", "x-lash-release-challenge": "wrong" }))).status, 400);
  assert.equal((await handler(request({ "x-lash-release-mode": "phase2-other" }))).status, 400);
  assert.equal((await createReleaseProbeHandler({ configuration: () => ({ ...configuration()!, environment: "production" }), run, phase2 })(request({ "x-lash-release-mode": "phase2" }))).status, 503);
  assert.equal(calls, 0);
  const failed = await handler(request({ "x-lash-release-mode": "phase2" }));
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "Release probe failed" });
  assert.equal(calls, 1);
});

test("authentication-origin mode reports only actual validated canonical configuration behind the existing challenge", async () => {
  const canonical = "https://staging.lashher.com";
  const env = { ...environment(), CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true",
    AUTH_URL: canonical, CUSTOMER_AUTH_URL: canonical, CUSTOMER_AUTH_SECRET: "customer-private-secret-value-32-characters",
    CUSTOMER_AUTH_GOOGLE_ID: "customer-google-id", CUSTOMER_AUTH_GOOGLE_SECRET: "customer-google-private-value",
    CUSTOMER_AUTH_RESEND_KEY: "customer-private-resend-value", CUSTOMER_AUTH_EMAIL_FROM: "academy@example.invalid" };
  let calls = 0;
  const phase2 = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(env, now), run: phase2, phase2 });
  assert.equal((await handler(request({ "x-lash-release-mode": "phase2-auth-origins", authorization: "Bearer wrong" }))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(request({ "x-lash-release-mode": "phase2-auth-origins" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.challenge, challenge); assert.equal(body.sourceCommit, env.VERCEL_GIT_COMMIT_SHA);
  assert.equal(body.projectId, VERCEL_PROJECT_BINDINGS.stagingProjectId); assert.equal(body.contractPhase, "p2");
  assert.deepEqual(body.authenticationOrigins, { customerOrigin: canonical, adminOrigin: canonical,
    adminRedirectProxyOrigin: null, customerRedirectProxyEnabled: false });
  for (const value of [env.CUSTOMER_AUTH_SECRET, env.CUSTOMER_AUTH_GOOGLE_SECRET, env.CUSTOMER_AUTH_RESEND_KEY, env.CUSTOMER_AUTH_GOOGLE_ID, env.CUSTOMER_AUTH_EMAIL_FROM, secret]) {
    assert.equal(JSON.stringify(body).includes(value), false);
  }
  const ordinary = await (await handler(request({ "x-lash-release-mode": "phase2" }))).json();
  assert.equal(Object.hasOwn(ordinary, "authenticationOrigins"), false);
});

test("authentication-origin mode refuses mismatched, missing, proxied or disabled auth before upstream work", async () => {
  const canonical = "https://staging.lashher.com";
  const env = { ...environment(), CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true",
    AUTH_URL: canonical, CUSTOMER_AUTH_URL: canonical, CUSTOMER_AUTH_SECRET: "customer-private-secret-value-32-characters",
    CUSTOMER_AUTH_GOOGLE_ID: "customer-google-id", CUSTOMER_AUTH_GOOGLE_SECRET: "customer-google-private-value",
    CUSTOMER_AUTH_RESEND_KEY: "customer-private-resend-value", CUSTOMER_AUTH_EMAIL_FROM: "academy@example.invalid" };
  let calls = 0;
  const phase2 = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  for (const changed of [{ AUTH_URL: "https://production.example.invalid" }, { AUTH_URL: "" },
    { AUTH_URL: canonical + "/other-auth" }, { AUTH_URL: canonical + "?private=value" },
    { CUSTOMER_AUTH_URL: "https://other.vercel.app" }, { CUSTOMER_AUTH_SECRET: "" },
    { NEXTAUTH_URL: "https://production.example.invalid" }, { AUTH_REDIRECT_PROXY_URL: canonical + "/api/auth" },
    { AUTH_REDIRECT_PROXY_URL: "https://production.example.invalid/api/auth" }, { CUSTOMER_AUTH_ENABLED: "false" }]) {
    const handler = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration({ ...env, ...changed }, now), run: phase2, phase2 });
    const response = await handler(request({ "x-lash-release-mode": "phase2-auth-origins" }));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "Release probe failed" });
  }
  assert.equal(calls, 0);
  const fallback = { ...env, AUTH_URL: undefined, NEXTAUTH_URL: canonical + "/api/auth" };
  assert.equal((await createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(fallback, now), run: phase2, phase2 })(request({ "x-lash-release-mode": "phase2-auth-origins" }))).status, 200);
});

test("Google binding requires staging bootstrap and issues transient runtime proofs for only the authenticated challenge", async () => {
  const configuration = () => readReleaseProbeConfiguration(environment(), now);
  const observation: FrontendBootstrapProbe = { admission: { environment: "staging", targetSha256: "a".repeat(64), producerSha256: "b".repeat(64), sourceCommit: "a".repeat(40), epoch: "1", newWork: false, recovery: false }, schemaCatalogSha256: "d".repeat(64), featureControls: {} as FrontendBootstrapProbe["featureControls"] };
  const binding = createFrontendGoogleBindingProbe({ environment: () => ({ APP_ENV: "staging", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    AUTH_GOOGLE_ID: "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "synthetic-identity".repeat(3),
    GOOGLE_CLIENT_ID: "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "synthetic-calendar".repeat(3) }) });
  let calls = 0;
  const dependencies = { configuration, run: async () => ({ ok: true as const, service: "course" as const, durationMs: 1 }),
    admission: async () => observation, google: async (...args: Parameters<typeof binding>) => {
      assert.deepEqual(args, [{ environment: "staging", sourceCommit: "a".repeat(40) }, challenge]); calls++; return binding(...args);
    } };
  const handler = createReleaseProbeHandler(dependencies);
  assert.equal((await handler(request({ "x-lash-release-mode": "google-binding", authorization: "Bearer invalid" }))).status, 401);
  const response = await handler(request({ "x-lash-release-mode": "google-binding", "x-lash-workload-token": "forged", cookie: "private-cookie" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json(); assert.equal(body.challenge, challenge);
  assert.deepEqual(body.checks, ["gateway-course-catalog", "frontend-admission-bootstrap", "google-binding"]);
  assert.deepEqual(body.admission, observation.admission); assert.match(body.googleBinding.identity.proof, /^[a-f0-9]{64}$/u);
  assert.match(body.googleBinding.calendar.proof, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(body).includes("synthetic-identity"), false); assert.equal(JSON.stringify(body).includes("private-cookie"), false);
  assert.equal((await createReleaseProbeHandler({ ...dependencies, google: undefined })(request({ "x-lash-release-mode": "google-binding" }))).status, 503);
  assert.equal((await createReleaseProbeHandler({ ...dependencies, admission: undefined })(request({ "x-lash-release-mode": "google-binding" }))).status, 503);
  assert.equal((await createReleaseProbeHandler({ ...dependencies, configuration: () => ({ ...configuration()!, environment: "production" }) })(request({ "x-lash-release-mode": "google-binding" }))).status, 503);
  assert.equal(calls, 1);
});
