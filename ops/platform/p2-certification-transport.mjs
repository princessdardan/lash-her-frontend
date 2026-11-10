// Fixed SSH broker. Only source methods are exposed; no commands from JSON.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFrontendReceipt} from './frontend-migration.mjs';
import {readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {sshCommand} from './recreation_ssh.mjs';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {validP2FirstOwnerSelection} from './p2-first-owner-identity.mjs';
import {validateP2CanonicalBrowserObservation} from './p2-canonical-browser-origin.mjs';
import {requireP2CertificationRotationTerminal} from './p2-certification-rotation-successor.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';
import {validateP2LessonRestorePriorSelection} from './p2-lesson-restore-prior.mjs';
import {validateP2LessonAckLossReceipt,validateP2LessonExitSaveReceipt,validateP2LessonVisibilityReceipt,
  validateP2LessonStaleRevisionReceipt,validP2MediaReservationAction,p2MediaReservationBody,
  p2MediaUploadCallbackOperation,validateP2MediaDispatchIntent,validateP2MediaDispatchReceipt,
  validateP2MediaReservationReceipt,p2StalledRenewalStage,validateP2StalledPlaybackRenewalBaseline,validateP2StalledPlaybackRenewalReceipt} from './p2-lifecycle-browser-recorder.mjs';
import {lessonAckLossBodies,lessonExitSaveBodies,lessonStaleRevisionBodies} from '../gateway/lesson-resume-position.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';

const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_TRANSPORT_REFUSED');};
const MAXIMUM=4_000_000;
const suspensionStages=new WeakMap();
const authenticationStages=new WeakMap();
const workerStages=new WeakMap();
const knownAckStages=new WeakMap();
const interactiveStages=new WeakMap();
const mediaDispatchReceipts=new WeakMap();
const stalledFenceReceipts=new WeakMap();
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const nonzeroSha256=value=>sha256(value)&&!/^0+$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const canonicalUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const providerId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,255}$/u.test(value);
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
const utc=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const interactiveReceiptKeys=['version','qualificationTargetProfile','status','certificationActionId','planSha256','stage'];
const gatewayFenceKeys=['gatewayAdmissionClosed','gatewayActive','gatewayUncertain'];
const closedGateway=value=>value.gatewayAdmissionClosed===true&&value.gatewayActive===0&&value.gatewayUncertain===0;
const authoringCourseTarget='/course/v1/admin/courses';
const authoringReorderOperation='reorder-and-stale-curriculum';
const authoringCreateCurriculumOperation='create-curriculum';
const authoringPublicationOperation='qualify-publication';
const authoringRepublishOperation='republish-paid-course';
const authoringQuizOperation='save-quiz-revision';
const authoringArchiveOperation='archive-paid-course';
const mediaOperations=new Set(['reserve-video-upload',p2MediaUploadCallbackOperation]);
const learningEnrollmentOperation='enroll-free-course';
const learningReplayOperation='replay-free-enrollment';
const paidGrantOperation='grant-paid-access';
const learnerAccessOperation='observe-paid-access';
const lessonEntryOperation='open-lesson';
const lessonDenialOperation='deny-cross-account';
const assessmentOperation='fail-then-pass';
const resumeOperation='play-and-rewind';
const restoreOperation='restore-resume';
const ackLossOperation='commit-drop-recover';
const exitSaveOperations=new Set(['spa-navigation','document-exit']);
const visibilityOperation='hide-active-document';
const staleRevisionOperation='conflict-reload';
const assessmentAnswerKey=value=>typeof value==='string'&&/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const uuid4=value=>canonicalUuid(value)&&value[14]==='4';
const paidRevokeOperation='revoke-paid-grant';
const learnerAccessOutcomes={
  allowed:{status:200,codes:[null]},archived:{status:410,codes:['course_archived']},
  draft:{status:404,codes:['not_found']},restricted:{status:403,codes:['access_required','access_revoked']},
};
const authoringPairedOperation=operation=>operation==='edit-and-stale-draft'||operation===authoringReorderOperation;
const authoringPublicationCase=operation=>operation===authoringPublicationOperation||operation===authoringRepublishOperation;
const emptyBodySha256=p2NativeHash(Buffer.alloc(0));
const interactiveGatewayKeys=['epoch','gatewayStateSha256','gatewayAcknowledgements','gatewayActive','gatewayUncertain','gatewayEvidenceSha256'];
const scopedOperations={
  'export-cleanup':['scoped-export-preflight','scoped-export-invoke','scoped-export-join'],
  'mux-callback-recovery':['scoped-mux-open','scoped-mux-observe','scoped-mux-close'],
  'lifecycle-persistence':['scoped-persistence-observe'],
  'mux-readiness':['scoped-mux-readiness-observe'],
  'mux-replacement-evidence':['scoped-mux-replacement-observe'],
};
const dayTwoAuthorityModes=new Set(['auth-preparation','browser-pending','direct-worker']);
export const usesP2ProfiledDayTwoAuthority=mode=>dayTwoAuthorityModes.has(mode);

export function readP2CertificationKnownAckStage(handle,plan){
  const selected=knownAckStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return selected.methods;
}

export function readP2CertificationInteractiveStage(handle,plan){
  const selected=interactiveStages.get(handle);demand(selected&&selected.plan===plan&&selected.active());
  if(plan.scopedAction.mediaAction?.operation===p2MediaUploadCallbackOperation)
    demand(typeof selected.methods.armMedia==='function'&&typeof selected.methods.observeMedia==='function');
  if(plan.scopedAction.stage===p2StalledRenewalStage)demand(typeof selected.methods.confirmObservationFence==='function');
  return selected.methods;
}

export function takeP2InteractiveMediaDispatch(plan,controller,receipt){
  const source=mediaDispatchReceipts.get(receipt);
  demand(source&&source.plan===plan&&source.controller===controller&&source.active()&&source.dispatch.expiresAt*1000>Date.now());
  mediaDispatchReceipts.delete(receipt);
  return source.dispatch;
}

export function takeP2InteractiveStalledObservationFence(plan,controller,receipt){
  const source=stalledFenceReceipts.get(receipt);
  demand(source&&source.plan===plan&&source.controller===controller&&source.active());
  stalledFenceReceipts.delete(receipt);
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
  const publication=authoringPublicationCase(selected?.operation),published=publication&&selected.outcome==='published';
  const republish=selected?.operation===authoringRepublishOperation;
  const quiz=selected?.operation===authoringQuizOperation;
  const archive=selected?.operation===authoringArchiveOperation;
  const paired=authoringPairedOperation(selected?.operation);
  const curriculum=reorder||createCurriculum;
  const hasCourse=paired||createCurriculum||publication||quiz||archive;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','slug',...(hasCourse?['courseId','revision']:[]),
    ...(curriculum?['kind','parentId']:[]),...(createCurriculum?['childSlug']:[]),...(publication?['outcome','issueCodes']:[]),
    ...(quiz?['lessonId','quizRevision','documentSha256']:[]),...(archive||republish?['userId','grantId']:[]),
    ...(republish?['expectedAccess']:[])])&&
    courseSlug(selected.slug)&&action.requests.length===(republish?published?4:3:paired||published||quiz?3:2));
  const selection={...selected,actorKind:'admin',actorId:action.actorId};
  if(hasCourse)demand(canonicalUuid(selected.courseId)&&Number.isInteger(selected.revision)&&selected.revision>=1&&
    selected.revision<=(republish?2_147_483_645:2_147_483_646));
  if(archive){
    const target=authoringCourseTarget+'/'+selected.courseId;
    demand([selected.userId,selected.grantId].every(canonicalUuid)&&
      isDeepStrictEqual(read,{method:'GET',target,bodySha256:emptyBodySha256,uses:2})&&
      isDeepStrictEqual(second,{method:'PATCH',target,uses:1,
        bodySha256:p2NativeHash(JSON.stringify({expectedRevision:selected.revision,status:'archived'}))}));
    return {selection,authoring:{actorId:action.actorId,...selected,bodySha256:second.bodySha256}};
  }
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
    const expected=[
      {method:'GET',target,bodySha256:emptyBodySha256,uses:(published?2:1)+Number(republish)},
      ...(republish?[{method:'PATCH',target,uses:1,bodySha256:p2NativeHash(JSON.stringify({expectedRevision:revision,status:'draft'}))}]:[]),
      {method:'GET',target:target+'/publication-readiness',bodySha256:emptyBodySha256,uses:1},
    ];
    if(published)expected.push({method:'PATCH',target,uses:1,
      bodySha256:p2NativeHash(JSON.stringify({expectedRevision:revision+Number(republish),status:'published'}))});
    demand(['published','blocked'].includes(outcome)&&Array.isArray(issueCodes)&&
      (published?issueCodes.length===0:issueCodes.length>=1&&issueCodes.length<=16)&&
      Array.from(issueCodes).every((code,index)=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)&&
        (index===0||issueCodes[index-1]<code))&&
      (!republish||[selected.userId,selected.grantId].every(canonicalUuid)&&typeof selected.expectedAccess==='boolean')&&
      isDeepStrictEqual(action.requests,expected));
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
  const replay=selected?.operation===learningReplayOperation;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','slug','idempotencyKey',...(replay?['prior']:[])])&&
    (replay||selected.operation===learningEnrollmentOperation)&&canonicalUuid(selected.courseId)&&courseSlug(selected.slug)&&
    canonicalUuid(selected.idempotencyKey));
  const {courseId,slug,idempotencyKey,prior}=selected,student='/course/v1/student',detail=student+'/courses/'+courseId;
  if(replay)demand(exact(prior,['grantId','enrollmentId','eventId','streamId','canonicalDigest'])&&
    [prior.grantId,prior.enrollmentId,prior.eventId,prior.streamId].every(canonicalUuid)&&nonzeroSha256(prior.canonicalDigest));
  const course={method:'GET',target:detail,bodySha256:emptyBodySha256,uses:replay?1:2};
  const progress={method:'GET',target:student+'/progress?courseId='+courseId,bodySha256:emptyBodySha256,uses:1};
  const enroll={method:'POST',target:detail+'/enrollments',bodySha256:p2NativeHash(JSON.stringify({idempotencyKey})),uses:1};
  demand(isDeepStrictEqual(action.requests,replay?[course,progress,enroll]:[
    {method:'GET',target:'/course/v1/courses/'+slug,bodySha256:emptyBodySha256,uses:1},course,enroll,progress,
  ]));
  const learning={actorId:action.actorId,...selected,...(replay?{prior:{...prior}}:{})};
  return {selection:{...learning,actorKind:'customer'},learning};
}

