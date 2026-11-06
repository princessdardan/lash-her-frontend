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
import p2_prior_gateway
from p2_release_broker import Broker, PhysicalObserver, MAXIMUM, LOCK
from p2_source_closure import verify_source_closure, private_observer_program

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


def fixed_layout(initial):
    # _guardLayout is replaced by supervise from fixed source arguments before
    # forking. Private input cannot select a program, class or receipt path.
    return initial.get('_guardLayout', DEFAULT_LAYOUT)


def action_id(initial):
    key = fixed_layout(initial)['actionIdKey']
    value = initial['candidate']['releaseId'] if key == 'releaseId' else initial.get(key)
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value), 'P2_GUARD_ACTION_ID_REQUIRED')
    return value


def cleanup_recovery_current_containers():
    # Only the recovery helper's fixed read-only container names. Matching IDs
    # are read from Docker, never supplied by an operator packet.
    pattern = '^/lash-p2-recovery-current-(course|community)-[a-f0-9]{32}$'
    query = ['docker', 'container', 'ls', '--all', '--filter', 'name=' + pattern, '--format', '{{.ID}}']
    for identity in runtime.command(query, runtime.SAFE_ENV, 15).splitlines():
        require(re.fullmatch(r'[a-f0-9]{12,64}', identity), 'P2_GUARD_RECOVERY_CONTAINER_ID_REFUSED')
        runtime.command(['docker', 'rm', '--force', identity], runtime.SAFE_ENV, 30)
    require(not runtime.command(query, runtime.SAFE_ENV, 15), 'P2_GUARD_RECOVERY_CONTAINER_REMAINS')


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


