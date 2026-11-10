#!/usr/bin/env node
// Explicit NEW action only. Plan is offline; apply retains a new physical FE
// lease and host FD. No frontend build, SQL apply, role setup or admission open.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {prepareP2OperatorRelease,validateP2PriorGatewayReference} from './p2-release.mjs';
import {withRecoveryFrontendSession,readRecoveryFrontendCurrent} from './p2-recovery-current-probe.mjs';
import {withP2ProfiledInterruptedFrontendSession} from './p2-certification-current-probe.mjs';
import {frontendPrivateReceiptDirectory,readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {writeFrontendReceipt} from './frontend-migration.mjs';
import {committedOperatorSource,committedProfiledCurrentOperatorSource,verifyOperatorCi} from './recreation_source.mjs';
import {githubSourceApi} from './release-inputs.mjs';
import {recreationSsh,sshCommand} from './recreation_ssh.mjs';
import {prepareP2ProfiledCurrentRelease,verifyP2ProfiledCurrentReleaseConfiguration} from './p2-profiled-current-release.mjs';
import {prepareP2CertificationReplacementRelease,validP2CertificationReplacementDescriptor} from './p2-certification-replacement-release.mjs';
import {assertSourceCheckout} from './source-checkout.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';

export const MODE='known-ack-interrupted-restoration';
export const TERMINAL='p2-known-ack-interrupted-restoration-outcome.json';
export const STATUS='P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED';
export const PROFILED_MODE='p2-profiled-known-ack-interrupted-restoration';
const profiledStatus='P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED';
const profiledCurrent='p2-profiled-interrupted-frontend-current.json';
const profiledPrepared='p2-profiled-interrupted-close-prepared.json';
const profiledTerminal='p2-profiled-interrupted-host-outcome.json';
const profiledFrameLimit=4_000_000;
export const CAUSAL_FILES=Object.freeze(['recovery-intent.json','baseline.json','domain.json','request-details.json','settlement.json','replacement-authorization.json']);
export const REPLACEMENT_FILES=Object.freeze(['known-ack-replacement-intent.json','known-ack-gateway-replacement-started.json',...Array.from({length:5},(_,i)=>['intent','observed'].map(kind=>`known-ack-stage-${i}-${kind}.json`)).flat()]);
const profiledCausalFiles=Object.freeze([...CAUSAL_FILES,'reconciliation-observed.json']);
const stagingRoot='/var/lib/lash-her/releases/staging';
const profileFields=Object.freeze({version:2,qualificationTargetProfile:currentProfile});
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const demand=ok=>{if(!ok)throw new Error('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_REFUSED');};
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const action=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());
const replacementFields=['replacementRelease','originalReleaseReceiptSha256','originalReleasePlanSha256'];
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));

function requireReplacementProvenance(value,provenance){
  demand(replacementFields.every(key=>Object.hasOwn(value,key)===!!provenance&&
    (!provenance||isDeepStrictEqual(value[key],provenance[key]))));
}

export function prepareInterruptedKnownAckAction(candidate,rawCandidate,selection,configurationSha256){
  demand(candidate?.environment==='staging'&&candidate.contractPhase==='p2'&&Buffer.isBuffer(rawCandidate)&&rawCandidate.length>0&&
    isDeepStrictEqual(JSON.parse(rawCandidate),candidate)&&exact(selection,['version','mode','restorationActionId','originalCertificationActionId','originalRecoveryActionId',
      'originalOperatorSourceCommit','causalReceiptSha256','replacementReceiptSha256','priorGatewayReference'])&&selection.version===1&&selection.mode===MODE&&
    [selection.restorationActionId,selection.originalCertificationActionId,selection.originalRecoveryActionId].every(action)&&
    new Set([candidate.releaseId,selection.restorationActionId,selection.originalCertificationActionId,selection.originalRecoveryActionId]).size===4&&
    /^[a-f0-9]{40}$/u.test(selection.originalOperatorSourceCommit??'')&&configurationSha256&&Object.keys(configurationSha256).length===19&&Object.values(configurationSha256).every(sha));
  demand(exact(selection.causalReceiptSha256,CAUSAL_FILES)&&Object.values(selection.causalReceiptSha256).every(sha)&&
    exact(selection.replacementReceiptSha256,REPLACEMENT_FILES)&&Object.values(selection.replacementReceiptSha256).every(value=>value===null||sha(value))&&
    sha(selection.replacementReceiptSha256['known-ack-replacement-intent.json']));
  const ref=validateP2PriorGatewayReference(selection.priorGatewayReference);demand(ref.kind==='stopped-current-candidate');
  let completed=0,active=false;
  for(let index=0;index<5;index++){
    const begin=selection.replacementReceiptSha256[`known-ack-stage-${index}-intent.json`],end=selection.replacementReceiptSha256[`known-ack-stage-${index}-observed.json`];
    demand(end===null||begin!==null);
    if(begin!==null){demand(!active&&completed===index);if(end===null)active=true;else completed++;}
  }
  demand(completed<5);
  // An active gateway intent needs the host's exact installed-helper/lineage
  // predicate; a present marker can never use the retained old-one path.
  demand(selection.replacementReceiptSha256['known-ack-gateway-replacement-started.json']===null);
  const originalReceiptSha256={...structuredClone(selection.causalReceiptSha256),...Object.fromEntries(Object.entries(selection.replacementReceiptSha256).map(([key,value])=>['replacement/'+key,value]))};
  return {version:1,mode:MODE,recoveryActionId:selection.restorationActionId,restorationActionId:selection.restorationActionId,originalReleaseId:candidate.releaseId,
    candidateSha256:hash(rawCandidate),configurationSha256:hash(JSON.stringify(configurationSha256)),originalReceiptSha256,
    interruptedRestoration:structuredClone(selection),runtimeServices:10,runtimeStages:5,runtimeReplacements:1,maximumSeconds:900,
    sqlReplayAllowed:false,rolePreparationAllowed:false,loginChangeAllowed:false,frontendBuildAllowed:false,frontendPromotionAllowed:false,
    admissionOpeningAllowed:false,ordinaryClosedZeroGate:false,originalGatewayUncertainty:{newWork:0,recovery:1},
    frontendReadinessVerified:false,trafficAuthorized:false,nativeSchedulesEnabled:false};
}

function privateBytes(path,maximum=2_000_000){
  demand(typeof path==='string'&&resolve(path)===path&&realpathSync(path)===path);frontendPrivateReceiptDirectory(dirname(path));
  const info=lstatSync(path);demand(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size>0&&info.size<=maximum);
  return readFileSync(path);
}
function object(path,maximum){const value=JSON.parse(privateBytes(path,maximum));demand(value&&typeof value==='object'&&!Array.isArray(value));return value;}

