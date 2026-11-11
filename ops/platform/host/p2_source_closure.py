"""Closed, continuously verified installed operator source and private probe copy."""
import hashlib
import json
import os
import re
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
PROFILED_REPLACEMENT_ARM_MODE = 'p2-profiled-frontend-replacement-arm'
PROFILED_REPLACEMENT_WRITE_MODE = 'p2-profiled-frontend-replacement-write'
ROTATION_MODE = 'p2-identity-key-rotation'
COMPACT_SOURCE_LIMITS = (544, 48_000_000)
ROTATION_REQUIRED = {
    'ops/platform/host/p2_identity_key_rotation.py',
    'ops/platform/host/p2_identity_key_rotation_parent.py',
    'ops/platform/host/p2_identity_key_rotation_adapter.py',
    'ops/platform/host/p2_identity_rotation_browser_scope.py',
    'ops/platform/host/p2_identity_rotation_replacement.py',
    'ops/platform/host/p2_identity_rotation_successor.py',
    'ops/platform/host/p2_replacement_operator_evidence.py',
    'ops/platform/host/p2_day_two_workload.py',
    'ops/platform/p2-identity-key-rotation.mjs',
    'ops/platform/p2-identity-key-rotation-browser-recorder.mjs',
    'ops/platform/p2-identity-key-rotation-replacement.mjs',
    'ops/platform/p2-identity-key-rotation-session-closed.mjs',
    'ops/platform/p2-identity-negative-probe.mjs',
    'ops/platform/p2-certification-current-probe.mjs',
    'ops/platform/p2-recovery-current-probe.mjs',
    'ops/platform/p2-recovery-api-current-probe.mjs',
}
MANAGED_REPLACEMENT_CATALOG = 'ops/platform/managed-neon-replacement-catalog.json'
MANAGED_REPLACEMENT_SOURCE_REQUIRED = {MANAGED_REPLACEMENT_CATALOG, 'ops/platform/frontend-managed-neon-catalog.mjs'}
PROFILED_REPLACEMENT_ARM_REQUIRED = {
    'ops/platform/host/p2_frontend_replacement_parent.py',
    'ops/platform/p2-frontend-replacement-arm.mjs',
    'ops/platform/p2-frontend-replacement-arm-transport.mjs',
    'ops/platform/p2-frontend-replacement-plan.mjs',
    'ops/platform/p2-frontend-replacement-probe.mjs',
    'ops/platform/qualification-target-profiles.json',
    'ops/platform/host/qualification_target_profile.py',
}
CERTIFICATION_OBSERVER = 'ops/platform/p2-certification-current-probe.mjs'
PROFILED_CERTIFICATION_REQUIRED = {'ops/platform/host/p2_certification_parent.py', 'ops/platform/p2-certification.mjs',
                                   CERTIFICATION_OBSERVER, 'ops/platform/p2-lifecycle-native.mjs',
                                   'ops/platform/p2-lesson-restore-prior.mjs',
                                   'ops/platform/qualification-target-profile.mjs',
                                   'ops/platform/qualification-target-profiles.json',
                                   'ops/platform/host/qualification_target_profile.py'}
PROFILED_INTERRUPTED_REQUIRED = {'ops/platform/host/p2_profiled_known_ack_restoration_parent.py',
                                 'ops/platform/host/p2_profiled_known_ack_runtime.py',
                                 'ops/platform/host/p2_known_ack_interrupted_restoration.py',
                                 'ops/platform/p2-known-ack-interrupted-restoration.mjs'}
PROFILED_REPLACEMENT_CERTIFICATION_REQUIRED = {
    'ops/gateway/p2-certification-fault.mjs',
    'ops/platform/p2-certification-replacement-release.mjs',
    'ops/platform/p2-frontend-replacement-release-review.mjs',
    'ops/platform/p2-frontend-replacement-closed.mjs',
    'ops/platform/p2-frontend-replacement-written.mjs',
    'ops/platform/host/p2_certification_fault.py',
    'ops/platform/host/p2_frontend_replacement_parent.py',
    'ops/platform/host/p2_replacement_runtime_review.py',
    'ops/platform/host/p2_replacement_runtime_containment.py',
    'ops/platform/host/p2_replacement_successor.py',
    'ops/platform/host/p2_replacement_terminal.py',
}
PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED = {
    'ops/platform/host/p2_known_ack_loss.py',
    'ops/platform/host/p2_profiled_known_ack_runtime.py',
    'ops/platform/p2-known-ack-loss-probe.mjs',
}


def read_managed_replacement_catalog(initial, root, expected_sha256):
    import migrate
    manifest = initial.get('sourceSha256')
    migrate.demand(type(manifest) is dict and MANAGED_REPLACEMENT_SOURCE_REQUIRED.issubset(manifest) and
                   all(type(manifest[key]) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{64}', manifest[key])
                       for key in MANAGED_REPLACEMENT_SOURCE_REQUIRED) and
                   manifest[MANAGED_REPLACEMENT_CATALOG] == expected_sha256,
                   'P2_MANAGED_REPLACEMENT_CATALOG_SOURCE_REQUIRED')
    raw = migrate.read_input(root, MANAGED_REPLACEMENT_CATALOG, 16_384)
    migrate.demand(migrate.file_hash(raw) == expected_sha256, 'P2_MANAGED_REPLACEMENT_CATALOG_SOURCE_CHANGED')
    return raw


