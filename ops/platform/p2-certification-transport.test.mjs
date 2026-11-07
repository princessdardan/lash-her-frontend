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
authoring=stage=='authoring';learning=stage=='learning';paid_grant=stage=='paid-grant';gateway_observation=None
learner_access=stage=='learner-access';access_action=action.get('learnerAccessAction',{})
paid_revoke=stage=='paid-revoke';revoke_action=action.get('paidRevokeAction',{})
lesson_entry=stage=='lesson-entry';entry_action=action.get('lessonEntryAction',{})
lesson_denial=stage=='lesson-denial';denial_action=action.get('lessonDenialAction',{})
assessment=stage=='lesson-assessment';assessment_action=action.get('assessmentAction',{})
resume=stage=='lesson-resume';resume_action=action.get('resumeAction',{})
restore=stage=='lesson-restore';restore_action=action.get('restoreAction',{})
ack_loss=stage=='lesson-ack-loss';ack_loss_action=action.get('ackLossAction',{})
exit_save=stage=='lesson-exit-save';exit_save_action=action.get('exitSaveAction',{})
visibility=stage=='lesson-visibility-save';visibility_action=action.get('visibilityAction',{})
gateway_scoped=authoring or learning or paid_grant or learner_access or paid_revoke or lesson_entry or lesson_denial or assessment or resume or restore or ack_loss or exit_save or visibility
access_outcome=access_action.get('outcome')
access_status={'allowed':200,'archived':410,'draft':404,'restricted':403}.get(access_outcome)
learning_action=action.get('learningAction',{});paid_grant_action=action.get('paidGrantAction',{})
replay=learning_action.get('operation')=='replay-free-enrollment'
authoring_action=action.get('authoringAction',{})
editing=authoring_action.get('operation')=='edit-and-stale-draft'
reorder=authoring_action.get('operation')=='reorder-and-stale-curriculum'
create_curriculum=authoring_action.get('operation')=='create-curriculum'
republish=authoring_action.get('operation')=='republish-paid-course'
publication=republish or authoring_action.get('operation')=='qualify-publication'
published=publication and authoring_action['outcome']=='published'
quiz=authoring_action.get('operation')=='save-quiz-revision'
archive=authoring_action.get('operation')=='archive-paid-course'
prior_status=404 if quiz and authoring_action['quizRevision']==0 else 200
changes_existing=editing or reorder
def fixture_id(suffix):return f'12345678-1234-4123-8123-{suffix:012d}'
def activation(event_id):
 return {'streamId':fixture_id(29),'streamVersion':1,'eventId':event_id,'canonicalDigest':'5'*64,'state':'active'}
