"""Read only the fixed replacement release receipts for the exact host action."""

import base64
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
from p2_frontend_replacement_parent import (PROFILE, RECOVERY_CLOSED, RECOVERY_OPERATOR, RECOVERY_PHYSICAL, RECOVERY_REVIEW,
                                           private_record, recovery_review)
from qualification_target_profile import decode_qualification_target_json

REFUSED = 'P2_REPLACEMENT_OPERATOR_EVIDENCE_REFUSED'
ROOT = Path('/var/lib/lash-her/releases/staging')
ACTION_NAMES = {
    'p2-frontend-replacement-guard-armed.json', 'p2-frontend-replacement-empty-catalog.json',
    'p2-frontend-replacement-write-intent.json', 'p2-frontend-replacement-written-observation.json',
    'p2-frontend-replacement-runtime-intent.json', 'frontend-deployment-proof.json',
    'frontend-workload-outcome.json', 'frontend-promotion-outcome.json', 'frontend-session-closed.json',
    'p2-frontend-replacement-close-prepared.json',
    'frontend-job-outcome.json', 'frontend-continuation-completed.json', 'frontend-release-outcome.json',
    'p2-frontend-replacement-write-commit-intent.json', 'p2-frontend-replacement-write-outcome.json',
}
RECOVERY_NAMES = {RECOVERY_PHYSICAL, RECOVERY_CLOSED}
RECOVERY_REQUEST_FIELDS = {'operatorSourceCommit', 'recoveryReviewSha256'}
OUTCOME_PREFIXES = {
    'migration-outcome.json': 'migration-profiled-frontend-replacement-',
    'runtime-outcome.json': 'runtime-profiled-frontend-replacement-',
}
SUCCESSOR_OPERATION = 'read-successor-runtime'
ROTATION_SUCCESSOR_OPERATION = 'read-identity-rotation-successor'
ROTATION_FRONTEND_READY_OPERATION = 'read-identity-rotation-frontend-ready'
SUCCESSOR_RECEIPT = 'p2-replacement-successor-runtime.json'
SUCCESSOR_STATUS = 'P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED'
SUCCESSOR_PREFIXES = {
    'known-ack': 'p2-profiled-current-certification-',
    'interrupted-known-ack': 'p2-profiled-known-ack-restoration-',
}
IDENTITY = ('environment', 'releaseId', 'sourceCommit', 'candidateSha256')
REQUEST_FIELDS = {'version', 'qualificationTargetProfile', 'results', *IDENTITY}
SUCCESSOR_PINS = ('targetSha256', 'configurationCanonicalSha256', 'terminalSha256', 'runtimeReceiptSha256',
                  'frontendSessionClosedSha256', 'runtimeInventorySha256', 'gatewayProcessSha256')
SUCCESSOR_FIELDS = {'version', 'qualificationTargetProfile', 'status', *IDENTITY, 'kind', 'actionId', 'runtimeActionId',
                    'hostMachineId', 'replacementRelease', 'originalReleasePlanSha256', 'originalReleaseReceiptSha256',
                    'frontendEpoch', *SUCCESSOR_PINS}


def require(condition):
    migrate.demand(condition, REFUSED)


def digest(value):
    return type(value) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{64}', value)


def action_id(value):
    return type(value) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value)


def read_reviewed_action(request, plan_sha):
    require(type(request['version']) is int and request['version'] == 1 and request['environment'] == 'staging')
    migrate.require_profile(PROFILE, request)
    release = request['releaseId']
    require(action_id(release) and migrate.source_commit(request['sourceCommit']) and
            digest(request['candidateSha256']) and digest(plan_sha))
    require(type(request['results']) is str and len(request['results']) <= 4096 and ',' not in request['results'])
    results = Path(request['results'])
    require(str(results) == request['results'] and results == results.resolve() and ROOT in results.parents)
    migrate.private_directory(results)
    action = results / ('p2-profiled-replacement-write-' + release)
    migrate.private_directory(action)
    plan_bytes = private_record(action, 'reviewed-plan.json', 2_000_000)
    require(migrate.file_hash(plan_bytes) == plan_sha)
    plan = decode_qualification_target_json(plan_bytes, 'carrier')
    migrate.require_profile(PROFILE, plan)
    require(plan.get('status') == 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED' and
            all(plan.get(key) == request[key] for key in IDENTITY))
    return results, action


