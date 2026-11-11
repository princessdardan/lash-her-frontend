import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { frontendConnectionOptions } from "./frontend-migration.mjs";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { withP2FrontendReplacementRecovery } from "./p2-frontend-replacement-closed.mjs";
import { continueReplacementFrontend } from "./p2-frontend-replacement-release.mjs";
import { prepareP2FrontendReplacementReleaseReview } from "./p2-frontend-replacement-release-review.mjs";
import { exchangeFrontendReplacementWrite } from "./p2-frontend-replacement-write-transport.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { recreationSsh, sshCommand } from "./recreation_ssh.mjs";
import { githubSourceApi } from "./release-inputs.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_FRONTEND_REPLACEMENT_RECOVERY_REQUIRES_REVIEW";
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const decode = bytes => decodeQualificationTargetJson(bytes, "carrier");
const applicationFiles = {
  physicalObservation: "replacement-physical-observation.json",
  databaseReceipt: "database-receipt.json",
  continuationStarted: "frontend-continuation-started.json",
  writtenObservation: "replacement-written-observation.json",
};
const hostFiles = {
  abortObservation: "p2-frontend-replacement-abort-observation.json",
  runtimeOutcome: "runtime-outcome.json",
  writeContainment: "p2-frontend-replacement-write-containment.json",
  runtimeContainment: "p2-frontend-replacement-runtime-containment.json",
};

function file(path) {
  demand(typeof path === "string" && resolve(path) === path);
  return readFrontendReleaseEvidence(dirname(path), basename(path));
}

function prepare(settings) {
  demand(exact(settings, ["releaseSettingsFile", "recoveryReviewFile", "recoveryReviewSha256",
    "operatorSourceCommit", "originalHostEvidenceDirectory"]) && digest(settings.recoveryReviewSha256) &&
    typeof settings.operatorSourceCommit === "string" && /^(?!0+$)[a-f0-9]{40}$/u.test(settings.operatorSourceCommit));
  const release = prepareP2FrontendReplacementReleaseReview(decode(file(settings.releaseSettingsFile)));
  const recoveryRaw = file(settings.recoveryReviewFile);
  demand(hash(recoveryRaw) === settings.recoveryReviewSha256);
  const recovery = decode(recoveryRaw);
  const { actionId, originalDirectory, originalEvidenceSha256 } = recovery;
  const { plan, probe, runtimeReview, settings: { arm } } = release;
  demand(exact(recovery, ["actionId", "originalDirectory", "originalEvidenceSha256"]) &&
    typeof actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(actionId) && actionId !== plan.releaseId &&
    originalDirectory === join(arm.host.results, "p2-profiled-replacement-write-" + plan.releaseId) &&
    exact(originalEvidenceSha256, [...Object.keys(applicationFiles), ...Object.keys(hostFiles)]) &&
    Object.values(originalEvidenceSha256).every(digest));
  const originalLocal = join(arm.results, plan.releaseId + "-replacement-write");
  const originalFrontend = join(originalLocal, "frontend");
  const raw = Object.fromEntries([
    ...Object.entries(applicationFiles).map(([key, name]) => [key, readFrontendReleaseEvidence(originalFrontend, name)]),
    ...Object.entries(hostFiles).map(([key, name]) => [key, readFrontendReleaseEvidence(settings.originalHostEvidenceDirectory, name)]),
  ]);
  demand(Object.entries(raw).every(([key, bytes]) => hash(bytes) === originalEvidenceSha256[key]));
  const { backendPid, backendStart, marker } = decode(raw.physicalObservation);
  const originalProbe = { ...probe, backendPid, backendStart, marker };
  const written = decode(raw.writtenObservation), abort = decode(raw.abortObservation);
  const failure = decode(raw.runtimeOutcome);
  demand(written.producerSha256 === runtimeReview.producerSha256 &&
    written.databaseReceiptSha256 === originalEvidenceSha256.databaseReceipt &&
    written.continuationStartedSha256 === originalEvidenceSha256.continuationStarted &&
    failure.status === "FAILED_REQUIRES_REVIEW" && failure.phase === "configuration-preflight" &&
    failure.environment === "staging" && failure.releaseId === plan.releaseId &&
    failure.candidateSha256 === plan.candidateSha256 && failure.trafficAuthorized === false &&
    abort.appliedPrefix?.length === plan.replacement.approvedPendingTags.length &&
    abort.originalBackendAbsent === true && abort.originalLocksAbsent === true);
  const packet = {
    probe: originalProbe, owner: written.owner, runtime: written.runtime, producerSha256: written.producerSha256,
    administrativeLogins: release.administrativeLogins,
    ...Object.fromEntries(["physicalObservation", "databaseReceipt", "continuationStarted", "writtenObservation", "abortObservation"]
      .map(key => [key, raw[key].toString("base64")])),
  };
  const confirmation = `staging/${plan.releaseId}/replacement-write/${arm.reviewedPlanSha256}/${release.settings.runtimeReviewSha256}/recover/${settings.recoveryReviewSha256}`;
  return { release, recovery, recoveryRaw, raw, packet, originalLocal, confirmation,
    localResults: join(arm.results, actionId), hostResults: join(arm.host.results, actionId), operatorSourceCommit: settings.operatorSourceCommit };
}

