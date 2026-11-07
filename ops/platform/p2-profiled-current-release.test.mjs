import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
