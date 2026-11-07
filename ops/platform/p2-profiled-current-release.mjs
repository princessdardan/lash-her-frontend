#!/usr/bin/env node
// Fixed existing-staging current-only action. No FE SQL, role preparation or admission opening.
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { prepareFrontendMigration, runFrontendMigration, writeFrontendReceipt } from './frontend-migration.mjs';
import { frontendWriterInventory } from './frontend-writer-inventory.mjs';
import { prepareFrontendReleaseInventory } from './frontend-release-inventory.mjs';
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from './frontend-release-receipts.mjs';
import { assertSourceCheckout } from './source-checkout.mjs';
import { validatePlatformRelease } from './release.mjs';
import { validateP2HostSettings, validateP2PriorGatewayReference } from './p2-release.mjs';
import { prepareP2CertificationProfile, P2_CERTIFICATION_RUNTIME_FLAGS } from './p2-certification-profile.mjs';
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from './recreation_source.mjs';
import { githubSourceApi } from './release-inputs.mjs';
import { recreationSsh } from './recreation_ssh.mjs';
import { createP2ProfiledCurrentProbe } from './p2-profiled-current-probe.mjs';
import { p2ProfiledCurrentEnvironmentLock, readP2ProfiledCurrentFrontendReceipt, retainP2ProfiledCurrentRaw } from './p2-profiled-current-transport.mjs';
import { deployProfiledCurrentFrontend, observeProfiledCurrentFrontend, readProfiledCurrentWorkloadReceipt } from './p2-profiled-current-frontend-adapters.mjs';
import { decodeQualificationTargetJson, requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from './qualification-target-profile.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const profile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;
const demand = ok => { if (!ok) throw new Error('P2_PROFILED_CURRENT_RELEASE_REFUSED'); };
const hash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const immutable = value => { if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };
const falseFlags = Object.freeze({ frontendSqlApplied: false, historicalProviderClosureClaimed: false, oldP200Qualified: false,
  nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false });
const services = ['course-api', 'course-publisher', 'course-snapshot', 'community-api', 'community-worker', 'course-media', 'course-export-cleanup'];
export const P2_PROFILED_CURRENT_CONFIGURATION_FILES = Object.freeze(['runtime.json', 'gateway.json', 'course-tls.json', 'community-tls.json',
  'tls/ca.pem', 'tls/gateway/ca.pem', 'tls/gateway/key.pem', 'tls/gateway/cert.pem', 'tls/course/key.pem', 'tls/course/cert.pem',
  'tls/community/key.pem', 'tls/community/cert.pem', ...services.map(service => service + '.env')]);
const preparations = new WeakMap();
const sourceCustody = new WeakMap();

function bytes(path, privateFile = true) {
  demand(typeof path === 'string' && resolve(path) === path && realpathSync(path) === path);
  if (privateFile) frontendPrivateReceiptDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    demand(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 2_000_000 &&
      (!privateFile || before.uid === process.getuid() && (before.mode & 0o077) === 0));
    const raw = Buffer.alloc(before.size); let offset = 0;
    while (offset < raw.length) { const count = readSync(fd, raw, offset, raw.length - offset, null); demand(count > 0); offset += count; }
    demand(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0);
    const after = fstatSync(fd);
    demand(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]));
    return raw;
  } finally { closeSync(fd); }
}
const object = path => decodeQualificationTargetJson(bytes(path), 'carrier');
function configurationMap(value) {
  demand(value && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...P2_PROFILED_CURRENT_CONFIGURATION_FILES].sort()) &&
    Object.values(value).every(sha => typeof sha === 'string' && /^[a-f0-9]{64}$/u.test(sha) && !/^0+$/u.test(sha)));
  return Object.fromEntries(P2_PROFILED_CURRENT_CONFIGURATION_FILES.map(name => [name, value[name]]));
}