post_request=fixture_id(4);stale_request=fixture_id(6)
readiness_request=fixture_id(27) if republish else post_request
initial_time=int(time.time());expires=initial_time+120
def iso(seconds):return datetime.fromtimestamp(seconds,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def send(value):print(json.dumps(value),flush=True)
def status(disposition):return 'P2_INTERACTIVE_'+stage.upper().replace('-','_')+'_'+disposition
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
   value['receipt']={**base,'status':status('OPENED'),'epoch':epoch,'expiresAt':iso(expires),'gatewayScoped':gateway_scoped}
  elif op=='interactive-permit':
   assert phase=='opened';phase='issued'
   selector='f'*64;nonce='e'*32
   if learning:
    learner=fixture_id(2) if behavior=='wrong-learner' else action['actorId']
    key=fixture_id(2) if behavior=='wrong-idempotency-key' else learning_action['idempotencyKey']
    selector=learner.replace('-','')+key.replace('-','')
   elif paid_grant or paid_revoke:
    owner=fixture_id(2) if behavior=='wrong-owner' else action['actorId']
    key=fixture_id(2) if behavior=='wrong-idempotency-key' else (revoke_action if paid_revoke else paid_grant_action)['idempotencyKey']
    selector=owner.replace('-','')+key.replace('-','')
   elif lesson_entry or lesson_denial or assessment or resume or restore or ack_loss or exit_save or visibility:
    selected_lesson=entry_action if lesson_entry else denial_action if lesson_denial else assessment_action if assessment else resume_action if resume else restore_action if restore else ack_loss_action if ack_loss else exit_save_action if exit_save else visibility_action
    learner=fixture_id(2) if behavior=='wrong-learner' else action['actorId']
    course=fixture_id(2) if behavior=='wrong-lesson-course' else selected_lesson['courseId']
    lesson=fixture_id(5) if behavior=='wrong-lesson' else selected_lesson['lessonId']
    selector=(learner+course+lesson).replace('-','')
   elif learner_access:
    learner=fixture_id(3) if behavior=='wrong-learner' else action['actorId']
    lesson=fixture_id(3) if behavior=='wrong-lesson' else access_action['lessonId']
    selector=learner.replace('-','')+lesson.replace('-','')
   elif authoring:
    owner_id=action['actorId']
    if behavior=='wrong-owner':owner_id=fixture_id(2)
    prefix='7032712d617574686f72696e672d7631'
    if behavior!='wrong-operation-permit':
     if reorder:prefix='7032712d617574682d736f72742d7631'
     elif editing:prefix='7032712d617574682d656469742d7631'
     elif create_curriculum:prefix='7032712d617574682d6e65772d763100'
     elif quiz:prefix='7032712d617574682d7175697a2d7631'
     elif archive:prefix='7032712d617574682d6172632d763100'
     elif publication:
      publish_selector=published if behavior!='wrong-outcome-permit' else not published
      if republish:prefix='7032712d617574682d7265702d763100' if publish_selector else '7032712d617574682d72626c2d763100'
      else:prefix='7032712d617574682d7075622d763100' if publish_selector else '7032712d617574682d7264792d763100'
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
   assert gateway_scoped and phase=='issued';phase='observed'
   if behavior=='observe-refused':
    value['receipt']={**base,'status':status('GATEWAY_OBSERVATION_REFUSED')}
   else:
    selected=[(11,13,0,200),(12,14,0,200),(4,15,1,200),(16,17,0,200),(6,18,2,409)] if changes_existing else [(11,13,0,200),(4,12,1,201)]
    if create_curriculum:selected.append((16,17,0,200))
    if archive:selected=[(11,13,0,200),(4,12,1,200),(16,17,0,200)]
    if publication:
     selected=[(11,13,0,200),(4,12,1,200)]
     if republish:selected.extend([(16,17,0,200),(27,28,2,200)])
     if published:selected.extend([(6,18,3 if republish else 2,200),(22,24,0,200)])
     if behavior=='unexpected-patch-ack':selected.append((6,18,3 if republish else 2,200))
    if quiz:
     observed_prior=(200 if prior_status==404 else 404) if behavior=='wrong-prior-status' else prior_status
     selected=[(11,13,0,200),(4,12,1,observed_prior),(6,18,2,200),(16,17,0,200)]
    if learning:
     selected=[(11,13,0,200),(12,14,1,403),(4,15,2,201),(16,17,1,200),(6,18,3,200)]
     if replay:
      selected=[(11,13,0,200),(12,14,1,200),(4,15,2,200)]
      if behavior=='joined-progress-first':selected[0],selected[1]=selected[1],selected[0]
     elif behavior=='joined-progress-first':selected[3],selected[4]=selected[4],selected[3]
     if behavior=='wrong-learning-tail':selected[4]=(6,18,1,200)
    if paid_grant:
     selected=[(11,13,0,200),(12,14,1,200),(16,17,0,200),(4,15,2,201),(21,23,1,200),(6,18,3,200),(22,24,0,200)]
    if paid_revoke:
     selected=[(11,13,0,200),(12,14,1,200),(16,17,0,200),(21,23,2,200),(4,15,3,200),(6,18,1,200),(22,24,2,200),(25,26,0,200)]
    if learner_access:
     selected=[(11,13,0,access_status),(12,14,1,access_status)]+[
      (30+index,40+index,route,access_status) for index,route in enumerate((0,2,3,4,5,6))]
     if behavior=='joined-progress-first':selected[0],selected[1]=selected[1],selected[0]
    if lesson_entry:
     selected=[(40+index,60+index,route,200) for index,route in enumerate((0,1,0,2,3,4,5,6,7))]
     if behavior=='joined-progress-first':
      selected=selected[:2][::-1]+selected[2:7][::-1]+selected[7:][::-1]
    if lesson_denial:
     order=(0,1,2,3,4,0,1,2,3,4,1,5,2,3,4)
     if behavior=='joined-progress-first':order=order[:5][::-1]+order[5:10][::-1]+order[10:]
     selected=[(70+index,90+index,route,403) for index,route in enumerate(order)]
    if assessment:
     order=(0,1,2,3,4,5,6,7,2,8,2)
     if behavior=='joined-progress-first':order=order[:5][::-1]+order[5:7][::-1]+order[7:]
     selected=[(100+index,120+index,route,404 if route==5 else 200) for index,route in enumerate(order)]
    if resume or restore:
     order=tuple(range(10 if resume else 8))
     if behavior=='joined-progress-first':order=order[:5][::-1]+order[5:7][::-1]+order[7:]
     selected=[(150+index,170+index,route,200) for index,route in enumerate(order)]
    if ack_loss:
     order=(0,1,2,3,4,5,6,7,8,2,0,1,2,3,4,5,9,10)
     if behavior=='joined-progress-first':
      order=order[:5][::-1]+order[5:7][::-1]+order[7:10]+order[10:15][::-1]+order[15:17][::-1]+order[17:]
     selected=[(200+index,230+index,route,200) for index,route in enumerate(order)]
    if exit_save:
     order=(4,3,2,1,0,6,5,7,8,9,0) if behavior=='joined-progress-first' else (0,1,2,3,4,5,6,7,0,8,9)
     selected=[(260+index,280+index,route,200) for index,route in enumerate(order)]
    if visibility:
     order=(4,3,2,1,0,6,5,7,8) if behavior=='joined-progress-first' else tuple(range(9))
     selected=[(310+index,330+index,route,200) for index,route in enumerate(order)]
    acks=[{'requestId':fixture_id(req),'proofRequestId':fixture_id(proof),'requestIndex':index,'upstreamStatus':http}
     for req,proof,index,http in selected]
    if behavior=='wrong-observe-ack':acks[3 if paid_grant else -1 if changes_existing else 1]['upstreamStatus']=201 if publication or archive else 200
    if replay and behavior=='wrong-observe-ack':acks[2]['upstreamStatus']=201
    if paid_revoke and behavior=='wrong-observe-ack':acks[4]['upstreamStatus']=201
    if lesson_entry and behavior=='wrong-observe-ack':acks[-1]['upstreamStatus']=201
    if assessment and behavior=='wrong-observe-ack':
     next(row for row in acks if row['requestIndex']==5)['upstreamStatus']=200
    if assessment and behavior=='wrong-observe-order':acks[7],acks[9]=acks[9],acks[7]
    if (resume or restore or ack_loss or visibility) and behavior=='wrong-observe-ack':acks[-1]['upstreamStatus']=409
    if resume and behavior=='wrong-observe-order':acks[7],acks[9]=acks[9],acks[7]
    if restore and behavior=='wrong-observe-order':acks[6],acks[7]=acks[7],acks[6]
    if (lesson_entry or lesson_denial or assessment or resume or restore or ack_loss or visibility) and behavior=='duplicate-lesson-ack':acks[-1]['proofRequestId']=acks[-2]['proofRequestId']
    if ack_loss and behavior=='duplicate-request-ack':acks[9]['requestId']=acks[8]['requestId']
    if ack_loss and behavior=='swap-recovery-ack':acks[8],acks[9]=acks[9],acks[8]
    if exit_save and behavior=='early-final-exit-ack':acks[7],acks[8]=acks[8],acks[7]
    if exit_save and behavior=='duplicate-final-exit-ack':acks[10]['requestIndex']=acks[9]['requestIndex']
    if visibility and behavior=='early-final-visibility-ack':acks[7],acks[8]=acks[8],acks[7]
    if visibility and behavior=='duplicate-final-visibility-ack':acks[8]['requestIndex']=acks[7]['requestIndex']
    if visibility and behavior=='unexpected-outline-ack':acks[8]['requestIndex']=9
    if lesson_denial and behavior=='wrong-observe-order':acks[10],acks[11]=acks[11],acks[10]
    if learner_access and behavior=='wrong-access-status':acks[-1]['upstreamStatus']=403 if access_status==200 else 200
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
   if lesson_entry:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    assert response['page']=={'pathname':'/academy/courses/'+entry_action['courseId']+'/lessons/'+entry_action['lessonId'],'flight':True}
    assert response['playback']['requestId']==fixture_id(47) and response['progress']['requestId']==fixture_id(48)
    assert witness['playbackExpiresAt']==max(response['playback']['expiresAt'],response['playback']['thumbnailExpiresAt'])
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'open-lesson',
     'playbackGatewayRequestId':fixture_id(47),'progressGatewayRequestId':fixture_id(48),
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['progressGatewayRequestId']=fixture_id(47)
   elif lesson_denial:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    course_id,lesson_id=denial_action['courseId'],denial_action['lessonId']
    acks=gateway_observation['gatewayAcknowledgements']
    document_id=next(row['requestId'] for row in acks[:5] if row['requestIndex']==0)
    flight_id=next(row['requestId'] for row in acks[5:10] if row['requestIndex']==0)
    assert response['page']=={'pathname':'/academy/courses/'+course_id+'/lessons/'+lesson_id,'documentStatus':200,'flightStatus':200,
     'documentRequestId':document_id,'flightRequestId':flight_id}
    lesson='/api/academy/lessons/'+lesson_id
    targets=[lesson,lesson+'/playback','/api/academy/progress?lessonId='+lesson_id,lesson+'/quiz',lesson+'/quiz/attempts']
    assert response['reads']==[{'target':target,'status':403,'requestId':fixture_id(80+index),'code':'access_required'}
     for index,target in enumerate(targets)]
    assert witness=={**{key:denial_action[key] for key in ('courseId','lessonId','enrolledActorId','grantId')},
     'actorId':action['actorId'],'effectiveAccess':False,'readOnly':True}
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'deny-cross-account',
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['enrolledActorId']=action['actorId']
   elif learner_access:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    course_id,lesson_id=access_action['courseId'],access_action['lessonId'];allowed=access_outcome=='allowed'
    page='/academy/courses/'+course_id;lesson='/api/academy/lessons/'+lesson_id
    assert response['page']=={'pathname':page,'status':200,'lessonLink':allowed}
    assert body=={'courseId':course_id,'lessonId':lesson_id,'outcome':access_outcome}
    targets=['/api'+page,lesson,lesson+'/playback','/api/academy/progress?lessonId='+lesson_id,lesson+'/quiz',lesson+'/quiz/attempts']
    code={'allowed':None,'archived':'course_archived','draft':'not_found','restricted':'access_revoked'}[access_outcome]
    assert response['reads']==[{'target':target,'status':access_status,'requestId':fixture_id(30+index),'code':code}
     for index,target in enumerate(targets)]
    assert witness=={**body,'actorId':action['actorId'],'grantId':access_action['grantId'],'revision':access_action['revision'],
     'effectiveAccess':allowed,'readOnly':True}
    joined={'actorId':action['actorId'],'operation':'observe-paid-access',**body,'grantId':witness['grantId'],'revision':witness['revision'],
     'effectiveAccess':allowed,'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['effectiveAccess']=not allowed
   elif paid_revoke:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    course_id=revoke_action['courseId'];remaining=revoke_action['remainingAccess'];transition_id=None if remaining else fixture_id(9)
    assert response=={'method':'POST','pathname':'/api/admin/courses/'+course_id+'/manual-grants/revoke','status':200,
     'requestId':post_request,'body':body}
    assert body=={**{key:revoke_action[key] for key in ('courseId','userId','grantId')},'commandId':fixture_id(20),
     'courseRevision':revoke_action['revision']}
    delivery={'streamId':fixture_id(29),'streamVersion':1 if remaining else 2,'eventId':fixture_id(28) if remaining else transition_id,
     'canonicalDigest':'5'*64,'state':'active' if remaining else 'revoked','independentActiveCount':2,'independentActiveSha256':'7'*64}
    assert witness=={**body,'remainingAccess':remaining,'transitionId':transition_id,'communityDelivery':delivery,'readOnly':True}
    joined={'actorId':action['actorId'],'operation':'revoke-paid-grant',**body,'remainingAccess':remaining,'transitionId':transition_id,'communityDelivery':delivery,
     'gatewayPostRequestId':post_request,'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['transitionId']=fixture_id(9) if remaining else None
    if behavior=='wrong-community-join':joined['communityDelivery']={**delivery,'canonicalDigest':'6'*64}
   elif paid_grant:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    course_id=paid_grant_action['courseId'];user_id=paid_grant_action['userId']
    assert response=={'method':'POST','pathname':'/api/admin/courses/'+course_id+'/manual-grants','status':200,
     'requestId':post_request,'body':body}
    assert body=={'courseId':course_id,'userId':user_id,'commandId':fixture_id(20),
     'grantId':fixture_id(7),'courseRevision':paid_grant_action['revision']}
    prior={'priorGrantId':paid_grant_action['priorGrantId']} if 'priorGrantId' in paid_grant_action else {}
    transition_id=None if prior else fixture_id(9);enrollment_id=fixture_id(8)
    delivery=activation(fixture_id(28) if prior else transition_id)
    assert witness=={**body,'transitionId':transition_id,'enrollmentId':enrollment_id,**prior,'communityDelivery':delivery,'readOnly':True}
    joined={'actorId':action['actorId'],**body,'enrollmentId':enrollment_id,'transitionId':transition_id,**prior,'communityDelivery':delivery,
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],'gatewayPostRequestId':post_request}
    if behavior=='wrong-join':joined['enrollmentId']=fixture_id(2)
    if behavior=='wrong-community-join':joined['communityDelivery']={**delivery,'canonicalDigest':'6'*64}
    if behavior=='wrong-prior-join':joined['priorGrantId']=fixture_id(2)
   elif learning:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    course_id=learning_action['courseId'];academy_path='/academy/courses/'+course_id
    assert response=={'method':'POST','pathname':'/api'+academy_path+'/enrollments','status':200,
     'requestId':post_request,'academyPath':academy_path,'body':body}
    assert body=={'courseId':course_id,'grantId':fixture_id(7),'enrollmentId':fixture_id(8),
     'source':'free','status':'active','idempotentReplay':replay}
    transition_id=fixture_id(9)
    delivery=activation(transition_id)
    assert witness=={**body,'transitionId':transition_id,'communityDelivery':delivery,'readOnly':True}
    joined={'actorId':action['actorId'],'courseId':course_id,'slug':learning_action['slug'],'grantId':body['grantId'],
     'enrollmentId':body['enrollmentId'],'transitionId':transition_id,'communityDelivery':delivery,'browserResponseSha256':digest(response),
     'courseWitnessSha256':digest(witness),'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],
     'gatewayPostRequestId':post_request}
    if replay:
     prior=learning_action['prior']
     assert prior=={'grantId':body['grantId'],'enrollmentId':body['enrollmentId'],'eventId':transition_id,
      'streamId':delivery['streamId'],'canonicalDigest':delivery['canonicalDigest']}
     joined['operation']=learning_action['operation']
    if behavior=='wrong-replay-join':joined.pop('operation')
    if behavior=='wrong-join':joined['transitionId']=fixture_id(2)
    if behavior=='wrong-community-join':joined['communityDelivery']={**delivery,'canonicalDigest':'6'*64}
   elif changes_existing:
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
   elif archive:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    course_id=authoring_action['courseId'];revision=authoring_action['revision']+1
    assert response=={'method':'PATCH','pathname':'/api/admin/courses/'+course_id,'status':200,'requestId':post_request,'body':body,
     'warningObserved':True,'cancelObservedWithoutMutation':True}
    assert body=={'courseId':course_id,'slug':authoring_action['slug'],'revision':revision,'status':'archived'}
    user_id=authoring_action['userId'];grant_id=authoring_action['grantId']
    assert witness=={**body,'userId':user_id,'grantId':grant_id,'historyPreserved':True,'readOnly':True}
    joined={'actorId':action['actorId'],'operation':'archive-paid-course','courseId':course_id,'slug':body['slug'],'revision':revision,
     'userId':user_id,'grantId':grant_id,'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],'gatewayPatchRequestId':post_request}
    if behavior=='wrong-join':joined['gatewayPatchRequestId']=fixture_id(2)
    if behavior=='unexpected-archive-flags':joined['historyPreserved']=True
   elif quiz:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    assert set(response)=={'prior','save','body'}
    pathname='/api/admin/lessons/'+authoring_action['lessonId']+'/quiz'
    assert response['prior']=={'method':'GET','pathname':pathname,'status':prior_status,'requestId':post_request}
    assert response['save']=={'method':'PUT','pathname':pathname,'status':200,'requestId':stale_request}
    assert body=={**{key:authoring_action[key] for key in ('courseId','slug','lessonId','documentSha256')},
     'quizId':fixture_id(10),'revision':authoring_action['revision']+1,'quizRevision':authoring_action['quizRevision']+1}
    assert witness=={**body,'readOnly':True}
    joined={'actorId':action['actorId'],'operation':'save-quiz-revision',**body,'browserResponseSha256':digest(response),
     'courseWitnessSha256':digest(witness),'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],
     'priorGatewayRequestId':post_request,'gatewayPutRequestId':stale_request}
    if behavior=='wrong-join':joined['gatewayPutRequestId']=fixture_id(2)
   elif publication:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];body=response['body'];witness=evidence['courseWitness']
    assert set(response)=={'readiness','body'}|({'publication'} if published else set())|({'draft'} if republish else set())
    assert response['readiness']['requestId']==readiness_request
    assert body=={'courseId':authoring_action['courseId'],'slug':authoring_action['slug'],'revision':authoring_action['revision']+int(published)+int(republish),
     'status':'published' if published else 'draft','issueCodes':authoring_action['issueCodes']}
    joined={'actorId':action['actorId'],'operation':authoring_action['operation'],'courseId':body['courseId'],'slug':body['slug'],
     'outcome':authoring_action['outcome'],'revision':body['revision'],'issueCodes':body['issueCodes'],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256'],'readinessGatewayRequestId':readiness_request}
    history={}
    if republish:
     assert response['draft']['requestId']==post_request
     access=published and authoring_action['expectedAccess']
     history={'userId':authoring_action['userId'],'grantId':authoring_action['grantId'],'historyPreserved':True,'effectiveAccess':access}
     joined.update(userId=history['userId'],grantId=history['grantId'],effectiveAccess=access,draftGatewayRequestId=post_request)
    assert witness=={**body,**history,'readOnly':True}
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
   elif assessment:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    acks=gateway_observation['gatewayAcknowledgements']
    assert response['page']=={'pathname':'/academy/courses/'+assessment_action['courseId']+'/lessons/'+assessment_action['lessonId'],'status':200}
    assert response['playback']['requestId']==next(row['requestId'] for row in acks[5:7] if row['requestIndex']==5)
    assert response['started']['requestId']==next(row['requestId'] for row in acks[5:7] if row['requestIndex']==6)
    assert [(row['requestId'],row['progress']['requestId']) for row in response['attempts']]==[(fixture_id(107),fixture_id(108)),(fixture_id(109),fixture_id(110))]
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'fail-then-pass',
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['attemptIds']=joined['attemptIds'][::-1]
   elif resume:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    acks=gateway_observation['gatewayAcknowledgements']
    assert response['page']=={'pathname':'/academy/courses/'+resume_action['courseId']+'/lessons/'+resume_action['lessonId'],'status':200}
    assert response['playback']['requestId']==next(row['requestId'] for row in acks[5:7] if row['requestIndex']==5)
    assert response['started']['requestId']==next(row['requestId'] for row in acks[5:7] if row['requestIndex']==6)
    assert [row['requestId'] for row in response['writes']]==[fixture_id(index) for index in (157,158,159)]
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'play-and-rewind',
     'playbackGatewayRequestId':response['playback']['requestId'],'startedGatewayRequestId':response['started']['requestId'],
     'positionGatewayRequestIds':[row['requestId'] for row in response['writes']],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['positionGatewayRequestIds'].reverse()
   elif restore:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    acks=gateway_observation['gatewayAcknowledgements']
    assert response['page']=={'pathname':'/academy/courses/'+restore_action['courseId']+'/lessons/'+restore_action['lessonId'],'status':200}
    ids={row['requestIndex']:row['requestId'] for row in acks[5:]}
    assert [response[key]['requestId'] for key in ('playback','started','restored')]==[ids[index] for index in (5,6,7)]
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'restore-resume',
     'playbackGatewayRequestId':ids[5],'startedGatewayRequestId':ids[6],'restoredGatewayRequestId':ids[7],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['restoredGatewayRequestId']=ids[6]
   elif ack_loss:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    acks=gateway_observation['gatewayAcknowledgements']
    assert response['page']=={'pathname':'/academy/courses/'+ack_loss_action['courseId']+'/lessons/'+ack_loss_action['lessonId'],'status':200}
    def request_at(start,end,index):
     return next(row['requestId'] for row in acks[start:end] if row['requestIndex']==index)
    playback_ids=[request_at(5,7,5),request_at(15,17,5)]
    progress_ids=[request_at(5,7,6),acks[7]['requestId'],acks[8]['requestId'],request_at(15,17,9),acks[17]['requestId']]
    recovery_id=acks[9]['requestId']
    assert [row['requestId'] for row in response['playback']]==playback_ids
    assert [row['requestId'] for row in response['writes']]==progress_ids and response['recovery']['requestId']==recovery_id
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':'commit-drop-recover',
     'playbackGatewayRequestIds':playback_ids,'progressGatewayRequestIds':progress_ids,'recoveryGatewayRequestId':recovery_id,
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['recoveryGatewayRequestId']=acks[2]['requestId']
   elif exit_save:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    acks=gateway_observation['gatewayAcknowledgements']
    ids={row['requestIndex']:row['requestId'] for row in acks[5:]}
    destination='/academy/courses/'+exit_save_action['courseId']
    assert response['page']=={'pathname':destination+'/lessons/'+exit_save_action['lessonId'],'status':200}
    assert response['exit']['pathname']==destination
    assert response['playback']['requestId']==ids[5] and [row['requestId'] for row in response['writes']]==[ids[6],ids[7]]
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':exit_save_action['operation'],
     'playbackGatewayRequestId':ids[5],'progressGatewayRequestIds':[ids[6],ids[7],ids[8]],
     'destinationCourseGatewayRequestId':ids[0],'destinationProgressGatewayRequestId':ids[9],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':
     joined['destinationCourseGatewayRequestId']=next(row['requestId'] for row in acks[:5] if row['requestIndex']==0)
   elif visibility:
    assert gateway_observation and set(evidence)=={'browserResponse','courseWitness'}
    response=evidence['browserResponse'];witness=evidence['courseWitness']
    ids={row['requestIndex']:row['requestId'] for row in gateway_observation['gatewayAcknowledgements']}
    assert response['page']=={'pathname':'/academy/courses/'+visibility_action['courseId']+'/lessons/'+visibility_action['lessonId'],'status':200}
    assert response['visibility']=={'sameDocument':True,'trustedHidden':True,'trustedPagehide':False,
     'resumePositionSeconds':7,'maxPositionSeconds':14,'expectedProgressRevision':8}
    assert response['playback']['requestId']==ids[5] and [row['requestId'] for row in response['writes']]==[ids[6],ids[7],ids[8]]
    joined={**{key:value for key,value in witness.items() if key!='readOnly'},'operation':visibility_action['operation'],
     'playbackGatewayRequestId':ids[5],'progressGatewayRequestIds':[ids[6],ids[7],ids[8]],
     'browserResponseSha256':digest(response),'courseWitnessSha256':digest(witness),
     'gatewayEvidenceSha256':gateway_observation['gatewayEvidenceSha256']}
    if behavior=='wrong-join':joined['progressGatewayRequestIds'][-1]=ids[2]
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
    'frontendAdmission':{'epoch':str(int(epoch)+1),'newWork':False,'recovery':False,'active':0,'uncertain':0},
    'frontendOperationCount':(4 if behavior=='unexpected-frontend-operation' else 3) if (exit_save or visibility) else
     (6 if behavior=='unexpected-frontend-operation' else 5) if ack_loss else
     (3 if behavior=='unexpected-frontend-operation' else 2) if restore else
     (5 if behavior=='unexpected-frontend-operation' else 4) if resume else
     (4 if behavior=='unexpected-frontend-operation' else 3) if assessment else
     2 if lesson_entry and behavior=='unexpected-frontend-operation' else
     0 if (learner_access or lesson_denial) and behavior!='unexpected-frontend-operation' else 1}
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
const identity=certificationStage==='identity',authoring=certificationStage==='authoring',learning=certificationStage==='learning';
const replay=learning&&variant==='exact-key-replay';
const paidGrant=certificationStage==='paid-grant',learnerAccess=certificationStage==='learner-access';
const secondPaid=paidGrant&&variant==='second-grant',priorGrantId='12345678-1234-4123-8123-000000000055';
const priorGrant=secondPaid?{priorGrantId}:{};
const paidRevoke=certificationStage==='paid-revoke',lessonEntry=certificationStage==='lesson-entry';
const lessonDenial=certificationStage==='lesson-denial',assessment=certificationStage==='lesson-assessment',resume=certificationStage==='lesson-resume';
const restore=certificationStage==='lesson-restore';
const ackLoss=certificationStage==='lesson-ack-loss';
const exitSave=certificationStage==='lesson-exit-save',spaExit=exitSave&&variant==='spa-navigation';
const visibility=certificationStage==='lesson-visibility-save';
const gatewayScoped=authoring||learning||paidGrant||learnerAccess||paidRevoke||lessonEntry||lessonDenial||assessment||resume||restore||ackLoss||exitSave||visibility;
const provider=identity?variant:undefined,editing=authoring&&variant==='edit-and-stale-draft';
const reorder=authoring&&['reorder-module','reorder-lesson'].includes(variant),changesExisting=editing||reorder;
const createCurriculum=authoring&&['create-module','create-lesson'].includes(variant);
const republish=authoring&&typeof variant==='string'&&variant.startsWith('republish-');
const publication=republish||authoring&&['publication-published','publication-blocked'].includes(variant);
const published=publication&&variant!=='publication-blocked'&&variant!=='republish-blocked';
const expectedAccess=variant!=='republish-published-denied',readinessRequestId=republish?'12345678-1234-4123-8123-000000000027':requestId;
const quiz=authoring&&['quiz-create','quiz-revise'].includes(variant),quizRevision=variant==='quiz-create'?0:3;
const archive=authoring&&variant==='archive-paid-course';
const priorStatus=quizRevision===0?404:200;
const context=actorKind==='admin'?'owner':'learner';
const stageLabel=certificationStage.toUpperCase().replaceAll('-','_');
const status=disposition=>'P2_INTERACTIVE_'+stageLabel+'_'+disposition;
const refusedPermit=['wrong-selector','wrong-kind','wrong-nonce','wrong-provider','wrong-email','wrong-owner','legacy-permit','wrong-operation-permit',
 'wrong-outcome-permit','wrong-learner','wrong-idempotency-key','wrong-lesson','wrong-lesson-course'].includes(behavior);
const installFailure=behavior==='install-failure'||refusedPermit;
const observeFailure=['observe-refused','wrong-observe-hash','wrong-observe-ack','wrong-observe-order','unexpected-patch-ack',
 'wrong-prior-status','wrong-learning-tail','wrong-access-status','duplicate-lesson-ack','duplicate-request-ack','swap-recovery-ack',
 'early-final-exit-ack','duplicate-final-exit-ack','early-final-visibility-ack','duplicate-final-visibility-ack','unexpected-outline-ack'].includes(behavior);
const skipObserve=behavior==='fence-without-observe';
const selection={actorKind,userId:actorKind==='admin'?target:actor,operation:actorKind==='admin'?'suspend':'delete'};
const identityActor={actorKind,actorId:actor};
const identityEnrollment=provider?{provider,emailSha256:'6'.repeat(64),nonce:'9'.repeat(32)}:null;
const observedActor=identityEnrollment?{actorKind:'customer',actorId:'12345678-1234-4123-8123-000000000005'}:identityActor;
const slug='p2q-course-draft',coursePath='/api/admin/courses/'+commandId,courseTarget='/course/v1/admin/courses/'+commandId;
const idempotencyKey='12345678-1234-4123-8123-000000000019';
const grantCommandId='12345678-1234-4123-8123-000000000020',grantRevision=variant==='max-revision'?2_147_483_647:7;
const grantReason='Qualification fixture reason',grantKey='owner-paid:'+idempotencyKey;
const grantPath='/course/v1/admin/entitlements/grants',encodedGrantKey=encodeURIComponent(grantKey);
const academyPath='/academy/courses/'+commandId,student='/course/v1/student',studentCourse=student+'/courses/'+commandId;
const kind=variant?.endsWith('-module')?'module':'lesson',parentId=kind==='module'?commandId:target;
const curriculumPath=kind==='module'?'/courses/'+parentId+'/modules':'/modules/'+parentId+'/lessons';
const reorderPath=curriculumPath+'/reorder',childSlug='p2q-new-child',itemId='12345678-1234-4123-8123-000000000010';
const ids=['12345678-1234-4123-8123-000000000009','12345678-1234-4123-8123-000000000007','12345678-1234-4123-8123-000000000008'];
const activationStreamId='12345678-1234-4123-8123-000000000029',activationDigest='5'.repeat(64);
const replayPrior={grantId:ids[1],enrollmentId:ids[2],eventId:ids[0],streamId:activationStreamId,canonicalDigest:activationDigest};
const learningAction={operation:replay?'replay-free-enrollment':'enroll-free-course',courseId:commandId,slug,idempotencyKey,
 ...(replay?{prior:replayPrior}:{})};
const outcomeKind=published?'published':'blocked',issueCodes=published?[]:['MISSING_LESSONS','MISSING_TITLE'];
const lessonId=target,quizId=itemId,quizPath='/admin/lessons/'+lessonId+'/quiz';
const quizDocument={version:1,mode:'graded',passingPercent:80,questions:[{
 id:ids[0],prompt:'Which choice applies?',options:[{id:ids[1],text:'First'},{id:ids[2],text:'Second'}],correctOptionId:ids[1],feedback:'Review the lesson.',
}]};
const rawHash=body=>createHash('sha256').update(body).digest('hex'),emptyBodySha256=rawHash('');
const paidGrantAction={operation:'grant-paid-access',courseId:commandId,userId:target,revision:grantRevision,
 idempotencyKey,reasonSha256:rawHash(grantReason),...priorGrant};
const remainingAccess=variant==='remaining-access',revokeKey='owner-paid-revoke:'+idempotencyKey;
const paidRevokeAction={operation:'revoke-paid-grant',courseId:commandId,userId:target,grantId:ids[1],revision:grantRevision,
 idempotencyKey,reasonSha256:rawHash(grantReason),remainingAccess};
const learnerAccessAction={operation:'observe-paid-access',courseId:commandId,lessonId,grantId:ids[1],revision:2_147_483_647,outcome:variant};
const lessonEntryAction={operation:'open-lesson',courseId:commandId,lessonId,grantId:ids[1]};
const lessonDenialAction={operation:'deny-cross-account',courseId:commandId,lessonId,enrolledActorId:ids[0],grantId:ids[1]};
const assessmentAction={operation:'fail-then-pass',courseId:commandId,lessonId,grantId:ids[1],quizRevision:4,
 failAnswers:[{questionId:'b',optionId:'fail'},{questionId:'a',optionId:'fail'}],
 passAnswers:[{questionId:'b',optionId:'pass'},{questionId:'a',optionId:'pass'}]};
const resumeAction={operation:'play-and-rewind',courseId:commandId,lessonId,grantId:ids[1]};
const restoreAction={...resumeAction,operation:'restore-resume',prior:{actionId:'prior-resume',outcomeSha256:'3'.repeat(64),
 progressId:staleRequestId,enrollmentId:'12345678-1234-4123-8123-000000000003',resumePositionSeconds:4,maxPositionSeconds:14,
 playbackIdSha256:rawHash('owned-playback'),playbackExpiresAt:'2026-11-07T12:02:00.000Z'}};
const ackLossAction={...resumeAction,operation:'commit-drop-recover',
 progressId:restoreAction.prior.progressId,enrollmentId:restoreAction.prior.enrollmentId,
 resumePositionSeconds:4,maxPositionSeconds:14,playbackIdSha256:restoreAction.prior.playbackIdSha256};
const exitSaveAction={...ackLossAction,operation:variant};
const visibilityAction={...ackLossAction,operation:'hide-active-document'};
const studentLesson=student+'/lessons/'+lessonId;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const documentSha256=rawHash(JSON.stringify(canonical(quizDocument)));
const authoringAction=reorder?{operation:'reorder-and-stale-curriculum',courseId:commandId,slug,revision:7,kind,parentId}:
 editing?{operation:'edit-and-stale-draft',courseId:commandId,slug,revision:7}:
 archive?{operation:'archive-paid-course',courseId:commandId,slug,revision:7,userId:target,grantId:ids[1]}:
 quiz?{operation:'save-quiz-revision',courseId:commandId,slug,revision:7,lessonId,quizRevision,documentSha256}:
 publication?{operation:republish?'republish-paid-course':'qualify-publication',courseId:commandId,slug,revision:7,outcome:outcomeKind,issueCodes,
  ...(republish?{userId:target,grantId:ids[1],expectedAccess}:{})}:
 createCurriculum?{operation:'create-curriculum',courseId:commandId,slug,revision:7,kind,parentId,childSlug}:{operation:'create-draft',slug};
const reorderHash=ids=>rawHash(JSON.stringify({expectedCourseRevision:authoringAction.revision,ids}));
const writeMethod=reorder?'POST':'PATCH',writeTarget=reorder?'/course/v1/admin'+reorderPath:courseTarget;
const publicationRequest={method:'PATCH',target:courseTarget,
 bodySha256:rawHash(JSON.stringify({expectedRevision:authoringAction.revision+Number(republish),status:'published'})),uses:1};
const draftRequest={method:'PATCH',target:courseTarget,
 bodySha256:rawHash(JSON.stringify({expectedRevision:authoringAction.revision,status:'draft'})),uses:1};
const outlineProgressRequest={method:'GET',target:student+'/progress?courseId='+commandId,bodySha256:emptyBodySha256,uses:1};
const requests=exitSave||visibility?[
 ...[studentCourse,studentLesson,student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',
  studentLesson+'/quiz/attempts',studentLesson+'/playback']
  .map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:exitSave&&index===0?2:1})),
 ...[{event:'lesson_started',expectedProgressRevision:6},
  {resumePositionSeconds:4,maxPositionSeconds:14,expectedProgressRevision:7},
  {expectedProgressRevision:8}]
  .map(body=>({method:'POST',target:studentLesson+'/progress',bodySha256:rawHash(JSON.stringify(body)),uses:1})),
 ...(exitSave?[outlineProgressRequest]:[]),
]:ackLoss?[
 ...[studentCourse,studentLesson,student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',
  studentLesson+'/quiz/attempts',studentLesson+'/playback']
  .map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===2?3:2})),
 ...[{event:'lesson_started',expectedProgressRevision:6},
  {resumePositionSeconds:4,maxPositionSeconds:14,expectedProgressRevision:7},
  {resumePositionSeconds:14,maxPositionSeconds:14,expectedProgressRevision:8},
  {event:'lesson_started',expectedProgressRevision:9},
  {resumePositionSeconds:14,maxPositionSeconds:14,expectedProgressRevision:10}]
  .map(body=>({method:'POST',target:studentLesson+'/progress',bodySha256:rawHash(JSON.stringify(body)),uses:1})),
]:resume||restore?[
 ...[studentCourse,studentLesson,student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',
  studentLesson+'/quiz/attempts',studentLesson+'/playback'].map(target=>({method:'GET',target,bodySha256:emptyBodySha256,uses:1})),
 ...(restore?[{event:'lesson_started',expectedProgressRevision:4},
  {resumePositionSeconds:4,maxPositionSeconds:14,expectedProgressRevision:5}]:
  [{event:'lesson_started',expectedProgressRevision:0},...[1,2,3].map(expectedProgressRevision=>({expectedProgressRevision}))])
  .map(body=>({method:'POST',target:studentLesson+'/progress',bodySha256:rawHash(JSON.stringify(body)),uses:1})),
]:assessment?[
 ...[studentCourse,studentLesson,student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',
  studentLesson+'/quiz/attempts',studentLesson+'/playback']
  .map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===2?3:1})),
 {method:'POST',target:studentLesson+'/progress',bodySha256:rawHash('{"event":"lesson_started","expectedProgressRevision":0}'),uses:1},
 ...[assessmentAction.failAnswers,assessmentAction.passAnswers].map(answers=>({method:'POST',target:studentLesson+'/quiz/attempts',
   bodySha256:rawHash(JSON.stringify({quizRevision:assessmentAction.quizRevision,answers})),uses:1})),
]:lessonDenial?[
 studentCourse,studentLesson,student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',
 studentLesson+'/quiz/attempts',studentLesson+'/playback',
].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:[2,3,3,3,3,1][index]})):lessonEntry?[
 ...[studentCourse,student+'/progress?courseId='+commandId,studentLesson,student+'/progress?lessonId='+lessonId,
  studentLesson+'/quiz',studentLesson+'/quiz/attempts',studentLesson+'/playback']
  .map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===0?2:1})),
 {method:'POST',target:studentLesson+'/progress',bodySha256:rawHash('{"event":"lesson_started","expectedProgressRevision":0}'),uses:1},
]:paidRevoke?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:3},
  {method:'GET',target:'/course/v1/admin/entitlements/commands?idempotencyKey='+encodeURIComponent(revokeKey)+'&limit=2',bodySha256:emptyBodySha256,uses:2},
  {method:'GET',target:grantPath+'?grantId='+ids[1]+'&userId='+target+'&courseId='+commandId+'&limit=2',bodySha256:emptyBodySha256,uses:2},
  {method:'POST',target:'/course/v1/admin/entitlements/revocations',bodySha256:rawHash(JSON.stringify({
    scope:'grantId',grantId:ids[1],reason:'[paid-course revision '+grantRevision+'] '+grantReason,idempotencyKey:revokeKey,
  })),uses:1},
]:learnerAccess?[
 studentCourse,student+'/progress?courseId='+commandId,studentLesson,studentLesson+'/playback',
 student+'/progress?lessonId='+lessonId,studentLesson+'/quiz',studentLesson+'/quiz/attempts',
].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===0?2:1})):archive?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:2},
  {method:'PATCH',target:courseTarget,bodySha256:rawHash(JSON.stringify({expectedRevision:authoringAction.revision,status:'archived'})),uses:1},
]:paidGrant?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:3},
  {method:'GET',target:'/course/v1/admin/entitlements/commands?idempotencyKey='+encodedGrantKey+'&limit=2',bodySha256:emptyBodySha256,uses:2},
  {method:'POST',target:grantPath,bodySha256:rawHash(JSON.stringify({
    userId:target,courseId:commandId,reason:'[paid-course revision '+grantRevision+'] '+grantReason,idempotencyKey:grantKey,
  })),uses:1},
  {method:'GET',target:grantPath+'?userId='+target+'&courseId='+commandId+'&idempotencyKey='+encodedGrantKey+'&limit=2',
   bodySha256:emptyBodySha256,uses:1},
]:replay?[
  {method:'GET',target:studentCourse,bodySha256:emptyBodySha256,uses:1},
  {method:'GET',target:student+'/progress?courseId='+commandId,bodySha256:emptyBodySha256,uses:1},
  {method:'POST',target:studentCourse+'/enrollments',bodySha256:rawHash(JSON.stringify({idempotencyKey})),uses:1},
]:learning?[
  {method:'GET',target:'/course/v1/courses/'+slug,bodySha256:emptyBodySha256,uses:1},
  {method:'GET',target:studentCourse,bodySha256:emptyBodySha256,uses:2},
  {method:'POST',target:studentCourse+'/enrollments',bodySha256:rawHash(JSON.stringify({idempotencyKey})),uses:1},
  {method:'GET',target:student+'/progress?courseId='+commandId,bodySha256:emptyBodySha256,uses:1},
]:quiz?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:2},
  {method:'GET',target:'/course/v1'+quizPath,bodySha256:emptyBodySha256,uses:1},
  {method:'PUT',target:'/course/v1'+quizPath,bodySha256:rawHash(JSON.stringify({expectedCourseRevision:authoringAction.revision,document:quizDocument})),uses:1},
]:publication?[
  {method:'GET',target:courseTarget,bodySha256:emptyBodySha256,uses:(published?2:1)+Number(republish)},
  ...(republish?[draftRequest]:[]),
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
  ...(identityEnrollment?{identityEnrollment}:identity?{identityActor}:authoring?{authoringAction}:learning?{learningAction}:
    paidGrant?{paidGrantAction}:learnerAccess?{learnerAccessAction}:paidRevoke?{paidRevokeAction}:
    lessonEntry?{lessonEntryAction}:lessonDenial?{lessonDenialAction}:assessment?{assessmentAction}:resume?{resumeAction}:
    restore?{restoreAction}:ackLoss?{ackLossAction}:exitSave?{exitSaveAction}:visibility?{visibilityAction}:{frontendAction:selection})};
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
   requests[0],{...requests[1],bodySha256:publication||quiz?'1'.repeat(64):emptyBodySha256},...requests.slice(2),
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
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[{...requests[0],uses:requests[0].uses+1},...requests.slice(1)]}}},
  ...(published?[
   {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[...requests.slice(0,-1),{...publicationRequest,bodySha256:'1'.repeat(64)}]}}},
  ]:[
   {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[...requests,publicationRequest]}}},
   ...[['bad'],['DUPLICATE','DUPLICATE'],[...issueCodes].reverse(),Array.from({length:17},(_,index)=>'CODE_'+String(index).padStart(2,'0'))]
    .map(issueCodes=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,issueCodes}}}})),
  ]),
 ]:[]),
 ...(republish?[
  ...[{userId:'invalid'},{grantId:'invalid'},{expectedAccess:1},{revision:2_147_483_646},{bodySha256:'1'.repeat(64)}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,...selected}}}})),
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[2],requests[1],...requests.slice(3)]}}},
  ...(published?[{...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[...requests.slice(0,-1),{
   ...publicationRequest,bodySha256:rawHash(JSON.stringify({expectedRevision:authoringAction.revision,status:'published'})),
  }]}}}]:[]),
 ]:[]),
 ...(quiz?[
  ...[{lessonId:'invalid'}, {quizRevision:-1}, {quizRevision:2_147_483_647}, {quizRevision:1.5},
   {documentSha256:'0'.repeat(64)}, {documentSha256:emptyBodySha256}, {documentSha256:'f'.repeat(63)}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,...selected}}}})),
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[{...requests[0],uses:1},...requests.slice(1)]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...requests[2],method:'PATCH'}]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...requests[2],target:courseTarget}]}}},
  {...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests:[requests[0],requests[1],{...requests[2],bodySha256:emptyBodySha256}]}}},
 ]:[]),
 ...(archive?[
  ...[{revision:0},{revision:2_147_483_647},{userId:'invalid'},{grantId:'invalid'},{idempotencyKey}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,authoringAction:{...authoringAction,...selected}}}})),
  ...[
   [{...requests[0],uses:1},requests[1]],
   [requests[0],{...requests[1],method:'POST'}],
   [requests[0],{...requests[1],target:courseTarget+'/archive'}],
   [requests[0],{...requests[1],bodySha256:rawHash(JSON.stringify({status:'archived',expectedRevision:authoringAction.revision}))}],
   [requests[0],requests[1],requests[1]],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(learning?[
  ...[{idempotencyKey:'invalid'},{idempotencyKey:target},{slug:'invalid/path'},{courseId:target},{operation:'enroll-paid-course'}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,learningAction:{...learningAction,...selected}}}})),
  ...[
   [...requests].reverse(),[requests[0],{...requests[1],uses:requests[1].uses+1},...requests.slice(2)],
   [...requests.slice(0,2),{...requests[2],bodySha256:'1'.repeat(64)},...requests.slice(3)],
   replay?[requests[0],{...requests[1],target:student+'/progress'},requests[2]]:[...requests.slice(0,3),{...requests[3],target:student+'/progress'}],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
  ...(replay?[undefined,null,{...replayPrior,grantId:'invalid'},{...replayPrior,streamId:'invalid'},{...replayPrior,canonicalDigest:'0'.repeat(64)},
   {...replayPrior,streamVersion:1}]:[replayPrior]).map(prior=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,
    learningAction:{...learningAction,prior}}}})),
 ]:[]),
 ...(paidGrant?[
  ...[{idempotencyKey:'invalid'},{idempotencyKey:target},{userId:commandId},{courseId:target},{revision:0},{revision:2_147_483_648},
   {reasonSha256:emptyBodySha256},{reasonSha256:'0'.repeat(64)},{reason:grantReason},{operation:'grant-free-access'},
   {priorGrantId:null},{priorGrantId:'invalid'}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,paidGrantAction:{...paidGrantAction,...selected}}}})),
  ...[
   [...requests].reverse(),[{...requests[0],uses:2},...requests.slice(1)],
   [requests[0],{...requests[1],target:requests[1].target.replace('%3A',':')},...requests.slice(2)],
   [requests[0],{...requests[1],target:requests[1].target+'&commandId='+grantCommandId},...requests.slice(2)],
   [...requests.slice(0,2),{...requests[2],bodySha256:emptyBodySha256},requests[3]],
   [...requests.slice(0,3),{...requests[3],target:grantPath+'?courseId='+commandId+'&userId='+target+'&idempotencyKey='+encodedGrantKey+'&limit=2'}],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(assessment?[
  ...[{quizRevision:0},{quizRevision:2_147_483_648},{operation:'try-pass'},
   {passAnswers:assessmentAction.failAnswers},{passAnswers:assessmentAction.passAnswers.toReversed()},
   {failAnswers:[assessmentAction.failAnswers[0],assessmentAction.failAnswers[0]]},
   {failAnswers:[{questionId:'not valid',optionId:'x'}]}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,assessmentAction:{...assessmentAction,...selected}}}})),
  ...[requests.toReversed(),requests.map((row,index)=>index===2?{...row,uses:2}:row),
   requests.map((row,index)=>index===7?{...row,bodySha256:requests[8].bodySha256}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(resume?[
  ...[{operation:'restore-resume'},{grantId:'invalid'},{pauseSeconds:25}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,resumeAction:{...resumeAction,...selected}}}})),
  ...[requests.toReversed(),requests.map((row,index)=>index===5?{...row,uses:2}:row),
   requests.map((row,index)=>index===7?{...row,bodySha256:requests[8].bodySha256}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(restore?[
  ...[{actionId},{maxPositionSeconds:4},{playbackIdSha256:'0'.repeat(64)},{playbackExpiresAt:'2026-11-07T12:02:00Z'}]
   .map(change=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,
    restoreAction:{...restoreAction,prior:{...restoreAction.prior,...change}}}}})),
  ...[requests.toReversed(),requests.map((row,index)=>index===5?{...row,uses:2}:row),
   requests.map((row,index)=>index===7?{...row,bodySha256:requests[6].bodySha256}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(ackLoss?[
  ...[{operation:'restore-resume'},{progressId:'invalid'},{enrollmentId:'invalid'},{resumePositionSeconds:7},
   {maxPositionSeconds:15},{playbackIdSha256:'0'.repeat(64)}]
   .map(change=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,
    ackLossAction:{...ackLossAction,...change}}}})),
  ...[requests.slice(0,-1),requests.map((row,index)=>index===2?{...row,uses:2}:row),
   requests.map((row,index)=>index===8?{...row,bodySha256:requests[7].bodySha256}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(exitSave?[
  ...[{operation:'commit-drop-recover'},{progressId:'invalid'},{maxPositionSeconds:13}]
   .map(change=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,
    exitSaveAction:{...exitSaveAction,...change}}}})),
  ...[requests.slice(0,-1),requests.map((row,index)=>index===0?{...row,uses:1}:row),
   requests.map((row,index)=>index===8?{...row,bodySha256:rawHash('{"resumePositionSeconds":7,"maxPositionSeconds":14,"expectedProgressRevision":8}')}:row),
   requests.map((row,index)=>index===9?{...row,target:student+'/progress?courseId='+target}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(visibility?[
  ...[{operation:'document-exit'},{progressId:'invalid'},{maxPositionSeconds:15}]
   .map(change=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,
    visibilityAction:{...visibilityAction,...change}}}})),
  ...[requests.slice(0,-1),[...requests,outlineProgressRequest],
   requests.map((row,index)=>index===0?{...row,uses:2}:row),
   requests.map((row,index)=>index===8?{...row,bodySha256:requests[7].bodySha256}:row)]
   .map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(lessonDenial?[
  ...[{enrolledActorId:actor},{lessonId:actor},{courseId:target},{grantId:'invalid'},{operation:'open-lesson'}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,lessonDenialAction:{...lessonDenialAction,...selected}}}})),
  ...[
   [...requests].reverse(),[{...requests[0],uses:1},...requests.slice(1)],requests.slice(0,-1),
   [...requests.slice(0,2),{...requests[2],target:requests[2].target+'&limit=1'},...requests.slice(3)],
   [...requests,{method:'POST',target:studentLesson+'/progress',bodySha256:'8'.repeat(64),uses:1}],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(lessonEntry?[
  ...[{lessonId:actor},{courseId:target},{grantId:'invalid'},{operation:'start-lesson'},{revision:1}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,lessonEntryAction:{...lessonEntryAction,...selected}}}})),
  ...[
   [...requests].reverse(),[{...requests[0],uses:1},...requests.slice(1)],requests.slice(0,-1),
   [...requests.slice(0,-1),{...requests.at(-1),bodySha256:rawHash('{"expectedProgressRevision":0,"event":"lesson_started"}')}],
   [...requests.slice(0,-1),{...requests.at(-1),uses:2}],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(learnerAccess?[
  ...[{lessonId:'invalid'},{courseId:target},{grantId:'invalid'},{revision:0},{revision:2_147_483_648},{outcome:'unknown'},{outcome:['allowed']}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,learnerAccessAction:{...learnerAccessAction,...selected}}}})),
  ...[
   [...requests].reverse(),[{...requests[0],uses:1},...requests.slice(1)],requests.slice(0,-1),
   [...requests.slice(0,-1),{...requests.at(-1),method:'POST'}],
   [...requests.slice(0,4),{...requests[4],target:student+'/progress?courseId='+commandId},...requests.slice(5)],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
 ]:[]),
 ...(paidRevoke?[
  ...[{idempotencyKey:'invalid'},{idempotencyKey:target},{userId:commandId},{courseId:target},{grantId:target},{revision:0},{revision:2_147_483_648},
   {reasonSha256:emptyBodySha256},{reasonSha256:'0'.repeat(64)},{reason:grantReason},{remainingAccess:1},{operation:'grant-paid-access'}]
   .map(selected=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,paidRevokeAction:{...paidRevokeAction,...selected}}}})),
  ...[
   [...requests].reverse(),[{...requests[0],uses:2},...requests.slice(1)],
   [requests[0],{...requests[1],target:requests[1].target.replace('%3A',':')},...requests.slice(2)],
   [...requests.slice(0,2),{...requests[2],uses:1},requests[3]],
   [...requests.slice(0,2),{...requests[2],target:grantPath+'?userId='+target+'&courseId='+commandId+'&grantId='+ids[1]+'&limit=2'},requests[3]],
   [...requests.slice(0,3),{...requests[3],bodySha256:emptyBodySha256}],
  ].map(requests=>({...initial,certificationPlan:{...plan,scopedAction:{...scopedAction,requests}}})),
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
const draftStep={method:'PATCH',pathname:coursePath,status:200,requestId};
const publicationBody={courseId:commandId,slug,revision:authoringAction.revision+Number(published)+Number(republish),status:published?'published':'draft',issueCodes};
const [transitionId,grantId,enrollmentId]=ids;
const activationTransitionId=secondPaid?null:transitionId;
const activationDelivery={
 streamId:activationStreamId,streamVersion:1,
 eventId:secondPaid?'12345678-1234-4123-8123-000000000028':transitionId,canonicalDigest:activationDigest,state:'active',
};
const revokeTransitionId=remainingAccess?null:transitionId;
const communityDelivery={
 streamId:'12345678-1234-4123-8123-000000000029',streamVersion:remainingAccess?1:2,
 eventId:remainingAccess?'12345678-1234-4123-8123-000000000028':revokeTransitionId,canonicalDigest:'5'.repeat(64),
 state:remainingAccess?'active':'revoked',independentActiveCount:2,independentActiveSha256:'7'.repeat(64),
};
const history=republish?{userId:target,grantId,historyPreserved:true,effectiveAccess:published&&expectedAccess}:{};
const quizBody={courseId:commandId,slug,lessonId,quizId,revision:authoringAction.revision+1,quizRevision:quizRevision+1,documentSha256};
const freeBody={courseId:commandId,grantId,enrollmentId,source:'free',status:'active',idempotentReplay:replay};
const grantBody={courseId:commandId,userId:target,commandId:grantCommandId,grantId,courseRevision:grantRevision};
const archiveBody={courseId:commandId,slug,revision:authoringAction.revision+1,status:'archived'};
const accessBody={courseId:commandId,lessonId,outcome:variant},effectiveAccess=variant==='allowed';
const [accessStatus,accessCode]=({allowed:[200,null],archived:[410,'course_archived'],draft:[404,'not_found'],restricted:[403,'access_revoked']})[variant]??[];
const apiLesson='/api/academy/lessons/'+lessonId;
const accessReads=['/api'+academyPath,apiLesson,apiLesson+'/playback','/api/academy/progress?lessonId='+lessonId,apiLesson+'/quiz',apiLesson+'/quiz/attempts']
 .map((target,index)=>({target,status:accessStatus,code:accessCode,requestId:'12345678-1234-4123-8123-'+String(30+index).padStart(12,'0')}));
