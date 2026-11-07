"""Fixed source dispatch checks. Full recovery is qualified by its owned harness."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import json
import re
import unittest
from p2_release_broker import Broker, PhysicalObserver
from p2_release_supervisor import supervise, DEFAULT_LAYOUT, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT, ROTATION_LAYOUT, cleanup_recovery_current_containers, cleanup_rotation_readonly_containers
from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver
import p2_certification_parent as certification
import p2_release_supervisor as supervisor


class FixedDispatchTests(unittest.TestCase):
    def test_profiled_fault_guard_removes_only_the_original_lease_from_the_original_mount(self):
        from p2_certification_fault import LEASE
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            configuration = root / 'configuration'
            admission = configuration / 'admission'
            fault = root / 'p2-profiled-current-certification-owned' / 'fault'
            admission.mkdir(parents=True, mode=0o700)
            fault.parent.mkdir(mode=0o700)
            fault.mkdir(mode=0o700)
            mount = admission.stat()
            selection = {'stageId': 'owned-503', 'receiver': 'course', 'commandSha256': 'a' * 64}
            plan = {'mode': 'fault-before-upstream', 'faultSelection': selection,
                    'configurationCanonicalSha256': 'b' * 64, 'gatewayProcessSha256': 'c' * 64}
            lease = {'version': 1, 'releaseId': 'original', 'candidateSha256': 'd' * 64, 'mode': '503-before-upstream',
                     'stageId': selection['stageId'], 'receiver': selection['receiver'], 'sourceWitnessSha256': selection['commandSha256'],
                     'configurationSha256': plan['configurationCanonicalSha256'], 'gatewayProcessSha256': plan['gatewayProcessSha256']}
            raw = json.dumps(lease).encode() + b'\n'
            retained = {'version': 2, 'qualificationTargetProfile': dict(profile), 'stageId': selection['stageId'], 'lease': lease,
                        'leaseSha256': supervisor.migrate.file_hash(raw), 'admissionDirectoryDevice': mount.st_dev,
                        'admissionDirectoryInode': mount.st_ino}
            initial = {'version': 2, 'qualificationTargetProfile': dict(profile), 'mode': supervisor.PROFILED_CERTIFICATION_MODE,
                       'certificationPlan': plan, 'certificationActionId': 'owned', 'candidate': {'releaseId': 'original'},
                       'candidateSha256': lease['candidateSha256'], 'configurationSha256': {}, 'configuration': str(configuration),
                       'results': str(root), '_guardLayout': supervisor.PROFILED_CERTIFICATION_LAYOUT}
            path, intent = admission / LEASE, fault / 'fault-arm-intent.json'
            with patch.object(supervisor, 'verify_guard_boundary'), patch.object(supervisor.staging_state, 'configuration_hashes', return_value={}):
                path.write_bytes(raw)
                intent.write_text(json.dumps({**retained, 'admissionDirectoryInode': mount.st_ino + 1}))
                with self.assertRaisesRegex(ValueError, 'FOREIGN_FAULT_LEASE'):
                    supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(path.read_bytes(), raw)
                intent.write_text(json.dumps(retained))
                path.write_bytes(raw + b' ')
                with self.assertRaisesRegex(ValueError, 'FOREIGN_FAULT_LEASE'):
                    supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(path.read_bytes(), raw + b' ')
                path.write_bytes(raw)
                supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertFalse(path.exists())
                supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(json.loads(intent.read_bytes()), retained)

    def test_profiled_certification_requires_all_exact_source_types_and_both_callbacks(self):
        class OwnedBroker(Broker):
            pass
        def native(*_):
            raise AssertionError('native action')
        def frontend(*_):
            raise AssertionError('frontend action')
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        initial = {'version': 2, 'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
                   'mode': supervisor.PROFILED_CERTIFICATION_MODE, 'candidate': {'releaseId': 'original'},
                   'certificationActionId': 'certification-2', '_guardLayout': supervisor.CERTIFICATION_LAYOUT}
        options = {'broker_type': OwnedBroker, 'observer_type': certification.P2CertificationPhysicalObserver,
                   'observer_source': supervisor.CERTIFICATION_OBSERVER, 'layout': supervisor.PROFILED_CERTIFICATION_LAYOUT,
                   'native_containment': native, 'frontend_containment': frontend}
        with patch.object(certification, 'P2ProfiledCertificationBroker', OwnedBroker, create=True), \
             patch.object(certification, 'contain_profiled_certification_native', native, create=True), \
             patch.object(certification, 'contain_profiled_certification_frontend', frontend, create=True), \
             patch.object(supervisor.os, 'geteuid', return_value=1), \
             patch.object(supervisor.migrate, 'make_plan', side_effect=AssertionError('unexpected plan I/O')):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(dict(initial), **options)
            for mismatch in ({'broker_type': Broker}, {'observer_type': PhysicalObserver},
                             {'observer_source': 'ops/platform/p2-profiled-current-probe.mjs'},
                             {'layout': CERTIFICATION_LAYOUT}, {'native_containment': frontend},
                             {'frontend_containment': None}, {'frontend_containment': lambda *_: None}):
                with self.subTest(mismatch=tuple(mismatch)), self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                    supervise(dict(initial), **{**options, **mismatch})
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(dict(initial))
            with self.assertRaisesRegex(ValueError, 'PROFILE_REQUIRED'):
                supervise({key: value for key, value in initial.items() if key != 'qualificationTargetProfile'}, **options)

    def test_profiled_certification_cleanup_only_touches_the_three_fixed_namespaces(self):
        inventory = {'a' * 12: '/lash-p2-certification-observer-' + '1' * 32,
                     'b' * 12: '/lash-p2-certification-api-check-course-' + '2' * 32,
                     'c' * 12: '/lash-p2-profiled-certification-guard-close-' + '3' * 32,
                     'd' * 12: '/lash-p2-profiled-certification-guard-close-' + '3' * 32 + '-foreign',
                     'e' * 12: '/lash-p2-profiled-current-observer-' + '4' * 32}
        calls = []
        def command(args, *_):
            calls.append(args)
            if args[1:3] == ['rm', '--force']:
                del inventory[args[-1]]
                return ''
            pattern = next(value.removeprefix('name=') for value in args if value.startswith('name='))
            return '\n'.join(identity for identity, name in inventory.items() if re.fullmatch(pattern, name))
        with patch.object(supervisor.runtime, 'command', side_effect=command):
            with self.assertRaisesRegex(ValueError, 'CONTAINER_REMAINS'):
                supervisor._profiled_certification_containers(remove=False)
            self.assertTrue(all(args[1:3] == ['container', 'ls'] for args in calls))
            supervisor.cleanup_profiled_certification_containers()
        self.assertEqual(set(inventory), {'d' * 12, 'e' * 12})
        self.assertEqual(sum(args[1:3] == ['rm', '--force'] for args in calls), 3)

    def test_private_json_cannot_select_recovery_program_or_layout(self):
        initial = {'candidate': {'releaseId': 'original'}, '_guardLayout': RECOVERY_LAYOUT,
                   '_guardObserverSource': 'ops/platform/unreviewed.mjs'}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        self.assertEqual(initial['_guardObserverSource'], 'ops/platform/p2-frontend-live-probe.mjs')

    def test_only_fixed_source_recovery_dispatch_is_accepted(self):
        class RecoveryBroker(Broker): pass
        class RecoveryObserver(PhysicalObserver): pass
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-post-sql-recovery', 'recoveryActionId': 'recovery-2'}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial, broker_type=RecoveryBroker, observer_type=RecoveryObserver,
                          observer_source='ops/platform/p2-recovery-current-probe.mjs', layout=RECOVERY_LAYOUT)
        self.assertEqual(initial['_guardLayout'], RECOVERY_LAYOUT)
        for source, layout in [('ops/platform/arbitrary.mjs', RECOVERY_LAYOUT),
                               ('ops/platform/p2-recovery-current-probe.mjs', {**RECOVERY_LAYOUT, 'terminalName': '../out.json'})]:
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, broker_type=RecoveryBroker, observer_type=RecoveryObserver, observer_source=source, layout=layout)

    def test_default_release_selection_preserves_pending_sql_and_same_source_requirements(self):
        initial = {'candidate': {'contractPhase': 'p2', 'environment': 'staging', 'sources': {'frontend': {'commit': 'a'*40}}}, 'sourceCommit': 'a'*40}
        broker = Broker(initial, lambda _: None)
        broker.bundle = broker.configuration = broker.source = Path('/owned')
        jobs = {'frontend': {'job': {'target': {'approvedPendingTags': ['p2']}}}, 'course': {}, 'community': {}}
        with patch('p2_release_broker.runtime.make_plan', return_value=(initial['candidate'],jobs,{},b'compose')):
            self.assertEqual(len(broker.select_release(initial)), 4)
            initial['sourceCommit'] = 'b'*40
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_BINDING_REFUSED'): broker.select_release(initial)
            initial['sourceCommit'] = 'a'*40
            jobs['frontend']['job']['target']['approvedPendingTags'] = []
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_BINDING_REFUSED'): broker.select_release(initial)

    def test_certification_dispatch_requires_source_callable_and_cannot_be_selected_by_json(self):
        class CertificationBroker(Broker): pass
        class CertificationObserver(PhysicalObserver): pass
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-bounded-certification', 'certificationActionId': 'certification-2',
                   'nativeContainment': 'operator-selected-function', '_guardLayout': CERTIFICATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        options = {'broker_type': CertificationBroker, 'observer_type': CertificationObserver,
                   'observer_source': 'ops/platform/p2-certification-current-probe.mjs', 'layout': CERTIFICATION_LAYOUT}
        for callback in (None, 'operator-selected-function', {'held': True}):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, **options, native_containment=callback)
        callback = lambda *_: {'nativeDisabled': True, 'nativeDisableAttempted': False}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial, **options, native_containment=callback)
        self.assertEqual(initial['_guardLayout'], CERTIFICATION_LAYOUT)
        self.assertEqual(initial['_guardObserverSource'], options['observer_source'])
        for changed in ({**options, 'observer_source': 'ops/platform/arbitrary.mjs'},
                        {**options, 'layout': {**CERTIFICATION_LAYOUT, 'terminalName': '../out.json'}}):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, **changed, native_containment=callback)
        for layout in (DEFAULT_LAYOUT, RECOVERY_LAYOUT):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, layout=layout, native_containment=callback)

    def test_recovery_readonly_helper_cleanup_accepts_only_docker_observed_ids(self):
        commands = []
        def command(args, *_):
            commands.append(args)
            if len(commands) == 1: return 'a'*12 + '\n'
            return ''
        with patch('p2_release_supervisor.runtime.command', side_effect=command): cleanup_recovery_current_containers()
        self.assertEqual(commands[1], ['docker', 'rm', '--force', 'a'*12])
        self.assertIn('name=^/lash-p2-recovery-current-(course|community)-[a-f0-9]{32}$',commands[0])
        with patch('p2_release_supervisor.runtime.command', return_value='invalid id'):
            with self.assertRaisesRegex(ValueError,'RECOVERY_CONTAINER_ID_REFUSED'): cleanup_recovery_current_containers()

    def test_rotation_dispatch_is_exact_and_cannot_be_selected_by_private_json(self):
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-identity-key-rotation',
                   'rotationActionId': 'p2-key-rotation-owned', '_guardLayout': ROTATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        options = {'broker_type': P2IdentityRotationBroker,
                   'observer_type': P2IdentityRotationPhysicalObserver,
                   'observer_source': 'ops/platform/p2-recovery-current-probe.mjs',
                   'layout': ROTATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial, **options)
        self.assertEqual(initial['_guardLayout'], ROTATION_LAYOUT)
        for changed in ({**options, 'observer_source': 'ops/platform/p2-frontend-live-probe.mjs'},
                        {**options, 'layout': {**ROTATION_LAYOUT, 'terminalName': '../out.json'}},
                        {**options, 'broker_type': Broker},
                        {**options, 'observer_type': PhysicalObserver}):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, **changed)

    def test_rotation_readonly_cleanup_accepts_only_fixed_names_and_docker_ids(self):
        commands = []
        def command(args, *_):
            commands.append(args)
            if len(commands) in (1, 4): return ('a' if len(commands) == 1 else 'b') * 12 + '\n'
            return ''
        with patch('p2_release_supervisor.runtime.command', side_effect=command):
            cleanup_rotation_readonly_containers()
        self.assertEqual(commands[1], ['docker', 'rm', '--force', 'a'*12])
        self.assertEqual(commands[4], ['docker', 'rm', '--force', 'b'*12])
        self.assertIn('rotation-current-(course|community)', commands[0][-3])
        self.assertIn('rotation-close-', commands[3][-3])
        with patch('p2_release_supervisor.runtime.command', return_value='not-an-id'):
            with self.assertRaisesRegex(ValueError, 'ROTATION_CONTAINER_ID_REFUSED'):
                cleanup_rotation_readonly_containers()

    def test_both_fixed_namespaces_are_cleaned_after_scope_loss_and_foreign_names_are_preserved(self):
        names={'a'*12:'/lash-p2-recovery-current-course-'+'1'*32,'b'*12:'/lash-p2-certification-observer-'+'2'*32,
            'c'*12:'/lash-p2-certification-observer-'+'2'*31,'d'*12:'/lash-p2-certification-observer-'+'A'*32,
            'e'*12:'/lash-p2-certification-observer-'+'3'*32+'-foreign','f'*12:'/lash-her-staging-gateway'}
        calls=[]
        def command(args,*_):
            calls.append(args)
            if args[:3]==['docker','rm','--force']:names.pop(args[-1]);return ''
            pattern=next(value.removeprefix('name=') for value in args if value.startswith('name='))
            return '\n'.join(identity for identity,name in names.items() if re.fullmatch(pattern,name))
        # Neither cleanup branch receives or calls a mutator scope. Docker
        # daemon inventory/removal is source-fixed and independently observed.
        with patch('p2_release_supervisor.runtime.command',side_effect=command):cleanup_recovery_current_containers()
        self.assertEqual(set(names),{'c'*12,'d'*12,'e'*12,'f'*12})
        self.assertEqual(sum(args[:3]==['docker','rm','--force'] for args in calls),2)
        self.assertEqual(sum(args[:3]==['docker','container','ls'] for args in calls),4)

    def test_failed_removal_or_readback_stays_unknown_and_does_not_skip_other_namespace(self):
        for kind in ('rm','readback'):
            calls=[];seen={'recovery':0,'certification':0}
            def command(args,*_):
                calls.append(args)
                if args[:3]==['docker','rm','--force']:
                    if args[-1]=='a'*12 and kind=='rm':raise RuntimeError('private error must not escape')
                    return ''
                mode='certification' if 'certification-observer' in ' '.join(args) else 'recovery';seen[mode]+=1
                if mode=='recovery' and seen[mode]==2 and kind=='readback':raise RuntimeError('private readback')
                return ('a'*12 if mode=='recovery' else 'b'*12) if seen[mode]==1 else ''
            with self.subTest(kind=kind),patch('p2_release_supervisor.runtime.command',side_effect=command):
                with self.assertRaisesRegex(ValueError,'CLEANUP_UNKNOWN'):cleanup_recovery_current_containers()
            self.assertEqual(seen,{'recovery':2,'certification':2});self.assertIn(['docker','rm','--force','b'*12],calls)
