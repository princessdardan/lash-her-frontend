import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { currentWriterAuthoringActorId, currentWriterAuthoringOperation, currentWriterIdentityCustomerId, currentWriterIdentityEnrollment,
  currentWriterIdentityRotation, currentWriterLifecycleSelection, currentWriterOperationIdentity, currentWriterPaidAccessActorId,
  markWriterOperationUncertain, matchesWriterIdentityEnrollment } from "./context";
import { authorizeCaptureSquarePayment } from "@/lib/payments/square/square-payment-charge";
import { createHash, createHmac } from "node:crypto";
import { P2_FIRST_OWNER_PATH, p2FirstOwnerDiscoveryEmailSha256,
  p2FirstOwnerIdentitySha256 } from "../../../ops/platform/p2-first-owner-identity.mjs";
import { createWriterAdmissionRunner } from "./runtime";
import stagingRelease from "../../../ops/staging/first-release.json" with { type: "json" };
import { attestInteractiveRequest, interactiveRequestHeaders, readInteractiveRequest, withinInteractiveAdminGoogleAction, INTERACTIVE_COOKIE, INTERACTIVE_HEADER, INTERACTIVE_ORIGIN } from "./interactive-proof";
import { withWriterAdmission } from "./route";
import { resolveWriterAdmissionConfiguration, WriterAdmissionError } from "./config";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { createSquareWebhookPostHandler } from "@/app/api/webhooks/square/handler";
import { createServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";

const selectedCustomerId = "8d680a92-8071-4fd0-9da2-c4d350aa729d";
const customerIdentityPrefix = "7032712d637573746f6d65722d763100";
const customerIdentitySelector = customerIdentityPrefix + selectedCustomerId.replaceAll("-", "");

test("rotation auth admits only exact Google identity routes and the assigned operation kind", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const admin = "8e2280dc-0389-4248-b21c-f87427f9e85c";
  const courseId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const compact = (id: string) => id.replaceAll("-", "");
  const issue = (stage: string, selector: string) => {
    const body = `v2.12.${stage}.${now}.${now + 120}.${"a".repeat(32)}.${selector}`;
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const customer = issue("identity", Buffer.from("p2q-rot-cust-v1\0").toString("hex") + compact(selectedCustomerId));
  const staff = issue("identity", Buffer.from("p2q-rot-admn-v1\0").toString("hex") + compact(admin));
  const signer = issue("rotation-admin", compact(admin) + compact(courseId));
  const attest = (cookie: string, method: string, path: string, search = "") =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie }, env, now);
  const f = fixture();
  f.state.epoch = "12";
  let verified: ReturnType<typeof readInteractiveRequest> = null;
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(env), createClient: () => f.client, getInteractiveWriter: async () => verified,
  });
  for (const [cookie, actorKind, actorId, method, path, search, kind] of [
    [customer, "customer", selectedCustomerId, "GET", "/sign-in", "?callbackUrl=/courses", undefined],
    [customer, "customer", selectedCustomerId, "GET", "/api/customer-auth/csrf", "", "new-work"],
    [customer, "customer", selectedCustomerId, "POST", "/api/customer-auth/signin/google", "", "new-work"],
    [customer, "customer", selectedCustomerId, "GET", "/api/customer-auth/callback/google", "?code=owned&state=owned", "new-work"],
    [customer, "customer", selectedCustomerId, "GET", "/api/customer-auth/session", "", "new-work"],
    [staff, "admin", admin, "GET", "/admin/sign-in", "?returnTo=/admin/not-authorized", undefined],
    [staff, "admin", admin, "POST", "/admin/sign-in", "?returnTo=/admin/not-authorized", "new-work"],
    [staff, "admin", admin, "GET", "/api/auth/callback/google", "?code=owned&state=owned", "recovery"],
    [staff, "admin", admin, "GET", "/api/auth/session", "", "recovery"],
    [staff, "admin", admin, "GET", "/admin/not-authorized", "", undefined],
  ] as const) {
    const proof = attest(cookie, method, path, search);
    assert.ok(proof);
    const verify = () => readInteractiveRequest(proof, cookie, env, now);
    if (method === "POST" && path === "/admin/sign-in") assert.equal(verify(), null);
    verified = await withinInteractiveAdminGoogleAction(async () => verify());
    assert.deepEqual(verified?.identityRotation, { actorKind, actorId });
    assert.equal(verified?.identityRotationWriterKind, kind);
    assert.equal(verified?.identityCustomerId, actorKind === "customer" ? actorId : undefined);
    assert.equal(readInteractiveRequest(proof, cookie === staff ? customer : staff, env, now), null);
    await assert.rejects(run(kind === "recovery" ? "new-work" : "recovery", () => assert.fail("unselected writer kind")), WriterAdmissionError);
    if (kind) {
      await run(kind, async () => { assert.deepEqual(currentWriterIdentityRotation(), { actorKind, actorId }); });
      assert.equal(currentWriterIdentityRotation(), undefined);
    } else await assert.rejects(run("new-work", () => assert.fail("read-only landing opened a writer")), WriterAdmissionError);
  }
  for (const [cookie, method, path, search] of [
    [customer, "GET", "/sign-in", "?callbackUrl=/account"],
    [customer, "POST", "/api/customer-auth/signin/google", "?prompt=consent"],
    [customer, "GET", "/api/customer-auth/providers", ""],
    [customer, "POST", "/api/customer-auth/signin/resend", ""],
    [customer, "GET", "/api/customer-auth/callback/resend", ""],
    [customer, "POST", "/api/customer-auth/signout", ""],
    [customer, "GET", "/api/auth/session", ""],
    [staff, "GET", "/admin", ""],
    [staff, "POST", "/admin/sign-in", "?returnTo=/admin"],
    [staff, "POST", "/api/auth/signin/google", ""],
    [staff, "POST", "/api/auth/signout", ""],
    [staff, "GET", "/api/customer-auth/session", ""],
    [staff, "GET", `/api/admin/courses/${courseId}`, ""],
    [signer, "GET", `/api/admin/courses/${courseId}`, "?x=1"],
    [signer, "GET", `/api/admin/courses/${admin}`, ""],
    [signer, "PATCH", `/api/admin/courses/${courseId}`, ""],
    [signer, "GET", "/api/auth/session", ""],
  ] as const) assert.equal(attest(cookie, method, path, search), null);

  const proof = attest(signer, "GET", `/api/admin/courses/${courseId}`);
  assert.ok(proof);
  verified = readInteractiveRequest(proof, signer, env, now);
  assert.deepEqual(verified?.rotationAdmin, { actorId: admin, courseId });
  for (const kind of ["new-work", "recovery"] as const) {
    await assert.rejects(run(kind, () => assert.fail("closed signer entered the writer ledger")), WriterAdmissionError);
  }
  assert.equal(f.calls.filter(call => call.sql.includes("begin_operation")).length, 7);
  assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 7);
});

function environment() {
  return { FRONTEND_WRITER_ADMISSION_MODE: "enforce", VERCEL: "1", APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432, database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "a".repeat(64), password: "must-not-copy" }),
    DATABASE_URL: "postgresql://protocol_runtime:owned-application-password@db.owned.invalid/owned?sslmode=verify-full",
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: "postgresql://protocol_runtime:owned-private-marker@db.owned.invalid/owned?sslmode=verify-full" };
}
function fixture(identity = { username: "protocol_runtime", database: "owned" }) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const state = { ended: false, epoch: "1", newWork: true, recovery: true, authorized: true, database: identity.database, uncertain: false };
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, get authorized() { return state.authorized; } } },
    async connect() {}, async end() { state.ended = true; },
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: identity.username, database: state.database, major: 18 }] };
      if (sql.includes("current_policy")) return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.includes("finish_operation")) state.uncertain = values?.[1] === "uncertain";
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({ getConfiguration: () => resolveWriterAdmissionConfiguration(environment()), createClient: () => client });
  return { calls, state, client, run };
}

