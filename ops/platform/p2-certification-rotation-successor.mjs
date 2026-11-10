import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { frontendCoordinationHash } from "./frontend-release-inventory.mjs";
import { p2NativeHash as hash } from "./p2-lifecycle-native.mjs";
import { prepareP2ReplacementSuccessor } from "./p2-replacement-successor.mjs";
import { decodeQualificationTargetJson as decode, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

export const rotationSuccessorKind = "identity-key-rotation-mixed-mount-v1";
const refusal = "P2_CERTIFICATION_ROTATION_SUCCESSOR_REFUSED";
const demand = condition => { if (!condition) throw new Error(refusal); };
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const rotationAction = value => typeof value === "string" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  equal(Reflect.ownKeys(value).sort(), [...keys].sort());
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const phaseNames = ["baseline", "overlap", "current-only"];
const mutationOrder = [["overlap", "api"], ["overlap", "frontend"], ["current-only", "frontend"], ["current-only", "api"]];
const unchangedServices = ["community-tls", "course-tls", "course-snapshot", "community-worker",
  "course-media", "course-export-cleanup", "course-publisher", "gateway"];
const terminalFlags = ["nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted", "g2Accepted"];
const joinedFalse = [...terminalFlags, "sqlExecuted", "rolesPrepared", "loginChanged", "tokenBytesOutput",
  "credentialHashesOutput", "communityMemberFeatureAdded", "newPublicEndpoint"];
const profileClasses = { "course-learner": "actual-protected-course-http", "course-admin": "actual-protected-course-http",
  "community-member": "deployed-private-community-verifier", "community-admin": "deployed-private-community-verifier" };
const planFlags = ["sqlAuthorized", "rolePreparationAuthorized", "loginChangeAuthorized", "trafficAuthorized",
  "communityMemberFeatureAdded", "newPublicEndpoint", "keyRemovalVerified", "releaseAccepted", "liveEligible"];
const identityFields = ["actionId", "bindingSha256", "sourceCommit", "candidateSha256"];
const planFields = ["version", "qualificationTargetProfile", "environment", "status", ...identityFields, "hostMachineId",
  "originalReleaseId", "courseId", "subjects", "configuration", "featureControls", "writerAdmissionBinding", "targetSha256",
  "operatorSourceClosureSha256", "candidateObjectSha256", "replacementLeasePlanSha256", "frontendCustodyPlanSha256",
  "readyReceiptSha256", "nativePlanSha256", "initialEpoch", "finalEpoch", "authenticationWindows", ...planFlags];
const custodyFields = ["version", "qualificationTargetProfile", "environment", "mode", "sourceCommit", "sourceSha256",
  "sourceClosureSha256", "hostMachineId", "bundle", "configuration", "results", "candidate", "candidateSha256",
  "configurationSha256", "apiJobSha256", "frontendJob", "frontendBaseline", "targetSha256", "owner", "inventory",
  "inventorySha256", "certification", "expectedWriterAdmissionBinding", "certificationActionId", "certificationPlan",
  "originalReleaseReceipt", "readyReceipts"];
const hashFields = ["predecessorRuntimeInventorySha256", "terminalReceiptSha256", "frontendSessionClosedSha256",
  "configurationSha256", "currentOnlyRuntimeConfigurationSha256", "runtimeInventorySha256", "gatewayProcessSha256",
  "gatewayConfigurationSha256"];
const receiptFields = ["version", "qualificationTargetProfile", "status", "environment", "kind", "releaseId",
  ...identityFields, "hostMachineId", "targetSha256", "originalReleasePlanSha256", "originalReleaseReceiptSha256", ...hashFields,
  "frontendEpoch", "frontend", "mutationReceipts", "phaseRuntimeInventoryReceiptSha256", "unchangedOriginalServices",
  "currentOnlyRecreatedServices", "frontendAdmissionClosed", "gatewayAdmissionClosed", ...terminalFlags];
const joinedFields = ["version", "qualificationTargetProfile", "status", "environment", ...identityFields, "configurationSha256",
  "profileEvidenceClass", "profileReceiptSha256", "frontendSignerReceiptSha256", "keyRemovalVerified", "sourceParentDispatchIntegrated",
  "frontendFinalEpoch", "frontendCustodyPlanSha256", "frontendSessionCloseReceiptSha256", ...joinedFalse];
const readyIdentity = ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "projectId", "previousDeploymentId"];
const readyFields = {
  "frontend-build-started.json": ["trafficAuthorized", "promotionAuthorized"],
  "frontend-build-created.json": ["trafficAuthorized", "promotionAuthorized", "deploymentId"],
  "frontend-build-outcome.json": ["trafficAuthorized", "promotionAuthorized", "deploymentId", "status", "phase", "url", "readyState"],
  "frontend-workload-outcome.json": ["deploymentId", "status", "phase", "trafficAuthorized", "nativeSchedulerVerified", "checks",
    "contractPhase", "phase2ContractManifestSha256", "featureControls", "writerAdmissionBinding"],
  "frontend-promotion-started.json": ["deploymentId", "previousAliasRequestedAt"],
  "frontend-promotion-outcome.json": ["deploymentId", "previousAliasRequestedAt", "status", "phase", "trafficAuthorized",
    "gatewayTrafficAuthorized", "frontendDomainsPromoted", "aliasRequestedAt"],
};

