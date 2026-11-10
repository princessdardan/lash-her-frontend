import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareFrontendMigration } from "./frontend-migration.mjs";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { prepareP2CertificationProfile } from "./p2-certification-profile.mjs";
import { prepareP2FrontendReplacementReleaseReview } from "./p2-frontend-replacement-release-review.mjs";
import { prepareP2FrontendReplacementWrittenReadback } from "./p2-frontend-replacement-written.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = "P2_CERTIFICATION_REPLACEMENT_RELEASE_REFUSED";
const demand = condition => { if (!condition) throw new Error(refusal); };
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key]]));
const json = bytes => decodeQualificationTargetJson(bytes, "carrier");
const compareName = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
const services = ["course", "community"];
const deploymentId = value => typeof value === "string" && /^dpl_[A-Za-z0-9]+$/u.test(value);
const physicalFields = ["marker", "backendPid", "backendStart"];
const falseFlags = { frontendSqlReplayed: false, historicalProviderClosureClaimed: false, oldP200Qualified: false,
  nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false };
const terminalPins = ["frontendDatabaseReceiptSha256", "frontendContinuationStartedSha256", "frontendDeploymentProofSha256",
  "frontendWorkloadReceiptSha256", "frontendPromotionReceiptSha256", "frontendTerminalSha256",
  "frontendContinuationCompletedSha256", "frontendReleaseOutcomeSha256", "frontendSessionClosedSha256"];
const apiPins = ["postflightSha256", "runtimeOutcomeSha256", "migrationOutcomeSha256"];
const descriptorPins = ["reviewedPlanSha256", "runtimeReviewSha256", "postflightSha256", "frontendSessionClosedSha256",
  "frontendDatabaseReceiptSha256"];
const oid = value => typeof value === "string" && /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 4294967295;
const roleName = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(value);

export function validP2CertificationReplacementDescriptor(value) {
  try {
    if (!exact(value, ["version", "kind", "qualificationTargetProfile", ...descriptorPins,
      "databaseOid", "migrationRoleOid", "predecessorRuntimeRole", "administrativeLogins"]) || value.version !== 1 ||
      value.kind !== "frontend-replacement" || !descriptorPins.every(key => digest(value[key])) ||
      !oid(value.databaseOid) || !oid(value.migrationRoleOid) || !roleName(value.predecessorRuntimeRole)) return false;
    requireQualificationTargetProfile(profile, value);
    const { administrativeLogins: logins, migrationRoleOid, predecessorRuntimeRole } = value;
    return Array.isArray(logins) && logins.length <= 32 && Array.from(logins).every((login, index) =>
      exact(login, ["name", "oid"]) && roleName(login.name) && oid(login.oid) && login.name !== predecessorRuntimeRole &&
      login.oid !== migrationRoleOid && (index === 0 || compareName(logins[index - 1], login) < 0)) &&
      new Set(logins.map(login => login.oid)).size === logins.length;
  } catch { return false; }
}

function privateBytes(path, maximum, expected) {
  frontendPrivateReceiptDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    demand(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o077) === 0 &&
      before.size > 0 && before.size <= maximum);
    const raw = Buffer.alloc(before.size);
    for (let offset = 0; offset < raw.length;) {
      const count = readSync(fd, raw, offset, raw.length - offset, null);
      demand(count > 0);
      offset += count;
    }
    demand(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0);
    const after = fstatSync(fd);
    demand(["dev", "ino", "size", "mode", "uid", "nlink", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]) &&
      (expected === undefined || digest(expected) && hash(raw) === expected));
    return raw;
  } finally { closeSync(fd); }
}

function readReceipt(directory, name, pin, maximum = 65_536) {
  const bytes = privateBytes(join(directory, name), maximum, pin);
  demand(bytes.at(-1) === 10);
  return bytes;
}