test("media permits select one owner, course and lesson and reject the old unselected scope", () => {
  const actorId = "8e2280dc-0389-4248-b21c-f87427f9e85c";
  const courseId = "8e2280dc-0389-4248-b21c-f87427f9e85d";
  const lessonId = "8e2280dc-0389-4248-b21c-f87427f9e85e";
  const env = { ...environment(), CRON_SECRET: "r".repeat(48), VERCEL_URL: "reviewed-deploy.vercel.app" };
  const now = 1_800_000_000;
  const issue = (value: string) => `${value}.${createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${value}`).digest("hex")}`;
  const window = `1.media.${now}.${now + 60}.${"a".repeat(32)}`;
  const selection = (actorId + courseId + lessonId).replaceAll("-", "");
  const cookie = issue(`v2.${window}.${selection}`);
  const attest = (method: string, path: string, candidate = cookie, search = "") =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie: candidate }, env, now);
  const lesson = `/api/admin/lessons/${lessonId}`;
  for (const [method, path] of [["GET", `/admin/courses/${courseId}`], ["GET", `${lesson}/video`], ["POST", `${lesson}/video-upload`]]) {
    const proof = attest(method, path);
    assert.ok(proof);
    assert.equal(readInteractiveRequest(proof, cookie, env, now)?.authoringActorId, actorId);
  }
  assert.equal(attest("POST", `${lesson}/video-upload`, issue(`v1.${window}`)), null);
  assert.equal(attest("POST", `/api/admin/lessons/${courseId}/video-upload`), null);
  assert.equal(attest("GET", `/admin/courses/${lessonId}`), null);
  assert.equal(attest("GET", `${lesson}/video`, cookie, "?refresh=true"), null);
  assert.equal(attest("POST", `${lesson}/video/${actorId}/refresh`), null);
  assert.equal(attest("DELETE", `${lesson}/video/${actorId}/captions/track`), null);
});

test("off mode preserves responses and exceptions without configuration or database work", async () => {
  let created = 0;
  const run = createWriterAdmissionRunner({ getConfiguration: () => resolveWriterAdmissionConfiguration({}), createClient: () => { created++; throw new Error(); } });
  const response = Response.json({ error: "original" }, { status: 500 });
  assert.equal(await withWriterAdmission("new-work", async () => response, run)(), response);
  const error = new Error("original-handler-error");
  await assert.rejects(withWriterAdmission("recovery", async () => { throw error; }, run)(), caught => caught === error);
  assert.equal(created, 0);
});

test("configuration binds dedicated hosted identity, source, producer, direct target and verified TLS", () => {
  const env = environment(), configuration = resolveWriterAdmissionConfiguration(env)!;
  assert.equal(configuration.connection.ssl.rejectUnauthorized, true);
  assert.equal(JSON.stringify(configuration.target).includes("must-not-copy"), false);
  for (const change of [
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_MODE = "true"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_ENV = "preview"; v.VERCEL_TARGET_ENV = "preview"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_PROJECT_ID = "another_project"; },
    (v: Record<string, string | undefined>) => { v.VERCEL_GIT_COMMIT_SHA = undefined; },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL = v.FRONTEND_WRITER_ADMISSION_DATABASE_URL!.replace("verify-full", "require"); },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL += "&options=bad"; },
    (v: Record<string, string | undefined>) => { v.FRONTEND_WRITER_ADMISSION_DATABASE_URL = v.FRONTEND_WRITER_ADMISSION_DATABASE_URL!.replace("db.owned.invalid", "other.owned.invalid"); },
  ]) {
    const value: Record<string, string | undefined> = { ...env }; change(value);
    assert.throws(() => resolveWriterAdmissionConfiguration(value), error => error instanceof WriterAdmissionError && !error.message.includes("owned-private-marker"));
  }
});

test("closed new-work admission returns retryable 503 before handler or raw body is consumed", async () => {
  const f = fixture(); f.state.newWork = false; let effects = 0;
  const request = new Request("https://owned.invalid", { method: "POST", body: "untouched" });
  const response = await withWriterAdmission("new-work", async (request: Request) => { effects++; await request.text(); return Response.json({ ok: true }); }, f.run)(request);
  assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30"); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(request.bodyUsed, false); assert.equal(effects, 0); assert.equal(f.state.ended, true);
  assert.equal(f.calls.some(call => call.sql.startsWith("CALL")), false);
});

test("interactive browser proof binds its exact stage, request, deployment, epoch and lifetime", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const source = env.VERCEL_GIT_COMMIT_SHA, target = "a".repeat(64);
  const cookieFor = (stage: string, selection?: string) => {
    const body = `${selection === undefined ? "v1" : "v2"}.12.${stage}.${now}.${now + 120}.${"a".repeat(32)}${selection === undefined ? "" : "." + selection}`;
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${source}\n${target}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const selector = (kind: string) => createHash("sha256").update(JSON.stringify(["identity", kind])).digest("hex");
  const cookie = cookieFor("identity", customerIdentitySelector);
  const staffCookie = cookieFor("identity", selector("admin"));
  const google = { origin: INTERACTIVE_ORIGIN, method: "GET", path: "/api/customer-auth/callback/google", cookie };
  const attested = attestInteractiveRequest(google, env, now)!;
  const producerSha256 = createHash("sha256").update(`lash-her:p2q:interactive-producer:v1\n${source}\n${target}`).digest("hex");
  assert.deepEqual(readInteractiveRequest(attested, cookie, env, now), { epoch: "12", producerSha256, source, target, identityCustomerId: selectedCustomerId });
  const otherCustomerId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const otherCustomerCookie = cookieFor("identity", customerIdentityPrefix + otherCustomerId.replaceAll("-", ""));
  const otherProof = attestInteractiveRequest({ ...google, cookie: otherCustomerCookie }, env, now)!;
  assert.equal(readInteractiveRequest(otherProof, otherCustomerCookie, env, now)?.identityCustomerId, otherCustomerId);
  assert.equal(readInteractiveRequest(attested, otherCustomerCookie, env, now), null);
  assert.equal(readInteractiveRequest(attested, cookie, env, now + 30), null);
  assert.equal(readInteractiveRequest(attested, cookieFor("authoring"), env, now), null);
  assert.equal(readInteractiveRequest(attested.replace(/.$/u, x => x === "a" ? "b" : "a"), cookie, env, now), null);
  for (const [method, path] of [
    ["HEAD", google.path], ["POST", google.path], ["GET", google.path + "/"],
    ["GET", "/api/customer-auth/callback/google%2f"], ["POST", "/api/checkout/products"], ["POST", "/api/webhooks/square"],
    ["GET", "/api/cron/account-lifecycle"], ["POST", "/api/admin/customer-accounts/a/commands"],
    ["GET", "/account/sign-in-methods"], ["POST", "/api/customer-auth/signout"],
  ]) assert.equal(attestInteractiveRequest({ ...google, method, path }, env, now), null);
  assert.equal(attestInteractiveRequest({ ...google, origin: "https://owned.vercel.app" }, env, now), null);
  assert.equal(attestInteractiveRequest(google, { ...env, VERCEL_URL: "different.vercel.app" }, now), null);
  assert.equal(attestInteractiveRequest(google, { ...env, ADMIN_DEVELOPER_MODE: "true", ADMIN_DEVELOPER_ACCESS_KEY: "x".repeat(32) }, now), null);
  assert.equal(attestInteractiveRequest(google, env, now + 120), null);
  const admin = attestInteractiveRequest({ ...google, method: "POST", path: "/admin/sign-in", cookie: staffCookie }, env, now)!;
  assert.equal(readInteractiveRequest(admin, staffCookie, env, now), null);
  assert.deepEqual(await withinInteractiveAdminGoogleAction(async () => readInteractiveRequest(admin, staffCookie, env, now)),
    { epoch: "12", producerSha256, source, target });
  for (const [method, path, allowedCookie, wrongCookie] of [
    ["GET", "/api/auth/callback/google", staffCookie, cookie],
    ["GET", "/api/auth/session", staffCookie, cookie],
    ["POST", "/api/auth/signin/google", staffCookie, cookie],
    ["GET", "/api/customer-auth/callback/google", cookie, staffCookie],
    ["GET", "/api/customer-auth/callback/resend", cookie, staffCookie],
    ["POST", "/api/customer-auth/signin/resend", cookie, staffCookie],
  ]) {
    const input = { origin: INTERACTIVE_ORIGIN, method, path };
    const allowedProof = attestInteractiveRequest({ ...input, cookie: allowedCookie }, env, now)!;
    assert.ok(readInteractiveRequest(allowedProof, allowedCookie, env, now));
    assert.equal(attestInteractiveRequest({ ...input, cookie: wrongCookie }, env, now), null);
    // The application independently checks the route family even if given an
    // otherwise valid internal proof over a route outside the signed scope.
    const route = `${now}.${Buffer.from(`${method} ${path}`).toString("base64url")}`;
    const wrongMac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:request:v1\n${env.VERCEL_URL}\n${source}\n${target}\n${wrongCookie}\n${route}`).digest("hex");
    assert.equal(readInteractiveRequest(`${route}.${wrongMac}`, wrongCookie, env, now), null);
  }
  for (const invalid of [cookieFor("identity"), cookieFor("identity", selector("unknown")), cookieFor("identity", selector("customer")),
    cookieFor("identity", customerIdentityPrefix + "0".repeat(32)),
    cookieFor("identity", customerIdentityPrefix + "8d680a9280714fd07da2c4d350aa729d"),
    cookieFor("identity", customerIdentitySelector.toUpperCase()),
    cookie.replace(customerIdentitySelector, selector("admin"))]) {
    assert.equal(attestInteractiveRequest({ ...google, cookie: invalid }, env, now), null);
  }
  const f = fixture();
  f.state.epoch = "12";
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
    createClient: () => f.client,
    getInteractiveWriter: async () => readInteractiveRequest(attested, cookie, env, now),
  });
  let observeAfterCompletion!: () => void;
  let outsideSelection: Promise<string | undefined> | undefined;
  await run("new-work", async () => {
    assert.equal(currentWriterIdentityCustomerId(), selectedCustomerId);
    assert.equal(currentWriterLifecycleSelection(), undefined);
    outsideSelection = new Promise<void>(resolve => { observeAfterCompletion = resolve; }).then(currentWriterIdentityCustomerId);
  });
  observeAfterCompletion();
  assert.equal(await outsideSelection, undefined);
  assert.equal(currentWriterIdentityCustomerId(), undefined);
  assert.equal(JSON.stringify(f.calls).includes(selectedCustomerId), false);
});

