// Fixed source parent for bounded certification stages. No release replay.
import {isDeepStrictEqual} from 'node:util';
import {frontendCoordinationHash as rawHash} from './frontend-release-inventory.mjs';
import {readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {prepareP2LifecycleNativePlan,p2NativeHash,P2_LIFECYCLE_NATIVE_SCHEDULE} from './p2-lifecycle-native.mjs';
import {frontendAdmissionTargetSha256} from './frontend-admission-bootstrap.mjs';
import {mkdirSync,existsSync,lstatSync,realpathSync,openSync,closeSync,fstatSync,readFileSync,constants} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {frontendReleaseReceiptStore,frontendPrivateReceiptDirectory} from './frontend-release-receipts.mjs';
import {changeFrontendAdmission,closeFrontendInteractiveAdmission,observeFrontendDrain,openFrontendInteractiveAdmission,
  prepareFrontendInteractiveProducer,reconcileFrontendOperation} from './frontend-admission.mjs';
import {qualifyP2LifecycleNative,containP2LifecycleNative} from './p2-lifecycle-native.mjs';
import {prepareP2LifecycleTransportFaultPlan,runP2LifecycleTransportFault} from './p2-lifecycle-transport-fault.mjs';
import {withP2CertificationFrontendSession,readP2CertificationCurrent} from './p2-certification-current-probe.mjs';
import {collectP2CertificationRequestDetails} from './p2-certification-request-evidence.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareP2OperatorRelease} from './p2-release.mjs';
import {prepareP2ProfiledCurrentRelease,verifyP2ProfiledCurrentReleaseConfiguration} from './p2-profiled-current-release.mjs';
import {assertSourceCheckout} from './source-checkout.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';
import {committedOperatorSource,committedProfiledCurrentOperatorSource,verifyOperatorCi} from './recreation_source.mjs';
import {githubSourceApi} from './release-inputs.mjs';
import {recreationSsh} from './recreation_ssh.mjs';
import {p2CertificationEnvironmentLock,readP2CertificationInteractiveStage,readP2CertificationKnownAckStage} from './p2-certification-transport.mjs';
import {prepareP2LifecycleSuspensionPlan,launchP2LifecycleBrowserRecorder,launchP2InteractiveBrowserRecorder,readP2InteractiveBrowserControllerBinding,
  readP2LifecycleBrowserControllerBinding,readP2LifecycleBrowserAuthentication,
  captureP2SuspensionControlledAuthority,observeP2SuspensionControlledAuthority,captureP2SuspensionPending} from './p2-lifecycle-suspension-evidence.mjs';
import {validateP2CanonicalBrowserObservation} from './p2-canonical-browser-origin.mjs';
import {interactiveCourseStagePermits} from '../gateway/operations.mjs';
import {captureP2InteractiveIdentityBaseline,observeP2InteractiveIdentityCase,captureP2InteractiveEnrollmentBaseline,
  observeP2InteractiveEnrollmentCase,validateP2InteractiveEnrollmentEmail,
  captureP2InteractiveLifecycleBaseline,observeP2InteractiveLifecycleCase} from './p2-lifecycle-pending-probe.mjs';
import {captureP2InteractiveCourseDraftBaseline,observeP2InteractiveCourseDraftCase,validateP2InteractiveCourseDraft,
  captureP2InteractiveCourseDraftEditsBaseline,observeP2InteractiveCourseDraftEditsCase,validateP2InteractiveCourseDraftEdits,
  captureP2InteractiveCourseReorderBaseline,observeP2InteractiveCourseReorderCase,validateP2InteractiveCourseReorder,
  captureP2InteractiveCurriculumCreateBaseline,observeP2InteractiveCurriculumCreateCase,validateP2InteractiveCurriculumCreate,
  captureP2InteractivePublicationBaseline,observeP2InteractivePublicationCase,validateP2InteractivePublication,
  captureP2InteractiveQuizSaveBaseline,observeP2InteractiveQuizSaveCase,validateP2InteractiveQuizSave,
  captureP2InteractiveFreeEnrollmentBaseline,observeP2InteractiveFreeEnrollmentCase,
  captureP2InteractivePaidGrantBaseline,observeP2InteractivePaidGrantCase} from './p2-lifecycle-persistence-probe.mjs';
import {prepareP2LifecycleWorkerEvidencePlan,createP2LifecycleWorkerPrivateResolvers,readP2LifecycleWorkerCronSecret,preflightP2DirectLifecycleWorker,
  invokeP2DirectLifecycleWorker,joinP2DirectLifecycleWorker,readP2DirectWorkerSourceArtifact} from './p2-lifecycle-worker-evidence.mjs';

const plans=new WeakMap();
const browserSessions=new WeakMap();
const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_PARENT_REFUSED');};
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/u.test(value)&&!/^0+$/u.test(value);
const action=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)&&!/^0+$/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const scopedModes=new Set(['export-cleanup','mux-callback-recovery','lifecycle-persistence']);
const scopedPlanningModes=new Set([...scopedModes,'interactive-browser']);
const persistenceModes=new Set(['export-cleanup','lifecycle-persistence']);
// This exact Course source enforces managed-only callbacks after signature verification.
const scopedMuxCourseSource='b21e25cf900458eb6cbbd993582d7e1bbac36c4b';
const assetEvents=new Set(['video.asset.created','video.asset.ready','video.asset.errored','video.asset.deleted']);
const trackEvents=new Set(['video.asset.track.ready','video.asset.track.deleted']);
const providerId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,255}$/u.test(value);
const courseBackedBrowserStages=new Set(['authoring','learning','paid-grant']);
const pairedBrowserStages=new Set(['lifecycle',...courseBackedBrowserStages]);
const emptyRequestSha256=rawHash(Buffer.alloc(0));
const authoringCases=new Map([
  ['create-draft',{field:'authoringDraft',paired:false,validate:validateP2InteractiveCourseDraft,
    baseline:captureP2InteractiveCourseDraftBaseline,observe:observeP2InteractiveCourseDraftCase}],
  ['edit-and-stale-draft',{field:'authoringDraftEdits',paired:true,validate:validateP2InteractiveCourseDraftEdits,
    baseline:captureP2InteractiveCourseDraftEditsBaseline,observe:observeP2InteractiveCourseDraftEditsCase}],
  ['reorder-and-stale-curriculum',{field:'authoringReorder',paired:true,validate:validateP2InteractiveCourseReorder,
    baseline:captureP2InteractiveCourseReorderBaseline,observe:observeP2InteractiveCourseReorderCase}],
  ['create-curriculum',{field:'authoringCurriculum',paired:false,validate:validateP2InteractiveCurriculumCreate,
    baseline:captureP2InteractiveCurriculumCreateBaseline,observe:observeP2InteractiveCurriculumCreateCase}],
  ['qualify-publication',{paired:false,validate:validateP2InteractivePublication,
    baseline:captureP2InteractivePublicationBaseline,observe:observeP2InteractivePublicationCase}],
  ['save-quiz-revision',{field:'authoringQuiz',paired:false,validate:validateP2InteractiveQuizSave,
    baseline:captureP2InteractiveQuizSaveBaseline,observe:observeP2InteractiveQuizSaveCase}],
]);
const authoringSlug=value=>typeof value==='string'&&value.length<=120&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
function authoringSelection({actorId,authoringAction,requests}){
  const {operation,...selection}=authoringAction;
  if(operation==='qualify-publication')return selection;
  if(operation==='save-quiz-revision')return {...selection,actorId,bodySha256:requests[2].bodySha256};
  return authoringCases.get(operation).paired?{...selection,winnerBodySha256:requests[1].bodySha256,staleBodySha256:requests[2].bodySha256}:
    {...selection,bodySha256:requests[1].bodySha256};
}
function quizSaveActionValid(selected,requests){
  if(!exactKeys(selected,['operation','courseId','slug','revision','lessonId','quizRevision','documentSha256'])||
    !uuid(selected.courseId)||!uuid(selected.lessonId)||!authoringSlug(selected.slug)||
    !Number.isInteger(selected.revision)||selected.revision<1||selected.revision>=2_147_483_647||
    !Number.isInteger(selected.quizRevision)||selected.quizRevision<0||selected.quizRevision>=2_147_483_647||
    !sha(selected.documentSha256)||selected.documentSha256===emptyRequestSha256||requests.length!==3)return false;
  const detail=`/course/v1/admin/courses/${selected.courseId}`;
  const quiz=`/course/v1/admin/lessons/${selected.lessonId}/quiz`;
  const [read,prior,save]=requests;
  return isDeepStrictEqual(read,{method:'GET',target:detail,bodySha256:emptyRequestSha256,uses:2})&&
    isDeepStrictEqual(prior,{method:'GET',target:quiz,bodySha256:emptyRequestSha256,uses:1})&&
    exactKeys(save,['method','target','bodySha256','uses'])&&save.method==='PUT'&&save.target===quiz&&save.uses===1&&
    sha(save.bodySha256)&&save.bodySha256!==emptyRequestSha256;
}
function publicationActionValid(selected,requests){
  if(!exactKeys(selected,['operation','courseId','slug','revision','outcome','issueCodes'])||
    !uuid(selected.courseId)||!authoringSlug(selected.slug)||!Number.isInteger(selected.revision)||
    selected.revision<1||selected.revision>=2_147_483_647||!['published','blocked'].includes(selected.outcome)||
    !Array.isArray(selected.issueCodes)||selected.issueCodes.length>16||
    ![...selected.issueCodes].every((code,index,list)=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)&&
      (index===0||list[index-1]<code)))return false;
  const published=selected.outcome==='published';
  if(published?selected.issueCodes.length!==0:selected.issueCodes.length===0)return false;
  const detail=`/course/v1/admin/courses/${selected.courseId}`;
  const expected=[
    {method:'GET',target:detail,bodySha256:emptyRequestSha256,uses:published?2:1},
    {method:'GET',target:detail+'/publication-readiness',bodySha256:emptyRequestSha256,uses:1},
  ];
  if(published)expected.push({method:'PATCH',target:detail,uses:1,
    bodySha256:rawHash(JSON.stringify({expectedRevision:selected.revision,status:'published'}))});
  return isDeepStrictEqual(requests,expected);
}
function learningEnrollmentActionValid(selected,requests){
  if(!exactKeys(selected,['operation','courseId','slug','idempotencyKey'])||selected.operation!=='enroll-free-course'||
    !uuid(selected.courseId)||!authoringSlug(selected.slug)||!uuid(selected.idempotencyKey))return false;
  const detail=`/course/v1/student/courses/${selected.courseId}`;
  return isDeepStrictEqual(requests,[
    {method:'GET',target:`/course/v1/courses/${selected.slug}`,uses:1,bodySha256:emptyRequestSha256},
    {method:'GET',target:detail,uses:2,bodySha256:emptyRequestSha256},
    {method:'POST',target:detail+'/enrollments',uses:1,bodySha256:rawHash(JSON.stringify({idempotencyKey:selected.idempotencyKey}))},
    {method:'GET',target:`/course/v1/student/progress?courseId=${selected.courseId}`,uses:1,bodySha256:emptyRequestSha256},
  ]);
}
function paidGrantActionValid(selected,requests){
  if(!exactKeys(selected,['operation','courseId','userId','revision','idempotencyKey','reasonSha256'])||
    selected.operation!=='grant-paid-access'||![selected.courseId,selected.userId,selected.idempotencyKey].every(uuid)||
    !Number.isInteger(selected.revision)||selected.revision<1||selected.revision>2_147_483_647||
    !sha(selected.reasonSha256)||selected.reasonSha256===emptyRequestSha256||requests.length!==4)return false;
  const key='owner-paid%3A'+selected.idempotencyKey;
  const [detail,command,write,grant]=requests;
  return isDeepStrictEqual(detail,{method:'GET',target:`/course/v1/admin/courses/${selected.courseId}`,uses:3,bodySha256:emptyRequestSha256})&&
    isDeepStrictEqual(command,{method:'GET',target:`/course/v1/admin/entitlements/commands?idempotencyKey=${key}&limit=2`,uses:2,bodySha256:emptyRequestSha256})&&
    exactKeys(write,['method','target','bodySha256','uses'])&&write.method==='POST'&&write.target==='/course/v1/admin/entitlements/grants'&&
    write.uses===1&&sha(write.bodySha256)&&write.bodySha256!==emptyRequestSha256&&
    isDeepStrictEqual(grant,{method:'GET',target:`/course/v1/admin/entitlements/grants?userId=${selected.userId}&courseId=${selected.courseId}&idempotencyKey=${key}&limit=2`,
      uses:1,bodySha256:emptyRequestSha256});
}
function reviewedPaidGrantReason(action,execution){
  demand(exactKeys(execution,['reason']));
  const {reason}=execution;
  const {userId,courseId,revision,idempotencyKey,reasonSha256}=action.paidGrantAction;
  demand(typeof reason==='string'&&reason.length>0&&reason.length<=1800&&reason.trim()===reason&&
    rawHash(reason)===reasonSha256);
  const body={userId,courseId,reason:`[paid-course revision ${revision}] ${reason}`,idempotencyKey:`owner-paid:${idempotencyKey}`};
  demand(rawHash(JSON.stringify(body))===action.requests[2].bodySha256);
  return reason;
}
export const P2_CERTIFICATION_READY_FILES=Object.freeze(['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json',
  'frontend-workload-outcome.json','frontend-promotion-started.json','frontend-promotion-outcome.json']);

