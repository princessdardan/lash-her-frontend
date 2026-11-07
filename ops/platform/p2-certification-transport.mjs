// Fixed SSH broker. Only source methods are exposed; no commands from JSON.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFrontendReceipt} from './frontend-migration.mjs';
import {readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {sshCommand} from './recreation_ssh.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateP2CanonicalBrowserObservation} from './p2-canonical-browser-origin.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';

const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_TRANSPORT_REFUSED');};
const MAXIMUM=4_000_000;
const suspensionStages=new WeakMap();
const authenticationStages=new WeakMap();
const workerStages=new WeakMap();
const knownAckStages=new WeakMap();
const interactiveStages=new WeakMap();
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const nonzeroSha256=value=>sha256(value)&&!/^0+$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const canonicalUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const utc=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const interactiveReceiptKeys=['version','qualificationTargetProfile','status','certificationActionId','planSha256','stage'];
const gatewayFenceKeys=['gatewayAdmissionClosed','gatewayActive','gatewayUncertain'];
const closedGateway=value=>value.gatewayAdmissionClosed===true&&value.gatewayActive===0&&value.gatewayUncertain===0;
const authoringCourseTarget='/course/v1/admin/courses';
const authoringReorderOperation='reorder-and-stale-curriculum';
const authoringCreateCurriculumOperation='create-curriculum';
const authoringPublicationOperation='qualify-publication';
const authoringQuizOperation='save-quiz-revision';
const learningEnrollmentOperation='enroll-free-course';
const paidGrantOperation='grant-paid-access';
const authoringPairedOperation=operation=>operation==='edit-and-stale-draft'||operation===authoringReorderOperation;
const emptyBodySha256=p2NativeHash(Buffer.alloc(0));
const interactiveGatewayKeys=['epoch','gatewayStateSha256','gatewayAcknowledgements','gatewayActive','gatewayUncertain','gatewayEvidenceSha256'];
const scopedOperations={
  'export-cleanup':['scoped-export-preflight','scoped-export-invoke','scoped-export-join'],
  'mux-callback-recovery':['scoped-mux-open','scoped-mux-observe','scoped-mux-close'],
  'lifecycle-persistence':['scoped-persistence-observe'],
};

export function readP2CertificationKnownAckStage(handle,plan){
  const selected=knownAckStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return selected.methods;
}

export function readP2CertificationInteractiveStage(handle,plan){
  const selected=interactiveStages.get(handle);demand(selected&&selected.plan===plan&&selected.active());
  return selected.methods;
}

function reviewedWriteRequest(row,method,target){
  return exact(row,['method','target','bodySha256','uses'])&&row.method===method&&row.target===target&&
    nonzeroSha256(row.bodySha256)&&row.bodySha256!==emptyBodySha256&&row.uses===1;
}

function authoringCurriculumPath(kind,parentId){
  return kind==='module'?'/courses/'+parentId+'/modules':'/modules/'+parentId+'/lessons';
}

const authoringQuizPath=lessonId=>'/admin/lessons/'+lessonId+'/quiz';
const courseSlug=value=>typeof value==='string'&&value.length<=120&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);

function reviewedAuthoringAction(action){
  const selected=action.authoringAction,[read,second,third]=action.requests;
  const reorder=selected?.operation===authoringReorderOperation;
  const createCurriculum=selected?.operation===authoringCreateCurriculumOperation;
  const publication=selected?.operation===authoringPublicationOperation,published=publication&&selected.outcome==='published';
  const quiz=selected?.operation===authoringQuizOperation;
  const paired=authoringPairedOperation(selected?.operation);
  const curriculum=reorder||createCurriculum;
  const hasCourse=paired||createCurriculum||publication||quiz;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','slug',...(hasCourse?['courseId','revision']:[]),
    ...(curriculum?['kind','parentId']:[]),...(createCurriculum?['childSlug']:[]),...(publication?['outcome','issueCodes']:[]),
    ...(quiz?['lessonId','quizRevision','documentSha256']:[])])&&
    courseSlug(selected.slug)&&action.requests.length===(paired||published||quiz?3:2));
  const selection={...selected,actorKind:'admin',actorId:action.actorId};
  if(hasCourse)demand(canonicalUuid(selected.courseId)&&Number.isInteger(selected.revision)&&selected.revision>=1&&selected.revision<=2_147_483_646);
  if(quiz){
    const {courseId,lessonId,quizRevision,documentSha256}=selected;
    const target='/course/v1'+authoringQuizPath(lessonId);
    demand(canonicalUuid(lessonId)&&Number.isInteger(quizRevision)&&quizRevision>=0&&quizRevision<=2_147_483_646&&
      nonzeroSha256(documentSha256)&&documentSha256!==emptyBodySha256&&
      isDeepStrictEqual(read,{method:'GET',target:authoringCourseTarget+'/'+courseId,bodySha256:emptyBodySha256,uses:2})&&
      isDeepStrictEqual(second,{method:'GET',target,bodySha256:emptyBodySha256,uses:1})&&reviewedWriteRequest(third,'PUT',target));
    return {selection,authoring:{actorId:action.actorId,...selected,bodySha256:third.bodySha256}};
  }
  if(publication){
    const {outcome,issueCodes,courseId,revision}=selected,target=authoringCourseTarget+'/'+courseId;
    demand(['published','blocked'].includes(outcome)&&Array.isArray(issueCodes)&&
      (published?issueCodes.length===0:issueCodes.length>=1&&issueCodes.length<=16)&&
      Array.from(issueCodes).every((code,index)=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)&&
        (index===0||issueCodes[index-1]<code))&&
      isDeepStrictEqual(read,{method:'GET',target,bodySha256:emptyBodySha256,uses:published?2:1})&&
      isDeepStrictEqual(second,{method:'GET',target:target+'/publication-readiness',bodySha256:emptyBodySha256,uses:1})&&
      (!published||reviewedWriteRequest(third,'PATCH',target)&&third.bodySha256===
        p2NativeHash(JSON.stringify({expectedRevision:revision,status:'published'}))));
    const reviewedCodes=[...issueCodes];
    return {selection:{...selection,issueCodes:reviewedCodes},authoring:{actorId:action.actorId,...selected,issueCodes:reviewedCodes}};
  }
  if(paired||createCurriculum){
    if(curriculum)demand(['module','lesson'].includes(selected.kind)&&canonicalUuid(selected.parentId)&&
      (selected.kind!=='module'||selected.parentId===selected.courseId));
    const readTarget=authoringCourseTarget+'/'+selected.courseId;
    const writeTarget=curriculum?'/course/v1/admin'+authoringCurriculumPath(selected.kind,selected.parentId)+(reorder?'/reorder':''):readTarget;
    const method=curriculum?'POST':'PATCH';
    demand(isDeepStrictEqual(read,{method:'GET',target:readTarget,bodySha256:emptyBodySha256,uses:createCurriculum?2:3})&&
      reviewedWriteRequest(second,method,writeTarget));
    if(createCurriculum){
      demand(courseSlug(selected.childSlug));
      return {selection,authoring:{actorId:action.actorId,...selected,bodySha256:second.bodySha256}};
    }
    demand(reviewedWriteRequest(third,method,writeTarget)&&second.bodySha256!==third.bodySha256);
    return {selection,authoring:{actorId:action.actorId,...selected,winnerBodySha256:second.bodySha256,staleBodySha256:third.bodySha256}};
  }
  demand(selected.operation==='create-draft'&&
    isDeepStrictEqual(read,{method:'GET',target:authoringCourseTarget+'?limit=100',bodySha256:emptyBodySha256,uses:1})&&
    reviewedWriteRequest(second,'POST',authoringCourseTarget));
  return {selection,authoring:{actorId:action.actorId,slug:selected.slug,bodySha256:second.bodySha256}};
}

