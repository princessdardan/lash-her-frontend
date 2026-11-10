import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sshCommand } from './recreation_ssh.mjs';
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from './frontend-release-receipts.mjs';
import { writeFrontendReceipt } from './frontend-migration.mjs';
import { decodeQualificationTargetJson, requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from './qualification-target-profile.mjs';
import { isDeepStrictEqual } from 'node:util';

const demand = ok => { if (!ok) throw new Error('P2_PROFILED_CURRENT_TRANSPORT_REFUSED'); };
const hash = raw => createHash('sha256').update(raw).digest('hex');
const MAXIMUM = 4_000_000;
const names = Object.freeze({ database: 'database-receipt.json', 'continuation-started': 'frontend-continuation-started.json',
  'continuation-completed': 'frontend-continuation-completed.json', terminal: 'job-outcome.json' });
const falseFlags = ['frontendSqlApplied', 'historicalProviderClosureClaimed', 'oldP200Qualified',
  'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted'];
const profile = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE;

export function retainP2ProfiledCurrentRaw(directory, name, raw) {
  demand(['release.candidate.json', 'api-migration-outcome.json', 'api-runtime-outcome.json'].includes(name) &&
    Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2_000_000);
  frontendPrivateReceiptDirectory(directory);
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, raw); fsyncSync(fd);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { closeSync(fd); }
}

function rawReceipt(value) {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 2_666_668);
  const bytes = Buffer.from(value, 'base64');
  demand(bytes.length > 0 && bytes.length <= 2_000_000 && bytes.toString('base64') === value);
  return bytes;
}

export function readP2ProfiledCurrentFrontendReceipt(directory, kind, migration) {
  resolveQualificationTargetProfile(profile);
  requireQualificationTargetProfile(profile, migration, migration?.candidate, migration?.candidate?.frontendMigration,
    migration?.job, migration?.job?.target);
  demand(typeof kind === 'string' && Object.hasOwn(names, kind) && migration.job.version === 2 &&
    migration.job.target.approvedPendingTags.length === 0);
  const bytes = readFrontendReleaseEvidence(directory, names[kind]), record = decodeQualificationTargetJson(bytes, 'carrier');
  requireQualificationTargetProfile(profile, record);
  const job = migration.job;
  demand(record.version === 2 && record.service === 'frontend' && record.environment === 'staging' &&
    ['releaseId', 'sourceCommit', 'sqlArtifactSha256', 'schemaBaselineSha256', 'migrationImageDigest', 'contractManifestSha256',
      'contractPhase', 'phase2ContractManifestSha256'].every(key => record[key] === job[key] && job[key] !== undefined) &&
    record.migrationMode === 'verify-current-only' && record.failureCode === undefined && record.trafficAuthorized === false &&
    isDeepStrictEqual(record.target, Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, job.target[key]]))));
  const status = kind === 'continuation-started' ? 'FRONTEND_CONTINUATION_STARTED' : kind === 'continuation-completed' ? 'FRONTEND_CONTINUATION_COMPLETED' : 'DATABASE_VERIFIED';
  demand(record.status === status);
  if (kind.startsWith('continuation-')) demand(record.databaseVerified === true);
  else demand(record.readOnlyVerified === true);
  if (kind === 'database') demand(record.schemaVerified === true && record.runtimeRoleVerified === true &&
    Array.isArray(record.applied) && record.applied.length === 0 && Array.isArray(record.before) && record.before.length > 0 &&
    isDeepStrictEqual(record.before, record.after));
  if (kind === 'terminal') demand(record.phase === 'completed');
  return { bytes, record, sha256: hash(bytes) };
}

export function p2ProfiledCurrentEnvironmentLock(settings, initial, directory) {
  return transport(settings, initial, directory, spawn);
}

