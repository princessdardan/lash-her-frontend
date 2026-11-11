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

if __name__ == '__main__':
    previous = sys.modules.get('p2_frontend_replacement_parent')
    if previous is not None and previous is not sys.modules[__name__]:
        raise SystemExit('P2_FRONTEND_REPLACEMENT_MODULE_IDENTITY_REFUSED')
    sys.modules['p2_frontend_replacement_parent'] = sys.modules[__name__]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import p2_release_supervisor as supervisor
import release as runtime
import staging_state
from p2_release_broker import Broker, LOCK, MAXIMUM, PhysicalObserver
from p2_source_closure import (PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE,
                               read_managed_replacement_catalog, verify_profiled_current_source_closure)
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json

require = migrate.demand
PROFILE = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
MODE = PROFILED_REPLACEMENT_ARM_MODE
WRITE_MODE = PROFILED_REPLACEMENT_WRITE_MODE
LAYOUT = supervisor.PROFILED_REPLACEMENT_ARM_LAYOUT
CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
CRON_CREDENTIAL = 'FRONTEND_STAGING_CRON_SECRET'
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
WRITTEN_OBSERVER_STARTED = 'p2-frontend-replacement-written-observer-started.json'
WRITTEN_OBSERVER_RETURNED = 'p2-frontend-replacement-written-observer-returned.json'
WRITTEN_OBSERVATION = 'p2-frontend-replacement-written-observation.json'
RUNTIME_REVIEW = 'p2-frontend-replacement-runtime-review.json'
RUNTIME_INTENT = 'p2-frontend-replacement-runtime-intent.json'
CLOSE_PREPARED = 'p2-frontend-replacement-close-prepared.json'
CLOSED_OBSERVER_STARTED = 'p2-frontend-replacement-closed-observer-started.json'
CLOSED_OBSERVER_RETURNED = 'p2-frontend-replacement-closed-observer-returned.json'
CLOSE_SECONDS = 120
RUNTIME_REVIEW_FIELDS = frozenset(('runtimeReviewBytes', 'runtimeReviewSha256'))
RECOVERY_FIELDS = frozenset(('operatorSourceCommit', 'recoveryReviewBytes', 'recoveryReviewSha256'))
RECOVERY_PHYSICAL = 'p2-frontend-replacement-recovery-physical-observation.json'
RECOVERY_CLOSED = 'p2-frontend-replacement-recovery-close-observation.json'
RECOVERY_REVIEW = 'p2-frontend-replacement-recovery-review.json'
RECOVERY_OPERATOR = 'p2-frontend-replacement-recovery-operator.json'
PRIOR_RECOVERY_EVIDENCE = frozenset(('physicalObservation', 'runtimeOutcome', 'migrationOutcome', 'courseJobOutcome',
                                    'runtimeContainment', 'gatewayStopped'))
API_CREDENTIALS = ('COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL')
WRITE_CONTAINMENT = 'p2-frontend-replacement-write-containment.json'
ABORT_ATTEMPT = 'p2-frontend-replacement-abort-attempt.json'
ABORT_OBSERVATION = 'p2-frontend-replacement-abort-observation.json'
ABORT_MAXIMUM = 65_536
NO_AUTHORITY = {'bootstrapAuthorized': False, 'migrationAuthorized': False,
                'deploymentAuthorized': False, 'trafficAuthorized': False}
WRITTEN_REQUEST_FIELDS = frozenset(('writeIntentSha256', 'databaseReceipt', 'continuationStarted',
                                    'owner', 'runtime', 'producerSha256'))
TARGET_FIELDS = ('host', 'port', 'database', 'user', 'runtimeRole', 'serverMajor')
REPLACEMENT_FIELDS = {'provider', 'databaseOid', 'migrationRoleOid', 'administrativeLogins', 'recoveryRef',
                      'target', 'approvedPendingTags'}
MANAGED_CATALOG_ID = 'staging-neon-replacement-2026-11-09'
MANAGED_CATALOG_SCOPE = 'postgresql-18-managed-neon-replacement-v1'
MANAGED_CATALOG_COUNTS = {'pg_default_acl': 2, 'normal_object_dependencies': 2, 'local_shared_dependencies': 2}
MANAGED_CATALOG_FIELDS = {'version', 'id', 'provider', 'target', 'databaseOid', 'migrationRoleOid',
                          'administrativeLogins', 'roles', 'memberships', 'defaultAcl', 'dependencies',
                          'sharedDependencies', 'databaseAclBefore', 'databaseAclAfter', 'expectedNonzeroCatalogCounts'}
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
pg_opfamily pg_proc pg_rewrite pg_statistic_ext pg_trigger pg_ts_config pg_ts_dict pg_ts_parser pg_ts_template pg_type
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


def recovery_review(initial, release_id):
    raw = unbase64(initial['recoveryReviewBytes'], 65_536)
    require(digest(initial['recoveryReviewSha256']) and migrate.file_hash(raw) == initial['recoveryReviewSha256']
            and migrate.source_commit(initial['operatorSourceCommit']), REFUSED)
    review = decode_qualification_target_json(raw, 'carrier')
    base_fields = {'actionId', 'originalDirectory', 'originalEvidenceSha256'}
    retry_fields = {'priorRecovery', 'rolePolicySupplement'}
    require(type(review) is dict and set(review) in (base_fields, base_fields | retry_fields)
            and match(review['actionId'], r'[a-z0-9][a-z0-9-]{0,63}') and review['actionId'] != release_id, REFUSED)
    pins = review['originalEvidenceSha256']
    require(type(pins) is dict and set(pins) == {'physicalObservation', 'databaseReceipt', 'continuationStarted',
            'writtenObservation', 'abortObservation', 'runtimeOutcome', 'writeContainment', 'runtimeContainment'}
            and all(digest(pin) for pin in pins.values()), REFUSED)
    original = exact_host_directory(review['originalDirectory'])
    require(original.name == supervisor.PROFILED_REPLACEMENT_WRITE_LAYOUT['receiptPrefix'] + release_id and
            initial['results'] == str(original.parent / review['actionId']), REFUSED)
    if 'priorRecovery' in review:
        previous = review['priorRecovery']
        require(type(previous) is dict and set(previous) == {'actionId', 'evidenceSha256'}
                and match(previous['actionId'], r'[a-z0-9][a-z0-9-]{0,63}')
                and previous['actionId'] not in (review['actionId'], release_id)
                and type(previous['evidenceSha256']) is dict and set(previous['evidenceSha256']) == PRIOR_RECOVERY_EVIDENCE
                and all(digest(pin) for pin in previous['evidenceSha256'].values()), REFUSED)
        supplements = review['rolePolicySupplement']
        require(type(supplements) is dict and set(supplements) == set(migrate.SERVICES)
                and all(type(pins) is dict and set(pins) == {'baseSourceCommit', 'sourceCommit', 'sourceSha256', 'compiledSha256'}
                        and migrate.source_commit(pins['baseSourceCommit']) and migrate.source_commit(pins['sourceCommit'])
                        and pins['baseSourceCommit'] != pins['sourceCommit']
                        and digest(pins['sourceSha256']) and digest(pins['compiledSha256'])
                        for pins in supplements.values()), REFUSED)
    return review


def reviewed_plan(initial, *, mode=MODE):
    require(mode in (MODE, WRITE_MODE), REFUSED)
    require(type(initial) is dict, REFUSED)
    has_runtime = mode == WRITE_MODE and bool(RUNTIME_REVIEW_FIELDS & set(initial))
    provider_fields = {'vercelToken'} if has_runtime and 'vercelToken' in initial else set()
    recovering = bool(RECOVERY_FIELDS & set(initial))
    require((not recovering or has_runtime and provider_fields and digest(initial.get('recoveryReviewSha256'))) and
            set(initial) == INITIAL_FIELDS | (RUNTIME_REVIEW_FIELDS if has_runtime else set()) | provider_fields |
            (RECOVERY_FIELDS if recovering else set()) and
            type(initial['version']) is int and initial['version'] == 1 and initial['mode'] == mode and
            initial['environment'] == 'staging' and migrate.source_commit(initial['sourceCommit']) and
            match(initial['hostMachineId'], r'[a-f0-9]{32}') and
            all(digest(initial[key]) for key in ('sourceClosureSha256', 'candidateSha256', 'reviewedPlanSha256')), REFUSED)
    if has_runtime:
        require(digest(initial['runtimeReviewSha256']), REFUSED)
        runtime_raw = unbase64(initial['runtimeReviewBytes'], 65_536)
        require(migrate.file_hash(runtime_raw) == initial['runtimeReviewSha256'], REFUSED)
        runtime_carrier = decode_qualification_target_json(runtime_raw, 'carrier')
        require(type(runtime_carrier) is dict and
                ('initializeStagingCronSecret' not in runtime_carrier or
                 runtime_carrier['initializeStagingCronSecret'] is True), REFUSED)
        initialize_cron = runtime_carrier.get('initializeStagingCronSecret') is True
    else:
        initialize_cron = False
    if provider_fields:
        require(match(initial['vercelToken'], r'[!-~]{1,8192}'), REFUSED)
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
                ('/replacement-write/' if mode == WRITE_MODE else '/replacement-arm/') + initial['reviewedPlanSha256'] +
                ('/' + initial['runtimeReviewSha256'] if has_runtime else '') +
                ('/recover/' + initial['recoveryReviewSha256'] if recovering else ''),
            REFUSED)
    if recovering:
        recovery_review(initial, plan['releaseId'])
    credentials = initial['credentials']
    expected_credentials = {CREDENTIAL, *API_CREDENTIALS} if has_runtime else {CREDENTIAL}
    credential_fields = set(credentials) if type(credentials) is dict else set()
    if initialize_cron:
        expected_credentials.add(CRON_CREDENTIAL)
    require(type(credentials) is dict and credential_fields == expected_credentials and
            all(type(value) is str and 0 < len(value) <= 16_384 and
                all(ord(character) >= 32 for character in value) for value in credentials.values()) and
            (CRON_CREDENTIAL not in credentials or match(credentials[CRON_CREDENTIAL], r'[!-~]{32,8192}')), REFUSED)
    return raw, plan


