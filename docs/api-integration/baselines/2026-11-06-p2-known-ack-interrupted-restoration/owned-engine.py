"""Owned C broker process. Real FE/API reads over private RPC; Docker projected.

This fixture never runs a cloud command. Linux root/Docker deployment metadata is
projected explicitly; the source broker methods, capability, lock and DB probes
are the production implementations.
"""
import copy
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import traceback
from unittest.mock import patch

TRACE=[];STAGE={'value':None}
def trace_failure(frame,event,arg):
    if event=='exception' and Path(frame.f_code.co_filename).name in ('p2_known_ack_interrupted_restoration.py','p2_known_ack_loss.py','p2_prior_gateway.py'):
        error=arg[1];code=str(error)
        if isinstance(error,ValueError) and re.fullmatch(r'[A-Z0-9_]{1,100}',code):TRACE.append({'file':Path(frame.f_code.co_filename).name,'line':frame.f_lineno,'code':code})
    return trace_failure
sys.settrace(trace_failure);threading.settrace(trace_failure)

ROOT_SOURCE=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT_SOURCE/'ops/platform/host'))
import p2_known_ack_interrupted_restoration as c
import p2_release_broker as shared
import p2_prior_gateway as prior
import frontend_gateway_observation
from p2_source_closure import TYPES


def write(directory,name,value):
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=directory/name;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode() if not isinstance(value,bytes) else value
    with path.open('xb') as file:file.write(raw)
    path.chmod(0o600);return c.sha(raw)


def model_row(candidate,service,identifier,configuration,running=False,pid=0):
    image=candidate['artifacts'][c.runtime.IMAGE_KEYS[service]]['image']
    env={'MODEL_SERVICE':service}
    if service in c.runtime.ENV_FILES:
        env.update(dict(line.split('=',1) for line in (configuration/(service+'.env')).read_text().splitlines() if line))
    return {'Id':format(identifier,'064x'),'Image':image.split('@')[1],'RestartCount':0,
      'Config':{'Image':image,'Env':['PATH=/owned/bin',*[key+'='+value for key,value in env.items()]],'Labels':{'com.docker.compose.project':'lash-her-staging','com.docker.compose.service':service}},
      'HostConfig':{'ReadonlyRootfs':True},'State':{'Running':running,'Pid':pid,'StartedAt':'2026-11-06T01:00:00.000000000Z',**({} if service.endswith('-tls') else {'Health':{'Status':'healthy'}})},
      'Mounts':[{'Type':'bind','Source':str(configuration/relative),'Destination':destination,'RW':False} for destination,relative in c.known.MOUNTS.get(service,{}).items()]}


