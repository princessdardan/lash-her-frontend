import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { observeIdentityRotationBoundary } from "./p2-identity-key-rotation-observer.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ACTION = /^p2-key-rotation-[a-z0-9-]{1,40}$/u;
const PHASES = Object.freeze(["baseline", "overlap", "current-only"]);
const MUTATIONS = Object.freeze({ overlap: ["api", "frontend"], "current-only": ["frontend", "api"] });
const DRAIN_MS = 330_000;
const TOKEN_CLOCK_RESOLUTION_MS = 1_000;

export class RotationControllerFailure extends Error {
  constructor(check) { super("P2_IDENTITY_KEY_ROTATION_CONTROLLER_REFUSED"); this.check = check; }
}
const demand = (value, check) => { if (!value) throw new RotationControllerFailure(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

function validatePlan(plan, options = {}) {
  demand(closed(plan, ["version", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit",
    "hostMachineId", "configuration", "privateDirectory", "courseId", "subjects"])
    && plan.version === 1 && plan.environment === "staging" && ACTION.test(plan.actionId)
    && [plan.bindingSha256, plan.candidateSha256].every(value => SHA.test(value)) && COMMIT.test(plan.sourceCommit)
    && /^[a-f0-9]{32}$/u.test(plan.hostMachineId) && typeof plan.privateDirectory === "string"
    && (resolve(plan.privateDirectory).startsWith("/var/lib/lash-her/releases/staging/")
      || options.fixture === true && resolve(plan.privateDirectory).startsWith("/private/tmp/"))
    && closed(plan.configuration, PHASES) && PHASES.every(phase => closed(plan.configuration[phase], ["sha256", "privateRef"])
      && SHA.test(plan.configuration[phase].sha256)
      && plan.configuration[phase].privateRef === `${plan.privateDirectory}/config/${phase}`)
    && /^[a-f0-9-]{36}$/u.test(plan.courseId)
    && closed(plan.subjects, ["course-learner", "course-admin", "community-member", "community-admin"])
    && Object.values(plan.subjects).every(value => /^[a-f0-9-]{36}$/u.test(value))
    && new Set(Object.values(plan.subjects)).size === 4, "rotation-plan");
  demand(new Set(PHASES.map(phase => plan.configuration[phase].sha256)).size === PHASES.length, "distinct-configurations");
  return plan;
}

class Records {
  constructor(directory, options = {}) {
    this.directory = directory; this.fixture = options.fixture === true;
    const info = lstatSync(directory);
    demand(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
      && realpathSync(directory) === resolve(directory) && (this.fixture || info.uid === 0), "private-record-directory");
  }
  path(name) { demand(/^[a-z0-9][a-z0-9-]{0,80}\.json$/u.test(name), "record-name"); return join(this.directory, name); }
  read(name) {
    const path = this.path(name); if (!existsSync(path)) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd); demand(info.isFile() && (info.mode & 0o077) === 0
        && (this.fixture || info.uid === 0) && info.size <= 131_072, "private-record-file");
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
  }
  create(name, value) {
    const fd = openSync(this.path(name), "wx", 0o600);
    try { writeFileSync(fd, canonical(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return value;
  }
}

function mutationIntent(plan, phase, kind) {
  return { version: 1, status: "P2_IDENTITY_ROTATION_MUTATION_INTENT", environment: "staging", actionId: plan.actionId,
    bindingSha256: plan.bindingSha256, candidateSha256: plan.candidateSha256, sourceCommit: plan.sourceCommit,
    phase, kind, fromConfigurationSha256: plan.configuration[phase === "overlap" ? "baseline" : "overlap"].sha256,
    toConfigurationSha256: plan.configuration[phase].sha256, privateConfigurationRef: plan.configuration[phase].privateRef,
    sqlAuthorized: false, rolePreparationAuthorized: false, loginChangeAuthorized: false, admissionAuthorized: false };
}

function exactMutationResult(result, intent) {
  return closed(result, ["version", "status", "actionId", "phase", "kind", "fromConfigurationSha256", "toConfigurationSha256",
    "mutationCount", "getFirstReconciled", "runtimeVerified", "sqlExecuted", "rolesPrepared", "loginChanged"])
    && result.version === 1 && result.status === "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED"
    && ["actionId", "phase", "kind", "fromConfigurationSha256", "toConfigurationSha256"].every(key => result[key] === intent[key])
    && result.mutationCount === 1 && typeof result.getFirstReconciled === "boolean" && result.runtimeVerified === true
    && result.sqlExecuted === false && result.rolesPrepared === false && result.loginChanged === false;
}

function retainedMutation(records, plan, phase, kind) {
  const intent = records.read(`${phase}-${kind}-intent.json`);
  const result = records.read(`${phase}-${kind}-qualified.json`);
  if (result === null) return false;
  const expected = mutationIntent(plan, phase, kind);
  demand(intent !== null && canonical(intent) === canonical(expected) && exactMutationResult(result, expected),
    "retained-mutation-result");
  return true;
}

function pendingMutation(records, plan, phase, kind) {
  const intent = records.read(`${phase}-${kind}-intent.json`);
  const result = records.read(`${phase}-${kind}-qualified.json`);
  if (intent === null || result !== null) return false;
  demand(canonical(intent) === canonical(mutationIntent(plan, phase, kind)), "retained-mutation-intent");
  return true;
}

function retainedOverlapPhase(records, plan) {
  const value = records.read("overlap-qualified.json");
  if (value === null) return null;
  demand(closed(value, ["version", "status", "phase", "configurationSha256", "frontendSignerReceiptSha256",
    "frontendIssuanceCutoffAt", "profiles"]) && value.version === 1
    && value.status === "P2_IDENTITY_ROTATION_PHASE_QUALIFIED" && value.phase === "overlap"
    && value.configurationSha256 === plan.configuration.overlap.sha256 && SHA.test(value.frontendSignerReceiptSha256)
    && Number.isFinite(Date.parse(value.frontendIssuanceCutoffAt)) && Array.isArray(value.profiles) && value.profiles.length === 4
    && value.profiles.map(row => row.profile).sort().join() === ["community-admin", "community-member", "course-admin", "course-learner"].join()
    && value.profiles.every(row => closed(row, ["profile", "observedAt", "oldTokenIssuedAt", "oldTokenExpiresAt"])
      && Number.isFinite(Date.parse(row.observedAt)) && Number.isFinite(Date.parse(row.oldTokenIssuedAt))
      && Date.parse(row.oldTokenExpiresAt) - Date.parse(row.oldTokenIssuedAt) === 300_000
      && Date.parse(row.oldTokenIssuedAt) <= Date.parse(row.observedAt)
      && Date.parse(row.observedAt) < Date.parse(row.oldTokenExpiresAt)), "retained-overlap-phase");
  return value;
}

async function runMutation(records, plan, phase, kind, dependencies) {
  const stem = `${phase}-${kind}`;
  const expected = mutationIntent(plan, phase, kind);
  const stored = records.read(`${stem}-intent.json`);
  const completed = records.read(`${stem}-qualified.json`);
  if (completed !== null) {
    demand(stored !== null && canonical(stored) === canonical(expected) && exactMutationResult(completed, expected), "retained-mutation-result");
    return completed;
  }
  if (stored !== null) {
    demand(canonical(stored) === canonical(expected), "retained-mutation-intent");
    let reconciled;
    try { reconciled = await dependencies.reconcileMutation(expected); } catch { throw new RotationControllerFailure("mutation-ack-unknown"); }
    demand(exactMutationResult(reconciled, expected) && reconciled.getFirstReconciled === true, "mutation-ack-unknown");
    return records.create(`${stem}-qualified.json`, reconciled);
  }
  records.create(`${stem}-intent.json`, expected);
  let result;
  try { result = await dependencies.applyMutation(expected); } catch { throw new RotationControllerFailure("mutation-ack-unknown"); }
  demand(exactMutationResult(result, expected) && result.getFirstReconciled === false, "mutation-ack-unknown");
  return records.create(`${stem}-qualified.json`, result);
}

function capturedProfiles(captures, cutoff, startedAt, completedAt, fresh) {
  const earliestIssuedAt = Math.ceil((cutoff + DRAIN_MS) / TOKEN_CLOCK_RESOLUTION_MS) * TOKEN_CLOCK_RESOLUTION_MS;
  const expected = ["community-admin", "community-member", "course-admin", "course-learner"];
  demand(Array.isArray(captures) && captures.length === expected.length
    && captures.map(row => row.profile).sort().join() === expected.join()
    && captures.every(row => row.status === "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
      && Number.isFinite(Date.parse(row.tokenIssuedAt)) && Number.isFinite(Date.parse(row.tokenExpiresAt))
      && Date.parse(row.tokenExpiresAt) - Date.parse(row.tokenIssuedAt) === 300_000
      && Date.parse(row.tokenIssuedAt) >= earliestIssuedAt
      && (!fresh || Date.parse(row.tokenIssuedAt) >= startedAt - TOKEN_CLOCK_RESOLUTION_MS
        && Date.parse(row.tokenIssuedAt) <= completedAt)
      && Date.parse(row.tokenExpiresAt) > completedAt), "retained-token-capture");
  return new Map(captures.map(row => [row.profile, row]));
}

function profileEvidence(receipts, phase, captures, startedAt, completedAt) {
  demand(Array.isArray(receipts) && receipts.length === 4, "profile-evidence-count");
  const expected = ["community-admin", "community-member", "course-admin", "course-learner"];
  demand(receipts.map(row => row.profile).sort().join() === expected.join()
    && receipts.every(row => row.status === "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED" && row.phase === phase
      && row.retainedTokenContinuityVerified === true && row.releaseAccepted === false
      && Number.isFinite(Date.parse(row.observedAt)) && Date.parse(row.observedAt) >= startedAt
      && Date.parse(row.observedAt) <= completedAt
      && row.oldTokenIssuedAt === captures.get(row.profile)?.tokenIssuedAt
      && row.oldTokenExpiresAt === captures.get(row.profile)?.tokenExpiresAt
      && Date.parse(row.oldTokenIssuedAt) <= Date.parse(row.observedAt)
      && Date.parse(row.observedAt) < Date.parse(row.oldTokenExpiresAt)), "profile-evidence");
  return receipts;
}

function retainedEvidenceMatchesCaptures(receipts, captures) {
  demand(receipts.every(row => row.oldTokenIssuedAt === captures.get(row.profile)?.tokenIssuedAt
    && row.oldTokenExpiresAt === captures.get(row.profile)?.tokenExpiresAt), "retained-token-continuity");
}

export async function runIdentityKeyRotationController(planValue, parent, dependencies, options = {}) {
  demand(options.fixture === true, "source-parent-dispatch-not-integrated");
  const plan = validatePlan(planValue, options);
  demand(parent && parent.sourceOwnedFixedAction === true && parent.hostLockHeld === true && parent.frontendPhysicalLockHeld === true
    && parent.configOnly === true && parent.nativeSchedulesEnabled === false && parent.businessSchedulesEnabled === false
    && parent.sqlAuthorized === false && parent.rolePreparationAuthorized === false && parent.loginChangeAuthorized === false,
  "source-parent-authority");
  const required = ["frontendSession", "hostScope", "observeRuntime", "observeFrontendProvider", "applyMutation", "reconcileMutation",
    "captureTokens", "observeProfiles", "observeFrontendSigner", "wait", "failClosed", "restoreQualified"];
  demand(required.every(name => name in dependencies) && ["applyMutation", "reconcileMutation", "captureTokens", "observeProfiles",
    "observeFrontendSigner", "wait", "failClosed", "restoreQualified"].every(name => typeof dependencies[name] === "function"),
  "controller-dependencies");
  const records = new Records(plan.privateDirectory, options);
  const final = records.read("rotation-controller-qualified.json");
  const overlapPhase = retainedOverlapPhase(records, plan);
  let overlapApi = retainedMutation(records, plan, "overlap", "api");
  let overlapFrontend = retainedMutation(records, plan, "overlap", "frontend");
  let currentFrontend = retainedMutation(records, plan, "current-only", "frontend");
  let currentApi = retainedMutation(records, plan, "current-only", "api");
  const pending = [["overlap", "api"], ["overlap", "frontend"], ["current-only", "frontend"], ["current-only", "api"]]
    .filter(([phase, kind]) => pendingMutation(records, plan, phase, kind));
  demand(pending.length <= 1, "retained-mutation-order");
  demand(!overlapFrontend || overlapApi, "retained-phase-order");
  demand(!overlapPhase || overlapApi && overlapFrontend, "retained-phase-order");
  demand(!currentFrontend && !currentApi || overlapPhase !== null, "retained-phase-order");
  demand(!currentApi || currentFrontend, "retained-phase-order");
  let lastQualified = overlapPhase === null ? "baseline" : "overlap";
  let runtimePhase = currentApi ? "current-only" : overlapApi ? "overlap" : "baseline";
  let frontendPhase = currentFrontend ? "current-only" : overlapFrontend ? "overlap" : "baseline";
  let mutationUncertain = false;
  const verifyBoundary = async phase => observeIdentityRotationBoundary({ version: 1, environment: "staging", actionId: plan.actionId,
    phase, bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
    runtimeConfigurationSha256: plan.configuration[runtimePhase].sha256,
    frontendConfigurationSha256: plan.configuration[frontendPhase].sha256,
    frontendSession: dependencies.frontendSession, hostScope: dependencies.hostScope }, dependencies);
  if (final !== null) {
    demand(closed(final, ["version", "status", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit",
      "baselineConfigurationSha256", "overlapConfigurationSha256", "currentOnlyConfigurationSha256", "lastFullyQualifiedPhase",
      "profileCount", "overlapDrainSeconds", "keyRemovalVerified", "sourceMechanicsQualified",
      "sourceParentDispatchIntegrated", "liveEligible", "sqlExecuted", "rolesPrepared", "loginChanged", "trafficAuthorized"])
      && final.version === 1 && final.environment === "staging"
      && final.status === "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED" && final.actionId === plan.actionId
      && final.bindingSha256 === plan.bindingSha256 && final.candidateSha256 === plan.candidateSha256
      && final.sourceCommit === plan.sourceCommit && final.currentOnlyConfigurationSha256 === plan.configuration["current-only"].sha256
      && final.sourceParentDispatchIntegrated === false && final.liveEligible === false && final.keyRemovalVerified === false
      && pending.length === 0 && overlapPhase !== null && overlapApi && overlapFrontend && currentFrontend && currentApi
      && runtimePhase === "current-only" && frontendPhase === "current-only", "retained-controller-result");
    try { await verifyBoundary("current-only"); }
    catch {
      try { await dependencies.failClosed({ phase: "current-only", mutationUncertain: false }); } catch {}
      throw new RotationControllerFailure("retained-result-current-state-unverified");
    }
    return Object.freeze(final);
  }
  try {
    if (pending.length === 1) {
      const [[phase, kind]] = pending;
      demand(phase === "overlap" && kind === "api" || phase === "overlap" && kind === "frontend" && overlapApi
        || phase === "current-only" && kind === "frontend" && overlapPhase !== null
        || phase === "current-only" && kind === "api" && currentFrontend, "retained-mutation-order");
      await runMutation(records, plan, phase, kind, dependencies);
      if (phase === "overlap" && kind === "api") { overlapApi = true; runtimePhase = "overlap"; }
      else if (phase === "overlap") { overlapFrontend = true; frontendPhase = "overlap"; }
      else if (kind === "frontend") { currentFrontend = true; frontendPhase = "current-only"; }
      else { currentApi = true; runtimePhase = "current-only"; }
    }
    await verifyBoundary(frontendPhase === "current-only" || runtimePhase === "current-only" ? "current-only"
      : frontendPhase === "overlap" || runtimePhase === "overlap" ? "overlap" : "baseline");
    let selectedOverlap = overlapPhase;
    if (selectedOverlap === null) {
      await runMutation(records, plan, "overlap", "api", dependencies); runtimePhase = "overlap";
      await verifyBoundary("overlap");
      await runMutation(records, plan, "overlap", "frontend", dependencies); frontendPhase = "overlap";
      await verifyBoundary("overlap");
      const frontendOverlap = await dependencies.observeFrontendSigner("overlap");
      demand(frontendOverlap?.status === "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
        && frontendOverlap.configurationSha256 === plan.configuration.overlap.sha256 && SHA.test(frontendOverlap.receiptSha256),
      "frontend-overlap-signer");
      const cutoff = Date.parse(frontendOverlap.issuanceCutoffAt);
      demand(Number.isFinite(cutoff), "frontend-issuance-cutoff");
      const tokenCaptureAt = Math.ceil((cutoff + DRAIN_MS) / TOKEN_CLOCK_RESOLUTION_MS) * TOKEN_CLOCK_RESOLUTION_MS;
      await dependencies.wait(tokenCaptureAt, async () => verifyBoundary("overlap"));
      demand((options.nowMs ?? Date.now)() >= tokenCaptureAt, "overlap-drain-incomplete");
      selectedOverlap = { frontendIssuanceCutoffAt: frontendOverlap.issuanceCutoffAt,
        frontendSignerReceiptSha256: frontendOverlap.receiptSha256 };
    }
    const cutoff = Date.parse(selectedOverlap.frontendIssuanceCutoffAt);
    const captureStartedAt = (options.nowMs ?? Date.now)();
    const captures = await dependencies.captureTokens();
    const captureCompletedAt = (options.nowMs ?? Date.now)();
    const captureByProfile = capturedProfiles(captures, cutoff, captureStartedAt, captureCompletedAt, overlapPhase === null);
    const overlapObservationStartedAt = (options.nowMs ?? Date.now)();
    const observedOverlap = overlapPhase === null ? await dependencies.observeProfiles("overlap", captures) : null;
    const overlapObservationCompletedAt = (options.nowMs ?? Date.now)();
    const overlapEvidence = overlapPhase === null
      ? profileEvidence(observedOverlap, "overlap", captureByProfile, overlapObservationStartedAt, overlapObservationCompletedAt)
      : overlapPhase.profiles;
    retainedEvidenceMatchesCaptures(overlapEvidence, captureByProfile);
    if (overlapPhase === null) records.create("overlap-qualified.json", { version: 1,
      status: "P2_IDENTITY_ROTATION_PHASE_QUALIFIED", phase: "overlap",
      configurationSha256: plan.configuration.overlap.sha256,
      frontendSignerReceiptSha256: selectedOverlap.frontendSignerReceiptSha256,
      frontendIssuanceCutoffAt: selectedOverlap.frontendIssuanceCutoffAt,
      profiles: overlapEvidence.map(row => ({ profile: row.profile, observedAt: row.observedAt,
        oldTokenIssuedAt: row.oldTokenIssuedAt, oldTokenExpiresAt: row.oldTokenExpiresAt })) });
    lastQualified = "overlap";
    await runMutation(records, plan, "current-only", "frontend", dependencies); frontendPhase = "current-only";
    await verifyBoundary("current-only");
    await runMutation(records, plan, "current-only", "api", dependencies); runtimePhase = "current-only";
    await verifyBoundary("current-only");
    const frontendCurrent = await dependencies.observeFrontendSigner("current-only");
    demand(frontendCurrent?.status === "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
      && frontendCurrent.configurationSha256 === plan.configuration["current-only"].sha256 && SHA.test(frontendCurrent.receiptSha256),
    "frontend-current-signer");
    const currentObservationStartedAt = (options.nowMs ?? Date.now)();
    const observedCurrent = await dependencies.observeProfiles("current-only", captures);
    const currentObservationCompletedAt = (options.nowMs ?? Date.now)();
    const currentEvidence = profileEvidence(observedCurrent, "current-only", captureByProfile,
      currentObservationStartedAt, currentObservationCompletedAt);
    for (const before of overlapEvidence) {
      const after = currentEvidence.find(row => row.profile === before.profile);
      demand(after.oldTokenIssuedAt === before.oldTokenIssuedAt && after.oldTokenExpiresAt === before.oldTokenExpiresAt,
        "retained-token-continuity");
    }
    await verifyBoundary("current-only");
    lastQualified = "current-only";
    const outcome = { version: 1, status: "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED", environment: "staging",
      actionId: plan.actionId, bindingSha256: plan.bindingSha256, candidateSha256: plan.candidateSha256, sourceCommit: plan.sourceCommit,
      baselineConfigurationSha256: plan.configuration.baseline.sha256, overlapConfigurationSha256: plan.configuration.overlap.sha256,
      currentOnlyConfigurationSha256: plan.configuration["current-only"].sha256, lastFullyQualifiedPhase: lastQualified,
      profileCount: currentEvidence.length, overlapDrainSeconds: DRAIN_MS / 1000, keyRemovalVerified: false,
      sourceMechanicsQualified: true, sourceParentDispatchIntegrated: false, liveEligible: false,
      sqlExecuted: false, rolesPrepared: false, loginChanged: false,
      trafficAuthorized: false };
    records.create("rotation-controller-qualified.json", outcome);
    return Object.freeze(outcome);
  } catch (error) {
    mutationUncertain = error instanceof RotationControllerFailure && ["mutation-ack-unknown", "mutation-result"].includes(error.check);
    try { await dependencies.failClosed({ phase: lastQualified, mutationUncertain }); } catch { mutationUncertain = true; }
    if (!mutationUncertain) {
      try {
        await verifyBoundary("containment");
        await dependencies.restoreQualified(lastQualified, plan.configuration[lastQualified]);
        runtimePhase = lastQualified; frontendPhase = lastQualified;
        await verifyBoundary("containment");
      } catch { mutationUncertain = true; }
    }
    throw new RotationControllerFailure(mutationUncertain ? "rotation-failure-uncertain" : "rotation-failure-contained");
  }
}

export const P2_IDENTITY_ROTATION_CONTROLLER = Object.freeze({ phases: PHASES, mutationOrder: MUTATIONS,
  overlapDrainSeconds: DRAIN_MS / 1000, sourceParentDispatchIntegrated: false, liveEligible: false });
