#!/usr/bin/env python3
"""Independent fail-closed lifetime guard for the fixed P2 broker.

Both processes retain the same actual flock open file description. A single
broker/guard death leaves a survivor that revokes mutations before final stop.
"""
import ctypes
import contextlib
import fcntl
import json
import os
import re
from pathlib import Path
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
from p2_source_closure import CERTIFICATION_OBSERVER, PROFILED_CERTIFICATION_MODE

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
PROFILED_CERTIFICATION_ARM = 'p2-profiled-current-certification-guard-armed.json'
PROFILED_CERTIFICATION_ARM_READY = 'p2-profiled-current-certification-guard-ready.json'
PROFILED_CERTIFICATION_CONTAINMENT_NAMES = (
    '^/lash-p2-certification-observer-[a-f0-9]{32}$',
    '^/lash-p2-certification-api-check-(course|community)-[a-f0-9]{32}$',
    '^/lash-p2-profiled-certification-guard-close-[a-f0-9]{32}$',
    '^/lash-p2-profiled-certification-image-check-[a-f0-9]{32}$',
)


def _guard_profile(initial):
    # The supervisor replaces this layout from its fixed source argument.
    if fixed_layout(initial) not in (PROFILED_CURRENT_LAYOUT, PROFILED_CURRENT_RECOVERY_LAYOUT, PROFILED_CERTIFICATION_LAYOUT):
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


