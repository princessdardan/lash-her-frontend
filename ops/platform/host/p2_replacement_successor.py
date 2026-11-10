"""Bind the replacement release to a guardian-observed successor runtime."""
import json
from pathlib import Path
import re
import stat
import subprocess
import time
from types import SimpleNamespace

import migrate
import p2_prior_gateway as prior
import release as runtime
import staging_state
from p2_certification_fault import GATEWAY_OBSERVER, MODULE as FAULT_MODULE
from p2_frontend_replacement_parent import private_record
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json


RECEIPT = 'p2-replacement-successor-runtime.json'
STATUS = 'P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED'
BINDING_FIELDS = frozenset(('kind', 'actionId', 'runtimeActionId', 'receiptSha256'))
RELEASE_PINS = ('replacementRelease', 'originalReleaseReceiptSha256', 'originalReleasePlanSha256')
REFUSED = 'P2_REPLACEMENT_SUCCESSOR_RUNTIME_REFUSED'
require = migrate.demand


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def _digest(value):
    return type(value) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{64}', value) is not None


def _action(value):
    return type(value) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value) is not None


def _epoch(value):
    return type(value) is str and re.fullmatch(r'[1-9][0-9]{0,17}', value) is not None


def _profile(expected):
    expected = migrate.profile_context(expected)
    require(expected == migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE), REFUSED)
    return expected


def _private(path):
    require(path.is_absolute() and path == path.resolve() and
            (path == prior.ROOT or prior.ROOT in path.parents), REFUSED)
    migrate.private_directory(path)
    staging_state.outside_checkout(path)


def _paths(results, kind, action, runtime_action):
    require(_action(action) and _action(runtime_action) and kind in ('known-ack', 'interrupted-known-ack') and
            (action == runtime_action) is (kind == 'interrupted-known-ack'), REFUSED)
    _private(results)
    if kind == 'known-ack':
        directory = results / ('p2-profiled-current-certification-' + action)
        runtime_directory = prior.ROOT / ('p2-profiled-known-ack-' + runtime_action) / 'runtime-known-ack'
        names = ('p2-profiled-current-certification-outcome.json', 'known-ack-runtime-outcome.json',
                 'p2-certification-frontend-session-closed.json')
    else:
        directory = results / ('p2-profiled-known-ack-restoration-' + action)
        runtime_directory = directory / 'runtime-interrupted'
        names = ('p2-profiled-known-ack-interrupted-restoration-outcome.json', 'profiled-interrupted-runtime-outcome.json',
                 'p2-profiled-interrupted-frontend-session-closed.json')
    for path in (directory, runtime_directory, runtime_directory / 'configuration'):
        _private(path)
    return directory, runtime_directory, names


def _profiled(raw, expected):
    value = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(expected, value)
    require(type(value) is dict and type(value.get('version')) is int and value['version'] == 2, REFUSED)
    return value


