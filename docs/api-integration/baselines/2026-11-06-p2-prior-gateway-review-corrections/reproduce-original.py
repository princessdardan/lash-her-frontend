"""Run final negative cases against exact frozen 843 helper, without editing it."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / 'ops/platform/host'))
import p2_prior_gateway_test as fixture

original = subprocess.check_output(['git', 'show', '843b00819b8fa08e2274d3066e6e856856f4fac2:ops/platform/host/p2_prior_gateway.py'], cwd=root)
assert hashlib.sha256(original).hexdigest() == '954e6d8002f58d6baf401a6c92ac5c2f343dcb4d965a7f952a2631058759aafb'
with tempfile.TemporaryDirectory(prefix='owned-original-prior-gateway-') as temporary:
    path = Path(temporary) / 'original_prior_gateway.py'
    path.write_bytes(original)
    spec = importlib.util.spec_from_file_location('owned_original_prior_gateway', path)
    original_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original_module)
    fixture.gate = original_module
    names = ['test_present_stopped_gateway_rejects_same_process_pending_refused_or_running_lineage',
             'test_noop_gateway_stage_cannot_mark_old_process_as_completed_replacement']
    suite = unittest.TestSuite(fixture.PriorGatewayTests(name) for name in names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