def managed_catalog(initial, plan, source=None):
    selected = plan['replacement']
    if 'managedCatalog' not in selected:
        return None
    ref = selected['managedCatalog']
    require(set(selected) == REPLACEMENT_FIELDS | {'managedCatalog'} and type(ref) is dict and set(ref) == {'id', 'sha256'} and
            ref['id'] == MANAGED_CATALOG_ID and digest(ref['sha256']), REFUSED)
    if source is None:
        source = Path(__file__).resolve().parents[3]
    raw = read_managed_replacement_catalog(initial, source, ref['sha256'])
    catalog = decode_qualification_target_json(raw, 'carrier')
    require(type(catalog) is dict and set(catalog) == MANAGED_CATALOG_FIELDS and
            type(catalog['version']) is int and catalog['version'] == 1 and catalog['id'] == ref['id'] and
            canonical(catalog['expectedNonzeroCatalogCounts']) == canonical(MANAGED_CATALOG_COUNTS) and
            all(canonical(catalog[key]) == canonical(selected[key])
                for key in ('provider', 'target', 'databaseOid', 'migrationRoleOid')), REFUSED)
    provider, target, admins = (catalog[key] for key in ('provider', 'target', 'administrativeLogins'))
    require(type(provider) is dict and set(provider) == {'kind', 'projectId', 'branchId', 'endpointId', 'directHost'} and
            provider['kind'] == 'neon' and type(target) is dict and set(target) == set(TARGET_FIELDS) and
            type(target['serverMajor']) is int and target['serverMajor'] == 18 and provider['directHost'] == target['host'] and
            oid(catalog['databaseOid']) and oid(catalog['migrationRoleOid']) and
            type(admins) is list and type(selected['administrativeLogins']) is list and
            all(type(row) is dict and set(row) == {'name', 'oid'} and match(row['name'], r'[a-z][a-z0-9_]{0,62}') and
                oid(row['oid']) for row in (*admins, *selected['administrativeLogins'])) and
            canonical(admins) == canonical(selected['administrativeLogins']), REFUSED)
    return catalog


