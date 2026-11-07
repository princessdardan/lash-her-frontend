import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
import os
import subprocess
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
    if disposition == 'reconcile-frontend-lost-build-get-first':
        value['originalReceiptSha256'] = dict(list(value['originalReceiptSha256'].items())[:5])
        value['lostBuildReceiptSha256'] = {'deployStarted': 'a' * 64, 'buildStarted': 'b' * 64,
                                           'buildIntent': 'c' * 64}
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
            promoted_suffix = initial('resume-approved-api-suffix')
            self.assertEqual(broker.select_release(promoted_suffix), selected_inputs(promoted_suffix))
            lost_build = initial('reconcile-frontend-lost-build-get-first')
            self.assertEqual(broker.select_release(lost_build), selected_inputs(lost_build))
            early_current = initial('restore-current-runtime')
            early_current['originalReceiptSha256'] = dict(list(early_current['originalReceiptSha256'].items())[:3])
            self.assertEqual(broker.select_release(early_current), selected_inputs(early_current))
            too_early = copy.deepcopy(early_current)
            too_early['originalReceiptSha256'].pop('frontendContinuationStarted')
            with self.assertRaises(Exception):
                broker.select_release(too_early)
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
        broker.derived_bundle = broker.bundle
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

    def test_early_current_api_restore_releases_runtime_and_closes_with_frontend_action_pending(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = initial('restore-current-runtime')
        broker.initial['originalReceiptSha256'] = dict(list(broker.initial['originalReceiptSha256'].items())[:3])
        broker._require_current_api = lambda: ({'status': 'API_RUNTIME_READY'},
                                               {'status': 'CURRENT_DATABASES_READ_ONLY_VERIFIED'})
        broker._runtime_readback = lambda: None
        broker.check = lambda: None
        broker.vercel = object(); broker.selected = {**selected(), 'workload': {'projectId': 'owned-project'}}
        broker.record_base = lambda status: {'status': status}
        broker.api_runtime_raw, broker.current_database_raw = b'runtime\n', b'current\n'
        broker.runtime_released, broker.worker_done, broker.failed = threading.Event(), threading.Event(), threading.Event()
        with patch.object(recovery.vercel, 'project_state', return_value={
                'projectId': 'owned-project', 'productionDeploymentId': 'dpl_owned', 'cronsEnabled': False}):
            result = broker.runtime_restored()
        self.assertTrue(broker.runtime_current); self.assertTrue(broker.runtime_released.is_set())
        self.assertEqual(result['status'], 'P2_PROFILED_CURRENT_RUNTIME_RESTORED')
        broker.promoted, broker.closing_at, broker.session_closed_proof = None, None, None
        broker.worker_done.set(); broker.verify_api_receipts = lambda: None
        class Observer:
            def __init__(self): self.operations = []
            def probe(self, operation): self.operations.append(operation)
            def stop(self): self.operations.append('stop')
        class Scope:
            def __init__(self): self.closed = False
            def begin_close(self): self.closed = True
        broker.observer, broker.scope = Observer(), Scope()
        with patch.object(recovery.vercel, 'project_state', return_value={
                'projectId': 'owned-project', 'productionDeploymentId': 'dpl_owned', 'cronsEnabled': False}):
            broker.prepare_close()
        self.assertEqual(broker.observer.operations, ['verify-schema', 'stop'])
        self.assertTrue(broker.scope.closed); self.assertIsNotNone(broker.closing_at)
        with patch.object(recovery.vercel, 'project_state', return_value={
                'projectId': 'owned-project', 'productionDeploymentId': 'dpl_owned', 'cronsEnabled': True}):
            with self.assertRaises(Exception):
                broker._require_native_schedules_off()

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

    def test_suffix_preflight_derives_only_remaining_jobs_and_replaces_the_readonly_scope_before_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); bundle = root / 'bundle'; configuration = root / 'configuration'; directory = root / 'recovery'
            for path in (bundle / 'jobs', bundle / 'schema', configuration, directory): path.mkdir(parents=True, mode=0o700)
            for relative in ('release.candidate.json', 'jobs/frontend.json', 'schema/frontend.json', 'schema/course.json', 'schema/community.json'):
                path = bundle / relative; path.write_text('{"owned":true}\n'); path.chmod(0o600)
            jobs = {}
            suffix = {'course': ['0012_owned'], 'community': []}
            for service, original in (('course', ['0011_done', '0012_owned']), ('community', ['0009_owned'])):
                job = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                       'target': {'approvedPendingTags': original, 'allowEmptyBootstrap': False}}
                jobs[service] = {'job': job, 'image': 'owned-' + service, 'service': 'lash-her-' + service + '-api'}
                (bundle / 'jobs' / (service + '.json')).write_bytes(recovery.encoded(job) + b'\n')
            jobs['frontend'] = {'job': {'target': {'approvedPendingTags': []}}, 'image': 'owned-frontend', 'service': 'frontend'}
            derived = copy.deepcopy(jobs)
            hashes = {}
            for service in ('course', 'community'):
                derived[service]['job']['target']['approvedPendingTags'] = suffix[service]
                hashes[service] = recovery.sha(recovery.encoded(derived[service]['job']) + b'\n')
            class Scope:
                receipt = {'status': 'DATABASE_VERIFIED'}
                cleanup_uncertain = False
                def __init__(self): self.revoked = False
                def run(self, args, **_kwargs):
                    if args[1] == 'run':
                        service = 'course' if 'owned-course' in args else 'community'
                        proof = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                                 'service': derived[service]['service'], 'environment': 'staging',
                                 'pendingTags': suffix[service], 'appliedCount': 10}
                        return subprocess.CompletedProcess(args, 0, recovery.encoded(proof), b'')
                    return subprocess.CompletedProcess(args, 0, b'', b'')
                def revoke(self): self.revoked = True
            old_scope, new_scope = Scope(), Scope(); new_scope.bind_runtime_parent = lambda parent: setattr(new_scope, 'parent', parent)
            broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
            broker.initial = {**initial('resume-approved-api-suffix'), 'approvedApiSuffix': suffix,
                              'recoveryApiJobSha256': hashes}
            broker.scope, broker.prior_gateway, broker.worker = old_scope, None, None
            broker.bundle, broker.configuration, broker.directory = bundle, configuration, directory
            broker.source, broker.selected, broker.jobs = root / 'source', selected(), jobs
            broker.check = lambda: None; broker.create_scope = lambda _receipt: new_scope
            broker.record_base = lambda status: {'status': status}
            with patch.dict(os.environ, {'COURSE_STAGING_DATABASE_URL': 'course', 'COMMUNITY_STAGING_DATABASE_URL': 'community'}), \
                    patch.object(recovery.runtime, 'make_plan', return_value=(broker.selected, derived, {}, {})):
                receipt = broker.prepare_api_suffix()
            self.assertTrue(old_scope.revoked); self.assertIs(broker.scope, new_scope); self.assertIs(new_scope.parent, broker)
            self.assertEqual(receipt['status'], 'P2_PROFILED_CURRENT_API_SUFFIX_PREPARED')
            self.assertEqual(broker.jobs['course']['job']['target']['approvedPendingTags'], ['0012_owned'])
            self.assertEqual(broker.jobs['community']['job']['target']['approvedPendingTags'], [])
            self.assertEqual(recovery.sha((broker.derived_bundle / 'jobs/course.json').read_bytes()), hashes['course'])

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
            broker.migration_attempt = Path(temporary) / 'migration'; broker.migration_attempt.mkdir()
            broker.directory = Path(temporary) / 'retained'; broker.directory.mkdir()
            broker.jobs = {}
            broker.api_suffix_lineage_sha256 = {}
            migration_receipt['databaseReceiptSha256'] = {}
            for service, approved in broker.initial['approvedApiSuffix'].items():
                broker.jobs[service] = {'job': {'target': {'approvedPendingTags': approved}}}
                directory = broker.migration_attempt / service; directory.mkdir()
                receipt = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                           'applyStarted': bool(approved), 'applyCompleted': bool(approved), 'preAppliedCount': 10,
                           'postAppliedCount': 10 + len(approved), 'failureCode': None}
                receipt_raw = json.dumps(receipt).encode()
                (directory / 'database-receipt.json').write_bytes(receipt_raw)
                migration_receipt['databaseReceiptSha256'][service] = recovery.sha(receipt_raw)
                lineage = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
                           'pendingTags': approved, 'appliedCount': 10}
                lineage_raw = recovery.encoded(lineage)
                (broker.directory / ('api-suffix-' + service + '-lineage.json')).write_bytes(lineage_raw)
                broker.api_suffix_lineage_sha256[service] = recovery.sha(lineage_raw)
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

    def test_lost_build_observation_is_retained_without_frontend_current_or_replay_claims(self):
        broker = object.__new__(recovery.P2ProfiledCurrentRecoveryBroker)
        broker.initial = {**initial('reconcile-frontend-lost-build-get-first'), 'sourceCommit': 'a' * 40,
                          'candidateSha256': 'b' * 64, 'configurationSha256': {'runtime.json': 'c' * 64},
                          'targetSha256': 'd' * 64}
        broker.selected = {**selected(), 'workload': {'projectId': 'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM'}}
        broker.promoted, broker.closing_at = None, None
        broker._require_current_api = lambda: ({}, {})
        broker.record_base = lambda status: {'status': status}
        retained = []
        broker.retain = lambda name, raw: retained.append((name, raw))
        pins = broker.initial['lostBuildReceiptSha256']
        observation = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(recovery.PROFILE),
            'status': 'P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED', 'environment': 'staging',
            'actionId': 'original-release', 'releaseId': 'original-release', 'sourceCommit': 'a' * 40,
            'candidateSha256': 'b' * 64, 'configurationSha256': {'runtime.json': 'c' * 64},
            'targetSha256': 'd' * 64, 'projectId': 'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',
            'deploymentId': 'dpl_owned', 'previousDeploymentId': 'dpl_previous',
            'lostBuildReceiptSha256': recovery.sha(recovery.encoded(dict(sorted(pins.items())))),
            'deployStartedSha256': pins['deployStarted'], 'buildStartedSha256': pins['buildStarted'],
            'buildIntentSha256': pins['buildIntent'], 'getFirst': True, 'newProviderPost': False,
            'ambiguous': False, 'deploymentEffectObserved': True, 'frontendActionPending': True,
            'originalBuildAckObserved': False, 'providerMutationReplayed': False, 'buildReadyVerified': False,
            'workloadVerified': False, 'aliasQualificationVerified': False, 'promotionVerified': False,
            'cronQualificationVerified': False, 'trafficAuthorized': False, 'releaseAccepted': False}
        receipt = broker.observe_lost_build(observation)
        self.assertEqual(receipt['status'], 'P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_RETAINED')
        self.assertEqual(receipt['observationSha256'], recovery.sha(recovery.encoded(observation)))
        self.assertEqual(retained[0][0], 'frontend-lost-build-observation.json')
        broker.check = lambda: None; broker.vercel = object()
        with patch.object(recovery.vercel, 'project_state', return_value={
                'projectId': 'prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',
                'productionDeploymentId': 'dpl_changed', 'cronsEnabled': False}):
            with self.assertRaises(Exception):
                broker._require_native_schedules_off()
        del broker.lost_build_observation
        del broker.lost_build_observation_sha256
        replayed = copy.deepcopy(observation); replayed['providerMutationReplayed'] = True
        same_deployment = copy.deepcopy(observation); same_deployment['previousDeploymentId'] = same_deployment['deploymentId']
        boolean_version = copy.deepcopy(observation); boolean_version['version'] = True
        for changed in (replayed, same_deployment, boolean_version):
            with self.assertRaises(Exception):
                broker.observe_lost_build(changed)

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
