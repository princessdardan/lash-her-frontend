#!/usr/bin/env python3
"""Fresh GET-only retained-deployment verification; no build/promotion mutation."""
import json
from pathlib import Path
import secrets
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parent))
import migrate
import vercel
import frontend_probe
import frontend_release_adapters
import p2_certification_profile
require=migrate.demand


def observe(client, selected, plan, original, private_directory, expected_writer, verify, probe_client=None):
    require(selected.get('environment')=='staging' and selected.get('contractPhase')=='p2' and
            selected.get('sources',{}).get('frontend',{}).get('commit')==plan.get('sourceCommit') and
            frontend_probe.valid_writer_admission_binding(expected_writer) and expected_writer['sourceCommit']==plan['sourceCommit'] and
            expected_writer['targetSha256']==plan['targetSha256'],'P2_RECOVERY_FRONTEND_SOURCE_BINDING_REQUIRED')
    profile=p2_certification_profile.require_profile(plan.get('certification'))
    identity=vercel._staged_identity(selected,original)
    private=frontend_probe._private_input(private_directory,identity)
    locked=frontend_release_adapters.LockedClient(client,verify)
    class Reads:
        def request(self,method,path,body=None):
            require(method=='GET' and body is None,'P2_RECOVERY_PROVIDER_MUTATION_REFUSED')
            return locked.request(method,path)
    reads=Reads()
    before=vercel.promotion_state(reads,identity['projectId'])
    intent=migrate.read_json(original,'frontend-promotion-started.json')
    job=before.get('aliasJob')
    require(before['productionDeploymentId']==identity['deploymentId'] and before['cronsEnabled'] is False and
            job is not None and job['jobStatus']=='succeeded' and job['type']=='promote' and job['toDeploymentId']==identity['deploymentId'] and
            type(intent.get('previousAliasRequestedAt')) is int and job['requestedAt']>intent['previousAliasRequestedAt'] and
            all(intent.get(key)==identity[key] for key in identity),'P2_RECOVERY_RETAINED_PROMOTION_REQUIRED')
    state=vercel.deployment_state(reads,identity['deploymentId'],identity['projectId'],identity['sourceCommit'],identity['releaseId'])
    require(state['readyState']=='READY','P2_RECOVERY_RETAINED_READY_REQUIRED')
    bypass=frontend_probe._automation_bypass(vercel._project(reads,identity['projectId']))
    challenge=secrets.token_hex(32)
    verify()
    result=(probe_client or frontend_probe.ProbeClient()).request(state['url'],private['secret'],bypass,challenge,mode='phase2')
    verify()
    require(type(result.get('version')) is int and result['version']==1 and result.get('status')=='FRONTEND_WORKLOAD_PROBE_PASS' and result.get('challenge')==challenge and
            all(result.get(key)==identity[key] for key in ('environment','projectId','sourceCommit')) and result.get('gatewayOrigin')==private['gatewayOrigin'] and
            result.get('contractPhase')=='p2' and result.get('checks')==['gateway-course-catalog-p2'] and
            frontend_probe.valid_feature_controls(result.get('featureControls')) and result['featureControls']==profile['featureControls'] and
            frontend_probe.valid_writer_admission_binding(result.get('writerAdmissionBinding')) and result['writerAdmissionBinding']==expected_writer and
            int(time.time()*1000)<private['expiresAt'] and vercel.promotion_state(reads,identity['projectId'])==before,'P2_RECOVERY_ACTUAL_FRONTEND_BINDING_REQUIRED')
    return {'version':1,'status':'P2_RECOVERY_FRONTEND_RUNTIME_VERIFIED',**identity,'featureControls':result['featureControls'],
            'writerAdmissionBinding':result['writerAdmissionBinding'],'frontendServerWorkloadReverified':True,'providerMutations':False,
            'nativeSchedulesEnabled':False,'trafficAuthorized':False}


def main():
    line=sys.stdin.buffer.readline(2_000_001);require(0<len(line)<=2_000_000 and line.endswith(b'\n'),'P2_RECOVERY_PRIVATE_INPUT_REFUSED')
    value=json.loads(line)
    sequence=0
    def verify():
        nonlocal sequence
        sequence+=1;print(json.dumps({'type':'checkpoint','id':sequence}),flush=True)
        answer=json.loads(sys.stdin.buffer.readline(4097))
        require(answer=={'type':'continue','id':sequence},'P2_RECOVERY_PARENT_GUARD_LOST')
    result=observe(vercel.Client(value['vercelToken']),value['candidate'],value['plan'],Path(value['originalDirectory'])/'vercel',
                   Path(value['privateConfigurationDirectory']),value['expectedWriterBinding'],verify)
    print(json.dumps({'type':'result','value':result}),flush=True)


if __name__=='__main__':
    try:main()
    except BaseException:
        print('P2_RECOVERY_FRONTEND_RECHECK_REFUSED',file=sys.stderr);raise SystemExit(1)