function readPhysical(directory, review) {
  const { plan, settings } = review;
  const custody = json(readReceipt(directory, "replacement-write-custody.json"));
  const { armReceiptSha256, emptyCatalogReceiptSha256, physicalObservationSha256 } = custody;
  demand([armReceiptSha256, emptyCatalogReceiptSha256, physicalObservationSha256].every(digest) &&
    isDeepStrictEqual(custody, {
      ...pick(plan, ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "candidateSha256", "targetSha256"]),
      status: "P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED", reviewedPlanSha256: settings.arm.reviewedPlanSha256,
      bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false,
      armReceiptSha256, emptyCatalogReceiptSha256, physicalObservationSha256, automaticReplayAuthorized: false,
    }));
  return readReceipt(directory, `${physicalObservationSha256}-${armReceiptSha256}.json`, physicalObservationSha256, 8192);
}

function verifyApplication(directory, terminal, review) {
  const database = readReceipt(directory, "database-receipt.json", terminal.frontendDatabaseReceiptSha256);
  const started = readReceipt(directory, "frontend-continuation-started.json", terminal.frontendContinuationStartedSha256, 8192);
  const completion = json(readReceipt(directory, "frontend-continuation-completed.json", terminal.frontendContinuationCompletedSha256));
  const outcome = json(readReceipt(directory, "job-outcome.json", terminal.frontendTerminalSha256));
  const physical = readPhysical(directory, review), startedRecord = json(started);
  const packet = { probe: { ...review.probe, ...pick(json(physical), physicalFields) },
    physicalObservation: physical.toString("base64"), databaseReceipt: database.toString("base64"),
    continuationStarted: started.toString("base64"), owner: terminal.owner, runtime: terminal.runtime,
    producerSha256: terminal.producerSha256, administrativeLogins: review.administrativeLogins };
  const { proof } = prepareP2FrontendReplacementWrittenReadback(packet);
  const startBinding = { ...startedRecord };
  delete startBinding.status;
  delete startBinding.databaseVerified;
  demand(isDeepStrictEqual(outcome, { ...startBinding, status: "DATABASE_VERIFIED", phase: "completed", readOnlyVerified: false }) &&
    isDeepStrictEqual(completion, { ...startedRecord, status: "FRONTEND_CONTINUATION_COMPLETED" }));
  const postflight = json(readReceipt(directory, `${terminal.postflightSha256}-${terminal.frontendDatabaseReceiptSha256}.json`,
    terminal.postflightSha256, 8192));
  demand(isDeepStrictEqual(postflight, proof));
  const closed = json(readReceipt(directory, `${terminal.frontendSessionClosedSha256}-${terminal.postflightSha256}.json`,
    terminal.frontendSessionClosedSha256, 8192));
  demand(isDeepStrictEqual(closed, { ...proof, status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED", operation: "verify-replacement-closed",
    writtenObservationSha256: terminal.postflightSha256, originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true }));
}

function verifyApi(directory, terminal) {
  const read = pin => json(readReceipt(directory, `${pin}-${terminal.postflightSha256}.json`, pin, 2_000_000));
  const migration = read(terminal.migrationOutcomeSha256), runtime = read(terminal.runtimeOutcomeSha256);
  requireQualificationTargetProfile(profile, migration, runtime);
  const expected = {
    ...pick(terminal, ["version", "qualificationTargetProfile", "environment", "releaseId", "candidateSha256", "contractPhase",
      "phase2ContractManifestSha256", "frontendSqlApplied"]), ...falseFlags, phase: "completed",
    frontendMigrationMode: "apply-forward", frontendReadOnlyVerified: false,
    frontendReplacementReadbackSha256: terminal.postflightSha256,
    frontendContinuationStartedSha256: terminal.frontendContinuationStartedSha256,
  };
  demand([migration, runtime].every(record => isDeepStrictEqual(pick(record, Object.keys(expected)), expected)) &&
    migration.status === "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN" &&
    exact(migration.databaseReceiptSha256, ["frontend", ...services]) && Object.values(migration.databaseReceiptSha256).every(digest) &&
    migration.databaseReceiptSha256.frontend === terminal.frontendDatabaseReceiptSha256 &&
    runtime.status === "API_RUNTIME_READY" && runtime.sourceCommit === terminal.sourceCommit &&
    runtime.migrationOutcomeSha256 === terminal.migrationOutcomeSha256 && runtime.frontendPromotionAuthorized === false &&
    isDeepStrictEqual(runtime.configurationSha256, terminal.configurationSha256));
}

