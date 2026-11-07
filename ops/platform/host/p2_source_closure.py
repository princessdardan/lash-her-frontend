"""Closed, continuously verified installed operator source and private probe copy."""
import hashlib
import json
import os
from pathlib import Path
import stat

TYPES = {'.py', '.mjs', '.json', '.yaml', '.yml', '.service', '.timer', '.sh', '.guard'}
REQUIRED = {
    'ops/platform/host/p2_source_closure.py', 'ops/platform/host/p2_release_supervisor.py',
    'ops/platform/host/p2_release_broker.py', 'ops/platform/host/p2_release_scope.py',
    'ops/platform/host/p2_certification_profile.py', 'ops/platform/host/migrate.py',
    'ops/platform/host/release.py', 'ops/platform/host/staging_admission.py',
    'ops/platform/host/frontend_gateway_observation.py', 'ops/platform/host/vercel.py',
    'ops/platform/compose.yaml', 'ops/platform/p2-frontend-live-probe.mjs',
}


PROFILED_CURRENT_REQUIRED = {
    'ops/platform/host/p2_profiled_current_scope.py', 'ops/platform/host/p2_profiled_current_parent.py',
    'ops/platform/host/p2_profiled_current_recovery.py', 'ops/platform/host/p2_profiled_current_frontend.py',
    'ops/platform/p2-profiled-current-probe.mjs', 'ops/platform/p2-recovery-current-probe.mjs',
    'ops/platform/p2-profiled-current-release.mjs', 'ops/platform/p2-profiled-current-transport.mjs',
    'ops/platform/p2-profiled-current-recovery.mjs', 'ops/platform/p2-profiled-current-recovery-transport.mjs',
    'ops/platform/p2-profiled-current-frontend-adapters.mjs',
    'ops/platform/host/current_databases.py', 'ops/platform/host/database_current.mjs',
}
PROFILED_CERTIFICATION_MODE = 'p2-bounded-certification-profiled-current'
PROFILED_INTERRUPTED_MODE = 'p2-profiled-known-ack-interrupted-restoration'
CERTIFICATION_OBSERVER = 'ops/platform/p2-certification-current-probe.mjs'
PROFILED_CERTIFICATION_REQUIRED = {'ops/platform/host/p2_certification_parent.py', 'ops/platform/p2-certification.mjs',
                                   CERTIFICATION_OBSERVER, 'ops/platform/p2-lifecycle-native.mjs',
                                   'ops/platform/qualification-target-profile.mjs',
                                   'ops/platform/qualification-target-profiles.json',
                                   'ops/platform/host/qualification_target_profile.py'}
PROFILED_INTERRUPTED_REQUIRED = {'ops/platform/host/p2_profiled_known_ack_restoration_parent.py',
                                 'ops/platform/host/p2_profiled_known_ack_runtime.py',
                                 'ops/platform/host/p2_known_ack_interrupted_restoration.py',
                                 'ops/platform/p2-known-ack-interrupted-restoration.mjs'}


def verify_source_closure(initial, root):
    return _verify_source_closure(initial, root, REQUIRED, 512, 41_000_000)


def verify_profiled_current_source_closure(initial, root):
    import migrate
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    if initial.get('mode') not in ('p2-profiled-current-release', 'p2-profiled-current-recovery',
                                  PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE):
        raise ValueError('PROFILED_CURRENT_FIXED_SOURCE_DISPATCH_REQUIRED')
    migrate.require_profile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, initial)
    required = REQUIRED | PROFILED_CURRENT_REQUIRED
    if initial['mode'] in (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE):
        required |= PROFILED_CERTIFICATION_REQUIRED
    if initial['mode'] == PROFILED_INTERRUPTED_MODE:
        required |= PROFILED_INTERRUPTED_REQUIRED
    if initial['mode'] == PROFILED_CERTIFICATION_MODE:
        scoped = {
            'export-cleanup': {'ops/platform/host/p2_scoped_export_cleanup.py', 'ops/platform/host/p2_interactive_ingress.py'},
            'mux-callback-recovery': {'ops/platform/host/p2_scoped_mux.py', 'ops/gateway/admission.mjs',
                                      'ops/gateway/assessment-attempt.mjs', 'ops/gateway/private-tls.mjs'},
            'lifecycle-persistence': {'ops/platform/host/p2_lifecycle_persistence_probe.py'},
            'interactive-browser': {'ops/platform/host/p2_interactive_window.py', 'ops/platform/host/p2_interactive_ingress.py',
                                    'ops/gateway/admission.mjs', 'ops/gateway/assessment-attempt.mjs',
                                    'ops/gateway/operations.mjs', 'ops/gateway/server.mjs',
                                    'ops/platform/p2-lifecycle-browser-recorder.mjs', 'ops/platform/p2-lifecycle-suspension-evidence.mjs',
                                    'ops/platform/p2-lifecycle-pending-probe.mjs', 'ops/platform/frontend-admission.mjs'},
        }.get(initial.get('certificationPlan', {}).get('mode'))
        if scoped is not None:
            required |= scoped | {'ops/platform/host/p2_day_two_workload.py'}
    return _verify_source_closure(initial, root, required, 544, 48_000_000)


