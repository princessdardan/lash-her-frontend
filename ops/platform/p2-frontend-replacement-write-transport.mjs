import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-admission-bootstrap.mjs";
import { selectManagedNeonCatalog } from "./frontend-managed-neon-catalog.mjs";
import { verifyP2FrontendReplacementObservation } from "./p2-frontend-replacement-probe.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const mode = "p2-profiled-frontend-replacement-write";
const refusal = "P2_FRONTEND_REPLACEMENT_WRITE_TRANSPORT_REFUSED";
const unavailable = () => new Error(refusal);
const demand = condition => { if (!condition) throw unavailable(); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const fields = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const pick = (value, names) => Object.fromEntries(names.map(key => [key, value[key]]));
const compareName = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
const targetFields = ["host", "port", "database", "user", "runtimeRole", "serverMajor"];
const originalEvidenceNames = ["physicalObservation", "databaseReceipt", "continuationStarted", "writtenObservation",
  "abortObservation", "runtimeOutcome", "writeContainment", "runtimeContainment"];
const maximumPacket = 4_000_000;
const maximumReply = 4096;
const guardianReapTimeout = 20 * 60_000;
const evidence = {
  arm: "p2-frontend-replacement-guard-armed.json",
  boundary: "p2-frontend-replacement-empty-catalog.json",
  writeIntent: "p2-frontend-replacement-write-intent.json",
  written: "p2-frontend-replacement-written-observation.json",
  recoveryPhysical: "p2-frontend-replacement-recovery-physical-observation.json",
  runtimeIntent: "p2-frontend-replacement-runtime-intent.json",
  migration: "migration-outcome.json",
  runtime: "runtime-outcome.json",
  proof: "frontend-deployment-proof.json",
  workload: "frontend-workload-outcome.json",
  promotion: "frontend-promotion-outcome.json",
  closePrepared: "p2-frontend-replacement-close-prepared.json",
  closed: "frontend-session-closed.json",
  terminal: "frontend-job-outcome.json",
  continuationCompleted: "frontend-continuation-completed.json",
  releaseOutcome: "frontend-release-outcome.json",
  commitIntent: "p2-frontend-replacement-write-commit-intent.json",
  writeOutcome: "p2-frontend-replacement-write-outcome.json",
};

function originalBytes(value, maximum) {
  demand(Buffer.isBuffer(value) && value.length > 0 && value.length <= maximum && value.at(-1) === 10);
  return Buffer.from(value);
}

function base64Bytes(value, maximum, newline = true) {
  demand(typeof value === "string" && value.length <= 4 * Math.ceil(maximum / 3));
  const bytes = Buffer.from(value, "base64");
  demand(bytes.length > 0 && bytes.length <= maximum && (!newline || bytes.at(-1) === 10) && bytes.toString("base64") === value);
  return bytes;
}

function snapshotSelection(initial, plan, recoveryInput) {
  requireQualificationTargetProfile(profile, initial, plan);
  demand(initial.version === 1 && initial.mode === mode && initial.environment === "staging" &&
    !Object.hasOwn(initial, "id") && !Object.hasOwn(initial, "operation") &&
    plan.version === 1 && plan.environment === "staging" && plan.status === "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED" &&
    initial.sourceCommit === plan.sourceCommit && /^(?!0+$)[a-f0-9]{40}$/u.test(initial.sourceCommit) &&
    initial.candidateSha256 === plan.candidateSha256 &&
    [plan.candidateSha256, plan.targetSha256, initial.reviewedPlanSha256].every(digest));
  const planBytes = base64Bytes(initial.reviewedPlanBytes, 2_000_000, false);
  demand(hash(planBytes) === initial.reviewedPlanSha256 &&
    isDeepStrictEqual(decodeQualificationTargetJson(planBytes, "carrier"), plan));
  const hasReview = ["runtimeReviewBytes", "runtimeReviewSha256"].some(field => Object.hasOwn(initial, field));
  demand(!Object.hasOwn(initial, "vercelToken") || hasReview && typeof initial.vercelToken === "string" && /^[!-~]{1,8192}$/u.test(initial.vercelToken));
  const hasRecovery = ["operatorSourceCommit", "recoveryReviewBytes", "recoveryReviewSha256"].some(field => Object.hasOwn(initial, field));
  demand(hasRecovery === (recoveryInput !== undefined) && (!hasRecovery || hasReview));
  const confirmation = `staging/${plan.releaseId}/replacement-write/${initial.reviewedPlanSha256}`;
  demand(initial.confirmation === confirmation + (hasReview ? "/" + initial.runtimeReviewSha256 : "") +
    (hasRecovery ? "/recover/" + initial.recoveryReviewSha256 : ""));
  if (!hasReview) return {};
  const bytes = base64Bytes(initial.runtimeReviewBytes, 65_536, false);
  demand(digest(initial.runtimeReviewSha256) && hash(bytes) === initial.runtimeReviewSha256);
  const review = decodeQualificationTargetJson(bytes, "carrier");
  requireQualificationTargetProfile(profile, review);
  const bindings = ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "candidateSha256", "targetSha256"];
  demand(isDeepStrictEqual(pick(review, bindings), pick(plan, bindings)) &&
    review.reviewedPlanSha256 === initial.reviewedPlanSha256 && review.hostMachineId === initial.hostMachineId &&
    digest(review.producerSha256));
  if (!hasRecovery) return { review };
  const recoveryBytes = base64Bytes(initial.recoveryReviewBytes, 65_536, false);
  demand(typeof initial.operatorSourceCommit === "string" && /^(?!0+$)[a-f0-9]{40}$/u.test(initial.operatorSourceCommit) &&
    digest(initial.recoveryReviewSha256) && hash(recoveryBytes) === initial.recoveryReviewSha256);
  const recoveryReview = decodeQualificationTargetJson(recoveryBytes, "carrier");
  demand(fields(recoveryReview, ["actionId", "originalDirectory", "originalEvidenceSha256"]));
  const { actionId, originalDirectory, originalEvidenceSha256 } = recoveryReview;
  demand(typeof actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(actionId) && actionId !== plan.releaseId &&
    typeof originalDirectory === "string" && path.isAbsolute(originalDirectory) && path.normalize(originalDirectory) === originalDirectory &&
    path.basename(originalDirectory) === `p2-profiled-replacement-write-${plan.releaseId}` &&
    initial.results === path.join(path.dirname(originalDirectory), actionId) && initial.results !== originalDirectory &&
    fields(originalEvidenceSha256, originalEvidenceNames) && Object.values(originalEvidenceSha256).every(digest));
  return { review, recovery: prepareRecovery(recoveryInput, recoveryReview, plan, review) };
}

