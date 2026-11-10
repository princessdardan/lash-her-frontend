import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { launchP2IdentityRotationBrowserReadRecorder, prepareP2IdentityRotationBrowserReadPlan,
  recordP2IdentityRotationBrowserReads } from "./p2-identity-key-rotation-browser-recorder.mjs";

const sha = value => createHash("sha256").update(value).digest("hex"), uuid = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const rotation = { version: 1, environment: "staging", actionId: "p2-key-rotation-owned", bindingSha256: sha("binding"),
  candidateSha256: sha("candidate"), sourceCommit: "a".repeat(40), originalReleaseId: "original-release", courseId: uuid("1"),
  featureControls: { identity: true }, writerAdmissionBinding: { mode: "enforce" },
  subjects: { "course-learner": uuid("2"), "course-admin": uuid("3"), "community-member": uuid("4"), "community-admin": uuid("5") },
  configuration: { overlap: { sha256: sha("overlap") }, "current-only": { sha256: sha("current") } } };
const deployment = { phase: "overlap", deploymentId: "dpl_owned", deploymentUrl: "https://owned.vercel.app",
  sourceCommit: rotation.sourceCommit, configurationSha256: rotation.configuration.overlap.sha256, workloadReceiptSha256: sha("workload") };
const canonical = { version: 1, status: "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED", environment: "staging",
  browserOrigin: "https://staging.lashher.com", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
  deploymentId: deployment.deploymentId, deploymentUrl: deployment.deploymentUrl, sourceCommit: rotation.sourceCommit,
  releaseId: rotation.originalReleaseId, configurationRecordSha256: deployment.workloadReceiptSha256,
  featureControls: rotation.featureControls, writerAdmissionBinding: rotation.writerAdmissionBinding,
  authenticationOrigins: { customerOrigin: "https://staging.lashher.com", adminOrigin: "https://staging.lashher.com",
    adminRedirectProxyOrigin: null, customerRedirectProxyEnabled: false }, aliasReadbackSha256: sha("alias"),
  protectedWorkloadSha256: sha("protected"), observedAt: "2026-11-06T12:00:00.000Z", aliasReadbacks: 2,
  aliasRedirect: false, workloadChallengeVerified: true, tlsVerified: true, probeExpiryExtended: false, releaseAccepted: false };
const response = (status, headers, value) => ({ status: () => status, allHeaders: async () => headers,
  body: async () => Buffer.from(JSON.stringify(value)), json: async () => value });

test("fixed plan binds one rollout and the bounded frontend-only read admission class", () => {
  const plan = prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment, canonical);
  assert.equal(plan.configurationSha256, rotation.configuration.overlap.sha256);
  assert.equal(plan.maximumWindowSeconds, 60);
  assert.equal(plan.admissionClass, "closed-frontend-read-only");
  assert.equal(plan.gatewayAdmissionRequired, false);
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", { ...deployment, configurationSha256: sha("other") }, canonical));
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment,
    { ...canonical, browserOrigin: "https://owned.vercel.app" }));
});

test("fixed child initializes from the module directory and binds post-removal to the current deployment", async () => {
  const current = { ...deployment, phase: "current-only", configurationSha256: rotation.configuration["current-only"].sha256 };
  const plan = prepareP2IdentityRotationBrowserReadPlan(rotation, "post-removal", current, canonical);
  assert.equal(plan.phase, "post-removal");
  assert.equal(plan.configurationSha256, current.configurationSha256);
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(rotation, "post-removal", deployment, canonical));
  const controller = launchP2IdentityRotationBrowserReadRecorder(plan);
  try {
    assert.equal(await controller.initialized(), true);
    await assert.rejects(() => controller.authenticate({}), /P2_IDENTITY_ROTATION_BROWSER_REFUSED/u);
  } finally { await controller.close(); }
});