test("authoring binds the exact owner UUID and operation routes, then clears its actor after admission", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const authoringActorId = "8e2280dc-0389-4248-b21c-f87427f9e85c";
  const prefix = "7032712d617574686f72696e672d7631";
  const issue = (stage: string, selector?: string) => {
    const body = [selector ? "v2" : "v1", "12", stage, now, now + 120, "ab".repeat(16), ...(selector ? [selector] : [])].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue("authoring", prefix + authoringActorId.replaceAll("-", ""));
  const editCookie = issue("authoring", "7032712d617574682d656469742d7631" + authoringActorId.replaceAll("-", ""));
  const reorderCookie = issue("authoring", "7032712d617574682d736f72742d7631" + authoringActorId.replaceAll("-", ""));
  const createCurriculumCookie = issue("authoring", "7032712d617574682d6e65772d763100" + authoringActorId.replaceAll("-", ""));
  const publishCookie = issue("authoring", "7032712d617574682d7075622d763100" + authoringActorId.replaceAll("-", ""));
  const reviewCookie = issue("authoring", "7032712d617574682d7264792d763100" + authoringActorId.replaceAll("-", ""));
  const quizCookie = issue("authoring", "7032712d617574682d7175697a2d7631" + authoringActorId.replaceAll("-", ""));
  const archivePrefix = "7032712d617574682d6172632d763100";
  const archiveCookie = issue("authoring", archivePrefix + authoringActorId.replaceAll("-", ""));
  const republishCookie = issue("authoring", "7032712d617574682d7265702d763100" + authoringActorId.replaceAll("-", ""));
  const reviewRestorationCookie = issue("authoring", "7032712d617574682d72626c2d763100" + authoringActorId.replaceAll("-", ""));
  assert.equal(attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method: "GET", path: `/admin/courses/${authoringActorId}`,
    cookie: issue("authoring", "7032712d617574682d6e65772d7631" + authoringActorId.replaceAll("-", "")) }, env, now), null);
  const attest = (method: string, path: string, permit = cookie) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie: permit }, env, now);
  const proof = attest("POST", "/api/admin/courses")!;
  const verified = readInteractiveRequest(proof, cookie, env, now);
  assert.equal(verified?.authoringActorId, authoringActorId);
  assert.equal(verified?.identityCustomerId, undefined);
  assert.equal(readInteractiveRequest(attest("GET", "/admin/courses")!, cookie, env, now)?.authoringActorId, authoringActorId);
  assert.equal(readInteractiveRequest(proof, issue("authoring", prefix + "6" + authoringActorId.replaceAll("-", "").slice(1)), env, now), null);
  for (const invalid of [issue("authoring"), issue("authoring", customerIdentitySelector), issue("authoring", prefix + "0".repeat(32))]) {
    assert.equal(attest("POST", "/api/admin/courses", invalid), null);
  }
  const courseDetail = `/admin/courses/${authoringActorId}`;
  const courseApi = "/api" + courseDetail;
  const readiness = `${courseApi}/publication-readiness`;
  const quizApi = `/api/admin/lessons/${authoringActorId}/quiz`;
  const moduleCreate = `${courseApi}/modules`;
  const lessonCreate = `/api/admin/modules/${authoringActorId}/lessons`;
  const moduleReorder = `${moduleCreate}/reorder`;
  const lessonReorder = `${lessonCreate}/reorder`;
  for (const [method, path] of [["GET", courseDetail], ["GET", "/api/admin/courses"], ["POST", "/admin/courses"], ["PATCH", "/api" + courseDetail]]) {
    assert.equal(attest(method, path), null);
  }
  for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["PATCH", courseApi]]) {
    const editProof = attest(method, path, editCookie)!;
    assert.equal(readInteractiveRequest(editProof, editCookie, env, now)?.authoringActorId, authoringActorId);
    assert.equal(readInteractiveRequest(editProof, cookie, env, now), null);
  }
  for (const [method, path] of [["GET", "/admin/courses"], ["POST", "/api/admin/courses"], ["GET", courseApi + "/publication-readiness"],
    ["PATCH", courseDetail], ["POST", courseApi + "/modules"], ["GET", "/admin/courses/noncanonical-id"], ["PATCH", courseApi.toUpperCase()]]) {
    assert.equal(attest(method, path, editCookie), null);
  }
  for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["POST", moduleReorder], ["POST", lessonReorder]]) {
    const reorderProof = attest(method, path, reorderCookie)!;
    assert.equal(readInteractiveRequest(reorderProof, reorderCookie, env, now)?.authoringActorId, authoringActorId);
    assert.equal(readInteractiveRequest(reorderProof, editCookie, env, now), null);
    assert.equal(readInteractiveRequest(reorderProof, cookie, env, now), null);
  }
  for (const [method, path] of [["GET", "/admin/courses"], ["POST", "/api/admin/courses"], ["PATCH", courseApi],
    ["POST", courseApi + "/modules"], ["GET", moduleReorder], ["POST", lessonReorder + "/"], ["POST", moduleReorder.toUpperCase()]]) {
    assert.equal(attest(method, path, reorderCookie), null);
  }
  assert.equal(attest("POST", moduleReorder, cookie), null);
  assert.equal(attest("POST", moduleReorder, editCookie), null);
  for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["POST", moduleCreate], ["POST", lessonCreate]]) {
    const createProof = attest(method, path, createCurriculumCookie)!;
    assert.equal(readInteractiveRequest(createProof, createCurriculumCookie, env, now)?.authoringActorId, authoringActorId);
    for (const otherCookie of [cookie, editCookie, reorderCookie]) {
      assert.equal(readInteractiveRequest(createProof, otherCookie, env, now), null);
      if (method === "POST") assert.equal(attest(method, path, otherCookie), null);
    }
  }
  for (const [method, path] of [["GET", "/admin/courses"], ["POST", "/api/admin/courses"], ["PATCH", courseApi],
    ["POST", moduleReorder], ["POST", lessonReorder], ["GET", moduleCreate], ["POST", lessonCreate + "/"], ["POST", moduleCreate.toUpperCase()]]) {
    assert.equal(attest(method, path, createCurriculumCookie), null);
  }
  for (const [permit, operation] of [[publishCookie, "publish-course"], [reviewCookie, "review-publication"]] as const) {
    for (const path of [courseDetail, courseApi, readiness]) {
      const selectedProof = attest("GET", path, permit);
      assert.ok(selectedProof);
      const selected = readInteractiveRequest(selectedProof, permit, env, now);
      assert.equal(selected?.authoringActorId, authoringActorId);
      assert.equal(selected?.authoringOperation, operation);
      assert.equal(readInteractiveRequest(selectedProof, permit === publishCookie ? reviewCookie : publishCookie, env, now), null);
    }
    for (const [method, path] of [["GET", "/admin/courses"], ["POST", "/api/admin/courses"], ["POST", moduleCreate],
      ["POST", moduleReorder], ["PATCH", courseDetail], ["PATCH", readiness], ["GET", `${courseDetail}/publication-readiness`]]) {
      assert.equal(attest(method, path, permit), null);
    }
  }
  assert.equal(attest("PATCH", courseApi, reviewCookie), null);
  assert.equal(attest("GET", readiness, editCookie), null);
  for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["GET", quizApi], ["PUT", quizApi]]) {
    const quizProof = attest(method, path, quizCookie);
    assert.ok(quizProof);
    const selected = readInteractiveRequest(quizProof, quizCookie, env, now);
    assert.equal(selected?.authoringActorId, authoringActorId);
    assert.equal(selected?.authoringOperation, "save-quiz-revision");
    assert.equal(readInteractiveRequest(quizProof, publishCookie, env, now), null);
  }
  for (const [method, path] of [["GET", readiness], ["GET", "/admin/courses"], ["POST", quizApi], ["PATCH", courseApi],
    ["PUT", quizApi + "/"], ["PUT", quizApi.toUpperCase()], ["PUT", "/api/admin/lessons/invalid/quiz"]]) {
    assert.equal(attest(method, path, quizCookie), null);
  }
  for (const permit of [cookie, editCookie, reorderCookie, createCurriculumCookie, publishCookie, reviewCookie, issue("media")]) {
    assert.equal(attest("PUT", quizApi, permit), null);
  }
  for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["PATCH", courseApi]]) {
    const archiveProof = attest(method, path, archiveCookie);
    assert.ok(archiveProof);
    const selected = readInteractiveRequest(archiveProof, archiveCookie, env, now);
    assert.equal(selected?.authoringActorId, authoringActorId);
    assert.equal(selected?.authoringOperation, "archive-paid-course");
    for (const otherCookie of [editCookie, publishCookie, issue("authoring", archivePrefix + selectedCustomerId.replaceAll("-", ""))]) {
      assert.equal(readInteractiveRequest(archiveProof, otherCookie, env, now), null);
    }
  }
  for (const [method, path] of [["GET", readiness], ["GET", "/admin/courses"], ["GET", quizApi], ["PATCH", courseDetail],
    ["POST", moduleCreate], ["POST", moduleReorder], ["PATCH", courseApi + "/"], ["PUT", quizApi]]) {
    assert.equal(attest(method, path, archiveCookie), null);
  }
  for (const [permit, operation] of [[republishCookie, "republish-paid-course"], [reviewRestorationCookie, "review-paid-restoration"]] as const) {
    for (const [method, path] of [["GET", courseDetail], ["GET", courseApi], ["GET", readiness], ["PATCH", courseApi]]) {
      const transitionProof = attest(method, path, permit);
      assert.ok(transitionProof);
      const selected = readInteractiveRequest(transitionProof, permit, env, now);
      assert.equal(selected?.authoringActorId, authoringActorId);
      assert.equal(selected?.authoringOperation, operation);
      for (const other of [archiveCookie, publishCookie, permit === republishCookie ? reviewRestorationCookie : republishCookie]) {
        assert.equal(readInteractiveRequest(transitionProof, other, env, now), null);
      }
    }
    for (const [method, path] of [["GET", "/admin/courses"], ["GET", quizApi], ["POST", moduleCreate], ["PATCH", courseDetail], ["PATCH", readiness]]) {
      assert.equal(attest(method, path, permit), null);
    }
  }
  assert.equal(attest("GET", courseDetail, issue("media")), null);
  const wrongRoute = `${now}.${Buffer.from(`GET ${courseDetail}`).toString("base64url")}`;
  const wrongMac = createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:request:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${cookie}\n${wrongRoute}`).digest("hex");
  assert.equal(readInteractiveRequest(`${wrongRoute}.${wrongMac}`, cookie, env, now), null);

  const editVerified = readInteractiveRequest(attest("PATCH", courseApi, editCookie)!, editCookie, env, now);
  const reorderVerified = readInteractiveRequest(attest("POST", moduleReorder, reorderCookie)!, reorderCookie, env, now);
  const createCurriculumVerified = readInteractiveRequest(attest("POST", moduleCreate, createCurriculumCookie)!, createCurriculumCookie, env, now);
  const publishVerified = readInteractiveRequest(attest("PATCH", courseApi, publishCookie)!, publishCookie, env, now);
  const reviewVerified = readInteractiveRequest(attest("GET", readiness, reviewCookie)!, reviewCookie, env, now);
  const quizVerified = readInteractiveRequest(attest("PUT", quizApi, quizCookie)!, quizCookie, env, now);
  const archiveVerified = readInteractiveRequest(attest("PATCH", courseApi, archiveCookie)!, archiveCookie, env, now);
  const republishVerified = readInteractiveRequest(attest("PATCH", courseApi, republishCookie)!, republishCookie, env, now);
  const reviewRestorationVerified = readInteractiveRequest(attest("PATCH", courseApi, reviewRestorationCookie)!, reviewRestorationCookie, env, now);
  for (const [accepted, operation] of [[verified, "create-draft"], [editVerified, "edit-draft"], [reorderVerified, "reorder-curriculum"],
    [createCurriculumVerified, "create-curriculum"], [publishVerified, "publish-course"], [reviewVerified, "review-publication"],
    [quizVerified, "save-quiz-revision"], [archiveVerified, "archive-paid-course"], [republishVerified, "republish-paid-course"],
    [reviewRestorationVerified, "review-paid-restoration"]] as const) {
    const f = fixture();
    f.state.epoch = "12";
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
      createClient: () => f.client,
      getInteractiveWriter: async () => accepted,
    });
    let observeAfterCompletion!: () => void;
    let outsideSelection: Promise<readonly (string | undefined)[]> | undefined;
    await run("new-work", async () => {
      assert.equal(currentWriterAuthoringActorId(), authoringActorId);
      assert.equal(currentWriterAuthoringOperation(), operation);
      outsideSelection = new Promise<void>(resolve => { observeAfterCompletion = resolve; })
        .then(() => [currentWriterAuthoringActorId(), currentWriterAuthoringOperation()]);
    });
    observeAfterCompletion();
    assert.deepEqual(await outsideSelection, [undefined, undefined]);
    assert.equal(currentWriterAuthoringActorId(), undefined);
    assert.equal(currentWriterAuthoringOperation(), undefined);
    assert.equal(JSON.stringify(f.calls).includes(authoringActorId), false);
  }
});

test("interactive writer uses only its certified producer and refuses a changed ledger epoch before effects", async () => {
  const f = fixture();
  const selected = { source: "c".repeat(40), target: "a".repeat(64), producerSha256: "d".repeat(64), epoch: "12" };
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
    createClient: () => f.client,
    getInteractiveWriter: async () => selected,
  });
  await assert.rejects(run("recovery", async () => assert.fail("unexpected writer execution")), WriterAdmissionError);
  assert.equal(f.calls.some(call => call.sql.includes("begin_operation")), false);
  f.state.epoch = "12";
  await run("recovery", async () => assert.equal(currentWriterOperationIdentity()?.producerSha256, selected.producerSha256));
  assert.equal(f.calls.at(-2)?.values?.[5], selected.producerSha256);
  assert.ok(f.calls.filter(call => call.sql.includes("current_policy")).every(call => call.values?.[2] === selected.producerSha256));
});

test("learning enrollment permits bind canonical customer and idempotency UUIDs to enrollment routes only", () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, idempotencyKey = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const selected = actorId.replaceAll("-", "") + idempotencyKey.replaceAll("-", "");
  const course = "10000000-0000-4000-8000-000000000001";
  const issue = (selector?: string) => {
    const body = [selector ? "v2" : "v1", "12", "learning", now, now + 120, "ab".repeat(16), ...(selector ? [selector] : [])].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue(selected);
  const attest = (method: string, path: string, permit = cookie) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie: permit }, env, now);
  const enroll = `/api/academy/courses/${course}/enrollments`;
  for (const [method, path] of [["GET", "/courses/owned-free-course"], ["GET", `/academy/courses/${course}`], ["POST", enroll]]) {
    const proof = attest(method, path);
    assert.ok(proof);
    assert.deepEqual(readInteractiveRequest(proof, cookie, env, now)?.learningEnrollment, { actorId, idempotencyKey });
    assert.equal(readInteractiveRequest(proof, issue(selected.slice(32) + selected.slice(0, 32)), env, now), null);
  }
  for (const [method, path] of [["GET", "/courses"], ["GET", "/academy"], ["GET", "/api/customer-auth/session"],
    ["GET", `/api/academy/courses/${course}`], ["GET", `/academy/courses/${course}/lessons/${course}`],
    ["POST", `/api/academy/lessons/${course}/progress`], ["POST", `/api/academy/lessons/${course}/quiz/attempts`], ["GET", enroll]]) {
    assert.equal(attest(method, path), null);
  }
  for (const invalid of [issue(), issue("0".repeat(32) + selected.slice(32)), issue(selected.slice(0, 32) + "0".repeat(32)),
    issue(selected.toUpperCase()), issue(selected.slice(1))]) assert.equal(attest("POST", enroll, invalid), null);
});

test("learner-access v2 admits only read routes and binds the exact lesson", () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const selector = actorId.replaceAll("-", "") + lessonId.replaceAll("-", "");
  const courseId = "10000000-0000-4000-8000-000000000001";
  const issue = (selection?: string, stage = "learner-access") => {
    const body = [selection ? "v2" : "v1", "12", stage, now, now + 120, "ab".repeat(16), ...(selection ? [selection] : [])].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue(selector), page = `/academy/courses/${courseId}`, lesson = `/api/academy/lessons/${lessonId}`;
  const attest = (method: string, path: string, permit = cookie) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie: permit }, env, now);
  for (const path of [page, "/api" + page, lesson, `${lesson}/playback`, `${lesson}/quiz`, `${lesson}/quiz/attempts`, "/api/academy/progress"]) {
    const proof = attest("GET", path);
    assert.ok(proof);
    const verified = readInteractiveRequest(proof, cookie, env, now);
    assert.deepEqual(verified?.learnerAccess, { actorId, lessonId });
    assert.equal(verified?.learningEnrollment, undefined);
    assert.equal(readInteractiveRequest(proof, issue(selector.slice(32) + selector.slice(0, 32)), env, now), null);
  }
  for (const [method, path] of [["GET", `${page}/lessons/${lessonId}`], ["GET", `/api/academy/lessons/${courseId}`],
    ["GET", `/api/academy/lessons/${courseId}/quiz/attempts`], ["GET", `${lesson}/progress`], ["GET", `${lesson}/playback/`],
    ["GET", "/api/academy/courses"], ["GET", "/api/customer-auth/session"], ["GET", "/courses/owned-course"],
    ["POST", `${lesson}/progress`], ["POST", `${lesson}/quiz/attempts`], ["PUT", `${lesson}/quiz`], ["HEAD", page]]) {
    assert.equal(attest(method, path), null);
  }
  for (const invalid of [issue(), issue(selector.slice(32)), issue(selector.slice(0, 32) + "0".repeat(32)), issue(selector, "learning")]) {
    assert.equal(attest("GET", lesson, invalid), null);
  }
});

test("lesson-entry v2 binds all three canonical UUIDs and only normal Academy entry paths", () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const courseId = "10000000-0000-4000-8000-000000000001";
  const selector = [actorId, courseId, lessonId].map(value => value.replaceAll("-", "")).join("");
  const issue = (selection: string, version = "v2") => {
    const body = [version, "9".repeat(18), "lesson-entry", now, now + 120, "ab".repeat(16), selection].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue(selector), page = `/academy/courses/${courseId}`, lesson = `${page}/lessons/${lessonId}`;
  const api = `/api/academy/lessons/${lessonId}`;
  const attest = (method: string, path: string, permit = cookie, search = "") =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie: permit }, env, now);
  assert.ok(cookie.length <= 256);
  for (const [method, path] of [["GET", page], ["GET", lesson], ["GET", `${api}/playback`], ["POST", `${api}/progress`]]) {
    const proof = attest(method, path);
    assert.ok(proof);
    const verified = readInteractiveRequest(proof, cookie, env, now);
    assert.deepEqual(verified?.lessonEntry, { actorId, courseId, lessonId });
    assert.equal(verified?.learnerAccess, undefined);
    assert.equal(readInteractiveRequest(proof, issue(selector.slice(32, 64) + selector.slice(0, 32) + selector.slice(64)), env, now), null);
    assert.equal(attest(method, path, cookie, "?course=preview"), null);
  }
  for (const [method, path] of [["GET", "/academy"], ["GET", `/academy/courses/${actorId}`], ["GET", `${page}/lessons/${actorId}`],
    ["GET", `/api/academy/lessons/${actorId}/playback`], ["GET", `${api}/progress`], ["GET", `${api}/quiz`], ["POST", `${api}/quiz/attempts`],
    ["POST", `/api/academy/lessons/${actorId}/progress`], ["HEAD", page]]) assert.equal(attest(method, path), null);
  for (const invalid of [issue(selector, "v1"), issue(selector.slice(32)), issue(selector.toUpperCase()),
    issue("0".repeat(32) + selector.slice(32)), issue(selector.slice(0, 32) + "0".repeat(32) + selector.slice(64)),
    issue(selector.slice(0, 64) + "0".repeat(32))]) assert.equal(attest("GET", page, invalid), null);
});

test("lesson denial v2 signs only the selected document and exact read-only BFF targets", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const courseId = "10000000-0000-4000-8000-000000000001";
  const selector = [actorId, courseId, lessonId].map(value => value.replaceAll("-", "")).join("");
  const issue = (selection: string, stage = "lesson-denial") => {
    const body = ["v2", "9".repeat(18), stage, now, now + 120, "ab".repeat(16), selection].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue(selector), page = `/academy/courses/${courseId}/lessons/${lessonId}`;
  const api = `/api/academy/lessons/${lessonId}`, progress = "/api/academy/progress", query = `?lessonId=${lessonId}`;
  const attest = (method: string, path: string, search = "", permit = cookie) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie: permit }, env, now);
  assert.ok(cookie.length <= 256);
  for (const [path, search] of [[page, ""], [api, ""], [`${api}/playback`, ""], [progress, query], [`${api}/quiz`, ""], [`${api}/quiz/attempts`, ""]]) {
    const proof = attest("GET", path, search);
    assert.ok(proof);
    assert.equal(Buffer.from(proof.split(".")[1], "base64url").toString(), `GET ${path}${search}`);
    const verified = readInteractiveRequest(proof, cookie, env, now);
    assert.deepEqual(verified?.lessonDenial, { actorId, courseId, lessonId });
    assert.equal(verified?.lessonEntry, undefined);
    assert.equal(readInteractiveRequest(proof, issue(courseId.replaceAll("-", "") + selector.slice(32)), env, now), null);
    assert.equal(readInteractiveRequest(proof, issue(selector, "lesson-entry"), env, now), null);
  }
  for (const [method, path, search] of [
    ["GET", page, "?course=preview"], ["GET", page.replace(courseId, actorId)], ["GET", page.replace(lessonId, actorId)],
    ["GET", `/academy/courses/${courseId}`], ["GET", api.replace(lessonId, actorId)], ["GET", `${api}/quiz`, "?limit=2"],
    ["GET", progress], ["GET", progress, `?courseId=${courseId}`], ["GET", progress, `?lessonId=${actorId}`],
    ["GET", progress, `${query}&lessonId=${lessonId}`], ["GET", progress, `?%6CessonId=${lessonId}`],
    ["GET", progress, `${query}&extra=1`], ["HEAD", page], ["POST", `${api}/progress`], ["POST", `${api}/quiz/attempts`],
  ]) assert.equal(attest(method, path, search), null);
  assert.equal(attest("GET", page, "", issue(selector.slice(32))), null);
  const proof = attest("GET", progress, query);
  assert.ok(proof);
  const f = fixture();
  f.state.epoch = "9".repeat(18);
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(env),
    createClient: () => f.client,
    getInteractiveWriter: async () => readInteractiveRequest(proof, cookie, env, now),
  });
  let effects = 0;
  for (const kind of ["new-work", "recovery"] as const) {
    await assert.rejects(run(kind, async () => { effects++; }), { name: "WriterAdmissionError", code: "unavailable" });
  }
  assert.equal(effects, 0);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT current_user")));
  assert.equal(f.state.ended, true);
});

test("stalled playback renewal grants no writer authority and attests only the selected document and playback GET", async () => {
  const now = 1_794_009_600, epoch = "9".repeat(18);
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, courseId = "10000000-0000-4000-8000-000000000001";
  const lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const selector = [actorId, courseId, lessonId].map(value => value.replaceAll("-", "")).join("");
  const body = ["v2", epoch, "stalled-playback-renewal", now, now + 120, "ab".repeat(16), selector].join(".");
  const mac = createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
  const cookie = `${body}.${mac}`;
  assert.equal(cookie.length, 263);
  const page = `/academy/courses/${courseId}/lessons/${lessonId}`, api = `/api/academy/lessons/${lessonId}`;
  const attest = (method: string, path: string, search = "") =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie }, env, now);
  for (const path of [page, `${api}/playback`]) {
    const proof = attest("GET", path);
    assert.ok(proof);
    assert.deepEqual(readInteractiveRequest(proof, cookie, env, now)?.stalledPlaybackRenewal, { actorId, courseId, lessonId });
    assert.equal(attest("GET", path, "?extra=1"), null);
    assert.equal(readInteractiveRequest(proof, cookie, { ...env, APP_ENV: "production" }, now), null);
  }
  for (const [method, path] of [
    ["GET", page.replace(courseId, actorId)], ["GET", page.replace(lessonId, actorId)], ["GET", `/academy/courses/${courseId}`],
    ["GET", api], ["GET", `${api}/quiz`], ["GET", "/api/academy/progress"], ["HEAD", page],
    ["POST", `${api}/progress`], ["POST", `${api}/quiz/attempts`], ["POST", `${api}/playback`],
  ]) assert.equal(attest(method, path), null);
  const f = fixture();
  f.state.epoch = epoch;
  const proof = attest("GET", page)!;
  const run = createWriterAdmissionRunner({ getConfiguration: () => resolveWriterAdmissionConfiguration(env), createClient: () => f.client,
    getInteractiveWriter: async () => readInteractiveRequest(proof, cookie, env, now) });
  for (const kind of ["new-work", "recovery"] as const) {
    await assert.rejects(run(kind, async () => assert.fail("observation opened a writer")), { name: "WriterAdmissionError", code: "unavailable" });
  }
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT current_user")));
});

test("lesson assessment v2 admits only scoped progress and quiz writes and exact progress reads", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = selectedCustomerId, lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const courseId = "10000000-0000-4000-8000-000000000001";
  const selector = [actorId, courseId, lessonId].map(value => value.replaceAll("-", "")).join("");
  const body = ["v2", "9".repeat(18), "lesson-assessment", now, now + 120, "ab".repeat(16), selector].join(".");
  const mac = createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
  const cookie = `${body}.${mac}`;
  assert.equal(cookie.length, 256);
  const page = `/academy/courses/${courseId}/lessons/${lessonId}`, api = `/api/academy/lessons/${lessonId}`;
  const progress = "/api/academy/progress", query = `?lessonId=${lessonId}`;
  const attest = (method: string, path: string, search = "") =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie }, env, now);
  for (const [method, path, search] of [["GET", page, ""], ["GET", `${api}/playback`, ""], ["GET", progress, query],
    ["POST", `${api}/progress`, ""], ["POST", `${api}/quiz/attempts`, ""]]) {
    const proof = attest(method, path, search);
    assert.ok(proof);
    assert.equal(Buffer.from(proof.split(".")[1], "base64url").toString(), `${method} ${path}${search}`);
    const verified = readInteractiveRequest(proof, cookie, env, now);
    assert.deepEqual(verified?.lessonAssessment, { actorId, courseId, lessonId });
    assert.equal(verified?.lessonAssessmentWrite, method === "POST");
  }
  for (const [method, path, search] of [["GET", page, "?course=preview"], ["GET", page.replace(courseId, actorId)], ["GET", progress],
    ["GET", progress, `?courseId=${courseId}`], ["GET", progress, `?lessonId=${actorId}`], ["GET", progress, `${query}&limit=1`],
    ["GET", `${api}/quiz`], ["GET", `${api}/quiz/attempts`], ["POST", `${api}/quiz`], ["POST", `${api}/progress`, "?retry=1"],
    ["POST", `${api.replace(lessonId, actorId)}/quiz/attempts`], ["HEAD", page]]) assert.equal(attest(method, path, search), null);
  const getProof = attest("GET", page), postProof = attest("POST", `${api}/quiz/attempts`);
  assert.ok(getProof && postProof);
  const f = fixture();
  f.state.epoch = "9".repeat(18);
  let verified = readInteractiveRequest(getProof, cookie, env, now);
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(env),
    createClient: () => f.client, getInteractiveWriter: async () => verified,
  });
  let effects = 0;
  await assert.rejects(run("new-work", async () => { effects++; }), { name: "WriterAdmissionError", code: "unavailable" });
  verified = readInteractiveRequest(postProof, cookie, env, now);
  await assert.rejects(run("recovery", async () => { effects++; }), { name: "WriterAdmissionError", code: "unavailable" });
  assert.equal(effects, 0);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.sql.startsWith("SELECT current_user")));
  await run("new-work", async () => { effects++; });
  assert.equal(effects, 1);
  assert.equal(f.calls.filter(call => call.sql.includes("begin_operation")).length, 1);
  assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
});

for (const [stage, selectionKey, writeKey] of [
  ["lesson-resume", "lessonResume", "lessonResumeWrite"],
  ["lesson-restore", "lessonRestore", "lessonRestoreWrite"],
  ["lesson-ack-loss", "lessonAckLoss", "lessonAckLossWrite"],
  ["lesson-exit-save", "lessonExitSave", "lessonExitSaveWrite"],
  ["lesson-visibility-save", "lessonVisibilitySave", "lessonVisibilitySaveWrite"],
  ["lesson-stale-revision", "lessonStaleRevision", "lessonStaleRevisionWrite"],
] as const) {
  test(`${stage} v2 grants write admission only on the exact selected progress POST`, async () => {
    const now = 1_794_009_600;
    const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
    const actorId = selectedCustomerId, lessonId = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
    const courseId = "10000000-0000-4000-8000-000000000001";
    const selector = [actorId, courseId, lessonId].map(value => value.replaceAll("-", "")).join("");
    const body = ["v2", "9".repeat(18), stage, now, now + 120, "ab".repeat(16), selector].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    const cookie = `${body}.${mac}`;
    const page = `/academy/courses/${courseId}/lessons/${lessonId}`, api = `/api/academy/lessons/${lessonId}`;
    const attest = (method: string, path: string, search = "") =>
      attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie }, env, now);
    const recovery = ["GET", "/api/academy/progress", `?lessonId=${lessonId}`];
    const outline = ["GET", `/academy/courses/${courseId}`];
    const allowed = [["GET", page], ["GET", `${api}/playback`], ["POST", `${api}/progress`]];
    const recoveryReadAllowed = stage === "lesson-ack-loss" || stage === "lesson-stale-revision";
    if (stage === "lesson-stale-revision") assert.equal(cookie.length, 260);
    if (recoveryReadAllowed) allowed.push(recovery);
    if (stage === "lesson-exit-save") allowed.push(outline);
    for (const [method, path, query] of allowed) {
      const proof = attest(method, path, query);
      assert.ok(proof);
      const verified = readInteractiveRequest(proof, cookie, env, now);
      assert.deepEqual(verified?.[selectionKey], { actorId, courseId, lessonId });
      assert.equal(verified?.[writeKey], method === "POST");
    }
    const forbidden = [["GET", page, "?course=preview"], ["HEAD", page], ["GET", page.replace(courseId, actorId)],
      ["GET", `${api}/playback`, "?x=1"], ["GET", `${api}/progress`],
      ["GET", recovery[1], `${recovery[2]}&limit=1`], ["GET", recovery[1], `?lessonId=${actorId}`],
      ["POST", `${api}/quiz/attempts`], ["POST", `${api}/progress`, "?retry=1"],
      ["POST", `${api.replace(lessonId, actorId)}/progress`]];
    if (!recoveryReadAllowed) forbidden.push(recovery);
    if (stage !== "lesson-exit-save") forbidden.push(outline);
    else forbidden.push(["GET", outline[1], "?unexpected=1"], ["GET", outline[1].replace(courseId, actorId)],
      ["POST", outline[1]], ["GET", "/api/academy/progress", `?courseId=${courseId}`]);
    for (const [method, path, query] of forbidden) assert.equal(attest(method, path, query), null);
    const getProof = attest("GET", stage === "lesson-exit-save" ? outline[1] : page), postProof = attest("POST", `${api}/progress`);
    assert.ok(getProof && postProof);
    const f = fixture();
    f.state.epoch = "9".repeat(18);
    let verified = readInteractiveRequest(getProof, cookie, env, now);
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration(env),
      createClient: () => f.client, getInteractiveWriter: async () => verified,
    });
    let effects = 0;
    await assert.rejects(run("new-work", async () => { effects++; }), { name: "WriterAdmissionError", code: "unavailable" });
    verified = readInteractiveRequest(postProof, cookie, env, now);
    await assert.rejects(run("recovery", async () => { effects++; }), { name: "WriterAdmissionError", code: "unavailable" });
    assert.equal(effects, 0);
    assert.equal(f.calls.length, 2);
    await run("new-work", async () => { effects++; });
    assert.equal(effects, 1);
    assert.equal(f.calls.filter(call => call.sql.includes("begin_operation")).length, 1);
    assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
  });
}

test("paid grant and revoke v2 permit only their fresh mutation and owner page, and clear owner scope", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const actorId = "8e2280dc-0389-4248-b21c-f87427f9e85c", idempotencyKey = "8284af5b-324d-45d9-b460-f97dc59b6d9b";
  const selector = actorId.replaceAll("-", "") + idempotencyKey.replaceAll("-", "");
  const courseId = "10000000-0000-4000-8000-000000000001";
  const issue = (selection?: string, stage = "paid-grant") => {
    const body = [selection ? "v2" : "v1", "12", stage, now, now + 120, "ab".repeat(16), ...(selection ? [selection] : [])].join(".");
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const cookie = issue(selector), page = `/admin/courses/${courseId}/manual-grants`, api = "/api" + page;
  const attest = (method: string, path: string, permit = cookie) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie: permit }, env, now);
  const getProof = attest("GET", page), postProof = attest("POST", api);
  assert.ok(getProof && postProof);
  assert.deepEqual(readInteractiveRequest(getProof, cookie, env, now)?.paidGrant, { actorId, idempotencyKey });
  const verified = readInteractiveRequest(postProof, cookie, env, now);
  assert.deepEqual(verified?.paidGrant, { actorId, idempotencyKey });
  assert.equal(verified?.learningEnrollment, undefined);
  for (const [method, path] of [["GET", api], ["GET", `/admin/courses/${courseId}`], ["GET", "/admin/courses"], ["POST", page],
    ["POST", `/api/academy/courses/${courseId}/enrollments`], ["PATCH", api], ["POST", api + "/"]]) assert.equal(attest(method, path), null);
  for (const invalid of [issue(), issue(selector.slice(32)), issue(selector.slice(0, 32) + "0".repeat(32)), issue(selector, "learning")]) {
    assert.equal(attest("POST", api, invalid), null);
  }
  assert.equal(readInteractiveRequest(postProof, issue(selector.slice(32) + selector.slice(0, 32)), env, now), null);

  const revokeCookie = issue(selector, "paid-revoke"), revokePage = `${page}/revoke`, revokeApi = `${api}/revoke`;
  const revokeGetProof = attest("GET", revokePage, revokeCookie), revokePostProof = attest("POST", revokeApi, revokeCookie);
  assert.ok(revokeGetProof && revokePostProof);
  const verifiedRevoke = readInteractiveRequest(revokePostProof, revokeCookie, env, now);
  assert.deepEqual(readInteractiveRequest(revokeGetProof, revokeCookie, env, now)?.paidRevoke, { actorId, idempotencyKey });
  assert.deepEqual(verifiedRevoke?.paidRevoke, { actorId, idempotencyKey });
  assert.equal(verifiedRevoke?.paidGrant, undefined);
  assert.equal(attest("POST", revokeApi, cookie), null);
  assert.equal(attest("POST", api, revokeCookie), null);
  assert.equal(attest("GET", revokeApi, revokeCookie), null);
  assert.equal(attest("GET", page, revokeCookie), null);
  assert.equal(attest("POST", revokeApi, issue(undefined, "paid-revoke")), null);
  assert.equal(readInteractiveRequest(revokePostProof, cookie, env, now), null);

  for (const selected of [verified, verifiedRevoke]) {
    const f = fixture();
    f.state.epoch = "12";
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
      createClient: () => f.client,
      getInteractiveWriter: async () => selected,
    });
    let releaseObservation!: () => void;
    let afterAdmission: Promise<string | undefined> | undefined;
    await run("new-work", async () => {
      assert.equal(currentWriterPaidAccessActorId(), actorId);
      assert.equal(currentWriterAuthoringActorId(), undefined);
      afterAdmission = new Promise<void>(resolve => { releaseObservation = resolve; }).then(currentWriterPaidAccessActorId);
    });
    releaseObservation();
    assert.equal(await afterAdmission, undefined);
    assert.equal(JSON.stringify(f.calls).includes(actorId), false);
  }
});

test("first-owner permit scopes the ordinary Google sign-in to one materialization route", async () => {
  const now = 1_794_009_600, nonce = "9".repeat(32);
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const identityDigest = p2FirstOwnerIdentitySha256(nonce, "owned-owner@example.invalid", "owned-google-subject")!.slice(0, 62);
  const cookieBody = `v2.12.identity.${now}.${now + 120}.${nonce}.a3${identityDigest}`;
  const cookieMac = createHmac("sha256", env.CRON_SECRET).update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${cookieBody}`).digest("hex");
  const cookie = `${cookieBody}.${cookieMac}`;
  const attest = (method: string, path: string) => attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie }, env, now);
  for (const path of ["/admin/sign-in", "/api/auth/callback/google", P2_FIRST_OWNER_PATH]) {
    const proof = attest("GET", path)!;
    assert.deepEqual(readInteractiveRequest(proof, cookie, env, now)?.firstOwner, { nonce, identityDigest, epoch: "12", startedAt: now });
  }
  const action = attest("POST", "/admin/sign-in")!;
  assert.equal(readInteractiveRequest(action, cookie, env, now), null);
  assert.deepEqual(await withinInteractiveAdminGoogleAction(async () => readInteractiveRequest(action, cookie, env, now)?.firstOwner),
    { nonce, identityDigest, epoch: "12", startedAt: now });
  for (const [method, path] of [["GET", "/admin"], ["GET", "/admin/courses"], ["GET", "/api/auth/session"],
    ["GET", "/api/auth/callback/other"], ["POST", "/api/auth/signin/google"], ["POST", P2_FIRST_OWNER_PATH],
    ["GET", "/api/customer-auth/callback/google"]]) assert.equal(attest(method, path), null);
});

