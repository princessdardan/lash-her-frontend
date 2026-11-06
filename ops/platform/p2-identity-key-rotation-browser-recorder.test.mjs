import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareP2IdentityRotationBrowserReadPlan, recordP2IdentityRotationBrowserReads } from "./p2-identity-key-rotation-browser-recorder.mjs";

const sha = value => createHash("sha256").update(value).digest("hex"), uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const rotation = { version: 1, environment: "staging", actionId: "p2-key-rotation-owned", bindingSha256: sha("binding"),
  candidateSha256: sha("candidate"), sourceCommit: "a".repeat(40), courseId: uuid("1"),
  subjects: { "course-learner": uuid("2"), "course-admin": uuid("3"), "community-member": uuid("4"), "community-admin": uuid("5") },
  configuration: { overlap: { sha256: sha("overlap") }, "current-only": { sha256: sha("current") } } };
const deployment = { phase: "overlap", deploymentId: "dpl_owned", deploymentUrl: "https://owned.vercel.app",
  sourceCommit: rotation.sourceCommit, configurationSha256: rotation.configuration.overlap.sha256, workloadReceiptSha256: sha("workload") };
const response = (status, headers, value) => ({ status: () => status, allHeaders: async () => headers,
  body: async () => Buffer.from(JSON.stringify(value)), json: async () => value });

test("fixed plan binds one rollout and the bounded frontend-only read admission class", () => {
  const plan = prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment);
  assert.equal(plan.configurationSha256, rotation.configuration.overlap.sha256);
  assert.equal(plan.maximumWindowSeconds, 60);
  assert.equal(plan.admissionClass, "bounded-frontend-new-work-read-only");
  assert.equal(plan.gatewayAdmissionRequired, false);
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", { ...deployment, configurationSha256: sha("other") }));
});

test("ordinary isolated customer/admin contexts exercise exact same-origin Course reads without token capture", async () => {
  const calls = [], now = Math.floor(Date.now() / 1000), requestId = uuid("6"), course = { course: { id: rotation.courseId } };
  const page = (profile, subject) => ({ request: { get: async url => { calls.push([profile, url]);
    if (url.endsWith("/api/customer-auth/session")) return response(200, {}, { user: { id: subject } });
    if (url.endsWith("/api/auth/session")) return response(200, {}, { user: { id: subject, authenticatedAt: now } });
    return response(200, { "cache-control": "private, no-store", "x-request-id": requestId }, course); } } });
  const input = { version: 1, environment: "staging", actionId: rotation.actionId, challenge: sha("challenge"),
    bindingSha256: rotation.bindingSha256, sourceCommit: rotation.sourceCommit, candidateSha256: rotation.candidateSha256,
    phase: "overlap", configurationSha256: deployment.configurationSha256, deploymentId: deployment.deploymentId,
    deploymentUrl: deployment.deploymentUrl, workloadReceiptSha256: deployment.workloadReceiptSha256,
    browserProgramSha256: prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment).browserProgramSha256,
    courseId: rotation.courseId, customerId: rotation.subjects["course-learner"], adminId: rotation.subjects["course-admin"] };
  const record = await recordP2IdentityRotationBrowserReads(input,
    { customer: page("customer", input.customerId), admin: page("admin", input.adminId) });
  assert.equal(record.status, "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED");
  assert.deepEqual(record.profiles.map(row => [row.profile, row.httpStatus]), [["course-learner", 200], ["course-admin", 200]]);
  assert.equal(record.tokenBytesOutput, false); assert.equal(record.requestsIntercepted, false); assert.equal(record.storageInjected, false);
  assert.deepEqual(calls.map(row => row[1]), [
    "https://owned.vercel.app/api/customer-auth/session", "https://owned.vercel.app/api/auth/session",
    `https://owned.vercel.app/api/academy/courses/${rotation.courseId}`, `https://owned.vercel.app/api/admin/courses/${rotation.courseId}`]);
});

test("redirects, non-private responses, wrong subjects and non-200 reads refuse", async () => {
  const input = { version: 1, environment: "staging", actionId: rotation.actionId, challenge: sha("challenge"), bindingSha256: rotation.bindingSha256,
    sourceCommit: rotation.sourceCommit, candidateSha256: rotation.candidateSha256, phase: "overlap", configurationSha256: deployment.configurationSha256,
    deploymentId: deployment.deploymentId, deploymentUrl: deployment.deploymentUrl, workloadReceiptSha256: deployment.workloadReceiptSha256,
    browserProgramSha256: prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment).browserProgramSha256,
    courseId: rotation.courseId, customerId: rotation.subjects["course-learner"], adminId: rotation.subjects["course-admin"] };
  const bad = { request: { get: async url => url.endsWith("session")
    ? response(200, {}, { user: { id: "wrong", authenticatedAt: Math.floor(Date.now() / 1000) } })
    : response(302, { location: "/sign-in" }, {}) } };
  await assert.rejects(() => recordP2IdentityRotationBrowserReads(input, { customer: bad, admin: bad }), /P2_IDENTITY_ROTATION_BROWSER_REFUSED/u);
});
