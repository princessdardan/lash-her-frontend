// Fixed-current frontend provider continuation. No CLI, ambient credential,
// legacy downcast or caller-selected provider program is exposed here.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { observeFrontendDrain } from "./frontend-admission.mjs";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { prepareP2CertificationProfile } from "./p2-certification-profile.mjs";
import { requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const workerPath = fileURLToPath(new URL("./host/p2_profiled_current_frontend.py", import.meta.url));
const refuse = () => { throw new Error("P2_PROFILED_CURRENT_FRONTEND_REVIEW_REQUIRED"); };
const demand = value => { if (!value) refuse(); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const jsonHash = value => hash(JSON.stringify(value));
const pinsHash = value => hash(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))));
const configurationNames = Object.freeze([
  "runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
  "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem",
  "tls/course/cert.pem", "tls/community/key.pem", "tls/community/cert.pem", "course-api.env",
  "course-publisher.env", "course-snapshot.env", "community-api.env", "community-worker.env",
  "course-media.env", "course-export-cleanup.env",
]);
const controlNames = Object.freeze([
  "INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
  "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED",
  "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
]);
const falseFields = Object.freeze(["frontendSqlApplied", "historicalProviderClosureClaimed", "oldP200Qualified",
  "nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted"]);
const recoveryPinNames = Object.freeze(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome",
  "apiRuntimeOutcome", "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]);
const lostBuildPinNames = Object.freeze(["deployStarted", "buildStarted", "buildIntent"]);

// Reject getters, proxies with inconsistent own data and exotic prototypes
// before source-owned functions or private values are consumed.
function plain(value, depth = 0, budget = { count: 0 }) {
  demand(depth <= 64 && ++budget.count <= 100_000);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  demand(typeof value === "object" && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), entries = Object.entries(descriptors);
  if (Array.isArray(value)) {
    demand(Object.hasOwn(descriptors.length, "value") && descriptors.length.value === value.length);
  }
  demand(entries.every(([key, descriptor]) => key === "length" && Array.isArray(value) ||
    descriptor.enumerable && Object.hasOwn(descriptor, "value")));
  entries.forEach(([key, descriptor]) => { if (key !== "length" || !Array.isArray(value)) plain(descriptor.value, depth + 1, budget); });
  return value;
}
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  demand(descriptor && Object.hasOwn(descriptor, "value")); return descriptor.value;
}
function profiles(...carriers) {
  carriers.forEach(value => plain(value)); requireQualificationTargetProfile(profile, ...carriers);
}
function configurationMap(value) {
  plain(value); demand(isDeepStrictEqual(Object.keys(value).sort(), [...configurationNames].sort()) &&
    Object.values(value).every(digest)); return value;
}
function featureControls(plan) {
  const value = prepareP2CertificationProfile(plan.certification).featureControls;
  demand(isDeepStrictEqual(Object.keys(value).sort(), [...controlNames].sort()) &&
    Object.values(value).every(item => typeof item === "boolean")); return value;
}
function providerContext(value, recovery) {
  demand(value && typeof value === "object");
  const version = own(value, "version"), selectedProfile = plain(own(value, "qualificationTargetProfile"));
  requireQualificationTargetProfile(profile, { qualificationTargetProfile: selectedProfile });
  demand(version === 2); plain(value);
  const required = ["version", "qualificationTargetProfile", "vercelToken", "bindings", ...(recovery ? ["originalDirectory"] : ["frontendRuntimeDatabaseUrl"])];
  const optional = recovery && Object.hasOwn(value, "frontendRuntimeDatabaseUrl") ? ["frontendRuntimeDatabaseUrl"] : [];
  demand(isDeepStrictEqual(Object.keys(value).sort(), [...required, ...optional].sort()));
  demand(typeof value.vercelToken === "string" &&
    value.vercelToken.length > 0 && value.vercelToken.length <= 8192 && /^[!-~]+$/u.test(value.vercelToken) &&
    value.bindings && typeof value.bindings === "object");
  if (recovery) frontendPrivateReceiptDirectory(value.originalDirectory);
  else demand(typeof value.frontendRuntimeDatabaseUrl === "string" && value.frontendRuntimeDatabaseUrl.length > 0 &&
    value.frontendRuntimeDatabaseUrl.length <= 16_384 && !/[\r\n]/u.test(value.frontendRuntimeDatabaseUrl));
  return value;
}

