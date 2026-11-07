// Profiled current-only recovery orchestration. This component never applies
// frontend SQL, prepares roles, restores historical logins, or opens traffic.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runFrontendMigration, writeFrontendReceipt } from "./frontend-migration.mjs";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { requireQualificationTargetProfile, resolveQualificationTargetProfile,
  decodeQualificationTargetJson, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { withP2ProfiledCurrentRecoveryTransport } from "./p2-profiled-current-recovery-transport.mjs";

const preparedValues = new WeakMap();
const runAuthorities = new WeakMap();
const demand = value => { if (!value) throw new Error("P2_PROFILED_CURRENT_RECOVERY_REFUSED"); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const contractDigest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) && !/^sha256:0+$/u.test(value);
const action = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const configurationNames = Object.freeze(["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
  "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem",
  "tls/community/key.pem", "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env",
  "community-api.env", "community-worker.env", "course-media.env", "course-export-cleanup.env"]);
const configuration = value => value && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...configurationNames].sort()) && Object.values(value).every(digest);
const originalReceiptNames = Object.freeze(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome",
  "apiRuntimeOutcome", "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]);
const lostBuildReceiptNames = Object.freeze(["deployStarted", "buildStarted", "buildIntent"]);
const lostBuildReceipts = value => value && !Array.isArray(value)
  && [lostBuildReceiptNames, [...lostBuildReceiptNames, "buildOutcome"]].some(keys => isDeepStrictEqual(Object.keys(value), keys))
  && Object.values(value).every(digest);
const originalReceipts = (value, disposition) => {
  if (!value || Array.isArray(value) || !Object.values(value).every(digest)) return false;
  const names = Object.keys(value), prefix = originalReceiptNames.slice(0, names.length);
  if (!isDeepStrictEqual(names, prefix)) return false;
  if (disposition === "resume-approved-api-suffix") return [3, 4, originalReceiptNames.length].includes(names.length);
  if (disposition === "restore-current-runtime") return [3, 4, 5, originalReceiptNames.length].includes(names.length);
  if (disposition === "reconcile-frontend-lost-build-get-first") return names.length === 5;
  return disposition === "reconcile-frontend-get-first" && names.length === originalReceiptNames.length;
};

function requireOriginalReceipts(results, releaseId, expected, disposition) {
  demand(originalReceipts(expected, disposition));
  const actionDirectory = join(frontendPrivateReceiptDirectory(results), releaseId);
  frontendPrivateReceiptDirectory(actionDirectory);
  const frontend = join(actionDirectory, "frontend"), vercel = join(frontend, "vercel");
  frontendPrivateReceiptDirectory(frontend);
  if (Object.keys(expected).some(name => ["frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"].includes(name))) {
    frontendPrivateReceiptDirectory(vercel);
  }
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
  for (const name of Object.keys(expected)) demand(hash(readFrontendReleaseEvidence(...files[name])) === expected[name]);
  return Object.freeze({ actionDirectory, frontendDirectory: frontend });
}
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => structuredClone(value);
const hash = value => createHash("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const jobHash = value => hash(Buffer.from(JSON.stringify(value) + "\n"));
const isSuffix = (chain, suffix) => Array.isArray(chain) && suffix.length <= chain.length
  && (suffix.length === 0 || isDeepStrictEqual(chain.slice(chain.length - suffix.length), suffix));

function readSettings(path) {
  const absolute = resolve(path); demand(realpathSync(absolute) === absolute); frontendPrivateReceiptDirectory(dirname(absolute));
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); demand(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o077) === 0
      && before.size > 0 && before.size <= 2_000_000);
    const bytes = readFileSync(fd), after = fstatSync(fd);
    demand(bytes.length === before.size && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]));
    return decodeQualificationTargetJson(bytes, "private-packet");
  } finally { closeSync(fd); }
}

