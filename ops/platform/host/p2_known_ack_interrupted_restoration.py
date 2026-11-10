#!/usr/bin/env python3
"""Explicit interrupted known-ACK restoration. Retained JSON is evidence only.

A fresh source broker, inherited host flock and frontend physical lease issue a
new process-local capability. The old gateway's one is never an ordinary zero.
"""
import base64
import copy
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import threading
import time
import weakref

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Fixed CLI and supervisor must share one class/capability registry identity.
if __name__ == '__main__':
    if 'p2_known_ack_interrupted_restoration' in sys.modules and sys.modules['p2_known_ack_interrupted_restoration'] is not sys.modules[__name__]:
        raise ValueError('P2_INTERRUPTED_MODULE_IDENTITY_CONFLICT')
    sys.modules['p2_known_ack_interrupted_restoration'] = sys.modules[__name__]
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
from p2_source_closure import (PROFILED_CERTIFICATION_MODE, TYPES, verify_source_closure,
                               verify_profiled_current_source_closure)
from qualification_target_profile import decode_qualification_target_json

require = migrate.demand
ROOT = Path('/var/lib/lash-her/releases/staging')
OPERATORS = Path('/opt/lash-her/operators')
MODE = 'known-ack-interrupted-restoration'
PROFILED_MODE = 'p2-profiled-known-ack-interrupted-restoration'
MAX_SECONDS = 900
CAUSAL_FILES = ('recovery-intent.json', 'baseline.json', 'domain.json', 'request-details.json',
                'settlement.json', 'replacement-authorization.json')
B_GATEWAY_MARKER = 'known-ack-gateway-replacement-started.json'
B_FRONTIER_MODULE = 'ops/platform/host/p2_known_ack_loss.py'
B_FRONTIER_SHA256 = '445fe8aba68bb4e708e4777c936466f6c5fd54b5500f7160664cf43cd1ddf3db'
PROFILED_LEGACY_B_FRONTIER_SHA256 = '133e2e383857149c8f82a0a0d85458805ae003f6b1a51667babbb414a99a0d78'
PROFILED_B_FRONTIER_SHA256 = '425504e269373ffbc7d6f43ebcb5d30b7ba40fbac4e03cc8e6398e2400a5c983'
PROFILED_CAUSAL_FILES = (*CAUSAL_FILES, 'reconciliation-observed.json')
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


