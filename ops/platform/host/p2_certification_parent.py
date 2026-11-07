#!/usr/bin/env python3
"""Fixed bounded certification broker and independent native containment.

No SQL executor, role preparation, deployment or runtime replacement is exposed.
"""
import base64
import copy
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
from p2_source_closure import verify_profiled_current_source_closure,verify_source_closure
from p2_certification_profile import require_profile as require_certification_profile
from p2_certification_fault import P2CertificationFaultStage,GATEWAY_OBSERVER,frontend_target_sha256
import p2_identity_negative_probe as identity_probe
from p2_lifecycle_suspension_evidence import P2LifecycleSuspensionEvidenceStage
import p2_canonical_browser_origin as canonical_browser
from p2_lifecycle_worker_evidence import P2LifecycleWorkerEvidenceStage

require=migrate.demand
CORE='ops/platform/p2-recovery-current-probe.mjs'
OBSERVER='ops/platform/p2-certification-current-probe.mjs'
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
PROFILED_MODES = frozenset(('native-window', 'fault-before-upstream', 'fault-drop-after-ack',
                           'known-ack-recovery', 'contain-native'))
NATIVE_PLAN_FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'environment', 'actionId', 'projectId', 'sourceCommit',
    'candidateSha256', 'phase2ContractManifestSha256', 'sourcePolicy', 'deploymentId', 'deploymentUrl',
    'configurationRecordSha256', 'featureControls', 'targetSha256', 'target', 'owner', 'producer',
    'initialEpoch', 'schedule', 'windowSeconds', 'drainSeconds', 'commandWitnesses', 'writerAdmissionBinding',
    'finalDisposition', 'providerQueuedInventory', 'automaticReplayAllowed', 'migrationAuthorized',
    'wholeReleaseAccepted', 'planSha256',
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


def _profiled_digest(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) is not None and value != '0' * 64


def _profiled_compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def _profiled_plan_hash(plan):
    return _sha(_canonical({key: value for key, value in plan.items() if key != 'planSha256'}))