function validateRelease(context) {
  demand(context && typeof context === "object");
  const plan = plain(own(context, "plan")), candidate = plain(own(context, "candidate")), job = plain(own(context, "job"));
  const configurationSha256 = configurationMap(own(context, "configurationSha256"));
  const target = plain(own(context, "bootstrapRuntimeTarget")), admission = plain(own(context, "admissionObservation"));
  const contextProfile = plain(own(context, "qualificationTargetProfile"));
  profiles({ qualificationTargetProfile: contextProfile }, plan, candidate, candidate.frontendMigration, job, job.target, target);
  const definition = resolveQualificationTargetProfile(profile), sourceCommit = candidate.sources?.frontend?.commit;
  demand(definition.id === "staging-current" && plan.version === 2 && plan.environment === "staging" &&
    candidate.version === 3 && candidate.environment === "staging" && job.version === 2 && job.environment === "staging" &&
    candidate.releaseId === job.releaseId && candidate.releaseId === plan.actionId && sourceCommit === plan.sourceCommit &&
    sourceCommit === job.sourceCommit && commit(sourceCommit) && candidate.contractPhase === "p2" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
    candidate.phase2ContractManifestSha256 !== `sha256:${"0".repeat(64)}` &&
    candidate.sources.frontend.repository === "https://github.com/princessdardan/lash-her-frontend.git" &&
    candidate.sources.frontend.requiredChecks === "passed" && candidate.workload?.projectId === definition.frontend.projectId &&
    candidate.workload.environment === definition.frontend.workloadEnvironment && Array.isArray(job.target.approvedPendingTags) &&
    job.target.approvedPendingTags.length === 0 && job.target.allowEmptyBootstrap === false &&
    digest(own(context, "candidateSha256")) && digest(own(context, "inventorySha256")) && context.inventorySha256 === jsonHash(plan) &&
    (!plan.configurationSha256 || isDeepStrictEqual(plan.configurationSha256, configurationSha256)));
  demand(target.environment === "staging" && target.targetSha256 === plan.targetSha256 && digest(target.targetSha256) &&
    target.host === job.target.host && target.port === job.target.port && target.database === job.target.database &&
    target.user === job.target.runtimeRole && target.serverMajor === job.target.serverMajor);
  demand(typeof admission.epoch === "string" && /^[1-9][0-9]{0,17}$/u.test(admission.epoch) && admission.newWork === false &&
    admission.recovery === false && admission.ledgerDrained === true && admission.active === 0 && admission.uncertain === 0);
  demand(typeof own(context, "getProviderContext") === "function" && typeof own(context, "verifyLockedSession") === "function" &&
    typeof own(context, "databaseClient")?.query === "function" && (!context.environmentSignal ||
      typeof context.environmentSignal.addEventListener === "function"));
  frontendPrivateReceiptDirectory(own(context, "directory"));
  const expectedFeatureControls = featureControls(plan);
  const writerAdmissionBinding = { mode: "enforce", targetSha256: plan.targetSha256,
    producerSha256: plan.runtimeProducerSha256, sourceCommit, roleName: target.user };
  demand(digest(writerAdmissionBinding.producerSha256) && /^[a-z][a-z0-9_]{0,62}$/u.test(writerAdmissionBinding.roleName ?? ""));
  return { plan, candidate, job, configurationSha256, target, admission, expectedFeatureControls, writerAdmissionBinding,
    candidateSha256: context.candidateSha256, inventorySha256: context.inventorySha256 };
}

