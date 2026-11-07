import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {prepareFrontendProviderBindings} from './frontend-provider-bindings.mjs';
import {readP2RecoveryForwardScope} from './p2-recovery-current-probe.mjs';
const require=ok=>{if(!ok)throw new Error('P2_RECOVERY_FRONTEND_RECHECK_REFUSED');};
async function invoke(context,operation,expectedStatus){
 const value=await context.getProviderContext();require(typeof value.vercelToken==='string'&&typeof value.privateConfigurationDirectory==='string');
 const runtimeCredential=value.frontendRuntimeDatabaseUrl;
 const selectedProducer=context.plan.runtimeProducerSha256??context.plan.bootstrapCompatibility?.runtimeProducerSha256;
 const candidates=context.plan.producers.filter(row=>row.role.name===context.job.target.runtimeRole&&row.producerSha256===selectedProducer);require(candidates.length===1);
 const expectedWriterBinding={mode:'enforce',targetSha256:context.plan.targetSha256,producerSha256:candidates[0].producerSha256,sourceCommit:context.plan.sourceCommit,roleName:context.job.target.runtimeRole};
 const forward=context.forwardRecoveryScope?await readP2RecoveryForwardScope(context.forwardRecoveryScope,context):null;
 const input={operation,candidate:context.candidate,plan:context.plan,originalDirectory:context.originalDirectory,receiptDirectory:forward?.directory??context.originalDirectory,
   directory:context.directory,privateConfigurationDirectory:forward?context.action.forwardPrivateConfigurationDirectory:value.privateConfigurationDirectory,
   vercelToken:value.vercelToken,expectedWriterBinding};
 require(typeof(operation==='build-forward'?context.verifyMutationScope:context.verifyLockedSession)==='function');
 const verify=operation==='build-forward'?()=>context.verifyMutationScope(runtimeCredential):context.verifyLockedSession;
 if(operation!=='observe')Object.assign(input,{bindings:prepareFrontendProviderBindings(value.bindings,context.plan),action:context.action,
   writerTarget:context.bootstrapRuntimeTarget,frontendRuntimeDatabaseUrl:runtimeCredential,gatewayHost:value.gatewayHost,
   newPrivateConfigurationDirectory:context.action.forwardPrivateConfigurationDirectory});
 await verify();
 const child=spawn('python3',['-I','-u',fileURLToPath(new URL('./host/p2_recovery_frontend_observation.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))});
 let failed=false,result,received=false,processing=Promise.resolve(),total=0,checkpoint=0,killTimer;
 const stop=()=>{if(failed)return;failed=true;child.stdin.destroy();child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);};
 const abort=()=>stop();context.environmentSignal?.addEventListener('abort',abort,{once:true});
 const lines=createInterface({input:child.stdout});child.stderr.resume();child.on('error',stop);child.stdin.on('error',stop);
 lines.on('line',line=>{total+=Buffer.byteLength(line);if(total>2_000_000){stop();return;}
  processing=processing.then(async()=>{require(!failed&&!received);const frame=JSON.parse(line);
   if(frame.type==='checkpoint'){require(frame.id===checkpoint+1);await verify();require(!failed&&!context.environmentSignal?.aborted);checkpoint=frame.id;child.stdin.write(JSON.stringify({type:'continue',id:checkpoint})+'\n');}
   else{require(frame.type==='result'&&frame.value?.status===expectedStatus);result=frame.value;received=true;child.stdin.end();}
  }).catch(stop);
 });
 const timer=setTimeout(stop,operation==='build-forward'?1_200_000:90_000),exit=new Promise(resolve=>{child.once('error',()=>resolve(null));child.once('close',resolve);});
 try{const raw=JSON.stringify(input)+'\n';require(Buffer.byteLength(raw)<=2_000_000);child.stdin.write(raw);const code=await exit;await processing;require(code===0&&!failed&&received);await verify();return result;}
 finally{clearTimeout(timer);clearTimeout(killTimer);lines.close();context.environmentSignal?.removeEventListener('abort',abort);if(child.exitCode===null)child.kill('SIGKILL');}
}
export const observeP2RecoveryFrontend=context=>invoke(context,'observe','P2_RECOVERY_FRONTEND_RUNTIME_VERIFIED');
export const reconcileP2RecoveryForward=context=>invoke(context,'reconcile-forward','P2_RECOVERY_FORWARD_ORIGINAL_RECONCILED');
export const buildP2RecoveryForward=context=>invoke(context,'build-forward','P2_RECOVERY_NEW_BUILD_VERIFIED');
