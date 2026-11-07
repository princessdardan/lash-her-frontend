"""Source-owned prior gateway boundary. No counter claims arrive from JSON.

The actual mounted gateway is closed and drained before any replacement. An
ordered-stop chain preserves unknown/uncertain counters rather than erasing them.
"""
import copy
import json
import os
from pathlib import Path
import re
import time
import tempfile
import stat
import subprocess
import frontend_gateway_observation
import migrate
import release as runtime
import staging_admission

require = migrate.demand
_AUTHORITY = object()
PROCESS_FIELDS = '{{.Image}}|{{.State.Running}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
ROOT = Path('/var/lib/lash-her/releases/staging')
BEFORE_STOP = 'prior-gateway-before-stop.json'
STOPPED = 'prior-gateway-stopped.json'
PROTOCOL = 'p2-prior-gateway-v1'


def _profile_kwargs(expected):
    return {} if expected is None else {'expected_profile': expected}


def _action_directories(action, expected=None):
    legacy = ('p2-'+action, 'p2-recovery-'+action, 'p2-certification-'+action)
    return legacy if expected is None else (*legacy, 'p2-profiled-current-'+action, 'p2-profiled-current-recovery-'+action)



def _lineage_path():
    return ROOT / '.p2-gateway-lineage.json'


def _read_lineage():
    root_info = ROOT.lstat()
    require(ROOT == ROOT.resolve() and stat.S_ISDIR(root_info.st_mode) and root_info.st_uid == os.getuid() and not root_info.st_mode & 0o022,
        'PRIOR_GATEWAY_LINEAGE_ROOT_REQUIRED')
    path = _lineage_path()
    if not path.exists():
        require(not path.is_symlink(),'PRIOR_GATEWAY_LINEAGE_SYMLINK_REFUSED')
        return None
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o600,
        'PRIOR_GATEWAY_LINEAGE_PERMISSIONS_REQUIRED')
    require(0 < info.st_size <= 65536, 'PRIOR_GATEWAY_LINEAGE_BOUNDS_REQUIRED')
    value = json.loads(path.read_bytes())
    require(isinstance(value,dict) and value.get('protocol') == PROTOCOL, 'PRIOR_GATEWAY_LINEAGE_PROTOCOL_REQUIRED')
    base = {'protocol','state','actionId','candidateSha256','process','binding'}
    state = value.get('state')
    extra = {'expectedCandidateSha256'} if state == 'replacement-in-progress' else {'stopReceiptDirectory','stopReceiptSha256'} if state == 'stopped-observed' else set()
    require(state in ('running-observed','replacement-in-progress','stopped-observed','prestop-unknown','preparation-refused') and
        set(value) == base | extra and isinstance(value.get('actionId'),str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',value['actionId']) and
        isinstance(value.get('candidateSha256'),str) and re.fullmatch(r'[a-f0-9]{64}',value['candidateSha256']), 'PRIOR_GATEWAY_LINEAGE_FIELDS_REQUIRED')
    return value


def _write_lineage(value):
    _read_lineage()  # Existing link/owner/mode is never silently replaced.
    record = {'protocol':PROTOCOL, **value}
    fd, name = tempfile.mkstemp(prefix='.p2-gateway-lineage-',dir=ROOT)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb') as stream:
            stream.write((json.dumps(record,sort_keys=True)+'\n').encode());stream.flush();os.fsync(stream.fileno())
        os.replace(name,_lineage_path())
        parent = os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(parent)
        finally:os.close(parent)
    finally:
        if os.path.exists(name):os.unlink(name)


def _remember(initial, observation, state='running-observed', **extra):
    _write_lineage({'state':state,'actionId':initial.get('recoveryActionId',initial.get('certificationActionId',initial.get('candidate',{}).get('releaseId'))),
        'candidateSha256':initial['candidateSha256'],'process':observation.get('process') if observation else None,
        'binding':observation.get('binding') if observation else None, **extra})


def _path(value):
    path = Path(value)
    require(path.is_absolute() and path == path.resolve() and (path == ROOT or ROOT in path.parents), 'PRIOR_GATEWAY_PRIVATE_PATH_REQUIRED')
    migrate.private_directory(path)
    return path


def _command(args, env, timeout):
    # Read-only Docker metadata/operations transport must not recurse through
    # scope.run -> scope.verify -> this observer. The held broker/guard verifies
    # before and after every bounded child; no mutating command is reachable.
    return subprocess.run(args, env=env, timeout=timeout, check=True,
        capture_output=True, text=True).stdout.strip()


def _assert_host(target):
    # The existing host policy uses runtime.command for read-only Docker engine
    # identity. During a scoped mutation its runner would recursively call this
    # boundary. Retain the same host policy with its unscoped read-only runner.
    token = runtime._command_scope.set(None)
    try:runtime.assert_host(target)
    finally:runtime._command_scope.reset(token)


def _run(command, verify, args):
    verify()
    value = command(args, runtime.SAFE_ENV, 5)
    verify()
    return value


def _inventory(command, verify):
    ids = _run(command, verify, ['docker', 'container', 'ls', '--all', '--filter', 'label=com.docker.compose.project=lash-her-staging',
        '--filter', 'label=com.docker.compose.service=gateway', '--format', '{{.ID}}', '--no-trunc']).split()
    require(len(ids) <= 1 and all(re.fullmatch(r'[a-f0-9]{64}', item) for item in ids), 'PRIOR_GATEWAY_EXACT_REPLICA_REQUIRED')
    return ids


def _process(identity, command, verify):
    values = _run(command, verify, ['docker', 'inspect', '--format', PROCESS_FIELDS, identity]).split('|')
    require(len(values) == 7 and re.fullmatch(r'sha256:[a-f0-9]{64}', values[0]) and values[1] in ('true', 'false') and
        values[2].isdigit() and values[4].isdigit() and values[5:] == ['lash-her-staging', 'gateway'] and
        re.fullmatch(r'[0-9TZ:.+-]{20,40}', values[3]), 'PRIOR_GATEWAY_PROCESS_REQUIRED')
    return {'containerId': identity, 'imageId': values[0], 'running': values[1] == 'true', 'pid': int(values[2]),
        'startedAt': values[3], 'restartCount': int(values[4])}


def _mounted_configuration(identity, command, verify):
    mounts = json.loads(_run(command, verify, ['docker', 'inspect', '--format', '{{json .Mounts}}', identity]))
    require(isinstance(mounts, list), 'PRIOR_GATEWAY_MOUNTS_REQUIRED')
    def source(destination):
        rows = [row for row in mounts if row.get('Destination') == destination]
        require(len(rows) == 1 and rows[0].get('Type') == 'bind' and rows[0].get('RW') is False, 'PRIOR_GATEWAY_READONLY_MOUNT_REQUIRED')
        return Path(rows[0]['Source'])
    gateway = source('/config/gateway.json')
    require(gateway.name == 'gateway.json', 'PRIOR_GATEWAY_CONFIG_MOUNT_REQUIRED')
    configuration = _path(str(gateway.parent))
    require(source('/admission') == configuration / 'admission', 'PRIOR_GATEWAY_ADMISSION_MOUNT_REQUIRED')
    return configuration


def _validate_reference(initial):
    ref = initial.get('priorGatewayReference')
    if ref is None:return
    require(isinstance(ref,dict), 'PRIOR_GATEWAY_REFERENCE_FIELDS_REQUIRED')
    base = {'kind','candidateDirectory','configurationDirectory','runtimeReceiptDirectory','candidateSha256','runtimeReceiptSha256'}
    stop = {'stopReceiptDirectory','stopReceiptSha256'}
    require(ref.get('kind') == 'retained-runtime' and set(ref) in (base,base|stop) or
        ref.get('kind') == 'stopped-current-candidate' and set(ref) == {'kind'}|stop, 'PRIOR_GATEWAY_REFERENCE_FIELDS_REQUIRED')
    for key,value in ref.items():
        if key.endswith('Sha256'):
            require(isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value) and value != '0'*64, 'PRIOR_GATEWAY_REFERENCE_HASH_REQUIRED')
        elif key.endswith('Directory'):
            require(isinstance(value,str) and 0 < len(value) <= 4096, 'PRIOR_GATEWAY_REFERENCE_PATH_REQUIRED')
            _path(value)


