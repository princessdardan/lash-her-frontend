"""Current-parent protocol projections plus real owned TLS and POSIX checks.

Protocol models do not qualify Docker, installed-root dispatch, PostgreSQL or
live providers. The HTTPS fixture trusts only its owned loopback certificate.
"""
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import frontend_probe
import frontend_probe_test
import migrate
import p2_prior_gateway
import p2_release_broker
import p2_profiled_current_parent as parent
import staging_state
import vercel
from p2_profiled_current_scope import PROFILE, COMMON
from p2_profiled_current_scope_test import fixture


def packet(value):
    return base64.b64encode(parent.encoded(value) + b'\n').decode()


class FrontendBindingPreflightTests(unittest.TestCase):
    def test_release_requires_unique_staging_target_names_and_retains_no_values(self):
        broker = object.__new__(parent.P2ProfiledCurrentBroker)
        broker.selected = {}
        broker.check = lambda: None
        broker.record_base = lambda status: {'status': status}
        calls, retained = [], []
        broker.retain = lambda name, raw: retained.append((name, json.loads(raw)))
        keys = parent.FRONTEND_PROVIDER_BINDINGS
        rows = [{'key': key, 'target': ['production'], 'value': 'private-canary'} for key in sorted(keys)]

        def request(method, path):
            calls.append((method, path))
            return {'envs': rows}

        broker.vercel = SimpleNamespace(request=request)
        with patch.object(vercel, 'release_identity', return_value=('staging', 'prj_owned', 'a' * 40)) as identity:
            broker.preflight_frontend_bindings()
            identity.assert_called_once_with(broker.selected, expected_profile=PROFILE)
            self.assertEqual(calls, [('GET', '/v10/projects/prj_owned/env?decrypt=false')])
            name, receipt = retained.pop()
            self.assertEqual(name, 'frontend-binding-preflight.json')
            self.assertEqual(set(receipt['names']), keys)
            self.assertFalse(receipt['valuesVerified'])
            self.assertNotIn('private-canary', json.dumps(receipt))
            origin_index = next(index for index, row in enumerate(rows) if row['key'] == 'AUTH_URL')
            origin = rows[origin_index]
            rows[origin_index] = {**origin, 'key': 'NEXTAUTH_URL'}
            with self.assertRaisesRegex(ValueError, 'FRONTEND_BINDINGS_REQUIRED'):
                broker.preflight_frontend_bindings()
            rows[origin_index] = origin
            first = rows[0]
            rows[0] = {**first, 'target': ['preview']}
            with self.assertRaisesRegex(ValueError, 'FRONTEND_BINDINGS_REQUIRED'):
                broker.preflight_frontend_bindings()
            rows[0] = first
            rows.append(dict(first))
            with self.assertRaisesRegex(ValueError, 'FRONTEND_BINDINGS_REQUIRED'):
                broker.preflight_frontend_bindings()
            self.assertFalse(retained)

    def test_recovery_does_not_require_preexisting_frontend_provider_configuration(self):
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker
        object.__new__(P2ProfiledCurrentRecoveryBroker).preflight_frontend_bindings()


class FixedEntryTests(unittest.TestCase):
    def test_isolated_main_uses_canonical_class_objects_before_platform_refusal(self):
        # Record the actual first failed demand, without overriding any guard.
        # The production environment deliberately stops before host/Docker I/O.
        program = r'''
import pathlib, runpy, sys
entry = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(entry.parent))
import p2_release_supervisor as supervisor
original = supervisor.require
def recorded(condition, code):
    if not condition:
        print(code, file=sys.stderr)
    return original(condition, code)
supervisor.require = recorded
runpy.run_path(str(entry), run_name='__main__')
'''
        entry = Path(parent.__file__).resolve()
        initial = {'version': 2, 'qualificationTargetProfile': PROFILE, 'mode': parent.P2ProfiledCurrentBroker.MODE,
            'environment': 'production', 'candidate': {'releaseId': 'owned-current'}}
        actual = subprocess.run([sys.executable, '-I', '-c', program, str(entry)],
            input=parent.encoded(initial) + b'\n', capture_output=True, timeout=5)
        self.assertEqual(actual.returncode, 1)
        self.assertEqual(actual.stdout, b'')
        self.assertEqual(actual.stderr.splitlines(), [b'P2_LINUX_ROOT_GUARD_REQUIRED',
            b'P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW'])