function verifyProvider(directory, terminal, review, writerAdmissionBinding) {
  const { plan, probe, runtimeReview } = review;
  const workload = json(readReceipt(directory, "frontend-workload-outcome.json", terminal.frontendWorkloadReceiptSha256));
  const promotion = json(readReceipt(directory, "frontend-promotion-outcome.json", terminal.frontendPromotionReceiptSha256));
  requireQualificationTargetProfile(profile, workload, promotion);
  const identity = { version: 2, qualificationTargetProfile: profile,
    ...pick(terminal, ["environment", "releaseId", "sourceCommit", "deploymentId", "trafficAuthorized"]),
    projectId: probe.candidate.workload.projectId, previousDeploymentId: plan.predecessor.deploymentId, phase: "completed" };
  demand(isDeepStrictEqual(pick(workload, Object.keys(identity)), identity) &&
    workload.status === "FRONTEND_VERIFIED" && workload.nativeSchedulerVerified === false &&
    workload.contractPhase === "p2" && workload.phase2ContractManifestSha256 === terminal.phase2ContractManifestSha256 &&
    isDeepStrictEqual(workload.featureControls, runtimeReview.certification.featureControls) &&
    isDeepStrictEqual(workload.writerAdmissionBinding, writerAdmissionBinding) &&
    isDeepStrictEqual(workload.checks, ["frontend-server-gateway-course-catalog-p2"]));
  const { previousAliasRequestedAt, aliasRequestedAt } = promotion;
  demand(Number.isSafeInteger(previousAliasRequestedAt) && previousAliasRequestedAt >= 0 &&
    Number.isSafeInteger(aliasRequestedAt) && aliasRequestedAt > previousAliasRequestedAt &&
    isDeepStrictEqual(promotion, { ...identity, status: "FRONTEND_DOMAINS_PROMOTED", previousAliasRequestedAt, aliasRequestedAt,
      frontendDomainsPromoted: true, gatewayTrafficAuthorized: false }));
}

