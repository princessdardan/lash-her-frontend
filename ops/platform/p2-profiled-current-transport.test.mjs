import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFrontendReceipt } from './frontend-migration.mjs';
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from './qualification-target-profile.mjs';
import { readP2ProfiledCurrentFrontendReceipt } from './p2-profiled-current-transport.mjs';

// The private launcher is accessed only in a fixture projection. Production
// has no launch/response injector. The child owns a real OS flock and pipes;
// database/provider/runtime responses in this protocol test are models.
const transportSource = readFileSync(new URL('./p2-profiled-current-transport.mjs', import.meta.url), 'utf8')
  .replace(/from '(\.\/[^']+)'/gu, (_, relative) => `from '${new URL(relative, import.meta.url).href}'`);
const { transport } = await import('data:text/javascript;base64,' + Buffer.from(transportSource + '\nexport { transport };\n').toString('base64'));
const program = String.raw`
import base64,fcntl,hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; frontend=root/'frontend'
fd=os.open(root/'lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
p=json.loads(sys.stdin.readline()); phase='locked'; arm=None; probe=None
flags={k:False for k in ('frontendSqlApplied','historicalProviderClosureClaimed','oldP200Qualified','nativeSchedulesEnabled','trafficAuthorized','releaseAccepted')}
base=dict(version=2,qualificationTargetProfile=p['qualificationTargetProfile'],environment='staging',releaseId=p['candidate']['releaseId'],sourceCommit=p['sourceCommit'],candidateSha256=p['candidateSha256'],configurationSha256=p['configurationSha256'],contractPhase='p2',phase2ContractManifestSha256=p['candidate']['phase2ContractManifestSha256'],**flags)
def encode(row): return ('  '+json.dumps(row,separators=(',',':'))+'\n').encode()
def b64(raw): return base64.b64encode(raw).decode()
def reply(i,status,**fields): return dict(id=i,status=status,**fields)
def emit(*rows): print('\n'.join(json.dumps(row,separators=(',',':')) for row in rows),flush=True)
def trace(op):
 with open(root/'trace','a') as f: f.write(op+'\n')
emit(reply(0,'LOCKED'))
for raw in sys.stdin:
 v=json.loads(raw); i=v['id']; op=v['operation']
 if op=='check': emit(reply(i,'HELD'));continue
 trace(op)
 if op=='profiled-current-arm':
  assert phase=='locked' and set(v)=={'id','operation','receipt','continuationStarted','probe'} and not(frontend/'job-outcome.json').exists()
  assert base64.b64decode(v['receipt'])==(frontend/'database-receipt.json').read_bytes()
  assert base64.b64decode(v['continuationStarted'])==(frontend/'frontend-continuation-started.json').read_bytes()
  arm=i;probe=v['probe'];phase='armed'
  if mode=='arm-death': os._exit(31)
  emit(reply(i,'PROFILED_CURRENT_ARMED'))
 elif op=='profiled-current-prepare-prior-gateway':
  assert phase=='armed' and set(v)=={'id','operation'}
  migration=encode(dict(base,status='API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN'))
  ready=dict(base,status='API_RUNTIME_READY',migrationOutcomeSha256=hashlib.sha256(migration).hexdigest())
  runtime=encode(ready if mode!='raw-tamper' else dict(ready,sourceCommit='0'*40))
  prepared=reply(i,'PROFILED_CURRENT_PRIOR_GATEWAY_PREPARED',receipt={'status':'PRIOR_GATEWAY_CLOSED_ZERO'})
  api=reply(arm,'PROFILED_CURRENT_API_READY',receipt=ready,migrationOutcome=b64(migration),runtimeOutcome=b64(runtime))
  emit(api,prepared) if mode=='early-ready' else emit(prepared,api)
  (root/'expected-migration').write_bytes(migration);(root/'expected-runtime').write_bytes(runtime);phase='ready'
 elif op=='profiled-current-frontend-verified':
  assert phase=='ready' and set(v)=={'id','operation','proof','workload'};phase='verified';emit(reply(i,'PROFILED_CURRENT_FRONTEND_VERIFIED'))
 elif op=='profiled-current-prepare-close':
  assert phase=='verified' and set(v)=={'id','operation'} and not(frontend/'job-outcome.json').exists();phase='close';emit(reply(i,'PROFILED_CURRENT_CLOSE_PREPARED'))
  if mode=='close-death': os._exit(32)
 elif op=='profiled-current-session-closed':
  assert phase=='close' and set(v)=={'id','operation'} and (frontend/'job-outcome.json').exists()
  closed=dict(version=2,qualificationTargetProfile=base['qualificationTargetProfile'],environment='staging',releaseId=base['releaseId'],sourceCommit=base['sourceCommit'],targetSha256=p['targetSha256'],status='P2_PROFILED_CURRENT_SESSION_CLOSED',originalBackendPid=probe['backendPid'],originalBackendStart=probe['backendStart'],backendAbsent=True,migrationLockReleased=True,nonceLockReleased=True,admission=dict(epoch='1',newWork=False,recovery=False,active=0,uncertain=0))
  if mode=='close-tamper': closed['originalBackendPid']+=1
  phase='closed';emit(reply(i,'PROFILED_CURRENT_SESSION_CLOSED',receipt=closed))
 elif op=='profiled-current-finish':
  assert phase=='closed' and set(v)=={'id','operation','terminal','continuationCompleted','releaseOutcome'}
  for key,name in (('terminal','job-outcome.json'),('continuationCompleted','frontend-continuation-completed.json'),('releaseOutcome','p2-profiled-current-release-outcome.json')):
   assert base64.b64decode(v[key])==(frontend/name).read_bytes()
  joined=dict(base,status='P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION');phase='joined';emit(reply(i,'PROFILED_CURRENT_JOINED',receipt=joined))
 elif op=='commit':
  assert phase=='joined' and set(v)=={'id','operation'}
  emit(reply(i,'COMMITTED',receipt=joined))
  if mode=='commit-death': os._exit(34)
  break
 else: os._exit(33)
os.close(fd)
`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const falseFlags = Object.fromEntries(['frontendSqlApplied', 'historicalProviderClosureClaimed', 'oldP200Qualified', 'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted'].map(key => [key, false]));

