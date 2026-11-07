"""Focused source tests for the profiled interrupted runtime transition."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import migrate
import release as runtime
import p2_profiled_known_ack_runtime as source


class ProfiledInterruptedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='p2-profiled-interrupted-runtime-')
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.profile = source._profile()
        self.action = 'owned-profiled-c'
        self.candidate = 'a' * 64
        self.stop_sha = 'b' * 64
        self.causal = {'baseline.json': 'c' * 64, 'settlement.json': 'd' * 64}
        self.processes = {
            service: {
                'containerId': format(index + 1, '064x'),
                'imageId': 'sha256:' + format(index + 1, '064x'),
                'pid': index + 100,
                'startedAt': 'owned-' + str(index),
                'restartCount': 0,
                'running': True,
            }
            for index, service in enumerate(runtime.SERVICES)
        }
        self.processes['gateway'].update(pid=0, running=False)
        paths = {name: self.root / name for name in
                 ('input', 'old-mounted', 'replacement', 'replacement-snapshot', 'source')}
        for path in paths.values():
            path.mkdir(mode=0o700)
        self.retained = {
            'selection': {
                'priorGatewayReference': {
                    'kind': 'stopped-current-candidate',
                    'stopReceiptDirectory': str(self.root / 'stopped'),
                    'stopReceiptSha256': self.stop_sha,
                },
                'causalReceiptSha256': copy.deepcopy(self.causal),
            },
            'plan': {}, 'values': {}, 'stages': {},
            'originalGateway': {'process': copy.deepcopy(self.processes['gateway']), 'binding': {'owned': 'old'},
                                'admission': {'newWork': False, 'recovery': False,
                                              'active': {'newWork': 0, 'recovery': 0},
                                              'uncertain': {'newWork': 0, 'recovery': 1}}},
            'stoppedGateway': {'process': copy.deepcopy(self.processes['gateway']), 'binding': {'owned': 'old'},
                               'admission': {'newWork': False, 'recovery': False,
                                             'active': {'newWork': 0, 'recovery': 0},
                                             'uncertain': {'newWork': 0, 'recovery': 1}}},
            'frontier': 'original-stopped-one',
            'inputDirectory': paths['input'], 'oldMountedDirectory': paths['old-mounted'],
            'replacementDirectory': paths['replacement'], 'replacementSnapshot': paths['replacement-snapshot'],
            'activeStage': None, 'completedStages': [], 'oldProcesses': {},
            'observedProcesses': copy.deepcopy(self.processes), 'originalSource': paths['source'],
            'originalSourceManifest': {}, 'originalFaultReceiptSha256': {}, 'originalAuxiliarySha256': {},
        }
        self.authority = {
            'version': 2, 'qualificationTargetProfile': self.profile,
            'status': 'P2_PROFILED_INTERRUPTED_RUNTIME_AUTHORIZED',
            'restorationActionId': self.action, 'candidateSha256': self.candidate,
            'frontier': self.retained['frontier'], 'originalStopReceiptSha256': self.stop_sha,
            'originalCausalReceiptSha256': copy.deepcopy(self.causal),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def broker_stub(self):
        return SimpleNamespace(action_id=lambda: self.action,
                               initial={'candidateSha256': self.candidate})

    def test_retained_and_authority_are_closed_and_bind_the_stop_frontier(self):
        actual = source._retained_shape(self.retained)
        self.assertIs(actual, self.retained)
        self.assertEqual(source._authority_record(
            self.authority, self.broker_stub(), self.retained, self.profile), self.authority)
        for field, value in (
            ('frontier', 'replacement-stopped-zero'),
            ('originalStopReceiptSha256', 'e' * 64),
            ('candidateSha256', 'f' * 64),
            ('qualificationTargetProfile', {**self.profile, 'id': 'foreign'}),
        ):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'AUTHORITY_BINDING'):
                source._authority_record({**self.authority, field: value}, self.broker_stub(),
                                         self.retained, self.profile)
        with self.assertRaisesRegex(ValueError, 'RETAINED_SHAPE'):
            source._retained_shape({**self.retained, 'callerSelectedPath': '/tmp/foreign'})
        with self.assertRaisesRegex(ValueError, 'COMPLETED_STAGE_PREFIX'):
            source._retained_shape({**self.retained, 'completedStages': [runtime.STAGES[1]]})
        with self.assertRaisesRegex(ValueError, 'ACTIVE_STAGE'):
            source._retained_shape({**self.retained, 'completedStages': list(runtime.STAGES),
                                    'activeStage': runtime.STAGES[-1]})
        rows = copy.deepcopy(self.processes); rows['course-api']['pid'] = True
        with self.assertRaisesRegex(ValueError, 'PROCESS_SHAPE'):
            source._retained_shape({**self.retained, 'observedProcesses': rows})

    def test_active_stage_may_be_missing_but_no_other_process_can_disappear(self):
        boundary = object.__new__(source.ProfiledInterruptedKnownAckBoundary)
        boundary.retained = copy.deepcopy(self.retained)
        boundary.retained['activeStage'] = runtime.STAGES[0]
        boundary.stopped_gateway = copy.deepcopy(self.retained['stoppedGateway'])
        boundary.stopped_gateway['process'].update(running=True, pid=4321)
        inventory = {service: [row['containerId']] for service, row in self.processes.items()}
        inventory['community-api'] = []
        stopped = {service: {**row, 'running': False, 'pid': 0} for service, row in self.processes.items()}
        boundary._inventory = lambda: copy.deepcopy(inventory)
        boundary._inspect = lambda identifier: next(copy.deepcopy(row) for row in stopped.values()
                                                      if row['containerId'] == identifier)
        boundary._validate_actual = lambda value, _service, healthy: copy.deepcopy(value)
        actual = boundary._read_actual_starting_processes()
        self.assertIsNone(actual['community-api'])
        self.assertEqual(actual['course-api'], stopped['course-api'])
        self.assertEqual(actual['gateway'], stopped['gateway'])
        inventory['course-snapshot'] = []
        with self.assertRaisesRegex(ValueError, 'EXACT_STARTING_INVENTORY'):
            boundary._read_actual_starting_processes()
        inventory['course-snapshot'] = [stopped['course-snapshot']['containerId']]
        stopped['course-api'] = self.processes['course-api']
        with self.assertRaisesRegex(ValueError, 'SOURCE_RUNTIME_NOT_STOPPED'):
            boundary._read_actual_starting_processes()
        stopped['course-api'] = {**stopped['course-api'], 'running': False, 'pid': 0}
        stopped['course-snapshot']['restartCount'] = 1
        with self.assertRaisesRegex(ValueError, 'RETAINED_PROCESS_CHANGED'):
            boundary._read_actual_starting_processes()

    def test_interrupted_stage_process_keeps_its_original_snapshot_until_replaced(self):
        boundary = object.__new__(source.ProfiledInterruptedKnownAckBoundary)
        boundary.retained = copy.deepcopy(self.retained)
        boundary.retained['activeStage'] = runtime.STAGES[0]
        boundary.old_configuration = self.retained['oldMountedDirectory']
        boundary.replacement_configuration = self.retained['replacementSnapshot']
        boundary.snapshot = self.root / 'current-snapshot'
        boundary._reading_starting_processes = True
        interrupted_id, fresh_id = '7' * 64, '8' * 64
        self.assertEqual(boundary._configuration_for('community-api', interrupted_id), boundary.replacement_configuration)
        boundary._reading_starting_processes = False
        boundary.old_metadata = {'community-api': {'containerId': interrupted_id}}
        self.assertEqual(boundary._configuration_for('community-api', interrupted_id), boundary.replacement_configuration)
        self.assertEqual(boundary._configuration_for('community-api', fresh_id), boundary.snapshot)

    def typed_scope(self):
        from p2_certification_parent import P2CertificationScope

        lock = self.root / 'host.lock'
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_EXCL, 0o600)
        self.addCleanup(os.close, descriptor)
        parent = object.__new__(P2CertificationScope)
        parent.descriptor, parent.path, parent.identity = descriptor, lock, os.fstat(descriptor)
        parent.receipt = {'journalSha256': '1' * 64}
        parent.candidate_sha256 = self.candidate
        parent.release = {'environment': 'staging', 'releaseId': 'owned-release',
                          'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + '2' * 64}
        parent.jobs = {'frontend': {'job': {}}, 'course': {}, 'community': {}}
        parent.configuration_sha256 = {}
        parent.revoked, parent.processes = Mock(), set()
        parent.mutations = Mock()
        parent.verify = Mock()
        parent.require_release = Mock()
        parent.require_configuration = Mock()
        parent.require_frontend = Mock(return_value={'status': 'owned-current'})
        parent.run = Mock(return_value=subprocess.CompletedProcess([], 0, '', ''))
        boundary = object.__new__(source.ProfiledInterruptedKnownAckBoundary)
        boundary.parent, boundary.action = parent, self.action
        boundary.expected_profile = self.profile
        boundary.snapshot = self.root / 'runtime-interrupted/configuration'
        boundary.snapshot.mkdir(parents=True, mode=0o700)
        (boundary.snapshot / 'gateway.json').write_text(json.dumps({
            'admission': {'file': '/admission/state.json', 'releaseId': parent.release['releaseId'],
                          'candidateSha256': self.candidate}}))
        boundary.verify = Mock()
        boundary.bind_snapshot = Mock()
        source._BOUNDARIES.add(boundary)
        scope = source.ProfiledInterruptedKnownAckScope(parent, boundary)
        return scope, parent, boundary

    def test_typed_scope_keeps_the_fresh_certification_parent_and_closed_admission(self):
        scope, parent, boundary = self.typed_scope()
        with patch.object(source.staging_admission, 'persist_state') as persist:
            scope.initialize_runtime(boundary.snapshot, parent.release)
        boundary.bind_snapshot.assert_called_once_with(boundary.snapshot)
        persist.assert_called_once_with(
            boundary.snapshot,
            {'releaseId': 'owned-release', 'candidateSha256': self.candidate},
            'p2-profiled-known-ack-restoration-' + self.action,
            new_work=False, recovery=False)
        with self.assertRaisesRegex(ValueError, 'PARENT_SCOPE_NOT_OWNED'):
            scope.revoke()
        with self.assertRaisesRegex(ValueError, 'PARENT_SCOPE_NOT_OWNED'):
            scope.close()

    def test_runtime_requires_equal_fresh_api_proofs_and_retains_no_mutation_claims(self):
        scope, parent, boundary = self.typed_scope()
        output = self.root / 'runtime-output'
        output.mkdir(mode=0o700)
        boundary.output, boundary.input_configuration = output, self.root / 'input'
        boundary.compose_file = self.root / 'source/ops/platform/compose.yaml'
        boundary.compose_file.parent.mkdir(parents=True, exist_ok=True)
        boundary.compose_file.write_text('owned-compose')
        boundary.selected, boundary.jobs = parent.release, parent.jobs
        boundary.retained = copy.deepcopy(self.retained)
        boundary.stopped_gateway = copy.deepcopy(self.retained['stoppedGateway'])
        boundary.old_metadata = {'gateway': copy.deepcopy(boundary.stopped_gateway['process'])}
        boundary.new_gateway = {'process': {'containerId': '9' * 64}, 'binding': {'owned': 'new'}}
        boundary.finished, boundary.stage_index = True, len(runtime.STAGES)
        boundary.runtime_attempted = False
        boundary.mutex = threading.RLock()
        api = {'version': 2, 'qualificationTargetProfile': self.profile,
               'status': 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED', 'phase': 'completed',
               'releaseId': parent.release['releaseId'], 'candidateSha256': self.candidate,
               'databases': {'course': {'journal': 'a'}, 'community': {'journal': 'b'}},
               'migrationsExecuted': False, 'frontendSqlApplied': False, 'trafficAuthorized': False}
        broker = SimpleNamespace(reader=SimpleNamespace(snapshot=Mock()), require_native_off=Mock(),
                                 _read_api_current=Mock(side_effect=[copy.deepcopy(api), copy.deepcopy(api)]))
        boundary.broker = broker
        runtime_component = source.ProfiledInterruptedKnownAckRuntime.__new__(source.ProfiledInterruptedKnownAckRuntime)
        runtime_component.scope, runtime_component.selected, runtime_component.jobs = scope, parent.release, parent.jobs
        runtime_component.configuration, runtime_component.output = boundary.input_configuration, output
        runtime_component.compose_file, runtime_component.source = boundary.compose_file, self.root / 'source'
        runtime_component.snapshot, runtime_component.api_before = None, None
        scope.boundary = boundary
        scope.verify = Mock()

        def fixed_restore(*, expected_profile):
            self.assertEqual(expected_profile, self.profile)
            runtime_component._read_current_apis()
            migrate.write_json(output, 'p2-recovery-runtime-ready.json', {'status': 'owned-ready'})
            return {'environment': 'staging', 'releaseId': parent.release['releaseId'],
                    'recoveryActionId': self.action, 'candidateSha256': self.candidate,
                    'apiDatabases': api['databases'], 'containers': [], 'boundaryChecks': [],
                    'sqlReplayed': False, 'rolePreparationRepeated': False, 'trafficAuthorized': False}

        runtime_component._restore = fixed_restore
        result = runtime_component.restore()
        self.assertEqual(result['status'], 'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED')
        self.assertFalse(result['sqlReplayed'])
        self.assertFalse(result['migrationsExecuted'])
        self.assertFalse(result['rolePreparationRepeated'])
        self.assertFalse(result['frontendSqlApplied'])
        self.assertFalse(result['newWorkOpened'])
        self.assertFalse(result['recoveryOpened'])
        self.assertFalse(result['trafficAuthorized'])
        self.assertEqual(broker._read_api_current.call_count, 2)
        self.assertTrue((output / source.OUTCOME).is_file())

    def test_api_proof_cannot_claim_migration_traffic_or_another_profile(self):
        scope, parent, boundary = self.typed_scope()
        component = source.ProfiledInterruptedKnownAckRuntime.__new__(source.ProfiledInterruptedKnownAckRuntime)
        component.scope, component.selected = scope, parent.release
        value = {'version': 2, 'qualificationTargetProfile': self.profile,
                 'status': 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED', 'phase': 'completed',
                 'releaseId': parent.release['releaseId'], 'candidateSha256': self.candidate,
                 'databases': {'course': {}, 'community': {}}, 'migrationsExecuted': False,
                 'frontendSqlApplied': False, 'trafficAuthorized': False}
        for field, changed in (
            ('version', True), ('qualificationTargetProfile', {**self.profile, 'id': 'foreign'}),
            ('migrationsExecuted', True), ('frontendSqlApplied', True), ('trafficAuthorized', True),
            ('databases', {'course': {}}),
        ):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'FRESH_API_PROOF'):
                component._require_api_outcome({**value, field: changed})

    def test_prepare_consumes_parent_authority_once_before_constructing_runtime(self):
        module = ModuleType('p2_profiled_known_ack_restoration_parent')

        class P2ProfiledInterruptedKnownAckBroker:
            pass

        used = set()

        def consume(authority, broker):
            if type(broker) is not P2ProfiledInterruptedKnownAckBroker or authority in used:
                raise ValueError('OWNED_ONE_USE_REFUSED')
            used.add(authority)
            return copy.deepcopy(self.authority)

        module.P2ProfiledInterruptedKnownAckBroker = P2ProfiledInterruptedKnownAckBroker
        module.consume_profiled_interrupted_runtime_authority = consume
        broker, authority = P2ProfiledInterruptedKnownAckBroker(), object()
        broker.scope = object()
        boundary, scope, runtime_value = object(), object(), object()
        with patch.dict(sys.modules, {module.__name__: module}), \
             patch.object(source, 'ProfiledInterruptedKnownAckBoundary', return_value=boundary) as make_boundary, \
             patch.object(source, 'ProfiledInterruptedKnownAckScope', return_value=scope), \
             patch.object(source, 'ProfiledInterruptedKnownAckRuntime', return_value=runtime_value):
            self.assertIs(source.prepare_profiled_interrupted_runtime(broker, authority, self.retained), runtime_value)
            make_boundary.assert_called_once_with(broker, self.authority, self.retained)
            with self.assertRaisesRegex(ValueError, 'ONE_USE'):
                source.prepare_profiled_interrupted_runtime(broker, authority, self.retained)
            with self.assertRaisesRegex(ValueError, 'SOURCE_BROKER'):
                source.prepare_profiled_interrupted_runtime(object(), object(), self.retained)


if __name__ == '__main__':
    unittest.main()
