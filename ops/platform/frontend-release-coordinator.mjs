// In-process staging component. The legacy staging entrypoint deliberately does
// not call this module. No CLI, provider credentials or automatic restoration.
import { randomBytes } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { prepareFrontendMigration, runFrontendMigration } from "./frontend-migration.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";
import { frontendWriterInventory } from "./frontend-writer-inventory.mjs";
import { bootstrapFrontendAdmission } from "./frontend-admission-bootstrap.mjs";
import { changeFrontendAdmission, observeFrontendDrain } from "./frontend-admission.mjs";
import { retireHistoricalFrontendLogins } from "./frontend-historical-logins.mjs";
import { frontendCoordinationHash, prepareFrontendReleaseInventory, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { frontendReleaseReceiptStore } from "./frontend-release-receipts.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const demand = ok => { if (!ok) throw new Error("FRONTEND_RELEASE_COORDINATION_REFUSED"); };
const immutable = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };

// The fixed adapter is intentionally absent until an exhaustive real provider
// inventory and its reviewed implementation exist. Neither input JSON nor an
// arbitrary callback can substitute a successful-looking fence certificate.
export async function loadFrontendReleaseAdapters(sourceRoot, expectedSha256) {
  const relative = "ops/platform/frontend-release-adapters.mjs", path = join(sourceRoot, relative);
  for (const part of ["ops", "ops/platform", relative]) demand(!lstatSync(join(sourceRoot, part)).isSymbolicLink());
  const bytes = readFileSync(path);
  demand(bytes.length > 0 && bytes.length <= 2_000_000 && frontendCoordinationHash(bytes) === expectedSha256);
  const adapters = await import(`${pathToFileURL(path).href}?source=${expectedSha256}`);
  demand(frontendCoordinationHash(readFileSync(path)) === expectedSha256 &&
    ["fenceFrontendExternalProducers", "observeFrontendExternalFences", "deployCompatibleFrontend", "observeCompatibleFrontend"].every(key => typeof adapters[key] === "function"));
  return adapters;
}

export function prepareFrontendReleaseCoordination(candidate, job, baseline, inventory, source = frontendWriterInventory(root)) {
  const migration = prepareFrontendMigration(candidate, job, baseline);
  const plan = prepareFrontendReleaseInventory(inventory, migration, source);
  // Existing admission closure needs a writable control transaction as well.
  // The established current-only runner remains read-only and is unchanged.
  demand(job.target.approvedPendingTags.length > 0);
  return { migration, plan, inventorySha256: frontendCoordinationHash(plan) };
}

function deploymentProof(plan, result) {
  demand(result?.version === 1 && result.actionId === plan.actionId && result.sourceCommit === plan.sourceCommit &&
    result.environment === plan.environment && result.targetSha256 === plan.targetSha256 &&
    result.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" && typeof result.deploymentId === "string" && /^dpl_[A-Za-z0-9]+$/u.test(result.deploymentId) &&
    result.readyState === "READY" && result.aliasJobState === "succeeded" && result.aliasDeploymentId === result.deploymentId &&
    result.nativeSchedulesEnabled === false && result.admissionNewWork === false && result.admissionRecovery === false &&
    result.workloadVerified === true && typeof result.workloadReceiptSha256 === "string" && /^[a-f0-9]{64}$/u.test(result.workloadReceiptSha256) &&
    Buffer.isBuffer(result.evidence) && result.evidence.length > 0 && result.evidence.length <= 2_000_000 &&
    frontendCoordinationHash(result.evidence) === result.evidenceSha256);
  const evidence = JSON.parse(result.evidence.toString("utf8"));
  demand(["version", "actionId", "sourceCommit", "environment", "targetSha256", "projectId", "deploymentId", "readyState", "aliasJobState", "aliasDeploymentId",
    "nativeSchedulesEnabled", "admissionNewWork", "admissionRecovery", "workloadVerified", "workloadReceiptSha256"].every(key => evidence[key] === result[key]));
  return Object.fromEntries(["version", "actionId", "sourceCommit", "environment", "targetSha256", "projectId", "deploymentId", "readyState", "aliasJobState", "aliasDeploymentId",
    "nativeSchedulesEnabled", "admissionNewWork", "admissionRecovery", "workloadVerified", "workloadReceiptSha256", "evidenceSha256"].map(key => [key, result[key]]));
}

