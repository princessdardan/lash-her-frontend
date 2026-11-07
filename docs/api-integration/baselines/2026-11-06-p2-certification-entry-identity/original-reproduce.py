import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root=Path(sys.argv[1]).resolve()
program=r'''
import hashlib,importlib,io,json,runpy,sys
from pathlib import Path
from unittest.mock import patch
root=Path(sys.argv[1]);mode=sys.argv[2];sys.path.insert(0,str(root/'ops/platform/host'))
import p2_release_supervisor as guard
import release,migrate,vercel,frontend_probe
report={'mode':mode,'hostOrProviderCalls':[]}
def forbidden(*args,**kwargs):
    report['hostOrProviderCalls'].append('forbidden-boundary')
    raise AssertionError('OWNED_ENTRY_CROSSED_SAFE_BOUNDARY')
release.command=forbidden;release.assert_host=forbidden;migrate.make_plan=forbidden;vercel.Client=forbidden;frontend_probe.verify=forbidden
guard.os.fork=forbidden
types={'.py','.mjs','.json','.yaml','.yml','.service','.timer','.sh','.guard'}
manifest={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'ops').rglob('*') if p.is_file() and p.suffix in types and '__pycache__' not in p.parts}
initial={'mode':'p2-bounded-certification','environment':'staging','certificationActionId':'owned-entry','sourceCommit':'e7ab752e604ba43bc5b6443a9197a56e2a6e0cad',
 'candidate':{'releaseId':'owned-release'},'sourceSha256':manifest,'sourceClosureSha256':hashlib.sha256(json.dumps(sorted(manifest.items()),separators=(',',':')).encode()).hexdigest(),
 'certificationPlan':{'mode':mode}}
actual=guard.supervise
def observe(value,**options):
    canonical=importlib.import_module('p2_certification_parent')
    cls=options['broker_type'];observer=options['observer_type'];callback=options['native_containment']
    report.update(brokerModule=cls.__module__,canonicalBrokerSame=cls is canonical.P2CertificationBroker,
      canonicalObserverSame=observer is canonical.P2CertificationPhysicalObserver,canonicalContainmentSame=callback is canonical.contain_certification_native,
      realEntryCallbackName=callback.__name__,sourceClosureVerified=True)
    if mode=='known-ack-recovery':
      from p2_known_ack_loss import P2KnownAckLossRecorder,digest,canonical as encode
      from p2_certification_fault import P2CertificationFaultStage
      from p2_release_scope import P2ReleaseScope
      # Deliberately invalid next fault policy. These exact source-class objects
      # have no live scope, and cannot reach I/O or issue any authority.
      broker=cls.__new__(cls);broker.scope=P2ReleaseScope.__new__(P2ReleaseScope)
      broker.fault_stage=P2CertificationFaultStage.__new__(P2CertificationFaultStage)
      broker.fault_stage.scope=broker.scope;broker.fault_stage.arm_called=False;broker.fault_stage.plan={'mode':'before-upstream'}
      broker.external_armed=True;broker.native_enable_attempted=False;broker.selected={'releaseId':'owned-release'}
      broker.initial={'certificationActionId':'owned-entry','nativePlan':{'planSha256':'a'*64,'commandWitnesses':[]},
        'certificationPlan':{'mode':mode,'knownAckRecovery':{'version':1,'recoveryActionId':'owned-recovery','intent':{},'intentSha256':digest(encode({}))}}}
      try:P2KnownAckLossRecorder(broker,'owned-recovery',{})
      except ValueError as error:report['knownRecorderCheckpoint']=str(error)
      else:raise AssertionError('INVALID_FAULT_POLICY_WAS_ACCEPTED')
    try:
      with patch.object(guard.os,'geteuid',return_value=1):actual(value,**options)
    except ValueError as error:
      report['dispatchCheckpoint']=str(error)
      raise
guard.supervise=observe
sys.stdin=io.TextIOWrapper(io.BytesIO((json.dumps(initial)+'\n').encode()))
sys.argv=[str(root/'ops/platform/host/p2_certification_parent.py'),'--supervisor']
try:runpy.run_path(sys.argv[0],run_name='__main__')
except SystemExit as error:report['entryExit']=error.code
print(json.dumps(report))
'''
results=[]
for mode in ('auth-preparation','browser-pending','direct-worker','native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery','contain-native'):
    child=subprocess.run([sys.executable,'-I','-B','-c',program,str(root),mode],capture_output=True,text=True,timeout=20,
      env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C','LC_ALL':'C'})
    if child.returncode!=0:raise AssertionError('SAFE_ENTRY_HARNESS_FAILED')
    result=json.loads(child.stdout)
    assert result['dispatchCheckpoint']=='P2_LINUX_ROOT_GUARD_REQUIRED' and result['hostOrProviderCalls']==[]
    assert child.stderr.strip()=='P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW'
    results.append(result)
print(json.dumps({'status':'P2_CERTIFICATION_ACTUAL_ENTRY_IDENTITY_REPRO','sourceCommit':'e7ab752e604ba43bc5b6443a9197a56e2a6e0cad','results':results},indent=2))
