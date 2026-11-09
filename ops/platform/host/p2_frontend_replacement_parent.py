#!/usr/bin/env python3
"""Fixed staging replacement lock observation under an independent host guard."""

import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import p2_release_supervisor as supervisor
import release as runtime
import staging_state
from p2_release_broker import Broker, LOCK, MAXIMUM
from p2_source_closure import PROFILED_REPLACEMENT_ARM_MODE, verify_profiled_current_source_closure
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json

require = migrate.demand
PROFILE = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
MODE = PROFILED_REPLACEMENT_ARM_MODE
LAYOUT = supervisor.PROFILED_REPLACEMENT_ARM_LAYOUT
CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
REFUSED = 'P2_FRONTEND_REPLACEMENT_HOST_ARM_REFUSED'
ARM = 'p2-frontend-replacement-guard-armed.json'
READY = 'p2-frontend-replacement-guard-ready.json'
COMMIT_INTENT = 'p2-frontend-replacement-broker-commit-intent.json'
INTENT_STATUS = 'P2_FRONTEND_REPLACEMENT_BROKER_COMMIT_INTENT'
TERMINAL = LAYOUT['terminalName']
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


def reviewed_plan(initial):
    require(type(initial) is dict and set(initial) == INITIAL_FIELDS and
            type(initial['version']) is int and initial['version'] == 1 and initial['mode'] == MODE and
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
            and initial['confirmation'] == 'staging/' + plan['releaseId'] + '/replacement-arm/' + initial['reviewedPlanSha256'],
            REFUSED)
    credentials = initial['credentials']
    require(type(credentials) is dict and set(credentials) == {CREDENTIAL} and
            type(credentials[CREDENTIAL]) is str and 0 < len(credentials[CREDENTIAL]) <= 16_384
            and all(ord(character) >= 32 for character in credentials[CREDENTIAL]), REFUSED)
    return raw, plan


def prepare(initial, source):
    raw, plan = reviewed_plan(initial)
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
    directory = results / (LAYOUT['receiptPrefix'] + plan['releaseId'])
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


def container_name(initial, probe):
    suffix = migrate.file_hash((initial['reviewedPlanSha256'] + probe['marker']).encode())[:32]
    return 'lash-p2-frontend-replacement-arm-' + suffix


def remove_container(name, plan_sha):
    query = ['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$']
    owned = [*query, '--filter', 'label=io.lash-her.replacement-arm=' + plan_sha]
    format_ids = ['--format', '{{.ID}}']
    found = runtime.command([*owned, *format_ids], runtime.SAFE_ENV, 10).splitlines()
    require(len(found) <= 1 and all(match(identity, r'[a-f0-9]{12,64}') for identity in found), REFUSED)
    for identity in found:
        runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 10)
    require(not runtime.command([*query, *format_ids], runtime.SAFE_ENV, 10), REFUSED)


def observe(initial, image, probe):
    name = container_name(initial, probe)
    plan_sha = initial['reviewedPlanSha256']
    args = ['docker', 'run', '--rm', '--pull=never', '--name', name,
            '--label', 'io.lash-her.replacement-arm=' + plan_sha, '--interactive', '--network', 'host',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '256m', '--pids-limit', '64', '--env', CREDENTIAL, '--entrypoint', 'node',
            image, 'ops/platform/frontend-image.mjs', '--observe-replacement-lock']
    try:
        result = subprocess.run(args, input=encoded(probe), capture_output=True,
                                env={**runtime.SAFE_ENV, CREDENTIAL: initial['credentials'][CREDENTIAL]},
                                timeout=25, check=True)
    finally:
        remove_container(name, plan_sha)
    raw = result.stdout
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


def broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read):
    broker = ReplacementArmBroker(initial, lambda value: print(encoded(value).decode(), flush=True),
                                  shared_lock_fd=fd, safety_write=safety_write, guard_read=health_read)
    try:
        broker.initialize_arm(source, plan, base_probe, directory)
        broker.send(0, 'LOCKED')
        while raw := sys.stdin.buffer.readline(MAXIMUM + 1):
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
        broker.abort()
        return 1


def supervise_replacement_arm(initial, source):
    require(sys.platform == 'linux' and os.geteuid() == 0, REFUSED)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, REFUSED)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        raw, plan, base_probe, image, directory = prepare(initial, source)
        initial = {**initial, '_guardLayout': LAYOUT, '_guardLockDescriptor': fd}
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
            os._exit(broker_child(initial, source, plan, base_probe, directory, fd, safety_write, health_read))
        os.close(safety_write)
        os.close(health_read)
        cancelled = threading.Event()
        armed_probe = None
        try:
            with ThreadPoolExecutor(max_workers=1) as worker:
                def arm(probe):
                    nonlocal armed_probe
                    probe_identity(probe, base_probe)
                    armed_probe = probe
                    return worker.submit(verify_and_retain, initial, plan, base_probe, image, directory, source, probe, cancelled)
                try:
                    committed = supervisor.watch_broker(child, safety_read, health_write, arm,
                                                        profiled_certification=True, async_arm=True)
                except BaseException:
                    cancelled.set()
                    raise
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
                require(supervisor._stop_profiled_certification_group(child), REFUSED)
                if armed_probe is not None:
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