export function prepareInterruptedKnownAckOperator(settings){
  demand(settings?.version===1&&settings.environment==='staging'&&/^[a-f0-9]{40}$/u.test(settings.operatorSourceCommit??''));
  const rawCandidate=privateBytes(join(settings.bundle,'release.candidate.json')),candidate=JSON.parse(rawCandidate);
  const original=prepareP2OperatorRelease({...settings,sourceCommit:candidate.sources.frontend.commit});
  demand(original.prepared&&original.roles===undefined&&settings.rolePreparation===undefined);
  const action=prepareInterruptedKnownAckAction(candidate,rawCandidate,settings.interruptedRestoration,original.configurationSha256);
  demand(isDeepStrictEqual(original.plan.priorGatewayReference,action.interruptedRestoration.priorGatewayReference));
  demand(exact(settings.receiverTargets,['course','community']));
  for(const service of ['course','community']){
    const target=settings.receiverTargets[service],job=object(join(settings.bundle,'jobs',service+'.json'));
    demand(exact(target,['host','port','database','user','serverMajor','roleOid'])&&
      ['host','port','database','serverMajor'].every(key=>target[key]===job.target[key])&&target.user===job.runtimeRole&&/^[1-9][0-9]{0,9}$/u.test(target.roleOid??''));
  }
  return {original,action,candidateBytes:rawCandidate,plan:{...action,operatorSourceCommit:settings.operatorSourceCommit,
    originalSources:candidate.sources,receiverTargets:structuredClone(settings.receiverTargets),frontendTarget:original.job.target,configurationInputSha256:original.configurationSha256,
    approval:'Dardan starts this exact reviewed interrupted known-ACK staging restoration'}};
}

function profiledFrontier(selection, host){
  demand(exact(selection.causalReceiptSha256,profiledCausalFiles)&&Object.values(selection.causalReceiptSha256).every(sha)&&
    exact(selection.replacementReceiptSha256,REPLACEMENT_FILES)&&Object.values(selection.replacementReceiptSha256).every(value=>value===null||sha(value)));
  const pins=selection.replacementReceiptSha256;
  demand(sha(pins['known-ack-replacement-intent.json']));
  let completed=0,active=false;
  for(let index=0;index<5;index++){
    const intent=pins[`known-ack-stage-${index}-intent.json`],observed=pins[`known-ack-stage-${index}-observed.json`];
    demand(observed===null||intent!==null);
    if(intent!==null){demand(!active&&completed===index);if(observed===null)active=true;else completed++;}
  }
  demand((pins['known-ack-gateway-replacement-started.json']!==null)===(completed===5));
  const reference=validateP2PriorGatewayReference(selection.priorGatewayReference);
  const replacement=join(stagingRoot,'p2-profiled-known-ack-'+selection.originalRecoveryActionId);
  const certification=join(host.results,'p2-profiled-current-certification-'+selection.originalCertificationActionId);
  const guarded=['prior-gateway-after-quiescence','prior-gateway-broker-fallback'].map(name=>join(certification,name));
  const stops=completed===5?[certification,...guarded]:[replacement,certification,...guarded];
  demand(reference.kind==='stopped-current-candidate'&&stops.includes(reference.stopReceiptDirectory));
  return completed===5?'replacement-stopped-zero':'original-stopped-one';
}

