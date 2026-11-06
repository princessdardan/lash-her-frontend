// Deliberate new, observe-only recovery action. Never migration replay, LOGIN,
// admission reopening, provider rollback or automatic traffic restoration.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { assertAppliedMigrationLineage } from "../../src/lib/private-db/migration-lineage.ts";
import { FRONTEND_MIGRATION_LOCK, frontendConnectionOptions } from "./frontend-migration.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";
import { loadFrontendReleaseAdapters, prepareFrontendReleaseCoordination } from "./frontend-release-coordinator.mjs";
import { frontendCoordinationHash, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const demand = ok => { if (!ok) throw new Error("FRONTEND_RELEASE_RECOVERY_REFUSED"); };

export function prepareFrontendReleaseRecovery(prepared, input) {
  const { migration, plan } = prepared;
  const checked = prepareFrontendReleaseCoordination(migration.candidate, migration.job, migration.baseline, plan);
  demand(input?.version === 1 && input.environment === "staging" && typeof input.actionId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && input.actionId !== plan.actionId &&
    input.originalActionId === plan.actionId && typeof input.originalIntentSha256 === "string" && /^[a-f0-9]{64}$/u.test(input.originalIntentSha256) &&
    !/^0+$/u.test(input.originalIntentSha256) && typeof input.reconciliationReviewSha256 === "string" && /^[a-f0-9]{64}$/u.test(input.reconciliationReviewSha256) &&
    !/^0+$/u.test(input.reconciliationReviewSha256));
  return { prepared: checked, action: { version: 1, environment: "staging", actionId: input.actionId, originalActionId: input.originalActionId,
    originalIntentSha256: input.originalIntentSha256, reconciliationReviewSha256: input.reconciliationReviewSha256 } };
}

export async function observeFrontendReleaseRecovery(input, dependencies) {
  const checked = prepareFrontendReleaseRecovery(input.prepared, input.action);
  const { migration, plan, inventorySha256 } = checked.prepared, { action } = checked;
  demand(dependencies?.confirmation === `staging/${action.actionId}` && dependencies.directory !== dependencies.originalDirectory && typeof dependencies.getUrl === "function");
  const store = frontendReleaseReceiptStore(dependencies.directory);
  const priorBytes = readFrontendReleaseEvidence(dependencies.originalDirectory, "frontend-release-started.json");
  demand(frontendCoordinationHash(priorBytes) === action.originalIntentSha256);
  const prior = JSON.parse(priorBytes.toString("utf8"));
  demand(prior?.actionId === plan.actionId && prior.environment === plan.environment && prior.sourceCommit === plan.sourceCommit &&
    prior.targetSha256 === plan.targetSha256 && prior.inventorySha256 === inventorySha256 && prior.adaptersSha256 === plan.adaptersSha256);
  const base = { ...action, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256, inventorySha256,
    trafficAuthorized: false, migrationAuthorized: false, sqlReplayAuthorized: false, admissionRestored: false, nativeSchedulesRestored: false };
  let phase = "source-and-adapter-preflight", intentRecorded = false, observedState;
  const assertSource = dependencies.assertSource ?? assertSourceCheckout;
  try {
    assertSource(root, plan.sourceCommit);
    const adapters = await loadFrontendReleaseAdapters(root, plan.adaptersSha256);
    await store.record("frontend-recovery-started.json", { ...base, status: "FRONTEND_RELEASE_RECOVERY_OBSERVATION_STARTED" }); intentRecorded = true;
    await withFrontendEnvironmentLock(async (verifyEnvironment, environmentSignal) => {
      let client, locked = false, lost = false, pid, cleanupFailed = false;
      const fenceLostEnvironment = () => { lost = true; try { if (client) void Promise.resolve(client.end()).catch(() => {}); } catch { /* observation remains unverified */ } };
      environmentSignal.addEventListener("abort", fenceLostEnvironment, { once: true });
      const target = migration.job.target;
      const verify = async () => {
        await verifyEnvironment();
        demand(!lost && client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true &&
          client.connectionParameters?.host === target.host && Number(client.connectionParameters.port) === target.port);
        const same = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS username,current_database() AS database,current_setting('server_version_num')::int/10000 AS major")).rows[0];
        demand(same?.username === target.user && same.database === target.database && same.major === target.serverMajor && (pid === undefined || same.pid === pid));
        pid = same.pid;
        if (locked) demand((await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
          AND objid=(hashtext($1)::bigint & 4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`, [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true);
        demand(!lost);
      };
      try {
        phase = "credential-and-target";
        // Force every transaction to read-only, including provider observation
        // wait time. The explicit session locks themselves remain available.
        const options = frontendConnectionOptions(await dependencies.getUrl(), target);
        client = (dependencies.createClient ?? (options => new Client(options)))({ ...options, options: "-c default_transaction_read_only=on", application_name: "lash-her-frontend-recovery-observer" });
        client.on("error", () => { lost = true; });
        await client.connect(); await verify();
        demand((await client.query("SHOW default_transaction_read_only")).rows[0]?.default_transaction_read_only === "on");
        phase = "physical-database-lock";
        locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [FRONTEND_MIGRATION_LOCK])).rows[0]?.locked === true;
        demand(locked); await verify();
        phase = "actual-database-and-admission-state";
        const hasJournal = (await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0]?.present === true;
        const actualJournal = hasJournal ? (await client.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC")).rows : [];
        const latest = assertAppliedMigrationLineage(migration.artifact.expected, actualJournal);
        const current = latest === migration.artifact.migrations.at(-1).folderMillis;
        const catalogMatches = isDeepStrictEqual(await readMigrationCatalog(client), migration.baseline.catalog);
        const names = plan.historicalLogins.retiredLogins.map(role => role.name), oids = plan.historicalLogins.retiredLogins.map(role => role.oid);
        const roles = (await client.query("SELECT oid::text,rolname,rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", [names])).rows;
        demand(roles.length === names.length && roles.every(row => plan.historicalLogins.retiredLogins.some(role => role.name === row.rolname && role.oid === row.oid)));
        await client.query("SELECT pg_stat_clear_snapshot()");
        const sessions = (await client.query("SELECT usesysid::text AS role_oid,datname,count(*)::int AS count FROM pg_stat_activity WHERE usesysid=ANY($1::oid[]) GROUP BY usesysid,datname ORDER BY usesysid,datname", [oids])).rows;
        let admission = { installed: false };
        if ((await client.query("SELECT to_regnamespace('frontend_admission') IS NOT NULL AS present")).rows[0]?.present === true) {
          const owner = (await client.query("SELECT oid::text FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin", [plan.owner.name])).rows;
          demand(owner.length === 1 && owner[0].oid === plan.owner.oid);
          await client.query("BEGIN READ ONLY");
          try {
            await client.query(`SET LOCAL ROLE "${plan.owner.name}"`);
            const controls = (await client.query("SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton")).rows;
            demand(controls.length === 1 && controls[0].environment === plan.environment && controls[0].target_sha256 === plan.targetSha256);
            const unresolved = (await client.query("SELECT state,count(*)::int AS count FROM frontend_admission.operations WHERE state <> 'completed' GROUP BY state ORDER BY state")).rows;
            admission = { installed: true, epoch: controls[0].epoch, newWork: controls[0].new_work, recovery: controls[0].recovery, unresolved };
          } finally { await client.query("ROLLBACK"); }
        }
        observedState = { migrationJournalSha256: frontendCoordinationHash(actualJournal), migrationsApplied: actualJournal.length,
          artifactMigrations: migration.artifact.migrations.length, lineageCurrent: current, schemaMatchesReviewedBaseline: catalogMatches,
          roles: roles.map(row => ({ name: row.rolname, oid: row.oid, canLogin: row.rolcanlogin })),
          selectedRoleSessions: sessions.map(row => ({ roleOid: row.role_oid, database: row.datname, count: row.count })), admission };
        await verify(); await store.record("frontend-recovery-database-observed.json", { ...base, ...observedState });
        phase = "independent-provider-state-observation";
        const nonce = randomBytes(32).toString("hex");
        const providerContext = { candidate: migration.candidate, directory: dependencies.directory,
          originalDirectory: dependencies.originalDirectory,
          getProviderContext: dependencies.getProviderContext, databaseClient: client, verifyLockedSession: verify, environmentSignal };
        const external = await adapters.observeFrontendExternalFences(Object.freeze({ plan, inventorySha256, nonce, checkpoint: "recovery", recoveryActionId: action.actionId, ...providerContext }));
        const proof = await validateFrontendFenceObservation(plan, nonce, external, store.retain, { requireFenced: false });
        await store.record("frontend-recovery-external-observed.json", { ...base, proof });
        phase = "actual-compatible-frontend-state-observation";
        const frontend = await adapters.observeCompatibleFrontend(Object.freeze({ plan, inventorySha256,
          checkpoint: "recovery", recoveryActionId: action.actionId, ...providerContext }));
        demand(frontend?.version === 1 && frontend.actionId === plan.actionId && frontend.environment === plan.environment &&
          frontend.sourceCommit === plan.sourceCommit && frontend.targetSha256 === plan.targetSha256 &&
          Buffer.isBuffer(frontend.evidence) && frontend.evidence.length > 0 && frontend.evidence.length <= 2_000_000 &&
          frontendCoordinationHash(frontend.evidence) === frontend.evidenceSha256);
        const providerState = JSON.parse(frontend.evidence.toString("utf8"));
        demand(["version", "actionId", "environment", "sourceCommit", "targetSha256"].every(key => providerState[key] === frontend[key]) &&
          providerState.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" &&
          (providerState.deploymentId === null || typeof providerState.deploymentId === "string" && /^dpl_[A-Za-z0-9]+$/u.test(providerState.deploymentId)) &&
          (providerState.readyState === null || ["QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED"].includes(providerState.readyState)) &&
          (providerState.aliasJobState === null || ["pending", "in-progress", "succeeded", "failed", "skipped"].includes(providerState.aliasJobState)) &&
          typeof providerState.nativeSchedulesEnabled === "boolean");
        await store.retain(`${nonce}-${frontend.evidenceSha256}.json`, frontend.evidence);
        await store.record("frontend-recovery-provider-state-observed.json", { ...base, evidenceSha256: frontend.evidenceSha256,
          projectId: providerState.projectId, deploymentId: providerState.deploymentId, readyState: providerState.readyState,
          aliasJobState: providerState.aliasJobState, nativeSchedulesEnabled: providerState.nativeSchedulesEnabled });
        await verify(); assertSource(root, plan.sourceCommit);
        // No deployCompatibleFrontend/fence method is invoked here. A missing
        // proof remains a review condition, never a request to replay effects.
      } finally {
        try { if (locked) demand((await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS unlocked", [FRONTEND_MIGRATION_LOCK])).rows[0]?.unlocked === true); }
        catch { cleanupFailed = true; }
        try { if (client) await client.end(); } catch { cleanupFailed = true; }
        environmentSignal.removeEventListener("abort", fenceLostEnvironment);
        demand(!cleanupFailed && !lost);
      }
    }, dependencies.lockPath ? { path: dependencies.lockPath } : {});
    const outcome = { ...base, status: "FRONTEND_RELEASE_STATE_OBSERVED_REVIEW_REQUIRED", phase: "completed", databaseObserved: observedState !== undefined };
    await store.record("frontend-recovery-outcome.json", outcome); return outcome;
  } catch {
    try { if (intentRecorded) await store.record("frontend-recovery-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase, databaseObserved: observedState !== undefined }); } catch { /* retain original receipts */ }
    throw new Error("FRONTEND_RELEASE_RECOVERY_FAILED_REVIEW_REQUIRED");
  }
}
