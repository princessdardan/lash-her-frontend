"""Owned POSIX scope tests; no Docker, provider or PostgreSQL qualification."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from p2_profiled_current_scope import P2ProfiledCurrentScope, PROFILE, COMMON


def fixture():
    target = {'host': 'owned.example.invalid', 'port': 5432, 'database': 'owned', 'user': 'owned_migration',
              'runtimeRole': 'owned_runtime', 'serverMajor': 18, 'approvedPendingTags': [],
              'qualificationTargetProfile': copy.deepcopy(PROFILE)}
    job = {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'target': target,
        **{key: 'a' * 64 for key in COMMON}}
    job.update(environment='staging', releaseId='owned-current', sourceCommit='a' * 40,
               contractPhase='p2', phase2ContractManifestSha256='sha256:' + 'b' * 64)
    release = {'version': 3, 'qualificationTargetProfile': copy.deepcopy(PROFILE),
               'environment': 'staging', 'releaseId': job['releaseId'], 'contractPhase': 'p2'}
    row = {'hash': 'c' * 64, 'created_at': '1000'}
    receipt = {**{key: job[key] for key in COMMON}, 'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE),
        'target': {key: target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')},
        'status': 'DATABASE_VERIFIED', 'service': 'frontend', 'migrationMode': 'verify-current-only',
        'readOnlyVerified': True, 'schemaVerified': True, 'runtimeRoleVerified': True,
        'trafficAuthorized': False, 'before': [row], 'after': [copy.deepcopy(row)], 'applied': []}
    return release, {'frontend': {'job': job}}, receipt


class ProfiledCurrentScopeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.path = self.root / 'actual-host.lock'
        self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.release, self.jobs, self.receipt = fixture()
        self.reads = 0
        def observed():
            self.reads += 1
        self.observe = observed
        self.scope = self.new()

    def new(self, receipt=None):
        return P2ProfiledCurrentScope(self.fd, self.path, self.observe,
            self.receipt if receipt is None else receipt, 'd' * 64,
            release=self.release, jobs=self.jobs, configuration_sha256={'owned': 'e' * 64})

    def tearDown(self):
        self.scope.revoke()
        os.close(self.fd)
        self.directory.cleanup()

    def contender(self):
        return subprocess.run([sys.executable, '-I', '-c',
            'import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', str(self.path)],
            capture_output=True, timeout=5).returncode

    def test_actual_flock_remains_owned_through_close_only_and_no_frontend_read_after_close(self):
        self.assertNotEqual(self.contender(), 0)
        self.scope.require_frontend(self.release, self.jobs['frontend'])
        before = self.reads
        self.scope.begin_close()
        after = self.reads
        self.assertGreater(after, before)
        self.scope.verify_close()
        self.assertEqual(self.reads, after)
        self.assertNotEqual(self.contender(), 0)
        with self.assertRaisesRegex(ValueError, 'CLOSE_ONLY'):
            self.scope.verify()
        with self.assertRaisesRegex(ValueError, 'CLOSE_ONLY'):
            self.scope.run([sys.executable, '-I', '-c', 'raise SystemExit(99)'], timeout=1)

    def test_suffix_consumes_only_source_derived_job_and_still_binds_original_bytes(self):
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker
        parent = object.__new__(P2ProfiledCurrentRecoveryBroker)
        parent.directory = self.root
        parent.bundle = self.root / 'reviewed'
        derived_bundle = self.root / 'api-suffix-bundle'
        original = {'target': {'approvedPendingTags': ['first', 'remaining']}}
        derived = {'target': {'approvedPendingTags': ['remaining'], 'allowEmptyBootstrap': False}}
        pins = []
        for bundle, job in ((parent.bundle, original), (derived_bundle, derived)):
            (bundle / 'jobs').mkdir(mode=0o700, parents=True)
            job_file = bundle / 'jobs/course.json'
            raw = (json.dumps(job, indent=2) + '\n').encode()
            job_file.write_bytes(raw)
            job_file.chmod(0o600)
            pins.append({'course': hashlib.sha256(raw).hexdigest()})
        parent.initial = {'recoveryActionId': 'owned-recovery', 'disposition': 'resume-approved-api-suffix',
                          'apiJobSha256': pins[0], 'recoveryApiJobSha256': pins[1]}
        self.jobs['course'] = {'job': derived}
        self.scope.revoke()
        self.scope = P2ProfiledCurrentScope(self.fd, self.path, self.observe, self.receipt, 'd' * 64,
            release=self.release, jobs=self.jobs, configuration_sha256={'owned': 'e' * 64},
            recovery_action_id='owned-recovery')
        parent.scope, parent.lock_fd, parent.selected, parent.jobs = self.scope, self.fd, self.release, self.jobs
        self.scope.bind_runtime_parent(parent)
        with self.assertRaisesRegex(ValueError, 'API_JOB_BYTES_CHANGED'):
            self.scope.api_job_bytes('course')
        parent.derived_bundle, parent.derived_api_job_sha256 = derived_bundle, pins[1]
        self.assertEqual(self.scope.api_job_bytes('course'), (derived_bundle / 'jobs/course.json').read_bytes())
        (parent.bundle / 'jobs/course.json').write_text(json.dumps(original))
        with self.assertRaisesRegex(ValueError, 'API_JOB_BYTES_CHANGED'):
            self.scope.api_job_bytes('course')

    def test_current_receipt_rejects_pending_or_apply_or_drift_or_downgrade(self):
        changes = [lambda r: r.update(version=True), lambda r: r.update(version=1),
            lambda r: r.pop('qualificationTargetProfile'), lambda r: r.update(migrationMode='apply-forward'),
            lambda r: r.update(readOnlyVerified=False), lambda r: r.update(schemaVerified=False),
            lambda r: r.update(runtimeRoleVerified=False), lambda r: r.update(applied=[{'tag': '0082_owned'}]),
            lambda r: r.update(sourceCommit='f' * 40), lambda r: r.update(after=[]),
            lambda r: r.update(before=[]), lambda r: r.update(trafficAuthorized=True),
            lambda r: r['target'].update(database='foreign')]
        for change in changes:
            altered = copy.deepcopy(self.receipt)
            change(altered)
            with self.subTest(change=changes.index(change)), self.assertRaises(ValueError):
                self.new(altered)
        self.jobs['frontend']['job']['target']['approvedPendingTags'] = ['0082_owned']
        with self.assertRaisesRegex(ValueError, 'FRONTEND_RECEIPT_REQUIRED'):
            self.new()

    def test_runtime_stop_keeps_real_child_and_lock_under_the_physical_scope(self):
        class OwnedBoundary:
            api_suspension_started = api_suspension_finished = False

            def verify(inner):
                if inner.api_suspension_started and not inner.api_suspension_finished:
                    raise ValueError('PRIOR_GATEWAY_API_SUSPENSION_UNVERIFIED')

            def before_api_suspension(inner):
                inner.api_suspension_started = True

            def after_api_suspension(inner):
                self.assertTrue((self.root / 'stopped').exists())
                inner.api_suspension_finished = True

        docker = self.root / 'docker'
        docker.write_text(f"""#!{sys.executable}
