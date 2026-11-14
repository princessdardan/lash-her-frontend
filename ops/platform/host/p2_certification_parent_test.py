"""Actual POSIX scope/receipt tests. Docker/TLS runtime observation is separate."""
import base64
import copy
import fcntl
import hashlib
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import migrate
import release_test
import p2_release_scope_test as scope_fixture
import p2_certification_parent as parent
import p2_release_supervisor as supervisor
from p2_source_closure import TYPES, REQUIRED, verify_source_closure


PROFILED_CURRENT_SOURCE_ONLY = frozenset({
    'ops/platform/host/p2_frontend_replacement_parent.py',
    'ops/platform/host/p2_replacement_operator_evidence.py',
    'ops/platform/host/p2_replacement_runtime_containment.py',
    'ops/platform/host/p2_replacement_runtime_review.py',
    'ops/platform/host/p2_replacement_terminal.py',
    'ops/platform/host/p2_identity_replacement_provenance.py',
    'ops/platform/host/p2_scoped_mux_readiness.py',
    'ops/platform/host/p2_scoped_lifecycle_receiver_negatives.py',
    'ops/platform/p2-frontend-replacement-arm.mjs',
    'ops/platform/p2-frontend-replacement-arm-transport.mjs',
    'ops/platform/p2-frontend-replacement-plan.mjs',
    'ops/platform/p2-frontend-replacement-release.mjs',
    'ops/platform/p2-frontend-replacement-release-review.mjs',
    'ops/platform/p2-frontend-replacement-write-transport.mjs',
    'ops/platform/p2-neon-replacement-acl.mjs',
    'ops/platform/host/p2_profiled_current_frontend.py',
    'ops/platform/host/p2_profiled_current_frontend_test.py',
    'ops/platform/host/p2_profiled_current_parent.py',
    'ops/platform/host/p2_profiled_current_parent_test.py',
    'ops/platform/host/p2_profiled_current_recovery.py',
    'ops/platform/host/p2_profiled_current_recovery_test.py',
    'ops/platform/host/p2_profiled_current_scope.py',
    'ops/platform/host/p2_profiled_current_scope_test.py',
    'ops/platform/host/p2_profiled_known_ack_restoration_parent.py',
    'ops/platform/host/p2_profiled_known_ack_runtime.py',
    'ops/platform/host/p2_profiled_known_ack_runtime_test.py',
    'ops/platform/host/p2_identity_rotation_browser_scope.py',
    'ops/platform/host/p2_identity_rotation_replacement.py',
    'ops/platform/host/p2_identity_rotation_successor.py',
    'ops/platform/host/p2_scoped_mux_replacement.py',
    'ops/platform/p2-identity-key-rotation-replacement.mjs',
    'ops/platform/p2-profiled-current-frontend-adapters.mjs',
    'ops/platform/p2-profiled-current-frontend-adapters.test.mjs',
    'ops/platform/p2-profiled-current-probe.mjs',
    'ops/platform/p2-profiled-current-probe.test.mjs',
    'ops/platform/p2-profiled-current-recovery-transport.mjs',
    'ops/platform/p2-profiled-current-recovery-transport.test.mjs',
    'ops/platform/p2-profiled-current-recovery.mjs',
    'ops/platform/p2-profiled-current-recovery.test.mjs',
    'ops/platform/p2-profiled-current-release.mjs',
    'ops/platform/p2-profiled-current-release.test.mjs',
    'ops/platform/p2-profiled-current-transport.mjs',
    'ops/platform/p2-profiled-current-transport.test.mjs',
})
# The archived interrupted-restoration engine also consumes this exclusion set.
LEGACY_FIXTURE_EVIDENCE_ONLY = frozenset(
    'ops/platform/evidence/2026-11-06-p2-identity-negative-probes/' + name for name in (
        'owned-operator-source-closure.json', 'owned-verifiers-current-only.json',
        'owned-verifiers.json', 'validation.json',
    )
) | {
    'ops/platform/harness/owned-frontend-identity-admission.mjs',
    'ops/platform/harness/owned-p2-lifecycle-receivers.mjs',
}
def tracked_source_fixture(source, destination, *, exclude=frozenset(), include_tests=True):
    """Mirror readOperatorSourceFiles' tracked public ops selection, not npm output."""
    environment={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C',
        'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull,'GIT_NO_REPLACE_OBJECTS':'1'}
    result=subprocess.run(['git','-c','safe.directory='+str(source),'-C',str(source),'ls-files','-z','--','ops'],
        capture_output=True,check=True,env=environment,timeout=10)
    selected={name for name in result.stdout.decode('utf-8').split('\0') if name and Path(name).suffix in TYPES}
    if not exclude.issubset(selected):
        raise ValueError('OWNED_TRACKED_SOURCE_PROJECTION_REQUIRED')
    names=sorted(name for name in selected-exclude if include_tests or name in REQUIRED or
                 not name.endswith(('_test.py', '.test.mjs', '.test.ts', '.test.mts')))
    for name in names:
        path=Path(name)
        if path.is_absolute() or '..' in path.parts or path.parts[0]!='ops' or (source/path).is_symlink():
            raise ValueError('OWNED_TRACKED_SOURCE_PATH_REQUIRED')
        target=destination/path;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((source/path).read_bytes());target.chmod(0o644)
    return names


def legacy_source_fixture(source, destination):
    """Install the v1 fixture with all production and required source files."""
    names = tracked_source_fixture(source, destination, exclude=PROFILED_CURRENT_SOURCE_ONLY | LEGACY_FIXTURE_EVIDENCE_ONLY,
                                   include_tests=False)
    if len(names) > 512 or sum((destination / name).stat().st_size for name in names) > 41_000_000:
        raise ValueError('LEGACY_SOURCE_FIXTURE_BOUNDS_REQUIRED')
    return names


class FirstOwnerSupplementTests(unittest.TestCase):
    def test_supplement_is_first_owner_only_and_compares_the_installed_base(self):
        candidate, operator = 'a' * 40, 'b' * 40
        plan = {'mode': 'interactive-browser', 'replacementRelease': {}, 'supplementalOperatorCommit': operator,
                'scopedAction': {'stage': 'identity', 'firstOwnerDiscovery': {}}}
        initial = {'environment': 'staging', 'sourceCommit': candidate, 'certificationPlan': plan}
        self.assertEqual(parent.profiled_certification_operator_commit(initial), operator)
        for changed in ({'mode': 'native-window'}, {'successorRuntime': {}},
                        {'scopedAction': {'stage': 'identity', 'identityEnrollment': {}}}):
            with self.assertRaisesRegex(ValueError, 'FIRST_OWNER_SUPPLEMENT_REFUSED'):
                parent.profiled_certification_operator_commit({**initial, 'certificationPlan': {**plan, **changed}})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            guard = 'ops/platform/host/p2_interactive_ingress.py'
            other = 'ops/gateway/server.mjs'
            for name in (guard, other):
                path = root / candidate / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'owned-original')
            original = migrate.file_hash(b'owned-original')
            updated = migrate.file_hash(b'owned-updated')
            with patch.object(parent, 'PROFILED_OPERATOR_ROOT', root):
                parent._verify_first_owner_supplement({**initial, 'sourceSha256': {guard: updated, other: original}})
                with self.assertRaisesRegex(ValueError, 'FIRST_OWNER_SUPPLEMENT_SCOPE_REFUSED'):
                    parent._verify_first_owner_supplement({**initial, 'sourceSha256': {guard: updated, other: updated}})


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
        self.broker.directory=self.directory
        self.broker.check=lambda:None
        self.broker.initial={'certificationActionId':'bounded-auth','certificationPlan':{'mode':'auth-preparation','initialEpoch':'7'},'browserPlan':{'sourceCommit':'a'*40},'sourceParentChallenge':'b'*64}
        self.broker.external_armed=True;self.broker.authentication_issued=False
        self.broker.known_ack_boundary=None;self.broker.known_ack_new_gateway_process=None;self.broker.known_ack_recorder=None
        self.broker.observer=type('Physical',(),{'probe':lambda _,op:{'admission':{'epoch':'8','newWork':True,'recovery':False,'uncertain':0}}})()
        self.gateway={'admission':{'newWork':True,'recovery':False,'uncertain':{'newWork':0,'recovery':0}}}
        self.broker._gateway_current=lambda:self.gateway
        self.broker._native_context=lambda:{};self.broker.vercel=object()
        self.broker._observe_browser_origin=lambda:{'browserOrigin':parent.canonical_browser.ORIGIN}

    def test_physical_observer_is_verified_before_concurrent_heartbeats_can_see_it(self):
        broker = self.broker
        broker.observer = None
        broker.selected, broker.source = {}, self.directory
        broker.observer_program = self.directory / 'observer.mjs'
        broker.initial['sourceSha256'] = {parent.OBSERVER: 'a' * 64}
        broker.initial['credentials'] = {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture'}
        observer = Mock()
        broker.observer_type = Mock(return_value=observer)
        started = False

        def verify():
            if not started:
                raise ValueError('PHYSICAL_OBSERVER_NOT_STARTED')

        def heartbeat():
            if broker.observer is not None:
                broker.observer.verify()

        def start(_abort):
            nonlocal started
            heartbeat()  # Interleave a host check while the initial probe is in flight.
            started = True

        broker.check = heartbeat
        observer.start.side_effect = start
        observer.verify.side_effect = verify
        broker._start_physical_observer({})
        self.assertIs(broker.observer, observer)
        heartbeat()
        observer.stop.assert_not_called()

        broker.observer = None
        observer.start.side_effect = ValueError('OWNED_PROBE_FAILURE')
        with self.assertRaisesRegex(ValueError, 'OWNED_PROBE_FAILURE'):
            broker._start_physical_observer({})
        self.assertIsNone(broker.observer)
        observer.stop.assert_called_once()

    def test_authentication_capability_requires_actual_arm_epoch_both_flags_and_native_off(self):
        value={'bindingSha256':parent._sha(parent._canonical(self.broker.initial['browserPlan']))}
        with patch.object(parent.native,'observe_metadata',return_value={'nativeEnabled':False}):
            actual=self.broker.authentication_stage(value)
            self.assertEqual({key:actual[key] for key in ('status','bindingSha256','certificationActionId')},{'status':'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD','bindingSha256':value['bindingSha256'],'certificationActionId':'bounded-auth'})
            self.assertEqual(actual['canonicalBrowserObservationSha256'],parent._sha(parent._canonical(actual['canonicalBrowserObservation'])))
            self.assertEqual(json.loads((self.directory/'p2-canonical-browser-authentication.json').read_text()),actual['canonicalBrowserObservation'])
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

    def test_surviving_broker_cleanup_uses_independent_fixed_namespace_after_scope_revocation(self):
        owned=CertificationScopeTests();owned.setUp();self.addCleanup(owned.tearDown);scope=owned.certification()
        broker=self.broker;broker.failed=threading.Event();broker.guard_alive=False;broker.native_mutex=threading.Lock()
        broker.outcome={};broker.armed_probe={};broker.source=self.directory;broker.scope=scope
        names={'a'*12:'/lash-p2-certification-observer-'+'1'*32,'b'*12:'/lash-p2-certification-observer-foreign'}
        def failed(_):broker.failed.set();scope.revoke()
        def command(args,*_):
            with self.assertRaisesRegex(ValueError,'SCOPE_CLOSED'):scope.verify()
            if args[:3]==['docker','rm','--force']:names.pop(args[-1]);return ''
            pattern=next(value[5:] for value in args if value.startswith('name='))
            return '\n'.join(identity for identity,name in names.items() if re.fullmatch(pattern,name))
        with patch.object(parent.Broker,'abort',failed),patch.object(parent,'contain_certification_native',return_value={'nativeDisabled':True,'nativeDisableAttempted':True}),\
                patch.object(supervisor.runtime,'command',side_effect=command):broker.abort()
        self.assertEqual(set(names),{'b'*12});self.assertNotIn('recoveryCurrentContainerCleanupUncertain',broker.outcome)

    def test_continuous_boundary_requires_full_features_writer_and_source_selected_native_state(self):
        broker=self.broker;broker.native_mutex=threading.Lock();broker.native_expected=False
        broker.scope=type('Scope',(),{'require_frontend':lambda *args:None,'require_configuration':lambda *args:None})()
        broker.selected={};broker.jobs={'frontend':{}};broker.configuration=self.directory;broker.runtime_current=[];broker.process_snapshot=[]
        broker._runtime_processes=lambda:[];broker.last_api_verified=time.monotonic();broker.last_boundary=0
        for mode in ('auth-preparation','browser-pending','direct-worker','native-window','fault-drop-after-ack'):
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

    def test_first_owner_watch_batches_exact_runtime_and_detects_process_or_container_drift(self):
        broker = self.broker
        broker.runtime_current = [
            {'containerId': f'{index:064x}', 'service': service,
             'image': 'example.invalid/runtime@sha256:' + 'a' * 64,
             'health': 'none' if service.endswith('-tls') else 'healthy'}
            for index, service in enumerate(parent.runtime.SERVICES, 1)
        ]
        ids = [row['containerId'] for row in broker.runtime_current]
        def snapshot(pid):
            return '\n'.join('|'.join((row['containerId'], row['image'], 'sha256:' + 'b' * 64, 'true',
                row['health'], 'lash-her-staging', row['service'], pid, '2026-11-12T20:00:00Z', 'true', '[]'))
                for row in broker.runtime_current).encode()
        def result(data):
            return SimpleNamespace(stdout=data, stderr=b'')
        broker.scope = Mock()
        broker.scope.run.side_effect = [result('\n'.join(ids).encode()), result(snapshot('10'))]
        broker.first_owner_runtime_snapshot = broker._read_first_owner_runtime_snapshot()
        self.assertEqual(broker.scope.run.call_count, 2)
        broker.selected = {}; broker.jobs = {'frontend': {}}; broker.configuration = self.directory
        broker.last_api_verified = time.monotonic()
        broker.initial['certificationPlan'].update(mode='interactive-browser')
        broker.require_scoped_native_off = Mock()
        broker.scope.run.side_effect = [result('\n'.join(ids).encode()), result(snapshot('10'))]
        broker._verify_boundary()
        broker.scope.run.side_effect = [result('\n'.join(ids).encode()), result(snapshot('11'))]
        with self.assertRaisesRegex(ValueError, 'PROCESS_OR_MOUNT_CHANGED'):
            broker._verify_boundary()
        broker.scope.run.side_effect = [result('\n'.join(ids + ['f' * 64]).encode())]
        with self.assertRaisesRegex(ValueError, 'RUNTIME_CHANGED'):
            broker._read_first_owner_runtime_snapshot()

    def test_direct_worker_stage_dispatch_is_armed_mode_bound_and_retains_exact_source_bytes(self):
        broker=self.broker;broker.initial['certificationPlan'].update(mode='direct-worker',workerPlanSha256='c'*64)
        stage=unittest.mock.Mock();stage.retain_joined_from_source_parent.return_value={'privateRecordSha256':'d'*64}
        broker.worker_stage=stage
        self.assertEqual(broker.worker_operation('worker-ready',{}),{'bindingSha256':'c'*64});stage.verify.assert_called_once()
        for operation,method,key,private in [('worker-credential','preflight_credential','secret','owned-only-private'),
            ('worker-invoke','invoke_direct','secret','owned-only-private'),('worker-witness','observe_lifecycle_witness','runtimeUrl','owned-only-url')]:
            broker.worker_operation(operation,{key:private});getattr(stage,method).assert_called_once_with(private)
        raw=b'{"status":"source-owned-worker-record"}\n';record=json.loads(raw)
        for source,selected in [(base64.b64encode(raw).decode(),{'status':'changed'}),('not-base64',record)]:
            with self.assertRaises(ValueError):broker.worker_operation('worker-retain',{'sourceArtifact':source,'record':selected})
        stage.retain_joined_from_source_parent.assert_not_called()
        actual=broker.worker_operation('worker-retain',{'sourceArtifact':base64.b64encode(raw).decode(),'record':record})
        self.assertEqual(actual,{'privateRecordSha256':'d'*64});stage.retain_joined_from_source_parent.assert_called_once_with(record)
        self.assertEqual(broker.worker_source_sha256,parent._sha(raw))
        for armed,mode in [(False,'direct-worker'),(True,'native-window')]:
            broker.external_armed=armed;broker.initial['certificationPlan']['mode']=mode
            with self.assertRaisesRegex(ValueError,'SOURCE_WORKER_STAGE_REQUIRED'):broker.worker_operation('worker-invoke',{'secret':'unused'})
        self.assertEqual(stage.invoke_direct.call_count,1)

    def test_direct_worker_terminal_requires_exact_local_source_and_machine_receipts_then_fresh_closed_read(self):
        broker=self.broker;broker.initial['certificationPlan'].update(mode='direct-worker',workerPlanSha256='c'*64)
        broker.worker_stage=unittest.mock.Mock();broker.worker_retained={'privateRecordSha256':'d'*64};broker.worker_source_sha256='e'*64
        valid={'version':1,'status':'P2_CERTIFICATION_DIRECT_WORKER_JOINED','workerPlanSha256':'c'*64,
            'workerSourceArtifactSha256':'e'*64,'workerMachineArtifactSha256':'d'*64}
        for change in ({'workerPlanSha256':'f'*64},{'workerSourceArtifactSha256':'f'*64},{'workerMachineArtifactSha256':'f'*64},
            {'status':'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED'},{'callerCompleted':True}):
            with self.subTest(change=tuple(change)):
                with self.assertRaisesRegex(ValueError,'SOURCE_WORKER_JOIN_REQUIRED'):broker._require_worker_outcome({**valid,**change})
        broker.worker_stage.final_closed_readback.assert_not_called()
        broker._require_worker_outcome(valid);broker.worker_stage.final_closed_readback.assert_called_once()
        broker.worker_stage.final_closed_readback.side_effect=ValueError('CURRENT_BOUNDARY_DRIFT')
        with self.assertRaisesRegex(ValueError,'CURRENT_BOUNDARY_DRIFT'):broker._require_worker_outcome(valid)


    def test_canonical_alias_provider_and_four_argument_probe_retain_scope_checks(self):
        broker=self.broker;events=[]
        broker.check=lambda:events.append('scope')
        broker.initial['browserPlan']['browserOrigin']=parent.canonical_browser.ORIGIN
        broker.vercel=type('Provider',(),{'request':lambda _,method,path,body=None:events.append('provider') or {}})()
        class Probe:
            def request(self,origin,secret,bypass,challenge):events.append('probe');return {}
        def observed(context,client,probe):
            client.request('GET','/fixed-provider');probe.request(parent.canonical_browser.ORIGIN,'owned-secret','owned-bypass','a'*64)
            return {'browserOrigin':parent.canonical_browser.ORIGIN}
        with patch.object(parent.canonical_browser,'observe',side_effect=observed),patch.object(parent.canonical_browser,'CanonicalBrowserProbeClient',return_value=Probe()):
            actual=parent.P2CertificationBroker._observe_browser_origin(broker)
        self.assertEqual(actual,{'browserOrigin':parent.canonical_browser.ORIGIN})
        self.assertEqual(events,['scope','provider','scope','scope','probe','scope'])
        broker._native_observe=lambda:{'nativeEnabled':False};broker.native_mutex=threading.Lock();broker.native_expected=False
        broker._observe_browser_origin=lambda:(_ for _ in ()).throw(ValueError('CANONICAL_ALIAS_DRIFT'))
        broker.scope=type('Scope',(),{'require_frontend':lambda *args:None,'require_configuration':lambda *args:None})()
        broker.selected={};broker.jobs={'frontend':{}};broker.configuration=self.directory;broker.runtime_current=[];broker.process_snapshot=[];broker._runtime_processes=lambda:[]
        broker.last_api_verified=time.monotonic()
        with patch.object(parent.runtime,'check_containers',return_value=[]):
            with self.assertRaisesRegex(ValueError,'CANONICAL_ALIAS_DRIFT'):broker._verify_boundary()


ENTRY_PROGRAM=r'''
import hashlib,importlib,io,json,runpy,sys,types
from pathlib import Path
from unittest.mock import patch
root=Path(sys.argv[1]);mode=sys.argv[2];flavor=sys.argv[3]
sys.path.insert(0,str(root/'ops/platform/host'))
import p2_release_supervisor as guard
import release,migrate,vercel,frontend_probe,p2_source_closure
report={'mode':mode,'hostOrProviderCalls':[],'sourceClosureCalls':0,'dispatchCalled':False}
def forbidden(*args,**kwargs):
    report['hostOrProviderCalls'].append('forbidden-boundary')
    raise AssertionError('OWNED_ENTRY_CROSSED_SAFE_BOUNDARY')
release.command=forbidden;release.assert_host=forbidden;migrate.make_plan=forbidden
vercel.Client=forbidden;frontend_probe.verify=forbidden;guard.os.fork=forbidden
verify_closure=p2_source_closure.verify_source_closure
def actual_closure(*args):
    report['sourceClosureCalls']+=1
    return verify_closure(*args)
p2_source_closure.verify_source_closure=actual_closure
foreign=None
if flavor!='normal':
    foreign=types.ModuleType('p2_certification_parent')
    if flavor=='foreign-same-file':foreign.__file__=str(root/'ops/platform/host/p2_certification_parent.py')
    sys.modules['p2_certification_parent']=foreign
extensions={'.py','.mjs','.json','.yaml','.yml','.service','.timer','.sh','.guard'}
manifest={} if foreign else {p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
    for p in (root/'ops').rglob('*') if p.is_file() and p.suffix in extensions and '__pycache__' not in p.parts}
initial={'mode':'p2-bounded-certification','environment':'staging','certificationActionId':'owned-entry',
 'sourceCommit':'a'*40,'candidate':{'releaseId':'owned-release'},'sourceSha256':manifest,
 'sourceClosureSha256':hashlib.sha256(json.dumps(sorted(manifest.items()),separators=(',',':')).encode()).hexdigest(),
 'certificationPlan':{'mode':mode}}
actual_supervise=guard.supervise
def observe(value,**options):
    report['dispatchCalled']=True
    canonical=importlib.import_module('p2_certification_parent')
    cls=options['broker_type'];observer=options['observer_type'];callback=options['native_containment']
    report.update(brokerModule=cls.__module__,canonicalBrokerSame=cls is canonical.P2CertificationBroker,
      canonicalObserverSame=observer is canonical.P2CertificationPhysicalObserver,
      canonicalContainmentSame=callback is canonical.contain_certification_native,
      sameModuleRegistrationIdempotent=importlib.import_module('p2_certification_parent') is canonical,
      mainOwnsCanonicalModule=sys.modules['__main__'] is canonical,realEntryCallbackName=callback.__name__)
    if mode=='known-ack-recovery':
      from p2_known_ack_loss import P2KnownAckLossRecorder,digest,canonical as encode
      from p2_certification_fault import P2CertificationFaultStage
      from p2_release_scope import P2ReleaseScope
      # Actual source classes, deliberately invalid next fault policy and no
      # live scope. This probe must reject before I/O and issue no authority.
      broker=cls.__new__(cls);broker.scope=P2ReleaseScope.__new__(P2ReleaseScope)
      broker.fault_stage=P2CertificationFaultStage.__new__(P2CertificationFaultStage)
      broker.fault_stage.scope=broker.scope;broker.fault_stage.arm_called=False
      broker.fault_stage.plan={'mode':'before-upstream'}
      broker.external_armed=True;broker.native_enable_attempted=False;broker.selected={'releaseId':'owned-release'}
      broker.initial={'certificationActionId':'owned-entry','nativePlan':{'planSha256':'a'*64,'commandWitnesses':[]},
        'certificationPlan':{'mode':mode,'knownAckRecovery':{'version':1,'recoveryActionId':'owned-recovery',
          'intent':{},'intentSha256':digest(encode({}))}}}
      try:P2KnownAckLossRecorder(broker,'owned-recovery',{})
      except ValueError as error:report['knownRecorderCheckpoint']=str(error)
      else:raise AssertionError('INVALID_FAULT_POLICY_WAS_ACCEPTED')
    try:
      # The real shared dispatcher and its actual callbacks remain unchanged.
      # This intentional nonroot guard prevents host/platform/process work.
      with patch.object(guard.os,'geteuid',return_value=1):actual_supervise(value,**options)
    except ValueError as error:
      report['dispatchCheckpoint']=str(error)
      raise
guard.supervise=observe
sys.stdin=io.TextIOWrapper(io.BytesIO((json.dumps(initial)+'\n').encode()))
sys.argv=[str(root/'ops/platform/host/p2_certification_parent.py'),'--supervisor']
try:runpy.run_path(sys.argv[0],run_name='__main__')
except SystemExit as error:report['entryExit']=error.code
except ValueError as error:report['entryRefusal']=str(error)
if foreign is not None:report['foreignCanonicalPreserved']=sys.modules.get('p2_certification_parent') is foreign
print(json.dumps(report))
'''


class ActualCertificationEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary=tempfile.TemporaryDirectory();cls.addClassCleanup(temporary.cleanup)
        cls.source=Path(temporary.name).resolve()
        cls.source_names=legacy_source_fixture(Path(parent.__file__).resolve().parents[3],cls.source)

    def test_legacy_source_omits_separately_executed_identity_harness_within_existing_bounds(self):
        omitted='ops/platform/harness/owned-frontend-identity-admission.mjs'
        self.assertIn(omitted,LEGACY_FIXTURE_EVIDENCE_ONLY)
        self.assertNotIn(omitted,self.source_names);self.assertFalse((self.source/omitted).exists())
        self.assertTrue(REQUIRED.issubset(self.source_names));self.assertLessEqual(len(self.source_names),512)
        self.assertLessEqual(sum((self.source/name).stat().st_size for name in self.source_names),41_000_000)

    def entry(self,mode,flavor='normal'):
        root=self.source
        result=subprocess.run([sys.executable,'-I','-B','-c',ENTRY_PROGRAM,str(root),mode,flavor],capture_output=True,text=True,timeout=20,
            env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C'})
        self.assertEqual(result.returncode,0);value=json.loads(result.stdout)
        self.assertEqual(value['hostOrProviderCalls'],[])
        self.assertEqual(result.stderr.strip(),'P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW' if flavor=='normal' else '')
        return value

    def test_actual_isolated_main_all_eight_modes_reach_unchanged_shared_dispatch_guard(self):
        for mode in ('auth-preparation','browser-pending','direct-worker','native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery','contain-native'):
            with self.subTest(mode=mode):
                value=self.entry(mode)
                self.assertEqual(value['brokerModule'],'__main__');self.assertEqual(value['sourceClosureCalls'],1)
                for key in ('canonicalBrokerSame','canonicalObserverSame','canonicalContainmentSame','sameModuleRegistrationIdempotent','mainOwnsCanonicalModule'):
                    self.assertTrue(value[key])
                self.assertEqual(value['realEntryCallbackName'],'contain_certification_native')
                self.assertEqual(value['dispatchCheckpoint'],'P2_LINUX_ROOT_GUARD_REQUIRED');self.assertEqual(value['entryExit'],1)
                if mode=='known-ack-recovery':self.assertEqual(value['knownRecorderCheckpoint'],'P2_KNOWN_ACK_ONE_SAME_SOURCE_SUSPENSION_REQUIRED')

    def test_foreign_canonical_module_is_refused_without_replacement_before_source_cache_or_dispatch(self):
        for flavor in ('foreign','foreign-same-file'):
            with self.subTest(flavor=flavor):
                value=self.entry('known-ack-recovery',flavor)
                self.assertEqual(value['entryRefusal'],'P2_CERTIFICATION_CANONICAL_MODULE_REFUSED')
                self.assertTrue(value['foreignCanonicalPreserved']);self.assertEqual(value['sourceClosureCalls'],0)
                self.assertFalse(value['dispatchCalled'])

    def test_tracked_copy_excludes_dependency_private_and_generated_files_without_weakening_closure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'checkout';source.mkdir();installed=root/'installed';installed.mkdir()
            for name in REQUIRED:
                path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'owned tracked source')
            environment={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C',
                'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':os.devnull}
            for command in (['git','init','--quiet',str(source)],['git','-C',str(source),'add','--','ops']):
                subprocess.run(command,check=True,capture_output=True,env=environment,timeout=10)
            excluded=('ops/gateway/node_modules/jose/package.json','ops/gateway/node_modules/.package-lock.json',
                'ops/platform/private/retained.json','ops/platform/generated-untracked.json')
            for name in excluded:
                path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'owned untracked input')
            names=tracked_source_fixture(source,installed)
            self.assertEqual(set(names),REQUIRED)
            for name in excluded:self.assertFalse((installed/name).exists())
            manifest={name:parent._sha((installed/name).read_bytes()) for name in names}
            initial={'sourceSha256':manifest,'sourceClosureSha256':parent._sha(json.dumps(sorted(manifest.items()),separators=(',',':')).encode())}
            self.assertEqual(verify_source_closure(initial,installed),initial['sourceClosureSha256'])
            extra=installed/excluded[0];extra.parent.mkdir(parents=True,exist_ok=True);extra.write_bytes(b'owned installed extra')
            with self.assertRaisesRegex(ValueError,'P2_SOURCE_CLOSURE_INCOMPLETE'):verify_source_closure(initial,installed)

    def test_git_inventory_failure_has_no_filesystem_fallback(self):
        source=Path(parent.__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temporary,patch('subprocess.run',side_effect=subprocess.CalledProcessError(1,['git'])) as command:
            destination=Path(temporary)
            with self.assertRaises(subprocess.CalledProcessError):tracked_source_fixture(source,destination)
            self.assertEqual(list(destination.iterdir()),[])
            self.assertEqual(command.call_args.args[0],['git','-c','safe.directory='+str(source),'-C',str(source),'ls-files','-z','--','ops'])


class ProfiledCertificationInputTests(unittest.TestCase):
    def test_profiled_suspension_start_accepts_only_day_two_credential(self):
        for mode in ('auth-preparation', 'browser-pending', 'direct-worker'):
            fields = set(parent.PROFILED_INITIAL_FIELDS) | {'sourceSuspensionPlan', 'confirmation', 'credentials',
                'vercelToken', '_guardLayout', '_guardObserverSource', '_guardObserverProgram', '_guardLockDescriptor'}
            if mode in parent.BROWSER_MODES:
                fields.add('sourceParentChallenge')
            if mode != 'auth-preparation':
                fields.add('persistenceReviewed')
            if mode == 'browser-pending':
                fields.add('browserResources')
            initial = dict.fromkeys(fields, '/owned')
            initial.update(certificationPlan={'mode': mode}, certificationActionId='owned', confirmation='staging/owned',
                _guardLockDescriptor=8)
            broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
            broker.shared_lock_fd = 8
            broker.safety_write = broker.guard_read = 1
            broker.start_parent_watch = lambda: None
            with self.subTest(mode=mode), patch.object(parent.os, 'geteuid', return_value=0), \
                    patch.object(parent, 'prepare_profiled_current_certification_input',
                        return_value={'originalReleasePlanHashHostVerified': True}), \
                    patch.object(parent.runtime, 'make_plan', side_effect=ValueError('OWNED_PAST_PRIVATE_VALIDATION')):
                for credential in ({}, {'privateProbe': {}}, {'privateProbe': {}, 'scopedCronSecret': 'owned-bearer'}):
                    broker.initial = {**initial, **credential}
                    with self.assertRaisesRegex(ValueError, 'FIXED_GUARDED_START_REQUIRED'):
                        broker.initialize()
                broker.initial = {**initial, 'scopedCronSecret': 'wrong\tcharacters'}
                with self.assertRaisesRegex(ValueError, 'SCOPED_CRON_CREDENTIAL_REQUIRED'):
                    broker.initialize()
                broker.initial = {**initial, 'scopedCronSecret': 'owned-bearer'}
                with self.assertRaisesRegex(ValueError, 'OWNED_PAST_PRIVATE_VALIDATION'):
                    broker.initialize()

    def test_profiled_browser_origin_and_native_select_only_fixed_guarded_readers(self):
        import p2_day_two_workload as day_two
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        broker.vercel = object()
        broker.check = lambda: None
        context = {'candidate': 'owned'}
        broker._native_context = lambda: context
        origin = parent.canonical_browser.ORIGIN
        broker.initial = {'certificationPlan': {'mode': 'auth-preparation'}, 'browserPlan': {'browserOrigin': origin},
            'scopedCronSecret': 'owned-bearer'}
        with patch.object(day_two, 'observe', return_value={'nativeEnabled': False}) as workload, \
                patch.object(day_two, 'observe_browser_origin', return_value={'browserOrigin': origin}) as browser, \
                patch.object(parent.native, 'observe', side_effect=AssertionError('expired probe accessed')) as legacy:
            for mode in ('auth-preparation', 'browser-pending'):
                broker.initial['certificationPlan']['mode'] = mode
                self.assertEqual(broker._observe_browser_origin(), browser.return_value)
                args, kwargs = browser.call_args
                self.assertIs(args[0], context)
                self.assertIs(args[1].client, broker.vercel)
                self.assertIs(args[1].verify, broker.check)
                self.assertEqual(args[2], 'owned-bearer')
                self.assertEqual(kwargs, broker.profile_arguments())
            broker.initial['browserPlan']['browserOrigin'] = 'https://other.invalid'
            with self.assertRaisesRegex(ValueError, 'CANONICAL_BROWSER_PLAN_REQUIRED'):
                broker._observe_browser_origin()
            broker.initial['certificationPlan']['mode'] = 'direct-worker'
            with self.assertRaisesRegex(ValueError, 'CANONICAL_BROWSER_PLAN_REQUIRED'):
                broker._observe_browser_origin()
            self.assertEqual(broker._native_observe(), {'nativeEnabled': False})
            workload.assert_called_once()
            legacy.assert_not_called()

    def test_profiled_worker_accepts_only_the_pinned_runtime_bearer(self):
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        broker.check = lambda: None
        broker.external_armed = True
        broker.initial = {'certificationPlan': {'mode': 'direct-worker'}, 'scopedCronSecret': 'owned-bearer'}
        broker.worker_stage = unittest.mock.Mock()
        for operation, handler in (('worker-credential', 'preflight_credential'), ('worker-invoke', 'invoke_direct')):
            target = getattr(broker.worker_stage, handler)
            for secret in (None, 'different', 'owned-bearer ', 'invalid非'):
                with self.subTest(operation=operation, secret=secret), \
                        self.assertRaisesRegex(ValueError, 'WORKER_DAY_TWO_CREDENTIAL_MISMATCH'):
                    broker.worker_operation(operation, {'secret': secret})
            target.assert_not_called()
            self.assertIs(broker.worker_operation(operation, {'secret': 'owned-bearer'}), target.return_value)
            target.assert_called_once_with('owned-bearer')

    def test_profiled_fault_correlates_an_admitted_503_to_its_completed_operation(self):
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        producer, source, target = 'a' * 64, 'b' * 40, 'c' * 64
        operation = '10000000-0000-4000-8000-000000000001'
        native = {'initialEpoch': '2', 'planSha256': 'd' * 64, 'projectId': 'owned', 'deploymentId': 'dpl_Owned',
                  'sourceCommit': source, 'targetSha256': target, 'producer': {'producerSha256': producer, 'role': {'oid': '100'}}}
        broker.initial = {'nativePlan': native, 'certificationPlan': {'mode': 'fault-before-upstream'}}
        broker.action_id = lambda: 'owned-fault'
        stamp = '2026-11-07T00:00:00.000Z'
        event = {'version': 1, 'status': 'P2_LIFECYCLE_CRON_ADMITTED', 'environment': 'staging', 'projectId': 'owned',
                 'operationId': operation, 'producerSha256': producer, 'sourceCommit': source, 'targetSha256': target,
                 'epoch': '3', 'kind': 'recovery'}
        detail = {'version': 1, 'kind': 'vercel-native-request-details', 'reviewerGithubUserId': '8996309', 'projectId': 'owned',
                  'deploymentId': 'dpl_Owned', 'path': parent.native.PATH, 'method': 'GET', 'providerRequestTypeFilter': 'cron',
                  'providerRequestId': 'owned-request', 'startedAt': stamp, 'completedAt': stamp, 'httpStatus': 503,
                  'logScope': 'this-provider-request-details', 'admittedLogLine': json.dumps(event)}
        artifact = {'version': 1, 'kind': 'operator-recorded-request-details', 'reviewerGithubUserId': '8996309',
                    'certificationActionId': 'owned-fault', 'nativePlanSha256': native['planSha256'], 'windowEpoch': '3',
                    'recordedAt': stamp, 'observations': [detail]}
        record = {'id': operation, 'kind': 'recovery', 'state': 'completed', 'completed_at': stamp, 'reconciliation_sha256': None,
                  'epoch': '3', 'producer_sha256': producer, 'source_sha': source, 'role_oid': '100'}
        for state, log, expected in (('completed', detail['admittedLogLine'], True), ('uncertain', detail['admittedLogLine'], False),
                                     ('completed', None, False)):
            with self.subTest(state=state, admitted=bool(log)), tempfile.TemporaryDirectory() as directory:
                broker.directory = Path(directory)
                detail['admittedLogLine'] = log
                raw = base64.b64encode(json.dumps(artifact).encode()).decode()
                evidence = broker._request_evidence(raw, {'operations': [{**record, 'state': state}]})
                self.assertIs(evidence['retryableFailureCorrelated'], expected)

    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temporary.cleanup)
        cls.operators = Path(temporary.name).resolve()
        cls.commit = 'a' * 40
        cls.source = cls.operators / cls.commit
        names = tracked_source_fixture(Path(__file__).resolve().parents[3], cls.source, include_tests=False)
        cls.files = {name: hashlib.sha256((cls.source / name).read_bytes()).hexdigest() for name in names}
        cls.closure = cls.hash(sorted(cls.files.items()))

    @staticmethod
    def hash(value, *, canonical=False):
        raw = value if isinstance(value, bytes) else json.dumps(value, separators=(',', ':'), sort_keys=canonical).encode()
        return hashlib.sha256(raw).hexdigest()

    def setUp(self):
        runtime = release_test.RuntimeReleaseTests()
        runtime.setUp()
        self.addCleanup(runtime.tearDown)
        fixture = runtime.fixture
        fixture.add_frontend()
        phase = {'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + 'b' * 64}
        for carrier in (fixture.release, fixture.release['frontendMigration'], *fixture.jobs.values()):
            carrier.update(phase)
        for name in ('course', 'community'):
            fixture.jobs[name]['target']['serverMajor'] = 18
        fixture.jobs['frontend']['target'].update(approvedPendingTags=[], allowEmptyBootstrap=False)
        fixture.release['runtime']['composeSha256'] = 'sha256:' + self.files['ops/platform/compose.yaml']
        self.profile = fixture.profiled()
        runtime.target.update(version=2, qualificationTargetProfile=self.profile)
        runtime.gateway.update(ownerId=parent.vercel.TEAM, projectId=parent.vercel.PROJECTS['staging'],
                               publicHost='api-staging.lashher.com')
        runtime.save('runtime.json', runtime.target)
        runtime.save('gateway.json', runtime.gateway)
        root = runtime.root.resolve()
        bundle, configuration, results = (path.resolve() for path in (runtime.bundle, runtime.configuration, runtime.results))
        self.bundle, self.configuration = bundle, configuration
        machine = root / 'machine-id'
        machine.write_text(runtime.target['hostMachineId'] + '\n')
        for key, value in {'PROFILED_RELEASE_ROOT': root, 'PROFILED_OPERATOR_ROOT': self.operators,
                           'PROFILED_MACHINE_ID': machine}.items():
            guard = patch.object(parent, key, value)
            guard.start()
            self.addCleanup(guard.stop)

        release, job = fixture.release, fixture.jobs['frontend']
        self.release_id = release['releaseId']
        self.original = results / ('p2-profiled-current-' + self.release_id)
        self.original.mkdir(mode=0o700)
        self.frontend = root / 'frontend'
        self.frontend.mkdir(mode=0o700)
        config = parent.staging_state.configuration_hashes(configuration)
        target = parent.frontend_target_sha256(job['target'])
        owner = {'name': 'owner_role', 'oid': '11111'}
        producer = {'producerSha256': '3' * 64, 'role': {'name': job['target']['runtimeRole'], 'oid': '22222'}}
        binding = {'mode': 'enforce', 'targetSha256': target, 'producerSha256': producer['producerSha256'],
                   'sourceCommit': self.commit, 'roleName': job['target']['runtimeRole']}
        from p2_certification_profile import PROFILE
        certification = copy.deepcopy(PROFILE)
        profiled = {'version': 2, 'qualificationTargetProfile': self.profile}
        inventory = {**profiled, 'environment': 'staging', 'actionId': self.release_id, 'sourceCommit': self.commit,
                     'targetSha256': target, 'owner': owner, 'producers': [producer], 'admissionMode': 'existing',
                     'runtimeProducerSha256': producer['producerSha256'], 'certification': certification,
                     'restoration': {**profiled, 'newWork': False, 'recovery': False, 'nativeSchedulesEnabled': False,
                                     'providerIngress': 'keep-retired', 'gatewayBindingSha256': '8' * 64}}
        ready = self.produce_ready(release, root, certification['featureControls'], binding)
        ready_hashes = {name: self.hash(raw) for name, raw in ready.items()}
        candidate_hash = self.hash((bundle / 'release.candidate.json').read_bytes())
        candidate_object_hash = self.hash(release, canonical=True)
        job_hashes = {name: self.hash((bundle / 'jobs' / (name + '.json')).read_bytes()) for name in ('course', 'community')}
        inventory_hash = self.hash(inventory)
        workload_hash = ready_hashes['frontend-workload-outcome.json']
        native = {**profiled, 'environment': 'staging', 'actionId': self.release_id, 'projectId': release['workload']['projectId'],
                  'sourceCommit': self.commit, 'candidateSha256': candidate_object_hash,
                  'phase2ContractManifestSha256': phase['phase2ContractManifestSha256'], 'sourcePolicy': {},
                  'deploymentId': 'dpl_new', 'deploymentUrl': 'https://owned-fixture.vercel.app',
                  'configurationRecordSha256': workload_hash, 'featureControls': certification['featureControls'],
                  'targetSha256': target, 'target': {key: job['target'][key] for key in parent.NATIVE_TARGET_FIELDS},
                  'owner': owner, 'producer': producer, 'initialEpoch': '1',
                  'schedule': {'path': parent.native.PATH, 'schedule': parent.native.SCHEDULE}, 'windowSeconds': 60, 'drainSeconds': 15,
                  'commandWitnesses': [{'commandId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'accountVersion': '1', 'action': 'suspend'}],
                  'writerAdmissionBinding': binding, 'finalDisposition': 'disabled-and-admission-closed', 'providerQueuedInventory': None,
                  'automaticReplayAllowed': False, 'migrationAuthorized': False, 'wholeReleaseAccepted': False}
        native['planSha256'] = self.hash(native, canonical=True)
        action = 'owned-certification'
        base = {**profiled, **phase, 'environment': 'staging', 'sourceCommit': self.commit, 'candidateSha256': candidate_hash,
                'targetSha256': target, 'inventorySha256': inventory_hash}
        release_record = {**base, 'releaseId': self.release_id, 'configurationSha256': config,
                          **dict.fromkeys(parent.TERMINAL_FALSE_FIELDS, False)}
        self.started = {**release_record, 'status': 'P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW', 'apiJobSha256': job_hashes}
        self.terminal = {**release_record, 'status': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
                         **dict.fromkeys(parent.TERMINAL_HASH_FIELDS, '7' * 64), 'frontendWorkloadReceiptSha256': workload_hash}
        self.write_host('p2-profiled-current-started.json', self.started)
        self.write_host('p2-profiled-current-outcome.json', self.terminal)
        local = json.dumps(self.terminal, separators=(',', ':')).encode() + b'\n'
        self.plan = {**base, 'certificationActionId': action, 'originalReleaseId': self.release_id, 'operatorSourceCommit': self.commit,
                     'candidateObjectSha256': candidate_object_hash, 'configurationSha256': self.hash(config),
                     'mode': 'contain-native', 'startState': 'already-closed', 'initialEpoch': '1',
                     'browserPlanSha256': None, 'workerPlan': None, 'workerPlanSha256': None,
                     'configurationCanonicalSha256': self.hash(config, canonical=True), 'runtimeInventorySha256': '4' * 64,
                     'gatewayProcessSha256': '5' * 64, 'gatewayConfigurationSha256': config['gateway.json'],
                     'operatorSourceClosureSha256': self.closure, 'nativePlan': native, 'persistenceReaderEligible': True,
                     'requestEvidenceDescriptorSha256': None, 'faultSelection': None, 'readyReceiptSha256': ready_hashes,
                     'maximumSeconds': 900, 'finalDisposition': 'native-disabled-and-both-admissions-closed',
                     'apiJobSha256': job_hashes, 'originalReleaseReceiptSha256': self.hash(local),
                     'originalReleasePlanSha256': '6' * 64, **dict.fromkeys(parent.PROFILED_PLAN_FALSE, False)}
        self.initial = {**profiled, 'mode': parent.PROFILED_CERTIFICATION_MODE, 'environment': 'staging',
                        'sourceCommit': self.commit, 'sourceSha256': self.files, 'sourceClosureSha256': self.closure,
                        'hostMachineId': runtime.target['hostMachineId'], 'bundle': str(bundle), 'configuration': str(configuration),
                        'results': str(results), 'candidate': release, 'candidateSha256': candidate_hash, 'configurationSha256': config,
                        'apiJobSha256': job_hashes, 'frontendJob': job, 'frontendBaseline': json.loads((bundle / 'schema/frontend.json').read_bytes()),
                        'targetSha256': target, 'owner': owner, 'inventory': inventory, 'inventorySha256': inventory_hash,
                        'certification': certification, 'expectedWriterAdmissionBinding': binding, 'certificationActionId': action,
                        'certificationPlan': self.plan, 'originalReleaseReceipt': base64.b64encode(local).decode(),
                        'readyReceipts': {name: base64.b64encode(raw).decode() for name, raw in ready.items()}}
        self.rehash()

    def produce_ready(self, release, root, controls, binding):
        """Run the real receipt writers with owned projected Vercel/probe responses."""
        vercel, frontend = parent.vercel, parent.frontend_probe
        project_id = release['workload']['projectId']
        identity = {'version': 2, 'qualificationTargetProfile': self.profile, 'environment': 'staging',
                    'projectId': project_id, 'sourceCommit': self.commit, 'releaseId': self.release_id}
        promoted = False
        def request(method, path, _body=None):
            nonlocal promoted
            if (method, path) == ('POST', '/v13/deployments'):
                return {'id': 'dpl_new'}
            if (method, path) == ('POST', f'/v10/projects/{project_id}/promote/dpl_new'):
                promoted = True
                return {}
            if (method, path) == ('GET', '/v13/deployments/dpl_new?withGitRepoInfo=true'):
                return {'id': 'dpl_new', 'projectId': project_id, 'target': 'production', 'url': 'owned-fixture.vercel.app',
                        'readyState': 'READY', 'gitSource': {'type': 'github', 'repoId': vercel.REPOSITORY_ID, 'sha': self.commit},
                        'meta': {'lashReleaseId': self.release_id}}
            if method == 'GET' and path in (f'/v9/projects/{project_id}', f'/v9/projects/{project_id}?rollbackInfo=true'):
                return {'id': project_id, 'accountId': vercel.TEAM, 'link': {'type': 'github', 'repoId': vercel.REPOSITORY_ID},
                        'targets': {'production': {'id': 'dpl_new' if promoted else 'dpl_old'}}, 'crons': {'disabledAt': 1},
                        'protectionBypass': {'fixture-bypass': {'scope': 'automation-bypass'}},
                        'lastAliasRequest': {'type': 'promote', 'jobStatus': 'succeeded', 'requestedAt': 2 if promoted else 1,
                                             'toDeploymentId': 'dpl_new' if promoted else 'dpl_old'}}
            raise AssertionError('unexpected modeled provider route')
        client = SimpleNamespace(request=request)
        origin = 'https://api-staging.lashher.com'
        private = root / 'private-probe'
        private.mkdir(mode=0o700)
        migrate.write_json(private, frontend.PRIVATE_FILE, {**identity, 'secret': 'e' * 64,
                           'gatewayOrigin': origin, 'expiresAt': int(time.time() * 1000) + 60_000})
        def probe(_url, _secret, _bypass, challenge, *, mode):
            self.assertEqual(mode, 'phase2')
            return {**identity, 'version': 1, 'status': 'FRONTEND_WORKLOAD_PROBE_PASS', 'challenge': challenge,
                    'checks': ['gateway-course-catalog-p2'], 'contractPhase': 'p2', 'gatewayOrigin': origin,
                    'featureControls': controls, 'writerAdmissionBinding': binding}
        def verify(selected, _deployment):
            return frontend.verify(client, selected, self.frontend, private, probe_client=SimpleNamespace(request=probe),
                                   expected_feature_controls=controls, expected_writer_admission_binding=binding,
                                   expected_profile=self.profile)
        vercel.stage_frontend(client, release, self.frontend, expected_profile=self.profile)
        vercel.promote_frontend(client, release, self.frontend, verify, expected_profile=self.profile)
        return {name: (self.frontend / name).read_bytes() for name in parent.READY_FILES}

    def write_host(self, name, record):
        path = self.original / name
        path.unlink(missing_ok=True)
        migrate.write_json(self.original, name, record)

    def rehash(self):
        self.plan.pop('planSha256', None)
        self.plan['planSha256'] = self.hash(self.plan, canonical=True)

    def replace_ready(self, name, raw):
        self.initial['readyReceipts'][name] = base64.b64encode(raw).decode()
        self.plan['readyReceiptSha256'][name] = self.hash(raw)
        self.rehash()

    def prepare(self):
        with patch.object(parent.subprocess, 'run', side_effect=AssertionError('unexpected child')), \
             patch.object(migrate, 'write_json', side_effect=AssertionError('unexpected receipt write')), \
             patch.object(parent.vercel.Client, 'request', side_effect=AssertionError('unexpected provider request')):
            return parent.prepare_profiled_current_certification_input(self.initial, self.source)

    def test_stalled_renewal_extends_only_the_outer_observation_lease(self):
        actor, course, lesson = [f'10000000-0000-4000-8000-{index:012d}' for index in (1, 2, 3)]
        lesson_api = f'/course/v1/student/lessons/{lesson}'
        targets = (f'/course/v1/student/courses/{course}', lesson_api, f'/course/v1/student/progress?lessonId={lesson}',
                   f'{lesson_api}/quiz', f'{lesson_api}/quiz/attempts', f'{lesson_api}/playback')
        action = {'stage': 'stalled-playback-renewal', 'actorId': actor, 'windowSeconds': 300,
                  'stalledRenewalAction': {'courseId': course, 'lessonId': lesson, 'playbackIdSha256': '9' * 64},
                  'requests': [{'method': 'GET', 'target': target, 'bodySha256': self.hash(b''), 'uses': 1} for target in targets]}
        baseline = self.plan['nativePlan']
        control = {key: baseline[key] for key in parent.BROWSER_CONTROL_FIELDS if key not in ('purpose', 'planSha256')}
        control.update(purpose='scoped-certification-control-only', commandWitnesses=[])
        control['planSha256'] = self.hash(control, canonical=True)
        self.plan.update(mode='interactive-browser', maximumSeconds=900, scopedAction=action, nativePlan=control)
        self.rehash()
        self.assertEqual(parent._profiled_initial(self.initial, self.profile), self.plan)
        for seconds, scoped, code in (
            (300, action, 'PLAN_BINDING_REQUIRED'),
            (900, {**action, 'windowSeconds': 900}, 'ACTION_REQUIRED'),
            (900, {'stage': 'identity', 'actorId': None, 'windowSeconds': 60, 'requests': [],
                   'identityActor': {'actorKind': 'customer', 'actorId': actor}}, 'PLAN_BINDING_REQUIRED'),
        ):
            self.plan.update(maximumSeconds=seconds, scopedAction=scoped)
            self.rehash()
            with self.subTest(seconds=seconds, stage=scoped['stage']), self.assertRaisesRegex(ValueError, code):
                parent._profiled_initial(self.initial, self.profile)

    def test_current_packet_binds_actual_sources_jobs_and_receipts_without_effects(self):
        before = sorted(self.original.iterdir())
        result = self.prepare()
        self.assertEqual(result['status'], 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED')
        self.assertEqual(result['qualificationTargetProfile'], self.profile)
        self.assertEqual(result['originalReleaseReceiptSha256'], self.plan['originalReleaseReceiptSha256'])
        self.assertEqual(result['hostOriginalReleaseReceiptSha256'], self.hash((self.original / 'p2-profiled-current-outcome.json').read_bytes()))
        self.assertNotEqual(result['hostOriginalReleaseReceiptSha256'], result['originalReleaseReceiptSha256'])
        for field in ('originalReleasePlanHashHostVerified', 'executionEligible', 'providerTouched', 'admissionChanged', 'releaseAccepted'):
            self.assertIs(result[field], False)
        self.assertEqual(sorted(self.original.iterdir()), before)
        self.write_host('p2-profiled-current-started.json', {**self.started, 'reviewedPlanSha256': self.plan['originalReleasePlanSha256']})
        self.assertIs(self.prepare()['originalReleasePlanHashHostVerified'], True)
        self.write_host('p2-profiled-current-started.json', {**self.started, 'reviewedPlanSha256': '1' * 64})
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_PLAN_CHANGED'):
            self.prepare()

    def test_fixed_host_entry_accepts_one_complete_profiled_packet(self):
        raw = json.dumps(self.initial).encode() + b'\n'
        output = io.StringIO()
        with patch.object(parent.sys, 'argv', ['p2_certification_parent.py', '--plan-profiled-current']), \
             patch.object(parent.sys, 'platform', 'linux'), patch.object(parent.os, 'geteuid', return_value=0), \
             patch.object(parent, '__file__', str(self.source / 'ops/platform/host/p2_certification_parent.py')), \
             patch.object(parent.sys, 'stdout', output), \
             patch.object(parent.subprocess, 'run', side_effect=AssertionError('unexpected child')), \
             patch.object(parent.vercel.Client, 'request', side_effect=AssertionError('unexpected provider request')):
            with patch.object(parent.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(raw))):
                parent.main()
            with patch.object(parent.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(raw + raw))):
                with self.assertRaisesRegex(ValueError, 'QUALIFICATION_TARGET_PROFILE_REFUSED'):
                    parent.main()
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        result = json.loads(lines[0])
        self.assertEqual(result['status'], 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED')
        self.assertIs(result['executionEligible'], False)

    def test_profiled_supervisor_dispatches_only_the_source_broker_and_containment_callbacks(self):
        argv=['p2_certification_parent.py','--supervisor-profiled-current']
        raw=json.dumps(self.initial).encode()+b'\n'
        with patch.object(parent.sys,'argv',argv), \
             patch.object(parent.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw))), \
             patch.object(parent,'cache_certification_core') as cache, patch.object(supervisor,'supervise') as supervise:
            parent.main()
            self.assertEqual(cache.call_args.kwargs,{'expected_profile':self.profile})
            self.assertEqual(supervise.call_args.kwargs,{
                'broker_type':parent.P2ProfiledCertificationBroker,'observer_type':parent.P2CertificationPhysicalObserver,
                'observer_source':parent.OBSERVER,'layout':supervisor.PROFILED_CERTIFICATION_LAYOUT,
                'native_containment':parent.contain_profiled_certification_native,
                'frontend_containment':parent.contain_profiled_certification_frontend,
            })
        for changed in ({'mode':'p2-bounded-certification'},{'_guardLockDescriptor':7}):
            raw=json.dumps({**self.initial,**changed}).encode()+b'\n'
            with patch.object(parent.sys,'argv',argv), \
                 patch.object(parent.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw))), \
                 patch.object(parent,'cache_certification_core',side_effect=AssertionError('unexpected source read')):
                with self.assertRaisesRegex(ValueError,'FIXED_MODE_REQUIRED'):
                    parent.main()

    def test_fixed_context_rejects_legacy_and_private_fields_before_source_io(self):
        changes = ({'version': 1}, {'qualificationTargetProfile': None}, {'credentials': {}}, {'mode': 'p2-bounded-certification'})
        with patch.object(parent, 'verify_profiled_current_source_closure', side_effect=AssertionError('source read')):
            for changeset in changes:
                with self.subTest(fields=tuple(changeset)), self.assertRaises(ValueError):
                    parent.prepare_profiled_current_certification_input({**self.initial, **changeset}, self.source)
            self.plan['mode'] = 'browser-pending'
            self.rehash()
            with self.assertRaisesRegex(ValueError, 'PLAN_BINDING_REQUIRED'):
                self.prepare()

    def test_browser_and_worker_packets_join_the_same_source_suspension(self):
        profiled = {'version': 2, 'qualificationTargetProfile': self.profile}
        baseline = copy.deepcopy(self.plan['nativePlan'])
        action = 'owned-browser'
        suspension = {
            **profiled, 'status': 'P2_LIFECYCLE_SUSPENSION_SOURCE_PLAN', 'environment': 'staging',
            'profile': 'normal-ui-suspension-pending-v1', 'actionId': action, 'releaseId': self.release_id,
            'operatorSourceCommit': self.commit, 'operatorSourceEligibility': 'same-as-immutable-frontend-candidate',
            'configurationSha256': self.plan['configurationCanonicalSha256'], 'resourceBindingSha256': '2' * 64,
            'hostMachineId': self.initial['hostMachineId'], 'browserOrigin': parent.canonical_browser.ORIGIN,
            'browserProgramSha256': '3' * 64, 'windowSeconds': 840, 'drainSeconds': 15,
            'initialAdmission': {'newWork': True, 'recovery': False},
            'finalDisposition': 'native-off-and-admission-closed',
            **{key: self.plan[key] for key in ('candidateSha256', 'candidateObjectSha256', 'sourceCommit', 'targetSha256')},
            **{key: baseline[key] for key in ('deploymentId', 'deploymentUrl', 'configurationRecordSha256', 'featureControls', 'writerAdmissionBinding')},
            **{key: self.files[path] for key, path in (
                ('pendingProgramSha256', 'ops/platform/p2-lifecycle-pending-probe.mjs'),
                ('parentProgramSha256', 'ops/platform/p2-lifecycle-suspension-evidence.mjs'),
                ('hostProgramSha256', 'ops/platform/host/p2_lifecycle_suspension_evidence.py'))},
            **dict.fromkeys(('fixtureCreationAuthorized', 'workerInvocationAuthorized', 'automaticReplayAllowed', 'releaseAccepted'), False),
        }
        self.initial['sourceSuspensionPlan'] = suspension
        suspension_hash = self.hash(suspension, canonical=True)
        for mode, certification_id, epoch, seconds in (
            ('auth-preparation', 'owned-auth', '1', 300), ('browser-pending', action, '3', 900)
        ):
            control = {key: baseline[key] for key in parent.BROWSER_CONTROL_FIELDS if key not in ('purpose', 'planSha256')}
            control.update(purpose='browser-authentication-control-only', initialEpoch=epoch, commandWitnesses=[])
            control['planSha256'] = self.hash(control, canonical=True)
            self.initial['certificationActionId'] = certification_id
            self.plan.update(mode=mode, certificationActionId=certification_id, initialEpoch=epoch,
                             maximumSeconds=seconds, browserPlanSha256=suspension_hash, nativePlan=control)
            self.rehash()
            self.assertIs(self.prepare()['executionEligible'], False)

        baseline.pop('planSha256')
        baseline['initialEpoch'] = '6'
        baseline['planSha256'] = self.hash(baseline, canonical=True)
        worker = {
            **profiled, 'environment': 'staging', 'profile': 'direct-known-suspension-v1', 'actionId': 'owned-worker',
            'configurationSha256': self.plan['configurationCanonicalSha256'], 'nativePlanSha256': baseline['planSha256'],
            'suspensionPlanSha256': suspension_hash, 'commandIndex': 0, 'workerInvocations': 1,
            'requiredPrivateInputs': ['FRONTEND_STAGING_CRON_SECRET', 'providerContext.frontendRuntimeDatabaseUrl'],
            'invocationClass': 'direct-source-authenticated-cron', 'finalDisposition': 'native-off-and-admission-closed',
            **{key: self.plan[key] for key in ('candidateSha256', 'candidateObjectSha256', 'sourceCommit', 'targetSha256',
                'gatewayProcessSha256', 'gatewayConfigurationSha256')},
            **dict.fromkeys(('pendingRecordSha256', 'canonicalCommandSha256', 'denialProgramSha256'), '4' * 64),
            **dict.fromkeys(('nativeInvocationQualified', 'automaticRetryAllowed', 'releaseAccepted'), False),
            **{key: self.files[path] for key, path in (
                ('sourceProgramSha256', 'ops/platform/p2-lifecycle-worker-evidence.mjs'),
                ('hostProgramSha256', 'ops/platform/host/p2_lifecycle_worker_evidence.py'),
                ('denialSourceSha256', 'ops/platform/p2-lifecycle-receiver-denial.mjs'))},
        }
        self.initial['certificationActionId'] = 'owned-worker'
        self.plan.update(mode='direct-worker', certificationActionId='owned-worker', initialEpoch='5',
                         browserPlanSha256=None, nativePlan=baseline, workerPlan=worker,
                         workerPlanSha256=self.hash(worker, canonical=True))
        self.rehash()
        self.assertIs(self.prepare()['executionEligible'], False)
        negative = {'profile': 'suspended-head-negatives-v2',
                    'sourceSha256': self.files['ops/platform/p2-lifecycle-receiver-post.mjs'],
                    'hostSourceSha256': self.files['ops/platform/host/p2_scoped_lifecycle_receiver_negatives.py']}
        worker['receiverNegatives'] = negative
        self.plan['workerPlanSha256'] = self.hash(worker, canonical=True)
        self.rehash()
        self.assertIs(self.prepare()['executionEligible'], False)
        worker['receiverNegatives'] = {**negative, 'sourceSha256': '8' * 64}
        self.plan['workerPlanSha256'] = self.hash(worker, canonical=True)
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'RECEIVER_NEGATIVE_SOURCE_REQUIRED'):
            self.prepare()
        del worker['receiverNegatives']
        self.plan['workerPlanSha256'] = self.hash(worker, canonical=True)
        worker['pendingRecordSha256'] = '5' * 64
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'SOURCE_WORKER_REQUIRED'):
            self.prepare()

    def test_profiled_guard_frontend_proof_requires_bound_output_and_reaped_child(self):
        initial = {**self.initial, 'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture-only'}}
        armed = {'plan': self.plan}
        value = {'version': 2, 'qualificationTargetProfile': self.profile,
                 'status': 'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_CLOSED',
                 'environment': 'staging', 'releaseId': self.release_id,
                 **{key: self.plan[key] for key in ('sourceCommit', 'certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')},
                 'frontendAdmissionClosed': True, 'sqlReplayed': False, 'releaseAccepted': False}
        program = self.source / 'ops/platform/p2-certification-current-probe.mjs'
        core = self.source / 'ops/platform/p2-recovery-current-probe.mjs'
        for changes, remaining, accepted in (({}, '', True), ({'targetSha256': '1'*64}, '', None), ({}, 'running', None)):
            with self.subTest(changes=changes, remaining=remaining), \
                 patch.object(parent, '_profiled_guard_context', return_value=self.profile), \
                 patch.object(parent, 'private_observer_program', return_value=program), \
                 patch.object(parent, '_cache_core', return_value=core), \
                 patch.object(parent.runtime, 'command', return_value=remaining), \
                 patch.object(parent.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps({**value, **changes}),stderr='')) as child:
                self.assertEqual(parent.contain_profiled_certification_frontend(initial, armed, self.source),
                                 {'frontendAdmissionClosed': accepted, 'frontendCloseAttempted': True})
                args, kwargs = child.call_args_list[0]
                self.assertEqual(args[0][-1], '--profiled-current-guard-fence')
                self.assertEqual(json.loads(kwargs['input']), armed)
                self.assertEqual(len(child.call_args_list), 2)
        with patch.object(parent, '_profiled_guard_context', side_effect=ValueError('owned refusal')), \
             patch.object(parent.subprocess, 'run', side_effect=AssertionError('guard refused before Docker')):
            self.assertEqual(parent.contain_profiled_certification_frontend(initial, armed, self.source),
                             {'frontendAdmissionClosed': None, 'frontendCloseAttempted': False})

    def test_profile_and_hash_are_required_on_the_nested_native_plan(self):
        native_plan = self.plan['nativePlan']
        native_target = native_plan['target']
        native_plan['target'] = {key: value for key, value in native_target.items() if key != 'qualificationTargetProfile'}
        native_plan.pop('planSha256')
        native_plan['planSha256'] = self.hash(native_plan, canonical=True)
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'QUALIFICATION_TARGET_PROFILE_REQUIRED'):
            self.prepare()
        native_plan['target'] = native_target
        self.rehash()
        with self.assertRaisesRegex(ValueError, 'NATIVE_PLAN_REQUIRED'):
            self.prepare()

    def test_rehashed_ready_receipts_still_require_source_shapes_and_causal_joins(self):
        for name, changes, reason in (
            ('frontend-build-created.json', {'qualificationTargetProfile': None}, 'QUALIFICATION_TARGET_PROFILE'),
            ('frontend-build-outcome.json', {'previousDeploymentId': 'dpl_unrelated'}, 'STAGED_IDENTITY_REQUIRED'),
            ('frontend-build-outcome.json', {'url': 'https://other.vercel.app'}, 'STAGED_IDENTITY_REQUIRED'),
            ('frontend-build-started.json', {'unexpected': 'private'}, 'READY_RECEIPT_FIELDS_REQUIRED'),
            ('frontend-promotion-outcome.json', {'aliasRequestedAt': 1}, 'PROMOTION_REQUIRED'),
        ):
            with self.subTest(name=name, fields=tuple(changes)):
                raw = (self.frontend / name).read_bytes()
                self.replace_ready(name, json.dumps({**json.loads(raw), **changes}).encode())
                with self.assertRaisesRegex(ValueError, reason):
                    self.prepare()
                self.replace_ready(name, raw)
        name = 'frontend-promotion-started.json'
        self.replace_ready(name, (self.frontend / name).read_bytes().replace(b'"version": 2', b'"version": 2, "version": 2'))
        with self.assertRaisesRegex(ValueError, 'QUALIFICATION_TARGET_PROFILE_REFUSED'):
            self.prepare()

    def test_original_terminal_must_exist_as_private_host_bytes_and_bind_workload(self):
        name = 'p2-profiled-current-outcome.json'
        path = self.original / name
        raw = path.read_bytes()
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        local = self.original / 'local-copy.json'
        local.write_bytes(raw)
        local.chmod(0o600)
        path.symlink_to(local)
        with self.assertRaises(OSError):
            self.prepare()
        self.write_host(name, {**self.terminal, 'frontendWorkloadReceiptSha256': '1' * 64})
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_RELEASE_REQUIRED'):
            self.prepare()

    def test_raw_api_job_and_configuration_must_match_actual_host_files(self):
        for path in (self.bundle / 'jobs/course.json', self.configuration / 'course-api.env'):
            raw = path.read_bytes()
            try:
                path.write_bytes(raw + b'\n')
                with self.assertRaisesRegex(ValueError, 'ACTUAL_RELEASE_INPUT_REQUIRED'):
                    self.prepare()
            finally:
                path.write_bytes(raw)

    def physical_fixture(self):
        selected, jobs = migrate.make_plan(self.bundle, expected_profile=self.profile)
        job = jobs['frontend']['job']
        target = self.plan['nativePlan']['target']
        owner = self.initial['owner']
        witness = {key: [] for key in ('commands', 'deliveries', 'orderViolations', 'operations')}
        admission = {'epoch': self.plan['initialEpoch'], 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
        after = [{'hash': '1' * 64, 'created_at': '100'}]
        receipt = {**job, 'target': target, 'status': 'P2_CERTIFICATION_DATABASE_CURRENT', 'service': 'frontend',
                   'certificationActionId': self.initial['certificationActionId'], 'planSha256': self.plan['planSha256'],
                   'candidateSha256': self.initial['candidateSha256'], 'targetSha256': self.initial['targetSha256'],
                   'after': after, 'journalSha256': self.hash(after), 'witness': witness, 'witnessSha256': self.hash(witness),
                   'owner': owner, 'runtime': self.plan['nativePlan']['producer']['role'], 'retiredLogins': [], 'admission': admission,
                   'schemaVerified': True, 'runtimeRoleVerified': True, 'oldLoginsDenied': True, 'oldRoleSessions': 0,
                   'sqlReplayed': False, 'trafficAuthorized': False}
        request = {'version': 2, 'qualificationTargetProfile': self.profile, 'marker': '7' * 64, 'backendPid': 1234,
                   'backendStart': '2026-11-07 00:00:00+00', 'job': job, 'baseline': self.initial['frontendBaseline'],
                   'owner': owner, 'producers': self.initial['inventory']['producers'], 'plan': self.plan, 'receipt': receipt,
                   'historicalLogins': {'version': 2, 'qualificationTargetProfile': self.profile, 'target': target, 'retiredLogins': []}}
        expected = {'version': 2, 'qualificationTargetProfile': self.profile, 'status': 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED',
                    **{key: request[key] for key in ('marker', 'backendPid', 'backendStart')},
                    **{key: receipt[key] for key in ('environment', 'releaseId', 'sourceCommit', 'targetSha256', 'journalSha256',
                                                    'witnessSha256', 'admission')}}
        guard = self.configuration.parent / 'physical'
        guard.mkdir(mode=0o700)
        program = guard / 'p2-certification-current-probe.mjs'
        program.write_bytes((self.source / parent.OBSERVER).read_bytes())
        original_core = patch.object(parent, '_core', None)
        original_core.start()
        self.addCleanup(original_core.stop)
        parent.cache_certification_core(self.initial, self.source, expected_profile=self.profile)
        kwargs = {'program': program, 'program_sha256': self.files[parent.OBSERVER], 'expected_profile': self.profile}
        observer = parent.P2CertificationPhysicalObserver(selected, request, self.source, 'owned-frontend-input', **kwargs)
        lock = guard / 'host.lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_EXCL, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return SimpleNamespace(selected=selected, jobs=jobs, receipt=receipt, request=request, expected=expected, observer=observer,
                               observer_kwargs=kwargs, lock=lock, fd=fd, calls=[])

    def physical_child(self, fixture, args, **kwargs):
        fixture.calls.append(args)
        if args[1] == 'run':
            flag = '--profiled-known-ack-interrupted' if fixture.request['plan']['mode'] == parent.PROFILED_INTERRUPTED_MODE else '--profiled-current'
            self.assertEqual(args[-2:], [parent.OBSERVER, flag])
            self.assertEqual(args[args.index('--pull') + 1], 'never')
            self.assertIn('dst=/app/' + parent.OBSERVER + ',readonly', ' '.join(args))
            self.assertEqual(kwargs['env']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], 'owned-frontend-input')
            request = json.loads(kwargs['input'])
            operation = request.pop('operation')
            self.assertEqual(request, fixture.request)
            value = {**fixture.expected, **({'witness': fixture.receipt['witness']} if operation == 'witness' else {})}
            return subprocess.CompletedProcess(args, 0, json.dumps(value), '')
        self.assertIn(args[1:3], (['rm', '--force'], ['container', 'ls']))
        return subprocess.CompletedProcess(args, 0, '', '')

    def physical_scope(self, fixture, **overrides):
        kwargs = {'release': fixture.selected, 'jobs': fixture.jobs, 'configuration_sha256': self.initial['configurationSha256'],
                  'certification_plan': self.plan, 'expected_profile': self.profile, 'physical_observer': fixture.observer}
        return parent.P2CertificationScope(fixture.fd, fixture.lock, lambda: None, fixture.receipt,
                                          self.initial['candidateSha256'], **{**kwargs, **overrides})

    def test_lifecycle_runtime_reads_require_the_armed_profiled_broker_and_exact_processes(self):
        from p2_certification_rotation_successor import RotationSuccessorRuntime

        scope = parent.P2CertificationScope.__new__(parent.P2CertificationScope)
        scope._expected_profile = self.profile
        scope.certification_plan = {'mode': 'browser-pending'}
        scope.verify = Mock()
        scope.require_configuration = Mock()
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        broker.scope, scope._profiled_broker = scope, broker
        broker.configuration = Path('/owned/predecessor')
        broker.guard_arm_verified = False
        broker.external_armed = True
        broker.process_snapshot = [{'pid': '2'}]
        broker.runtime_current = [{'service': 'course-api'}]
        broker._runtime_processes = Mock(return_value=broker.process_snapshot)
        broker._read_runtime_inventory = Mock(return_value=broker.runtime_current)
        successor_path = Path('/owned/current-only')
        broker.rotation_successor = RotationSuccessorRuntime(broker.configuration, successor_path,
            'a' * 64, {}, broker.runtime_current, '7')
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE_REQUIRED'):
            scope.read_runtime_inventory(broker.configuration)
        broker._read_runtime_inventory.assert_not_called()
        broker.guard_arm_verified = True
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE_REQUIRED'):
            scope.read_runtime_inventory(successor_path)
        self.assertEqual(scope.read_runtime_inventory(broker.configuration), broker.runtime_current)
        broker._runtime_processes.return_value = [{'pid': '3'}]
        with self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE_CHANGED'):
            scope.read_runtime_inventory(broker.configuration)
        with patch('p2_identity_key_rotation_adapter._runtime_phase_hash', return_value='a' * 64) as checksum:
            self.assertEqual(scope.runtime_mount_configuration('community-api', broker.configuration), successor_path)
            checksum.assert_called_once_with(successor_path)
            checksum.return_value = 'b' * 64
            with self.assertRaisesRegex(ValueError, 'RUNTIME_SCOPE_CHANGED'):
                scope.runtime_mount_configuration('course-api', broker.configuration)
            with self.assertRaisesRegex(ValueError, 'RUNTIME_SERVICE_REFUSED'):
                scope.runtime_mount_configuration('gateway', broker.configuration)

    def test_profiled_observer_uses_only_the_fixed_read_only_source_and_checks_current_identity(self):
        fixture = self.physical_fixture()
        observer = fixture.observer
        with patch.object(parent.subprocess, 'run', side_effect=lambda args, **kwargs: self.physical_child(fixture, args, **kwargs)):
            with self.assertRaisesRegex(ValueError, 'READ_ONLY_OBSERVER_REQUIRED'):
                observer.probe('fence')
            self.assertEqual(fixture.calls, [])
            self.assertEqual(observer.probe('verify-schema'), fixture.expected)
            self.assertEqual(observer.probe('witness')['witness'], fixture.receipt['witness'])
            for field, value in (('version', 1), ('backendPid', 4321), ('backendStart', 'foreign'), ('targetSha256', 'a' * 64),
                                 ('journalSha256', 'b' * 64), ('admission', {**fixture.receipt['admission'], 'active': 1})):
                with self.subTest(field=field):
                    saved = fixture.expected[field]
                    fixture.expected[field] = value
                    with self.assertRaises(ValueError):
                        observer.probe('verify-schema')
                    fixture.expected[field] = saved

    def test_profiled_interrupted_observer_uses_a_fixed_source_flag_and_immutable_witness(self):
        fixture = self.physical_fixture()
        fixture.request['plan'] = {**fixture.request['plan'], 'mode': parent.PROFILED_INTERRUPTED_MODE}
        args = (fixture.selected, fixture.request, self.source, 'owned-frontend-input')
        with self.assertRaisesRegex(ValueError, 'PHYSICAL_REQUEST_REQUIRED'):
            parent.P2CertificationPhysicalObserver(*args, **fixture.observer_kwargs)
        observer = parent.P2CertificationPhysicalObserver(*args, **fixture.observer_kwargs, interrupted=True)
        with patch.object(parent.subprocess, 'run', side_effect=lambda args, **kwargs: self.physical_child(fixture, args, **kwargs)):
            self.assertEqual(observer.probe('observe'), fixture.expected)
            fixture.expected['witnessSha256'] = '9' * 64
            with self.assertRaisesRegex(ValueError, 'INITIAL_CLOSED_BOUNDARY_REQUIRED'):
                observer.probe('observe')

    def test_profiled_scope_requires_exact_live_observer_and_original_host_flock(self):
        fixture = self.physical_fixture()
        observer = fixture.observer
        with self.assertRaisesRegex(ValueError, 'PHYSICAL_SESSION_LOST'):
            self.physical_scope(fixture)
        with self.assertRaisesRegex(ValueError, 'PHYSICAL_SCOPE_REQUIRED'):
            self.physical_scope(fixture, physical_observer=None)
        with self.assertRaisesRegex(ValueError, 'PROFILE_POLICY_REFUSED'):
            parent.P2CertificationPhysicalObserver(fixture.selected, fixture.request, self.source, 'owned-frontend-input',
                                                  **{**fixture.observer_kwargs, 'expected_profile': None})
        with patch.object(parent.subprocess, 'run', side_effect=lambda args, **kwargs: self.physical_child(fixture, args, **kwargs)):
            observer.start(lambda: None)
            try:
                scope = self.physical_scope(fixture)
                self.assertEqual(scope.require_frontend(fixture.selected, fixture.jobs['frontend']), fixture.receipt)
                contender = os.open(fixture.lock, os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(contender)
                with self.assertRaisesRegex(ValueError, 'BINDING_REQUIRED'):
                    scope.require_frontend(fixture.selected, {**fixture.jobs['frontend'], 'schema': b'{}'})
                fixture.lock.rename(fixture.lock.with_name('old.lock'))
                fixture.lock.touch(mode=0o600)
                with self.assertRaisesRegex(ValueError, 'LOCK_IDENTITY_CHANGED'):
                    scope.verify()
            finally:
                observer.stop()
        with self.assertRaisesRegex(ValueError, 'PHYSICAL_SESSION_LOST'):
            observer.verify()

    def test_profiled_api_call_site_consumes_real_typed_checker_and_readback(self):
        from current_databases import read_certification_api_proof
        fixture = self.physical_fixture()
        observer = fixture.observer
        credentials = {'course': 'owned-course-input', 'community': 'owned-community-input'}
        output = self.configuration.parent / 'api-check'
        checked = []
        def command(args, **options):
            if args[1] != 'run':
                self.assertIn(args[1:3], (['rm', '--force'], ['container', 'ls']))
                return subprocess.CompletedProcess(args, 0, b'', b'')
            mount = next(part for part in args if part.endswith('dst=/check/input,readonly'))
            inputs = Path(mount.split(',src=', 1)[1].split(',dst=', 1)[0])
            name = inputs.name.removesuffix('-input')
            checked.append(name)
            self.assertEqual(args[-4:], ['/check/input/current.mjs', '--profiled-current', '/check/input/job.json', '/check/input/schema.json'])
            self.assertEqual((inputs / 'job.json').read_bytes(), (self.bundle / 'jobs' / (name + '.json')).read_bytes())
            self.assertEqual(json.loads(options['input']), {'connectionUrl': credentials[name]})
            self.assertNotIn('FRONTEND_STAGING_MIGRATION_DATABASE_URL', options['env'])
            job = fixture.jobs[name]['job']
            proof = {'version': 2, 'qualificationTargetProfile': self.profile, 'status': 'CURRENT_API_DATABASE_READ_ONLY_PASS',
                     'environment': 'staging', 'service': fixture.jobs[name]['service'], 'pendingTags': [], 'appliedCount': 1,
                     'migrationsExecuted': False, 'transportVerifier': 'selected-image/hasVerifiedMigrationTransport',
                     'checks': ['selected-image-operator-role-policy'], 'checkerSha256': self.files[parent.API_CHECKER],
                     'manifestSha256': self.initial['apiJobSha256'][name], 'schemaBaselineSha256': job['schemaBaselineSha256'],
                     'artifactSha256': job['target']['artifactSha256'],
                     'target': {key: job['target'][key] for key in ('host', 'port', 'database', 'user', 'serverMajor')},
                     **migrate.contract_identity(job)}
            return subprocess.CompletedProcess(args, 0, json.dumps(proof).encode(), b'')
        with patch.object(parent.subprocess, 'run', side_effect=lambda args, **kwargs: self.physical_child(fixture, args, **kwargs)):
            observer.start(lambda: None)
            try:
                scope = self.physical_scope(fixture)
                with self.assertRaisesRegex(ValueError, 'ACTUAL_API_SCOPE_REQUIRED'):
                    parent.observe_certification_api(scope, fixture.jobs, self.source, 'course', output)
                with patch.object(scope, 'run', side_effect=command):
                    proof, outcome = parent.check_profiled_certification_apis(scope, fixture.jobs, self.source, self.bundle,
                        output, credentials, self.files, expected_profile=self.profile)
                self.assertEqual(checked, ['course', 'community'])
                self.assertEqual(outcome['status'], 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED')
                self.assertIs(outcome['migrationsExecuted'], False)
                self.assertIs(outcome['frontendSqlApplied'], False)
                self.assertNotIn('owned-course-input', json.dumps(outcome))
                raw = output / 'community/database-receipt.json'
                raw.write_bytes(raw.read_bytes() + b'\n')
                with self.assertRaisesRegex(ValueError, 'API_RECEIPT_CHANGED'):
                    read_certification_api_proof(proof, scope, fixture.selected, fixture.jobs, expected_profile=self.profile)
            finally:
                observer.stop()


if __name__=='__main__':unittest.main()
