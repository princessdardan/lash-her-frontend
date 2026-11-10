import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { observeIdentityRotationBoundary } from "./p2-identity-key-rotation-observer.mjs";
import { isP2IdentityRotationParentAuthority } from "./p2-identity-key-rotation-parent.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { writeFrontendReceipt } from "./frontend-migration.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ACTION = /^p2-key-rotation-[a-z0-9-]{1,40}$/u;
const PHASES = Object.freeze(["baseline", "overlap", "current-only"]);
const MUTATIONS = Object.freeze({ overlap: ["api", "frontend"], "current-only": ["frontend", "api"] });
const DRAIN_MS = 330_000;
const TOKEN_CLOCK_RESOLUTION_MS = 1_000;
const TOKEN_LIFETIME_MS = 300_000;
const PROFILES = Object.freeze(["community-admin", "community-member", "course-admin", "course-learner"]);
const earliestCapture = cutoff => Math.ceil((Date.parse(cutoff) + DRAIN_MS) / TOKEN_CLOCK_RESOLUTION_MS) * TOKEN_CLOCK_RESOLUTION_MS;
const issuedAtSecond = time => Math.floor(time / TOKEN_CLOCK_RESOLUTION_MS) * TOKEN_CLOCK_RESOLUTION_MS;
const exactProfiles = rows => Array.isArray(rows) && rows.length === PROFILES.length
  && rows.map(row => row?.profile).sort().join() === PROFILES.join();
const FIXTURE_ROOT = `${realpathSync(tmpdir())}/`;