function interactiveActionValid(value){
  const lifecycle=value?.stage==='lifecycle',identity=value?.stage==='identity',authoring=value?.stage==='authoring';
  const enrollment=identity&&Object.hasOwn(value,'identityEnrollment');
  const learning=value?.stage==='learning',paidGrant=value?.stage==='paid-grant';
  const selectionKey=lifecycle?'frontendAction':authoring?'authoringAction':learning?'learningAction':paidGrant?'paidGrantAction':
    identity?(enrollment?'identityEnrollment':'identityActor'):null;
  if(!exactKeys(value,['stage','actorId','requests','windowSeconds',...(selectionKey?[selectionKey]:[])])||
     !['identity','authoring','media','learning','paid-grant','lifecycle'].includes(value.stage)||
     !(value.stage==='identity'?value.actorId===null:uuid(value.actorId))||
     !Number.isInteger(value.windowSeconds)||value.windowSeconds<30||value.windowSeconds>300||
     !Array.isArray(value.requests))return false;
  if(learning)return learningEnrollmentActionValid(value.learningAction,value.requests);
  if(paidGrant)return paidGrantActionValid(value.paidGrantAction,value.requests);
  if(lifecycle){
    const selected=value.frontendAction;
    return value.requests.length===0&&exactKeys(selected,['actorKind','userId','operation'])&&uuid(selected.userId)&&
      (selected.actorKind==='admin'?['suspend','restore','export','delete'].includes(selected.operation):
        selected.actorKind==='customer'&&selected.userId===value.actorId&&
        ['export','delete','preferences-on','preferences-off'].includes(selected.operation));
  }
  if(identity){
    if(enrollment){
      const selected=value.identityEnrollment;
      return value.requests.length===0&&exactKeys(selected,['provider','emailSha256','nonce'])&&
        ['google','resend'].includes(selected.provider)&&sha(selected.emailSha256)&&typeof selected.nonce==='string'&&
        /^[a-f0-9]{32}$/u.test(selected.nonce)&&!/^0+$/u.test(selected.nonce);
    }
    const selected=value.identityActor;
    return value.requests.length===0&&exactKeys(selected,['actorKind','actorId'])&&
      ['admin','customer'].includes(selected.actorKind)&&uuid(selected.actorId);
  }
  if(authoring){
    const selected=value.authoringAction,configured=authoringCases.get(selected?.operation),[read,...mutations]=value.requests;
    if(!configured)return false;
    if(selected.operation==='qualify-publication')return publicationActionValid(selected,value.requests);
    if(selected.operation==='save-quiz-revision')return quizSaveActionValid(selected,value.requests);
    const {paired}=configured,reorder=selected.operation==='reorder-and-stale-curriculum',create=selected.operation==='create-curriculum';
    const detailRead=paired||create,curriculum=reorder||create;
    if(!exactKeys(selected,['operation','slug',...(detailRead?['courseId','revision']:[]),
      ...(curriculum?['kind','parentId']:[]),...(create?['childSlug']:[])])||
      !authoringSlug(selected.slug)||(create&&!authoringSlug(selected.childSlug)))return false;
    if(detailRead&&(!uuid(selected.courseId)||!Number.isInteger(selected.revision)||selected.revision<1||selected.revision>=2_147_483_647))return false;
    if(curriculum&&(!uuid(selected.parentId)||!['module','lesson'].includes(selected.kind)||
      selected.kind==='module'&&selected.parentId!==selected.courseId))return false;
    const base='/course/v1/admin/courses',detail=`${base}/${selected.courseId}`;
    const curriculumPath=selected.kind==='module'?detail+'/modules':`/course/v1/admin/modules/${selected.parentId}/lessons`;
    const target=curriculum?curriculumPath+(reorder?'/reorder':''):paired?detail:base;
    return isDeepStrictEqual(read,{method:'GET',target:detailRead?detail:base+'?limit=100',bodySha256:emptyRequestSha256,uses:paired?3:create?2:1})&&
      mutations.length===(paired?2:1)&&mutations.every(row=>exactKeys(row,['method','target','bodySha256','uses'])&&
        row.method===(paired&&!reorder?'PATCH':'POST')&&row.target===target&&row.uses===1&&sha(row.bodySha256)&&row.bodySha256!==emptyRequestSha256)&&
      (!paired||mutations[0].bodySha256!==mutations[1].bodySha256);
  }
  if(!value.requests.length||value.requests.length>16)return false;
  const selected=new Set();
  for(const row of value.requests){
    if(!exactKeys(row,['method','target','bodySha256','uses'])||
       typeof row.target!=='string'||row.target.length>512||
       !/^\/course\/v1\/[A-Za-z0-9/_-]+(?:\?[!$%&'()*+,./:;=?@\[\]_~A-Za-z0-9-]+)?$/u.test(row.target)||
       !sha(row.bodySha256)||(row.method==='GET'&&row.bodySha256!==emptyRequestSha256)||
       !Number.isInteger(row.uses)||row.uses<1||row.uses>4||!interactiveCourseStagePermits(value.stage,row.method,row.target))return false;
    const key=JSON.stringify([row.method,row.target,row.bodySha256]);
    if(selected.has(key))return false;
    selected.add(key);
  }
  return true;
}

function scopedActionValid(mode, value){
  if(mode==='interactive-browser')return interactiveActionValid(value);
  if(mode==='export-cleanup')return exactKeys(value,['commandId','readyRecordSha256'])&&uuid(value.commandId)&&sha(value.readyRecordSha256);
  if(mode==='lifecycle-persistence')return exactKeys(value,['stage','subjectBindingSha256'])&&
    ['capture-export-ready','capture-delete-baseline','verify-delete'].includes(value.stage)&&sha(value.subjectBindingSha256);
  if(!exactKeys(value,['attemptId','generation','environmentId','assetId','uploadId','eventType'])||
     !uuid(value.attemptId)||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation>2_147_483_647||
     !providerId(value.environmentId)||(value.assetId!==null&&!providerId(value.assetId))||
     (value.uploadId!==null&&!providerId(value.uploadId)))return false;
  if(value.eventType==='video.upload.asset_created')return value.uploadId!==null;
  return assetEvents.has(value.eventType)||(trackEvents.has(value.eventType)&&value.assetId!==null);
}

export function bindP2CertificationReadyReceipts(directory,plan){
  const profiled=plan.version===2, records={};
  for(const name of P2_CERTIFICATION_READY_FILES){
    const bytes=readFrontendReleaseEvidence(directory,name);demand(rawHash(bytes)===plan.readyReceiptSha256[name]);
    records[name]=profiled?decodeQualificationTargetJson(bytes,'carrier'):JSON.parse(bytes);
  }
  if(profiled){
    requireQualificationTargetProfile(currentProfile,plan,...Object.values(records));
    const [intent,created,staged,workload,promotion,completed]=P2_CERTIFICATION_READY_FILES.map(name=>records[name]);
    demand(Object.values(records).every(row=>row.version===2&&row.previousDeploymentId===intent.previousDeploymentId)&&
      [intent,created,staged,workload,completed].every(row=>row.trafficAuthorized===false)&&workload.nativeSchedulerVerified===false&&
      (intent.previousDeploymentId===null||/^dpl_[A-Za-z0-9]+$/u.test(intent.previousDeploymentId))&&
      intent.previousDeploymentId!==plan.nativePlan.deploymentId&&[intent,created,staged].every(row=>row.promotionAuthorized===false)&&
      staged.readyState==='READY'&&staged.phase==='completed'&&staged.url===plan.nativePlan.deploymentUrl&&
      Number.isSafeInteger(promotion.previousAliasRequestedAt)&&promotion.previousAliasRequestedAt>=0&&
      completed.previousAliasRequestedAt===promotion.previousAliasRequestedAt&&Number.isSafeInteger(completed.aliasRequestedAt)&&
      completed.aliasRequestedAt>promotion.previousAliasRequestedAt&&completed.phase==='completed'&&completed.frontendDomainsPromoted===true);
  }
  const candidate=plans.get(plan)?.candidate??plan.candidate;
  const build=records['frontend-build-created.json'],workload=records['frontend-workload-outcome.json'];
  demand(candidate&&records['frontend-build-outcome.json'].status==='FRONTEND_STAGED'&&records['frontend-promotion-outcome.json'].status==='FRONTEND_DOMAINS_PROMOTED'&&
    P2_CERTIFICATION_READY_FILES.every(name=>{const row=records[name];return row.environment==='staging'&&row.releaseId===plan.originalReleaseId&&row.sourceCommit===plan.sourceCommit&&row.projectId===candidate.workload.projectId&&
      (name==='frontend-build-started.json'||row.deploymentId===plan.nativePlan.deploymentId);})&&
    build.deploymentId===plan.nativePlan.deploymentId&&workload.status==='FRONTEND_VERIFIED'&&workload.contractPhase==='p2'&&
    workload.phase2ContractManifestSha256===candidate.phase2ContractManifestSha256&&isDeepStrictEqual(workload.featureControls,plan.nativePlan.featureControls)&&
    isDeepStrictEqual(workload.writerAdmissionBinding,plan.nativePlan.writerAdmissionBinding)&&rawHash(readFrontendReleaseEvidence(directory,'frontend-workload-outcome.json'))===plan.nativePlan.configurationRecordSha256);
  return records;
}

export function prepareP2BoundedCertification(prepared,input,candidateBytes,{frontendReceipts,configurationSha256,profiledRelease}){
  const candidate=prepared?.migration?.candidate,inventory=prepared?.plan,job=prepared?.migration?.job;
  const profile=profiledRelease?requireQualificationTargetProfile(currentProfile,input,input.native,input.native.target,candidate,inventory,job,job.target):undefined;
  const scoped=scopedPlanningModes.has(input?.mode);
  if(scoped)demand(profile&&scopedActionValid(input.mode,input.scopedAction));
  else demand(input?.scopedAction===undefined);
  demand(persistenceModes.has(input?.mode)?sha(input.persistenceReviewedSha256):input?.persistenceReviewedSha256===undefined);
  if(profile)demand(input.startState==='already-closed'&&input.operatorSourceCommit===job.sourceCommit&&
    sha(profiledRelease.receiptSha256)&&sha(profiledRelease.planSha256)&&
    exactKeys(profiledRelease.apiJobSha256,['course','community'])&&Object.values(profiledRelease.apiJobSha256).every(sha));
  else demand(!Object.hasOwn(input??{},'qualificationTargetProfile')&&!Object.hasOwn(candidate??{},'qualificationTargetProfile'));
  demand(Buffer.isBuffer(candidateBytes)&&candidateBytes.length>0&&candidateBytes.length<=2_000_000);
  const document=profile?decodeQualificationTargetJson(candidateBytes,'carrier'):JSON.parse(candidateBytes);
  demand(isDeepStrictEqual(document,candidate)&&
    candidate?.contractPhase==='p2'&&candidate.environment==='staging'&&candidate.releaseId===inventory?.actionId&&job?.sourceCommit===candidate.sources.frontend.commit&&
    input?.version===(profile?2:1)&&input.environment==='staging'&&inventory.targetSha256===frontendAdmissionTargetSha256('staging',job.target)&&action(input.certificationActionId)&&input.certificationActionId!==candidate.releaseId&&commit(input.operatorSourceCommit)&&
    (scoped||['auth-preparation','browser-pending','direct-worker','native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery','contain-native'].includes(input.mode))&&['qualified-ready','already-closed'].includes(input.startState)&&
    (!['auth-preparation','browser-pending','direct-worker','native-window','known-ack-recovery'].includes(input.mode)||input.operatorSourceCommit===job.sourceCommit)&&
    (input.mode!=='direct-worker'||input.startState==='already-closed')&&
    /^[1-9][0-9]{0,17}$/u.test(input.initialEpoch??'')&&input.candidateSha256===rawHash(candidateBytes)&&input.inventorySha256===rawHash(inventory)&&
    input.configurationSha256===rawHash(configurationSha256)&&sha(input.configurationSha256)&&input.readyReceiptSha256&&
    [input.runtimeInventorySha256,input.gatewayProcessSha256,input.gatewayConfigurationSha256,input.operatorSourceClosureSha256].every(sha)&&
    isDeepStrictEqual(Object.keys(input.readyReceiptSha256).sort(),[...P2_CERTIFICATION_READY_FILES].sort())&&Object.values(input.readyReceiptSha256).every(sha));
  const selected=inventory.producers.find(row=>row.producerSha256===(inventory.runtimeProducerSha256??inventory.bootstrapCompatibility?.runtimeProducerSha256)&&row.role.name===job.target.runtimeRole);
  demand(selected&&isDeepStrictEqual(input.native?.owner,inventory.owner)&&isDeepStrictEqual(input.native.producer,{producerSha256:selected.producerSha256,role:{name:selected.role.name,oid:selected.role.oid}})&&
    isDeepStrictEqual(input.native.featureControls,inventory.certification.featureControls)&&input.native.targetSha256===inventory.targetSha256&&
    ['host','port','database','user','serverMajor'].every(key=>input.native.target[key]===job.target[key]));
  const closedOffset=input.startState==='qualified-ready'?1n:0n;
  if(input.mode==='interactive-browser')demand(input.startState==='already-closed'&&input.operatorSourceCommit===job.sourceCommit&&
    (BigInt(input.initialEpoch)+2n).toString().length<=18);
  if(['native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery'].includes(input.mode)){
    demand(input.requestEvidence?.kind==='operator-recorded-request-details'&&typeof input.requestEvidence.path==='string'&&resolve(input.requestEvidence.path)===input.requestEvidence.path);
    frontendPrivateReceiptDirectory(dirname(input.requestEvidence.path));
  }
  const nativeSettings={...structuredClone(input.native),epoch:input.mode==='contain-native'?input.native.epoch:(BigInt(input.initialEpoch)+closedOffset+1n).toString()};
  let nativePlan;
  if(scoped||['auth-preparation','browser-pending'].includes(input.mode)){
    demand(Array.isArray(input.native.commandWitnesses)&&input.native.commandWitnesses.length===0&&/^dpl_[A-Za-z0-9]+$/u.test(input.native.deploymentId??'')&&
      /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.native.deploymentUrl??'')&&sha(input.native.configurationRecordSha256));
    const control={version:input.version,...(profile?{qualificationTargetProfile:profile,candidateSha256:p2NativeHash(candidate)}:{}),
      purpose:scoped?'scoped-certification-control-only':'browser-authentication-control-only',environment:'staging',actionId:candidate.releaseId,sourceCommit:job.sourceCommit,projectId:candidate.workload.projectId,
      phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,deploymentId:input.native.deploymentId,deploymentUrl:input.native.deploymentUrl,
      configurationRecordSha256:input.native.configurationRecordSha256,targetSha256:inventory.targetSha256,
      target:profile?{...Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,input.native.target[key]])),qualificationTargetProfile:profile}
        :structuredClone(input.native.target),owner:inventory.owner,
      producer:{producerSha256:selected.producerSha256,role:{name:selected.role.name,oid:selected.role.oid}},featureControls:structuredClone(inventory.certification.featureControls),
      writerAdmissionBinding:{mode:'enforce',targetSha256:inventory.targetSha256,producerSha256:selected.producerSha256,sourceCommit:job.sourceCommit,roleName:job.target.runtimeRole},
      schedule:P2_LIFECYCLE_NATIVE_SCHEDULE,initialEpoch:input.initialEpoch,commandWitnesses:[],finalDisposition:'disabled-and-admission-closed'};
    nativePlan=freeze({...control,planSha256:p2NativeHash(control)});
  }else nativePlan=prepareP2LifecycleNativePlan(candidate,nativeSettings,profile);
  if(input.mode==='direct-worker')demand(nativePlan.commandWitnesses.length===1&&input.worker?.input?.commandIndex===0);
  const workerPlan=input.mode==='direct-worker'?prepareP2LifecycleWorkerEvidencePlan(nativePlan,input.worker?.suspensionPlan,input.worker?.input,profile):null;
  demand(workerPlan===null||workerPlan.actionId===input.certificationActionId&&workerPlan.candidateSha256===input.candidateSha256&&workerPlan.configurationSha256===p2NativeHash(configurationSha256)&&
    workerPlan.gatewayProcessSha256===input.gatewayProcessSha256&&workerPlan.gatewayConfigurationSha256===input.gatewayConfigurationSha256);
  const base={version:input.version,...(profile?{qualificationTargetProfile:profile,
    originalReleaseReceiptSha256:profiledRelease.receiptSha256,originalReleasePlanSha256:profiledRelease.planSha256,
    apiJobSha256:structuredClone(profiledRelease.apiJobSha256)}:{}),environment:'staging',certificationActionId:input.certificationActionId,originalReleaseId:candidate.releaseId,sourceCommit:job.sourceCommit,
    operatorSourceCommit:input.operatorSourceCommit,candidateSha256:input.candidateSha256,candidateObjectSha256:p2NativeHash(candidate),inventorySha256:input.inventorySha256,
    configurationSha256:input.configurationSha256,targetSha256:inventory.targetSha256,mode:input.mode,startState:input.startState,initialEpoch:input.initialEpoch,
    browserPlanSha256:['auth-preparation','browser-pending'].includes(input.mode)?input.browserPlanSha256:null,
    workerPlan,
    workerPlanSha256:workerPlan?p2NativeHash(workerPlan):null,
    configurationCanonicalSha256:p2NativeHash(configurationSha256),runtimeInventorySha256:input.runtimeInventorySha256,gatewayProcessSha256:input.gatewayProcessSha256,
    gatewayConfigurationSha256:input.gatewayConfigurationSha256,operatorSourceClosureSha256:input.operatorSourceClosureSha256,
    contractPhase:'p2',phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,nativePlan,
    persistenceReaderEligible:input.operatorSourceCommit===job.sourceCommit,
    requestEvidenceDescriptorSha256:input.requestEvidence?p2NativeHash(input.requestEvidence):null,
    faultSelection:input.mode.startsWith('fault-')||input.mode==='known-ack-recovery'?{stageId:input.fault?.stageId,receiver:input.fault?.receiver,commandIndex:input.fault?.commandIndex,commandSha256:input.fault?.commandSha256}:null,
    readyReceiptSha256:structuredClone(input.readyReceiptSha256),maximumSeconds:scoped||input.mode==='auth-preparation'?300:900,finalDisposition:'native-disabled-and-both-admissions-closed',
    frontendSqlReplay:false,apiSqlReplay:false,rolePreparationAllowed:false,historicalLoginRestorationAllowed:false,buildAllowed:false,promotionAllowed:false,
    wholeReleaseAccepted:false};
  if(scoped)base.scopedAction=structuredClone(input.scopedAction);
  if(persistenceModes.has(input.mode))base.persistenceReviewedSha256=input.persistenceReviewedSha256;
  if(input.mode==='known-ack-recovery'){
    const recovery=input.knownAckRecovery;
    const fields={version:input.version,...(profile?{qualificationTargetProfile:profile}:{})};
    if(profile)requireQualificationTargetProfile(profile,recovery);
    demand(exactKeys(recovery,[...Object.keys(fields),'recoveryActionId','receiverTargets','configurationInputDirectory'])&&recovery.version===input.version&&action(recovery.recoveryActionId)&&
      typeof recovery.configurationInputDirectory==='string'&&resolve(recovery.configurationInputDirectory)===recovery.configurationInputDirectory&&
      recovery.configurationInputDirectory.startsWith('/var/lib/lash-her/releases/staging/')&&
      ![input.certificationActionId,candidate.releaseId,input.fault?.stageId].includes(recovery.recoveryActionId)&&
      nativePlan.commandWitnesses.length===1&&input.fault?.commandIndex===0&&exactKeys(recovery.receiverTargets,['course','community']));
    for(const target of Object.values(recovery.receiverTargets))demand(exactKeys(target,['host','port','database','user','serverMajor','roleOid'])&&
      typeof target.host==='string'&&target.host.length>0&&target.host.length<=253&&Number.isInteger(target.port)&&target.port>0&&target.port<=65535&&
      /^[a-z][a-z0-9_]{0,62}$/u.test(target.database??'')&&/^[a-z][a-z0-9_]{0,62}$/u.test(target.user??'')&&[16,18].includes(target.serverMajor)&&/^[1-9][0-9]{0,9}$/u.test(target.roleOid??''));
    if(profile){
      demand(!recovery.configurationInputDirectory.includes(',')&&recovery.configurationInputDirectory!==profiledRelease.configurationDirectory&&
        nativePlan.commandWitnesses[0].action==='suspend');
      for(const [service,target] of Object.entries(recovery.receiverTargets)){
        const receiver=profiledRelease.apiJobs[service];
        demand(target.user===receiver.runtimeRole&&['host','port','database','serverMajor'].every(key=>target[key]===receiver.target[key]));
      }
    }
    base.knownAckReceiverTargets=structuredClone(recovery.receiverTargets);
    base.knownAckConfigurationInputDirectory=recovery.configurationInputDirectory;
    const intent={...fields,recoveryActionId:recovery.recoveryActionId,certificationActionId:base.certificationActionId,
      ...Object.fromEntries(['candidateSha256','sourceCommit','operatorSourceCommit','targetSha256','configurationSha256','gatewayProcessSha256','runtimeInventorySha256','operatorSourceClosureSha256'].map(key=>[key,base[key]])),
      configurationInputDirectory:base.knownAckConfigurationInputDirectory,nativePlanSha256:nativePlan.planSha256,receiverTargetsSha256:p2NativeHash(base.knownAckReceiverTargets),profile:'known-ack-same-session-ordered-replacement-v1',runtimeReplacements:1,nativeWindowSeconds:nativePlan.windowSeconds,
      sqlReplayAllowed:false,roleChangeAllowed:false,ordinaryClosedZeroGate:false,automaticFailureRecoveryAllowed:false};
    base.knownAckRecovery={...fields,recoveryActionId:recovery.recoveryActionId,intent,intentSha256:p2NativeHash(intent)};
  }else demand(input.knownAckRecovery===undefined);
  const plan=freeze({...base,planSha256:p2NativeHash(base)});
  demand(base.browserPlanSha256===null||sha(base.browserPlanSha256));
  let faultInput;
  if(input.mode.startsWith('fault-')||input.mode==='known-ack-recovery'){
    demand(input.fault&&action(input.fault.stageId)&&(!profile||nativePlan.commandWitnesses.length===1));
    faultInput={version:input.version,...(profile?{qualificationTargetProfile:profile}:{}),stageId:input.fault.stageId,mode:input.mode==='fault-before-upstream'?'503-before-upstream':'drop-after-ack',receiver:input.fault.receiver,
      commandIndex:input.fault.commandIndex,commandSha256:input.fault.commandSha256,candidateSha256:input.candidateSha256,operatorSourceCommit:input.operatorSourceCommit,
      configurationSha256:base.configurationCanonicalSha256,gatewayConfigurationSha256:base.gatewayConfigurationSha256,gatewayProcessSha256:base.gatewayProcessSha256,
      gatewayImageSha256:candidate.artifacts.gateway.image.split('@sha256:')[1],operatorSourceClosureSha256:base.operatorSourceClosureSha256};
    prepareP2LifecycleTransportFaultPlan(nativePlan,faultInput,profile);
  }
  plans.set(plan,{prepared,candidate:structuredClone(candidate),nativeSettings,candidateBytes:Buffer.from(candidateBytes),frontendReceipts,configurationSha256:structuredClone(configurationSha256),requestEvidence:structuredClone(input.requestEvidence),faultInput,
    ...(workerPlan?{workerPlan,suspensionPlan:structuredClone(input.worker.suspensionPlan)}:{})});
  bindP2CertificationReadyReceipts(frontendReceipts,plan);return plan;
}

