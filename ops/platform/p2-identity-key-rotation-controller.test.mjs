import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runIdentityKeyRotationController } from "./p2-identity-key-rotation-controller.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const profiles = ["community-admin", "community-member", "course-admin", "course-learner"];
const fixture = label => { const directory = mkdtempSync(join(realpathSync(tmpdir()), `p2-rotation-controller-${label}-`)); chmodSync(directory, 0o700); return directory; };

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

function harness(selected, { failFirst = false, failAt = failFirst ? 1 : null, initialRuntime = "baseline", initialFrontend = "baseline",
  initialClock = "2027-01-15T07:00:00.000Z", signerCutoff = "2027-01-15T07:00:00.000Z",
  currentBuildMs = 0, currentSignerMs = 0, currentApiMs = 0 } = {}) {
  let runtime = initialRuntime, frontend = initialFrontend, clock = Date.parse(initialClock), failed = false;
  const calls = [], timeline = [], restored = [], failClosed = [];
  const note = (operation, details = {}) => timeline.push({ operation, runtime, frontend, clock, ...details });
  const containers = ["community-api", "community-tls", "community-worker", "course-api", "course-export-cleanup", "course-media",
    "course-publisher", "course-snapshot", "course-tls", "gateway"].map((service, index) => ({ service,
    containerId: String(index + 1).repeat(64).slice(0, 64),
    image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${String(index + 1).repeat(64).slice(0, 64)}` }));
  const result = (intent, reconciled) => ({ version: 1, status: "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED", actionId: intent.actionId,
    phase: intent.phase, kind: intent.kind, fromConfigurationSha256: intent.fromConfigurationSha256,
    toConfigurationSha256: intent.toConfigurationSha256, mutationCount: 1, getFirstReconciled: reconciled,
    runtimeVerified: true, sqlExecuted: false, rolesPrepared: false, loginChanged: false });
  const applyState = intent => { if (intent.kind === "api") runtime = intent.phase; else frontend = intent.phase; };
  let guardCalls = 0;
  const dependencies = {
    frontendSession: { verify: async () => { guardCalls += 1; }, receipt: { candidateSha256: selected.candidateSha256 },
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
      note(calls.at(-1));
      if (failAt === calls.length && !failed) { failed = true; throw new Error("lost ack"); }
      if (intent.phase === "current-only") clock += intent.kind === "frontend" ? currentBuildMs : currentApiMs;
      applyState(intent); return result(intent, false);
    },
    reconcileMutation: async intent => { calls.push(`reconcile:${intent.phase}:${intent.kind}`); applyState(intent); return result(intent, true); },
    captureTokens: async () => {
      note("capture");
      const issued = Math.floor(clock / 1000) * 1000;
      return profiles.map(profile => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", profile,
        tokenIssuedAt: new Date(issued).toISOString(), tokenExpiresAt: new Date(issued + 300_000).toISOString(),
        privateFixtureMarker: "private-capture-payload" }));
    },
    observeProfiles: async (phase, captures) => {
      note(`observe:${phase}`, { captures });
      clock += 10_000;
      return captures.map(({ profile, tokenIssuedAt, tokenExpiresAt }) => ({ status: "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED",
        profile, phase, retainedTokenContinuityVerified: true, releaseAccepted: false,
        oldResult: phase === "overlap" ? "accepted" : "rejected", newResult: "accepted",
        oldTokenIssuedAt: tokenIssuedAt, oldTokenExpiresAt: tokenExpiresAt,
        observedAt: new Date(clock).toISOString() }));
    },
    observeFrontendSigner: async phase => {
      if (phase === "current-only") clock += currentSignerMs;
      note(`signer:${phase}`);
      return { status: "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED",
        configurationSha256: selected.configuration[phase].sha256,
        issuanceCutoffAt: phase === "overlap" ? signerCutoff : new Date(clock).toISOString(),
        receiptSha256: sha(`frontend-${phase}`) };
    },
    wait: async (deadline, verify) => { await verify(); clock = Math.max(clock, deadline); await verify(); },
    failClosed: async value => { failClosed.push(value); },
    restoreQualified: async phase => { restored.push(phase); runtime = phase; frontend = phase; },
  };
  return { dependencies, calls, timeline, restored, failClosed, nowMs: () => clock, guardCalls: () => guardCalls };
}

test("fixed controller orders API/frontend phases, verifies every split state and retains same-token evidence", async () => {
  const directory = fixture("success");
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
    assert.ok(retained.guardCalls() > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("captures once after a frontend build longer than token life and proves both API phases with that capture", async () => {
  const directory = fixture("slow-frontend");
  try {
    const selected = plan(directory), owned = harness(selected, { currentBuildMs: 420_000, currentSignerMs: 25_000 });
    const outcome = await runIdentityKeyRotationController(selected, parent, owned.dependencies, { fixture: true, nowMs: owned.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    const build = owned.timeline.find(row => row.operation === "apply:current-only:frontend");
    const afterBuild = owned.timeline.slice(owned.timeline.indexOf(build) + 1);
    assert.deepEqual(afterBuild.map(row => row.operation),
      ["signer:current-only", "capture", "observe:overlap", "apply:current-only:api", "observe:current-only"]);
    const [signer, capture, beforeRemoval, , afterRemoval] = afterBuild;
    assert.ok(capture.clock - build.clock > 300_000);
    assert.ok(capture.clock >= signer.clock);
    assert.deepEqual([capture.runtime, capture.frontend], ["overlap", "current-only"]);
    assert.deepEqual([beforeRemoval.runtime, afterRemoval.runtime], ["overlap", "current-only"]);
    assert.strictEqual(beforeRemoval.captures, afterRemoval.captures);
    assert.equal(beforeRemoval.captures.some(row => Object.hasOwn(row, "privateFixtureMarker")), false);
    assert.equal(readFileSync(join(directory, "overlap-qualified.json"), "utf8").includes("private-capture-payload"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a retained receiver acknowledgement loss is reconciled without capturing another pair", async () => {
  const directory = fixture("receiver-ack-loss");
  try {
    const selected = plan(directory), first = harness(selected, { failAt: 4 });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    const beforeRemoval = first.timeline.find(row => row.operation === "observe:overlap");
    const resumed = harness(selected, { initialRuntime: "current-only", initialFrontend: "current-only",
      initialClock: "2027-01-15T07:06:00.000Z" });
    const outcome = await runIdentityKeyRotationController(selected, parent, resumed.dependencies,
      { fixture: true, nowMs: resumed.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.deepEqual(resumed.calls, ["reconcile:current-only:api"]);
    assert.deepEqual(resumed.timeline.map(row => row.operation), ["observe:current-only"]);
    assert.deepEqual(resumed.timeline[0].captures, beforeRemoval.captures);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an incomplete retained capture stays fenced without retrying capture or removing receiver keys", async () => {
  const directory = fixture("capture-ack-loss");
  try {
    const selected = plan(directory), first = harness(selected);
    first.dependencies.captureTokens = async () => { throw new Error("lost capture acknowledgement"); };
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.equal(first.calls.includes("apply:current-only:api"), false);
    assert.deepEqual(first.restored, []);
    const resumed = harness(selected, { initialRuntime: "overlap", initialFrontend: "current-only",
      initialClock: "2027-01-15T07:06:00.000Z" });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, resumed.dependencies,
      { fixture: true, nowMs: resumed.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.deepEqual(resumed.calls, []);
    assert.deepEqual(resumed.timeline, []);
    assert.deepEqual(resumed.restored, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("receiver transition that exhausts the capture lifetime cannot qualify", async () => {
  const directory = fixture("expired-at-receiver");
  try {
    const selected = plan(directory), owned = harness(selected, { currentApiMs: 300_000 });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, owned.dependencies,
      { fixture: true, nowMs: owned.nowMs }), error => error.check === "rotation-failure-contained");
    assert.equal(owned.timeline.some(row => row.operation === "observe:current-only"), false);
    assert.deepEqual(owned.restored, ["overlap"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fractional signer cutoff waits through the next JWT second before capture", async () => {
  const directory = fixture("fractional-cutoff");
  try {
    const selected = plan(directory), owned = harness(selected, { signerCutoff: "2027-01-15T07:00:00.500Z" });
    const outcome = await runIdentityKeyRotationController(selected, parent, owned.dependencies,
      { fixture: true, nowMs: owned.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("successful lost API acknowledgement is reconciled before the split-state boundary is evaluated", async () => {
  const directory = fixture("post-effect");
  try {
    const selected = plan(directory), first = harness(selected, { failFirst: true });
    const apply = first.dependencies.applyMutation;
    first.dependencies.applyMutation = async intent => {
      try { return await apply(intent); } finally { first.dependencies.observeRuntime = async () => ({
        configurationSha256: selected.configuration.overlap.sha256, nativeSchedulesEnabled: false,
        businessSchedulesEnabled: false, containers: (await harness(selected).dependencies.observeRuntime()).containers,
        courseCurrent: true, communityCurrent: true,
        boundaryChecks: ["private-application-credential-required", "private-community-peer-denied", "private-course-tls-catalog",
          "public-metrics-hidden", "public-tls-missing-workload-denied"] }); }
    };
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    const resumed = harness(selected, { initialRuntime: "overlap", initialFrontend: "baseline" });
    const outcome = await runIdentityKeyRotationController(selected, parent, resumed.dependencies,
      { fixture: true, nowMs: resumed.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.equal(resumed.calls[0], "reconcile:overlap:api");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("resume after overlap drain reconciles the frontend before issuing the first capture", async () => {
  const directory = fixture("phase-resume");
  try {
    const selected = plan(directory), first = harness(selected, { failAt: 3 });
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, first.dependencies,
      { fixture: true, nowMs: first.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.deepEqual(first.calls, ["apply:overlap:api", "apply:overlap:frontend", "apply:current-only:frontend"]);
    assert.equal(first.timeline.some(row => row.operation === "capture"), false);
    const resumed = harness(selected, { initialRuntime: "overlap", initialFrontend: "overlap",
      initialClock: "2027-01-15T07:12:00.000Z" });
    const outcome = await runIdentityKeyRotationController(selected, parent, resumed.dependencies,
      { fixture: true, nowMs: resumed.nowMs });
    assert.equal(outcome.status, "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED");
    assert.equal(resumed.calls[0], "reconcile:current-only:frontend");
    assert.equal(resumed.calls.some(value => value.includes("overlap")), false);
    const capture = resumed.timeline.find(row => row.operation === "capture");
    assert.deepEqual([capture.runtime, capture.frontend], ["overlap", "current-only"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("lost mutation acknowledgement remains closed and a later run reconciles GET-first without replay", async () => {
  const directory = fixture("resume");
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
  const directory = fixture("authority");
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

test("controller refuses observation timestamps not joined to the retained capture and actual phase window", async () => {
  for (const variant of ["capture", "window"]) {
    const directory = fixture(`time-${variant}`);
    try {
      const selected = plan(directory), owned = harness(selected);
      const original = owned.dependencies.observeProfiles;
      owned.dependencies.observeProfiles = async (phase, captures) => {
        const receipts = await original(phase, captures);
        if (phase === "overlap") receipts[0] = { ...receipts[0],
          ...(variant === "capture" ? { oldTokenIssuedAt: "2027-01-15T07:02:00.000Z",
            oldTokenExpiresAt: "2027-01-15T07:07:00.000Z" } : { observedAt: "2027-01-15T07:02:10.000Z" }) };
        return receipts;
      };
      await assert.rejects(() => runIdentityKeyRotationController(selected, parent, owned.dependencies,
        { fixture: true, nowMs: owned.nowMs }), error => error.check === "rotation-failure-contained");
      assert.deepEqual(owned.calls, ["apply:overlap:api", "apply:overlap:frontend", "apply:current-only:frontend"]);
      assert.deepEqual(owned.restored, ["baseline"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("controller performs a final boundary read and refuses drift after the last profile observation", async () => {
  const directory = fixture("final-boundary");
  try {
    const selected = plan(directory), owned = harness(selected);
    const observeProfiles = owned.dependencies.observeProfiles;
    owned.dependencies.observeProfiles = async (phase, captures) => {
      const rows = await observeProfiles(phase, captures);
      if (phase === "current-only") {
        const observeRuntime = owned.dependencies.observeRuntime;
        owned.dependencies.observeRuntime = async () => ({ ...await observeRuntime(),
          configurationSha256: selected.configuration.overlap.sha256 });
      }
      return rows;
    };
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, owned.dependencies,
      { fixture: true, nowMs: owned.nowMs }), error => error.check === "rotation-failure-uncertain");
    assert.equal(owned.failClosed.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retained controller result is historical until current guards pass again", async () => {
  const directory = fixture("retained-read");
  try {
    const selected = plan(directory), first = harness(selected);
    await runIdentityKeyRotationController(selected, parent, first.dependencies, { fixture: true, nowMs: first.nowMs });
    const retained = harness(selected, { initialRuntime: "current-only", initialFrontend: "current-only",
      initialClock: "2027-01-15T07:06:00.000Z" });
    retained.dependencies.hostScope.verify = () => { throw new Error("lost host lock"); };
    await assert.rejects(() => runIdentityKeyRotationController(selected, parent, retained.dependencies,
      { fixture: true, nowMs: retained.nowMs }), error => error.check === "retained-result-current-state-unverified");
    assert.equal(retained.failClosed.length, 1);
    assert.deepEqual(retained.calls, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
