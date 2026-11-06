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


def _reference(initial, selected, configuration, identity):
    target = migrate.read_json(configuration, 'runtime.json')
    gateway = migrate.read_json(configuration, 'gateway.json')
    admission = gateway.get('admission')
    require(isinstance(admission, dict), 'PRIOR_GATEWAY_ADMISSION_PROTOCOL_REQUIRED')
    selected_hash = initial['candidateSha256']
    if admission.get('candidateSha256') == selected_hash and admission.get('releaseId') == selected['releaseId']:
        prior = selected
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
        prior, _jobs, retained_plan, _compose = runtime.make_plan(bundle,retained,retained/'compose.yaml')
        require(retained_plan['hostMachineId'] == initial['hostMachineId'], 'PRIOR_GATEWAY_RETAINED_HOST_REQUIRED')
        raw = migrate.read_input(bundle, 'release.candidate.json')
        require(migrate.file_hash(raw) == ref['candidateSha256'] == admission.get('candidateSha256') and prior['releaseId'] == admission.get('releaseId') and
            retained == configuration and prior['environment'] == 'staging', 'PRIOR_GATEWAY_RETAINED_CANDIDATE_REQUIRED')
        raw = migrate.read_input(receipt_directory, 'runtime-outcome.json')
        receipt = json.loads(raw)
        migrate.require_contract_identity(prior,receipt)
        require(migrate.file_hash(raw) == ref['runtimeReceiptSha256'] and receipt.get('status') in ('API_RUNTIME_READY','API_RUNTIME_RESTORED_FOR_QUALIFICATION') and
            receipt.get('phase') == 'completed' and receipt.get('environment') == 'staging' and
            receipt.get('candidateSha256') == ref['candidateSha256'] and receipt.get('releaseId') == prior['releaseId'] and
            any(row.get('service') == 'gateway' and row.get('containerId') == identity and row.get('image') == prior['artifacts']['gateway']['image']
                for row in receipt.get('containers', [])), 'PRIOR_GATEWAY_RETAINED_RUNTIME_REQUIRED')
    require(target.get('environment') == gateway.get('appEnv') == 'staging' and target.get('releaseId') == prior['releaseId'] and
        target.get('hostMachineId') == initial['hostMachineId'] and gateway.get('projectId') == prior['workload']['projectId'] and
        admission == {'file':'/admission/state.json','releaseId':prior['releaseId'],'candidateSha256':admission['candidateSha256']},
        'PRIOR_GATEWAY_SOURCE_BINDING_REQUIRED')
    return {'releaseId': prior['releaseId'], 'candidateSha256': admission['candidateSha256'], 'hostMachineId': initial['hostMachineId'],
        'gatewayImage': prior['artifacts']['gateway']['image'], 'runtimeConfigurationSha256': migrate.file_hash(migrate.read_input(configuration,'runtime.json')),
        'gatewayConfigurationSha256': migrate.file_hash(migrate.read_input(configuration,'gateway.json')), 'configurationDirectory': str(configuration)}


def observe_prior_gateway(initial, selected, verify, command=None, assert_host=None):
    """Actual read-only observer, also usable by the separate known-ACK binder."""
    command = command or _command
    _validate_reference(initial)
    ids = _inventory(command, verify)
    require(len(ids) == 1, 'PRIOR_GATEWAY_ABSENT_UNKNOWN')
    process = _process(ids[0], command, verify)
    require(process['running'] and process['pid'] > 0, 'PRIOR_GATEWAY_STOPPED_PROOF_REQUIRED')
    configuration = _mounted_configuration(ids[0], command, verify)
    binding = _reference(initial, selected, configuration, ids[0])
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


def _close(initial, selected, verify, command, assert_host, clock, progress=None):
    before = observe_prior_gateway(initial, selected, verify, command, assert_host)
    if progress is not None: progress(before)
    binding = before['binding']
    digest = staging_admission.persist_state(Path(binding['configurationDirectory']), binding,
        'p2-prior-' + initial.get('recoveryActionId', selected['releaseId']), new_work=False, recovery=False)
    deadline = clock.monotonic() + staging_admission.DRAIN_SECONDS
    while True:
        actual = observe_prior_gateway(initial, selected, verify, command, assert_host)
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


