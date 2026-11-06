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
import {changeFrontendAdmission,observeFrontendDrain} from './frontend-admission.mjs';
import {qualifyP2LifecycleNative,containP2LifecycleNative} from './p2-lifecycle-native.mjs';
import {prepareP2LifecycleTransportFaultPlan,runP2LifecycleTransportFault} from './p2-lifecycle-transport-fault.mjs';
import {withP2CertificationFrontendSession,readP2CertificationCurrent} from './p2-certification-current-probe.mjs';
import {collectP2CertificationRequestDetails} from './p2-certification-request-evidence.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareP2OperatorRelease} from './p2-release.mjs';
import {committedOperatorSource,verifyOperatorCi} from './recreation_source.mjs';
import {githubSourceApi} from './release-inputs.mjs';
import {recreationSsh} from './recreation_ssh.mjs';
import {p2CertificationEnvironmentLock} from './p2-certification-transport.mjs';
import {prepareP2LifecycleSuspensionPlan,launchP2LifecycleBrowserRecorder,readP2LifecycleBrowserControllerBinding,readP2LifecycleBrowserAuthentication,
  captureP2SuspensionControlledAuthority,observeP2SuspensionControlledAuthority,captureP2SuspensionPending} from './p2-lifecycle-suspension-evidence.mjs';

import {validateP2CanonicalBrowserObservation} from './p2-canonical-browser-origin.mjs';

const plans=new WeakMap();
const browserSessions=new WeakMap();
const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_PARENT_REFUSED');};
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/u.test(value)&&!/^0+$/u.test(value);
const action=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)&&!/^0+$/u.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const P2_CERTIFICATION_READY_FILES=Object.freeze(['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json',
  'frontend-workload-outcome.json','frontend-promotion-started.json','frontend-promotion-outcome.json']);

