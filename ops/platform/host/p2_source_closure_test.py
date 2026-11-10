import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from p2_source_closure import REQUIRED, PROFILED_CURRENT_REQUIRED, verify_source_closure, verify_profiled_current_source_closure, private_observer_program
from p2_source_closure import CERTIFICATION_OBSERVER, PROFILED_CERTIFICATION_MODE, PROFILED_CERTIFICATION_REQUIRED
from p2_source_closure import PROFILED_REPLACEMENT_CERTIFICATION_REQUIRED, PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED


class SourceClosureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        for name in REQUIRED:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('owned ' + name).encode())
        self.manifest = {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in REQUIRED}
        self.initial = self.make(self.manifest)

    def tearDown(self): self.temp.cleanup()

    def make(self, manifest):
        return {'sourceSha256': manifest, 'sourceClosureSha256': hashlib.sha256(json.dumps(sorted(manifest.items()), separators=(',', ':')).encode()).hexdigest()}

    def test_closed_manifest_rejects_empty_partial_and_omitted_altered_dependency(self):
        self.assertEqual(verify_source_closure(self.initial, self.root), self.initial['sourceClosureSha256'])
        with self.assertRaises(ValueError): verify_source_closure(self.make({}), self.root)
        partial = dict(self.manifest); partial.pop('ops/platform/host/release.py')
        with self.assertRaises(ValueError): verify_source_closure(self.make(partial), self.root)
        extra = self.root / 'ops/platform/host/omitted.py'; extra.write_text('changed code')
        with self.assertRaisesRegex(ValueError, 'CLOSURE_INCOMPLETE'): verify_source_closure(self.initial, self.root)

    def test_continuous_source_check_refuses_change_after_initial_qualification(self):
        verify_source_closure(self.initial, self.root)
        (self.root / 'ops/platform/host/migrate.py').write_text('unreviewed')
        with self.assertRaisesRegex(ValueError, 'CONTENT_CHANGED'): verify_source_closure(self.initial, self.root)

    def test_certification_source_file_bound_is_finite_and_keeps_complete_coverage(self):
        manifest = dict(self.manifest)
        while len(manifest) < 512:
            name = f'ops/platform/harness/owned-count-{len(manifest)}.mjs'
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned bounded source')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        selected = self.make(manifest)
        self.assertEqual(verify_source_closure(selected, self.root), selected['sourceClosureSha256'])
        name = 'ops/platform/harness/owned-count-overflow.mjs'
        (self.root / name).write_bytes(b'owned bounded source')
        manifest[name] = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            verify_source_closure(self.make(manifest), self.root)

    def test_fixed_profiled_source_bound_and_unmanifested_test_refusal(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        manifest = dict(self.manifest)
        names = sorted(PROFILED_CURRENT_REQUIRED - set(manifest))
        names += [f'ops/platform/harness/profiled-{index}.mjs' for index in range(544-len(manifest)-len(names))]
        for name in names:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned profiled source')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        selected = {**self.make(manifest), 'mode': 'p2-profiled-current-release',
                    'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)}
        self.assertEqual(len(manifest), 544)
        self.assertEqual(verify_profiled_current_source_closure(selected, self.root), selected['sourceClosureSha256'])
        with self.assertRaises(ValueError):
            verify_source_closure(selected, self.root)
        injected = 'ops/platform/harness/unmanifested.test.mjs'
        (self.root / injected).write_bytes(b'unreviewed')
        with self.assertRaisesRegex(ValueError, 'CLOSURE_INCOMPLETE'):
            verify_profiled_current_source_closure(selected, self.root)
        manifest[injected] = hashlib.sha256((self.root / injected).read_bytes()).hexdigest()
        oversized = {**selected, **self.make(manifest)}
        with self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
            verify_profiled_current_source_closure(oversized, self.root)

    def test_guard_observer_uses_exact_cached_source_when_original_is_lost(self):
        raw = (self.root / 'ops/platform/p2-frontend-live-probe.mjs').read_bytes()
        self.initial['_guardObserverProgram'] = raw
        private = self.root / 'private'; private.mkdir(mode=0o700)
        program = private_observer_program(self.initial, private / 'source')
        (self.root / 'ops/platform/p2-frontend-live-probe.mjs').unlink()
        self.assertEqual(program.read_bytes(), raw)
        self.assertEqual(program.stat().st_mode & 0o777, 0o444)
        program.chmod(0o600); program.write_text('different')
        with self.assertRaises(ValueError): private_observer_program(self.initial, private / 'source')

    def test_replacement_certification_requires_original_release_verifiers(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        manifest = dict(self.manifest)
        for name in PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED:
            if name in manifest:
                continue
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned profiled certification source')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        current = {**self.make(manifest), 'mode': PROFILED_CERTIFICATION_MODE,
                   'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
                   'certificationPlan': {'mode': 'contain-native'}}
        self.assertEqual(verify_profiled_current_source_closure(current, self.root), current['sourceClosureSha256'])
        replacement = {**current, 'certificationPlan': {**current['certificationPlan'], 'replacementRelease': {}}}
        with self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
            verify_profiled_current_source_closure(replacement, self.root)
        for name in (PROFILED_REPLACEMENT_CERTIFICATION_REQUIRED | PROFILED_REPLACEMENT_KNOWN_ACK_REQUIRED) - manifest.keys():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned successor certification source')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        replacement.update(self.make(manifest))
        self.assertEqual(verify_profiled_current_source_closure(replacement, self.root), replacement['sourceClosureSha256'])
        successor = {**replacement, 'certificationPlan': {**replacement['certificationPlan'], 'successorRuntime': {}}}
        with self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
            verify_profiled_current_source_closure(successor, self.root)

    def test_profiled_mux_gateway_closure_requires_shared_request_parsers(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        manifest = dict(self.manifest)
        parsers = ('ops/gateway/assessment-attempt.mjs', 'ops/gateway/lesson-resume-position.mjs')
        required = PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED | {
            'ops/platform/host/p2_scoped_mux.py', 'ops/platform/host/p2_day_two_workload.py',
            'ops/gateway/admission.mjs', 'ops/gateway/private-tls.mjs',
        }
        for name in required - set(manifest):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned scoped gateway source')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        selected = {
            'mode': PROFILED_CERTIFICATION_MODE,
            'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
            'certificationPlan': {'mode': 'mux-callback-recovery'},
        }
        for parser in parsers:
            with self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
                verify_profiled_current_source_closure({**selected, **self.make(manifest)}, self.root)
            path = self.root / parser
            path.write_bytes(b'owned shared parser')
            manifest[parser] = hashlib.sha256(path.read_bytes()).hexdigest()
        plan = {**selected, **self.make(manifest)}
        self.assertEqual(verify_profiled_current_source_closure(plan, self.root), plan['sourceClosureSha256'])

    def test_stalled_renewal_source_closure_requires_ingress_workload_and_fence_transport(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        manifest = dict(self.manifest)
        required = PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED | {
            'ops/platform/host/p2_interactive_window.py', 'ops/platform/host/p2_interactive_ingress.py',
            'ops/platform/host/p2_day_two_workload.py', 'ops/gateway/admission.mjs',
            'ops/gateway/assessment-attempt.mjs', 'ops/gateway/lesson-resume-position.mjs',
            'ops/gateway/operations.mjs', 'ops/gateway/server.mjs', 'ops/platform/p2-lifecycle-browser-recorder.mjs',
            'ops/platform/p2-lifecycle-suspension-evidence.mjs', 'ops/platform/p2-lifecycle-pending-probe.mjs',
            'ops/platform/frontend-admission.mjs', 'ops/platform/p2-certification-transport.mjs',
        }
        for name in required - set(manifest):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned source for the stalled renewal scope')
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        selected = {'mode': PROFILED_CERTIFICATION_MODE,
                    'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
                    'certificationPlan': {'mode': 'interactive-browser', 'scopedAction': {'stage': 'stalled-playback-renewal'}}}
        plan = {**selected, **self.make(manifest)}
        self.assertEqual(verify_profiled_current_source_closure(plan, self.root), plan['sourceClosureSha256'])
        for name in ('ops/platform/host/p2_interactive_ingress.py', 'ops/platform/host/p2_day_two_workload.py',
                     'ops/gateway/server.mjs', 'ops/platform/p2-certification-transport.mjs'):
            missing = {path: digest for path, digest in manifest.items() if path != name}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
                verify_profiled_current_source_closure({**selected, **self.make(missing)}, self.root)

    def test_profiled_certification_manifest_and_private_observer_bind_fixed_current_source(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        manifest = dict(self.manifest)
        for name in (PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED) - set(manifest):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('owned ' + name).encode())
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        selected = {**self.make(manifest), 'version': 2, 'mode': PROFILED_CERTIFICATION_MODE,
                    'qualificationTargetProfile': dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
                    '_guardObserverSource': CERTIFICATION_OBSERVER,
                    '_guardObserverProgram': (self.root / CERTIFICATION_OBSERVER).read_bytes()}
        self.assertEqual(verify_profiled_current_source_closure(selected, self.root), selected['sourceClosureSha256'])
        private = self.root / 'private'; private.mkdir(mode=0o700)
        program = private_observer_program(selected, private / 'source')
        self.assertEqual(program.read_bytes(), selected['_guardObserverProgram'])
        for mismatch in ({'version': 1}, {'mode': 'p2-profiled-current-release'}, {'qualificationTargetProfile': None},
                         {'_guardObserverSource': 'ops/platform/p2-profiled-current-probe.mjs'},
                         {'_guardObserverProgram': b'different source'}):
            with self.subTest(mismatch=tuple(mismatch)), self.assertRaises(ValueError):
                private_observer_program({**selected, **mismatch}, private / 'source')
        omitted = dict(manifest); omitted.pop('ops/platform/qualification-target-profiles.json')
        with self.assertRaisesRegex(ValueError, 'CLOSED_OPERATOR_SOURCE_REQUIRED'):
            verify_profiled_current_source_closure({**selected, **self.make(omitted)}, self.root)

    def test_complete_installed_closure_accepts_41mb_and_refuses_one_extra_byte(self):
        manifest = dict(self.manifest)
        remaining = 41_000_000 - sum((self.root / name).stat().st_size for name in manifest)
        index = 0
        while remaining:
            name = f'ops/platform/harness/owned-bytes-{index}.mjs'
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            size = min(remaining, 2_000_000)
            path.write_bytes(b'x' * size)
            manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            remaining -= size
            index += 1
        selected = self.make(manifest)
        self.assertEqual(verify_source_closure(selected, self.root), selected['sourceClosureSha256'])
        path.write_bytes(path.read_bytes() + b'x')
        manifest[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'CONTENT_CHANGED'):
            verify_source_closure(self.make(manifest), self.root)

    def test_fixed_recovery_observer_uses_its_own_exact_cached_source(self):
        raw = b'owned recovery observer'
        source = 'ops/platform/p2-recovery-current-probe.mjs'
        self.initial['sourceSha256'][source] = hashlib.sha256(raw).hexdigest()
        self.initial['_guardObserverSource'] = source
        self.initial['_guardObserverProgram'] = raw
        private = self.root / 'recovery-private'; private.mkdir(mode=0o700)
        self.assertEqual(private_observer_program(self.initial, private / 'source').read_bytes(), raw)
        self.initial['_guardObserverSource'] = 'ops/platform/operator-supplied.mjs'
        with self.assertRaisesRegex(ValueError, 'FIXED_OBSERVER_SOURCE_REQUIRED'):
            private_observer_program(self.initial, private / 'other')

    def test_fixed_certification_observer_requires_its_exact_mode_and_cached_bytes(self):
        raw = b'owned certification observer'
        source = 'ops/platform/p2-certification-current-probe.mjs'
        self.initial['sourceSha256'][source] = hashlib.sha256(raw).hexdigest()
        self.initial['_guardObserverSource'] = source
        self.initial['_guardObserverProgram'] = raw
        private = self.root / 'certification-private'; private.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'FIXED_CERTIFICATION_OBSERVER_REQUIRED'):
            private_observer_program(self.initial, private / 'refused')
        self.initial['mode'] = 'p2-bounded-certification'
        self.assertEqual(private_observer_program(self.initial, private / 'source').read_bytes(), raw)
        self.initial['_guardObserverProgram'] = b'changed observer'
        with self.assertRaisesRegex(ValueError, 'OBSERVER_SOURCE_CHANGED'):
            private_observer_program(self.initial, private / 'changed')