function validateRecovery(context) {
  demand(context && typeof context === "object");
  const plan = plain(own(context, "plan")), migration = plain(own(context, "migration"));
  profiles(plan, migration, migration.candidate, migration.candidate.frontendMigration, migration.job, migration.job.target);
  const candidate = migration.candidate, job = migration.job, pins = plain(own(context, "originalReceiptSha256"));
  const configurationSha256 = configurationMap(plan.configurationSha256);
  demand(plan.version === 2 && plan.mode === "p2-profiled-current-recovery" && plan.environment === "staging" &&
    ["restore-current-runtime", "reconcile-frontend-get-first", "resume-approved-api-suffix"].includes(plan.disposition) &&
    candidate.version === 3 && job.version === 2 && candidate.releaseId === plan.originalReleaseId &&
    job.releaseId === plan.originalReleaseId && candidate.sources?.frontend?.commit === plan.sourceCommit &&
    candidate.sources.frontend.repository === "https://github.com/princessdardan/lash-her-frontend.git" &&
    candidate.sources.frontend.requiredChecks === "passed" && candidate.workload?.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" &&
    candidate.workload.environment === "production" && candidate.contractPhase === "p2" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
    candidate.phase2ContractManifestSha256 !== `sha256:${"0".repeat(64)}` && job.sourceCommit === plan.sourceCommit &&
    job.environment === "staging" && Array.isArray(job.target.approvedPendingTags) && job.target.approvedPendingTags.length === 0 &&
    job.target.allowEmptyBootstrap === false && commit(plan.sourceCommit) && digest(plan.candidateSha256) &&
    digest(plan.targetSha256) && isDeepStrictEqual(pins, plan.originalReceiptSha256) &&
    isDeepStrictEqual(Object.keys(pins).sort(), [...recoveryPinNames].sort()) && Object.values(pins).every(digest));
  demand(typeof own(context, "verifyEnvironment") === "function" && typeof own(context, "verifySession") === "function");
  return { plan, migration, candidate, job, pins, configurationSha256 };
}

function validateLostBuildRecovery(context) {
  demand(context && typeof context === "object");
  const plan = plain(own(context, "plan")), migration = plain(own(context, "migration"));
  profiles(plan, migration, migration.candidate, migration.candidate.frontendMigration, migration.job, migration.job.target);
  const candidate = migration.candidate, job = migration.job, pins = plain(own(context, "lostBuildReceiptSha256"));
  const configurationSha256 = configurationMap(plan.configurationSha256), keys = Object.keys(pins).sort();
  demand(plan.version === 2 && plan.mode === "p2-profiled-current-recovery" && plan.environment === "staging" &&
    plan.disposition === "reconcile-frontend-lost-build-get-first" && candidate.version === 3 && job.version === 2 &&
    candidate.releaseId === plan.originalReleaseId && job.releaseId === plan.originalReleaseId &&
    candidate.sources?.frontend?.commit === plan.sourceCommit && job.sourceCommit === plan.sourceCommit &&
    candidate.sources.frontend.repository === "https://github.com/princessdardan/lash-her-frontend.git" &&
    candidate.sources.frontend.requiredChecks === "passed" && candidate.workload?.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" &&
    candidate.workload.environment === "production" && candidate.contractPhase === "p2" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") &&
    candidate.phase2ContractManifestSha256 !== `sha256:${"0".repeat(64)}` && job.environment === "staging" &&
    Array.isArray(job.target.approvedPendingTags) && job.target.approvedPendingTags.length === 0 &&
    job.target.allowEmptyBootstrap === false && commit(plan.sourceCommit) && digest(plan.candidateSha256) && digest(plan.targetSha256) &&
    isDeepStrictEqual(pins, plan.lostBuildReceiptSha256) && (isDeepStrictEqual(keys, [...lostBuildPinNames].sort()) ||
      isDeepStrictEqual(keys, [...lostBuildPinNames, "buildOutcome"].sort())) && Object.values(pins).every(digest));
  demand(typeof own(context, "verifyEnvironment") === "function" && typeof own(context, "verifySession") === "function");
  return { plan, migration, candidate, job, pins, configurationSha256 };
}