export function bindP2CertificationReadyReceipts(directory,plan){
  const records={};
  for(const name of P2_CERTIFICATION_READY_FILES){const bytes=readFrontendReleaseEvidence(directory,name);demand(rawHash(bytes)===plan.readyReceiptSha256[name]);records[name]=JSON.parse(bytes);}
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

export function prepareP2BoundedCertification(prepared,input,candidateBytes,{frontendReceipts,configurationSha256}){
  const candidate=prepared?.migration?.candidate,inventory=prepared?.plan,job=prepared?.migration?.job;
  demand(Buffer.isBuffer(candidateBytes)&&candidateBytes.length>0&&candidateBytes.length<=2_000_000&&isDeepStrictEqual(JSON.parse(candidateBytes),candidate)&&
    candidate?.contractPhase==='p2'&&candidate.environment==='staging'&&candidate.releaseId===inventory?.actionId&&job?.sourceCommit===candidate.sources.frontend.commit&&
    input?.version===1&&input.environment==='staging'&&inventory.targetSha256===frontendAdmissionTargetSha256('staging',job.target)&&action(input.certificationActionId)&&input.certificationActionId!==candidate.releaseId&&commit(input.operatorSourceCommit)&&
    ['auth-preparation','browser-pending','native-window','fault-before-upstream','fault-drop-after-ack','contain-native'].includes(input.mode)&&['qualified-ready','already-closed'].includes(input.startState)&&
    (!['auth-preparation','browser-pending','native-window'].includes(input.mode)||input.operatorSourceCommit===job.sourceCommit)&&
    /^[1-9][0-9]{0,17}$/u.test(input.initialEpoch??'')&&input.candidateSha256===rawHash(candidateBytes)&&input.inventorySha256===rawHash(inventory)&&
    input.configurationSha256===rawHash(configurationSha256)&&sha(input.configurationSha256)&&input.readyReceiptSha256&&
    [input.runtimeInventorySha256,input.gatewayProcessSha256,input.gatewayConfigurationSha256,input.operatorSourceClosureSha256].every(sha)&&
    isDeepStrictEqual(Object.keys(input.readyReceiptSha256).sort(),[...P2_CERTIFICATION_READY_FILES].sort())&&Object.values(input.readyReceiptSha256).every(sha));
  const selected=inventory.producers.find(row=>row.producerSha256===(inventory.runtimeProducerSha256??inventory.bootstrapCompatibility?.runtimeProducerSha256)&&row.role.name===job.target.runtimeRole);
  demand(selected&&isDeepStrictEqual(input.native?.owner,inventory.owner)&&isDeepStrictEqual(input.native.producer,{producerSha256:selected.producerSha256,role:{name:selected.role.name,oid:selected.role.oid}})&&
    isDeepStrictEqual(input.native.featureControls,inventory.certification.featureControls)&&input.native.targetSha256===inventory.targetSha256&&
    ['host','port','database','user','serverMajor'].every(key=>input.native.target[key]===job.target[key]));
  const closedOffset=input.startState==='qualified-ready'?1n:0n;
  if(['native-window','fault-before-upstream','fault-drop-after-ack'].includes(input.mode)){
    demand(input.requestEvidence?.kind==='operator-recorded-request-details'&&typeof input.requestEvidence.path==='string'&&resolve(input.requestEvidence.path)===input.requestEvidence.path);
    frontendPrivateReceiptDirectory(dirname(input.requestEvidence.path));
  }
  const nativeSettings={...structuredClone(input.native),epoch:input.mode==='contain-native'?input.native.epoch:(BigInt(input.initialEpoch)+closedOffset+1n).toString()};
  let nativePlan;
  if(['auth-preparation','browser-pending'].includes(input.mode)){
    demand(Array.isArray(input.native.commandWitnesses)&&input.native.commandWitnesses.length===0&&/^dpl_[A-Za-z0-9]+$/u.test(input.native.deploymentId??'')&&
      /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.native.deploymentUrl??'')&&sha(input.native.configurationRecordSha256));
    const control={version:1,purpose:'browser-authentication-control-only',environment:'staging',actionId:candidate.releaseId,sourceCommit:job.sourceCommit,projectId:candidate.workload.projectId,
      phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,deploymentId:input.native.deploymentId,deploymentUrl:input.native.deploymentUrl,
      configurationRecordSha256:input.native.configurationRecordSha256,targetSha256:inventory.targetSha256,target:structuredClone(input.native.target),owner:inventory.owner,
      producer:{producerSha256:selected.producerSha256,role:{name:selected.role.name,oid:selected.role.oid}},featureControls:structuredClone(inventory.certification.featureControls),
      writerAdmissionBinding:{mode:'enforce',targetSha256:inventory.targetSha256,producerSha256:selected.producerSha256,sourceCommit:job.sourceCommit,roleName:job.target.runtimeRole},
      schedule:P2_LIFECYCLE_NATIVE_SCHEDULE,initialEpoch:input.initialEpoch,commandWitnesses:[],finalDisposition:'disabled-and-admission-closed'};
    nativePlan=freeze({...control,planSha256:p2NativeHash(control)});
  }else nativePlan=prepareP2LifecycleNativePlan(candidate,nativeSettings);
  const base={version:1,environment:'staging',certificationActionId:input.certificationActionId,originalReleaseId:candidate.releaseId,sourceCommit:job.sourceCommit,
    operatorSourceCommit:input.operatorSourceCommit,candidateSha256:input.candidateSha256,candidateObjectSha256:p2NativeHash(candidate),inventorySha256:input.inventorySha256,
    configurationSha256:input.configurationSha256,targetSha256:inventory.targetSha256,mode:input.mode,startState:input.startState,initialEpoch:input.initialEpoch,
    browserPlanSha256:['auth-preparation','browser-pending'].includes(input.mode)?input.browserPlanSha256:null,
    configurationCanonicalSha256:p2NativeHash(configurationSha256),runtimeInventorySha256:input.runtimeInventorySha256,gatewayProcessSha256:input.gatewayProcessSha256,
    gatewayConfigurationSha256:input.gatewayConfigurationSha256,operatorSourceClosureSha256:input.operatorSourceClosureSha256,
    contractPhase:'p2',phase2ContractManifestSha256:candidate.phase2ContractManifestSha256,nativePlan,
    persistenceReaderEligible:input.operatorSourceCommit===job.sourceCommit,
    requestEvidenceDescriptorSha256:input.requestEvidence?p2NativeHash(input.requestEvidence):null,
    faultSelection:input.mode.startsWith('fault-')?{stageId:input.fault?.stageId,receiver:input.fault?.receiver,commandIndex:input.fault?.commandIndex,commandSha256:input.fault?.commandSha256}:null,
    readyReceiptSha256:structuredClone(input.readyReceiptSha256),maximumSeconds:input.mode==='auth-preparation'?300:900,finalDisposition:'native-disabled-and-both-admissions-closed',
    frontendSqlReplay:false,apiSqlReplay:false,rolePreparationAllowed:false,historicalLoginRestorationAllowed:false,buildAllowed:false,promotionAllowed:false,
    wholeReleaseAccepted:false};
  const plan=freeze({...base,planSha256:p2NativeHash(base)});
  demand(base.browserPlanSha256===null||sha(base.browserPlanSha256));
  let faultInput;
  if(input.mode.startsWith('fault-')){
    demand(input.fault&&action(input.fault.stageId));
    faultInput={version:1,stageId:input.fault.stageId,mode:input.mode==='fault-before-upstream'?'503-before-upstream':'drop-after-ack',receiver:input.fault.receiver,
      commandIndex:input.fault.commandIndex,commandSha256:input.fault.commandSha256,candidateSha256:input.candidateSha256,operatorSourceCommit:input.operatorSourceCommit,
      configurationSha256:base.configurationCanonicalSha256,gatewayConfigurationSha256:base.gatewayConfigurationSha256,gatewayProcessSha256:base.gatewayProcessSha256,
      gatewayImageSha256:candidate.artifacts.gateway.image.split('@sha256:')[1],operatorSourceClosureSha256:base.operatorSourceClosureSha256};
    prepareP2LifecycleTransportFaultPlan(nativePlan,faultInput);
  }
  plans.set(plan,{prepared,candidate:structuredClone(candidate),nativeSettings,candidateBytes:Buffer.from(candidateBytes),frontendReceipts,configurationSha256:structuredClone(configurationSha256),requestEvidence:structuredClone(input.requestEvidence),faultInput});
  bindP2CertificationReadyReceipts(frontendReceipts,plan);return plan;
}