export function prepareP2ProfiledCurrentRelease(settings) {
  demand(resolveQualificationTargetProfile(profile).kind === 'existing-staging');
  requireQualificationTargetProfile(profile, settings);
  demand(settings.version === 2 && settings.environment === 'staging' && /^[a-f0-9]{40}$/u.test(settings.sourceCommit ?? '') &&
    settings.rolePreparation === undefined && settings.rolesReuseDirectory === undefined);
  const allowed = ['version', 'qualificationTargetProfile', 'environment', 'sourceCommit', 'bundle', 'configuration', 'configurationSha256',
    'inventory', 'host', 'results', 'providerContext', 'knownHosts', 'sshKey', ...(settings.priorGatewayReference === undefined ? [] : ['priorGatewayReference'])];
  demand(isDeepStrictEqual(Object.keys(settings).sort(), allowed.sort()));
  const configurationSha256 = configurationMap(settings.configurationSha256);
  validateP2HostSettings(settings.host);
  for (const key of ['bundle', 'configuration', 'inventory', 'results', 'providerContext', 'knownHosts', 'sshKey']) demand(typeof settings[key] === 'string' && resolve(settings[key]) === settings[key]);
  frontendPrivateReceiptDirectory(settings.bundle); frontendPrivateReceiptDirectory(settings.configuration);
  const candidateRaw = bytes(join(settings.bundle, 'release.candidate.json'));
  const candidate = decodeQualificationTargetJson(candidateRaw, 'carrier');
  requireQualificationTargetProfile(profile, candidate, candidate?.frontendMigration);
  demand(candidate.version === 3 && candidate.environment === 'staging' && candidate.contractPhase === 'p2' && candidate.sourceGraph === undefined &&
    validatePlatformRelease(candidate, new Date(), profile).length === 0);
  const job = object(join(settings.bundle, 'jobs/frontend.json')), baseline = object(join(settings.bundle, 'schema/frontend.json'));
  requireQualificationTargetProfile(profile, job, job?.target);
  demand(job.version === 2 && job.sourceCommit === settings.sourceCommit && job.target.allowEmptyBootstrap === false &&
    Array.isArray(job.target.approvedPendingTags) && job.target.approvedPendingTags.length === 0);
  const migration = prepareFrontendMigration(candidate, job, baseline, undefined, profile);
  const apiJobSha256 = {};
  const apiJobs = Object.fromEntries(['course', 'community'].map(name => {
    const raw = bytes(join(settings.bundle, 'jobs', name + '.json')), api = decodeQualificationTargetJson(raw, 'carrier');
    requireQualificationTargetProfile(profile, api, api?.target);
    demand(api.schemaVersion === 2 && api.target.schemaVersion === 2 && api.kind === 'operator-migration' &&
      api.operator === 'Dardan' && api.environment === 'staging' && api.target.environment === 'staging' &&
      api.target.service === `lash-her-${name}-api` && api.releaseId === candidate.releaseId &&
      api.sourceCommit === candidate.sources[name].commit && api.contractPhase === 'p2' && api.phase2ContractManifestSha256 === candidate.phase2ContractManifestSha256 &&
      api.contractSha256 === candidate.contractManifestSha256.slice(7) &&
      api.migrationImageDigest === candidate.artifacts[name + 'Migration'].image.split('@')[1] &&
      api.runtimeImageDigest === candidate.artifacts[name + 'Runtime'].image.split('@')[1] &&
      typeof api.runtimeRole === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(api.runtimeRole) && api.runtimeRole !== api.target.user);
    apiJobSha256[name] = hash(raw); return [name, api];
  }));
  const inventory = object(settings.inventory);
  requireQualificationTargetProfile(profile, inventory);
  demand(inventory.version === 2 && inventory.admissionMode === 'existing' && inventory.restoration?.newWork === false &&
    inventory.restoration.recovery === false && inventory.restoration.nativeSchedulesEnabled === false);
  const reviewedInventory = prepareFrontendReleaseInventory(inventory, migration, frontendWriterInventory(root), profile);
  demand(isDeepStrictEqual(reviewedInventory.certification, prepareP2CertificationProfile(reviewedInventory.certification)));
  const producer = reviewedInventory.runtimeProducerSha256;
  demand(/^[a-f0-9]{64}$/u.test(producer ?? '') && reviewedInventory.producers.some(row => row.producerSha256 === producer && row.role.name === job.target.runtimeRole));
  // Only metadata is read in plan. Secret-bearing configuration bytes are checked in apply.
  const runtimeRaw = bytes(join(settings.configuration, 'runtime.json')), runtime = decodeQualificationTargetJson(runtimeRaw, 'carrier');
  requireQualificationTargetProfile(profile, runtime);
  demand(runtime.version === 2 && runtime.releaseId === candidate.releaseId && runtime.environment === 'staging' &&
    runtime.hostMachineId === settings.host.machineId && hash(runtimeRaw) === configurationSha256['runtime.json'] &&
    isDeepStrictEqual(Object.keys(runtime).sort(), ['environment', 'hostMachineId', 'maintenanceRef', 'previousReleaseRef',
      'qualificationTargetProfile', 'releaseId', 'version']) && ['maintenanceRef', 'previousReleaseRef'].every(key => /^[A-Za-z0-9_./:-]{1,200}$/u.test(runtime[key] ?? '')));
  const priorGatewayReference = validateP2PriorGatewayReference(settings.priorGatewayReference);
  const plan = immutable({ version: 2, qualificationTargetProfile: profile, environment: 'staging',
    operation: 'profiled-current-api-runtime-and-compatible-frontend', releaseId: candidate.releaseId,
    sourceCommit: settings.sourceCommit, sources: candidate.sources, candidateSha256: hash(candidateRaw),
    contractPhase: 'p2', phase2ContractManifestSha256: candidate.phase2ContractManifestSha256,
    hostMachineId: settings.host.machineId, frontendTarget: job.target, targetSha256: reviewedInventory.targetSha256,
    inventorySha256: hash(reviewedInventory), configurationSha256, apiJobSha256, certification: reviewedInventory.certification,
    writerAdmissionBinding: { mode: 'enforce', targetSha256: reviewedInventory.targetSha256, producerSha256: producer,
      sourceCommit: settings.sourceCommit, roleName: job.target.runtimeRole },
    ...(priorGatewayReference ? { priorGatewayReference } : {}),
    configurationObserved: false, currentDatabaseObserved: false, ...falseFlags });
  const prepared = immutable({ qualificationTargetProfile: profile, migration, apiJobs, inventory: reviewedInventory, plan });
  preparations.set(prepared, { settings: structuredClone(settings) });
  return prepared;
}

