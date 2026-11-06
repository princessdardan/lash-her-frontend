#!/usr/bin/env python3
"""Retained READY verification and one explicitly reviewed forward build."""
import json
from pathlib import Path
import re
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

FORWARD_ROOT_FILES=('p2-recovery-started.json','p2-recovery-current-database.json','p2-recovery-api-runtime.json',
                    'p2-recovery-forward-original.json','p2-recovery-forward-started.json','p2-recovery-forward-outcome.json')
FORWARD_VERCEL_FILES=('frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json',
                      'frontend-workload-outcome.json','frontend-promotion-started.json','frontend-promotion-outcome.json')
FORWARD_SCOPE_FIELDS={'version','mode','recoveryActionId','originalReleaseId','candidateSha256','sourceCommit','targetSha256',
                      'inventorySha256','configurationSha256','originalDirectory','directory','originalReceiptSha256'}


def _forward_documents(scope):
    original,directory=Path(scope['originalDirectory']),Path(scope['directory'])
    migrate.private_directory(original);migrate.private_directory(directory)
    require(original.resolve()!=directory.resolve(),'P2_FORWARD_DIRECTORIES_REQUIRED')
    for name,expected in scope['originalReceiptSha256'].items():
        require(re.fullmatch(r'(?:vercel/)?[a-z0-9][a-z0-9.-]{0,180}\.json',name),'P2_FORWARD_ORIGINAL_PATH_REFUSED')
        parent=original/'vercel' if name.startswith('vercel/') else original
        file=parent/name.split('/')[-1]
        if expected is None:require(not file.exists() and not file.is_symlink(),'P2_FORWARD_ORIGINAL_ABSENCE_CHANGED')
        else:require(re.fullmatch(r'[a-f0-9]{64}',expected) and migrate.file_hash(migrate.read_input(parent,file.name))==expected,'P2_FORWARD_ORIGINAL_RECEIPT_CHANGED')
    documents,hashes={},{}
    for name in FORWARD_ROOT_FILES+tuple('vercel/'+name for name in FORWARD_VERCEL_FILES):
        parent=directory/'vercel' if name.startswith('vercel/') else directory
        raw=migrate.read_input(parent,name.split('/')[-1]);value=json.loads(raw)
        require(isinstance(value,dict),'P2_FORWARD_RECEIPT_REFUSED')
        documents[name]=value;hashes[name]=migrate.file_hash(raw)
    return documents,hashes


