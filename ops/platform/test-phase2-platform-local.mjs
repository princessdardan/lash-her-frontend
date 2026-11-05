// Owned local HTTP/PG16 qualification. No image, provider or deployed proof is
// claimed. Run with Node24, register-server-only-test.mjs and tsx; explicit opt-in,
// PG_BIN and both qualified API source directories are required.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { Client } from "pg";
import { createGateway } from "../gateway/server.mjs";
import { createPrivateTlsProxy } from "../gateway/private-tls.mjs";
import { createWorkloadVerifier } from "../gateway/oidc.mjs";
import { createGatewayTransport } from "../../src/lib/api-integration/gateway-transport.ts";
import { runPhase2GatewaySmoke } from "../../src/lib/api-integration/phase2-gateway-smoke.ts";
import { courseHarnessAuth, disabledCourseWorkerEnvironment, phase2Workers } from "./phase2-harness-profile.mjs";
import { prepareFixture } from "./host/staging_fixture.mjs";
import { createReleaseProbeHandler, readReleaseProbeConfiguration } from "../../src/app/api/internal/release-probe/handler.ts";
import { VERCEL_PROJECT_BINDINGS } from "../../src/lib/env/application-environment.mjs";

assert.equal(process.env.PHASE2_PLATFORM_LOCAL_TEST, "true");
assert.equal(process.versions.node.split(".")[0], "24");
const pins = { course: process.env.PHASE2_COURSE_SOURCE_COMMIT ?? "dd0ae7179eea51173285e472d28467de1e2793c4", community: process.env.PHASE2_COMMUNITY_SOURCE_COMMIT ?? "ae9624489208b57cf408dacfcfb2240dc839a3d6" };
for (const pin of Object.values(pins)) assert.match(pin, /^[a-f0-9]{40}$/u);
const directories = { course: process.env.PHASE2_COURSE_SOURCE_ROOT, community: process.env.PHASE2_COMMUNITY_SOURCE_ROOT };
const binaries = process.env.PG_BIN;
assert.ok(binaries?.startsWith("/"));
const folder = mkdtempSync(join(tmpdir(), "phase2-platform-owned-")); chmodSync(folder, 0o700);
const clean = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", NO_COLOR: "1" };
const run = (file, args, options = {}) => execFileSync(file, args, { env: clean, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const children = [], servers = [], clients = [], checks = [];
let started = false, stage = "source-binding";
const check = name => checks.push(name);
const privateKey = join(folder, "key.pem"), certificate = join(folder, "cert.pem"), data = join(folder, "data");
try {
  for (const [name, directory] of Object.entries(directories)) {
    assert.ok(directory?.startsWith("/"));
    assert.equal(run("git", ["-C", directory, "remote", "get-url", "origin"]).trim(), `https://github.com/princessdardan/lash-her-${name}-api.git`);
    assert.equal(run("git", ["-C", directory, "rev-parse", "HEAD"]).trim(), pins[name]);
    run("git", ["-C", directory, "diff", "--quiet", "HEAD"]);
    const path = `openapi/${name}-api.json`;
    assert.equal(hash(readFileSync(join(directory, path))), hash(readFileSync(new URL(`../../contracts/api-integration/p2-candidate/${name}-api.json`, import.meta.url))));
    // Build exactly the checked source; the processes below execute this output.
    run("npm", ["run", "build:production"], { cwd: directory });
  }
  check("qualified-api-source-and-consumed-wire-bytes");
  stage = "owned-postgres16";
  assert.match(run(join(binaries, "postgres"), ["--version"]), /PostgreSQL\) 16\./u);
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=gateway.test", "-addext", "subjectAltName=DNS:gateway.test,DNS:localhost,IP:127.0.0.1", "-keyout", privateKey, "-out", certificate]); chmodSync(privateKey, 0o600);
  run(join(binaries, "initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale", "--encoding=UTF8"]);
  const databasePort = await port();
  run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(folder, "postgres.log"), "-o", `-h 127.0.0.1 -p ${databasePort} -c unix_socket_directories=`, "-w", "start"]); started = true;
  const admin = new Client({ connectionString: `postgresql://postgres@127.0.0.1:${databasePort}/postgres` }); clients.push(admin); await admin.connect();
  const databases = {};
  for (const name of Object.keys(pins)) {
    const database = `owned_phase2_${name}_test`;
    await admin.query(`create database ${database}`);
    databases[name] = `postgresql://postgres@127.0.0.1:${databasePort}/${database}`;
    run("npm", ["run", "db:migrate"], { cwd: directories[name], env: { ...clean, NODE_ENV: "test", DATABASE_TARGET: "test", TEST_DATABASE_URL: databases[name] } });
  }
  check("complete-migrations-on-two-owned-loopback-databases");
  const db = new Client({ connectionString: databases.course }); clients.push(db); await db.connect();
  const secret = () => randomBytes(32).toString("hex");
  const frontendSecret = secret(), adminSecret = secret(), learnerSecret = secret(), publisherSecret = secret();
  const coursePort = await port(), communityPort = await port();
  child(directories.course, "dist/server.js", { NODE_ENV: "test", DATABASE_TARGET: "test", TEST_DATABASE_URL: databases.course, PORT: String(coursePort), HTTP_BIND_ADDRESS: "127.0.0.1", ...courseHarnessAuth("p2", { frontendSecret, adminSecret, learnerSecret }), INTERNAL_SERVICE_ALLOWED_IPS: "127.0.0.1/32" });
  child(directories.community, "dist/server.js", { NODE_ENV: "test", DATABASE_TARGET: "test", TEST_DATABASE_URL: databases.community, PORT: String(communityPort), HTTP_BIND_ADDRESS: "127.0.0.1", COURSE_PUBLISHER_JWT_CURRENT_SECRET: publisherSecret, COURSE_PUBLISHER_ALLOWED_IPS: "127.0.0.1/32" });
  await ready(coursePort); await ready(communityPort);
  check("actual-course-and-community-fastify-processes-ready");
  stage = "tls-and-signed-workload";
  const courseTls = createPrivateTlsProxy({ upstream: `http://127.0.0.1:${coursePort}`, keyFile: privateKey, certFile: certificate,
    peers: [{ address: "127.0.0.1", routes: [
      { method: "GET", path: "/v1/courses" }, { method: "POST", path: "/v1/admin/courses" },
      { method: "POST", path: "/v1/admin/entitlements/grants" }, { method: "POST", path: "/v1/internal/entitlements/grants" },
    ] }] });
  const tlsPort = await listen(courseTls);
  const pair = await generateKeyPair("RS256", { extractable: true });
  const seconds = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://oidc.vercel.com/fixture-team", aud: "https://vercel.com/fixture-team", sub: "owner:fixture-team:project:fixture-project:environment:production", owner_id: "team_fixture", project_id: "prj_fixture", environment: "production", iat: seconds, nbf: seconds, exp: seconds + 600 };
  const config = { issuer: claims.iss, audience: claims.aud, subject: claims.sub, ownerId: claims.owner_id, projectId: claims.project_id, environment: "production", appEnv: "staging", publicHost: `gateway.test:${await port()}`, courseOrigin: `https://127.0.0.1:${tlsPort}`, tlsKeyFile: privateKey, tlsCertFile: certificate, upstreamCaFile: certificate };
  const jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: "owned", alg: "RS256", use: "sig" }] };
  const { server: gateway } = createGateway(config, { verify: createWorkloadVerifier(config, { fetch: async () => Response.json(jwks) }) });
  await listen(gateway, Number(config.publicHost.split(":")[1]));
  const workload = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "owned" }).sign(pair.privateKey);
  const origin = `https://${config.publicHost}`;
  const transport = createGatewayTransport({ origin, getWorkloadToken: async () => workload, fetch: tlsFetch });
  assert.equal((await tlsFetch(`${origin}/course/v1/courses`)).status, 401);
  assert.equal((await tlsFetch(`${origin}/course/metrics`, { headers: { "x-lash-workload-token": workload } })).status, 404);
  check("missing-workload-and-unlisted-private-route-denied");
  await db.query("insert into courses(id,slug,title,status,price_cents,currency,introduction) values($1,'owned-published','Owned published','published',0,'CAD','Owned introduction')", [randomUUID()]);
  assert.equal((await runPhase2GatewaySmoke(transport)).ok, true);
  const catalog = await (await transport({ method: "GET", path: "/v1/courses?limit=1" })).json();
  assert.equal(catalog.courses[0].accessMode, "free"); assert.equal(catalog.courses[0].introduction, "Owned introduction"); assert.ok(Object.hasOwn(catalog, "nextCursor"));
  check("actual-p2-catalog-metadata-through-verified-double-tls-and-signed-workload");
  const probeSecret = secret(), challenge = randomBytes(32).toString("hex");
  const probeEnvironment = { VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_ENV: "staging",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: run("git", ["rev-parse", "HEAD"]).trim(), LASH_RELEASE_PROBE_SECRET: probeSecret,
    LASH_RELEASE_PROBE_EXPIRES_AT: String(Date.now() + 60000), API_GATEWAY_STAGING_ORIGIN: origin };
  const probe = createReleaseProbeHandler({ configuration: () => readReleaseProbeConfiguration(probeEnvironment),
    run: async () => assert.fail("P2 probe used legacy parser"), admission: async () => assert.fail("P2 probe read disabled-feature bootstrap"),
    phase2: async selectedOrigin => { assert.equal(selectedOrigin, origin); return runPhase2GatewaySmoke(transport); } });
  const probeResponse = await probe(new Request("https://owned.vercel.app/api/internal/release-probe", { headers: {
    authorization: `Bearer ${probeSecret}`, "x-lash-release-challenge": challenge, "x-lash-release-mode": "phase2",
    "x-lash-workload-token": "must-not-be-forwarded", cookie: "must-not-be-forwarded" } }));
  assert.equal(probeResponse.status, 200); assert.equal(probeResponse.headers.get("cache-control"), "private, no-store");
  const observedProbe = await probeResponse.json(); assert.equal(observedProbe.challenge, challenge);
  assert.deepEqual(observedProbe.checks, ["gateway-course-catalog-p2"]); assert.equal(observedProbe.contractPhase, "p2");
  check("protected-p2-release-probe-through-actual-catalog-without-bootstrap-or-credential-forwarding");

  const actorUserId = randomUUID(), userIds = [randomUUID(), randomUUID()];
  const adminToken = await jwt({ version: 1, iss: "lash-her-frontend", aud: "lash-her-course-api:admin", sub: actorUserId, capabilities: ["course-editor", "course-support"] }, adminSecret);
  const result = await prepareFixture({ version: 2, environment: "staging", actionId: `recovery-fixture-owned-${randomUUID()}`, nonce: randomUUID().replaceAll("-", ""), actorUserId, userIds, applicationToken: adminToken }, {
    call: async (method, path, applicationToken, body, idempotencyKey) => {
      const response = await transport({ method, path, applicationToken, body: JSON.stringify(body), ...(idempotencyKey ? { idempotencyKey } : {}) });
      return { status: response.status, body: await response.json() };
    },
  });
  assert.equal(result.grants.length, 2);
  const rows = await db.query("select count(*)::int as count from entitlement_grants where course_id=$1", [result.courseId]); assert.equal(rows.rows[0].count, 2);
  check("actual-p2-admin-fixture-creates-draft-and-two-audited-grants");
  const legacy = await jwt({ sub: actorUserId, role: "courseAdmin" }, adminSecret);
  const confused = await jwt({ version: 1, iss: "lash-her-frontend", aud: "lash-her-course-api:learner", sub: actorUserId }, learnerSecret);
  const support = await jwt({ version: 1, iss: "lash-her-frontend", aud: "lash-her-course-api:admin", sub: actorUserId, capabilities: ["course-support"] }, adminSecret);
  for (const [label, token, expected] of [["legacy-admin", legacy, 401], ["cross-profile", confused, 403], ["support-only", support, 403]]) { stage = label; assert.equal((await transport({ method: "POST", path: "/v1/admin/courses", applicationToken: token, body: JSON.stringify({ slug: "denied", title: "Denied" }) })).status, expected); }
  check("legacy-profile-cross-profile-and-missing-editor-capability-denied");
  const key = randomUUID(), command = { userId: userIds[0], courseId: result.courseId, orderId: `owned-${key}`, idempotencyKey: key, grantReason: "import", grantedAt: new Date().toISOString() };
  for (const [sub, expected] of [["lash-her-frontend", 401], ["frontend", 201], ["frontend", 200]]) {
    const applicationToken = await jwt({ iss: "lash-her-frontend", aud: "lash-her-course-api", sub }, frontendSecret);
    assert.equal((await transport({ method: "POST", path: "/v1/internal/entitlements/grants", applicationToken, idempotencyKey: key, body: JSON.stringify(command) })).status, expected);
  }
  check("exact-frontend-service-subject-and-idempotent-replay");
  const event = (await db.query("select canonical_body from community_enrollment_outbox order by created_at limit 1")).rows[0].canonical_body;
  const publisher = await jwt({ iss: "lash-her-course-api", aud: "lash-her-community-api:course-enrollment-events", sub: "course-enrollment-publisher" }, publisherSecret);
  const receive = async token => fetch(`http://127.0.0.1:${communityPort}/v1/internal/course/enrollment-events`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: typeof event === "string" ? event : JSON.stringify(event) });
  assert.equal((await receive(adminToken)).status, 401);
  assert.equal((await receive(publisher)).status, 202); assert.equal((await receive(publisher)).status, 200);
  check("unchanged-actual-enrollment-receiver-acceptance-and-exact-replay");
  stage = "disabled-workers";
  for (const worker of phase2Workers) {
    const workerPort = await port();
    const process = child(directories.course, worker === "course-media" ? "dist/mux-media-worker.js" : "dist/account-export-cleanup-worker.js", { NODE_ENV: "production", PORT: String(workerPort), ...disabledCourseWorkerEnvironment(databases.course, worker) });
    await ready(workerPort);
    const metrics = await (await fetch(`http://127.0.0.1:${workerPort}/metrics`)).text(); assert.match(metrics, /_enabled 0/u);
    process.kill("SIGTERM"); await stopped(process);
  }
  check("two-minimal-disabled-workers-database-ready-metrics-and-graceful-stop");
  console.log(JSON.stringify({ status: "PHASE2_PLATFORM_OWNED_SOURCE_PASS", sources: pins, checks, providerTouched: false, imagesQualified: false, realVercelOidcVerified: false }));
} catch (error) {
  console.log(JSON.stringify({ status: "PHASE2_PLATFORM_OWNED_SOURCE_FAILED", stage, completed: checks, reason: error instanceof assert.AssertionError ? { code: "ASSERTION", ...(typeof error.actual === "number" ? { actual: error.actual } : {}), ...(typeof error.expected === "number" ? { expected: error.expected } : {}) } : { code: "OWNED_FIXTURE_FAILED" }, imagesQualified: false }));
  process.exitCode = 1;
} finally {
  for (const child of children) { if (child.exitCode === null) child.kill("SIGTERM"); await stopped(child).catch(() => child.kill("SIGKILL")); }
  for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const client of clients.reverse()) await client.end().catch(() => {});
  if (started) run(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
  rmSync(folder, { recursive: true, force: true });
}
async function port() { const server = createServer(); await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); }); const result = server.address().port; await new Promise(done => server.close(done)); return result; }
async function listen(server, port = 0) { servers.push(server); await new Promise((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", done); }); return server.address().port; }
function child(directory, entrypoint, environment) { const child = spawn(process.execPath, [join(directory, entrypoint)], { cwd: folder, env: { ...clean, ...environment }, stdio: ["ignore", "ignore", "ignore"] }); children.push(child); return child; }
async function stopped(child) { if (child.exitCode !== null) { assert.equal(child.exitCode, 0); return; } const result = await Promise.race([new Promise(done => child.once("exit", (code, signal) => done({ code, signal }))), new Promise(done => setTimeout(() => done(null), 5000))]); assert.deepEqual(result, { code: 0, signal: null }); }
async function ready(port) { for (let n = 0; n < 100; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(300) })).ok) return; } catch {} await new Promise(done => setTimeout(done, 50)); } throw new Error("Owned API readiness timeout"); }
async function jwt(claims, secret) { const now = Math.floor(Date.now() / 1000); return new SignJWT({ ...claims, iat: now, exp: now + 300, jti: randomUUID() }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret)); }
function tlsFetch(url, options = {}) { return new Promise((done, fail) => { const headers = Object.fromEntries(new Headers(options.headers)); const call = request(url, { method: options.method ?? "GET", headers, signal: options.signal, ca: readFileSync(certificate), lookup: (_name, options, callback) => callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4) }, response => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", fail); response.once("end", () => done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.entries(response.headers).filter(([, value]) => typeof value === "string") }))); }); call.once("error", fail); call.end(options.body); }); }