test("first-owner discovery permits only auth-only Google routes and carries no materialization scope", async () => {
  const now = 1_794_009_600, nonce = "8".repeat(32);
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const emailDigest = p2FirstOwnerDiscoveryEmailSha256(nonce, "owned-owner@example.invalid")!.slice(0, 62);
  const body = `v2.12.identity.${now}.${now + 120}.${nonce}.a4${emailDigest}`;
  const mac = createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
  const cookie = `${body}.${mac}`;
  const attest = (method: string, path: string, search?: string) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, search, cookie }, env, now);
  for (const [method, path, search] of [
    ["GET", "/admin/sign-in", ""], ["POST", "/admin/sign-in", ""],
    ["GET", "/api/auth/callback/google", "?code=private&state=private"],
    ["GET", "/admin/not-authorized", ""], ["GET", "/api/auth/session", ""],
  ] as const) {
    const proof = attest(method, path, search)!;
    const selected = method === "POST" ?
      await withinInteractiveAdminGoogleAction(async () => readInteractiveRequest(proof, cookie, env, now)) :
      readInteractiveRequest(proof, cookie, env, now);
    assert.deepEqual(selected?.firstOwnerDiscovery, { nonce, emailDigest, epoch: "12", startedAt: now });
    assert.equal(selected?.firstOwner, undefined);
  }
  for (const [method, path, search] of [
    ["GET", P2_FIRST_OWNER_PATH, ""], ["GET", "/admin", ""], ["POST", "/api/auth/signin/google", ""],
    ["GET", "/api/auth/providers", ""], ["GET", "/api/auth/session", "?extra=1"],
    ["GET", "/admin/not-authorized", "?extra=1"], ["GET", "/api/auth/callback/other", "?code=private"],
  ] as const) assert.equal(attest(method, path, search), null);
});