def one(value):
    return type(value) is int and value == 1


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
    require(isinstance(selection, dict) and set(selection) == keys and one(selection['version']) and selection['mode'] == MODE and
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


def original_source(commit, expected, *, expected_profile=None):
    profile = migrate.profile_context(expected_profile)
    max_bytes, max_files = (48_000_000, 544) if profile is not None else (41_000_000, 512)
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
        require(total <= max_bytes and len(manifest) < max_files, 'P2_INTERRUPTED_ORIGINAL_SOURCE_BOUNDS')
        manifest[p.relative_to(directory).as_posix()] = sha(p.read_bytes())
    packet = {'sourceSha256': manifest, 'sourceClosureSha256': expected}
    if profile is None:
        verify_source_closure(packet, directory)
    else:
        verify_profiled_current_source_closure({**packet, 'mode': PROFILED_CERTIFICATION_MODE,
            'qualificationTargetProfile': profile}, directory)
    return directory, manifest


def validate_request_details(plan, certification_id, evidence, operations, *, strict=False):
    artifact = evidence['originalArtifact']
    require(set(artifact) == {'version', 'kind', 'reviewerGithubUserId', 'certificationActionId', 'nativePlanSha256', 'windowEpoch', 'recordedAt', 'observations'} and
            one(artifact['version']) and artifact['kind'] == 'operator-recorded-request-details' and artifact['reviewerGithubUserId'] == '8996309' and
            artifact['certificationActionId'] == certification_id and artifact['nativePlanSha256'] == plan['nativePlan']['planSha256'] and
            artifact['windowEpoch'] == str(int(plan['nativePlan']['initialEpoch']) + 1) and len(artifact['observations']) == 2,
            'P2_INTERRUPTED_NATIVE_REQUEST_SCOPE_REQUIRED')
    from p2_certification_parent import _iso
    _iso(artifact['recordedAt'])
    ids = set()
    for row in artifact['observations']:
        require(set(row) == {'version', 'kind', 'reviewerGithubUserId', 'projectId', 'deploymentId', 'path', 'method', 'providerRequestTypeFilter',
                             'providerRequestId', 'startedAt', 'completedAt', 'httpStatus', 'logScope', 'admittedLogLine'} and
                one(row['version']) and row['kind'] == 'vercel-native-request-details' and row['reviewerGithubUserId'] == '8996309' and
                row['projectId'] == plan['nativePlan']['projectId'] and row['deploymentId'] == plan['nativePlan']['deploymentId'] and
                row['path'] == native.PATH and row['method'] == 'GET' and row['providerRequestTypeFilter'] == 'cron' and
                row['logScope'] == 'this-provider-request-details' and row['httpStatus'] in (200, 503) and
                re.fullmatch(r'[A-Za-z0-9:._-]{1,200}', row['providerRequestId']) and row['providerRequestId'] not in ids and
                _iso(row['completedAt']) >= _iso(row['startedAt']), 'P2_INTERRUPTED_NATIVE_REQUEST_REQUIRED')
        ids.add(row['providerRequestId'])
        event = decode_qualification_target_json(row['admittedLogLine'], 'carrier') if strict else json.loads(row['admittedLogLine'])
        require(set(event) == {'version', 'status', 'environment', 'projectId', 'operationId', 'producerSha256', 'sourceCommit', 'epoch', 'kind', 'targetSha256'} and
                one(event['version']) and event['status'] == 'P2_LIFECYCLE_CRON_ADMITTED' and event['environment'] == 'staging' and
                event['projectId'] == plan['nativePlan']['projectId'] and event['producerSha256'] == plan['nativePlan']['producer']['producerSha256'] and
                event['sourceCommit'] == plan['nativePlan']['sourceCommit'] and event['targetSha256'] == plan['targetSha256'] and
                event['epoch'] == artifact['windowEpoch'] and event['kind'] == 'recovery', 'P2_INTERRUPTED_ADMITTED_REQUEST_BINDING_REQUIRED')
    known.validate_request_operations(plan, artifact, operations)


def require_original_configuration(initial, plan, intent):
    values = initial.get('configurationSha256')
    require(isinstance(values, dict) and set(values) == set(staging_state.CONFIGURATION_FILES) and
            all(digest(value) for value in values.values()) and
            intent.get('configurationSha256') == sha(json.dumps(values, separators=(',', ':'), ensure_ascii=False).encode()) and
            plan.get('configurationSha256') == sha(canonical(values)),
            'P2_INTERRUPTED_ORIGINAL_CONFIGURATION_REQUIRED')


def require_snapshot_numbers(value):
    front = value['frontend']
    require(isinstance(front['outstanding'], list) and isinstance(front['deliveries'], list), 'P2_INTERRUPTED_DELIVERY_ROWS_REQUIRED')
    counts = [front[key] for key in ('exports', 'later')] + [row['attempts'] for row in front['outstanding'] + front['deliveries']]
    counts += [front['admission'][key] for key in ('active', 'uncertain')]
    for service in ('course', 'community'):
        require(one(value[service]['backend'].get('version')), 'P2_INTERRUPTED_BACKEND_VERSION_REQUIRED')
        counts += list(value[service]['backend']['eligible'].values()) + list(value[service]['backend']['rowCounts'].values())
    require(all(type(item) is int and item >= 0 for item in counts), 'P2_INTERRUPTED_INTEGER_COUNTS_REQUIRED')


def require_gateway_counts(value):
    admission = value['admission']
    require(all(set(admission[key]) == {'newWork', 'recovery'} and
                all(type(item) is int and item >= 0 for item in admission[key].values()) for key in ('active', 'uncertain')),
            'P2_INTERRUPTED_INTEGER_GATEWAY_COUNTS_REQUIRED')


def original_fault_receipts(selection, selected, plan, effect, *, expected_profile=None, certification=None, old_mount=None):
    profile = migrate.profile_context(expected_profile)
    certification = ROOT / ('p2-certification-' + selection['originalCertificationActionId']) if profile is None else certification
    directory = root_path(str(certification / 'fault'))
    names = ('fault-arm-intent.json', 'fault-arm-observed.json')
    raw = {name: migrate.read_input(directory, name, 2_000_000) for name in names}
    intent, observed = (json.loads(raw[name]) if profile is None else _profiled_record(raw[name], profile) for name in names)
    lease = intent.get('lease')
    common = {'version', 'stageId', 'leaseSha256', 'lease'}
    if profile is not None:
        from p2_certification_fault import LEASE
        mount = old_mount / 'admission'
        info = mount.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022 and
                type(intent.get('admissionDirectoryDevice')) is int and type(intent.get('admissionDirectoryInode')) is int and
                (intent['admissionDirectoryDevice'], intent['admissionDirectoryInode']) == (info.st_dev, info.st_ino) and
                not (mount / LEASE).exists() and not (mount / LEASE).is_symlink(), 'P2_INTERRUPTED_PROFILED_FAULT_MOUNT_REQUIRED')
        common |= {'qualificationTargetProfile', 'admissionDirectoryDevice', 'admissionDirectoryInode'}
    require(set(intent) == common and (profile is not None or one(intent['version'])) and
            isinstance(lease, dict) and set(lease) == {'version', 'environment', 'profile', 'stageId', 'candidateSha256', 'configurationSha256',
            'gatewayConfigurationSha256', 'gatewayProcessSha256', 'gatewayImageSha256', 'mode', 'receiver', 'releaseId',
            'sourceWitnessSha256', 'issuedAt', 'expiresAt', 'maxMatches', 'record'} and
            sha(canonical(lease) + b'\n') == intent['leaseSha256'] == effect.get('leaseSha256') and
            one(lease['version']) and one(lease['maxMatches']) and lease['releaseId'] == selected['releaseId'] and
            all(lease[key] == plan[key] for key in ('environment', 'profile', 'stageId', 'candidateSha256', 'configurationSha256', 'gatewayConfigurationSha256',
                'gatewayProcessSha256', 'gatewayImageSha256', 'mode', 'receiver')) and
            lease['sourceWitnessSha256'] == plan['commandSha256'] and intent['stageId'] == plan['stageId'],
            'P2_INTERRUPTED_ORIGINAL_FAULT_LEASE_REQUIRED')
    record, command = lease['record'], plan['nativePlan']['commandWitnesses'][0]
    require(set(record) == {'commandId', 'accountVersion', 'canonicalSha256'} and type(record['accountVersion']) is int and
            1 <= record['accountVersion'] <= 9007199254740991 and record['commandId'] == command['commandId'] and
            str(record['accountVersion']) == command['accountVersion'] and record['canonicalSha256'] == plan['commandSha256'],
            'P2_INTERRUPTED_ORIGINAL_FAULT_COMMAND_REQUIRED')
    from p2_certification_parent import _iso
    fields = {'version', 'status', 'stageId', 'leaseSha256', 'expiresAt', 'maxMatches', 'gatewayProcessSha256'}
    if profile is not None:
        fields.add('qualificationTargetProfile')
    require(_iso(lease['expiresAt']) - _iso(lease['issuedAt']) == 120 and set(observed) == fields and
            (profile is not None or one(observed['version'])) and one(observed['maxMatches']) and observed['status'] == 'P2_FAULT_LEASE_ARMED' and
            all(observed[key] == lease[key] for key in ('stageId', 'expiresAt', 'gatewayProcessSha256')) and
            observed['leaseSha256'] == intent['leaseSha256'], 'P2_INTERRUPTED_ORIGINAL_FAULT_READBACK_REQUIRED')
    return {name: sha(raw[name]) for name in names}


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
            set(intent) == {'version', 'recoveryActionId', 'intent', 'intentSha256'} and
            intent['recoveryActionId'] == selection['originalRecoveryActionId'] and one(intent['version']) and
            sha(canonical(intent['intent'])) == intent['intentSha256'] == authorization['recoveryIntentSha256'], 'P2_INTERRUPTED_ORIGINAL_CAUSAL_CONTEXT_REQUIRED')
    require(one(authorization.get('version')) and all(authorization.get(key) is False for key in
            ('ordinaryClosedZeroGate', 'sqlReplayAllowed', 'roleChangeAllowed')), 'P2_INTERRUPTED_ORIGINAL_AUTHORIZATION_POLICY_REQUIRED')
    native_plan = plan['nativePlan']
    require(one(plan.get('version')) and one(native_plan.get('version')) and one(plan.get('maxMatches')) and
            type(plan.get('leaseMilliseconds')) is int and plan['leaseMilliseconds'] == 120000 and plan.get('mode') == 'drop-after-ack' and
            plan.get('nativePlanSha256') == native_plan['planSha256'] and
            isinstance(native_plan.get('commandWitnesses'), list) and len(native_plan['commandWitnesses']) == 1 and
            native_plan['commandWitnesses'][0].get('action') == 'suspend' and
            isinstance(native_plan.get('initialEpoch'), str) and re.fullmatch(r'[1-9][0-9]{0,17}', native_plan['initialEpoch']) and
            type(native_plan.get('windowSeconds')) is int and 1 <= native_plan['windowSeconds'] <= 180,
            'P2_INTERRUPTED_ORIGINAL_ONE_SUSPEND_FAULT_REQUIRED')
    for record in (baseline, domain, settlement):
        require_snapshot_numbers(record['databases'])
        require_gateway_counts(record['gateway'])
    expected_intent = intent['intent']
    require_original_configuration(initial, plan, expected_intent)
    require(set(expected_intent) == set(known.replacement_intent({**expected_intent, 'knownAckConfigurationInputDirectory': expected_intent['configurationInputDirectory'],
            'knownAckReceiverTargets': initial['receiverTargets'], 'nativePlan': plan['nativePlan']}, selection['originalRecoveryActionId'])),
            'P2_INTERRUPTED_ORIGINAL_INTENT_SCHEMA_REQUIRED')
    require(one(expected_intent.get('version')) and expected_intent.get('recoveryActionId') == selection['originalRecoveryActionId'] and
            expected_intent.get('targetSha256') == initial['targetSha256'] and
            expected_intent.get('receiverTargetsSha256') == sha(canonical(initial['receiverTargets'])) and
            type(expected_intent.get('nativeWindowSeconds')) is int and expected_intent['nativeWindowSeconds'] == plan['nativePlan']['windowSeconds'] and expected_intent['profile'] == 'known-ack-same-session-ordered-replacement-v1' and one(expected_intent['runtimeReplacements']) and
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
    effect = domain['effect']
    require(expected_intent.get('gatewayProcessSha256') == plan.get('gatewayProcessSha256') == effect.get('gatewayProcessSha256') and
            effect.get('candidateSha256') == initial['candidateSha256'] and effect.get('configurationSha256') == plan['configurationSha256'] and
            effect.get('gatewayImageSha256') == selected['artifacts']['gateway']['image'].split(':')[-1] and
            one(effect.get('version')) and effect.get('stageId') == plan.get('stageId') and
            effect.get('profile') == plan.get('profile') == 'lifecycle-known-command-v1' and
            effect.get('environment') == plan.get('environment') == 'staging' and effect.get('status') == 'P2_TRANSPORT_FAULT_INJECTED',
            'P2_INTERRUPTED_ORIGINAL_PROCESS_EFFECT_REQUIRED')
    fault_pins = original_fault_receipts(selection, selected, plan, effect)
    original_gateway = settlement['gateway']
    require(known._same_process(baseline['gateway'], original_gateway) and original_gateway['admission']['newWork'] is False and
            original_gateway['admission']['recovery'] is False and known._zero(original_gateway['admission']['active']) and
            original_gateway['admission']['uncertain'] == {'newWork': 0, 'recovery': 1}, 'P2_INTERRUPTED_EXACT_ORIGINAL_ONE_REQUIRED')
    output = stages['known-ack-replacement-intent.json']
    require(output['status'] == 'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT' and output['authorization'] == authorization and output['recoveryIntent'] == intent and
            output['stages'] == [list(s) for s in runtime.STAGES] and output.get('unavailableStages') == [list(s) for s in known.UNAVAILABLE_STAGES] and set(output['oldProcesses']) == set(runtime.SERVICES), 'P2_INTERRUPTED_SOURCE_REPLACEMENT_INTENT_REQUIRED')
    ready_path = ROOT / ('p2-certification-' + selection['originalCertificationActionId'])
    ready_raw = migrate.read_input(ready_path, 'p2-certification-current-ready.json', 2_000_000)
    ready = json.loads(ready_raw)
    inventory = ready.get('containers')
    require(ready.get('status') == 'P2_CERTIFICATION_CURRENT_READY' and ready.get('sqlReplayed') is False and ready.get('runtimeReplaced') is False and
            isinstance(inventory, list) and len(inventory) == len(runtime.SERVICES) and
            [row.get('service') for row in inventory] == list(runtime.SERVICES) and
            sha(canonical(inventory)) == expected_intent.get('runtimeInventorySha256') and
            all(set(row) == {'service', 'containerId', 'image', 'health'} and
                row['containerId'] == output['oldProcesses'][row['service']]['containerId'] and
                row['image'] == selected['artifacts'][runtime.IMAGE_KEYS[row['service']]]['image'] and
                row['health'] == ('none' if row['service'].endswith('-tls') else 'healthy') for row in inventory),
            'P2_INTERRUPTED_ORIGINAL_RUNTIME_INVENTORY_REQUIRED')
    active = None
    completed = []
    for index, stage in enumerate(runtime.STAGES):
        begin = stages.get('known-ack-stage-' + str(index) + '-intent.json')
        end = stages.get('known-ack-stage-' + str(index) + '-observed.json')
        require(end is None or begin is not None, 'P2_INTERRUPTED_STAGE_READBACK_WITHOUT_INTENT')
        if begin is not None:
            require(len(completed) == index and active is None and begin['status'] == 'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT' and
                    begin['stage'] == list(stage) and type(begin.get('maximumSeconds')) is int and begin['maximumSeconds'] == 120 and begin['candidateSha256'] == initial['candidateSha256'] and
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
    require_gateway_counts(observation)
    require(known._same_process(observation, original_gateway) and prior._closed_observed(observation) and
            known._zero(observation['admission']['active']) and observation['admission']['uncertain'] == {'newWork': 0, 'recovery': 1},
            'P2_INTERRUPTED_LATEST_SOURCE_STOPPED_ONE_REQUIRED')
    verify()
    return {'selection': selection, 'plan': plan, 'values': values, 'stages': stages, 'originalGateway': observation,
            'inputDirectory': input_directory, 'replacementDirectory': replacement, 'activeStage': active, 'completedStages': completed,
            'oldProcesses': output['oldProcesses'], 'originalReadySha256': sha(ready_raw), 'originalFaultReceiptSha256': fault_pins, 'originalSource': source, 'originalSourceManifest': manifest}


def _profiled_record(raw, profile):
    value = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(profile, value)
    require(type(value.get('version')) is int and value['version'] == 2, 'P2_INTERRUPTED_PROFILED_RECEIPT_REQUIRED')
    return value


def _profiled_selection(initial, selected, profile):
    value = initial['interruptedRestoration']
    migrate.require_profile(profile, initial, value)
    keys = {'version', 'qualificationTargetProfile', 'mode', 'restorationActionId', 'originalCertificationActionId',
            'originalRecoveryActionId', 'originalOperatorSourceCommit', 'causalReceiptSha256',
            'replacementReceiptSha256', 'priorGatewayReference'}
    ids = ('restorationActionId', 'originalCertificationActionId', 'originalRecoveryActionId')
    require(type(initial['version']) is int and initial['version'] == 2 and initial['mode'] == PROFILED_MODE and
            initial['environment'] == 'staging' and initial['recoveryActionId'] == value['restorationActionId'] and
            digest(initial['originalCertificationPlanSha256']) and digest(initial['originalCertificationPlanBytesSha256']) and
            set(value) == keys and type(value['version']) is int and value['version'] == 2 and value['mode'] == PROFILED_MODE and
            all(action(value[key]) for key in ids) and len({selected['releaseId'], *(value[key] for key in ids)}) == 4 and
            value['originalOperatorSourceCommit'] == selected['sources']['frontend']['commit'] and
            migrate.source_commit(value['originalOperatorSourceCommit']) and digest(initial['candidateSha256']),
            'P2_INTERRUPTED_PROFILED_EXPLICIT_SELECTION_REQUIRED')
    for key, names in (('causalReceiptSha256', PROFILED_CAUSAL_FILES), ('replacementReceiptSha256', REPLACEMENT_FILES)):
        pins = value[key]
        require(type(pins) is dict and set(pins) == set(names) and all(digest(pin) or
                key == 'replacementReceiptSha256' and pin is None for pin in pins.values()),
                'P2_INTERRUPTED_PROFILED_FIXED_PINS_REQUIRED')
    require(digest(value['replacementReceiptSha256']['known-ack-replacement-intent.json']),
            'P2_INTERRUPTED_PROFILED_REPLACEMENT_INTENT_REQUIRED')
    ref = value['priorGatewayReference']
    require(type(ref) is dict and set(ref) == {'kind', 'stopReceiptDirectory', 'stopReceiptSha256'} and
            ref['kind'] == 'stopped-current-candidate' and type(ref['stopReceiptDirectory']) is str and
            ref['stopReceiptDirectory'] == str(Path(ref['stopReceiptDirectory'])) and digest(ref['stopReceiptSha256']),
            'P2_INTERRUPTED_PROFILED_STOP_REFERENCE_REQUIRED')
    return copy.deepcopy(value)


def _profiled_files(directory, pins, profile):
    rows = {}
    for name, pin in pins.items():
        path = directory / name
        if pin is None:
            require(not path.exists() and not path.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_ABSENCE_CHANGED')
            continue
        raw = migrate.read_input(directory, name)
        require(sha(raw) == pin, 'P2_INTERRUPTED_ORIGINAL_RECEIPT_CHANGED')
        rows[name] = _profiled_record(raw, profile)
    return rows


def _profiled_causal(initial, selection, selected, values, profile):
    intent, baseline, domain, requests, settlement, authorization, reconciled = (values[name] for name in PROFILED_CAUSAL_FILES)
    plan = baseline['plan']; native_plan = plan['nativePlan']; reviewed = intent['intent']
    migrate.require_profile(profile, plan, native_plan, native_plan.get('target'), reviewed)
    for value in (plan, native_plan, reviewed):
        require(type(value.get('version')) is int and value['version'] == 2, 'P2_INTERRUPTED_PROFILED_ORIGINAL_PLAN_REQUIRED')
    recovery_id, cert_id = selection['originalRecoveryActionId'], selection['originalCertificationActionId']
    source_commit, candidate = selection['originalOperatorSourceCommit'], initial['candidateSha256']
    require(plan['candidateSha256'] == candidate and plan['candidateObjectSha256'] == native_plan['candidateSha256'] == sha(canonical(selected)) and
            plan['sourceCommit'] == plan['operatorSourceCommit'] == native_plan['sourceCommit'] == source_commit and
            plan['targetSha256'] == native_plan['targetSha256'] == initial['targetSha256'] and
            native_plan['actionId'] == plan['actionId'] == selected['releaseId'] and native_plan['projectId'] == selected['workload']['projectId'] and
            native_plan['phase2ContractManifestSha256'] == selected['phase2ContractManifestSha256'] and
            plan['environment'] == native_plan['environment'] == 'staging' and plan['profile'] == 'lifecycle-known-command-v1' and
            plan['mode'] == 'drop-after-ack' and plan['receiver'] in ('course', 'community') and one(plan['maxMatches']) and
            type(plan['leaseMilliseconds']) is int and plan['leaseMilliseconds'] == 120000 and
            len(native_plan['commandWitnesses']) == 1 and native_plan['commandWitnesses'][0]['action'] == 'suspend' and
            re.fullmatch(r'[1-9][0-9]{0,17}', native_plan['initialEpoch']) and
            type(native_plan['windowSeconds']) is int and 1 <= native_plan['windowSeconds'] <= 180 and
            plan['nativePlanSha256'] == native_plan['planSha256'] == sha(canonical({k: v for k, v in native_plan.items() if k != 'planSha256'})),
            'P2_INTERRUPTED_PROFILED_ORIGINAL_ONE_SUSPEND_REQUIRED')
    expected_intent = known.replacement_intent({**reviewed, 'knownAckConfigurationInputDirectory': reviewed['configurationInputDirectory'],
        'knownAckReceiverTargets': initial['receiverTargets'], 'nativePlan': native_plan}, recovery_id, expected_profile=profile)
    require(set(intent) == {'version', 'qualificationTargetProfile', 'recoveryActionId', 'intent', 'intentSha256'} and
            intent['recoveryActionId'] == recovery_id and reviewed == expected_intent and reviewed['certificationActionId'] == cert_id and
            reviewed['candidateSha256'] == candidate and reviewed['sourceCommit'] == reviewed['operatorSourceCommit'] == source_commit and
            reviewed['targetSha256'] == initial['targetSha256'] and reviewed['gatewayProcessSha256'] == plan['gatewayProcessSha256'] and
            reviewed['operatorSourceClosureSha256'] == plan['operatorSourceClosureSha256'] and
            sha(canonical(reviewed)) == intent['intentSha256'] == authorization['recoveryIntentSha256'],
            'P2_INTERRUPTED_PROFILED_ORIGINAL_INTENT_REQUIRED')
    require_original_configuration(initial, plan, reviewed)
    names = ('P2_KNOWN_ACK_BASELINE_RETAINED', 'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW', 'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED',
             'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT', 'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED', 'P2_KNOWN_ACK_RECONCILIATION_OBSERVED_FENCED')
    common = {'version', 'qualificationTargetProfile', 'status'}
    source_keys = {'recoveryActionId', 'candidateSha256', 'certificationActionId', 'sourceModuleSha256',
                   'operatorSourceClosureSha256', 'recoveryIntentReceiptSha256'}
    causal_keys = {'operationId', 'baselineSha256', 'domainSha256', 'requestDetailsSha256', 'settlementSha256'}
    replacement_pins = known.replacement_release_pins(reviewed, profile)
    for row, status, fields in zip((baseline, domain, requests, settlement, authorization, reconciled), names, (
            {'plan', 'sourceModuleSha256', 'candidateSha256', 'gateway', 'databases', 'recoveryActionId'},
            {'gateway', 'databases', 'effect', 'operationId'},
            {'artifactSha256', 'domainSha256', 'provenance', 'originalArtifact'},
            (causal_keys - {'settlementSha256'}) | {'recoveryActionId', 'epoch', 'gateway', 'databases'},
            source_keys | causal_keys | {'originalGateway', 'recoveryIntentSha256', 'reconciliationObservedSha256',
                'ordinaryClosedZeroGate', 'sqlReplayAllowed', 'roleChangeAllowed'},
            source_keys | causal_keys | {'gateway', 'databases', 'frontendGlobalClosedZero', 'oldGatewayUncertain',
                'runtimeReplaced', 'ordinaryClosedZeroGate'} | set(replacement_pins))):
        require(set(row) == common | fields and row.get('status') == status, 'P2_INTERRUPTED_PROFILED_CAUSAL_RECORD_REQUIRED')
    require(
            all(row['candidateSha256'] == candidate for row in (baseline, authorization, reconciled)) and
            all(row['recoveryActionId'] == recovery_id for row in (baseline, settlement, authorization, reconciled)) and
            authorization['certificationActionId'] == reconciled['certificationActionId'] == cert_id and
            authorization['sourceModuleSha256'] == reconciled['sourceModuleSha256'] == baseline['sourceModuleSha256'] and
            authorization['operatorSourceClosureSha256'] == reconciled['operatorSourceClosureSha256'] == reviewed['operatorSourceClosureSha256'] and
            all(authorization[key] is False for key in ('ordinaryClosedZeroGate', 'sqlReplayAllowed', 'roleChangeAllowed')) and
            reconciled['frontendGlobalClosedZero'] is True and reconciled['runtimeReplaced'] is False and
            reconciled['ordinaryClosedZeroGate'] is False and canonical(reconciled['oldGatewayUncertain']) == canonical({'newWork': 0, 'recovery': 1}),
            'P2_INTERRUPTED_PROFILED_CAUSAL_CONTEXT_REQUIRED')
    require(all(canonical(reconciled[key]) == canonical(value) for key, value in replacement_pins.items()),
            'P2_INTERRUPTED_PROFILED_REPLACEMENT_CAUSAL_PINS_CHANGED')
    pins = selection['causalReceiptSha256']
    for field, name, carriers in (
            ('baselineSha256', 'baseline.json', (settlement, authorization, reconciled)),
            ('domainSha256', 'domain.json', (requests, settlement, authorization, reconciled)),
            ('requestDetailsSha256', 'request-details.json', (settlement, authorization, reconciled)),
            ('settlementSha256', 'settlement.json', (authorization, reconciled)),
            ('recoveryIntentReceiptSha256', 'recovery-intent.json', (authorization, reconciled)),
            ('reconciliationObservedSha256', 'reconciliation-observed.json', (authorization,))):
        require(all(row[field] == pins[name] for row in carriers), 'P2_INTERRUPTED_PROFILED_CAUSAL_HASH_REQUIRED')
    old = settlement['gateway']
    for row in (baseline, domain, settlement, reconciled):
        require_snapshot_numbers(row['databases']); require_gateway_counts(row['gateway'])
        require(_profiled_process(row['gateway']['process'], running=True) and known._same_process(old, row['gateway']),
                'P2_INTERRUPTED_PROFILED_OLD_PROCESS_CHANGED')
    initial_gateway = baseline['gateway']['admission']
    require(initial_gateway['newWork'] is False and initial_gateway['recovery'] is True and
            known._zero(initial_gateway['active']) and known._zero(initial_gateway['uncertain']) and
            domain['databases']['frontend']['admission']['epoch'] == str(int(native_plan['initialEpoch']) + 1),
            'P2_INTERRUPTED_PROFILED_ORIGINAL_WINDOW_EPOCH_REQUIRED')
    for row, closed in ((domain, False), (settlement, True)):
        require(known.validate_domain(plan, baseline['databases'], row['databases'], row['gateway'], [domain['effect']], closed=closed)
                == {'operationId': domain['operationId']}, 'P2_INTERRUPTED_PROFILED_DOMAIN_REQUIRED')
    require(canonical(authorization['originalGateway']) == canonical(baseline['gateway']) and reconciled['gateway'] == old and
            prior._closed_observed(old) and known._zero(old['admission']['active']) and
            old['admission']['uncertain'] == {'newWork': 0, 'recovery': 1} and
            domain['operationId'] == settlement['operationId'] == authorization['operationId'] == reconciled['operationId'] and
            settlement['epoch'] == settlement['databases']['frontend']['admission']['epoch'] == str(int(native_plan['initialEpoch']) + 2),
            'P2_INTERRUPTED_PROFILED_EXACT_SETTLEMENT_REQUIRED')
    known.validate_settled(plan, settlement['databases'], reconciled['databases'], domain['operationId'], pins['settlement.json'])
    snapshots = (domain['databases'], settlement['databases'], reconciled['databases'])
    require(all(known._delivery_receipts(row['frontend']) == known._delivery_receipts(snapshots[0]['frontend']) and
                all(row[name] == snapshots[0][name] for name in ('course', 'community')) for row in snapshots[1:]) and
            snapshots[0]['frontend']['operations'] == snapshots[1]['frontend']['operations'],
            'P2_INTERRUPTED_PROFILED_IN_WINDOW_RECEIPTS_CHANGED')
    return plan, reviewed, old


def _profiled_process(value, *, running):
    return (type(value) is dict and set(value) == {'containerId', 'imageId', 'pid', 'startedAt', 'restartCount', 'running'} and
            digest(value['containerId']) and migrate.digest(value['imageId']) and type(value['pid']) is int and
            (value['pid'] > 0 if running else value['pid'] == 0) and value['running'] is running and
            type(value['startedAt']) is str and 0 < len(value['startedAt']) <= 80 and
            type(value['restartCount']) is int and value['restartCount'] >= 0)


def profiled_original_replacement_paths(initial, selected):
    from p2_frontend_replacement_parent import RUNTIME_REVIEW, WRITTEN_OBSERVATION
    from p2_replacement_terminal import SESSION_CLOSED, TERMINAL
    plan = initial['reviewedPlan']
    descriptor = plan['replacementRelease']
    return (Path(initial['results']) / ('p2-profiled-replacement-write-' + selected['releaseId']), {
        TERMINAL: plan['originalReleaseReceiptSha256'],
        'reviewed-plan.json': plan['originalReleasePlanSha256'],
        RUNTIME_REVIEW: descriptor['runtimeReviewSha256'],
        WRITTEN_OBSERVATION: descriptor['postflightSha256'],
        SESSION_CLOSED: descriptor['frontendSessionClosedSha256'],
        'frontend-original-database-receipt.json': descriptor['frontendDatabaseReceiptSha256'],
    })


def _profiled_original_replacement(initial, selected, reviewed, inputs, profile, *, source, manifest):
    import p2_certification_parent as cert
    from p2_frontend_replacement_parent import RUNTIME_REVIEW, private_record
    from p2_profiled_known_ack_restoration_parent import _raw_original
    original = _raw_original(initial, profile)
    pins = known.replacement_release_pins(original, profile)
    require(original['knownAckRecovery']['intent'] == reviewed and
            canonical(known.replacement_release_pins(reviewed, profile)) == canonical(pins) and
            canonical(known.replacement_release_pins(initial['reviewedPlan'], profile)) == canonical(pins) and
            all(canonical(inputs.get(key)) == canonical(value) for key, value in pins.items()) and
            inputs.get('hostOriginalReleaseReceiptSha256') == pins['originalReleaseReceiptSha256'] and
            inputs.get('readyReceiptSha256') == original['readyReceiptSha256'],
            'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_INPUT_REQUIRED')
    directory, records = profiled_original_replacement_paths(initial, selected)
    runtime_review = private_record(directory, RUNTIME_REVIEW)
    require(sha(runtime_review) == records[RUNTIME_REVIEW], 'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_REVIEW_CHANGED')
    review = decode_qualification_target_json(runtime_review, 'carrier')
    migrate.require_profile(profile, review)
    reviewed_controls = initial['inventory']['certification']
    require(type(review.get('version')) is int and review['version'] == 1 and
            canonical(review.get('certification')) == canonical(reviewed_controls),
            'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_REVIEW_CHANGED')
    results = Path(initial['results'])
    configuration = results / ('runtime-profiled-frontend-replacement-' + selected['releaseId']) / 'configuration'
    carrier = {**initial, 'sourceCommit': original['sourceCommit'], 'sourceSha256': manifest,
               'configuration': str(configuration), 'certification': reviewed_controls}
    receipt, verified = cert._profiled_replacement_original_terminal(carrier, original, selected, results, profile,
                                                                    source=source)
    require(verified is True and receipt == pins['originalReleaseReceiptSha256'],
            'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_TERMINAL_REQUIRED')
    return records


def _profiled_original_release(initial, selected, jobs, certification, selection, reviewed, manifest, profile, *, source):
    bundle = root_path(initial['bundle'])
    replacement = bool(known.replacement_release_pins(reviewed, profile))
    release_directory = ('migration-profiled-frontend-replacement-' if replacement else '') + selected['releaseId']
    retained_release = root_path(str(Path(initial['results']) / release_directory))
    candidate_raw = migrate.read_input(bundle, 'release.candidate.json')
    require(candidate_raw == migrate.read_input(retained_release, 'candidate.json') and
            sha(candidate_raw) == initial['candidateSha256'] and decode_qualification_target_json(candidate_raw, 'carrier') == selected,
            'P2_INTERRUPTED_PROFILED_EXACT_ORIGINAL_CANDIDATE_REQUIRED')
    inputs_raw = migrate.read_input(certification, 'p2-profiled-certification-input-verified.json')
    inputs = _profiled_record(inputs_raw, profile)
    require(inputs['status'] == 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED' and inputs['environment'] == 'staging' and
            inputs['releaseId'] == selected['releaseId'] and inputs['sourceCommit'] == reviewed['sourceCommit'] and
            inputs['certificationActionId'] == selection['originalCertificationActionId'] and inputs['targetSha256'] == initial['targetSha256'] and
            inputs['candidateSha256'] == initial['candidateSha256'] and digest(inputs['planSha256']) and
            inputs['planSha256'] == initial['originalCertificationPlanSha256'] and
            inputs['originalReleasePlanHashHostVerified'] is True, 'P2_INTERRUPTED_PROFILED_ORIGINAL_INPUT_REQUIRED')
    require(('replacementRelease' in inputs) == ('originalReleaseReceipt' in initial) == replacement,
            'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_INPUT_REQUIRED')
    original_pins = (_profiled_original_replacement(initial, selected, reviewed, inputs, profile, source=source,
                                                    manifest=manifest) if replacement else None)
    ready_raw = migrate.read_input(certification, 'p2-certification-current-ready.json')
    # This outer ready receipt is unchanged by the profiled certification
    # parent. The source API proof nested in it carries the v2 profile.
    ready = decode_qualification_target_json(ready_raw, 'carrier')
    require(set(ready) == {'status', 'apiDatabases', 'containers', 'sqlReplayed', 'runtimeReplaced'} and
            ready['status'] == 'P2_CERTIFICATION_CURRENT_READY' and ready['sqlReplayed'] is False and
            ready['runtimeReplaced'] is False and sha(canonical(ready['containers'])) == reviewed['runtimeInventorySha256'],
            'P2_INTERRUPTED_PROFILED_ORIGINAL_READY_REQUIRED')
    api_dir = certification / 'current-api'
    api_raw = migrate.read_input(api_dir, 'certification-current-databases-outcome.json')
    api = _profiled_record(api_raw, profile)
    migrate.require_contract_identity(selected, api)
    pins = initial['apiJobSha256']
    require(type(pins) is dict and set(pins) == {'course', 'community'} and all(digest(pin) for pin in pins.values()) and
            api == ready['apiDatabases'] and api['status'] == 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED' and
            api['phase'] == 'completed' and api['environment'] == 'staging' and api['releaseId'] == selected['releaseId'] and
            api['certificationActionId'] == selection['originalCertificationActionId'] and api['candidateSha256'] == initial['candidateSha256'] and
            api['checkerSha256'] == manifest['ops/platform/host/database_current.mjs'] and set(api['databases']) == set(pins) and
            all(api[key] is False for key in ('migrationsExecuted', 'frontendSqlApplied', 'trafficAuthorized')),
            'P2_INTERRUPTED_PROFILED_ORIGINAL_API_CURRENT_REQUIRED')
    for name, pin in pins.items():
        job = jobs[name]['job']; migrate.require_job_profile(profile, job)
        raw = migrate.read_input(bundle, 'jobs/' + name + '.json')
        receipt_raw = migrate.read_input(api_dir / name, 'database-receipt.json')
        receipt = _profiled_record(receipt_raw, profile)
        migrate.require_contract_identity(selected, receipt)
        receiver = initial['receiverTargets'][name]
        require(set(receiver) == {'host', 'port', 'database', 'user', 'serverMajor', 'roleOid'} and
                all(receiver[key] == job['target'][key] for key in ('host', 'port', 'database', 'serverMajor')) and
                receiver['user'] == job['runtimeRole'] and re.fullmatch(r'[1-9][0-9]{0,9}', receiver['roleOid']) and
                raw == migrate.read_input(api_dir / (name + '-input'), 'job.json') and sha(raw) == pin and
                decode_qualification_target_json(raw, 'carrier') == job and
                api['databases'][name] == {'image': jobs[name]['image'], 'jobSha256': pin, 'receiptSha256': sha(receipt_raw)} and
                receipt['status'] == 'CURRENT_API_DATABASE_READ_ONLY_PASS' and receipt['service'] == jobs[name]['service'] and
                receipt['environment'] == 'staging' and receipt['manifestSha256'] == pin and
                receipt['checkerSha256'] == api['checkerSha256'] and receipt['migrationsExecuted'] is False and
                receipt['schemaBaselineSha256'] == job['schemaBaselineSha256'] and receipt['artifactSha256'] == job['target']['artifactSha256'] and
                receipt['target'] == {key: job['target'][key] for key in ('host', 'port', 'database', 'user', 'serverMajor')} and
                'selected-image-operator-role-policy' in receipt['checks'] and receipt['pendingTags'] == [],
                'P2_INTERRUPTED_PROFILED_EXACT_ORIGINAL_API_JOB_REQUIRED')
    auxiliary = {'inputVerifiedSha256': sha(inputs_raw), 'readySha256': sha(ready_raw), 'apiCurrentSha256': sha(api_raw)}
    if original_pins is not None:
        auxiliary['originalReplacementRelease'] = original_pins
    return ready, auxiliary


def _profiled_replacement(initial, selected, selection, values, stages, old, ready, replacement):
    intent = stages['known-ack-replacement-intent.json']
    authorization = values['replacement-authorization.json']; recovery_id = selection['originalRecoveryActionId']
    candidate = initial['candidateSha256']; snapshot = replacement / 'runtime-known-ack/configuration'
    stage_fields = {'version', 'qualificationTargetProfile', 'status', 'recoveryActionId', 'candidateSha256'}
    require(set(intent) == stage_fields | {'authorization', 'recoveryIntent', 'oldProcesses', 'stages', 'unavailableStages',
            'authorizationRawSha256', 'configurationSha256', 'configurationPaths'} and
            intent['status'] == 'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT' and intent['authorization'] == authorization and
            intent['recoveryIntent'] == values['recovery-intent.json'] and
            intent['authorizationRawSha256'] == selection['causalReceiptSha256']['replacement-authorization.json'] and
            intent['configurationSha256'] == initial['configurationSha256'] and
            intent['configurationPaths'] == {'input': initial['configuration'], 'oldMounted': old['binding']['configurationDirectory'],
                                              'newMounted': str(snapshot)} and
            intent['stages'] == [list(stage) for stage in runtime.STAGES] and
            intent['unavailableStages'] == [list(stage) for stage in known.UNAVAILABLE_STAGES],
            'P2_INTERRUPTED_PROFILED_REPLACEMENT_INTENT_REQUIRED')
    for row in stages.values():
        require(row.get('candidateSha256') == candidate and row.get('recoveryActionId') == recovery_id,
                'P2_INTERRUPTED_PROFILED_REPLACEMENT_ACTION_REQUIRED')
    inventory, old_processes = ready['containers'], intent['oldProcesses']
    require(set(old_processes) == set(runtime.SERVICES) and old_processes['gateway'] == old['process'] and
            [row['service'] for row in inventory] == list(runtime.SERVICES) and
            all(set(row) == {'service', 'containerId', 'image', 'health'} and
                _profiled_process(old_processes[row['service']], running=True) and
                row['containerId'] == old_processes[row['service']]['containerId'] and
                row['image'] == selected['artifacts'][runtime.IMAGE_KEYS[row['service']]]['image'] and
                row['health'] == ('none' if row['service'].endswith('-tls') else 'healthy') for row in inventory) and
            len({row['containerId'] for row in inventory}) == len(runtime.SERVICES), 'P2_INTERRUPTED_PROFILED_RUNTIME_INVENTORY_REQUIRED')
    completed, active, processes = [], None, copy.deepcopy(old_processes)
    for index, stage in enumerate(runtime.STAGES):
        begin = stages.get(f'known-ack-stage-{index}-intent.json')
        end = stages.get(f'known-ack-stage-{index}-observed.json')
        if begin is None:
            require(end is None, 'P2_INTERRUPTED_STAGE_READBACK_WITHOUT_INTENT')
            continue
        require(set(begin) == stage_fields | {'stage', 'maximumSeconds', 'authorizationReceiptSha256'} and
                len(completed) == index and active is None and begin['status'] == 'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT' and
                begin['stage'] == list(stage) and type(begin['maximumSeconds']) is int and begin['maximumSeconds'] == 120 and
                begin['authorizationReceiptSha256'] == sha(canonical(authorization)), 'P2_INTERRUPTED_PROFILED_STAGE_INTENT_REQUIRED')
        if end is None:
            active = stage
            continue
        require(set(end) == stage_fields | {'stage', 'newProcesses'} and end['status'] == 'P2_KNOWN_ACK_RUNTIME_STAGE_OBSERVED' and
                end['stage'] == list(stage) and set(end['newProcesses']) == set(stage) and
                all(_profiled_process(row, running=True) and row['restartCount'] == 0 and
                    row['containerId'] != old_processes[name]['containerId'] and row['imageId'] == old_processes[name]['imageId']
                    for name, row in end['newProcesses'].items()), 'P2_INTERRUPTED_PROFILED_STAGE_READBACK_REQUIRED')
        processes.update(end['newProcesses']); completed.append(stage)
        require(len({row['containerId'] for row in processes.values()}) == len(processes), 'P2_INTERRUPTED_PROFILED_STAGE_PROCESS_COLLISION')
    return active, completed, old_processes, processes


def _profiled_stop_pair(directory, initial, selected, manifest, profile):
    before_raw, stop_raw = (migrate.read_input(directory, name) for name in (prior.BEFORE_STOP, prior.STOPPED))
    before, stop = (_profiled_record(raw, profile) for raw in (before_raw, stop_raw))
    action_id = prior._require_profiled_stop_identity(directory, initial, selected, before, stop, profile)
    observation = before['observation']; process = observation['process']; stopped = stop['stoppedProcess']
    require(action_id is not None and before['status'] == 'PRIOR_GATEWAY_PRESTOP_OBSERVED' and
            stop['status'] == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED' and before['protocol'] == stop['protocol'] == prior.PROTOCOL and
            before['sourceModuleSha256'] == stop['sourceModuleSha256'] == manifest['ops/platform/host/p2_prior_gateway.py'] and
            stop['beforeSha256'] == sha(before_raw) and prior._closed_observed(observation) and
            _profiled_process(process, running=True) and _profiled_process(stopped, running=False) and
            stopped == {**process, 'pid': 0, 'running': False}, 'P2_INTERRUPTED_PROFILED_STOP_PAIR_REQUIRED')
    return observation, action_id, {'beforeSha256': sha(before_raw), 'stopSha256': sha(stop_raw)}


def _profiled_gateway_frontier(initial, selected, selection, stages, old, active, completed, processes,
                               certification, replacement, snapshot, manifest, profile, verify, command):
    ref = selection['priorGatewayReference']; stop_dir = root_path(ref['stopReceiptDirectory'])
    guard_dirs = (certification, certification / 'prior-gateway-after-quiescence', certification / 'prior-gateway-broker-fallback')
    require(stop_dir in (replacement, *guard_dirs), 'P2_INTERRUPTED_PROFILED_FIXED_STOP_ROOT_REQUIRED')
    stopped, retained_action, stop_pins = _profiled_stop_pair(stop_dir, initial, selected, manifest, profile)
    require(stop_pins['stopSha256'] == ref['stopReceiptSha256'] and known._zero(stopped['admission']['active']),
            'P2_INTERRUPTED_PROFILED_STOP_REFERENCE_CHANGED')
    require(prior.observe_stopped_prior_gateway({**initial, 'priorGatewayReference': ref}, selected, verify, command,
                expected_profile=profile) == stopped, 'P2_INTERRUPTED_PROFILED_ACTUAL_STOP_REQUIRED')
    marker = stages.get(B_GATEWAY_MARKER)
    if marker is None:
        require(('gateway',) not in completed and known._same_process(stopped, old) and
                stopped['admission']['uncertain'] == {'newWork': 0, 'recovery': 1} and
                (stop_dir != replacement or active == ('gateway',)), 'P2_INTERRUPTED_PROFILED_LATEST_STOPPED_ONE_REQUIRED')
        if active == ('gateway',):
            frontier_sources = {PROFILED_B_FRONTIER_SHA256}
            if 'originalReleaseReceipt' not in initial:
                frontier_sources.add(PROFILED_LEGACY_B_FRONTIER_SHA256)
            require(manifest[known.HOST_MODULE] in frontier_sources,
                    'P2_INTERRUPTED_PROFILED_GATEWAY_FRONTIER_UNKNOWN')
        return 'original-stopped-one', stopped, stop_pins

    require(completed == list(runtime.STAGES) and active is None and stop_dir in guard_dirs and
            retained_action == selection['originalCertificationActionId'] and prior._zero(stopped) and
            stopped['process'] == processes['gateway'] and stopped['process']['containerId'] != old['process']['containerId'] and
            stopped['binding'] == {**old['binding'], 'configurationDirectory': str(snapshot)},
            'P2_INTERRUPTED_PROFILED_LATEST_REPLACEMENT_ZERO_REQUIRED')
    original_stop, original_action, original_pins = _profiled_stop_pair(replacement, initial, selected, manifest, profile)
    candidate, recovery_id = initial['candidateSha256'], selection['originalRecoveryActionId']
    common = {'protocol': prior.PROTOCOL, 'actionId': recovery_id, 'candidateSha256': candidate,
              'process': old['process'], 'binding': old['binding']}
    require(set(marker) == {'version', 'qualificationTargetProfile', 'status', 'recoveryActionId', 'candidateSha256',
            'operatorSourceClosureSha256', 'sourceModuleSha256', 'authorizationReceiptSha256', 'beforeStopSha256', 'orderedStopSha256',
            'oldProcess', 'oldBinding', 'sourceStopLineage', 'pendingLineage'} and
            marker['status'] == 'P2_KNOWN_ACK_GATEWAY_REPLACEMENT_STARTED' and original_action == recovery_id and
            known._same_process(original_stop, old) and known._zero(original_stop['admission']['active']) and
            original_stop['admission']['uncertain'] == {'newWork': 0, 'recovery': 1} and
            marker['operatorSourceClosureSha256'] == stages['known-ack-replacement-intent.json']['authorization']['operatorSourceClosureSha256'] and
            marker['sourceModuleSha256'] == manifest[known.HOST_MODULE] and
            marker['authorizationReceiptSha256'] == stages['known-ack-stage-4-intent.json']['authorizationReceiptSha256'] and
            marker['beforeStopSha256'] == original_pins['beforeSha256'] and marker['orderedStopSha256'] == original_pins['stopSha256'] and
            canonical(marker['oldProcess']) == canonical(old['process']) and marker['oldBinding'] == old['binding'] and
            canonical(marker['sourceStopLineage']) == canonical({**common, 'state': 'stopped-observed', 'stopReceiptDirectory': str(replacement),
                                                                  'stopReceiptSha256': original_pins['stopSha256']}) and
            canonical(marker['pendingLineage']) == canonical({**common, 'state': 'replacement-in-progress', 'expectedCandidateSha256': candidate}),
            'P2_INTERRUPTED_PROFILED_DURABLE_GATEWAY_FRONTIER_REQUIRED')
    return 'replacement-stopped-zero', stopped, {**stop_pins, 'originalBeforeSha256': original_pins['beforeSha256'],
                                                  'originalStopSha256': original_pins['stopSha256']}


def _profiled_completion(certification, replacement, frontier, stopped, old, processes, initial, selected, selection, values, profile):
    terminal = certification / 'p2-profiled-current-certification-outcome.json'
    require(not terminal.exists() and not terminal.is_symlink(), 'P2_INTERRUPTED_ORIGINAL_COMPLETION_EXISTS')
    runtime_dir = replacement / 'runtime-known-ack'
    paths = (runtime_dir / 'p2-recovery-runtime-ready.json', runtime_dir / 'known-ack-runtime-outcome.json',
             certification / 'known-ack-replacement-joined.json')
    records = [migrate.read_input(path.parent, path.name) if path.exists() or path.is_symlink() else None for path in paths]
    if any(raw is not None for raw in records):
        require(frontier == 'replacement-stopped-zero' and records[0] is not None and
                (records[2] is None or records[2] == records[1]), 'P2_INTERRUPTED_PROFILED_COMPLETION_FRONTIER_REQUIRED')
        for raw in records[:2]:
            if raw is None:
                continue
            value = _profiled_record(raw, profile)
            require(value['environment'] == 'staging' and value['releaseId'] == selected['releaseId'] and
                    value['recoveryActionId'] == selection['originalRecoveryActionId'] and value['candidateSha256'] == initial['candidateSha256'] and
                    all(value[key] is False for key in ('sqlReplayed', 'migrationsExecuted', 'frontendSqlApplied', 'trafficAuthorized')),
                    'P2_INTERRUPTED_PROFILED_COMPLETION_IDENTITY_REQUIRED')
        ready = _profiled_record(records[0], profile)
        inventory = [{'service': name, 'containerId': processes[name]['containerId'],
                      'image': selected['artifacts'][runtime.IMAGE_KEYS[name]]['image'],
                      'health': 'none' if name.endswith('-tls') else 'healthy'} for name in runtime.SERVICES]
        require(ready['status'] == 'P2_RECOVERY_API_RUNTIME_READY' and ready['containers'] == inventory,
                'P2_INTERRUPTED_PROFILED_COMPLETION_READY_REQUIRED')
        if records[1] is not None:
            outcome = _profiled_record(records[1], profile)
            migrate.require_contract_identity(selected, outcome)
            release_pins = known.replacement_release_pins(values['recovery-intent.json']['intent'], profile)
            require(outcome['status'] == 'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED' and outcome['readinessReceiptSha256'] == sha(records[0]) and
                    all(canonical(outcome.get(key)) == canonical(value) for key, value in release_pins.items()) and
                    ('replacementRelease' in outcome) == bool(release_pins) and
                    known._same_process(outcome['newGateway'], stopped) and prior._zero(outcome['newGateway']) and
                    known._same_process(outcome['originalGateway'], old) and outcome['originalGatewayUncertaintyPreserved'] is True and
                    outcome['originalGateway']['admission']['uncertain'] == {'newWork': 0, 'recovery': 1} and
                    outcome['containers'] == ready['containers'] and outcome['apiDatabases'] == ready['apiDatabases'] == outcome['currentApiDatabasesAfter'] and
                    outcome['ordinaryClosedZeroGate'] is False and outcome['nativeDisabled'] is True and one(outcome['runtimeReplacements']) and
                    outcome['recoveryIntentSha256'] == values['recovery-intent.json']['intentSha256'] and
                    outcome['frontendOperationId'] == initial['operationId'] and
                    outcome['gatewayReplacementStartedSha256'] == selection['replacementReceiptSha256'][B_GATEWAY_MARKER],
                    'P2_INTERRUPTED_PROFILED_COMPLETION_OUTCOME_REQUIRED')
    return {path.name: None if raw is None else sha(raw) for path, raw in zip(paths, records)}


def load_profiled_retained(initial, selected, jobs, verify, command=None, *, expected_profile):
    """Read the exact interrupted B chain and latest stop. This issues no authority."""
    profile = migrate.profile_context(expected_profile)
    require(profile is not None, 'P2_INTERRUPTED_PROFILED_SOURCE_REQUIRED')
    migrate.candidate_profile(selected, profile)
    require(set(jobs) == {'frontend', 'course', 'community'} and set(initial['receiverTargets']) == {'course', 'community'},
            'P2_INTERRUPTED_PROFILED_EXACT_JOBS_REQUIRED')
    verify()
    selection = _profiled_selection(initial, selected, profile)
    cert_id, recovery_id = selection['originalCertificationActionId'], selection['originalRecoveryActionId']
    certification = root_path(str(Path(initial['results']) / ('p2-profiled-current-certification-' + cert_id)))
    causal = root_path(str(ROOT / ('p2-known-ack-loss-' + cert_id)))
    replacement = root_path(str(ROOT / ('p2-profiled-known-ack-' + recovery_id)))
    values = _profiled_files(causal, selection['causalReceiptSha256'], profile)
    stages = _profiled_files(replacement, selection['replacementReceiptSha256'], profile)
    plan, reviewed, old = _profiled_causal(initial, selection, selected, values, profile)
    from p2_certification_fault import frontend_target_sha256
    frontend_job = jobs['frontend']['job']; migrate.require_job_profile(profile, frontend_job, frontend=True)
    target = {key: frontend_job['target'][key] for key in ('host', 'port', 'database', 'user', 'serverMajor', 'qualificationTargetProfile')}
    require(plan['nativePlan']['target'] == target and initial['targetSha256'] == frontend_target_sha256(target),
            'P2_INTERRUPTED_PROFILED_ORIGINAL_FRONTEND_TARGET_REQUIRED')
    require(values['settlement.json']['operationId'] == initial['operationId'] and
            re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', initial['operationId']),
            'P2_INTERRUPTED_PROFILED_REVIEWED_OPERATION_REQUIRED')
    source, manifest = original_source(selection['originalOperatorSourceCommit'], reviewed['operatorSourceClosureSha256'], expected_profile=profile)
    require({known.HOST_MODULE, known.MODULE, 'ops/platform/host/p2_prior_gateway.py', 'ops/platform/host/p2_certification_fault.py',
             'ops/gateway/p2-certification-fault.mjs'}.issubset(manifest) and
            manifest[known.MODULE] == values['baseline.json']['sourceModuleSha256'], 'P2_INTERRUPTED_PROFILED_ORIGINAL_READER_REQUIRED')
    ready, auxiliary = _profiled_original_release(initial, selected, jobs, certification, selection, reviewed, manifest, profile,
                                                 source=source)
    active, completed, old_processes, processes = _profiled_replacement(initial, selected, selection, values, stages, old, ready, replacement)
    input_directory = root_path(initial['configuration']); old_mount = root_path(old['binding']['configurationDirectory'])
    snapshot = replacement / 'runtime-known-ack/configuration'
    require(str(input_directory) == reviewed['configurationInputDirectory'] and len({input_directory, old_mount, snapshot}) == 3,
            'P2_INTERRUPTED_PROFILED_ORIGINAL_CONFIGURATION_PATH_REQUIRED')
    if 'originalReplacementRelease' in auxiliary:
        require(old_mount == Path(initial['results']) / ('runtime-profiled-frontend-replacement-' + selected['releaseId']) / 'configuration',
                'P2_INTERRUPTED_PROFILED_ORIGINAL_REPLACEMENT_RUNTIME_MOUNT_REQUIRED')
    runtime.validate_snapshot_source(input_directory, selected, jobs, expected_profile=profile)
    for directory in (input_directory, old_mount):
        require(staging_state.configuration_hashes(directory) == initial['configurationSha256'],
                'P2_INTERRUPTED_PROFILED_ORIGINAL_CONFIGURATION_BYTES_CHANGED')
    if active is not None or completed or snapshot.exists() or snapshot.is_symlink():
        require(staging_state.configuration_hashes(root_path(str(snapshot))) == initial['configurationSha256'] and
                'sha256:' + sha(migrate.read_input(snapshot, 'compose.yaml')) == selected['runtime']['composeSha256'],
                'P2_INTERRUPTED_PROFILED_REPLACEMENT_SNAPSHOT_CHANGED')
    requests = values['request-details.json']
    request_raw = migrate.read_input(certification, 'p2-certification-operator-request-details.json')
    require(sha(request_raw) == requests['artifactSha256'] == requests['provenance']['artifactSha256'] and
            decode_qualification_target_json(request_raw, 'carrier') == requests['originalArtifact'] and
            requests['provenance']['authority'] == 'operator-recorded-request-details', 'P2_INTERRUPTED_ORIGINAL_REQUEST_BYTES_REQUIRED')
    domain = values['domain.json']; effect = domain['effect']
    validate_request_details(plan, cert_id, requests, domain['databases']['frontend']['operations'], strict=True)
    require(set(effect) == {'version', 'status', 'environment', 'profile', 'stageId', 'candidateSha256', 'configurationSha256',
            'gatewayProcessSha256', 'gatewayImageSha256', 'sourceWitnessSha256', 'leaseSha256', 'mode', 'receiver', 'upstreamStarted',
            'downstreamDisposition', 'upstreamReceiptVerified', 'upstreamStatus', 'downstreamBytesStarted'} and
            one(effect['version']) and effect['status'] == 'P2_TRANSPORT_FAULT_INJECTED' and
            all(effect[key] == plan[key] for key in ('environment', 'profile', 'stageId', 'candidateSha256', 'configurationSha256',
                'gatewayProcessSha256', 'gatewayImageSha256', 'mode', 'receiver')) and
            effect['gatewayImageSha256'] == selected['artifacts']['gateway']['image'].split('@sha256:')[1] and
            type(effect['upstreamStatus']) is int and effect['upstreamStatus'] == 200, 'P2_INTERRUPTED_PROFILED_RAW_EFFECT_REQUIRED')
    fault_pins = original_fault_receipts(selection, selected, plan, effect, expected_profile=profile,
                                         certification=certification, old_mount=old_mount)
    frontier, stopped, stop_pins = _profiled_gateway_frontier(initial, selected, selection, stages, old, active, completed,
        processes, certification, replacement, snapshot, manifest, profile, verify, command)
    completion = _profiled_completion(certification, replacement, frontier, stopped, old, processes, initial, selected, selection, values, profile)
    verify()
    return {'selection': selection, 'plan': plan, 'values': values, 'stages': stages, 'originalGateway': old, 'stoppedGateway': stopped,
            'frontier': frontier, 'inputDirectory': input_directory, 'oldMountedDirectory': old_mount, 'replacementDirectory': replacement,
            'replacementSnapshot': snapshot, 'activeStage': active, 'completedStages': completed, 'oldProcesses': old_processes,
            'observedProcesses': processes, 'originalSource': source, 'originalSourceManifest': manifest, 'originalFaultReceiptSha256': fault_pins,
            'originalAuxiliarySha256': {**auxiliary, 'operatorRequestSha256': sha(request_raw), 'stop': stop_pins, 'completion': completion}}


def validate_fresh_settled(retained, snapshot):
    """Fresh observation deadline is not inherited from the interrupted process."""
    settlement = retained['values']['settlement.json']
    require_snapshot_numbers(snapshot)
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
                require_gateway_counts(actual)
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
                require_gateway_counts(actual)
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

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.interrupted_fallback_lock = threading.RLock()
        self.interrupted_fallback_done = False

    def children_quiesced(self):
        if not self.scope:
            return True
        try:
            with self.scope.mutations:
                return all(process.poll() is not None for process in self.scope.processes)
        except BaseException:
            return False

    def fixed_failure_containment(self, name):
        from p2_release_supervisor import fail_closed, C_LAYOUT
        initial = {**self.initial, '_guardLayout': C_LAYOUT,
                   '_guardObserverSource': self.observer_source}
        result = fail_closed(initial, getattr(self, 'armed_probe', None), self.source,
                             record_name=name, observer_type=self.observer_type,
                             native_containment=contain_interrupted_native)
        self.outcome.update(result)

    def abort(self):
        # Serialize the parent reaping with all tail containment and close().
        # A healthy independent guard remains the sole containment owner.
        with self.interrupted_fallback_lock:
            previously_failed = self.failed.is_set()
            super().abort()
            if self.guard_alive or not (self.observer or self.scope or getattr(self, 'armed_probe', None)):
                return
            if self.interrupted_fallback_done:
                return
            self.interrupted_fallback_done = True
            # A guard may die after an earlier delegated abort. Parent.failed
            # is never reset: explicitly reap, then use the fixed C guard path.
            if self.scope:
                try:
                    self.scope.revoke()
                except BaseException:
                    self.outcome['workerProcessCleanupUncertain'] = True
            if previously_failed:
                try:
                    self.fixed_failure_containment('p2-interrupted-surviving-broker-containment.json')
                except BaseException:
                    self.outcome['survivingBrokerContainmentUncertain'] = True
            else:
                try:
                    result = contain_interrupted_native(self.initial, getattr(self, 'armed_probe', None), self.source)
                    require(set(result) == {'nativeDisabled', 'nativeDisableAttempted'} and
                            (result['nativeDisabled'] is True or result['nativeDisabled'] is None) and type(result['nativeDisableAttempted']) is bool,
                            'P2_INTERRUPTED_NATIVE_CONTAINMENT_RESULT_UNKNOWN')
                    self.outcome.update(result)
                except BaseException:
                    self.outcome.update(nativeDisabled=None, nativeDisableAttempted=None)
                try:
                    from p2_release_supervisor import cleanup_recovery_current_containers
                    cleanup_recovery_current_containers()
                except BaseException:
                    self.outcome['recoveryCurrentContainerCleanupUncertain'] = True
            self.outcome['workerProcessesQuiesced'] = self.children_quiesced()
            if not self.children_quiesced():
                self.outcome.update(workerProcessesQuiesced=False, workerProcessCleanupUncertain=True,
                                    runtimeStopped=None, recoveryCurrentContainerCleanupUncertain=True)

    def close(self, committed=False):
        from p2_release_supervisor import sticky_cleanup_signals
        with self.interrupted_fallback_lock:
            if not committed:
                self.abort()
            retained = not self.children_quiesced()
        # Retain the actual FD if kill/wait is unknown. Release the cleanup
        # mutex while waiting so a newly dead guard can still trigger reaping.
        signals = sticky_cleanup_signals() if retained and threading.current_thread() is threading.main_thread() else contextlib.nullcontext()
        with signals:
            while True:
                with self.interrupted_fallback_lock:
                    if self.children_quiesced():
                        break
                    self.outcome.update(workerProcessesQuiesced=False, workerProcessCleanupUncertain=True, runtimeStopped=None)
                time.sleep(0.1)
            if retained:
                with self.interrupted_fallback_lock:
                    try:
                        self.fixed_failure_containment('p2-interrupted-surviving-broker-after-quiescence.json')
                        self.outcome['workerProcessesQuiesced'] = True
                    except BaseException:
                        self.outcome['survivingBrokerContainmentUncertain'] = True
        # A worker may itself unwind through abort(); never join while holding
        # the cleanup mutex that it needs in order to finish.
        if self.worker and self.worker is not threading.current_thread():
            self.worker_done.wait(15)
        with self.interrupted_fallback_lock:
            require(self.children_quiesced(), 'P2_INTERRUPTED_MUTATOR_NOT_QUIESCED')
            if not committed and hasattr(self, 'directory'):
                try:
                    migrate.write_json(self.directory, 'p2-release-failure.json', self.outcome)
                except BaseException:
                    pass
            if self.observer:
                self.observer.stop()
            if self.scope:
                self.scope.closed = True
            if self.lock_fd is not None:
                os.close(self.lock_fd)
                self.lock_fd = None

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
        fault = ROOT / ('p2-certification-' + selection['originalCertificationActionId']) / 'fault'
        require({name: sha(migrate.read_input(fault, name, 2_000_000)) for name in retained['originalFaultReceiptSha256']} == retained['originalFaultReceiptSha256'],
                'P2_INTERRUPTED_ORIGINAL_FAULT_BYTES_CHANGED')
        require(sha(migrate.read_input(ROOT / ('p2-certification-' + selection['originalCertificationActionId']),
                'p2-certification-current-ready.json', 2_000_000)) == retained['originalReadySha256'], 'P2_INTERRUPTED_ORIGINAL_READY_CHANGED')
        verify_source_closure({'sourceSha256': retained['originalSourceManifest'],
                               'sourceClosureSha256': retained['values']['replacement-authorization.json']['operatorSourceClosureSha256']}, retained['originalSource'])
        require_original_configuration(self.initial, retained['plan'], retained['values']['recovery-intent.json']['intent'])
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
                  'originalReadyReceiptSha256': self.retained['originalReadySha256'],
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
