// The immutable original configuration stays private. Source/configuration
// closures are emitted only by the checked Git/profile and SQL collector.
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { verifiedSourceRequirements, prepareHistoricalSourceOriginalConfiguration,
  historicalSourceSqlCredentialQueryPlan, observeHistoricalSourceSqlCredentials,
  deriveHistoricalSourceCapabilityClosures } from "./frontend-historical-source.mjs";
const repository = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const demand = ok => { if (!ok) throw new Error("FRONTEND_HISTORICAL_SOURCE_OBSERVATION_REFUSED"); };
const privateValues = new WeakMap();

export function frontendHistoricalSourceRequirements(binding) {
  const requirements = verifiedSourceRequirements(repository, binding.sourceCommit);
  demand(binding.sourceConfiguration);
  return requirements;
}

export async function observeFrontendHistoricalSourceContexts(context, bindings, privateRuntime, dependencies = {}) {
  try {
    const verify = context.verifyLockedSession, parent = context.databaseClient;
    demand(parent && typeof verify === "function");
    const result = { version: 1, actionId: context.plan.actionId, sourceCommit: context.plan.sourceCommit,
      targetSha256: context.plan.targetSha256, providerBindingsSha256: context.plan.providerBindingsSha256,
      bindings: [], missingSurfaceSha256: [], rawInvocationCount: null };
    let pinned = privateValues.get(context.getProviderContext);
    if (!pinned) { pinned = new Map(); privateValues.set(context.getProviderContext, pinned); }
    for (const surface of bindings.surfaces.filter(row => ["deployment", "direct-caller"].includes(row.kind))) {
      const binding = bindings.historicalRuntimeBindings?.find(row => row.surfaceSha256 === surface.surfaceSha256);
      const original = privateRuntime.historicalRuntimeConfigurations?.[surface.surfaceSha256];
      if (!binding?.sourceConfiguration || !original) { result.missingSurfaceSha256.push(surface.surfaceSha256); continue; }
      const source = frontendHistoricalSourceRequirements(binding);
      const prepared = prepareHistoricalSourceOriginalConfiguration(source, binding, original);
      const pin = `${context.plan.actionId}:${surface.surfaceSha256}:${binding.configurationRecordSha256}`;
      const values = Object.entries(original.environment);
      if (pinned.has(pin)) {
        const before = pinned.get(pin); demand(before.length === values.length && before.every(([key, value]) => original.environment[key] === value));
      } else pinned.set(pin, values);
      const markers = Array.from({ length: 4 }, () => (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn).toString());
      const clients = new Map(), physical = new Map(), locks = [], facts = [];
      let failed = false;
      const make = dependencies.createClient ?? (options => new Client(options));
      try {
        await verify();
        const selectedPid = (await parent.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        demand(Number.isInteger(selectedPid));
        for (const marker of markers) { await parent.query("SELECT pg_advisory_lock($1::bigint)", [marker]); locks.push([parent, marker]); }
        for (const key of prepared.configuredSqlKeys) {
          const url = new URL(original.environment[key]);
          demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && !url.hash && url.password &&
            ["require", "verify-full"].includes(url.searchParams.get("sslmode")) &&
            [...url.searchParams.keys()].every(key => ["sslmode", "channel_binding"].includes(key)));
          const client = make({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password), database: decodeURIComponent(url.pathname.slice(1)), ssl: { rejectUnauthorized: true },
            options: "-c default_transaction_read_only=on", application_name: "lash-her-original-source-metadata",
            connectionTimeoutMillis: 10000, query_timeout: 10000 });
          clients.set(key, client); client.on("error", () => { failed = true; });
          await verify(); await client.connect();
          demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
          const plan = historicalSourceSqlCredentialQueryPlan(source);
          const identity = (await client.query(plan.identity)).rows;
          demand(identity.length === 1 && Number.isInteger(identity[0].major));
          const same = (await client.query(plan.markers, [selectedPid, markers])).rows[0]?.count;
          demand(same === 0 || same === 4);
          let parentPid = selectedPid, selectedMarkers = markers;
          if (same === 0) {
            // Metadata only on an alternate physical target. Hold a fresh
            // four-marker namespace on this exact TLS credential connection;
            // never query application tables or retire this alternate role.
            parentPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
            demand(Number.isInteger(parentPid));
            selectedMarkers = Array.from({ length: 4 }, () => (randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn).toString());
            for (const marker of selectedMarkers) { await client.query("SELECT pg_advisory_lock($1::bigint)", [marker]); locks.push([client, marker]); }
          }
          physical.set(key, { database: identity[0].database, major: identity[0].major, parentPid, markers: selectedMarkers });
          facts.push({ key, sameSelectedPhysicalDatabase: same === 4,
            role: prepared.databaseRoles.find(row => row.key === key), database: identity[0].database, major: identity[0].major });
          await verify(); demand(!failed);
        }
        const sql = await observeHistoricalSourceSqlCredentials(source, { binding, originalConfiguration: original,
          clientsByKey: clients, physicalDatabasesByKey: physical, verifySession: verify });
        const closures = deriveHistoricalSourceCapabilityClosures(source, binding, original, sql);
        for (const fact of facts.filter(row => row.sameSelectedPhysicalDatabase)) demand(context.plan.historicalLogins.retiredLogins.some(role =>
          role.name === fact.role.name && role.oid === fact.role.oid));
        const selectedCount = (await parent.query(historicalSourceSqlCredentialQueryPlan(source).markers, [
          (await parent.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid, markers])).rows[0]?.count;
        demand(selectedCount === 4 && !failed); await verify();
        if (surface.kind === "deployment" && surface.identity.projectId !== bindings.projectId) {
          const deployment = bindings.relatedProjects?.find(project => project.projectId === surface.identity.projectId)?.deployments.find(row => row.deploymentId === surface.identity.deploymentId);
          demand(deployment && (deployment.target !== "production" || facts.every(row => row.sameSelectedPhysicalDatabase === false)));
        }
        const credentialKeys = { squareRetiredToken: "SQUARE_ACCESS_TOKEN", resendRetiredToken: "RESEND_API_KEY",
          chitchatsRetiredToken: "CHITCHATS_ACCESS_TOKEN",
          googleIdentityRetiredSecret: "AUTH_GOOGLE_SECRET", googleCalendarRetiredSecret: "GOOGLE_CLIENT_SECRET" };
        const providerCredentialBindings = binding.providerCredentials.map(row => ({ ...row,
          originalCredentialEqualityVerified: typeof privateRuntime[row.runtimeKey] === "string" && privateRuntime[row.runtimeKey].length > 0 &&
            original.environment[credentialKeys[row.runtimeKey]] === privateRuntime[row.runtimeKey] }));
        result.bindings.push({ surfaceSha256: binding.surfaceSha256, sourceCommit: binding.sourceCommit,
          configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: binding.sourceConfiguration.provenanceSha256,
          sourceInventorySha256: source.sourceInventorySha256, requirementsSha256: source.requirementsSha256,
          sqlEvidence: sql, sqlPhysicalBindings: facts, providerCredentialBindings, requirements: { ...source, ...closures } });
      } finally {
        let cleanupFailed = false;
        for (const [client, marker] of locks.reverse()) {
          try { demand((await client.query("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [marker])).rows[0]?.unlocked === true); }
          catch { cleanupFailed = true; }
        }
        for (const client of clients.values()) { try { await client.end(); } catch { cleanupFailed = true; } }
        await verify(); demand(!cleanupFailed);
      }
    }
    return result;
  } catch { throw new Error("FRONTEND_HISTORICAL_SOURCE_OBSERVATION_REFUSED"); }
}

export async function observeFrontendHistoricalSourceIntentCounts(context, before) {
  const tables = [...new Set((before?.bindings ?? []).flatMap(row => row.requirements?.providerFamilies ?? [])
    .flatMap(row => row.sqlIntentRequirements ?? []).flatMap(row => row.tables ?? []))].sort();
  demand(tables.length <= 128 && tables.every(name => /^[a-z_][a-z0-9_]{0,62}$/u.test(name)));
  const result = {};
  await context.verifyLockedSession();
  await context.databaseClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    for (const table of tables) {
      const exists = (await context.databaseClient.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`])).rows[0]?.present;
      result[table] = exists === true ? (await context.databaseClient.query(`SELECT count(*)::int AS count FROM (SELECT 1 FROM public."${table}" LIMIT 4097) source_rows`)).rows[0]?.count : null;
      demand(result[table] === null || Number.isInteger(result[table]) && result[table] >= 0 && result[table] <= 4097);
      await context.verifyLockedSession();
    }
  } finally { await context.databaseClient.query("ROLLBACK"); }
  await context.verifyLockedSession(); return result;
}
