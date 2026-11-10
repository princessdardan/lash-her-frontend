import fcntl
import base64
import copy
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

import migrate
from p2_release_broker import Broker
from p2_release_scope import P2ReleaseScope
from p2_release_supervisor import stop_group, watch_broker, close_gateway, fail_closed, sticky_cleanup_signals, finish_failure_cleanup, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT
import staging_admission
import p2_release_scope_test as scope_fixture
import p2_release_supervisor as supervisor
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

    def profiled_certification(self, certification_id='owned-case'):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        profile = {'version': 2, 'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)}
        phase = {'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + 'a' * 64}
        candidate = {**profile, **phase, 'version': 3, 'releaseId': 'original', 'environment': 'staging'}
        plan = {**profile, **phase, 'certificationActionId': certification_id, 'environment': 'staging', 'originalReleaseId': 'original',
                'sourceCommit': 'b' * 40, 'candidateSha256': 'c' * 64, 'configurationSha256': 'd' * 64, 'targetSha256': 'e' * 64,
                'planSha256': 'f' * 64, 'mode': 'native-window', 'initialEpoch': '1'}
        initial = {**profile, 'mode': supervisor.PROFILED_CERTIFICATION_MODE, 'candidate': candidate,
                   'results': str(self.root), 'configuration': str(self.root / 'configuration'),
                   'configurationSha256': dict.fromkeys(supervisor.staging_state.CONFIGURATION_FILES, 'd' * 64),
                   '_guardLayout': supervisor.PROFILED_CERTIFICATION_LAYOUT, 'certificationPlan': plan,
                   '_guardLockDescriptor': self.fd, **{key: plan[key] for key in ('certificationActionId', 'sourceCommit',
                       'candidateSha256', 'targetSha256')}}
        directory = self.root / ('p2-profiled-current-certification-' + initial['certificationActionId'])
        directory.mkdir(mode=0o700)
        return initial, directory

    def test_profiled_guard_arm_is_bound_to_the_original_physical_request(self):
        initial, directory = self.profiled_certification()
        profile = {'version': 2, 'qualificationTargetProfile': initial['qualificationTargetProfile']}
        plan = initial['certificationPlan']
        target = {'host': 'fixture.invalid', 'port': 5432, 'database': 'fixture', 'user': 'operator', 'serverMajor': 18,
                  'qualificationTargetProfile': initial['qualificationTargetProfile']}
        role = {'name': 'runtime_role', 'oid': '22222'}
        plan['nativePlan'] = {'target': target, 'producer': {'role': role}}
        job = {**profile, 'releaseId': 'original', 'target': target}
        owner = {'name': 'owner_role', 'oid': '11111'}
        history = {**profile, 'target': target, 'retiredLogins': []}
        initial.update(owner=owner, inventory={'producers': [plan['nativePlan']['producer']], 'historicalLogins': history})
        receipt = {**profile, **migrate.contract_identity(initial['candidate']), 'target': target, 'owner': owner, 'runtime': role,
                   'status': 'P2_CERTIFICATION_DATABASE_CURRENT', 'service': 'frontend', 'releaseId': 'original',
                   **{key: plan[key] for key in ('certificationActionId', 'sourceCommit', 'candidateSha256', 'targetSha256', 'planSha256')},
                   'sqlReplayed': False, 'trafficAuthorized': False, 'schemaVerified': True, 'runtimeRoleVerified': True,
                   'admission': {'epoch': '1', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}
        probe = {**profile, 'marker': '1' * 64, 'backendPid': 123, 'backendStart': 'owned-backend-start',
                 'job': job, 'baseline': {}, 'owner': owner, 'producers': initial['inventory']['producers'], 'historicalLogins': history,
                 'plan': plan, 'receipt': receipt}
        info = {'job': job, 'schema': b'{}'}
        with self.assertRaises(FileNotFoundError):
            supervisor.require_profiled_certification_guard_arm(initial, probe)
        supervisor._validate_profiled_certification_arm(initial, probe, info)
        for changes in ({'baseline': {'other': True}}, {'owner': role}, {'backendPid': True},
                        {'receipt': {**receipt, 'admission': {**receipt['admission'], 'active': 1}}}):
            with self.subTest(changes=tuple(changes)), self.assertRaisesRegex(ValueError, 'GUARD_PROBE_REQUIRED'):
                supervisor._validate_profiled_certification_arm(initial, {**probe, **changes}, info)
        armed = supervisor._profiled_certification_arm_record(initial, probe)
        migrate.write_json(directory, supervisor.PROFILED_CERTIFICATION_ARM, armed)
        with self.assertRaises(FileNotFoundError):
            supervisor.require_profiled_certification_guard_arm(initial, probe)
        (directory / supervisor.PROFILED_CERTIFICATION_ARM).unlink()
        supervisor._retain_profiled_certification_arm(initial, probe)
        self.assertEqual(supervisor.require_profiled_certification_guard_arm(initial, probe), armed)
        with self.assertRaisesRegex(ValueError, 'GUARD_ARM_REQUIRED'):
            supervisor.require_profiled_certification_guard_arm(initial, {**probe, 'backendStart': 'changed'})

    def test_profiled_terminal_joins_raw_commit_and_rejects_unknown_as_closed(self):
        initial, _ = self.profiled_certification()
        terminal = {**initial['certificationPlan'], 'status': supervisor.PROFILED_CERTIFICATION_LAYOUT['terminalStatus'],
                    'releaseId': 'original', 'configurationSha256': initial['configurationSha256'],
                    'frontendSqlApplied': False, 'trafficAuthorized': False, 'releaseAccepted': False, 'sqlReplayed': False,
                    'nativeDisabled': True, 'frontendAdmission': {'epoch': '4', 'newWork': False, 'recovery': False, 'active': 0,
                    'uncertain': 0}, 'gatewayAdmission': {'newWork': False, 'recovery': False,
                    'active': {'newWork': 0, 'recovery': 0}, 'uncertain': {'newWork': 0, 'recovery': 0}}}
        raw = json.dumps(terminal).encode()
        digest = migrate.file_hash(raw)
        self.assertEqual(supervisor._require_profiled_certification_terminal(initial, raw, digest), terminal)
        with self.assertRaisesRegex(ValueError, 'TERMINAL_REFUSED'):
            supervisor._require_profiled_certification_terminal(initial, raw + b'\n', digest)
        for changes, code in (({'nativeDisabled': None}, 'TERMINAL_REFUSED'), ({'releaseAccepted': True}, 'TERMINAL_REFUSED'),
                ({'planSha256': '0' * 64}, 'TERMINAL_REFUSED'),
                ({'frontendAdmission': {**terminal['frontendAdmission'], 'uncertain': 1}}, 'TERMINAL_NOT_CLOSED'),
                ({'gatewayAdmission': {**terminal['gatewayAdmission'], 'active': {'newWork': False, 'recovery': 0}}}, 'TERMINAL_NOT_CLOSED')):
            with self.subTest(changes=tuple(changes)), self.assertRaisesRegex(ValueError, code):
                changed = json.dumps({**terminal, **changes}).encode()
                supervisor._require_profiled_certification_terminal(initial, changed, migrate.file_hash(changed))

    def test_known_ack_terminal_requires_the_original_replacement_receipt_bytes(self):
        initial, directory = self.profiled_certification()
        plan = initial['certificationPlan']
        replacement = {'recoveryActionId': 'owned-replacement', 'intentSha256': 'a' * 64}
        plan.update(mode='known-ack-recovery', knownAckRecovery=replacement)
        operation = '10000000-0000-4000-8000-000000000001'
        zero = {'newWork': 0, 'recovery': 0}
        admission = {'newWork': False, 'recovery': False, 'active': zero, 'uncertain': zero}
        outcome = {'version': 2, 'qualificationTargetProfile': initial['qualificationTargetProfile'],
                   **migrate.contract_identity(initial['candidate']), 'status': 'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED',
                   'candidateSha256': initial['candidateSha256'], 'recoveryActionId': replacement['recoveryActionId'],
                   'recoveryIntentSha256': replacement['intentSha256'], 'frontendOperationId': operation, 'runtimeReplacements': 1,
                   'sqlReplayed': False, 'frontendSqlApplied': False, 'migrationsExecuted': False, 'trafficAuthorized': False,
                   'newGateway': {'admission': admission}}
        with patch.object(supervisor.p2_prior_gateway, 'ROOT', directory.parent):
            runtime = supervisor._profiled_known_ack_runtime_directory(initial)
            runtime.mkdir(parents=True, mode=0o700)
            migrate.write_json(runtime, 'known-ack-runtime-outcome.json', outcome)
            migrate.write_json(directory, 'known-ack-replacement-joined.json', outcome)
            retained = migrate.read_input(runtime, 'known-ack-runtime-outcome.json')
            terminal = {**plan, 'status': supervisor.PROFILED_CERTIFICATION_LAYOUT['terminalStatus'], 'releaseId': 'original',
                        'configurationSha256': initial['configurationSha256'], 'frontendSqlApplied': False, 'trafficAuthorized': False,
                        'releaseAccepted': False, 'sqlReplayed': False, 'nativeDisabled': True, 'runtimeReplaced': True,
                        'frontendAdmission': {'epoch': '4', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0},
                        'gatewayAdmission': admission, 'knownAckRuntimeReceiptSha256': migrate.file_hash(retained),
                        'knownAckLoss': {'replacementCompletedClosed': True, 'ordinaryClosedZeroGate': False,
                                         'oldGatewayUncertain': {'newWork': 0, 'recovery': 1}, 'operationId': operation,
                                         'recoveryActionId': replacement['recoveryActionId']}}
            raw = json.dumps(terminal).encode()
            self.assertEqual(supervisor._require_profiled_certification_terminal(initial, raw, migrate.file_hash(raw)), terminal)
            (directory / 'known-ack-replacement-joined.json').write_bytes(retained + b'\n')
            with self.assertRaisesRegex(ValueError, 'KNOWN_ACK_TERMINAL_REFUSED'):
                supervisor._require_profiled_certification_terminal(initial, raw, migrate.file_hash(raw))

    def test_profiled_interactive_terminal_joins_private_dispatch_and_physical_ledger(self):
        cases = (('lifecycle', 'admin', None), ('authoring', 'admin', None), ('paid-grant', 'admin', None),
                 ('identity', 'admin', None), ('identity', 'customer', None),
                 ('identity', 'customer', 'google'), ('identity', 'customer', 'resend'))
        for stage, actor_kind, provider in cases:
            with self.subTest(stage=stage, actor_kind=actor_kind, provider=provider):
                self.check_profiled_interactive_terminal(stage, actor_kind, provider)
        self.check_profiled_interactive_terminal('paid-grant', 'admin', None, second_paid=True)
        for remaining in (False, True):
            with self.subTest(remaining_access=remaining):
                self.check_profiled_interactive_terminal('paid-revoke', 'admin', None, remaining_access=remaining)
        for progress_first in (False, True):
            with self.subTest(progress_first=progress_first):
                self.check_profiled_interactive_terminal('learning', 'customer', None, progress_first=progress_first)
            with self.subTest(replay=True, progress_first=progress_first):
                self.check_profiled_interactive_terminal('learning', 'customer', None, progress_first=progress_first, replay=True)
        for index, outcome in enumerate(('allowed', 'archived', 'draft', 'restricted')):
            with self.subTest(learner_outcome=outcome):
                self.check_profiled_interactive_terminal('learner-access', 'customer', None, progress_first=bool(index % 2),
                                                        learner_outcome=outcome)
        for progress_first in (False, True):
            with self.subTest(lesson_entry_progress_first=progress_first):
                self.check_profiled_interactive_terminal('lesson-entry', 'customer', None, progress_first=progress_first)
            with self.subTest(lesson_denial_parallel_order=progress_first):
                self.check_profiled_interactive_terminal('lesson-denial', 'customer', None, progress_first=progress_first)
            with self.subTest(assessment_parallel_order=progress_first):
                self.check_profiled_interactive_terminal('lesson-assessment', 'customer', None, progress_first=progress_first)
            with self.subTest(resume_parallel_order=progress_first):
                self.check_profiled_interactive_terminal('lesson-resume', 'customer', None, progress_first=progress_first)
            with self.subTest(restore_parallel_order=progress_first):
                self.check_profiled_interactive_terminal('lesson-restore', 'customer', None, progress_first=progress_first)
            with self.subTest(ack_loss_parallel_order=progress_first):
                self.check_profiled_interactive_terminal('lesson-ack-loss', 'customer', None, progress_first=progress_first)
        self.check_profiled_interactive_terminal('authoring', 'admin', None, editing=True)
        self.check_profiled_interactive_terminal('authoring', 'admin', None, archiving=True)
        for outcome, access in (('published', True), ('published', False), ('blocked', True)):
            with self.subTest(republish_outcome=outcome, expected_access=access):
                self.check_profiled_interactive_terminal('authoring', 'admin', None,
                                                        republish_outcome=outcome, expected_access=access)
        for outcome in ('published', 'blocked'):
            with self.subTest(publication_outcome=outcome):
                self.check_profiled_interactive_terminal('authoring', 'admin', None, publication_outcome=outcome)
        for revision in (0, 7):
            with self.subTest(quiz_revision=revision):
                self.check_profiled_interactive_terminal('authoring', 'admin', None, quiz_revision=revision)
        for kind in ('module', 'lesson'):
            with self.subTest(reorder_kind=kind):
                self.check_profiled_interactive_terminal('authoring', 'admin', None, reorder_kind=kind)
            with self.subTest(create_kind=kind):
                self.check_profiled_interactive_terminal('authoring', 'admin', None, create_kind=kind)

    def test_profiled_exit_save_joins_the_native_browser_exit_to_the_course_write(self):
        for progress_first, operation in enumerate(('spa-navigation', 'document-exit')):
            with self.subTest(operation=operation):
                self.check_profiled_interactive_terminal('lesson-exit-save', 'customer', None,
                                                         progress_first=bool(progress_first), exit_operation=operation)

    def test_profiled_visibility_save_joins_the_hidden_document_to_the_course_write(self):
        for progress_first in (False, True):
            with self.subTest(progress_first=progress_first):
                self.check_profiled_interactive_terminal('lesson-visibility-save', 'customer', None,
                                                         progress_first=progress_first)

    def test_profiled_stale_revision_joins_the_conflict_to_authoritative_reload(self):
        for progress_first in (False, True):
            with self.subTest(progress_first=progress_first):
                self.check_profiled_interactive_terminal('lesson-stale-revision', 'customer', None,
                                                         progress_first=progress_first)

    def test_profiled_paired_identity_requires_distinct_verified_customer_sessions(self):
        self.check_profiled_interactive_terminal('identity', 'customer', None, identity_pair=True)

    def test_exit_save_gateway_waits_for_a_pending_acknowledgement_within_the_permit(self):
        import p2_interactive_window as window

        stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
        stage._check = lambda: None
        stage._state, stage._private_cookie, stage._scoped_sha = 'opened', None, 'a' * 64
        stage._expires = 20
        stage.action = {'stage': 'lesson-exit-save', 'requests': [{'uses': 2}] + [{'uses': 1}] * 9}
        rows = [{'requestId': f'70000000-0000-4000-8000-{index:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{index:012d}',
                 'requestIndex': request_index, 'upstreamStatus': 200}
                for index, request_index in enumerate((*range(8), 0, 8, 9), 1)]
        pending = {'active': {'newWork': 1, 'recovery': 0}, 'uncertain': window._ZERO,
                   'interactiveEvidence': {'admitted': 11, 'acknowledged': rows[:-1]}}
        settled = {'active': window._ZERO, 'uncertain': window._ZERO,
                   'interactiveEvidence': {'admitted': 11, 'acknowledged': rows}}
        with patch.object(window.time, 'time', return_value=1), patch.object(window.time, 'monotonic', return_value=1), \
             patch.object(window.time, 'sleep') as sleep:
            stage._scoped_gateway = iter((pending, settled)).__next__
            self.assertEqual(stage.collect_gateway_effects(), rows)
            sleep.assert_called_once()
            sleep.reset_mock()
            stage._scoped_gateway = lambda: {**pending, 'uncertain': {'newWork': 1, 'recovery': 0}}
            with self.assertRaisesRegex(ValueError, 'COMPLETE_GATEWAY_EFFECTS_REQUIRED'):
                stage.collect_gateway_effects()
            stage._scoped_gateway = lambda: {**pending, 'interactiveEvidence': {'admitted': 12, 'acknowledged': rows[:-1]}}
            with self.assertRaisesRegex(ValueError, 'COMPLETE_GATEWAY_EFFECTS_REQUIRED'):
                stage.collect_gateway_effects()
            sleep.assert_not_called()
        stage._scoped_gateway = lambda: pending
        with patch.object(window.time, 'time', side_effect=(1, 20)), patch.object(window.time, 'monotonic', return_value=1), \
             patch.object(window.time, 'sleep') as sleep:
            with self.assertRaisesRegex(ValueError, 'EXIT_SAVE_GATEWAY_DRAIN_EXPIRED'):
                stage.collect_gateway_effects()
            sleep.assert_not_called()

    def test_stalled_renewal_joins_the_host_fence_and_original_playback_after_waiting(self):
        import p2_interactive_window as window
        from p2_certification_parent import P2ProfiledCertificationBroker

        initial, directory = self.profiled_certification('owned-stalled-renewal')
        plan = initial['certificationPlan']
        actor, course, lesson = [f'10000000-0000-4000-8000-{index:012d}' for index in (1, 2, 3)]
        selected = {'courseId': course, 'lessonId': lesson, 'playbackIdSha256': '9' * 64}
        lesson_api = f'/course/v1/student/lessons/{lesson}'
        targets = (f'/course/v1/student/courses/{course}', lesson_api, f'/course/v1/student/progress?lessonId={lesson}',
                   f'{lesson_api}/quiz', f'{lesson_api}/quiz/attempts', f'{lesson_api}/playback')
        action = {'stage': 'stalled-playback-renewal', 'actorId': actor, 'windowSeconds': 300, 'stalledRenewalAction': selected,
                  'requests': [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': 1} for target in targets]}
        plan.update(mode='interactive-browser', scopedAction=action, maximumSeconds=900)
        self.assertEqual(window.validate_interactive_plan_action(plan), action)
        for wrong in ({**action, 'windowSeconds': 900}, {**action, 'requests': action['requests'] + [action['requests'][-1]]}):
            with self.assertRaises(ValueError):
                window.validate_interactive_action(wrong)
        self.assertEqual(window._selection_sha(action), (actor + course + lesson).replace('-', ''))

        source = Path(__file__).resolve().parents[3]
        recorder = migrate.read_input(source, window._BROWSER_SOURCE)
        initial.update(sourceSha256={window._BROWSER_SOURCE: migrate.file_hash(recorder)}, interactiveController={
            'challenge': '1' * 64, 'bindingSha256': plan['planSha256'],
            'browserProgramSha256': migrate.file_hash(recorder + window._BROWSER_LAUNCHER)})
        acknowledgements = [
            {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
             'requestIndex': index, 'upstreamStatus': 200} for position, index in enumerate((4, 2, 1, 3, 0, 5), 1)]
        gateway_artifact = {**window.browser_receipt(plan, 'GATEWAY_OBSERVED'), 'epoch': '2', 'gatewayActive': 0,
                            'gatewayUncertain': 0, 'gatewayStateSha256': '7' * 64, 'gatewayAcknowledgements': acknowledgements}
        migrate.write_json(directory, window.browser_artifact(plan, 'gateway'), gateway_artifact)
        ledger = dict.fromkeys(('commands', 'deliveries', 'orderViolations', 'operations'), [])
        frontend = {'epoch': '3', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
        original = (b'owned-closed-gateway', 0o640, window._GATEWAY_GID)
        gateway = {'version': 1, 'valid': True, 'releaseId': 'original', 'candidateSha256': initial['candidateSha256'],
                   'newWork': False, 'recovery': False, 'active': window._ZERO, 'uncertain': window._ZERO,
                   'sha256': window._hash(original[0])}
        broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
        stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
        stage.plan, stage.action, stage.broker, stage._permit_issued = plan, action, broker, True
        stage._state, stage._original, stage._stalled_renewal_fence = 'opened', original, None
        stage._check = lambda: None
        stage._read, stage._gateway = lambda: original, lambda: gateway
        broker.initial, broker.scoped_stage, broker.directory = initial, stage, directory
        broker.scoped_case = broker.closing_at = None
        broker.scoped_gate_lock = threading.RLock()
        broker.external_armed = broker.guard_arm_verified = True
        broker.check = lambda: None
        broker.observer = SimpleNamespace(probe=lambda _: {'admission': frontend, 'witness': ledger})
        calls = []
        broker.send = lambda identity, status, **data: calls.append({'id': identity, 'status': status, **data})
        envelope = {'id': 1, 'controllerChallenge': initial['interactiveController']['challenge']}
        confirm = {**envelope, 'operation': 'interactive-confirm-fence'}
        fence_path = directory / window.browser_artifact(plan, 'observation-fence')
        with self.assertRaisesRegex(ValueError, 'FENCE_REQUIRED'):
            broker.command(confirm)
        stage._state = 'fenced'
        with patch.object(broker.observer, 'probe', return_value={'admission': {**frontend, 'uncertain': 1}, 'witness': ledger}):
            with self.assertRaisesRegex(ValueError, 'FRONTEND_DRAIN_REQUIRED'):
                broker.command(confirm)
        self.assertFalse(fence_path.exists())
        wall = window._lesson_expiry('2026-11-09T10:00:00.000Z').replace(tzinfo=window.timezone.utc).timestamp()
        with patch.object(window.time, 'time', return_value=wall + 3), patch.object(window.time, 'monotonic', return_value=100):
            broker.command(confirm)
        fence = calls.pop()['receipt']
        self.assertEqual(fence, json.loads(fence_path.read_bytes()))
        self.assertEqual(fence['observedAt'], '2026-11-09T10:00:03.000Z')
        with self.assertRaisesRegex(ValueError, 'FENCE_ORDER_REQUIRED'):
            broker.command(confirm)

        browser = {'version': 1, 'status': 'P2_STALLED_PLAYBACK_RENEWAL_BROWSER_OBSERVED',
                   'evidenceClass': 'source-browser-observation', 'actorId': actor,
                   'page': {'pathname': f'/academy/courses/{course}/lessons/{lesson}', 'status': 200},
                   'media': {'manifestObserved': True, 'segmentObserved': True, 'nativeVideoObserved': True},
                   'playback': {'requestId': acknowledgements[-1]['requestId'], 'playbackIdSha256': selected['playbackIdSha256'],
                                'serverDate': 'Mon, 09 Nov 2026 10:00:00 GMT', 'expiresAt': '2026-11-09T10:10:00.000Z',
                                'thumbnailExpiresAt': '2026-11-09T10:10:00.000Z', 'lifetimeMs': 600_000},
                   'observation': {'expectedExpiryElapsedMs': 599_100, 'permitCookieAbsent': True,
                                   'renewal': {'pathname': f'/api/academy/lessons/{lesson}/playback', 'method': 'GET', 'count': 1,
                                               'forwarded': False, 'responseObserved': False}}}
        for name, elapsed, seconds in (('initialRequest', 100, 0), ('baseline', 2100, 2), ('fenceConfirmed', 3150, 3.05),
                                       ('renewalStarted', 569100, 569), ('playerLastPresent', 599000, 598.9),
                                       ('playerRemoved', 599100, 599), ('retryVisible', 599200, 599.1)):
            browser['observation'][name] = {'observedAt': window._instant(wall + seconds), 'elapsedMs': elapsed}
        retain = {**envelope, 'operation': 'interactive-retain', 'caseEvidence': {'stalledRenewalBrowser': browser}}
        with patch.object(window.time, 'time', return_value=wall + 599.1), patch.object(window.time, 'monotonic', return_value=104):
            with self.assertRaisesRegex(ValueError, 'HOST_TIMING_REQUIRED'):
                broker.command(retain)
        wrong = {**browser, 'playback': {**browser['playback'], 'requestId': acknowledgements[0]['requestId']}}
        with self.assertRaisesRegex(ValueError, 'PLAYBACK_REQUIRED'):
            broker.command({**retain, 'caseEvidence': {'stalledRenewalBrowser': wrong}})
        with patch.object(window.time, 'time', return_value=wall + 599.2), patch.object(window.time, 'monotonic', return_value=696.2):
            broker.command(retain)
        case = calls.pop()['receipt']
        self.assertEqual(case['playbackGatewayRequestId'], acknowledgements[-1]['requestId'])
        self.assertEqual(case['frontendOperationCount'], 0)
        terminal = {**plan, 'status': supervisor.PROFILED_CERTIFICATION_LAYOUT['terminalStatus'], 'releaseId': 'original',
                    'configurationSha256': initial['configurationSha256'], 'caseStatus': case['status'],
                    'caseOutcomeSha256': supervisor._canonical_sha(case), 'frontendAdmission': frontend,
                    'witnessSha256': migrate.file_hash(json.dumps(ledger, separators=(',', ':')).encode()),
                    'gatewayAdmission': gateway, 'nativeDisabled': True,
                    **dict.fromkeys(('frontendSqlApplied', 'trafficAuthorized', 'releaseAccepted', 'sqlReplayed', 'nativeInvocationQualified',
                        'persistenceAuthorityJoined', 'deployedCertificationComplete', 'directWorkerSourceJoined', 'runtimeReplaced',
                        'wholeReleaseAccepted'), False)}
        raw = json.dumps(terminal).encode()
        self.assertEqual(supervisor._require_profiled_certification_terminal(initial, raw, migrate.file_hash(raw), source=source), terminal)
        fence_path.write_text(json.dumps({**fence, 'observedAt': '2026-11-09T10:09:30.000Z'}))
        with self.assertRaisesRegex(ValueError, 'TIMING_REQUIRED'):
            supervisor._require_profiled_certification_terminal(initial, raw, migrate.file_hash(raw), source=source)

    def check_profiled_interactive_terminal(self, stage_name, actor_kind, provider, *, editing=False, reorder_kind=None,
                                            create_kind=None, publication_outcome=None, quiz_revision=None,
                                            progress_first=False, archiving=False, republish_outcome=None, expected_access=None,
                                            learner_outcome=None, remaining_access=None, second_paid=False, replay=False,
                                            exit_operation=None, identity_pair=False):
        import p2_interactive_window as window
        from p2_certification_parent import P2ProfiledCertificationBroker

        variant = (f'create-{create_kind}' if create_kind is not None else 'edit' if editing else
                   publication_outcome or reorder_kind or provider or actor_kind)
        if quiz_revision is not None:
            variant = f'quiz-{quiz_revision}'
        if archiving:
            variant = 'archive'
        if republish_outcome is not None:
            variant = f'republish-{republish_outcome}-{str(expected_access).lower()}'
        if stage_name == 'learning':
            variant = 'progress-first' if progress_first else 'course-first'
            if replay:
                variant = 'replay-' + variant
        if stage_name in ('lesson-entry', 'lesson-denial', 'lesson-assessment', 'lesson-resume', 'lesson-restore',
                          'lesson-ack-loss', 'lesson-visibility-save', 'lesson-stale-revision'):
            variant = 'progress-first' if progress_first else 'playback-first'
        if identity_pair:
            variant = 'customer-pair'
        if learner_outcome is not None:
            variant = learner_outcome
        if remaining_access is not None:
            variant = 'remaining' if remaining_access else 'removed'
        if second_paid:
            variant = 'second-grant'
        if exit_operation:
            variant = exit_operation
        initial, directory = self.profiled_certification(f'owned-{stage_name}-{variant}')
        plan = initial['certificationPlan']
        ids = [f'10000000-0000-4000-8000-00000000000{index}' for index in range(1, 8)]
        actor, user, request, command, *ledger_ids = ids
        identity = stage_name == 'identity'
        authoring = stage_name == 'authoring'
        learning = stage_name == 'learning'
        paid_grant = stage_name == 'paid-grant'
        paid_revoke = stage_name == 'paid-revoke'
        learner_access = stage_name == 'learner-access'
        lesson_entry = stage_name == 'lesson-entry'
        lesson_denial = stage_name == 'lesson-denial'
        assessment = stage_name == 'lesson-assessment'
        resume = stage_name == 'lesson-resume'
        restore = stage_name == 'lesson-restore'
        ack_loss = stage_name == 'lesson-ack-loss'
        exit_save = stage_name == 'lesson-exit-save'
        visibility = stage_name == 'lesson-visibility-save'
        stale_revision = stage_name == 'lesson-stale-revision'
        if restore:
            plan['initialEpoch'] = '7'
        active_epoch = str(int(plan['initialEpoch']) + 1)
        closed_epoch = str(int(active_epoch) + 1)
        read_only = learner_access or lesson_denial
        gateway_scoped = stage_name in window.SCOPED_GATEWAY_BROWSER_STAGES
        stage_status = stage_name.upper().replace('-', '_')
        paired = editing or reorder_kind is not None
        republishing = republish_outcome is not None
        published = (publication_outcome or republish_outcome) == 'published'
        reviewed = {'actorKind': actor_kind, 'actorId': actor}
        selection = {'actorKind': actor_kind, 'userId': user, 'operation': 'delete'}
        action = {'stage': stage_name, 'actorId': None if identity else actor, 'requests': [], 'windowSeconds': 60}
        if provider is not None:
            action['identityEnrollment'] = {'provider': provider, 'emailSha256': '7' * 64, 'nonce': '8' * 32}
        elif identity:
            action['identityActor'] = {**reviewed, 'sessionCount': 2} if identity_pair else reviewed
            if identity_pair:
                self.assertEqual(window.validate_interactive_action(action), action)
                for change in ({'actorKind': 'admin'}, {'sessionCount': True}, {'sessionCount': 2.0}, {'sessionCount': 3}):
                    wrong = {**action, 'identityActor': {**action['identityActor'], **change}}
                    with self.subTest(identity=change), self.assertRaisesRegex(ValueError, 'IDENTITY_ACTOR_REQUIRED'):
                        window.validate_interactive_action(wrong)
        elif lesson_entry:
            lesson = ledger_ids[0]
            action['lessonEntryAction'] = {'operation': 'open-lesson', 'courseId': command, 'lessonId': lesson,
                                           'grantId': ledger_ids[1]}
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', f'{student}/progress?courseId={command}', lesson_path,
                       f'{student}/progress?lessonId={lesson}', f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts',
                       f'{lesson_path}/playback')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': 2 if index == 0 else 1}
                                  for index, target in enumerate(targets)]
            action['requests'].append({'method': 'POST', 'target': f'{lesson_path}/progress',
                                       'bodySha256': window._hash(b'{"event":"lesson_started","expectedProgressRevision":0}'), 'uses': 1})
        elif lesson_denial:
            lesson = ledger_ids[0]
            action['lessonDenialAction'] = {'operation': 'deny-cross-account', 'courseId': command, 'lessonId': lesson,
                                            'enrolledActorId': user, 'grantId': ledger_ids[1]}
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', lesson_path, f'{student}/progress?lessonId={lesson}',
                       f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts', f'{lesson_path}/playback')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': uses}
                                  for target, uses in zip(targets, (2, 3, 3, 3, 3, 1))]
        elif assessment:
            lesson = ledger_ids[0]
            fail = [{'questionId': 'q2', 'optionId': 'wrong'}, {'questionId': 'q1', 'optionId': 'wrong'}]
            passed = [{'questionId': 'q2', 'optionId': 'correct'}, {'questionId': 'q1', 'optionId': 'correct'}]
            action['assessmentAction'] = {'operation': 'fail-then-pass', 'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1],
                                          'quizRevision': 4, 'failAnswers': fail, 'passAnswers': passed}
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', lesson_path, f'{student}/progress?lessonId={lesson}',
                       f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts', f'{lesson_path}/playback')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': 3 if index == 2 else 1}
                                  for index, target in enumerate(targets)]
            action['requests'].append({'method': 'POST', 'target': f'{lesson_path}/progress',
                                       'bodySha256': window._hash(b'{"event":"lesson_started","expectedProgressRevision":0}'), 'uses': 1})
            for answers in (fail, passed):
                body = json.dumps({'quizRevision': 4, 'answers': answers}, separators=(',', ':')).encode()
                action['requests'].append({'method': 'POST', 'target': f'{lesson_path}/quiz/attempts', 'bodySha256': window._hash(body), 'uses': 1})
        elif resume or restore:
            lesson = ledger_ids[0]
            selection = {'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1]}
            if restore:
                prior = {'actionId': 'owned-prior-resume', 'outcomeSha256': '5' * 64, 'progressId': ledger_ids[2], 'enrollmentId': user,
                         'resumePositionSeconds': 4, 'maxPositionSeconds': 14, 'playbackIdSha256': window._hash(b'owned-resume-playback'),
                         'playbackExpiresAt': '2026-11-07T00:03:00.000Z'}
                action['restoreAction'] = {**selection, 'operation': 'restore-resume', 'prior': prior}
            else:
                action['resumeAction'] = {**selection, 'operation': 'play-and-rewind'}
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', lesson_path, f'{student}/progress?lessonId={lesson}',
                       f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts', f'{lesson_path}/playback')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': 1} for target in targets]
            progress_bodies = [{'event': 'lesson_started', 'expectedProgressRevision': 4 if restore else 0}]
            if restore:
                progress_bodies.append({'resumePositionSeconds': 4, 'maxPositionSeconds': 14, 'expectedProgressRevision': 5})
            else:
                progress_bodies.extend({'expectedProgressRevision': revision} for revision in (1, 2, 3))
            action['requests'].extend({'method': 'POST', 'target': f'{lesson_path}/progress', 'uses': 1,
                                       'bodySha256': window._hash(json.dumps(body, separators=(',', ':')).encode())}
                                      for body in progress_bodies)
        elif ack_loss or stale_revision:
            lesson = ledger_ids[0]
            recovery_selection = {'operation': 'conflict-reload' if stale_revision else 'commit-drop-recover',
                             'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1],
                             'progressId': ledger_ids[2], 'enrollmentId': user, 'resumePositionSeconds': 4, 'maxPositionSeconds': 14,
                             'playbackIdSha256': window._hash(b'owned-resume-playback')}
            selection_key = 'staleRevisionAction' if stale_revision else 'ackLossAction'
            action[selection_key] = recovery_selection
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', lesson_path, f'{student}/progress?lessonId={lesson}',
                       f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts', f'{lesson_path}/playback')
            budgets = (3, 3, 4, 3, 3, 3) if stale_revision else (2, 2, 3, 2, 2, 2)
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': uses}
                                  for target, uses in zip(targets, budgets)]
            bodies = (b'{"event":"lesson_started","expectedProgressRevision":6}',
                      b'{"resumePositionSeconds":4,"maxPositionSeconds":14,"expectedProgressRevision":7}')
            if stale_revision:
                bodies += (b'{"event":"lesson_started","expectedProgressRevision":8}',
                           b'{"resumePositionSeconds":4,"maxPositionSeconds":14,"expectedProgressRevision":9}',
                           b'{"resumePositionSeconds":14,"maxPositionSeconds":14,"expectedProgressRevision":10}',
                           b'{"resumePositionSeconds":0,"maxPositionSeconds":14,"expectedProgressRevision":8}',
                           b'{"event":"lesson_started","expectedProgressRevision":11}',
                           b'{"resumePositionSeconds":14,"maxPositionSeconds":14,"expectedProgressRevision":12}')
            else:
                bodies += (b'{"resumePositionSeconds":14,"maxPositionSeconds":14,"expectedProgressRevision":8}',
                           b'{"event":"lesson_started","expectedProgressRevision":9}',
                           b'{"resumePositionSeconds":14,"maxPositionSeconds":14,"expectedProgressRevision":10}')
            action['requests'].extend({'method': 'POST', 'target': f'{lesson_path}/progress', 'uses': 1, 'bodySha256': window._hash(body)}
                                      for body in bodies)
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = (actor + command + lesson).replace('-', '')
            self.assertEqual(window._selection_sha(action), selector)
            material = ("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                        active_epoch, stage_name, 1794009600, 60, "9" * 32)
            cookie, key, _, _ = window._material(*material, selector)
            self.assertTrue(cookie.startswith(f'v2.{active_epoch}.{stage_name}.'))
            self.assertEqual(cookie.split('.')[-2], selector)
            self.assertRegex(key, r'^[0-9a-f]{64}$')
            if stale_revision:
                max_epoch_material = (*material[:4], "9" * 18, *material[5:])
                self.assertEqual(len(window._material(*max_epoch_material, selector)[0]), 260)
            with self.assertRaisesRegex(ValueError, 'FRONTEND_BINDING_REQUIRED'):
                window._material(*material, selector[:64])
            mutations = [(2, {'uses': 2}), (8, {'bodySha256': 'a' * 64}), (9, {'uses': 2})]
            if stale_revision:
                mutations.append((11, {'bodySha256': 'b' * 64}))
            for index, changes in mutations:
                wrong = copy.deepcopy(action)
                wrong['requests'][index].update(changes)
                with self.subTest(request=index), self.assertRaisesRegex(ValueError, f'{stage_status}_REQUESTS_REQUIRED'):
                    window.validate_interactive_action(wrong)
            for changes in ({'resumePositionSeconds': 7}, {'maxPositionSeconds': 14.0}, {'playbackIdSha256': '0' * 64}):
                wrong = {**action, selection_key: {**recovery_selection, **changes}}
                with self.subTest(selection=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_SELECTION_REQUIRED'):
                    window.validate_interactive_action(wrong)
        elif exit_save or visibility:
            lesson = ledger_ids[0]
            position_selection = {'operation': 'hide-active-document' if visibility else exit_operation,
                                  'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1],
                                  'progressId': ledger_ids[2], 'enrollmentId': user,
                                  'resumePositionSeconds': 4, 'maxPositionSeconds': 14,
                                  'playbackIdSha256': window._hash(b'owned-position-playback')}
            selection_key = 'visibilityAction' if visibility else 'exitSaveAction'
            action[selection_key] = position_selection
            student = '/course/v1/student'
            lesson_path = f'{student}/lessons/{lesson}'
            targets = (f'{student}/courses/{command}', lesson_path, f'{student}/progress?lessonId={lesson}',
                       f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts', f'{lesson_path}/playback')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY,
                                   'uses': 2 if exit_save and index == 0 else 1}
                                  for index, target in enumerate(targets)]
            bodies = (b'{"event":"lesson_started","expectedProgressRevision":6}',
                      b'{"resumePositionSeconds":4,"maxPositionSeconds":14,"expectedProgressRevision":7}',
                      b'{"expectedProgressRevision":8}')
            action['requests'].extend({'method': 'POST', 'target': f'{lesson_path}/progress', 'uses': 1, 'bodySha256': window._hash(body)}
                                      for body in bodies)
            outline_read = {'method': 'GET', 'target': f'{student}/progress?courseId={command}',
                            'bodySha256': window._EMPTY, 'uses': 1}
            if exit_save:
                action['requests'].append(outline_read)
            else:
                wrong = {**action, 'requests': [*action['requests'], outline_read]}
                with self.assertRaisesRegex(ValueError, 'LESSON_VISIBILITY_SAVE_REQUESTS_REQUIRED'):
                    window.validate_interactive_action(wrong)
            self.assertEqual(window.validate_interactive_action(action), action)
            selector = (actor + command + lesson).replace('-', '')
            self.assertEqual(window._selection_sha(action), selector)
            material = ("fixture" * 8, "https://owned.vercel.app", "a" * 40, "b" * 64,
                        active_epoch, stage_name, 1794009600, 60, "9" * 32)
            cookie, _, _, _ = window._material(*material, selector)
            self.assertTrue(cookie.startswith(f'v2.{active_epoch}.{stage_name}.'))
            self.assertEqual(cookie.split('.')[-2], selector)
            with self.assertRaisesRegex(ValueError, 'FRONTEND_BINDING_REQUIRED'):
                window._material(*material, selector[:64])
            mutations = [(0, {'uses': 2 if visibility else 1}), (8, {'bodySha256': 'a' * 64})]
            if exit_save:
                mutations.append((9, {'target': f'{student}/progress?courseId={user}'}))
            for index, changes in mutations:
                wrong = copy.deepcopy(action)
                wrong['requests'][index].update(changes)
                with self.subTest(request=index), self.assertRaisesRegex(ValueError, f'{stage_status}_REQUESTS_REQUIRED'):
                    window.validate_interactive_action(wrong)
            for changes in ({'operation': 'close-tab'}, {'resumePositionSeconds': 7},
                            {'maxPositionSeconds': 14.0}, {'playbackIdSha256': '0' * 64}):
                wrong = {**action, selection_key: {**position_selection, **changes}}
                with self.subTest(selection=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_SELECTION_REQUIRED'):
                    window.validate_interactive_action(wrong)
        elif learner_access:
            lesson = ledger_ids[0]
            action['learnerAccessAction'] = {'operation': 'observe-paid-access', 'courseId': command, 'lessonId': lesson,
                                             'grantId': ledger_ids[1], 'revision': 4, 'outcome': learner_outcome}
            course_path = f'/course/v1/student/courses/{command}'
            lesson_path = f'/course/v1/student/lessons/{lesson}'
            targets = (course_path, f'/course/v1/student/progress?courseId={command}', lesson_path, f'{lesson_path}/playback',
                       f'/course/v1/student/progress?lessonId={lesson}', f'{lesson_path}/quiz', f'{lesson_path}/quiz/attempts')
            action['requests'] = [{'method': 'GET', 'target': target, 'bodySha256': window._EMPTY, 'uses': 2 if index == 0 else 1}
                                  for index, target in enumerate(targets)]
        elif learning:
            operation = 'replay-free-enrollment' if replay else 'enroll-free-course'
            action['learningAction'] = {'operation': operation, 'courseId': command,
                                         'slug': 'owned-course', 'idempotencyKey': ledger_ids[0]}
            course = f'/course/v1/student/courses/{command}'
            detail = {'method': 'GET', 'target': course, 'bodySha256': window._EMPTY, 'uses': 1 if replay else 2}
            progress = {'method': 'GET', 'target': f'/course/v1/student/progress?courseId={command}', 'bodySha256': window._EMPTY, 'uses': 1}
            enroll = {'method': 'POST', 'target': f'{course}/enrollments',
                      'bodySha256': supervisor._canonical_sha({'idempotencyKey': ledger_ids[0]}), 'uses': 1}
            if replay:
                action['learningAction']['prior'] = {
                    'grantId': ledger_ids[0], 'enrollmentId': ledger_ids[1], 'eventId': ledger_ids[2],
                    'streamId': '70000000-0000-4000-8000-000000000001', 'canonicalDigest': '5' * 64,
                }
                action['requests'] = [detail, progress, enroll]
            else:
                action['requests'] = [{'method': 'GET', 'target': '/course/v1/courses/owned-course',
                                       'bodySha256': window._EMPTY, 'uses': 1}, detail, enroll, progress]
        elif paid_grant:
            action['paidGrantAction'] = {'operation': 'grant-paid-access', 'courseId': command, 'userId': user,
                                          'revision': 4, 'idempotencyKey': ledger_ids[0], 'reasonSha256': '8' * 64}
            prior_grant = {'priorGrantId': '70000000-0000-4000-8000-000000000003'} if second_paid else {}
            action['paidGrantAction'].update(prior_grant)
            entitlements = '/course/v1/admin/entitlements'
            query = f'idempotencyKey=owner-paid%3A{ledger_ids[0]}&limit=2'
            action['requests'] = [
                {'method': 'GET', 'target': f'/course/v1/admin/courses/{command}', 'bodySha256': window._EMPTY, 'uses': 3},
                {'method': 'GET', 'target': f'{entitlements}/commands?{query}', 'bodySha256': window._EMPTY, 'uses': 2},
                {'method': 'POST', 'target': f'{entitlements}/grants', 'bodySha256': '9' * 64, 'uses': 1},
                {'method': 'GET', 'target': f'{entitlements}/grants?userId={user}&courseId={command}&{query}',
                 'bodySha256': window._EMPTY, 'uses': 1}]
        elif paid_revoke:
            action['paidRevokeAction'] = {'operation': 'revoke-paid-grant', 'courseId': command, 'userId': user,
                                           'grantId': ledger_ids[1], 'revision': 4, 'idempotencyKey': ledger_ids[0],
                                           'reasonSha256': '8' * 64, 'remainingAccess': remaining_access}
            entitlements = '/course/v1/admin/entitlements'
            command_query = f'idempotencyKey=owner-paid-revoke%3A{ledger_ids[0]}&limit=2'
            grant_query = f'grantId={ledger_ids[1]}&userId={user}&courseId={command}&limit=2'
            action['requests'] = [
                {'method': 'GET', 'target': f'/course/v1/admin/courses/{command}', 'bodySha256': window._EMPTY, 'uses': 3},
                {'method': 'GET', 'target': f'{entitlements}/commands?{command_query}', 'bodySha256': window._EMPTY, 'uses': 2},
                {'method': 'GET', 'target': f'{entitlements}/grants?{grant_query}', 'bodySha256': window._EMPTY, 'uses': 2},
                {'method': 'POST', 'target': f'{entitlements}/revocations', 'bodySha256': '9' * 64, 'uses': 1}]
        elif authoring:
            if republishing:
                issue_codes = [] if published else ['MISSING_COVER', 'NO_LESSONS']
                action['authoringAction'] = {'operation': 'republish-paid-course', 'courseId': command, 'slug': 'owned-course',
                                             'revision': 3, 'userId': user, 'grantId': ledger_ids[0], 'outcome': republish_outcome,
                                             'issueCodes': issue_codes, 'expectedAccess': expected_access}
                path = f'/course/v1/admin/courses/{command}'
                action['requests'] = [
                    {'method': 'GET', 'target': path, 'bodySha256': window._EMPTY, 'uses': 3 if published else 2},
                    {'method': 'PATCH', 'target': path, 'uses': 1,
                     'bodySha256': supervisor._canonical_sha({'expectedRevision': 3, 'status': 'draft'})},
                    {'method': 'GET', 'target': f'{path}/publication-readiness', 'bodySha256': window._EMPTY, 'uses': 1}]
                if published:
                    action['requests'].append({'method': 'PATCH', 'target': path, 'uses': 1,
                                               'bodySha256': supervisor._canonical_sha({'expectedRevision': 4, 'status': 'published'})})
            elif archiving:
                action['authoringAction'] = {'operation': 'archive-paid-course', 'courseId': command, 'slug': 'owned-course',
                                             'revision': 3, 'userId': user, 'grantId': ledger_ids[0]}
                path = f'/course/v1/admin/courses/{command}'
                action['requests'] = [
                    {'method': 'GET', 'target': path, 'bodySha256': window._EMPTY, 'uses': 2},
                    {'method': 'PATCH', 'target': path, 'uses': 1,
                     'bodySha256': supervisor._canonical_sha({'expectedRevision': 3, 'status': 'archived'})}]
            elif quiz_revision is not None:
                document_sha = supervisor._canonical_sha({'questions': [{'id': 'reviewed', 'answers': ['yes', 'no']}]})
                lesson = ledger_ids[0]
                action['authoringAction'] = {'operation': 'save-quiz-revision', 'courseId': command, 'slug': 'owned-draft',
                                             'revision': 3, 'lessonId': lesson, 'quizRevision': quiz_revision,
                                             'documentSha256': document_sha}
                detail = f'/course/v1/admin/courses/{command}'
                quiz = f'/course/v1/admin/lessons/{lesson}/quiz'
                action['requests'] = [
                    {'method': 'GET', 'target': detail, 'bodySha256': window._EMPTY, 'uses': 2},
                    {'method': 'GET', 'target': quiz, 'bodySha256': window._EMPTY, 'uses': 1},
                    {'method': 'PUT', 'target': quiz, 'bodySha256': '9' * 64, 'uses': 1}]
            elif publication_outcome is not None:
                issue_codes = [] if published else ['MISSING_COVER', 'NO_LESSONS']
                action['authoringAction'] = {'operation': 'qualify-publication', 'courseId': command, 'slug': 'owned-draft',
                                             'revision': 3, 'outcome': publication_outcome, 'issueCodes': issue_codes}
                detail = f'/course/v1/admin/courses/{command}'
                action['requests'] = [
                    {'method': 'GET', 'target': detail, 'bodySha256': window._EMPTY, 'uses': 2 if published else 1},
                    {'method': 'GET', 'target': f'{detail}/publication-readiness', 'bodySha256': window._EMPTY, 'uses': 1}]
                if published:
                    digest = supervisor._canonical_sha({'expectedRevision': 3, 'status': 'published'})
                    action['requests'].append({'method': 'PATCH', 'target': detail, 'bodySha256': digest, 'uses': 1})
            elif create_kind is not None:
                parent = command if create_kind == 'module' else ledger_ids[0]
                action['authoringAction'] = {'operation': 'create-curriculum', 'slug': 'owned-draft', 'childSlug': 'owned-child',
                                             'courseId': command, 'revision': 3, 'kind': create_kind, 'parentId': parent}
                resource = f'/admin/courses/{command}/modules' if create_kind == 'module' else f'/admin/modules/{parent}/lessons'
                action['requests'] = [
                    {'method': 'GET', 'target': f'/course/v1/admin/courses/{command}', 'bodySha256': window._EMPTY, 'uses': 2},
                    {'method': 'POST', 'target': f'/course/v1{resource}', 'bodySha256': '9' * 64, 'uses': 1}]
            elif reorder_kind is not None:
                parent = command if reorder_kind == 'module' else ledger_ids[0]
                ordered_ids = [f'30000000-0000-4000-8000-{index:012d}'
                               for index in range(1, (1001 if reorder_kind == 'lesson' else 4))]
                action['authoringAction'] = {'operation': 'reorder-and-stale-curriculum', 'slug': 'owned-draft',
                                             'courseId': command, 'revision': 3, 'kind': reorder_kind, 'parentId': parent}
                resource = f'/admin/courses/{command}/modules/reorder' if reorder_kind == 'module' else f'/admin/modules/{parent}/lessons/reorder'
                action['requests'] = [{'method': 'GET', 'target': f'/course/v1/admin/courses/{command}', 'bodySha256': window._EMPTY, 'uses': 3},
                                      *[{'method': 'POST', 'target': f'/course/v1{resource}', 'uses': 1,
                                         'bodySha256': supervisor._canonical_sha({'expectedCourseRevision': 3, 'ids': ids})}
                                        for ids in (ordered_ids, list(reversed(ordered_ids)))]]
            elif editing:
                action['authoringAction'] = {'operation': 'edit-and-stale-draft', 'slug': 'owned-draft', 'courseId': command, 'revision': 3}
                action['requests'] = [{'method': method, 'target': f'/course/v1/admin/courses/{command}',
                                       'bodySha256': digest, 'uses': uses}
                                      for method, digest, uses in (('GET', window._EMPTY, 3), ('PATCH', '9' * 64, 1), ('PATCH', '8' * 64, 1))]
            else:
                action['authoringAction'] = {'operation': 'create-draft', 'slug': 'owned-draft'}
                action['requests'] = [
                    {'method': 'GET', 'target': '/course/v1/admin/courses?limit=100', 'bodySha256': window._EMPTY, 'uses': 1},
                    {'method': 'POST', 'target': '/course/v1/admin/courses', 'bodySha256': '9' * 64, 'uses': 1}]
        else:
            action['frontendAction'] = selection
        plan.update(mode='interactive-browser', scopedAction=action, nativePlan={'producer': {'role': {'oid': '22222'}}})
        source = Path(__file__).resolve().parents[3]
        recorder = migrate.read_input(source, window._BROWSER_SOURCE)
        initial.update(sourceSha256={window._BROWSER_SOURCE: migrate.file_hash(recorder)}, interactiveController={
            'challenge': '1' * 64, 'bindingSha256': plan['planSha256'],
            'browserProgramSha256': migrate.file_hash(recorder + window._BROWSER_LAUNCHER)})
        producer = migrate.file_hash(f'lash-her:p2q:interactive-producer:v1\n{plan["sourceCommit"]}\n{plan["targetSha256"]}'.encode())
        operation_ids = [*ledger_ids, '10000000-0000-4000-8000-000000000008'] if resume else ledger_ids[:2] if restore else ledger_ids
        if ack_loss:
            operation_ids = [*ledger_ids, '10000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000009']
        if stale_revision:
            operation_ids = [f'10000000-0000-4000-8000-{index:012d}' for index in range(5, 13)]
        operation_kinds = (('new-work',) * len(operation_ids)
                           if assessment or resume or restore or ack_loss or exit_save or visibility or stale_revision
                           else ('new-work', 'new-work', 'recovery'))
        ledger = {'commands': [], 'deliveries': [], 'orderViolations': [], 'operations': [
            {'id': identity, 'epoch': active_epoch, 'kind': kind, 'state': 'completed', 'producer_sha256': producer,
             'source_sha': plan['sourceCommit'], 'role_oid': '22222', 'completed_at': '2026-11-07T00:00:02.000Z',
             'reconciliation_sha256': None}
            for identity, kind in zip(operation_ids, operation_kinds)]}
        if read_only:
            unexpected_operation = ledger['operations'][0]
            ledger['operations'] = []
        if lesson_entry:
            unexpected_operation = ledger['operations'][1]
            ledger['operations'] = ledger['operations'][:1]
        browser = {'method': 'POST', 'pathname': f'/api/admin/customer-accounts/{user}/commands', 'status': 202,
                   'requestId': request, 'body': {'commandId': command, 'action': 'delete', 'accountVersion': 2, 'status': 'pending'}}
        domain = {'version': 1, 'status': 'P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED', **selection, 'actorId': actor,
                  'requestId': request, 'httpStatus': 202, 'baselineSha256': '2' * 64, 'frontendStatus': 'deleted',
                  'accountVersion': 2, 'sessionsBefore': 1, 'sessionsAfter': 0, 'learningUpdates': False, 'commandId': command,
                  'deliveries': [{'receiver': receiver, 'status': 'pending', 'attempts': 0} for receiver in ('course', 'community')],
                  'pendingOrDeliveringCount': 2, 'observedAt': '2026-11-07T00:00:02.000Z', 'readOnly': True}
        if identity:
            browser = {**reviewed, 'sessionVerified': True}
            domain = {**reviewed, 'actorActive': True, **({'ownerMappingVerified': True} if actor_kind == 'admin'
                      else {'liveSessionCount': 1})}
            if provider is not None:
                domain.update(provider=provider, providerLinkCount=1 if provider == 'google' else 0)
            if identity_pair:
                browser['sessionProofs'] = ['4' * 64, '5' * 64]
                domain.update(sessionCount=2, liveSessionCount=3, verifiedFreshSessionCount=2)
            browser_key, domain_key = 'browserIdentity', 'identityWitness'
        elif lesson_entry:
            indices = (1, 0, 5, 4, 3, 2, 0, 7, 6) if progress_first else (0, 1, 0, 2, 3, 4, 5, 6, 7)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 200}
                for position, index in enumerate(indices, 1)]
            requests_by_index = {row['requestIndex']: row['requestId'] for row in acknowledgements}
            playback_expiry, thumbnail_expiry = '2026-11-07T00:10:00.000Z', '2026-11-07T00:10:00.250Z'
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'flight': True},
                       'playback': {'requestId': requests_by_index[6], 'expiresAt': playback_expiry,
                                    'thumbnailExpiresAt': thumbnail_expiry, 'lifetimeMs': 600_000},
                       'progress': {'requestId': requests_by_index[7], 'progressId': ledger_ids[2],
                                    'enrollmentId': user, 'revision': 1}}
            domain = {'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1], 'actorId': actor,
                      'enrollmentId': user, 'progressId': ledger_ids[2], 'revision': 1,
                      'playbackExpiresAt': thumbnail_expiry, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif lesson_denial:
            render_indices = (4, 3, 2, 1, 0) if progress_first else (0, 1, 2, 3, 4)
            indices = render_indices * 2 + (1, 5, 2, 3, 4)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 403}
                for position, index in enumerate(indices, 1)]
            paths = [targets[index].replace('/course/v1/student', '/api/academy') for index in (1, 5, 2, 3, 4)]
            document_id = next(row['requestId'] for row in acknowledgements[:5] if row['requestIndex'] == 0)
            flight_id = next(row['requestId'] for row in acknowledgements[5:10] if row['requestIndex'] == 0)
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'documentStatus': 200,
                                'flightStatus': 200, 'documentRequestId': document_id, 'flightRequestId': flight_id},
                       'reads': [{'target': path, 'status': 403, 'requestId': ack['requestId'], 'code': 'access_required'}
                                 for path, ack in zip(paths, acknowledgements[10:])]}
            domain = {'courseId': command, 'lessonId': lesson, 'actorId': actor, 'enrolledActorId': user,
                      'grantId': ledger_ids[1], 'effectiveAccess': False, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif assessment:
            indices = (4, 3, 2, 1, 0, 6, 5, 7, 2, 8, 2) if progress_first else (0, 1, 2, 3, 4, 5, 6, 7, 2, 8, 2)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 404 if index == 5 else 200}
                for position, index in enumerate(indices, 1)]
            requests_by_index = {row['requestIndex']: row['requestId'] for row in acknowledgements[5:7]}
            attempts = []
            for index, passed in enumerate((False, True)):
                created = f'2026-11-07T00:10:0{index}.000Z'
                attempts.append({'requestId': acknowledgements[7 + index * 2]['requestId'],
                                 'payloadRequestId': f'50000000-0000-4000-8000-{index:012d}',
                                 'attemptId': f'60000000-0000-4000-8000-{index:012d}', 'quizRevisionId': request,
                                 'quizRevision': 4, 'correctCount': 2 if passed else 0, 'totalCount': 2,
                                 'passed': passed, 'completed': passed, 'createdAt': created,
                                 'progress': {'requestId': acknowledgements[8 + index * 2]['requestId'], 'progressId': ledger_ids[2],
                                              'enrollmentId': user, 'revision': 2 + index, 'completedAt': created if passed else None,
                                              'completedQuizRevision': 4 if passed else None}})
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'status': 200},
                       'playback': {'requestId': requests_by_index[5], 'status': 404},
                       'started': {'requestId': requests_by_index[6], 'progressId': ledger_ids[2], 'enrollmentId': user, 'revision': 1},
                       'attempts': attempts}
            domain = {'actorId': actor, 'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1], 'quizRevision': 4,
                      'enrollmentId': user, 'progressId': ledger_ids[2], 'attemptIds': [row['attemptId'] for row in attempts],
                      'progressRevision': 3, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif resume or restore:
            indices = (4, 3, 2, 1, 0, 6, 5, 7, 8, 9) if progress_first else tuple(range(10))
            if restore:
                indices = indices[:8]
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 200}
                for position, index in enumerate(indices, 1)]
            requests_by_index = {row['requestIndex']: row['requestId'] for row in acknowledgements[5:]}
            expires, thumbnail_expires = '2026-11-07T00:10:00.000Z', '2026-11-07T00:10:01.000Z'
            playback_id_sha = window._hash(b'owned-resume-playback')
            writes = [{'requestId': requests_by_index[7 + index], 'expectedProgressRevision': index + 1, 'revision': index + 2,
                       'resumePositionSeconds': position, 'submittedMaxPositionSeconds': submitted,
                       'maxPositionSeconds': max(position, submitted)}
                      for index, (position, submitted) in enumerate(((10, 10), (14, 13), (4, 14)))] if resume else []
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'status': 200},
                       'playback': {'requestId': requests_by_index[5], 'expiresAt': expires, 'thumbnailExpiresAt': thumbnail_expires,
                                    'lifetimeMs': 600_000, 'playbackIdSha256': playback_id_sha},
                       'started': {'requestId': requests_by_index[6], 'progressId': ledger_ids[2], 'enrollmentId': user, 'revision': 1},
                       'writes': writes, 'media': {'durationSeconds': 32, 'videoWidth': 128, 'heartbeatSeconds': 11,
                                                  'pausedSeconds': 14, 'rewoundSeconds': 4,
                                                  'manifestObserved': True, 'segmentObserved': True}}
            domain = {'actorId': actor, 'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1],
                      'enrollmentId': user, 'progressId': ledger_ids[2], 'revision': 4, 'resumePositionSeconds': 4,
                      'maxPositionSeconds': 14, 'playbackExpiresAt': thumbnail_expires, 'playbackIdSha256': playback_id_sha, 'readOnly': True}
            if restore:
                browser['started']['revision'] = 5
                browser['restored'] = {**browser['started'], 'requestId': requests_by_index[7], 'revision': 6,
                                       'resumePositionSeconds': 4, 'maxPositionSeconds': 14}
                del browser['writes']
                browser['media'] = {'durationSeconds': 32, 'videoWidth': 128, 'restoredSeconds': 4, 'paused': True,
                                    'manifestObserved': True, 'segmentObserved': True}
                domain['revision'] = 6
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif stale_revision:
            opening = (4, 3, 2, 1, 0) if progress_first else (0, 1, 2, 3, 4)
            def hydration(start, restore):
                startup = (start, 5) if progress_first else (5, start)
                return opening + startup + (restore,)
            indices = hydration(6, 7) + hydration(8, 9) + (10, 11, 2) + hydration(12, 13)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 409 if index == 11 else 200}
                for position, index in enumerate(indices, 1)]
            playback_ids = [row['requestId'] for row in acknowledgements if row['requestIndex'] == 5]
            progress_gateway_ids = [row['requestId'] for row in acknowledgements if row['requestIndex'] in (6, 7, 8, 9, 10, 12, 13)]
            conflict_gateway_id, authoritative_gateway_id = (row['requestId'] for row in acknowledgements[17:19])
            writes = [{'requestId': request_id, 'progressId': ledger_ids[2], 'enrollmentId': user, 'revision': revision,
                       'resumePositionSeconds': 4 if revision < 11 else 14, 'maxPositionSeconds': 14}
                      for revision, request_id in enumerate(progress_gateway_ids, 7)]
            playback = [{'requestId': identity, 'expiresAt': f'2026-11-07T00:10:{index * 7:02d}.000Z',
                         'thumbnailExpiresAt': f'2026-11-07T00:10:{index * 7:02d}.250Z', 'lifetimeMs': 600_000,
                         'playbackIdSha256': recovery_selection['playbackIdSha256']}
                        for index, identity in enumerate(playback_ids)]
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'status': 200},
                       'playback': playback, 'writes': writes,
                       'conflict': {'requestId': conflict_gateway_id, 'expectedProgressRevision': 8,
                                    'resumePositionSeconds': 0, 'maxPositionSeconds': 14, 'status': 409},
                       'authoritative': {**writes[4], 'requestId': authoritative_gateway_id},
                       'reload': {'documentReplaced': True, 'noReplay': True},
                       'media': {'beforeSeconds': 4, 'afterSeconds': 14, 'paused': True, 'manifestObserved': True,
                                 'segmentObserved': True}}
            domain = {**{key: value for key, value in recovery_selection.items() if key != 'operation'}, 'actorId': actor,
                      'revision': 13, 'resumePositionSeconds': 14, 'playbackExpiresAt': playback[-1]['thumbnailExpiresAt'],
                      'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif ack_loss:
            opening = (4, 3, 2, 1, 0, 6, 5) if progress_first else tuple(range(7))
            reloading = (3, 2, 4, 1, 0, 9, 5) if progress_first else (0, 1, 2, 3, 4, 5, 9)
            indices = opening + (7, 8, 2) + reloading + (10,)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 200}
                for position, index in enumerate(indices, 1)]
            playback_ids = [row['requestId'] for row in acknowledgements if row['requestIndex'] == 5]
            progress_gateway_ids = [row['requestId'] for row in acknowledgements if row['requestIndex'] >= 6]
            recovery_gateway_id = acknowledgements[9]['requestId']
            writes = [{'requestId': request_id, 'progressId': ledger_ids[2], 'enrollmentId': user, 'revision': revision,
                       'resumePositionSeconds': 4 if revision < 9 else 14, 'maxPositionSeconds': 14}
                      for revision, request_id in enumerate(progress_gateway_ids, 7)]
            expiry = '2026-11-07T00:10:08.000Z'
            browser = {'page': {'pathname': f'/academy/courses/{command}/lessons/{lesson}', 'status': 200},
                       'playback': [{'requestId': identity, 'expiresAt': f'2026-11-07T00:10:0{index * 7}.000Z',
                                     'thumbnailExpiresAt': f'2026-11-07T00:10:0{index * 7 + 1}.000Z', 'lifetimeMs': 600_000,
                                     'playbackIdSha256': recovery_selection['playbackIdSha256']}
                                    for index, identity in enumerate(playback_ids)],
                       'writes': writes,
                       'recovery': {**writes[2], 'requestId': recovery_gateway_id, 'browserFailure': 'connectionreset',
                                    'unconfirmedObserved': True, 'noReplay': True},
                       'media': {'beforeSeconds': 4, 'afterSeconds': 14, 'paused': True, 'manifestObserved': True,
                                 'segmentObserved': True}}
            domain = {**{key: value for key, value in recovery_selection.items() if key != 'operation'}, 'actorId': actor,
                      'revision': 11, 'resumePositionSeconds': 14, 'playbackExpiresAt': expiry, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif exit_save or visibility:
            opening = (4, 3, 2, 1, 0, 6, 5) if progress_first else tuple(range(7))
            final = (8,) if visibility else (9, 8, 0) if progress_first else (0, 8, 9)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': 200}
                for position, index in enumerate(opening + (7,) + final, 1)
            ]
            requests_by_index = {row['requestIndex']: row['requestId'] for row in acknowledgements[5:]}
            writes = [{'requestId': requests_by_index[index], 'progressId': ledger_ids[2], 'enrollmentId': user, 'revision': index + 1,
                       'resumePositionSeconds': 7 if index == 8 else 4, 'maxPositionSeconds': 14}
                      for index in ((6, 7, 8) if visibility else (6, 7))]
            destination = f'/academy/courses/{command}'
            same_document = visibility or exit_operation == 'spa-navigation'
            receipt_key = 'visibility' if visibility else 'exit'
            position_receipt = {'sameDocument': same_document, 'trustedPagehide': not same_document,
                                'trustedHidden': visibility or not same_document, 'resumePositionSeconds': 7,
                                'maxPositionSeconds': 14, 'expectedProgressRevision': 8}
            if exit_save:
                position_receipt.update(pathname=destination, status=200)
            expiry = '2026-11-07T00:10:01.000Z'
            browser = {'page': {'pathname': f'{destination}/lessons/{lesson}', 'status': 200},
                       'playback': {'requestId': requests_by_index[5], 'expiresAt': '2026-11-07T00:10:00.000Z',
                                    'thumbnailExpiresAt': expiry, 'lifetimeMs': 600_000,
                                    'playbackIdSha256': position_selection['playbackIdSha256']},
                       'writes': writes,
                       receipt_key: position_receipt,
                       'media': {'playedSeconds': 7, 'playing': True, 'manifestObserved': True, 'segmentObserved': True}}
            domain = {**{key: value for key, value in position_selection.items() if key != 'operation'}, 'actorId': actor,
                      'revision': 9, 'resumePositionSeconds': 7, 'playbackExpiresAt': expiry, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif learner_access:
            allowed = learner_outcome == 'allowed'
            status, codes = {'allowed': (200, (None,)), 'archived': (410, ('course_archived',)),
                             'draft': (404, ('not_found',)), 'restricted': (403, ('access_required', 'access_revoked'))}[learner_outcome]
            indices = (1, 0, 0, 2, 3, 4, 5, 6) if progress_first else (0, 1, 0, 2, 3, 4, 5, 6)
            acknowledgements = [
                {'requestId': f'70000000-0000-4000-8000-{position:012d}', 'proofRequestId': f'80000000-0000-4000-8000-{position:012d}',
                 'requestIndex': index, 'upstreamStatus': status}
                for position, index in enumerate(indices, 1)]
            paths = [targets[index].replace('/course/v1/student', '/api/academy') for index in (0, 2, 3, 4, 5, 6)]
            observed = {'courseId': command, 'lessonId': lesson, 'outcome': learner_outcome}
            browser = {'page': {'pathname': f'/academy/courses/{command}', 'status': 200, 'lessonLink': allowed},
                       'reads': [{'target': path, 'status': status, 'requestId': ack['requestId'], 'code': codes[index % len(codes)]}
                                 for index, (path, ack) in enumerate(zip(paths, acknowledgements[2:]))], 'body': observed}
            domain = {**observed, 'actorId': actor, 'grantId': ledger_ids[1], 'revision': 4, 'effectiveAccess': allowed, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
        elif learning:
            academy = f'/academy/courses/{command}'
            enrolled = {'courseId': command, 'grantId': ledger_ids[0], 'enrollmentId': ledger_ids[1],
                        'source': 'free', 'status': 'active', 'idempotentReplay': replay}
            browser = {'method': 'POST', 'pathname': f'/api{academy}/enrollments', 'status': 200, 'requestId': request,
                       'academyPath': academy, 'body': enrolled}
            community_delivery = {
                'streamId': '70000000-0000-4000-8000-000000000001', 'streamVersion': 1, 'eventId': ledger_ids[2],
                'canonicalDigest': '5' * 64, 'state': 'active',
            }
            domain = {**enrolled, 'transitionId': ledger_ids[2], 'communityDelivery': community_delivery, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
            observed_indices = ((1, 0, 2) if progress_first else (0, 1, 2)) if replay else (
                (0, 1, 2, 3, 1) if progress_first else (0, 1, 2, 1, 3))
            requests = [user, ledger_ids[0], request] if replay else [user, *ledger_ids[:1], request, *ledger_ids[1:]]
            statuses = (200, 200, 200) if replay else (200, 403, 201, 200, 200)
            proofs = [f'40000000-0000-4000-8000-{index:012d}' for index in range(1, len(observed_indices) + 1)]
            acknowledgements = [
                {'requestId': identity, 'proofRequestId': proof, 'requestIndex': index, 'upstreamStatus': status}
                for identity, proof, index, status in zip(
                    requests, proofs, observed_indices, statuses)]
        elif paid_grant:
            granted = {'courseId': command, 'userId': user, 'commandId': ledger_ids[0], 'grantId': ledger_ids[1],
                       'courseRevision': 4}
            pathname = f'/api/admin/courses/{command}/manual-grants'
            browser = {'method': 'POST', 'pathname': pathname, 'status': 200, 'requestId': request, 'body': granted}
            proofs = [f'50000000-0000-4000-8000-{index:012d}' for index in range(1, 8)]
            community_delivery = {
                'streamId': '70000000-0000-4000-8000-000000000001', 'streamVersion': 1,
                'eventId': '70000000-0000-4000-8000-000000000002' if second_paid else proofs[0],
                'canonicalDigest': '5' * 64, 'state': 'active',
            }
            domain = {**granted, 'enrollmentId': ledger_ids[2], 'transitionId': None if second_paid else proofs[0],
                      **prior_grant, 'communityDelivery': community_delivery, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
            acknowledgements = [
                {'requestId': identity, 'proofRequestId': proof, 'requestIndex': index, 'upstreamStatus': status}
                for identity, proof, index, status in zip(
                    [actor, user, command, request, *ledger_ids], proofs, (0, 1, 0, 2, 1, 3, 0), (200, 200, 200, 201, 200, 200, 200))]
        elif paid_revoke:
            revoked = {'courseId': command, 'userId': user, 'grantId': ledger_ids[1], 'commandId': ledger_ids[0], 'courseRevision': 4}
            pathname = f'/api/admin/courses/{command}/manual-grants/revoke'
            browser = {'method': 'POST', 'pathname': pathname, 'status': 200, 'requestId': request, 'body': revoked}
            community_delivery = {
                'streamId': '70000000-0000-4000-8000-000000000001', 'streamVersion': 1 if remaining_access else 2,
                'eventId': '70000000-0000-4000-8000-000000000002' if remaining_access else ledger_ids[2],
                'canonicalDigest': '5' * 64, 'state': 'active' if remaining_access else 'revoked',
                'independentActiveCount': 2, 'independentActiveSha256': '7' * 64,
            }
            domain = {**revoked, 'remainingAccess': remaining_access, 'transitionId': None if remaining_access else ledger_ids[2],
                      'communityDelivery': community_delivery, 'readOnly': True}
            browser_key, domain_key = 'browserResponse', 'courseWitness'
            acknowledgements = [
                {'requestId': request if index == 3 else f'80000000-0000-4000-8000-{position:012d}',
                 'proofRequestId': f'90000000-0000-4000-8000-{position:012d}', 'requestIndex': index, 'upstreamStatus': 200}
                for position, index in enumerate((0, 1, 0, 2, 3, 1, 2, 0), 1)]
        elif authoring:
            draft = ({'courseId': command, 'parentId': parent, 'kind': reorder_kind, 'revision': 4, 'ids': ordered_ids}
                     if reorder_kind is not None else
                     {'courseId': command, 'slug': 'owned-draft', 'revision': 4 if editing else 1, 'status': 'draft'})
            if create_kind is not None:
                draft = {'courseId': command, 'parentId': parent, 'kind': create_kind, 'revision': 4,
                         'itemId': ledger_ids[1], 'slug': 'owned-child'}
            if publication_outcome is not None:
                draft = {'courseId': command, 'slug': 'owned-draft', 'revision': 4 if published else 3,
                         'status': 'published' if published else 'draft', 'issueCodes': issue_codes}
            if quiz_revision is not None:
                draft = {'courseId': command, 'slug': 'owned-draft', 'lessonId': lesson, 'quizId': ledger_ids[1],
                         'revision': 4, 'quizRevision': quiz_revision + 1, 'documentSha256': document_sha}
            if archiving:
                draft = {'courseId': command, 'slug': 'owned-course', 'revision': 4, 'status': 'archived'}
            if republishing:
                draft = {'courseId': command, 'slug': 'owned-course', 'revision': 5 if published else 4,
                         'status': 'published' if published else 'draft', 'issueCodes': issue_codes}
            domain = {**draft, 'readOnly': True}
            domain_key = 'courseWitness'
            if republishing:
                browser_key = 'browserResponse'
                detail = f'/api/admin/courses/{command}'
                browser = {'draft': {'method': 'PATCH', 'pathname': detail, 'status': 200, 'requestId': request},
                           'readiness': {'method': 'GET', 'pathname': f'{detail}/publication-readiness',
                                         'status': 200, 'requestId': user}, 'body': draft}
                domain.update(userId=user, grantId=ledger_ids[0], historyPreserved=True, effectiveAccess=published and expected_access)
                indices = [0, 1, 0, 2]
                requests = [ledger_ids[0], request, ledger_ids[1], user]
                if published:
                    browser['publication'] = {'method': 'PATCH', 'pathname': detail, 'status': 200, 'requestId': ledger_ids[2]}
                    indices += [3, 0]
                    requests += [ledger_ids[2], actor]
                acknowledgements = [
                    {'requestId': identity, 'proofRequestId': f'60000000-0000-4000-8000-{position:012d}',
                     'requestIndex': index, 'upstreamStatus': 200}
                    for position, (identity, index) in enumerate(zip(requests, indices), 1)]
            elif archiving:
                browser_key = 'browserResponse'
                browser = {'method': 'PATCH', 'pathname': f'/api/admin/courses/{command}', 'status': 200, 'requestId': request,
                           'body': draft, 'warningObserved': True, 'cancelObservedWithoutMutation': True}
                domain.update(userId=user, grantId=ledger_ids[0], historyPreserved=True)
                acknowledgements = [
                    {'requestId': user, 'proofRequestId': actor, 'requestIndex': 0, 'upstreamStatus': 200},
                    {'requestId': request, 'proofRequestId': command, 'requestIndex': 1, 'upstreamStatus': 200},
                    {'requestId': ledger_ids[1], 'proofRequestId': ledger_ids[2], 'requestIndex': 0, 'upstreamStatus': 200}]
            elif quiz_revision is not None:
                path = f'/api/admin/lessons/{lesson}/quiz'
                prior_status = 404 if quiz_revision == 0 else 200
                browser_key = 'browserResponse'
                browser = {
                    'prior': {'method': 'GET', 'pathname': path, 'status': prior_status, 'requestId': user},
                    'save': {'method': 'PUT', 'pathname': path, 'status': 200, 'requestId': request}, 'body': draft}
                acknowledgements = [
                    {'requestId': ledger_ids[0], 'proofRequestId': actor, 'requestIndex': 0, 'upstreamStatus': 200},
                    {'requestId': user, 'proofRequestId': ledger_ids[1], 'requestIndex': 1, 'upstreamStatus': prior_status},
                    {'requestId': request, 'proofRequestId': command, 'requestIndex': 2, 'upstreamStatus': 200},
                    {'requestId': ledger_ids[2], 'proofRequestId': ledger_ids[0], 'requestIndex': 0, 'upstreamStatus': 200}]
            elif publication_outcome is not None:
                detail = f'/api/admin/courses/{command}'
                browser_key = 'browserResponse'
                browser = {'readiness': {'method': 'GET', 'pathname': f'{detail}/publication-readiness',
                                         'status': 200, 'requestId': user}, 'body': draft}
                acknowledgements = [
                    {'requestId': ledger_ids[0], 'proofRequestId': actor, 'requestIndex': 0, 'upstreamStatus': 200},
                    {'requestId': user, 'proofRequestId': ledger_ids[1], 'requestIndex': 1, 'upstreamStatus': 200}]
                if published:
                    browser['publication'] = {'method': 'PATCH', 'pathname': detail, 'status': 200, 'requestId': request}
                    acknowledgements += [
                        {'requestId': request, 'proofRequestId': command, 'requestIndex': 2, 'upstreamStatus': 200},
                        {'requestId': ledger_ids[2], 'proofRequestId': ledger_ids[0], 'requestIndex': 0, 'upstreamStatus': 200}]
            elif paired:
                detail, method = (f'/api{resource}', 'POST') if reorder_kind is not None else (f'/api/admin/courses/{command}', 'PATCH')
                winner_extra = {'keyboardActivated': True} if reorder_kind is not None else {}
                stale_extra = winner_extra or {'dirtyInputPreserved': True}
                browser = {
                    'winner': {'method': method, 'pathname': detail, 'status': 200, 'requestId': request, 'body': draft, **winner_extra},
                    'stale': {'method': method, 'pathname': detail, 'status': 409, 'requestId': user, 'outcome': 'conflict', **stale_extra}}
                browser_key = 'browserResponses'
                acknowledgement_ids = [f'20000000-0000-4000-8000-{index:012d}' for index in range(1, 9)]
                acknowledgements = [
                    {'requestId': identity, 'proofRequestId': proof, 'requestIndex': index, 'upstreamStatus': status}
                    for identity, proof, index, status in zip(
                        [*acknowledgement_ids[:2], request, acknowledgement_ids[2], user], acknowledgement_ids[3:],
                        (0, 0, 1, 0, 2), (200, 200, 200, 200, 409))]
            else:
                pathname = f'/api{resource}' if create_kind is not None else '/api/admin/courses'
                browser = {'method': 'POST', 'pathname': pathname, 'status': 200, 'requestId': request, 'body': draft}
                browser_key = 'browserResponse'
                acknowledgements = [
                    {'requestId': user, 'proofRequestId': actor, 'requestIndex': 0, 'upstreamStatus': 200},
                    {'requestId': request, 'proofRequestId': ledger_ids[0], 'requestIndex': 1, 'upstreamStatus': 201}]
                if create_kind is not None:
                    acknowledgements.append({'requestId': ledger_ids[2], 'proofRequestId': ledger_ids[1],
                                             'requestIndex': 0, 'upstreamStatus': 200})
        else:
            browser_key, domain_key = 'browserResponse', 'lifecycleWitness'
        if gateway_scoped:
            gateway_artifact = {**window.browser_receipt(plan, 'GATEWAY_OBSERVED'), 'epoch': active_epoch, 'gatewayActive': 0,
                                'gatewayUncertain': 0, 'gatewayStateSha256': '7' * 64, 'gatewayAcknowledgements': acknowledgements}
            migrate.write_json(directory, window.browser_artifact(plan, 'gateway'), gateway_artifact)
        evidence = {browser_key: browser, domain_key: domain}
        closed = {'epoch': closed_epoch, 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
        gateway_fence = {'gatewayAdmissionClosed': True, 'gatewayActive': 0, 'gatewayUncertain': 0}
        broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
        stage = window.P2InteractiveWindow.__new__(window.P2InteractiveWindow)
        stage.plan, stage.action, stage.broker, stage._permit_issued = plan, plan['scopedAction'], broker, False
        stage.verify_gateway_fenced = lambda: gateway_fence
        broker.initial, broker.scoped_stage, broker.directory = initial, stage, directory
        broker.scoped_case = broker.closing_at = None
        broker.external_armed = broker.guard_arm_verified = True
        broker.check = lambda: None
        broker.observer = SimpleNamespace(probe=lambda _: {'admission': closed, 'witness': ledger})
        calls = []
        broker.send = lambda identity, status, **data: calls.append({'id': identity, 'status': status, **data})
        permit = {'stage': stage_name, 'epoch': active_epoch, 'expires': 1794009630, 'cookie': 'private-fixture-only'}
        stage.take_private_browser_permit = lambda: permit
        envelope = {'id': 1, 'controllerChallenge': initial['interactiveController']['challenge']}
        with self.assertRaisesRegex(ValueError, 'FIXED_CONTROLLER_OPERATION_REQUIRED'):
            broker.command({**envelope, 'operation': 'interactive-permit', 'callerTask': 'refused'})
        with self.assertRaisesRegex(ValueError, 'FIXED_CONTROLLER_OPERATION_REQUIRED'):
            broker.command({**envelope, 'operation': 'interactive-permit', 'controllerChallenge': 'wrong'})
        broker.command({**envelope, 'operation': 'interactive-permit'})
        self.assertEqual(calls.pop(), {'id': 1, 'status': 'CERTIFICATION_INTERACTIVE_PRIVATE', 'permit': permit})
        with self.assertRaisesRegex(ValueError, f'{stage_status}_PERMIT_REQUIRED'):
            broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        stage._permit_issued = True
        witness_error = f'{stage_status}_COURSE_WITNESS_REQUIRED' if gateway_scoped else f'{stage_status}_WITNESS_REQUIRED'
        with self.assertRaisesRegex(ValueError, witness_error):
            broker.command({**envelope, 'operation': 'interactive-retain',
                            'caseEvidence': {**evidence, domain_key: {**domain, 'actorId': user}}})
        if identity_pair:
            for proofs in (['4' * 64] * 2, ['0' * 64, '5' * 64], ['4' * 64], '4' * 64):
                wrong = {**browser, 'sessionProofs': proofs}
                with self.subTest(proofs=proofs), self.assertRaisesRegex(ValueError, 'IDENTITY_DISTINCT_SESSIONS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: wrong}})
            for changes in ({'verifiedFreshSessionCount': 1}, {'liveSessionCount': 1}, {'sessionCount': 2.0}):
                with self.subTest(witness=changes), self.assertRaisesRegex(ValueError, 'IDENTITY_PAIR_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **changes}}})
        if lesson_entry:
            invalid = (('page', {'flight': 1}, 'PAGE'),
                       ('playback', {'requestId': requests_by_index[7]}, 'PLAYBACK'),
                       ('playback', {'lifetimeMs': 600_751}, 'PLAYBACK'),
                       ('playback', {'expiresAt': '2026-02-30T00:10:00.000Z'}, 'PLAYBACK'),
                       ('playback', {'token': 'fixture-forbidden'}, 'PLAYBACK'),
                       ('progress', {'requestId': requests_by_index[6]}, 'PROGRESS'),
                       ('progress', {'revision': True}, 'PROGRESS'))
            for part, change, error in invalid:
                with self.subTest(part=part, change=change), self.assertRaisesRegex(ValueError, f'LESSON_ENTRY_{error}_REQUIRED'):
                    wrong = {**browser, part: {**browser[part], **change}}
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'playbackExpiresAt': playback_expiry}, {'progressId': request}, {'grantId': request}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'LESSON_ENTRY_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if lesson_denial:
            for change in ({'flightStatus': 403}, {'documentRequestId': flight_id, 'flightRequestId': document_id},
                           {'documentRequestId': browser['reads'][0]['requestId']}):
                wrong = {**browser, 'page': {**browser['page'], **change}}
                with self.subTest(page=change), self.assertRaisesRegex(ValueError, 'LESSON_DENIAL_PAGE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'code': 'access_revoked'}, {'status': 200}, {'requestId': browser['reads'][1]['requestId']}):
                wrong = {**browser, 'reads': [{**browser['reads'][0], **change}, *browser['reads'][1:]]}
                with self.subTest(read=change), self.assertRaisesRegex(ValueError, 'LESSON_DENIAL_READS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'enrolledActorId': actor}, {'grantId': user}, {'effectiveAccess': 0}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'LESSON_DENIAL_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if assessment:
            invalid_attempts = (({'payloadRequestId': attempts[0]['payloadRequestId']}, 'ATTEMPTS'),
                                ({'createdAt': '2026-02-30T00:10:00.000Z'}, 'ATTEMPTS'),
                                ({'completed': False}, 'ATTEMPTS'), ({'quizRevision': True}, 'ATTEMPTS'),
                                ({'progress': {**attempts[1]['progress'], 'completedAt': None}}, 'PROGRESS'),
                                ({'progress': {**attempts[1]['progress'], 'requestId': attempts[0]['progress']['requestId']}}, 'PROGRESS'))
            for change, error in invalid_attempts:
                wrong = {**browser, 'attempts': [attempts[0], {**attempts[1], **change}]}
                with self.subTest(attempt=change), self.assertRaisesRegex(ValueError, f'LESSON_ASSESSMENT_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'attemptIds': list(reversed(domain['attemptIds']))}, {'progressRevision': 2}, {'quizRevision': True}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'LESSON_ASSESSMENT_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if restore:
            for part, changes, error in (
                ('playback', {'expiresAt': prior['playbackExpiresAt'], 'thumbnailExpiresAt': prior['playbackExpiresAt']}, 'PLAYBACK'),
                ('playback', {'playbackIdSha256': 'a' * 64}, 'PLAYBACK'),
                ('started', {'requestId': requests_by_index[5]}, 'STARTED'),
                ('restored', {'maxPositionSeconds': 4}, 'PROGRESS'),
                ('restored', {'revision': 6.0}, 'PROGRESS'),
                ('media', {'paused': False}, 'MEDIA'),
                ('media', {'restoredSeconds': 14}, 'MEDIA'),
            ):
                wrong = {**browser, part: {**browser[part], **changes}}
                with self.subTest(part=part, changes=changes), self.assertRaisesRegex(ValueError, f'LESSON_RESTORE_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
        if ack_loss:
            hydration_read = next(row['requestId'] for row in acknowledgements[:5] if row['requestIndex'] == 2)
            for part, changes, error in (
                ('recovery', {'requestId': hydration_read}, 'RECOVERY'),
                ('recovery', {'noReplay': False}, 'RECOVERY'),
                ('recovery', {'unconfirmedObserved': 1}, 'RECOVERY'),
                ('recovery', {'revision': 10}, 'RECOVERY'),
                ('media', {'afterSeconds': 4}, 'MEDIA'),
            ):
                wrong = {**browser, part: {**browser[part], **changes}}
                with self.subTest(part=part, changes=changes), self.assertRaisesRegex(ValueError, f'LESSON_ACK_LOSS_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for part, rows, error in (
                ('playback', list(reversed(browser['playback'])), 'PLAYBACK'),
                ('writes', [*writes[:2], {**writes[2], 'requestId': recovery_gateway_id}, *writes[3:]], 'PROGRESS'),
                ('writes', [*writes[:4], {**writes[4], 'progressId': user}], 'PROGRESS'),
            ):
                with self.subTest(part=part, error=error), self.assertRaisesRegex(ValueError, f'LESSON_ACK_LOSS_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, part: rows}}})
            for changes in ({'revision': 10}, {'playbackExpiresAt': browser['playback'][0]['thumbnailExpiresAt']}):
                with self.subTest(witness=changes), self.assertRaisesRegex(ValueError, 'LESSON_ACK_LOSS_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **changes}}})
        if stale_revision:
            for part, changes, error in (
                ('conflict', {'status': 200}, 'CONFLICT'),
                ('conflict', {'expectedProgressRevision': 10}, 'CONFLICT'),
                ('conflict', {'requestId': authoritative_gateway_id}, 'CONFLICT'),
                ('authoritative', {'revision': 8}, 'AUTHORITATIVE'),
                ('authoritative', {'requestId': writes[4]['requestId']}, 'AUTHORITATIVE'),
                ('reload', {'documentReplaced': False}, 'RELOAD'),
                ('reload', {'noReplay': 1}, 'RELOAD'),
                ('media', {'afterSeconds': 4}, 'MEDIA'),
            ):
                wrong = {**browser, part: {**browser[part], **changes}}
                with self.subTest(part=part, changes=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            wrong = {**browser, 'writes': [*writes[:4], {**writes[4], 'resumePositionSeconds': 4}, *writes[5:]]}
            with self.assertRaisesRegex(ValueError, f'{stage_status}_PROGRESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for changes in ({'revision': 12}, {'maxPositionSeconds': 15}, {'progressId': request}, {'playbackExpiresAt': playback[0]['expiresAt']}):
                with self.subTest(witness=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **changes}}})
            wrong_ack = copy.deepcopy(gateway_artifact)
            wrong_ack['gatewayAcknowledgements'][17]['upstreamStatus'] = 200
            with self.assertRaisesRegex(ValueError, f'{stage_status}_ACKNOWLEDGEMENTS_REQUIRED'):
                window.browser_gateway_receipt(plan, wrong_ack)
        if exit_save or visibility:
            wrong_playback_id = requests_by_index[0] if exit_save else requests_by_index[6]
            for part, changes, error in (
                (receipt_key, {'pathname': f'/academy/courses/{user}'}, receipt_key.upper()),
                (receipt_key, {'sameDocument': not same_document}, receipt_key.upper()),
                (receipt_key, {'trustedPagehide': same_document}, receipt_key.upper()),
                (receipt_key, {'trustedHidden': not position_receipt['trustedHidden']}, receipt_key.upper()),
                (receipt_key, {'resumePositionSeconds': 10}, receipt_key.upper()),
                (receipt_key, {'expectedProgressRevision': 8.0}, receipt_key.upper()),
                ('media', {'playedSeconds': 6, 'playing': 1}, 'MEDIA'),
                ('playback', {'requestId': wrong_playback_id}, 'PLAYBACK'),
            ):
                wrong = {**browser, part: {**browser[part], **changes}}
                with self.subTest(part=part, changes=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            position_writes = [*writes[:2], {**writes[2], 'resumePositionSeconds': 9}] if visibility else writes
            wrong = {**browser, receipt_key: {**position_receipt, 'resumePositionSeconds': 9}, 'writes': position_writes,
                     'media': {**browser['media'], 'playedSeconds': 6}}
            with self.assertRaisesRegex(ValueError, f'{stage_status}_MEDIA_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            wrong = {**browser, 'writes': [{**writes[0], 'requestId': requests_by_index[8]}, *writes[1:]]}
            with self.assertRaisesRegex(ValueError, f'{stage_status}_PROGRESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for changes in ({'revision': 8}, {'resumePositionSeconds': 8}, {'progressId': request}, {'maxPositionSeconds': 15}):
                with self.subTest(witness=changes), self.assertRaisesRegex(ValueError, f'{stage_status}_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **changes}}})
        if resume:
            for part, changes, error in (
                ('playback', {'playbackIdSha256': '0' * 64}, 'PLAYBACK'),
                ('playback', {'lifetimeMs': 601_000}, 'PLAYBACK'),
                ('started', {'requestId': requests_by_index[5]}, 'STARTED'),
                ('media', {'manifestObserved': False}, 'MEDIA'),
                ('media', {'segmentObserved': False}, 'MEDIA'),
                ('media', {'heartbeatSeconds': 12}, 'MEDIA'),
            ):
                wrong = {**browser, part: {**browser[part], **changes}}
                with self.subTest(part=part, changes=changes), self.assertRaisesRegex(ValueError, f'LESSON_RESUME_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change, error in (({'requestId': requests_by_index[8]}, 'WRITES'),
                                  ({'resumePositionSeconds': 5}, 'POSITIONS'),
                                  ({'submittedMaxPositionSeconds': 13, 'maxPositionSeconds': 13}, 'POSITIONS')):
                wrong = {**browser, 'writes': [*writes[:2], {**writes[2], **change}]}
                with self.subTest(write=change), self.assertRaisesRegex(ValueError, f'LESSON_RESUME_{error}_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'playbackIdSha256': 'a' * 64}, {'revision': 3}, {'maxPositionSeconds': 13}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'LESSON_RESUME_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if learner_access:
            with self.assertRaisesRegex(ValueError, 'LEARNER_ACCESS_PAGE_REQUIRED'):
                wrong = {**browser, 'page': {**browser['page'], 'lessonLink': not allowed}}
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'status': 418}, {'code': 'wrong'}, {'target': paths[1]}, {'requestId': browser['reads'][1]['requestId']}):
                wrong = {**browser, 'reads': [{**browser['reads'][0], **change}, *browser['reads'][1:]]}
                with self.subTest(read=change), self.assertRaisesRegex(ValueError, 'LEARNER_ACCESS_READS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'revision': 5}, {'grantId': user}, {'effectiveAccess': not allowed}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'LEARNER_ACCESS_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if learning:
            for change in ({'requestId': user}, {'academyPath': '/academy'}, {'status': 201}):
                with self.subTest(browser=change), self.assertRaisesRegex(ValueError, 'LEARNING_ENROLLMENT_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, **change}}})
            wrong_bodies = [{'source': 'paid'}, {'idempotentReplay': not replay}, {'courseId': user}]
            if replay:
                wrong_bodies.extend(({'grantId': user}, {'enrollmentId': user}))
            for change in wrong_bodies:
                wrong = {**browser, 'body': {**enrolled, **change}}
                with self.subTest(body=change), self.assertRaisesRegex(ValueError, 'LEARNING_ENROLLMENT_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            with self.assertRaisesRegex(ValueError, 'LEARNING_COURSE_WITNESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, domain_key: {**domain, 'grantId': user}}})
            if replay:
                for change in ({'streamId': user}, {'canonicalDigest': '6' * 64}):
                    wrong = {**domain, 'communityDelivery': {**community_delivery, **change}}
                    with self.assertRaisesRegex(ValueError, 'LEARNING_COMMUNITY_DELIVERY_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain',
                                        'caseEvidence': {**evidence, domain_key: wrong}})
                wrong = {**domain, 'transitionId': user, 'communityDelivery': {**community_delivery, 'eventId': user}}
                with self.assertRaisesRegex(ValueError, 'LEARNING_COMMUNITY_DELIVERY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: wrong}})
        if paid_grant:
            for change in ({'requestId': user}, {'method': 'GET'}, {'status': 202}):
                with self.subTest(browser=change), self.assertRaisesRegex(ValueError, 'PAID_GRANT_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, **change}}})
            for change in ({'courseRevision': 5}, {'userId': actor}, {'grantId': 'invalid'}, {'communityDeliveryVerified': True}):
                wrong = {**browser, 'body': {**granted, **change}}
                with self.subTest(body=change), self.assertRaisesRegex(ValueError, 'PAID_GRANT_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'commandId': user}, {'transitionId': 'invalid'}, {'communityDeliveryVerified': True},
                           {'priorGrantId': user}, {'transitionId': user if second_paid else None}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'PAID_GRANT_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
            if second_paid:
                wrong = {**browser, 'body': {**granted, 'grantId': prior_grant['priorGrantId']}}
                with self.assertRaisesRegex(ValueError, 'PAID_GRANT_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
        if learning or paid_grant:
            invalid = [
                None, {}, {**community_delivery, 'streamId': 'invalid'}, {**community_delivery, 'eventId': 'invalid'},
                {**community_delivery, 'streamVersion': 0}, {**community_delivery, 'streamVersion': 2},
                {**community_delivery, 'streamVersion': True}, {**community_delivery, 'canonicalDigest': '0' * 64},
                {**community_delivery, 'canonicalDigest': 'A' * 64}, {**community_delivery, 'state': 'revoked'},
                {**community_delivery, 'rawPayload': {}},
            ]
            if not second_paid:
                invalid.append({**community_delivery, 'eventId': user})
            for delivery in invalid:
                with self.subTest(delivery=delivery), self.assertRaisesRegex(ValueError, f'{stage_status}_COMMUNITY_DELIVERY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, 'communityDelivery': delivery}}})
        if paid_revoke:
            for change in ({'requestId': user}, {'pathname': pathname.removesuffix('/revoke')}, {'status': 202}):
                with self.subTest(browser=change), self.assertRaisesRegex(ValueError, 'PAID_REVOKE_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, **change}}})
            for change in ({'courseRevision': 5}, {'userId': actor}, {'grantId': user}):
                wrong = {**browser, 'body': {**revoked, **change}}
                with self.subTest(body=change), self.assertRaisesRegex(ValueError, 'PAID_REVOKE_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'remainingAccess': not remaining_access}, {'transitionId': user if remaining_access else None},
                           {'commandId': user}, {'communityDeliveryVerified': True}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'PAID_REVOKE_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
            invalid_deliveries = [
                None, {}, {**community_delivery, 'rawPayload': {}}, {**community_delivery, 'streamId': 'invalid'},
                {**community_delivery, 'eventId': 'DEADBEEF-0000-4000-8000-000000000001'},
                {**community_delivery, 'streamVersion': 0}, {**community_delivery, 'streamVersion': 2_147_483_648},
                {**community_delivery, 'streamVersion': True}, {**community_delivery, 'canonicalDigest': '0' * 64},
                {**community_delivery, 'canonicalDigest': 'A' * 64}, {**community_delivery, 'independentActiveSha256': '0' * 64},
                {**community_delivery, 'independentActiveSha256': '7' * 63}, {**community_delivery, 'independentActiveCount': 0},
                {**community_delivery, 'independentActiveCount': 4097}, {**community_delivery, 'independentActiveCount': True},
                {**community_delivery, 'state': 'revoked' if remaining_access else 'active'},
            ]
            if not remaining_access:
                invalid_deliveries.append({**community_delivery, 'eventId': user})
            for delivery in invalid_deliveries:
                with self.subTest(delivery=delivery), self.assertRaisesRegex(ValueError, 'PAID_REVOKE_COMMUNITY_DELIVERY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, 'communityDelivery': delivery}}})
        if identity:
            wrong_actor = 'invalid-uuid' if provider is not None else user
            with self.assertRaisesRegex(ValueError, 'IDENTITY_SESSION_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, browser_key: {**browser, 'actorId': wrong_actor}}})
            with self.assertRaisesRegex(ValueError, 'IDENTITY_WITNESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, domain_key: {**domain, 'providerSubject': 'fixture'}}})
        if provider is not None:
            other_provider = 'resend' if provider == 'google' else 'google'
            for change in ({'provider': other_provider}, {'liveSessionCount': 2}, {'liveSessionCount': True},
                           {'providerLinkCount': 1 - domain['providerLinkCount']},
                           {'providerLinkCount': bool(domain['providerLinkCount'])}):
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'IDENTITY_ENROLLMENT_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if authoring and not archiving and not republishing and publication_outcome is None and quiz_revision is None:
            wrong = {**browser, 'winner': {**browser['winner'], 'requestId': user}} if paired else {**browser, 'requestId': user}
            response_error = ('AUTHORING_CURRICULUM_RESPONSE_REQUIRED' if create_kind is not None else
                              'AUTHORING_REORDER_RESPONSES_REQUIRED' if reorder_kind is not None else 'AUTHORING_BROWSER_RESPONSE_REQUIRED')
            with self.assertRaisesRegex(ValueError, response_error):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, browser_key: wrong}})
        if archiving:
            for change in ({'requestId': user}, {'warningObserved': False}, {'cancelObservedWithoutMutation': False}, {'method': 'POST'}):
                with self.subTest(browser=change), self.assertRaisesRegex(ValueError, 'AUTHORING_ARCHIVE_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, **change}}})
            for change in ({'status': 'published'}, {'revision': 3}, {'slug': 'different'}):
                wrong = {**browser, 'body': {**draft, **change}}
                with self.subTest(body=change), self.assertRaisesRegex(ValueError, 'AUTHORING_ARCHIVE_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'historyPreserved': False}, {'readOnly': False}, {'userId': actor}, {'grantId': ledger_ids[1]}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'AUTHORING_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if republishing:
            for key, change in (('draft', {'requestId': user}), ('readiness', {'method': 'PATCH'})):
                wrong = {**browser, key: {**browser[key], **change}}
                with self.subTest(receipt=key, change=change), self.assertRaisesRegex(ValueError, 'AUTHORING_REPUBLISH_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            wrong = {key: value for key, value in browser.items() if key != 'publication'} if published else {**browser, 'publication': {}}
            with self.assertRaisesRegex(ValueError, 'AUTHORING_REPUBLISH_EVIDENCE_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'issueCodes': ['OTHER_CODE']}, {'revision': 3}, {'status': 'archived'}):
                wrong = {**browser, 'body': {**draft, **change}}
                with self.subTest(body=change), self.assertRaisesRegex(ValueError, 'AUTHORING_REPUBLISH_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'effectiveAccess': not domain['effectiveAccess']}, {'historyPreserved': False}, {'grantId': user}):
                with self.subTest(witness=change), self.assertRaisesRegex(ValueError, 'AUTHORING_COURSE_WITNESS_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, domain_key: {**domain, **change}}})
        if publication_outcome is not None:
            wrong = {**browser, 'readiness': {**browser['readiness'], 'requestId': request}}
            with self.assertRaisesRegex(ValueError, 'AUTHORING_PUBLICATION_RESPONSE_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            wrong = {key: value for key, value in browser.items() if key != 'publication'} if published else {**browser, 'publication': {}}
            with self.assertRaisesRegex(ValueError, 'AUTHORING_PUBLICATION_EVIDENCE_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'issueCodes': ['OTHER_CODE']}, {'revision': 6}, {'status': 'archived'}):
                wrong = {**browser, 'body': {**draft, **change}}
                with self.subTest(body=tuple(change)), self.assertRaisesRegex(ValueError, 'AUTHORING_PUBLICATION_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
        if quiz_revision is not None:
            for key, change in (('prior', {'status': 200 if prior_status == 404 else 404}), ('save', {'requestId': user}),
                                ('save', {'method': 'PATCH'})):
                wrong = {**browser, key: {**browser[key], **change}}
                with self.subTest(receipt=key, change=change), self.assertRaisesRegex(ValueError, 'AUTHORING_QUIZ_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            for change in ({'documentSha256': '6' * 64}, {'revision': 3}, {'quizRevision': quiz_revision}, {'lessonId': user}):
                wrong = {**browser, 'body': {**draft, **change}}
                with self.subTest(body=tuple(change)), self.assertRaisesRegex(ValueError, 'AUTHORING_QUIZ_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            with self.assertRaisesRegex(ValueError, 'AUTHORING_COURSE_WITNESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, domain_key: {**domain, 'quizId': user}}})
        if create_kind is not None:
            for change in ({'itemId': 'invalid-uuid'}, {'parentId': user}, {'slug': 'owned-draft'}, {'revision': 3}):
                wrong = {**browser, 'body': {**draft, **change}}
                with self.subTest(body=tuple(change)), self.assertRaisesRegex(ValueError, 'AUTHORING_CURRICULUM_BODY_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
            with self.assertRaisesRegex(ValueError, 'AUTHORING_COURSE_WITNESS_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain',
                                'caseEvidence': {**evidence, domain_key: {**domain, 'itemId': user}}})
        if editing:
            for change in ({'requestId': request}, {'dirtyInputPreserved': False}, {'outcome': 'other'}, {'body': {'code': 'conflict'}}):
                with self.subTest(stale=change), self.assertRaisesRegex(ValueError, 'AUTHORING_STALE_RESPONSE_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, 'stale': {**browser['stale'], **change}}}})
        if reorder_kind is not None:
            for change in ({'requestId': request}, {'keyboardActivated': False}, {'outcome': 'other'}):
                with self.subTest(stale=change), self.assertRaisesRegex(ValueError, 'AUTHORING_REORDER_RESPONSES_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain',
                                    'caseEvidence': {**evidence, browser_key: {**browser, 'stale': {**browser['stale'], **change}}}})
            for change, error in (({'ids': list(reversed(ordered_ids))}, 'ORDER_REFUSED'),
                                  ({'ids': [ordered_ids[0]] * 3}, 'BODY_REQUIRED'),
                                  ({'revision': 3}, 'BODY_REQUIRED'), ({'parentId': user}, 'BODY_REQUIRED')):
                wrong = {**browser, 'winner': {**browser['winner'], 'body': {**draft, **change}}}
                with self.subTest(winner=tuple(change)), self.assertRaisesRegex(ValueError, f'AUTHORING_REORDER_{error}'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': {**evidence, browser_key: wrong}})
        with patch.object(stage, 'verify_gateway_fenced', side_effect=ValueError('P2_INTERACTIVE_FENCE_REQUIRED')):
            with self.assertRaisesRegex(ValueError, 'FENCE_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        changed_ledger = copy.deepcopy(ledger)
        if read_only:
            changed_ledger['operations'] = [unexpected_operation]
        else:
            for operation in changed_ledger['operations']:
                operation['kind'] = 'recovery'
        with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': changed_ledger}):
            with self.assertRaisesRegex(ValueError, 'READ_ONLY_LEDGER_REQUIRED' if read_only else 'COMPLETED_NEW_WORK_REQUIRED'):
                broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if lesson_entry:
            changed_ledger = {**ledger, 'operations': [*ledger['operations'], unexpected_operation]}
            with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': changed_ledger}):
                with self.assertRaisesRegex(ValueError, 'LESSON_ENTRY_SINGLE_NEW_WORK_REQUIRED'):
                    broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if assessment or exit_save or visibility:
            for operations in (ledger['operations'][:2], [*ledger['operations'][:2], {**ledger['operations'][2], 'kind': 'recovery'}]):
                with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': {**ledger, 'operations': operations}}):
                    with self.assertRaisesRegex(ValueError, f'{stage_status}_THREE_NEW_WORK_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if restore:
            for operations in (ledger['operations'][:1], [ledger['operations'][0], {**ledger['operations'][1], 'kind': 'recovery'}]):
                with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': {**ledger, 'operations': operations}}):
                    with self.assertRaisesRegex(ValueError, 'LESSON_RESTORE_TWO_NEW_WORK_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if resume:
            for operations in (ledger['operations'][:3], [*ledger['operations'][:3], {**ledger['operations'][3], 'kind': 'recovery'}]):
                with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': {**ledger, 'operations': operations}}):
                    with self.assertRaisesRegex(ValueError, 'LESSON_RESUME_FOUR_NEW_WORK_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if ack_loss:
            for operations in (ledger['operations'][:4], [*ledger['operations'][:4], {**ledger['operations'][4], 'kind': 'recovery'}]):
                with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': {**ledger, 'operations': operations}}):
                    with self.assertRaisesRegex(ValueError, 'LESSON_ACK_LOSS_FIVE_NEW_WORK_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        if stale_revision:
            rows = ledger['operations']
            for operations in (rows[:-1], [*rows[:-1], {**rows[-1], 'kind': 'recovery'}]):
                with patch.object(broker.observer, 'probe', return_value={'admission': closed, 'witness': {**ledger, 'operations': operations}}):
                    with self.assertRaisesRegex(ValueError, f'{stage_status}_EIGHT_NEW_WORK_REQUIRED'):
                        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        case = broker.scoped_case
        self.assertEqual(calls.pop(), {'id': 1, 'status': 'CERTIFICATION_INTERACTIVE_OBSERVED', 'receipt': case})
        self.assertEqual(case['frontendOperationCount'], 0 if read_only else 1 if lesson_entry else 8 if stale_revision else
                         5 if ack_loss else 4 if resume else 2 if restore else 3)
        if identity:
            self.assertEqual(case['context'], 'owner' if actor_kind == 'admin' else 'learner')
            self.assertEqual(case['browserIdentitySha256'], supervisor._canonical_sha(browser))
            self.assertEqual(case['identityWitnessSha256'], supervisor._canonical_sha(domain))
            if identity_pair:
                self.assertEqual(case['sessionCount'], 2)
        if learning:
            self.assertEqual({key: case[key] for key in ('grantId', 'enrollmentId', 'transitionId', 'gatewayPostRequestId')},
                             {'grantId': ledger_ids[0], 'enrollmentId': ledger_ids[1], 'transitionId': ledger_ids[2],
                              'gatewayPostRequestId': request})
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
            self.assertEqual(case['communityDelivery'], community_delivery)
            if replay:
                self.assertEqual(case['operation'], 'replay-free-enrollment')
            else:
                self.assertNotIn('operation', case)
        if lesson_entry:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'open-lesson')
            self.assertEqual(case['playbackGatewayRequestId'], requests_by_index[6])
            self.assertEqual(case['progressGatewayRequestId'], requests_by_index[7])
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if lesson_denial:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'deny-cross-account')
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if assessment:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'fail-then-pass')
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if resume or restore:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'restore-resume' if restore else 'play-and-rewind')
            self.assertEqual(case['playbackGatewayRequestId'], requests_by_index[5])
            self.assertEqual(case['startedGatewayRequestId'], requests_by_index[6])
            if restore:
                self.assertEqual(case['restoredGatewayRequestId'], requests_by_index[7])
            else:
                self.assertEqual(case['positionGatewayRequestIds'], [requests_by_index[index] for index in (7, 8, 9)])
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if ack_loss:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'commit-drop-recover')
            self.assertEqual(case['playbackGatewayRequestIds'], playback_ids)
            self.assertEqual(case['progressGatewayRequestIds'], progress_gateway_ids)
            self.assertEqual(case['recoveryGatewayRequestId'], recovery_gateway_id)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if stale_revision:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], 'conflict-reload')
            self.assertEqual(case['playbackGatewayRequestIds'], playback_ids)
            self.assertEqual(case['progressGatewayRequestIds'], progress_gateway_ids)
            self.assertEqual(case['conflictGatewayRequestId'], conflict_gateway_id)
            self.assertEqual(case['authoritativeGatewayRequestId'], authoritative_gateway_id)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if exit_save or visibility:
            self.assertEqual({key: case[key] for key in domain if key != 'readOnly'},
                             {key: value for key, value in domain.items() if key != 'readOnly'})
            self.assertEqual(case['operation'], position_selection['operation'])
            self.assertEqual(case['playbackGatewayRequestId'], requests_by_index[5])
            self.assertEqual(case['progressGatewayRequestIds'], [requests_by_index[index] for index in (6, 7, 8)])
            if exit_save:
                self.assertEqual(case['destinationCourseGatewayRequestId'], requests_by_index[0])
                self.assertEqual(case['destinationProgressGatewayRequestId'], requests_by_index[9])
            else:
                self.assertNotIn('destinationCourseGatewayRequestId', case)
                self.assertNotIn('destinationProgressGatewayRequestId', case)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if learner_access:
            self.assertEqual({key: case[key] for key in observed}, observed)
            self.assertIs(case['effectiveAccess'], allowed)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if paid_grant:
            self.assertEqual(case['status'], 'P2_INTERACTIVE_PAID_GRANT_JOINED')
            self.assertEqual({key: case[key] for key in granted}, granted)
            self.assertEqual(case['gatewayPostRequestId'], request)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
            self.assertEqual(case['communityDelivery'], community_delivery)
            self.assertEqual(case['transitionId'], domain['transitionId'])
            if second_paid:
                self.assertEqual(case['priorGrantId'], prior_grant['priorGrantId'])
            else:
                self.assertNotIn('priorGrantId', case)
        if paid_revoke:
            self.assertEqual(case['status'], 'P2_INTERACTIVE_PAID_REVOKE_JOINED')
            self.assertEqual({key: case[key] for key in revoked}, revoked)
            self.assertIs(case['remainingAccess'], remaining_access)
            self.assertEqual(case['transitionId'], domain['transitionId'])
            self.assertEqual(case['communityDelivery'], community_delivery)
            self.assertEqual(case['gatewayPostRequestId'], request)
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        if authoring:
            if republishing:
                self.assertEqual(case['draftGatewayRequestId'], request)
                self.assertEqual(case['readinessGatewayRequestId'], user)
                self.assertEqual(case['effectiveAccess'], published and expected_access)
                self.assertEqual(case.get('gatewayPatchRequestId'), ledger_ids[2] if published else None)
            elif archiving:
                self.assertEqual(case['gatewayPatchRequestId'], request)
                self.assertEqual({key: case[key] for key in ('userId', 'grantId', 'revision')},
                                 {'userId': user, 'grantId': ledger_ids[0], 'revision': 4})
                for flag in ('warningObserved', 'cancelObservedWithoutMutation', 'historyPreserved'):
                    self.assertNotIn(flag, case)
            elif quiz_revision is not None:
                self.assertEqual(case['priorGatewayRequestId'], user)
                self.assertEqual(case['gatewayPutRequestId'], request)
                self.assertEqual({key: case[key] for key in draft}, draft)
            elif publication_outcome is not None:
                self.assertEqual(case['readinessGatewayRequestId'], user)
                self.assertEqual(case['issueCodes'], issue_codes)
                self.assertEqual(case['revision'], draft['revision'])
                self.assertEqual(case.get('gatewayPatchRequestId'), request if published else None)
            elif paired:
                self.assertEqual(case['gatewayPostRequestIds' if reorder_kind is not None else 'gatewayPatchRequestIds'], [request, user])
                self.assertEqual(case['browserResponsesSha256'], supervisor._canonical_sha(browser))
            else:
                self.assertEqual(case['gatewayPostRequestId'], request)
            if create_kind is not None:
                self.assertEqual({key: case[key] for key in ('kind', 'parentId', 'itemId', 'slug', 'childSlug', 'revision')},
                                 {'kind': create_kind, 'parentId': parent, 'itemId': draft['itemId'],
                                  'slug': 'owned-draft', 'childSlug': 'owned-child', 'revision': 4})
            self.assertEqual(case['gatewayEvidenceSha256'], supervisor._canonical_sha(gateway_artifact))
        with self.assertRaisesRegex(ValueError, 'FIXED_CONTROLLER_OPERATION_REQUIRED'):
            broker.command({**envelope, 'operation': 'interactive-retain', 'caseEvidence': evidence})
        for retained in directory.iterdir():
            raw = retained.read_text()
            self.assertNotIn(permit['cookie'], raw)
            self.assertNotIn(envelope['controllerChallenge'], raw)
            if provider is not None:
                self.assertNotIn(action['identityEnrollment']['emailSha256'], raw)
                self.assertNotIn(action['identityEnrollment']['nonce'], raw)
        terminal = {**plan, 'status': supervisor.PROFILED_CERTIFICATION_LAYOUT['terminalStatus'], 'releaseId': 'original',
                    'configurationSha256': initial['configurationSha256'], 'caseStatus': f'P2_INTERACTIVE_{stage_status}_JOINED',
                    'caseOutcomeSha256': supervisor._canonical_sha(case), 'frontendAdmission': closed,
                    'witnessSha256': migrate.file_hash(json.dumps(ledger, separators=(',', ':')).encode()),
                    'gatewayAdmission': {'version': 1, 'valid': True, 'releaseId': 'original', 'candidateSha256': initial['candidateSha256'],
                        'newWork': False, 'recovery': False, 'active': window._ZERO, 'uncertain': window._ZERO},
                    'nativeDisabled': True, **dict.fromkeys(('frontendSqlApplied', 'trafficAuthorized', 'releaseAccepted',
                        'sqlReplayed', 'nativeInvocationQualified', 'persistenceAuthorityJoined', 'deployedCertificationComplete',
                        'directWorkerSourceJoined', 'runtimeReplaced', 'wholeReleaseAccepted'), False)}

        def guard(record):
            raw = json.dumps(record).encode()
            return supervisor._require_profiled_certification_terminal(initial, raw, migrate.file_hash(raw), source=source)

        self.assertEqual(guard(terminal), terminal)
        if resume:
            import p2_certification_parent as parent
            for key in parent._RESUME_RELEASE_PINS:
                plan.setdefault(key, '9' * 64)
            for key in parent._RESUME_DEPLOYMENT_PINS:
                plan['nativePlan'].setdefault(key, 'owned-' + key)
            terminal_file = supervisor.PROFILED_CERTIFICATION_LAYOUT['terminalName']
            migrate.write_json(directory, terminal_file, terminal)
            host_terminal_sha = migrate.file_hash(migrate.read_input(directory, terminal_file))
            source_terminal = json.dumps(terminal, separators=(',', ':')).encode() + b'\n'
            migrate.write_exact_bytes(directory, parent._RESUME_SOURCE_TERMINAL, source_terminal)
            prior = {key: domain[key] for key in ('progressId', 'enrollmentId', 'resumePositionSeconds', 'maxPositionSeconds',
                                                   'playbackIdSha256', 'playbackExpiresAt')}
            prior.update(actionId=plan['certificationActionId'], outcomeSha256=migrate.file_hash(source_terminal))
            restore_action = {'operation': 'restore-resume', 'courseId': command, 'lessonId': lesson, 'grantId': ledger_ids[1], 'prior': prior}
            restore_plan = {**plan, 'certificationActionId': 'owned-next-restore', 'initialEpoch': str(int(closed_epoch) + 2),
                            'scopedAction': {'stage': 'lesson-restore', 'actorId': actor, 'restoreAction': restore_action}}
            def require_prior(selection=restore_plan):
                parent._require_profiled_restore_prior(selection, self.root, parent._profiled_context())

            with self.assertRaises(FileNotFoundError):
                require_prior()
            parent.retain_profiled_resume_guard(initial, terminal, host_terminal_sha)
            require_prior()
            for changes, error in (
                ({'gatewayProcessSha256': '1' * 64}, 'GUARD'),
                ({'nativePlan': {**plan['nativePlan'], 'deploymentId': 'foreign-deployment'}}, 'GUARD'),
                ({'initialEpoch': str(int(closed_epoch) + 3)}, 'EVIDENCE'),
                ({'scopedAction': {**restore_plan['scopedAction'], 'actorId': user}}, 'EVIDENCE'),
            ):
                with self.subTest(prior=changes), self.assertRaisesRegex(ValueError, f'LESSON_RESTORE_PRIOR_{error}_REQUIRED'):
                    require_prior({**restore_plan, **changes})
            for changes, error in (({'outcomeSha256': '2' * 64}, 'GUARD'), ({'maxPositionSeconds': 4}, 'EVIDENCE')):
                changed = {**restore_action, 'prior': {**prior, **changes}}
                with self.subTest(selection=changes), self.assertRaisesRegex(ValueError, f'LESSON_RESTORE_PRIOR_{error}_REQUIRED'):
                    require_prior({**restore_plan, 'scopedAction': {**restore_plan['scopedAction'], 'restoreAction': changed}})
            (directory / terminal_file).write_bytes(migrate.read_input(directory, terminal_file) + b'\n')
            with self.assertRaisesRegex(ValueError, 'LESSON_RESTORE_PRIOR_GUARD_REQUIRED'):
                require_prior()
        if paid_revoke or paid_grant or learning:
            evidence_path = directory / window.browser_artifact(plan, 'evidence')
            substituted = {**domain, 'communityDelivery': {**community_delivery, 'canonicalDigest': '6' * 64}}
            evidence_path.write_text(json.dumps({**evidence, domain_key: substituted}))
            with self.assertRaisesRegex(ValueError, 'LEARNING_COMMUNITY_DELIVERY_REQUIRED' if replay else 'INTERACTIVE_CASE_REFUSED'):
                guard(terminal)
            evidence_path.write_text(json.dumps(evidence))
        with self.assertRaisesRegex(ValueError, 'SCOPED_CASE_REFUSED'):
            guard({**terminal, 'frontendAdmission': {**closed, 'epoch': active_epoch}})
        with self.assertRaisesRegex(ValueError, 'INTERACTIVE_CASE_REFUSED'):
            guard({**terminal, 'witnessSha256': '0' * 64})
        if gateway_scoped:
            bad = copy.deepcopy(gateway_artifact)
            if paid_grant:
                rows = bad['gatewayAcknowledgements']
                rows[1], rows[2] = rows[2], rows[1]
            elif paid_revoke:
                rows = bad['gatewayAcknowledgements']
                rows[3], rows[4] = rows[4], rows[3]
            elif lesson_entry:
                rows = bad['gatewayAcknowledgements']
                rows[0], rows[-1] = rows[-1], rows[0]
            elif lesson_denial:
                rows = bad['gatewayAcknowledgements']
                rows[10], rows[11] = rows[11], rows[10]
            elif restore:
                rows = bad['gatewayAcknowledgements']
                rows[6], rows[7] = rows[7], rows[6]
            elif ack_loss:
                rows = bad['gatewayAcknowledgements']
                rows[8], rows[9] = rows[9], rows[8]
            elif stale_revision:
                rows = bad['gatewayAcknowledgements']
                rows[17], rows[18] = rows[18], rows[17]
            elif exit_save or visibility:
                rows = bad['gatewayAcknowledgements']
                rows[7], rows[8] = rows[8], rows[7]
            elif assessment or resume:
                rows = bad['gatewayAcknowledgements']
                rows[7], rows[9] = rows[9], rows[7]
            elif learner_access:
                bad['gatewayAcknowledgements'][0]['upstreamStatus'] = 418
            elif learning:
                bad['gatewayAcknowledgements'][1]['upstreamStatus'] = 201 if replay else 200
            elif archiving:
                rows = bad['gatewayAcknowledgements']
                rows[1], rows[2] = rows[2], rows[1]
            elif republishing:
                rows = bad['gatewayAcknowledgements']
                rows[2], rows[3] = rows[3], rows[2]
            elif quiz_revision is not None:
                bad['gatewayAcknowledgements'][1]['upstreamStatus'] = 200 if prior_status == 404 else 404
            elif publication_outcome is not None:
                rows = bad['gatewayAcknowledgements']
                rows[0], rows[1] = rows[1], rows[0]
            elif paired:
                rows = bad['gatewayAcknowledgements']
                rows[2], rows[4] = rows[4], rows[2]
            elif create_kind is not None:
                rows = bad['gatewayAcknowledgements']
                rows[1], rows[2] = rows[2], rows[1]
            else:
                bad['gatewayAcknowledgements'][1]['upstreamStatus'] = 200
            (directory / window.browser_artifact(plan, 'gateway')).write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, f'{stage_status}_ACKNOWLEDGEMENTS_REQUIRED'):
                guard(terminal)
            (directory / window.browser_artifact(plan, 'gateway')).write_text(json.dumps(gateway_artifact))
        change = {'baselineSha256': '3' * 64}
        if identity:
            change = {'ownerMappingVerified': False} if actor_kind == 'admin' else {'liveSessionCount': 0}
        changed = {**domain, **change}
        (directory / window.browser_artifact(plan, 'evidence')).write_text(json.dumps({**evidence, domain_key: changed}))
        error = ('IDENTITY_ENROLLMENT_WITNESS_REQUIRED' if provider is not None else
                 'IDENTITY_PAIR_WITNESS_REQUIRED' if identity_pair else
                 'IDENTITY_WITNESS_REQUIRED' if identity else
                 f'{stage_status}_COURSE_WITNESS_REQUIRED' if gateway_scoped else 'INTERACTIVE_CASE_REFUSED')
        with self.assertRaisesRegex(ValueError, error):
            guard(terminal)

    def test_profiled_arm_constructs_interactive_leaf_after_guard_and_current_checks(self):
        import p2_certification_parent as parent
        import p2_interactive_window as window

        initial, directory = self.profiled_certification()
        plan = initial['certificationPlan']
        actor = '10000000-0000-4000-8000-000000000001'
        containers = [{'service': f'owned-{index}'} for index in range(10)]
        plan.update(mode='interactive-browser', startState='already-closed', maximumSeconds=300,
                    runtimeInventorySha256=supervisor._canonical_sha(containers),
                    scopedAction={'stage': 'lifecycle', 'actorId': actor, 'requests': [], 'windowSeconds': 60,
                                  'frontendAction': {'actorKind': 'customer', 'userId': actor, 'operation': 'preferences-on'}})
        initial.update(owner={}, producers=[], historicalLogins={}, credentials={'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'fixture'},
                       sourceSha256={parent.OBSERVER: '1' * 64, window._SOURCE_KEY: migrate.file_hash(window._SOURCE.read_bytes())})
        receipt = {'frontend': 'owned-fixture'}
        probe = {'job': {}, 'baseline': {}, 'receipt': receipt, 'plan': plan, 'owner': {},
                 'producers': [], 'historicalLogins': {}}
        request = {'probe': probe, 'receipt': base64.b64encode(json.dumps(receipt).encode()).decode()}
        broker = parent.P2ProfiledCertificationBroker.__new__(parent.P2ProfiledCertificationBroker)
        broker._initialize_certification_state()
        broker.rotation_successor = None
        broker.initial, broker.directory, broker.source = initial, directory, directory
        broker.configuration = directory / 'configuration'
        (broker.configuration / 'admission').mkdir(parents=True)
        broker.selected, broker.jobs, broker.lock_fd = initial['candidate'], {'frontend': {'job': {}, 'schema': '{}'}}, self.fd
        broker.scope = broker.observer = broker.scoped_stage = broker.observer_program = None
        broker.guard_arm_verified = False
        broker.worker_done = threading.Event()
        broker.check = lambda: None
        broker._start_boundary_watch = lambda: None
        broker.observer_type = lambda *_args, **_kwargs: SimpleNamespace(start=lambda _: None)
        broker._runtime_processes = lambda: []
        events = []

        def guard(_):
            self.assertFalse(broker.external_armed)
            broker.guard_arm_verified = True
            events.append('guard')

        def gateway():
            self.assertEqual(events, ['guard', 'api-current'])
            self.assertFalse(broker.external_armed)
            events.append('gateway-current')
            return {'admission': {'newWork': False, 'recovery': False, 'active': window._ZERO, 'uncertain': window._ZERO}}

        def observe_api(_):
            self.assertEqual(events, ['guard'])
            events.append('api-current')
            return {}

        broker._accept_guard_arm, broker._read_api_current, broker._gateway_current = guard, observe_api, gateway
        broker._native_observe = lambda: {'nativeEnabled': False}
        try:
            with patch.object(parent.P2CertificationScope, '__init__', return_value=None), \
                 patch.object(parent.runtime, 'check_containers', return_value=containers), \
                 patch.object(window.os, 'geteuid', return_value=0):
                self.assertEqual(broker.arm(request)['status'], 'P2_CERTIFICATION_CURRENT_READY')
            self.assertEqual(events, ['guard', 'api-current', 'gateway-current'])
            self.assertIs(type(broker.scoped_stage), window.P2InteractiveWindow)
            self.assertIsNotNone(broker.last_boundary)
            self.assertTrue(broker.external_armed)
        finally:
            if broker.admission_fd is not None:
                os.close(broker.admission_fd)

    def test_profiled_cleanup_waits_for_actual_reap_and_keeps_failed_frontend_proof_unknown(self):
        initial, directory = self.profiled_certification()
        ready_r, ready_w = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(ready_r); os.setsid(); os.write(ready_w, b'R'); os.close(ready_w)
            while True:
                time.sleep(1)
        self.children.append(child); os.close(ready_w)
        self.assertEqual(os.read(ready_r, 1), b'R'); os.close(ready_r)
        events = []
        def check(*_):
            self.assertEqual(supervisor.members(child), [])
            contender = os.open(self.lock, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(contender)
        def native(*_):
            check(); events.append('native')
            return {'nativeDisabled': None, 'nativeDisableAttempted': True}
        def frontend(*_):
            check(); events.append('frontend')
            raise RuntimeError('private fixture exception')
        with patch.object(supervisor, 'verify_guard_boundary', side_effect=check), \
             patch.object(supervisor, 'cleanup_profiled_certification_containers', side_effect=lambda: events.append('containers')), \
             patch.object(supervisor, 'capture_gateway_before_stop', side_effect=ValueError('unavailable owned gateway')), \
             patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']), \
             patch.object(supervisor, 'close_gateway', return_value={'gatewayAdmissionFileClosed': True, 'gatewayAdmissionAcknowledged': None}), \
             patch.object(migrate, 'suspend_runtime', side_effect=lambda *_: events.append('stop')):
            result = finish_failure_cleanup(initial, {'source': 'owned physical probe'}, self.root, child,
                                            native_containment=native, frontend_containment=frontend)
        self.children.remove(child)
        self.assertEqual(events, ['native', 'frontend', 'containers', 'stop'])
        self.assertIs(result['workerProcessesQuiesced'], True)
        self.assertIs(result['runtimeStopped'], True)
        self.assertIs(result['nativeDisabled'], None)
        self.assertIs(result['frontendAdmissionClosed'], None)
        self.assertIs(result['frontendCloseAttempted'], None)
        self.assertIs(result['trafficAuthorized'], None)
        initial_path = directory / 'p2-independent-guard-outcome.json'
        reaped_path = directory / 'p2-independent-guard-after-quiescence.json'
        if reaped_path.exists():
            first = json.loads(initial_path.read_bytes())
            self.assertIs(first['workerProcessesQuiesced'], False)
            self.assertIs(first['runtimeStopAttempted'], False)
        retained = (reaped_path if reaped_path.exists() else initial_path).read_text()
        self.assertEqual(json.loads(retained), result)
        self.assertNotIn('private fixture exception', retained)

    def test_profiled_preamble_never_contains_or_stops_the_adopted_runtime(self):
        initial, _ = self.profiled_certification()
        with patch.object(supervisor, 'stop_group', return_value=True), \
             patch.object(supervisor, 'verify_guard_boundary'), \
             patch.object(supervisor, 'cleanup_profiled_certification_containers') as cleanup, \
             patch.object(migrate, 'suspend_runtime', side_effect=AssertionError('unexpected stop')) as stop:
            result = fail_closed(initial, None, self.root, group=123,
                native_containment=lambda *_: self.fail('unexpected native action'),
                frontend_containment=lambda *_: self.fail('unexpected frontend action'))
        cleanup.assert_called_once_with()
        stop.assert_not_called()
        self.assertEqual(result['status'], 'P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE')
        self.assertIs(result['runtimeStopAttempted'], False)
        self.assertIsNone(result['frontendAdmissionClosed'])

    def test_profiled_cleanup_reaps_its_direct_child_even_before_setsid(self):
        child = os.fork()
        if child == 0:
            while True:
                time.sleep(1)
        self.children.append(child)
        deadline = time.monotonic() + 5
        while not supervisor._stop_profiled_certification_group(child):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.children.remove(child)
        with self.assertRaises(ChildProcessError):
            os.waitpid(child, os.WNOHANG)

    def test_profiled_cleanup_retries_container_absence_without_replaying_containment(self):
        initial, directory = self.profiled_certification()
        with patch.object(supervisor, 'stop_group', return_value=True), \
             patch.object(supervisor, 'verify_guard_boundary'), \
             patch.object(supervisor, 'cleanup_profiled_certification_containers', side_effect=[ValueError('unknown'), None]) as cleanup, \
             patch.object(supervisor, '_stop_profiled_certification_runtime') as stop:
            native = unittest.mock.Mock(return_value={'nativeDisabled': True, 'nativeDisableAttempted': False})
            frontend = unittest.mock.Mock(return_value={'frontendAdmissionClosed': None, 'frontendCloseAttempted': True})
            result = finish_failure_cleanup(initial, {'source': 'owned probe'}, self.root, 123,
                                            native_containment=native, frontend_containment=frontend)
        self.assertEqual(cleanup.call_count, 2)
        native.assert_called_once()
        frontend.assert_called_once()
        stop.assert_called_once()
        first = json.loads((directory / 'p2-independent-guard-outcome.json').read_bytes())
        final = json.loads((directory / 'p2-independent-guard-after-container-cleanup.json').read_bytes())
        self.assertIs(first['profiledCertificationContainerCleanupUncertain'], True)
        self.assertEqual(final, result)
        self.assertIs(final['profiledCertificationContainerCleanupVerified'], True)
        self.assertIsNone(final['frontendAdmissionClosed'])

    def test_profiled_safety_pipe_requires_one_arm_before_one_raw_commit_and_reap(self):
        digest = 'c' * 64
        arm = {'operation': 'armed', 'probe': {'owned': True}}
        commit = {'operation': 'committed', 'sha256': digest}
        for frames, suffix, code in (([arm, commit], b'', None), ([commit], b'', 'SAFETY_COMMIT_REFUSED'),
                                    ([arm, commit, commit], b'', 'SAFETY_COMMIT_REFUSED'),
                                    ([arm, commit], b'partial', 'SAFETY_TERMINAL_REFUSED')):
            safety_r, safety_w = os.pipe(); health_r, health_w = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(safety_r); os.close(health_w)
                raw = b''.join(json.dumps(frame).encode() + b'\n' for frame in frames) + suffix
                os.write(safety_w, raw); os.close(safety_w); os.close(health_r); os._exit(0)
            self.children.append(child); os.close(safety_w); os.close(health_r)
            observed = []
            try:
                if code is None:
                    self.assertEqual(watch_broker(child, safety_r, health_w, observed.append, profiled_certification=True), digest)
                    self.assertEqual(observed, [arm['probe']])
                    with self.assertRaises(ChildProcessError):
                        os.waitpid(child, os.WNOHANG)
                else:
                    with self.assertRaisesRegex(ValueError, code):
                        watch_broker(child, safety_r, health_w, observed.append, profiled_certification=True)
                    try: os.waitpid(child, 0)
                    except ChildProcessError: pass
            finally:
                os.close(safety_r); os.close(health_w); self.children.remove(child)

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
                             native_result=None, native_error=False, helper_cleanup=None):
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
             patch('p2_release_supervisor.cleanup_recovery_current_containers',side_effect=helper_cleanup) as cleanup_current, \
             patch('p2_release_supervisor.stop_group', side_effect=[False, True, True] if retry else lambda *_: False), \
             patch('p2_release_supervisor.migrate.suspend_runtime', side_effect=stop), \
             patch.object(staging_admission.Host, 'state', side_effect=ValueError('unavailable')), sticky_cleanup_signals():
            if repeated_signal: os.kill(os.getpid(), signal.SIGTERM)
            options = {'native_containment': native_containment} if certification else {}
            receipt = (finish_failure_cleanup(initial, {'owned': True}, self.root, group, **options) if retry else
                       fail_closed(initial, {'owned': True}, self.root, group=group, **options))
        expected_calls = (['native-disable'] if certification else []) + ['fence', 'runtime-stop']
        self.assertEqual(calls, expected_calls * (2 if retry else 1))
        self.assertEqual(cleanup_current.call_count, (2 if retry else 1) if recovery or certification else 0)
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

    def test_independent_certification_cleanup_runs_after_actual_scope_revocation(self):
        owned=scope_fixture.P2ScopeTests();owned.setUp();self.addCleanup(owned.tearDown)
        owned.scope.revoke()
        with self.assertRaisesRegex(ValueError,'SCOPE_CLOSED'):owned.scope.run(['unreachable'],timeout=1)
        names={'a'*12:'/lash-p2-certification-observer-'+'1'*32,'b'*12:'/lash-p2-certification-observer-'+'1'*31}
        actual=supervisor.cleanup_recovery_current_containers
        def command(args,*_):
            if args[:3]==['docker','rm','--force']:names.pop(args[-1]);return ''
            pattern=next(value[5:] for value in args if value.startswith('name='))
            return '\n'.join(identity for identity,name in names.items() if re.fullmatch(pattern,name))
        def cleanup():
            with self.assertRaisesRegex(ValueError,'SCOPE_CLOSED'):owned.scope.verify()
            with patch.object(supervisor.runtime,'command',side_effect=command):actual()
        self.failure_closure_case(certification=True,helper_cleanup=cleanup)
        self.assertEqual(set(names),{'b'*12})

    def test_independent_unknown_helper_cleanup_does_not_skip_runtime_stop(self):
        def cleanup():raise ValueError('P2_GUARD_READONLY_CONTAINER_CLEANUP_UNKNOWN')
        self.failure_closure_case(certification=True,helper_cleanup=cleanup)
        value=json.loads((self.root/'results/p2-certification-deliberate/p2-independent-guard-outcome.json').read_bytes())
        self.assertTrue(value['recoveryCurrentContainerCleanupUncertain']);self.assertTrue(value['runtimeStopped'])

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
