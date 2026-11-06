// Owned HTTPS only. No inherited environment/configuration/provider URL is read.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historicalSourceSha256 as hash } from '../../../../ops/platform/frontend-historical-source.mjs';
const repository = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/u, '');
const moduleUrl = new URL('../../../../ops/platform/frontend-historical-source.mjs', import.meta.url).href;
const directory = mkdtempSync(join(tmpdir(), 'historical-six-owned-https-'));
const checks = []; let server;
try {
  assert.equal(process.env.FRONTEND_HISTORICAL_SOURCE_OWNED_HTTPS_TEST, 'true');
  const cert = join(directory,'cert.pem'), key = join(directory,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  let scenario, calls = [], statePages = 0;
  server = createServer({cert:readFileSync(cert),key:readFileSync(key)},async(req,res)=>{
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const cmd=JSON.parse(Buffer.concat(chunks).toString()); calls.push(cmd);
    assert.equal(req.method,'POST'); assert.equal(req.url,'/'); assert.equal(req.headers.authorization,'Bearer owned-redis-fixture-token');
    assert.ok(['EXISTS','SCAN'].includes(cmd[0]));
    if(scenario==='401'){res.writeHead(401);res.end('{"private":"must-never-escape"}');return;}
    if(scenario==='redirect'){res.writeHead(302,{location:'https://provider.invalid/forbidden'});res.end();return;}
    let result=0;
    if(cmd[0]==='EXISTS') {
      if(scenario==='scoped'&&cmd[1]==='booking:google-refresh-token:preview-owned')result=1;
      if(scenario==='legacy'&&cmd[1]==='booking:google-refresh-token')result=1;
      if(scenario==='lock'&&cmd[1]==='booking:calendar-lock')result=1;
      if(scenario==='malformed')result='0';
    } else {
      const prefix=cmd[3].slice(0,-1);
      if(scenario==='loop'){result=['1',[prefix+'owned']];}
      else if(scenario==='state'&&cmd[3]==='booking:calendar-oauth-state:*') {
        statePages++; result=cmd[1]==='0'?['1',[prefix+'owned-first']]:['0',[prefix+'owned-second']];
      } else if(scenario==='changing'&&cmd[3]==='booking:lock:*') result=['0',calls.length>6?[prefix+'owned-changed']:[]];
      else result=['0',[]];
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`https://127.0.0.1:${server.address().port}/`;
  const child=`
    import {verifiedSourceRequirements as getter,historicalSourceSha256 as hash,observeHistoricalSourceSqlCredentials as observe,observeHistoricalSourceAlternateStores as stores,deriveHistoricalSourceCapabilityClosures as derive} from ${JSON.stringify(moduleUrl)};
    const sourceCommit='b99d4f346696f897fa6a6729dfcc52d6503fe8d6',requirements=getter(${JSON.stringify(repository)},sourceCommit);
    const environment={KV_REST_API_URL:${JSON.stringify(url)},KV_REST_API_TOKEN:'owned-redis-fixture-token',VERCEL_ENV:'preview-owned'},keyCatalog=Object.keys(environment).sort();
    const provenance={sourceCommit,surfaceSha256:hash('owned-https-surface'),configurationRecordSha256:hash('owned-https-original'),kind:'deployment',immutableReference:'owned-fixture/https-only',entrypoint:null,keyCatalogSha256:hash(keyCatalog)};
    const binding={sourceCommit,surfaceSha256:provenance.surfaceSha256,configurationRecordSha256:provenance.configurationRecordSha256,sourceConfiguration:{...provenance,provenanceSha256:hash(provenance),databaseRoles:[]}};
    const original={sourceCommit,configurationRecordSha256:provenance.configurationRecordSha256,provenance,keyCatalog,environment}; let checkpoints=0;
    try {const sql=await observe(requirements,{binding,originalConfiguration:original,clientsByKey:new Map(),physicalDatabasesByKey:new Map(),verifySession:async()=>{checkpoints++;}});
      const store=await stores(requirements,binding,original,sql); const result=derive(requirements,binding,original,sql,store);
      process.stdout.write(JSON.stringify({status:'observed',store,result,checkpoints}));
    } catch(error) {process.stdout.write(JSON.stringify({status:'refused',message:error.message,checkpoints}));}
  `;
  const run=async name=>{
    scenario=name;calls=[];statePages=0;
    const result=await new Promise((resolve,reject)=>{
      const proc=spawn(process.execPath,['--input-type=module','-e',child],{env:{PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:cert},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';proc.stdout.on('data',b=>stdout+=b);proc.stderr.on('data',b=>stderr+=b);
      proc.once('error',reject);proc.once('close',code=>{try{assert.equal(code,0,stderr);assert.equal(stderr,'');resolve(JSON.parse(stdout));}catch(error){reject(error);}});
    });
    assert.ok(!JSON.stringify(result).includes('owned-redis-fixture-token')); assert.ok(!JSON.stringify(result).includes('must-never-escape'));
    return result;
  };
  for(const name of ['empty','scoped','legacy','lock','state']) {
    const result=await run(name); assert.equal(result.status,'observed');
    assert.equal(result.store.hasRetainedGoogleState,name!=='empty');
    assert.ok(result.result.unresolvedFamilyIds.includes('google.calendar'));assert.ok(result.result.unresolvedFamilyIds.includes('google.oauth'));
    assert.ok(calls.some(c=>c[1]==='booking:google-refresh-token:preview-owned')); assert.ok(calls.some(c=>c[1]==='booking:google-refresh-token'));
    assert.ok(result.checkpoints>=calls.length*2);if(name==='state')assert.equal(statePages,4);
    checks.push({name,requests:calls.length,checkpoints:result.checkpoints,status:'PASS'});
  }
  for(const name of ['401','redirect','malformed','loop','changing']) {
    const result=await run(name);assert.equal(result.status,'refused');assert.equal(result.message,'FRONTEND_HISTORICAL_SOURCE_REFUSED');
    assert.ok(result.checkpoints>=calls.length*2); checks.push({name,requests:calls.length,checkpoints:result.checkpoints,status:'PASS'});
  }
  process.stdout.write(JSON.stringify({status:'HISTORICAL_SIX_OWNED_HTTPS_PASS',fixtureOnly:true,actualHistoricalDeploymentObserved:false,liveProviderCalls:0,
    sourceModuleSha256:hash(readFileSync(new URL('../../../../ops/platform/frontend-historical-source.mjs',import.meta.url))),executedChecks:checks.length,checks},null,2)+'\n');
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(directory,{recursive:true,force:true});
}
