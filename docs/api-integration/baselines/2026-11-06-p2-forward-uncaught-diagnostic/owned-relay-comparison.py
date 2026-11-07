import ast,concurrent.futures,hashlib,json,os,re,select,socket,socketserver,subprocess,sys,tempfile,threading,uuid
from pathlib import Path
root=Path.cwd();name='ops/platform/test-p2-recovery-owned.py';source=root/name;tree=ast.parse(source.read_text());major=18
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Fixture'],type_ignores=[]),str(source),'exec'),globals())
relays=[]
try:
 Fixture.setUpClass()
 Fixture.sql('CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)')
 for row in json.loads((root/'drizzle/meta/_journal.json').read_text())['entries']:
  digest=hashlib.sha256((root/'drizzle'/(row['tag']+'.sql')).read_bytes()).hexdigest()
  Fixture.sql("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('"+digest+"',"+str(row['when'])+")")
 before=Fixture.sql('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')
 texts={'original47':subprocess.check_output(['git','show','47d5b6a1:'+name],text=True),'fixed2abd':source.read_text()};contexts=[]
 class Proxy(socketserver.ThreadingTCPServer):daemon_threads=True
 for mode,text in texts.items():
  route=next(n for n in ast.walk(ast.parse(text)) if isinstance(n,ast.ClassDef) and n.name=='Route');closed=threading.Event()
  ns={'socket':socket,'socketserver':socketserver,'select':select,'Fixture':Fixture,'foreign_fixture':Fixture,'foreign_route_flag':Fixture.root/'never-foreign'}
  exec(compile(ast.Module(body=[route],type_ignores=[]),str(source),'exec'),ns);actual=ns['Route']
  def observed(actual,closed):
   class Observed(actual):
    def handle(self):
     try:super().handle()
     finally:closed.set()
   return Observed
  relay=Proxy(('127.0.0.1',0),observed(actual,closed));worker=threading.Thread(target=relay.serve_forever,daemon=True);worker.start();relays.append((relay,worker))
  contexts.append((mode,relay,closed,hashlib.sha256(ast.get_source_segment(text,route).encode()).hexdigest()))
 code="""import {Client} from 'pg';import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');const began=process.hrtime.bigint();process.on('uncaughtExceptionMonitor',e=>writeFileSync(2,JSON.stringify({status:'OWNED_IDLE_RELAY_UNCAUGHT',kind:e.name==='Error'?'Error':'unknown',elapsedSeconds:Number(process.hrtime.bigint()-began)/1e9})+'\\n'));const client=new Client({connectionString:process.env.OWNED_URL,ssl:{rejectUnauthorized:true}});await client.connect();const pid=(await client.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid,journal=(await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows;console.log(JSON.stringify({status:'OWNED_IDLE_BASELINE',pid,tls:client.connection.stream.encrypted===true,authorized:client.connection.stream.authorized===true}));await new Promise(resolve=>setTimeout(resolve,32000));const sameBackend=(await client.query('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0].pid===pid,journalUnchanged=digest((await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')).rows)===digest(journal);console.log(JSON.stringify({status:'OWNED_IDLE_AFTER',sameBackend,journalUnchanged,tlsAuthorized:client.connection.stream.authorized===true}));await client.end();"""
 def run(context):
  mode,relay,closed,route_hash=context
  env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','LANG','TMPDIR')};env.update(OWNED_URL='postgresql://frontend_provider_fixture:'+Fixture.password+'@127.0.0.1:'+str(relay.server_address[1])+'/postgres?sslmode=verify-full',NODE_EXTRA_CA_CERTS=str(Fixture.cert))
  child=subprocess.run(['/Users/dardan/.nvm/versions/node/v24.18.0/bin/node','--input-type=module','-e',code],cwd=root,env=env,capture_output=True,text=True,timeout=45)
  values=[json.loads(line)for line in child.stdout.splitlines()];baseline=values[0];assert baseline['tls'] and baseline['authorized'] and isinstance(baseline['pid'],int)
  if mode=='original47':
   markers=[]
   for line in child.stderr.splitlines():
    try:value=json.loads(line)
    except ValueError:continue
    if isinstance(value,dict) and value.get('status')=='OWNED_IDLE_RELAY_UNCAUGHT':markers.append(value)
   assert child.returncode==1 and len(markers)==1 and 29<=markers[0]['elapsedSeconds']<=36
   gone=Fixture.sql('SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid='+str(baseline['pid'])).strip()=='0';assert gone
   detail={'baselineTlsAuthorized':True,'originalBackendGone':gone,'uncaught':markers[0]}
  else:
   assert child.returncode==0 and child.stderr=='' and len(values)==2
   after=values[1];assert after['sameBackend'] and after['journalUnchanged'] and after['tlsAuthorized'];detail={k:after[k] for k in ('sameBackend','journalUnchanged','tlsAuthorized')}
  assert closed.wait(2)
  return {'mode':mode,'routeSha256':route_hash,'exitStatus':child.returncode,'actualTls':True,'relayClosedOnExpectedTimeoutOrEof':True,'detail':detail}
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:results=list(executor.map(run,contexts))
 assert Fixture.sql('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at,id')==before
 print(json.dumps({'status':'OWNED_ORIGINAL_AND_FIXED_RELAY_ACTUAL_PG18_COMPARISON_PASS','serverMajor':18,'frontendMigrations':Fixture.migration_count,'oldSourceCommit':'47d5b6a19c8f2d7f14335ce0a5c6d5a49100395b','fixedSourceCommit':'2abdfe451453eda6f761894115fd6f4e3011a784','cases':results,'journalUnchanged':True,'rawChildOutputRetained':False,'fixtureOnly':True}))
finally:
 for relay,worker in relays:relay.shutdown();relay.server_close();worker.join(2)
 Fixture.cleanup()
