"""Fixed source dispatch checks. Full recovery is qualified by its owned harness."""
from pathlib import Path
from unittest.mock import patch
import unittest
from p2_release_broker import Broker, PhysicalObserver
from p2_release_supervisor import supervise, DEFAULT_LAYOUT, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT, ROTATION_LAYOUT, cleanup_recovery_current_containers, cleanup_rotation_readonly_containers
from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver


class FixedDispatchTests(unittest.TestCase):
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
