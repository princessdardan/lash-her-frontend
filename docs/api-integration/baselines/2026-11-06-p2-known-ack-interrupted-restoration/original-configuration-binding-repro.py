import ast,subprocess,json,sys
from pathlib import Path
ROOT=Path('/Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-known-ack-interrupted-restoration');sys.path.insert(0,str(ROOT/'ops/platform/host'))
import p2_known_ack_interrupted_restoration as c
from p2_known_ack_interrupted_restoration_test import RetainedChainTests
SOURCE='269a7d3b5f07f6b6925dd787b4234b037e1f70f2'
text=subprocess.check_output(['git','show',SOURCE+':ops/platform/host/p2_known_ack_interrupted_restoration.py'],cwd=ROOT,text=True)
function=next(node for node in ast.parse(text).body if isinstance(node,ast.FunctionDef) and node.name=='load_retained');namespace=dict(vars(c));exec(compile(ast.Module(body=[function],type_ignores=[]),str(ROOT/'ops/platform/host/p2_known_ack_interrupted_restoration.py'),'exec'),namespace)
f=RetainedChainTests('test_complete_source_chain_keeps_one_without_issuing_a_capability');f.setUp();namespace['ROOT']=c.ROOT;namespace['OPERATORS']=c.OPERATORS
try:
 original_map=dict(f.initial['configurationSha256']);original_digest=c.sha(json.dumps(original_map,separators=(',',':'),ensure_ascii=False).encode())
 intent=f.values['recovery-intent.json'];intent['intent']['configurationSha256']=original_digest;intent['intentSha256']=c.sha(c.canonical(intent['intent']))
 f.selection['causalReceiptSha256']['recovery-intent.json']=f.write('recovery-intent.json',intent)
 auth=f.values['replacement-authorization.json'];auth['recoveryIntentSha256']=intent['intentSha256'];f.selection['causalReceiptSha256']['replacement-authorization.json']=f.write('replacement-authorization.json',auth)
 name='known-ack-replacement-intent.json';replacement=json.loads((f.replacement/name).read_text());replacement['authorization']=auth;replacement['recoveryIntent']=intent;raw=c.canonical(replacement)+b'\n';(f.replacement/name).write_bytes(raw);f.selection['replacementReceiptSha256'][name]=c.sha(raw)
 p=f.f.configuration/'course-api.env';p.write_bytes(p.read_bytes()+b'\nOWNED_ALLOWED_CONFIG_DRIFT=1\n');f.initial['configurationSha256']=c.staging_state.configuration_hashes(f.f.configuration)
 result=namespace['load_retained'](f.initial,f.selected,f.jobs,lambda:None)
 print(json.dumps({'sourceCommit':SOURCE,'status':'ORIGINAL_CONFIG_DIGEST_MISMATCH_ACCEPTED_BY_LOADER','originalIntentDigestRemains':result['values']['recovery-intent.json']['intent']['configurationSha256']==original_digest,'freshMapDiffers':f.initial['configurationSha256']!=original_map,'authorityIssued':False,'scope':'actual frozen loader; source-chain and stopped-gateway transport projected; no runtime transition attempted'}))
finally:f.doCleanups()