export function planP2FrontendReplacementRecovery(settings) {
  const prepared = prepare(settings);
  const { plan, settings: { arm } } = prepared.release;
  const apiTargets = Object.fromEntries(["course", "community"].map(service => {
    const { target } = decode(readFrontendReleaseEvidence(join(arm.bundle, "jobs"), service + ".json"));
    return [service, { host: target.host, database: target.database, user: target.user, pendingTags: target.approvedPendingTags }];
  }));
  return { status: "P2_FRONTEND_REPLACEMENT_RECOVERY_REVIEWED", environment: "staging",
    releaseId: plan.releaseId, recoveryActionId: prepared.recovery.actionId, sourceCommit: plan.sourceCommit,
    operatorSourceCommit: prepared.operatorSourceCommit, candidateSha256: plan.candidateSha256, hostMachineId: arm.host.machineId,
    frontendTarget: plan.replacement.target, frontendMigrationsPreserved: plan.replacement.approvedPendingTags.length,
    frontendMigrationsPending: 0, apiTargets, recoveryReviewSha256: settings.recoveryReviewSha256,
    localResults: prepared.localResults, hostResults: prepared.hostResults, confirmation: prepared.confirmation,
    applicationSqlExecuted: false, applicationDeployment: false, trafficAuthorized: false, productionTarget: false };
}

function recordApiOutcome(store, ready, postflight) {
  for (const kind of ["migration", "runtime"]) {
    const bytes = ready[`${kind}OutcomeBytes`], sha = ready[`${kind}OutcomeSha256`];
    demand(Buffer.isBuffer(bytes) && hash(bytes) === sha);
    store.retain(`${sha}-${postflight}.json`, bytes);
  }
}

