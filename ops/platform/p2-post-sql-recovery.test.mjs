import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,realpathSync,writeFileSync,chmodSync,rmSync,readFileSync,copyFileSync,readdirSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { frontendMigrationArtifact,prepareFrontendMigration } from './frontend-migration.mjs';
import { frontendAdmissionTargetSha256 } from './frontend-admission-bootstrap.mjs';
import { frontendCandidateSurfaces,frontendCoordinationHash as hash,prepareFrontendReleaseInventory } from './frontend-release-inventory.mjs';
import { P2_CERTIFICATION_PROFILE } from './p2-certification-profile.mjs';
import { prepareP2PostSqlRecovery,bindOriginalRecoveryReceipts,p2RecoveryProviderContext } from './p2-post-sql-recovery.mjs';
import { frontendProviderBindingsArtifact,FRONTEND_VERCEL_PROJECT,FRONTEND_VERCEL_TEAM,FRONTEND_VERCEL_REPOSITORY } from './frontend-provider-bindings.mjs';
import {readP2RecoveryForwardScope} from './p2-recovery-current-probe.mjs';
import {createP2RecoveryReceiptDirectories,requireP2RecoveryPrivateDirectories} from './p2-recovery.mjs';
import {frontendReleaseReceiptStore} from './frontend-release-receipts.mjs';

test('operator metadata and SSH diagnostics leave the actual frontend receipt store empty at handoff',()=>{
  const results=realpathSync(mkdtempSync(join(tmpdir(),'p2-recovery-cli-layout-')));chmodSync(results,0o700);
  try{
    const paths=createP2RecoveryReceiptDirectories(results,'owned-layout');
    writeFileSync(join(paths.directory,'reviewed-plan.json'),'{"sourceOnly":true}\n',{mode:0o600});
    writeFileSync(join(paths.directory,'operator-source-ci.json'),'{"fixtureOnly":true}\n',{mode:0o600});
    writeFileSync(join(paths.diagnostics,'owned.log'),'owned diagnostic',{mode:0o600});
    // The old flat CLI handoff fails this real constructor before any lock.
    assert.throws(()=>frontendReleaseReceiptStore(paths.directory),/FRONTEND_RELEASE_RECEIPTS_REFUSED/u);
    assert.deepEqual(readdirSync(paths.frontendDirectory),[]);
    const store=frontendReleaseReceiptStore(paths.frontendDirectory);
    store.record('owned-boundary.json',{sourceOnly:true});
    assert.deepEqual(JSON.parse(readFileSync(join(paths.frontendDirectory,'owned-boundary.json'))),{sourceOnly:true});
    assert.equal(readFileSync(join(paths.directory,'reviewed-plan.json'),'utf8'),'{"sourceOnly":true}\n');
    assert.throws(()=>createP2RecoveryReceiptDirectories(results,'owned-layout'));
    for(const id of ['../escape','bad/action',''])assert.throws(()=>createP2RecoveryReceiptDirectories(results,id));
    assert.deepEqual(readdirSync(results),['owned-layout']);
  }finally{rmSync(results,{recursive:true,force:true});}
});

test('forward private probe directory is canonically disjoint from both common trees and old private tree',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p2-private-boundary-')));chmodSync(root,0o700);
  try{
    const oldParent=join(root,'private-container');mkdirSync(oldParent,{mode:0o700});
    const original=join(root,'original'),directory=join(root,'fresh'),old=join(oldParent,'old-private'),good=join(root,'new-private');
    for(const path of [original,directory,old]){mkdirSync(path,{mode:0o700});mkdirSync(join(path,'nested'),{mode:0o700});writeFileSync(join(path,'unchanged.json'),'{}\n',{mode:0o600});}
    const options={originalDirectory:original,directory,oldPrivateDirectory:old};
    assert.equal(requireP2RecoveryPrivateDirectories(good,options),good);
    for(const path of [original,directory,old,oldParent,root,...[original,directory,old].map(path=>join(path,'nested'))])assert.throws(()=>requireP2RecoveryPrivateDirectories(path,options));
    const alias=join(root,'alias');symlinkSync(original,alias);assert.throws(()=>requireP2RecoveryPrivateDirectories(join(alias,'planned'),options));
    assert.equal(readdirSync(root).includes('new-private'),false);
    for(const path of [original,directory,old])assert.equal(readFileSync(join(path,'unchanged.json'),'utf8'),'{}\n');
  }finally{rmSync(root,{recursive:true,force:true});}
});