import fcntl, os, sys
from pathlib import Path
root = Path(__file__).parent
with (root / 'actual-host.lock').open() as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise SystemExit(91)
if sys.argv[1:3] == ['stop', '--timeout']:
    assert sys.argv[3:] == ['30', 'a' * 64]
    (root / 'stopped').touch()
elif sys.argv[1:3] == ['ps', '--filter']:
    print('a' * 64, 'gateway')
elif sys.argv[1:3] == ['ps', '-q']:
    assert (root / 'stopped').exists()
else:
    raise SystemExit(92)
""")
        docker.chmod(0o700)
        self.scope.prior_gateway = OwnedBoundary()
        before = self.reads
        self.assertEqual(self.scope.suspend_api_runtime('staging', {'PATH': str(self.root)}), ['a' * 64])
        self.assertTrue(self.scope.prior_gateway.api_suspension_finished)
        self.assertGreaterEqual(self.reads - before, 8)
        self.assertEqual(self.scope.processes, set())
        self.assertNotEqual(self.contender(), 0)

    def test_close_deadline_and_replaced_lock_never_become_success(self):
        for seconds in (True, 0, 11, 900):
            with self.assertRaisesRegex(ValueError, 'CLOSE_BUDGET_REFUSED'):
                self.scope.begin_close(seconds)
        self.scope.begin_close()
        with patch('p2_profiled_current_scope.time.monotonic', return_value=self.scope.close_deadline + 1):
            with self.assertRaisesRegex(ValueError, 'CLOSE_WINDOW_LOST'):
                self.scope.verify_close()
        self.path.unlink()
        self.path.write_text('new inode')
        self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'LOCK_IDENTITY_CHANGED'):
            self.scope.verify_close()

    def test_revocation_actually_kills_and_reaps_registered_process(self):
        failures = []
        def run():
            try:
                self.scope.run([sys.executable, '-I', '-c', 'import time;time.sleep(60)'], timeout=70)
            except BaseException as error:
                failures.append(type(error).__name__)
        thread = threading.Thread(target=run)
        thread.start()
        deadline = time.monotonic() + 5
        while not self.scope.processes and time.monotonic() < deadline:
            time.sleep(0.01)
        children = list(self.scope.processes)
        self.assertEqual(len(children), 1)
        self.scope.revoke()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(all(child.poll() is not None for child in children))
        self.assertTrue(failures)
        self.assertNotEqual(self.contender(), 0)
        with self.assertRaises(ValueError):
            self.scope.begin_close()

    def test_close_refuses_registered_or_unreaped_children_and_forged_observer(self):
        child = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(60)'])
        self.scope.processes.add(child)
        with self.assertRaisesRegex(ValueError, 'WORKER_NOT_QUIESCED'):
            self.scope.begin_close()
        self.scope.revoke()
        self.assertIsNotNone(child.poll())
        self.scope.processes.clear()
        fresh = self.new()
        fresh.begin_close()
        with self.assertRaisesRegex(ValueError, 'CLOSE_OBSERVER_REQUIRED'):
            fresh.run_close_probe(object())

    def test_frontend_session_loss_stops_next_child_before_spawn(self):
        self.scope.verify_frontend = lambda: (_ for _ in ()).throw(ValueError('OWNED_SESSION_LOST'))
        with patch('p2_release_scope.subprocess.Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'OWNED_SESSION_LOST'):
                self.scope.run(['must-not-execute'], timeout=1)
            spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
