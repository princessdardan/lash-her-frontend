#!/usr/bin/env python3
"""Independent fail-closed lifetime guard for the fixed P2 broker.

Both processes retain the same actual flock open file description. A single
broker/guard death leaves a survivor that revokes mutations before final stop.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import stat
import sys
import subprocess
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import staging_admission
from p2_release_broker import Broker, PhysicalObserver, MAXIMUM, LOCK

require = migrate.demand


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


def stop_group(pid):
    # This guard is a subreaper. Reap adopted Docker CLI children as well as the
    # broker; no still-running worker may race the final container stop.
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
        time.sleep(0.02)


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


def fail_closed(initial, armed, source, *, group=None):
    result = {'status': 'P2_INDEPENDENT_GUARD_FAILED_CLOSED_REQUIRES_REVIEW', 'trafficAuthorized': None,
              'sqlReplayAuthorized': False, 'releaseAccepted': False, 'g2Accepted': False,
              'workerProcessesQuiesced': False, 'runtimeStopped': None, 'frontendAdmissionClosed': None}
    if group is not None:
        stop_group(group)
        result['workerProcessesQuiesced'] = True
    if armed is None:
        # Before the SQL-complete handshake, the broker could not start APIs.
        result.update(status='P2_GUARD_REFUSED_BEFORE_API_STAGE', runtimeStopAttempted=False)
        return result
    # These values were verified before forking. Mutable input loss is not a
    # reason to skip closure of an already-running release.
    selected = initial['candidate']
    observer = PhysicalObserver(selected, armed, source, initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'])
    try:
        observer.probe('fence')
        result['frontendAdmissionClosed'] = True
        result['trafficAuthorized'] = False
    except BaseException:
        pass
    snapshot = Path(initial['results']) / ('runtime-' + selected['releaseId']) / 'configuration'
    try:
        result.update(close_gateway(initial, selected, snapshot))
    except BaseException:
        result['gatewayAdmissionFileClosed'] = None
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
    try:
        migrate.suspend_runtime('staging', runtime.SAFE_ENV)
        result['runtimeStopped'] = True
    except BaseException:
        pass
    directory = Path(initial['results']) / ('p2-' + selected['releaseId'])
    if directory.is_dir():
        migrate.write_json(directory, 'p2-independent-guard-outcome.json', result)
    return result


def supervise(initial):
    require(os.geteuid() == 0 and sys.platform == 'linux' and initial.get('environment') == 'staging', 'P2_LINUX_ROOT_GUARD_REQUIRED')
    source = Path(__file__).resolve().parents[3]
    require(migrate.source_commit(initial.get('sourceCommit')) and str(source) == '/opt/lash-her/operators/' + initial['sourceCommit'],
            'P2_INSTALLED_GUARD_SOURCE_REQUIRED')
    selected, verified_jobs = migrate.make_plan(Path(initial['bundle']))
    require(selected == initial['candidate'] and migrate.file_hash(migrate.read_input(Path(initial['bundle']), 'release.candidate.json')) == initial.get('candidateSha256'),
            'P2_GUARD_CANDIDATE_BINDING_REFUSED')
    # Linux subreaper adoption prevents orphaned mutating Docker CLI workers
    # from surviving a killed broker and racing the final container inventory.
    require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'P2_GUARD_SUBREAPER_REQUIRED')
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, 'P2_GUARD_LOCK_REFUSED')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    safety_read, safety_write = os.pipe()
    health_read, health_write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(safety_read); os.close(health_write); os.setsid()
        broker, committed = None, False
        try:
            def emit(value):
                print(json.dumps(value, separators=(',', ':')), flush=True)
            broker = Broker(initial, emit, shared_lock_fd=fd, safety_write=safety_write, guard_read=health_read)
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
        result = migrate.read_input(Path(initial['results']) / ('p2-' + initial['candidate']['releaseId']), 'p2-release-outcome.json')
        require(migrate.file_hash(result) == committed and json.loads(result).get('status') == 'P2_STAGING_READY_FOR_CERTIFICATION',
                'P2_GUARD_TERMINAL_RECEIPT_REQUIRED')
    except BaseException:
        fail_closed(initial, armed, source, group=child)
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
