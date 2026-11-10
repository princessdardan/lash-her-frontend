"""Read only the fixed replacement release receipts for the exact host action."""

import base64
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
from p2_frontend_replacement_parent import PROFILE, private_record
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
OUTCOME_PREFIXES = {
    'migration-outcome.json': 'migration-profiled-frontend-replacement-',
    'runtime-outcome.json': 'runtime-profiled-frontend-replacement-',
}
SUCCESSOR_OPERATION = 'read-successor-runtime'
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
    if 'operation' in request:
        return read_successor_runtime_evidence(request)
    require(set(request) == REQUEST_FIELDS | {'reviewedPlanSha256', 'name'})
    release, name = request['releaseId'], request['name']
    require(type(name) is str and name in ACTION_NAMES | OUTCOME_PREFIXES.keys())
    results, action = read_reviewed_action(request, request['reviewedPlanSha256'])
    directory = results / (OUTCOME_PREFIXES[name] + release) if name in OUTCOME_PREFIXES else action
    migrate.private_directory(directory)
    raw = private_record(directory, name, 2_000_000 if name in OUTCOME_PREFIXES else 65_536)
    require(raw.endswith(b'\n'))
    return raw


def read_successor_runtime_evidence(request):
    from p2_certification_parent import REPLACEMENT_RELEASE_HASHES, require_certification_replacement_release
    from p2_replacement_terminal import TERMINAL, TERMINAL_STATUS, exact_receipt

    require(set(request) == REQUEST_FIELDS | {'operation', 'kind', 'actionId', 'originalReleasePlanSha256',
            'originalReleaseReceiptSha256'} and request['operation'] == SUCCESSOR_OPERATION and
            type(request['kind']) is str and request['kind'] in SUCCESSOR_PREFIXES and
            action_id(request['actionId']) and request['actionId'] != request['releaseId'] and
            digest(request['originalReleaseReceiptSha256']))
    results, original = read_reviewed_action(request, request['originalReleasePlanSha256'])
    terminal_raw = private_record(original, TERMINAL)
    require(migrate.file_hash(terminal_raw) == request['originalReleaseReceiptSha256'])
    terminal = exact_receipt(terminal_raw)
    require(terminal.get('status') == TERMINAL_STATUS and terminal.get('frontendSqlApplied') is True and
            terminal.get('frontendSqlReplayed') is False and terminal.get('frontendSessionClosed') is True and
            terminal.get('trafficAuthorized') is False and terminal.get('releaseAccepted') is False and
            terminal.get('reviewedPlanSha256') == request['originalReleasePlanSha256'] and
            all(terminal.get(key) == request[key] for key in IDENTITY))
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


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8193)
        require(len(sys.argv) == 1 and os.geteuid() == 0 and 0 < len(raw) <= 8192)
        request = decode_qualification_target_json(raw, 'private-packet')
        require(Path(__file__).resolve().parents[3] == Path('/opt/lash-her/operators') / request['sourceCommit'])
        print(json.dumps({'bytes': base64.b64encode(read_replacement_evidence(request)).decode('ascii')}))
    except BaseException:
        print(REFUSED, file=sys.stderr)
        raise SystemExit(1)
