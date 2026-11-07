import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { p2ProfiledCertificationOperator, prepareP2ProfiledCertificationOperator, runP2BoundedCertification } from './p2-certification.mjs';
import { nativeSourceCommit } from './harness/p2-native-unit-fixture.mjs';
import { p2NativeHash } from './p2-lifecycle-native.mjs';
import { p2LifecyclePersistenceTargetSha256, prepareP2LifecyclePersistencePlan } from './p2-lifecycle-persistence-probe.mjs';
import { resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from './qualification-target-profile.mjs';
import { CAUSAL_FILES, REPLACEMENT_FILES, PROFILED_MODE, prepareProfiledInterruptedKnownAckOperator } from './p2-known-ack-interrupted-restoration.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const root = fileURLToPath(new URL('../..', import.meta.url));
const write = (path, value) => writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
function fixture(sourceCommit = 'a'.repeat(40)) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'p2-profile-current-plan-')));
  const make = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700, recursive: true }); return path; };
  const bundle = make('bundle'), configuration = make('configuration'), results = make('results'); make('bundle/jobs'); make('bundle/schema');
  const artifact = frontendMigrationArtifact(), environment = 'staging', releaseId = 'owned-profile-current';
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
    commit: [sourceCommit, 'b'.repeat(40), 'c'.repeat(40)][index], requiredChecks: 'passed',
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
    target: { schemaVersion: 2, qualificationTargetProfile: profile, environment, service: `lash-her-${name}-api`, host: `${name}.owned.invalid`, port: 5432, database: name, user: `${name}_migration`, serverMajor: 18 },
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

