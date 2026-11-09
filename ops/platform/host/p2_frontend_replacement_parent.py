#!/usr/bin/env python3
"""Fixed staging replacement lock observation under an independent host guard."""

import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import os
from pathlib import Path
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import p2_release_supervisor as supervisor
import release as runtime
import staging_state
from p2_release_broker import Broker, LOCK, MAXIMUM
from p2_source_closure import (PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE,
                               verify_profiled_current_source_closure)
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json

require = migrate.demand
PROFILE = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
MODE = PROFILED_REPLACEMENT_ARM_MODE
WRITE_MODE = PROFILED_REPLACEMENT_WRITE_MODE
LAYOUT = supervisor.PROFILED_REPLACEMENT_ARM_LAYOUT
CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
REFUSED = 'P2_FRONTEND_REPLACEMENT_HOST_ARM_REFUSED'
ARM = 'p2-frontend-replacement-guard-armed.json'
READY = 'p2-frontend-replacement-guard-ready.json'
COMMIT_INTENT = 'p2-frontend-replacement-broker-commit-intent.json'
INTENT_STATUS = 'P2_FRONTEND_REPLACEMENT_BROKER_COMMIT_INTENT'
TERMINAL = LAYOUT['terminalName']
WRITE_BOUNDARY = 'p2-frontend-replacement-empty-catalog.json'
WRITE_INTENT = 'p2-frontend-replacement-write-intent.json'
WRITE_READY = 'p2-frontend-replacement-write-ready.json'
WRITE_OBSERVER_STARTED = 'p2-frontend-replacement-write-observer-started.json'
WRITE_OBSERVER_RETURNED = 'p2-frontend-replacement-write-observer-returned.json'
WRITE_CONTAINMENT = 'p2-frontend-replacement-write-containment.json'
ABORT_ATTEMPT = 'p2-frontend-replacement-abort-attempt.json'
ABORT_OBSERVATION = 'p2-frontend-replacement-abort-observation.json'
ABORT_MAXIMUM = 65_536
NO_AUTHORITY = {'bootstrapAuthorized': False, 'migrationAuthorized': False,
                'deploymentAuthorized': False, 'trafficAuthorized': False}
TARGET_FIELDS = ('host', 'port', 'database', 'user', 'runtimeRole', 'serverMajor')
PROBE_IDENTITY = ('marker', 'backendPid', 'backendStart')
INITIAL_FIELDS = {'version', 'mode', 'qualificationTargetProfile', 'environment', 'sourceCommit', 'sourceSha256',
                  'sourceClosureSha256', 'hostMachineId', 'bundle', 'results', 'candidateSha256',
                  'reviewedPlanBytes', 'reviewedPlanSha256', 'confirmation', 'credentials'}
PLAN_FIELDS = {'version', 'qualificationTargetProfile', 'environment', 'operation', 'status', 'releaseId',
               'sourceCommit', 'reviewSha256', 'targetSha256', 'candidateSha256', 'frontendJobSha256',
               'schemaBaselineFileSha256', 'migrationImageDigest', 'sqlArtifactSha256', 'schemaBaselineSha256',
               'contractManifestSha256', 'phase2ContractManifestSha256', 'predecessor', 'replacement',
               'replacementObserved', 'releaseAccepted', *NO_AUTHORITY}
EMPTY_CATALOG_COUNTERS = set("""
pg_am pg_cast pg_class pg_collation pg_constraint pg_conversion pg_language pg_namespace pg_opclass pg_operator
pg_opfamily pg_proc pg_rewrite pg_statistic_ext pg_trigger pg_ts_config pg_ts_dict pg_ts_parser pg_ts_template
pg_default_acl pg_event_trigger pg_foreign_data_wrapper pg_foreign_server pg_foreign_table pg_largeobject_metadata
pg_policy pg_publication pg_publication_namespace pg_publication_rel pg_transform pg_user_mappings unexpected_schemas
additional_extensions local_subscriptions normal_object_dependencies local_shared_dependencies relevant_role_settings
local_prepared_transactions
""".split())


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, sort_keys=True)


def match(value, pattern):
    return type(value) is str and re.fullmatch(pattern, value) is not None


def digest(value):
    return match(value, r'(?!0+$)[a-f0-9]{64}')


def oid(value):
    return match(value, r'[1-9][0-9]{0,9}') and int(value) <= 4294967295


