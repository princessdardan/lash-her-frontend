// Owned actual app/receiver integration. No provider, deployed browser or Docker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer, request } from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { changeFrontendAdmission } from "../frontend-admission.mjs";
import { observeCourseSuspensionDenial, observeCommunitySuspensionDenial } from "../p2-lifecycle-receiver-denial.mjs";
import { signProbeToken } from "../p2-identity-negative-probe.mjs";

let phase = "owned-guard", workerFailure;
const ownedSecrets = [];
async function main() {
  assert.equal(process.env.P2_WORKER_OWNED_CHILD, "true");
  const input = JSON.parse(readFileSync(0, "utf8")), ca = readFileSync(input.certificate, "utf8"), clients = [], pools = [], apps = [], servers = [], checks = [], traces = [];
  const originalFetch = globalThis.fetch, originalInfo = console.info, hash = value => createHash("sha256").update(value).digest("hex");
  const randomKey = () => "owned-"+randomBytes(40).toString("hex"), keys = { learner: randomKey(), member: randomKey(), courseLifecycle: randomKey(), communityLifecycle: randomKey() };
  ownedSecrets.push(...Object.values(keys), ...Object.values(input.databases).map(row => row.password));
  const url = service => {
    const database = input.databases[service]; assert.equal(database.host, "127.0.0.1"); assert.match(database.database, /^owned_worker_(frontend|course|community)$/u);
    const value = new URL(`postgresql://${database.user}:${database.password}@${database.host}:${database.port}/${database.database}`);
    // The actual admission URL contract permits only sslmode. The owned CA is
    // trusted through the parent's NODE_EXTRA_CA_CERTS before this process starts.
    value.searchParams.set("sslmode", "verify-full"); return value.href;
  };
  Object.assign(process.env, { NODE_ENV: "production", LOG_LEVEL: "silent", DATABASE_TARGET: "staging", STAGING_DATABASE_URL: url("course"), COURSE_LEARNER_JWT_CURRENT_SECRET: keys.learner,
    COURSE_ADMIN_JWT_CURRENT_SECRET: randomKey(), CORS_ALLOWED_ORIGINS: "https://owned-worker.vercel.app", INTERNAL_SERVICE_JWT_SECRETS: randomKey(), INTERNAL_SERVICE_ALLOWED_IPS: "127.0.0.1/32",
    COURSE_ACCOUNT_LIFECYCLE_ENABLED: "true", COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: keys.courseLifecycle, COMMUNITY_MEMBER_JWT_CURRENT_SECRET: keys.member,
    COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED: "true", COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: keys.communityLifecycle,
    DATABASE_URL: url("frontend"), FRONTEND_WRITER_ADMISSION_DATABASE_URL: url("frontend"), FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ ...input.target, user: input.roles.frontend.name, targetSha256: input.targetSha256, environment: "staging" }),
    FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", APP_VERCEL_TEAM_ID: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", VERCEL_GIT_COMMIT_SHA: input.sourceCommit,
    CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED: "true", CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED: "true", LASH_P2_CERTIFICATION_SCHEDULES: "account-lifecycle",
    CRON_SECRET: randomKey(), API_GATEWAY_STAGING_ORIGIN: "https://gateway.owned.invalid",
    VERCEL_OIDC_TOKEN: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString("base64url")}.owned` });
  ownedSecrets.push(process.env.CRON_SECRET, process.env.VERCEL_OIDC_TOKEN, process.env.COURSE_ADMIN_JWT_CURRENT_SECRET, process.env.INTERNAL_SERVICE_JWT_SECRETS);
  const connect = async service => { const client = new Client({ ...input.databases[service], ssl: { rejectUnauthorized: true, ca }, options: "-c search_path=public" }); clients.push(client); await client.connect(); return client; };
  const operator = new Client({ ...input.target, password: undefined, ssl: { rejectUnauthorized: true, ca }, options: "-c search_path=public" }); clients.push(operator); await operator.connect();
  const withOwner = async task => { await operator.query(`SET ROLE "${input.owner.name}"`); try { return await task(); } finally { await operator.query("RESET ROLE"); } };
  const userId = randomUUID(), courseId = randomUUID(), commandId = randomUUID(), at = new Date().toISOString();
  const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt: at };
  let closeFrontend;
  try {
    const db = {}, repos = {}, courseOptions = {};
    const load = (service, file) => import(pathToFileURL(join(input.sources[service], file)).href);
    for (const service of ["course", "community"]) {
      phase = "load-actual-" + service;
      process.env.STAGING_DATABASE_URL = url(service);
      const require = createRequire(join(input.sources[service], "package.json")), { Pool } = require("pg"), { drizzle } = require("drizzle-orm/node-postgres");
      const pool = new Pool({ ...input.databases[service], ssl: { rejectUnauthorized: true, ca }, max: 4, options: "-c search_path=public" }); pools.push(pool);
      db[service] = drizzle(pool, { schema: await load(service, "src/db/schema.ts") });
      repos[service] = (await load(service, "src/accounts/lifecycle-repository.ts")).createAccountLifecycleRepository(db[service]);
      const lifecycle = (await load(service, "src/accounts/lifecycle-auth.ts")).createAccountLifecycleVerifier({ currentSecret: service === "course" ? keys.courseLifecycle : keys.communityLifecycle });
      const options = { accountLifecycle: { repository: repos[service], authVerifier: lifecycle } };
      if (service === "course") {
        const auth = await load(service, "src/auth/first-party.ts");
        options.authVerifier = auth.createFirstPartyJwtVerifier({ learner: { currentSecret: keys.learner } }); options.accountAccessReader = repos.course;
        options.courseRepository = (await load(service, "src/courses/course.repository.ts")).createDrizzleCourseRepository(db.course);
        options.entitlementRepository = (await load(service, "src/video/video.repository.ts")).createDrizzleEntitlementRepository(db.course);
        options.lessonProgressRepository = (await load(service, "src/progress/lesson-progress.repository.ts")).createDrizzleLessonProgressRepository(db.course);
        options.accountLifecycle.rateLimit = { maxPerMinute: 1000, burst: 1000, scope: "owned-worker-lifecycle", store: new (await load(service, "src/rate-limit/drizzle-rate-limit-store.ts")).DrizzleRateLimitStore(db.course) };
        Object.assign(courseOptions, options);
      } else {
        options.accountLifecycle.rateLimitStore = (await load(service, "src/http/shared-rate-limit.ts")).createSharedRateLimitStore(db.community);
      }
      const app = await (await load(service, "src/app.ts")).buildApp(options); await app.ready(); apps.push(app);
    }
    const course = await connect("course"), front = await connect("frontend");
    phase = "source-fixture-free-grant-and-command";
    await course.query("INSERT INTO public.courses(id,slug,title,status,price_cents,currency,access_mode) VALUES($1,$2,'Owned course','published',0,'CAD','free')", [courseId, "owned-"+courseId]);
    await (await load("course", "src/entitlements/free-enrollment.repository.ts")).createDrizzleFreeEnrollmentRepository(db.course).enrollFree({ userId, courseId, idempotencyKey: randomUUID() });
    await front.query("INSERT INTO public.customer_users(id,email,status,account_version) VALUES($1,'owned-worker@example.invalid','suspended',1)", [userId]);
    await front.query("INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command) VALUES($1,$2,1,$3,'suspend',$4,$5)", [commandId, userId, randomUUID(), at, command]);
    for (const service of ["course", "community"]) await front.query("INSERT INTO public.customer_account_deliveries(command_id,receiver) VALUES($1,$2)", [commandId, service]);
    phase = "actual-frontend-cron";
    const { GET } = await import("../../../src/app/api/cron/account-lifecycle/route.ts");
    ({ closePrivateDbPool: closeFrontend } = await import("../../../src/lib/private-db/client.ts"));
    console.info = line => { if (typeof line === "string" && line.includes("P2_LIFECYCLE_CRON_ADMITTED")) traces.push(JSON.parse(line)); };
    const receiverResponses = [];
    const server = createServer({ cert: readFileSync(input.certificate), key: readFileSync(input.key) }, async (req, res) => {
      if (req.url === "/api/cron/account-lifecycle") {
        const response = await GET(new Request("https://owned-worker.vercel.app/api/cron/account-lifecycle", { headers: { authorization: req.headers.authorization ?? "", "x-request-id": "untrusted-caller-id" } }));
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
      }
      const match = /^\/(course|community)(\/v1\/internal\/accounts\/commands)$/u.exec(req.url ?? "");
      if (match) { res.once("finish", () => receiverResponses.push({ service: match[1], httpStatus: res.statusCode })); req.url = match[2]; apps[match[1] === "course" ? 0 : 1].routing(req, res); return; }
      if (req.url?.startsWith("/v1/student/")) { apps[0].routing(req, res); return; }
      res.writeHead(404); res.end();
    }); servers.push(server); await new Promise(done => server.listen(0, "127.0.0.1", done));
    const origin = `https://127.0.0.1:${server.address().port}`;
    globalThis.fetch = (value, options) => { const selected = new URL(typeof value === "string" || value instanceof URL ? value : value.url); assert.equal(selected.origin, "https://gateway.owned.invalid"); return originalFetch(origin + selected.pathname, options); };
    const direct = secret => originalFetch(origin + "/api/cron/account-lifecycle", { headers: { authorization: "Bearer " + secret } });
    const privateRequest = (options, receive) => { assert.equal(options.hostname, "course-tls"); assert.equal(options.port, 8443); assert.equal(options.rejectUnauthorized, true); return request({ ...options, hostname: "127.0.0.1", port: server.address().port }, receive); };
    const denialInput = { version: 1, mode: "course-http", environment: "staging", bindingSha256: "c".repeat(64), subject: userId, courseId,
      currentKey: keys.learner, gatewayCaSha256: hash(ca), runtimeEnvironment: null, target: null };
    phase = "actual-course-baseline";
    await assert.rejects(observeCourseSuspensionDenial(denialInput, { ca, request: privateRequest }));
    const learnerToken = signProbeToken({ version: 1, iss: "lash-her-frontend", aud: "lash-her-course-api:learner", sub: userId, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, jti: randomUUID() }, keys.learner);
    const baseline = await originalFetch(origin+`/v1/student/courses/${courseId}`, { headers: { authorization: "Bearer "+learnerToken } }); assert.equal(baseline.status, 200); await baseline.arrayBuffer();
    checks.push("actual-course-protected200-before-command-cannot-qualify-denial");
    await operator.query("SELECT pg_advisory_lock(hashtext($1))", ["lash-her:private-db:migrations"]);
    phase = "actual-closed-credential-controls";
    let epoch = (await withOwner(() => changeFrontendAdmission(operator, { environment: "staging", targetSha256: input.targetSha256 }, "1", { newWork: false, recovery: false }))).epoch;
    const bad = await direct("owned-intentionally-invalid-key"); assert.equal(bad.status, 401); assert.equal(bad.headers.get("x-request-id"), null); await bad.arrayBuffer();
    const closed = await direct(process.env.CRON_SECRET); assert.equal(closed.status, 503); assert.equal(closed.headers.get("x-request-id"), null); await closed.arrayBuffer();
    assert.equal((await withOwner(async () => (await operator.query("SELECT count(*)::int AS count FROM frontend_admission.operations")).rows[0])).count, 0);
    checks.push("actual-bad401-validclosed503-no-header-or-ledger-operation");
    epoch = (await withOwner(() => changeFrontendAdmission(operator, { environment: "staging", targetSha256: input.targetSha256 }, epoch, { newWork: false, recovery: true }))).epoch;
    phase = "actual-one-direct-worker-invocation";
    const response = await direct(process.env.CRON_SECRET), operationId = response.headers.get("x-request-id"), workerBody = await response.json();
    if (response.status !== 200) workerFailure = { status: response.status, admittedUuidPresent: Boolean(operationId), receiverResponses,
      resultCounts: Object.fromEntries(Object.entries(workerBody).filter(([key, value]) => ["acknowledged", "retrying", "blocked", "exportsReady", "expired"].includes(key) && typeof value === "number")),
      deliveries: (await front.query("SELECT receiver,status,attempts,last_error AS error FROM customer_account_deliveries WHERE command_id=$1 ORDER BY receiver", [commandId])).rows };
    assert.equal(response.status, 200);
    assert.deepEqual(workerBody, { acknowledged: 2, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 });
    assert.match(operationId, /^[a-f0-9-]{36}$/u); assert.notEqual(operationId, "untrusted-caller-id");
    const operations = await withOwner(async () => (await operator.query("SELECT id::text,producer_sha256,source_sha,database_role::text AS role_oid,epoch::text,kind,state FROM frontend_admission.operations")).rows);
    phase = "actual-header-ledger-join";
    assert.equal(operations.length, 1); assert.deepEqual(operations[0], { id: operationId, producer_sha256: "b".repeat(64), source_sha: input.sourceCommit, role_oid: input.roles.frontend.oid, epoch, kind: "recovery", state: "completed" });
    assert.equal(traces.length, 1); assert.equal(traces[0].operationId, operationId);
    checks.push("actual-cron-header-joins-real-admission-uuid-source-producer-role-epoch-completed");
    const deliveries = (await front.query("SELECT receiver,status,attempts,lease_id,lease_until,acknowledged_at FROM customer_account_deliveries WHERE command_id=$1 ORDER BY receiver", [commandId])).rows;
    assert.equal(deliveries.length, 2); assert.ok(deliveries.every(row => row.status === "acknowledged" && row.attempts === 1 && row.lease_id === null && row.lease_until === null && row.acknowledged_at));
    checks.push("actual-normal-worker-delivers-canonical-command-both-real-api-repositories-and-persists-both-acks");
    epoch = (await withOwner(() => changeFrontendAdmission(operator, { environment: "staging", targetSha256: input.targetSha256 }, epoch, { newWork: false, recovery: false }))).epoch;
    const courseDenied = await observeCourseSuspensionDenial(denialInput, { ca, request: privateRequest }); assert.equal(courseDenied.httpStatus, 403);
    await assert.rejects(observeCourseSuspensionDenial({ ...denialInput, currentKey: randomKey() }, { ca, request: privateRequest }));
    checks.push("actual-course-current-signed-learner403-account-restriction-and-wrong-key401-refusal");
    phase = "actual-community-private-guard";
    const configured = { ...await load("community", "src/config/env.ts"), ...await load("community", "src/config/runtime.ts") };
    const runtimeEnvironment = { DATABASE_TARGET: "staging", STAGING_DATABASE_URL: url("community"), COMMUNITY_MEMBER_JWT_CURRENT_SECRET: keys.member,
      COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED: "true", COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: keys.communityLifecycle };
    const communityInput = { ...denialInput, mode: "community-private-guard", currentKey: keys.member, gatewayCaSha256: null, runtimeEnvironment,
      target: { host: "127.0.0.1", port: input.databases.community.port, database: input.databases.community.database, runtimeRole: input.roles.community.name, runtimeRoleOid: input.roles.community.oid, serverMajor: input.major } };
    const modules = { configured, ...await load("community", "src/auth/community-user-auth.ts"), ...await load("community", "src/auth/community-user-routes.ts"),
      ...await load("community", "src/accounts/lifecycle-repository.ts"), require: createRequire(join(input.sources.community, "package.json")) };
    const communityDenied = await observeCommunitySuspensionDenial(communityInput, { load: async () => modules });
    assert.equal(communityDenied.evidenceClass, "deployed-private-community-account-access-guard"); assert.equal(communityDenied.httpStatus, null); assert.equal(communityDenied.denialStatusCode, 403);
    await assert.rejects(observeCommunitySuspensionDenial({ ...communityInput, currentKey: randomKey() }, { load: async () => modules }));
    await assert.rejects(observeCommunitySuspensionDenial({ ...communityInput, target: { ...communityInput.target, runtimeRoleOid: "1" } }, { load: async () => modules }));
    checks.push("actual-community-configured-current-member-verifier-real-tls-db-repository-and-actual-guard403");
    checks.push("community-wrong-key-and-wrong-runtime-role-oid-refuse-without-http-feature-claim");
    assert.equal((await withOwner(async () => (await operator.query("SELECT count(*)::int AS count FROM frontend_admission.operations WHERE state IN ('active','uncertain')")).rows[0])).count, 0);
    checks.push("actual-final-both-gates-closed-global-active-uncertain-zero");
    const receipt = { version: 1, status: "P2_LIFECYCLE_WORKER_OWNED_PASS", checks, skipped: 0, actualFrontendCron: true, actualHeaderLedgerJoin: true,
      actualCourseProtectedHttp: true, actualCommunityConfiguredGuard: true, receiverDeniedCount: 2, receiverDeniedHttpCount: 1,
      frontendGlobalActive: 0, frontendGlobalUncertain: 0, userTokenExpiryQualified: false, sourceHostPathQualified: false, releaseAccepted: false };
    const serialized = JSON.stringify(receipt); for (const value of [userId, commandId, ...Object.values(keys), process.env.CRON_SECRET]) assert.equal(serialized.includes(value), false);
    return receipt;
  } finally { globalThis.fetch = originalFetch; console.info = originalInfo; for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    for (const app of apps.reverse()) await app.close(); for (const pool of pools.reverse()) await pool.end(); await closeFrontend?.(); for (const client of clients.reverse()) await client.end(); }
}
main().then(value => process.stdout.write(JSON.stringify(value)+"\n")).catch(error => {
  let diagnostic = String(error?.message ?? "failure"); for (const secret of ownedSecrets) if (secret) diagnostic = diagnostic.replaceAll(secret, "{owned-secret}");
  diagnostic = diagnostic.replace(/postgres(?:ql)?:\/\/[^\s"']+/gu, "{owned-database-url}").replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}").slice(0, 500);
  process.stderr.write(JSON.stringify({ status: "P2_WORKER_OWNED_CHILD_FAILED", phase, code: error?.code ?? error?.name ?? "Error", diagnostic,
    ...(typeof error?.actual === "number" ? { actual: error.actual } : {}), ...(typeof error?.expected === "number" ? { expected: error.expected } : {}), ...(workerFailure ? { workerFailure } : {}) })+"\n"); process.exitCode = 1;
});