@contextlib.contextmanager
def sticky_cleanup_signals():
    previous = {item: signal.signal(item, signal.SIG_IGN) for item in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        yield
    finally:
        for item, handler in previous.items():
            signal.signal(item, handler)


def watch_broker(child, safety_read, health_write, arm):
    buffer, last_alive, committed, status = b'', time.monotonic(), None, None
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
                value = json.loads(raw)
                if value.get('operation') == 'alive':
                    last_alive = time.monotonic()
                elif value.get('operation') == 'armed':
                    arm(value['probe'])
                elif value.get('operation') == 'committed':
                    committed = value['sha256']
                else:
                    raise ValueError('P2_BROKER_ABORTED')
        if status is None:
            pid, observed_status = os.waitpid(child, os.WNOHANG)
            if pid:
                status = observed_status
        require(time.monotonic() - last_alive < 5, 'P2_BROKER_HEALTH_LOST')
        if status is None:
            os.write(health_write, b'H')
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
    verify_source_closure(initial,source)


def capture_gateway_before_stop(initial, selected, directory, source):
    return p2_prior_gateway.capture_before_stop(initial,selected,directory,lambda:verify_guard_boundary(initial,source))


def fail_closed(initial, armed, source, *, group=None, record_name='p2-independent-guard-outcome.json', observer_type=None,
                native_containment=None):
    result = {'status': 'P2_INDEPENDENT_GUARD_FAILED_CLOSED_REQUIRES_REVIEW', 'trafficAuthorized': None,
              'sqlReplayAuthorized': False, 'releaseAccepted': False, 'g2Accepted': False,
              'workerProcessesQuiesced': False, 'runtimeStopped': None, 'frontendAdmissionClosed': None}
    if group is not None:
        try:
            result['workerProcessesQuiesced'] = stop_group(group)
        except BaseException:
            result['workerProcessCleanupUncertain'] = True
    if armed is None:
        # Certification starts from an existing runtime but cannot issue any
        # mutator before its separate source-selected armed handshake.
        status = ('P2_GUARD_REFUSED_BEFORE_CERTIFICATION_STAGE' if fixed_layout(initial) == CERTIFICATION_LAYOUT
                  else 'P2_GUARD_REFUSED_BEFORE_ROTATION_STAGE' if fixed_layout(initial) == ROTATION_LAYOUT
                  else 'P2_GUARD_REFUSED_BEFORE_API_STAGE')
        result.update(status=status, runtimeStopAttempted=False)
        return result
    # These values were verified before forking. Mutable input loss is not a
    # reason to skip closure of an already-running release.
    selected = initial['candidate']
    layout, identity = fixed_layout(initial), action_id(initial)
    if layout == CERTIFICATION_LAYOUT:
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
        container = 'lash-migrate-' + name + '-' + selected['releaseId']
        try:
            query = ['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}']
            if runtime.command(query, runtime.SAFE_ENV, 15):
                runtime.command(['docker', 'rm', '--force', container], runtime.SAFE_ENV, 30)
            require(not runtime.command(query, runtime.SAFE_ENV, 15), 'P2_GUARD_MIGRATION_CONTAINER_REMAINS')
        except BaseException:
            result['migrationContainerCleanupUncertain'] = True
    if layout in (RECOVERY_LAYOUT, CERTIFICATION_LAYOUT):
        try:
            cleanup_recovery_current_containers()
        except BaseException:
            result['recoveryCurrentContainerCleanupUncertain'] = True
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
            stopped = p2_prior_gateway.retain_ordered_stop(prior,gateway_directory,lambda:verify_guard_boundary(initial,source))
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


def finish_failure_cleanup(initial, armed, source, child, *, observer_type=None, native_containment=None):
    failed = fail_closed(initial, armed, source, group=child, observer_type=observer_type, native_containment=native_containment)
    if armed is not None and not failed['workerProcessesQuiesced']:
        # Admissions have already been closed/stopped as far as can be
        # observed. Keep the actual flock while an unreaped mutator survives.
        while not stop_group(child):
            time.sleep(1)
        failed = fail_closed(initial, armed, source, group=child,
                             record_name='p2-independent-guard-after-quiescence.json', observer_type=observer_type,
                             native_containment=native_containment)
    return failed


def supervise(initial, *, broker_type=Broker, observer_type=PhysicalObserver,
              observer_source='ops/platform/p2-frontend-live-probe.mjs', layout=None, native_containment=None):
    layout = dict(DEFAULT_LAYOUT if layout is None else layout)
    require(issubclass(broker_type, Broker) and issubclass(observer_type, PhysicalObserver), 'P2_FIXED_SOURCE_TYPES_REQUIRED')
    rotation_types = None
    if layout == ROTATION_LAYOUT:
        from p2_identity_key_rotation_parent import P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver
        rotation_types = (P2IdentityRotationBroker, P2IdentityRotationPhysicalObserver)
    require((layout == DEFAULT_LAYOUT and broker_type is Broker and observer_type is PhysicalObserver
             and observer_source == 'ops/platform/p2-frontend-live-probe.mjs' and native_containment is None) or
            (layout == RECOVERY_LAYOUT and initial.get('mode') == 'p2-post-sql-recovery'
             and observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is None) or
            (layout == CERTIFICATION_LAYOUT and initial.get('mode') == 'p2-bounded-certification'
             and observer_source == 'ops/platform/p2-certification-current-probe.mjs' and callable(native_containment)) or
            (layout == ROTATION_LAYOUT and initial.get('mode') == 'p2-identity-key-rotation'
             and rotation_types == (broker_type, observer_type)
             and observer_source == 'ops/platform/p2-recovery-current-probe.mjs' and native_containment is None),
            'P2_FIXED_SOURCE_DISPATCH_REQUIRED')
    initial['_guardLayout'], initial['_guardObserverSource'] = layout, observer_source
    identity = action_id(initial)
    require(os.geteuid() == 0 and sys.platform == 'linux' and initial.get('environment') == 'staging', 'P2_LINUX_ROOT_GUARD_REQUIRED')
    source = Path(__file__).resolve().parents[3]
    require(migrate.source_commit(initial.get('sourceCommit')) and str(source) == '/opt/lash-her/operators/' + initial['sourceCommit'],
            'P2_INSTALLED_GUARD_SOURCE_REQUIRED')
    selected, verified_jobs = migrate.make_plan(Path(initial['bundle']))
    require(selected == initial['candidate'] and migrate.file_hash(migrate.read_input(Path(initial['bundle']), 'release.candidate.json')) == initial.get('candidateSha256'),
            'P2_GUARD_CANDIDATE_BINDING_REFUSED')
    verify_source_closure(initial, source)
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
                value = json.loads(raw)
                if value.get('operation') == 'check':
                    broker.command(value)
                else:
                    require(broker.operation_active.acquire(blocking=False), 'P2_CONCURRENT_STAGE_REFUSED')
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
            armed = probe
            require(probe['job'] == verified_jobs['frontend']['job']
                    and probe['baseline'] == json.loads(verified_jobs['frontend']['schema']), 'P2_SAFETY_SCOPE_REFUSED')
        committed = watch_broker(child, safety_read, health_write, arm)
        result = migrate.read_input(Path(initial['results']) / (layout['receiptPrefix'] + identity), layout['terminalName'])
        require(migrate.file_hash(result) == committed and json.loads(result).get('status') == layout['terminalStatus'],
                'P2_GUARD_TERMINAL_RECEIPT_REQUIRED')
    except BaseException:
        with sticky_cleanup_signals():
            finish_failure_cleanup(initial, armed, source, child, observer_type=observer_type, native_containment=native_containment)
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