def unbase64(value, maximum):
    require(type(value) is str and 0 < len(value) <= 4 * ((maximum + 2) // 3), REFUSED)
    raw = base64.b64decode(value, validate=True)
    require(0 < len(raw) <= maximum and base64.b64encode(raw).decode() == value, REFUSED)
    return raw


def exact_host_directory(value):
    require(type(value) is str and ',' not in value, REFUSED)
    path = Path(value)
    require(path == path.resolve() and str(path) == value
            and Path('/var/lib/lash-her/releases/staging') in path.parents, REFUSED)
    staging_state.outside_checkout(path)
    return path


def reviewed_plan(initial, *, mode=MODE):
    require(mode in (MODE, WRITE_MODE), REFUSED)
    require(type(initial) is dict and set(initial) == INITIAL_FIELDS and
            type(initial['version']) is int and initial['version'] == 1 and initial['mode'] == mode and
            initial['environment'] == 'staging' and migrate.source_commit(initial['sourceCommit']) and
            match(initial['hostMachineId'], r'[a-f0-9]{32}') and
            all(digest(initial[key]) for key in ('sourceClosureSha256', 'candidateSha256', 'reviewedPlanSha256')), REFUSED)
    raw = unbase64(initial['reviewedPlanBytes'], 2_000_000)
    require(migrate.file_hash(raw) == initial['reviewedPlanSha256'], REFUSED)
    plan = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(PROFILE, initial, plan)
    require(type(plan) is dict and set(plan) == PLAN_FIELDS and type(plan['version']) is int and plan['version'] == 1
            and plan['environment'] == 'staging' and plan['operation'] == 'profiled-frontend-replacement'
            and plan['status'] == 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED'
            and match(plan['releaseId'], r'[a-z0-9][a-z0-9-]{0,63}')
            and all(plan[key] == initial[key] for key in ('candidateSha256', 'sourceCommit'))
            and all(digest(plan[key]) for key in ('reviewSha256', 'targetSha256', 'frontendJobSha256',
                                                 'schemaBaselineFileSha256'))
            and all(plan[key] is False for key in (*NO_AUTHORITY, 'replacementObserved', 'releaseAccepted'))
            and initial['confirmation'] == 'staging/' + plan['releaseId'] +
                ('/replacement-write/' if mode == WRITE_MODE else '/replacement-arm/') + initial['reviewedPlanSha256'],
            REFUSED)
    credentials = initial['credentials']
    require(type(credentials) is dict and set(credentials) == {CREDENTIAL} and
            type(credentials[CREDENTIAL]) is str and 0 < len(credentials[CREDENTIAL]) <= 16_384
            and all(ord(character) >= 32 for character in credentials[CREDENTIAL]), REFUSED)
    return raw, plan


def prepare(initial, source, *, mode=MODE):
    raw, plan = reviewed_plan(initial, mode=mode)
    require(source == Path('/opt/lash-her/operators') / initial['sourceCommit'] and source == source.resolve(), REFUSED)
    runtime.assert_host({'environment': 'staging', 'hostMachineId': initial['hostMachineId']})
    verify_profiled_current_source_closure(initial, source)
    bundle, results = (exact_host_directory(initial[key]) for key in ('bundle', 'results'))
    require(bundle != results and bundle not in results.parents and results not in bundle.parents, REFUSED)
    selected, jobs = migrate.make_plan(bundle, expected_profile=PROFILE)
    job_info = jobs['frontend']
    job, target = job_info['job'], job_info['job']['target']
    require(selected['environment'] == 'staging' and selected.get('contractPhase') == 'p2'
            and 'sourceGraph' not in selected and selected['releaseId'] == plan['releaseId']
            and selected['sources']['frontend']['commit'] == plan['sourceCommit']
            and all(job[key] == plan[key] for key in ('migrationImageDigest', 'sqlArtifactSha256', 'schemaBaselineSha256',
                                                      'contractManifestSha256', 'phase2ContractManifestSha256')), REFUSED)
    replacement, predecessor = plan['replacement'], plan['predecessor']
    require(type(replacement) is dict and set(replacement) == {
        'provider', 'databaseOid', 'migrationRoleOid', 'administrativeLogins', 'recoveryRef', 'target', 'approvedPendingTags'}
        and type(predecessor) is dict and set(predecessor) == {
        'provider', 'target', 'lineageSha256', 'deploymentId', 'recoveryRef', 'databaseOid', 'loginRoleOid', 'sourceCommit',
        'observedAt', 'appliedCount', 'appliedPrefixSha256', 'pendingTags', 'phase2ContractManifestSha256'}, REFUSED)
    target_projection = {key: target[key] for key in TARGET_FIELDS}
    previous = predecessor['target']
    target_binding = {key: target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}
    require(replacement['target'] == target_projection and target['allowEmptyBootstrap'] is True
            and type(target['port']) is int and target['approvedPendingTags']
            and len(set(target['approvedPendingTags'])) == len(target['approvedPendingTags'])
            and replacement['approvedPendingTags'] == target['approvedPendingTags']
            and replacement['recoveryRef'] == job['recoveryRef']
            and plan['targetSha256'] == migrate.file_hash(encoded({'environment': 'staging', **target_binding}))
            and oid(replacement['databaseOid']) and oid(replacement['migrationRoleOid'])
            and type(previous) is dict and set(previous) == set(TARGET_FIELDS)
            and previous['host'] != target['host'] and previous['runtimeRole'] not in (target['user'], target['runtimeRole']),
            REFUSED)
    base_probe = {'version': 1, 'qualificationTargetProfile': initial['qualificationTargetProfile'],
                  'operation': 'verify-pre-bootstrap-lock', 'candidate': selected, 'job': job,
                  'baseline': decode_qualification_target_json(job_info['schema'], 'carrier'),
                  'predecessorTarget': previous, 'targetSha256': plan['targetSha256'],
                  'databaseOid': replacement['databaseOid'], 'migrationRoleOid': replacement['migrationRoleOid']}
    verify_bundle(bundle, plan, base_probe)
    layout = supervisor.PROFILED_REPLACEMENT_WRITE_LAYOUT if mode == WRITE_MODE else LAYOUT
    directory = results / (layout['receiptPrefix'] + plan['releaseId'])
    return raw, plan, base_probe, job_info['image'], directory


def probe_identity(probe, base_probe):
    require(type(probe) is dict and set(probe) == set(base_probe) | set(PROBE_IDENTITY)
            and all(canonical(probe[key]) == canonical(value) for key, value in base_probe.items())
            and digest(probe['marker']) and type(probe['backendPid']) is int and 0 < probe['backendPid'] <= 2147483647
            and match(probe['backendStart'], r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z'), REFUSED)


def verify_bundle(bundle, plan, probe):
    for path, pin, key in (('release.candidate.json', 'candidateSha256', 'candidate'),
                           ('jobs/frontend.json', 'frontendJobSha256', 'job'),
                           ('schema/frontend.json', 'schemaBaselineFileSha256', 'baseline')):
        raw = migrate.read_input(bundle, path)
        require(migrate.file_hash(raw) == plan[pin] and
                canonical(decode_qualification_target_json(raw, 'carrier')) == canonical(probe[key]), REFUSED)


def observation(probe, raw):
    value = decode_qualification_target_json(raw, 'carrier')
    expected = {key: probe[key] for key in ('version', 'qualificationTargetProfile', 'operation', 'targetSha256',
                                          'databaseOid', 'migrationRoleOid', *PROBE_IDENTITY)}
    expected.update(status='P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED', environment='staging',
                    releaseId=probe['job']['releaseId'], sourceCommit=probe['job']['sourceCommit'],
                    readOnlyVerified=True, authorityIssued=False, trafficAuthorized=False)
    require(type(value) is dict and set(value) == set(expected)
            and all(type(value[key]) is type(item) and value[key] == item for key, item in expected.items()), REFUSED)
    return value


def container_name(initial, probe, *, aborting=False):
    suffix = migrate.file_hash((initial['reviewedPlanSha256'] + probe['marker']).encode())[:32]
    return ('lash-p2-frontend-replacement-abort-' if aborting else 'lash-p2-frontend-replacement-arm-') + suffix


def remove_container(name, plan_sha):
    query = ['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$']
    owned = [*query, '--filter', 'label=io.lash-her.replacement-arm=' + plan_sha]
    format_ids = ['--format', '{{.ID}}']
    found = runtime.command([*owned, *format_ids], runtime.SAFE_ENV, 10).splitlines()
    require(len(found) <= 1 and all(match(identity, r'[a-f0-9]{12,64}') for identity in found), REFUSED)
    for identity in found:
        runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 10)
    require(not runtime.command([*query, *format_ids], runtime.SAFE_ENV, 10), REFUSED)
    return bool(found)


def run_replacement_image(initial, image, probe, *, abort_observation=None):
    aborting = abort_observation is not None
    name = container_name(initial, probe, aborting=aborting)
    plan_sha = initial['reviewedPlanSha256']
    entry = '--abort-replacement' if aborting else '--observe-replacement-lock'
    payload = {'probe': probe, 'physicalObservation': base64.b64encode(abort_observation).decode()} if aborting else probe
    args = ['docker', 'run', '--rm', '--pull=never', '--name', name,
            '--label', 'io.lash-her.replacement-arm=' + plan_sha, '--interactive', '--network', 'host',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64', '--env', CREDENTIAL, '--entrypoint', 'node',
            image, 'ops/platform/frontend-image.mjs', entry]
    env = {**runtime.SAFE_ENV, CREDENTIAL: initial['credentials'][CREDENTIAL]}
    if aborting:
        return run_bounded_abort(args, encoded(payload), env)
    try:
        result = subprocess.run(args, input=encoded(payload), capture_output=True, env=env, timeout=25, check=True)
    finally:
        remove_container(name, plan_sha)
    return result.stdout


def run_bounded_abort(args, packet, env):
    require(0 < len(packet) <= MAXIMUM, REFUSED)
    deadline = time.monotonic() + 25
    output = bytearray()
    pending = memoryview(packet)
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env) as child:
        try:
            with selectors.DefaultSelector() as channels:
                os.set_blocking(child.stdin.fileno(), False)
                channels.register(child.stdin, selectors.EVENT_WRITE)
                channels.register(child.stdout, selectors.EVENT_READ)
                while channels.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, REFUSED)
                    for key, _ in channels.select(remaining):
                        if key.fileobj is child.stdin:
                            pending = pending[os.write(key.fd, pending):]
                            if not pending:
                                channels.unregister(child.stdin)
                                child.stdin.close()
                        else:
                            chunk = os.read(key.fd, ABORT_MAXIMUM + 1 - len(output))
                            output.extend(chunk)
                            require(len(output) <= ABORT_MAXIMUM, REFUSED)
                            if not chunk:
                                channels.unregister(child.stdout)
            require(child.wait(timeout=max(0, deadline - time.monotonic())) == 0, REFUSED)
        finally:
            if child.poll() is None:
                child.kill()
    return bytes(output)


def observe(initial, image, probe):
    raw = run_replacement_image(initial, image, probe)
    require(0 < len(raw) <= 8192 and raw.endswith(b'\n'), REFUSED)
    observation(probe, raw)
    return raw


def receipt_base(initial, plan, status):
    return {key: plan[key] for key in ('version', 'qualificationTargetProfile', 'environment', 'releaseId',
                                      'sourceCommit', 'candidateSha256', 'targetSha256')} | {
        'status': status, 'reviewedPlanSha256': initial['reviewedPlanSha256'], **NO_AUTHORITY}


def arm_receipt(initial, plan, raw):
    return receipt_base(initial, plan, 'P2_FRONTEND_REPLACEMENT_ARMED') | {
        'physicalObservation': base64.b64encode(raw).decode(), 'physicalObservationSha256': migrate.file_hash(raw)}


def ready_receipt(raw):
    return {'version': 1, 'status': 'P2_FRONTEND_REPLACEMENT_GUARD_READY', 'armReceiptSha256': migrate.file_hash(raw)}


def private_record(directory, name, maximum=65_536):
    info = (directory / name).lstat()
    if stat.S_ISREG(info.st_mode) and info.st_nlink == 2:
        # Atomic hard-link publication completes only after temporary removal.
        raise FileNotFoundError('P2_FRONTEND_REPLACEMENT_RECEIPT_PUBLICATION_PENDING')
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
            stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, REFUSED)
    return migrate.read_input(directory, name, maximum)


