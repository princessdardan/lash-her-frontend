"""Actual POSIX scope/receipt tests. Docker/TLS runtime observation is separate."""
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import migrate
import p2_release_scope_test as scope_fixture
import p2_certification_parent as parent


class CertificationScopeTests(unittest.TestCase):
    save=scope_fixture.P2ScopeTests.save
    add_frontend=scope_fixture.P2ScopeTests.add_frontend
    setUp=scope_fixture.P2ScopeTests.setUp
    tearDown=scope_fixture.P2ScopeTests.tearDown

    def certification(self,changes=None):
        selected,jobs=migrate.make_plan(self.bundle)
        job=jobs['frontend']['job']
        target={key:job['target'][key] for key in ('host','port','database','user','serverMajor')}
        plan={'certificationActionId':'bounded-certification','candidateSha256':'a'*64,'planSha256':'b'*64,'targetSha256':parent.frontend_target_sha256(job['target'])}
        receipt={**self.receipt,'status':'P2_CERTIFICATION_DATABASE_CURRENT','certificationActionId':plan['certificationActionId'],'target':target,
            'candidateSha256':plan['candidateSha256'],'planSha256':plan['planSha256'],'targetSha256':plan['targetSha256'],'sqlReplayed':False,'oldLoginsDenied':True,'oldRoleSessions':0}
        if changes:receipt.update(changes)
        return parent.P2CertificationScope(self.descriptor,self.path,lambda:None,receipt,'a'*64,release=selected,jobs=jobs,certification_plan=plan)

    def test_actual_descriptor_contends_and_runtime_replacement_has_no_entry(self):
        scope=self.certification()
        code='import os,fcntl,sys;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)'
        self.assertNotEqual(subprocess.run([sys.executable,'-I','-c',code,str(self.path)],capture_output=True).returncode,0)
        self.assertEqual(scope.require_frontend(scope.release,scope.jobs['frontend'])['status'],'P2_CERTIFICATION_DATABASE_CURRENT')
        with self.assertRaisesRegex(ValueError,'RUNTIME_REPLACEMENT_FORBIDDEN'):scope.initialize_runtime()
        scope.revoke()
        with self.assertRaisesRegex(ValueError,'SCOPE_CLOSED'):scope.verify()

    def test_exact_current_receipt_contract_target_action_and_roles_required(self):
        for change in ({'status':'DATABASE_VERIFIED'},{'phase2ContractManifestSha256':'sha256:'+'f'*64},{'certificationActionId':'other'},
            {'candidateSha256':'f'*64},{'targetSha256':'f'*64},{'planSha256':'f'*64},{'oldRoleSessions':1},{'oldLoginsDenied':False},{'sqlReplayed':True}):
            with self.subTest(change=tuple(change)):
                with self.assertRaises(ValueError):self.certification(change)
        scope=self.certification();self.path.rename(self.root/'old-lock');self.path.write_text('replacement');self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'LOCK_IDENTITY_CHANGED'):scope.verify()


class CertificationProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.directory=Path(self.temporary.name);self.directory.chmod(0o700)
        self.broker=parent.P2CertificationBroker.__new__(parent.P2CertificationBroker)
        self.broker.check=lambda:None
        self.broker.initial={'certificationActionId':'bounded-auth','certificationPlan':{'mode':'auth-preparation','initialEpoch':'7'},'browserPlan':{'sourceCommit':'a'*40},'sourceParentChallenge':'b'*64}
        self.broker.external_armed=True;self.broker.authentication_issued=False
        self.broker.observer=type('Physical',(),{'probe':lambda _,op:{'admission':{'epoch':'8','newWork':True,'recovery':False,'uncertain':0}}})()
        self.gateway={'admission':{'newWork':True,'recovery':False,'uncertain':{'newWork':0,'recovery':0}}}
        self.broker._gateway_current=lambda:self.gateway
        self.broker._native_context=lambda:{};self.broker.vercel=object()

    def test_authentication_capability_requires_actual_arm_epoch_both_flags_and_native_off(self):
        value={'bindingSha256':parent._sha(parent._canonical(self.broker.initial['browserPlan']))}
        with patch.object(parent.native,'observe_metadata',return_value={'nativeEnabled':False}):
            actual=self.broker.authentication_stage(value)
            self.assertEqual(actual,{'status':'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD','bindingSha256':value['bindingSha256'],'certificationActionId':'bounded-auth'})
            with self.assertRaises(ValueError):self.broker.authentication_stage(value)
            for bad in ('unarmed','uncertain','wrong-plan','native-on'):
                self.broker.authentication_issued=False;self.broker.external_armed=bad!='unarmed'
                self.gateway['admission']['uncertain']['recovery']=1 if bad=='uncertain' else 0
                request={'bindingSha256':'f'*64} if bad=='wrong-plan' else value
                with self.subTest(bad=bad),patch.object(parent.native,'observe_metadata',return_value={'nativeEnabled':bad=='native-on'}):
                    with self.assertRaises(ValueError):self.broker.authentication_stage(request)

    def test_finish_requires_exact_p2_pair_and_exact_source_prepared_bytes_before_persistence(self):
        broker=self.broker;broker.directory=self.directory;broker.selected={'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'d'*64}
        broker.prepared_terminal={**broker.selected,'status':'P2_BOUNDED_CERTIFICATION_CONTAINED'}
        broker.closing_at=1;broker.finished=False
        broker.released=type('Event',(),{'set':lambda _:None})()
        for value in ({'status':'P2_BOUNDED_CERTIFICATION_CONTAINED'},{**broker.prepared_terminal,'phase2ContractManifestSha256':'sha256:'+'e'*64}):
            with self.assertRaises(ValueError):broker.finish_certification({'certification':base64.b64encode(json.dumps(value).encode()).decode()})
            self.assertFalse((self.directory/'p2-certification-verification.json').exists())
        actual=broker.finish_certification({'certification':base64.b64encode(json.dumps(broker.prepared_terminal).encode()).decode()})
        self.assertEqual(actual,broker.prepared_terminal);self.assertTrue((self.directory/'p2-certification-verification.json').is_file())

    def test_independent_disable_uses_only_metadata_and_attempts_cleanup_after_observer_failure(self):
        initial={'certificationActionId':'owned-disable','certificationPlan':{'nativePlan':{}},'candidate':{},'vercelToken':'private-test-only'}
        armed={'plan':initial['certificationPlan']}
        calls=[]
        client=type('Client',(),{'request':lambda _,*args:calls.append(args)})()
        with patch.object(parent.vercel,'Client',return_value=client),patch.object(parent.native,'observe_metadata',side_effect=[{'nativeEnabled':True},{'nativeEnabled':False}]),\
            patch.object(parent,'_remove_private_probe') as probe,patch.object(parent,'_scrub_suspension_credentials') as suspension:
            initial['certificationPlan']['nativePlan']['projectId']='prj_owned'
            actual=parent.contain_certification_native(initial,armed,None)
            self.assertEqual(actual,{'nativeDisabled':True,'nativeDisableAttempted':True});self.assertEqual(calls,[('PATCH','/v1/projects/prj_owned/crons',{'enabled':False})]);probe.assert_called_once();suspension.assert_called_once()
        with patch.object(parent.vercel,'Client',side_effect=ValueError('PRIVATE')),patch.object(parent,'_remove_private_probe') as probe,patch.object(parent,'_scrub_suspension_credentials') as suspension:
            self.assertEqual(parent.contain_certification_native(initial,armed,None),{'nativeDisabled':None,'nativeDisableAttempted':False});probe.assert_called_once();suspension.assert_called_once()

    def test_cached_source_companion_is_readonly_and_replacement_refuses(self):
        with patch.object(parent,'_core',b'// fixed test source\n'):
            path=parent._cache_core(self.directory);self.assertEqual(path.stat().st_mode&0o777,0o444)
            path.chmod(0o600);path.write_text('// changed\n')
            with self.assertRaises(ValueError):parent._cache_core(self.directory)

    def test_surviving_broker_waits_for_toggle_quiescence_before_independent_disable(self):
        broker=self.broker;broker.failed=threading.Event();broker.guard_alive=False;broker.native_mutex=threading.Lock()
        broker.outcome={};broker.armed_probe={};broker.source=self.directory;events=[];entered=threading.Event();release=threading.Event()
        def toggle():
            with broker.native_mutex:events.append('toggle-start');entered.set();release.wait(2);events.append('toggle-end')
        worker=threading.Thread(target=toggle);worker.start();self.assertTrue(entered.wait(1))
        def failed(_):broker.failed.set()
        def disable(*_):
            self.assertTrue(broker.failed.is_set());events.append('disable');return {'nativeDisabled':True,'nativeDisableAttempted':True}
        with patch.object(parent.Broker,'abort',failed),patch.object(parent,'contain_certification_native',side_effect=disable),\
            patch('p2_release_supervisor.cleanup_recovery_current_containers'):
            aborted=threading.Thread(target=broker.abort);aborted.start();time.sleep(0.02);self.assertNotIn('disable',events);release.set()
            worker.join(2);aborted.join(2);self.assertFalse(aborted.is_alive())
        self.assertEqual(events,['toggle-start','toggle-end','disable']);self.assertTrue(broker.outcome['nativeDisabled'])

    def test_continuous_boundary_requires_full_features_writer_and_source_selected_native_state(self):
        broker=self.broker;broker.native_mutex=threading.Lock();broker.native_expected=False
        broker.scope=type('Scope',(),{'require_frontend':lambda *args:None,'require_configuration':lambda *args:None})()
        broker.selected={};broker.jobs={'frontend':{}};broker.configuration=self.directory;broker.runtime_current=[];broker.process_snapshot=[]
        broker._runtime_processes=lambda:[];broker.last_api_verified=time.monotonic();broker.last_boundary=0
        for mode in ('auth-preparation','browser-pending','native-window','fault-drop-after-ack'):
            broker.initial['certificationPlan']['mode']=mode
            with self.subTest(mode=mode),patch.object(parent.runtime,'check_containers',return_value=[]):
                full=unittest.mock.Mock(return_value={'nativeEnabled':False});broker._native_observe=full
                broker._verify_boundary();full.assert_called_once();self.assertGreater(broker.last_boundary,0)
                broker._native_observe=lambda:{'nativeEnabled':True}
                with self.assertRaisesRegex(ValueError,'NATIVE_STATE_DRIFT'):broker._verify_boundary()
                broker._native_observe=unittest.mock.Mock(side_effect=ValueError('PROTECTED_BINDING_DRIFT'))
                with self.assertRaisesRegex(ValueError,'PROTECTED_BINDING_DRIFT'):broker._verify_boundary()
        broker.initial['certificationPlan']['mode']='contain-native';broker._native_observe=unittest.mock.Mock(side_effect=AssertionError('expired private probe used'))
        with patch.object(parent.runtime,'check_containers',return_value=[]),patch.object(parent.native,'observe_metadata',return_value={'nativeEnabled':True}) as metadata:
            broker._verify_boundary();metadata.assert_called_once();broker._native_observe.assert_not_called()


if __name__=='__main__':unittest.main()