function transport(settings, initial, directory, launch) {
  resolveQualificationTargetProfile(profile);
  requireQualificationTargetProfile(profile, initial, initial?.candidate, initial?.candidate?.frontendMigration,
    initial?.frontendJob, initial?.frontendJob?.target, initial?.inventory);
  demand(initial.version === 2 && initial.mode === 'p2-profiled-current-release' && initial.environment === 'staging' &&
    /^[a-f0-9]{40}$/u.test(initial.sourceCommit ?? '') && initial.candidate.version === 3 && initial.frontendJob.version === 2 &&
    initial.frontendJob.target.approvedPendingTags.length === 0);
  const snapshot = structuredClone(initial);
  const rawInitial = JSON.stringify(snapshot); demand(Buffer.byteLength(rawInitial) <= MAXIMUM);
  const migration = { qualificationTargetProfile: profile, candidate: snapshot.candidate, job: snapshot.frontendJob, baseline: snapshot.frontendBaseline };
  const bound = (receipt, status) => {
    requireQualificationTargetProfile(profile, receipt);
    demand(receipt.version === 2 && receipt.status === status && receipt.environment === 'staging' &&
      receipt.releaseId === snapshot.candidate.releaseId && receipt.sourceCommit === snapshot.sourceCommit &&
      receipt.candidateSha256 === snapshot.candidateSha256 && isDeepStrictEqual(receipt.configurationSha256, snapshot.configurationSha256) &&
      receipt.contractPhase === 'p2' && receipt.phase2ContractManifestSha256 === snapshot.candidate.phase2ContractManifestSha256 &&
      falseFlags.every(key => receipt[key] === false));
  };
  const remote = ['sudo', '-n', '/usr/bin/python3', '-I', '-u',
    `/opt/lash-her/operators/${snapshot.sourceCommit}/ops/platform/host/p2_profiled_current_parent.py`];
  return async task => {
    demand(typeof task === 'function');
    const child = launch('/usr/bin/ssh', sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote), {
      stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(['PATH', 'HOME', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    });
    const controller = new AbortController(), pending = new Map();
    let active = true, failed = false, exited, sequence = 0, heartbeat, diagnostics = Buffer.alloc(0);
    let armSent = false, armed = false, armedProbe, priorSent = false, priorPrepared = false, apiReady = false;
    let frontendVerified = false, closing = false, sessionClosed = false, joined;
    const lost = () => {
      if (failed) return;
      failed = true; controller.abort();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('P2_PROFILED_CURRENT_ENVIRONMENT_LOST')); }
      pending.clear(); child.stdin.end();
    };
    let stdout = Buffer.alloc(0);
    const acceptLine = raw => {
      try {
        demand(raw.length > 0 && raw.length <= MAXIMUM);
        const value = decodeQualificationTargetJson(raw, 'private-packet'), waiter = pending.get(value.id);
        demand(waiter && value.status === waiter.expected);
        waiter.accept(value);
      } catch { lost(); }
    };
    child.stdout.on('data', chunk => {
      let offset = 0;
      while (!failed && offset < chunk.length) {
        const end = chunk.indexOf(10, offset), part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (stdout.length + part.length > MAXIMUM) { lost(); return; }
        stdout = Buffer.concat([stdout, part]);
        if (end < 0) return;
        acceptLine(stdout); stdout = Buffer.alloc(0); offset = end + 1;
      }
    });
    child.stdout.on('end', () => { if (stdout.length) lost(); });
    child.on('error', lost); child.stdin.on('error', lost);
    child.stderr.on('data', chunk => {
      if (diagnostics.length + chunk.length > 1_000_000) { lost(); return; }
      diagnostics = Buffer.concat([diagnostics, chunk]);
    });
    child.on('exit', code => { exited = code; if (active || code !== 0) lost(); });
    const reaped = new Promise(resolve => child.once('close', resolve));
    const wait = (id, expected, timeout = 60_000, onAccept = () => {}) => new Promise((resolve, reject) => {
      demand(!failed && !pending.has(id));
      const timer = setTimeout(lost, timeout);
      pending.set(id, { expected, timer, reject, accept(value) {
        onAccept(value);
        clearTimeout(timer); pending.delete(id); resolve(value);
      } });
    });
    const send = (operation, expected, data = {}, timeout = 60_000, onAccept) => {
      demand(active && !failed);
      const id = ++sequence, raw = JSON.stringify({ id, operation, ...data });
      demand(Buffer.byteLength(raw) <= MAXIMUM);
      const response = wait(id, expected, timeout, onAccept); child.stdin.write(raw + '\n'); return response;
    };
    const started = wait(0, 'LOCKED');
    child.stdin.write(rawInitial + '\n');
    const verifyEnvironment = async () => { await send('check', 'HELD'); };
    const host = {
      async armCurrent({ receipt, continuationStarted, probe }) {
        demand(active && !failed && !armSent && !closing);
        const database = readP2ProfiledCurrentFrontendReceipt(directory, 'database', migration);
        const continuation = readP2ProfiledCurrentFrontendReceipt(directory, 'continuation-started', migration);
        demand(Buffer.isBuffer(receipt) && receipt.equals(database.bytes) && Buffer.isBuffer(continuationStarted) &&
          continuationStarted.equals(continuation.bytes) && isDeepStrictEqual(probe.receipt, database.record));
        requireQualificationTargetProfile(profile, probe);
        demand(probe.version === 2 && probe.operation === 'verify-schema' &&
          isDeepStrictEqual(probe.job, snapshot.frontendJob) && isDeepStrictEqual(probe.baseline, snapshot.frontendBaseline) &&
          isDeepStrictEqual(probe.owner, snapshot.owner) && probe.targetSha256 === snapshot.targetSha256);
        armSent = true;
        armedProbe = structuredClone(probe);
        const id = ++sequence;
        let resolveArmed, rejectArmed, resolveReady, rejectReady;
        const accepted = new Promise((resolve, reject) => { resolveArmed = resolve; rejectArmed = reject; });
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        // The deferred READY may reject while PREPARED is still awaited.
        void ready.catch(() => {});
        const timer = setTimeout(lost, 2_700_000);
        pending.set(id, { expected: 'PROFILED_CURRENT_ARMED', timer, reject(error) { rejectArmed(error); rejectReady(error); }, accept(value) {
          const waiter = pending.get(id);
          if (!armed) { armed = true; waiter.expected = 'PROFILED_CURRENT_API_READY'; resolveArmed(value); }
          else {
            demand(priorPrepared && !apiReady); bound(value.receipt, 'API_RUNTIME_READY');
            const migrationRaw = rawReceipt(value.migrationOutcome), runtimeRaw = rawReceipt(value.runtimeOutcome);
            const migrationOutcome = decodeQualificationTargetJson(migrationRaw, 'carrier');
            requireQualificationTargetProfile(profile, migrationOutcome);
            demand(migrationOutcome.version === 2 && migrationOutcome.status === 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN' &&
              migrationOutcome.environment === 'staging' && migrationOutcome.releaseId === snapshot.candidate.releaseId &&
              value.receipt.migrationOutcomeSha256 === hash(migrationRaw) &&
              isDeepStrictEqual(decodeQualificationTargetJson(runtimeRaw, 'carrier'), value.receipt));
            retainP2ProfiledCurrentRaw(dirname(directory), 'api-migration-outcome.json', migrationRaw);
            retainP2ProfiledCurrentRaw(dirname(directory), 'api-runtime-outcome.json', runtimeRaw);
            apiReady = true; clearTimeout(timer); pending.delete(id); resolveReady(value.receipt);
          }
        } });
        const raw = JSON.stringify({ id, operation: 'profiled-current-arm', receipt: receipt.toString('base64'),
          continuationStarted: continuationStarted.toString('base64'), probe });
        demand(Buffer.byteLength(raw) <= MAXIMUM); child.stdin.write(raw + '\n');
        await accepted; return { apiReady: ready };
      },
      async preparePriorGateway() {
        demand(armed && !priorSent && !closing); priorSent = true;
        await send('profiled-current-prepare-prior-gateway', 'PROFILED_CURRENT_PRIOR_GATEWAY_PREPARED', {}, 300_000, result => {
          demand(result.receipt?.status === 'PRIOR_GATEWAY_CLOSED_ZERO'); priorPrepared = true;
        });
      },
      async frontendVerified(proof, workload) {
        demand(apiReady && !frontendVerified && !closing && Buffer.isBuffer(workload) && workload.length > 0 && workload.length <= 2_000_000);
        requireQualificationTargetProfile(profile, proof);
        demand(proof.version === 2 && proof.actionId === snapshot.candidate.releaseId && proof.sourceCommit === snapshot.sourceCommit &&
          proof.workloadReceiptSha256 === hash(workload));
        const record = decodeQualificationTargetJson(workload, 'carrier');
        requireQualificationTargetProfile(profile, record);
        demand(record.version === 2 && record.status === 'FRONTEND_VERIFIED' && record.environment === 'staging' &&
          record.releaseId === snapshot.candidate.releaseId && record.sourceCommit === snapshot.sourceCommit &&
          record.contractPhase === 'p2' && record.phase2ContractManifestSha256 === snapshot.candidate.phase2ContractManifestSha256);
        const safe = Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'evidence'));
        await send('profiled-current-frontend-verified', 'PROFILED_CURRENT_FRONTEND_VERIFIED', { proof: safe, workload: workload.toString('base64') });
        frontendVerified = true;
      },
      async prepareClose() {
        demand(frontendVerified && !closing);
        await send('profiled-current-prepare-close', 'PROFILED_CURRENT_CLOSE_PREPARED', {}, 300_000); closing = true;
      },
      async frontendSessionClosed() {
        demand(closing && !sessionClosed);
        // Read the actual terminal only after the runner has disconnected.
        readP2ProfiledCurrentFrontendReceipt(directory, 'terminal', migration);
        const result = await send('profiled-current-session-closed', 'PROFILED_CURRENT_SESSION_CLOSED', {}, 5_000);
        requireQualificationTargetProfile(profile, result.receipt);
        demand(result.receipt.version === 2 && result.receipt.status === 'P2_PROFILED_CURRENT_SESSION_CLOSED' &&
          result.receipt.environment === 'staging' && result.receipt.releaseId === snapshot.candidate.releaseId &&
          result.receipt.sourceCommit === snapshot.sourceCommit && result.receipt.targetSha256 === snapshot.targetSha256 &&
          result.receipt.originalBackendPid === armedProbe.backendPid && result.receipt.originalBackendStart === armedProbe.backendStart &&
          result.receipt.backendAbsent === true && result.receipt.migrationLockReleased === true && result.receipt.nonceLockReleased === true &&
          result.receipt.admission?.newWork === false && result.receipt.admission.recovery === false &&
          result.receipt.admission.active === 0 && result.receipt.admission.uncertain === 0);
        sessionClosed = true; return result.receipt;
      },
      async finish({ terminal, continuationCompleted, releaseOutcome }) {
        demand(closing && sessionClosed && !joined);
        const actualTerminal = readP2ProfiledCurrentFrontendReceipt(directory, 'terminal', migration);
        const continuation = readP2ProfiledCurrentFrontendReceipt(directory, 'continuation-completed', migration);
        const actualOutcome = readFrontendReleaseEvidence(directory, 'p2-profiled-current-release-outcome.json');
        demand(Buffer.isBuffer(terminal) && terminal.equals(actualTerminal.bytes) && Buffer.isBuffer(continuationCompleted) &&
          continuationCompleted.equals(continuation.bytes) && Buffer.isBuffer(releaseOutcome) && releaseOutcome.equals(actualOutcome));
        const record = decodeQualificationTargetJson(releaseOutcome, 'carrier');
        bound(record, 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED');
        demand(falseFlags.every(key => record[key] === false));
        joined = await send('profiled-current-finish', 'PROFILED_CURRENT_JOINED', { terminal: terminal.toString('base64'),
          continuationCompleted: continuationCompleted.toString('base64'), releaseOutcome: releaseOutcome.toString('base64') }, 5_000);
        bound(joined.receipt, 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION');
      },
    };
    let committedReceipt, failure;
    try {
      await started;
      heartbeat = setInterval(() => { if (!failed) void verifyEnvironment().catch(lost); }, 1000);
      await verifyEnvironment(); await task(verifyEnvironment, controller.signal, host);
      demand(joined && !failed);
      const committed = await send('commit', 'COMMITTED', {}, 60_000, value => {
        demand(isDeepStrictEqual(value.receipt, joined.receipt)); active = false;
      });
      committedReceipt = committed.receipt;
    } catch { failure = new Error('P2_PROFILED_CURRENT_RELEASE_FAILED_REQUIRES_REVIEW'); lost(); }
    finally {
      clearInterval(heartbeat); child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 65_000);
      const stop = setTimeout(() => { failure ??= new Error('P2_PROFILED_CURRENT_CLEANUP_UNCERTAIN'); child.kill('SIGTERM'); }, 60_000);
      await reaped; clearTimeout(stop); clearTimeout(kill); active = false;
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      if (exited !== 0 || failed) failure ??= new Error('P2_PROFILED_CURRENT_CLEANUP_UNCERTAIN');
      if (failure && diagnostics.length) writeFileSync(join(directory, 'p2-profiled-current-private-stderr.bin'), diagnostics, { mode: 0o600, flag: 'wx' });
    }
    if (failure) throw failure;
    demand(committedReceipt);
    // The ACK alone does not prove the independently guarded SSH child reaped
    // successfully. Publish local success only after its verified zero exit.
    writeFrontendReceipt(directory, 'p2-profiled-current-host-outcome.json', committedReceipt);
    return committedReceipt;
  };
}