function receiptBinding(initial, plan, status) {
  return { ...pick(plan, ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "candidateSha256", "targetSha256"]),
    status, reviewedPlanSha256: initial.reviewedPlanSha256,
    bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false };
}

function validateProbe(probe, plan) {
  requireQualificationTargetProfile(profile, probe);
  demand(probe.version === 1 && probe.operation === "verify-pre-bootstrap-lock" &&
    probe.targetSha256 === plan.targetSha256 && probe.databaseOid === plan.replacement.databaseOid &&
    probe.migrationRoleOid === plan.replacement.migrationRoleOid &&
    isDeepStrictEqual(pick(probe.job.target, targetFields), plan.replacement.target) &&
    isDeepStrictEqual(probe.job.target.approvedPendingTags, plan.replacement.approvedPendingTags) &&
    probe.job.target.allowEmptyBootstrap === true && isDeepStrictEqual(probe.predecessorTarget, plan.predecessor.target) &&
    probe.job.releaseId === plan.releaseId && probe.job.sourceCommit === plan.sourceCommit &&
    digest(probe.marker) && Number.isInteger(probe.backendPid) && probe.backendPid > 0 &&
    typeof probe.backendStart === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(probe.backendStart));
}

function validateBoundary(boundary, plan, probe, managed) {
  const { observedAt, ...receipt } = boundary;
  const binding = {
    version: 1, status: "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED", target: plan.replacement.target,
    predecessorTarget: probe.predecessorTarget, databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid,
    administrativeLogins: [...plan.replacement.administrativeLogins].sort(compareName),
    readOnlyVerified: true, completeDatabaseEmptyProven: false, authorityIssued: false,
  };
  demand(typeof observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(observedAt));
  if (managed) {
    demand(Number.isFinite(Date.parse(observedAt)) && new Date(observedAt).toISOString() === observedAt &&
      isDeepStrictEqual(receipt, { ...binding, catalogScope: "postgresql-18-managed-neon-replacement-v1",
      managedCatalog: managed.reference, catalogCounts: managed.expectedCatalogCounts }));
  } else {
    const { zeroCatalogCounts, ...stock } = receipt;
    demand(isDeepStrictEqual(stock, { ...binding, catalogScope: "postgresql-16-18-stock-replacement-v1" }) &&
      zeroCatalogCounts && Object.values(zeroCatalogCounts).length > 0 && Object.values(zeroCatalogCounts).every(value => value === 0));
  }
}