function validateSettings(settings) {
  resolveQualificationTargetProfile(current);
  demand(settings?.version === 2 && settings.environment === "staging" && settings.mode === "p2-profiled-current-recovery"
    && action(settings.recoveryActionId) && action(settings.originalReleaseId) && settings.recoveryActionId !== settings.originalReleaseId
    && /^[a-f0-9]{40}$/u.test(settings.sourceCommit ?? "") && !/^0+$/u.test(settings.sourceCommit)
    && digest(settings.candidateSha256) && configuration(settings.configurationSha256) && digest(settings.targetSha256) && digest(settings.inventorySha256)
    && settings.apiJobSha256 && isDeepStrictEqual(Object.keys(settings.apiJobSha256).sort(), ["community", "course"])
    && Object.values(settings.apiJobSha256).every(digest)
    && settings.inventory && hash(settings.inventory) === settings.inventorySha256
    && ["restore-current-runtime", "reconcile-frontend-get-first", "reconcile-frontend-lost-build-get-first",
      "resume-approved-api-suffix"].includes(settings.disposition));
  const migration = settings.frontendMigration;
  requireQualificationTargetProfile(current, settings, migration, migration?.candidate, migration?.candidate?.frontendMigration,
    migration?.job, migration?.job?.target, settings.courseJob, settings.courseJob?.target, settings.communityJob, settings.communityJob?.target,
    settings.inventory);
  demand(migration.candidate.version === 3 && migration.candidate.environment === "staging"
    && migration.candidate.contractPhase === "p2" && contractDigest(migration.candidate.phase2ContractManifestSha256)
    && migration.candidate.releaseId === settings.originalReleaseId
    && migration.candidate.sources?.frontend?.commit === settings.sourceCommit
    && migration.job.version === 2 && migration.job.environment === "staging" && migration.job.releaseId === settings.originalReleaseId
    && migration.job.sourceCommit === settings.sourceCommit && migration.job.target.approvedPendingTags?.length === 0
    && migration.job.target.allowEmptyBootstrap === false
    && settings.courseJob.schemaVersion === 2 && settings.communityJob.schemaVersion === 2
    && settings.courseJob.releaseId === settings.originalReleaseId && settings.communityJob.releaseId === settings.originalReleaseId);
  demand(settings.owner && Object.keys(settings.owner).sort().join(",") === "name,oid"
    && /^[a-z][a-z0-9_]{0,62}$/u.test(settings.owner.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(settings.owner.oid ?? ""));
  demand(originalReceipts(settings.originalReceiptSha256, settings.disposition));
  if (settings.disposition === "resume-approved-api-suffix") {
    demand(settings.approvedApiSuffix && !Array.isArray(settings.approvedApiSuffix)
      && ["course", "community"].every(service => Array.isArray(settings.approvedApiSuffix[service]))
      && Object.keys(settings.approvedApiSuffix).length === 2
      && Object.values(settings.approvedApiSuffix).flat().length > 0
      && Object.values(settings.approvedApiSuffix).flat().every(tag => typeof tag === "string" && /^\d{4}_[a-z0-9_]+$/u.test(tag))
      && ["course", "community"].every(service => settings[service + "Job"].target.allowEmptyBootstrap === false
        && isSuffix(settings[service + "Job"].target.approvedPendingTags, settings.approvedApiSuffix[service])));
  } else demand(settings.approvedApiSuffix === undefined);
  if (settings.disposition === "reconcile-frontend-lost-build-get-first") demand(lostBuildReceipts(settings.lostBuildReceiptSha256));
  else demand(settings.lostBuildReceiptSha256 === undefined);
  return settings;
}

export function prepareP2ProfiledCurrentRecovery(settings) {
  const selected = clone(validateSettings(settings));
  selected.originalReceiptSha256 = Object.fromEntries(Object.keys(selected.originalReceiptSha256)
    .map(name => [name, selected.originalReceiptSha256[name]]));
  const recoveryApiJobSha256 = selected.approvedApiSuffix ? Object.fromEntries(["course", "community"].map(service => {
    const derived = clone(selected[service + "Job"]); derived.target.approvedPendingTags = clone(selected.approvedApiSuffix[service]);
    derived.target.allowEmptyBootstrap = false; return [service, jobHash(derived)];
  })) : undefined;
  const plan = freeze({ version: 2, qualificationTargetProfile: clone(current), mode: "p2-profiled-current-recovery",
    environment: "staging", recoveryActionId: selected.recoveryActionId, originalReleaseId: selected.originalReleaseId,
    releaseId: selected.originalReleaseId, contractPhase: "p2",
    phase2ContractManifestSha256: selected.frontendMigration.candidate.phase2ContractManifestSha256,
    sourceCommit: selected.sourceCommit, candidateSha256: selected.candidateSha256, configurationSha256: selected.configurationSha256,
    targetSha256: selected.targetSha256, inventorySha256: selected.inventorySha256, apiJobSha256: clone(selected.apiJobSha256), owner: clone(selected.owner),
    disposition: selected.disposition, originalReceiptSha256: clone(selected.originalReceiptSha256),
    ...(selected.lostBuildReceiptSha256 ? { lostBuildReceiptSha256: clone(selected.lostBuildReceiptSha256) } : {}),
    ...(selected.approvedApiSuffix ? { approvedApiSuffix: clone(selected.approvedApiSuffix) } : {}),
    ...(recoveryApiJobSha256 ? { recoveryApiJobSha256 } : {}),
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

export async function runP2ProfiledCurrentRecovery(prepared, authority) {
  const retained = preparedValues.get(prepared?.handle); demand(retained && prepared.plan === retained.plan); preparedValues.delete(prepared.handle);
  const deps = requireRunDependencies(runAuthorities.get(authority)), { settings, plan } = retained;
  demand(authority && deps); runAuthorities.delete(authority);
  demand(deps.confirmation === `staging/${settings.recoveryActionId}`); deps.assertSource(settings.sourceCommit);
  const [{ createP2ProfiledCurrentProbe }, { readP2ProfiledCurrentFrontendReceipt }, frontendAdapters, releaseSource] = await Promise.all([
    import("./p2-profiled-current-probe.mjs"), import("./p2-profiled-current-transport.mjs"),
    import("./p2-profiled-current-frontend-adapters.mjs"), import("./p2-profiled-current-release.mjs"),
  ]);
  demand(typeof createP2ProfiledCurrentProbe === "function" && typeof readP2ProfiledCurrentFrontendReceipt === "function"
    && typeof frontendAdapters.observeProfiledCurrentFrontend === "function" && typeof frontendAdapters.readProfiledCurrentWorkloadReceipt === "function");
  demand(typeof releaseSource.verifyP2ProfiledCurrentWriterBoundary === "function");
  const store = frontendReleaseReceiptStore(deps.directory); let databaseClient, closePrepared = false, lostBuildObservation;
  const base = freeze({ ...clone(plan), status: "P2_PROFILED_CURRENT_RECOVERY_STARTED", phase: "source-preflight" });
  await store.record("p2-profiled-current-recovery-started.json", base);
  try {
    return await withP2ProfiledCurrentRecoveryTransport(deps.transportHandle, async (verifyEnvironment, environmentSignal, runtime) => {
      const result = await runFrontendMigration(settings.frontendMigration, {
        confirmation: `staging/${settings.originalReleaseId}`, getUrl: deps.getUrl, assertSource: () => deps.assertSource(settings.sourceCommit),
        record: store.record,
        async beforeDatabasePreflight(context) {
          databaseClient = context.client; await context.verifySession(); await verifyEnvironment();
          await releaseSource.verifyP2ProfiledCurrentWriterBoundary(databaseClient, settings.frontendMigration,
            settings.inventory, context.verifySession);
        },
        async afterDatabaseVerified(database, verifySession) {
          demand(databaseClient && !environmentSignal.aborted); await verifySession(); await verifyEnvironment();
          const continuationStarted = readP2ProfiledCurrentFrontendReceipt(deps.directory, "continuation-started", settings.frontendMigration);
          const probe = await createP2ProfiledCurrentProbe(settings.frontendMigration, plan, databaseClient, verifySession, database);
          let lostBuildSourceObservation;
          if (settings.disposition === "reconcile-frontend-lost-build-get-first") {
            const providerContext = await deps.getProviderContext();
            const observed = await frontendAdapters.observeProfiledCurrentFrontend({ plan, migration: settings.frontendMigration,
              lostBuildReceiptSha256: settings.lostBuildReceiptSha256, providerContext, environmentSignal, verifyEnvironment, verifySession });
            demand(observed?.status === "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED"
              && Buffer.isBuffer(observed.evidence) && observed.evidence.length > 0 && observed.evidence.length <= 2_000_000
              && observed.evidenceSha256 === hash(observed.evidence));
            lostBuildSourceObservation = Object.fromEntries(Object.entries(observed)
              .filter(([key]) => !["evidence", "evidenceSha256"].includes(key)));
          }
          const armed = await runtime.armRecovery({ receipt: database, continuationStarted: continuationStarted.record, probe });
          await verifySession();
          if (settings.disposition !== "resume-approved-api-suffix") await runtime.verifyCurrentApis();
          else await runtime.prepareApiSuffix();
          if (settings.disposition === "reconcile-frontend-lost-build-get-first") {
            demand(lostBuildSourceObservation);
            lostBuildObservation = await runtime.observeLostBuild(lostBuildSourceObservation);
            await store.record("p2-profiled-current-lost-build-observation.json", lostBuildSourceObservation);
          }
          await runtime.preparePriorGateway(); await armed.apiReady; await verifySession();
          if (settings.disposition !== "reconcile-frontend-lost-build-get-first"
              && Object.keys(settings.originalReceiptSha256).length === originalReceiptNames.length) {
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
          } else demand(settings.disposition === "resume-approved-api-suffix" || settings.disposition === "restore-current-runtime"
            || settings.disposition === "reconcile-frontend-lost-build-get-first");
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
        frontendEffectReconciled: settings.disposition === "reconcile-frontend-get-first",
        frontendBuildEffectObserved: settings.disposition === "reconcile-frontend-lost-build-get-first",
        ...(lostBuildObservation ? { frontendBuildEffectObservationSha256: lostBuildObservation.observationSha256 } : {}),
        frontendCurrentVerified: Object.keys(settings.originalReceiptSha256).length === originalReceiptNames.length,
        frontendActionPending: Object.keys(settings.originalReceiptSha256).length < originalReceiptNames.length, frontendSqlApplied: false,
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
    && Object.keys(request).sort().join(",") === ["approvedApiSuffix", "disposition", "environment", "lostBuildReceiptSha256", "originalReceiptSha256",
      "qualificationTargetProfile", "recoveryActionId", "version"].filter(key => request[key] !== undefined).sort().join(","));
  const materialized = { version: 2, qualificationTargetProfile: current, mode: "p2-profiled-current-recovery", environment: "staging",
    recoveryActionId: request.recoveryActionId, originalReleaseId: release.plan.releaseId, sourceCommit: release.plan.sourceCommit,
    candidateSha256: release.plan.candidateSha256, configurationSha256: release.plan.configurationSha256,
    targetSha256: release.plan.targetSha256, inventorySha256: release.plan.inventorySha256,
    apiJobSha256: release.plan.apiJobSha256, owner: release.inventory.owner,
    disposition: request.disposition, originalReceiptSha256: request.originalReceiptSha256,
    ...(request.lostBuildReceiptSha256 ? { lostBuildReceiptSha256: request.lostBuildReceiptSha256 } : {}),
    ...(request.approvedApiSuffix ? { approvedApiSuffix: request.approvedApiSuffix } : {}),
    frontendMigration: release.migration, courseJob: release.apiJobs.course, communityJob: release.apiJobs.community,
    inventory: release.inventory };
  const prepared = prepareP2ProfiledCurrentRecovery(materialized);
  if (!apply) return prepared.plan;
  demand(confirmation === `staging/${prepared.plan.recoveryActionId}`);
  const original = requireOriginalReceipts(settings.release.results, release.plan.releaseId,
    prepared.plan.originalReceiptSha256, prepared.plan.disposition);
  const sourceHandle = await releaseSource.openP2ProfiledCurrentSource(release,
    { actionId: prepared.plan.recoveryActionId, confirmation });
  const custody = releaseSource.readP2ProfiledCurrentSource(sourceHandle, release, prepared.plan.recoveryActionId);
  writeFrontendReceipt(custody.directory, "reviewed-recovery-plan.json", prepared.plan);
  const initial = { ...custody.initialBase, mode: "p2-profiled-current-recovery", confirmation,
    reviewedPlanSha256: hash(prepared.plan), recoveryActionId: prepared.plan.recoveryActionId,
    originalReleaseId: prepared.plan.originalReleaseId, disposition: prepared.plan.disposition,
    originalReceiptSha256: prepared.plan.originalReceiptSha256,
    ...(prepared.plan.lostBuildReceiptSha256 ? { lostBuildReceiptSha256: prepared.plan.lostBuildReceiptSha256 } : {}),
    ...(prepared.plan.approvedApiSuffix ? { approvedApiSuffix: prepared.plan.approvedApiSuffix,
      recoveryApiJobSha256: prepared.plan.recoveryApiJobSha256 } : {}) };
  const transportModule = await import("./p2-profiled-current-recovery-transport.mjs");
  const transportHandle = transportModule.p2ProfiledCurrentRecoveryEnvironmentLock(settings.release, initial, custody.frontendDirectory);
  const authority = Object.freeze({});
  runAuthorities.set(authority, Object.freeze({ confirmation, directory: custody.frontendDirectory, transportHandle,
    getUrl: () => custody.credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    getProviderContext: async () => Object.freeze({ ...custody.context, originalDirectory: original.frontendDirectory }),
    assertSource: custody.assertSource }));
  return runP2ProfiledCurrentRecovery(prepared, authority);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), apply = args[0] === "--apply";
    demand(args.length === (apply ? 5 : 3) && ["--apply", "--plan"].includes(args[0]) && args[1] === "--settings"
      && (!apply || args[3] === "--confirm"));
    const settings = readSettings(args[2]);
    console.log(JSON.stringify(await p2ProfiledCurrentRecoveryOperator(settings, { apply, confirmation: args[4] })));
  } catch {
    console.error("P2_PROFILED_CURRENT_RECOVERY_REFUSED"); process.exitCode = 1;
  }
}
