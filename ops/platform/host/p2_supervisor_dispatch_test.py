"""Fixed source dispatch checks. Full recovery is qualified by its owned harness."""
from pathlib import Path
from unittest.mock import patch
import unittest
from p2_release_broker import Broker, PhysicalObserver
from p2_release_supervisor import supervise, DEFAULT_LAYOUT, RECOVERY_LAYOUT, cleanup_recovery_current_containers


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
