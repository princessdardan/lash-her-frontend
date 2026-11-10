import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frontendCoordinationHash } from "./frontend-release-inventory.mjs";
import { readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { bindP2CertificationReadyReceipts, P2_CERTIFICATION_READY_FILES } from "./p2-certification.mjs";
import { observeP2ProfiledReplacementFrontendPhysical, withP2CertificationFrontendSession } from "./p2-certification-current-probe.mjs";
import { prepareP2CertificationReplacementRelease, validP2CertificationReplacementDescriptor } from "./p2-certification-replacement-release.mjs";
import { P2_LIFECYCLE_NATIVE_SCHEDULE, p2NativeHash } from "./p2-lifecycle-native.mjs";
import { prepareP2ReplacementSuccessor } from "./p2-replacement-successor.mjs";
import { validateP2HostSettings } from "./p2-release.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = "P2_IDENTITY_ROTATION_REPLACEMENT_CUSTODY_REFUSED";
const liveRefusal = "P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED";
export const P2_IDENTITY_ROTATION_REPLACEMENT_LEASE = Object.freeze({ liveEligible: false });
const demand = condition => { if (!condition) throw new Error(refusal); };
const contexts = new WeakMap();
const profileFields = { version: 2, qualificationTargetProfile: profile, environment: "staging" };
const action = value => typeof value === "string" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(value);
const commit = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{40}$/u.test(value);
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const actionPhases = Object.freeze(["overlap", "current-only", "post-removal"]);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key]]));
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const admission = (epochValue, open = false) => ({ epoch: epochValue, newWork: open, recovery: open, active: 0, uncertain: 0 });

function reviewedWindows(custody) {
  const phases = Object.hasOwn(custody, "authenticationWindows") ? custody.authenticationWindows : [];
  demand(isDeepStrictEqual(phases, []) || isDeepStrictEqual(phases, actionPhases));
  const initial = BigInt(custody.initialEpoch);
  const windows = phases.map((phase, index) => {
    const before = initial + 2n * BigInt(index);
    return { phase, beforeEpoch: String(before), openEpoch: String(before + 1n), closedEpoch: String(before + 2n) };
  });
  const finalEpoch = String(initial + 2n * BigInt(windows.length));
  demand(epoch(finalEpoch));
  return { windows, finalEpoch };
}

