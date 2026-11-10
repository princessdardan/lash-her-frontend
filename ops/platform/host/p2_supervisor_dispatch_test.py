"""Fixed source dispatch checks. Full recovery is qualified by its owned harness."""
from concurrent.futures import Future
from contextlib import suppress
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
import fcntl
import json
import os
import re
import sys
import unittest
from p2_release_broker import Broker, PhysicalObserver
from p2_release_supervisor import supervise, DEFAULT_LAYOUT, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT, ROTATION_LAYOUT, cleanup_recovery_current_containers, cleanup_rotation_readonly_containers
from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver
import p2_certification_parent as certification
import p2_release_supervisor as supervisor


class FixedDispatchTests(unittest.TestCase):
    def test_rotation_successor_live_gate_refuses_before_host_inputs(self):
        initial = self.profiled_interrupted()
        initial.update(mode=supervisor.PROFILED_CERTIFICATION_MODE,
                       certificationPlan={'rotationSuccessor': {}}, _guardLayout=supervisor.PROFILED_CERTIFICATION_LAYOUT)
        with patch.object(supervisor.migrate, 'make_plan', side_effect=AssertionError('live inputs reached')):
            with self.assertRaisesRegex(ValueError, 'ROTATION_SUCCESSOR_LIVE_UNQUALIFIED'):
                supervise(initial, broker_type=certification.P2ProfiledCertificationBroker,
                          observer_type=certification.P2CertificationPhysicalObserver,
                          observer_source=supervisor.CERTIFICATION_OBSERVER, layout=supervisor.PROFILED_CERTIFICATION_LAYOUT,
                          native_containment=certification.contain_profiled_certification_native,
                          frontend_containment=certification.contain_profiled_certification_frontend)

    def test_rotation_successor_eligibility_still_requires_the_exact_closed_staging_path(self):
        plan = {'version': 2, 'qualificationTargetProfile': certification._profiled_context(),
                'environment': 'staging', 'mode': 'mux-readiness', 'startState': 'already-closed',
                'rotationSuccessor': {'kind': 'identity-key-rotation-mixed-mount-v1'},
                'replacementRelease': {'kind': 'frontend-replacement'}}
        with patch.object(certification, 'ROTATION_SUCCESSOR_LIVE_ELIGIBLE', True):
            certification.require_profiled_certification_execution(plan)
            for change in ({'mode': 'contain-native'}, {'mode': 'native-window'}, {'environment': 'production'},
                           {'version': 2.0}, {'startState': 'qualified-ready'}, {'replacementRelease': None},
                           {'rotationSuccessor': {}}, {'qualificationTargetProfile': {}}):
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'ROTATION_SUCCESSOR_LIVE_UNQUALIFIED'):
                    certification.require_profiled_certification_execution({**plan, **change})

    def test_rotation_frontend_terminal_requires_two_current_canonical_challenges(self):
        import p2_canonical_browser_origin as canonical

        with TemporaryDirectory() as temporary:
            initial = self.profiled_interrupted(Path(temporary).resolve())
            profile = initial['qualificationTargetProfile']
            initial.update(mode=supervisor.PROFILED_CERTIFICATION_MODE, certificationActionId='owned',
                           _guardLayout=supervisor.PROFILED_CERTIFICATION_LAYOUT)
            directory = Path(initial['results']) / (supervisor.PROFILED_CERTIFICATION_LAYOUT['receiptPrefix'] + 'owned')
            directory.mkdir(mode=0o700)
            candidate = initial['candidate']
            plan = {'projectId': canonical.PROJECT, 'candidateSha256': initial['candidateSha256'],
                    'sourceCommit': candidate['sources']['frontend']['commit'], 'actionId': candidate['releaseId'],
                    'deploymentId': 'dpl_Current', 'deploymentUrl': 'https://current.vercel.app',
                    'configurationRecordSha256': '2' * 64, 'featureControls': {'owned': True}, 'writerAdmissionBinding': {'owned': 'writer'}}
            rotation = {'kind': 'identity-key-rotation-mixed-mount-v1', 'receiptSha256': '3' * 64}
            initial['certificationPlan'] = {'nativePlan': plan, 'rotationSuccessor': rotation, 'maximumSeconds': 300}
            alias = {'alias': canonical.HOST, 'projectId': canonical.PROJECT, 'deploymentId': plan['deploymentId'],
                     'redirect': False, 'deleted': False, 'microfrontends': False}
            answer = {**{key: value for key, value in plan.items() if key != 'actionId'},
                      'version': 2, 'qualificationTargetProfile': profile, 'status': 'P2_CANONICAL_BROWSER_ORIGIN_VERIFIED',
                      'environment': 'staging', 'releaseId': candidate['releaseId'], 'browserOrigin': canonical.ORIGIN,
                      'phase2ContractManifestSha256': candidate['phase2ContractManifestSha256'],
                      'authenticationOrigins': canonical.AUTHENTICATION_ORIGINS, 'aliasReadbackSha256': supervisor._canonical_sha(alias),
                      'aliasReadbacks': 2, 'aliasRedirect': False, 'workloadChallengeVerified': True, 'tlsVerified': True,
                      'probeExpiryExtended': False, 'releaseAccepted': False}
            observations = {stage: {**answer, 'protectedWorkloadSha256': supervisor._canonical_sha(stage),
                                    'observedAt': f'2026-11-09T18:00:0{index}.000Z'}
                            for index, stage in enumerate(('arm', 'terminal'))}

            def write(stage, record):
                path = directory / f'p2-rotation-successor-frontend-{stage}.json'
                path.unlink(missing_ok=True)
                supervisor.migrate.write_json(directory, path.name, record)
                return supervisor.migrate.file_hash(path.read_bytes())

            pins = {stage: write(stage, row) for stage, row in observations.items()}
            terminal = {'rotationSuccessor': rotation, 'rotationFrontendObservationSha256': pins}
            supervisor._require_rotation_certification_frontend(initial, terminal)
            for changed in ({'deploymentId': 'dpl_Predecessor'}, {'aliasReadbackSha256': '8' * 64}):
                pins['terminal'] = write('terminal', {**observations['terminal'], **changed})
                with self.assertRaisesRegex(ValueError, 'ROTATION_WORKLOAD_REFUSED'):
                    supervisor._require_rotation_certification_frontend(initial, terminal)
            pins['terminal'] = write('terminal', {**observations['terminal'],
                'protectedWorkloadSha256': observations['arm']['protectedWorkloadSha256']})
            with self.assertRaisesRegex(ValueError, 'ROTATION_WORKLOAD_REPLAYED'):
                supervisor._require_rotation_certification_frontend(initial, terminal)

    def profiled_interrupted(self, root=None):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile
        app_source, operator_source = 'a' * 40, 'b' * 40
        candidate = {'version': 3, 'qualificationTargetProfile': dict(profile), 'releaseId': 'original',
                     'environment': 'staging', 'contractPhase': 'p2',
                     'phase2ContractManifestSha256': 'sha256:' + '9' * 64,
                     'sources': {'frontend': {'commit': app_source}}}
        frontend = {'version': 2, 'qualificationTargetProfile': dict(profile), 'sourceCommit': app_source,
                    'planSha256': 'c' * 64, 'initialEpoch': '3'}
        plan = {'version': 2, 'qualificationTargetProfile': dict(profile),
                'mode': supervisor.PROFILED_INTERRUPTED_MODE, 'environment': 'staging',
                'sourceCommit': app_source, 'operatorSourceCommit': operator_source,
                'frontendPlan': frontend}
        return {'version': 2, 'qualificationTargetProfile': dict(profile),
                'mode': supervisor.PROFILED_INTERRUPTED_MODE, 'environment': 'staging',
                'sourceCommit': operator_source, 'candidate': candidate, 'candidateSha256': 'e' * 64,
                'targetSha256': 'f' * 64, 'restorationActionId': 'restoration-2',
                'reviewedPlan': plan, 'results': str(root) if root else '/private/owned',
                '_guardLayout': supervisor.PROFILED_INTERRUPTED_LAYOUT}

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_replacement_guard_checks_runtime_before_arm_and_retains_successor_after_close(self):
        import p2_profiled_known_ack_restoration_parent as interrupted

        cases = (('known-ack', True, None), ('interrupted-known-ack', True, None),
                 ('known-ack', False, None), ('interrupted-known-ack', False, None),
                 ('contain-native', True, None), ('known-ack', True, 'terminal'),
                 ('interrupted-known-ack', True, 'physical'), ('interrupted-known-ack', True, 'gateway'),
                 ('known-ack', True, 'successor'), ('known-ack', True, 'prearm-runtime'),
                 ('rotation', True, None), ('rotation', True, 'prearm-runtime'), ('rotation', True, 'terminal-runtime'))
        cleanup = supervisor.finish_failure_cleanup
        for kind, replacement, refused in cases:
            with self.subTest(kind=kind, replacement=replacement, refused=refused), TemporaryDirectory() as temporary:
                root = Path(temporary)
                initial = self.profiled_interrupted(root)
                candidate = initial['candidate']
                frontend = initial['reviewedPlan']['frontendPlan']
                if replacement:
                    frontend['replacementRelease'] = {'kind': 'frontend-replacement'}
                    if kind == 'contain-native':
                        frontend['successorRuntime'] = {'kind': 'known-ack'}
                    if kind == 'rotation':
                        frontend['rotationSuccessor'] = {'kind': 'identity-key-rotation-mixed-mount-v1'}
                        frontend.update(environment='staging', startState='already-closed')
                if kind == 'interrupted-known-ack':
                    layout = supervisor.PROFILED_INTERRUPTED_LAYOUT
                    broker = interrupted.P2ProfiledInterruptedKnownAckBroker
                    native = interrupted.contain_profiled_interrupted_native
                    contain_frontend = interrupted.contain_profiled_interrupted_frontend
                    fields = interrupted.INITIAL_FIELDS
                else:
                    layout = supervisor.PROFILED_CERTIFICATION_LAYOUT
                    broker = certification.P2ProfiledCertificationBroker
                    native = certification.contain_profiled_certification_native
                    contain_frontend = certification.contain_profiled_certification_frontend
                    frontend['mode'] = {'known-ack': 'known-ack-recovery', 'rotation': 'lifecycle-persistence'}.get(kind, kind)
                    fields = certification.profiled_certification_review_fields(frontend)
                    initial.update(mode=supervisor.PROFILED_CERTIFICATION_MODE, certificationActionId='owned',
                                   certificationPlan=frontend, _guardLayout=layout)
                initial.update(dict.fromkeys(fields - initial.keys()))
                raw_candidate = b'owned candidate\n'
                initial.update(bundle=str(root), candidateSha256=supervisor.migrate.file_hash(raw_candidate),
                               sourceSha256={supervisor.CERTIFICATION_OBSERVER: '1' * 64})
                source = Path('/opt/lash-her/operators') / initial['sourceCommit']
                lock = root / 'owned.lock'
                directory = root / (layout['receiptPrefix'] + supervisor.action_id(initial))
                directory.mkdir(mode=0o700)
                admission = {'epoch': '3', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
                closed = {'admission': admission}
                terminal = {'frontendAdmission': admission}
                raw_terminal = json.dumps(terminal).encode()
                committed = supervisor.migrate.file_hash(raw_terminal)
                (directory / layout['terminalName']).write_bytes(raw_terminal)
                (directory / 'p2-certification-frontend-session-closed.json').write_text(json.dumps(closed))
                read_input = supervisor.migrate.read_input
                events = []
                probe = {'owned': 'physical-request'}

                def record(stage, value=None):
                    def effect(*args, **kwargs):
                        events.append(stage)
                        if refused == stage:
                            raise ValueError('FIXTURE_REFUSAL')
                        return value
                    return effect

                def read(root, relative, *args):
                    if relative == 'release.candidate.json':
                        return raw_candidate
                    if relative == supervisor.CERTIFICATION_OBSERVER:
                        return b'owned observer\n'
                    return read_input(root, relative, *args)

                def watch(_child, _safety, _health, arm, *, publish_verified_arm, **_):
                    waiting = arm(probe)
                    if waiting is not None:
                        publish_verified_arm(waiting.result())
                    return record('reaped', committed)()

                def observe(_initial, _source_probe, _source, operation):
                    return record('schema' if operation == 'verify-schema' else 'physical', closed)()

                def verify_runtime(actual, actual_source):
                    self.assertIs(actual, initial)
                    self.assertEqual(actual_source, source)
                    self.assertEqual('successorRuntime' in actual['certificationPlan'], kind == 'contain-native')
                    self.assertEqual('rotationSuccessor' in actual['certificationPlan'], kind == 'rotation')
                    with lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                        fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    record('prearm-runtime')()

                def verify_rotation_terminal(actual, actual_source):
                    self.assertIs(actual, initial)
                    self.assertEqual(actual_source, source)
                    with lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                        fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    record('terminal-runtime')()

                def on_failure(actual, armed, actual_source, child, **options):
                    record('cleanup')()
                    if refused == 'prearm-runtime':
                        self.assertIsNone(armed)
                        cleanup(actual, armed, actual_source, child, **options)

                def retain(actual, actual_source, actual_terminal, actual_digest, *, kind):
                    self.assertIs(actual, initial)
                    self.assertEqual((actual_source, actual_terminal, actual_digest), (source, terminal, committed))
                    self.assertEqual(kind, 'interrupted-known-ack' if layout == supervisor.PROFILED_INTERRUPTED_LAYOUT else 'known-ack')
                    with lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                        fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    record('successor')()

                jobs = {'frontend': {}}
                verified = {'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED', 'executionEligible': False,
                            'planSha256': frontend['planSha256']}
                with (patch.multiple(supervisor, __file__=str(source / 'ops/platform/host/p2_release_supervisor.py'),
                                     LOCK=lock, _verify_guard_source=Mock(), watch_broker=Mock(side_effect=watch),
                                     members=Mock(side_effect=record('no-children', [])),
                                     _validate_profiled_certification_arm=Mock(), _validate_profiled_interrupted_arm=Mock(),
                                     _retain_profiled_certification_arm=Mock(side_effect=record('armed')),
                                     _retain_profiled_interrupted_arm=Mock(side_effect=record('armed')),
                                     require_profiled_certification_guard_arm=Mock(), require_profiled_interrupted_guard_arm=Mock(),
                                     require_profiled_interrupted_frontend_closed=Mock(return_value=closed),
                                     _profiled_certification_containers=Mock(),
                                     _observe_profiled_replacement_certification=Mock(side_effect=observe),
                                     _require_profiled_certification_terminal=Mock(side_effect=record('terminal', terminal)),
                                     _require_profiled_interrupted_terminal=Mock(side_effect=record('terminal', terminal)),
                                     _require_profiled_interrupted_gateway_after_reap=Mock(side_effect=record('gateway')),
                                     _stop_profiled_certification_group=Mock(return_value=True),
                                     cleanup_profiled_certification_containers=Mock(),
                                     _stop_profiled_certification_runtime=Mock(side_effect=AssertionError('prearm runtime stop')),
                                     finish_failure_cleanup=Mock(side_effect=on_failure)),
                      patch.object(supervisor.ctypes, 'CDLL', return_value=Mock(prctl=Mock(return_value=0))),
                      patch.object(supervisor.os, 'fork', return_value=1234),
                      patch.object(supervisor.migrate, 'make_plan', return_value=(candidate, jobs)),
                      patch.object(supervisor.migrate, 'profiled_current_job_hashes', return_value=None),
                      patch.object(supervisor.migrate, 'read_input', side_effect=read),
                      patch.object(certification, 'ROTATION_SUCCESSOR_LIVE_ELIGIBLE', True),
                      patch.object(certification, 'prepare_profiled_current_certification_input', return_value=verified),
                      patch.object(interrupted, 'prepare_profiled_interrupted_input',
                                   return_value=(initial['reviewedPlan'], None, candidate, jobs)),
                      patch.dict(sys.modules, {'p2_replacement_successor': Mock(retain_successor_runtime=retain,
                          verify_replacement_runtime_before_arm=verify_runtime,
                          verify_rotation_successor_guard_runtime=verify_rotation_terminal)})):
                    options = dict(broker_type=broker, observer_type=certification.P2CertificationPhysicalObserver,
                                   observer_source=supervisor.CERTIFICATION_OBSERVER, layout=layout,
                                   native_containment=native, frontend_containment=contain_frontend)
                    if refused is None:
                        supervise(initial, **options)
                    else:
                        with self.assertRaisesRegex(ValueError, 'FIXTURE_REFUSAL'):
                            supervise(initial, **options)
                    if refused == 'prearm-runtime':
                        supervisor._retain_profiled_certification_arm.assert_not_called()
                        supervisor._stop_profiled_certification_runtime.assert_not_called()
                        failure = json.loads((directory / 'p2-independent-guard-outcome.json').read_bytes())
                        self.assertEqual(failure['status'], 'P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE')
                        self.assertIs(failure['runtimeStopAttempted'], False)
                expected = ['schema'] if replacement else []
                if replacement and kind != 'interrupted-known-ack':
                    expected.append('prearm-runtime')
                expected.extend(('armed', 'reaped', 'no-children'))
                if kind == 'interrupted-known-ack':
                    expected.extend((*(['physical'] if replacement else []), 'terminal', 'gateway'))
                else:
                    expected.extend(('terminal', *(['physical'] if replacement else [])))
                if kind == 'rotation':
                    expected.append('terminal-runtime')
                elif replacement and kind != 'contain-native':
                    expected.append('successor')
                if refused is not None:
                    expected = expected[:expected.index(refused) + 1] + ['cleanup']
                self.assertEqual(events, expected)

    @unittest.skipUnless(sys.platform == 'linux', 'owned Linux pipe fixture')
    def test_async_guard_cannot_publish_after_the_broker_aborts_or_disconnects(self):
        probe, digest = {'owned': True}, '1' * 64
        for disposition in ('commit', 'early-commit', 'abort', 'disconnect'):
            with self.subTest(disposition=disposition):
                safety_r, safety_w = os.pipe()
                health_r, health_w = os.pipe()
                signal_r, signal_w = os.pipe()
                child = os.fork()
                if child == 0:
                    os.close(safety_r)
                    os.close(health_w)
                    os.close(signal_w)
                    try:
                        os.write(safety_w, json.dumps({'operation': 'armed', 'probe': probe}).encode() + b'\n')
                        if os.read(signal_r, 1) and disposition != 'disconnect':
                            final = {'operation': 'abort'} if disposition == 'abort' else {'operation': 'committed', 'sha256': digest}
                            os.write(safety_w, json.dumps(final).encode() + b'\n')
                    finally:
                        os._exit(0)
                os.close(safety_w)
                os.close(signal_r)
                waiting = Future()
                published = []

                def verify(request):
                    self.assertEqual(request, probe)
                    if disposition == 'commit':
                        waiting.set_result(request)
                    else:
                        os.write(signal_w, b'1')
                    return waiting

                def publish(request):
                    published.append(request)
                    os.write(signal_w, b'1')

                try:
                    options = dict(profiled_certification=True, async_arm=True, publish_verified_arm=publish)
                    if disposition == 'commit':
                        self.assertEqual(supervisor.watch_broker(child, safety_r, health_w, verify, **options), digest)
                        self.assertEqual(published, [probe])
                    else:
                        refusal = {'early-commit': 'SAFETY_COMMIT_REFUSED', 'abort': 'BROKER_ABORTED',
                                   'disconnect': 'SAFETY_TERMINAL_REFUSED'}[disposition]
                        with self.assertRaisesRegex(ValueError, refusal):
                            supervisor.watch_broker(child, safety_r, health_w, verify, **options)
                        waiting.set_result(probe)
                        self.assertEqual(published, [])
                finally:
                    for fd in (safety_r, health_r, health_w, signal_w):
                        os.close(fd)
                    with suppress(ChildProcessError):
                        os.waitpid(child, 0)

    def test_profiled_interrupted_dispatch_requires_exact_source_types_and_callbacks(self):
        import p2_profiled_known_ack_restoration_parent as parent
        class OwnedBroker(Broker):
            pass
        def native(*_):
            return {'nativeDisabled': True, 'nativeDisableAttempted': False}
        def frontend(*_):
            return {'frontendAdmissionClosed': True, 'frontendCloseAttempted': False}
        initial = self.profiled_interrupted()
        options = {'broker_type': OwnedBroker, 'observer_type': certification.P2CertificationPhysicalObserver,
                   'observer_source': supervisor.CERTIFICATION_OBSERVER,
                   'layout': supervisor.PROFILED_INTERRUPTED_LAYOUT,
                   'native_containment': native, 'frontend_containment': frontend}
        with patch.object(parent, 'P2ProfiledInterruptedKnownAckBroker', OwnedBroker, create=True), \
             patch.object(parent, 'contain_profiled_interrupted_native', native, create=True), \
             patch.object(parent, 'contain_profiled_interrupted_frontend', frontend, create=True), \
             patch.object(supervisor.os, 'geteuid', return_value=1), \
             patch.object(supervisor.migrate, 'make_plan', side_effect=AssertionError('unexpected plan I/O')):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(dict(initial), **options)
            for mismatch in ({'broker_type': Broker}, {'observer_type': PhysicalObserver},
                             {'observer_source': 'ops/platform/p2-profiled-current-probe.mjs'},
                             {'layout': supervisor.PROFILED_CERTIFICATION_LAYOUT},
                             {'native_containment': frontend}, {'frontend_containment': native},
                             {'frontend_containment': None}):
                with self.subTest(mismatch=tuple(mismatch)), \
                     self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                    supervise(dict(initial), **{**options, **mismatch})

    def test_profiled_interrupted_arm_binds_app_and_operator_sources_and_is_durable(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial = self.profiled_interrupted(root)
            directory = root / 'p2-profiled-known-ack-restoration-restoration-2'
            directory.mkdir(mode=0o700)
            probe = {'fixed': 'physical-request'}
            record = supervisor._profiled_interrupted_arm_record(initial, probe)
            self.assertEqual(record['sourceCommit'], 'a' * 40)
            self.assertEqual(record['operatorSourceCommit'], 'b' * 40)
            with self.assertRaises(FileNotFoundError):
                supervisor.require_profiled_interrupted_guard_arm(initial, probe)
            supervisor._retain_profiled_interrupted_arm(initial, probe)
            self.assertEqual(supervisor.require_profiled_interrupted_guard_arm(initial, probe), record)
            with self.assertRaisesRegex(ValueError, 'GUARD_ARM_REQUIRED'):
                supervisor.require_profiled_interrupted_guard_arm(initial, {'fixed': 'changed'})
            initial['reviewedPlan']['sourceCommit'] = initial['sourceCommit']
            with self.assertRaisesRegex(ValueError, 'SOURCE_BINDING_REQUIRED'):
                supervisor._profiled_interrupted_arm_record(initial, probe)

    def test_profiled_interrupted_arm_requires_the_exact_fresh_frontend_plan(self):
        initial = self.profiled_interrupted()
        profile = {'version': 2, 'qualificationTargetProfile': initial['qualificationTargetProfile']}
        target = {'host': 'fixture.invalid', 'port': 5432, 'database': 'fixture', 'user': 'runtime',
                  'serverMajor': 18, 'qualificationTargetProfile': initial['qualificationTargetProfile']}
        owner, role = {'name': 'owner', 'oid': '11'}, {'name': 'runtime', 'oid': '22'}
        producer = {'producerSha256': '1' * 64, 'role': role}
        history = {**profile, 'target': target, 'retiredLogins': []}
        frontend = initial['reviewedPlan']['frontendPlan']
        frontend.update(certificationActionId=initial['restorationActionId'], candidateSha256=initial['candidateSha256'],
                        targetSha256=initial['targetSha256'], nativePlan={'target': target, 'producer': producer})
        job = {**profile, 'releaseId': 'original', 'sourceCommit': 'a' * 40, 'target': target}
        initial.update(owner=owner, inventory={'producers': [producer], 'historicalLogins': history})
        receipt = {**profile, **supervisor.migrate.contract_identity(initial['candidate']), 'target': target,
                   'owner': owner, 'runtime': role, 'status': 'P2_CERTIFICATION_DATABASE_CURRENT',
                   'service': 'frontend', 'releaseId': 'original', 'sourceCommit': 'a' * 40,
                   'candidateSha256': initial['candidateSha256'], 'targetSha256': initial['targetSha256'],
                   'certificationActionId': initial['restorationActionId'], 'planSha256': frontend['planSha256'],
                   'sqlReplayed': False, 'trafficAuthorized': False, 'schemaVerified': True,
                   'runtimeRoleVerified': True, 'journalSha256': '3' * 64, 'witnessSha256': '4' * 64,
                   'admission': {'epoch': '3', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}
        probe = {**profile, 'marker': '2' * 64, 'backendPid': 123, 'backendStart': 'fixture-start',
                 'job': job, 'baseline': {}, 'owner': owner, 'producers': [producer],
                 'historicalLogins': history, 'plan': frontend, 'receipt': receipt}
        supervisor._validate_profiled_interrupted_arm(initial, probe, {'job': job, 'schema': b'{}'})
        for change in ({'plan': {**frontend, 'initialEpoch': '4'}},
                       {'receipt': {**receipt, 'admission': {**receipt['admission'], 'uncertain': 1}}},
                       {'backendPid': True}):
            with self.subTest(change=tuple(change)), self.assertRaisesRegex(ValueError, 'GUARD_PROBE_REQUIRED'):
                supervisor._validate_profiled_interrupted_arm(initial, {**probe, **change}, {'job': job, 'schema': b'{}'})
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial['results'] = str(root)
            directory = root / 'p2-profiled-known-ack-restoration-restoration-2'
            directory.mkdir(mode=0o700)
            closed = {**profile, 'status': 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED', 'environment': 'staging',
                      'releaseId': 'original', 'sourceCommit': 'a' * 40, 'targetSha256': initial['targetSha256'],
                      'marker': probe['marker'], 'backendPid': probe['backendPid'], 'backendStart': probe['backendStart'],
                      'admission': receipt['admission'], 'journalSha256': receipt['journalSha256'],
                      'witnessSha256': receipt['witnessSha256'], 'backendAbsent': True,
                      'migrationLockReleased': True, 'nonceLockReleased': True}
            supervisor.migrate.write_json(directory, supervisor.PROFILED_INTERRUPTED_FRONTEND_CLOSED, closed)
            self.assertEqual(supervisor.require_profiled_interrupted_frontend_closed(initial, probe), closed)
            (directory / supervisor.PROFILED_INTERRUPTED_FRONTEND_CLOSED).unlink()
            supervisor.migrate.write_json(directory, supervisor.PROFILED_INTERRUPTED_FRONTEND_CLOSED,
                                          {**closed, 'backendAbsent': False})
            with self.assertRaisesRegex(ValueError, 'SESSION_CLOSE_REQUIRED'):
                supervisor.require_profiled_interrupted_frontend_closed(initial, probe)

    def test_profiled_interrupted_mount_selection_accepts_only_original_b_or_c(self):
        import p2_known_ack_interrupted_restoration as interrupted
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial = self.profiled_interrupted(root)
            initial.update(configuration=str(root / 'configuration'), configurationSha256={'runtime.json': '1' * 64},
                           interruptedRestoration={'originalRecoveryActionId': 'replacement-b'})
            initial['candidate']['runtime'] = {'composeSha256': 'sha256:' + '2' * 64}
            input_directory = root / 'configuration'
            old = root / 'original-mounted'
            prior = root / 'p2-profiled-known-ack-replacement-b' / 'runtime-known-ack' / 'configuration'
            action_directory = root / 'p2-profiled-known-ack-restoration-restoration-2'
            action_directory.mkdir(mode=0o700)
            current = action_directory / 'runtime-interrupted' / 'configuration'
            for directory in (input_directory, old, prior, current):
                directory.mkdir(parents=True, mode=0o700)
            selection = {'originalCertificationActionId': 'certification-a',
                         'originalRecoveryActionId': 'replacement-b', 'causalReceiptSha256': {}}
            with patch.object(interrupted, 'ROOT', root), \
                 patch.object(interrupted, '_profiled_selection', return_value=selection), \
                 patch.object(interrupted, '_profiled_files', return_value={}), \
                 patch.object(interrupted, '_profiled_causal', return_value=(None, None, {
                     'binding': {'configurationDirectory': str(old)}})), \
                 patch.object(interrupted, 'root_path', side_effect=lambda value: Path(value)), \
                 patch.object(supervisor, 'verify_guard_boundary'), \
                 patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']), \
                 patch.object(supervisor.migrate, 'read_input', return_value=b'compose'), \
                 patch.object(supervisor.migrate, 'file_hash', return_value='2' * 64):
                allowed = supervisor._profiled_interrupted_allowed_configurations(initial, root)
            self.assertEqual(allowed, (old, prior, current))
            self.assertNotIn(input_directory, allowed)
            with patch.object(supervisor, '_profiled_interrupted_allowed_configurations', return_value=allowed):
                def command(args, *_):
                    if args[1:3] == ['container', 'ls']:
                        return 'a' * 12 + '|gateway\n' + 'b' * 12 + '|course-api\n'
                    identity = args[-1]
                    directory = old if identity == 'a' * 12 else root / 'foreign'
                    service = 'gateway' if identity == 'a' * 12 else 'course-api'
                    return f'{directory}|{directory / "compose.yaml"}|{service}'
                with patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.runtime, 'command', side_effect=command), \
                     patch.object(supervisor.p2_prior_gateway, '_mounted_configuration', return_value=old), \
                     patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']):
                    with self.assertRaisesRegex(ValueError, 'GUARD_MOUNT_REFUSED'):
                        supervisor._profiled_interrupted_runtime_inventory(initial, root)
                with patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.runtime, 'command', side_effect=command), \
                     patch.object(supervisor.p2_prior_gateway, '_mounted_configuration', return_value=root / 'foreign'), \
                     patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']):
                    with self.assertRaisesRegex(ValueError, 'GATEWAY_RUNTIME_CHANGED'):
                        supervisor._profiled_interrupted_runtime_inventory(initial, root)
                def no_gateway(args, *_):
                    if args[1:3] == ['container', 'ls']:
                        return 'b' * 12 + '|course-api\n'
                    return f'{current}|{current / "compose.yaml"}|course-api'
                with patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.runtime, 'command', side_effect=no_gateway), \
                     patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']):
                    without_gateway = supervisor._profiled_interrupted_runtime_inventory(initial, root)
                self.assertEqual(without_gateway, {
                    'course-api': {'containerId': 'b' * 12, 'configuration': str(current)}})
                result = {}
                with patch.object(supervisor, '_profiled_interrupted_runtime_inventory', return_value={
                         'gateway': {'containerId': 'a' * 12, 'configuration': str(old)}}), \
                     patch.object(supervisor, '_profiled_interrupted_running_ids', return_value=[]), \
                     patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.migrate, 'suspend_runtime') as suspend:
                    supervisor._stop_profiled_interrupted_runtime(initial, root, result)
                suspend.assert_called_once_with('staging', supervisor.runtime.SAFE_ENV)
                self.assertIs(result['runtimeStopped'], True)
                self.assertEqual(result['selectedRuntimeConfiguration'], str(old))
                result = {}
                with patch.object(supervisor, '_profiled_interrupted_runtime_inventory', return_value={
                         'course-api': {'containerId': 'b' * 12, 'configuration': str(current)}}), \
                     patch.object(supervisor, '_profiled_interrupted_running_ids', return_value=[]), \
                     patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.migrate, 'suspend_runtime') as suspend:
                    supervisor._stop_profiled_interrupted_runtime(initial, root, result)
                suspend.assert_called_once_with('staging', supervisor.runtime.SAFE_ENV)
                self.assertIs(result['runtimeStopped'], True)
                self.assertEqual(result['selectedRuntimeConfigurations'], [str(current)])

    def test_profiled_interrupted_containment_runs_only_after_reap_and_keeps_failed_frontend_unknown(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial = self.profiled_interrupted(root)
            initial.update(configuration=str(root / 'configuration'), configurationSha256={},
                           interruptedRestoration={'originalRecoveryActionId': 'replacement-b'},
                           _guardLockDescriptor=3)
            (root / 'p2-profiled-known-ack-restoration-restoration-2').mkdir(mode=0o700)
            events = []
            def native(*_):
                events.append('native')
                return {'nativeDisabled': True, 'nativeDisableAttempted': True}
            def frontend(*_):
                events.append('frontend')
                raise RuntimeError('private frontend readback failed')
            def stop(*_):
                events.append('runtime')
                return None
            armed = {'physical': 'arm'}
            supervisor._retain_profiled_interrupted_arm(initial, armed)
            with patch.object(supervisor, '_stop_profiled_certification_group', return_value=True), \
                 patch.object(supervisor, 'verify_guard_boundary'), \
                 patch.object(supervisor, 'cleanup_profiled_certification_containers'), \
                 patch.object(supervisor, '_stop_profiled_interrupted_runtime', side_effect=stop), \
                 patch.object(supervisor, 'capture_gateway_before_stop', side_effect=AssertionError('ordinary gate selected')), \
                 patch.object(supervisor, 'close_gateway', side_effect=AssertionError('ordinary close selected')):
                result = supervisor.fail_closed(initial, armed, root, group=123,
                                                native_containment=native, frontend_containment=frontend)
            self.assertEqual(events, ['native', 'frontend', 'runtime'])
            self.assertIs(result['workerProcessesQuiesced'], True)
            self.assertIs(result['nativeDisabled'], True)
            self.assertIs(result['frontendAdmissionClosed'], None)
            self.assertIs(result['frontendContainmentUncertain'], True)
            self.assertIs(result['trafficAuthorized'], None)
            retained = (root / 'p2-profiled-known-ack-restoration-restoration-2' /
                        'p2-independent-guard-outcome.json').read_text()
            self.assertNotIn('private frontend readback failed', retained)
            direct = {'workerProcessesQuiesced': True}
            with patch.object(supervisor, 'verify_guard_boundary'), \
                 patch.object(supervisor, 'cleanup_profiled_certification_containers'), \
                 patch.object(supervisor, '_stop_profiled_interrupted_runtime'), \
                 patch.object(supervisor, 'require_profiled_interrupted_guard_arm'), \
                 patch.object(supervisor, 'capture_gateway_before_stop', side_effect=AssertionError('ordinary gate selected')):
                supervisor.contain_profiled_interrupted_after_reap(
                    initial, armed, root, direct,
                    lambda *_: (_ for _ in ()).throw(RuntimeError('native failed')),
                    lambda *_: (_ for _ in ()).throw(RuntimeError('frontend failed')))
            self.assertIsNone(direct['nativeDisabled'])
            self.assertIsNone(direct['frontendAdmissionClosed'])
            self.assertIs(direct['nativeContainmentUncertain'], True)
            self.assertIs(direct['frontendContainmentUncertain'], True)

    def test_profiled_interrupted_terminal_is_the_verbatim_runtime_receipt(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial = self.profiled_interrupted(root)
            directory = root / 'p2-profiled-known-ack-restoration-restoration-2'
            runtime_output = directory / 'runtime-interrupted'
            runtime_output.mkdir(parents=True, mode=0o700)
            directory.chmod(0o700)
            zero = {'newWork': 0, 'recovery': 0}
            stopped = {'admission': {'newWork': False, 'recovery': False, 'active': zero,
                                     'uncertain': {'newWork': 0, 'recovery': 1}}}
            new = {'admission': {'newWork': False, 'recovery': False, 'active': zero, 'uncertain': zero}}
            databases = {'course': {'current': True}, 'community': {'current': True}}
            terminal = {'version': 2, 'qualificationTargetProfile': initial['qualificationTargetProfile'],
                        **supervisor.migrate.contract_identity(initial['candidate']),
                        'status': supervisor.PROFILED_INTERRUPTED_LAYOUT['terminalStatus'],
                        'environment': 'staging', 'releaseId': 'original',
                        'restorationActionId': initial['restorationActionId'],
                        'candidateSha256': initial['candidateSha256'], 'frontier': 'original-stopped-one',
                        'apiDatabases': databases, 'currentApiDatabasesAfter': databases,
                        'stoppedGateway': stopped, 'newGateway': new, 'runtimeReplacements': 1,
                        'frontendSqlApplied': False, 'trafficAuthorized': False, 'sqlReplayed': False,
                        'migrationsExecuted': False, 'rolePreparationRepeated': False, 'newWorkOpened': False,
                        'recoveryOpened': False, 'nativeDisabled': True}
            supervisor.migrate.write_json(runtime_output, 'profiled-interrupted-runtime-outcome.json', terminal)
            raw = supervisor.migrate.read_input(runtime_output, 'profiled-interrupted-runtime-outcome.json')
            self.assertEqual(supervisor._require_profiled_interrupted_terminal(
                initial, raw, supervisor.migrate.file_hash(raw)), terminal)
            changed = json.dumps({**terminal, 'trafficAuthorized': True}, separators=(',', ':')).encode() + b'\n'
            with self.assertRaisesRegex(ValueError, 'RUNTIME_RECEIPT_CHANGED'):
                supervisor._require_profiled_interrupted_terminal(initial, changed,
                                                                  supervisor.migrate.file_hash(changed))

    def test_profiled_interrupted_terminal_rechecks_actual_gateway_and_lineage_after_reap(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            initial = self.profiled_interrupted(root)
            initial.update(hostMachineId='1' * 32, configurationSha256={})
            directory = root / 'p2-profiled-known-ack-restoration-restoration-2'
            directory.mkdir(mode=0o700)
            snapshot = directory / 'runtime-interrupted' / 'configuration'
            zero = {'newWork': 0, 'recovery': 0}
            gateway = {'binding': {'configurationDirectory': str(snapshot)},
                       'process': {'containerId': 'd' * 64},
                       'admission': {'newWork': False, 'recovery': False, 'active': zero, 'uncertain': zero}}
            lineage = {'protocol': supervisor.p2_prior_gateway.PROTOCOL, 'state': 'running-observed',
                       'actionId': initial['restorationActionId'], 'candidateSha256': initial['candidateSha256'],
                       'process': gateway['process'], 'binding': gateway['binding']}
            terminal = {'newGateway': gateway}
            with patch.object(supervisor, 'verify_guard_boundary'), \
                 patch.object(supervisor.p2_prior_gateway, 'observe_prior_gateway', return_value=gateway) as observe, \
                 patch.object(supervisor.p2_prior_gateway, '_read_lineage', return_value=lineage) as retained:
                supervisor._require_profiled_interrupted_gateway_after_reap(initial, root, terminal)
                observe.return_value = {**gateway, 'process': {'containerId': 'e' * 64}}
                with self.assertRaisesRegex(ValueError, 'GUARD_NEW_GATEWAY_CHANGED'):
                    supervisor._require_profiled_interrupted_gateway_after_reap(initial, root, terminal)
                observe.return_value = gateway
                retained.return_value = {**lineage, 'actionId': 'older-action'}
                with self.assertRaisesRegex(ValueError, 'GUARD_NEW_GATEWAY_CHANGED'):
                    supervisor._require_profiled_interrupted_gateway_after_reap(initial, root, terminal)

    def test_profiled_fault_guard_removes_only_the_original_lease_from_the_original_mount(self):
        from p2_certification_fault import LEASE
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            configuration = root / 'configuration'
            admission = configuration / 'admission'
            fault = root / 'p2-profiled-current-certification-owned' / 'fault'
            admission.mkdir(parents=True, mode=0o700)
            fault.parent.mkdir(mode=0o700)
            fault.mkdir(mode=0o700)
            mount = admission.stat()
            selection = {'stageId': 'owned-503', 'receiver': 'course', 'commandSha256': 'a' * 64}
            plan = {'mode': 'fault-before-upstream', 'faultSelection': selection,
                    'configurationCanonicalSha256': 'b' * 64, 'gatewayProcessSha256': 'c' * 64}
            lease = {'version': 1, 'releaseId': 'original', 'candidateSha256': 'd' * 64, 'mode': '503-before-upstream',
                     'stageId': selection['stageId'], 'receiver': selection['receiver'], 'sourceWitnessSha256': selection['commandSha256'],
                     'configurationSha256': plan['configurationCanonicalSha256'], 'gatewayProcessSha256': plan['gatewayProcessSha256']}
            raw = json.dumps(lease).encode() + b'\n'
            retained = {'version': 2, 'qualificationTargetProfile': dict(profile), 'stageId': selection['stageId'], 'lease': lease,
                        'leaseSha256': supervisor.migrate.file_hash(raw), 'admissionDirectoryDevice': mount.st_dev,
                        'admissionDirectoryInode': mount.st_ino}
            initial = {'version': 2, 'qualificationTargetProfile': dict(profile), 'mode': supervisor.PROFILED_CERTIFICATION_MODE,
                       'certificationPlan': plan, 'certificationActionId': 'owned', 'candidate': {'releaseId': 'original'},
                       'candidateSha256': lease['candidateSha256'], 'configurationSha256': {}, 'configuration': str(configuration),
                       'results': str(root), '_guardLayout': supervisor.PROFILED_CERTIFICATION_LAYOUT}
            path, intent = admission / LEASE, fault / 'fault-arm-intent.json'
            with patch.object(supervisor, 'verify_guard_boundary'), patch.object(supervisor.staging_state, 'configuration_hashes', return_value={}):
                path.write_bytes(raw)
                intent.write_text(json.dumps({**retained, 'admissionDirectoryInode': mount.st_ino + 1}))
                with self.assertRaisesRegex(ValueError, 'FOREIGN_FAULT_LEASE'):
                    supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(path.read_bytes(), raw)
                intent.write_text(json.dumps(retained))
                path.write_bytes(raw + b' ')
                with self.assertRaisesRegex(ValueError, 'FOREIGN_FAULT_LEASE'):
                    supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(path.read_bytes(), raw + b' ')
                path.write_bytes(raw)
                supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertFalse(path.exists())
                supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(json.loads(intent.read_bytes()), retained)
                plan['mode'] = 'known-ack-recovery'
                path.write_bytes(raw)
                with self.assertRaisesRegex(ValueError, 'FOREIGN_FAULT_LEASE'):
                    supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertEqual(path.read_bytes(), raw)
                lease['mode'] = 'drop-after-ack'
                raw = json.dumps(lease).encode() + b'\n'
                intent.write_text(json.dumps({**retained, 'leaseSha256': supervisor.migrate.file_hash(raw)}))
                path.write_bytes(raw)
                supervisor.remove_profiled_certification_fault_lease(initial, root)
                self.assertFalse(path.exists())

    def test_profiled_certification_requires_all_exact_source_types_and_both_callbacks(self):
        class OwnedBroker(Broker):
            pass
        def native(*_):
            raise AssertionError('native action')
        def frontend(*_):
            raise AssertionError('frontend action')
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        initial = {'version': 2, 'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
                   'mode': supervisor.PROFILED_CERTIFICATION_MODE, 'candidate': {'releaseId': 'original'},
                   'certificationActionId': 'certification-2', '_guardLayout': supervisor.CERTIFICATION_LAYOUT}
        options = {'broker_type': OwnedBroker, 'observer_type': certification.P2CertificationPhysicalObserver,
                   'observer_source': supervisor.CERTIFICATION_OBSERVER, 'layout': supervisor.PROFILED_CERTIFICATION_LAYOUT,
                   'native_containment': native, 'frontend_containment': frontend}
        with patch.object(certification, 'P2ProfiledCertificationBroker', OwnedBroker, create=True), \
             patch.object(certification, 'contain_profiled_certification_native', native, create=True), \
             patch.object(certification, 'contain_profiled_certification_frontend', frontend, create=True), \
             patch.object(supervisor.os, 'geteuid', return_value=1), \
             patch.object(supervisor.migrate, 'make_plan', side_effect=AssertionError('unexpected plan I/O')):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(dict(initial), **options)
            for mismatch in ({'broker_type': Broker}, {'observer_type': PhysicalObserver},
                             {'observer_source': 'ops/platform/p2-profiled-current-probe.mjs'},
                             {'layout': CERTIFICATION_LAYOUT}, {'native_containment': frontend},
                             {'frontend_containment': None}, {'frontend_containment': lambda *_: None}):
                with self.subTest(mismatch=tuple(mismatch)), self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                    supervise(dict(initial), **{**options, **mismatch})
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(dict(initial))
            with self.assertRaisesRegex(ValueError, 'PROFILE_REQUIRED'):
                supervise({key: value for key, value in initial.items() if key != 'qualificationTargetProfile'}, **options)

    def test_profiled_certification_cleanup_only_touches_fixed_namespaces(self):
        inventory = {'a' * 12: '/lash-p2-certification-observer-' + '1' * 32,
                     'b' * 12: '/lash-p2-certification-api-check-course-' + '2' * 32,
                     'c' * 12: '/lash-p2-profiled-certification-guard-close-' + '3' * 32,
                     'd' * 12: '/lash-p2-profiled-certification-guard-close-' + '3' * 32 + '-foreign',
                     'e' * 12: '/lash-p2-profiled-current-observer-' + '4' * 32,
                     'f' * 12: '/lash-p2-profiled-certification-image-check-' + '5' * 32}
        calls = []
        def command(args, *_):
            calls.append(args)
            if args[1:3] == ['rm', '--force']:
                del inventory[args[-1]]
                return ''
            pattern = next(value.removeprefix('name=') for value in args if value.startswith('name='))
            return '\n'.join(identity for identity, name in inventory.items() if re.fullmatch(pattern, name))
        with patch.object(supervisor.runtime, 'command', side_effect=command):
            with self.assertRaisesRegex(ValueError, 'CONTAINER_REMAINS'):
                supervisor._profiled_certification_containers(remove=False)
            self.assertTrue(all(args[1:3] == ['container', 'ls'] for args in calls))
            supervisor.cleanup_profiled_certification_containers()
        self.assertEqual(set(inventory), {'d' * 12, 'e' * 12})
        self.assertEqual(sum(args[1:3] == ['rm', '--force'] for args in calls), 4)

    def test_private_json_cannot_select_recovery_program_or_layout(self):
        initial = {'candidate': {'releaseId': 'original'}, '_guardLayout': RECOVERY_LAYOUT,
                   '_guardObserverSource': 'ops/platform/unreviewed.mjs'}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        self.assertEqual(initial['_guardObserverSource'], 'ops/platform/p2-frontend-live-probe.mjs')

    def test_only_fixed_source_recovery_dispatch_is_accepted(self):
        class RecoveryBroker(Broker): pass
        class RecoveryObserver(PhysicalObserver): pass
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-post-sql-recovery', 'recoveryActionId': 'recovery-2'}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial, broker_type=RecoveryBroker, observer_type=RecoveryObserver,
                          observer_source='ops/platform/p2-recovery-current-probe.mjs', layout=RECOVERY_LAYOUT)
        self.assertEqual(initial['_guardLayout'], RECOVERY_LAYOUT)
        for source, layout in [('ops/platform/arbitrary.mjs', RECOVERY_LAYOUT),
                               ('ops/platform/p2-recovery-current-probe.mjs', {**RECOVERY_LAYOUT, 'terminalName': '../out.json'})]:
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, broker_type=RecoveryBroker, observer_type=RecoveryObserver, observer_source=source, layout=layout)

    def test_default_release_selection_preserves_pending_sql_and_same_source_requirements(self):
        initial = {'candidate': {'contractPhase': 'p2', 'environment': 'staging', 'sources': {'frontend': {'commit': 'a'*40}}}, 'sourceCommit': 'a'*40}
        broker = Broker(initial, lambda _: None)
        broker.bundle = broker.configuration = broker.source = Path('/owned')
        jobs = {'frontend': {'job': {'target': {'approvedPendingTags': ['p2']}}}, 'course': {}, 'community': {}}
        with patch('p2_release_broker.runtime.make_plan', return_value=(initial['candidate'],jobs,{},b'compose')):
            self.assertEqual(len(broker.select_release(initial)), 4)
            initial['sourceCommit'] = 'b'*40
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_BINDING_REFUSED'): broker.select_release(initial)
            initial['sourceCommit'] = 'a'*40
            jobs['frontend']['job']['target']['approvedPendingTags'] = []
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_BINDING_REFUSED'): broker.select_release(initial)

    def test_certification_dispatch_requires_source_callable_and_cannot_be_selected_by_json(self):
        class CertificationBroker(Broker): pass
        class CertificationObserver(PhysicalObserver): pass
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-bounded-certification', 'certificationActionId': 'certification-2',
                   'nativeContainment': 'operator-selected-function', '_guardLayout': CERTIFICATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        options = {'broker_type': CertificationBroker, 'observer_type': CertificationObserver,
                   'observer_source': 'ops/platform/p2-certification-current-probe.mjs', 'layout': CERTIFICATION_LAYOUT}
        for callback in (None, 'operator-selected-function', {'held': True}):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, **options, native_containment=callback)
        callback = lambda *_: {'nativeDisabled': True, 'nativeDisableAttempted': False}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial, **options, native_containment=callback)
        self.assertEqual(initial['_guardLayout'], CERTIFICATION_LAYOUT)
        self.assertEqual(initial['_guardObserverSource'], options['observer_source'])
        for changed in ({**options, 'observer_source': 'ops/platform/arbitrary.mjs'},
                        {**options, 'layout': {**CERTIFICATION_LAYOUT, 'terminalName': '../out.json'}}):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, **changed, native_containment=callback)
        for layout in (DEFAULT_LAYOUT, RECOVERY_LAYOUT):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial, layout=layout, native_containment=callback)

    def test_recovery_readonly_helper_cleanup_accepts_only_docker_observed_ids(self):
        commands = []
        def command(args, *_):
            commands.append(args)
            if len(commands) == 1: return 'a'*12 + '\n'
            return ''
        with patch('p2_release_supervisor.runtime.command', side_effect=command): cleanup_recovery_current_containers()
        self.assertEqual(commands[1], ['docker', 'rm', '--force', 'a'*12])
        self.assertIn('name=^/lash-p2-recovery-current-(course|community)-[a-f0-9]{32}$',commands[0])
        with patch('p2_release_supervisor.runtime.command', return_value='invalid id'):
            with self.assertRaisesRegex(ValueError,'RECOVERY_CONTAINER_ID_REFUSED'): cleanup_recovery_current_containers()

    def test_rotation_dispatch_is_exact_and_cannot_be_selected_by_private_json(self):
        initial = {'version': 1, 'candidate': {'releaseId': 'original'}, 'mode': 'p2-identity-key-rotation',
                   'rotationActionId': 'p2-key-rotation-owned', '_guardLayout': ROTATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                supervise(initial)
        options = {'broker_type': P2IdentityRotationBroker,
                   'observer_type': P2IdentityRotationPhysicalObserver,
                   'observer_source': 'ops/platform/p2-recovery-current-probe.mjs',
                   'layout': ROTATION_LAYOUT}
        with self.assertRaisesRegex(ValueError, 'ROTATION_LIVE_EXECUTION_UNQUALIFIED'):
            supervise(initial, **options)
        with patch('p2_identity_key_rotation_parent.LIVE_ELIGIBLE', True):
            with patch('p2_release_supervisor.os.geteuid', return_value=1):
                with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                    supervise(initial, **options)
            self.assertEqual(initial['_guardLayout'], ROTATION_LAYOUT)
            for changed in ({**options, 'observer_source': 'ops/platform/p2-frontend-live-probe.mjs'},
                            {**options, 'layout': {**ROTATION_LAYOUT, 'terminalName': '../out.json'}},
                            {**options, 'broker_type': Broker},
                            {**options, 'observer_type': PhysicalObserver}):
                with self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                    supervise(initial, **changed)

    def test_rotation_readonly_cleanup_accepts_only_fixed_names_and_docker_ids(self):
        commands = []
        def command(args, *_):
            commands.append(args)
            if len(commands) in (1, 4): return ('a' if len(commands) == 1 else 'b') * 12 + '\n'
            return ''
        with patch('p2_release_supervisor.runtime.command', side_effect=command):
            cleanup_rotation_readonly_containers()
        self.assertEqual(commands[1], ['docker', 'rm', '--force', 'a'*12])
        self.assertEqual(commands[4], ['docker', 'rm', '--force', 'b'*12])
        self.assertIn('rotation-current-(course|community)', commands[0][-3])
        self.assertIn('rotation-close-', commands[3][-3])
        with patch('p2_release_supervisor.runtime.command', return_value='not-an-id'):
            with self.assertRaisesRegex(ValueError, 'ROTATION_CONTAINER_ID_REFUSED'):
                cleanup_rotation_readonly_containers()

    def test_both_fixed_namespaces_are_cleaned_after_scope_loss_and_foreign_names_are_preserved(self):
        names={'a'*12:'/lash-p2-recovery-current-course-'+'1'*32,'b'*12:'/lash-p2-certification-observer-'+'2'*32,
            'c'*12:'/lash-p2-certification-observer-'+'2'*31,'d'*12:'/lash-p2-certification-observer-'+'A'*32,
            'e'*12:'/lash-p2-certification-observer-'+'3'*32+'-foreign','f'*12:'/lash-her-staging-gateway'}
        calls=[]
        def command(args,*_):
            calls.append(args)
            if args[:3]==['docker','rm','--force']:names.pop(args[-1]);return ''
            pattern=next(value.removeprefix('name=') for value in args if value.startswith('name='))
            return '\n'.join(identity for identity,name in names.items() if re.fullmatch(pattern,name))
        # Neither cleanup branch receives or calls a mutator scope. Docker
        # daemon inventory/removal is source-fixed and independently observed.
        with patch('p2_release_supervisor.runtime.command',side_effect=command):cleanup_recovery_current_containers()
        self.assertEqual(set(names),{'c'*12,'d'*12,'e'*12,'f'*12})
        self.assertEqual(sum(args[:3]==['docker','rm','--force'] for args in calls),2)
        self.assertEqual(sum(args[:3]==['docker','container','ls'] for args in calls),4)

    def test_failed_removal_or_readback_stays_unknown_and_does_not_skip_other_namespace(self):
        for kind in ('rm','readback'):
            calls=[];seen={'recovery':0,'certification':0}
            def command(args,*_):
                calls.append(args)
                if args[:3]==['docker','rm','--force']:
                    if args[-1]=='a'*12 and kind=='rm':raise RuntimeError('private error must not escape')
                    return ''
                mode='certification' if 'certification-observer' in ' '.join(args) else 'recovery';seen[mode]+=1
                if mode=='recovery' and seen[mode]==2 and kind=='readback':raise RuntimeError('private readback')
                return ('a'*12 if mode=='recovery' else 'b'*12) if seen[mode]==1 else ''
            with self.subTest(kind=kind),patch('p2_release_supervisor.runtime.command',side_effect=command):
                with self.assertRaisesRegex(ValueError,'CLEANUP_UNKNOWN'):cleanup_recovery_current_containers()
            self.assertEqual(seen,{'recovery':2,'certification':2});self.assertIn(['docker','rm','--force','b'*12],calls)


class ManagedRotationSupervisorTests(unittest.TestCase):
    def setUp(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        import p2_identity_key_rotation_parent as parent
        import p2_identity_rotation_replacement as custody

        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.profile = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        self.parent, self.custody_module = parent, custody
        self.action, self.source_commit = 'p2-key-rotation-owned', 'a' * 40
        self.candidate = {'releaseId': 'original'}
        self.source = Path('/opt/lash-her/operators') / self.source_commit
        self.raw_candidate = b'owned candidate\n'
        self.raw_observer = b'owned observer\n'
        self.directory = self.root / ('p2-identity-key-rotation-' + self.action)
        self.directory.mkdir(mode=0o700)
        self.lock = self.root / 'owned.lock'
        self.candidate_sha = supervisor.migrate.file_hash(self.raw_candidate)
        self.review = {'qualificationTargetProfile': self.profile, 'originalReleaseId': 'original', 'certificationActionId': self.action,
                       'sourceCommit': self.source_commit, 'candidateSha256': self.candidate_sha, 'targetSha256': 'b' * 64,
                       'planSha256': 'c' * 64, 'initialEpoch': '12', 'replacementRelease': {'owned': True}}
        self.rotation = {'actionId': self.action, 'bindingSha256': 'd' * 64, 'candidateSha256': self.candidate_sha,
                         'sourceCommit': self.source_commit, 'configuration': {'current-only': {'sha256': 'e' * 64}}}
        self.initial = {'version': 2, 'qualificationTargetProfile': self.profile, 'mode': 'p2-identity-key-rotation',
                        'environment': 'staging', 'rotationActionId': self.action, 'sourceCommit': self.source_commit,
                        'candidate': self.candidate, 'candidateSha256': self.candidate_sha, 'bundle': str(self.root),
                        'results': str(self.root), 'rotationPlan': self.rotation,
                        'sourceSha256': {supervisor.CERTIFICATION_OBSERVER: supervisor.migrate.file_hash(self.raw_observer)},
                        'frontendCustody': {'certificationPlan': self.review, 'apiJobSha256': {'frontend': 'f' * 64}},
                        '_guardLayout': ROTATION_LAYOUT, '_guardObserverSource': supervisor.CERTIFICATION_OBSERVER}
        self.probe = {'qualificationTargetProfile': self.profile, 'plan': self.review, 'receipt': {
            'candidateSha256': self.candidate_sha, 'targetSha256': 'b' * 64, 'planSha256': 'c' * 64}}
        self.closed = {'admission': {'epoch': '18', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}
        post_removal = {'phase': 'post-removal'}
        (self.directory / 'frontend-post-removal').mkdir(mode=0o700)
        supervisor.migrate.write_json(self.directory / 'frontend-post-removal', 'rotation-frontend-browser-source.json', post_removal)
        prepared = {'version': 2, 'qualificationTargetProfile': self.profile, 'status': 'P2_IDENTITY_KEY_ROTATION_CLOSE_PREPARED',
                    'environment': 'staging', 'keyRemovalVerified': False, 'frontendFinalEpoch': '18',
                    'frontendCustodyPlanSha256': self.review['planSha256'],
                    'configurationSha256': 'e' * 64, **{key: self.rotation[key] for key in
                        ('actionId', 'bindingSha256', 'candidateSha256', 'sourceCommit')},
                    'frontendSignerReceiptSha256': {'overlap': '1' * 64, 'current-only': '2' * 64,
                                                     'post-removal': supervisor._canonical_sha(post_removal)},
                    **dict.fromkeys(('sqlExecuted', 'rolesPrepared', 'loginChanged', 'nativeSchedulesEnabled', 'trafficAuthorized',
                                     'tokenBytesOutput', 'credentialHashesOutput', 'communityMemberFeatureAdded', 'newPublicEndpoint',
                                     'releaseAccepted', 'g2Accepted'), False)}
        supervisor.migrate.write_json(self.directory, parent.PREPARED_RECEIPT, prepared)
        supervisor.migrate.write_json(self.directory, parent.SESSION_CLOSED_RECEIPT, self.closed)
        close_raw = (self.directory / parent.SESSION_CLOSED_RECEIPT).read_bytes()
        joined = {**prepared, 'status': ROTATION_LAYOUT['terminalStatus'], 'keyRemovalVerified': True,
                  'frontendSessionCloseReceiptSha256': supervisor.migrate.file_hash(close_raw)}
        supervisor.migrate.write_json(self.directory, parent.JOINED_RECEIPT, joined)
        self.joined_raw = (self.directory / parent.JOINED_RECEIPT).read_bytes()
        self.final = self.directory / ROTATION_LAYOUT['terminalName']
        self.options = {'broker_type': parent.P2IdentityRotationBroker, 'observer_type': custody.ReplacementRotationPhysicalObserver,
                        'observer_source': supervisor.CERTIFICATION_OBSERVER, 'layout': ROTATION_LAYOUT}

    def test_managed_rotation_requires_exact_source_dispatch_and_version(self):
        with patch.object(supervisor.os, 'geteuid', return_value=1):
            with patch.object(self.parent, 'MANAGED_LIVE_ELIGIBLE', False):
                with self.assertRaisesRegex(ValueError, 'ROTATION_LIVE_EXECUTION_UNQUALIFIED'):
                    supervise(dict(self.initial), **self.options)
                with patch.object(self.parent, 'LIVE_ELIGIBLE', True):
                    with self.assertRaisesRegex(ValueError, 'ROTATION_LIVE_EXECUTION_UNQUALIFIED'):
                        supervise(dict(self.initial), **self.options)
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(dict(self.initial), **self.options)
            for version in (1, True, 2.0, None):
                with self.subTest(version=version), self.assertRaisesRegex(ValueError, 'ROTATION_LIVE_EXECUTION_UNQUALIFIED'):
                    supervise({**self.initial, 'version': version}, **self.options)
            for changed in ({'observer_type': certification.P2CertificationPhysicalObserver},
                            {'observer_source': 'ops/platform/p2-recovery-current-probe.mjs'},
                            {'frontend_containment': lambda: None}):
                with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'FIXED_SOURCE_DISPATCH_REQUIRED'):
                    supervise(dict(self.initial), **{**self.options, **changed})

    def test_durable_guard_arm_requires_exact_ready_and_probe_bytes(self):
        with self.assertRaises(FileNotFoundError):
            supervisor.require_managed_rotation_guard_arm(self.initial, self.probe)
        supervisor._retain_managed_rotation_guard_arm(self.initial, self.probe)
        record = supervisor.require_managed_rotation_guard_arm(self.initial, self.probe)
        self.assertEqual(record['probeSha256'], supervisor._canonical_sha(self.probe))
        with self.assertRaisesRegex(ValueError, 'MANAGED_ROTATION_ARM_REQUIRED'):
            supervisor.require_managed_rotation_guard_arm(self.initial, {**self.probe, 'marker': 'changed'})
        ready = self.directory / supervisor.MANAGED_ROTATION_ARM_READY
        ready.write_text(ready.read_text().replace(record['qualificationTargetProfile']['sha256'], '0' * 64))
        with self.assertRaisesRegex(ValueError, 'MANAGED_ROTATION_ARM_REQUIRED'):
            supervisor.require_managed_rotation_guard_arm(self.initial, self.probe)

    def exercise_supervisor(self, failure=None):
        import p2_identity_rotation_successor as successor

        order = []
        read_input, fstat = supervisor.migrate.read_input, os.fstat

        def read(root, relative, *args):
            if relative == 'release.candidate.json':
                return self.raw_candidate
            if relative == supervisor.CERTIFICATION_OBSERVER:
                return self.raw_observer
            return read_input(root, relative, *args)

        def owned_root_fstat(fd):
            actual = fstat(fd)
            if self.lock.exists() and actual.st_ino == self.lock.stat().st_ino:
                fields = list(actual)
                fields[4] = 0
                return os.stat_result(fields)
            return actual

        def assert_flock(*_):
            with self.lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        def check_arm(probe):
            self.assertEqual(probe, self.probe)
            assert_flock()
            order.append('physical-arm')
            if failure == 'arm':
                raise ValueError('owned-arm-failure')

        def check_closed(probe, epoch):
            self.assertEqual((probe, epoch), (self.probe, '18'))
            assert_flock()
            self.assertIn('reaped', order)
            self.assertFalse(self.final.exists())
            order.append('physical-close')
            return {} if failure == 'closed' else self.closed

        def watch(_child, _safety, _health, arm, *, publish_verified_arm, **flags):
            self.assertEqual(flags, {'profiled_certification': True, 'async_arm': True})
            result = arm(self.probe).result()
            self.assertFalse((self.directory / supervisor.MANAGED_ROTATION_ARM_READY).exists())
            publish_verified_arm(result)
            supervisor.require_managed_rotation_guard_arm(self.initial, self.probe)
            order.extend(('guard-arm', 'reaped'))
            return supervisor.migrate.file_hash(self.joined_raw)

        def retain(initial, source, terminal, committed, closed, *, worker_reaped, terminal_pending):
            self.assertEqual((initial, source, terminal, committed, closed),
                             (self.initial, self.source, json.loads(self.joined_raw), supervisor.migrate.file_hash(self.joined_raw), self.closed))
            self.assertTrue(worker_reaped and terminal_pending)
            self.assertFalse(self.final.exists())
            assert_flock()
            order.append('mixed-successor')
            if failure == 'successor':
                raise ValueError('owned-successor-failure')

        def fail(initial, armed, source, child, **_):
            self.assertEqual((initial, armed, source, child), (self.initial, None if failure == 'arm' else self.probe, self.source, 1234))
            self.assertFalse(self.final.exists())
            assert_flock()
            order.append('contain')

        with (patch.multiple(supervisor, __file__=str(self.source / 'ops/platform/host/p2_release_supervisor.py'),
                             LOCK=self.lock, _verify_guard_source=Mock(), verify_guard_lock=Mock(side_effect=assert_flock),
                             watch_broker=Mock(side_effect=watch), members=Mock(return_value=[]),
                             _managed_rotation_containers=Mock(), finish_failure_cleanup=Mock(side_effect=fail)),
              patch.object(supervisor.sys, 'platform', 'linux'), patch.object(supervisor.os, 'geteuid', return_value=0),
              patch.object(supervisor.os, 'fstat', side_effect=owned_root_fstat),
              patch.object(supervisor.os, 'fork', return_value=1234),
              patch.object(supervisor.ctypes, 'CDLL', return_value=Mock(prctl=Mock(return_value=0))),
              patch.object(supervisor.migrate, 'make_plan', return_value=(self.candidate, {'frontend': {}})),
              patch.object(supervisor.migrate, 'profiled_current_job_hashes', return_value=self.initial['frontendCustody']['apiJobSha256']),
              patch.object(supervisor.migrate, 'read_input', side_effect=read),
              patch.object(self.parent, 'MANAGED_LIVE_ELIGIBLE', True),
              patch.object(self.custody_module, 'prepare_replacement_rotation_custody',
                           return_value=Mock(verify_arm=check_arm, verify_closed=check_closed)),
              patch.object(successor, 'retain_rotation_successor', side_effect=retain)):
            if failure is None:
                supervise(self.initial, **self.options)
                self.assertEqual(self.final.read_bytes(), self.joined_raw)
            else:
                with self.assertRaises(ValueError):
                    supervise(self.initial, **self.options)
                self.assertFalse(self.final.exists())
        return order

    def test_independent_guard_arms_and_publishes_after_reap_under_the_flock(self):
        self.assertEqual(self.exercise_supervisor(), ['physical-arm', 'guard-arm', 'reaped', 'physical-close', 'mixed-successor'])

    def test_failed_arm_never_creates_marker_or_terminal(self):
        self.assertEqual(self.exercise_supervisor('arm'), ['physical-arm', 'contain'])
        self.assertFalse((self.directory / supervisor.MANAGED_ROTATION_ARM_READY).exists())

    def test_fresh_closure_mismatch_does_not_run_successor(self):
        self.assertEqual(self.exercise_supervisor('closed'), ['physical-arm', 'guard-arm', 'reaped', 'physical-close', 'contain'])

    def test_mixed_successor_failure_does_not_publish_terminal(self):
        self.assertEqual(self.exercise_supervisor('successor'),
                         ['physical-arm', 'guard-arm', 'reaped', 'physical-close', 'mixed-successor', 'contain'])

    def test_after_reap_retains_uncertainty_without_reopening_or_fencing_twice(self):
        supervisor._retain_managed_rotation_guard_arm(self.initial, self.probe)
        readback = {'epoch': '14', 'newWork': False, 'recovery': False, 'active': 1, 'uncertain': 2,
                    'registry': 'interactive', 'registrySha256': '1' * 64, 'admissionChanged': True}
        with (patch.object(supervisor, '_stop_profiled_certification_group', side_effect=[False, True, True]),
              patch.object(supervisor, '_contain_managed_rotation_frontend', return_value=readback) as fence,
              patch.object(supervisor, '_stop_managed_rotation_runtime') as stop,
              patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(supervisor, '_managed_rotation_containers')):
            result = supervisor.finish_failure_cleanup(self.initial, self.probe, self.source, 1234)
        fence.assert_called_once_with(self.initial, self.probe, self.source)
        stop.assert_called_once()
        self.assertEqual(result['frontendFence'], readback)
        self.assertIs(result['frontendAdmissionClosed'], True)
        self.assertIsNone(result['trafficAuthorized'])
        self.assertTrue(result['workerProcessesQuiesced'])

    def test_rotation_fence_launcher_uses_only_fixed_node_path_and_retains_original_ledger(self):
        from types import SimpleNamespace

        from p2_certification_parent import CORE, REPLACEMENT_PROOF_FIELDS

        self.candidate['artifacts'] = {'frontendMigration': {'image': 'owned/frontend@sha256:' + '1' * 64}}
        self.initial['credentials'] = {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture-credential'}
        program, core = self.directory / 'observer.mjs', self.directory / 'core.mjs'
        core.write_bytes(b'owned core\n')
        self.initial['sourceSha256'][CORE] = supervisor.migrate.file_hash(core.read_bytes())
        receipt = {'version': 2, 'qualificationTargetProfile': self.profile,
                   'status': 'P2_PROFILED_ROTATION_GUARD_FRONTEND_CLOSED', 'environment': 'staging',
                   'releaseId': 'original', 'frontendAdmissionClosed': True, 'epoch': '14', 'admissionChanged': True,
                   'sqlReplayed': False, 'releaseAccepted': False, 'newWork': False, 'recovery': False,
                   'active': 1, 'uncertain': 2, 'registry': 'interactive', 'registrySha256': '1' * 64,
                   **{key: self.review[key] for key in
                      ('sourceCommit', 'certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')},
                   **dict.fromkeys(REPLACEMENT_PROOF_FIELDS, 'owned')}
        stdout = json.dumps(receipt) + '\n'
        invocations = []

        def run(args, **kwargs):
            invocations.append(args)
            if args[:2] == ['docker', 'run']:
                self.assertEqual(args[-2:], [supervisor.CERTIFICATION_OBSERVER, '--profiled-replacement-rotation-guard-fence'])
                self.assertEqual(json.loads(kwargs['input']), self.probe)
                self.assertNotIn('owned-fixture-credential', args)
                return SimpleNamespace(stdout=stdout, stderr='')
            self.assertEqual(args[:3], ['docker', 'rm', '--force'])
            return SimpleNamespace()

        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(supervisor, 'private_observer_program', return_value=program),
              patch.object(certification, '_cache_core', return_value=core),
              patch.object(certification, 'require_certification_replacement_proof'),
              patch.object(supervisor.subprocess, 'run', side_effect=run),
              patch.object(supervisor.runtime, 'command', return_value='')):
            readback = supervisor._contain_managed_rotation_frontend(self.initial, self.probe, self.source)
            self.assertEqual((self.directory / supervisor.MANAGED_ROTATION_FENCE).read_text(), stdout)
            self.assertEqual((readback['active'], readback['uncertain'], readback['registry']), (1, 2, 'interactive'))
            for change in ({'epoch': '15'}, {'active': True}, {'registry': 'ordinary'}, {'newWork': True}):
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'MANAGED_ROTATION_FENCE_REFUSED'):
                    supervisor._managed_rotation_fence_record(self.initial, self.probe, {**receipt, **change})
        self.assertEqual(len(invocations), 2)
