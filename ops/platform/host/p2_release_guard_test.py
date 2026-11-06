import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest

import migrate
from p2_release_broker import Broker
from p2_release_scope import P2ReleaseScope
from p2_release_supervisor import stop_group, watch_broker, close_gateway, fail_closed, sticky_cleanup_signals, finish_failure_cleanup, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT
import staging_admission
from unittest.mock import patch


@unittest.skipUnless(hasattr(os, 'fork'), 'owned POSIX process fixtures')
class IndependentGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.lock = self.root / 'environment.lock'
        self.fd = os.open(self.lock, os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.children = []

    def tearDown(self):
        for pid in self.children:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, os.WNOHANG)
            except ChildProcessError: pass
        if self.fd is not None: os.close(self.fd)
        self.temporary.cleanup()

    def wait_file(self, name, timeout=5):
        path = self.root / name
        deadline = time.monotonic() + timeout
        while not path.exists():
            self.assertLess(time.monotonic(), deadline, name + ' was not retained')
            time.sleep(0.01)
        return path

    def test_killed_broker_group_cannot_start_after_independent_guard_final_stop(self):
        report_r, report_w = os.pipe()
        supervisor = os.fork()
        if supervisor == 0:
            os.close(report_r)
            safety_r, safety_w = os.pipe(); health_r, health_w = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(safety_r); os.close(health_w); os.close(report_w); os.setsid()
                try:
                    os.write(safety_w, b'{"operation":"alive"}\n{"operation":"armed","probe":{"owned":true}}\n')
                    scope = P2ReleaseScope(self.fd, self.lock, lambda: None, {})
                    (self.root / 'mutator-started').touch()
                    scope.run(['python3', '-I', '-c', 'import pathlib,time,sys;pathlib.Path(sys.argv[2]).touch();time.sleep(1);pathlib.Path(sys.argv[1]).touch()',
                               str(self.root / 'late-start'), str(self.root / 'worker-running')], timeout=10, check=True)
                finally: os._exit(0)
            os.close(safety_w); os.close(health_r)
            os.write(report_w, str(child).encode()); os.close(report_w)
            try:
                watch_broker(child, safety_r, health_w, lambda _: None)
            except BaseException:
                stop_group(child)
                (self.root / 'final-stop-after-group-quiescence').touch()
            os.close(self.fd); os._exit(0)
        self.children.append(supervisor); os.close(report_w)
        broker = int(os.read(report_r, 32)); os.close(report_r)
        os.close(self.fd); self.fd = None
        self.wait_file('worker-running')
        os.kill(broker, signal.SIGKILL)
        self.wait_file('final-stop-after-group-quiescence')
        time.sleep(1.1)
        self.assertFalse((self.root / 'late-start').exists())
        _, status = os.waitpid(supervisor, 0); self.children.remove(supervisor)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_killed_guard_revokes_broker_mutations_before_fencing_and_stop(self):
        report_r, report_w = os.pipe()
        guardian = os.fork()
        if guardian == 0:
            os.close(report_r)
            safety_r, safety_w = os.pipe(); health_r, health_w = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(safety_r); os.close(health_w); os.close(report_w); os.setsid()
                class Observer:
                    def probe(owned_self, operation):
                        assert operation == 'fence'
                        (self.root / 'frontend-closed').touch()
                broker = Broker({}, lambda _: None, shared_lock_fd=self.fd, safety_write=safety_w, guard_read=health_r)
                broker.lock_fd = self.fd; broker.observer = Observer()
                broker.scope = P2ReleaseScope(self.fd, self.lock, lambda: None, {})
                migrate.suspend_runtime = lambda *_: (self.root / 'runtime-stopped').touch()
                broker.start_guard_health()
                def mutate():
                    try:
                        broker.scope.run(['python3', '-I', '-c', 'import pathlib,time,sys;pathlib.Path(sys.argv[2]).touch();time.sleep(1);pathlib.Path(sys.argv[1]).touch()',
                                          str(self.root / 'late-start'), str(self.root / 'worker-running')], timeout=10, check=True)
                    except BaseException: pass
                threading.Thread(target=mutate, daemon=True).start()
                (self.root / 'broker-ready').touch()
                deadline = time.monotonic() + 5
                while not (self.root / 'runtime-stopped').exists() and time.monotonic() < deadline: time.sleep(0.01)
                try:
                    broker.scope.run(['python3', '-c', 'raise SystemExit(9)'], timeout=1, check=True)
                    os._exit(2)
                except ValueError:
                    os.close(self.fd); os._exit(0)
            os.close(safety_w); os.close(health_r)
            os.write(report_w, str(child).encode()); os.close(report_w)
            while True:
                os.write(health_w, b'H'); time.sleep(0.1)
        self.children.append(guardian); os.close(report_w)
        broker = int(os.read(report_r, 32)); os.close(report_r)
        self.children.append(broker)
        os.close(self.fd); self.fd = None
        self.wait_file('broker-ready'); self.wait_file('worker-running')
        os.kill(guardian, signal.SIGKILL)
        os.waitpid(guardian, 0); self.children.remove(guardian)
        self.wait_file('frontend-closed'); self.wait_file('runtime-stopped')
        time.sleep(1.1)
        self.assertFalse((self.root / 'late-start').exists())

    def test_failure_persists_closed_gateway_state_for_any_deliberate_restart(self):
        bundle = self.root / 'bundle'; bundle.mkdir(mode=0o700)
        snapshot = self.root / 'configuration'; snapshot.mkdir(mode=0o700)
        (snapshot / 'admission').mkdir(mode=0o755)
        (bundle / 'release.candidate.json').write_text('{"owned":true}\n')
        candidate_hash = migrate.file_hash((bundle / 'release.candidate.json').read_bytes())
        gateway = {'admission': {'file': '/admission/state.json', 'releaseId': 'owned', 'candidateSha256': candidate_hash}}
        (snapshot / 'gateway.json').write_text(json.dumps(gateway))
        staging_admission.persist_state(snapshot, {'releaseId': 'owned', 'candidateSha256': candidate_hash},
                                         'owned-open', new_work=True, recovery=True)
        with patch.object(staging_admission.Host, 'state', side_effect=ValueError('runtime unavailable')):
            receipt = close_gateway({'candidateSha256': candidate_hash}, {'releaseId': 'owned'}, snapshot)
        persisted = json.loads((snapshot / 'admission/state.json').read_bytes())
        self.assertIs(persisted['newWork'], False); self.assertIs(persisted['recovery'], False)
        self.assertIs(receipt['gatewayAdmissionFileClosed'], True)
        self.assertIsNone(receipt['gatewayAdmissionAcknowledged'])

    def test_input_bundle_loss_cannot_skip_frontend_gateway_fence_or_runtime_stop(self):
        self.failure_closure_case()

    def test_stuck_members_and_repeated_graceful_signal_still_close_admissions_and_stop(self):
        self.failure_closure_case(group=424242, repeated_signal=True)

    def test_final_guard_receipt_records_observed_quiescence_after_retry(self):
        self.failure_closure_case(group=424242, retry=True)

    def test_recovery_failure_uses_distinct_snapshot_and_receipts_without_original_overwrite(self):
        self.failure_closure_case(recovery=True)

    def test_certification_disables_native_before_current_mounted_admission_and_runtime_cleanup(self):
        self.failure_closure_case(certification=True)

    def test_certification_unknown_native_outcome_still_fences_and_stops(self):
        self.failure_closure_case(certification=True, native_result={'nativeDisabled': None, 'nativeDisableAttempted': True})

    def test_certification_callback_error_never_skips_other_cleanup_or_exposes_details(self):
        self.failure_closure_case(certification=True, native_error=True)

    def test_certification_malformed_native_outcome_is_unknown_not_verified(self):
        self.failure_closure_case(certification=True, native_result={'nativeDisabled': True, 'nativeDisableAttempted': False, 'unreviewed': True})

    def test_certification_native_disable_is_rechecked_after_mutator_reaping_retry(self):
        self.failure_closure_case(group=424242, retry=True, certification=True)

    def test_certification_cannot_issue_native_control_before_actual_armed_handshake(self):
        callback_calls = []
        initial = {'_guardLayout': CERTIFICATION_LAYOUT, 'nativeContainment': {'nativeDisabled': True}}
        result = fail_closed(initial, None, self.root, native_containment=lambda *_: callback_calls.append(True))
        self.assertEqual(callback_calls, [])
        self.assertEqual(result['status'], 'P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE')
        self.assertIs(result['runtimeStopAttempted'], False)
        self.assertNotIn('nativeDisabled', result)

    def failure_closure_case(self, group=None, repeated_signal=False, retry=False, recovery=False, certification=False,
                             native_result=None, native_error=False):
        results = self.root / 'results'; results.mkdir(mode=0o700)
        receipt_name = 'p2-certification-deliberate' if certification else 'p2-recovery-deliberate' if recovery else 'p2-owned'
        runtime_name = 'runtime-recovery-deliberate' if recovery else 'runtime-owned'
        (results / receipt_name).mkdir(mode=0o700)
        snapshot = self.root / 'actual-mounted-configuration' if certification else results / runtime_name / 'configuration'
        snapshot.mkdir(parents=True, mode=0o700)
        (snapshot / 'admission').mkdir(mode=0o755)
        candidate_hash = 'a' * 64
        (snapshot / 'gateway.json').write_text(json.dumps({'admission': {'file': '/admission/state.json',
            'releaseId': 'owned', 'candidateSha256': candidate_hash}}))
        staging_admission.persist_state(snapshot, {'releaseId': 'owned', 'candidateSha256': candidate_hash}, 'owned-open', new_work=True, recovery=True)
        initial = {'candidate': {'releaseId': 'owned'}, 'candidateSha256': candidate_hash, 'results': str(results),
                   'bundle': str(self.root / 'deleted-bundle'), 'sourceSha256': {'ops/platform/p2-frontend-live-probe.mjs': 'a'*64}, 'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'synthetic'}}
        if recovery:
            initial.update(recoveryActionId='deliberate', _guardLayout=RECOVERY_LAYOUT,
                           _guardObserverSource='ops/platform/p2-recovery-current-probe.mjs')
            initial['sourceSha256']['ops/platform/p2-recovery-current-probe.mjs'] = 'b'*64
        if certification:
            initial.update(certificationActionId='deliberate', _guardLayout=CERTIFICATION_LAYOUT, configuration=str(snapshot),
                           _guardObserverSource='ops/platform/p2-certification-current-probe.mjs')
            initial['sourceSha256']['ops/platform/p2-certification-current-probe.mjs'] = 'c'*64
        calls = []
        def native_containment(actual_initial, armed, source):
            self.assertIs(actual_initial, initial)
            self.assertEqual(armed, {'owned': True}); self.assertEqual(source, self.root)
            calls.append('native-disable')
            if native_error:
                raise RuntimeError('private-native-error-must-not-escape')
            return native_result if native_result is not None else {'nativeDisabled': True, 'nativeDisableAttempted': False}
        class Observer:
            def __init__(owned_self, *_, **kwargs): pass
            def probe(owned_self, operation): calls.append(operation)
        def stop(*_):
            if repeated_signal: os.kill(os.getpid(), signal.SIGTERM)
            calls.append('runtime-stop')
        with patch('p2_release_supervisor.PhysicalObserver', Observer), \
             patch('p2_release_supervisor.private_observer_program', return_value=self.root / 'owned-program'), \
             patch('p2_release_supervisor.runtime.command', return_value=''), \
             patch('p2_release_supervisor.stop_group', side_effect=[False, True, True] if retry else lambda *_: False), \
             patch('p2_release_supervisor.migrate.suspend_runtime', side_effect=stop), \
             patch.object(staging_admission.Host, 'state', side_effect=ValueError('unavailable')), sticky_cleanup_signals():
            if repeated_signal: os.kill(os.getpid(), signal.SIGTERM)
            options = {'native_containment': native_containment} if certification else {}
            receipt = (finish_failure_cleanup(initial, {'owned': True}, self.root, group, **options) if retry else
                       fail_closed(initial, {'owned': True}, self.root, group=group, **options))
        expected_calls = (['native-disable'] if certification else []) + ['fence', 'runtime-stop']
        self.assertEqual(calls, expected_calls * (2 if retry else 1))
        self.assertIs(receipt['frontendAdmissionClosed'], True); self.assertIs(receipt['runtimeStopped'], True)
        state = json.loads((snapshot / 'admission/state.json').read_bytes())
        self.assertIs(state['newWork'], False); self.assertIs(state['recovery'], False)
        if group is not None: self.assertIs(receipt['workerProcessesQuiesced'], retry)
        if retry:
            final = json.loads((results / receipt_name / 'p2-independent-guard-after-quiescence.json').read_bytes())
            self.assertIs(final['workerProcessesQuiesced'], True)
        if certification:
            valid = not native_error and (native_result is None or set(native_result) == {'nativeDisabled', 'nativeDisableAttempted'})
            self.assertIs(receipt['nativeDisabled'], (native_result or {'nativeDisabled': True})['nativeDisabled'] if valid else None)
            self.assertIs(receipt['nativeDisableAttempted'], (native_result or {'nativeDisableAttempted': False})['nativeDisableAttempted'] if valid else None)
            self.assertNotIn('private-native-error', json.dumps(receipt))
            self.assertFalse((results / 'runtime-certification-deliberate').exists())
        if recovery:
            self.assertTrue((results / receipt_name / 'p2-independent-guard-outcome.json').exists())
            self.assertFalse((results / 'p2-owned').exists())

    def test_abort_notifies_independent_guard_before_fallible_process_cleanup(self):
        safety_r, safety_w = os.pipe(); health_r, health_w = os.pipe()
        try:
            broker = Broker({}, lambda _: None, shared_lock_fd=self.fd, safety_write=safety_w, guard_read=health_r)
            broker.scope = P2ReleaseScope(self.fd, self.lock, lambda: None, {})
            with patch.object(broker.scope, 'revoke', side_effect=subprocess.TimeoutExpired('owned', 1)) as revoke:
                broker.abort()
                revoke.assert_not_called()
            self.assertTrue(broker.scope.revoked.is_set())
            self.assertEqual(json.loads(os.read(safety_r, 4096)), {'operation': 'abort'})
        finally:
            for descriptor in (safety_r, safety_w, health_r, health_w): os.close(descriptor)
