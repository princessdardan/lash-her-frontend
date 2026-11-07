// Protocol model only. Actual physical/frontend/host/provider parent is separate.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeDocuments, nativeModel } from "./harness/p2-native-unit-fixture.mjs";
import { prepareP2LifecycleTransportFaultPlan, runP2LifecycleTransportFault } from "./p2-lifecycle-transport-fault.mjs";
import { prepareP2LifecycleNativePlan } from "./p2-lifecycle-native.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile } from "./qualification-target-profile.mjs";
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");

function fixture(mode = "503-before-upstream", profile) {
  const documents = nativeDocuments(), model = nativeModel(documents);
  const fields = profile ? { version: 2, qualificationTargetProfile: profile } : { version: 1 };
  if (profile) {
    const bind = value => ({ ...value, qualificationTargetProfile: profile });
    const candidate = documents.candidate, source = documents.settings;
    model.plan = prepareP2LifecycleNativePlan({ ...bind(candidate), version: 3, workload: bind(candidate.workload),
      sources: { frontend: bind(candidate.sources.frontend) } }, { ...source, ...fields, target: bind(source.target) }, profile);
  }
  const selected = model.plan.commandWitnesses[0], calls = [], originalQuery = model.client.query;
  const marker = "c".repeat(64), backendStart = "2026-11-07 00:00:00+00", lockReads = [];
  model.state.newWork = false;
  Object.assign(model.state.deliveries.find(row => row.receiver === "community"), { status: "acknowledged", attempts: 1, acknowledged_at: new Date() });
  const command = { version: 1, commandId: selected.commandId, userId: randomUUID(), accountVersion: 1, action: "suspend", issuedAt: new Date().toISOString() };
  model.client.query = async (sql, values) => {
    if (sql.includes("backend_start::text")) return { rows: [{ backend_start: backendStart }] };
    if (sql.includes("AS held")) lockReads.push(values[0]);
    if (sql.includes("SELECT command_id::text,user_id::text")) return { rows: [{ command_id: command.commandId, user_id: command.userId, account_version: "1", action: "suspend", issued_at: new Date(command.issuedAt), command }] };
    if (sql.includes("WHERE status<>'acknowledged'")) return { rows: model.state.deliveries.filter(row => row.status !== "acknowledged").map(row => ({ ...row, lease_id: null, ready: true })) };
    return originalQuery.call(model.client, sql, values);
  };
  const settings = { ...fields, stageId: "owned-fault", mode, receiver: "course", commandIndex: 0, candidateSha256: "1".repeat(64), commandSha256: hash(command),
    configurationSha256: "2".repeat(64), gatewayConfigurationSha256: "3".repeat(64), gatewayImageSha256: "4".repeat(64), gatewayProcessSha256: "5".repeat(64),
    operatorSourceCommit: model.plan.sourceCommit, operatorSourceClosureSha256: "8".repeat(64) };
  const plan = prepareP2LifecycleTransportFaultPlan(model.plan, settings, profile), leaseSha = "6".repeat(64), zeros = { newWork: 0, recovery: 0 };
  const gatewayState = { newWork: false, recovery: true, active: { ...zeros }, uncertain: { ...zeros } };
  let armed = false;
  const hostStage = {
    async verify() { calls.push("host-verify"); },
    async observe() { return { ...fields, status: "P2_FAULT_HOST_CURRENT", candidateSha256: plan.candidateSha256, candidateObjectSha256: plan.candidateObjectSha256,
      configurationSha256: plan.configurationSha256, gatewayConfigurationSha256: plan.gatewayConfigurationSha256, gatewayImageSha256: plan.gatewayImageSha256,
      gatewayProcessSha256: plan.gatewayProcessSha256, targetSha256: plan.targetSha256, operatorSourceCommit: plan.operatorSourceCommit,
      operatorSourceClosureSha256: plan.operatorSourceClosureSha256,
      runtimeInventorySha256: "7".repeat(64), gatewayAdmission: { valid: true, ...structuredClone(gatewayState),
        ...(profile ? { releaseId: plan.actionId, candidateSha256: plan.candidateSha256 } : {}) }, faultLeasePresent: false }; },
    async arm(_plan, record) { calls.push("arm"); assert.equal(record.commandId, command.commandId); assert.equal(record.canonicalSha256, plan.commandSha256); armed = true;
      return { status: "P2_FAULT_LEASE_ARMED", leaseSha256: leaseSha,
        ...(profile ? { ...fields, stageId: plan.stageId, maxMatches: 1, gatewayProcessSha256: plan.gatewayProcessSha256 } : {}) }; },
    async disarm() { calls.push("disarm"); armed = false; return { faultDisabled: true, ...(profile ? { ...fields, leaseAbsent: true } : {}) }; },
    async closeGateway() { calls.push("gateway-close"); gatewayState.newWork = false; gatewayState.recovery = false;
      return { gatewayAdmissionClosed: true, active: gatewayState.active, uncertain: gatewayState.uncertain,
        ...(profile ? { ...fields, fileFencePersisted: true } : {}) }; },
    async effects() { assert.equal(armed, true); return [{ version: 1, status: "P2_TRANSPORT_FAULT_INJECTED", environment: "staging", profile: plan.profile, stageId: plan.stageId,
      candidateSha256: plan.candidateSha256, configurationSha256: plan.configurationSha256, gatewayProcessSha256: plan.gatewayProcessSha256,
      gatewayImageSha256: plan.gatewayImageSha256, sourceWitnessSha256: plan.commandSha256, leaseSha256: leaseSha, mode: plan.mode, receiver: plan.receiver,
      upstreamStarted: mode !== "503-before-upstream", downstreamDisposition: mode === "503-before-upstream" ? "503" : "dropped-before-any-response-bytes",
      upstreamReceiptVerified: mode !== "503-before-upstream", ...(mode === "drop-after-ack" ? { upstreamStatus: 200, downstreamBytesStarted: false } : {}) }]; },
  };
  const nativeControl = { async observeMetadata() { return { projectId: model.plan.projectId, deploymentId: model.plan.deploymentId, sourceCommit: model.plan.sourceCommit,
    deploymentUrl: model.plan.deploymentUrl, schedule: model.plan.schedule, nativeEnabled: model.state.enabled,
    ...(profile ? { ...fields, environment: 'staging', releaseId: model.plan.actionId, candidateSha256: model.plan.candidateSha256,
      phase2ContractManifestSha256: model.plan.phase2ContractManifestSha256 } : {}) }; },
    async observe() { return { ...await nativeControl.observeMetadata(), configurationRecordSha256: model.plan.configurationRecordSha256,
      featureControls: model.plan.featureControls, writerAdmissionBinding: model.plan.writerAdmissionBinding }; } };
  const input = { plan, client: model.client, directory: model.input.directory, confirmation: "staging/" + model.plan.actionId,
    verifyEnvironment: async () => { calls.push("environment"); }, verifySession: async () => {}, withOwner: model.input.withOwner, nativeControl, hostStage,
    async exercise() { calls.push("exercise"); model.state.deliveries.find(row => row.receiver === "course").attempts++; },
    async containFrontend() { calls.push("frontend-contain"); model.state.newWork = false; model.state.recovery = false; return { frontendAdmissionClosed: true }; } };
  if (profile) {
    const certification = { ...fields, planSha256: "9".repeat(64), nativePlan: model.plan };
    const identity = { releaseId: plan.actionId, sourceCommit: plan.sourceCommit };
    input.frontendProbe = { ...fields, marker, backendStart, backendPid: 123, plan: certification,
      job: { ...fields, ...identity, target: model.plan.target }, receipt: { ...fields, ...identity, status: 'P2_CERTIFICATION_DATABASE_CURRENT',
        planSha256: certification.planSha256, candidateSha256: plan.candidateSha256, targetSha256: plan.targetSha256, target: model.plan.target } };
  }
  return { model, plan, settings, input, calls, hostStage, gatewayState, marker, lockReads, cleanup: model.cleanup,
    run: () => runP2LifecycleTransportFault(input, profile) };
}

