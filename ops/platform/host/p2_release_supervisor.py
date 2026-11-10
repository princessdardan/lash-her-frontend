#!/usr/bin/env python3
"""Independent fail-closed lifetime guard for the fixed P2 broker.

Both processes retain the same actual flock open file description. A single
broker/guard death leaves a survivor that revokes mutations before final stop.
"""
import ctypes
import contextlib
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
import select
import signal
import stat
import sys
import subprocess
import time

sys.modules.setdefault('p2_release_supervisor', sys.modules[__name__])

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_admission
import staging_state
import p2_prior_gateway
from p2_release_broker import Broker, PhysicalObserver, MAXIMUM, LOCK
from p2_source_closure import verify_source_closure, verify_profiled_current_source_closure, private_observer_program
from p2_source_closure import (CERTIFICATION_OBSERVER, PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE,
                               PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE)

require = migrate.demand

DEFAULT_LAYOUT = {'actionIdKey': 'releaseId', 'receiptPrefix': 'p2-', 'runtimePrefix': 'runtime-',
                  'terminalName': 'p2-release-outcome.json', 'terminalStatus': 'P2_STAGING_READY_FOR_CERTIFICATION'}
RECOVERY_LAYOUT = {'actionIdKey': 'recoveryActionId', 'receiptPrefix': 'p2-recovery-', 'runtimePrefix': 'runtime-recovery-',
                   'terminalName': 'p2-recovery-outcome.json', 'terminalStatus': 'P2_STAGING_RECOVERY_RESTORATION_VERIFIED'}
CERTIFICATION_LAYOUT = {'actionIdKey': 'certificationActionId', 'receiptPrefix': 'p2-certification-', 'runtimePrefix': 'runtime-certification-',
                        'terminalName': 'p2-certification-outcome.json', 'terminalStatus': 'P2_BOUNDED_CERTIFICATION_CONTAINED'}
ROTATION_LAYOUT = {'actionIdKey': 'rotationActionId', 'receiptPrefix': 'p2-identity-key-rotation-',
                   'runtimePrefix': 'runtime-identity-key-rotation-',
                   'terminalName': 'p2-identity-key-rotation-outcome.json',
                   'terminalStatus': 'P2_IDENTITY_KEY_ROTATION_QUALIFIED'}
C_LAYOUT = {**RECOVERY_LAYOUT, 'terminalName': 'p2-known-ack-interrupted-restoration-outcome.json',
            'terminalStatus': 'P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED'}
PROFILED_CURRENT_LAYOUT = {'actionIdKey': 'releaseId', 'receiptPrefix': 'p2-profiled-current-',
                          'runtimePrefix': 'runtime-', 'terminalName': 'p2-profiled-current-outcome.json',
                          'terminalStatus': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION'}
PROFILED_CURRENT_RECOVERY_LAYOUT = {'actionIdKey': 'recoveryActionId', 'receiptPrefix': 'p2-profiled-current-recovery-',
                                   'runtimePrefix': 'runtime-profiled-current-recovery-',
                                   'migrationPrefix': 'migration-profiled-current-recovery-',
                                   'terminalName': 'p2-profiled-current-recovery-outcome.json',
                                   'terminalStatus': 'P2_PROFILED_CURRENT_RECOVERED_FENCED'}
PROFILED_CERTIFICATION_LAYOUT = {'actionIdKey': 'certificationActionId', 'receiptPrefix': 'p2-profiled-current-certification-',
                                 'runtimePrefix': 'runtime-profiled-current-certification-',
                                 'terminalName': 'p2-profiled-current-certification-outcome.json',
                                 'terminalStatus': 'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED'}
PROFILED_INTERRUPTED_LAYOUT = {'actionIdKey': 'restorationActionId',
                               'receiptPrefix': 'p2-profiled-known-ack-restoration-',
                               'runtimePrefix': 'runtime-profiled-known-ack-restoration-',
                               'terminalName': 'p2-profiled-known-ack-interrupted-restoration-outcome.json',
                               'terminalStatus': 'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED'}
PROFILED_REPLACEMENT_ARM_LAYOUT = {'actionIdKey': 'releaseId', 'receiptPrefix': 'p2-profiled-replacement-arm-',
                                   'terminalName': 'p2-frontend-replacement-arm-outcome.json',
                                   'terminalStatus': 'P2_FRONTEND_REPLACEMENT_ARM_COMMITTED'}
PROFILED_REPLACEMENT_WRITE_LAYOUT = {'actionIdKey': 'releaseId', 'receiptPrefix': 'p2-profiled-replacement-write-'}
PROFILED_CERTIFICATION_ARM = 'p2-profiled-current-certification-guard-armed.json'
PROFILED_CERTIFICATION_ARM_READY = 'p2-profiled-current-certification-guard-ready.json'
PROFILED_INTERRUPTED_ARM = 'p2-profiled-known-ack-restoration-guard-armed.json'
PROFILED_INTERRUPTED_ARM_READY = 'p2-profiled-known-ack-restoration-guard-ready.json'
PROFILED_INTERRUPTED_FRONTEND_CLOSED = 'p2-profiled-interrupted-frontend-session-closed.json'
PROFILED_CERTIFICATION_CONTAINMENT_NAMES = (
    '^/lash-p2-certification-observer-[a-f0-9]{32}$',
    '^/lash-p2-certification-api-check-(course|community)-[a-f0-9]{32}$',
    '^/lash-p2-profiled-certification-guard-close-[a-f0-9]{32}$',
    '^/lash-p2-profiled-certification-image-check-[a-f0-9]{32}$',
)


def _guard_profile(initial):
    # The supervisor replaces this layout from its fixed source argument.
    if fixed_layout(initial) not in (PROFILED_CURRENT_LAYOUT, PROFILED_CURRENT_RECOVERY_LAYOUT,
                                     PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT,
                                     PROFILED_REPLACEMENT_ARM_LAYOUT, PROFILED_REPLACEMENT_WRITE_LAYOUT):
        return None
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    return migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)


def _verify_guard_source(initial, source):
    checker = verify_profiled_current_source_closure if _guard_profile(initial) is not None else verify_source_closure
    return checker(initial, source)


def _profile_kwargs(initial):
    expected = _guard_profile(initial)
    return {} if expected is None else {'expected_profile': expected}


def cleanup_profiled_current_readonly_containers():
    patterns = ('^/lash-p2-profiled-current-observer-[a-f0-9]{32}$',
                '^/lash-p2-profiled-current-api-check-(course|community)-[a-f0-9]{32}$',
                '^/lash-p2-profiled-current-image-check-[a-f0-9]{32}$')
    failed = None
    for pattern in patterns:
        query = ['docker', 'container', 'ls', '--all', '--filter', 'name=' + pattern, '--format', '{{.ID}}']
        try:
            for identity in runtime.command(query, runtime.SAFE_ENV, 15).splitlines():
                if not re.fullmatch(r'[a-f0-9]{12,64}', identity):
                    failed = 'P2_GUARD_PROFILED_CURRENT_CONTAINER_ID_REFUSED'
                    continue
                try:
                    runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 30)
                except BaseException:
                    failed = 'P2_GUARD_PROFILED_CURRENT_CLEANUP_UNKNOWN'
        except BaseException:
            failed = 'P2_GUARD_PROFILED_CURRENT_CLEANUP_UNKNOWN'
        try:
            if runtime.command(query, runtime.SAFE_ENV, 15):
                failed = 'P2_GUARD_PROFILED_CURRENT_CONTAINER_REMAINS'
        except BaseException:
            failed = 'P2_GUARD_PROFILED_CURRENT_CLEANUP_UNKNOWN'
    if failed:
        raise ValueError(failed)



def fixed_layout(initial):
    # _guardLayout is replaced by supervise from fixed source arguments before
    # forking. Private input cannot select a program, class or receipt path.
    return initial.get('_guardLayout', DEFAULT_LAYOUT)


def action_id(initial):
    key = fixed_layout(initial)['actionIdKey']
    value = initial['candidate']['releaseId'] if key == 'releaseId' else initial.get(key)
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value), 'P2_GUARD_ACTION_ID_REQUIRED')
    return value