class PriorGatewayObservationError(ValueError):
    def __init__(self, partial):
        super().__init__('PRIOR_GATEWAY_ADMISSION_OBSERVATION_UNKNOWN')
        self.partial = partial


def _reference(initial, selected, configuration, identity, *, expected_profile=None):
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    target = migrate.read_json(configuration, 'runtime.json', **_profile_kwargs(expected_profile))
    gateway = migrate.read_json(configuration, 'gateway.json')
    admission = gateway.get('admission')
    require(isinstance(admission, dict), 'PRIOR_GATEWAY_ADMISSION_PROTOCOL_REQUIRED')
    selected_hash = initial['candidateSha256']
    if admission.get('candidateSha256') == selected_hash and admission.get('releaseId') == selected['releaseId']:
        prior = selected
        prior_profile = expected_profile
        expected_hashes = initial['configurationSha256']
        require(all(migrate.file_hash(migrate.read_input(configuration, name)) == expected_hashes[name] for name in ('runtime.json', 'gateway.json')),
            'PRIOR_GATEWAY_SELECTED_CONFIGURATION_CHANGED')
    else:
        ref = initial.get('priorGatewayReference')
        require(isinstance(ref, dict) and ref.get('kind') == 'retained-runtime' and
            set(ref) in ({'kind','candidateDirectory','configurationDirectory','runtimeReceiptDirectory','candidateSha256','runtimeReceiptSha256'},
                {'kind','candidateDirectory','configurationDirectory','runtimeReceiptDirectory','candidateSha256','runtimeReceiptSha256','stopReceiptDirectory','stopReceiptSha256'}),
            'PRIOR_GATEWAY_RETAINED_REFERENCE_REQUIRED')
        bundle, retained, receipt_directory = (_path(ref[name]) for name in ('candidateDirectory', 'configurationDirectory', 'runtimeReceiptDirectory'))
        # Validate the retained candidate against ITS pinned Compose/config.
        # No current ten-service/P2 schema requirement is imposed on a P1 prior.
        retained_candidate = migrate.read_json(bundle, 'release.candidate.json', **_profile_kwargs(expected_profile))
        prior_profile = expected_profile if 'qualificationTargetProfile' in retained_candidate else None
        # The new source path may retain an actual legacy predecessor. It never
        # downcasts a profiled predecessor or selects an unregistered policy.
        migrate.candidate_profile(retained_candidate, prior_profile)
        prior, _jobs, retained_plan, _compose = runtime.make_plan(bundle,retained,retained/'compose.yaml', **_profile_kwargs(prior_profile))
        require(retained_plan['hostMachineId'] == initial['hostMachineId'], 'PRIOR_GATEWAY_RETAINED_HOST_REQUIRED')
        raw = migrate.read_input(bundle, 'release.candidate.json')
        require(migrate.file_hash(raw) == ref['candidateSha256'] == admission.get('candidateSha256') and prior['releaseId'] == admission.get('releaseId') and
            retained == configuration and prior['environment'] == 'staging', 'PRIOR_GATEWAY_RETAINED_CANDIDATE_REQUIRED')
        raw = migrate.read_input(receipt_directory, 'runtime-outcome.json')
        if prior_profile is None:
            receipt = json.loads(raw)
        else:
            from qualification_target_profile import decode_qualification_target_json
            receipt = decode_qualification_target_json(raw, "carrier")
            migrate.require_profile(prior_profile, receipt)
            require(type(receipt.get('version')) is int and receipt['version'] == 2,
                    'PRIOR_GATEWAY_RETAINED_RUNTIME_PROFILE_REQUIRED')
        migrate.require_contract_identity(prior,receipt)
        require(migrate.file_hash(raw) == ref['runtimeReceiptSha256'] and receipt.get('status') in ('API_RUNTIME_READY','API_RUNTIME_RESTORED_FOR_QUALIFICATION') and
            receipt.get('phase') == 'completed' and receipt.get('environment') == 'staging' and
            receipt.get('candidateSha256') == ref['candidateSha256'] and receipt.get('releaseId') == prior['releaseId'] and
            any(row.get('service') == 'gateway' and row.get('containerId') == identity and row.get('image') == prior['artifacts']['gateway']['image']
                for row in receipt.get('containers', [])), 'PRIOR_GATEWAY_RETAINED_RUNTIME_REQUIRED')
    if expected_profile is not None:
        runtime._runtime_target_profile(target, prior, prior_profile)
    require(target.get('environment') == gateway.get('appEnv') == 'staging' and target.get('releaseId') == prior['releaseId'] and
        target.get('hostMachineId') == initial['hostMachineId'] and gateway.get('projectId') == prior['workload']['projectId'] and
        admission == {'file':'/admission/state.json','releaseId':prior['releaseId'],'candidateSha256':admission['candidateSha256']},
        'PRIOR_GATEWAY_SOURCE_BINDING_REQUIRED')
    return {'releaseId': prior['releaseId'], 'candidateSha256': admission['candidateSha256'], 'hostMachineId': initial['hostMachineId'],
        'gatewayImage': prior['artifacts']['gateway']['image'], 'runtimeConfigurationSha256': migrate.file_hash(migrate.read_input(configuration,'runtime.json')),
        'gatewayConfigurationSha256': migrate.file_hash(migrate.read_input(configuration,'gateway.json')), 'configurationDirectory': str(configuration)}