def verify_source_closure(initial, root):
    return _verify_source_closure(initial, root, REQUIRED, 512, 41_000_000)


def verify_rotation_source_closure(initial, root):
    if initial.get('mode') != ROTATION_MODE:
        raise ValueError('P2_ROTATION_FIXED_SOURCE_DISPATCH_REQUIRED')
    return _verify_source_closure(initial, root, REQUIRED | ROTATION_REQUIRED, *COMPACT_SOURCE_LIMITS)


def verify_profiled_current_source_closure(initial, root):
    import migrate
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    if initial.get('mode') not in ('p2-profiled-current-release', 'p2-profiled-current-recovery',
                                  PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE,
                                  PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE):
        raise ValueError('PROFILED_CURRENT_FIXED_SOURCE_DISPATCH_REQUIRED')
    migrate.require_profile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, initial)
    required = REQUIRED | PROFILED_CURRENT_REQUIRED
    if initial['mode'] in (PROFILED_REPLACEMENT_ARM_MODE, PROFILED_REPLACEMENT_WRITE_MODE):
        required |= PROFILED_REPLACEMENT_ARM_REQUIRED
    if initial['mode'] == PROFILED_REPLACEMENT_WRITE_MODE:
        required |= {'ops/platform/p2-frontend-replacement-abort.mjs', 'ops/platform/p2-frontend-replacement-written.mjs',
                     'ops/platform/p2-frontend-replacement-closed.mjs',
                     'ops/platform/p2-frontend-replacement-release.mjs', 'ops/platform/p2-frontend-replacement-release-review.mjs',
                     'ops/platform/p2-frontend-replacement-write-transport.mjs',
                     'ops/platform/frontend-image.mjs', 'ops/platform/host/p2_replacement_runtime_review.py',
                     'ops/platform/host/p2_replacement_runtime_containment.py',
                     'ops/platform/host/p2_replacement_operator_evidence.py',
                     'ops/platform/host/p2_replacement_terminal.py'}
    if initial['mode'] in (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE):
        required |= PROFILED_CERTIFICATION_REQUIRED
    if initial['mode'] == PROFILED_INTERRUPTED_MODE:
        required |= PROFILED_INTERRUPTED_REQUIRED
        if 'replacementRelease' in initial.get('reviewedPlan', {}):
            required |= PROFILED_REPLACEMENT_CERTIFICATION_REQUIRED | PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED
    if initial['mode'] == PROFILED_CERTIFICATION_MODE:
        certification = initial.get('certificationPlan', {})
        if 'replacementRelease' in certification:
            required |= PROFILED_REPLACEMENT_CERTIFICATION_REQUIRED
            if certification.get('mode') == 'known-ack-recovery':
                required |= PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED
            if 'successorRuntime' in certification:
                required |= PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED | {
                    'ops/platform/p2-replacement-successor.mjs',
                    'ops/platform/host/p2_replacement_operator_evidence.py',
                }
            if 'rotationSuccessor' in certification:
                required |= ROTATION_REQUIRED | {
                    'ops/platform/p2-certification-rotation-successor.mjs',
                    'ops/platform/host/p2_certification_rotation_successor.py',
                    'ops/platform/host/p2_canonical_browser_origin.py',
                    'ops/platform/host/p2_prior_gateway.py',
                }
                if 'predecessorRuntime' in certification['rotationSuccessor']:
                    required |= PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED | {'ops/platform/p2-replacement-successor.mjs'}
        scoped = {
            'export-cleanup': {'ops/platform/host/p2_scoped_export_cleanup.py', 'ops/platform/host/p2_interactive_ingress.py'},
            'mux-callback-recovery': {'ops/platform/host/p2_scoped_mux.py', 'ops/gateway/admission.mjs',
                                      'ops/gateway/assessment-attempt.mjs', 'ops/gateway/lesson-resume-position.mjs',
                                      'ops/gateway/private-tls.mjs'},
            'mux-readiness': {'ops/platform/host/p2_scoped_mux_readiness.py', 'ops/platform/host/p2_scoped_mux.py',
                              'ops/platform/host/p2_scoped_mux_replacement.py', 'ops/platform/p2-certification-transport.mjs'},
            'mux-replacement-evidence': {'ops/platform/host/p2_scoped_mux_readiness.py', 'ops/platform/host/p2_scoped_mux.py',
                                         'ops/platform/host/p2_scoped_mux_replacement.py', 'ops/platform/p2-certification-transport.mjs'},
            'lifecycle-persistence': {'ops/platform/host/p2_lifecycle_persistence_probe.py'},
            'interactive-browser': {'ops/platform/host/p2_interactive_window.py', 'ops/platform/host/p2_interactive_ingress.py',
                                    'ops/gateway/admission.mjs', 'ops/gateway/assessment-attempt.mjs',
                                    'ops/gateway/lesson-resume-position.mjs',
                                    'ops/gateway/operations.mjs', 'ops/gateway/server.mjs',
                                    'ops/platform/p2-lifecycle-browser-recorder.mjs', 'ops/platform/p2-lifecycle-suspension-evidence.mjs',
                                    'ops/platform/p2-lifecycle-pending-probe.mjs', 'ops/platform/frontend-admission.mjs'},
        }.get(certification.get('mode'))
        if scoped is not None:
            required |= scoped | {'ops/platform/host/p2_day_two_workload.py'}
        if certification.get('mode') in ('auth-preparation', 'browser-pending', 'direct-worker'):
            required |= {'ops/platform/host/p2_day_two_workload.py', 'ops/platform/host/p2_canonical_browser_origin.py'}
        if certification.get('mode') == 'direct-worker':
            required.add('ops/platform/host/p2_lifecycle_worker_evidence.py')
        action = certification.get('scopedAction') or {}
        if certification.get('mode') == 'interactive-browser' and action.get('stage') == 'media' and \
                (action.get('mediaAction') or {}).get('operation') == 'upload-video-and-observe-callback':
            required |= {'ops/platform/host/p2_scoped_mux_replacement.py', 'ops/platform/host/p2_scoped_mux_readiness.py',
                         'ops/platform/host/p2_scoped_mux.py'}
        if certification.get('mode') == 'interactive-browser' and action.get('stage') == 'stalled-playback-renewal':
            required.add('ops/platform/p2-certification-transport.mjs')
    manifest = initial.get('sourceSha256')
    if type(manifest) is dict and MANAGED_REPLACEMENT_SOURCE_REQUIRED.intersection(manifest):
        required |= MANAGED_REPLACEMENT_SOURCE_REQUIRED
    return _verify_source_closure(initial, root, required, *COMPACT_SOURCE_LIMITS)


