import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { frontendMigrationArtifact, prepareFrontendMigration, runFrontendMigration, writeFrontendReceipt, FRONTEND_MIGRATION_LOCK } from './frontend-migration.mjs';
import { readMigrationCatalog } from './frontend-schema.mjs';
import { frontendAdmissionTargetSha256, bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact } from './frontend-admission-bootstrap.mjs';
import { prepareFrontendRolesPlan, applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES } from './frontend-role-preparation.mjs';
import { validateP2ProfiledCurrentProbe, createP2ProfiledCurrentProbe, observeP2ProfiledCurrentFrontend } from './p2-profiled-current-probe.mjs';
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from './qualification-target-profile.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(major = 16) {
  const artifact = frontendMigrationArtifact(), sourceCommit = 'a'.repeat(40);
  const target = { qualificationTargetProfile: profile, host: '127.0.0.1', port: 5432, database: 'owned_current', user: 'frontend_operator',
    runtimeRole: FRONTEND_PREPARATION_ROLES.runtime, serverMajor: major, allowEmptyBootstrap: false, approvedPendingTags: [] };
  const baseline = { version: 1, serverMajor: major, sqlArtifactSha256: artifact.sqlArtifactSha256,
    catalog: Object.fromEntries(['relations', 'columns', 'constraints', 'indexes', 'triggers', 'functions', 'enums', 'sequences', 'policies'].map(key => [key, []])) };
  const phase2 = { contractPhase: 'p2', phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
  const job = { version: 2, qualificationTargetProfile: profile, operator: 'Dardan', environment: 'staging', releaseId: 'owned-current', sourceCommit,
    migrationImageDigest: 'sha256:' + 'b'.repeat(64), contractManifestSha256: artifact.contractManifestSha256, sqlArtifactSha256: artifact.sqlArtifactSha256,
    schemaBaselineSha256: hash(baseline), recoveryRef: 'owned/current', target, ...phase2 };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: 'staging', releaseId: job.releaseId, ...phase2,
    integration: { state: 'passed' }, sourceApproval: { mode: 'single-operator-dispatch', operatorGithubUserId: '8996309' },
    sources: { frontend: { repository: 'https://github.com/princessdardan/lash-her-frontend.git', commit: sourceCommit, requiredChecks: 'passed' } },
    artifacts: { frontendMigration: { image: 'ghcr.io/princessdardan/lash-her-platform-frontend-migration@' + job.migrationImageDigest } },
    contractManifestSha256: artifact.contractManifestSha256,
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { [major]: job.schemaBaselineSha256 }, ...phase2 } };
  const after = artifact.migrations.map(row => ({ hash: row.hash, created_at: String(row.folderMillis) }));
  const receipt = { version: 2, qualificationTargetProfile: profile, service: 'frontend', status: 'DATABASE_VERIFIED', environment: 'staging',
    releaseId: job.releaseId, sourceCommit, migrationImageDigest: job.migrationImageDigest, sqlArtifactSha256: job.sqlArtifactSha256,
    schemaBaselineSha256: job.schemaBaselineSha256, contractManifestSha256: job.contractManifestSha256, ...phase2,
    migrationMode: 'verify-current-only', target: Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, target[key]])),
    before: after, after, applied: [], readOnlyVerified: true, schemaVerified: true, runtimeRoleVerified: true, trafficAuthorized: false };
  const owner = { name: FRONTEND_PREPARATION_ROLES.owner, oid: '100' };
  const input = { version: 2, qualificationTargetProfile: profile, operation: 'verify-schema', marker: 'c'.repeat(64), backendPid: 123,
    backendStart: '2026-11-06 00:00:00+00', job, receipt, baseline, targetSha256: frontendAdmissionTargetSha256('staging', target), owner };
  return { artifact, candidate, job, baseline, input };
}

