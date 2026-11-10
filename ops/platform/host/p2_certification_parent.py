#!/usr/bin/env python3
"""Fixed bounded certification broker and independent native containment.

No SQL executor, role preparation, deployment or runtime replacement is exposed.
"""
import base64
import fcntl
import copy
from contextlib import nullcontext
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time

_current_module=sys.modules[__name__]
_canonical_module=sys.modules.get('p2_certification_parent')
if _canonical_module is not None and _canonical_module is not _current_module:
    raise ValueError('P2_CERTIFICATION_CANONICAL_MODULE_REFUSED')
sys.modules['p2_certification_parent']=_current_module

sys.path.insert(0,str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_admission
import staging_state
import vercel
import frontend_probe
from frontend_release_adapters import LockedClient,LockedProbe
import p2_lifecycle_native as native
from p2_release_broker import Broker,PhysicalObserver,LOCK,MAXIMUM,decode
from p2_release_scope import P2ReleaseScope
from p2_source_closure import PROFILED_INTERRUPTED_MODE,private_observer_program,verify_profiled_current_source_closure,verify_source_closure
from p2_certification_profile import require_profile as require_certification_profile
from p2_certification_fault import P2CertificationFaultStage,GATEWAY_OBSERVER,frontend_target_sha256
import p2_identity_negative_probe as identity_probe
from p2_lifecycle_suspension_evidence import P2LifecycleSuspensionEvidenceStage
import p2_canonical_browser_origin as canonical_browser
from p2_lifecycle_worker_evidence import P2LifecycleWorkerEvidenceStage

require=migrate.demand
CORE='ops/platform/p2-recovery-current-probe.mjs'
OBSERVER='ops/platform/p2-certification-current-probe.mjs'
API_CHECKER='ops/platform/host/database_current.mjs'
PRIVATE_ROOT=Path('/run/lash-her-p2-certification-private')
_core=None


def _sha(raw):return hashlib.sha256(raw).hexdigest()
def _canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()


PROFILED_CERTIFICATION_MODE = 'p2-bounded-certification-profiled-current'
PROFILED_RELEASE_ROOT = Path('/var/lib/lash-her/releases/staging')
PROFILED_OPERATOR_ROOT = Path('/opt/lash-her/operators')
PROFILED_MACHINE_ID = Path('/etc/machine-id')
PROFILED_INITIAL_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'mode', 'environment', 'sourceCommit', 'sourceSha256',
    'sourceClosureSha256', 'hostMachineId', 'bundle', 'configuration', 'results', 'candidate',
    'candidateSha256', 'configurationSha256', 'apiJobSha256', 'frontendJob', 'frontendBaseline',
    'targetSha256', 'owner', 'inventory', 'inventorySha256', 'certification', 'expectedWriterAdmissionBinding',
    'certificationActionId', 'certificationPlan', 'originalReleaseReceipt', 'readyReceipts',
))
READY_FILES = (
    'frontend-build-started.json', 'frontend-build-created.json', 'frontend-build-outcome.json',
    'frontend-workload-outcome.json', 'frontend-promotion-started.json', 'frontend-promotion-outcome.json',
)
PROFILED_PLAN_FALSE = (
    'frontendSqlReplay', 'apiSqlReplay', 'rolePreparationAllowed', 'historicalLoginRestorationAllowed',
    'buildAllowed', 'promotionAllowed', 'wholeReleaseAccepted',
)
PROFILED_PLAN_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'environment', 'certificationActionId', 'originalReleaseId',
    'sourceCommit', 'operatorSourceCommit', 'candidateSha256', 'candidateObjectSha256', 'inventorySha256',
    'configurationSha256', 'targetSha256', 'mode', 'startState', 'initialEpoch', 'browserPlanSha256',
    'workerPlan', 'workerPlanSha256', 'configurationCanonicalSha256', 'runtimeInventorySha256',
    'gatewayProcessSha256', 'gatewayConfigurationSha256', 'operatorSourceClosureSha256', 'contractPhase',
    'phase2ContractManifestSha256', 'nativePlan', 'persistenceReaderEligible', 'requestEvidenceDescriptorSha256',
    'faultSelection', 'readyReceiptSha256', 'maximumSeconds', 'finalDisposition', 'planSha256',
    'apiJobSha256', 'originalReleaseReceiptSha256', 'originalReleasePlanSha256', *PROFILED_PLAN_FALSE,
))
BROWSER_MODES = frozenset(('auth-preparation', 'browser-pending'))
SUSPENSION_MODES = BROWSER_MODES | {'direct-worker'}
PERSISTENCE_MODES = frozenset(('export-cleanup', 'lifecycle-persistence'))
SCOPED_MODES = PERSISTENCE_MODES | {'mux-callback-recovery', 'interactive-browser'}
# Exact Course source with signed, managed-only callback processing.
SCOPED_MUX_COURSE_SOURCE = 'b21e25cf900458eb6cbbd993582d7e1bbac36c4b'
PAID_REVOKE_COURSE_SOURCE = '54fd289a5a8579bfbe343afb07482f406b56ad5b'
MERGED_COURSE_RUNTIME_SOURCE = '09e3aaf234d9d9c1296c438d7c872e6bd67db074'
PAID_REVOKE_COURSE_SOURCES = frozenset((PAID_REVOKE_COURSE_SOURCE, MERGED_COURSE_RUNTIME_SOURCE))
PROFILED_MODES = SUSPENSION_MODES | SCOPED_MODES | {'native-window', 'fault-before-upstream', 'fault-drop-after-ack',
                                    'known-ack-recovery', 'contain-native'}
NATIVE_PLAN_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'environment', 'actionId', 'projectId', 'sourceCommit',
    'candidateSha256', 'phase2ContractManifestSha256', 'sourcePolicy', 'deploymentId', 'deploymentUrl',
    'configurationRecordSha256', 'featureControls', 'targetSha256', 'target', 'owner', 'producer',
    'initialEpoch', 'schedule', 'windowSeconds', 'drainSeconds', 'commandWitnesses', 'writerAdmissionBinding',
    'finalDisposition', 'providerQueuedInventory', 'automaticReplayAllowed', 'migrationAuthorized',
    'wholeReleaseAccepted', 'planSha256',
))
BROWSER_CONTROL_FIELDS = (NATIVE_PLAN_FIELDS - {
    'sourcePolicy', 'windowSeconds', 'drainSeconds', 'providerQueuedInventory',
    'automaticReplayAllowed', 'migrationAuthorized', 'wholeReleaseAccepted',
}) | {'purpose'}
SUSPENSION_PLAN_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'status', 'environment', 'profile', 'actionId', 'releaseId',
    'candidateSha256', 'candidateObjectSha256', 'sourceCommit', 'operatorSourceCommit', 'operatorSourceEligibility',
    'configurationSha256', 'configurationRecordSha256', 'resourceBindingSha256', 'targetSha256', 'hostMachineId',
    'deploymentId', 'deploymentUrl', 'browserOrigin', 'featureControls', 'writerAdmissionBinding',
    'browserProgramSha256', 'pendingProgramSha256', 'parentProgramSha256', 'hostProgramSha256',
    'windowSeconds', 'drainSeconds', 'initialAdmission', 'finalDisposition', 'fixtureCreationAuthorized',
    'workerInvocationAuthorized', 'automaticReplayAllowed', 'releaseAccepted',
))
WORKER_PLAN_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'environment', 'profile', 'actionId', 'candidateSha256',
    'candidateObjectSha256', 'sourceCommit', 'configurationSha256', 'nativePlanSha256', 'suspensionPlanSha256',
    'targetSha256', 'commandIndex', 'pendingRecordSha256', 'canonicalCommandSha256', 'gatewayProcessSha256',
    'gatewayConfigurationSha256', 'denialProgramSha256', 'sourceProgramSha256', 'hostProgramSha256',
    'denialSourceSha256', 'workerInvocations', 'requiredPrivateInputs', 'invocationClass', 'nativeInvocationQualified',
    'automaticRetryAllowed', 'finalDisposition', 'releaseAccepted',
))
NATIVE_TARGET_FIELDS = frozenset(('host', 'port', 'database', 'user', 'serverMajor', 'qualificationTargetProfile'))
RECEIPT_IDENTITY_FIELDS = frozenset(('version', 'qualificationTargetProfile', 'environment', 'releaseId',
                                    'sourceCommit', 'projectId', 'previousDeploymentId'))
READY_RECEIPT_FIELDS = (
    {'trafficAuthorized', 'promotionAuthorized'},
    {'trafficAuthorized', 'promotionAuthorized', 'deploymentId'},
    {'trafficAuthorized', 'promotionAuthorized', 'deploymentId', 'status', 'phase', 'url', 'readyState'},
    {'deploymentId', 'status', 'phase', 'trafficAuthorized', 'nativeSchedulerVerified', 'checks',
     'contractPhase', 'phase2ContractManifestSha256', 'featureControls', 'writerAdmissionBinding'},
    {'deploymentId', 'previousAliasRequestedAt'},
    {'deploymentId', 'previousAliasRequestedAt', 'status', 'phase', 'trafficAuthorized', 'gatewayTrafficAuthorized',
     'frontendDomainsPromoted', 'aliasRequestedAt'},
)
TERMINAL_HASH_FIELDS = frozenset((
    'frontendDatabaseReceiptSha256', 'frontendTerminalSha256', 'frontendContinuationCompletedSha256',
    'frontendReleaseOutcomeSha256', 'frontendSessionClosedSha256', 'frontendWorkloadReceiptSha256',
    'apiRuntimeReceiptSha256', 'migrationOutcomeSha256',
))
TERMINAL_FALSE_FIELDS = (
    'frontendSqlApplied', 'historicalProviderClosureClaimed', 'oldP200Qualified',
    'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted',
)
REPLACEMENT_RELEASE_FIELDS = frozenset((
    'version', 'kind', 'qualificationTargetProfile', 'reviewedPlanSha256', 'runtimeReviewSha256', 'postflightSha256',
    'frontendSessionClosedSha256', 'frontendDatabaseReceiptSha256', 'databaseOid', 'migrationRoleOid',
    'predecessorRuntimeRole', 'administrativeLogins',
))
REPLACEMENT_RELEASE_HASHES = ('reviewedPlanSha256', 'runtimeReviewSha256', 'postflightSha256',
                              'frontendSessionClosedSha256', 'frontendDatabaseReceiptSha256')
REPLACEMENT_PROOF_FIELDS = frozenset(('replacementRelease', 'effectiveLoginBoundaryVerified', 'predecessorRuntimeRoleAbsent'))
REPLACEMENT_LINEAGE_FIELDS = ('replacementRelease', 'originalReleaseReceiptSha256', 'originalReleasePlanSha256')
HISTORICAL_PROOF_FIELDS = frozenset(('retiredLogins', 'oldLoginsDenied', 'oldRoleSessions'))


def _profiled_digest(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) is not None and value != '0' * 64


def _profiled_compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def _profiled_plan_hash(plan):
    return _sha(_canonical({key: value for key, value in plan.items() if key != 'planSha256'}))


def _profiled_context():
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    return migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)


