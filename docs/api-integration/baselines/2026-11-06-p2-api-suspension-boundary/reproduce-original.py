"""Exact f1 source repro with source-valid candidate and real owned gateway stop."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root=Path(__file__).resolve().parents[4]
sys.dont_write_bytecode=True
base='f1aebc11f9a1cc4c84e8599fa4db1fca14c84d1c'
with tempfile.TemporaryDirectory(prefix='owned-original-api-suspension-')as directory:
    directory=Path(directory);hashes={}
    for name in ('migrate.py','p2_prior_gateway.py','p2_release_scope.py'):
        raw=subprocess.check_output(['git','show',base+':ops/platform/host/'+name],cwd=root)
        (directory/name).write_bytes(raw);hashes[name]=hashlib.sha256(raw).hexdigest()
    sys.path[:0]=[str(directory),str(root/'ops/platform/host')]
    import p2_prior_gateway_test as fixture
    case=fixture.PriorGatewayTests();case.setUp()
    try:
        bundle,results,_=case.normal_migration_fixture(prior_p1=True)
        assert case.initial['candidate']==case.selected
        try:case.normal_migrate(bundle,results)
        except ValueError as error:
            assert str(error)=='PRIOR_GATEWAY_STOPPED_PROOF_REQUIRED'
            assert case.stop_calls==1 and case.child.poll()is not None and case.migration_applies==[]
            assert (case.root/'original-frontend-database-receipt.json').read_bytes()==case.original_frontend_bytes
            print(json.dumps({'status':'EXACT_F1_NORMAL_API_STOP_BLOCKER_REPRODUCED','baseCommit':base,
                'sourceSha256':hashes,'sourceValidCandidateContext':True,'priorGatewayReleaseId':'prior-p1','failureCode':str(error),'actualGatewayProcessStopped':True,
                'stopCalls':case.stop_calls,'apiApplies':case.migration_applies,'originalFrontendReceiptUnchanged':True,
                'frontendTerminalCreated':(results/case.selected['releaseId']/'frontend/job-outcome.json').exists(),'dockerMetadataProjected':True}))
        else:raise AssertionError('original source unexpectedly accepted suspension')
    finally:case.doCleanups();case.tearDown()