export function p2CertificationParentContext(plan){const context=plans.get(plan);demand(context);return context;}

export function deriveP2CertificationNativePlan(plan,closedAdmission){
  const context=p2CertificationParentContext(plan),closedOffset=plan.startState==='qualified-ready'?1n:0n;
  demand(!['auth-preparation','browser-pending','direct-worker','contain-native'].includes(plan.mode));
  demand(closedAdmission?.newWork===false&&closedAdmission.recovery===false&&closedAdmission.active===0&&closedAdmission.uncertain===0&&
    closedAdmission.epoch===(BigInt(plan.initialEpoch)+closedOffset).toString());
  const derived=prepareP2LifecycleNativePlan(context.candidate,{...context.nativeSettings,epoch:(BigInt(closedAdmission.epoch)+1n).toString()},plan.qualificationTargetProfile);
  demand(derived.planSha256===plan.nativePlan.planSha256);return derived;
}

async function runKnownAckCase(plan,nativePlan,host,faultPlan,hostStage,client,verify,withOwner,directory){
  const context=p2CertificationParentContext(plan),prepared=context.prepared,policy={environment:'staging',targetSha256:plan.targetSha256};
  const profile=plan.qualificationTargetProfile;
  const handle=await host.knownAckStage(plan),stage=readP2CertificationKnownAckStage(handle,plan);
  await stage.armFault();let barrier,enableAttempted=false,domainJoined=false,closureFailed=false;
  try{
    barrier=await withOwner(()=>changeFrontendAdmission(client,policy,nativePlan.initialEpoch,{newWork:false,recovery:true}));
    demand(barrier.epoch===(BigInt(nativePlan.initialEpoch)+1n).toString());
    const initial=await readP2CertificationCurrent(client,prepared,plan,verify,false,profile);demand(initial.admission.active===0&&initial.admission.uncertain===0&&initial.witness.operations.length===0);
    enableAttempted=true;await host.nativeControl.setEnabled(nativePlan,true);await stage.startWindow();
    const deadline=performance.now()+nativePlan.windowSeconds*1000;
    while(performance.now()<deadline){
      await verify();const domain=await stage.observeDomain();
      demand(['P2_KNOWN_ACK_DOMAIN_PENDING','P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW'].includes(domain.status));
      if(domain.status==='P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW'&&existsSync(context.requestEvidence.path)){
        collectP2CertificationRequestDetails(nativePlan,barrier.epoch,context.requestEvidence,{directory,certificationActionId:plan.certificationActionId});
        const evidence=join(directory,'native-request-evidence'),provenance=JSON.parse(readFrontendReleaseEvidence(evidence,'p2-native-request-evidence-provenance.json'));
        const bytes=readFrontendReleaseEvidence(evidence,provenance.artifactReceipt);demand(rawHash(bytes)===provenance.artifactSha256);
        demand((await stage.retainRequestDetails(bytes)).status==='P2_KNOWN_ACK_REQUEST_DETAILS_JOINED');domainJoined=true;break;
      }
      await pause(Math.min(1000,deadline-performance.now()));
    }
  }finally{
    // Every closure is attempted independently; none replays the fault/request.
    try{demand((await hostStage.disarm(faultPlan)).faultDisabled===true);}catch{closureFailed=true;}
    if(enableAttempted){try{if((await host.nativeControl.observeMetadata(nativePlan)).nativeEnabled!==false)await host.nativeControl.setEnabled(nativePlan,false);
      demand((await host.nativeControl.observeMetadata(nativePlan)).nativeEnabled===false);}catch{closureFailed=true;}}
    try{const actual=await readP2CertificationCurrent(client,prepared,plan,verify,false,profile);
      if(actual.admission.newWork||actual.admission.recovery)await withOwner(()=>changeFrontendAdmission(client,policy,actual.admission.epoch,{newWork:false,recovery:false}));
    }catch{closureFailed=true;}
    try{await host.gatewayStage('closed');}catch{closureFailed=true;}
  }
  demand(domainJoined&&!closureFailed&&barrier);
  const settlement=await stage.prepareSettlement();demand(/^[a-f0-9-]{36}$/u.test(settlement.operationId??'')&&sha(settlement.evidenceSha256)&&/^[1-9][0-9]*$/u.test(settlement.epoch??''));
  await withOwner(()=>reconcileFrontendOperation(client,policy,settlement.epoch,settlement.operationId,settlement.evidenceSha256));
  if(profile){
    const confirmed=await stage.confirmSettlement();
    requireQualificationTargetProfile(profile,confirmed);
    demand(confirmed.version===2&&confirmed.status==='P2_KNOWN_ACK_RECONCILIATION_OBSERVED_FENCED'&&confirmed.operationId===settlement.operationId&&
      confirmed.settlementSha256===settlement.evidenceSha256&&sha(confirmed.reconciliationObservedSha256)&&confirmed.frontendGlobalClosedZero===true&&
      isDeepStrictEqual(confirmed.oldGatewayUncertain,{newWork:0,recovery:1})&&confirmed.runtimeReplaced===false&&confirmed.ordinaryClosedZeroGate===false);
  }
  const result=await stage.replace();demand(result.status==='P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED'&&result.recoveryActionId===plan.knownAckRecovery.recoveryActionId&&
    result.ordinaryClosedZeroGate===false&&result.originalGatewayUncertaintyPreserved===true&&result.runtimeReplacements===1&&result.sqlReplayed===false);
  return result;
}

