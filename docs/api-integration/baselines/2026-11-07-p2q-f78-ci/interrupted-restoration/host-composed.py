"""Fixed C source path with projected Docker and provider transports."""
import base64
from contextlib import ExitStack
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

SOURCE = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(SOURCE / 'ops/platform/host'))
import migrate
import p2_certification_parent as cert
import p2_known_ack_interrupted_restoration_test as retained_test
import p2_profiled_known_ack_restoration_parent as host
import p2_profiled_known_ack_runtime as kernel
import p2_prior_gateway as prior
import release
from p2_source_closure import CERTIFICATION_OBSERVER

def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()

def command_projection(fixture, broker, stages):
    b = fixture.fixture
    def run(args, **options):
        b.calls.append(args)
        if args[1:3] == ['rm', '--force'] or args[1:3] == ['container', 'ls'] and any('name=^/' in value for value in args):
            value = ''
        elif '/check/input/current.mjs' in args:
            service = next(name for name in ('course', 'community') if any('api-check-'+name+'-' in arg for arg in args))
            job = broker.jobs[service]['job']
            assert options['input'] and args[2:4] == ['--rm','--pull']
            value = {**b.fields,**migrate.contract_identity(broker.selected),
                'status':'CURRENT_API_DATABASE_READ_ONLY_PASS','environment':'staging','service':broker.jobs[service]['service'],
                'checks':['selected-image-operator-role-policy'],'migrationsExecuted':False,'pendingTags':[],
                'appliedCount':22 if service=='course' else 11,
                'transportVerifier':'selected-image/hasVerifiedMigrationTransport','checkerSha256':broker.initial['sourceSha256'][cert.API_CHECKER],
                'manifestSha256':broker.initial['apiJobSha256'][service],
                'schemaBaselineSha256':job['schemaBaselineSha256'],'artifactSha256':job['target']['artifactSha256'],
                'target':{key:job['target'][key] for key in ('host','port','database','user','serverMajor')}}
        elif '/app/p2-known-ack-loss-probe.mjs' in args:
            payload = json.loads(options['input']); service = payload['service']
            value = copy.deepcopy(b.current[service])
            value.update(version=1,status='P2_KNOWN_ACK_SQL_CURRENT',service=service,
                         commandId=payload['commandId'],readOnly=True)
            if service != 'frontend':
                value['backend']['deadline'] = payload['backendDeadline']
                value['roleOid'] = b.receiver_targets[service]['roleOid']
        elif 'up' in args:
            stage = tuple(args[args.index('90') + 1:])
            boundary = broker.runtime_transition.scope.boundary
            assert stage == boundary.stage_active
            if stage == ('gateway',):
                assert prior._read_lineage()['state'] == 'replacement-in-progress'
                assert (boundary.output / kernel.GATEWAY_INTENT).is_file()
            stages.append(stage)
            for service in stage:
                b.model[service] = [b.metadata(service, 5000 + release.SERVICES.index(service), boundary.snapshot)]
            value = ''
        else:
            value = retained_test.b.KnownTransitionTests.docker(b, args)
        raw = value if isinstance(value, str) else compact(value).decode()
        return subprocess.CompletedProcess(args,0,stdout=raw if options.get('text') else raw.encode(),
                                           stderr='' if options.get('text') else b'')
    return run

def run(frontier):
    fixture = retained_test.ProfiledRetainedChainTests()
    original = retained_test.b.fixture
    def wire_fixture():
        plan, baseline, domain, gateway, effects = original()
        for snapshot in (baseline, domain):
            for service, value in snapshot.items():
                value.update(version=1,status='P2_KNOWN_ACK_SQL_CURRENT',service=service,
                    commandId=plan['nativePlan']['commandWitnesses'][0]['commandId'],readOnly=True)
                if service != 'frontend':
                    value['roleOid'] = '456'
        return plan, baseline, domain, gateway, effects
    with patch.object(retained_test.b,'fixture',wire_fixture):
        fixture.setUp()
    try:
        return exercise(fixture, frontier)
    finally:
        fixture.doCleanups()