def _verify_source_closure(initial, root, required, max_files, max_bytes):
    manifest = initial.get('sourceSha256')
    if not isinstance(manifest, dict) or not 1 <= len(manifest) <= max_files or not required.issubset(manifest):
        raise ValueError('P2_CLOSED_OPERATOR_SOURCE_REQUIRED')
    digest = hashlib.sha256(json.dumps(sorted(manifest.items()), separators=(',', ':')).encode()).hexdigest()
    if digest != initial.get('sourceClosureSha256'):
        raise ValueError('P2_SOURCE_CLOSURE_DIGEST_REQUIRED')
    installed = set()
    for path in (root / 'ops').rglob('*'):
        if path.is_symlink():
            raise ValueError('P2_SOURCE_SYMLINK_REFUSED')
        if path.is_file() and path.suffix in TYPES and '__pycache__' not in path.parts:
            installed.add(path.relative_to(root).as_posix())
    if installed != set(manifest):
        raise ValueError('P2_SOURCE_CLOSURE_INCOMPLETE')
    total = 0
    for name, expected in manifest.items():
        path = root / name
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or not 0 < info.st_size <= 2_000_000:
            raise ValueError('P2_SOURCE_PERMISSIONS_REFUSED')
        raw = path.read_bytes(); total += len(raw)
        if hashlib.sha256(raw).hexdigest() != expected or total > max_bytes:
            raise ValueError('P2_SOURCE_CONTENT_CHANGED')
    return digest


def private_observer_program(initial, directory):
    raw = initial['_guardObserverProgram']
    # Set by the fixed source supervisor after checking the closed manifest;
    # never selected from the private operator input packet.
    source_name = initial.get('_guardObserverSource', 'ops/platform/p2-frontend-live-probe.mjs')
    if source_name not in {'ops/platform/p2-frontend-live-probe.mjs', 'ops/platform/p2-recovery-current-probe.mjs',
                           CERTIFICATION_OBSERVER, 'ops/platform/p2-profiled-current-probe.mjs'}:
        raise ValueError('P2_FIXED_OBSERVER_SOURCE_REQUIRED')
    if initial.get('mode') in (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE) and source_name != CERTIFICATION_OBSERVER:
        raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
    if source_name == CERTIFICATION_OBSERVER:
        if initial.get('mode') not in ('p2-bounded-certification', PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE):
            raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
        if initial['mode'] in (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE):
            import migrate
            from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
            if type(initial.get('version')) is not int or initial['version'] != 2:
                raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
            migrate.require_profile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, initial)
    if source_name == 'ops/platform/p2-profiled-current-probe.mjs':
        import migrate
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        if initial.get('mode') not in ('p2-profiled-current-release', 'p2-profiled-current-recovery'):
            raise ValueError('PROFILED_CURRENT_FIXED_OBSERVER_REQUIRED')
        migrate.require_profile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, initial)
    expected = initial['sourceSha256'][source_name]
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('P2_OBSERVER_SOURCE_CHANGED')
    path = directory / 'p2-frontend-live-probe.mjs'
    if not directory.exists():
        directory.mkdir(mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or directory.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('P2_PRIVATE_OBSERVER_DIRECTORY_REFUSED')
    if not path.exists():
        # Public source only. The private parent prevents host traversal, while
        # 0444 lets the nonroot image read the single read-only bind mount.
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        try:
            remaining = raw
            while remaining:
                remaining = remaining[os.write(descriptor, remaining):]
            os.fchmod(descriptor, 0o444); os.fsync(descriptor)
        finally:
            os.close(descriptor)
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(parent)
        finally: os.close(parent)
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o777 != 0o444 or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('P2_PRIVATE_OBSERVER_CHANGED')
    return path