function buildFrontendPlan(loaded, custody, terminal, readyReceipts, successor) {
  const { original: { plan: release, inventory, migration: { candidate, job } }, profiledRelease } = loaded;
  const readyReceiptSha256 = Object.fromEntries(Object.entries(readyReceipts).map(([name, raw]) => [name, p2NativeHash(raw)]));
  const staged = decodeQualificationTargetJson(readyReceipts["frontend-build-outcome.json"], "carrier");
  const candidateObjectSha256 = p2NativeHash(candidate);
  // This is the existing closed physical observer carrier. Rotation never
  // invokes the lifecycle native action or provides a lifecycle command.
  const native = { ...profileFields, actionId: release.releaseId, sourceCommit: release.sourceCommit,
    projectId: candidate.workload.projectId, candidateSha256: candidateObjectSha256,
    phase2ContractManifestSha256: release.phase2ContractManifestSha256,
    sourcePolicy: { purpose: "identity-rotation-physical-custody-only" },
    deploymentId: terminal.deploymentId, deploymentUrl: staged.url, configurationRecordSha256: terminal.frontendWorkloadReceiptSha256,
    featureControls: release.certification.featureControls, targetSha256: release.targetSha256,
    target: { ...pick(job.target, ["host", "port", "database", "user", "serverMajor"]), qualificationTargetProfile: profile },
    owner: inventory.owner, producer: inventory.producers[0], initialEpoch: custody.initialEpoch,
    schedule: P2_LIFECYCLE_NATIVE_SCHEDULE, windowSeconds: 60, drainSeconds: 1, commandWitnesses: [],
    writerAdmissionBinding: release.writerAdmissionBinding, finalDisposition: "disabled-and-admission-closed",
    providerQueuedInventory: null, automaticReplayAllowed: false, migrationAuthorized: false, wholeReleaseAccepted: false };
  const frontendPlan = { ...profileFields, certificationActionId: custody.actionId, originalReleaseId: release.releaseId,
    sourceCommit: release.sourceCommit, operatorSourceCommit: release.sourceCommit,
    candidateSha256: release.candidateSha256, candidateObjectSha256, inventorySha256: release.inventorySha256,
    configurationSha256: frontendCoordinationHash(release.configurationSha256), configurationCanonicalSha256: p2NativeHash(release.configurationSha256),
    targetSha256: release.targetSha256, mode: "contain-native", startState: "already-closed", initialEpoch: custody.initialEpoch,
    browserPlanSha256: null, workerPlan: null, workerPlanSha256: null,
    runtimeInventorySha256: custody.runtimeInventorySha256, gatewayProcessSha256: custody.gatewayProcessSha256,
    gatewayConfigurationSha256: release.configurationSha256["gateway.json"], operatorSourceClosureSha256: custody.operatorSourceClosureSha256,
    contractPhase: "p2", phase2ContractManifestSha256: release.phase2ContractManifestSha256,
    nativePlan: { ...native, planSha256: p2NativeHash(native) }, persistenceReaderEligible: true,
    requestEvidenceDescriptorSha256: null, faultSelection: null, readyReceiptSha256, maximumSeconds: 900,
    finalDisposition: "native-disabled-and-both-admissions-closed", frontendSqlReplay: false, apiSqlReplay: false,
    rolePreparationAllowed: false, historicalLoginRestorationAllowed: false, buildAllowed: false,
    promotionAllowed: false, wholeReleaseAccepted: false, apiJobSha256: profiledRelease.apiJobSha256,
    originalReleaseReceiptSha256: profiledRelease.receiptSha256, originalReleasePlanSha256: profiledRelease.planSha256,
    replacementRelease: profiledRelease.replacementRelease, ...(successor ? { successorRuntime: successor.binding } : {}) };
  return { ...frontendPlan, planSha256: p2NativeHash(frontendPlan) };
}

