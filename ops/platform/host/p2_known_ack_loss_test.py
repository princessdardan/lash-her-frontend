"""Source state/opaque-authority regressions; actual three-DB fixture is separate."""
import base64
import copy
import fcntl
import json
import shutil
import threading
import os
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from unittest.mock import patch
import migrate
import current_databases
import staging_state
import p2_certification_parent as parent
import p2_certification_parent_test as cert_fixture
import p2_release_scope_test as scope_fixture
import p2_prior_gateway as prior
import p2_prior_gateway_test as prior_fixture
import release_test
import unittest
from unittest.mock import Mock
import p2_known_ack_loss as source


def fixture():
    command='00000000-0000-4000-8000-000000000001'
    plan={'receiver':'course','commandSha256':'a'*64,'nativePlan':{'initialEpoch':'2','sourceCommit':'b'*40,
        'producer':{'producerSha256':'c'*64,'role':{'oid':'123'}},'commandWitnesses':[{'commandId':command,'accountVersion':'1','action':'suspend'}]}}
    deliveries=[{'command_id':command,'receiver':name,'status':'pending','attempts':0,'lease_id':None,'lease_until':None,'acknowledged_at':None,'ready':True} for name in ('community','course')]
    front={'commandId':command,'accountVersion':'1','accountStatus':'suspended','commandSha256':'a'*64,'userBindingSha256':'d'*64,
        'exports':0,'later':0,'operations':[],'deliveries':copy.deepcopy(deliveries),'outstanding':copy.deepcopy(deliveries),
        'admission':{'epoch':'2','newWork':False,'recovery':True,'active':0,'uncertain':0}}
    baseline={'frontend':front,'course':{'command':None},'community':{'command':None}}
    for service,fields,projections in [('course',('outbox','snapshots','media','exports','retention'),('control','outbox','operations','snapshots','snapshotItems','streams','media','exports','lifecycleCommands','lifecycleStates')),
            ('community',('repairs','reconciliations','exports','reconciliationSchedule','retentionSchedule'),('repairs','reconciliations','operations','projections','inbox','tombstones','baselines','sourceItems','exports','lifecycleCommands','lifecycleStates'))]:
        baseline[service]['backend']={'version':1,'status':'P2_KNOWN_ACK_BACKEND_OBSERVED','deadline':'2026-11-06T01:15:00.000Z',
            'eligible':dict.fromkeys(fields,0),'rowCounts':dict.fromkeys(projections,0),'snapshotSha256':'a'*64,'selectedLifecycleCommand':None,'selectedLifecycleState':None}
    domain=copy.deepcopy(baseline);front=domain['frontend'];front['admission'].update(epoch='3',uncertain=1);front['outstanding']=[]
    for row in front['deliveries']:
        row.update(status='acknowledged',attempts=2 if row['receiver']=='course' else 1,acknowledged_at='2026-11-06T01:00:03.000Z')
    front['operations']=[{'id':name,'epoch':'3','kind':'recovery','producer_sha256':'c'*64,'source_sha':'b'*40,'role_oid':'123',
        'state':state,'started_at':started,'completed_at':None if state=='uncertain' else '2026-11-06T01:00:04.000Z','reconciliation_sha256':None}
        for name,state,started in [('00000000-0000-4000-8000-000000000002','uncertain','2026-11-06T01:00:00.000Z'),
            ('00000000-0000-4000-8000-000000000003','completed','2026-11-06T01:00:02.000Z')]]
    for name in ('course','community'):
        domain[name]['command']={'userBindingSha256':'d'*64,'accountVersion':'1','commandSha256':'a'*64,'acceptedAt':'2026-11-06T01:00:01.000Z','accountStatus':'suspended'}
        domain[name]['backend']['selectedLifecycleCommand']={'commandId':command,'userBindingSha256':'d'*64,'accountVersion':'1','action':'suspend','commandSha256':'a'*64,'acceptedAt':'2026-11-06T01:00:01.000Z'}
        domain[name]['backend']['selectedLifecycleState']={'userBindingSha256':'d'*64,'accountVersion':'1','status':'suspended','updatedAt':'2026-11-06T01:00:01.000Z'}
    gateway={'admission':{'newWork':False,'recovery':True,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':1}}}
    effect={'mode':'drop-after-ack','receiver':'course','sourceWitnessSha256':'a'*64,'upstreamReceiptVerified':True,
        'upstreamStarted':True,'upstreamStatus':200,'downstreamBytesStarted':False,'downstreamDisposition':'dropped-before-any-response-bytes'}
    return plan,baseline,domain,gateway,[effect]


class KnownAckSourceTests(unittest.TestCase):
    def test_fixed_ephemeral_runtime_observer_is_independent_of_recreated_api_and_keeps_credentials_private(self):
        recorder=source.P2KnownAckLossRecorder.__new__(source.P2KnownAckLossRecorder)
        recorder._verify=lambda:None;recorder.command={'commandId':'00000000-0000-4000-8000-000000000001','accountVersion':'1'}
        recorder.plan={'commandSha256':'a'*64};recorder.window_epoch='3';recorder.backend_deadline='2026-11-06T01:15:00.000Z'
        recorder.receiver_targets={'course':{'host':'owned.invalid','port':5432,'database':'owned','user':'runtime','serverMajor':18,'roleOid':'123'}}
        calls=[]
        def run(args,**kwargs):
            calls.append((args,kwargs));return subprocess.CompletedProcess(args,0,stdout=json.dumps({'status':'P2_KNOWN_ACK_SQL_CURRENT','service':'course','readOnly':True}).encode(),stderr=b'')
        recorder.scope=Mock();recorder.scope.run=run
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'course-api.env').write_text('private-test-input')
            recorder.configuration_input=root
            recorder.broker=Mock(source=root,jobs={},selected={'artifacts':{'courseRuntime':{'image':'registry.invalid/course@sha256:'+'b'*64}}})
            private='postgresql://runtime:owned-private-password@owned.invalid/owned?sslmode=verify-full'
            with patch.object(source.runtime,'environment_values',return_value={'STAGING_DATABASE_URL':private}):recorder._sql('course','d'*64)
        args,options=calls[0]
        self.assertEqual(args[:2],['docker','run']);self.assertIn('--read-only',args);self.assertIn('--network',args)
        self.assertIn('registry.invalid/course@sha256:'+'b'*64,args);self.assertNotIn(private,' '.join(args))
        self.assertEqual(options['env'],{**source.runtime.SAFE_ENV,'STAGING_DATABASE_URL':private})
        self.assertEqual(json.loads(options['input'])['backendDeadline'],recorder.backend_deadline)
        self.assertTrue(args[args.index('--name')+1].startswith('lash-p2-certification-observer-'))
        self.assertEqual(calls[-1][0][:3],['docker','rm','--force'])

    def test_backend_work_or_completed_effect_drift_refuses_before_fault_and_settlement(self):
        plan,baseline,domain,gateway,effects=fixture();source.validate_backend_idle(domain,baseline)
        for service in ('course','community'):
            for key in baseline[service]['backend']['eligible']:
                bad=copy.deepcopy(baseline);bad[service]['backend']['eligible'][key]=1
                with self.subTest(service=service,key=key),self.assertRaisesRegex(ValueError,'BACKEND_WORK'):
                    source.validate_baseline(plan,bad)
                bad=copy.deepcopy(domain);bad[service]['backend']['snapshotSha256']='f'*64
                with self.subTest(service=service,key='completed-projection'),self.assertRaisesRegex(ValueError,'PROJECTION_CHANGED'):
                    source.validate_domain(plan,baseline,bad,gateway,effects)

    def test_only_exact_selected_lifecycle_source_transition_can_be_normalized(self):
        plan,baseline,domain,gateway,effects=fixture();source.validate_domain(plan,baseline,domain,gateway,effects)
        for kind in ('missing-command','other-user','other-version','mutable-timestamp','premature-state'):
            actual=copy.deepcopy(domain)
            if kind=='missing-command':actual['course']['backend']['selectedLifecycleCommand']=None
            elif kind=='other-user':actual['course']['backend']['selectedLifecycleCommand']['userBindingSha256']='f'*64
            elif kind=='other-version':actual['course']['backend']['selectedLifecycleState']['accountVersion']='2'
            elif kind=='mutable-timestamp':actual['course']['backend']['selectedLifecycleState']['updatedAt']='2026-11-06T01:00:05.000Z'
            else:
                actual=copy.deepcopy(baseline);actual['course']['backend']['selectedLifecycleState']={'userBindingSha256':'d'*64,'accountVersion':'1','status':'suspended','updatedAt':'2026-11-06T01:00:01.000Z'}
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_backend_idle(actual,baseline)

    def test_two_untouched_pending_deliveries_are_required_before_fault(self):
        plan,baseline,_,_,_=fixture();source.validate_baseline(plan,baseline)
        for field,value in [('attempts',1),('status','delivering'),('lease_id','owned-lease'),('acknowledged_at','2026-11-06T00:00:00.000Z'),('ready',False)]:
            bad=copy.deepcopy(baseline);bad['frontend']['outstanding'][0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):source.validate_baseline(plan,bad)
        bad=copy.deepcopy(baseline);bad['course']['command']={'acceptedAt':'already-accepted'}
        with self.assertRaises(ValueError):source.validate_baseline(plan,bad)

    def test_exact_drop_and_normal_replay_domain_proof_preserves_original_one(self):
        plan,baseline,domain,gateway,effects=fixture()
        self.assertEqual(source.validate_domain(plan,baseline,domain,gateway,effects),{'operationId':domain['frontend']['operations'][0]['id']})
        self.assertEqual(domain['frontend']['admission']['uncertain'],1)
        self.assertEqual(gateway['admission']['uncertain'],{'newWork':0,'recovery':1})
        closed=copy.deepcopy(domain);closed['frontend']['admission'].update(epoch='4',recovery=False)
        after=copy.deepcopy(gateway);after['admission']['recovery']=False
        self.assertIsNotNone(source.validate_domain(plan,baseline,closed,after,effects,closed=True))

    def test_active_same_source_operation_is_pending_and_can_never_authorize_settlement(self):
        plan,baseline,domain,gateway,effects=fixture()
        domain['frontend']['operations'][1].update(state='active',completed_at=None);domain['frontend']['admission']['active']=1
        gateway['admission']['active']['recovery']=1
        self.assertIsNone(source.validate_domain(plan,baseline,domain,gateway,effects))
        domain['frontend']['operations'][1]['source_sha']='f'*40
        with self.assertRaisesRegex(ValueError,'UNRELATED_OPERATION'):source.validate_domain(plan,baseline,domain,gateway,effects)

    def test_extra_effect_work_global_uncertainty_command_and_receiver_drift_refuse(self):
        for kind in ('effect','export','later','global','gateway','producer','command','version','attempt','receiver'):
            plan,baseline,domain,gateway,effects=fixture();front=domain['frontend']
            if kind=='effect':effects+=effects
            elif kind=='export':front['exports']=1
            elif kind=='later':front['later']=1
            elif kind=='global':front['admission']['uncertain']=2
            elif kind=='gateway':gateway['admission']['uncertain']['recovery']=2
            elif kind=='producer':front['operations'][0]['producer_sha256']='f'*64
            elif kind=='command':front['commandSha256']='f'*64
            elif kind=='version':front['accountVersion']='2'
            elif kind=='attempt':front['deliveries'][1]['attempts']=3
            elif kind=='receiver':domain['course']['command']['commandSha256']='f'*64
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_domain(plan,baseline,domain,gateway,effects)

    def test_every_request_must_join_exact_uncertain503_and_completed200_operation(self):
        plan,_,domain,_,_=fixture();operations=domain['frontend']['operations']
        artifact={'observations':[{'admittedLogLine':json.dumps({'operationId':row['id']}),'httpStatus':503 if row['state']=='uncertain' else 200} for row in operations]}
        source.validate_request_operations(plan,artifact,operations)
        for kind in ('missing','unknown','swapped','unadmitted','duplicate'):
            changed=copy.deepcopy(artifact)
            if kind=='missing':changed['observations'].pop()
            elif kind=='unknown':changed['observations'][0]['admittedLogLine']=json.dumps({'operationId':'unknown'})
            elif kind=='swapped':changed['observations'][0]['httpStatus']=200
            elif kind=='unadmitted':changed['observations'][0]['admittedLogLine']=None
            elif kind=='duplicate':changed['observations'][1]=changed['observations'][0]
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_request_operations(plan,changed,operations)

    def test_opaque_authorization_is_same_scope_action_fresh_and_once_only(self):
        scope=object();recorder=Mock();recorder.scope=scope
        with self.assertRaises(ValueError):source.KnownAckLossRecoveryAuthorization(object(),recorder,{})
        value=source.KnownAckLossRecoveryAuthorization(source._ISSUER,recorder,{'recoveryActionId':'owned-replacement'})
        for changed,selected,action in [({'recoveryActionId':'owned-replacement'},scope,'owned-replacement'),(copy.copy(value),scope,'owned-replacement'),
            (value,object(),'owned-replacement'),(value,scope,'wrong-action')]:
            with self.assertRaises(ValueError):source.require_known_ack_loss_authorization(changed,selected,action)
        source.require_known_ack_loss_authorization(value,scope,'owned-replacement');recorder._verify_authorization.assert_called_once()
        source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        with self.assertRaises(ValueError):source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        with self.assertRaises(ValueError):source.require_known_ack_loss_authorization(copy.copy(value),scope,'owned-replacement')

    def test_source_constructor_rejects_json_and_foreign_parent_before_io(self):
        for broker in ({'mode':'known-ack-recovery'},object(),Mock()):
            with self.assertRaises(ValueError):source.P2KnownAckLossRecorder(broker,'owned-replacement',{})

    def test_concurrent_consumption_reserves_before_verifier_io(self):
        scope=object();entered=threading.Event();release=threading.Event();results=[]
        recorder=Mock();recorder.scope=scope
        def verify(_):entered.set();self.assertTrue(release.wait(2))
        recorder._verify_authorization.side_effect=verify
        value=source.KnownAckLossRecoveryAuthorization(source._ISSUER,recorder,{'recoveryActionId':'owned-replacement'})
        def consume():
            try:source.consume_known_ack_loss_authorization(value,scope,'owned-replacement');results.append('accepted')
            except ValueError:results.append('refused')
        first=threading.Thread(target=consume);first.start();self.assertTrue(entered.wait(1))
        second=threading.Thread(target=consume);second.start();second.join(1)
        self.assertFalse(second.is_alive());self.assertEqual(results,['refused'])
        release.set();first.join(1);self.assertFalse(first.is_alive());self.assertCountEqual(results,['accepted','refused'])
        recorder._verify_authorization.assert_called_once()

    def test_failed_verification_poisons_consumption_and_cannot_retry(self):
        scope=object();recorder=Mock();recorder.scope=scope;recorder._verify_authorization.side_effect=ValueError('ACTUAL_SCOPE_LOST')
        value=source.KnownAckLossRecoveryAuthorization(source._ISSUER,recorder,{'recoveryActionId':'owned-replacement'})
        with self.assertRaisesRegex(ValueError,'ACTUAL_SCOPE_LOST'):source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        with self.assertRaisesRegex(ValueError,'OPAQUE_AUTHORIZATION'):source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        recorder._verify_authorization.assert_called_once()

    def test_extra_completed_request_before_settlement_refuses_all_authority_boundaries(self):
        plan,baseline,domain,gateway,effects=fixture();extra=copy.deepcopy(domain['frontend']['operations'][1])
        extra['id']='00000000-0000-4000-8000-000000000099';domain['frontend']['operations'].append(extra)
        with self.assertRaises(ValueError):source.validate_domain(plan,baseline,domain,gateway,effects)
        observations={'observations':[{'admittedLogLine':json.dumps({'operationId':row['id']}),'httpStatus':503 if row['state']=='uncertain' else 200} for row in domain['frontend']['operations']]}
        with self.assertRaises(ValueError):source.validate_request_operations(plan,observations,domain['frontend']['operations'])
        domain['frontend']['admission'].update(recovery=False,epoch='4');actual=copy.deepcopy(domain)
        actual['frontend']['admission']['uncertain']=0;actual['frontend']['operations'][0].update(state='completed',completed_at='2026-11-06T01:00:06.000Z',reconciliation_sha256='e'*64)
        with self.assertRaises(ValueError):source.validate_settled(plan,domain,actual,domain['frontend']['operations'][0]['id'],'e'*64)

    def test_specific_settlement_cannot_hide_new_completed_operations_or_other_changed_receipts(self):
        plan,_,before,_,_=fixture();before['frontend']['admission'].update(epoch='4',recovery=False)
        after=copy.deepcopy(before);operation_id=before['frontend']['operations'][0]['id']
        after['frontend']['admission']['uncertain']=0
        after['frontend']['operations'][0].update(state='completed',completed_at='2026-11-06T01:00:06.000Z',reconciliation_sha256='e'*64)
        source.validate_settled(plan,before,after,operation_id,'e'*64)
        for kind in ('new-completed','other-reconciliation','wrong-reconciliation','new-epoch','receiver'):
            actual=copy.deepcopy(after)
            if kind=='new-completed':
                extra=copy.deepcopy(actual['frontend']['operations'][1]);extra['id']='00000000-0000-4000-8000-000000000099';actual['frontend']['operations'].append(extra)
            elif kind=='other-reconciliation':actual['frontend']['operations'][1]['reconciliation_sha256']='e'*64
            elif kind=='wrong-reconciliation':actual['frontend']['operations'][0]['reconciliation_sha256']='f'*64
            elif kind=='new-epoch':actual['frontend']['admission']['epoch']='5'
            elif kind=='receiver':actual['community']['command']['acceptedAt']='2026-11-06T01:00:09.000Z'
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_settled(plan,before,actual,operation_id,'e'*64)


class ProfiledKnownAckSourceTests(unittest.TestCase):
    """Actual source types, flock, configuration, and bytes with projected I/O."""

    def setUp(self):
        runtime=release_test.RuntimeReleaseTests();runtime.setUp();self.addCleanup(runtime.tearDown)
        root=runtime.root.resolve();bundle=runtime.bundle.resolve();configuration=runtime.configuration.resolve()
        source_root=Path(source.__file__).resolve().parents[3]
        runtime.compose.write_bytes(migrate.read_input(source_root,'ops/platform/compose.yaml'))
        runtime.fixture.release['runtime']['composeSha256']='sha256:'+source.digest(runtime.compose.read_bytes())
        runtime.fixture.add_frontend()
        pair={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'e'*64}
        for carrier in (runtime.fixture.release,runtime.fixture.release['frontendMigration'],*runtime.fixture.jobs.values()):
            carrier.update(pair)
        for name in ('course','community'):
            runtime.fixture.jobs[name]['target']['serverMajor']=18
        runtime.fixture.jobs['frontend']['target'].update(approvedPendingTags=[],allowEmptyBootstrap=False)
        self.profile=runtime.fixture.profiled();self.fields={'version':2,'qualificationTargetProfile':self.profile}
        runtime.target.update(self.fields)
        runtime.gateway.update(ownerId=parent.vercel.TEAM,projectId=parent.vercel.PROJECTS['staging'],publicHost='api-staging.lashher.com')
        self.candidate_file=bundle/'release.candidate.json';self.candidate_raw=(json.dumps(runtime.fixture.release,indent=2)+'\n').encode()
        self.candidate_file.write_bytes(self.candidate_raw);candidate_sha=source.digest(self.candidate_raw)
        runtime.gateway['admission']={'file':'/admission/state.json','releaseId':'test-release','candidateSha256':candidate_sha}
        runtime.save('runtime.json',runtime.target);runtime.save('gateway.json',runtime.gateway)
        input_configuration=Path(shutil.copytree(configuration,root/'original-configuration-input'))
        selected,jobs,_,_=source.runtime.make_plan(bundle,configuration,runtime.compose,expected_profile=self.profile)
        configuration_hashes=staging_state.configuration_hashes(configuration)
        test_plan,self.baseline,self.domain,domain_gateway,effects=fixture()
        job=jobs['frontend']['job'];target={key:job['target'][key] for key in ('host','port','database','user','serverMajor')}
        target_sha=parent.frontend_target_sha256(target);owner={'name':'owned_owner','oid':'321'}
        canonical_candidate_sha=source.digest(source.canonical(selected));action='owned-certification';self.recovery='owned-replacement'
        self.receiver_targets={name:{**{key:jobs[name]['job']['target'][key] for key in ('host','port','database','serverMajor')},
            'user':jobs[name]['job']['runtimeRole'],'roleOid':'456'} for name in ('course','community')}
        source_files={name:source.digest(migrate.read_input(source_root,name)) for name in (source.MODULE,source.HOST_MODULE,parent.API_CHECKER)}
        closure=source.digest(source.canonical(sorted(source_files.items())))
        native={**test_plan['nativePlan'],**self.fields,'candidateSha256':canonical_candidate_sha,'targetSha256':target_sha,
            'sourceCommit':job['sourceCommit'],'owner':owner,'windowSeconds':60,'projectId':selected['workload']['projectId'],
            'deploymentId':'dpl_owned','producer':{**test_plan['nativePlan']['producer'],'role':{'oid':'123','name':'runtime_role'}}}
        native['planSha256']=source.digest(source.canonical(native))
        for row in self.domain['frontend']['operations']:row['source_sha']=job['sourceCommit']
        gateway_config=source.digest(migrate.read_input(configuration,'gateway.json'))
        job_hashes={name:source.digest(migrate.read_input(bundle,'jobs/'+name+'.json')) for name in self.receiver_targets}
        cert={**self.fields,**pair,'environment':'staging','mode':'known-ack-recovery','maximumSeconds':900,
            'certificationActionId':action,'sourceCommit':job['sourceCommit'],'operatorSourceCommit':job['sourceCommit'],
            'candidateSha256':candidate_sha,'candidateObjectSha256':canonical_candidate_sha,'targetSha256':target_sha,
            'gatewayProcessSha256':'b'*64,'gatewayConfigurationSha256':gateway_config,'runtimeInventorySha256':'c'*64,
            'configurationSha256':'d'*64,'configurationCanonicalSha256':source.digest(source.canonical(configuration_hashes)),
            'operatorSourceClosureSha256':closure,'knownAckConfigurationInputDirectory':str(input_configuration),
            'knownAckReceiverTargets':self.receiver_targets,'nativePlan':native,'apiJobSha256':job_hashes,
            'faultSelection':{'stageId':'owned-fault','receiver':'course','commandIndex':0,'commandSha256':test_plan['commandSha256']}}
        intent=source.replacement_intent(cert,self.recovery,expected_profile=self.profile)
        cert['knownAckRecovery']={**self.fields,'recoveryActionId':self.recovery,'intent':intent,'intentSha256':source.digest(source.canonical(intent))}
        cert['planSha256']=parent._profiled_plan_hash(cert)
        observer=parent.P2CertificationPhysicalObserver.__new__(parent.P2CertificationPhysicalObserver)
        witness={};after=['owned-current-journal']
        receipt={**self.fields,**pair,**{key:job[key] for key in ('environment','releaseId','sourceCommit','migrationImageDigest',
            'sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256')},'service':'frontend',
            'status':'P2_CERTIFICATION_DATABASE_CURRENT','certificationActionId':action,'candidateSha256':candidate_sha,'planSha256':cert['planSha256'],
            'targetSha256':target_sha,'target':{**target,'qualificationTargetProfile':self.profile},'schemaVerified':True,'runtimeRoleVerified':True,
            'oldLoginsDenied':True,'oldRoleSessions':0,'sqlReplayed':False,'trafficAuthorized':False,'owner':owner,'runtime':native['producer']['role'],
            'retiredLogins':[],'after':after,'witness':witness,'journalSha256':source.digest(parent._profiled_compact(after)),
            'witnessSha256':source.digest(parent._profiled_compact(witness))}
        observer._expected_profile=self.profile;observer.selected=selected;observer.source=source_root
        observer.request={'job':job,'plan':cert,'receipt':receipt,'baseline':json.loads(jobs['frontend']['schema']),
            'owner':owner,'historicalLogins':{'retiredLogins':[]}}
        observer.verify=Mock()
        lock=root/'owned-flock';fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);self.addCleanup(os.close,fd);fcntl.flock(fd,fcntl.LOCK_EX)
        self.scope=parent.P2CertificationScope(fd,lock,observer.verify,receipt,candidate_sha,release=selected,jobs=jobs,
            configuration_sha256=configuration_hashes,certification_plan=cert,expected_profile=self.profile,physical_observer=observer)
        stage=source.P2CertificationFaultStage.__new__(source.P2CertificationFaultStage)
        stage.expected_profile=self.profile;stage.scope=self.scope;stage.arm_called=False;stage.lease_sha256='2'*64
        stage.gateway={'containerId':'1'*64}
        stage.plan={**self.fields,**{key:cert[key] for key in ('candidateSha256','candidateObjectSha256','sourceCommit','operatorSourceCommit',
            'targetSha256','gatewayProcessSha256','gatewayConfigurationSha256','operatorSourceClosureSha256')},
            **{key:cert['faultSelection'][key] for key in ('stageId','receiver','commandSha256')},
            'profile':'lifecycle-known-command-v1','nativePlanSha256':native['planSha256'],'mode':'drop-after-ack',
            'configurationSha256':cert['configurationCanonicalSha256'],'gatewayImageSha256':'f'*64}
        stage.effects=Mock(return_value=[{**effects[0],'version':1,'environment':'staging','status':'P2_TRANSPORT_FAULT_INJECTED',
            'leaseSha256':stage.lease_sha256,
            **{key:stage.plan[key] for key in ('profile','stageId','candidateSha256','configurationSha256','gatewayProcessSha256','gatewayImageSha256')}}])
        broker=parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker);self.broker=broker
        broker.initial={**self.fields,'certificationPlan':cert,'certificationActionId':action,'nativePlan':native,'configurationSha256':configuration_hashes,
            'candidateSha256':candidate_sha,'sourceSha256':source_files,'sourceClosureSha256':closure}
        broker.scope=self.scope;broker.fault_stage=stage;broker.external_armed=True;broker.native_enable_attempted=False;broker.native_expected=False
        broker.configuration=configuration;broker.selected=selected;broker.jobs=jobs;broker.bundle=bundle;broker.source=source_root
        broker.certification_started=time.monotonic();broker.directory=root/'certification';broker.directory.mkdir(mode=0o700)
        broker._native_observe=Mock(return_value={'nativeEnabled':False})
        broker.known_ack_recorder=None;broker.known_ack_boundary=None
        self.gateway={'status':'PRIOR_GATEWAY_OBSERVED','process':{'containerId':stage.gateway['containerId'],'pid':123},
            'binding':{'candidateSha256':candidate_sha,'configurationDirectory':str(configuration),'gatewayConfigurationSha256':gateway_config},
            'admission':{**domain_gateway['admission'],'uncertain':{'newWork':0,'recovery':0}}}
        broker._gateway_current=Mock(return_value={'processSha256':cert['gatewayProcessSha256'],'gatewayConfigurationSha256':gateway_config,
            'faultLeasePresent':False,'admission':self.gateway['admission']})
        api=broker.directory/'api';api.mkdir();databases={}
        for name,pin in job_hashes.items():
            (api/(name+'-input')).mkdir();(api/name).mkdir()
            (api/(name+'-input')/'job.json').write_bytes(migrate.read_input(bundle,'jobs/'+name+'.json'))
            migrate.write_json(api/name,'database-receipt.json',{'manifestSha256':pin})
            databases[name]={'image':jobs[name]['image'],'jobSha256':pin,'receiptSha256':source.digest(migrate.read_input(api/name,'database-receipt.json'))}
        outcome={**self.fields,'status':'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED','phase':'completed','candidateSha256':candidate_sha,
            'releaseId':selected['releaseId'],'certificationActionId':action,'databases':databases,'migrationsExecuted':False,
            'frontendSqlApplied':False,'trafficAuthorized':False}
        migrate.write_json(api,'certification-current-databases-outcome.json',outcome)
        broker.api_proof=current_databases.CertificationCurrentDatabaseProof(current_databases._CERTIFICATION_PROOF_AUTHORITY,
            self.scope,selected,jobs,api,outcome)
        self.current=self.baseline
        self.gateway_read=Mock(side_effect=lambda *_args,**_kwargs:copy.deepcopy(self.gateway))
        for projection in (patch.object(source,'ROOT',root),patch.object(source.os,'geteuid',return_value=0),
                           patch.object(prior,'observe_prior_gateway',self.gateway_read),
                           patch.object(source.P2KnownAckLossRecorder,'_snapshot',side_effect=lambda **_:copy.deepcopy(self.current))):
            projection.start();self.addCleanup(projection.stop)

    def recorder(self):
        recorder=source.P2KnownAckLossRecorder(self.broker,self.recovery,self.receiver_targets,expected_profile=self.profile)
        self.broker.known_ack_recorder=recorder
        return recorder

    def request_artifact(self):
        native=self.broker.initial['nativePlan'];action=self.broker.action_id();observations=[]
        for i,row in enumerate(self.domain['frontend']['operations']):
            event={'version':1,'status':'P2_LIFECYCLE_CRON_ADMITTED','environment':'staging','projectId':native['projectId'],
                'operationId':row['id'],'producerSha256':native['producer']['producerSha256'],'sourceCommit':native['sourceCommit'],
                'epoch':'3','kind':'recovery','targetSha256':native['targetSha256']}
            observations.append({'version':1,'kind':'vercel-native-request-details','reviewerGithubUserId':'8996309','projectId':native['projectId'],
                'deploymentId':native['deploymentId'],'path':parent.native.PATH,'method':'GET','providerRequestTypeFilter':'cron',
                'providerRequestId':'owned-'+str(i),'startedAt':'2026-11-06T01:00:00.000Z','completedAt':'2026-11-06T01:00:05.000Z',
                'httpStatus':503 if row['state']=='uncertain' else 200,'logScope':'this-provider-request-details','admittedLogLine':json.dumps(event)})
        return source.canonical({'version':1,'kind':'operator-recorded-request-details','reviewerGithubUserId':'8996309',
            'certificationActionId':action,'nativePlanSha256':native['planSha256'],'windowEpoch':'3','recordedAt':'2026-11-06T01:00:05.000Z',
            'observations':observations})+b'\n'

    def begin_window(self):
        recorder=self.recorder();self.broker.native_expected=True
        with self.assertRaisesRegex(ValueError,'PROFILED_FAULT_ARM_REQUIRED'):recorder.start_native_window()
        self.broker.fault_stage.arm_called=True;recorder.start_native_window()
        self.current=copy.deepcopy(self.domain);self.gateway['admission']['uncertain']['recovery']=1
        return recorder

    def prepare(self):
        recorder=self.begin_window()
        self.assertEqual(recorder.observe_domain()['status'],'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW')
        raw=self.request_artifact();recorder.retain_request_details(base64.b64encode(raw).decode())
        self.broker.native_expected=False;self.current['frontend']['admission'].update(epoch='4',recovery=False)
        self.gateway['admission']['recovery']=False
        return recorder

    def settle(self,recorder):
        proof=recorder.prepare_reconciliation();self.current['frontend']['admission']['uncertain']=0
        self.current['frontend']['operations'][0].update(state='completed',completed_at='2026-11-06T01:00:06.000Z',
            reconciliation_sha256=proof['evidenceSha256'])
        return proof

    def test_same_held_source_confirms_specific_frontend_settlement_and_keeps_gateway_one(self):
        recorder=self.prepare();proof=self.settle(recorder);result=recorder.confirm_reconciliation()
        self.assertEqual(result['qualificationTargetProfile'],self.profile);self.assertEqual(result['version'],2)
        self.assertEqual(result['operationId'],proof['operationId']);self.assertEqual(result['settlementSha256'],proof['evidenceSha256'])
        self.assertEqual(result['oldGatewayUncertain'],{'newWork':0,'recovery':1});self.assertTrue(result['frontendGlobalClosedZero'])
        self.assertFalse(result['ordinaryClosedZeroGate']);self.assertFalse(result['runtimeReplaced'])
        raw=migrate.read_input(recorder.directory,'reconciliation-observed.json')
        self.assertEqual(source.digest(raw),result['reconciliationObservedSha256'])
        self.assertEqual(json.loads(raw)['candidateSha256'],source.digest(self.candidate_raw))
        self.assertEqual(json.loads(raw)['databases'],self.current)
        for name in ('recovery-intent.json','baseline.json','domain.json','request-details.json','settlement.json'):
            self.assertEqual(json.loads(migrate.read_input(recorder.directory,name))['qualificationTargetProfile'],self.profile)
        self.assertEqual(json.loads(migrate.read_input(recorder.directory,'domain.json'))['effect']['version'],1)
        self.assertEqual(self.gateway_read.call_args.kwargs['expected_profile'],self.profile)
        with self.assertRaisesRegex(ValueError,'PROFILED_CONFIRMATION_REQUIRED'):recorder.confirm_reconciliation()
        with self.assertRaisesRegex(ValueError,'PROFILED_REPLACEMENT_UNAVAILABLE'):recorder.authorize_replacement()
        with self.assertRaisesRegex(ValueError,'FIXED_SOURCE_CONSUMER_REQUIRED'):source.issue_known_ack_loss_boundary(self.broker,result)
        self.assertFalse((recorder.directory/'replacement-authorization.json').exists())

    def test_raw_candidate_drift_and_missing_opaque_api_proof_refuse_before_gateway_or_output(self):
        self.candidate_file.write_bytes(self.candidate_raw+b'\n')
        with self.assertRaisesRegex(ValueError,'EXACT_ORIGINAL_CANDIDATE_REQUIRED'):self.recorder()
        self.candidate_file.write_bytes(self.candidate_raw);self.broker.api_proof={'version':2,'qualificationTargetProfile':self.profile}
        with self.assertRaisesRegex(ValueError,'CERTIFICATION_API_PROOF_REQUIRED'):self.recorder()
        with self.assertRaisesRegex(ValueError,'BEFORE_FAULT_SOURCE_PARENT_REQUIRED'):
            source.P2KnownAckLossRecorder(self.broker,self.recovery,self.receiver_targets)
        self.gateway_read.assert_not_called();self.assertFalse((source.ROOT/('p2-known-ack-loss-'+self.broker.action_id())).exists())

    def test_profiled_sql_transport_uses_actual_private_configuration_and_original_wire(self):
        recorder=self.recorder();broker=self.broker
        broker.armed_probe={'marker':'owned','backendPid':123,'backendStart':'owned-start'}
        broker.initial.update(owner=recorder.plan['nativePlan']['owner'],
            credentials={'FRONTEND_STAGING_MIGRATION_DATABASE_URL':'owned-private-frontend-fixture'})
        expected_role='456';calls=[]
        def run(args,**kwargs):
            if args[1]=='rm':return subprocess.CompletedProcess(args,0,stdout=b'',stderr=b'')
            payload=json.loads(kwargs['input']);calls.append((args,payload,kwargs['env']))
            value={'version':1,'status':'P2_KNOWN_ACK_SQL_CURRENT','service':payload['service'],'readOnly':True,
                'commandId':recorder.command['commandId'],'roleOid':expected_role}
            return subprocess.CompletedProcess(args,0,stdout=source.canonical(value),stderr=b'')
        with patch.object(self.scope,'run',side_effect=run):
            recorder._sql('frontend');recorder._sql('course','d'*64)
            expected_role='999'
            with self.assertRaisesRegex(ValueError,'PROFILED_SQL_READBACK_REQUIRED'):recorder._sql('course','d'*64)
        args,payload,env=calls[0]
        self.assertEqual(payload['version'],1);self.assertNotIn('qualificationTargetProfile',payload)
        self.assertEqual(set(payload['target']),{'host','port','database','user','serverMajor'})
        self.assertEqual(args[2:4],['--pull','never']);self.assertNotIn(env['FRONTEND_STAGING_MIGRATION_DATABASE_URL'],args)
        args,payload,env=calls[1]
        self.assertEqual(payload['target'],self.receiver_targets['course']);self.assertIn('STAGING_DATABASE_URL',env)
        self.assertNotIn(env['STAGING_DATABASE_URL'],args)

    def test_domain_refuses_other_lease_and_retained_candidate_bytes_drift(self):
        recorder=self.begin_window();effect=self.broker.fault_stage.effects.return_value[0]
        effect['leaseSha256']='9'*64
        with self.assertRaisesRegex(ValueError,'PROFILED_RAW_EFFECT_REQUIRED'):recorder.observe_domain()
        self.assertFalse((recorder.directory/'domain.json').exists())
        self.candidate_file.write_bytes(self.candidate_raw+b'\n')
        with self.assertRaisesRegex(ValueError,'EXACT_ORIGINAL_CANDIDATE_REQUIRED'):recorder.observe_domain()

    def test_preparation_refuses_live_lease_and_changed_in_window_receiver_receipt(self):
        recorder=self.prepare();current=self.broker._gateway_current.return_value
        current['faultLeasePresent']=True
        with self.assertRaisesRegex(ValueError,'PROFILED_OLD_GATEWAY_REQUIRED'):recorder.prepare_reconciliation()
        current['faultLeasePresent']=False
        self.current['frontend']['deliveries'][0]['acknowledged_at']='2026-11-06T01:00:09.000Z'
        with self.assertRaisesRegex(ValueError,'PROFILED_IN_WINDOW_RECEIPTS_CHANGED'):recorder.prepare_reconciliation()
        self.assertFalse((recorder.directory/'settlement.json').exists())

    def test_confirmation_refuses_causal_byte_drift_wrong_settlement_old_counter_and_scope_loss(self):
        recorder=self.prepare();proof=self.settle(recorder)
        retained=self.broker.directory/'p2-certification-operator-request-details.json';raw=retained.read_bytes()
        retained.write_bytes(raw+b'\n')
        with self.assertRaisesRegex(ValueError,'ORIGINAL_RECEIPT_CHANGED'):recorder.confirm_reconciliation()
        retained.write_bytes(raw);recorder.reconciliation_attempted=False
        row=self.current['frontend']['operations'][0];row['reconciliation_sha256']='9'*64
        with self.assertRaisesRegex(ValueError,'SPECIFIC_SETTLED_OPERATION_REQUIRED'):recorder.confirm_reconciliation()
        row['reconciliation_sha256']=proof['evidenceSha256'];recorder.reconciliation_attempted=False
        self.gateway['admission']['uncertain']['recovery']=0
        with self.assertRaisesRegex(ValueError,'GLOBAL_ZERO_AND_OLD_ONE_REQUIRED'):recorder.confirm_reconciliation()
        recorder.reconciliation_attempted=False;self.gateway['admission']['uncertain']['recovery']=1
        self.broker._gateway_current.return_value['processSha256']='9'*64
        with self.assertRaisesRegex(ValueError,'PROFILED_OLD_GATEWAY_REQUIRED'):recorder.confirm_reconciliation()
        recorder.reconciliation_attempted=False;self.scope.revoked.set()
        with self.assertRaisesRegex(ValueError,'RELEASE_SCOPE_CLOSED'):recorder.confirm_reconciliation()
        self.assertFalse((recorder.directory/'reconciliation-observed.json').exists())

    def test_profiled_authority_requires_confirmation_and_poisoned_consume_cannot_retry(self):
        recorder=self.prepare();self.settle(recorder)
        with self.assertRaisesRegex(ValueError,'REPLACEMENT_CONFIRMATION_REQUIRED'):recorder.authorize_profiled_replacement()
        observed=recorder.confirm_reconciliation();authorization=recorder.authorize_profiled_replacement()
        with self.assertRaisesRegex(ValueError,'REPLACEMENT_CONFIRMATION_REQUIRED'):recorder.authorize_profiled_replacement()
        with self.assertRaisesRegex(ValueError,'OPAQUE_AUTHORIZATION_REQUIRED'):
            source.consume_known_ack_loss_authorization(authorization,self.scope,self.recovery)
        with self.assertRaisesRegex(ValueError,'OPAQUE_AUTHORIZATION_REQUIRED'):
            source.issue_profiled_known_ack_loss_boundary(self.broker,observed)
        path=recorder.directory/'reconciliation-observed.json';raw=path.read_bytes();path.write_bytes(raw+b'\n')
        with self.assertRaisesRegex(ValueError,'PROFILED_RECONCILIATION_CHANGED'):
            source.issue_profiled_known_ack_loss_boundary(self.broker,authorization)
        path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError,'OPAQUE_AUTHORIZATION_REQUIRED'):
            source.issue_profiled_known_ack_loss_boundary(self.broker,authorization)
        self.assertFalse((source.ROOT/('p2-profiled-known-ack-'+self.recovery)).exists())

    def replacement_fixture(self):
        broker=self.broker;self.release=broker.selected;self.configuration=broker.configuration
        self.model={service:[KnownTransitionTests.metadata(self,service,index+1,self.configuration)]
            for index,service in enumerate(source.runtime.SERVICES)}
        self.replace=lambda stage:KnownTransitionTests.replace(self,stage)
        self.metadata=lambda *args:KnownTransitionTests.metadata(self,*args)
        self.calls=[];self.api_fault=None;self.api_after_drift=False;self.new_uncertain=0
        broker.runtime_current=[{'service':service,'containerId':rows[0]['Id']} for service,rows in self.model.items()]
        broker.process_snapshot=[{'service':service,'pid':str(rows[0]['State']['Pid']),'startedAt':rows[0]['State']['StartedAt']}
            for service,rows in self.model.items()]
        self.gateway['process']=source.KnownAckLossBoundary._public_process(self.model['gateway'][0])
        broker.fault_stage.gateway={'containerId':self.gateway['process']['containerId']}
        broker.initial['hostMachineId']='1'*32
        broker.initial['credentials']={name.upper()+'_STAGING_DATABASE_URL':'owned-private-input' for name in ('course','community')}
        broker.native_mutex=threading.Lock();broker.check=self.scope.verify
        broker.observer=self.scope._physical_observer
        broker.observer.probe=Mock(side_effect=lambda _: {**self.fields,'journalSha256':self.scope.receipt['journalSha256'],
            'targetSha256':self.scope.receipt['targetSha256'],'admission':copy.deepcopy(self.current['frontend']['admission'])})
        def gateway(*_args,**options):
            self.assertEqual(options['expected_profile'],self.profile)
            value=copy.deepcopy(self.gateway);actual=source.KnownAckLossBoundary._public_process(self.model['gateway'][0])
            if actual['containerId']!=value['process']['containerId']:
                value['process']=actual;value['binding']['configurationDirectory']=str(self.snapshot)
                value['admission']['uncertain']['recovery']=self.new_uncertain
            return value
        self.gateway_read.side_effect=gateway

        def run(args,**kwargs):
            self.scope.verify();self.calls.append(args)
            if args[1:3]==['rm','--force'] or args[1:3]==['container','ls'] and any('name=^/' in arg for arg in args):
                value=''
            elif '/check/input/current.mjs' in args:
                service=next(name for name in ('course','community') if any('api-check-'+name+'-' in arg for arg in args))
                if service==self.api_fault:return subprocess.CompletedProcess(args,1,stdout=b'',stderr=b'')
                job=broker.jobs[service]['job'];value={**self.fields,**migrate.contract_identity(broker.selected),
                    'status':'CURRENT_API_DATABASE_READ_ONLY_PASS','environment':'staging','service':broker.jobs[service]['service'],
                    'checks':['selected-image-operator-role-policy'],'migrationsExecuted':False,'pendingTags':[],
                    'appliedCount':2 if self.api_after_drift and self.boundary.finished else 1,
                    'transportVerifier':'selected-image/hasVerifiedMigrationTransport','checkerSha256':broker.initial['sourceSha256'][parent.API_CHECKER],
                    'manifestSha256':broker.initial['certificationPlan']['apiJobSha256'][service],
                    'schemaBaselineSha256':job['schemaBaselineSha256'],'artifactSha256':job['target']['artifactSha256'],
                    'target':{key:job['target'][key] for key in ('host','port','database','user','serverMajor')}}
            elif '/app/p2-known-ack-loss-probe.mjs' in args:
                payload=json.loads(kwargs['input']);service=payload['service']
                value={**self.current[service],'version':1,'status':'P2_KNOWN_ACK_SQL_CURRENT','service':service,
                    'commandId':payload['commandId'],'roleOid':self.receiver_targets[service]['roleOid'],'readOnly':True}
            else:value=KnownTransitionTests.docker(self,args)
            raw=value if isinstance(value,str) else json.dumps(value)
            return subprocess.CompletedProcess(args,0,stdout=raw if kwargs.get('text') else raw.encode(),stderr='' if kwargs.get('text') else b'')

        for projection in (patch.object(self.scope,'run',side_effect=run),patch.object(prior,'ROOT',source.ROOT),
                patch.object(prior,'_inventory',side_effect=lambda *_:[self.model['gateway'][0]['Id']]),
                patch.object(prior,'_mounted_configuration',return_value=self.configuration),
                patch.object(prior,'_reference',return_value=self.gateway['binding']),
                patch.object(prior,'_close',side_effect=lambda *args,**options:gateway(expected_profile=options['expected_profile'])),
                patch.object(prior,'_process',side_effect=lambda *_:source.KnownAckLossBoundary._public_process(self.model['gateway'][0])),
                patch.object(source.runtime,'preflight')):
            projection.start();self.addCleanup(projection.stop)
        recorder=self.prepare();self.settle(recorder);recorder.confirm_reconciliation()
        authorization=recorder.authorize_profiled_replacement()
        self.boundary=source.issue_profiled_known_ack_loss_boundary(broker,authorization)
        self.snapshot=self.boundary.snapshot;broker.known_ack_boundary=self.boundary
        with self.assertRaisesRegex(ValueError,'EXACT_BOUNDARY_REQUIRED'):source.KnownAckRecoveryScope(self.boundary)
        with self.assertRaisesRegex(ValueError,'OPAQUE_AUTHORIZATION_REQUIRED'):
            source.issue_profiled_known_ack_loss_boundary(broker,authorization)
        scope=source.ProfiledKnownAckRecoveryScope(self.boundary)
        self.assertEqual(scope.descriptor,self.scope.descriptor)
        with self.assertRaisesRegex(ValueError,'ACTUAL_RECOVERY_SCOPE_REQUIRED'):source.KnownAckRecoveryRuntime(scope)
        return source.ProfiledKnownAckRecoveryRuntime(scope)

    def test_profiled_runtime_replaces_exact_five_stages_and_retains_old_one(self):
        component=self.replacement_fixture();result=component.restore()
        self.assertEqual(result['status'],'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED')
        self.assertEqual(result['qualificationTargetProfile'],self.profile)
        self.assertEqual(result['currentApiBeforeReceiptSha256'],result['currentApiAfterReceiptSha256'])
        self.assertEqual(result['frontendJournalSha256'],self.scope.receipt['journalSha256'])
        self.assertEqual(result['originalGateway']['admission']['uncertain'],{'newWork':0,'recovery':1})
        self.assertEqual(result['newGateway']['admission']['uncertain'],{'newWork':0,'recovery':0})
        self.assertEqual(prior._read_lineage()['process'],result['newGateway']['process'])
        self.assertFalse(result['sqlReplayed']);self.assertFalse(result['frontendSqlApplied']);self.assertFalse(result['trafficAuthorized'])
        self.assertEqual(len(result['containers']),10)
        self.assertEqual(self.boundary.output.name,'p2-profiled-known-ack-'+self.recovery)
        self.assertEqual([tuple(call[call.index('90')+1:]) for call in self.calls if 'up' in call],list(source.runtime.STAGES))
        self.assertFalse(any('--execute' in call or 'pull' in call for call in self.calls))
        self.assertEqual(staging_state.configuration_hashes(self.snapshot),self.scope.configuration_sha256)
        for name,pin in self.boundary.stage_receipt_sha256.items():
            raw=migrate.read_input(self.boundary.output,name)
            self.assertEqual(source.digest(raw),pin);self.assertEqual(json.loads(raw)['qualificationTargetProfile'],self.profile)
        source.runtime.preflight.assert_called_once_with(component.selected,self.snapshot,component.jobs,pull=False,expected_profile=self.profile)

    def test_profiled_api_failure_refuses_before_runtime_and_poisons_attempt(self):
        component=self.replacement_fixture();self.api_fault='community'
        with self.assertRaisesRegex(ValueError,'DATABASE_CONTAINER_CHECK_FAILED'):component.restore()
        self.assertFalse(self.snapshot.exists());self.assertFalse(any('up' in call or 'stop' in call for call in self.calls))
        self.api_fault=None
        with self.assertRaisesRegex(ValueError,'PROFILED_RUNTIME_ALREADY_ATTEMPTED'):component.restore()

    def test_profiled_nonzero_new_gateway_never_advances_pending_lineage(self):
        component=self.replacement_fixture();self.new_uncertain=1
        with self.assertRaisesRegex(ValueError,'NEW_GATEWAY_CLOSED_ZERO_REQUIRED'):component.restore()
        self.assertEqual(prior._read_lineage()['state'],'replacement-in-progress')
        self.assertTrue((self.boundary.output/source.GATEWAY_STARTED).is_file())
        self.assertFalse((self.boundary.runtime_output/'known-ack-runtime-outcome.json').exists())

    def test_profiled_runtime_has_no_terminal_for_different_current_api_proof(self):
        component=self.replacement_fixture();self.api_after_drift=True
        with self.assertRaisesRegex(ValueError,'PROFILED_API_CURRENT_CHANGED'):component.restore()
        self.assertEqual(prior._read_lineage()['state'],'running-observed')
        self.assertFalse((self.boundary.runtime_output/'known-ack-runtime-outcome.json').exists())