def require_forward_scope(context,client,verify):
    """Read-only join of source-branded context, immutable receipts and GETs.

    Admission may already be deliberately reopened. This function never
    authorizes a mutation, extends a probe, or turns an uncertain POST into retry.
    """
    scope=context.get('forwardRecoveryScope');require(isinstance(scope,dict) and set(scope)==FORWARD_SCOPE_FIELDS,'P2_FORWARD_SOURCE_SCOPE_REQUIRED')
    selected=frontend_release_adapters.identity(context)
    require(scope['version']==1 and scope['mode']=='reviewed-new-build' and
        re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',scope['recoveryActionId']) and scope['recoveryActionId']!=selected['actionId'] and
        scope['originalReleaseId']==selected['actionId'] and scope['sourceCommit']==selected['sourceCommit'] and scope['targetSha256']==selected['targetSha256'] and
        scope['directory']==context['directory'] and scope['originalDirectory']==context.get('originalDirectory') and
        all(re.fullmatch(r'[a-f0-9]{64}',scope[key]) for key in ('candidateSha256','inventorySha256','configurationSha256')) and
        isinstance(scope['originalReceiptSha256'],dict) and 3<=len(scope['originalReceiptSha256'])<=128,'P2_FORWARD_SOURCE_BINDING_REFUSED')
    documents,hashes=_forward_documents(scope)
    start,outcome,prior=(documents[name] for name in ('p2-recovery-forward-started.json','p2-recovery-forward-outcome.json','p2-recovery-forward-original.json'))
    def identity(value):
        return all(value.get(key)==scope[key] for key in ('recoveryActionId','originalReleaseId','candidateSha256','sourceCommit','targetSha256','inventorySha256','configurationSha256','originalReceiptSha256'))
    require(all(identity(value) for value in (start,outcome,prior)) and start.get('status')=='P2_RECOVERY_NEW_BUILD_INTENT' and
        outcome.get('status')=='P2_RECOVERY_NEW_BUILD_VERIFIED' and prior.get('status')=='P2_RECOVERY_FORWARD_ORIGINAL_RECONCILED' and
        start.get('reason') in ('prior-build-failed','prior-build-canceled','retained-ready-probe-expired') and
        outcome.get('reason')==prior.get('reason')==start['reason'],'P2_FORWARD_ROOT_CHAIN_REFUSED')
    current,api=documents['p2-recovery-current-database.json'],documents['p2-recovery-api-runtime.json']
    require(current.get('status')=='P2_RECOVERY_DATABASE_CURRENT' and current.get('migrationMode')=='recovery-current-only' and
        current.get('releaseId')==scope['originalReleaseId'] and current.get('sourceCommit')==scope['sourceCommit'] and current.get('candidateSha256')==scope['candidateSha256'] and
        current.get('recoveryActionId')==scope['recoveryActionId'] and current.get('sqlReplayed') is False and
        api.get('status')=='P2_RECOVERY_API_RUNTIME_READY' and api.get('candidateSha256')==scope['candidateSha256'] and api.get('recoveryActionId')==scope['recoveryActionId'] and
        api.get('sqlReplayed') is False and len(api.get('containers',[]))==10 and all(api.get('apiDatabases',{}).get(name,{}).get('status')=='P2_RECOVERY_API_DATABASE_CURRENT' for name in ('course','community')) and
        start.get('currentDatabaseReceiptSha256')==hashes['p2-recovery-current-database.json'] and start.get('apiRuntimeReceiptSha256')==hashes['p2-recovery-api-runtime.json'] and
        start.get('priorReconciliationReceiptSha256')==hashes['p2-recovery-forward-original.json'] and outcome.get('intentSha256')==hashes['p2-recovery-forward-started.json'],'P2_FORWARD_CURRENT_CHAIN_REFUSED')
    expected=frontend_release_adapters.compatible_writer_admission_binding(context)
    profile=p2_certification_profile.require_profile(context['plan'].get('certification'))
    require(start.get('expectedWriterAdmissionBinding')==expected and start.get('featureControls')==profile['featureControls'] and
        all(outcome.get('receiptSha256',{}).get('vercel/'+name)==hashes['vercel/'+name] for name in FORWARD_VERCEL_FILES),'P2_FORWARD_PROVIDER_HASH_CHAIN_REFUSED')
    attempt=Path(scope['directory'])/'vercel';original=Path(scope['originalDirectory'])/'vercel'
    staged=vercel._staged_identity(context['candidate'],attempt)
    require(staged['deploymentId']==outcome.get('deploymentId'),'P2_FORWARD_NEW_DEPLOYMENT_REQUIRED')
    workload=documents['vercel/frontend-workload-outcome.json']
    require(workload.get('status')=='FRONTEND_VERIFIED' and workload.get('deploymentId')==staged['deploymentId'] and
        workload.get('releaseId')==scope['originalReleaseId'] and workload.get('sourceCommit')==scope['sourceCommit'] and
        workload.get('contractPhase')=='p2' and workload.get('phase2ContractManifestSha256')==context['candidate'].get('phase2ContractManifestSha256') and
        workload.get('featureControls')==profile['featureControls'] and workload.get('writerAdmissionBinding')==expected,'P2_FORWARD_WORKLOAD_BINDING_REFUSED')
    verify()
    old=migrate.read_json(original,'frontend-build-created.json');old_state=vercel.deployment_state(client,old['deploymentId'],selected['projectId'],selected['sourceCommit'],selected['actionId'])
    required_state={'prior-build-failed':'ERROR','prior-build-canceled':'CANCELED','retained-ready-probe-expired':'READY'}[start['reason']]
    require(old_state['readyState']==required_state and prior.get('deploymentId')==old['deploymentId'],'P2_FORWARD_ORIGINAL_STATE_CHANGED')
    detail=client.request('GET',f'/v13/deployments/{staged["deploymentId"]}?withGitRepoInfo=true')
    require((detail.get('meta') or {}).get('lashRecoveryActionId')==scope['recoveryActionId'],'P2_FORWARD_NEW_ACTION_METADATA_REQUIRED')
    state=vercel.deployment_state(client,staged['deploymentId'],selected['projectId'],selected['sourceCommit'],selected['actionId'])
    promotion=vercel.promotion_state(client,selected['projectId']);intent=documents['vercel/frontend-promotion-started.json'];job=promotion.get('aliasJob')
    require(state['readyState']=='READY' and promotion['cronsEnabled'] is False and promotion['productionDeploymentId']==staged['deploymentId'] and
        job is not None and job['jobStatus']=='succeeded' and job['type']=='promote' and job['toDeploymentId']==staged['deploymentId'] and
        type(intent.get('previousAliasRequestedAt')) is int and job['requestedAt']>intent['previousAliasRequestedAt'] and
        documents['vercel/frontend-promotion-outcome.json'].get('status')=='FRONTEND_DOMAINS_PROMOTED','P2_FORWARD_ACTUAL_PROMOTION_REQUIRED')
    verify();return {**scope,'newReceiptSha256':hashes}