export function p2CertificationParentContext(plan){const context=plans.get(plan);demand(context);return context;}

export function deriveP2CertificationNativePlan(plan,closedAdmission){
  const context=p2CertificationParentContext(plan),closedOffset=plan.startState==='qualified-ready'?1n:0n;
  demand(!['auth-preparation','browser-pending','contain-native'].includes(plan.mode));
  demand(closedAdmission?.newWork===false&&closedAdmission.recovery===false&&closedAdmission.active===0&&closedAdmission.uncertain===0&&
    closedAdmission.epoch===(BigInt(plan.initialEpoch)+closedOffset).toString());
  const derived=prepareP2LifecycleNativePlan(context.candidate,{...context.nativeSettings,epoch:(BigInt(closedAdmission.epoch)+1n).toString()});
  demand(derived.planSha256===plan.nativePlan.planSha256);return derived;
}

export async function runP2BoundedCertification(plan,dependencies){
  const context=p2CertificationParentContext(plan),{prepared}=context;
  demand(dependencies.confirmation==='staging/'+plan.certificationActionId&&typeof dependencies.withEnvironmentLock==='function'&&typeof dependencies.getUrl==='function');
  const store=frontendReleaseReceiptStore(dependencies.directory);store.record('p2-certification-started.json',plan);
  if(dependencies.sourceCi)store.record('operator-source-ci.json',dependencies.sourceCi);
  bindP2CertificationReadyReceipts(context.frontendReceipts,plan);
  let phase='host-serialization';
  try{return await dependencies.withEnvironmentLock(async(verifyEnvironment,signal,host)=>{
    demand(host.mode==='p2-bounded-certification'&&host.certificationActionId===plan.certificationActionId);
    const environment=async()=>{await dependencies.assertSource?.();demand(!signal.aborted);bindP2CertificationReadyReceipts(context.frontendReceipts,plan);await verifyEnvironment();};
    let terminal;
    await withP2CertificationFrontendSession(prepared,plan,{getUrl:dependencies.getUrl,verifyEnvironment:environment},async({client,verify,receipt,probe})=>{
      const withOwner=async task=>{await verify();await client.query(`SET ROLE "${prepared.plan.owner.name}"`);try{return await task();}finally{await client.query('RESET ROLE');await verify();}};
      const policy={environment:'staging',targetSha256:plan.targetSha256};
      const observe=async expectedEpoch=>withOwner(()=>observeFrontendDrain(client,policy,expectedEpoch));
      store.record('p2-certification-current-database.json',receipt);phase='all-three-current-and-existing-runtime';
      const current=await host.arm({receipt,probe});demand(current.status==='P2_CERTIFICATION_CURRENT_READY'&&current.runtimeReplaced===false&&current.sqlReplayed===false&&current.containers?.length===10);
      store.record('p2-certification-host-current.json',current);
      if(['auth-preparation','browser-pending'].includes(plan.mode)){
        const source=browserSessions.get(dependencies.browserSession);
        demand(source&&source.active&&source[plan.mode==='auth-preparation'?'authPlan':'browserPlan']===plan);
        const binding=readP2LifecycleBrowserControllerBinding(source.suspensionPlan,source.controller);
        demand(binding.challenge===source.challenge);
        validateP2CanonicalBrowserObservation(source.suspensionPlan,current.browserOrigin);
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
        terminal=await host.prepareClose(caseOutcome);demand(terminal.status==='P2_BOUNDED_CERTIFICATION_CONTAINED'&&terminal.planSha256===plan.planSha256);
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
        if(plan.mode==='native-window'){phase='bounded-actual-native-window';caseOutcome=await invoke();}
        else{
          const faultInput=context.faultInput;demand(faultInput);
          const faultPlan=prepareP2LifecycleTransportFaultPlan(nativePlan,faultInput),hostStage=await host.prepareFault(faultPlan);
          const faultDirectory=join(dependencies.directory,'fault');mkdirSync(faultDirectory,{mode:0o700});phase='bounded-known-transport-fault';
          try{caseOutcome=await runP2LifecycleTransportFault({plan:faultPlan,client,withOwner,verifyEnvironment:environment,verifySession:verify,hostStage,nativeControl:host.nativeControl,
            directory:faultDirectory,confirmation:'staging/'+faultPlan.stageId,exercise:invoke,
            containFrontend:async()=>{const actual=await readP2CertificationCurrent(client,prepared,plan,verify);return{frontendAdmissionClosed:actual.admission.newWork===false&&actual.admission.recovery===false};}});}
          catch(error){demand(plan.mode==='fault-drop-after-ack'&&error.publicReceipt?.outstandingUncertain===1);caseOutcome=error.publicReceipt;}
        }
        await host.gatewayStage('closed');
      }
      phase='fresh-contained-terminal';await verify();
      terminal=await host.prepareClose(caseOutcome,requestArtifact);demand(terminal?.status==='P2_BOUNDED_CERTIFICATION_CONTAINED'&&terminal.planSha256===plan.planSha256&&terminal.nativeDisabled===true&&terminal.sqlReplayed===false&&terminal.runtimeReplaced===false);
      store.record('p2-certification-close-prepared.json',terminal);
    });
    // The physical session is now actually closed. The host retains its real
    // environment lock while joining these exact immutable terminal bytes.
    store.record('p2-certification-outcome.json',terminal);await host.finish(terminal);return terminal;
  });}catch{
    try{store.record('p2-certification-outcome.json',{version:1,status:'P2_BOUNDED_CERTIFICATION_REQUIRES_REVIEW',planSha256:plan.planSha256,phase,
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

export function prepareP2CertificationOperator(settings){
  demand(settings?.version===1&&settings.environment==='staging'&&commit(settings.operatorSourceCommit));
  const candidateBytes=privateBytes(join(settings.bundle,'release.candidate.json')),candidate=JSON.parse(candidateBytes);
  const original=prepareP2OperatorRelease({...settings,sourceCommit:candidate.sources.frontend.commit});demand(original.prepared&&original.roles===undefined);
  const input={...settings.certification,operatorSourceCommit:settings.operatorSourceCommit};
  let suspensionPlan,authPlan;
  if(input.mode==='browser-pending'){
    demand(settings.browser&&settings.authPreparation&&input.startState==='already-closed');
    suspensionPlan=prepareP2LifecycleSuspensionPlan(candidate,settings.browser.input);
    demand(suspensionPlan.actionId===input.certificationActionId&&suspensionPlan.candidateSha256===rawHash(candidateBytes)&&
      suspensionPlan.targetSha256===original.prepared.plan.targetSha256&&suspensionPlan.deploymentId===input.native.deploymentId&&
      suspensionPlan.configurationRecordSha256===input.native.configurationRecordSha256&&suspensionPlan.configurationSha256===p2NativeHash(original.configurationSha256));
    input.browserPlanSha256=p2NativeHash(suspensionPlan);
    const auth=settings.authPreparation;
    demand(isDeepStrictEqual(Object.keys(auth).sort(),['certificationActionId','initialEpoch','startState'])&&
      input.initialEpoch===(BigInt(auth.initialEpoch)+2n).toString()&&auth.certificationActionId!==input.certificationActionId);
    authPlan=prepareP2BoundedCertification(original.prepared,{...input,...auth,mode:'auth-preparation'},candidateBytes,
      {frontendReceipts:settings.frontendReceipts,configurationSha256:original.configurationSha256});
  }else demand(input.mode!=='auth-preparation');
  const plan=prepareP2BoundedCertification(original.prepared,input,candidateBytes,{frontendReceipts:settings.frontendReceipts,configurationSha256:original.configurationSha256});
  frontendPrivateReceiptDirectory(settings.results);
  demand(lstatSync(join(settings.results,plan.certificationActionId),{throwIfNoEntry:false})===undefined);
  if(authPlan)demand(lstatSync(join(settings.results,authPlan.certificationActionId),{throwIfNoEntry:false})===undefined);
  return{plan,authPlan,suspensionPlan,original,candidateBytes};
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
  return runP2BoundedCertification(plan,{directory,confirmation:'staging/'+plan.certificationActionId,sourceCi,browserSession:browserSource?.handle,getUrl:()=>credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
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
  try{const[operation,path,flag,confirmation]=process.argv.slice(2);demand(['plan','apply'].includes(operation)&&typeof path==='string'&&(operation==='plan'?flag===undefined&&confirmation===undefined:flag==='--confirm'&&typeof confirmation==='string'));
    console.log(JSON.stringify(await p2CertificationOperator(privateObject(resolve(path)),{apply:operation==='apply',confirmation})));
  }catch{console.error('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW');process.exitCode=1;}
}
