// Fixed image-side physical observer. The only writable operation closes admission.
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from './frontend-migration.mjs';
import { readMigrationCatalog } from './frontend-schema.mjs';
import { assertAppliedMigrationLineage } from '../../src/lib/private-db/migration-lineage.ts';
import { verifyRecoveryRuntimeGrants } from './p2-recovery-current-probe.mjs';
import { decodeQualificationTargetJson, requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from './qualification-target-profile.mjs';

const demand = ok => { if (!ok) throw new Error('P2_PROFILED_CURRENT_PROBE_REFUSED'); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()) && expected.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
  });
const role = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(value);
export const P2_PROFILED_CURRENT_LOCK_APPLICATION = 'lash-her-operator-frontend-migration';
const bindings = ['releaseId', 'environment', 'sourceCommit', 'migrationImageDigest', 'sqlArtifactSha256',
  'schemaBaselineSha256', 'contractManifestSha256', 'contractPhase', 'phase2ContractManifestSha256'];

export async function createP2ProfiledCurrentProbe(migration, plan, client, verifySession, databaseReceipt) {
  const profile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  requireQualificationTargetProfile(profile, migration, migration?.candidate, migration?.candidate?.frontendMigration,
    migration?.job, migration?.job?.target, plan, databaseReceipt);
  demand(typeof verifySession === 'function' && migration.job.target.approvedPendingTags.length === 0 &&
    client?.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
  await verifySession();
  const marker = randomBytes(32).toString('hex');
  await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))', [marker]);
  const row = (await client.query('SELECT pg_catalog.pg_backend_pid() AS pid,backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0];
  const result = { version: 2, qualificationTargetProfile: profile, operation: 'verify-schema', marker,
    backendPid: row?.pid, backendStart: row?.backend_start, job: structuredClone(migration.job),
    receipt: structuredClone(databaseReceipt), baseline: structuredClone(migration.baseline),
    targetSha256: plan.targetSha256, owner: structuredClone(plan.owner) };
  validateP2ProfiledCurrentProbe(result);
  await verifySession();
  return result;
}

export function validateP2ProfiledCurrentProbe(input) {
  const profile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
  demand(resolveQualificationTargetProfile(profile).kind === 'existing-staging');
  requireQualificationTargetProfile(profile, input, input?.job, input?.job?.target, input?.receipt);
  demand(keys(input, ['version', 'qualificationTargetProfile', 'operation', 'marker', 'backendPid', 'backendStart',
    'job', 'receipt', 'baseline', 'targetSha256', 'owner']) && input.version === 2 &&
    ['verify-schema', 'observe', 'fence', 'verify-closed'].includes(input.operation) && digest(input.marker) &&
    Number.isSafeInteger(input.backendPid) && input.backendPid > 0 && typeof input.backendStart === 'string' &&
    input.backendStart.length > 0 && input.backendStart.length <= 100 && digest(input.targetSha256));
  const { job, receipt, baseline, owner } = input, target = job.target;
  demand(job.version === 2 && job.environment === 'staging' && job.contractPhase === 'p2' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(job.releaseId ?? '') && /^[a-f0-9]{40}$/u.test(job.sourceCommit ?? '') &&
    Array.isArray(target.approvedPendingTags) && target.approvedPendingTags.length === 0 && target.allowEmptyBootstrap === false &&
    role(target.user) && role(target.runtimeRole) && target.user !== target.runtimeRole &&
    keys(owner, ['name', 'oid']) && role(owner.name) && /^[1-9][0-9]{0,9}$/u.test(owner.oid) &&
    Number(owner.oid) <= 4294967295 && ![target.user, target.runtimeRole].includes(owner.name));
  const selectedTarget = { environment: 'staging', ...Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, target[key]])) };
  demand(input.targetSha256 === hash(selectedTarget) && receipt.version === 2 && receipt.service === 'frontend' &&
    receipt.status === 'DATABASE_VERIFIED' && receipt.migrationMode === 'verify-current-only' &&
    receipt.readOnlyVerified === true && receipt.schemaVerified === true && receipt.runtimeRoleVerified === true &&
    receipt.trafficAuthorized === false && receipt.failureCode === undefined &&
    bindings.every(key => receipt[key] === job[key] && job[key] !== undefined) &&
    isDeepStrictEqual(receipt.target, Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, target[key]]))) &&
    Array.isArray(receipt.applied) && receipt.applied.length === 0 && Array.isArray(receipt.before) && receipt.before.length > 0 &&
    isDeepStrictEqual(receipt.before, receipt.after));
  // Source catalog and SQL are immutable artifacts, never profiled by restamping.
  demand(!Object.hasOwn(baseline, 'qualificationTargetProfile') && baseline.version === 1 &&
    baseline.serverMajor === target.serverMajor && hash(baseline) === job.schemaBaselineSha256);
  const artifact = frontendMigrationArtifact();
  demand(artifact.sqlArtifactSha256 === job.sqlArtifactSha256 && baseline.sqlArtifactSha256 === job.sqlArtifactSha256 &&
    artifact.contractManifestSha256 === job.contractManifestSha256 && artifact.contractPhase === job.contractPhase &&
    artifact.phase2ContractManifestSha256 === job.phase2ContractManifestSha256 &&
    assertAppliedMigrationLineage(artifact.expected, receipt.after) === artifact.migrations.at(-1).folderMillis);
  return { profile, artifact };
}