function reviewedPaidGrantAction(action){
  const selected=action.paidGrantAction;
  const second=selected!==null&&selected!==undefined&&Object.hasOwn(selected,'priorGrantId');
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','userId','revision','idempotencyKey','reasonSha256',
    ...(second?['priorGrantId']:[])])&&(!second||canonicalUuid(selected.priorGrantId))&&
    selected.operation===paidGrantOperation&&[selected.courseId,selected.userId,selected.idempotencyKey].every(canonicalUuid)&&
    Number.isInteger(selected.revision)&&selected.revision>=1&&selected.revision<=2_147_483_647&&
    nonzeroSha256(selected.reasonSha256)&&selected.reasonSha256!==emptyBodySha256);
  const {operation,courseId,userId,revision,idempotencyKey,reasonSha256}=selected,grant=action.requests[2];
  const grants='/course/v1/admin/entitlements/grants',key='owner-paid%3A'+idempotencyKey;
  demand(reviewedWriteRequest(grant,'POST',grants)&&isDeepStrictEqual(action.requests,[
    {method:'GET',target:authoringCourseTarget+'/'+courseId,bodySha256:emptyBodySha256,uses:3},
    {method:'GET',target:'/course/v1/admin/entitlements/commands?idempotencyKey='+key+'&limit=2',bodySha256:emptyBodySha256,uses:2},
    grant,
    {method:'GET',target:grants+'?userId='+userId+'&courseId='+courseId+'&idempotencyKey='+key+'&limit=2',bodySha256:emptyBodySha256,uses:1},
  ]));
  return {selection:{actorId:action.actorId,...selected,actorKind:'admin'},
    paidGrant:{actorId:action.actorId,operation,courseId,userId,revision,idempotencyKey,reasonSha256}};
}

function reviewedLearnerAccessAction(action){
  const selected=action.learnerAccessAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','lessonId','grantId','revision','outcome'])&&
    selected.operation===learnerAccessOperation&&[selected.courseId,selected.lessonId,selected.grantId].every(canonicalUuid)&&
    Number.isInteger(selected.revision)&&selected.revision>=1&&selected.revision<=2_147_483_647&&
    typeof selected.outcome==='string'&&Object.hasOwn(learnerAccessOutcomes,selected.outcome));
  const {courseId,lessonId}=selected,student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  demand(isDeepStrictEqual(action.requests,[
    student+'/courses/'+courseId,student+'/progress?courseId='+courseId,lesson,lesson+'/playback',
    student+'/progress?lessonId='+lessonId,lesson+'/quiz',lesson+'/quiz/attempts',
  ].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===0?2:1}))));
  const learnerAccess={actorId:action.actorId,...selected};
  return {selection:{...learnerAccess,actorKind:'customer'},learnerAccess};
}

function reviewedLessonEntryAction(action){
  const selected=action.lessonEntryAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','lessonId','grantId'])&&
    selected.operation===lessonEntryOperation&&[selected.courseId,selected.lessonId,selected.grantId].every(canonicalUuid));
  const {courseId,lessonId}=selected,student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  const reads=[student+'/courses/'+courseId,student+'/progress?courseId='+courseId,lesson,
    student+'/progress?lessonId='+lessonId,lesson+'/quiz',lesson+'/quiz/attempts',lesson+'/playback'];
  demand(isDeepStrictEqual(action.requests,[
    ...reads.map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===0?2:1})),
    {method:'POST',target:lesson+'/progress',bodySha256:p2NativeHash(JSON.stringify({
      event:'lesson_started',expectedProgressRevision:0,
    })),uses:1},
  ]));
  const lessonEntry={actorId:action.actorId,...selected};
  return {selection:{...lessonEntry,actorKind:'customer'},lessonEntry};
}

export function validateP2InteractiveStalledRenewalAction(selected,requests){
  if(!exact(selected,['courseId','lessonId','playbackIdSha256'])||![selected.courseId,selected.lessonId].every(canonicalUuid)||
    !nonzeroSha256(selected.playbackIdSha256))return false;
  const {courseId,lessonId}=selected,student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  return isDeepStrictEqual(requests,[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,
    lesson+'/quiz',lesson+'/quiz/attempts',lesson+'/playback']
    .map(target=>({method:'GET',target,uses:1,bodySha256:emptyBodySha256})));
}

function reviewedLessonDenialAction(action){
  const selected=action.lessonDenialAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','lessonId','enrolledActorId','grantId'])&&
    selected.operation===lessonDenialOperation&&[selected.courseId,selected.lessonId,selected.enrolledActorId,selected.grantId].every(canonicalUuid)&&
    selected.enrolledActorId!==action.actorId);
  const {courseId,lessonId}=selected,student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  const targets=[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
    lesson+'/quiz/attempts',lesson+'/playback'];
  demand(isDeepStrictEqual(action.requests,targets.map((target,index)=>({
    method:'GET',target,bodySha256:emptyBodySha256,uses:[2,3,3,3,3,1][index],
  }))));
  const lessonDenial={actorId:action.actorId,...selected};
  return {selection:{...lessonDenial,actorKind:'customer'},lessonDenial};
}

function reviewedPaidRevokeAction(action){
  const selected=action.paidRevokeAction;
  demand(canonicalUuid(action.actorId)&&exact(selected,['operation','courseId','userId','grantId','revision','idempotencyKey','reasonSha256','remainingAccess'])&&
    selected.operation===paidRevokeOperation&&[selected.courseId,selected.userId,selected.grantId,selected.idempotencyKey].every(canonicalUuid)&&
    Number.isInteger(selected.revision)&&selected.revision>=1&&selected.revision<=2_147_483_647&&
    nonzeroSha256(selected.reasonSha256)&&selected.reasonSha256!==emptyBodySha256&&typeof selected.remainingAccess==='boolean');
  const {courseId,userId,grantId,idempotencyKey}=selected,write=action.requests[3],base='/course/v1/admin/entitlements';
  const key='owner-paid-revoke%3A'+idempotencyKey;
  demand(reviewedWriteRequest(write,'POST',base+'/revocations')&&isDeepStrictEqual(action.requests,[
    {method:'GET',target:authoringCourseTarget+'/'+courseId,bodySha256:emptyBodySha256,uses:3},
    {method:'GET',target:base+'/commands?idempotencyKey='+key+'&limit=2',bodySha256:emptyBodySha256,uses:2},
    {method:'GET',target:base+'/grants?grantId='+grantId+'&userId='+userId+'&courseId='+courseId+'&limit=2',bodySha256:emptyBodySha256,uses:2},
    write,
  ]));
  const paidRevoke={actorId:action.actorId,...selected};
  return {selection:{...paidRevoke,actorKind:'admin'},paidRevoke};
}

export function validateP2InteractiveAssessmentAction(selected,requests){
  if(!exact(selected,['operation','courseId','lessonId','grantId','quizRevision','failAnswers','passAnswers'])||
    selected.operation!==assessmentOperation||![selected.courseId,selected.lessonId,selected.grantId].every(canonicalUuid)||
    !Number.isInteger(selected.quizRevision)||selected.quizRevision<1||selected.quizRevision>2_147_483_647)return false;
  const {courseId,lessonId,quizRevision,failAnswers,passAnswers}=selected;
  const validAnswers=answers=>Array.isArray(answers)&&answers.length>=1&&answers.length<=100&&
    answers.every(answer=>exact(answer,['questionId','optionId'])&&assessmentAnswerKey(answer.questionId)&&assessmentAnswerKey(answer.optionId))&&
    new Set(answers.map(answer=>answer.questionId)).size===answers.length;
  if(!validAnswers(failAnswers)||!validAnswers(passAnswers)||
    !isDeepStrictEqual(failAnswers.map(answer=>answer.questionId),passAnswers.map(answer=>answer.questionId))||
    isDeepStrictEqual(failAnswers,passAnswers))return false;
  const student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback']
      .map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===2?3:1})),
    {method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(JSON.stringify({event:'lesson_started',expectedProgressRevision:0}))},
    ...[failAnswers,passAnswers].map(answers=>({method:'POST',target:lesson+'/quiz/attempts',uses:1,
      bodySha256:p2NativeHash(JSON.stringify({quizRevision,answers:answers.map(({questionId,optionId})=>({questionId,optionId}))}))})),
  ]);
}

function reviewedAssessmentAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveAssessmentAction(action.assessmentAction,action.requests));
  const assessment={actorId:action.actorId,...action.assessmentAction};
  return {selection:{...assessment,actorKind:'customer'},assessment};
}

export function validateP2InteractiveResumeAction(selected,requests){
  if(!exact(selected,['operation','courseId','lessonId','grantId'])||
    selected.operation!==resumeOperation||![selected.courseId,selected.lessonId,selected.grantId].every(canonicalUuid))return false;
  const {courseId,lessonId}=selected,student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  const progressPost=body=>({method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(JSON.stringify(body))});
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback'].map(target=>({method:'GET',target,bodySha256:emptyBodySha256,uses:1})),
    progressPost({event:'lesson_started',expectedProgressRevision:0}),
    ...[1,2,3].map(expectedProgressRevision=>progressPost({expectedProgressRevision})),
  ]);
}

function reviewedResumeAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveResumeAction(action.resumeAction,action.requests));
  const resume={actorId:action.actorId,...action.resumeAction};
  return {selection:{...resume,actorKind:'customer'},resume};
}

export function validateP2InteractiveRestoreAction(selected,requests){
  if(!exact(selected,['operation','courseId','lessonId','grantId','prior'])||
    selected.operation!==restoreOperation||![selected.courseId,selected.lessonId,selected.grantId].every(canonicalUuid)||
    !validateP2LessonRestorePriorSelection(selected.prior))return false;
  const {courseId,lessonId,prior:{resumePositionSeconds,maxPositionSeconds}}=selected;
  const student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  const progressPost=body=>({method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(JSON.stringify(body))});
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback'].map(target=>({method:'GET',target,bodySha256:emptyBodySha256,uses:1})),
    progressPost({event:'lesson_started',expectedProgressRevision:4}),
    progressPost({resumePositionSeconds,maxPositionSeconds,expectedProgressRevision:5}),
  ]);
}

function reviewedRestoreAction(action,plan){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveRestoreAction(action.restoreAction,action.requests)&&
    action.restoreAction.prior.actionId!==plan.certificationActionId&&BigInt(plan.initialEpoch)>2n);
  const restore={actorId:action.actorId,...action.restoreAction};
  return {selection:{...restore,actorKind:'customer'},restore};
}

export function validateP2InteractiveAckLossAction(selected,requests){
  if(!exact(selected,['operation','courseId','lessonId','grantId','progressId','enrollmentId',
    'resumePositionSeconds','maxPositionSeconds','playbackIdSha256'])||selected.operation!==ackLossOperation||
    ![selected.courseId,selected.lessonId,selected.grantId,selected.progressId,selected.enrollmentId].every(canonicalUuid)||
    !nonzeroSha256(selected.playbackIdSha256))return false;
  const {courseId,lessonId,resumePositionSeconds,maxPositionSeconds}=selected;
  if(!Number.isInteger(resumePositionSeconds)||resumePositionSeconds<3||resumePositionSeconds>6||
    maxPositionSeconds!==resumePositionSeconds+10)return false;
  const student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback'].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===2?3:2})),
    ...lessonAckLossBodies(resumePositionSeconds).map(body=>({method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(body)})),
  ]);
}

function reviewedAckLossAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveAckLossAction(action.ackLossAction,action.requests));
  const ackLoss={actorId:action.actorId,...action.ackLossAction};
  return {selection:{...ackLoss,actorKind:'customer'},ackLoss};
}

function validateReviewedPositionAction(selected,requests,visibility){
  if(!exact(selected,['operation','courseId','lessonId','grantId','progressId','enrollmentId',
    'resumePositionSeconds','maxPositionSeconds','playbackIdSha256'])||
    !(visibility?selected.operation===visibilityOperation:exitSaveOperations.has(selected.operation))||
    ![selected.courseId,selected.lessonId,selected.grantId,selected.progressId,selected.enrollmentId].every(canonicalUuid)||
    !nonzeroSha256(selected.playbackIdSha256))return false;
  const {courseId,lessonId,resumePositionSeconds,maxPositionSeconds}=selected;
  if(!Number.isInteger(resumePositionSeconds)||resumePositionSeconds<3||resumePositionSeconds>6||
    maxPositionSeconds!==resumePositionSeconds+10)return false;
  const student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback'].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:!visibility&&index===0?2:1})),
    ...lessonExitSaveBodies(resumePositionSeconds).map(body=>({method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(body)})),
    ...(visibility?[]:[{method:'GET',target:student+'/progress?courseId='+courseId,bodySha256:emptyBodySha256,uses:1}]),
  ]);
}

export function validateP2InteractiveExitSaveAction(selected,requests){
  return validateReviewedPositionAction(selected,requests,false);
}

export function validateP2InteractiveVisibilityAction(selected,requests){
  return validateReviewedPositionAction(selected,requests,true);
}

function reviewedExitSaveAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveExitSaveAction(action.exitSaveAction,action.requests));
  const exitSave={actorId:action.actorId,...action.exitSaveAction};
  return {selection:{...exitSave,actorKind:'customer'},exitSave};
}

function reviewedVisibilityAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveVisibilityAction(action.visibilityAction,action.requests));
  const visibility={actorId:action.actorId,...action.visibilityAction};
  return {selection:{...visibility,actorKind:'customer'},visibility};
}

export function validateP2InteractiveStaleRevisionAction(selected,requests){
  if(!exact(selected,['operation','courseId','lessonId','grantId','progressId','enrollmentId',
    'resumePositionSeconds','maxPositionSeconds','playbackIdSha256'])||selected.operation!==staleRevisionOperation||
    ![selected.courseId,selected.lessonId,selected.grantId,selected.progressId,selected.enrollmentId].every(canonicalUuid)||
    !nonzeroSha256(selected.playbackIdSha256))return false;
  const {courseId,lessonId,resumePositionSeconds,maxPositionSeconds}=selected;
  if(!Number.isInteger(resumePositionSeconds)||resumePositionSeconds<3||resumePositionSeconds>6||
    maxPositionSeconds!==resumePositionSeconds+10)return false;
  const student='/course/v1/student',lesson=student+'/lessons/'+lessonId;
  return isDeepStrictEqual(requests,[
    ...[student+'/courses/'+courseId,lesson,student+'/progress?lessonId='+lessonId,lesson+'/quiz',
      lesson+'/quiz/attempts',lesson+'/playback'].map((target,index)=>({method:'GET',target,bodySha256:emptyBodySha256,uses:index===2?4:3})),
    ...lessonStaleRevisionBodies(resumePositionSeconds).map(body=>({method:'POST',target:lesson+'/progress',uses:1,bodySha256:p2NativeHash(body)})),
  ]);
}

function reviewedStaleRevisionAction(action){
  demand(canonicalUuid(action.actorId)&&validateP2InteractiveStaleRevisionAction(action.staleRevisionAction,action.requests));
  const staleRevision={actorId:action.actorId,...action.staleRevisionAction};
  return {selection:{...staleRevision,actorKind:'customer'},staleRevision};
}

export function validP2MediaReservationRequests(selected,requests){
  if(!validP2MediaReservationAction(selected))return false;
  const lesson='/course/v1/admin/lessons/'+selected.lessonId;
  return isDeepStrictEqual(requests,[
    {method:'GET',target:'/course/v1/admin/courses/'+selected.courseId,bodySha256:emptyBodySha256,uses:1},
    {method:'GET',target:lesson+'/video',bodySha256:emptyBodySha256,uses:1},
    {method:'POST',target:lesson+'/video-upload',bodySha256:p2NativeHash(p2MediaReservationBody(selected)),uses:1},
  ]);
}