test('fixed probe accepts exact source current lineage and rejects mixed/pending/false receipts before credential access', async () => {
  const f = fixture(); assert.equal(validateP2ProfiledCurrentProbe(f.input).artifact.migrations.length, 83);
  for (const mutate of [
    value => { delete value.qualificationTargetProfile; }, value => { value.version = 1; },
    value => { value.job.version = 1; }, value => { delete value.job.target.qualificationTargetProfile; },
    value => { value.receipt.qualificationTargetProfile = { ...profile, sha256: '1'.repeat(64) }; },
    value => { value.job.target.approvedPendingTags = ['0080_invented']; }, value => { value.job.target.allowEmptyBootstrap = true; },
    value => { value.receipt.readOnlyVerified = false; }, value => { value.receipt.applied = [{ tag: '0080_invented' }]; },
    value => { value.receipt.after = value.receipt.after.slice(0, 80); }, value => { value.targetSha256 = 'd'.repeat(64); },
    value => { value.baseline.catalog.columns.push({ changed: true }); }, value => { value.operation = 'apply'; },
    value => { value.originalBackendAbsent = true; },
  ]) {
    const bad = structuredClone(f.input); mutate(bad); let acquired = false;
    await assert.rejects(observeP2ProfiledCurrentFrontend(bad, { getUrl() { acquired = true; throw Error('credential canary'); } }));
    assert.equal(acquired, false);
  }
});

