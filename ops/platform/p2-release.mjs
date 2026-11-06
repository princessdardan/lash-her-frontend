#!/usr/bin/env node
// Plan-default P2 operator entry point. Private credentials remain in the
// runtime process/SSH stdin; no dotenv loading, migrations or network in plan.
import { readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareFrontendReleaseCoordination, runFrontendReleaseCoordination } from './frontend-release-coordinator.mjs';
import { frontendPrivateReceiptDirectory } from './frontend-release-receipts.mjs';
import { committedOperatorSource, verifyOperatorCi } from './recreation_source.mjs';
import { githubSourceApi } from './release-inputs.mjs';
import { recreationSsh } from './recreation_ssh.mjs';
import { p2HostEnvironmentLock } from './p2-release-transport.mjs';
import { prepareP2CertificationProfile, P2_CERTIFICATION_RUNTIME_FLAGS } from './p2-certification-profile.mjs';

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
export function prepareP2OperatorRelease(settings) {
  require(settings?.version === 1 && settings.environment === 'staging' && /^[a-f0-9]{40}$/u.test(settings.sourceCommit));
  const bundle = settings.bundle;
  frontendPrivateReceiptDirectory(bundle);
  const candidate = object(join(bundle, 'release.candidate.json'), true);
  const job = object(join(bundle, 'jobs/frontend.json'));
  const baseline = object(join(bundle, 'schema/frontend.json'));
  const inventory = object(settings.inventory, true);
  const prepared = prepareFrontendReleaseCoordination(candidate, job, baseline, inventory);
  require(candidate.contractPhase === 'p2' && settings.sourceCommit === prepared.plan.sourceCommit &&
    prepared.plan.restoration?.newWork === true && prepared.plan.restoration.recovery === true &&
    isDeepStrictEqual(prepared.plan.certification, prepareP2CertificationProfile(prepared.plan.certification)));
  validateP2HostSettings(settings.host);
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
  return { prepared, candidate, job, baseline, configurationSha256, plan: {
    version: 1, environment: 'staging', operation: 'phase2-frontend-sql-api-runtime-and-compatible-promotion',
    sourceCommit: settings.sourceCommit, sources: candidate.sources, releaseId: candidate.releaseId, candidateSha256,
    hostMachineId: settings.host.machineId, frontendTarget: job.target, configurationSha256,
    certification: prepared.plan.certification, runtimeFlags: P2_CERTIFICATION_RUNTIME_FLAGS, restoration: prepared.plan.restoration,
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
    hostMachineId: settings.host.machineId, candidate: checked.candidate,
    candidateSha256: checked.plan.candidateSha256,
    bundle: settings.host.bundle, configuration: settings.host.configuration, results: settings.host.results,
    configurationSha256: checked.configurationSha256, confirmation, credentials, vercelToken: context.vercelToken,
    frontendJob: checked.job, frontendBaseline: checked.baseline, targetSha256: checked.prepared.plan.targetSha256,
    owner: checked.prepared.plan.owner, certification: checked.prepared.plan.certification,
    gatewayObservation: context.bindings?.gatewayObservation };
  require(sha256(JSON.stringify(initial.gatewayObservation)) === checked.prepared.plan.restoration.gatewayBindingSha256);
  const withEnvironmentLock = p2HostEnvironmentLock(settings, initial, frontendDirectory);
  return runFrontendReleaseCoordination(checked.prepared, {
    confirmation, directory: frontendDirectory, getUrl: () => credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    getProviderContext: async () => context, withEnvironmentLock,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, path, flag, confirmation] = process.argv.slice(2);
    require(['plan', 'apply'].includes(operation) && typeof path === 'string' &&
      (operation === 'plan' ? flag === undefined && confirmation === undefined : flag === '--confirm' && typeof confirmation === 'string'));
    console.log(JSON.stringify(await p2OperatorRelease(object(resolve(path), true), { apply: operation === 'apply', confirmation })));
  } catch { console.error('P2_OPERATOR_RELEASE_FAILED_REQUIRES_REVIEW'); process.exitCode = 1; }
}
