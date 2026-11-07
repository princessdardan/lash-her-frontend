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

export async function observeRecoveryApiCurrent(input, { getUrl, modules = imageModules, createClient = options => new Client(options) }) {
  require(input?.version === 1 && ['lash-her-course-api','lash-her-community-api'].includes(input.service) && input.job?.environment === 'staging' &&
    typeof input.schemaBytes === 'string' && /^[a-f0-9]{64}$/u.test(input.candidateSha256 ?? '') && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.recoveryActionId ?? ''));
  const api = await modules();
  const prepared = api.prepareOperatorMigration(JSON.stringify(input.job), input.schemaBytes, 'drizzle', input.service);
  const { manifest: job, target, artifact, baseline } = prepared;
  const connection=api.directMigrationConnection(await getUrl(),target);
  const client = createClient({ ...connection, options: [connection.options,'-c default_transaction_read_only=on -c search_path=pg_catalog,public'].filter(Boolean).join(' '), application_name: 'lash-her-p2-api-recovery-current' });
  let lost = false,checkpoint='api-transport'; client.on('error', () => { lost = true; });
  try {
    await client.connect(); require(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      checkpoint='api-identity';const identity = (await client.query("SELECT pg_catalog.current_database() AS database,current_user AS role,pg_catalog.current_setting('server_version_num')::int/10000 AS major,pg_catalog.current_setting('transaction_read_only') AS readonly")).rows[0];
      require(identity.database === target.database && identity.role === target.user && identity.major === target.serverMajor && identity.readonly === 'on');
      // Validate source-owned role settings before any application-schema or
      // catalog reader could resolve names through a forbidden search_path.
      checkpoint='api-role-export';require(typeof api.verifyOperatorRoles === 'function');
      checkpoint='api-role-policy';await api.verifyOperatorRoles(client, target.user, job.runtimeRole, true, { service: input.service, environment: job.environment }); require(!lost);
      const journal = (await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC')).rows;
      // Preserve original approvedPendingTags. Current-only comparison is an
      // independent read; it never edits the original manifest to authorize [].
      checkpoint='api-lineage';require(api.assertAppliedLineage(artifact, journal).length === 0);
      checkpoint='api-schema';require(isDeepStrictEqual(await api.readMigrationCatalog(client),baseline.catalog));
      return { version: 1, status: 'P2_RECOVERY_API_DATABASE_CURRENT', service: input.service,
        ...Object.fromEntries(['environment','releaseId','sourceCommit','migrationImageDigest','runtimeImageDigest','schemaBaselineSha256','contractSha256'].map(key => [key,job[key]])),
        ...(job.contractPhase === 'p2' ? { contractPhase:'p2',phase2ContractManifestSha256:job.phase2ContractManifestSha256 } : {}),
        candidateSha256: input.candidateSha256, recoveryActionId: input.recoveryActionId, journalSha256: hash(journal), artifactSha256: artifact.artifactSha256,
        pendingTags: [], readOnlyVerified: true, schemaVerified: true, runtimeRoleVerified: true, sqlReplayed: false };
    } finally { await client.query('ROLLBACK'); }
  } catch { const error=new Error('P2_RECOVERY_API_CURRENT_REFUSED');error.checkpoint=checkpoint;throw error; }
  finally { try { await client.end(); require(!lost); } catch { throw new Error('P2_RECOVERY_API_CLEANUP_UNCERTAIN'); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const bytes = readFileSync(0); require(bytes.length > 0 && bytes.length <= 2_000_000);
    console.log(JSON.stringify(await observeRecoveryApiCurrent(JSON.parse(bytes), { getUrl: () => process.env.STAGING_DATABASE_URL })));
  } catch { console.error('P2_RECOVERY_API_CURRENT_REFUSED'); process.exitCode = 1; }
}