test("first-time identity permits bind the selected provider, normalized email and operation context", async () => {
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const nonce = "ab".repeat(16);
  const normalizedEmail = "iñés@owned.example";
  const issue = (selector: string, issuedNonce = nonce) => {
    const body = `v2.12.identity.${now}.${now + 120}.${issuedNonce}.${selector}`;
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    return `${body}.${mac}`;
  };
  const attest = (cookie: string, method: string, path: string) =>
    attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method, path, cookie }, env, now);
  for (const [prefix, provider, otherProvider] of [["a1", "google", "resend"], ["a2", "resend", "google"]] as const) {
    const emailDigest = createHash("sha256").update(JSON.stringify(["p2q-customer-enrollment-v1", provider, nonce, normalizedEmail]))
      .digest("hex").slice(0, 62);
    const selector = prefix + emailDigest;
    const cookie = issue(selector);
    const callbackPath = `/api/customer-auth/callback/${provider}`;
    const callbackProof = attest(cookie, "GET", callbackPath)!;
    const verified = readInteractiveRequest(callbackProof, cookie, env, now);
    const enrollment = { provider, nonce, emailDigest };
    assert.deepEqual(verified?.identityEnrollment, enrollment);
    assert.equal(verified?.identityCustomerId, undefined);
    assert.ok(matchesWriterIdentityEnrollment(enrollment, normalizedEmail));
    assert.equal(matchesWriterIdentityEnrollment(enrollment, normalizedEmail.toUpperCase()), false);
    assert.equal(matchesWriterIdentityEnrollment(enrollment, "other@owned.example"), false);
    assert.equal(matchesWriterIdentityEnrollment({ ...enrollment, provider: otherProvider }, normalizedEmail), false);
    assert.equal(matchesWriterIdentityEnrollment({ ...enrollment, nonce: "cd".repeat(16) }, normalizedEmail), false);
    assert.equal(matchesWriterIdentityEnrollment({ ...enrollment, emailDigest: "x".repeat(62) }, normalizedEmail), false);
    assert.ok(attest(cookie, "POST", `/api/customer-auth/signin/${provider}`));
    for (const path of ["/sign-in", "/api/customer-auth/csrf", "/api/customer-auth/providers", "/api/customer-auth/session"]) {
      assert.ok(attest(cookie, "GET", path));
    }
    for (const [method, path] of [
      ["POST", `/api/customer-auth/signin/${otherProvider}`], ["GET", `/api/customer-auth/callback/${otherProvider}`],
      ["GET", "/account/sign-in-methods"], ["POST", "/api/customer-auth/signout"], ["POST", "/api/auth/signin/google"],
    ]) assert.equal(attest(cookie, method, path), null);
    const wrongRoute = `${now}.${Buffer.from(`GET /api/customer-auth/callback/${otherProvider}`).toString("base64url")}`;
    const wrongMac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:request:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${cookie}\n${wrongRoute}`).digest("hex");
    assert.equal(readInteractiveRequest(`${wrongRoute}.${wrongMac}`, cookie, env, now), null);
    assert.equal(attest(issue("a3" + emailDigest), "GET", callbackPath), null);
    assert.equal(attest(issue(selector.slice(0, -1)), "GET", callbackPath), null);
    assert.equal(readInteractiveRequest(callbackProof, issue(selector, "cd".repeat(16)), env, now), null);

    const f = fixture();
    f.state.epoch = "12";
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
      createClient: () => f.client,
      getInteractiveWriter: async () => verified,
    });
    let observeAfterCompletion!: () => void;
    let outsideSelection: Promise<ReturnType<typeof currentWriterIdentityEnrollment>> | undefined;
    await run("new-work", async () => {
      assert.deepEqual(currentWriterIdentityEnrollment(), enrollment);
      assert.ok(Object.isFrozen(currentWriterIdentityEnrollment()));
      assert.equal(currentWriterIdentityCustomerId(), undefined);
      assert.equal(currentWriterLifecycleSelection(), undefined);
      outsideSelection = new Promise<void>(resolve => { observeAfterCompletion = resolve; }).then(currentWriterIdentityEnrollment);
    });
    observeAfterCompletion();
    assert.equal(await outsideSelection, undefined);
    assert.equal(currentWriterIdentityEnrollment(), undefined);
    assert.equal(JSON.stringify(f.calls).includes(emailDigest), false);
  }
});

test("lifecycle browser proof requires a signed v2 selection and carries it only through the admitted operation", async () => {
  const f = fixture();
  f.state.epoch = "12";
  const now = 1_794_009_600;
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const userId = "8d680a92-8071-4fd0-9da2-c4d350aa729d";
  const selection = createHash("sha256").update(JSON.stringify(["customer", userId, userId, "preferences-off"])).digest("hex");
  const nonce = "a".repeat(32);
  const tail = `12.lifecycle.${now}.${now + 120}.${nonce}`;
  const issue = (body: string) => `${body}.${createHmac("sha256", env.CRON_SECRET)
    .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex")}`;
  const cookie = issue(`v2.${tail}.${selection}`);
  const input = { origin: INTERACTIVE_ORIGIN, method: "POST", path: "/api/account/preferences" };
  const proof = attestInteractiveRequest({ ...input, cookie }, env, now)!;
  const selected = readInteractiveRequest(proof, cookie, env, now);
  assert.equal(selected?.lifecycleSelectionSha256, selection);
  for (const invalid of [issue(`v1.${tail}`), issue(`v2.${tail}`), issue(`v2.${tail}.bad`),
    issue(`v2.${tail.replace(".lifecycle.", ".identity.")}.${selection}`), cookie.replace(selection, "0".repeat(64))]) {
    assert.equal(attestInteractiveRequest({ ...input, cookie: invalid }, env, now), null);
    assert.equal(readInteractiveRequest(proof, invalid, env, now), null);
  }
  assert.equal(attestInteractiveRequest({ ...input, method: "GET", path: `/api/admin/customer-accounts/${userId}/exports/${userId}`, cookie }, env, now), null);
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration(environment()),
    createClient: () => f.client,
    getInteractiveWriter: async () => selected,
  });
  let observeAfterCompletion!: () => void;
  let outsideSelection: Promise<string | undefined> | undefined;
  await run("new-work", async () => {
    assert.equal(currentWriterLifecycleSelection(), selection);
    outsideSelection = new Promise<void>(resolve => { observeAfterCompletion = resolve; }).then(currentWriterLifecycleSelection);
  });
  observeAfterCompletion();
  assert.equal(await outsideSelection, undefined);
  assert.equal(currentWriterLifecycleSelection(), undefined);
  assert.equal(JSON.stringify(f.calls).includes(selection), false);
});

