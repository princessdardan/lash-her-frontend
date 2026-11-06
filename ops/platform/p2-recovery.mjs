#!/usr/bin/env node
// Plan-default supplemental operator tooling; the original application stays pinned.
import { readFileSync, mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareP2OperatorRelease } from './p2-release.mjs';
import { prepareP2PostSqlRecovery, bindOriginalRecoveryReceipts, runP2PostSqlRecovery } from './p2-post-sql-recovery.mjs';
import { frontendCoordinationHash as hash } from './frontend-release-inventory.mjs';
import { frontendPrivateReceiptDirectory } from './frontend-release-receipts.mjs';
import { committedOperatorSource, verifyOperatorCi } from './recreation_source.mjs';
import { githubSourceApi } from './release-inputs.mjs';
import { recreationSsh } from './recreation_ssh.mjs';
import { p2RecoveryEnvironmentLock } from './p2-recovery-transport.mjs';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = ok => { if (!ok) throw new Error('P2_RECOVERY_OPERATOR_REFUSED'); };
function bytes(path,maximum=2_000_000) {
  require(resolve(path) === path && realpathSync(path) === path); frontendPrivateReceiptDirectory(dirname(path));
  const info = lstatSync(path); require(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= maximum);
  return readFileSync(path);
}
function object(path,maximum) { const value=JSON.parse(bytes(path,maximum)); require(value && typeof value === 'object' && !Array.isArray(value)); return value; }
export function prepareP2RecoveryOperator(settings) {
  require(settings?.version === 1 && settings.environment === 'staging' && /^[a-f0-9]{40}$/u.test(settings.operatorSourceCommit ?? ''));
  const candidateBytes=bytes(join(settings.bundle,'release.candidate.json')), candidate=JSON.parse(candidateBytes);
  const original=prepareP2OperatorRelease({ ...settings, sourceCommit: candidate.sources.frontend.commit });
  require(original.prepared && original.roles === undefined);
  const selected=prepareP2PostSqlRecovery(original.prepared,settings.recovery,candidateBytes);
  require(selected.action.configurationSha256 === hash(original.configurationSha256));
  bindOriginalRecoveryReceipts(settings.originalDirectory,selected.action,selected.prepared);
  return { ...selected, candidateBytes, original, plan: { ...selected.action, operation:'p2-post-sql-deliberate-recovery', operatorSourceCommit:settings.operatorSourceCommit,
    originalSources:candidate.sources, frontendTarget:original.job.target, featureProfile:original.prepared.plan.certification,
    runtimeServices:10, frontendMode:'reuse-retained-ready', nativeSchedulesEnabled:false, trafficAuthorized:false,
    failedBuildForwardAction:'OPEN', approval:'Dardan starts this exact reviewed staging recovery action' } };
}

export async function p2RecoveryOperator(settings,{apply=false,confirmation}={}) {
  require(process.versions.node.split('.')[0] === '24'); const checked=prepareP2RecoveryOperator(settings);
  if(!apply)return checked.plan;
  require(confirmation === 'staging/'+checked.action.recoveryActionId);
  const committed=committedOperatorSource(root,settings.operatorSourceCommit);
  const ci=await verifyOperatorCi({api:githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),sourceCommit:settings.operatorSourceCommit,branch:committed.branch,workflowBytes:committed.workflowBytes});
  frontendPrivateReceiptDirectory(settings.results); const directory=join(settings.results,checked.action.recoveryActionId);mkdirSync(directory,{mode:0o700});
  const diagnostics=join(directory,'ssh');mkdirSync(diagnostics,{mode:0o700});
  writeFileSync(join(directory,'reviewed-plan.json'),JSON.stringify(checked.plan)+'\n',{mode:0o600,flag:'wx'});
  writeFileSync(join(directory,'operator-source-ci.json'),JSON.stringify(ci)+'\n',{mode:0o600,flag:'wx'});
  const context=object(settings.providerContext,24_000_000),credentials=Object.fromEntries(['FRONTEND_STAGING_MIGRATION_DATABASE_URL','COURSE_STAGING_DATABASE_URL','COMMUNITY_STAGING_DATABASE_URL'].map(key=>{
    const value=process.env[key];require(typeof value==='string'&&value.length>0);return[key,value];}));
  require(typeof context.vercelToken==='string'&&context.vercelToken.length>0);
  const ssh=await recreationSsh({knownHosts:settings.knownHosts,keyFile:settings.sshKey,diagnostics});
  require((await ssh.machine()).machineId===settings.host.machineId);
  const installed=await ssh.installSource({commit:settings.operatorSourceCommit,files:committed.files});require(installed.commit===settings.operatorSourceCommit&&installed.status==='EXACT_OPERATOR_SOURCE_INSTALLED');
  const initial={version:1,environment:'staging',mode:'p2-post-sql-recovery',sourceCommit:settings.operatorSourceCommit,
    sourceSha256:Object.fromEntries(committed.files.map(file=>[file.path,file.sha256])),
    sourceClosureSha256:hash(JSON.stringify(committed.files.map(file=>[file.path,file.sha256]).sort(([a],[b])=>a<b?-1:a>b?1:0))),
    hostMachineId:settings.host.machineId,candidate:checked.original.candidate,candidateSha256:checked.action.candidateSha256,
    bundle:settings.host.bundle,configuration:settings.host.configuration,results:settings.host.results,
    configurationSha256:checked.original.configurationSha256,configurationBindingSha256:checked.action.configurationSha256,
    confirmation,credentials,vercelToken:context.vercelToken,recoveryActionId:checked.action.recoveryActionId,originalReleaseId:checked.action.originalReleaseId,
    originalReceiptSha256:checked.action.originalReceiptSha256,frontendJob:checked.original.job,frontendBaseline:checked.original.baseline,
    expectedWriterAdmissionBinding:checked.original.plan.writerAdmissionBinding,owner:checked.prepared.plan.owner,historicalLogins:checked.prepared.plan.historicalLogins,producers:checked.prepared.plan.producers,targetSha256:checked.prepared.plan.targetSha256,certification:checked.prepared.plan.certification,
    gatewayObservation:context.bindings?.gatewayObservation};
  require(hash(initial.gatewayObservation)===checked.prepared.plan.restoration.gatewayBindingSha256);
  return runP2PostSqlRecovery({prepared:checked.prepared,action:checked.action,candidateBytes:checked.candidateBytes},{confirmation,directory,originalDirectory:settings.originalDirectory,
    operatorSourceCommit:settings.operatorSourceCommit,getUrl:()=>credentials.FRONTEND_STAGING_MIGRATION_DATABASE_URL,getProviderContext:async()=>context,
    withRecoveryEnvironmentLock:p2RecoveryEnvironmentLock(settings,initial,directory),
    assertSource:()=>committedOperatorSource(root,settings.operatorSourceCommit)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const[operation,path,flag,confirmation]=process.argv.slice(2);require(['plan','apply'].includes(operation)&&typeof path==='string'&&(operation==='plan'?flag===undefined&&confirmation===undefined:flag==='--confirm'&&typeof confirmation==='string'));
    console.log(JSON.stringify(await p2RecoveryOperator(object(resolve(path)),{apply:operation==='apply',confirmation})));
  }catch{console.error('P2_POST_SQL_RECOVERY_FAILED_REQUIRES_REVIEW');process.exitCode=1;}
}