const lessonPlaybackId='12345678-1234-4123-8123-000000000047',lessonProgressId='12345678-1234-4123-8123-000000000048';
const entryPlayback={requestId:lessonPlaybackId,expiresAt:'2026-11-07T12:10:00.000Z',thumbnailExpiresAt:'2026-11-07T12:10:00.500Z',lifetimeMs:600_000};
const entryProgress={requestId:lessonProgressId,progressId:staleRequestId,enrollmentId,revision:1};
const entryWitness={courseId:commandId,lessonId,grantId,actorId:actor,enrollmentId,progressId:staleRequestId,
 revision:1,playbackExpiresAt:entryPlayback.thumbnailExpiresAt,readOnly:true};
const denialRequestId=index=>'12345678-1234-4123-8123-'+String(70+index).padStart(12,'0');
const denialReads=accessReads.slice(1).map(({target},index)=>({
 target,status:403,code:'access_required',requestId:denialRequestId(index+10),
}));
const denialRenderIndex=behavior==='joined-progress-first'?4:0;
const denialWitness={courseId:commandId,lessonId,enrolledActorId:lessonDenialAction.enrolledActorId,grantId,
 actorId:actor,effectiveAccess:false,readOnly:true};
const assessmentId=index=>denialRequestId(30+index);
const assessmentStarted={requestId:assessmentId(behavior==='joined-progress-first'?5:6),progressId:staleRequestId,enrollmentId,revision:1};
const assessmentAttempts=[false,true].map((passed,index)=>{
 const createdAt='2026-11-07T12:00:0'+(index+1)+'.000Z';
 return {requestId:assessmentId(7+index*2),payloadRequestId:assessmentId(30+index),attemptId:assessmentId(40+index),
  quizRevisionId:assessmentId(42),quizRevision:assessmentAction.quizRevision,correctCount:passed?2:0,totalCount:2,passed,completed:passed,createdAt,
  progress:{requestId:assessmentId(8+index*2),progressId:assessmentStarted.progressId,enrollmentId,revision:2+index,
   completedAt:passed?createdAt:null,completedQuizRevision:passed?assessmentAction.quizRevision:null}};
});
const assessmentWitness={actorId:actor,courseId:commandId,lessonId,grantId,quizRevision:assessmentAction.quizRevision,
 enrollmentId,progressId:assessmentStarted.progressId,attemptIds:assessmentAttempts.map(row=>row.attemptId),progressRevision:3,readOnly:true};
