import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isP2IdentityRotationParentAuthority, prepareP2IdentityRotationParent,
  runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";
import { requireP2IdentityRotationCaptureMetadata } from "./p2-identity-key-rotation-transport.mjs";
import { observeIdentityRotationBoundary, P2_IDENTITY_ROTATION_SERVICES } from "./p2-identity-key-rotation-observer.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const plan = Object.freeze({ version: 1, environment: "staging", actionId: "p2-key-rotation-owned",
  bindingSha256: sha("binding"), candidateSha256: sha("candidate"), sourceCommit: "a".repeat(40),
  hostMachineId: "b".repeat(32), privateDirectory: "/private/tmp/p2-key-rotation-parent",
  courseId: "11111111-1111-4111-8111-111111111111",
  subjects: { "course-learner": "11111111-1111-4111-8111-111111111111",
    "course-admin": "22222222-2222-4222-8222-222222222222",
    "community-member": "33333333-3333-4333-8333-333333333333",
    "community-admin": "44444444-4444-4444-8444-444444444444" },
  configuration: Object.fromEntries(["baseline", "overlap", "current-only"].map(phase => [phase,
    { sha256: sha(phase), privateRef: `/private/tmp/p2-key-rotation-parent/config/${phase}` }])) });
const prepared = { migration: { job: { sourceCommit: plan.sourceCommit }, candidate: { environment: "staging", contractPhase: "p2" } } };
const action = { recoveryActionId: plan.actionId, candidateSha256: plan.candidateSha256, originalReceiptSha256: {
  "frontend-release-started.json": sha("started"), "database-receipt.json": sha("database"), "job-outcome.json": null,
  "vercel/frontend-build-outcome.json": sha("build") } };
const bindings = { sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256, bindingSha256: plan.bindingSha256,
  configuration: structuredClone(plan.configuration), featureControls: { identity: true }, writerAdmissionBinding: { mode: "enforce" } };
let sessionCalls = 0;
const dependencies = { getUrl: async () => { sessionCalls += 1; return "not-read"; }, verifyEnvironment: async () => {} };

test("parent preparation binds the exact candidate, recovery action, and three configuration records", () => {
  const selected = prepareP2IdentityRotationParent(plan, prepared, action, bindings, dependencies);
  assert.notEqual(selected, plan);
  assert.deepEqual(selected, plan);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(isP2IdentityRotationParentAuthority({}, selected), false);
  assert.throws(() => prepareP2IdentityRotationParent(plan, prepared, { ...action, candidateSha256: sha("other") }, bindings, dependencies),
    /P2_IDENTITY_ROTATION_PARENT_PLAN_REFUSED/u);
  assert.throws(() => prepareP2IdentityRotationParent(plan, prepared,
    { ...action, originalReceiptSha256: sha("scalar-was-never-valid") }, bindings, dependencies),
  /P2_IDENTITY_ROTATION_PARENT_PLAN_REFUSED/u);
  assert.throws(() => prepareP2IdentityRotationParent(plan, prepared,
    { ...action, originalReceiptSha256: { ...action.originalReceiptSha256, "../../escape.json": sha("bad") } }, bindings, dependencies),
  /P2_IDENTITY_ROTATION_PARENT_PLAN_REFUSED/u);
});

test("caller objects cannot stand in for the fixed single-use SSH transport", async () => {
  sessionCalls = 0;
  const selected = prepareP2IdentityRotationParent(plan, prepared, action, bindings, dependencies);
  await assert.rejects(() => runP2IdentityRotationParent(selected, { confirmation: `staging/${selected.actionId}`,
    transport: {} }),
  /P2_IDENTITY_ROTATION_TRANSPORT_REFUSED/u);
  assert.equal(sessionCalls, 0);
});