def observe_prior_gateway(initial, selected, verify, command=None, assert_host=None, *, expected_profile=None):
    """Actual read-only observer, also usable by the separate known-ACK binder."""
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    command = command or _command
    _validate_reference(initial)
    ids = _inventory(command, verify)
    require(len(ids) == 1, 'PRIOR_GATEWAY_ABSENT_UNKNOWN')
    process = _process(ids[0], command, verify)
    require(process['running'] and process['pid'] > 0, 'PRIOR_GATEWAY_STOPPED_PROOF_REQUIRED')
    configuration = _mounted_configuration(ids[0], command, verify)
    binding = _reference(initial, selected, configuration, ids[0], **_profile_kwargs(expected_profile))
    reviewed = {key: value for key, value in binding.items() if key != 'configurationDirectory'}
    try:
        actual = frontend_gateway_observation.observe(configuration, reviewed, verify, command, assert_host or _assert_host)
    except BaseException:
        # Preserve actual identity/config even if the operations endpoint cannot
        # return trustworthy counters. This is never a closed-zero observation.
        raise PriorGatewayObservationError({'status':'PRIOR_GATEWAY_OBSERVATION_UNKNOWN','binding':binding,'process':process,'admission':None}) from None
    require(_process(ids[0], command, verify) == process and _inventory(command, verify) == ids, 'PRIOR_GATEWAY_PROCESS_CHANGED')
    return {'status':'PRIOR_GATEWAY_OBSERVED','binding':binding,'process':process,'admission':actual['admission']}