export function prepareProfiledInterruptedKnownAckOperator(settings){
  const replacing=Object.hasOwn(settings??{},'replacementRelease');
  demand(exact(settings,['version','qualificationTargetProfile','environment','operatorSourceCommit','releaseSettings','interruptedRestoration','receiverTargets','operationId',
    ...(replacing?['replacementRelease']:[])])&&
    settings.version===2&&settings.environment==='staging'&&/^[a-f0-9]{40}$/u.test(settings.operatorSourceCommit??'')&&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(settings.operationId??''));
  const selection=settings.interruptedRestoration;
  requireQualificationTargetProfile(currentProfile,settings,selection);
  demand(exact(selection,['version','qualificationTargetProfile','mode','restorationActionId','originalCertificationActionId','originalRecoveryActionId',
    'originalOperatorSourceCommit','causalReceiptSha256','replacementReceiptSha256','priorGatewayReference'])&&selection.version===2&&selection.mode===PROFILED_MODE&&
    [selection.restorationActionId,selection.originalCertificationActionId,selection.originalRecoveryActionId].every(action)&&
    /^[a-f0-9]{40}$/u.test(selection.originalOperatorSourceCommit??''));
  const releaseInput=settings.releaseSettings;
  const selected=replacing?prepareP2CertificationReplacementRelease(releaseInput,settings.replacementRelease):undefined;
  const original=selected?.original??prepareP2ProfiledCurrentRelease(releaseInput), release=original.plan;
  const releaseSettings=selected?{...pick(releaseInput.arm,['results','knownHosts','sshKey']),host:selected.host,
    providerContext:releaseInput.providerContext}:releaseInput;
  const provenance=selected?{replacementRelease:selected.profiledRelease.replacementRelease,
    originalReleaseReceiptSha256:selected.profiledRelease.receiptSha256,originalReleasePlanSha256:selected.profiledRelease.planSha256}:undefined;
  demand(new Set([release.releaseId,selection.restorationActionId,selection.originalCertificationActionId,selection.originalRecoveryActionId]).size===4);
  const frontier=profiledFrontier(selection,releaseSettings.host);
  const retainedDirectory=join(releaseSettings.results,selection.originalCertificationActionId);
  const originalPlanRaw=readFrontendReleaseEvidence(retainedDirectory,'p2-certification-started.json');
  demand(originalPlanRaw.length<=65_536);
  const originalCertificationPlan=decodeQualificationTargetJson(originalPlanRaw,'carrier');
  const {planSha256,...body}=originalCertificationPlan, nativePlan=body.nativePlan;
  requireQualificationTargetProfile(currentProfile,originalCertificationPlan,nativePlan,nativePlan?.target,body.knownAckRecovery,body.knownAckRecovery?.intent);
  const {planSha256:nativeSha256,...nativeBody}=nativePlan;
  demand(body.version===2&&body.mode==='known-ack-recovery'&&body.environment==='staging'&&body.startState==='already-closed'&&
    body.certificationActionId===selection.originalCertificationActionId&&body.originalReleaseId===release.releaseId&&
    body.operatorSourceCommit===selection.originalOperatorSourceCommit&&body.sourceCommit===release.sourceCommit&&body.candidateSha256===release.candidateSha256&&
    body.targetSha256===release.targetSha256&&body.inventorySha256===release.inventorySha256&&body.configurationCanonicalSha256===p2NativeHash(release.configurationSha256)&&
    isDeepStrictEqual(body.apiJobSha256,release.apiJobSha256)&&planSha256===p2NativeHash(body)&&
    body.knownAckRecovery.recoveryActionId===selection.originalRecoveryActionId&&body.knownAckRecovery.intentSha256===p2NativeHash(body.knownAckRecovery.intent)&&
    nativePlan.version===2&&nativeSha256===p2NativeHash(nativeBody)&&/^[1-9][0-9]{0,17}$/u.test(nativePlan.initialEpoch??'')&&
    nativePlan.commandWitnesses?.length===1&&nativePlan.commandWitnesses[0].action==='suspend');
  if(provenance){
    const inputDirectory=body.knownAckConfigurationInputDirectory;
    demand(validP2CertificationReplacementDescriptor(provenance.replacementRelease)&&
      isDeepStrictEqual(original.inventory.replacementRelease,provenance.replacementRelease)&&
      body.operatorSourceCommit===release.sourceCommit&&hash(selected.originalReleaseReceipt)===provenance.originalReleaseReceiptSha256&&
      typeof inputDirectory==='string'&&resolve(inputDirectory)===inputDirectory&&inputDirectory.startsWith(stagingRoot+'/')&&
      !inputDirectory.includes(',')&&inputDirectory!==selected.host.configuration&&body.knownAckRecovery.intent.configurationInputDirectory===inputDirectory&&
      ['host','port','database','user','serverMajor'].every(key=>nativePlan.target[key]===original.migration.job.target[key])&&
      nativePlan.targetSha256===release.targetSha256&&isDeepStrictEqual(nativePlan.owner,original.inventory.owner)&&
      original.inventory.producers.length===1&&isDeepStrictEqual(nativePlan.producer,original.inventory.producers[0]));
    requireReplacementProvenance(body,provenance);
  }else demand(!Object.hasOwn(body,'replacementRelease')&&!Object.hasOwn(original.inventory,'replacementRelease'));
  requireReplacementProvenance(body.knownAckRecovery.intent,provenance);
  const receivers=settings.receiverTargets;
  demand(exact(receivers,['course','community'])&&isDeepStrictEqual(receivers,body.knownAckReceiverTargets)&&
    p2NativeHash(receivers)===body.knownAckRecovery.intent.receiverTargetsSha256);
  for(const [service,target] of Object.entries(receivers)){
    const job=original.apiJobs[service];
    demand(exact(target,['host','port','database','user','serverMajor','roleOid'])&&
      ['host','port','database','serverMajor'].every(key=>target[key]===job.target[key])&&target.user===job.runtimeRole&&/^[1-9][0-9]{0,9}$/u.test(target.roleOid??''));
  }
  const frontend={...profileFields,mode:PROFILED_MODE,environment:'staging',startState:'already-closed',
    certificationActionId:selection.restorationActionId,originalCertificationActionId:selection.originalCertificationActionId,
    originalReleaseId:release.releaseId,sourceCommit:release.sourceCommit,
    candidateSha256:release.candidateSha256,targetSha256:release.targetSha256,contractPhase:release.contractPhase,
    apiJobSha256:release.apiJobSha256,
    phase2ContractManifestSha256:release.phase2ContractManifestSha256,configurationCanonicalSha256:p2NativeHash(release.configurationSha256),
    nativePlan,initialEpoch:(BigInt(nativePlan.initialEpoch)+2n).toString(),operationId:settings.operationId,
    reconciliationSha256:selection.causalReceiptSha256['settlement.json'],...provenance};
  const frontendPlan={...frontend,planSha256:p2NativeHash(frontend)};
  const plan={...profileFields,mode:PROFILED_MODE,environment:'staging',restorationActionId:selection.restorationActionId,
    originalReleaseId:release.releaseId,sourceCommit:release.sourceCommit,operatorSourceCommit:settings.operatorSourceCommit,
    candidateSha256:release.candidateSha256,apiJobSha256:release.apiJobSha256,configurationSha256:release.configurationSha256,
    inventorySha256:release.inventorySha256,targetSha256:release.targetSha256,hostMachineId:releaseSettings.host.machineId,
    originalCertificationPlanSha256:planSha256,originalCertificationPlanBytesSha256:hash(originalPlanRaw),frontendPlan,
    configurationInputDirectory:body.knownAckConfigurationInputDirectory,
    interruptedRestoration:structuredClone(selection),receiverTargets:structuredClone(receivers),requestedFrontier:frontier,
    runtimeStages:5,runtimeReplacements:1,maximumSeconds:900,frontendSqlApplied:false,sqlReplayAllowed:false,rolePreparationAllowed:false,
    loginChangeAllowed:false,frontendBuildAllowed:false,frontendPromotionAllowed:false,admissionOpeningAllowed:false,nativeSchedulesEnabled:false,
    trafficAuthorized:false,liveExecutionEligible:false,releaseAccepted:false,...provenance};
  return {original,plan,releaseSettings,originalCertificationPlan:originalPlanRaw.toString('base64'),
    ...(selected?{originalReleaseReceipt:selected.originalReleaseReceipt.toString('base64')}:{})};
}

export function prepareProfiledInterruptedKnownAckHostPacket(settings){
  const checked=prepareProfiledInterruptedKnownAckOperator(settings);
  return profiledInterruptedHostPacket(checked,committedProfiledCurrentOperatorSource(root,checked.plan.operatorSourceCommit));
}

function profiledInterruptedHostPacket(checked,source){
  const {original,plan,releaseSettings:{host}}=checked;
  const sourceSha256=Object.fromEntries(source.files.map(file=>[file.path,file.sha256]));
  return {...profileFields,mode:PROFILED_MODE,environment:'staging',sourceCommit:plan.operatorSourceCommit,sourceSha256,
    sourceClosureSha256:hash(JSON.stringify(Object.entries(sourceSha256).sort(([a],[b])=>a<b?-1:a>b?1:0))),
    hostMachineId:host.machineId,bundle:host.bundle,configuration:plan.configurationInputDirectory,results:host.results,
    candidate:original.migration.candidate,candidateSha256:plan.candidateSha256,apiJobSha256:plan.apiJobSha256,configurationSha256:plan.configurationSha256,
    targetSha256:plan.targetSha256,inventorySha256:plan.inventorySha256,inventory:original.inventory,owner:original.inventory.owner,
    frontendJob:original.migration.job,frontendBaseline:original.migration.baseline,restorationActionId:plan.restorationActionId,recoveryActionId:plan.restorationActionId,
    interruptedRestoration:plan.interruptedRestoration,receiverTargets:plan.receiverTargets,priorGatewayReference:plan.interruptedRestoration.priorGatewayReference,
    originalCertificationPlanSha256:plan.originalCertificationPlanSha256,originalCertificationPlanBytesSha256:plan.originalCertificationPlanBytesSha256,
    operationId:plan.frontendPlan.operationId,reviewedPlan:plan,originalCertificationPlan:checked.originalCertificationPlan,
    ...(checked.originalReleaseReceipt?{originalReleaseReceipt:checked.originalReleaseReceipt}:{})};
}