test("managed browser reads bind the profiled workload proof to its exact candidate", () => {
  const managed = { ...rotation, version: 2, qualificationTargetProfile: profile, candidateObjectSha256: sha("candidate-object") };
  const receipt = { ...canonical, version: 2, qualificationTargetProfile: profile,
    candidateSha256: managed.candidateObjectSha256, phase2ContractManifestSha256: "sha256:" + sha("contract") };
  assert.equal(prepareP2IdentityRotationBrowserReadPlan(managed, "overlap", deployment, receipt).deploymentId, deployment.deploymentId);
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(managed, "overlap", deployment, canonical));
  assert.throws(() => prepareP2IdentityRotationBrowserReadPlan(managed, "overlap", deployment,
    { ...receipt, candidateSha256: sha("other-candidate") }));
});

test("ordinary isolated customer/admin contexts exercise exact same-origin Course reads without token capture", async () => {
  const calls = [], requestId = uuid("6"), course = { course: { id: rotation.courseId } };
  const page = profile => ({ request: { get: async url => { calls.push([profile, url]);
    return response(200, { "cache-control": "private, no-store", "x-request-id": requestId }, course); } } });
  const input = { version: 1, environment: "staging", actionId: rotation.actionId, challenge: sha("challenge"),
    bindingSha256: rotation.bindingSha256, sourceCommit: rotation.sourceCommit, candidateSha256: rotation.candidateSha256,
    phase: "overlap", configurationSha256: deployment.configurationSha256, deploymentId: deployment.deploymentId,
    deploymentUrl: deployment.deploymentUrl, browserOrigin: canonical.browserOrigin,
    canonicalAliasReadbackSha256: canonical.aliasReadbackSha256, canonicalProtectedWorkloadSha256: canonical.protectedWorkloadSha256,
    workloadReceiptSha256: deployment.workloadReceiptSha256,
    browserProgramSha256: prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment, canonical).browserProgramSha256,
    courseId: rotation.courseId, customerId: rotation.subjects["course-learner"], adminId: rotation.subjects["course-admin"] };
  const record = await recordP2IdentityRotationBrowserReads(input,
    { customer: page("customer"), admin: page("admin") });
  assert.equal(record.status, "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED");
  assert.equal(record.challenge, input.challenge);
  assert.deepEqual(record.profiles.map(row => [row.profile, row.httpStatus]), [["course-learner", 200], ["course-admin", 200]]);
  assert.equal(record.tokenBytesOutput, false); assert.equal(record.requestsIntercepted, false); assert.equal(record.storageInjected, false);
  assert.deepEqual(calls.map(row => row[1]), [
    `https://staging.lashher.com/api/academy/courses/${rotation.courseId}`, `https://staging.lashher.com/api/admin/courses/${rotation.courseId}`]);
});

test("redirects and non-200 protected reads refuse", async () => {
  const input = { version: 1, environment: "staging", actionId: rotation.actionId, challenge: sha("challenge"), bindingSha256: rotation.bindingSha256,
    sourceCommit: rotation.sourceCommit, candidateSha256: rotation.candidateSha256, phase: "overlap", configurationSha256: deployment.configurationSha256,
    deploymentId: deployment.deploymentId, deploymentUrl: deployment.deploymentUrl, browserOrigin: canonical.browserOrigin,
    canonicalAliasReadbackSha256: canonical.aliasReadbackSha256, canonicalProtectedWorkloadSha256: canonical.protectedWorkloadSha256,
    workloadReceiptSha256: deployment.workloadReceiptSha256,
    browserProgramSha256: prepareP2IdentityRotationBrowserReadPlan(rotation, "overlap", deployment, canonical).browserProgramSha256,
    courseId: rotation.courseId, customerId: rotation.subjects["course-learner"], adminId: rotation.subjects["course-admin"] };
  const bad = { request: { get: async () => response(302, { location: "/sign-in" }, {}) } };
  await assert.rejects(() => recordP2IdentityRotationBrowserReads(input, { customer: bad, admin: bad }), /P2_IDENTITY_ROTATION_BROWSER_REFUSED/u);
});