def require_arm(initial, plan, probe, directory):
    ready = decode_qualification_target_json(private_record(directory, READY), 'carrier')
    raw = private_record(directory, ARM)
    value = decode_qualification_target_json(raw, 'carrier')
    physical = unbase64(value['physicalObservation'], 8192)
    observation(probe, physical)
    require(migrate.file_hash(private_record(directory, 'reviewed-plan.json', 2_000_000)) == initial['reviewedPlanSha256']
            and encoded(ready) == encoded(ready_receipt(raw))
            and encoded(value) == encoded(arm_receipt(initial, plan, physical)), REFUSED)
    return value, migrate.file_hash(raw)


def terminal_receipt(initial, plan, armed, digest_value):
    return receipt_base(initial, plan, LAYOUT['terminalStatus']) | {
        'armReceiptSha256': digest_value, 'physicalObservationSha256': armed['physicalObservationSha256'],
        'backendClosureVerified': False}


def verify_and_retain(initial, plan, base_probe, image, directory, source, probe, cancelled):
    supervisor.verify_guard_boundary(initial, source)
    probe_identity(probe, base_probe)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    raw = observe(initial, image, probe)
    supervisor.verify_guard_boundary(initial, source)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    require(not cancelled.is_set(), REFUSED)
    migrate.write_json(directory, ARM, arm_receipt(initial, plan, raw))
    migrate.write_json(directory, READY, ready_receipt(private_record(directory, ARM)))