test("terminal protocol closes the actual frontend session before the host proves closure and commits", async () => {
  const preparedParent = { ...prepared, plan: { environment: "staging", targetSha256: sha("target"),
    owner: { name: "frontend_migration_owner", oid: "42" } } };
  const selected = prepareP2IdentityRotationParent(plan, preparedParent, action, bindings, dependencies);
  let sessionOpen = false, finishWhileOpen = false, closureAfterSession = false;
  const preparedReceipt = { status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED", keyRemovalVerified: true,
    actionId: plan.actionId, bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit,
    candidateSha256: plan.candidateSha256, sqlExecuted: false, rolesPrepared: false, loginChanged: false,
    trafficAuthorized: false, tokenBytesOutput: false, credentialHashesOutput: false,
    communityMemberFeatureAdded: false, newPublicEndpoint: false };
  const host = { active: () => true, check: async () => {},
    arm: async () => ({ status: "P2_IDENTITY_ROTATION_PARENT_ARMED", bindingSha256: plan.bindingSha256 }),
    finish: async () => { finishWhileOpen = sessionOpen; return preparedReceipt; },
    frontendSessionClosed: async () => { closureAfterSession = !sessionOpen;
      return { ...preparedReceipt, frontendSessionCloseReceiptSha256: sha("frontend-session-closed") }; } };
  const withTransport = async (_transport, _plan, task) => task(host);
  const withSession = async (_prepared, _action, _dependencies, task) => {
    sessionOpen = true;
    try { return await task({ client: {}, verify: async () => {}, receipt: { admissionEpoch: "1" }, probe: {} }); }
    finally { sessionOpen = false; }
  };
  const runController = async (_plan, _parent, _dependencies, options) => {
    assert.equal(options.fixture, true);
    return { status: "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED", sourceMechanicsQualified: true };
  };
  const result = await runP2IdentityRotationParent(selected, { confirmation: `staging/${selected.actionId}`, transport: {} },
    { fixture: true, fixtureTerminal: true, withTransport, withSession, observePhysical: async () => {}, runController });
  assert.equal(finishWhileOpen, true);
  assert.equal(closureAfterSession, true);
  assert.equal(result.status, "P2_IDENTITY_KEY_ROTATION_PARENT_FIXTURE_JOINED");
  assert.equal(result.keyRemovalVerified, false);
});

test("public runtime boundary projects exact three-field container rows while rejecting private health fields", async () => {
  const containers = P2_IDENTITY_ROTATION_SERVICES.map((service, index) => ({ service,
    containerId: (index + 1).toString(16).padStart(64, "0"),
    image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${"b".repeat(64)}` }));
  const context = { version: 1, environment: "staging", actionId: plan.actionId, phase: "baseline",
    bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
    runtimeConfigurationSha256: sha("runtime"), frontendConfigurationSha256: sha("frontend"),
    frontendSession: { verify: async () => {}, receipt: { candidateSha256: plan.candidateSha256 },
      probe: { receipt: { sourceCommit: plan.sourceCommit } } },
    hostScope: { verify() {}, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
      bindingSha256: plan.bindingSha256 } };
  const dependencies = { observePhysical: async () => ({ status: "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED",
      sourceCommit: plan.sourceCommit, admission: { newWork: false, recovery: false, active: 0, uncertain: 0 } }),
    observeRuntime: async () => ({ configurationSha256: context.runtimeConfigurationSha256,
      nativeSchedulesEnabled: false, businessSchedulesEnabled: false, containers,
      courseCurrent: true, communityCurrent: true, boundaryChecks: ["private-application-credential-required",
        "private-community-peer-denied", "private-course-tls-catalog", "public-metrics-hidden",
        "public-tls-missing-workload-denied"] }),
    observeFrontendProvider: async () => ({ configurationSha256: context.frontendConfigurationSha256,
      cronsEnabled: false, aliasJobActive: false, deploymentId: "dpl_Owned" }) };
  assert.equal((await observeIdentityRotationBoundary(context, dependencies)).containerCount, 10);
  dependencies.observeRuntime = async () => ({ configurationSha256: context.runtimeConfigurationSha256,
    nativeSchedulesEnabled: false, businessSchedulesEnabled: false, containers: containers.map(row => ({ ...row, health: "healthy" })),
    courseCurrent: true, communityCurrent: true, boundaryChecks: ["private-application-credential-required",
      "private-community-peer-denied", "private-course-tls-catalog", "public-metrics-hidden",
      "public-tls-missing-workload-denied"] });
  await assert.rejects(() => observeIdentityRotationBoundary(context, dependencies), /P2_IDENTITY_ROTATION_BOUNDARY_REFUSED/u);
});

test("fixed capture transport accepts only the four ordered timing-only records", () => {
  const rows = ["community-admin", "community-member", "course-admin", "course-learner"].map(profile =>
    ({ status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", profile,
      tokenIssuedAt: "2027-01-15T07:02:30.000Z", tokenExpiresAt: "2027-01-15T07:07:30.000Z" }));
  assert.equal(requireP2IdentityRotationCaptureMetadata(rows), rows);
  for (const changed of [
    { oldToken: "synthetic.old.token" }, { newToken: "synthetic.new.token" }, { privateCredentialBytes: true },
    { profile: "course-admin" }, { tokenExpiresAt: "2027-01-15T07:07:31.000Z" }, { tokenIssuedAt: "2027-02-31T07:02:30.000Z" },
  ]) assert.throws(() => requireP2IdentityRotationCaptureMetadata([{ ...rows[0], ...changed }, ...rows.slice(1)]),
    /P2_IDENTITY_ROTATION_TRANSPORT_REFUSED/u);
});
