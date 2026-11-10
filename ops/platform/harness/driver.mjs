import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { request as freshRequest } from "node:https";
import { createGateway } from "/app/server.mjs";
import { checkRuntime } from "/app/release-probe.mjs";
import { createWorkloadVerifier } from "/app/oidc.mjs";
import { SignJWT, importPKCS8 } from "/app/node_modules/jose/dist/webapi/index.js";
import { createGatewayTransport, runGatewaySmoke } from "/test/transport.mjs";

const fixture = JSON.parse(readFileSync("/test/fixture.json", "utf8"));
const config = JSON.parse(readFileSync("/config/gateway.json", "utf8"));
const jwks = JSON.parse(readFileSync("/test/jwks.json", "utf8"));
const records = [];
let server;
const proof = readFileSync("/test/oidc.token", "utf8").trim();

async function waitFor(name, check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) { records.push({ name, passed: true }); return; } } catch { /* bounded retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${name}`);
}

async function raw(path, options = {}) {
  return fetch(`https://gateway.test:8443${path}`, { ...options, redirect: "manual", signal: AbortSignal.timeout(5000) });
}

// The maintenance phase deliberately restarts the fixture's HTTPS listener.
// A fresh connection avoids reusing a pooled socket from the closed listener.
function freshRaw(path, options = {}) {
  return new Promise((resolve, reject) => {
    const call = freshRequest(new URL(`https://gateway.test:8443${path}`), {
      method: options.method ?? "GET", headers: options.headers, agent: false, signal: AbortSignal.timeout(5000),
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, retryAfter: response.headers["retry-after"] }));
      response.once("error", reject);
    });
    call.once("error", reject); call.end(options.body);
  });
}

try {
  ({ server } = createGateway(config, { verify: createWorkloadVerifier(config, { fetch: async () => Response.json(jwks) }) }));
  await new Promise((resolve) => server.listen(8443, "0.0.0.0", resolve));
  const transport = createGatewayTransport({ origin: "https://gateway.test:8443" });
  await waitFor("frontend-sdk-oidc-catalog-tls", async () => (await runGatewaySmoke(transport)).ok);
  const startup = await checkRuntime(config);
  for (const name of startup.checks) records.push({ name, passed: true });
  assert.equal((await raw("/course/v1/courses")).status, 401);
  assert.equal((await raw("/course/metrics", { headers: { "x-lash-workload-token": proof } })).status, 404);
  assert.equal((await raw("/course/v1/internal/community/entitlements/check", { method: "POST", headers: { "x-lash-workload-token": proof } })).status, 404);
  assert.equal((await raw("/course/v1/internal/entitlements/grants", { method: "POST", headers: { "x-lash-workload-token": proof } })).status, 401);
  const key = await importPKCS8(readFileSync("/test/oidc-private.pem", "utf8"), "RS256");
  const wrongProject = await new SignJWT({ ...fixture.claims, project_id: "prj_untrusted" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(key);
  assert.equal((await raw("/course/v1/courses", { headers: { "x-lash-workload-token": wrongProject } })).status, 401);
  records.push({ name: "signed-project-and-public-route-boundaries", passed: true });

  const issuedAt = Math.floor(Date.now() / 1000);
  const applicationToken = await new SignJWT({ iat: issuedAt, exp: issuedAt + 300, jti: randomUUID() })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("lash-her-frontend").setAudience("lash-her-course-api")
    .setSubject(process.env.HARNESS_CONTRACT_PHASE === "p2" ? "frontend" : "lash-her-frontend").sign(new TextEncoder().encode(process.env.HARNESS_FRONTEND_SECRET));
  const idempotencyKey = randomUUID();
  const command = { userId: fixture.userId, courseId: fixture.courseId, orderId: `fixture-${idempotencyKey}`,
    idempotencyKey, grantReason: "import", grantedAt: new Date().toISOString() };
  const grant = await transport({ method: "POST", path: "/v1/internal/entitlements/grants", applicationToken,
    idempotencyKey, body: JSON.stringify(command) });
  assert.ok([200, 201].includes(grant.status), `Grant status ${grant.status}`);
  const replay = await transport({ method: "POST", path: "/v1/internal/entitlements/grants", applicationToken,
    idempotencyKey, body: JSON.stringify(command) });
  assert.equal(replay.status, 200);
  records.push({ name: "authenticated-idempotent-enrollment", passed: true });
  writeFileSync("/test/out/grant.json", JSON.stringify({ userId: fixture.userId, courseId: fixture.courseId }));

  const privateDenied = await fetch("https://community-tls:8443/v1/internal/course/enrollment-events", {
    method: "POST", headers: { "x-forwarded-for": "172.29.10.22" }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(privateDenied.status, 403);
  await assert.rejects(fetch("http://172.29.20.10:4000/health", { signal: AbortSignal.timeout(1500) }));
  records.push({ name: "private-peer-spoofing-and-direct-backend-denial", passed: true });

  const muxEvent = { id: randomUUID(), type: "fixture.unsupported", created_at: new Date().toISOString(), data: {} };
  const muxEnvironment = process.env.HARNESS_MUX_ENVIRONMENT_ID;
  const p2Mux = process.env.HARNESS_CONTRACT_PHASE === "p2";
  if (p2Mux) assert.ok(muxEnvironment);
  const muxBody = JSON.stringify(p2Mux ? { ...muxEvent, environment: { id: muxEnvironment } } : muxEvent);
  assert.equal((await raw("/course/v1/webhooks/mux", { method: "POST", headers: { "content-type": "application/json", "mux-signature": "invalid" }, body: muxBody })).status, 400);
  const postSignedMux = (body) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", process.env.HARNESS_MUX_SECRET).update(`${timestamp}.${body}`).digest("hex");
    return raw("/course/v1/webhooks/mux", { method: "POST", headers: { "content-type": "application/json", "mux-signature": `t=${timestamp},v1=${signature}` }, body });
  };
  if (p2Mux) assert.equal((await postSignedMux(JSON.stringify({ ...muxEvent, environment: { id: "foreign-fixture" } }))).status, 400);
  const acceptedMux = await postSignedMux(muxBody);
  assert.ok([200, 204].includes(acceptedMux.status), `Mux status ${acceptedMux.status}`);
  records.push({ name: "signed-mux-only-exception", passed: true });

  await waitFor("publisher-projection-and-worker-loop", async () => {
    const result = await (await fetch("http://observer:8080/status", { signal: AbortSignal.timeout(5000) })).json();
    return result.applied >= 1 && result.workerAge >= 0 && result.workerAge < 30;
  });
  await waitFor("actual-community-authority-client", async () => existsSync("/test/out/authority.json"));
  const authority = JSON.parse(readFileSync("/test/out/authority.json", "utf8"));
  assert.equal(authority.hasAccess, true);
  assert.equal(authority.wrongRouteDenied, true);
  writeFileSync("/test/out/restart-ready.json", JSON.stringify({ startedAt: Date.now() }));
  await waitFor("worker-restart-requested", async () => existsSync("/test/out/restarted.json"));
  await waitFor("worker-recovered-after-restart", async () => {
    const result = await (await fetch("http://observer:8080/status", { signal: AbortSignal.timeout(5000) })).json();
    return result.workerAge >= 0 && result.workerAge < 15;
  });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  ({ server } = createGateway({ ...config, maintenance: true }, { verify: createWorkloadVerifier(config, { fetch: async () => Response.json(jwks) }) }));
  await new Promise((resolve) => server.listen(8443, "0.0.0.0", resolve));
  const held = await freshRaw("/course/v1/internal/entitlements/grants", { method: "POST",
    headers: { "x-lash-workload-token": proof, authorization: `Bearer ${applicationToken}`, "content-type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(held.status, 503); assert.equal(held.retryAfter, "30");
  assert.equal((await freshRaw("/course/v1/courses", { headers: { "x-lash-workload-token": proof } })).status, 200);
  records.push({ name: "maintenance-holds-application-writes", passed: true });
} catch (error) {
  records.push({ name: "harness", passed: false, reason: error instanceof Error && /^(?:Timed out:|Grant status |Mux status )/u.test(error.message) ? error.message :
    typeof error?.actual === "number" && typeof error?.expected === "number" ? `Boundary status mismatch: ${error.actual}/${error.expected}` : "Boundary assertion failed" });
  process.exitCode = 1;
} finally {
  writeFileSync("/test/out/results.json", JSON.stringify({ records }, null, 2));
  server?.close(); server?.closeAllConnections();
  process.stdout.write(`Harness checks: ${records.filter((record) => record.passed).length} passed; ${records.filter((record) => !record.passed).length} failed\n`);
}
