// Profiled current-only recovery orchestration. This component never applies
// frontend SQL, prepares roles, restores historical logins, or opens traffic.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { runFrontendMigration, writeFrontendReceipt } from "./frontend-migration.mjs";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { withP2ProfiledCurrentRecoveryTransport } from "./p2-profiled-current-recovery-transport.mjs";

const preparedValues = new WeakMap();
const demand = value => { if (!value) throw new Error("P2_PROFILED_CURRENT_RECOVERY_REFUSED"); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const action = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const configurationNames = Object.freeze(["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
  "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem",
  "tls/community/key.pem", "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env",
  "community-api.env", "community-worker.env", "course-media.env", "course-export-cleanup.env"]);
const configuration = value => value && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...configurationNames].sort()) && Object.values(value).every(digest);
const originalReceiptNames = Object.freeze(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome",
  "apiRuntimeOutcome", "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]);
const originalReceipts = value => value && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...originalReceiptNames].sort()) && Object.values(value).every(digest);

function requireOriginalReceipts(results, releaseId, expected) {
  demand(originalReceipts(expected));
  const actionDirectory = join(frontendPrivateReceiptDirectory(results), releaseId);
  frontendPrivateReceiptDirectory(actionDirectory);
  const frontend = join(actionDirectory, "frontend"), vercel = join(frontend, "vercel");
  frontendPrivateReceiptDirectory(frontend); frontendPrivateReceiptDirectory(vercel);
  const files = {
    candidate: [actionDirectory, "release.candidate.json"],
    frontendDatabase: [frontend, "database-receipt.json"],
    frontendContinuationStarted: [frontend, "frontend-continuation-started.json"],
    apiMigrationOutcome: [actionDirectory, "api-migration-outcome.json"],
    apiRuntimeOutcome: [actionDirectory, "api-runtime-outcome.json"],
    frontendBuildOutcome: [vercel, "frontend-build-outcome.json"],
    frontendPromotionStarted: [vercel, "frontend-promotion-started.json"],
    frontendWorkloadOutcome: [vercel, "frontend-workload-outcome.json"],
  };
  for (const name of originalReceiptNames) demand(hash(readFrontendReleaseEvidence(...files[name])) === expected[name]);
  return Object.freeze({ actionDirectory, frontendDirectory: frontend });
}
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);
const hash = value => createHash("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function validateSettings(settings) {
  resolveQualificationTargetProfile(current);
  demand(settings?.version === 2 && settings.environment === "staging" && settings.mode === "p2-profiled-current-recovery"
    && action(settings.recoveryActionId) && action(settings.originalReleaseId) && settings.recoveryActionId !== settings.originalReleaseId
    && /^[a-f0-9]{40}$/u.test(settings.sourceCommit ?? "") && !/^0+$/u.test(settings.sourceCommit)
    && digest(settings.candidateSha256) && configuration(settings.configurationSha256) && digest(settings.targetSha256) && digest(settings.inventorySha256)
    && ["restore-current-runtime", "reconcile-frontend-get-first", "resume-approved-api-suffix"].includes(settings.disposition));
  const migration = settings.frontendMigration;
  requireQualificationTargetProfile(current, settings, migration, migration?.candidate, migration?.candidate?.frontendMigration,
    migration?.job, migration?.job?.target, settings.courseJob, settings.courseJob?.target, settings.communityJob, settings.communityJob?.target);
  demand(migration.candidate.version === 3 && migration.candidate.environment === "staging"
    && migration.candidate.releaseId === settings.originalReleaseId
    && migration.candidate.sources?.frontend?.commit === settings.sourceCommit
    && migration.job.version === 2 && migration.job.environment === "staging" && migration.job.releaseId === settings.originalReleaseId
    && migration.job.sourceCommit === settings.sourceCommit && migration.job.target.approvedPendingTags?.length === 0
    && migration.job.target.allowEmptyBootstrap === false
    && settings.courseJob.schemaVersion === 2 && settings.communityJob.schemaVersion === 2
    && settings.courseJob.releaseId === settings.originalReleaseId && settings.communityJob.releaseId === settings.originalReleaseId);
  demand(settings.owner && Object.keys(settings.owner).sort().join(",") === "name,oid"
    && /^[a-z][a-z0-9_]{0,62}$/u.test(settings.owner.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(settings.owner.oid ?? ""));
  demand(originalReceipts(settings.originalReceiptSha256));
  if (settings.disposition === "resume-approved-api-suffix") {
    demand(settings.approvedApiSuffix && !Array.isArray(settings.approvedApiSuffix)
      && ["course", "community"].every(service => Array.isArray(settings.approvedApiSuffix[service]))
      && Object.keys(settings.approvedApiSuffix).length === 2
      && Object.values(settings.approvedApiSuffix).flat().every(tag => typeof tag === "string" && /^\d{4}_[a-z0-9_]+$/u.test(tag)));
  } else demand(settings.approvedApiSuffix === undefined);
  return settings;
}

export function prepareP2ProfiledCurrentRecovery(settings) {
  const selected = clone(validateSettings(settings));
  selected.originalReceiptSha256 = Object.fromEntries(originalReceiptNames.map(name => [name, selected.originalReceiptSha256[name]]));
  const plan = freeze({ version: 2, qualificationTargetProfile: clone(current), mode: "p2-profiled-current-recovery",
    environment: "staging", recoveryActionId: selected.recoveryActionId, originalReleaseId: selected.originalReleaseId,
    sourceCommit: selected.sourceCommit, candidateSha256: selected.candidateSha256, configurationSha256: selected.configurationSha256,
    targetSha256: selected.targetSha256, inventorySha256: selected.inventorySha256, owner: clone(selected.owner),
    disposition: selected.disposition, originalReceiptSha256: clone(selected.originalReceiptSha256),
    ...(selected.approvedApiSuffix ? { approvedApiSuffix: clone(selected.approvedApiSuffix) } : {}),
    frontendSqlApplied: false, rolePreparationAuthorized: false, historicalProviderClosureClaimed: false,
    historicalLoginsRestored: false, oldP200Qualified: false, nativeSchedulesEnabled: false, trafficAuthorized: false,
    releaseAccepted: false, pendingFrontendSqlResolved: false });
  const handle = Object.freeze({});
  preparedValues.set(handle, freeze({ settings: selected, plan }));
  return Object.freeze({ handle, plan });
}

function requireRunDependencies(dependencies) {
  demand(dependencies && typeof dependencies === "object" && typeof dependencies.getUrl === "function"
    && typeof dependencies.assertSource === "function" && typeof dependencies.getProviderContext === "function"
    && typeof dependencies.directory === "string" && dependencies.transportHandle && typeof dependencies.confirmation === "string");
  return dependencies;
}

export async function runP2ProfiledCurrentRecovery(prepared, dependencies) {
  const retained = preparedValues.get(prepared?.handle); demand(retained && prepared.plan === retained.plan); preparedValues.delete(prepared.handle);
  const deps = requireRunDependencies(dependencies), { settings, plan } = retained;
  demand(deps.confirmation === `staging/${settings.recoveryActionId}`); deps.assertSource(settings.sourceCommit);
  const [{ createP2ProfiledCurrentProbe }, { readP2ProfiledCurrentFrontendReceipt }, frontendAdapters] = await Promise.all([
    import("./p2-profiled-current-probe.mjs"), import("./p2-profiled-current-transport.mjs"),
    import("./p2-profiled-current-frontend-adapters.mjs"),
  ]);
  demand(typeof createP2ProfiledCurrentProbe === "function" && typeof readP2ProfiledCurrentFrontendReceipt === "function"
    && typeof frontendAdapters.observeProfiledCurrentFrontend === "function" && typeof frontendAdapters.readProfiledCurrentWorkloadReceipt === "function");
  const store = frontendReleaseReceiptStore(deps.directory); let databaseClient, closePrepared = false;
  const base = freeze({ ...clone(plan), status: "P2_PROFILED_CURRENT_RECOVERY_STARTED", phase: "source-preflight" });
  await store.record("p2-profiled-current-recovery-started.json", base);
  try {
    return await withP2ProfiledCurrentRecoveryTransport(deps.transportHandle, async (verifyEnvironment, environmentSignal, runtime) => {
      const result = await runFrontendMigration(settings.frontendMigration, {
        confirmation: `staging/${settings.originalReleaseId}`, getUrl: deps.getUrl, assertSource: () => deps.assertSource(settings.sourceCommit),
        record: store.record,
        async beforeDatabasePreflight(context) { databaseClient = context.client; await context.verifySession(); await verifyEnvironment(); },
        async afterDatabaseVerified(database, verifySession) {
          demand(databaseClient && !environmentSignal.aborted); await verifySession(); await verifyEnvironment();
          const continuationStarted = readP2ProfiledCurrentFrontendReceipt(deps.directory, "continuation-started", settings.frontendMigration);
          const probe = await createP2ProfiledCurrentProbe(settings.frontendMigration, plan, databaseClient, verifySession, database);
          const armed = await runtime.armRecovery({ receipt: database, continuationStarted: continuationStarted.record, probe });
          await verifySession(); await runtime.preparePriorGateway(); await armed.apiReady; await verifySession();
          const providerContext = await deps.getProviderContext();
          const observed = await frontendAdapters.observeProfiledCurrentFrontend({ plan, migration: settings.frontendMigration,
            originalReceiptSha256: settings.originalReceiptSha256, providerContext, environmentSignal, verifyEnvironment, verifySession });
          demand(observed?.status === "P2_PROFILED_CURRENT_FRONTEND_CURRENT" && observed.getFirst === true
            && observed.newProviderPost === false && observed.ambiguous === false
            && observed.originalEffectReconciled === (settings.disposition === "reconcile-frontend-get-first")
            && observed.proof?.status === "P2_PROFILED_CURRENT_FRONTEND_VERIFIED");
          const workload = await frontendAdapters.readProfiledCurrentWorkloadReceipt({ plan, migration: settings.frontendMigration,
            originalReceiptSha256: settings.originalReceiptSha256, providerContext }, observed);
          demand(Buffer.isBuffer(workload) && workload.length > 0 && workload.length <= 2_000_000);
          await runtime.reconcileFrontend(observed, observed.proof, workload);
          if (settings.disposition === "resume-approved-api-suffix") {
            await runtime.resumeApprovedApiSuffix();
          }
          await runtime.runtimeRestored();
          await verifySession(); await verifyEnvironment(); await runtime.prepareClose(); closePrepared = true;
        },
      }, current);
      demand(closePrepared && result.version === 2 && result.status === "DATABASE_VERIFIED" && result.phase === "completed"
        && result.readOnlyVerified === true && result.trafficAuthorized === false && isDeepStrictEqual(result.qualificationTargetProfile, current));
      const continuation = readP2ProfiledCurrentFrontendReceipt(deps.directory, "continuation-completed", settings.frontendMigration);
      const terminal = readP2ProfiledCurrentFrontendReceipt(deps.directory, "terminal", settings.frontendMigration);
      demand(isDeepStrictEqual(terminal.record, result));
      const sessionClosed = await runtime.frontendSessionClosed();
      const outcome = freeze({ ...clone(plan), status: "P2_PROFILED_CURRENT_RECOVERED_FENCED", phase: "completed",
        frontendTerminalSha256: terminal.sha256, frontendContinuationCompletedSha256: continuation.sha256,
        ...(digest(sessionClosed.sha256) ? { sessionClosedSha256: sessionClosed.sha256 } : {}),
        runtimeCurrent: true, apiSuffixResumed: settings.disposition === "resume-approved-api-suffix",
        frontendEffectReconciled: settings.disposition === "reconcile-frontend-get-first", frontendSqlApplied: false,
        rolePreparationAuthorized: false, historicalLoginsRestored: false, nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false });
      await store.record("p2-profiled-current-recovery-held.json", outcome);
      await runtime.finish({ terminal: terminal.record, continuationCompleted: continuation.record, recoveryOutcome: outcome });
      return outcome;
    });
  } catch {
    try { await store.record("p2-profiled-current-recovery-failed.json", { ...clone(plan), status: "FAILED_REQUIRES_REVIEW", phase: closePrepared ? "close" : "active",
      trafficAuthorized: false, releaseAccepted: false }); } catch { /* exclusive retained evidence may already exist */ }
    throw new Error("P2_PROFILED_CURRENT_RECOVERY_FAILED_REQUIRES_REVIEW");
  }
}

export async function p2ProfiledCurrentRecoveryOperator(settings, { apply = false, confirmation } = {}) {
  demand(process.versions.node.split(".")[0] === "24" && settings?.version === 2 && settings.environment === "staging");
  requireQualificationTargetProfile(current, settings, settings?.release, settings?.recovery);
  demand(Object.keys(settings).sort().join(",") === "environment,qualificationTargetProfile,recovery,release,version");
  const releaseSource = await import("./p2-profiled-current-release.mjs");
  const release = releaseSource.prepareP2ProfiledCurrentRelease(settings.release);
  const request = settings.recovery;
  demand(request.version === 2 && request.environment === "staging"
    && Object.keys(request).sort().join(",") === ["approvedApiSuffix", "disposition", "environment", "originalReceiptSha256",
      "qualificationTargetProfile", "recoveryActionId", "version"].filter(key => request[key] !== undefined).sort().join(","));
  const materialized = { version: 2, qualificationTargetProfile: current, mode: "p2-profiled-current-recovery", environment: "staging",
    recoveryActionId: request.recoveryActionId, originalReleaseId: release.plan.releaseId, sourceCommit: release.plan.sourceCommit,
    candidateSha256: release.plan.candidateSha256, configurationSha256: release.plan.configurationSha256,
    targetSha256: release.plan.targetSha256, inventorySha256: release.plan.inventorySha256, owner: release.inventory.owner,
    disposition: request.disposition, originalReceiptSha256: request.originalReceiptSha256,
    ...(request.approvedApiSuffix ? { approvedApiSuffix: request.approvedApiSuffix } : {}),
    frontendMigration: release.migration, courseJob: release.apiJobs.course, communityJob: release.apiJobs.community };
  const prepared = prepareP2ProfiledCurrentRecovery(materialized);
  if (!apply) return prepared.plan;
  demand(confirmation === `staging/${prepared.plan.recoveryActionId}`);
  const original = requireOriginalReceipts(settings.release.results, release.plan.releaseId, prepared.plan.originalReceiptSha256);
  const sourceHandle = await releaseSource.openP2ProfiledCurrentSource(release,
    { actionId: prepared.plan.recoveryActionId, confirmation });
  const custody = releaseSource.readP2ProfiledCurrentSource(sourceHandle, release, prepared.plan.recoveryActionId);
  writeFrontendReceipt(custody.directory, "reviewed-recovery-plan.json", prepared.plan);
  const initial = { ...custody.initialBase, mode: "p2-profiled-current-recovery", confirmation,
    reviewedPlanSha256: hash(prepared.plan), recoveryActionId: prepared.plan.recoveryActionId,
    originalReleaseId: prepared.plan.originalReleaseId, disposition: prepared.plan.disposition,
    originalReceiptSha256: prepared.plan.originalReceiptSha256,
    ...(prepared.plan.approvedApiSuffix ? { approvedApiSuffix: prepared.plan.approvedApiSuffix } : {}) };
  const transportModule = await import("./p2-profiled-current-recovery-transport.mjs");
  const transportHandle = transportModule.p2ProfiledCurrentRecoveryEnvironmentLock(settings.release, initial, custody.frontendDirectory);
  return runP2ProfiledCurrentRecovery(prepared, { confirmation, directory: custody.frontendDirectory, transportHandle,
    getUrl: () => custody.credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    getProviderContext: async () => Object.freeze({ ...custody.context, originalDirectory: original.frontendDirectory }),
    assertSource: custody.assertSource });
}