async function closedAdmission(context, selected) {
  await context.verifyLockedSession(); demand(!context.environmentSignal?.aborted);
  const actual = await observeFrontendDrain(context.databaseClient,
    { environment: "staging", targetSha256: selected.plan.targetSha256 }, selected.admission.epoch);
  demand(actual.epoch === selected.admission.epoch && actual.newWork === false && actual.recovery === false &&
    actual.active === 0 && actual.uncertain === 0 && actual.ledgerDrained === true);
  await context.verifyLockedSession(); demand(!context.environmentSignal?.aborted); return actual;
}

async function runWorker(operation, payload, checkpoint, signal) {
  let child, result, received = false, failed = false, timeout, killTimeout, processing = Promise.resolve(), outputBytes = 0;
  try {
    const input = JSON.stringify({ operation, ...payload }) + "\n"; demand(Buffer.byteLength(input) <= 2_000_000);
    child = spawn("python3", ["-I", "-B", "-u", "-c",
      "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_module('p2_profiled_current_frontend',run_name='__main__')",
      dirname(workerPath)], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      cwd: resolve(dirname(workerPath), "../../..") });
    const stop = () => {
      if (failed) return; failed = true; child.kill("SIGTERM");
      killTimeout ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => stop(); signal?.addEventListener("abort", abort, { once: true });
    const lines = createInterface({ input: child.stdout }); let sequence = 0;
    lines.on("line", line => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > 8_000_000 || Buffer.byteLength(line) > 2_000_000) { stop(); return; }
      processing = processing.then(async () => {
        demand(!failed); const frame = JSON.parse(line);
        if (frame?.type === "checkpoint") {
          demand(!received && Number.isSafeInteger(frame.id) && frame.id === sequence + 1);
          await checkpoint(); demand(!failed && !signal?.aborted); sequence = frame.id;
          child.stdin.write(JSON.stringify({ type: "continue", id: sequence }) + "\n");
        } else {
          demand(frame?.type === "result" && !received && frame.value && typeof frame.value === "object");
          received = true; result = frame.value; child.stdin.end();
        }
      }).catch(stop);
    });
    child.stdin.on("error", stop); child.stdout.on("error", stop); timeout = setTimeout(stop, 20 * 60_000);
    const exit = new Promise(resolveExit => {
      child.once("error", () => { failed = true; resolveExit(null); }); child.once("close", resolveExit);
    });
    child.stdin.write(input); const code = await exit; await processing; lines.close(); signal?.removeEventListener("abort", abort);
    demand(code === 0 && !failed && received); await checkpoint(); return result;
  } catch { refuse(); } finally { clearTimeout(timeout); clearTimeout(killTimeout); }
}

function releasePayload(selected, provider, directory) {
  return { qualificationTargetProfile: profile, plan: selected.plan, candidate: selected.candidate, job: selected.job,
    candidateSha256: selected.candidateSha256, inventorySha256: selected.inventorySha256,
    configurationSha256: selected.configurationSha256, directory, vercelToken: provider.vercelToken,
    bindings: provider.bindings, expectedFeatureControls: selected.expectedFeatureControls,
    writerAdmissionBinding: selected.writerAdmissionBinding, bootstrapRuntimeTarget: selected.target,
    frontendRuntimeDatabaseUrl: provider.frontendRuntimeDatabaseUrl };
}

