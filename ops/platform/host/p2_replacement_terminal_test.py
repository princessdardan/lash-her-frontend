import contextlib
from concurrent.futures import Future
import fcntl
import json
import os
import sys
import threading
import unittest
from unittest.mock import Mock, patch

import migrate
import p2_frontend_replacement_parent as parent
import p2_release_supervisor as supervisor
import p2_replacement_terminal as terminal
import p2_replacement_written_protocol_test as written_fixture
import staging_state
import vercel

base64_bytes = written_fixture.base64_bytes
retained = written_fixture.retained


class ReplacementTerminalTests(unittest.TestCase):
    def setUp(self):
        written_fixture.ReplacementWrittenProtocolTests.setUp(self)
        compose = b'owned-compose\n'
        self.candidate.update(phase2ContractManifestSha256=self.job['phase2ContractManifestSha256'],
                              runtime={'composeSha256': 'sha256:' + migrate.file_hash(compose)})
        candidate = retained(self.candidate)
        (self.bundle / 'release.candidate.json').write_bytes(candidate)
        self.plan['candidateSha256'] = self.write_initial['candidateSha256'] = migrate.file_hash(candidate)
        self.plan_raw = retained(self.plan)
        plan_sha = migrate.file_hash(self.plan_raw)
        self.write_initial.update(reviewedPlanBytes=base64_bytes(self.plan_raw), reviewedPlanSha256=plan_sha,
                                  confirmation='staging/' + self.release_id + '/replacement-write/' + plan_sha)
        self.initial, self.review, _ = written_fixture.ReplacementWrittenProtocolTests.runtime_review_fixture(self)
        self.initial['vercelToken'] = 'owned-private-provider-token'
        self.write_directory.mkdir(mode=0o700)
        self.attempt = self.results / ('runtime-profiled-frontend-replacement-' + self.release_id)
        self.migration = self.results / ('migration-profiled-frontend-replacement-' + self.release_id)
        self.snapshot = self.attempt / 'configuration'
        for path in (self.attempt, self.migration, self.snapshot, self.attempt / 'migration-input', self.migration / 'frontend'):
            path.mkdir(mode=0o700)
        (self.attempt / 'migration-input/jobs').mkdir(mode=0o700)
        migrate.write_exact_bytes(self.attempt / 'migration-input', 'release.candidate.json', candidate)
        migrate.write_exact_bytes(self.migration, 'candidate.json', candidate)
        migrate.write_exact_bytes(self.snapshot, 'compose.yaml', compose)
        for name in staging_state.CONFIGURATION_FILES:
            path = self.snapshot / name
            path.parent.mkdir(mode=0o700, exist_ok=True, parents=True)
            path.write_bytes(b'owned-config\n')
        self.review['configurationSha256'] = staging_state.configuration_hashes(self.snapshot)
        pins = {'frontend': migrate.file_hash(self.database_raw)}
        (self.bundle / 'jobs').chmod(0o700)
        for service in migrate.SERVICES:
            directory = self.migration / service
            directory.mkdir(mode=0o700)
            raw = retained({'service': service})
            migrate.write_exact_bytes(directory, 'database-receipt.json', raw)
            pins[service] = migrate.file_hash(raw)
            job = retained({'service': service, 'exact': True})
            (self.migration / (service + '-input')).mkdir(mode=0o700)
            migrate.write_exact_bytes(self.migration / (service + '-input'), 'job.json', job)
            migrate.write_exact_bytes(self.attempt / 'migration-input/jobs', service + '.json', job)
            migrate.write_exact_bytes(self.bundle / 'jobs', service + '.json', job)
            self.review['apiJobSha256'][service] = migrate.file_hash(job)
        review_raw = retained(self.review)
        self.initial.update(runtimeReviewBytes=base64_bytes(review_raw), runtimeReviewSha256=migrate.file_hash(review_raw),
                            confirmation=self.write_initial['confirmation'] + '/' + migrate.file_hash(review_raw))
        migrate.write_exact_bytes(self.write_directory, parent.RUNTIME_REVIEW, review_raw)
        migrate.write_exact_bytes(self.write_directory, parent.WRITTEN_OBSERVATION, self.written_raw)
        migrate.write_json(self.write_directory, parent.RUNTIME_INTENT,
                           parent.runtime_intent_record(self.initial, self.plan, self.review, self.written_raw))
        common = {'version': 2, 'qualificationTargetProfile': parent.PROFILE, 'phase': 'completed', 'environment': 'staging',
                  'releaseId': self.release_id, 'candidateSha256': self.plan['candidateSha256'], 'frontendSqlApplied': True,
                  'frontendMigrationMode': 'apply-forward', 'frontendReadOnlyVerified': False,
                  'frontendReplacementReadbackSha256': migrate.file_hash(self.written_raw),
                  'frontendContinuationStartedSha256': migrate.file_hash(self.started_raw),
                  **dict.fromkeys(terminal.FALSE_FLAGS, False), **migrate.contract_identity(self.candidate)}
        self.migration_raw = retained({**common, 'status': 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN',
                                       'databaseReceiptSha256': pins})
        self.runtime_raw = retained({**common, 'status': 'API_RUNTIME_READY', 'sourceCommit': self.commit,
                                     'configurationSha256': self.review['configurationSha256'],
                                     'migrationOutcomeSha256': migrate.file_hash(self.migration_raw), 'containers': []})
        migrate.write_exact_bytes(self.attempt, 'runtime-outcome.json', self.runtime_raw)
        migrate.write_exact_bytes(self.migration, 'migration-outcome.json', self.migration_raw)
        for original, copied, raw in (
            ('frontend-original-database-receipt.json', 'database-receipt.json', self.database_raw),
            ('frontend-continuation-started.json', 'frontend-continuation-started.json', self.started_raw),
            ('frontend-replacement-written-observation.json', 'frontend-replacement-written-observation.json', self.written_raw),
        ):
            migrate.write_exact_bytes(self.write_directory, original, raw)
            migrate.write_exact_bytes(self.migration / 'frontend', copied, raw)
        self.api = terminal.read_api(self.initial, self.plan, self.review, self.candidate, self.write_directory, self.packet, self.written_raw)
        self.base = terminal.release_base(self.initial, self.plan, self.review, self.candidate, self.written_raw, self.api)
        self.provider_fixture()
        self.closed_raw = retained({**self.written, 'status': 'P2_FRONTEND_REPLACEMENT_SESSION_CLOSED',
                                   'operation': 'verify-replacement-closed', 'writtenObservationSha256': migrate.file_hash(self.written_raw),
                                   'originalBackendAbsent': True, 'originalLocksAbsent': True, 'observationLockReleased': True})
        started = json.loads(self.started_raw)
        node_terminal = {key: value for key, value in started.items() if key not in ('status', 'databaseVerified')}
        self.node_raw = (retained({**node_terminal, 'status': 'DATABASE_VERIFIED', 'phase': 'completed', 'readOnlyVerified': False}),
                         retained({**started, 'status': 'FRONTEND_CONTINUATION_COMPLETED'}),
                         retained({**self.base, 'status': terminal.FRONTEND_STATUS,
                                   'deploymentProofSha256': migrate.file_hash(self.provider_raw[0])}))

    def provider_fixture(self):
        self.deployment, self.previous = 'dpl_owned', self.plan['predecessor']['deploymentId']
        self.project_id = vercel.PROJECTS['staging']
        profile = {'version': 2, 'qualificationTargetProfile': parent.PROFILE}
        identity = {**profile, 'environment': 'staging', 'projectId': self.project_id, 'releaseId': self.release_id,
                    'sourceCommit': self.commit, 'deploymentId': self.deployment, 'previousDeploymentId': self.previous}
        feature_controls = self.review['certification']['featureControls']
        writer = {'mode': 'enforce', 'targetSha256': self.target_sha, 'producerSha256': self.producer,
                  'sourceCommit': self.commit, 'roleName': self.runtime['name']}
        self.workload = {**identity, **migrate.contract_identity(self.candidate), 'status': 'FRONTEND_VERIFIED',
                         'phase': 'completed', 'trafficAuthorized': False, 'nativeSchedulerVerified': False,
                         'checks': ['frontend-server-gateway-course-catalog-p2'], 'featureControls': feature_controls,
                         'writerAdmissionBinding': writer}
        self.promotion = {**identity, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed', 'trafficAuthorized': False,
                          'gatewayTrafficAuthorized': False, 'frontendDomainsPromoted': True,
                          'previousAliasRequestedAt': 1, 'aliasRequestedAt': 2}
        definition = {'path': '/api/cron/account-lifecycle', 'schedule': '* * * * *', 'host': 'owned.invalid'}
        self.proof = {**self.base, 'status': terminal.FRONTEND_STATUS, 'projectId': self.project_id, 'deploymentId': self.deployment,
                      'actionId': self.release_id, 'readyState': 'READY', 'aliasJobState': 'succeeded',
                      'aliasDeploymentId': self.deployment, 'aliasJobDeploymentId': self.deployment, 'aliasJobMatchesIntent': True,
                      'aliasJobType': 'promote', 'workloadVerified': True,
                      'workloadReceiptSha256': migrate.file_hash(retained(self.workload)),
                      'configurationRecordSha256': migrate.file_hash(retained(self.workload)),
                      'frontendPromotionReceiptSha256': migrate.file_hash(retained(self.promotion)),
                      'featureControls': feature_controls, 'writerAdmissionBinding': writer,
                      'certificationSchedule': {**definition, 'deploymentId': self.deployment, 'nativeEnabled': False,
                          'definitionsSha256': migrate.file_hash(parent.encoded([definition]))},
                      'admissionNewWork': False, 'admissionRecovery': False}
        self.provider_raw = tuple(retained(value) for value in (self.proof, self.workload, self.promotion))
        self.provider_project = {'targets': {'production': {'id': self.deployment}}, 'lastAliasRequest': {
            'type': 'promote', 'jobStatus': 'succeeded', 'toDeploymentId': self.deployment, 'requestedAt': 2},
            'crons': {'disabledAt': 1, 'deploymentId': self.deployment, 'definitions': [definition]}}

    @contextlib.contextmanager
    def provider_readback(self):
        with (patch.object(vercel, 'release_identity', return_value=('staging', self.project_id, self.commit)),
              patch.object(vercel, 'deployment_state', return_value={'readyState': 'READY', 'url': 'https://owned.invalid'}),
              patch.object(vercel, '_project', return_value=self.provider_project) as project):
            yield project

    def test_provider_pins_original_promotion_api_receipts_and_runtime_role(self):
        with self.provider_readback() as project:
            check = Mock()
            self.assertEqual(terminal.verify_provider(self.provider_raw, self.base, self.candidate, self.plan, self.review,
                                                     self.packet, Mock(), check), self.proof)
            self.assertEqual(check.call_count, 2)
            for field, value in (('migrationOutcomeSha256', '0' * 64),
                                 ('writerAdmissionBinding', {**self.proof['writerAdmissionBinding'], 'roleName': 'wrong_role'}),
                                 ('frontendPromotionReceiptSha256', '0' * 64), ('admissionRecovery', True)):
                with self.subTest(field=field), self.assertRaises(ValueError):
                    terminal.verify_provider((retained({**self.proof, field: value}), *self.provider_raw[1:]),
                                             self.base, self.candidate, self.plan, self.review, self.packet, Mock(), check)
            wrong_predecessor = {**self.plan, 'predecessor': {**self.plan['predecessor'], 'deploymentId': 'dpl_wrong'}}
            with self.assertRaises(ValueError):
                terminal.verify_provider(self.provider_raw, self.base, self.candidate, wrong_predecessor, self.review,
                                         self.packet, Mock(), check)
            self.assertEqual(project.call_count, 1)
            self.provider_project['lastAliasRequest']['requestedAt'] = 3
            with self.assertRaises(ValueError):
                terminal.verify_provider(self.provider_raw, self.base, self.candidate, self.plan, self.review, self.packet, Mock(), check)

    def test_provider_token_requires_paired_review_and_does_not_enable_installed_write_dispatch(self):
        self.assertEqual(parent.reviewed_plan(self.initial, mode=parent.WRITE_MODE), (self.plan_raw, self.plan))
        with self.assertRaises(ValueError):
            parent.reviewed_plan({**self.write_initial, 'vercelToken': self.initial['vercelToken']}, mode=parent.WRITE_MODE)
        with (patch.object(parent.sys, 'argv', ['parent.py', '--supervise-replacement-write']),
              patch.object(parent.os, 'open') as opened, self.assertRaises(ValueError)):
            parent.main()
        opened.assert_not_called()

    def test_independent_api_join_rejects_receipt_or_snapshot_drift(self):
        (self.migration / 'course/database-receipt.json').write_bytes(b'{"changed":true}\n')
        with self.assertRaises(ValueError):
            terminal.read_api(self.initial, self.plan, self.review, self.candidate, self.write_directory, self.packet, self.written_raw)

    def test_exact_terminal_refuses_current_mode_or_unrelated_closed_proof(self):
        joined = terminal.join_terminal(self.base, self.packet, self.provider_raw, self.node_raw, self.closed_raw,
                                        status=terminal.INTENT_STATUS)
        self.assertEqual(joined['migrationMode'], 'apply-forward')
        self.assertEqual(joined['owner'], self.owner)
        for changed in ({'migrationMode': 'verify-current-only'}, {'readOnlyVerified': True}, {'failureCode': 'FAILED'}):
            with self.assertRaises(ValueError):
                terminal.join_terminal(self.base, self.packet, self.provider_raw,
                    (retained({**json.loads(self.node_raw[0]), **changed}), *self.node_raw[1:]),
                    self.closed_raw, status=terminal.INTENT_STATUS)
        with self.assertRaises(ValueError):
            parent.closed_result(self.packet, self.written_raw, retained({**json.loads(self.closed_raw), 'originalLocksAbsent': False}))

    def test_close_preparation_waits_for_worker_tail_before_releasing_observer(self):
        emitted = []
        broker = parent.ReplacementWriteBroker(self.initial, emitted.append, image=self.image, runtime_review=self.review)
        broker.directory, broker.plan = self.write_directory, self.plan
        broker.provider_raw, broker.promoted = self.provider_raw, self.proof
        broker.scope = Mock()
        broker.observer = Mock(stop_event=threading.Event())
        original_observer = broker.observer

        def worker():
            if broker.released.wait(5):
                original_observer.stop_event.set()
                broker.worker_done.set()

        tail = threading.Thread(target=worker)
        tail.start()
        try:
            with (patch.object(broker, 'check'), patch.object(broker, 'verify_replacement_mutation') as live,
                  patch.object(broker, 'readback_replacement_provider', return_value=self.proof)):
                broker.command({'id': 1, 'operation': 'prepare-replacement-close'})
                live.assert_called()
            broker.scope.begin_close.assert_called_once_with()
            self.assertTrue(broker.worker_done.is_set())
            self.assertIsNone(broker.observer)
            self.assertEqual(emitted, [{'id': 1, 'status': 'REPLACEMENT_CLOSE_PREPARED'}])
            self.assertFalse((self.write_directory / terminal.SESSION_CLOSED).exists())
            self.assertFalse((self.write_directory / terminal.TERMINAL).exists())
        finally:
            broker.released.set()
            tail.join(5)

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_guard_terminal_only_after_reap_and_fresh_closed_readback(self):
        lock = self.root / 'owned-lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        initial = {**self.initial, '_guardLockDescriptor': fd}
        child = os.fork()
        if child == 0:
            os._exit(0)
        os.waitpid(child, 0)
        for name, raw in zip((*terminal.PROVIDER_FILES, *terminal.NODE_FILES, terminal.SESSION_CLOSED),
                             (*self.provider_raw, *self.node_raw, self.closed_raw)):
            migrate.write_exact_bytes(self.write_directory, name, raw)
        for name, status in ((parent.CLOSED_OBSERVER_STARTED, 'CLOSED_STARTED'), (parent.CLOSED_OBSERVER_RETURNED, 'CLOSED_RETURNED')):
            migrate.write_json(self.write_directory, name, parent.write_observer_receipt(initial, self.probe, self.raw_observation, status))
        intent = terminal.join_terminal(self.base, self.packet, self.provider_raw, self.node_raw, self.closed_raw,
                                        status=terminal.INTENT_STATUS)
        raw_intent = retained(intent)
        migrate.write_exact_bytes(self.write_directory, terminal.INTENT, raw_intent)
        committed = migrate.file_hash(raw_intent)
        self.assertFalse((self.write_directory / terminal.TERMINAL).exists())

        def independent_readback(value, image, probe, *, closed_packet):
            self.assertEqual((value, image, probe), (initial, self.image, self.probe))
            self.assertEqual(closed_packet, {**self.packet, 'writtenObservation': base64_bytes(self.written_raw)})
            with self.assertRaises(ChildProcessError):
                os.waitpid(child, os.WNOHANG)
            with lock.open() as contender, self.assertRaises(BlockingIOError):
                fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self.closed_raw

        request = {**self.operator_evidence, 'writeIntentSha256': '2' * 64}
        with (patch.object(supervisor, 'LOCK', lock), patch.object(supervisor, '_verify_guard_source'),
              self.provider_readback(), patch.object(terminal, 'verify_runtime'),
              patch.object(parent, 'run_replacement_image', side_effect=independent_readback)):
            self.provider_project['lastAliasRequest']['requestedAt'] = 3
            with self.assertRaises(ValueError):
                parent.finalize_replacement_terminal(initial, self.plan, self.review, self.root, self.write_directory,
                    self.image, self.probe, self.raw_observation, request, committed)
            self.assertFalse((self.write_directory / terminal.TERMINAL).exists())
            self.provider_project['lastAliasRequest']['requestedAt'] = 2
            parent.finalize_replacement_terminal(initial, self.plan, self.review, self.root, self.write_directory,
                self.image, self.probe, self.raw_observation, request, committed)
        result = json.loads((self.write_directory / terminal.TERMINAL).read_bytes())
        self.assertEqual(result, {**intent, 'status': terminal.TERMINAL_STATUS})
        self.assertEqual((self.write_directory / terminal.INTENT).read_bytes(), raw_intent)

    @unittest.skipUnless(sys.platform == 'linux', 'owned Linux pipe fixture')
    def test_guard_refuses_commit_before_independent_closed_stage(self):
        def done(_value):
            result = Future()
            result.set_result(None)
            return result

        for closed in (False, True):
            safety_read, safety_write = os.pipe()
            health_read, health_write = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(safety_read)
                os.close(health_write)
                frames = [{'operation': 'armed', 'probe': {}},
                          {'operation': 'replacement-write', 'armReceiptSha256': '1' * 64, 'emptyCatalogReceipt': {}},
                          {'operation': 'replacement-written', **dict.fromkeys(parent.WRITTEN_REQUEST_FIELDS, 'owned')},
                          {'operation': 'replacement-runtime', 'postflightSha256': '2' * 64}]
                if closed:
                    frames.append({'operation': 'replacement-closed', 'providerProofSha256': '3' * 64})
                frames.append({'operation': 'committed', 'sha256': '4' * 64})
                os.write(safety_write, b''.join(parent.encoded(value) + b'\n' for value in frames))
                os._exit(0)
            os.close(safety_write)
            os.close(health_read)
            try:
                args = {'profiled_certification': True, 'async_arm': True, 'authorize_replacement_write': done,
                        'verify_replacement_written': done, 'start_replacement_runtime': done, 'verify_replacement_closed': done}
                if closed:
                    self.assertEqual(supervisor.watch_broker(child, safety_read, health_write, done, **args), '4' * 64)
                else:
                    with self.assertRaisesRegex(ValueError, 'WRITE_TERMINAL_REFUSED'):
                        supervisor.watch_broker(child, safety_read, health_write, done, **args)
            finally:
                os.close(safety_read)
                os.close(health_write)
                with contextlib.suppress(ChildProcessError):
                    os.waitpid(child, 0)


if __name__ == '__main__':
    unittest.main()