function fixture(mode) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'profile-current-transport-'))), work = join(directory, 'frontend');
  mkdirSync(work, { mode: 0o700 });
  const target = { qualificationTargetProfile: profile, host: 'owned.invalid', port: 5432, database: 'owned', user: 'operator', serverMajor: 16, approvedPendingTags: [] };
  const candidate = { version: 3, qualificationTargetProfile: profile, releaseId: 'owned-current', frontendMigration: { qualificationTargetProfile: profile }, phase2ContractManifestSha256: 'sha256:' + 'c'.repeat(64) };
  const sourceCommit = 'a'.repeat(40), owner = { name: 'admission_owner', oid: '100' };
  const job = { version: 2, qualificationTargetProfile: profile, releaseId: candidate.releaseId, sourceCommit, target, environment: 'staging',
    migrationImageDigest: 'sha256:' + 'b'.repeat(64), sqlArtifactSha256: 'd'.repeat(64), schemaBaselineSha256: 'e'.repeat(64),
    contractManifestSha256: 'sha256:' + 'f'.repeat(64), contractPhase: 'p2', phase2ContractManifestSha256: candidate.phase2ContractManifestSha256 };
  const initial = { version: 2, qualificationTargetProfile: profile, mode: 'p2-profiled-current-release', environment: 'staging', sourceCommit, candidate,
    candidateSha256: 'b'.repeat(64), configurationSha256: { 'runtime.json': 'e'.repeat(64) }, frontendJob: job, frontendBaseline: {}, owner,
    inventory: { qualificationTargetProfile: profile }, targetSha256: 'd'.repeat(64), credentials: { fixture: 'never-in-child-environment-or-arguments' } };
  const base = { ...job, service: 'frontend', migrationMode: 'verify-current-only', trafficAuthorized: false,
    target: Object.fromEntries(['host', 'port', 'database', 'user', 'serverMajor'].map(key => [key, target[key]])) };
  const before = [{ hash: 'a'.repeat(64), created_at: '1' }];
  const receipt = { ...base, status: 'DATABASE_VERIFIED', before, after: before, applied: [], schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: true };
  writeFrontendReceipt(work, 'database-receipt.json', receipt);
  writeFrontendReceipt(work, 'frontend-continuation-started.json', { ...base, status: 'FRONTEND_CONTINUATION_STARTED', databaseVerified: true });
  const migration = { qualificationTargetProfile: profile, candidate, job };
  const probe = { version: 2, qualificationTargetProfile: profile, operation: 'verify-schema', backendPid: 42, backendStart: 'owned-start',
    marker: 'f'.repeat(64), job, receipt, baseline: {}, owner, targetSha256: initial.targetSha256 };
  const lock = transport({ knownHosts: '/owned/known-hosts', sshKey: '/owned/key' }, initial, work, (executable, args, options) => {
    assert.equal(executable, '/usr/bin/ssh'); assert.match(args.at(-1), /p2_profiled_current_parent\.py/u);
    assert(!JSON.stringify([args, options.env]).includes(initial.credentials.fixture));
    return spawn('python3', ['-I', '-u', '-c', program, directory, mode], options);
  });
  const trace = () => readFileSync(join(directory, 'trace'), 'utf8').trim().split('\n');
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  const finish = async (verify, signal, host) => {
    await verify(); assert.equal(signal.aborted, false);
    const record = kind => readP2ProfiledCurrentFrontendReceipt(work, kind, migration).bytes;
    const { apiReady } = await host.armCurrent({ receipt: record('database'), continuationStarted: record('continuation-started'), probe });
    assert.deepEqual(trace(), ['profiled-current-arm']);
    await host.preparePriorGateway(); assert.equal((await apiReady).status, 'API_RUNTIME_READY');
    const workload = Buffer.from(JSON.stringify({ version: 2, qualificationTargetProfile: profile, status: 'FRONTEND_VERIFIED', environment: 'staging',
      releaseId: candidate.releaseId, sourceCommit, contractPhase: 'p2', phase2ContractManifestSha256: candidate.phase2ContractManifestSha256 }) + '\n');
    await host.frontendVerified({ version: 2, qualificationTargetProfile: profile, actionId: candidate.releaseId, sourceCommit, workloadReceiptSha256: hash(workload) }, workload);
    await host.prepareClose();
    await assert.rejects(host.frontendSessionClosed()); // no early caller claim or terminal
    writeFrontendReceipt(work, 'frontend-continuation-completed.json', { ...base, status: 'FRONTEND_CONTINUATION_COMPLETED', databaseVerified: true });
    writeFrontendReceipt(work, 'job-outcome.json', { ...base, status: 'DATABASE_VERIFIED', phase: 'completed', readOnlyVerified: true });
    writeFrontendReceipt(work, 'p2-profiled-current-release-outcome.json', { ...base, status: 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED',
      candidateSha256: initial.candidateSha256, configurationSha256: initial.configurationSha256, ...falseFlags });
    await host.frontendSessionClosed();
    await host.finish({ terminal: record('terminal'), continuationCompleted: record('continuation-completed'),
      releaseOutcome: readFileSync(join(work, 'p2-profiled-current-release-outcome.json')) });
    return 'joined';
  };
  return { directory, work, lock, finish, trace, dispose };
}

