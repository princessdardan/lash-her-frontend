import sys,subprocess,json,io
from pathlib import Path
ROOT=Path('/Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-known-ack-interrupted-restoration')
sys.path.insert(0,str(ROOT/'ops/platform/host'))
SOURCE='ff564a6d0add74e368706d1c8616f1fbbef8e53c'
PATH='ops/platform/host/p2_known_ack_interrupted_restoration.py'
raw=subprocess.check_output(['git','show',SOURCE+':'+PATH],cwd=ROOT,text=True)
import migrate
actual=migrate.demand;failures=[]
def traced(ok,code):
 if not ok:failures.append(code)
 return actual(ok,code)
migrate.demand=traced
sys.stdin=io.TextIOWrapper(io.BytesIO((json.dumps({'mode':'known-ack-interrupted-restoration','candidate':{'releaseId':'owned-original'},'recoveryActionId':'owned-new'})+'\n').encode()))
ns={'__name__':'__main__','__file__':str(ROOT/PATH)}
try:exec(compile(raw,str(ROOT/PATH),'exec'),ns)
except SystemExit as e:print(json.dumps({'sourceCommit':SOURCE,'isolatedPython':sys.flags.isolated,'exitCode':e.code,'guardRefusals':failures,'noHostOrChildPhaseReached':failures==['P2_FIXED_SOURCE_DISPATCH_REQUIRED']}))