export function mediaReservationJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse']));
  const browser=validateP2MediaReservationReceipt(evidence.browserResponse,selected);
  demand(browser.read.requestId===observed.gatewayAcknowledgements[1].requestId&&
    browser.reservation.requestId===observed.gatewayAcknowledgements[2].requestId);
  return {actorId:selected.actorId,operation:selected.operation,courseId:selected.courseId,lessonId:selected.lessonId,
    courseRevision:selected.revision+1,currentVideoAssetId:selected.currentVideoAssetId,attemptId:browser.reservation.assetId,
    uploadId:browser.reservation.uploadId,assetStatus:'uploading',isCurrent:selected.currentVideoAssetId===null,
    uploadTimeoutSeconds:browser.reservation.uploadTimeoutSeconds,fileSha256:selected.fileSha256,fileBytes:selected.fileBytes,
    contentType:selected.contentType,uploadIntercepted:true,uploadSent:false,gatewayPostRequestId:browser.reservation.requestId,
    browserResponseSha256:p2NativeHash(browser),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function reviewedInteractivePlan(plan,initial){
  const action=plan.scopedAction,binding=initial.interactiveController;
  const identity=action?.stage==='identity',authoring=action?.stage==='authoring',media=action?.stage==='media',learning=action?.stage==='learning';
  const paidGrant=action?.stage==='paid-grant',learnerAccess=action?.stage==='learner-access';
  const paidRevoke=action?.stage==='paid-revoke',lessonEntry=action?.stage==='lesson-entry';
  const lessonDenial=action?.stage==='lesson-denial',assessment=action?.stage==='lesson-assessment',resume=action?.stage==='lesson-resume',restore=action?.stage==='lesson-restore';
  const ackLoss=action?.stage==='lesson-ack-loss';
  const exitSave=action?.stage==='lesson-exit-save';
  const visibility=action?.stage==='lesson-visibility-save';
  const staleRevision=action?.stage==='lesson-stale-revision',stalledRenewal=action?.stage===p2StalledRenewalStage;
  const gatewayScoped=authoring||media||learning||paidGrant||learnerAccess||paidRevoke||lessonEntry||lessonDenial||assessment||resume||restore||ackLoss||exitSave||visibility||staleRevision||stalledRenewal;
  const enrollment=identity&&Object.hasOwn(action,'identityEnrollment');
  const firstOwner=identity&&Object.hasOwn(action,'firstOwner');
  demand(plan.environment==='staging'&&plan.sourceCommit===initial.sourceCommit&&plan.operatorSourceCommit===initial.sourceCommit&&
    plan.maximumSeconds===(stalledRenewal?900:300)&&typeof plan.initialEpoch==='string'&&/^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch)&&
    (BigInt(plan.initialEpoch)+2n).toString().length<=18&&sha256(plan.planSha256)&&
    (identity||gatewayScoped||action?.stage==='lifecycle')&&exact(action,['stage','actorId','requests','windowSeconds',
      firstOwner?'firstOwner':enrollment?'identityEnrollment':identity?'identityActor':authoring?'authoringAction':media?'mediaAction':learning?'learningAction':
        paidGrant?'paidGrantAction':learnerAccess?'learnerAccessAction':paidRevoke?'paidRevokeAction':
          lessonEntry?'lessonEntryAction':lessonDenial?'lessonDenialAction':assessment?'assessmentAction':resume?'resumeAction':restore?'restoreAction':
            ackLoss?'ackLossAction':exitSave?'exitSaveAction':visibility?'visibilityAction':staleRevision?'staleRevisionAction':stalledRenewal?'stalledRenewalAction':'frontendAction'])&&
    Array.isArray(action.requests)&&(gatewayScoped||action.requests.length===0)&&
    Number.isInteger(action.windowSeconds)&&action.windowSeconds>=30&&action.windowSeconds<=300&&
    exact(binding,['challenge','bindingSha256','browserProgramSha256'])&&sha256(binding.challenge)&&
    binding.bindingSha256===plan.planSha256&&sha256(binding.browserProgramSha256));
  if(authoring)return reviewedAuthoringAction(action);
  if(media){
    demand(canonicalUuid(action.actorId)&&validP2MediaReservationRequests(action.mediaAction,action.requests));
    const selection={actorId:action.actorId,...action.mediaAction};
    return {selection:{...selection,actorKind:'admin'},media:selection};
  }
  if(learning)return reviewedLearningAction(action);
  if(paidGrant)return reviewedPaidGrantAction(action);
  if(learnerAccess)return reviewedLearnerAccessAction(action);
  if(lessonEntry)return reviewedLessonEntryAction(action);
  if(lessonDenial)return reviewedLessonDenialAction(action);
  if(assessment)return reviewedAssessmentAction(action);
  if(resume)return reviewedResumeAction(action);
  if(restore)return reviewedRestoreAction(action,plan);
  if(ackLoss)return reviewedAckLossAction(action);
  if(exitSave)return reviewedExitSaveAction(action);
  if(visibility)return reviewedVisibilityAction(action);
  if(staleRevision)return reviewedStaleRevisionAction(action);
  if(stalledRenewal){
    demand(canonicalUuid(action.actorId)&&validateP2InteractiveStalledRenewalAction(action.stalledRenewalAction,action.requests));
    const target={actorId:action.actorId,...action.stalledRenewalAction};
    return {selection:{...target,actorKind:'customer',operation:p2StalledRenewalStage},stalledRenewal:target};
  }
  if(paidRevoke)return reviewedPaidRevokeAction(action);
  if(firstOwner){
    demand(action.actorId===null&&validP2FirstOwnerSelection(action.firstOwner));
    return {selection:{actorKind:'admin'},firstOwner:{...action.firstOwner}};
  }
  if(enrollment){
    const selected=action.identityEnrollment;
    demand(action.actorId===null&&exact(selected,['provider','emailSha256','nonce'])&&
      ['google','resend'].includes(selected.provider)&&nonzeroSha256(selected.emailSha256)&&
      typeof selected.nonce==='string'&&/^[a-f0-9]{32}$/u.test(selected.nonce)&&!/^0+$/u.test(selected.nonce));
    return {selection:{actorKind:'customer'},enrollment:{...selected}};
  }
  if(identity){
    const actor=action.identityActor;
    demand(action.actorId===null&&(exact(actor,['actorKind','actorId'])||
      exact(actor,['actorKind','actorId','sessionCount'])&&actor.actorKind==='customer'&&actor.sessionCount===2)&&
      ['admin','customer'].includes(actor.actorKind)&&
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

function identityJoinedEvidence(evidence,selected,context,enrollment,firstOwner){
  demand(exact(evidence,['browserIdentity','identityWitness']));
  const {browserIdentity:identity,identityWitness:witness}=evidence;
  const owner=context==='owner';
  const {sessionCount,...actorSelection}=selected;
  const paired=sessionCount===2;
  const actor={...actorSelection,actorId:enrollment||firstOwner?identity?.actorId:actorSelection.actorId};
  const witnessFields=enrollment?['liveSessionCount','provider','providerLinkCount']:
    firstOwner?['ownerMappingVerified','firstOwnerVerified']:
    paired?['sessionCount','liveSessionCount','verifiedFreshSessionCount']:[owner?'ownerMappingVerified':'liveSessionCount'];
  demand(exact(identity,['actorKind','actorId','sessionVerified',...(paired?['sessionProofs']:[])])&&identity.sessionVerified===true&&
    exact(witness,['actorKind','actorId','actorActive',...witnessFields])&&witness.actorActive===true&&
    canonicalUuid(actor.actorId)&&Object.entries(actor).every(([key,value])=>identity[key]===value&&witness[key]===value));
  if(firstOwner){
    demand(owner&&witness.ownerMappingVerified===true&&witness.firstOwnerVerified===true);
  }else if(enrollment){
    demand(witness.liveSessionCount===1&&witness.provider===enrollment.provider&&witness.providerLinkCount===(enrollment.provider==='google'?1:0));
  }else if(paired){
    const {sessionProofs}=identity;
    demand(!owner&&Array.isArray(sessionProofs)&&sessionProofs.length===2&&sessionProofs.every(nonzeroSha256)&&
      sessionProofs[0]!==sessionProofs[1]&&witness.sessionCount===2&&witness.verifiedFreshSessionCount===2&&
      Number.isSafeInteger(witness.liveSessionCount)&&witness.liveSessionCount>=2);
  }else{
    demand(owner?witness.ownerMappingVerified===true:Number.isSafeInteger(witness.liveSessionCount)&&witness.liveSessionCount>0);
  }
  return {...actor,...(paired?{sessionCount}:{}),context,browserIdentitySha256:p2NativeHash(identity),identityWitnessSha256:p2NativeHash(witness)};
}

function requireInteractiveGatewayObservation(receipt,epoch,{operation,outcome,quizRevision}){
  const {gatewayEvidenceSha256,...observed}=receipt;
  const acks=receipt.gatewayAcknowledgements;
  const createCurriculum=operation===authoringCreateCurriculumOperation;
  const archive=operation===authoringArchiveOperation;
  const publication=authoringPublicationCase(operation),paired=authoringPairedOperation(operation),republish=operation===authoringRepublishOperation;
  const quiz=operation===authoringQuizOperation,learning=operation===learningEnrollmentOperation;
  const statuses=quiz?[200,quizRevision===0?404:200,200]:publication?[200,200,200,200]:paired?[200,200,409]:archive?[200,200]:[200,201];
  const indices=republish?(outcome==='published'?[0,1,0,2,3,0]:[0,1,0,2]):
    quiz||publication&&outcome==='published'?[0,1,2,0]:paired?[0,0,1,0,2]:createCurriculum||archive?[0,1,0]:[0,1];
  const sequences=mediaOperations.has(operation)?[[[0,200],[1,200],[2,201]]]:learning?[
    [[0,200],[1,403],[2,201],[1,200],[3,200]],
    [[0,200],[1,403],[2,201],[3,200],[1,200]],
  ]:operation===learningReplayOperation?[
    [[0,200],[1,200],[2,200]],[[1,200],[0,200],[2,200]],
  ]:operation===paidGrantOperation?[
    [[0,200],[1,200],[0,200],[2,201],[1,200],[3,200],[0,200]],
  ]:operation===paidRevokeOperation?[
    [0,1,0,2,3,1,2,0].map(index=>[index,200]),
  ]:operation===learnerAccessOperation?[
    [0,1,0,2,3,4,5,6],[1,0,0,2,3,4,5,6],
  ].map(order=>order.map(index=>[index,learnerAccessOutcomes[outcome].status])):
    [indices.map(index=>[index,statuses[index]])];
  const lessonEntry=operation===lessonEntryOperation,lessonDenial=operation===lessonDenialOperation,assessment=operation===assessmentOperation;
  const resume=operation===resumeOperation,restore=operation===restoreOperation,ackLoss=operation===ackLossOperation;
  const exitSave=exitSaveOperations.has(operation);
  const visibility=operation===visibilityOperation;
  const staleRevision=operation===staleRevisionOperation,stalledRenewal=operation===p2StalledRenewalStage;
  const phaseMatches=(start,end,expected)=>isDeepStrictEqual(
    acks.slice(start,end).map(row=>row.requestIndex).sort((left,right)=>left-right),expected);
  demand(receipt.epoch===epoch&&nonzeroSha256(receipt.gatewayStateSha256)&&receipt.gatewayActive===0&&receipt.gatewayUncertain===0&&
    Array.isArray(acks)&&acks.length===(lessonEntry||visibility?9:lessonDenial?15:assessment||exitSave?11:resume?10:restore?8:ackLoss?18:staleRevision?27:stalledRenewal?6:sequences[0].length)&&acks.every(row=>exact(row,['requestId','proofRequestId','requestIndex','upstreamStatus'])&&
      canonicalUuid(row.requestId)&&canonicalUuid(row.proofRequestId))&&
    (stalledRenewal?acks.every(row=>row.upstreamStatus===200)&&phaseMatches(0,5,[0,1,2,3,4])&&acks[5].requestIndex===5:
      lessonEntry?acks.every(row=>row.upstreamStatus===200)&&
      phaseMatches(0,2,[0,1])&&phaseMatches(2,7,[0,2,3,4,5])&&phaseMatches(7,9,[6,7]):
      lessonDenial?acks.every(row=>row.upstreamStatus===403)&&phaseMatches(0,5,[0,1,2,3,4])&&
        phaseMatches(5,10,[0,1,2,3,4])&&isDeepStrictEqual(acks.slice(10).map(row=>row.requestIndex),[1,5,2,3,4]):
      assessment?acks.every(row=>row.upstreamStatus===(row.requestIndex===5?404:200))&&phaseMatches(0,5,[0,1,2,3,4])&&
        phaseMatches(5,7,[5,6])&&isDeepStrictEqual(acks.slice(7).map(row=>row.requestIndex),[7,2,8,2]):
      resume||restore?acks.every(row=>row.upstreamStatus===200)&&phaseMatches(0,5,[0,1,2,3,4])&&
        phaseMatches(5,7,[5,6])&&isDeepStrictEqual(acks.slice(7).map(row=>row.requestIndex),resume?[7,8,9]:[7]):
      ackLoss?acks.every(row=>row.upstreamStatus===200)&&phaseMatches(0,5,[0,1,2,3,4])&&phaseMatches(5,7,[5,6])&&
        acks[7].requestIndex===7&&acks[8].requestIndex===8&&acks[9].requestIndex===2&&
        phaseMatches(10,15,[0,1,2,3,4])&&phaseMatches(15,17,[5,9])&&acks[17].requestIndex===10:
      exitSave?acks.every(row=>row.upstreamStatus===200)&&phaseMatches(0,5,[0,1,2,3,4])&&phaseMatches(5,7,[5,6])&&
        acks[7].requestIndex===7&&phaseMatches(8,11,[0,8,9]):
      visibility?acks.every(row=>row.upstreamStatus===200)&&phaseMatches(0,5,[0,1,2,3,4])&&phaseMatches(5,7,[5,6])&&
        acks[7].requestIndex===7&&acks[8].requestIndex===8:
      staleRevision?acks.every(row=>row.upstreamStatus===(row.requestIndex===11?409:200))&&
        phaseMatches(0,5,[0,1,2,3,4])&&phaseMatches(5,7,[5,6])&&acks[7].requestIndex===7&&
        phaseMatches(8,13,[0,1,2,3,4])&&phaseMatches(13,15,[5,8])&&acks[15].requestIndex===9&&
        isDeepStrictEqual(acks.slice(16,19).map(row=>row.requestIndex),[10,11,2])&&
        phaseMatches(19,24,[0,1,2,3,4])&&phaseMatches(24,26,[5,12])&&acks[26].requestIndex===13:
      sequences.some(sequence=>acks.every((row,index)=>row.requestIndex===sequence[index][0]&&row.upstreamStatus===sequence[index][1])))&&
    new Set(acks.map(row=>row.requestId)).size===acks.length&&new Set(acks.map(row=>row.proofRequestId)).size===acks.length&&
    gatewayEvidenceSha256===p2NativeHash(observed));
}

function requireCommunityActivation(delivery,transitionId){
  demand(exact(delivery,['streamId','streamVersion','eventId','canonicalDigest','state'])&&
    canonicalUuid(delivery.streamId)&&canonicalUuid(delivery.eventId)&&delivery.streamVersion===1&&
    nonzeroSha256(delivery.canonicalDigest)&&delivery.state==='active'&&(transitionId===null||delivery.eventId===transitionId));
}

function learningJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,courseId,slug,operation,prior}=selected,{grantId,enrollmentId}=response?.body??{};
  const replay=operation===learningReplayOperation;
  const {transitionId,communityDelivery}=witness??{},gatewayPostRequestId=observed.gatewayAcknowledgements[2].requestId;
  const academyPath='/academy/courses/'+courseId;
  const body={courseId,grantId,enrollmentId,source:'free',status:'active',idempotentReplay:replay};
  demand([grantId,enrollmentId,transitionId].every(canonicalUuid)&&
    isDeepStrictEqual(response,{method:'POST',pathname:'/api'+academyPath+'/enrollments',status:200,requestId:gatewayPostRequestId,academyPath,body})&&
    isDeepStrictEqual(witness,{...body,transitionId,communityDelivery,readOnly:true}));
  requireCommunityActivation(communityDelivery,transitionId);
  if(replay)demand(grantId===prior.grantId&&enrollmentId===prior.enrollmentId&&transitionId===prior.eventId&&
    communityDelivery.streamId===prior.streamId&&communityDelivery.canonicalDigest===prior.canonicalDigest);
  return {actorId,...(replay?{operation}:{}),courseId,slug,grantId,enrollmentId,transitionId,communityDelivery,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPostRequestId};
}

function paidGrantJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,courseId,userId,revision:courseRevision,priorGrantId}=selected,{commandId,grantId}=response?.body??{};
  const {enrollmentId,transitionId,communityDelivery}=witness??{},gatewayPostRequestId=observed.gatewayAcknowledgements[3].requestId;
  const second=priorGrantId!==undefined,prior=second?{priorGrantId}:{};
  const body={courseId,userId,commandId,grantId,courseRevision};
  demand([commandId,grantId,enrollmentId].every(canonicalUuid)&&
    (second?transitionId===null&&grantId!==priorGrantId:canonicalUuid(transitionId))&&
    isDeepStrictEqual(response,{method:'POST',pathname:'/api/admin/courses/'+courseId+'/manual-grants',status:200,requestId:gatewayPostRequestId,body})&&
    isDeepStrictEqual(witness,{...body,enrollmentId,transitionId,...prior,communityDelivery,readOnly:true}));
  requireCommunityActivation(communityDelivery,transitionId);
  return {actorId,...body,enrollmentId,transitionId,...prior,communityDelivery,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPostRequestId};
}

function learnerAccessJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,revision,outcome}=selected;
  const effectiveAccess=outcome==='allowed',{status,codes}=learnerAccessOutcomes[outcome];
  const body={courseId,lessonId,outcome},coursePath='/academy/courses/'+courseId,lessonPath='/api/academy/lessons/'+lessonId;
  const targets=['/api'+coursePath,lessonPath,lessonPath+'/playback','/api/academy/progress?lessonId='+lessonId,lessonPath+'/quiz',lessonPath+'/quiz/attempts'];
  demand(exact(response,['page','reads','body'])&&isDeepStrictEqual(response.page,{pathname:coursePath,status:200,lessonLink:effectiveAccess})&&
    Array.isArray(response.reads)&&response.reads.length===targets.length&&Array.from(response.reads).every((row,index)=>
      exact(row,['target','status','requestId','code'])&&row.target===targets[index]&&row.status===status&&codes.includes(row.code)&&
      row.requestId===observed.gatewayAcknowledgements[index+2].requestId)&&
    isDeepStrictEqual(response.body,body)&&isDeepStrictEqual(witness,{...body,actorId,grantId,revision,effectiveAccess,readOnly:true}));
  return {actorId,operation,courseId,lessonId,grantId,revision,outcome,effectiveAccess,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function stalledRenewalJoinedEvidence(evidence,target,observed,baseline,fence){
  demand(exact(evidence,['stalledRenewalBrowser']));
  const browser=validateP2StalledPlaybackRenewalReceipt(evidence.stalledRenewalBrowser,target);
  validateP2StalledPlaybackRenewalBaseline(baseline,target);
  const playbackGatewayRequestId=observed.gatewayAcknowledgements.find(row=>row.requestIndex===5)?.requestId;
  const fenceTime=Date.parse(fence.observedAt), marks=browser.observation;
  demand(isDeepStrictEqual(baseline,{page:browser.page,playback:browser.playback})&&
    canonicalUuid(playbackGatewayRequestId)&&browser.playback.requestId===playbackGatewayRequestId&&utc(fence.observedAt)&&
    Date.parse(marks.baseline.observedAt)-2_000<=fenceTime&&fenceTime<=Date.parse(marks.fenceConfirmed.observedAt)+2_000&&
    fenceTime<Date.parse(marks.renewalStarted.observedAt));
  return {...target,playbackGatewayRequestId,browserResponseSha256:p2NativeHash(browser),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function lessonEntryJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId}=selected;
  const acks=observed.gatewayAcknowledgements;
  const playbackGatewayRequestId=acks.find(row=>row.requestIndex===6).requestId;
  const progressGatewayRequestId=acks.find(row=>row.requestIndex===7).requestId;
  demand(exact(response,['page','playback','progress'])&&isDeepStrictEqual(response.page,{
    pathname:'/academy/courses/'+courseId+'/lessons/'+lessonId,flight:true,
  }));
  const {playback,progress}=response;
  const lessonExpiry=value=>utc(value)&&value.length===24&&value.slice(0,4)!=='0000';
  demand(exact(playback,['requestId','expiresAt','thumbnailExpiresAt','lifetimeMs'])&&
    playback.requestId===playbackGatewayRequestId&&lessonExpiry(playback.expiresAt)&&lessonExpiry(playback.thumbnailExpiresAt)&&
    Number.isInteger(playback.lifetimeMs)&&playback.lifetimeMs>=590_000&&
    playback.lifetimeMs+Math.abs(Date.parse(playback.expiresAt)-Date.parse(playback.thumbnailExpiresAt))<=601_000);
  demand(exact(progress,['requestId','progressId','enrollmentId','revision'])&&progress.requestId===progressGatewayRequestId&&
    canonicalUuid(progress.progressId)&&canonicalUuid(progress.enrollmentId)&&progress.revision===1);
  const playbackExpiresAt=playback.expiresAt>playback.thumbnailExpiresAt?playback.expiresAt:playback.thumbnailExpiresAt;
  const {enrollmentId,progressId,revision}=progress;
  const body={courseId,lessonId,grantId,actorId,enrollmentId,progressId,revision,playbackExpiresAt};
  demand(isDeepStrictEqual(witness,{...body,readOnly:true}));
  return {...body,operation,playbackGatewayRequestId,progressGatewayRequestId,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function lessonDenialJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,enrolledActorId,grantId}=selected;
  const lesson='/api/academy/lessons/'+lessonId;
  const targets=[lesson,lesson+'/playback','/api/academy/progress?lessonId='+lessonId,lesson+'/quiz',lesson+'/quiz/attempts'];
  const acks=observed.gatewayAcknowledgements;
  const documentRequestId=acks.slice(0,5).find(row=>row.requestIndex===0).requestId;
  const flightRequestId=acks.slice(5,10).find(row=>row.requestIndex===0).requestId;
  const joined={actorId,courseId,lessonId,enrolledActorId,grantId,effectiveAccess:false};
  demand(exact(response,['page','reads'])&&isDeepStrictEqual(response.page,{
    pathname:'/academy/courses/'+courseId+'/lessons/'+lessonId,documentStatus:200,flightStatus:200,documentRequestId,flightRequestId,
  })&&Array.isArray(response.reads)&&response.reads.length===targets.length&&targets.every((target,index)=>
    isDeepStrictEqual(response.reads[index],{
      target,status:403,requestId:acks[index+10].requestId,code:'access_required',
    }))&&isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function assessmentJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,quizRevision,failAnswers}=selected;
  const acks=observed.gatewayAcknowledgements;
  const playbackRequestId=acks.slice(5,7).find(row=>row.requestIndex===5).requestId;
  const startedRequestId=acks.slice(5,7).find(row=>row.requestIndex===6).requestId;
  demand(exact(response,['page','playback','started','attempts'])&&
    isDeepStrictEqual(response.page,{pathname:'/academy/courses/'+courseId+'/lessons/'+lessonId,status:200})&&
    isDeepStrictEqual(response.playback,{requestId:playbackRequestId,status:404}));
  const {started,attempts}=response;
  demand(exact(started,['requestId','progressId','enrollmentId','revision'])&&started.requestId===startedRequestId&&
    canonicalUuid(started.progressId)&&canonicalUuid(started.enrollmentId)&&started.revision===1&&
    Array.isArray(attempts)&&attempts.length===2&&attempts.every((row,index)=>{
      const passed=index===1;
      return exact(row,['requestId','payloadRequestId','attemptId','quizRevisionId','quizRevision','correctCount','totalCount','passed','completed','createdAt','progress'])&&
        row.requestId===acks[7+index*2].requestId&&uuid4(row.payloadRequestId)&&canonicalUuid(row.attemptId)&&canonicalUuid(row.quizRevisionId)&&
        row.quizRevision===quizRevision&&row.totalCount===failAnswers.length&&nonnegative(row.correctCount)&&row.correctCount<=row.totalCount&&
        row.passed===passed&&row.completed===passed&&utc(row.createdAt)&&isDeepStrictEqual(row.progress,{
          requestId:acks[8+index*2].requestId,progressId:started.progressId,enrollmentId:started.enrollmentId,revision:2+index,
          completedAt:passed?row.createdAt:null,completedQuizRevision:passed?quizRevision:null,
        });
    }));
  const [failed,passed]=attempts;
  demand(failed.quizRevisionId===passed.quizRevisionId&&failed.createdAt<=passed.createdAt&&failed.correctCount<passed.correctCount&&
    new Set([...acks.map(row=>row.requestId),...attempts.flatMap(row=>[row.payloadRequestId,row.attemptId])]).size===acks.length+4);
  const joined={actorId,courseId,lessonId,grantId,quizRevision,enrollmentId:started.enrollmentId,progressId:started.progressId,
    attemptIds:attempts.map(row=>row.attemptId),progressRevision:3};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function resumeJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId}=selected;
  const acks=observed.gatewayAcknowledgements;
  const playbackGatewayRequestId=acks.find(row=>row.requestIndex===5).requestId;
  const startedGatewayRequestId=acks.find(row=>row.requestIndex===6).requestId;
  demand(exact(response,['page','playback','started','writes','media'])&&isDeepStrictEqual(response.page,{
    pathname:'/academy/courses/'+courseId+'/lessons/'+lessonId,status:200,
  }));
  const {playback,started,writes,media}=response;
  const lessonExpiry=value=>utc(value)&&value.length===24&&value.slice(0,4)!=='0000';
  demand(exact(playback,['requestId','expiresAt','thumbnailExpiresAt','lifetimeMs','playbackIdSha256'])&&
    playback.requestId===playbackGatewayRequestId&&nonzeroSha256(playback.playbackIdSha256)&&
    lessonExpiry(playback.expiresAt)&&lessonExpiry(playback.thumbnailExpiresAt)&&
    Number.isInteger(playback.lifetimeMs)&&playback.lifetimeMs>=590_000&&
    playback.lifetimeMs+Math.abs(Date.parse(playback.expiresAt)-Date.parse(playback.thumbnailExpiresAt))<=601_000);
  demand(exact(started,['requestId','progressId','enrollmentId','revision'])&&started.requestId===startedGatewayRequestId&&
    canonicalUuid(started.progressId)&&canonicalUuid(started.enrollmentId)&&started.revision===1);
  demand(Array.isArray(writes)&&writes.length===3&&writes.every((write,index)=>
    exact(write,['requestId','expectedProgressRevision','revision','resumePositionSeconds','submittedMaxPositionSeconds','maxPositionSeconds'])&&
    write.requestId===acks[7+index].requestId&&write.expectedProgressRevision===index+1&&write.revision===index+2&&
    [write.resumePositionSeconds,write.submittedMaxPositionSeconds,write.maxPositionSeconds].every(nonnegative)&&
    write.maxPositionSeconds===Math.max(write.resumePositionSeconds,write.submittedMaxPositionSeconds)));
  const [heartbeat,paused,rewound]=writes;
  demand(heartbeat.resumePositionSeconds>=10&&heartbeat.resumePositionSeconds<=12&&
    heartbeat.submittedMaxPositionSeconds===heartbeat.resumePositionSeconds&&
    paused.resumePositionSeconds>=13&&paused.resumePositionSeconds<=16&&
    paused.submittedMaxPositionSeconds>=Math.max(heartbeat.maxPositionSeconds,paused.resumePositionSeconds-1)&&
    paused.submittedMaxPositionSeconds<=paused.resumePositionSeconds&&
    rewound.resumePositionSeconds===paused.resumePositionSeconds-10&&
    rewound.submittedMaxPositionSeconds===paused.maxPositionSeconds&&rewound.maxPositionSeconds===paused.maxPositionSeconds);
  demand(exact(media,['durationSeconds','videoWidth','heartbeatSeconds','pausedSeconds','rewoundSeconds','manifestObserved','segmentObserved'])&&
    Number.isSafeInteger(media.durationSeconds)&&media.durationSeconds>=22&&Number.isSafeInteger(media.videoWidth)&&media.videoWidth>0&&
    Number.isSafeInteger(media.heartbeatSeconds)&&media.heartbeatSeconds>=heartbeat.resumePositionSeconds&&
    media.heartbeatSeconds<=heartbeat.resumePositionSeconds+1&&media.pausedSeconds===paused.resumePositionSeconds&&
    media.rewoundSeconds===rewound.resumePositionSeconds&&media.manifestObserved===true&&media.segmentObserved===true);
  const playbackExpiresAt=playback.expiresAt>playback.thumbnailExpiresAt?playback.expiresAt:playback.thumbnailExpiresAt;
  const {enrollmentId,progressId}=started,{revision,resumePositionSeconds,maxPositionSeconds}=rewound;
  const joined={actorId,courseId,lessonId,grantId,enrollmentId,progressId,revision,resumePositionSeconds,maxPositionSeconds,
    playbackExpiresAt,playbackIdSha256:playback.playbackIdSha256};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestId,startedGatewayRequestId,positionGatewayRequestIds:writes.map(write=>write.requestId),
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function restoreJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,prior}=selected;
  const {progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256}=prior;
  const acks=observed.gatewayAcknowledgements;
  const playbackGatewayRequestId=acks.find(row=>row.requestIndex===5).requestId;
  const startedGatewayRequestId=acks.find(row=>row.requestIndex===6).requestId;
  const restoredGatewayRequestId=acks[7].requestId;
  demand(exact(response,['page','playback','started','restored','media'])&&isDeepStrictEqual(response.page,{
    pathname:'/academy/courses/'+courseId+'/lessons/'+lessonId,status:200,
  }));
  const {playback,started,restored,media}=response;
  const lessonExpiry=value=>utc(value)&&value.length===24&&value.slice(0,4)!=='0000';
  demand(exact(playback,['requestId','expiresAt','thumbnailExpiresAt','lifetimeMs','playbackIdSha256'])&&
    playback.requestId===playbackGatewayRequestId&&playback.playbackIdSha256===playbackIdSha256&&
    lessonExpiry(playback.expiresAt)&&lessonExpiry(playback.thumbnailExpiresAt)&&
    Number.isInteger(playback.lifetimeMs)&&playback.lifetimeMs>=590_000&&
    playback.lifetimeMs+Math.abs(Date.parse(playback.expiresAt)-Date.parse(playback.thumbnailExpiresAt))<=601_000);
  demand(isDeepStrictEqual(started,{requestId:startedGatewayRequestId,progressId,enrollmentId,revision:5})&&
    isDeepStrictEqual(restored,{requestId:restoredGatewayRequestId,progressId,enrollmentId,revision:6,resumePositionSeconds,maxPositionSeconds}));
  demand(exact(media,['durationSeconds','videoWidth','restoredSeconds','paused','manifestObserved','segmentObserved'])&&
    Number.isSafeInteger(media.durationSeconds)&&media.durationSeconds>=22&&Number.isSafeInteger(media.videoWidth)&&media.videoWidth>0&&
    media.restoredSeconds===resumePositionSeconds&&media.paused===true&&media.manifestObserved===true&&media.segmentObserved===true);
  const playbackExpiresAt=playback.expiresAt>playback.thumbnailExpiresAt?playback.expiresAt:playback.thumbnailExpiresAt;
  demand(playbackExpiresAt>prior.playbackExpiresAt);
  const joined={actorId,courseId,lessonId,grantId,enrollmentId,progressId,revision:6,resumePositionSeconds,maxPositionSeconds,
    playbackExpiresAt,playbackIdSha256};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestId,startedGatewayRequestId,restoredGatewayRequestId,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function ackLossJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256}=selected;
  const target={actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256};
  validateP2LessonAckLossReceipt(response,target);
  const acks=observed.gatewayAcknowledgements;
  const requestIn=(start,end,index)=>acks.slice(start,end).find(row=>row.requestIndex===index).requestId;
  const playbackGatewayRequestIds=[requestIn(5,7,5),requestIn(15,17,5)];
  const progressGatewayRequestIds=[requestIn(5,7,6),acks[7].requestId,acks[8].requestId,requestIn(15,17,9),acks[17].requestId];
  const recoveryGatewayRequestId=acks[9].requestId;
  demand(isDeepStrictEqual(response.playback.map(row=>row.requestId),playbackGatewayRequestIds)&&
    isDeepStrictEqual(response.writes.map(row=>row.requestId),progressGatewayRequestIds)&&
    response.recovery.requestId===recoveryGatewayRequestId);
  const playbackExpiresAt=response.playback.flatMap(row=>[row.expiresAt,row.thumbnailExpiresAt]).sort().at(-1);
  const joined={actorId,courseId,lessonId,grantId,progressId,enrollmentId,revision:11,resumePositionSeconds:maxPositionSeconds,
    maxPositionSeconds,playbackIdSha256,playbackExpiresAt};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestIds,progressGatewayRequestIds,recoveryGatewayRequestId,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function exitSaveJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256}=selected;
  validateP2LessonExitSaveReceipt(response,{actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,
    resumePositionSeconds,maxPositionSeconds,playbackIdSha256});
  const acks=observed.gatewayAcknowledgements;
  const requestIn=(start,end,index)=>acks.slice(start,end).find(row=>row.requestIndex===index).requestId;
  const playbackGatewayRequestId=requestIn(5,7,5);
  const progressGatewayRequestIds=[requestIn(5,7,6),acks[7].requestId,requestIn(8,11,8)];
  const destinationCourseGatewayRequestId=requestIn(8,11,0),destinationProgressGatewayRequestId=requestIn(8,11,9);
  demand(response.playback.requestId===playbackGatewayRequestId&&
    isDeepStrictEqual(response.writes.map(row=>row.requestId),progressGatewayRequestIds.slice(0,2)));
  const {expiresAt,thumbnailExpiresAt}=response.playback;
  const playbackExpiresAt=expiresAt>thumbnailExpiresAt?expiresAt:thumbnailExpiresAt;
  const joined={actorId,courseId,lessonId,grantId,progressId,enrollmentId,revision:9,resumePositionSeconds:response.exit.resumePositionSeconds,
    maxPositionSeconds,playbackIdSha256,playbackExpiresAt};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestId,progressGatewayRequestIds,destinationCourseGatewayRequestId,destinationProgressGatewayRequestId,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function visibilityJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256}=selected;
  validateP2LessonVisibilityReceipt(response,{actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,
    resumePositionSeconds,maxPositionSeconds,playbackIdSha256});
  const acks=observed.gatewayAcknowledgements;
  const playbackGatewayRequestId=acks.slice(5,7).find(row=>row.requestIndex===5).requestId;
  const progressGatewayRequestIds=[acks.slice(5,7).find(row=>row.requestIndex===6).requestId,acks[7].requestId,acks[8].requestId];
  demand(response.playback.requestId===playbackGatewayRequestId&&
    isDeepStrictEqual(response.writes.map(row=>row.requestId),progressGatewayRequestIds));
  const {expiresAt,thumbnailExpiresAt}=response.playback;
  const playbackExpiresAt=expiresAt>thumbnailExpiresAt?expiresAt:thumbnailExpiresAt;
  const joined={actorId,courseId,lessonId,grantId,progressId,enrollmentId,revision:9,resumePositionSeconds:response.visibility.resumePositionSeconds,
    maxPositionSeconds,playbackIdSha256,playbackExpiresAt};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestId,progressGatewayRequestIds,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function staleRevisionJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,resumePositionSeconds,maxPositionSeconds,playbackIdSha256}=selected;
  validateP2LessonStaleRevisionReceipt(response,{actorId,operation,courseId,lessonId,grantId,progressId,enrollmentId,
    resumePositionSeconds,maxPositionSeconds,playbackIdSha256});
  const acks=observed.gatewayAcknowledgements;
  const playbackGatewayRequestIds=acks.filter(row=>row.requestIndex===5).map(row=>row.requestId);
  const progressGatewayRequestIds=acks.filter(row=>[6,7,8,9,10,12,13].includes(row.requestIndex)).map(row=>row.requestId);
  const conflictGatewayRequestId=acks[17].requestId,authoritativeGatewayRequestId=acks[18].requestId;
  demand(isDeepStrictEqual(response.playback.map(row=>row.requestId),playbackGatewayRequestIds)&&
    isDeepStrictEqual(response.writes.map(row=>row.requestId),progressGatewayRequestIds)&&
    response.conflict.requestId===conflictGatewayRequestId&&response.authoritative.requestId===authoritativeGatewayRequestId);
  const playbackExpiresAt=response.playback.flatMap(row=>[row.expiresAt,row.thumbnailExpiresAt]).sort().at(-1);
  const joined={actorId,courseId,lessonId,grantId,progressId,enrollmentId,revision:13,resumePositionSeconds:maxPositionSeconds,
    maxPositionSeconds,playbackIdSha256,playbackExpiresAt};
  demand(isDeepStrictEqual(witness,{...joined,readOnly:true}));
  return {...joined,operation,playbackGatewayRequestIds,progressGatewayRequestIds,conflictGatewayRequestId,authoritativeGatewayRequestId,
    browserResponseSha256:p2NativeHash(response),courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
}

function paidRevokeJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,userId,grantId,revision:courseRevision,remainingAccess}=selected;
  const commandId=response?.body?.commandId,transitionId=witness?.transitionId,communityDelivery=witness?.communityDelivery;
  const gatewayPostRequestId=observed.gatewayAcknowledgements[4].requestId,body={courseId,userId,grantId,commandId,courseRevision};
  demand(canonicalUuid(commandId)&&(remainingAccess?transitionId===null:canonicalUuid(transitionId))&&
    isDeepStrictEqual(response,{method:'POST',pathname:'/api/admin/courses/'+courseId+'/manual-grants/revoke',status:200,requestId:gatewayPostRequestId,body})&&
    isDeepStrictEqual(witness,{...body,remainingAccess,transitionId,communityDelivery,readOnly:true}));
  demand(exact(communityDelivery,['streamId','streamVersion','eventId','canonicalDigest','state','independentActiveCount','independentActiveSha256'])&&
    canonicalUuid(communityDelivery.streamId)&&canonicalUuid(communityDelivery.eventId)&&
    Number.isInteger(communityDelivery.streamVersion)&&communityDelivery.streamVersion>=1&&communityDelivery.streamVersion<=2_147_483_647&&
    nonzeroSha256(communityDelivery.canonicalDigest)&&nonzeroSha256(communityDelivery.independentActiveSha256)&&
    Number.isInteger(communityDelivery.independentActiveCount)&&communityDelivery.independentActiveCount>=1&&communityDelivery.independentActiveCount<=4096&&
    communityDelivery.state===(remainingAccess?'active':'revoked')&&(remainingAccess||communityDelivery.eventId===transitionId));
  return {actorId,operation,...body,remainingAccess,transitionId,communityDelivery,gatewayPostRequestId,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256};
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
  const {actorId,operation,courseId,slug,outcome,issueCodes,userId,grantId,expectedAccess}=selected;
  const published=outcome==='published',republish=operation===authoringRepublishOperation;
  const revision=selected.revision+Number(published)+Number(republish),pathname='/api/admin/courses/'+courseId;
  const {gatewayAcknowledgements:acks,gatewayEvidenceSha256}=observed;
  const readinessIndex=republish?3:1;
  const readinessGatewayRequestId=acks[readinessIndex].requestId,gatewayPatchRequestId=published?acks[readinessIndex+1].requestId:undefined;
  const draftGatewayRequestId=republish?acks[1].requestId:undefined,effectiveAccess=published&&expectedAccess;
  const body={courseId,slug,revision,status:published?'published':'draft',issueCodes};
  const history=republish?{userId,grantId,historyPreserved:true,effectiveAccess}:{};
  demand(exact(response,['readiness','body',...(republish?['draft']:[]),...(published?['publication']:[])])&&
    (!republish||isDeepStrictEqual(response.draft,{method:'PATCH',pathname,status:200,requestId:draftGatewayRequestId}))&&
    isDeepStrictEqual(response.readiness,{method:'GET',pathname:pathname+'/publication-readiness',status:200,requestId:readinessGatewayRequestId})&&
    (!published||isDeepStrictEqual(response.publication,{method:'PATCH',pathname,status:200,requestId:gatewayPatchRequestId}))&&
    isDeepStrictEqual(response.body,body)&&isDeepStrictEqual(witness,{...body,...history,readOnly:true}));
  return {actorId,operation,courseId,slug,outcome,revision,issueCodes,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256,readinessGatewayRequestId,
    ...(republish?{userId,grantId,effectiveAccess,draftGatewayRequestId}:{}),...(published?{gatewayPatchRequestId}:{})};
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