function verifyConfiguration(prepared, settings) {
  const expected = prepared.plan.configurationSha256;
  const actual = Object.fromEntries(P2_PROFILED_CURRENT_CONFIGURATION_FILES.map(name => [name, bytes(join(settings.configuration, name))]));
  demand(Object.keys(actual).every(name => hash(actual[name]) === expected[name]));
  const gateway = decodeQualificationTargetJson(actual['gateway.json'], 'carrier');
  demand(isDeepStrictEqual(gateway.admission, { file: '/admission/state.json', releaseId: prepared.plan.releaseId,
    candidateSha256: prepared.plan.candidateSha256 }) && gateway.maintenance === true);
  for (const service of services) {
    const values = new Map();
    for (const line of actual[service + '.env'].toString('utf8').split('\n').filter(line => line && !line.startsWith('#'))) {
      const index = line.indexOf('='); demand(index > 0 && !values.has(line.slice(0, index))); values.set(line.slice(0, index), line.slice(index + 1));
    }
    demand(Object.entries(P2_CERTIFICATION_RUNTIME_FLAGS[service] ?? {}).every(([key, value]) => values.get(key) === value));
    const api = prepared.apiJobs[service.startsWith('course-') ? 'course' : 'community'];
    let url; try { url = new URL(values.get('STAGING_DATABASE_URL')); } catch { demand(false); }
    demand(values.get('DATABASE_TARGET') === 'staging' && (values.get('NODE_ENV') ?? 'production') === 'production' &&
      ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === api.target.host && Number(url.port || 5432) === (api.target.port ?? 5432) &&
      decodeURIComponent(url.pathname) === '/' + api.target.database && decodeURIComponent(url.username) === api.runtimeRole && url.password && !url.hash &&
      isDeepStrictEqual([...url.searchParams], [['sslmode', 'verify-full']]));
  }
}

export function verifyP2ProfiledCurrentReleaseConfiguration(prepared) {
  const original = preparations.get(prepared);
  demand(original);
  verifyConfiguration(prepared, original.settings);
}

