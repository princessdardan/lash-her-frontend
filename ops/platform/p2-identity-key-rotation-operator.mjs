#!/usr/bin/env node
// Source-owned plan/apply composition for the fixed staging identity rotation.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareP2RecoveryOperator } from "./p2-recovery.mjs";
import { bindP2CertificationReadyReceipts, P2_CERTIFICATION_READY_FILES } from "./p2-certification.mjs";
import { P2_LIFECYCLE_NATIVE_SCHEDULE, p2NativeHash } from "./p2-lifecycle-native.mjs";
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { githubSourceApi } from "./release-inputs.mjs";
import { recreationSsh } from "./recreation_ssh.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { writeFrontendReceipt } from "./frontend-migration.mjs";
import { frontendCoordinationHash } from "./frontend-release-inventory.mjs";
import { P2_IDENTITY_ROTATION_PARENT, prepareP2IdentityRotationParent, prepareP2ManagedIdentityRotationParent, runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";
import { p2IdentityRotationEnvironmentLock } from "./p2-identity-key-rotation-transport.mjs";
import { prepareP2IdentityRotationReplacementLease, readP2IdentityRotationReplacementCustody,
  readP2IdentityRotationReplacementHostReview, readP2IdentityRotationReplacementTransportSettings } from "./p2-identity-key-rotation-replacement.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile, resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_OPERATOR_REFUSED"); };
const SHA = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const managedSelections = new WeakMap();
const reviewedManagedTransports = new WeakSet();
const gatewayHostname = new URL(resolveQualificationTargetProfile(profile).gateway.publicOrigin).hostname;
const credentialNames = ["FRONTEND_STAGING_MIGRATION_DATABASE_URL", "COURSE_STAGING_DATABASE_URL", "COMMUNITY_STAGING_DATABASE_URL"];
const phases = ["baseline", "overlap", "current-only"];
const profiles = ["course-learner", "course-admin", "community-member", "community-admin"];
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = value => createHash("sha256").update(Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join();
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function privateBytes(path, maximum = 24_000_000) {
  demand(typeof path === "string" && resolve(path) === path && realpathSync(path) === path);
  frontendPrivateReceiptDirectory(dirname(path));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = fstatSync(descriptor); demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0
      && info.size > 0 && info.size <= maximum); const bytes = readFileSync(descriptor); demand(bytes.length === info.size); return bytes; }
  finally { closeSync(descriptor); }
}
function privateObject(path, maximum) { const value = JSON.parse(privateBytes(path, maximum)); demand(value && typeof value === "object" && !Array.isArray(value)); return value; }

export function isReviewedManagedIdentityRotationTransport(transport) {
  return reviewedManagedTransports.has(transport);
}