export function interruptedKnownAckEnvironmentLock(settings,initial,directory,{launch=spawn}={}){
  demand(initial?.environment==='staging'&&initial.mode===MODE&&/^[a-f0-9]{40}$/u.test(initial.sourceCommit??''));
  const remote=['sudo','-n','/usr/bin/python3','-I','-u',`/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_known_ack_interrupted_restoration.py`];
  return async task=>{
    const child=launch('/usr/bin/ssh',sshCommand({knownHosts:settings.knownHosts,keyFile:settings.sshKey},remote),
      {stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))});
    const pending=new Map(),controller=new AbortController();let sequence=0,failed=false,active=true,exited,heartbeat,armed=false,prepared=false,started=false,closed=false;
    const fail=()=>{if(failed)return;failed=true;controller.abort();for(const value of pending.values()){clearTimeout(value.timer);value.reject(new Error('P2_INTERRUPTED_HOST_LOST'));}pending.clear();child.stdin.end();};
    const lines=createInterface({input:child.stdout});
    lines.on('line',raw=>{try{demand(Buffer.byteLength(raw)<=4_000_000);const value=JSON.parse(raw),waiter=pending.get(value.id);demand(waiter&&value.status===waiter.status);pending.delete(value.id);clearTimeout(waiter.timer);waiter.resolve(value);}catch{fail();}});
    // Raw remote errors may contain private URLs. The source guard retains its
    // sanitized outcome; the operator emits only a fixed error on failure.
    child.stderr.resume();child.on('error',fail);child.stdin.on('error',fail);child.on('exit',code=>{exited=code;if(active||code!==0)fail();});
    const expect=(id,status,timeout)=>new Promise((resolve,reject)=>{demand(!failed&&!pending.has(id));const timer=setTimeout(()=>{fail();reject(new Error('P2_INTERRUPTED_HOST_UNCERTAIN'));},timeout);pending.set(id,{status,resolve,reject,timer});});
    const request=(operation,status,data={},timeout=90_000)=>{demand(!failed&&active);const id=++sequence,raw=JSON.stringify({id,operation,...data});demand(Buffer.byteLength(raw)<=4_000_000);const response=expect(id,status,timeout);child.stdin.write(raw+'\n');return response;};
    const ready=expect(0,'LOCKED',90_000),raw=JSON.stringify(initial);demand(Buffer.byteLength(raw)<=4_000_000);child.stdin.write(raw+'\n');
    let result,error;
    try{
      await ready;const verify=async()=>{await request('check','HELD');};heartbeat=setInterval(()=>{if(!failed)void verify().catch(fail);},1000);
      const host={
        async arm({receipt,probe}){demand(!armed&&!prepared&&!started);const bytes=readFrontendReleaseEvidence(directory,'p2-recovery-current-database.json');demand(isDeepStrictEqual(JSON.parse(bytes),receipt));
          const value=await request('arm-interrupted-restoration','INTERRUPTED_RESTORATION_ARMED',{receipt:bytes.toString('base64'),probe},240_000);demand(value.receipt?.status==='P2_INTERRUPTED_FRESH_CURRENT_READY');armed=true;return value.receipt;},
        async prepare(){demand(armed&&!prepared&&!started);const value=await request('prepare-interrupted-restoration','INTERRUPTED_RESTORATION_PREPARED',{},240_000);demand(value.receipt?.status==='P2_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED');prepared=true;return value.receipt;},
        async restore(){demand(prepared&&!started&&!closed);started=true;const value=await request('restore-runtime','INTERRUPTED_RUNTIME_READY',{},900_000);demand(value.receipt?.status===STATUS);return value.receipt;},
        async prepareClose(){demand(started&&!closed);const value=await request('prepare-close','INTERRUPTED_CLOSE_PREPARED',{},240_000);demand(value.receipt?.status===STATUS);closed=true;return value.receipt;},
      };
      result=await task(verify,controller.signal,host);await verify();demand(closed&&!failed&&result?.status===STATUS);
      const outcome=readFrontendReleaseEvidence(directory,TERMINAL);demand(isDeepStrictEqual(JSON.parse(outcome),result));
      const joined=await request('finish','INTERRUPTED_RESTORATION_JOINED',{restoration:outcome.toString('base64')});demand(isDeepStrictEqual(joined.receipt,result));
      const committed=await request('commit','COMMITTED');demand(isDeepStrictEqual(committed.receipt,result));writeFrontendReceipt(directory,'p2-host-interrupted-restoration-outcome.json',committed.receipt);active=false;
    }catch{error=new Error('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_FAILED_REQUIRES_REVIEW');fail();}
    finally{clearInterval(heartbeat);child.stdin.end();if(exited===undefined)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');error??=new Error('P2_INTERRUPTED_HOST_CLEANUP_UNCERTAIN');resolve();},60_000);child.once('close',()=>{clearTimeout(timer);resolve();});});active=false;lines.close();for(const value of pending.values())clearTimeout(value.timer);if(exited!==0)error??=new Error('P2_INTERRUPTED_HOST_CLEANUP_UNCERTAIN');}
    if(error)throw error;return result;
  };
}

