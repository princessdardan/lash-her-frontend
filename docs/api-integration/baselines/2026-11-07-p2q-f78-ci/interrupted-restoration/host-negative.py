"""Focused refusal controls for the frozen C host composition."""
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
import sys

directory = Path(__file__).resolve().parent
base = directory / 'host-composed.py'
assert hashlib.sha256(base.read_bytes()).hexdigest() == '1b1bdbd37f61a03031579ce4523e4deb3245097abce42fb3133a026efc137d9c'
spec = importlib.util.spec_from_file_location('owned_profiled_host', base)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def replace(raw, before, after):
    assert raw.count(before) == 1
    return raw.replace(before, after)

def run(fault):
    raw = inspect.getsource(module.exercise)
    raw = replace(raw, "        if lease_closed:value.update(backendAbsent=True,migrationLockReleased=True,nonceLockReleased=True)",
        "        if lease_closed:value.update(backendAbsent=fault!='frontend-still-held',migrationLockReleased=True,nonceLockReleased=True)")
    raw = replace(raw, "            command('prepare-interrupted-restoration')",
        """            if fault=='changed-original-input':
                with (original['inputDirectory'] / 'gateway.json').open('ab') as stream:
                    stream.write(b' ')
            command('prepare-interrupted-restoration')
            if fault=='pending-newer-gateway':
                pending_initial={**initial,'recoveryActionId':'owned-pending-newer'}
                prior._remember(pending_initial,original['stoppedGateway'],'replacement-in-progress',
                    expectedCandidateSha256=initial['candidateSha256'])
            if fault=='restarted-old-service':
                b.model['course-api'][0]['RestartCount']+=1
            if fault=='still-running-old-service':
                b.model['course-api'][0]['State'].update(Running=True,Pid=7001)
""".rstrip())
    raw = replace(raw, "    finally:\n        if broker.observer:",
        """    except ValueError as error:
        assert not (broker.directory/host.TERMINAL).exists()
        assert not (fixture.cert/'p2-profiled-current-certification-outcome.json').exists()
        if fault!='frontend-still-held': assert not stages
        else: assert stages==list(release.STAGES)
        assert broker.committed.is_set() is False
        return {'case':fault,'refused':str(error),'upCommands':len(stages),'terminalWritten':False,
                'historicalTerminalWritten':False}
    finally:
        if broker.observer:""")
    namespace = dict(vars(module), fault=fault)
    exec(compile(raw, str(base)+'-owned-negative', 'exec'), namespace)
    original = module.exercise
    module.exercise = namespace['exercise']
    try:
        return module.run('original-stopped-one')
    finally:
        module.exercise = original

expectations = {
    'changed-original-input':'P2_PROFILED_INTERRUPTED_ORIGINAL_CONFIGURATION_CHANGED',
    'pending-newer-gateway':'PRIOR_GATEWAY_LATEST_STOP_LINEAGE_REQUIRED',
    'restarted-old-service':'P2_PROFILED_INTERRUPTED_RETAINED_PROCESS_CHANGED',
    'still-running-old-service':'P2_PROFILED_INTERRUPTED_SOURCE_RUNTIME_NOT_STOPPED',
    'frontend-still-held':'P2_PROFILED_CERTIFICATION_SESSION_CLOSE_REQUIRED',
}
cases = [run(case) for case in expectations]
for case in cases:
    assert case['refused'] == expectations[case['case']], case
print(json.dumps({'version':1,'status':'PROFILED_C_HOST_PROJECTED_REFUSALS_PASS',
    'dockerProjected':True,'sqlAndFrontendTransportProjected':True,'providerTouched':False,'cases':cases}))
