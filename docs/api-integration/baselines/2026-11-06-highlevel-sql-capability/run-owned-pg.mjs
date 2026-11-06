// Owned loopback fixture only. Never reads a configured database URL or provider credential.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {chmodSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {join,posix} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from 'pg';
import {historicalSourceSha256 as hash,verifiedSourceRequirements,historicalSourceOriginalValueKeys} from '../../../../ops/platform/frontend-historical-source.mjs';
import {observeFrontendHistoricalSourceContexts} from '../../../../ops/platform/frontend-historical-source-observer.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url)).replace(/\/$/u,''),require=createRequire(new URL('../../../../package.json',import.meta.url));
const sourceCommit='b99d4f346696f897fa6a6729dfcc52d6503fe8d6',source=verifiedSourceRequirements(root,sourceCommit);
const execute=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const digest=raw=>createHash('sha256').update(raw).digest('hex');
let phase='ownership';
async function main(){
 assert.equal(process.env.FRONTEND_HISTORICAL_SOURCE_OWNED_TEST,'true');
 const binaries=process.env.PG_BIN,major=Number(process.env.OWNED_POSTGRES_MAJOR??16);assert.ok(binaries?.startsWith('/')&&[16,18].includes(major));
 assert.match(execute(join(binaries,'postgres'),['--version']),new RegExp(`PostgreSQL\\) ${major}\\.`,'u'));
 const listener=createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const directory=mkdtempSync(join(tmpdir(),'owned-highlevel-sql-')),data=join(directory,'data'),password='owned-'+randomUUID();
 const clients=[],checks=[],loadedSources=new Map();let started=false,providerCalls=0;
 const check=(name,fn)=>{fn();checks.push(name);};
 const names=['AUTH_SECRET','HIGHLEVEL_CLIENT_ID','HIGHLEVEL_CLIENT_SECRET','HIGHLEVEL_LOCATION_ID','HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY','VERCEL_ENV','NODE_ENV'];
 const originalFetch=globalThis.fetch;
 try{
  phase='cluster-initdb';execute(join(binaries,'initdb'),['-D',data,'-A','trust','-U','owned_admin','-E','UTF8','--locale=C']);
  phase='cluster-openssl';const certificate=join(directory,'server.crt'),key=join(directory,'server.key');execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',certificate]);chmodSync(key,0o600);
  writeFileSync(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
  writeFileSync(join(data,'pg_hba.conf'),'hostssl all owned_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n');phase='cluster-start';execute(join(binaries,'pg_ctl'),['-D',data,'-l',join(directory,'postgres.log'),'-w','start']);started=true;
  const ssl={rejectUnauthorized:true,ca:readFileSync(certificate,'utf8')};
  const connect=async(user='owned_admin')=>{const c=new Client({host:'127.0.0.1',port,database:'postgres',user,password,ssl});clients.push(c);await c.connect();assert.equal(c.connection.stream.authorized,true);return c;};
  const parent=await connect(),pid=(await parent.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  phase='migrations';const journal=JSON.parse(readFileSync(new URL('../../../../drizzle/meta/_journal.json',import.meta.url)));
  for(const entry of journal.entries)for(const statement of readFileSync(new URL('../../../../drizzle/'+entry.tag+'.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await parent.query(statement);
  await parent.query(`CREATE ROLE owned_hl_writer LOGIN NOINHERIT PASSWORD '${password}'; GRANT USAGE ON SCHEMA public TO owned_hl_writer; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO owned_hl_writer; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO owned_hl_writer`);
  const oid=(await parent.query("SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname='owned_hl_writer'")).rows[0].oid;
  const writer=await connect('owned_hl_writer');assert.equal((await writer.query("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly,'off');
  const url=`postgresql://owned_hl_writer:${password}@127.0.0.1:${port}/postgres?sslmode=verify-full`,keyCatalog=['AUTH_SECRET','DATABASE_URL'],surfaceSha256=hash('owned-hl-sql-surface'),configurationRecordSha256=hash('owned-hl-sql-record');
  const provenance={sourceCommit,surfaceSha256,configurationRecordSha256,kind:'deployment',immutableReference:'owned:hl-sql-record',entrypoint:null,keyCatalogSha256:hash(keyCatalog)};
  const binding={sourceCommit,surfaceSha256,configurationRecordSha256,providerCredentials:[],sourceConfiguration:{...provenance,provenanceSha256:hash(provenance),databaseRoles:[{key:'DATABASE_URL',name:'owned_hl_writer',oid}]}};
  const original={sourceCommit,configurationRecordSha256,provenance,keyCatalog,environment:{DATABASE_URL:url}};
  const verify=async()=>assert.equal((await parent.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pid);
  const context={databaseClient:parent,verifyLockedSession:verify,getProviderContext:async()=>{},plan:{actionId:'owned-hl-sql',sourceCommit:'a'.repeat(40),targetSha256:hash('owned-target'),providerBindingsSha256:hash('owned-bindings'),historicalLogins:{retiredLogins:[{name:'owned_hl_writer',oid}]}}};
  const bindings={projectId:'owned-staging',surfaces:[{surfaceSha256,kind:'deployment',identity:{provider:'vercel',projectId:'owned-staging',deploymentId:'dpl_owned'}}],historicalRuntimeBindings:[binding]};
  phase='actual-observer';const observation=await observeFrontendHistoricalSourceContexts(context,bindings,{historicalRuntimeConfigurations:{[surfaceSha256]:original}},{createClient(options){return new Client({...options,ssl});}});
  const facts=observation.bindings[0];
  check('actual-tls-scram-role-and-parent-marker-observation',()=>{assert.equal(facts.sqlPhysicalBindings[0].sameSelectedPhysicalDatabase,true);assert.equal(facts.sqlEvidence.facts.find(r=>r.key==='DATABASE_URL').role.oid,oid);});
  check('only-database-url-value-projected',()=>assert.deepEqual(historicalSourceOriginalValueKeys(source,binding,original),['DATABASE_URL']));
  check('outbound-only-facts-leave-seven-sql-families-unresolved',()=>{assert.equal(facts.requirements.unresolvedFrontendSqlFamilyIds.filter(id=>id.startsWith('highlevel.')).length,7);assert.equal(facts.outboundCredentialExclusions.length,7);});
  check('missing-location-preserves-webhook-http-exclusion',()=>assert.ok(facts.requirements.capabilityClosures.some(r=>r.familyId==='highlevel.webhooks')));
  const helperCode="import sys,json\nsys.path.insert(0,sys.argv[1])\nimport frontend_highlevel_history as h\ns=json.load(sys.stdin)\nrows={name:([{'contacts':0,'effects':0,'connections':0,'webhooks':0}] if name=='historyGlobalScope' else []) for name in h.COLUMNS}\ntry:\n r=h.observe_scoped_effects(None,{'environment':'staging','sourceBindingSha256':s['configurationRecordSha256'],'historicalSourceCommit':s['sourceCommit'],'historyDatabaseSnapshotSha256':h.sha256(rows)},rows,s)\n print(json.dumps({'zero':r.get('activeExecutions')==0 and r.get('uncertainEffects')==0}))\nexcept ValueError as error:\n print(json.dumps({'zero':False,'refusal':str(error)}))\n";
  const helper=JSON.parse(execFileSync('python3',['-I','-c',helperCode,join(root,'ops/platform/host')],{input:JSON.stringify(facts.requirements),encoding:'utf8',env:Object.fromEntries(['PATH','HOME','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))}));
  check('actual-highlevel-helper-refuses-zero-from-outbound-only-facts',()=>assert.deepEqual(helper,{zero:false,refusal:'HIGHLEVEL_HISTORY_ACTUAL_PRINCIPAL_REQUIRED'}));
  phase='actual-c07-source';const profile=JSON.parse(readFileSync(new URL('../../../../ops/platform/profiles/frontend-historical-sources/'+sourceCommit+'.json',import.meta.url))),files=new Map(profile.inventory.sourceFiles.map(row=>[row.file,row]));
  const ts=require('typescript'),db=require('drizzle-orm/node-postgres').drizzle(writer),cache=new Map();
  function load(file){
   if(cache.has(file))return cache.get(file).exports;
   const raw=execFileSync('git',['--no-replace-objects','show',sourceCommit+':'+file],{cwd:root}),expected=files.get(file);assert.ok(expected);assert.equal(digest(raw),expected.sha256);loadedSources.set(file,{file,blobOid:expected.blobOid,sha256:expected.sha256});
   const sourceModule={exports:{}};cache.set(file,sourceModule);
   const sourceRequire=specifier=>{
    if(specifier==='server-only')return {};
    if(specifier==='@/lib/private-db/client')return {getPrivateDb:()=>db};
    if(specifier.startsWith('.')||specifier.startsWith('@/'))return load((specifier.startsWith('@/')?'src/'+specifier.slice(2):posix.normalize(posix.join(posix.dirname(file),specifier)))+'.ts');
    return require(specifier);
   };
   const transpiled=ts.transpileModule(raw.toString(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
   // Execute only exact Git/profile-verified old source in this owned process.
   new Function('require','module','exports',transpiled)(sourceRequire,sourceModule,sourceModule.exports);return sourceModule.exports;
  }
  for(const name of names)delete process.env[name];process.env.AUTH_SECRET='owned-signing-presence';process.env.NODE_ENV='test';process.env.VERCEL_ENV='preview';
  globalThis.fetch=async()=>{providerCalls++;throw Error('OWNED_PROVIDER_EGRESS_REFUSED');};
  const oauth=load('src/lib/highlevel/oauth.ts'),actor=randomUUID(),state='s'.repeat(43),stateHash=oauth.stateHash(state);
  await writer.query("INSERT INTO highlevel_oauth_states(hash,actor_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[stateHash,actor]);
  await assert.rejects(oauth.completeInstallation(actor,state,'owned-unissued-code'),error=>error.code==='missing_highlevel_client_id');
  check('actual-old-callback-deletes-valid-state-before-missing-client-id',()=>assert.equal(providerCalls,0));
  assert.equal((await writer.query('SELECT count(*)::int AS count FROM highlevel_oauth_states WHERE hash=$1',[stateHash])).rows[0].count,0);checks.push('actual-oauth-state-delete-committed-with-all-four-highlevel-keys-absent');
  const store=load('src/lib/highlevel/store.ts');await store.enqueueCrmEvent(db,{entityType:'contact',entityId:randomUUID(),eventKey:'owned:no-provider-keys'});
  assert.equal((await writer.query("SELECT count(*)::int AS count FROM highlevel_outbox WHERE event_key='owned:no-provider-keys'")).rows[0].count,1);checks.push('actual-local-outbox-insert-without-highlevel-keys');
  process.env.HIGHLEVEL_LOCATION_ID='owned-location';
  await assert.rejects(oauth.createInstallation(actor),error=>error.code==='missing_highlevel_client_id');
  assert.equal((await writer.query('SELECT count(*)::int AS count FROM highlevel_oauth_states')).rows[0].count,1);checks.push('actual-installation-state-insert-before-client-id-lookup');
  const webhook=load('src/lib/highlevel/webhook.ts'),config=load('src/lib/highlevel/config.ts'),pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),body=JSON.stringify({type:'OwnedReceiptOnly',locationId:'owned-location',webhookId:'owned-event'}),signature=sign(null,Buffer.from(body),pair.privateKey).toString('base64');
  const handler=webhook.createHighLevelWebhookHandler({location:config.locationId,verify:(raw,signature)=>webhook.verifyHighLevelSignature(raw,signature,publicKey),persist:webhook.persistHighLevelWebhook});
  assert.equal((await handler(new Request('https://owned.invalid/api/webhooks/highlevel',{method:'POST',body,headers:{'x-ghl-signature':signature}}))).status,200);
  assert.equal((await writer.query("SELECT count(*)::int AS count FROM highlevel_webhook_receipts WHERE event_type='OwnedReceiptOnly'")).rows[0].count,1);checks.push('actual-handler-owned-signature-persists-receipt-without-client-or-encryption-keys');
  check('provider-egress-remains-zero',()=>assert.equal(providerCalls,0));
  check('source-policy-changes-requirements-identity',()=>assert.notEqual(source.requirementsSha256,''+JSON.parse(readFileSync(new URL('./repro-before.json',import.meta.url))).requirementsSha256));
  check('sanitized-source-observation-has-no-password-or-url',()=>{assert.ok(!JSON.stringify(facts).includes(password));assert.ok(!JSON.stringify(facts).includes('postgresql:'));});
  return {status:'OWNED_HIGHLEVEL_SQL_SCOPE_PASS',fixtureOnly:true,serverMajor:major,frontendMigrations:journal.entries.length,checks,providerCalls,
   actualSourceObserver:true,actualOriginalDeploymentObserved:false,physicalAdmissionOrLoginFencePerformed:false,wholeBarrierBypassDemonstrated:false,
   sourceCommit,requirementsSha256:source.requirementsSha256,sourceModuleSha256:digest(readFileSync(new URL('../../../../ops/platform/frontend-historical-source.mjs',import.meta.url))),loadedOldSourceBlobs:[...loadedSources.values()],
   sourceBodyBridge:'Only old getPrivateDb is supplied the owned Drizzle/TLS writer; actual old function bodies execute. Webhook signature uses an explicitly owned key through the existing dependency seam, not the provider private key.',highlevelSqlResiduals:facts.requirements.unresolvedFrontendSqlFamilyIds.filter(id=>id.startsWith('highlevel.'))};
 }finally{
  globalThis.fetch=originalFetch;
  for(const client of clients)try{await client.end();}catch{/* disposable peers only */}
  if(started)execute(join(binaries,'pg_ctl'),['-D',data,'-m','immediate','-w','stop']);rmSync(directory,{recursive:true,force:true});
 }
}
main().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({status:'OWNED_HIGHLEVEL_SQL_SCOPE_FAILED',phase,errorKind:error.name,code:/^[A-Z0-9_]{1,80}$/u.test(error.code??'')?error.code:undefined}));process.exitCode=1;});
