"""Conservative size model only; no runtime/release authority or external input."""
import ast
import json
from pathlib import Path

source=Path.cwd()/'ops/platform/test-p2-recovery-owned.py'
constants={}
for node in ast.parse(source.read_text()).body:
    if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('OWNED_CHILD_PHASES','OWNED_CHILD_ERROR_CODES','OWNED_NODE_GUARD_CODES','OWNED_NODE_SOURCE_FILES'):
        constants[node.targets[0].id]=eval(compile(ast.Expression(node.value),'<fixed-source>','eval'),{'frozenset':frozenset})
longest=lambda name:max(constants[name],key=len)
record={'status':'OWNED_P2_RECOVERY_NODE_DIAGNOSTIC','phase':longest('OWNED_CHILD_PHASES'),'stage':'composed-source-bridge','kind':'AssertionError','guardCode':longest('OWNED_NODE_GUARD_CODES'),'checkpoint':'runtime-physical-session','systemCode':'ERR_ASSERTION','frames':[{'source':'frontend-fixture','file':longest('OWNED_NODE_SOURCE_FILES'),'line':1000000,'column':100000}for _ in range(12)]}
reasons=('line-bound','json','schema','types','phase','stage','kind','guard','checkpoint','system-code','frames','frame-binding')
envelope={'version':1,'status':'OWNED_P2_RECOVERY_CHILD_DIAGNOSTIC','fixture':'forward','phase':longest('OWNED_CHILD_PHASES'),'nodeErrors':[record],'nodeRecordCounts':dict.fromkeys(('seen','accepted','rejected','retained','truncated'),1000000),'nodeRecordRejections':dict.fromkeys(reasons,1000000),'nodeEmission':{'status':'OWNED_P2_NODE_EMISSION_SUMMARY','attempted':1000,'emitted':1000,'projectionFailures':1000,'uncaughtMonitor':1000,'origin':'unhandledRejection'},'exitStatus':-2147483648,'signal':'SIGXFSZ','errorKind':'AssertionError','errorCode':longest('OWNED_CHILD_ERROR_CODES'),'frames':[{'source':'frontend-fixture','file':'a'*256,'line':99999999,'column':999999}for _ in range(12)],'stdoutBytes':4000000,'stderrBytes':4000000,'rawChildOutputRetained':False,'bridgeErrors':[]}
size=len(json.dumps(envelope,separators=(',',':')).encode())
assert size<8192
print(json.dumps({'status':'OWNED_CONSERVATIVE_LAST_RECORD_ENVELOPE_BOUND','maximumBytes':size,'limit':8192,'conservativeCounters':1000000,'recordCount':1,'sourceFrameCount':12,'sourceFramePathBytes':256,'nodeFrameCount':12,'byteBudgetCanRetainFinalRecord':True,'manualConservativeModel':True,'fixtureOnly':True}))