function releaseProof(result, selected) {
  plain(result); profiles(result);
  demand(result.version === 2 && result.status === "P2_PROFILED_CURRENT_FRONTEND_VERIFIED" &&
    result.environment === "staging" && result.actionId === selected.candidate.releaseId &&
    result.releaseId === selected.candidate.releaseId && result.sourceCommit === selected.plan.sourceCommit &&
    result.targetSha256 === selected.plan.targetSha256 && result.candidateSha256 === selected.candidateSha256 &&
    isDeepStrictEqual(result.configurationSha256, selected.configurationSha256) && result.contractPhase === "p2" &&
    result.phase2ContractManifestSha256 === selected.candidate.phase2ContractManifestSha256 &&
    result.projectId === selected.candidate.workload.projectId && /^dpl_[A-Za-z0-9]+$/u.test(result.deploymentId ?? "") &&
    result.readyState === "READY" && result.aliasJobState === "succeeded" && result.aliasDeploymentId === result.deploymentId &&
    result.aliasJobDeploymentId === result.deploymentId && result.aliasJobMatchesIntent === true && result.aliasJobType === "promote" &&
    result.nativeSchedulesEnabled === false && result.admissionNewWork === false && result.admissionRecovery === false &&
    result.workloadVerified === true && isDeepStrictEqual(result.featureControls, selected.expectedFeatureControls) &&
    isDeepStrictEqual(result.writerAdmissionBinding, selected.writerAdmissionBinding) &&
    result.configurationRecordSha256 === result.workloadReceiptSha256 && digest(result.workloadReceiptSha256) &&
    result.certificationSchedule?.path === "/api/cron/account-lifecycle" && result.certificationSchedule.schedule === "* * * * *" &&
    result.certificationSchedule.nativeEnabled === false && result.certificationSchedule.deploymentId === result.deploymentId &&
    digest(result.certificationSchedule.definitionsSha256) && falseFields.every(key => result[key] === false));
  const evidence = Buffer.from(JSON.stringify(result)); demand(evidence.length > 0 && evidence.length <= 2_000_000);
  return { ...result, evidence, evidenceSha256: hash(evidence) };
}

function recoveryProof(result, selected) {
  plain(result); profiles(result);
  demand(result.version === 2 && result.status === "P2_PROFILED_CURRENT_FRONTEND_CURRENT" &&
    result.environment === "staging" && result.actionId === selected.plan.originalReleaseId &&
    result.releaseId === selected.plan.originalReleaseId && result.sourceCommit === selected.plan.sourceCommit &&
    result.targetSha256 === selected.plan.targetSha256 && result.candidateSha256 === selected.plan.candidateSha256 &&
    isDeepStrictEqual(result.configurationSha256, selected.configurationSha256) && result.getFirst === true &&
    result.newProviderPost === false && result.ambiguous === false &&
    result.originalEffectReconciled === (selected.plan.disposition === "reconcile-frontend-get-first") &&
    result.originalReceiptSha256 === pinsHash(selected.pins) && digest(result.workloadReceiptSha256) &&
    result.configurationRecordSha256 === result.workloadReceiptSha256 && result.nativeSchedulesEnabled === false &&
    result.admissionNewWork === false && result.admissionRecovery === false && falseFields.every(key => result[key] === false));
  const inner = result.proof; profiles(inner);
  demand(inner.version === 2 && inner.status === "P2_PROFILED_CURRENT_FRONTEND_VERIFIED" && inner.environment === "staging" &&
    inner.actionId === selected.plan.originalReleaseId && inner.releaseId === selected.plan.originalReleaseId &&
    inner.sourceCommit === selected.plan.sourceCommit && inner.targetSha256 === selected.plan.targetSha256 &&
    inner.candidateSha256 === selected.plan.candidateSha256 && isDeepStrictEqual(inner.configurationSha256, selected.configurationSha256) &&
    inner.contractPhase === "p2" && inner.phase2ContractManifestSha256 === selected.candidate.phase2ContractManifestSha256 &&
    /^dpl_[A-Za-z0-9]+$/u.test(inner.deploymentId ?? "") && inner.readyState === "READY" &&
    inner.aliasJobState === "succeeded" && inner.aliasDeploymentId === inner.deploymentId &&
    inner.aliasJobDeploymentId === inner.deploymentId && inner.aliasJobMatchesIntent === true && inner.aliasJobType === "promote" &&
    inner.workloadVerified === true && inner.workloadReceiptSha256 === result.workloadReceiptSha256 &&
    inner.configurationRecordSha256 === inner.workloadReceiptSha256 && isDeepStrictEqual(Object.keys(inner.featureControls).sort(), [...controlNames].sort()) &&
    Object.values(inner.featureControls).every(value => typeof value === "boolean") &&
    inner.writerAdmissionBinding?.mode === "enforce" && inner.writerAdmissionBinding.targetSha256 === selected.plan.targetSha256 &&
    digest(inner.writerAdmissionBinding.producerSha256) && inner.writerAdmissionBinding.sourceCommit === selected.plan.sourceCommit &&
    inner.writerAdmissionBinding.roleName === selected.job.target.runtimeRole && inner.certificationSchedule?.path === "/api/cron/account-lifecycle" &&
    inner.certificationSchedule.schedule === "* * * * *" && inner.certificationSchedule.nativeEnabled === false &&
    inner.certificationSchedule.deploymentId === inner.deploymentId && digest(inner.certificationSchedule.definitionsSha256) &&
    inner.nativeSchedulesEnabled === false && inner.admissionNewWork === false && inner.admissionRecovery === false &&
    falseFields.every(key => inner[key] === false));
  const evidence = Buffer.from(JSON.stringify(result)); demand(evidence.length > 0 && evidence.length <= 2_000_000);
  return { ...result, evidence, evidenceSha256: hash(evidence) };
}

