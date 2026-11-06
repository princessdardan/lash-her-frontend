import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import { runIdentityKeyRotationController } from "./p2-identity-key-rotation-controller.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const profiles = ["community-admin", "community-member", "course-admin", "course-learner"];

function plan(directory) {
  return { version: 1, environment: "staging", actionId: "p2-key-rotation-owned", bindingSha256: sha("binding"),
    candidateSha256: sha("candidate"), sourceCommit: "a".repeat(40), hostMachineId: "b".repeat(32), privateDirectory: directory,
    courseId: "22222222-2222-4222-8222-222222222222",
    subjects: { "course-learner": "11111111-1111-4111-8111-111111111111",
      "course-admin": "22222222-2222-4222-8222-222222222222",
      "community-member": "33333333-3333-4333-8333-333333333333",
      "community-admin": "44444444-4444-4444-8444-444444444444" },
    configuration: Object.fromEntries(["baseline", "overlap", "current-only"].map(phase => [phase,
      { sha256: sha(phase), privateRef: `${directory}/config/${phase}` }])) };
}

const parent = { sourceOwnedFixedAction: true, hostLockHeld: true, frontendPhysicalLockHeld: true, configOnly: true,
  nativeSchedulesEnabled: false, businessSchedulesEnabled: false, sqlAuthorized: false, rolePreparationAuthorized: false,
  loginChangeAuthorized: false };

