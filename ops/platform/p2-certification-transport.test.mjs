import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {p2CertificationEnvironmentLock,readP2CertificationAuthenticationStage,readP2CertificationSuspensionStage,readP2CertificationWorkerStage,readP2CertificationKnownAckStage,readP2CertificationInteractiveStage} from './p2-certification-transport.mjs';
import {STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile} from './qualification-target-profile.mjs';
const program=String.raw`
import base64,fcntl,json,os,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
initial=json.loads(sys.stdin.readline());assert initial['mode'] in ('p2-bounded-certification','p2-bounded-certification-profiled-current')
print(json.dumps({'id':0,'status':'LOCKED'}),flush=True)
terminal={'status':'P2_BOUNDED_CERTIFICATION_CONTAINED','sqlReplayed':False,'runtimeReplaced':False}
if initial['mode'].endswith('profiled-current'):
 terminal.update(status='P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',version=2,qualificationTargetProfile=initial['qualificationTargetProfile'],
  planSha256=initial['certificationPlan']['planSha256'])
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];value={'id':p['id']}
 if op=='check':value['status']='HELD'
 elif op=='arm-certification':
  assert json.loads(base64.b64decode(p['receipt']))['status']=='P2_CERTIFICATION_DATABASE_CURRENT'
  if sys.argv[2]=='death':os._exit(31)
  value.update(status='CERTIFICATION_ARMED',receipt={'status':'P2_CERTIFICATION_CURRENT_READY'})
 elif op=='certification-gateway-stage':value.update(status='CERTIFICATION_GATEWAY_OBSERVED',receipt={'gateway':{'newWork':p['stage']=='browser','recovery':False}})
 elif op=='certification-prepare-close':value.update(status='CERTIFICATION_CLOSE_PREPARED',receipt=terminal)
 elif op=='finish':
  assert json.loads(base64.b64decode(p['certification']))==terminal
  value.update(status='P2_CERTIFICATION_JOINED',receipt=terminal)
 elif op=='commit':
  value.update(status='COMMITTED',receipt=terminal);print(json.dumps(value),flush=True)
  if sys.argv[2]=='bad-reap':os._exit(33)
  break
 else:os._exit(32)
 print(json.dumps(value),flush=True)
os.close(fd)
`;
function fixture(mode='ready',profiled=false){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-certification-pipe-')));chmodSync(directory,0o700);
 const receipt={status:'P2_CERTIFICATION_DATABASE_CURRENT'},outcome={status:'P2_BOUNDED_CERTIFICATION_CONTAINED',sqlReplayed:false,runtimeReplaced:false};
 const planSha256='c'.repeat(64);
 if(profiled)Object.assign(outcome,{status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',version:2,qualificationTargetProfile:profile,planSha256});
 writeFileSync(join(directory,'p2-certification-current-database.json'),JSON.stringify(receipt),{mode:0o600});
 writeFileSync(join(directory,profiled?'p2-certification-close-prepared.json':'p2-certification-outcome.json'),JSON.stringify(outcome),{mode:0o600});
 const initial={environment:'staging',sourceCommit:'a'.repeat(40),mode:'p2-bounded-certification',certificationActionId:'bounded-case',nativePlan:{planSha256:'b'.repeat(64)},
  certificationPlan:{mode:'auth-preparation'},browserPlan:{},credentials:{privateMarker:'fixture-private-stdin-only'}};
 if(profiled)Object.assign(initial,{mode:'p2-bounded-certification-profiled-current',version:2,qualificationTargetProfile:profile,
  certificationPlan:{mode:'contain-native',version:2,qualificationTargetProfile:profile,certificationActionId:initial.certificationActionId,
    nativePlan:{version:2,qualificationTargetProfile:profile,planSha256:'b'.repeat(64)},planSha256}});
 const lock=join(directory,'actual.lock');let captured;
 const factory=p2CertificationEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},initial,directory,{expectedProfile:profiled?profile:undefined,launch(executable,args,options){captured={executable,args,options};return spawn('python3',['-I','-u','-c',program,lock,mode],options);}});
 return{directory,receipt,outcome,factory,lock,getCaptured:()=>captured,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('actual child pipe/flock joins only exact certification terminal and keeps credentials in stdin',async()=>{
 const f=fixture();try{
  const actual=await f.factory(async(verify,_signal,host)=>{
   await verify();const other=spawnSync('python3',['-I','-c',"import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",f.lock]);assert.notEqual(other.status,0);
   await host.arm({receipt:f.receipt,probe:{}});await host.gatewayStage('browser');
   await assert.rejects(host.authenticationStage({},{}));await assert.rejects(host.suspensionEvidenceStage({},{}));
   await assert.rejects(host.workerEvidenceStage({}));
   await assert.rejects(host.knownAckStage({}));
   await assert.rejects(host.interactiveStage({}));
   assert.throws(()=>readP2CertificationAuthenticationStage({status:'P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD'},{}));
   assert.throws(()=>readP2CertificationSuspensionStage({captureControlled:async()=>({})},{}));
   assert.throws(()=>readP2CertificationWorkerStage({invokeDirect:async()=>({status:'P2_DIRECT_WORKER_HTTP_OBSERVED'})},{}));
   assert.throws(()=>readP2CertificationKnownAckStage({replace:async()=>({status:'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED'})},{}));
   assert.throws(()=>readP2CertificationInteractiveStage({installPermit:async()=>({})},{}));
   await host.prepareClose({status:'P2_TEST_FIXTURE'});await host.finish(f.outcome);return'joined';
  });
  assert.equal(actual,'joined');assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-certification-outcome.json'))),f.outcome);
  assert.equal(JSON.stringify(f.getCaptured()).includes('fixture-private-stdin-only'),false);
  assert.equal(f.getCaptured().executable,'/usr/bin/ssh');assert.ok(f.getCaptured().args.some(value=>value.includes('p2_certification_parent.py')));
 }finally{f.cleanup();}
});

const interactiveProgram=String.raw`
import base64,hashlib,json,sys,time
from datetime import datetime,timezone
initial=json.loads(sys.stdin.readline())
plan=initial['certificationPlan'];binding=initial['interactiveController'];profile=initial['qualificationTargetProfile']
action=plan['scopedAction'];stage=action['stage'];epoch=str(int(plan['initialEpoch'])+1);behavior=sys.argv[1]
enrollment=action.get('identityEnrollment')
authoring=stage=='authoring';gateway_observation=None
authoring_action=action.get('authoringAction',{})
editing=authoring_action.get('operation')=='edit-and-stale-draft'
reorder=authoring_action.get('operation')=='reorder-and-stale-curriculum'
create_curriculum=authoring_action.get('operation')=='create-curriculum'
publication=authoring_action.get('operation')=='qualify-publication'
published=publication and authoring_action['outcome']=='published'
changes_existing=editing or reorder
def fixture_id(suffix):return f'12345678-1234-4123-8123-{suffix:012d}'
post_request=fixture_id(4);stale_request=fixture_id(6)
initial_time=int(time.time());expires=initial_time+120
def iso(seconds):return datetime.fromtimestamp(seconds,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def send(value):print(json.dumps(value),flush=True)
def status(disposition):return f'P2_INTERACTIVE_{stage.upper()}_{disposition}'
send({'id':0,'status':'LOCKED'})
phase='new';terminal={'status':'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED','version':2,'qualificationTargetProfile':profile,'planSha256':plan['planSha256'],'sqlReplayed':False,'runtimeReplaced':False}
base={'version':2,'qualificationTargetProfile':profile,'certificationActionId':initial['certificationActionId'],'planSha256':plan['planSha256'],'stage':stage}
fence={'gatewayAdmissionClosed':True,'gatewayActive':0,'gatewayUncertain':0}
for raw in sys.stdin:
 p=json.loads(raw);op=p['operation'];value={'id':p['id']}
 if op=='check':value['status']='HELD'
 elif op=='arm-certification':value.update(status='CERTIFICATION_ARMED',receipt={'status':'P2_CERTIFICATION_CURRENT_READY'})
 elif op.startswith('interactive-'):
  assert p['controllerChallenge']==binding['challenge']
  assert set(p)=={'id','operation','controllerChallenge'}|({'caseEvidence'} if op=='interactive-retain' else set())
  value['status']='CERTIFICATION_INTERACTIVE_OBSERVED'
  if op=='interactive-prepare':
   assert phase=='new';phase='prepared'
   value['receipt']={**base,'status':status('PREPARED'),'ingressSha256':'d'*64}
  elif op=='interactive-open':
   assert phase=='prepared';phase='opened'
   value['receipt']={**base,'status':status('OPENED'),'epoch':epoch,'expiresAt':iso(expires),'gatewayScoped':authoring}
  elif op=='interactive-permit':
   assert phase=='opened';phase='issued'
   selector='f'*64;nonce='e'*32
   if authoring:
    owner_id=action['actorId']
    if behavior=='wrong-owner':owner_id=fixture_id(2)
    prefix='7032712d617574686f72696e672d7631'
    if behavior!='wrong-operation-permit':
     if reorder:prefix='7032712d617574682d736f72742d7631'
     elif editing:prefix='7032712d617574682d656469742d7631'
     elif create_curriculum:prefix='7032712d617574682d6e65772d763100'
     elif publication:
      publish_selector=published if behavior!='wrong-outcome-permit' else not published
      prefix='7032712d617574682d7075622d763100' if publish_selector else '7032712d617574682d7264792d763100'
    selector=prefix+owner_id.replace('-','')
   elif enrollment:
    provider=enrollment['provider'];nonce=enrollment['nonce'];email_digest=enrollment['emailSha256']
    if behavior=='wrong-nonce':nonce='8'+nonce[1:]
    if behavior=='wrong-provider':provider='resend' if provider=='google' else 'google'
    if behavior=='wrong-email':email_digest='7'+email_digest[1:]
    selector=('a1' if provider=='google' else 'a2')+email_digest[:62]
   elif stage=='identity':
    identity=action['identityActor']
    if identity['actorKind']=='customer':
     customer_id=identity['actorId']
     if behavior=='wrong-selector':customer_id='12345678-1234-4123-8123-000000000002'
     selector='7032712d637573746f6d65722d763100'+customer_id.replace('-','')
     if behavior=='wrong-kind':selector=digest(['identity','admin'])
    else:selector=digest(['identity','admin'])
   version='v1' if behavior=='legacy-permit' else 'v2'
   cookie='.'.join((version,epoch,stage,str(initial_time),str(expires),nonce,*(() if version=='v1' else (selector,)),'a'*64))
   value.update(status='CERTIFICATION_INTERACTIVE_PRIVATE',permit={'stage':stage,'epoch':epoch,'expires':expires,'cookie':cookie})
  elif op=='interactive-observe':
   assert authoring and phase=='issued';phase='observed'
   if behavior=='observe-refused':
    value['receipt']={**base,'status':status('GATEWAY_OBSERVATION_REFUSED')}
   else:
    selected=[(11,13,0,200),(12,14,0,200),(4,15,1,200),(16,17,0,200),(6,18,2,409)] if changes_existing else [(11,13,0,200),(4,12,1,201)]
    if create_curriculum:selected.append((16,17,0,200))
    if publication:
     selected=[(11,13,0,200),(4,12,1,200)]
     if published:selected.extend([(6,18,2,200),(16,17,0,200)])
     if behavior=='unexpected-patch-ack':selected.append((6,18,2,200))
    acks=[{'requestId':fixture_id(req),'proofRequestId':fixture_id(proof),'requestIndex':index,'upstreamStatus':http}
     for req,proof,index,http in selected]
    if behavior=='wrong-observe-ack':acks[-1 if changes_existing else 1]['upstreamStatus']=201 if publication else 200
    if behavior=='wrong-observe-order':
     first=2 if changes_existing else 1
     acks[first],acks[first+1]=acks[first+1],acks[first]
    gateway_observation={**base,'status':status('GATEWAY_OBSERVED'),'epoch':epoch,'gatewayStateSha256':'4'*64,
     'gatewayAcknowledgements':acks,'gatewayActive':0,'gatewayUncertain':0}
    gateway_observation['gatewayEvidenceSha256']='0'*64 if behavior=='wrong-observe-hash' else digest(gateway_observation)
    value['receipt']=gateway_observation
  elif op=='interactive-fence':
   assert phase in ('opened','issued','observed');phase='fenced'
   value['receipt']={**base,**fence,'status':status('FENCED')}
  elif op=='interactive-retain':
   assert phase=='fenced';phase='retained'
   evidence=p['caseEvidence']
   if changes_existing:
    assert gateway_observation and set(evidence)=={'browserResponses','courseWitness'}
    responses=evidence['browserResponses'];body=responses['winner']['body'];witness=evidence['courseWitness']
    assert responses['winner']['requestId']==post_request and responses['stale']['requestId']==stale_request
    proof='keyboardActivated' if reorder else 'dirtyInputPreserved'
    assert set(responses['stale'])=={'method','pathname','status','requestId','outcome',proof}
    assert responses['stale']['outcome']=='conflict' and responses['stale'][proof] is True and witness=={**body,'readOnly':True}
    request_ids=[post_request,stale_request]
    if behavior=='wrong-join':request_ids.reverse()
    joined={'actorId':action['actorId'],'operation':authoring_action['operation'],'courseId':body['courseId'],'slug':authoring_action['slug'],
     'browserResponsesSha256':digest(responses),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if reorder:
     assert responses['winner']['keyboardActivated'] is True
     joined.update(kind=authoring_action['kind'],parentId=authoring_action['parentId'],gatewayPostRequestIds=request_ids)
    else:joined['gatewayPatchRequestIds']=request_ids
   elif publication:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    assert set(response)==({'readiness','body','publication'} if published else {'readiness','body'})
    assert response['readiness']['requestId']==post_request and witness=={**body,'readOnly':True}
    assert body=={'courseId':authoring_action['courseId'],'slug':authoring_action['slug'],'revision':authoring_action['revision']+int(published),
     'status':'published' if published else 'draft','issueCodes':authoring_action['issueCodes']}
    joined={'actorId':action['actorId'],'operation':'qualify-publication','courseId':body['courseId'],'slug':body['slug'],
     'outcome':authoring_action['outcome'],'revision':body['revision'],'issueCodes':body['issueCodes'],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],'readinessGatewayRequestId':post_request}
    if published:
     assert response['publication']['requestId']==stale_request
     joined['gatewayPatchRequestId']=stale_request
    if behavior=='wrong-join':joined['readinessGatewayRequestId']=fixture_id(2)
   elif authoring:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    assert response['requestId']==post_request and witness=={**body,'readOnly':True}
    joined={'actorId':action['actorId'],'operation':'create-draft','courseId':body['courseId'],'slug':body['slug'],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],'gatewayPostRequestId':post_request}
    if create_curriculum:
     assert body=={'courseId':authoring_action['courseId'],'parentId':authoring_action['parentId'],'kind':authoring_action['kind'],
      'itemId':fixture_id(10),'slug':authoring_action['childSlug'],'revision':authoring_action['revision']+1}
     joined.update(operation='create-curriculum',parentId=body['parentId'],kind=body['kind'],itemId=body['itemId'],
      slug=authoring_action['slug'],childSlug=body['slug'],revision=body['revision'])
     if behavior=='wrong-item-join':joined['itemId']=fixture_id(2)
    if behavior=='wrong-join':joined['gatewayPostRequestId']='12345678-1234-4123-8123-000000000011'
   elif stage=='identity':
    actor={'actorKind':'customer','actorId':'12345678-1234-4123-8123-000000000005'} if enrollment else action['identityActor']
    assert set(evidence)=={'browserIdentity','identityWitness'}
    assert evidence['browserIdentity']=={**actor,'sessionVerified':True}
    if enrollment:
     provider=enrollment['provider']
     assert evidence['identityWitness']=={**actor,'actorActive':True,'liveSessionCount':1,
      'provider':provider,'providerLinkCount':1 if provider=='google' else 0}
    joined={**actor,'context':'owner' if actor['actorKind']=='admin' else 'learner',
     'browserIdentitySha256':digest(evidence['browserIdentity']),'identityWitnessSha256':digest(evidence['identityWitness'])}
    if behavior=='wrong-join':
     if enrollment:joined['actorId']='12345678-1234-4123-8123-000000000002'
     else:joined['identityWitnessSha256']='0'*64
   else:
    assert set(evidence)=={'browserResponse','lifecycleWitness'}
    joined={'browserResponseSha256':digest(evidence['browserResponse']),'lifecycleWitnessSha256':digest(evidence['lifecycleWitness']),
     'actorId':action['actorId'],**action['frontendAction']}
   value['receipt']={**base,**fence,**joined,'status':status('JOINED'),
    'browserProgramSha256':binding['browserProgramSha256'],
    'frontendAdmission':{'epoch':str(int(epoch)+1),'newWork':False,'recovery':False,'active':0,'uncertain':0},'frontendOperationCount':1}
  else:raise AssertionError('unexpected interactive operation')
 elif op=='certification-prepare-close':
  assert phase=='retained' and p['caseOutcome']['status']==status('JOINED')
  value.update(status='CERTIFICATION_CLOSE_PREPARED',receipt=terminal)
 elif op=='finish':
  assert phase=='retained' and json.loads(base64.b64decode(p['certification']))==terminal
  value.update(status='P2_CERTIFICATION_JOINED',receipt=terminal)
 elif op=='commit':
  send({'id':p['id'],'status':'COMMITTED','receipt':terminal})
  break
 else:raise AssertionError('unexpected operation')
 send(value)
`;

const interactiveHarness=String.raw`
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mock} from 'node:test';
import * as childProcess from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const fixture=JSON.parse(readFileSync(0));
const {default:defaultChild,spawn:realSpawn,...childExports}=childProcess;
const program=fixture.program,directory=fixture.directory,profile=fixture.profile;
const sourceCommit='a'.repeat(40),planSha256='c'.repeat(64),actionId='interactive-case';
const actor='12345678-1234-4123-8123-000000000001',target='12345678-1234-4123-8123-000000000002';
const commandId='12345678-1234-4123-8123-000000000003',requestId='12345678-1234-4123-8123-000000000004';
const staleRequestId='12345678-1234-4123-8123-000000000006';
const {certificationStage,actorKind,behavior,variant}=fixture;
const identity=certificationStage==='identity',authoring=certificationStage==='authoring';
const provider=identity?variant:undefined,editing=authoring&&variant==='edit-and-stale-draft';
const reorder=authoring&&['reorder-module','reorder-lesson'].includes(variant),changesExisting=editing||reorder;
const createCurriculum=authoring&&['create-module','create-lesson'].includes(variant);
const publication=authoring&&['publication-published','publication-blocked'].includes(variant),published=variant==='publication-published';
const context=actorKind==='admin'?'owner':'learner';
const status=disposition=>'P2_INTERACTIVE_'+certificationStage.toUpperCase()+'_'+disposition;
const refusedPermit=['wrong-selector','wrong-kind','wrong-nonce','wrong-provider','wrong-email','wrong-owner','legacy-permit','wrong-operation-permit',
 'wrong-outcome-permit'].includes(behavior);
const installFailure=behavior==='install-failure'||refusedPermit;
const observeFailure=['observe-refused','wrong-observe-hash','wrong-observe-ack','wrong-observe-order','unexpected-patch-ack'].includes(behavior);
const skipObserve=behavior==='fence-without-observe';
const selection={actorKind,userId:actorKind==='admin'?target:actor,operation:actorKind==='admin'?'suspend':'delete'};
const identityActor={actorKind,actorId:actor};
const identityEnrollment=provider?{provider,emailSha256:'6'.repeat(64),nonce:'9'.repeat(32)}:null;
const observedActor=identityEnrollment?{actorKind:'customer',actorId:'12345678-1234-4123-8123-000000000005'}:identityActor;
const slug='p2q-course-draft',coursePath='/api/admin/courses/'+commandId,courseTarget='/course/v1/admin/courses/'+commandId;
const kind=variant?.endsWith('-module')?'module':'lesson',parentId=kind==='module'?commandId:target;
const curriculumPath=kind==='module'?'/courses/'+parentId+'/modules':'/modules/'+parentId+'/lessons';
const reorderPath=curriculumPath+'/reorder',childSlug='p2q-new-child',itemId='12345678-1234-4123-8123-000000000010';
const ids=['12345678-1234-4123-8123-000000000009','12345678-1234-4123-8123-000000000007','12345678-1234-4123-8123-000000000008'];
const outcomeKind=published?'published':'blocked',issueCodes=published?[]:['MISSING_LESSONS','MISSING_TITLE'];
const authoringAction=reorder?{operation:'reorder-and-stale-curriculum',courseId:commandId,slug,revision:7,kind,parentId}:
 editing?{operation:'edit-and-stale-draft',courseId:commandId,slug,revision:7}:
 publication?{operation:'qualify-publication',courseId:commandId,slug,revision:7,outcome:outcomeKind,issueCodes}:
 createCurriculum?{operation:'create-curriculum',courseId:commandId,slug,revision:7,kind,parentId,childSlug}:{operation:'create-draft',slug};
const rawHash=body=>createHash('sha256').update(body).digest('hex'),emptyBodySha256=rawHash('');
const reorderHash=ids=>rawHash(JSON.stringify({expectedCourseRevision:authoringAction.revision,ids}));
const writeMethod=reorder?'POST':'PATCH',writeTarget=reorder?'/course/v1/admin'+reorderPath:courseTarget;
const publicationRequest={method:'PATCH',target:courseTarget,
 bodySha256:rawHash(JSON.stringify({expectedRevision:authoringAction.revision,status:'published'})),uses:1};
const requests=publication?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:published?2:1},
  {method:'GET',target:courseTarget+'/publication-readiness',bodySha256:emptyBodySha256,uses:1},
  ...(published?[publicationRequest]:[]),
]:createCurriculum?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:2},
  {method:'POST',target:'/course/v1/admin'+curriculumPath,bodySha256:'8'.repeat(64),uses:1},
]:changesExisting?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:3},
  {method:writeMethod,target:writeTarget,bodySha256:reorder?reorderHash(ids):'8'.repeat(64),uses:1},
  {method:writeMethod,target:writeTarget,bodySha256:reorder?reorderHash([...ids].reverse()):'7'.repeat(64),uses:1},
]:authoring?[
  {method:'GET',target:'/course/v1/admin/courses?limit=100',bodySha256:emptyBodySha256,uses:1},
  {method:'POST',target:'/course/v1/admin/courses',bodySha256:'8'.repeat(64),uses:1},
]:[];
const scopedAction={stage:certificationStage,actorId:identity?null:actor,requests,windowSeconds:120,
  ...(identityEnrollment?{identityEnrollment}:identity?{identityActor}:authoring?{authoringAction}:{frontendAction:selection})};
const plan={mode:'interactive-browser',version:2,environment:'staging',qualificationTargetProfile:profile,certificationActionId:actionId,
  initialEpoch:'7',maximumSeconds:300,sourceCommit,operatorSourceCommit:sourceCommit,planSha256,
  nativePlan:{version:2,qualificationTargetProfile:profile,planSha256:'b'.repeat(64)},
  scopedAction};
const binding={challenge:'5'.repeat(64),bindingSha256:planSha256,browserProgramSha256:'7'.repeat(64)};
const initial={version:2,qualificationTargetProfile:profile,environment:'staging',sourceCommit,certificationActionId:actionId,
  mode:'p2-bounded-certification-profiled-current',certificationPlan:plan,interactiveController:binding};
const receipt={status:'P2_CERTIFICATION_DATABASE_CURRENT'};
const outcome={status:'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED',sqlReplayed:false,runtimeReplaced:false,
  version:2,qualificationTargetProfile:profile,planSha256};
const fenced={status:status('FENCED'),version:2,qualificationTargetProfile:profile,certificationActionId:actionId,planSha256,
  stage:certificationStage,gatewayAdmissionClosed:true,gatewayActive:0,gatewayUncertain:0};
let privatePacket,alive=true,installCount=0;
const browser={
 async installPermit(permit,actualContext){
  assert.equal(actualContext,context);installCount++;
  assert.ok(permit.cookie.startsWith('v2.8.'+certificationStage+'.')&&permit.cookie.endsWith('a'.repeat(64)));
  privatePacket=permit;
  if(behavior==='install-failure'){alive=false;throw new Error(permit.cookie);}
  return {type:'interactive-permit-installed',challenge:binding.challenge,bindingSha256:planSha256,stage:certificationStage,
    epoch:'8',context,expires:permit.expires};
 },
};
let starts=0;const writes=[];
const spawn=(executable,args,options)=>{
 starts++;assert.equal(executable,'/usr/bin/ssh');assert.ok(args.some(value=>value.includes('--supervisor-profiled-current')));
 const child=realSpawn('python3',['-I','-u','-c',program,behavior],options);
 const write=child.stdin.write.bind(child.stdin);child.stdin.write=(value,...rest)=>{writes.push(JSON.parse(value));return write(value,...rest);};
 return child;
};
mock.module('node:child_process',{exports:{...childExports,spawn,default:{...defaultChild,spawn}}});
mock.module(fixture.browserUrl,{exports:{readP2InteractiveBrowserControllerBinding(selected,controller){
  assert.ok(alive&&selected===plan&&controller===browser);return binding;
}}});
const {p2CertificationEnvironmentLock,readP2CertificationInteractiveStage}=await import(fixture.transportUrl);
const start=(input=initial)=>p2CertificationEnvironmentLock({knownHosts:'/owned/hosts',sshKey:'/owned/key'},input,directory,{expectedProfile:profile});
for(const changed of [
 {...initial,interactiveController:{...binding,cookie:'fixture-forbidden'}},
 {...initial,interactiveController:{...binding,bindingSha256:'0'.repeat(64)}},
 {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,stage:identity?'lifecycle':'identity'}}},
 ...(identity?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,actorId:actor}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityActor:{...identityActor,actorKind:'editor'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityActor:{...identityActor,actorId:'00000000-0000-0000-0000-000000000000'}}}},
 ]:[]),
 ...(identityEnrollment?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityEnrollment:{...identityEnrollment,provider:'github'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityEnrollment:{...identityEnrollment,emailSha256:'6'.repeat(62)}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityEnrollment:{...identityEnrollment,nonce:'9'.repeat(31)}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityEnrollment:{...identityEnrollment,emailSha256:'0'.repeat(64)}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,identityEnrollment:{...identityEnrollment,nonce:'0'.repeat(32)}}}},
 ]:[]),
 ...(authoring?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[...requests].reverse()}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],{...requests[1],uses:2},...requests.slice(2)]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[
   requests[0],{...requests[1],bodySha256:publication?'1'.repeat(64):emptyBodySha256},...requests.slice(2),
  ]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,slug:'invalid/slug'}}}},
 ]:[]),
 ...(changesExisting?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...requests[2],bodySha256:requests[1].bodySha256}]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...requests[2],target:courseTarget+'/publish'}]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,revision:2_147_483_647}}}},
 ]:[]),
 ...(reorder?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,kind:'course'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],{...requests[1],method:'PATCH'},requests[2]]}}},
  ...(kind==='module'?[{...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,parentId:target}}}}]:[]),
 ]:[]),
 ...(createCurriculum?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[{...requests[0],uses:1},requests[1]]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],{...requests[1],target:requests[1].target+'/reorder'}]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,childSlug:'invalid/child'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,revision:2_147_483_647}}}},
  ...(kind==='module'?[{...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,parentId:target}}}}]:[]),
 ]:[]),
 ...(publication?[
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,outcome:'draft'}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,issueCodes:published?['UNEXPECTED']:[]}}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[{...requests[0],uses:published?1:2},...requests.slice(1)]}}},
  ...(published?[
   {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...publicationRequest,bodySha256:'1'.repeat(64)}]}}},
  ]:[
   {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[...requests,publicationRequest]}}},
   ...[['bad'],['DUPLICATE','DUPLICATE'],[...issueCodes].reverse(),Array.from({length:17},(_,index)=>'CODE_'+String(index).padStart(2,'0'))]
    .map(issueCodes=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,issueCodes}}}})),
  ]),
 ]:[]),
]) assert.throws(()=>start(changed),{message:'P2_CERTIFICATION_TRANSPORT_REFUSED'});
assert.equal(starts,0);
writeFileSync(join(directory,'p2-certification-current-database.json'),JSON.stringify(receipt),{mode:0o600});
writeFileSync(join(directory,'p2-certification-close-prepared.json'),JSON.stringify(outcome),{mode:0o600});
const response={method:'POST',pathname:'/api/admin/customer-accounts/'+target+'/commands',status:202,requestId,
  body:{commandId,action:'suspend',accountVersion:2,status:'pending'}};
const witness={version:1,status:'P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED',actorId:actor,...selection,requestId,httpStatus:202,
 baselineSha256:'3'.repeat(64),frontendStatus:'suspended',accountVersion:2,sessionsBefore:1,sessionsAfter:0,learningUpdates:false,commandId,
 deliveries:['course','community'].map(receiver=>({receiver,status:'pending',attempts:0})),pendingOrDeliveringCount:2,
 observedAt:new Date().toISOString(),readOnly:true};
const draft={courseId:commandId,revision:changesExisting||createCurriculum?authoringAction.revision+1:1,
 ...(reorder?{parentId,kind,ids}:createCurriculum?{parentId,kind,itemId,slug:childSlug}:{slug,status:'draft'})};
const changePath=reorder?'/api/admin'+reorderPath:coursePath,staleProof=reorder?'keyboardActivated':'dirtyInputPreserved';
const publicationStep={method:'PATCH',pathname:coursePath,status:200,requestId:staleRequestId};
const publicationBody={courseId:commandId,slug,revision:authoringAction.revision+(published?1:0),status:published?'published':'draft',issueCodes};
const evidence=publication?{browserResponse:{
 readiness:{method:'GET',pathname:coursePath+'/publication-readiness',status:200,requestId},
 ...(published?{publication:publicationStep}:{}),body:publicationBody,
},courseWitness:{...publicationBody,readOnly:true}}
 :changesExisting?{browserResponses:{
 winner:{method:writeMethod,pathname:changePath,status:200,requestId,body:draft,...(reorder?{keyboardActivated:true}:{})},
 stale:{method:writeMethod,pathname:changePath,status:409,requestId:staleRequestId,outcome:'conflict',[staleProof]:true},
},courseWitness:{...draft,readOnly:true}}
 :authoring?{browserResponse:{method:'POST',pathname:'/api/admin'+(createCurriculum?curriculumPath:'/courses'),status:200,requestId,body:draft},
 courseWitness:{...draft,readOnly:true}}
 :identity?{browserIdentity:{...observedActor,sessionVerified:true},
 identityWitness:{...observedActor,actorActive:true,...(context==='owner'?{ownerMappingVerified:true}:{liveSessionCount:1}),
  ...(identityEnrollment?{provider,providerLinkCount:provider==='google'?1:0}:{})}}
 :{browserResponse:response,lifecycleWitness:witness};
const invalidEvidence=publication?{...evidence,browserResponse:{...evidence.browserResponse,readiness:{...evidence.browserResponse.readiness,requestId:target}}}
 :changesExisting?{...evidence,browserResponses:{...evidence.browserResponses,winner:{...evidence.browserResponses.winner,requestId:target}}}
 :authoring?{...evidence,browserResponse:{...evidence.browserResponse,requestId:target}}
 :identity?{...evidence,identityWitness:{...evidence.identityWitness,actorId:target}}
 :{...evidence,browserResponse:{...response,unexpected:'fixture-forbidden'}};
let handle;
const result=start()(async(_verify,_signal,host)=>{
 await assert.rejects(host.interactiveStage(browser));
 await host.arm({receipt,probe:{}});
 handle=await host.interactiveStage(browser);
 assert.deepEqual(Object.keys(handle),[]);
 assert.throws(()=>readP2CertificationInteractiveStage(handle,{...plan}));
 const stage=readP2CertificationInteractiveStage(handle,plan);
 if(authoring) await assert.rejects(stage.observe());
 else assert.equal(stage.observe,undefined);
 await assert.rejects(host.interactiveStage(browser));
 await assert.rejects(host.gatewayStage('browser'));
 await assert.rejects(host.nativeControl.setEnabled(plan.nativePlan,true));
 await assert.rejects(host.prepareClose({status:status('JOINED')}));
 await assert.rejects(stage.installPermit());
 assert.equal((await stage.prepare()).status,status('PREPARED'));
 await assert.rejects(stage.prepare());
 assert.equal((await stage.open()).status,status('OPENED'));
 if(installFailure){
  await assert.rejects(stage.installPermit(),{message:'P2_CERTIFICATION_INTERACTIVE_PERMIT_INSTALL_FAILED'});
  await assert.rejects(stage.installPermit());
  assert.deepEqual(await stage.fence(),fenced);
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-fence');
 }
 const ack=await stage.installPermit();
 assert.deepEqual(Object.keys(ack).sort(),['bindingSha256','challenge','context','epoch','expires','stage','type']);
 assert.equal(ack.context,context);
 await assert.rejects(stage.installPermit());
 await assert.rejects(stage.retain(evidence));
 if(authoring&&!skipObserve){
  if(observeFailure) await assert.rejects(stage.observe(),{message:'P2_CERTIFICATION_INTERACTIVE_AUTHORING_OBSERVE_FAILED'});
  else {
   const observed=await stage.observe();
   assert.equal(observed.status,status('GATEWAY_OBSERVED'));
   const mutation=observed.gatewayAcknowledgements.find(row=>row.requestIndex===1);
   assert.equal(mutation.requestId,requestId);
   if(changesExisting) assert.equal(observed.gatewayAcknowledgements.at(-1).requestId,staleRequestId);
   if(published) assert.equal(observed.gatewayAcknowledgements[2].requestId,staleRequestId);
   mutation.requestId=target;
  }
  await assert.rejects(stage.observe());
 }
 assert.deepEqual(await stage.fence(),fenced);
 await assert.rejects(stage.fence());
 if(observeFailure||skipObserve){
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-fence');
 }
 await assert.rejects(stage.retain(invalidEvidence));
 if(authoring){
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,revision:evidence.courseWitness.revision+1}}));
  await assert.rejects(stage.retain({...evidence,gatewayEvidence:{}}));
 }
 if(publication){
  for(const changed of [{issueCodes:['UNREVIEWED']},{status:published?'draft':'published'},{revision:publicationBody.revision+1}]){
   const body={...publicationBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...body,readOnly:true}}));
  }
  const publication=published?{...publicationStep,requestId:target}:publicationStep;
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,publication}}));
 }
 if(createCurriculum){
  for(const changed of [
   {slug},{kind:kind==='module'?'lesson':'module'},{status:'draft'},{courseId:target},
   {parentId:'12345678-1234-4123-8123-000000000011'},{itemId:'invalid-item'},{revision:draft.revision+1},
  ]){
   const body={...draft,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...body,readOnly:true}}));
  }
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,itemId:target}}));
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,pathname:coursePath}}));
 }
 if(changesExisting){
  for(const changed of [{[staleProof]:false},{requestId},{outcome:'invalid_request'},{status:400},{body:{code:'conflict'}}]){
   await assert.rejects(stage.retain({...evidence,browserResponses:{...evidence.browserResponses,
    stale:{...evidence.browserResponses.stale,...changed}}}));
  }
 }
 if(reorder){
  const {winner}=evidence.browserResponses;
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,ids:[...ids].reverse()}}));
  for(const changed of [{keyboardActivated:false},{pathname:coursePath},{body:{...draft,parentId:'12345678-1234-4123-8123-000000000010'}}]){
   await assert.rejects(stage.retain({...evidence,browserResponses:{...evidence.browserResponses,winner:{...winner,...changed}}}));
  }
  for(const invalidIds of [[...ids].reverse(),ids.slice(0,2),[ids[0],ids[1],ids[1]],['invalid',...ids.slice(1)]]){
   const body={...draft,ids:invalidIds};
   await assert.rejects(stage.retain({browserResponses:{...evidence.browserResponses,winner:{...winner,body}},courseWitness:{...body,readOnly:true}}));
  }
 }
 if(identityEnrollment){
  for(const changed of [
   {provider:provider==='google'?'resend':'google'},
   {providerLinkCount:provider==='google'?0:1},
   {liveSessionCount:2},
  ]) await assert.rejects(stage.retain({...evidence,identityWitness:{...evidence.identityWitness,...changed}}));
 }
 if(['wrong-join','wrong-item-join'].includes(behavior)){
  await assert.rejects(stage.retain(evidence),{message:'P2_CERTIFICATION_TRANSPORT_REFUSED'});
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-mismatched-join');
 }
 const retained=await stage.retain(evidence);
 assert.equal(retained.status,status('JOINED'));
 if(authoring){
  if(publication){
   assert.equal(retained.readinessGatewayRequestId,requestId);
   assert.equal(retained.outcome,outcomeKind);
   assert.equal(retained.revision,publicationBody.revision);
   assert.deepEqual(retained.issueCodes,issueCodes);
   if(published) assert.equal(retained.gatewayPatchRequestId,staleRequestId);
   else assert.ok(!Object.hasOwn(retained,'gatewayPatchRequestId'));
  }else if(reorder){
   assert.deepEqual(retained.gatewayPostRequestIds,[requestId,staleRequestId]);
   assert.equal(retained.parentId,parentId);
   assert.equal(retained.kind,kind);
  }else if(editing) assert.deepEqual(retained.gatewayPatchRequestIds,[requestId,staleRequestId]);
  else assert.equal(retained.gatewayPostRequestId,requestId);
  assert.equal(retained.courseId,draft.courseId);
  if(createCurriculum){
   assert.equal(retained.itemId,itemId);
   assert.equal(retained.slug,slug);
   assert.equal(retained.childSlug,childSlug);
   assert.equal(retained.revision,draft.revision);
  }
 }
 if(identity){
  assert.equal(retained.context,context);
  assert.equal(retained.actorId,observedActor.actorId);
 }
 await assert.rejects(stage.retain(evidence));
 await assert.rejects(host.prepareClose({...retained,actorId:target}));
 await host.prepareClose(retained);await host.finish(outcome);
 return 'fixture-joined';
});
if(behavior!=='joined'){
 await assert.rejects(result,{message:'P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW'});
 assert.equal(existsSync(join(directory,'p2-host-certification-outcome.json')),false);
}else{
 assert.equal(await result,'fixture-joined');
 assert.deepEqual(JSON.parse(readFileSync(join(directory,'p2-host-certification-outcome.json'))),outcome);
}
assert.equal(starts,1);assert.equal(installCount,refusedPermit?0:1);
if(privatePacket) assert.ok(!Object.hasOwn(privatePacket,'cookie'));
assert.throws(()=>readP2CertificationInteractiveStage(handle,plan));
assert.deepEqual(writes.filter(row=>row.operation?.startsWith('interactive-')).map(row=>row.operation),
 ['interactive-prepare','interactive-open','interactive-permit',...(authoring&&!installFailure&&!skipObserve?['interactive-observe']:[]),
  'interactive-fence',...(installFailure||observeFailure||skipObserve?[]:['interactive-retain'])]);
assert.ok(!/v[12]\.8\.|fixture-forbidden/u.test(JSON.stringify(writes)));
`;

for(const [certificationStage,actorKind,behavior,variant] of [
 ['lifecycle','admin','joined'],
 ['lifecycle','customer','install-failure'],
 ['identity','admin','joined'],
 ['identity','customer','joined'],
 ['identity','customer','wrong-kind'],
 ['identity','customer','wrong-selector'],
 ['identity','admin','wrong-join'],
 ['identity','customer','joined','google'],
 ['identity','customer','joined','resend'],
 ['identity','customer','wrong-nonce','google'],
 ['identity','customer','wrong-provider','resend'],
 ['identity','customer','wrong-email','resend'],
 ['identity','customer','wrong-join','google'],
 ['authoring','admin','joined'],
 ['authoring','admin','wrong-owner'],
 ['authoring','admin','legacy-permit'],
 ['authoring','admin','fence-without-observe'],
 ['authoring','admin','observe-refused'],
 ['authoring','admin','wrong-observe-hash'],
 ['authoring','admin','wrong-observe-ack'],
 ['authoring','admin','wrong-join'],
 ['authoring','admin','joined','edit-and-stale-draft'],
 ['authoring','admin','wrong-owner','edit-and-stale-draft'],
 ['authoring','admin','wrong-operation-permit','edit-and-stale-draft'],
 ['authoring','admin','wrong-observe-order','edit-and-stale-draft'],
 ['authoring','admin','wrong-observe-ack','edit-and-stale-draft'],
 ['authoring','admin','wrong-join','edit-and-stale-draft'],
 ['authoring','admin','joined','reorder-module'],
 ['authoring','admin','joined','reorder-lesson'],
 ['authoring','admin','wrong-owner','reorder-module'],
 ['authoring','admin','wrong-operation-permit','reorder-lesson'],
 ['authoring','admin','wrong-observe-order','reorder-module'],
 ['authoring','admin','wrong-join','reorder-lesson'],
 ['authoring','admin','joined','create-module'],
 ['authoring','admin','joined','create-lesson'],
 ['authoring','admin','wrong-owner','create-module'],
 ['authoring','admin','wrong-operation-permit','create-lesson'],
 ['authoring','admin','wrong-observe-order','create-module'],
 ['authoring','admin','wrong-observe-ack','create-lesson'],
 ['authoring','admin','wrong-item-join','create-lesson'],
 ['authoring','admin','joined','publication-published'],
 ['authoring','admin','joined','publication-blocked'],
 ['authoring','admin','wrong-owner','publication-published'],
 ['authoring','admin','wrong-outcome-permit','publication-blocked'],
 ['authoring','admin','wrong-observe-order','publication-published'],
 ['authoring','admin','wrong-observe-ack','publication-blocked'],
 ['authoring','admin','unexpected-patch-ack','publication-blocked'],
 ['authoring','admin','wrong-join','publication-published'],
]){
 test(`fixed interactive transport handles ${certificationStage} ${variant??actorKind} ${behavior} over the guarded pipe`,()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-interactive-wire-')));chmodSync(directory,0o700);
  try{
   // Subprocess-local imports project the source-owned recorder and fixed SSH
   // launch onto a synthetic recorder and actual Python pipes. The transport
   // runs with its ordinary launch argument and retains no test-only bypass.
   const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',interactiveHarness],{
    input:JSON.stringify({certificationStage,actorKind,behavior,variant,directory,profile,program:interactiveProgram,
      transportUrl:new URL('./p2-certification-transport.mjs',import.meta.url).href,
      browserUrl:new URL('./p2-lifecycle-suspension-evidence.mjs',import.meta.url).href}),encoding:'utf8',timeout:20_000,
   });
   assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
   assert.equal(result.stdout,'');
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
}
test('actual remote process death aborts before case mutation and retains no success receipt',async()=>{
 const f=fixture('death');let continued=false;try{await assert.rejects(f.factory(async(_verify,signal,host)=>{await host.arm({receipt:f.receipt,probe:{}});continued=true;assert.equal(signal.aborted,false);}));
  assert.equal(continued,false);assert.equal(existsSync(join(f.directory,'p2-host-certification-outcome.json')),false);
 }finally{f.cleanup();}
});

test('profiled transport selects only the fixed host entry and retains success after a zero exit',async()=>{
 for(const behavior of ['ready','bad-reap']){
  const f=fixture(behavior,true);
  try{
   const outcome=f.factory(async(_verify,_signal,host)=>{
    assert.equal(host.mode,'p2-bounded-certification-profiled-current');
    await host.arm({receipt:f.receipt,probe:{}});
    await host.prepareClose({status:'P2_OWNED_FIXTURE'});await host.finish(f.outcome);
   });
   if(behavior==='ready'){
    await outcome;assert.deepEqual(JSON.parse(readFileSync(join(f.directory,'p2-host-certification-outcome.json'))),f.outcome);
   }else{
    await assert.rejects(outcome);assert.equal(existsSync(join(f.directory,'p2-host-certification-outcome.json')),false);
   }
   assert.ok(f.getCaptured().args.some(value=>value.includes('--supervisor-profiled-current')));
   assert.equal(JSON.stringify(f.getCaptured()).includes('fixture-private-stdin-only'),false);
  }finally{f.cleanup();}
 }
});