def _canonical_sha(value):
    return migrate.file_hash(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def _profiled_certification_directory(initial):
    require(fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT and initial.get('mode') == PROFILED_CERTIFICATION_MODE,
            'P2_PROFILED_CERTIFICATION_FIXED_LAYOUT_REQUIRED')
    path = Path(initial['results']) / (PROFILED_CERTIFICATION_LAYOUT['receiptPrefix'] + action_id(initial))
    migrate.private_directory(path)
    require(path == path.resolve(), 'P2_PROFILED_CERTIFICATION_GUARD_DIRECTORY_REQUIRED')
    return path


def _profiled_interrupted_directory(initial):
    require(fixed_layout(initial) == PROFILED_INTERRUPTED_LAYOUT and initial.get('mode') == PROFILED_INTERRUPTED_MODE,
            'P2_PROFILED_INTERRUPTED_FIXED_LAYOUT_REQUIRED')
    path = Path(initial['results']) / (PROFILED_INTERRUPTED_LAYOUT['receiptPrefix'] + action_id(initial))
    migrate.private_directory(path)
    require(path == path.resolve(), 'P2_PROFILED_INTERRUPTED_GUARD_DIRECTORY_REQUIRED')
    return path


def _profiled_interrupted_arm_record(initial, probe):
    expected = _guard_profile(initial)
    plan, frontend = initial['reviewedPlan'], initial['reviewedPlan']['frontendPlan']
    app_source = initial['candidate']['sources']['frontend']['commit']
    require(plan['sourceCommit'] == frontend['sourceCommit'] == app_source and
            plan['operatorSourceCommit'] == initial['sourceCommit'],
            'P2_PROFILED_INTERRUPTED_GUARD_SOURCE_BINDING_REQUIRED')
    return {'version': 2, 'qualificationTargetProfile': expected,
            'status': 'P2_PROFILED_INTERRUPTED_GUARD_ARMED', 'environment': 'staging',
            'originalReleaseId': initial['candidate']['releaseId'],
            'restorationActionId': action_id(initial), 'operatorSourceCommit': initial['sourceCommit'],
            'sourceCommit': app_source, 'candidateSha256': initial['candidateSha256'],
            'targetSha256': initial['targetSha256'], 'reviewedPlanSha256': _canonical_sha(plan),
            'frontendPlanSha256': frontend['planSha256'], 'probeSha256': _canonical_sha(probe),
            **({'replacementRelease': frontend['replacementRelease']} if 'replacementRelease' in frontend else {})}


def _profiled_interrupted_arm_ready(record, raw):
    return {'version': 2, 'qualificationTargetProfile': record['qualificationTargetProfile'],
            'status': 'P2_PROFILED_INTERRUPTED_GUARD_ARM_READY',
            'armReceiptSha256': migrate.file_hash(raw)}


def _retain_profiled_interrupted_arm(initial, probe):
    directory = _profiled_interrupted_directory(initial)
    record = _profiled_interrupted_arm_record(initial, probe)
    migrate.write_json(directory, PROFILED_INTERRUPTED_ARM, record)
    raw = migrate.read_input(directory, PROFILED_INTERRUPTED_ARM, 65_536)
    migrate.write_json(directory, PROFILED_INTERRUPTED_ARM_READY,
                       _profiled_interrupted_arm_ready(record, raw))


def require_profiled_interrupted_guard_arm(initial, probe):
    from qualification_target_profile import decode_qualification_target_json
    directory = _profiled_interrupted_directory(initial)
    expected = _profiled_interrupted_arm_record(initial, probe)
    def read(name):
        info = (directory / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                stat.S_IMODE(info.st_mode) == 0o600, 'P2_PROFILED_INTERRUPTED_GUARD_ARM_REQUIRED')
        if name == PROFILED_INTERRUPTED_ARM_READY and info.st_nlink == 2:
            raise FileNotFoundError('P2_PROFILED_INTERRUPTED_GUARD_ARM_PUBLICATION_PENDING')
        require(info.st_nlink == 1, 'P2_PROFILED_INTERRUPTED_GUARD_ARM_REQUIRED')
        return migrate.read_input(directory, name, 65_536)
    ready = decode_qualification_target_json(read(PROFILED_INTERRUPTED_ARM_READY), 'carrier')
    raw = read(PROFILED_INTERRUPTED_ARM)
    retained = decode_qualification_target_json(raw, 'carrier')
    require(_canonical_sha(retained) == _canonical_sha(expected) and
            _canonical_sha(ready) == _canonical_sha(_profiled_interrupted_arm_ready(expected, raw)),
            'P2_PROFILED_INTERRUPTED_GUARD_ARM_REQUIRED')
    return retained


def require_profiled_interrupted_frontend_closed(initial, probe):
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    value = decode_qualification_target_json(
        migrate.read_input(_profiled_interrupted_directory(initial), PROFILED_INTERRUPTED_FRONTEND_CLOSED, 65_536),
        'carrier')
    receipt, plan = probe['receipt'], probe['plan']
    fields = {'version', 'qualificationTargetProfile', 'status', 'environment', 'releaseId', 'sourceCommit',
              'targetSha256', 'marker', 'backendPid', 'backendStart', 'admission', 'journalSha256',
              'witnessSha256', 'backendAbsent', 'migrationLockReleased', 'nonceLockReleased'}
    if 'replacementRelease' in plan:
        from p2_certification_parent import REPLACEMENT_PROOF_FIELDS, require_certification_replacement_proof
        fields.update(REPLACEMENT_PROOF_FIELDS)
        require_certification_replacement_proof(value, plan['replacementRelease'])
    migrate.require_profile(expected, value)
    require(type(value.get('version')) is int and value['version'] == 2 and set(value) == fields and
            value['status'] == 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' and value['environment'] == 'staging' and
            all(value[key] == probe[key] for key in ('marker', 'backendPid', 'backendStart')) and
            value['releaseId'] == probe['job']['releaseId'] and value['sourceCommit'] == probe['job']['sourceCommit'] and
            value['targetSha256'] == plan['targetSha256'] and value['journalSha256'] == receipt['journalSha256'] and
            value['witnessSha256'] == receipt['witnessSha256'] and
            all(value[key] is True for key in ('backendAbsent', 'migrationLockReleased', 'nonceLockReleased')) and
            _canonical_sha(value['admission']) == _canonical_sha({'epoch': plan['initialEpoch'], 'newWork': False, 'recovery': False,
                                                                 'active': 0, 'uncertain': 0}),
            'P2_PROFILED_INTERRUPTED_FRONTEND_SESSION_CLOSE_REQUIRED')
    return value


def _validate_profiled_interrupted_arm(initial, probe, job_info):
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    plan, frontend = initial['reviewedPlan'], initial['reviewedPlan']['frontendPlan']
    replacement = 'replacementRelease' in frontend
    boundary = 'replacementRelease' if replacement else 'historicalLogins'
    require(type(probe) is dict and set(probe) == {'version', 'qualificationTargetProfile', 'marker',
            'backendPid', 'backendStart', 'job', 'baseline', 'owner', 'producers', boundary,
            'plan', 'receipt'}, 'P2_PROFILED_INTERRUPTED_GUARD_PROBE_REQUIRED')
    receipt = probe['receipt']
    job = job_info['job']
    migrate.require_profile(expected, probe, probe['job'], probe['job'].get('target'), probe['plan'], receipt,
                            receipt.get('target'))
    from p2_certification_parent import require_certification_replacement_lineage
    require_certification_replacement_lineage(frontend, plan)
    if replacement:
        _require_replacement_certification_probe(frontend, probe, job, expected)
    else:
        migrate.require_profile(expected, probe[boundary], probe[boundary].get('target'))
    app_source = initial['candidate']['sources']['frontend']['commit']
    closed = {'epoch': frontend['initialEpoch'], 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
    require(type(probe['version']) is int and probe['version'] == 2 and
            _canonical_sha(probe['job']) == _canonical_sha(job) and
            _canonical_sha(probe['baseline']) == _canonical_sha(
                decode_qualification_target_json(job_info['schema'], 'carrier')) and
            _canonical_sha(probe['plan']) == _canonical_sha(frontend) and
            probe['owner'] == initial['owner'] and probe['producers'] == initial['inventory']['producers'] and
            _canonical_sha(probe[boundary]) == _canonical_sha(initial['inventory'][boundary]) and
            plan['sourceCommit'] == frontend['sourceCommit'] == job['sourceCommit'] == app_source and
            plan['operatorSourceCommit'] == initial['sourceCommit'] and
            type(probe['marker']) is str and re.fullmatch(r'[a-f0-9]{64}', probe['marker']) and
            probe['marker'] != '0' * 64 and type(probe['backendPid']) is int and probe['backendPid'] > 0 and
            type(probe['backendStart']) is str and 0 < len(probe['backendStart']) <= 80 and
            type(receipt.get('version')) is int and receipt['version'] == 2 and
            receipt.get('status') == 'P2_CERTIFICATION_DATABASE_CURRENT' and receipt.get('service') == 'frontend' and
            receipt.get('releaseId') == initial['candidate']['releaseId'] and receipt.get('sourceCommit') == app_source and
            receipt.get('target') == frontend['nativePlan']['target'] and receipt.get('owner') == initial['owner'] and
            receipt.get('runtime') == frontend['nativePlan']['producer']['role'] and
            receipt.get('candidateSha256') == initial['candidateSha256'] and
            receipt.get('targetSha256') == initial['targetSha256'] and
            receipt.get('certificationActionId') == initial['restorationActionId'] and
            receipt.get('planSha256') == frontend['planSha256'] and receipt.get('sqlReplayed') is False and
            receipt.get('trafficAuthorized') is False and receipt.get('schemaVerified') is True and
            receipt.get('runtimeRoleVerified') is True and type(receipt.get('journalSha256')) is str and
            re.fullmatch(r'[a-f0-9]{64}', receipt['journalSha256']) and receipt['journalSha256'] != '0' * 64 and
            type(receipt.get('witnessSha256')) is str and re.fullmatch(r'[a-f0-9]{64}', receipt['witnessSha256']) and
            receipt['witnessSha256'] != '0' * 64 and
            _canonical_sha(receipt.get('admission')) == _canonical_sha(closed),
            'P2_PROFILED_INTERRUPTED_GUARD_PROBE_REQUIRED')
    migrate.require_contract_identity(initial['candidate'], receipt)


def _profiled_certification_arm_record(initial, probe):
    expected = _guard_profile(initial)
    plan = initial['certificationPlan']
    return {'version': 2, 'qualificationTargetProfile': expected, 'status': 'P2_PROFILED_CERTIFICATION_GUARD_ARMED',
            'environment': 'staging', 'originalReleaseId': initial['candidate']['releaseId'],
            'certificationActionId': action_id(initial), 'sourceCommit': initial['sourceCommit'],
            'candidateSha256': initial['candidateSha256'], 'targetSha256': initial['targetSha256'],
            'planSha256': plan['planSha256'], 'probeSha256': _canonical_sha(probe),
            **({'replacementRelease': plan['replacementRelease']} if 'replacementRelease' in plan else {})}


def require_profiled_certification_guard_arm(initial, probe):
    """Check exact source-owned durable ARM acceptance before mutation."""
    directory = _profiled_certification_directory(initial)
    expected = _profiled_certification_arm_record(initial, probe)
    from qualification_target_profile import decode_qualification_target_json
    def read(name):
        info = (directory / name).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
                'P2_PROFILED_CERTIFICATION_GUARD_ARM_REQUIRED')
        if name == PROFILED_CERTIFICATION_ARM_READY and info.st_nlink == 2:
            raise FileNotFoundError('P2_PROFILED_CERTIFICATION_GUARD_ARM_PUBLICATION_PENDING')
        require(info.st_nlink == 1, 'P2_PROFILED_CERTIFICATION_GUARD_ARM_REQUIRED')
        return migrate.read_input(directory, name, 65_536)
    # The ready record is published only after the ARM record and its parent
    # directory are fsynced. A visible but incomplete ARM write grants nothing.
    ready = decode_qualification_target_json(read(PROFILED_CERTIFICATION_ARM_READY), 'carrier')
    raw = read(PROFILED_CERTIFICATION_ARM)
    retained = decode_qualification_target_json(raw, 'carrier')
    require(_canonical_sha(retained) == _canonical_sha(expected) and
            _canonical_sha(ready) == _canonical_sha(_profiled_certification_arm_ready(expected, raw)),
            'P2_PROFILED_CERTIFICATION_GUARD_ARM_REQUIRED')
    return retained


def _profiled_certification_arm_ready(record, raw):
    return {'version': 2, 'qualificationTargetProfile': record['qualificationTargetProfile'],
            'status': 'P2_PROFILED_CERTIFICATION_GUARD_ARM_READY', 'armReceiptSha256': migrate.file_hash(raw)}


def _retain_profiled_certification_arm(initial, probe):
    directory = _profiled_certification_directory(initial)
    record = _profiled_certification_arm_record(initial, probe)
    migrate.write_json(directory, PROFILED_CERTIFICATION_ARM, record)
    raw = migrate.read_input(directory, PROFILED_CERTIFICATION_ARM, 65_536)
    migrate.write_json(directory, PROFILED_CERTIFICATION_ARM_READY, _profiled_certification_arm_ready(record, raw))


def _validate_profiled_certification_arm(initial, probe, job_info):
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    plan = initial['certificationPlan']
    replacement = 'replacementRelease' in plan
    boundary = 'replacementRelease' if replacement else 'historicalLogins'
    require(type(probe) is dict and set(probe) == {'version', 'qualificationTargetProfile', 'marker', 'backendPid',
            'backendStart', 'job', 'baseline', 'owner', 'producers', boundary, 'plan', 'receipt'},
            'P2_PROFILED_CERTIFICATION_GUARD_PROBE_REQUIRED')
    receipt, job = probe['receipt'], job_info['job']
    migrate.require_profile(expected, probe, probe['job'], probe['job'].get('target'), probe['plan'], receipt, receipt.get('target'))
    if replacement:
        _require_replacement_certification_probe(plan, probe, job, expected)
    else:
        migrate.require_profile(expected, probe[boundary], probe[boundary].get('target'))
    inventory = initial['inventory']
    require(type(probe['version']) is int and probe['version'] == 2 and type(receipt.get('version')) is int and receipt['version'] == 2 and
            _canonical_sha(probe['job']) == _canonical_sha(job) and _canonical_sha(probe['plan']) == _canonical_sha(plan) and
            _canonical_sha(probe['baseline']) == _canonical_sha(decode_qualification_target_json(job_info['schema'], 'carrier')) and
            probe['owner'] == initial['owner'] and probe['producers'] == inventory['producers'] and
            _canonical_sha(probe[boundary]) == _canonical_sha(inventory[boundary]) and
            type(probe['marker']) is str and re.fullmatch(r'[a-f0-9]{64}', probe['marker']) and probe['marker'] != '0' * 64 and
            type(probe['backendPid']) is int and probe['backendPid'] > 0 and type(probe['backendStart']) is str and
            0 < len(probe['backendStart']) <= 80 and receipt.get('status') == 'P2_CERTIFICATION_DATABASE_CURRENT' and
            receipt.get('service') == 'frontend' and receipt.get('releaseId') == job['releaseId'] and
            receipt.get('sourceCommit') == initial['sourceCommit'] and
            all(receipt.get(key) == plan[key] for key in ('certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')) and
            receipt.get('target') == plan['nativePlan']['target'] and receipt.get('owner') == initial['owner'] and
            receipt.get('runtime') == plan['nativePlan']['producer']['role'] and
            receipt.get('sqlReplayed') is False and receipt.get('trafficAuthorized') is False and
            receipt.get('schemaVerified') is True and receipt.get('runtimeRoleVerified') is True and
            _canonical_sha(receipt.get('admission')) == _canonical_sha({'epoch': plan['initialEpoch'], 'newWork': False,
                'recovery': False, 'active': 0, 'uncertain': 0}), 'P2_PROFILED_CERTIFICATION_GUARD_PROBE_REQUIRED')
    migrate.require_contract_identity(initial['candidate'], receipt)


def _require_replacement_certification_probe(plan, probe, job, expected):
    from p2_certification_parent import require_certification_replacement_proof, require_certification_replacement_release
    replacement = require_certification_replacement_release(plan['replacementRelease'], expected)
    require(_canonical_sha(probe['replacementRelease']) == _canonical_sha(replacement) and
            type(probe['backendStart']) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z', probe['backendStart']) and
            type(job['target'].get('approvedPendingTags')) is list and bool(job['target']['approvedPendingTags']) and
            job['target'].get('allowEmptyBootstrap') is True, 'P2_PROFILED_CERTIFICATION_REPLACEMENT_GUARD_REQUIRED')
    require_certification_replacement_proof(probe['receipt'], replacement)


def _observe_profiled_replacement_certification(initial, probe, source, operation):
    from p2_certification_parent import P2CertificationPhysicalObserver
    interrupted = fixed_layout(initial) == PROFILED_INTERRUPTED_LAYOUT
    plan = initial['reviewedPlan']['frontendPlan'] if interrupted else initial['certificationPlan']
    require(operation in ('verify-schema', 'verify-closed') and 'replacementRelease' in plan,
            'P2_PROFILED_CERTIFICATION_REPLACEMENT_GUARD_REQUIRED')
    verify_guard_boundary(initial, source)
    directory = _profiled_interrupted_directory(initial) if interrupted else _profiled_certification_directory(initial)
    program = private_observer_program(initial, directory / ('guard-replacement-' + operation))
    observer = P2CertificationPhysicalObserver(initial['candidate'], probe, source,
        initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], program=program,
        program_sha256=initial['sourceSha256'][CERTIFICATION_OBSERVER], expected_profile=_guard_profile(initial),
        interrupted=interrupted)
    observed = observer.probe(operation)
    verify_guard_boundary(initial, source)
    return observed


