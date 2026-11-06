// In-process staging component. The legacy staging entrypoint deliberately does
// not call this module. No CLI, provider credentials or automatic restoration.
import { isDeepStrictEqual } from "node:util";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { restoreFrontendAdmission } from "./frontend-release-restoration.mjs";
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
import { observeFrontendBootstrapSchema } from "./frontend-bootstrap-compatibility.mjs";
import { observeFrontendOperationalProviderInventory } from "./frontend-operational-provider-inventory.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const demand = ok => { if (!ok) throw new Error("FRONTEND_RELEASE_COORDINATION_REFUSED"); };
const immutable = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };

// Neither input JSON nor an arbitrary callback can substitute source-qualified
// controls or observations for the source-owned final fence predicate.
export async function loadFrontendReleaseAdapters(sourceRoot, expectedSha256) {
  const relative = "ops/platform/frontend-release-adapters.mjs", path = join(sourceRoot, relative);
  for (const part of ["ops", "ops/platform", relative]) demand(!lstatSync(join(sourceRoot, part)).isSymbolicLink());
  const bytes = readFileSync(path);
  demand(bytes.length > 0 && bytes.length <= 2_000_000 && frontendCoordinationHash(bytes) === expectedSha256);
  const adapters = await import(`${pathToFileURL(path).href}?source=${expectedSha256}`);
  demand(frontendCoordinationHash(readFileSync(path)) === expectedSha256 &&
    ["fenceFrontendExternalProducers", "reconcileFrontendExternalProducers", "observeFrontendExternalFences", "deployCompatibleFrontend", "observeCompatibleFrontend",
      "deployAdmissionCompatibleFrontend", "observeAdmissionCompatibleFrontend"].every(key => typeof adapters[key] === "function"));
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

function deploymentProof(plan, result, { bootstrap = false } = {}) {
  const certification = bootstrap ? undefined : plan.certification;
  const runtimeProducer = plan.runtimeProducerSha256 ?? plan.bootstrapCompatibility?.runtimeProducerSha256;
  demand(result?.version === 1 && result.actionId === plan.actionId && result.sourceCommit === plan.sourceCommit &&
    result.environment === plan.environment && result.targetSha256 === plan.targetSha256 &&
    result.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" && typeof result.deploymentId === "string" && /^dpl_[A-Za-z0-9]+$/u.test(result.deploymentId) &&
    result.readyState === "READY" && result.aliasJobState === "succeeded" && result.aliasDeploymentId === result.deploymentId &&
    result.nativeSchedulesEnabled === false && result.admissionNewWork === false && result.admissionRecovery === false &&
    result.workloadVerified === true && typeof result.workloadReceiptSha256 === "string" && /^[a-f0-9]{64}$/u.test(result.workloadReceiptSha256) &&
    Buffer.isBuffer(result.evidence) && result.evidence.length > 0 && result.evidence.length <= 2_000_000 &&
    frontendCoordinationHash(result.evidence) === result.evidenceSha256);
  const evidence = JSON.parse(result.evidence.toString("utf8"));
  if (certification) demand(isDeepStrictEqual(result.featureControls, certification.featureControls) &&
    isDeepStrictEqual(evidence.featureControls, certification.featureControls) &&
    isDeepStrictEqual(result.certificationSchedule, evidence.certificationSchedule) &&
    result.certificationSchedule?.path === "/api/cron/account-lifecycle" && result.certificationSchedule.schedule === "* * * * *" &&
    result.certificationSchedule.deploymentId === result.deploymentId && result.certificationSchedule.nativeEnabled === false &&
    /^[a-z0-9-]+\.vercel\.app$/u.test(result.certificationSchedule.host ?? "") &&
    /^[a-f0-9]{64}$/u.test(result.certificationSchedule.definitionsSha256 ?? "") &&
    isDeepStrictEqual(result.writerAdmissionBinding, evidence.writerAdmissionBinding) &&
    isDeepStrictEqual(result.writerAdmissionBinding, { mode: "enforce", targetSha256: plan.targetSha256,
      producerSha256: runtimeProducer, sourceCommit: plan.sourceCommit,
      roleName: plan.producers.find(producer => producer.producerSha256 === runtimeProducer)?.role.name }) &&
    result.configurationRecordSha256 === result.workloadReceiptSha256 && evidence.configurationRecordSha256 === result.configurationRecordSha256);
  demand(["version", "actionId", "sourceCommit", "environment", "targetSha256", "projectId", "deploymentId", "readyState", "aliasJobState", "aliasDeploymentId",
    "nativeSchedulesEnabled", "admissionNewWork", "admissionRecovery", "workloadVerified", "workloadReceiptSha256"].every(key => evidence[key] === result[key]));
  return { ...Object.fromEntries(["version", "actionId", "sourceCommit", "environment", "targetSha256", "projectId", "deploymentId", "readyState", "aliasJobState", "aliasDeploymentId",
    "nativeSchedulesEnabled", "admissionNewWork", "admissionRecovery", "workloadVerified", "workloadReceiptSha256", "evidenceSha256"].map(key => [key, result[key]])),
    ...(certification ? { featureControls: structuredClone(result.featureControls), certificationSchedule: structuredClone(result.certificationSchedule),
      writerAdmissionBinding: structuredClone(result.writerAdmissionBinding), configurationRecordSha256: result.configurationRecordSha256 } : {}) };
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
    ...(plan.rolePreparationProofSha256 ? { rolePreparationProofSha256: plan.rolePreparationProofSha256 } : {}),
    trafficAuthorized: false, migrationAuthorized: false, admissionRestored: false, nativeSchedulesRestored: false };
  let phase = "source-and-adapter-preflight", intentRecorded = false, databaseVerified = false, frontendVerified = false, frontendMutationAttempted = false;
  let bootstrapFrontendMutationAttempted = false, bootstrapFrontendVerified = false;
  let epoch = plan.expectedEpoch, outcome, restored, restorationAttempted = false;
  const assertSource = dependencies.assertSource ?? assertSourceCheckout;
  try {
    assertSource(root, plan.sourceCommit);
    const adapters = await loadFrontendReleaseAdapters(root, plan.adaptersSha256);
    await store.record("frontend-release-started.json", { ...base, status: "FRONTEND_RELEASE_COORDINATION_STARTED" }); intentRecorded = true;
    phase = "environment-release-lock";
    await (dependencies.withEnvironmentLock ?? withFrontendEnvironmentLock)(async (verifyEnvironment, environmentSignal, apiRuntime) => {
      demand(apiRuntime === undefined || ["start", "frontendVerified", "prepareClose", "finish"].every(key => typeof apiRuntime[key] === "function"));
      const verifySource = async () => { await verifyEnvironment(); assertSource(root, plan.sourceCommit); };
      const providerContext = { candidate: migration.candidate, directory: dependencies.directory,
        bootstrapRuntimeTarget: { environment: plan.environment, targetSha256: plan.targetSha256,
          host: migration.job.target.host, port: migration.job.target.port, database: migration.job.target.database,
          user: migration.job.target.runtimeRole, serverMajor: migration.job.target.serverMajor },
        getProviderContext: dependencies.getProviderContext };
      const observeFences = async (checkpoint, verifyLockedSession) => {
        await verifyEnvironment();
        const nonce = randomBytes(32).toString("hex");
        const result = await adapters.observeFrontendExternalFences(Object.freeze({ plan, inventorySha256, nonce, checkpoint, ...providerContext,
          databaseClient, verifyLockedSession, environmentSignal }));
        // Retain honest unknown observations before enforcing the unchanged
        // strict predicate. Retaining evidence never authorizes application SQL.
        const proof = await validateFrontendFenceObservation(plan, nonce, result, store.retain, { requireFenced: false });
        await verifyEnvironment();
        await store.record(`external-fences-${checkpoint}.json`, proof);
        await validateFrontendFenceObservation(plan, nonce, result, async () => {});
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
      let databaseClient, admissionClient, verifiedDeployment;
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
            phase = "preapplication-schema-verification";
            const preapplicationSchema = await observeFrontendBootstrapSchema(client, plan, migration, verify);
            await store.record("frontend-preapplication-schema.json", preapplicationSchema);
            const admission = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
            demand(admission.newWork === false && admission.recovery === false && admission.ledgerDrained === true);
            phase = "admission-compatible-bootstrap-deployment";
            bootstrapFrontendMutationAttempted = true;
            await adapters.deployAdmissionCompatibleFrontend(Object.freeze({ plan, inventorySha256, preapplicationSchema,
              admissionObservation: admission, verifyLockedSession: verify, environmentSignal, ...providerContext }));
            await verify();
            const after = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
            demand(after.newWork === false && after.recovery === false && after.ledgerDrained === true);
            const observed = await adapters.observeAdmissionCompatibleFrontend(Object.freeze({ plan, inventorySha256, preapplicationSchema,
              admissionObservation: after, verifyLockedSession: verify, environmentSignal, ...providerContext }));
            const proof = deploymentProof(plan, observed, { bootstrap: true });
            demand(observed.bootstrapAdmissionVerified === true && observed.schemaCatalogSha256 === preapplicationSchema.schemaCatalogSha256 &&
              observed.appliedLineageSha256 === preapplicationSchema.appliedLineageSha256);
            const evidence = JSON.parse(observed.evidence.toString("utf8"));
            demand(["bootstrapAdmissionVerified", "schemaCatalogSha256", "appliedLineageSha256"].every(key => evidence[key] === observed[key]));
            const rechecked = await observeFrontendBootstrapSchema(client, plan, migration, verify);
            demand(frontendCoordinationHash(rechecked) === frontendCoordinationHash(preapplicationSchema));
            await store.retain(`${randomBytes(32).toString("hex")}-${proof.evidenceSha256}.json`, observed.evidence);
            await store.record("frontend-bootstrap-compatible-verified.json", { ...proof, schemaCatalogSha256: rechecked.schemaCatalogSha256,
              appliedLineageSha256: rechecked.appliedLineageSha256, bootstrapAdmissionVerified: true });
            bootstrapFrontendVerified = true;
            // The reviewed recovery-only stage is explicit and follows actual
            // compatible promotion. Failure never automatically reopens it.
            if (plan.bootstrapCompatibility.recoveryAfterCompatibleBuild) {
              phase = "reviewed-bootstrap-eligible-recovery";
              epoch = (await owner(client, verifySession, () => changeFrontendAdmission(client, target, epoch, { newWork: false, recovery: true }))).epoch;
              await store.record("frontend-bootstrap-recovery-enabled.json", { ...base, epoch, newWork: false, recovery: true });
            }
          }
          phase = "new-work-closure";
          const started = performance.now(), deadline = started + plan.observationBudgetSeconds * 1000;
          const current = await owner(client, verifySession, () => observeFrontendDrain(client, target, epoch));
          const flags = await owner(client, verifySession, () => changeFrontendAdmission(client, target, epoch, { newWork: false, recovery: current.recovery }));
          epoch = flags.epoch;
          await store.record("admission-new-work-closed.json", { ...base, epoch, recovery: flags.recovery });
          phase = "operational-provider-binding-inventory";
          const providerInventory = await observeFrontendOperationalProviderInventory(client, verify);
          await store.record("frontend-operational-provider-inventory-before-fence.json", { ...base, ...providerInventory });
          phase = "external-producer-fencing";
          await adapters.fenceFrontendExternalProducers(Object.freeze({ plan, inventorySha256, deadline,
            environmentSignal, verifyLockedSession: verify, record: store.record, retain: store.retain,
            admissionObservation: { ...current, ...flags }, databaseClient: client, ...providerContext }));
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
          const drainedProviderInventory = await observeFrontendOperationalProviderInventory(client, verify);
          await store.record("frontend-operational-provider-inventory-after-drain.json", { ...base, ...drainedProviderInventory });
          phase = "selected-provider-retirement-and-effect-reconciliation";
          await adapters.reconcileFrontendExternalProducers(Object.freeze({ plan, inventorySha256, deadline,
            environmentSignal, verifyLockedSession: verify, record: store.record, retain: store.retain,
            admissionObservation: drain, databaseClient: client, ...providerContext }));
          await verify(); demand(performance.now() <= deadline);
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
          await observeFences("before-sql", verify); await verify(); demand(performance.now() <= deadline);
          await verifySource(); demand(performance.now() <= deadline);
          // The core immediately rechecks physical liveness/lock before its
          // lineage preflight. A drain receipt alone is never SQL authority.
          phase = "reviewed-forward-sql";
        },
        async afterDatabaseVerified(database, verifySession) {
          databaseVerified = true; phase = "compatible-frontend-deployment";
          const verify = async () => { await verifyEnvironment(); await verifySession(); };
          await verify();
          if (apiRuntime) {
            phase = "locked-api-migration-and-runtime";
            await apiRuntime.start({ database, client: admissionClient, verifySession, verify });
            await verify(); phase = "compatible-frontend-deployment";
          }
          const beforeDeployDrain = await owner(admissionClient, verifySession, () => observeFrontendDrain(admissionClient, target, epoch));
          demand(beforeDeployDrain.ledgerDrained === true && beforeDeployDrain.active === 0 && beforeDeployDrain.uncertain === 0);
          frontendMutationAttempted = true;
          await adapters.deployCompatibleFrontend(Object.freeze({ plan, inventorySha256, database,
            environmentSignal, verifyLockedSession: verify, record: store.record, retain: store.retain,
            admissionObservation: beforeDeployDrain, ...providerContext }));
          await verify(); phase = "independent-compatible-frontend-observation";
          const afterDeployDrain = await owner(admissionClient, verifySession, () => observeFrontendDrain(admissionClient, target, epoch));
          demand(afterDeployDrain.ledgerDrained === true && afterDeployDrain.active === 0 && afterDeployDrain.uncertain === 0);
          const observed = await adapters.observeCompatibleFrontend(Object.freeze({ plan, inventorySha256, database,
            verifyLockedSession: verify, environmentSignal, admissionObservation: afterDeployDrain, ...providerContext }));
          const proof = deploymentProof(plan, observed);
          await store.retain(`${randomBytes(32).toString("hex")}-${proof.evidenceSha256}.json`, observed.evidence);
          await store.record("compatible-frontend-verified.json", proof); verifiedDeployment = proof;
          if (apiRuntime) { await apiRuntime.frontendVerified(proof, verify); await verify(); }
          frontendVerified = true;
          await store.record("admission-post-deployment-drained.json", { ...base, ...afterDeployDrain });
          await observeFences("after-promotion", verify); await verifySource(); await verify();
        },
        afterContinuationVerified: plan.restoration === undefined && !apiRuntime ? undefined : async ({ database, verifySession }) => {
          const verify = async () => { await verifyEnvironment(); await verifySession(); };
          const proof = verifiedDeployment;
          if (plan.restoration !== undefined) {
            demand(typeof adapters.observeFrontendRestorationBoundary === "function");
            phase = "deliberate-admission-restoration"; restorationAttempted = true;
            restored = await restoreFrontendAdmission(plan, admissionClient, epoch, {
              verifySession: verify, record: store.record,
              withOwner: work => owner(admissionClient, verifySession, work),
              async verifyBoundary(stage, admission) {
                await verifySource(); await verify();
                demand(isDeepStrictEqual(await readMigrationCatalog(admissionClient), migration.baseline.catalog) &&
                  isDeepStrictEqual((await admissionClient.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at asc nulls first, id asc")).rows, database.after));
                await observeFences(stage, verify);
                const boundaryContext = Object.freeze({ plan, inventorySha256, database,
                  admissionObservation: admission, verifyLockedSession: verify, environmentSignal, ...providerContext });
                const actual = apiRuntime?.observeRestorationBoundary ?
                  await apiRuntime.observeRestorationBoundary(await adapters.observeCompatibleFrontend(boundaryContext), boundaryContext) :
                  await adapters.observeFrontendRestorationBoundary(boundaryContext);
                demand(Buffer.isBuffer(actual.evidence) && actual.evidence.length > 0 && actual.evidence.length <= 2_000_000 &&
                  frontendCoordinationHash(actual.evidence) === actual.evidenceSha256);
                const value = JSON.parse(actual.evidence.toString("utf8"));
                demand(value.status === "FRONTEND_RESTORATION_BOUNDARY_OBSERVED" && value.environment === plan.environment &&
                  value.actionId === plan.actionId && value.sourceCommit === plan.sourceCommit && value.targetSha256 === plan.targetSha256);
                const frontend = value.frontend, gateway = value.gateway;
                demand(frontend?.deploymentId === proof.deploymentId && frontend.aliasDeploymentId === proof.deploymentId && frontend.readyState === "READY" &&
                  frontend.aliasJobState === "succeeded" && frontend.aliasJobMatchesIntent === true && frontend.aliasJobType === "promote" &&
                  frontend.workloadVerified === true && frontend.workloadReceiptSha256 === proof.workloadReceiptSha256 && frontend.nativeSchedulesEnabled === false &&
                  frontend.admissionNewWork === admission.newWork && frontend.admissionRecovery === admission.recovery);
                demand(gateway?.status === "FRONTEND_RESTORATION_GATEWAY_OBSERVED" && gateway.gatewayMutated === false &&
                  frontendCoordinationHash(gateway.binding) === plan.restoration.gatewayBindingSha256 &&
                  gateway.admission?.newWork === plan.restoration.newWork && gateway.admission.recovery === plan.restoration.recovery &&
                  gateway.admission.uncertain?.newWork === 0 && gateway.admission.uncertain?.recovery === 0);
                await store.record(`${stage}-boundary.json`, { version: 1, actionId: plan.actionId, sourceCommit: plan.sourceCommit,
                  targetSha256: plan.targetSha256, evidenceSha256: actual.evidenceSha256, frontend, gateway });
                await store.retain(`${randomBytes(32).toString("hex")}-${actual.evidenceSha256}.json`, actual.evidence);
                await verify();
              },
            });
            epoch = restored.epoch;
          }
          if (apiRuntime) { await verify(); await apiRuntime.prepareClose(verify); await verify(); }
        },
      }); } finally { environmentSignal.removeEventListener("abort", fenceLostEnvironment); }
      phase = "locked-final-verification"; await verifyEnvironment();
      outcome = { ...base, status: restored ? "FRONTEND_SQL_COMPATIBLE_DEPLOYMENT_AND_ADMISSION_RESTORED" : "FRONTEND_SQL_AND_COMPATIBLE_DEPLOYMENT_VERIFIED_HELD", databaseVerified, frontendVerified,
        ...(restored ? { admissionRestored: true, admissionNewWork: restored.newWork, admissionRecovery: restored.recovery } : {}),
        databaseOutcome: "verified", frontendDomainsPromoted: true, epoch, wholeReleaseAccepted: false, phase: "completed" };
      await store.record("frontend-release-held.json", outcome);
      if (apiRuntime) await apiRuntime.finish(outcome, verifyEnvironment);
    }, dependencies.lockPath ? { path: dependencies.lockPath } : {});
    phase = "completed";
    await store.record("frontend-release-outcome.json", outcome); return outcome;
  } catch {
    try { if (intentRecorded) await store.record("frontend-release-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW", phase, epoch,
      databaseVerified, databaseOutcome: databaseVerified ? "verified" : "unverified", frontendVerified,
      frontendDomainsPromoted: frontendVerified ? true : frontendMutationAttempted ? null : false,
      bootstrapFrontendVerified, bootstrapFrontendDomainsPromoted: bootstrapFrontendVerified ? true : bootstrapFrontendMutationAttempted ? null : false,
      restorationAttempted, ...(restorationAttempted ? { admissionNewWork: null, admissionRecovery: null } : {}), sqlReplayAuthorized: false }); } catch { /* preserve original partial successes */ }
    throw new Error("FRONTEND_RELEASE_COORDINATION_FAILED_REVIEW_REQUIRED");
  }
}
