"""Generate the exact owned FE source fixture with three host readbacks."""
import hashlib
import json
from pathlib import Path
import re
import sys

snapshot = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
source = snapshot / 'ops/platform/test-p2-certification-local.mjs'
base = source.read_text()
def replace(before, after):
    global base
    assert base.count(before) == 1
    base = base.replace(before, after)

base = re.sub(r"from '([.][.]/|[.]/)([^']+)'",
              lambda match: "from " + json.dumps((source.parent/(match[1]+match[2])).resolve().as_uri()), base)
for relative in ('frontend-admission.sql','p2-certification-current-probe.mjs'):
    replace("new URL('./"+relative+"',import.meta.url)", "new URL("+json.dumps((source.parent/relative).as_uri())+")")
projection = json.dumps({'python': str(output.parent/'physical-host-bridge.py'), 'source': str(snapshot)})
bridge = '\nconst hostProjection = '+projection+r''';
function actualHostRead(probe,operation,deps){
  const result=spawnSync('python3',['-B',hostProjection.python,hostProjection.source,process.execPath],
    {input:JSON.stringify({probe,operation,ownedCredential:deps.getUrl()}),encoding:'utf8',timeout:40000,
     env:{PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS}});
  if(result.status!==0){
    const diagnostic=JSON.parse(result.stderr);
    process.stderr.write(JSON.stringify(diagnostic)+'\n');
    throw new Error('OWNED_PHYSICAL_HOST_BRIDGE_FAILED');
  }
  return JSON.parse(result.stdout);
}
'''
replace("let phase='owned-preflight';","let phase='owned-preflight';"+bridge)
replace("    assert.equal((await observe('verify-schema')).witnessSha256,receipt.witnessSha256);",
'''    assert.equal((await observe('verify-schema')).witnessSha256,receipt.witnessSha256);
    phase='actual-profiled-interrupted-host-open';
    const physicalOpen=actualHostRead(probe,'verify-schema',deps);
    assert.equal(physicalOpen.status,'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED');
    assert.equal(physicalOpen.backendPid,probe.backendPid);
    assert.equal(physicalOpen.journalSha256,receipt.journalSha256);
    assert.equal(physicalOpen.witnessSha256,receipt.witnessSha256);
    assert.equal(physicalOpen.physicalClosed,false);
    const stillHeld=actualHostRead(probe,'verify-closed',deps);
    assert.equal(stillHeld.status,'P2_PROFILED_INTERRUPTED_OWNED_CLOSURE_REFUSED');
''')
replace("  assert.deepEqual(JSON.parse(child.stdout),late);",
'''  assert.deepEqual(JSON.parse(child.stdout),late);
  phase='actual-profiled-interrupted-host-closed';
  const hostClosed=actualHostRead(probe,'verify-closed',deps);
  assert.equal(hostClosed.status,'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED');
  assert.equal(hostClosed.backendPid,probe.backendPid);
  assert.equal(hostClosed.journalSha256,probe.receipt.journalSha256);
  assert.equal(hostClosed.witnessSha256,probe.receipt.witnessSha256);
  assert.equal(hostClosed.physicalClosed,true);
''')
replace("checks.push('actual-profiled-interrupted-fresh-locks-specific-settlement-and-independent-closure');",
'''checks.push('actual-profiled-interrupted-fresh-locks-specific-settlement-and-independent-closure');
    checks.push('actual-host-python-to-fixed-node-profiled-physical-open-still-held-refusal-and-closure');''')
replace("checkpoint:error?.checkpoint??null,providerTouched:false",
'''checkpoint:error?.checkpoint??null,bridgeRefusal:typeof error?.cause==='string'&&/^[A-Za-z][A-Za-z_]+: P2_[A-Z0-9_]+$/u.test(error.cause)?error.cause:null,providerTouched:false''')
output.write_text(base)
print(json.dumps({'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                  'generatedSha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