def _profiled_certification_containers(*, remove):
    failed = None
    for pattern in PROFILED_CERTIFICATION_CONTAINMENT_NAMES:
        query = ['docker', 'container', 'ls', '--all', '--filter', 'name=' + pattern, '--format', '{{.ID}}']
        if remove:
            try:
                for identity in runtime.command(query, runtime.SAFE_ENV, 15).splitlines():
                    if not re.fullmatch(r'[a-f0-9]{12,64}', identity):
                        failed = failed or 'P2_PROFILED_CERTIFICATION_CONTAINER_ID_REFUSED'
                        continue
                    try: runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 30)
                    except BaseException: failed = failed or 'P2_PROFILED_CERTIFICATION_CONTAINER_CLEANUP_UNKNOWN'
            except BaseException:
                failed = failed or 'P2_PROFILED_CERTIFICATION_CONTAINER_CLEANUP_UNKNOWN'
        try:
            if runtime.command(query, runtime.SAFE_ENV, 15):
                failed = failed or 'P2_PROFILED_CERTIFICATION_CONTAINER_REMAINS'
        except BaseException:
            failed = failed or 'P2_PROFILED_CERTIFICATION_CONTAINER_CLEANUP_UNKNOWN'
    if failed:
        raise ValueError(failed)


def cleanup_profiled_certification_containers():
    """Remove and verify absence of only fixed profile certification helpers."""
    _profiled_certification_containers(remove=True)


def cleanup_recovery_current_containers():
    # Both source-fixed read-only namespaces are independent of a revoked
    # mutator scope. Never accept a prefix or container ID from operator JSON.
    failed=None
    for pattern in ('^/lash-p2-recovery-current-(course|community)-[a-f0-9]{32}$',
                    '^/lash-p2-certification-observer-[a-f0-9]{32}$'):
        query=['docker','container','ls','--all','--filter','name='+pattern,'--format','{{.ID}}']
        try:
            for identity in runtime.command(query,runtime.SAFE_ENV,15).splitlines():
                if not re.fullmatch(r'[a-f0-9]{12,64}',identity):
                    failed=failed or 'P2_GUARD_RECOVERY_CONTAINER_ID_REFUSED';continue
                try:runtime.command(['docker','rm','--force',identity],runtime.SAFE_ENV,30)
                except BaseException:failed=failed or 'P2_GUARD_READONLY_CONTAINER_CLEANUP_UNKNOWN'
        except BaseException:failed=failed or 'P2_GUARD_READONLY_CONTAINER_CLEANUP_UNKNOWN'
        # Even a failed rm does not skip absence readback or the other namespace.
        try:
            if runtime.command(query,runtime.SAFE_ENV,15):failed=failed or 'P2_GUARD_RECOVERY_CONTAINER_REMAINS'
        except BaseException:failed=failed or 'P2_GUARD_READONLY_CONTAINER_CLEANUP_UNKNOWN'
    if failed:raise ValueError(failed)


def cleanup_rotation_readonly_containers():
    # Fixed read-only observer containers only. The broker and all registered
    # mutators are reaped before this selector can run.
    patterns = ('^/lash-p2-rotation-current-(course|community)-[a-f0-9]{32}$',
                '^/lash-p2-rotation-close-[a-f0-9]{32}$')
    for pattern in patterns:
        query = ['docker', 'container', 'ls', '--all', '--filter', 'name=' + pattern, '--format', '{{.ID}}']
        for identity in runtime.command(query, runtime.SAFE_ENV, 15).splitlines():
            require(re.fullmatch(r'[a-f0-9]{12,64}', identity), 'P2_GUARD_ROTATION_CONTAINER_ID_REFUSED')
            runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 30)
        require(not runtime.command(query, runtime.SAFE_ENV, 15), 'P2_GUARD_ROTATION_CONTAINER_REMAINS')



def members(group):
    result = []
    if not Path('/proc').is_dir():  # owned macOS process tests; production is Linux
        output = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid='], check=True, capture_output=True, text=True, timeout=5).stdout
        return [int(fields[0]) for line in output.splitlines() if len(fields := line.split()) == 2 and int(fields[1]) == group]
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group:
                result.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError):
            pass
    return result


def stop_group(pid, timeout=2):
    # This guard is a subreaper. Reap adopted Docker CLI children as well as the
    # broker; no still-running worker may race the final container stop.
    deadline = time.monotonic() + timeout
    try:
        os.killpg(pid, signal.SIGSTOP)
    except ProcessLookupError:
        pass
    while members(pid):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        while True:
            try:
                reaped, _ = os.waitpid(-1, os.WNOHANG)
                if not reaped:
                    break
            except ChildProcessError:
                break
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)
    return True


def _stop_profiled_certification_group(child):
    # An interrupted fork may leave our direct child alive before setsid().
    # Its PID is pinned by waitpid until reaped, unlike an arbitrary PID.
    try:
        reaped, _ = os.waitpid(child, os.WNOHANG)
    except ChildProcessError:
        reaped = child
    if not reaped:
        try:
            if os.getpgid(child) != child:
                os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if members(child) and not stop_group(child):
        return False
    try:
        reaped, _ = os.waitpid(child, os.WNOHANG)
    except ChildProcessError:
        return True
    return reaped == child