export async function runP2BoundedCertification(plan,dependencies){
  demand(plan?.version===1);
  return runBoundedCertification(plan,dependencies);
}

async function runScopedCertificationCase(plan,{host,withOwner,verify,observe,client,policy}){
  if(plan.mode==='lifecycle-persistence'){
    const statuses={'capture-export-ready':'P2_LIFECYCLE_EXPORT_READY_CAPTURED',
      'capture-delete-baseline':'P2_LIFECYCLE_EXPORT_SCRUBBED_DELETE_BASELINE_CAPTURED','verify-delete':'P2_LIFECYCLE_DELETE_PERSISTENCE_VERIFIED'};
    const receipt=await host.scopedStage('scoped-persistence-observe');
    demand(receipt.status===statuses[plan.scopedAction.stage]&&receipt.readOnly===true);
    return receipt;
  }
  if(plan.mode==='export-cleanup'){
    const preflight=await host.scopedStage('scoped-export-preflight');
    demand(preflight.status==='P2_SCOPED_EXPORT_CLEANUP_PREFLIGHT_VERIFIED');
    let opened;
    try{
      opened=await withOwner(()=>changeFrontendAdmission(client,policy,plan.initialEpoch,{newWork:false,recovery:true}));
      demand(opened.epoch===(BigInt(plan.initialEpoch)+1n).toString());
      const invocation=await host.scopedStage('scoped-export-invoke');
      demand(invocation.status==='P2_SCOPED_EXPORT_CLEANUP_INVOKED');
    }finally{
      if(opened){
        await verify();const actual=await observe(opened.epoch);
        demand(actual.epoch===opened.epoch&&actual.newWork===false&&actual.recovery===true);
        const closed=await withOwner(()=>changeFrontendAdmission(client,policy,opened.epoch,{newWork:false,recovery:false}));
        demand(closed.epoch===(BigInt(plan.initialEpoch)+2n).toString());
      }
    }
    const receipt=await host.scopedStage('scoped-export-join');
    demand(receipt.status==='P2_SCOPED_EXPORT_CLEANUP_JOINED');
    return receipt;
  }
  const opened=await host.scopedStage('scoped-mux-open');
  demand(opened.status==='P2_SCOPED_MUX_OPENED'&&opened.muxCallbackActive===true);
  let closed;
  try{
    const deadline=performance.now()+90_000;
    while(true){
      await verify();
      const observed=await host.scopedStage('scoped-mux-observe');
      if(observed.status==='P2_SCOPED_MUX_EFFECT_OBSERVED')break;
      demand(observed.status==='P2_SCOPED_MUX_WAITING'&&performance.now()<deadline);
      await pause(1_000);
    }
  }finally{
    closed=await host.scopedStage('scoped-mux-close');
  }
  demand(closed.status==='P2_SCOPED_MUX_CLOSED'&&closed.gatewayAdmissionClosed===true&&closed.gatewayEffectDrained===true);
  return closed;
}

export async function runP2InteractiveFrontendCase(plan,{stage,controller,client,withOwner,verifySession,verifyEnvironment,
  target,ordinaryProducers,signal,controllerChallenge,identityEnrollmentEmail,courseDraft,record=()=>{}}){
  const action=plan.scopedAction;
  demand(plan.mode==='interactive-browser'&&(action?.stage==='identity'||pairedBrowserStages.has(action?.stage))&&interactiveActionValid(action)&&
    plan.startState==='already-closed'&&plan.maximumSeconds===300&&plan.sourceCommit===plan.operatorSourceCommit&&
    /^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch));
  const identity=action.stage==='identity',enrollment=identity&&action.identityEnrollment!==undefined,authoring=action.stage==='authoring';
  const learning=action.stage==='learning',paidGrant=action.stage==='paid-grant',courseBacked=courseBackedBrowserStages.has(action.stage);
  const authoringCase=authoring?authoringCases.get(action.authoringAction.operation):undefined;
  if(courseBacked)demand(courseDraft?.job&&(!authoringCase?.field||courseDraft.draft)&&typeof courseDraft.readCourseDatabaseUrl==='function');
  if(paidGrant)demand(typeof courseDraft.paidGrantReason==='string');
  const statusPrefix=`P2_INTERACTIVE_${action.stage.toUpperCase().replaceAll('-','_')}`;
  const expectedOpen=(BigInt(plan.initialEpoch)+1n).toString(),expectedClosed=(BigInt(plan.initialEpoch)+2n).toString();
  const {operation:_learningOperation,...learningSelection}=action.learningAction??{};
  const {operation:_grantOperation,reasonSha256:_grantReasonSha256,...paidGrantSelection}=action.paidGrantAction??{};
  const selection=authoring?authoringSelection(action):learning?{...learningSelection,actorId:action.actorId}:
    paidGrant?{...paidGrantSelection,actorId:action.actorId,reason:courseDraft.paidGrantReason}:
    enrollment?action.identityEnrollment:identity?action.identityActor:{...action.frontendAction,actorId:action.actorId};
  const context=authoring||paidGrant||!enrollment&&selection.actorKind==='admin'?'owner':'learner';
  const policy={environment:'staging',targetSha256:plan.targetSha256,runtimeRole:target.runtimeRole};
  const runtimeProducer=plan.nativePlan.producer;
  const producerSha256=rawHash(`lash-her:p2q:interactive-producer:v1\n${plan.sourceCommit}\n${plan.targetSha256}`);
  const reviewed={sourceCommit:plan.sourceCommit,ordinaryProducers,runtimeProducer,
    interactiveProducer:{producerSha256,role:runtimeProducer.role}};
  const observations={verifySession,verifyEnvironment};
  const courseObservations=courseBacked?{...observations,readCourseDatabaseUrl:courseDraft.readCourseDatabaseUrl}:undefined;
  const cancelBrowser=()=>{void Promise.resolve().then(()=>controller.close()).catch(()=>{});};
  signal?.addEventListener('abort',cancelBrowser,{once:true});
  try{
    signal?.throwIfAborted();
    const prepared=await stage.prepare();
    demand(prepared.status===statusPrefix+'_PREPARED');
    const baseline=authoringCase?await authoringCase.baseline(courseDraft.job,selection,courseDraft.draft,courseObservations):
      learning?await captureP2InteractiveFreeEnrollmentBaseline(courseDraft.job,selection,courseObservations):
      paidGrant?await captureP2InteractivePaidGrantBaseline(courseDraft.job,selection,courseObservations):
      enrollment?await captureP2InteractiveEnrollmentBaseline(client,target,selection,identityEnrollmentEmail,observations):
      identity?await captureP2InteractiveIdentityBaseline(client,target,selection,controllerChallenge,observations):
        await captureP2InteractiveLifecycleBaseline(client,target,selection,observations);
    if(action.stage==='lifecycle')record('p2-interactive-lifecycle-baseline.json',baseline);
    const registered=await withOwner(()=>prepareFrontendInteractiveProducer(client,policy,plan.initialEpoch,reviewed));
    demand(registered.epoch===plan.initialEpoch&&registered.producerSha256===producerSha256&&
      registered.newWork===false&&registered.recovery===false);
    let gatewayOpened=false,frontendOpened,browserEvidence,closureFailed=false;
    try{
      const opened=await stage.open();
      gatewayOpened=true;
      demand(opened.status===statusPrefix+'_OPENED');
      if(courseBacked)demand(opened.gatewayScoped===true);
      frontendOpened=await withOwner(()=>openFrontendInteractiveAdmission(client,policy,plan.initialEpoch,reviewed));
      demand(frontendOpened.epoch===expectedOpen&&frontendOpened.newWork===true&&frontendOpened.recovery===true);
      const installed=await stage.installPermit();
      demand(installed.context===context&&installed.epoch===expectedOpen&&installed.stage===action.stage);
      await controller.open(context);
      browserEvidence=authoringCase?.paired?await controller.captureAuthoringResponses(context):authoring?await controller.captureAuthoringResponse(context):
        learning?await controller.captureLearningResponse(context):
        paidGrant?await controller.capturePaidGrantResponse(context):
        identity?await controller.captureIdentity(context,baseline.ownerSubjectSha256):
        await controller.captureLifecycleResponse(context);
      record(`p2-interactive-${action.stage}-browser.json`,browserEvidence);
      if(courseBacked){
        const gateway=await stage.observe();
        demand(gateway.status===statusPrefix+'_GATEWAY_OBSERVED');
        record(`p2-interactive-${action.stage}-gateway.json`,gateway);
      }
    }finally{
      if(gatewayOpened)try{
        const fenced=await stage.fence();
        demand(fenced.status===statusPrefix+'_FENCED');
      }catch{closureFailed=true;}
      if(frontendOpened)try{
        const closed=await withOwner(()=>closeFrontendInteractiveAdmission(client,policy,expectedOpen,reviewed));
        record(`p2-interactive-${action.stage}-frontend-closed.json`,closed);
        let drained=closed;
        const deadline=performance.now()+10_000;
        while(drained.active>0&&drained.uncertain===0&&performance.now()<deadline){
          await pause(250);
          drained=await withOwner(()=>observeFrontendDrain(client,policy,expectedClosed));
        }
        if(drained!==closed)record(`p2-interactive-${action.stage}-frontend-drained.json`,drained);
        demand(drained.epoch===expectedClosed&&drained.newWork===false&&drained.recovery===false&&
          drained.active===0&&drained.uncertain===0&&drained.ledgerDrained===true);
      }catch{closureFailed=true;}
      if(closureFailed)throw new Error(statusPrefix+'_CLOSURE_REQUIRES_REVIEW');
    }
    signal?.throwIfAborted();
    const witness=authoringCase?await authoringCase.observe(courseDraft.job,selection,baseline,
      authoringCase.paired?browserEvidence.winner.body:browserEvidence.body,courseObservations):
      learning?await observeP2InteractiveFreeEnrollmentCase(courseDraft.job,selection,baseline,browserEvidence.body,courseObservations):
      paidGrant?await observeP2InteractivePaidGrantCase(courseDraft.job,selection,baseline,browserEvidence.body,courseObservations):
      enrollment?await observeP2InteractiveEnrollmentCase(client,target,selection,baseline,browserEvidence,observations):
      identity?await observeP2InteractiveIdentityCase(client,target,selection,baseline,browserEvidence,observations):
        await observeP2InteractiveLifecycleCase(client,target,selection,baseline,browserEvidence,observations);
    record(`p2-interactive-${action.stage}-witness.json`,witness);
    const joined=await stage.retain(authoringCase?.paired?{browserResponses:browserEvidence,courseWitness:witness}:
      courseBacked?{browserResponse:browserEvidence,courseWitness:witness}:
      identity?{browserIdentity:browserEvidence,identityWitness:witness}:{browserResponse:browserEvidence,lifecycleWitness:witness});
    demand(joined.status===statusPrefix+'_JOINED');
    return joined;
  }catch(error){
    // Keep the original domain/fence failure. A dying child may separately
    // fail to acknowledge cookie cleanup, so the host guard owns physical closure.
    await Promise.resolve().then(()=>controller.close()).catch(()=>{});
    throw error;
  }finally{
    signal?.removeEventListener('abort',cancelBrowser);
  }
}