def observe_stopped_prior_gateway(initial, selected, verify, command=None):
    """Read-only retained counters, not an authorization or zero inference."""
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
        (directory.name in ('p2-'+before['actionId'],'p2-recovery-'+before['actionId'],'p2-certification-'+before['actionId']) or
         directory.name in ('prior-gateway-after-quiescence','prior-gateway-broker-fallback') and directory.parent.name in ('p2-'+before['actionId'],'p2-recovery-'+before['actionId'],'p2-certification-'+before['actionId'])) and
        stopped.get('status') == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED' and before.get('status') == 'PRIOR_GATEWAY_PRESTOP_OBSERVED' and
        _closed_observed(before.get('observation') or {}), 'PRIOR_GATEWAY_STOP_PROOF_REQUIRED')
    observation = before['observation']
    require(_reference(initial, selected, _path(observation['binding']['configurationDirectory']), observation['process']['containerId']) == observation['binding'],
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


def _stopped_observation(initial,selected,verify,command):
    observation=observe_stopped_prior_gateway(initial,selected,verify,command)
    require(_zero(observation),'PRIOR_GATEWAY_STOP_PROOF_REQUIRES_ZERO')
    return observation


class PriorGatewayBoundary:
    def __init__(self, authority, initial, selected, verify, command, assert_host, observation, stopped=False):
        require(authority is _AUTHORITY, 'PRIOR_GATEWAY_SOURCE_AUTHORITY_REQUIRED')
        # Never retain credentials or mutable caller state in the authority.
        self.initial = copy.deepcopy({key:initial[key] for key in ('candidateSha256','hostMachineId','configurationSha256','priorGatewayReference','recoveryActionId','certificationActionId') if key in initial})
        self.initial.setdefault('recoveryActionId', initial.get('certificationActionId',selected['releaseId']))
        self.selected, self.verify_session = copy.deepcopy(selected), verify
        self.command, self.assert_host, self.observation = command, assert_host, observation
        self.replacement_started = self.replacement_finished = False
        self.stopped = stopped
        self.stage_index, self.stage_active = 0, None

    def verify(self):
        if self.replacement_started and not self.replacement_finished:
            self.verify_session();return  # Only the fixed gateway-last command owns this transition.
        if self.replacement_finished:
            actual = observe_prior_gateway(self.initial,self.selected,self.verify_session,self.command,self.assert_host)
            require(actual['process'] == self.current['process'] and actual['binding'] == self.current['binding'], 'PRIOR_GATEWAY_REPLACED_PROCESS_CHANGED')
        elif self.stopped:
            _stopped_observation(self.initial,self.selected,self.verify_session,self.command)
        else:
            actual = observe_prior_gateway(self.initial,self.selected,self.verify_session,self.command,self.assert_host)
            require(actual['process'] == self.observation['process'] and actual['binding'] == self.observation['binding'] and _zero(actual),
                'PRIOR_GATEWAY_BOUNDARY_CHANGED')


    def before_stage(self, stage):
        require(self.stage_active is None and self.stage_index < len(runtime.STAGES) and tuple(stage) == runtime.STAGES[self.stage_index] and not self.replacement_finished, 'PRIOR_GATEWAY_STAGE_REQUIRED')
        self._verify_old()
        self.stage_active = tuple(stage)
        if tuple(stage) == ('gateway',):
            require(not self.replacement_started, 'PRIOR_GATEWAY_REPLACEMENT_ALREADY_STARTED')
            _remember(self.initial,self.observation,'replacement-in-progress',expectedCandidateSha256=self.initial['candidateSha256'])
            self.replacement_started = True

    def _verify_old(self):
        if self.stopped:
            actual = _stopped_observation(self.initial, self.selected, self.verify_session, self.command)
        else:
            actual = observe_prior_gateway(self.initial, self.selected, self.verify_session, self.command, self.assert_host)
        require(actual['process'] == self.observation['process'] and actual['binding'] == self.observation['binding'] and _zero(actual),
            'PRIOR_GATEWAY_BOUNDARY_CHANGED')

    def after_stage(self, stage):
        require(self.stage_active == tuple(stage), 'PRIOR_GATEWAY_STAGE_NOT_STARTED')
        if tuple(stage) != ('gateway',):
            self._verify_old()
            self.stage_active = None; self.stage_index += 1
            return
        require(self.replacement_started and not self.replacement_finished, 'PRIOR_GATEWAY_REPLACEMENT_NOT_STARTED')
        actual = observe_prior_gateway(self.initial, self.selected, self.verify_session, self.command, self.assert_host)
        require(actual['binding']['candidateSha256'] == self.initial['candidateSha256'] and _zero(actual), 'PRIOR_GATEWAY_NEW_BOUNDARY_REQUIRED')
        require(actual['process']['containerId'] != self.observation['process']['containerId'],
            'PRIOR_GATEWAY_REPLACEMENT_NEW_CONTAINER_REQUIRED')
        _remember(self.initial,actual)
        self.replacement_finished = True
        self.current = actual
        self.stage_active = None; self.stage_index += 1


def preflight_prior_gateway(initial, selected, verify, command=None, assert_host=None):
    """No state/pointer writes. Eligible FE recovery is not closed here."""
    command = command or _command
    _validate_reference(initial)
    ids = _inventory(command,verify)
    if ids and _process(ids[0],command,verify)['running']:
        return observe_prior_gateway(initial,selected,verify,command,assert_host)
    return _stopped_observation(initial,selected,verify,command)


def prepare_prior_gateway(initial, selected, output, verify, command=None, assert_host=None, clock=time):
    command = command or _command
    migrate.private_directory(output)
    outcome = {'protocol':PROTOCOL,'status':'PRIOR_GATEWAY_REPLACEMENT_REFUSED','candidateSha256':initial['candidateSha256'],
        'actionId':initial.get('recoveryActionId',selected['releaseId']),'observation':None}
    try:
        _validate_reference(initial)
        ids = _inventory(command, verify)
        stopped = not ids or not _process(ids[0], command, verify)['running']
        actual = _stopped_observation(initial, selected, verify, command) if stopped else _close(initial, selected, verify, command, assert_host, clock, lambda value:outcome.update(observation=value))
        outcome['observation'] = actual
        _remember(initial,actual, 'stopped-observed' if stopped else 'running-observed',
            **({'stopReceiptDirectory':initial['priorGatewayReference']['stopReceiptDirectory'],
                'stopReceiptSha256':initial['priorGatewayReference']['stopReceiptSha256']} if stopped else {}))
        require(_zero(actual), 'PRIOR_GATEWAY_UNCERTAIN_REQUIRES_RECONCILIATION')
        outcome['status'] = 'PRIOR_GATEWAY_CLOSED_ZERO'
        return PriorGatewayBoundary(_AUTHORITY, initial, selected, verify, command, assert_host, actual, stopped)
    except BaseException as error:
        if outcome['observation'] is None and isinstance(error,PriorGatewayObservationError):outcome['observation']=error.partial
        try: _remember(initial,outcome['observation'],'preparation-refused')
        except BaseException: pass
        raise
    finally:
        migrate.write_json(output,'prior-gateway-boundary.json',outcome)


def capture_before_stop(initial, selected, output, verify, command=None, assert_host=None, clock=time):
    """Containment never requires successful drain; retain unknown/nonzero."""
    command = command or _command
    record = {'protocol':PROTOCOL,'sourceModuleSha256':_source_sha256(),'status':'PRIOR_GATEWAY_PRESTOP_UNKNOWN','candidateSha256':initial['candidateSha256'],
        'actionId':initial.get('recoveryActionId',initial.get('certificationActionId',selected['releaseId'])),'observation':None}
    try:
        ids = _inventory(command,verify)
        if not ids or not _process(ids[0],command,verify)['running']:
            record['observation'] = observe_stopped_prior_gateway(initial,selected,verify,command)
        else:
            record['observation'] = _close(initial, selected, verify, command, assert_host, clock, lambda value:record.update(observation=value))
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
                binding=_reference(initial,selected,configuration,ids[0])
                record['observation']={'status':'PRIOR_GATEWAY_OBSERVATION_UNKNOWN','process':process,'binding':binding,'admission':None}
            except BaseException:pass
        try:_remember(initial,record['observation'],'prestop-unknown')
        except BaseException:pass
    migrate.write_json(output,BEFORE_STOP,record)
    return record


def retain_ordered_stop(before, output, verify, command=None):
    command = command or _command
    observed = before.get('observation')
    record = {'protocol':PROTOCOL,'sourceModuleSha256':_source_sha256(),'status':'PRIOR_GATEWAY_STOP_UNKNOWN','beforeSha256':migrate.file_hash(migrate.read_input(output,BEFORE_STOP)),
        'candidateSha256':before['candidateSha256'],'actionId':before['actionId'],'stoppedProcess':None}
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
