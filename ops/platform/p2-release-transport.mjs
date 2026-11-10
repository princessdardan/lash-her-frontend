// The operator's Node process retains the frontend PG session; this fixed SSH
// child retains the actual selected Linux host flock and API continuation.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sshCommand } from './recreation_ssh.mjs';
import { readFrontendReleaseEvidence } from './frontend-release-receipts.mjs';
import { writeFrontendReceipt } from './frontend-migration.mjs';

const require = ok => { if (!ok) throw new Error('P2_HOST_RELEASE_TRANSPORT_REFUSED'); };
const MAXIMUM = 4_000_000;
export function p2HostEnvironmentLock(settings, initial, directory, { launch = spawn } = {}) {
  require(/^[a-f0-9]{40}$/u.test(initial.sourceCommit) && initial.environment === 'staging');
  const remote = ['sudo', '-n', '/usr/bin/python3', '-I', '-u',
    `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_release_supervisor.py`];
  return async task => {
    const child = launch('/usr/bin/ssh', sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote), {
      stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(['PATH', 'HOME', 'LANG'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
    });
    const signal = new AbortController(), pending = new Map();
    let sequence = 0, failed = false, exited, active = true, diagnostics = Buffer.alloc(0), heartbeat, priorGatewayPrepared = false, apiStarted = false, preparedClose = false, joined;
    const fail = () => {
      if (failed) return;
      failed = true; signal.abort();
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('P2_REMOTE_ENVIRONMENT_OR_RUNTIME_LOST')); }
      pending.clear();
      child.stdin.end();
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', raw => {
      try {
        require(Buffer.byteLength(raw) <= MAXIMUM);
        const value = JSON.parse(raw), waiter = pending.get(value.id);
        require(waiter && value.status === waiter.expected);
        pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value);
      } catch { fail(); }
    });
    child.stderr.on('data', chunk => {
      if (diagnostics.length + chunk.length > 1_000_000) { fail(); return; }
      diagnostics = Buffer.concat([diagnostics, chunk]);
    });
    child.on('error', fail); child.stdin.on('error', fail);
    child.on('exit', code => { exited = code; if (active || code !== 0) fail(); });
    const expect = (id, expected, timeout) => new Promise((resolve, reject) => {
      if (failed || pending.has(id)) { reject(new Error('P2_REMOTE_ENVIRONMENT_OR_RUNTIME_LOST')); return; }
      const timer = setTimeout(() => { fail(); reject(new Error('P2_REMOTE_OPERATION_UNCERTAIN')); }, timeout);
      pending.set(id, { expected, resolve, reject, timer });
    });
    const request = (operation, expected, data = {}, timeout = 60_000) => {
      require(!failed && active);
      const id = ++sequence, raw = JSON.stringify({ id, operation, ...data });
      require(Buffer.byteLength(raw) <= MAXIMUM);
      const response = expect(id, expected, timeout); child.stdin.write(raw + '\n'); return response;
    };
    const started = expect(0, 'LOCKED', 60_000);
    const payload = JSON.stringify(initial); require(Buffer.byteLength(payload) <= MAXIMUM);
    child.stdin.write(payload + '\n');
    let result, failure;
    try {
      await started;
      const verifyEnvironment = async () => { await request('check', 'HELD'); };
      // This heartbeat never interleaves queries into the frontend client's
      // SET ROLE/transaction operations. The host independently observes PG.
      heartbeat = setInterval(() => { if (!failed) void verifyEnvironment().catch(fail); }, 1000);
      const runtime = {
        async preparePriorGateway({ verify }) {
          require(!apiStarted && !priorGatewayPrepared); await verify();
          const result = await request('prepare-prior-gateway', 'PRIOR_GATEWAY_PREPARED', {}, 300_000);
          require(result.receipt?.status === 'PRIOR_GATEWAY_CLOSED_ZERO');
          await verify(); priorGatewayPrepared = true;
        },
        async bindRoles(proof) {
          require(!apiStarted && initial.rolePreparation);
          await verifyEnvironment();
          await request('roles-prepared', 'ROLES_PREPARED', { proof });
          initial.owner = structuredClone(proof.owner);
        },
        async start({ database, client, verify }) {
          require(priorGatewayPrepared && !apiStarted); await verify(); apiStarted = true;
          const marker = randomBytes(32).toString('hex');
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [marker]);
          const identity = (await client.query('SELECT pg_backend_pid() AS pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];
          require(Number.isSafeInteger(identity?.pid) && typeof identity.backend_start === 'string');
          const original = readFrontendReleaseEvidence(directory, 'database-receipt.json');
          require(JSON.stringify(JSON.parse(original)) === JSON.stringify(database));
          const result = await request('start-api', 'API_READY', { receipt: original.toString('base64'), probe: {
            version: 1, operation: 'verify-schema', marker, backendPid: identity.pid, backendStart: identity.backend_start,
            job: initial.frontendJob, receipt: database, baseline: initial.frontendBaseline,
            targetSha256: initial.targetSha256, owner: initial.owner,
          } }, 2_700_000);
          require(result.receipt?.status === 'API_RUNTIME_READY' && result.receipt.environment === 'staging' &&
            result.receipt.releaseId === initial.candidate.releaseId && result.receipt.trafficAuthorized === false);
          await verify();
        },
        async frontendVerified(proof, verify) {
          require(apiStarted && !preparedClose); await verify();
          const workload = readFrontendReleaseEvidence(join(directory, 'vercel'), 'frontend-workload-outcome.json');
          require(workload.length > 0 && workload.length <= 2_000_000);
          await request('frontend-verified', 'FRONTEND_VERIFIED', { proof, workload: workload.toString('base64') });
          await verify();
        },
        async prepareClose(verify) {
          require(apiStarted && !preparedClose); await verify();
          await request('prepare-close', 'FRONTEND_CLOSE_PREPARED'); preparedClose = true;
        },
        async observeRestorationBoundary(frontend, context) {
          require(apiStarted && !preparedClose); await context.verifyLockedSession();
          const { gateway } = await request('observe-gateway', 'GATEWAY_OBSERVED');
          const observation = Object.fromEntries(Object.entries(frontend).filter(([key]) => !['evidence', 'evidenceSha256'].includes(key)));
          const value = { version: 1, environment: 'staging', actionId: context.plan.actionId,
            sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256,
            status: 'FRONTEND_RESTORATION_BOUNDARY_OBSERVED', frontend: observation, gateway };
          const evidence = Buffer.from(JSON.stringify(value));
          await context.verifyLockedSession();
          return { ...value, evidence, evidenceSha256: createHash('sha256').update(evidence).digest('hex') };
        },
        async finish(outcome, verifyEnvironmentOnly) {
          require(preparedClose); await verifyEnvironmentOnly();
          const terminal = readFrontendReleaseEvidence(directory, 'job-outcome.json');
          const frontend = readFrontendReleaseEvidence(directory, 'frontend-release-held.json');
          require(JSON.stringify(JSON.parse(frontend)) === JSON.stringify(outcome));
          joined = await request('finish', 'P2_RELEASE_JOINED', { terminal: terminal.toString('base64'), frontend: frontend.toString('base64') });
          require(joined.receipt?.status === 'P2_STAGING_READY_FOR_CERTIFICATION');
        },
      };
      await verifyEnvironment(); result = await task(verifyEnvironment, signal.signal, runtime); await verifyEnvironment();
      require(joined && !failed);
      const committed = await request('commit', 'COMMITTED');
      require(JSON.stringify(committed.receipt) === JSON.stringify(joined.receipt));
      writeFrontendReceipt(directory, 'p2-host-release-outcome.json', committed.receipt);
      active = false;
    } catch { failure = new Error('P2_RELEASE_FAILED_REQUIRES_REVIEW'); fail(); }
    finally {
      clearInterval(heartbeat); child.stdin.end();
      if (exited === undefined) {
        await new Promise(resolve => {
          const timeout = setTimeout(() => { child.kill('SIGTERM'); failure ??= new Error('P2_HOST_CLEANUP_UNCERTAIN'); resolve(); }, 60_000);
          child.once('close', () => { clearTimeout(timeout); resolve(); });
        });
      }
      active = false; lines.close();
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      if (exited !== 0) failure ??= new Error('P2_HOST_CLEANUP_UNCERTAIN');
      if (failure && diagnostics.length) writeFileSync(join(directory, 'p2-private-host-stderr.bin'), diagnostics, { mode: 0o600, flag: 'wx' });
    }
    if (failure) throw failure;
    return result;
  };
}