async function runBoundedCertification(plan,dependencies,profile){
  const mode=profile?'p2-bounded-certification-profiled-current':'p2-bounded-certification';
  const terminalStatus=profile?'P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED':'P2_BOUNDED_CERTIFICATION_CONTAINED';
  const versionFields={version:profile?2:1,...(profile?{qualificationTargetProfile:profile}:{})};
  if(profile)requireQualificationTargetProfile(currentProfile,plan);
  const context=p2CertificationParentContext(plan),{prepared}=context;
  demand(dependencies.confirmation==='staging/'+plan.certificationActionId&&typeof dependencies.withEnvironmentLock==='function'&&typeof dependencies.getUrl==='function');
  if(plan.mode==='interactive-browser')demand(profile&&(plan.scopedAction.stage==='identity'||pairedBrowserStages.has(plan.scopedAction.stage))&&dependencies.interactiveController);
  const store=frontendReleaseReceiptStore(dependencies.directory);store.record('p2-certification-started.json',plan);
  if(dependencies.sourceCi)store.record('operator-source-ci.json',dependencies.sourceCi);
  bindP2CertificationReadyReceipts(context.frontendReceipts,plan);
  let phase='host-serialization';
  try{const outcome=await dependencies.withEnvironmentLock(async(verifyEnvironment,signal,host)=>{
    demand(host.mode===mode&&host.certificationActionId===plan.certificationActionId);
    const environment=async()=>{await dependencies.assertSource?.();demand(!signal.aborted);bindP2CertificationReadyReceipts(context.frontendReceipts,plan);await verifyEnvironment();};
    let terminal;
    await withP2CertificationFrontendSession(prepared,plan,{getUrl:dependencies.getUrl,verifyEnvironment:environment},async({client,verify,receipt,probe})=>{
      const withOwner=async task=>{await verify();await client.query(`SET ROLE "${prepared.plan.owner.name}"`);try{return await task();}finally{await client.query('RESET ROLE');await verify();}};
      const policy={environment:'staging',targetSha256:plan.targetSha256};
      const observe=async expectedEpoch=>withOwner(()=>observeFrontendDrain(client,policy,expectedEpoch));
      store.record('p2-certification-current-database.json',receipt);phase='all-three-current-and-existing-runtime';
      const current=await host.arm({receipt,probe});demand(current.status==='P2_CERTIFICATION_CURRENT_READY'&&current.runtimeReplaced===false&&current.sqlReplayed===false&&current.containers?.length===10);
      store.record('p2-certification-host-current.json',current);
      if(plan.mode==='interactive-browser'){
        phase=`interactive-${plan.scopedAction.stage}-held-browser-and-database`;
        const controller=dependencies.interactiveController;
        const {challenge}=readP2InteractiveBrowserControllerBinding(plan,controller);
        const stage=readP2CertificationInteractiveStage(await host.interactiveStage(controller),plan);
        const joined=await runP2InteractiveFrontendCase(plan,{stage,controller,client,withOwner,controllerChallenge:challenge,
          verifySession:verify,verifyEnvironment:environment,target:prepared.migration.job.target,
          ordinaryProducers:prepared.plan.producers,signal,identityEnrollmentEmail:dependencies.identityEnrollmentEmail,courseDraft:dependencies.courseDraft,
          record:(name,receipt)=>store.record(name,receipt)});
        requireQualificationTargetProfile(currentProfile,joined);
        terminal=await host.prepareClose(joined);
        demand(terminal.status===terminalStatus&&terminal.planSha256===plan.planSha256&&
          terminal.caseStatus===joined.status&&terminal.nativeDisabled===true&&terminal.sqlReplayed===false);
        store.record('p2-certification-close-prepared.json',terminal);
        return;
      }
      if(scopedModes.has(plan.mode)){
        phase='fixed-scoped-stage';
        const scopedOutcome=await runScopedCertificationCase(plan,{host,withOwner,verify,observe,client,policy});
        requireQualificationTargetProfile(currentProfile,scopedOutcome);
        terminal=await host.prepareClose(scopedOutcome);
        demand(terminal.status===terminalStatus&&terminal.planSha256===plan.planSha256&&terminal.caseStatus===scopedOutcome.status);
        store.record('p2-certification-close-prepared.json',terminal);
        return;
      }
      if(plan.mode==='direct-worker'){
        const workerPlan=context.workerPlan;demand(workerPlan===plan.workerPlan&&dependencies.workerPrivateResolvers);
        const stage=await host.workerEvidenceStage(workerPlan),workerDependencies={withOwner,verifyEnvironment:environment,verifySession:verify};
        phase='direct-worker-credential-preflight-closed';const credential=await preflightP2DirectLifecycleWorker(workerPlan,stage,dependencies.workerPrivateResolvers,client,workerDependencies);
        let opened,invocation;
        try{
          opened=await withOwner(()=>changeFrontendAdmission(client,policy,plan.initialEpoch,{newWork:false,recovery:true}));
          demand(opened.epoch===plan.nativePlan.initialEpoch);await host.gatewayStage('recovery');phase='one-direct-source-worker-request';
          invocation=await invokeP2DirectLifecycleWorker(workerPlan,credential,client,workerDependencies);
        }finally{
          if(opened){await verify();const actual=await observe(opened.epoch);demand(actual.epoch===opened.epoch&&actual.newWork===false&&actual.recovery===true);
            const closed=await withOwner(()=>changeFrontendAdmission(client,policy,opened.epoch,{newWork:false,recovery:false}));
            demand(closed.epoch===(BigInt(plan.initialEpoch)+2n).toString());await host.gatewayStage('closed');}
        }
        phase='direct-worker-domain-and-denial-join';const sourceDirectory=join(dependencies.directory,'worker-source');mkdirSync(sourceDirectory,{mode:0o700});
        const joined=await joinP2DirectLifecycleWorker(workerPlan,invocation,client,{...workerDependencies,directory:sourceDirectory});
        const artifact=readP2DirectWorkerSourceArtifact(workerPlan,joined);
        const methods=(await import('./p2-certification-transport.mjs')).readP2CertificationWorkerStage(stage,workerPlan);
        const retained=await methods.retainJoined(joined);demand(retained.status==='P2_DIRECT_WORKER_JOINED_RETAINED');
        terminal=await host.prepareClose({...versionFields,status:'P2_CERTIFICATION_DIRECT_WORKER_JOINED',workerPlanSha256:p2NativeHash(workerPlan),
          workerSourceArtifactSha256:artifact.recordSha256,workerMachineArtifactSha256:retained.privateRecordSha256});
        demand(terminal.status===terminalStatus&&terminal.planSha256===plan.planSha256);
        store.record('p2-certification-close-prepared.json',terminal);return;
      }
      if(['auth-preparation','browser-pending'].includes(plan.mode)){
        const source=browserSessions.get(dependencies.browserSession);
        demand(source&&source.active&&source[plan.mode==='auth-preparation'?'authPlan':'browserPlan']===plan);
        const binding=readP2LifecycleBrowserControllerBinding(source.suspensionPlan,source.controller);
        demand(binding.challenge===source.challenge);
        validateP2CanonicalBrowserObservation(source.suspensionPlan,current.browserOrigin,profile);
        if(plan.mode==='browser-pending')demand(source.authenticationCompleted===true&&plan.startState==='already-closed');
        phase=plan.mode==='auth-preparation'?'bounded-normal-authentication':'bounded-browser-pending';
        const opened=await withOwner(()=>changeFrontendAdmission(client,policy,plan.initialEpoch,{newWork:true,recovery:false}));
        demand(opened.epoch===(BigInt(plan.initialEpoch)+1n).toString());await host.gatewayStage('browser');
        let caseOutcome;
        let cancelSource;
        const cancelled=new Promise((_,reject)=>{cancelSource=()=>{void source.controller.close();reject(new Error('P2_CERTIFICATION_BROWSER_PARENT_LOST'));};signal.addEventListener('abort',cancelSource,{once:true});});
        const deadlineTimer=setTimeout(cancelSource,plan.maximumSeconds*1000);
        const guarded=task=>Promise.race([Promise.resolve().then(task),cancelled]);
        try{await guarded(async()=>{
          if(plan.mode==='auth-preparation'){
            const authStage=await host.authenticationStage(source.suspensionPlan,source.controller);
            await source.controller.beginAuthentication(authStage);
            const authentication=readP2LifecycleBrowserAuthentication(source.suspensionPlan,await source.controller.authenticated());
            demand(authentication.customerAuthenticated===true&&authentication.ownerFresh===true&&Date.now()-Date.parse(authentication.observedAt)>=0&&Date.now()-Date.parse(authentication.observedAt)<=5000);await verify();
            caseOutcome={version:1,status:'P2_CERTIFICATION_AUTHENTICATION_PREPARED',browserPlanSha256:p2NativeHash(source.suspensionPlan)};
          }else{
            const authentication=readP2LifecycleBrowserAuthentication(source.suspensionPlan,await source.controller.recheckAuthenticated());
            demand(authentication.customerAuthenticated===true&&authentication.ownerFresh===true&&Date.now()-Date.parse(authentication.observedAt)>=0&&Date.now()-Date.parse(authentication.observedAt)<=5000);await verify();
            const stage=await host.suspensionEvidenceStage(source.suspensionPlan,source.controller);
            await source.controller.start(stage);
            const controlled=await captureP2SuspensionControlledAuthority(source.suspensionPlan,stage);
            await source.controller.suspend(controlled);
            const naturalPromise=observeP2SuspensionControlledAuthority(source.suspensionPlan,controlled);
            const browserPromise=source.controller.complete();
            const [natural,browser]=await Promise.all([naturalPromise,browserPromise]);await verify();
            const pendingDirectory=join(dependencies.directory,'pending');mkdirSync(pendingDirectory,{mode:0o700});
            const pending=await captureP2SuspensionPending(source.suspensionPlan,browser,natural,client,{verifyEnvironment:environment,verifySession:verify,directory:pendingDirectory});
            const methods=(await import('./p2-certification-transport.mjs')).readP2CertificationSuspensionStage(stage,source.suspensionPlan);
            const retainedBrowser=await methods.retain(browser),retainedPending=await methods.capturePending(pending);
            demand(retainedBrowser.status==='P2_SUSPENSION_BROWSER_RETAINED'&&retainedPending.status==='P2_SUSPENSION_PENDING_RETAINED');
            caseOutcome={version:1,status:'P2_CERTIFICATION_BROWSER_PENDING_CAPTURED',browserPlanSha256:p2NativeHash(source.suspensionPlan),
              browserRecordSha256:retainedBrowser.recordSha256,pendingRecordSha256:retainedPending.recordSha256,workerInvoked:false};
          }
        });
        }finally{
          clearTimeout(deadlineTimer);signal.removeEventListener('abort',cancelSource);
          await verify();const actual=await observe(opened.epoch);demand(actual.epoch===opened.epoch&&actual.newWork===true&&actual.recovery===false&&actual.uncertain===0);
          const closed=await withOwner(()=>changeFrontendAdmission(client,policy,opened.epoch,{newWork:false,recovery:false}));
          demand(closed.epoch===(BigInt(plan.initialEpoch)+2n).toString());await host.gatewayStage('closed');
          const deadline=performance.now()+source.suspensionPlan.drainSeconds*1000;
          while(true){await verify();const actual=await observe(closed.epoch),gateway=await host.observeGateway();
            demand(actual.newWork===false&&actual.recovery===false&&actual.uncertain===0&&gateway.newWork===false&&gateway.recovery===false&&
              ['newWork','recovery'].every(key=>gateway.uncertain?.[key]===0));
            if(actual.active===0&&['newWork','recovery'].every(key=>gateway.active?.[key]===0))break;
            demand(performance.now()<deadline);await pause(250);
          }
        }
        terminal=await host.prepareClose(caseOutcome);demand(terminal.status===terminalStatus&&terminal.planSha256===plan.planSha256);
        store.record('p2-certification-close-prepared.json',terminal);
        return;
      }
      let nativePlan=plan.nativePlan,caseOutcome,requestArtifact;
      const nativeDirectory=join(dependencies.directory,'native');mkdirSync(nativeDirectory,{mode:0o700});
      const collect=async(selected,epoch)=>{
        demand(selected.planSha256===nativePlan.planSha256);
        const deadline=performance.now()+120_000;
        while(!existsSync(context.requestEvidence.path)){
          await verify();demand(performance.now()<deadline);demand((await host.nativeControl.observeMetadata(nativePlan)).nativeEnabled===false);
          await pause(Math.min(1000,deadline-performance.now()));
        }
        const rows=collectP2CertificationRequestDetails(nativePlan,epoch,context.requestEvidence,{directory:dependencies.directory,certificationActionId:plan.certificationActionId});
        const evidenceDirectory=join(dependencies.directory,'native-request-evidence');
        const provenance=JSON.parse(readFrontendReleaseEvidence(evidenceDirectory,'p2-native-request-evidence-provenance.json'));
        const bytes=readFrontendReleaseEvidence(evidenceDirectory,provenance.artifactReceipt);demand(rawHash(bytes)===provenance.artifactSha256);requestArtifact=bytes.toString('base64');return rows;
      };
      const nativeInput={client,verifyEnvironment:environment,verifySession:verify,withOwner,nativeControl:host.nativeControl,confirmation:'staging/'+plan.originalReleaseId};
      if(plan.mode==='contain-native'){
        demand(typeof context.requestEvidence?.originalNativeDirectory==='string');phase='explicit-native-containment';
        caseOutcome=await containP2LifecycleNative({...nativeInput,plan:nativePlan,directory:nativeDirectory,originalDirectory:context.requestEvidence.originalNativeDirectory,expectedEpoch:plan.initialEpoch});
        await host.gatewayStage('closed');
      }else{
        phase='close-new-work-and-drain';let closedEpoch=plan.initialEpoch;
        if(plan.startState==='qualified-ready'){
          const closed=await withOwner(()=>changeFrontendAdmission(client,policy,plan.initialEpoch,{newWork:false,recovery:false}));closedEpoch=closed.epoch;
          demand(closedEpoch===(BigInt(plan.initialEpoch)+1n).toString());store.record('p2-certification-initial-closed.json',closed);
        }
        await host.gatewayStage('closed');const deadline=performance.now()+nativePlan.drainSeconds*1000;let closed;
        do{
          await verify();closed=await observe(closedEpoch);const gateway=await host.observeGateway();
          demand(closed.newWork===false&&closed.recovery===false&&closed.uncertain===0&&gateway.newWork===false&&gateway.recovery===false&&
            ['newWork','recovery'].every(key=>gateway.uncertain?.[key]===0));
          if(closed.active===0&&['newWork','recovery'].every(key=>gateway.active?.[key]===0))break;
          demand(performance.now()<deadline);await pause(Math.min(1000,deadline-performance.now()));
        }while(true);
        nativePlan=deriveP2CertificationNativePlan(plan,closed);store.record('p2-certification-closed-drained.json',closed);
        phase='recovery-only-stage';const recovery=await withOwner(()=>changeFrontendAdmission(client,policy,closedEpoch,{newWork:false,recovery:true}));
        demand(recovery.epoch===nativePlan.initialEpoch);store.record('p2-certification-recovery-only.json',recovery);await host.gatewayStage('recovery');
        const invoke=()=>qualifyP2LifecycleNative({...nativeInput,plan:nativePlan,directory:nativeDirectory,observeNativeRequests:collect});
        if(plan.mode==='known-ack-recovery'){
          const faultPlan=prepareP2LifecycleTransportFaultPlan(nativePlan,context.faultInput,profile),hostStage=await host.prepareFault(faultPlan);
          phase='reviewed-known-ack-drop-replay-settlement-replacement';
          caseOutcome=await runKnownAckCase(plan,nativePlan,host,faultPlan,hostStage,client,verify,withOwner,dependencies.directory);
        }else if(plan.mode==='native-window'){phase='bounded-actual-native-window';caseOutcome=await invoke();}
        else{
          const faultInput=context.faultInput;demand(faultInput);
          const faultPlan=prepareP2LifecycleTransportFaultPlan(nativePlan,faultInput,profile),hostStage=await host.prepareFault(faultPlan);
          const faultDirectory=join(dependencies.directory,'fault');mkdirSync(faultDirectory,{mode:0o700});phase='bounded-known-transport-fault';
          try{caseOutcome=await runP2LifecycleTransportFault({plan:faultPlan,client,withOwner,verifyEnvironment:environment,verifySession:verify,hostStage,nativeControl:host.nativeControl,
            directory:faultDirectory,confirmation:'staging/'+faultPlan.actionId,exercise:invoke,...(profile?{frontendProbe:probe}:{}),
            containFrontend:async()=>{const actual=await readP2CertificationCurrent(client,prepared,plan,verify,false,profile);return{frontendAdmissionClosed:actual.admission.newWork===false&&actual.admission.recovery===false};}},profile);}
          catch(error){demand(plan.mode==='fault-drop-after-ack'&&error.publicReceipt?.outstandingUncertain===1);caseOutcome=error.publicReceipt;}
        }
        if(!profile||plan.mode!=='known-ack-recovery')await host.gatewayStage('closed');
      }
      phase='fresh-contained-terminal';await verify();
      terminal=await host.prepareClose(caseOutcome,requestArtifact);demand(terminal?.status===terminalStatus&&terminal.planSha256===plan.planSha256&&terminal.nativeDisabled===true&&terminal.sqlReplayed===false&&terminal.runtimeReplaced===(plan.mode==='known-ack-recovery'));
      store.record('p2-certification-close-prepared.json',terminal);
    },profile);
    if(profile)requireQualificationTargetProfile(currentProfile,terminal);
    // The physical session is now actually closed. The host retains its real
    // environment lock while joining these exact immutable terminal bytes.
    if(!profile)store.record('p2-certification-outcome.json',terminal);
    await host.finish(terminal);return terminal;
  });
    if(profile)store.record('p2-certification-outcome.json',outcome);
    return outcome;
  }catch{
    try{store.record('p2-certification-outcome.json', {...versionFields,status:'P2_BOUNDED_CERTIFICATION_REQUIRES_REVIEW',planSha256:plan.planSha256,phase,
      certificationActionId:plan.certificationActionId,nativeDisabled:null,frontendAdmissionClosed:null,gatewayAdmissionClosed:null,runtimeStopped:null,trafficAuthorized:null,sqlReplayed:false});}catch{/* Preserve exclusive prior evidence. */}
    throw new Error('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW');
  }
}

