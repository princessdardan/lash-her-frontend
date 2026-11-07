import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { assertAppliedMigrationLineage } from "../../src/lib/private-db/migration-lineage.ts";
import { FRONTEND_MIGRATION_LOCK, frontendConnectionOptions, frontendMigrationArtifact } from "./frontend-migration.mjs";
import { frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";

const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const credentialName = "FRONTEND_STAGING_MIGRATION_DATABASE_URL";
const observationFile = "frontend-lineage-observation.json";
const refusal = "FRONTEND_LINEAGE_OBSERVATION_REFUSED";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const demand = (condition, message = refusal) => { if (!condition) throw new Error(message); };
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const safeName = /^[A-Za-z0-9_-]{1,63}$/u;
const connectionIdentity = `select pg_catalog.pg_backend_pid() as pid,
  current_user as role, session_user as login, pg_catalog.current_database() as database,
  pg_catalog.current_setting('server_version_num')::int / 10000 as major,
  pg_catalog.current_setting('default_transaction_read_only') as default_read_only,
  (select oid::text from pg_catalog.pg_database where datname=pg_catalog.current_database()) as database_oid,
  (select oid::text from pg_catalog.pg_roles where rolname=session_user) as login_oid,
  (select backend_start::text from pg_catalog.pg_stat_activity where pid=pg_catalog.pg_backend_pid()) as backend_start`;
const heldMigrationLock = `select exists (
  select 1 from pg_catalog.pg_locks where locktype='advisory' and pid=pg_catalog.pg_backend_pid()
    and database=(select oid from pg_catalog.pg_database where datname=pg_catalog.current_database())
    and classid=((pg_catalog.hashtext($1)::bigint >> 32) & 4294967295)::oid
    and objid=(pg_catalog.hashtext($1)::bigint & 4294967295)::oid
    and objsubid=1 and mode='ExclusiveLock' and granted
) as held`;

export function validateFrontendLineageObservationRequest(request) {
  demand(exact(request, ["version", "qualificationTargetProfile", "sourceCommit", "target"]) && request.version === 1 &&
    matches(request.sourceCommit, /^[a-f0-9]{40}$/u) && !/^0+$/u.test(request.sourceCommit));
  const qualificationTargetProfile = requireQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, request);
  const { target } = request;
  demand(exact(target, ["host", "port", "database", "user", "serverMajor"]) &&
    matches(target.host, /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u) && !/pooler|pgbouncer/u.test(target.host) &&
    Number.isInteger(target.port) && target.port > 0 && target.port < 65536 &&
    matches(target.database, safeName) && matches(target.user, safeName) && [16, 18].includes(target.serverMajor));
  return Object.freeze({
    version: 1, qualificationTargetProfile, sourceCommit: request.sourceCommit,
    target: Object.freeze({ ...target }),
  });
}

async function readJournal(client, maximum) {
  const catalog = (await client.query(`select c.relkind, c.relpersistence,
    exists(select 1 from pg_catalog.pg_inherits i where c.oid in (i.inhrelid, i.inhparent)) as inherits
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='drizzle' and c.relname='__drizzle_migrations'`)).rows;
  if (catalog.length === 0) return { present: false, rows: [] };
  demand(catalog.length === 1 && catalog[0].relkind === "r" && catalog[0].relpersistence === "p" && !catalog[0].inherits,
    "FRONTEND_LINEAGE_JOURNAL_SHAPE_REFUSED");
  const rows = (await client.query(`select hash, created_at from drizzle.__drizzle_migrations
    order by created_at asc nulls first, id asc limit $1`, [maximum + 1])).rows;
  demand(rows.length <= maximum, "FRONTEND_LINEAGE_JOURNAL_LENGTH_REFUSED");
  return { present: true, rows };
}

function describeJournal(artifact, present, rows) {
  let latest;
  try { latest = assertAppliedMigrationLineage(artifact.expected, rows); }
  catch { throw new Error("FRONTEND_LINEAGE_HISTORY_REFUSED"); }
  const byTimestamp = new Map(artifact.expected.map((entry) => [entry.folderMillis, entry.tag]));
  const appliedPrefix = Object.freeze(rows.map(({ hash, created_at }) => Object.freeze({
    tag: byTimestamp.get(Number(created_at)), folderMillis: Number(created_at), hash,
  })));
  const pendingTags = Object.freeze(artifact.migrations.filter(({ folderMillis }) => folderMillis > latest).map(({ tag }) => tag));
  return {
    status: !present ? "FRONTEND_LINEAGE_JOURNAL_ABSENT" : rows.length === 0 ? "FRONTEND_LINEAGE_JOURNAL_EMPTY" :
      pendingTags.length ? "FRONTEND_LINEAGE_PENDING" : "FRONTEND_LINEAGE_CURRENT",
    journalPresent: present,
    appliedCount: appliedPrefix.length,
    lastApplied: appliedPrefix.at(-1) ?? null,
    appliedPrefix,
    appliedPrefixSha256: digest(appliedPrefix),
    pendingTags,
  };
}