def _original_build(context):
    selected=frontend_release_adapters.identity(context);directory=Path(context['originalDirectory'])/'vercel'
    started,created,outcome=(migrate.read_json(directory,name) for name in ('frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json'))
    require(all(all(row.get(key)==value for key,value in {'environment':'staging','projectId':selected['projectId'],'sourceCommit':selected['sourceCommit'],'releaseId':selected['actionId']}.items()) for row in (started,created,outcome)) and
        all(created.get(key)==started.get(key) for key in started) and created.get('deploymentId')==outcome.get('deploymentId') and
        outcome.get('previousDeploymentId')==started.get('previousDeploymentId'),'P2_FORWARD_ORIGINAL_BUILD_CHAIN_REQUIRED')
    return selected,directory,started,created,outcome


def reconcile_forward(context,client,verify):
    selected,directory,started,created,outcome=_original_build(context);action=context['action'];reason=action['forwardReason']
    class Reads:
        def request(self,method,path,body=None):
            require(method=='GET' and body is None,'P2_FORWARD_GET_FIRST_REQUIRED');verify();value=client.request(method,path);verify();return value
    reads=Reads();state=vercel.deployment_state(reads,created['deploymentId'],selected['projectId'],selected['sourceCommit'],selected['actionId'])
    project=vercel.promotion_state(reads,selected['projectId']);job=project.get('aliasJob')
    require(project['cronsEnabled'] is False and (job is None or job['jobStatus'] in ('succeeded','failed','skipped')),'P2_FORWARD_SETTLED_ALIAS_REQUIRED')
    result={**action,'targetSha256':selected['targetSha256'],'status':'P2_RECOVERY_FORWARD_ORIGINAL_RECONCILED','reason':reason,
        'deploymentId':created['deploymentId'],'readyState':state['readyState'],'previousProductionDeploymentId':project['productionDeploymentId'],
        'previousAliasRequestedAt':0 if job is None else job['requestedAt'],'providerMutations':False,'trafficAuthorized':False}
    if reason in ('prior-build-failed','prior-build-canceled'):
        require(state['readyState']==('ERROR' if reason=='prior-build-failed' else 'CANCELED') and outcome.get('status')=='FRONTEND_BUILD_FAILED_REQUIRES_REVIEW' and
            outcome.get('phase')=='build' and project['productionDeploymentId']==started.get('previousDeploymentId') and
            not (directory/'frontend-promotion-started.json').exists(),'P2_FORWARD_CONCLUSIVE_FAILED_BUILD_REQUIRED')
    else:
        require(reason=='retained-ready-probe-expired' and state['readyState']=='READY' and outcome.get('status')=='FRONTEND_STAGED','P2_FORWARD_RETAINED_READY_REQUIRED')
        promotion=migrate.read_json(directory,'frontend-promotion-started.json');preparation=migrate.read_json(directory,'frontend-probe-preparation.json')
        require(project['productionDeploymentId']==created['deploymentId'] and job is not None and job['type']=='promote' and job['jobStatus']=='succeeded' and
            job['toDeploymentId']==created['deploymentId'] and type(promotion.get('previousAliasRequestedAt')) is int and job['requestedAt']>promotion['previousAliasRequestedAt'] and
            all(promotion.get(key)==value for key,value in {'environment':'staging','projectId':selected['projectId'],'sourceCommit':selected['sourceCommit'],'releaseId':selected['actionId'],'deploymentId':created['deploymentId']}.items()),'P2_FORWARD_RETAINED_ALIAS_REQUIRED')
        private_directory=Path(context['privateConfigurationDirectory']);frontend_probe._private_configuration(private_directory)
        private=json.loads(migrate.read_input(private_directory,frontend_probe.PRIVATE_FILE,8192))
        require(preparation.get('status')=='FRONTEND_PROBE_CONFIGURED' and type(preparation.get('expiresAt')) is int and
            private.get('expiresAt')==preparation['expiresAt']<=int(time.time()*1000) and
            all(private.get(key)==preparation.get(key)==value for key,value in {'environment':'staging','projectId':selected['projectId'],'sourceCommit':selected['sourceCommit'],'releaseId':selected['actionId']}.items()),'P2_FORWARD_ORIGINAL_PROBE_EXPIRY_REQUIRED')
        result['originalProbeExpiresAt']=preparation['expiresAt']
    require(vercel.promotion_state(reads,selected['projectId'])==project,'P2_FORWARD_ORIGINAL_STATE_DRIFT');return result


