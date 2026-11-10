import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { recreationSsh } from "./recreation_ssh.mjs";
import { githubSourceApi } from "./release-inputs.mjs";
import { p2NativeHash as hash } from "./p2-lifecycle-native.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_REPLACEMENT_IDENTITY_PROBE_REQUIRES_REVIEW";
const demand = ok => { if (!ok) throw new Error(refusal); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = (value, width = 64) => typeof value === "string" && new RegExp(`^(?!0+$)[a-f0-9]{${width}}$`, "u").test(value);
const actionId = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const localPath = value => typeof value === "string" && resolve(value) === value;
const hostPath = value => localPath(value) && /^\/var\/lib\/lash-her\/releases\/staging\/[a-zA-Z0-9_/.-]+$/u.test(value) &&
  !value.includes("//") && !value.endsWith("/");
const evidenceNames = ["originalReleaseReceipt", "frontendDeploymentRecord"];
const replacementFields = ["targetSha256", "apiJobSha256", "runtimeInventorySha256", "gatewayProcessSha256", "replacementRelease", "successorRuntime"];
const reviewFields = ["version", "qualificationTargetProfile", "environment", "probeId", "releaseId", "candidateSha256", "hostMachineId",
  "configurationSha256", "sources", "containers", "subjects", "resources", "previousProfiles", "priorEvidence", ...replacementFields];
const commonProofFields = ["version", "qualificationTargetProfile", "environment", "probeId", "releaseId", "candidateSha256", "hostMachineId",
  "sources", "configurationSha256", "programSha256", "operatorSourceSha256", "priorEvidence", ...replacementFields];
const program = "ops/platform/p2-identity-negative-probe.mjs";
const launcher = "\nawait runPrivateProbeFromStdin();\n";
const subjects = ["learnerA", "learnerB", "admin"];
const resources = ["courseA", "courseB", "sharedCourse", "lesson", "completedAttempt"];
const profileNames = ["community-admin", "community-member", "course-admin", "course-learner"];
const images = { gateway: "gateway", "course-api": "course-runtime", "community-api": "community-runtime" };
const verifierScopes = ["actual-course-image-verifier-only", "actual-community-image-verifier-only"];
const verifierModules = [
  ["dist/auth/first-party.js", "dist/auth/jwt-profile.js", "dist/config/env.js"],
  ["dist/auth/community-user-auth.js", "dist/config/runtime.js", "dist/config/env.js"],
];

function readLocal(path) {
  demand(localPath(path));
  return readFrontendReleaseEvidence(dirname(path), basename(path));
}

function reviewSettings(settings) {
  demand(exact(settings, ["version", "qualificationTargetProfile", "reviewed", "host", "results", "knownHosts", "sshKey", "priorEvidence"]) &&
    settings.version === 2 && exact(settings.reviewed, reviewFields) && exact(settings.host, ["bundle", "configuration", "results"]) &&
    Object.values(settings.host).every(hostPath) && new Set(Object.values(settings.host)).size === 3 &&
    [settings.results, settings.knownHosts, settings.sshKey].every(localPath) &&
    exact(settings.priorEvidence, evidenceNames) && Object.values(settings.priorEvidence).every(localPath));
  const reviewed = settings.reviewed;
  requireQualificationTargetProfile(profile, settings, reviewed, reviewed.replacementRelease);
  demand(reviewed.version === 2 && reviewed.environment === "staging" && actionId(reviewed.probeId) &&
    actionId(reviewed.releaseId) && reviewed.probeId !== reviewed.releaseId && digest(reviewed.hostMachineId, 32) &&
    [reviewed.candidateSha256, reviewed.configurationSha256, reviewed.targetSha256, reviewed.runtimeInventorySha256,
      reviewed.gatewayProcessSha256].every(value => digest(value)) &&
    exact(reviewed.sources, ["frontend", "course", "community"]) && Object.values(reviewed.sources).every(value => digest(value, 40)) &&
    exact(reviewed.apiJobSha256, ["course", "community"]) && Object.values(reviewed.apiJobSha256).every(value => digest(value)) &&
    exact(reviewed.priorEvidence, [...evidenceNames.map(name => name + "Sha256"), "originalReleasePlanSha256"]) &&
    Object.values(reviewed.priorEvidence).every(value => digest(value)) &&
    reviewed.priorEvidence.originalReleasePlanSha256 === reviewed.replacementRelease.reviewedPlanSha256);
  demand([["subjects", subjects], ["resources", resources]].every(([field, keys]) =>
    exact(reviewed[field], keys) && Object.values(reviewed[field]).every(uuid) &&
    new Set(Object.values(reviewed[field])).size === keys.length));
  demand(Array.isArray(reviewed.previousProfiles) && reviewed.previousProfiles.every(name => profileNames.includes(name)) &&
    isDeepStrictEqual(reviewed.previousProfiles, [...new Set(reviewed.previousProfiles)].sort()));
  demand(Array.isArray(reviewed.containers) && reviewed.containers.length === 3 &&
    reviewed.containers.every(row => {
      if (!exact(row, ["service", "containerId", "image"]) || !Object.hasOwn(images, row.service) ||
          !digest(row.containerId) || typeof row.image !== "string") return false;
      const prefix = `ghcr.io/princessdardan/lash-her-platform-${images[row.service]}@sha256:`;
      return row.image.startsWith(prefix) && digest(row.image.slice(prefix.length));
    }) &&
    new Set(reviewed.containers.map(row => row.service)).size === 3 &&
    new Set(reviewed.containers.map(row => row.containerId)).size === 3);
  return reviewed;
}

export function prepareReplacementIdentityProbe(settings, sourceFiles) {
  const draft = reviewSettings(settings);
  const original = Object.fromEntries(evidenceNames.map(name => {
    const raw = readLocal(settings.priorEvidence[name]);
    demand(raw.length <= 65_536 && hash(raw) === draft.priorEvidence[name + "Sha256"]);
    return [name, raw.toString("base64")];
  }));
  const sourceProgram = sourceFiles.find(file => file.path === program);
  demand(sourceProgram);
  const rawProgram = Buffer.from(sourceProgram.data, "base64");
  demand(hash(rawProgram) === sourceProgram.sha256);
  const entries = sourceFiles.filter(file => !file.path.startsWith("ops/platform/evidence/")).map(file => [file.path, file.sha256]);
  demand(entries.length > 0 && entries.length <= 544 && new Set(entries.map(([path]) => path)).size === entries.length);
  const operatorSourceFiles = Object.fromEntries(entries);
  const reviewed = { ...draft, operatorSourceFiles, operatorSourceSha256: hash(operatorSourceFiles),
    programSha256: hash(Buffer.concat([rawProgram, Buffer.from(launcher)])) };
  const packet = { version: 2, qualificationTargetProfile: profile, operation: "plan-replacement",
    bundleDirectory: settings.host.bundle, configurationDirectory: settings.host.configuration, resultsDirectory: settings.host.results,
    reviewed, priorEvidence: null };
  const bindingSha256 = hash({ packet, settings });
  const plan = { version: 2, qualificationTargetProfile: profile, status: "P2_REPLACEMENT_IDENTITY_PROBE_PREPARED",
    probeId: reviewed.probeId, releaseId: reviewed.releaseId, hostMachineId: reviewed.hostMachineId, sources: reviewed.sources,
    candidateSha256: reviewed.candidateSha256, configurationSha256: reviewed.configurationSha256, targetSha256: reviewed.targetSha256,
    reviewedScopeSha256: hash(reviewed), bindingSha256, confirmation: `staging/${reviewed.probeId}/identity-probe/${bindingSha256}`,
    readOnly: true, frontendSqlVerified: false, oidcVerified: false, keyRemovalVerified: false, releaseAccepted: false };
  return { plan, packet, original };
}

export function requireReplacementIdentityHostReceipt(receipt, reviewed, executed) {
  const planFields = ["prerequisites", "credentialsRead", "networkCalled"];
  const runFields = ["containers", "reviewedScopeSha256", "verifiers", "httpChecks", "previousProfiles", "keyRemovalVerified",
    "crossAccountIsolationVerified", "completedAttemptIsolationVerified", "newFixturesCreated", "leaseProfile", "priorEvidenceBytesBound"];
  demand(exact(receipt, [...commonProofFields, "status", "readOnly", "frontendSqlVerified", "oidcVerified", "releaseAccepted",
    ...(executed ? runFields : planFields)]));
  requireQualificationTargetProfile(profile, receipt);
  demand(commonProofFields.every(key => isDeepStrictEqual(receipt[key], reviewed[key])) && receipt.readOnly === true &&
    receipt.frontendSqlVerified === false && receipt.oidcVerified === false && receipt.releaseAccepted === false);
  if (executed) {
    demand(receipt.status === "P2_STAGING_IDENTITY_NEGATIVE_PROBES_PASS" && receipt.reviewedScopeSha256 === hash(reviewed) &&
      isDeepStrictEqual(receipt.containers, reviewed.containers) && isDeepStrictEqual(receipt.previousProfiles, reviewed.previousProfiles) &&
      Array.isArray(receipt.verifiers) && receipt.verifiers.length === 2 && Array.isArray(receipt.httpChecks) &&
      [receipt.httpChecks, ...receipt.verifiers.map(row => row?.checks)].every(checks =>
        Array.isArray(checks) && checks.length >= 60 && checks.length <= 150 &&
        checks.every(row => typeof row?.name === "string" && /^[a-z0-9.-]{1,120}$/u.test(row.name) && row.status === "passed") &&
        new Set(checks.map(row => row.name)).size === checks.length) &&
      receipt.keyRemovalVerified === false && receipt.newFixturesCreated === false && receipt.crossAccountIsolationVerified === true &&
      receipt.completedAttemptIsolationVerified === true && receipt.leaseProfile === "fresh-host-flock-readonly-identity-no-sql" &&
      receipt.priorEvidenceBytesBound === true);
    demand(receipt.verifiers.every((row, index) =>
      row.scope === verifierScopes[index] && row.bindingSha256 === receipt.reviewedScopeSha256 &&
      row.runtimeConfigurationBindingVerified === true && exact(row.moduleSha256, verifierModules[index]) &&
      Object.values(row.moduleSha256).every(value => digest(value)) &&
      row.checks.every(check => exact(check, ["name", "status"]))));
    demand(receipt.httpChecks.every(row => exact(row, ["name", "status", "httpStatus"]) &&
      row.name.startsWith("course-http.") && [200, 401, 403].includes(row.httpStatus)) &&
      receipt.httpChecks[0].name === "course-http.current.learner-a-baseline" && receipt.httpChecks[0].httpStatus === 200 &&
      receipt.httpChecks.at(-1).name === "course-http.final-valid-baseline" && receipt.httpChecks.at(-1).httpStatus === 200);
  } else {
    demand(receipt.status === "P2_IDENTITY_NEGATIVE_PROBE_PLAN" && Array.isArray(receipt.prerequisites) &&
      receipt.prerequisites.length > 0 && receipt.credentialsRead === false && receipt.networkCalled === false);
  }
  return receipt;
}

async function verifyReviewedProbe(settings, source, prepared, confirmation) {
  const { plan, packet, original } = prepared;
  demand(confirmation === plan.confirmation && source.branch === "staging");
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit: plan.sources.frontend, branch: source.branch, workflowBytes: source.workflowBytes });
  frontendPrivateReceiptDirectory(settings.results);
  const directory = join(settings.results, `${plan.probeId}-identity-probe`);
  mkdirSync(directory, { mode: 0o700 });
  const store = frontendReleaseReceiptStore(directory);
  store.record("exact-source-ci.json", ci);
  store.record("reviewed-plan.json", plan);
  const diagnostics = join(directory, "ssh");
  mkdirSync(diagnostics, { mode: 0o700 });
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics });
  demand((await ssh.machine()).machineId === plan.hostMachineId);
  const commit = plan.sources.frontend;
  const installed = await ssh.installProfiledCurrentSource({ commit, files: source.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === commit && installed.files === source.files.length);
  const hostPlan = requireReplacementIdentityHostReceipt(await ssh.replacementIdentityProbe(commit, packet), packet.reviewed, false);
  store.record("host-plan.json", hostPlan);
  const execution = { ...packet, operation: "execute-replacement-readonly", priorEvidence: original };
  const receipt = requireReplacementIdentityHostReceipt(await ssh.replacementIdentityProbe(commit, execution), packet.reviewed, true);
  store.record("host-probe-receipt.json", receipt);
  const receiptSha256 = hash(readFrontendReleaseEvidence(directory, "host-probe-receipt.json"));
  return { ...plan, status: receipt.status, receiptSha256, exactSourceCiRunId: ci.ciRunId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, settingsPath, flag, confirmation] = process.argv.slice(2);
    demand(process.versions.node.split(".")[0] === "24" &&
      (mode === "--plan" && process.argv.length === 4 ||
        mode === "--verify-readonly" && process.argv.length === 6 && flag === "--confirm"));
    const settings = decodeQualificationTargetJson(readLocal(settingsPath), "carrier");
    const reviewed = reviewSettings(settings);
    const source = committedProfiledCurrentOperatorSource(root, reviewed.sources.frontend);
    const prepared = prepareReplacementIdentityProbe(settings, source.files);
    const result = mode === "--plan" ? prepared.plan : await verifyReviewedProbe(settings, source, prepared, confirmation);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write(refusal + "\n");
    process.exitCode = 1;
  }
}