function fixture(){
  const sourceInventory={version:2,scope:'candidate-source-only',sourceManifestSha256:'1'.repeat(64),routes:[{file:'src/app/api/owned/route.ts',methods:['POST'],sourceSha256:'2'.repeat(64)}],actionModules:[],renderEntries:[],manualEntries:[],inlineActions:[],deferredSites:[],databaseConstructors:[],schedules:[]};
  const artifact=frontendMigrationArtifact(),phase2={contractPhase:artifact.contractPhase,phase2ContractManifestSha256:artifact.phase2ContractManifestSha256};
  const baseline={version:1,serverMajor:16,sqlArtifactSha256:artifact.sqlArtifactSha256,catalog:Object.fromEntries(['relations','columns','constraints','indexes','triggers','functions','enums','sequences','policies'].map(key=>[key,[]]))};
  const job={version:1,operator:'Dardan',environment:'staging',releaseId:'original-release',sourceCommit:'a'.repeat(40),...phase2,migrationImageDigest:'sha256:'+'b'.repeat(64),contractManifestSha256:artifact.contractManifestSha256,sqlArtifactSha256:artifact.sqlArtifactSha256,schemaBaselineSha256:hash(baseline),recoveryRef:'owned/recovery',target:{host:'owned.invalid',port:5432,database:'owned',user:'operator',runtimeRole:'runtime',serverMajor:16,allowEmptyBootstrap:false,approvedPendingTags:artifact.migrations.map(row=>row.tag)}};
  const candidate={version:2,...phase2,environment:'staging',releaseId:job.releaseId,integration:{state:'passed'},sourceApproval:{mode:'single-operator-dispatch',operatorGithubUserId:'8996309'},sources:{frontend:{repository:'https://github.com/princessdardan/lash-her-frontend.git',commit:job.sourceCommit,requiredChecks:'passed'}},artifacts:{frontendMigration:{image:'ghcr.io/princessdardan/lash-her-platform-frontend-migration@'+job.migrationImageDigest}},contractManifestSha256:artifact.contractManifestSha256,frontendMigration:{...phase2,sourceCommit:job.sourceCommit,sqlArtifactSha256:artifact.sqlArtifactSha256,contractManifestSha256:artifact.contractManifestSha256,schemaBaselines:{16:job.schemaBaselineSha256}}};
  const targetSha256=frontendAdmissionTargetSha256('staging',job.target),producerSha256='5'.repeat(64);
  const inventory={version:1,environment:'staging',actionId:job.releaseId,sourceCommit:job.sourceCommit,targetSha256,sourceInventorySha256:hash(sourceInventory),reviewSha256:'3'.repeat(64),adaptersSha256:'4'.repeat(64),observationBudgetSeconds:300,admissionMode:'existing',expectedEpoch:'1',owner:{name:'admission_owner',oid:'100'},producers:[{producerSha256,role:{name:'runtime',oid:'101'}}],candidateCoverage:frontendCandidateSurfaces(sourceInventory).map(row=>({surfaceSha256:row.surfaceSha256,disposition:'admitted',producerSha256,evidenceSha256:'6'.repeat(64)})),externalSurfaces:['deployment','provider','scheduler','direct-caller'].map((kind,i)=>{const identitySha256=String(i+1).repeat(64);return{kind,identitySha256,surfaceSha256:hash({kind,identitySha256})};}),historicalLogins:{version:1,environment:'staging',actionId:job.releaseId,sourceCommit:job.sourceCommit,clusterScopeSha256:'7'.repeat(64),target:{...job.target,currentRuntimeRole:'runtime',admissionOwnerRole:'admission_owner'},retiredLogins:[{name:'old_runtime',oid:'102'}]},certification:structuredClone(P2_CERTIFICATION_PROFILE),restoration:{version:1,recovery:true,newWork:true,nativeSchedulesEnabled:false,providerIngress:'keep-retired',gatewayBindingSha256:'8'.repeat(64)}};
  const migration=prepareFrontendMigration(candidate,job,baseline,artifact),plan=prepareFrontendReleaseInventory(inventory,migration,sourceInventory),prepared={migration,plan,sourceInventory};
  const candidateBytes=Buffer.from(JSON.stringify(candidate)+'\n'),original=Buffer.from(JSON.stringify({actionId:plan.actionId,sourceCommit:plan.sourceCommit,environment:'staging',targetSha256:plan.targetSha256,inventorySha256:hash(plan),adaptersSha256:plan.adaptersSha256})+'\n');
  const action={version:1,environment:'staging',recoveryActionId:'fresh-recovery',originalReleaseId:plan.actionId,sourceCommit:plan.sourceCommit,candidateSha256:hash(candidateBytes),inventorySha256:hash(plan),configurationSha256:'9'.repeat(64),frontendMode:'reuse-retained-ready',originalReceiptSha256:{'frontend-release-started.json':hash(original),'job-outcome.json':null,'database-receipt.json':null,...Object.fromEntries(['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json','frontend-promotion-started.json','frontend-workload-outcome.json'].map(name=>['vercel/'+name,hash(Buffer.from('{}'))]))}};
  return{prepared,action,candidateBytes,original};
}
function forwardAction(f,reason='prior-build-failed'){
  const originalReceiptSha256=structuredClone(f.action.originalReceiptSha256);
  if(reason==='retained-ready-probe-expired')originalReceiptSha256['vercel/frontend-probe-preparation.json']=hash(Buffer.from('{"probe":"expired"}'));
  else{
    originalReceiptSha256['vercel/frontend-promotion-started.json']=null;
    originalReceiptSha256['vercel/frontend-workload-outcome.json']=null;
  }
  return {...f.action,recoveryActionId:'fresh-forward-'+reason,frontendMode:'reviewed-new-build',forwardReason:reason,
    forwardPrivateConfigurationDirectory:'/private/tmp/p2-forward-'+reason,originalReceiptSha256};
}

