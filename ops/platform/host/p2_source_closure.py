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


def verify_source_closure(initial, root):
    manifest = initial.get('sourceSha256')
    if not isinstance(manifest, dict) or not 1 <= len(manifest) <= 496 or not REQUIRED.issubset(manifest):
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
        if hashlib.sha256(raw).hexdigest() != expected or total > 41_000_000:
            raise ValueError('P2_SOURCE_CONTENT_CHANGED')
    return digest


def private_observer_program(initial, directory):
    raw = initial['_guardObserverProgram']
    # Set by the fixed source supervisor after checking the closed manifest;
    # never selected from the private operator input packet.
    source_name = initial.get('_guardObserverSource', 'ops/platform/p2-frontend-live-probe.mjs')
    if source_name not in {'ops/platform/p2-frontend-live-probe.mjs', 'ops/platform/p2-recovery-current-probe.mjs',
                           'ops/platform/p2-certification-current-probe.mjs'}:
        raise ValueError('P2_FIXED_OBSERVER_SOURCE_REQUIRED')
    if source_name == 'ops/platform/p2-certification-current-probe.mjs' and initial.get('mode') != 'p2-bounded-certification':
        raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
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