def _profiled_context():
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    return migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)


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
    require(type(initial) is dict and set(initial) == PROFILED_INITIAL_FIELDS and
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
    extra = {'knownAckRecovery', 'knownAckReceiverTargets', 'knownAckConfigurationInputDirectory'} if plan['mode'] == 'known-ack-recovery' else set()
    require(set(plan) == PROFILED_PLAN_FIELDS | extra and plan['startState'] == 'already-closed' and
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
            type(plan['maximumSeconds']) is int and plan['maximumSeconds'] == 900 and
            all(plan[key] is None for key in ('browserPlanSha256', 'workerPlan', 'workerPlanSha256')) and
            plan['finalDisposition'] == 'native-disabled-and-both-admissions-closed' and
            plan['persistenceReaderEligible'] is True and all(plan[key] is False for key in PROFILED_PLAN_FALSE) and
            plan['planSha256'] == _profiled_plan_hash(plan),
            'P2_PROFILED_CERTIFICATION_PLAN_BINDING_REQUIRED')
    native_plan = plan['nativePlan']
    vercel.require_record_profile(expected, plan, native_plan)
    migrate.require_profile(expected, native_plan.get('target'))
    require(set(native_plan) == NATIVE_PLAN_FIELDS and set(native_plan['target']) == NATIVE_TARGET_FIELDS and
            native_plan['planSha256'] == _profiled_plan_hash(native_plan) and
            native_plan['candidateSha256'] == plan['candidateObjectSha256'] and
            native_plan['schedule'] == {'path': native.PATH, 'schedule': native.SCHEDULE} and
            native_plan['finalDisposition'] == 'disabled-and-admission-closed' and
            native_plan['providerQueuedInventory'] is None and
            all(native_plan[key] is False for key in ('automaticReplayAllowed', 'migrationAuthorized', 'wholeReleaseAccepted')) and
            type(native_plan['initialEpoch']) is str and re.fullmatch(r'[1-9][0-9]{0,17}', native_plan['initialEpoch']) and
            (plan['mode'] == 'contain-native' or native_plan['initialEpoch'] == str(int(plan['initialEpoch']) + 1)) and
            type(native_plan['windowSeconds']) is int and 60 <= native_plan['windowSeconds'] <= 180 and
            type(native_plan['drainSeconds']) is int and 1 <= native_plan['drainSeconds'] <= 180,
            'P2_PROFILED_CERTIFICATION_NATIVE_PLAN_REQUIRED')
    require(type(initial['readyReceipts']) is dict and set(initial['readyReceipts']) == set(READY_FILES) and
            type(plan['readyReceiptSha256']) is dict and set(plan['readyReceiptSha256']) == set(READY_FILES),
            'P2_PROFILED_CERTIFICATION_READY_RECEIPTS_REQUIRED')
    return plan


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
            target.get('approvedPendingTags') == [] and target.get('allowEmptyBootstrap') is False and
            frontend_target_sha256(target) == initial['targetSha256'] and
            runtime_plan['hostMachineId'] == initial['hostMachineId'] and
            staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
            'P2_PROFILED_CERTIFICATION_ACTUAL_RELEASE_INPUT_REQUIRED')
    migrate.require_contract_identity(selected, plan)
    restoration = inventory['restoration']
    require(_sha(_profiled_compact(inventory)) == initial['inventorySha256'] and inventory.get('admissionMode') == 'existing' and
            inventory.get('actionId') == selected['releaseId'] and inventory.get('sourceCommit') == initial['sourceCommit'] and
            inventory.get('targetSha256') == initial['targetSha256'] and inventory.get('owner') == initial['owner'] and
            inventory.get('certification') == initial['certification'] and restoration.get('providerIngress') == 'keep-retired' and
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
    terminal_sha, plan_hash_verified = _profiled_original_terminal(initial, plan, selected, results, expected)
    return {'version': 2, 'qualificationTargetProfile': expected, 'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED',
            'environment': 'staging', 'releaseId': selected['releaseId'], 'certificationActionId': initial['certificationActionId'],
            'sourceCommit': initial['sourceCommit'], 'candidateSha256': initial['candidateSha256'], 'targetSha256': initial['targetSha256'],
            'planSha256': plan['planSha256'], 'readyReceiptSha256': plan['readyReceiptSha256'],
            'originalReleaseReceiptSha256': plan['originalReleaseReceiptSha256'], 'hostOriginalReleaseReceiptSha256': terminal_sha,
            'originalReleasePlanSha256': plan['originalReleasePlanSha256'], 'originalReleasePlanHashHostVerified': plan_hash_verified,
            'executionEligible': False, 'providerTouched': False, 'admissionChanged': False, 'releaseAccepted': False}


def _iso(value):
    require(isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',value),'P2_CERTIFICATION_SOURCE_TIME_REQUIRED')
    return datetime.datetime.fromisoformat(value.removesuffix('Z')+'+00:00').timestamp()


def cache_certification_core(initial,source):
    global _core
    verify_source_closure(initial,source)
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
    plan=initial['browserPlan'];require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',plan['actionId']),'P2_CERTIFICATION_BROWSER_ACTION_REQUIRED')
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


class P2CertificationPhysicalObserver(PhysicalObserver):
    def probe(self,operation):
        require(operation in ('observe','verify-schema','witness','fence'),'P2_CERTIFICATION_OBSERVATION_REQUIRED')
        program=self.program;require(program is not None and _sha(program.read_bytes())==self.program_sha256,'P2_CERTIFICATION_OBSERVER_CHANGED')
        core=_cache_core(program.parent)
        image=self.selected['artifacts']['frontendMigration']['image']
        from uuid import uuid4
        container='lash-p2-certification-observer-'+uuid4().hex
        args=['docker','run','--rm','--name',container,'--interactive','--network','host','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges','--memory','256m','--pids-limit','64','--env','FRONTEND_STAGING_MIGRATION_DATABASE_URL',
            '--mount',f'type=bind,src={program},dst=/app/ops/platform/p2-frontend-live-probe.mjs,readonly',
            '--mount',f'type=bind,src={core},dst=/app/ops/platform/p2-recovery-current-probe.mjs,readonly',
            '--entrypoint','node',image,'ops/platform/p2-frontend-live-probe.mjs']
        environment={**runtime.SAFE_ENV,'FRONTEND_STAGING_MIGRATION_DATABASE_URL':self.credential}
        try:result=subprocess.run(args,input=json.dumps({**self.request,'operation':operation}),capture_output=True,text=True,env=environment,timeout=30,check=True)
        finally:
            subprocess.run(['docker','rm','--force',container],env=runtime.SAFE_ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
            require(not runtime.command(['docker','container','ls','--all','--filter','name=^/'+container+'$','--format','{{.ID}}'],runtime.SAFE_ENV,15),'P2_CERTIFICATION_OBSERVER_REMAINS')
        maximum=2_000_000 if operation=='witness' else 16384
        require(not result.stderr and 0<len(result.stdout)<=maximum and _sha(program.read_bytes())==self.program_sha256 and _sha(core.read_bytes())==_sha(_core),'P2_CERTIFICATION_OBSERVER_OUTPUT_REFUSED')
        value=json.loads(result.stdout)
        require(value.get('status')==('P2_FRONTEND_ADMISSION_CLOSED' if operation=='fence' else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED'),'P2_CERTIFICATION_PHYSICAL_OBSERVATION_REFUSED')
        if operation!='fence':require(value.get('marker')==self.request['marker'] and value.get('backendPid')==self.request['backendPid'] and value.get('sourceCommit')==self.request['job']['sourceCommit'],'P2_CERTIFICATION_PHYSICAL_BINDING_REFUSED')
        return value


class P2CertificationScope(P2ReleaseScope):
    def __init__(self,*args,certification_plan,**kwargs):
        self.certification_plan=copy.deepcopy(certification_plan)
        super().__init__(*args,**kwargs)
        self.require_frontend(self.release,self.jobs['frontend'])

    def require_frontend(self,release,info):
        self.verify();job,receipt=info['job'],self.receipt;plan=self.certification_plan
        migrate.require_contract_identity(release,receipt)
        fields=('environment','releaseId','sourceCommit','migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256')
        require(release==self.release and info==self.jobs['frontend'] and all(receipt.get(key)==job.get(key) for key in fields) and
            receipt.get('status')=='P2_CERTIFICATION_DATABASE_CURRENT' and receipt.get('certificationActionId')==plan['certificationActionId'] and
            receipt.get('candidateSha256')==self.candidate_sha256==plan['candidateSha256'] and receipt.get('planSha256')==plan['planSha256'] and
            receipt.get('targetSha256')==plan['targetSha256']==frontend_target_sha256(job['target']) and receipt.get('target')=={key:job['target'][key] for key in ('host','port','database','user','serverMajor')} and
            receipt.get('schemaVerified') is True and receipt.get('runtimeRoleVerified') is True and receipt.get('oldLoginsDenied') is True and receipt.get('oldRoleSessions')==0 and
            receipt.get('sqlReplayed') is False and receipt.get('trafficAuthorized') is False and isinstance(receipt.get('after'),list) and receipt['after'],
            'P2_CERTIFICATION_FRESH_CURRENT_PROOF_REQUIRED')
        return copy.deepcopy(receipt)

    def initialize_runtime(self,*_):raise ValueError('P2_CERTIFICATION_RUNTIME_REPLACEMENT_FORBIDDEN')


def observe_certification_api(scope,jobs,source,name,directory):
    require(type(scope) is P2CertificationScope and name in ('course','community'),'P2_CERTIFICATION_ACTUAL_API_SCOPE_REQUIRED')
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

    def initialize(self):
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
        require(isinstance(value,dict) and set(value)=={'environment','projectId','sourceCommit','releaseId','secret','expiresAt','gatewayOrigin'},'P2_CERTIFICATION_PRIVATE_PROBE_SHAPE_REQUIRED')
        migrate.write_json(directory,frontend_probe.PRIVATE_FILE,value)
        frontend_probe._private_input(directory,{'environment':'staging','projectId':self.selected['workload']['projectId'],'sourceCommit':self.selected['sources']['frontend']['commit'],'releaseId':self.selected['releaseId']})

    def arm(self,request):
        self.check();require(self.scope is None and self.observer is None and not self.external_armed,'P2_CERTIFICATION_ALREADY_ARMED')
        raw,receipt=decode(request['receipt']);probe=request['probe'];cert=self.initial['certificationPlan']
        require(probe.get('job')==self.jobs['frontend']['job'] and probe.get('baseline')==json.loads(self.jobs['frontend']['schema']) and probe.get('receipt')==receipt and
            probe.get('plan')==cert and probe.get('owner')==self.initial['owner'] and probe.get('producers')==self.initial['producers'] and
            probe.get('historicalLogins')==self.initial['historicalLogins'],'P2_CERTIFICATION_CURRENT_PROBE_BINDING_REQUIRED')
        self.frontend_raw=raw;self.armed_probe=probe
        self.observer=self.observer_type(self.selected,probe,self.source,self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'],
            program=self.observer_program,program_sha256=self.initial['sourceSha256'][OBSERVER])
        self.observer.start(self.abort)
        self.scope=P2CertificationScope(self.lock_fd,LOCK,self.check,receipt,self.initial['candidateSha256'],release=self.selected,jobs=self.jobs,
            configuration_sha256=self.initial['configurationSha256'],certification_plan=cert)
        # Independent cleanup is armed before readonly helpers are launched.
        # There is still no native/admission/fault mutation authority.
        self.safety({'operation':'armed','probe':probe})
        if cert['mode']=='contain-native':native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check))
        else:
            self._store_private_probe()
            require(self._native_observe()['nativeEnabled'] is False,'P2_CERTIFICATION_NATIVE_OFF_REQUIRED')
        output=self.directory/'current-api';output.mkdir(mode=0o700)
        api={}
        for service in ('course','community'):
            target=output/service;target.mkdir(mode=0o700)
            api[service]=observe_certification_api(self.scope,self.jobs,self.source,service,target)
        self.runtime_snapshot=self.configuration
        token=runtime._command_scope.set(self.scope)
        try:self.runtime_current=runtime.check_containers(self.selected,self.configuration)
        finally:runtime._command_scope.reset(token)
        require(len(self.runtime_current)==10 and all(api[service].get('status')=='P2_RECOVERY_API_DATABASE_CURRENT' for service in api),'P2_CERTIFICATION_ALL_CURRENT_REQUIRED')
        self.last_api_verified=time.monotonic()
        require(_sha(_canonical(self.runtime_current))==cert['runtimeInventorySha256'],'P2_CERTIFICATION_REVIEWED_RUNTIME_SELECTION_REQUIRED')
        self.admission_fd=os.open(self.configuration/'admission',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);self.admission_identity=os.fstat(self.admission_fd)
        self.process_snapshot=self._runtime_processes();gateway=self._gateway_current()
        expected=cert['startState']=='qualified-ready';actual=gateway['admission']
        require(actual.get('newWork') is expected and actual.get('recovery') is expected and
            all(actual.get('uncertain',{}).get(key)==0 for key in ('newWork','recovery')) and
            (expected or all(actual.get('active',{}).get(key)==0 for key in ('newWork','recovery'))),'P2_CERTIFICATION_REVIEWED_GATEWAY_STATE_REQUIRED')
        if cert['mode']=='browser-pending':
            self.suspension_stage=P2LifecycleSuspensionEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,
                self.initial['browserPlan'],self.initial['persistenceReviewed'],self.initial['browserResources'])
            self.suspension_stage.register_source_parent(self.initial['sourceParentChallenge'])
        if cert['mode']=='direct-worker':
            self.worker_stage=P2LifecycleWorkerEvidenceStage(self.scope,self.selected,self.jobs,self.configuration,self.source,self.initial['workerPlan'],
                self.initial['sourceSuspensionPlan'],self.initial['persistenceReviewed'],native_context=self._native_context(),provider_client=LockedClient(self.vercel,self.check),
                observe_frontend=lambda:self.observer.probe('witness'))
        if cert['mode'] in ('auth-preparation','browser-pending'):
            self.browser_origin=self._retain_browser_observation('arm')['canonicalBrowserObservation']
        self.last_boundary=time.monotonic();self.external_armed=True
        self.ready={'status':'P2_CERTIFICATION_CURRENT_READY','apiDatabases':api,'containers':self.runtime_current,'sqlReplayed':False,'runtimeReplaced':False,
            **({'browserOrigin':self.browser_origin} if self.browser_origin else {})}
        self.worker_done.set();migrate.write_json(self.directory,'p2-certification-current-ready.json',self.ready)
        self._start_boundary_watch()
        return self.ready

    def _verify_boundary(self):
        self.scope.require_frontend(self.selected,self.jobs['frontend']);self.scope.require_configuration(self.configuration)
        if self.known_ack_boundary is not None:
            self.known_ack_boundary.verify_healthy_boundary()
            if time.monotonic()-self.last_api_verified>=10:self._refresh_api()
            self.last_boundary=time.monotonic();return
        if self.known_ack_recorder is not None:self.known_ack_recorder.verify_backend_idle()
        token=runtime._command_scope.set(self.scope)
        try:require(runtime.check_containers(self.selected,self.configuration)==self.runtime_current,'P2_CERTIFICATION_RUNTIME_CHANGED')
        finally:runtime._command_scope.reset(token)
        require(self._runtime_processes()==self.process_snapshot,'P2_CERTIFICATION_PROCESS_OR_MOUNT_CHANGED')
        self._gateway_current()
        if self.initial['certificationPlan']['mode']=='contain-native':
            native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check))
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
        if operation=='native-metadata':return native.observe_metadata(context,client)
        require(operation=='native-toggle' and type(request.get('enabled')) is bool,'P2_CERTIFICATION_FIXED_NATIVE_OPERATION_REQUIRED')
        with self.native_mutex:
            self.check()
            require(request['enabled'] is False or self.initial['certificationPlan']['mode'] not in ('contain-native','auth-preparation','browser-pending','direct-worker'),'P2_CERTIFICATION_ENABLE_FORBIDDEN')
            if request['enabled']:
                require(not self.native_enable_attempted,'P2_CERTIFICATION_ENABLE_ALREADY_ATTEMPTED')
                current=self.observer.probe('witness');admission=current['admission'];plan=self.initial['nativePlan']
                require(admission=={'epoch':str(int(plan['initialEpoch'])+1),'newWork':False,'recovery':True,'active':0,'uncertain':0},'P2_CERTIFICATION_NATIVE_EPOCH_BARRIER_REQUIRED')
                require(any(row['status']!='acknowledged' for row in current['witness']['deliveries']),'P2_CERTIFICATION_ACTUAL_PENDING_DELIVERY_REQUIRED')
                gateway=self._gateway_current()['admission']
                require(gateway.get('newWork') is False and gateway.get('recovery') is True and all(gateway[category][key]==0 for category in ('active','uncertain') for key in ('newWork','recovery')),
                    'P2_CERTIFICATION_NATIVE_GATEWAY_BARRIER_REQUIRED')
                self.native_enable_attempted=True
            elif native.observe_metadata(context,client)['nativeEnabled'] is False:
                self.native_expected=False
                return {'status':'P2_NATIVE_ALREADY_DISABLED','observation':native.observe_metadata(context,client)}
            attempt=self.directory/('provider-'+('enable' if request['enabled'] else 'disable')+'-'+str(request['id']));attempt.mkdir(mode=0o700)
            observed=native.set_enabled(context,client,request['enabled'],attempt,self.check)
            self.native_expected=request['enabled'];return observed

    def _native_observe(self):
        result=native.observe(self._native_context(),LockedClient(self.vercel,self.check))
        frontend_probe._private_input(_private_probe_directory(self.action_id()),{'environment':'staging','projectId':self.selected['workload']['projectId'],
            'sourceCommit':self.selected['sources']['frontend']['commit'],'releaseId':self.selected['releaseId']})
        return result

    def _observe_browser_origin(self):
        # Both provider and protected alias HTTPS calls retain the source/physical
        # verifier. No old phase2 fallback or private-probe renewal is allowed.
        result=canonical_browser.observe(self._native_context(),LockedClient(self.vercel,self.check),
            probe=LockedProbe(self.check,canonical_browser.CanonicalBrowserProbeClient()))
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

    def _gateway_current(self):
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

    def gateway_stage(self,stage):
        self.check();require(self.external_armed and stage in ('closed','recovery','browser'),'P2_CERTIFICATION_GATEWAY_STAGE_REQUIRED')
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
            self.fault_stage=P2CertificationFaultStage(self.scope,self.selected,self.jobs,self.configuration,self.source,plan,self.directory/'fault',source_files=self.initial['sourceSha256'])
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
        matched=bool(events and len(operations)==len(events) and len({event['operationId'] for event,_ in events})==len(events) and all(
            row['kind']=='recovery' and row['state']=='completed' and row['completed_at'] is not None and row['reconciliation_sha256'] is None and row['epoch']==window and
            row['producer_sha256']==plan['producer']['producerSha256'] and row['source_sha']==plan['sourceCommit'] and row['role_oid']==plan['producer']['role']['oid'] and
            any(event['operationId']==row['id'] and status==200 for event,status in events) for row in operations))
        name='p2-certification-operator-request-details.json'
        descriptor=os.open(self.directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        try:
            remaining=raw
            while remaining:remaining=remaining[os.write(descriptor,remaining):]
            os.fsync(descriptor)
        finally:os.close(descriptor)
        return {'qualified':matched,'authority':'operator-recorded-request-details','artifactSha256':_sha(raw),'requestCount':len(ids),'automaticProviderEvidence':False}

    def authentication_stage(self,value):
        self.check();cert=self.initial['certificationPlan'];plan=self.initial['browserPlan']
        require(self.external_armed and cert['mode']=='auth-preparation' and not self.authentication_issued and
            value.get('bindingSha256')==_sha(_canonical(plan)) and re.fullmatch(r'[a-f0-9]{64}',self.initial.get('sourceParentChallenge','')),
            'P2_CERTIFICATION_SOURCE_AUTHENTICATION_STAGE_REQUIRED')
        physical=self.observer.probe('witness')['admission'];gateway=self._gateway_current()['admission']
        require(physical['epoch']==str(int(cert['initialEpoch'])+1) and physical['newWork'] is True and physical['recovery'] is False and physical['uncertain']==0 and
            gateway['newWork'] is True and gateway['recovery'] is False and all(gateway['uncertain'][key]==0 for key in ('newWork','recovery')),
            'P2_CERTIFICATION_AUTHENTICATION_STATE_REQUIRED')
        require(native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check))['nativeEnabled'] is False,'P2_CERTIFICATION_AUTHENTICATION_NATIVE_OFF_REQUIRED')
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
        require(self.external_armed and cert['mode']=='known-ack-recovery','P2_CERTIFICATION_FIXED_KNOWN_ACK_MODE_REQUIRED')
        import p2_known_ack_loss as known
        if operation=='known-prepare':
            require(self.known_ack_recorder is None and self.fault_stage is not None,'P2_CERTIFICATION_KNOWN_ACK_ISSUER_ALREADY_USED')
            self.known_ack_recorder=known.P2KnownAckLossRecorder(self,cert['knownAckRecovery']['recoveryActionId'],cert['knownAckReceiverTargets'])
            return {'status':'P2_KNOWN_ACK_SOURCE_STAGE_PREPARED','bindingSha256':cert['planSha256'],'baselineSha256':self.known_ack_recorder.baseline_sha256}
        recorder=self.known_ack_recorder;require(recorder is not None,'P2_CERTIFICATION_KNOWN_ACK_SOURCE_ISSUER_REQUIRED')
        if operation=='known-arm':
            recorder._verify();known.validate_baseline(recorder.plan,recorder._snapshot())
            require(self._native_observe()['nativeEnabled'] is False,'P2_CERTIFICATION_KNOWN_ACK_NATIVE_OFF_BEFORE_ARM')
            observed=self.fault_stage.arm({'commandId':recorder.command['commandId'],'accountVersion':int(recorder.command['accountVersion']),'canonicalSha256':recorder.plan['commandSha256']})
            recorder._verify();return observed
        if operation=='known-start-window':recorder.start_native_window();return {'status':'P2_KNOWN_ACK_NATIVE_WINDOW_STARTED'}
        if operation=='known-domain':return recorder.observe_domain()
        if operation=='known-requests':return recorder.retain_request_details(value.get('requestArtifact'))
        if operation=='known-settlement':return recorder.prepare_reconciliation()
        if operation=='known-replace':
            require(not self.known_ack_replace_attempted and self.known_ack_boundary is None,'P2_CERTIFICATION_KNOWN_ACK_REPLACEMENT_ALREADY_ATTEMPTED')
            self.known_ack_replace_attempted=True
            authorization=recorder.authorize_replacement()
            boundary=known.issue_known_ack_loss_boundary(self,authorization);self.known_ack_boundary=boundary
            restored=known.KnownAckRecoveryRuntime(known.KnownAckRecoveryScope(boundary));outcome=restored.restore()
            self.configuration=self.runtime_snapshot=restored.snapshot;self.runtime_current=outcome['containers']
            if self.admission_fd is not None:os.close(self.admission_fd)
            self.admission_fd=os.open(self.configuration/'admission',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);self.admission_identity=os.fstat(self.admission_fd)
            self.process_snapshot=self._runtime_processes()
            gateway=next(row for row in self.runtime_current if row['service']=='gateway')
            observed=self.scope.run(['docker','exec','--workdir','/app',gateway['containerId'],'node','--input-type=module','--eval',GATEWAY_OBSERVER],
                env=runtime.SAFE_ENV,timeout=10,capture_output=True,check=True)
            require(not observed.stderr and 0<len(observed.stdout)<=16384,'P2_CERTIFICATION_KNOWN_ACK_NEW_GATEWAY_PROOF_REQUIRED')
            actual=json.loads(observed.stdout);require(actual.get('status')=='P2_FAULT_GATEWAY_CURRENT' and re.fullmatch(r'[a-f0-9]{64}',actual.get('processSha256','')),
                'P2_CERTIFICATION_KNOWN_ACK_NEW_PROCESS_REQUIRED')
            self.known_ack_new_gateway_process=actual['processSha256'];self._gateway_current();self._verify_boundary()
            self.known_ack_outcome=outcome
            migrate.write_json(self.directory,'known-ack-replacement-joined.json',outcome)
            return copy.deepcopy(outcome)
        raise ValueError('P2_CERTIFICATION_FIXED_KNOWN_ACK_OPERATION_REQUIRED')

    def _require_worker_outcome(self,case):
        cert=self.initial['certificationPlan']
        require(self.worker_stage is not None and self.worker_retained and set(case)=={'version','status','workerPlanSha256','workerSourceArtifactSha256','workerMachineArtifactSha256'} and
            case['version']==1 and case['status']=='P2_CERTIFICATION_DIRECT_WORKER_JOINED' and case['workerPlanSha256']==cert['workerPlanSha256'] and
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
        final=native.observe_metadata(self._native_context(),LockedClient(self.vercel,self.check));require(final['nativeEnabled'] is False,'P2_CERTIFICATION_FINAL_NATIVE_OFF_REQUIRED')
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
        migrate.require_contract_identity(self.selected,self.prepared_terminal)
        migrate.write_json(self.directory,'p2-certification-close-prepared.json',self.prepared_terminal)
        self.boundary_stop.set()
        if self.boundary_thread and self.boundary_thread is not threading.current_thread():self.boundary_thread.join(35)
        self.observer.stop();self.closing_at=time.monotonic();return copy.deepcopy(self.prepared_terminal)

    def finish_certification(self,value):
        self.check();raw,outcome=decode(value['certification']);migrate.require_contract_identity(self.selected,outcome)
        require(self.closing_at is not None and not self.finished and outcome==self.prepared_terminal,'P2_CERTIFICATION_TERMINAL_BINDING_REQUIRED')
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