def empty_catalog_receipt(plan, probe, boundary):
    selected = plan['replacement']
    admins = sorted(selected['administrativeLogins'], key=lambda item: item['name'])
    expected = {'version': 1, 'status': 'FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED',
                'target': selected['target'], 'predecessorTarget': probe['predecessorTarget'],
                'databaseOid': probe['databaseOid'], 'migrationRoleOid': probe['migrationRoleOid'],
                'administrativeLogins': admins, 'catalogScope': 'postgresql-16-18-stock-replacement-v1',
                'zeroCatalogCounts': dict.fromkeys(EMPTY_CATALOG_COUNTERS, 0), 'readOnlyVerified': True,
                'completeDatabaseEmptyProven': False, 'authorityIssued': False}
    require(type(boundary) is dict and set(boundary) == set(expected) | {'observedAt'} and
            match(boundary['observedAt'], r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z') and
            all(canonical(boundary[key]) == canonical(value) for key, value in expected.items()), REFUSED)
    return encoded(boundary) + b'\n'


def write_custody(initial, plan, armed, arm_sha, boundary_raw):
    # The submitted catalog receipt binds the request, but cannot authorize SQL.
    # A source-owned continuation must independently verify the original session.
    return receipt_base(initial, plan, 'P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED') | {
        'armReceiptSha256': arm_sha, 'emptyCatalogReceiptSha256': migrate.file_hash(boundary_raw),
        'physicalObservationSha256': armed['physicalObservationSha256'], 'automaticReplayAuthorized': False}


def write_ready_receipt(raw):
    return {'version': 1, 'status': 'P2_FRONTEND_REPLACEMENT_WRITE_READY', 'writeIntentSha256': migrate.file_hash(raw)}


def write_observer_receipt(initial, probe, physical, status):
    return {'version': 1, 'status': 'P2_FRONTEND_REPLACEMENT_WRITE_OBSERVER_' + status,
            'reviewedPlanSha256': initial['reviewedPlanSha256'], 'targetSha256': probe['targetSha256'],
            'physicalObservationSha256': migrate.file_hash(physical)}


def require_write_observer_returned(initial, probe, physical, directory):
    for filename, status in ((WRITE_OBSERVER_STARTED, 'STARTED'), (WRITE_OBSERVER_RETURNED, 'RETURNED')):
        actual = decode_qualification_target_json(private_record(directory, filename), 'carrier')
        require(canonical(actual) == canonical(write_observer_receipt(initial, probe, physical, status)), REFUSED)


def require_write_custody(initial, plan, probe, directory, arm_sha, boundary):
    ready = decode_qualification_target_json(private_record(directory, WRITE_READY), 'carrier')
    intent = private_record(directory, WRITE_INTENT)
    receipt = decode_qualification_target_json(intent, 'carrier')
    armed, actual_arm = require_arm(initial, plan, probe, directory)
    physical = unbase64(armed['physicalObservation'], 8192)
    require_write_observer_returned(initial, probe, physical, directory)
    boundary_raw = empty_catalog_receipt(plan, probe, boundary)
    require(arm_sha == actual_arm and private_record(directory, WRITE_BOUNDARY) == boundary_raw and
            canonical(ready) == canonical(write_ready_receipt(intent)) and
            canonical(receipt) == canonical(write_custody(initial, plan, armed, arm_sha, boundary_raw)), REFUSED)
    return receipt, migrate.file_hash(intent), physical


def verify_and_retain_write_custody(initial, plan, base_probe, image, directory, source, probe, request, cancelled):
    require(initial['mode'] == WRITE_MODE, REFUSED)
    supervisor.verify_guard_boundary(initial, source)
    probe_identity(probe, base_probe)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    armed, arm_sha = require_arm(initial, plan, probe, directory)
    require(request['armReceiptSha256'] == arm_sha, REFUSED)
    boundary_raw = empty_catalog_receipt(plan, probe, request['emptyCatalogReceipt'])
    physical = unbase64(armed['physicalObservation'], 8192)
    require(not cancelled.is_set(), REFUSED)
    migrate.write_json(directory, WRITE_OBSERVER_STARTED, write_observer_receipt(initial, probe, physical, 'STARTED'))
    raw = observe(initial, image, probe)
    # The fixed observer only returns after Docker's launcher and its named
    # container reconcile. A guard SIGKILL may leave only the STARTED record.
    migrate.write_json(directory, WRITE_OBSERVER_RETURNED, write_observer_receipt(initial, probe, physical, 'RETURNED'))
    require(raw == physical, REFUSED)
    supervisor.verify_guard_boundary(initial, source)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    require(not cancelled.is_set() and require_arm(initial, plan, probe, directory) == (armed, arm_sha), REFUSED)
    migrate.write_exact_bytes(directory, WRITE_BOUNDARY, boundary_raw)
    migrate.write_json(directory, WRITE_INTENT, write_custody(initial, plan, armed, arm_sha, boundary_raw))
    migrate.write_json(directory, WRITE_READY, write_ready_receipt(private_record(directory, WRITE_INTENT)))
    return raw


def abort_result(plan, probe, physical, raw):
    require(0 < len(raw) <= ABORT_MAXIMUM and raw.endswith(b'\n'), REFUSED)
    value = decode_qualification_target_json(raw, 'carrier')
    expected = {**observation(probe, physical), 'operation': 'observe-after-replacement-abort',
                'status': 'P2_FRONTEND_REPLACEMENT_ABORT_OBSERVED',
                'physicalObservationSha256': migrate.file_hash(physical), 'originalBackendAbsent': True,
                'originalLocksAbsent': True, 'observationLockReleased': True, 'replayAuthorized': False}
    require(type(value) is dict and set(value) == set(expected) |
            {'observedAt', 'backendTerminated', 'journalPresent', 'appliedPrefix', 'appliedPrefixSha256'} and
            all(canonical(value[key]) == canonical(item) for key, item in expected.items()) and
            match(value['observedAt'], r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z') and
            type(value['backendTerminated']) is bool and type(value['journalPresent']) is bool and
            type(value['appliedPrefix']) is list, REFUSED)
    prefix = value['appliedPrefix']
    tags = plan['replacement']['approvedPendingTags']
    require(len(prefix) <= len(tags) and (value['journalPresent'] or not prefix), REFUSED)
    previous = 0
    for row, tag in zip(prefix, tags):
        require(type(row) is dict and set(row) == {'tag', 'hash', 'folderMillis'} and row['tag'] == tag and
                digest(row['hash']) and type(row['folderMillis']) is int and
                previous < row['folderMillis'] <= (1 << 53) - 1, REFUSED)
        previous = row['folderMillis']
    require(value['appliedPrefixSha256'] == migrate.file_hash(encoded(prefix)), REFUSED)
    return value


def contain_replacement_write(initial, plan, image, directory, probe, physical, *, process_reconciled=True):
    receipt = {**receipt_base(initial, plan, 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN'),
               'physicalObservationSha256': migrate.file_hash(physical), 'automaticReplayAuthorized': False,
               'abortObservationSha256': None, 'appliedPrefixCount': None, 'backendClosureVerified': False,
               'processScopeReconciled': process_reconciled, 'observerContainerAbsent': False,
               'abortContainerAbsent': False, 'observerLauncherReconciled': False}
    def has_record(name):
        return os.path.lexists(directory / name)

    def cleanup(aborting):
        name = container_name(initial, probe, aborting=aborting)
        found = remove_container(name, initial['reviewedPlanSha256'])
        receipt['abortContainerAbsent' if aborting else 'observerContainerAbsent'] = True
        return found

    try:
        # Trust the armed tuple and immutable image already captured under this
        # flock. Later checkout or bundle drift cannot suppress containment.
        supervisor.verify_guard_lock(initial)
        require(process_reconciled, REFUSED)
        observer_reconciled = not (has_record(WRITE_OBSERVER_STARTED) or has_record(WRITE_OBSERVER_RETURNED))
        if not observer_reconciled:
            try:
                require_write_observer_returned(initial, probe, physical, directory)
                observer_reconciled = True
            except (OSError, ValueError):
                pass
        receipt['observerLauncherReconciled'] = observer_reconciled
        receipt['processScopeReconciled'] = observer_reconciled
        if has_record(WRITE_CONTAINMENT):
            # A surviving broker may already have completed the single pass.
            retained = decode_qualification_target_json(private_record(directory, WRITE_CONTAINMENT), 'carrier')
            require(retained.get('status') == 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW', REFUSED)
            raw = private_record(directory, ABORT_OBSERVATION)
            observed = abort_result(plan, probe, physical, raw)
            require(canonical(retained) == canonical({
                **receipt, 'status': 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW',
                'abortObservationSha256': migrate.file_hash(raw), 'appliedPrefixCount': len(observed['appliedPrefix']),
                'backendClosureVerified': True, 'observerContainerAbsent': True, 'abortContainerAbsent': True}), REFUSED)
            supervisor.verify_guard_lock(initial)
            return

        # An observer cleanup failure does not suppress scoped backend
        # containment. It still prevents a fully reconciled containment receipt.
        try:
            cleanup(False)
            receipt['observerContainerAbsent'] = observer_reconciled
        except Exception:
            pass
        attempt = {**receipt_base(initial, plan, 'P2_FRONTEND_REPLACEMENT_ABORT_ATTEMPT'),
                   'physicalObservationSha256': receipt['physicalObservationSha256'], 'automaticReplayAuthorized': False}
        prior_attempt = has_record(ABORT_ATTEMPT)
        if not prior_attempt:
            migrate.write_json(directory, ABORT_ATTEMPT, attempt)
        try:
            require(canonical(decode_qualification_target_json(private_record(directory, ABORT_ATTEMPT), 'carrier'))
                    == canonical(attempt), REFUSED)
            if prior_attempt:
                # A previous guardian may have died during the packaged abort.
                # Reconcile its exact container, never invoke the abort again.
                cleanup(True)
                raw = private_record(directory, ABORT_OBSERVATION)
            else:
                require(not cleanup(True), REFUSED)
                receipt['abortContainerAbsent'] = False
                raw = run_replacement_image(initial, image, probe, abort_observation=physical)
                abort_result(plan, probe, physical, raw)
                migrate.write_exact_bytes(directory, ABORT_OBSERVATION, raw)
            observed = abort_result(plan, probe, physical, raw)
            receipt.update(abortObservationSha256=migrate.file_hash(raw), appliedPrefixCount=len(observed['appliedPrefix']),
                           backendClosureVerified=True)
        finally:
            if not receipt['abortContainerAbsent']:
                cleanup(True)
        supervisor.verify_guard_lock(initial)
        require(receipt['observerContainerAbsent'] and receipt['abortContainerAbsent'], REFUSED)
        receipt['status'] = 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW'
    finally:
        if not has_record(WRITE_CONTAINMENT):
            migrate.write_json(directory, WRITE_CONTAINMENT, receipt)


class ReplacementArmBroker(Broker):
    """Only check, arm and receipt commit. No inherited mutation dispatch."""

    def failure_profile(self):
        return PROFILE

    def initialize_arm(self, source, plan, base_probe, directory):
        self.source, self.plan, self.base_probe, self.directory = source, plan, base_probe, directory
        self.probe = None
        self.lock_fd = self.shared_lock_fd
        self.lock_info = os.fstat(self.lock_fd)
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, REFUSED)
        self.check()
        self.start_parent_watch()

    def abort(self):
        if self.failed.is_set():
            return
        self.failed.set()
        if self.guard_alive:
            try:
                self.safety({'operation': 'abort'})
            except (OSError, ValueError):
                self.guard_alive = False

    def contain_failure_without_guard(self):
        raise AssertionError('REPLACEMENT_ARM_HAS_NO_MUTATION_CONTAINMENT')

    def command(self, value):
        require(type(value) is dict and type(value.get('id')) is int and 0 < value['id'] <= (1 << 53) - 1
                and type(value.get('operation')) is str, REFUSED)
        operation = value['operation']
        fields = {'id', 'operation', 'probe'} if operation == 'arm-replacement' else {'id', 'operation'}
        require(set(value) == fields and not self.committed.is_set(), REFUSED)
        self.last_command = time.monotonic()
        self.check()
        if operation == 'check':
            self.send(value['id'], 'LOCKED')
            return
        if operation == 'arm-replacement':
            require(self.probe is None, REFUSED)
            probe_identity(value['probe'], self.base_probe)
            self.probe = value['probe']
            self.safety({'operation': 'armed', 'probe': self.probe})
            deadline = time.monotonic() + 60
            while True:
                require(not self.failed.is_set() and self.guard_alive and time.monotonic() < deadline, REFUSED)
                try:
                    receipt, arm_sha = require_arm(self.initial, self.plan, self.probe, self.directory)
                    break
                except FileNotFoundError:
                    time.sleep(0.05)
            self.check()
            self.send(value['id'], 'REPLACEMENT_ARMED', receipt=receipt, armReceiptSha256=arm_sha)
            return
        require(operation == 'commit' and self.probe is not None, REFUSED)
        armed, arm_sha = require_arm(self.initial, self.plan, self.probe, self.directory)
        receipt = terminal_receipt(self.initial, self.plan, armed, arm_sha)
        migrate.write_json(self.directory, COMMIT_INTENT, {**receipt, 'status': INTENT_STATUS})
        raw = private_record(self.directory, COMMIT_INTENT)
        self.safety({'operation': 'committed', 'sha256': migrate.file_hash(raw)})
        self.committed.set()
        self.send(value['id'], 'COMMITTED', receipt=receipt)


class ReplacementWriteBroker(ReplacementArmBroker):
    """Write frontier only, pending a separately verified release continuation."""

    def __init__(self, *args, image, **kwargs):
        super().__init__(*args, **kwargs)
        self.image = image
        self.write_mutex = threading.Lock()
        self.write_observation = None
        self.fallback_started = False

    def command(self, value):
        operation = value.get('operation') if type(value) is dict else None
        if operation in ('check', 'arm-replacement'):
            return super().command(value)
        require(operation == 'authorize-replacement-write' and set(value) == {
            'id', 'operation', 'armReceiptSha256', 'emptyCatalogReceipt'} and
            type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1 and
            self.probe is not None and self.write_observation is None, REFUSED)
        self.last_command = time.monotonic()
        self.check()
        armed, arm_sha = require_arm(self.initial, self.plan, self.probe, self.directory)
        require(value['armReceiptSha256'] == arm_sha, REFUSED)
        empty_catalog_receipt(self.plan, self.probe, value['emptyCatalogReceipt'])
        with self.write_mutex:
            self.check()
            self.write_observation = unbase64(armed['physicalObservation'], 8192)
        self.safety({'operation': 'replacement-write', 'armReceiptSha256': arm_sha,
                     'emptyCatalogReceipt': value['emptyCatalogReceipt']})
        deadline = time.monotonic() + 60
        while True:
            require(not self.failed.is_set() and self.guard_alive and time.monotonic() < deadline, REFUSED)
            try:
                receipt, intent_sha, physical = require_write_custody(
                    self.initial, self.plan, self.probe, self.directory, arm_sha, value['emptyCatalogReceipt'])
                break
            except FileNotFoundError:
                time.sleep(0.05)
        with self.write_mutex:
            self.check()
            require(physical == self.write_observation, REFUSED)
            self.send(value['id'], 'REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED', receipt=receipt, writeIntentSha256=intent_sha)

    def abort(self):
        # Keep the inherited flock held until a surviving broker's cleanup
        # finishes. The main reader also calls abort before exiting.
        with self.write_mutex:
            super().abort()
            if (not self.guard_alive and os.getppid() != self.initial['_guardPid']
                    and self.write_observation is not None and not self.fallback_started):
                self.fallback_started = True
                try:
                    contain_replacement_write(self.initial, self.plan, self.image, self.directory, self.probe,
                                              self.write_observation)
                except Exception:
                    # The containment helper retains uncertainty on failure.
                    # The surviving process still exits without an authority receipt.
                    pass

    def finish_failed_reader(self):
        self.abort()
        if self.write_observation is not None:
            # A successful pipe write delegates cleanup but does not prove the
            # guard survived to perform it. Hold the inherited flock until the
            # guard reaps us or its health channel closes and we take custody.
            while self.guard_alive:
                time.sleep(0.05)
            # Linux closes the dying guard's descriptors before it reparents
            # this process. Keep the flock through that bounded transition.
            deadline = time.monotonic() + 3
            while os.getppid() == self.initial['_guardPid'] and time.monotonic() < deadline:
                time.sleep(0.05)
            self.abort()

    def read_frames(self):
        fd = sys.stdin.buffer.fileno()
        buffer = bytearray()
        while not self.failed.is_set():
            readable, _, _ = select.select([fd], [], [], 0.1)
            if not readable:
                continue
            chunk = os.read(fd, 65_536)
            if not chunk:
                require(not buffer, REFUSED)
                return
            buffer.extend(chunk)
            while (index := buffer.find(b'\n')) >= 0 and not self.failed.is_set():
                require(index < MAXIMUM, REFUSED)
                yield bytes(buffer[:index + 1])
                del buffer[:index + 1]
            require(len(buffer) < MAXIMUM, REFUSED)


def broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read, image=None):
    writing = initial['mode'] == WRITE_MODE
    broker_type = ReplacementWriteBroker if writing else ReplacementArmBroker
    output_fd = sys.stdout.fileno() if writing else None
    if writing:
        os.set_blocking(output_fd, False)

    def emit(value):
        if not writing:
            print(encoded(value).decode(), flush=True)
            return
        raw = encoded(value) + b'\n'
        require(len(raw) <= min(4096, os.fpathconf(output_fd, 'PC_PIPE_BUF')), REFUSED)
        require(select.select([], [output_fd], [], 2)[1], REFUSED)
        require(os.write(output_fd, raw) == len(raw), REFUSED)

    broker = broker_type(initial, emit,
                         shared_lock_fd=fd, safety_write=safety_write, guard_read=health_read,
                         **({'image': image} if writing else {}))
    try:
        broker.initialize_arm(source, plan, base_probe, directory)
        broker.send(0, 'LOCKED')
        frames = broker.read_frames() if writing else iter(lambda: sys.stdin.buffer.readline(MAXIMUM + 1), b'')
        for raw in frames:
            require(len(raw) <= MAXIMUM and raw.endswith(b'\n'), REFUSED)
            value = decode_qualification_target_json(raw, 'private-packet')
            if type(value) is dict and value.get('operation') == 'check':
                broker.command(value)
                continue
            require(broker.operation_active.acquire(timeout=2), REFUSED)
            def operation(frame=value):
                try:
                    broker.command(frame)
                except BaseException:
                    broker.abort()
                    broker.send(frame.get('id') if type(frame) is dict else None, 'P2_HOST_STAGE_FAILED')
                finally:
                    broker.operation_active.release()
            threading.Thread(target=operation, daemon=True).start()
        require(broker.committed.is_set(), REFUSED)
        return 0
    except BaseException:
        if writing:
            broker.finish_failed_reader()
        else:
            broker.abort()
        return 1


def supervise_replacement_arm(initial, source):
    return _supervise_replacement(initial, source, writing=False)


def qualify_replacement_write_frontier(initial, source):
    # Source-only. The installed entry below will remain read-only until the
    # same guarded action supports the full compatible release continuation.
    return _supervise_replacement(initial, source, writing=True)


def _supervise_replacement(initial, source, *, writing):
    require(sys.platform == 'linux' and os.geteuid() == 0, REFUSED)
    require(initial.get('mode') == (WRITE_MODE if writing else MODE), REFUSED)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, REFUSED)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw, plan, base_probe, image, directory = prepare(initial, source, mode=WRITE_MODE if writing else MODE)
        layout = supervisor.PROFILED_REPLACEMENT_WRITE_LAYOUT if writing else LAYOUT
        initial = {**initial, '_guardLayout': layout, '_guardLockDescriptor': fd, '_guardPid': os.getpid()}
        supervisor.verify_guard_boundary(initial, source)
        directory.mkdir(mode=0o700)
        results_fd = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(results_fd)
        finally:
            os.close(results_fd)
        migrate.write_exact_bytes(directory, 'reviewed-plan.json', raw)
        safety_read, safety_write = os.pipe()
        health_read, health_write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(safety_read)
            os.close(health_write)
            os.setsid()
            os._exit(broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read, image))
        os.close(safety_write)
        os.close(health_read)
        cancelled = threading.Event()
        armed_probe = None
        write_physical = None
        try:
            with ThreadPoolExecutor(max_workers=1) as worker:
                def arm(probe):
                    nonlocal armed_probe
                    probe_identity(probe, base_probe)
                    armed_probe = probe
                    return worker.submit(verify_and_retain, initial, plan, base_probe, image, directory, source, probe, cancelled)
                def authorize_write(request):
                    nonlocal write_physical
                    require(armed_probe is not None and write_physical is None, REFUSED)
                    armed, _ = require_arm(initial, plan, armed_probe, directory)
                    write_physical = unbase64(armed['physicalObservation'], 8192)
                    return worker.submit(verify_and_retain_write_custody, initial, plan, base_probe, image,
                                         directory, source, armed_probe, request, cancelled)
                try:
                    committed = supervisor.watch_broker(child, safety_read, health_write, arm,
                                                        profiled_certification=True, async_arm=True,
                                                        authorize_replacement_write=authorize_write if writing else None)
                except BaseException:
                    cancelled.set()
                    raise
            require(not writing, REFUSED)
            supervisor.verify_guard_boundary(initial, source)
            verify_bundle(Path(initial['bundle']), plan, base_probe)
            armed, arm_sha = require_arm(initial, plan, armed_probe, directory)
            intent = private_record(directory, COMMIT_INTENT)
            expected = terminal_receipt(initial, plan, armed, arm_sha)
            require(migrate.file_hash(intent) == committed and encoded(decode_qualification_target_json(intent, 'carrier'))
                    == encoded({**expected, 'status': INTENT_STATUS}), REFUSED)
            migrate.write_json(directory, TERMINAL, expected)
        except BaseException:
            with supervisor.sticky_cleanup_signals():
                reaped = False
                try:
                    reaped = supervisor._stop_profiled_certification_group(child)
                    require(reaped, REFUSED)
                finally:
                    if write_physical is not None:
                        contain_replacement_write(initial, plan, image, directory, armed_probe, write_physical,
                                                  process_reconciled=reaped)
                    elif reaped and armed_probe is not None:
                        remove_container(container_name(initial, armed_probe), initial['reviewedPlanSha256'])
            raise
        finally:
            os.close(safety_read)
            os.close(health_write)
    finally:
        os.close(fd)


def main():
    require(sys.argv[1:] == ['--supervise-pre-bootstrap'] and sys.platform == 'linux' and os.geteuid() == 0, REFUSED)
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), REFUSED)
    supervise_replacement_arm(decode_qualification_target_json(raw, 'private-packet'), Path(__file__).resolve().parents[3])


if __name__ == '__main__':
    def interrupt(signum, _frame):
        raise SystemExit(128 + signum)

    for event in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(event, interrupt)
    try:
        main()
    except BaseException:
        print(REFUSED, file=sys.stderr)
        raise SystemExit(1)