function reviewedLearningAction(action){
  const selected=action.learningAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','slug','idempotencyKey'])&&
    selected.operation===learningEnrollmentOperation&&canonicalUuid(selected.courseId)&&courseSlug(selected.slug)&&
    canonicalUuid(selected.idempotencyKey));
  const {courseId,slug,idempotencyKey}=selected,student='/course/v1/student',detail=student+'/courses/'+courseId;
  demand(isDeepStrictEqual(action.requests,[
    {method:'GET',target:'/course/v1/courses/'+slug,bodySha256:emptyBodySha256,uses:1},
    {method:'GET',target:detail,bodySha256:emptyBodySha256,uses:2},
    {method:'POST',target:detail+'/enrollments',bodySha256:p2NativeHash(JSON.stringify({idempotencyKey})),uses:1},
    {method:'GET',target:student+'/progress?courseId='+courseId,bodySha256:emptyBodySha256,uses:1},
  ]));
  const learning={actorId:action.actorId,...selected};
  return {selection:{...learning,actorKind:'customer'},learning};
}

function reviewedPaidGrantAction(action){
  const selected=action.paidGrantAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','userId','revision','idempotencyKey','reasonSha256'])&&
    selected.operation===paidGrantOperation&&[selected.courseId,selected.userId,selected.idempotencyKey].every(canonicalUuid)&&
    Number.isInteger(selected.revision)&&selected.revision>=1&&selected.revision<=2_147_483_647&&
    nonzeroSha256(selected.reasonSha256)&&selected.reasonSha256!==emptyBodySha256);
  const {courseId,userId,idempotencyKey}=selected,grant=action.requests[2];
  const grants='/course/v1/admin/entitlements/grants',key='owner-paid%3A'+idempotencyKey;
  demand(reviewedWriteRequest(grant,'POST',grants)&&isDeepStrictEqual(action.requests,[
    {method:'GET',target:authoringCourseTarget+'/'+courseId,bodySha256:emptyBodySha256,uses:3},
    {method:'GET',target:'/course/v1/admin/entitlements/commands?idempotencyKey='+key+'&limit=2',bodySha256:emptyBodySha256,uses:2},
    grant,
    {method:'GET',target:grants+'?userId='+userId+'&courseId='+courseId+'&idempotencyKey='+key+'&limit=2',bodySha256:emptyBodySha256,uses:1},
  ]));
  const paidGrant={actorId:action.actorId,...selected};
  return {selection:{...paidGrant,actorKind:'admin'},paidGrant};
}

function reviewedInteractivePlan(plan,initial){
  const action=plan.scopedAction,binding=initial.interactiveController;
  const identity=action?.stage==='identity',authoring=action?.stage==='authoring',learning=action?.stage==='learning';
  const paidGrant=action?.stage==='paid-grant',gatewayScoped=authoring||learning||paidGrant;
  const enrollment=identity&&Object.hasOwn(action,'identityEnrollment');
  demand(plan.environment==='staging'&&plan.sourceCommit===initial.sourceCommit&&plan.operatorSourceCommit===initial.sourceCommit&&
    plan.maximumSeconds===300&&typeof plan.initialEpoch==='string'&&/^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch)&&
    (BigInt(plan.initialEpoch)+2n).toString().length<=18&&sha256(plan.planSha256)&&
    (identity||gatewayScoped||action?.stage==='lifecycle')&&exact(action,['stage','actorId','requests','windowSeconds',
      enrollment?'identityEnrollment':identity?'identityActor':authoring?'authoringAction':learning?'learningAction':paidGrant?'paidGrantAction':'frontendAction'])&&
    Array.isArray(action.requests)&&(gatewayScoped||action.requests.length===0)&&
    Number.isInteger(action.windowSeconds)&&action.windowSeconds>=30&&action.windowSeconds<=300&&
    exact(binding,['challenge','bindingSha256','browserProgramSha256'])&&sha256(binding.challenge)&&
    binding.bindingSha256===plan.planSha256&&sha256(binding.browserProgramSha256));
  if(authoring)return reviewedAuthoringAction(action);
  if(learning)return reviewedLearningAction(action);
  if(paidGrant)return reviewedPaidGrantAction(action);
  if(enrollment){
    const selected=action.identityEnrollment;
    demand(action.actorId===null&&exact(selected,['provider','emailSha256','nonce'])&&
      ['google','resend'].includes(selected.provider)&&nonzeroSha256(selected.emailSha256)&&
      typeof selected.nonce==='string'&&/^[a-f0-9]{32}$/u.test(selected.nonce)&&!/^0+$/u.test(selected.nonce));
    return {selection:{actorKind:'customer'},enrollment:{...selected}};
  }
  if(identity){
    const actor=action.identityActor;
    demand(action.actorId===null&&exact(actor,['actorKind','actorId'])&&['admin','customer'].includes(actor.actorKind)&&
      canonicalUuid(actor.actorId));
    return {selection:{...actor}};
  }
  const selected=action.frontendAction;
  demand(uuid(action.actorId)&&exact(selected,['actorKind','userId','operation'])&&uuid(selected.userId)&&
    (selected.actorKind==='admin'?['suspend','restore','export','delete'].includes(selected.operation):
      selected.actorKind==='customer'&&action.actorId===selected.userId&&['export','delete','preferences-on','preferences-off'].includes(selected.operation)));
  return {selection:{...selected,actorId:action.actorId}};
}

