import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { frontendConnectionOptions } from "./frontend-migration.mjs";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { prepareP2FrontendReplacementReleaseReview } from "./p2-frontend-replacement-release-review.mjs";
import { exchangeFrontendReplacementWrite } from "./p2-frontend-replacement-write-transport.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { recreationSsh, sshCommand } from "./recreation_ssh.mjs";
import { githubSourceApi } from "./release-inputs.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_FRONTEND_REPLACEMENT_RELEASE_REVIEW_REQUIRED";
const mode = "p2-profiled-frontend-replacement-write";
const credentialNames = ["FRONTEND_STAGING_MIGRATION_DATABASE_URL", "COURSE_STAGING_DATABASE_URL", "COMMUNITY_STAGING_DATABASE_URL"];
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = value => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const settingsFile = path => {
  demand(typeof path === "string" && resolve(path) === path);
  return decodeQualificationTargetJson(readFrontendReleaseEvidence(dirname(path), basename(path)), "carrier");
};

function confirmationFor(review) {
  return `staging/${review.plan.releaseId}/replacement-write/${review.settings.arm.reviewedPlanSha256}/${review.settings.runtimeReviewSha256}`;
}

export function planP2FrontendReplacementRelease(settings) {
  const review = prepareP2FrontendReplacementReleaseReview(settings);
  const { plan, runtimeReview } = review;
  return {
    version: 1, qualificationTargetProfile: profile, environment: plan.environment, releaseId: plan.releaseId,
    sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256, candidateSha256: plan.candidateSha256,
    reviewedPlanSha256: review.settings.arm.reviewedPlanSha256, runtimeReviewSha256: review.settings.runtimeReviewSha256,
    configurationSha256: runtimeReview.configurationSha256, apiJobSha256: runtimeReview.apiJobSha256,
    producerSha256: runtimeReview.producerSha256, migrationCount: plan.replacement.approvedPendingTags.length,
    confirmation: confirmationFor(review), providerCredentialsResolved: false, migrationAuthorized: false, trafficAuthorized: false,
  };
}

