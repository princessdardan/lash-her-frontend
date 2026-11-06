import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isP2IdentityRotationParentAuthority, prepareP2IdentityRotationParent,
  runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";

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
const action = { recoveryActionId: plan.actionId, candidateSha256: plan.candidateSha256, originalReceiptSha256: sha("receipt") };
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
});

test("caller objects cannot stand in for the fixed single-use SSH transport", async () => {
  sessionCalls = 0;
  const selected = prepareP2IdentityRotationParent(plan, prepared, action, bindings, dependencies);
  await assert.rejects(() => runP2IdentityRotationParent(selected, { confirmation: `staging/${selected.actionId}`,
    transport: {} }),
  /P2_IDENTITY_ROTATION_TRANSPORT_REFUSED/u);
  assert.equal(sessionCalls, 0);
});