_replacement_source_fingerprints = None


def _verify_source_closure(initial, root, required, max_files, max_bytes):
    global _replacement_source_fingerprints
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
    # Recovery repeatedly verifies the same root-owned installation under the
    # host lock. Reuse hashes only while the kernel file identities match.
    cache_key = (root, digest) if (initial.get('mode') == PROFILED_REPLACEMENT_WRITE_MODE and
                                  initial.get('recoveryReviewSha256')) else None
    retained = _replacement_source_fingerprints
    previous = retained[1] if cache_key and retained and retained[0] == cache_key else {}
    fingerprints = {}
    total = 0
    for name, expected in manifest.items():
        path = root / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or not 0 < info.st_size <= 2_000_000:
            raise ValueError('P2_SOURCE_PERMISSIONS_REFUSED')
        total += info.st_size
        if total > max_bytes:
            raise ValueError('P2_SOURCE_CONTENT_CHANGED')
        fingerprint = _source_file_fingerprint(info)
        if not cache_key or previous.get(name) != fingerprint:
            raw = path.read_bytes()
            if len(raw) != info.st_size or hashlib.sha256(raw).hexdigest() != expected or (
                    cache_key and _source_file_fingerprint(path.lstat()) != fingerprint):
                raise ValueError('P2_SOURCE_CONTENT_CHANGED')
        if cache_key:
            fingerprints[name] = fingerprint
    if cache_key:
        _replacement_source_fingerprints = (cache_key, fingerprints)
    return digest


def _source_file_fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def private_observer_program(initial, directory):
    raw = initial['_guardObserverProgram']
    # Set by the fixed source supervisor after checking the closed manifest;
    # never selected from the private operator input packet.
    source_name = initial.get('_guardObserverSource', 'ops/platform/p2-frontend-live-probe.mjs')
    if source_name not in {'ops/platform/p2-frontend-live-probe.mjs', 'ops/platform/p2-recovery-current-probe.mjs',
                           CERTIFICATION_OBSERVER, 'ops/platform/p2-profiled-current-probe.mjs'}:
        raise ValueError('P2_FIXED_OBSERVER_SOURCE_REQUIRED')
    mode = initial.get('mode')
    profiled = mode in (PROFILED_CERTIFICATION_MODE, PROFILED_INTERRUPTED_MODE)
    if mode == ROTATION_MODE and type(initial.get('version')) is int and initial['version'] == 2:
        from p2_release_supervisor import ROTATION_LAYOUT
        if initial.get('_guardLayout') != ROTATION_LAYOUT:
            raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
        profiled = True
    if profiled and source_name != CERTIFICATION_OBSERVER:
        raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
    if source_name == CERTIFICATION_OBSERVER:
        if mode != 'p2-bounded-certification' and not profiled:
            raise ValueError('P2_FIXED_CERTIFICATION_OBSERVER_REQUIRED')
        if profiled:
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