const resumeId=index=>denialRequestId(80+index);
const resumePlayback={...entryPlayback,requestId:resumeId(behavior==='joined-progress-first'?6:5),playbackIdSha256:rawHash('owned-playback')};
const resumeStarted={...entryProgress,requestId:resumeId(behavior==='joined-progress-first'?5:6)};
const resumeWrites=[[10,10],[14,13],[4,14]].map(([resumePositionSeconds,submittedMaxPositionSeconds],index)=>({
 requestId:resumeId(7+index),expectedProgressRevision:index+1,revision:index+2,
 resumePositionSeconds,submittedMaxPositionSeconds,maxPositionSeconds:Math.max(resumePositionSeconds,submittedMaxPositionSeconds),
}));
const resumeMedia={durationSeconds:32,videoWidth:128,heartbeatSeconds:11,pausedSeconds:14,rewoundSeconds:4,
 manifestObserved:true,segmentObserved:true};
const resumeWitness={actorId:actor,courseId:commandId,lessonId,grantId,enrollmentId,progressId:resumeStarted.progressId,
 revision:4,resumePositionSeconds:4,maxPositionSeconds:14,playbackExpiresAt:resumePlayback.thumbnailExpiresAt,
 playbackIdSha256:resumePlayback.playbackIdSha256,readOnly:true};