function privateBytes(path,maximum=2_000_000){
  demand(typeof path==='string'&&resolve(path)===path&&realpathSync(path)===path);frontendPrivateReceiptDirectory(dirname(path));
  const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=fstatSync(descriptor);demand(info.isFile()&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size>0&&info.size<=maximum);
    const bytes=readFileSync(descriptor);demand(bytes.length===info.size);return bytes;
  }finally{closeSync(descriptor);}
}
function privateObject(path,maximum){const value=JSON.parse(privateBytes(path,maximum));demand(value&&typeof value==='object'&&!Array.isArray(value));return value;}

function prepareProfiledCertification(settings){
  const extra=settings?.certification?.mode==='browser-pending'?['browser','authPreparation']
    :settings?.certification?.mode==='direct-worker'?['worker']
      :settings?.certification?.mode==='interactive-browser'&&pairedBrowserStages.has(settings.certification.scopedAction?.stage)?['interactiveIdentity']:[];
  demand(exactKeys(settings,['version','environment','qualificationTargetProfile','operatorSourceCommit','releaseSettings','certification',...extra])&&
    settings.version===2&&settings.environment==='staging');
  requireQualificationTargetProfile(currentProfile,settings);
  const original=prepareP2ProfiledCurrentRelease(settings.releaseSettings), release=original.plan;
  demand(settings.operatorSourceCommit===release.sourceCommit);
  const directory=join(settings.releaseSettings.results,release.releaseId);
  const frontend=join(directory,'frontend'), frontendReceipts=join(frontend,'vercel');
  const retainedPlan=decodeQualificationTargetJson(readFrontendReleaseEvidence(directory,'reviewed-plan.json'),'carrier');
  demand(isDeepStrictEqual(retainedPlan,release));
  const raw=readFrontendReleaseEvidence(frontend,'p2-profiled-current-host-outcome.json');
  const receipt=decodeQualificationTargetJson(raw,'carrier');
  requireQualificationTargetProfile(currentProfile,receipt);
  const identity=['environment','releaseId','sourceCommit','candidateSha256','targetSha256','inventorySha256','contractPhase','phase2ContractManifestSha256'];
  const flags=['frontendSqlApplied','historicalProviderClosureClaimed','oldP200Qualified','nativeSchedulesEnabled','trafficAuthorized','releaseAccepted'];
  const pins=['frontendDatabaseReceiptSha256','frontendTerminalSha256','frontendContinuationCompletedSha256','frontendReleaseOutcomeSha256',
    'frontendSessionClosedSha256','frontendWorkloadReceiptSha256','apiRuntimeReceiptSha256','migrationOutcomeSha256'];
  demand(exactKeys(receipt,['version','qualificationTargetProfile','status','configurationSha256',...identity,...flags,...pins])&&
    receipt.version===2&&receipt.status==='P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION'&&identity.every(key=>receipt[key]===release[key])&&
    isDeepStrictEqual(receipt.configurationSha256,release.configurationSha256)&&flags.every(key=>receipt[key]===false)&&pins.every(key=>sha(receipt[key])));
  const input={...settings.certification,operatorSourceCommit:settings.operatorSourceCommit};
  demand(input.gatewayConfigurationSha256===release.configurationSha256['gateway.json']&&
    input.native?.configurationRecordSha256===receipt.frontendWorkloadReceiptSha256&&
    input.readyReceiptSha256?.['frontend-workload-outcome.json']===receipt.frontendWorkloadReceiptSha256);
  const candidateBytes=readFrontendReleaseEvidence(directory,'release.candidate.json');
  demand(rawHash(candidateBytes)===release.candidateSha256);
  const profiledRelease={receiptSha256:rawHash(raw),planSha256:rawHash(release),apiJobSha256:release.apiJobSha256,apiJobs:original.apiJobs,
    configurationDirectory:settings.releaseSettings.host.configuration};
  const stages=prepareCertificationStages({migration:original.migration,plan:original.inventory},input,candidateBytes,settings,
    {frontendReceipts,configurationSha256:release.configurationSha256,profiledRelease},currentProfile);
  return {...stages,original,frontendReceipts,originalReleaseReceipt:raw};
}

export function prepareP2ProfiledCertificationOperator(settings){
  const {plan,authPlan,identityPlan}=prepareProfiledCertification(settings);
  if(identityPlan){
    const stage=plan.scopedAction.stage;
    return {version:2,qualificationTargetProfile:currentProfile,status:`P2_INTERACTIVE_${stage.toUpperCase().replaceAll('-','_')}_ACTIONS_PLANNED`,
      identity:identityPlan,[stage]:plan};
  }
  return authPlan?{version:2,qualificationTargetProfile:currentProfile,status:'P2_BROWSER_CERTIFICATION_ACTIONS_PLANNED',authentication:authPlan,browser:plan}:plan;
}

function profiledCertificationHostPlan(settings,authentication=false){
  const checked=prepareProfiledCertification(settings);
  const plan=authentication?(checked.authPlan??checked.identityPlan):checked.plan;
  demand(plan);
  const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const source=committedProfiledCurrentOperatorSource(root,plan.operatorSourceCommit);
  return bindProfiledCertificationHostPlan(settings,checked,source,plan);
}

