// Run only after applying community-runtime-role.sql in the disposable local
// PostgreSQL 18 container documented in release-store.md. Never targets cloud DBs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { Pool } = require('pg');
const ownerUrl = new URL(process.env.COMMUNITY_ROLE_TEST_OWNER_URL ?? 'postgresql://neondb_owner@127.0.0.1:55439/neondb?sslmode=disable');
const runtimeUrl = new URL(process.env.COMMUNITY_ROLE_TEST_RUNTIME_URL ?? 'postgresql://lash_her_community_staging_runtime@127.0.0.1:55439/neondb?sslmode=disable');
for (const url of [ownerUrl, runtimeUrl]) {
  assert(url.hostname === '127.0.0.1' && url.port === '55439' && url.pathname === '/neondb', 'Only the disposable local role-test database is allowed');
}
const owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
const refusals = [];
try {
  await owner.query('CREATE TABLE public.staging_runtime_grant_probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)');
  const inserted = await runtime.query("INSERT INTO public.staging_runtime_grant_probe(value) VALUES ('one') RETURNING id,value");
  assert.equal(inserted.rows[0].value, 'one');
  assert.equal((await runtime.query('SELECT count(*)::int AS count FROM public.staging_runtime_grant_probe')).rows[0].count, 1);
  assert.equal((await runtime.query("UPDATE public.staging_runtime_grant_probe SET value='two' RETURNING value")).rows[0].value, 'two');
  for (const [label, sql] of [
    ['create-table', 'CREATE TABLE public.staging_runtime_ddl_probe(id int)'],
    ['alter-table', 'ALTER TABLE public.staging_runtime_grant_probe ADD COLUMN denied text'],
    ['drop-table', 'DROP TABLE public.staging_runtime_grant_probe'],
    ['truncate-table', 'TRUNCATE public.staging_runtime_grant_probe'],
    ['create-schema', 'CREATE SCHEMA staging_runtime_denied'],
    ['create-role', 'CREATE ROLE staging_runtime_denied'],
    ['assume-owner', 'SET ROLE neondb_owner'],
  ]) {
    await assert.rejects(runtime.query(sql), error => error.code === '42501', `${label} must be refused`);
    refusals.push(label);
  }
  assert.equal((await runtime.query('DELETE FROM public.staging_runtime_grant_probe RETURNING id')).rowCount, 1);
  console.log(JSON.stringify({ postMigrationOwnerDefaultGrantsVerified: true, runtimeDmlVerified: ['insert', 'select', 'update', 'delete', 'identity-sequence'], refusedOperations: refusals, cloudDatabaseModified: false }));
} finally {
  await owner.query('DROP TABLE IF EXISTS public.staging_runtime_grant_probe');
  await Promise.all([owner.end(), runtime.end()]);
}