function lifecycleJoinedEvidence(evidence,selected){
  demand(exact(evidence,['browserResponse','lifecycleWitness']));
  const {browserResponse:response,lifecycleWitness:witness}=evidence;
  const preferences=selected.operation.startsWith('preferences-'),status=preferences?200:202;
  const pathname=selected.actorKind==='admin'?'/api/admin/customer-accounts/'+selected.userId+'/commands':
    preferences?'/api/account/preferences':'/api/account/commands';
  demand(exact(response,['method','pathname','status','requestId','body'])&&response.method==='POST'&&response.pathname===pathname&&
    response.status===status&&uuid(response.requestId)&&
    (preferences?exact(response.body,['saved'])&&response.body.saved===true:
      exact(response.body,['commandId','action','accountVersion','status'])&&uuid(response.body.commandId)&&
      response.body.action===selected.operation&&Number.isSafeInteger(response.body.accountVersion)&&response.body.accountVersion>0&&
      response.body.status==='pending'));
  demand(exact(witness,['version','status','actorKind','actorId','userId','operation','requestId','httpStatus','baselineSha256','frontendStatus',
    'accountVersion','sessionsBefore','sessionsAfter','learningUpdates','commandId','deliveries','pendingOrDeliveringCount','observedAt','readOnly'])&&
    witness.version===1&&witness.status==='P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED'&&
    Object.entries(selected).every(([key,value])=>witness[key]===value)&&witness.requestId===response.requestId&&witness.httpStatus===status&&
    sha256(witness.baselineSha256)&&['active','suspended','deleted'].includes(witness.frontendStatus)&&
    [witness.accountVersion,witness.sessionsBefore,witness.sessionsAfter,witness.pendingOrDeliveringCount].every(nonnegative)&&
    typeof witness.learningUpdates==='boolean'&&utc(witness.observedAt)&&witness.readOnly===true&&Array.isArray(witness.deliveries)&&
    (preferences?witness.commandId===null&&witness.deliveries.length===0&&witness.learningUpdates===(selected.operation==='preferences-on'):
      witness.commandId===response.body.commandId&&witness.accountVersion===response.body.accountVersion&&
      witness.deliveries.length===2&&witness.deliveries.every((row,index)=>exact(row,['receiver','status','attempts'])&&
        row.receiver===['course','community'][index]&&row.status==='pending'&&row.attempts===0)));
  return {...selected,browserResponseSha256:p2NativeHash(response),lifecycleWitnessSha256:p2NativeHash(witness)};
}

function identityJoinedEvidence(evidence,selected,context,enrollment){
  demand(exact(evidence,['browserIdentity','identityWitness']));
  const {browserIdentity:identity,identityWitness:witness}=evidence;
  const owner=context==='owner';
  const actor={...selected,actorId:enrollment?identity?.actorId:selected.actorId};
  const witnessFields=enrollment?['liveSessionCount','provider','providerLinkCount']:[owner?'ownerMappingVerified':'liveSessionCount'];
  demand(exact(identity,['actorKind','actorId','sessionVerified'])&&identity.sessionVerified===true&&
    exact(witness,['actorKind','actorId','actorActive',...witnessFields])&&witness.actorActive===true&&
    canonicalUuid(actor.actorId)&&Object.entries(actor).every(([key,value])=>identity[key]===value&&witness[key]===value));
  if(enrollment){
    demand(witness.liveSessionCount===1&&witness.provider===enrollment.provider&&witness.providerLinkCount===(enrollment.provider==='google'?1:0));
  }else{
    demand(owner?witness.ownerMappingVerified===true:Number.isSafeInteger(witness.liveSessionCount)&&witness.liveSessionCount>0);
  }
  return {...actor,context,browserIdentitySha256:p2NativeHash(identity),identityWitnessSha256:p2NativeHash(witness)};
}

function requireInteractiveGatewayObservation(receipt,epoch,{operation,outcome,quizRevision}){
  const {gatewayEvidenceSha256,...observed}=receipt;
  const acks=receipt.gatewayAcknowledgements;
  const createCurriculum=operation===authoringCreateCurriculumOperation;
  const publication=operation===authoringPublicationOperation,paired=authoringPairedOperation(operation);
  const quiz=operation===authoringQuizOperation,learning=operation===learningEnrollmentOperation;
  const statuses=quiz?[200,quizRevision===0?404:200,200]:publication?[200,200,200]:paired?[200,200,409]:[200,201];
  const indices=quiz||publication&&outcome==='published'?[0,1,2,0]:paired?[0,0,1,0,2]:createCurriculum?[0,1,0]:[0,1];
  const sequences=learning?[
    [[0,200],[1,403],[2,201],[1,200],[3,200]],
    [[0,200],[1,403],[2,201],[3,200],[1,200]],
  ]:operation===paidGrantOperation?[
    [[0,200],[1,200],[0,200],[2,201],[1,200],[3,200],[0,200]],
  ]:[indices.map(index=>[index,statuses[index]])];
  demand(receipt.epoch===epoch&&nonzeroSha256(receipt.gatewayStateSha256)&&receipt.gatewayActive===0&&receipt.gatewayUncertain===0&&
    Array.isArray(acks)&&acks.length===sequences[0].length&&acks.every(row=>exact(row,['requestId','proofRequestId','requestIndex','upstreamStatus'])&&
      canonicalUuid(row.requestId)&&canonicalUuid(row.proofRequestId))&&
    sequences.some(sequence=>acks.every((row,index)=>row.requestIndex===sequence[index][0]&&row.upstreamStatus===sequence[index][1]))&&
    new Set(acks.map(row=>row.requestId)).size===acks.length&&new Set(acks.map(row=>row.proofRequestId)).size===acks.length&&
    gatewayEvidenceSha256===p2NativeHash(observed));
}

function learningJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,courseId,slug}=selected,{grantId,enrollmentId}=response?.body??{};
  const transitionId=witness?.transitionId,gatewayPostRequestId=observed.gatewayAcknowledgements[2].requestId;
  const academyPath='/academy/courses/'+courseId;
  const body={courseId,grantId,enrollmentId,source:'free',status:'active',idempotentReplay:false};
  demand([grantId,enrollmentId,transitionId].every(canonicalUuid)&&
    isDeepStrictEqual(response,{method:'POST',pathname:'/api'+academyPath+'/enrollments',status:200,requestId:gatewayPostRequestId,academyPath,body})&&
    isDeepStrictEqual(witness,{...body,transitionId,readOnly:true}));
  return {actorId,courseId,slug,grantId,enrollmentId,transitionId,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPostRequestId};
}

function paidGrantJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,courseId,userId,revision:courseRevision}=selected,{commandId,grantId}=response?.body??{};
  const {enrollmentId,transitionId}=witness??{},gatewayPostRequestId=observed.gatewayAcknowledgements[3].requestId;
  const body={courseId,userId,commandId,grantId,courseRevision};
  demand([commandId,grantId,enrollmentId,transitionId].every(canonicalUuid)&&
    isDeepStrictEqual(response,{method:'POST',pathname:'/api/admin/courses/'+courseId+'/manual-grants',status:200,requestId:gatewayPostRequestId,body})&&
    isDeepStrictEqual(witness,{...body,enrollmentId,transitionId,readOnly:true}));
  return {actorId,...body,enrollmentId,transitionId,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPostRequestId};
}

function authoringJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const gatewayPostRequestId=observed.gatewayAcknowledgements[1].requestId;
  const {actorId,operation,courseId,slug,kind,parentId,childSlug,revision}=selected;
  const createCurriculum=operation===authoringCreateCurriculumOperation;
  const pathname='/api/admin'+(createCurriculum?authoringCurriculumPath(kind,parentId):'/courses');
  const body=response?.body;
  demand(exact(response,['method','pathname','status','requestId','body'])&&response.method==='POST'&&response.pathname===pathname&&
    response.status===200&&response.requestId===gatewayPostRequestId);
  let created;
  if(createCurriculum){
    const itemId=body?.itemId,nextRevision=revision+1;
    demand(canonicalUuid(itemId)&&isDeepStrictEqual(body,{courseId,parentId,kind,itemId,slug:childSlug,revision:nextRevision}));
    created={courseId,parentId,kind,itemId,slug,childSlug,revision:nextRevision};
  }else{
    demand(exact(body,['courseId','slug','revision','status'])&&canonicalUuid(body.courseId)&&body.slug===slug&&
      body.revision===1&&body.status==='draft');
    created={courseId:body.courseId,slug};
  }
  demand(isDeepStrictEqual(witness,{...body,readOnly:true}));
  return {actorId,operation,...created,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),
    gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPostRequestId};
}

function authoringPublicationJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,slug,outcome,issueCodes}=selected,published=outcome==='published';
  const revision=selected.revision+(published?1:0),pathname='/api/admin/courses/'+courseId;
  const {gatewayAcknowledgements:acks,gatewayEvidenceSha256}=observed;
  const readinessGatewayRequestId=acks[1].requestId,gatewayPatchRequestId=published?acks[2].requestId:undefined;
  const body={courseId,slug,revision,status:published?'published':'draft',issueCodes};
  demand(exact(response,['readiness','body',...(published?['publication']:[])])&&
    isDeepStrictEqual(response.readiness,{method:'GET',pathname:pathname+'/publication-readiness',status:200,requestId:readinessGatewayRequestId})&&
    (!published||isDeepStrictEqual(response.publication,{method:'PATCH',pathname,status:200,requestId:gatewayPatchRequestId}))&&
    isDeepStrictEqual(response.body,body)&&isDeepStrictEqual(witness,{...body,readOnly:true}));
  return {actorId,operation,courseId,slug,outcome,revision,issueCodes,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256,readinessGatewayRequestId,...(published?{gatewayPatchRequestId}:{})};
}

function authoringQuizJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,slug,lessonId,documentSha256}=selected;
  const revision=selected.revision+1,quizRevision=selected.quizRevision+1,quizId=response?.body?.quizId;
  const pathname='/api'+authoringQuizPath(lessonId),priorStatus=selected.quizRevision===0?404:200;
  const {gatewayAcknowledgements:acks,gatewayEvidenceSha256}=observed;
  const priorGatewayRequestId=acks[1].requestId,gatewayPutRequestId=acks[2].requestId;
  const body={courseId,slug,lessonId,quizId,revision,quizRevision,documentSha256};
  demand(exact(response,['prior','save','body'])&&canonicalUuid(quizId)&&
    isDeepStrictEqual(response.prior,{method:'GET',pathname,status:priorStatus,requestId:priorGatewayRequestId})&&
    isDeepStrictEqual(response.save,{method:'PUT',pathname,status:200,requestId:gatewayPutRequestId})&&
    isDeepStrictEqual(response.body,body)&&isDeepStrictEqual(witness,{...body,readOnly:true}));
  return {actorId,operation,...body,browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),
    gatewayEvidenceSha256,priorGatewayRequestId,gatewayPutRequestId};
}