const lockSql = `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
  AND ($1::int IS NULL OR pid=$1) AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
  AND classid=((pg_catalog.hashtext($2)::bigint>>32)&4294967295)::oid
  AND objid=(pg_catalog.hashtext($2)::bigint&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`;

export async function observeP2ProfiledCurrentFrontend(input, { getUrl, createClient = options => new Client(options) }) {
  const { profile, artifact } = validateP2ProfiledCurrentProbe(input);
  demand(typeof getUrl === 'function');
  const target = input.job.target, options = frontendConnectionOptions(await getUrl(), target);
  // Closing is the sole source-selected writable control action. No DDL or open flag is exposed.
  const client = createClient({ ...options, application_name: 'lash-her-profiled-current-observer',
    options: '-c search_path=pg_catalog,public -c default_transaction_read_only=' + (input.operation === 'fence' ? 'off' : 'on'),
    statement_timeout: 15_000, query_timeout: 20_000, lock_timeout: 5_000 });
  let lost = false;
  client.on('error', () => { lost = true; });
  const base = { version: 2, qualificationTargetProfile: profile, environment: 'staging', releaseId: input.job.releaseId,
    sourceCommit: input.job.sourceCommit, targetSha256: input.targetSha256 };
  try {
    await client.connect();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    const identity = (await client.query("SELECT current_user AS username,session_user AS session_username,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(identity?.username === target.user && identity.session_username === target.user && identity.database === target.database && identity.major === target.serverMajor);
    const owners = (await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname=$1', [input.owner.name])).rows;
    demand(owners.length === 1 && owners[0].oid === input.owner.oid && owners[0].rolconfig === null && owners[0].rolconnlimit === -1 && owners[0].rolvaliduntil === null &&
      ['rolcanlogin', 'rolsuper', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'].every(key => owners[0][key] === false));
    if (input.operation === 'fence') {
      // Controller absence is never evidence of closure. Re-establish the
      // actual current database/role boundary before the sole control write.
      await client.query('BEGIN READ ONLY');
      try {
        const current = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
        demand(isDeepStrictEqual(current, input.receipt.after) &&
          assertAppliedMigrationLineage(artifact.expected, current) === artifact.migrations.at(-1).folderMillis &&
          isDeepStrictEqual(await readMigrationCatalog(client), input.baseline.catalog));
        await verifyRecoveryRuntimeGrants(client, target, input.owner);
      } finally { await client.query('ROLLBACK'); }
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE "${input.owner.name}"`);
        const rows = (await client.query('SELECT environment,target_sha256 FROM frontend_admission.control WHERE singleton FOR UPDATE')).rows;
        demand(rows.length === 1 && rows[0].environment === 'staging' && rows[0].target_sha256 === input.targetSha256);
        await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND (new_work OR recovery)');
        const row = (await client.query('SELECT new_work,recovery FROM frontend_admission.control WHERE singleton')).rows[0];
        demand(row?.new_work === false && row.recovery === false && !lost);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      return { ...base, status: 'P2_PROFILED_CURRENT_ADMISSION_CLOSED' };
    }
    await client.query('BEGIN READ ONLY');
    try {
      const original = (await client.query('SELECT backend_start::text,usename,datname,application_name FROM pg_catalog.pg_stat_activity WHERE pid=$1', [input.backendPid])).rows;
      if (input.operation === 'verify-closed') {
        demand(original.every(row => row.backend_start !== input.backendStart));
      } else {
        demand(original.length === 1 && original[0].backend_start === input.backendStart && original[0].usename === target.user &&
          original[0].datname === target.database && original[0].application_name === P2_PROFILED_CURRENT_LOCK_APPLICATION);
      }
      for (const lock of [FRONTEND_MIGRATION_LOCK, input.marker]) {
        const row = (await client.query(lockSql, [input.operation === 'verify-closed' ? null : input.backendPid, lock])).rows[0];
        demand(row?.held === (input.operation !== 'verify-closed'));
      }
      const journal = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
      demand(isDeepStrictEqual(journal, input.receipt.after) && assertAppliedMigrationLineage(artifact.expected, journal) === artifact.migrations.at(-1).folderMillis);
      if (input.operation !== 'observe') demand(isDeepStrictEqual(await readMigrationCatalog(client), input.baseline.catalog));
      await verifyRecoveryRuntimeGrants(client, target, input.owner);
      await client.query(`SET LOCAL ROLE "${input.owner.name}"`);
      const control = (await client.query(`SELECT environment,target_sha256,epoch::text,new_work,recovery,
        (SELECT count(*)::int FROM frontend_admission.operations WHERE state='active') AS active,
        (SELECT count(*)::int FROM frontend_admission.operations WHERE state='uncertain') AS uncertain
        FROM frontend_admission.control WHERE singleton`)).rows;
      demand(control.length === 1 && control[0].environment === 'staging' && control[0].target_sha256 === input.targetSha256 &&
        control[0].new_work === false && control[0].recovery === false && /^[1-9][0-9]*$/u.test(control[0].epoch) &&
        control[0].active === 0 && control[0].uncertain === 0 && !lost);
      const admission = { epoch: control[0].epoch, newWork: false, recovery: false, active: control[0].active, uncertain: control[0].uncertain };
      return input.operation === 'verify-closed'
        ? { ...base, status: 'P2_PROFILED_CURRENT_SESSION_CLOSED', originalBackendPid: input.backendPid, originalBackendStart: input.backendStart,
            backendAbsent: true, migrationLockReleased: true, nonceLockReleased: true, admission }
        : { ...base, status: 'P2_PROFILED_CURRENT_PHYSICAL_LOCK_VERIFIED', marker: input.marker, backendPid: input.backendPid, backendStart: input.backendStart, admission };
    } finally { await client.query('ROLLBACK'); }
  } finally { await client.end(); demand(!lost); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Source context is selected before decoding any untrusted stdin carrier.
  try {
    resolveQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
    const raw = Buffer.alloc(2_000_001); let length = 0;
    while (length < raw.length) { const count = readSync(0, raw, length, raw.length - length, null); if (!count) break; length += count; }
    demand(length > 0 && length <= 2_000_000);
    console.log(JSON.stringify(await observeP2ProfiledCurrentFrontend(decodeQualificationTargetJson(raw.subarray(0, length), 'carrier'),
      { getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL })));
  } catch { console.error('P2_PROFILED_CURRENT_PROBE_REFUSED'); process.exitCode = 1; }
}