// Rejoin the original replacement evidence. This loader grants no authority
// and performs no runtime, database, network or provider operation.
export function prepareP2CertificationReplacementRelease(releaseSettings, selection) {
  try {
    demand(exact(selection, ["terminalFile", "terminalSha256"]) && typeof selection.terminalFile === "string" && digest(selection.terminalSha256));
    const review = prepareP2FrontendReplacementReleaseReview(releaseSettings);
    const { plan, probe, administrativeLogins, runtimeReview, writerReview, settings } = review;
    const directory = join(settings.arm.results, `${plan.releaseId}-replacement-write`);
    const frontend = join(directory, "frontend"), frontendReceipts = join(frontend, "vercel");
    const terminalName = basename(selection.terminalFile);
    demand(selection.terminalFile === join(frontend, terminalName) &&
      new RegExp(`^${selection.terminalSha256}-(?!0+\\.json$)[a-f0-9]{64}\\.json$`, "u").test(terminalName));
    const originalReleaseReceipt = readReceipt(frontend, terminalName, selection.terminalSha256);
    const terminal = json(originalReleaseReceipt);
    requireQualificationTargetProfile(profile, terminal);
    demand([...apiPins, ...terminalPins].every(key => digest(terminal[key])) && deploymentId(terminal.deploymentId) &&
      terminal.deploymentId !== plan.predecessor.deploymentId);
    const base = { version: 2, qualificationTargetProfile: profile,
      ...pick(plan, ["environment", "releaseId", "sourceCommit", "targetSha256", "candidateSha256", "phase2ContractManifestSha256"]),
      configurationSha256: runtimeReview.configurationSha256, ...pick(terminal, apiPins),
      reviewedPlanSha256: hash(review.reviewedPlanBytes), runtimeReviewSha256: hash(review.runtimeReviewBytes),
      contractPhase: "p2", frontendSqlApplied: true, ...falseFlags };
    demand(isDeepStrictEqual(terminal, { ...base, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION",
      frontendSessionClosed: true, migrationMode: "apply-forward", ...pick(terminal, ["deploymentId", "owner", "runtime", ...terminalPins]),
      producerSha256: runtimeReview.producerSha256 }));
    verifyApplication(frontend, terminal, review);
    verifyApi(frontend, terminal);
    const release = json(readReceipt(frontend, "frontend-release-outcome.json", terminal.frontendReleaseOutcomeSha256));
    demand(isDeepStrictEqual(release, { ...base, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED",
      deploymentProofSha256: terminal.frontendDeploymentProofSha256 }));
    const writerAdmissionBinding = { mode: "enforce", targetSha256: plan.targetSha256, producerSha256: terminal.producerSha256,
      sourceCommit: plan.sourceCommit, roleName: terminal.runtime.name };
    verifyProvider(frontendReceipts, terminal, review, writerAdmissionBinding);

    const candidateBytes = privateBytes(join(settings.arm.bundle, "release.candidate.json"), 2_000_000, plan.candidateSha256);
    demand(isDeepStrictEqual(json(candidateBytes), probe.candidate));
    const apiJobs = Object.fromEntries(services.map(service => [service, json(privateBytes(join(settings.arm.bundle, "jobs", service + ".json"),
      65_536, runtimeReview.apiJobSha256[service]))]));
    const replacementRelease = { version: 1, kind: "frontend-replacement", qualificationTargetProfile: profile,
      ...pick(terminal, descriptorPins),
      databaseOid: probe.databaseOid, migrationRoleOid: probe.migrationRoleOid, predecessorRuntimeRole: probe.predecessorTarget.runtimeRole,
      administrativeLogins: [...administrativeLogins].sort(compareName) };
    demand(validP2CertificationReplacementDescriptor(replacementRelease));
    const certification = prepareP2CertificationProfile(runtimeReview.certification);
    const inventory = { version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: plan.releaseId,
      sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256, admissionMode: "existing", owner: terminal.owner,
      producers: [{ producerSha256: terminal.producerSha256, role: terminal.runtime }], runtimeProducerSha256: terminal.producerSha256,
      certification, restoration: { version: 2, qualificationTargetProfile: profile, newWork: false, recovery: false, nativeSchedulesEnabled: false,
        providerIngress: "replacement-closed", gatewayBindingSha256: writerReview.gatewayBindingSha256 }, replacementRelease };
    const original = { migration: prepareFrontendMigration(probe.candidate, probe.job, probe.baseline, undefined, profile),
      plan: { version: 2, qualificationTargetProfile: profile,
        ...pick(base, ["environment", "releaseId", "sourceCommit", "targetSha256", "candidateSha256", "configurationSha256",
          "contractPhase", "phase2ContractManifestSha256"]),
        apiJobSha256: runtimeReview.apiJobSha256, inventorySha256: hash(inventory), certification, writerAdmissionBinding },
      inventory, apiJobs };
    const host = { ...settings.arm.host,
      configuration: join(settings.arm.host.results, `runtime-profiled-frontend-replacement-${plan.releaseId}`, "configuration") };
    const profiledRelease = { receiptSha256: selection.terminalSha256, planSha256: base.reviewedPlanSha256,
      apiJobSha256: runtimeReview.apiJobSha256, apiJobs, configurationDirectory: host.configuration, replacementRelease };
    return { original, directory, frontendReceipts, originalReleaseReceipt, candidateBytes, profiledRelease, host };
  } catch { throw new Error(refusal); }
}