def _profiled_certification_arm_record(initial, probe):
    expected = _guard_profile(initial)
    plan = initial['certificationPlan']
    return {'version': 2, 'qualificationTargetProfile': expected, 'status': 'P2_PROFILED_CERTIFICATION_GUARD_ARMED',
            'environment': 'staging', 'originalReleaseId': initial['candidate']['releaseId'],
            'certificationActionId': action_id(initial), 'sourceCommit': initial['sourceCommit'],
            'candidateSha256': initial['candidateSha256'], 'targetSha256': initial['targetSha256'],
            'planSha256': plan['planSha256'], 'probeSha256': _canonical_sha(probe)}


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
    require(type(probe) is dict and set(probe) == {'version', 'qualificationTargetProfile', 'marker', 'backendPid',
            'backendStart', 'job', 'baseline', 'owner', 'producers', 'historicalLogins', 'plan', 'receipt'},
            'P2_PROFILED_CERTIFICATION_GUARD_PROBE_REQUIRED')
    plan, receipt, job = initial['certificationPlan'], probe['receipt'], job_info['job']
    migrate.require_profile(expected, probe, probe['job'], probe['job'].get('target'), probe['plan'], receipt, receipt.get('target'),
                            probe['historicalLogins'], probe['historicalLogins'].get('target'))
    inventory = initial['inventory']
    require(type(probe['version']) is int and probe['version'] == 2 and type(receipt.get('version')) is int and receipt['version'] == 2 and
            _canonical_sha(probe['job']) == _canonical_sha(job) and _canonical_sha(probe['plan']) == _canonical_sha(plan) and
            _canonical_sha(probe['baseline']) == _canonical_sha(decode_qualification_target_json(job_info['schema'], 'carrier')) and
            probe['owner'] == initial['owner'] and probe['producers'] == inventory['producers'] and
            probe['historicalLogins'] == inventory['historicalLogins'] and
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


def watch_broker(child, safety_read, health_write, arm, *, profiled_certification=False):
    buffer, last_alive, committed, status = b'', time.monotonic(), None, None
    armed = False
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
                    require(type(value) is dict and type(value.get('operation')) is str and
                            set(value) == keys.get(value['operation']), 'P2_PROFILED_CERTIFICATION_SAFETY_FRAME_REFUSED')
                else:
                    value = json.loads(raw)
                if value.get('operation') == 'alive':
                    last_alive = time.monotonic()
                elif value.get('operation') == 'armed':
                    arm(value['probe'])
                    armed = True
                elif value.get('operation') == 'committed':
                    if profiled_certification:
                        require(armed and committed is None and type(value['sha256']) is str and
                                re.fullmatch(r'[a-f0-9]{64}', value['sha256']), 'P2_PROFILED_CERTIFICATION_SAFETY_COMMIT_REFUSED')
                    committed = value['sha256']
                else:
                    raise ValueError('P2_BROKER_ABORTED')
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


def verify_guard_boundary(initial, source):
    # Source-selected inherited open file description, never an operator DTO.
    descriptor = initial.get('_guardLockDescriptor')
    require(type(descriptor) is int, 'P2_GUARD_BOUNDARY_LOCK_REQUIRED')
    opened, current = os.fstat(descriptor), os.lstat(LOCK)
    require(stat.S_ISREG(current.st_mode) and current.st_uid == 0 and not current.st_mode & 0o077 and
        (current.st_dev,current.st_ino) == (opened.st_dev,opened.st_ino), 'P2_GUARD_BOUNDARY_LOCK_CHANGED')
    fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
    _verify_guard_source(initial,source)


def capture_gateway_before_stop(initial, selected, directory, source):
    return p2_prior_gateway.capture_before_stop(initial,selected,directory,lambda:verify_guard_boundary(initial,source),
                                                **_profile_kwargs(initial))


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


def _stop_profiled_certification_runtime(initial, source, result, record_name):
    selected, configuration = initial['candidate'], Path(initial['configuration'])
    prior = None
    try:
        directory = _profiled_certification_directory(initial)
        if record_name == 'p2-independent-guard-after-quiescence.json':
            directory = directory / 'prior-gateway-after-quiescence'
            directory.mkdir(mode=0o700)
        prior = capture_gateway_before_stop(initial, selected, directory, source)
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
            require(staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
                    'P2_PROFILED_CERTIFICATION_GUARD_CONFIGURATION_CHANGED')
            result.update(close_gateway(initial, selected, configuration))
        except BaseException:
            result['gatewayAdmissionFileClosed'] = None
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
            stop = _stop_profiled_certification_group if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT else stop_group
            result['workerProcessesQuiesced'] = stop(group)
        except BaseException:
            result['workerProcessCleanupUncertain'] = True
    if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT:
        return _fail_profiled_certification(initial, armed, source, result, record_name, native_containment, frontend_containment)
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
    if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT:
        options['frontend_containment'] = frontend_containment
    failed = fail_closed(initial, armed, source, group=child, **options)
    if (armed is not None or _guard_profile(initial) is not None) and not failed['workerProcessesQuiesced']:
        # Admissions have already been closed/stopped as far as can be
        # observed. Keep the actual flock while an unreaped mutator survives.
        stop = _stop_profiled_certification_group if fixed_layout(initial) == PROFILED_CERTIFICATION_LAYOUT else stop_group
        while True:
            try:
                if stop(child):
                    break
            except BaseException:
                if fixed_layout(initial) != PROFILED_CERTIFICATION_LAYOUT:
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


def _require_profiled_certification_terminal(initial, raw, committed):
    from qualification_target_profile import decode_qualification_target_json
    expected = _guard_profile(initial)
    terminal = decode_qualification_target_json(raw, 'carrier')
    migrate.require_profile(expected, terminal)
    plan = initial['certificationPlan']
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
    return terminal


def supervise(initial, *, broker_type=Broker, observer_type=PhysicalObserver,
              observer_source='ops/platform/p2-frontend-live-probe.mjs', layout=None, native_containment=None,
              frontend_containment=None):
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
    else:
        require(frontend_containment is None, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
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
             and observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is None) or interrupted or profiled or profiled_certification,
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    initial['_guardLayout'], initial['_guardObserverSource'] = layout, observer_source
    expected = _guard_profile(initial)
    if expected is not None:
        require((profiled or profiled_certification) and initial.get('version') == 2,
                'PROFILED_CURRENT_FIXED_SOURCE_DISPATCH_REQUIRED')
        if profiled_certification:
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
            verified = certification_parent.prepare_profiled_current_certification_input(
                {key: initial[key] for key in certification_parent.PROFILED_INITIAL_FIELDS}, source)
            require(verified.get('status') == 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED' and
                    verified.get('executionEligible') is False and verified.get('planSha256') == initial['certificationPlan']['planSha256'],
                    'P2_PROFILED_CERTIFICATION_GUARD_INPUT_REQUIRED')
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
                    acquired = (broker.operation_active.acquire(timeout=2) if profiled or profiled_certification else
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
    try:
        def arm(probe):
            nonlocal armed
            require(armed is None, 'P2_SAFETY_REARM_REFUSED')
            if profiled_certification:
                verify_guard_boundary(initial, source)
                _validate_profiled_certification_arm(initial, probe, verified_jobs['frontend'])
                armed = probe
                _retain_profiled_certification_arm(initial, probe)
                return
            armed = probe
            require(probe['job'] == verified_jobs['frontend']['job']
                    and probe['baseline'] == json.loads(verified_jobs['frontend']['schema']), 'P2_SAFETY_SCOPE_REFUSED')
        committed = (watch_broker(child, safety_read, health_write, arm, profiled_certification=True)
                     if profiled_certification else watch_broker(child, safety_read, health_write, arm))
        result = migrate.read_input(Path(initial['results']) / (layout['receiptPrefix'] + identity), layout['terminalName'])
        if profiled_certification:
            require(not members(child), 'P2_PROFILED_CERTIFICATION_TERMINAL_CHILD_REMAINS')
            verify_guard_boundary(initial, source)
            require_profiled_certification_guard_arm(initial, armed)
            _profiled_certification_containers(remove=False)
            _require_profiled_certification_terminal(initial, result, committed)
            verify_guard_boundary(initial, source)
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
            if profiled_certification:
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
