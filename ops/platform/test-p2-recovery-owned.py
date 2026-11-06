"""Explicit loopback-only recovery qualification, all actual migration sources."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import uuid
import re
import subprocess
import sys
import urllib.parse

if os.environ.get('P2_RECOVERY_OWNED_TEST') != 'true' or len(sys.argv) != 1:
    raise SystemExit('EXPLICIT_OWNED_P2_RECOVERY_TEST_REQUIRED')
root=Path(__file__).resolve().parents[2]
def child_environment(**generated):
    # Never inherit Node loaders/options, database/provider credentials, or
    # unrelated application configuration from the operator shell.
    allowed={'PATH','HOME','LANG','TMPDIR'}
    return {**{key:value for key,value in os.environ.items() if key in allowed or key.startswith('LC_')},**generated}
node=os.environ.get('NODE_BIN') or shutil.which('node')
if not node or not subprocess.check_output([node,'--version'],text=True,env=child_environment()).startswith('v24.'):
    raise SystemExit('NODE24_REQUIRED')
major=int(os.environ.get('OWNED_POSTGRES_MAJOR','16'))
if major not in (16,18):
    raise SystemExit('OWNED_POSTGRES_MAJOR_MUST_BE_16_OR_18')

class Fixture:
    started=False
    @classmethod
    def setUpClass(cls):
        cls.cluster=tempfile.TemporaryDirectory(prefix='p2-recovery-owned-')
        cls.root=Path(cls.cluster.name).resolve();cls.data=cls.root/'postgres'
        cls.bin=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@'+str(major)+'/bin'))
        version=subprocess.check_output([str(cls.bin/'postgres'),'--version'],text=True)
        if not re.search(r'PostgreSQL\) '+str(major)+r'\.',version):
            raise ValueError('EXACT_OWNED_POSTGRES_MAJOR_REQUIRED')
        cls.password='owned-'+str(uuid.uuid4());password_file=cls.root/'password';password_file.write_text(cls.password);password_file.chmod(0o600)
        cls.cert,cls.key=cls.root/'ca.pem',cls.root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',str(cls.key),'-out',str(cls.cert)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        cls.key.chmod(0o600)
        subprocess.run([str(cls.bin/'initdb'),'-D',str(cls.data),'-U','frontend_provider_fixture','-A','scram-sha-256','--pwfile',str(password_file),'--locale=C','-E','UTF8'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        probe=socket.socket();probe.bind(('127.0.0.1',0));cls.port=probe.getsockname()[1];probe.close()
        (cls.data/'postgresql.conf').write_text("listen_addresses='127.0.0.1'\nport="+str(cls.port)+"\nunix_socket_directories=''\nssl=on\nssl_cert_file='"+str(cls.cert)+"'\nssl_key_file='"+str(cls.key)+"'\npassword_encryption='scram-sha-256'\n")
        (cls.data/'pg_hba.conf').write_text('hostssl all all 127.0.0.1/32 scram-sha-256\n')
        subprocess.run([str(cls.bin/'pg_ctl'),'-D',str(cls.data),'-l',str(cls.root/'postgres.log'),'-w','start'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);cls.started=True
        cls.environment={'PATH':os.environ.get('PATH',''),'PGPASSWORD':cls.password,'PGSSLMODE':'verify-full','PGSSLROOTCERT':str(cls.cert)}
        journal=json.loads((root/'drizzle/meta/_journal.json').read_text())
        for entry in journal['entries']:
            cls.sql('BEGIN;\n'+(root/'drizzle'/(entry['tag']+'.sql')).read_text()+'\nCOMMIT;')
        cls.migration_count=len(journal['entries'])
    @classmethod
    def sql(cls,text):
        result=subprocess.run([str(cls.bin/'psql'),'-X','-h','127.0.0.1','-p',str(cls.port),'-U','frontend_provider_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-A','-t'],input=text,text=True,env=cls.environment,capture_output=True)
        if result.returncode:raise ValueError('OWNED_P2_RECOVERY_SQL_FIXTURE_FAILED')
        return result.stdout
    @classmethod
    def cleanup(cls):
        try:
            if cls.started:subprocess.run([str(cls.bin/'pg_ctl'),'-D',str(cls.data),'-m','immediate','-w','stop'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        finally:
            if hasattr(cls,'cluster'):cls.cluster.cleanup()
try:
    Fixture.setUpClass()
    api_roots={name:Path(os.environ.get(name.upper()+'_RECOVERY_SOURCE_ROOT','/Users/dardan/workspace/lash-her-'+name+'-api/.worktrees/phase2-'+name)).resolve() for name in ('course','community')}
    def sql(database,text):
        result=subprocess.run([str(Fixture.bin/'psql'),'-X','-h','127.0.0.1','-p',str(Fixture.port),'-U','frontend_provider_fixture','-d',database,'-v','ON_ERROR_STOP=1','-A','-t'],input=text,text=True,env=Fixture.environment,capture_output=True)
        if result.returncode:
            raise ValueError('OWNED_P2_RECOVERY_SQL_FIXTURE_FAILED')
    connections={'serverMajor':major,'password':Fixture.password,'apiRoots':{key:str(value) for key,value in api_roots.items()}}
    def url(user,database):
        return 'postgresql://'+user+':'+urllib.parse.quote(Fixture.password,safe='')+'@127.0.0.1:'+str(Fixture.port)+'/'+database+'?sslmode=verify-full'
    connections['frontend']=url('frontend_provider_fixture','postgres')
    for name,source in api_roots.items():
        if not source.is_dir():
            raise ValueError('EXACT_OWNED_API_SOURCE_REQUIRED')
        migration=name+'_recovery_migration';runtime=name+'_recovery_runtime';database=name+'_recovery_owned'
        # Generated synthetic credentials remain solely in child memory/stdin.
        Fixture.sql("CREATE ROLE "+migration+" LOGIN NOINHERIT PASSWORD '"+Fixture.password+"'; CREATE ROLE "+runtime+" LOGIN NOINHERIT PASSWORD '"+Fixture.password+"'; CREATE DATABASE "+database+" OWNER "+migration+";")
        Fixture.sql('GRANT CONNECT ON DATABASE '+database+' TO '+runtime+';')
        sql(database,"GRANT USAGE,CREATE ON SCHEMA public TO "+migration+"; SET ROLE "+migration+"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "+runtime+"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO "+runtime+";")
        journal=json.loads((source/'drizzle/meta/_journal.json').read_text())
        for entry in journal['entries']:
            raw=(source/'drizzle'/(entry['tag']+'.sql')).read_text()
            sql(database,'SET ROLE '+migration+'; BEGIN;\n'+raw+'\nCOMMIT;')
        sql(database,'SET ROLE '+migration+'; CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint);')
        for entry in journal['entries']:
            digest=hashlib.sha256((source/'drizzle'/(entry['tag']+'.sql')).read_bytes()).hexdigest()
            sql(database,"SET ROLE "+migration+"; INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('"+digest+"',"+str(entry['when'])+");")
        # An owned probe sequence exercises ACL checks even when application
        # migrations currently use UUIDs only. It is included in the fixture's
        # actual catalog baseline; an ACL fault cannot hide behind schema drift.
        sql(database,'SET ROLE '+migration+'; CREATE SEQUENCE public.recovery_acl_probe; GRANT USAGE ON SCHEMA public TO '+runtime+'; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO '+runtime+'; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO '+runtime+'; REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;')
        connections[name]=url(migration,database);connections[name+'Admin']=url('frontend_provider_fixture',database)
    sentinel=Fixture.root/'ambient-node-option-executed'
    injection=Fixture.root/'ambient-node-option.cjs'
    injection.write_text("require('node:fs').writeFileSync("+json.dumps(str(sentinel))+",'executed');process.exit(47);\n")
    poison={'NODE_OPTIONS':'--require='+str(injection),'NODE_PATH':str(Fixture.root/'ambient-modules'),'TSX_TSCONFIG_PATH':str(Fixture.root/'ambient-tsconfig.json'),
            'DATABASE_URL':'postgresql://ambient.invalid/never-use','TEST_DATABASE_URL':'postgresql://ambient.invalid/never-use',
            'STAGING_DATABASE_URL':'postgresql://ambient.invalid/never-use','VERCEL_TOKEN':'synthetic-ambient-provider-token','PGPASSWORD':'synthetic-ambient-password'}
    # Positive control proves the sentinel is executable by this actual Node.
    control=subprocess.run([node,'-e',''],env={**child_environment(),**poison},capture_output=True)
    if control.returncode != 47 or not sentinel.is_file():
        raise ValueError('OWNED_ENVIRONMENT_SENTINEL_CONTROL_FAILED')
    sentinel.unlink()
    original={key:os.environ.get(key) for key in poison}
    try:
        os.environ.update(poison)
        environment=child_environment(NODE_EXTRA_CA_CERTS=str(Fixture.cert),P2_RECOVERY_OWNED_TEST='true',P2_RECOVERY_OWNED_CONNECTIONS=json.dumps(connections))
        if set(environment)&set(poison):
            raise ValueError('OWNED_AMBIENT_ENVIRONMENT_LEAKED')
        result=subprocess.run([node,'--import',str(root/'node_modules/tsx/dist/loader.mjs'),str(root/'ops/platform/test-p2-recovery-owned.mjs')],cwd=root,env=environment,capture_output=True,text=True)
        if sentinel.exists():
            raise ValueError('OWNED_AMBIENT_NODE_OPTION_EXECUTED')
        if len(result.stdout)+len(result.stderr)>1_000_000:
            raise ValueError('OWNED_RECOVERY_TEST_OUTPUT_LIMIT')
        source_receipts=[]
        for line in result.stdout.splitlines():
            try:value=json.loads(line)
            except json.JSONDecodeError:value=None
            if isinstance(value,dict) and value.get('status')=='OWNED_P2_RECOVERY_DATABASE_SOURCE_CHECKS_PASS':source_receipts.append(value)
            else:print(line,flush=True)
        if result.stderr:print(result.stderr,file=sys.stderr,flush=True)
        if result.returncode==0:
            if len(source_receipts)!=1 or source_receipts[0].get('childEnvironmentAllowlistEnforced') is not True:
                raise ValueError('OWNED_RECOVERY_SOURCE_RECEIPT_MISSING')
            source_receipts[0].pop('childEnvironmentAllowlistEnforced')
            print(json.dumps({**source_receipts[0],'status':'OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS','environmentIsolation':{
                'nodeOptionsPositiveControlExecuted':True,'poisonedParentEnvironment':True,'ambientNodeOptionsExecuted':False,
                'ambientConfigVariablesAbsent':True,'childEnvironmentAllowlistEnforced':True}}),flush=True)
    finally:
        for key,value in original.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value
    raise SystemExit(result.returncode)
finally:
    Fixture.cleanup()
