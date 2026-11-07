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
import {frontendPrivateReceiptDirectory,readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {writeFrontendReceipt} from './frontend-migration.mjs';
import {committedOperatorSource,verifyOperatorCi} from './recreation_source.mjs';
import {githubSourceApi} from './release-inputs.mjs';
import {recreationSsh,sshCommand} from './recreation_ssh.mjs';

export const MODE='known-ack-interrupted-restoration';
export const TERMINAL='p2-known-ack-interrupted-restoration-outcome.json';
export const STATUS='P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED';
export const CAUSAL_FILES=Object.freeze(['recovery-intent.json','baseline.json','domain.json','request-details.json','settlement.json','replacement-authorization.json']);
export const REPLACEMENT_FILES=Object.freeze(['known-ack-replacement-intent.json','known-ack-gateway-replacement-started.json',...Array.from({length:5},(_,i)=>['intent','observed'].map(kind=>`known-ack-stage-${i}-${kind}.json`)).flat()]);
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const demand=ok=>{if(!ok)throw new Error('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_REFUSED');};
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const action=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort());

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
  try{const[operation,path,flag,confirmation]=process.argv.slice(2);demand(['plan','apply'].includes(operation)&&typeof path==='string'&&(operation==='plan'?flag===undefined&&confirmation===undefined:flag==='--confirm'&&typeof confirmation==='string'));
    console.log(JSON.stringify(await interruptedKnownAckOperator(object(resolve(path)),{apply:operation==='apply',confirmation})));
  }catch{console.error('P2_KNOWN_ACK_INTERRUPTED_RESTORATION_FAILED_REQUIRES_REVIEW');process.exitCode=1;}
}