test("Next request handoff overwrites caller headers on selected paths and strips them elsewhere", async () => {
  const { NextRequest } = await import("next/server");
  const now = Math.floor(Date.now() / 1000);
  const env = { ...environment(), VERCEL_URL: "owned.vercel.app", CRON_SECRET: "owned-staging-cron-test-key-only".repeat(2) };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const body = `v2.12.identity.${now}.${now + 120}.${"a".repeat(32)}.${customerIdentitySelector}`;
    const mac = createHmac("sha256", env.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${env.VERCEL_URL}\n${env.VERCEL_GIT_COMMIT_SHA}\n${"a".repeat(64)}\n${body}`).digest("hex");
    const cookie = `${body}.${mac}`;
    const headers = { cookie: `${INTERACTIVE_COOKIE}=${cookie}`, [INTERACTIVE_HEADER]: "caller-forgery" };
    const allowed = new NextRequest(INTERACTIVE_ORIGIN + "/api/customer-auth/callback/google", { headers });
    const handoff = interactiveRequestHeaders(allowed)?.get(INTERACTIVE_HEADER);
    assert.ok(handoff);
    assert.notEqual(handoff, "caller-forgery");
    assert.equal(readInteractiveRequest(handoff, cookie)?.epoch, "12");
    assert.equal(readInteractiveRequest(handoff, cookie)?.identityCustomerId, selectedCustomerId);
    const unrelated = new NextRequest(INTERACTIVE_ORIGIN + "/api/webhooks/square", { method: "POST", headers });
    assert.equal(interactiveRequestHeaders(unrelated)?.get(INTERACTIVE_HEADER), null);
    assert.equal(interactiveRequestHeaders(new NextRequest(unrelated.url)), undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("recovery reads the current epoch and commits admission before passing the original request", async () => {
  const f = fixture(); f.state.newWork = false; f.state.epoch = "7";
  const request = new Request("https://owned.invalid", { method: "POST", body: "signed-raw-body" });
  const response = await withWriterAdmission("recovery", async (actual: Request) => {
    assert.equal(actual, request); assert.equal(f.calls.at(-1)?.sql.includes("begin_operation"), true);
    assert.equal(await actual.text(), "signed-raw-body"); return Response.json({ ok: true });
  }, f.run)(request);
  assert.equal(response.status, 200); assert.equal(f.state.ended, true);
  assert.equal(f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[4], "7");
});

test("opaque identity is the admitted ledger UUID, scoped to the active task and cleared after completion", async () => {
  const f = fixture(); f.state.epoch = "8";
  assert.equal(currentWriterOperationIdentity(), undefined);
  await f.run("recovery", async () => {
    const identity = currentWriterOperationIdentity()!;
    assert.ok(Object.isFrozen(identity));
    assert.equal(identity.operationId, f.calls.find(call => call.sql.includes("begin_operation"))?.values?.[0]);
    assert.deepEqual({ ...identity, operationId: "owned" }, { operationId: "owned", kind: "recovery", epoch: "8",
      producerSha256: "b".repeat(64), sourceCommit: "c".repeat(40), targetSha256: "a".repeat(64) });
    await Promise.resolve(); assert.equal(currentWriterOperationIdentity(), identity);
  });
  assert.equal(currentWriterOperationIdentity(), undefined);
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  await off("recovery", async () => assert.equal(currentWriterOperationIdentity(), undefined));
});

test("the real Square handler validates the untouched signature and persists recovery only after admission", async () => {
  const f = fixture(); f.state.newWork = false; let persisted = 0;
  const url = "https://owned.invalid/api/webhooks/square", key = "owned-signature-fixture";
  const raw = JSON.stringify({ event_id: "owned_refund_event", type: "refund.created", data: { object: { refund: {
    id: "owned_refund", payment_id: "owned_payment", status: "PENDING", amount_money: { amount: 500, currency: "CAD" }, created_at: "2026-11-04T00:00:00Z",
  } } } }, null, 2) + "\n";
  const request = () => new Request(url, { method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": createHmac("sha256", key).update(url + raw).digest("base64") } });
  const handler = createSquareWebhookPostHandler({
    getEnv: () => ({ notificationUrl: url, webhookSignatureKey: key }),
    alerts: createServicePaymentAlertLogger({ logWarn: () => {}, logError: () => {} }),
    claimSquareInvoiceWebhookEvent: async () => undefined,
    recordSquareInvoiceWebhookEventProcessed: async () => {},
    findOrderBySquareInvoiceId: async () => null,
    finalizeNoShowCharge: async () => { throw new Error("unexpected-finalizer"); },
    finalizeSquarePayment: async () => { throw new Error("unexpected-finalizer"); },
    finalizeTrainingSquareInvoicePayment: async () => { throw new Error("unexpected-finalizer"); },
    recordSquareRefundEvent: async () => { assert.equal(f.calls.at(-1)?.sql.includes("begin_operation"), true); persisted++; return { duplicate: false }; },
  });
  const admitted = withWriterAdmission("recovery", handler, f.run);
  assert.equal((await admitted(request())).status, 200); assert.equal(persisted, 1);
  f.state.recovery = false;
  const blocked = request();
  assert.equal((await admitted(blocked)).status, 503); assert.equal(blocked.bodyUsed, false); assert.equal(persisted, 1);
});

test("lost admission or settlement acknowledgements never invoke or replay effects", async () => {
  for (const stage of ["begin_operation", "finish_operation"]) {
    const f = fixture(), query = f.client.query; let effects = 0, failures = 0;
    f.client.query = async (sql, values) => { const result = await query(sql, values); if (sql.includes(stage)) { failures++; throw new Error("owned-private-marker"); } return result; };
    const response = await withWriterAdmission("recovery", async () => { effects++; return Response.json({ ok: true }); }, f.run)();
    assert.equal(response.status, 503); assert.equal(effects, stage === "begin_operation" ? 0 : 1); assert.equal(failures, 1);
    assert.equal((await response.text()).includes("owned-private-marker"), false); assert.equal(f.state.ended, true);
  }
});

test("5xx, handler exceptions and idle connection loss cannot acknowledge a successful recovery", async () => {
  for (const mode of ["response", "exception", "socket"]) {
    const f = fixture();
    const response = await withWriterAdmission("recovery", async () => {
      if (mode === "exception") throw new Error("owned-private-marker");
      if (mode === "socket") f.client.emit("error", new Error("owned-private-marker"));
      return Response.json({ ok: true }, { status: mode === "response" ? 500 : 200 });
    }, f.run)();
    assert.equal(response.status, 503); assert.equal(f.state.uncertain, true); assert.equal(f.state.ended, true);
  }
});

test("TLS, actual target, policy lookup and disconnect failures remain sanitized and fail closed", async () => {
  for (const mode of ["tls", "target", "policy", "disconnect"]) {
    const f = fixture(); let effects = 0;
    if (mode === "tls") f.state.authorized = false;
    if (mode === "target") f.state.database = "other";
    if (mode === "policy") { const query = f.client.query; f.client.query = async (sql, values) => { if (sql.includes("current_policy")) throw new Error("private-marker"); return query(sql, values); }; }
    if (mode === "disconnect") f.client.end = async () => { throw new Error("private-marker"); };
    const response = await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, f.run)();
    assert.equal(response.status, 503); assert.equal(effects, mode === "disconnect" ? 1 : 0);
    assert.equal((await response.text()).includes("private-marker"), false);
  }
});



test("caught Square charge errors retain uncertainty even behind successful or payment-rejected responses", async () => {
  for (const stage of ["authorize", "finalize", "capture", "captured-marker", "email", "void", "void-by-key"]) {
    const f = fixture(); let captures = 0;
    const fail = () => { throw new Error("owned-private-marker"); };
    const handler = async () => {
      const result = await authorizeCaptureSquarePayment({ orderReference: "owned-order", amountCents: 500, currency: "CAD", sourceId: "owned-nonce", idempotencyKey: "owned-key" }, {
        authorizePayment: async () => {
          if (stage === "authorize" || stage === "void-by-key") fail();
          return { payment: { id: "owned-payment", status: stage === "void" ? "FAILED" : "APPROVED", amount_money: { amount: 500, currency: "CAD" } } };
        },
        finalize: async () => { if (stage === "finalize") fail(); return { transition: "applied" }; },
        capturePayment: async () => { captures++; if (stage === "capture") fail(); },
        onCaptured: async () => { if (stage === "captured-marker") fail(); },
        onSuccess: async () => { if (stage === "email") fail(); },
        voidPayment: async () => { if (stage === "void") fail(); },
        voidPaymentByIdempotencyKey: async () => { if (stage === "void-by-key") fail(); },
        logError: () => {},
      });
      return Response.json({ ok: result.ok }, { status: result.ok ? 200 : 402 });
    };
    assert.equal((await withWriterAdmission("new-work", handler, f.run)()).status, 503, stage);
    assert.equal(f.state.uncertain, true, stage);
    assert.ok(captures <= 1);
    // The same domain flow retains its prior response when admission is off.
    const off = createWriterAdmissionRunner({ getConfiguration: () => null });
    const original = await withWriterAdmission("new-work", handler, off)();
    assert.ok(original.status === 200 || original.status === 402);
  }
});

test("uncertainty is sticky across awaits and isolated between simultaneous requests", async () => {
  const failed = fixture(), clean = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = withWriterAdmission("new-work", async () => {
    markWriterOperationUncertain(); entered(); await held;
    return Response.json({ ok: true });
  }, failed.run)();
  await started;
  assert.equal((await withWriterAdmission("new-work", async () => Response.json({ ok: true }), clean.run)()).status, 200);
  release(); assert.equal((await pending).status, 503);
  assert.equal(failed.state.uncertain, true); assert.equal(clean.state.uncertain, false);
});


test("application database must share the admitted direct target, login and strict TLS before effects", async () => {
  const valid = environment();
  assert.ok(resolveWriterAdmissionConfiguration(valid));
  for (const databaseUrl of [
    undefined,
    "postgresql://protocol_runtime:application-private-marker@elsewhere.owned.invalid/owned?sslmode=verify-full",
    valid.DATABASE_URL.replace("/owned?", "/another?"),
    valid.DATABASE_URL.replace("db.owned.invalid/", "db.owned.invalid:6432/"),
    valid.DATABASE_URL.replace("protocol_runtime:", "legacy_runtime:"),
    valid.DATABASE_URL.replace("db.owned.invalid", "db-pooler.owned.invalid"),
    valid.DATABASE_URL.replace("verify-full", "disable"),
    valid.DATABASE_URL + "&host=elsewhere.owned.invalid",
    valid.DATABASE_URL + "&options=-csearch_path=other",
  ]) {
    let created = 0, effects = 0;
    const run = createWriterAdmissionRunner({
      getConfiguration: () => resolveWriterAdmissionConfiguration({ ...valid, DATABASE_URL: databaseUrl }),
      createClient: () => { created++; throw new Error(); },
    });
    const response = await withWriterAdmission("new-work", async () => { effects++; return Response.json({ ok: true }); }, run)();
    assert.equal(response.status, 503);
    assert.equal(created, 0, "configuration must refuse before any connection is created");
    assert.equal(effects, 0);
    assert.equal((await response.text()).includes("application-private-marker"), false);
  }
});

test("reviewed staging pooler is accepted for business traffic while the ledger stays direct and closed", async () => {
  const db = stagingRelease.frontendDatabase;
  const direct = `postgresql://${db.runtimeRole}:owned-test@${db.directHost}/${db.database}?sslmode=verify-full`;
  const pooled = direct.replace(db.directHost, db.pooledHost);
  const base = {
    ...environment(),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({
      environment: "staging", host: db.directHost, port: 5432, database: db.database,
      user: db.runtimeRole, serverMajor: 18, targetSha256: "a".repeat(64),
    }),
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: direct,
  };
  for (const databaseUrl of [pooled, pooled + "&channel_binding=require"]) {
    const configuration = resolveWriterAdmissionConfiguration({ ...base, DATABASE_URL: databaseUrl });
    assert.equal(configuration?.connection.host, db.directHost);
    assert.equal(configuration?.connection.ssl.rejectUnauthorized, true);
  }
  const ledger = fixture({ username: db.runtimeRole, database: db.database });
  ledger.state.newWork = false;
  ledger.state.recovery = false;
  const run = createWriterAdmissionRunner({
    getConfiguration: () => resolveWriterAdmissionConfiguration({ ...base, DATABASE_URL: pooled }),
    createClient: connection => {
      assert.equal(connection.host, db.directHost);
      return ledger.client;
    },
    getInteractiveWriter: async () => null,
  });
  for (const kind of ["new-work", "recovery"] as const) {
    await assert.rejects(run(kind, async () => assert.fail("closed staging ledger reached business writes")),
      { name: "WriterAdmissionError", code: "unavailable" });
  }
  assert.equal(ledger.calls.filter(call => call.sql.includes("current_policy")).length, 2);
  assert.ok(ledger.calls.every(call => !call.sql.includes("begin_operation")));

  for (const env of [
    { ...base, DATABASE_URL: pooled.replace(db.pooledHost, "other-pooler.example.test") },
    { ...base, DATABASE_URL: pooled.replace(db.runtimeRole, "wrong_role") },
    { ...base, DATABASE_URL: pooled.replace(`/${db.database}?`, "/wrong?") },
    { ...base, DATABASE_URL: pooled.replace("verify-full", "require") },
    { ...base, DATABASE_URL: pooled + "&sslmode=verify-full" },
    { ...base, DATABASE_URL: pooled + "&channel_binding=disable" },
    { ...base, DATABASE_URL: pooled + "&options=-csearch_path=other" },
    { ...base, DATABASE_URL: pooled, FRONTEND_WRITER_ADMISSION_DATABASE_URL: pooled },
    { ...base, APP_ENV: "production", VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId,
      DATABASE_URL: pooled, FRONTEND_WRITER_ADMISSION_TARGET_JSON: base.FRONTEND_WRITER_ADMISSION_TARGET_JSON.replace("staging", "production") },
  ]) assert.throws(() => resolveWriterAdmissionConfiguration(env), WriterAdmissionError);
});