export class RotationControllerFailure extends Error {
  constructor(check) { super("P2_IDENTITY_KEY_ROTATION_CONTROLLER_REFUSED"); this.check = check; }
}
const demand = (value, check) => { if (!value) throw new RotationControllerFailure(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

function validatePlan(plan, sourceBound) {
  const privateDirectory = plan?.privateDirectory;
  const firstReference = plan?.configuration?.baseline?.privateRef;
  const configurationDirectory = sourceBound && typeof firstReference === "string" ? dirname(firstReference) : `${privateDirectory}/config`;
  demand(closed(plan, ["version", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit",
    "hostMachineId", "configuration", "privateDirectory", "courseId", "subjects"])
    && plan.version === 1 && plan.environment === "staging" && ACTION.test(plan.actionId)
    && [plan.bindingSha256, plan.candidateSha256].every(value => SHA.test(value)) && COMMIT.test(plan.sourceCommit)
    && /^[a-f0-9]{32}$/u.test(plan.hostMachineId) && typeof privateDirectory === "string"
    && resolve(privateDirectory) === privateDirectory
    && (sourceBound ? basename(privateDirectory) === "controller" && basename(dirname(privateDirectory)) === plan.actionId
      && configurationDirectory.startsWith("/var/lib/lash-her/releases/staging/") && resolve(configurationDirectory) === configurationDirectory
      : privateDirectory.startsWith(FIXTURE_ROOT))
    && closed(plan.configuration, PHASES) && PHASES.every(phase => closed(plan.configuration[phase], ["sha256", "privateRef"])
      && SHA.test(plan.configuration[phase].sha256)
      && plan.configuration[phase].privateRef === `${configurationDirectory}/${phase}`)
    && /^[a-f0-9-]{36}$/u.test(plan.courseId)
    && closed(plan.subjects, ["course-learner", "course-admin", "community-member", "community-admin"])
    && Object.values(plan.subjects).every(value => /^[a-f0-9-]{36}$/u.test(value))
    && new Set(Object.values(plan.subjects)).size === 4, "rotation-plan");
  demand(new Set(PHASES.map(phase => plan.configuration[phase].sha256)).size === PHASES.length, "distinct-configurations");
  return plan;
}

class Records {
  constructor(directory) {
    this.directory = frontendPrivateReceiptDirectory(directory);
    this.identity = lstatSync(directory);
  }
  path(name) {
    demand(/^[a-z0-9][a-z0-9-]{0,80}\.json$/u.test(name), "record-name");
    const info = lstatSync(frontendPrivateReceiptDirectory(this.directory));
    demand(info.dev === this.identity.dev && info.ino === this.identity.ino, "private-record-directory-changed");
    return join(this.directory, name);
  }
  read(name) {
    const path = this.path(name);
    let fd;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const info = fstatSync(fd);
      demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600
        && info.size > 0 && info.size <= 131_072, "private-record-file");
      const bytes = readFileSync(fd);
      const raw = bytes.toString("utf8"), value = JSON.parse(raw);
      demand(bytes.length === info.size && raw === canonical(value) + "\n", "private-record-bytes");
      return value;
    } finally { closeSync(fd); }
  }
  create(name, value) {
    this.path(name);
    writeFrontendReceipt(this.directory, name, JSON.parse(canonical(value)));
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

function requireFrontendSigner(plan, phase, signer) {
  demand(signer?.status === "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
    && signer.phase === phase && signer.configurationSha256 === plan.configuration[phase === "post-removal" ? "current-only" : phase].sha256
    && SHA.test(signer.receiptSha256) && Number.isFinite(Date.parse(signer.issuanceCutoffAt)), "frontend-signer");
  return signer;
}

function frontendMilestone(plan, phase, signer, verifiedAt) {
  const value = { version: 1, actionId: plan.actionId, bindingSha256: plan.bindingSha256, phase,
    configurationSha256: signer.configurationSha256, frontendSignerReceiptSha256: signer.receiptSha256,
    frontendIssuanceCutoffAt: signer.issuanceCutoffAt, verifiedAt: new Date(verifiedAt).toISOString() };
  requireFrontendMilestone(value, plan, phase);
  return value;
}

function requireFrontendMilestone(value, plan, phase) {
  const verifiedAt = Date.parse(value.verifiedAt), cutoff = Date.parse(value.frontendIssuanceCutoffAt);
  demand(closed(value, ["version", "actionId", "bindingSha256", "phase", "configurationSha256",
    "frontendSignerReceiptSha256", "frontendIssuanceCutoffAt", "verifiedAt"])
    && value.version === 1 && value.actionId === plan.actionId && value.bindingSha256 === plan.bindingSha256
    && value.phase === phase && value.configurationSha256 === plan.configuration[phase === "post-removal" ? "current-only" : phase].sha256
    && SHA.test(value.frontendSignerReceiptSha256) && Number.isFinite(verifiedAt) && Number.isFinite(cutoff)
    && verifiedAt >= (phase === "overlap" ? earliestCapture(value.frontendIssuanceCutoffAt) : cutoff), "retained-frontend-milestone");
  return value;
}

function captureIntent(plan, overlapDrained, currentSigner, startedAt) {
  return { version: 1, actionId: plan.actionId, bindingSha256: plan.bindingSha256,
    overlapConfigurationSha256: plan.configuration.overlap.sha256,
    overlapFrontendSignerReceiptSha256: overlapDrained.frontendSignerReceiptSha256,
    currentFrontendSignerReceiptSha256: currentSigner.frontendSignerReceiptSha256, startedAt };
}

function retainedOverlapPhase(records, intent) {
  const value = records.read("overlap-qualified.json");
  if (value === null) return null;
  demand(intent !== null && closed(value, ["version", "status", "phase", "captureIntent", "profiles"]) && value.version === 2
    && value.status === "P2_IDENTITY_ROTATION_PHASE_QUALIFIED" && value.phase === "overlap"
    && canonical(value.captureIntent) === canonical(intent) && exactProfiles(value.profiles)
    && value.profiles.every(row => closed(row, ["profile", "observedAt", "oldTokenIssuedAt", "oldTokenExpiresAt"])
      && Number.isFinite(Date.parse(row.observedAt)) && Number.isFinite(Date.parse(row.oldTokenIssuedAt))
      && Date.parse(row.oldTokenExpiresAt) - Date.parse(row.oldTokenIssuedAt) === TOKEN_LIFETIME_MS
      && Date.parse(row.oldTokenIssuedAt) >= issuedAtSecond(Date.parse(intent.startedAt))
      && Date.parse(row.observedAt) >= Date.parse(intent.startedAt)
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

function capturedProfiles(captures, intent, cutoff, completedAt) {
  const earliestIssuedAt = Math.max(earliestCapture(cutoff), issuedAtSecond(Date.parse(intent.startedAt)));
  demand(exactProfiles(captures)
    && captures.every(row => row.status === "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
      && Number.isFinite(Date.parse(row.tokenIssuedAt)) && Number.isFinite(Date.parse(row.tokenExpiresAt))
      && Date.parse(row.tokenExpiresAt) - Date.parse(row.tokenIssuedAt) === TOKEN_LIFETIME_MS
      && Date.parse(row.tokenIssuedAt) >= earliestIssuedAt && Date.parse(row.tokenIssuedAt) <= completedAt
      && Date.parse(row.tokenExpiresAt) > completedAt), "retained-token-capture");
  return captures.map(({ profile, tokenIssuedAt, tokenExpiresAt }) =>
    Object.freeze({ profile, tokenIssuedAt, tokenExpiresAt }));
}

function profileEvidence(receipts, phase, captures, startedAt, completedAt) {
  const captureByProfile = new Map(captures.map(row => [row.profile, row]));
  demand(exactProfiles(receipts)
    && receipts.every(row => row.status === "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED" && row.phase === phase
      && row.retainedTokenContinuityVerified === true && row.releaseAccepted === false
      && row.oldResult === (phase === "overlap" ? "accepted" : "rejected") && row.newResult === "accepted"
      && Number.isFinite(Date.parse(row.observedAt)) && Date.parse(row.observedAt) >= startedAt
      && Date.parse(row.observedAt) <= completedAt
      && row.oldTokenIssuedAt === captureByProfile.get(row.profile)?.tokenIssuedAt
      && row.oldTokenExpiresAt === captureByProfile.get(row.profile)?.tokenExpiresAt
      && Date.parse(row.oldTokenIssuedAt) <= Date.parse(row.observedAt)
      && Date.parse(row.observedAt) < Date.parse(row.oldTokenExpiresAt)), "profile-evidence");
  return receipts;
}

function requireUnexpired(captures, observedAt) {
  demand(captures.every(row => observedAt < Date.parse(row.tokenExpiresAt)), "retained-token-expired");
}

export async function runIdentityKeyRotationController(planValue, parent, dependencies, options = {}) {
  const sourceBound = isP2IdentityRotationParentAuthority(options.parentAuthority, planValue);
  demand(options.fixture === true || sourceBound, "source-parent-dispatch-not-integrated");
  const plan = validatePlan(planValue, sourceBound);
  demand(parent && parent.sourceOwnedFixedAction === true && parent.hostLockHeld === true && parent.frontendPhysicalLockHeld === true
    && parent.configOnly === true && parent.nativeSchedulesEnabled === false && parent.businessSchedulesEnabled === false
    && parent.sqlAuthorized === false && parent.rolePreparationAuthorized === false && parent.loginChangeAuthorized === false,
  "source-parent-authority");
  const required = ["frontendSession", "hostScope", "observeRuntime", "observeFrontendProvider", "applyMutation", "reconcileMutation",
    "captureTokens", "observeProfiles", "observeFrontendSigner", "wait", "failClosed", "restoreQualified"];
  demand(required.every(name => name in dependencies) && ["applyMutation", "reconcileMutation", "captureTokens", "observeProfiles",
    "observeFrontendSigner", "wait", "failClosed", "restoreQualified"].every(name => typeof dependencies[name] === "function"),
  "controller-dependencies");
  const records = new Records(plan.privateDirectory);
  const final = records.read("rotation-controller-qualified.json");
  const now = options.nowMs ?? Date.now;
  let overlapDrained = records.read("overlap-drained.json");
  let currentSigner = records.read("current-frontend-verified.json");
  const postRemovalIntent = records.read("post-removal-signer-intent.json");
  const postRemovalSigner = records.read("post-removal-signer-verified.json");
  const retainedCaptureIntent = records.read("pre-removal-capture-intent.json");
  if (overlapDrained !== null) requireFrontendMilestone(overlapDrained, plan, "overlap");
  if (currentSigner !== null) requireFrontendMilestone(currentSigner, plan, "current-only");
  if (postRemovalIntent !== null) {
    demand(closed(postRemovalIntent, ["version", "actionId", "bindingSha256", "startedAt"]) && postRemovalIntent.version === 1
      && postRemovalIntent.actionId === plan.actionId && postRemovalIntent.bindingSha256 === plan.bindingSha256
      && Number.isFinite(Date.parse(postRemovalIntent.startedAt)), "retained-post-removal-signer-intent");
  }
  if (postRemovalSigner !== null) {
    requireFrontendMilestone(postRemovalSigner, plan, "post-removal");
    demand(currentSigner !== null && postRemovalIntent !== null
      && postRemovalSigner.frontendSignerReceiptSha256 !== currentSigner.frontendSignerReceiptSha256
      && Date.parse(postRemovalIntent.startedAt) >= Date.parse(currentSigner.verifiedAt)
      && Date.parse(postRemovalSigner.frontendIssuanceCutoffAt) >= Date.parse(postRemovalIntent.startedAt),
    "retained-post-removal-signer-evidence");
  }
  if (retainedCaptureIntent !== null) {
    const startedAt = Date.parse(retainedCaptureIntent.startedAt);
    demand(overlapDrained !== null && currentSigner !== null && Number.isFinite(startedAt)
      && startedAt >= Date.parse(currentSigner.verifiedAt) && startedAt >= Date.parse(overlapDrained.verifiedAt)
      && canonical(retainedCaptureIntent) === canonical(captureIntent(plan, overlapDrained, currentSigner, retainedCaptureIntent.startedAt)),
    "retained-token-capture-intent");
  }
  let overlapPhase = retainedOverlapPhase(records, retainedCaptureIntent);
  let overlapApi = retainedMutation(records, plan, "overlap", "api");
  let overlapFrontend = retainedMutation(records, plan, "overlap", "frontend");
  let currentFrontend = retainedMutation(records, plan, "current-only", "frontend");
  let currentApi = retainedMutation(records, plan, "current-only", "api");
  const pending = [["overlap", "api"], ["overlap", "frontend"], ["current-only", "frontend"], ["current-only", "api"]]
    .filter(([phase, kind]) => pendingMutation(records, plan, phase, kind));
  demand(pending.length <= 1, "retained-mutation-order");
  demand(!overlapFrontend || overlapApi, "retained-phase-order");
  demand(!overlapDrained || overlapApi && overlapFrontend, "retained-phase-order");
  demand(!currentFrontend || overlapDrained !== null, "retained-phase-order");
  demand(!currentSigner || currentFrontend && Date.parse(currentSigner.verifiedAt) >= Date.parse(overlapDrained.verifiedAt), "retained-phase-order");
  demand(!currentApi || overlapPhase !== null && currentFrontend, "retained-phase-order");
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
      "profileCount", "overlapDrainSeconds", "postRemovalFrontendSignerReceiptSha256", "keyRemovalVerified", "sourceMechanicsQualified",
      "sourceParentDispatchIntegrated", "liveEligible", "sqlExecuted", "rolesPrepared", "loginChanged", "trafficAuthorized"])
      && final.version === 1 && final.environment === "staging"
      && final.status === "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED" && final.actionId === plan.actionId
      && final.bindingSha256 === plan.bindingSha256 && final.candidateSha256 === plan.candidateSha256
      && final.sourceCommit === plan.sourceCommit && final.currentOnlyConfigurationSha256 === plan.configuration["current-only"].sha256
      && final.baselineConfigurationSha256 === plan.configuration.baseline.sha256
      && final.overlapConfigurationSha256 === plan.configuration.overlap.sha256
      && final.lastFullyQualifiedPhase === "current-only" && final.profileCount === PROFILES.length
      && final.overlapDrainSeconds === DRAIN_MS / 1000 && final.sourceMechanicsQualified === true
      && postRemovalSigner !== null && final.postRemovalFrontendSignerReceiptSha256 === postRemovalSigner.frontendSignerReceiptSha256
      && ["sourceParentDispatchIntegrated", "liveEligible", "keyRemovalVerified", "sqlExecuted", "rolesPrepared", "loginChanged",
        "trafficAuthorized"].every(key => final[key] === false)
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
    demand(postRemovalIntent === null, "post-removal-signer-outcome-unknown");
    if (pending.length === 1) {
      const [[phase, kind]] = pending;
      demand(phase === "overlap" && kind === "api" || phase === "overlap" && kind === "frontend" && overlapApi
        || phase === "current-only" && kind === "frontend" && overlapDrained !== null
        || phase === "current-only" && kind === "api" && overlapPhase !== null && currentFrontend, "retained-mutation-order");
      await runMutation(records, plan, phase, kind, dependencies);
      if (phase === "overlap" && kind === "api") { overlapApi = true; runtimePhase = "overlap"; }
      else if (phase === "overlap") { overlapFrontend = true; frontendPhase = "overlap"; }
      else if (kind === "frontend") { currentFrontend = true; frontendPhase = "current-only"; }
      else { currentApi = true; runtimePhase = "current-only"; }
    }
    await verifyBoundary(frontendPhase === "current-only" || runtimePhase === "current-only" ? "current-only"
      : frontendPhase === "overlap" || runtimePhase === "overlap" ? "overlap" : "baseline");
    if (retainedCaptureIntent !== null && overlapPhase === null) throw new RotationControllerFailure("capture-outcome-unknown");
    if (overlapDrained === null) {
      await runMutation(records, plan, "overlap", "api", dependencies); runtimePhase = "overlap";
      await verifyBoundary("overlap");
      await runMutation(records, plan, "overlap", "frontend", dependencies); frontendPhase = "overlap";
      await verifyBoundary("overlap");
      const frontendOverlap = requireFrontendSigner(plan, "overlap", await dependencies.observeFrontendSigner("overlap"));
      const tokenCaptureAt = earliestCapture(frontendOverlap.issuanceCutoffAt);
      await dependencies.wait(tokenCaptureAt, async () => verifyBoundary("overlap"));
      await verifyBoundary("overlap");
      const verifiedAt = now();
      demand(verifiedAt >= tokenCaptureAt, "overlap-drain-incomplete");
      overlapDrained = records.create("overlap-drained.json", frontendMilestone(plan, "overlap", frontendOverlap, verifiedAt));
    }
    if (!currentFrontend) {
      await runMutation(records, plan, "current-only", "frontend", dependencies);
      currentFrontend = true; frontendPhase = "current-only";
      await verifyBoundary("current-only");
    }
    let captures;
    if (overlapPhase === null) {
      demand(runtimePhase === "overlap" && frontendPhase === "current-only", "capture-split-state");
      if (currentSigner === null) {
        const frontendCurrent = requireFrontendSigner(plan, "current-only", await dependencies.observeFrontendSigner("current-only"));
        await verifyBoundary("current-only");
        currentSigner = records.create("current-frontend-verified.json", frontendMilestone(plan, "current-only", frontendCurrent, now()));
      }
      const captureStartedAt = now();
      demand(captureStartedAt >= Date.parse(currentSigner.verifiedAt), "capture-frontend-verification-order");
      const intent = records.create("pre-removal-capture-intent.json",
        captureIntent(plan, overlapDrained, currentSigner, new Date(captureStartedAt).toISOString()));
      let captured;
      try { captured = await dependencies.captureTokens(); }
      catch { throw new RotationControllerFailure("capture-outcome-unknown"); }
      captures = capturedProfiles(captured, intent, overlapDrained.frontendIssuanceCutoffAt, now());
      await verifyBoundary("current-only");
      const overlapObservationStartedAt = now();
      requireUnexpired(captures, overlapObservationStartedAt);
      const observedOverlap = await dependencies.observeProfiles("overlap", captures);
      const overlapEvidence = profileEvidence(observedOverlap, "overlap", captures, overlapObservationStartedAt, now());
      overlapPhase = records.create("overlap-qualified.json", { version: 2,
        status: "P2_IDENTITY_ROTATION_PHASE_QUALIFIED", phase: "overlap", captureIntent: intent,
        profiles: overlapEvidence.map(({ profile, observedAt, oldTokenIssuedAt, oldTokenExpiresAt }) =>
          ({ profile, observedAt, oldTokenIssuedAt, oldTokenExpiresAt })) });
    } else {
      captures = overlapPhase.profiles.map(({ profile, oldTokenIssuedAt, oldTokenExpiresAt }) =>
        ({ profile, tokenIssuedAt: oldTokenIssuedAt, tokenExpiresAt: oldTokenExpiresAt }));
    }
    lastQualified = "overlap";
    if (!currentApi) {
      await verifyBoundary("current-only");
      requireUnexpired(captures, now());
      await runMutation(records, plan, "current-only", "api", dependencies); runtimePhase = "current-only";
      await verifyBoundary("current-only");
    }
    requireUnexpired(captures, now());
    const currentObservationStartedAt = now();
    const observedCurrent = await dependencies.observeProfiles("current-only", captures);
    const currentEvidence = profileEvidence(observedCurrent, "current-only", captures, currentObservationStartedAt, now());
    await verifyBoundary("current-only");
    const postRemovalStartedAt = now();
    records.create("post-removal-signer-intent.json", { version: 1, actionId: plan.actionId,
      bindingSha256: plan.bindingSha256, startedAt: new Date(postRemovalStartedAt).toISOString() });
    const postRemoval = requireFrontendSigner(plan, "post-removal", await dependencies.observeFrontendSigner("post-removal"));
    await verifyBoundary("current-only");
    demand(Date.parse(postRemoval.issuanceCutoffAt) >= postRemovalStartedAt
      && postRemoval.receiptSha256 !== currentSigner.frontendSignerReceiptSha256, "post-removal-signer-evidence");
    records.create("post-removal-signer-verified.json", frontendMilestone(plan, "post-removal", postRemoval, now()));
    lastQualified = "current-only";
    const outcome = { version: 1, status: "P2_IDENTITY_KEY_ROTATION_CONTROLLER_QUALIFIED", environment: "staging",
      actionId: plan.actionId, bindingSha256: plan.bindingSha256, candidateSha256: plan.candidateSha256, sourceCommit: plan.sourceCommit,
      baselineConfigurationSha256: plan.configuration.baseline.sha256, overlapConfigurationSha256: plan.configuration.overlap.sha256,
      currentOnlyConfigurationSha256: plan.configuration["current-only"].sha256, lastFullyQualifiedPhase: lastQualified,
      profileCount: currentEvidence.length, overlapDrainSeconds: DRAIN_MS / 1000,
      postRemovalFrontendSignerReceiptSha256: postRemoval.receiptSha256, keyRemovalVerified: false,
      sourceMechanicsQualified: true, sourceParentDispatchIntegrated: false, liveEligible: false,
      sqlExecuted: false, rolesPrepared: false, loginChanged: false,
      trafficAuthorized: false };
    records.create("rotation-controller-qualified.json", outcome);
    return Object.freeze(outcome);
  } catch (error) {
    mutationUncertain = error instanceof RotationControllerFailure && ["mutation-ack-unknown", "mutation-result", "capture-outcome-unknown",
      "post-removal-signer-outcome-unknown"].includes(error.check);
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