function authoringArchiveJoinedEvidence(evidence,selected,observed){
  demand(exact(evidence,['browserResponse','courseWitness']));
  const {browserResponse:response,courseWitness:witness}=evidence;
  const {actorId,operation,courseId,slug,userId,grantId}=selected;
  const revision=selected.revision+1,gatewayPatchRequestId=observed.gatewayAcknowledgements[1].requestId;
  const body={courseId,slug,revision,status:'archived'};
  demand(isDeepStrictEqual(response,{method:'PATCH',pathname:'/api/admin/courses/'+courseId,status:200,requestId:gatewayPatchRequestId,
    body,warningObserved:true,cancelObservedWithoutMutation:true})&&
    isDeepStrictEqual(witness,{...body,userId,grantId,historyPreserved:true,readOnly:true}));
  return {actorId,operation,courseId,slug,revision,userId,grantId,browserResponseSha256:p2NativeHash(response),
    courseWitnessSha256:p2NativeHash(witness),gatewayEvidenceSha256:observed.gatewayEvidenceSha256,gatewayPatchRequestId};
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
  const certificationMode=initial.certificationPlan?.mode;
  const authorityMode=usesP2ProfiledDayTwoAuthority(certificationMode);
  const authorityBearer=profiled&&authorityMode?initial.scopedCronSecret:undefined;
  if(profiled&&authorityMode){
    demand(typeof authorityBearer==='string'&&authorityBearer.length>0&&authorityBearer.length<=8192&&
      authorityBearer.trim()===authorityBearer&&/^[!-~]+$/u.test(authorityBearer)&&!Object.hasOwn(initial,'privateProbe'));
  }else if(Object.hasOwn(initial,'scopedCronSecret')){
    demand(profiled&&(certificationMode==='interactive-browser'||Object.hasOwn(scopedOperations,certificationMode)));
  }
  const interactivePlan=profiled&&initial.certificationPlan.mode==='interactive-browser'?initial.certificationPlan:null;
  const selectedInteractive=interactivePlan?reviewedInteractivePlan(interactivePlan,initial):null;
  if(!interactivePlan)demand(!Object.hasOwn(initial,'interactiveController')&&initial.certificationPlan?.mode!=='interactive-browser');
  const command=['sudo','-n','/usr/bin/python3','-I','-u',`/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_certification_parent.py`,
    profiled?'--supervisor-profiled-current':'--supervisor'];
  return async task=>{
    if(authorityBearer!==undefined)demand(initial.certificationPlan.mode===certificationMode&&initial.scopedCronSecret===authorityBearer&&
      !Object.hasOwn(initial,'privateProbe'));
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
          const {readP2InteractiveBrowserControllerBinding,requireP2InteractiveBrowserMediaEvidence,
            requireP2InteractiveBrowserStalledRenewalEvidence}=await import('./p2-lifecycle-suspension-evidence.mjs');
          const {validateP2InteractiveBrowserPermit}=await import('./p2-lifecycle-browser-recorder.mjs');
          const binding=structuredClone(initial.interactiveController),snapshot=structuredClone(interactivePlan);
          const alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&
            isDeepStrictEqual(interactivePlan,snapshot)&&isDeepStrictEqual(initial.interactiveController,binding);
          const requireRecorder=()=>demand(alive()&&isDeepStrictEqual(readP2InteractiveBrowserControllerBinding(interactivePlan,browserController),binding));
          requireRecorder();
          const controllerChallenge=binding.challenge,epoch=(BigInt(snapshot.initialEpoch)+1n).toString();
          const stage=snapshot.scopedAction.stage,identity=stage==='identity',authoring=stage==='authoring',media=stage==='media',learning=stage==='learning';
          const stageLabel=stage.toUpperCase().replaceAll('-','_');
          const paidGrant=stage==='paid-grant',learnerAccess=stage==='learner-access',paidRevoke=stage==='paid-revoke';
          const lessonEntry=stage==='lesson-entry',lessonDenial=stage==='lesson-denial',assessment=stage==='lesson-assessment',resume=stage==='lesson-resume',restore=stage==='lesson-restore';
          const ackLoss=stage==='lesson-ack-loss';
          const exitSave=stage==='lesson-exit-save';
          const visibility=stage==='lesson-visibility-save';
          const staleRevision=stage==='lesson-stale-revision',stalledRenewal=stage===p2StalledRenewalStage;
          const gatewayScoped=authoring||media||learning||paidGrant||learnerAccess||paidRevoke||lessonEntry||lessonDenial||assessment||resume||restore||ackLoss||exitSave||visibility||staleRevision||stalledRenewal;
          const {selection,enrollment,firstOwner,authoring:authoringPermit,media:mediaPermit,learning:learningPermit,paidGrant:paidGrantPermit,
            learnerAccess:learnerAccessPermit,paidRevoke:paidRevokePermit,lessonEntry:lessonEntryPermit,
            lessonDenial:lessonDenialPermit,assessment:assessmentPermit,resume:resumePermit,restore:restorePermit,ackLoss:ackLossPermit,
            exitSave:exitSavePermit,visibility:visibilityPermit,staleRevision:staleRevisionPermit,stalledRenewal:stalledRenewalTarget}=selectedInteractive;
          const paired=authoringPairedOperation(selection.operation);
          const joinedUpload=media&&selection.operation===p2MediaUploadCallbackOperation;
          const context=selection.actorKind==='admin'?'owner':'learner';
          const permitInput={stage,epoch,windowSeconds:snapshot.scopedAction.windowSeconds,
            ...(authoring?{authoring:authoringPermit}:media?{media:mediaPermit}:learning?{learning:learningPermit}:paidGrant?{paidGrant:paidGrantPermit}:
              learnerAccess?{learnerAccess:learnerAccessPermit}:paidRevoke?{paidRevoke:paidRevokePermit}:
              lessonEntry?{lessonEntry:lessonEntryPermit}:lessonDenial?{lessonDenial:lessonDenialPermit}:assessment?{assessment:assessmentPermit}:resume?{resume:resumePermit}:restore?{restore:restorePermit}:
              ackLoss?{ackLoss:ackLossPermit}:exitSave?{exitSave:exitSavePermit}:visibility?{visibility:visibilityPermit}:
              staleRevision?{staleRevision:staleRevisionPermit}:stalledRenewal?{stalledRenewal:stalledRenewalTarget}:
              firstOwner?{firstOwner}:enrollment?{identityEnrollment:enrollment}:identity?{identity:selection}:{})};
          let phase='new',expiresAt,installed=false,gatewayObservation,mediaArm,mediaUpload,heldMediaResponse,stalledBaseline,stalledFence;
          const statusFor=disposition=>`P2_INTERACTIVE_${stageLabel}_${disposition}`;
          const call=async(operation,disposition,extraKeys,data={},timeout=120_000,waitingDisposition)=>{
            demand(alive());
            const packet=await request(operation,'CERTIFICATION_INTERACTIVE_OBSERVED',{controllerChallenge,...data},timeout);
            const receipt=packet.receipt;
            const waiting=waitingDisposition!==undefined&&receipt?.status===statusFor(waitingDisposition);
            demand(exact(packet,['id','status','receipt'])&&exact(receipt,[...interactiveReceiptKeys,...(waiting?[]:extraKeys)]));
            requireQualificationTargetProfile(currentProfile,receipt);
            demand(receipt.version===2&&(receipt.status===statusFor(disposition)||waiting)&&
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
              async observe(baseline){
                demand(phase==='installed'&&(stalledRenewal||baseline===undefined));requireRecorder();phase='observing';
                try{
                  const receipt=await call('interactive-observe','GATEWAY_OBSERVED',interactiveGatewayKeys);
                  requireInteractiveGatewayObservation(receipt,epoch,selection);
                  if(stalledRenewal){
                    stalledBaseline=structuredClone(validateP2StalledPlaybackRenewalBaseline(baseline,stalledRenewalTarget));
                    demand(stalledBaseline.playback.requestId===receipt.gatewayAcknowledgements[5].requestId);
                  }
                  gatewayObservation=structuredClone(receipt);phase='observed';return receipt;
                }catch{phase='observe-failed';throw new Error(`P2_CERTIFICATION_INTERACTIVE_${stageLabel}_OBSERVE_FAILED`);}
              },
            }:{}),
            ...(joinedUpload?{
              async armMedia(caseEvidence){
                demand(phase==='fenced'&&gatewayObservation);requireRecorder();
                mediaReservationJoinedEvidence(caseEvidence,selection,gatewayObservation);
                requireP2InteractiveBrowserMediaEvidence(interactivePlan,browserController,caseEvidence.browserResponse);
                heldMediaResponse=caseEvidence.browserResponse;
                phase='media-arming';
                try{
                  const receipt=await call('interactive-media-arm','UPLOAD_ARMED',['intentSha256','expiresAt'],
                    {caseEvidence:structuredClone(caseEvidence)},30_000);
                  requireRecorder();
                  mediaArm=Object.freeze(validateP2MediaDispatchIntent({intentSha256:receipt.intentSha256,expiresAt:receipt.expiresAt},expiresAt/1000));
                  mediaDispatchReceipts.set(receipt,{plan:interactivePlan,controller:browserController,dispatch:mediaArm,
                    active:()=>alive()&&phase==='media-armed'});
                  phase='media-armed';
                  return Object.freeze(receipt);
                }catch{phase='media-arm-failed';throw new Error('P2_CERTIFICATION_INTERACTIVE_MEDIA_ARM_FAILED');}
              },
              async observeMedia(dispatchEvidence){
                demand(phase==='media-armed');
                validateP2MediaDispatchReceipt(dispatchEvidence);
                requireRecorder();
                requireP2InteractiveBrowserMediaEvidence(interactivePlan,browserController,heldMediaResponse,
                  {response:dispatchEvidence,intentSha256:mediaArm.intentSha256});
                const evidence=structuredClone(dispatchEvidence);
                phase='media-observing';
                try{
                  const remaining=()=>mediaArm.expiresAt*1000-Date.now();
                  for(;;){
                    requireRecorder();
                    const timeout=remaining();
                    demand(timeout>0);
                    const receipt=await call('interactive-media-observe','UPLOAD_OBSERVED',
                      ['callbackReceiptSha256','requestId','eventId','assetId'],{dispatchEvidence:evidence},
                      Math.min(timeout,30_000),'UPLOAD_WAITING');
                    requireRecorder();
                    demand(remaining()>0);
                    if(receipt.status===statusFor('UPLOAD_WAITING')){
                      await delay(Math.min(750,remaining()),undefined,{signal:controller.signal});
                      continue;
                    }
                    const {callbackReceiptSha256,requestId,eventId,assetId}=receipt;
                    demand(nonzeroSha256(callbackReceiptSha256)&&[requestId,eventId,assetId].every(providerId)&&
                      !gatewayObservation.gatewayAcknowledgements.some(row=>row.requestId===requestId));
                    mediaUpload={intentSha256:mediaArm.intentSha256,callbackReceiptSha256,requestId,eventId,assetId,httpStatus:evidence.status};
                    phase='media-observed';
                    return receipt;
                  }
                }catch{phase='media-observe-failed';throw new Error('P2_CERTIFICATION_INTERACTIVE_MEDIA_OBSERVE_FAILED');}
              },
            }:{}),
            async fence(){
              // The gateway fence must remain available when the recorder dies
              // or an observation fails after the host has opened the stage.
              demand(['opened','installed','install-failed','observed','observe-failed'].includes(phase));phase='fencing';
              const receipt=await call('interactive-fence','FENCED',gatewayFenceKeys);
              demand(closedGateway(receipt));phase='fenced';return receipt;
            },
            ...(stalledRenewal?{
              async confirmObservationFence(){
                demand(phase==='fenced'&&stalledBaseline&&gatewayObservation);requireRecorder();phase='confirming-fence';
                const receipt=await call('interactive-confirm-fence','OBSERVATION_FENCED',
                  ['observedAt','frontendAdmission','frontendOperationCount',...gatewayFenceKeys]);
                demand(utc(receipt.observedAt)&&receipt.frontendOperationCount===0&&closedGateway(receipt)&&
                  isDeepStrictEqual(receipt.frontendAdmission,{epoch:(BigInt(epoch)+1n).toString(),newWork:false,recovery:false,active:0,uncertain:0}));
                stalledFence=structuredClone(receipt);phase='observation-fenced';
                const handle=Object.freeze(receipt);
                stalledFenceReceipts.set(handle,{plan:interactivePlan,controller:browserController,active:()=>alive()&&phase==='observation-fenced'});
                return handle;
              },
            }:{}),
            async retain(caseEvidence){
              demand(phase===(joinedUpload?'media-observed':stalledRenewal?'observation-fenced':'fenced')&&installed&&(!gatewayScoped||gatewayObservation)&&
                (!joinedUpload||mediaUpload&&caseEvidence?.browserResponse===heldMediaResponse));requireRecorder();
              if(stalledRenewal)requireP2InteractiveBrowserStalledRenewalEvidence(interactivePlan,browserController,caseEvidence?.stalledRenewalBrowser);
              const evidence=structuredClone(caseEvidence);
              const expected=media?mediaReservationJoinedEvidence(evidence,selection,gatewayObservation):
                learning?learningJoinedEvidence(evidence,selection,gatewayObservation):
                paidGrant?paidGrantJoinedEvidence(evidence,selection,gatewayObservation):
                learnerAccess?learnerAccessJoinedEvidence(evidence,selection,gatewayObservation):
                paidRevoke?paidRevokeJoinedEvidence(evidence,selection,gatewayObservation):
                lessonEntry?lessonEntryJoinedEvidence(evidence,selection,gatewayObservation):
                lessonDenial?lessonDenialJoinedEvidence(evidence,selection,gatewayObservation):
                assessment?assessmentJoinedEvidence(evidence,selection,gatewayObservation):
                resume?resumeJoinedEvidence(evidence,selection,gatewayObservation):
                restore?restoreJoinedEvidence(evidence,selection,gatewayObservation):
                ackLoss?ackLossJoinedEvidence(evidence,selection,gatewayObservation):
                exitSave?exitSaveJoinedEvidence(evidence,selection,gatewayObservation):
                visibility?visibilityJoinedEvidence(evidence,selection,gatewayObservation):
                staleRevision?staleRevisionJoinedEvidence(evidence,selection,gatewayObservation):
                stalledRenewal?stalledRenewalJoinedEvidence(evidence,stalledRenewalTarget,gatewayObservation,stalledBaseline,stalledFence):
                paired?authoringChangeJoinedEvidence(evidence,selection,gatewayObservation,authoringPermit.winnerBodySha256):
                selection.operation===authoringQuizOperation?authoringQuizJoinedEvidence(evidence,selection,gatewayObservation):
                selection.operation===authoringArchiveOperation?authoringArchiveJoinedEvidence(evidence,selection,gatewayObservation):
                authoringPublicationCase(selection.operation)?authoringPublicationJoinedEvidence(evidence,selection,gatewayObservation):
                authoring?authoringJoinedEvidence(evidence,selection,gatewayObservation):
                identity?identityJoinedEvidence(evidence,selection,context,enrollment,firstOwner):lifecycleJoinedEvidence(evidence,selection);
              if(joinedUpload)Object.assign(expected,{uploadSent:true,upload:mediaUpload});
              phase='retaining';
              const receipt=await call('interactive-retain','JOINED',
                ['browserProgramSha256',...Object.keys(expected),...(media?['generation','environmentId','courseWitnessSha256']:[]),
                  'frontendAdmission','frontendOperationCount',...gatewayFenceKeys],{caseEvidence:evidence});
              demand(receipt.browserProgramSha256===binding.browserProgramSha256&&Object.entries(expected).every(([key,value])=>isDeepStrictEqual(receipt[key],value))&&
                (!media||Number.isSafeInteger(receipt.generation)&&receipt.generation>=1&&receipt.generation<=2_147_483_647&&
                  typeof receipt.environmentId==='string'&&/^[A-Za-z0-9_-]{1,255}$/u.test(receipt.environmentId)&&nonzeroSha256(receipt.courseWitnessSha256))&&
                isDeepStrictEqual(receipt.frontendAdmission,{epoch:(BigInt(epoch)+1n).toString(),newWork:false,recovery:false,active:0,uncertain:0})&&
                (learnerAccess||lessonDenial||stalledRenewal?receipt.frontendOperationCount===0:lessonEntry?receipt.frontendOperationCount===1:
                  assessment?receipt.frontendOperationCount===3:
                  resume?receipt.frontendOperationCount===4:
                  restore?receipt.frontendOperationCount===2:
                  ackLoss?receipt.frontendOperationCount===5:
                  exitSave||visibility?receipt.frontendOperationCount===3:
                  staleRevision?receipt.frontendOperationCount===8:media?Number.isSafeInteger(receipt.frontendOperationCount)&&receipt.frontendOperationCount>=3:
                  Number.isSafeInteger(receipt.frontendOperationCount)&&receipt.frontendOperationCount>0)&&closedGateway(receipt));
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
            async preflightCredential(handle){const secret=readers.readP2LifecycleWorkerCronSecret(handle);
              demand(credential===undefined&&(!profiled||secret===authorityBearer));credential=secret;return call('worker-credential',{secret},240_000);},
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
          const value=await request('certification-prepare-close','CERTIFICATION_CLOSE_PREPARED',{caseOutcome,requestEvidence},240_000);
          if(initial.certificationPlan.rotationSuccessor)requireP2CertificationRotationTerminal(initial,value.receipt,caseOutcome);
          prepared=true;return value.receipt;},
        async finish(outcome){demand(prepared);const name=profiled?'p2-certification-close-prepared.json':'p2-certification-outcome.json';
          const bytes=readFrontendReleaseEvidence(directory,name);demand(JSON.stringify(JSON.parse(bytes))===JSON.stringify(outcome));
          joined=await request('finish','P2_CERTIFICATION_JOINED',{certification:bytes.toString('base64')});
          if(initial.certificationPlan.rotationSuccessor)demand(isDeepStrictEqual(joined.receipt,outcome));
          return joined.receipt;},
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