function harness(selected, { failFirst = false, failAt = failFirst ? 1 : null, initialRuntime = "baseline", initialFrontend = "baseline" } = {}) {
  let runtime = initialRuntime, frontend = initialFrontend, clock = Date.parse("2027-01-15T07:10:00.000Z"), failed = false;
  const calls = [], restored = [], failClosed = [];
  const containers = ["community-api", "community-tls", "community-worker", "course-api", "course-export-cleanup", "course-media",
    "course-publisher", "course-snapshot", "course-tls", "gateway"].map((service, index) => ({ service,
    containerId: String(index + 1).repeat(64).slice(0, 64),
    image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${String(index + 1).repeat(64).slice(0, 64)}` }));
  const result = (intent, reconciled) => ({ version: 1, status: "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED", actionId: intent.actionId,
    phase: intent.phase, kind: intent.kind, fromConfigurationSha256: intent.fromConfigurationSha256,
    toConfigurationSha256: intent.toConfigurationSha256, mutationCount: 1, getFirstReconciled: reconciled,
    runtimeVerified: true, sqlExecuted: false, rolesPrepared: false, loginChanged: false });
  const applyState = intent => { if (intent.kind === "api") runtime = intent.phase; else frontend = intent.phase; };
  const dependencies = {
    frontendSession: { verify: async () => {}, receipt: { candidateSha256: selected.candidateSha256 },
      probe: { receipt: { sourceCommit: selected.sourceCommit } } },
    hostScope: { verify() {}, sourceCommit: selected.sourceCommit, candidateSha256: selected.candidateSha256,
      bindingSha256: selected.bindingSha256 },
    observePhysical: async () => ({ status: "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED", sourceCommit: selected.sourceCommit,
      admission: { newWork: false, recovery: false, active: 0, uncertain: 0 } }), physicalDependencies: {},
    observeRuntime: async () => ({ configurationSha256: selected.configuration[runtime].sha256, nativeSchedulesEnabled: false,
      businessSchedulesEnabled: false, containers, courseCurrent: true, communityCurrent: true,
      boundaryChecks: ["private-application-credential-required", "private-community-peer-denied", "private-course-tls-catalog",
        "public-metrics-hidden", "public-tls-missing-workload-denied"] }),
    observeFrontendProvider: async () => ({ configurationSha256: selected.configuration[frontend].sha256, cronsEnabled: false,
      aliasJobActive: false, deploymentId: `dpl_${frontend.replaceAll("-", "")}` }),
    applyMutation: async intent => {
      calls.push(`apply:${intent.phase}:${intent.kind}`);
      if (failAt === calls.length && !failed) { failed = true; throw new Error("lost ack"); }
      applyState(intent); return result(intent, false);
    },
    reconcileMutation: async intent => { calls.push(`reconcile:${intent.phase}:${intent.kind}`); applyState(intent); return result(intent, true); },
    captureTokens: async () => profiles.map(profile => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", profile,
      tokenIssuedAt: "2027-01-15T07:05:30.000Z", tokenExpiresAt: "2027-01-15T07:10:30.000Z" })),
    observeProfiles: async (phase, captures) => captures.map(({ profile }) => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED",
      profile, phase, retainedTokenContinuityVerified: true, releaseAccepted: false,
      oldTokenIssuedAt: "2027-01-15T07:02:00.000Z", oldTokenExpiresAt: "2027-01-15T07:07:00.000Z",
      observedAt: phase === "overlap" ? "2027-01-15T07:02:10.000Z" : "2027-01-15T07:06:00.000Z" })),
    observeFrontendSigner: async phase => ({ status: "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED",
      configurationSha256: selected.configuration[phase].sha256, issuanceCutoffAt: "2027-01-15T07:00:00.000Z",
      receiptSha256: sha(`frontend-${phase}`) }),
    wait: async (deadline, verify) => { await verify(); clock = deadline; await verify(); },
    failClosed: async value => { failClosed.push(value); },
    restoreQualified: async phase => { restored.push(phase); runtime = phase; frontend = phase; },
  };
  return { dependencies, calls, restored, failClosed, nowMs: () => clock };
}

test("fixed controller orders API/frontend phases, verifies every split state and retains same-token evidence", async () => {
  const directory = `/private/tmp/p2-rotation-controller-${process.pid}-success`; mkdirSync(directory, { mode: 0o700 });
  try {
    const selected = plan(directory), owned = harness(selected);
    const outcome = await runIdentityKeyRotationController(selected, parent, owned.dependencies, { fixture: true, nowMs: owned.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.equal(outcome.liveEligible, false);
    assert.deepEqual(owned.calls, ["apply:overlap:api", "apply:overlap:frontend", "apply:current-only:frontend", "apply:current-only:api"]);
    assert.deepEqual(owned.restored, []);
    const retained = harness(selected, { initialRuntime: "current-only", initialFrontend: "current-only" });
    assert.equal((await runIdentityKeyRotationController(selected, parent, retained.dependencies,
      { fixture: true, nowMs: retained.nowMs })).status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.deepEqual(retained.calls, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("resume after overlap qualification reuses retained phase and reconciles only the current mutation", async () => {
  const directory = `/private/tmp/p2-rotation-controller-${process.pid}-phase-resume`; mkdirSync(directory, { mode: 0o700 });
  try {
    const selected = plan(directory), first = harness(selected, { failAt: 3 });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.deepEqual(first.calls, ["apply:overlap:api", "apply:overlap:frontend", "apply:current-only:frontend"]);
    const resumed = harness(selected, { initialRuntime: "overlap", initialFrontend: "overlap" });
    const outcome = await runIdentityKeyRotationController(selected, parent, resumed.dependencies,
      { fixture: true, nowMs: resumed.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.equal(resumed.calls[0], "reconcile:current-only:frontend");
    assert.equal(resumed.calls.some(value => value.includes("overlap")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("lost mutation acknowledgement remains closed and a later run reconciles GET-first without replay", async () => {
  const directory = `/private/tmp/p2-rotation-controller-${process.pid}-resume`; mkdirSync(directory, { mode: 0o700 });
  try {
    const selected = plan(directory), first = harness(selected, { failFirst: true });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.deepEqual(first.calls, ["apply:overlap:api"]);
    assert.deepEqual(first.restored, []);
    const resumed = harness(selected);
    const outcome = await runIdentityKeyRotationController(selected, parent, resumed.dependencies, { fixture: true, nowMs: resumed.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.equal(resumed.calls[0], "reconcile:overlap:api");
    assert.equal(resumed.calls.filter(value => value === "apply:overlap:api").length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("controller rejects caller-shaped authority and does not start a mutation", async () => {
  const directory = `/private/tmp/p2-rotation-controller-${process.pid}-authority`; mkdirSync(directory, { mode: 0o700 });
  try {
    const selected = plan(directory), owned = harness(selected);
    await assert.rejects(() => runIdentityKeyRotationController(selected, { ...parent, hostLockHeld: false }, owned.dependencies,
      { fixture: true, nowMs: owned.nowMs }), error => error.check === "source-parent-authority");
    assert.deepEqual(owned.calls, []);
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, owned.dependencies),
      error => error.check === "source-parent-dispatch-not-integrated");
    assert.deepEqual(owned.calls, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