// A source-owned host transport supplies the only runtime and deployment
// authority. The held frontend client uses read-only transactions throughout.
export async function continueP2FrontendReplacementRecovery({ host, packet, getUrl, directory, runtimeDatabaseUrl, continueFrontend,
  store = frontendReleaseReceiptStore(directory) }) {
  const raw = key => Buffer.from(packet[key], "base64");
  const started = decode(raw("continuationStarted"));
  const written = decode(raw("writtenObservation"));
  let releaseOutcome;
  const postflight = await withP2FrontendReplacementRecovery(packet, { getUrl, signal: host.signal }, async lease => {
    const verifyLockedSession = async () => {
      demand(!host.signal.aborted);
      await host.verifyEnvironment();
      await lease.verify();
    };
    await verifyLockedSession();
    const resumed = await host.resumeReplacementWritten(lease.probe);
    demand(Buffer.isBuffer(resumed.bytes) && resumed.bytes.equals(raw("writtenObservation")) &&
      resumed.postflightSha256 === lease.retained.writtenObservationSha256);
    store.retain(`${resumed.postflightSha256}-${lease.retained.databaseReceiptSha256}.json`, resumed.bytes);
    store.retain(`${lease.retained.abortObservationSha256}-${resumed.postflightSha256}.json`, raw("abortObservation"));
    store.retainOriginal("database-receipt.json", raw("databaseReceipt"));
    store.retainOriginal("frontend-continuation-started.json", raw("continuationStarted"));
    store.record("replacement-recovery-lock.json", { status: "P2_FRONTEND_REPLACEMENT_RECOVERY_LOCK_VERIFIED",
      environment: "staging", releaseId: started.releaseId, sourceCommit: started.sourceCommit, ...lease.retained,
      backendPid: lease.probe.backendPid, backendStart: lease.probe.backendStart, marker: lease.probe.marker,
      originalBackendPid: packet.probe.backendPid, frontendSqlReplayed: false });
    const ready = await host.startReplacementRuntime();
    await verifyLockedSession();
    recordApiOutcome(store, ready, resumed.postflightSha256);
    releaseOutcome = await continueFrontend({ databaseClient: lease.databaseClient, probe: lease.probe,
      environmentSignal: host.signal, verifyLockedSession, owner: written.owner, runtime: written.runtime,
      admission: { admissionEpoch: written.epoch, newWork: false, recovery: false, operations: 0 },
      ready, host, postflightSha256: resumed.postflightSha256, private: { runtimeDatabaseUrl } });
    await verifyLockedSession();
    await host.prepareReplacementClose();
    return resumed.postflightSha256;
  });
  const closed = await host.observeReplacementClosed();
  demand(Buffer.isBuffer(closed.bytes) && hash(closed.bytes) === closed.sessionClosedSha256);
  store.retain(`${closed.sessionClosedSha256}-${postflight}.json`, closed.bytes);
  const { status, databaseVerified, ...base } = started;
  demand(status === "FRONTEND_CONTINUATION_STARTED" && databaseVerified === true);
  store.record("job-outcome.json", { ...base, status: "DATABASE_VERIFIED", phase: "completed", readOnlyVerified: false });
  store.record("frontend-continuation-completed.json", { ...started, status: "FRONTEND_CONTINUATION_COMPLETED" });
  store.record("frontend-release-outcome.json", releaseOutcome);
  return host.finishReplacement({
    terminal: readFrontendReleaseEvidence(directory, "job-outcome.json"),
    continuationCompleted: readFrontendReleaseEvidence(directory, "frontend-continuation-completed.json"),
    releaseOutcome: readFrontendReleaseEvidence(directory, "frontend-release-outcome.json"),
  });
}