test('duplicate raw profile and unknown operation cannot reach a database child', () => {
  const raw = JSON.stringify(fixture().input).replace('"version":2', '"version":2,"version":2');
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'ops/platform/p2-profiled-current-probe.mjs'], { input: raw, encoding: 'utf8',
    env: Object.fromEntries(['PATH', 'LANG', 'HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr.trim(), 'P2_PROFILED_CURRENT_PROBE_REFUSED');
});

test('physical builder refuses non-TLS client before any query', async () => {
  const f = fixture(); let queries = 0;
  const migration = { qualificationTargetProfile: profile, candidate: f.candidate, job: f.job, baseline: f.baseline };
  await assert.rejects(createP2ProfiledCurrentProbe(migration, { qualificationTargetProfile: profile }, { query() { queries++; } }, async () => {}, f.input.receipt));
  assert.equal(queries, 0);
});

test('actual owned TLS PG current session, 80-vs83 refusal, physical locks and late closure', {
  skip: process.env.P2_PROFILED_CURRENT_OWNED_TEST !== 'true', timeout: 180_000,
}, async () => {
  const binaries = process.env.PG_BIN, major = Number(process.env.OWNED_POSTGRES_MAJOR);
  assert.ok(binaries?.startsWith('/') && [16, 18].includes(major));
  const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  assert.match(run(join(binaries, 'postgres'), ['--version']), new RegExp(`PostgreSQL\\) ${major}\\.`));
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'p2-profile-current-pg-'))), data = join(directory, 'data');
  chmodSync(directory, 0o700); const password = 'owned-' + randomUUID(), clients = []; let running = false;
  try {
    run(join(binaries, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'fixture_admin', '-E', 'UTF8', '--locale=C']);
    const cert = join(directory, 'server.crt'), key = join(directory, 'server.key');
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert]); chmodSync(key, 0o600);
    writeFileSync(join(data, 'postgresql.conf'), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${cert}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, 'pg_hba.conf'), 'local all all trust\nhostssl all fixture_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n');
    run(join(binaries, 'pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start']); running = true;
    const ca = readFileSync(cert, 'utf8');
    const connect = async (database, user = 'fixture_admin') => { const c = new Client({ host: '127.0.0.1', port, database, user, password, ssl: { rejectUnauthorized: true, ca } }); c.on('error', () => {}); clients.push(c); await c.connect(); return c; };
    const setup = await connect('postgres');
    await setup.query(`CREATE ROLE frontend_operator LOGIN CREATEROLE NOINHERIT PASSWORD '${password}'`);
    const freshDatabase = async () => { await setup.query('CREATE DATABASE owned_current OWNER frontend_operator'); return connect('owned_current', 'frontend_operator'); };
    let operator = await freshDatabase(); const f = fixture(major);
    const apply = async migrations => { for (const migration of migrations) { await operator.query('BEGIN'); for (const sql of migration.sql) await operator.query(sql); await operator.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [migration.hash, migration.folderMillis]); await operator.query('COMMIT'); } };
    const journalTable = async () => { await operator.query('CREATE SCHEMA drizzle'); await operator.query('CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text,created_at bigint)'); };
    await journalTable(); await apply(f.artifact.migrations); f.baseline.catalog = await readMigrationCatalog(operator);
    await operator.end(); await setup.query('DROP DATABASE owned_current'); operator = await freshDatabase();
    await journalTable(); await apply(f.artifact.migrations.slice(0, 80));
    f.job.target.port = port; f.job.schemaBaselineSha256 = hash(f.baseline);
    f.candidate.frontendMigration.schemaBaselines[major] = f.job.schemaBaselineSha256;
    const migration = prepareFrontendMigration(f.candidate, f.job, f.baseline, undefined, profile);
    const createClient = options => { const c = new Client({ ...options, ssl: { ...options.ssl, ca } }); clients.push(c); return c; };
    const url = `postgresql://frontend_operator:${password}@127.0.0.1:${port}/owned_current?sslmode=verify-full`;
    const output = label => { const path = join(directory, label); mkdirSync(path, { mode: 0o700 }); return path; };
    const prefixRecords = output('prefix'); let continued = false;
    await assert.rejects(runFrontendMigration(migration, { confirmation: 'staging/owned-current', getUrl: () => url, createClient,
      assertSource() {}, record: (name, value) => writeFrontendReceipt(prefixRecords, name, value), afterDatabaseVerified() { continued = true; } }, profile));
    assert.equal(continued, false); assert.equal((await operator.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, 80);
    await apply(f.artifact.migrations.slice(80));
    await operator.query('SELECT pg_advisory_lock(hashtext($1))', [FRONTEND_MIGRATION_LOCK]);
    const rolesDirectory = output('roles'), privateDirectory = output('private');
    const rolesPlan = prepareFrontendRolesPlan(f.candidate, f.job, { version: 2, qualificationTargetProfile: profile, producerSha256: ['d'.repeat(64)] }, profile);
    const roles = await applyPreparedFrontendRoles(rolesPlan, operator, { confirmation: 'staging/owned-current', directory: rolesDirectory, privateDirectory,
      verifyEnvironment: async () => {}, verifySession: async () => { assert.equal(operator.connection.stream.authorized, true); } }, profile);
    const targetSha256 = frontendAdmissionTargetSha256('staging', f.job.target);
    await bootstrapFrontendAdmission({ version: 2, qualificationTargetProfile: profile, environment: 'staging', actionId: f.job.releaseId,
      sourceCommit: f.job.sourceCommit, ...frontendAdmissionBootstrapArtifact(), inventorySha256: 'e'.repeat(64), targetSha256, target: f.job.target,
      owner: roles.owner, producers: roles.producers.map(row => ({ ...row, sourceCommit: f.job.sourceCommit })) }, operator,
    { confirmation: 'staging/owned-current', record: async () => {}, verifySession: async () => {} }, profile);
    await operator.query('SELECT pg_advisory_unlock(hashtext($1))', [FRONTEND_MIGRATION_LOCK]);
    const records = output('current'); let heldClient, probe, liveVerified = false;
    const outcome = await runFrontendMigration(migration, { confirmation: 'staging/owned-current', getUrl: () => url,
      createClient(options) { heldClient = createClient(options); return heldClient; }, assertSource() {},
      record: (name, value) => writeFrontendReceipt(records, name, value),
      async afterDatabaseVerified(receipt, verifySession) {
        assert.equal(existsSync(join(records, 'job-outcome.json')), false);
        probe = await createP2ProfiledCurrentProbe(migration, { qualificationTargetProfile: profile, targetSha256, owner: roles.owner }, heldClient, verifySession, receipt);
        const observed = await observeP2ProfiledCurrentFrontend(probe, { getUrl: () => url, createClient });
        assert.equal(observed.status, 'P2_PROFILED_CURRENT_PHYSICAL_LOCK_VERIFIED'); liveVerified = true;
        await assert.rejects(observeP2ProfiledCurrentFrontend({ ...probe, operation: 'verify-closed' }, { getUrl: () => url, createClient }));
        await assert.rejects(observeP2ProfiledCurrentFrontend({ ...probe, marker: 'f'.repeat(64) }, { getUrl: () => url, createClient }));
        assert.equal((await operator.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [FRONTEND_MIGRATION_LOCK])).rows[0].held, false);
      },
    }, profile);
    assert.equal(outcome.readOnlyVerified, true); assert.equal(liveVerified, true);
    const closed = await observeP2ProfiledCurrentFrontend({ ...probe, operation: 'verify-closed' }, { getUrl: () => url, createClient });
    assert.equal(closed.status, 'P2_PROFILED_CURRENT_SESSION_CLOSED'); assert.equal(closed.backendAbsent, true);
    assert.equal(closed.migrationLockReleased, true); assert.equal(closed.nonceLockReleased, true);
    assert.equal((await operator.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, 83);
    assert.equal((await operator.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [FRONTEND_MIGRATION_LOCK])).rows[0].held, true);
    await assert.rejects(observeP2ProfiledCurrentFrontend({ ...probe, operation: 'verify-closed' }, { getUrl: () => url, createClient }));
    await operator.query('SELECT pg_advisory_unlock(hashtext($1))', [FRONTEND_MIGRATION_LOCK]);
    // Only this disposable setup opens a control, to prove absent backend is
    // never accepted as admission closure and fence is a real scoped write.
    await operator.query(`SET ROLE "${roles.owner.name}"`);
    await operator.query('UPDATE frontend_admission.control SET new_work=true,recovery=true WHERE singleton');
    await operator.query('RESET ROLE');
    await assert.rejects(observeP2ProfiledCurrentFrontend({ ...probe, operation: 'verify-closed' }, { getUrl: () => url, createClient }));
    const fenced = await observeP2ProfiledCurrentFrontend({ ...probe, operation: 'fence' }, { getUrl: () => url, createClient });
    assert.equal(fenced.status, 'P2_PROFILED_CURRENT_ADMISSION_CLOSED');
    const afterFence = await observeP2ProfiledCurrentFrontend({ ...probe, operation: 'verify-closed' }, { getUrl: () => url, createClient });
    assert.equal(BigInt(afterFence.admission.epoch), BigInt(closed.admission.epoch) + 1n);
    const lostRecords = output('backend-loss'); let lostProbe;
    await assert.rejects(runFrontendMigration(migration, { confirmation: 'staging/owned-current', getUrl: () => url,
      createClient(options) { heldClient = createClient(options); return heldClient; }, assertSource() {},
      record: (name, value) => writeFrontendReceipt(lostRecords, name, value),
      async afterDatabaseVerified(receipt, verifySession) {
        lostProbe = await createP2ProfiledCurrentProbe(migration, { qualificationTargetProfile: profile, targetSha256, owner: roles.owner }, heldClient, verifySession, receipt);
        const ended = new Promise(resolve => heldClient.once('end', resolve));
        assert.equal((await setup.query('SELECT pg_terminate_backend($1) AS terminated', [lostProbe.backendPid])).rows[0].terminated, true);
        await ended; await verifySession();
      },
    }, profile));
    assert.equal(JSON.parse(readFileSync(join(lostRecords, 'job-outcome.json'))).status, 'FAILED_REQUIRES_REVIEW');
    assert.equal(existsSync(join(lostRecords, 'frontend-continuation-completed.json')), false);
    await assert.rejects(observeP2ProfiledCurrentFrontend(lostProbe, { getUrl: () => url, createClient }));
    assert.equal((await observeP2ProfiledCurrentFrontend({ ...lostProbe, operation: 'verify-closed' }, { getUrl: () => url, createClient })).backendAbsent, true);
    assert.deepEqual((await operator.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows, probe.receipt.after);
  } finally {
    for (const client of clients) { try { await client.end(); } catch { /* owned cleanup */ } }
    if (running) run(join(binaries, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(directory, { recursive: true, force: true });
  }
});