test("profiled transport checks both locks and preserves the original gateway effect wire in both fault modes", async () => {
  for (const mode of ['503-before-upstream', 'drop-after-ack']) {
    const value = fixture(mode, currentProfile);
    try {
      const result = await value.run();
      assert.equal(result.status, 'P2_LIFECYCLE_TRANSPORT_FAULT_OBSERVED_CONTAINED');
      assert.equal(result.version, 2);
      assert.deepEqual(result.qualificationTargetProfile, currentProfile);
      assert.equal(result.targetSha256, value.plan.targetSha256);
      assert.equal(result.nativePlanSha256, value.model.plan.planSha256);
      assert.equal(result.releaseAccepted, false);
      assert.equal(result.deployedCertificationComplete, false);
      assert.ok(value.lockReads.includes(value.marker));
      assert.ok(value.lockReads.includes('lash-her:private-db:migrations'));
      const retained = JSON.parse(readFileSync(join(value.input.directory, 'p2-fault-effect.json'))).effect;
      assert.equal(retained.version, 1);
      assert.equal(Object.hasOwn(retained, 'qualificationTargetProfile'), false);
    } finally { value.cleanup(); }
  }
});

test("profiled transport refuses mixed contexts and stale nonce or native profile before arming", async () => {
  for (const scenario of ['wrong-context', 'nonce-lost', 'legacy-host', 'legacy-native', 'native-drift-before-arm']) {
    const value = fixture('503-before-upstream', currentProfile);
    try {
      assert.throws(() => prepareP2LifecycleTransportFaultPlan(value.model.plan, value.settings));
      assert.throws(() => prepareP2LifecycleTransportFaultPlan(value.model.plan,
        { ...value.settings, operatorSourceCommit: 'a'.repeat(40) }, currentProfile));
      if (scenario === 'nonce-lost') {
        const query = value.input.client.query;
        value.input.client.query = (sql, args) => sql.includes('AS held') && args[0] === value.marker ? { rows: [{ held: false }] } : query(sql, args);
      }
      const stripProfile = value => {
        const row = { ...value, version: 1 };
        delete row.qualificationTargetProfile;
        return row;
      };
      if (scenario === 'legacy-host') {
        const observe = value.hostStage.observe;
        value.hostStage.observe = async () => stripProfile(await observe());
      }
      if (scenario === 'legacy-native') {
        const observe = value.input.nativeControl.observeMetadata;
        value.input.nativeControl.observeMetadata = async () => stripProfile(await observe());
      }
      if (scenario === 'native-drift-before-arm') {
        const verify = value.hostStage.verify;
        let count = 0;
        value.hostStage.verify = async () => {
          await verify();
          if (++count === 2) value.model.state.enabled = true;
        };
      }
      await assert.rejects(scenario === 'wrong-context' ? runP2LifecycleTransportFault(value.input) : value.run());
      assert.equal(value.calls.includes('arm'), false);
      assert.equal(value.calls.includes('exercise'), false);
      if (scenario !== 'wrong-context') assert.ok(value.calls.includes('gateway-close'));
    } finally { value.cleanup(); }
  }
});