def _identity(initial, plan, selected, expected):
    from p2_certification_parent import require_certification_replacement_release
    migrate.candidate_profile(selected, expected)
    migrate.require_profile(expected, initial, plan)
    descriptor = require_certification_replacement_release(plan['replacementRelease'], expected)
    config = initial['configurationSha256']
    require(selected['environment'] == plan['environment'] == 'staging' and
            _action(selected['releaseId']) and selected['releaseId'] == plan['originalReleaseId'] and
            selected['sources']['frontend']['commit'] == plan['sourceCommit'] and
            _digest(plan.get('candidateSha256')) and plan['candidateSha256'] == initial['candidateSha256'] and
            _digest(plan.get('targetSha256')) and plan['targetSha256'] == initial['targetSha256'] and
            _digest(plan.get('originalReleaseReceiptSha256')) and plan['originalReleasePlanSha256'] == descriptor['reviewedPlanSha256'] and
            type(config) is dict and set(config) == set(staging_state.CONFIGURATION_FILES) and all(_digest(v) for v in config.values()) and
            migrate.file_hash(_canonical(config)) == plan['configurationCanonicalSha256'] and
            type(initial['hostMachineId']) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{32}', initial['hostMachineId']), REFUSED)
    return {'version': 2, 'qualificationTargetProfile': expected, 'status': STATUS, 'environment': 'staging',
            'releaseId': selected['releaseId'], 'hostMachineId': initial['hostMachineId'],
            **{key: plan[key] for key in ('sourceCommit', 'candidateSha256', 'targetSha256', 'configurationCanonicalSha256', *RELEASE_PINS)}}


def _configuration(configuration, initial, selected, source):
    raw = migrate.read_input(configuration, 'compose.yaml', 65_536)
    require(staging_state.configuration_hashes(configuration) == initial['configurationSha256'] and
            'sha256:' + migrate.file_hash(raw) == selected['runtime']['composeSha256'] and
            raw == migrate.read_input(source, 'ops/platform/compose.yaml', 65_536), REFUSED)


def _retained(directory, runtime_directory, names, binding, identity, selected, expected):
    from p2_certification_parent import require_certification_replacement_proof
    terminal_raw, runtime_raw, closed_raw = (
        private_record(path, name) for path, name in zip((directory, runtime_directory, directory), names))
    terminal, outcome, closed = (_profiled(raw, expected) for raw in (terminal_raw, runtime_raw, closed_raw))
    for record in (terminal, outcome):
        migrate.require_contract_identity(selected, record)
        require(all(record.get(key) == identity[key] for key in ('environment', 'releaseId', 'candidateSha256')) and
                all(_canonical(record.get(key)) == _canonical(identity[key]) for key in RELEASE_PINS) and
                record.get('nativeDisabled') is True and all(record.get(key) is False for key in
                    ('sqlReplayed', 'frontendSqlApplied', 'trafficAuthorized')), REFUSED)
    require(outcome.get('recoveryActionId') == binding['runtimeActionId'] and
            type(outcome.get('runtimeReplacements')) is int and outcome['runtimeReplacements'] == 1 and
            outcome.get('migrationsExecuted') is False, REFUSED)
    if binding['kind'] == 'known-ack':
        require(terminal['status'] == 'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED' and
                terminal.get('mode') == 'known-ack-recovery' and terminal.get('runtimeReplaced') is True and
                terminal.get('certificationActionId') == binding['actionId'] and
                terminal.get('knownAckLoss', {}).get('recoveryActionId') == binding['runtimeActionId'] and
                all(terminal.get(key) == identity[key] for key in ('sourceCommit', 'targetSha256')) and
                terminal.get('knownAckRuntimeReceiptSha256') == migrate.file_hash(runtime_raw) and
                private_record(directory, 'known-ack-replacement-joined.json') == runtime_raw and
                outcome['status'] == 'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED' and
                _canonical(terminal.get('frontendAdmission')) == _canonical(closed.get('admission')), REFUSED)
    else:
        require(terminal_raw == runtime_raw and terminal['status'] == 'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED' and
                terminal.get('restorationActionId') == binding['actionId'], REFUSED)
    require_certification_replacement_proof(closed, identity['replacementRelease'])
    admission = closed.get('admission')
    require(closed['status'] == 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' and
            all(closed.get(key) == identity[key] for key in ('environment', 'releaseId', 'sourceCommit', 'targetSha256')) and
            all(closed.get(key) is True for key in ('backendAbsent', 'migrationLockReleased', 'nonceLockReleased')) and
            _digest(closed.get('journalSha256')) and closed['journalSha256'] == outcome.get('frontendJournalSha256') and
            type(admission) is dict and _epoch(admission.get('epoch')) and
            _canonical(admission) == _canonical({'epoch': admission['epoch'], 'newWork': False, 'recovery': False,
                                                'active': 0, 'uncertain': 0}), REFUSED)
    inventory = outcome.get('containers')
    require(type(inventory) is list and all(type(row) is dict for row in inventory) and
            [row.get('service') for row in inventory] == list(runtime.SERVICES) and all(
                set(row) == {'service', 'containerId', 'image', 'health'} and _digest(row['containerId']) and
                row['image'] == selected['artifacts'][runtime.IMAGE_KEYS[row['service']]]['image'] and
                row['health'] == ('none' if row['service'].endswith('-tls') else 'healthy') for row in inventory) and
            len({row['containerId'] for row in inventory}) == len(runtime.SERVICES), REFUSED)
    gateway = outcome.get('newGateway')
    configuration = runtime_directory / 'configuration'
    gateway_id = next(row['containerId'] for row in inventory if row['service'] == 'gateway')
    require(type(gateway) is dict and prior._zero(gateway) and
            gateway.get('process', {}).get('containerId') == gateway_id and
            gateway.get('process', {}).get('running') is True and
            gateway.get('binding', {}).get('configurationDirectory') == str(configuration) and
            all(gateway['binding'].get(key) == identity[key] for key in ('releaseId', 'candidateSha256', 'hostMachineId')), REFUSED)
    proof = {'terminalSha256': migrate.file_hash(terminal_raw), 'runtimeReceiptSha256': migrate.file_hash(runtime_raw),
             'frontendSessionClosedSha256': migrate.file_hash(closed_raw), 'frontendEpoch': admission['epoch'],
             'runtimeInventorySha256': migrate.file_hash(_canonical(inventory))}
    return terminal, outcome, proof


def _observe(initial, source, selected, expected, configuration, verify, *, include_full_admission=False):
    from p2_replacement_runtime_containment import _compose_inventory

    def run(args, environment, timeout):
        verify()
        value = runtime.command(args, environment, timeout)
        verify()
        return value

    containers = runtime.check_containers(selected, configuration, expected_profile=expected)
    verify()
    members, unknown = _compose_inventory(lambda args, timeout: run(args, runtime.SAFE_ENV, timeout),
                                          configuration, selected, True)
    require([row['service'] for row in containers] == list(runtime.SERVICES) and
            len({row['containerId'] for row in containers}) == len(runtime.SERVICES) and unknown == 0 and members == {
        row['containerId']: {'service': row['service'], 'running': True} for row in containers}, REFUSED)
    context = {key: initial[key] for key in ('candidateSha256', 'hostMachineId', 'configurationSha256')}
    context.update(version=2, qualificationTargetProfile=expected)
    gateway = prior.observe_prior_gateway(context, selected, verify, command=run, assert_host=runtime.assert_host,
                                         expected_profile=expected)
    require(prior._zero(gateway) and gateway['binding']['configurationDirectory'] == str(configuration), REFUSED)
    identifier = gateway['process']['containerId']
    require(identifier == next(row['containerId'] for row in containers if row['service'] == 'gateway'), REFUSED)
    admission_mount = (configuration / 'admission').lstat()
    value = json.loads(run(['docker', 'exec', '--workdir', '/app', identifier, 'node',
                            '--input-type=module', '--eval', GATEWAY_OBSERVER], runtime.SAFE_ENV, 10))
    require(stat.S_ISDIR(admission_mount.st_mode) and value.get('status') == 'P2_FAULT_GATEWAY_CURRENT' and
            type(value.get('version')) is int and value['version'] == 1 and _digest(value.get('processSha256')) and
            value.get('admissionDirectory') == {'device': str(admission_mount.st_dev), 'inode': str(admission_mount.st_ino)} and
            value.get('gatewayConfigurationSha256') == initial['configurationSha256']['gateway.json'] and
            value.get('faultModuleSha256') == migrate.file_hash(migrate.read_input(source, FAULT_MODULE, 65_536)) and
            value.get('faultLeasePresent') is False and value.get('admission', {}).get('valid') is True and
            all(_canonical(value['admission'].get(key)) == _canonical(item) for key, item in gateway['admission'].items()) and
            prior._process(identifier, run, verify) == gateway['process'],
            REFUSED)
    verify()
    if include_full_admission:
        gateway = {**gateway, 'admission': value['admission']}
    return containers, gateway, value['processSha256']


def verify_replacement_runtime_before_arm(initial, source):
    """Reject a stale runtime selection before the guardian can arm containment."""
    from p2_certification_parent import PROFILED_MODES
    from p2_release_supervisor import PROFILED_CERTIFICATION_LAYOUT, fixed_layout, verify_guard_boundary, verify_guard_lock
    from p2_source_closure import PROFILED_CERTIFICATION_MODE

    require(fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT and initial.get('mode') == PROFILED_CERTIFICATION_MODE, REFUSED)
    plan = initial['certificationPlan']
    require(plan.get('mode') in PROFILED_MODES and plan.get('startState') == 'already-closed' and
            'replacementRelease' in plan and all(_digest(plan.get(key)) for key in
                ('runtimeInventorySha256', 'gatewayProcessSha256', 'gatewayConfigurationSha256')) and
            plan['gatewayConfigurationSha256'] == initial['configurationSha256']['gateway.json'], REFUSED)
    selected, expected = initial['candidate'], _profile(initial['qualificationTargetProfile'])
    _identity(initial, plan, selected, expected)
    results, configuration = Path(initial['results']), Path(initial['configuration'])
    deadline = time.monotonic() + 25
    verify_guard_boundary(initial, source)
    expected_mount = (require_successor_runtime(initial, plan, selected, results, source, expected)
                      if 'successorRuntime' in plan else
                      results / ('runtime-profiled-frontend-replacement-' + selected['releaseId']) / 'configuration')
    require(configuration == expected_mount, REFUSED)
    _private(configuration)
    _configuration(configuration, initial, selected, source)

    def verify():
        require(time.monotonic() < deadline, REFUSED)
        verify_guard_lock(initial)

    def bounded_run(args, **kwargs):
        verify()
        timeout = min(kwargs['timeout'], deadline - time.monotonic())
        require(timeout > 0, REFUSED)
        return subprocess.run(args, **{**kwargs, 'timeout': timeout})

    token = runtime._command_scope.set(SimpleNamespace(run=bounded_run))
    try:
        containers, _, gateway_sha = _observe(initial, source, selected, expected, configuration, verify)
    finally:
        runtime._command_scope.reset(token)
    require(migrate.file_hash(_canonical(containers)) == plan['runtimeInventorySha256'] and
            gateway_sha == plan['gatewayProcessSha256'], REFUSED)
    _configuration(configuration, initial, selected, source)
    verify_guard_boundary(initial, source)
    verify()


def retain_successor_runtime(initial, source, terminal, committed, *, kind):
    """Called by the guardian only after child reap and fresh frontend closure."""
    from p2_release_supervisor import PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT, fixed_layout, verify_guard_boundary
    require(kind in ('known-ack', 'interrupted-known-ack'), REFUSED)
    same_session = kind == 'known-ack'
    require(fixed_layout(initial) == (PROFILED_CERTIFICATION_LAYOUT if same_session else PROFILED_INTERRUPTED_LAYOUT), REFUSED)
    plan = initial['certificationPlan'] if same_session else initial['reviewedPlan']['frontendPlan']
    require(plan['mode'] == ('known-ack-recovery' if same_session else 'p2-profiled-known-ack-interrupted-restoration'), REFUSED)
    action = initial['certificationActionId'] if same_session else initial['restorationActionId']
    runtime_action = plan['knownAckRecovery']['recoveryActionId'] if same_session else action
    binding = {'kind': kind, 'actionId': action, 'runtimeActionId': runtime_action}
    selected, results, expected = initial['candidate'], Path(initial['results']), _profile(initial['qualificationTargetProfile'])
    require(selected['releaseId'] not in (action, runtime_action) and _epoch(plan.get('initialEpoch')), REFUSED)

    def verify():
        verify_guard_boundary(initial, source)

    verify()
    identity = _identity(initial, plan, selected, expected)
    directory, runtime_directory, names = _paths(results, kind, action, runtime_action)
    configuration = runtime_directory / 'configuration'
    _configuration(configuration, initial, selected, source)
    prior_terminal, outcome, proof = _retained(directory, runtime_directory, names, binding, identity, selected, expected)
    expected_epoch = int(plan['initialEpoch'])
    if same_session:
        native_epoch = plan['nativePlan']['initialEpoch']
        require(_epoch(native_epoch) and int(native_epoch) == expected_epoch + 1, REFUSED)
        expected_epoch = int(native_epoch) + 2
    require(proof['terminalSha256'] == committed and _canonical(prior_terminal) == _canonical(terminal) and
            int(proof['frontendEpoch']) == expected_epoch, REFUSED)
    containers, gateway, gateway_sha = _observe(initial, source, selected, expected, configuration, verify)
    lineage = {'protocol': prior.PROTOCOL, 'state': 'running-observed', 'actionId': runtime_action,
               'candidateSha256': initial['candidateSha256'], 'process': gateway['process'], 'binding': gateway['binding']}
    require(containers == outcome['containers'] and _canonical(gateway) == _canonical(outcome['newGateway']) and
            _canonical(prior._read_lineage()) == _canonical(lineage), REFUSED)
    _configuration(configuration, initial, selected, source)
    require(_retained(directory, runtime_directory, names, binding, identity, selected, expected)[2] == proof, REFUSED)
    verify()
    migrate.write_json(directory, RECEIPT, {**identity, **binding, **proof, 'gatewayProcessSha256': gateway_sha})


def require_successor_runtime(initial, plan, selected, results, source, expected):
    """Rejoin the prior guardian's raw files without inspecting or changing the live runtime."""
    expected = _profile(expected)
    binding = plan['successorRuntime']
    require(type(binding) is dict and set(binding) == BINDING_FIELDS and _digest(binding.get('receiptSha256')) and
            _epoch(plan.get('initialEpoch')) and _action(plan.get('certificationActionId')) and
            all(binding[key] not in (selected['releaseId'], plan['certificationActionId'])
                for key in ('actionId', 'runtimeActionId')), REFUSED)
    identity = _identity(initial, plan, selected, expected)
    directory, runtime_directory, names = _paths(results, binding['kind'], binding['actionId'], binding['runtimeActionId'])
    raw = private_record(directory, RECEIPT)
    require(migrate.file_hash(raw) == binding['receiptSha256'], REFUSED)
    receipt = _profiled(raw, expected)
    configuration = runtime_directory / 'configuration'
    _configuration(configuration, initial, selected, source)
    _, _, proof = _retained(directory, runtime_directory, names, binding, identity, selected, expected)
    expected_receipt = {**identity, **{key: binding[key] for key in ('kind', 'actionId', 'runtimeActionId')}, **proof,
                        'gatewayProcessSha256': plan.get('gatewayProcessSha256')}
    require(_digest(plan.get('gatewayProcessSha256')) and _canonical(receipt) == _canonical(expected_receipt) and
            proof['runtimeInventorySha256'] == plan.get('runtimeInventorySha256') and
            int(plan['initialEpoch']) >= int(proof['frontendEpoch']), REFUSED)
    return configuration