def read_replacement_evidence(request):
    require(type(request) is dict)
    if request.get('operation') == ROTATION_SUCCESSOR_OPERATION:
        return read_rotation_successor_evidence(request)
    if request.get('operation') == ROTATION_FRONTEND_READY_OPERATION:
        return read_rotation_frontend_ready_evidence(request)
    if 'operation' in request:
        return read_successor_runtime_evidence(request)
    recovering = bool(RECOVERY_REQUEST_FIELDS & set(request))
    require(set(request) == REQUEST_FIELDS | {'reviewedPlanSha256', 'name'} |
            (RECOVERY_REQUEST_FIELDS if recovering else set()))
    release, name = request['releaseId'], request['name']
    require(type(name) is str and name in ACTION_NAMES | OUTCOME_PREFIXES.keys() | (RECOVERY_NAMES if recovering else set()))
    results, action = read_reviewed_action(request, request['reviewedPlanSha256'])
    if recovering:
        reviewed = private_record(action, RECOVERY_REVIEW)
        review = recovery_review({**request, 'recoveryReviewBytes': base64.b64encode(reviewed).decode('ascii')}, release)
        operator = decode_qualification_target_json(private_record(action, RECOVERY_OPERATOR), 'carrier')
        require(type(operator) is dict and set(operator) == {
            'operatorSourceCommit', 'sourceClosureSha256', 'sourceCommit', 'recoveryReviewSha256', 'actionId'} and
            all(operator[key] == request[key] for key in ('operatorSourceCommit', 'sourceCommit', 'recoveryReviewSha256')) and
            operator['actionId'] == review['actionId'] and digest(operator['sourceClosureSha256']))
    directory = results / (OUTCOME_PREFIXES[name] + release) if name in OUTCOME_PREFIXES else action
    migrate.private_directory(directory)
    raw = private_record(directory, name, 2_000_000 if name in OUTCOME_PREFIXES else 65_536)
    require(raw.endswith(b'\n'))
    return raw


def _read_original_terminal(request):
    from p2_replacement_terminal import TERMINAL, TERMINAL_STATUS, exact_receipt

    require(digest(request['originalReleaseReceiptSha256']))
    results, original = read_reviewed_action(request, request['originalReleasePlanSha256'])
    terminal_raw = private_record(original, TERMINAL)
    require(migrate.file_hash(terminal_raw) == request['originalReleaseReceiptSha256'])
    terminal = exact_receipt(terminal_raw)
    require(terminal.get('status') == TERMINAL_STATUS and terminal.get('frontendSqlApplied') is True and
            terminal.get('frontendSqlReplayed') is False and terminal.get('frontendSessionClosed') is True and
            terminal.get('trafficAuthorized') is False and terminal.get('releaseAccepted') is False and
            terminal.get('reviewedPlanSha256') == request['originalReleasePlanSha256'] and
            all(terminal.get(key) == request[key] for key in IDENTITY))
    return results, terminal