test('actual child flock/pipe ordering retains exact API bytes and joins only after late terminal', async () => {
  const f = fixture('success');
  try {
    assert.equal((await f.lock(f.finish)).status, 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION');
    assert.deepEqual(f.trace(), ['profiled-current-arm', 'profiled-current-prepare-prior-gateway', 'profiled-current-frontend-verified',
      'profiled-current-prepare-close', 'profiled-current-session-closed', 'profiled-current-finish', 'commit']);
    for (const name of ['migration', 'runtime']) assert.deepEqual(readFileSync(join(f.directory, `api-${name}-outcome.json`)), readFileSync(join(f.directory, `expected-${name}`)));
    assert.equal(JSON.parse(readFileSync(join(f.work, 'p2-profiled-current-host-outcome.json'))).status, 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION');
    const contender = spawnSync('python3', ['-I', '-c', 'import fcntl,sys;f=open(sys.argv[1]);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', join(f.directory, 'lock')]);
    assert.equal(contender.status, 0);
  } finally { f.dispose(); }
});

for (const mode of ['arm-death', 'early-ready', 'raw-tamper', 'close-death', 'close-tamper']) test(`protocol ${mode} cannot join or commit`, async () => {
  const f = fixture(mode);
  try {
    await assert.rejects(f.lock(f.finish), /FAILED_REQUIRES_REVIEW/u);
    assert(!f.trace().includes('profiled-current-finish')); assert(!f.trace().includes('commit'));
    assert.equal(existsSync(join(f.work, 'p2-profiled-current-host-outcome.json')), false);
  } finally { f.dispose(); }
});

test('commit ACK without a successful guarded child exit never publishes local success', async () => {
  const f = fixture('commit-death');
  try {
    await assert.rejects(f.lock(f.finish), /CLEANUP_UNCERTAIN/u);
    assert(f.trace().includes('commit'));
    assert.equal(existsSync(join(f.work, 'p2-profiled-current-host-outcome.json')), false);
  } finally { f.dispose(); }
});
