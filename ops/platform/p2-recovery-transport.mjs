// The operator's Node process retains the frontend PG session; this fixed SSH
// child retains the actual selected Linux host flock and API continuation.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sshCommand } from './recreation_ssh.mjs';
import { readFrontendReleaseEvidence } from './frontend-release-receipts.mjs';
import { writeFrontendReceipt } from './frontend-migration.mjs';

const require = ok => { if (!ok) throw new Error('P2_HOST_RELEASE_TRANSPORT_REFUSED'); };
const MAXIMUM = 4_000_000;
export function p2RecoveryEnvironmentLock(settings, initial, directory, { launch = spawn } = {}) {
  require(/^[a-f0-9]{40}$/u.test(initial.sourceCommit) && initial.environment === 'staging');
  const remote = ['sudo', '-n', '/usr/bin/python3', '-I', '-u',
    `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_recovery_supervisor.py`];
  return async task => {
    const child = launch('/usr/bin/ssh', sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote), {
      stdio: ['pipe', 'pipe', 'pipe'], env: Object.fromEntries(['PATH', 'HOME', 'LANG'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
    });
    const signal = new AbortController(), pending = new Map();
    let sequence = 0, failed = false, exited, active = true, armed = false, priorGatewayPrepared = false, diagnostics = Buffer.alloc(0), heartbeat, apiStarted = false, preparedClose = false, joined;
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
        mode: 'p2-post-sql-recovery', recoveryActionId: initial.recoveryActionId,
        async preparePriorGateway({ verify }) {
          require(!armed && !apiStarted && !priorGatewayPrepared); await verify();
          const result = await request('prepare-prior-gateway','PRIOR_GATEWAY_PREPARED',{},300_000);
          require(result.receipt?.status === 'PRIOR_GATEWAY_CLOSED_ZERO');
          await verify(); priorGatewayPrepared=true;
        },
        async armRecovery({ receipt, probe }) {
          require(priorGatewayPrepared&&!armed&&!apiStarted);await verifyEnvironment();
          const raw=readFrontendReleaseEvidence(directory,'p2-recovery-current-database.json');require(JSON.stringify(JSON.parse(raw))===JSON.stringify(receipt));
          await request('arm-recovery','RECOVERY_ARMED',{receipt:raw.toString('base64'),probe});armed=true;
        },
        async restoreCurrent({ receipt, probe }) {
          require(armed&&!apiStarted); await verifyEnvironment(); apiStarted = true;
          const raw = readFrontendReleaseEvidence(directory, 'p2-recovery-current-database.json');
          require(JSON.stringify(JSON.parse(raw)) === JSON.stringify(receipt));
          const result = await request('start-api','API_READY',{ receipt: raw.toString('base64'), probe }, 600_000);
          require(result.receipt?.status === 'P2_RECOVERY_API_RUNTIME_READY'); return result.receipt;
        },
        async frontendVerified(observed,selectedWorkload) {
          require(apiStarted && !preparedClose); await verifyEnvironment();
          const proof = Object.fromEntries(Object.entries(observed).filter(([key]) => !['evidence','evidenceSha256'].includes(key)));
          if(initial.frontendMode==='reviewed-new-build')require(Buffer.isBuffer(selectedWorkload));
          const workload=selectedWorkload??readFrontendReleaseEvidence(join(settings.originalDirectory,'vercel'),'frontend-workload-outcome.json');
          require(Buffer.isBuffer(workload)&&workload.length>0&&workload.length<=2_000_000&&createHash('sha256').update(workload).digest('hex')===proof.workloadReceiptSha256);
          await request('frontend-verified','FRONTEND_VERIFIED',{ proof, workload: workload.toString('base64') });
        },
        async restoreGatewayStage(stage, admission) {
          require(apiStarted && !preparedClose); await verifyEnvironment();
          return request('recovery-gateway-stage','GATEWAY_STAGE_VERIFIED',{ stage, flags: { newWork: admission.newWork, recovery: admission.recovery } });
        },
        async observeGateway() { return (await request('observe-gateway','GATEWAY_OBSERVED')).gateway; },
        async prepareClose(verify) {
          require(apiStarted && !preparedClose); await verify(); await request('prepare-close','FRONTEND_CLOSE_PREPARED'); preparedClose=true;
        },
        async finish(outcome, verifyEnvironmentOnly) {
          require(preparedClose); await verifyEnvironmentOnly();
          const raw = readFrontendReleaseEvidence(directory,'p2-recovery-outcome.json');
          require(JSON.stringify(JSON.parse(raw)) === JSON.stringify(outcome));
          joined = await request('finish','P2_RECOVERY_JOINED',{ recovery: raw.toString('base64') });
          require(joined.receipt?.status === 'P2_STAGING_RECOVERY_RESTORATION_VERIFIED');
        },
        async failClosed() { fail(); return { frontendAdmissionClosed: null, gatewayAdmissionClosed: null, runtimeStopped: null }; },
      };
      await verifyEnvironment(); result = await task(verifyEnvironment, signal.signal, runtime); await verifyEnvironment();
      require(joined && !failed);
      const committed = await request('commit', 'COMMITTED');
      require(JSON.stringify(committed.receipt) === JSON.stringify(joined.receipt));
      writeFrontendReceipt(directory, 'p2-host-recovery-outcome.json', committed.receipt);
      active = false;
    } catch { failure = new Error('P2_RECOVERY_FAILED_REQUIRES_REVIEW'); fail(); }
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