test('fixed current certification plan joins the original release plan, terminal and ready receipt bytes', async () => {
  const f = fixture(nativeSourceCommit());
  const rawHash = raw => createHash('sha256').update(raw).digest('hex');
  try {
    const { plan, inventory, migration } = prepareP2ProfiledCurrentRelease(f.settings);
    const original = join(f.settings.results, plan.releaseId);
    const frontend = join(original, 'frontend'), vercel = join(frontend, 'vercel');
    mkdirSync(vercel, { recursive: true, mode: 0o700 });
    const candidateBytes = readFileSync(join(f.settings.bundle, 'release.candidate.json'));
    writeFileSync(join(original, 'release.candidate.json'), candidateBytes, { mode: 0o600 });
    write(join(original, 'reviewed-plan.json'), plan);
    const deploymentId = 'dpl_Owned', deploymentUrl = 'https://owned.vercel.app';
    const base = { version: 2, qualificationTargetProfile: profile, environment: 'staging', releaseId: plan.releaseId,
      sourceCommit: plan.sourceCommit, projectId: migration.candidate.workload.projectId, previousDeploymentId: 'dpl_Prior' };
    const intent = { ...base, trafficAuthorized: false, promotionAuthorized: false };
    const promotion = { ...base, deploymentId, previousAliasRequestedAt: 1 };
    const records = {
      'frontend-build-started.json': intent,
      'frontend-build-created.json': { ...intent, deploymentId },
      'frontend-build-outcome.json': { ...intent, deploymentId, status: 'FRONTEND_STAGED', phase: 'completed', readyState: 'READY', url: deploymentUrl },
      'frontend-workload-outcome.json': { ...base, deploymentId, status: 'FRONTEND_VERIFIED', contractPhase: 'p2',
        phase2ContractManifestSha256: plan.phase2ContractManifestSha256, featureControls: inventory.certification.featureControls,
        writerAdmissionBinding: plan.writerAdmissionBinding, trafficAuthorized: false, nativeSchedulerVerified: false },
      'frontend-promotion-started.json': promotion,
      'frontend-promotion-outcome.json': { ...promotion, trafficAuthorized: false, status: 'FRONTEND_DOMAINS_PROMOTED',
        phase: 'completed', frontendDomainsPromoted: true, aliasRequestedAt: 2 },
    };
    const readyReceiptSha256 = Object.fromEntries(Object.entries(records).map(([name, row]) => {
      const path = join(vercel, name); write(path, row); return [name, rawHash(readFileSync(path))];
    }));
    const configurationRecordSha256 = readyReceiptSha256['frontend-workload-outcome.json'];
    const terminal = { version: 2, qualificationTargetProfile: profile, status: 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
      ...Object.fromEntries(['environment', 'releaseId', 'sourceCommit', 'candidateSha256', 'targetSha256', 'inventorySha256',
        'contractPhase', 'phase2ContractManifestSha256', 'configurationSha256', 'frontendSqlApplied', 'historicalProviderClosureClaimed',
        'oldP200Qualified', 'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted'].map(key => [key, plan[key]])),
      frontendWorkloadReceiptSha256: configurationRecordSha256,
      ...Object.fromEntries(['frontendDatabaseReceiptSha256', 'frontendTerminalSha256', 'frontendContinuationCompletedSha256',
        'frontendReleaseOutcomeSha256', 'frontendSessionClosedSha256', 'apiRuntimeReceiptSha256', 'migrationOutcomeSha256']
        .map(name => [name, '9'.repeat(64)])) };
    const terminalPath = join(frontend, 'p2-profiled-current-host-outcome.json'); write(terminalPath, terminal);
    const settings = { version: 2, environment: 'staging', qualificationTargetProfile: profile, operatorSourceCommit: plan.sourceCommit,
      releaseSettings: f.settings, certification: { version: 2, environment: 'staging', qualificationTargetProfile: profile,
        certificationActionId: 'owned-certification', mode: 'contain-native', startState: 'already-closed', initialEpoch: '1',
        candidateSha256: plan.candidateSha256, inventorySha256: plan.inventorySha256, configurationSha256: hash(plan.configurationSha256),
        readyReceiptSha256, runtimeInventorySha256: '1'.repeat(64), gatewayProcessSha256: '2'.repeat(64),
        gatewayConfigurationSha256: plan.configurationSha256['gateway.json'], operatorSourceClosureSha256: '4'.repeat(64),
        native: { version: 2, qualificationTargetProfile: profile, actionId: plan.releaseId, deploymentId, deploymentUrl, configurationRecordSha256,
          epoch: '1', target: migration.job.target, targetSha256: plan.targetSha256, owner: inventory.owner,
          producer: inventory.producers[0], featureControls: inventory.certification.featureControls,
          windowSeconds: 60, drainSeconds: 15, finalDisposition: 'disabled-and-admission-closed',
          commandWitnesses: [{ commandId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', accountVersion: '1', action: 'suspend' }] } } };
    const output = prepareP2ProfiledCertificationOperator(settings);
    assert.equal(output.version, 2);
    assert.equal(output.wholeReleaseAccepted, false);
    assert.deepEqual(output.qualificationTargetProfile, profile);
    assert.equal(output.nativePlan.configurationRecordSha256, configurationRecordSha256);
    assert.deepEqual(output.apiJobSha256, plan.apiJobSha256);
    assert.equal(output.originalReleasePlanSha256, hash(plan));
    assert.equal(output.originalReleaseReceiptSha256, rawHash(readFileSync(terminalPath)));
    await assert.rejects(runP2BoundedCertification(output, {}), /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator(settings, { confirmation: 'staging/another-action' }), /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator(settings, { confirmation: 'staging/owned-certification' }), { code: 'ENOENT' });
    assert.equal(existsSync(join(f.settings.results, 'owned-certification-ssh')), false);
    assert.equal(existsSync(join(f.settings.results, 'owned-certification')), false);

    const scoped = (mode, scopedAction) => ({ ...settings, certification: { ...settings.certification, mode,
      certificationActionId: 'owned-scoped-action', native: { ...settings.certification.native, commandWitnesses: [] }, scopedAction,
      ...(['export-cleanup', 'lifecycle-persistence'].includes(mode) ? { persistenceReviewedSha256: 'b'.repeat(64) } : {}) } });
    const selectedCommand = { commandId: '10000000-0000-4000-8000-000000000001', readyRecordSha256: 'a'.repeat(64) };
    const selectedMux = { attemptId: '10000000-0000-4000-8000-000000000002', generation: 2,
      environmentId: 'owned-environment', assetId: null, uploadId: 'owned-upload', eventType: 'video.upload.asset_created' };
    const selectedPersistence = { stage: 'verify-delete', subjectBindingSha256: 'a'.repeat(64) };
    const courseId = '10000000-0000-4000-8000-000000000002';
    const userId = '10000000-0000-4000-8000-000000000004';
    const paidKey = '10000000-0000-4000-8000-000000000006';
    const paidReason = 'Owned controlled access';
    const emptyBodySha256 = rawHash(Buffer.alloc(0));
    const paidQuery = 'idempotencyKey=owner-paid%3A' + paidKey + '&limit=2';
    const selectedInteractive = { stage: 'paid-grant', actorId: '10000000-0000-4000-8000-000000000003', windowSeconds: 90,
      paidGrantAction: { operation: 'grant-paid-access', courseId, userId, revision: 1, idempotencyKey: paidKey, reasonSha256: rawHash(paidReason) },
      requests: [
        { method: 'GET', target: '/course/v1/admin/courses/' + courseId, bodySha256: emptyBodySha256, uses: 3 },
        { method: 'GET', target: '/course/v1/admin/entitlements/commands?' + paidQuery, bodySha256: emptyBodySha256, uses: 2 },
        { method: 'POST', target: '/course/v1/admin/entitlements/grants', uses: 1,
          bodySha256: rawHash(JSON.stringify({ userId, courseId, reason: '[paid-course revision 1] ' + paidReason, idempotencyKey: 'owner-paid:' + paidKey })) },
        { method: 'GET', target: `/course/v1/admin/entitlements/grants?userId=${userId}&courseId=${courseId}&${paidQuery}`,
          bodySha256: emptyBodySha256, uses: 1 },
      ] };
    const selectedLifecycle = { stage: 'lifecycle', actorId: selectedInteractive.actorId, requests: [], windowSeconds: 90,
      frontendAction: { actorKind: 'admin', userId, operation: 'suspend' } };
    const authoringDraft = { title: 'Owned reviewed draft', slug: 'owned-reviewed-draft', description: null, introduction: null,
      currency: 'CAD', accessMode: 'free', priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null, status: 'draft' };
    const selectedAuthoring = { stage: 'authoring', actorId: selectedInteractive.actorId, windowSeconds: 90,
      authoringAction: { operation: 'create-draft', slug: authoringDraft.slug }, requests: [
        { method: 'GET', target: '/course/v1/admin/courses?limit=100', bodySha256: rawHash(Buffer.alloc(0)), uses: 1 },
        { method: 'POST', target: '/course/v1/admin/courses', bodySha256: rawHash(JSON.stringify(authoringDraft)), uses: 1 },
      ] };
    const paired = (scope, identity = { certificationActionId: 'owned-identity-action', initialEpoch: '7', windowSeconds: 240 }) => {
      const selected = scoped('interactive-browser', scope);
      return { ...selected, interactiveIdentity: identity, certification: { ...selected.certification, initialEpoch: '9' } };
    };
    const scopedVerifier = 'import json,sys;sys.path.insert(0,sys.argv[1]);import p2_certification_parent as p;' +
      'packet=json.load(sys.stdin);p._require_profiled_scoped_action(packet["mode"],packet["scopedAction"])';
    const paidSettings = paired(selectedInteractive), paidPair = prepareP2ProfiledCertificationOperator(paidSettings);
    assert.equal(paidPair.status, 'P2_INTERACTIVE_PAID_GRANT_ACTIONS_PLANNED');
    assert.deepEqual(paidPair['paid-grant'].scopedAction, selectedInteractive);
    assert.deepEqual(paidPair.identity.scopedAction.identityActor, { actorKind: 'admin', actorId: selectedInteractive.actorId });
    assert.equal(JSON.stringify(paidPair).includes(paidReason), false);
    const paidHostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(paidPair['paid-grant']), encoding: 'utf8' });
    assert.equal(paidHostPlan.status, 0, paidHostPlan.stderr);
    const secondGrant = { ...selectedInteractive, paidGrantAction: { ...selectedInteractive.paidGrantAction,
      priorGrantId: '10000000-0000-4000-8000-000000000009' } };
    const secondPair = prepareP2ProfiledCertificationOperator(paired(secondGrant));
    assert.deepEqual(secondPair['paid-grant'].scopedAction, secondGrant);
    assert.notEqual(secondPair['paid-grant'].planSha256, paidPair['paid-grant'].planSha256);
    assert.equal(spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(secondPair['paid-grant']), encoding: 'utf8' }).status, 0);
    for (const priorGrantId of [null, [], 'unreviewed-prior-grant']) {
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...secondGrant,
        paidGrantAction: { ...secondGrant.paidGrantAction, priorGrantId } })));
    }
    const paidConfirmation = { confirmation: 'staging/owned-scoped-action' };
    await assert.rejects(p2ProfiledCertificationOperator({ ...paidSettings, execution: { reason: paidReason } }, paidConfirmation), { code: 'ENOENT' });
    for (const execution of [undefined, { reason: 'unreviewed' }, { reason: ' ' + paidReason }, { reason: paidReason, extra: true }])
      await assert.rejects(p2ProfiledCertificationOperator({ ...paidSettings, execution }, paidConfirmation), /P2_CERTIFICATION_PARENT_REFUSED/);
    const [paidDetail, paidCommands, paidWrite, paidReadback] = selectedInteractive.requests;
    for (const requests of [[paidDetail, paidWrite], [paidCommands, paidDetail, paidWrite, paidReadback],
      [paidDetail, { ...paidCommands, uses: 1 }, paidWrite, paidReadback],
      [paidDetail, paidCommands, paidWrite, { ...paidReadback, target: paidReadback.target.replace('%3A', '%3a') }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedInteractive, requests })));
    await assert.rejects(p2ProfiledCertificationOperator({
      ...paired({ ...selectedInteractive, requests: [paidDetail, paidCommands, { ...paidWrite, bodySha256: '1'.repeat(64) }, paidReadback] }),
      execution: { reason: paidReason },
    }, paidConfirmation), /P2_CERTIFICATION_PARENT_REFUSED/);
    const revokeGrantId = '10000000-0000-4000-8000-00000000000a';
    const revokeKey = '10000000-0000-4000-8000-00000000000b';
    const revokeReason = 'Owned reviewed grant removal';
    const revokeRequest = { scope: 'grantId', grantId: revokeGrantId, reason: '[paid-course revision 1] ' + revokeReason,
      idempotencyKey: 'owner-paid-revoke:' + revokeKey };
    const selectedRevoke = {
      stage: 'paid-revoke', actorId: selectedInteractive.actorId, windowSeconds: 90,
      paidRevokeAction: { operation: 'revoke-paid-grant', courseId, userId, grantId: revokeGrantId, revision: 1,
        idempotencyKey: revokeKey, reasonSha256: rawHash(revokeReason), remainingAccess: false },
      requests: [
        paidDetail,
        { ...paidCommands, target: '/course/v1/admin/entitlements/commands?idempotencyKey=owner-paid-revoke%3A' + revokeKey + '&limit=2' },
        { method: 'GET', target: `/course/v1/admin/entitlements/grants?grantId=${revokeGrantId}&userId=${userId}&courseId=${courseId}&limit=2`,
          uses: 2, bodySha256: emptyBodySha256 },
        { method: 'POST', target: '/course/v1/admin/entitlements/revocations', uses: 1, bodySha256: rawHash(JSON.stringify(revokeRequest)) },
      ],
    };
    for (const remainingAccess of [false, true]) {
      const scope = { ...selectedRevoke, paidRevokeAction: { ...selectedRevoke.paidRevokeAction, remainingAccess } };
      const settings = paired(scope), prepared = prepareP2ProfiledCertificationOperator(settings);
      assert.equal(prepared.status, 'P2_INTERACTIVE_PAID_REVOKE_ACTIONS_PLANNED');
      assert.deepEqual(prepared['paid-revoke'].scopedAction, scope);
      assert.deepEqual(prepared.identity.scopedAction.identityActor, { actorKind: 'admin', actorId: selectedRevoke.actorId });
      assert.equal(JSON.stringify(prepared).includes(revokeReason), false);
      const checked = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(prepared['paid-revoke']), encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: { reason: revokeReason } }, paidConfirmation), /P2_PAID_REVOKE_COURSE_SOURCE_REQUIRED/u);
    }
    const revokeSettings = paired(selectedRevoke);
    for (const execution of [undefined, { reason: 'unreviewed' }, { reason: ' ' + revokeReason }, { reason: revokeReason + '\n' },
      { reason: 'x'.repeat(1801) }, { reason: revokeReason, extra: true }])
      await assert.rejects(p2ProfiledCertificationOperator({ ...revokeSettings, execution }, paidConfirmation), /P2_CERTIFICATION_PARENT_REFUSED/);
    const [revokeDetail, revokeCommands, revokeGrant, revokeWrite] = selectedRevoke.requests;
    for (const requests of [[revokeDetail, revokeCommands, revokeWrite, revokeGrant], [revokeDetail, revokeCommands, { ...revokeGrant, uses: 1 }, revokeWrite],
      [revokeDetail, { ...revokeCommands, target: revokeCommands.target.replace('%3A', ':') }, revokeGrant, revokeWrite],
      [revokeDetail, revokeCommands, revokeGrant, { ...revokeWrite, bodySha256: emptyBodySha256 }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedRevoke, requests })));
    for (const changed of [{ remainingAccess: 'true' }, { grantId: 'invalid' }, { revision: 0 }, { reasonSha256: emptyBodySha256 }])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedRevoke, paidRevokeAction: { ...selectedRevoke.paidRevokeAction, ...changed } })));
    const { scope: revokeRequestScope, ...reorderedRevokeRequest } = revokeRequest;
    await assert.rejects(p2ProfiledCertificationOperator({
      ...paired({ ...selectedRevoke, requests: [revokeDetail, revokeCommands, revokeGrant,
        { ...revokeWrite, bodySha256: rawHash(JSON.stringify({ ...reorderedRevokeRequest, scope: revokeRequestScope })) }] }),
      execution: { reason: revokeReason },
    }, paidConfirmation), /P2_CERTIFICATION_PARENT_REFUSED/);
    const selectedFree = { stage: 'learning', actorId: userId, windowSeconds: 90,
      learningAction: { operation: 'enroll-free-course', courseId, slug: 'owned-free-course',
        idempotencyKey: '10000000-0000-4000-8000-000000000005' } };
    const freeCourse = '/course/v1/student/courses/' + courseId;
    selectedFree.requests = [
      { method: 'GET', target: '/course/v1/courses/owned-free-course', bodySha256: emptyBodySha256, uses: 1 },
      { method: 'GET', target: freeCourse, bodySha256: emptyBodySha256, uses: 2 },
      { method: 'POST', target: freeCourse + '/enrollments',
        bodySha256: rawHash(JSON.stringify({ idempotencyKey: selectedFree.learningAction.idempotencyKey })), uses: 1 },
      { method: 'GET', target: '/course/v1/student/progress?courseId=' + courseId, bodySha256: emptyBodySha256, uses: 1 },
    ];
    const freeSettings = paired(selectedFree), freePair = prepareP2ProfiledCertificationOperator(freeSettings);
    assert.equal(freePair.status, 'P2_INTERACTIVE_LEARNING_ACTIONS_PLANNED');
    assert.deepEqual(freePair.learning.scopedAction, selectedFree);
    assert.deepEqual(freePair.identity.scopedAction.identityActor, { actorKind: 'customer', actorId: userId });
    const freeHostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(freePair.learning), encoding: 'utf8' });
    assert.equal(freeHostPlan.status, 0, freeHostPlan.stderr);
    await assert.rejects(p2ProfiledCertificationOperator(freeSettings, { confirmation: 'staging/owned-scoped-action' }), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...freeSettings, execution: {} },
      { confirmation: 'staging/owned-scoped-action' }), error => error.code !== 'ENOENT');
    const [catalogRead, learnerRead, grant, progressRead] = selectedFree.requests;
    for (const requests of [[catalogRead, learnerRead, grant], [catalogRead, grant, learnerRead, progressRead],
      [catalogRead, { ...learnerRead, uses: 1 }, grant, progressRead],
      [catalogRead, learnerRead, { ...grant, bodySha256: 'd'.repeat(64) }, progressRead],
      [catalogRead, learnerRead, grant, { ...progressRead, target: '/course/v1/student/progress' }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedFree, requests })));
    assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedFree,
      learningAction: { ...selectedFree.learningAction, idempotencyKey: userId } })));
    const prior = {
      grantId: '10000000-0000-4000-8000-000000000010', enrollmentId: '10000000-0000-4000-8000-000000000011',
      eventId: '10000000-0000-4000-8000-000000000012', streamId: '10000000-0000-4000-8000-000000000013',
      canonicalDigest: 'a'.repeat(64),
    };
    const replayScope = { ...selectedFree, learningAction: { ...selectedFree.learningAction, operation: 'replay-free-enrollment', prior },
      requests: [{ ...learnerRead, uses: 1 }, progressRead, grant] };
    const replay = prepareP2ProfiledCertificationOperator(paired(replayScope));
    assert.deepEqual(replay.learning.scopedAction, replayScope);
    assert.notEqual(replay.learning.planSha256, freePair.learning.planSha256);
    const replayHost = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(replay.learning), encoding: 'utf8' });
    assert.equal(replayHost.status, 0, replayHost.stderr);
    for (const badPrior of [null, { ...prior, canonicalDigest: '0'.repeat(64) }, { ...prior, eventId: 'other' }]) {
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...replayScope,
        learningAction: { ...replayScope.learningAction, prior: badPrior } })));
    }
    assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...replayScope, requests: selectedFree.requests })));
    const accessLessonId = '10000000-0000-4000-8000-000000000007';
    const accessGrantId = '10000000-0000-4000-8000-000000000008';
    const student = '/course/v1/student', lesson = student + '/lessons/' + accessLessonId;
    const selectedAccess = {
      stage: 'learner-access', actorId: userId, windowSeconds: 90,
      learnerAccessAction: { operation: 'observe-paid-access', courseId, lessonId: accessLessonId, grantId: accessGrantId, revision: 2_147_483_647, outcome: 'allowed' },
      requests: [student + '/courses/' + courseId, student + '/progress?courseId=' + courseId, lesson, lesson + '/playback',
        student + '/progress?lessonId=' + accessLessonId, lesson + '/quiz', lesson + '/quiz/attempts']
        .map((target, index) => ({ method: 'GET', target, bodySha256: emptyBodySha256, uses: index === 0 ? 2 : 1 })),
    };
    for (const outcome of ['allowed', 'archived', 'draft', 'restricted']) {
      const scope = { ...selectedAccess, learnerAccessAction: { ...selectedAccess.learnerAccessAction, outcome } };
      const prepared = prepareP2ProfiledCertificationOperator(paired(scope));
      assert.equal(prepared.status, 'P2_INTERACTIVE_LEARNER_ACCESS_ACTIONS_PLANNED');
      assert.deepEqual(prepared['learner-access'].scopedAction, scope);
      assert.deepEqual(prepared.identity.scopedAction.identityActor, { actorKind: 'customer', actorId: userId });
      assert.equal(BigInt(prepared['learner-access'].initialEpoch) - BigInt(prepared.identity.initialEpoch), 2n);
      const checked = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(prepared['learner-access']), encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
    }
    const accessSettings = paired(selectedAccess), accessConfirmation = { confirmation: 'staging/owned-scoped-action' };
    await assert.rejects(p2ProfiledCertificationOperator(accessSettings, accessConfirmation), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...accessSettings, execution: {} }, accessConfirmation), error => error.code !== 'ENOENT');
    const [accessRead, ...accessRemaining] = selectedAccess.requests;
    for (const requests of [selectedAccess.requests.toReversed(), [accessRead, ...accessRemaining.slice(0, -1)],
      [{ ...accessRead, uses: 1 }, ...accessRemaining], [{ ...accessRead, method: 'POST' }, ...accessRemaining],
      [{ ...accessRead, bodySha256: 'f'.repeat(64) }, ...accessRemaining]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedAccess, requests })));
    for (const changed of [{ outcome: 'unknown' }, { lessonId: 'invalid' }, { grantId: 'invalid' }, { revision: 0 }, { revision: 2_147_483_648 }])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedAccess, learnerAccessAction: { ...selectedAccess.learnerAccessAction, ...changed } })));
    const selectedLessonEntry = {
      stage: 'lesson-entry', actorId: userId, windowSeconds: 90,
      lessonEntryAction: { operation: 'open-lesson', courseId, lessonId: accessLessonId, grantId: accessGrantId },
      requests: [
        ...[student + '/courses/' + courseId, student + '/progress?courseId=' + courseId, lesson,
          student + '/progress?lessonId=' + accessLessonId, lesson + '/quiz', lesson + '/quiz/attempts', lesson + '/playback']
          .map((target, index) => ({ method: 'GET', target, bodySha256: emptyBodySha256, uses: index === 0 ? 2 : 1 })),
        { method: 'POST', target: lesson + '/progress', uses: 1,
          bodySha256: rawHash(JSON.stringify({ event: 'lesson_started', expectedProgressRevision: 0 })) },
      ],
    };
    const lessonSettings = paired(selectedLessonEntry), lessonPair = prepareP2ProfiledCertificationOperator(lessonSettings);
    assert.equal(lessonPair.status, 'P2_INTERACTIVE_LESSON_ENTRY_ACTIONS_PLANNED');
    assert.deepEqual(lessonPair['lesson-entry'].scopedAction, selectedLessonEntry);
    assert.deepEqual(lessonPair.identity.scopedAction.identityActor, { actorKind: 'customer', actorId: userId });
    const lessonHost = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(lessonPair['lesson-entry']), encoding: 'utf8' });
    assert.equal(lessonHost.status, 0, lessonHost.stderr);
    await assert.rejects(p2ProfiledCertificationOperator({ ...lessonSettings, execution: {} }, accessConfirmation), error => error.code !== 'ENOENT');
    const lessonReadRows = selectedLessonEntry.requests.slice(0, -1), lessonWrite = selectedLessonEntry.requests.at(-1);
    for (const requests of [lessonReadRows, [...lessonReadRows, { ...lessonWrite, uses: 2 }],
      [...lessonReadRows, { ...lessonWrite, bodySha256: rawHash(JSON.stringify({ event: 'lesson_started', expectedProgressRevision: 1 })) }],
      [...lessonReadRows, { ...lessonWrite, target: student + '/lessons/' + courseId + '/progress' }]]) {
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedLessonEntry, requests })));
    }
    const selectedLessonDenial = {
      stage: 'lesson-denial', actorId: userId, windowSeconds: 90,
      lessonDenialAction: { operation: 'deny-cross-account', courseId, lessonId: accessLessonId,
        enrolledActorId: '10000000-0000-4000-8000-000000000015', grantId: accessGrantId },
      requests: [student + '/courses/' + courseId, lesson, student + '/progress?lessonId=' + accessLessonId,
        lesson + '/quiz', lesson + '/quiz/attempts', lesson + '/playback']
        .map((target, index) => ({ method: 'GET', target, bodySha256: emptyBodySha256, uses: [2, 3, 3, 3, 3, 1][index] })),
    };
    const denialSettings = paired(selectedLessonDenial), denialPair = prepareP2ProfiledCertificationOperator(denialSettings);
    assert.equal(denialPair.status, 'P2_INTERACTIVE_LESSON_DENIAL_ACTIONS_PLANNED');
    assert.deepEqual(denialPair['lesson-denial'].scopedAction, selectedLessonDenial);
    assert.deepEqual(denialPair.identity.scopedAction.identityActor, { actorKind: 'customer', actorId: userId });
    assert.equal(BigInt(denialPair['lesson-denial'].initialEpoch) - BigInt(denialPair.identity.initialEpoch), 2n);
    const denialHost = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(denialPair['lesson-denial']), encoding: 'utf8' });
    assert.equal(denialHost.status, 0, denialHost.stderr);
    await assert.rejects(p2ProfiledCertificationOperator(denialSettings, accessConfirmation), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...denialSettings, execution: {} }, accessConfirmation), error => error.code !== 'ENOENT');
    assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedLessonDenial,
      lessonDenialAction: { ...selectedLessonDenial.lessonDenialAction, enrolledActorId: userId } })));
    const denialReadRows = selectedLessonDenial.requests;
    for (const requests of [denialReadRows.toReversed(), [...denialReadRows, lessonWrite],
      denialReadRows.map((row, index) => index === 2 ? { ...row, target: row.target + '&limit=1' } : row)]) {
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedLessonDenial, requests })));
    }
    const draftPair = prepareP2ProfiledCertificationOperator(paired(selectedAuthoring));
    assert.equal(draftPair.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
    assert.deepEqual(draftPair.authoring.scopedAction, selectedAuthoring);
    assert.deepEqual(draftPair.identity.scopedAction.identityActor, { actorKind: 'admin', actorId: selectedAuthoring.actorId });
    assert.equal(BigInt(draftPair.authoring.initialEpoch) - BigInt(draftPair.identity.initialEpoch), 2n);
    assert.equal(JSON.stringify(draftPair).includes(authoringDraft.title), false);
    const draftHostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(draftPair.authoring), encoding: 'utf8' });
    assert.equal(draftHostPlan.status, 0, draftHostPlan.stderr);
    const draftSettings = paired(selectedAuthoring);
    await assert.rejects(p2ProfiledCertificationOperator(draftSettings, { confirmation: 'staging/owned-scoped-action' }), /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator({ ...draftSettings, execution: { authoringDraft: { ...authoringDraft, title: 'Other title' } } },
      { confirmation: 'staging/owned-scoped-action' }), error => error.code !== 'ENOENT');
    await assert.rejects(p2ProfiledCertificationOperator({ ...draftSettings, execution: { authoringDraft } },
      { confirmation: 'staging/owned-scoped-action' }), { code: 'ENOENT' });
    for (const requests of [selectedAuthoring.requests.toReversed(), [selectedAuthoring.requests[0]],
      [{ ...selectedAuthoring.requests[0], target: '/course/v1/admin/courses?limit=99' }, selectedAuthoring.requests[1]],
      [selectedAuthoring.requests[0], { ...selectedAuthoring.requests[1], uses: 2 }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedAuthoring, requests })));
    const { status: _draftStatus, ...draftFields } = authoringDraft;
    const authoringDraftEdits = {
      winner: { ...draftFields, title: 'Owned winning edit', expectedRevision: 1 },
      stale: { ...draftFields, title: 'Owned stale edit', expectedRevision: 1 },
    };
    const editPath = `/course/v1/admin/courses/${courseId}`;
    const selectedEdit = { ...selectedAuthoring,
      authoringAction: { operation: 'edit-and-stale-draft', courseId, slug: authoringDraft.slug, revision: 1 },
      requests: [
        { method: 'GET', target: editPath, bodySha256: rawHash(Buffer.alloc(0)), uses: 3 },
        ...Object.values(authoringDraftEdits).map(body => ({ method: 'PATCH', target: editPath, bodySha256: rawHash(JSON.stringify(body)), uses: 1 })),
      ] };
    const editSettings = paired(selectedEdit), editPair = prepareP2ProfiledCertificationOperator(editSettings);
    assert.equal(editPair.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
    assert.deepEqual(editPair.authoring.scopedAction, selectedEdit);
    assert.deepEqual(editPair.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
    assert.equal(JSON.stringify(editPair).includes(authoringDraftEdits.stale.title), false);
    const editHostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(editPair.authoring), encoding: 'utf8' });
    assert.equal(editHostPlan.status, 0, editHostPlan.stderr);
    await assert.rejects(p2ProfiledCertificationOperator({ ...editSettings, execution: { authoringDraftEdits } },
      { confirmation: 'staging/owned-scoped-action' }), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...editSettings, execution: {
      authoringDraftEdits: { ...authoringDraftEdits, stale: { ...authoringDraftEdits.stale, expectedRevision: 2 } },
    } }, { confirmation: 'staging/owned-scoped-action' }), error => error.code !== 'ENOENT');
    for (const requests of [selectedEdit.requests.toReversed(), selectedEdit.requests.slice(0, 2),
      [{ ...selectedEdit.requests[0], uses: 2 }, ...selectedEdit.requests.slice(1)],
      [selectedEdit.requests[0], selectedEdit.requests[1], { ...selectedEdit.requests[1] }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedEdit, requests })));
    const before = [1, 2, 3].map(number => `90000000-0000-4000-8000-00000000000${number}`);
    const authoringReorder = {
      before,
      winner: { expectedCourseRevision: 1, ids: [before[1], before[0], before[2]] },
      stale: { expectedCourseRevision: 1, ids: [before[0], before[2], before[1]] },
    };
    const lessonParent = '80000000-0000-4000-8000-000000000001';
    const selectedReorders = ['module', 'lesson'].map(kind => {
      const parentId = kind === 'module' ? courseId : lessonParent;
      const target = kind === 'module' ? editPath + '/modules/reorder' : `/course/v1/admin/modules/${parentId}/lessons/reorder`;
      return { ...selectedEdit, authoringAction: { ...selectedEdit.authoringAction, operation: 'reorder-and-stale-curriculum', kind, parentId },
        requests: [selectedEdit.requests[0], ...[authoringReorder.winner, authoringReorder.stale].map(body => ({
          method: 'POST', target, bodySha256: rawHash(JSON.stringify(body)), uses: 1,
        }))] };
    });
    for (const selectedReorder of selectedReorders) {
      const reorderSettings = paired(selectedReorder), reorderPair = prepareP2ProfiledCertificationOperator(reorderSettings);
      assert.equal(reorderPair.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
      assert.deepEqual(reorderPair.authoring.scopedAction, selectedReorder);
      assert.deepEqual(reorderPair.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
      assert.equal(JSON.stringify(reorderPair).includes(before[0]), false);
      const hostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(reorderPair.authoring), encoding: 'utf8' });
      assert.equal(hostPlan.status, 0, hostPlan.stderr);
      const confirmation = { confirmation: 'staging/owned-scoped-action' };
      await assert.rejects(p2ProfiledCertificationOperator({ ...reorderSettings, execution: { authoringReorder } }, confirmation), { code: 'ENOENT' });
      await assert.rejects(p2ProfiledCertificationOperator({ ...reorderSettings,
        execution: { authoringReorder: { ...authoringReorder, before: before.toReversed() } } }, confirmation), error => error.code !== 'ENOENT');
      const [read, winner, stale] = selectedReorder.requests;
      for (const requests of [[read, winner, winner], [read, winner, { ...stale, method: 'PATCH' }],
        [read, winner, { ...stale, uses: 2 }], [{ ...read, uses: 2 }, winner, stale], [read, winner, { ...stale, target: editPath }]])
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedReorder, requests })));
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedReorder,
        authoringAction: { ...selectedReorder.authoringAction, parentId: before[0] } })));
    }
    const selectedCurriculum = selectedReorders.map(({ authoringAction, requests }, index) => {
      const base = { expectedCourseRevision: 1, title: 'Owned private scaffold', slug: 'owned-child', position: 1 };
      const authoringCurriculum = authoringAction.kind === 'module'
        ? { expectedCourseRevision: base.expectedCourseRevision, title: base.title, slug: base.slug, description: null, position: base.position }
        : { ...base, contentDocument: { version: 1, blocks: [
          { _type: 'block', _key: 'block-1-1', style: 'h2',
            children: [{ _type: 'span', _key: 'span-1-1', text: 'Reviewed lesson text', marks: ['strong', 'link-1-1'] }],
            markDefs: [{ _type: 'link', _key: 'link-1-1', href: '/courses' }] },
        ] }, transcript: 'Private transcript', isPreview: false, captions: [] };
      return [{ ...selectedReorders[index],
        authoringAction: { ...authoringAction, operation: 'create-curriculum', childSlug: base.slug },
        requests: [{ ...requests[0], uses: 2 }, { ...requests[1], target: requests[1].target.replace(/\/reorder$/u, ''),
          bodySha256: rawHash(JSON.stringify(authoringCurriculum)) }] }, authoringCurriculum];
    });
    for (const [selected, authoringCurriculum] of selectedCurriculum) {
      const settings = paired(selected), planned = prepareP2ProfiledCertificationOperator(settings);
      assert.equal(planned.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
      assert.deepEqual(planned.authoring.scopedAction, selected);
      assert.deepEqual(planned.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
      assert.equal(JSON.stringify(planned).includes(authoringCurriculum.title), false);
      const hostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(planned.authoring), encoding: 'utf8' });
      assert.equal(hostPlan.status, 0, hostPlan.stderr);
      const confirmation = { confirmation: 'staging/owned-scoped-action' };
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: { authoringCurriculum } }, confirmation), { code: 'ENOENT' });
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: {
        authoringCurriculum: { ...authoringCurriculum, expectedCourseRevision: 2 },
      } }, confirmation), error => error.code !== 'ENOENT');
      const [read, write] = selected.requests;
      for (const requests of [[read, write, write], [read, { ...write, method: 'PATCH' }],
        [read, { ...write, target: write.target + '/reorder' }], [{ ...read, uses: 1 }, write]])
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected, requests })));
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected,
        authoringAction: { ...selected.authoringAction, childSlug: 'Other child' } })));
    }
    const selectedPublications = ['published', 'blocked'].map(outcome => {
      const published = outcome === 'published';
      const { courseId, slug, revision } = selectedEdit.authoringAction;
      const reads = [
        { ...selectedEdit.requests[0], uses: published ? 2 : 1 },
        { ...selectedEdit.requests[0], target: editPath + '/publication-readiness', uses: 1 },
      ];
      return { ...selectedEdit, authoringAction: { operation: 'qualify-publication', courseId, slug, revision, outcome,
        issueCodes: published ? [] : ['LESSON_CONTENT_REQUIRED', 'TAX_CLASSIFICATION_REQUIRED'] },
        requests: published ? [...reads, { method: 'PATCH', target: editPath, uses: 1,
          bodySha256: rawHash(JSON.stringify({ expectedRevision: revision, status: 'published' })) }] : reads };
    });
    for (const selected of selectedPublications) {
      const settings = paired(selected), planned = prepareP2ProfiledCertificationOperator(settings);
      assert.equal(planned.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
      assert.deepEqual(planned.authoring.scopedAction, selected);
      assert.deepEqual(planned.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
      const hostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(planned.authoring), encoding: 'utf8' });
      assert.equal(hostPlan.status, 0, hostPlan.stderr);
      const confirmation = { confirmation: 'staging/owned-scoped-action' };
      await assert.rejects(p2ProfiledCertificationOperator(settings, confirmation), { code: 'ENOENT' });
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: { authoringDraft: {} } }, confirmation), error => error.code !== 'ENOENT');
      const [read, readiness] = selected.requests;
      for (const requests of [[read, { ...readiness, uses: 2 }, ...selected.requests.slice(2)],
        [readiness, read, ...selected.requests.slice(2)], [...selected.requests, selectedPublications[0].requests[2]]])
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected, requests })));
      const issueCodes = selected.authoringAction.outcome === 'published' ? ['MODULE_REQUIRED'] : ['Z_CODE', 'A_CODE'];
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected,
        authoringAction: { ...selected.authoringAction, issueCodes } })));
    }
    const [positivePublication] = selectedPublications;
    assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...positivePublication, requests: [
      ...positivePublication.requests.slice(0, 2), { ...positivePublication.requests[2], bodySha256: rawHash('{"status":"published","expectedRevision":1}') },
    ] })));
    const quizDocument = { version: 1, mode: 'graded', passingPercent: 80, questions: [
      { id: 'question-1-1', prompt: 'Private quiz prompt',
        options: [{ id: 'option-1-1', text: 'First' }, { id: 'option-1-2', text: 'Second' }],
        correctOptionId: 'option-1-1', feedback: 'Private feedback' },
    ] };
    const authoringQuiz = { expectedCourseRevision: 1, document: quizDocument };
    const quizPath = `/course/v1/admin/lessons/${lessonParent}/quiz`;
    const selectedQuizzes = [0, 1].map(quizRevision => ({
      ...selectedEdit, authoringAction: { ...selectedEdit.authoringAction, operation: 'save-quiz-revision',
        lessonId: lessonParent, quizRevision, documentSha256: p2NativeHash(quizDocument) },
      requests: [
        { ...selectedEdit.requests[0], uses: 2 },
        { method: 'GET', target: quizPath, uses: 1, bodySha256: rawHash(Buffer.alloc(0)) },
        { method: 'PUT', target: quizPath, uses: 1, bodySha256: rawHash(JSON.stringify(authoringQuiz)) },
      ],
    }));
    for (const selected of selectedQuizzes) {
      const settings = paired(selected), planned = prepareP2ProfiledCertificationOperator(settings);
      assert.deepEqual(planned.authoring.scopedAction, selected);
      assert.deepEqual(planned.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
      assert.equal(JSON.stringify(planned).includes(quizDocument.questions[0].prompt), false);
      const hostPlan = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(planned.authoring), encoding: 'utf8' });
      assert.equal(hostPlan.status, 0, hostPlan.stderr);
      const confirmation = { confirmation: 'staging/owned-scoped-action' };
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: { authoringQuiz } }, confirmation), { code: 'ENOENT' });
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: {
        authoringQuiz: { ...authoringQuiz, document: { ...quizDocument, mode: 'practice' } },
      } }, confirmation), error => error.code !== 'ENOENT');
      const [read, prior, write] = selected.requests;
      for (const requests of [[read, write], [read, write, prior], [read, prior, { ...write, uses: 2 }],
        [read, prior, { ...write, target: editPath }], [{ ...read, uses: 1 }, prior, write]])
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected, requests })));
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected,
        authoringAction: { ...selected.authoringAction, quizRevision: -1 } })));
    }
    const archiveGrantId = '10000000-0000-4000-8000-000000000009';
    const selectedArchive = {
      ...selectedEdit,
      authoringAction: { ...selectedEdit.authoringAction, operation: 'archive-paid-course', userId, grantId: archiveGrantId },
      requests: [
        { ...selectedEdit.requests[0], uses: 2 },
        { method: 'PATCH', target: editPath, uses: 1, bodySha256: rawHash(JSON.stringify({ expectedRevision: 1, status: 'archived' })) },
      ],
    };
    const archiveSettings = paired(selectedArchive), archivePlan = prepareP2ProfiledCertificationOperator(archiveSettings);
    assert.equal(archivePlan.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
    assert.deepEqual(archivePlan.authoring.scopedAction, selectedArchive);
    assert.deepEqual(archivePlan.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
    const archiveHost = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
      { input: JSON.stringify(archivePlan.authoring), encoding: 'utf8' });
    assert.equal(archiveHost.status, 0, archiveHost.stderr);
    const archiveConfirmation = { confirmation: 'staging/owned-scoped-action' };
    await assert.rejects(p2ProfiledCertificationOperator(archiveSettings, archiveConfirmation), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...archiveSettings, execution: {} }, archiveConfirmation), error => error.code !== 'ENOENT');
    const [archiveRead, archiveWrite] = selectedArchive.requests;
    for (const requests of [[{ ...archiveRead, uses: 1 }, archiveWrite], [archiveRead, { ...archiveWrite, method: 'POST' }],
      [archiveRead, archiveWrite, archiveWrite], [archiveRead, { ...archiveWrite, bodySha256: rawHash('{"status":"archived","expectedRevision":1}') }]])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedArchive, requests })));
    for (const changed of [{ revision: 2_147_483_647 }, { userId: 'invalid' }, { grantId: 'invalid' }, { outcome: 'archived' }])
      assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selectedArchive, authoringAction: { ...selectedArchive.authoringAction, ...changed } })));
    for (const [outcome, expectedAccess] of [['published', true], ['published', false], ['blocked', true]]) {
      const published = outcome === 'published', revision = 2;
      const issueCodes = published ? [] : ['LESSON_CONTENT_REQUIRED', 'TAX_CLASSIFICATION_REQUIRED'];
      const authoringAction = { ...selectedArchive.authoringAction, operation: 'republish-paid-course', revision, outcome, issueCodes, expectedAccess };
      const draft = { method: 'PATCH', target: editPath, uses: 1, bodySha256: rawHash(JSON.stringify({ expectedRevision: revision, status: 'draft' })) };
      const readiness = { ...archiveRead, target: editPath + '/publication-readiness', uses: 1 };
      const publish = { ...draft, bodySha256: rawHash(JSON.stringify({ expectedRevision: revision + 1, status: 'published' })) };
      const requests = [{ ...archiveRead, uses: published ? 3 : 2 }, draft, readiness, ...(published ? [publish] : [])];
      const selected = { ...selectedArchive, authoringAction, requests };
      const settings = paired(selected), planned = prepareP2ProfiledCertificationOperator(settings);
      assert.equal(planned.status, 'P2_INTERACTIVE_AUTHORING_ACTIONS_PLANNED');
      assert.deepEqual(planned.authoring.scopedAction, selected);
      assert.deepEqual(planned.identity.scopedAction.identityActor, draftPair.identity.scopedAction.identityActor);
      const checked = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(planned.authoring), encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
      await assert.rejects(p2ProfiledCertificationOperator(settings, archiveConfirmation), { code: 'ENOENT' });
      await assert.rejects(p2ProfiledCertificationOperator({ ...settings, execution: {} }, archiveConfirmation), error => error.code !== 'ENOENT');
      const invalidRequests = [[requests[0], readiness, draft, ...requests.slice(3)], [{ ...requests[0], uses: 1 }, ...requests.slice(1)]];
      invalidRequests.push(published ? [...requests.slice(0, 3), { ...publish,
        bodySha256: rawHash(JSON.stringify({ expectedRevision: revision, status: 'published' })) }] : [...requests, publish]);
      for (const invalid of invalidRequests)
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected, requests: invalid })));
      for (const changed of [{ revision: 2_147_483_646 }, { expectedAccess: 'yes' }, { grantId: 'invalid' },
        { issueCodes: published ? ['UNEXPECTED'] : [...issueCodes].reverse() }])
        assert.throws(() => prepareP2ProfiledCertificationOperator(paired({ ...selected, authoringAction: { ...authoringAction, ...changed } })));
    }
    const enrolledEmail = 'owned-enrollment@example.invalid';
    const firstEnrollments = ['google', 'resend'].map((provider, index) => {
      const nonce = String(index+1).repeat(32);
      const emailSha256 = rawHash(JSON.stringify(['p2q-customer-enrollment-v1', provider, nonce, enrolledEmail]));
      return { stage: 'identity', actorId: null, requests: [], windowSeconds: 240, identityEnrollment: { provider, emailSha256, nonce } };
    });
    for (const [mode, selected] of [['export-cleanup', selectedCommand], ['mux-callback-recovery', selectedMux],
      ['lifecycle-persistence', selectedPersistence],
      ...firstEnrollments.map(selected => ['interactive-browser', selected])]) {
      const preparedScope = prepareP2ProfiledCertificationOperator(scoped(mode, selected));
      assert.deepEqual(preparedScope.scopedAction, selected);
      assert.equal(preparedScope.maximumSeconds, 300);
      assert.equal(preparedScope.nativePlan.purpose, 'scoped-certification-control-only');
      assert.equal(preparedScope.nativePlan.initialEpoch, preparedScope.initialEpoch);
      assert.deepEqual(preparedScope.nativePlan.commandWitnesses, []);
      assert.equal(preparedScope.wholeReleaseAccepted, false);
      assert.equal(JSON.stringify(preparedScope).includes(enrolledEmail), false);
      const checked = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
        { input: JSON.stringify(preparedScope), encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
      await assert.rejects(p2ProfiledCertificationOperator(scoped(mode, selected), { confirmation: 'staging/unrelated-action' }),
        /P2_CERTIFICATION_PARENT_REFUSED/);
    }
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('export-cleanup',
      { ...selectedCommand, readyRecordSha256: '0'.repeat(64) })));
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('mux-callback-recovery',
      { ...selectedMux, eventType: 'video.asset.track.ready' })));
    await assert.rejects(p2ProfiledCertificationOperator(scoped('mux-callback-recovery', selectedMux),
      { confirmation: 'staging/owned-scoped-action' }), /P2_CERTIFICATION_PARENT_REFUSED/);
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('lifecycle-persistence',
      { ...selectedPersistence, stage: 'unreviewed-stage' })));
    await assert.rejects(p2ProfiledCertificationOperator(scoped('interactive-browser', selectedInteractive),
      { confirmation: 'staging/owned-scoped-action' }), /P2_CERTIFICATION_PARENT_REFUSED/);
    const enrollmentSettings = scoped('interactive-browser', firstEnrollments[0]);
    await assert.rejects(p2ProfiledCertificationOperator(enrollmentSettings, { confirmation: 'staging/owned-scoped-action' }),
      /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator({ ...enrollmentSettings, execution: { identityEnrollmentEmail: 'wrong@example.invalid' } },
      { confirmation: 'staging/owned-scoped-action' }), error => error.code !== 'ENOENT');
    await assert.rejects(p2ProfiledCertificationOperator({ ...enrollmentSettings, execution: { identityEnrollmentEmail: enrolledEmail } },
      { confirmation: 'staging/owned-scoped-action' }), { code: 'ENOENT' });
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('interactive-browser', { ...firstEnrollments[0],
      identityActor: { actorKind: 'customer', actorId: userId } })));
    const { paidGrantAction: _legacy, ...unscopedPaid } = selectedInteractive;
    assert.throws(() => prepareP2ProfiledCertificationOperator(paired(unscopedPaid)));
    for (const frontendAction of [
      undefined,
      { actorKind: 'customer', userId, operation: 'export' },
      { actorKind: 'customer', userId: selectedLifecycle.actorId, operation: 'suspend' },
      { actorKind: 'admin', userId, operation: 'preferences-on' },
      { actorKind: 'admin', userId, operation: 'suspend', commandId: courseId },
    ]) assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('interactive-browser', { ...selectedLifecycle, frontendAction })));
    const preferenceScope = { ...selectedLifecycle, actorId: userId,
      frontendAction: { actorKind: 'customer', userId, operation: 'preferences-off' } };
    for (const scope of [selectedLifecycle, preferenceScope]) {
      const pair = prepareP2ProfiledCertificationOperator(paired(scope));
      assert.equal(pair.status, 'P2_INTERACTIVE_LIFECYCLE_ACTIONS_PLANNED');
      assert.deepEqual(pair.lifecycle.scopedAction, scope);
      assert.deepEqual(pair.identity.scopedAction, { stage: 'identity', actorId: null, requests: [], windowSeconds: 240,
        identityActor: { actorKind: scope.frontendAction.actorKind, actorId: scope.actorId } });
      assert.equal(BigInt(pair.identity.initialEpoch) + 2n, BigInt(pair.lifecycle.initialEpoch));
      assert.equal(pair.identity.candidateSha256, pair.lifecycle.candidateSha256);
      for (const part of [pair.identity, pair.lifecycle]) {
        const checked = spawnSync('python3', ['-B', '-c', scopedVerifier, join(root, 'ops/platform/host')],
          { input: JSON.stringify(part), encoding: 'utf8' });
        assert.equal(checked.status, 0, checked.stderr);
      }
    }
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('interactive-browser', selectedLifecycle)));
    for (const invalid of [
      { certificationActionId: 'owned-scoped-action', initialEpoch: '7', windowSeconds: 240 },
      { certificationActionId: 'owned-identity-action', initialEpoch: '8', windowSeconds: 240 },
      { certificationActionId: 'owned-identity-action', initialEpoch: '7', windowSeconds: 240, actorId: userId },
    ]) assert.throws(() => prepareP2ProfiledCertificationOperator(paired(selectedLifecycle, invalid)));
    await assert.rejects(p2ProfiledCertificationOperator(paired(selectedLifecycle), { confirmation: 'staging/owned-identity-action' }),
      /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator(paired(preferenceScope), { confirmation: 'staging/owned-identity-action' }),
      /P2_CERTIFICATION_PARENT_REFUSED/);
    await assert.rejects(p2ProfiledCertificationOperator(paired(preferenceScope), { confirmation: 'staging/owned-scoped-action' }),
      { code: 'ENOENT' });
    const material = ['owned-interoperability-fixture-key', 'https://owned.vercel.app', 'a'.repeat(40), 'b'.repeat(64),
      '14', 'media', 1794009600, 90, 'c'.repeat(32)];
    const privateFixture = spawnSync('python3', ['-B', '-c',
      'import json,sys;sys.path.insert(0,sys.argv[1]);from p2_interactive_window import _material;print(json.dumps(_material(*json.load(sys.stdin))))',
      join(root, 'ops/platform/host')], { input: JSON.stringify(material), encoding: 'utf8' });
    assert.equal(privateFixture.status, 0, privateFixture.stderr);
    const [secret, deployment, sourceCommit, targetSha, epoch, stage, issued, duration, nonce] = material;
    const host = new URL(deployment).host, expires = issued + duration, binding = `${host}\n${sourceCommit}\n${targetSha}`;
    const sign = message => createHmac('sha256', secret).update(message).digest('hex');
    const cookieBody = `v1.${epoch}.${stage}.${issued}.${expires}.${nonce}`;
    assert.deepEqual(JSON.parse(privateFixture.stdout), [
      `${cookieBody}.${sign(`lash-her:p2q:interactive:browser:v1\n${binding}\n${cookieBody}`)}`,
      sign(`lash-her:p2q:interactive:gateway-key:v1\n${binding}\n${epoch}\n${stage}\n${nonce}`), host, expires,
    ]);
    for (const [selection, selector] of [
      [selectedLifecycle, rawHash(JSON.stringify(['admin', selectedLifecycle.actorId, userId, 'suspend']))],
      [selectedAuthoring, '7032712d617574686f72696e672d7631' + selectedAuthoring.actorId.replaceAll('-', '')],
      [selectedEdit, '7032712d617574682d656469742d7631' + selectedEdit.actorId.replaceAll('-', '')],
      ...selectedReorders.map(selection => [selection, '7032712d617574682d736f72742d7631' + selection.actorId.replaceAll('-', '')]),
      ...selectedCurriculum.map(([selection]) => [selection, '7032712d617574682d6e65772d763100' + selection.actorId.replaceAll('-', '')]),
      ...selectedPublications.map(selection => [selection, (selection.authoringAction.outcome === 'published'
        ? '7032712d617574682d7075622d763100' : '7032712d617574682d7264792d763100') + selection.actorId.replaceAll('-', '')]),
      ...selectedQuizzes.map(selection => [selection, '7032712d617574682d7175697a2d7631' + selection.actorId.replaceAll('-', '')]),
      [selectedFree, (selectedFree.actorId + selectedFree.learningAction.idempotencyKey).replaceAll('-', '')],
      [selectedLessonEntry, (userId + courseId + accessLessonId).replaceAll('-', '')],
      [selectedLessonDenial, (userId + courseId + accessLessonId).replaceAll('-', '')],
      [selectedInteractive, (selectedInteractive.actorId + paidKey).replaceAll('-', '')],
      [selectedAccess, (selectedAccess.actorId + accessLessonId).replaceAll('-', '')],
      [selectedRevoke, (selectedRevoke.actorId + revokeKey).replaceAll('-', '')],
      [prepareP2ProfiledCertificationOperator(paired(selectedLifecycle)).identity.scopedAction, rawHash(JSON.stringify(['identity', 'admin']))],
      [prepareP2ProfiledCertificationOperator(paired(preferenceScope)).identity.scopedAction, '7032712d637573746f6d65722d763100' + userId.replaceAll('-', '')],
      ...firstEnrollments.map(({ identityEnrollment, ...selection }) => [{ ...selection, identityEnrollment },
        (identityEnrollment.provider === 'google' ? 'a1' : 'a2') + identityEnrollment.emailSha256.slice(0,62)]),
    ]) {
      const scopedMaterial = [...material];
      scopedMaterial[5] = selection.stage;
      const scopedNonce = selection.identityEnrollment?.nonce ?? nonce;
      scopedMaterial[8] = scopedNonce;
      const frontendFixture = spawnSync('python3', ['-B', '-c',
        'import json,sys;sys.path.insert(0,sys.argv[1]);from p2_interactive_window import _selection_sha as digest,_material,validate_interactive_action as check;data=json.load(sys.stdin);print(json.dumps(_material(*data["material"],digest(check(data["action"])))))',
        join(root, 'ops/platform/host')], { input: JSON.stringify({ material: scopedMaterial, action: selection }), encoding: 'utf8' });
      assert.equal(frontendFixture.status, 0, frontendFixture.stderr);
      const frontendCookieBody = `v2.${epoch}.${selection.stage}.${issued}.${expires}.${scopedNonce}.${selector}`;
      const selectedGatewayKey = ['authoring', 'learning', 'lesson-entry', 'lesson-denial', 'paid-grant', 'learner-access', 'paid-revoke'].includes(selection.stage)
        ? sign(`lash-her:p2q:interactive:gateway-key:v1\n${binding}\n${epoch}\n${selection.stage}\n${scopedNonce}`) : null;
      assert.deepEqual(JSON.parse(frontendFixture.stdout), [
        `${frontendCookieBody}.${sign(`lash-her:p2q:interactive:browser:v1\n${binding}\n${frontendCookieBody}`)}`, selectedGatewayKey, host, expires,
      ]);
    }
    assert.throws(() => prepareP2ProfiledCertificationOperator(scoped('contain-native', selectedCommand)));

    const faultSettings = { ...settings, certification: { ...settings.certification, mode: 'fault-before-upstream',
      certificationActionId: 'owned-fault', requestEvidence: { kind: 'operator-recorded-request-details', path: join(original, 'owned-request.json') },
      fault: { stageId: 'owned-503', receiver: 'course', commandIndex: 0, commandSha256: '3'.repeat(64) } } };
    const fault = prepareP2ProfiledCertificationOperator(faultSettings);
    assert.equal(fault.mode, 'fault-before-upstream');
    assert.equal(fault.nativePlan.initialEpoch, '2');
    assert.deepEqual(fault.faultSelection, faultSettings.certification.fault);
    await assert.rejects(p2ProfiledCertificationOperator(faultSettings, { confirmation: 'staging/owned-fault' }), { code: 'ENOENT' });
    await assert.rejects(p2ProfiledCertificationOperator({ ...faultSettings, certification: { ...faultSettings.certification,
      mode: 'fault-drop-after-ack' } }, { confirmation: 'staging/owned-fault' }), /P2_CERTIFICATION_PARENT_REFUSED/);

    const knownInput = { version: 2, qualificationTargetProfile: profile, recoveryActionId: 'owned-known-replacement',
      configurationInputDirectory: '/var/lib/lash-her/releases/staging/owned-known-input',
      receiverTargets: Object.fromEntries(Object.entries(f.apiJobs).map(([service, job]) => {
        const { host, port, database, serverMajor } = job.target;
        return [service, { host, port, database, serverMajor, user: job.runtimeRole, roleOid: '102' }];
      })) };
    const knownSettings = { ...faultSettings, certification: { ...faultSettings.certification, mode: 'known-ack-recovery', knownAckRecovery: knownInput } };
    const known = prepareP2ProfiledCertificationOperator(knownSettings);
    assert.deepEqual(known.knownAckRecovery.qualificationTargetProfile, profile);
    assert.equal(known.knownAckRecovery.intentSha256, p2NativeHash(known.knownAckRecovery.intent));
    const select = 'import json,sys;sys.path.insert(0,sys.argv[1]);import p2_certification_parent as p;' +
      'p._profiled_known_ack_selection(json.load(sys.stdin),sys.argv[2],p._profiled_context())';
    const verifyKnown = value => spawnSync('python3', ['-B', '-c', select, join(root, 'ops/platform/host'), f.settings.host.configuration],
      { input: JSON.stringify(value), encoding: 'utf8' });
    assert.equal(verifyKnown(known).status, 0);
    const tampered = structuredClone(known);
    tampered.knownAckRecovery.intent.runtimeReplacements = 2;
    tampered.knownAckRecovery.intentSha256 = p2NativeHash(tampered.knownAckRecovery.intent);
    assert.match(verifyKnown(tampered).stderr, /P2_PROFILED_KNOWN_ACK_INTENT_CHANGED/);
    assert.throws(() => prepareP2ProfiledCertificationOperator({ ...knownSettings, certification: { ...knownSettings.certification,
      knownAckRecovery: { ...knownInput, receiverTargets: { ...knownInput.receiverTargets,
        course: { ...knownInput.receiverTargets.course, database: 'wrong' } } } } }));
    await assert.rejects(p2ProfiledCertificationOperator(knownSettings, { confirmation: 'staging/owned-fault' }), /P2_CERTIFICATION_PARENT_REFUSED/);

    const originalKnownDirectory = join(f.settings.results, known.certificationActionId);
    mkdirSync(originalKnownDirectory, { mode: 0o700 });
    const originalKnownPlanPath = join(originalKnownDirectory, 'p2-certification-started.json');
    write(originalKnownPlanPath, known);
    const selection = { version: 2, qualificationTargetProfile: profile, mode: PROFILED_MODE, restorationActionId: 'owned-c',
      originalCertificationActionId: known.certificationActionId, originalRecoveryActionId: knownInput.recoveryActionId,
      originalOperatorSourceCommit: plan.sourceCommit,
      causalReceiptSha256: Object.fromEntries([...CAUSAL_FILES, 'reconciliation-observed.json'].map(name => [name, '7'.repeat(64)])),
      replacementReceiptSha256: Object.fromEntries(REPLACEMENT_FILES.map(name => [name, name === REPLACEMENT_FILES[0] ? '8'.repeat(64) : null])),
      priorGatewayReference: { kind: 'stopped-current-candidate', stopReceiptDirectory: '/var/lib/lash-her/releases/staging/p2-profiled-known-ack-' + knownInput.recoveryActionId,
        stopReceiptSha256: '9'.repeat(64) } };
    const cSettings = { version: 2, qualificationTargetProfile: profile, environment: 'staging', operatorSourceCommit: plan.sourceCommit,
      releaseSettings: f.settings, interruptedRestoration: selection, receiverTargets: knownInput.receiverTargets,
      operationId: '10000000-0000-4000-8000-000000000001' };
    const cPlan = prepareProfiledInterruptedKnownAckOperator(cSettings).plan;
    assert.equal(cPlan.originalCertificationPlanBytesSha256, rawHash(readFileSync(originalKnownPlanPath)));
    assert.equal(cPlan.originalCertificationPlanSha256, known.planSha256);
    assert.equal(cPlan.configurationInputDirectory, knownInput.configurationInputDirectory);
    assert.equal(cPlan.frontendPlan.initialEpoch, '4');
    assert.equal(cPlan.frontendPlan.reconciliationSha256, selection.causalReceiptSha256['settlement.json']);
    const { planSha256: cFrontendSha, ...cFrontendBody } = cPlan.frontendPlan;
    assert.deepEqual(cFrontendBody.apiJobSha256, cPlan.apiJobSha256);
    assert.equal(cFrontendSha, p2NativeHash(cFrontendBody));
    assert.equal(cPlan.requestedFrontier, 'original-stopped-one');
    assert.equal(cPlan.liveExecutionEligible, false);
    const complete = Object.fromEntries(REPLACEMENT_FILES.map(name => [name, '8'.repeat(64)]));
    assert.throws(() => prepareProfiledInterruptedKnownAckOperator({ ...cSettings, interruptedRestoration: { ...selection,
      replacementReceiptSha256: { ...complete, 'known-ack-stage-4-observed.json': null } } }));
    const completed = prepareProfiledInterruptedKnownAckOperator({ ...cSettings, interruptedRestoration: { ...selection,
      replacementReceiptSha256: complete, priorGatewayReference: { ...selection.priorGatewayReference,
        stopReceiptDirectory: join(f.settings.host.results, 'p2-profiled-current-certification-' + known.certificationActionId) } } }).plan;
    assert.equal(completed.requestedFrontier, 'replacement-stopped-zero');

    const targets = Object.fromEntries(Object.entries({ frontend: migration.job, ...f.apiJobs }).map(([service, job]) => {
      const { host, port, database, serverMajor } = job.target;
      const target = { qualificationTargetProfile: profile, host, port, database, serverMajor,
        runtimeRole: service === 'frontend' ? job.target.runtimeRole : job.runtimeRole,
        runtimeRoleOid: service === 'frontend' ? inventory.producers[0].role.oid : '102' };
      return [service, { ...target, targetSha256: p2LifecyclePersistenceTargetSha256(service, target, profile) }];
    }));
    const persistencePlan = prepareP2LifecyclePersistencePlan({ version: 2, qualificationTargetProfile: profile,
      environment: 'staging', releaseId: plan.releaseId, hostMachineId: plan.hostMachineId,
      candidateSha256: plan.candidateSha256, configurationSha256: p2NativeHash(plan.configurationSha256),
      sources: Object.fromEntries(Object.entries(plan.sources).map(([service, source]) => [service, source.commit])), targets,
      containerImages: Object.fromEntries(['course', 'community'].map(service => [service, migration.candidate.artifacts[service + 'Runtime'].image])),
      operatorSourceSha256: settings.certification.operatorSourceClosureSha256,
      frontendDeploymentSha256: readyReceiptSha256['frontend-promotion-outcome.json'],
      originalReleaseSha256: rawHash(readFileSync(terminalPath)), expectedMigrations: { frontend: 83, course: 22, community: 11 } }, profile);
    const suspension = { version: 2, qualificationTargetProfile: profile, actionId: 'owned-browser', candidateSha256: plan.candidateSha256,
      persistencePlan, deployment: { deploymentId, deploymentUrl, configurationRecordSha256, featureControls: inventory.certification.featureControls,
        writerAdmissionBinding: plan.writerAdmissionBinding },
      target: { ...Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, migration.job.target[key]])),
        qualificationTargetProfile: profile },
      owner: inventory.owner, producer: inventory.producers[0],
      resources: { userId: '10000000-0000-4000-8000-000000000001', courseId: '10000000-0000-4000-8000-000000000002',
        lessonId: '10000000-0000-4000-8000-000000000003' },
      windowSeconds: 840, drainSeconds: 15, operatorSourceCommit: plan.sourceCommit };
    const browserSettings = { ...settings, browser: { input: suspension },
      authPreparation: { certificationActionId: 'owned-auth', initialEpoch: '1', startState: 'already-closed' },
      certification: { ...settings.certification, mode: 'browser-pending', certificationActionId: 'owned-browser', initialEpoch: '3',
        native: { ...settings.certification.native, commandWitnesses: [] } } };
    const browser = prepareP2ProfiledCertificationOperator(browserSettings);
    assert.equal(browser.authentication.maximumSeconds, 300);
    assert.equal(browser.browser.initialEpoch, '3');
    assert.equal(browser.browser.browserPlanSha256, browser.authentication.browserPlanSha256);
    assert.equal(browser.browser.nativePlan.commandWitnesses.length, 0);
    assert.ok(!JSON.stringify(browser).includes(suspension.resources.userId));
    assert.throws(() => prepareP2ProfiledCertificationOperator({ ...browserSettings,
      authPreparation: { ...browserSettings.authPreparation, initialEpoch: '2' } }));
    assert.throws(() => prepareP2ProfiledCertificationOperator({ ...browserSettings, browser: { input: { ...suspension,
      persistencePlan: { ...persistencePlan, originalReleaseSha256: '6'.repeat(64) } } } }));

    const worker = prepareP2ProfiledCertificationOperator({ ...settings, worker: { suspensionInput: suspension },
      certification: { ...settings.certification, mode: 'direct-worker', certificationActionId: 'owned-worker', initialEpoch: '5',
        worker: { input: { version: 2, qualificationTargetProfile: profile, actionId: 'owned-worker', commandIndex: 0,
          pendingRecordSha256: '1'.repeat(64), canonicalCommandSha256: '2'.repeat(64),
          gatewayProcessSha256: settings.certification.gatewayProcessSha256, gatewayConfigurationSha256: settings.certification.gatewayConfigurationSha256,
          denialProgramSha256: '3'.repeat(64) } } } });
    assert.equal(worker.workerPlan.suspensionPlanSha256, browser.browser.browserPlanSha256);
    assert.equal(worker.workerPlan.nativeInvocationQualified, false);
    assert.equal(worker.nativePlan.initialEpoch, '6');
    await assert.rejects(runP2BoundedCertification(worker, {}), /P2_CERTIFICATION_PARENT_REFUSED/);

    assert.throws(() => prepareP2ProfiledCertificationOperator({ ...settings, certification: { ...settings.certification, startState: 'qualified-ready' } }));
    write(terminalPath, { ...terminal, frontendWorkloadReceiptSha256: '5'.repeat(64) });
    assert.throws(() => prepareP2ProfiledCertificationOperator(settings));
    write(terminalPath, terminal);
    const promotionName = 'frontend-promotion-outcome.json';
    const promotionPath = join(vercel, promotionName);
    write(promotionPath, { ...records[promotionName], previousAliasRequestedAt: 3 });
    readyReceiptSha256[promotionName] = rawHash(readFileSync(promotionPath));
    assert.throws(() => prepareP2ProfiledCertificationOperator(settings));
  } finally { f.dispose(); }
});