function embeddedRotationProgramSha256(sourceRoot) {
  const script = "import hashlib,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import p2_identity_key_rotation as p;print(hashlib.sha256(p.private_program(Path(sys.argv[2]))).hexdigest())";
  const value = execFileSync("python3", ["-I", "-c", script, join(sourceRoot, "ops/platform/host"), sourceRoot],
    { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  demand(SHA.test(value)); return value;
}

export function prepareP2IdentityRotationOperator(settings) {
  demand(settings?.version === 1 && settings.environment === "staging" && COMMIT.test(settings.operatorSourceCommit ?? ""));
  return prepareP2IdentityRotationPlanFromChecked(settings, prepareP2RecoveryOperator(settings));
}

export function prepareP2ManagedIdentityRotationOperator(settings) {
  demand(exact(settings, ["version", "qualificationTargetProfile", "environment", "operatorSourceCommit",
    "replacementLease", "rotationConfiguration", "rotation"])
    && settings.version === 2 && settings.environment === "staging" && COMMIT.test(settings.operatorSourceCommit ?? ""));
  requireQualificationTargetProfile(profile, settings);
  const lease = prepareP2IdentityRotationReplacementLease(settings.replacementLease);
  demand(lease.plan.sourceCommit === settings.operatorSourceCommit);
  const committed = readP2IdentityRotationOperatorSource(root, settings.operatorSourceCommit);
  return bindP2ManagedIdentityRotationPlan(lease, committed.files, settings.rotationConfiguration, settings.rotation);
}

export function bindP2ManagedIdentityRotationPlan(lease, sourceFiles, rotationConfiguration, rotation) {
  const hostReview = readP2IdentityRotationReplacementHostReview(lease, sourceFiles);
  const { plan: custody, host } = lease;
  const native = custody.frontendPlan.nativePlan;
  demand(exact(rotation, ["actionId", "courseId", "subjects",
    "configuration", "privateConfigurationSha256"]) && rotation.actionId === custody.actionId && UUID.test(rotation.courseId)
    && exact(rotation.subjects, profiles) && Object.values(rotation.subjects).every(value => UUID.test(value))
    && new Set(Object.values(rotation.subjects)).size === profiles.length
    && exact(rotation.configuration, phases) && exact(rotation.privateConfigurationSha256, phases)
    && custody.authenticationWindows.map(window => window.phase).join() === "overlap,current-only,post-removal"
    && typeof rotationConfiguration === "string" && resolve(rotationConfiguration) === rotationConfiguration
    && rotationConfiguration.startsWith("/var/lib/lash-her/releases/staging/") && !rotationConfiguration.includes(","));
  for (const phase of phases) {
    const value = rotation.configuration[phase];
    demand(exact(value, ["sha256", "privateRef"]) && SHA.test(value.sha256) && !/^0+$/u.test(value.sha256)
      && value.privateRef === join(rotationConfiguration, phase) && SHA.test(rotation.privateConfigurationSha256[phase])
      && !/^0+$/u.test(rotation.privateConfigurationSha256[phase]) && value.sha256 !== rotation.privateConfigurationSha256[phase]);
  }
  demand(new Set(phases.map(phase => rotation.configuration[phase].sha256)).size === phases.length
    && new Set(Object.values(rotation.privateConfigurationSha256)).size === phases.length);
  const base = { version: 2, qualificationTargetProfile: profile, environment: "staging",
    status: "P2_IDENTITY_ROTATION_MANAGED_PLANNED", actionId: custody.actionId, candidateSha256: custody.candidateSha256,
    hostMachineId: host.machineId, sourceCommit: custody.sourceCommit, originalReleaseId: custody.frontendPlan.originalReleaseId,
    courseId: rotation.courseId, subjects: structuredClone(rotation.subjects), configuration: structuredClone(rotation.configuration),
    featureControls: structuredClone(native.featureControls), writerAdmissionBinding: structuredClone(native.writerAdmissionBinding),
    targetSha256: custody.targetSha256, operatorSourceClosureSha256: hostReview.sourceClosureSha256,
    candidateObjectSha256: custody.frontendPlan.candidateObjectSha256,
    replacementLeasePlanSha256: custody.planSha256, frontendCustodyPlanSha256: custody.frontendPlan.planSha256,
    readyReceiptSha256: structuredClone(custody.frontendPlan.readyReceiptSha256), nativePlanSha256: native.planSha256,
    initialEpoch: custody.initialEpoch, finalEpoch: custody.finalEpoch, authenticationWindows: structuredClone(custody.authenticationWindows),
    sqlAuthorized: false, rolePreparationAuthorized: false, loginChangeAuthorized: false, trafficAuthorized: false,
    communityMemberFeatureAdded: false, newPublicEndpoint: false, keyRemovalVerified: false, releaseAccepted: false, liveEligible: false };
  const selected = Object.freeze({ plan: freeze({ ...base, bindingSha256: p2NativeHash(base) }), lease, hostReview });
  managedSelections.set(selected, freeze({ rotationConfiguration,
    privateRotationConfigurationSha256: structuredClone(rotation.privateConfigurationSha256) }));
  return selected;
}

export function prepareP2IdentityRotationPlanFromChecked(settings, checked, bindReady = bindP2CertificationReadyReceipts) {
  demand(settings?.version === 1 && settings.environment === "staging" && COMMIT.test(settings.operatorSourceCommit ?? "")
    && typeof bindReady === "function");
  const rotation = settings.rotation;
  demand(checked.action.recoveryActionId === rotation?.actionId && checked.action.sourceCommit === settings.operatorSourceCommit
    && checked.original.candidate.sources.frontend.commit === settings.operatorSourceCommit
    && exact(rotation, ["actionId", "courseId", "subjects", "configuration", "privateConfigurationSha256", "baseline", "readyReceiptSha256"])
    && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(rotation.actionId) && UUID.test(rotation.courseId)
    && exact(rotation.baseline, ["deploymentId", "deploymentUrl", "configurationRecordSha256"])
    && exact(rotation.subjects, profiles) && Object.values(rotation.subjects).every(value => UUID.test(value))
    && exact(rotation.configuration, phases) && exact(rotation.privateConfigurationSha256, phases));
  for (const phase of phases) {
    const value = rotation.configuration[phase];
    demand(exact(value, ["sha256", "privateRef"]) && SHA.test(value.sha256)
      && typeof value.privateRef === "string" && value.privateRef === `${settings.host.rotationConfiguration}/${phase}`
      && SHA.test(rotation.privateConfigurationSha256[phase]) && value.sha256 !== rotation.privateConfigurationSha256[phase]);
  }
  const candidate = checked.original.candidate, inventory = checked.prepared.plan, job = checked.original.job;
  const featureControls = inventory.certification.featureControls, writerAdmissionBinding = checked.original.plan.writerAdmissionBinding;
  const nativePlan = freeze({ version: 1, purpose: "identity-key-rotation-browser-origin-control", environment: "staging",
    actionId: candidate.releaseId, sourceCommit: job.sourceCommit, projectId: candidate.workload.projectId,
    phase2ContractManifestSha256: candidate.phase2ContractManifestSha256,
    deploymentId: rotation.baseline.deploymentId, deploymentUrl: rotation.baseline.deploymentUrl,
    configurationRecordSha256: rotation.baseline.configurationRecordSha256, targetSha256: inventory.targetSha256,
    target: structuredClone(job.target), owner: structuredClone(inventory.owner), featureControls: structuredClone(featureControls),
    writerAdmissionBinding: structuredClone(writerAdmissionBinding), schedule: P2_LIFECYCLE_NATIVE_SCHEDULE,
    finalDisposition: "disabled-and-admission-closed" });
  demand(/^dpl_[A-Za-z0-9]+$/u.test(nativePlan.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(nativePlan.deploymentUrl)
    && SHA.test(nativePlan.configurationRecordSha256) && exact(rotation.readyReceiptSha256,
      ["frontend-build-started.json", "frontend-build-created.json", "frontend-build-outcome.json", "frontend-workload-outcome.json", "frontend-promotion-started.json", "frontend-promotion-outcome.json"])
    && Object.values(rotation.readyReceiptSha256).every(value => SHA.test(value)));
  bindReady(settings.frontendReceipts, { candidate, originalReleaseId: candidate.releaseId,
    sourceCommit: job.sourceCommit, readyReceiptSha256: rotation.readyReceiptSha256, nativePlan });
  const base = { version: 1, environment: "staging", actionId: rotation.actionId, candidateSha256: checked.action.candidateSha256,
    hostMachineId: settings.host.machineId, sourceCommit: job.sourceCommit, originalReleaseId: candidate.releaseId,
    courseId: rotation.courseId, subjects: structuredClone(rotation.subjects), configuration: structuredClone(rotation.configuration),
    featureControls: structuredClone(featureControls), writerAdmissionBinding: structuredClone(writerAdmissionBinding),
    nativePlanSha256: hash(nativePlan), recoveryActionSha256: hash(checked.action), readyReceiptSha256: structuredClone(rotation.readyReceiptSha256),
    sqlAuthorized: false, rolePreparationAuthorized: false, loginChangeAuthorized: false, trafficAuthorized: false,
    communityMemberFeatureAdded: false, newPublicEndpoint: false, releaseAccepted: false };
  const plan = freeze({ ...base, bindingSha256: hash(base) });
  return { plan, nativePlan, checked };
}

export function prepareP2IdentityRotationDispatch(settings, selected, initial, dependencies) {
  const reviewed = selected.plan;
  const plan = prepareP2IdentityRotationParent(reviewed, selected.checked.prepared, selected.checked.action,
    { sourceCommit: reviewed.sourceCommit, candidateSha256: reviewed.candidateSha256, bindingSha256: reviewed.bindingSha256,
      configuration: reviewed.configuration, featureControls: reviewed.featureControls, writerAdmissionBinding: reviewed.writerAdmissionBinding },
    { ...dependencies, resultsDirectory: settings.results });
  const transport = p2IdentityRotationEnvironmentLock(settings, { ...initial, rotationPlan: plan });
  return Object.freeze({ plan, transport });
}

/** Bind one opaque transport and retain only reviewed bytes and noncredential inputs. */
export function prepareP2ManagedIdentityRotationDispatch(selected, privateInputs, dependencies, transportOptions = {}) {
  const configuration = managedSelections.get(selected);
  demand(configuration &&
    exact(privateInputs, ["credentials", "vercelToken", "scopedCronSecret", "gatewayHost", "operatorProgramSha256", "rotationBrowserProgramSha256"]) &&
    exact(privateInputs.credentials, credentialNames) &&
    Object.values(privateInputs.credentials).every(value => typeof value === "string" && value.length > 0 && value.length <= 16_384) &&
    typeof privateInputs.vercelToken === "string" && /^[!-~]{1,8192}$/u.test(privateInputs.vercelToken) &&
    typeof privateInputs.scopedCronSecret === "string" && /^[!-~]{32,8192}$/u.test(privateInputs.scopedCronSecret) &&
    privateInputs.gatewayHost === gatewayHostname &&
    [privateInputs.operatorProgramSha256, privateInputs.rotationBrowserProgramSha256].every(value => SHA.test(value) && !/^0+$/u.test(value)) &&
    exact(dependencies, ["verifyEnvironment"]) && typeof dependencies.verifyEnvironment === "function");
  const { plan: reviewed, lease, hostReview } = selected;
  const settings = readP2IdentityRotationReplacementTransportSettings(lease);
  const input = freeze(structuredClone(privateInputs));
  const custody = readP2IdentityRotationReplacementCustody(lease);
  const privateInputBindings = freeze({ version: 2, qualificationTargetProfile: profile, environment: "staging",
    actionId: reviewed.actionId, bindingSha256: reviewed.bindingSha256, ...configuration,
    gatewayHost: input.gatewayHost, operatorProgramSha256: input.operatorProgramSha256,
    rotationBrowserProgramSha256: input.rotationBrowserProgramSha256,
    successorReceipt: custody.successorReceipt ?? null });
  const getUrl = () => input.credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL;
  const plan = prepareP2ManagedIdentityRotationParent(reviewed, lease, hostReview, privateInputBindings,
    { getUrl, verifyEnvironment: dependencies.verifyEnvironment, resultsDirectory: settings.results });
  const shared = ["qualificationTargetProfile", "environment", "sourceCommit", "sourceSha256", "sourceClosureSha256", "hostMachineId",
    "bundle", "configuration", "results", "candidate", "candidateSha256", "configurationSha256", "certification", "targetSha256", "owner"];
  const nativePlan = hostReview.certificationPlan.nativePlan;
  const initial = { version: 2, mode: "p2-identity-key-rotation",
    ...Object.fromEntries(shared.map(key => [key, hostReview[key]])),
    rotationActionId: plan.actionId, rotationPlan: plan, frontendCustody: hostReview, confirmation: `staging/${plan.actionId}`,
    ...input, ...configuration, nativePlan, baselineConfigurationRecordSha256: nativePlan.configurationRecordSha256,
    expectedFeatureControls: plan.featureControls, expectedWriterAdmissionBinding: plan.writerAdmissionBinding,
    producers: hostReview.inventory.producers };
  const transport = p2IdentityRotationEnvironmentLock(settings, initial, transportOptions);
  frontendPrivateReceiptDirectory(settings.results);
  const directory = join(settings.results, plan.actionId);
  demand(lstatSync(directory, { throwIfNoEntry: false }) === undefined);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "controller"), { mode: 0o700 });
  for (const [name, value] of [["reviewed-plan.json", plan], ["frontend-custody.json", hostReview],
    ["private-input-bindings.json", privateInputBindings]]) {
    writeFrontendReceipt(directory, name, JSON.parse(canonical(value)));
  }
  return Object.freeze({ plan, transport, directory });
}

export function readP2IdentityRotationOperatorSource(sourceRoot, sourceCommit) {
  const committed = committedProfiledCurrentOperatorSource(sourceRoot, sourceCommit);
  const sourceSha256 = Object.fromEntries(committed.files.map(file => [file.path, file.sha256]));
  // The Linux supervisor hashes Python's sorted path pairs.
  demand(Object.keys(sourceSha256).every(path => /^[\x20-\x7e]+$/u.test(path)));
  const sourceClosureSha256 = hash(Object.entries(sourceSha256).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { ...committed, sourceSha256, sourceClosureSha256 };
}

function decodeRotationEvidenceBytes(encoded, maximum = 65_536) {
  demand(typeof encoded === "string" && encoded.length <= Math.ceil(maximum / 3) * 4);
  const raw = Buffer.from(encoded, "base64");
  demand(raw.length > 0 && raw.length <= maximum && raw.toString("base64") === encoded);
  return raw;
}

export function validateP2ManagedRotationSuccessorEvidence(response, plan, joined) {
  demand(exact(response, ["bytes"]));
  const raw = decodeRotationEvidenceBytes(response.bytes);
  demand(raw.at(-1) === 10);
  const receipt = decodeQualificationTargetJson(raw, "carrier");
  requireQualificationTargetProfile(profile, plan, joined, receipt);
  const identity = ["actionId", "bindingSha256", "sourceCommit", "candidateSha256"];
  const frontend = receipt.frontend;
  demand(exact(frontend, ["deploymentId", "deploymentUrl", "readyReceiptSha256", "postRemovalSignerReceiptSha256"])
    && typeof frontend.deploymentId === "string" && /^dpl_[A-Za-z0-9]+$/u.test(frontend.deploymentId)
    && typeof frontend.deploymentUrl === "string" && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(frontend.deploymentUrl)
    && exact(frontend.readyReceiptSha256, P2_CERTIFICATION_READY_FILES)
    && Object.values(frontend.readyReceiptSha256).every(value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value))
    && typeof frontend.postRemovalSignerReceiptSha256 === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(frontend.postRemovalSignerReceiptSha256)
    && frontend.postRemovalSignerReceiptSha256 === joined.frontendSignerReceiptSha256?.["post-removal"]);
  demand(receipt.version === 2 && receipt.environment === "staging"
    && receipt.status === "P2_IDENTITY_ROTATION_MIXED_SUCCESSOR_RUNTIME_VERIFIED"
    && receipt.kind === "identity-key-rotation-mixed-mount-v1"
    && joined.status === "P2_IDENTITY_KEY_ROTATION_QUALIFIED" && joined.keyRemovalVerified === true
    && identity.every(key => receipt[key] === plan[key] && joined[key] === plan[key])
    && receipt.releaseId === plan.originalReleaseId && receipt.hostMachineId === plan.hostMachineId
    && receipt.targetSha256 === plan.targetSha256 && receipt.frontendEpoch === plan.finalEpoch && joined.frontendFinalEpoch === plan.finalEpoch
    && receipt.configurationSha256 === plan.configuration["current-only"].sha256
    && typeof receipt.currentOnlyRuntimeConfigurationSha256 === "string"
    && /^(?!0+$)[a-f0-9]{64}$/u.test(receipt.currentOnlyRuntimeConfigurationSha256)
    && receipt.frontendSessionClosedSha256 === joined.frontendSessionCloseReceiptSha256
    && ["terminalReceiptSha256", "runtimeInventorySha256", "frontendSessionClosedSha256"].every(key => SHA.test(receipt[key] ?? ""))
    && receipt.frontendAdmissionClosed === true && receipt.gatewayAdmissionClosed === true
    && ["nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted", "g2Accepted"].every(key => receipt[key] === false));
  return freeze({ receiptSha256: hash(raw), originalBytesBase64: response.bytes, terminalReceiptSha256: receipt.terminalReceiptSha256 });
}

export function validateP2ManagedRotationFrontendReady(response, evidence) {
  demand(exact(response, ["bytes"]));
  const successorRaw = decodeRotationEvidenceBytes(evidence.originalBytesBase64);
  demand(hash(successorRaw) === evidence.receiptSha256);
  const { frontend } = decodeQualificationTargetJson(successorRaw, "carrier");
  const raw = decodeRotationEvidenceBytes(response.bytes, P2_CERTIFICATION_READY_FILES.length * 87_384 + 4096);
  const originalBytesBase64 = decodeQualificationTargetJson(raw, "carrier");
  demand(exact(originalBytesBase64, P2_CERTIFICATION_READY_FILES) && exact(frontend?.readyReceiptSha256, P2_CERTIFICATION_READY_FILES));
  for (const name of P2_CERTIFICATION_READY_FILES) {
    const receipt = decodeRotationEvidenceBytes(originalBytesBase64[name]);
    demand(receipt.at(-1) === 10 && hash(receipt) === frontend.readyReceiptSha256[name]);
  }
  return freeze({ successorReceiptSha256: evidence.receiptSha256, originalBytesBase64 });
}

export async function p2IdentityRotationOperator(settings, { apply = false, confirmation } = {}) {
  const managed = settings?.version === 2;
  if (apply && !(managed ? P2_IDENTITY_ROTATION_PARENT.managedLiveEligible : P2_IDENTITY_ROTATION_PARENT.liveEligible))
    throw new Error("P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED");
  demand(process.versions.node.split(".")[0] === "24");
  if (managed) {
    const selected = prepareP2ManagedIdentityRotationOperator(settings);
    if (!apply) return selected.plan;
    demand(confirmation === `staging/${selected.plan.actionId}`);
    const committed = readP2IdentityRotationOperatorSource(root, settings.operatorSourceCommit);
    demand(committed.sourceClosureSha256 === selected.plan.operatorSourceClosureSha256);
    const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN), sourceCommit: settings.operatorSourceCommit,
      branch: committed.branch, workflowBytes: committed.workflowBytes });
    const { arm, providerContext } = settings.replacementLease.releaseSettings;
    const provider = decodeQualificationTargetJson(privateBytes(providerContext), "private-packet");
    requireQualificationTargetProfile(profile, provider);
    demand(exact(provider, ["version", "qualificationTargetProfile", "vercelToken", "bindings"]) && provider.version === 2 &&
      frontendCoordinationHash(provider.bindings?.gatewayObservation) === selected.hostReview.inventory.restoration.gatewayBindingSha256);
    const credentials = Object.fromEntries(credentialNames.map(key => [key, process.env[key]]));
    const browserBytes = readFileSync(join(root, "ops/platform/p2-identity-key-rotation-browser-recorder.mjs"));
    const dispatch = prepareP2ManagedIdentityRotationDispatch(selected,
      { credentials, vercelToken: provider.vercelToken, scopedCronSecret: process.env.FRONTEND_STAGING_CRON_SECRET,
        gatewayHost: gatewayHostname, operatorProgramSha256: embeddedRotationProgramSha256(root),
        rotationBrowserProgramSha256: hash(Buffer.concat([browserBytes, Buffer.from("\nawait runP2IdentityRotationBrowserChild();\n")])) },
      { verifyEnvironment: () => {
        demand(readP2IdentityRotationOperatorSource(root, settings.operatorSourceCommit).sourceClosureSha256 === committed.sourceClosureSha256);
      } });
    writeFrontendReceipt(dispatch.directory, "operator-source-ci.json", ci);
    const diagnostics = join(dispatch.directory, "ssh");
    mkdirSync(diagnostics, { mode: 0o700 });
    const ssh = await recreationSsh({ knownHosts: arm.knownHosts, keyFile: arm.sshKey, diagnostics });
    demand((await ssh.machine()).machineId === selected.plan.hostMachineId);
    const installed = await ssh.installProfiledCurrentSource({ commit: settings.operatorSourceCommit, files: committed.files });
    demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === settings.operatorSourceCommit);
    reviewedManagedTransports.add(dispatch.transport);
    let joined;
    try {
      joined = await runP2IdentityRotationParent(dispatch.plan, { confirmation, transport: dispatch.transport });
    } finally {
      reviewedManagedTransports.delete(dispatch.transport);
    }
    const frontend = selected.lease.plan.frontendPlan;
    const evidenceRequest = {
      version: 1, qualificationTargetProfile: profile, environment: "staging",
      results: selected.hostReview.results, releaseId: selected.plan.originalReleaseId, actionId: selected.plan.actionId,
      sourceCommit: selected.plan.sourceCommit, candidateSha256: selected.plan.candidateSha256, bindingSha256: selected.plan.bindingSha256,
      originalReleasePlanSha256: frontend.originalReleasePlanSha256, originalReleaseReceiptSha256: frontend.originalReleaseReceiptSha256,
    };
    const mixed = await ssh.replacementEvidence(settings.operatorSourceCommit, {
      ...evidenceRequest, operation: "read-identity-rotation-successor",
    });
    const evidence = validateP2ManagedRotationSuccessorEvidence(mixed, selected.plan, joined);
    writeFrontendReceipt(dispatch.directory, "managed-rotation-successor-evidence.json", evidence);
    const ready = await ssh.replacementEvidence(settings.operatorSourceCommit, {
      ...evidenceRequest, operation: "read-identity-rotation-frontend-ready", successorReceiptSha256: evidence.receiptSha256,
    });
    const readyEvidence = validateP2ManagedRotationFrontendReady(ready, evidence);
    writeFrontendReceipt(dispatch.directory, "managed-rotation-frontend-ready.json", readyEvidence);
    return freeze({ ...joined, mixedSuccessorReceiptSha256: evidence.receiptSha256, hostTerminalReceiptSha256: evidence.terminalReceiptSha256 });
  }
  const selected = prepareP2IdentityRotationOperator(settings);
  if (!apply) return selected.plan;
  demand(confirmation === `staging/${selected.plan.actionId}`);
  const committed = readP2IdentityRotationOperatorSource(root, settings.operatorSourceCommit);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN), sourceCommit: settings.operatorSourceCommit,
    branch: committed.branch, workflowBytes: committed.workflowBytes });
  const { sourceSha256, sourceClosureSha256 } = committed;
  const context = privateObject(settings.providerContext);
  demand(typeof context.vercelToken === "string" && context.vercelToken.length > 0 && context.vercelToken.length <= 8192
    && typeof context.privateConfigurationDirectory === "string" && typeof context.gatewayHost === "string"
    && context.bindings?.gatewayHost === context.gatewayHost
    && frontendCoordinationHash(context.bindings?.gatewayObservation) === selected.checked.prepared.plan.restoration.gatewayBindingSha256);
  const privateProbe = privateObject(join(context.privateConfigurationDirectory, "frontend-probe-private.json"), 8192);
  demand(privateProbe.environment === "staging" && privateProbe.projectId === selected.nativePlan.projectId
    && privateProbe.sourceCommit === selected.nativePlan.sourceCommit && privateProbe.releaseId === selected.nativePlan.actionId
    && Number.isSafeInteger(privateProbe.expiresAt) && Date.now() < privateProbe.expiresAt && privateProbe.expiresAt <= Date.now() + 3_600_000);
  const credentials = Object.fromEntries(["FRONTEND_STAGING_MIGRATION_DATABASE_URL", "COURSE_STAGING_DATABASE_URL", "COMMUNITY_STAGING_DATABASE_URL"].map(key => {
    const value = process.env[key]; demand(typeof value === "string" && value.length > 0 && value.length <= 16_384); return [key, value];
  }));
  frontendPrivateReceiptDirectory(settings.results);
  const localDirectory = join(settings.results, selected.plan.actionId); demand(lstatSync(localDirectory, { throwIfNoEntry: false }) === undefined);
  mkdirSync(localDirectory, { mode: 0o700 });
  mkdirSync(join(localDirectory, "controller"), { mode: 0o700 });
  mkdirSync(join(localDirectory, "ssh"), { mode: 0o700 });
  writeFrontendReceipt(localDirectory, "reviewed-plan.json", JSON.parse(canonical(selected.plan)));
  writeFrontendReceipt(localDirectory, "operator-source-ci.json", ci);
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics: join(localDirectory, "ssh") });
  demand((await ssh.machine()).machineId === settings.host.machineId);
  const installed = await ssh.installProfiledCurrentSource({ commit: settings.operatorSourceCommit, files: committed.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === settings.operatorSourceCommit);
  const browserBytes = readFileSync(join(root, "ops/platform/p2-identity-key-rotation-browser-recorder.mjs"));
  const initial = { version: 1, environment: "staging", mode: "p2-identity-key-rotation", sourceCommit: settings.operatorSourceCommit,
    sourceSha256, sourceClosureSha256, hostMachineId: settings.host.machineId, candidate: selected.checked.original.candidate,
    candidateSha256: selected.plan.candidateSha256, bundle: settings.host.bundle, configuration: settings.host.configuration,
    results: settings.host.results, configurationSha256: selected.checked.original.configurationSha256, confirmation,
    credentials, vercelToken: context.vercelToken, rotationActionId: selected.plan.actionId,
    nativePlan: selected.nativePlan, privateProbe, baselineConfigurationRecordSha256: selected.nativePlan.configurationRecordSha256,
    rotationConfiguration: settings.host.rotationConfiguration,
    privateRotationConfigurationSha256: structuredClone(settings.rotation.privateConfigurationSha256),
    expectedFeatureControls: selected.plan.featureControls, expectedWriterAdmissionBinding: selected.plan.writerAdmissionBinding,
    operatorProgramSha256: embeddedRotationProgramSha256(root),
    rotationBrowserProgramSha256: hash(Buffer.concat([browserBytes, Buffer.from("\nawait runP2IdentityRotationBrowserChild();\n")])),
    gatewayHost: context.gatewayHost, certification: selected.checked.prepared.plan.certification,
    targetSha256: selected.checked.prepared.plan.targetSha256, owner: selected.checked.prepared.plan.owner,
    producers: selected.checked.prepared.plan.producers, historicalLogins: selected.checked.prepared.plan.historicalLogins,
    ...(selected.checked.original.plan.priorGatewayReference ? { priorGatewayReference: selected.checked.original.plan.priorGatewayReference } : {}) };
  const dispatch = prepareP2IdentityRotationDispatch(settings, selected, initial,
    { getUrl: () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
      verifyEnvironment: () => readP2IdentityRotationOperatorSource(root, settings.operatorSourceCommit) });
  return runP2IdentityRotationParent(dispatch.plan, { confirmation, transport: dispatch.transport });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [operation, path, flag, confirmation] = process.argv.slice(2);
    demand(["plan", "apply"].includes(operation) && typeof path === "string"
      && (operation === "plan" ? flag === undefined && confirmation === undefined : flag === "--confirm" && typeof confirmation === "string"));
    console.log(JSON.stringify(await p2IdentityRotationOperator(privateObject(resolve(path)), { apply: operation === "apply", confirmation })));
  } catch { console.error("P2_IDENTITY_KEY_ROTATION_FAILED_REQUIRES_REVIEW"); process.exitCode = 1; }
}