export async function runFrontendReleaseCoordination(prepared, dependencies) {
  // Reconstruct preparation: mutated prepared objects must not bypass policy.
  const fresh = prepareFrontendReleaseCoordination(prepared.migration.candidate, prepared.migration.job, prepared.migration.baseline, prepared.plan);
  const { migration, plan, inventorySha256 } = fresh;
  demand(inventorySha256 === prepared.inventorySha256 && dependencies?.confirmation === `staging/${plan.actionId}` &&
    typeof dependencies.getUrl === "function");
  immutable(plan);
  const store = frontendReleaseReceiptStore(dependencies.directory);
  const base = { version: 1, environment: plan.environment, actionId: plan.actionId, sourceCommit: plan.sourceCommit,
    targetSha256: plan.targetSha256, inventorySha256, adaptersSha256: plan.adaptersSha256,
    trafficAuthorized: false, migrationAuthorized: false, admissionRestored: false, nativeSchedulesRestored: false };
  let phase = "source-and-adapter-preflight", intentRecorded = false, databaseVerified = false, frontendVerified = false, frontendMutationAttempted = false;
  let epoch = plan.expectedEpoch, outcome;
  const assertSource = dependencies.assertSource ?? assertSourceCheckout;
  try {
    assertSource(root, plan.sourceCommit);
    const adapters = await loadFrontendReleaseAdapters(root, plan.adaptersSha256);
    await store.record("frontend-release-started.json", { ...base, status: "FRONTEND_RELEASE_COORDINATION_STARTED" }); intentRecorded = true;
    phase = "environment-release-lock";
    await withFrontendEnvironmentLock(async (verifyEnvironment, environmentSignal) => {
      const verifySource = async () => { await verifyEnvironment(); assertSource(root, plan.sourceCommit); };
      const observeFences = async checkpoint => {
        await verifyEnvironment();
        const nonce = randomBytes(32).toString("hex");
        const result = await adapters.observeFrontendExternalFences(Object.freeze({ plan, inventorySha256, nonce, checkpoint }));
        const proof = await validateFrontendFenceObservation(plan, nonce, result, store.retain);
        await verifyEnvironment();
        await store.record(`external-fences-${checkpoint}.json`, proof);
      };
      const owner = async (client, verifySession, work) => {
        await verifyEnvironment(); await verifySession();
        const actual = (await client.query(`SELECT oid::text FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin AND NOT rolinherit
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls`, [plan.owner.name])).rows;
        demand(actual.length === 1 && actual[0].oid === plan.owner.oid);
        await client.query(`SET ROLE "${plan.owner.name}"`);
        try { return await work(); }
        finally { await client.query("RESET ROLE"); await verifySession(); await verifyEnvironment(); }
      };
      const target = { environment: plan.environment, targetSha256: plan.targetSha256 };
      phase = "locked-database-stage";
      let databaseClient, admissionClient;
      const fenceLostEnvironment = () => { try { if (databaseClient) void Promise.resolve(databaseClient.end()).catch(() => {}); } catch { /* sticky lost lease refuses progress */ } };
      environmentSignal.addEventListener("abort", fenceLostEnvironment, { once: true });
      try { await runFrontendMigration(migration, {
        confirmation: dependencies.confirmation, getUrl: dependencies.getUrl,
        createClient(options) {
          demand(!environmentSignal.aborted);
          databaseClient = (dependencies.createClient ?? (options => new Client(options)))(options);
          return databaseClient;
        },
        assertSource: (...args) => { assertSource(...args); }, record: store.record,
        async beforeDatabasePreflight({ client, verifySession }) {
          admissionClient = client;
          const verify = async () => { await verifyEnvironment(); await verifySession(); };
          if (plan.admissionMode === "bootstrap") {
            phase = "closed-admission-bootstrap";
            await bootstrapFrontendAdmission({ version: 1, environment: plan.environment, actionId: plan.actionId,
              sourceCommit: plan.sourceCommit, sqlSha256: plan.bootstrapSqlSha256, inventorySha256, targetSha256: plan.targetSha256,
              target: migration.job.target, owner: plan.owner,
              producers: plan.producers.map(p => ({ ...p, sourceCommit: plan.sourceCommit })) }, client,
            { confirmation: dependencies.confirmation, verifySession: verify, record: store.record });
          }
          phase = "new-work-closure";
          const started = performance.now(), deadline = started + plan.observationBudgetSeconds * 1000;
          const current = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
          const flags = await owner(client, verifySession, () => changeFrontendAdmission(client, target, epoch, { newWork: false, recovery: current.recovery }));
          epoch = flags.epoch;
          await store.record("admission-new-work-closed.json", { ...base, epoch, recovery: flags.recovery });
          phase = "external-producer-fencing";
          await adapters.fenceFrontendExternalProducers(Object.freeze({ plan, inventorySha256, deadline,
            environmentSignal, verifyLockedSession: verify, record: store.record, retain: store.retain }));
          await verify(); demand(performance.now() <= deadline);
          phase = "historical-database-login-retirement";
          await retireHistoricalFrontendLogins(plan.historicalLogins, client, { confirmation: dependencies.confirmation, record: store.record });
          await verify(); demand(performance.now() <= deadline);
          phase = "eligible-recovery-drain";
          while (true) {
            await verify();
            const observed = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
            demand(performance.now() <= deadline);
            if (observed.active === 0 && observed.uncertain === 0) break;
            const remaining = deadline - performance.now(); demand(remaining > 0);
            await sleep(Math.min(1000, remaining));
          }
          phase = "recovery-closure";
          epoch = (await owner(client, verifySession, () => changeFrontendAdmission(client, target, epoch, { newWork: false, recovery: false }))).epoch;
          const drain = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
          demand(drain.ledgerDrained === true && drain.active === 0 && drain.uncertain === 0 && performance.now() <= deadline);
          await store.record("admission-drained.json", { ...base, ...drain });
          phase = "current-source-producer-verification";
          const registered = await owner(client, verifySession, async () => {
            const rows = (await client.query("SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256")).rows;
            demand(rows.length === plan.producers.length && rows.every((row, i) => row.producer_sha256 === plan.producers[i].producerSha256 &&
              row.source_sha === plan.sourceCommit && row.role_oid === plan.producers[i].role.oid));
            const roles = [...new Map(plan.producers.map(p => [p.role.name, p.role])).values()];
            const actual = (await client.query(`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
              FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [roles.map(role => role.name)])).rows;
            demand(actual.length === roles.length && actual.every(row => roles.some(role => role.name === row.rolname && role.oid === row.oid) && row.rolcanlogin === true &&
              ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"].every(key => row[key] === false)));
            return rows;
          });
          await store.record("admission-producers-verified.json", { ...base, producers: registered.length, registrationSha256: frontendCoordinationHash(registered) });
          phase = "independent-external-fence-observation";
          await observeFences("before-sql"); await verify(); demand(performance.now() <= deadline);
          await verifySource(); demand(performance.now() <= deadline);
          // The core immediately rechecks physical liveness/lock before its
          // lineage preflight. A drain receipt alone is never SQL authority.
          phase = "reviewed-forward-sql";
        },
        async afterDatabaseVerified(database, verifySession) {
          databaseVerified = true; phase = "compatible-frontend-deployment";
          const verify = async () => { await verifyEnvironment(); await verifySession(); };
          await verify();
          const beforeDeployDrain = await owner(admissionClient, verifySession, () => observeFrontendDrain(admissionClient, target, epoch));
          demand(beforeDeployDrain.ledgerDrained === true && beforeDeployDrain.active === 0 && beforeDeployDrain.uncertain === 0);
          frontendMutationAttempted = true;
          await adapters.deployCompatibleFrontend(Object.freeze({ plan, inventorySha256, database,
            environmentSignal, verifyLockedSession: verify, record: store.record, retain: store.retain }));
          await verify(); phase = "independent-compatible-frontend-observation";
          const observed = await adapters.observeCompatibleFrontend(Object.freeze({ plan, inventorySha256, database }));
          const proof = deploymentProof(plan, observed);
          await store.retain(`${randomBytes(32).toString("hex")}-${proof.evidenceSha256}.json`, observed.evidence);
          await store.record("compatible-frontend-verified.json", proof);
          frontendVerified = true;
          const afterDeployDrain = await owner(admissionClient, verifySession, () => observeFrontendDrain(admissionClient, target, epoch));
          demand(afterDeployDrain.ledgerDrained === true && afterDeployDrain.active === 0 && afterDeployDrain.uncertain === 0);
          await store.record("admission-post-deployment-drained.json", { ...base, ...afterDeployDrain });
          await observeFences("after-promotion"); await verifySource(); await verify();
        },
      }); } finally { environmentSignal.removeEventListener("abort", fenceLostEnvironment); }
      phase = "locked-final-verification"; await verifyEnvironment();
      outcome = { ...base, status: "FRONTEND_SQL_AND_COMPATIBLE_DEPLOYMENT_VERIFIED_HELD", databaseVerified, frontendVerified,
        databaseOutcome: "verified", frontendDomainsPromoted: true, epoch, wholeReleaseAccepted: false, phase: "completed" };
      await store.record("frontend-release-held.json", outcome);
    }, dependencies.lockPath ? { path: dependencies.lockPath } : {});
    phase = "completed";
    await store.record("frontend-release-outcome.json", outcome); return outcome;
  } catch {
    try { if (intentRecorded) await store.record("frontend-release-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase, epoch,
      databaseVerified, databaseOutcome: databaseVerified ? "verified" : "unverified", frontendVerified,
      frontendDomainsPromoted: frontendVerified ? true : frontendMutationAttempted ? null : false,
      sqlReplayAuthorized: false }); } catch { /* preserve original partial successes */ }
    throw new Error("FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED");
  }
}
