// Fixed SSH broker. Only source methods are exposed; no commands from JSON.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFrontendReceipt} from './frontend-migration.mjs';
import {readFrontendReleaseEvidence} from './frontend-release-receipts.mjs';
import {sshCommand} from './recreation_ssh.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateP2CanonicalBrowserObservation} from './p2-canonical-browser-origin.mjs';
import {p2NativeHash} from './p2-lifecycle-native.mjs';

const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_TRANSPORT_REFUSED');};
const MAXIMUM=4_000_000;
const suspensionStages=new WeakMap();
const authenticationStages=new WeakMap();
const workerStages=new WeakMap();
const knownAckStages=new WeakMap();

export function readP2CertificationKnownAckStage(handle,plan){
  const selected=knownAckStages.get(handle);demand(selected&&selected.plan===plan&&selected.active()&&isDeepStrictEqual(selected.snapshot,plan));
  return selected.methods;
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

export function p2CertificationEnvironmentLock(settings,initial,directory,{launch=spawn}={}){
  demand(initial?.environment==='staging'&&initial.mode==='p2-bounded-certification'&&/^[a-f0-9]{40}$/u.test(initial.sourceCommit??''));
  const command=['sudo','-n','/usr/bin/python3','-I','-u',`/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_certification_parent.py`,'--supervisor'];
  return async task=>{
    const child=launch('/usr/bin/ssh',sshCommand({knownHosts:settings.knownHosts,keyFile:settings.sshKey},command),
      {stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))});
    const controller=new AbortController(),pending=new Map();let sequence=0,failed=false,active=true,exited,heartbeat,joined,armed=false,prepared=false,browserOpened=false;
    const fail=()=>{if(failed)return;failed=true;controller.abort();for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('P2_CERTIFICATION_REMOTE_LOST'));}pending.clear();child.stdin.end();};
    const lines=createInterface({input:child.stdout});
    lines.on('line',raw=>{try{demand(Buffer.byteLength(raw)<=MAXIMUM);const value=JSON.parse(raw),waiter=pending.get(value.id);demand(waiter&&value.status===waiter.status);pending.delete(value.id);clearTimeout(waiter.timer);waiter.resolve(value);}catch{fail();}});
    // Remote errors may contain credentials. Retain neither raw stderr nor
    // exception text; the independent host guard retains sanitized outcomes.
    child.stderr.resume();child.on('error',fail);child.stdin.on('error',fail);child.on('exit',code=>{exited=code;if(active||code!==0)fail();});
    const expect=(id,status,timeout)=>new Promise((resolve,reject)=>{demand(!failed&&!pending.has(id));const timer=setTimeout(()=>{fail();reject(new Error('P2_CERTIFICATION_REMOTE_UNCERTAIN'));},timeout);pending.set(id,{status,resolve,reject,timer});});
    const request=(operation,status,data={},timeout=90_000)=>{demand(!failed&&active);const id=++sequence,raw=JSON.stringify({id,operation,...data});demand(Buffer.byteLength(raw)<=MAXIMUM);const promise=expect(id,status,timeout);child.stdin.write(raw+'\n');return promise;};
    const ready=expect(0,'LOCKED',60_000),raw=JSON.stringify(initial);demand(Buffer.byteLength(raw)<=MAXIMUM);child.stdin.write(raw+'\n');
    let result,error;
    try{
      await ready;const verify=async()=>{await request('check','HELD');};heartbeat=setInterval(()=>{if(!failed)void verify().catch(fail);},1000);
      const nativePlan=initial.nativePlan;
      const match=plan=>demand(plan?.planSha256===nativePlan.planSha256);
      const host={mode:'p2-bounded-certification',certificationActionId:initial.certificationActionId,
        async arm({receipt,probe}){demand(!armed);const bytes=readFrontendReleaseEvidence(directory,'p2-certification-current-database.json');demand(JSON.stringify(JSON.parse(bytes))===JSON.stringify(receipt));
          const value=await request('arm-certification','CERTIFICATION_ARMED',{receipt:bytes.toString('base64'),probe},240_000);armed=true;return value.receipt;},
        nativeControl:{
          async observe(plan){match(plan);demand(armed&&!prepared);return(await request('native-observe','CERTIFICATION_NATIVE_OBSERVED')).receipt;},
          async observeMetadata(plan){match(plan);demand(armed&&!prepared);return(await request('native-metadata','CERTIFICATION_NATIVE_OBSERVED')).receipt;},
          async setEnabled(plan,enabled){match(plan);demand(armed&&!prepared&&typeof enabled==='boolean');return(await request('native-toggle','CERTIFICATION_NATIVE_OBSERVED',{enabled},120_000)).receipt;},
        },
        async gatewayStage(stage){demand(armed&&!prepared&&['closed','recovery','browser'].includes(stage));const receipt=(await request('certification-gateway-stage','CERTIFICATION_GATEWAY_OBSERVED',{stage})).receipt;
          browserOpened=stage==='browser'&&receipt?.gateway?.newWork===true&&receipt?.gateway?.recovery===false;return receipt;},
        async observeGateway(){demand(armed&&!prepared);return(await request('certification-gateway-observe','CERTIFICATION_GATEWAY_OBSERVED')).receipt;},
        async authenticationStage(plan,browserController){
          demand(launch===spawn&&armed&&!prepared&&browserOpened&&initial.certificationPlan.mode==='auth-preparation'&&isDeepStrictEqual(plan,initial.browserPlan));
          const readers=await import('./p2-lifecycle-suspension-evidence.mjs'),binding=readers.readP2LifecycleBrowserControllerBinding(plan,browserController);
          demand(binding.challenge===initial.sourceParentChallenge);await verify();
          const receipt=(await request('authentication-stage','CERTIFICATION_AUTHENTICATION_HELD',{bindingSha256:binding.bindingSha256})).receipt;
          demand(receipt.status==='P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD'&&receipt.bindingSha256===binding.bindingSha256&&receipt.certificationActionId===initial.certificationActionId);
          validateP2CanonicalBrowserObservation(plan,receipt.canonicalBrowserObservation);
          demand(p2NativeHash(receipt.canonicalBrowserObservation)===receipt.canonicalBrowserObservationSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&browserOpened&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          const handle=Object.freeze({});authenticationStages.set(handle,{plan,snapshot,active:alive,receipt});return handle;
        },
        async suspensionEvidenceStage(plan,browserController){
          demand(launch===spawn&&armed&&!prepared&&initial.certificationPlan.mode==='browser-pending'&&isDeepStrictEqual(plan,initial.browserPlan));
          const readers=await import('./p2-lifecycle-suspension-evidence.mjs');
          const binding=readers.readP2LifecycleBrowserControllerBinding(plan,browserController);
          demand(binding.challenge===initial.sourceParentChallenge);
          const ready=await request('suspension-ready','CERTIFICATION_SUSPENSION_READY',{bindingSha256:binding.bindingSha256});
          demand(ready.receipt?.bindingSha256===binding.bindingSha256);
          validateP2CanonicalBrowserObservation(plan,ready.receipt.canonicalBrowserObservation);
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
          demand(launch===spawn&&armed&&!prepared&&initial.certificationPlan.mode==='direct-worker'&&isDeepStrictEqual(plan,initial.workerPlan));
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
          const ready=(await request('known-prepare','CERTIFICATION_KNOWN_ACK_OBSERVED',{},180_000)).receipt;
          demand(ready.status==='P2_KNOWN_ACK_SOURCE_STAGE_PREPARED'&&ready.bindingSha256===plan.planSha256);
          const snapshot=structuredClone(plan),alive=()=>active&&!failed&&armed&&!prepared&&!controller.signal.aborted&&isDeepStrictEqual(plan,snapshot);
          const call=async(operation,data={},timeout=180_000)=>{demand(alive());return(await request(operation,'CERTIFICATION_KNOWN_ACK_OBSERVED',data,timeout)).receipt;};
          let replacementAttempted=false;
          const methods=Object.freeze({armFault:()=>call('known-arm'),startWindow:()=>call('known-start-window'),observeDomain:()=>call('known-domain'),
            retainRequestDetails:bytes=>{demand(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=2_000_000);return call('known-requests',{requestArtifact:bytes.toString('base64')});},
            prepareSettlement:()=>call('known-settlement'),replace:()=>{demand(!replacementAttempted);replacementAttempted=true;return call('known-replace',{},800_000);}});
          const handle=Object.freeze({});knownAckStages.set(handle,{plan,snapshot,active:alive,methods});return handle;
        },
        async prepareFault(plan){demand(armed&&!prepared);await request('fault-initialize','CERTIFICATION_FAULT_READY',{plan});
          const call=async(operation,data={})=>(await request(operation,'CERTIFICATION_FAULT_OBSERVED',{plan,...data})).receipt;
          return{verify:async()=>{await call('fault-verify');},observe:()=>call('fault-observe'),arm:(_plan,record)=>call('fault-arm',{record}),effects:()=>call('fault-effects'),
            disarm:()=>call('fault-disarm'),closeGateway:()=>call('fault-close-gateway')};},
        async prepareClose(caseOutcome,requestEvidence){demand(armed&&!prepared);const value=await request('certification-prepare-close','CERTIFICATION_CLOSE_PREPARED',{caseOutcome,requestEvidence},240_000);prepared=true;return value.receipt;},
        async finish(outcome){demand(prepared);const bytes=readFrontendReleaseEvidence(directory,'p2-certification-outcome.json');demand(JSON.stringify(JSON.parse(bytes))===JSON.stringify(outcome));
          joined=await request('finish','P2_CERTIFICATION_JOINED',{certification:bytes.toString('base64')});return joined.receipt;},
        failClosed:fail,
      };
      await verify();result=await task(verify,controller.signal,host);await verify();demand(joined&&!failed);
      const committed=await request('commit','COMMITTED');demand(JSON.stringify(committed.receipt)===JSON.stringify(joined.receipt));
      writeFrontendReceipt(directory,'p2-host-certification-outcome.json',committed.receipt);active=false;
    }catch{error=new Error('P2_BOUNDED_CERTIFICATION_FAILED_REQUIRES_REVIEW');fail();}
    finally{
      clearInterval(heartbeat);child.stdin.end();
      if(exited===undefined)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGTERM');error??=new Error('P2_CERTIFICATION_HOST_CLEANUP_UNCERTAIN');resolve();},60_000);child.once('close',()=>{clearTimeout(timer);resolve();});});
      active=false;lines.close();for(const waiter of pending.values())clearTimeout(waiter.timer);
      if(exited!==0)error??=new Error('P2_CERTIFICATION_HOST_CLEANUP_UNCERTAIN');
    }
    if(error)throw error;return result;
  };
}