def prepare(initial, source, *, mode=MODE):
    raw, plan = reviewed_plan(initial, mode=mode)
    require(source == Path('/opt/lash-her/operators') / initial.get('operatorSourceCommit', initial['sourceCommit'])
            and source == source.resolve(), REFUSED)
    runtime.assert_host({'environment': 'staging', 'hostMachineId': initial['hostMachineId']})
    verify_profiled_current_source_closure(initial, source)
    bundle = exact_host_directory(initial['bundle'])
    results = Path(initial['results']) if 'recoveryReviewSha256' in initial else exact_host_directory(initial['results'])
    if 'recoveryReviewSha256' in initial:
        exact_host_directory(str(results.parent))
        require(results == results.resolve() and not os.path.lexists(results), REFUSED)
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
    require(type(replacement) is dict and set(replacement) in (REPLACEMENT_FIELDS, REPLACEMENT_FIELDS | {'managedCatalog'})
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
    managed_catalog(initial, plan, source)
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


def run_replacement_image(initial, image, probe, *, abort_observation=None, written_packet=None, closed_packet=None):
    aborting = abort_observation is not None
    require(sum(value is not None for value in (abort_observation, written_packet, closed_packet)) <= 1, REFUSED)
    name = container_name(initial, probe, aborting=aborting)
    plan_sha = initial['reviewedPlanSha256']
    entry = '--abort-replacement' if aborting else '--observe-replacement-lock'
    payload = {'probe': probe, 'physicalObservation': base64.b64encode(abort_observation).decode()} if aborting else probe
    if written_packet is not None:
        entry, payload = '--observe-replacement-written', written_packet
    if closed_packet is not None:
        entry, payload = '--observe-replacement-closed', closed_packet
    args = ['docker', 'run', '--rm', '--pull=never', '--name', name,
            '--label', 'io.lash-her.replacement-arm=' + plan_sha, '--interactive', '--network', 'host',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64', '--env', CREDENTIAL, '--entrypoint', 'node',
            image, 'ops/platform/frontend-image.mjs', entry]
    env = {**runtime.SAFE_ENV, CREDENTIAL: initial['credentials'][CREDENTIAL]}
    if aborting:
        return run_bounded_image(args, encoded(payload), env)
    try:
        if written_packet is not None or closed_packet is not None:
            return run_bounded_image(args, encoded(payload), env)
        result = subprocess.run(args, input=encoded(payload), capture_output=True, env=env, timeout=25, check=True)
    finally:
        remove_container(name, plan_sha)
    return result.stdout


def run_bounded_image(args, packet, env):
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


def private_record(directory, name, maximum=65_536, *, owner_uid=None):
    info = (directory / name).lstat()
    if stat.S_ISREG(info.st_mode) and info.st_nlink == 2:
        # Atomic hard-link publication completes only after temporary removal.
        raise FileNotFoundError('P2_FRONTEND_REPLACEMENT_RECEIPT_PUBLICATION_PENDING')
    require(stat.S_ISREG(info.st_mode) and info.st_uid == (os.getuid() if owner_uid is None else owner_uid) and
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


def empty_catalog_receipt(initial, plan, probe, boundary, *, source=None):
    selected = plan['replacement']
    catalog = managed_catalog(initial, plan, source)
    admins = sorted(selected['administrativeLogins'], key=lambda item: item['name'])
    expected = {'version': 1, 'status': 'FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED',
                'target': selected['target'], 'predecessorTarget': probe['predecessorTarget'],
                'databaseOid': probe['databaseOid'], 'migrationRoleOid': probe['migrationRoleOid'],
                'administrativeLogins': admins, 'readOnlyVerified': True,
                'completeDatabaseEmptyProven': False, 'authorityIssued': False}
    counts = dict.fromkeys(EMPTY_CATALOG_COUNTERS, 0)
    if catalog is None:
        expected.update(catalogScope='postgresql-16-18-stock-replacement-v1', zeroCatalogCounts=counts)
    else:
        require(all(catalog[key] == probe[key] for key in ('databaseOid', 'migrationRoleOid')) and
                canonical(catalog['target']) == canonical({key: probe['job']['target'][key] for key in TARGET_FIELDS}), REFUSED)
        counts.update(catalog['expectedNonzeroCatalogCounts'])
        expected.update(catalogScope=MANAGED_CATALOG_SCOPE, catalogCounts=counts, managedCatalog=selected['managedCatalog'])
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


def require_write_observer_returned(initial, probe, physical, directory, *, written=False):
    names = ((WRITTEN_OBSERVER_STARTED, 'WRITTEN_STARTED'), (WRITTEN_OBSERVER_RETURNED, 'WRITTEN_RETURNED')) if written else (
        (WRITE_OBSERVER_STARTED, 'STARTED'), (WRITE_OBSERVER_RETURNED, 'RETURNED'))
    require_observer_pair(initial, probe, physical, directory, names)


def require_observer_pair(initial, probe, physical, directory, names):
    for filename, status in names:
        actual = decode_qualification_target_json(private_record(directory, filename), 'carrier')
        require(canonical(actual) == canonical(write_observer_receipt(initial, probe, physical, status)), REFUSED)


def require_write_custody(initial, plan, probe, directory, arm_sha, boundary, *, source=None):
    ready = decode_qualification_target_json(private_record(directory, WRITE_READY), 'carrier')
    intent = private_record(directory, WRITE_INTENT)
    receipt = decode_qualification_target_json(intent, 'carrier')
    armed, actual_arm = require_arm(initial, plan, probe, directory)
    physical = unbase64(armed['physicalObservation'], 8192)
    require_write_observer_returned(initial, probe, physical, directory)
    boundary_raw = empty_catalog_receipt(initial, plan, probe, boundary, source=source)
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
    boundary_raw = empty_catalog_receipt(initial, plan, probe, request['emptyCatalogReceipt'], source=source)
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
    require(not cancelled.is_set() and require_arm(initial, plan, probe, directory) == (armed, arm_sha) and
            empty_catalog_receipt(initial, plan, probe, request['emptyCatalogReceipt'], source=source) == boundary_raw, REFUSED)
    migrate.write_exact_bytes(directory, WRITE_BOUNDARY, boundary_raw)
    migrate.write_json(directory, WRITE_INTENT, write_custody(initial, plan, armed, arm_sha, boundary_raw))
    migrate.write_json(directory, WRITE_READY, write_ready_receipt(private_record(directory, WRITE_INTENT)))
    return raw


def written_packet(plan, probe, physical, request):
    require(digest(request['writeIntentSha256']) and digest(request['producerSha256']), REFUSED)
    for role, name in ((request['owner'], 'lash_her_frontend_staging_admission_owner_p2'),
                       (request['runtime'], probe['job']['target']['runtimeRole'])):
        require(type(role) is dict and set(role) == {'name', 'oid'} and role['name'] == name and oid(role['oid']), REFUSED)
    require(len({request['owner']['oid'], request['runtime']['oid'], probe['migrationRoleOid']}) == 3, REFUSED)
    for name, maximum in (('databaseReceipt', 65_536), ('continuationStarted', 8192)):
        require(unbase64(request[name], maximum).endswith(b'\n'), REFUSED)
    return {key: request[key] for key in WRITTEN_REQUEST_FIELDS - {'writeIntentSha256'}} | {
        'probe': probe, 'physicalObservation': base64.b64encode(physical).decode(),
        'administrativeLogins': sorted(plan['replacement']['administrativeLogins'], key=lambda login: login['name'])}


def written_result(packet, raw):
    from p2_profiled_current_scope import _replacement_producer_bytes
    require(0 < len(raw) <= 8192 and raw.endswith(b'\n'), REFUSED)
    _replacement_producer_bytes(packet['probe'], unbase64(packet['physicalObservation'], 8192),
                                unbase64(packet['databaseReceipt'], 65_536), unbase64(packet['continuationStarted'], 8192),
                                raw, packet['owner'], packet['runtime'], packet['producerSha256'], packet['administrativeLogins'])
    return decode_qualification_target_json(raw, 'carrier')


def verify_and_retain_written(initial, plan, base_probe, image, directory, source, probe, custody, request, cancelled):
    supervisor.verify_guard_boundary(initial, source)
    probe_identity(probe, base_probe)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    def current_custody():
        return require_write_custody(initial, plan, probe, directory,
                                     custody['armReceiptSha256'], custody['emptyCatalogReceipt'], source=source)[1:]
    intent_sha, physical = current_custody()
    require(request['writeIntentSha256'] == intent_sha and not cancelled.is_set(), REFUSED)
    packet = written_packet(plan, probe, physical, request)
    migrate.write_json(directory, WRITTEN_OBSERVER_STARTED, write_observer_receipt(initial, probe, physical, 'WRITTEN_STARTED'))
    raw = run_replacement_image(initial, image, probe, written_packet=packet)
    migrate.write_json(directory, WRITTEN_OBSERVER_RETURNED, write_observer_receipt(initial, probe, physical, 'WRITTEN_RETURNED'))
    written_result(packet, raw)
    supervisor.verify_guard_boundary(initial, source)
    verify_bundle(Path(initial['bundle']), plan, base_probe)
    require(not cancelled.is_set() and current_custody() == (intent_sha, physical), REFUSED)
    migrate.write_exact_bytes(directory, WRITTEN_OBSERVATION, raw)


def runtime_intent_record(initial, plan, review, postflight):
    return {key: plan[key] for key in ('version', 'qualificationTargetProfile', 'environment', 'releaseId',
                                      'sourceCommit', 'candidateSha256', 'targetSha256')} | {
        'status': 'P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED', 'reviewedPlanSha256': initial['reviewedPlanSha256'],
        'runtimeReviewSha256': initial['runtimeReviewSha256'], 'postflightSha256': migrate.file_hash(postflight),
        'apiJobSha256': review['apiJobSha256'], 'configurationSha256': review['configurationSha256'],
        'trafficAuthorized': False}


def retain_runtime_intent(initial, plan, review, source, directory, probe, physical, custody, written_request, request, cancelled):
    from p2_replacement_runtime_review import prepare_runtime_review
    supervisor.verify_guard_boundary(initial, source)
    require(not cancelled.is_set() and prepare_runtime_review(initial, plan, source, probe) == review and
            migrate.file_hash(private_record(directory, RUNTIME_REVIEW)) == initial['runtimeReviewSha256'], REFUSED)
    require(require_write_custody(initial, plan, probe, directory, custody['armReceiptSha256'],
                                  custody['emptyCatalogReceipt'], source=source)[1:] == (written_request['writeIntentSha256'], physical), REFUSED)
    require_write_observer_returned(initial, probe, physical, directory, written=True)
    readback = private_record(directory, WRITTEN_OBSERVATION, 8192)
    written_result(written_packet(plan, probe, physical, written_request), readback)
    require(migrate.file_hash(readback) == request['postflightSha256'] and not cancelled.is_set(), REFUSED)
    migrate.write_json(directory, RUNTIME_INTENT, runtime_intent_record(initial, plan, review, readback))


def close_prepared_record(initial, plan, proof_sha):
    return {**receipt_base(initial, plan, 'P2_FRONTEND_REPLACEMENT_CLOSE_PREPARED'), 'providerProofSha256': proof_sha}


def closed_result(packet, written, raw):
    require(type(raw) is bytes and 0 < len(raw) <= 8192 and raw.endswith(b'\n'), REFUSED)
    value = decode_qualification_target_json(raw, 'carrier')
    expected = {**written_result(packet, written), 'status': 'P2_FRONTEND_REPLACEMENT_SESSION_CLOSED',
                'operation': 'verify-replacement-closed', 'writtenObservationSha256': migrate.file_hash(written),
                'originalBackendAbsent': True, 'originalLocksAbsent': True, 'observationLockReleased': True}
    require(canonical(value) == canonical(expected), REFUSED)
    return value


def retain_closed_observation(initial, plan, review, source, directory, image, probe, physical,
                              custody, written_request, request, cancelled, *, recovery=None, fresh=None):
    import p2_replacement_terminal as terminal
    import vercel

    def verify():
        supervisor.verify_guard_boundary(initial, source)
        require(not cancelled.is_set(), REFUSED)

    verify()
    verify_bundle(Path(initial['bundle']), plan, probe)
    require(require_write_custody(initial, plan, probe, directory, custody['armReceiptSha256'],
                                  custody['emptyCatalogReceipt'], source=source)[1:] == (written_request['writeIntentSha256'], physical), REFUSED)
    written = written_packet(plan, probe, physical, written_request)
    postflight = private_record(directory, WRITTEN_OBSERVATION, 8192)
    require_write_observer_returned(initial, probe, physical, directory, written=True)
    prepared = decode_qualification_target_json(private_record(directory, CLOSE_PREPARED), 'carrier')
    proof = tuple(private_record(directory, name) for name in terminal.PROVIDER_FILES)
    proof_sha = migrate.file_hash(proof[0])
    require(proof_sha == request['providerProofSha256'] and
            canonical(prepared) == canonical(close_prepared_record(initial, plan, proof_sha)), REFUSED)
    api = terminal.read_api(initial, plan, review, probe['candidate'], directory, written, postflight)
    base = terminal.release_base(initial, plan, review, probe['candidate'], postflight, api)
    terminal.verify_provider(proof, base, probe['candidate'], plan, review, written, vercel.Client(initial['vercelToken']), verify)
    terminal.verify_runtime(initial, probe['candidate'], api, verify)
    migrate.write_json(directory, CLOSED_OBSERVER_STARTED, write_observer_receipt(initial, probe, physical, 'CLOSED_STARTED'))
    raw = run_replacement_image(initial, image, probe, closed_packet={**written, 'writtenObservation': base64.b64encode(postflight).decode()})
    migrate.write_json(directory, CLOSED_OBSERVER_RETURNED, write_observer_receipt(initial, probe, physical, 'CLOSED_RETURNED'))
    closed_result(written, postflight, raw)
    if recovery is not None:
        fresh_physical = private_record(directory, RECOVERY_PHYSICAL, 8192)
        closure = observe_recovery_closed(initial, image, recovery, fresh, fresh_physical)
        verify()
        migrate.write_json(directory, RECOVERY_CLOSED, closure)
    verify()
    migrate.write_exact_bytes(directory, terminal.SESSION_CLOSED, raw)


def finalize_replacement_terminal(initial, plan, review, source, directory, image, probe, physical, written_request, committed,
                                  *, recovery=None, fresh=None):
    import p2_replacement_terminal as terminal
    import vercel

    def verify():
        supervisor.verify_guard_boundary(initial, source)

    verify()
    verify_bundle(Path(initial['bundle']), plan, probe)
    written = written_packet(plan, probe, physical, written_request)
    postflight = private_record(directory, WRITTEN_OBSERVATION, 8192)
    api = terminal.read_api(initial, plan, review, probe['candidate'], directory, written, postflight)
    base = terminal.release_base(initial, plan, review, probe['candidate'], postflight, api)
    proof = tuple(private_record(directory, name) for name in terminal.PROVIDER_FILES)
    node = tuple(private_record(directory, name) for name in terminal.NODE_FILES)
    closed = private_record(directory, terminal.SESSION_CLOSED, 8192)
    intent = private_record(directory, terminal.INTENT)
    require(migrate.file_hash(intent) == committed and canonical(terminal.exact_receipt(intent)) ==
            canonical(terminal.join_terminal(base, written, proof, node, closed, status=terminal.INTENT_STATUS)), REFUSED)
    require_observer_pair(initial, probe, physical, directory, ((CLOSED_OBSERVER_STARTED, 'CLOSED_STARTED'),
                                                               (CLOSED_OBSERVER_RETURNED, 'CLOSED_RETURNED')))
    closed_result(written, postflight, closed)
    fresh_closed = run_replacement_image(initial, image, probe,
        closed_packet={**written, 'writtenObservation': base64.b64encode(postflight).decode()})
    closed_result(written, postflight, fresh_closed)
    require(fresh_closed == closed, REFUSED)
    if recovery is not None:
        require(prepare_recovery_evidence(initial, plan, probe, review, source) == recovery, REFUSED)
        fresh_physical = private_record(directory, RECOVERY_PHYSICAL, 8192)
        require(decode_qualification_target_json(private_record(directory, RECOVERY_CLOSED, 8192), 'carrier') ==
                observe_recovery_closed(initial, image, recovery, fresh, fresh_physical), REFUSED)
    terminal.verify_provider(proof, base, probe['candidate'], plan, review, written, vercel.Client(initial['vercelToken']), verify)
    terminal.verify_runtime(initial, probe['candidate'], api, verify)
    # Re-read every byte after the independent provider and runtime checks.
    require(tuple(private_record(directory, name) for name in terminal.PROVIDER_FILES) == proof and
            tuple(private_record(directory, name) for name in terminal.NODE_FILES) == node and
            private_record(directory, terminal.SESSION_CLOSED, 8192) == closed and
            private_record(directory, WRITTEN_OBSERVATION, 8192) == postflight and
            private_record(directory, terminal.INTENT) == intent and
            terminal.read_api(initial, plan, review, probe['candidate'], directory, written, postflight) == api, REFUSED)
    verify()
    migrate.write_json(directory, terminal.TERMINAL, terminal.join_terminal(
        base, written, proof, node, closed, status=terminal.TERMINAL_STATUS))


def contain_runtime_if_started(initial, plan, selected, directory, review, reaped):
    if review is not None and os.path.lexists(directory / RUNTIME_INTENT):
        from p2_replacement_runtime_containment import contain_replacement_runtime_after_reap
        contain_replacement_runtime_after_reap(
            {**initial, 'configuration': review['configuration']}, plan, selected, directory,
            configuration_sha256=review['configurationSha256'], worker_reaped=reaped)


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


def retain_prior_recovery(initial, plan, base_probe, review, selection, evidence):
    """Read the exact failed recovery without deriving authority from its uncertain outcome."""
    import p2_prior_gateway
    from p2_replacement_runtime_containment import RECEIPT, _binding, verify_runtime_intent
    import p2_replacement_terminal as terminal

    release_id = plan['releaseId']
    previous = selection['priorRecovery']
    original = Path(selection['originalDirectory'])
    results = exact_host_directory(str(original.parent / previous['actionId']))
    directory = exact_host_directory(str(results / original.name))
    runtime_attempt = exact_host_directory(str(results / ('runtime-profiled-frontend-replacement-' + release_id)))
    migration = exact_host_directory(str(results / ('migration-profiled-frontend-replacement-' + release_id)))
    # The migration container writes its own job receipt as UID 65532.
    course = migration / 'course'
    course_uid = 65532 if os.getuid() == 0 else os.getuid()
    course_info = course.lstat()
    require(course == course.resolve() and stat.S_ISDIR(course_info.st_mode) and
            course_info.st_uid == course_uid and stat.S_IMODE(course_info.st_mode) == 0o700, REFUSED)
    stop = exact_host_directory(str(directory / 'prior-gateway-api-suspension'))
    for path in (results, directory, runtime_attempt, migration, stop):
        migrate.private_directory(path)
    require(not any(os.path.lexists(directory / name) for name in (*terminal.PROVIDER_FILES, *terminal.NODE_FILES,
                CLOSE_PREPARED, CLOSED_OBSERVER_STARTED, CLOSED_OBSERVER_RETURNED, terminal.SESSION_CLOSED,
                terminal.INTENT, terminal.TERMINAL)) and
            not os.path.lexists(runtime_attempt / 'runtime-failure.json') and
            not os.path.lexists(course / 'database-receipt.json') and
            not any(os.path.lexists(migration / 'community' / name)
                    for name in ('started.json', 'database-receipt.json', 'job-outcome.json')), REFUSED)

    raw = {
        'physicalObservation': private_record(directory, RECOVERY_PHYSICAL, 8192),
        'runtimeOutcome': private_record(runtime_attempt, 'runtime-outcome.json'),
        'migrationOutcome': private_record(migration, 'migration-outcome.json'),
        'courseJobOutcome': private_record(course, 'job-outcome.json', owner_uid=course_uid),
        'runtimeContainment': private_record(directory, RECEIPT),
        'gatewayStopped': private_record(stop, p2_prior_gateway.STOPPED),
    }
    require({key: migrate.file_hash(value) for key, value in raw.items()} == previous['evidenceSha256'], REFUSED)
    require(migrate.file_hash(private_record(migration, 'candidate.json', 2_000_000)) == plan['candidateSha256'] and
            private_record(migration / 'frontend', 'database-receipt.json') ==
                unbase64(evidence['request']['databaseReceipt'], 65_536) and
            private_record(migration / 'frontend', 'frontend-continuation-started.json', 8192) ==
                unbase64(evidence['request']['continuationStarted'], 8192) and
            private_record(migration / 'frontend', 'frontend-replacement-written-observation.json', 8192) ==
                evidence['written'], REFUSED)
    verify_runtime_intent(initial, plan, directory, configuration_sha256=review['configurationSha256'],
                          api_job_sha256=review['apiJobSha256'], postflight_sha256=migrate.file_hash(evidence['written']))
    failed_runtime = terminal.exact_receipt(raw['runtimeOutcome'])
    failed_migration = terminal.exact_receipt(raw['migrationOutcome'])
    selected = base_probe['candidate']
    migrate.require_contract_identity(selected, failed_runtime, failed_migration)
    require(all(value.get('status') == 'FAILED_REQUIRES_REVIEW' and value.get('environment') == 'staging'
                and value.get('releaseId') == release_id and value.get('frontendSqlApplied') is True
                and all(value.get(flag) is False for flag in ('trafficAuthorized', 'releaseAccepted', 'nativeSchedulesEnabled'))
                for value in (failed_runtime, failed_migration)) and
            failed_runtime.get('phase') == 'migrations' and failed_runtime.get('sourceCommit') == plan['sourceCommit'] and
            failed_runtime.get('candidateSha256') == plan['candidateSha256'] and
            failed_runtime.get('configurationSha256') == review['configurationSha256'] and
            failed_runtime.get('failureCode') == 'RUNTIME_OR_INPUT_FAILURE' and
            failed_runtime.get('frontendPromotionAuthorized') is False and not failed_runtime.get('containers') and
            failed_migration.get('phase') == 'apply-course' and failed_migration.get('runtimeResumed') is False and
            failed_migration.get('failureCode') == 'EXECUTION_OR_INPUT_FAILURE' and
            failed_migration.get('frontendSqlReplayed') is False and
            failed_migration.get('frontendReplacementReadbackSha256') == migrate.file_hash(evidence['written']) and
            failed_migration.get('frontendContinuationStartedSha256') ==
                migrate.file_hash(unbase64(evidence['request']['continuationStarted'], 8192)) and
            decode_qualification_target_json(raw['courseJobOutcome'], 'carrier') ==
                {**migrate.contract_identity(selected), 'qualificationTargetProfile': PROFILE,
                 'status': 'FAILED_REQUIRES_REVIEW', 'trafficAuthorized': False}, REFUSED)
    containment = decode_qualification_target_json(raw['runtimeContainment'], 'carrier')
    require(all(containment.get(key) == value for key, value in _binding(initial, plan).items()) and
            containment.get('status') in ('P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN',
                                          'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_OBSERVED_REQUIRES_REVIEW') and
            all(containment.get(flag) is False for flag in
                ('frontendSqlReplayed', 'automaticReplayAuthorized', 'releaseAccepted')), REFUSED)
    stopped = decode_qualification_target_json(raw['gatewayStopped'], 'carrier')
    gateway_id = stopped.get('stoppedProcess', {}).get('containerId')
    stopped_ids = failed_migration.get('stoppedRuntimeContainers')
    require(stopped.get('status') == 'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED' and
            stopped.get('actionId') == release_id and stopped.get('candidateSha256') == plan['candidateSha256'] and
            stopped.get('sourceCommit') == plan['sourceCommit'] and match(gateway_id, r'[a-f0-9]{64}') and
            type(stopped_ids) is list and all(match(identity, r'[a-f0-9]{12,64}') for identity in stopped_ids) and
            any(gateway_id.startswith(identity) for identity in stopped_ids), REFUSED)
    previous_observation = decode_qualification_target_json(raw['physicalObservation'], 'carrier')
    previous_probe = {**base_probe, **{key: previous_observation[key] for key in PROBE_IDENTITY}}
    recovery_probe_identity(previous_probe, evidence['probe'], base_probe)
    observation(previous_probe, raw['physicalObservation'])
    reference = review.get('priorGatewayReference')
    require(type(reference) is dict and reference.get('kind') == 'retained-runtime' and
            not {'stopReceiptDirectory', 'stopReceiptSha256'} & set(reference), REFUSED)
    return {
        'priorRecoveryProbe': previous_probe,
        'priorGatewayReference': {**reference, 'stopReceiptDirectory': str(stop),
                                  'stopReceiptSha256': previous['evidenceSha256']['gatewayStopped']},
        'rolePolicySupplement': selection['rolePolicySupplement'],
    }


def prepare_recovery_evidence(initial, plan, base_probe, review, source):
    from p2_replacement_runtime_containment import RECEIPT, _binding, verify_runtime_intent
    import p2_replacement_terminal as terminal

    selected = recovery_review(initial, plan['releaseId'])
    original = Path(selected['originalDirectory'])
    results, release_id = original.parent, plan['releaseId']
    attempt = exact_host_directory(str(results / ('runtime-profiled-frontend-replacement-' + release_id)))
    require(not os.path.lexists(results / ('migration-profiled-frontend-replacement-' + release_id)) and
            not any((attempt / 'configuration').glob('*.resolved.env')) and
            not any(os.path.lexists(original / name) for name in (*terminal.PROVIDER_FILES, *terminal.NODE_FILES,
                CLOSE_PREPARED, CLOSED_OBSERVER_STARTED, CLOSED_OBSERVER_RETURNED, terminal.SESSION_CLOSED,
                terminal.INTENT, terminal.TERMINAL)), REFUSED)
    armed = decode_qualification_target_json(private_record(original, ARM), 'carrier')
    physical = unbase64(armed['physicalObservation'], 8192)
    observed = decode_qualification_target_json(physical, 'carrier')
    base_probe = {key: value for key, value in base_probe.items() if key not in PROBE_IDENTITY}
    probe = {**base_probe, **{key: observed[key] for key in PROBE_IDENTITY}}
    probe_identity(probe, base_probe)
    _, arm_sha = require_arm(initial, plan, probe, original)
    boundary = decode_qualification_target_json(private_record(original, WRITE_BOUNDARY), 'carrier')
    _, write_sha, original_physical = require_write_custody(initial, plan, probe, original, arm_sha, boundary, source=source)
    require(original_physical == physical, REFUSED)
    require_write_observer_returned(initial, probe, physical, original, written=True)
    database = private_record(original, 'frontend-original-database-receipt.json')
    started = private_record(original, 'frontend-continuation-started.json', 8192)
    written = private_record(original, WRITTEN_OBSERVATION, 8192)
    aborted = private_record(original, ABORT_OBSERVATION)
    failed = private_record(attempt, 'runtime-outcome.json')
    write_containment = private_record(original, WRITE_CONTAINMENT)
    runtime_containment = private_record(original, RECEIPT)
    require(selected['originalEvidenceSha256'] == {key: migrate.file_hash(raw) for key, raw in zip(
        ('physicalObservation', 'databaseReceipt', 'continuationStarted', 'writtenObservation', 'abortObservation',
         'runtimeOutcome', 'writeContainment', 'runtimeContainment'),
        (physical, database, started, written, aborted, failed, write_containment, runtime_containment))}, REFUSED)
    postflight = decode_qualification_target_json(written, 'carrier')
    request = {key: postflight[key] for key in ('owner', 'runtime', 'producerSha256')} | {
        'writeIntentSha256': write_sha,
        'databaseReceipt': base64.b64encode(database).decode(), 'continuationStarted': base64.b64encode(started).decode()}
    packet = written_packet(plan, probe, physical, request)
    written_result(packet, written)
    require(postflight['producerSha256'] == review['producerSha256'], REFUSED)
    abort = abort_result(plan, probe, physical, aborted)
    expected_tags = plan['replacement']['approvedPendingTags']
    journal = decode_qualification_target_json(database, 'carrier')['after']
    require(abort['journalPresent'] is True and abort['appliedPrefix'] == [
        {'tag': tag, 'hash': row['hash'], 'folderMillis': int(row['created_at'])}
        for tag, row in zip(expected_tags, journal)
    ], REFUSED)
    verify_runtime_intent(initial, plan, original, configuration_sha256=review['configurationSha256'],
                          api_job_sha256=review['apiJobSha256'], postflight_sha256=migrate.file_hash(written))
    failed_record = terminal.exact_receipt(failed)
    migrate.require_contract_identity(base_probe['candidate'], failed_record)
    require(all(failed_record.get(key) == plan[key] for key in ('environment', 'releaseId', 'sourceCommit', 'candidateSha256'))
            and failed_record.get('configurationSha256') == review['configurationSha256']
            and failed_record.get('status') == 'FAILED_REQUIRES_REVIEW'
            and failed_record.get('phase') == 'configuration-preflight' and not failed_record.get('containers')
            and failed_record.get('frontendSqlApplied') is True and all(failed_record.get(key) is False for key in
                ('trafficAuthorized', 'frontendPromotionAuthorized', 'releaseAccepted', 'nativeSchedulesEnabled')), REFUSED)
    write = decode_qualification_target_json(write_containment, 'carrier')
    require(write.get('status') in ('P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN',
            'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW') and
            all(write.get(key) == value for key, value in receipt_base(initial, plan, write['status']).items()) and
            write.get('automaticReplayAuthorized') is False and write.get('backendClosureVerified') is True and
            write.get('abortObservationSha256') == migrate.file_hash(aborted) and
            write.get('physicalObservationSha256') == migrate.file_hash(physical) and
            write.get('appliedPrefixCount') == len(expected_tags), REFUSED)
    runtime_record = decode_qualification_target_json(runtime_containment, 'carrier')
    require(runtime_record.get('status') in ('P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN',
            'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_OBSERVED_REQUIRES_REVIEW') and
            all(runtime_record.get(key) == value for key, value in _binding(initial, plan).items()) and
            all(runtime_record.get(key) is False for key in ('automaticReplayAuthorized', 'frontendSqlReplayed',
                                                            'releaseAccepted')), REFUSED)
    names = (ARM, READY, WRITE_BOUNDARY, WRITE_INTENT, WRITE_READY, WRITE_OBSERVER_STARTED, WRITE_OBSERVER_RETURNED,
             WRITTEN_OBSERVER_STARTED, WRITTEN_OBSERVER_RETURNED)
    evidence = {'actionId': selected['actionId'], 'probe': probe, 'physical': physical, 'written': written,
                'request': request, 'packet': packet, 'copies': {name: private_record(original, name) for name in names},
                'custody': {'armReceiptSha256': arm_sha, 'emptyCatalogReceipt': boundary}}
    if 'priorRecovery' in selected:
        evidence.update(retain_prior_recovery(initial, plan, base_probe, review, selected, evidence))
    return evidence


def replacement_prior_gateway_input(initial, selected, review, recovery):
    input_value = {**initial, 'candidate': selected,
                   **{key: review[key] for key in ('configurationSha256', 'priorGatewayReference') if key in review}}
    if recovery is not None and 'priorGatewayReference' in recovery:
        input_value['priorGatewayReference'] = recovery['priorGatewayReference']
    return input_value


def verify_original_recovery_frontier(initial, plan, review, source, image, recovery):
    from p2_replacement_runtime_containment import HELPER, _helper_rows, replacement_write_label
    import p2_prior_gateway

    def verify():
        supervisor.verify_guard_boundary(initial, source)

    def run(args, timeout):
        verify()
        result = runtime.command(args, runtime.SAFE_ENV, timeout)
        verify()
        return result

    probe, written = recovery['probe'], recovery['written']
    packet = {**recovery['packet'], 'writtenObservation': base64.b64encode(written).decode()}
    closed_result(recovery['packet'], written, run_replacement_image(initial, image, probe, closed_packet=packet))
    label = replacement_write_label(initial['reviewedPlanSha256'])
    require(not _helper_rows(run, HELPER, label) and all(not _helper_rows(run, re.escape(f'lash-migrate-{service}-{plan["releaseId"]}'))
                for service in migrate.SERVICES), REFUSED)
    selected = probe['candidate']
    prior_input = replacement_prior_gateway_input(initial, selected, review, recovery)
    previous = recovery.get('priorRecoveryProbe')
    if previous is None:
        prior = p2_prior_gateway.preflight_prior_gateway(prior_input, selected, verify, expected_profile=PROFILE)
    else:
        prior = p2_prior_gateway.observe_stopped_prior_gateway(prior_input, selected, verify, expected_profile=PROFILE)
        require(not run(['docker', 'container', 'ls', '--filter', 'label=com.docker.compose.project=lash-her-staging',
                         '--format', '{{.ID}}'], 15) and
                not _helper_rows(run, re.escape(container_name(initial, previous))), REFUSED)
        prove_recovery_sessions_closed(initial, image, (probe, previous))
        for service in migrate.SERVICES:
            migrate.read_replacement_role_policy_artifact(initial, recovery, service, selected['sources'][service]['commit'])
    require(p2_prior_gateway._zero(prior), REFUSED)
    verify()


def recovery_probe_identity(fresh, original, base_probe, previous=None):
    probe_identity(fresh, base_probe)
    prior_probes = (original,) if previous is None else (original, previous)
    require(all(fresh['marker'] != retained['marker'] and fresh['backendPid'] != retained['backendPid'] and
                fresh['backendStart'] >= retained['backendStart'] for retained in prior_probes), REFUSED)


RECOVERY_CLOSED_PROGRAM = '''
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./ops/platform/frontend-migration.mjs";
const input = JSON.parse(readFileSync(0, "utf8"));
const { target, databaseOid, migrationRoleOid, pids, markers } = input;
const client = new Client({ ...frontendConnectionOptions(process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL, target),
  application_name: "lash-her-frontend-replacement-recovery-close", statement_timeout: 7000, query_timeout: 8000,
  options: "-c search_path=pg_catalog -c default_transaction_read_only=on" });
let lost = false;
client.on("error", () => { lost = true; });
try {
  await client.connect();
  if (!client.connection?.stream?.encrypted || !client.connection.stream.authorized) throw new Error();
  const { rows: [result] } = await client.query(`SELECT current_user=$1 AND session_user=$1 AND
    pg_catalog.current_database()=$2 AND pg_catalog.current_setting('server_version_num')::int/10000=$3::int AND
    pg_catalog.current_setting('transaction_read_only')='on' AND
    EXISTS(SELECT FROM pg_catalog.pg_roles WHERE oid=$4::oid AND rolname=session_user) AND
    EXISTS(SELECT FROM pg_catalog.pg_database WHERE oid=$5::oid AND datname=pg_catalog.current_database()) AND
    NOT EXISTS(SELECT FROM pg_catalog.pg_stat_activity WHERE pid=ANY($6::int[])) AND
    NOT EXISTS(SELECT FROM pg_catalog.pg_prepared_xacts WHERE database=pg_catalog.current_database()) AND
    NOT EXISTS(SELECT FROM pg_catalog.pg_locks l JOIN
      (SELECT pg_catalog.hashtext(name)::bigint AS key FROM pg_catalog.unnest($7::text[]) AS name) wanted
      ON l.classid=((wanted.key>>32)&4294967295)::oid AND l.objid=(wanted.key&4294967295)::oid
      WHERE l.locktype='advisory' AND l.database=$5::oid AND l.objsubid=1) AS verified`,
    [target.user, target.database, target.serverMajor, migrationRoleOid, databaseOid, pids, [...markers, FRONTEND_MIGRATION_LOCK]]);
  if (result?.verified !== true || lost) throw new Error();
} finally { await client.end(); }
if (lost) throw new Error();
console.log("RECOVERY_BACKENDS_AND_LOCKS_ABSENT");
'''


def prove_recovery_sessions_closed(initial, image, probes):
    plan_sha = initial['reviewedPlanSha256']
    final_probe = probes[-1]
    name = container_name(initial, final_probe)
    args = ['docker', 'run', '--rm', '--pull=never', '--platform', 'linux/amd64', '--name', name,
            '--label', 'io.lash-her.replacement-arm=' + plan_sha, '--interactive', '--network', 'host',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
            '--pids-limit', '64', '--env', CREDENTIAL, '--entrypoint', 'node', image, '--input-type=module',
            '--eval', RECOVERY_CLOSED_PROGRAM]
    packet = {'target': final_probe['job']['target'], 'databaseOid': final_probe['databaseOid'],
              'migrationRoleOid': final_probe['migrationRoleOid'], 'pids': [probe['backendPid'] for probe in probes],
              'markers': [probe['marker'] for probe in probes]}
    env = {**runtime.SAFE_ENV, CREDENTIAL: initial['credentials'][CREDENTIAL]}
    try:
        require(run_bounded_image(args, encoded(packet), env) == b'RECOVERY_BACKENDS_AND_LOCKS_ABSENT\n', REFUSED)
    finally:
        remove_container(name, plan_sha)


def observe_recovery_closed(initial, image, recovery, fresh, physical):
    observation(fresh, physical)
    previous = recovery.get('priorRecoveryProbe')
    probes = (recovery['probe'], fresh) if previous is None else (recovery['probe'], previous, fresh)
    prove_recovery_sessions_closed(initial, image, probes)
    return {'version': 1, 'status': 'P2_FRONTEND_REPLACEMENT_RECOVERY_SESSION_CLOSED',
            'recoveryReviewSha256': initial['recoveryReviewSha256'],
            'originalPhysicalObservationSha256': migrate.file_hash(recovery['physical']),
            'freshPhysicalObservationSha256': migrate.file_hash(physical),
            'originalBackendAbsent': True, 'freshBackendAbsent': True, 'advisoryLocksAbsent': True}


def contain_replacement_write(initial, plan, image, directory, probe, physical, *, process_reconciled=True,
                              runtime_observer_reconciled=False):
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
        observer_reconciled = not has_record(RUNTIME_INTENT) or runtime_observer_reconciled
        for started, returned, stage in ((WRITE_OBSERVER_STARTED, WRITE_OBSERVER_RETURNED, ''),
                                         (WRITTEN_OBSERVER_STARTED, WRITTEN_OBSERVER_RETURNED, 'WRITTEN_'),
                                         (CLOSED_OBSERVER_STARTED, CLOSED_OBSERVER_RETURNED, 'CLOSED_')):
            if has_record(started) or has_record(returned):
                try:
                    require_observer_pair(initial, probe, physical, directory,
                                          ((started, stage + 'STARTED'), (returned, stage + 'RETURNED')))
                except (OSError, ValueError):
                    observer_reconciled = False
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


class ReplacementRuntimeObserver(PhysicalObserver):
    def __init__(self, broker, packet, original):
        super().__init__(broker.probe['candidate'], packet, broker.source, broker.initial['credentials'][CREDENTIAL])
        self.broker, self.original = broker, original
        self.probe_lock = threading.Lock()

    def probe(self, operation):
        require(operation in ('verify-schema', 'observe'), REFUSED)
        broker = self.broker
        try:
            with self.probe_lock:
                if broker.recovery is not None:
                    raw = observe(broker.initial, broker.image, broker.fresh_probe)
                    require(raw == broker.fresh_observation, REFUSED)
                    return observation(broker.fresh_probe, raw)
                raw = run_replacement_image(broker.initial, broker.image, broker.probe, written_packet=self.request)
            require(raw == self.original, REFUSED)
            return written_result(self.request, raw)
        except BaseException:
            broker.runtime_observer_cleanup_uncertain = True
            raise

    def verify_live_lock(self):
        broker = self.broker
        try:
            with self.probe_lock:
                require(not broker.failed.is_set(), REFUSED)
                probe, physical = ((broker.probe, broker.write_observation) if broker.recovery is None else
                                   (broker.fresh_probe, broker.fresh_observation))
                raw = observe(broker.initial, broker.image, probe)
            require(raw == physical, REFUSED)
        except BaseException:
            broker.runtime_observer_cleanup_uncertain = True
            raise


class ReplacementWriteBroker(ReplacementArmBroker):
    """Source-only replacement through closed staged runtime and provider join."""

    def __init__(self, *args, image, runtime_review=None, recovery=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.image = image
        self.write_mutex = threading.Lock()
        self.write_observation = None
        self.custody = None
        self.write_intent_sha = None
        self.verified_written = None
        self.written_request = None
        self.runtime_review = runtime_review
        self.recovery = recovery
        self.fresh_probe = self.fresh_observation = None
        self.runtime_intent = None
        self.runtime_observer_cleanup_uncertain = False
        self.provider_raw = None
        self.close_started = None
        self.session_closed = None
        self.joined_intent_sha = None

    def check(self):
        super().check()
        if self.close_started is not None:
            require(time.monotonic() - self.close_started < CLOSE_SECONDS, REFUSED)

    def command(self, value):
        operation = value.get('operation') if type(value) is dict else None
        if operation == 'resume-replacement-written':
            return self.resume_replacement_written(value)
        if self.recovery is not None:
            require(operation not in ('arm-replacement', 'authorize-replacement-write', 'verify-replacement-written'), REFUSED)
        if operation in ('check', 'arm-replacement'):
            return super().command(value)
        if operation == 'verify-replacement-written':
            return self.verify_written(value)
        if operation == 'start-replacement-runtime':
            return self.start_replacement_runtime(value)
        stages = {'verify-replacement-frontend': (self.verify_replacement_frontend, {'proof', 'workload', 'promotion'}),
                  'prepare-replacement-close': (self.prepare_replacement_close, set()),
                  'observe-replacement-closed': (self.observe_replacement_closed, set()),
                  'finish-replacement': (self.finish_replacement, {'terminal', 'continuationCompleted', 'releaseOutcome'}),
                  'commit': (self.commit_replacement, set())}
        if operation in stages:
            stage, fields = stages[operation]
            require(self.runtime_review is not None and 'vercelToken' in self.initial and not self.committed.is_set() and
                    set(value) == {'id', 'operation', *fields} and
                    type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1, REFUSED)
            self.last_command = time.monotonic()
            self.check()
            return stage(value)
        require(operation == 'authorize-replacement-write' and set(value) == {
            'id', 'operation', 'armReceiptSha256', 'emptyCatalogReceipt'} and
            type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1 and
            self.probe is not None and self.write_observation is None, REFUSED)
        self.last_command = time.monotonic()
        self.check()
        armed, arm_sha = require_arm(self.initial, self.plan, self.probe, self.directory)
        require(value['armReceiptSha256'] == arm_sha, REFUSED)
        empty_catalog_receipt(self.initial, self.plan, self.probe, value['emptyCatalogReceipt'], source=self.source)
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
                    self.initial, self.plan, self.probe, self.directory, arm_sha, value['emptyCatalogReceipt'], source=self.source)
                break
            except FileNotFoundError:
                time.sleep(0.05)
        with self.write_mutex:
            self.check()
            require(physical == self.write_observation, REFUSED)
            self.custody = {'armReceiptSha256': arm_sha, 'emptyCatalogReceipt': value['emptyCatalogReceipt']}
            self.write_intent_sha = intent_sha
            self.send(value['id'], 'REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED', receipt=receipt, writeIntentSha256=intent_sha)

    def resume_replacement_written(self, value):
        require(self.recovery is not None and self.probe is None and set(value) == {'id', 'operation', 'probe'} and
                type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1, REFUSED)
        self.last_command = time.monotonic()
        self.check()
        fresh = value['probe']
        recovery_probe_identity(fresh, self.recovery['probe'], self.base_probe, self.recovery.get('priorRecoveryProbe'))
        self.safety({'operation': 'replacement-recovery-armed', 'probe': fresh})
        deadline = time.monotonic() + 60
        while True:
            require(not self.failed.is_set() and self.guard_alive and time.monotonic() < deadline, REFUSED)
            try:
                raw = private_record(self.directory, RECOVERY_PHYSICAL, 8192)
                written = private_record(self.directory, WRITTEN_OBSERVATION, 8192)
                break
            except FileNotFoundError:
                time.sleep(0.05)
        self.check()
        observation(fresh, raw)
        require(written == self.recovery['written'], REFUSED)
        self.fresh_probe, self.fresh_observation = fresh, raw
        self.probe, self.write_observation = self.recovery['probe'], self.recovery['physical']
        self.written_request, self.verified_written = self.recovery['packet'], written
        self.custody, self.write_intent_sha = self.recovery['custody'], self.recovery['request']['writeIntentSha256']
        self.send(value['id'], 'REPLACEMENT_WRITTEN_RESUMED', postflightSha256=migrate.file_hash(written))

    def verify_written(self, value):
        require(set(value) == {'id', 'operation', *WRITTEN_REQUEST_FIELDS} and
                type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1 and
                self.custody is not None and self.verified_written is None, REFUSED)
        self.last_command = time.monotonic()
        self.check()
        _, intent_sha, physical = require_write_custody(self.initial, self.plan, self.probe, self.directory,
                                                        self.custody['armReceiptSha256'], self.custody['emptyCatalogReceipt'], source=self.source)
        require(value['writeIntentSha256'] == intent_sha and physical == self.write_observation, REFUSED)
        packet = written_packet(self.plan, self.probe, physical, value)
        require(self.runtime_review is None or packet['producerSha256'] == self.runtime_review['producerSha256'], REFUSED)
        self.safety({'operation': 'replacement-written', **{key: value[key] for key in WRITTEN_REQUEST_FIELDS}})
        deadline = time.monotonic() + 60
        while True:
            require(not self.failed.is_set() and self.guard_alive and time.monotonic() < deadline, REFUSED)
            try:
                raw = private_record(self.directory, WRITTEN_OBSERVATION, 8192)
                break
            except FileNotFoundError:
                time.sleep(0.05)
        self.check()
        require_write_observer_returned(self.initial, self.probe, physical, self.directory, written=True)
        written_result(packet, raw)
        self.verified_written = raw
        self.written_request = packet
        self.send(value['id'], 'REPLACEMENT_WRITTEN_VERIFIED', postflightSha256=migrate.file_hash(raw))

    def verify_replacement_runtime(self):
        self.check()
        require(self.runtime_review is not None and self.runtime_intent is not None and
                type(self.observer) is ReplacementRuntimeObserver, REFUSED)
        require(private_record(self.directory, RUNTIME_INTENT) == self.runtime_intent and
                private_record(self.directory, WRITTEN_OBSERVATION, 8192) == self.verified_written and
                migrate.file_hash(private_record(self.directory, RUNTIME_REVIEW, 65_536)) == self.initial['runtimeReviewSha256'],
                REFUSED)

        require(require_write_custody(self.initial, self.plan, self.probe, self.directory,
                                      self.custody['armReceiptSha256'], self.custody['emptyCatalogReceipt'], source=self.source)[1:] ==
                (self.write_intent_sha, self.write_observation), REFUSED)
        if self.recovery is not None:
            require(private_record(self.directory, RECOVERY_PHYSICAL, 8192) == self.fresh_observation and
                    migrate.file_hash(private_record(self.directory, RECOVERY_REVIEW)) == self.initial['recoveryReviewSha256'], REFUSED)
        verify_bundle(Path(self.initial['bundle']), self.plan, self.probe)
        require(migrate.profiled_current_job_hashes(Path(self.initial['bundle'])) == self.runtime_review['apiJobSha256'] and
                staging_state.configuration_hashes(Path(self.runtime_review['configuration'])) == self.runtime_review['configurationSha256'],
                REFUSED)

    def verify_replacement_mutation(self):
        self.verify_replacement_runtime()
        # The fresh observer runs outside the runtime command ContextVar.
        # It must be able to reap its own Docker helper on scope revocation.
        with ThreadPoolExecutor(max_workers=1) as worker:
            worker.submit(self.observer.verify_live_lock).result()
        self.verify_replacement_runtime()

    def start_replacement_runtime(self, value):
        require(set(value) == {'id', 'operation', 'postflightSha256'} and
                type(value['id']) is int and 0 < value['id'] <= (1 << 53) - 1 and
                self.runtime_review is not None and self.verified_written is not None and self.worker is None and
                migrate.file_hash(self.verified_written) == value['postflightSha256'], REFUSED)
        self.last_command = time.monotonic()
        self.check()
        self.safety({'operation': 'replacement-runtime', 'postflightSha256': value['postflightSha256']})
        deadline = time.monotonic() + 60
        while True:
            require(not self.failed.is_set() and self.guard_alive and time.monotonic() < deadline, REFUSED)
            try:
                raw = private_record(self.directory, RUNTIME_INTENT)
                break
            except FileNotFoundError:
                time.sleep(0.05)
        require(canonical(decode_qualification_target_json(raw, 'carrier')) ==
                canonical(runtime_intent_record(self.initial, self.plan, self.runtime_review, self.verified_written)), REFUSED)
        with self.write_mutex:
            self.check()
            self.runtime_intent, self.runtime_identity = raw, value['id']
            self.worker = threading.Thread(target=self.run_replacement_runtime, daemon=True)
            self.worker.start()

    def run_replacement_runtime(self):
        from p2_profiled_current_scope import P2ProfiledReplacementScope
        import p2_prior_gateway
        old_credentials = {}
        observer = None
        try:
            review, packet = self.runtime_review, self.written_request
            observer = ReplacementRuntimeObserver(self, packet, self.verified_written)
            self.check()
            observer.start(self.abort)
            with self.write_mutex:
                self.check()
                self.observer = observer
            self.verify_replacement_runtime()
            self.scope = P2ProfiledReplacementScope(
                self, postflight_raw=self.verified_written, database_raw=unbase64(packet['databaseReceipt'], 65_536),
                started_raw=unbase64(packet['continuationStarted'], 8192), owner=packet['owner'], runtime=packet['runtime'],
                producer_sha256=packet['producerSha256'], api_job_sha256=review['apiJobSha256'],
                configuration_sha256=review['configurationSha256'])
            prior_input = replacement_prior_gateway_input(self.initial, self.probe['candidate'], review, self.recovery)
            self.verify_replacement_mutation()
            resumed_stopped = self.recovery is not None and 'priorGatewayReference' in self.recovery
            if resumed_stopped:
                prior = p2_prior_gateway.observe_stopped_prior_gateway(
                    prior_input, self.probe['candidate'], self.verify_replacement_runtime, expected_profile=PROFILE)
                require(p2_prior_gateway._zero(prior), REFUSED)
            prior_gateway = p2_prior_gateway.prepare_prior_gateway(prior_input, self.probe['candidate'], self.directory,
                                                                   self.verify_replacement_runtime, expected_profile=PROFILE)
            require(not resumed_stopped or prior_gateway.stopped, REFUSED)
            self.scope.bind_prior_gateway(prior_gateway)
            for key in API_CREDENTIALS:
                old_credentials[key] = os.environ.get(key)
                os.environ[key] = self.initial['credentials'][key]
            result = runtime.execute_profiled_replacement_runtime(
                Path(self.initial['bundle']), Path(review['configuration']), Path(self.initial['results']),
                self.source / 'ops/platform/compose.yaml', expected_profile=PROFILE, _profiled_replacement_scope=self.scope)
            require(self.released.is_set() and self.promoted is not None and result == self.ready and not self.failed.is_set(), REFUSED)
        except BaseException:
            self.abort()
        finally:
            if observer is not None:
                try:
                    observer.stop()
                except BaseException:
                    self.runtime_observer_cleanup_uncertain = True
                    self.abort()
            for key, previous in old_credentials.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous
            self.worker_done.set()

    def replacement_runtime_ready(self, attempt, migration_attempt, snapshot, selected, outcome):
        self.verify_replacement_runtime()
        raw = migrate.read_input(attempt, 'runtime-outcome.json')
        migration_raw = migrate.read_input(migration_attempt, 'migration-outcome.json')
        require(selected == self.probe['candidate'] and decode_qualification_target_json(raw, 'carrier') == outcome and
                outcome.get('status') == 'API_RUNTIME_READY' and
                outcome.get('candidateSha256') == self.initial['candidateSha256'] and
                outcome.get('migrationOutcomeSha256') == migrate.file_hash(migration_raw) and
                outcome.get('frontendReplacementReadbackSha256') == migrate.file_hash(self.verified_written) and
                outcome.get('frontendSqlApplied') is True and outcome.get('frontendSqlReplayed') is False and
                outcome.get('trafficAuthorized') is False and outcome.get('releaseAccepted') is False, REFUSED)
        self.verify_replacement_gateway_closed(selected, snapshot, outcome)
        self.runtime_snapshot, self.ready = snapshot, outcome
        self.api_pins = (migrate.file_hash(raw), migrate.file_hash(migration_raw))
        self.send(self.runtime_identity, 'REPLACEMENT_API_RUNTIME_READY', runtimeOutcomeSha256=self.api_pins[0],
                  migrationOutcomeSha256=self.api_pins[1])
        next_gateway_check = time.monotonic() + 1
        while not self.released.wait(0.1):
            self.verify_replacement_runtime()
            if time.monotonic() >= next_gateway_check:
                self.verify_replacement_gateway_closed(selected, snapshot, outcome)
                next_gateway_check = time.monotonic() + 1
        self.verify_replacement_runtime()
        require(self.promoted is not None, REFUSED)

    def verify_replacement_gateway_closed(self, selected, snapshot, outcome):
        self.verify_replacement_runtime()
        require(runtime.check_containers(selected, snapshot, expected_profile=PROFILE) == outcome['containers'], REFUSED)
        self.scope.prior_gateway.verify_replacement_closed_zero()
        self.verify_replacement_runtime()

    def replacement_api(self):
        import p2_replacement_terminal as terminal
        selected = self.probe['candidate']
        api = terminal.read_api(self.initial, self.plan, self.runtime_review, selected, self.directory,
                                self.written_request, self.verified_written)
        require((migrate.file_hash(api['runtimeRaw']), migrate.file_hash(api['migrationRaw'])) == self.api_pins and
                api['outcome'] == self.ready and api['snapshot'] == self.runtime_snapshot, REFUSED)
        return api, terminal.release_base(self.initial, self.plan, self.runtime_review, selected, self.verified_written, api)

    def readback_replacement_provider(self, raw):
        import p2_replacement_terminal as terminal
        import vercel
        api, base = self.replacement_api()
        selected = self.probe['candidate']
        proof = terminal.verify_provider(raw, base, selected, self.plan, self.runtime_review, self.written_request,
                                         vercel.Client(self.initial['vercelToken']), self.verify_replacement_runtime)
        terminal.verify_runtime(self.initial, selected, api, self.verify_replacement_runtime)
        return proof

    def verify_replacement_frontend(self, value):
        import p2_replacement_terminal as terminal
        require(self.ready is not None and self.provider_raw is None and self.close_started is None, REFUSED)
        self.verify_replacement_mutation()
        raw = tuple(unbase64(value[key], 65_536) for key in ('proof', 'workload', 'promotion'))
        proof = self.readback_replacement_provider(raw)
        self.verify_replacement_mutation()
        for name, original in zip(terminal.PROVIDER_FILES, raw):
            migrate.write_exact_bytes(self.directory, name, original)
        self.provider_raw, self.promoted = raw, proof
        self.send(value['id'], 'REPLACEMENT_FRONTEND_VERIFIED', proofSha256=migrate.file_hash(raw[0]))

    def prepare_replacement_close(self, value):
        require(self.provider_raw is not None and self.close_started is None and self.session_closed is None, REFUSED)
        self.verify_replacement_mutation()
        require(self.readback_replacement_provider(self.provider_raw) == self.promoted, REFUSED)
        self.released.set()
        require(self.worker_done.wait(40) and not self.failed.is_set() and not self.runtime_observer_cleanup_uncertain, REFUSED)
        self.verify_replacement_mutation()
        require(self.observer.stop_event.is_set(), REFUSED)
        self.scope.begin_close()
        # The guarded worker has finished. No ordinary scoped subprocess can
        # start again. Node still holds PostgreSQL through its final checks.
        self.observer = None
        self.close_started = time.monotonic()
        self.check()
        migrate.write_json(self.directory, CLOSE_PREPARED, close_prepared_record(
            self.initial, self.plan, migrate.file_hash(self.provider_raw[0])))
        self.send(value['id'], 'REPLACEMENT_CLOSE_PREPARED')

    def observe_replacement_closed(self, value):
        import p2_replacement_terminal as terminal
        require(self.close_started is not None and self.session_closed is None, REFUSED)
        self.safety({'operation': 'replacement-closed', 'providerProofSha256': migrate.file_hash(self.provider_raw[0])})
        deadline = time.monotonic() + 90
        while True:
            self.check()
            require(time.monotonic() < deadline, REFUSED)
            try:
                raw = private_record(self.directory, terminal.SESSION_CLOSED, 8192)
                break
            except FileNotFoundError:
                time.sleep(0.05)
        closed_result(self.written_request, self.verified_written, raw)
        self.session_closed = raw
        self.send(value['id'], 'REPLACEMENT_SESSION_CLOSED', sessionClosedSha256=migrate.file_hash(raw))

    def finish_replacement(self, value):
        import p2_replacement_terminal as terminal
        require(self.session_closed is not None and self.joined_intent_sha is None and self.worker_done.is_set(), REFUSED)
        require(tuple(private_record(self.directory, name) for name in terminal.PROVIDER_FILES) == self.provider_raw and
                private_record(self.directory, terminal.SESSION_CLOSED, 8192) == self.session_closed, REFUSED)
        api, base = self.replacement_api()
        raw = tuple(unbase64(value[key], 65_536) for key in ('terminal', 'continuationCompleted', 'releaseOutcome'))
        intent = terminal.join_terminal(base, self.written_request, self.provider_raw, raw,
                                        self.session_closed, status=terminal.INTENT_STATUS)
        terminal.verify_runtime(self.initial, self.probe['candidate'], api, self.check)
        for name, original in zip(terminal.NODE_FILES, raw):
            migrate.write_exact_bytes(self.directory, name, original)
        migrate.write_json(self.directory, terminal.INTENT, intent)
        self.joined_intent_sha = migrate.file_hash(private_record(self.directory, terminal.INTENT))
        self.send(value['id'], 'REPLACEMENT_JOINED', commitIntentSha256=self.joined_intent_sha)

    def commit_replacement(self, value):
        import p2_replacement_terminal as terminal
        require(self.joined_intent_sha is not None and self.session_closed is not None and self.worker_done.is_set() and
                migrate.file_hash(private_record(self.directory, terminal.INTENT)) == self.joined_intent_sha, REFUSED)
        self.send(value['id'], 'COMMITTED', commitIntentSha256=self.joined_intent_sha)
        self.safety({'operation': 'committed', 'sha256': self.joined_intent_sha})
        self.committed.set()

    def abort(self):
        with self.write_mutex:
            super().abort()
            if self.scope is not None:
                self.scope.revoked.set()
            if self.observer is not None:
                self.observer.stop_event.set()

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
            reaped = os.getppid() != self.initial['_guardPid']
            try:
                if self.scope is not None:
                    self.scope.revoke()
                    reaped = reaped and not getattr(self.scope, 'cleanup_uncertain', False)
                if self.worker is not None and not self.worker_done.wait(45):
                    reaped = False
                if self.observer is not None:
                    try:
                        self.observer.stop()
                    except BaseException:
                        self.runtime_observer_cleanup_uncertain = True
            except BaseException:
                reaped = False
            try:
                try:
                    contain_runtime_if_started(self.initial, self.plan, self.probe['candidate'], self.directory,
                                               self.runtime_review, reaped)
                finally:
                    if self.recovery is None:
                        contain_replacement_write(self.initial, self.plan, self.image, self.directory, self.probe,
                                                  self.write_observation, process_reconciled=reaped,
                                                  runtime_observer_reconciled=reaped and not self.runtime_observer_cleanup_uncertain)
                    elif reaped:
                        remove_container(container_name(self.initial, self.fresh_probe), self.initial['reviewedPlanSha256'])
            except Exception:
                pass  # Each containment stage retains its own uncertainty.

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


def broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read, image=None,
                 runtime_review=None, recovery=None):
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
                         **({'image': image, 'runtime_review': runtime_review, 'recovery': recovery} if writing else {}))
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
        if writing:
            require(broker.operation_active.acquire(timeout=2), REFUSED)
            broker.operation_active.release()
        require(broker.committed.is_set() and not broker.failed.is_set(), REFUSED)
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
    # Owned qualification also exercises intermediate no-provider cases.
    return _supervise_replacement(initial, source, writing=True)


