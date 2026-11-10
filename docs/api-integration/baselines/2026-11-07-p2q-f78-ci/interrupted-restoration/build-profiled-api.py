"""Create the source fixture variant using its exact owned database setup."""
import hashlib
import json
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).resolve() / 'ops/platform/test-p2-known-ack-loss-local.mjs'
output = Path(sys.argv[2]).resolve()
base = source.read_text()
def replace(before, after):
    global base
    assert base.count(before) == 1
    base = base.replace(before, after)

base = re.sub(r"""from (['"])([.]/[^'"]+)\1""",
              lambda match: 'from '+json.dumps((source.parent/match[2]).resolve().as_uri()), base)
replace("'known_'+service+'_runtime'", "'lash_her_'+service+'_staging_runtime'")
replace("    const sourceCommit=nativeSourceCommit()", """    phase='owned-profiled-api-current';
    const {runProfiledApiRead}=await import('./profiled-api-read.mjs');
    return await runProfiledApiRead({setup,connect,operator,apis,postgresMajor,port,password,certificate,frontendMigrations:artifact.migrations.length});
    const sourceCommit=nativeSourceCommit()""")
replace(".catch(()=>{process.stderr.write(", ".catch(error=>{const code=error?.code??error?.message;process.stderr.write(")
replace("phase,providerTouched:false", "phase,code:typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,99}$/u.test(code)?code:null,kind:['AssertionError','Error','TypeError','SyntaxError'].includes(error?.name)?error.name:'Unknown',frames:[...(error?.stack??'').matchAll(/(profiled-api-read\\.mjs|database_current\\.mjs|operator-migration\\.ts|migration-lineage\\.ts):(\\d+):(\\d+)/gu)].slice(0,4).map(row=>row.slice(1)),providerTouched:false")
output.write_text(base)
print(json.dumps({'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                  'generatedSha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