function runtimeEvidenceBinding(receipt, plan, frontend) {
  requireQualificationTargetProfile(profile, receipt);
  demand(receipt.version === 2 && receipt.environment === "staging" && receipt.releaseId === plan.releaseId &&
    receipt.candidateSha256 === plan.candidateSha256 && receipt.contractPhase === "p2" &&
    receipt.phase2ContractManifestSha256 === plan.phase2ContractManifestSha256 && receipt.phase === "completed" &&
    receipt.frontendSqlApplied === true && receipt.frontendMigrationMode === "apply-forward" &&
    receipt.frontendSqlReplayed === false && receipt.frontendReadOnlyVerified === false &&
    receipt.frontendReplacementReadbackSha256 === frontend.postflightSha256 &&
    receipt.frontendContinuationStartedSha256 === frontend.continuationStartedSha256 &&
    ["trafficAuthorized", "historicalProviderClosureClaimed", "oldP200Qualified", "nativeSchedulesEnabled", "releaseAccepted"]
      .every(field => receipt[field] === false));
}

function releaseBinding(initial, plan, review, frontend, api) {
  return { ...pick(plan, ["qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "targetSha256", "candidateSha256"]),
    version: 2, configurationSha256: review.configurationSha256, postflightSha256: frontend.postflightSha256,
    reviewedPlanSha256: initial.reviewedPlanSha256, runtimeReviewSha256: initial.runtimeReviewSha256,
    ...api, contractPhase: "p2", phase2ContractManifestSha256: plan.phase2ContractManifestSha256,
    frontendSqlApplied: true, frontendSqlReplayed: false, historicalProviderClosureClaimed: false,
    oldP200Qualified: false, nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false };
}

function capture(input, names, maximum = 65_536) {
  demand(fields(input, names));
  const bytes = Object.fromEntries(names.map(name => [name, originalBytes(input[name], maximum)]));
  const records = Object.fromEntries(names.map(name => [name, decodeQualificationTargetJson(bytes[name], "carrier")]));
  const packet = Object.fromEntries(names.map(name => [name, bytes[name].toString("base64")]));
  return { bytes, records, packet };
}

function prepareWritten(input, probe, review) {
  demand(fields(input, ["databaseReceipt", "continuationStarted", "owner", "runtime", "producerSha256"]));
  const database = originalBytes(input.databaseReceipt, 65_536), started = originalBytes(input.continuationStarted, 8192);
  const startedRecord = decodeQualificationTargetJson(started, "carrier");
  demand(decodeQualificationTargetJson(database, "carrier")?.status === "DATABASE_VERIFIED" &&
    startedRecord?.status === "FRONTEND_CONTINUATION_STARTED" && startedRecord.databaseVerified === true);
  const { owner, runtime, producerSha256 } = structuredClone(pick(input, ["owner", "runtime", "producerSha256"]));
  demand(fields(owner, ["name", "oid"]) && fields(runtime, ["name", "oid"]) &&
    owner.name === FRONTEND_PREPARATION_ROLES.owner && runtime.name === probe.job.target.runtimeRole &&
    oid(owner.oid) && oid(runtime.oid) && new Set([owner.oid, runtime.oid, probe.migrationRoleOid]).size === 3 &&
    digest(producerSha256) && (!review || producerSha256 === review.producerSha256));
  return { database, started, startedRecord, databaseReceiptSha256: hash(database), continuationStartedSha256: hash(started),
    owner, runtime, producerSha256 };
}

function writtenBinding(plan, observation, physicalObservationSha256, written) {
  return {
    ...observation, status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED", operation: "verify-replacement-written",
    physicalObservationSha256, ...pick(written, ["databaseReceiptSha256", "continuationStartedSha256", "owner", "runtime", "producerSha256"]),
    administrativeLogins: [...plan.replacement.administrativeLogins].sort(compareName),
    appliedMigrationCount: plan.replacement.approvedPendingTags.length, epoch: "1", newWork: false, recovery: false,
    active: 0, uncertain: 0, schemaVerified: true, runtimeRoleVerified: true, effectiveLoginBoundaryVerified: true,
  };
}

function prepareRecovery(input, recoveryReview, plan, review) {
  demand(fields(input, ["originalProbe", "physicalObservation", "databaseReceipt", "continuationStarted", "writtenObservation"]));
  const probe = structuredClone(input.originalProbe);
  validateProbe(probe, plan);
  const physical = originalBytes(input.physicalObservation, 8192);
  const observation = verifyP2FrontendReplacementObservation(probe, physical);
  const bytes = originalBytes(input.writtenObservation, 8192), written = decodeQualificationTargetJson(bytes, "carrier");
  const original = prepareWritten({ ...pick(input, ["databaseReceipt", "continuationStarted"]),
    ...pick(written, ["owner", "runtime", "producerSha256"]) }, probe, review);
  const { originalEvidenceSha256: reviewed } = recoveryReview;
  const physicalSha256 = hash(physical);
  demand(reviewed.physicalObservation === physicalSha256 && reviewed.databaseReceipt === original.databaseReceiptSha256 &&
    reviewed.continuationStarted === original.continuationStartedSha256 && reviewed.writtenObservation === hash(bytes) &&
    isDeepStrictEqual(written, writtenBinding(plan, observation, physicalSha256, original)));
  return { probe, bytes, frontend: { ...pick(original, ["databaseReceiptSha256", "continuationStartedSha256"]),
    postflightSha256: hash(bytes), written, started: original.startedRecord } };
}

function validateFreshProbe(probe, original, plan) {
  const identity = ["marker", "backendPid", "backendStart"];
  validateProbe(probe, plan);
  const fixed = Object.keys(original).filter(key => !identity.includes(key));
  demand(fields(probe, [...fixed, ...identity]) && isDeepStrictEqual(pick(probe, fixed), pick(original, fixed)) &&
    identity.every(key => probe[key] !== original[key]));
}

// The caller supplies the already-selected process and reads evidence from the
// same private host action. No executable, remote command or shell is selected here.
export async function exchangeFrontendReplacementWrite(child, initialInput, planInput, task, { readHostEvidence, recovery: recoveryInput } = {}) {
  const controller = new AbortController(), pending = new Map();
  let failure, closed = false, closing = false, stdout = Buffer.alloc(0), stderrBytes = 0, heartbeat;
  let sequence = 0, phase = "starting", busy = false, heartbeatPending, result, committed, writeRequested = false;
  let rejectInterrupted;
  const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => {});
  const fail = () => {
    if (failure) return;
    failure = unavailable();
    controller.abort(failure);
    rejectInterrupted(failure);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure); }
    pending.clear();
  };
  const reaped = new Promise(resolve => child.once("close", (code, signal) => {
    closed = true;
    if (!closing || code !== 0 || signal || stdout.length || pending.size) fail();
    resolve({ code, signal });
  }));
  child.on("error", fail);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", fail);
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 64_000) fail(); });
  child.stdout.on("data", chunk => {
    try {
      let offset = 0;
      while (!failure && offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, newline < 0 ? undefined : newline);
        demand(stdout.length + part.length < maximumReply);
        stdout = Buffer.concat([stdout, part]);
        if (newline < 0) return;
        const reply = decodeQualificationTargetJson(stdout, "private-packet");
        stdout = Buffer.alloc(0);
        const waiter = pending.get(reply?.id);
        demand(waiter && reply.status === waiter.status && fields(reply, ["id", "status", ...waiter.fields]));
        clearTimeout(waiter.timer);
        pending.delete(reply.id);
        waiter.resolve(reply);
        offset = newline + 1;
      }
    } catch { fail(); }
  });
  child.stdout.on("end", () => { if (!closing || stdout.length || pending.size) fail(); });

  const send = (packet, status, expectedFields = [], timeout = 60_000) => {
    demand(!failure && !closing && !closed && pending.size < 64);
    const id = packet.id ?? 0, raw = Buffer.from(JSON.stringify(packet) + "\n");
    demand(raw.length <= maximumPacket && !pending.has(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(fail, timeout);
      pending.set(id, { status, fields: expectedFields, timer, resolve, reject });
      child.stdin.write(raw, error => { if (error) fail(); });
    });
  };
  const request = (operation, status, data, fields, timeout) =>
    send({ id: ++sequence, operation, ...data }, status, fields, timeout);
  const advance = async (expected, next, operation) => {
    try {
      demand(!failure && !busy && phase === expected);
      busy = true;
      const result = await operation();
      demand(!failure);
      phase = next;
      return result;
    } catch {
      fail();
      throw unavailable();
    } finally { busy = false; }
  };
  const verifyEnvironment = async () => {
    try { await request("check", "LOCKED", {}, [], 5_000); }
    catch { fail(); throw unavailable(); }
  };
  const read = async (name, expectedHash, limit = 65_536) => {
    const bytes = originalBytes(await readHostEvidence(name), limit);
    demand(!failure && (expectedHash === undefined || digest(expectedHash) && hash(bytes) === expectedHash));
    return { bytes, receipt: decodeQualificationTargetJson(bytes, "carrier") };
  };

  try {
    demand(typeof task === "function" && typeof readHostEvidence === "function");
    const initial = structuredClone(initialInput), plan = structuredClone(planInput);
    const { review, recovery } = snapshotSelection(initial, plan, recoveryInput);
    const managed = Object.hasOwn(plan.replacement, "managedCatalog") ? selectManagedNeonCatalog(plan.replacement.managedCatalog,
      pick(plan.replacement, ["provider", "target", "databaseOid", "migrationRoleOid", "administrativeLogins"])) : undefined;
    await send(initial, "LOCKED", [], recovery ? 90_000 : 5_000);
    phase = "locked";
    heartbeat = setInterval(() => {
      if (heartbeatPending || closing || failure) return;
      heartbeatPending = verifyEnvironment().catch(fail).finally(() => { heartbeatPending = undefined; });
    }, 1000);
    await verifyEnvironment();
    let armed, custody, frontend, api, provider, sessionClosed, joined;
    const startup = recovery ? {
      resumeReplacementWritten: input => advance("locked", "written", async () => {
        const probe = structuredClone(input);
        validateFreshProbe(probe, recovery.probe, plan);
        writeRequested = true;
        const reply = await request("resume-replacement-written", "REPLACEMENT_WRITTEN_RESUMED", { probe }, ["postflightSha256"]);
        demand(reply.postflightSha256 === recovery.frontend.postflightSha256);
        const physical = await read(evidence.recoveryPhysical, undefined, 8192);
        verifyP2FrontendReplacementObservation(probe, physical.bytes);
        const { bytes, receipt } = await read(evidence.written, reply.postflightSha256, 8192);
        demand(bytes.equals(recovery.bytes));
        frontend = recovery.frontend;
        return { receipt, bytes, postflightSha256: frontend.postflightSha256 };
      }),
    } : {
      armReplacement: input => advance("locked", "armed", async () => {
        const probe = structuredClone(input);
        validateProbe(probe, plan);
        const reply = await request("arm-replacement", "REPLACEMENT_ARMED", { probe }, ["receipt", "armReceiptSha256"]);
        const { receipt } = await read(evidence.arm, reply.armReceiptSha256);
        const { physicalObservation, physicalObservationSha256, ...binding } = receipt;
        demand(isDeepStrictEqual(receipt, reply.receipt) &&
          isDeepStrictEqual(binding, receiptBinding(initial, plan, "P2_FRONTEND_REPLACEMENT_ARMED")));
        const physical = base64Bytes(physicalObservation, 8192);
        demand(hash(physical) === physicalObservationSha256);
        const observation = verifyP2FrontendReplacementObservation(probe, physical);
        armed = { probe, observation, physicalObservation, physicalObservationSha256, armReceiptSha256: reply.armReceiptSha256 };
        return { physicalObservation, physicalObservationSha256, armReceiptSha256: armed.armReceiptSha256 };
      }),
      authorizeReplacementWrite: input => advance("armed", "custody", async () => {
        const emptyCatalogReceipt = structuredClone(input);
        validateBoundary(emptyCatalogReceipt, plan, armed.probe, managed);
        writeRequested = true;
        const reply = await request("authorize-replacement-write", "REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED",
          { armReceiptSha256: armed.armReceiptSha256, emptyCatalogReceipt }, ["receipt", "writeIntentSha256"]);
        const { receipt } = await read(evidence.writeIntent, reply.writeIntentSha256);
        const boundary = await read(evidence.boundary, receipt.emptyCatalogReceiptSha256);
        demand(digest(receipt.emptyCatalogReceiptSha256) && isDeepStrictEqual(boundary.receipt, emptyCatalogReceipt) &&
          isDeepStrictEqual(receipt, reply.receipt) && isDeepStrictEqual(receipt, {
            ...receiptBinding(initial, plan, "P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED"),
            armReceiptSha256: armed.armReceiptSha256, physicalObservationSha256: armed.physicalObservationSha256,
            emptyCatalogReceiptSha256: hash(boundary.bytes), automaticReplayAuthorized: false,
          }));
        custody = reply.writeIntentSha256;
        return { receipt, writeIntentSha256: custody };
      }),
      verifyReplacementWritten: input => advance("custody", "written", async () => {
        const selected = prepareWritten(input, armed.probe, review);
        const { database, started, startedRecord, databaseReceiptSha256, continuationStartedSha256, owner, runtime, producerSha256 } = selected;
        const reply = await request("verify-replacement-written", "REPLACEMENT_WRITTEN_VERIFIED", {
          writeIntentSha256: custody, databaseReceipt: database.toString("base64"), continuationStarted: started.toString("base64"),
          owner, runtime, producerSha256,
        }, ["postflightSha256"]);
        const { bytes, receipt } = await read(evidence.written, reply.postflightSha256, 8192);
        demand(isDeepStrictEqual(receipt, writtenBinding(plan, armed.observation, armed.physicalObservationSha256, selected)));
        frontend = { databaseReceiptSha256, continuationStartedSha256, postflightSha256: reply.postflightSha256,
          written: structuredClone(receipt), started: startedRecord };
        return { receipt, bytes, postflightSha256: frontend.postflightSha256 };
      }),
    };
    const host = {
      signal: controller.signal,
      verifyEnvironment,
      ...startup,
      startReplacementRuntime: () => advance("written", "runtime", async () => {
        demand(review);
        const reply = await request("start-replacement-runtime", "REPLACEMENT_API_RUNTIME_READY",
          { postflightSha256: frontend.postflightSha256 }, ["runtimeOutcomeSha256", "migrationOutcomeSha256"], 3_600_000);
        const intent = await read(evidence.runtimeIntent);
        demand(isDeepStrictEqual(intent.receipt, {
          ...pick(plan, ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "candidateSha256", "targetSha256"]),
          status: "P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED", reviewedPlanSha256: initial.reviewedPlanSha256,
          runtimeReviewSha256: initial.runtimeReviewSha256, postflightSha256: frontend.postflightSha256,
          apiJobSha256: review.apiJobSha256, configurationSha256: review.configurationSha256, trafficAuthorized: false,
        }));
        const migration = await read(evidence.migration, reply.migrationOutcomeSha256, 2_000_000);
        const runtime = await read(evidence.runtime, reply.runtimeOutcomeSha256, 2_000_000);
        runtimeEvidenceBinding(migration.receipt, plan, frontend);
        runtimeEvidenceBinding(runtime.receipt, plan, frontend);
        demand(migration.receipt.status === "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN" &&
          migration.receipt.databaseReceiptSha256?.frontend === frontend.databaseReceiptSha256 &&
          runtime.receipt.status === "API_RUNTIME_READY" && runtime.receipt.sourceCommit === plan.sourceCommit &&
          isDeepStrictEqual(runtime.receipt.configurationSha256, review.configurationSha256) &&
          runtime.receipt.migrationOutcomeSha256 === reply.migrationOutcomeSha256 && runtime.receipt.frontendPromotionAuthorized === false);
        api = pick(reply, ["migrationOutcomeSha256", "runtimeOutcomeSha256"]);
        return { ...api, migrationOutcome: migration.receipt, migrationOutcomeBytes: migration.bytes,
          runtimeOutcome: runtime.receipt, runtimeOutcomeBytes: runtime.bytes };
      }),
      verifyReplacementFrontend: input => advance("runtime", "frontend", async () => {
        demand(typeof initial.vercelToken === "string");
        const names = ["proof", "workload", "promotion"], submitted = capture(input, names);
        const { proof, workload, promotion } = submitted.records;
        const base = releaseBinding(initial, plan, review, frontend, api);
        const deploymentId = proof.deploymentId;
        demand(typeof deploymentId === "string" && /^dpl_[A-Za-z0-9]+$/u.test(deploymentId) &&
          isDeepStrictEqual(pick(proof, Object.keys(base)), base) && proof.status === "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED" &&
          workload.status === "FRONTEND_VERIFIED" && promotion.status === "FRONTEND_DOMAINS_PROMOTED" &&
          [workload, promotion].every(record => record.deploymentId === deploymentId && record.releaseId === plan.releaseId &&
            record.sourceCommit === plan.sourceCommit && record.environment === plan.environment && record.trafficAuthorized === false));
        const reply = await request("verify-replacement-frontend", "REPLACEMENT_FRONTEND_VERIFIED", submitted.packet, ["proofSha256"], 300_000);
        demand(hash(submitted.bytes.proof) === reply.proofSha256);
        for (const name of names) demand((await read(evidence[name])).bytes.equals(submitted.bytes[name]));
        provider = { deploymentId, frontendDeploymentProofSha256: reply.proofSha256,
          frontendWorkloadReceiptSha256: hash(submitted.bytes.workload), frontendPromotionReceiptSha256: hash(submitted.bytes.promotion) };
        return { receipt: proof, bytes: submitted.bytes.proof, proofSha256: reply.proofSha256 };
      }),
      prepareReplacementClose: () => advance("frontend", "close-prepared", async () => {
        await request("prepare-replacement-close", "REPLACEMENT_CLOSE_PREPARED", {}, [], 300_000);
        const { receipt } = await read(evidence.closePrepared);
        demand(isDeepStrictEqual(receipt, { ...receiptBinding(initial, plan, "P2_FRONTEND_REPLACEMENT_CLOSE_PREPARED"),
          providerProofSha256: provider.frontendDeploymentProofSha256 }));
      }),
      observeReplacementClosed: () => advance("close-prepared", "closed", async () => {
        const reply = await request("observe-replacement-closed", "REPLACEMENT_SESSION_CLOSED", {}, ["sessionClosedSha256"], 95_000);
        const { bytes, receipt } = await read(evidence.closed, reply.sessionClosedSha256, 8192);
        demand(isDeepStrictEqual(receipt, { ...frontend.written, status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED",
          operation: "verify-replacement-closed", writtenObservationSha256: frontend.postflightSha256,
          originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true }));
        sessionClosed = reply.sessionClosedSha256;
        return { receipt, bytes, sessionClosedSha256: sessionClosed };
      }),
      finishReplacement: input => advance("closed", "joined", async () => {
        const names = ["terminal", "continuationCompleted", "releaseOutcome"], submitted = capture(input, names);
        const { terminal, continuationCompleted, releaseOutcome } = submitted.records;
        const startBinding = { ...frontend.started };
        delete startBinding.status;
        delete startBinding.databaseVerified;
        const base = releaseBinding(initial, plan, review, frontend, api);
        demand(isDeepStrictEqual(terminal, { ...startBinding, status: "DATABASE_VERIFIED", phase: "completed", readOnlyVerified: false }) &&
          isDeepStrictEqual(continuationCompleted, { ...frontend.started, status: "FRONTEND_CONTINUATION_COMPLETED" }) &&
          isDeepStrictEqual(releaseOutcome, { ...base, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED",
            deploymentProofSha256: provider.frontendDeploymentProofSha256 }));
        const reply = await request("finish-replacement", "REPLACEMENT_JOINED", submitted.packet, ["commitIntentSha256"]);
        for (const name of names) demand((await read(evidence[name])).bytes.equals(submitted.bytes[name]));
        const { receipt, bytes } = await read(evidence.commitIntent, reply.commitIntentSha256);
        demand(isDeepStrictEqual(receipt, { ...base, status: "P2_FRONTEND_REPLACEMENT_WRITE_COMMIT_INTENT",
          frontendSessionClosed: true, migrationMode: "apply-forward", ...provider,
          ...pick(frontend.written, ["owner", "runtime", "producerSha256"]),
          frontendDatabaseReceiptSha256: frontend.databaseReceiptSha256, frontendContinuationStartedSha256: frontend.continuationStartedSha256,
          frontendTerminalSha256: hash(submitted.bytes.terminal), frontendContinuationCompletedSha256: hash(submitted.bytes.continuationCompleted),
          frontendReleaseOutcomeSha256: hash(submitted.bytes.releaseOutcome), frontendSessionClosedSha256: sessionClosed }));
        joined = { receipt: structuredClone(receipt), commitIntentSha256: reply.commitIntentSha256 };
        return { receipt, bytes, commitIntentSha256: joined.commitIntentSha256 };
      }),
    };
    result = await Promise.race([task(Object.freeze(host)), interrupted]);
    clearInterval(heartbeat);
    await heartbeatPending;
    demand(!failure && phase === "joined" && !busy && pending.size === 0);
    const reply = await request("commit", "COMMITTED", {}, ["commitIntentSha256"]);
    demand(reply.commitIntentSha256 === joined.commitIntentSha256);
    committed = joined;
  } catch { fail(); }
  finally {
    clearInterval(heartbeat);
    closing = true;
    child.stdin.end();
    if (writeRequested && !closed) {
      // Once custody may have transferred, only the guardian can resolve
      // release or containment. A transport timeout must leave it running.
      let deadline;
      await Promise.race([reaped, new Promise(resolve => {
        deadline = setTimeout(() => { fail(); resolve(); }, guardianReapTimeout);
      })]);
      clearTimeout(deadline);
    } else {
      const stop = closed ? undefined : setTimeout(() => child.kill("SIGTERM"), 60_000);
      const force = closed ? undefined : setTimeout(() => child.kill("SIGKILL"), 65_000);
      await reaped;
      clearTimeout(stop);
      clearTimeout(force);
    }
  }
  try {
    demand(!failure && committed);
    demand(isDeepStrictEqual((await read(evidence.commitIntent, committed.commitIntentSha256)).receipt, committed.receipt));
    const { receipt, bytes } = await read(evidence.writeOutcome);
    demand(isDeepStrictEqual(receipt, { ...committed.receipt, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION" }));
    return { result, receipt, bytes, commitIntentSha256: committed.commitIntentSha256 };
  } catch { fail(); throw unavailable(); }
}
