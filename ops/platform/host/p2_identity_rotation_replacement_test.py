"""Owned checks for the profiled replacement rotation custody adapter."""

import base64
import copy
import json
import subprocess
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import migrate
import p2_identity_rotation_replacement as custody


class ReplacementRotationCustodyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / 'source'
        self.directory = self.root / 'results' / 'rotation'
        self.directory.mkdir(mode=0o700, parents=True)
        self.raw_program = b'// owned fixed frontend observation source\n'
        program = self.source / custody.certification.OBSERVER
        program.parent.mkdir(parents=True)
        program.write_bytes(self.raw_program)
        self.profile = custody.certification._profiled_context()
        self.candidate = {'version': 3, 'releaseId': 'original'}
        self.jobs = {'frontend': {'job': {'releaseId': 'original'}}, 'course': {}, 'community': {}}
        self.original = b'{"owned":"original-replacement-receipt"}\n'
        self.descriptor = {'databaseOid': '41', 'migrationRoleOid': '42'}
        self.plan = {
            'version': 2, 'qualificationTargetProfile': self.profile, 'mode': 'contain-native',
            'startState': 'already-closed', 'initialEpoch': '5', 'planSha256': '1' * 64,
            'replacementRelease': self.descriptor, 'originalReleaseReceiptSha256': migrate.file_hash(self.original),
            'nativePlan': {'commandWitnesses': [], 'initialEpoch': '5', 'providerQueuedInventory': None,
                           'automaticReplayAllowed': False,
                           'migrationAuthorized': False, 'wholeReleaseAccepted': False},
        }
        self.review = dict.fromkeys(custody.certification.PROFILED_INITIAL_FIELDS)
        self.review.update(version=2, qualificationTargetProfile=self.profile, environment='staging',
                           mode=custody.certification.PROFILED_CERTIFICATION_MODE,
                           certificationActionId='owned-rotation', candidate=self.candidate, candidateSha256='2' * 64,
                           certificationPlan=self.plan, hostMachineId='3' * 32, sourceCommit='4' * 40,
                           sourceSha256={custody.certification.OBSERVER: migrate.file_hash(self.raw_program)},
                           sourceClosureSha256='5' * 64, bundle=str(self.root / 'bundle'),
                           configuration=str(self.root / 'configuration'), results=str(self.directory.parent),
                           configurationSha256={'gateway.json': '6' * 64},
                           originalReleaseReceipt=base64.b64encode(self.original).decode())
        self.credentials = {custody.CREDENTIAL: 'owned-frontend',
                            **{key: 'owned-' + service for service, key in custody.API_CREDENTIALS.items()}}
        self.initial = {key: self.review[key] for key in custody.SHARED_FIELDS}
        self.initial.update(version=2, rotationActionId='owned-rotation', credentials=self.credentials,
                            frontendCustody=self.review, rotationPlan={'actionId': 'owned-rotation',
                                **{key: self.review[key] for key in ('sourceCommit', 'candidateSha256', 'hostMachineId')}})
        self.probe = {'marker': '7' * 64, 'backendPid': 31, 'backendStart': '2026-11-09T23:59:00.000001Z',
                      'receipt': {'journalSha256': '8' * 64}}
        self.observer = Mock()
        self.observer.request = self.probe
        self.observer.probe.side_effect = lambda operation: self.observation(operation, '5' if operation == 'verify-schema' else '11')
        self.verified = {
            'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED', 'originalReleasePlanHashHostVerified': True,
            'hostOriginalReleaseReceiptSha256': self.plan['originalReleaseReceiptSha256'], 'planSha256': self.plan['planSha256'],
            'replacementRelease': self.descriptor,
            **dict.fromkeys(('executionEligible', 'providerTouched', 'admissionChanged', 'releaseAccepted'), False),
        }
        self.boundary = self.mock(custody.supervisor, 'verify_guard_boundary')
        self.prepare = self.mock(custody.certification, 'prepare_profiled_current_certification_input', return_value=self.verified)
        self.mock(custody.migrate, 'make_plan', return_value=(self.candidate, self.jobs))
        self.mock(custody.certification, 'cache_certification_core')
        self.validate = self.mock(custody.supervisor, '_validate_profiled_certification_arm')
        self.frontend = self.mock(custody.certification, 'P2CertificationPhysicalObserver', return_value=self.observer)
        self.runtime = self.mock(custody, 'verify_replacement_runtime_before_arm')
        self.pins = self.mock(custody, 'verify_replacement_rotation_pins')

    def mock(self, module, name, **kwargs):
        active = patch.object(module, name, **kwargs)
        self.addCleanup(active.stop)
        return active.start()

    def prepare_custody(self, initial=None):
        return custody.prepare_replacement_rotation_custody(self.initial if initial is None else initial, self.source,
                                                             lock_fd=11, directory=self.directory)

    @staticmethod
    def observation(operation, epoch):
        return {'status': ('P2_FRONTEND_PHYSICAL_LOCK_VERIFIED' if operation == 'verify-schema' else
                           'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED'),
                'admission': {'epoch': epoch, 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}

    def test_replacement_guard_checks_the_exact_live_probe_and_reaped_closed_epoch(self):
        selected = self.prepare_custody()
        self.assertEqual(selected.verify_arm(self.probe), self.observation('verify-schema', '5'))
        self.assertEqual(selected.verify_closed(self.probe, '11'), self.observation('verify-closed', '11'))
        self.assertEqual([row.args for row in self.observer.probe.call_args_list], [('verify-schema',), ('verify-closed',)])
        self.assertEqual(self.prepare.call_count, 3)
        self.pins.assert_called_once_with(self.review, self.source, self.candidate, self.profile)
        self.runtime.assert_called_once()
        self.assertEqual(self.runtime.call_args.args[0]['_guardLockDescriptor'], 11)
        for call in self.frontend.call_args_list:
            self.assertEqual(call.args, (self.candidate, self.probe, self.source, self.credentials[custody.CREDENTIAL]))
            self.assertEqual(call.kwargs['expected_profile'], self.profile)
            self.assertEqual(call.kwargs['program'].read_bytes(), self.raw_program)
            self.assertEqual(call.kwargs['program_sha256'], migrate.file_hash(self.raw_program))
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_arm(self.probe)
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_closed({**self.probe, 'backendPid': 32}, '11')

    def test_refuses_unqualified_predecessor_before_starting_the_arm_observer(self):
        selected = self.prepare_custody()
        self.pins.side_effect = ValueError('P2_ROTATION_MIXED_SUCCESSOR_REFUSED')
        with self.assertRaisesRegex(ValueError, 'P2_ROTATION_MIXED_SUCCESSOR_REFUSED'):
            selected.verify_arm(self.probe)
        self.frontend.assert_not_called()
        self.runtime.assert_not_called()
        self.assertIsNone(selected._armed_probe_sha)

    def test_requires_fresh_closed_zero_on_both_sides(self):
        selected = self.prepare_custody()
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_closed(self.probe, '11')
        bad = self.observation('verify-schema', '5')
        bad['admission']['active'] = False
        self.observer.probe.side_effect = None
        self.observer.probe.return_value = bad
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_arm(self.probe)
        self.runtime.assert_not_called()
        self.observer.probe.return_value = self.observation('verify-schema', '5')
        selected.verify_arm(self.probe)
        for epoch in ('4', '10'):
            with self.assertRaisesRegex(ValueError, custody.REFUSED):
                selected.verify_closed(self.probe, epoch)
        self.observer.probe.return_value = self.observation('verify-closed', '11')
        self.observer.probe.return_value['admission']['uncertain'] = 1
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_closed(self.probe, '11')

    def test_successor_must_equal_freshly_verified_review_and_mount(self):
        successor = {'kind': 'known-ack', 'actionId': 'owned-certification', 'runtimeActionId': 'owned-recovery',
                     'receiptSha256': '9' * 64}
        self.plan['successorRuntime'] = successor
        self.verified['successorRuntime'] = successor
        selected = self.prepare_custody()
        selected.verify_arm(self.probe)
        guard, source = self.runtime.call_args.args
        self.assertEqual(guard['certificationPlan']['successorRuntime'], successor)
        self.assertEqual(source, self.source)
        self.prepare.return_value = {**self.verified, 'successorRuntime': {**successor, 'receiptSha256': 'a' * 64}}
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.verify_closed(self.probe, '11')

    def test_refuses_foreign_action_legacy_or_mutating_review_before_observation(self):
        for changes in ({'version': 1}, {'rotationActionId': 'foreign'}, {'configuration': '/other'},
                        {'_guardLockDescriptor': 12}, {'sourceClosureSha256': 'a' * 64}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, custody.REFUSED):
                self.prepare_custody({**self.initial, **changes})
        for changes in ({'mode': 'native-window'}, {'startState': 'qualified-ready'}, {'scopedAction': {}},
                        {'nativePlan': {**self.plan['nativePlan'], 'commandWitnesses': [{'commandId': 'foreign'}]}},
                        {'nativePlan': {**self.plan['nativePlan'], 'migrationAuthorized': True}}):
            changed = copy.deepcopy(self.initial)
            changed['frontendCustody']['certificationPlan'].update(changes)
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, custody.REFUSED):
                self.prepare_custody(changed)
        self.prepare.assert_not_called()
        self.frontend.assert_not_called()

    def managed_packet(self):
        action = 'p2-key-rotation-owned'
        producer = {'producerSha256': 'a' * 64, 'role': {'name': 'owned_runtime', 'oid': '43'}}
        owner = {'name': 'owned_owner', 'oid': '41'}
        native = {**self.plan['nativePlan'], 'qualificationTargetProfile': self.profile,
                  'planSha256': 'b' * 64, 'producer': producer, 'owner': owner,
                  'featureControls': {'example': False}, 'writerAdmissionBinding': {'mode': 'enforce'},
                  'configurationRecordSha256': 'c' * 64}
        plan = {**self.plan, 'certificationActionId': action, 'originalReleaseId': 'original', 'nativePlan': native,
                'candidateObjectSha256': 'd' * 64, 'readyReceiptSha256': {'owned.json': 'e' * 64}}
        review = {**self.review, 'certificationActionId': action, 'certificationPlan': plan, 'targetSha256': 'f' * 64,
                  'certification': {'featureControls': native['featureControls']}, 'owner': owner,
                  'inventory': {'producers': [producer]}, 'expectedWriterAdmissionBinding': native['writerAdmissionBinding']}
        root = '/var/lib/lash-her/releases/staging/owned-rotation'
        configuration = {phase: {'sha256': str(index) * 64, 'privateRef': root + '/' + phase}
                         for index, phase in enumerate(custody.CONFIGURATION_PHASES, 1)}
        rotation = {'version': 2, 'qualificationTargetProfile': self.profile, 'environment': 'staging',
                    'status': custody.MANAGED_PLAN_STATUS, 'actionId': action, 'originalReleaseId': 'original',
                    'courseId': '00000000-0000-4000-8000-000000000001',
                    'subjects': {name: f'00000000-0000-4000-8000-00000000000{index}'
                                 for index, name in enumerate(custody.IDENTITY_PROFILES, 2)},
                    'configuration': configuration,
                    **{key: review[key] for key in ('candidateSha256', 'hostMachineId', 'sourceCommit', 'targetSha256')},
                    **{key: native[key] for key in ('featureControls', 'writerAdmissionBinding')},
                    **{key: plan[key] for key in ('candidateObjectSha256', 'readyReceiptSha256', 'initialEpoch')},
                    'operatorSourceClosureSha256': review['sourceClosureSha256'], 'replacementLeasePlanSha256': '1' * 64,
                    'frontendCustodyPlanSha256': plan['planSha256'], 'nativePlanSha256': native['planSha256'],
                    'authenticationWindows': [{'phase': phase, 'beforeEpoch': str(5 + 2 * index),
                                               'openEpoch': str(6 + 2 * index), 'closedEpoch': str(7 + 2 * index)}
                                              for index, phase in enumerate(custody.AUTHENTICATION_PHASES)],
                    'finalEpoch': '11', **dict.fromkeys(custody.MANAGED_PLAN_FALSE, False)}
        self.bind_managed_plan(rotation)
        return {**{key: review[key] for key in custody.SHARED_FIELDS},
                'version': 2, 'mode': custody.MANAGED_MODE, 'rotationActionId': action, 'rotationPlan': rotation,
                'frontendCustody': review, 'confirmation': 'staging/' + action, 'credentials': self.credentials,
                'vercelToken': 'owned-token', 'scopedCronSecret': 'k' * 32, 'nativePlan': native,
                'baselineConfigurationRecordSha256': native['configurationRecordSha256'], 'rotationConfiguration': root,
                'privateRotationConfigurationSha256': {phase: str(index) * 64
                                                      for index, phase in enumerate(custody.CONFIGURATION_PHASES, 4)},
                'expectedFeatureControls': native['featureControls'],
                'expectedWriterAdmissionBinding': native['writerAdmissionBinding'],
                'operatorProgramSha256': '2' * 64, 'rotationBrowserProgramSha256': '3' * 64,
                'gatewayHost': 'owned.invalid', 'certification': review['certification'], 'targetSha256': review['targetSha256'],
                'owner': owner, 'producers': [producer]}

    @staticmethod
    def bind_managed_plan(rotation):
        rotation['bindingSha256'] = migrate.file_hash(custody.certification._canonical(
            {key: value for key, value in rotation.items() if key != 'bindingSha256'}))

    def test_exact_managed_packet_binds_the_original_custody_and_three_reviewed_epochs(self):
        initial = self.managed_packet()
        self.assertEqual(custody.validate_managed_rotation_initial(initial), self.profile)
        for changed in ({'privateProbe': {}}, {'historicalLogins': {}}, {'configuration': '/other'},
                        {'scopedCronSecret': 'short'}, {'version': 1}):
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, custody.REFUSED):
                custody.validate_managed_rotation_initial({**initial, **changed})
        for changed in ({'finalEpoch': '12'}, {'authenticationWindows': []}, {'liveEligible': True},
                        {'targetSha256': '2' * 64}, {'frontendCustodyPlanSha256': '3' * 64}):
            rotation = {**initial['rotationPlan'], **changed}
            self.bind_managed_plan(rotation)
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, custody.REFUSED):
                custody.validate_managed_rotation_initial({**initial, 'rotationPlan': rotation})
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            custody.validate_managed_rotation_initial({**initial, 'rotationPlan': {**initial['rotationPlan'],
                                                                                   'bindingSha256': '4' * 64}})

    def test_api_readback_requires_the_broker_created_typed_scope(self):
        selected = self.prepare_custody()
        scope = Mock(_physical_observer=self.observer)
        self.mock(custody, 'ReplacementRotationPhysicalObserver', return_value=self.observer)
        typed = self.mock(custody.certification, 'P2CertificationScope', return_value=scope)
        api = self.mock(custody.certification, 'check_profiled_certification_apis', return_value=('proof', 'outcome'))
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.check_apis(scope, self.directory / 'current-api')
        abort = Mock()
        self.assertIs(selected.open_scope(self.probe, abort), scope)
        self.observer.start.assert_called_once_with(abort)
        self.assertEqual(typed.call_args.args[:2], (11, custody.supervisor.LOCK))
        self.assertIs(typed.call_args.kwargs['physical_observer'], self.observer)
        self.assertEqual(typed.call_args.kwargs['original_replacement_receipt'], self.original)
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.open_scope(self.probe, abort)
        with self.assertRaisesRegex(ValueError, custody.REFUSED):
            selected.check_apis(object(), self.directory / 'current-api')
        self.assertEqual(selected.check_apis(scope, self.directory / 'current-api'), ('proof', 'outcome'))
        api.assert_called_once_with(scope, self.jobs, self.source, Path(self.review['bundle']),
                                    self.directory / 'current-api', {'course': 'owned-course', 'community': 'owned-community'},
                                    self.review['sourceSha256'], expected_profile=self.profile)


