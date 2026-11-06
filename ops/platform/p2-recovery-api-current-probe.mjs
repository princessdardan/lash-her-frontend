// Mounted into the exact API migration image. Never imports/calls its executor.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
const require = ok => { if (!ok) throw new Error('P2_RECOVERY_API_CURRENT_REFUSED'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function imageModules() {
  const [operator, lineage, schema] = await Promise.all([
    import('./dist-migration/src/db/operator-migration.js'), import('./dist-migration/src/db/migration-lineage.js'), import('./dist-migration/src/db/migration-schema.js'),
  ]);
  return { ...operator, ...lineage, ...schema };
}

export async function verifyRecoveryApiRoles(client, job) {
  const migration = job.target.user, runtime = job.runtimeRole;
  const roles = (await client.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,
    has_database_privilege(oid,current_database(),'CREATE') AS database_create,has_database_privilege(oid,current_database(),'CONNECT') AS database_connect,
    has_schema_privilege(oid,'public','USAGE') AS schema_usage,has_schema_privilege(oid,'public','CREATE') AS schema_create,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [[migration,runtime]])).rows;
  require(roles.length === 2 && roles.every(role => ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit'].every(key => role[key] === false) &&
    role.memberships === 0 && role.database_connect === true && role.schema_usage === true && role.database_create === (role.rolname === migration) && role.schema_create === (role.rolname === migration)));
  const defaults = (await client.query(`SELECT d.defaclobjtype AS kind,count(*)::int AS count FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=$1::regrole AND d.defaclnamespace='public'::regnamespace AND a.grantee=$2::regrole AND NOT a.is_grantable
    AND ((d.defaclobjtype='r' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) OR (d.defaclobjtype='S' AND a.privilege_type IN ('USAGE','SELECT')))
    GROUP BY d.defaclobjtype ORDER BY d.defaclobjtype`, [migration,runtime])).rows;
  require(defaults.some(row => row.kind === 'r' && row.count === 4) && defaults.some(row => row.kind === 'S' && row.count === 2));
  const grants = (await client.query(`SELECT bool_and(has_table_privilege($1,c.oid,'SELECT') AND has_table_privilege($1,c.oid,'INSERT') AND
    has_table_privilege($1,c.oid,'UPDATE') AND has_table_privilege($1,c.oid,'DELETE') AND NOT has_table_privilege($1,c.oid,'TRUNCATE')) AS runtime_dml,
    NOT has_schema_privilege($1,'drizzle','USAGE') AS journal_isolated FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')`, [runtime])).rows[0];
  require(grants?.runtime_dml === true && grants.journal_isolated === true);
}

export async function observeRecoveryApiCurrent(input, { getUrl, modules = imageModules, createClient = options => new Client(options) }) {
  require(input?.version === 1 && ['lash-her-course-api','lash-her-community-api'].includes(input.service) && input.job?.environment === 'staging' &&
    typeof input.schemaBytes === 'string' && /^[a-f0-9]{64}$/u.test(input.candidateSha256 ?? '') && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.recoveryActionId ?? ''));
  const api = await modules();
  const prepared = api.prepareOperatorMigration(JSON.stringify(input.job), input.schemaBytes, 'drizzle', input.service);
  const { manifest: job, target, artifact, baseline } = prepared;
  const client = createClient({ ...api.directMigrationConnection(await getUrl(), target), options: '-c default_transaction_read_only=on', application_name: 'lash-her-p2-api-recovery-current' });
  let lost = false; client.on('error', () => { lost = true; });
  try {
    await client.connect(); require(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const identity = (await client.query("SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::int/10000 AS major,current_setting('transaction_read_only') AS readonly")).rows[0];
      require(identity.database === target.database && identity.role === target.user && identity.major === target.serverMajor && identity.readonly === 'on');
      const journal = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
      // Preserve original approvedPendingTags. Current-only comparison is an
      // independent read; it never edits the original manifest to authorize [].
      require(api.assertAppliedLineage(artifact, journal).length === 0);
      require(isDeepStrictEqual(await api.readMigrationCatalog(client), baseline.catalog));
      await verifyRecoveryApiRoles(client, job); require(!lost);
      return { version: 1, status: 'P2_RECOVERY_API_DATABASE_CURRENT', service: input.service,
        ...Object.fromEntries(['environment','releaseId','sourceCommit','migrationImageDigest','runtimeImageDigest','schemaBaselineSha256','contractSha256'].map(key => [key,job[key]])),
        ...(job.contractPhase === 'p2' ? { contractPhase:'p2',phase2ContractManifestSha256:job.phase2ContractManifestSha256 } : {}),
        candidateSha256: input.candidateSha256, recoveryActionId: input.recoveryActionId, journalSha256: hash(journal), artifactSha256: artifact.artifactSha256,
        pendingTags: [], readOnlyVerified: true, schemaVerified: true, runtimeRoleVerified: true, sqlReplayed: false };
    } finally { await client.query('ROLLBACK'); }
  } catch { throw new Error('P2_RECOVERY_API_CURRENT_REFUSED'); }
  finally { try { await client.end(); require(!lost); } catch { throw new Error('P2_RECOVERY_API_CLEANUP_UNCERTAIN'); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const bytes = readFileSync(0); require(bytes.length > 0 && bytes.length <= 2_000_000);
    console.log(JSON.stringify(await observeRecoveryApiCurrent(JSON.parse(bytes), { getUrl: () => process.env.STAGING_DATABASE_URL })));
  } catch { console.error('P2_RECOVERY_API_CURRENT_REFUSED'); process.exitCode = 1; }
}