def exercise(fixture, frontier):
    b = fixture.fixture
    if frontier == 'replacement-stopped-zero':
        fixture.component.restore()
    fixture.stop()
    for rows in b.model.values():
        for row in rows:
            row['State'].update(Running=False, Pid=0)
    fixture.refresh_pins()
    original = fixture.load()
    assert original['frontier'] == frontier
    initial = {**fixture.initial,'restorationActionId':'new-profiled-c','sourceCommit':fixture.source_commit,
        'credentials':dict.fromkeys((host.FRONTEND_CREDENTIAL,*host.API_CREDENTIALS.values()),'owned-transport-projection'),
        'sourceSha256':{name:migrate.file_hash(migrate.read_input(SOURCE,name)) for name in
            (CERTIFICATION_OBSERVER,cert.API_CHECKER,host.interrupted.known.MODULE)},
        'owner':b.scope.receipt['owner'],'inventory':{'historicalLogins':{
            **b.fields,'retiredLogins':[],'target':b.scope.receipt['target']},'producers':[]}}
    receipt=copy.deepcopy(b.scope.receipt)
    plan={**copy.deepcopy(b.scope.certification_plan),'mode':host.MODE,'startState':'already-closed',
        'certificationActionId':initial['restorationActionId'],'initialEpoch':'4','apiJobSha256':initial['apiJobSha256']}
    plan['planSha256'] = cert._profiled_plan_hash(plan)
    receipt.update(certificationActionId=initial['restorationActionId'],planSha256=plan['planSha256'],
        admission={'epoch':'4','newWork':False,'recovery':False,'active':0,'uncertain':0})
    probe={**b.fields,'marker':'f'*64,'backendPid':751,'backendStart':'2026-11-06 02:00:00.001+00',
        'job':fixture.jobs['frontend']['job'],'baseline':json.loads(fixture.jobs['frontend']['schema']),
        'owner':initial['owner'],'historicalLogins':initial['inventory']['historicalLogins'],'producers':[],'plan':plan,'receipt':receipt}
    output=[];safety=[];stages=[];physical=[];lease_closed=False
    broker=host.P2ProfiledInterruptedKnownAckBroker(initial,output.append,
        observer_type=cert.P2CertificationPhysicalObserver,observer_source=CERTIFICATION_OBSERVER)
    broker.source, broker.bundle, broker.configuration, broker.results = SOURCE, b.broker.bundle, original['inputDirectory'], fixture.root
    broker.selected, broker.jobs, broker.retained, broker.plan = fixture.selected, fixture.jobs, original, {'frontendPlan':plan}
    broker.directory=fixture.root / (host.ACTION_PREFIX+broker.action_id())
    broker.directory.mkdir(mode=0o700)
    broker.guard_arm_verified=broker.runtime_attempted=False
    broker.reader=broker.authority=broker.armed_probe=broker.prepared_terminal=broker.runtime_transition=None
    broker.observer_program=SOURCE / CERTIFICATION_OBSERVER
    broker.vercel=object()
    lock=fixture.root/'new-owned-flock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
    broker.lock_fd=fd
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def check():
        assert not broker.failed.is_set()
        assert lock.stat().st_ino == os.fstat(fd).st_ino
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if broker.observer and broker.closing_at is None:
            broker.observer.verify()
    def probe_transport(observer, operation):
        assert lease_closed == (operation == 'verify-closed')
        physical.append(operation)
        value={**b.fields,'environment':'staging','releaseId':fixture.selected['releaseId'],
            'sourceCommit':probe['job']['sourceCommit'],'targetSha256':plan['targetSha256'],
            **{key:probe[key] for key in ('marker','backendPid','backendStart')},'admission':receipt['admission'],
            'journalSha256':receipt['journalSha256'],'witnessSha256':receipt['witnessSha256'],
            'status':'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' if lease_closed else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED'}
        if lease_closed:value.update(backendAbsent=True,migrationLockReleased=True,nonceLockReleased=True)
        if operation == 'witness':value['witness']=receipt['witness']
        return observer._profiled_result(compact(value), operation)
    def gateway(*_args, **kwargs):
        assert kwargs['expected_profile'] == b.profile
        row=b.model['gateway'][0]
        configuration=Path(next(mount['Source'] for mount in row['Mounts'] if mount['Destination']=='/admission')).parent
        binding=prior._reference(initial,fixture.selected,configuration,row['Id'],expected_profile=b.profile)
        return {'status':'PRIOR_GATEWAY_OBSERVED','process':host.interrupted.known.KnownAckLossBoundary._public_process(row),
            'binding':binding,'admission':{'newWork':False,'recovery':False,'active':{'newWork':0,'recovery':0},
            'uncertain':{'newWork':0,'recovery':0},'sha256':'1'*64}}
    def command(operation, **fields):
        broker.command({'id':len(output)+1,'operation':operation,**fields})
        return output[-1]
    projected_run=command_projection(fixture,broker,stages)
    try:
        with ExitStack() as stack:
            for projection in (
                patch.object(host,'LOCK',lock),
                patch.object(broker,'check',check),patch.object(broker,'safety',safety.append),
                patch.object(broker,'_accept_guard_arm',lambda _:setattr(broker,'guard_arm_verified',True)),
                patch.object(cert.P2CertificationPhysicalObserver,'probe',probe_transport),
                patch.object(cert.P2CertificationScope,'run',lambda scope,*args,**options:projected_run(*args,**options)),
                patch.object(host.native,'observe_metadata',return_value={'nativeEnabled':False}),
                patch.object(prior,'observe_prior_gateway',side_effect=gateway),
            ):
                stack.enter_context(projection)
            arm=command('arm-interrupted-restoration',probe=probe,receipt=base64.b64encode(compact(receipt)).decode())
            assert arm['status']=='INTERRUPTED_RESTORATION_ARMED' and arm['receipt']['authorityIssued'] is False
            assert not stages
            command('prepare-interrupted-restoration')
            ready=command('restore-runtime')['receipt']
            assert stages==list(release.STAGES)
            assert ready['frontier']==frontier and ready['runtimeReplacements']==1
            assert ready['sqlReplayed'] is ready['trafficAuthorized'] is False
            assert ready['stoppedGateway']['process']['running'] is False
            assert ready['newGateway']['process']['containerId']!=ready['stoppedGateway']['process']['containerId']
            assert ready['newGateway']['admission']['uncertain']=={'newWork':0,'recovery':0}
            assert ready['stoppedGateway']['admission']['uncertain']['recovery']==(frontier=='original-stopped-one')
            assert command('prepare-close')['receipt']==ready
            assert not (broker.directory/host.TERMINAL).exists()
            lease_closed=True
            assert command('finish',restoration=base64.b64encode(compact(ready)).decode())['receipt']==ready
            assert not (broker.directory/host.TERMINAL).exists()
            assert command('commit')['receipt']==ready
            assert (broker.directory/host.TERMINAL).is_file()
            assert physical[-1]=='verify-closed'
            assert not (fixture.cert/'p2-profiled-current-certification-outcome.json').exists()
            return {'frontier':frontier,'actualTypedHostBrokerAndRuntime':True,'actualHostFlock':True,
                'projectedPhysicalAndDatabaseTransport':True,'actualDocker':False,'providerTouched':False,
                'fiveStages':len(stages),'tenServices':len(ready['containers']),
                'statuses':[row['status'] for row in output],'physicalProbes':physical,
                'newZero':True,'oldCounterRetained':True,'trafficAuthorized':False}
    finally:
        if broker.observer:
            broker.observer.stop()
        os.close(fd)

if __name__=='__main__':
    cases = sys.argv[2:] or ['original-stopped-one','replacement-stopped-zero']
    print(json.dumps({'version':1,'status':'PROFILED_C_HOST_PROJECTED_PASS','cases':[run(case) for case in cases]}))