test('post-SQL recovery preserves original candidate and pending chain without fabricating absent terminal',()=>{
  const f=fixture(),before=JSON.stringify(f.prepared.migration.job),checked=prepareP2PostSqlRecovery(f.prepared,f.action,f.candidateBytes);
  assert.equal(JSON.stringify(f.prepared.migration.job),before);assert.notEqual(checked.action.recoveryActionId,checked.action.originalReleaseId);
  assert.equal(checked.action.originalReceiptSha256['job-outcome.json'],null);assert.equal(checked.action.failedBuildForwardAction,'OPEN');
  assert.equal(checked.action.sqlReplayAuthorized,false);assert.ok(checked.prepared.migration.job.target.approvedPendingTags.length>0);
});

test('reviewed new build eligibility is exact for failed, canceled and expired retained READY sources',()=>{
  for(const reason of ['prior-build-failed','prior-build-canceled','retained-ready-probe-expired']){
    const f=fixture(),checked=prepareP2PostSqlRecovery(f.prepared,forwardAction(f,reason),f.candidateBytes);
    assert.equal(checked.action.frontendMode,'reviewed-new-build');assert.equal(checked.action.forwardReason,reason);
    assert.equal(checked.action.failedBuildForwardAction,'REVIEWED_NEW_BUILD');assert.equal(checked.action.sqlReplayAuthorized,false);
    assert.equal(checked.action.rolePreparationAuthorized,false);assert.equal(checked.action.historicalLoginsRestored,false);
    assert.equal(checked.action.originalReceiptSha256['job-outcome.json'],null);
  }
});

test('reviewed new build refuses incomplete source history, fabricated prior terminals and unreviewed mode inputs',()=>{
  const f=fixture();
  for(const reason of ['prior-build-failed','prior-build-canceled']){
    const action=forwardAction(f,reason);
    for(const name of ['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json']){
      const changed=structuredClone(action);delete changed.originalReceiptSha256['vercel/'+name];
      assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,changed,f.candidateBytes));
    }
    for(const name of ['frontend-promotion-started.json','frontend-workload-outcome.json']){
      const changed=structuredClone(action);changed.originalReceiptSha256['vercel/'+name]='b'.repeat(64);
      assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,changed,f.candidateBytes));
    }
  }
  const expired=forwardAction(f,'retained-ready-probe-expired');delete expired.originalReceiptSha256['vercel/frontend-probe-preparation.json'];
  assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,expired,f.candidateBytes));
  for(const changes of [{forwardReason:'lost-post-without-id'},{forwardPrivateConfigurationDirectory:'relative/path'},{frontendMode:'retry-build'}]){
    assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,{...forwardAction(f),...changes},f.candidateBytes));
  }
});

test('forward provider context binds the reviewed action and inventory at the adapter boundary',()=>{
  const f=fixture(),checked=prepareP2PostSqlRecovery(f.prepared,forwardAction(f),f.candidateBytes),action=checked.action;
  const context=p2RecoveryProviderContext(checked.prepared,{directory:'/private/tmp/current',originalDirectory:'/private/tmp/original',getProviderContext:async()=>({})},{client:{},verify:async()=>{},environmentSignal:new AbortController().signal,action});
  assert.equal(context.recoveryActionId,action.recoveryActionId);assert.equal(context.action,action);
  assert.equal(context.inventorySha256,checked.prepared.inventorySha256);assert.equal(context.bootstrapRuntimeTarget.user,f.prepared.migration.job.target.runtimeRole);
});