export async function openP2FrontendReplacementOperator(settings, confirmation) {
  demand(process.versions.node.split(".")[0] === "24");
  const review = prepareP2FrontendReplacementReleaseReview(settings);
  const { arm } = review.settings, { plan, runtimeReview, writerReview } = review;
  demand(confirmation === confirmationFor(review));
  const source = committedProfiledCurrentOperatorSource(root, plan.sourceCommit);
  demand(source.files.find(file => file.path === "ops/platform/p2-profiled-current-frontend-adapters.mjs")?.sha256 === writerReview.adaptersSha256);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit: plan.sourceCommit, branch: source.branch, workflowBytes: source.workflowBytes });
  const context = settingsFile(review.settings.providerContext);
  demand(exact(context, ["version", "qualificationTargetProfile", "vercelToken", "bindings"]) && context.version === 2 &&
    typeof context.vercelToken === "string" && /^[!-~]{1,8192}$/u.test(context.vercelToken) &&
    hash(JSON.stringify(context.bindings?.gatewayObservation)) === writerReview.gatewayBindingSha256);
  requireQualificationTargetProfile(profile, context);
  const credentials = Object.fromEntries(credentialNames.map(key => {
    const value = process.env[key];
    demand(typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\x00-\x1f]/u.test(value));
    return [key, value];
  }));
  const url = credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL;
  frontendConnectionOptions(url, review.probe.job.target);

  frontendPrivateReceiptDirectory(arm.results);
  const action = join(arm.results, `${plan.releaseId}-replacement-write`);
  mkdirSync(action, { mode: 0o700 });
  const parent = openSync(arm.results, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const store = frontendReleaseReceiptStore(action);
  store.record("exact-source-ci.json", ci);
  store.retain(`${arm.reviewedPlanSha256}-${plan.reviewSha256}.json`, review.reviewedPlanBytes);
  store.retain(`${review.settings.runtimeReviewSha256}-${plan.candidateSha256}.json`, review.runtimeReviewBytes);
  store.retain(`${runtimeReview.producerSha256}-${plan.targetSha256}.json`, review.writerReviewBytes);
  const [directory, rolesDirectory, privateDirectory, diagnostics] = ["frontend", "roles", "credentials", "ssh"].map(name => {
    const path = join(action, name); mkdirSync(path, { mode: 0o700 }); return path;
  });
  const ssh = await recreationSsh({ knownHosts: arm.knownHosts, keyFile: arm.sshKey, diagnostics });
  demand((await ssh.machine()).machineId === arm.host.machineId);
  const installed = await ssh.installProfiledCurrentSource({ commit: plan.sourceCommit, files: source.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === plan.sourceCommit);
  const entries = source.files.map(file => [file.path, file.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const initial = { version: 1, mode, qualificationTargetProfile: profile, environment: "staging", sourceCommit: plan.sourceCommit,
    sourceSha256: Object.fromEntries(entries), sourceClosureSha256: hash(JSON.stringify(entries)), hostMachineId: arm.host.machineId,
    bundle: arm.host.bundle, results: arm.host.results, candidateSha256: plan.candidateSha256,
    reviewedPlanBytes: review.reviewedPlanBytes.toString("base64"), reviewedPlanSha256: arm.reviewedPlanSha256,
    runtimeReviewBytes: review.runtimeReviewBytes.toString("base64"), runtimeReviewSha256: review.settings.runtimeReviewSha256,
    confirmation, credentials, vercelToken: context.vercelToken };

  return { review, directory, rolesDirectory, privateDirectory, getUrl: () => url,
    verifySource: () => assertSourceCheckout(root, plan.sourceCommit),
    withEnvironmentLock: task => withReplacementOperatorHost(arm, initial, plan, ssh, task),
    continueRelease: continuation => continueReplacementFrontend(review, directory, context, continuation),
  };
}

function withReplacementOperatorHost(arm, initial, plan, ssh, task) {
  const remote = ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
    `/opt/lash-her/operators/${plan.sourceCommit}/ops/platform/host/p2_frontend_replacement_parent.py`,
    "--supervise-replacement-write"];
  const child = spawn("/usr/bin/ssh", sshCommand({ knownHosts: arm.knownHosts, keyFile: arm.sshKey }, remote), {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.fromEntries(["PATH", "HOME", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  });
  const readHostEvidence = async name => {
    const value = await ssh.replacementEvidence(plan.sourceCommit, { version: 1, qualificationTargetProfile: profile,
      environment: "staging", releaseId: plan.releaseId, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
      results: arm.host.results, reviewedPlanSha256: arm.reviewedPlanSha256, name });
    demand(exact(value, ["bytes"]) && typeof value.bytes === "string");
    const raw = Buffer.from(value.bytes, "base64");
    demand(raw.length > 0 && raw.length <= 2_000_000 && raw.toString("base64") === value.bytes);
    return raw;
  };
  return exchangeFrontendReplacementWrite(child, initial, plan,
    host => task(host.verifyEnvironment, host.signal, host), { readHostEvidence });
}

async function continueReplacementFrontend(review, directory, provider, continuation) {
  const { deployProfiledReplacementFrontend, observeProfiledReplacementFrontend,
    readProfiledReplacementWorkloadReceipt, readProfiledReplacementPromotionReceipt } =
    await import("./p2-profiled-current-frontend-adapters.mjs");
  const { plan, runtimeReview, writerReview, settings } = review;
  const { probe, databaseClient, environmentSignal, verifyLockedSession, owner, runtime, admission, ready, host } = continuation;
  const { candidate, job } = probe;
  const replacementProvenance = {
    postflightSha256: continuation.postflightSha256, reviewedPlanSha256: settings.arm.reviewedPlanSha256,
    runtimeReviewSha256: settings.runtimeReviewSha256, runtimeOutcomeSha256: ready.runtimeOutcomeSha256,
    migrationOutcomeSha256: ready.migrationOutcomeSha256,
  };
  const inventory = { version: 2, qualificationTargetProfile: profile, environment: "staging",
    actionId: plan.releaseId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256, owner,
    runtimeProducerSha256: runtimeReview.producerSha256, producers: [{ producerSha256: runtimeReview.producerSha256, role: runtime }],
    configurationSha256: runtimeReview.configurationSha256, certification: runtimeReview.certification,
    restoration: { gatewayBindingSha256: writerReview.gatewayBindingSha256 } };
  const context = { qualificationTargetProfile: profile, plan: inventory, inventorySha256: hash(JSON.stringify(inventory)), candidate,
    candidateSha256: plan.candidateSha256, job, configurationSha256: runtimeReview.configurationSha256, directory,
    databaseClient, environmentSignal, verifyLockedSession, getProviderContext: async () => provider,
    bootstrapRuntimeTarget: { qualificationTargetProfile: profile, environment: "staging", targetSha256: plan.targetSha256,
      ...Object.fromEntries(["host", "port", "database", "serverMajor"].map(key => [key, job.target[key]])), user: runtime.name },
    admissionObservation: { epoch: admission.admissionEpoch, newWork: admission.newWork, recovery: admission.recovery, operations: admission.operations },
    replacementProbe: probe, replacementProvenance };
  Object.defineProperty(context, "frontendRuntimeDatabaseUrl", { value: continuation.private.runtimeDatabaseUrl });
  await deployProfiledReplacementFrontend(context);
  await verifyLockedSession();
  const observed = await observeProfiledReplacementFrontend(context);
  const proof = Buffer.concat([observed.evidence, Buffer.from("\n")]);
  const workload = readProfiledReplacementWorkloadReceipt(context, observed);
  const promotion = readProfiledReplacementPromotionReceipt(context, observed);
  await host.verifyReplacementFrontend({ proof, workload, promotion });
  await verifyLockedSession();
  return { version: 2, qualificationTargetProfile: profile, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED",
    environment: "staging", releaseId: plan.releaseId, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
    targetSha256: plan.targetSha256, configurationSha256: runtimeReview.configurationSha256, ...replacementProvenance,
    contractPhase: "p2", phase2ContractManifestSha256: plan.phase2ContractManifestSha256, deploymentProofSha256: hash(proof),
    frontendSqlApplied: true, frontendSqlReplayed: false, historicalProviderClosureClaimed: false, oldP200Qualified: false,
    nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, path] = process.argv.slice(2);
    demand(process.versions.node.split(".")[0] === "24" && process.argv.length === 4 && command === "--plan");
    console.log(JSON.stringify(planP2FrontendReplacementRelease(settingsFile(path))));
  } catch {
    console.error(refusal);
    process.exitCode = 1;
  }
}