def _closed_observed(observation):
    state = observation.get('admission') or {}
    return state.get('newWork') is False and state.get('recovery') is False and all(
        isinstance(state.get(field), dict) and set(state[field]) == {'newWork','recovery'} and
        all(type(value) is int and value >= 0 for value in state[field].values()) for field in ('active','uncertain'))


def _zero(observation):
    return _closed_observed(observation) and all(value == 0 for field in ('active','uncertain') for value in observation['admission'][field].values())


def _close(initial, selected, verify, command, assert_host, clock, progress=None, *, expected_profile=None):
    before = observe_prior_gateway(initial, selected, verify, command, assert_host, **_profile_kwargs(expected_profile))
    if progress is not None: progress(before)
    binding = before['binding']
    digest = staging_admission.persist_state(Path(binding['configurationDirectory']), binding,
        'p2-prior-' + initial.get('recoveryActionId', selected['releaseId']), new_work=False, recovery=False)
    deadline = clock.monotonic() + staging_admission.DRAIN_SECONDS
    while True:
        actual = observe_prior_gateway(initial, selected, verify, command, assert_host, **_profile_kwargs(expected_profile))
        if progress is not None: progress(actual)
        require(actual['process'] == before['process'] and actual['binding'] == binding and actual['admission']['sha256'] == digest,
            'PRIOR_GATEWAY_CLOSE_ACK_CHANGED')
        if any(actual['admission']['uncertain'].values()):
            return actual
        if _zero(actual):
            return actual
        if clock.monotonic() >= deadline:
            return actual  # Preserve the actual nonzero count for containment.
        clock.sleep(0.05)


def _source_sha256():
    return migrate.file_hash(Path(__file__).read_bytes())