test("source plan has no executable standalone path or caller command/body/URL options", () => {
  const value = fixture();
  try {
    assert.equal(value.plan.standaloneActivationEligible, false); assert.equal(value.plan.automaticReconciliationAllowed, false);
    assert.equal(JSON.stringify(value.plan).includes(value.model.plan.commandWitnesses[0].commandId), false);
    assert.throws(() => prepareP2LifecycleTransportFaultPlan(value.model.plan, { ...value.settings, url: "https://foreign.invalid" }));
  } finally { value.cleanup(); }
});

test("physical/owner/native gates precede activation, and cleanup runs after a failed lock check", async () => {
  const value = fixture();
  try {
    const query = value.input.client.query;
    value.input.client.query = async (sql, args) => sql.includes("AS held") ? { rows: [{ held: false }] } : query(sql, args);
    await assert.rejects(value.run());
    assert.equal(value.calls.includes("arm"), false); assert.equal(value.calls.includes("exercise"), false);
    assert.ok(value.calls.includes("gateway-close")); assert.ok(value.calls.includes("frontend-contain"));
  } finally { value.cleanup(); }
});

test("open new-work, prior uncertainty, native enabled, changed command or unrelated pending work cannot arm", async () => {
  for (const scenario of ["new-work", "uncertain", "native-on", "global-pending", "changed-command", "gateway-uncertain", "wrong-native-deployment"]) {
    const value = fixture();
    try {
      if (scenario === "new-work") value.model.state.newWork = true;
      if (scenario === "uncertain") value.model.state.operations.push({ id: randomUUID(), epoch: "1", state: "uncertain" });
      if (scenario === "native-on") value.model.state.enabled = true;
      if (scenario === "global-pending") Object.assign(value.model.state.deliveries.find(row => row.receiver === "community"), { status: "pending", acknowledged_at: null });
      if (scenario === "changed-command") {
        const query = value.input.client.query;
        value.input.client.query = async (sql, args) => {
          const result = await query(sql, args);
          if (sql.includes("SELECT command_id::text,user_id::text")) result.rows[0].command = { ...result.rows[0].command, userId: randomUUID() };
          return result;
        };
      }
      if (scenario === "gateway-uncertain") { const observe = value.hostStage.observe; value.hostStage.observe = async () => {
        const row = structuredClone(await observe()); row.gatewayAdmission.uncertain.recovery = 1; return row;
      }; }
      if (scenario === "wrong-native-deployment") { const observe = value.input.nativeControl.observeMetadata; value.input.nativeControl.observeMetadata = async plan => ({ ...await observe(plan), deploymentId: "dpl_foreign" }); }
      await assert.rejects(value.run()); assert.equal(value.calls.includes("arm"), false); assert.equal(value.calls.includes("exercise"), false);
      assert.ok(value.calls.includes("disarm")); assert.ok(value.calls.includes("gateway-close")); assert.ok(value.calls.includes("frontend-contain"));
    } finally { value.cleanup(); }
  }
});

