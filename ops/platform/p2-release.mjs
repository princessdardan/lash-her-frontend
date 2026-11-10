#!/usr/bin/env node
// Plan-default P2 operator entry point. Private credentials remain in the
// runtime process/SSH stdin; no dotenv loading, migrations or network in plan.
import { readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { prepareFrontendReleaseCoordination, runFrontendReleaseCoordination } from './frontend-release-coordinator.mjs';
import { frontendPrivateReceiptDirectory } from './frontend-release-receipts.mjs';
import { committedOperatorSource, verifyOperatorCi } from './recreation_source.mjs';
import { githubSourceApi } from './release-inputs.mjs';
import { recreationSsh } from './recreation_ssh.mjs';
import { p2HostEnvironmentLock } from './p2-release-transport.mjs';
import { prepareP2CertificationProfile, P2_CERTIFICATION_RUNTIME_FLAGS } from './p2-certification-profile.mjs';
import { Client } from 'pg';
import { prepareFrontendMigration, frontendConnectionOptions, FRONTEND_MIGRATION_LOCK, writeFrontendReceipt } from './frontend-migration.mjs';
import { frontendWriterInventory } from './frontend-writer-inventory.mjs';
import { prepareFrontendReleaseRoleTemplate } from './frontend-release-inventory.mjs';
import { prepareFrontendRolesPlan, applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES } from './frontend-role-preparation.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = ok => { if (!ok) throw new Error('P2_OPERATOR_RELEASE_REFUSED'); };
const sha256 = raw => createHash('sha256').update(raw).digest('hex');
function bytes(path, privateFile = false) {
  require(resolve(path) === path && realpathSync(path) === path);
  const info = lstatSync(path);
  require(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2_000_000);
  if (privateFile) {
    frontendPrivateReceiptDirectory(dirname(path));
    require(info.uid === process.getuid() && (info.mode & 0o077) === 0);
  }
  return readFileSync(path);
}
function object(path, privateFile = false) {
  const value = JSON.parse(bytes(path, privateFile)); require(value && typeof value === 'object' && !Array.isArray(value)); return value;
}
export function validateP2HostSettings(host) {
  require(host?.machineId && /^[a-f0-9]{32}$/u.test(host.machineId) && !/^0+$/u.test(host.machineId) &&
    isDeepStrictEqual(Object.keys(host).sort(), ['bundle', 'configuration', 'machineId', 'results']) &&
    ['bundle', 'configuration', 'results'].every(key => /^\/var\/lib\/lash-her\/releases\/staging\/[A-Za-z0-9_/.-]+$/u.test(host[key] ?? '') &&
      !host[key].split('/').some(part => part === '.' || part === '..') && !host[key].includes('//')));
  return { machineId: host.machineId, bundle: host.bundle, configuration: host.configuration, results: host.results };
}
export function validateP2PriorGatewayReference(reference) {
  if (reference === undefined) return undefined;
  require(reference && typeof reference === 'object' && !Array.isArray(reference));
  const fields = reference.kind === 'retained-runtime'
    ? ['kind', 'candidateDirectory', 'configurationDirectory', 'runtimeReceiptDirectory', 'candidateSha256', 'runtimeReceiptSha256',
      ...(Object.hasOwn(reference, 'stopReceiptDirectory') || Object.hasOwn(reference, 'stopReceiptSha256') ? ['stopReceiptDirectory', 'stopReceiptSha256'] : [])]
    : reference.kind === 'stopped-current-candidate' ? ['kind', 'stopReceiptDirectory', 'stopReceiptSha256'] : [];
  require(fields.length > 0 && isDeepStrictEqual(Object.keys(reference).sort(), fields.sort()));
  for (const [key, value] of Object.entries(reference)) {
    if (key.endsWith('Directory')) require(typeof value === 'string' && value.length <= 4096 &&
      /^\/var\/lib\/lash-her\/releases\/staging\/[A-Za-z0-9_/.-]+$/u.test(value) &&
      !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..'));
    if (key.endsWith('Sha256')) require(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value));
  }
  // References select retained source evidence; the host observes the actual
  // latest process and counters. No caller-provided zero/drain assertion exists.
  return structuredClone(reference);
}
export function prepareP2OperatorRelease(settings) {
  require(settings?.version === 1 && settings.environment === 'staging' && /^[a-f0-9]{40}$/u.test(settings.sourceCommit));
  const bundle = settings.bundle;
  frontendPrivateReceiptDirectory(bundle);
  const candidate = object(join(bundle, 'release.candidate.json'), true);
  const job = object(join(bundle, 'jobs/frontend.json'));
  const baseline = object(join(bundle, 'schema/frontend.json'));
  const inventory = object(settings.inventory, true);
  const roles = settings.rolePreparation === undefined ? undefined : prepareFrontendRolesPlan(candidate, job, settings.rolePreparation);
  const prepared = roles ? undefined : prepareFrontendReleaseCoordination(candidate, job, baseline, inventory);
  const reviewedInventory = roles ? prepareFrontendReleaseRoleTemplate(inventory, prepareFrontendMigration(candidate, job, baseline), frontendWriterInventory(root)) : prepared.plan;
  if (roles) require(reviewedInventory.admissionMode === 'bootstrap' && reviewedInventory.owner.name === FRONTEND_PREPARATION_ROLES.owner &&
    reviewedInventory.producers.every(producer => producer.role.name === FRONTEND_PREPARATION_ROLES.runtime) &&
    isDeepStrictEqual(reviewedInventory.producers.map(producer => producer.producerSha256).sort(), roles.producerSha256));
  require(candidate.contractPhase === 'p2' && settings.sourceCommit === reviewedInventory.sourceCommit &&
    reviewedInventory.restoration?.newWork === true && reviewedInventory.restoration.recovery === true &&
    isDeepStrictEqual(reviewedInventory.certification, prepareP2CertificationProfile(reviewedInventory.certification)));
  const runtimeProducer = reviewedInventory.runtimeProducerSha256 ?? reviewedInventory.bootstrapCompatibility?.runtimeProducerSha256;
  require(/^[a-f0-9]{64}$/u.test(runtimeProducer ?? '') && reviewedInventory.producers.some(producer => producer.producerSha256 === runtimeProducer && producer.role.name === job.target.runtimeRole));
  const writerAdmissionBinding = { mode: 'enforce', targetSha256: reviewedInventory.targetSha256,
    producerSha256: runtimeProducer, sourceCommit: job.sourceCommit, roleName: job.target.runtimeRole };
  validateP2HostSettings(settings.host);
  const priorGatewayReference = validateP2PriorGatewayReference(settings.priorGatewayReference);
  const configuration = settings.configuration;
  frontendPrivateReceiptDirectory(configuration);
  const runtime = object(join(configuration, 'runtime.json'), true);
  require(runtime.hostMachineId === settings.host.machineId && runtime.releaseId === candidate.releaseId && runtime.environment === 'staging');
  const services = ['course-api', 'course-publisher', 'course-snapshot', 'community-api', 'community-worker', 'course-media', 'course-export-cleanup'];
  const names = ['runtime.json', 'gateway.json', 'course-tls.json', 'community-tls.json', 'tls/ca.pem', 'tls/gateway/ca.pem',
    'tls/gateway/key.pem', 'tls/gateway/cert.pem', 'tls/course/key.pem', 'tls/course/cert.pem', 'tls/community/key.pem', 'tls/community/cert.pem',
    ...services.map(service => service + '.env')];
  const configurationSha256 = Object.fromEntries(names.map(name => [name, sha256(bytes(join(configuration, name)))]));
  for (const [service, flags] of Object.entries(P2_CERTIFICATION_RUNTIME_FLAGS)) {
    const values = Object.fromEntries(bytes(join(configuration, service + '.env')).toString('utf8').split('\n')
      .filter(line => line && !line.startsWith('#')).map(line => { const index = line.indexOf('='); require(index > 0); return [line.slice(0, index), line.slice(index + 1)]; }));
    require(Object.entries(flags).every(([key, expected]) => values[key] === expected));
  }
  const candidateSha256 = sha256(bytes(join(bundle, 'release.candidate.json'), true));
  require(isDeepStrictEqual(object(join(configuration, 'gateway.json')).admission,
    { file: '/admission/state.json', releaseId: candidate.releaseId, candidateSha256 }));
  return { prepared, roles, inventory, reviewedInventory, candidate, job, baseline, configurationSha256, plan: {
    version: 1, environment: 'staging', operation: 'phase2-frontend-sql-api-runtime-and-compatible-promotion',
    sourceCommit: settings.sourceCommit, sources: candidate.sources, releaseId: candidate.releaseId, candidateSha256,
    hostMachineId: settings.host.machineId, frontendTarget: job.target, configurationSha256,
    certification: reviewedInventory.certification, writerAdmissionBinding, runtimeFlags: P2_CERTIFICATION_RUNTIME_FLAGS, restoration: reviewedInventory.restoration,
    ...(priorGatewayReference ? { priorGatewayReference } : {}),
    ...(roles ? { rolePreparation: roles, inventoryRoleBindings: 'desired-names-only' } : {}),
    trafficAuthorized: false, releaseAccepted: false, approval: 'Dardan starts this exact reviewed staging action',
  } };
}

export async function p2OperatorRelease(settings, { apply = false, confirmation } = {}) {
  require(process.versions.node.split('.')[0] === '24');
  const checked = prepareP2OperatorRelease(settings);
  if (!apply) return checked.plan;
  require(confirmation === `staging/${checked.candidate.releaseId}`);
  const committed = committedOperatorSource(root, settings.sourceCommit);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN), sourceCommit: settings.sourceCommit,
    branch: committed.branch, workflowBytes: committed.workflowBytes });
  frontendPrivateReceiptDirectory(settings.results);
  const directory = join(settings.results, checked.candidate.releaseId); mkdirSync(directory, { mode: 0o700 });
  const frontendDirectory = join(directory, 'frontend'); mkdirSync(frontendDirectory, { mode: 0o700 });
  const diagnostics = join(directory, 'ssh'); mkdirSync(diagnostics, { mode: 0o700 });
  writeFileSync(join(directory, 'reviewed-plan.json'), JSON.stringify(checked.plan) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(directory, 'exact-source-ci.json'), JSON.stringify(ci) + '\n', { mode: 0o600, flag: 'wx' });
  // The existing mounted/private handoff is read only in apply, inside this
  // process. AWS-held fields must be resolved privately by asm-exec beforehand.
  const context = object(settings.providerContext, true);
  const credentials = Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL', 'COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL']
    .map(key => { const value = process.env[key]; require(typeof value === 'string' && value.length > 0); return [key, value]; }));
  require(typeof context.vercelToken === 'string' && context.vercelToken.length > 0);
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics });
  const machine = await ssh.machine(); require(machine.machineId === settings.host.machineId);
  const installed = await ssh.installSource({ commit: settings.sourceCommit, files: committed.files });
  require(installed.status === 'EXACT_OPERATOR_SOURCE_INSTALLED' && installed.commit === settings.sourceCommit);
  const initial = { version: 1, environment: 'staging', sourceCommit: settings.sourceCommit,
    sourceSha256: Object.fromEntries(committed.files.map(file => [file.path, file.sha256])),
    sourceClosureSha256: sha256(JSON.stringify(committed.files.map(file => [file.path, file.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))),
    hostMachineId: settings.host.machineId, candidate: checked.candidate,
    candidateSha256: checked.plan.candidateSha256,
    bundle: settings.host.bundle, configuration: settings.host.configuration, results: settings.host.results,
    configurationSha256: checked.configurationSha256, confirmation, credentials, vercelToken: context.vercelToken,
    frontendJob: checked.job, frontendBaseline: checked.baseline, targetSha256: checked.reviewedInventory.targetSha256,
    owner: checked.reviewedInventory.owner, certification: checked.reviewedInventory.certification,
    expectedWriterAdmissionBinding: checked.plan.writerAdmissionBinding,
    ...(checked.plan.priorGatewayReference ? { priorGatewayReference: checked.plan.priorGatewayReference } : {}),
    ...(checked.roles ? { rolePreparation: checked.roles } : {}),
    gatewayObservation: context.bindings?.gatewayObservation };
  require(sha256(JSON.stringify(initial.gatewayObservation)) === checked.reviewedInventory.restoration.gatewayBindingSha256);
  const withEnvironmentLock = p2HostEnvironmentLock(settings, initial, frontendDirectory);
  if (checked.roles) return withEnvironmentLock((verifyEnvironment, environmentSignal, runtime) =>
    runP2RolePreparationContinuation({ checked, settings, directory, frontendDirectory, context, credentials, confirmation,
      verifyEnvironment, environmentSignal, runtime }));
  return runFrontendReleaseCoordination(checked.prepared, {
    confirmation, directory: frontendDirectory, getUrl: () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    getProviderContext: async () => context, withEnvironmentLock,
  });
}

