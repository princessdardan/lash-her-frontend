import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import unittest
import time
from unittest.mock import patch

import migrate
import staging_state
import migrate_test
from p2_certification_profile import PROFILE, require_profile
from p2_release_scope import P2ReleaseScope


class P2ScopeTests(unittest.TestCase):
    # Existing migration cases remain covered by their original suite. These
    # cases exercise the new broker-only seam with actual OS descriptors.
    save = migrate_test.MigrationDriverTests.save
    add_frontend = migrate_test.MigrationDriverTests.add_frontend
    fake_docker = migrate_test.MigrationDriverTests.fake_docker

    def setUp(self):
        migrate_test.MigrationDriverTests.setUp(self)
        self.add_frontend()
        phase2 = {'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + 'e' * 64}
        self.release.update(phase2); self.release['frontendMigration'].update(phase2)
        for job in self.jobs.values():
            job.update(phase2)
        self.save()
        self.path = self.root / 'actual-lock'
        self.descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.receipt = {**copy.deepcopy(self.jobs['frontend']), 'status': 'DATABASE_VERIFIED', 'service': 'frontend',
                        'target': {k: self.jobs['frontend']['target'][k] for k in ('host', 'port', 'database', 'user', 'serverMajor')},
                        'migrationMode': 'apply-forward', 'schemaVerified': True, 'runtimeRoleVerified': True,
                        'trafficAuthorized': False, 'after': [{'hash': 'f' * 64, 'created_at': '1'}],
                        'applied': [{'tag': '0000_test', 'hash': 'f' * 64}]}
        self.observations = 0
        def observed():
            self.observations += 1
        self.scope = P2ReleaseScope(self.descriptor, self.path, observed, self.receipt)

    def tearDown(self):
        os.close(self.descriptor)
        migrate_test.MigrationDriverTests.tearDown(self)

    def test_p2_scope_contends_with_an_independent_watchdog_process(self):
        script = 'import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
        result = subprocess.run(['python3', '-I', '-c', script, str(self.path)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.scope.require_frontend(self.release, migrate.frontend_plan(self.bundle, self.release))
        self.assertGreaterEqual(self.observations, 2)

    def test_p2_scope_refuses_replaced_inode_and_stale_frontend_receipt(self):
        for key in ('sourceCommit', 'schemaBaselineSha256', 'phase2ContractManifestSha256'):
            altered = copy.deepcopy(self.receipt); altered[key] = 'changed'
            scope = P2ReleaseScope(self.descriptor, self.path, lambda: None, altered)
            with self.assertRaises(ValueError):
                scope.require_frontend(self.release, migrate.frontend_plan(self.bundle, self.release))
        self.path.unlink(); self.path.write_text('new inode'); self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'LOCK_IDENTITY_CHANGED'):
            self.scope.verify()

    def test_p2_scope_is_not_a_caller_json_quiescence_flag(self):
        with self.assertRaisesRegex(ValueError, 'PROCESS_LOCAL_SCOPE_REQUIRED'):
            migrate.execute(self.bundle, self.results, True, 'staging/test-release', self.path,
                            _p2_scope={'held': True, 'frontendVerified': True})

    def test_p2_consumes_live_frontend_without_any_second_frontend_apply(self):
        calls = []
        def docker(args, **kwargs):
            calls.append(args)
            result = self.fake_docker(args, **kwargs)
            if '--execute' in args:
                mount = next(v for v in args if isinstance(v, str) and v.endswith('dst=/run/release-receipts'))
                directory = Path(mount.split(',src=')[1].split(',dst=')[0])
                terminal = {'status': 'DATABASE_VERIFIED', **migrate.contract_identity(self.release)}
                (directory / 'job-outcome.json').write_text(json.dumps(terminal))
            return result
        with patch.dict(os.environ, {'COURSE_STAGING_DATABASE_URL': 'owned-fixture-url',
                                     'COMMUNITY_STAGING_DATABASE_URL': 'owned-fixture-url'}, clear=False), \
             patch.object(migrate.subprocess, 'run', side_effect=docker), \
             patch.object(self.scope, 'run', side_effect=docker), \
             patch.object(self.scope, 'before_api_suspension'), patch.object(self.scope, 'after_api_suspension'):
            outcome = migrate.execute(self.bundle, self.results, True, 'staging/test-release', self.path, _p2_scope=self.scope)
        self.assertEqual(outcome['status'], 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN')
        frontend = self.results / 'test-release/frontend'
        self.assertEqual(json.loads((frontend / 'database-receipt.json').read_bytes()), self.receipt)
        self.assertFalse((frontend / 'job-outcome.json').exists())
        self.assertTrue((frontend / 'frontend-continuation-open.json').exists())
        applies = [args for args in calls if '--execute' in args]
        self.assertEqual(len(applies), 2)
        self.assertFalse(any('ops/platform/frontend-image.mjs' in args for args in applies))
        self.scope.verify()  # the borrowed descriptor was neither closed nor unlocked
        self.assertGreater(self.observations, 4)

    def test_input_is_private_stdin_and_scope_rejects_changed_api_jobs_before_docker(self):
        result = self.scope.run(['python3', '-I', '-c', 'import sys;print(len(sys.stdin.read()))'],
                                input='synthetic-private-input', text=True, capture_output=True, check=True, timeout=5)
        self.assertEqual(result.stdout.strip(), str(len('synthetic-private-input')))
        selected, jobs = migrate.make_plan(self.bundle)
        scope = P2ReleaseScope(self.descriptor, self.path, lambda: None, self.receipt, release=selected, jobs=jobs)
        self.jobs['course']['target']['approvedPendingTags'] = ['0001_unreviewed']
        self.save()
        with patch.object(migrate.subprocess, 'run', side_effect=AssertionError('Docker must not run')) as docker:
            with self.assertRaisesRegex(ValueError, 'REVIEWED_RELEASE_INPUTS_CHANGED'):
                migrate.execute(self.bundle, self.results, True, 'staging/test-release', self.path, _p2_scope=scope)
            docker.assert_not_called()

    def test_unreaped_child_remains_registered_for_guard_loss_retry(self):
        began, effect = self.root / 'child-began', self.root / 'late-effect'
        actual = subprocess.Popen(['python3', '-I', '-c', 'import pathlib,time,sys;pathlib.Path(sys.argv[1]).touch();time.sleep(1);pathlib.Path(sys.argv[2]).touch()', str(began), str(effect)])
        deadline = time.monotonic() + 5
        while not began.exists():
            self.assertLess(time.monotonic(), deadline); time.sleep(0.01)
        class LostKill:
            calls = 0
            def poll(owned_self): return actual.poll()
            def communicate(owned_self, **_): raise subprocess.TimeoutExpired('owned', 1)
            def kill(owned_self):
                owned_self.calls += 1
                if owned_self.calls == 1: raise OSError('owned kill acknowledgement lost')
                actual.kill()
            def wait(owned_self, **kwargs): return actual.wait(**kwargs)
        lost = LostKill()
        try:
            with patch('p2_release_scope.subprocess.Popen', return_value=lost):
                with self.assertRaises(OSError): self.scope.run(['owned-only'], timeout=1)
            self.assertIn(lost, self.scope.processes)
            self.scope.revoke()
            self.assertIsNotNone(actual.poll())
            time.sleep(1.05)
            self.assertFalse(effect.exists())
        finally:
            if actual.poll() is None: actual.kill()
            actual.wait(timeout=5)

    def test_changed_runtime_configuration_refuses_before_it_can_be_consumed(self):
        directory = self.root / 'configuration'; directory.mkdir(mode=0o700)
        for name in staging_state.CONFIGURATION_FILES:
            path = directory / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned-reviewed')
        expected = staging_state.configuration_hashes(directory)
        scope = P2ReleaseScope(self.descriptor, self.path, lambda: None, self.receipt, configuration_sha256=expected)
        scope.require_configuration(directory)
        (directory / 'course-api.env').write_text('COURSE_ACCOUNT_LIFECYCLE_ENABLED=false\n')
        with self.assertRaisesRegex(ValueError, 'REVIEWED_CONFIGURATION_CHANGED'):
            scope.require_configuration(directory)


class P2ProfileTests(unittest.TestCase):
    def test_profile_is_closed_and_bool_strict(self):
        self.assertEqual(require_profile(copy.deepcopy(PROFILE)), PROFILE)
        for mutated in [dict(PROFILE, extra=True), dict(PROFILE, version=True), dict(PROFILE, nativeSchedulesEnabled=True)]:
            with self.assertRaises(ValueError): require_profile(mutated)
        for key in PROFILE['featureControls']:
            mutated = copy.deepcopy(PROFILE); mutated['featureControls'][key] = not mutated['featureControls'][key]
            with self.assertRaises(ValueError): require_profile(mutated)