test("observed source effect and real delivery attempt require awaited closure of all admissions", async () => {
  const value = fixture();
  try {
    const receipt = await value.run(); assert.equal(receipt.status, "P2_LIFECYCLE_TRANSPORT_FAULT_OBSERVED_CONTAINED");
    assert.equal(receipt.uncertaintySettled, true); assert.equal(receipt.automaticReconciliationPerformed, false); assert.equal(receipt.nativeInvocationQualified, false);
    const order = value.calls.filter(name => ["arm", "exercise", "disarm", "gateway-close", "frontend-contain"].includes(name));
    assert.deepEqual(order, ["arm", "exercise", "disarm", "gateway-close", "frontend-contain"]);
    const privateOutcome = JSON.parse(readFileSync(join(value.model.input.directory, "p2-fault-outcome.json"))); assert.equal(privateOutcome.status, receipt.status);
  } finally { value.cleanup(); }
});

test("outstanding uncertainty is retained and cannot be called contained or automatically reconciled", async () => {
  const value = fixture("drop-after-ack");
  try {
    const exercise = value.input.exercise;
    value.input.exercise = async () => { await exercise(); value.model.state.operations.push({ id: randomUUID(), epoch: "1", state: "uncertain" }); };
    const close = value.hostStage.closeGateway;
    value.hostStage.closeGateway = async () => { value.gatewayState.uncertain.recovery = 1; return close(); };
    await assert.rejects(value.run(), error => { assert.equal(error.publicReceipt.status, "P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW");
      assert.equal(error.publicReceipt.frontendAdmissionClosed, true); assert.equal(error.publicReceipt.outstandingUncertain, 1);
      assert.equal(error.publicReceipt.uncertaintySettled, false); assert.equal(error.publicReceipt.automaticReconciliationPerformed, false); return true; });
    assert.equal(value.model.state.operations[0].state, "uncertain");
  } finally { value.cleanup(); }
});