@contextlib.contextmanager
def sticky_cleanup_signals():
    previous = {item: signal.signal(item, signal.SIG_IGN) for item in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        yield
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def watch_broker(child, safety_read, health_write, arm, *, profiled_certification=False, async_arm=False,
                 authorize_replacement_write=None, verify_replacement_written=None, start_replacement_runtime=None,
                 verify_replacement_closed=None, publish_verified_arm=None):
    require(authorize_replacement_write is None or profiled_certification and async_arm,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    require(verify_replacement_written is None or authorize_replacement_write is not None,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    require(start_replacement_runtime is None or verify_replacement_written is not None,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    require(verify_replacement_closed is None or start_replacement_runtime is not None,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    require(publish_verified_arm is None or callable(publish_verified_arm) and profiled_certification and
            async_arm and authorize_replacement_write is None, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    buffer, last_alive, committed, status = b'', time.monotonic(), None, None
    armed = False
    pending_arm = None
    pending_write = None
    write_requested = False
    pending_written = None
    written_requested = False
    pending_runtime = None
    runtime_requested = False
    pending_closed = None
    closed_requested = False
    while True:
        readable, _, _ = select.select([safety_read], [], [], 0.25)
        if readable:
            chunk = os.read(safety_read, 65536)
            if not chunk:
                break
            buffer += chunk
            require(len(buffer) <= MAXIMUM, 'P2_SAFETY_CHANNEL_BOUNDS')
            while b'\n' in buffer:
                raw, buffer = buffer.split(b'\n', 1)
                if profiled_certification:
                    from qualification_target_profile import decode_qualification_target_json
                    value = decode_qualification_target_json(raw, 'private-packet')
                    keys = {'alive': {'operation'}, 'abort': {'operation'}, 'armed': {'operation', 'probe'},
                            'committed': {'operation', 'sha256'}}
                    if authorize_replacement_write is not None:
                        keys['replacement-write'] = {'operation', 'armReceiptSha256', 'emptyCatalogReceipt'}
                    if verify_replacement_written is not None:
                        from p2_frontend_replacement_parent import WRITTEN_REQUEST_FIELDS
                        keys['replacement-written'] = {'operation', *WRITTEN_REQUEST_FIELDS}
                    if start_replacement_runtime is not None:
                        keys['replacement-runtime'] = {'operation', 'postflightSha256'}
                    if verify_replacement_closed is not None:
                        keys['replacement-closed'] = {'operation', 'providerProofSha256'}
                    require(type(value) is dict and type(value.get('operation')) is str and
                            set(value) == keys.get(value['operation']), 'P2_PROFILED_CERTIFICATION_SAFETY_FRAME_REFUSED')
                else:
                    value = json.loads(raw)
                if value.get('operation') == 'alive':
                    last_alive = time.monotonic()
                elif value.get('operation') == 'armed':
                    if async_arm:
                        require(not armed, 'P2_SAFETY_REARM_REFUSED')
                        pending_arm = arm(value['probe'])
                    else:
                        arm(value['probe'])
                    armed = True
                elif value.get('operation') == 'replacement-write':
                    require(authorize_replacement_write is not None and armed and not write_requested,
                            'P2_SAFETY_REPLACEMENT_WRITE_REFUSED')
                    write_requested = True
                    pending_write = authorize_replacement_write(value)
                elif value.get('operation') == 'replacement-written':
                    require(verify_replacement_written is not None and write_requested and not written_requested,
                            'P2_SAFETY_REPLACEMENT_WRITTEN_REFUSED')
                    written_requested = True
                    pending_written = verify_replacement_written(value)
                elif value.get('operation') == 'replacement-runtime':
                    require(start_replacement_runtime is not None and written_requested and not runtime_requested,
                            'P2_SAFETY_REPLACEMENT_RUNTIME_REFUSED')
                    runtime_requested = True
                    pending_runtime = start_replacement_runtime(value)
                elif value.get('operation') == 'replacement-closed':
                    require(verify_replacement_closed is not None and runtime_requested and not closed_requested,
                            'P2_SAFETY_REPLACEMENT_CLOSE_REFUSED')
                    closed_requested = True
                    pending_closed = verify_replacement_closed(value)
                elif value.get('operation') == 'committed':
                    if authorize_replacement_write is not None:
                        require(verify_replacement_closed is not None and closed_requested and
                                (pending_closed is None or pending_closed.done()), 'P2_SAFETY_REPLACEMENT_WRITE_TERMINAL_REFUSED')
                        if pending_closed is not None:
                            pending_closed.result()
                    if profiled_certification:
                        require(armed and committed is None and type(value['sha256']) is str and
                                (publish_verified_arm is None or pending_arm is None) and
                                re.fullmatch(r'[a-f0-9]{64}', value['sha256']), 'P2_PROFILED_CERTIFICATION_SAFETY_COMMIT_REFUSED')
                    committed = value['sha256']
                else:
                    raise ValueError('P2_BROKER_ABORTED')
        if (pending_arm is not None and pending_arm.done() and
                (publish_verified_arm is None or not buffer and not select.select([safety_read], [], [], 0)[0])):
            verified = pending_arm.result()
            if publish_verified_arm is not None:
                # Only the watcher can publish. Handle any queued abort or EOF
                # first, and do not let executor shutdown arm a dead broker.
                require(status is None and time.monotonic() - last_alive < 5,
                        'P2_PROFILED_CERTIFICATION_ARM_BROKER_LOST')
                pid, observed_status = os.waitpid(child, os.WNOHANG)
                if pid:
                    status = observed_status
                require(status is None, 'P2_PROFILED_CERTIFICATION_ARM_BROKER_LOST')
                publish_verified_arm(verified)
            pending_arm = None
        if pending_write is not None and pending_write.done():
            pending_write.result()
            pending_write = None
        if pending_written is not None and pending_written.done():
            pending_written.result()
            pending_written = None
        if pending_runtime is not None and pending_runtime.done():
            pending_runtime.result()
            pending_runtime = None
        if pending_closed is not None and pending_closed.done():
            pending_closed.result()
            pending_closed = None
        if status is None:
            pid, observed_status = os.waitpid(child, os.WNOHANG)
            if pid:
                status = observed_status
        require(time.monotonic() - last_alive < 5, 'P2_BROKER_HEALTH_LOST')
        if status is None:
            try: os.write(health_write, b'H')
            except BrokenPipeError:
                if not profiled_certification or committed is None:
                    raise
    if profiled_certification:
        require(not buffer and armed and committed is not None, 'P2_PROFILED_CERTIFICATION_SAFETY_TERMINAL_REFUSED')
        deadline = time.monotonic() + 5
        while status is None and time.monotonic() < deadline:
            pid, observed_status = os.waitpid(child, os.WNOHANG)
            if pid:
                status = observed_status
                break
            time.sleep(0.02)
        require(status is not None, 'P2_PROFILED_CERTIFICATION_BROKER_REAP_REQUIRED')
    if status is None:
        _, status = os.waitpid(child, 0)
    require(os.waitstatus_to_exitcode(status) == 0 and committed is not None, 'P2_BROKER_TERMINAL_FAILED')
    if pending_arm is not None:
        pending_arm.result()
    return committed


def close_gateway(initial, selected, configuration):
    if not configuration.exists():
        return {'gatewayAdmissionFileClosed': False, 'gatewayAdmissionAcknowledged': None}
    expected = {'file': '/admission/state.json', 'releaseId': selected['releaseId'],
                'candidateSha256': initial['candidateSha256']}
    gateway = migrate.read_json(configuration, 'gateway.json')
    require(gateway.get('admission') == expected, 'P2_GUARD_GATEWAY_BINDING_REFUSED')
    digest = staging_admission.persist_state(configuration, {'releaseId': expected['releaseId'],
        'candidateSha256': expected['candidateSha256']}, 'p2-failed-' + selected['releaseId'], new_work=False, recovery=False)
    try:
        host = staging_admission.Host(selected, configuration, None)
        observed = host.state()
        acknowledged = observed.get('sha256') == digest and observed.get('newWork') is False and observed.get('recovery') is False
    except BaseException:
        acknowledged = None
    return {'gatewayAdmissionFileClosed': True, 'gatewayAdmissionAcknowledged': acknowledged,
            'closedGatewayAdmissionSha256': digest}


def verify_guard_lock(initial):
    # Source-selected inherited open file description, never an operator DTO.
    descriptor = initial.get('_guardLockDescriptor')
    require(type(descriptor) is int, 'P2_GUARD_BOUNDARY_LOCK_REQUIRED')
    opened, current = os.fstat(descriptor), os.lstat(LOCK)
    require(stat.S_ISREG(current.st_mode) and current.st_uid == 0 and not current.st_mode & 0o077 and
        (current.st_dev,current.st_ino) == (opened.st_dev,opened.st_ino), 'P2_GUARD_BOUNDARY_LOCK_CHANGED')
    fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)


def verify_guard_boundary(initial, source):
    verify_guard_lock(initial)
    _verify_guard_source(initial,source)


def capture_gateway_before_stop(initial, selected, directory, source):
    return p2_prior_gateway.capture_before_stop(initial,selected,directory,lambda:verify_guard_boundary(initial,source),
                                                **_profile_kwargs(initial))


def _profiled_known_ack_runtime_directory(initial):
    action = initial['certificationPlan']['knownAckRecovery']['recoveryActionId']
    require(type(action) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', action),
            'P2_PROFILED_KNOWN_ACK_GUARD_ACTION_REQUIRED')
    return p2_prior_gateway.ROOT / ('p2-profiled-known-ack-' + action) / 'runtime-known-ack'


def _profiled_known_ack_gateway_mount(initial, source):
    def verify():
        verify_guard_boundary(initial, source)
    command = runtime.command
    ids = p2_prior_gateway._inventory(command, verify)
    if not ids:
        return None
    configuration = p2_prior_gateway._mounted_configuration(ids[0], command, verify)
    require(configuration in (Path(initial['configuration']), _profiled_known_ack_runtime_directory(initial) / 'configuration') and
            staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
            'P2_PROFILED_KNOWN_ACK_GUARD_MOUNT_REFUSED')
    return configuration


def _profiled_interrupted_allowed_configurations(initial, source):
    """Recover exact old/B/C configuration roots without live stop selection."""
    from p2_known_ack_interrupted_restoration import (_profiled_causal, _profiled_files,
        _profiled_selection, ROOT as INTERRUPTED_ROOT, root_path)
    expected, selected = _guard_profile(initial), initial['candidate']
    verify_guard_boundary(initial, source)
    selection = _profiled_selection(initial, selected, expected)
    certification = selection['originalCertificationActionId']
    causal = INTERRUPTED_ROOT / ('p2-known-ack-loss-' + certification)
    values = _profiled_files(causal, selection['causalReceiptSha256'], expected)
    _plan, _reviewed, original = _profiled_causal(initial, selection, selected, values, expected)
    old = root_path(original['binding']['configurationDirectory'])
    prior = INTERRUPTED_ROOT / ('p2-profiled-known-ack-' + selection['originalRecoveryActionId']) / \
        'runtime-known-ack' / 'configuration'
    current = _profiled_interrupted_directory(initial) / 'runtime-interrupted' / 'configuration'
    input_directory = root_path(initial['configuration'])
    require(len({input_directory, old, prior, current}) == 4 and old.is_dir(),
            'P2_PROFILED_INTERRUPTED_GUARD_CONFIGURATION_LINEAGE_REFUSED')
    allowed = [old]
    for configuration in (old, prior, current):
        if configuration == old or configuration.exists() or configuration.is_symlink():
            require(configuration == configuration.resolve() and configuration.is_dir() and
                    staging_state.configuration_hashes(configuration) == initial['configurationSha256'] and
                    'sha256:' + migrate.file_hash(migrate.read_input(configuration, 'compose.yaml')) ==
                        selected['runtime']['composeSha256'],
                    'P2_PROFILED_INTERRUPTED_GUARD_CONFIGURATION_CHANGED')
            if configuration != old:
                allowed.append(configuration)
    verify_guard_boundary(initial, source)
    return tuple(allowed)


def _profiled_interrupted_runtime_inventory(initial, source):
    def run(args):
        verify_guard_boundary(initial, source)
        value = runtime.command(args, runtime.SAFE_ENV, 15)
        verify_guard_boundary(initial, source)
        return value
    rows = run(['docker', 'container', 'ls', '--all', '--filter',
        'label=com.docker.compose.project=lash-her-staging', '--format',
        '{{.ID}}|{{.Label "com.docker.compose.service"}}']).splitlines()
    services, observed = set(runtime.SERVICES), {}
    allowed = _profiled_interrupted_allowed_configurations(initial, source)
    for row in rows:
        fields = row.split('|')
        require(len(fields) == 2 and re.fullmatch(r'[a-f0-9]{12,64}', fields[0]) and
                fields[1] in services and fields[1] not in observed,
                'P2_PROFILED_INTERRUPTED_RUNTIME_INVENTORY_REFUSED')
        labels = run(['docker', 'inspect', '--format',
            '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|'
            '{{index .Config.Labels "com.docker.compose.project.config_files"}}|'
            '{{index .Config.Labels "com.docker.compose.service"}}', fields[0]]).split('|')
        require(len(labels) == 3 and labels[2] == fields[1],
                'P2_PROFILED_INTERRUPTED_RUNTIME_LABELS_REFUSED')
        configuration = Path(labels[0])
        require(configuration in allowed and labels[1] == str(configuration / 'compose.yaml') and
                staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
                'P2_PROFILED_INTERRUPTED_GUARD_MOUNT_REFUSED')
        if fields[1] == 'gateway':
            mounted = p2_prior_gateway._mounted_configuration(fields[0], runtime.command,
                                                               lambda: verify_guard_boundary(initial, source))
            require(mounted == configuration,
                    'P2_PROFILED_INTERRUPTED_GATEWAY_RUNTIME_CHANGED')
        observed[fields[1]] = {'containerId': fields[0], 'configuration': str(configuration)}
    return observed


def _profiled_interrupted_running_ids(initial, source):
    verify_guard_boundary(initial, source)
    value = runtime.command(['docker', 'ps', '--filter', 'label=com.docker.compose.project=lash-her-staging',
                             '--format', '{{.ID}}'], runtime.SAFE_ENV, 15).splitlines()
    verify_guard_boundary(initial, source)
    require(all(re.fullmatch(r'[a-f0-9]{12,64}', identity) for identity in value),
            'P2_PROFILED_INTERRUPTED_RUNTIME_INVENTORY_REFUSED')
    return value


def _stop_profiled_interrupted_runtime(initial, source, result):
    try:
        containers = _profiled_interrupted_runtime_inventory(initial, source)
        if not containers:
            result.update(runtimeStopAttempted=False, runtimeStopped=True, runtimeAlreadyAbsent=True)
            return
        configurations = sorted({row['configuration'] for row in containers.values()})
        result['selectedRuntimeConfigurations'] = configurations
        if len(configurations) == 1:
            result['selectedRuntimeConfiguration'] = configurations[0]
        result['selectedRuntimeContainers'] = containers
        verify_guard_boundary(initial, source)
        result['runtimeStopAttempted'] = True
        migrate.suspend_runtime('staging', runtime.SAFE_ENV)
        verify_guard_boundary(initial, source)
        require(_profiled_interrupted_runtime_inventory(initial, source) == containers,
                'P2_PROFILED_INTERRUPTED_RUNTIME_CHANGED_DURING_STOP')
        require(not _profiled_interrupted_running_ids(initial, source),
                'P2_PROFILED_INTERRUPTED_RUNTIME_REMAINS')
        result['runtimeStopped'] = True
    except BaseException:
        result['runtimeStopUncertain'] = True


def remove_profiled_certification_fault_lease(initial, source):
    from p2_certification_fault import LEASE
    plan, configuration = initial['certificationPlan'], Path(initial['configuration'])
    transport_mode = {'fault-before-upstream':'503-before-upstream','known-ack-recovery':'drop-after-ack'}.get(plan['mode'])
    require(transport_mode is not None, 'P2_PROFILED_CERTIFICATION_GUARD_FAULT_MODE_REQUIRED')
    verify_guard_boundary(initial, source)
    require(staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
            'P2_PROFILED_CERTIFICATION_GUARD_CONFIGURATION_CHANGED')
    admission = configuration / 'admission'
    directory = os.open(admission, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        mount = os.fstat(directory)
        require(mount.st_uid == os.getuid() and not mount.st_mode & 0o022,
                'P2_PROFILED_CERTIFICATION_GUARD_FAULT_MOUNT_REFUSED')
        try:
            fd = os.open(LEASE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return
        try:
            existing = os.fstat(fd)
            require(stat.S_ISREG(existing.st_mode) and existing.st_uid == os.getuid() and 0 < existing.st_size <= 8192,
                    'P2_PROFILED_CERTIFICATION_GUARD_FAULT_LEASE_REFUSED')
            raw = os.read(fd, 8193)
            fault = _profiled_certification_directory(initial) / 'fault'
            migrate.private_directory(fault)
            intent = migrate.read_json(fault, 'fault-arm-intent.json', **_profile_kwargs(initial))
            migrate.require_profile(_guard_profile(initial), intent)
            lease = intent['lease']
            require(intent['version'] == 2 and intent['stageId'] == plan['faultSelection']['stageId'] and
                    type(intent['admissionDirectoryDevice']) is int and type(intent['admissionDirectoryInode']) is int and
                    (intent['admissionDirectoryDevice'], intent['admissionDirectoryInode']) == (mount.st_dev, mount.st_ino) and
                    lease['version'] == 1 and lease['stageId'] == intent['stageId'] and
                    lease['releaseId'] == initial['candidate']['releaseId'] and lease['candidateSha256'] == initial['candidateSha256'] and
                    lease['configurationSha256'] == plan['configurationCanonicalSha256'] and
                    lease['gatewayProcessSha256'] == plan['gatewayProcessSha256'] and lease['mode'] == transport_mode and
                    lease['receiver'] == plan['faultSelection']['receiver'] and lease['sourceWitnessSha256'] == plan['faultSelection']['commandSha256'] and
                    len(raw) == existing.st_size and migrate.file_hash(raw) == intent['leaseSha256'] and
                    _canonical_sha(json.loads(raw)) == _canonical_sha(lease), 'P2_PROFILED_CERTIFICATION_GUARD_FOREIGN_FAULT_LEASE')
            verify_guard_boundary(initial, source)
            current_mount = admission.lstat()
            current = os.stat(LEASE, dir_fd=directory, follow_symlinks=False)
            require((current_mount.st_dev, current_mount.st_ino) == (mount.st_dev, mount.st_ino) and
                    (current.st_dev, current.st_ino) == (existing.st_dev, existing.st_ino),
                    'P2_PROFILED_CERTIFICATION_GUARD_FAULT_LEASE_CHANGED')
            os.unlink(LEASE, dir_fd=directory)
            os.fsync(directory)
            try:
                os.stat(LEASE, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise ValueError('P2_PROFILED_CERTIFICATION_GUARD_FAULT_LEASE_REMAINS')
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def _fail_profiled_certification(initial, armed, source, result, record_name, native_containment, frontend_containment):
    result.update(certificationActionId=action_id(initial), targetSha256=initial['targetSha256'],
                  planSha256=initial['certificationPlan']['planSha256'], runtimeStopAttempted=False,
                  nativeDisabled=None, nativeDisableAttempted=False, frontendCloseAttempted=False)
    if armed is None:
        result['status'] = 'P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE'
    if not result['workerProcessesQuiesced']:
        result['profiledCertificationContainerCleanupUncertain'] = True
    else:
        if armed is not None:
            for callback, verified, attempted, unknown in (
                    (native_containment, 'nativeDisabled', 'nativeDisableAttempted', 'nativeContainmentUncertain'),
                    (frontend_containment, 'frontendAdmissionClosed', 'frontendCloseAttempted', 'frontendContainmentUncertain')):
                try:
                    verify_guard_boundary(initial, source)
                    result[attempted] = None
                    state = callback(initial, armed, source)
                    require(type(state) is dict and set(state) == {verified, attempted} and
                            (state[verified] is True or state[verified] is None) and type(state[attempted]) is bool,
                            'P2_PROFILED_CERTIFICATION_CONTAINMENT_RESULT_REFUSED')
                    result[attempted] = state[attempted]
                    verify_guard_boundary(initial, source)
                    result[verified] = state[verified]
                except BaseException:
                    result[unknown] = True
        try:
            verify_guard_boundary(initial, source)
            cleanup_profiled_certification_containers()
            result['profiledCertificationContainerCleanupVerified'] = True
        except BaseException:
            result['profiledCertificationContainerCleanupUncertain'] = True
        if armed is not None:
            _stop_profiled_certification_runtime(initial, source, result, record_name)
            if initial['certificationPlan'].get('mode') in ('fault-before-upstream','known-ack-recovery'):
                result['faultLeaseDisabled'] = None
                if result['runtimeStopped'] is True:
                    try:
                        remove_profiled_certification_fault_lease(initial, source)
                        result['faultLeaseDisabled'] = True
                    except BaseException:
                        result['faultLeaseContainmentUncertain'] = True
    try:
        directory = _profiled_certification_directory(initial)
        migrate.write_json(directory, record_name, result)
    except BaseException:
        result['guardReceiptRetained'] = False
    return result


def contain_profiled_interrupted_after_reap(initial, armed, source, result,
                                            native_containment, frontend_containment):
    """Fixed fallback after the independent broker process tree is absent."""
    require(result.get('workerProcessesQuiesced') is True,
            'P2_PROFILED_INTERRUPTED_BROKER_REAP_REQUIRED')
    result.setdefault('nativeDisabled', None)
    result.setdefault('nativeDisableAttempted', False)
    result.setdefault('frontendAdmissionClosed', None)
    result.setdefault('frontendCloseAttempted', False)
    result.setdefault('runtimeStopped', None)
    result.setdefault('runtimeStopAttempted', False)
    try:
        require_profiled_interrupted_guard_arm(initial, armed)
        result['profiledInterruptedArmReceiptVerified'] = True
    except BaseException:
        # The in-memory value was independently validated before assignment.
        # A failed durable publication must remain visible, but cannot skip
        # containment after the broker may already have started a mutator.
        result['profiledInterruptedArmReceiptUncertain'] = True
    for callback, verified, attempted, unknown in (
            (native_containment, 'nativeDisabled', 'nativeDisableAttempted', 'nativeContainmentUncertain'),
            (frontend_containment, 'frontendAdmissionClosed', 'frontendCloseAttempted', 'frontendContainmentUncertain')):
        try:
            verify_guard_boundary(initial, source)
            state = callback(initial, armed, source)
            require(type(state) is dict and set(state) == {verified, attempted} and
                    (state[verified] is True or state[verified] is None) and type(state[attempted]) is bool,
                    'P2_PROFILED_INTERRUPTED_CONTAINMENT_RESULT_REFUSED')
            verify_guard_boundary(initial, source)
            result.update(state)
        except BaseException:
            result[unknown] = True
    try:
        verify_guard_boundary(initial, source)
        cleanup_profiled_certification_containers()
        result['profiledInterruptedContainerCleanupVerified'] = True
    except BaseException:
        result['profiledInterruptedContainerCleanupUncertain'] = True
    # No prior-gateway capture or ordinary closed-zero gate is consulted.
    # The retained C source owns the interrupted lineage. The guard only
    # identifies and stops the exact currently mounted original/B/C runtime.
    _stop_profiled_interrupted_runtime(initial, source, result)
    if result['frontendAdmissionClosed'] is True and result['nativeDisabled'] is True and result['runtimeStopped'] is True:
        result['trafficAuthorized'] = False
    return result


def _fail_profiled_interrupted(initial, armed, source, result, record_name,
                               native_containment, frontend_containment):
    plan = initial['reviewedPlan']
    result.update(restorationActionId=action_id(initial), targetSha256=initial['targetSha256'],
                  reviewedPlanSha256=_canonical_sha(plan), runtimeStopAttempted=False,
                  nativeDisabled=None, nativeDisableAttempted=False,
                  frontendAdmissionClosed=None, frontendCloseAttempted=False)
    if armed is None:
        result['status'] = 'P2_GUARD_REFUSED_BEFORE_PROFILED_INTERRUPTED_STAGE'
    elif result['workerProcessesQuiesced']:
        contain_profiled_interrupted_after_reap(initial, armed, source, result,
                                                native_containment, frontend_containment)
    else:
        result['profiledInterruptedCleanupUncertain'] = True
    try:
        migrate.write_json(_profiled_interrupted_directory(initial), record_name, result)
    except BaseException:
        result['guardReceiptRetained'] = False
    return result


def _stop_profiled_certification_runtime(initial, source, result, record_name):
    from p2_interactive_window import SCOPED_GATEWAY_BROWSER_STAGES

    selected, configuration = initial['candidate'], Path(initial['configuration'])
    plan = initial['certificationPlan']
    known = plan.get('mode') == 'known-ack-recovery'
    scoped_browser = (plan.get('mode') == 'interactive-browser' and
                      plan.get('scopedAction', {}).get('stage') in SCOPED_GATEWAY_BROWSER_STAGES)
    mounted = None
    prior = None
    try:
        directory = _profiled_certification_directory(initial)
        if record_name == 'p2-independent-guard-after-quiescence.json':
            directory = directory / 'prior-gateway-after-quiescence'
            directory.mkdir(mode=0o700)
        if known:
            mounted = _profiled_known_ack_gateway_mount(initial, source)
        observed = capture_gateway_before_stop(initial, selected, directory, source)
        if known and observed.get('observation') is not None:
            actual = Path(observed['observation']['binding']['configurationDirectory'])
            require(actual in (configuration, _profiled_known_ack_runtime_directory(initial) / 'configuration') and
                    (mounted is None or mounted == actual), 'P2_PROFILED_KNOWN_ACK_GUARD_MOUNT_REFUSED')
        prior = observed
        result['priorGatewayBeforeStopSha256'] = migrate.file_hash(migrate.read_input(directory, p2_prior_gateway.BEFORE_STOP))
        result['priorGatewayBeforeStop'] = prior
        admission = (prior.get('observation') or {}).get('admission') or {}
        if prior['status'] == 'PRIOR_GATEWAY_PRESTOP_OBSERVED' and admission.get('newWork') is False and admission.get('recovery') is False:
            result.update(gatewayAdmissionFileClosed=True, gatewayAdmissionAcknowledged=True,
                          closedGatewayAdmissionSha256=admission.get('sha256'))
    except BaseException:
        result['priorGatewayBeforeStopUnknown'] = True
    if result.get('gatewayAdmissionAcknowledged') is not True:
        try:
            verify_guard_boundary(initial, source)
            selected_configuration = mounted if known else configuration
            require(selected_configuration is not None and staging_state.configuration_hashes(selected_configuration) == initial['configurationSha256'],
                    'P2_PROFILED_CERTIFICATION_GUARD_CONFIGURATION_CHANGED')
            result.update(close_gateway(initial, selected, selected_configuration))
        except BaseException:
            result['gatewayAdmissionFileClosed'] = None
    if scoped_browser:
        result['interactiveGatewayDrainBeforeStop'] = None
        try:
            verify_guard_boundary(initial, source)
            observed = staging_admission.Host(selected, configuration, None).state()
            require(observed.get('version') == 1 and p2_prior_gateway._closed_observed({'admission': observed}) and
                    observed.get('sha256') == result.get('closedGatewayAdmissionSha256'),
                    'P2_PROFILED_CERTIFICATION_GUARD_INTERACTIVE_DRAIN_UNKNOWN')
            result['interactiveGatewayDrainBeforeStop'] = {key: observed[key] for key in ('active', 'uncertain')}
        except BaseException:
            pass
    if result['frontendAdmissionClosed'] is True and result.get('gatewayAdmissionAcknowledged') is True:
        result['trafficAuthorized'] = False
    try:
        verify_guard_boundary(initial, source)
        result['runtimeStopAttempted'] = True
        migrate.suspend_runtime('staging', runtime.SAFE_ENV)
        verify_guard_boundary(initial, source)
        result['runtimeStopped'] = True
    except BaseException:
        pass
    if prior is not None:
        try:
            stopped = p2_prior_gateway.retain_ordered_stop(prior, directory, lambda: verify_guard_boundary(initial, source),
                                                          **_profile_kwargs(initial))
            result['priorGatewayOrderedStop'] = stopped
            result['priorGatewayStopReceiptDirectory'] = str(directory)
            result['priorGatewayStopReceiptSha256'] = migrate.file_hash(migrate.read_input(directory, p2_prior_gateway.STOPPED))
        except BaseException:
            result['priorGatewayOrderedStopUnknown'] = True


def fail_closed(initial, armed, source, *, group=None, record_name='p2-independent-guard-outcome.json', observer_type=None,
                native_containment=None, frontend_containment=None):
    result = {'status': 'P2_INDEPENDENT_GUARD_FAILED_CLOSED_REQUIRES_REVIEW', 'trafficAuthorized': None,
              'sqlReplayAuthorized': False, 'releaseAccepted': False, 'g2Accepted': False,
              'workerProcessesQuiesced': False, 'runtimeStopped': None, 'frontendAdmissionClosed': None}
    expected = _guard_profile(initial)
    if expected is not None:
        result.update(version=2, qualificationTargetProfile=expected, environment='staging',
                      releaseId=initial['candidate']['releaseId'], sourceCommit=initial['sourceCommit'],
                      candidateSha256=initial['candidateSha256'], frontendSqlApplied=False,
                      historicalProviderClosureClaimed=False, oldP200Qualified=False)

    if group is not None:
        try:
            stop = (_stop_profiled_certification_group if fixed_layout(initial) in
                    (PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT) else stop_group)
            result['workerProcessesQuiesced'] = stop(group)
        except BaseException:
            result['workerProcessCleanupUncertain'] = True
    if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT:
        return _fail_profiled_certification(initial, armed, source, result, record_name, native_containment, frontend_containment)
    if fixed_layout(initial) == PROFILED_INTERRUPTED_LAYOUT:
        return _fail_profiled_interrupted(initial, armed, source, result, record_name,
                                          native_containment, frontend_containment)
    if armed is None:
        # Certification starts from an existing runtime but cannot issue any
        # mutator before its separate source-selected armed handshake.
        status = ('P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE' if fixed_layout(initial) == CERTIFICATION_LAYOUT
                  else 'P2_GUARD_REFUSED_BEFORE_ROTATION_STAGE' if fixed_layout(initial) == ROTATION_LAYOUT
                  else 'P2_GUARD_REFUSED_BEFORE_API_STAGE')
        result.update(status=status, runtimeStopAttempted=False)
        if expected is not None:
            # A first readonly observer may have outlived its Docker CLI.
            # There is no authority to stop the prior runtime before arming.
            if result['workerProcessesQuiesced']:
                try:
                    cleanup_profiled_current_readonly_containers()
                except BaseException:
                    result['profiledCurrentReadonlyCleanupUncertain'] = True
            else:
                result['profiledCurrentReadonlyCleanupUncertain'] = True
        return result
    # These values were verified before forking. Mutable input loss is not a
    # reason to skip closure of an already-running release.
    selected = initial['candidate']
    layout, identity = fixed_layout(initial), action_id(initial)
    if layout in (CERTIFICATION_LAYOUT, C_LAYOUT):
        # The fixed source entry supplies this callable before forking. No
        # operator JSON field selects code or a provider action. Reaping the
        # mutator precedes disable; failed/unknown disable must not skip either
        # admission fence or the final runtime stop below.
        result.update(nativeDisabled=None, nativeDisableAttempted=None)
        try:
            require(callable(native_containment), 'P2_CERTIFICATION_NATIVE_CONTAINMENT_REQUIRED')
            native = native_containment(initial, armed, source)
            require(isinstance(native, dict) and set(native) == {'nativeDisabled', 'nativeDisableAttempted'} and
                    (native['nativeDisabled'] is True or native['nativeDisabled'] is None) and
                    type(native['nativeDisableAttempted']) is bool, 'P2_CERTIFICATION_NATIVE_CONTAINMENT_REFUSED')
            result.update(native)
        except BaseException:
            result['nativeContainmentUncertain'] = True
    observer_source = initial.get('_guardObserverSource', 'ops/platform/p2-frontend-live-probe.mjs')
    observer = None
    try:
        private_root = Path(initial['results']) / (layout['receiptPrefix'] + identity)
        program = private_observer_program(initial, private_root / 'guard-source')
        observer = (observer_type or PhysicalObserver)(selected, armed, source, initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], program=program,
                                    program_sha256=initial['sourceSha256'][observer_source])
        observer.probe('fence')
        result['frontendAdmissionClosed'] = True
        result['trafficAuthorized'] = False
    except BaseException:
        pass
    # Certification adopts the exact currently mounted configuration; unlike
    # release/recovery it neither creates nor restores a runtime snapshot.
    snapshot = (Path(initial['configuration']) if layout in (CERTIFICATION_LAYOUT, ROTATION_LAYOUT) else
                Path(initial['results']) / (layout['runtimePrefix'] + identity) / 'configuration')
    directory = Path(initial['results']) / (layout['receiptPrefix'] + identity)
    gateway_directory = directory
    if record_name == 'p2-independent-guard-after-quiescence.json':
        gateway_directory = directory / 'prior-gateway-after-quiescence'
        try: gateway_directory.mkdir(mode=0o700)
        except FileExistsError: pass
    prior = None
    try:
        prior = capture_gateway_before_stop(initial,selected,gateway_directory,source)
        result['priorGatewayBeforeStopSha256'] = migrate.file_hash(migrate.read_input(gateway_directory,p2_prior_gateway.BEFORE_STOP))
        result['priorGatewayBeforeStop'] = prior
        admission = (prior.get('observation') or {}).get('admission') or {}
        acknowledged = prior['status'] == 'PRIOR_GATEWAY_PRESTOP_OBSERVED'
        result.update(gatewayAdmissionFileClosed=acknowledged or None,gatewayAdmissionAcknowledged=acknowledged or None,
            closedGatewayAdmissionSha256=admission.get('sha256'))
    except BaseException:
        result['priorGatewayBeforeStopUnknown'] = True
    if prior is None or prior['status'] != 'PRIOR_GATEWAY_PRESTOP_OBSERVED':
        # Best-effort closure of a newly prepared snapshot does not prove that
        # it was mounted. Preserve the actual observation's unknown status.
        try: result.update(close_gateway(initial, selected, snapshot))
        except BaseException: result['gatewayAdmissionFileClosed'] = None
    # The only processes allowed to start containers have been revoked/reaped.
    # Close known migration containers first, then stop all API/runtime services.
    for name in ('course', 'community'):
        container = 'lash-migrate-' + name + '-' + (identity if expected is not None else selected['releaseId'])
        try:
            query = ['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}']
            if runtime.command(query, runtime.SAFE_ENV, 15):
                runtime.command(['docker', 'rm', '--force', container], runtime.SAFE_ENV, 30)
            require(not runtime.command(query, runtime.SAFE_ENV, 15), 'P2_GUARD_MIGRATION_CONTAINER_REMAINS')
        except BaseException:
            result['migrationContainerCleanupUncertain'] = True
    if layout in (RECOVERY_LAYOUT, CERTIFICATION_LAYOUT, C_LAYOUT):
        try:
            cleanup_recovery_current_containers()
        except BaseException:
            result['recoveryCurrentContainerCleanupUncertain'] = True
    if expected is not None:
        # Never remove an observer while the source worker can still launch it.
        # finish_failure_cleanup retains the flock and retries after actual reap.
        if result['workerProcessesQuiesced']:
            try:
                cleanup_profiled_current_readonly_containers()
            except BaseException:
                result['profiledCurrentReadonlyCleanupUncertain'] = True
        else:
            result['profiledCurrentReadonlyCleanupUncertain'] = True
    if layout == ROTATION_LAYOUT:
        try:
            cleanup_rotation_readonly_containers()
        except BaseException:
            result['rotationReadonlyContainerCleanupUncertain'] = True
    try:
        migrate.suspend_runtime('staging', runtime.SAFE_ENV)
        result['runtimeStopped'] = True
    except BaseException:
        pass
    if prior is not None:
        try:
            stopped = p2_prior_gateway.retain_ordered_stop(prior,gateway_directory,lambda:verify_guard_boundary(initial,source), **_profile_kwargs(initial))
            result['priorGatewayOrderedStop'] = stopped
            result['priorGatewayStopReceiptDirectory'] = str(gateway_directory)
            result['priorGatewayStopReceiptSha256'] = migrate.file_hash(migrate.read_input(gateway_directory,p2_prior_gateway.STOPPED))
        except BaseException: result['priorGatewayOrderedStopUnknown'] = True
    directory = Path(initial['results']) / (layout['receiptPrefix'] + identity)
    if directory.is_dir():
        try:
            migrate.write_json(directory, record_name, result)
        except BaseException:
            result['guardReceiptRetained'] = False
    return result


def finish_failure_cleanup(initial, armed, source, child, *, observer_type=None, native_containment=None, frontend_containment=None):
    options = {'observer_type': observer_type, 'native_containment': native_containment}
    if fixed_layout(initial) in (PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT):
        options['frontend_containment'] = frontend_containment
    failed = fail_closed(initial, armed, source, group=child, **options)
    if (armed is not None or _guard_profile(initial) is not None) and not failed['workerProcessesQuiesced']:
        # Admissions have already been closed/stopped as far as can be
        # observed. Keep the actual flock while an unreaped mutator survives.
        stop = (_stop_profiled_certification_group if fixed_layout(initial) in
                (PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT) else stop_group)
        while True:
            try:
                if stop(child):
                    break
            except BaseException:
                if fixed_layout(initial) not in (PROFILED_CERTIFICATION_LAYOUT, PROFILED_INTERRUPTED_LAYOUT):
                    raise
            time.sleep(1)
        failed = fail_closed(initial, armed, source, group=child,
                             record_name='p2-independent-guard-after-quiescence.json', **options)
    if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT and failed.get('profiledCertificationContainerCleanupUncertain'):
        # A timed-out guard close may still own a Docker process. Keep the
        # canonical flock and retry only fixed removal and absence readback.
        # Neither frontend closure nor provider disable may be replayed here.
        while True:
            try:
                verify_guard_boundary(initial, source)
                cleanup_profiled_certification_containers()
                break
            except BaseException:
                time.sleep(1)
        failed = {**failed, 'profiledCertificationContainerCleanupVerified': True,
                  'profiledCertificationContainerCleanupUncertain': False}
        try:
            migrate.write_json(_profiled_certification_directory(initial),
                               'p2-independent-guard-after-container-cleanup.json', failed)
        except BaseException:
            failed['guardReceiptRetained'] = False
    return failed


def _require_profiled_certification_terminal(initial, raw, committed, *, source=None):
    from p2_certification_parent import require_certification_replacement_lineage
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    terminal = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(expected, terminal)
    plan = initial['certificationPlan']
    require_certification_replacement_lineage(plan, terminal)
    require(migrate.file_hash(raw) == committed and type(terminal.get('version')) is int and terminal['version'] == 2 and
            terminal.get('status') == PROFILED_CERTIFICATION_LAYOUT['terminalStatus'] and
            all(terminal.get(key) == plan[key] for key in ('environment', 'certificationActionId', 'originalReleaseId',
                'sourceCommit', 'candidateSha256', 'targetSha256', 'planSha256', 'mode')) and
            terminal.get('releaseId') == initial['candidate']['releaseId'] and
            _canonical_sha(terminal.get('configurationSha256')) == _canonical_sha(initial['configurationSha256']) and
            all(terminal.get(key) is False for key in ('frontendSqlApplied', 'trafficAuthorized', 'releaseAccepted', 'sqlReplayed')) and
            terminal.get('nativeDisabled') is True, 'P2_PROFILED_CERTIFICATION_GUARD_TERMINAL_REFUSED')
    migrate.require_contract_identity(initial['candidate'], terminal)
    frontend, gateway = terminal.get('frontendAdmission'), terminal.get('gatewayAdmission')
    require(type(frontend) is dict and type(gateway) is dict and all(
        row.get('newWork') is False and row.get('recovery') is False for row in (frontend, gateway)) and
        type(frontend.get('epoch')) is str and re.fullmatch(r'[1-9][0-9]{0,17}', frontend['epoch']) and
        type(frontend.get('active')) is int and frontend['active'] == 0 and
        type(frontend.get('uncertain')) is int and frontend['uncertain'] == 0 and
        all(_canonical_sha(gateway.get(key)) == _canonical_sha({'newWork': 0, 'recovery': 0}) for key in ('active', 'uncertain')),
        'P2_PROFILED_CERTIFICATION_GUARD_TERMINAL_NOT_CLOSED')
    scoped_status = {
        'export-cleanup': 'P2_SCOPED_EXPORT_CLEANUP_JOINED',
        'mux-callback-recovery': 'P2_SCOPED_MUX_CLOSED',
        'lifecycle-persistence': {
            'capture-export-ready': 'P2_LIFECYCLE_EXPORT_READY_CAPTURED',
            'capture-delete-baseline': 'P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED',
            'verify-delete': 'P2_LIFECYCLE_DELETE_PERSISTENCE_VERIFIED',
        }.get(plan.get('scopedAction', {}).get('stage')),
    }.get(plan['mode'])
    if plan['mode'] == 'interactive-browser':
        from p2_interactive_window import (SCOPED_GATEWAY_BROWSER_STAGES, browser_artifact, browser_case_evidence,
                                            browser_evidence_limit, browser_receipt, browser_status, media_upload_selected,
                                            require_browser_ledger, require_media_upload_gateway, verify_browser_controller)
        scoped_status = browser_status(plan, 'JOINED')
    if scoped_status is not None:
        directory = _profiled_certification_directory(initial)
        retained = migrate.read_input(directory, 'p2-scoped-case-joined.json')
        case = decode_qualification_target_json(retained, 'carrier')
        migrate.require_profile(expected, case)
        epoch = int(plan['initialEpoch']) + (2 if plan['mode'] in ('export-cleanup', 'interactive-browser') else 0)
        require(type(case.get('version')) is int and case['version'] == 2 and
                case.get('status') == terminal.get('caseStatus') == scoped_status and
                terminal.get('caseOutcomeSha256') == _canonical_sha(case) and
                gateway.get('valid') is True and gateway.get('version') == 1 and
                frontend['epoch'] == str(epoch),
                'P2_PROFILED_CERTIFICATION_GUARD_SCOPED_CASE_REFUSED')
        if plan['mode'] == 'interactive-browser':
            program_sha = verify_browser_controller(initial, source or Path(__file__).resolve().parents[3])
            evidence = decode_qualification_target_json(
                migrate.read_input(directory, browser_artifact(plan, 'evidence'), browser_evidence_limit(plan)), 'carrier')
            witness = decode_qualification_target_json(migrate.read_input(directory, browser_artifact(plan, 'ledger')), 'carrier')
            operation_count = require_browser_ledger(plan, witness)
            gateway_artifact = None
            if plan['scopedAction']['stage'] in SCOPED_GATEWAY_BROWSER_STAGES:
                gateway_artifact = decode_qualification_target_json(migrate.read_input(directory, browser_artifact(plan, 'gateway'), 8192), 'carrier')
            expected_case = {**browser_receipt(plan, 'JOINED'), **browser_case_evidence(plan, evidence, gateway_artifact=gateway_artifact),
                             'browserProgramSha256': program_sha, 'frontendAdmission': frontend,
                             'frontendOperationCount': operation_count, 'gatewayAdmissionClosed': True,
                             'gatewayActive': 0, 'gatewayUncertain': 0}
            if media_upload_selected(plan):
                for part, name in (('dispatchIntent', 'upload-intent'), ('dispatchOutcome', 'upload-http'), ('callback', 'upload-callback')):
                    retained_part = decode_qualification_target_json(
                        migrate.read_input(directory, browser_artifact(plan, name), 8192), 'carrier')
                    require(_canonical_sha(retained_part) == _canonical_sha(evidence[part]),
                            'P2_PROFILED_CERTIFICATION_GUARD_MEDIA_EVIDENCE_CHANGED')
                require_media_upload_gateway(evidence, gateway)
            require(_canonical_sha(case) == _canonical_sha(expected_case) and type(gateway.get('version')) is int and
                    gateway.get('releaseId') == initial['candidate']['releaseId'] and
                    gateway.get('candidateSha256') == initial['candidateSha256'] and
                    terminal.get('witnessSha256') == migrate.file_hash(
                        json.dumps(witness, separators=(',', ':'), ensure_ascii=False).encode()) and
                    all(terminal.get(key) is False for key in ('nativeInvocationQualified', 'persistenceAuthorityJoined',
                        'deployedCertificationComplete', 'directWorkerSourceJoined', 'runtimeReplaced', 'wholeReleaseAccepted')),
                    'P2_PROFILED_CERTIFICATION_GUARD_INTERACTIVE_CASE_REFUSED')
    if plan['mode'] == 'known-ack-recovery':
        joined = migrate.read_input(_profiled_certification_directory(initial), 'known-ack-replacement-joined.json')
        retained = migrate.read_input(_profiled_known_ack_runtime_directory(initial), 'known-ack-runtime-outcome.json')
        runtime_outcome = decode_qualification_target_json(retained, 'carrier')
        migrate.require_profile(expected, runtime_outcome)
        migrate.require_contract_identity(initial['candidate'], runtime_outcome)
        require_certification_replacement_lineage(plan, runtime_outcome)
        known = terminal['knownAckLoss']
        require(joined == retained and terminal.get('knownAckRuntimeReceiptSha256') == migrate.file_hash(retained) and
                terminal.get('runtimeReplaced') is True and known['replacementCompletedClosed'] is True and
                known['ordinaryClosedZeroGate'] is False and known['oldGatewayUncertain'] == {'newWork':0,'recovery':1} and
                type(runtime_outcome.get('version')) is int and runtime_outcome['version'] == 2 and
                runtime_outcome['status'] == 'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED' and
                runtime_outcome['recoveryActionId'] == known['recoveryActionId'] == plan['knownAckRecovery']['recoveryActionId'] and
                runtime_outcome['recoveryIntentSha256'] == plan['knownAckRecovery']['intentSha256'] and
                runtime_outcome['candidateSha256'] == initial['candidateSha256'] and
                runtime_outcome['frontendOperationId'] == known['operationId'] and
                runtime_outcome['runtimeReplacements'] == 1 and all(runtime_outcome.get(key) is False for key in
                    ('sqlReplayed','frontendSqlApplied','migrationsExecuted','trafficAuthorized')) and
                all(gateway.get(key) == value for key,value in runtime_outcome['newGateway']['admission'].items()),
                'P2_PROFILED_CERTIFICATION_GUARD_KNOWN_ACK_TERMINAL_REFUSED')
    return terminal


def _verify_media_upload_after_reap(initial, source, terminal):
    from p2_interactive_window import browser_artifact, require_media_upload_gateway
    from p2_replacement_successor import _observe
    from qualification_target_profile import decode_qualification_target_json

    plan = initial['certificationPlan']
    evidence = decode_qualification_target_json(migrate.read_input(_profiled_certification_directory(initial),
        browser_artifact(plan, 'evidence'), 8192), 'carrier')
    deadline = time.monotonic() + 25

    def verify():
        require(time.monotonic() < deadline, 'P2_PROFILED_CERTIFICATION_MEDIA_FINAL_RUNTIME_TIMEOUT')
        verify_guard_lock(initial)

    def bounded_run(args, **kwargs):
        verify()
        timeout = min(kwargs['timeout'], deadline - time.monotonic())
        require(timeout > 0, 'P2_PROFILED_CERTIFICATION_MEDIA_FINAL_RUNTIME_TIMEOUT')
        return subprocess.run(args, **{**kwargs, 'timeout': timeout})

    token = runtime._command_scope.set(SimpleNamespace(run=bounded_run))
    try:
        containers, gateway, process = _observe(initial, source, initial['candidate'], _guard_profile(initial),
            Path(initial['configuration']), verify, include_full_admission=True)
    finally:
        runtime._command_scope.reset(token)
    require(_canonical_sha(containers) == plan['runtimeInventorySha256'] and process == plan['gatewayProcessSha256'] and
            _canonical_sha(gateway['admission']) == _canonical_sha(terminal['gatewayAdmission']),
            'P2_PROFILED_CERTIFICATION_MEDIA_FINAL_RUNTIME_CHANGED')
    require_media_upload_gateway(evidence, gateway['admission'])
    verify_guard_boundary(initial, source)


def _require_profiled_interrupted_terminal(initial, raw, committed):
    from p2_certification_parent import require_certification_replacement_lineage
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    terminal = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(expected, terminal)
    require_certification_replacement_lineage(initial.get('reviewedPlan', {}).get('frontendPlan', {}), terminal)
    directory = _profiled_interrupted_directory(initial)
    retained = migrate.read_input(directory / 'runtime-interrupted',
                                  'profiled-interrupted-runtime-outcome.json')
    require(raw == retained, 'P2_PROFILED_INTERRUPTED_GUARD_RUNTIME_RECEIPT_CHANGED')
    require(migrate.file_hash(raw) == committed and type(terminal.get('version')) is int and terminal['version'] == 2 and
            terminal.get('status') == PROFILED_INTERRUPTED_LAYOUT['terminalStatus'] and
            terminal.get('environment') == 'staging' and terminal.get('releaseId') == initial['candidate']['releaseId'] and
            terminal.get('restorationActionId') == initial['restorationActionId'] and
            terminal.get('candidateSha256') == initial['candidateSha256'] and
            terminal.get('frontier') in ('original-stopped-one', 'replacement-stopped-zero') and
            type(terminal.get('apiDatabases')) is dict and set(terminal['apiDatabases']) == {'course', 'community'} and
            terminal.get('currentApiDatabasesAfter') == terminal['apiDatabases'] and
            type(terminal.get('stoppedGateway')) is dict and type(terminal.get('newGateway')) is dict and
            p2_prior_gateway._closed_observed(terminal['stoppedGateway']) and
            all(value == 0 for value in terminal['stoppedGateway']['admission']['active'].values()) and
            p2_prior_gateway._zero(terminal['newGateway']) and
            terminal.get('runtimeReplacements') == 1 and
            all(terminal.get(key) is False for key in ('frontendSqlApplied', 'trafficAuthorized', 'sqlReplayed',
                'migrationsExecuted', 'rolePreparationRepeated', 'newWorkOpened', 'recoveryOpened')) and
            terminal.get('nativeDisabled') is True,
            'P2_PROFILED_INTERRUPTED_GUARD_TERMINAL_REFUSED')
    stopped_uncertain = terminal['stoppedGateway']['admission']['uncertain']
    require(stopped_uncertain == ({'newWork': 0, 'recovery': 1} if terminal['frontier'] == 'original-stopped-one'
                                  else {'newWork': 0, 'recovery': 0}),
            'P2_PROFILED_INTERRUPTED_GUARD_FRONTIER_REFUSED')
    migrate.require_contract_identity(initial['candidate'], terminal)
    return terminal


def _require_profiled_interrupted_gateway_after_reap(initial, source, terminal):
    selected = initial['candidate']
    expected = _guard_profile(initial)
    context = {key: initial[key] for key in ('candidateSha256', 'hostMachineId', 'configurationSha256')}
    context.update(version=2, qualificationTargetProfile=expected, recoveryActionId=action_id(initial))
    def verify():
        verify_guard_boundary(initial, source)

    observed = p2_prior_gateway.observe_prior_gateway(context, selected, verify, expected_profile=expected)
    snapshot = _profiled_interrupted_directory(initial) / 'runtime-interrupted' / 'configuration'
    require(observed == terminal['newGateway'] and p2_prior_gateway._zero(observed) and
            observed['binding']['configurationDirectory'] == str(snapshot) and
            p2_prior_gateway._read_lineage() == {
                'protocol': p2_prior_gateway.PROTOCOL, 'state': 'running-observed',
                'actionId': action_id(initial), 'candidateSha256': initial['candidateSha256'],
                'process': observed['process'], 'binding': observed['binding'],
            },
            'P2_PROFILED_INTERRUPTED_GUARD_NEW_GATEWAY_CHANGED')
    verify()


def supervise(initial, *, broker_type=Broker, observer_type=PhysicalObserver,
              observer_source='ops/platform/p2-frontend-live-probe.mjs', layout=None, native_containment=None,
              frontend_containment=None):
    require(initial.get('mode') not in (PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE),
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    layout = dict(DEFAULT_LAYOUT if layout is None else layout)
    require(issubclass(broker_type, Broker) and issubclass(observer_type, PhysicalObserver), 'P2_FIXED_SOURCE_TYPES_REQUIRED')
    rotation_types = None
    if layout == ROTATION_LAYOUT:
        from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver
        rotation_types = (P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver)
    profiled = False
    if layout == PROFILED_CURRENT_LAYOUT:
        from p2_profiled_current_parent import P2ProfiledCurrentBroker, P2ProfiledCurrentPhysicalObserver
        profiled = (broker_type is P2ProfiledCurrentBroker and observer_type is P2ProfiledCurrentPhysicalObserver
                    and initial.get('mode') == 'p2-profiled-current-release')
    elif layout == PROFILED_CURRENT_RECOVERY_LAYOUT:
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker, P2ProfiledCurrentRecoveryPhysicalObserver
        profiled = (broker_type is P2ProfiledCurrentRecoveryBroker and observer_type is P2ProfiledCurrentRecoveryPhysicalObserver
                    and initial.get('mode') == 'p2-profiled-current-recovery')
    profiled = (profiled and observer_source == 'ops/platform/p2-profiled-current-probe.mjs'
                and native_containment is None)
    profiled_certification = False
    if initial.get('mode') == PROFILED_CERTIFICATION_MODE or layout == PROFILED_CERTIFICATION_LAYOUT:
        import p2_certification_parent as certification_parent
        profiled_certification = (
            initial.get('mode') == PROFILED_CERTIFICATION_MODE and layout == PROFILED_CERTIFICATION_LAYOUT and
            broker_type is getattr(certification_parent, 'P2ProfiledCertificationBroker', None) and
            observer_type is certification_parent.P2CertificationPhysicalObserver and observer_source == CERTIFICATION_OBSERVER and
            callable(native_containment) and native_containment is getattr(certification_parent, 'contain_profiled_certification_native', None) and
            callable(frontend_containment) and frontend_containment is getattr(certification_parent, 'contain_profiled_certification_frontend', None))
        require(profiled_certification, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    elif initial.get('mode') != PROFILED_INTERRUPTED_MODE and layout != PROFILED_INTERRUPTED_LAYOUT:
        require(frontend_containment is None, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    profiled_interrupted = False
    interrupted_parent = None
    if initial.get('mode') == PROFILED_INTERRUPTED_MODE or layout == PROFILED_INTERRUPTED_LAYOUT:
        import p2_profiled_known_ack_restoration_parent as interrupted_parent
        import p2_certification_parent as certification_parent
        profiled_interrupted = (
            initial.get('mode') == PROFILED_INTERRUPTED_MODE and layout == PROFILED_INTERRUPTED_LAYOUT and
            broker_type is getattr(interrupted_parent, 'P2ProfiledInterruptedKnownAckBroker', None) and
            observer_type is certification_parent.P2CertificationPhysicalObserver and
            observer_source == CERTIFICATION_OBSERVER and
            callable(native_containment) and native_containment is
                getattr(interrupted_parent, 'contain_profiled_interrupted_native', None) and
            callable(frontend_containment) and frontend_containment is
                getattr(interrupted_parent, 'contain_profiled_interrupted_frontend', None))
        require(profiled_interrupted, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    interrupted = False
    if initial.get('mode') == 'known-ack-interrupted-restoration':
        from p2_known_ack_interrupted_restoration import InterruptedKnownAckRestorationBroker, InterruptedRestorationPhysicalObserver, contain_interrupted_native
        interrupted = (layout == C_LAYOUT and broker_type is InterruptedKnownAckRestorationBroker and
                       observer_type is InterruptedRestorationPhysicalObserver and
                       observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is contain_interrupted_native)
    require((layout == DEFAULT_LAYOUT and broker_type is Broker and observer_type is PhysicalObserver
             and observer_source == 'ops/platform/p2-frontend-live-probe.mjs' and native_containment is None) or
            (layout == RECOVERY_LAYOUT and initial.get('mode') == 'p2-post-sql-recovery'
             and observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is None) or
            (layout == CERTIFICATION_LAYOUT and initial.get('mode') == 'p2-bounded-certification'
             and observer_source == 'ops/platform/p2-certification-current-probe.mjs' and callable(native_containment)) or
            (layout == ROTATION_LAYOUT and initial.get('mode') == 'p2-identity-key-rotation'
             and rotation_types == (broker_type, observer_type)
             and observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is None) or interrupted or profiled or
            profiled_certification or profiled_interrupted,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    initial['_guardLayout'], initial['_guardObserverSource'] = layout, observer_source
    expected = _guard_profile(initial)
    if expected is not None:
        require((profiled or profiled_certification or profiled_interrupted) and initial.get('version') == 2,
                'PROFILED_CURRENT_FIXED_SOURCE_DISPATCH_REQUIRED')
        if profiled_certification or profiled_interrupted:
            require(type(initial['version']) is int, 'PROFILED_CURRENT_FIXED_SOURCE_DISPATCH_REQUIRED')
        migrate.require_profile(expected, initial)
    identity = action_id(initial)
    require(os.geteuid() == 0 and sys.platform == 'linux' and initial.get('environment') == 'staging', 'P2_LINUX_ROOT_GUARD_REQUIRED')
    source = Path(__file__).resolve().parents[3]
    require(migrate.source_commit(initial.get('sourceCommit')) and str(source) == '/opt/lash-her/operators/' + initial['sourceCommit'],
            'P2_INSTALLED_GUARD_SOURCE_REQUIRED')
    selected, verified_jobs = migrate.make_plan(Path(initial['bundle']), **_profile_kwargs(initial))
    require(selected == initial['candidate'] and migrate.file_hash(migrate.read_input(Path(initial['bundle']), 'release.candidate.json')) == initial.get('candidateSha256'),
            'P2_GUARD_CANDIDATE_BINDING_REFUSED')
    if expected is not None:
        require(initial.get('apiJobSha256') == migrate.profiled_current_job_hashes(Path(initial['bundle'])),
                'PROFILED_CURRENT_GUARD_API_JOB_BYTES_REFUSED')
    _verify_guard_source(initial, source)
    require(observer_source in initial['sourceSha256'], 'P2_FIXED_OBSERVER_CLOSURE_REQUIRED')
    initial['_guardObserverProgram'] = migrate.read_input(source, observer_source)
    # Linux subreaper adoption prevents orphaned mutating Docker CLI workers
    # from surviving a killed broker and racing the final container inventory.
    require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'P2_GUARD_SUBREAPER_REQUIRED')
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, 'P2_GUARD_LOCK_REFUSED')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    initial['_guardLockDescriptor'] = fd
    if profiled_certification:
        try:
            plan_mode = initial['certificationPlan']['mode']
            input_fields = certification_parent.PROFILED_INITIAL_FIELDS | (
                {'sourceSuspensionPlan'} if plan_mode in certification_parent.SUSPENSION_MODES else set())
            verified = certification_parent.prepare_profiled_current_certification_input(
                {key: initial[key] for key in input_fields}, source)
            require(verified.get('status') == 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED' and
                    verified.get('executionEligible') is False and verified.get('planSha256') == initial['certificationPlan']['planSha256'],
                    'P2_PROFILED_CERTIFICATION_GUARD_INPUT_REQUIRED')
        except BaseException:
            os.close(fd)
            raise
    elif profiled_interrupted:
        try:
            verified_plan, _original, verified_selected, verified_interrupted_jobs = \
                interrupted_parent.prepare_profiled_interrupted_input(
                    interrupted_parent.profiled_interrupted_review(initial), source)
            require(verified_plan == initial['reviewedPlan'] and verified_selected == selected and
                    verified_interrupted_jobs == verified_jobs,
                    'P2_PROFILED_INTERRUPTED_GUARD_INPUT_REQUIRED')
        except BaseException:
            os.close(fd)
            raise
    safety_read, safety_write = os.pipe()
    health_read, health_write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(safety_read); os.close(health_write); os.setsid()
        broker, committed = None, False
        try:
            def emit(value):
                print(json.dumps(value, separators=(',', ':')), flush=True)
            broker = broker_type(initial, emit, shared_lock_fd=fd, safety_write=safety_write, guard_read=health_read,
                                 observer_type=observer_type, observer_source=observer_source)
            broker.initialize(); broker.send(0, 'LOCKED')
            while True:
                raw = sys.stdin.buffer.readline(MAXIMUM + 1)
                if not raw:
                    break
                require(len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_PROTOCOL_INPUT_REFUSED')
                if expected is None:
                    value = json.loads(raw)
                else:
                    from qualification_target_profile import decode_qualification_target_json
                    value = decode_qualification_target_json(raw, 'private-packet')
                if value.get('operation') == 'check':
                    broker.command(value)
                else:
                    # The profiled worker flushes its ACK before returning.
                    # Its next ordered stage may arrive during that tiny tail;
                    # wait on the actual mutex, never overlap or replay stages.
                    acquired = (broker.operation_active.acquire(timeout=2) if profiled or profiled_certification or profiled_interrupted else
                                broker.operation_active.acquire(blocking=False))
                    require(acquired, 'P2_CONCURRENT_STAGE_REFUSED')
                    import threading
                    def operation(value=value):
                        try:
                            broker.command(value)
                        except BaseException:
                            broker.abort()
                            broker.send(value.get('id'), 'P2_HOST_STAGE_FAILED')
                        finally:
                            broker.operation_active.release()
                    threading.Thread(target=operation, daemon=True).start()
            committed = broker.committed.is_set()
            require(committed, 'P2_CONTROLLER_DISCONNECTED')
        except BaseException:
            committed = False
        finally:
            if broker:
                broker.close(committed)
            os.close(safety_write); os.close(health_read)
        os._exit(0 if committed else 1)
    os.close(safety_write); os.close(health_read)
    armed = None
    replacement_certification = profiled_certification and 'replacementRelease' in initial['certificationPlan']
    replacement_interrupted = profiled_interrupted and 'replacementRelease' in initial['reviewedPlan']['frontendPlan']
    replacement_guarded = replacement_certification or replacement_interrupted
    try:
        def arm(probe):
            nonlocal armed
            require(armed is None, 'P2_SAFETY_REARM_REFUSED')
            if profiled_certification:
                verify_guard_boundary(initial, source)
                _validate_profiled_certification_arm(initial, probe, verified_jobs['frontend'])
                if replacement_certification:
                    return observer_worker.submit(arm_replacement, probe)
                armed = probe
                _retain_profiled_certification_arm(initial, probe)
                return
            if profiled_interrupted:
                verify_guard_boundary(initial, source)
                _validate_profiled_interrupted_arm(initial, probe, verified_jobs['frontend'])
                if replacement_interrupted:
                    return observer_worker.submit(arm_replacement, probe)
                armed = probe
                _retain_profiled_interrupted_arm(initial, probe)
                return
            armed = probe
            require(probe['job'] == verified_jobs['frontend']['job']
                    and probe['baseline'] == json.loads(verified_jobs['frontend']['schema']), 'P2_SAFETY_SCOPE_REFUSED')

        def arm_replacement(probe):
            _observe_profiled_replacement_certification(initial, probe, source, 'verify-schema')
            if replacement_certification:
                from p2_replacement_successor import verify_replacement_runtime_before_arm
                verify_replacement_runtime_before_arm(initial, source)
            return probe

        def publish_replacement_arm(probe):
            nonlocal armed
            verify_guard_lock(initial)
            armed = probe
            retain_arm = _retain_profiled_interrupted_arm if replacement_interrupted else _retain_profiled_certification_arm
            retain_arm(initial, probe)

        with (ThreadPoolExecutor(max_workers=1) if replacement_guarded else contextlib.nullcontext()) as observer_worker:
            committed = (watch_broker(child, safety_read, health_write, arm, profiled_certification=True,
                                      async_arm=replacement_guarded,
                                      publish_verified_arm=publish_replacement_arm if replacement_guarded else None)
                         if profiled_certification or profiled_interrupted else
                         watch_broker(child, safety_read, health_write, arm))
        result = migrate.read_input(Path(initial['results']) / (layout['receiptPrefix'] + identity), layout['terminalName'])
        if profiled_certification:
            require(not members(child), 'P2_PROFILED_CERTIFICATION_TERMINAL_CHILD_REMAINS')
            verify_guard_boundary(initial, source)
            require_profiled_certification_guard_arm(initial, armed)
            _profiled_certification_containers(remove=False)
            terminal = _require_profiled_certification_terminal(initial, result, committed, source=source)
            if replacement_certification:
                from qualification_target_profile import decode_qualification_target_json
                closed = decode_qualification_target_json(migrate.read_input(_profiled_certification_directory(initial),
                    'p2-certification-frontend-session-closed.json', 16_384), 'carrier')
                fresh = _observe_profiled_replacement_certification(initial, armed, source, 'verify-closed')
                require(_canonical_sha(fresh) == _canonical_sha(closed) and
                        _canonical_sha(fresh['admission']) == _canonical_sha(terminal['frontendAdmission']),
                        'P2_PROFILED_CERTIFICATION_REPLACEMENT_TERMINAL_PHYSICAL_CHANGED')
                _profiled_certification_containers(remove=False)
            verify_guard_boundary(initial, source)
            from p2_interactive_window import media_upload_selected
            if media_upload_selected(initial['certificationPlan']):
                _verify_media_upload_after_reap(initial, source, terminal)
            if initial['certificationPlan'].get('scopedAction', {}).get('stage') == 'lesson-resume':
                from p2_certification_parent import retain_profiled_resume_guard
                retain_profiled_resume_guard(initial, terminal, committed)
            if replacement_certification and initial['certificationPlan']['mode'] == 'known-ack-recovery':
                from p2_replacement_successor import retain_successor_runtime
                retain_successor_runtime(initial, source, terminal, committed, kind='known-ack')
            return
        if profiled_interrupted:
            require(not members(child), 'P2_PROFILED_INTERRUPTED_TERMINAL_CHILD_REMAINS')
            verify_guard_boundary(initial, source)
            require_profiled_interrupted_guard_arm(initial, armed)
            closed = require_profiled_interrupted_frontend_closed(initial, armed)
            if replacement_interrupted:
                fresh = _observe_profiled_replacement_certification(initial, armed, source, 'verify-closed')
                require(_canonical_sha(fresh) == _canonical_sha(closed), 'P2_PROFILED_INTERRUPTED_REPLACEMENT_PHYSICAL_CHANGED')
                _profiled_certification_containers(remove=False)
            terminal = _require_profiled_interrupted_terminal(initial, result, committed)
            _require_profiled_interrupted_gateway_after_reap(initial, source, terminal)
            if replacement_interrupted:
                from p2_replacement_successor import retain_successor_runtime
                retain_successor_runtime(initial, source, terminal, committed, kind='interrupted-known-ack')
            return
        terminal = json.loads(result)
        if expected is not None:
            migrate.require_profile(expected, terminal)
            require(terminal.get('version') == 2 and terminal.get('environment') == 'staging'
                    and terminal.get('releaseId') == selected['releaseId']
                    and terminal.get('candidateSha256') == initial['candidateSha256']
                    and terminal.get('frontendSqlApplied') is False and terminal.get('trafficAuthorized') is False
                    and terminal.get('releaseAccepted') is False, 'PROFILED_CURRENT_GUARD_TERMINAL_REFUSED')
        require(migrate.file_hash(result) == committed and terminal.get('status') == layout['terminalStatus'],
                'P2_GUARD_TERMINAL_RECEIPT_REQUIRED')
    except BaseException:
        with sticky_cleanup_signals():
            options = {'observer_type': observer_type, 'native_containment': native_containment}
            if profiled_certification or profiled_interrupted:
                options['frontend_containment'] = frontend_containment
            finish_failure_cleanup(initial, armed, source, child, **options)
        raise
    finally:
        os.close(safety_read); os.close(health_write); os.close(fd)


def main():
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_INITIAL_INPUT_REFUSED')
    supervise(json.loads(raw))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
    signal.signal(signal.SIGHUP, lambda *_: (_ for _ in ()).throw(SystemExit(129)))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(SystemExit(130)))
    try:
        main()
    except BaseException:
        print('P2_INDEPENDENT_GUARD_FAILED_REQUIRES_REVIEW', file=sys.stderr)
        raise SystemExit(1)