def build_forward(context,client,verify,probe_client=None):
    """One explicitly reviewed new build; every POST has an exclusive intent."""
    action=context['action'];directory=Path(context['directory']);attempt=directory/'vercel';private=Path(context['newPrivateConfigurationDirectory'])
    migrate.private_directory(directory);frontend_probe._private_configuration(private)
    old_private=Path(context['privateConfigurationDirectory']).resolve()
    require(private.resolve()!=old_private and old_private not in private.resolve().parents and private.resolve() not in old_private.parents and
        not any(private.iterdir()) and context.get('gatewayHost')==context['bindings'].get('gatewayHost') and isinstance(context.get('gatewayHost'),str) and
        re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+',context['gatewayHost']),'P2_FORWARD_NEW_PRIVATE_PROBE_REQUIRED')
    require(not attempt.exists(),'P2_FORWARD_NEW_ATTEMPT_REQUIRED');attempt.mkdir(mode=0o700)
    intent_raw=migrate.read_input(directory,'p2-recovery-forward-started.json');intent=json.loads(intent_raw)
    selected=frontend_release_adapters.identity(context)
    require(action.get('frontendMode')=='reviewed-new-build' and intent.get('status')=='P2_RECOVERY_NEW_BUILD_INTENT' and
        intent.get('reason')==action.get('forwardReason') and intent.get('targetSha256')==selected['targetSha256'] and
        all(intent.get(key)==action.get(key) for key in ('recoveryActionId','originalReleaseId','candidateSha256','sourceCommit','inventorySha256','configurationSha256','originalReceiptSha256')),'P2_FORWARD_EXCLUSIVE_INTENT_REQUIRED')
    prior=migrate.read_json(directory,'p2-recovery-forward-original.json')
    current_raw=migrate.read_input(directory,'p2-recovery-current-database.json');current=json.loads(current_raw)
    api_raw=migrate.read_input(directory,'p2-recovery-api-runtime.json');api=json.loads(api_raw)
    require(current.get('status')=='P2_RECOVERY_DATABASE_CURRENT' and current.get('migrationMode')=='recovery-current-only' and
        current.get('sqlReplayed') is False and current.get('candidateSha256')==action['candidateSha256'] and current.get('recoveryActionId')==action['recoveryActionId'] and
        current.get('sourceCommit')==selected['sourceCommit'] and current.get('releaseId')==selected['actionId'] and
        api.get('status')=='P2_RECOVERY_API_RUNTIME_READY' and api.get('sqlReplayed') is False and
        api.get('candidateSha256')==action['candidateSha256'] and api.get('recoveryActionId')==action['recoveryActionId'] and len(api.get('containers',[]))==10 and
        all(api.get('apiDatabases',{}).get(key,{}).get('status')=='P2_RECOVERY_API_DATABASE_CURRENT' for key in ('course','community')) and
        intent.get('currentDatabaseReceiptSha256')==migrate.file_hash(current_raw) and intent.get('apiRuntimeReceiptSha256')==migrate.file_hash(api_raw) and
        intent.get('priorReconciliationReceiptSha256')==migrate.file_hash(migrate.read_input(directory,'p2-recovery-forward-original.json')) and
        intent.get('expectedWriterAdmissionBinding')==frontend_release_adapters.compatible_writer_admission_binding(context) and
        intent.get('featureControls')==p2_certification_profile.require_profile(context['plan']['certification'])['featureControls'],'P2_FORWARD_CURRENT_INTENT_REQUIRED')
    require(reconcile_forward(context,client,verify)==prior,'P2_FORWARD_ORIGINAL_RECONCILIATION_CHANGED')
    outcome={**action,'targetSha256':selected['targetSha256'],'reason':action['forwardReason'],'status':'P2_RECOVERY_NEW_BUILD_REQUIRES_REVIEW',
        'intentSha256':migrate.file_hash(intent_raw),'deploymentId':None,'receiptSha256':{},'sqlReplayed':False,'trafficAuthorized':False,'phase':'configuration'}
    class Writes:
        ordinal=0
        def request(self,method,path,body=None):
            verify()
            if method!='GET':
                require(method=='POST' and (path==f'/v10/projects/{selected["projectId"]}/env?upsert=true' or path=='/v13/deployments' or
                    re.fullmatch(r'/v10/projects/'+re.escape(selected['projectId'])+r'/promote/dpl_[A-Za-z0-9]+',path)),'P2_FORWARD_MUTATION_REFUSED')
                self.ordinal+=1
                migrate.write_json(attempt,f'provider-post-{self.ordinal:03d}-started.json',{**action,'method':method,'path':path,
                    'environmentKey':body.get('key') if isinstance(body,dict) else None,'ordinal':self.ordinal,'trafficAuthorized':False})
                if path=='/v13/deployments':
                    require(isinstance(body,dict) and (body.get('meta') or {}).get('lashReleaseId')==selected['actionId'] and (body.get('gitSource') or {}).get('sha')==selected['sourceCommit'],'P2_FORWARD_SOURCE_BUILD_REQUIRED')
                    body={**body,'meta':{**body['meta'],'lashRecoveryActionId':action['recoveryActionId']}}
            value=client.request(method,path,body);verify();return value
    writes=Writes()
    try:
        frontend_release_adapters.compatible_writer_admission_binding(context);frontend_release_adapters.require_runtime_database_binding(context)
        raw=migrate.read_input(directory,'p2-recovery-current-database.json')
        frontend_release_adapters.write_source_pins(context,writes,attempt,migrate.file_hash(raw),'verified-current-recovery-database-readonly')
        frontend_release_adapters.configure_compatible_features(context,writes,attempt)
        frontend_probe.prepare(writes,context['candidate'],private,attempt,context['gatewayHost'],scheduler_qualification=False)
        outcome['phase']='build';vercel.stage_frontend(writes,context['candidate'],attempt)
        created=migrate.read_json(attempt,'frontend-build-created.json');outcome['deploymentId']=created['deploymentId']
        outcome['phase']='promotion'
        vercel.promote_frontend(writes,context['candidate'],attempt,lambda release,_state:frontend_probe.verify(writes,release,attempt,private,probe_client,
            expected_feature_controls=p2_certification_profile.require_profile(context['plan']['certification'])['featureControls'],
            expected_writer_admission_binding=frontend_release_adapters.compatible_writer_admission_binding(context)))
        detail=writes.request('GET',f'/v13/deployments/{created["deploymentId"]}?withGitRepoInfo=true')
        require((detail.get('meta') or {}).get('lashRecoveryActionId')==action['recoveryActionId'],'P2_FORWARD_NEW_ACTION_METADATA_REQUIRED')
        outcome.update(status='P2_RECOVERY_NEW_BUILD_VERIFIED',phase='completed')
        return outcome
    finally:
        if (attempt/'frontend-build-created.json').exists():outcome['deploymentId']=migrate.read_json(attempt,'frontend-build-created.json').get('deploymentId')
        for name in FORWARD_VERCEL_FILES:
            path=attempt/name
            if path.exists():outcome['receiptSha256']['vercel/'+name]=migrate.file_hash(migrate.read_input(attempt,name))
        migrate.write_json(directory,'p2-recovery-forward-outcome.json',outcome)


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
    operation=value.get('operation','observe');require(operation in ('observe','reconcile-forward','build-forward'),'P2_RECOVERY_OPERATION_REFUSED')
    client=vercel.Client(value['vercelToken'])
    if operation=='reconcile-forward':result=reconcile_forward(value,client,verify)
    elif operation=='build-forward':result=build_forward(value,client,verify)
    else:result=observe(client,value['candidate'],value['plan'],Path(value['receiptDirectory'])/'vercel',
                   Path(value['privateConfigurationDirectory']),value['expectedWriterBinding'],verify)
    print(json.dumps({'type':'result','value':result}),flush=True)


if __name__=='__main__':
    try:main()
    except BaseException:
        print('P2_RECOVERY_FRONTEND_RECHECK_REFUSED',file=sys.stderr);raise SystemExit(1)