/** Load immutable original/successor evidence without reading provider credentials or opening a connection. */
export function prepareP2IdentityRotationReplacementLease(settings, options = {}) {
  const hasSuccessor = Object.hasOwn(settings ?? {}, "successorRuntime");
  demand(exact(settings, ["version", "qualificationTargetProfile", "environment", "operatorSourceCommit",
    "releaseSettings", "replacementRelease", "custody", ...(hasSuccessor ? ["successorRuntime"] : [])]) &&
    settings.version === 2 && settings.environment === "staging" && commit(settings.operatorSourceCommit));
  requireQualificationTargetProfile(profile, settings);
  const { custody } = settings;
  demand(exact(custody, ["actionId", "initialEpoch", "runtimeInventorySha256", "gatewayProcessSha256", "operatorSourceClosureSha256",
    ...(Object.hasOwn(custody ?? {}, "authenticationWindows") ? ["authenticationWindows"] : [])]) &&
    action(custody.actionId) && epoch(custody.initialEpoch) &&
    [custody.runtimeInventorySha256, custody.gatewayProcessSha256, custody.operatorSourceClosureSha256].every(digest));
  const { windows, finalEpoch } = reviewedWindows(custody);
  const fixture = options.fixture === true;
  demand(exact(options, fixture ? ["fixture", "readReplacement"] : []) && (!fixture || typeof options.readReplacement === "function"));
  const loaded = (fixture ? options.readReplacement : prepareP2CertificationReplacementRelease)(settings.releaseSettings, settings.replacementRelease);
  const { original, profiledRelease, frontendReceipts, originalReleaseReceipt, candidateBytes } = loaded;
  const host = validateP2HostSettings(loaded.host);
  const { plan: release, inventory, migration } = original;
  const { candidate, job } = migration;
  requireQualificationTargetProfile(profile, release, inventory, candidate, job, job.target);
  const { replacementRelease } = profiledRelease;
  demand(settings.operatorSourceCommit === release.sourceCommit && custody.actionId !== release.releaseId &&
    candidate.version === 3 && job.version === 2 && candidate.releaseId === release.releaseId && job.releaseId === release.releaseId &&
    candidate.sources?.frontend?.commit === release.sourceCommit && job.sourceCommit === release.sourceCommit &&
    host.configuration === profiledRelease.configurationDirectory &&
    host.configuration === join(host.results, `runtime-profiled-frontend-replacement-${release.releaseId}`, "configuration") &&
    validP2CertificationReplacementDescriptor(replacementRelease) && isDeepStrictEqual(inventory.replacementRelease, replacementRelease) &&
    replacementRelease.reviewedPlanSha256 === profiledRelease.planSha256 && Buffer.isBuffer(originalReleaseReceipt) &&
    p2NativeHash(originalReleaseReceipt) === profiledRelease.receiptSha256 && p2NativeHash(candidateBytes) === release.candidateSha256 &&
    isDeepStrictEqual(decodeQualificationTargetJson(candidateBytes, "carrier"), candidate));
  const terminal = decodeQualificationTargetJson(originalReleaseReceipt, "carrier");
  requireQualificationTargetProfile(profile, terminal);
  demand(terminal.status === "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION" && terminal.releaseId === release.releaseId &&
    terminal.sourceCommit === release.sourceCommit && terminal.candidateSha256 === release.candidateSha256 &&
    terminal.targetSha256 === release.targetSha256 && terminal.reviewedPlanSha256 === profiledRelease.planSha256 &&
    inventory.producers.length === 1 && isDeepStrictEqual(inventory.owner, terminal.owner) &&
    isDeepStrictEqual(inventory.producers[0], { producerSha256: terminal.producerSha256, role: terminal.runtime }) &&
    digest(release.configurationSha256["gateway.json"]));
  const results = settings.releaseSettings.arm.results;
  const successorInput = { ...profileFields, startState: "already-closed", certificationActionId: custody.actionId,
    operatorSourceCommit: release.sourceCommit, candidateSha256: release.candidateSha256, initialEpoch: custody.initialEpoch,
    configurationSha256: frontendCoordinationHash(release.configurationSha256), gatewayConfigurationSha256: release.configurationSha256["gateway.json"],
    runtimeInventorySha256: custody.runtimeInventorySha256, gatewayProcessSha256: custody.gatewayProcessSha256,
    native: { qualificationTargetProfile: profile, targetSha256: release.targetSha256, target: job.target } };
  const successor = hasSuccessor ? prepareP2ReplacementSuccessor(settings.successorRuntime,
    { original, profiledRelease, host, results, input: successorInput }) : null;
  const activeHost = { ...host, configuration: successor?.configuration ?? host.configuration };
  const readyReceipts = Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name => [name, readFrontendReleaseEvidence(frontendReceipts, name)]));
  demand(p2NativeHash(readyReceipts["frontend-workload-outcome.json"]) === terminal.frontendWorkloadReceiptSha256 &&
    p2NativeHash(readyReceipts["frontend-promotion-outcome.json"]) === terminal.frontendPromotionReceiptSha256);
  const frontendPlan = buildFrontendPlan(loaded, custody, terminal, readyReceipts, successor);
  bindP2CertificationReadyReceipts(frontendReceipts, { ...frontendPlan, candidate });
  const base = { ...profileFields, status: "P2_IDENTITY_ROTATION_REPLACEMENT_LEASE_PREPARED", actionId: custody.actionId,
    sourceCommit: release.sourceCommit, hostMachineId: host.machineId, candidateSha256: release.candidateSha256,
    targetSha256: release.targetSha256, activeConfigurationDirectory: activeHost.configuration,
    initialEpoch: custody.initialEpoch, finalEpoch, authenticationWindows: windows, frontendPlan,
    liveEligible: false, trafficAuthorized: false, keyRemovalVerified: false };
  const lease = freeze(structuredClone({ plan: { ...base, planSha256: p2NativeHash(base) }, host: activeHost }));
  const readReceipt = value => Buffer.from(value).toString("base64");
  const retained = { originalReleaseReceipt: readReceipt(originalReleaseReceipt),
    readyReceipts: Object.fromEntries(Object.entries(readyReceipts).map(([name, raw]) => [name, readReceipt(raw)])) };
  if (successor) {
    const { receiptFile, receiptSha256 } = settings.successorRuntime;
    const raw = readFrontendReleaseEvidence(dirname(receiptFile), basename(receiptFile));
    demand(raw.length <= 65_536 && p2NativeHash(raw) === receiptSha256);
    retained.successorReceipt = readReceipt(raw);
  }
  const localTransport = pick(settings.releaseSettings.arm, ["results", "knownHosts", "sshKey"]);
  contexts.set(lease, { original: freeze(structuredClone(original)), retained: freeze(retained), localTransport: freeze(localTransport) });
  return lease;
}