function bindProfiledCertificationHostPlan(settings,checked,source,plan){
  const {suspensionPlan,original,frontendReceipts,originalReleaseReceipt}=checked;
  const sourceSha256=Object.fromEntries(source.files.map(file=>[file.path,file.sha256]));
  const sourceClosureSha256=rawHash(JSON.stringify(Object.entries(sourceSha256).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  demand(sourceClosureSha256===plan.operatorSourceClosureSha256);
  const readyReceipts=Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name=>{
    const bytes=readFrontendReleaseEvidence(frontendReceipts,name);
    demand(rawHash(bytes)===plan.readyReceiptSha256[name]);
    return [name,bytes.toString('base64')];
  }));
  const {plan:release,inventory,migration}=original;
  const {machineId:hostMachineId,bundle,configuration,results}=settings.releaseSettings.host;
  return {version:2,qualificationTargetProfile:currentProfile,environment:'staging',mode:'p2-bounded-certification-profiled-current',
    sourceCommit:plan.operatorSourceCommit,sourceSha256,sourceClosureSha256,hostMachineId,bundle,configuration,results,
    candidate:migration.candidate,candidateSha256:release.candidateSha256,configurationSha256:release.configurationSha256,
    apiJobSha256:release.apiJobSha256,frontendJob:migration.job,frontendBaseline:migration.baseline,targetSha256:release.targetSha256,
    owner:inventory.owner,inventory,inventorySha256:release.inventorySha256,certification:release.certification,
    expectedWriterAdmissionBinding:release.writerAdmissionBinding,certificationActionId:plan.certificationActionId,certificationPlan:plan,
    originalReleaseReceipt:originalReleaseReceipt.toString('base64'),readyReceipts,
    ...(suspensionPlan?{sourceSuspensionPlan:suspensionPlan}:{})};
}

function prepareCertificationStages(prepared,input,candidateBytes,settings,options,profile){
  const {candidate,job}=prepared.migration;
  let suspensionPlan,authPlan,identityPlan;
  const prepareSuspension=source=>{
    const selected=prepareP2LifecycleSuspensionPlan(candidate,source,profile);
    if(profile){
      const retained=source.persistencePlan;
      const jobs={frontend:job,...options.profiledRelease.apiJobs};
      demand(retained.hostMachineId===settings.releaseSettings.host.machineId&&
        isDeepStrictEqual(source.owner,input.native.owner)&&isDeepStrictEqual(source.producer,input.native.producer)&&
        selected.deploymentId===input.native.deploymentId&&selected.deploymentUrl===input.native.deploymentUrl&&
        selected.configurationRecordSha256===input.native.configurationRecordSha256&&
        selected.candidateSha256===rawHash(candidateBytes)&&selected.configurationSha256===p2NativeHash(options.configurationSha256)&&
        retained.operatorSourceSha256===input.operatorSourceClosureSha256&&retained.originalReleaseSha256===options.profiledRelease.receiptSha256&&
        retained.frontendDeploymentSha256===input.readyReceiptSha256['frontend-promotion-outcome.json']&&
        retained.targets.frontend.runtimeRoleOid===input.native.producer.role.oid&&
        Object.entries(jobs).every(([service,job])=>['host','port','database','serverMajor'].every(key=>retained.targets[service][key]===job.target[key])&&
          retained.targets[service].runtimeRole===(service==='frontend'?job.target.runtimeRole:job.runtimeRole))&&
        ['course','community'].every(service=>retained.containerImages[service]===candidate.artifacts[service+'Runtime'].image));
    }
    return selected;
  };
  if(input.mode==='direct-worker'){
    demand(settings.worker&&input.worker&&(!profile||exactKeys(settings.worker,['suspensionInput'])));
    const selected=prepareSuspension(settings.worker.suspensionInput);
    demand((!profile||selected.actionId!==input.certificationActionId)&&
      (input.worker.suspensionPlan===undefined||isDeepStrictEqual(input.worker.suspensionPlan,selected)));
    suspensionPlan=selected;
    input.worker={...input.worker,suspensionPlan:selected};
  }
  if(input.mode==='browser-pending'){
    demand(settings.browser&&settings.authPreparation&&input.startState==='already-closed'&&(!profile||exactKeys(settings.browser,['input'])));
    suspensionPlan=prepareSuspension(settings.browser.input);
    demand(suspensionPlan.actionId===input.certificationActionId&&suspensionPlan.candidateSha256===rawHash(candidateBytes)&&
      suspensionPlan.targetSha256===prepared.plan.targetSha256&&suspensionPlan.deploymentId===input.native.deploymentId&&
      suspensionPlan.configurationRecordSha256===input.native.configurationRecordSha256&&suspensionPlan.configurationSha256===p2NativeHash(options.configurationSha256));
    input.browserPlanSha256=p2NativeHash(suspensionPlan);
    const auth=settings.authPreparation;
    demand(isDeepStrictEqual(Object.keys(auth).sort(),['certificationActionId','initialEpoch','startState'])&&
      input.initialEpoch===(BigInt(auth.initialEpoch)+2n).toString()&&auth.certificationActionId!==input.certificationActionId);
    authPlan=prepareP2BoundedCertification(prepared,{...input,...auth,mode:'auth-preparation'},candidateBytes,options);
  }else demand(input.mode!=='auth-preparation');
  const plan=prepareP2BoundedCertification(prepared,input,candidateBytes,options);
  if(input.mode==='interactive-browser'&&pairedBrowserStages.has(input.scopedAction.stage)){
    const identity=settings.interactiveIdentity;
    demand(profile&&exactKeys(identity,['certificationActionId','initialEpoch','windowSeconds'])&&
      typeof identity.initialEpoch==='string'&&/^[1-9][0-9]{0,17}$/u.test(identity.initialEpoch)&&
      BigInt(identity.initialEpoch)+2n===BigInt(plan.initialEpoch)&&identity.certificationActionId!==plan.certificationActionId&&
      settings.authPreparation===undefined&&settings.browser===undefined&&settings.worker===undefined);
    const {actorId}=input.scopedAction;
    const actorKind=['authoring','paid-grant'].includes(input.scopedAction.stage)?'admin':
      input.scopedAction.stage==='learning'?'customer':input.scopedAction.frontendAction.actorKind;
    identityPlan=prepareP2BoundedCertification(prepared,{...input,certificationActionId:identity.certificationActionId,initialEpoch:identity.initialEpoch,
      scopedAction:{stage:'identity',actorId:null,requests:[],windowSeconds:identity.windowSeconds,identityActor:{actorKind,actorId}}},candidateBytes,options);
  }else demand(settings.interactiveIdentity===undefined);
  return {plan,authPlan,identityPlan,suspensionPlan};
}

export function prepareP2CertificationOperator(settings){
  demand(settings?.version===1&&settings.environment==='staging'&&commit(settings.operatorSourceCommit));
  const candidateBytes=privateBytes(join(settings.bundle,'release.candidate.json')),candidate=JSON.parse(candidateBytes);
  const original=prepareP2OperatorRelease({...settings,sourceCommit:candidate.sources.frontend.commit});demand(original.prepared&&original.roles===undefined);
  const input={...settings.certification,operatorSourceCommit:settings.operatorSourceCommit};
  const {plan,authPlan,suspensionPlan}=prepareCertificationStages(original.prepared,input,candidateBytes,settings,
    {frontendReceipts:settings.frontendReceipts,configurationSha256:original.configurationSha256});
  frontendPrivateReceiptDirectory(settings.results);
  demand(lstatSync(join(settings.results,plan.certificationActionId),{throwIfNoEntry:false})===undefined);
  if(authPlan)demand(lstatSync(join(settings.results,authPlan.certificationActionId),{throwIfNoEntry:false})===undefined);
  return{plan,authPlan,suspensionPlan,original,candidateBytes};
}

export async function p2ProfiledCertificationOperator(settings,{confirmation}={}){
  demand(process.versions.node.split('.')[0]==='24');
  const {execution,...selection}=settings;
  const checked=prepareProfiledCertification(selection);
  const {plan,authPlan,identityPlan,suspensionPlan,original}=checked;
  const interactive=plan.mode==='interactive-browser'&&pairedBrowserStages.has(plan.scopedAction.stage)&&identityPlan!==undefined;
  const authoring=interactive&&plan.scopedAction.stage==='authoring';
  const paidGrant=interactive&&plan.scopedAction.stage==='paid-grant';
  if(interactive&&plan.scopedAction.stage==='learning')demand(execution===undefined);
  const paidGrantReason=paidGrant?reviewedPaidGrantReason(plan.scopedAction,execution):undefined;
  const enrollment=plan.mode==='interactive-browser'&&plan.scopedAction.stage==='identity'&&plan.scopedAction.identityEnrollment;
  const scoped=scopedModes.has(plan.mode)||interactive||!!enrollment;
  demand(confirmation==='staging/'+plan.certificationActionId&&
    (scoped||['contain-native','native-window','browser-pending','direct-worker','fault-before-upstream'].includes(plan.mode)));
  let identityEnrollmentEmail,authoringDraft;
  if(enrollment){
    demand(exactKeys(execution,['identityEnrollmentEmail']));
    identityEnrollmentEmail=validateP2InteractiveEnrollmentEmail(enrollment,execution.identityEnrollmentEmail);
  }
  if(authoring){
    const {field,validate}=authoringCases.get(plan.scopedAction.authoringAction.operation);
    demand(field?exactKeys(execution,[field]):execution===undefined);
    authoringDraft=validate(authoringSelection(plan.scopedAction),field?execution[field]:undefined);
  }
  demand(plan.mode!=='mux-callback-recovery'||original.migration.candidate.sources.course.commit===scopedMuxCourseSource);
  const releaseSettings=selection.releaseSettings;
  const directory=releaseSettings.results;
  frontendPrivateReceiptDirectory(directory);
  for(const action of [plan,authPlan,identityPlan].filter(Boolean)){
    demand(lstatSync(join(directory,action.certificationActionId),{throwIfNoEntry:false})===undefined);
  }
  verifyP2ProfiledCurrentReleaseConfiguration(original);
  const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const source=committedProfiledCurrentOperatorSource(root,plan.operatorSourceCommit);
  const packet=bindProfiledCertificationHostPlan(selection,checked,source,plan);
  const authPacket=authPlan?bindProfiledCertificationHostPlan(selection,checked,source,authPlan):null;
  const identityPacket=identityPlan?bindProfiledCertificationHostPlan(selection,checked,source,identityPlan):null;
  const needsPersistence=['browser-pending','direct-worker'].includes(plan.mode)||persistenceModes.has(plan.mode);
  let persistenceReviewed;
  if(needsPersistence){
    const privateWitness=plan.mode==='lifecycle-persistence';
    demand(exactKeys(execution,privateWitness?['persistenceReviewed','persistenceWitness']:['persistenceReviewed']));
    persistenceReviewed=execution.persistenceReviewed;
    requireQualificationTargetProfile(currentProfile,persistenceReviewed,persistenceReviewed?.plan);
    demand(persistenceReviewed.version===2&&persistenceReviewed.environment==='staging'&&
      isDeepStrictEqual(persistenceReviewed.operatorSourceFiles,packet.sourceSha256)&&
      p2NativeHash(persistenceReviewed.containers)===plan.runtimeInventorySha256);
    if(persistenceModes.has(plan.mode)){
      const reviewed=persistenceReviewed.plan;
      demand(p2NativeHash(persistenceReviewed)===plan.persistenceReviewedSha256&&reviewed.environment==='staging'&&
        reviewed.releaseId===plan.originalReleaseId&&reviewed.candidateSha256===plan.candidateSha256&&
        reviewed.configurationSha256===plan.configurationCanonicalSha256&&reviewed.sources.frontend===plan.sourceCommit&&
        reviewed.originalReleaseSha256===plan.originalReleaseReceiptSha256&&
        reviewed.frontendDeploymentSha256===plan.readyReceiptSha256['frontend-promotion-outcome.json']&&
        reviewed.operatorSourceSha256===plan.operatorSourceClosureSha256);
      if(privateWitness)demand(execution.persistenceWitness?.stage===plan.scopedAction.stage);
    }else{
      const reviewed=plan.mode==='browser-pending'?selection.browser.input.persistencePlan:selection.worker.suspensionInput.persistencePlan;
      demand(isDeepStrictEqual(persistenceReviewed.plan,reviewed));
    }
  }else if(!enrollment&&!authoring&&!paidGrant)demand(execution===undefined);
  const sourceCi=await verifyOperatorCi({api:githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit:plan.operatorSourceCommit,branch:source.branch,workflowBytes:source.workflowBytes});
  const provider=decodeQualificationTargetJson(privateBytes(releaseSettings.providerContext,24_000_000),'private-packet');
  requireQualificationTargetProfile(currentProfile,provider);
  const needsRuntimeUrl=['direct-worker','lifecycle-persistence'].includes(plan.mode);
  demand(provider.version===2&&typeof provider.vercelToken==='string'&&provider.vercelToken.length>0&&provider.vercelToken.length<=8192&&
    (!needsRuntimeUrl||typeof provider.frontendRuntimeDatabaseUrl==='string'&&provider.frontendRuntimeDatabaseUrl.length>0&&provider.frontendRuntimeDatabaseUrl.length<=8192));
  const scopedCronSecret=scoped?readP2LifecycleWorkerCronSecret(createP2LifecycleWorkerPrivateResolvers(()=>provider)):undefined;
  const credentials=Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL','COURSE_STAGING_DATABASE_URL','COMMUNITY_STAGING_DATABASE_URL'].map(key=>{
    const value=process.env[key];demand(typeof value==='string'&&value.length>0&&value.length<=16384);return[key,value];}));
  let privateProbe;
  if(plan.mode!=='contain-native'&&!scoped){
    const path=join(directory,plan.originalReleaseId,'frontend','vercel-private','frontend-probe-private.json');
    privateProbe=decodeQualificationTargetJson(privateBytes(path,8192),'carrier');
    requireQualificationTargetProfile(currentProfile,privateProbe);
    demand(privateProbe.version===2&&privateProbe.environment==='staging'&&privateProbe.releaseId===plan.originalReleaseId&&
      privateProbe.sourceCommit===plan.sourceCommit&&privateProbe.projectId===packet.candidate.workload.projectId&&
      typeof privateProbe.secret==='string'&&/^[a-f0-9]{64}$/u.test(privateProbe.secret)&&
      Number.isSafeInteger(privateProbe.expiresAt)&&Date.now()<privateProbe.expiresAt&&privateProbe.expiresAt<=Date.now()+3_600_000);
  }
  const diagnostics=join(directory,plan.certificationActionId+'-ssh');mkdirSync(diagnostics,{mode:0o700});
  const ssh=await recreationSsh({knownHosts:releaseSettings.knownHosts,keyFile:releaseSettings.sshKey,diagnostics});
  demand((await ssh.machine()).machineId===releaseSettings.host.machineId);
  const installed=await ssh.installProfiledCurrentSource({commit:plan.operatorSourceCommit,files:source.files});
  demand(installed.status==='EXACT_OPERATOR_SOURCE_INSTALLED'&&installed.commit===plan.operatorSourceCommit);
  const execute=async(action,reviewedPacket,browserSource,interactiveController)=>{
    const results=join(directory,action.certificationActionId);mkdirSync(results,{mode:0o700});
    const actionConfirmation='staging/'+action.certificationActionId;
    const initial={...reviewedPacket,confirmation:actionConfirmation,credentials,vercelToken:provider.vercelToken,
      ...(privateProbe?{privateProbe}:{}),...(browserSource?{sourceParentChallenge:browserSource.challenge}:{}),
      ...(interactiveController?{interactiveController:readP2InteractiveBrowserControllerBinding(action,interactiveController)}:{}),
      ...(scoped?{scopedCronSecret}:{}),
      ...(action.mode==='browser-pending'?{persistenceReviewed,browserResources:selection.browser.input.resources}:{}),
      ...(action.mode==='direct-worker'||persistenceModes.has(action.mode)?{persistenceReviewed}:{}),
      ...(action.mode==='lifecycle-persistence'?{persistencePrivate:{
        frontendRuntimeDatabaseUrl:provider.frontendRuntimeDatabaseUrl,witness:execution.persistenceWitness,
      }}:{})};
    return runBoundedCertification(action,{directory:results,confirmation:actionConfirmation,sourceCi,browserSession:browserSource?.handle,
      interactiveController,...(enrollment?{identityEnrollmentEmail}:{}),
      ...(courseBackedBrowserStages.has(action.scopedAction?.stage)?{courseDraft:{job:original.apiJobs.course,draft:authoringDraft,paidGrantReason,
        readCourseDatabaseUrl:()=>credentials.COURSE_STAGING_DATABASE_URL}}:{}),
      getUrl:()=>credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
      ...(action.mode==='direct-worker'?{workerPrivateResolvers:createP2LifecycleWorkerPrivateResolvers(()=>provider)}:{}),
      assertSource:()=>assertSourceCheckout(root,plan.operatorSourceCommit),
      withEnvironmentLock:p2CertificationEnvironmentLock(releaseSettings,initial,results,{expectedProfile:currentProfile})},currentProfile);
  };
  if(enrollment){
    const controller=await launchP2InteractiveBrowserRecorder(plan);
    try{
      await controller.initialized();
      return await execute(plan,packet,undefined,controller);
    }finally{await controller.close();}
  }
  if(interactive){
    const controller=await launchP2InteractiveBrowserRecorder(identityPlan);
    try{
      await controller.initialized();
      const authenticated=await execute(identityPlan,identityPacket,undefined,controller);
      const admission=authenticated.frontendAdmission;
      demand(authenticated.caseStatus==='P2_INTERACTIVE_IDENTITY_JOINED'&&admission.epoch===plan.initialEpoch&&
        admission.active===0&&admission.uncertain===0&&admission.newWork===false&&admission.recovery===false);
      await controller.selectPlan(plan);
      return await execute(plan,packet,undefined,controller);
    }finally{await controller.close();}
  }
  if(!authPlan)return execute(plan,packet);
  const browserDirectory=join(directory,plan.certificationActionId+'-browser-source');mkdirSync(browserDirectory,{mode:0o700});
  const controller=launchP2LifecycleBrowserRecorder(suspensionPlan,browserDirectory),binding=readP2LifecycleBrowserControllerBinding(suspensionPlan,controller);
  const handle=Object.freeze({}),browserSource={handle,controller,challenge:binding.challenge,suspensionPlan,authPlan,browserPlan:plan,active:true,authenticationCompleted:false};
  browserSessions.set(handle,browserSource);
  try{
    await controller.initialized();
    const authenticated=await execute(authPlan,authPacket,browserSource);
    demand(authenticated.caseStatus==='P2_CERTIFICATION_AUTHENTICATION_PREPARED'&&authenticated.frontendAdmission.epoch===plan.initialEpoch&&
      authenticated.frontendAdmission.active===0&&authenticated.frontendAdmission.uncertain===0&&
      authenticated.frontendAdmission.newWork===false&&authenticated.frontendAdmission.recovery===false);
    browserSource.authenticationCompleted=true;
    return await execute(plan,packet,browserSource);
  }finally{browserSource.active=false;await controller.close();}
}

