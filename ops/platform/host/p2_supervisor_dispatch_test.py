"""Fixed source dispatch checks. Full recovery is qualified by its owned harness."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import json
import re
import unittest
from p2_release_broker import Broker, PhysicalObserver
from p2_release_supervisor import supervise, DEFAULT_LAYOUT, RECOVERY_LAYOUT, CERTIFICATION_LAYOUT, ROTATION_LAYOUT, cleanup_recovery_current_containers, cleanup_rotation_readonly_containers
from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver
import p2_certification_parent as certification
import p2_release_supervisor as supervisor


class FixedDispatchTests(unittest.TestCase):
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
                with patch.object(supervisor, 'verify_guard_boundary'), \
                     patch.object(supervisor.p2_prior_gateway, '_inventory', return_value=['a' * 64]), \
                     patch.object(supervisor.p2_prior_gateway, '_mounted_configuration', return_value=root / 'foreign'), \
                     patch.object(supervisor.staging_state, 'configuration_hashes', return_value=initial['configurationSha256']), \
                     patch.object(supervisor.migrate, 'suspend_runtime', side_effect=AssertionError('foreign runtime stop')):
                    with self.assertRaisesRegex(ValueError, 'GUARD_MOUNT_REFUSED'):
                        supervisor._profiled_interrupted_gateway_mount(initial, root)
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
        initial = {'candidate': {'releaseId': 'original'}, 'mode': 'p2-identity-key-rotation',
                   'rotationActionId': 'p2-key-rotation-owned', '_guardLayout': ROTATION_LAYOUT}
        with patch('p2_release_supervisor.os.geteuid', return_value=1):
            with self.assertRaisesRegex(ValueError, 'LINUX_ROOT_GUARD_REQUIRED'):
                supervise(initial)
        self.assertEqual(initial['_guardLayout'], DEFAULT_LAYOUT)
        options = {'broker_type': P2IdentityRotationBroker,
                   'observer_type': P2IdentityRotationPhysicalObserver,
                   'observer_source': 'ops/platform/p2-recovery-current-probe.mjs',
                   'layout': ROTATION_LAYOUT}
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