def require_certification_replacement_release(value, expected):
    from p2_frontend_replacement_parent import oid
    require(type(value) is dict and set(value) == REPLACEMENT_RELEASE_FIELDS and
            type(value['version']) is int and value['version'] == 1 and value['kind'] == 'frontend-replacement' and
            all(_profiled_digest(value[key]) for key in REPLACEMENT_RELEASE_HASHES) and
            oid(value['databaseOid']) and oid(value['migrationRoleOid']) and
            type(value['predecessorRuntimeRole']) is str and
            re.fullmatch(r'[a-z][a-z0-9_]{0,62}', value['predecessorRuntimeRole']) and
            type(value['administrativeLogins']) is list and len(value['administrativeLogins']) <= 32 and all(
                type(row) is dict and set(row) == {'name', 'oid'} and type(row['name']) is str and
                re.fullmatch(r'[a-z][a-z0-9_]{0,62}', row['name']) and oid(row['oid'])
                for row in value['administrativeLogins']), 'P2_PROFILED_CERTIFICATION_REPLACEMENT_RELEASE_REQUIRED')
    admins = value['administrativeLogins']
    require([row['name'] for row in admins] == sorted({row['name'] for row in admins}) and
            len({row['oid'] for row in admins}) == len(admins) and
            value['migrationRoleOid'] not in {row['oid'] for row in admins},
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_RELEASE_REQUIRED')
    migrate.require_profile(expected, value)
    return value


def require_certification_replacement_proof(value, replacement):
    require(type(value) is dict and not (HISTORICAL_PROOF_FIELDS & set(value)) and
            _canonical(value.get('replacementRelease')) == _canonical(replacement) and
            value.get('effectiveLoginBoundaryVerified') is True and value.get('predecessorRuntimeRoleAbsent') is True,
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_BOUNDARY_REQUIRED')


def require_certification_replacement_lineage(plan, *records):
    if 'replacementRelease' in plan:
        require(all(key in plan for key in REPLACEMENT_LINEAGE_FIELDS) and
                all(type(record) is dict and all(_canonical(record.get(key)) == _canonical(plan[key]) for key in REPLACEMENT_LINEAGE_FIELDS)
                    for record in records), 'P2_PROFILED_CERTIFICATION_REPLACEMENT_LINEAGE_CHANGED')
    else:
        require(all('replacementRelease' not in record for record in records),
                'P2_PROFILED_CERTIFICATION_REPLACEMENT_LINEAGE_CHANGED')


def _profiled_record(raw, expected):
    from qualification_target_profile import decode_qualification_target_json
    record = decode_qualification_target_json(raw, 'carrier')
    require(type(record) is dict, 'P2_PROFILED_CERTIFICATION_RECEIPT_REQUIRED')
    vercel.require_record_profile(expected, record)
    return record


def _profiled_wire_receipt(encoded, digest, expected):
    require(type(encoded) is str and 0 < len(encoded) <= 87_384 and _profiled_digest(digest),
            'P2_PROFILED_CERTIFICATION_RECEIPT_REQUIRED')
    raw = base64.b64decode(encoded, validate=True)
    require(0 < len(raw) <= 65_536 and base64.b64encode(raw).decode() == encoded and _sha(raw) == digest,
            'P2_PROFILED_CERTIFICATION_RECEIPT_BYTES_CHANGED')
    return _profiled_record(raw, expected)


def _profiled_host_receipt(directory, name, expected):
    migrate.private_directory(directory)
    require(directory == directory.resolve(), 'P2_PROFILED_CERTIFICATION_ORIGINAL_DIRECTORY_REQUIRED')
    descriptor = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and
                stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= 65_536,
                'P2_PROFILED_CERTIFICATION_ORIGINAL_RECEIPT_REQUIRED')
        raw = stream.read(65_537)
        after = os.fstat(stream.fileno())
        require(len(raw) == before.st_size and before.st_size == after.st_size and
                before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns,
                'P2_PROFILED_CERTIFICATION_ORIGINAL_RECEIPT_CHANGED')
    return _profiled_record(raw, expected), _sha(raw)


def _profiled_initial(initial, expected):
    require(type(initial) is dict and
            type(initial.get('version')) is int and initial['version'] == 2 and initial['environment'] == 'staging' and
            initial['mode'] == PROFILED_CERTIFICATION_MODE and migrate.source_commit(initial['sourceCommit']) and
            type(initial['certificationActionId']) is str and
            re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', initial['certificationActionId']) and
            type(initial['hostMachineId']) is str and re.fullmatch(r'[a-f0-9]{32}', initial['hostMachineId']) and
            initial['hostMachineId'] != '0' * 32 and
            all(_profiled_digest(initial[key]) for key in ('sourceClosureSha256', 'candidateSha256', 'targetSha256', 'inventorySha256')),
            'P2_PROFILED_CERTIFICATION_INITIAL_REQUIRED')
    vercel.require_record_profile(expected, initial)
    hashes, api = initial['configurationSha256'], initial['apiJobSha256']
    require(type(hashes) is dict and set(hashes) == set(staging_state.CONFIGURATION_FILES) and
            type(api) is dict and set(api) == {'course', 'community'} and
            all(_profiled_digest(value) for value in (*hashes.values(), *api.values())),
            'P2_PROFILED_CERTIFICATION_INPUT_PINS_REQUIRED')
    plan = initial['certificationPlan']
    require(type(plan) is dict and type(plan.get('mode')) is str and plan['mode'] in PROFILED_MODES,
            'P2_PROFILED_CERTIFICATION_PLAN_REQUIRED')
    mode = plan['mode']
    maximum_seconds = 300 if mode == 'auth-preparation' or mode in SCOPED_MODES else 900
    extra = set()
    if mode == 'known-ack-recovery':
        extra = {'knownAckRecovery', 'knownAckReceiverTargets', 'knownAckConfigurationInputDirectory'}
    if mode in SCOPED_MODES:
        extra = {'scopedAction'}
        _require_profiled_scoped_action(mode, plan)
        if mode == 'interactive-browser':
            from p2_interactive_window import stalled_renewal_selected
            if stalled_renewal_selected(plan):
                maximum_seconds = 900
    if mode in PERSISTENCE_MODES:
        extra.add('persistenceReviewedSha256')
        require(_profiled_digest(plan.get('persistenceReviewedSha256')), 'P2_PROFILED_PERSISTENCE_REVIEW_REQUIRED')
    if 'replacementRelease' in plan:
        replacement = require_certification_replacement_release(plan['replacementRelease'], expected)
        inventory = initial['inventory']
        require(type(inventory) is dict and 'historicalLogins' not in inventory and
                _canonical(inventory.get('replacementRelease')) == _canonical(replacement) and
                plan.get('originalReleasePlanSha256') == replacement['reviewedPlanSha256'],
                'P2_PROFILED_CERTIFICATION_REPLACEMENT_RELEASE_REQUIRED')
        extra.add('replacementRelease')
        if 'successorRuntime' in plan:
            require(mode != 'known-ack-recovery', 'P2_PROFILED_CERTIFICATION_SUCCESSOR_MODE_REFUSED')
            extra.add('successorRuntime')
    else:
        require(type(initial['inventory']) is dict and 'replacementRelease' not in initial['inventory'],
                'P2_PROFILED_CERTIFICATION_REPLACEMENT_RELEASE_REQUIRED')
    require(set(initial) == PROFILED_INITIAL_FIELDS | ({'sourceSuspensionPlan'} if mode in SUSPENSION_MODES else set()) and
            set(plan) == PROFILED_PLAN_FIELDS | extra and plan['startState'] == 'already-closed' and
            plan['environment'] == 'staging' and plan['certificationActionId'] == initial['certificationActionId'] and
            plan['sourceCommit'] == plan['operatorSourceCommit'] == initial['sourceCommit'] and
            all(plan[key] == initial[key] for key in ('candidateSha256', 'inventorySha256', 'targetSha256', 'apiJobSha256')) and
            plan['operatorSourceClosureSha256'] == initial['sourceClosureSha256'] and
            plan['configurationSha256'] == _sha(_profiled_compact(hashes)) and
            plan['configurationCanonicalSha256'] == _sha(_canonical(hashes)) and
            plan['gatewayConfigurationSha256'] == hashes['gateway.json'] and
            all(_profiled_digest(plan[key]) for key in ('candidateObjectSha256', 'runtimeInventorySha256', 'gatewayProcessSha256',
                'originalReleasePlanSha256', 'originalReleaseReceiptSha256')) and
            type(plan['initialEpoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', plan['initialEpoch']) and
            type(plan['maximumSeconds']) is int and plan['maximumSeconds'] == maximum_seconds and
            (_profiled_digest(plan['browserPlanSha256']) if mode in BROWSER_MODES else plan['browserPlanSha256'] is None) and
            (type(plan['workerPlan']) is dict and _profiled_digest(plan['workerPlanSha256'])
             if mode == 'direct-worker' else plan['workerPlan'] is None and plan['workerPlanSha256'] is None) and
            plan['finalDisposition'] == 'native-disabled-and-both-admissions-closed' and
            plan['persistenceReaderEligible'] is True and all(plan[key] is False for key in PROFILED_PLAN_FALSE) and
            plan['planSha256'] == _profiled_plan_hash(plan),
            'P2_PROFILED_CERTIFICATION_PLAN_BINDING_REQUIRED')
    if mode == 'interactive-browser':
        require(len(str(int(plan['initialEpoch']) + 2)) <= 18, 'P2_INTERACTIVE_FRONTEND_EPOCH_BOUNDS_REQUIRED')
    native_plan = plan['nativePlan']
    vercel.require_record_profile(expected, plan, native_plan)
    migrate.require_profile(expected, native_plan.get('target'))
    control_only = mode in BROWSER_MODES or mode in SCOPED_MODES
    require(set(native_plan) == (BROWSER_CONTROL_FIELDS if control_only else NATIVE_PLAN_FIELDS) and
            set(native_plan['target']) == NATIVE_TARGET_FIELDS and
            native_plan['planSha256'] == _profiled_plan_hash(native_plan) and
            native_plan['candidateSha256'] == plan['candidateObjectSha256'] and
            native_plan['schedule'] == {'path': native.PATH, 'schedule': native.SCHEDULE} and
            native_plan['finalDisposition'] == 'disabled-and-admission-closed' and
            type(native_plan['initialEpoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', native_plan['initialEpoch']),
            'P2_PROFILED_CERTIFICATION_NATIVE_PLAN_REQUIRED')
    if control_only:
        purpose = 'scoped-certification-control-only' if mode in SCOPED_MODES else 'browser-authentication-control-only'
        require(native_plan['purpose'] == purpose and native_plan['commandWitnesses'] == [] and
                native_plan['initialEpoch'] == plan['initialEpoch'], 'P2_PROFILED_CERTIFICATION_BROWSER_CONTROL_REQUIRED')
    else:
        require(native_plan['providerQueuedInventory'] is None and
                all(native_plan[key] is False for key in ('automaticReplayAllowed', 'migrationAuthorized', 'wholeReleaseAccepted')) and
                (mode == 'contain-native' or native_plan['initialEpoch'] == str(int(plan['initialEpoch']) + 1)) and
                type(native_plan['windowSeconds']) is int and 60 <= native_plan['windowSeconds'] <= 180 and
                type(native_plan['drainSeconds']) is int and 1 <= native_plan['drainSeconds'] <= 180,
                'P2_PROFILED_CERTIFICATION_NATIVE_CONTROL_REQUIRED')
    if mode in ('fault-before-upstream', 'known-ack-recovery'):
        fault = plan['faultSelection']
        require(type(fault) is dict and set(fault) == {'stageId','receiver','commandIndex','commandSha256'} and
                type(fault['stageId']) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', fault['stageId']) and
                fault['receiver'] in ('course','community') and type(fault['commandIndex']) is int and fault['commandIndex'] == 0 and
                _profiled_digest(fault['commandSha256']) and len(native_plan['commandWitnesses']) == 1 and
                _profiled_digest(plan['requestEvidenceDescriptorSha256']), 'P2_PROFILED_CERTIFICATION_FAULT_SELECTION_REQUIRED')
    if mode == 'known-ack-recovery':
        _profiled_known_ack_selection(plan, initial['configuration'], expected)
    require(type(initial['readyReceipts']) is dict and set(initial['readyReceipts']) == set(READY_FILES) and
            type(plan['readyReceiptSha256']) is dict and set(plan['readyReceiptSha256']) == set(READY_FILES),
            'P2_PROFILED_CERTIFICATION_READY_RECEIPTS_REQUIRED')
    return plan


def _require_profiled_scoped_action(mode, plan):
    value = plan.get("scopedAction")
    uuid_pattern = r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
    def matches(pattern, text):
        return type(text) is str and re.fullmatch(pattern, text) is not None

    if mode == 'interactive-browser':
        from p2_interactive_window import validate_interactive_plan_action
        validate_interactive_plan_action(plan)
        return

    if mode == 'export-cleanup':
        require(type(value) is dict and set(value) == {'commandId', 'readyRecordSha256'} and
                matches(uuid_pattern, value['commandId']) and _profiled_digest(value['readyRecordSha256']),
                'P2_PROFILED_SCOPED_EXPORT_SELECTION_REQUIRED')
        return
    if mode == 'lifecycle-persistence':
        require(type(value) is dict and set(value) == {'stage', 'subjectBindingSha256'} and
                type(value['stage']) is str and value['stage'] in ('capture-export-ready', 'capture-delete-baseline', 'verify-delete') and
                _profiled_digest(value['subjectBindingSha256']), 'P2_PROFILED_SCOPED_PERSISTENCE_SELECTION_REQUIRED')
        return
    provider_pattern = r'[A-Za-z0-9_-]{1,255}'
    asset_events = {'video.asset.created', 'video.asset.ready', 'video.asset.errored', 'video.asset.deleted'}
    track_events = {'video.asset.track.ready', 'video.asset.track.deleted'}
    require(mode == 'mux-callback-recovery' and type(value) is dict and
            set(value) == {'attemptId', 'generation', 'environmentId', 'assetId', 'uploadId', 'eventType'} and
            matches(uuid_pattern, value['attemptId']) and type(value['generation']) is int and
            1 <= value['generation'] <= 2_147_483_647 and matches(provider_pattern, value['environmentId']) and
            all(value[key] is None or matches(provider_pattern, value[key]) for key in ('assetId', 'uploadId')) and
            type(value['eventType']) is str and (value['eventType'] in asset_events or
                value['eventType'] in track_events and value['assetId'] is not None or
                value['eventType'] == 'video.upload.asset_created' and value['uploadId'] is not None),
            'P2_PROFILED_SCOPED_MUX_SELECTION_REQUIRED')


def _profiled_known_ack_selection(plan, mounted, expected):
    from p2_known_ack_loss import replacement_intent
    selection, targets = plan['knownAckRecovery'], plan['knownAckReceiverTargets']
    require(type(selection) is dict and set(selection) == {'version','qualificationTargetProfile','recoveryActionId','intent','intentSha256'},
            'P2_PROFILED_KNOWN_ACK_SELECTION_REQUIRED')
    vercel.require_record_profile(expected, selection, selection['intent'])
    require_certification_replacement_lineage(plan, selection['intent'])
    action = selection['recoveryActionId']
    path = plan['knownAckConfigurationInputDirectory']
    require(type(action) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', action) and
            action not in (plan['certificationActionId'], plan['originalReleaseId'], plan['faultSelection']['stageId']) and
            type(path) is str and path == str(Path(path)) and PROFILED_RELEASE_ROOT in Path(path).parents and '..' not in Path(path).parts and
            ',' not in path and path != mounted and plan['nativePlan']['commandWitnesses'][0].get('action') == 'suspend',
            'P2_PROFILED_KNOWN_ACK_SELECTION_REQUIRED')
    require(type(targets) is dict and set(targets) == {'course','community'} and all(
            type(target) is dict and set(target) == {'host','port','database','user','serverMajor','roleOid'} and
            type(target['host']) is str and 0 < len(target['host']) <= 253 and
            type(target['port']) is int and 0 < target['port'] <= 65535 and
            all(type(target[key]) is str and re.fullmatch(r'[a-z][a-z0-9_]{0,62}', target[key]) for key in ('database','user')) and
            type(target['serverMajor']) is int and target['serverMajor'] in (16,18) and
            type(target['roleOid']) is str and re.fullmatch(r'[1-9][0-9]{0,9}', target['roleOid']) for target in targets.values()),
            'P2_PROFILED_KNOWN_ACK_RECEIVER_TARGETS_REQUIRED')
    require(selection['intent'] == replacement_intent(plan, action, expected_profile=expected) and
            selection['intentSha256'] == _sha(_canonical(selection['intent'])), 'P2_PROFILED_KNOWN_ACK_INTENT_CHANGED')


def _profiled_suspension_plan(initial, plan, expected):
    mode = plan['mode']
    if mode not in SUSPENSION_MODES:
        return
    suspension = initial['sourceSuspensionPlan']
    native_plan = plan['nativePlan']
    vercel.require_record_profile(expected, suspension)
    require(set(suspension) == SUSPENSION_PLAN_FIELDS and
            suspension.get('environment') == 'staging' and suspension.get('status') == 'P2_LIFECYCLE_SUSPENSION_SOURCE_PLAN' and
            suspension.get('profile') == 'normal-ui-suspension-pending-v1' and
            suspension.get('releaseId') == plan['originalReleaseId'] and
            suspension.get('operatorSourceCommit') == plan['operatorSourceCommit'] and
            suspension.get('configurationSha256') == plan['configurationCanonicalSha256'] and
            suspension.get('hostMachineId') == initial['hostMachineId'] and suspension['browserOrigin'] == canonical_browser.ORIGIN and
            suspension['windowSeconds'] == 840 and type(suspension['drainSeconds']) is int and 1 <= suspension['drainSeconds'] <= 180 and
            all(_profiled_digest(suspension[key]) for key in ('resourceBindingSha256', 'browserProgramSha256')) and
            all(suspension[key] == initial['sourceSha256'].get(path) for key, path in (
                ('pendingProgramSha256', 'ops/platform/p2-lifecycle-pending-probe.mjs'),
                ('parentProgramSha256', 'ops/platform/p2-lifecycle-suspension-evidence.mjs'),
                ('hostProgramSha256', 'ops/platform/host/p2_lifecycle_suspension_evidence.py'))) and
            type(suspension.get('actionId')) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', suspension['actionId']) and
            all(suspension.get(key) == plan[key] for key in ('candidateSha256', 'candidateObjectSha256', 'sourceCommit', 'targetSha256')) and
            all(suspension.get(key) == native_plan[key] for key in ('deploymentId', 'deploymentUrl', 'configurationRecordSha256', 'writerAdmissionBinding', 'featureControls')) and
            suspension.get('initialAdmission') == {'newWork': True, 'recovery': False} and
            suspension.get('finalDisposition') == 'native-off-and-admission-closed' and
            all(suspension.get(key) is False for key in ('fixtureCreationAuthorized', 'workerInvocationAuthorized', 'automaticReplayAllowed', 'releaseAccepted')),
            'P2_PROFILED_CERTIFICATION_SOURCE_SUSPENSION_REQUIRED')
    suspension_hash = _sha(_canonical(suspension))
    if mode in BROWSER_MODES:
        require(suspension_hash == plan['browserPlanSha256'] and
                (suspension['actionId'] == plan['certificationActionId']) == (mode == 'browser-pending'),
                'P2_PROFILED_CERTIFICATION_BROWSER_SUSPENSION_CHANGED')
        return
    worker = plan['workerPlan']
    vercel.require_record_profile(expected, worker)
    require(set(worker) == WORKER_PLAN_FIELDS and worker.get('environment') == 'staging' and
            plan['workerPlanSha256'] == _sha(_canonical(worker)) and worker.get('suspensionPlanSha256') == suspension_hash and
            worker.get('actionId') == plan['certificationActionId'] != suspension['actionId'] and
            worker.get('profile') == 'direct-known-suspension-v1' and worker.get('nativePlanSha256') == native_plan['planSha256'] and
            worker.get('configurationSha256') == plan['configurationCanonicalSha256'] and
            all(worker.get(key) == plan[key] for key in ('candidateSha256', 'candidateObjectSha256', 'sourceCommit', 'targetSha256',
                'gatewayProcessSha256', 'gatewayConfigurationSha256')) and
            len(native_plan['commandWitnesses']) == 1 and native_plan['commandWitnesses'][0].get('action') == 'suspend' and
            worker.get('commandIndex') == 0 and worker.get('workerInvocations') == 1 and
            worker['invocationClass'] == 'direct-source-authenticated-cron' and
            worker['requiredPrivateInputs'] == ['FRONTEND_STAGING_CRON_SECRET', 'providerContext.frontendRuntimeDatabaseUrl'] and
            worker['finalDisposition'] == 'native-off-and-admission-closed' and
            all(_profiled_digest(worker[key]) for key in ('pendingRecordSha256', 'canonicalCommandSha256', 'denialProgramSha256')) and
            all(worker[key] == initial['sourceSha256'].get(path) for key, path in (
                ('sourceProgramSha256', 'ops/platform/p2-lifecycle-worker-evidence.mjs'),
                ('hostProgramSha256', 'ops/platform/host/p2_lifecycle_worker_evidence.py'),
                ('denialSourceSha256', 'ops/platform/p2-lifecycle-receiver-denial.mjs'))) and
            all(worker.get(key) is False for key in ('automaticRetryAllowed', 'nativeInvocationQualified', 'releaseAccepted')),
            'P2_PROFILED_CERTIFICATION_SOURCE_WORKER_REQUIRED')


def _profiled_ready_receipts(initial, plan, selected, expected):
    receipts = [_profiled_wire_receipt(initial['readyReceipts'][name], plan['readyReceiptSha256'][name], expected)
                for name in READY_FILES]
    require(all(set(row) == RECEIPT_IDENTITY_FIELDS | fields for row, fields in zip(receipts, READY_RECEIPT_FIELDS)),
            'P2_PROFILED_CERTIFICATION_READY_RECEIPT_FIELDS_REQUIRED')
    started, _created, staged, workload, promote_started, promoted = receipts
    native_plan = plan['nativePlan']
    identity = {'environment': 'staging', 'releaseId': selected['releaseId'], 'sourceCommit': initial['sourceCommit'],
                'projectId': selected['workload']['projectId'], 'previousDeploymentId': started.get('previousDeploymentId')}
    deployment, previous = native_plan.get('deploymentId'), identity['previousDeploymentId']
    require(type(deployment) is str and re.fullmatch(r'dpl_[A-Za-z0-9]+', deployment) and deployment != previous and
            (previous is None or type(previous) is str and re.fullmatch(r'dpl_[A-Za-z0-9]+', previous)) and
            all(all(key in row and row[key] == value for key, value in identity.items()) for row in receipts) and
            all(row.get('deploymentId') == deployment for row in receipts[1:]) and 'deploymentId' not in started and
            all(row.get('trafficAuthorized') is False and row.get('promotionAuthorized') is False for row in receipts[:3]) and
            staged.get('status') == 'FRONTEND_STAGED' and staged.get('phase') == 'completed' and staged.get('readyState') == 'READY' and
            type(staged.get('url')) is str and re.fullmatch(r'https://[a-z0-9][a-z0-9-]*\.vercel\.app', staged['url']) and
            staged['url'] == native_plan.get('deploymentUrl'),
            'P2_PROFILED_CERTIFICATION_STAGED_IDENTITY_REQUIRED')
    require(workload.get('status') == 'FRONTEND_VERIFIED' and workload.get('phase') == 'completed' and
            workload.get('trafficAuthorized') is False and workload.get('nativeSchedulerVerified') is False and
            workload.get('checks') == ['frontend-server-gateway-course-catalog-p2'] and
            _canonical(workload.get('featureControls')) == _canonical(native_plan.get('featureControls')) and
            workload.get('writerAdmissionBinding') == initial['expectedWriterAdmissionBinding'] == native_plan.get('writerAdmissionBinding') and
            plan['readyReceiptSha256']['frontend-workload-outcome.json'] == native_plan.get('configurationRecordSha256'),
            'P2_PROFILED_CERTIFICATION_WORKLOAD_REQUIRED')
    migrate.require_contract_identity(selected, workload)
    prior_time, alias_time = promote_started.get('previousAliasRequestedAt'), promoted.get('aliasRequestedAt')
    require(promoted.get('status') == 'FRONTEND_DOMAINS_PROMOTED' and promoted.get('phase') == 'completed' and
            promoted.get('frontendDomainsPromoted') is True and promoted.get('trafficAuthorized') is False and
            promoted.get('gatewayTrafficAuthorized') is False and type(prior_time) is int and type(alias_time) is int and
            0 <= prior_time < alias_time <= 2**53 - 1 and type(promoted.get('previousAliasRequestedAt')) is int and
            promoted['previousAliasRequestedAt'] == prior_time,
            'P2_PROFILED_CERTIFICATION_PROMOTION_REQUIRED')


def _profiled_original_terminal(initial, plan, selected, results, expected):
    if 'replacementRelease' in plan:
        return _profiled_replacement_original_terminal(initial, plan, selected, results, expected)
    local = _profiled_wire_receipt(initial['originalReleaseReceipt'], plan['originalReleaseReceiptSha256'], expected)
    original = results / ('p2-profiled-current-' + selected['releaseId'])
    terminal, terminal_sha = _profiled_host_receipt(original, 'p2-profiled-current-outcome.json', expected)
    started, _ = _profiled_host_receipt(original, 'p2-profiled-current-started.json', expected)
    binding = {'environment': 'staging', 'releaseId': selected['releaseId'], **migrate.contract_identity(selected),
               **{key: initial[key] for key in ('sourceCommit', 'candidateSha256', 'configurationSha256', 'targetSha256', 'inventorySha256')}}
    fields = {'version', 'qualificationTargetProfile', 'status', *binding, *TERMINAL_FALSE_FIELDS}
    require(_canonical(local) == _canonical(terminal) and set(terminal) == fields | TERMINAL_HASH_FIELDS and
            terminal['status'] == 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION' and
            set(started) in (fields | {'apiJobSha256'}, fields | {'apiJobSha256', 'reviewedPlanSha256'}) and
            started['status'] == 'P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW' and
            started['apiJobSha256'] == initial['apiJobSha256'] and
            all(all(row.get(key) == value for key, value in binding.items()) and
                all(row.get(key) is False for key in TERMINAL_FALSE_FIELDS) for row in (terminal, started)) and
            all(_profiled_digest(terminal[key]) for key in TERMINAL_HASH_FIELDS) and
            terminal['frontendWorkloadReceiptSha256'] == plan['readyReceiptSha256']['frontend-workload-outcome.json'],
            'P2_PROFILED_CERTIFICATION_ORIGINAL_RELEASE_REQUIRED')
    plan_hash_verified = 'reviewedPlanSha256' in started
    require(not plan_hash_verified or started['reviewedPlanSha256'] == plan['originalReleasePlanSha256'],
            'P2_PROFILED_CERTIFICATION_ORIGINAL_PLAN_CHANGED')
    return terminal_sha, plan_hash_verified


def _profiled_replacement_original_terminal(initial, plan, selected, results, expected):
    """Rejoin the installed guardian's original apply-forward bytes."""
    import p2_frontend_replacement_parent as replacement
    import p2_replacement_terminal as terminal
    from p2_replacement_runtime_review import FIELDS as REVIEW_FIELDS
    from qualification_target_profile import decode_qualification_target_json

    descriptor = require_certification_replacement_release(plan['replacementRelease'], expected)
    directory = results / ('p2-profiled-replacement-write-' + selected['releaseId'])
    migrate.private_directory(directory)
    require(directory == directory.resolve() and Path(initial['configuration']) ==
            results / ('runtime-profiled-frontend-replacement-' + selected['releaseId']) / 'configuration',
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_RUNTIME_MOUNT_REQUIRED')
    local = _profiled_wire_receipt(initial['originalReleaseReceipt'], plan['originalReleaseReceiptSha256'], expected)
    raw = replacement.private_record(directory, terminal.TERMINAL)
    require(raw == base64.b64decode(initial['originalReleaseReceipt'], validate=True),
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_BYTES_CHANGED')
    reviewed_plan = replacement.private_record(directory, 'reviewed-plan.json', 2_000_000)
    reviewed_runtime = replacement.private_record(directory, replacement.RUNTIME_REVIEW)
    original_plan = decode_qualification_target_json(reviewed_plan, 'carrier')
    original_review = decode_qualification_target_json(reviewed_runtime, 'carrier')
    migrate.require_profile(expected, original_plan, original_review)
    require(_sha(reviewed_plan) == descriptor['reviewedPlanSha256'] == plan['originalReleasePlanSha256'] and
            _sha(reviewed_runtime) == descriptor['runtimeReviewSha256'] and
            set(original_plan) == replacement.PLAN_FIELDS and type(original_plan['version']) is int and original_plan['version'] == 1 and
            original_plan['operation'] == 'profiled-frontend-replacement' and
            original_plan['status'] == 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED' and
            all(original_plan[key] is False for key in (*replacement.NO_AUTHORITY, 'releaseAccepted', 'replacementObserved')) and
            set(original_review) in (REVIEW_FIELDS, REVIEW_FIELDS | {'priorGatewayReference'}) and
            type(original_review['version']) is int and original_review['version'] == 1 and
            all(original_plan[key] == original_review[key] == plan[key]
                for key in ('environment', 'sourceCommit', 'candidateSha256', 'targetSha256')) and
            original_plan['releaseId'] == original_review['releaseId'] == selected['releaseId'] and
            all(original_review[key] == initial[key] for key in ('hostMachineId', 'configurationSha256', 'apiJobSha256', 'certification')) and
            original_review['reviewedPlanSha256'] == descriptor['reviewedPlanSha256'],
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_REVIEW_CHANGED')
    target = initial['frontendJob']['target']
    original_target = original_plan['replacement']
    native_plan = plan['nativePlan']
    require(original_target['target'] == {key: target[key] for key in replacement.TARGET_FIELDS} and
            original_target['approvedPendingTags'] == target['approvedPendingTags'] and
            all(original_target[key] == descriptor[key] for key in ('databaseOid', 'migrationRoleOid')) and
            sorted(original_target['administrativeLogins'], key=lambda row: row['name']) == descriptor['administrativeLogins'] and
            original_plan['predecessor']['target']['runtimeRole'] == descriptor['predecessorRuntimeRole'] and
            original_review['producerSha256'] == native_plan['producer']['producerSha256'] and
            local.get('owner') == native_plan['owner'] == initial['owner'] and
            local.get('runtime') == native_plan['producer']['role'] and local.get('producerSha256') == original_review['producerSha256'],
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_TARGET_CHANGED')
    replacement_initial = {**initial, 'mode': replacement.WRITE_MODE, 'configuration': original_review['configuration'],
                           **{key: descriptor[key] for key in ('reviewedPlanSha256', 'runtimeReviewSha256')}}
    arm = decode_qualification_target_json(replacement.private_record(directory, replacement.ARM), 'carrier')
    physical = replacement.unbase64(arm['physicalObservation'], 8192)
    identity = decode_qualification_target_json(physical, 'carrier')
    probe = {'version': 1, 'qualificationTargetProfile': expected, 'operation': 'verify-pre-bootstrap-lock',
             'candidate': selected, 'job': initial['frontendJob'], 'baseline': initial['frontendBaseline'],
             'predecessorTarget': original_plan['predecessor']['target'], 'targetSha256': plan['targetSha256'],
             **{key: descriptor[key] for key in ('databaseOid', 'migrationRoleOid')},
             **{key: identity[key] for key in replacement.PROBE_IDENTITY}}
    replacement.verify_bundle(Path(initial['bundle']), original_plan, probe)
    _, arm_sha = replacement.require_arm(replacement_initial, original_plan, probe, directory)
    boundary = decode_qualification_target_json(replacement.private_record(directory, replacement.WRITE_BOUNDARY), 'carrier')
    _, write_sha, held = replacement.require_write_custody(replacement_initial, original_plan, probe, directory, arm_sha, boundary)
    database = replacement.private_record(directory, 'frontend-original-database-receipt.json')
    started = replacement.private_record(directory, 'frontend-continuation-started.json', 8192)
    postflight = replacement.private_record(directory, replacement.WRITTEN_OBSERVATION, 8192)
    closed = replacement.private_record(directory, terminal.SESSION_CLOSED, 8192)
    require(_sha(database) == descriptor['frontendDatabaseReceiptSha256'] and
            _sha(postflight) == descriptor['postflightSha256'] and _sha(closed) == descriptor['frontendSessionClosedSha256'],
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_RECEIPT_BYTES_CHANGED')
    written = replacement.written_packet(original_plan, probe, held, {
        'writeIntentSha256': write_sha, 'databaseReceipt': base64.b64encode(database).decode(),
        'continuationStarted': base64.b64encode(started).decode(), 'owner': native_plan['owner'],
        'runtime': native_plan['producer']['role'], 'producerSha256': original_review['producerSha256']})
    replacement.require_write_observer_returned(replacement_initial, probe, held, directory, written=True)
    replacement.require_observer_pair(replacement_initial, probe, held, directory, (
        (replacement.CLOSED_OBSERVER_STARTED, 'CLOSED_STARTED'), (replacement.CLOSED_OBSERVER_RETURNED, 'CLOSED_RETURNED')))
    replacement.closed_result(written, postflight, closed)
    api = terminal.read_api(replacement_initial, original_plan, original_review, selected, directory, written, postflight)
    base = terminal.release_base(replacement_initial, original_plan, original_review, selected, postflight, api)
    provider = tuple(replacement.private_record(directory, name) for name in terminal.PROVIDER_FILES)
    node = tuple(replacement.private_record(directory, name) for name in terminal.NODE_FILES)
    proof, workload, promotion = (terminal.exact_receipt(value) for value in provider)
    require(proof['deploymentId'] == workload['deploymentId'] == promotion['deploymentId'] == native_plan['deploymentId'] and
            workload['previousDeploymentId'] == promotion['previousDeploymentId'] == original_plan['predecessor']['deploymentId'] and
            all(_sha(value) == plan['readyReceiptSha256'][name] for name, value in zip(terminal.PROVIDER_FILES[1:], provider[1:])),
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_PROVIDER_CHANGED')
    intent = terminal.exact_receipt(replacement.private_record(directory, terminal.INTENT))
    expected_terminal = terminal.join_terminal(base, written, provider, node, closed, status=terminal.TERMINAL_STATUS)
    require(_canonical(intent) == _canonical({**expected_terminal, 'status': terminal.INTENT_STATUS}) and
            _canonical(local) == _canonical(expected_terminal), 'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_REQUIRED')
    return _sha(raw), True


_RESUME_SOURCE_TERMINAL = 'p2-interactive-lesson-resume-source-terminal.json'
_RESUME_GUARD_RECEIPT = 'p2-interactive-lesson-resume-guard.json'
_RESUME_RELEASE_PINS = ('environment', 'originalReleaseId', 'sourceCommit', 'operatorSourceCommit', 'candidateSha256',
    'candidateObjectSha256', 'inventorySha256', 'targetSha256', 'contractPhase', 'phase2ContractManifestSha256',
    'originalReleaseReceiptSha256', 'originalReleasePlanSha256', 'configurationCanonicalSha256', 'runtimeInventorySha256',
    'gatewayProcessSha256', 'gatewayConfigurationSha256', 'operatorSourceClosureSha256', 'apiJobSha256', 'readyReceiptSha256')
_RESUME_DEPLOYMENT_PINS = ('projectId', 'deploymentId', 'deploymentUrl', 'configurationRecordSha256')


def _profiled_resume_binding(plan):
    return {**{key: plan[key] for key in _RESUME_RELEASE_PINS},
            **({'replacementRelease': plan['replacementRelease']} if 'replacementRelease' in plan else {}),
            'deployment': {key: plan['nativePlan'][key] for key in _RESUME_DEPLOYMENT_PINS}}


def retain_profiled_resume_guard(initial, terminal, committed):
    # The fixed supervisor calls this only after reaping the broker and
    # independently validating the physical ledger, Course and gateway joins.
    from p2_release_supervisor import _profiled_certification_directory
    plan = initial['certificationPlan']
    directory = _profiled_certification_directory(initial)
    source_terminal, source_sha = _profiled_host_receipt(directory, _RESUME_SOURCE_TERMINAL, _profiled_context())
    require(_canonical(source_terminal) == _canonical(terminal), 'P2_INTERACTIVE_LESSON_RESUME_GUARD_SOURCE_REQUIRED')
    migrate.write_json(directory, _RESUME_GUARD_RECEIPT, {
        'version': 2, 'qualificationTargetProfile': terminal['qualificationTargetProfile'],
        'status': 'P2_INTERACTIVE_LESSON_RESUME_GUARD_VERIFIED', 'certificationActionId': plan['certificationActionId'],
        'planSha256': plan['planSha256'], 'hostTerminalSha256': committed, 'operatorTerminalSha256': source_sha,
        'releaseBinding': _profiled_resume_binding(plan)})


def _require_profiled_restore_prior(plan, results, expected):
    from p2_release_supervisor import PROFILED_CERTIFICATION_LAYOUT
    action = plan['scopedAction']
    selected = action['restoreAction']
    prior = selected['prior']
    require(prior['actionId'] not in (plan['originalReleaseId'], plan['certificationActionId']),
            'P2_INTERACTIVE_LESSON_RESTORE_PRIOR_BINDING_REQUIRED')
    directory = results / (PROFILED_CERTIFICATION_LAYOUT['receiptPrefix'] + prior['actionId'])
    receipt, _ = _profiled_host_receipt(directory, _RESUME_GUARD_RECEIPT, expected)
    terminal, terminal_sha = _profiled_host_receipt(directory, PROFILED_CERTIFICATION_LAYOUT['terminalName'], expected)
    joined, _ = _profiled_host_receipt(directory, 'p2-scoped-case-joined.json', expected)
    require(_canonical(receipt) == _canonical({
        'version': 2, 'qualificationTargetProfile': terminal['qualificationTargetProfile'],
        'status': 'P2_INTERACTIVE_LESSON_RESUME_GUARD_VERIFIED', 'certificationActionId': prior['actionId'],
        'planSha256': terminal.get('planSha256'), 'hostTerminalSha256': terminal_sha,
        'operatorTerminalSha256': prior['outcomeSha256'], 'releaseBinding': _profiled_resume_binding(plan)}),
        'P2_INTERACTIVE_LESSON_RESTORE_PRIOR_GUARD_REQUIRED')
    closed_epoch = int(plan['initialEpoch']) - 2
    closed = {'epoch': str(closed_epoch), 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
    saved = {**{key: selected[key] for key in ('courseId', 'lessonId', 'grantId')},
             **{key: prior[key] for key in ('progressId', 'enrollmentId', 'resumePositionSeconds', 'maxPositionSeconds',
                                            'playbackIdSha256', 'playbackExpiresAt')}}
    require(closed_epoch >= 3 and terminal.get('status') == PROFILED_CERTIFICATION_LAYOUT['terminalStatus'] and
            terminal.get('certificationActionId') == joined.get('certificationActionId') == prior['actionId'] and
            terminal.get('mode') == 'interactive-browser' and _profiled_digest(terminal.get('planSha256')) and
            terminal['planSha256'] == joined.get('planSha256') and
            terminal.get('caseStatus') == joined.get('status') == 'P2_INTERACTIVE_LESSON_RESUME_JOINED' and
            terminal.get('caseOutcomeSha256') == _sha(_canonical(joined)) and
            _canonical(terminal.get('frontendAdmission')) == _canonical(joined.get('frontendAdmission')) == _canonical(closed) and
            joined.get('stage') == 'lesson-resume' and joined.get('operation') == 'play-and-rewind' and
            joined.get('frontendOperationCount') == 4 and joined.get('gatewayAdmissionClosed') is True and
            joined.get('gatewayActive') == joined.get('gatewayUncertain') == 0 and joined.get('actorId') == action['actorId'] and
            joined.get('revision') == 4 and all(_canonical(joined.get(key)) == _canonical(value) for key, value in saved.items()),
            'P2_INTERACTIVE_LESSON_RESTORE_PRIOR_EVIDENCE_REQUIRED')


def prepare_profiled_current_certification_input(initial, source):
    """Fixed current-profile host input check without execution authority."""
    from qualification_target_profile import decode_qualification_target_json
    expected = _profiled_context()
    plan = _profiled_initial(initial, expected)
    source = Path(source)
    require(source == PROFILED_OPERATOR_ROOT / initial['sourceCommit'] and source == source.resolve(),
            'P2_PROFILED_CERTIFICATION_INSTALLED_SOURCE_REQUIRED')
    verify_profiled_current_source_closure(initial, source)
    require(PROFILED_MACHINE_ID.read_text().strip() == initial['hostMachineId'], 'P2_PROFILED_CERTIFICATION_HOST_REQUIRED')
    paths = []
    for key in ('bundle', 'configuration', 'results'):
        require(type(initial[key]) is str, 'P2_PROFILED_CERTIFICATION_HOST_PATH_REQUIRED')
        path = Path(initial[key])
        require(path.is_absolute() and PROFILED_RELEASE_ROOT in path.parents and path == path.resolve() and
                ',' not in str(path), 'P2_PROFILED_CERTIFICATION_HOST_PATH_REQUIRED')
        staging_state.outside_checkout(path)
        paths.append(path)
    bundle, configuration, results = paths
    selected, jobs, runtime_plan, _ = runtime.make_plan(bundle, configuration, source / 'ops/platform/compose.yaml',
                                                        expected_profile=expected)
    require(set(jobs) == {'frontend', 'course', 'community'}, 'P2_PROFILED_CERTIFICATION_THREE_TARGETS_REQUIRED')
    frontend, inventory, native_plan = jobs['frontend']['job'], initial['inventory'], plan['nativePlan']
    target = frontend['target']
    replacement = 'replacementRelease' in plan
    require(type(inventory) is dict, 'P2_PROFILED_CERTIFICATION_FENCED_INVENTORY_REQUIRED')
    vercel.require_record_profile(expected, inventory, inventory.get('restoration'))
    require(_canonical(selected) == _canonical(initial['candidate']) and selected['contractPhase'] == 'p2' and
            selected['sources']['frontend']['commit'] == initial['sourceCommit'] and
            selected['releaseId'] == plan['originalReleaseId'] != initial['certificationActionId'] and
            _sha(migrate.read_input(bundle, 'release.candidate.json')) == initial['candidateSha256'] and
            _sha(_canonical(selected)) == plan['candidateObjectSha256'] and
            migrate.profiled_current_job_hashes(bundle) == initial['apiJobSha256'] and
            _canonical(frontend) == _canonical(initial['frontendJob']) and
            _canonical(decode_qualification_target_json(jobs['frontend']['schema'], 'carrier')) == _canonical(initial['frontendBaseline']) and
            (type(target.get('approvedPendingTags')) is list and bool(target['approvedPendingTags']) and target.get('allowEmptyBootstrap') is True
             if replacement else target.get('approvedPendingTags') == [] and target.get('allowEmptyBootstrap') is False) and
            frontend_target_sha256(target) == initial['targetSha256'] and
            runtime_plan['hostMachineId'] == initial['hostMachineId'] and
            staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
            'P2_PROFILED_CERTIFICATION_ACTUAL_RELEASE_INPUT_REQUIRED')
    migrate.require_contract_identity(selected, plan)
    restoration = inventory['restoration']
    require(_sha(_profiled_compact(inventory)) == initial['inventorySha256'] and inventory.get('admissionMode') == 'existing' and
            inventory.get('actionId') == selected['releaseId'] and inventory.get('sourceCommit') == initial['sourceCommit'] and
            inventory.get('targetSha256') == initial['targetSha256'] and inventory.get('owner') == initial['owner'] and
            inventory.get('certification') == initial['certification'] and
            restoration.get('providerIngress') == ('replacement-closed' if replacement else 'keep-retired') and
            all(restoration.get(key) is False for key in ('newWork', 'recovery', 'nativeSchedulesEnabled')),
            'P2_PROFILED_CERTIFICATION_FENCED_INVENTORY_REQUIRED')
    certification = require_certification_profile(initial['certification'])
    producer_hash = inventory.get('runtimeProducerSha256')
    producers = [row for row in inventory['producers'] if row['producerSha256'] == producer_hash]
    require(len(producers) == 1 and _profiled_digest(producer_hash) and producers[0]['role']['name'] == target['runtimeRole'] and
            native_plan.get('producer') == {'producerSha256': producer_hash, 'role': producers[0]['role']} and
            native_plan.get('owner') == initial['owner'] and
            all(native_plan['target'].get(key) == target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')) and
            native_plan.get('environment') == 'staging' and native_plan.get('actionId') == selected['releaseId'] and
            native_plan.get('projectId') == selected['workload']['projectId'] and
            native_plan.get('sourceCommit') == initial['sourceCommit'] and native_plan.get('targetSha256') == initial['targetSha256'] and
            native_plan.get('phase2ContractManifestSha256') == selected['phase2ContractManifestSha256'] and
            _canonical(native_plan.get('featureControls')) == _canonical(certification['featureControls']) and
            initial['expectedWriterAdmissionBinding'] == {'mode': 'enforce', 'targetSha256': initial['targetSha256'],
                'producerSha256': producer_hash, 'sourceCommit': initial['sourceCommit'], 'roleName': target['runtimeRole']},
            'P2_PROFILED_CERTIFICATION_NATIVE_BINDING_REQUIRED')
    _profiled_ready_receipts(initial, plan, selected, expected)
    _profiled_suspension_plan(initial, plan, expected)
    if plan['mode'] == 'known-ack-recovery':
        from p2_known_ack_loss import validate_known_configuration_input
        require(all(row['user'] == jobs[service]['job']['runtimeRole'] and
                    all(row[key] == jobs[service]['job']['target'][key] for key in ('host','port','database','serverMajor'))
                    for service,row in plan['knownAckReceiverTargets'].items()), 'P2_PROFILED_KNOWN_ACK_API_JOB_CHANGED')
        validate_known_configuration_input(plan['knownAckConfigurationInputDirectory'], configuration, selected, jobs,
                                           initial['configurationSha256'], expected_profile=expected)
    original_initial = initial
    if 'successorRuntime' in plan:
        from p2_replacement_successor import require_successor_runtime
        require(require_successor_runtime(initial, plan, selected, results, source, expected) == configuration,
                'P2_PROFILED_CERTIFICATION_SUCCESSOR_MOUNT_REQUIRED')
        original_mount = results / ('runtime-profiled-frontend-replacement-' + selected['releaseId']) / 'configuration'
        require(original_mount == original_mount.resolve() and
                staging_state.configuration_hashes(original_mount) == initial['configurationSha256'],
                'P2_PROFILED_CERTIFICATION_ORIGINAL_MOUNT_CHANGED')
        original_initial = {**initial, 'configuration': str(original_mount)}
    terminal_sha, plan_hash_verified = _profiled_original_terminal(original_initial, plan, selected, results, expected)
    if plan['mode'] == 'interactive-browser' and plan['scopedAction']['stage'] == 'lesson-restore':
        _require_profiled_restore_prior(plan, results, expected)
    return {'version': 2, 'qualificationTargetProfile': expected, 'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED',
            'environment': 'staging', 'releaseId': selected['releaseId'], 'certificationActionId': initial['certificationActionId'],
            'sourceCommit': initial['sourceCommit'], 'candidateSha256': initial['candidateSha256'], 'targetSha256': initial['targetSha256'],
            'planSha256': plan['planSha256'], 'readyReceiptSha256': plan['readyReceiptSha256'],
            'originalReleaseReceiptSha256': plan['originalReleaseReceiptSha256'], 'hostOriginalReleaseReceiptSha256': terminal_sha,
            'originalReleasePlanSha256': plan['originalReleasePlanSha256'], 'originalReleasePlanHashHostVerified': plan_hash_verified,
            'executionEligible': False, 'providerTouched': False, 'admissionChanged': False, 'releaseAccepted': False,
            **({'replacementRelease': plan['replacementRelease']} if replacement else {}),
            **({'successorRuntime': plan['successorRuntime']} if 'successorRuntime' in plan else {})}


def _iso(value):
    require(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value),'P2_CERTIFICATION_SOURCE_TIME_REQUIRED')
    return datetime.datetime.fromisoformat(value.removesuffix('Z')+'+00:00').timestamp()


def cache_certification_core(initial,source,*,expected_profile=None):
    global _core
    if expected_profile is None:
        migrate.require_profile(None, initial)
        verify_source_closure(initial,source)
    else:
        expected = _profiled_context()
        require(migrate.profile_context(expected_profile) == expected and initial.get('mode') in
                (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE),
                'P2_PROFILED_CERTIFICATION_SOURCE_CONTEXT_REQUIRED')
        vercel.require_record_profile(expected, initial)
        verify_profiled_current_source_closure(initial,source)
    raw=migrate.read_input(source,CORE)
    require(_sha(raw)==initial['sourceSha256'][CORE],'P2_CERTIFICATION_CORE_SOURCE_REQUIRED')
    _core=raw


def _cache_core(directory):
    require(isinstance(_core,bytes) and _core,'P2_CERTIFICATION_CACHED_CORE_REQUIRED')
    migrate.private_directory(directory)
    path=directory/'p2-recovery-current-probe.mjs'
    if not path.exists():
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
        try:
            remaining=_core
            while remaining:remaining=remaining[os.write(descriptor,remaining):]
            os.fchmod(descriptor,0o444);os.fsync(descriptor)
        finally:os.close(descriptor)
    info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid==os.getuid() and info.st_mode&0o777==0o444 and _sha(path.read_bytes())==_sha(_core),'P2_CERTIFICATION_PRIVATE_CORE_CHANGED')
    return path


def _private_probe_directory(action_id):
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',action_id),'P2_CERTIFICATION_ACTION_REQUIRED')
    return PRIVATE_ROOT/action_id


def _remove_private_probe(initial):
    directory=_private_probe_directory(initial['certificationActionId'])
    if directory.exists():
        migrate.private_directory(directory)
        file=directory/frontend_probe.PRIVATE_FILE
        require(not file.is_symlink(),'P2_CERTIFICATION_PRIVATE_PROBE_CHANGED')
        if file.exists():file.unlink()
        directory.rmdir()


def _scrub_suspension_credentials(initial):
    """Independent cleanup after the source mutator group has been reaped."""
    if initial['certificationPlan']['mode']!='browser-pending':return
    plan=initial['sourceSuspensionPlan'] if initial.get('mode')==PROFILED_CERTIFICATION_MODE else initial['browserPlan']
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',plan['actionId']),'P2_CERTIFICATION_BROWSER_ACTION_REQUIRED')
    directory=Path('/run/lash-her-p2-suspension-private')/plan['actionId']
    require(directory.resolve()==directory and not any(path.is_symlink() for path in (directory,*directory.parents)),'P2_CERTIFICATION_PRIVATE_CAPTURE_PATH_CHANGED')
    if not directory.exists():return
    migrate.private_directory(directory);path=directory/'controlled-capture.json'
    if not path.exists():return
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(descriptor);require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size<=262144,'P2_CERTIFICATION_PRIVATE_CAPTURE_REQUIRED')
        value=json.loads(os.read(descriptor,262145));require(value.get('bindingSha256')==_sha(_canonical(plan)),'P2_CERTIFICATION_PRIVATE_CAPTURE_BINDING_REQUIRED')
    finally:os.close(descriptor)
    path.unlink()


def contain_certification_native(initial,armed,source):
    """Called only by the fixed supervisor after the mutator group is reaped."""
    result={'nativeDisabled':None,'nativeDisableAttempted':False}
    try:
        require(armed is not None and armed['plan']==initial['certificationPlan'],'P2_CERTIFICATION_ARMED_SCOPE_REQUIRED')
        context={'candidate':initial['candidate'],'plan':initial['certificationPlan']['nativePlan']}
        client=vercel.Client(initial['vercelToken'])
        before=native.observe_metadata(context,client)
        if before['nativeEnabled']:
            result['nativeDisableAttempted']=True
            # Disable is an independent declared containment action. It never
            # depends on the old probe credential or a healthy parent session.
            client.request('PATCH',f'/v1/projects/{context["plan"]["projectId"]}/crons',{'enabled':False})
        result['nativeDisabled']=True if native.observe_metadata(context,client)['nativeEnabled'] is False else None
    except BaseException:pass
    try:_remove_private_probe(initial)
    except BaseException:pass
    try:_scrub_suspension_credentials(initial)
    except BaseException:pass
    return result



def _profiled_guard_context(initial, armed, source):
    from p2_release_supervisor import require_profiled_certification_guard_arm
    expected = _profiled_context()
    vercel.require_record_profile(expected, initial, armed, initial.get('certificationPlan'))
    require(initial.get('mode') == PROFILED_CERTIFICATION_MODE and
            source == PROFILED_OPERATOR_ROOT / initial['sourceCommit'] and os.geteuid() == 0,
            'P2_PROFILED_CERTIFICATION_GUARD_CONTEXT_REQUIRED')
    descriptor = initial.get('_guardLockDescriptor')
    require(type(descriptor) is int and descriptor >= 0, 'P2_PROFILED_CERTIFICATION_GUARD_LOCK_REQUIRED')
    lock = os.lstat(LOCK)
    held = os.fstat(descriptor)
    require(stat.S_ISREG(lock.st_mode) and lock.st_uid == 0 and not lock.st_mode & 0o077 and
            (lock.st_dev, lock.st_ino) == (held.st_dev, held.st_ino), 'P2_PROFILED_CERTIFICATION_GUARD_LOCK_CHANGED')
    witness = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(witness, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise ValueError('P2_PROFILED_CERTIFICATION_GUARD_LOCK_NOT_HELD')
    finally:
        os.close(witness)
    require_profiled_certification_guard_arm(initial, armed)
    require(armed['plan'] == initial['certificationPlan'], 'P2_PROFILED_CERTIFICATION_GUARD_PLAN_CHANGED')
    return expected


def contain_profiled_certification_native(initial, armed, source):
    result = {'nativeDisabled': None, 'nativeDisableAttempted': False}
    try:
        expected = _profiled_guard_context(initial, armed, source)
        context = {'candidate': initial['candidate'], 'plan': initial['certificationPlan']['nativePlan']}
        client = vercel.Client(initial['vercelToken'])
        before = native.observe_metadata(context, client, expected_profile=expected)
        if before['nativeEnabled']:
            result['nativeDisableAttempted'] = True
            client.request('PATCH', f"/v1/projects/{context['plan']['projectId']}/crons", {'enabled': False})
        if native.observe_metadata(context, client, expected_profile=expected)['nativeEnabled'] is False:
            result['nativeDisabled'] = True
    except Exception:
        pass
    for cleanup in (_remove_private_probe, _scrub_suspension_credentials):
        try:
            cleanup(initial)
        except Exception:
            pass
    return result


def contain_profiled_certification_frontend(initial, armed, source):
    result = {'frontendAdmissionClosed': None, 'frontendCloseAttempted': False}
    try:
        expected = _profiled_guard_context(initial, armed, source)
        credential = initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL']
        require(type(credential) is str and 0 < len(credential) <= 16384,
                'P2_PROFILED_CERTIFICATION_GUARD_CREDENTIAL_REQUIRED')
        directory = Path(initial['results']) / ('p2-profiled-current-certification-' + initial['certificationActionId'])
        program = private_observer_program(initial, directory / 'guard-frontend-source')
        core = _cache_core(program.parent)
        replacement = armed['plan'].get('replacementRelease')
        fence = '--profiled-replacement-guard-fence' if replacement is not None else '--profiled-current-guard-fence'
        from uuid import uuid4
        container = 'lash-p2-profiled-certification-guard-close-' + uuid4().hex
        args = ['docker', 'run', '--rm', '--pull', 'never', '--name', container, '--interactive', '--network', 'host',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
                '--pids-limit', '64', '--env', 'FRONTEND_STAGING_MIGRATION_DATABASE_URL',
                '--mount', f'type=bind,src={program},dst=/app/ops/platform/p2-frontend-live-probe.mjs,readonly',
                '--mount', f'type=bind,src={core},dst=/app/ops/platform/p2-recovery-current-probe.mjs,readonly',
                '--entrypoint', 'node', initial['candidate']['artifacts']['frontendMigration']['image'],
                'ops/platform/p2-frontend-live-probe.mjs', fence]
        environment = {**runtime.SAFE_ENV, 'FRONTEND_STAGING_MIGRATION_DATABASE_URL': credential}
        result['frontendCloseAttempted'] = True
        try:
            child = subprocess.run(args, input=json.dumps(armed), env=environment, capture_output=True, text=True, timeout=30, check=True)
        finally:
            subprocess.run(['docker', 'rm', '--force', container], env=runtime.SAFE_ENV, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=15, check=False)
            require(not runtime.command(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$',
                                         '--format', '{{.ID}}'], runtime.SAFE_ENV, 15), 'P2_PROFILED_CERTIFICATION_GUARD_CONTAINER_REMAINS')
        from qualification_target_profile import decode_qualification_target_json
        require(not child.stderr and 0 < len(child.stdout) <= 8192, 'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_OUTPUT_REFUSED')
        value = decode_qualification_target_json(child.stdout, 'carrier')
        vercel.require_record_profile(expected, value)
        if replacement is not None:
            require_certification_replacement_proof(value, replacement)
        plan = armed['plan']
        replacement_known_ack = replacement is not None and plan['mode'] == 'known-ack-recovery'
        if replacement is not None:
            fields = {'version', 'qualificationTargetProfile', 'status', 'environment', 'releaseId', 'sourceCommit',
                      'certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256', 'frontendAdmissionClosed',
                      'epoch', 'admissionChanged', 'sqlReplayed', 'releaseAccepted', *REPLACEMENT_PROOF_FIELDS}
            require(set(value) == fields | ({'knownAckLedger'} if replacement_known_ack else set()) and
                    type(value['epoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', value['epoch']) and
                    type(value['admissionChanged']) is bool,
                    'P2_PROFILED_CERTIFICATION_REPLACEMENT_GUARD_FRONTEND_BINDING_REQUIRED')
        require(value.get('status') == 'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_CLOSED' and
                value.get('environment') == 'staging' and value.get('releaseId') == plan['originalReleaseId'] and
                all(value.get(key) == plan[key] for key in ('sourceCommit', 'certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')) and
                value.get('frontendAdmissionClosed') is True and value.get('sqlReplayed') is False and value.get('releaseAccepted') is False,
                'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_BINDING_REQUIRED')
        _profiled_guard_context(initial, armed, source)
        if replacement_known_ack:
            ledger = value.get('knownAckLedger')
            require(type(ledger) is dict and set(ledger) == {'active', 'uncertain', 'closedZero'} and
                    all(type(ledger[key]) is int and 0 <= ledger[key] <= 2**53 - 1 for key in ('active', 'uncertain')) and
                    ledger['closedZero'] is (ledger['active'] == ledger['uncertain'] == 0),
                    'P2_PROFILED_CERTIFICATION_KNOWN_ACK_GUARD_LEDGER_REQUIRED')
            # Closed flags are compatible with retained uncertainty. Preserve
            # the actual readback without deriving a drain or retry authority.
            name = 'p2-known-ack-guard-frontend-ledger.json'
            raw = child.stdout.encode()
            require(raw.endswith(b'\n'), 'P2_PROFILED_CERTIFICATION_KNOWN_ACK_GUARD_LEDGER_REQUIRED')
            if not os.path.lexists(directory / name):
                migrate.write_exact_bytes(directory, name, raw)
            else:
                require(migrate.read_input(directory, name, 8192) == raw,
                        'P2_PROFILED_CERTIFICATION_KNOWN_ACK_GUARD_LEDGER_CHANGED')
        else:
            require('knownAckLedger' not in value, 'P2_PROFILED_CERTIFICATION_KNOWN_ACK_GUARD_LEDGER_REQUIRED')
        result['frontendAdmissionClosed'] = True
    except Exception:
        pass
    return result

class P2CertificationPhysicalObserver(PhysicalObserver):
    def __init__(self, selected, request, source, credential, *, program=None, program_sha256=None, expected_profile=None, interrupted=False):
        self._expected_profile = migrate.profile_context(expected_profile)
        self._replacement = None
        require(type(interrupted) is bool and (not interrupted or self._expected_profile is not None),
                'P2_PROFILED_CERTIFICATION_OBSERVER_MODE_REQUIRED')
        self._interrupted = interrupted
        if self._expected_profile is None:
            job, plan, receipt = (request.get(key, {}) for key in ('job', 'plan', 'receipt'))
            migrate.require_profile(None, selected, request, plan, job, job.get('target'), receipt, receipt.get('target'))
            require('replacementRelease' not in request and 'replacementRelease' not in plan and
                    selected.get('version') != 3 and all(row.get('version', 1) == 1 for row in (request, plan, job, receipt)),
                    'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED')
        else:
            expected = _profiled_context()
            plan = request['plan']
            self._replacement = copy.deepcopy(plan.get('replacementRelease'))
            boundary = 'historicalLogins' if self._replacement is None else 'replacementRelease'
            require(self._expected_profile == expected and set(request) == {
                'version', 'qualificationTargetProfile', 'marker', 'backendPid', 'backendStart', 'job', 'baseline',
                'owner', 'producers', boundary, 'plan', 'receipt'}, 'P2_PROFILED_CERTIFICATION_PHYSICAL_REQUEST_REQUIRED')
            job, receipt = request['job'], request['receipt']
            migrate.candidate_profile(selected, expected)
            migrate.require_job_profile(expected, job, frontend=True)
            vercel.require_record_profile(expected, request, plan, plan.get('nativePlan'), receipt)
            migrate.require_profile(expected, plan['nativePlan'].get('target'), receipt.get('target'))
            if self._replacement is None:
                history = request['historicalLogins']
                vercel.require_record_profile(expected, history)
                migrate.require_profile(expected, history.get('target'))
            else:
                require(_canonical(request[boundary]) == _canonical(self._replacement) and
                        type(request['backendStart']) is str and
                        re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z', request['backendStart']),
                        'P2_PROFILED_CERTIFICATION_REPLACEMENT_OBSERVER_REQUIRED')
                require_certification_replacement_release(self._replacement, expected)
                require_certification_replacement_proof(receipt, self._replacement)
            allowed_modes = (PROFILED_INTERRUPTED_MODE,) if interrupted else PROFILED_MODES
            require(plan.get('startState') == 'already-closed' and plan.get('mode') in allowed_modes and
                    type(request['backendPid']) is int and request['backendPid'] > 0 and
                    type(request['backendStart']) is str and 0 < len(request['backendStart']) <= 80 and
                    _profiled_digest(request['marker']) and
                    _profiled_digest(receipt.get('journalSha256')) and _profiled_digest(receipt.get('witnessSha256')) and
                    program is not None and _profiled_digest(program_sha256) and
                    _sha(migrate.read_input(source, OBSERVER)) == program_sha256,
                    'P2_PROFILED_CERTIFICATION_PHYSICAL_REQUEST_REQUIRED')
            selected, request = copy.deepcopy(selected), copy.deepcopy(request)
            self._request_sha256 = _sha(_profiled_compact(request))
        super().__init__(selected, request, source, credential, program=program, program_sha256=program_sha256)

    def verify(self):
        if self._expected_profile is not None:
            require(self.thread is not None and self.thread.is_alive() and not self.stop_event.is_set() and
                    _sha(_profiled_compact(self.request)) == self._request_sha256,
                    'P2_PROFILED_CERTIFICATION_PHYSICAL_SESSION_LOST')
        super().verify()

    def probe(self,operation):
        profiled = self._expected_profile is not None
        require(operation in ('observe','verify-schema','witness','fence') or profiled and operation=='verify-closed',
                'P2_CERTIFICATION_OBSERVATION_REQUIRED')
        if profiled:
            require(operation != 'fence' and _sha(_profiled_compact(self.request)) == self._request_sha256,
                    'P2_PROFILED_CERTIFICATION_READ_ONLY_OBSERVER_REQUIRED')
        payload = json.dumps({**self.request, 'operation': operation})
        if profiled:
            require(len(payload.encode()) <= 2_000_000, 'P2_PROFILED_CERTIFICATION_PHYSICAL_REQUEST_REQUIRED')
        program=self.program;require(program is not None and _sha(program.read_bytes())==self.program_sha256,'P2_CERTIFICATION_OBSERVER_CHANGED')
        if profiled:
            require(isinstance(_core, bytes) and _sha(migrate.read_input(self.source, CORE)) == _sha(_core),
                    'P2_PROFILED_CERTIFICATION_CORE_SOURCE_REQUIRED')
        core=_cache_core(program.parent)
        image=self.selected['artifacts']['frontendMigration']['image']
        from uuid import uuid4
        container='lash-p2-certification-observer-'+uuid4().hex
        entry = OBSERVER if profiled else 'ops/platform/p2-frontend-live-probe.mjs'
        if self._replacement is not None:
            observer_flag = '--profiled-replacement-known-ack-interrupted' if self._interrupted else '--profiled-replacement'
        else:
            observer_flag = '--profiled-known-ack-interrupted' if self._interrupted else '--profiled-current'
        args=['docker','run','--rm',*(['--pull','never'] if profiled else []),'--name',container,'--interactive','--network','host','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--memory','256m','--pids-limit','64','--env','FRONTEND_STAGING_MIGRATION_DATABASE_URL',
            '--mount',f'type=bind,src={program},dst=/app/{entry},readonly',
            '--mount',f'type=bind,src={core},dst=/app/ops/platform/p2-recovery-current-probe.mjs,readonly',
            '--entrypoint','node',image,entry,*([observer_flag] if profiled else [])]
        environment={**runtime.SAFE_ENV,'FRONTEND_STAGING_MIGRATION_DATABASE_URL':self.credential}
        try:result=subprocess.run(args,input=payload,capture_output=True,text=True,env=environment,timeout=30,check=True)
        finally:
            subprocess.run(['docker','rm','--force',container],env=runtime.SAFE_ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
            require(not runtime.command(['docker','container','ls','--all','--filter','name=^/'+container+'$','--format','{{.ID}}'],runtime.SAFE_ENV,15),'P2_CERTIFICATION_OBSERVER_REMAINS')
        maximum=2_000_000 if operation=='witness' else 16384
        require(not result.stderr and 0<len(result.stdout)<=maximum and _sha(program.read_bytes())==self.program_sha256 and _sha(core.read_bytes())==_sha(_core),'P2_CERTIFICATION_OBSERVER_OUTPUT_REFUSED')
        if profiled:
            return self._profiled_result(result.stdout, operation)
        value=json.loads(result.stdout)
        require(value.get('status')==('P2_FRONTEND_ADMISSION_CLOSED' if operation=='fence' else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED'),'P2_CERTIFICATION_PHYSICAL_OBSERVATION_REFUSED')
        if operation!='fence':require(value.get('marker')==self.request['marker'] and value.get('backendPid')==self.request['backendPid'] and value.get('sourceCommit')==self.request['job']['sourceCommit'],'P2_CERTIFICATION_PHYSICAL_BINDING_REFUSED')
        return value

    def _profiled_result(self, raw, operation):
        value = _profiled_record(raw, self._expected_profile)
        request, receipt = self.request, self.request['receipt']
        fields = {'version', 'qualificationTargetProfile', 'status', 'environment', 'releaseId', 'sourceCommit',
                  'targetSha256', 'marker', 'backendPid', 'backendStart', 'admission', 'journalSha256', 'witnessSha256'}
        if self._replacement is not None:
            fields.update(REPLACEMENT_PROOF_FIELDS)
            require_certification_replacement_proof(value, self._replacement)
        if operation == 'witness':
            fields.add('witness')
        closed = operation == 'verify-closed'
        if closed:
            fields.update(('backendAbsent','migrationLockReleased','nonceLockReleased'))
        expected_status = 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' if closed else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED'
        require(set(value) == fields and value['status'] == expected_status and
                all(value[key] == request[key] for key in ('marker', 'backendPid', 'backendStart')) and
                type(value['backendPid']) is int and value['environment'] == 'staging' and
                all(value[key] == request['job'][key] for key in ('releaseId', 'sourceCommit')) and
                value['targetSha256'] == request['plan']['targetSha256'] and value['journalSha256'] == receipt['journalSha256'] and
                _profiled_digest(value['witnessSha256']) and
                (operation != 'witness' or _sha(_profiled_compact(value['witness'])) == value['witnessSha256']),
                'P2_PROFILED_CERTIFICATION_PHYSICAL_BINDING_REQUIRED')
        admission = value['admission']
        require(type(admission) is dict and set(admission) == {'epoch', 'newWork', 'recovery', 'active', 'uncertain'} and
                type(admission['epoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', admission['epoch']) and
                all(type(admission[key]) is bool for key in ('newWork', 'recovery')) and
                all(type(admission[key]) is int and admission[key] >= 0 for key in ('active', 'uncertain')),
                'P2_PROFILED_CERTIFICATION_PHYSICAL_ADMISSION_REQUIRED')
        if closed:
            require(all(value[key] is True for key in ('backendAbsent','migrationLockReleased','nonceLockReleased')) and
                    admission['newWork'] is False and admission['recovery'] is False and admission['active'] == admission['uncertain'] == 0,
                    'P2_PROFILED_CERTIFICATION_SESSION_CLOSE_REQUIRED')
        if operation == 'verify-schema' or self._interrupted:
            require(admission == receipt['admission'] == {'epoch': request['plan']['initialEpoch'], 'newWork': False,
                    'recovery': False, 'active': 0, 'uncertain': 0} and value['witnessSha256'] == receipt['witnessSha256'],
                    'P2_PROFILED_CERTIFICATION_INITIAL_CLOSED_BOUNDARY_REQUIRED')
        return value


class P2CertificationScope(P2ReleaseScope):
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256=None, *, release=None, jobs=None,
                 configuration_sha256=None, certification_plan, expected_profile=None, physical_observer=None,
                 original_replacement_receipt=None):
        self.certification_plan = copy.deepcopy(certification_plan)
        self._expected_profile = migrate.profile_context(expected_profile)
        self._physical_observer = physical_observer
        self._original_replacement_receipt = original_replacement_receipt
        replacement = self.certification_plan.get('replacementRelease')
        require((replacement is None and original_replacement_receipt is None) or
                (self._expected_profile is not None and type(original_replacement_receipt) is bytes and
                 _sha(original_replacement_receipt) == self.certification_plan['originalReleaseReceiptSha256']),
                'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_REQUIRED')
        if self._expected_profile is None:
            require(physical_observer is None, 'P2_CERTIFICATION_FIXED_SCOPE_REQUIRED')
            job = jobs['frontend']['job']
            migrate.require_profile(None, release, certification_plan, job, job.get('target'), receipt, receipt.get('target'))
            require(release.get('version') != 3 and all(row.get('version', 1) == 1 for row in (certification_plan, job, receipt)),
                    'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED')
        else:
            expected = _profiled_context()
            require(self._expected_profile == expected and type(physical_observer) is P2CertificationPhysicalObserver and
                    physical_observer._expected_profile == expected and getattr(physical_observer,'_interrupted',False) is
                    (certification_plan.get('mode') == PROFILED_INTERRUPTED_MODE), 'P2_PROFILED_CERTIFICATION_PHYSICAL_SCOPE_REQUIRED')
            migrate.candidate_profile(release, expected)
            migrate.require_job_profile(expected, jobs['frontend']['job'], frontend=True)
            vercel.require_record_profile(expected, certification_plan, receipt)
            migrate.require_profile(expected, receipt.get('target'))
            if replacement is not None:
                from p2_replacement_terminal import TERMINAL_STATUS
                original = _profiled_record(original_replacement_receipt, expected)
                require(_canonical(self._physical_observer._replacement) == _canonical(replacement) and
                        original.get('status') == TERMINAL_STATUS and original.get('frontendSqlApplied') is True and
                        original.get('frontendSqlReplayed') is False and original.get('frontendSessionClosed') is True and
                        all(original.get(key) == replacement[key] for key in REPLACEMENT_RELEASE_HASHES),
                        'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_REQUIRED')
            require(type(configuration_sha256) is dict and set(configuration_sha256) == set(staging_state.CONFIGURATION_FILES) and
                    all(_profiled_digest(value) for value in configuration_sha256.values()) and
                    certification_plan.get('configurationCanonicalSha256') == _sha(_canonical(configuration_sha256)) and
                    certification_plan.get('planSha256') == _profiled_plan_hash(certification_plan),
                    'P2_PROFILED_CERTIFICATION_CONFIGURATION_SCOPE_REQUIRED')
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256, release=release, jobs=jobs,
                         configuration_sha256=configuration_sha256)
        self.require_frontend(self.release,self.jobs['frontend'])

    def verify(self):
        super().verify()
        if self._expected_profile is not None:
            self._physical_observer.verify()

    def require_frontend(self,release,info):
        self.verify();job,receipt=info['job'],self.receipt;plan=self.certification_plan
        target = {key: job['target'][key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}
        if self._expected_profile is not None:
            self._require_profiled_frontend(release, info)
            target['qualificationTargetProfile'] = self._expected_profile
        migrate.require_contract_identity(release,receipt)
        fields=('environment','releaseId','sourceCommit','migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256')
        require(release==self.release and info==self.jobs['frontend'] and all(receipt.get(key)==job.get(key) for key in fields) and
            receipt.get('status')=='P2_CERTIFICATION_DATABASE_CURRENT' and receipt.get('certificationActionId')==plan['certificationActionId'] and
            receipt.get('candidateSha256')==self.candidate_sha256==plan['candidateSha256'] and receipt.get('planSha256')==plan['planSha256'] and
            receipt.get('targetSha256')==plan['targetSha256']==frontend_target_sha256(job['target']) and receipt.get('target')==target and
            receipt.get('schemaVerified') is True and receipt.get('runtimeRoleVerified') is True and
            ('replacementRelease' in plan or receipt.get('oldLoginsDenied') is True and receipt.get('oldRoleSessions')==0) and
            receipt.get('sqlReplayed') is False and receipt.get('trafficAuthorized') is False and isinstance(receipt.get('after'),list) and receipt['after'],
            'P2_CERTIFICATION_FRESH_CURRENT_PROOF_REQUIRED')
        return copy.deepcopy(receipt)

    def require_replacement_original(self, raw):
        self.verify()
        require(type(raw) is bytes and raw == self._original_replacement_receipt and
                _sha(raw) == self.certification_plan.get('originalReleaseReceiptSha256'),
                'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_BYTES_CHANGED')
        return _profiled_record(raw, self._expected_profile)

    def _require_profiled_frontend(self, release, info):
        from qualification_target_profile import decode_qualification_target_json
        expected, observer, receipt = self._expected_profile, self._physical_observer, self.receipt
        request, job = observer.request, info['job']
        migrate.candidate_profile(release, expected)
        migrate.require_job_profile(expected, job, frontend=True)
        vercel.require_record_profile(expected, self.certification_plan, receipt)
        migrate.require_profile(expected, receipt.get('target'))
        migrate.require_contract_identity(release, job, receipt, self.certification_plan)
        replacement = self.certification_plan.get('replacementRelease')
        if replacement is not None:
            require_certification_replacement_release(replacement, expected)
            require_certification_replacement_proof(receipt, replacement)
            boundary_ok = (_canonical(request.get('replacementRelease')) == _canonical(replacement) and
                           type(job['target'].get('approvedPendingTags')) is list and bool(job['target']['approvedPendingTags']) and
                           job['target'].get('allowEmptyBootstrap') is True)
        else:
            boundary_ok = (job['target'].get('approvedPendingTags') == [] and job['target'].get('allowEmptyBootstrap') is False and
                           type(receipt.get('oldRoleSessions')) is int and
                           receipt.get('retiredLogins') == request['historicalLogins'].get('retiredLogins'))
        require(_canonical(observer.selected) == _canonical(release) and _canonical(request['job']) == _canonical(job) and
                request['plan'] == self.certification_plan and request['receipt'] == receipt and
                _canonical(request['baseline']) == _canonical(decode_qualification_target_json(info['schema'], 'carrier')) and
                boundary_ok and receipt.get('service') == 'frontend' and
                receipt.get('owner') == request['owner'] == self.certification_plan['nativePlan']['owner'] and
                receipt.get('runtime') == self.certification_plan['nativePlan']['producer']['role'] and
                receipt.get('journalSha256') == _sha(_profiled_compact(receipt.get('after'))) and
                receipt.get('witnessSha256') == _sha(_profiled_compact(receipt.get('witness'))),
                'P2_PROFILED_CERTIFICATION_FRONTEND_SCOPE_BINDING_REQUIRED')

    def initialize_runtime(self,*_):raise ValueError('P2_CERTIFICATION_RUNTIME_REPLACEMENT_FORBIDDEN')


def check_profiled_certification_apis(scope, jobs, source, bundle, output, credentials, source_sha256, *, expected_profile):
    """Run both fixed selected-image read-only checks under the same held scope."""
    from current_databases import check_certification_apis, read_certification_api_proof
    expected = _profiled_context()
    require(migrate.profile_context(expected_profile) == expected and type(scope) is P2CertificationScope and
            scope._expected_profile == expected and scope._physical_observer.source == source and
            type(source_sha256) is dict and _profiled_digest(source_sha256.get(API_CHECKER)),
            'P2_PROFILED_CERTIFICATION_API_SCOPE_REQUIRED')
    scope.require_release(scope.release, jobs)
    scope.require_frontend(scope.release, jobs['frontend'])
    raw_jobs = {name: migrate.read_input(bundle, f'jobs/{name}.json') for name in ('course', 'community')}
    proof = check_certification_apis(scope.release, jobs, output, credentials, source / API_CHECKER,
        source_sha256[API_CHECKER], raw_jobs, expected_profile=expected, _certification_scope=scope)
    _, outcome = read_certification_api_proof(proof, scope, scope.release, jobs, expected_profile=expected)
    return proof, outcome


def observe_certification_api(scope,jobs,source,name,directory):
    require(type(scope) is P2CertificationScope and scope._expected_profile is None and name in ('course','community'),'P2_CERTIFICATION_ACTUAL_API_SCOPE_REQUIRED')
    scope.require_frontend(scope.release,jobs['frontend']);info=jobs[name]
    external,internal=migrate.credential_names(name,'staging');credential=os.environ.get(external)
    require(isinstance(credential,str) and credential,'P2_CERTIFICATION_API_CREDENTIAL_REQUIRED')
    from uuid import uuid4
    container='lash-p2-recovery-current-'+name+'-'+uuid4().hex
    program=source/'ops/platform/p2-recovery-api-current-probe.mjs'
    payload={'version':1,'service':info['service'],'job':info['job'],'schemaBytes':info['schema'].decode(),
        'candidateSha256':scope.candidate_sha256,'recoveryActionId':scope.certification_plan['certificationActionId']}
    args=['docker','run','--rm','--name',container,'--interactive','--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--memory','256m','--pids-limit','64','--env',internal,'--mount',f'type=bind,src={program},dst=/app/p2-recovery-api-current-probe.mjs,readonly',
        '--entrypoint','node',info['image'],'/app/p2-recovery-api-current-probe.mjs']
    try:
        result=scope.run(args,env={**runtime.SAFE_ENV,internal:credential},input=json.dumps(payload),check=True,capture_output=True,text=True,timeout=60)
        require(not result.stderr and 0<len(result.stdout)<=16384,'P2_CERTIFICATION_API_PROOF_BOUNDS')
        proof=json.loads(result.stdout);keys=('environment','releaseId','sourceCommit','migrationImageDigest','runtimeImageDigest','schemaBaselineSha256','contractSha256')
        require(proof.get('status')=='P2_RECOVERY_API_DATABASE_CURRENT' and proof.get('service')==info['service'] and
            all(proof.get(key)==info['job'].get(key) for key in keys) and proof.get('candidateSha256')==scope.candidate_sha256 and
            proof.get('recoveryActionId')==scope.certification_plan['certificationActionId'] and proof.get('readOnlyVerified') is True and
            proof.get('schemaVerified') is True and proof.get('runtimeRoleVerified') is True and proof.get('pendingTags')==[] and proof.get('sqlReplayed') is False,
            'P2_CERTIFICATION_CURRENT_API_REQUIRED')
        migrate.require_contract_identity(scope.release,proof);migrate.write_json(directory,name+'-current-database.json',proof);return proof
    finally:
        scope.run(['docker','rm','--force',container],env=runtime.SAFE_ENV,timeout=30,check=False,capture_output=True,text=True)
        remaining=scope.run(['docker','container','ls','--all','--filter','name=^/'+container+'$','--format','{{.ID}}'],env=runtime.SAFE_ENV,timeout=15,check=True,capture_output=True,text=True)
        require(not remaining.stdout,'P2_CERTIFICATION_API_CONTAINER_REMAINS')


class P2CertificationBroker(Broker):
    def action_id(self):return self.initial['certificationActionId']
    def directory_name(self):return 'p2-certification-'+self.action_id()
    def terminal_filename(self):return 'p2-certification-outcome.json'

    def certification_profile(self):return None

    def profile_arguments(self):
        expected = self.certification_profile()
        return {} if expected is None else {'expected_profile': expected}

    def _initialize_certification_state(self):
        self.certification_started=time.monotonic();self.native_mutex=threading.Lock();self.boundary_stop=threading.Event();self.boundary_thread=None
        self.fault_stage=None;self.runtime_current=None;self.last_boundary=None;self.external_armed=False
        self.native_enable_attempted=False;self.admission_fd=None;self.process_snapshot=None;self.api_cycle=0
        self.native_expected=False
        self.api_mutex=threading.Lock();self.last_api_verified=0;self.prepared_terminal=None
        self.suspension_stage=None;self.authentication_issued=False;self.browser_retained=None;self.pending_retained=None
        self.browser_origin=None
        self.worker_stage=None;self.worker_retained=None;self.worker_source_sha256=None
        self.known_ack_recorder=None;self.known_ack_boundary=None;self.known_ack_outcome=None;self.known_ack_replace_attempted=False
        self.known_ack_new_gateway_process=None

    def initialize(self):
        self._initialize_certification_state()
        super().initialize()

    def select_release(self,initial):
        selected,jobs,plan,compose=runtime.make_plan(Path(initial['bundle']),Path(initial['configuration']),self.source/'ops/platform/compose.yaml')
        cert=initial['certificationPlan']
        require(initial.get('mode')=='p2-bounded-certification' and selected==initial['candidate'] and selected['environment']=='staging' and selected.get('contractPhase')=='p2' and
            cert['certificationActionId']==initial['certificationActionId']!=selected['releaseId'] and cert['originalReleaseId']==selected['releaseId'] and
            cert['candidateSha256']==initial['candidateSha256'] and cert['sourceCommit']==selected['sources']['frontend']['commit'] and
            cert['operatorSourceCommit']==initial['sourceCommit'] and cert['targetSha256']==initial['targetSha256'] and set(jobs)=={'frontend','course','community'} and
            cert['configurationSha256']==_sha(json.dumps(initial['configurationSha256'],separators=(',',':'),ensure_ascii=False).encode()) and
            cert['nativePlan']==initial['nativePlan'] and cert['maximumSeconds']==(300 if cert['mode']=='auth-preparation' else 900),'P2_CERTIFICATION_REVIEWED_SELECTION_REQUIRED')
        if cert['mode'] in ('auth-preparation','browser-pending'):
            require(_sha(_canonical(initial['browserPlan']))==cert['browserPlanSha256'] and initial['browserPlan']['releaseId']==selected['releaseId'] and
                initial['browserPlan']['candidateSha256']==initial['candidateSha256'] and initial['browserPlan']['sourceCommit']==initial['sourceCommit'] and
                initial['browserPlan']['targetSha256']==cert['targetSha256'],'P2_CERTIFICATION_BROWSER_SOURCE_PLAN_REQUIRED')
        if cert['mode']=='direct-worker':
            require(cert['startState']=='already-closed' and initial['workerPlan']==cert['workerPlan'] and _sha(_canonical(initial['workerPlan']))==cert['workerPlanSha256'] and
                initial['workerPlan']['actionId']==self.action_id() and initial['workerPlan']['nativePlanSha256']==initial['nativePlan']['planSha256'] and
                cert['sourceCommit']==cert['operatorSourceCommit'],'P2_CERTIFICATION_SOURCE_WORKER_PLAN_REQUIRED')
        if cert['mode']=='known-ack-recovery':
            import p2_known_ack_loss as known
            selection=cert.get('knownAckRecovery')
            require(cert['sourceCommit']==cert['operatorSourceCommit'] and isinstance(selection,dict) and selection.get('version')==1 and
                re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',selection.get('recoveryActionId','')) and
                selection['recoveryActionId'] not in (self.action_id(),selected['releaseId']) and
                selection.get('intent')==known.replacement_intent(cert,selection['recoveryActionId']) and selection.get('intentSha256')==_sha(_canonical(selection['intent'])),
                'P2_CERTIFICATION_REVIEWED_KNOWN_ACK_INTENT_REQUIRED')
            known.validate_known_configuration_input(cert['knownAckConfigurationInputDirectory'],self.configuration,selected,jobs,initial['configurationSha256'])
        require(cert['operatorSourceClosureSha256']==initial['sourceClosureSha256'] and cert['configurationCanonicalSha256']==_sha(_canonical(initial['configurationSha256'])),
            'P2_CERTIFICATION_CLOSED_SOURCE_CONFIGURATION_REQUIRED')
        migrate.require_contract_identity(selected,cert)
        return selected,jobs,plan,compose

    def check(self):
        super().check()
        require(time.monotonic()-self.certification_started<self.initial['certificationPlan']['maximumSeconds'],'P2_CERTIFICATION_BOUNDED_STAGE_EXPIRED')
        if self.external_armed:
            require(self.last_boundary is not None and 0<=time.monotonic()-self.last_boundary<40,'P2_CERTIFICATION_CURRENT_BOUNDARY_STALE')
            require(staging_state.configuration_hashes(self.configuration)==self.initial['configurationSha256'],'P2_CERTIFICATION_CONFIGURATION_CHANGED')

    def _native_context(self):
        return {'candidate':self.selected,'plan':self.initial['nativePlan'],'configurationRecordSha256':self.initial['nativePlan']['configurationRecordSha256'],
            'privateProbeDirectory':str(_private_probe_directory(self.action_id()))}

    def _store_private_probe(self):
        PRIVATE_ROOT.mkdir(mode=0o700,exist_ok=True);migrate.private_directory(PRIVATE_ROOT)
        require(PRIVATE_ROOT.resolve()==PRIVATE_ROOT and not PRIVATE_ROOT.is_symlink(),'P2_CERTIFICATION_FIXED_PRIVATE_ROOT_REQUIRED')
        directory=_private_probe_directory(self.action_id());directory.mkdir(mode=0o700)
        value=self.initial['privateProbe']
        fields={'environment','projectId','sourceCommit','releaseId','secret','expiresAt','gatewayOrigin'}
        if self.certification_profile() is not None:
            fields |= {'version','qualificationTargetProfile'}
        require(isinstance(value,dict) and set(value)==fields,'P2_CERTIFICATION_PRIVATE_PROBE_SHAPE_REQUIRED')
        migrate.write_json(directory,frontend_probe.PRIVATE_FILE,value)
        frontend_probe._private_input(directory,self._probe_identity(),**self.profile_arguments())

    def _probe_identity(self):
        identity={'environment':'staging','projectId':self.selected['workload']['projectId'],
            'sourceCommit':self.selected['sources']['frontend']['commit'],'releaseId':self.selected['releaseId']}
        expected=self.certification_profile()
        if expected is not None:identity.update(version=2,qualificationTargetProfile=expected)
        return identity

    def _scope_arguments(self):
        return {}

    def _accept_guard_arm(self,probe):
        self.safety({'operation':'armed','probe':probe})

    def _read_api_current(self,directory):
        directory.mkdir(mode=0o700)
        api={}
        for service in ('course','community'):
            target=directory/service;target.mkdir(mode=0o700)
            api[service]=observe_certification_api(self.scope,self.jobs,self.source,service,target)
        require(all(row.get('status')=='P2_RECOVERY_API_DATABASE_CURRENT' for row in api.values()),
                'P2_CERTIFICATION_ALL_CURRENT_REQUIRED')
        return api

    def arm(self,request):
        self.check();require(self.scope is None and self.observer is None and not self.external_armed,'P2_CERTIFICATION_ALREADY_ARMED')
        raw,receipt=decode(request['receipt']);probe=request['probe'];cert=self.initial['certificationPlan']
        boundary = 'replacementRelease' if 'replacementRelease' in cert else 'historicalLogins'
        if boundary == 'replacementRelease':
            require(base64.b64encode(raw).decode() == request['receipt'] and 'historicalLogins' not in probe and
                    _canonical(probe.get(boundary)) == _canonical(cert[boundary]),
                    'P2_PROFILED_CERTIFICATION_REPLACEMENT_ARM_REQUIRED')
            require_certification_replacement_proof(receipt, cert[boundary])
        require(probe.get('job')==self.jobs['frontend']['job'] and probe.get('baseline')==json.loads(self.jobs['frontend']['schema']) and probe.get('receipt')==receipt and
            probe.get('plan')==cert and probe.get('owner')==self.initial['owner'] and probe.get('producers')==self.initial['producers'] and
            probe.get(boundary)==self.initial[boundary],'P2_CERTIFICATION_CURRENT_PROBE_BINDING_REQUIRED')
        self.frontend_raw=raw;self.armed_probe=probe
        self.observer=self.observer_type(self.selected,probe,self.source,self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'],
            program=self.observer_program,program_sha256=self.initial['sourceSha256'][OBSERVER],**self.profile_arguments())
        self.observer.start(self.abort)
        self.scope=P2CertificationScope(self.lock_fd,LOCK,self.check,receipt,self.initial['candidateSha256'],release=self.selected,jobs=self.jobs,
            configuration_sha256=self.initial['configurationSha256'],certification_plan=cert,**self._scope_arguments())
        # Independent cleanup is armed before readonly helpers are launched.
        # There is still no native/admission/fault mutation authority.
        self._accept_guard_arm(probe)
        if cert['mode']=='contain-native':native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check),**self.profile_arguments())
        elif cert['mode'] in SCOPED_MODES:
            workload = self._native_observe()
            require(workload['nativeEnabled'] is False, 'P2_CERTIFICATION_NATIVE_OFF_REQUIRED')
            migrate.write_json(self.directory, 'p2-scoped-current-workload.json', workload)
        else:
            self._store_private_probe()
            require(self._native_observe()['nativeEnabled'] is False,'P2_CERTIFICATION_NATIVE_OFF_REQUIRED')
        api=self._read_api_current(self.directory/'current-api')
        self.runtime_snapshot=self.configuration
        token=runtime._command_scope.set(self.scope)
        try:self.runtime_current=runtime.check_containers(self.selected,self.configuration,**self.profile_arguments())
        finally:runtime._command_scope.reset(token)
        require(len(self.runtime_current)==10,'P2_CERTIFICATION_ALL_CURRENT_REQUIRED')
        self.last_api_verified=time.monotonic()
        require(_sha(_canonical(self.runtime_current))==cert['runtimeInventorySha256'],'P2_CERTIFICATION_REVIEWED_RUNTIME_SELECTION_REQUIRED')
        self.admission_fd=os.open(self.configuration/'admission',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);self.admission_identity=os.fstat(self.admission_fd)
        self.process_snapshot=self._runtime_processes();gateway=self._gateway_current()
        expected=cert['startState']=='qualified-ready';actual=gateway['admission']
        require(actual.get('newWork') is expected and actual.get('recovery') is expected and
            all(actual.get('uncertain',{}).get(key)==0 for key in ('newWork','recovery')) and
            (expected or all(actual.get('active',{}).get(key)==0 for key in ('newWork','recovery'))),'P2_CERTIFICATION_REVIEWED_GATEWAY_STATE_REQUIRED')
        self.last_boundary=time.monotonic();self.external_armed=True
        self._prepare_lifecycle_stages(cert['mode'])
        if cert['mode'] in ('auth-preparation','browser-pending'):
            self.browser_origin=self._retain_browser_observation('arm')['canonicalBrowserObservation']
        self.ready={'status':'P2_CERTIFICATION_CURRENT_READY','apiDatabases':api,'containers':self.runtime_current,'sqlReplayed':False,'runtimeReplaced':False,
            **({'browserOrigin':self.browser_origin} if self.browser_origin else {})}
        self.worker_done.set();migrate.write_json(self.directory,'p2-certification-current-ready.json',self.ready)
        self._start_boundary_watch()
        return self.ready

    def _prepare_lifecycle_stages(self,mode):
        if mode=='browser-pending':
            self.suspension_stage=P2LifecycleSuspensionEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,
                self.initial['browserPlan'],self.initial['persistenceReviewed'],self.initial['browserResources'])
            self.suspension_stage.register_source_parent(self.initial['sourceParentChallenge'])
        if mode=='direct-worker':
            self.worker_stage=P2LifecycleWorkerEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,self.initial['workerPlan'],
                self.initial['sourceSuspensionPlan'],self.initial['persistenceReviewed'],native_context=self._native_context(),provider_client=LockedClient(self.vercel,self.check),
                observe_frontend=lambda:self.observer.probe('witness'))

    def _verify_boundary(self):
        self.scope.require_frontend(self.selected,self.jobs['frontend']);self.scope.require_configuration(self.configuration)
        if self.known_ack_boundary is not None:
            self.known_ack_boundary.verify_healthy_boundary()
            if time.monotonic()-self.last_api_verified>=10:self._refresh_api()
            self.last_boundary=time.monotonic();return
        if self.known_ack_recorder is not None:self.known_ack_recorder.verify_backend_idle()
        token=runtime._command_scope.set(self.scope)
        try:require(runtime.check_containers(self.selected,self.configuration,**self.profile_arguments())==self.runtime_current,'P2_CERTIFICATION_RUNTIME_CHANGED')
        finally:runtime._command_scope.reset(token)
        require(self._runtime_processes()==self.process_snapshot,'P2_CERTIFICATION_PROCESS_OR_MOUNT_CHANGED')
        self._verify_gateway_boundary()
        if self.initial['certificationPlan']['mode']=='contain-native':
            native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check),**self.profile_arguments())
        elif self.initial['certificationPlan']['mode'] in SCOPED_MODES:
            self.require_scoped_native_off()
        else:
            # The same source mutex serializes toggles and healthy readbacks.
            # A provider enable or feature/writer drift outside our declared
            # action must revoke the stage, including browser/authentication.
            with self.native_mutex:
                expected=False if self.initial['certificationPlan']['mode'] in ('auth-preparation','browser-pending','direct-worker') else self.native_expected
                require(self._native_observe()['nativeEnabled'] is expected,'P2_CERTIFICATION_NATIVE_STATE_DRIFT')
                if self.initial['certificationPlan']['mode'] in ('auth-preparation','browser-pending'):
                    self.browser_origin=self._observe_browser_origin()
        if time.monotonic()-self.last_api_verified>=10:self._refresh_api()
        self.last_boundary=time.monotonic()

    def _refresh_api(self):
        with self.api_mutex:
            self.api_cycle+=1;directory=self.directory/('current-api-'+str(self.api_cycle));directory.mkdir(mode=0o700)
            for service in ('course','community'):observe_certification_api(self.scope,self.jobs,self.source,service,directory)
            self.last_api_verified=time.monotonic()

    def _start_boundary_watch(self):
        def watch():
            while not self.boundary_stop.wait(2):
                try:self._verify_boundary()
                except BaseException:self.abort();return
        self.boundary_thread=threading.Thread(target=watch,daemon=True);self.boundary_thread.start()

    def native_operation(self,operation,request):
        self.check();require(self.external_armed,'P2_CERTIFICATION_MUTATION_BEFORE_ARM_REFUSED')
        context=self._native_context();client=LockedClient(self.vercel,self.check)
        if operation=='native-observe':return self._native_observe()
        if operation=='native-metadata':return native.observe_metadata(context,client,**self.profile_arguments())
        require(operation=='native-toggle' and type(request.get('enabled')) is bool,'P2_CERTIFICATION_FIXED_NATIVE_OPERATION_REQUIRED')
        require(self.initial['certificationPlan']['mode'] not in SCOPED_MODES, 'P2_CERTIFICATION_SCOPED_NATIVE_TOGGLE_REFUSED')
        with self.native_mutex:
            self.check()
            require(request['enabled'] is False or self.initial['certificationPlan']['mode'] not in ('contain-native','auth-preparation','browser-pending','direct-worker'),'P2_CERTIFICATION_ENABLE_FORBIDDEN')
            if request['enabled']:
                require(not self.native_enable_attempted,'P2_CERTIFICATION_ENABLE_ALREADY_ATTEMPTED')
                current=self.observer.probe('witness');admission=current['admission'];plan=self.initial['nativePlan']
                require(admission=={'epoch':str(int(plan['initialEpoch'])+1),'newWork':False,'recovery':True,'active':0,'uncertain':0},'P2_CERTIFICATION_NATIVE_EPOCH_BARRIER_REQUIRED')
                require(any(row['status']!='acknowledged' for row in current['witness']['deliveries']),'P2_CERTIFICATION_ACTUAL_PENDING_DELIVERY_REQUIRED')
                gateway_current=self._gateway_current();gateway=gateway_current['admission']
                require(gateway.get('newWork') is False and gateway.get('recovery') is True and all(gateway[category][key]==0 for category in ('active','uncertain') for key in ('newWork','recovery')),
                    'P2_CERTIFICATION_NATIVE_GATEWAY_BARRIER_REQUIRED')
                if self.certification_profile() is not None and self.initial['certificationPlan']['mode'] in ('fault-before-upstream','known-ack-recovery'):
                    require(self.fault_stage is not None and self.fault_stage.lease_sha256 is not None and gateway_current['faultLeasePresent'] is True,
                        'P2_PROFILED_CERTIFICATION_NATIVE_FAULT_ARM_REQUIRED')
                self.native_enable_attempted=True
            elif native.observe_metadata(context,client,**self.profile_arguments())['nativeEnabled'] is False:
                self.native_expected=False
                return {'status':'P2_NATIVE_ALREADY_DISABLED','observation':native.observe_metadata(context,client,**self.profile_arguments())}
            attempt=self.directory/('provider-'+('enable' if request['enabled'] else 'disable')+'-'+str(request['id']));attempt.mkdir(mode=0o700)
            observed=native.set_enabled(context,client,request['enabled'],attempt,self.check,**self.profile_arguments())
            self.native_expected=request['enabled'];return observed

    def _native_observe(self):
        result=native.observe(self._native_context(),LockedClient(self.vercel,self.check),**self.profile_arguments())
        frontend_probe._private_input(_private_probe_directory(self.action_id()),self._probe_identity(),**self.profile_arguments())
        return result

    def _verify_gateway_boundary(self):
        return self._gateway_current()

    def _observe_browser_origin(self):
        # Both provider and protected alias HTTPS calls retain the source/physical
        # verifier. No old phase2 fallback or private-probe renewal is allowed.
        result=canonical_browser.observe(self._native_context(),LockedClient(self.vercel,self.check),
            probe=LockedProbe(self.check,canonical_browser.CanonicalBrowserProbeClient()),**self.profile_arguments())
        require(result['browserOrigin']==self.initial['browserPlan']['browserOrigin'],'P2_CERTIFICATION_CANONICAL_BROWSER_PLAN_REQUIRED')
        return result

    def _retain_browser_observation(self,stage):
        require(stage in ('arm','authentication','suspension','terminal'),'P2_CERTIFICATION_FIXED_CANONICAL_STAGE_REQUIRED')
        observation=self._observe_browser_origin()
        migrate.write_json(self.directory,'p2-canonical-browser-'+stage+'.json',observation)
        return {'canonicalBrowserObservation':observation,'canonicalBrowserObservationSha256':_sha(_canonical(observation))}

    def _runtime_processes(self):
        rows=[]
        expected_mounts={'gateway':{'/config/gateway.json':'gateway.json','/admission':'admission','/tls':'tls/gateway'},
            'course-tls':{'/config/course-tls.json':'course-tls.json','/tls':'tls/course'},'community-tls':{'/config/community-tls.json':'community-tls.json','/tls':'tls/community'},
            'course-publisher':{'/tls/ca.pem':'tls/ca.pem'},'community-api':{'/tls/ca.pem':'tls/ca.pem'},'community-worker':{'/tls/ca.pem':'tls/ca.pem'}}
        for row in self.runtime_current:
            result=self.scope.run(['docker','inspect','--format','{{.State.Pid}}|{{.State.StartedAt}}|{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}',row['containerId']],
                env=runtime.SAFE_ENV,timeout=15,capture_output=True,check=True)
            require(not result.stderr and len(result.stdout)<=16384,'P2_CERTIFICATION_RUNTIME_PROCESS_READBACK_REQUIRED')
            fields=result.stdout.decode().strip().split('|',3);require(len(fields)==4 and fields[0].isdigit() and int(fields[0])>0 and fields[2]=='true','P2_CERTIFICATION_RUNTIME_PROCESS_REQUIRED')
            mounts=json.loads(fields[3]);expected=expected_mounts.get(row['service'],{});actual={}
            for mount in mounts:
                destination=mount.get('Destination');require(destination not in actual,'P2_CERTIFICATION_MOUNT_DUPLICATE')
                if mount.get('Type')=='tmpfs' and destination=='/tmp':continue
                require(destination in expected and mount.get('Type')=='bind' and mount.get('RW') is False and mount.get('Source')==str(self.configuration/expected[destination]),'P2_CERTIFICATION_MOUNT_CHANGED')
                actual[destination]=mount['Source']
            require(set(actual)==set(expected),'P2_CERTIFICATION_MOUNT_MISSING')
            rows.append({'service':row['service'],'containerId':row['containerId'],'pid':fields[0],'startedAt':fields[1],'mounts':actual})
        return rows

    def _gateway_observation(self):
        current=os.stat(self.configuration/'admission',follow_symlinks=False);opened=os.fstat(self.admission_fd)
        require(stat.S_ISDIR(current.st_mode) and current.st_dev==opened.st_dev==self.admission_identity.st_dev and current.st_ino==opened.st_ino==self.admission_identity.st_ino,
            'P2_CERTIFICATION_ADMISSION_MOUNT_CHANGED')
        gateway=next(row for row in self.runtime_current if row['service']=='gateway')
        result=self.scope.run(['docker','exec','--workdir','/app',gateway['containerId'],'node','--input-type=module','--eval',GATEWAY_OBSERVER],env=runtime.SAFE_ENV,timeout=10,capture_output=True,check=True)
        require(not result.stderr and 0<len(result.stdout)<=16384,'P2_CERTIFICATION_GATEWAY_READBACK_REQUIRED')
        value=json.loads(result.stdout);plan=self.initial['certificationPlan']
        require(value.get('status')=='P2_FAULT_GATEWAY_CURRENT' and value.get('processSha256')==(self.known_ack_new_gateway_process or plan['gatewayProcessSha256']) and
            value.get('gatewayConfigurationSha256')==plan['gatewayConfigurationSha256'] and value.get('faultModuleSha256')==_sha(migrate.read_input(self.source,'ops/gateway/p2-certification-fault.mjs')) and
            value.get('admissionDirectory')=={'device':str(opened.st_dev),'inode':str(opened.st_ino)},'P2_CERTIFICATION_EXACT_GATEWAY_REQUIRED')
        return value

    def _gateway_current(self):
        value = self._gateway_observation()
        require(value.get('admission', {}).get('valid') is True, 'P2_CERTIFICATION_ORDINARY_GATEWAY_STATE_REQUIRED')
        return value

    def gateway_stage(self,stage):
        self.check();require(self.external_armed and stage in ('closed','recovery','browser'),'P2_CERTIFICATION_GATEWAY_STAGE_REQUIRED')
        require(self.initial['certificationPlan']['mode'] not in SCOPED_MODES, 'P2_CERTIFICATION_SCOPED_GATEWAY_STAGE_REFUSED')
        flags={'closed':(False,False),'recovery':(False,True),'browser':(True,False)}[stage]
        observed=self.observer.probe('observe')['admission']
        require(observed['newWork'] is flags[0] and observed['recovery'] is flags[1],'P2_CERTIFICATION_FE_GATEWAY_ORDER_REQUIRED')
        before=self._gateway_current()['admission']
        if stage=='recovery':
            require(self.initial['certificationPlan']['mode']!='contain-native' and observed['active']==observed['uncertain']==0 and
                all(before[category][key]==0 for category in ('active','uncertain') for key in ('newWork','recovery')),
                'P2_CERTIFICATION_GATEWAY_DRAIN_REQUIRED')
        if stage=='browser':
            require(self.initial['certificationPlan']['mode'] in ('auth-preparation','browser-pending') and observed['uncertain']==0 and all(before['uncertain'][key]==0 for key in ('newWork','recovery')),
                'P2_CERTIFICATION_BROWSER_GATEWAY_REQUIRED')
        digest=staging_admission.persist_state(self.configuration,{'releaseId':self.selected['releaseId'],'candidateSha256':self.initial['candidateSha256']},
            'p2-certification-'+self.action_id()+'-'+stage,new_work=flags[0],recovery=flags[1])
        after=self._gateway_current()['admission']
        require(after.get('sha256')==digest and after.get('newWork') is flags[0] and after.get('recovery') is flags[1],'P2_CERTIFICATION_GATEWAY_READBACK_REQUIRED')
        return {'status':'P2_CERTIFICATION_GATEWAY_STAGE_OBSERVED','stage':stage,'gateway':after}

    def fault_operation(self,operation,request):
        self.check();plan=request.get('plan');cert=self.initial['certificationPlan']
        require(self.external_armed and cert['mode'] in ('fault-before-upstream','fault-drop-after-ack','known-ack-recovery') and isinstance(plan,dict) and
            plan.get('mode')==('503-before-upstream' if cert['mode']=='fault-before-upstream' else 'drop-after-ack') and
            plan.get('nativePlanSha256')==self.initial['nativePlan']['planSha256'] and plan.get('operatorSourceCommit')==self.initial['sourceCommit'] and
            plan.get('configurationSha256')==cert['configurationCanonicalSha256'] and plan.get('gatewayProcessSha256')==cert['gatewayProcessSha256'] and
            plan.get('gatewayConfigurationSha256')==cert['gatewayConfigurationSha256'] and plan.get('operatorSourceClosureSha256')==self.initial['sourceClosureSha256'],
            'P2_CERTIFICATION_FIXED_FAULT_SELECTION_REQUIRED')
        selection=cert['faultSelection']
        require(plan.get('stageId')==selection['stageId'] and plan.get('receiver')==selection['receiver'] and plan.get('commandSha256')==selection['commandSha256'] and
            plan.get('commandSelectionSha256')==_sha(_canonical({'nativePlanSha256':self.initial['nativePlan']['planSha256'],'commandIndex':selection['commandIndex']})),
            'P2_CERTIFICATION_REVIEWED_FAULT_SELECTION_CHANGED')
        if operation=='fault-initialize':
            require(self.fault_stage is None,'P2_CERTIFICATION_FAULT_ALREADY_SELECTED')
            self.fault_stage=P2CertificationFaultStage(self.scope,self.selected,self.jobs,self.configuration,self.source,plan,self.directory/'fault',
                source_files=self.initial['sourceSha256'],**self.profile_arguments())
            return {'status':'P2_CERTIFICATION_FAULT_READY'}
        require(self.fault_stage is not None and self.fault_stage.plan==plan,'P2_CERTIFICATION_FAULT_STAGE_CHANGED')
        if operation=='fault-verify':self.fault_stage.verify();return {'verified':True}
        if operation=='fault-observe':return self.fault_stage.observe()
        if operation=='fault-arm':
            require(cert['mode']!='known-ack-recovery','P2_CERTIFICATION_KNOWN_ACK_SOURCE_ARM_REQUIRED')
            actual=self.observer.probe('witness')['witness']['commands'];record=request.get('record')
            require(isinstance(record,dict) and any(row['commandId']==record.get('commandId') and row['accountVersion']==str(record.get('accountVersion')) and
                row['canonicalSha256']==record.get('canonicalSha256')==plan['commandSha256'] for row in actual),'P2_CERTIFICATION_FAULT_ACTUAL_COMMAND_REQUIRED')
            return self.fault_stage.arm(record)
        if operation=='fault-effects':return self.fault_stage.effects()
        if operation=='fault-disarm':return self.fault_stage.disarm()
        if operation=='fault-close-gateway':return self.fault_stage.close_gateway()
        raise ValueError('P2_CERTIFICATION_FIXED_FAULT_OPERATION_REQUIRED')

    def _request_evidence(self,value,witness):
        if value is None:return {'qualified':False,'authority':'operator-details-missing','artifactSha256':None,'requestCount':0}
        raw,artifact=decode(value)
        keys={'version','kind','reviewerGithubUserId','certificationActionId','nativePlanSha256','windowEpoch','recordedAt','observations'}
        plan=self.initial['nativePlan'];window=str(int(plan['initialEpoch'])+1)
        require(set(artifact)==keys and artifact['version']==1 and artifact['kind']=='operator-recorded-request-details' and artifact['reviewerGithubUserId']=='8996309' and
            artifact['certificationActionId']==self.action_id() and artifact['nativePlanSha256']==plan['planSha256'] and artifact['windowEpoch']==window and
            isinstance(artifact['observations'],list) and 0<len(artifact['observations'])<=4096,'P2_CERTIFICATION_EXPLICIT_REQUEST_DETAILS_REQUIRED')
        _iso(artifact['recordedAt'])
        fields={'version','kind','reviewerGithubUserId','projectId','deploymentId','path','method','providerRequestTypeFilter','providerRequestId','startedAt','completedAt','httpStatus','logScope','admittedLogLine'}
        event_fields={'version','status','environment','projectId','operationId','producerSha256','sourceCommit','epoch','kind','targetSha256'}
        events=[];ids=set()
        for row in artifact['observations']:
            require(isinstance(row,dict) and set(row)==fields and row['version']==1 and row['kind']=='vercel-native-request-details' and row['reviewerGithubUserId']=='8996309' and
                row['projectId']==plan['projectId'] and row['deploymentId']==plan['deploymentId'] and row['path']==native.PATH and row['method']=='GET' and
                row['providerRequestTypeFilter']=='cron' and row['logScope']=='this-provider-request-details' and row['httpStatus'] in (200,503) and
                isinstance(row['providerRequestId'],str) and re.fullmatch(r'[A-Za-z0-9:._-]{1,200}',row['providerRequestId']) and row['providerRequestId'] not in ids,'P2_CERTIFICATION_REQUEST_SCOPE_REFUSED')
            ids.add(row['providerRequestId'])
            require(_iso(row['completedAt'])>=_iso(row['startedAt']),'P2_CERTIFICATION_REQUEST_TIME_ORDER_REQUIRED')
            if row['admittedLogLine'] is None:require(row['httpStatus']==503,'P2_CERTIFICATION_REQUEST_LOG_REQUIRED');continue
            require(isinstance(row['admittedLogLine'],str) and len(row['admittedLogLine'])<=2048,'P2_CERTIFICATION_REQUEST_LOG_BOUNDS')
            event=json.loads(row['admittedLogLine'])
            require(set(event)==event_fields and event['version']==1 and event['status']=='P2_LIFECYCLE_CRON_ADMITTED' and event['environment']=='staging' and
                event['projectId']==plan['projectId'] and event['producerSha256']==plan['producer']['producerSha256'] and event['sourceCommit']==plan['sourceCommit'] and
                event['targetSha256']==plan['targetSha256'] and event['epoch']==window and event['kind']=='recovery','P2_CERTIFICATION_ADMITTED_EVENT_REFUSED')
            require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',event.get('operationId','')),'P2_CERTIFICATION_OPERATION_ID_REQUIRED')
            events.append((event,row['httpStatus']))
        operations=witness['operations']
        known_503 = self.certification_profile() is not None and self.initial['certificationPlan']['mode']=='fault-before-upstream'
        expected_statuses = (200,503) if known_503 else (200,)
        matched=bool(events and len(operations)==len(events) and len({event['operationId'] for event,_ in events})==len(events) and all(
            row['kind']=='recovery' and row['state']=='completed' and row['completed_at'] is not None and row['reconciliation_sha256'] is None and row['epoch']==window and
            row['producer_sha256']==plan['producer']['producerSha256'] and row['source_sha']==plan['sourceCommit'] and row['role_oid']==plan['producer']['role']['oid'] and
            any(event['operationId']==row['id'] and status in expected_statuses for event,status in events) for row in operations))
        name='p2-certification-operator-request-details.json'
        descriptor=os.open(self.directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            remaining=raw
            while remaining:remaining=remaining[os.write(descriptor,remaining):]
            os.fsync(descriptor)
        finally:os.close(descriptor)
        return {'qualified':matched,'authority':'operator-recorded-request-details','artifactSha256':_sha(raw),'requestCount':len(ids),'automaticProviderEvidence':False,
            **({'retryableFailureCorrelated':matched and sum(status==503 for _,status in events)==1} if known_503 else {})}

    def authentication_stage(self,value):
        self.check();cert=self.initial['certificationPlan'];plan=self.initial['browserPlan']
        require(self.external_armed and cert['mode']=='auth-preparation' and not self.authentication_issued and
            value.get('bindingSha256')==_sha(_canonical(plan)) and re.fullmatch(r'[a-f0-9]{64}',self.initial.get('sourceParentChallenge','')),
            'P2_CERTIFICATION_SOURCE_AUTHENTICATION_STAGE_REQUIRED')
        physical=self.observer.probe('witness')['admission'];gateway=self._gateway_current()['admission']
        require(physical['epoch']==str(int(cert['initialEpoch'])+1) and physical['newWork'] is True and physical['recovery'] is False and physical['uncertain']==0 and
            gateway['newWork'] is True and gateway['recovery'] is False and all(gateway['uncertain'][key]==0 for key in ('newWork','recovery')),
            'P2_CERTIFICATION_AUTHENTICATION_STATE_REQUIRED')
        require(native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check),**self.profile_arguments())['nativeEnabled'] is False,'P2_CERTIFICATION_AUTHENTICATION_NATIVE_OFF_REQUIRED')
        canonical=self._retain_browser_observation('authentication');self.browser_origin=canonical['canonicalBrowserObservation']
        self.authentication_issued=True
        return {'status':'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD','bindingSha256':_sha(_canonical(plan)),'certificationActionId':self.action_id(),**canonical}

    def suspension_operation(self,operation,value):
        self.check();stage=self.suspension_stage
        require(self.external_armed and self.initial['certificationPlan']['mode']=='browser-pending' and stage is not None,'P2_CERTIFICATION_SOURCE_BROWSER_STAGE_REQUIRED')
        if operation=='suspension-ready':
            require(value.get('bindingSha256')==_sha(_canonical(self.initial['browserPlan'])),'P2_CERTIFICATION_BROWSER_BINDING_REQUIRED')
            stage.verify();canonical=self._retain_browser_observation('suspension');self.browser_origin=canonical['canonicalBrowserObservation']
            return {'bindingSha256':value['bindingSha256'],**canonical}
        if operation=='suspension-controlled':return stage.capture_controlled()
        if operation=='suspension-natural-expiry':return stage.capture_natural_expiry(value.get('event'))
        if operation=='suspension-retain-browser':
            raw=base64.b64decode(value.get('artifact',''),validate=True)
            self.browser_retained=stage.retain_browser_from_source_parent(raw);return self.browser_retained
        if operation=='suspension-pending':
            self.pending_retained=stage.retain_pending_from_source_parent(value.get('record'));return self.pending_retained
        raise ValueError('P2_CERTIFICATION_FIXED_BROWSER_OPERATION_REQUIRED')

    def worker_operation(self,operation,value):
        self.check();stage=self.worker_stage
        require(self.external_armed and self.initial['certificationPlan']['mode']=='direct-worker' and stage is not None,'P2_CERTIFICATION_SOURCE_WORKER_STAGE_REQUIRED')
        if operation=='worker-ready':stage.verify();return {'bindingSha256':self.initial['certificationPlan']['workerPlanSha256']}
        if operation=='worker-credential':return stage.preflight_credential(value.get('secret'))
        if operation=='worker-invoke':return stage.invoke_direct(value.get('secret'))
        if operation=='worker-witness':return stage.observe_lifecycle_witness(value.get('runtimeUrl'))
        if operation=='worker-denials':return stage.observe_receiver_denials()
        if operation=='worker-final-closed':return stage.final_closed_readback()
        if operation=='worker-retain':
            raw,record=decode(value.get('sourceArtifact'));require(len(raw)<=262144 and record==value.get('record'),'P2_CERTIFICATION_WORKER_SOURCE_BYTES_REQUIRED')
            self.worker_retained=stage.retain_joined_from_source_parent(record);self.worker_source_sha256=_sha(raw);return self.worker_retained
        raise ValueError('P2_CERTIFICATION_FIXED_WORKER_OPERATION_REQUIRED')

    def known_ack_operation(self,operation,value):
        self.check();cert=self.initial['certificationPlan']
        expected=self.certification_profile();profile_fields={} if expected is None else {'version':2,'qualificationTargetProfile':expected}
        require(self.external_armed and cert['mode']=='known-ack-recovery','P2_CERTIFICATION_FIXED_KNOWN_ACK_MODE_REQUIRED')
        import p2_known_ack_loss as known
        if operation=='known-prepare':
            require(self.known_ack_recorder is None and self.fault_stage is not None,'P2_CERTIFICATION_KNOWN_ACK_ISSUER_ALREADY_USED')
            self.known_ack_recorder=known.P2KnownAckLossRecorder(self,cert['knownAckRecovery']['recoveryActionId'],cert['knownAckReceiverTargets'],**self.profile_arguments())
            return {**profile_fields,'status':'P2_KNOWN_ACK_SOURCE_STAGE_PREPARED','bindingSha256':cert['planSha256'],'baselineSha256':self.known_ack_recorder.baseline_sha256}
        recorder=self.known_ack_recorder;require(recorder is not None,'P2_CERTIFICATION_KNOWN_ACK_SOURCE_ISSUER_REQUIRED')
        if operation=='known-arm':
            recorder._verify();known.validate_baseline(recorder.plan,recorder._snapshot())
            require(self._native_observe()['nativeEnabled'] is False,'P2_CERTIFICATION_KNOWN_ACK_NATIVE_OFF_BEFORE_ARM')
            observed=self.fault_stage.arm({'commandId':recorder.command['commandId'],'accountVersion':int(recorder.command['accountVersion']),'canonicalSha256':recorder.plan['commandSha256']})
            recorder._verify();return observed
        if operation=='known-start-window':recorder.start_native_window();return {**profile_fields,'status':'P2_KNOWN_ACK_NATIVE_WINDOW_STARTED'}
        if operation=='known-domain':return recorder.observe_domain()
        if operation=='known-requests':return recorder.retain_request_details(value.get('requestArtifact'))
        if operation=='known-settlement':return recorder.prepare_reconciliation()
        if operation=='known-confirm-settlement':
            require(expected is not None and self.known_ack_reconciliation is None,'P2_CERTIFICATION_PROFILED_SETTLEMENT_ALREADY_ATTEMPTED')
            self.known_ack_reconciliation=recorder.confirm_reconciliation()
            return copy.deepcopy(self.known_ack_reconciliation)
        if operation=='known-replace':
            require(not self.known_ack_replace_attempted and self.known_ack_boundary is None,'P2_CERTIFICATION_KNOWN_ACK_REPLACEMENT_ALREADY_ATTEMPTED')
            self.known_ack_replace_attempted=True
            if expected is None:
                authorization=recorder.authorize_replacement()
                boundary=known.issue_known_ack_loss_boundary(self,authorization)
                self.known_ack_boundary=boundary
                restored=known.KnownAckRecoveryRuntime(known.KnownAckRecoveryScope(boundary))
            else:
                require(self.known_ack_reconciliation is not None,'P2_CERTIFICATION_PROFILED_SETTLEMENT_REQUIRED')
                authorization=recorder.authorize_profiled_replacement()
                boundary=known.issue_profiled_known_ack_loss_boundary(self,authorization)
                self.known_ack_boundary=boundary
                restored=known.ProfiledKnownAckRecoveryRuntime(known.ProfiledKnownAckRecoveryScope(boundary))
            outcome=restored.restore()
            if expected is not None:
                vercel.require_record_profile(expected,outcome)
                require_certification_replacement_lineage(cert, outcome)
                require(outcome['recoveryIntentSha256']==cert['knownAckRecovery']['intentSha256'] and
                    outcome['frontendOperationId']==self.known_ack_reconciliation['operationId'] and
                    outcome['frontendJournalSha256']==self.scope.receipt['journalSha256'] and
                    outcome['originalGatewayUncertaintyPreserved'] is True and
                    outcome['runtimeReplacements']==1 and outcome['sqlReplayed'] is False and
                    restored.snapshot==boundary.snapshot and boundary.finished,
                    'P2_PROFILED_CERTIFICATION_KNOWN_ACK_OUTCOME_REQUIRED')
            self.configuration=self.runtime_snapshot=restored.snapshot;self.runtime_current=outcome['containers']
            new_admission_fd=os.open(self.configuration/'admission',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            if self.admission_fd is not None:os.close(self.admission_fd)
            self.admission_fd=new_admission_fd;self.admission_identity=os.fstat(new_admission_fd)
            self.process_snapshot=self._runtime_processes()
            gateway=next(row for row in self.runtime_current if row['service']=='gateway')
            observed=self.scope.run(['docker','exec','--workdir','/app',gateway['containerId'],'node','--input-type=module','--eval',GATEWAY_OBSERVER],
                env=runtime.SAFE_ENV,timeout=10,capture_output=True,check=True)
            require(not observed.stderr and 0<len(observed.stdout)<=16384,'P2_CERTIFICATION_KNOWN_ACK_NEW_GATEWAY_PROOF_REQUIRED')
            actual=json.loads(observed.stdout);require(actual.get('status')=='P2_FAULT_GATEWAY_CURRENT' and re.fullmatch(r'[a-f0-9]{64}',actual.get('processSha256','')),
                'P2_CERTIFICATION_KNOWN_ACK_NEW_PROCESS_REQUIRED')
            self.known_ack_new_gateway_process=actual['processSha256']
            current=self._gateway_current()
            if expected is not None:
                require(current['processSha256']!=cert['gatewayProcessSha256'] and current['faultLeasePresent'] is False and
                    current['admission'].get('valid') is True and
                    all(current['admission'].get(key)==value for key,value in outcome['newGateway']['admission'].items()) and
                    outcome['newGateway']['process']['containerId']==gateway['containerId'] and
                    outcome['newGateway']['binding']['configurationDirectory']==str(self.configuration),
                    'P2_PROFILED_CERTIFICATION_KNOWN_ACK_NEW_GATEWAY_REQUIRED')
            self._verify_boundary()
            self.known_ack_outcome=outcome
            migrate.write_json(self.directory,'known-ack-replacement-joined.json',outcome)
            return copy.deepcopy(outcome)
        raise ValueError('P2_CERTIFICATION_FIXED_KNOWN_ACK_OPERATION_REQUIRED')

    def _require_worker_outcome(self,case):
        cert=self.initial['certificationPlan']
        expected=self.certification_profile()
        fields={'version','status','workerPlanSha256','workerSourceArtifactSha256','workerMachineArtifactSha256'}
        if expected is not None:
            fields.add('qualificationTargetProfile')
            vercel.require_record_profile(expected,case)
        require(self.worker_stage is not None and self.worker_retained and set(case)==fields and
            case['version']==(2 if expected is not None else 1) and case['status']=='P2_CERTIFICATION_DIRECT_WORKER_JOINED' and case['workerPlanSha256']==cert['workerPlanSha256'] and
            case['workerMachineArtifactSha256']==self.worker_retained['privateRecordSha256'] and case['workerSourceArtifactSha256']==self.worker_source_sha256,
            'P2_CERTIFICATION_SOURCE_WORKER_JOIN_REQUIRED')
        self.worker_stage.final_closed_readback()

    def prepare_close(self,request):
        self.check();require(self.external_armed and self.closing_at is None,'P2_CERTIFICATION_CLOSE_ALREADY_PREPARED')
        self._verify_boundary();self._refresh_api()
        physical=self.observer.probe('witness');admission=physical['admission'];witness=physical['witness'];cert=self.initial['certificationPlan']
        require(admission['newWork'] is False and admission['recovery'] is False and admission['active']==0,'P2_CERTIFICATION_FINAL_FRONTEND_CLOSED_REQUIRED')
        gateway=self._gateway_current();state=gateway['admission']
        require(state.get('newWork') is False and state.get('recovery') is False and all(state.get('active',{}).get(key)==0 for key in ('newWork','recovery')) and gateway['faultLeasePresent'] is False,
            'P2_CERTIFICATION_FINAL_GATEWAY_CLOSED_REQUIRED')
        known=None
        if admission['uncertain']:
            require(cert['mode']=='fault-drop-after-ack' and admission['uncertain']==1 and state['uncertain']=={'newWork':0,'recovery':1} and self.fault_stage is not None,'P2_CERTIFICATION_UNRELATED_UNCERTAINTY_REFUSED')
            effects=self.fault_stage.effects();unknown=[row for row in witness['operations'] if row['state']=='uncertain']
            require(len(effects)==1 and effects[0]['mode']=='drop-after-ack' and effects[0]['upstreamReceiptVerified'] is True and len(unknown)==1 and
                unknown[0]['source_sha']==cert['sourceCommit'] and unknown[0]['producer_sha256']==cert['nativePlan']['producer']['producerSha256'] and unknown[0]['kind']=='recovery',
                'P2_CERTIFICATION_KNOWN_ACK_LOSS_REQUIRED')
            known={'operationId':unknown[0]['id'],'effect':effects[0],'oldGatewayProcessSha256':cert['gatewayProcessSha256'],'gatewayUncertain':state['uncertain'],
                'frontendUncertain':1,'automaticReconciliationAllowed':False,'recoveryAuthorized':False}
        else:require(all(state.get('uncertain',{}).get(key)==0 for key in ('newWork','recovery')),'P2_CERTIFICATION_GATEWAY_UNCERTAINTY_REFUSED')
        if cert['mode']=='known-ack-recovery':
            require(self.known_ack_outcome is not None and self.known_ack_recorder.request_evidence is not None,'P2_CERTIFICATION_KNOWN_ACK_JOIN_REQUIRED')
            evidence={**self.known_ack_recorder.request_evidence['provenance'],'qualified':False,'knownAckCorrelationVerified':True}
        else:evidence=self._request_evidence(request.get('requestEvidence'),witness)
        case=request.get('caseOutcome');require(isinstance(case,dict) and re.fullmatch(r'P2_[A-Z0-9_]{1,100}',case.get('status','')),'P2_CERTIFICATION_SOURCE_CASE_OUTCOME_REQUIRED')
        if cert['mode']=='auth-preparation':
            require(self.authentication_issued and set(case)=={'version','status','browserPlanSha256'} and case['version']==1 and
                case['status']=='P2_CERTIFICATION_AUTHENTICATION_PREPARED' and case['browserPlanSha256']==cert['browserPlanSha256'],
                'P2_CERTIFICATION_SOURCE_AUTHENTICATION_OUTCOME_REQUIRED')
        if cert['mode']=='browser-pending':
            require(self.suspension_stage is not None and self.browser_retained and self.pending_retained and
                set(case)=={'version','status','browserPlanSha256','browserRecordSha256','pendingRecordSha256','workerInvoked'} and case['version']==1 and
                case['status']=='P2_CERTIFICATION_BROWSER_PENDING_CAPTURED' and case['browserPlanSha256']==cert['browserPlanSha256'] and case['workerInvoked'] is False and
                case['browserRecordSha256']==self.browser_retained['recordSha256'] and case['pendingRecordSha256']==self.pending_retained['recordSha256'],
                'P2_CERTIFICATION_SOURCE_BROWSER_PENDING_OUTCOME_REQUIRED')
            self.suspension_stage.scrub_controlled_credentials()
        if cert['mode']=='direct-worker':
            self._require_worker_outcome(case)
        if cert['mode'] in SCOPED_MODES:
            expected_epoch = int(cert['initialEpoch']) + (2 if cert['mode'] in ('export-cleanup', 'interactive-browser') else 0)
            require(case == self.scoped_case and admission['epoch'] == str(expected_epoch) and admission['uncertain'] == 0,
                    'P2_CERTIFICATION_SCOPED_CASE_OUTCOME_REQUIRED')
        if cert['mode'] == 'interactive-browser':
            from p2_interactive_window import browser_artifact
            retained = json.loads(migrate.read_input(self.directory, browser_artifact(cert, 'ledger')))
            require(case['frontendAdmission'] == admission and _sha(_profiled_compact(retained)) == physical['witnessSha256'],
                    'P2_INTERACTIVE_TERMINAL_WITNESS_CHANGED')
        if cert['mode']=='fault-before-upstream' and self.certification_profile() is not None:
            self._require_profiled_before_upstream(case,evidence)
        if cert['mode']=='known-ack-recovery':
            require(case==self.known_ack_outcome and case['status']=='P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED' and self.known_ack_boundary.finished,
                'P2_CERTIFICATION_KNOWN_ACK_RUNTIME_OUTCOME_REQUIRED')
            known={'operationId':self.known_ack_recorder.domain['operationId'],'domainSha256':self.known_ack_recorder.domain_sha256,
                'settlementSha256':self.known_ack_recorder.settlement_sha256,'oldGatewayUncertain':{'newWork':0,'recovery':1},
                'recoveryActionId':cert['knownAckRecovery']['recoveryActionId'],'ordinaryClosedZeroGate':False,'replacementCompletedClosed':True}
        initial=json.loads(self.frontend_raw)['witness']['deliveries']
        ordered=not witness['orderViolations'] and all(row['status']=='acknowledged' and row['acknowledged_at'] is not None and row['lease_until'] is None for row in witness['deliveries']) and any(
            row['attempts']>old['attempts'] and old['status']!='acknowledged' for row in witness['deliveries'] for old in initial if row['command_id']==old['command_id'] and row['receiver']==old['receiver'])
        healthy=cert['mode']!='contain-native'
        if healthy:self._native_observe()
        canonical=self._retain_browser_observation('terminal') if cert['mode'] in ('auth-preparation','browser-pending') else None
        final=native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check),**self.profile_arguments());require(final['nativeEnabled'] is False,'P2_CERTIFICATION_FINAL_NATIVE_OFF_REQUIRED')
        qualified=cert['mode']=='native-window' and case.get('status')=='P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED' and evidence['qualified'] and ordered and known is None
        self.prepared_terminal={**{key:cert[key] for key in ('version','environment','certificationActionId','originalReleaseId','sourceCommit','operatorSourceCommit','candidateSha256','candidateObjectSha256',
            'inventorySha256','configurationSha256','targetSha256','contractPhase','phase2ContractManifestSha256','mode','planSha256')},
            'status':'P2_BOUNDED_CERTIFICATION_CONTAINED','nativeDisabled':True,'frontendAdmission':admission,'gatewayAdmission':state,'nativeInvocationQualified':qualified,
            'persistenceAuthorityJoined':False,'deployedCertificationComplete':False,
            'directWorkerSourceJoined':cert['mode']=='direct-worker',
            **({'canonicalBrowserObservationSha256':canonical['canonicalBrowserObservationSha256']} if canonical else {}),
            'caseStatus':case.get('status'),'caseOutcomeSha256':_sha(_canonical(case)),'requestEvidence':evidence,'knownAckLoss':known,'witnessSha256':physical['witnessSha256'],
            'sqlReplayed':False,'runtimeReplaced':cert['mode']=='known-ack-recovery','rolesPrepared':False,'historicalLoginsRestored':False,'frontendBuilt':False,'frontendPromoted':False,
            'providerQueuedInvocations':None,'providerCancellationVerified':False,'trafficAuthorized':False,'wholeReleaseAccepted':False}
        self._bind_terminal_profile()
        migrate.require_contract_identity(self.selected,self.prepared_terminal)
        migrate.write_json(self.directory,'p2-certification-close-prepared.json',self.prepared_terminal)
        self.boundary_stop.set()
        if self.boundary_thread and self.boundary_thread is not threading.current_thread():self.boundary_thread.join(35)
        self.closing_at=time.monotonic();self.observer.stop();self.check();return copy.deepcopy(self.prepared_terminal)

    def _bind_terminal_profile(self):
        return

    def finish_certification(self,value):
        self.check();raw,outcome=decode(value['certification']);migrate.require_contract_identity(self.selected,outcome)
        require(self.closing_at is not None and not self.finished and outcome==self.prepared_terminal,'P2_CERTIFICATION_TERMINAL_BINDING_REQUIRED')
        if self.initial['certificationPlan'].get('scopedAction', {}).get('stage') == 'lesson-resume':
            migrate.write_exact_bytes(self.directory, _RESUME_SOURCE_TERMINAL, raw)
        migrate.write_json(self.directory,'p2-certification-verification.json',outcome);self.outcome=copy.deepcopy(outcome)
        self.finished=True;self.released.set();return self.outcome

    def abort(self):
        already_failed=self.failed.is_set()
        super().abort()
        if already_failed or self.guard_alive or not self.external_armed:return
        # Only this fixed class can enable native schedules. Once failed is
        # sticky, no new toggle can pass check(). Wait for any in-flight toggle
        # to release its mutex before the surviving broker disables metadata.
        acquired=self.native_mutex.acquire(timeout=65)
        self.outcome.update(nativeDisabled=None,nativeDisableAttempted=False)
        if acquired:
            try:self.outcome.update(contain_certification_native(self.initial,self.armed_probe,self.source))
            finally:self.native_mutex.release()
        else:self.outcome['nativeMutatorQuiescenceUncertain']=True
        try:
            from p2_release_supervisor import cleanup_recovery_current_containers
            cleanup_recovery_current_containers()
        except BaseException:self.outcome['recoveryCurrentContainerCleanupUncertain']=True

    def command(self,value):
        identity,operation=value.get('id'),value.get('operation')
        require(type(identity) is int and 0<identity<1_000_000,'P2_CERTIFICATION_PROTOCOL_ID_REQUIRED')
        self.last_command=time.monotonic()
        if operation=='check':self.check();self.send(identity,'HELD');return
        if operation=='arm-certification':self.send(identity,'CERTIFICATION_ARMED',receipt=self.arm(value));return
        if operation=='authentication-stage':self.send(identity,'CERTIFICATION_AUTHENTICATION_HELD',receipt=self.authentication_stage(value));return
        if operation.startswith('suspension-'):
            result=self.suspension_operation(operation,value)
            self.send(identity,'CERTIFICATION_SUSPENSION_READY' if operation=='suspension-ready' else 'CERTIFICATION_SUSPENSION_OBSERVED',receipt=result);return
        if operation.startswith('worker-'):
            result=self.worker_operation(operation,value)
            self.send(identity,'CERTIFICATION_WORKER_READY' if operation=='worker-ready' else 'CERTIFICATION_WORKER_OBSERVED',receipt=result);return
        if operation.startswith('known-'):
            result=self.known_ack_operation(operation,value)
            self.send(identity,'CERTIFICATION_KNOWN_ACK_OBSERVED',receipt=result);return
        if operation.startswith('scoped-'):
            require(type(self) is P2ProfiledCertificationBroker, 'P2_CERTIFICATION_PROFILED_SCOPED_SOURCE_REQUIRED')
            self.send(identity, 'CERTIFICATION_SCOPED_OBSERVED', receipt=self.scoped_operation(operation, value));return
        if operation.startswith('interactive-'):
            require(type(self) is P2ProfiledCertificationBroker, 'P2_INTERACTIVE_PROFILED_SOURCE_REQUIRED')
            result = self.interactive_operation(operation, value)
            if operation == 'interactive-permit':
                self.send(identity, 'CERTIFICATION_INTERACTIVE_PRIVATE', permit=result)
            else:
                self.send(identity, 'CERTIFICATION_INTERACTIVE_OBSERVED', receipt=result)
            return
        if operation.startswith('native-'):
            self.send(identity,'CERTIFICATION_NATIVE_OBSERVED',receipt=self.native_operation(operation,value));return
        if operation=='certification-gateway-stage':self.send(identity,'CERTIFICATION_GATEWAY_OBSERVED',receipt=self.gateway_stage(value.get('stage')));return
        if operation=='certification-gateway-observe':self.check();self.send(identity,'CERTIFICATION_GATEWAY_OBSERVED',receipt=self._gateway_current()['admission']);return
        if operation.startswith('fault-'):
            result=self.fault_operation(operation,value)
            self.send(identity,'CERTIFICATION_FAULT_READY' if operation=='fault-initialize' else 'CERTIFICATION_FAULT_OBSERVED',receipt=result);return
        if operation=='certification-prepare-close':self.send(identity,'CERTIFICATION_CLOSE_PREPARED',receipt=self.prepare_close(value));return
        if operation=='finish':self.send(identity,'P2_CERTIFICATION_JOINED',receipt=self.finish_certification(value));return
        if operation=='commit':
            self.check();require(self.finished,'P2_CERTIFICATION_JOIN_REQUIRED');migrate.write_json(self.directory,self.terminal_filename(),self.outcome)
            raw=migrate.read_input(self.directory,self.terminal_filename());self.safety({'operation':'committed','sha256':_sha(raw)});self.committed.set();self.send(identity,'COMMITTED',receipt=self.outcome);return
        raise ValueError('P2_CERTIFICATION_SOURCE_OPERATION_NOT_INSTALLED')

    def close(self,committed=False):
        self.boundary_stop.set()
        if self.boundary_thread and self.boundary_thread is not threading.current_thread():self.boundary_thread.join(35)
        try:super().close(committed)
        finally:
            if self.suspension_stage is not None:
                try:self.suspension_stage.scrub_controlled_credentials()
                except BaseException:pass
            try:_remove_private_probe(self.initial)
            except BaseException:pass
            if self.admission_fd is not None:os.close(self.admission_fd);self.admission_fd=None



class P2ProfiledCertificationBroker(P2CertificationBroker):
    def certification_profile(self):
        return _profiled_context()

    def failure_profile(self):
        return self.certification_profile()

    def directory_name(self):
        return 'p2-profiled-current-certification-' + self.action_id()

    def terminal_filename(self):
        return 'p2-profiled-current-certification-outcome.json'

    def initialize(self):
        self._initialize_certification_state()
        self.api_proof = None
        self.known_ack_reconciliation = None
        self.authority_timing_sha256 = None
        self.guard_arm_verified = False
        self.fallback_complete = False
        self.failure_lock = threading.RLock()
        self.scoped_gate_lock = threading.RLock()
        self.scoped_stage = self.scoped_case = self.scoped_mux_sha256 = None
        self.media_upload = None
        self.gateway_observation_attempted = False
        initial = self.initial
        plan = initial['certificationPlan']
        mode = plan['mode']
        require(mode in SUSPENSION_MODES | SCOPED_MODES | {'native-window', 'contain-native', 'fault-before-upstream'} or
                mode == 'known-ack-recovery' and 'replacementRelease' in plan,
                'P2_PROFILED_CERTIFICATION_EXECUTION_MODE_UNQUALIFIED')
        if mode == 'interactive-browser':
            from p2_interactive_window import EXECUTABLE_BROWSER_STAGES
            stage = plan.get('scopedAction', {}).get('stage')
            require(type(stage) is str and stage in EXECUTABLE_BROWSER_STAGES, 'P2_PROFILED_INTERACTIVE_EXECUTION_STAGE_UNQUALIFIED')
        review_fields = PROFILED_INITIAL_FIELDS | ({'sourceSuspensionPlan'} if mode in SUSPENSION_MODES else set())
        private_fields = {'confirmation', 'credentials', 'vercelToken'}
        if mode in SCOPED_MODES:
            private_fields.add('scopedCronSecret')
        elif mode != 'contain-native':
            private_fields.add('privateProbe')
        if mode in BROWSER_MODES:
            private_fields.add('sourceParentChallenge')
        if mode == 'interactive-browser':
            private_fields.add('interactiveController')
        if mode == 'browser-pending':
            private_fields.update(('persistenceReviewed', 'browserResources'))
        if mode == 'direct-worker':
            private_fields.add('persistenceReviewed')
        if mode in PERSISTENCE_MODES:
            private_fields.add('persistenceReviewed')
        if mode == 'lifecycle-persistence':
            private_fields.add('persistencePrivate')
        guard_fields = {'_guardLayout', '_guardObserverSource', '_guardObserverProgram', '_guardLockDescriptor'}
        require(set(initial) == review_fields | private_fields | guard_fields and
                initial['confirmation'] == 'staging/' + self.action_id() and
                self.shared_lock_fd is not None and self.shared_lock_fd == initial['_guardLockDescriptor'] and
                self.safety_write is not None and self.guard_read is not None and os.geteuid() == 0,
                'P2_PROFILED_CERTIFICATION_FIXED_GUARDED_START_REQUIRED')
        self.start_parent_watch()
        self.source = Path(__file__).resolve().parents[3]
        review = {key: initial[key] for key in review_fields}
        verified = prepare_profiled_current_certification_input(review, self.source)
        require(verified['originalReleasePlanHashHostVerified'] is True, 'P2_PROFILED_CERTIFICATION_ORIGINAL_PLAN_PROOF_REQUIRED')
        if mode in SCOPED_MODES:
            secret = initial['scopedCronSecret']
            require(type(secret) is str and (32 if mode == 'interactive-browser' else 1) <= len(secret) <= 8192 and
                    re.fullmatch(r'[!-~]+', secret) is not None,
                    'P2_CERTIFICATION_SCOPED_CRON_CREDENTIAL_REQUIRED')
        if mode == 'interactive-browser':
            from p2_interactive_window import verify_browser_controller
            verify_browser_controller(initial, self.source)
        if mode in PERSISTENCE_MODES:
            require(_sha(_canonical(initial['persistenceReviewed'])) == plan['persistenceReviewedSha256'],
                    'P2_PROFILED_PERSISTENCE_REVIEW_CHANGED')
        self.bundle, self.configuration, self.results = (Path(initial[key]) for key in ('bundle', 'configuration', 'results'))
        self.selected, self.jobs, self.plan, _ = runtime.make_plan(self.bundle, self.configuration,
            self.source / 'ops/platform/compose.yaml', **self.profile_arguments())
        course_source = self.selected['sources']['course']['commit']
        from p2_interactive_window import media_upload_selected
        require((mode != 'mux-callback-recovery' and not media_upload_selected(plan)) or
                course_source == SCOPED_MUX_COURSE_SOURCE or course_source in PAID_REVOKE_COURSE_SOURCES,
                'P2_SCOPED_MUX_MANAGED_COURSE_SOURCE_REQUIRED')
        require(mode != 'interactive-browser' or plan['scopedAction']['stage'] != 'paid-revoke' or
                course_source in PAID_REVOKE_COURSE_SOURCES, 'P2_PAID_REVOKE_COURSE_SOURCE_REQUIRED')
        runtime.assert_host(self.plan)
        self.lock_fd = self.shared_lock_fd
        self.lock_info = os.fstat(self.lock_fd)
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, 'P2_INDEPENDENT_GUARD_HANDSHAKE_REQUIRED')
        credentials = initial['credentials']
        require(type(credentials) is dict and set(credentials) == {'FRONTEND_STAGING_MIGRATION_DATABASE_URL',
            'COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL'} and
            all(type(value) is str and 0 < len(value) <= 16384 for value in credentials.values()),
            'P2_PROFILED_CERTIFICATION_CREDENTIALS_REQUIRED')
        self.vercel = vercel.Client(initial['vercelToken'])
        initial['nativePlan'] = plan['nativePlan']
        initial['producers'] = initial['inventory']['producers']
        boundary = 'replacementRelease' if 'replacementRelease' in plan else 'historicalLogins'
        initial[boundary] = initial['inventory'][boundary]
        if mode in BROWSER_MODES:
            initial['browserPlan'] = initial['sourceSuspensionPlan']
        if mode == 'direct-worker':
            initial['workerPlan'] = plan['workerPlan']
        self.directory = self.results / self.directory_name()
        self.directory.mkdir(mode=0o700)
        self.observer_program = private_observer_program(initial, self.directory / 'private-source')
        self.outcome.update(version=2, qualificationTargetProfile=self.certification_profile(),
            environment='staging', releaseId=self.selected['releaseId'], sourceCommit=initial['sourceCommit'],
            candidateSha256=initial['candidateSha256'], frontendSqlApplied=False)
        migrate.write_json(self.directory, 'p2-profiled-certification-input-verified.json', verified)
        self.check()

    def _scope_arguments(self):
        return {**self.profile_arguments(), 'physical_observer': self.observer,
                **({'original_replacement_receipt': base64.b64decode(self.initial['originalReleaseReceipt'], validate=True)}
                   if 'replacementRelease' in self.initial['certificationPlan'] else {})}

    def _accept_guard_arm(self,probe):
        from p2_release_supervisor import require_profiled_certification_guard_arm
        self.safety({'operation':'armed','probe':probe})
        expires = time.monotonic() + (75 if 'replacementRelease' in self.initial['certificationPlan'] else 10)
        while True:
            self.check()
            try:
                require_profiled_certification_guard_arm(self.initial, probe)
                self.guard_arm_verified = True
                return
            except FileNotFoundError:
                require(time.monotonic() < expires, 'P2_PROFILED_CERTIFICATION_GUARD_ARM_TIMEOUT')
                time.sleep(0.05)

    def _read_api_current(self,directory):
        credentials = {'course': self.initial['credentials']['COURSE_STAGING_DATABASE_URL'],
                       'community': self.initial['credentials']['COMMUNITY_STAGING_DATABASE_URL']}
        self.api_proof, outcome = check_profiled_certification_apis(self.scope, self.jobs, self.source, self.bundle, directory,
            credentials, self.initial['sourceSha256'], **self.profile_arguments())
        return outcome

    def _refresh_api(self):
        with self.api_mutex:
            self.api_cycle += 1
            self._read_api_current(self.directory / ('current-api-' + str(self.api_cycle)))
            self.last_api_verified = time.monotonic()

    def _release_evidence(self):
        return {key: self.initial[key] for key in ('originalReleaseReceipt', 'readyReceipts')}

    def require_scoped_native_off(self):
        self.check()
        require(self.initial['certificationPlan']['mode'] in SCOPED_MODES, 'P2_CERTIFICATION_SCOPED_NATIVE_READ_REQUIRED')
        observed = native.observe_metadata(self._native_context(), LockedClient(self.vercel, self.check), **self.profile_arguments())
        require(observed.get('nativeEnabled') is False, 'P2_CERTIFICATION_NATIVE_OFF_REQUIRED')
        return observed

    def _native_observe(self):
        if self.initial['certificationPlan']['mode'] not in SCOPED_MODES:
            return super()._native_observe()
        from p2_day_two_workload import observe
        return observe(self._native_context(), LockedClient(self.vercel, self.check), self.initial['scopedCronSecret'],
                       **self.profile_arguments())

    def _verify_gateway_boundary(self):
        mode = self.initial['certificationPlan']['mode']
        if mode not in ('interactive-browser', 'mux-callback-recovery'):
            return super()._verify_gateway_boundary()
        with self.scoped_gate_lock:
            if self.scoped_mux_sha256 is None:
                return self.scoped_stage.verify_gateway_boundary() if mode == 'interactive-browser' else self._gateway_current()
            observed = self._gateway_observation()['admission']
            require(observed.get('version') == 2 and observed.get('muxCallbackActive') is True and
                    observed.get('sha256') == self.scoped_mux_sha256 and
                    observed.get('uncertain') == {'newWork': 0, 'recovery': 0},
                    'P2_CERTIFICATION_SCOPED_MUX_BOUNDARY_CHANGED')
            return observed

    def _interactive_media_upload(self, operation, value, plan, stage, gateway_artifact):
        from p2_interactive_window import (browser_artifact, browser_case_evidence, browser_receipt,
                                           media_reservation_bindings, media_upload_selected, require_media_upload_gateway)
        from p2_scoped_mux import P2ScopedMuxStage

        require(media_upload_selected(plan), 'P2_INTERACTIVE_MEDIA_UPLOAD_PLAN_REQUIRED')
        with self.scoped_gate_lock:
            if operation == 'interactive-media-arm':
                incoming = value['caseEvidence']
                require(self.media_upload is None and type(incoming) is dict and set(incoming) == {'browserResponse'},
                        'P2_INTERACTIVE_MEDIA_SINGLE_ARM_REQUIRED')
                self.media_upload = {'phase': 'arming'}
                stage.verify_fenced()
                browser = incoming['browserResponse']
                witness = stage.observe_media_reservation(browser)
                bindings = media_reservation_bindings(plan, stage.action, browser, witness, gateway_artifact)
                scope = P2ScopedMuxStage(self, reservation=witness, expires_at=stage.media_dispatch_expiry())
                opened = scope.open()
                self.scoped_mux_sha256 = opened['scopedStateSha256']
                try:
                    expiry = int(datetime.datetime.fromisoformat(opened['expiresAt']).timestamp())
                    require(expiry > time.time() and opened['managedAckCount'] == opened['admitted'] == 0,
                            'P2_INTERACTIVE_MEDIA_UNUSED_CALLBACK_WINDOW_REQUIRED')
                    intent = {**browser_receipt(plan, 'UPLOAD_DISPATCH_INTENT'),
                              **{key: bindings[key] for key in ('attemptId', 'uploadId', 'generation', 'environmentId',
                                  'browserResponseSha256', 'courseWitnessSha256', 'gatewayEvidenceSha256')},
                              **{key: opened[key] for key in ('gatewayProcessSha256', 'scopedStateSha256', 'originalStateSha256')},
                              'expiresAt': expiry}
                    migrate.write_json(self.directory, browser_artifact(plan, 'upload-intent'), intent)
                    require(expiry > time.time(), 'P2_INTERACTIVE_MEDIA_DISPATCH_EXPIRED')
                    self.media_upload.update(phase='armed', scope=scope, browserResponse=copy.deepcopy(browser),
                                             courseWitness=witness, dispatchIntent=intent)
                    return {**browser_receipt(plan, 'UPLOAD_ARMED'), 'intentSha256': _sha(_canonical(intent)), 'expiresAt': expiry}
                except BaseException:
                    try:
                        scope.close()
                    except Exception:
                        pass
                    raise

            upload = self.media_upload
            dispatch = value['dispatchEvidence']
            require(operation == 'interactive-media-observe' and upload is not None and upload['phase'] in ('armed', 'observing') and
                    time.time() < upload['dispatchIntent']['expiresAt'] and type(dispatch) is dict and
                    set(dispatch) == {'attempted', 'status'} and dispatch['attempted'] is True and
                    type(dispatch['status']) is int and 200 <= dispatch['status'] < 300,
                    'P2_INTERACTIVE_MEDIA_DISPATCH_OUTCOME_REQUIRED')
            result = {**browser_receipt(plan, 'UPLOAD_HTTP_OBSERVED'), 'attempted': True, 'httpStatus': dispatch['status'],
                      'intentSha256': _sha(_canonical(upload['dispatchIntent']))}
            if upload['phase'] == 'armed':
                migrate.write_json(self.directory, browser_artifact(plan, 'upload-http'), result)
                upload.update(phase='observing', dispatchOutcome=result)
            require(upload['dispatchOutcome'] == result, 'P2_INTERACTIVE_MEDIA_DISPATCH_OUTCOME_CHANGED')
            scope = upload['scope']
            try:
                observed = scope.observe()
                if observed['status'] == 'P2_SCOPED_MUX_WAITING':
                    return browser_receipt(plan, 'UPLOAD_WAITING')
                require(observed['status'] == 'P2_SCOPED_MUX_EFFECT_OBSERVED', 'P2_INTERACTIVE_MEDIA_CALLBACK_UNCERTAIN')
            except BaseException:
                try:
                    scope.close()
                except Exception:
                    pass
                raise
            callback = scope.close()
            self.scoped_mux_sha256 = None
            keys = ('browserResponse', 'courseWitness', 'dispatchIntent', 'dispatchOutcome')
            evidence = {**{key: upload[key] for key in keys}, 'callback': callback}
            bindings = browser_case_evidence(plan, evidence, gateway_artifact=gateway_artifact)
            require_media_upload_gateway(evidence, self._gateway_current()['admission'])
            migrate.write_json(self.directory, browser_artifact(plan, 'upload-callback'), callback)
            upload.update(phase='observed', evidence=evidence)
            return {**browser_receipt(plan, 'UPLOAD_OBSERVED'),
                    **{key: bindings['upload'][key] for key in ('callbackReceiptSha256', 'requestId', 'eventId', 'assetId')}}

    def _prepare_lifecycle_stages(self,mode):
        if mode == 'interactive-browser':
            from p2_interactive_window import P2InteractiveWindow
            self.scoped_stage = P2InteractiveWindow(self)
        if mode == 'export-cleanup':
            from p2_scoped_export_cleanup import P2ScopedExportCleanupStage
            self.scoped_stage = P2ScopedExportCleanupStage(self)
        if mode == 'mux-callback-recovery':
            from p2_scoped_mux import P2ScopedMuxStage
            self.scoped_stage = P2ScopedMuxStage(self)
        if mode == 'lifecycle-persistence':
            from p2_lifecycle_persistence_probe import P2ScopedLifecyclePersistenceStage
            self.scoped_stage = P2ScopedLifecyclePersistenceStage(self)
        if mode == 'browser-pending':
            self.suspension_stage = P2LifecycleSuspensionEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,
                self.initial['browserPlan'],self.initial['persistenceReviewed'],self.initial['browserResources'],
                release_evidence=self._release_evidence(),**self.profile_arguments())
            self.suspension_stage.register_source_parent(self.initial['sourceParentChallenge'])
        if mode == 'direct-worker':
            self.worker_stage = P2LifecycleWorkerEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,
                self.initial['workerPlan'],self.initial['sourceSuspensionPlan'],self.initial['persistenceReviewed'],
                native_context=self._native_context(),provider_client=LockedClient(self.vercel,self.check),
                observe_frontend=lambda:self.observer.probe('witness'),bundle=self.bundle,database_proof=self.api_proof,
                release_evidence=self._release_evidence(),**self.profile_arguments())

    def interactive_operation(self, operation, value):
        from p2_interactive_window import (EXECUTABLE_BROWSER_STAGES, SCOPED_GATEWAY_BROWSER_STAGES, P2InteractiveWindow,
                                           browser_artifact, browser_case_evidence, browser_receipt, media_upload_selected,
                                           require_media_upload_gateway, stalled_renewal_selected)
        self.check()
        plan, stage = self.initial['certificationPlan'], self.scoped_stage
        fields = {'id', 'operation', 'controllerChallenge'}
        if operation in ('interactive-retain', 'interactive-media-arm'):
            fields.add('caseEvidence')
        if operation == 'interactive-media-observe':
            fields.add('dispatchEvidence')
        require(plan['mode'] == 'interactive-browser' and type(stage) is P2InteractiveWindow and
                stage.action['stage'] in EXECUTABLE_BROWSER_STAGES and stage.action == plan['scopedAction'] and
                self.external_armed and self.guard_arm_verified and
                self.scoped_case is None and self.closing_at is None and set(value) == fields and
                value['controllerChallenge'] == self.initial['interactiveController']['challenge'],
                'P2_INTERACTIVE_FIXED_CONTROLLER_OPERATION_REQUIRED')
        if operation == 'interactive-prepare':
            ingress = stage.prepare()
            migrate.write_json(self.directory, browser_artifact(plan, 'ingress'), ingress)
            return {**browser_receipt(plan, 'PREPARED'), 'ingressSha256': _sha(_canonical(ingress))}
        if operation == 'interactive-open':
            with self.scoped_gate_lock:
                opened = stage.open_gateway()
            return {**browser_receipt(plan, 'OPENED'), **opened}
        if operation == 'interactive-permit':
            return stage.take_private_browser_permit()
        if operation == 'interactive-observe':
            require(stage.action['stage'] in SCOPED_GATEWAY_BROWSER_STAGES and not self.gateway_observation_attempted,
                    'P2_INTERACTIVE_FIXED_GATEWAY_OBSERVATION_REQUIRED')
            self.gateway_observation_attempted = True
            try:
                return stage.observe_browser_gateway()
            except ValueError:
                # A rejected observation grants no receipt but still permits the fixed fence.
                return browser_receipt(plan, 'GATEWAY_OBSERVATION_REFUSED')
        if operation == 'interactive-fence':
            with self.scoped_gate_lock:
                stage.fence_gateway()
                fenced = stage.verify_gateway_fenced()
            return {**browser_receipt(plan, 'FENCED'), **fenced}
        require(operation in ('interactive-retain', 'interactive-media-arm', 'interactive-media-observe') or
                operation == 'interactive-confirm-fence' and stalled_renewal_selected(plan),
                'P2_INTERACTIVE_FIXED_OPERATION_REQUIRED')
        gateway_artifact = None
        if stage.action['stage'] in SCOPED_GATEWAY_BROWSER_STAGES:
            from qualification_target_profile import decode_qualification_target_json
            gateway_artifact = decode_qualification_target_json(migrate.read_input(self.directory, browser_artifact(plan, 'gateway'), 8192), 'carrier')
        if operation == 'interactive-confirm-fence':
            with self.scoped_gate_lock:
                return stage.confirm_stalled_renewal_fence(gateway_artifact)
        if operation != 'interactive-retain':
            return self._interactive_media_upload(operation, value, plan, stage, gateway_artifact)
        evidence = value['caseEvidence']
        if stage.action['stage'] == 'media':
            require(type(evidence) is dict and set(evidence) == {'browserResponse'},
                    'P2_INTERACTIVE_MEDIA_BROWSER_RESPONSE_REQUIRED')
            fenced = stage.verify_fenced(retain=True)
            if media_upload_selected(plan):
                require(self.media_upload is not None and self.media_upload['phase'] == 'observed' and
                        evidence['browserResponse'] == self.media_upload['browserResponse'],
                        'P2_INTERACTIVE_MEDIA_UPLOAD_UNJOINED')
                evidence = self.media_upload['evidence']
                require_media_upload_gateway(evidence, self._gateway_current()['admission'])
            else:
                evidence = {**evidence, 'courseWitness': stage.observe_media_reservation(evidence['browserResponse'])}
            bindings = browser_case_evidence(plan, evidence, gateway_artifact=gateway_artifact)
        else:
            bindings = (stage.stalled_renewal_bindings(evidence, gateway_artifact) if stalled_renewal_selected(plan) else
                        browser_case_evidence(plan, evidence, gateway_artifact=gateway_artifact))
            fenced = stage.verify_fenced(retain=True)
        result = {**browser_receipt(plan, 'JOINED'), **bindings, **fenced,
                  'browserProgramSha256': self.initial['interactiveController']['browserProgramSha256']}
        migrate.write_json(self.directory, browser_artifact(plan, 'evidence'), evidence)
        migrate.write_json(self.directory, 'p2-scoped-case-joined.json', result)
        self.scoped_case = copy.deepcopy(result)
        return result

    def scoped_operation(self, operation, value):
        self.check()
        require(self.external_armed and self.scoped_stage is not None and self.scoped_case is None and
                self.closing_at is None and set(value) == {'id', 'operation'},
                'P2_CERTIFICATION_FIXED_SCOPED_OPERATION_REQUIRED')
        mode = self.initial['certificationPlan']['mode']
        stage = self.scoped_stage
        if mode == 'export-cleanup':
            if operation == 'scoped-export-preflight':
                self._require_protected_export_ingress('preflight')
                return stage.preflight(self.initial['scopedCronSecret'])
            if operation == 'scoped-export-invoke':
                self._require_protected_export_ingress('invoke')
                return stage.invoke(self.initial['scopedCronSecret'])
            require(operation == 'scoped-export-join', 'P2_CERTIFICATION_FIXED_EXPORT_OPERATION_REQUIRED')
            result = stage.join()
        elif mode == 'mux-callback-recovery':
            with self.scoped_gate_lock:
                if operation == 'scoped-mux-open':
                    require(self.scoped_mux_sha256 is None, 'P2_CERTIFICATION_SCOPED_MUX_ALREADY_OPEN')
                    opened = stage.open()
                    self.scoped_mux_sha256 = opened['scopedStateSha256']
                    return opened
                if operation == 'scoped-mux-observe':
                    return stage.observe()
                require(operation == 'scoped-mux-close', 'P2_CERTIFICATION_FIXED_MUX_OPERATION_REQUIRED')
                result = stage.close()
                self.scoped_mux_sha256 = None
        else:
            require(mode == 'lifecycle-persistence' and operation == 'scoped-persistence-observe',
                    'P2_CERTIFICATION_FIXED_PERSISTENCE_OPERATION_REQUIRED')
            result = stage.observe()
        self.scoped_case = copy.deepcopy(result)
        migrate.write_json(self.directory, 'p2-scoped-case-joined.json', self.scoped_case)
        return result

    def _require_protected_export_ingress(self, stage):
        from p2_interactive_ingress import observe_selected_protection
        receipt = observe_selected_protection(self._native_context(), LockedClient(self.vercel, self.check),
                                              **self.profile_arguments())
        require(receipt['automationBypassCount'] == 1, 'P2_CERTIFICATION_SCOPED_EXPORT_SINGLE_BYPASS_REQUIRED')
        migrate.write_json(self.directory, 'p2-scoped-export-ingress-' + stage + '.json', receipt)

    def _require_worker_outcome(self,case):
        from p2_lifecycle_authority_timing import finalize_retained_authority_timing
        expected = self.certification_profile()
        super()._require_worker_outcome(case)
        action = self.initial['certificationPlan']
        try:
            receipt = finalize_retained_authority_timing(self.scope,self.selected,self.jobs,self.configuration,self.source,
                action['workerPlan'],self.initial['sourceSuspensionPlan'],self.initial['persistenceReviewed'],
                self.worker_retained['privateRecordSha256'],expected_profile=expected,release_evidence=self._release_evidence(),
                database_proof=self.api_proof)
        except Exception:
            # A timing witness is separate from the worker and the final
            # containment result. Preserve its failure without losing either.
            receipt = {'version': 2, 'qualificationTargetProfile': expected,
                'status': 'P2_S13_AUTHORITY_TIMING_REQUIRES_REVIEW', 'certificationActionId': self.action_id(),
                'workerPlanSha256': action['workerPlanSha256'], 'releaseAccepted': False}
        name = 'p2-s13-authority-timing.json'
        migrate.write_json(self.directory,name,receipt)
        self.authority_timing_sha256 = _sha(migrate.read_input(self.directory,name))

    def _bind_terminal_profile(self):
        self.prepared_terminal.update(status='P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',
            qualificationTargetProfile=self.certification_profile(),frontendSqlApplied=False,
            releaseAccepted=False,releaseId=self.selected['releaseId'])
        self.prepared_terminal['configurationSha256'] = self.initial['configurationSha256']
        plan = self.initial['certificationPlan']
        if 'replacementRelease' in plan:
            self.prepared_terminal.update({key: plan[key] for key in REPLACEMENT_LINEAGE_FIELDS})
        if self.authority_timing_sha256 is not None:
            self.prepared_terminal['authorityTimingReceiptSha256'] = self.authority_timing_sha256
        if self.initial['certificationPlan']['mode'] == 'known-ack-recovery':
            self.prepared_terminal['knownAckRuntimeReceiptSha256'] = _sha(migrate.read_input(self.directory,'known-ack-replacement-joined.json'))

    def _require_profiled_before_upstream(self,case,evidence):
        expected = self.certification_profile()
        fault = self.fault_stage
        require(type(fault) is P2CertificationFaultStage and fault.expected_profile == expected,
                'P2_PROFILED_CERTIFICATION_FAULT_STAGE_REQUIRED')
        vercel.require_record_profile(expected, case)
        require(case.get('status') == 'P2_LIFECYCLE_TRANSPORT_FAULT_OBSERVED_CONTAINED' and
                all(case.get(key) == fault.plan[key] for key in ('environment','stageId','candidateSha256','mode','receiver',
                    'targetSha256','sourceCommit','nativePlanSha256')) and case.get('nativeEnabled') is False and
                all(case.get(key) is True for key in ('faultDisabled','gatewayAdmissionClosed','frontendAdmissionClosed',
                    'frontendRuntimeBindingVerified','uncertaintySettled')) and
                type(case.get('outstandingUncertain')) is int and case['outstandingUncertain'] == 0 and
                evidence.get('retryableFailureCorrelated') is True, 'P2_PROFILED_CERTIFICATION_FAULT_OUTCOME_REQUIRED')
        effects = fault.effects()
        require(len(effects) == 1 and effects[0]['upstreamStarted'] is False and effects[0]['upstreamReceiptVerified'] is False and
                effects[0]['downstreamDisposition'] == '503' and _sha(_canonical(effects[0])) == case.get('injectedEffectSha256'),
                'P2_PROFILED_CERTIFICATION_FAULT_EFFECT_REQUIRED')

    def finish_certification(self,value):
        self.check()
        require(self.closing_at is not None and not self.finished, 'P2_PROFILED_CERTIFICATION_CLOSE_NOT_PREPARED')
        observed = self.observer.probe('verify-closed')
        if 'replacementRelease' in self.initial['certificationPlan']:
            require_certification_replacement_proof(observed, self.initial['certificationPlan']['replacementRelease'])
        require(observed['admission'] == self.prepared_terminal['frontendAdmission'],
                'P2_PROFILED_CERTIFICATION_LATE_FRONTEND_STATE_CHANGED')
        migrate.write_json(self.directory,'p2-certification-frontend-session-closed.json',observed)
        return super().finish_certification(value)

    def abort(self):
        # The independent guard owns provider and FE containment after reap.
        Broker.abort(self)

    def contain_frontend_without_guard(self):
        result = {**contain_profiled_certification_native(self.initial,self.armed_probe,self.source),
                  **contain_profiled_certification_frontend(self.initial,self.armed_probe,self.source)}
        self.outcome.update(result)
        require(result['frontendAdmissionClosed'] is True, 'P2_PROFILED_CERTIFICATION_FALLBACK_FRONTEND_UNKNOWN')

    def _children_quiesced(self):
        if self.operation_active.locked():
            return False
        if not self.scope:
            return True
        with self.scope.mutations:
            return all(process.poll() is not None for process in self.scope.processes)

    def contain_failure_without_guard(self):
        from p2_release_supervisor import cleanup_profiled_certification_containers, remove_profiled_certification_fault_lease
        with self.failure_lock:
            thread = self.observer.thread if self.observer else None
            if thread is not None and thread is not threading.current_thread() and thread.is_alive():
                return False
            if self.scope:
                try:
                    self.scope.revoke()
                except Exception:
                    self.outcome['workerProcessCleanupUncertain'] = True
            if not self._children_quiesced():
                self.outcome['workerProcessCleanupUncertain'] = True
                return False
            # An observer can start before durable ARM. Pre-ARM failure has
            # no authority to mutate provider, frontend or gateway state.
            if self.guard_arm_verified and not self.fallback_complete:
                token = runtime._command_scope.set(None)
                try:
                    if super().contain_failure_without_guard() is False:
                        return False
                finally:
                    runtime._command_scope.reset(token)
                if self.initial['certificationPlan']['mode'] in ('fault-before-upstream','known-ack-recovery'):
                    self.outcome['faultLeaseDisabled'] = None
                    if self.outcome.get('runtimeStopped') is True:
                        try:
                            remove_profiled_certification_fault_lease(self.initial, self.source)
                            self.outcome['faultLeaseDisabled'] = True
                        except Exception:
                            self.outcome['faultLeaseContainmentUncertain'] = True
                self.fallback_complete = True
            try:
                cleanup_profiled_certification_containers()
            except Exception:
                self.outcome['profiledCertificationContainerCleanupUncertain'] = True
                return False
            return True

    def close(self,committed=False):
        from p2_release_supervisor import sticky_cleanup_signals
        signals = sticky_cleanup_signals() if threading.current_thread() is threading.main_thread() else nullcontext()
        with signals:
            if not committed:
                self.abort()
            self.boundary_stop.set()
            if self.observer:
                self.observer.stop_event.set()
            while not self._children_quiesced():
                if self.scope:
                    try:
                        self.scope.revoke()
                    except Exception:
                        self.outcome['workerProcessCleanupUncertain'] = True
                time.sleep(0.1)
            if self.observer:
                self.observer.stop()
            if not committed and not self.guard_alive:
                while not self.contain_failure_without_guard():
                    time.sleep(0.1)
            super().close(committed)


def main():
    if sys.argv[1:] == ['--plan-profiled-current']:
        from qualification_target_profile import decode_qualification_target_json
        _profiled_context()
        raw = sys.stdin.buffer.read(MAXIMUM + 1)
        require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_CERTIFICATION_PRIVATE_INPUT_REQUIRED')
        initial = decode_qualification_target_json(raw, 'private-packet')
        require(sys.platform == 'linux' and os.geteuid() == 0, 'P2_PROFILED_CERTIFICATION_LINUX_ROOT_REQUIRED')
        result = prepare_profiled_current_certification_input(initial, Path(__file__).resolve().parents[3])
        print(json.dumps(result, separators=(',', ':')), flush=True)
        return
    if sys.argv[1:] == ['--supervisor-profiled-current']:
        from qualification_target_profile import decode_qualification_target_json
        from p2_release_supervisor import supervise,PROFILED_CERTIFICATION_LAYOUT
        raw = sys.stdin.buffer.readline(MAXIMUM + 1)
        require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_CERTIFICATION_PRIVATE_INPUT_REQUIRED')
        initial = decode_qualification_target_json(raw, 'private-packet')
        expected = _profiled_context()
        vercel.require_record_profile(expected, initial)
        require(initial.get('mode') == PROFILED_CERTIFICATION_MODE and
                not any(key.startswith('_guard') for key in initial), 'P2_PROFILED_CERTIFICATION_FIXED_MODE_REQUIRED')
        source = Path(__file__).resolve().parents[3]
        cache_certification_core(initial,source,expected_profile=expected)
        supervise(initial,broker_type=P2ProfiledCertificationBroker,observer_type=P2CertificationPhysicalObserver,
            observer_source=OBSERVER,layout=PROFILED_CERTIFICATION_LAYOUT,
            native_containment=contain_profiled_certification_native,frontend_containment=contain_profiled_certification_frontend)
        return
    require(sys.argv[1:]==['--supervisor'],'P2_CERTIFICATION_FIXED_ENTRY_REQUIRED')
    raw=sys.stdin.buffer.readline(MAXIMUM+1);require(0<len(raw)<=MAXIMUM and raw.endswith(b'\n'),'P2_CERTIFICATION_PRIVATE_INPUT_REQUIRED')
    initial=json.loads(raw);require(initial.get('mode')=='p2-bounded-certification','P2_CERTIFICATION_FIXED_MODE_REQUIRED')
    source=Path(__file__).resolve().parents[3];cache_certification_core(initial,source)
    from p2_release_supervisor import supervise,CERTIFICATION_LAYOUT
    supervise(initial,broker_type=P2CertificationBroker,observer_type=P2CertificationPhysicalObserver,observer_source=OBSERVER,
        layout=CERTIFICATION_LAYOUT,native_containment=contain_certification_native)


if __name__=='__main__':
    for item,code in ((signal.SIGTERM,143),(signal.SIGHUP,129),(signal.SIGINT,130)):
        signal.signal(item,lambda *_args,code=code:(_ for _ in ()).throw(SystemExit(code)))
    try:main()
    except BaseException:print('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW',file=sys.stderr);raise SystemExit(1)