export async function runInterruptedKnownAckRestoration({prepared,action},{directory,getUrl,assertSource,withEnvironmentLock,createClient}){
  demand(prepared&&action?.mode===MODE&&typeof getUrl==='function'&&typeof assertSource==='function'&&typeof withEnvironmentLock==='function');
  return withEnvironmentLock(async(verifyEnvironment,signal,host)=>{
    const verifyHost=async()=>{assertSource();signal.throwIfAborted();await verifyEnvironment();};
    return withRecoveryFrontendSession(prepared,action,{getUrl,createClient,verifyEnvironment:verifyHost},async({client,verify,receipt,probe})=>{
      writeFrontendReceipt(directory,'p2-recovery-current-database.json',receipt);await verify();await host.arm({receipt,probe});await verify();
      await host.prepare();await verify();const result=await host.restore();await verify();
      demand(result.status===STATUS&&result.restorationActionId===action.restorationActionId&&result.candidateSha256===action.candidateSha256&&
        result.sqlReplayed===false&&result.rolePreparationRepeated===false&&result.originalTerminalRecreated===false&&result.trafficAuthorized===false&&
        result.frontendReadinessVerified===false&&result.frontendWorkloadProbePerformed===false&&result.originalGatewayUncertaintyPreserved===true&&result.ordinaryClosedZeroGate===false&&
        result.runtimeReplacements===1&&result.nativeDisabled===true&&result.containers?.length===10&&
        isDeepStrictEqual(result.oldGateway?.admission?.uncertain,{newWork:0,recovery:1})&&isDeepStrictEqual(result.newGateway?.admission?.uncertain,{newWork:0,recovery:0})&&
        isDeepStrictEqual(result.newGateway?.admission?.active,{newWork:0,recovery:0})&&result.newGateway.admission.newWork===false&&result.newGateway.admission.recovery===false&&
        result.newGateway.process.containerId!==result.oldGateway.process.containerId);
      const after=await readRecoveryFrontendCurrent(client,prepared,action,verify);demand(isDeepStrictEqual(after,receipt)&&result.frontendJournalSha256===after.journalSha256);
      const terminal=await host.prepareClose();demand(isDeepStrictEqual(terminal,result));await verify();writeFrontendReceipt(directory,TERMINAL,terminal);return terminal;
    });
  });
}

const profiledServices=['community-api','course-api','community-tls','course-tls','course-snapshot','community-worker',
  'course-media','course-export-cleanup','course-publisher','gateway'];
const profiledBoundaryChecks=['public-tls-missing-workload-denied','public-metrics-hidden','private-course-tls-catalog',
  'private-application-credential-required','private-community-peer-denied'];
const zeroCounters={newWork:0,recovery:0};
const profiledFalseFlags=['sqlReplayed','migrationsExecuted','rolePreparationRepeated','frontendSqlApplied','newWorkOpened','recoveryOpened','trafficAuthorized'];

function profiledReceipt(receipt,status){
  requireQualificationTargetProfile(currentProfile,receipt);
  demand(receipt.version===2&&receipt.status===status);
}

function requireProfiledApiDatabases(initial,databases){
  demand(exact(databases,['course','community'])&&Object.entries(databases).every(([name,record])=>
    exact(record,['image','jobSha256','receiptSha256'])&&record.image===initial.candidate.artifacts[name+'Migration'].image&&
    record.jobSha256===initial.apiJobSha256[name]&&sha(record.receiptSha256)));
}

function requireProfiledGateway(gateway,running,uncertain){
  const admission=gateway?.admission, process=gateway?.process;
  demand(admission?.newWork===false&&admission.recovery===false&&isDeepStrictEqual(admission.active,zeroCounters)&&
    isDeepStrictEqual(admission.uncertain,uncertain)&&process?.running===running&&Number.isSafeInteger(process.pid)&&
    (running?process.pid>0:process.pid===0)&&/^[a-f0-9]{12,64}$/u.test(process.containerId??''));
}

function requireProfiledRestored(initial,receipt,current,apiDatabases,provenance){
  profiledReceipt(receipt,profiledStatus);
  requireReplacementProvenance(receipt,provenance);
  const plan=initial.reviewedPlan;
  demand(receipt.environment==='staging'&&receipt.releaseId===plan.originalReleaseId&&receipt.candidateSha256===plan.candidateSha256&&
    receipt.restorationActionId===plan.restorationActionId&&receipt.recoveryActionId===plan.restorationActionId&&
    receipt.contractPhase===plan.frontendPlan.contractPhase&&receipt.phase2ContractManifestSha256===plan.frontendPlan.phase2ContractManifestSha256&&
    receipt.frontier===plan.requestedFrontier&&receipt.frontendJournalSha256===current.journalSha256&&sha(receipt.readinessReceiptSha256)&&
    profiledFalseFlags.every(key=>receipt[key]===false)&&receipt.nativeDisabled===true&&receipt.runtimeReplacements===1&&
    isDeepStrictEqual(receipt.apiDatabases,apiDatabases)&&isDeepStrictEqual(receipt.currentApiDatabasesAfter,apiDatabases)&&
    Array.isArray(receipt.boundaryChecks)&&isDeepStrictEqual([...receipt.boundaryChecks].sort(),[...profiledBoundaryChecks].sort())&&
    Array.isArray(receipt.containers)&&isDeepStrictEqual(receipt.containers.map(row=>row.service).sort(),[...profiledServices].sort())&&
    receipt.containers.every(row=>/^[a-f0-9]{12,64}$/u.test(row.containerId??''))&&
    new Set(receipt.containers.map(row=>row.containerId)).size===profiledServices.length);
  requireProfiledGateway(receipt.stoppedGateway,false,receipt.frontier==='original-stopped-one'?{newWork:0,recovery:1}:zeroCounters);
  requireProfiledGateway(receipt.newGateway,true,zeroCounters);
  const gatewayId=receipt.newGateway.process.containerId;
  demand(gatewayId!==receipt.stoppedGateway.process.containerId&&
    gatewayId.startsWith(receipt.containers.find(row=>row.service==='gateway').containerId));
}

