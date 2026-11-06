#!/usr/bin/env python3
"""Explicit interrupted known-ACK restoration. Retained JSON is evidence only.

A fresh source broker, inherited host flock and frontend physical lease issue a
new process-local capability. The old gateway's one is never an ordinary zero.
"""
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_admission
import staging_state
import p2_known_ack_loss as known
import p2_prior_gateway as prior
import p2_lifecycle_native as native
from frontend_release_adapters import LockedClient
from p2_release_broker import Broker, PhysicalObserver, LOCK, MAXIMUM, decode
from p2_recovery_broker import P2RecoveryPhysicalObserver
from p2_recovery_scope import P2RecoveryScope
from p2_recovery_runtime import P2RecoveryRuntime
from p2_source_closure import TYPES, verify_source_closure

require = migrate.demand
ROOT = Path('/var/lib/lash-her/releases/staging')
OPERATORS = Path('/opt/lash-her/operators')
MODE = 'known-ack-interrupted-restoration'
MAX_SECONDS = 900
CAUSAL_FILES = ('recovery-intent.json', 'baseline.json', 'domain.json', 'request-details.json',
                'settlement.json', 'replacement-authorization.json')
B_GATEWAY_MARKER = 'known-ack-gateway-replacement-started.json'
B_FRONTIER_MODULE = 'ops/platform/host/p2_known_ack_loss.py'
B_FRONTIER_SHA256 = '445fe8aba68bb4e708e4777c936466f6c5fd54b5500f7160664cf43cd1ddf3db'
REPLACEMENT_FILES = ('known-ack-replacement-intent.json', B_GATEWAY_MARKER, *(
    'known-ack-stage-' + str(i) + '-' + suffix + '.json'
    for i in range(5) for suffix in ('intent', 'observed')))
_ISSUER = object()
_AUTH = weakref.WeakKeyDictionary()
_AUTH_LOCK = threading.Lock()
_BOUNDARIES = weakref.WeakSet()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def action(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value)


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)


def root_path(value):
    path = Path(value)
    require(path.is_absolute() and ROOT in path.parents and path == path.resolve() and
            not any(p.is_symlink() for p in (path, *path.parents)), 'P2_INTERRUPTED_PRIVATE_ROOT_REQUIRED')
    migrate.private_directory(path)
    return path


def require_selection(selection, selected, candidate_sha256):
    keys = {'version', 'mode', 'restorationActionId', 'originalCertificationActionId', 'originalRecoveryActionId',
            'originalOperatorSourceCommit', 'causalReceiptSha256', 'replacementReceiptSha256', 'priorGatewayReference'}
    require(isinstance(selection, dict) and set(selection) == keys and selection['version'] == 1 and selection['mode'] == MODE and
            all(action(selection[k]) for k in ('restorationActionId', 'originalCertificationActionId', 'originalRecoveryActionId')) and
            len({selected['releaseId'], selection['restorationActionId'], selection['originalCertificationActionId'], selection['originalRecoveryActionId']}) == 4 and
            migrate.source_commit(selection['originalOperatorSourceCommit']) and digest(candidate_sha256), 'P2_INTERRUPTED_EXPLICIT_SELECTION_REQUIRED')
    for key, names in (('causalReceiptSha256', CAUSAL_FILES), ('replacementReceiptSha256', REPLACEMENT_FILES)):
        pins = selection[key]
        require(isinstance(pins, dict) and set(pins) == set(names) and all(digest(v) or key == 'replacementReceiptSha256' and v is None for v in pins.values()),
                'P2_INTERRUPTED_FIXED_RECEIPT_PINS_REQUIRED')
    require(digest(selection['replacementReceiptSha256']['known-ack-replacement-intent.json']), 'P2_INTERRUPTED_ORIGINAL_REPLACEMENT_INTENT_REQUIRED')
    ref = selection['priorGatewayReference']
    require(isinstance(ref, dict) and set(ref) == {'kind', 'stopReceiptDirectory', 'stopReceiptSha256'} and
            ref['kind'] == 'stopped-current-candidate' and digest(ref['stopReceiptSha256']), 'P2_INTERRUPTED_SOURCE_STOP_REFERENCE_REQUIRED')
    return copy.deepcopy(selection)