def prepare(value):
    work=Path(value['work']);root=work/'root';root.mkdir(mode=0o700);operators=work/'operators';operators.mkdir(mode=0o700)
    data=value['input'];old=value['old'];candidate=value['candidate'];candidate_hash=value['candidateSha256'];commit=data['sourceCommit'];source=operators/commit;source.mkdir()
    archive=subprocess.check_output(['git','--no-replace-objects','-c','safe.directory='+value['root'],'-C',value['root'],'archive',commit,'ops'])
    subprocess.run(['tar','-xf','-','-C',str(source)],input=archive,check=True)
    manifest={path.relative_to(source).as_posix():c.sha(path.read_bytes()) for path in (source/'ops').rglob('*') if path.is_file() and path.suffix in TYPES}
    closure=c.sha(c.canonical(sorted(manifest.items())))
    input_directory=root/'root-owned-input';input_directory.mkdir(mode=0o700)
    runtime={'version':1,'environment':'staging','releaseId':candidate['releaseId'],'hostMachineId':'1'*32,'previousReleaseRef':'owned/none','maintenanceRef':'owned/c'}
    write(input_directory,'runtime.json',runtime)
    gateway={'appEnv':'staging','projectId':candidate['workload']['projectId'],'admission':{'file':'/admission/state.json','candidateSha256':candidate_hash,'releaseId':candidate['releaseId']}}
    write(input_directory,'gateway.json',gateway)
    for service in ('course','community'):write(input_directory,service+'-tls.json',{'owned':service})
    for name in c.runtime.TLS_FILES:
        path=data['key'] if name.endswith('key.pem') else data['certificate']
        write(input_directory,name,Path(path).read_bytes())
    for service in c.runtime.ENV_FILES:
        api=service.split('-')[0];role=data['apis'][api]['database']['user'];db=data['apis'][api]['database']['database']
        env={'DATABASE_TARGET':'staging','STAGING_DATABASE_URL':f'postgresql://{role}:{data["password"]}@127.0.0.1:{data["port"]}/{db}?sslmode=verify-full','NODE_ENV':'production'}
        write(input_directory,service+'.env',('\n'.join(key+'='+item for key,item in env.items())+'\n').encode())
    jobs={name:{**info,'schema':info['schema'].encode()} for name,info in value['jobs'].items()}
    mounted=root/'original-runtime/configuration';mounted.parent.mkdir(mode=0o700)
    compose=Path(value['root'])/'ops/platform/compose.yaml'
    c.runtime.snapshot_configuration(input_directory,mounted,candidate,jobs,compose.read_bytes())
    models={service:[model_row(candidate,service,i+1,mounted)] for i,service in enumerate(c.runtime.SERVICES)}
    original_process={**c.known.KnownAckLossBoundary._public_process(models['gateway'][0]),'pid':old['oldPid'],'running':True}
    configuration_hashes=c.staging_state.configuration_hashes(input_directory)
    initial={'version':1,'environment':'staging','mode':c.MODE,'sourceCommit':commit,'candidate':candidate,'candidateSha256':candidate_hash,'configuration':str(input_directory),
      'configurationSha256':configuration_hashes,'hostMachineId':'1'*32,'results':str(root),'recoveryActionId':value['actionId'],'originalReleaseId':candidate['releaseId'],
      'targetSha256':data['targetSha256'],'owner':data['owner'],'receiverTargets':value['receiverTargets'],'historicalLogins':{},'producers':[]}
    with patch.object(prior,'ROOT',root):binding=prior._reference(initial,candidate,mounted,models['gateway'][0]['Id'])
    admission={'newWork':False,'recovery':False,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':1},'sha256':'b'*64}
    gateway_observed={'status':'PRIOR_GATEWAY_OBSERVED','process':original_process,'binding':binding,'admission':admission}
    baseline_gateway=copy.deepcopy(gateway_observed);baseline_gateway['admission']['recovery']=True;baseline_gateway['admission']['uncertain']['recovery']=0
    domain_gateway=copy.deepcopy(gateway_observed);domain_gateway['admission']['recovery']=True
    cert_id='owned-b-certification';replace_id='owned-b-replacement';causal=root/('p2-known-ack-loss-'+cert_id);replacement=root/('p2-certification-'+replace_id);cert=root/('p2-certification-'+cert_id)
    native={**old['plan']['nativePlan'],'version':1,'environment':'staging','projectId':candidate['workload']['projectId'],'deploymentId':'dpl_ownedKnown','deploymentUrl':'https://owned-known.vercel.app',
      'planSha256':'d'*64,'targetSha256':data['targetSha256'],'actionId':candidate['releaseId'],'phase2ContractManifestSha256':candidate['phase2ContractManifestSha256'],
      'schedule':{'path':c.native.PATH,'schedule':c.native.SCHEDULE},'finalDisposition':'disabled-and-admission-closed'}
    plan={**old['plan'],'nativePlan':native,'candidateSha256':candidate_hash,'sourceCommit':commit,'operatorSourceCommit':commit,'targetSha256':data['targetSha256']}
    intent={'version':1,'recoveryActionId':replace_id,'intent':{'version':1,'profile':'known-ack-same-session-ordered-replacement-v1','runtimeReplacements':1,'sqlReplayAllowed':False,
      'roleChangeAllowed':False,'ordinaryClosedZeroGate':False,'automaticFailureRecoveryAllowed':False,'certificationActionId':cert_id,'candidateSha256':candidate_hash,
      'operatorSourceCommit':commit,'sourceCommit':commit,'operatorSourceClosureSha256':closure,'nativePlanSha256':native['planSha256'],'configurationInputDirectory':str(input_directory),
      'receiverTargetsSha256':c.sha(c.canonical(value['receiverTargets']))}}
    intent['intentSha256']=c.sha(c.canonical(intent['intent']))
    values={'recovery-intent.json':intent,'baseline.json':{'status':'P2_KNOWN_ACK_BASELINE_RETAINED','candidateSha256':candidate_hash,'recoveryActionId':replace_id,'sourceModuleSha256':manifest[c.known.MODULE],
      'plan':plan,'gateway':baseline_gateway,'databases':old['before']},'domain.json':{'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','gateway':domain_gateway,'databases':old['domain'],
      'effect':old['effects'][0],'operationId':old['firstLedger'][0]['id'] if 'firstLedger' in old else old['domain']['frontend']['operations'][0]['id']}}
    operation_id=values['domain.json']['operationId'];domain_hash=write(causal,'domain.json',values['domain.json'])
    artifact={'version':1,'kind':'operator-recorded-request-details','reviewerGithubUserId':'8996309','certificationActionId':cert_id,'nativePlanSha256':native['planSha256'],
      'windowEpoch':str(int(native['initialEpoch'])+1),'recordedAt':'2026-11-06T01:05:00.000Z','observations':[]}
    for index,row in enumerate(old['domain']['frontend']['operations']):
        event={'version':1,'status':'P2_LIFECYCLE_CRON_ADMITTED','environment':'staging','projectId':candidate['workload']['projectId'],'operationId':row['id'],
          'producerSha256':native['producer']['producerSha256'],'sourceCommit':commit,'epoch':row['epoch'],'kind':'recovery','targetSha256':data['targetSha256']}
        artifact['observations'].append({'version':1,'kind':'vercel-native-request-details','reviewerGithubUserId':'8996309','projectId':candidate['workload']['projectId'],
          'deploymentId':native['deploymentId'],'path':c.native.PATH,'method':'GET','providerRequestTypeFilter':'cron','providerRequestId':'owned-real-request-'+str(index),
          'startedAt':'2026-11-06T01:00:00.000Z','completedAt':'2026-11-06T01:04:00.000Z','httpStatus':503 if row['state']=='uncertain' else 200,
          'logScope':'this-provider-request-details','admittedLogLine':json.dumps(event)})
    raw=c.canonical(artifact)+b'\n';write(cert,'p2-certification-operator-request-details.json',raw)
    values['request-details.json']={'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','artifactSha256':c.sha(raw),'originalArtifact':artifact,'domainSha256':domain_hash,
      'provenance':{'authority':'operator-recorded-request-details','artifactSha256':c.sha(raw)}}
    pins={name:write(causal,name,values[name]) for name in c.CAUSAL_FILES[:4] if name!='domain.json'};pins['domain.json']=domain_hash
    # The real B fixture settled with its own source domain receipt digest. C
    # must use that exact digest; keep the real settled operation untouched.
    values['settlement.json']={'status':'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT','recoveryActionId':replace_id,'domainSha256':pins['domain.json'],'baselineSha256':pins['baseline.json'],
      'requestDetailsSha256':pins['request-details.json'],'operationId':operation_id,'epoch':old['beforeSettlement']['frontend']['admission']['epoch'],'gateway':gateway_observed,'databases':old['beforeSettlement']}
    settlement_raw=c.canonical(values['settlement.json'])+b'\n'
    # The original B fixture uses this exact source-shaped receipt digest in
    # its normal specific reconciliation. C never changes that operation.
    settlement_hash=write(causal,'settlement.json',values['settlement.json']);pins['settlement.json']=settlement_hash
    authorization={'version':1,'status':'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED','candidateSha256':candidate_hash,'certificationActionId':cert_id,'recoveryActionId':replace_id,
      'baselineSha256':pins['baseline.json'],'domainSha256':pins['domain.json'],'requestDetailsSha256':pins['request-details.json'],'settlementSha256':settlement_hash,
      'originalGateway':baseline_gateway,'operationId':operation_id,'sourceModuleSha256':manifest[c.known.MODULE],'recoveryIntentSha256':intent['intentSha256'],
      'operatorSourceClosureSha256':closure}
    pins['replacement-authorization.json']=write(causal,'replacement-authorization.json',authorization)
    old_processes={service:{**c.known.KnownAckLossBoundary._public_process(rows[0]),'running':True,'pid':100+index} for index,(service,rows) in enumerate(models.items())}
    old_processes['gateway']=original_process
    replacement_values={'known-ack-replacement-intent.json':{'status':'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT','authorization':authorization,'recoveryIntent':intent,
      'oldProcesses':old_processes,'stages':[list(s) for s in c.runtime.STAGES]}}
    # Earlier fixed API stage intent interrupted; no gateway command frontier.
    stage=c.runtime.STAGES[0];replacement_values['known-ack-stage-0-intent.json']={'status':'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT','stage':list(stage),'recoveryActionId':replace_id,
      'candidateSha256':candidate_hash,'authorizationReceiptSha256':c.sha(c.canonical(authorization)),'maximumSeconds':120}
    replacement_pins={name:write(replacement,name,replacement_values[name]) if name in replacement_values else None for name in c.REPLACEMENT_FILES}
    before={'protocol':prior.PROTOCOL,'sourceModuleSha256':prior._source_sha256(),'status':'PRIOR_GATEWAY_PRESTOP_OBSERVED','candidateSha256':candidate_hash,'actionId':replace_id,'observation':gateway_observed}
    write(replacement,prior.BEFORE_STOP,before)
    stopped={**original_process,'running':False,'pid':0}
    stop={'protocol':prior.PROTOCOL,'sourceModuleSha256':prior._source_sha256(),'status':'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED','beforeSha256':c.sha((replacement/prior.BEFORE_STOP).read_bytes()),
      'candidateSha256':candidate_hash,'actionId':replace_id,'stoppedProcess':stopped}
    stop_hash=write(replacement,prior.STOPPED,stop)
    with patch.object(prior,'ROOT',root):prior._remember({'candidateSha256':candidate_hash,'recoveryActionId':replace_id},gateway_observed,'stopped-observed',stopReceiptDirectory=str(replacement),stopReceiptSha256=stop_hash)
    selection={'version':1,'mode':c.MODE,'restorationActionId':value['actionId'],'originalCertificationActionId':cert_id,'originalRecoveryActionId':replace_id,
      'originalOperatorSourceCommit':commit,'causalReceiptSha256':pins,'replacementReceiptSha256':replacement_pins,
      'priorGatewayReference':{'kind':'stopped-current-candidate','stopReceiptDirectory':str(replacement),'stopReceiptSha256':stop_hash}}
    initial.update(interruptedRestoration=selection,priorGatewayReference=selection['priorGatewayReference'],originalReceiptSha256={**pins,**{'replacement/'+key:item for key,item in replacement_pins.items()}},
      credentials={'FRONTEND_STAGING_MIGRATION_DATABASE_URL':f'postgresql://{data["target"]["user"]}:{data["password"]}@127.0.0.1:{data["port"]}/{data["target"]["database"]}?sslmode=verify-full'})
    current_manifest={p.relative_to(Path(value['root'])).as_posix():c.sha(p.read_bytes()) for p in (Path(value['root'])/'ops').rglob('*') if p.is_file() and p.suffix in TYPES and '__pycache__' not in p.parts and 'node_modules' not in p.parts}
    initial.update(sourceSha256=current_manifest,sourceClosureSha256=c.sha(c.canonical(sorted(current_manifest.items()))))
    write(work,'owned-context.json',{'fixture':value,'initial':initial,'models':models,'oldGateway':gateway_observed,'root':str(root),'operators':str(operators),
      'settlementHash':settlement_hash,'operationId':operation_id})
    print(json.dumps(initial))


RPC_WRITE=None;RPC_READ=None;RPC_LOCK=threading.Lock();RPC_ID=0

def rpc(operation,**payload):
    global RPC_ID
    with RPC_LOCK:
        RPC_ID+=1;identifier=RPC_ID
        RPC_WRITE.write(json.dumps({'id':identifier,'operation':operation,**payload})+'\n');RPC_WRITE.flush()
        response=json.loads(RPC_READ.readline())
        if response.get('id')!=identifier or response.get('error'):raise ValueError('OWNED_REAL_READ_REFUSED')
        return response['result']


def run_broker(initial):
    global RPC_WRITE,RPC_READ
    RPC_WRITE=os.fdopen(3,'w');RPC_READ=os.fdopen(4,'r')
    work=Path(initial['configuration']).parents[1];context=json.loads((work.parent/'owned-context.json').read_text()) if not (work/'owned-context.json').exists() else json.loads((work/'owned-context.json').read_text())
    data=context['fixture'];root=Path(context['root']);models=context['models'];jobs={name:{**info,'schema':info['schema'].encode()} for name,info in data['jobs'].items()}
    for service in ('course','community'):
        api=data['input']['apis'][service];os.environ[service.upper()+'_STAGING_DATABASE_URL']=f'postgresql://{api["migrationRole"]}:{data["input"]["password"]}@127.0.0.1:{data["input"]["port"]}/{api["database"]["database"]}?sslmode=verify-full'
    lock=root/'actual-host-lock';fd=os.open(lock,os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    c.ROOT=prior.ROOT=root;c.OPERATORS=Path(context['operators']);c.LOCK=shared.LOCK=lock
    def command(args,env,timeout):return docker(args,{'env':env,'timeout':timeout,'text':True}).stdout.strip()
    def metadata(value):return c.known.KnownAckLossBoundary._public_process(value)
    active_gateway={'value':None}
    def docker(args,kwargs):
        text=kwargs.get('text',False)
        if args[1:3]==['container','ls']:
            if 'label=com.docker.compose.service=gateway' in args:result='\n'.join(row['Id'] for row in models['gateway'])
            elif any(str(v).startswith('name=^/') for v in args):result=''
            else:result='\n'.join(row['Id']+'|'+service for service,rows in models.items() for row in rows)
        elif args[1:3]==['image','inspect']:result={'Id':args[-1].split('@')[1],'Config':{'Env':['PATH=/owned/bin']}}
        elif args[1]=='inspect':
            row=next(row for rows in models.values() for row in rows if row['Id'].startswith(args[-1]));fmt=args[args.index('--format')+1]
            if fmt==prior.PROCESS_FIELDS:result='|'.join([row['Image'],str(row['State']['Running']).lower(),str(row['State']['Pid']),row['State']['StartedAt'],str(row['RestartCount']),'lash-her-staging','gateway'])
            elif fmt=='{{json .Mounts}}':result=row['Mounts']
            elif fmt=='{{json .}}':result=row
            else:result='|'.join([row['Image'],'true',(row['State'].get('Health') or {}).get('Status','none'),'lash-her-staging',row['Config']['Labels']['com.docker.compose.service']])
        elif 'config' in args:
            configuration=Path(args[args.index('--project-directory')+1]);result={'services':{}}
            for service in c.runtime.SERVICES:
                row=model_row(initial['candidate'],service,100,configuration);result['services'][service]={'environment':dict(v.split('=',1) for v in row['Config']['Env'] if not v.startswith('PATH='))}
        elif args[1]=='run':
            payload=json.loads(kwargs['input']);program=args[-1]
            if program.endswith('p2-known-ack-loss-probe.mjs'):result=rpc('known-sql',payload=payload)
            elif program.endswith('p2-recovery-api-current-probe.mjs'):
                service='course' if payload['service']=='lash-her-course-api' else 'community';result=rpc('api-current',service=service,payload=payload)
            else:raise ValueError('OWNED_UNKNOWN_READ_CONTAINER')
        elif args[1]=='rm':result=''
        elif 'up' in args:
            STAGE['value']=list(args[args.index('90')+1:])
            configuration=Path(args[args.index('--project-directory')+1]);stage=tuple(args[args.index('90')+1:])
            assert stage==broker.boundary.stage_active
            for service in stage:models[service]=[model_row(initial['candidate'],service,2000+c.runtime.SERVICES.index(service),configuration,True,2000+c.runtime.SERVICES.index(service))]
            if stage==('gateway',):active_gateway['value']={'status':'PRIOR_GATEWAY_OBSERVED','binding':prior._reference(initial,initial['candidate'],configuration,models['gateway'][0]['Id']),
              'process':metadata(models['gateway'][0]),'admission':{'newWork':False,'recovery':False,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':0},'sha256':'f'*64}}
            result=''
        elif 'ps' in args:result='\n'.join(row['Id'] for row in models[args[-1]])
        elif 'release-probe.mjs' in args:result={'status':'API_RUNTIME_BOUNDARIES_PASS','checks':sorted(c.runtime.PROBE_CHECKS)}
        elif args[1]=='stop':
            for rows in models.values():
                for row in rows:row['State'].update(Running=False,Pid=0)
            result=''
        else:raise ValueError('OWNED_UNKNOWN_DOCKER_COMMAND')
        raw=result if isinstance(result,str) else json.dumps(result)
        return subprocess.CompletedProcess(args,0,stdout=raw if text else raw.encode(),stderr='' if text else b'')
    class Physical:
        def __init__(self,_selected,request,*_args,**_kwargs):self.request=request;self.failure=None
        def probe(self,kind):return rpc('physical',probe=self.request,kind=kind)
        def start(self,_abort):self.verify()
        def verify(self):self.probe('observe')
        def stop(self):pass
    broker=c.InterruptedKnownAckRestorationBroker(initial,lambda value:print(json.dumps(value),flush=True),observer_type=Physical,observer_source='ops/platform/p2-recovery-current-probe.mjs')
    broker.started_at=time.monotonic();broker.source=Path(data['root']);broker.selected=initial['candidate'];broker.jobs=jobs;broker.configuration=Path(initial['configuration']);broker.results=root
    broker.directory=root/('p2-recovery-'+initial['recoveryActionId']);broker.directory.mkdir(mode=0o700);broker.lock_fd=fd
    broker.retained=broker.reader=broker.raw_scope=broker.boundary=None;broker.restore_attempted=False;broker.prepared_terminal=None
    broker.observer_program=broker.source/'ops/platform/p2-recovery-current-probe.mjs'
    def check():
        assert os.fstat(fd).st_ino==lock.stat().st_ino;fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        assert not broker.failed.is_set()
        if broker.observer and broker.closing_at is None:broker.observer.verify()
    broker.check=check;broker.safety=lambda _value:None
    def observed(_configuration,reviewed,verify,_command,_host):
        verify();assert active_gateway['value'] is not None
        return {'admission':active_gateway['value']['admission']}
    def native_off(context,_client):c.native.identity(context);return rpc('native-off')
    broker.vercel=object()
    actual_scope_run=c.P2RecoveryScope.run
    def scope_run(scope,args,**kwargs):
        scope.verify()
        if args[0]=='docker':result=docker(args,kwargs)
        else:result=actual_scope_run(scope,args,**kwargs)
        scope.verify();return result
    with patch.object(prior,'_command',side_effect=command),patch.object(frontend_gateway_observation,'observe',side_effect=observed),\
         patch.object(c.native,'observe_metadata',side_effect=native_off),patch.object(c.P2RecoveryScope,'run',scope_run),patch.object(c.runtime,'preflight',return_value=None):
        broker.retained=c.load_retained(initial,broker.selected,jobs,broker.check,command)
        print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
        try:
            for line in sys.stdin:
                value=json.loads(line);broker.command(value)
                if broker.committed.is_set():break
            assert broker.committed.is_set()
        finally:os.close(fd)


if __name__=='__main__':
    try:
        value=json.loads(sys.stdin.readline())
        if sys.argv[1]=='prepare':prepare(value)
        else:run_broker(value)
    except BaseException as error:
        print(json.dumps({'status':'OWNED_C_ENGINE_FAILED','kind':type(error).__name__,'code':str(error) if isinstance(error,ValueError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'UNKNOWN','trace':TRACE[-6:],'stage':STAGE['value'],'frames':[{'file':Path(frame.filename).name,'line':frame.lineno} for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).name in ('owned-engine.py','p2_known_ack_interrupted_restoration.py')][-5:]}),file=sys.stderr)
        raise SystemExit(1)