function authoringChangeJoinedEvidence(evidence,selected,observed,winnerBodySha256){
  demand(exact(evidence,['browserResponses','courseWitness'])&&exact(evidence.browserResponses,['winner','stale']));
  const {browserResponses:responses,courseWitness:witness}=evidence;
  const {winner,stale}=responses;
  const gatewayMutationRequestIds=[1,2].map(index=>observed.gatewayAcknowledgements.find(row=>row.requestIndex===index).requestId);
  const {actorId,operation,courseId,slug,revision,kind,parentId}=selected;
  const reorder=operation===authoringReorderOperation;
  const pathname='/api/admin'+(reorder?authoringCurriculumPath(kind,parentId)+'/reorder':'/courses/'+courseId);
  const method=reorder?'POST':'PATCH',receiptKeys=['method','pathname','status','requestId'];
  const staleProof=reorder?'keyboardActivated':'dirtyInputPreserved';
  const ids=winner?.body?.ids;
  if(reorder)demand(Array.isArray(ids)&&ids.length>=3&&ids.length<=1_000&&Array.from(ids).every(canonicalUuid)&&
    new Set(ids).size===ids.length&&p2NativeHash(JSON.stringify({expectedCourseRevision:revision,ids}))===winnerBodySha256);
  const body={courseId,revision:revision+1,...(reorder?{parentId,kind,ids}:{slug,status:'draft'})};
  demand(exact(winner,[...receiptKeys,'body',...(reorder?['keyboardActivated']:[])])&&winner.method===method&&winner.pathname===pathname&&
    winner.status===200&&winner.requestId===gatewayMutationRequestIds[0]&&isDeepStrictEqual(winner.body,body)&&(!reorder||winner.keyboardActivated===true)&&
    exact(stale,[...receiptKeys,'outcome',staleProof])&&stale.method===method&&stale.pathname===pathname&&
    stale.status===409&&stale.requestId===gatewayMutationRequestIds[1]&&stale.outcome==='conflict'&&stale[staleProof]===true&&
    isDeepStrictEqual(witness,{...body,readOnly:true}));
  const mutation=reorder?{kind,parentId,gatewayPostRequestIds:gatewayMutationRequestIds}:{gatewayPatchRequestIds:gatewayMutationRequestIds};
  return {actorId,operation,courseId,slug,browserResponsesSha256:p2NativeHash(responses),courseWitnessSha256:p2NativeHash(witness),
    gatewayEvidenceSha256:observed.gatewayEvidenceSha256,...mutation};
}

export function readP2CertificationWorkerStage(handle,plan){
  const selected=workerStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return selected.methods;
}


export function readP2CertificationAuthenticationStage(handle,plan){
  const selected=authenticationStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return structuredClone(selected.receipt);
}

export function readP2CertificationSuspensionStage(handle,plan){
  const selected=suspensionStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return selected.methods;
}