const restorePlayback={...resumePlayback};
const restoreStarted={...resumeStarted,enrollmentId:restoreAction.prior.enrollmentId,revision:5};
const restored={...restoreStarted,requestId:resumeId(7),revision:6,resumePositionSeconds:4,maxPositionSeconds:14};
const restoreMedia={durationSeconds:32,videoWidth:128,restoredSeconds:4,paused:true,manifestObserved:true,segmentObserved:true};
const restoreWitness={...resumeWitness,enrollmentId:restoreStarted.enrollmentId,revision:6};
const ackLossId=index=>'12345678-1234-4123-8123-'+String(200+index).padStart(12,'0');
const reverseHydration=behavior==='joined-progress-first';
const ackLossPlayback=[reverseHydration?6:5,reverseHydration?16:15].map(index=>({...resumePlayback,requestId:ackLossId(index)}));
const ackLossWrites=[reverseHydration?5:6,7,8,reverseHydration?15:16,17].map((position,index)=>({
 requestId:ackLossId(position),progressId:ackLossAction.progressId,enrollmentId:ackLossAction.enrollmentId,
 revision:7+index,resumePositionSeconds:index<2?4:14,maxPositionSeconds:14,
}));
const ackLossRecovery={...ackLossWrites[2],requestId:ackLossId(9),browserFailure:'connectionreset',unconfirmedObserved:true,noReplay:true};
const ackLossWitness={...restoreWitness,revision:11,resumePositionSeconds:14,maxPositionSeconds:14};
const exitSaveId=index=>'12345678-1234-4123-8123-'+String(260+index).padStart(12,'0');
const exitSaveOrder=reverseHydration?[4,3,2,1,0,6,5,7,8,9,0]:[0,1,2,3,4,5,6,7,0,8,9];
const exitSaveRequestId=index=>exitSaveId(exitSaveOrder.lastIndexOf(index));
const exitSavePlayback={...resumePlayback,requestId:exitSaveRequestId(5)};
const exitSaveWrites=[6,7].map((index,offset)=>({
 requestId:exitSaveRequestId(index),progressId:exitSaveAction.progressId,enrollmentId:exitSaveAction.enrollmentId,
 revision:7+offset,resumePositionSeconds:4,maxPositionSeconds:14,
}));
const exitReceipt={pathname:academyPath,status:200,sameDocument:spaExit,trustedPagehide:!spaExit,trustedHidden:!spaExit,
 resumePositionSeconds:7,maxPositionSeconds:14,expectedProgressRevision:8};