def read_successor_runtime_evidence(request):
    from p2_certification_parent import REPLACEMENT_RELEASE_HASHES, require_certification_replacement_release
    from p2_replacement_terminal import exact_receipt

    require(set(request) == REQUEST_FIELDS | {'operation', 'kind', 'actionId', 'originalReleasePlanSha256',
            'originalReleaseReceiptSha256'} and request['operation'] == SUCCESSOR_OPERATION and
            type(request['kind']) is str and request['kind'] in SUCCESSOR_PREFIXES and
            action_id(request['actionId']) and request['actionId'] != request['releaseId'])
    results, terminal = _read_original_terminal(request)
    directory = results / (SUCCESSOR_PREFIXES[request['kind']] + request['actionId'])
    migrate.private_directory(directory)
    raw = private_record(directory, SUCCESSOR_RECEIPT)
    receipt = exact_receipt(raw)
    require(set(receipt) == SUCCESSOR_FIELDS and receipt['status'] == SUCCESSOR_STATUS and
            all(receipt[key] == request[key] for key in
                (*IDENTITY, 'kind', 'actionId', 'originalReleasePlanSha256', 'originalReleaseReceiptSha256')) and
            all(digest(receipt[key]) for key in SUCCESSOR_PINS) and receipt['targetSha256'] == terminal.get('targetSha256') and
            type(terminal.get('configurationSha256')) is dict and
            receipt['configurationCanonicalSha256'] == migrate.file_hash(
                json.dumps(terminal['configurationSha256'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()) and
            type(receipt['hostMachineId']) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{32}', receipt['hostMachineId']) and
            type(receipt['frontendEpoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', receipt['frontendEpoch']) and
            action_id(receipt['runtimeActionId']) and receipt['runtimeActionId'] != request['releaseId'])
    descriptor = require_certification_replacement_release(receipt['replacementRelease'], PROFILE)
    require(all(descriptor[key] == terminal.get(key) for key in REPLACEMENT_RELEASE_HASHES) and
            (receipt['runtimeActionId'] != request['actionId'] if request['kind'] == 'known-ack' else
             receipt['runtimeActionId'] == request['actionId'] and receipt['terminalSha256'] == receipt['runtimeReceiptSha256']))
    return raw


def read_rotation_successor_evidence(request):
    from p2_identity_key_rotation_parent import SESSION_CLOSED_RECEIPT
    from p2_identity_rotation_successor import MUTATIONS, PHASES, RECEIPT, STATUS, rotation_frontend_successor
    from p2_release_supervisor import ROTATION_LAYOUT
    from p2_replacement_terminal import exact_receipt
    from release import SERVICES
    from p2_identity_key_rotation_adapter import API_SERVICES

    pins = ('originalReleasePlanSha256', 'originalReleaseReceiptSha256')
    identity = (*IDENTITY, 'actionId', 'bindingSha256')
    require(set(request) == REQUEST_FIELDS | {'operation', 'actionId', 'bindingSha256', *pins}
            and request['operation'] == ROTATION_SUCCESSOR_OPERATION
            and type(request['actionId']) is str and re.fullmatch(r'p2-key-rotation-[a-z0-9-]{1,40}', request['actionId'])
            and request['actionId'] != request['releaseId'] and digest(request['bindingSha256']))
    results, original = _read_original_terminal(request)
    directory = results / (ROTATION_LAYOUT['receiptPrefix'] + request['actionId'])
    migrate.private_directory(directory)
    terminal_raw = private_record(directory, ROTATION_LAYOUT['terminalName'])
    closed_raw = private_record(directory, SESSION_CLOSED_RECEIPT)
    raw = private_record(directory, RECEIPT)
    terminal, closed, receipt = map(exact_receipt, (terminal_raw, closed_raw, raw))
    hashes = {'predecessorRuntimeInventorySha256', 'terminalReceiptSha256', 'frontendSessionClosedSha256',
              'configurationSha256', 'currentOnlyRuntimeConfigurationSha256', 'runtimeInventorySha256',
              'gatewayProcessSha256', 'gatewayConfigurationSha256'}
    flags = {'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted', 'g2Accepted'}
    fields = {'version', 'qualificationTargetProfile', 'status', 'kind', *identity, *pins, *hashes, *flags,
              'hostMachineId', 'targetSha256', 'frontendEpoch', 'frontend', 'mutationReceipts', 'phaseRuntimeInventoryReceiptSha256',
              'unchangedOriginalServices', 'currentOnlyRecreatedServices', 'frontendAdmissionClosed', 'gatewayAdmissionClosed'}
    require((set(receipt) == fields or set(receipt) == fields | {'predecessorSuccessorReceiptSha256'} and
             digest(receipt['predecessorSuccessorReceiptSha256'])) and receipt['status'] == STATUS
            and receipt['kind'] == 'identity-key-rotation-mixed-mount-v1'
            and all(receipt[key] == request[key] for key in (*identity, *pins))
            and all(digest(receipt[key]) for key in hashes)
            and receipt['targetSha256'] == original.get('targetSha256')
            and receipt['gatewayConfigurationSha256'] == original.get('configurationSha256', {}).get('gateway.json')
            and type(receipt['hostMachineId']) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{32}', receipt['hostMachineId'])
            and type(receipt['frontendEpoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', receipt['frontendEpoch'])
            and receipt['unchangedOriginalServices'] == [name for name in SERVICES if name not in API_SERVICES]
            and receipt['currentOnlyRecreatedServices'] == list(API_SERVICES)
            and all(receipt[key] is True for key in ('frontendAdmissionClosed', 'gatewayAdmissionClosed'))
            and all(receipt[key] is False for key in flags))
    mutations = receipt['mutationReceipts']
    inventory = receipt['phaseRuntimeInventoryReceiptSha256']
    require(type(mutations) is list and len(mutations) == len(MUTATIONS)
            and all(type(row) is dict and set(row) == {'phase', 'kind', 'attemptReceiptSha256', 'observationReceiptSha256'}
                    and (row['phase'], row['kind']) == phase_kind and digest(row['attemptReceiptSha256'])
                    and digest(row['observationReceiptSha256']) for row, phase_kind in zip(mutations, MUTATIONS))
            and type(inventory) is dict and set(inventory) == set(PHASES) and all(digest(value) for value in inventory.values()))
    require(terminal.get('status') == ROTATION_LAYOUT['terminalStatus'] and terminal.get('keyRemovalVerified') is True
            and all(terminal.get(key) == request[key] for key in identity if key != 'releaseId')
            and terminal.get('frontendFinalEpoch') == receipt['frontendEpoch']
            and terminal.get('configurationSha256') == receipt['configurationSha256']
            and all(terminal.get(key) is False for key in flags)
            and receipt['terminalReceiptSha256'] == migrate.file_hash(terminal_raw)
            and receipt['frontendSessionClosedSha256'] == terminal.get('frontendSessionCloseReceiptSha256') == migrate.file_hash(closed_raw)
            and closed.get('status') == 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED'
            and all(closed.get(key) == request[key] for key in ('environment', 'releaseId', 'sourceCommit'))
            and closed.get('targetSha256') == receipt['targetSha256']
            and closed.get('admission') == {'epoch': receipt['frontendEpoch'], 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
            and all(closed.get(key) is True for key in ('backendAbsent', 'migrationLockReleased', 'nonceLockReleased')))
    require(receipt['frontend'] == rotation_frontend_successor(directory, terminal))
    return raw


def read_rotation_frontend_ready_evidence(request):
    from p2_certification_parent import READY_FILES
    from p2_release_supervisor import ROTATION_LAYOUT
    from p2_replacement_terminal import exact_receipt

    require(digest(request.get('successorReceiptSha256')))
    successor_request = {**request, 'operation': ROTATION_SUCCESSOR_OPERATION}
    successor_digest = successor_request.pop('successorReceiptSha256')
    successor_raw = read_rotation_successor_evidence(successor_request)
    require(migrate.file_hash(successor_raw) == successor_digest)
    expected = exact_receipt(successor_raw)['frontend']['readyReceiptSha256']
    directory = Path(request['results']) / (ROTATION_LAYOUT['receiptPrefix'] + request['actionId']) / 'frontend-current-only'
    require(directory == directory.resolve())
    migrate.private_directory(directory)
    records = {}
    for name in READY_FILES:
        raw = private_record(directory, name)
        require(migrate.file_hash(raw) == expected[name])
        records[name] = base64.b64encode(raw).decode('ascii')
    return json.dumps(records, separators=(',', ':')).encode()


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8193)
        require(len(sys.argv) == 1 and os.geteuid() == 0 and 0 < len(raw) <= 8192)
        request = decode_qualification_target_json(raw, 'private-packet')
        commit = request.get('operatorSourceCommit', request['sourceCommit'])
        require(migrate.source_commit(commit) and Path(__file__).resolve().parents[3] == Path('/opt/lash-her/operators') / commit)
        print(json.dumps({'bytes': base64.b64encode(read_replacement_evidence(request)).decode('ascii')}))
    except BaseException:
        print(REFUSED, file=sys.stderr)
        raise SystemExit(1)