class KnownTransitionTests(unittest.TestCase):
    """Real inherited flock/child registry; Docker/provider transport is modeled.

    Domain/FE nonce/TLS/three-DB source behavior is separately exercised by the
    owned fixtures. These tests execute the actual new typed transition guard.
    """
    save=scope_fixture.P2ScopeTests.save
    add_frontend=scope_fixture.P2ScopeTests.add_frontend

    def setUp(self):
        scope_fixture.P2ScopeTests.setUp(self)
        compose=self.root/'ops/platform/compose.yaml';compose.parent.mkdir(parents=True);compose.write_bytes(b'owned-compose')
        self.release['runtime']={'composeSha256':'sha256:'+source.digest(compose.read_bytes())}
        self.release['artifacts']['gateway']={'image':'ghcr.io/princessdardan/lash-her-platform-gateway@sha256:'+'e'*64};self.save()
        self.scope=cert_fixture.CertificationScopeTests.certification(self)
        self.configuration=self.root/'configuration';self.configuration.mkdir(mode=0o700)
        for name in staging_state.CONFIGURATION_FILES:
            path=self.configuration/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('owned-'+name).encode());path.chmod(0o600)
        (self.configuration/'gateway.json').write_text(json.dumps({'admission':{'file':'/admission/state.json','releaseId':self.release['releaseId'],'candidateSha256':'a'*64}}))
        self.scope.configuration_sha256=staging_state.configuration_hashes(self.configuration)
        self.model={};self.calls=[];self.lineage={'state':'running-observed'}
        for index,service in enumerate(source.runtime.SERVICES):self.model[service]=[self.metadata(service,index+1,self.configuration)]
        self.broker=parent.P2CertificationBroker.__new__(parent.P2CertificationBroker)
        b=self.broker;b.scope=self.scope;b.selected=self.scope.release;b.jobs=self.scope.jobs;b.configuration=self.configuration;b.source=self.root
        b.initial={'candidateSha256':'a'*64,'hostMachineId':'f'*64,'configurationSha256':self.scope.configuration_sha256,'certificationPlan':{'mode':'known-ack-recovery'}}
        helper=self.root/source.HOST_MODULE;helper.parent.mkdir(parents=True);helper.write_bytes(b'owned-source-helper-transport-fixture')
        b.initial['sourceSha256']={source.HOST_MODULE:source.digest(helper.read_bytes())}
        b.native_mutex=threading.Lock();b.full_calls=0
        def full():b.full_calls+=1;return {'nativeEnabled':False}
        b.initial['privateProbe']={'owned':'modeled-unexpired-original-probe'}
        b._native_observe=full;b._native_context=lambda:{'plan':{'projectId':'prj_owned','sourceCommit':'a'*40,'actionId':'test-release'},'privateProbeDirectory':str(self.root/'private-probe')};b.check=self.scope.verify;b.vercel=Mock()
        b.observer=Mock();b.observer.probe.return_value={'admission':{'epoch':'4','newWork':False,'recovery':False,'active':0,'uncertain':0}}
        b.runtime_current=[{'service':service,'containerId':rows[0]['Id'],'image':rows[0]['Config']['Image'],'health':'none' if service.endswith('-tls') else 'healthy'} for service,rows in self.model.items()]
        b.process_snapshot=[{'service':service,'pid':str(rows[0]['State']['Pid']),'startedAt':rows[0]['State']['StartedAt']} for service,rows in self.model.items()]
        self.old_gateway=self.gateway()
        recorder=Mock();recorder.scope=self.scope;recorder.recovery_action_id='known-replacement';recorder.selection={'intent':'modeled-domain-prerequisite'};recorder.settlement={'epoch':'4'}
        recorder.configuration_input=self.configuration
        recorder._verify_authorization.side_effect=lambda _:self.scope.verify();recorder._gateway.side_effect=lambda:copy.deepcopy(self.old_gateway)
        b.known_ack_recorder=recorder
        authorization=source.KnownAckLossRecoveryAuthorization(source._ISSUER,recorder,{'recoveryActionId':'known-replacement','candidateSha256':'a'*64,
            'operationId':'00000000-0000-4000-8000-000000000002','recoveryIntentSha256':'e'*64,'operatorSourceClosureSha256':'f'*64})
        actual_run=self.scope.run
        def run(args,**kwargs):
            if args[0]!='docker':return actual_run(args,**kwargs)
            self.scope.verify();self.calls.append(list(args));result=self.docker(args);self.scope.verify()
            raw=result if isinstance(result,str) else json.dumps(result)
            return subprocess.CompletedProcess(args,0,stdout=raw if kwargs.get('text') else raw.encode(),stderr='' if kwargs.get('text') else b'')
        self.scope.run=run
        self.real_remember=prior._remember;self.real_read_lineage=prior._read_lineage
        patches=[patch.object(source,'ROOT',self.root),patch.object(source.runtime,'runtime_environment',return_value={}),
            patch.object(prior,'observe_prior_gateway',side_effect=lambda *_args,**_kwargs:self.gateway()),
            patch.object(prior,'capture_before_stop',side_effect=self.capture_stop),patch.object(prior,'retain_ordered_stop',side_effect=self.retain_stop),
            patch.object(prior,'observe_stopped_prior_gateway',side_effect=lambda *_args,**_kwargs:copy.deepcopy(self.old_gateway)),
            patch.object(prior,'_read_lineage',side_effect=lambda:copy.deepcopy(self.lineage)),patch.object(prior,'_remember',side_effect=self.remember)]
        for item in patches:item.start();self.addCleanup(item.stop)
        self.boundary=source.issue_known_ack_loss_boundary(b,authorization)
        self.snapshot=self.boundary.snapshot;self.snapshot.mkdir(mode=0o700)
        for name in staging_state.CONFIGURATION_FILES:
            path=self.snapshot/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((self.configuration/name).read_bytes());path.chmod(0o600)
        (self.snapshot/'compose.yaml').write_bytes(compose.read_bytes())
        self.boundary.bind_snapshot(self.snapshot)
        self.known_scope=source.KnownAckRecoveryScope(self.boundary)

    def tearDown(self):scope_fixture.P2ScopeTests.tearDown(self)

    def metadata(self,service,number,configuration):
        image=self.release['artifacts'][source.runtime.IMAGE_KEYS[service]]['image']
        return {'Id':format(number,'064x'),'Image':image.split('@')[1],'RestartCount':0,
            'Config':{'Image':image,'Env':['PATH=/owned/bin','MODEL_SERVICE='+service],
                'Labels':{'com.docker.compose.project':'lash-her-staging','com.docker.compose.service':service}},
            'HostConfig':{'ReadonlyRootfs':True},'State':{'Running':True,'Pid':100+number,'StartedAt':'owned-start-'+str(number),
                **({} if service.endswith('-tls') else {'Health':{'Status':'healthy'}})},
            'Mounts':[{'Destination':destination,'Source':str(configuration/relative),'Type':'bind','RW':False} for destination,relative in source.MOUNTS.get(service,{}).items()]}

    def docker(self,args):
        if args[1:3]==['container','ls']:return '\n'.join(row['Id']+'|'+service for service,rows in self.model.items() for row in rows)
        if args[1:3]==['image','inspect']:
            if args[args.index('--format')+1]=='{{.Id}}':return args[-1].split('@')[1]
            return {'Id':args[-1].split('@')[1],'Config':{'Env':['PATH=/owned/bin']}}
        if args[1]=='inspect':
            row=next(copy.deepcopy(row) for rows in self.model.values() for row in rows if row['Id'].startswith(args[-1]))
            if args[args.index('--format')+1]!='{{json .}}':return '|'.join([row['Image'],'true',(row['State'].get('Health') or {}).get('Status','none'),'lash-her-staging',row['Config']['Labels']['com.docker.compose.service']])
            return row
        if 'config' in args:return {'services':{name:{'environment':{'MODEL_SERVICE':name}} for name in source.runtime.SERVICES}}
        if 'up' in args:
            stage=tuple(args[args.index('90')+1:]);self.assertEqual(stage,self.boundary.stage_active)
            if stage==('gateway',):
                self.assertTrue(self.boundary.gateway_frontier_ready);self.assertEqual(prior._read_lineage()['state'],'replacement-in-progress')
                self.assertEqual(source.digest(migrate.read_input(self.boundary.output,source.GATEWAY_STARTED)),self.boundary.gateway_started_sha256)
            self.replace(stage);return ''
        if 'ps' in args:return '\n'.join(row['Id'] for row in self.model[args[-1]])
        if 'release-probe.mjs' in args:return {'status':'API_RUNTIME_BOUNDARIES_PASS','checks':sorted(source.runtime.PROBE_CHECKS)}
        if args[1]=='stop':
            row=next(row for rows in self.model.values() for row in rows if row['Id'].startswith(args[-1]));row['State'].update(Running=False,Pid=0)
            return args[-1]
        raise AssertionError('unreviewed modeled Docker operation')

    def remember(self,initial,observation,state='running-observed',**extra):
        self.lineage={'protocol':prior.PROTOCOL,'state':state,'actionId':initial['recoveryActionId'],'candidateSha256':initial['candidateSha256'],
            'process':copy.deepcopy(observation['process']),'binding':copy.deepcopy(observation['binding']),**extra}

    def gateway(self):
        row=self.model['gateway'][0]
        old=not hasattr(self,'old_gateway') or row['Id']==self.old_gateway['process']['containerId']
        configuration=self.configuration if old else self.snapshot
        return {'process':{'containerId':row['Id'],'imageId':row['Image'],'running':row['State']['Running'],'pid':row['State']['Pid'],
            'startedAt':row['State']['StartedAt'],'restartCount':row['RestartCount']},
            'binding':{'candidateSha256':'a'*64,'configurationDirectory':str(configuration)},
            'admission':{'newWork':False,'recovery':False,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':1 if old else 0}}}

    def capture_stop(self,_initial,_selected,output,*_args):
        record={'status':'PRIOR_GATEWAY_PRESTOP_OBSERVED','observation':self.gateway()}
        migrate.write_json(output,prior.BEFORE_STOP,record);return record

    def retain_stop(self,before,output,*_args):
        self.assertFalse(self.model['gateway'][0]['State']['Running'])
        record={'status':'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED','beforeSha256':source.digest(migrate.read_input(output,prior.BEFORE_STOP))}
        migrate.write_json(output,prior.STOPPED,record);self.lineage={'state':'stopped-observed','before':copy.deepcopy(before)};return record

    def replace(self,stage):
        for service in stage:
            self.model[service]=[self.metadata(service,1000+source.runtime.SERVICES.index(service),self.snapshot)]

    def advance_to_gateway(self):
        for stage in source.runtime.STAGES[:-1]:
            self.boundary.before_stage(stage);self.replace(stage);self.boundary.after_stage(stage)

    def test_actual_durable_pending_pointer_and_exclusive_marker_precede_gateway_up(self):
        self.advance_to_gateway();retained=self.retain_stop
        def stop(before,output,verify,command):
            result=retained(before,output,verify,command)
            self.real_remember(self.boundary.initial,before['observation'],'stopped-observed',
                stopReceiptDirectory=str(output),stopReceiptSha256=source.digest(migrate.read_input(output,prior.STOPPED)))
            return result
        with patch.object(prior,'ROOT',self.root.resolve()),patch.object(prior,'_remember',side_effect=self.real_remember),\
                patch.object(prior,'_read_lineage',side_effect=self.real_read_lineage),patch.object(prior,'retain_ordered_stop',side_effect=stop):
            self.boundary.before_stage(('gateway',))
            pointer=json.loads((self.root/'.p2-gateway-lineage.json').read_bytes())
            self.assertEqual(pointer['state'],'replacement-in-progress');self.assertEqual(pointer,self.boundary.pending_lineage)
            self.assertEqual((self.root/'.p2-gateway-lineage.json').stat().st_mode&0o777,0o600)
            marker=json.loads(migrate.read_input(self.boundary.output,source.GATEWAY_STARTED))
            self.assertEqual(marker['pendingLineage'],pointer);self.assertEqual(marker['sourceStopLineage']['state'],'stopped-observed')
            self.assertEqual(marker['oldProcess'],self.old_gateway['process']);self.assertEqual(marker['orderedStopSha256'],self.boundary.stopped_sha256)
            self.assertFalse(any('up' in call and 'gateway' in call for call in self.calls))
            self.known_scope.run(['docker','compose','up','--wait-timeout','90','gateway'],env={},timeout=120,capture_output=True,check=True)
            self.boundary.after_stage(('gateway',))
            self.assertEqual(self.real_read_lineage()['state'],'running-observed');self.assertTrue(self.boundary.finished)

    def test_pending_and_marker_write_or_ack_ambiguity_never_returns_to_gateway_up(self):
        for mode in ('pending-before','pending-after','pending-readback','marker-before','marker-after','marker-readback','marker-existing'):
            owned=KnownTransitionTests();owned.setUp()
            try:
                owned.advance_to_gateway();actual_write=migrate.write_json;actual_read=migrate.read_input
                def remember(initial,observation,state='running-observed',**extra):
                    if state=='replacement-in-progress' and mode=='pending-before':raise ValueError('OWNED_PENDING_WRITE_FAILURE')
                    owned.remember(initial,observation,state,**extra)
                    if state=='replacement-in-progress' and mode=='pending-after':raise ValueError('OWNED_PENDING_ACK_LOSS')
                def lineage():
                    result=copy.deepcopy(owned.lineage)
                    if mode=='pending-readback' and result.get('state')=='replacement-in-progress':result['expectedCandidateSha256']='e'*64
                    return result
                def write(directory,name,value):
                    if name==source.GATEWAY_STARTED and mode=='marker-before':raise ValueError('OWNED_MARKER_WRITE_FAILURE')
                    result=actual_write(directory,name,value)
                    if name==source.GATEWAY_STARTED and mode=='marker-after':raise ValueError('OWNED_MARKER_ACK_LOSS')
                    return result
                def read(directory,name,*args):
                    raw=actual_read(directory,name,*args)
                    return b'{}' if name==source.GATEWAY_STARTED and mode=='marker-readback' else raw
                if mode=='marker-existing':actual_write(owned.boundary.output,source.GATEWAY_STARTED,{'owned':'preexisting'})
                with self.subTest(mode=mode),patch.object(prior,'_remember',side_effect=remember),patch.object(prior,'_read_lineage',side_effect=lineage),\
                        patch.object(migrate,'write_json',side_effect=write),patch.object(migrate,'read_input',side_effect=read):
                    with self.assertRaises((ValueError,FileExistsError)):owned.boundary.before_stage(('gateway',))
                self.assertFalse(owned.boundary.gateway_frontier_ready);self.assertFalse(owned.boundary.finished)
                self.assertFalse(any('up' in call and 'gateway' in call for call in owned.calls))
                with self.assertRaises(ValueError):owned.boundary.verify()
            finally:owned.tearDown();owned.doCleanups()

    def test_pending_pointer_marker_and_original_stop_drift_revoke_before_recreation(self):
        self.advance_to_gateway();self.boundary.before_stage(('gateway',))
        for name,code in ((source.GATEWAY_STARTED,'START_MARKER_CHANGED'),(prior.STOPPED,'STOP_RECEIPT_CHANGED'),(prior.BEFORE_STOP,'STOP_RECEIPT_CHANGED')):
            path=self.boundary.output/name;raw=path.read_bytes();path.write_bytes(raw+b'\n')
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,code):self.known_scope.verify()
            path.write_bytes(raw);self.known_scope.verify()
        original=copy.deepcopy(self.lineage);self.lineage['state']='stopped-observed'
        with self.assertRaisesRegex(ValueError,'PENDING_REPLACEMENT_REQUIRED'):self.known_scope.verify()
        self.lineage=original;self.known_scope.verify()
        self.assertFalse(any('up' in call and 'gateway' in call for call in self.calls))

    def test_unknown_or_new_uncertain_gateway_cannot_resolve_pending_lineage(self):
        for mode in ('unknown','new-one','same-id'):
            owned=KnownTransitionTests();owned.setUp()
            try:
                owned.advance_to_gateway();owned.boundary.before_stage(('gateway',));owned.replace(('gateway',))
                observed=owned.gateway()
                if mode=='new-one':observed['admission']['uncertain']['recovery']=1
                if mode=='same-id':owned.model['gateway'][0]['Id']=owned.old_gateway['process']['containerId']
                with self.subTest(mode=mode),patch.object(prior,'observe_prior_gateway',side_effect=ValueError('OWNED_UNKNOWN') if mode=='unknown' else None,return_value=observed):
                    with self.assertRaises(ValueError):owned.boundary.after_stage(('gateway',))
                self.assertFalse(owned.boundary.finished);self.assertEqual(owned.lineage['state'],'replacement-in-progress')
            finally:owned.tearDown();owned.doCleanups()

    def test_fixed_stages_preserve_old_one_and_require_distinct_new_zero(self):
        for stage in source.runtime.STAGES:
            self.boundary.before_stage(stage);self.replace(stage);self.boundary.after_stage(stage)
        self.assertTrue(self.boundary.finished);self.assertEqual(self.boundary.stage_index,5)
        self.assertNotEqual(self.boundary.new_gateway['process']['containerId'],self.old_gateway['process']['containerId'])
        self.assertEqual(self.old_gateway['admission']['uncertain'],{'newWork':0,'recovery':1})
        self.assertEqual(self.boundary.new_gateway['admission']['uncertain'],{'newWork':0,'recovery':0})
        self.assertTrue((self.boundary.output/prior.BEFORE_STOP).is_file());self.assertTrue((self.boundary.output/prior.STOPPED).is_file())
        with self.assertRaises(ValueError):self.boundary.before_stage(source.runtime.STAGES[0])

    def test_unrelated_drift_and_selected_missing_are_distinguished_by_fixed_deadline(self):
        with self.assertRaises(ValueError):self.boundary.before_stage(('gateway',))
        stage=source.runtime.STAGES[0];self.boundary.before_stage(stage)
        held=self.model[stage[0]];self.model[stage[0]]=[];self.boundary.verify();self.model[stage[0]]=held
        row=self.model['gateway'][0];row['Config']['Env'].append('FOREIGN=value')
        with self.assertRaisesRegex(ValueError,'ENVIRONMENT'):self.boundary.verify()
        row['Config']['Env'].pop();self.boundary.verify()
        row['State']['StartedAt']='foreign-process'
        with self.assertRaisesRegex(ValueError,'PROCESS_DRIFT'):self.boundary.verify()
        row['State']['StartedAt']=self.old_gateway['process']['startedAt'];self.boundary.verify()
        self.boundary.stage_deadline=time.monotonic()-1
        with self.assertRaisesRegex(ValueError,'STAGE_EXPIRED'):self.boundary.verify()

    def test_only_three_literal_stages_can_use_metadata_and_full_probe_is_required_afterward(self):
        self.assertEqual(source.UNAVAILABLE_STAGES,(('community-api','course-api'),('community-tls','course-tls'),('gateway',)))
        with patch('p2_lifecycle_native.observe_metadata',return_value={'nativeEnabled':False}) as metadata,\
            patch('frontend_probe._private_input',return_value=self.broker.initial['privateProbe']):
            for stage in source.runtime.STAGES:
                self.boundary.before_stage(stage);before=self.broker.full_calls;calls=metadata.call_count
                actual=self.boundary.verify_healthy_boundary()
                self.assertEqual(actual['catalogUnavailableStage'],stage in source.UNAVAILABLE_STAGES)
                self.assertEqual(metadata.call_count-calls,1 if stage in source.UNAVAILABLE_STAGES else 0)
                self.assertEqual(self.broker.full_calls-before,0 if stage in source.UNAVAILABLE_STAGES else 1)
                self.replace(stage);before=self.broker.full_calls;self.boundary.after_stage(stage)
                self.assertEqual(self.broker.full_calls-before,1)

    def test_probe_expiry_or_private_drift_revokes_even_the_fixed_unavailable_stage(self):
        self.boundary.before_stage(source.runtime.STAGES[0])
        for error in ('expired','changed'):
            with patch('frontend_probe._private_input',side_effect=ValueError('EXPIRED')) if error=='expired' else patch('frontend_probe._private_input',return_value={'owned':'changed'}):
                with self.assertRaises(ValueError):self.boundary.verify_healthy_boundary()

    def test_same_scope_child_registry_and_flock_survive_typed_adapter_then_revoke(self):
        owned_env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C'}
        contender=subprocess.run([sys.executable,'-I','-c','import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(self.path)],capture_output=True,env=owned_env)
        self.assertNotEqual(contender.returncode,0);failures=[]
        def run():
            try:self.known_scope.run([sys.executable,'-I','-c','import time;time.sleep(30)'],timeout=35,check=True,capture_output=True,env=owned_env)
            except BaseException:failures.append(True)
        child=threading.Thread(target=run);child.start();deadline=time.monotonic()+3
        while not self.scope.processes and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(self.scope.processes);self.scope.revoke();child.join(3)
        self.assertFalse(child.is_alive());self.assertTrue(failures)
        with self.assertRaises(ValueError):self.known_scope.verify()

    def test_new_metadata_wrong_image_mount_extra_replica_or_uncertainty_refuses(self):
        stage=source.runtime.STAGES[0];self.boundary.before_stage(stage);self.replace(stage)
        row=self.model[stage[0]][0]
        original=row['Image'];row['Image']='sha256:'+'f'*64
        with self.assertRaisesRegex(ValueError,'IMAGE_ENVIRONMENT'):self.boundary.verify()
        row['Image']=original;self.boundary.verify()
        original=row['Mounts'][0]['Source'];row['Mounts'][0]['Source']=str(self.root/'foreign')
        with self.assertRaisesRegex(ValueError,'MOUNT_DRIFT'):self.boundary.verify()
        row['Mounts'][0]['Source']=original;self.boundary.verify()
        self.model[stage[0]]+=[copy.deepcopy(row),copy.deepcopy(row)]
        with self.assertRaisesRegex(ValueError,'EXTRA_TRANSITION_REPLICA'):self.boundary.verify()
        self.model[stage[0]]=[row];self.boundary.verify()
        observed=self.gateway();observed['admission']['uncertain']['recovery']=0
        with patch.object(prior,'observe_prior_gateway',return_value=observed):
            with self.assertRaisesRegex(ValueError,'OLD_ONE_CHANGED'):self.boundary.verify()

    def test_completed_stage_mounted_bytes_input_and_compose_remain_bound(self):
        stage=source.runtime.STAGES[0];self.boundary.before_stage(stage);self.replace(stage);self.boundary.after_stage(stage)
        for directory,name,code in [(self.snapshot,'tls/ca.pem','CONFIGURATION_CHANGED'),(self.snapshot,'community-api.env','CONFIGURATION_CHANGED'),
                (self.configuration,'course-api.env','CONFIGURATION_CHANGED'),(self.snapshot,'compose.yaml','RENDERED_COMPOSE_CHANGED')]:
            path=directory/name;before=path.read_bytes();path.write_bytes(before+b'\n')
            with self.subTest(path=name),self.assertRaisesRegex(ValueError,code):self.boundary.verify()
            path.write_bytes(before);self.boundary.verify()
        compose=self.root/'ops/platform/compose.yaml';before=compose.read_bytes();compose.write_bytes(before+b'\n')
        with self.assertRaisesRegex(ValueError,'COMPOSE_SOURCE_CHANGED'):self.boundary.verify()
        compose.write_bytes(before);self.boundary.verify()

    def test_recorder_rechecks_separate_source_input_before_any_new_observation(self):
        recorder=source.P2KnownAckLossRecorder.__new__(source.P2KnownAckLossRecorder)
        recorder.broker=self.broker;recorder.scope=self.scope;recorder.fault_plan={'owned':'fault'};recorder.plan={'nativePlan':{'owned':'native'}}
        recorder.selection={'owned':'intent'};self.broker.fault_stage=Mock(plan=recorder.fault_plan)
        self.broker.initial.update(nativePlan=recorder.plan['nativePlan']);self.broker.initial['certificationPlan']['knownAckRecovery']=recorder.selection
        recorder.configuration_input=self.root/'separate-input';recorder.configuration_input.mkdir(mode=0o700)
        for name in staging_state.CONFIGURATION_FILES:
            path=recorder.configuration_input/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((self.configuration/name).read_bytes());path.chmod(0o600)
        program=self.root/source.MODULE;program.write_bytes(b'owned-reader');recorder.source_sha256=source.digest(program.read_bytes())
        recorder._verify();path=recorder.configuration_input/'community-api.env';before=path.read_bytes();path.write_bytes(before+b'\n')
        with self.assertRaisesRegex(ValueError,'CONFIGURATION_CHANGED'):recorder._verify()
        path.write_bytes(before);recorder._verify()

    def test_unknown_stop_receipt_refuses_before_gateway_recreation(self):
        for stage in source.runtime.STAGES[:-1]:
            self.boundary.before_stage(stage);self.replace(stage);self.boundary.after_stage(stage)
        with patch.object(prior,'retain_ordered_stop',return_value={'status':'PRIOR_GATEWAY_STOP_UNKNOWN'}):
            with self.assertRaisesRegex(ValueError,'ORDERED_STOP_REQUIRED'):self.boundary.before_stage(('gateway',))
        self.assertFalse(self.boundary.finished);self.assertFalse(self.model['gateway'][0]['State']['Running'])
        self.assertFalse(any('up' in call and 'gateway' in call for call in self.calls))

    def test_ordinary_scopes_and_copied_boundary_cannot_construct_known_runtime(self):
        from p2_recovery_runtime import P2RecoveryRuntime
        with self.assertRaises(ValueError):source.KnownAckRecoveryScope(copy.copy(self.boundary))
        with self.assertRaises(ValueError):source.KnownAckRecoveryRuntime(self.scope)
        with self.assertRaises(ValueError):P2RecoveryRuntime(self.known_scope,{}, {},self.root,self.root,self.root,self.root)
        with self.assertRaisesRegex(ValueError,'REPLACEMENT_FORBIDDEN'):self.scope.initialize_runtime(self.snapshot,self.release)
        with self.assertRaises(ValueError):self.known_scope.initialize_runtime(self.root/'foreign',self.release)

    def test_reused_restore_requires_both_current_apis_before_any_mutation(self):
        component=source.KnownAckRecoveryRuntime(self.known_scope);seen=[]
        def current(name,_directory):
            seen.append(name)
            if name=='community':raise ValueError('API_NOT_CURRENT')
            return {'status':'P2_RECOVERY_API_DATABASE_CURRENT'}
        with patch.object(component,'verify_api_current',side_effect=current),patch.object(source.runtime,'snapshot_configuration') as snapshot:
            with self.assertRaisesRegex(ValueError,'API_NOT_CURRENT'):component.restore()
        self.assertEqual(seen,['course','community']);snapshot.assert_not_called()
        self.assertFalse(any('stop' in call or 'up' in call for call in self.calls))

    def test_reused_actual_restore_method_composes_all_stage_guards_and_final_current_proofs(self):
        component=source.KnownAckRecoveryRuntime(self.known_scope);order=[]
        compose=self.root/'ops/platform/compose.yaml'
        # This transport fixture precreated its files; exercise the actual
        # source bind again at the base restore's initialize_runtime hook.
        self.boundary.snapshot_bound=False
        component.selected['runtime']={'composeSha256':'sha256:'+source.digest(compose.read_bytes())}
        self.scope.release['runtime']=copy.deepcopy(component.selected['runtime'])
        component.scope.release['runtime']=copy.deepcopy(component.selected['runtime'])
        self.boundary.selected['runtime']=copy.deepcopy(component.selected['runtime'])
        def current(name,directory):
            order.append(('current',name,directory.name));return {'status':'P2_RECOVERY_API_DATABASE_CURRENT'}
        def snapshot(_configuration,destination,selected,jobs,raw):
            self.assertEqual(destination,self.snapshot);self.assertEqual(raw,b'owned-compose');self.assertEqual(order,[('current','course','runtime-known-ack'),('current','community','runtime-known-ack')])
            (destination/'admission').mkdir(mode=0o700)
        def closed(_snapshot,_selection,_action,**flags):
            self.assertEqual(flags,{'new_work':False,'recovery':False});order.append(('new-admission','closed'));return 'f'*64
        with patch.object(component,'verify_api_current',side_effect=current),patch.object(source.runtime,'snapshot_configuration',side_effect=snapshot),\
            patch.object(source.runtime,'preflight',side_effect=lambda *_args:order.append(('preflight','source-fixed'))),patch('staging_admission.persist_state',side_effect=closed):
            actual=component.restore()
        self.assertEqual(actual['status'],'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED');self.assertFalse(actual['ordinaryClosedZeroGate'])
        self.assertEqual(actual['gatewayReplacementStartedSha256'],source.digest(migrate.read_input(self.boundary.output,source.GATEWAY_STARTED)))
        self.assertEqual(order[-2:],[('current','course','current-api-after'),('current','community','current-api-after')])
        self.assertEqual(len(actual['containers']),10);self.assertTrue(actual['originalGatewayUncertaintyPreserved'])
        self.assertEqual([tuple(call[call.index('90')+1:]) for call in self.calls if 'up' in call],source.runtime.STAGES)
        self.assertFalse(any('--execute' in call for call in self.calls));self.assertTrue((self.boundary.runtime_output/'known-ack-runtime-outcome.json').is_file())


class KnownAckFrontierLineageTests(unittest.TestCase):
    def test_actual_old_gateway_one_stop_proof_becomes_ineligible_after_pending_frontier(self):
        fixture=prior_fixture.PriorGatewayTests();fixture.setUp()
        try:
            fixture.control({'mode':'drop'});before=fixture.stop_proof()
            stopped=prior.observe_stopped_prior_gateway(fixture.initial,fixture.selected,fixture.verify,fixture.command)
            self.assertEqual(stopped['admission']['uncertain'],{'newWork':0,'recovery':1})
            original={name:migrate.read_input(fixture.output,name) for name in (prior.BEFORE_STOP,prior.STOPPED)}
            prior._remember(fixture.initial,before['observation'],'replacement-in-progress',expectedCandidateSha256=fixture.initial['candidateSha256'])
            with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
                prior.observe_stopped_prior_gateway(fixture.initial,fixture.selected,fixture.verify,fixture.command)
            with self.assertRaisesRegex(ValueError,'CONTAINMENT_LATEST_REQUIRED'):
                prior._stopped_for_containment(fixture.initial,fixture.selected,fixture.verify,fixture.command)
            self.assertEqual(prior._read_lineage()['state'],'replacement-in-progress')
            self.assertEqual({name:migrate.read_input(fixture.output,name) for name in original},original)
        finally:fixture.tearDown()


class KnownConfigurationInputTests(unittest.TestCase):
    def test_actual_snapshot_producer_preserves_original_input_through_two_snapshots(self):
        fixture=release_test.RuntimeReleaseTests();fixture.setUp();self.addCleanup(fixture.tearDown)
        fixture.root=fixture.root.resolve();fixture.bundle=fixture.bundle.resolve();fixture.configuration=fixture.configuration.resolve();fixture.compose=fixture.compose.resolve()
        fixture.fixture.add_frontend()
        pair={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'e'*64}
        fixture.fixture.release.update(pair);fixture.fixture.release['frontendMigration'].update(pair)
        for job in fixture.fixture.jobs.values():job.update(pair)
        fixture.fixture.save()
        gateway=json.loads((fixture.configuration/'gateway.json').read_bytes())
        gateway['admission']={'file':'/admission/state.json','releaseId':'test-release','candidateSha256':source.digest((fixture.bundle/'release.candidate.json').read_bytes())}
        (fixture.configuration/'gateway.json').write_text(json.dumps(gateway))
        selected,jobs,_,_=source.runtime.make_plan(fixture.bundle,fixture.configuration,fixture.compose)
        source.runtime.validate_snapshot_source(fixture.configuration,selected,jobs)
        original=fixture.root/'actual-snapshot-one';restored=fixture.root/'actual-snapshot-two'
        source.runtime.snapshot_configuration(fixture.configuration,original,selected,jobs,fixture.compose.read_bytes())
        expected=staging_state.configuration_hashes(original)
        with patch.object(source,'ROOT',fixture.root):
            checked=source.validate_known_configuration_input(fixture.configuration,original,selected,jobs,expected)
            source.runtime.snapshot_configuration(checked,restored,selected,jobs,fixture.compose.read_bytes())
            self.assertEqual(staging_state.configuration_hashes(restored),expected)
            for name in staging_state.CONFIGURATION_FILES:
                self.assertEqual((fixture.configuration/name).read_bytes(),(original/name).read_bytes())
                self.assertEqual((original/name).read_bytes(),(restored/name).read_bytes())
            raw=(fixture.configuration/'gateway.json').read_bytes()
            (fixture.configuration/'gateway.json').write_bytes(raw+b'\n')
            with self.assertRaisesRegex(ValueError,'CONFIGURATION_BYTES_DIFFER'):
                source.validate_known_configuration_input(fixture.configuration,original,selected,jobs,expected)
            (fixture.configuration/'gateway.json').write_bytes(raw)
            self.assertEqual(source.validate_known_configuration_input(fixture.configuration,original,selected,jobs,expected),fixture.configuration)
            # Simulate the production snapshot's container-owned TLS metadata;
            # no owner changes, privileges or fake equivalence are introduced.
            actual_stat=Path.stat
            def container_owned(path,*args,**kwargs):
                value=actual_stat(path,*args,**kwargs)
                if path==original/'tls/gateway/key.pem':
                    fields=list(value);fields[4]=65532;return os.stat_result(fields)
                return value
            with patch.object(Path,'stat',container_owned):
                with self.assertRaisesRegex(ValueError,'CONFIGURATION_OWNER_REQUIRED'):
                    source.validate_known_configuration_input(original,original,selected,jobs,expected)


if __name__=='__main__':unittest.main()