function profiledTransportProvenance(initial){
  const plan=initial.reviewedPlan, replacing=Object.hasOwn(plan,'replacementRelease');
  const provenance=replacing?pick(plan,replacementFields):undefined;
  requireReplacementProvenance(plan,provenance);
  requireReplacementProvenance(plan.frontendPlan,provenance);
  demand(Object.hasOwn(initial,'originalReleaseReceipt')===replacing&&Object.hasOwn(initial.inventory,'replacementRelease')===replacing&&
    replacementFields.every(key=>!Object.hasOwn(initial,key)));
  const target=initial.frontendJob.target;
  if(!replacing){
    demand(target.allowEmptyBootstrap===false&&isDeepStrictEqual(target.approvedPendingTags,[]));
    return;
  }
  const {replacementRelease,originalReleaseReceiptSha256,originalReleasePlanSha256}=provenance;
  const encoded=initial.originalReleaseReceipt;
  demand(validP2CertificationReplacementDescriptor(replacementRelease)&&sha(originalReleaseReceiptSha256)&&
    !/^0+$/u.test(originalReleaseReceiptSha256)&&originalReleasePlanSha256===replacementRelease.reviewedPlanSha256&&
    isDeepStrictEqual(initial.inventory.replacementRelease,replacementRelease)&&!Object.hasOwn(initial.inventory,'historicalLogins')&&
    target.allowEmptyBootstrap===true&&Array.isArray(target.approvedPendingTags)&&target.approvedPendingTags.length>0&&
    typeof encoded==='string'&&encoded.length<=87_384);
  const raw=Buffer.from(encoded,'base64');
  demand(raw.length>0&&raw.length<=65_536&&raw.at(-1)===10&&raw.toString('base64')===encoded&&hash(raw)===originalReleaseReceiptSha256);
  const terminal=decodeQualificationTargetJson(raw,'carrier');
  profiledReceipt(terminal,'P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION');
  demand(terminal.environment==='staging'&&terminal.releaseId===plan.originalReleaseId&&terminal.sourceCommit===plan.sourceCommit&&
    terminal.candidateSha256===plan.candidateSha256&&terminal.targetSha256===plan.targetSha256&&
    terminal.contractPhase===plan.frontendPlan.contractPhase&&terminal.phase2ContractManifestSha256===plan.frontendPlan.phase2ContractManifestSha256&&
    ['reviewedPlanSha256','runtimeReviewSha256','postflightSha256','frontendSessionClosedSha256','frontendDatabaseReceiptSha256']
      .every(key=>terminal[key]===replacementRelease[key])&&isDeepStrictEqual(terminal.configurationSha256,plan.configurationSha256)&&
    terminal.migrationMode==='apply-forward'&&terminal.frontendSqlApplied===true&&terminal.frontendSessionClosed===true&&
    terminal.frontendSqlReplayed===false&&terminal.trafficAuthorized===false&&terminal.releaseAccepted===false&&
    isDeepStrictEqual(terminal.owner,initial.owner)&&initial.inventory.producers?.length===1&&
    isDeepStrictEqual(initial.inventory.producers[0],{role:terminal.runtime,producerSha256:terminal.producerSha256})&&
    terminal.runtime.name===target.runtimeRole);
  return provenance;
}

