import sys,subprocess,json,io
from pathlib import Path
ROOT=Path('/Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-known-ack-interrupted-restoration')
sys.path.insert(0,str(ROOT/'ops/platform/host'))
SOURCE='ff564a6d0add74e368706d1c8616f1fbbef8e53c'
PATH='ops/platform/host/p2_known_ack_interrupted_restoration.py'
raw=subprocess.check_output(['git','show',SOURCE+':'+PATH],cwd=ROOT,text=True)
import threading,tempfile,types
from unittest.mock import patch,Mock
import p2_release_scope_test as fixture
import p2_release_broker as shared
import p2_release_supervisor as supervisor
ns={'__name__':'review_frozen_c','__file__':str(ROOT/PATH)};exec(compile(raw,str(ROOT/PATH),'exec'),ns)
f=fixture.P2ScopeTests();f.setUp()
try:
 with tempfile.TemporaryDirectory(prefix='c-frozen-abort-review-') as tmp:
  b=ns['InterruptedKnownAckRestorationBroker'].__new__(ns['InterruptedKnownAckRestorationBroker']);b.failed=threading.Event();b.released=threading.Event();b.outcome={};b.scope=f.scope;b.raw_scope=f.scope;b.guard_alive=False;b.safety_write=None;b.worker=None;b.selected={'releaseId':'owned-review'};b.observer=types.SimpleNamespace(probe=lambda _:None);b.directory=Path(tmp);b.initial={};b.source=Path(tmp);b.lock_fd=f.scope.descriptor;b.armed_probe={'version':1}
  native=Mock(return_value={'nativeDisabled':True,'nativeDisableAttempted':True});ns['contain_interrupted_native']=native
  with patch.object(shared.p2_prior_gateway,'capture_before_stop',side_effect=ValueError('OWNED_SOURCE_UNAVAILABLE')),patch.object(shared.migrate,'suspend_runtime') as stopped,patch.object(supervisor,'cleanup_recovery_current_containers') as cleanup:b.abort()
  print(json.dumps({'sourceCommit':SOURCE,'actualScopeRevoked':f.scope.revoked.is_set(),'runtimeStopAttempted':stopped.call_count,'nativeContainmentCalled':native.call_count,'readonlyNamespaceCleanupCalled':cleanup.call_count,'phase':'armed-before-worker','transports':'fence/runtime projected; actual owned scope/flock'}))
finally:f.tearDown()
