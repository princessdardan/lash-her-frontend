import base64
import contextlib
import fcntl
import json
import os
import select
import signal
import sys
import unittest
from unittest.mock import patch

import migrate
import p2_frontend_replacement_parent as parent
import p2_frontend_replacement_parent_test as arm_tests
import p2_release_broker as broker_module
import p2_release_supervisor as supervisor
import p2_replacement_runtime_containment as runtime_containment
import p2_replacement_runtime_review as runtime_review
import staging_state
from p2_certification_profile import PROFILE as CERTIFICATION
from p2_profiled_current_scope import COMMON, TARGET


def retained(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def base64_bytes(raw):
    return base64.b64encode(raw).decode()


class ReplacementWrittenProtocolTests(unittest.TestCase):
    def setUp(self):
        arm_tests.ReplacementArmTests.setUp(self)
        self.job.update(environment='staging', contractPhase='p2')
        self.job['target']['approvedPendingTags'] = ['0001_fixture', '0002_fixture']
        job_raw = retained(self.job)
        (self.bundle / 'jobs/frontend.json').write_bytes(job_raw)
        self.admins = [{'name': 'owned_admin_a', 'oid': '50'}, {'name': 'owned_admin_z', 'oid': '51'}]
        self.plan['frontendJobSha256'] = migrate.file_hash(job_raw)
        self.plan['replacement'].update(administrativeLogins=self.admins,
                                        approvedPendingTags=self.job['target']['approvedPendingTags'])
        self.empty_boundary['administrativeLogins'] = self.admins
        self.plan_raw = retained(self.plan)
        plan_sha = migrate.file_hash(self.plan_raw)
        self.write_initial.update(reviewedPlanBytes=base64_bytes(self.plan_raw), reviewedPlanSha256=plan_sha,
                                  confirmation='staging/' + self.release_id + '/replacement-write/' + plan_sha)

        self.owner = {'name': 'lash_her_frontend_staging_admission_owner_p2', 'oid': '44'}
        self.runtime = {'name': self.job['target']['runtimeRole'], 'oid': '45'}
        self.producer = '6' * 64
        binding = {'version': 2, 'qualificationTargetProfile': parent.PROFILE, 'service': 'frontend',
                   **{key: self.job[key] for key in COMMON}, 'operator': 'Dardan', 'migrationMode': 'apply-forward',
                   'target': {key: self.job['target'][key] for key in TARGET},
                   'recoveryRef': self.job['recoveryRef'], 'trafficAuthorized': False}
        after = [{'hash': char * 64, 'created_at': stamp} for char, stamp in (('a', '1762725060000'), ('b', '1762725060001'))]
        self.database = {**binding, 'status': 'DATABASE_VERIFIED', 'before': [], 'after': after,
                         'applied': [{'tag': tag, 'hash': row['hash']}
                                     for tag, row in zip(self.job['target']['approvedPendingTags'], after)],
                         'schemaVerified': True, 'runtimeRoleVerified': True, 'readOnlyVerified': False}
        self.database_raw = retained(self.database)
        self.started_raw = retained({**binding, 'status': 'FRONTEND_CONTINUATION_STARTED', 'databaseVerified': True})
        self.operator_evidence = {'databaseReceipt': base64_bytes(self.database_raw),
                                  'continuationStarted': base64_bytes(self.started_raw),
                                  'owner': self.owner, 'runtime': self.runtime, 'producerSha256': self.producer}
        self.packet = {**self.operator_evidence, 'probe': self.probe,
                       'physicalObservation': base64_bytes(self.raw_observation), 'administrativeLogins': self.admins}
        self.written = {**json.loads(self.raw_observation), 'operation': 'verify-replacement-written',
                        'status': 'P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED',
                        'physicalObservationSha256': migrate.file_hash(self.raw_observation),
                        'databaseReceiptSha256': migrate.file_hash(self.database_raw),
                        'continuationStartedSha256': migrate.file_hash(self.started_raw),
                        'owner': self.owner, 'runtime': self.runtime, 'producerSha256': self.producer,
                        'appliedMigrationCount': 2, 'epoch': '1', 'newWork': False, 'recovery': False,
                        'active': 0, 'uncertain': 0, 'schemaVerified': True, 'runtimeRoleVerified': True,
                        'administrativeLogins': self.admins, 'effectiveLoginBoundaryVerified': True}
        self.written_raw = retained(self.written)

    def test_written_result_binds_exact_receipts_roles_and_reviewed_admins(self):
        parent.written_result(self.packet, self.written_raw)
        for field, value in (
            ('physicalObservationSha256', '1' * 64),
            ('databaseReceiptSha256', '1' * 64),
            ('continuationStartedSha256', '1' * 64),
            ('owner', {**self.owner, 'oid': '46'}),
            ('runtime', {**self.runtime, 'oid': '47'}),
            ('producerSha256', '1' * 64),
            ('administrativeLogins', self.admins[::-1]),
            ('effectiveLoginBoundaryVerified', False),
            ('active', False),
            ('trafficAuthorized', True),
        ):
            with self.subTest(field=field), self.assertRaises(ValueError):
                parent.written_result(self.packet, retained({**self.written, field: value}))

    def test_matching_raw_hash_cannot_authorize_duplicate_or_reordered_journal(self):
        first, second = self.database['after']
        for after in ([first, {**second, 'created_at': first['created_at']}], [second, first]):
            changed = retained({**self.database, 'after': after})
            with self.subTest(after=after), self.assertRaises(ValueError):
                parent.written_result({**self.packet, 'databaseReceipt': base64_bytes(changed)},
                                      retained({**self.written, 'databaseReceiptSha256': migrate.file_hash(changed)}))

    def test_broker_refuses_readback_without_write_custody(self):
        emitted = []
        broker = parent.ReplacementWriteBroker(self.write_initial, emitted.append, image=self.image)
        broker.probe, broker.plan, broker.directory = self.probe, self.plan, self.write_directory
        request = {'id': 1, 'operation': 'verify-replacement-written', 'writeIntentSha256': '2' * 64,
                   **self.operator_evidence}
        with (patch.object(broker, 'check'), patch.object(broker, 'safety') as safety,
              self.assertRaises(ValueError)):
            broker.command(request)
        safety.assert_not_called()
        self.assertEqual(emitted, [])

    def test_broker_refuses_reviewed_runtime_start_before_readback(self):
        emitted = []
        broker = parent.ReplacementWriteBroker(self.write_initial, emitted.append, image=self.image,
                                                runtime_review={'producerSha256': self.producer})
        with (patch.object(broker, 'safety') as safety, self.assertRaises(ValueError)):
            broker.command({'id': 1, 'operation': 'start-replacement-runtime',
                            'postflightSha256': migrate.file_hash(self.written_raw)})
        safety.assert_not_called()
        self.assertIsNone(broker.worker)
        self.assertEqual(emitted, [])

    def test_broker_refuses_planted_result_without_matching_guard_return(self):
        emitted = []
        broker = parent.ReplacementWriteBroker(self.write_initial, emitted.append, image=self.image)
        broker.probe, broker.plan, broker.directory = self.probe, self.plan, self.write_directory
        broker.source = self.root
        broker.custody = {'armReceiptSha256': '3' * 64, 'emptyCatalogReceipt': self.empty_boundary}
        broker.guard_alive, broker.write_observation = True, self.raw_observation
        self.write_directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.write_directory, parent.WRITTEN_OBSERVATION, self.written_raw)
        started = parent.write_observer_receipt(self.write_initial, self.probe, self.raw_observation, 'WRITTEN_STARTED')
        migrate.write_json(self.write_directory, parent.WRITTEN_OBSERVER_STARTED, started)
        intent_sha = '2' * 64
        request = {'id': 1, 'operation': 'verify-replacement-written', 'writeIntentSha256': intent_sha,
                   **self.operator_evidence}
        with (patch.object(broker, 'check'), patch.object(broker, 'safety'),
              patch.object(parent, 'require_write_custody', return_value=({}, intent_sha, self.raw_observation))):
            with self.assertRaises(FileNotFoundError):
                broker.command(request)
            returned = parent.write_observer_receipt(self.write_initial, self.probe, self.raw_observation, 'WRITTEN_RETURNED')
            migrate.write_json(self.write_directory, parent.WRITTEN_OBSERVER_RETURNED,
                               {**returned, 'physicalObservationSha256': '1' * 64})
            with self.assertRaises(ValueError):
                broker.command(request)
        self.assertIsNone(broker.verified_written)
        self.assertEqual(emitted, [])

    def test_unreturned_written_observer_preserves_containment_uncertainty(self):
        self.write_directory.mkdir(mode=0o700)
        migrate.write_json(self.write_directory, parent.WRITTEN_OBSERVER_STARTED,
                           parent.write_observer_receipt(self.write_initial, self.probe, self.raw_observation, 'WRITTEN_STARTED'))
        with (patch.object(supervisor, 'verify_guard_lock'), patch.object(parent, 'remove_container', return_value=False),
              patch.object(parent, 'run_replacement_image', return_value=self.raw_abort) as run):
            with self.assertRaises(ValueError):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
            run.assert_called_once_with(self.write_initial, self.image, self.probe, abort_observation=self.raw_observation)
        self.assertEqual((self.write_directory / parent.ABORT_OBSERVATION).read_bytes(), self.raw_abort)
        record = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertEqual(record['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN')
        self.assertTrue(record['backendClosureVerified'])
        self.assertFalse(record['observerLauncherReconciled'])
        self.assertFalse(record['automaticReplayAuthorized'])

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_guard_acknowledges_only_its_own_raw_observation_then_contains_duplicate(self):
        self.exercise_guard('duplicate')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_guard_refuses_invalid_independent_observation_and_contains(self):
        self.exercise_guard('wrong-observer-digest')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_broker_refuses_wrong_write_intent_without_running_written_observer(self):
        self.exercise_guard('wrong-write-intent')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_runtime_start_without_review_refuses_even_with_exact_readback_digest(self):
        self.exercise_guard('runtime-no-review')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_reviewed_runtime_refuses_wrong_postflight_digest(self):
        self.exercise_guard('runtime-wrong-digest')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_reviewed_runtime_starts_once_and_contains_duplicate(self):
        self.exercise_guard('runtime-duplicate')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_reviewed_runtime_eof_reaps_worker_and_contains_under_flock(self):
        self.exercise_guard('runtime-eof')

    def runtime_review_fixture(self):
        initial = self.write_initial
        review = {**{key: self.plan[key] for key in ('version', 'qualificationTargetProfile', 'environment', 'releaseId',
                                                     'sourceCommit', 'candidateSha256', 'targetSha256')},
                  **{key: initial[key] for key in ('reviewedPlanSha256', 'hostMachineId')},
                  'configuration': str(self.root / 'owned-reviewed-config'), 'certification': CERTIFICATION,
                  'configurationSha256': dict.fromkeys(staging_state.CONFIGURATION_FILES, '2' * 64),
                  'apiJobSha256': dict.fromkeys(migrate.SERVICES, '3' * 64), 'producerSha256': self.producer}
        raw = retained(review)
        digest = migrate.file_hash(raw)
        return {**initial, 'runtimeReviewBytes': base64_bytes(raw), 'runtimeReviewSha256': digest,
                'confirmation': initial['confirmation'] + '/' + digest,
                'credentials': {**initial['credentials'], **dict.fromkeys(parent.API_CREDENTIALS, 'owned-api-private')}}, review, raw

    def exercise_guard(self, scenario):
        starting_runtime = scenario.startswith('runtime-')
        has_review = starting_runtime and scenario != 'runtime-no-review'
        runtime_ready = scenario in ('runtime-duplicate', 'runtime-eof')
        initial, review, review_raw = self.runtime_review_fixture() if has_review else (self.write_initial, None, None)
        lock = self.root / 'owned-host.lock'
        lock_fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.addCleanup(os.close, lock_fd)
        inbound, send = os.pipe()
        receive, outbound = os.pipe()
        directory = self.write_directory
        runtime_effect = directory / 'owned-runtime-effect.json'
        runtime_cleanup = directory / 'owned-runtime-cleanup.json'
        child = os.fork()
        if child == 0:
            for fd in (send, receive, lock_fd):
                os.close(fd)
            sys.stdin, sys.stdout = os.fdopen(inbound), os.fdopen(outbound, 'w')
            guard_pid = os.getpid()

            def assert_lock_held():
                with lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                    fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            def prepare(value, source, *, mode):
                self.assertEqual(source, self.root)
                self.assertEqual(parent.reviewed_plan(value, mode=mode), (self.plan_raw, self.plan))
                return self.plan_raw, self.plan, self.probe_base, self.image, directory

            def prepare_review(value, plan, source, probe):
                self.assertTrue(has_review)
                self.assertEqual((plan, source), (self.plan, self.root))
                self.assertIn(probe, (self.probe_base, self.probe))
                self.assertEqual(runtime_review.reviewed_bytes(value), review_raw)
                return review

            def run_image(args, packet, env):
                self.assertEqual(os.getpid(), guard_pid)
                self.assertEqual(args[-3:-1], [self.image, 'ops/platform/frontend-image.mjs'])
                self.assertIn('--pull=never', args)
                self.assertIn('--read-only', args)
                self.assertNotIn('--mount', args)
                self.assertNotIn(self.write_initial['credentials'][parent.CREDENTIAL], args)
                self.assertEqual(env[parent.CREDENTIAL], self.write_initial['credentials'][parent.CREDENTIAL])
                assert_lock_held()
                if args[-1] == '--abort-replacement':
                    self.assertEqual(runtime_cleanup.exists(), runtime_ready)
                    self.assertEqual(json.loads(packet), {'probe': self.probe,
                                     'physicalObservation': base64_bytes(self.raw_observation)})
                    return self.raw_abort
                self.assertEqual(args[-1], '--observe-replacement-written')
                self.assertEqual(json.loads(packet), self.packet)
                if scenario == 'wrong-observer-digest':
                    return retained({**self.written, 'databaseReceiptSha256': '1' * 64})
                return self.written_raw

            def start_runtime(broker):
                self.assertTrue(runtime_ready)
                self.assertNotEqual(os.getpid(), guard_pid)
                assert_lock_held()
                expected = parent.runtime_intent_record(initial, self.plan, review, self.written_raw)
                self.assertEqual(broker.runtime_intent, (directory / parent.RUNTIME_INTENT).read_bytes())
                self.assertEqual(json.loads(broker.runtime_intent), expected)
                self.assertEqual((directory / parent.RUNTIME_REVIEW).read_bytes(), review_raw)
                self.assertEqual(broker.written_request, self.packet)
                migrate.write_json(directory, runtime_effect.name, {'runtimeIntentSha256': migrate.file_hash(broker.runtime_intent)})
                migration_raw = retained({'status': 'OWNED_TEST_API_DATABASES_VERIFIED'})
                migrate.write_exact_bytes(directory, 'migration-outcome.json', migration_raw)
                outcome = {'status': 'API_RUNTIME_READY', 'candidateSha256': initial['candidateSha256'],
                           'migrationOutcomeSha256': migrate.file_hash(migration_raw),
                           'frontendReplacementReadbackSha256': migrate.file_hash(self.written_raw),
                           'frontendSqlApplied': True, 'frontendSqlReplayed': False,
                           'trafficAuthorized': False, 'releaseAccepted': False}
                migrate.write_json(directory, 'runtime-outcome.json', outcome)
                try:
                    with patch.object(broker, 'verify_replacement_runtime', side_effect=broker.check):
                        broker.replacement_runtime_ready(directory, directory, {}, self.candidate, outcome)
                except ValueError:
                    if not broker.failed.is_set():
                        raise
                finally:
                    broker.worker_done.set()

            def contain_runtime(value, plan, selected, retained_directory, *, configuration_sha256, worker_reaped):
                self.assertEqual(os.getpid(), guard_pid)
                self.assertTrue(runtime_ready and worker_reaped)
                self.assertEqual((plan, selected, retained_directory), (self.plan, self.candidate, directory))
                self.assertEqual(value['configuration'], review['configuration'])
                self.assertEqual(configuration_sha256, review['configurationSha256'])
                self.assertTrue(runtime_effect.exists())
                assert_lock_held()
                migrate.write_json(directory, runtime_cleanup.name, {'workerReaped': worker_reaped})

            try:
                with (patch.object(parent, 'LOCK', lock), patch.object(supervisor, 'LOCK', lock),
                      patch.object(broker_module, 'LOCK', lock),
                      patch.object(parent, 'prepare', side_effect=prepare),
                      patch.object(supervisor, '_verify_guard_source'),
                      patch.object(parent.ReplacementArmBroker, 'require_source_closure'),
                      patch.object(parent, 'observe', return_value=self.raw_observation),
                      patch.object(parent, 'run_bounded_image', side_effect=run_image),
                      patch.object(runtime_review, 'prepare_runtime_review', side_effect=prepare_review),
                      patch.object(parent.ReplacementWriteBroker, 'run_replacement_runtime', start_runtime),
                      patch.object(parent.ReplacementWriteBroker, 'verify_replacement_gateway_closed'),
                      patch.object(runtime_containment, 'contain_replacement_runtime_after_reap', side_effect=contain_runtime),
                      patch.object(parent, 'remove_container', return_value=False)):
                    parent.qualify_replacement_write_frontier(initial, self.root)
            except BaseException:
                os._exit(1)
            os._exit(0)

        os.close(inbound)
        os.close(outbound)
        reaped = False
        try:
            with os.fdopen(send, 'wb') as commands, os.fdopen(receive, 'rb', buffering=0) as results:
                def send_frame(value):
                    commands.write(parent.encoded(value) + b'\n')
                    commands.flush()

                def response():
                    self.assertTrue(select.select([results], [], [], 12)[0], 'no response from owned guard fixture')
                    raw = results.readline()
                    return json.loads(raw) if raw else None

                self.assertEqual(response(), {'id': 0, 'status': 'LOCKED'})
                send_frame({'id': 1, 'operation': 'arm-replacement', 'probe': self.probe})
                armed = response()
                self.assertEqual(armed['status'], 'REPLACEMENT_ARMED')
                send_frame({'id': 2, 'operation': 'authorize-replacement-write', 'armReceiptSha256': armed['armReceiptSha256'],
                            'emptyCatalogReceipt': self.empty_boundary})
                custody = response()
                self.assertEqual(custody['status'], 'REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED')
                request = {'id': 3, 'operation': 'verify-replacement-written',
                           'writeIntentSha256': custody['writeIntentSha256'], **self.operator_evidence}
                if scenario == 'wrong-write-intent':
                    request['writeIntentSha256'] = '1' * 64
                send_frame(request)
                written = directory / parent.WRITTEN_OBSERVATION
                if scenario == 'duplicate' or starting_runtime:
                    self.assertEqual(response(), {'id': 3, 'status': 'REPLACEMENT_WRITTEN_VERIFIED',
                                                 'postflightSha256': migrate.file_hash(self.written_raw)})
                    self.assertEqual(written.read_bytes(), self.written_raw)
                    self.assertEqual(written.stat().st_mode & 0o777, 0o600)
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if scenario == 'duplicate':
                    send_frame({**request, 'id': 4})
                if starting_runtime:
                    runtime_request = {'id': 4, 'operation': 'start-replacement-runtime',
                                       'postflightSha256': migrate.file_hash(self.written_raw)}
                    if scenario == 'runtime-wrong-digest':
                        runtime_request['postflightSha256'] = '1' * 64
                    self.assertFalse((directory / parent.RUNTIME_INTENT).exists())
                    send_frame(runtime_request)
                    if runtime_ready:
                        outcome = response()
                        self.assertEqual(outcome, {'id': 4, 'status': 'REPLACEMENT_API_RUNTIME_READY',
                                                  'runtimeOutcomeSha256': migrate.file_hash((directory / 'runtime-outcome.json').read_bytes()),
                                                  'migrationOutcomeSha256': migrate.file_hash((directory / 'migration-outcome.json').read_bytes())})
                        intent = directory / parent.RUNTIME_INTENT
                        self.assertEqual(json.loads(intent.read_bytes()), parent.runtime_intent_record(initial, self.plan, review, self.written_raw))
                        self.assertEqual(intent.stat().st_mode & 0o777, 0o600)
                        self.assertFalse(runtime_cleanup.exists())
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if scenario == 'runtime-duplicate':
                            send_frame({**runtime_request, 'id': 5})
                        else:
                            commands.close()
                failure = response()
                if failure is not None:
                    self.assertEqual(failure['status'], 'P2_HOST_STAGE_FAILED')
                    self.assertIsNone(response())

            _, status = os.waitpid(child, 0)
            reaped = True
            self.assertEqual(os.waitstatus_to_exitcode(status), 1)
            self.assertEqual(written.exists(), scenario == 'duplicate' or starting_runtime)
            if written.exists():
                self.assertEqual(written.read_bytes(), self.written_raw)
            self.assertEqual((directory / parent.WRITTEN_OBSERVER_STARTED).exists(), scenario != 'wrong-write-intent')
            self.assertEqual((directory / parent.RUNTIME_REVIEW).exists(), has_review)
            if has_review:
                self.assertEqual((directory / parent.RUNTIME_REVIEW).read_bytes(), review_raw)
            self.assertEqual((directory / parent.RUNTIME_INTENT).exists(), runtime_ready)
            self.assertEqual(runtime_effect.exists(), runtime_ready)
            self.assertEqual(runtime_cleanup.exists(), runtime_ready)
            self.assertFalse((directory / parent.COMMIT_INTENT).exists())
            self.assertFalse((directory / parent.TERMINAL).exists())
            self.assertEqual((directory / parent.ABORT_OBSERVATION).read_bytes(), self.raw_abort)
            containment = json.loads((directory / parent.WRITE_CONTAINMENT).read_bytes())
            # The mocked worker never launches the long-lived physical
            # observer, so its reconciliation has no retained evidence.
            expected_containment = ('P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN' if runtime_ready else
                                    'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW')
            self.assertEqual(containment['status'], expected_containment)
            self.assertTrue(containment['backendClosureVerified'])
            self.assertIs(containment['observerLauncherReconciled'], not runtime_ready)
            self.assertFalse(containment['automaticReplayAuthorized'])
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if not reaped:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)


if __name__ == '__main__':
    unittest.main()