async function withProfiledInterruptedEnvironmentLock(settings,initial,directory,task,launch=spawn){
  const plan=initial.reviewedPlan;
  requireQualificationTargetProfile(currentProfile,initial,plan,plan?.frontendPlan,initial.candidate,
    initial.candidate?.frontendMigration,initial.frontendJob,initial.frontendJob?.target,initial.inventory);
  demand(initial.version===2&&initial.environment==='staging'&&initial.mode===PROFILED_MODE&&plan.mode===PROFILED_MODE&&
    plan.version===2&&plan.frontendPlan.version===2&&plan.frontendPlan.mode===PROFILED_MODE&&
    /^[a-f0-9]{40}$/u.test(initial.sourceCommit??'')&&initial.sourceCommit===plan.operatorSourceCommit&&
    action(plan.restorationActionId)&&initial.confirmation==='staging/'+plan.restorationActionId&&
    initial.restorationActionId===plan.restorationActionId&&initial.recoveryActionId===plan.restorationActionId&&
    plan.frontendPlan.certificationActionId===plan.restorationActionId&&initial.candidateSha256===plan.candidateSha256&&
    initial.targetSha256===plan.targetSha256&&initial.candidate.version===3&&initial.candidate.releaseId===plan.originalReleaseId&&
    initial.frontendJob.version===2&&initial.frontendJob.releaseId===plan.originalReleaseId&&
    initial.frontendJob.sourceCommit===plan.sourceCommit&&initial.candidate.sources?.frontend?.commit===plan.sourceCommit);
  const provenance=profiledTransportProvenance(initial);
  const rawInitial=JSON.stringify(initial);
  demand(Buffer.byteLength(rawInitial)+1<=profiledFrameLimit);
  const remote=['sudo','-n','/usr/bin/python3','-I','-u',
    `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_profiled_known_ack_restoration_parent.py`,'--supervisor-profiled-current'];
  const child=launch('/usr/bin/ssh',sshCommand({knownHosts:settings.knownHosts,keyFile:settings.sshKey},remote),
    {stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))});
  const pending=new Map(),controller=new AbortController();
  let sequence=0,failed=false,phase='locked',heartbeat,exit,stdout=Buffer.alloc(0),current,apiDatabases,restored,preparedRaw;
  const lost=()=>{
    if(failed)return;
    failed=true;controller.abort();
    for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('P2_PROFILED_INTERRUPTED_HOST_LOST'));}
    pending.clear();child.stdin.end();
  };
  const accept=raw=>{
    try{
      const value=decodeQualificationTargetJson(raw,'private-packet'),waiter=pending.get(value?.id);
      demand(phase!=='committed'&&waiter&&value.status===waiter.status&&exact(value,waiter.receipt?['id','status','receipt']:['id','status']));
      if(waiter.status==='COMMITTED'){
        demand(isDeepStrictEqual(value.receipt,restored));phase='committed';
      }
      pending.delete(value.id);clearTimeout(waiter.timer);waiter.resolve(value.receipt);
    }catch{lost();}
  };
  child.stdout.on('data',chunk=>{
    let offset=0;
    while(!failed&&offset<chunk.length){
      const end=chunk.indexOf(10,offset),part=chunk.subarray(offset,end<0?chunk.length:end);
      if(stdout.length+part.length+1>profiledFrameLimit){lost();return;}
      stdout=Buffer.concat([stdout,part]);
      if(end<0)return;
      accept(stdout);stdout=Buffer.alloc(0);offset=end+1;
    }
  });
  child.stdout.on('end',()=>{if(stdout.length||phase!=='committed')lost();});
  // Host stderr can contain private material. The independent guard retains its own failure record.
  child.stderr.resume();child.on('error',lost);child.stdin.on('error',lost);
  child.on('exit',(code,signal)=>{exit={code,signal};if(code!==0||signal!==null)lost();});
  const reaped=new Promise(done=>child.once('close',done));
  const expect=(id,status,timeout,receipt)=>new Promise((resolve,reject)=>{
    demand(!failed&&!pending.has(id));
    pending.set(id,{status,receipt,resolve,reject,timer:setTimeout(lost,timeout)});
  });
  const send=(operation,status,data={},timeout=90_000,receipt=true)=>{
    demand(!failed&&phase!=='committed');
    const id=++sequence,raw=JSON.stringify({id,operation,...data});
    demand(Buffer.byteLength(raw)+1<=profiledFrameLimit);
    const result=expect(id,status,timeout,receipt);child.stdin.write(raw+'\n');return result;
  };
  const verify=async()=>{await send('check','HELD',{},90_000,false);};
  const transition=async(before,after,operation,status,data,timeout)=>{
    demand(phase===before);phase='pending-'+after;
    const receipt=await send(operation,status,data,timeout);phase=after;return receipt;
  };
  const host={
    async arm({receipt,probe}){
      requireQualificationTargetProfile(currentProfile,probe,receipt);
      demand(probe.version===2&&isDeepStrictEqual(probe.plan,plan.frontendPlan)&&isDeepStrictEqual(probe.job,initial.frontendJob)&&
        isDeepStrictEqual(probe.baseline,initial.frontendBaseline)&&isDeepStrictEqual(probe.owner,initial.owner)&&
        isDeepStrictEqual(probe.receipt,receipt)&&receipt.version===2&&receipt.status==='P2_CERTIFICATION_DATABASE_CURRENT');
      if(provenance)demand(isDeepStrictEqual(probe.replacementRelease,provenance.replacementRelease)&&
        !Object.hasOwn(probe,'historicalLogins')&&isDeepStrictEqual(probe.producers,initial.inventory.producers)&&
        isDeepStrictEqual(receipt.replacementRelease,provenance.replacementRelease)&&receipt.effectiveLoginBoundaryVerified===true&&
        receipt.predecessorRuntimeRoleAbsent===true);
      else demand(!Object.hasOwn(probe,'replacementRelease')&&!Object.hasOwn(receipt,'replacementRelease'));
      const raw=readFrontendReleaseEvidence(directory,profiledCurrent);
      demand(isDeepStrictEqual(decodeQualificationTargetJson(raw,'carrier'),receipt));
      const ready=await transition('locked','armed','arm-interrupted-restoration','INTERRUPTED_RESTORATION_ARMED',{receipt:raw.toString('base64'),probe},240_000);
      profiledReceipt(ready,'P2_PROFILED_INTERRUPTED_FRESH_CURRENT_READY');
      demand(ready.restorationActionId===plan.restorationActionId&&ready.candidateSha256===plan.candidateSha256&&ready.authorityIssued===false);
      requireProfiledApiDatabases(initial,ready.apiDatabases);
      current=receipt;apiDatabases=ready.apiDatabases;
    },
    async prepare(){
      const ready=await transition('armed','prepared','prepare-interrupted-restoration','INTERRUPTED_RESTORATION_PREPARED',{},240_000);
      profiledReceipt(ready,'P2_PROFILED_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED');demand(sha(ready.authoritySha256));
    },
    async restore(){
      restored=await transition('prepared','restored','restore-runtime','INTERRUPTED_RUNTIME_READY',{},900_000);
      requireProfiledRestored(initial,restored,current,apiDatabases,provenance);return structuredClone(restored);
    },
    async prepareClose(){
      const ready=await transition('restored','closing','prepare-close','INTERRUPTED_CLOSE_PREPARED',{},240_000);
      demand(isDeepStrictEqual(ready,restored));
      writeFrontendReceipt(directory,profiledPrepared,ready);
      preparedRaw=readFrontendReleaseEvidence(directory,profiledPrepared);
      demand(isDeepStrictEqual(decodeQualificationTargetJson(preparedRaw,'carrier'),ready));
    },
  };
  let committed,failure;
  try{
    const ready=expect(0,'LOCKED',90_000,false);child.stdin.write(rawInitial+'\n');await ready;
    heartbeat=setInterval(()=>{if(!failed&&phase!=='committed')void verify().catch(lost);},1000);
    await task(verify,controller.signal,host);
    // The source task owns the real FE session. Its return means unlock and disconnect completed.
    demand(phase==='closing'&&preparedRaw.equals(readFrontendReleaseEvidence(directory,profiledPrepared)));
    const joined=await transition('closing','joined','finish','INTERRUPTED_RESTORATION_JOINED',{restoration:preparedRaw.toString('base64')},30_000);
    demand(isDeepStrictEqual(joined,restored));clearInterval(heartbeat);
    committed=await send('commit','COMMITTED');
  }catch{failure=new Error('P2_PROFILED_INTERRUPTED_RESTORATION_FAILED_REQUIRES_REVIEW');lost();}
  finally{
    clearInterval(heartbeat);child.stdin.end();
    const stop=setTimeout(()=>{lost();child.kill('SIGTERM');},60_000);
    const kill=setTimeout(()=>child.kill('SIGKILL'),65_000);
    await reaped;clearTimeout(stop);clearTimeout(kill);
    if(pending.size)lost();
    if(failed||exit?.code!==0||exit.signal!==null)failure??=new Error('P2_PROFILED_INTERRUPTED_HOST_CLEANUP_UNCERTAIN');
  }
  if(failure)throw failure;
  demand(committed&&phase==='committed');
  writeFrontendReceipt(directory,profiledTerminal,committed);return committed;
}

function runProfiledInterruptedKnownAckRestoration(settings,initial,prepared,directory){
  return withProfiledInterruptedEnvironmentLock(settings,initial,directory,async(verifyEnvironment,signal,host)=>{
    const verifyHost=async()=>{signal.throwIfAborted();assertSourceCheckout(root,initial.sourceCommit);await verifyEnvironment();};
    await withP2ProfiledInterruptedFrontendSession(prepared,initial.reviewedPlan.frontendPlan,
      {getUrl:()=>initial.credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,verifyEnvironment:verifyHost},
      async({verify,receipt,probe,readCurrent})=>{
        writeFrontendReceipt(directory,profiledCurrent,receipt);
        await verify();await host.arm({receipt,probe});await verify();
        await host.prepare();await verify();
        const result=await host.restore(),after=await readCurrent();
        demand(isDeepStrictEqual(after,receipt)&&result.frontendJournalSha256===after.journalSha256);
        await host.prepareClose();
      });
  });
}