test("unknown arm, source effect mismatch and later receipt loss still attempt both closures", async () => {
  for (const scenario of ["arm-unknown", "effect-mismatch", "receipt-loss"]) {
    const value = fixture();
    try {
      if (scenario === "arm-unknown") value.hostStage.arm = async () => { value.calls.push("arm"); throw new Error("UNKNOWN"); };
      if (scenario === "effect-mismatch") { const effects = value.hostStage.effects; value.hostStage.effects = async () => (await effects()).map(row => ({ ...row, secret: "must refuse" })); }
      if (scenario === "receipt-loss") value.input.exercise = async () => { mkdirSync(join(value.model.input.directory, "p2-fault-effect.json")); value.model.state.deliveries.find(row => row.receiver === "course").attempts++; };
      await assert.rejects(value.run()); assert.ok(value.calls.includes("disarm")); assert.ok(value.calls.includes("gateway-close")); assert.ok(value.calls.includes("frontend-contain"));
    } finally { value.cleanup(); }
  }
});

test("component cannot unwind before an in-flight containment callback completes", async () => {
  const value = fixture(); let release, entered;
  const waiting = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; });
  try {
    const contain = value.input.containFrontend;
    value.input.containFrontend = async () => { entered(); await gate; return contain(); };
    let ended = false; const running = value.run().finally(() => { ended = true; });
    await waiting; await new Promise(done => setImmediate(done)); assert.equal(ended, false);
    release(); await running; assert.equal(ended, true);
  } finally { release?.(); value.cleanup(); }
});

test("a serialized plan or an already attempted source plan cannot replay activation", async () => {
  const value = fixture();
  try {
    await assert.rejects(runP2LifecycleTransportFault({ ...value.input, plan: JSON.parse(JSON.stringify(value.plan)) }));
    assert.equal(value.calls.includes("arm"), false);
    await value.run(); const count = value.calls.length;
    await assert.rejects(value.run()); assert.equal(value.calls.length, count);
  } finally { value.cleanup(); }
});

test("native re-enable during final FE ledger is reread and cannot retain native-off success", async () => {
  const value = fixture(); let counts = 0;
  try {
    const query = value.input.client.query;
    value.input.client.query = async (sql, args) => {
      const result = await query(sql, args);
      if (sql.includes("count(*) FILTER") && ++counts === 3) value.model.state.enabled = true;
      return result;
    };
    await assert.rejects(value.run(), error => { assert.equal(error.publicReceipt.status, "P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW");
      assert.equal(error.publicReceipt.nativeEnabled, true); return true; });
  } finally { value.cleanup(); }
});

test("gateway reopening after close is reread and cannot retain admission-closed success", async () => {
  const value = fixture();
  try {
    const contain = value.input.containFrontend;
    value.input.containFrontend = async (...args) => { const result = await contain(...args); value.gatewayState.recovery = true; return result; };
    await assert.rejects(value.run(), error => { assert.equal(error.publicReceipt.status, "P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW");
      assert.equal(error.publicReceipt.gatewayAdmissionClosed, null); assert.notEqual(error.publicReceipt.faultDisabled, true); return true; });
  } finally { value.cleanup(); }
});

test("supplemental operator identity stays distinct from the immutable app source", () => {
  const value = fixture();
  try {
    const plan = prepareP2LifecycleTransportFaultPlan(value.model.plan, { ...value.settings, operatorSourceCommit: "f".repeat(40) });
    assert.equal(plan.sourceCommit, value.model.plan.sourceCommit); assert.equal(plan.operatorSourceCommit, "f".repeat(40));
  } finally { value.cleanup(); }
});

test("actual configuration, controls and writer binding must match at preflight and final probe", async () => {
  for (const field of ["configurationRecordSha256", "featureControls", "writerAdmissionBinding"]) for (const finalOnly of [false, true]) {
    const value = fixture(); let observations = 0;
    try {
      const observe = value.input.nativeControl.observe;
      value.input.nativeControl.observe = async plan => {
        const row = { ...await observe(plan) }; observations++;
        if (!finalOnly || observations > 1) row[field] = field === "configurationRecordSha256" ? "f".repeat(64) : {};
        return row;
      };
      await assert.rejects(value.run(), error => { assert.equal(error.publicReceipt.status, "P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW");
        assert.equal(error.publicReceipt.frontendRuntimeBindingVerified, false); return true; });
      if (!finalOnly) assert.equal(value.calls.includes("arm"), false);
    } finally { value.cleanup(); }
  }
});
