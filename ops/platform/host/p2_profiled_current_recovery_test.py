import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import os
from unittest.mock import patch

import p2_profiled_current_recovery as recovery


def digests():
    return {name: str(index + 1) * 64 for index, name in enumerate(recovery.ORIGINAL_NAMES)}


def selected():
    return {'version': 3, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
            'environment': 'staging', 'releaseId': 'original-release', 'contractPhase': 'p2',
            'sources': {'frontend': {'commit': 'a' * 40}}}


def initial(disposition='restore-current-runtime'):
    value = {'recoveryActionId': 'owned-recovery', 'originalReleaseId': 'original-release',
             'disposition': disposition, 'originalReceiptSha256': digests(),
             'apiJobSha256': {'course': 'a' * 64, 'community': 'b' * 64}}
    if disposition == 'resume-approved-api-suffix':
        value['approvedApiSuffix'] = {'course': ['0012_owned'], 'community': ['0009_owned']}
        value['recoveryApiJobSha256'] = {'course': 'c' * 64, 'community': 'd' * 64}
    return value


class ProfiledCurrentRecoveryTest(unittest.TestCase):
    def test_initialize_joins_the_five_host_original_receipts_by_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); bundle = root / 'bundle'; results = root / 'results'
            bundle.mkdir(mode=0o700); results.mkdir(mode=0o700)
            release = selected()['releaseId']
            locations = {
                'candidate': (bundle, 'release.candidate.json'),
                'frontendDatabase': (results / ('p2-profiled-current-' + release), 'frontend-original-database-receipt.json'),
                'frontendContinuationStarted': (results / ('p2-profiled-current-' + release), 'frontend-continuation-started.json'),
                'apiMigrationOutcome': (results / release, 'migration-outcome.json'),
                'apiRuntimeOutcome': (results / ('runtime-' + release), 'runtime-outcome.json'),
            }
            pins = digests()
            for index, (key, (directory, name)) in enumerate(locations.items()):
                directory.mkdir(mode=0o700, exist_ok=True); raw = ('{"owned":%d}\n' % index).encode()
                path = directory / name; path.write_bytes(raw); path.chmod(0o600); pins[key] = recovery.sha(raw)
            started = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                       'status': 'P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW', 'releaseId': release,
                       'sourceCommit': 'a' * 40, 'candidateSha256': 'a' * 64,
                       'configurationSha256': {'owned': 'b' * 64}, 'targetSha256': 'c' * 64,
                       'inventorySha256': 'd' * 64, 'apiJobSha256': {'course': 'e' * 64, 'community': 'f' * 64}}
            started_path = results / ('p2-profiled-current-' + release) / 'p2-profiled-current-started.json'
            started_path.write_text(json.dumps(started)); started_path.chmod(0o600)
            broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
            broker.bundle, broker.results, broker.selected = bundle, results, selected()
            broker.initial = {'originalReceiptSha256': pins, 'sourceCommit': 'a' * 40,
                              'candidateSha256': 'a' * 64, 'configurationSha256': {'owned': 'b' * 64},
                              'targetSha256': 'c' * 64, 'inventorySha256': 'd' * 64,
                              'apiJobSha256': {'course': 'e' * 64, 'community': 'f' * 64}}
            with patch.object(recovery.P2ProfiledCurrentBroker, 'initialize', return_value=None):
                broker.initialize()
                (results / release / 'migration-outcome.json').write_bytes(b'{"changed":true}\n')
                with self.assertRaises(Exception):
                    broker.initialize()

    def test_source_selection_requires_distinct_action_closed_disposition_and_exact_original_pins(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        def selected_inputs(value):
            jobs = {'frontend': {'job': {'target': {'approvedPendingTags': [], 'allowEmptyBootstrap': False}}},
                    'course': {'job': {'target': {'approvedPendingTags': value.get('approvedApiSuffix', {}).get('course', []), 'allowEmptyBootstrap': False}}},
                    'community': {'job': {'target': {'approvedPendingTags': value.get('approvedApiSuffix', {}).get('community', []), 'allowEmptyBootstrap': False}}}}
            return selected(), jobs, {'hostMachineId': 'owned'}, {}
        with patch.object(recovery.P2ProfiledCurrentBroker, 'select_release', side_effect=selected_inputs):
            self.assertEqual(broker.select_release(initial()), selected_inputs(initial()))
            suffix = initial('resume-approved-api-suffix')
            suffix['originalReceiptSha256'] = dict(list(suffix['originalReceiptSha256'].items())[:3])
            self.assertEqual(broker.select_release(suffix), selected_inputs(suffix))
            for change in (
                    lambda value: value.update(recoveryActionId='original-release'),
                    lambda value: value.update(disposition='retry-sql'),
                    lambda value: value['originalReceiptSha256'].pop('apiRuntimeOutcome'),
                    lambda value: value['originalReceiptSha256'].update(candidate='0' * 64),
                    lambda value: value.update(approvedApiSuffix={'course': [], 'community': []})):
                changed = initial(); change(changed)
                with self.assertRaises(Exception):
                    broker.select_release(changed)
            empty = initial('resume-approved-api-suffix'); empty['approvedApiSuffix'] = {'course': [], 'community': []}
            with self.assertRaises(Exception):
                broker.select_release(empty)
        broker.initial, broker.selected = initial(), selected()
        with patch.object(recovery.P2ProfiledCurrentBroker, 'record_base', return_value={'status': 'OWNED'}):
            receipt = broker.record_base('OWNED')
        self.assertEqual(receipt['apiJobSha256'], broker.initial['apiJobSha256'])
        self.assertEqual(receipt['originalReceiptSha256'], broker.initial['originalReceiptSha256'])

    def test_scope_is_constructed_only_with_the_source_recovery_action(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = {'candidateSha256': 'a' * 64, 'configurationSha256': {'owned': 'b' * 64},
                          'recoveryActionId': 'owned-recovery'}
        broker.lock_fd, broker.check, broker.selected, broker.jobs = 9, lambda: None, selected(), {'frontend': {}}
        captured = {}

        class Scope:
            def __init__(self, *args, **kwargs):
                captured.update(args=args, kwargs=kwargs)

        with patch.object(recovery, 'P2ProfiledCurrentScope', Scope):
            result = broker.create_scope({'status': 'DATABASE_VERIFIED'})
        self.assertIsInstance(result, Scope)
        self.assertEqual(captured['kwargs']['recovery_action_id'], 'owned-recovery')
        self.assertEqual(captured['kwargs']['release'], broker.selected)

    def test_runtime_uses_original_release_confirmation_and_typed_scope_not_recovery_confirmation(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.scope, broker.prior_gateway, broker.worker = object(), object(), None
        broker.initial = initial('resume-approved-api-suffix')
        broker.bundle, broker.configuration, broker.results = Path('/owned/bundle'), Path('/owned/configuration'), Path('/owned/results')
        broker.source, broker.selected = Path('/owned/source'), selected()
        broker.runtime_released, broker.failed, broker.worker_done = threading.Event(), threading.Event(), threading.Event()
        broker.runtime_released.set(); sent = []
        broker.send = lambda *args, **kwargs: sent.append((args, kwargs))
        calls = []

        ready = {'status': 'API_RUNTIME_READY'}
        broker.ready = ready; broker.api_suffix_resumed = True

        def execute(*args, **kwargs):
            calls.append((args, kwargs)); return ready

        with patch.object(recovery.runtime, 'execute', execute):
            broker.start_runtime(17); broker.worker.join(2)
        self.assertTrue(broker.worker_done.is_set()); self.assertFalse(broker.failed.is_set())
        self.assertEqual(calls[0][0][5], 'staging/original-release')
        self.assertIs(calls[0][1]['_profiled_current_scope'], broker.scope)
        self.assertEqual(calls[0][1]['expected_profile'], recovery.PROFILE)
        self.assertEqual(sent, [])

    def test_restore_runtime_uses_only_the_read_only_proof_and_never_enters_migration_execute(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = initial('restore-current-runtime')
        broker.scope, broker.prior_gateway, broker.worker = object(), object(), None
        broker.bundle, broker.configuration, broker.results = Path('/owned/bundle'), Path('/owned/configuration'), Path('/owned/results')
        broker.source, broker.selected = Path('/owned/source'), selected()
        broker.current_database_proof = object()
        broker.runtime_released, broker.failed, broker.worker_done = threading.Event(), threading.Event(), threading.Event()
        broker.runtime_released.set(); broker.send = lambda *_args, **_kwargs: None
        ready = {'status': 'API_RUNTIME_READY'}; broker.ready = ready
        calls = []
        def restore(*args, **kwargs):
            calls.append((args, kwargs)); return ready
        with patch.object(recovery.runtime, 'restore_profiled_current_runtime', restore, create=True), \
                patch.object(recovery.runtime, 'execute', side_effect=AssertionError('migration executor called')):
            broker.start_runtime(17); broker.worker.join(2)
        self.assertTrue(broker.worker_done.is_set()); self.assertFalse(broker.failed.is_set())
        self.assertIs(calls[0][0][4], broker.current_database_proof)
        self.assertIs(calls[0][1]['_profiled_current_scope'], broker.scope)

    def test_restore_proves_api_current_before_prior_gateway_without_a_migration_entrypoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / 'source'; results = root / 'results'
            checker = source / 'ops/platform/host/database_current.mjs'
            checker.parent.mkdir(parents=True); checker.write_text('export {}\n'); results.mkdir()
            broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
            broker.initial = {**initial('restore-current-runtime'),
                              'sourceSha256': {'ops/platform/host/database_current.mjs': recovery.sha(checker.read_bytes())}}
            broker.scope, broker.prior_gateway, broker.worker = object(), None, None
            broker.source, broker.results, broker.selected = source, results, selected()
            broker.jobs = {'frontend': {}, 'course': {}, 'community': {}}
            broker.check = lambda: None
            captured = {}
            proof = object()
            def check_all(selected_value, jobs, output, credentials, checker_value, checker_hash, **kwargs):
                captured.update(selected=selected_value, jobs=jobs, credentials=credentials, checker=checker_value,
                                checker_hash=checker_hash, kwargs=kwargs)
                output.mkdir()
                receipt = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                           'status': 'CURRENT_DATABASES_READ_ONLY_VERIFIED', 'migrationsExecuted': False,
                           'trafficAuthorized': False}
                (output / 'current-databases-outcome.json').write_text(json.dumps(receipt))
                return proof
            with patch.dict(os.environ, {'COURSE_STAGING_DATABASE_URL': 'course', 'COMMUNITY_STAGING_DATABASE_URL': 'community'}), \
                    patch.object(recovery.current_databases, 'check_all', check_all):
                receipt = broker.verify_current_apis()
            self.assertIs(broker.current_database_proof, proof)
            self.assertEqual(receipt['status'], 'CURRENT_DATABASES_READ_ONLY_VERIFIED')
            self.assertEqual(captured['credentials'], {'course': 'course', 'community': 'community'})
            self.assertIs(captured['kwargs']['_profiled_current_scope'], broker.scope)

    def test_api_suffix_is_source_disposition_bound_and_never_claims_frontend_sql_replay(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = initial('resume-approved-api-suffix')
        broker.initial['approvedApiSuffix']['community'] = []
        runtime_receipt = {'status': 'API_RUNTIME_READY'}
        migration_receipt = {'status': 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN'}
        broker._require_current_api = lambda: (runtime_receipt, migration_receipt)
        broker.api_runtime_raw, broker.api_migration_raw = b'runtime\n', b'migration\n'
        broker.record_base = lambda status: {'status': status}
        broker.runtime_released = threading.Event()
        with tempfile.TemporaryDirectory() as temporary:
            broker.migration_attempt = Path(temporary)
            broker.jobs = {}
            for service, approved in broker.initial['approvedApiSuffix'].items():
                broker.jobs[service] = {'job': {'target': {'approvedPendingTags': approved}}}
                directory = broker.migration_attempt / service; directory.mkdir()
                receipt = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                           'applyStarted': bool(approved), 'applyCompleted': bool(approved), 'preAppliedCount': 10,
                           'postAppliedCount': 10 + len(approved), 'failureCode': None}
                (directory / 'database-receipt.json').write_text(json.dumps(receipt))
            result = broker.resume_api_suffix()
        self.assertEqual(result['status'], 'P2_PROFILED_CURRENT_API_SUFFIX_RESUMED')
        self.assertTrue(broker.api_suffix_resumed)
        broker.initial = initial('restore-current-runtime')
        with self.assertRaises(Exception):
            broker.resume_api_suffix()

    def test_frontend_reconciliation_keeps_outer_get_first_and_inner_workload_proofs_distinct(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        configuration = {'runtime.json': 'a' * 64}
        broker.initial = {**initial('reconcile-frontend-get-first'), 'sourceCommit': 'a' * 40,
                          'candidateSha256': 'b' * 64, 'configurationSha256': configuration,
                          'targetSha256': 'c' * 64}
        broker.selected, broker.promoted, broker.closing_at = selected(), None, None
        broker._require_current_api = lambda: ({}, {})
        broker.record_base = lambda status: {'status': status}
        proof = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                 'status': 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED'}
        observation = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                       'status': 'P2_PROFILED_CURRENT_FRONTEND_CURRENT', 'getFirst': True,
                       'newProviderPost': False, 'ambiguous': False, 'originalEffectReconciled': True,
                       'releaseId': 'original-release', 'sourceCommit': 'a' * 40,
                       'candidateSha256': 'b' * 64, 'configurationSha256': configuration,
                       'targetSha256': 'c' * 64, 'proof': proof,
                       'originalReceiptSha256': recovery.sha(recovery.encoded(dict(sorted(broker.initial['originalReceiptSha256'].items())))),
                       'workloadReceiptSha256': None}
        workload = 'eyJvd25lZCI6dHJ1ZX0='
        proof['workloadReceiptSha256'] = observation['workloadReceiptSha256'] = 'd' * 64
        captured = []
        with patch.object(recovery.P2ProfiledCurrentBroker, 'verify_frontend',
                          side_effect=lambda current, actual, raw: captured.append((current, actual, raw))):
            result = broker.reconcile_frontend({'observation': observation, 'proof': proof, 'workload': workload})
        self.assertEqual(result['status'], 'P2_PROFILED_CURRENT_FRONTEND_CURRENT')
        self.assertEqual(captured, [(broker, proof, workload)])
        self.assertEqual(broker.recovery_frontend_observation, observation)
        changed = copy.deepcopy(observation); changed['proof']['status'] = 'FORGED'
        with self.assertRaises(Exception):
            broker.reconcile_frontend({'observation': changed, 'proof': proof, 'workload': workload})

    def test_protocol_has_no_sql_replay_path_or_caller_fields_on_field_free_operations(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.check = lambda: None
        broker.scope, broker.closing_at = None, None
        broker.last_command = 0
        for value in (
                {'id': 1, 'operation': 'profiled-current-recovery-replay-sql'},
                {'id': 1, 'operation': 'profiled-current-recovery-runtime-restored', 'receipt': {}},
                {'id': 1, 'operation': 'profiled-current-recovery-reconcile-frontend', 'observation': {}, 'proof': {}},
                {'id': 1, 'operation': 'profiled-current-recovery-resume-api-suffix', 'suffix': []}):
            with self.assertRaises(Exception):
                broker.command(value)


if __name__ == '__main__':
    unittest.main()