class FixedPhysicalObserverTests(unittest.TestCase):
    def test_fixed_close_and_fence_distinguish_backend_locks_epoch_and_unknown_work(self):
        # Only the Docker subprocess is projected. Exercise the real request,
        # source pin, cleanup and response validator without a Docker daemon.
        release, jobs, receipt = fixture()
        release['artifacts'] = {'frontendMigration': {'image': 'owned@sha256:' + 'a' * 64}}
        job = jobs['frontend']['job']
        request = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'operation': 'verify-schema',
            'marker': '4' * 64, 'backendPid': 12345, 'backendStart': '2026-11-06 01:02:03+00', 'job': job,
            'receipt': receipt, 'baseline': {'catalog': {}}, 'targetSha256': '1' * 64,
            'owner': {'name': 'owned_owner', 'oid': '123'}}
        base = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'environment': 'staging',
                'releaseId': release['releaseId'], 'sourceCommit': job['sourceCommit'], 'targetSha256': request['targetSha256']}
        closed = {**base, 'status': 'P2_PROFILED_CURRENT_SESSION_CLOSED', 'originalBackendPid': request['backendPid'],
            'originalBackendStart': request['backendStart'], 'backendAbsent': True, 'migrationLockReleased': True,
            'nonceLockReleased': True, 'admission': {'epoch': '42', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}
        fence = {**base, 'status': 'P2_PROFILED_CURRENT_ADMISSION_CLOSED'}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            program = root / 'fixed.mjs'
            program.write_bytes(b'// owned projection\n')
            observer = parent.P2ProfiledCurrentPhysicalObserver(release, request, root, 'owned-projection',
                program=program, program_sha256=parent.sha(program.read_bytes()))
            observer.expected_epoch = '42'

            def observe(operation, result):
                calls = []
                def docker(argv, **options):
                    calls.append(argv)
                    if argv[1] == 'run':
                        self.assertEqual(json.loads(options['input']), {**request, 'operation': operation})
                        self.assertIn(f'type=bind,src={program},dst=/app/{parent.PROGRAM},readonly', argv)
                        self.assertEqual(argv[-2:], [release['artifacts']['frontendMigration']['image'], parent.PROGRAM])
                        self.assertIn('--read-only', argv)
                        return SimpleNamespace(stdout=parent.encoded(result))
                    self.assertEqual(argv, ['docker', 'rm', '--force', calls[0][4]])
                    self.assertNotIn('FRONTEND_STAGING_MIGRATION_DATABASE_URL', options['env'])
                    return SimpleNamespace(returncode=0)
                with patch.object(parent.subprocess, 'run', docker), patch.object(parent.runtime, 'command', return_value='') as remaining:
                    try:
                        return observer.probe(operation)
                    finally:
                        self.assertEqual(len(calls), 2)
                        self.assertRegex(calls[0][4], r'^lash-p2-profiled-current-observer-[a-f0-9]{32}$')
                        self.assertIn('name=^/' + calls[0][4] + '$', remaining.call_args.args[0])

            self.assertEqual(observe('verify-closed', closed), closed)
            self.assertEqual(observe('fence', fence), fence)
            mutations = (
                ('backendAbsent', False), ('migrationLockReleased', False), ('nonceLockReleased', False),
                ('originalBackendPid', 12346), ('originalBackendStart', 'different'), ('version', True),
                ('qualificationTargetProfile', {'id': 'unregistered', 'sha256': 'f' * 64}),
                ('admission', {**closed['admission'], 'epoch': '43'}),
                ('admission', {**closed['admission'], 'newWork': True}),
                ('admission', {**closed['admission'], 'active': False}),
                ('admission', {**closed['admission'], 'uncertain': 1}),
            )
            for key, value in mutations:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    observe('verify-closed', {**closed, key: value})
            with self.assertRaises(ValueError):
                observe('fence', {**fence, 'admission': closed['admission']})


class ParentProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / 'actual-host.lock'
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.health_read, self.health_write = os.pipe()
        self.safety_read, self.safety_write = os.pipe()
        os.write(self.health_write, b'H')
        self.events, self.messages = [], []
        release, jobs, receipt = fixture()
        release.update(sources={'frontend': {'commit': 'a' * 40}},
                       phase2ContractManifestSha256=jobs['frontend']['job']['phase2ContractManifestSha256'],
                       workload={'projectId': 'prj_owned'})
        initial = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'mode': parent.P2ProfiledCurrentBroker.MODE,
            'candidate': release, 'candidateSha256': 'd' * 64, 'configurationSha256': {'owned': 'e' * 64},
            'sourceCommit': 'a' * 40, 'sourceSha256': {parent.PROGRAM: 'f' * 64}, 'targetSha256': '1' * 64,
            'inventory': {'expectedEpoch': '1'},
            'inventorySha256': '2' * 64, 'owner': {'name': 'owned_owner', 'oid': '123'},
            'confirmation': 'staging/owned-current',
            'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-never-connected'},
            'certification': {'featureControls': {name: False for name in frontend_probe.FEATURE_CONTROL_NAMES}},
            'expectedWriterAdmissionBinding': {'mode': 'enforce', 'targetSha256': '1' * 64,
                'producerSha256': '3' * 64, 'sourceCommit': 'a' * 40, 'roleName': 'owned_runtime'}}
        self.broker = parent.P2ProfiledCurrentBroker(initial, self.messages.append, shared_lock_fd=self.fd,
            safety_write=self.safety_write, guard_read=self.health_read)
        b = self.broker
        b.selected, b.jobs, b.source, b.configuration, b.directory = release, jobs, self.root, self.root, self.root
        b.bundle = b.results = self.root
        b.prior_gateway = None
        b.lock_fd, b.lock_info = self.fd, os.fstat(self.fd)
        b.observer_program = self.root / 'fixed-probe.mjs'
        b.observer_program.write_text('// owned projection\n')
        b.jobs['frontend']['schema'] = json.dumps({'catalog': {'owned': True}})
        self.receipt = receipt
        self.started = {key: copy.deepcopy(value) for key, value in receipt.items()
            if key not in ('before', 'after', 'applied', 'schemaVerified', 'runtimeRoleVerified', 'readOnlyVerified')}
        self.started.update(status='FRONTEND_CONTINUATION_STARTED', databaseVerified=True)
        self.probe = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'operation': 'verify-schema',
            'marker': '4' * 64, 'backendPid': 12345, 'backendStart': '2026-11-06 01:02:03+00',
            'job': jobs['frontend']['job'], 'receipt': receipt, 'baseline': {'catalog': {'owned': True}},
            'targetSha256': '1' * 64, 'owner': initial['owner']}
        # Project only the Linux root UID check in the inherited broker. The
        # descriptor, pathname inode, owner in the scope, and flock are real.
        class OwnedBrokerOs:
            def __getattr__(self, name):
                return getattr(os, name)

            def lstat(self, path):
                actual = os.lstat(path)
                return SimpleNamespace(st_uid=0, st_mode=actual.st_mode,
                                       st_ino=actual.st_ino, st_dev=actual.st_dev)
        self.patches = [patch.object(parent, 'LOCK', self.path), patch.object(p2_release_broker, 'LOCK', self.path),
            patch.object(p2_release_broker, 'os', OwnedBrokerOs()),
            patch.object(p2_release_broker, 'verify_profiled_current_source_closure', return_value='owned-source-projection'),
            patch.object(staging_state, 'configuration_hashes', return_value=initial['configurationSha256']),
            patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'start', lambda observer, failed: self.observer_start(observer, failed)),
            patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'probe', lambda _, operation: self.observer_probe(operation)),
            patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'stop', lambda _: self.observer_stop()),
            patch.object(p2_prior_gateway, 'prepare_prior_gateway', self.prior),
            patch.object(parent.runtime, 'execute', self.runtime),
            patch.object(parent.P2ProfiledCurrentBroker, '_frontend_readback', lambda *_: self.events.append('frontend-readback')),
            patch.object(parent.P2ProfiledCurrentBroker, '_runtime_readback', lambda *_: self.events.append('runtime-readback'))]
        for item in self.patches:
            item.start()

    def tearDown(self):
        self.broker.runtime_released.set()
        if self.broker.worker:
            self.broker.worker.join(3)
        if self.broker.scope:
            self.broker.scope.revoke()
        for item in reversed(self.patches):
            item.stop()
        for fd in (self.fd, self.health_read, self.health_write, self.safety_read, self.safety_write):
            if fd is not None:
                os.close(fd)
        self.temporary.cleanup()

    def observer_start(self, observer, failed):
        self.events.append('observer-start')
        observer.last_verified = time.monotonic()

    def observer_stop(self):
        self.events.append('observer-stop')

    def observer_probe(self, operation):
        self.events.append(operation)
        return {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE),
            'status': 'P2_PROFILED_CURRENT_SESSION_CLOSED', 'environment': 'staging', 'releaseId': 'owned-current',
            'sourceCommit': 'a' * 40, 'targetSha256': '1' * 64, 'originalBackendPid': 12345,
            'originalBackendStart': self.probe['backendStart'], 'backendAbsent': True,
            'migrationLockReleased': True, 'nonceLockReleased': True,
            'admission': {'epoch': '1', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}

    def prior(self, initial, selected, directory, verify, *, expected_profile):
        self.events.append('prior-mutation')
        self.assertEqual(expected_profile, PROFILE)
        boundary = object.__new__(p2_prior_gateway.PriorGatewayBoundary)
        boundary.selected, boundary.initial = selected, initial
        boundary.verify = lambda: None
        return boundary

    def runtime(self, *args, **kwargs):
        self.events.append('runtime-start')
        scope = kwargs['_profiled_current_scope']
        self.assertEqual(kwargs['expected_profile'], PROFILE)
        scope.require_frontend(self.broker.selected, self.broker.jobs['frontend'])
        raw, started = scope.frontend_current_receipt_bytes()
        self.assertEqual(raw, base64.b64decode(packet(self.receipt)))
        self.assertEqual(started, base64.b64decode(packet(self.started)))
        migration = self.broker.record_base('API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN')
        migration['databaseReceiptSha256'] = {'frontend': parent.sha(raw)}
        migrate.write_json(self.root, 'migration-outcome.json', migration)
        outcome = self.broker.record_base('API_RUNTIME_READY')
        outcome['containers'] = []
        outcome['migrationOutcomeSha256'] = parent.sha(migrate.read_input(self.root, 'migration-outcome.json'))
        migrate.write_json(self.root, 'runtime-outcome.json', outcome)
        scope.runtime_ready(self.root, self.root, self.root, self.broker.selected, outcome)
        self.events.append('runtime-tail')
        return outcome

    def arm(self):
        self.broker.command({'id': 1, 'operation': 'profiled-current-arm', 'receipt': packet(self.receipt),
                             'continuationStarted': packet(self.started), 'probe': self.probe})

    def ready(self):
        self.arm()
        self.broker.command({'id': 2, 'operation': 'profiled-current-prepare-prior-gateway'})
        deadline = time.monotonic() + 2
        while not any(row['status'] == 'PROFILED_CURRENT_API_READY' for row in self.messages) and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIsNotNone(self.broker.ready)

    def test_observer_arms_before_any_prior_mutation_then_same_id_ready(self):
        self.ready()
        self.assertLess(self.events.index('observer-start'), self.events.index('prior-mutation'))
        self.assertLess(self.events.index('prior-mutation'), self.events.index('runtime-start'))
        self.assertEqual([(row['id'], row['status']) for row in self.messages],
            [(1, 'PROFILED_CURRENT_ARMED'), (2, 'PROFILED_CURRENT_PRIOR_GATEWAY_PREPARED'), (1, 'PROFILED_CURRENT_API_READY')])
        for key, filename in (('runtimeOutcome', 'runtime-outcome.json'), ('migrationOutcome', 'migration-outcome.json')):
            self.assertEqual(base64.b64decode(self.messages[2][key]), (self.root / filename).read_bytes())
        self.assertFalse((self.root / 'frontend-job-outcome.json').exists())
        self.assertFalse((self.root / self.broker.terminal_filename()).exists())

    def test_missing_or_tampered_current_proof_refuses_before_runtime_and_prior_mutation(self):
        self.receipt['readOnlyVerified'] = False
        self.probe['receipt'] = self.receipt
        with self.assertRaisesRegex(ValueError, 'FRONTEND_RECEIPT_REQUIRED'):
            self.arm()
        self.assertNotIn('prior-mutation', self.events)
        self.assertNotIn('runtime-start', self.events)
        self.assertNotIn('observer-start', self.events)

    def test_actual_observer_refusal_does_not_arm_containment_or_prior_gateway(self):
        with patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'start', side_effect=ValueError('OWNED_LIVE_BACKEND_MISMATCH')):
            with self.assertRaisesRegex(ValueError, 'OWNED_LIVE_BACKEND_MISMATCH'):
                self.arm()
        self.assertIsNone(self.broker.armed_probe)
        self.assertIsNone(self.broker.observer)
        self.assertIsNone(self.broker.worker)
        os.set_blocking(self.safety_read, False)
        with self.assertRaises(BlockingIOError):
            os.read(self.safety_read, 8192)

    def test_original_raw_api_job_pins_refuse_semantically_equal_byte_drift_before_prior_effect(self):
        jobs = self.root / 'jobs'
        jobs.mkdir()
        original = {name: parent.encoded({'service': name, 'approvedPendingTags': []}) for name in ('course', 'community')}
        for name, raw in original.items():
            (jobs / (name + '.json')).write_bytes(raw)
        self.broker.api_job_sha256 = {name: parent.sha(raw) for name, raw in original.items()}
        self.broker.verify_api_job_inputs()
        self.arm()
        (jobs / 'community.json').write_bytes(original['community'] + b'\n')
        with self.assertRaisesRegex(ValueError, 'API_JOB_BYTES_CHANGED'):
            self.broker.command({'id': 2, 'operation': 'profiled-current-prepare-prior-gateway'})
        self.assertNotIn('prior-mutation', self.events)
        self.assertIsNone(self.broker.worker)
        (jobs / 'community.json').write_bytes(original['community'])
        self.broker.verify_api_job_inputs()

    def test_unknown_operations_early_prepare_and_early_terminal_are_not_authority(self):
        for operation in ('start-api', 'roles-prepared', 'prepare-prior-gateway', 'profiled-current-prepare-prior-gateway',
                          'profiled-current-finish'):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                self.broker.command({'id': 1, 'operation': operation})
        self.assertEqual(self.events, [])

    def test_runtime_tail_precedes_close_only_and_actual_late_terminal_join(self):
        self.ready()
        base = self.broker.record_base('P2_PROFILED_CURRENT_FRONTEND_VERIFIED')
        base.pop('inventorySha256')
        workload = {key: base[key] for key in ('version', 'qualificationTargetProfile', 'environment',
            'sourceCommit', 'releaseId', 'contractPhase', 'phase2ContractManifestSha256', 'trafficAuthorized')}
        workload.update(projectId='prj_owned', deploymentId='dpl_owned', previousDeploymentId='dpl_previous',
            status='FRONTEND_VERIFIED', phase='completed', nativeSchedulerVerified=False,
            checks=['frontend-server-gateway-course-catalog-p2'], featureControls=self.broker.initial['certification']['featureControls'],
            writerAdmissionBinding=self.broker.initial['expectedWriterAdmissionBinding'])
        raw = base64.b64decode(packet(workload))
        proof = {**base, 'actionId': 'owned-current', 'projectId': 'prj_owned', 'deploymentId': 'dpl_owned', 'readyState': 'READY',
            'aliasJobState': 'succeeded', 'aliasDeploymentId': 'dpl_owned', 'aliasJobDeploymentId': 'dpl_owned',
            'aliasJobMatchesIntent': True, 'aliasJobType': 'promote', 'workloadVerified': True,
            'workloadReceiptSha256': parent.sha(raw), 'configurationRecordSha256': parent.sha(raw),
            'featureControls': workload['featureControls'], 'writerAdmissionBinding': workload['writerAdmissionBinding'],
            'certificationSchedule': {'path': '/api/cron/account-lifecycle', 'schedule': '* * * * *', 'host': 'owned.example.invalid',
                'deploymentId': 'dpl_owned', 'nativeEnabled': False, 'definitionsSha256': '6' * 64},
            'admissionNewWork': False, 'admissionRecovery': False, 'evidenceSha256': '7' * 64}
        event = {'id': 7, 'operation': 'profiled-current-frontend-verified', 'proof': proof, 'workload': packet(workload)}
        for change in ({'aliasJobDeploymentId': 'dpl_foreign'}, {'writerAdmissionBinding': {}}, {'workloadReceiptSha256': '0' * 64},
                       {'configurationRecordSha256': '0' * 64}, {'trafficAuthorized': True}, {'unknown': False}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'WORKLOAD_REQUIRED'):
                self.broker.command({**event, 'proof': {**proof, **change}})
        self.assertIsNone(self.broker.promoted)
        self.broker.command(event)
        self.assertEqual(migrate.read_input(self.root, 'frontend-workload-outcome.json'), raw)
        completed = {**self.started, 'status': 'FRONTEND_CONTINUATION_COMPLETED'}
        terminal = {key: value for key, value in self.started.items() if key != 'databaseVerified'}
        terminal.update(status='DATABASE_VERIFIED', phase='completed', readOnlyVerified=True)
        outcome = {**self.broker.record_base('P2_PROFILED_CURRENT_FRONTEND_VERIFIED'),
                   'deploymentProofSha256': parent.sha(parent.encoded(self.broker.promoted))}
        finish = {'id': 5, 'operation': 'profiled-current-finish', 'terminal': packet(terminal),
            'continuationCompleted': packet(completed), 'releaseOutcome': packet(outcome)}
        with self.assertRaisesRegex(ValueError, 'SESSION_CLOSURE_REQUIRED'):
            self.broker.command(finish)
        self.broker.command({'id': 3, 'operation': 'profiled-current-prepare-close'})
        self.assertLess(self.events.index('runtime-tail'), self.events.index('observer-stop'))
        self.assertIsNotNone(self.broker.scope.close_deadline)
        with self.assertRaisesRegex(ValueError, 'CLOSE_ONLY'):
            self.broker.scope.verify()
        self.assertFalse((self.root / 'frontend-job-outcome.json').exists())
        self.broker.command({'id': 4, 'operation': 'profiled-current-session-closed'})
        self.broker.command(finish)
        self.assertFalse((self.root / self.broker.terminal_filename()).exists())
        self.broker.command({'id': 6, 'operation': 'commit'})
        actual = migrate.read_json(self.root, self.broker.terminal_filename())
        self.assertEqual(actual['status'], 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION')
        self.assertTrue(all(actual[key] is False for key in parent.FALSE_FIELDS))
        self.assertTrue((self.root / 'frontend-job-outcome.json').is_file())

    def test_guard_process_death_during_runtime_reaps_registered_child_under_flock(self):
        self.ready()
        guard = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(60)'],
                                 pass_fds=(self.fd, self.health_write, self.safety_read))
        os.close(self.health_write); self.health_write = None
        os.close(self.safety_read); self.safety_read = None
        failures = []
        def child():
            try:
                self.broker.scope.run([sys.executable, '-I', '-c', 'import time;time.sleep(60)'], timeout=70)
            except BaseException as error:
                failures.append(type(error).__name__)
        thread = threading.Thread(target=child)
        thread.start()
        try:
            deadline = time.monotonic() + 2
            while not self.broker.scope.processes and time.monotonic() < deadline:
                time.sleep(0.01)
            children = list(self.broker.scope.processes)
            self.assertEqual(len(children), 1)
            guard.kill(); guard.wait(timeout=3)
            def stopped(*_):
                self.assertTrue(all(item.poll() is not None for item in children))
                self.events.append('runtime-containment-projection')
            with patch.object(p2_prior_gateway, 'capture_before_stop', side_effect=ValueError('OWNED_GATEWAY_UNKNOWN')) as capture, \
                    patch.object(migrate, 'suspend_runtime', side_effect=stopped), \
                    patch.object(p2_release_broker.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                    patch.object(parent.runtime, 'command', return_value=''):
                with self.assertRaisesRegex(ValueError, 'GUARD_DIED|BROKER_FAILED'):
                    self.broker.command({'id': 3, 'operation': 'profiled-current-prepare-close'})
                self.broker.abort()
                self.assertTrue(self.broker.worker_done.wait(3))
                self.broker.abort()
                capture.assert_called_once()
                self.assertEqual(capture.call_args.kwargs.get('expected_profile'), PROFILE)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertTrue(failures)
            self.assertTrue(all(item.poll() is not None for item in children))
            self.assertTrue(self.broker.scope.revoked.is_set())
            self.assertIn('runtime-containment-projection', self.events)
            self.assertFalse((self.root / self.broker.terminal_filename()).exists())
            rival = os.open(self.path, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(rival, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(rival)
        finally:
            if guard.poll() is None:
                guard.kill(); guard.wait(timeout=3)

    def test_guard_death_after_delegation_allows_one_fixed_fallback_only(self):
        self.arm()
        with patch.object(p2_release_broker.Broker, 'contain_failure_without_guard') as fallback:
            self.broker.abort()
            self.assertTrue(self.broker.failed.is_set())
            self.assertIn(b'"operation":"abort"', os.read(self.safety_read, 8192))
            fallback.assert_not_called()
            self.broker.guard_alive = False
            self.broker.abort()
            self.broker.abort()
            fallback.assert_called_once_with()
            self.assertTrue(self.broker.outcome['workerProcessesQuiesced'])

    def test_guard_dead_unarmed_scope_cannot_stop_runtime(self):
        with patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'start', side_effect=ValueError('OWNED_NO_PHYSICAL_PROOF')):
            with self.assertRaisesRegex(ValueError, 'OWNED_NO_PHYSICAL_PROOF'):
                self.arm()
        self.broker.guard_alive = False
        with patch.object(p2_prior_gateway, 'capture_before_stop') as capture, \
                patch.object(migrate, 'suspend_runtime') as stop, patch.object(parent.runtime, 'command', return_value=''):
            self.broker.abort()
            capture.assert_not_called()
            stop.assert_not_called()
        self.assertIsNone(self.broker.observer)
        self.assertIsNone(self.broker.armed_probe)
        self.assertFalse((self.root / self.broker.terminal_filename()).exists())

    def test_observer_abort_can_finish_while_a_survivor_waits_outside_cleanup_lock(self):
        self.arm()
        self.broker.guard_alive = False
        observer = self.broker.observer
        signal_failure = threading.Event()
        def observer_failure():
            if signal_failure.wait(3):
                self.broker.abort()
        def stop(value):
            signal_failure.set()
            return p2_release_broker.PhysicalObserver.stop(value)
        observer.thread = threading.Thread(target=observer_failure, daemon=True)
        observer.thread.start()
        survivor = threading.Thread(target=self.broker.abort, daemon=True)
        with patch.object(p2_release_broker.Broker, 'contain_failure_without_guard', return_value=True) as fallback, \
                patch.object(parent.P2ProfiledCurrentPhysicalObserver, 'stop', stop):
            survivor.start()
            survivor.join(3)
            self.assertFalse(survivor.is_alive())
            self.assertFalse(observer.thread.is_alive())
            fallback.assert_called_once_with()

    def test_concurrent_close_retains_actual_flock_until_registered_child_reaps(self):
        self.arm()
        child = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(60)'])
        with self.broker.scope.mutations:
            self.broker.scope.processes.add(child)
        self.broker.guard_alive = False
        attempted = threading.Event()
        errors = []
        def closed():
            try:
                self.broker.close()
            except BaseException as error:
                errors.append(error)
        def reap_unknown():
            attempted.set()
            raise TimeoutError('owned wait failure')
        def fixed_fallback():
            self.assertIsNotNone(child.poll())
            self.assertIsNotNone(self.broker.lock_fd)
        thread = threading.Thread(target=closed)
        try:
            # Keep a real process alive while modeling only the failed reap;
            # actual child exit and wait allow exactly one source fallback.
            with patch.object(self.broker.scope, 'revoke', side_effect=reap_unknown), \
                    patch.object(p2_release_broker.Broker, 'contain_failure_without_guard', side_effect=fixed_fallback) as fallback:
                thread.start()
                self.assertTrue(attempted.wait(3))
                self.broker.abort()
                self.assertTrue(thread.is_alive())
                fallback.assert_not_called()
                contender = os.open(self.path, os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    child.kill(); child.wait(timeout=3)
                    thread.join(3)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(errors, [])
                    fallback.assert_called_once_with()
                    self.assertIsNone(self.broker.lock_fd)
                    self.fd = None
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(contender)
        finally:
            if child.poll() is None:
                child.kill(); child.wait(timeout=3)
            if thread.is_alive():
                thread.join(3)

    def test_retained_original_byte_tamper_and_duplicate_prior_stage_refuse(self):
        self.ready()
        with self.assertRaisesRegex(ValueError, 'ALREADY_PREPARED'):
            self.broker.command({'id': 3, 'operation': 'profiled-current-prepare-prior-gateway'})
        path = self.root / 'frontend-original-database-receipt.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'RETAINED_BYTES_CHANGED'):
            self.broker.command({'id': 4, 'operation': 'check'})

    def test_duplicate_or_mixed_profile_raw_and_early_terminal_fields_refuse(self):
        for raw in [b'{"version":2,"version":2}', parent.encoded({**self.receipt, 'version': 1}),
                    parent.encoded({**self.receipt, 'qualificationTargetProfile': {**PROFILE, 'sha256': 'f' * 64}})]:
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                parent.decode_profiled(base64.b64encode(raw).decode())
        with self.assertRaisesRegex(ValueError, 'PROTOCOL_REFUSED'):
            self.broker.command({'id': 1, 'operation': 'profiled-current-arm', 'receipt': packet(self.receipt),
                'continuationStarted': packet(self.started), 'probe': self.probe, 'terminal': packet(self.receipt)})
        self.assertEqual(self.events, [])


def profiled_release(release):
    value = copy.deepcopy(release)
    value.update(version=3, qualificationTargetProfile=copy.deepcopy(PROFILE))
    for key in ('sourceApproval', 'integration', 'approval'):
        value[key] = {'qualificationTargetProfile': copy.deepcopy(PROFILE)}
    value['workload']['qualificationTargetProfile'] = copy.deepcopy(PROFILE)
    for service in ('frontend', 'course', 'community'):
        value['sources'].setdefault(service, {})['qualificationTargetProfile'] = copy.deepcopy(PROFILE)
    return value


class ProfiledProviderTlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frontend_probe_test.FrontendProbeTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        frontend_probe_test.FrontendProbeTests.tearDownClass()

    def setUp(self):
        self.owner = frontend_probe_test.FrontendProbeTests(methodName='runTest')
        self.owner.setUp()
        self.owner.release = profiled_release(self.owner.release)
        self.owner.release.update(contractPhase='p2', phase2ContractManifestSha256='sha256:' + 'd' * 64)

    def tearDown(self):
        self.owner.tearDown()

    def test_actual_owned_https_build_and_private_workload_propagate_exact_profile(self):
        f, service = self.owner.fixture, self.owner
        f.enqueue(f.project(), {'id': 'dpl_fixture'}, f.deployment(), f.project())
        build = vercel.stage_frontend(service.client, service.release, f.attempt, expected_profile=PROFILE)
        self.assertEqual(build['version'], 2)
        self.assertEqual(build['qualificationTargetProfile'], PROFILE)
        service.prepared_responses()
        frontend_probe.prepare(service.client, service.release, service.private, f.attempt,
                               'gateway.example.invalid', expected_profile=PROFILE)
        service.probe_body = {'checks': ['gateway-course-catalog-p2'], 'contractPhase': 'p2',
            'featureControls': {key: False for key in frontend_probe.FEATURE_CONTROL_NAMES},
            'writerAdmissionBinding': service.writer_binding()}
        f.enqueue(f.deployment(), service.project())
        result = frontend_probe.verify(service.client, service.release, f.attempt, service.private,
            service.mapped_http(), service.probe_body['featureControls'], service.writer_binding(), expected_profile=PROFILE)
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['qualificationTargetProfile'], PROFILE)
        self.assertEqual(result['status'], 'FRONTEND_VERIFIED')
        self.assertFalse(result['trafficAuthorized'])
        private = migrate.read_json(service.private, frontend_probe.PRIVATE_FILE)
        self.assertEqual(private['qualificationTargetProfile'], PROFILE)
        self.assertEqual(sum(row['method'] == 'POST' and row['path'].startswith('/v13/deployments') for row in f.calls), 1)
        common = ''.join(path.read_text() for path in f.attempt.glob('*.json'))
        for secret in ('fixture-private-token', 'fixture-protection-bypass', private['secret']):
            self.assertNotIn(secret, common)

    def test_profile_cannot_be_selected_from_carrier_or_cross_environment(self):
        service = self.owner
        with self.assertRaises(ValueError):
            vercel.stage_frontend(service.client, service.release, service.fixture.attempt)
        changed = copy.deepcopy(service.release)
        changed['environment'] = 'production'
        with self.assertRaises(ValueError):
            vercel.stage_frontend(service.client, changed, service.fixture.attempt, expected_profile=PROFILE)
        self.assertEqual(service.fixture.calls, [])

    def test_mixed_staged_receipt_refuses_before_provider_and_private_input(self):
        service = self.owner
        attempt = service.attempt()
        with self.assertRaises(ValueError):
            frontend_probe.verify(service.client, service.release, attempt, service.private,
                expected_profile=PROFILE)
        self.assertEqual(service.fixture.calls, [])
        self.assertEqual(list(service.private.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
