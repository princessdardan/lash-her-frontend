"""Owned physical flock and no-replay recovery fault tests; no Docker daemon."""
import copy
import fcntl
import json
import io
import base64
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import migrate
import migrate_test
import release as runtime
import p2_release_scope_test as scope_fixture
from p2_recovery_scope import P2RecoveryScope
from p2_recovery_runtime import P2RecoveryRuntime
from p2_recovery_broker import P2RecoveryBroker


class RecoveryScopeTests(unittest.TestCase):
    save = migrate_test.MigrationDriverTests.save
    add_frontend = migrate_test.MigrationDriverTests.add_frontend
    setUp = scope_fixture.P2ScopeTests.setUp
    tearDown = scope_fixture.P2ScopeTests.tearDown

    def recovery(self, receipt=None):
        selected, jobs = migrate.make_plan(self.bundle)
        proof = {**copy.deepcopy(self.receipt), 'status':'P2_RECOVERY_DATABASE_CURRENT','migrationMode':'recovery-current-only',
                 'candidateSha256':'a'*64,'recoveryActionId':'separate-recovery','oldLoginsDenied':True,'oldRoleSessions':0,
                 'sqlReplayed':False,'originalFrontendTerminalRecreated':False,'originalReceiptSha256':{'job-outcome.json':None}}
        proof.pop('applied',None)
        if receipt:
            proof.update(receipt)
        return P2RecoveryScope(self.descriptor,self.path,lambda:None,proof,'a'*64,recovery_action_id='separate-recovery',
                               release=selected,jobs=jobs,configuration_sha256=None)

    def test_committed_current_sql_with_missing_original_terminal_is_a_new_proof(self):
        scope = self.recovery()
        proof = scope.require_frontend(scope.release,scope.jobs['frontend'])
        self.assertIsNone(proof['originalReceiptSha256']['job-outcome.json'])
        self.assertFalse(proof['originalFrontendTerminalRecreated'])
        self.assertEqual(scope.jobs['frontend']['job']['target']['approvedPendingTags'],['0000_test'])
        self.assertFalse((self.results/'job-outcome.json').exists())

    def test_stale_roles_source_contract_original_receipts_and_action_refuse(self):
        for change in ({'sourceCommit':'b'*40},{'schemaBaselineSha256':'b'*64},{'oldLoginsDenied':False},{'oldRoleSessions':1},
                       {'recoveryActionId':'other-action'},{'originalFrontendTerminalRecreated':True},{'migrationMode':'apply-forward'}):
            with self.assertRaises(ValueError):
                self.recovery(change)
        with self.assertRaisesRegex(ValueError,'ACTUAL_RECOVERY_SCOPE'):
            P2RecoveryRuntime({'held':True},{},{},self.root,self.root,self.root,self.root)

    def test_physical_lock_contends_and_sticky_revoke_kills_registered_process(self):
        scope = self.recovery()
        contender = subprocess.run([sys.executable,'-I','-c','import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(self.path)],capture_output=True)
        self.assertNotEqual(contender.returncode,0)
        failures=[]
        def child():
            try:
                scope.run([sys.executable,'-I','-c','import time;time.sleep(30)'],timeout=40,check=True,capture_output=True)
            except BaseException:
                failures.append(True)
        worker=threading.Thread(target=child);worker.start()
        deadline=time.monotonic()+3
        while not scope.processes and time.monotonic()<deadline:
            time.sleep(.01)
        self.assertTrue(scope.processes);scope.revoke();worker.join(5)
        self.assertFalse(worker.is_alive());self.assertTrue(failures)
        with self.assertRaisesRegex(ValueError,'SCOPE_CLOSED'):
            scope.run([sys.executable,'-I','-c','pass'],timeout=5)

    def test_api_incomplete_refuses_before_any_runtime_up_or_migration_execution(self):
        scope=self.recovery()
        output=self.root/'recovery-output';output.mkdir(mode=0o700)
        component=P2RecoveryRuntime(scope,scope.release,scope.jobs,self.root,output,self.root/'compose.yaml',self.root)
        calls=[]
        def current(name,directory):
            calls.append(name)
            if name=='community':
                raise ValueError('P2_RECOVERY_CURRENT_API_REQUIRED')
            return {'status':'P2_RECOVERY_API_DATABASE_CURRENT'}
        with patch.object(component,'verify_api_current',side_effect=current),patch.object(runtime,'snapshot_configuration') as snapshot,patch.object(migrate,'execute',side_effect=AssertionError('SQL replay forbidden')):
            with self.assertRaisesRegex(ValueError,'CURRENT_API'):
                component.restore()
        self.assertEqual(calls,['course','community']);snapshot.assert_not_called()

    def test_normal_runtime_restores_exactly_ten_services_only_after_both_current_api_proofs(self):
        import hashlib
        compose=self.root/'compose.yaml';compose.write_text('owned-compose')
        self.release['runtime']={'composeSha256':'sha256:'+hashlib.sha256(compose.read_bytes()).hexdigest()}
        self.release['artifacts']['gateway']={'image':'ghcr.io/princessdardan/lash-her-platform-gateway@sha256:'+'f'*64}
        self.save();scope=self.recovery();output=self.root.resolve()/'ready-output';output.mkdir(mode=0o700)
        component=P2RecoveryRuntime(scope,scope.release,scope.jobs,self.root,output,compose,self.root)
        order=[]
        def current(name,_directory):
            order.append('current-'+name);return {'status':'P2_RECOVERY_API_DATABASE_CURRENT'}
        def snapshot(_source,destination,selected,_jobs,_compose):
            self.assertEqual(order,['current-course','current-community'])
            destination.mkdir(mode=0o700);(destination/'admission').mkdir()
            (destination/'gateway.json').write_text(json.dumps({'admission':{'file':'/admission/state.json','releaseId':selected['releaseId'],'candidateSha256':scope.candidate_sha256}}))
        def command(args,_env,timeout=30,**_kwargs):
            self.assertEqual(order[:2],['current-course','current-community'])
            if 'up' in args:order.extend(args[args.index('90')+1:])
            if 'release-probe.mjs' in args:return json.dumps({'status':'API_RUNTIME_BOUNDARIES_PASS','checks':sorted(runtime.PROBE_CHECKS)})
            return ''
        containers=[{'service':name,'image':scope.release['artifacts'][runtime.IMAGE_KEYS[name]]['image']} for name in runtime.SERVICES]
        with patch.object(component,'verify_api_current',side_effect=current),patch.object(runtime,'snapshot_configuration',side_effect=snapshot),patch.object(runtime,'preflight'),patch.object(component,'command',side_effect=command),patch.object(runtime,'check_containers',return_value=containers),patch.object(migrate,'execute',side_effect=AssertionError('SQL replay forbidden')):
            outcome=component.restore()
        self.assertEqual(outcome['status'],'P2_RECOVERY_API_RUNTIME_READY');self.assertEqual(order[2:],list(runtime.SERVICES))
        self.assertEqual(len(outcome['containers']),10);self.assertFalse(outcome['sqlReplayed'])
        self.assertFalse(outcome['rolePreparationRepeated']);self.assertFalse(outcome['trafficAuthorized'])

    def test_gateway_restore_requires_actual_frontend_flags_and_never_builds(self):
        broker=object.__new__(P2RecoveryBroker)
        broker.scope=self.recovery();broker.check=lambda:None;broker.closing_at=None;broker.initial={'configuration':str(self.root)};broker.runtime_snapshot=None
        broker.observer=type('Observer',(),{'probe':lambda *_:{'admission':{'newWork':False,'recovery':False,'uncertain':0}}})()
        broker.send=lambda *_args,**_kwargs:None
        with patch.object(broker,'restore_gateway') as restore:
            with self.assertRaisesRegex(ValueError,'ACTUAL_FRONTEND_ADMISSION'):
                broker.command({'id':1,'operation':'recovery-gateway-stage','flags':{'newWork':True,'recovery':True}})
            restore.assert_not_called()

    def test_recovery_has_no_automatic_provider_retry_or_original_terminal_dependency(self):
        source=(Path(__file__).parent/'p2_recovery_runtime.py').read_text()
        self.assertNotIn('migrate.execute(',source)
        self.assertNotIn('--execute',source)
        # Actual runtime flow above refused before all mutation APIs. This
        # structural check additionally catches accidentally imported executors.
        broker=(Path(__file__).parent/'p2_recovery_broker.py').read_text()
        self.assertNotIn('stage_frontend(',broker)
        self.assertNotIn('promote_frontend(',broker)

    def test_terminal_requires_exact_phase2_contract_before_persistence_or_update(self):
        pair={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'f'*64}
        def prepared():
            broker=object.__new__(P2RecoveryBroker);broker.closing_at=1;broker.finished=False;broker.directory=self.root/'terminal'
            broker.directory.mkdir(mode=0o700,exist_ok=True);broker.worker_done=threading.Event();broker.worker_done.set();broker.failed=threading.Event()
            broker.promoted={};broker.gateway_flags={'newWork':True,'recovery':True};broker.released=threading.Event();broker.frontend_raw=b'{}'
            broker.selected={'releaseId':'original','sources':{'frontend':{'commit':'a'*40}},**pair}
            broker.initial={'sourceCommit':'b'*40,'recoveryActionId':'fresh','candidateSha256':'1'*64,'inventorySha256':'2'*64,
                'targetSha256':'3'*64,'configurationBindingSha256':'4'*64,'originalReceiptSha256':{'job-outcome.json':None}}
            broker.outcome={'retained':'unchanged',**pair};return broker
        outcome={**pair,'status':'P2_STAGING_RECOVERY_RESTORATION_VERIFIED','recoveryActionId':'fresh','originalReleaseId':'original','candidateSha256':'1'*64,
            'sourceCommit':'a'*40,'admissionRestored':True,'inventorySha256':'2'*64,'targetSha256':'3'*64,'configurationSha256':'4'*64,
            'originalReceiptSha256':{'job-outcome.json':None},'originalFrontendTerminalRecreated':False,'sqlReplayed':False,
            'rolePreparationAuthorized':False,'historicalLoginsRestored':False,'failedBuildForwardAction':'OPEN'}
        for change in ({'phase2ContractManifestSha256':'sha256:'+'e'*64},{'phase2ContractManifestSha256':None},{'contractPhase':None}):
            broker=prepared();value={key:item for key,item in {**outcome,**change}.items() if item is not None};before=copy.deepcopy(broker.outcome)
            with self.assertRaisesRegex(ValueError,'CONTRACT'):
                broker.finish_receipts({'recovery':base64.b64encode(json.dumps(value).encode()).decode()})
            self.assertEqual(broker.outcome,before);self.assertFalse(broker.finished);self.assertFalse(broker.released.is_set())
            self.assertFalse((broker.directory/'p2-recovery-frontend-verification.json').exists())
        broker=prepared();actual=broker.finish_receipts({'recovery':base64.b64encode(json.dumps(outcome).encode()).decode()})
        self.assertEqual(actual['phase2ContractManifestSha256'],pair['phase2ContractManifestSha256']);self.assertTrue(broker.finished)



import frontend_release_adapters_test as provider_fixture
import frontend_release_adapters as provider_adapter


class RecoveryProviderReadTests(unittest.TestCase):
    setUpClass=classmethod(provider_fixture.ConcreteFrontendAdapterTests.setUpClass.__func__)
    tearDownClass=classmethod(provider_fixture.ConcreteFrontendAdapterTests.tearDownClass.__func__)
    setUp=provider_fixture.ConcreteFrontendAdapterTests.setUp
    tearDown=provider_fixture.ConcreteFrontendAdapterTests.tearDown
    verify=provider_fixture.ConcreteFrontendAdapterTests.verify
    mapped_probe=provider_fixture.ConcreteFrontendAdapterTests.mapped_probe
    execute=provider_fixture.ConcreteFrontendAdapterTests.execute
    mutations=provider_fixture.ConcreteFrontendAdapterTests.mutations
    bootstrap_context=provider_fixture.ConcreteFrontendAdapterTests.bootstrap_context

    def stage(self,*,lost_promotion=False,lost_build=False):
        self.bootstrap_context()
        pair={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'9'*64}
        self.context['candidate'].update(pair);self.database.update(pair)
        self.context['plan']['certification']=provider_adapter.p2_certification_profile.PROFILE
        self.execute('deploy-admission')
        migrate.write_json(self.parent,'database-receipt.json',self.database)
        self.lost_promotion,self.lost_build=lost_promotion,lost_build
        if lost_promotion or lost_build:
            with self.assertRaises(ValueError):self.execute('deploy-compatible')
        else:
            self.execute('deploy-compatible')
        self.original={str(path):path.read_bytes() for path in self.parent.rglob('*.json')}
        recovery=self.parent.parent/'new-recovery';recovery.mkdir(mode=0o700)
        self.context.update(originalDirectory=str(self.parent),directory=str(recovery),checkpoint='recovery')
        self.before_calls=len(self.calls)

    def verify_preserved_get_only(self):
        self.assertTrue(all(call['method']=='GET' for call in self.calls[self.before_calls:]))
        for path,raw in self.original.items():self.assertEqual(Path(path).read_bytes(),raw)
        self.assertFalse((self.parent/'job-outcome.json').exists())

    def test_normal_retained_ready_reuses_actual_immutable_p2_features_without_post(self):
        self.stage();actual=self.execute('observe-compatible')
        self.assertEqual(actual['readyState'],'READY');self.assertTrue(actual['aliasJobMatchesIntent'])
        self.assertEqual(actual['featureControls'],provider_adapter.p2_certification_profile.FEATURE_CONTROLS)
        self.verify_preserved_get_only()

    def test_uncertain_promotion_is_reconciled_by_actual_get_without_reissuing_post(self):
        self.stage(lost_promotion=True);actual=self.execute('observe-compatible')
        self.assertEqual(actual['aliasJobState'],'succeeded');self.assertTrue(actual['aliasJobMatchesIntent'])
        self.verify_preserved_get_only()

    def test_unknown_build_response_never_guesses_identity_or_issues_replacement_post(self):
        self.stage(lost_build=True);actual=self.execute('observe-compatible')
        self.assertIsNone(actual['deploymentId']);self.assertFalse(actual['workloadVerified'])
        self.verify_preserved_get_only()


import frontend_probe_test as live_fixture
import p2_recovery_frontend_observation as live_recovery
import vercel


class RecoveryLiveFrontendTests(unittest.TestCase):
    setUpClass=classmethod(live_fixture.FrontendProbeTests.setUpClass.__func__)
    tearDownClass=classmethod(live_fixture.FrontendProbeTests.tearDownClass.__func__)
    setUp=live_fixture.FrontendProbeTests.setUp
    tearDown=live_fixture.FrontendProbeTests.tearDown
    project=live_fixture.FrontendProbeTests.project
    attempt=live_fixture.FrontendProbeTests.attempt
    credential=live_fixture.FrontendProbeTests.credential
    mapped_http=live_fixture.FrontendProbeTests.mapped_http
    writer_binding=live_fixture.FrontendProbeTests.writer_binding

    def actual(self,changes=None):
        self.release.update(contractPhase='p2',phase2ContractManifestSha256='sha256:'+'9'*64)
        original=self.attempt();self.credential()
        identity=vercel._staged_identity(self.release,original)
        migrate.write_json(original,'frontend-promotion-started.json',{**identity,'previousAliasRequestedAt':0})
        project=self.project(deployment='dpl_fixture');project['lastAliasRequest']={'jobStatus':'succeeded','requestedAt':100,'toDeploymentId':'dpl_fixture','type':'promote'}
        self.fixture.enqueue(project,self.fixture.deployment(),project,project)
        self.probe_body={'contractPhase':'p2','checks':['gateway-course-catalog-p2'],'featureControls':copy.deepcopy(provider_adapter.p2_certification_profile.FEATURE_CONTROLS),'writerAdmissionBinding':self.writer_binding(),**(changes or {})}
        result=live_recovery.observe(self.client,self.release,{'sourceCommit':'a'*40,'targetSha256':'1'*64,'certification':provider_adapter.p2_certification_profile.PROFILE},original,self.private,self.writer_binding(),lambda:None,self.mapped_http())
        self.assertTrue(all(call['method']=='GET' for call in self.fixture.calls))
        self.assertTrue(all(row['path']=='/api/internal/release-probe' for row in self.probes))
        self.assertNotIn('provider-secret-must-not-escape',json.dumps(result));return result

    def test_actual_https_rechecks_ready_features_and_writer_binding_without_changing_old_receipt(self):
        result=self.actual();self.assertEqual(result['writerAdmissionBinding'],self.writer_binding());self.assertTrue(result['frontendServerWorkloadReverified'])
        self.assertFalse(result['providerMutations'])

    def test_actual_wrong_runtime_binding_is_refused_even_when_ready_and_features_match(self):
        binding=self.writer_binding();binding['producerSha256']='3'*64
        with self.assertRaisesRegex(ValueError,'ACTUAL_FRONTEND_BINDING'):
            self.actual({'writerAdmissionBinding':binding})

    def test_actual_changed_feature_profile_is_refused_even_with_correct_writer_binding(self):
        flags=copy.deepcopy(provider_adapter.p2_certification_profile.FEATURE_CONTROLS);flags['CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED']=False
        with self.assertRaisesRegex(ValueError,'ACTUAL_FRONTEND_BINDING'):
            self.actual({'featureControls':flags})


class RecoveryForwardBuildTests(RecoveryProviderReadTests):
    """Actual owned TLS requests through the named production provider helpers."""
    def setUp(self):
        super().setUp()
        owner=self;original_handler=self.server.RequestHandlerClass
        class ForwardHandler(original_handler):
            def do_GET(self):
                if getattr(owner,'runtime_fault_flag',None) and Path(owner.runtime_fault_flag).exists():owner.runtime_fault_calls+=1
                path=self.path.split('?',1)[0]
                if self.command=='POST' and path=='/v13/deployments':
                    raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
                    body=json.loads(raw);self.rfile=io.BytesIO(raw)
                    super().do_GET()
                    owner.deployments[-1]['meta'].update(body.get('meta') or {})
                    return
                if self.command=='GET' and path.startswith('/v13/deployments/'):
                    deployment_id=path.rsplit('/',1)[-1]
                    row=next(row for row in owner.deployments if row['uid']==deployment_id)
                    owner.calls.append({'method':'GET','path':self.path,'body':None})
                    owner.assertEqual(self.headers.get('Authorization'),'Bearer owned-token-marker')
                    owner.probed_deployment=deployment_id
                    result={'id':deployment_id,'projectId':vercel.PROJECTS['staging'],'target':row['target'],
                        'readyState':row['state'],'url':'owned.vercel.app',
                        'gitSource':{'type':'github','repoId':vercel.REPOSITORY_ID,'sha':row['meta']['githubCommitSha']},
                        'meta':{'lashReleaseId':'adapter-owned',**row['meta']}}
                    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                    self.wfile.write(json.dumps(result).encode());return
                super().do_GET()
            do_POST=do_GET
            do_PATCH=do_GET
            do_DELETE=do_GET
        self.server.RequestHandlerClass=ForwardHandler

    def prepare_forward(self,reason='prior-build-failed'):
        self.bootstrap_context()
        pair={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'9'*64}
        self.context['candidate'].update(pair);self.database.update(pair)
        self.context['plan']['certification']=provider_adapter.p2_certification_profile.PROFILE
        self.execute('deploy-admission');migrate.write_json(self.parent,'database-receipt.json',self.database)
        if reason=='retained-ready-probe-expired':
            now=time.time()
            with patch.object(live_recovery.time,'time',return_value=now-3600):self.execute('deploy-compatible')
        else:
            self.failed_build=True
            with self.assertRaisesRegex(ValueError,'BUILD_FAILED'):self.execute('deploy-compatible')
            self.failed_build=False
            if reason=='prior-build-canceled':self.deployments[-1]['state']='CANCELED'
        original_directory=self.parent
        self.original={str(path):path.read_bytes() for path in original_directory.rglob('*.json')}
        original_hashes={str(path.relative_to(original_directory)):migrate.file_hash(raw) for path,raw in
            ((Path(path),raw) for path,raw in self.original.items())
            if len(path.relative_to(original_directory).parts)==1 or
               path.relative_to(original_directory).parts[0]=='vercel' and len(path.relative_to(original_directory).parts)==2}
        for name in ('frontend-promotion-started.json','frontend-promotion-outcome.json','frontend-workload-outcome.json'):
            original_hashes.setdefault('vercel/'+name,None)
        recovery=original_directory.parent/'new-recovery';recovery.mkdir(mode=0o700)
        new_private=original_directory.parent/'new-private';new_private.mkdir(mode=0o700)
        action={'version':1,'environment':'staging','recoveryActionId':'reviewed-forward','originalReleaseId':'adapter-owned',
            'candidateSha256':'1'*64,'sourceCommit':'a'*40,'inventorySha256':'2'*64,'configurationSha256':'3'*64,
            'originalReceiptSha256':original_hashes,'frontendMode':'reviewed-new-build','forwardReason':reason}
        self.context.update(originalDirectory=str(original_directory),directory=str(recovery),action=action,
                            newPrivateConfigurationDirectory=str(new_private))
        self.before_calls=len(self.calls)
        prior=live_recovery.reconcile_forward(self.context,self.client,self.verify)
        self.assertTrue(all(call['method']=='GET' for call in self.calls[self.before_calls:]))
        migrate.write_json(recovery,'p2-recovery-forward-original.json',prior)
        base={**action,'targetSha256':self.context['plan']['targetSha256']}
        migrate.write_json(recovery,'p2-recovery-started.json',{**base,'status':'P2_POST_SQL_RECOVERY_STARTED'})
        current={**base,'releaseId':action['originalReleaseId'],'status':'P2_RECOVERY_DATABASE_CURRENT',
                 'migrationMode':'recovery-current-only','sqlReplayed':False}
        migrate.write_json(recovery,'p2-recovery-current-database.json',current)
        api={**base,'status':'P2_RECOVERY_API_RUNTIME_READY','sqlReplayed':False,'containers':[{'name':str(i)} for i in range(10)],
             'apiDatabases':{key:{'status':'P2_RECOVERY_API_DATABASE_CURRENT'} for key in ('course','community')}}
        migrate.write_json(recovery,'p2-recovery-api-runtime.json',api)
        migrate.write_json(recovery,'p2-recovery-forward-started.json',{**base,'reason':reason,'status':'P2_RECOVERY_NEW_BUILD_INTENT',
            'currentDatabaseReceiptSha256':migrate.file_hash(migrate.read_input(recovery,'p2-recovery-current-database.json')),
            'apiRuntimeReceiptSha256':migrate.file_hash(migrate.read_input(recovery,'p2-recovery-api-runtime.json')),
            'priorReconciliationReceiptSha256':migrate.file_hash(migrate.read_input(recovery,'p2-recovery-forward-original.json')),
            'expectedWriterAdmissionBinding':provider_adapter.compatible_writer_admission_binding(self.context),
            'featureControls':provider_adapter.p2_certification_profile.FEATURE_CONTROLS})
        self.scope={key:action[key] for key in ('recoveryActionId','originalReleaseId','candidateSha256','sourceCommit',
                    'inventorySha256','configurationSha256','originalReceiptSha256')}
        self.scope.update(version=1,mode='reviewed-new-build',targetSha256=base['targetSha256'],originalDirectory=str(original_directory),directory=str(recovery))
        return recovery

    def build(self):
        return live_recovery.build_forward(self.context,self.client,self.verify,self.mapped_probe())

    def preserved(self):
        for path,raw in self.original.items():self.assertEqual(Path(path).read_bytes(),raw)

    def rewrite(self,directory,name,change):
        value=migrate.read_json(directory,name);change(value)
        (directory/name).write_text(json.dumps(value)+'\n');(directory/name).chmod(0o600)

    def test_reviewed_failed_build_creates_one_same_source_deployment_and_actual_private_probe(self):
        recovery=self.prepare_forward();result=self.build()
        self.assertEqual(result['status'],'P2_RECOVERY_NEW_BUILD_VERIFIED');self.assertFalse(result['sqlReplayed'])
        self.context['forwardRecoveryScope']=self.scope
        before=len(self.calls);actual=live_recovery.require_forward_scope(self.context,self.client,self.verify)
        self.assertEqual(actual['recoveryActionId'],'reviewed-forward')
        self.assertTrue(all(call['method']=='GET' for call in self.calls[before:]))
        creates=[call for call in self.calls[self.before_calls:] if call['method']=='POST' and call['path'].split('?',1)[0]=='/v13/deployments']
        self.assertEqual(len(creates),1);self.assertEqual(creates[0]['body']['meta']['lashRecoveryActionId'],'reviewed-forward')
        self.assertEqual(creates[0]['body']['gitSource']['sha'],'a'*40)
        posts=[call for call in self.calls[self.before_calls:] if call['method']=='POST']
        self.assertEqual(len(list((recovery/'vercel').glob('provider-post-*-started.json'))),len(posts))
        self.assertTrue(any(call['path']=='/api/internal/release-probe' for call in self.calls[self.before_calls:]))
        common=''.join(path.read_text() for path in recovery.rglob('*.json'))
        for secret in ('owned-token-marker','owned-runtime-marker',self.variables['LASH_RELEASE_PROBE_SECRET']['value']):self.assertNotIn(secret,common)
        self.preserved()

    def test_reviewed_canceled_build_uses_same_candidate_without_replaying_original(self):
        self.prepare_forward('prior-build-canceled');self.assertEqual(self.build()['status'],'P2_RECOVERY_NEW_BUILD_VERIFIED');self.preserved()

    def test_expired_ready_uses_fresh_probe_without_extending_original_probe(self):
        self.prepare_forward('retained-ready-probe-expired');self.assertEqual(self.build()['status'],'P2_RECOVERY_NEW_BUILD_VERIFIED');self.preserved()

    def test_lost_create_ack_is_retained_unknown_and_second_invocation_never_posts(self):
        recovery=self.prepare_forward();self.lost_build=True
        with self.assertRaises(ValueError):self.build()
        result=migrate.read_json(recovery,'p2-recovery-forward-outcome.json')
        self.assertEqual(result['status'],'P2_RECOVERY_NEW_BUILD_REQUIRES_REVIEW');self.assertIsNone(result['deploymentId'])
        before=len(self.calls)
        with self.assertRaisesRegex(ValueError,'NEW_PRIVATE_PROBE|NEW_ATTEMPT'):self.build()
        self.assertFalse(any(call['method']=='POST' for call in self.calls[before:]));self.preserved()

    def test_original_changed_to_building_refuses_before_any_new_post(self):
        self.prepare_forward();self.deployments[-1]['state']='BUILDING';before=len(self.calls)
        with self.assertRaisesRegex(ValueError,'CONCLUSIVE_FAILED'):self.build()
        self.assertTrue(all(call['method']=='GET' for call in self.calls[before:]));self.preserved()

    def test_current_database_or_api_receipt_drift_refuses_before_any_new_post(self):
        recovery=self.prepare_forward();before=len(self.calls)
        self.rewrite(recovery,'p2-recovery-api-runtime.json',lambda row:row['apiDatabases']['community'].update(status='PENDING'))
        with self.assertRaisesRegex(ValueError,'CURRENT_INTENT'):self.build()
        self.assertFalse(any(call['method']=='POST' for call in self.calls[before:]));self.preserved()

    def test_intent_writer_or_candidate_drift_refuses_before_any_new_post(self):
        recovery=self.prepare_forward();before=len(self.calls)
        self.rewrite(recovery,'p2-recovery-forward-started.json',lambda row:row.update(candidateSha256='f'*64))
        with self.assertRaisesRegex(ValueError,'EXCLUSIVE_INTENT'):self.build()
        self.assertFalse(any(call['method']=='POST' for call in self.calls[before:]));self.preserved()

    def test_original_unknown_create_without_bound_id_never_invents_a_new_build(self):
        self.prepare_forward();attempt=Path(self.context['originalDirectory'])/'vercel'
        (attempt/'frontend-build-created.json').unlink();before=len(self.calls)
        with self.assertRaises((ValueError,OSError)):self.build()
        self.assertFalse(any(call['method']=='POST' for call in self.calls[before:]))

    def test_original_unsettled_alias_refuses_before_any_new_post(self):
        self.prepare_forward();self.alias={'jobStatus':'pending','requestedAt':200,'toDeploymentId':self.current,'type':'promote'}
        before=len(self.calls)
        with self.assertRaisesRegex(ValueError,'SETTLED_ALIAS'):self.build()
        self.assertTrue(all(call['method']=='GET' for call in self.calls[before:]));self.preserved()

    def test_lost_new_promotion_ack_remains_review_required_and_never_reposts(self):
        recovery=self.prepare_forward();self.lost_promotion=True
        with self.assertRaises(ValueError):self.build()
        value=migrate.read_json(recovery,'p2-recovery-forward-outcome.json')
        self.assertEqual(value['status'],'P2_RECOVERY_NEW_BUILD_REQUIRES_REVIEW')
        self.assertEqual(value['phase'],'promotion');self.assertIsNotNone(value['deploymentId'])
        self.assertEqual(self.alias['jobStatus'],'succeeded')
        before=len(self.calls);self.context['forwardRecoveryScope']=self.scope
        with self.assertRaisesRegex(ValueError,'ROOT_CHAIN'):live_recovery.require_forward_scope(self.context,self.client,self.verify)
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(any(call['method']=='POST' for call in self.calls[before:]));self.preserved()

    def test_guard_loss_after_build_prevents_probe_and_promotion(self):
        recovery=self.prepare_forward();owner=self
        def guard():
            owner.verify()
            if len([row for row in owner.deployments if row['uid'].startswith('dpl_candidate')])>=3:
                raise ValueError('OWNED_PARENT_LOCK_LOST')
        with self.assertRaisesRegex(ValueError,'OWNED_PARENT_LOCK_LOST'):
            live_recovery.build_forward(self.context,self.client,guard,self.mapped_probe())
        result=migrate.read_json(recovery,'p2-recovery-forward-outcome.json')
        self.assertEqual(result['status'],'P2_RECOVERY_NEW_BUILD_REQUIRES_REVIEW')
        self.assertFalse(any('/promote/' in row['path'] for row in self.calls[self.before_calls:]));self.preserved()

    def test_completed_chain_requires_exact_metadata_and_immutable_original_receipts(self):
        recovery=self.prepare_forward();self.build();self.context['forwardRecoveryScope']=self.scope
        live_recovery.require_forward_scope(self.context,self.client,self.verify)
        deployment=self.deployments[-1];deployment['meta']['lashRecoveryActionId']='another-action'
        before=len(self.calls)
        with self.assertRaisesRegex(ValueError,'NEW_ACTION_METADATA'):live_recovery.require_forward_scope(self.context,self.client,self.verify)
        deployment['meta']['lashRecoveryActionId']='reviewed-forward'
        self.rewrite(Path(self.context['originalDirectory']),'database-receipt.json',lambda row:row.update(sourceCommit='c'*40))
        with self.assertRaisesRegex(ValueError,'ORIGINAL_RECEIPT_CHANGED'):live_recovery.require_forward_scope(self.context,self.client,self.verify)
        self.assertTrue(all(call['method']=='GET' for call in self.calls[before:]))

    def test_valid_forward_scope_never_accepts_unreviewed_same_source_deployment(self):
        self.prepare_forward();self.build();self.context['forwardRecoveryScope']=self.scope
        self.assertTrue(self.execute('observe-vercel')['reviewedInventoryMatches'])
        before=len(self.calls)
        self.deployments.append({'uid':'dpl_unknownsame','state':'READY','target':'production','created':40,
                                 'url':'unknownsame.vercel.app','meta':{'githubCommitSha':'a'*40}})
        observed=self.execute('observe-vercel')
        self.assertFalse(observed['reviewedInventoryMatches']);self.assertIsNone(observed['activeExecutions']);self.assertIsNone(observed['uncertainEffects'])
        self.deployments.pop();self.assertTrue(self.execute('observe-vercel')['reviewedInventoryMatches'])
        self.assertTrue(all(call['method']=='GET' for call in self.calls[before:]));self.preserved()

    def test_private_probe_overlap_refuses_before_attempt_write_or_provider_call(self):
        self.prepare_forward();recovery=Path(self.context['directory']);original=Path(self.context['originalDirectory']);old=Path(self.context['privateConfigurationDirectory'])
        old_parent=old.parent/'private-container';old_parent.mkdir(mode=0o700);old=old.rename(old_parent/'old-private');self.context['privateConfigurationDirectory']=str(old)
        for parent in (original,recovery,old):(parent/'new-private-nested').mkdir(mode=0o700)
        baseline={str(path):path.read_bytes() for parent in (original,recovery,old) for path in parent.rglob('*') if path.is_file()}
        for path in (original,recovery,old,old_parent,original.parent,original/'new-private-nested',recovery/'new-private-nested',old/'new-private-nested'):
            self.context['newPrivateConfigurationDirectory']=str(path);before=len(self.calls)
            with self.assertRaisesRegex(ValueError,'NEW_PRIVATE_PROBE'):self.build()
            self.assertEqual(len(self.calls),before);self.assertFalse((recovery/'vercel').exists())
            for name,raw in baseline.items():self.assertEqual(Path(name).read_bytes(),raw)

if __name__=='__main__':
    unittest.main()
