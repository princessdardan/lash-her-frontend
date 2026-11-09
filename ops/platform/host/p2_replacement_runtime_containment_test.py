import fcntl
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import migrate
import p2_frontend_replacement_parent as replacement
import p2_replacement_runtime_containment as containment
import p2_release_supervisor as supervisor
import release
import staging_state


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
class ReplacementRuntimeContainmentTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.lock = self.root / 'actual-host.lock'
        self.fd = os.open(self.lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, self.fd)
        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.release_id = 'owned-replacement'
        self.directory = self.root / ('p2-profiled-replacement-write-' + self.release_id)
        self.attempt = self.root / ('runtime-profiled-frontend-replacement-' + self.release_id)
        self.snapshot = self.attempt / 'configuration'
        self.directory.mkdir(mode=0o700)
        self.config_source = self.root / 'reviewed-configuration'
        self.config_source.mkdir(mode=0o700)
        self.compose = b'owned-exact-compose\n'
        self.selected = {'qualificationTargetProfile': replacement.PROFILE, 'environment': 'staging',
                         'releaseId': self.release_id, 'sources': {'frontend': {'commit': 'a' * 40}},
                         'runtime': {'composeSha256': 'sha256:' + migrate.file_hash(self.compose)},
                         'artifacts': {key: {'image': f'owned.invalid/{key}@sha256:{digit * 64}'}
                                       for key, digit in zip(set(release.IMAGE_KEYS.values()), '123')}}
        self.candidate_raw = (json.dumps(self.selected, indent=2) + '\n').encode()
        candidate_sha = migrate.file_hash(self.candidate_raw)
        self.initial = {'mode': replacement.WRITE_MODE, 'qualificationTargetProfile': replacement.PROFILE,
                        'environment': 'staging', 'sourceCommit': 'a' * 40, 'candidateSha256': candidate_sha,
                        'reviewedPlanSha256': 'e' * 64, 'runtimeReviewSha256': 'f' * 64,
                        'results': str(self.root), '_guardLockDescriptor': self.fd}
        self.plan = {'qualificationTargetProfile': replacement.PROFILE, 'environment': 'staging',
                     'releaseId': self.release_id, 'sourceCommit': self.initial['sourceCommit'],
                     'candidateSha256': candidate_sha, 'targetSha256': 'b' * 64}
        self.label = containment.replacement_write_label(self.initial['reviewedPlanSha256'])
        for name in staging_state.CONFIGURATION_FILES:
            file = self.config_source / name
            file.parent.mkdir(mode=0o700, exist_ok=True, parents=True)
            file.write_bytes(b'owned-configuration\n')
            file.chmod(0o600)
        (self.config_source / 'gateway.json').write_text(json.dumps({'admission': {
            'file': '/admission/state.json', 'releaseId': self.release_id, 'candidateSha256': candidate_sha}}))
        self.config_pins = staging_state.configuration_hashes(self.config_source)
        self.postflight = b'{"proof":"owned-independent-postflight"}\n'
        self.original_sql = b'{"receipt":"owned-original-sql"}\n'
        raw_review = (json.dumps({'apiJobSha256': {name: 'c' * 64 for name in migrate.SERVICES},
                                  'configurationSha256': self.config_pins, 'configuration': str(self.config_source)}) + '\n').encode()
        self.initial['runtimeReviewSha256'] = migrate.file_hash(raw_review)
        self.initial['configuration'] = str(self.config_source)
        migrate.write_exact_bytes(self.directory, containment.REVIEW, raw_review)
        migrate.write_exact_bytes(self.directory, replacement.WRITTEN_OBSERVATION, self.postflight)
        migrate.write_exact_bytes(self.directory, 'frontend-original-database-receipt.json', self.original_sql)
        self.intent = {'version': 1, 'qualificationTargetProfile': replacement.PROFILE, 'environment': 'staging',
                       'releaseId': self.release_id, 'sourceCommit': self.initial['sourceCommit'],
                       'candidateSha256': candidate_sha, 'targetSha256': self.plan['targetSha256'],
                       'reviewedPlanSha256': self.initial['reviewedPlanSha256'],
                       'runtimeReviewSha256': self.initial['runtimeReviewSha256'],
                       'apiJobSha256': {name: 'c' * 64 for name in migrate.SERVICES},
                       'configurationSha256': self.config_pins, 'postflightSha256': migrate.file_hash(self.postflight),
                       'status': 'P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED', 'trafficAuthorized': False}
        migrate.write_json(self.directory, containment.INTENT, self.intent)
        self.commands, self.helpers, self.containers = [], {}, {}
        self.removal_error, self.bad_ack, self.late_container, self.late_helper = None, False, None, None
        self.enterContext(patch.object(supervisor, 'LOCK', self.lock))
        self.enterContext(patch.object(containment.p2_prior_gateway, 'ROOT', self.root))
        self.enterContext(patch.object(release, 'command', side_effect=self.docker))

    def create_snapshot(self):
        self.attempt.mkdir(mode=0o700)
        migration = self.attempt / 'migration-input'
        migration.mkdir(mode=0o700)
        migrate.write_exact_bytes(migration, 'release.candidate.json', self.candidate_raw)
        shutil.copytree(self.config_source, self.snapshot)
        migrate.write_exact_bytes(self.snapshot, 'compose.yaml', self.compose)
        admission = self.snapshot / 'admission'
        admission.mkdir(mode=0o700)
        (admission / 'state.json').write_text('{"newWork":true,"recovery":true}\n')

    def docker(self, args, env, timeout):
        self.assertEqual(env, release.SAFE_ENV)
        self.assertGreater(timeout, 0)
        with self.lock.open() as contender, self.assertRaises(BlockingIOError):
            fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.commands.append(args)
        if args[1:3] == ['container', 'ls']:
            filters = [value for value in args if value.startswith(('name=', 'label='))]
            if filters == ['label=com.docker.compose.project=lash-her-staging']:
                return '\n'.join(self.containers)
            pattern = next(value[5:] for value in filters if value.startswith('name='))
            labels = [value[6:] for value in filters if value.startswith('label=')]
            return '\n'.join(f'{identity}|{name}' for identity, (name, label) in self.helpers.items()
                             if re.fullmatch(pattern, '/' + name) and (not labels or labels == [label]))
        if args[1:3] == ['image', 'inspect']:
            return args[-1].split('@')[1]
        if args[1] == 'inspect':
            identity = args[-1]
            if identity in self.helpers:
                name, label = self.helpers[identity]
                return f'/{name}|{label.split("=", 1)[1]}'
            service, mount, running = self.containers[identity]
            if args[3] == '{{json .Mounts}}':
                return json.dumps([{'Type': 'bind', 'RW': False, 'Destination': destination, 'Source': str(mount / file)}
                                   for destination, file in (('/config/gateway.json', 'gateway.json'), ('/admission', 'admission'))])
            image = self.selected['artifacts'][release.IMAGE_KEYS[service]]['image']
            return '|'.join((identity, image.split('@')[1], image, 'true' if running else 'false',
                             containment.PROJECT, service, str(mount), str(mount / 'compose.yaml')))
        if args[1] == 'rm':
            identity = args[-1]
            if identity == self.removal_error:
                raise subprocess.CalledProcessError(1, args)
            self.assertEqual(self.helpers[identity][1], self.label)
            del self.helpers[identity]
            return ''
        if args[1] == 'exec':
            identity = args[2]
            self.assertEqual(self.containers[identity], ('gateway', self.snapshot, True))
            raw = (self.snapshot / 'admission/state.json').read_bytes()
            state = json.loads(raw)
            self.assertFalse(state['newWork'])
            self.assertFalse(state['recovery'])
            if self.bad_ack:
                return '[]'
            return json.dumps({'valid': True, 'sha256': migrate.file_hash(raw), 'newWork': False, 'recovery': False,
                               'active': {'newWork': 0, 'recovery': 0}, 'uncertain': {'newWork': 0, 'recovery': 0}})
        if args[1] == 'stop':
            for identity in args[4:]:
                service, mount, running = self.containers[identity]
                self.assertTrue(running)
                self.assertEqual(mount, self.snapshot)
                self.containers[identity] = (service, mount, False)
            if self.late_container:
                self.containers[self.late_container] = ('community-worker', self.snapshot, True)
            if self.late_helper:
                identity, name = self.late_helper
                self.helpers[identity] = (name, self.label)
            return ''
        raise AssertionError('unexpected fixture operation')

    def contain(self, worker_reaped=True):
        result = containment.contain_replacement_runtime_after_reap(self.initial, self.plan, self.selected,
            self.directory, configuration_sha256=self.config_pins, worker_reaped=worker_reaped)
        retained = self.directory / containment.RECEIPT
        self.assertEqual(json.loads(retained.read_bytes()), result)
        self.assertEqual(retained.stat().st_mode & 0o777, 0o600)
        self.assertFalse(result['automaticReplayAuthorized'])
        self.assertFalse(result['daemonOperationCompletionVerified'])
        self.assertFalse(result['releaseAccepted'])
        self.assertEqual((self.directory / replacement.WRITTEN_OBSERVATION).read_bytes(), self.postflight)
        self.assertEqual((self.directory / 'frontend-original-database-receipt.json').read_bytes(), self.original_sql)
        return result

    def test_closes_exact_gateway_stops_compose_and_removes_only_owned_helpers(self):
        self.create_snapshot()
        owned_api, owned_helper, foreign_helper = ('1' * 64, '2' * 64, '3' * 64)
        self.helpers.update({owned_api: ('lash-migrate-course-' + self.release_id, self.label),
                             owned_helper: ('lash-p2-profiled-current-image-check-' + '1' * 32, self.label),
                             foreign_helper: ('lash-p2-profiled-current-image-check-' + '2' * 32, containment.LABEL + '=' + '9' * 64)})
        gateway, worker = ('4' * 64, '5' * 64)
        self.containers.update({gateway: ('gateway', self.snapshot, True), worker: ('course-media', self.snapshot, True)})
        # Exercise the supervisor's real Linux broker process-group reap before
        # letting the independently held flock select any Docker effects.
        read, write = os.pipe()
        broker_pid = os.fork()
        if broker_pid == 0:
            os.close(read)
            os.setsid()
            os.write(write, b'ready')
            os.close(write)
            signal.pause()
            os._exit(1)
        os.close(write)
        try:
            self.assertTrue(select.select([read], [], [], 5)[0])
            self.assertEqual(os.read(read, 5), b'ready')
            reaped = supervisor._stop_profiled_certification_group(broker_pid)
            self.assertTrue(reaped)
            with self.assertRaises(ChildProcessError):
                os.waitpid(broker_pid, os.WNOHANG)
            result = self.contain(worker_reaped=reaped)
        finally:
            os.close(read)
            try:
                remaining, _ = os.waitpid(broker_pid, os.WNOHANG)
                if not remaining:
                    os.kill(broker_pid, signal.SIGKILL)
                    os.waitpid(broker_pid, 0)
            except ChildProcessError:
                pass
        self.assertEqual(result['status'], 'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_OBSERVED_REQUIRES_REVIEW')
        self.assertTrue(result['ownedHelpersAbsent'])
        self.assertTrue(result['gatewayAdmissionAcknowledged'])
        self.assertTrue(result['replacementRuntimeStopped'])
        self.assertEqual(set(self.helpers), {foreign_helper})
        self.assertIn(['docker', 'stop', '--timeout', '60', gateway, worker], self.commands)
        self.assertLess(next(i for i, row in enumerate(self.commands) if row[1] == 'exec'),
                        next(i for i, row in enumerate(self.commands) if row[1] == 'stop'))
        previous = list(self.commands)
        self.assertEqual(self.contain(), result)
        self.assertEqual(self.commands, previous)

    def test_helper_error_and_gateway_no_ack_do_not_skip_owned_runtime_stop(self):
        self.create_snapshot()
        gateway, worker = ('1' * 64, '2' * 64)
        self.containers.update({gateway: ('gateway', self.snapshot, True), worker: ('course-api', self.snapshot, True)})
        self.removal_error, self.bad_ack = '3' * 64, True
        self.helpers[self.removal_error] = ('lash-migrate-course-' + self.release_id, self.label)
        community = '4' * 64
        self.helpers[community] = ('lash-migrate-community-' + self.release_id, self.label)
        result = self.contain()
        self.assertEqual(result['status'], 'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN')
        self.assertFalse(result['ownedHelpersAbsent'])
        self.assertFalse(result['gatewayAdmissionAcknowledged'])
        self.assertTrue(result['ownedRuntimeContainersStopped'])
        self.assertEqual(set(self.helpers), {self.removal_error})

    def test_foreign_exact_migration_and_other_compose_mount_are_preserved(self):
        self.create_snapshot()
        foreign = '1' * 64
        name = 'lash-migrate-course-' + self.release_id
        self.helpers[foreign] = (name, containment.LABEL + '=' + '9' * 64)
        with self.assertRaisesRegex(ValueError, containment.REFUSED):
            containment.cleanup_named_replacement_helper(lambda args, timeout: self.docker(args, release.SAFE_ENV, timeout),
                                                         name, self.release_id, self.label)
        owned, predecessor = '2' * 64, '3' * 64
        self.containers.update({owned: ('course-api', self.snapshot, True),
                                predecessor: ('gateway', self.root / 'previous', True)})
        result = self.contain()
        self.assertEqual(result['foreignMigrationNames'], [name])
        self.assertEqual(result['unboundProjectContainers'], 1)
        self.assertTrue(result['ownedRuntimeContainersStopped'])
        self.assertFalse(result['replacementRuntimeStopped'])
        self.assertTrue(self.containers[predecessor][2])
        self.assertEqual(set(self.helpers), {foreign})

    def test_normal_cleanup_accepts_only_exact_absence_when_docker_auto_removes(self):
        identity = '1' * 64
        name = 'lash-migrate-course-' + self.release_id
        self.helpers[identity] = (name, self.label)

        def docker(args, timeout):
            if args[1] == 'rm':
                del self.helpers[identity]
                raise subprocess.CalledProcessError(1, args)
            return self.docker(args, release.SAFE_ENV, timeout)

        containment.cleanup_named_replacement_helper(docker, name, self.release_id, self.label)
        self.assertEqual(self.helpers, {})

    def test_absent_snapshot_can_observe_no_owned_runtime(self):
        result = self.contain()
        self.assertEqual(result['snapshot'], 'absent')
        self.assertTrue(result['replacementRuntimeStopped'])
        self.assertFalse(any(row[1] in ('rm', 'stop', 'exec') for row in self.commands))

    def test_unknown_snapshot_refuses_destructive_runtime_operations(self):
        self.create_snapshot()
        identity = '1' * 64
        self.containers[identity] = ('gateway', self.snapshot, True)
        (self.snapshot / 'compose.yaml').write_bytes(b'altered\n')
        result = self.contain()
        self.assertEqual(result['snapshot'], 'unknown')
        self.assertFalse(result['replacementRuntimeStopped'])
        self.assertFalse(any(row[1] in ('rm', 'stop', 'exec') for row in self.commands))

    def test_unreaped_worker_keeps_durable_uncertainty_without_docker_calls(self):
        result = self.contain(worker_reaped=False)
        self.assertFalse(result['workerProcessesReaped'])
        self.assertEqual(result['status'], 'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN')
        self.assertEqual(self.commands, [])

    def test_post_stop_new_daemon_effect_prevents_stopped_claim(self):
        self.create_snapshot()
        self.containers['1' * 64] = ('community-api', self.snapshot, True)
        self.late_container = '2' * 64
        result = self.contain()
        self.assertFalse(result['ownedRuntimeContainersStopped'])
        self.assertFalse(result['replacementRuntimeStopped'])
        self.assertTrue(self.containers[self.late_container][2])

    def test_post_stop_reconciles_owned_helper_created_during_compose_stop(self):
        self.create_snapshot()
        self.containers['1' * 64] = ('community-api', self.snapshot, True)
        identity = '2' * 64
        self.late_helper = identity, 'lash-migrate-course-' + self.release_id
        result = self.contain()
        self.assertTrue(result['ownedHelpersAbsent'])
        self.assertEqual(self.helpers, {})
        removal = self.commands.index(['docker', 'rm', '--force', identity])
        self.assertGreater(removal, next(index for index, row in enumerate(self.commands) if row[1] == 'stop'))

    def test_post_stop_late_helper_removal_failure_retains_uncertainty(self):
        self.create_snapshot()
        self.containers['1' * 64] = ('community-api', self.snapshot, True)
        self.removal_error = '2' * 64
        self.late_helper = self.removal_error, 'lash-p2-profiled-current-image-check-' + '3' * 32
        result = self.contain()
        self.assertFalse(result['ownedHelpersAbsent'])
        self.assertTrue(result['ownedRuntimeContainersStopped'])
        self.assertEqual(result['status'], 'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN')

    def test_runtime_review_drift_does_not_skip_owned_containment(self):
        self.create_snapshot()
        identity = '1' * 64
        self.containers[identity] = ('course-api', self.snapshot, True)
        path = self.directory / containment.REVIEW
        path.write_bytes(path.read_bytes() + b' ')
        result = self.contain()
        self.assertFalse(result['runtimeIntentVerified'])
        self.assertTrue(result['replacementRuntimeStopped'])
        self.assertEqual(result['status'], 'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN')


if __name__ == '__main__':
    unittest.main()