def read_pinned(directory, pins):
    result = {}
    for name, expected in pins.items():
        path = directory / name
        if expected is None:
            require(not path.exists() and not path.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_ABSENCE_CHANGED')
            continue
        raw = migrate.read_input(directory, name, 2_000_000)
        require(sha(raw) == expected, 'P2_INTERRUPTED_ORIGINAL_RECEIPT_CHANGED')
        result[name] = json.loads(raw)
    return result


def original_source(commit, expected):
    directory = OPERATORS / commit
    require(directory == directory.resolve() and not any(p.is_symlink() for p in (directory, *directory.parents)), 'P2_INTERRUPTED_ORIGINAL_SOURCE_REQUIRED')
    manifest, total = {}, 0
    for p in (directory / 'ops').rglob('*'):
        require(not p.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_SOURCE_SYMLINK')
        if not p.is_file() or p.suffix not in TYPES or '__pycache__' in p.parts:
            continue
        info = p.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o022 and 0 < info.st_size <= 2_000_000, 'P2_INTERRUPTED_ORIGINAL_SOURCE_PERMISSIONS')
        total += info.st_size
        require(total <= 41_000_000 and len(manifest) < 496, 'P2_INTERRUPTED_ORIGINAL_SOURCE_BOUNDS')
        manifest[p.relative_to(directory).as_posix()] = sha(p.read_bytes())
    verify_source_closure({'sourceSha256': manifest, 'sourceClosureSha256': expected}, directory)
    return directory, manifest


def validate_request_details(plan, certification_id, evidence, operations):
    artifact = evidence['originalArtifact']
    require(set(artifact) == {'version', 'kind', 'reviewerGithubUserId', 'certificationActionId', 'nativePlanSha256', 'windowEpoch', 'recordedAt', 'observations'} and
            artifact['version'] == 1 and artifact['kind'] == 'operator-recorded-request-details' and artifact['reviewerGithubUserId'] == '8996309' and
            artifact['certificationActionId'] == certification_id and artifact['nativePlanSha256'] == plan['nativePlan']['planSha256'] and
            artifact['windowEpoch'] == str(int(plan['nativePlan']['initialEpoch']) + 1) and len(artifact['observations']) == 2,
            'P2_INTERRUPTED_NATIVE_REQUEST_SCOPE_REQUIRED')
    from p2_certification_parent import _iso
    _iso(artifact['recordedAt'])
    ids = set()
    for row in artifact['observations']:
        require(set(row) == {'version', 'kind', 'reviewerGithubUserId', 'projectId', 'deploymentId', 'path', 'method', 'providerRequestTypeFilter',
                             'providerRequestId', 'startedAt', 'completedAt', 'httpStatus', 'logScope', 'admittedLogLine'} and
                row['version'] == 1 and row['kind'] == 'vercel-native-request-details' and row['reviewerGithubUserId'] == '8996309' and
                row['projectId'] == plan['nativePlan']['projectId'] and row['deploymentId'] == plan['nativePlan']['deploymentId'] and
                row['path'] == native.PATH and row['method'] == 'GET' and row['providerRequestTypeFilter'] == 'cron' and
                row['logScope'] == 'this-provider-request-details' and row['httpStatus'] in (200, 503) and
                re.fullmatch(r'[A-Za-z0-9:._-]{1,200}', row['providerRequestId']) and row['providerRequestId'] not in ids and
                _iso(row['completedAt']) >= _iso(row['startedAt']), 'P2_INTERRUPTED_NATIVE_REQUEST_REQUIRED')
        ids.add(row['providerRequestId'])
        event = json.loads(row['admittedLogLine'])
        require(set(event) == {'version', 'status', 'environment', 'projectId', 'operationId', 'producerSha256', 'sourceCommit', 'epoch', 'kind', 'targetSha256'} and
                event['version'] == 1 and event['status'] == 'P2_LIFECYCLE_CRON_ADMITTED' and event['environment'] == 'staging' and
                event['projectId'] == plan['nativePlan']['projectId'] and event['producerSha256'] == plan['nativePlan']['producer']['producerSha256'] and
                event['sourceCommit'] == plan['nativePlan']['sourceCommit'] and event['targetSha256'] == plan['targetSha256'] and
                event['epoch'] == artifact['windowEpoch'] and event['kind'] == 'recovery', 'P2_INTERRUPTED_ADMITTED_REQUEST_BINDING_REQUIRED')
    known.validate_request_operations(plan, artifact, operations)


def load_retained(initial, selected, jobs, verify, command=None):
    """Read-only reconstruction of source facts, never old capability state."""
    verify()
    selection = require_selection(initial['interruptedRestoration'], selected, initial['candidateSha256'])
    causal = root_path(str(ROOT / ('p2-known-ack-loss-' + selection['originalCertificationActionId'])))
    replacement = root_path(str(ROOT / ('p2-certification-' + selection['originalRecoveryActionId'])))
    values = read_pinned(causal, selection['causalReceiptSha256'])
    stages = read_pinned(replacement, selection['replacementReceiptSha256'])
    baseline, domain, requests, settlement, authorization = (values[name] for name in CAUSAL_FILES[1:])
    plan, intent = baseline['plan'], values['recovery-intent.json']
    require(baseline['status'] == 'P2_KNOWN_ACK_BASELINE_RETAINED' and domain['status'] == 'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW' and
            requests['status'] == 'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED' and settlement['status'] == 'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT' and
            authorization['status'] == 'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED' and baseline['candidateSha256'] == initial['candidateSha256'] and
            authorization['candidateSha256'] == initial['candidateSha256'] and authorization['certificationActionId'] == selection['originalCertificationActionId'] and
            authorization['recoveryActionId'] == baseline['recoveryActionId'] == settlement['recoveryActionId'] == selection['originalRecoveryActionId'] and
            plan['candidateSha256'] == initial['candidateSha256'] and plan['sourceCommit'] == selected['sources']['frontend']['commit'] and
            plan['operatorSourceCommit'] == selection['originalOperatorSourceCommit'] == selected['sources']['frontend']['commit'] and plan['targetSha256'] == initial['targetSha256'] and
            intent['recoveryActionId'] == selection['originalRecoveryActionId'] and intent['version'] == 1 and
            sha(canonical(intent['intent'])) == intent['intentSha256'] == authorization['recoveryIntentSha256'], 'P2_INTERRUPTED_ORIGINAL_CAUSAL_CONTEXT_REQUIRED')
    expected_intent = intent['intent']
    require(expected_intent['profile'] == 'known-ack-same-session-ordered-replacement-v1' and expected_intent['runtimeReplacements'] == 1 and
            all(expected_intent[k] is False for k in ('sqlReplayAllowed', 'roleChangeAllowed', 'ordinaryClosedZeroGate', 'automaticFailureRecoveryAllowed')) and
            expected_intent['certificationActionId'] == selection['originalCertificationActionId'] and expected_intent['candidateSha256'] == initial['candidateSha256'] and
            expected_intent['operatorSourceCommit'] == selection['originalOperatorSourceCommit'] and expected_intent['sourceCommit'] == plan['sourceCommit'] and
            expected_intent['operatorSourceClosureSha256'] == authorization['operatorSourceClosureSha256'] and
            expected_intent['nativePlanSha256'] == plan['nativePlan']['planSha256'], 'P2_INTERRUPTED_ORIGINAL_REVIEWED_INTENT_REQUIRED')
    source, manifest = original_source(selection['originalOperatorSourceCommit'], authorization['operatorSourceClosureSha256'])
    require(manifest.get(known.MODULE) == baseline['sourceModuleSha256'] == authorization['sourceModuleSha256'], 'P2_INTERRUPTED_ORIGINAL_READER_SOURCE_REQUIRED')
    pins = selection['causalReceiptSha256']
    require(authorization['baselineSha256'] == settlement['baselineSha256'] == pins['baseline.json'] and
            authorization['domainSha256'] == settlement['domainSha256'] == requests['domainSha256'] == pins['domain.json'] and
            authorization['requestDetailsSha256'] == settlement['requestDetailsSha256'] == pins['request-details.json'] and
            authorization['settlementSha256'] == pins['settlement.json'] and
            authorization['originalGateway'] == baseline['gateway'], 'P2_INTERRUPTED_CAUSAL_HASH_CHAIN_REQUIRED')
    require(known.validate_domain(plan, baseline['databases'], domain['databases'], domain['gateway'], [domain['effect']]) == {'operationId': domain['operationId']} and
            known.validate_domain(plan, baseline['databases'], settlement['databases'], settlement['gateway'], [domain['effect']], closed=True) == {'operationId': domain['operationId']} and
            domain['operationId'] == settlement['operationId'] == authorization['operationId'], 'P2_INTERRUPTED_EXACT_DOMAIN_SETTLEMENT_REQUIRED')
    request_raw = migrate.read_input(ROOT / ('p2-certification-' + selection['originalCertificationActionId']), 'p2-certification-operator-request-details.json', 2_000_000)
    require(sha(request_raw) == requests['artifactSha256'] == requests['provenance']['artifactSha256'] and
            json.loads(request_raw) == requests['originalArtifact'] and requests['provenance']['authority'] == 'operator-recorded-request-details',
            'P2_INTERRUPTED_ORIGINAL_REQUEST_BYTES_REQUIRED')
    validate_request_details(plan, selection['originalCertificationActionId'], requests, domain['databases']['frontend']['operations'])
    original_gateway = settlement['gateway']
    require(known._same_process(baseline['gateway'], original_gateway) and original_gateway['admission']['newWork'] is False and
            original_gateway['admission']['recovery'] is False and known._zero(original_gateway['admission']['active']) and
            original_gateway['admission']['uncertain'] == {'newWork': 0, 'recovery': 1}, 'P2_INTERRUPTED_EXACT_ORIGINAL_ONE_REQUIRED')
    output = stages['known-ack-replacement-intent.json']
    require(output['status'] == 'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT' and output['authorization'] == authorization and output['recoveryIntent'] == intent and
            output['stages'] == [list(s) for s in runtime.STAGES] and set(output['oldProcesses']) == set(runtime.SERVICES), 'P2_INTERRUPTED_SOURCE_REPLACEMENT_INTENT_REQUIRED')
    active = None
    completed = []
    for index, stage in enumerate(runtime.STAGES):
        begin = stages.get('known-ack-stage-' + str(index) + '-intent.json')
        end = stages.get('known-ack-stage-' + str(index) + '-observed.json')
        require(end is None or begin is not None, 'P2_INTERRUPTED_STAGE_READBACK_WITHOUT_INTENT')
        if begin is not None:
            require(len(completed) == index and active is None and begin['status'] == 'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT' and
                    begin['stage'] == list(stage) and begin['candidateSha256'] == initial['candidateSha256'] and
                    begin['recoveryActionId'] == selection['originalRecoveryActionId'] and begin['authorizationReceiptSha256'] == sha(canonical(authorization)), 'P2_INTERRUPTED_STAGE_ORDER_OR_INTENT_REQUIRED')
            if end is None:
                active = stage
            else:
                require(end['status'] == 'P2_KNOWN_ACK_RUNTIME_STAGE_OBSERVED' and end['stage'] == list(stage) and end['recoveryActionId'] == selection['originalRecoveryActionId'] and
                        set(end['newProcesses']) == set(stage), 'P2_INTERRUPTED_FIXED_STAGE_READBACK_REQUIRED')
                completed.append(stage)
        else:
            require(end is None, 'P2_INTERRUPTED_MISSING_STAGE_INTENT')
    require(len(completed) < len(runtime.STAGES), 'P2_INTERRUPTED_ALREADY_COMPLETED_USE_ORDINARY_RECOVERY')
    # Only the reviewed frontier helper proves gateway up cannot precede a
    # durable pending pointer and exclusive marker. Old helpers never gain this
    # predicate retrospectively. Latest raw stopped lineage is still required
    # below, and the boundary rejects every extra/unmapped actual process.
    require(selection['replacementReceiptSha256'][B_GATEWAY_MARKER] is None, 'P2_INTERRUPTED_GATEWAY_COMMAND_FRONTIER_REACHED')
    if active == ('gateway',):
        require(manifest.get(B_FRONTIER_MODULE) == B_FRONTIER_SHA256, 'P2_INTERRUPTED_ORIGINAL_GATEWAY_FRONTIER_UNKNOWN')
    for path in (replacement / 'runtime-known-ack/known-ack-runtime-outcome.json', ROOT / ('p2-certification-' + selection['originalCertificationActionId']) / 'known-ack-replacement-joined.json',
                 ROOT / ('p2-certification-' + selection['originalCertificationActionId']) / 'p2-certification-outcome.json'):
        require(not path.exists() and not path.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_COMPLETION_EXISTS')
    input_directory = root_path(expected_intent['configurationInputDirectory'])
    require(input_directory == Path(initial['configuration']), 'P2_INTERRUPTED_EXACT_ROOT_INPUT_REQUIRED')
    runtime.validate_snapshot_source(input_directory, selected, jobs)
    require(staging_state.configuration_hashes(input_directory) == initial['configurationSha256'], 'P2_INTERRUPTED_ROOT_INPUT_CHANGED')
    stopped_initial = {**initial, 'priorGatewayReference': selection['priorGatewayReference']}
    observation = prior.observe_stopped_prior_gateway(stopped_initial, selected, verify, command)
    require(known._same_process(observation, original_gateway) and prior._closed_observed(observation) and
            known._zero(observation['admission']['active']) and observation['admission']['uncertain'] == {'newWork': 0, 'recovery': 1},
            'P2_INTERRUPTED_LATEST_SOURCE_STOPPED_ONE_REQUIRED')
    verify()
    return {'selection': selection, 'plan': plan, 'values': values, 'stages': stages, 'originalGateway': observation,
            'inputDirectory': input_directory, 'replacementDirectory': replacement, 'activeStage': active, 'completedStages': completed,
            'oldProcesses': output['oldProcesses'], 'originalSource': source, 'originalSourceManifest': manifest}


def validate_fresh_settled(retained, snapshot):
    """Fresh observation deadline is not inherited from the interrupted process."""
    settlement = retained['values']['settlement.json']
    known.validate_backend_idle(snapshot)
    normalized = copy.deepcopy(snapshot)
    for service in ('course', 'community'):
        # Deadline/eligibility are freshly verified above; only stable data and
        # the exact selected lifecycle transition may equal the retained state.
        normalized[service]['backend']['deadline'] = settlement['databases'][service]['backend']['deadline']
    known.validate_settled(retained['plan'], settlement['databases'], normalized, settlement['operationId'],
                           retained['selection']['causalReceiptSha256']['settlement.json'])
    return snapshot


class InterruptedKnownAckRestorationAuthorization:
    def __init__(self, issuer, broker, record):
        require(issuer is _ISSUER, 'P2_INTERRUPTED_SOURCE_ISSUER_REQUIRED')
        with _AUTH_LOCK:
            _AUTH[self] = {'broker': broker, 'record': copy.deepcopy(record), 'state': 'unused',
                           'scope': getattr(broker, 'raw_scope', None), 'observer': getattr(broker, 'observer', None)}


def consume_authorization(value, broker):
    with _AUTH_LOCK:
        state = _AUTH.get(value) if type(value) is InterruptedKnownAckRestorationAuthorization else None
        require(state is not None and type(broker) is InterruptedKnownAckRestorationBroker and state['broker'] is broker and state['state'] == 'unused',
                'P2_INTERRUPTED_NEW_OPAQUE_AUTHORITY_REQUIRED')
        require(state['scope'] is getattr(broker, 'raw_scope', None) and state['observer'] is getattr(broker, 'observer', None),
                'P2_INTERRUPTED_AUTHORITY_PHYSICAL_SCOPE_CHANGED')
        state['state'] = 'consuming'
    try:
        broker.verify_prepared()
    except BaseException:
        with _AUTH_LOCK:
            state['state'] = 'poisoned'
        raise
    with _AUTH_LOCK:
        require(state['state'] == 'consuming' and state['scope'] is getattr(broker, 'raw_scope', None) and
                state['observer'] is getattr(broker, 'observer', None), 'P2_INTERRUPTED_AUTHORITY_PHYSICAL_SCOPE_CHANGED')
        state['state'] = 'used'
    return copy.deepcopy(state['record'])


class FreshSettledReader:
    """The B query program is reused with a NEW lease and observation deadline."""
    _sql = known.P2KnownAckLossRecorder._sql

    def __init__(self, broker, scope, retained):
        self.broker, self.scope, self.retained = broker, scope, retained
        self.plan = copy.deepcopy(retained['plan'])
        self.command = self.plan['nativePlan']['commandWitnesses'][0]
        self.window_epoch = str(int(self.plan['nativePlan']['initialEpoch']) + 1)
        self.receiver_targets = copy.deepcopy(broker.initial['receiverTargets'])
        require(sha(canonical(self.receiver_targets)) == retained['values']['recovery-intent.json']['intent']['receiverTargetsSha256'],
                'P2_INTERRUPTED_ORIGINAL_RECEIVER_BINDINGS_REQUIRED')
        require(set(self.receiver_targets) == {'course', 'community'}, 'P2_INTERRUPTED_EXACT_RECEIVER_SET_REQUIRED')
        for service, target in self.receiver_targets.items():
            job = broker.jobs[service]['job']
            require(set(target) == {'host', 'port', 'database', 'user', 'serverMajor', 'roleOid'} and
                    all(target[k] == job['target'][k] for k in ('host', 'port', 'database', 'serverMajor')) and
                    target['user'] == job['runtimeRole'] and re.fullmatch(r'[1-9][0-9]{0,9}', target['roleOid']), 'P2_INTERRUPTED_EXACT_RECEIVER_ROLE_REQUIRED')
        self.configuration_input = retained['inputDirectory']
        self.backend_deadline = (datetime.now(timezone.utc) + timedelta(seconds=MAX_SECONDS)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        self.deadline = time.monotonic() + MAX_SECONDS

    def _verify(self):
        self.scope.verify()
        require(time.monotonic() < self.deadline and self.broker.armed_probe['receipt'] == self.scope.receipt,
                'P2_INTERRUPTED_FRESH_PHYSICAL_LEASE_REQUIRED')
        require(sha(migrate.read_input(self.broker.source, known.MODULE)) == self.broker.initial['sourceSha256'][known.MODULE],
                'P2_INTERRUPTED_CURRENT_READER_SOURCE_CHANGED')

    def snapshot(self):
        first = self._sql('frontend')
        receivers = {service: self._sql(service, first['userBindingSha256']) for service in ('course', 'community')}
        last = self._sql('frontend')
        require(first == last, 'P2_INTERRUPTED_FRONTEND_CHANGED_DURING_RECEIVER_READ')
        value = {'frontend': first, **receivers}
        validate_fresh_settled(self.retained, value)
        return value


class InterruptedRestorationBoundary:
    """New action transition from retained old-one to distinct new-zero."""
    _read_json = known.KnownAckLossBoundary._read_json
    _inspect = known.KnownAckLossBoundary._inspect
    _cache_environment = known.KnownAckLossBoundary._cache_environment
    _validate_container = known.KnownAckLossBoundary._validate_container
    _inventory = known.KnownAckLossBoundary._inventory
    _public_process = staticmethod(known.KnownAckLossBoundary._public_process)

    def __init__(self, broker, raw_scope, retained, authorization):
        require(type(broker) is InterruptedKnownAckRestorationBroker and type(raw_scope) is P2RecoveryScope,
                'P2_INTERRUPTED_SOURCE_BOUNDARY_REQUIRED')
        self.broker, self.parent, self.retained = broker, raw_scope, retained
        self.record = consume_authorization(authorization, broker)
        self.selected, self.jobs = copy.deepcopy(broker.selected), copy.deepcopy(broker.jobs)
        self.old_gateway = copy.deepcopy(retained['originalGateway'])
        self.old_configuration = Path(self.old_gateway['binding']['configurationDirectory'])
        self.input_configuration = retained['inputDirectory']
        self.output = Path(broker.initial['results']) / ('runtime-recovery-' + broker.action_id())
        self.output.mkdir(mode=0o700)
        self.snapshot = self.output / 'configuration'
        self.initial = {**broker.initial, 'priorGatewayReference': retained['selection']['priorGatewayReference']}
        self.command = known._source_command(raw_scope)
        self.expected_environments, self.image_ids = {}, {}
        self.stage_index, self.stage_active, self.stage_deadline = 0, None, None
        self.new_rows, self.new_metadata = {}, {}
        self.finished, self.new_gateway = False, None
        self.mutex = threading.RLock()
        self.old_rows, self.old_metadata, self.old_mounts = {}, {}, {}
        configurations = {self.old_configuration, retained['replacementDirectory'] / 'runtime-known-ack/configuration'}
        self.allowed_configurations = {}
        for path in configurations:
            if path.exists():
                require(path == path.resolve() and not path.is_symlink() and
                        staging_state.configuration_hashes(path) == broker.initial['configurationSha256'], 'P2_INTERRUPTED_MOUNTED_CONFIGURATION_BYTES_CHANGED')
                self._cache_environment(path)
                self.allowed_configurations[str(path)] = path
        inventory = self._inventory()
        observed_records = {name: dict(value) for name, value in retained['oldProcesses'].items()}
        for index, stage in enumerate(runtime.STAGES):
            observed = retained['stages'].get('known-ack-stage-' + str(index) + '-observed.json')
            if observed:
                observed_records.update(observed['newProcesses'])
        for service in runtime.SERVICES:
            require(len(inventory[service]) <= 1, 'P2_INTERRUPTED_EXTRA_RUNTIME_REPLICA')
            if not inventory[service]:
                require(service in (retained['activeStage'] or ()), 'P2_INTERRUPTED_UNDECLARED_MISSING_SERVICE')
                self.old_rows[service] = None
                continue
            value = self._inspect(inventory[service][0])
            metadata = self._public_process(value)
            require(metadata['running'] is False and metadata['pid'] == 0, 'P2_INTERRUPTED_RUNTIME_NOT_SOURCE_STOPPED')
            configuration = self._select_configuration(value, service)
            self._validate_container(value, service, configuration, healthy=False)
            expected = observed_records[service]
            recorded = all(metadata[k] == expected[k] for k in ('containerId', 'imageId', 'startedAt', 'restartCount'))
            require(recorded or service in (retained['activeStage'] or ()) and metadata['restartCount'] == 0 and
                    configuration == retained['replacementDirectory'] / 'runtime-known-ack/configuration', 'P2_INTERRUPTED_UNDECLARED_RUNTIME_PROCESS')
            self.old_rows[service] = {'containerId': value['Id']}
            self.old_metadata[service], self.old_mounts[service] = metadata, configuration
        require(self.old_rows['gateway'] and self.old_rows['gateway']['containerId'] == self.old_gateway['process']['containerId'],
                'P2_INTERRUPTED_EXACT_STOPPED_GATEWAY_REQUIRED')
        _BOUNDARIES.add(self)
        migrate.write_json(broker.directory, 'interrupted-restoration-authority.json', self.record)
        migrate.write_json(broker.directory, 'interrupted-restoration-runtime-intent.json', {
            'status': 'P2_INTERRUPTED_RUNTIME_RESTORATION_INTENT', 'restorationActionId': broker.action_id(),
            'candidateSha256': broker.initial['candidateSha256'], 'originalGateway': self.old_gateway,
            'stages': [list(s) for s in runtime.STAGES], 'priorProcesses': self.old_metadata,
            'originalCausalReceiptSha256': retained['selection']['causalReceiptSha256'], 'runtimeReplacements': 1})

    def _select_configuration(self, value, service):
        matches = []
        for path in self.allowed_configurations.values():
            try:
                self._validate_container(value, service, path, healthy=False)
                matches.append(path)
            except ValueError:
                pass
        require(matches, 'P2_INTERRUPTED_FOREIGN_RUNTIME_MOUNT_OR_ENVIRONMENT')
        return matches[0]

    def verify(self):
        with self.mutex:
            require(self in _BOUNDARIES and time.monotonic() < self.broker.reader.deadline,
                    'P2_INTERRUPTED_SOURCE_BOUNDARY_OR_DEADLINE_LOST')
            self.parent.verify()
            self.broker.verify_original()
            if self.snapshot.exists():
                require(staging_state.configuration_hashes(self.snapshot) == self.broker.initial['configurationSha256'] and
                        migrate.read_input(self.snapshot, 'compose.yaml') == migrate.read_input(self.broker.source, 'ops/platform/compose.yaml'),
                        'P2_INTERRUPTED_NEW_SNAPSHOT_BYTES_CHANGED')
            front = self.broker.observer.probe('observe')['admission']
            settlement = self.retained['values']['settlement.json']
            require(front == {'epoch': settlement['epoch'], 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0},
                    'P2_INTERRUPTED_FRESH_FRONTEND_ZERO_REQUIRED')
            require(self.stage_active is None or time.monotonic() < self.stage_deadline, 'P2_INTERRUPTED_STAGE_EXPIRED')
            inventory = self._inventory()
            for service, ids in inventory.items():
                if self.stage_active is not None and service in self.stage_active:
                    require(len(ids) <= 2, 'P2_INTERRUPTED_EXTRA_TRANSITION_REPLICA')
                    for identifier in ids:
                        value = self._inspect(identifier)
                        old = self.old_rows[service] and value['Id'] == self.old_rows[service]['containerId']
                        self._validate_container(value, service, self.old_mounts[service] if old else self.snapshot, healthy=False)
                    continue
                expected = self.new_rows.get(service, self.old_rows[service])
                require((not ids and expected is None) or expected is not None and len(ids) == 1 and expected['containerId'].startswith(ids[0]),
                        'P2_INTERRUPTED_UNRELATED_RUNTIME_ID_DRIFT')
                if ids:
                    value = self._inspect(ids[0])
                    new = service in self.new_rows
                    self._validate_container(value, service, self.snapshot if new else self.old_mounts[service], healthy=new)
                    require(self._public_process(value) == (self.new_metadata[service] if new else self.old_metadata[service]), 'P2_INTERRUPTED_RUNTIME_PROCESS_DRIFT')
            if self.finished:
                actual = prior.observe_prior_gateway({**self.initial, 'configurationSha256': self.broker.initial['configurationSha256']},
                                                     self.selected, self.parent.verify, self.command)
                require(known._same_process(actual, self.new_gateway) and prior._zero(actual) and prior._closed_observed(actual),
                        'P2_INTERRUPTED_NEW_GATEWAY_DRIFT')
            elif self.stage_active == ('gateway',):
                require(prior._read_lineage() == self.gateway_transition_lineage,
                        'P2_INTERRUPTED_LATEST_REPLACEMENT_LINEAGE_CHANGED')
            else:
                require(prior.observe_stopped_prior_gateway(self.initial, self.selected, self.parent.verify, self.command) == self.old_gateway,
                        'P2_INTERRUPTED_ORIGINAL_STOPPED_ONE_CHANGED')

    def before_stage(self, stage):
        with self.mutex:
            self.verify()
            require(self.stage_active is None and self.stage_index < len(runtime.STAGES) and tuple(stage) == runtime.STAGES[self.stage_index] and not self.finished,
                    'P2_INTERRUPTED_FIXED_NEW_STAGE_ORDER_REQUIRED')
            self.broker.reader.snapshot()
            self.broker.require_native_off()
            self._cache_environment(self.snapshot)
            self.stage_active, self.stage_deadline = tuple(stage), time.monotonic() + 120
            migrate.write_json(self.broker.directory, 'interrupted-stage-' + str(self.stage_index) + '-intent.json', {
                'status': 'P2_INTERRUPTED_RUNTIME_STAGE_INTENT', 'stage': list(stage), 'restorationActionId': self.broker.action_id(),
                'candidateSha256': self.broker.initial['candidateSha256'], 'authoritySha256': sha(canonical(self.record))})
            if tuple(stage) == ('gateway',):
                require(prior.observe_stopped_prior_gateway(self.initial, self.selected, self.parent.verify, self.command) == self.old_gateway,
                        'P2_INTERRUPTED_EXACT_PRE_REPLACEMENT_STOP_REQUIRED')
                prior._remember(self.initial, self.old_gateway, 'replacement-in-progress',
                                expectedCandidateSha256=self.broker.initial['candidateSha256'])
                self.gateway_transition_lineage = prior._read_lineage()
                require(self.gateway_transition_lineage is not None and self.gateway_transition_lineage['state'] == 'replacement-in-progress',
                        'P2_INTERRUPTED_DURABLE_REPLACEMENT_LINEAGE_REQUIRED')

    def after_stage(self, stage):
        with self.mutex:
            require(self.stage_active == tuple(stage) and time.monotonic() < self.stage_deadline, 'P2_INTERRUPTED_FINITE_STARTED_STAGE_REQUIRED')
            inventory = self._inventory()
            for service in stage:
                require(len(inventory[service]) == 1, 'P2_INTERRUPTED_ONE_NEW_PROCESS_REQUIRED')
                value = self._inspect(inventory[service][0])
                self._validate_container(value, service, self.snapshot, healthy=True)
                require(value['RestartCount'] == 0 and (self.old_rows[service] is None or value['Id'] != self.old_rows[service]['containerId']),
                        'P2_INTERRUPTED_DISTINCT_NEW_PROCESS_REQUIRED')
                self.new_rows[service] = {'containerId': value['Id']}
                self.new_metadata[service] = self._public_process(value)
            if tuple(stage) == ('gateway',):
                require(prior._read_lineage() == self.gateway_transition_lineage,
                        'P2_INTERRUPTED_LATEST_REPLACEMENT_LINEAGE_CHANGED')
                actual = prior.observe_prior_gateway(self.initial, self.selected, self.parent.verify, self.command)
                require(actual['process']['containerId'] != self.old_gateway['process']['containerId'] and prior._closed_observed(actual) and prior._zero(actual) and
                        actual['binding']['configurationDirectory'] == str(self.snapshot), 'P2_INTERRUPTED_ACTUAL_NEW_GATEWAY_ZERO_REQUIRED')
                prior._remember(self.initial, actual)
                self.new_gateway, self.finished = actual, True
            self.stage_active, self.stage_deadline = None, None
            self.stage_index += 1
            self.verify()
            self.broker.reader.snapshot()
            self.broker.require_native_off()
            migrate.write_json(self.broker.directory, 'interrupted-stage-' + str(self.stage_index - 1) + '-observed.json', {
                'status': 'P2_INTERRUPTED_RUNTIME_STAGE_OBSERVED', 'stage': list(stage), 'newProcesses': {s: self.new_metadata[s] for s in stage}})


class InterruptedRestorationScope(P2RecoveryScope):
    def __init__(self, parent, boundary):
        require(type(parent) is P2RecoveryScope and type(boundary) is InterruptedRestorationBoundary and boundary in _BOUNDARIES,
                'P2_INTERRUPTED_EXACT_TYPED_SCOPE_REQUIRED')
        self.parent, self.boundary = parent, boundary
        for key in ('descriptor', 'path', 'identity', 'receipt', 'candidate_sha256', 'release', 'jobs', 'configuration_sha256', 'recovery_action_id',
                    'revoked', 'processes', 'mutations'):
            setattr(self, key, getattr(parent, key))
        self.closed = False
        self.verify()

    def verify(self):
        self.parent.verify()
        self.boundary.verify()

    def require_prior_gateway(self):
        self.verify()

    def before_runtime_stage(self, stage):
        self.boundary.before_stage(stage)

    def after_runtime_stage(self, stage):
        self.boundary.after_stage(stage)

    def run(self, *args, **kwargs):
        self.verify()
        try:
            return self.parent.run(*args, **kwargs)
        finally:
            self.verify()

    def revoke(self):
        self.parent.revoke()

    def close(self):
        # The broker owns the host descriptor. Closing the typed view cannot
        # release or transfer that independent environment lock.
        self.closed = self.parent.closed = True


class InterruptedRestorationRuntime(P2RecoveryRuntime):
    def __init__(self, scope):
        require(type(scope) is InterruptedRestorationScope and scope.boundary in _BOUNDARIES, 'P2_INTERRUPTED_RUNTIME_SOURCE_SCOPE_REQUIRED')
        scope.verify()
        boundary = scope.boundary
        self.scope, self.selected, self.jobs = scope, boundary.selected, boundary.jobs
        self.configuration, self.output = boundary.input_configuration, boundary.output
        self.compose_file, self.source = boundary.broker.source / 'ops/platform/compose.yaml', boundary.broker.source
        self.snapshot = None


class InterruptedRestorationPhysicalObserver(P2RecoveryPhysicalObserver):
    pass


def contain_interrupted_native(initial, armed, source):
    """Fixed metadata-only containment, independent of workload probe expiry."""
    result = {'nativeDisabled': None, 'nativeDisableAttempted': False}
    try:
        selection = initial['interruptedRestoration']
        directory = root_path(str(ROOT / ('p2-known-ack-loss-' + selection['originalCertificationActionId'])))
        baseline = read_pinned(directory, {'baseline.json': selection['causalReceiptSha256']['baseline.json']})['baseline.json']
        context = {'candidate': initial['candidate'], 'plan': baseline['plan']['nativePlan']}
        import vercel
        client = vercel.Client(initial['vercelToken'])
        if native.observe_metadata(context, client)['nativeEnabled']:
            result['nativeDisableAttempted'] = True
            client.request('PATCH', '/v1/projects/' + context['plan']['projectId'] + '/crons', {'enabled': False})
        result['nativeDisabled'] = True if native.observe_metadata(context, client)['nativeEnabled'] is False else None
    except BaseException:
        pass
    return result


class InterruptedKnownAckRestorationBroker(Broker):
    observer_type = InterruptedRestorationPhysicalObserver
    observer_source = 'ops/platform/p2-recovery-current-probe.mjs'

    def initialize(self):
        self.started_at = time.monotonic()
        self.retained = self.reader = self.raw_scope = self.boundary = None
        self.restore_attempted = False
        self.prepared_terminal = None
        super().initialize()

    def action_id(self):
        return self.initial['recoveryActionId']

    def directory_name(self):
        return 'p2-recovery-' + self.action_id()

    def terminal_filename(self):
        return 'p2-known-ack-interrupted-restoration-outcome.json'

    def check(self):
        require(time.monotonic() - self.started_at < 900, 'P2_INTERRUPTED_BOUNDED_NEW_ACTION_EXPIRED')
        super().check()

    def select_release(self, initial):
        selected, jobs, plan, compose = runtime.make_plan(Path(initial['bundle']), Path(initial['configuration']), self.source / 'ops/platform/compose.yaml')
        require(initial.get('mode') == MODE and selected == initial['candidate'] and selected['environment'] == 'staging' and selected.get('contractPhase') == 'p2' and
                initial['confirmation'] == 'staging/' + self.action_id() and set(jobs) == {'frontend', 'course', 'community'}, 'P2_INTERRUPTED_SAME_CANDIDATE_ONLY')
        selected_input = require_selection(initial['interruptedRestoration'], selected, initial['candidateSha256'])
        pins = {**selected_input['causalReceiptSha256'], **{'replacement/' + key: value for key, value in selected_input['replacementReceiptSha256'].items()}}
        require(initial['originalReceiptSha256'] == pins, 'P2_INTERRUPTED_EXACT_ORIGINAL_PIN_MAP_REQUIRED')
        require(selected_input['restorationActionId'] == self.action_id() and initial['originalReleaseId'] == selected['releaseId'] and
                initial['priorGatewayReference'] == selected_input['priorGatewayReference'] and initial.get('rolePreparation') is None,
                'P2_INTERRUPTED_DISTINCT_EXPLICIT_ACTION_REQUIRED')
        return selected, jobs, plan, compose

    def preflight_prior_gateway(self):
        # This is NOT ordinary closed-zero preparation and grants no mutation.
        retained = load_retained(self.initial, self.selected, self.jobs, self.check)
        self.retained = retained
        return {'status': 'P2_INTERRUPTED_ORIGINAL_ONE_RETAINED', 'candidateSha256': self.initial['candidateSha256'],
                'restorationActionId': self.action_id(), 'originalGateway': retained['originalGateway'], 'authorityIssued': False}

    def verify_original(self):
        self.raw_scope.verify()
        retained = self.retained
        selection = retained['selection']
        causal = ROOT / ('p2-known-ack-loss-' + selection['originalCertificationActionId'])
        require(read_pinned(causal, selection['causalReceiptSha256']) == retained['values'] and
                read_pinned(retained['replacementDirectory'], selection['replacementReceiptSha256']) == retained['stages'],
                'P2_INTERRUPTED_ORIGINAL_BYTES_CHANGED')
        stop_ref = selection['priorGatewayReference']
        stop_raw = migrate.read_input(Path(stop_ref['stopReceiptDirectory']), prior.STOPPED)
        require(sha(stop_raw) == stop_ref['stopReceiptSha256'] and
                sha(migrate.read_input(Path(stop_ref['stopReceiptDirectory']), prior.BEFORE_STOP)) == json.loads(stop_raw)['beforeSha256'],
                'P2_INTERRUPTED_ORIGINAL_STOP_BYTES_CHANGED')
        verify_source_closure({'sourceSha256': retained['originalSourceManifest'],
                               'sourceClosureSha256': retained['values']['replacement-authorization.json']['operatorSourceClosureSha256']}, retained['originalSource'])
        runtime.validate_snapshot_source(retained['inputDirectory'], self.selected, self.jobs)
        require(staging_state.configuration_hashes(retained['inputDirectory']) == self.initial['configurationSha256'], 'P2_INTERRUPTED_ROOT_INPUT_CHANGED')
        for path in (retained['replacementDirectory'] / 'runtime-known-ack/known-ack-runtime-outcome.json',
                     ROOT / ('p2-certification-' + selection['originalCertificationActionId']) / 'known-ack-replacement-joined.json',
                     ROOT / ('p2-certification-' + selection['originalCertificationActionId']) / 'p2-certification-outcome.json'):
            require(not path.exists() and not path.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_TERMINAL_CHANGED')

    def require_native_off(self):
        context = {'candidate': self.selected, 'plan': self.retained['plan']['nativePlan']}
        require(native.observe_metadata(context, LockedClient(self.vercel, self.raw_scope.verify))['nativeEnabled'] is False,
                'P2_INTERRUPTED_NATIVE_MUST_ALREADY_BE_OFF')

    def verify_prepared(self):
        require(type(self.raw_scope) is P2RecoveryScope and self.observer is not None and self.armed_probe['receipt'] == self.raw_scope.receipt,
                'P2_INTERRUPTED_NEW_PHYSICAL_SCOPE_REQUIRED')
        self.verify_original()
        observed = prior.observe_stopped_prior_gateway(self.initial, self.selected, self.raw_scope.verify, known._source_command(self.raw_scope))
        require(observed == self.retained['originalGateway'], 'P2_INTERRUPTED_SOURCE_STOP_CHANGED')
        self.reader.snapshot()
        self.require_native_off()
        return True

    def arm(self, request):
        self.check()
        require(self.scope is None and self.observer is None and self.reader is None, 'P2_INTERRUPTED_ALREADY_ARMED')
        raw, receipt = decode(request['receipt'])
        probe = request['probe']
        require(probe.get('job') == self.jobs['frontend']['job'] and probe.get('baseline') == json.loads(self.jobs['frontend']['schema']) and
                probe.get('receipt') == receipt and probe.get('owner') == self.initial['owner'] and probe.get('targetSha256') == self.initial['targetSha256'] and
                receipt.get('recoveryActionId') == self.action_id() and receipt.get('originalReceiptSha256') == self.initial['originalReceiptSha256'] and
                receipt.get('retiredLogins') == self.initial['historicalLogins']['retiredLogins'] and receipt.get('producers') == self.initial['producers'],
                'P2_INTERRUPTED_NEW_FRONTEND_RECEIPT_REQUIRED')
        self.frontend_raw, self.armed_probe = raw, probe
        self.observer = self.observer_type(self.selected, probe, self.source, self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'],
                                           program=self.observer_program, program_sha256=self.initial['sourceSha256'][self.observer_source])
        self.observer.start(self.abort)
        self.raw_scope = P2RecoveryScope(self.lock_fd, LOCK, self.check, receipt, self.initial['candidateSha256'], recovery_action_id=self.action_id(),
                                         release=self.selected, jobs=self.jobs, configuration_sha256=self.initial['configurationSha256'])
        self.scope = self.raw_scope
        # The guard is armed before observation containers start; no service
        # mutation is reachable until prepare() mints a NEW source capability.
        self.safety({'operation': 'armed', 'probe': probe})
        self.reader = FreshSettledReader(self, self.raw_scope, self.retained)
        self.verify_prepared()
        current = self.directory / 'current-api-before'
        current.mkdir(mode=0o700)
        observer_runtime = P2RecoveryRuntime(self.raw_scope, self.selected, self.jobs, self.configuration, current, self.source / 'ops/platform/compose.yaml', self.source)
        self.api_before = {s: observer_runtime.verify_api_current(s, current) for s in ('course', 'community')}
        self.verify_prepared()
        migrate.write_json(self.directory, 'interrupted-restoration-current-database.json', receipt)
        return {'status': 'P2_INTERRUPTED_FRESH_CURRENT_READY', 'candidateSha256': self.initial['candidateSha256'],
                'restorationActionId': self.action_id(), 'apiDatabases': self.api_before, 'authorityIssued': False}

    def prepare(self):
        require(not self.restore_attempted and self.boundary is None and self.reader is not None, 'P2_INTERRUPTED_ALREADY_PREPARED')
        self.verify_prepared()
        record = {'version': 1, 'status': 'P2_INTERRUPTED_NEW_SOURCE_AUTHORITY', 'restorationActionId': self.action_id(),
                  'candidateSha256': self.initial['candidateSha256'], 'originalCertificationActionId': self.retained['selection']['originalCertificationActionId'],
                  'originalRecoveryActionId': self.retained['selection']['originalRecoveryActionId'],
                  'originalCausalReceiptSha256': self.retained['selection']['causalReceiptSha256'],
                  'originalReplacementReceiptSha256': self.retained['selection']['replacementReceiptSha256'],
                  'originalStopReference': self.retained['selection']['priorGatewayReference'], 'newFrontendReceiptSha256': sha(self.frontend_raw),
                  'newApiCurrentSha256': sha(canonical(self.api_before)), 'operatorSourceClosureSha256': self.initial['sourceClosureSha256'],
                  'ordinaryClosedZeroGate': False, 'originalGatewayUncertainty': {'newWork': 0, 'recovery': 1}}
        authorization = InterruptedKnownAckRestorationAuthorization(_ISSUER, self, record)
        self.boundary = InterruptedRestorationBoundary(self, self.raw_scope, self.retained, authorization)
        self.scope = InterruptedRestorationScope(self.raw_scope, self.boundary)
        return {'status': 'P2_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED', 'authoritySha256': sha(canonical(record))}

    def start(self, identity, request):
        self.check()
        require(self.boundary is not None and not self.restore_attempted and self.worker is None and request == {'id': identity, 'operation': 'restore-runtime'},
                'P2_INTERRUPTED_ONE_EXPLICIT_RESTORATION_REQUIRED')
        self.restore_attempted = True

        def worker():
            try:
                restored = InterruptedRestorationRuntime(self.scope)
                ready = restored.restore()
                require(self.boundary.finished and self.boundary.stage_index == len(runtime.STAGES), 'P2_INTERRUPTED_ALL_NEW_STAGES_REQUIRED')
                self.runtime_snapshot = restored.snapshot
                current = self.directory / 'current-api-after'
                current.mkdir(mode=0o700)
                after = {s: restored.verify_api_current(s, current) for s in ('course', 'community')}
                require(after == self.api_before, 'P2_INTERRUPTED_DATABASE_JOURNAL_OR_ROLE_CHANGED')
                self.reader.snapshot()
                self.scope.verify()
                self.require_native_off()
                self.ready = {**ready, **migrate.contract_identity(self.selected), 'status': 'P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED',
                              'restorationActionId': self.action_id(), 'originalCertificationActionId': self.retained['selection']['originalCertificationActionId'],
                              'originalRecoveryActionId': self.retained['selection']['originalRecoveryActionId'], 'oldGateway': self.retained['originalGateway'],
                              'newGateway': self.boundary.new_gateway, 'apiDatabasesAfter': after, 'originalGatewayUncertaintyPreserved': True,
                              'ordinaryClosedZeroGate': False, 'runtimeReplacements': 1, 'nativeDisabled': True, 'frontendReadinessVerified': False,
                              'frontendWorkloadProbePerformed': False, 'trafficAuthorized': False, 'rolePreparationRepeated': False,
                              'originalTerminalRecreated': False, 'frontendJournalSha256': self.raw_scope.receipt['journalSha256'],
                              'originalCausalReceiptSha256': self.retained['selection']['causalReceiptSha256']}
                self.send(identity, 'INTERRUPTED_RUNTIME_READY', receipt=self.ready)
            except BaseException:
                self.abort()
                self.send(identity, 'P2_INTERRUPTED_RUNTIME_FAILED')
            finally:
                self.worker_done.set()
        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_INTERRUPTED_PROTOCOL_ID_REQUIRED')
        self.last_command = time.monotonic()
        self.check()
        if operation == 'check':
            self.send(identity, 'HELD')
        elif operation == 'arm-interrupted-restoration':
            require(set(value) == {'id', 'operation', 'receipt', 'probe'}, 'P2_INTERRUPTED_CLOSED_ARM_EVENT_REQUIRED')
            self.send(identity, 'INTERRUPTED_RESTORATION_ARMED', receipt=self.arm(value))
        elif operation == 'prepare-interrupted-restoration':
            require(set(value) == {'id', 'operation'}, 'P2_INTERRUPTED_FIELD_FREE_PREPARE_REQUIRED')
            self.send(identity, 'INTERRUPTED_RESTORATION_PREPARED', receipt=self.prepare())
        elif operation == 'restore-runtime':
            self.start(identity, value)
        elif operation == 'prepare-close':
            require(set(value) == {'id', 'operation'} and self.ready is not None and self.worker_done.is_set() and self.closing_at is None,
                    'P2_INTERRUPTED_RUNTIME_NOT_READY')
            self.scope.verify()
            self.reader.snapshot()
            self.observer.probe('verify-schema')
            self.require_native_off()
            self.observer.stop()
            self.closing_at = time.monotonic()
            self.prepared_terminal = copy.deepcopy(self.ready)
            self.send(identity, 'INTERRUPTED_CLOSE_PREPARED', receipt=self.prepared_terminal)
        elif operation == 'finish':
            raw, outcome = decode(value['restoration'])
            require(self.prepared_terminal is not None and not self.finished and outcome == self.prepared_terminal,
                    'P2_INTERRUPTED_TERMINAL_BINDING_REQUIRED')
            self.finished = True
            self.released.set()
            self.outcome = copy.deepcopy(outcome)
            self.send(identity, 'INTERRUPTED_RESTORATION_JOINED', receipt=self.outcome)
        elif operation == 'commit':
            require(set(value) == {'id', 'operation'} and self.finished, 'P2_INTERRUPTED_JOIN_REQUIRED')
            migrate.write_json(self.directory, self.terminal_filename(), self.outcome)
            self.safety({'operation': 'committed', 'sha256': sha(migrate.read_input(self.directory, self.terminal_filename()))})
            self.committed.set()
            self.send(identity, 'COMMITTED', receipt=self.outcome)
        else:
            raise ValueError('P2_INTERRUPTED_SOURCE_OPERATION_NOT_INSTALLED')


def main():
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_INTERRUPTED_INITIAL_INPUT_REFUSED')
    initial = json.loads(raw)
    require(initial.get('mode') == MODE, 'P2_INTERRUPTED_FIXED_MODE_REQUIRED')
    from p2_release_supervisor import supervise, C_LAYOUT
    supervise(initial, broker_type=InterruptedKnownAckRestorationBroker, observer_type=InterruptedRestorationPhysicalObserver,
              observer_source='ops/platform/p2-recovery-current-probe.mjs', layout=C_LAYOUT, native_containment=contain_interrupted_native)


if __name__ == '__main__':
    for item, code in ((signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
        signal.signal(item, lambda *_args, code=code: (_ for _ in ()).throw(SystemExit(code)))
    try:
        main()
    except BaseException:
        print('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_FAILED_REQUIRES_REVIEW', file=sys.stderr)
        raise SystemExit(1)
