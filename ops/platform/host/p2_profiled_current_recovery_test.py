import copy
from pathlib import Path
import tempfile
import threading
import unittest
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
             'disposition': disposition, 'originalReceiptSha256': digests()}
    if disposition == 'resume-approved-api-suffix':
        value['approvedApiSuffix'] = {'course': ['0012_owned'], 'community': ['0009_owned']}
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
            broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
            broker.bundle, broker.results, broker.selected = bundle, results, selected()
            broker.initial = {'originalReceiptSha256': pins}
            with patch.object(recovery.P2ProfiledCurrentBroker, 'initialize', return_value=None):
                broker.initialize()
                (results / release / 'migration-outcome.json').write_bytes(b'{"changed":true}\n')
                with self.assertRaises(Exception):
                    broker.initialize()

    def test_source_selection_requires_distinct_action_closed_disposition_and_exact_original_pins(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        expected = (selected(), {'frontend': {}, 'course': {}, 'community': {}}, {'hostMachineId': 'owned'}, {})
        with patch.object(recovery.P2ProfiledCurrentBroker, 'select_release', return_value=expected):
            self.assertEqual(broker.select_release(initial()), expected)
            self.assertEqual(broker.select_release(initial('resume-approved-api-suffix')), expected)
            for change in (
                    lambda value: value.update(recoveryActionId='original-release'),
                    lambda value: value.update(disposition='retry-sql'),
                    lambda value: value['originalReceiptSha256'].pop('apiRuntimeOutcome'),
                    lambda value: value['originalReceiptSha256'].update(candidate='0' * 64),
                    lambda value: value.update(approvedApiSuffix={'course': [], 'community': []})):
                changed = initial(); change(changed)
                with self.assertRaises(Exception):
                    broker.select_release(changed)

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
        broker.bundle, broker.configuration, broker.results = Path('/owned/bundle'), Path('/owned/configuration'), Path('/owned/results')
        broker.source, broker.selected = Path('/owned/source'), selected()
        broker.runtime_released, broker.failed, broker.worker_done = threading.Event(), threading.Event(), threading.Event()
        broker.runtime_released.set(); sent = []
        broker.send = lambda *args, **kwargs: sent.append((args, kwargs))
        calls = []

        ready = {'status': 'API_RUNTIME_READY'}
        broker.ready = ready

        def execute(*args, **kwargs):
            calls.append((args, kwargs)); return ready

        with patch.object(recovery.runtime, 'execute', execute):
            broker.start_runtime(17); broker.worker.join(2)
        self.assertTrue(broker.worker_done.is_set()); self.assertFalse(broker.failed.is_set())
        self.assertEqual(calls[0][0][5], 'staging/original-release')
        self.assertIs(calls[0][1]['_profiled_current_scope'], broker.scope)
        self.assertEqual(calls[0][1]['expected_profile'], recovery.PROFILE)
        self.assertEqual(sent, [])

    def test_api_suffix_is_source_disposition_bound_and_never_claims_frontend_sql_replay(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = initial('resume-approved-api-suffix')
        runtime_receipt = {'status': 'API_RUNTIME_READY'}
        migration_receipt = {'approvedApiSuffix': broker.initial['approvedApiSuffix'],
                             'committedPrefixReplayed': False, 'frontendSqlApplied': False}
        broker._require_current_api = lambda: (runtime_receipt, migration_receipt)
        broker.record_base = lambda status: {'status': status}
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