export async function runP2FrontendReplacementRecovery(settings, confirmation, { validateOnly = false } = {}) {
  const selected = prepare(settings);
  demand(process.versions.node.split(".")[0] === "24" && confirmation === selected.confirmation && typeof validateOnly === "boolean");
  const { release, packet, raw, operatorSourceCommit, localResults, hostResults } = selected;
  const { plan, runtimeReview, writerReview, settings: { arm } } = release;
  const source = committedProfiledCurrentOperatorSource(root, operatorSourceCommit);
  demand(source.files.find(file => file.path === "ops/platform/p2-profiled-current-frontend-adapters.mjs")?.sha256 === writerReview.adaptersSha256);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit: operatorSourceCommit, branch: source.branch, workflowBytes: source.workflowBytes });
  const provider = decode(file(release.settings.providerContext));
  requireQualificationTargetProfile(profile, provider);
  demand(exact(provider, ["version", "qualificationTargetProfile", "vercelToken", "bindings"]) && provider.version === 2 &&
    typeof provider.vercelToken === "string" && /^[!-~]{1,8192}$/u.test(provider.vercelToken) &&
    hash(JSON.stringify(provider.bindings?.gatewayObservation)) === writerReview.gatewayBindingSha256);
  const credentials = Object.fromEntries(["FRONTEND_STAGING_MIGRATION_DATABASE_URL", "COURSE_STAGING_DATABASE_URL",
    "COMMUNITY_STAGING_DATABASE_URL", ...(runtimeReview.initializeStagingCronSecret === true ? ["FRONTEND_STAGING_CRON_SECRET"] : [])]
    .map(key => [key, process.env[key]]));
  demand(Object.values(credentials).every(value => typeof value === "string" && value.length > 0 &&
    value.length <= 16_384 && !/[\x00-\x1f]/u.test(value)));
  const getUrl = () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL;
  frontendConnectionOptions(getUrl(), packet.probe.job.target);
  const role = decode(readFrontendReleaseEvidence(join(selected.originalLocal, "roles"), "roles-preparation-outcome.json"));
  const secret = decode(readFrontendReleaseEvidence(join(selected.originalLocal, "credentials"), "frontend-role-credentials.json"));
  requireQualificationTargetProfile(profile, role, secret);
  demand(role.status === "FRONTEND_ROLES_PREPARED" && role.committed === true && role.runtimeCredentialVerified === true &&
    isDeepStrictEqual(role.owner, packet.owner) && isDeepStrictEqual(role.runtime, packet.runtime) &&
    role.environment === "staging" && role.actionId === plan.releaseId && role.sourceCommit === plan.sourceCommit && role.targetSha256 === plan.targetSha256 &&
    role.planSha256 === secret.planSha256 && secret.targetSha256 === plan.targetSha256 && secret.role === packet.runtime.name);
  frontendConnectionOptions(secret.runtimeDatabaseUrl, { ...packet.probe.job.target, user: packet.runtime.name });

  frontendPrivateReceiptDirectory(arm.results);
  const action = join(localResults, plan.releaseId + "-replacement-write");
  const custody = readFrontendReleaseEvidence(join(selected.originalLocal, "frontend"), "replacement-write-custody.json");
  const { armReceiptSha256, physicalObservationSha256 } = decode(custody);
  demand(digest(armReceiptSha256) && physicalObservationSha256 === hash(raw.physicalObservation));
  const diagnostics = mkdtempSync(join(dirname(settings.recoveryReviewFile), "ssh-"));
  const ssh = await recreationSsh({ knownHosts: arm.knownHosts, keyFile: arm.sshKey, diagnostics });
  demand((await ssh.machine()).machineId === arm.host.machineId);
  const installed = await ssh.installProfiledCurrentSource({ commit: operatorSourceCommit, files: source.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === operatorSourceCommit);
  const entries = source.files.map(({ path, sha256 }) => [path, sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const initial = { version: 1, mode: "p2-profiled-frontend-replacement-write", qualificationTargetProfile: profile,
    environment: "staging", sourceCommit: plan.sourceCommit, operatorSourceCommit, sourceSha256: Object.fromEntries(entries),
    sourceClosureSha256: hash(JSON.stringify(entries)), hostMachineId: arm.host.machineId, bundle: arm.host.bundle, results: hostResults,
    candidateSha256: plan.candidateSha256, reviewedPlanBytes: release.reviewedPlanBytes.toString("base64"),
    reviewedPlanSha256: arm.reviewedPlanSha256, runtimeReviewBytes: release.runtimeReviewBytes.toString("base64"),
    runtimeReviewSha256: release.settings.runtimeReviewSha256, recoveryReviewBytes: selected.recoveryRaw.toString("base64"),
    recoveryReviewSha256: settings.recoveryReviewSha256, confirmation, credentials, vercelToken: provider.vercelToken };
  assertSourceCheckout(root, operatorSourceCommit);
  if (validateOnly) {
    const receipt = await ssh.replacementRecoveryFrontier(operatorSourceCommit, initial);
    demand(isDeepStrictEqual(receipt, { status: "P2_FRONTEND_REPLACEMENT_RECOVERY_FRONTIER_VERIFIED", environment: "staging",
      releaseId: plan.releaseId, actionId: selected.recovery.actionId, recoveryReviewSha256: settings.recoveryReviewSha256,
      trafficAuthorized: false }));
    return { ...receipt, operatorSourceCommit, operatorCi: ci, applicationSqlExecuted: false, applicationDeployment: false };
  }
  mkdirSync(localResults, { mode: 0o700 });
  mkdirSync(action, { mode: 0o700 });
  const actionStore = frontendReleaseReceiptStore(action);
  actionStore.record("exact-source-ci.json", ci);
  actionStore.record("ssh-diagnostics-reference.json", { directory: diagnostics });
  actionStore.retain(`${settings.recoveryReviewSha256}-${plan.candidateSha256}.json`, selected.recoveryRaw);
  const directory = join(action, "frontend");
  mkdirSync(directory, { mode: 0o700 });
  const frontendStore = frontendReleaseReceiptStore(directory);
  frontendStore.retainOriginal("replacement-write-custody.json", custody);
  frontendStore.retain(`${physicalObservationSha256}-${armReceiptSha256}.json`, raw.physicalObservation);
  const child = spawn("/usr/bin/ssh", sshCommand({ knownHosts: arm.knownHosts, keyFile: arm.sshKey },
    ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
      `/opt/lash-her/operators/${operatorSourceCommit}/ops/platform/host/p2_frontend_replacement_parent.py`, "--supervise-replacement-write"]),
  { stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "LANG"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  const result = await exchangeFrontendReplacementWrite(child, initial, plan, host => continueP2FrontendReplacementRecovery({
    host, packet, getUrl, directory, runtimeDatabaseUrl: secret.runtimeDatabaseUrl, store: frontendStore,
    continueFrontend: continuation => continueReplacementFrontend(release, directory, provider, continuation,
      credentials.FRONTEND_STAGING_CRON_SECRET),
  }), { recovery: { originalProbe: packet.probe, ...Object.fromEntries(Object.keys(applicationFiles).map(key => [key, raw[key]])) },
    readHostEvidence: async name => {
      const value = await ssh.replacementEvidence(operatorSourceCommit, { version: 1, qualificationTargetProfile: profile,
        environment: "staging", releaseId: plan.releaseId, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256,
        results: hostResults, reviewedPlanSha256: arm.reviewedPlanSha256, operatorSourceCommit,
        recoveryReviewSha256: settings.recoveryReviewSha256, name });
      demand(exact(value, ["bytes"]) && typeof value.bytes === "string");
      const bytes = Buffer.from(value.bytes, "base64");
      demand(bytes.length > 0 && bytes.length <= 2_000_000 && bytes.toString("base64") === value.bytes);
      return bytes;
    } });
  demand(Buffer.isBuffer(result.bytes) && digest(result.commitIntentSha256) &&
    result.receipt?.status === "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION");
  // Keep the same loader-compatible layout with the new action roots.
  frontendStore.retain(`${hash(result.bytes)}-${result.commitIntentSha256}.json`, result.bytes);
  frontendStore.record("replacement-release-terminal.json", result.receipt);
  actionStore.record("certification-release-settings.json", { ...release.settings,
    arm: { ...arm, results: localResults, host: { ...arm.host, results: hostResults } } });
  return result.receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, settingsPath, flag, confirmation] = process.argv.slice(2);
    const settings = decode(file(settingsPath));
    demand(process.versions.node.split(".")[0] === "24");
    if (operation === "--plan" && process.argv.length === 4) console.log(JSON.stringify(planP2FrontendReplacementRecovery(settings)));
    else {
      demand(["--apply", "--validate"].includes(operation) && flag === "--confirm" && process.argv.length === 6);
      console.log(JSON.stringify(await runP2FrontendReplacementRecovery(settings, confirmation, { validateOnly: operation === "--validate" })));
    }
  } catch {
    console.error(refusal);
    process.exitCode = 1;
  }
}