test('serialized forward scope cannot replace a live source-issued recovery session',async()=>{
  await assert.rejects(readP2RecoveryForwardScope({version:1,mode:'reviewed-new-build',recoveryActionId:'invented',held:true},{}));
  await assert.rejects(readP2RecoveryForwardScope(Object.freeze({}),{}));
});

test('candidate bytes, source, original action, inventory, config and deployment retry mode are bounded',()=>{
  const f=fixture();
  for(const changes of [{recoveryActionId:'original-release'},{originalReleaseId:'other'},{sourceCommit:'b'.repeat(40)},{candidateSha256:'b'.repeat(64)},{inventorySha256:'b'.repeat(64)},{configurationSha256:'not-a-digest'},{frontendMode:'retry-build'}])assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,{...f.action,...changes},f.candidateBytes));
  assert.throws(()=>prepareP2PostSqlRecovery(f.prepared,f.action,Buffer.from(JSON.stringify(JSON.parse(f.candidateBytes)))));
});

test('actual retained receipt hashes and actual missing terminal cannot be stale or overwritten',()=>{
  const f=fixture(),directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-recovery-original-')));chmodSync(directory,0o700);
  try{mkdirSync(join(directory,'vercel'),{mode:0o700});for(const name of Object.keys(f.action.originalReceiptSha256).filter(name=>name.startsWith('vercel/')))writeFileSync(join(directory,name),'{}',{mode:0o600});writeFileSync(join(directory,'frontend-release-started.json'),f.original,{mode:0o600});bindOriginalRecoveryReceipts(directory,f.action,f.prepared);
    writeFileSync(join(directory,'job-outcome.json'),'{}',{mode:0o600});assert.throws(()=>bindOriginalRecoveryReceipts(directory,f.action,f.prepared));
    rmSync(join(directory,'job-outcome.json'));writeFileSync(join(directory,'frontend-release-started.json'),Buffer.from('{}'),{mode:0o600});assert.throws(()=>bindOriginalRecoveryReceipts(directory,f.action,f.prepared));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('recovery runtime target reaches the actual shared adapter and Python worker over owned HTTPS',async()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'p2-recovery-adapter-context-'))),source=fileURLToPath(new URL('.',import.meta.url));
  chmodSync(directory,0o700);let server;
  try{
    const cert=join(directory,'ca.pem'),key=join(directory,'key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
    const f=fixture(),identities=[{kind:'deployment',identity:{provider:'vercel',teamId:FRONTEND_VERCEL_TEAM,projectId:FRONTEND_VERCEL_PROJECT,deploymentId:'dpl_previous'}},
      {kind:'scheduler',identity:{provider:'vercel',teamId:FRONTEND_VERCEL_TEAM,projectId:FRONTEND_VERCEL_PROJECT,scheduler:'native-crons'}},
      {kind:'provider',identity:{provider:'square',accountSha256:'c'.repeat(64),credentialBindingSha256:'d'.repeat(64)}},
      {kind:'direct-caller',identity:{provider:'manual',accountSha256:'e'.repeat(64),credentialBindingSha256:'f'.repeat(64)}}];
    const plan={...f.prepared.plan,externalSurfaces:identities.map(row=>({kind:row.kind,identitySha256:hash(row.identity),surfaceSha256:hash({kind:row.kind,identitySha256:hash(row.identity)})})).sort((a,b)=>a.surfaceSha256.localeCompare(b.surfaceSha256))};
    const gatewayObservation={hostMachineId:'1'.repeat(32),releaseId:plan.actionId,candidateSha256:'2'.repeat(64),gatewayConfigurationSha256:'3'.repeat(64),runtimeConfigurationSha256:'4'.repeat(64),gatewayImage:'ghcr.io/princessdardan/lash-her-platform-gateway@sha256:'+'5'.repeat(64)};
    plan.restoration={...plan.restoration,gatewayBindingSha256:hash(gatewayObservation)};
    const deployment={deploymentId:'dpl_previous',sourceCommit:'c'.repeat(40),target:'production',createdAt:10,url:'previous.vercel.app',state:'READY'};
    const bindings=frontendProviderBindingsArtifact({version:1,environment:'staging',actionId:plan.actionId,sourceCommit:plan.sourceCommit,targetSha256:plan.targetSha256,
      teamId:FRONTEND_VERCEL_TEAM,projectId:FRONTEND_VERCEL_PROJECT,repositoryId:FRONTEND_VERCEL_REPOSITORY,projectState:{productionDeploymentId:'dpl_previous',nativeSchedulesEnabled:false},deployments:[deployment],gatewayObservation,
      surfaces:identities.map(row=>({...row,surfaceSha256:plan.externalSurfaces.find(surface=>surface.kind===row.kind).surfaceSha256}))},plan);
    plan.providerBindingsSha256=hash(bindings);
    const prepared={...f.prepared,plan,migration:{...f.prepared.migration,candidate:{...f.prepared.migration.candidate,workload:{projectId:FRONTEND_VERCEL_PROJECT,environment:'production'}}}};
    const requests=[];server=createServer({cert:readFileSync(cert),key:readFileSync(key)},(request,response)=>{
      requests.push([request.method,new URL(request.url,'https://owned.invalid').pathname]);
      assert.equal(request.headers.authorization,'Bearer owned-adapter-context');
      const path=new URL(request.url,'https://owned.invalid').pathname;
      const project={id:FRONTEND_VERCEL_PROJECT,accountId:FRONTEND_VERCEL_TEAM,link:{type:'github',repoId:FRONTEND_VERCEL_REPOSITORY},targets:{production:{id:'dpl_previous'}},crons:{disabledAt:1}};
      response.setHeader('content-type','application/json');
      if(path==='/v9/projects/'+FRONTEND_VERCEL_PROJECT)response.end(JSON.stringify(project));
      else if(path==='/v9/projects')response.end(JSON.stringify({projects:[project],pagination:{count:1,next:null}}));
      else if(path==='/v7/deployments')response.end(JSON.stringify({deployments:[{uid:'dpl_previous',created:10,url:deployment.url,target:'production',state:'READY',gitSource:{sha:deployment.sourceCommit}}],pagination:{count:1,next:null}}));
      else{response.statusCode=404;response.end('{}');}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const platform=join(directory,'app/ops/platform'),host=join(platform,'host');mkdirSync(host,{recursive:true});writeFileSync(join(directory,'app/package.json'),'{"type":"module"}\n');
    for(const name of readdirSync(source).filter(name=>name.endsWith('.mjs'))){if(name==='frontend-release-adapters.mjs')copyFileSync(join(source,name),join(platform,name));else symlinkSync(join(source,name),join(platform,name));}
    const receipts=join(directory,'receipts');mkdirSync(receipts,{mode:0o700});let verified=0;
    const context={plan,...p2RecoveryProviderContext(prepared,{directory:receipts,getProviderContext:async()=>({bindings,vercelToken:'owned-adapter-context'})},{client:{},verify:async()=>{verified++;}})};
    const expected=context.bootstrapRuntimeTarget;
    writeFileSync(join(host,'frontend_release_adapters.py'),`import sys,json,ssl\nsys.path.insert(0,${JSON.stringify(join(source,'host'))})\nimport frontend_release_adapters as actual\nactual.vercel.API_ORIGIN=${JSON.stringify('https://127.0.0.1:'+server.address().port)}\noriginal_ssl=ssl.create_default_context\nssl.create_default_context=lambda *args,**kwargs: original_ssl(cafile=${JSON.stringify(cert)})\noriginal_execute=actual.execute\ndef checked(context,client,verify,probe=None):\n    assert context['writerTarget']==json.loads(${JSON.stringify(JSON.stringify(expected))})\n    return original_execute(context,client,verify,probe)\nactual.execute=checked\nactual.main()\n`);
    const adapter=await import(pathToFileURL(join(platform,'frontend-release-adapters.mjs')).href);
    let observed;try{observed=await adapter.runFrontendVercelWorker('observe-vercel',context);}catch(error){throw new Error('OWNED_ADAPTER_CONTEXT_FAILURE '+JSON.stringify({verified,requests}),{cause:error});}
    assert.equal(observed.status,'VERCEL_STAGING_METADATA_OBSERVED');assert.equal(observed.reviewedInventoryMatches,true);assert.equal(observed.reviewedProjectMatches,true);
    assert.ok(verified>=3);assert.ok(requests.length>=4);assert.ok(requests.every(([method])=>method==='GET'));
    const count=requests.length;await assert.rejects(adapter.runFrontendVercelWorker('observe-vercel',{...context,bootstrapRuntimeTarget:undefined}));assert.equal(requests.length,count);
    assert.equal(expected.user,prepared.migration.job.target.runtimeRole);assert.notEqual(expected.user,prepared.migration.job.target.user);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