export async function p2ProfiledInterruptedKnownAckOperator(settings,{confirmation}={}){
  demand(process.versions.node.split('.')[0]==='24');
  const checked=prepareProfiledInterruptedKnownAckOperator(settings),{original,plan,releaseSettings}=checked;
  demand(confirmation==='staging/'+plan.restorationActionId);
  const directory=join(releaseSettings.results,plan.restorationActionId);
  frontendPrivateReceiptDirectory(releaseSettings.results);demand(lstatSync(directory,{throwIfNoEntry:false})===undefined);
  if(!plan.replacementRelease)verifyP2ProfiledCurrentReleaseConfiguration(original);
  const source=committedProfiledCurrentOperatorSource(root,plan.operatorSourceCommit),packet=profiledInterruptedHostPacket(checked,source);
  const sourceCi=await verifyOperatorCi({api:githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit:plan.operatorSourceCommit,branch:source.branch,workflowBytes:source.workflowBytes});
  const provider=decodeQualificationTargetJson(privateBytes(releaseSettings.providerContext,24_000_000),'private-packet');
  requireQualificationTargetProfile(currentProfile,provider);
  demand(provider.version===2&&typeof provider.vercelToken==='string'&&provider.vercelToken.length>0&&provider.vercelToken.length<=8192);
  const credentials=Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL','COURSE_STAGING_DATABASE_URL','COMMUNITY_STAGING_DATABASE_URL'].map(key=>{
    const value=process.env[key];demand(typeof value==='string'&&value.length>0&&value.length<=16_384);return[key,value];}));
  mkdirSync(directory,{mode:0o700});const diagnostics=join(directory,'ssh');mkdirSync(diagnostics,{mode:0o700});
  writeFrontendReceipt(directory,'reviewed-plan.json',plan);writeFrontendReceipt(directory,'operator-source-ci.json',sourceCi);
  const ssh=await recreationSsh({knownHosts:releaseSettings.knownHosts,keyFile:releaseSettings.sshKey,diagnostics});
  demand((await ssh.machine()).machineId===packet.hostMachineId);
  const installed=await ssh.installProfiledCurrentSource({commit:plan.operatorSourceCommit,files:source.files});
  demand(installed.status==='EXACT_OPERATOR_SOURCE_INSTALLED'&&installed.commit===plan.operatorSourceCommit);
  const initial={...packet,confirmation,credentials,vercelToken:provider.vercelToken};
  return runProfiledInterruptedKnownAckRestoration(releaseSettings,initial,{migration:original.migration,plan:original.inventory},directory);
}

export async function interruptedKnownAckOperator(settings,{apply=false,confirmation}={}){
  demand(process.versions.node.split('.')[0]==='24');const checked=prepareInterruptedKnownAckOperator(settings);if(!apply)return checked.plan;
  demand(confirmation==='staging/'+checked.action.restorationActionId);
  const committed=committedOperatorSource(root,settings.operatorSourceCommit);
  const ci=await verifyOperatorCi({api:githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),sourceCommit:settings.operatorSourceCommit,branch:committed.branch,workflowBytes:committed.workflowBytes});
  const context=object(settings.providerContext,24_000_000);demand(typeof context.vercelToken==='string'&&context.vercelToken.length>0);
  const credentials=Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL','COURSE_STAGING_DATABASE_URL','COMMUNITY_STAGING_DATABASE_URL'].map(key=>{const value=process.env[key];demand(typeof value==='string'&&value.length>0);return[key,value];}));
  frontendPrivateReceiptDirectory(settings.results);const directory=join(settings.results,checked.action.restorationActionId);mkdirSync(directory,{mode:0o700});
  const diagnostics=join(directory,'ssh');mkdirSync(diagnostics,{mode:0o700});writeFileSync(join(directory,'reviewed-plan.json'),JSON.stringify(checked.plan)+'\n',{mode:0o600,flag:'wx'});
  writeFileSync(join(directory,'operator-source-ci.json'),JSON.stringify(ci)+'\n',{mode:0o600,flag:'wx'});
  const ssh=await recreationSsh({knownHosts:settings.knownHosts,keyFile:settings.sshKey,diagnostics});demand((await ssh.machine()).machineId===settings.host.machineId);
  demand((await ssh.installSource({commit:settings.operatorSourceCommit,files:committed.files})).status==='EXACT_OPERATOR_SOURCE_INSTALLED');
  const initial={version:1,environment:'staging',mode:MODE,sourceCommit:settings.operatorSourceCommit,sourceSha256:Object.fromEntries(committed.files.map(file=>[file.path,file.sha256])),
    sourceClosureSha256:hash(JSON.stringify(committed.files.map(file=>[file.path,file.sha256]).sort(([a],[b])=>a<b?-1:a>b?1:0))),
    hostMachineId:settings.host.machineId,candidate:checked.original.candidate,candidateSha256:checked.action.candidateSha256,bundle:settings.host.bundle,configuration:settings.host.configuration,results:settings.host.results,
    configurationSha256:checked.original.configurationSha256,confirmation,credentials,vercelToken:context.vercelToken,recoveryActionId:checked.action.restorationActionId,originalReleaseId:checked.action.originalReleaseId,
    interruptedRestoration:checked.action.interruptedRestoration,priorGatewayReference:checked.action.interruptedRestoration.priorGatewayReference,originalReceiptSha256:checked.action.originalReceiptSha256,
    receiverTargets:settings.receiverTargets,frontendJob:checked.original.job,frontendBaseline:checked.original.baseline,owner:checked.original.prepared.plan.owner,
    historicalLogins:checked.original.prepared.plan.historicalLogins,producers:checked.original.prepared.plan.producers,targetSha256:checked.original.prepared.plan.targetSha256,certification:checked.original.prepared.plan.certification};
  return runInterruptedKnownAckRestoration({prepared:checked.original.prepared,action:checked.action},{directory,getUrl:()=>credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
    assertSource:()=>committedOperatorSource(root,settings.operatorSourceCommit),withEnvironmentLock:interruptedKnownAckEnvironmentLock(settings,initial,directory)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const[operation,path,flag,confirmation]=process.argv.slice(2),profiledApply=operation==='apply-profiled-current';
    demand(['plan','apply','plan-profiled-current','host-plan-profiled-current','apply-profiled-current'].includes(operation)&&typeof path==='string'&&
      (operation==='apply'||profiledApply?flag==='--confirm'&&typeof confirmation==='string':flag===undefined&&confirmation===undefined)&&
      (!profiledApply||process.argv.length===6));
    if(operation.endsWith('-profiled-current')){
      resolveQualificationTargetProfile(currentProfile);
      const settings=decodeQualificationTargetJson(privateBytes(resolve(path)),'private-packet');
      const result=profiledApply?await p2ProfiledInterruptedKnownAckOperator(settings,{confirmation}):
        operation==='plan-profiled-current'?prepareProfiledInterruptedKnownAckOperator(settings).plan:prepareProfiledInterruptedKnownAckHostPacket(settings);
      console.log(JSON.stringify(result));
    }else console.log(JSON.stringify(await interruptedKnownAckOperator(object(resolve(path)),{apply:operation==='apply',confirmation})));
  }catch{console.error('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_FAILED_REQUIRES_REVIEW');process.exitCode=1;}
}
