"""Exercise exact successor files and project only read-only Docker observations."""
from contextlib import ExitStack
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import migrate
import p2_known_ack_loss_test as fixtures
import p2_release_supervisor as supervisor
import p2_replacement_runtime_containment as containment
import p2_replacement_successor as successor
from qualification_target_profile import resolve_qualification_target_profile
import release as runtime
import staging_state


class SuccessorRuntimeTests(unittest.TestCase):
    def fixture(self, kind, frontend_epoch='6'):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        results, source = root / 'results', root / 'source'
        results.mkdir(mode=0o700)
        profile = dict(successor.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        fields = {'version': 2, 'qualificationTargetProfile': profile}
        same = kind == 'known-ack'
        action = 'owned-previous-action'
        runtime_action = 'owned-runtime-action' if same else action
        layout = supervisor.PROFILED_CERTIFICATION_LAYOUT if same else supervisor.PROFILED_INTERRUPTED_LAYOUT
        prior_dir = results / (layout['receiptPrefix'] + action)
        runtime_dir = (root / ('p2-profiled-known-ack-' + runtime_action) / 'runtime-known-ack'
                       if same else prior_dir / 'runtime-interrupted')
        prior_dir.mkdir(mode=0o700)
        if same:
            runtime_dir.parent.mkdir(mode=0o700)
        runtime_dir.mkdir(mode=0o700)
        configuration = runtime_dir / 'configuration'
        configuration.mkdir(mode=0o700)
        (configuration / 'admission').mkdir(mode=0o700)
        for name in staging_state.CONFIGURATION_FILES:
            path = configuration / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(name.encode() + b'\n')
        (configuration / 'compose.yaml').write_bytes(b'owned-compose\n')
        for name, raw in (('ops/platform/compose.yaml', b'owned-compose\n'),
                          (successor.FAULT_MODULE, b'owned-fault-module\n')):
            path = source / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(raw)
        hashes = staging_state.configuration_hashes(configuration)
        pairs = {'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + 'c' * 64}
        selected = {**pairs, 'version': 3, 'qualificationTargetProfile': profile, 'environment': 'staging',
                    'releaseId': 'owned-release',
                    'sources': {name: {**fields, 'commit': 'd' * 40} for name in ('frontend', 'course', 'community')},
                    **{key: dict(fields) for key in ('sourceApproval', 'integration', 'workload', 'approval')},
                    'runtime': {'composeSha256': 'sha256:' + migrate.file_hash(b'owned-compose\n')},
                    'artifacts': {key: {'image': f'local/{key}@sha256:' + 'e' * 64} for key in set(runtime.IMAGE_KEYS.values())}}
        frontend_profile = resolve_qualification_target_profile(profile)['frontend']
        selected['workload'].update(projectId=frontend_profile['projectId'], environment=frontend_profile['workloadEnvironment'])
        pins, _ = fixtures.replacement_release_fixture(profile)
        plan = {**fields, **pins, 'environment': 'staging', 'candidateSha256': 'a' * 64, 'targetSha256': 'b' * 64,
                'sourceCommit': 'd' * 40, 'originalReleaseId': selected['releaseId'], 'initialEpoch': '3' if same else '6',
                'nativePlan': {'initialEpoch': '4'},
                'configurationCanonicalSha256': migrate.file_hash(successor._canonical(hashes)),
                'mode': 'known-ack-recovery' if same else 'p2-profiled-known-ack-interrupted-restoration'}
        initial = {**fields, '_guardLayout': layout, 'candidate': selected, 'candidateSha256': plan['candidateSha256'],
                   'targetSha256': plan['targetSha256'], 'configurationSha256': hashes,
                   'results': str(results), 'hostMachineId': 'f' * 32}
        if same:
            plan['knownAckRecovery'] = {'recoveryActionId': runtime_action}
            initial.update(certificationPlan=plan, certificationActionId=action)
        else:
            initial.update(reviewedPlan={'frontendPlan': plan}, restorationActionId=action)
        containers = [{'service': service, 'containerId': format(index, '064x'),
                       'image': selected['artifacts'][runtime.IMAGE_KEYS[service]]['image'],
                       'health': 'none' if service.endswith('-tls') else 'healthy'}
                      for index, service in enumerate(runtime.SERVICES, 1)]
        gateway = {'process': {'containerId': containers[-1]['containerId'], 'running': True, 'pid': 17},
                   'binding': {'configurationDirectory': str(configuration), 'releaseId': selected['releaseId'],
                               'candidateSha256': initial['candidateSha256'], 'hostMachineId': initial['hostMachineId']},
                   'admission': {'newWork': False, 'recovery': False, 'active': {'newWork': 0, 'recovery': 0},
                                 'uncertain': {'newWork': 0, 'recovery': 0}}}
        frontend = {'epoch': frontend_epoch, 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
        identity = {**fields, **pairs, **pins, 'environment': 'staging', 'releaseId': selected['releaseId'],
                    'candidateSha256': plan['candidateSha256'], 'nativeDisabled': True, 'sqlReplayed': False,
                    'frontendSqlApplied': False, 'trafficAuthorized': False}
        outcome = {**identity, 'status': 'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED' if same else layout['terminalStatus'],
                   'recoveryActionId': runtime_action, 'runtimeReplacements': 1, 'migrationsExecuted': False,
                   'containers': containers, 'newGateway': gateway, 'frontendJournalSha256': '9' * 64}
        if not same:
            outcome['restorationActionId'] = action
        runtime_name = 'known-ack-runtime-outcome.json' if same else 'profiled-interrupted-runtime-outcome.json'
        migrate.write_json(runtime_dir, runtime_name, outcome)
        runtime_raw = (runtime_dir / runtime_name).read_bytes()
        if same:
            migrate.write_exact_bytes(prior_dir, 'known-ack-replacement-joined.json', runtime_raw)
            terminal = {**identity, 'status': layout['terminalStatus'], 'mode': plan['mode'], 'runtimeReplaced': True,
                        'certificationActionId': action, 'knownAckLoss': {'recoveryActionId': runtime_action},
                        'sourceCommit': plan['sourceCommit'], 'targetSha256': plan['targetSha256'],
                        'frontendAdmission': frontend, 'knownAckRuntimeReceiptSha256': migrate.file_hash(runtime_raw)}
            migrate.write_json(prior_dir, layout['terminalName'], terminal)
        else:
            terminal = outcome
            migrate.write_exact_bytes(prior_dir, layout['terminalName'], runtime_raw)
        close_name = ('p2-certification-frontend-session-closed.json' if same
                      else 'p2-profiled-interrupted-frontend-session-closed.json')
        migrate.write_json(prior_dir, close_name, {**fields, 'status': 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED',
            'environment': 'staging', 'releaseId': selected['releaseId'], 'sourceCommit': plan['sourceCommit'],
            'targetSha256': plan['targetSha256'], 'backendAbsent': True, 'migrationLockReleased': True,
            'nonceLockReleased': True, 'journalSha256': outcome['frontendJournalSha256'], 'admission': frontend,
            'replacementRelease': pins['replacementRelease'], 'effectiveLoginBoundaryVerified': True,
            'predecessorRuntimeRoleAbsent': True})
        committed = migrate.file_hash((prior_dir / layout['terminalName']).read_bytes())
        mount = (configuration / 'admission').stat()
        reported = {'version': 1, 'status': 'P2_FAULT_GATEWAY_CURRENT', 'processSha256': '8' * 64,
                    'admissionDirectory': {'device': str(mount.st_dev), 'inode': str(mount.st_ino)},
                    'gatewayConfigurationSha256': hashes['gateway.json'], 'faultLeasePresent': False,
                    'faultModuleSha256': migrate.file_hash(b'owned-fault-module\n'),
                    'admission': {'valid': True, **gateway['admission']}}
        lineage = {'protocol': successor.prior.PROTOCOL, 'state': 'running-observed', 'actionId': runtime_action,
                   'candidateSha256': initial['candidateSha256'], 'process': gateway['process'], 'binding': gateway['binding']}
        members = {row['containerId']: {'service': row['service'], 'running': True} for row in containers}
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(successor.prior, 'ROOT', root))
        lock = stack.enter_context(patch.object(supervisor, 'verify_guard_boundary'))
        stack.enter_context(patch.object(supervisor, 'verify_guard_lock'))
        stack.enter_context(patch.object(runtime, 'check_containers', return_value=containers))
        inventory = stack.enter_context(patch.object(containment, '_compose_inventory', return_value=(members, 0)))
        stack.enter_context(patch.object(successor.prior, 'observe_prior_gateway', return_value=gateway))
        process = stack.enter_context(patch.object(successor.prior, '_process', return_value=gateway['process']))
        stack.enter_context(patch.object(successor.prior, '_read_lineage', return_value=lineage))
        docker = stack.enter_context(patch.object(runtime, 'command', side_effect=lambda *_: json.dumps(reported)))
        return locals()

    def write(self, fixture):
        successor.retain_successor_runtime(fixture['initial'], fixture['source'], fixture['terminal'],
                                            fixture['committed'], kind=fixture['kind'])

    def next_plan(self, fixture):
        raw = (fixture['prior_dir'] / successor.RECEIPT).read_bytes()
        receipt = json.loads(raw)
        binding = {key: receipt[key] for key in ('kind', 'actionId', 'runtimeActionId')}
        binding['receiptSha256'] = migrate.file_hash(raw)
        return {**fixture['plan'], 'initialEpoch': '7', 'certificationActionId': 'owned-next-certification',
                'successorRuntime': binding,
                **{key: receipt[key] for key in ('runtimeInventorySha256', 'gatewayProcessSha256')}}

    def read(self, fixture, plan):
        return successor.require_successor_runtime(fixture['initial'], plan, fixture['selected'], fixture['results'],
                                                   fixture['source'], fixture['profile'])

    def prearm(self, fixture, plan, configuration):
        initial = {**fixture['initial'], 'mode': supervisor.PROFILED_CERTIFICATION_MODE,
                   'certificationPlan': {**plan, 'startState': 'already-closed',
                                         'gatewayConfigurationSha256': fixture['hashes']['gateway.json']},
                   'configuration': str(configuration)}
        successor.verify_replacement_runtime_before_arm(initial, fixture['source'])

    def test_prearm_rejects_stale_original_mount_then_accepts_exact_original(self):
        fixture = self.fixture('known-ack')
        original = fixture['results'] / ('runtime-profiled-frontend-replacement-' + fixture['selected']['releaseId']) / 'configuration'
        shutil.copytree(fixture['configuration'], original)
        plan = {**fixture['plan'], 'gatewayProcessSha256': fixture['reported']['processSha256'],
                'runtimeInventorySha256': migrate.file_hash(successor._canonical(fixture['containers']))}
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, original)
        fixture['docker'].assert_not_called()
        fixture['gateway']['binding']['configurationDirectory'] = str(original)
        mount = (original / 'admission').stat()
        fixture['reported']['admissionDirectory'] = {'device': str(mount.st_dev), 'inode': str(mount.st_ino)}
        self.prearm(fixture, plan, original)
        fixture['docker'].assert_called_once()
        self.assertFalse((fixture['prior_dir'] / successor.RECEIPT).exists())

    def test_prearm_requires_exact_successor_inventory_process_and_fault_free_closed_zero(self):
        fixture = self.fixture('known-ack')
        self.write(fixture)
        plan = self.next_plan(fixture)
        self.prearm(fixture, plan, fixture['configuration'])
        fixture['reported']['processSha256'] = '7' * 64
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, fixture['configuration'])
        fixture['reported']['processSha256'] = plan['gatewayProcessSha256']
        fixture['reported']['faultLeasePresent'] = True
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, fixture['configuration'])
        fixture['reported']['faultLeasePresent'] = False
        fixture['gateway']['admission']['uncertain']['recovery'] = 1
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, fixture['configuration'])
        fixture['gateway']['admission']['uncertain']['recovery'] = 0
        fixture['inventory'].return_value = (fixture['members'], 1)
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, fixture['configuration'])

    def test_prearm_caps_each_read_only_command_with_remaining_budget(self):
        fixture = self.fixture('known-ack')
        self.write(fixture)
        plan = self.next_plan(fixture)
        now = [100]

        def observe(*_):
            now[0] += 9
            runner = runtime._command_scope.get().run
            runner(['docker', 'inspect', 'owned-container'], timeout=30)
            now[0] += 17
            runner(['docker', 'inspect', 'owned-container'], timeout=30)

        with patch.object(successor.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(successor, '_observe', side_effect=observe), \
             patch.object(successor.subprocess, 'run') as process, \
             self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.prearm(fixture, plan, fixture['configuration'])
        process.assert_called_once_with(['docker', 'inspect', 'owned-container'], timeout=16)
        self.assertIsNone(runtime._command_scope.get())

    def test_both_fixed_successor_paths_bind_guardian_bytes_and_remain_read_only(self):
        for kind in ('known-ack', 'interrupted-known-ack'):
            with self.subTest(kind=kind):
                fixture = self.fixture(kind)
                self.write(fixture)
                fixture['lock'].assert_called()
                fixture['docker'].assert_called_once()
                self.assertEqual(fixture['docker'].call_args.args[0][-1], successor.GATEWAY_OBSERVER)
                self.assertEqual(json.loads((fixture['prior_dir'] / successor.RECEIPT).read_bytes())['frontendEpoch'], '6')
                self.assertEqual(self.read(fixture, self.next_plan(fixture)), fixture['configuration'])
                fixture['docker'].assert_called_once()
                with self.assertRaises(FileExistsError):
                    self.write(fixture)

    def test_same_session_requires_close_after_native_recovery_and_barrier(self):
        fixture = self.fixture('known-ack', frontend_epoch='5')
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.write(fixture)
        fixture['docker'].assert_not_called()
        self.assertFalse((fixture['prior_dir'] / successor.RECEIPT).exists())

    def test_writer_refuses_foreign_inventory_lease_and_changed_gateway_process(self):
        fixture = self.fixture('known-ack')
        fixture['inventory'].return_value = (fixture['members'], 1)
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.write(fixture)
        fixture['inventory'].return_value = (fixture['members'], 0)
        fixture['reported']['faultLeasePresent'] = True
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.write(fixture)
        fixture['reported']['faultLeasePresent'] = False
        fixture['process'].return_value = {'containerId': '0' * 64}
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.write(fixture)
        self.assertFalse((fixture['prior_dir'] / successor.RECEIPT).exists())

    def test_reader_refuses_changed_plan_and_each_retained_file(self):
        fixture = self.fixture('interrupted-known-ack')
        self.write(fixture)
        plan = self.next_plan(fixture)
        for key, value in (('initialEpoch', '4'), ('gatewayProcessSha256', '7' * 64), ('runtimeInventorySha256', '6' * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, successor.REFUSED):
                self.read(fixture, {**plan, key: value})
        changed = copy.deepcopy(plan)
        changed['successorRuntime']['runtimeActionId'] = 'foreign-action'
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.read(fixture, changed)
        for path in (fixture['prior_dir'] / fixture['layout']['terminalName'],
                     fixture['runtime_dir'] / fixture['runtime_name'], fixture['prior_dir'] / fixture['close_name'],
                     fixture['prior_dir'] / successor.RECEIPT, fixture['configuration'] / 'gateway.json'):
            raw = path.read_bytes()
            path.write_bytes(raw + b'\n')
            with self.subTest(path=path.name), self.assertRaisesRegex(ValueError, successor.REFUSED):
                self.read(fixture, plan)
            path.write_bytes(raw)
        self.assertEqual(self.read(fixture, plan), fixture['configuration'])
        fixture['docker'].assert_called_once()