export async function inspectFrontendMigrationLineage(input, readCredential) {
  const request = validateFrontendLineageObservationRequest(input);
  const { target, sourceCommit } = request;
  assertSourceCheckout(sourceRoot, sourceCommit);
  const artifact = frontendMigrationArtifact(sourceRoot);
  // Use the migration runner's exact direct URL/TLS checks and startup setting
  // for a read-only connection, regardless of the observed pending count.
  const options = frontendConnectionOptions(await readCredential(), { ...target, approvedPendingTags: [] });
  const client = new Client({ ...options, application_name: "lash-her-frontend-lineage-observation", query_timeout: 30_000 });
  let socketLost = false;
  client.on("error", () => { socketLost = true; });
  let locked = false, transaction = false, observation, failure;
  try {
    await client.connect();
    const readIdentity = async () => {
      demand(!socketLost && client.connection.stream.encrypted === true && client.connection.stream.authorized === true,
        "FRONTEND_LINEAGE_VERIFIED_TLS_REQUIRED");
      return (await client.query(connectionIdentity)).rows[0];
    };
    const identity = await readIdentity();
    demand(Number.isInteger(identity?.pid) && identity.pid > 0 && identity.role === target.user && identity.login === target.user &&
      identity.database === target.database && identity.major === target.serverMajor && identity.default_read_only === "on" &&
      matches(identity.database_oid, /^[1-9][0-9]*$/u) && matches(identity.login_oid, /^[1-9][0-9]*$/u) &&
      typeof identity.backend_start === "string" && identity.backend_start.length > 0, "FRONTEND_LINEAGE_TARGET_IDENTITY_REFUSED");
    locked = (await client.query("select pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) as locked", [FRONTEND_MIGRATION_LOCK])).rows[0]?.locked === true;
    demand(locked, "FRONTEND_LINEAGE_MIGRATION_LOCK_CONTENDED");
    const verifySession = async () => {
      demand(digest(await readIdentity()) === digest(identity) &&
        (await client.query(heldMigrationLock, [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true &&
        !socketLost, "FRONTEND_LINEAGE_SESSION_OR_LOCK_CHANGED");
    };
    await client.query("begin isolation level repeatable read read only");
    transaction = true;
    const transactionMode = (await client.query(`select pg_catalog.current_setting('transaction_read_only') as read_only,
      pg_catalog.current_setting('transaction_isolation') as isolation`)).rows[0];
    demand(transactionMode?.read_only === "on" && transactionMode.isolation === "repeatable read", "FRONTEND_LINEAGE_READ_ONLY_REQUIRED");
    await verifySession();
    const { present, rows } = await readJournal(client, artifact.expected.length);
    const journal = describeJournal(artifact, present, rows);
    await verifySession();
    await client.query("rollback");
    transaction = false;
    await verifySession();
    assertSourceCheckout(sourceRoot, sourceCommit);
    demand(frontendMigrationArtifact(sourceRoot).sqlArtifactSha256 === artifact.sqlArtifactSha256, "FRONTEND_LINEAGE_SOURCE_CHANGED");
    observation = Object.freeze({
      ...request, ...journal, service: "frontend", environment: "staging", observedAt: new Date().toISOString(),
      sqlArtifactSha256: artifact.sqlArtifactSha256, contractManifestSha256: artifact.contractManifestSha256,
      ...(artifact.contractPhase === "p2" ? { contractPhase: "p2", phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 } : {}),
      expectedMigrationCount: artifact.migrations.length, databaseOid: identity.database_oid, loginRoleOid: identity.login_oid,
      verifiedTls: true, readOnlyVerified: true, migrationLockVerified: true, samePhysicalSessionVerified: true,
      applicationSqlApplied: false, bootstrapAuthorized: false, migrationAuthorized: false, trafficAuthorized: false,
    });
  } catch (error) { failure = error; }
  finally {
    try {
      if (transaction) await client.query("rollback");
      if (locked) {
        demand((await client.query("select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) as unlocked",
          [FRONTEND_MIGRATION_LOCK])).rows[0]?.unlocked === true && !socketLost, "FRONTEND_LINEAGE_LOCK_RELEASE_UNVERIFIED");
      }
    } catch (error) { failure ??= error; }
    try { await client.end(); }
    catch (error) { failure ??= error; }
  }
  if (failure) {
    // A PostgreSQL error may contain values from an unexpected server. Only
    // return this observer's fixed errors to callers.
    if (failure.code === undefined && /^FRONTEND_LINEAGE_[A-Z_]+$/u.test(failure.message)) throw failure;
    throw new Error(refusal);
  }
  return observation;
}

async function main(argv) {
  try {
    const [mode, requestFile, output] = argv;
    demand(process.versions.node.split(".")[0] === "24" && argv.length === 3 && mode === "--inspect" &&
      requestFile === resolve(requestFile));
    const request = decodeQualificationTargetJson(readFrontendReleaseEvidence(dirname(requestFile), basename(requestFile)), "carrier");
    const receipts = frontendReleaseReceiptStore(output);
    const observation = await inspectFrontendMigrationLineage(request, () => process.env[credentialName]);
    receipts.record(observationFile, observation);
    console.log(JSON.stringify({ status: observation.status, receipt: observationFile, migrationAuthorized: false, trafficAuthorized: false }));
  } catch {
    console.error(JSON.stringify({ status: refusal, migrationAuthorized: false, trafficAuthorized: false }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