export function readP2IdentityRotationReplacementCustody(lease) {
  const context = contexts.get(lease);
  demand(context);
  return freeze(structuredClone(context.retained));
}

export function readP2IdentityRotationReplacementTransportSettings(lease) {
  const context = contexts.get(lease);
  demand(context && Object.values(context.localTransport).every(value => typeof value === "string" && value.startsWith("/")));
  return context.localTransport;
}

/** Form only the existing exact nested host-review DTO. The outer host guard must independently verify it. */
export function readP2IdentityRotationReplacementHostReview(lease, sourceFiles) {
  const context = contexts.get(lease);
  demand(context && Array.isArray(sourceFiles) && sourceFiles.length > 0 && sourceFiles.length <= 544);
  const paths = new Set();
  let decodedBytes = 0;
  for (const entry of sourceFiles) {
    demand(exact(entry, ["path", "sha256", "data"]) && typeof entry.path === "string" &&
      /^ops\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:py|mjs|json|yaml|yml|service|timer|sh|guard)$/u.test(entry.path) &&
      !entry.path.split("/").some(part => part === "." || part === "..") && !paths.has(entry.path) && digest(entry.sha256) &&
      typeof entry.data === "string" && entry.data.length <= 2_700_000);
    const raw = Buffer.from(entry.data, "base64");
    decodedBytes += raw.length;
    demand(raw.length <= 2_000_000 && decodedBytes <= 48_000_000 && raw.toString("base64") === entry.data && p2NativeHash(raw) === entry.sha256);
    paths.add(entry.path);
  }
  const entries = sourceFiles.map(({ path, sha256 }) => [path, sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const sourceClosureSha256 = p2NativeHash(JSON.stringify(entries));
  const { plan: { frontendPlan }, host } = lease;
  demand(sourceClosureSha256 === frontendPlan.operatorSourceClosureSha256 &&
    paths.has("ops/platform/p2-certification-current-probe.mjs") && paths.has("ops/platform/p2-identity-key-rotation-replacement.mjs"));
  const { original: { migration: { candidate, job, baseline }, inventory, plan: release }, retained } = context;
  return freeze(structuredClone({ ...profileFields, mode: "p2-bounded-certification-profiled-current",
    sourceCommit: frontendPlan.operatorSourceCommit, sourceSha256: Object.fromEntries(entries), sourceClosureSha256,
    hostMachineId: host.machineId, bundle: host.bundle, configuration: host.configuration, results: host.results,
    candidate, candidateSha256: release.candidateSha256, configurationSha256: release.configurationSha256, apiJobSha256: release.apiJobSha256,
    frontendJob: job, frontendBaseline: baseline, targetSha256: release.targetSha256, owner: inventory.owner, inventory,
    inventorySha256: release.inventorySha256, certification: release.certification, expectedWriterAdmissionBinding: release.writerAdmissionBinding,
    certificationActionId: frontendPlan.certificationActionId, certificationPlan: frontendPlan,
    ...pick(retained, ["originalReleaseReceipt", "readyReceipts"]) }));
}

function requirePhysicalProof(proof, probe, expectedEpoch, closing) {
  const status = closing ? "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED" : "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED";
  const fields = ["version", "qualificationTargetProfile", "status", "marker", "backendPid", "backendStart",
    "sourceCommit", "admission", "journalSha256", "witnessSha256", "environment", "releaseId", "targetSha256",
    "replacementRelease", "effectiveLoginBoundaryVerified", "predecessorRuntimeRoleAbsent"];
  demand(exact(proof, [...fields, ...(closing ? ["backendAbsent", "migrationLockReleased", "nonceLockReleased"] : [])]) &&
    proof.version === 2 && proof.status === status &&
    ["marker", "backendPid", "backendStart"].every(key => proof[key] === probe[key]) &&
    ["sourceCommit", "environment", "releaseId", "targetSha256", "journalSha256"].every(key => proof[key] === probe.receipt[key]) &&
    proof.effectiveLoginBoundaryVerified === true && proof.predecessorRuntimeRoleAbsent === true &&
    isDeepStrictEqual(proof.replacementRelease, probe.replacementRelease) &&
    isDeepStrictEqual(proof.admission, admission(expectedEpoch)) && digest(proof.witnessSha256) &&
    (!closing || ["backendAbsent", "migrationLockReleased", "nonceLockReleased"].every(key => proof[key] === true)));
  requireQualificationTargetProfile(profile, proof);
  return freeze(structuredClone(proof));
}

function requireInitialProbe(probe, receipt, frontendPlan, prepared) {
  const { migration: { job, baseline }, plan: { owner, producers, replacementRelease } } = prepared;
  demand(exact(probe, ["version", "qualificationTargetProfile", "marker", "backendPid", "backendStart",
    "job", "baseline", "owner", "producers", "replacementRelease", "plan", "receipt"]) &&
    probe.version === 2 && probe.plan === frontendPlan && probe.receipt === receipt &&
    digest(probe.marker) && Number.isSafeInteger(probe.backendPid) && probe.backendPid > 0 && probe.backendPid <= 2147483647 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(probe.backendStart) &&
    isDeepStrictEqual(probe.job, job) && isDeepStrictEqual(probe.baseline, baseline) &&
    isDeepStrictEqual(probe.owner, owner) && isDeepStrictEqual(probe.producers, producers) &&
    isDeepStrictEqual(probe.replacementRelease, replacementRelease) &&
    receipt.status === "P2_CERTIFICATION_DATABASE_CURRENT" && receipt.version === 2 &&
    receipt.releaseId === frontendPlan.originalReleaseId && receipt.certificationActionId === frontendPlan.certificationActionId &&
    ["environment", "sourceCommit", "candidateSha256", "targetSha256", "planSha256"].every(key => receipt[key] === frontendPlan[key]) &&
    receipt.schemaVerified === true && receipt.runtimeRoleVerified === true && receipt.sqlReplayed === false &&
    receipt.trafficAuthorized === false && receipt.effectiveLoginBoundaryVerified === true && receipt.predecessorRuntimeRoleAbsent === true &&
    isDeepStrictEqual(receipt.replacementRelease, replacementRelease) &&
    isDeepStrictEqual(receipt.admission, admission(frontendPlan.initialEpoch)) &&
    [receipt.journalSha256, receipt.witnessSha256].every(digest));
  requireQualificationTargetProfile(profile, probe, receipt, receipt.target);
  return freeze(structuredClone(probe));
}

async function withPhysicalOwner(client, owner, verify, operation) {
  await verify();
  const { rows } = await client.query(`SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=$1 AND NOT rolcanlogin
    AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolsuper AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls`, [owner.name]);
  demand(isDeepStrictEqual(rows, [{ oid: owner.oid }]) && /^[a-z][a-z0-9_]{0,62}$/u.test(owner.name));
  await client.query(`SET ROLE "${owner.name}"`);
  try { return await operation(client); }
  finally { await client.query("RESET ROLE"); await verify(); }
}

/**
 * Exercise the exact replacement lease in an owned fixture. The future
 * guardian owns live activation, scoped admission and independent recovery.
 */
export async function withP2IdentityRotationReplacementLease(lease, dependencies, task, options = {}) {
  const context = contexts.get(lease);
  demand(context);
  const fixture = options.fixture === true;
  if (!fixture && !P2_IDENTITY_ROTATION_REPLACEMENT_LEASE.liveEligible) throw new Error(liveRefusal);
  const mocked = Object.hasOwn(options, "withSession") || Object.hasOwn(options, "observePhysical");
  demand(exact(options, fixture ? (mocked ? ["fixture", "withSession", "observePhysical"] : ["fixture"]) : []) &&
    (!mocked || fixture && typeof options.withSession === "function" && typeof options.observePhysical === "function") &&
    exact(dependencies, ["getUrl", "verifyEnvironment"]) && typeof dependencies.getUrl === "function" &&
    typeof dependencies.verifyEnvironment === "function" && typeof task === "function");
  const withSession = mocked ? options.withSession : withP2CertificationFrontendSession;
  const observePhysical = mocked ? options.observePhysical : observeP2ProfiledReplacementFrontendPhysical;
  const { plan: { frontendPlan, finalEpoch, authenticationWindows } } = lease;
  const prepared = { migration: context.original.migration, plan: context.original.inventory };
  const { owner } = prepared.plan;
  const getUrl = async () => {
    const value = await dependencies.getUrl();
    if (fixture) {
      const url = new URL(value);
      demand(["127.0.0.1", "[::1]"].includes(url.hostname) && url.hostname === prepared.migration.job.target.host);
    }
    return value;
  };
  const sessionDependencies = { ...dependencies, getUrl };
  const approvedClosedEpochs = new Set([frontendPlan.initialEpoch, ...authenticationWindows.map(window => window.closedEpoch)]);
  let retainedProbe, heldFinal;
  const result = await withSession(prepared, frontendPlan, sessionDependencies, async ({ client, verify, receipt, probe }) => {
    retainedProbe = requireInitialProbe(probe, receipt, frontendPlan, prepared);
    let active = true, ownerActive = false;
    const requireHeld = () => demand(active && !ownerActive);
    const verifyHeld = async () => { requireHeld(); await verify(); };
    const observe = async expectedEpoch => {
      await verifyHeld();
      const proof = await observePhysical({ ...retainedProbe, operation: "observe" }, { getUrl });
      await verifyHeld();
      return requirePhysicalProof(proof, retainedProbe, expectedEpoch, false);
    };
    const observeCurrent = expectedEpoch => { demand(approvedClosedEpochs.has(expectedEpoch)); return observe(expectedEpoch); };
    const initial = await observeCurrent(frontendPlan.initialEpoch);
    demand(initial.witnessSha256 === retainedProbe.receipt.witnessSha256);
    const withOwner = async operation => {
      requireHeld();
      demand(typeof operation === "function");
      ownerActive = true;
      try { return await withPhysicalOwner(client, owner, verify, operation); }
      finally { ownerActive = false; }
    };
    const observeClosed = (phase, boundary) => {
      const selected = authenticationWindows.find(window => window.phase === phase);
      demand(selected && ["before", "after"].includes(boundary));
      return observe(boundary === "before" ? selected.beforeEpoch : selected.closedEpoch);
    };
    const finalObservation = async () => {
      const proof = await observeCurrent(finalEpoch);
      if (authenticationWindows.length === 0) demand(proof.witnessSha256 === initial.witnessSha256);
      return proof;
    };
    const prepareClose = async operation => {
      requireHeld();
      demand(!heldFinal && typeof operation === "function");
      const proof = await finalObservation();
      active = false;
      const result = await operation(proof);
      heldFinal = proof;
      return result;
    };
    try {
      const value = await task(Object.freeze({ client, verify: verifyHeld, withOwner, observeClosed, observeCurrent, prepareClose,
        receipt: retainedProbe.receipt, probe: retainedProbe, initial }));
      if (!heldFinal) heldFinal = await finalObservation();
      return value;
    } finally { active = false; }
  }, profile);
  demand(retainedProbe && heldFinal);
  await dependencies.verifyEnvironment();
  const closure = requirePhysicalProof(await observePhysical({ ...retainedProbe, operation: "verify-closed" }, { getUrl }),
    retainedProbe, finalEpoch, true);
  await dependencies.verifyEnvironment();
  demand(closure.witnessSha256 === heldFinal.witnessSha256);
  return Object.freeze({ ...profileFields, status: fixture ? "P2_IDENTITY_ROTATION_REPLACEMENT_LEASE_FIXTURE_VERIFIED" : "P2_IDENTITY_ROTATION_REPLACEMENT_LEASE_CLOSED",
    liveEligible: false, result, frontendSessionClosed: closure, frontendSessionClosedSha256: p2NativeHash(closure) });
}