function lostBuildProof(result, selected) {
  plain(result); profiles(result);
  const fields = ["version", "qualificationTargetProfile", "status", "environment", "actionId", "releaseId", "sourceCommit",
    "candidateSha256", "configurationSha256", "targetSha256", "projectId", "deploymentId", "previousDeploymentId",
    "lostBuildReceiptSha256", "deployStartedSha256", "buildStartedSha256", "buildIntentSha256",
    ...(Object.hasOwn(selected.pins, "buildOutcome") ? ["buildOutcomeSha256"] : []), "getFirst", "newProviderPost", "ambiguous",
    "deploymentEffectObserved", "frontendActionPending", "originalBuildAckObserved", "providerMutationReplayed",
    "buildReadyVerified", "workloadVerified", "aliasQualificationVerified", "promotionVerified", "cronQualificationVerified",
    "trafficAuthorized", "releaseAccepted"];
  demand(isDeepStrictEqual(Object.keys(result).sort(), fields.sort()) && result.version === 2 &&
    result.status === "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED" && result.environment === "staging" &&
    result.actionId === selected.plan.originalReleaseId && result.releaseId === selected.plan.originalReleaseId &&
    result.sourceCommit === selected.plan.sourceCommit && result.candidateSha256 === selected.plan.candidateSha256 &&
    isDeepStrictEqual(result.configurationSha256, selected.configurationSha256) && result.targetSha256 === selected.plan.targetSha256 &&
    result.projectId === selected.candidate.workload.projectId && /^dpl_[A-Za-z0-9]+$/u.test(result.deploymentId ?? "") &&
    (result.previousDeploymentId === null || /^dpl_[A-Za-z0-9]+$/u.test(result.previousDeploymentId ?? "")) &&
    result.lostBuildReceiptSha256 === pinsHash(selected.pins) && result.deployStartedSha256 === selected.pins.deployStarted &&
    result.buildStartedSha256 === selected.pins.buildStarted && result.buildIntentSha256 === selected.pins.buildIntent &&
    (!Object.hasOwn(selected.pins, "buildOutcome") || result.buildOutcomeSha256 === selected.pins.buildOutcome) &&
    result.getFirst === true && result.newProviderPost === false && result.ambiguous === false &&
    result.deploymentEffectObserved === true && result.frontendActionPending === true &&
    ["originalBuildAckObserved", "providerMutationReplayed", "buildReadyVerified", "workloadVerified",
      "aliasQualificationVerified", "promotionVerified", "cronQualificationVerified", "trafficAuthorized", "releaseAccepted"]
      .every(key => result[key] === false));
  const evidence = Buffer.from(JSON.stringify(result)); demand(evidence.length > 0 && evidence.length <= 2_000_000);
  return { ...result, evidence, evidenceSha256: hash(evidence) };
}

export async function deployProfiledCurrentFrontend(context) {
  try {
    const selected = validateRelease(context); await closedAdmission(context, selected);
    const provider = providerContext(await context.getProviderContext(Object.freeze({ qualificationTargetProfile: profile,
      actionId: selected.plan.actionId, sourceCommit: selected.plan.sourceCommit, targetSha256: selected.plan.targetSha256 })), false);
    await closedAdmission(context, selected);
    const result = await runWorker("deploy", releasePayload(selected, provider, context.directory),
      () => closedAdmission(context, selected), context.environmentSignal);
    return releaseProof(result, selected);
  } catch { refuse(); }
}

