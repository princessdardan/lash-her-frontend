"""Owned physical flock and no-replay recovery fault tests; no Docker daemon."""
import copy
import fcntl
import json
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

if __name__=='__main__':
    unittest.main()