export async function runP2RolePreparationContinuation({ checked, settings, directory, frontendDirectory, context, credentials, confirmation, verifyEnvironment, environmentSignal, runtime }, { createClient = options => new Client(options) } = {}) {
    let client, identity, closePromise, terminatePromise, aborted = environmentSignal.aborted;
    const connection = () => frontendConnectionOptions(credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL, checked.job.target);
    const terminateOriginal = () => terminatePromise ??= (async () => {
      if (!identity) return; // no role SQL or advisory lock can precede identity
      const checker = createClient({ ...connection(), application_name: 'lash-her-p2-role-close',
        statement_timeout: 7_000, query_timeout: 8_000, lock_timeout: 1_000 });
      checker.on('error', () => {});
      let cleanup;
      try {
        await checker.connect();
        const actual = (await checker.query('SELECT current_user,current_database() AS database')).rows[0];
        require(checker.connection.stream.encrypted && checker.connection.stream.authorized &&
          actual.current_user === checked.job.target.user && actual.database === checked.job.target.database);
        // Terminate only this action's original backend. A reused PID cannot
        // match its independently read server start time/user/database tuple.
        await checker.query(`SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity
          WHERE pid=$1 AND backend_start::text=$2 AND usename=$3 AND datname=$4`,
        [identity.pid, identity.backend_start, identity.current_user, identity.database]);
        const deadline = Date.now() + 5_000;
        while (true) {
          const remaining = (await checker.query(`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE pid=$1 AND backend_start::text=$2`, [identity.pid, identity.backend_start])).rows[0]?.count;
          require(Number.isInteger(remaining));
          if (remaining === 0) break;
          require(Date.now() < deadline); await delay(50);
        }
        cleanup = { status: 'P2_ROLE_SESSION_ABORTED_AND_ABSENT', originalBackendPid: identity.pid,
          originalBackendStart: identity.backend_start, backendAbsent: true, originalBackendLocksReleased: true };
      } finally { await checker.end(); }
      writeFrontendReceipt(directory, 'role-session-cleanup.json', cleanup);
    })();
    const close = () => closePromise ??= (async () => {
      // pg.end destroys a blocked-query socket, but PostgreSQL can keep that
      // backend and its advisory lock until the statement notices disconnect.
      // Abort therefore also uses a bounded same-identity termination/readback.
      try { if (client) await client.end(); }
      finally { if (aborted) await terminateOriginal(); }
    })();
    const abort = () => {
      aborted = true;
      // Also interrupt a normal close already in progress; its cached promise
      // remains the one awaited by every caller and the finalizer.
      try { client?.connection?.stream?.destroy(); } catch { /* termination/readback remains mandatory */ }
      void terminateOriginal().catch(() => {});
      void close().catch(() => {});
    };
    environmentSignal.addEventListener('abort', abort, { once: true });
    try {
      require(!aborted); await verifyEnvironment();
      client = createClient(connection());
      let failed = false; client.on('error', () => { failed = true; }); await client.connect();
      identity = (await client.query('SELECT pg_backend_pid() AS pid,current_user,current_database() AS database,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
      require(Number.isSafeInteger(identity?.pid) && typeof identity.backend_start === 'string' && client.connection.stream.encrypted && client.connection.stream.authorized && identity.current_user === checked.job.target.user && identity.database === checked.job.target.database);
      require((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [FRONTEND_MIGRATION_LOCK])).rows[0]?.held === true);
      const verifySession = async () => {
        require(!failed && !aborted && !environmentSignal.aborted); await verifyEnvironment();
        const same = (await client.query('SELECT pg_backend_pid() AS pid,current_user,current_database() AS database')).rows[0];
        require(same.pid === identity.pid && same.current_user === identity.current_user && same.database === identity.database);
      };
      const rolesDirectory = join(directory, 'role-preparation'), rolesPrivate = join(directory, 'role-credentials');
      mkdirSync(rolesDirectory, { mode: 0o700 }); mkdirSync(rolesPrivate, { mode: 0o700 });
      const proof = await applyPreparedFrontendRoles(checked.roles, client, { confirmation, verifyEnvironment, verifySession,
        directory: rolesDirectory, privateDirectory: rolesPrivate,
        ...(settings.rolesReuseDirectory ? { reuseDirectory: settings.rolesReuseDirectory, reusePrivateDirectory: settings.rolesReusePrivateDirectory } : {}) });
      await verifySession(); await runtime.bindRoles(proof);
      const inventory = { ...checked.inventory, owner: proof.owner,
        producers: proof.producers.map(({ producerSha256, role }) => ({ producerSha256, role })), rolePreparationProofSha256: proof.proofSha256 };
      const prepared = prepareFrontendReleaseCoordination(checked.candidate, checked.job, checked.baseline, inventory);
      writeFrontendReceipt(directory, 'observed-frontend-inventory.json', prepared.plan);
      const replacementContext = { ...context, frontendRuntimeDatabaseUrl: proof.private.runtimeDatabaseUrl };
      const connected = new Proxy(client, { get(target, key) {
        if (key === 'connect') return verifySession;
        if (key === 'end') return close;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return await runFrontendReleaseCoordination(prepared, { confirmation, directory: frontendDirectory,
        getUrl: () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL, getProviderContext: async () => replacementContext,
        createClient: () => connected,
        withEnvironmentLock: continuation => continuation(verifyEnvironment, environmentSignal, runtime) });
    } finally {
      try { await close(); if (aborted) await terminateOriginal(); }
      finally { environmentSignal.removeEventListener('abort', abort); }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, path, flag, confirmation] = process.argv.slice(2);
    require(['plan', 'apply'].includes(operation) && typeof path === 'string' &&
      (operation === 'plan' ? flag === undefined && confirmation === undefined : flag === '--confirm' && typeof confirmation === 'string'));
    console.log(JSON.stringify(await p2OperatorRelease(object(resolve(path), true), { apply: operation === 'apply', confirmation })));
  } catch { console.error('P2_OPERATOR_RELEASE_FAILED_REQUIRES_REVIEW'); process.exitCode = 1; }
}