export async function observeProfiledCurrentFrontend(context) {
  try {
    const descriptor = context && Object.getOwnPropertyDescriptor(context, "plan"), mode = descriptor &&
      Object.hasOwn(descriptor, "value") && Object.getOwnPropertyDescriptor(descriptor.value, "mode");
    if (mode && Object.hasOwn(mode, "value") && mode.value === "p2-profiled-current-recovery") {
      const disposition = Object.getOwnPropertyDescriptor(descriptor.value, "disposition");
      if (disposition && Object.hasOwn(disposition, "value") && disposition.value === "reconcile-frontend-lost-build-get-first") {
        const selected = validateLostBuildRecovery(context); await context.verifyEnvironment(); await context.verifySession();
        const provider = providerContext(own(context, "providerContext"), true);
        const result = await runWorker("recovery-observe-lost-build", { version: 2, qualificationTargetProfile: profile,
          plan: selected.plan, candidate: selected.candidate, job: selected.job, lostBuildReceiptSha256: selected.pins,
          originalDirectory: provider.originalDirectory, vercelToken: provider.vercelToken, bindings: provider.bindings },
        async () => { await context.verifyEnvironment(); await context.verifySession(); }, context.environmentSignal);
        return lostBuildProof(result, selected);
      }
      const selected = validateRecovery(context); await context.verifyEnvironment(); await context.verifySession();
      const provider = providerContext(own(context, "providerContext"), true);
      const result = await runWorker("recovery-observe", { qualificationTargetProfile: profile, plan: selected.plan,
        candidate: selected.candidate, job: selected.job, originalReceiptSha256: selected.pins,
        originalDirectory: provider.originalDirectory, vercelToken: provider.vercelToken, bindings: provider.bindings },
      async () => { await context.verifyEnvironment(); await context.verifySession(); }, context.environmentSignal);
      return recoveryProof(result, selected);
    }
    const selected = validateRelease(context); await closedAdmission(context, selected);
    const provider = providerContext(await context.getProviderContext(Object.freeze({ qualificationTargetProfile: profile,
      actionId: selected.plan.actionId, sourceCommit: selected.plan.sourceCommit, targetSha256: selected.plan.targetSha256 })), false);
    const result = await runWorker("observe", releasePayload(selected, provider, context.directory),
      () => closedAdmission(context, selected), context.environmentSignal);
    return releaseProof(result, selected);
  } catch { refuse(); }
}

export async function readProfiledCurrentWorkloadReceipt(context, observation) {
  try {
    plain(observation); profiles(observation); demand(digest(observation.workloadReceiptSha256)); let directory;
    const descriptor = context && Object.getOwnPropertyDescriptor(context, "plan"), mode = descriptor &&
      Object.hasOwn(descriptor, "value") && Object.getOwnPropertyDescriptor(descriptor.value, "mode");
    if (mode && Object.hasOwn(mode, "value") && mode.value === "p2-profiled-current-recovery") {
      const selected = validateRecovery(context), provider = providerContext(own(context, "providerContext"), true);
      directory = provider.originalDirectory;
      demand(observation.status === "P2_PROFILED_CURRENT_FRONTEND_CURRENT" &&
        observation.originalReceiptSha256 === pinsHash(selected.pins));
    } else {
      const selected = validateRelease(context); directory = context.directory;
      demand(observation.status === "P2_PROFILED_CURRENT_FRONTEND_VERIFIED" && observation.releaseId === selected.candidate.releaseId);
    }
    const bytes = readFrontendReleaseEvidence(resolve(frontendPrivateReceiptDirectory(directory), "vercel"), "frontend-workload-outcome.json");
    demand(hash(bytes) === observation.workloadReceiptSha256); return bytes;
  } catch { refuse(); }
}
