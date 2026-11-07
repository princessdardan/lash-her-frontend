// Executes the real frontend lifecycle store/worker/typed clients/signers with
// a local gateway workload edge. No receiver receipts or DB effects are mocked.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let pools = [], hooks, controlId = 0;
const controls = new Map();
function control(kind, values = {}) { const id = ++controlId; return new Promise((done, fail) => { controls.set(id, { done, fail }); process.send({ control: kind, id, ...values }); }); }
async function journey(input) {
  const { root, keys, receivers } = input;
  const checks = [], findings = [], require = createRequire(join(root, "package.json"));
  const { Pool } = require("pg"), { drizzle } = require("drizzle-orm/node-postgres");
  const sqlPools = {};
  for (const [service, database] of Object.entries(input.databases)) {
    assert.equal(database.host, "127.0.0.1"); assert.match(database.database, /^owned_lifecycle_(frontend|course|community)_test$/u);
    const pool = new Pool({ ...database, ssl: { rejectUnauthorized: true, ca: input.ca }, enableChannelBinding: true, max: 5 }); pools.push(pool); sqlPools[service] = pool;
  }
  const connection = new URL("postgresql://127.0.0.1");
  connection.username = input.databases.frontend.user; connection.password = input.databases.frontend.password; connection.port = String(input.databases.frontend.port); connection.pathname = `/${input.databases.frontend.database}`; connection.searchParams.set("sslmode", "verify-full");
  Object.assign(process.env, { DATABASE_URL: connection.toString(), FRONTEND_WRITER_ADMISSION_DATABASE_URL: connection.toString(), FRONTEND_WRITER_ADMISSION_MODE: "enforce", FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(input.target), FRONTEND_WRITER_PRODUCER_SHA256: input.producerSha256, VERCEL_GIT_COMMIT_SHA: input.sourceCommit,
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_VERCEL_TEAM_ID: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", VERCEL_PROJECT_ID: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", ...keys });
  hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return nextResolve(pathToFileURL(join(root, "node_modules/server-only/empty.js")).href, context);
    if (specifier.startsWith("@/")) { const path = join(root, "src", specifier.slice(2)); for (const candidate of [path, `${path}.ts`, `${path}.mjs`]) if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context); }
    return nextResolve(specifier, context);
  } });
  const load = file => import(pathToFileURL(join(root, file)).href);
  const { createAccountLifecycleStore } = await load("src/lib/customer-lifecycle/store.ts");
  const { runAccountWriter } = await load("src/lib/customer-lifecycle/context.ts");
  const { processAccountLifecycle } = await load("src/lib/customer-lifecycle/worker.ts");
  const { createAccountLifecycleClient } = await load("src/lib/api-integration/account-lifecycle-client.ts");
  const { createLifecycleServiceTokenIssuer } = await load("src/lib/api-integration/lifecycle-service-jwt.ts");
  const { createApplicationTokenIssuer } = await load("src/lib/api-integration/application-jwt.ts");
  const { createGatewayTransport } = await load("src/lib/api-integration/gateway-transport.ts");
  const authSchema = await load("src/lib/customer-auth/schema.ts");
  const lifecycleSchema = await load("src/lib/customer-lifecycle/schema.ts");
  const db = drizzle({ client: sqlPools.frontend, schema: { ...authSchema, ...lifecycleSchema } });
  let clock = input.clock;
  const store = createAccountLifecycleStore(() => db, () => new Date(clock));
  const issuer = createLifecycleServiceTokenIssuer({ getEnvironment: () => keys, now: () => Math.floor(clock / 1000) });
  const applicationIssuer = createApplicationTokenIssuer({ getEnvironment: () => keys, now: () => Math.floor(clock / 1000) });
  const nativeFetch = globalThis.fetch;
  let communityOutage = false, loseCourseReceipt = false;
  const calls = [];
  const gateway = createGatewayTransport({ origin: "https://owned-gateway.invalid", getWorkloadToken: async () => "owned-workload-proof", fetch: async (url, init) => {
    const target = new URL(url); assert.equal(target.origin, "https://owned-gateway.invalid");
    const match = /^\/(course|community)(\/v1\/.*)$/u.exec(target.pathname); assert.ok(match);
    const [, receiver, path] = match; assert.equal(init.headers["x-lash-workload-token"], "owned-workload-proof");
    assert.match(receivers[receiver], /^http:\/\/127\.0\.0\.1:\d+$/u);
    calls.push({ receiver, path, method: init.method });
    if (communityOutage && receiver === "community" && init.method === "POST") throw new Error("Owned gateway edge unavailable");
    const response = await nativeFetch(receivers[receiver] + path, init);
    if (loseCourseReceipt && receiver === "course" && init.method === "POST" && path === "/v1/internal/accounts/commands") { loseCourseReceipt = false; assert.equal(response.status, 200); await response.arrayBuffer(); throw new Error("Owned gateway response lost after commit"); }
    return response;
  } });
  const clients = Object.fromEntries(["course", "community"].map(receiver => [receiver, createAccountLifecycleClient({ receiver, mintServiceToken: () => issuer(receiver), getTransport: () => gateway, run: async (_kind, task) => task(), now: () => clock })]));
  const admitted = task => runAccountWriter("new-work", task);
  async function directDeliver(receiver, command) {
    // Keep a known negative receipt outside the whole-operation exception path,
    // matching the typed client's own outcome envelope and the worker's catch.
    const outcome = await runAccountWriter("recovery", async () => {
      try { return { receipt: await clients[receiver].deliverCommand(command) }; }
      catch (error) { return { failure: error }; }
    });
    if (outcome.failure) throw outcome.failure;
    return outcome.receipt;
  }
  async function recover(uncertain = false) {
    try { const result = await runAccountWriter("recovery", () => processAccountLifecycle({ store, client: receiver => clients[receiver] })); assert.equal(uncertain, false, "Uncertain parent operation must not report clean completion"); return result; }
    catch (error) { if (!uncertain) throw error; assert.equal(error.name, "WriterAdmissionError"); assert.equal(error.code, "outcome"); return null; }
  }
  async function advance(ms) { clock += ms; await control("clock", { clock }); }
  const userId = randomUUID(), otherId = randomUUID(), adminId = randomUUID();
  const email = `owned-${userId}@example.invalid`, session = { userId, tokenHash: randomUUID() };
  await db.insert(authSchema.customerUsers).values([{ id: userId, email, name: "Owned Private Profile", emailVerified: new Date(clock), createdAt: new Date(clock) }, { id: otherId, email: `other-${otherId}@example.invalid` }]);
  await db.insert(authSchema.customerSessions).values({ ...session, expires: new Date(clock + 86400000), createdAt: new Date(clock) });
  await db.insert(authSchema.customerProviderLinks).values({ userId, provider: "google", providerAccountId: `owned-provider-${userId}`, type: "oidc", createdAt: new Date(clock) });
  await db.insert(authSchema.customerVerificationTokens).values({ token: randomUUID(), identifier: email, expires: new Date(clock + 900000) });
  await admitted(() => store.updatePreferences(session, true));
  const learner = () => applicationIssuer({ profile: "course-learner", customerId: userId });
  const member = () => applicationIssuer({ profile: "community-member", customerId: userId });
  const editor = () => applicationIssuer({ profile: "course-admin", adminId, capabilities: ["course-editor"] });
  async function api(service, path, { method = "GET", body, token, key, expected = 200 } = {}) {
    const headers = { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key === undefined ? {} : { "x-idempotency-key": key }) };
    const response = await nativeFetch(receivers[service] + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (response.status !== expected && expected === 403 && response.status === 500 && data.code === "FST_ERR_FAILED_ERROR_SERIALIZATION") {
      // Continue independent cases to report the complete source defect, but
      // the launcher fails the overall qualification when findings exist.
      findings.push({ service, method, path: path.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gu, "{uuid}"), expectedStatus: 403, actualStatus: 500, code: data.code });
    } else assert.equal(response.status, expected, `${service} ${method} ${path}: ${JSON.stringify(data)}`);
    if (/^\/v1\/(student|admin|internal)\//u.test(path) || path === "/owned/member") assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
    return data;
  }
  const course = (await api("course", "/v1/admin/courses", { method: "POST", token: editor(), body: { slug: `owned-${randomUUID()}`, title: "Owned lifecycle course", taxClassification: "reviewed-owned-fixture" }, expected: 201 })).course;
  const courseModule = (await api("course", `/v1/admin/courses/${course.id}/modules`, { method: "POST", token: editor(), body: { expectedCourseRevision: 1, title: "Module", slug: "module", position: 1 }, expected: 201 })).module;
  const lesson = (await api("course", `/v1/admin/modules/${courseModule.id}/lessons`, { method: "POST", token: editor(), body: { expectedCourseRevision: 2, title: "Learning", slug: "learning", position: 1, content: "Owned lesson text" }, expected: 201 })).lesson;
  const quiz = await api("course", `/v1/admin/lessons/${lesson.id}/quiz`, { method: "PUT", token: editor(), body: { expectedCourseRevision: 3, document: { version: 1, questions: [{ id: "question", prompt: "Choose", options: [{ id: "correct", text: "Correct" }, { id: "other", text: "Other" }], correctOptionId: "correct", feedback: "Owned feedback" }] } } });
  await api("course", `/v1/admin/courses/${course.id}`, { method: "PATCH", token: editor(), body: { expectedRevision: 4, status: "published" } });
  const freeKey = randomUUID();
  const grant = await api("course", `/v1/student/courses/${course.id}/enrollments`, { method: "POST", token: learner(), key: freeKey, body: { idempotencyKey: freeKey }, expected: 201 });
  const progress = await api("course", `/v1/student/lessons/${lesson.id}/progress`, { method: "POST", token: learner(), body: { expectedProgressRevision: 0, maxPositionSeconds: 30, resumePositionSeconds: 12 } });
  const attempt = (await api("course", `/v1/student/lessons/${lesson.id}/quiz/attempts`, { method: "POST", token: learner(), body: { quizRevision: quiz.quiz.revision, requestId: randomUUID(), answers: [{ questionId: "question", optionId: "correct" }] } })).attempt;
  assert.equal(attempt.passed, true);
  await api("course", `/v1/student/lessons/${lesson.id}/progress`, { method: "POST", token: learner(), body: { expectedProgressRevision: 0, resumePositionSeconds: 1 }, expected: 409 });
  await sqlPools.course.query("update users set email=$1 where id=$2", [email, userId]);
  const loadCourse = file => import(pathToFileURL(join(input.courseRoot, "src/integrations/community", file)).href);
  const { createCommunityHttpTransport } = await loadCourse("http-transport/community-http-transport.ts");
  const { createCommunityEnrollmentPublisher } = await loadCourse("publisher/community-publisher.ts");
  const { createDrizzleCommunityEnrollmentPublisherRepository } = await loadCourse("persistence/drizzle-publisher.repository.ts");
  const transport = createCommunityHttpTransport({ endpoint: receivers.community + "/v1/internal/course/enrollment-events", currentSecret: keys.COURSE_PUBLISHER_JWT_CURRENT_SECRET, now: () => new Date(clock), nowSeconds: () => Math.floor(clock / 1000) });
  const publisher = createCommunityEnrollmentPublisher({
    repository: createDrizzleCommunityEnrollmentPublisherRepository(drizzle(sqlPools.course)),
    transport, now: () => new Date(Math.max(clock, Date.now())),
  });
  async function publishTransition(customerId, courseId, version, state) {
    assert.equal(await publisher.runOnce(), 1, `Expected one ${state} transition at version ${version}`);
    const event = (await sqlPools.course.query(`
      select event_id as "eventId", canonical_body as "canonicalBody", canonical_digest, stream_id, stream_version, state, delivered_at, lease_owner
      from community_enrollment_outbox where canonical_body::jsonb #>> '{data,userId}'=$1
        and canonical_body::jsonb #>> '{data,courseId}'=$2 and stream_version=$3`, [customerId, courseId, version])).rows[0];
    assert.ok(event?.delivered_at);
    assert.equal(event.state, "delivered");
    assert.equal(event.lease_owner, null);
    const inbox = await sqlPools.community.query("select canonical_digest, stream_id, stream_version, state, status from course_enrollment_inbox where event_id=$1", [event.eventId]);
    assert.deepEqual(inbox.rows, [{ canonical_digest: event.canonical_digest, stream_id: event.stream_id, stream_version: version, state, status: "applied" }]);
    const projection = await sqlPools.community.query("select state, status, applied_version, source_event_id from course_enrollment_projections where user_id=$1 and course_id=$2", [customerId, courseId]);
    assert.deepEqual(projection.rows, [{ state, status: "current", applied_version: version, source_event_id: event.eventId }]);
    return event;
  }
  await publishTransition(userId, course.id, 1, "active");
  await api("community", "/owned/member", { token: member() });
  checks.push("real-admin-authoring-free-ledger-grant-progress-quiz-and-Course-publisher-to-Community-receiver");

  const paidUser = randomUUID();
  const paidLearner = () => applicationIssuer({ profile: "course-learner", customerId: paidUser });
  const support = () => applicationIssuer({ profile: "course-admin", adminId, capabilities: ["course-support"] });
  const paidCourse = (await api("course", "/v1/admin/courses", { method: "POST", token: editor(),
    body: { slug: `owned-paid-${randomUUID()}`, title: "Owned paid course", accessMode: "paid", priceCents: 1000, taxClassification: "reviewed-owned-fixture" }, expected: 201 })).course;
  const paidModule = (await api("course", `/v1/admin/courses/${paidCourse.id}/modules`, { method: "POST", token: editor(),
    body: { expectedCourseRevision: 1, title: "Module", slug: "module", position: 1 }, expected: 201 })).module;
  await api("course", `/v1/admin/modules/${paidModule.id}/lessons`, { method: "POST", token: editor(),
    body: { expectedCourseRevision: 2, title: "Paid lesson", slug: "paid-lesson", position: 1, content: "Owned paid lesson text" }, expected: 201 });
  await api("course", `/v1/admin/courses/${paidCourse.id}`, { method: "PATCH", token: editor(), body: { expectedRevision: 3, status: "published" } });

  const unrelatedKey = randomUUID();
  await api("course", `/v1/student/courses/${course.id}/enrollments`, { method: "POST", token: paidLearner(),
    key: unrelatedKey, body: { idempotencyKey: unrelatedKey }, expected: 201 });
  await publishTransition(paidUser, course.id, 1, "active");
  async function grantPaid() {
    const key = `owner-paid:${randomUUID()}`;
    const response = await api("course", "/v1/admin/entitlements/grants", { method: "POST", token: support(), key,
      body: { userId: paidUser, courseId: paidCourse.id, reason: "[paid-course revision 4] Owned publisher fixture", idempotencyKey: key }, expected: 201 });
    assert.equal(response.effects[0].effectType, "grant_created");
    return response.effects[0].grantId;
  }
  async function revokePaid(grantId) {
    const key = `owner-paid-revoke:${randomUUID()}`;
    const response = await api("course", "/v1/admin/entitlements/revocations", { method: "POST", token: support(), key,
      body: { scope: "grantId", grantId, reason: "[paid-course revision 4] Owned publisher fixture", idempotencyKey: key } });
    assert.deepEqual(response.effects, [{ grantId, effectType: "grant_revoked", previousStatus: "active", resultingStatus: "revoked" }]);
  }
  const paidGrant = await grantPaid();
  const activated = await publishTransition(paidUser, paidCourse.id, 1, "active");
  const independentGrant = await grantPaid();
  await revokePaid(paidGrant);
  assert.equal(await publisher.runOnce(), 0);
  await api("course", `/v1/student/courses/${paidCourse.id}`, { token: paidLearner() });

  // Import a historical grant without changing the immutable live grant rows.
  const courseSchema = await import(pathToFileURL(join(input.courseRoot, "src/db/schema.ts")).href);
  await drizzle(sqlPools.course).transaction(async tx => {
    const userId = randomUUID(), enrollmentId = randomUUID(), idempotencyKey = randomUUID(), requestHash = "e".repeat(64);
    await tx.insert(courseSchema.users).values({ id: userId });
    await tx.insert(courseSchema.enrollments).values({ id: enrollmentId, userId, courseId: paidCourse.id, source: "import" });
    await tx.insert(courseSchema.entitlementIdempotencyKeys).values({ idempotencyKey, requestHash, commandType: "internal_grant" });
    await tx.insert(courseSchema.entitlementGrants).values({ enrollmentId, userId, courseId: paidCourse.id, idempotencyKey, requestHash,
      externalOrderId: `owned-historical-${idempotencyKey}`, provider: "square", grantReason: "import", expiresAt: new Date(clock + 86400000) });
  });
  await revokePaid(independentGrant);
  await api("course", `/v1/student/courses/${paidCourse.id}`, { token: paidLearner(), expected: 403 });
  const revoked = await publishTransition(paidUser, paidCourse.id, 2, "revoked");
  assert.equal(revoked.stream_id, activated.stream_id);
  assert.notEqual(revoked.eventId, activated.eventId);
  assert.equal((await transport.deliver(revoked)).kind, "acknowledged");
  assert.equal((await sqlPools.community.query("select count(*)::integer as count from course_enrollment_inbox where stream_id=$1", [revoked.stream_id])).rows[0].count, 2);
  assert.deepEqual((await sqlPools.community.query("select state, applied_version, source_event_id from course_enrollment_projections where stream_id=$1", [revoked.stream_id])).rows,
    [{ state: "revoked", applied_version: 2, source_event_id: revoked.eventId }]);
  assert.deepEqual((await sqlPools.course.query("select status, external_order_id, external_payment_id, provider from entitlement_grants where id = any($1::uuid[])", [[paidGrant, independentGrant]])).rows,
    Array.from({ length: 2 }, () => ({ status: "revoked", external_order_id: null, external_payment_id: null, provider: null })));
  await api("course", `/v1/student/courses/${course.id}`, { token: paidLearner() });
  assert.equal((await sqlPools.community.query("select state from course_enrollment_projections where user_id=$1 and course_id=$2", [paidUser, course.id])).rows[0].state, "active");
  checks.push("audited-orderless-paid-grants-preserve-independent-access-and-publish-exact-last-revocation-to-Community");

  const exportKey = randomUUID();
  const exported = await admitted(() => store.request({ userId, action: "export", idempotencyKey: exportKey, requester: { kind: "customer", session } }));
  assert.deepEqual(await admitted(() => store.request({ userId, action: "export", idempotencyKey: exportKey, requester: { kind: "customer", session } })), exported);
  loseCourseReceipt = true; await recover(true);
  assert.equal((await sqlPools.course.query("select count(*)::integer as count from account_lifecycle_commands where command_id=$1", [exported.commandId])).rows[0].count, 1);
  assert.equal(await store.getExport(userId, exported.commandId), null);
  await advance(11000); const recovery = await recover(); assert.equal(recovery.exportsReady, 1);
  const artifact = await store.getExport(userId, exported.commandId); assert.ok(artifact);
  assert.equal(artifact.userId, userId); assert.equal(artifact.frontend.profile.email, email);
  assert.ok(artifact.course.progress.some(row => row.lessonId === lesson.id && row.resumePositionSeconds === 12));
  assert.ok(artifact.course.attempts.some(row => row.id === attempt.id && row.passed));
  assert.ok(artifact.course.grants.some(row => row.id === grant.grantId && row.grantReason === "free"));
  assert.equal(artifact.community.projections.length, 1); assert.equal(artifact.community.inbox.length, 1);
  assert.equal(await store.getExport(otherId, exported.commandId), null);
  for (const receiver of ["course", "community"]) {
    assert.equal((await directDeliver(receiver, exported)).status, "duplicate");
    await api(receiver, `/v1/internal/accounts/exports/${exported.commandId}`, { token: issuer(receiver === "course" ? "community" : "course"), expected: 401 });
    await api(receiver, "/v1/internal/accounts/commands", { method: "POST", token: learner(), key: exported.commandId, body: exported, expected: 401 });
  }
  checks.push("real-dedicated-JWTs-and-runtime-validated-export-aggregation-after-lost-committed-receipt");
  checks.push("private-UUID-owner-export-and-cross-profile-service-credential-isolation");
  const snapshot = (await sqlPools.frontend.query("select expires_at from customer_account_exports where command_id=$1", [exported.commandId])).rows[0];
  const remaining = snapshot.expires_at.getTime() - clock; assert.ok(remaining > 0 && remaining <= 86400000);
  await advance(remaining - 1); assert.deepEqual(await store.getExport(userId, exported.commandId), artifact);
  await advance(1); assert.equal(await store.getExport(userId, exported.commandId), null);
  for (const receiver of ["course", "community"]) await api(receiver, `/v1/internal/accounts/exports/${exported.commandId}`, { token: issuer(receiver), expected: 404 });
  await admitted(() => store.expireExports());
  assert.deepEqual((await control("receiver_cleanup")).map(row => row.expired), [1, 1]);
  for (const receiver of ["course", "community"]) { assert.equal((await directDeliver(receiver, exported)).status, "duplicate"); await api(receiver, `/v1/internal/accounts/exports/${exported.commandId}`, { token: issuer(receiver), expected: 404 }); }
  const cleared = (await sqlPools.frontend.query("select status,data,frontend_data from customer_account_exports where command_id=$1", [exported.commandId])).rows[0];
  assert.deepEqual(cleared, { status: "expired", data: null, frontend_data: null });
  checks.push("exact-24-hour-expiry-physical-cleanup-and-export-replay-never-renews-private-data");

  const admin = { kind: "admin", adminId };
  const suspend = await admitted(() => store.request({ userId, action: "suspend", idempotencyKey: randomUUID(), requester: admin }));
  assert.equal(suspend.accountVersion, 2);
  assert.equal((await sqlPools.frontend.query("select count(*)::integer as count from customer_sessions where user_id=$1", [userId])).rows[0].count, 0);
  communityOutage = true; await recover(true);
  // Recovery stops after uncertainty. A new admitted pass may process the
  // other receiver while the failed delivery waits for its durable backoff.
  await recover();
  await api("course", `/v1/student/courses/${course.id}`, { token: learner(), expected: 403 });
  await api("course", `/v1/student/lessons/${lesson.id}/progress`, { method: "POST", token: learner(), body: { expectedProgressRevision: progress.progress.revision, resumePositionSeconds: 99 }, expected: 403 });
  const restore = await admitted(() => store.request({ userId, action: "restore", idempotencyKey: randomUUID(), requester: admin }));
  assert.equal(restore.accountVersion, 3); await advance(11000); await recover(true); await recover();
  assert.equal((await sqlPools.frontend.query("select status from customer_users where id=$1", [userId])).rows[0].status, "suspended");
  assert.equal((await sqlPools.course.query("select status,account_version from account_lifecycle_states where user_id=$1", [userId])).rows[0].status, "active");
  assert.equal((await sqlPools.community.query("select count(*)::integer as count from account_lifecycle_commands where command_id=$1", [restore.commandId])).rows[0].count, 0);
  communityOutage = false;
  await assert.rejects(directDeliver("community", restore), error => error.receiverCode === "account_version_conflict" && error.retryable === true);
  communityOutage = false; await advance(21000); await recover();
  assert.equal((await sqlPools.frontend.query("select status from customer_users where id=$1", [userId])).rows[0].status, "active");
  assert.equal((await sqlPools.community.query("select status,account_version from account_lifecycle_states where user_id=$1", [userId])).rows[0].account_version, "3");
  await api("course", `/v1/student/courses/${course.id}`, { token: learner() }); await api("community", "/owned/member", { token: member() });
  checks.push("suspension-revokes-sessions-and-existing-protected-operation-authority");
  checks.push("receiver-outage-keeps-frontend-suspended-until-both-ordered-predecessor-and-restore-acknowledgments");

  const fresh = { userId, tokenHash: randomUUID() };
  await db.insert(authSchema.customerSessions).values({ ...fresh, expires: new Date(clock + 3600000), createdAt: new Date(clock) });
  const deleteKey = randomUUID();
  const deletion = await admitted(() => store.request({ userId, action: "delete", idempotencyKey: deleteKey, requester: { kind: "customer", session: fresh } }));
  await recover(); assert.equal(deletion.accountVersion, 4);
  assert.deepEqual(await admitted(() => store.request({ userId, action: "delete", idempotencyKey: deleteKey, requester: admin })), deletion);
  const frontend = (await sqlPools.frontend.query("select status,email,name,account_version from customer_users where id=$1", [userId])).rows[0];
  assert.equal(frontend.status, "deleted"); assert.equal(frontend.email, `deleted+${userId}@account.invalid`); assert.equal(frontend.name, null); assert.equal(frontend.account_version, "4");
  for (const table of ["customer_sessions", "customer_provider_links", "customer_account_preferences"]) assert.equal((await sqlPools.frontend.query(`select count(*)::integer as count from ${table} where user_id=$1`, [userId])).rows[0].count, 0);
  assert.equal((await sqlPools.frontend.query("select count(*)::integer as count from customer_verification_tokens where identifier=$1", [email])).rows[0].count, 0);
  assert.equal((await sqlPools.course.query("select count(*)::integer as count from lesson_progress where user_id=$1", [userId])).rows[0].count, 0);
  assert.equal((await sqlPools.course.query("select email from users where id=$1", [userId])).rows[0].email, null);
  const retained = (await sqlPools.course.query("select user_id,enrollment_id,request_id,request_hash,answers,correct_count,total_count,passed,completed,deidentified_at from quiz_attempts where id=$1", [attempt.id])).rows[0];
  assert.deepEqual({ ...retained, deidentified_at: Boolean(retained.deidentified_at) }, { user_id: null, enrollment_id: null, request_id: null, request_hash: null, answers: [], correct_count: 1, total_count: 1, passed: true, completed: true, deidentified_at: true });
  assert.equal((await sqlPools.course.query("select status from entitlement_grants where id=$1", [grant.grantId])).rows[0].status, "active");
  for (const receiver of ["course", "community"]) {
    assert.equal((await directDeliver(receiver, deletion)).status, "duplicate");
    assert.equal((await directDeliver(receiver, restore)).status, "duplicate");
    await assert.rejects(directDeliver(receiver, { ...restore, commandId: randomUUID(), accountVersion: 5 }), error => error.receiverCode === "account_deleted" && error.retryable === false);
    const state = (await sqlPools[receiver].query("select status,account_version from account_lifecycle_states where user_id=$1", [userId])).rows[0]; assert.equal(state.status, "deleted"); assert.equal(state.account_version, "4");
  }
  await api("course", `/v1/student/courses/${course.id}/enrollments`, { method: "POST", token: learner(), body: { idempotencyKey: randomUUID() }, expected: 403 });
  await api("course", `/v1/student/lessons/${lesson.id}/quiz/attempts`, { method: "POST", token: learner(), body: { quizRevision: 1, requestId: randomUUID(), answers: [{ questionId: "question", optionId: "correct" }] }, expected: 403 });
  await api("community", "/owned/member", { token: member(), expected: 403 });
  assert.equal(await store.getExport(userId, exported.commandId), null);
  checks.push("customer-fresh-session-deletion-removes-progress-profile-links-preferences-and-private-artifacts");
  checks.push("quiz-results-deidentified-once-with-immutable-grant-audit-history-retained");
  checks.push("terminal-tombstones-deny-delayed-grants-assessment-and-member-access-while-exact-replay-cannot-restore");
  assert.ok(calls.some(call => call.receiver === "course" && call.path.endsWith("/commands")) && calls.some(call => call.receiver === "community" && call.path.endsWith("/commands")));
  return { checks, findings };
}
process.on("message", async input => {
  if (input.control) { const entry = controls.get(input.id); if (entry) { controls.delete(input.id); if (input.error) entry.fail(new Error("Owned receiver control failed")); else entry.done(input.result); } return; }
  try {
    if (input.op === "stop") { for (const pool of pools) await pool.end(); hooks?.deregister(); process.send({ id: input.id, result: { stopped: true } }); process.disconnect(); return; }
    assert.equal(input.op, "journey"); const result = await journey(input); process.send({ id: input.id, result });
  } catch (error) { process.send({ id: input.id, error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "Owned frontend journey failed" }); }
});
