import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from p2_source_closure import REQUIRED, verify_source_closure, private_observer_program


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