def _supervise_replacement(initial, source, *, writing, validate_only=False):
    require(sys.platform == 'linux' and os.geteuid() == 0, REFUSED)
    require(initial.get('mode') == (WRITE_MODE if writing else MODE), REFUSED)
    require(not validate_only or writing and 'recoveryReviewSha256' in initial, REFUSED)
    flags = os.O_RDWR | os.O_NOFOLLOW | (0 if validate_only else os.O_CREAT)
    fd = os.open(LOCK, flags, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, REFUSED)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw, plan, base_probe, image, directory = prepare(initial, source, mode=WRITE_MODE if writing else MODE)
        layout = supervisor.PROFILED_REPLACEMENT_WRITE_LAYOUT if writing else LAYOUT
        initial = {**initial, '_guardLayout': layout, '_guardLockDescriptor': fd, '_guardPid': os.getpid()}
        supervisor.verify_guard_boundary(initial, source)
        runtime_review = None
        recovery = None
        if writing and 'runtimeReviewSha256' in initial:
            from p2_replacement_runtime_review import prepare_runtime_review
            runtime_review = prepare_runtime_review(initial, plan, source, base_probe)
        if 'recoveryReviewSha256' in initial:
            recovery = prepare_recovery_evidence(initial, plan, base_probe, runtime_review, source)
            verify_original_recovery_frontier(initial, plan, runtime_review, source, image, recovery)
            if validate_only:
                print(encoded({'status': 'P2_FRONTEND_REPLACEMENT_RECOVERY_FRONTIER_VERIFIED',
                               'environment': 'staging', 'releaseId': plan['releaseId'], 'actionId': recovery['actionId'],
                               'recoveryReviewSha256': initial['recoveryReviewSha256'], 'trafficAuthorized': False}).decode())
                return
            directory.parent.mkdir(mode=0o700)
            previous_results = os.open(directory.parent.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(previous_results)
            finally:
                os.close(previous_results)
        directory.mkdir(mode=0o700)
        results_fd = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(results_fd)
        finally:
            os.close(results_fd)
        migrate.write_exact_bytes(directory, 'reviewed-plan.json', raw)
        if runtime_review is not None:
            migrate.write_exact_bytes(directory, RUNTIME_REVIEW, unbase64(initial['runtimeReviewBytes'], 65_536))
        if recovery is not None:
            migrate.write_exact_bytes(directory, RECOVERY_REVIEW, unbase64(initial['recoveryReviewBytes'], 65_536))
            migrate.write_json(directory, RECOVERY_OPERATOR, {
                **{key: initial[key] for key in ('operatorSourceCommit', 'sourceClosureSha256', 'sourceCommit', 'recoveryReviewSha256')},
                'actionId': recovery['actionId'],
            })
            for name, record in recovery['copies'].items():
                migrate.write_exact_bytes(directory, name, record)
        safety_read, safety_write = os.pipe()
        health_read, health_write = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(safety_read)
            os.close(health_write)
            os.setsid()
            os._exit(broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read, image,
                                  runtime_review, recovery))
        os.close(safety_write)
        os.close(health_read)
        cancelled = threading.Event()
        armed_probe = None
        write_physical = None
        fresh_probe = None
        try:
            with ThreadPoolExecutor(max_workers=1) as worker:
                custody_request = None
                written_request = None
                def arm(probe):
                    nonlocal armed_probe
                    probe_identity(probe, base_probe)
                    armed_probe = probe
                    return worker.submit(verify_and_retain, initial, plan, base_probe, image, directory, source, probe, cancelled)
                def authorize_write(request):
                    nonlocal write_physical, custody_request
                    require(armed_probe is not None and write_physical is None, REFUSED)
                    armed, _ = require_arm(initial, plan, armed_probe, directory)
                    write_physical = unbase64(armed['physicalObservation'], 8192)
                    custody_request = request
                    return worker.submit(verify_and_retain_write_custody, initial, plan, base_probe, image,
                                         directory, source, armed_probe, request, cancelled)
                def verify_written(request):
                    nonlocal written_request
                    require(custody_request is not None and write_physical is not None, REFUSED)
                    require(runtime_review is None or request['producerSha256'] == runtime_review['producerSha256'], REFUSED)
                    written_request = request
                    return worker.submit(verify_and_retain_written, initial, plan, base_probe, image, directory,
                                         source, armed_probe, custody_request, request, cancelled)
                def resume_written(probe):
                    nonlocal armed_probe, write_physical, fresh_probe, custody_request, written_request
                    recovery_probe_identity(probe, recovery['probe'], base_probe, recovery.get('priorRecoveryProbe'))
                    fresh_probe = probe
                    armed_probe, write_physical = recovery['probe'], recovery['physical']
                    custody_request, written_request = recovery['custody'], recovery['request']

                    def retain():
                        supervisor.verify_guard_boundary(initial, source)
                        verify_bundle(Path(initial['bundle']), plan, fresh_probe)
                        physical = observe(initial, image, fresh_probe)
                        supervisor.verify_guard_boundary(initial, source)
                        require(not cancelled.is_set(), REFUSED)
                        migrate.write_exact_bytes(directory, WRITTEN_OBSERVATION, recovery['written'])
                        migrate.write_exact_bytes(directory, RECOVERY_PHYSICAL, physical)

                    return worker.submit(retain)
                def start_runtime(request):
                    require(written_request is not None and write_physical is not None, REFUSED)
                    return worker.submit(retain_runtime_intent, initial, plan, runtime_review, source, directory,
                                         armed_probe, write_physical, custody_request, written_request, request, cancelled)
                def verify_closed(request):
                    require(written_request is not None and write_physical is not None and runtime_review is not None and
                            digest(request['providerProofSha256']), REFUSED)
                    return worker.submit(retain_closed_observation, initial, plan, runtime_review, source, directory,
                                         image, armed_probe, write_physical, custody_request, written_request, request, cancelled,
                                         recovery=recovery, fresh=fresh_probe)
                provider_selected = runtime_review is not None and 'vercelToken' in initial
                try:
                    committed = supervisor.watch_broker(child, safety_read, health_write, arm,
                                                        profiled_certification=True, async_arm=True,
                                                        authorize_replacement_write=authorize_write if writing and recovery is None else None,
                                                        verify_replacement_written=verify_written if writing and recovery is None else None,
                                                        start_replacement_runtime=start_runtime if runtime_review is not None else None,
                                                        verify_replacement_closed=verify_closed if provider_selected else None,
                                                        resume_replacement_written=resume_written if recovery is not None else None)
                except BaseException:
                    cancelled.set()
                    raise
            if writing:
                require(provider_selected and write_physical is not None and written_request is not None and
                        not supervisor.members(child), REFUSED)
                require(require_write_custody(initial, plan, armed_probe, directory, custody_request['armReceiptSha256'],
                                              custody_request['emptyCatalogReceipt'], source=source)[1:] ==
                        (written_request['writeIntentSha256'], write_physical), REFUSED)
                finalize_replacement_terminal(initial, plan, runtime_review, source, directory, image, armed_probe, write_physical,
                                              written_request, committed, recovery=recovery, fresh=fresh_probe)
                return
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
                        try:
                            contain_runtime_if_started(initial, plan, base_probe['candidate'], directory, runtime_review, reaped)
                        finally:
                            if recovery is None:
                                contain_replacement_write(initial, plan, image, directory, armed_probe, write_physical,
                                                          process_reconciled=reaped)
                            elif reaped:
                                remove_container(container_name(initial, fresh_probe), initial['reviewedPlanSha256'])
                    elif reaped and armed_probe is not None:
                        remove_container(container_name(initial, armed_probe), initial['reviewedPlanSha256'])
            raise
        finally:
            os.close(safety_read)
            os.close(health_write)
    finally:
        os.close(fd)


def main():
    require(sys.argv[1:] in (['--supervise-pre-bootstrap'], ['--supervise-replacement-write'],
                            ['--validate-replacement-recovery']) and
            sys.platform == 'linux' and os.geteuid() == 0, REFUSED)
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), REFUSED)
    initial = decode_qualification_target_json(raw, 'private-packet')
    source = Path(__file__).resolve().parents[3]
    if sys.argv[1] in ('--supervise-replacement-write', '--validate-replacement-recovery'):
        require(type(initial) is dict and {*RUNTIME_REVIEW_FIELDS, 'vercelToken'} <= set(initial), REFUSED)
        reviewed_plan(initial, mode=WRITE_MODE)
        if sys.argv[1] == '--validate-replacement-recovery':
            _supervise_replacement(initial, source, writing=True, validate_only=True)
        else:
            qualify_replacement_write_frontier(initial, source)
    else:
        supervise_replacement_arm(initial, source)


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