const exitSaveWitness={...restoreWitness,revision:9,resumePositionSeconds:7,maxPositionSeconds:14};
const visibilityOrder=reverseHydration?[4,3,2,1,0,6,5,7,8]:[0,1,2,3,4,5,6,7,8];
const visibilityRequestId=index=>'12345678-1234-4123-8123-'+String(310+visibilityOrder.indexOf(index)).padStart(12,'0');
const visibilityPlayback={...resumePlayback,requestId:visibilityRequestId(5)};
const visibilityWrites=[6,7,8].map((index,offset)=>({
 requestId:visibilityRequestId(index),progressId:visibilityAction.progressId,enrollmentId:visibilityAction.enrollmentId,
 revision:7+offset,resumePositionSeconds:index===8?7:4,maxPositionSeconds:14,
}));
const visibilityReceipt={sameDocument:true,trustedHidden:true,trustedPagehide:false,
 resumePositionSeconds:7,maxPositionSeconds:14,expectedProgressRevision:8};
const evidence=visibility?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},
 playback:visibilityPlayback,writes:visibilityWrites,visibility:visibilityReceipt,
 media:{playedSeconds:7,playing:true,manifestObserved:true,segmentObserved:true}},courseWitness:exitSaveWitness}
 :exitSave?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},
 playback:exitSavePlayback,writes:exitSaveWrites,exit:exitReceipt,media:{playedSeconds:7,playing:true,manifestObserved:true,segmentObserved:true}},
 courseWitness:exitSaveWitness}
 :ackLoss?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},playback:ackLossPlayback,
 writes:ackLossWrites,recovery:ackLossRecovery,media:{beforeSeconds:4,afterSeconds:14,paused:true,manifestObserved:true,segmentObserved:true}},
 courseWitness:ackLossWitness}
 :restore?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},playback:restorePlayback,
 started:restoreStarted,restored,media:restoreMedia},courseWitness:restoreWitness}
 :resume?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},playback:resumePlayback,
 started:resumeStarted,writes:resumeWrites,media:resumeMedia},courseWitness:resumeWitness}
 :assessment?{browserResponse:{page:{pathname:academyPath+'/lessons/'+lessonId,status:200},
 playback:{requestId:assessmentId(behavior==='joined-progress-first'?6:5),status:404},started:assessmentStarted,attempts:assessmentAttempts},
 courseWitness:assessmentWitness}:lessonDenial?{browserResponse:{
 page:{pathname:academyPath+'/lessons/'+lessonId,documentStatus:200,flightStatus:200,
  documentRequestId:denialRequestId(denialRenderIndex),flightRequestId:denialRequestId(denialRenderIndex+5)},reads:denialReads,
},courseWitness:denialWitness}
 :lessonEntry?{browserResponse:{
 page:{pathname:academyPath+'/lessons/'+lessonId,flight:true},playback:entryPlayback,progress:entryProgress,
},courseWitness:entryWitness}
 :learnerAccess?{browserResponse:{
 page:{pathname:academyPath,status:200,lessonLink:effectiveAccess},reads:accessReads,body:accessBody,
},courseWitness:{...accessBody,actorId:actor,grantId,revision:learnerAccessAction.revision,effectiveAccess,readOnly:true}}
 :archive?{browserResponse:{
 method:'PATCH',pathname:coursePath,status:200,requestId,body:archiveBody,warningObserved:true,cancelObservedWithoutMutation:true,
},courseWitness:{...archiveBody,userId:target,grantId,historyPreserved:true,readOnly:true}}
 :paidRevoke?{browserResponse:{
 method:'POST',pathname:coursePath+'/manual-grants/revoke',status:200,requestId,body:grantBody,
},courseWitness:{...grantBody,remainingAccess,transitionId:revokeTransitionId,communityDelivery,readOnly:true}}
 :paidGrant?{browserResponse:{
 method:'POST',pathname:coursePath+'/manual-grants',status:200,requestId,body:grantBody,
},courseWitness:{...grantBody,enrollmentId,transitionId:activationTransitionId,...priorGrant,communityDelivery:activationDelivery,readOnly:true}}
 :learning?{browserResponse:{
 method:'POST',pathname:'/api'+academyPath+'/enrollments',status:200,requestId,academyPath,body:freeBody,
},courseWitness:{...freeBody,transitionId,communityDelivery:activationDelivery,readOnly:true}}
 :quiz?{browserResponse:{
 prior:{method:'GET',pathname:'/api'+quizPath,status:priorStatus,requestId},
 save:{method:'PUT',pathname:'/api'+quizPath,status:200,requestId:staleRequestId},body:quizBody,
},courseWitness:{...quizBody,readOnly:true}}
 :publication?{browserResponse:{
 readiness:{method:'GET',pathname:coursePath+'/publication-readiness',status:200,requestId:readinessRequestId},
 ...(republish?{draft:draftStep}:{}),...(published?{publication:publicationStep}:{}),body:publicationBody,
},courseWitness:{...publicationBody,...history,readOnly:true}}
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
const invalidEvidence=visibility?{...evidence,browserResponse:{...evidence.browserResponse,
 visibility:{...visibilityReceipt,trustedPagehide:true}}}
 :exitSave?{...evidence,browserResponse:{...evidence.browserResponse,exit:{...exitReceipt,trustedPagehide:spaExit}}}
 :ackLoss?{...evidence,browserResponse:{...evidence.browserResponse,recovery:{
 ...ackLossRecovery,requestId:ackLossId(2)}}}
 :restore?{...evidence,browserResponse:{...evidence.browserResponse,restored:{...restored,requestId:restoreStarted.requestId}}}
 :resume?{...evidence,browserResponse:{...evidence.browserResponse,
 writes:[...resumeWrites.slice(0,2),{...resumeWrites[2],requestId:resumeWrites[1].requestId}]}}
 :assessment?{...evidence,browserResponse:{...evidence.browserResponse,
 attempts:[{...assessmentAttempts[0],requestId:target},assessmentAttempts[1]]}}:lessonDenial?{...evidence,browserResponse:{...evidence.browserResponse,
 reads:[{...denialReads[0],requestId:target},...denialReads.slice(1)]}}
 :lessonEntry?{...evidence,browserResponse:{...evidence.browserResponse,playback:{...entryPlayback,requestId:lessonProgressId}}}
 :learnerAccess?{...evidence,browserResponse:{...evidence.browserResponse,reads:[{...accessReads[0],requestId:target},...accessReads.slice(1)]}}
 :quiz?{...evidence,browserResponse:{...evidence.browserResponse,prior:{...evidence.browserResponse.prior,requestId:target}}}
 :publication?{...evidence,browserResponse:{...evidence.browserResponse,readiness:{...evidence.browserResponse.readiness,requestId:target}}}
 :changesExisting?{...evidence,browserResponses:{...evidence.browserResponses,winner:{...evidence.browserResponses.winner,requestId:target}}}
 :gatewayScoped?{...evidence,browserResponse:{...evidence.browserResponse,requestId:target}}
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
 if(gatewayScoped) await assert.rejects(stage.observe());
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
 if(gatewayScoped&&!skipObserve){
  if(observeFailure) await assert.rejects(stage.observe(),{message:'P2_CERTIFICATION_INTERACTIVE_'+stageLabel+'_OBSERVE_FAILED'});
  else {
   const observed=await stage.observe();
   assert.equal(observed.status,status('GATEWAY_OBSERVED'));
   const mutation=lessonEntry?observed.gatewayAcknowledgements.find(row=>row.requestIndex===7):
    learnerAccess?observed.gatewayAcknowledgements[2]:lessonDenial?observed.gatewayAcknowledgements[10]:
    observed.gatewayAcknowledgements.find(row=>row.requestIndex===(paidRevoke?3:learning||paidGrant?2:1));
   if(learnerAccess) assert.deepEqual(observed.gatewayAcknowledgements.slice(2).map(row=>row.requestId),accessReads.map(row=>row.requestId));
   else if(lessonDenial) assert.deepEqual(observed.gatewayAcknowledgements.slice(10).map(row=>row.requestId),denialReads.map(row=>row.requestId));
   else if(assessment) assert.deepEqual(observed.gatewayAcknowledgements.slice(7).map(row=>row.requestId),
    assessmentAttempts.flatMap(row=>[row.requestId,row.progress.requestId]));
   else if(ackLoss) assert.equal(observed.gatewayAcknowledgements[9].requestId,ackLossRecovery.requestId);
   else if(exitSave) assert.deepEqual(observed.gatewayAcknowledgements.map(row=>row.requestIndex),exitSaveOrder);
   else if(visibility) assert.deepEqual(observed.gatewayAcknowledgements.map(row=>row.requestIndex),visibilityOrder);
   else if(restore) assert.equal(observed.gatewayAcknowledgements[7].requestId,restored.requestId);
   else if(resume) assert.deepEqual(observed.gatewayAcknowledgements.slice(7).map(row=>row.requestId),resumeWrites.map(row=>row.requestId));
   else assert.equal(mutation.requestId,lessonEntry?lessonProgressId:requestId);
   if(changesExisting) assert.equal(observed.gatewayAcknowledgements.at(-1).requestId,staleRequestId);
   if(republish) assert.equal(observed.gatewayAcknowledgements[3].requestId,readinessRequestId);
   if(published||quiz) assert.equal(observed.gatewayAcknowledgements[republish?4:2].requestId,staleRequestId);
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
 if(ackLoss){
  const invalidResponses=[
   {playback:[ackLossPlayback[0],{...ackLossPlayback[1],playbackIdSha256:'a'.repeat(64)}]},
   {writes:ackLossWrites.map((row,index)=>index===4?{...row,progressId:target}:row)},
   {writes:ackLossWrites.map((row,index)=>index===2?{...row,requestId:ackLossWrites[1].requestId}:row)},
   {recovery:{...ackLossRecovery,noReplay:false}},
  ];
  for(const change of invalidResponses) await assert.rejects(stage.retain({...evidence,
    browserResponse:{...evidence.browserResponse,...change}}));
  for(const change of [{enrollmentId:target},{revision:10},{playbackExpiresAt:'2026-11-07T12:02:00.000Z'}])
   await assert.rejects(stage.retain({...evidence,courseWitness:{...ackLossWitness,...change}}));
 }
 if(exitSave){
  for(const change of [{sameDocument:!spaExit},{trustedHidden:spaExit},{pathname:academyPath+'/lessons/'+lessonId},
   {resumePositionSeconds:5},{maxPositionSeconds:15},{expectedProgressRevision:9}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,exit:{...exitReceipt,...change}}}));
  }
  const movedStart={...exitSaveWrites[0],requestId:exitSaveRequestId(9)};
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,writes:[movedStart,exitSaveWrites[1]]}}));
  for(const change of [{enrollmentId:target},{revision:8},{resumePositionSeconds:8},{maxPositionSeconds:15}])
   await assert.rejects(stage.retain({...evidence,courseWitness:{...exitSaveWitness,...change}}));
 }
 if(visibility){
  for(const change of [{sameDocument:false},{trustedHidden:false},{resumePositionSeconds:5},{expectedProgressRevision:9}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,
    visibility:{...visibilityReceipt,...change}}}));
  }
  for(const change of [{revision:8},{requestId:visibilityRequestId(2)},{maxPositionSeconds:15}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,
    writes:[...visibilityWrites.slice(0,2),{...visibilityWrites[2],...change}]}}));
  }
  for(const change of [{progressId:target},{revision:8},{resumePositionSeconds:8},{maxPositionSeconds:15}])
   await assert.rejects(stage.retain({...evidence,courseWitness:{...exitSaveWitness,...change}}));
 }
 if(assessment){
  const [failed,passed]=assessmentAttempts;
  for(const changed of [{...passed,quizRevision:1},{...passed,passed:false},{...passed,payloadRequestId:failed.payloadRequestId},
   {...passed,progress:{...passed.progress,revision:2}},{...passed,progress:{...passed.progress,completedAt:null}},
   {...passed,progress:{...passed.progress,requestId:failed.progress.requestId}}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,attempts:[failed,changed]}}));
  }
  for(const changed of [{grantId:target},{progressRevision:2},{attemptIds:assessmentWitness.attemptIds.toReversed()}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...assessmentWitness,...changed}}));
  }
 }
 if(restore){
  for(const [field,change] of [
   ['playback',{expiresAt:restoreAction.prior.playbackExpiresAt,thumbnailExpiresAt:restoreAction.prior.playbackExpiresAt}],
   ['playback',{playbackIdSha256:'a'.repeat(64)}],['started',{revision:4}],
   ['restored',{maxPositionSeconds:4}],['media',{paused:false}],['media',{restoredSeconds:14}],
  ]) await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,
    [field]:{...evidence.browserResponse[field],...change}}}));
  await assert.rejects(stage.retain({...evidence,courseWitness:{...restoreWitness,revision:5}}));
 }
 if(resume){
  for(const change of [{resumePositionSeconds:5},{expectedProgressRevision:2},{submittedMaxPositionSeconds:13,maxPositionSeconds:13}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,
    writes:[...resumeWrites.slice(0,2),{...resumeWrites[2],...change}]}}));
  }
  for(const change of [{manifestObserved:false},{segmentObserved:false},{rewoundSeconds:5},{durationSeconds:18}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,media:{...resumeMedia,...change}}}));
  }
  for(const change of [{revision:3},{playbackIdSha256:'9'.repeat(64)},{maxPositionSeconds:13}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...resumeWitness,...change}}));
  }
 }
 if(lessonDenial){
  const {page,reads}=evidence.browserResponse;
  for(const changed of [{pathname:academyPath},{flightStatus:403},{documentStatus:302},
   {documentRequestId:page.flightRequestId,flightRequestId:page.documentRequestId},
   {documentRequestId:reads[0].requestId},{flightRequestId:reads[4].requestId}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{page:{...page,...changed},reads}}));
  }
  for(const changed of [{code:'access_revoked'},{status:200},{target:reads[0].target+'?_rsc'}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{page,reads:[{...reads[0],...changed},...reads.slice(1)]}}));
  }
  for(const changed of [{enrolledActorId:actor},{actorId:target},{grantId:target},{effectiveAccess:true},{readOnly:false}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...denialWitness,...changed}}));
  }
 }
 if(lessonEntry){
  for(const [key,changed] of [
   ['page',{flight:false}],['page',{pathname:academyPath}],['playback',{expiresAt:'2026-11-07T12:10:00Z'}],
   ['playback',{thumbnailExpiresAt:'2026-02-30T12:10:00.000Z'}],['playback',{lifetimeMs:600_501}],['playback',{token:'fixture-forbidden'}],
   ['progress',{requestId:lessonPlaybackId}],['progress',{revision:2}],['progress',{enrollmentId:'invalid'}],
  ]) await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,
   [key]:{...evidence.browserResponse[key],...changed},
  }}));
  for(const changed of [{actorId:target},{grantId:target},{progressId:target},{playbackExpiresAt:entryPlayback.expiresAt},{readOnly:false}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...entryWitness,...changed}}));
  }
 }
 if(learnerAccess){
  for(const page of [{...evidence.browserResponse.page,lessonLink:!effectiveAccess},{...evidence.browserResponse.page,status:accessStatus===200?403:accessStatus}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,page}}));
  }
  for(const reads of [[...accessReads].reverse(),accessReads.slice(1),[{...accessReads[0],code:'service_unavailable'},...accessReads.slice(1)],
   [{...accessReads[0],status:accessStatus===200?403:200},...accessReads.slice(1)]]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,reads}}));
  }
  for(const changed of [{actorId:target},{grantId:target},{revision:1},{effectiveAccess:!effectiveAccess},{readOnly:false}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
 }
 if(archive){
  for(const changed of [{warningObserved:false},{cancelObservedWithoutMutation:false},{pathname:coursePath+'/archive'},{method:'POST'}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,...changed}}));
  }
  for(const changed of [{status:'draft'},{revision:authoringAction.revision},{slug:'substituted-slug'}]){
   const body={...archiveBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...evidence.courseWitness,...changed}}));
  }
  for(const changed of [{historyPreserved:false},{readOnly:false},{userId:actor},{grantId:target}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
 }
 if(paidGrant){
  for(const changed of [{courseId:target},{userId:commandId},{commandId:'invalid'},{grantId:'invalid'},
   {courseRevision:grantRevision+1},{idempotencyKey}]){
   const body={...grantBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...evidence.courseWitness,...changed}}));
  }
  for(const changed of [{enrollmentId:'invalid'},{transitionId:'invalid'},{transitionId:secondPaid?transitionId:null},
   {priorGrantId:target},{readOnly:false},{commandId:target}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
  if(secondPaid){
   const body={...grantBody,grantId:priorGrantId};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},
    courseWitness:{...evidence.courseWitness,grantId:priorGrantId}}));
  }
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,pathname:coursePath}}));
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,status:202}}));
  await assert.rejects(stage.retain({...evidence,gatewayEvidence:{}}));
 }
 if(paidRevoke){
  for(const changed of [{courseId:target},{userId:commandId},{commandId:'invalid'},{grantId:actor},{courseRevision:grantRevision+1},{idempotencyKey}]){
   const body={...grantBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...evidence.courseWitness,...changed}}));
  }
  for(const changed of [{transitionId:remainingAccess?transitionId:null},{transitionId:'invalid'},{remainingAccess:!remainingAccess},
   {readOnly:false},{commandId:target},{communityDelivery:null},{communityDelivery:undefined}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
  const invalidCommunity=[
   {streamId:'invalid'},{eventId:'DEADBEEF-0000-4000-8000-000000000001'},{streamVersion:0},{streamVersion:2_147_483_648},{streamVersion:'2'},
   {canonicalDigest:'0'.repeat(64)},{canonicalDigest:'A'.repeat(64)},{independentActiveSha256:'0'.repeat(64)},{independentActiveSha256:'7'.repeat(63)},
   {independentActiveCount:0},{independentActiveCount:4097},{independentActiveCount:true},{state:remainingAccess?'revoked':'active'},{rawPayload:{}},
   ...(remainingAccess?[]:[{eventId:target}]),
  ];
  for(const changed of invalidCommunity){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,communityDelivery:{...communityDelivery,...changed}}}));
  }
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,pathname:coursePath+'/manual-grants'}}));
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,status:202}}));
 }
 if(learning){
  for(const changed of [{source:'paid'},{status:'revoked'},{idempotentReplay:!replay},{courseId:target},{grantId:'invalid'},
   ...(replay?[{grantId:target},{enrollmentId:target}]:[])]){
   const body={...freeBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...evidence.courseWitness,...changed}}));
  }
  for(const changed of [{transitionId:'invalid'},{readOnly:false},{enrollmentId:target}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,academyPath:'/academy'}}));
  await assert.rejects(stage.retain({...evidence,gatewayEvidence:{}}));
  if(replay){
   for(const changed of [{streamId:target},{canonicalDigest:'6'.repeat(64)}]){
    await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,communityDelivery:{...activationDelivery,...changed}}}));
   }
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,transitionId:target,
    communityDelivery:{...activationDelivery,eventId:target}}}));
  }
 }
 if(learning||paidGrant){
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,communityDelivery:undefined}}));
  for(const changed of [{streamId:'invalid'},{eventId:'invalid'},{streamVersion:0},{streamVersion:2},{streamVersion:true},
   {state:'revoked'},{canonicalDigest:'0'.repeat(64)},{canonicalDigest:'A'.repeat(64)},{rawPayload:{}},...(secondPaid?[]:[{eventId:target}])]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,communityDelivery:{...activationDelivery,...changed}}}));
  }
 }
 if(authoring){
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,revision:evidence.courseWitness.revision+1}}));
  await assert.rejects(stage.retain({...evidence,gatewayEvidence:{}}));
 }
 if(publication){
  for(const changed of [{issueCodes:['UNREVIEWED']},{status:published?'draft':'published'},{revision:publicationBody.revision+1}]){
   const body={...publicationBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...body,...history,readOnly:true}}));
  }
  const publication=published?{...publicationStep,requestId:target}:publicationStep;
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,publication}}));
 }
 if(republish){
  for(const changed of [{userId:actor},{grantId:actor},{historyPreserved:false},{effectiveAccess:!history.effectiveAccess}]){
   await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,...changed}}));
  }
  await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,draft:{...draftStep,requestId:target}}}));
 }
 if(quiz){
  const {prior,save}=evidence.browserResponse;
  for(const changed of [{documentSha256:'f'.repeat(64)},{lessonId:commandId},{quizId:'invalid'},{quizRevision},{revision:authoringAction.revision}]){
   const body={...quizBody,...changed};
   await assert.rejects(stage.retain({browserResponse:{...evidence.browserResponse,body},courseWitness:{...body,readOnly:true}}));
  }
  for(const changed of [{prior:{...prior,status:priorStatus===404?200:404}},{save:{...save,requestId:target}},{save:{...save,pathname:coursePath}}]){
   await assert.rejects(stage.retain({...evidence,browserResponse:{...evidence.browserResponse,...changed}}));
  }
  await assert.rejects(stage.retain({...evidence,courseWitness:{...evidence.courseWitness,documentSha256:'f'.repeat(64)}}));
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
 if(['wrong-join','wrong-item-join','unexpected-archive-flags','unexpected-frontend-operation','wrong-community-join','wrong-prior-join',
  'wrong-replay-join'].includes(behavior)){
  await assert.rejects(stage.retain(evidence),{message:'P2_CERTIFICATION_TRANSPORT_REFUSED'});
  await assert.rejects(stage.retain(evidence));
  throw new Error('fixture-stop-after-mismatched-join');
 }
 const retained=await stage.retain(evidence);
 assert.equal(retained.status,status('JOINED'));
 if(assessment) assert.deepEqual(
  [retained.actorId,retained.operation,retained.quizRevision,retained.attemptIds,retained.progressRevision,retained.frontendOperationCount],
  [actor,'fail-then-pass',assessmentAction.quizRevision,assessmentWitness.attemptIds,3,3],
 );
 if(restore) assert.deepEqual(
  [retained.actorId,retained.operation,retained.restoredGatewayRequestId,retained.revision,
   retained.resumePositionSeconds,retained.maxPositionSeconds,retained.frontendOperationCount],
  [actor,'restore-resume',restored.requestId,6,4,14,2],
 );
 if(ackLoss) assert.deepEqual(
  [retained.actorId,retained.operation,retained.playbackGatewayRequestIds,retained.progressGatewayRequestIds,
   retained.recoveryGatewayRequestId,retained.revision,retained.resumePositionSeconds,retained.maxPositionSeconds,retained.frontendOperationCount],
  [actor,'commit-drop-recover',ackLossPlayback.map(row=>row.requestId),ackLossWrites.map(row=>row.requestId),
   ackLossRecovery.requestId,11,14,14,5],
 );
 if(exitSave) assert.deepEqual(
  [retained.actorId,retained.operation,retained.playbackGatewayRequestId,retained.progressGatewayRequestIds,
   retained.destinationCourseGatewayRequestId,retained.destinationProgressGatewayRequestId,
   retained.revision,retained.resumePositionSeconds,retained.maxPositionSeconds,retained.frontendOperationCount],
  [actor,variant,exitSavePlayback.requestId,[6,7,8].map(exitSaveRequestId),exitSaveRequestId(0),exitSaveRequestId(9),9,7,14,3],
 );
 if(visibility) assert.deepEqual(
  [retained.actorId,retained.operation,retained.playbackGatewayRequestId,retained.progressGatewayRequestIds,
   retained.revision,retained.resumePositionSeconds,retained.maxPositionSeconds,retained.frontendOperationCount],
  [actor,'hide-active-document',visibilityPlayback.requestId,visibilityWrites.map(row=>row.requestId),9,7,14,3],
 );
 if(resume) assert.deepEqual(
  [retained.actorId,retained.operation,retained.positionGatewayRequestIds,retained.revision,
   retained.resumePositionSeconds,retained.maxPositionSeconds,retained.frontendOperationCount],
  [actor,'play-and-rewind',resumeWrites.map(row=>row.requestId),4,4,14,4],
 );
 if(lessonDenial) assert.deepEqual(
  [retained.actorId,retained.operation,retained.courseId,retained.lessonId,retained.enrolledActorId,retained.grantId,
   retained.effectiveAccess,retained.frontendOperationCount],
  [actor,'deny-cross-account',commandId,lessonId,lessonDenialAction.enrolledActorId,grantId,false,0],
 );
 if(lessonEntry) assert.deepEqual(
  [retained.actorId,retained.operation,retained.courseId,retained.lessonId,retained.grantId,retained.enrollmentId,retained.progressId,
   retained.revision,retained.playbackExpiresAt,retained.playbackGatewayRequestId,retained.progressGatewayRequestId,retained.frontendOperationCount],
  [actor,'open-lesson',commandId,lessonId,grantId,enrollmentId,staleRequestId,1,entryWitness.playbackExpiresAt,lessonPlaybackId,lessonProgressId,1],
 );
 if(learnerAccess) assert.deepEqual(
  [retained.actorId,retained.courseId,retained.lessonId,retained.grantId,retained.revision,retained.outcome,retained.effectiveAccess,retained.frontendOperationCount],
  [actor,commandId,lessonId,grantId,learnerAccessAction.revision,variant,effectiveAccess,0],
 );
 if(paidGrant){
  assert.deepEqual(
   [retained.actorId,retained.courseId,retained.userId,retained.commandId,retained.grantId,retained.courseRevision,
    retained.enrollmentId,retained.transitionId,retained.communityDelivery,retained.gatewayPostRequestId],
   [actor,commandId,target,grantCommandId,grantId,grantRevision,enrollmentId,activationTransitionId,activationDelivery,requestId],
  );
  if(secondPaid) assert.equal(retained.priorGrantId,priorGrantId);
  else assert.ok(!Object.hasOwn(retained,'priorGrantId'));
 }
 if(paidRevoke) assert.deepEqual(
  [retained.actorId,retained.operation,retained.courseId,retained.userId,retained.grantId,retained.commandId,retained.courseRevision,
   retained.remainingAccess,retained.transitionId,retained.communityDelivery,retained.gatewayPostRequestId],
  [actor,'revoke-paid-grant',commandId,target,grantId,grantCommandId,grantRevision,remainingAccess,revokeTransitionId,communityDelivery,requestId],
 );
 if(learning){
  assert.deepEqual(
   [retained.actorId,retained.courseId,retained.slug,retained.grantId,retained.enrollmentId,retained.transitionId,retained.communityDelivery,retained.gatewayPostRequestId],
   [actor,commandId,slug,grantId,enrollmentId,transitionId,activationDelivery,requestId],
  );
  if(replay) assert.equal(retained.operation,'replay-free-enrollment');
  else assert.ok(!Object.hasOwn(retained,'operation'));
 }
 if(authoring){
  if(archive){
   assert.equal(retained.gatewayPatchRequestId,requestId);
   assert.equal(retained.userId,target);
   assert.equal(retained.grantId,grantId);
   assert.equal(retained.revision,archiveBody.revision);
   for(const key of ['warningObserved','cancelObservedWithoutMutation','historyPreserved']) assert.ok(!Object.hasOwn(retained,key));
  }else if(quiz){
   assert.equal(retained.priorGatewayRequestId,requestId);
   assert.equal(retained.gatewayPutRequestId,staleRequestId);
   assert.equal(retained.lessonId,lessonId);
   assert.equal(retained.quizId,quizId);
   assert.equal(retained.quizRevision,quizBody.quizRevision);
   assert.equal(retained.revision,quizBody.revision);
   assert.equal(retained.documentSha256,documentSha256);
  }else if(publication){
   assert.equal(retained.readinessGatewayRequestId,readinessRequestId);
   assert.equal(retained.outcome,outcomeKind);
   assert.equal(retained.revision,publicationBody.revision);
   assert.deepEqual(retained.issueCodes,issueCodes);
   if(published) assert.equal(retained.gatewayPatchRequestId,staleRequestId);
   else assert.ok(!Object.hasOwn(retained,'gatewayPatchRequestId'));
   if(republish) assert.deepEqual(
    [retained.userId,retained.grantId,retained.effectiveAccess,retained.draftGatewayRequestId],
    [target,grantId,history.effectiveAccess,requestId],
   );
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
if(!['joined','joined-progress-first'].includes(behavior)){
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
 ['interactive-prepare','interactive-open','interactive-permit',...(gatewayScoped&&!installFailure&&!skipObserve?['interactive-observe']:[]),
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
 ['authoring','admin','joined','quiz-create'],
 ['authoring','admin','joined','quiz-revise'],
 ['authoring','admin','wrong-owner','quiz-create'],
 ['authoring','admin','wrong-operation-permit','quiz-revise'],
 ['authoring','admin','wrong-observe-order','quiz-create'],
 ['authoring','admin','wrong-prior-status','quiz-create'],
 ['authoring','admin','wrong-prior-status','quiz-revise'],
 ['authoring','admin','wrong-join','quiz-revise'],
 ['authoring','admin','joined','archive-paid-course'],
 ['authoring','admin','wrong-owner','archive-paid-course'],
 ['authoring','admin','wrong-operation-permit','archive-paid-course'],
 ['authoring','admin','wrong-observe-order','archive-paid-course'],
 ['authoring','admin','wrong-observe-ack','archive-paid-course'],
 ['authoring','admin','wrong-join','archive-paid-course'],
 ['authoring','admin','unexpected-archive-flags','archive-paid-course'],
 ['authoring','admin','joined','republish-published'],
 ['authoring','admin','joined','republish-published-denied'],
 ['authoring','admin','joined','republish-blocked'],
 ['authoring','admin','wrong-owner','republish-published'],
 ['authoring','admin','wrong-outcome-permit','republish-blocked'],
 ['authoring','admin','wrong-observe-order','republish-published'],
 ['authoring','admin','wrong-observe-ack','republish-blocked'],
 ['authoring','admin','unexpected-patch-ack','republish-blocked'],
 ['authoring','admin','wrong-join','republish-published'],
 ['learning','customer','joined'],
 ['learning','customer','joined-progress-first'],
 ['learning','customer','wrong-learner'],
 ['learning','customer','wrong-idempotency-key'],
 ['learning','customer','wrong-observe-order'],
 ['learning','customer','wrong-observe-ack'],
 ['learning','customer','wrong-learning-tail'],
 ['learning','customer','wrong-join'],
 ['learning','customer','wrong-community-join'],
 ['learning','customer','joined','exact-key-replay'],
 ['learning','customer','joined-progress-first','exact-key-replay'],
 ['learning','customer','wrong-learner','exact-key-replay'],
 ['learning','customer','wrong-idempotency-key','exact-key-replay'],
 ['learning','customer','wrong-observe-order','exact-key-replay'],
 ['learning','customer','wrong-observe-ack','exact-key-replay'],
 ['learning','customer','wrong-community-join','exact-key-replay'],
 ['learning','customer','wrong-replay-join','exact-key-replay'],
 ['paid-grant','admin','joined'],
 ['paid-grant','admin','joined','max-revision'],
 ['paid-grant','admin','wrong-owner'],
 ['paid-grant','admin','wrong-idempotency-key'],
 ['paid-grant','admin','wrong-observe-order'],
 ['paid-grant','admin','wrong-observe-ack'],
 ['paid-grant','admin','wrong-join'],
 ['paid-grant','admin','wrong-community-join'],
 ['paid-grant','admin','joined','second-grant'],
 ['paid-grant','admin','wrong-community-join','second-grant'],
 ['paid-grant','admin','wrong-prior-join','second-grant'],
 ['paid-revoke','admin','joined','remaining-access'],
 ['paid-revoke','admin','joined','last-grant'],
 ['paid-revoke','admin','wrong-owner','remaining-access'],
 ['paid-revoke','admin','wrong-idempotency-key','last-grant'],
 ['paid-revoke','admin','wrong-observe-order','last-grant'],
 ['paid-revoke','admin','wrong-observe-ack','remaining-access'],
 ['paid-revoke','admin','wrong-join','remaining-access'],
 ['paid-revoke','admin','wrong-join','last-grant'],
 ['paid-revoke','admin','wrong-community-join','remaining-access'],
 ['paid-revoke','admin','wrong-community-join','last-grant'],
 ['learner-access','customer','joined','allowed'],
 ['learner-access','customer','joined','archived'],
 ['learner-access','customer','joined','draft'],
 ['learner-access','customer','joined-progress-first','restricted'],
 ['learner-access','customer','wrong-learner','allowed'],
 ['learner-access','customer','wrong-lesson','archived'],
 ['learner-access','customer','wrong-observe-order','draft'],
 ['learner-access','customer','wrong-access-status','restricted'],
 ['learner-access','customer','wrong-join','allowed'],
 ['learner-access','customer','unexpected-frontend-operation','archived'],
 ['lesson-entry','customer','joined'],
 ['lesson-entry','customer','joined-progress-first'],
 ['lesson-entry','customer','wrong-learner'],
 ['lesson-entry','customer','wrong-lesson-course'],
 ['lesson-entry','customer','wrong-lesson'],
 ['lesson-entry','customer','wrong-observe-order'],
 ['lesson-entry','customer','wrong-observe-ack'],
 ['lesson-entry','customer','duplicate-lesson-ack'],
 ['lesson-entry','customer','wrong-join'],
 ['lesson-entry','customer','unexpected-frontend-operation'],
 ['lesson-denial','customer','joined'],
 ['lesson-denial','customer','joined-progress-first'],
 ['lesson-denial','customer','wrong-learner'],
 ['lesson-denial','customer','wrong-observe-order'],
 ['lesson-denial','customer','wrong-observe-ack'],
 ['lesson-denial','customer','duplicate-lesson-ack'],
 ['lesson-denial','customer','wrong-join'],
 ['lesson-denial','customer','unexpected-frontend-operation'],
 ['lesson-assessment','customer','joined'],
 ['lesson-assessment','customer','joined-progress-first'],
 ['lesson-assessment','customer','wrong-learner'],
 ['lesson-assessment','customer','wrong-observe-order'],
 ['lesson-assessment','customer','wrong-observe-ack'],
 ['lesson-assessment','customer','duplicate-lesson-ack'],
 ['lesson-assessment','customer','wrong-join'],
 ['lesson-assessment','customer','unexpected-frontend-operation'],
 ['lesson-resume','customer','joined'],
 ['lesson-resume','customer','joined-progress-first'],
 ['lesson-resume','customer','wrong-learner'],
 ['lesson-resume','customer','wrong-observe-order'],
 ['lesson-resume','customer','wrong-observe-ack'],
 ['lesson-resume','customer','duplicate-lesson-ack'],
 ['lesson-resume','customer','wrong-join'],
 ['lesson-resume','customer','unexpected-frontend-operation'],
 ...['joined','joined-progress-first','wrong-learner','wrong-observe-order','wrong-observe-ack',
  'duplicate-lesson-ack','wrong-join','unexpected-frontend-operation'].map(behavior=>['lesson-restore','customer',behavior]),
 ...['joined','joined-progress-first','wrong-learner','swap-recovery-ack','wrong-observe-ack','duplicate-lesson-ack',
  'duplicate-request-ack','wrong-join','unexpected-frontend-operation'].map(behavior=>['lesson-ack-loss','customer',behavior]),
 ...['joined','early-final-exit-ack','wrong-join','unexpected-frontend-operation']
  .map(behavior=>['lesson-exit-save','customer',behavior,'spa-navigation']),
 ...['joined-progress-first','duplicate-final-exit-ack','wrong-learner']
  .map(behavior=>['lesson-exit-save','customer',behavior,'document-exit']),
 ...['joined','joined-progress-first','wrong-learner','early-final-visibility-ack','duplicate-final-visibility-ack',
  'unexpected-outline-ack','wrong-observe-ack','duplicate-lesson-ack','wrong-join','unexpected-frontend-operation']
  .map(behavior=>['lesson-visibility-save','customer',behavior]),
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
