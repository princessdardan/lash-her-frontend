#!/usr/bin/env node
// Source-owned plan/apply composition for the fixed staging identity rotation.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareP2RecoveryOperator } from "./p2-recovery.mjs";
import { bindP2CertificationReadyReceipts } from "./p2-certification.mjs";
import { P2_LIFECYCLE_NATIVE_SCHEDULE } from "./p2-lifecycle-native.mjs";
import { committedOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { githubSourceApi } from "./release-inputs.mjs";
import { recreationSsh } from "./recreation_ssh.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { frontendCoordinationHash } from "./frontend-release-inventory.mjs";
import { prepareP2IdentityRotationParent, runP2IdentityRotationParent } from "./p2-identity-key-rotation-parent.mjs";
import { p2IdentityRotationEnvironmentLock } from "./p2-identity-key-rotation-transport.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_OPERATOR_REFUSED"); };
const SHA = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
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

export async function p2IdentityRotationOperator(settings, { apply = false, confirmation } = {}) {
  demand(process.versions.node.split(".")[0] === "24");
  const selected = prepareP2IdentityRotationOperator(settings);
  if (!apply) return selected.plan;
  demand(confirmation === `staging/${selected.plan.actionId}`);
  const committed = committedOperatorSource(root, settings.operatorSourceCommit);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN), sourceCommit: settings.operatorSourceCommit,
    branch: committed.branch, workflowBytes: committed.workflowBytes });
  const sourceSha256 = Object.fromEntries(committed.files.map(file => [file.path, file.sha256]));
  const sourceClosureSha256 = hash(Object.entries(sourceSha256).sort(([a], [b]) => a.localeCompare(b)));
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
  mkdirSync(localDirectory, { mode: 0o700 }); mkdirSync(join(localDirectory, "ssh"), { mode: 0o700 });
  writeFileSync(join(localDirectory, "reviewed-plan.json"), canonical(selected.plan) + "\n", { mode: 0o600, flag: "wx" });
  writeFileSync(join(localDirectory, "operator-source-ci.json"), canonical(ci) + "\n", { mode: 0o600, flag: "wx" });
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics: join(localDirectory, "ssh") });
  demand((await ssh.machine()).machineId === settings.host.machineId);
  const installed = await ssh.installSource({ commit: settings.operatorSourceCommit, files: committed.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === settings.operatorSourceCommit);
  const browserBytes = readFileSync(join(root, "ops/platform/p2-identity-key-rotation-browser-recorder.mjs"));
  const initial = { version: 1, environment: "staging", mode: "p2-identity-key-rotation", sourceCommit: settings.operatorSourceCommit,
    sourceSha256, sourceClosureSha256, hostMachineId: settings.host.machineId, candidate: selected.checked.original.candidate,
    candidateSha256: selected.plan.candidateSha256, bundle: settings.host.bundle, configuration: settings.host.configuration,
    results: settings.host.results, configurationSha256: selected.checked.original.configurationSha256, confirmation,
    credentials, vercelToken: context.vercelToken, rotationActionId: selected.plan.actionId, rotationPlan: selected.plan,
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
  const prepared = prepareP2IdentityRotationParent(selected.plan, selected.checked.prepared, selected.checked.action,
    { sourceCommit: selected.plan.sourceCommit, candidateSha256: selected.plan.candidateSha256,
      bindingSha256: selected.plan.bindingSha256, configuration: selected.plan.configuration,
      featureControls: selected.plan.featureControls, writerAdmissionBinding: selected.plan.writerAdmissionBinding },
    { getUrl: () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
      verifyEnvironment: () => committedOperatorSource(root, settings.operatorSourceCommit) });
  const transport = p2IdentityRotationEnvironmentLock(settings, initial);
  return runP2IdentityRotationParent(prepared, { confirmation, transport });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [operation, path, flag, confirmation] = process.argv.slice(2);
    demand(["plan", "apply"].includes(operation) && typeof path === "string"
      && (operation === "plan" ? flag === undefined && confirmation === undefined : flag === "--confirm" && typeof confirmation === "string"));
    console.log(JSON.stringify(await p2IdentityRotationOperator(privateObject(resolve(path)), { apply: operation === "apply", confirmation })));
  } catch { console.error("P2_IDENTITY_KEY_ROTATION_FAILED_REQUIRES_REVIEW"); process.exitCode = 1; }
}
