import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { p2HostEnvironmentLock } from './p2-release-transport.mjs';
import { P2_CERTIFICATION_PROFILE, P2_CERTIFICATION_RUNTIME_FLAGS, prepareP2CertificationProfile } from './p2-certification-profile.mjs';
import { validateP2HostSettings } from './p2-release.mjs';
import { fileURLToPath } from 'node:url';

// Owned process fixture: actual Python/OS flock and pipe lifetime. It substitutes
// API/provider responses only; actual PG enforcement has a separate harness.
const program = String.raw`
import fcntl,json,os,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline())
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
started=False
receipt={'status':'P2_STAGING_READY_FOR_CERTIFICATION','trafficAuthorized':False}
for raw in sys.stdin:
 p=json.loads(raw); op=p['operation']; v={'id':p['id']}
 if op=='check': v['status']='HELD'
 elif op=='start-api':
  started=True
  if sys.argv[2]=='death': os._exit(31)
  v.update(status='API_READY',receipt={'status':'API_RUNTIME_READY','environment':'staging','releaseId':'owned-p2','trafficAuthorized':False})
 elif op=='frontend-verified': v['status']='FRONTEND_VERIFIED'
 elif op=='prepare-close': v['status']='FRONTEND_CLOSE_PREPARED'
 elif op=='finish': v.update(status='P2_RELEASE_JOINED',receipt=receipt)
 elif op=='commit':
  v.update(status='COMMITTED',receipt=receipt)
  print(json.dumps(v),flush=True); break
 else: os._exit(32)
 print(json.dumps(v),flush=True)
os.close(fd)
`;
function fixture(mode = 'success') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'p2-broker-owned-')));
  const work = join(directory, 'frontend'); mkdirSync(work, { mode: 0o700 });
  const vercel = join(work, 'vercel'); mkdirSync(vercel, { mode: 0o700 });
  const initial = { environment: 'staging', sourceCommit: 'a'.repeat(40), candidate: { releaseId: 'owned-p2' },
    frontendJob: {}, frontendBaseline: {}, targetSha256: 'b'.repeat(64), owner: { name: 'owner', oid: '100' },
    credentials: { test: 'never-in-arguments-or-child-env' } };
  const database = { status: 'DATABASE_VERIFIED', after: [{ hash: 'a'.repeat(64), created_at: '1' }] };
  writeFileSync(join(work, 'database-receipt.json'), JSON.stringify(database) + '\n', { mode: 0o600 });
  writeFileSync(join(vercel, 'frontend-workload-outcome.json'), '{}\n', { mode: 0o600 });
  const lock = join(directory, 'host.lock');
  let args, options;
  const factory = p2HostEnvironmentLock({ knownHosts: '/owned/known-hosts', sshKey: '/owned/key' }, initial, work, {
    launch(executable, command, supplied) {
      args = [executable, ...command]; options = supplied;
      return spawn('python3', ['-I', '-u', '-c', program, lock, mode], supplied);
    },
  });
  const client = { async query(sql) {
    return sql.includes('backend_start') ? { rows: [{ pid: 123, backend_start: 'owned-backend-start' }] } : { rows: [] };
  } };
  return { directory, work, initial, database, factory, client, lock,
    getArgs: () => args, getOptions: () => options, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('fixed P2 profile excludes checkout, member access and native schedule activation', () => {
  assert.deepEqual(prepareP2CertificationProfile(structuredClone(P2_CERTIFICATION_PROFILE)), P2_CERTIFICATION_PROFILE);
  for (const key of Object.keys(P2_CERTIFICATION_PROFILE.featureControls)) {
    const altered = structuredClone(P2_CERTIFICATION_PROFILE); altered.featureControls[key] = !altered.featureControls[key];
    assert.throws(() => prepareP2CertificationProfile(altered));
  }
  assert.throws(() => prepareP2CertificationProfile({ ...P2_CERTIFICATION_PROFILE, nativeSchedulesEnabled: true }));
});

test('Node and fixed host enforce identical closed certification and runtime profiles', () => {
  const python = spawnSync('python3', ['-I', '-c', 'import json,sys;sys.path.insert(0,sys.argv[1]);import p2_certification_profile as p;print(json.dumps([p.PROFILE,p.RUNTIME_FLAGS]))',
    fileURLToPath(new URL('./host/', import.meta.url))], { encoding: 'utf8' });
  assert.equal(python.status, 0); assert.deepEqual(JSON.parse(python.stdout), [P2_CERTIFICATION_PROFILE, P2_CERTIFICATION_RUNTIME_FLAGS]);
});

test('host settings cannot override source, candidate, credentials or staging scope', () => {
  const host = { machineId: 'a'.repeat(32), bundle: '/var/lib/lash-her/releases/staging/owned/bundle',
    configuration: '/var/lib/lash-her/releases/staging/owned/configuration', results: '/var/lib/lash-her/releases/staging/owned/results' };
  assert.deepEqual(validateP2HostSettings(host), host);
  for (const key of ['sourceCommit', 'candidate', 'credentials', 'environment']) assert.throws(() => validateP2HostSettings({ ...host, [key]: 'override' }));
  for (const path of ['/var/lib/lash-her/releases/production/owned', '/var/lib/lash-her/releases/staging/../production',
    '/var/lib/lash-her/releases/staging//owned', '/var/lib/lash-her/releases/staging/./owned', '/private/tmp/owned']) {
    assert.throws(() => validateP2HostSettings({ ...host, bundle: path }));
  }
});

test('actual guardian pipe retains host flock, joins receipts and never places credentials in SSH args/env', async () => {
  const f = fixture();
  try {
    const result = await f.factory(async (verify, signal, runtime) => {
      await verify(); assert.equal(signal.aborted, false);
      const contender = spawnSync('python3', ['-I', '-c', 'import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', f.lock]);
      assert.notEqual(contender.status, 0);
      await runtime.start({ database: f.database, client: f.client, verify });
      await runtime.frontendVerified({}, verify); await runtime.prepareClose(verify);
      const outcome = { status: 'FRONTEND_SQL_COMPATIBLE_DEPLOYMENT_AND_ADMISSION_RESTORED', wholeReleaseAccepted: false };
      writeFileSync(join(f.work, 'job-outcome.json'), '{"status":"DATABASE_VERIFIED"}\n', { mode: 0o600 });
      writeFileSync(join(f.work, 'frontend-release-held.json'), JSON.stringify(outcome) + '\n', { mode: 0o600 });
      await runtime.finish(outcome, verify); return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(JSON.parse(readFileSync(join(f.work, 'p2-host-release-outcome.json'))).status, 'P2_STAGING_READY_FOR_CERTIFICATION');
    assert.match(f.getArgs().at(-1), /sudo.*p2_release_supervisor\.py/u);
    assert.equal(JSON.stringify([f.getArgs(), f.getOptions().env]).includes('never-in-arguments'), false);
  } finally { f.cleanup(); }
});

test('guardian process death during API stage aborts continuation before frontend mutation', async () => {
  const f = fixture('death'); let frontendStarted = false;
  try {
    await assert.rejects(f.factory(async (verify, signal, runtime) => {
      await runtime.start({ database: f.database, client: f.client, verify });
      frontendStarted = true; assert.equal(signal.aborted, false);
    }));
    assert.equal(frontendStarted, false);
    assert.throws(() => readFileSync(join(f.work, 'p2-host-release-outcome.json')));
  } finally { f.cleanup(); }
});

test('missing frontend terminal receipt refuses the parent join without a replay', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.factory(async (verify, _signal, runtime) => {
      await runtime.start({ database: f.database, client: f.client, verify });
      await runtime.frontendVerified({}, verify); await runtime.prepareClose(verify);
      await runtime.finish({ status: 'owned' }, verify);
    }));
    assert.equal(JSON.parse(readFileSync(join(f.work, 'database-receipt.json'))).status, 'DATABASE_VERIFIED');
    assert.throws(() => readFileSync(join(f.work, 'p2-host-release-outcome.json')));
  } finally { f.cleanup(); }
});
