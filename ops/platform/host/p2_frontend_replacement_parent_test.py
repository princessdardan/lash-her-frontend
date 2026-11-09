import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import migrate
import p2_frontend_replacement_parent as parent
import p2_release_broker as broker_module
import p2_release_supervisor as supervisor


class ReplacementArmTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.bundle = self.root / 'bundle'
        (self.bundle / 'jobs').mkdir(parents=True)
        (self.bundle / 'schema').mkdir()
        self.results = self.root / 'results'
        self.results.mkdir(mode=0o700)
        self.release_id = 'owned-replacement'
        self.commit = 'a' * 40
        self.image_digest = 'sha256:' + 'b' * 64
        self.image = 'ghcr.io/princessdardan/lash-her-platform-frontend-migration@' + self.image_digest
        target = {'host': 'replacement.neon.tech', 'port': 5432, 'database': 'replacement', 'user': 'owner',
                  'runtimeRole': 'frontend_runtime', 'serverMajor': 18}
        predecessor = {**target, 'host': 'predecessor.neon.tech', 'runtimeRole': 'old_runtime'}
        self.target_sha = migrate.file_hash(parent.encoded({'environment': 'staging',
            **{key: target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}}))
        self.job = {'releaseId': self.release_id, 'sourceCommit': self.commit, 'migrationImageDigest': self.image_digest,
                    'sqlArtifactSha256': 'c' * 64, 'schemaBaselineSha256': 'd' * 64,
                    'contractManifestSha256': 'sha256:' + 'e' * 64, 'phase2ContractManifestSha256': 'sha256:' + 'f' * 64,
                    'recoveryRef': 'staging/replacement', 'target': {**target, 'allowEmptyBootstrap': True,
                                                                     'approvedPendingTags': ['0001_fixture']}}
        self.candidate = {'environment': 'staging', 'contractPhase': 'p2', 'releaseId': self.release_id,
                          'sources': {'frontend': {'commit': self.commit}}}
        self.baseline = {'version': 1, 'serverMajor': 18, 'catalog': {'relations': []}}
        self.raw_baseline = parent.encoded(self.baseline) + b'\n'
        self.probe_base = {'version': 1, 'qualificationTargetProfile': parent.PROFILE,
                           'operation': 'verify-pre-bootstrap-lock', 'candidate': self.candidate, 'job': self.job,
                           'baseline': self.baseline, 'predecessorTarget': predecessor, 'targetSha256': self.target_sha,
                           'databaseOid': '42', 'migrationRoleOid': '43'}
        self.probe = {**self.probe_base, 'marker': '9' * 64, 'backendPid': 313,
                      'backendStart': '2026-11-09T21:51:00.000000Z'}
        self.raw_observation = parent.encoded({
            **{key: self.probe[key] for key in ('version', 'qualificationTargetProfile', 'operation', 'targetSha256',
                                               'databaseOid', 'migrationRoleOid', *parent.PROBE_IDENTITY)},
            'status': 'P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED', 'environment': 'staging',
            'releaseId': self.release_id, 'sourceCommit': self.commit, 'readOnlyVerified': True,
            'authorityIssued': False, 'trafficAuthorized': False,
        }) + b'\n'
        candidate_path = self.bundle / 'release.candidate.json'
        job_path = self.bundle / 'jobs/frontend.json'
        candidate_path.write_bytes(parent.encoded(self.candidate) + b'\n')
        job_path.write_bytes(parent.encoded(self.job) + b'\n')
        (self.bundle / 'schema/frontend.json').write_bytes(self.raw_baseline)
        self.plan = {'version': 1, 'qualificationTargetProfile': parent.PROFILE, 'environment': 'staging',
                     'operation': 'profiled-frontend-replacement', 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED',
                     'releaseId': self.release_id, 'sourceCommit': self.commit, 'reviewSha256': '1' * 64,
                     'targetSha256': self.target_sha, 'candidateSha256': migrate.file_hash(candidate_path.read_bytes()),
                     'frontendJobSha256': migrate.file_hash(job_path.read_bytes()),
                     'schemaBaselineFileSha256': migrate.file_hash(self.raw_baseline),
                     **{key: self.job[key] for key in ('migrationImageDigest', 'sqlArtifactSha256', 'schemaBaselineSha256',
                                                       'contractManifestSha256', 'phase2ContractManifestSha256')},
                     'predecessor': {'provider': {}, 'target': predecessor, 'lineageSha256': '3' * 64,
                                     'deploymentId': 'dpl_prior', 'recoveryRef': 'prior', 'databaseOid': '22',
                                     'loginRoleOid': '23', 'sourceCommit': self.commit, 'observedAt': '2026-11-01',
                                     'appliedCount': 1, 'appliedPrefixSha256': '5' * 64, 'pendingTags': ['0001_fixture'],
                                     'phase2ContractManifestSha256': self.job['phase2ContractManifestSha256']},
                     'replacement': {'provider': {}, 'databaseOid': '42', 'migrationRoleOid': '43', 'administrativeLogins': [],
                                     'recoveryRef': self.job['recoveryRef'], 'target': target,
                                     'approvedPendingTags': ['0001_fixture']},
                     'replacementObserved': False, 'releaseAccepted': False, **parent.NO_AUTHORITY}
        self.plan_raw = parent.encoded(self.plan) + b'\n'
        review = migrate.file_hash(self.plan_raw)
        self.initial = {'version': 1, 'mode': parent.MODE, 'qualificationTargetProfile': parent.PROFILE,
                        'environment': 'staging', 'sourceCommit': self.commit, 'sourceSha256': {},
                        'sourceClosureSha256': '7' * 64, 'hostMachineId': '8' * 32, 'bundle': str(self.bundle),
                        'results': str(self.results), 'candidateSha256': self.plan['candidateSha256'],
                        'reviewedPlanBytes': base64.b64encode(self.plan_raw).decode(), 'reviewedPlanSha256': review,
                        'confirmation': 'staging/' + self.release_id + '/replacement-arm/' + review,
                        'credentials': {parent.CREDENTIAL: 'private-fixture-url'}}
        self.directory = self.results / (parent.LAYOUT['receiptPrefix'] + self.release_id)

    def test_exact_review_and_confirmation(self):
        self.assertEqual(parent.reviewed_plan(self.initial), (self.plan_raw, self.plan))
        for update in ({'reviewedPlanSha256': '1' * 64}, {'confirmation': 'staging/owned-replacement'},
                       {'sourceCommit': '1' * 40}, {'version': True}, {'credentials': {}}, {'extra': 1}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                parent.reviewed_plan({**self.initial, **update})
        with self.assertRaisesRegex(ValueError, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED'):
            supervisor.supervise(self.initial)

    def test_bundle_raw_bytes_match_probe_and_review(self):
        source = Path('/opt/lash-her/operators') / self.commit
        jobs = {'frontend': {'job': self.job, 'schema': self.raw_baseline, 'image': self.image}}
        with (patch.object(parent.runtime, 'assert_host'), patch.object(parent, 'verify_profiled_current_source_closure'),
              patch.object(parent, 'exact_host_directory', side_effect=Path),
              patch.object(migrate, 'make_plan', return_value=(self.candidate, jobs))):
            prepared = parent.prepare(self.initial, source)
            self.assertEqual(prepared, (self.plan_raw, self.plan, self.probe_base, self.image, self.directory))
            file = self.bundle / 'schema/frontend.json'
            file.write_bytes(self.raw_baseline + b' ')
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.prepare(self.initial, source)

    def test_observer_uses_exact_packaged_entry_and_owned_cleanup(self):
        result = subprocess.CompletedProcess([], 0, stdout=self.raw_observation)
        with (patch.object(parent.subprocess, 'run', return_value=result) as execute,
              patch.object(parent, 'remove_container') as cleanup):
            self.assertEqual(parent.observe(self.initial, self.image, self.probe), self.raw_observation)
            args = execute.call_args.args[0]
            options = execute.call_args.kwargs
            self.assertEqual(args[-3:], [self.image, 'ops/platform/frontend-image.mjs', '--observe-replacement-lock'])
            self.assertIn('--pull=never', args)
            self.assertIn('--read-only', args)
            self.assertNotIn('--mount', args)
            self.assertNotIn(self.initial['credentials'][parent.CREDENTIAL], args)
            self.assertEqual(options['env'][parent.CREDENTIAL], self.initial['credentials'][parent.CREDENTIAL])
            cleanup.assert_called_once_with(parent.container_name(self.initial, self.probe), self.initial['reviewedPlanSha256'])
        for name, value in (('backendPid', True), ('databaseOid', '44'), ('authorityIssued', True), ('marker', '2' * 64)):
            changed = json.loads(self.raw_observation)
            changed[name] = value
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.observation(self.probe, parent.encoded(changed))

    def test_arm_ready_and_review_bytes_are_bound(self):
        self.directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.directory, 'reviewed-plan.json', self.plan_raw)
        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(parent, 'observe', return_value=self.raw_observation)):
            parent.verify_and_retain(self.initial, self.plan, self.probe_base, self.image,
                                     self.directory, self.root, self.probe, threading.Event())
        armed, arm_sha = parent.require_arm(self.initial, self.plan, self.probe, self.directory)
        self.assertEqual(base64.b64decode(armed['physicalObservation']), self.raw_observation)
        self.assertEqual(arm_sha, migrate.file_hash((self.directory / parent.ARM).read_bytes()))
        self.assertEqual((self.directory / parent.READY).stat().st_mode & 0o777, 0o600)
        terminal = parent.terminal_receipt(self.initial, self.plan, armed, arm_sha)
        self.assertFalse(terminal['backendClosureVerified'])
        self.assertTrue(all(terminal[key] is False for key in parent.NO_AUTHORITY))
        with self.assertRaises(FileExistsError):
            migrate.write_json(self.directory, parent.ARM, {})
        (self.directory / 'reviewed-plan.json').write_bytes(self.plan_raw + b' ')
        with self.assertRaisesRegex(ValueError, parent.REFUSED):
            parent.require_arm(self.initial, self.plan, self.probe, self.directory)

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_live_flock_and_heartbeats_outlast_slow_independent_observer(self):
        self.exercise_live_guard()

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_late_bundle_drift_preserves_intent_and_refuses_terminal(self):
        self.exercise_live_guard(change_bundle=True)

    def exercise_live_guard(self, change_bundle=False):
        lock = self.root / 'owned-host.lock'
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        fd = os.open(lock, flags, 0o600)
        self.addCleanup(os.close, fd)
        operator_input, send = os.pipe()
        receive, operator_output = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(send)
            os.close(receive)
            os.close(fd)
            sys.stdin = os.fdopen(operator_input)
            sys.stdout = os.fdopen(operator_output, 'w')
            def slow_observer(*_args):
                if not change_bundle:
                    time.sleep(3.4)  # Longer than the broker's 3-second guard heartbeat limit.
                return self.raw_observation
            try:
                with (patch.object(parent, 'LOCK', lock), patch.object(supervisor, 'LOCK', lock),
                      patch.object(broker_module, 'LOCK', lock),
                      patch.object(parent, 'prepare', return_value=(self.plan_raw, self.plan, self.probe_base, self.image, self.directory)),
                      patch.object(supervisor, '_verify_guard_source'),
                      patch.object(parent.ReplacementArmBroker, 'require_source_closure'),
                      patch.object(parent, 'observe', side_effect=slow_observer),
                      patch.object(parent, 'remove_container')):
                    parent.supervise_replacement_arm(self.initial, self.root)
            except BaseException:
                os._exit(1)
            os._exit(0)
        os.close(operator_input)
        os.close(operator_output)
        reaped = False
        try:
            with os.fdopen(send, 'wb') as output, os.fdopen(receive, 'rb', buffering=0) as input_file:
                def response():
                    self.assertTrue(select.select([input_file], [], [], 12)[0], 'no owned host response')
                    return json.loads(input_file.readline())
                def send_frame(value):
                    output.write(parent.encoded(value) + b'\n')
                    output.flush()
                self.assertEqual(response(), {'id': 0, 'status': 'LOCKED'})
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                send_frame({'id': 1, 'operation': 'arm-replacement', 'probe': self.probe})
                ready = response()
                self.assertEqual(ready['status'], 'REPLACEMENT_ARMED')
                self.assertEqual(ready['armReceiptSha256'], migrate.file_hash((self.directory / parent.ARM).read_bytes()))
                send_frame({'id': 2, 'operation': 'check'})
                self.assertEqual(response(), {'id': 2, 'status': 'LOCKED'})
                send_frame({'id': 3, 'operation': 'commit'})
                terminal = response()
                self.assertEqual(terminal['status'], 'COMMITTED')
                self.assertEqual(terminal['receipt']['armReceiptSha256'], ready['armReceiptSha256'])
                self.assertFalse((self.directory / parent.TERMINAL).exists())
                self.assertEqual(json.loads((self.directory / parent.COMMIT_INTENT).read_bytes())['status'], parent.INTENT_STATUS)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if change_bundle:
                    (self.bundle / 'schema/frontend.json').write_bytes(self.raw_baseline + b' ')
            _, status = os.waitpid(child, 0)
            reaped = True
            self.assertEqual(os.waitstatus_to_exitcode(status), 1 if change_bundle else 0)
            self.assertEqual((self.directory / parent.TERMINAL).exists(), not change_bundle)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if not reaped:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)


if __name__ == '__main__':
    unittest.main()