def observe_stopped_prior_gateway(initial, selected, verify, command=None, *, expected_profile=None):
    """Read-only retained counters, not an authorization or zero inference."""
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    command = command or _command
    _validate_reference(initial)
    ref = initial.get('priorGatewayReference')
    require(isinstance(ref, dict) and ref.get('kind') in ('retained-runtime','stopped-current-candidate') and
        isinstance(ref.get('stopReceiptDirectory'), str) and re.fullmatch(r'[a-f0-9]{64}', ref.get('stopReceiptSha256','')),
        'PRIOR_GATEWAY_STOP_REFERENCE_REQUIRED')
    if ref['kind'] == 'stopped-current-candidate':
        require(set(ref) == {'kind','stopReceiptDirectory','stopReceiptSha256'}, 'PRIOR_GATEWAY_STOP_REFERENCE_FIELDS_REQUIRED')
    directory = _path(ref['stopReceiptDirectory'])
    raw = migrate.read_input(directory, STOPPED)
    require(migrate.file_hash(raw) == ref['stopReceiptSha256'], 'PRIOR_GATEWAY_STOP_RECEIPT_CHANGED')
    stopped = json.loads(raw)
    before_raw = migrate.read_input(directory, BEFORE_STOP)
    before = json.loads(before_raw)
    require(stopped.get('protocol') == before.get('protocol') == PROTOCOL and
        stopped.get('sourceModuleSha256') == before.get('sourceModuleSha256') == _source_sha256() and
        stopped.get('beforeSha256') == migrate.file_hash(before_raw) and
        stopped.get('candidateSha256') == before.get('candidateSha256') and
        isinstance(before.get('candidateSha256'),str) and re.fullmatch(r'[a-f0-9]{64}',before['candidateSha256']) and
        (ref['kind'] == 'retained-runtime' or before['candidateSha256'] == initial['candidateSha256']) and
        stopped.get('actionId') == before.get('actionId') and isinstance(before.get('actionId'), str) and
        (directory.name in _action_directories(before['actionId'], expected_profile) or
         directory.name in ('prior-gateway-after-quiescence','prior-gateway-broker-fallback','prior-gateway-api-suspension') and directory.parent.name in _action_directories(before['actionId'], expected_profile)) and
        stopped.get('status') == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED' and before.get('status') == 'PRIOR_GATEWAY_PRESTOP_OBSERVED' and
        _closed_observed(before.get('observation') or {}), 'PRIOR_GATEWAY_STOP_PROOF_REQUIRED')
    observation = before['observation']
    require(_reference(initial, selected, _path(observation['binding']['configurationDirectory']), observation['process']['containerId'], **_profile_kwargs(expected_profile)) == observation['binding'],
        'PRIOR_GATEWAY_STOP_BINDING_CHANGED')
    ids = _inventory(command, verify)
    require(not ids or ids == [observation['process']['containerId']], 'PRIOR_GATEWAY_STOPPED_INVENTORY_CHANGED')
    pointer = _read_lineage()
    require(pointer is not None and pointer.get('state') == 'stopped-observed' and pointer.get('process') == observation['process'] and
        pointer.get('binding') == observation['binding'] and pointer.get('stopReceiptDirectory') == str(directory) and
        pointer.get('stopReceiptSha256') == ref['stopReceiptSha256'], 'PRIOR_GATEWAY_LATEST_STOP_LINEAGE_REQUIRED')
    if ids:
        require(_process(ids[0],command,verify) == stopped.get('stoppedProcess'), 'PRIOR_GATEWAY_STOPPED_PROCESS_CHANGED')
        require(_mounted_configuration(ids[0],command,verify) == Path(observation['binding']['configurationDirectory']), 'PRIOR_GATEWAY_STOPPED_MOUNT_CHANGED')
    require(stopped.get('stoppedProcess') and stopped['stoppedProcess'].get('running') is False and stopped['stoppedProcess'].get('pid') == 0 and
        all(stopped['stoppedProcess'].get(key) == observation['process'].get(key) for key in ('containerId','imageId','startedAt','restartCount')),
        'PRIOR_GATEWAY_STOPPED_IDENTITY_REQUIRED')
    verify()
    return observation


def _stopped_observation(initial,selected,verify,command, *, expected_profile=None):
    observation=observe_stopped_prior_gateway(initial,selected,verify,command, **_profile_kwargs(expected_profile))
    require(_zero(observation),'PRIOR_GATEWAY_STOP_PROOF_REQUIRES_ZERO')
    return observation