function bytes(encoded) {
  demand(typeof encoded === "string" && encoded.length <= 87_384);
  const raw = Buffer.from(encoded, "base64");
  demand(raw.length > 0 && raw.length <= 65_536 && raw.at(-1) === 10 && raw.toString("base64") === encoded);
  return raw;
}

function hashWithout(value, key) {
  const body = { ...value };
  delete body[key];
  return hash(body);
}

function readyBytes(value, hashes, names) {
  demand(exact(value, names) && exact(hashes, names));
  return new Map(names.map(name => {
    const raw = bytes(value[name]);
    demand(digest(hashes[name]) && hash(raw) === hashes[name]);
    const record = decode(raw, "carrier");
    demand(exact(record, [...readyIdentity, ...readyFields[name]]));
    if (name === "frontend-workload-outcome.json") {
      demand(record.phase === "completed" && equal(record.checks, ["frontend-server-gateway-course-catalog-p2"]));
    }
    if (name === "frontend-promotion-outcome.json") demand(record.gatewayTrafficAuthorized === false);
    return [name, raw];
  }));
}

function reviewedRotation(rotation, custody, joined, checked, input, results, actionId, readyNames) {
  const { original: { plan: release, inventory, migration }, profiledRelease, originalReleaseReceipt, host } = checked;
  demand(exact(rotation, planFields) && exact(custody, custodyFields));
  const prior = custody.certificationPlan, native = prior.nativePlan;
  const runtimeProducers = inventory.producers.filter(row => row.producerSha256 === inventory.runtimeProducerSha256);
  const originalTerminal = decode(originalReleaseReceipt, "carrier");
  requireQualificationTargetProfile(profile, rotation, custody, prior, native, joined);
  const baselineIdentity = pick(release, ["sourceCommit", "candidateSha256", "targetSha256", "environment"]);
  demand(equal(pick(rotation, Object.keys(baselineIdentity)), baselineIdentity) &&
    equal(pick(custody, Object.keys(baselineIdentity)), baselineIdentity) &&
    equal(pick(prior, Object.keys(baselineIdentity)), baselineIdentity) &&
    rotation.version === 2 && rotation.status === "P2_IDENTITY_ROTATION_MANAGED_PLANNED" &&
    rotation.actionId === actionId && rotation.originalReleaseId === release.releaseId && rotation.hostMachineId === host.machineId &&
    digest(rotation.bindingSha256) && rotation.bindingSha256 === hashWithout(rotation, "bindingSha256") &&
    planFlags.every(key => rotation[key] === false) &&
    exact(rotation.configuration, phaseNames) && phaseNames.every(phase => exact(rotation.configuration[phase], ["sha256", "privateRef"]) &&
      digest(rotation.configuration[phase].sha256) && typeof rotation.configuration[phase].privateRef === "string") &&
    epoch(rotation.initialEpoch) && epoch(rotation.finalEpoch) && BigInt(rotation.finalEpoch) === BigInt(rotation.initialEpoch) + 6n &&
    equal(rotation.authenticationWindows, ["overlap", "current-only", "post-removal"].map((phase, index) => {
      const before = BigInt(rotation.initialEpoch) + BigInt(index * 2);
      return { phase, beforeEpoch: String(before), openEpoch: String(before + 1n), closedEpoch: String(before + 2n) };
    })));

  demand(custody.version === 2 && custody.mode === "p2-bounded-certification-profiled-current" &&
    custody.certificationActionId === actionId && custody.hostMachineId === host.machineId && custody.bundle === host.bundle &&
    custody.results === host.results && equal(custody.candidate, migration.candidate) &&
    equal(custody.frontendJob, migration.job) && equal(custody.frontendBaseline, migration.baseline) &&
    equal(custody.configurationSha256, release.configurationSha256) && equal(custody.apiJobSha256, release.apiJobSha256) &&
    equal(custody.inventory, inventory) && custody.inventorySha256 === release.inventorySha256 &&
    equal(custody.owner, inventory.owner) && equal(custody.certification, release.certification) &&
    equal(custody.expectedWriterAdmissionBinding, release.writerAdmissionBinding) &&
    bytes(custody.originalReleaseReceipt).equals(originalReleaseReceipt));
  const source = Object.entries(custody.sourceSha256);
  demand(source.length > 0 && source.length <= 544 && source.every(([name, sha]) => /^ops\/[a-zA-Z0-9_./-]+$/u.test(name) && digest(sha)) &&
    ["ops/platform/p2-certification-current-probe.mjs", "ops/platform/p2-identity-key-rotation-replacement.mjs"]
      .every(path => Object.hasOwn(custody.sourceSha256, path)) &&
    custody.sourceClosureSha256 === hash(JSON.stringify(source.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) &&
    custody.sourceClosureSha256 === prior.operatorSourceClosureSha256 &&
    custody.sourceClosureSha256 === rotation.operatorSourceClosureSha256 &&
    custody.sourceClosureSha256 === input.operatorSourceClosureSha256);
  demand(prior.version === 2 && prior.mode === "contain-native" && prior.startState === "already-closed" &&
    prior.certificationActionId === actionId && prior.originalReleaseId === release.releaseId &&
    prior.operatorSourceCommit === release.sourceCommit && prior.initialEpoch === rotation.initialEpoch &&
    prior.planSha256 === hashWithout(prior, "planSha256") && prior.planSha256 === rotation.frontendCustodyPlanSha256 &&
    prior.candidateObjectSha256 === hash(migration.candidate) && prior.candidateObjectSha256 === rotation.candidateObjectSha256 &&
    prior.configurationSha256 === frontendCoordinationHash(release.configurationSha256) &&
    prior.configurationCanonicalSha256 === hash(release.configurationSha256) &&
    prior.gatewayConfigurationSha256 === release.configurationSha256["gateway.json"] &&
    prior.inventorySha256 === release.inventorySha256 && equal(prior.apiJobSha256, release.apiJobSha256) &&
    equal(prior.replacementRelease, profiledRelease.replacementRelease) &&
    prior.originalReleaseReceiptSha256 === profiledRelease.receiptSha256 && prior.originalReleasePlanSha256 === profiledRelease.planSha256 &&
    [prior.gatewayProcessSha256, prior.runtimeInventorySha256].every(digest) &&
    ["frontendSqlReplay", "apiSqlReplay", "rolePreparationAllowed", "historicalLoginRestorationAllowed",
      "buildAllowed", "promotionAllowed", "wholeReleaseAccepted"].every(key => prior[key] === false));
  demand(native.planSha256 === hashWithout(native, "planSha256") && native.planSha256 === rotation.nativePlanSha256 &&
    native.deploymentId === originalTerminal.deploymentId &&
    native.configurationRecordSha256 === originalTerminal.frontendWorkloadReceiptSha256 &&
    equal(native.featureControls, release.certification.featureControls) && equal(native.featureControls, rotation.featureControls) &&
    equal(native.writerAdmissionBinding, release.writerAdmissionBinding) && equal(native.writerAdmissionBinding, rotation.writerAdmissionBinding) &&
    equal(native.owner, inventory.owner) && runtimeProducers.length === 1 && equal(native.producer, runtimeProducers[0]) &&
    equal(prior.readyReceiptSha256, rotation.readyReceiptSha256) &&
    prior.readyReceiptSha256["frontend-workload-outcome.json"] === originalTerminal.frontendWorkloadReceiptSha256 &&
    prior.readyReceiptSha256["frontend-promotion-outcome.json"] === originalTerminal.frontendPromotionReceiptSha256);
  const originalReady = readyBytes(custody.readyReceipts, prior.readyReceiptSha256, readyNames);
  demand(readyNames.every(name => readFrontendReleaseEvidence(checked.frontendReceipts, name).equals(originalReady.get(name))));

  const previous = prior.successorRuntime;
  let predecessor;
  if (Object.hasOwn(prior, "successorRuntime")) {
    const receiptFile = join(results, previous.actionId, "p2-replacement-successor-runtime.json");
    predecessor = prepareP2ReplacementSuccessor({ receiptFile, receiptSha256: previous.receiptSha256 },
      { original: checked.original, profiledRelease, host, results, input: { ...prior, native } });
    demand(equal(predecessor.binding, previous) && ![previous.actionId, previous.runtimeActionId].includes(input.certificationActionId));
  }
  demand(custody.configuration === (predecessor?.configuration ?? host.configuration) &&
    !Object.hasOwn(prior, "rotationSuccessor"));
  demand(exact(joined, joinedFields) && joined.version === 2 && joined.environment === "staging" &&
    joined.status === "P2_IDENTITY_KEY_ROTATION_QUALIFIED" && joined.keyRemovalVerified === true &&
    joined.sourceParentDispatchIntegrated === true && equal(pick(joined, identityFields), pick(rotation, identityFields)) &&
    joined.frontendCustodyPlanSha256 === prior.planSha256 && joined.frontendFinalEpoch === rotation.finalEpoch &&
    joined.configurationSha256 === rotation.configuration["current-only"].sha256 && joinedFalse.every(key => joined[key] === false) &&
    equal(joined.profileEvidenceClass, profileClasses) && exact(joined.profileReceiptSha256, Object.keys(profileClasses)) &&
    Object.values(joined.profileReceiptSha256).every(hashes => exact(hashes, ["overlap", "current-only"]) && Object.values(hashes).every(digest)) &&
    exact(joined.frontendSignerReceiptSha256, ["overlap", "current-only", "post-removal"]) &&
    Object.values(joined.frontendSignerReceiptSha256).every(digest));
  return { prior, native, originalReady, predecessor };
}

/** Pure local join. The immutable host copy and mixed runtime must be verified independently before an action can run. */
export function prepareP2CertificationRotationSuccessor(selection, checked, input, results, readyNames) {
  try {
    demand(exact(selection, ["actionId", "receiptSha256"]) && rotationAction(selection.actionId) &&
      digest(selection.receiptSha256) && ![checked.original.plan.releaseId, input.certificationActionId].includes(selection.actionId));
    frontendPrivateReceiptDirectory(results);
    const directory = join(results, selection.actionId);
    const read = name => decode(readFrontendReleaseEvidence(directory, name), "carrier");
    const rotation = read("reviewed-plan.json"), custody = read("frontend-custody.json"), joined = read("host-rotation-joined.json");
    const { prior, native, originalReady, predecessor } =
      reviewedRotation(rotation, custody, joined, checked, input, results, selection.actionId, readyNames);
    const wrapper = read("managed-rotation-successor-evidence.json");
    demand(exact(wrapper, ["receiptSha256", "originalBytesBase64", "terminalReceiptSha256"]) && wrapper.receiptSha256 === selection.receiptSha256);
    const raw = bytes(wrapper.originalBytesBase64);
    demand(hash(raw) === selection.receiptSha256);
    const receipt = decode(raw, "carrier");
    requireQualificationTargetProfile(profile, receipt);
    const hasPredecessor = Boolean(predecessor);
    demand(exact(receipt, [...receiptFields, ...(hasPredecessor ? ["predecessorSuccessorReceiptSha256"] : [])]) &&
      receipt.version === 2 && receipt.environment === "staging" &&
      receipt.status === "P2_IDENTITY_ROTATION_MIXED_SUCCESSOR_RUNTIME_VERIFIED" && receipt.kind === rotationSuccessorKind &&
      equal(pick(receipt, identityFields), pick(rotation, identityFields)) && receipt.releaseId === rotation.originalReleaseId &&
      receipt.hostMachineId === rotation.hostMachineId && receipt.targetSha256 === rotation.targetSha256 &&
      receipt.originalReleasePlanSha256 === prior.originalReleasePlanSha256 && receipt.originalReleaseReceiptSha256 === prior.originalReleaseReceiptSha256 &&
      hashFields.every(key => digest(receipt[key])) &&
      receipt.terminalReceiptSha256 === wrapper.terminalReceiptSha256 && receipt.frontendSessionClosedSha256 === joined.frontendSessionCloseReceiptSha256 &&
      receipt.configurationSha256 === joined.configurationSha256 &&
      receipt.predecessorRuntimeInventorySha256 === prior.runtimeInventorySha256 &&
      (!hasPredecessor || receipt.predecessorSuccessorReceiptSha256 === predecessor.binding.receiptSha256) &&
      receipt.gatewayProcessSha256 === prior.gatewayProcessSha256 && receipt.gatewayProcessSha256 === input.gatewayProcessSha256 &&
      receipt.gatewayConfigurationSha256 === prior.gatewayConfigurationSha256 && receipt.gatewayConfigurationSha256 === input.gatewayConfigurationSha256 &&
      receipt.runtimeInventorySha256 === input.runtimeInventorySha256 && receipt.runtimeInventorySha256 !== prior.runtimeInventorySha256 &&
      receipt.frontendEpoch === rotation.finalEpoch && epoch(input.initialEpoch) && BigInt(input.initialEpoch) >= BigInt(receipt.frontendEpoch) &&
      equal(receipt.unchangedOriginalServices, unchangedServices) && equal(receipt.currentOnlyRecreatedServices, ["course-api", "community-api"]) &&
      receipt.frontendAdmissionClosed === true && receipt.gatewayAdmissionClosed === true &&
      terminalFlags.every(key => receipt[key] === false));
    demand(exact(receipt.phaseRuntimeInventoryReceiptSha256, phaseNames) &&
      Object.values(receipt.phaseRuntimeInventoryReceiptSha256).every(digest) &&
      Array.isArray(receipt.mutationReceipts) && receipt.mutationReceipts.length === mutationOrder.length &&
      receipt.mutationReceipts.every((row, index) => exact(row, ["phase", "kind", "attemptReceiptSha256", "observationReceiptSha256"]) &&
        equal([row.phase, row.kind], mutationOrder[index]) && digest(row.attemptReceiptSha256) && digest(row.observationReceiptSha256)));
    const { frontend } = receipt;
    demand(exact(frontend, ["deploymentId", "deploymentUrl", "readyReceiptSha256", "postRemovalSignerReceiptSha256"]) &&
      /^dpl_[A-Za-z0-9]+$/u.test(frontend.deploymentId) && frontend.deploymentId !== native.deploymentId &&
      /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(frontend.deploymentUrl) && frontend.deploymentUrl !== native.deploymentUrl &&
      digest(frontend.postRemovalSignerReceiptSha256) && frontend.postRemovalSignerReceiptSha256 === joined.frontendSignerReceiptSha256?.["post-removal"] &&
      input.native.deploymentId === frontend.deploymentId && input.native.deploymentUrl === frontend.deploymentUrl &&
      input.native.configurationRecordSha256 === frontend.readyReceiptSha256["frontend-workload-outcome.json"] &&
      equal(input.readyReceiptSha256, frontend.readyReceiptSha256));
    const ready = read("managed-rotation-frontend-ready.json");
    demand(exact(ready, ["successorReceiptSha256", "originalBytesBase64"]) && ready.successorReceiptSha256 === selection.receiptSha256);
    return {
      binding: { kind: rotationSuccessorKind, actionId: selection.actionId, bindingSha256: rotation.bindingSha256,
        receiptSha256: selection.receiptSha256, ...(predecessor ? { predecessorRuntime: predecessor.binding } : {}) },
      configuration: custody.configuration,
      originalFrontendReady: { ...pick(native, ["deploymentId", "deploymentUrl"]), readyReceiptSha256: prior.readyReceiptSha256 },
      originalReady, currentReady: readyBytes(ready.originalBytesBase64, frontend.readyReceiptSha256, readyNames),
      rawReceiptBase64: wrapper.originalBytesBase64,
    };
  } catch { throw new Error(refusal); }
}