export async function p2CertificationOperator(settings,{apply=false,confirmation}={}){
  demand(process.versions.node.split('.')[0]==='24');const checked=prepareP2CertificationOperator(settings);
  if(!apply)return checked.authPlan?{version:1,status:'P2_BROWSER_CERTIFICATION_ACTIONS_PLANNED',authentication:checked.authPlan,browser:checked.plan}:checked.plan;
  demand(confirmation==='staging/'+checked.plan.certificationActionId);
  const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),source=committedOperatorSource(root,settings.operatorSourceCommit);
  const sourceCi=await verifyOperatorCi({api:githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),sourceCommit:settings.operatorSourceCommit,branch:source.branch,workflowBytes:source.workflowBytes});
  const sourceSha256=Object.fromEntries(source.files.map(file=>[file.path,file.sha256]));
  const sourceClosureSha256=rawHash(JSON.stringify(Object.entries(sourceSha256).sort(([a],[b])=>a<b?-1:a>b?1:0)));
  demand(sourceClosureSha256===checked.plan.operatorSourceClosureSha256);
  const context=privateObject(settings.providerContext,24_000_000);demand(typeof context.vercelToken==='string'&&context.vercelToken.length>0&&context.vercelToken.length<=8192);
  const credentials=Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL','COURSE_STAGING_DATABASE_URL','COMMUNITY_STAGING_DATABASE_URL'].map(key=>{
    const value=process.env[key];demand(typeof value==='string'&&value.length>0&&value.length<=16384);return[key,value];}));
  let privateProbe;
  if(checked.plan.mode!=='contain-native'){
    demand(typeof context.privateConfigurationDirectory==='string');frontendPrivateReceiptDirectory(context.privateConfigurationDirectory);
    privateProbe=privateObject(join(context.privateConfigurationDirectory,'frontend-probe-private.json'),8192);
    demand(privateProbe.environment==='staging'&&privateProbe.releaseId===checked.original.candidate.releaseId&&privateProbe.sourceCommit===checked.plan.sourceCommit&&
      privateProbe.projectId===checked.original.candidate.workload.projectId&&typeof privateProbe.secret==='string'&&/^[a-f0-9]{64}$/u.test(privateProbe.secret)&&
      Number.isSafeInteger(privateProbe.expiresAt)&&Date.now()<privateProbe.expiresAt&&privateProbe.expiresAt<=Date.now()+3_600_000);
  }
  const execute=async(plan,browserSource)=>{
  const directory=join(settings.results,plan.certificationActionId);mkdirSync(directory,{mode:0o700});
  // Source/SSH diagnostics use a separate sibling. The controller's one receipt
  // store is initialized while its action directory is actually empty.
  const diagnostics=join(settings.results,plan.certificationActionId+'-ssh');mkdirSync(diagnostics,{mode:0o700});
  const ssh=await recreationSsh({knownHosts:settings.knownHosts,keyFile:settings.sshKey,diagnostics});
  demand((await ssh.machine()).machineId===settings.host.machineId);
  const installed=await ssh.installSource({commit:settings.operatorSourceCommit,files:source.files});demand(installed.status==='EXACT_OPERATOR_SOURCE_INSTALLED'&&installed.commit===settings.operatorSourceCommit);
  const initial={version:1,environment:'staging',mode:'p2-bounded-certification',sourceCommit:settings.operatorSourceCommit,sourceSha256,sourceClosureSha256,
    hostMachineId:settings.host.machineId,candidate:checked.original.candidate,candidateSha256:checked.plan.candidateSha256,
    bundle:settings.host.bundle,configuration:settings.host.configuration,results:settings.host.results,configurationSha256:checked.original.configurationSha256,
    confirmation:'staging/'+plan.certificationActionId,credentials,vercelToken:context.vercelToken,...(privateProbe?{privateProbe}:{}),certificationActionId:plan.certificationActionId,
    ...(browserSource?{browserPlan:checked.suspensionPlan,sourceParentChallenge:browserSource.challenge,persistenceReviewed:settings.browser.persistenceReviewed,browserResources:settings.browser.input.resources}:{}),
    certificationPlan:plan,nativePlan:plan.nativePlan,targetSha256:plan.targetSha256,owner:checked.original.prepared.plan.owner,
    producers:checked.original.prepared.plan.producers,historicalLogins:checked.original.prepared.plan.historicalLogins,certification:checked.original.prepared.plan.certification,
    expectedWriterAdmissionBinding:checked.original.plan.writerAdmissionBinding};
  if(plan.mode==='direct-worker')Object.assign(initial,{workerPlan:plan.workerPlan,sourceSuspensionPlan:p2CertificationParentContext(plan).suspensionPlan,persistenceReviewed:settings.worker.persistenceReviewed});
  return runP2BoundedCertification(plan,{directory,confirmation:'staging/'+plan.certificationActionId,sourceCi,browserSession:browserSource?.handle,getUrl:()=>credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    ...(plan.mode==='direct-worker'?{workerPrivateResolvers:createP2LifecycleWorkerPrivateResolvers(()=>privateObject(settings.providerContext,24_000_000))}:{}),
    assertSource:()=>committedOperatorSource(root,settings.operatorSourceCommit),withEnvironmentLock:p2CertificationEnvironmentLock(settings,initial,directory)});
  };
  if(!checked.authPlan)return execute(checked.plan);
  const browserDirectory=join(settings.results,checked.plan.certificationActionId+'-browser-source');mkdirSync(browserDirectory,{mode:0o700});
  const controller=launchP2LifecycleBrowserRecorder(checked.suspensionPlan,browserDirectory),binding=readP2LifecycleBrowserControllerBinding(checked.suspensionPlan,controller);
  const handle=Object.freeze({}),browserSource={handle,controller,challenge:binding.challenge,suspensionPlan:checked.suspensionPlan,authPlan:checked.authPlan,browserPlan:checked.plan,active:true,authenticationCompleted:false};
  browserSessions.set(handle,browserSource);
  try{
    await controller.initialized();const authenticated=await execute(checked.authPlan,browserSource);
    demand(authenticated.caseStatus==='P2_CERTIFICATION_AUTHENTICATION_PREPARED'&&authenticated.frontendAdmission.epoch===checked.plan.initialEpoch&&
      authenticated.frontendAdmission.active===0&&authenticated.frontendAdmission.uncertain===0&&authenticated.frontendAdmission.newWork===false&&authenticated.frontendAdmission.recovery===false);
    browserSource.authenticationCompleted=true;return await execute(checked.plan,browserSource);
  }finally{browserSource.active=false;await controller.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const[operation,path,flag,confirmation]=process.argv.slice(2);demand(['plan','plan-profiled-current','host-plan-profiled-current','apply','apply-profiled-current'].includes(operation)&&typeof path==='string'&&
    (operation.startsWith('apply')?flag==='--confirm'&&typeof confirmation==='string':confirmation===undefined&&
      (flag===undefined||operation==='host-plan-profiled-current'&&flag==='--authentication')));
    if(operation==='plan-profiled-current'||operation==='host-plan-profiled-current'||operation==='apply-profiled-current'){
      const settings=decodeQualificationTargetJson(privateBytes(resolve(path),24_000_000),'private-packet');
      if(operation==='apply-profiled-current')console.log(JSON.stringify(await p2ProfiledCertificationOperator(settings,{confirmation})));
      else {
        const plan=operation==='plan-profiled-current'?prepareP2ProfiledCertificationOperator(settings):profiledCertificationHostPlan(settings,flag==='--authentication');
        console.log(JSON.stringify(plan));
      }
    }else console.log(JSON.stringify(await p2CertificationOperator(privateObject(resolve(path)),{apply:operation==='apply',confirmation})));
  }catch{console.error('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW');process.exitCode=1;}
}