class ReplacementRotationWriterScopeTests(unittest.TestCase):
    def setUp(self):
        self.observer = object.__new__(custody.ReplacementRotationPhysicalObserver)
        self.profile = custody.certification._profiled_context()
        self.ordinary = {'producerSha256': '1' * 64, 'role': {'name': 'frontend_runtime', 'oid': '42'}}
        self.replacement = {'databaseOid': '41', 'migrationRoleOid': '43'}
        self.observer.request = {'marker': '2' * 64, 'backendPid': 31, 'backendStart': '2026-11-09T23:59:00.000001Z',
            'plan': {'initialEpoch': '5', 'sourceCommit': '3' * 40, 'targetSha256': '4' * 64,
                     'nativePlan': {'producer': self.ordinary}},
            'job': {'releaseId': 'original', 'sourceCommit': '3' * 40}, 'receipt': {'journalSha256': '5' * 64},
            'producers': [self.ordinary]}
        self.observer._request_sha256 = migrate.file_hash(custody.certification._profiled_compact(self.observer.request))
        self.observer._state_lock = threading.RLock()
        self.observer._allowed = (('5', 'ordinary'),)
        self.observer._opened_epochs = set()
        self.observer._deadline = None
        self.observer._replacement = self.replacement
        self.observer._expected_profile = self.profile
        self.epoch, self.registry = '5', 'ordinary'
        self.operations = []
        self.observer._run_writer_observer = Mock(side_effect=lambda selection: json.dumps(self.response(selection)))

    def response(self, selection):
        request = self.observer.request
        interactive = self.registry == 'interactive'
        producers = self.observer._producers(self.registry)
        return {'version': 2, 'qualificationTargetProfile': self.profile, 'status': custody.WRITER_STATUS, 'environment': 'staging',
                **request['job'], **{key: request[key] for key in ('marker', 'backendPid', 'backendStart')},
                'targetSha256': request['plan']['targetSha256'], 'journalSha256': request['receipt']['journalSha256'],
                'replacementRelease': self.replacement, 'effectiveLoginBoundaryVerified': True,
                'predecessorRuntimeRoleAbsent': True,
                'admission': {'epoch': self.epoch, 'newWork': interactive, 'recovery': interactive,
                              'active': sum(row['state'] == 'active' for row in self.operations), 'uncertain': 0},
                'writerScope': {'currentEpoch': self.epoch, 'currentRegistry': self.registry, **selection,
                                'operations': self.operations, 'producers': producers,
                                'registrySha256': migrate.file_hash(custody.certification._profiled_compact(producers))}}

    def completed(self, epoch):
        producer = self.observer._producers('interactive')[0]
        return {'id': '00000000-0000-4000-8000-000000000001', 'epoch': epoch, 'kind': 'new-work',
                'state': 'completed', 'producer_sha256': producer['producerSha256'],
                'source_sha': self.observer.request['job']['sourceCommit'], 'role_oid': producer['role']['oid'],
                'completed_at': '2026-11-09T23:59:00.000Z', 'reconciliation_sha256': None}

    def test_initial_future_open_and_restored_registry_use_exact_writer_epochs(self):
        held = self.observer
        self.assertEqual(held.observe_writer_scope('5')['producers'], [self.ordinary])
        self.assertEqual(held.observe_writer_scope('6')['operations'], [])
        self.assertEqual(held._run_writer_observer.call_args.args[0],
                         {'operationEpoch': '6', 'operationRegistry': 'interactive'})
        self.assertEqual(held.transition('5', True, 300), '6')
        self.assertEqual(held.probe('observe')['admission']['epoch'], '5')
        self.epoch, self.registry = '6', 'interactive'
        self.assertEqual(held.probe('observe')['admission']['epoch'], '6')
        held.exact('6', True, 300)
        self.assertEqual(held.observe_writer_scope('6')['producers'], held._producers('interactive'))
        self.assertEqual(held.transition('6', False), '7')
        self.operations = [self.completed('6')]
        self.assertEqual(held.probe('observe')['admission']['epoch'], '6')
        self.epoch, self.registry = '7', 'ordinary'
        self.assertEqual(held.observe_writer_scope('6')['operations'], self.operations)
        held.exact('7', False)
        self.operations = []
        self.assertEqual(held.observe_writer_scope('7')['producers'], [self.ordinary])
        for operation in ('fence', 'witness'):
            with self.assertRaisesRegex(ValueError, custody.REFUSED):
                held.probe(operation)

    def test_rejects_wrong_epoch_registry_role_journal_and_future_rows(self):
        held = self.observer
        for epoch in ('4', '7'):
            with self.subTest(epoch=epoch), self.assertRaisesRegex(ValueError, custody.REFUSED):
                held.observe_writer_scope(epoch)
        selection = {'operationEpoch': '6', 'operationRegistry': 'interactive'}
        positive = self.response(selection)
        for altered in ({'journalSha256': '6' * 64}, {'backendPid': 32},
                        {'effectiveLoginBoundaryVerified': False},
                        {'admission': {**positive['admission'], 'recovery': True}},
                        {'writerScope': {**positive['writerScope'], 'registrySha256': '7' * 64}},
                        {'writerScope': {**positive['writerScope'], 'operations': [self.completed('6')]}}):
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                held._writer_result(json.dumps({**positive, **altered}), selection)

    def test_writer_uses_pinned_image_source_and_private_stdin(self):
        held = self.observer
        del held._run_writer_observer
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            held.source = root / 'source'
            selected_core = held.source / custody.certification.CORE
            selected_core.parent.mkdir(parents=True)
            selected_core.write_bytes(b'owned core')
            held.program = root / 'observer.mjs'
            held.program.write_bytes(b'owned observer')
            held.program_sha256 = migrate.file_hash(held.program.read_bytes())
            held.credential = 'owned-private-database-url'
            image = 'owned-frontend-image'
            held.selected = {'artifacts': {'frontendMigration': {'image': image}}}
            result = subprocess.CompletedProcess([], 0, stdout='{}', stderr='')
            with (patch.object(custody.certification, '_core', b'owned core'),
                  patch.object(custody.certification, '_cache_core', return_value=selected_core),
                  patch.object(custody.subprocess, 'run', return_value=result) as run,
                  patch.object(custody.runtime, 'command', return_value='')):
                selection = {'operationEpoch': '5', 'operationRegistry': 'ordinary'}
                self.assertEqual(held._run_writer_observer(selection), '{}')
            launch, cleanup = run.call_args_list
            self.assertEqual(launch.args[0][-3:], [image, custody.certification.OBSERVER, custody.WRITER_FLAG])
            self.assertIn('--read-only', launch.args[0])
            self.assertNotIn(held.credential, str(launch.args))
            self.assertEqual(launch.kwargs['env'][custody.CREDENTIAL], held.credential)
            self.assertEqual(json.loads(launch.kwargs['input']),
                             {**held.request, 'operation': 'writer-scope', 'writerScope': selection})
            name = launch.args[0][launch.args[0].index('--name') + 1]
            self.assertEqual(cleanup.args[0], ['docker', 'rm', '--force', name])

    def test_window_deadline_can_shorten_but_never_extend(self):
        held = self.observer
        with patch.object(custody.time, 'monotonic', return_value=10):
            held.transition('5', True, 30)
        self.epoch, self.registry = '6', 'interactive'
        with patch.object(custody.time, 'monotonic', return_value=20):
            held.exact('6', True, 300)
        self.assertEqual(held._deadline, 40)
        with patch.object(custody.time, 'monotonic', return_value=41), self.assertRaisesRegex(ValueError, custody.REFUSED):
            held.probe('observe')


if __name__ == '__main__':
    unittest.main()