export async function verifyP2ProfiledCurrentWriterBoundary(client, migration, inventory, verify) {
  demand(/^[a-z][a-z0-9_]{0,62}$/u.test(inventory?.owner?.name ?? ""));
  await verify(); await client.query('BEGIN READ ONLY');
  try {
    const retired = inventory.historicalLogins.retiredLogins;
    const roles = (await client.query('SELECT oid::text,rolname,rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [retired.map(row => row.name)])).rows;
    demand(roles.length === retired.length && roles.every(row => row.rolcanlogin === false && retired.some(expected => expected.name === row.rolname && expected.oid === row.oid)));
    await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
    demand((await client.query('SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE usesysid=ANY($1::oid[])', [retired.map(row => row.oid)])).rows[0]?.count === 0);
    await client.query(`SET LOCAL ROLE "${inventory.owner.name}"`);
    const controls = (await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
    demand(controls.length === 1 && controls[0].environment === 'staging' && controls[0].target_sha256 === inventory.targetSha256 &&
      controls[0].epoch === inventory.expectedEpoch && controls[0].new_work === false && controls[0].recovery === false);
    const counts = (await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
    demand(counts?.active === 0 && counts.uncertain === 0);
    const producers = (await client.query('SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256')).rows;
    demand(producers.length === inventory.producers.length && producers.every((row, index) => row.source_sha === migration.job.sourceCommit &&
      row.producer_sha256 === inventory.producers[index].producerSha256 && row.role_oid === inventory.producers[index].role.oid));
    return { epoch: controls[0].epoch, newWork: false, recovery: false, active: counts.active, uncertain: counts.uncertain, ledgerDrained: true };
  } finally { await client.query('ROLLBACK'); await verify(); }
}

function deploymentProof(prepared, result) {
  const { plan, inventory } = prepared;
  requireQualificationTargetProfile(profile, result);
  demand(result.version === 2 && result.status === 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED' && result.environment === 'staging' && result.releaseId === plan.releaseId &&
    result.actionId === plan.releaseId && result.sourceCommit === plan.sourceCommit && result.targetSha256 === plan.targetSha256 &&
    result.candidateSha256 === plan.candidateSha256 && isDeepStrictEqual(result.configurationSha256, plan.configurationSha256) &&
    result.contractPhase === 'p2' && result.phase2ContractManifestSha256 === plan.phase2ContractManifestSha256 &&
    result.projectId === prepared.migration.candidate.workload.projectId && /^dpl_[A-Za-z0-9]+$/u.test(result.deploymentId ?? '') &&
    result.readyState === 'READY' && result.aliasJobState === 'succeeded' && result.aliasDeploymentId === result.deploymentId &&
    result.aliasJobDeploymentId === result.deploymentId && result.aliasJobMatchesIntent === true && result.aliasJobType === 'promote' &&
    result.nativeSchedulesEnabled === false && result.admissionNewWork === false && result.admissionRecovery === false && result.workloadVerified === true &&
    isDeepStrictEqual(result.featureControls, inventory.certification.featureControls) && isDeepStrictEqual(result.writerAdmissionBinding, plan.writerAdmissionBinding) &&
    result.configurationRecordSha256 === result.workloadReceiptSha256 && /^[a-f0-9]{64}$/u.test(result.workloadReceiptSha256 ?? '') &&
    result.certificationSchedule?.path === '/api/cron/account-lifecycle' && result.certificationSchedule.schedule === '* * * * *' &&
    result.certificationSchedule.nativeEnabled === false && result.certificationSchedule.deploymentId === result.deploymentId &&
    /^[a-f0-9]{64}$/u.test(result.certificationSchedule.definitionsSha256 ?? '') &&
    Buffer.isBuffer(result.evidence) && result.evidence.length > 0 && result.evidence.length <= 2_000_000 && hash(result.evidence) === result.evidenceSha256);
  const evidence = decodeQualificationTargetJson(result.evidence, 'carrier');
  const safe = Object.fromEntries(Object.entries(result).filter(([key]) => !['evidence', 'evidenceSha256'].includes(key)));
  demand(isDeepStrictEqual(evidence, safe));
  return { ...safe, evidenceSha256: result.evidenceSha256 };
}

async function runProfiledCurrentContinuation(prepared, deps) {
  const original = preparations.get(prepared); demand(original);
  const fresh = prepareP2ProfiledCurrentRelease(original.settings);
  demand(isDeepStrictEqual(fresh, prepared) && deps?.confirmation === `staging/${prepared.plan.releaseId}` &&
    typeof deps.getUrl === 'function' && typeof deps.getProviderContext === 'function' && typeof deps.withEnvironmentLock === 'function');
  verifyConfiguration(prepared, original.settings);
  const { migration, plan, inventory } = prepared, store = frontendReleaseReceiptStore(deps.directory);
  const source = assertSourceCheckout;
  const base = { version: 2, qualificationTargetProfile: profile, environment: 'staging', releaseId: plan.releaseId,
    sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256, configurationSha256: plan.configurationSha256,
    contractPhase: 'p2', phase2ContractManifestSha256: plan.phase2ContractManifestSha256, targetSha256: plan.targetSha256,
    inventorySha256: plan.inventorySha256, ...falseFlags };
  let phase = 'environment-lock';
  try {
    await store.record('p2-profiled-current-release-started.json', { ...base, status: 'P2_PROFILED_CURRENT_RELEASE_STARTED' });
    return await deps.withEnvironmentLock(async (verifyEnvironment, signal, host) => {
      demand(['armCurrent', 'preparePriorGateway', 'frontendVerified', 'prepareClose', 'frontendSessionClosed', 'finish'].every(key => typeof host?.[key] === 'function'));
      const guard = async () => { demand(!signal.aborted); source(root, plan.sourceCommit); verifyConfiguration(prepared, original.settings); await verifyEnvironment(); };
      let client, outcome;
      const abort = () => { try { client?.connection?.stream?.destroy(); } catch { /* host guard retains uncertainty */ } };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await guard();
        await runFrontendMigration(migration, { confirmation: deps.confirmation, getUrl: deps.getUrl, record: store.record, assertSource: source,
          createClient(options) { demand(!signal.aborted); client = new Client(options); return client; },
          async beforeDatabasePreflight() { await guard(); },
          async afterDatabaseVerified(database, verifySession) {
            const verify = async () => { await guard(); await verifySession(); };
            await verify(); phase = 'current-physical-arm';
            const probe = await createP2ProfiledCurrentProbe(migration, inventory, client, verify, database);
            await verifyP2ProfiledCurrentWriterBoundary(client, migration, inventory, verify);
            const receipt = readP2ProfiledCurrentFrontendReceipt(deps.directory, 'database', migration);
            const started = readP2ProfiledCurrentFrontendReceipt(deps.directory, 'continuation-started', migration);
            const { apiReady } = await host.armCurrent({ receipt: receipt.bytes, continuationStarted: started.bytes, probe });
            phase = 'prior-gateway-and-api-runtime';
            await host.preparePriorGateway(); await apiReady; await verify();
            const admission = await verifyP2ProfiledCurrentWriterBoundary(client, migration, inventory, verify);
            const context = { qualificationTargetProfile: profile, plan: inventory, inventorySha256: plan.inventorySha256,
              candidate: migration.candidate, candidateSha256: plan.candidateSha256, job: migration.job,
              configurationSha256: plan.configurationSha256, directory: deps.directory, getProviderContext: deps.getProviderContext,
              verifyLockedSession: verify, environmentSignal: signal, databaseClient: client,
              bootstrapRuntimeTarget: { qualificationTargetProfile: profile, environment: 'staging', targetSha256: plan.targetSha256,
                ...Object.fromEntries(['host', 'port', 'database', 'serverMajor'].map(key => [key, migration.job.target[key]])), user: migration.job.target.runtimeRole },
              admissionObservation: admission };
            phase = 'compatible-frontend-build-probe-promotion';
            await deployProfiledCurrentFrontend(context); await verify();
            const actual = await observeProfiledCurrentFrontend(context), proof = deploymentProof(prepared, actual);
            await verify(); const workload = await readProfiledCurrentWorkloadReceipt(context, actual);
            demand(Buffer.isBuffer(workload) && hash(workload) === proof.workloadReceiptSha256);
            await host.frontendVerified(proof, workload); await verifyP2ProfiledCurrentWriterBoundary(client, migration, inventory, verify);
            outcome = { ...base, status: 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED', deploymentProofSha256: hash(proof) };
            await store.record('p2-profiled-current-release-outcome.json', outcome);
            phase = 'late-terminal-close'; await verify(); await host.prepareClose();
          },
        }, profile);
      } finally { signal.removeEventListener('abort', abort); }
      // These files can only exist successfully after the actual runner's final
      // schema/lineage/grants verification, unlock and disconnect.
      const terminal = readP2ProfiledCurrentFrontendReceipt(deps.directory, 'terminal', migration);
      const continuation = readP2ProfiledCurrentFrontendReceipt(deps.directory, 'continuation-completed', migration);
      await host.frontendSessionClosed();
      await host.finish({ terminal: terminal.bytes, continuationCompleted: continuation.bytes,
        releaseOutcome: readFrontendReleaseEvidence(deps.directory, 'p2-profiled-current-release-outcome.json') });
      return outcome;
    });
  } catch {
    try { await store.record('p2-profiled-current-failure.json', { ...base, status: 'FAILED_REQUIRES_REVIEW', phase }); } catch { /* preserve exclusive original evidence */ }
    throw new Error('P2_PROFILED_CURRENT_RELEASE_FAILED_REQUIRES_REVIEW');
  }
}

export async function openP2ProfiledCurrentSource(prepared, { actionId, confirmation }) {
  demand(process.versions.node.split('.')[0] === '24');
  const original = preparations.get(prepared); demand(original);
  const settings = original.settings;
  const fresh = prepareP2ProfiledCurrentRelease(settings);
  demand(isDeepStrictEqual(fresh, prepared) && typeof actionId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(actionId) &&
    confirmation === `staging/${actionId}`);
  verifyConfiguration(prepared, settings);
  demand(hash(bytes(join(root, 'ops/platform/p2-profiled-current-frontend-adapters.mjs'), false)) === prepared.inventory.adaptersSha256);
  const committed = committedProfiledCurrentOperatorSource(root, settings.sourceCommit);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN), sourceCommit: settings.sourceCommit,
    branch: committed.branch, workflowBytes: committed.workflowBytes });
  frontendPrivateReceiptDirectory(settings.results);
  const directory = join(settings.results, actionId); mkdirSync(directory, { mode: 0o700 });
  const frontend = join(directory, 'frontend'); mkdirSync(frontend, { mode: 0o700 });
  const diagnostics = join(directory, 'ssh'); mkdirSync(diagnostics, { mode: 0o700 });
  writeFrontendReceipt(directory, 'reviewed-plan.json', prepared.plan); writeFrontendReceipt(directory, 'exact-source-ci.json', ci);
  const originalCandidate = bytes(join(settings.bundle, 'release.candidate.json'));
  demand(hash(originalCandidate) === prepared.plan.candidateSha256);
  retainP2ProfiledCurrentRaw(directory, 'release.candidate.json', originalCandidate);
  const context = object(settings.providerContext);
  requireQualificationTargetProfile(profile, context);
  demand(context.version === 2 && isDeepStrictEqual(Object.keys(context).sort(), ['version', 'qualificationTargetProfile', 'vercelToken', 'bindings',
    ...(Object.hasOwn(context, 'frontendRuntimeDatabaseUrl') ? ['frontendRuntimeDatabaseUrl'] : [])].sort()));
  const credentials = Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL', 'COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL'].map(key => {
    const value = process.env[key]; demand(typeof value === 'string' && value.length > 0 && value.length <= 16_384); return [key, value];
  }));
  demand(typeof context.vercelToken === 'string' && context.vercelToken.length > 0 &&
    hash(context.bindings?.gatewayObservation) === prepared.inventory.restoration.gatewayBindingSha256);
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics });
  demand((await ssh.machine()).machineId === settings.host.machineId);
  const installed = await ssh.installProfiledCurrentSource({ commit: settings.sourceCommit, files: committed.files });
  demand(installed.status === 'EXACT_OPERATOR_SOURCE_INSTALLED' && installed.commit === settings.sourceCommit);
  const initialBase = { version: 2, qualificationTargetProfile: profile, environment: 'staging', sourceCommit: settings.sourceCommit,
    sourceSha256: Object.fromEntries(committed.files.map(file => [file.path, file.sha256])),
    sourceClosureSha256: hash(committed.files.map(file => [file.path, file.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    hostMachineId: settings.host.machineId, candidate: prepared.migration.candidate, candidateSha256: prepared.plan.candidateSha256,
    bundle: settings.host.bundle, configuration: settings.host.configuration, results: settings.host.results,
    configurationSha256: prepared.plan.configurationSha256, apiJobSha256: prepared.plan.apiJobSha256, confirmation, credentials, vercelToken: context.vercelToken,
    frontendJob: prepared.migration.job, frontendBaseline: prepared.migration.baseline, targetSha256: prepared.plan.targetSha256,
    owner: prepared.inventory.owner, certification: prepared.plan.certification, expectedWriterAdmissionBinding: prepared.plan.writerAdmissionBinding,
    inventory: prepared.inventory, inventorySha256: prepared.plan.inventorySha256,
    gatewayObservation: context.bindings.gatewayObservation, ...(prepared.plan.priorGatewayReference ? { priorGatewayReference: prepared.plan.priorGatewayReference } : {}) };
  const handle = Object.freeze({});
  sourceCustody.set(handle, { prepared, actionId, value: Object.freeze({ directory, frontendDirectory: frontend,
    context: immutable(context), credentials: Object.freeze(credentials), initialBase: immutable(initialBase),
    assertSource: () => assertSourceCheckout(root, settings.sourceCommit) }) });
  return handle;
}

export function readP2ProfiledCurrentSource(handle, prepared, actionId) {
  const record = sourceCustody.get(handle);
  demand(record && record.prepared === prepared && record.actionId === actionId && preparations.has(prepared));
  record.value.assertSource();
  return record.value;
}

export async function runP2ProfiledCurrentRelease(prepared, dependencies) {
  const original = preparations.get(prepared); demand(original && dependencies &&
    isDeepStrictEqual(Object.keys(dependencies).sort(), ['confirmation', 'source']) &&
    dependencies.confirmation === `staging/${prepared.plan.releaseId}`);
  const custody = readP2ProfiledCurrentSource(dependencies.source, prepared, prepared.plan.releaseId);
  demand(typeof custody.context.frontendRuntimeDatabaseUrl === 'string' && custody.context.frontendRuntimeDatabaseUrl.length > 0);
  const initial = { ...custody.initialBase, mode: 'p2-profiled-current-release', reviewedPlanSha256: hash(prepared.plan) };
  return runProfiledCurrentContinuation(prepared, { confirmation: dependencies.confirmation, directory: custody.frontendDirectory,
    getUrl: () => custody.credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL, getProviderContext: async () => custody.context,
    withEnvironmentLock: p2ProfiledCurrentEnvironmentLock(original.settings, initial, custody.frontendDirectory) });
}

export async function p2ProfiledCurrentReleaseOperator(settings, { apply = false, confirmation } = {}) {
  demand(process.versions.node.split('.')[0] === '24');
  const prepared = prepareP2ProfiledCurrentRelease(settings);
  if (!apply) return prepared.plan;
  const handle = await openP2ProfiledCurrentSource(prepared, { actionId: prepared.plan.releaseId, confirmation });
  return runP2ProfiledCurrentRelease(prepared, { source: handle, confirmation });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    resolveQualificationTargetProfile(profile);
    const args = process.argv.slice(2), apply = args[0] === '--apply';
    demand(args.length === (apply ? 5 : 3) && ['--apply', '--plan'].includes(args[0]) && args[1] === '--settings' &&
      (!apply || args[3] === '--confirm'));
    const settings = object(resolve(args[2]));
    console.log(JSON.stringify(await p2ProfiledCurrentReleaseOperator(settings, { apply, confirmation: args[4] })));
  } catch { console.error('P2_PROFILED_CURRENT_RELEASE_REFUSED'); process.exitCode = 1; }
}