class PriorGatewayBoundary:
    def __init__(self, authority, initial, selected, verify, command, assert_host, observation, stopped=False, *, output=None, expected_profile=None):
        require(authority is _AUTHORITY, 'PRIOR_GATEWAY_SOURCE_AUTHORITY_REQUIRED')
        # Never retain credentials or mutable caller state in the authority.
        self.expected_profile = migrate.profile_context(expected_profile)
        migrate.candidate_profile(selected, self.expected_profile)
        self.initial = copy.deepcopy({key:initial[key] for key in ('candidateSha256','hostMachineId','configurationSha256','priorGatewayReference','recoveryActionId','certificationActionId') if key in initial})
        self.initial.setdefault('recoveryActionId', initial.get('certificationActionId',selected['releaseId']))
        self.selected, self.verify_session = copy.deepcopy(selected), verify
        self.command, self.assert_host, self.observation = command, assert_host, observation
        self.replacement_started = self.replacement_finished = False
        self.stopped = stopped
        self.stage_index, self.stage_active = 0, None
        self.output = _path(str(output)) if output is not None else None
        self.api_suspension_started = self.api_suspension_finished = False

    def verify(self):
        require(not self.api_suspension_started or self.api_suspension_finished, 'PRIOR_GATEWAY_API_SUSPENSION_UNVERIFIED')
        if self.replacement_started and not self.replacement_finished:
            self.verify_session();return  # Only the fixed gateway-last command owns this transition.
        if self.replacement_finished:
            actual = observe_prior_gateway(self.initial,self.selected,self.verify_session,self.command,self.assert_host, **_profile_kwargs(self.expected_profile))
            require(actual['process'] == self.current['process'] and actual['binding'] == self.current['binding'], 'PRIOR_GATEWAY_REPLACED_PROCESS_CHANGED')
        elif self.stopped:
            _stopped_observation(self.initial,self.selected,self.verify_session,self.command, **_profile_kwargs(self.expected_profile))
        else:
            actual = observe_prior_gateway(self.initial,self.selected,self.verify_session,self.command,self.assert_host, **_profile_kwargs(self.expected_profile))
            require(actual['process'] == self.observation['process'] and actual['binding'] == self.observation['binding'] and _zero(actual),
                'PRIOR_GATEWAY_BOUNDARY_CHANGED')

    def before_api_suspension(self):
        require(not self.api_suspension_started and self.stage_index == 0 and self.stage_active is None and
            not self.replacement_started and self.output is not None, 'PRIOR_GATEWAY_API_SUSPENSION_STAGE_REQUIRED')
        action = self.initial['recoveryActionId']
        require(self.output.name in _action_directories(action, self.expected_profile),
            'PRIOR_GATEWAY_API_SUSPENSION_DIRECTORY_REQUIRED')
        self._verify_old()
        self.api_suspension_started = True
        self.api_suspension_directory = self.output / 'prior-gateway-api-suspension'
        self.api_suspension_directory.mkdir(mode=0o700)
        before = capture_before_stop(self.initial,self.selected,self.api_suspension_directory,self.verify_session,self.command,self.assert_host, **_profile_kwargs(self.expected_profile))
        require(before['status'] == 'PRIOR_GATEWAY_PRESTOP_OBSERVED' and _zero(before.get('observation') or {}) and
            before['observation']['process'] == self.observation['process'] and before['observation']['binding'] == self.observation['binding'],
            'PRIOR_GATEWAY_API_PRESTOP_ZERO_REQUIRED')
        self.api_suspension_before = before

    def after_api_suspension(self):
        require(self.api_suspension_started and not self.api_suspension_finished and hasattr(self,'api_suspension_before'),
            'PRIOR_GATEWAY_API_SUSPENSION_NOT_STARTED')
        record = retain_ordered_stop(self.api_suspension_before,self.api_suspension_directory,self.verify_session,self.command, **_profile_kwargs(self.expected_profile))
        require(record['status'] == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED', 'PRIOR_GATEWAY_API_STOP_UNVERIFIED')
        stop = {'stopReceiptDirectory':str(self.api_suspension_directory),
            'stopReceiptSha256':migrate.file_hash(migrate.read_input(self.api_suspension_directory,STOPPED))}
        if self.observation['binding']['candidateSha256'] == self.initial['candidateSha256']:
            reference = {'kind':'stopped-current-candidate',**stop}
        else:
            reference = {**self.initial['priorGatewayReference'],**stop}
            require(reference.get('kind') == 'retained-runtime', 'PRIOR_GATEWAY_RETAINED_REFERENCE_REQUIRED')
        initial = {**self.initial,'priorGatewayReference':reference}
        actual = _stopped_observation(initial,self.selected,self.verify_session,self.command, **_profile_kwargs(self.expected_profile))
        require(actual['process'] == self.observation['process'] and actual['binding'] == self.observation['binding'],
            'PRIOR_GATEWAY_API_STOP_BINDING_CHANGED')
        self.initial, self.observation = initial, actual
        self.stopped = self.api_suspension_finished = True

    def before_stage(self, stage):
        require(not self.api_suspension_started or self.api_suspension_finished, 'PRIOR_GATEWAY_API_SUSPENSION_UNVERIFIED')
        require(self.stage_active is None and self.stage_index < len(runtime.STAGES) and tuple(stage) == runtime.STAGES[self.stage_index] and not self.replacement_finished, 'PRIOR_GATEWAY_STAGE_REQUIRED')
        self._verify_old()
        self.stage_active = tuple(stage)
        if tuple(stage) == ('gateway',):
            require(not self.replacement_started, 'PRIOR_GATEWAY_REPLACEMENT_ALREADY_STARTED')
            _remember(self.initial,self.observation,'replacement-in-progress',expectedCandidateSha256=self.initial['candidateSha256'])
            self.replacement_started = True

    def _verify_old(self):
        if self.stopped:
            actual = _stopped_observation(self.initial, self.selected, self.verify_session, self.command, **_profile_kwargs(self.expected_profile))
        else:
            actual = observe_prior_gateway(self.initial, self.selected, self.verify_session, self.command, self.assert_host, **_profile_kwargs(self.expected_profile))
        require(actual['process'] == self.observation['process'] and actual['binding'] == self.observation['binding'] and _zero(actual),
            'PRIOR_GATEWAY_BOUNDARY_CHANGED')

    def after_stage(self, stage):
        require(self.stage_active == tuple(stage), 'PRIOR_GATEWAY_STAGE_NOT_STARTED')
        if tuple(stage) != ('gateway',):
            self._verify_old()
            self.stage_active = None; self.stage_index += 1
            return
        require(self.replacement_started and not self.replacement_finished, 'PRIOR_GATEWAY_REPLACEMENT_NOT_STARTED')
        actual = observe_prior_gateway(self.initial, self.selected, self.verify_session, self.command, self.assert_host, **_profile_kwargs(self.expected_profile))
        require(actual['binding']['candidateSha256'] == self.initial['candidateSha256'] and _zero(actual), 'PRIOR_GATEWAY_NEW_BOUNDARY_REQUIRED')
        require(actual['process']['containerId'] != self.observation['process']['containerId'],
            'PRIOR_GATEWAY_REPLACEMENT_NEW_CONTAINER_REQUIRED')
        _remember(self.initial,actual)
        self.replacement_finished = True
        self.current = actual
        self.stage_active = None; self.stage_index += 1


def preflight_prior_gateway(initial, selected, verify, command=None, assert_host=None, *, expected_profile=None):
    """No state/pointer writes. Eligible FE recovery is not closed here."""
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    command = command or _command
    _validate_reference(initial)
    ids = _inventory(command,verify)
    if ids and _process(ids[0],command,verify)['running']:
        return observe_prior_gateway(initial,selected,verify,command,assert_host, **_profile_kwargs(expected_profile))
    return _stopped_observation(initial,selected,verify,command, **_profile_kwargs(expected_profile))


def prepare_prior_gateway(initial, selected, output, verify, command=None, assert_host=None, clock=time, *, expected_profile=None):
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    command = command or _command
    migrate.private_directory(output)
    outcome = {'protocol':PROTOCOL,'status':'PRIOR_GATEWAY_REPLACEMENT_REFUSED','candidateSha256':initial['candidateSha256'],
        'actionId':initial.get('recoveryActionId',selected['releaseId']),'observation':None}
    if expected_profile is not None:
        outcome.update(version=2, qualificationTargetProfile=migrate.profile_context(expected_profile))
    try:
        _validate_reference(initial)
        ids = _inventory(command, verify)
        stopped = not ids or not _process(ids[0], command, verify)['running']
        actual = _stopped_observation(initial, selected, verify, command, **_profile_kwargs(expected_profile)) if stopped else _close(initial, selected, verify, command, assert_host, clock, lambda value:outcome.update(observation=value), **_profile_kwargs(expected_profile))
        outcome['observation'] = actual
        _remember(initial,actual, 'stopped-observed' if stopped else 'running-observed',
            **({'stopReceiptDirectory':initial['priorGatewayReference']['stopReceiptDirectory'],
                'stopReceiptSha256':initial['priorGatewayReference']['stopReceiptSha256']} if stopped else {}))
        require(_zero(actual), 'PRIOR_GATEWAY_UNCERTAIN_REQUIRES_RECONCILIATION')
        outcome['status'] = 'PRIOR_GATEWAY_CLOSED_ZERO'
        return PriorGatewayBoundary(_AUTHORITY, initial, selected, verify, command, assert_host, actual, stopped, output=output, **_profile_kwargs(expected_profile))
    except BaseException as error:
        if outcome['observation'] is None and isinstance(error,PriorGatewayObservationError):outcome['observation']=error.partial
        try: _remember(initial,outcome['observation'],'preparation-refused')
        except BaseException: pass
        raise
    finally:
        migrate.write_json(output,'prior-gateway-boundary.json',outcome)


def _stopped_for_containment(initial, selected, verify, command, *, expected_profile=None):
    try:
        return observe_stopped_prior_gateway(initial,selected,verify,command, **_profile_kwargs(expected_profile))
    except (ValueError,OSError):
        # A source stop in this action may postdate the original forked input.
        # Only containment can discover that fixed-root latest receipt; ordinary
        # preflight/preparation still requires its explicit reviewed reference.
        pointer = _read_lineage()
        require(pointer is not None and pointer['state'] == 'stopped-observed' and
            pointer['candidateSha256'] == initial['candidateSha256'] and isinstance(pointer.get('binding'),dict) and
            pointer['binding'].get('hostMachineId') == initial['hostMachineId'], 'PRIOR_GATEWAY_CONTAINMENT_LATEST_REQUIRED')
        stop = {'stopReceiptDirectory':pointer['stopReceiptDirectory'],'stopReceiptSha256':pointer['stopReceiptSha256']}
        if pointer['binding'].get('candidateSha256') == initial['candidateSha256']:
            reference = {'kind':'stopped-current-candidate',**stop}
        else:
            prior = initial.get('priorGatewayReference') or {}
            require(prior.get('kind') == 'retained-runtime' and prior.get('candidateSha256') == pointer['binding'].get('candidateSha256') and
                prior.get('configurationDirectory') == pointer['binding'].get('configurationDirectory'), 'PRIOR_GATEWAY_CONTAINMENT_PRIOR_REQUIRED')
            reference = {**prior,**stop}
        return observe_stopped_prior_gateway({**initial,'priorGatewayReference':reference},selected,verify,command, **_profile_kwargs(expected_profile))


def capture_before_stop(initial, selected, output, verify, command=None, assert_host=None, clock=time, *, expected_profile=None):
    """Containment never requires successful drain; retain unknown/nonzero."""
    expected_profile = migrate.profile_context(expected_profile)
    migrate.candidate_profile(selected, expected_profile)
    command = command or _command
    record = {'protocol':PROTOCOL,'sourceModuleSha256':_source_sha256(),'status':'PRIOR_GATEWAY_PRESTOP_UNKNOWN','candidateSha256':initial['candidateSha256'],
        'actionId':initial.get('recoveryActionId',initial.get('certificationActionId',selected['releaseId'])),'observation':None}
    if expected_profile is not None:
        record.update(version=2, qualificationTargetProfile=migrate.profile_context(expected_profile))
    try:
        ids = _inventory(command,verify)
        if not ids or not _process(ids[0],command,verify)['running']:
            record['observation'] = _stopped_for_containment(initial,selected,verify,command, **_profile_kwargs(expected_profile))
        else:
            record['observation'] = _close(initial, selected, verify, command, assert_host, clock, lambda value:record.update(observation=value), **_profile_kwargs(expected_profile))
        record['status'] = 'PRIOR_GATEWAY_PRESTOP_OBSERVED'
        _remember(initial,record['observation'])
    except BaseException as error:
        if record['observation'] is None and isinstance(error,PriorGatewayObservationError):record['observation']=error.partial
        if record['observation'] is None:
            try:
                ids=_inventory(command,verify)
                require(len(ids)==1,'PRIOR_GATEWAY_EXACT_PROCESS_REQUIRED')
                process=_process(ids[0],command,verify)
                configuration=_mounted_configuration(ids[0],command,verify)
                binding=_reference(initial,selected,configuration,ids[0], **_profile_kwargs(expected_profile))
                record['observation']={'status':'PRIOR_GATEWAY_OBSERVATION_UNKNOWN','process':process,'binding':binding,'admission':None}
            except BaseException:pass
        try:_remember(initial,record['observation'],'prestop-unknown')
        except BaseException:pass
    migrate.write_json(output,BEFORE_STOP,record)
    return record


def retain_ordered_stop(before, output, verify, command=None, *, expected_profile=None):
    command = command or _command
    observed = before.get('observation')
    record = {'protocol':PROTOCOL,'sourceModuleSha256':_source_sha256(),'status':'PRIOR_GATEWAY_STOP_UNKNOWN','beforeSha256':migrate.file_hash(migrate.read_input(output,BEFORE_STOP)),
        'candidateSha256':before['candidateSha256'],'actionId':before['actionId'],'stoppedProcess':None}
    if expected_profile is not None:
        record.update(version=2, qualificationTargetProfile=migrate.profile_context(expected_profile))
    if observed is not None:
        try:
            process = _process(observed['process']['containerId'],command,verify)
            require(not process['running'] and process['pid'] == 0 and all(process[key] == observed['process'][key]
                for key in ('containerId','imageId','startedAt','restartCount')), 'PRIOR_GATEWAY_ORDERED_STOP_REQUIRED')
            record['stoppedProcess'] = process
            record['status'] = 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED'
        except BaseException:
            pass
    migrate.write_json(output,STOPPED,record)
    if observed is not None and record['status'] == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED':
        _remember({'candidateSha256':before['candidateSha256'],'recoveryActionId':before['actionId']},observed,'stopped-observed',
            stopReceiptDirectory=str(output),stopReceiptSha256=migrate.file_hash(migrate.read_input(output,STOPPED)))
    return record
