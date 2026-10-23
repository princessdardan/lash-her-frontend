import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const privateDirIndex=process.argv.indexOf('--private-dir');
const dir=privateDirIndex<0?'/private/tmp/lash-her-p1-02-staging':process.argv[privateDirIndex+1];
assert(dir?.startsWith('/'), 'An absolute private directory is required');
const privateDirectory=fs.statSync(dir);
assert(privateDirectory.isDirectory() && privateDirectory.uid===process.getuid(), 'Private directory owner mismatch');
assert.equal(privateDirectory.mode & 0o077,0,'Private directory must be mode 0700');
const projectId='prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',teamId='team_2Hrn5eMZyZxfAWdmYvyKi9t3';
const cli='/Users/dardan/.npm/_npx/ce0d8c019a05051b/node_modules/vercel/dist/vc.js';
function api(route,method='GET',body){
 const args=[cli,'api',route+(route.includes('?')?'&':'?')+'teamId='+teamId,'--method',method];let file;
 if(body){file=dir+'/ingress-request-'+crypto.randomUUID()+'.json';fs.writeFileSync(file,JSON.stringify(Array.isArray(body)?JSON.stringify(body):body),{mode:0o600});args.push('--header','Content-Type: application/json','--input',file);}
 try{const r=spawnSync(process.execPath,args,{cwd:dir,encoding:'utf8',maxBuffer:3e6});if(r.status!==0){const filtered=(r.stderr??'').replace(/[a-f0-9]{32,}/gi,'[redacted]');console.error(JSON.stringify({operation:method,route:route.split('?')[0],status:r.status,detail:filtered.slice(0,1200)}));throw new Error('Vercel private API request failed');}return JSON.parse(r.stdout);}finally{if(file)fs.rmSync(file,{force:true});}
}
try{
 const project=api('/v9/projects/'+projectId);assert.equal(project.id,projectId);assert.equal(project.accountId,teamId);assert.equal(project.ssoProtection.deploymentType,'all');
 const plan={projectId,teamId,providers:['square','sanity','resend'],allDeploymentAuthenticationRetained:true,platformCredentialScope:'all-deployments-in-this-staging-project; not-path-scoped',providerSignatureVerificationRequired:true,mandatorySystemEnvironmentVariable:'VERCEL_AUTOMATION_BYPASS_SECRET',selectedEnvironmentProvider:'square',registrationEnabled:false,applicationDeploymentCreated:false,delivery:{square:'private exact notification URL with x-vercel-protection-bypass query',sanity:'private x-vercel-protection-bypass header',resend:'private exact endpoint URL with x-vercel-protection-bypass query'},risk:'Each provider token can bypass platform authentication and some firewall/bot checks throughout the staging project. Treat URLs, provider settings and keys as secrets.'};
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({dryRun:true,...plan}));process.exit(0);}
 const file=dir+'/webhook-ingress-secrets-v2.json';const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
 for(const provider of plan.providers){
  state[provider]??={bypassSecret:crypto.randomBytes(16).toString('hex'),note:'Lash Her staging '+provider+' webhook ingress - provider signatures still required'};
  if(state[provider].bypassSecret.length!==32){assert(!project.protectionBypass?.[state[provider].bypassSecret], 'Do not replace an active credential without reviewed rotation');state[provider].bypassSecret=crypto.randomBytes(16).toString('hex');}
  fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});fs.chmodSync(file,0o600);
  const key=state[provider].bypassSecret;
  if(!project.protectionBypass?.[key])api('/v1/projects/'+projectId+'/protection-bypass','PATCH',{generate:{secret:key,note:state[provider].note}});

 }
 api('/v1/projects/'+projectId+'/protection-bypass','PATCH',{update:{secret:state.square.bypassSecret,note:state.square.note,isEnvVar:true}});
 for(const provider of ['sanity','resend'])api('/v1/projects/'+projectId+'/protection-bypass','PATCH',{update:{secret:state[provider].bypassSecret,note:state[provider].note,isEnvVar:false}});
 const result=api('/v9/projects/'+projectId);assert.equal(result.ssoProtection.deploymentType,'all');
 for(const provider of plan.providers){const value=result.protectionBypass?.[state[provider].bypassSecret];assert(value,'Provider bypass missing');assert.equal(value.isEnvVar??false,provider==='square');}
 const squareUrl=new URL('https://staging.lashher.com/api/webhooks/square');squareUrl.searchParams.set('x-vercel-protection-bypass',state.square.bypassSecret);
 const resendUrl=new URL('https://staging.lashher.com/api/webhooks/resend');resendUrl.searchParams.set('x-vercel-protection-bypass',state.resend.bypassSecret);state.resend.endpoint=resendUrl.toString();state.square.notificationUrl=squareUrl.toString();state.sanity.headers={'x-vercel-protection-bypass':state.sanity.bypassSecret};
 fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});
 // Save only public scope metadata; registration and deployment remain held.
 fs.writeFileSync('/Users/dardan/workspace/lash-her-frontend/ops/staging/webhook-ingress.json',JSON.stringify({...plan,status:'platform-tokens-configured-registration-and-deployment-pending',tokensConfigured:true,tokensInjectedIntoDeploymentEnvironment:true,selectedEnvironmentProvider:'square',lastVerifiedAt:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify({...plan,tokensConfigured:true,tokensInjectedIntoDeploymentEnvironment:true,selectedEnvironmentProvider:'square',valuesLogged:false}));
}catch(error){console.error(JSON.stringify({error:'Private staging ingress configuration failed',class:error.name,valuesWithheld:true}));process.exitCode=1;}