export function p2CertificationEnvironmentLock(settings,initial,directory,{launch=spawn,expectedProfile}={}){
  const profiled=expectedProfile!==undefined;
  const mode=profiled?'p2-bounded-certification-profiled-current':'p2-bounded-certification';
  demand(initial?.environment==='staging'&&initial.mode===mode&&/^[a-f0-9]{40}$/u.test(initial.sourceCommit??''));
  if(profiled){
    requireQualificationTargetProfile(currentProfile,{qualificationTargetProfile:expectedProfile},initial,initial.certificationPlan,initial.certificationPlan?.nativePlan);
    demand(initial.version===2&&initial.certificationPlan.version===2&&initial.certificationPlan.nativePlan.version===2&&
      initial.certificationPlan.certificationActionId===initial.certificationActionId);
  }else demand(!Object.hasOwn(initial,'qualificationTargetProfile'));
  const interactivePlan=profiled&&initial.certificationPlan.mode==='interactive-browser'?initial.certificationPlan:null;
  const selectedInteractive=interactivePlan?reviewedInteractivePlan(interactivePlan,initial):null;
  if(!interactivePlan)demand(!Object.hasOwn(initial,'interactiveController')&&initial.certificationPlan?.mode!=='interactive-browser');
  const command=['sudo','-n','/usr/bin/python3','-I','-u',`/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_certification_parent.py`,
    profiled?'--supervisor-profiled-current':'--supervisor'];
  return async task=>{
    const child=launch('/usr/bin/ssh',sshCommand({knownHosts:settings.knownHosts,keyFile:settings.sshKey},command),
      {stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))});
    const reaped=new Promise(resolve=>child.once('close',resolve));
    const controller=new AbortController(),pending=new Map();let sequence=0,failed=false,active=true,exited,heartbeat,joined,armed=false,prepared=false,browserOpened=false,committedReceipt;
    const fail=()=>{if(failed)return;failed=true;controller.abort();for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('P2_CERTIFICATION_REMOTE_LOST'));}pending.clear();child.stdin.end();};
    const lines=createInterface({input:child.stdout});
    lines.on('line',raw=>{try{demand(Buffer.byteLength(raw)<=MAXIMUM);const value=profiled?decodeQualificationTargetJson(raw,'private-packet'):JSON.parse(raw),waiter=pending.get(value.id);demand(waiter&&value.status===waiter.status);pending.delete(value.id);clearTimeout(waiter.timer);waiter.resolve(value);}catch{fail();}});
    // Remote errors may contain credentials. Retain neither raw stderr nor
    // exception text; the independent host guard retains sanitized outcomes.
    child.stderr.resume();child.on('error',fail);child.stdin.on('error',fail);child.on('exit',code=>{exited=code;if(active||code!==0)fail();});
    const expect=(id,status,timeout)=>new Promise((resolve,reject)=>{demand(!failed&&!pending.has(id));const timer=setTimeout(()=>{fail();reject(new Error('P2_CERTIFICATION_REMOTE_UNCERTAIN'));},timeout);pending.set(id,{status,resolve,reject,timer});});
    const request=(operation,status,data={},timeout=90_000)=>{demand(!failed&&active);const id=++sequence,raw=JSON.stringify({id,operation,...data});demand(Buffer.byteLength(raw)<=MAXIMUM);const promise=expect(id,status,timeout);child.stdin.write(raw+'\n');return promise;};
    const ready=expect(0,'LOCKED',60_000),raw=JSON.stringify(initial);demand(Buffer.byteLength(raw)<=MAXIMUM);child.stdin.write(raw+'\n');
    let result,error;
    try{
      await ready;const verify=async()=>{await request('check','HELD');};heartbeat=setInterval(()=>{if(!failed)void verify().catch(fail);},1000);
      const nativePlan=profiled?initial.certificationPlan.nativePlan:initial.nativePlan;
      const browserPlan=profiled?initial.sourceSuspensionPlan:initial.browserPlan;
      const workerPlan=profiled?initial.certificationPlan.workerPlan:initial.workerPlan;
      const validateBrowser=(plan,observation)=>{
        validateP2CanonicalBrowserObservation(plan,observation,expectedProfile);
        if(profiled)demand(observation.phase2ContractManifestSha256===initial.certificationPlan.phase2ContractManifestSha256);
      };
      const match=plan=>demand(plan?.planSha256===nativePlan.planSha256);
      let interactiveCreated=false,interactiveRetained;
      const host={mode,certificationActionId:initial.certificationActionId,
        async arm({receipt,probe}){demand(!armed);const bytes=readFrontendReleaseEvidence(directory,'p2-certification-current-database.json');demand(JSON.stringify(JSON.parse(bytes))===JSON.stringify(receipt));
          const value=await request('arm-certification','CERTIFICATION_ARMED',{receipt:bytes.toString('base64'),probe},240_000);armed=true;return value.receipt;},
        async scopedStage(operation){
          demand(profiled&&armed&&!prepared&&scopedOperations[initial.certificationPlan.mode]?.includes(operation));
          const {receipt}=await request(operation,'CERTIFICATION_SCOPED_OBSERVED');
          requireQualificationTargetProfile(currentProfile,receipt);
          demand(receipt.version===2&&typeof receipt.status==='string');
          return receipt;
        },
        async interactiveStage(browserController){
          demand(launch===spawn&&interactivePlan&&armed&&!prepared&&!interactiveCreated&&active&&!failed);
          interactiveCreated=true;
          const {readP2InteractiveBrowserControllerBinding}=await import('./p2-lifecycle-suspension-evidence.mjs');
          const {validateP2InteractiveBrowserPermit}=await import('./p2-lifecycle-browser-recorder.mjs');
          const binding=structuredClone(initial.interactiveController),snapshot=structuredClone(interactivePlan);
          const alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&
            isDeepStrictEqual(interactivePlan,snapshot)&&isDeepStrictEqual(initial.interactiveController,binding);
          const requireRecorder=()=>demand(alive()&&isDeepStrictEqual(readP2InteractiveBrowserControllerBinding(interactivePlan,browserController),binding));
          requireRecorder();
          const controllerChallenge=binding.challenge,epoch=(BigInt(snapshot.initialEpoch)+1n).toString();
          const stage=snapshot.scopedAction.stage,identity=stage==='identity',authoring=stage==='authoring',learning=stage==='learning';
          const stageLabel=stage.toUpperCase().replaceAll('-','_');
          const paidGrant=stage==='paid-grant',gatewayScoped=authoring||learning||paidGrant;
          const {selection,enrollment,authoring:authoringPermit,learning:learningPermit,paidGrant:paidGrantPermit}=selectedInteractive;
          const paired=authoringPairedOperation(selection.operation);
          const context=selection.actorKind==='admin'?'owner':'learner';
          const permitInput={stage,epoch,windowSeconds:snapshot.scopedAction.windowSeconds,
            ...(authoring?{authoring:authoringPermit}:learning?{learning:learningPermit}:paidGrant?{paidGrant:paidGrantPermit}:
              enrollment?{identityEnrollment:enrollment}:identity?{identity:selection}:{})};
          let phase='new',expiresAt,installed=false,gatewayObservation;
          const call=async(operation,disposition,extraKeys,data={},timeout=120_000)=>{
            demand(alive());
            const packet=await request(operation,'CERTIFICATION_INTERACTIVE_OBSERVED',{controllerChallenge,...data},timeout);
            const receipt=packet.receipt;
            demand(exact(packet,['id','status','receipt'])&&exact(receipt,[...interactiveReceiptKeys,...extraKeys]));
            requireQualificationTargetProfile(currentProfile,receipt);
            demand(receipt.version===2&&receipt.status===`P2_INTERACTIVE_${stageLabel}_${disposition}`&&
              receipt.certificationActionId===initial.certificationActionId&&receipt.planSha256===snapshot.planSha256&&receipt.stage===stage);
            return receipt;
          };
          const methods=Object.freeze({
            async prepare(){
              demand(phase==='new');requireRecorder();phase='preparing';
              const receipt=await call('interactive-prepare','PREPARED',['ingressSha256'],{},240_000);
              demand(sha256(receipt.ingressSha256));phase='prepared';return receipt;
            },
            async open(){
              demand(phase==='prepared');requireRecorder();phase='opening';
              const receipt=await call('interactive-open','OPENED',['epoch','expiresAt','gatewayScoped']);
              demand(receipt.epoch===epoch&&utc(receipt.expiresAt)&&receipt.gatewayScoped===gatewayScoped);
              expiresAt=Date.parse(receipt.expiresAt);phase='opened';return receipt;
            },
            async installPermit(){
              demand(phase==='opened');requireRecorder();phase='installing';
              let packet;
              try{
                packet=await request('interactive-permit','CERTIFICATION_INTERACTIVE_PRIVATE',{controllerChallenge});
                demand(exact(packet,['id','status','permit']));
                const permit=validateP2InteractiveBrowserPermit(packet.permit,permitInput);
                demand(permit.expires*1000===expiresAt);
                requireRecorder();
                const ack=await browserController.installPermit(permit,context);
                requireRecorder();
                const expected={type:'interactive-permit-installed',challenge:controllerChallenge,bindingSha256:binding.bindingSha256,
                  stage,epoch,context,expires:expiresAt/1000};
                demand(isDeepStrictEqual(ack,expected));
                installed=true;phase='installed';return Object.freeze(expected);
              }catch{phase='install-failed';throw new Error('P2_CERTIFICATION_INTERACTIVE_PERMIT_INSTALL_FAILED');}
              finally{if(packet){if(packet.permit&&typeof packet.permit==='object')delete packet.permit.cookie;delete packet.permit;}}
            },
            ...(gatewayScoped?{
              async observe(){
                demand(phase==='installed');requireRecorder();phase='observing';
                try{
                  const receipt=await call('interactive-observe','GATEWAY_OBSERVED',interactiveGatewayKeys);
                  requireInteractiveGatewayObservation(receipt,epoch,selection);
                  gatewayObservation=structuredClone(receipt);phase='observed';return receipt;
                }catch{phase='observe-failed';throw new Error(`P2_CERTIFICATION_INTERACTIVE_${stageLabel}_OBSERVE_FAILED`);}
              },
            }:{}),
            async fence(){
              // The gateway fence must remain available when the recorder dies
              // or an observation fails after the host has opened the stage.
              demand(['opened','installed','install-failed','observed','observe-failed'].includes(phase));phase='fencing';
              const receipt=await call('interactive-fence','FENCED',gatewayFenceKeys);
              demand(closedGateway(receipt));phase='fenced';return receipt;
            },
            async retain(caseEvidence){
              demand(phase==='fenced'&&installed&&(!gatewayScoped||gatewayObservation));requireRecorder();
              const evidence=structuredClone(caseEvidence);
              const expected=learning?learningJoinedEvidence(evidence,selection,gatewayObservation):
                paidGrant?paidGrantJoinedEvidence(evidence,selection,gatewayObservation):
                paired?authoringChangeJoinedEvidence(evidence,selection,gatewayObservation,authoringPermit.winnerBodySha256):
                selection.operation===authoringQuizOperation?authoringQuizJoinedEvidence(evidence,selection,gatewayObservation):
                selection.operation===authoringPublicationOperation?authoringPublicationJoinedEvidence(evidence,selection,gatewayObservation):
                authoring?authoringJoinedEvidence(evidence,selection,gatewayObservation):
                identity?identityJoinedEvidence(evidence,selection,context,enrollment):lifecycleJoinedEvidence(evidence,selection);
              phase='retaining';
              const receipt=await call('interactive-retain','JOINED',
                ['browserProgramSha256',...Object.keys(expected),
                  'frontendAdmission','frontendOperationCount',...gatewayFenceKeys],{caseEvidence:evidence});
              demand(receipt.browserProgramSha256===binding.browserProgramSha256&&Object.entries(expected).every(([key,value])=>isDeepStrictEqual(receipt[key],value))&&
                isDeepStrictEqual(receipt.frontendAdmission,{epoch:(BigInt(epoch)+1n).toString(),newWork:false,recovery:false,active:0,uncertain:0})&&
                Number.isSafeInteger(receipt.frontendOperationCount)&&receipt.frontendOperationCount>0&&closedGateway(receipt));
              interactiveRetained=structuredClone(receipt);phase='retained';return receipt;
            },
          });
          const handle=Object.freeze({});interactiveStages.set(handle,{plan:interactivePlan,active:alive,methods});return handle;
        },
        nativeControl:{
          async observe(plan){match(plan);demand(armed&&!prepared);return(await request('native-observe','CERTIFICATION_NATIVE_OBSERVED')).receipt;},
          async observeMetadata(plan){match(plan);demand(armed&&!prepared);return(await request('native-metadata','CERTIFICATION_NATIVE_OBSERVED')).receipt;},
          async setEnabled(plan,enabled){match(plan);demand(!interactivePlan&&armed&&!prepared&&typeof enabled==='boolean');return(await request('native-toggle','CERTIFICATION_NATIVE_OBSERVED',{enabled},120_000)).receipt;},
        },
        async gatewayStage(stage){demand(!interactivePlan&&armed&&!prepared&&['closed','recovery','browser'].includes(stage));const receipt=(await request('certification-gateway-stage','CERTIFICATION_GATEWAY_OBSERVED',{stage})).receipt;
          browserOpened=stage==='browser'&&receipt?.gateway?.newWork===true&&receipt?.gateway?.recovery===false;return receipt;},
        async observeGateway(){demand(armed&&!prepared);return(await request('certification-gateway-observe','CERTIFICATION_GATEWAY_OBSERVED')).receipt;},
        async authenticationStage(plan,browserController){
          demand(launch===spawn&&armed&&!prepared&&browserOpened&&initial.certificationPlan.mode==='auth-preparation'&&isDeepStrictEqual(plan,browserPlan));
          const readers=await import('./p2-lifecycle-suspension-evidence.mjs'),binding=readers.readP2LifecycleBrowserControllerBinding(plan,browserController);
          demand(binding.challenge===initial.sourceParentChallenge);await verify();
          const receipt=(await request('authentication-stage','CERTIFICATION_AUTHENTICATION_HELD',{bindingSha256:binding.bindingSha256})).receipt;
          demand(receipt.status==='P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD'&&receipt.bindingSha256===binding.bindingSha256&&receipt.certificationActionId===initial.certificationActionId);
          validateBrowser(plan,receipt.canonicalBrowserObservation);
          demand(p2NativeHash(receipt.canonicalBrowserObservation)===receipt.canonicalBrowserObservationSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&browserOpened&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          const handle=Object.freeze({});authenticationStages.set(handle,{plan,snapshot,active:alive,receipt});return handle;
        },
        async suspensionEvidenceStage(plan,browserController){
          demand(launch===spawn&&armed&&!prepared&&initial.certificationPlan.mode==='browser-pending'&&isDeepStrictEqual(plan,browserPlan));
          const readers=await import('./p2-lifecycle-suspension-evidence.mjs');
          const binding=readers.readP2LifecycleBrowserControllerBinding(plan,browserController);
          demand(binding.challenge===initial.sourceParentChallenge);
          const ready=await request('suspension-ready','CERTIFICATION_SUSPENSION_READY',{bindingSha256:binding.bindingSha256});
          demand(ready.receipt?.bindingSha256===binding.bindingSha256);
          validateBrowser(plan,ready.receipt.canonicalBrowserObservation);
          demand(p2NativeHash(ready.receipt.canonicalBrowserObservation)===ready.receipt.canonicalBrowserObservationSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          const call=async(operation,data={},timeout=120_000)=>{demand(alive());return(await request(operation,'CERTIFICATION_SUSPENSION_OBSERVED',data,timeout)).receipt;};
          const methods=Object.freeze({
            captureControlled:()=>call('suspension-controlled'),
            captureNaturalExpiry:()=>call('suspension-natural-expiry',{event:readers.readP2LifecycleBrowserSuspensionEvent(plan,browserController)},720_000),
            async capturePending(handle){const artifact=readers.readP2SuspensionPendingSourceArtifact(plan,handle);demand(Buffer.isBuffer(artifact.bytes)&&artifact.bytes.length>0&&artifact.bytes.length<=2_000_000);return call('suspension-pending',{record:artifact.record});},
            async retain(handle){const artifact=readers.readP2LifecycleBrowserSourceArtifact(plan,handle);demand(Buffer.isBuffer(artifact.bytes)&&artifact.bytes.length>0&&artifact.bytes.length<=2_000_000);return call('suspension-retain-browser',{artifact:artifact.bytes.toString('base64')});},
          });
          const handle=Object.freeze({});suspensionStages.set(handle,{plan,snapshot,active:alive,methods,canonicalBrowserObservationSha256:ready.receipt.canonicalBrowserObservationSha256});return handle;
        },
        async workerEvidenceStage(plan){
          demand(launch===spawn&&armed&&!prepared&&initial.certificationPlan.mode==='direct-worker'&&isDeepStrictEqual(plan,workerPlan));
          const readers=await import('./p2-lifecycle-worker-evidence.mjs');
          const ready=(await request('worker-ready','CERTIFICATION_WORKER_READY')).receipt;demand(ready.bindingSha256===initial.certificationPlan.workerPlanSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          let credential;
          const call=async(operation,data={},timeout=120_000)=>{demand(alive());return(await request(operation,'CERTIFICATION_WORKER_OBSERVED',data,timeout)).receipt;};
          const methods=Object.freeze({
            async preflightCredential(handle){const secret=readers.readP2LifecycleWorkerCronSecret(handle);demand(credential===undefined);credential=secret;return call('worker-credential',{secret},240_000);},
            async invokeDirect(handle){const secret=readers.readP2LifecycleWorkerCronSecret(handle);demand(credential!==undefined&&secret===credential);return call('worker-invoke',{secret},120_000);},
            async observeLifecycleWitness(handle){const runtimeUrl=await readers.readP2LifecycleWorkerRuntimeUrl(handle);return call('worker-witness',{runtimeUrl},240_000);},
            observeReceiverDenials:()=>call('worker-denials',{},120_000),
            finalClosedReadback:()=>call('worker-final-closed'),
            async retainJoined(handle){const source=readers.readP2DirectWorkerSourceArtifact(plan,handle);demand(Buffer.isBuffer(source.bytes)&&source.bytes.length>0&&source.bytes.length<=262144);
              return call('worker-retain',{record:source.record,sourceArtifact:source.bytes.toString('base64')});},
          });
          const handle=Object.freeze({});workerStages.set(handle,{plan,snapshot,active:alive,methods});return handle;
        },
        async knownAckStage(plan){
          demand(launch===spawn&&armed&&!prepared&&initial.certificationPlan.mode==='known-ack-recovery'&&isDeepStrictEqual(plan,initial.certificationPlan));
          const read=async(operation,data={},timeout=180_000)=>{
            const receipt=(await request(operation,'CERTIFICATION_KNOWN_ACK_OBSERVED',data,timeout)).receipt;
            if(profiled){requireQualificationTargetProfile(currentProfile,receipt);demand(receipt.version===2);}
            return receipt;
          };
          const ready=await read('known-prepare');
          demand(ready.status==='P2_KNOWN_ACK_SOURCE_STAGE_PREPARED'&&ready.bindingSha256===plan.planSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          const call=(operation,data,timeout)=>{demand(alive());return read(operation,data,timeout);};
          let replacementAttempted=false,settlementAttempted=false,settlementConfirmed=false;
          const methods=Object.freeze({armFault:()=>call('known-arm'),startWindow:()=>call('known-start-window'),observeDomain:()=>call('known-domain'),
            retainRequestDetails:bytes=>{demand(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=2_000_000);return call('known-requests',{requestArtifact:bytes.toString('base64')});},
            prepareSettlement:()=>call('known-settlement'),
            ...(profiled?{async confirmSettlement(){
              demand(!settlementAttempted);settlementAttempted=true;
              const result=await call('known-confirm-settlement');demand(result.status==='P2_KNOWN_ACK_RECONCILIATION_OBSERVED_FENCED');
              settlementConfirmed=true;return result;
            }}:{}),
            replace:()=>{demand(!replacementAttempted&&(!profiled||settlementConfirmed));replacementAttempted=true;return call('known-replace',{},800_000);}});
          const handle=Object.freeze({});knownAckStages.set(handle,{plan,snapshot,active:alive,methods});return handle;
        },
        async prepareFault(plan){demand(!interactivePlan&&armed&&!prepared);await request('fault-initialize','CERTIFICATION_FAULT_READY',{plan});
          const call=async(operation,data={})=>(await request(operation,'CERTIFICATION_FAULT_OBSERVED',{plan,...data})).receipt;
          return{verify:async()=>{await call('fault-verify');},observe:()=>call('fault-observe'),arm:(_plan,record)=>call('fault-arm',{record}),effects:()=>call('fault-effects'),
            disarm:()=>call('fault-disarm'),closeGateway:()=>call('fault-close-gateway')};},
        async prepareClose(caseOutcome,requestEvidence){demand(armed&&!prepared&&(!interactivePlan||
          interactiveRetained&&isDeepStrictEqual(caseOutcome,interactiveRetained)&&requestEvidence===undefined));
          const value=await request('certification-prepare-close','CERTIFICATION_CLOSE_PREPARED',{caseOutcome,requestEvidence},240_000);prepared=true;return value.receipt;},
        async finish(outcome){demand(prepared);const name=profiled?'p2-certification-close-prepared.json':'p2-certification-outcome.json';
          const bytes=readFrontendReleaseEvidence(directory,name);demand(JSON.stringify(JSON.parse(bytes))===JSON.stringify(outcome));
          joined=await request('finish','P2_CERTIFICATION_JOINED',{certification:bytes.toString('base64')});return joined.receipt;},
        failClosed:fail,
      };
      await verify();result=await task(verify,controller.signal,host);await verify();demand(joined&&!failed);
      const committed=await request('commit','COMMITTED');demand(JSON.stringify(committed.receipt)===JSON.stringify(joined.receipt));
      if(profiled){
        requireQualificationTargetProfile(currentProfile,committed.receipt);
        demand(committed.receipt.version===2&&committed.receipt.status==='P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED'&&
          committed.receipt.planSha256===initial.certificationPlan.planSha256);
        committedReceipt=committed.receipt;
      }else writeFrontendReceipt(directory,'p2-host-certification-outcome.json',committed.receipt);
      active=false;
    }catch{error=new Error('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW');fail();}
    finally{
      clearInterval(heartbeat);child.stdin.end();
      if(profiled){
        const stop=setTimeout(()=>{error??=new Error('P2_CERTIFICATION_HOST_CLEANUP_UNCERTAIN');child.kill('SIGTERM');},60_000);
        const kill=setTimeout(()=>child.kill('SIGKILL'),65_000);
        await reaped;clearTimeout(stop);clearTimeout(kill);
      }else if(exited===undefined)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');error??=new Error('P2_CERTIFICATION_HOST_CLEANUP_UNCERTAIN');resolve();},60_000);child.once('close',()=>{clearTimeout(timer);resolve();});});
      active=false;lines.close();for(const waiter of pending.values())clearTimeout(waiter.timer);
      if(exited!==0)error??=new Error('P2_CERTIFICATION_HOST_CLEANUP_UNCERTAIN');
    }
    if(error)throw error;
    if(profiled){demand(committedReceipt);writeFrontendReceipt(directory,'p2-host-certification-outcome.json',committedReceipt);}
    return result;
  };
}
