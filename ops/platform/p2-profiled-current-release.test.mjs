import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { frontendMigrationArtifact } from './frontend-migration.mjs';
import { frontendWriterInventory } from './frontend-writer-inventory.mjs';
import { frontendCandidateSurfaces } from './frontend-release-inventory.mjs';
import { frontendAdmissionTargetSha256 } from './frontend-admission-bootstrap.mjs';
import { P2_CERTIFICATION_PROFILE } from './p2-certification-profile.mjs';
import { prepareP2ProfiledCurrentRelease, runP2ProfiledCurrentRelease, p2ProfiledCurrentReleaseOperator,
  openP2ProfiledCurrentSource, readP2ProfiledCurrentSource, P2_PROFILED_CURRENT_CONFIGURATION_FILES } from './p2-profiled-current-release.mjs';
import { resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from './qualification-target-profile.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const root = fileURLToPath(new URL('../..', import.meta.url));
const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'p2-profile-current-plan-')));
  const make = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700, recursive: true }); return path; };
  const bundle = make('bundle'), configuration = make('configuration'), results = make('results'); make('bundle/jobs'); make('bundle/schema');
  const artifact = frontendMigrationArtifact(), environment = 'staging', releaseId = 'owned-profile-current', sourceCommit = 'a'.repeat(40);
  const phase2 = { contractPhase: 'p2', phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
  const target = { qualificationTargetProfile: profile, host: 'owned.invalid', port: 5432, database: 'owned', user: 'operator', runtimeRole: 'runtime',
    serverMajor: 18, allowEmptyBootstrap: false, approvedPendingTags: [] };
  const baseline = { version: 1, serverMajor: 18, sqlArtifactSha256: artifact.sqlArtifactSha256,
    catalog: Object.fromEntries(['relations', 'columns', 'constraints', 'indexes', 'triggers', 'functions', 'enums', 'sequences', 'policies'].map(key => [key, []])) };
  const job = { version: 2, qualificationTargetProfile: profile, environment, releaseId, sourceCommit, operator: 'Dardan', ...phase2,
    migrationImageDigest: 'sha256:' + '1'.repeat(64), contractManifestSha256: artifact.contractManifestSha256, sqlArtifactSha256: artifact.sqlArtifactSha256,
    schemaBaselineSha256: hash(baseline), recoveryRef: 'owned/recovery', target };
  const sources = Object.fromEntries(['frontend', 'course', 'community'].map((name, index) => [name, {
    qualificationTargetProfile: profile, repository: `https://github.com/princessdardan/lash-her-${name}${name === 'frontend' ? '' : '-api'}.git`,
    commit: ['a', 'b', 'c'][index].repeat(40), requiredChecks: 'passed',
  }]));
  const artifacts = Object.fromEntries([['frontendMigration', 'frontend-migration'], ['courseMigration', 'course-migration'],
    ['communityMigration', 'community-migration'], ['courseRuntime', 'course-runtime'], ['communityRuntime', 'community-runtime'], ['gateway', 'gateway']]
    .map(([key, name], index) => [key, { image: `ghcr.io/princessdardan/lash-her-platform-${name}@sha256:${String(index + 1).repeat(64)}`,
      sbomSha256: 'sha256:' + 'd'.repeat(64), provenanceSha256: 'sha256:' + 'e'.repeat(64), scan: 'passed' }]));
  const candidate = { version: 3, qualificationTargetProfile: profile, environment, releaseId, sources, artifacts, ...phase2,
    contractManifestSha256: artifact.contractManifestSha256,
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, ...phase2, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { 18: job.schemaBaselineSha256 } },
    sourceApproval: { qualificationTargetProfile: profile, mode: 'single-operator-dispatch', operatorGithubUserId: '8996309', runId: '1', runAttempt: 1, verifiedAt: '2026-01-01T00:00:00Z' },
    integration: { qualificationTargetProfile: profile, state: 'passed' },
    approval: { qualificationTargetProfile: profile, environment, releaseId, state: 'approved', operator: 'Dardan', approvedAt: '2026-01-01T00:00:00Z' },
    migrations: { frontend: { state: 'verified' }, course: { state: 'verified' }, community: { state: 'verified' } },
    recovery: { state: 'verified' }, scheduler: { state: 'verified', cancellation: 'verified' },
    workload: { qualificationTargetProfile: profile, environment: 'production', projectId: resolveQualificationTargetProfile(profile).frontend.projectId } };
  write(join(bundle, 'release.candidate.json'), candidate); write(join(bundle, 'jobs/frontend.json'), job); write(join(bundle, 'schema/frontend.json'), baseline);
  const apiJobs = Object.fromEntries(['course', 'community'].map(name => [name, {
    schemaVersion: 2, qualificationTargetProfile: profile, kind: 'operator-migration', operator: 'Dardan', environment, releaseId,
    sourceCommit: sources[name].commit, ...phase2, contractSha256: artifact.contractManifestSha256.slice(7),
    migrationImageDigest: artifacts[name + 'Migration'].image.split('@')[1], runtimeImageDigest: artifacts[name + 'Runtime'].image.split('@')[1], runtimeRole: `${name}_runtime`,
    target: { schemaVersion: 2, qualificationTargetProfile: profile, environment, service: `lash-her-${name}-api`, host: `${name}.owned.invalid`, port: 5432, database: name, user: `${name}_migration` },
  }]));
  for (const [name, apiJob] of Object.entries(apiJobs)) write(join(bundle, 'jobs', name + '.json'), apiJob);
  const source = frontendWriterInventory(root), targetSha256 = frontendAdmissionTargetSha256(environment, target), producerSha256 = 'a'.repeat(64);
  const inventory = { version: 2, qualificationTargetProfile: profile, environment, actionId: releaseId, sourceCommit, targetSha256,
    sourceInventorySha256: hash(source), reviewSha256: 'b'.repeat(64), adaptersSha256: 'c'.repeat(64), runtimeProducerSha256: producerSha256,
    observationBudgetSeconds: 60, admissionMode: 'existing', expectedEpoch: '1', owner: { name: 'admission_owner', oid: '100' },
    producers: [{ producerSha256, role: { name: target.runtimeRole, oid: '101' } }],
    candidateCoverage: frontendCandidateSurfaces(source).map(row => ({ surfaceSha256: row.surfaceSha256, disposition: 'closed', evidenceSha256: 'd'.repeat(64) })),
    externalSurfaces: ['deployment', 'provider', 'scheduler', 'direct-caller'].map((kind, index) => {
      const identitySha256 = String(index + 1).repeat(64); return { kind, identitySha256, surfaceSha256: hash({ kind, identitySha256 }) };
    }),
    historicalLogins: { version: 2, qualificationTargetProfile: profile, environment, actionId: releaseId, sourceCommit, clusterScopeSha256: 'e'.repeat(64),
      target: { ...target, currentRuntimeRole: 'runtime', admissionOwnerRole: 'admission_owner' }, retiredLogins: [{ name: 'old_runtime', oid: '102' }] },
    restoration: { version: 2, qualificationTargetProfile: profile, newWork: false, recovery: false, nativeSchedulesEnabled: false, providerIngress: 'keep-retired', gatewayBindingSha256: 'f'.repeat(64) },
    certification: P2_CERTIFICATION_PROFILE };
  const inventoryPath = join(directory, 'inventory.json'); write(inventoryPath, inventory);
  const host = Object.fromEntries(['bundle', 'configuration', 'results'].map(name => [name, '/var/lib/lash-her/releases/staging/owned/' + name]));
  host.machineId = 'a'.repeat(32);
  const runtime = { version: 2, qualificationTargetProfile: profile, environment, releaseId, hostMachineId: host.machineId, previousReleaseRef: 'owned/previous', maintenanceRef: 'owned/maintenance' };
  const runtimeRaw = JSON.stringify(runtime) + '\n'; write(join(configuration, 'runtime.json'), runtimeRaw);
  const settings = { version: 2, qualificationTargetProfile: profile, environment, sourceCommit, bundle, configuration, inventory: inventoryPath, host, results,
    configurationSha256: Object.fromEntries(P2_PROFILED_CURRENT_CONFIGURATION_FILES.map(name => [name, name === 'runtime.json' ? hash(runtimeRaw) : 'a'.repeat(64)])),
    providerContext: join(directory, 'no-provider-file'), knownHosts: join(directory, 'no-known-hosts'), sshKey: join(directory, 'no-ssh-key') };
  return { directory, settings, job, apiJobs, inventory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test('profiled current plan reads only metadata and keeps all authority flags false', async () => {
  const f = fixture();
  try {
    const { plan } = prepareP2ProfiledCurrentRelease(f.settings);
    assert.deepEqual(await p2ProfiledCurrentReleaseOperator(f.settings), plan);
    assert.deepEqual(plan.qualificationTargetProfile, profile); assert.equal(plan.configurationObserved, false); assert.equal(plan.currentDatabaseObserved, false);
    for (const key of ['frontendSqlApplied', 'historicalProviderClosureClaimed', 'oldP200Qualified', 'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted']) assert.equal(plan[key], false);
    assert.equal(Object.keys(plan.configurationSha256).length, 19);
    assert.deepEqual(plan.apiJobSha256, Object.fromEntries(Object.entries(f.apiJobs).map(([name, job]) => [name, hash(JSON.stringify(job) + '\n')])));
    assert(!existsSync(join(f.settings.configuration, 'course-api.env')) && !existsSync(f.settings.providerContext));
  } finally { f.dispose(); }
});

test('legacy or mismatched profile refuses before settings paths are accessed', () => {
  let accessed = false;
  for (const ref of [undefined, { ...profile, sha256: '1'.repeat(64) }]) {
    const settings = { version: 2, ...(ref ? { qualificationTargetProfile: ref } : {}), get bundle() { accessed = true; throw Error('path canary'); } };
    assert.throws(() => prepareP2ProfiledCurrentRelease(settings), /QUALIFICATION_TARGET_PROFILE/u);
  }
  assert.equal(accessed, false);
});

test('pending FE, downgraded API target, and open restoration cannot prepare', () => {
  const f = fixture();
  try {
    const path = join(f.settings.bundle, 'jobs/frontend.json');
    write(path, { ...f.job, target: { ...f.job.target, approvedPendingTags: ['0080_owned_pending'] } });
    assert.throws(() => prepareP2ProfiledCurrentRelease(f.settings)); write(path, f.job);
    const course = join(f.settings.bundle, 'jobs/course.json');
    // A target shape with the same registered profile still cannot select v1.
    write(course, { ...f.apiJobs.course, target: { ...f.apiJobs.course.target, schemaVersion: 1 } });
    assert.throws(() => prepareP2ProfiledCurrentRelease(f.settings));
  } finally { f.dispose(); }
  const open = fixture();
  try {
    write(open.settings.inventory, { ...open.inventory, restoration: { ...open.inventory.restoration, newWork: true, recovery: true } });
    assert.throws(() => prepareP2ProfiledCurrentRelease(open.settings));
  } finally { open.dispose(); }
});

test('raw duplicate settings and profile selector refuse at the fixed CLI', () => {
  const f = fixture();
  try {
    const path = join(f.directory, 'settings.json'); write(path, JSON.stringify(f.settings).replace('"version":2', '"version":2,"version":2'));
    for (const args of [['--plan', '--settings', path], ['--profile', 'staging-current', '--settings', path]]) {
      const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'ops/platform/p2-profiled-current-release.mjs', ...args], {
        encoding: 'utf8', env: Object.fromEntries(['PATH', 'LANG', 'HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
      });
      assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.equal(child.stderr.trim(), 'P2_PROFILED_CURRENT_RELEASE_REFUSED');
    }
  } finally { f.dispose(); }
});

test('source apply requires actual custody and config before credentials or host work', async () => {
  const f = fixture();
  try {
    const prepared = prepareP2ProfiledCurrentRelease(f.settings), confirmation = `staging/${prepared.plan.releaseId}`;
    let called = false;
    await assert.rejects(runP2ProfiledCurrentRelease(prepared, { confirmation, source: {}, withEnvironmentLock() { called = true; } }));
    await assert.rejects(runP2ProfiledCurrentRelease(prepared, { confirmation, source: {} }));
    assert.throws(() => readP2ProfiledCurrentSource({}, prepared, prepared.plan.releaseId));
    await assert.rejects(openP2ProfiledCurrentSource(structuredClone(prepared), { actionId: prepared.plan.releaseId, confirmation }));
    await assert.rejects(openP2ProfiledCurrentSource(prepared, { actionId: prepared.plan.releaseId, confirmation }));
    assert.equal(called, false); assert.equal(existsSync(join(f.settings.results, prepared.plan.releaseId)), false);
  } finally { f.dispose(); }
});
