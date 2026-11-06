"""Explicit loopback-only recovery qualification, all actual migration sources."""
import ast
import contextlib
import io
import hashlib
import inspect
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import select
import signal
import threading
import tempfile
import uuid
import re
import subprocess
import sys
import traceback
import urllib.error
import ssl
import urllib.parse

# Failure-only metadata. Raw inner output is never forwarded; the outer fixed
# CI parent privately retains this bounded record without changing its receipt.
OWNED_CHILD_PHASES = frozenset((
    'boot','frontend-connect','frontend-owner-roles','frontend-recovery-session',
    'forward-composed-failure-control','forward-prior-reconciliation','forward-api-course-current','forward-api-community-current',
    'forward-runtime-credential-negatives','forward-new-build-probe-promote','forward-post-build-runtime-credential-negative','forward-source-scope',
    'forward-shared-compatible-observation','forward-shared-vercel-observation',
    'forward-open-admission-and-receipt-negatives','forward-journal-preservation','forward-scope-expired','forward-result',
    'current-frontend-privileges','current-api-privileges','current-result'))
OWNED_CHILD_ERROR_CODES = frozenset((
    'ERR_ASSERTION','ERR_MODULE_NOT_FOUND','ERR_INVALID_URL','ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ECONNREFUSED','ECONNRESET','ETIMEDOUT','EADDRINUSE','EPIPE','ENOENT','EACCES','EPERM','ENOMEM',
    '42501','28P01','28000','3D000','53300','57P01'))


# Fixed source closure for failure-only guard-code/frame projection. These are
# source literals, never exception-message regexes or caller-selected paths.
OWNED_BRIDGE_SOURCE_FILES = (
    'ops/platform/host/p2_recovery_frontend_observation.py',
    'ops/platform/host/frontend_release_adapters.py',
    'ops/platform/host/frontend_probe.py', 'ops/platform/host/vercel.py',
    'ops/platform/host/migrate.py', 'ops/platform/host/p2_certification_profile.py')
OWNED_BRIDGE_ERROR_KINDS = frozenset(('ValueError','TypeError','RuntimeError','AssertionError','JSONDecodeError',
    'FileNotFoundError','FileExistsError','PermissionError','TimeoutError','ConnectionError','HTTPError','URLError',
    'SSLError','SSLCertVerificationError','ConnectionRefusedError','ConnectionResetError','BrokenPipeError','OSError'))


def owned_bridge_guard_codes(source_root):
    codes={}
    for name in OWNED_BRIDGE_SOURCE_FILES:
        for node in ast.walk(ast.parse((Path(source_root)/name).read_text())):
            if not isinstance(node,ast.Call) or not node.args:continue
            function=node.func.id if isinstance(node.func,ast.Name) else node.func.attr if isinstance(node.func,ast.Attribute) else ''
            value=node.args[-1]
            if function in ('demand','require','ValueError') and isinstance(value,ast.Constant) and isinstance(value.value,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}',value.value):
                codes.setdefault(value.value,[]).append((name,node.lineno,node.end_lineno))
    return {code:tuple(sites) for code,sites in codes.items()}


def owned_bridge_diagnostic(error, allowed_codes, source_root):
    chain=[];frames=[];seen=set();pending=[error]
    while pending and len(chain)<8:
        current=pending.pop(0)
        if not isinstance(current,BaseException) or id(current) in seen:continue
        seen.add(id(current))
        def safe(name):
            try:return getattr(current,name,None)
            except BaseException:return None
        try:kind=type(current).__name__
        except BaseException:kind='unknown'
        try:source_frames=traceback.extract_tb(safe('__traceback__'))
        except BaseException:source_frames=[]
        sites=[]
        for frame in source_frames:
            try:relative=str(Path(frame.filename).resolve().relative_to(Path(source_root).resolve()))
            except (ValueError,OSError):continue
            if relative not in OWNED_BRIDGE_SOURCE_FILES or not 1<=frame.lineno<=1000000:continue
            sites.append((relative,frame.lineno))
            value={'source':'frontend','file':relative,'line':frame.lineno}
            if value not in frames and len(frames)<12:frames.append(value)
        args=safe('args');candidate=args[0] if type(args) is tuple and len(args)==1 and type(args[0]) is str else None
        selected=allowed_codes.get(candidate,()) if isinstance(allowed_codes,dict) else ()
        code=candidate if any(file==source and first<=line<=last for file,line in sites for source,first,last in selected) else 'unknown'
        http=safe('code') if isinstance(current,urllib.error.HTTPError) else None
        tls=safe('verify_code') if isinstance(current,ssl.SSLCertVerificationError) else None
        chain.append({'kind':kind if kind in OWNED_BRIDGE_ERROR_KINDS else 'unknown','guardCode':code,
            'httpStatus':http if type(http) is int and 100<=http<=599 else None,
            'tlsVerifyCode':tls if type(tls) is int and 0<=tls<=1000 else None})
        # Suppressed contexts contain the actual transport failure beneath the
        # source's deliberately generic outer exception. Never print messages.
        pending.extend(value for value in (safe('__cause__'),safe('__context__'),safe('reason')) if isinstance(value,BaseException))
    return {'version':1,'status':'OWNED_P2_FORWARD_BRIDGE_DIAGNOSTIC','chain':chain,'frames':frames,'rawOutputRetained':False}


def read_owned_bridge_diagnostics(directory, allowed_codes):
    if directory is None:return []
    values=[]
    for path in sorted(Path(directory).iterdir()):
        if len(values)>=4:break
        if not re.fullmatch(r'[1-9][0-9]{0,9}\.json',path.name) or path.is_symlink() or not path.is_file() or path.stat().st_size>16384:continue
        try:value=json.loads(path.read_bytes())
        except (ValueError,OSError):continue
        if not isinstance(value,dict) or set(value)!={'version','status','chain','frames','rawOutputRetained'} or value.get('version')!=1 or value.get('status')!='OWNED_P2_FORWARD_BRIDGE_DIAGNOSTIC' or value.get('rawOutputRetained') is not False:continue
        if not isinstance(value['chain'],list) or not 1<=len(value['chain'])<=8 or not isinstance(value['frames'],list) or len(value['frames'])>12:continue
        if any(not isinstance(row,dict) or set(row)!={'kind','guardCode','httpStatus','tlsVerifyCode'} or not isinstance(row['kind'],str) or row['kind'] not in OWNED_BRIDGE_ERROR_KINDS|{'unknown'} or not isinstance(row['guardCode'],str) or row['guardCode'] not in set(allowed_codes)|{'unknown'} or
            not (row['httpStatus'] is None or type(row['httpStatus']) is int and 100<=row['httpStatus']<=599) or not (row['tlsVerifyCode'] is None or type(row['tlsVerifyCode']) is int and 0<=row['tlsVerifyCode']<=1000) for row in value['chain']):continue
        if any(not isinstance(row,dict) or set(row)!={'source','file','line'} or row['source']!='frontend' or not isinstance(row['file'],str) or row['file'] not in OWNED_BRIDGE_SOURCE_FILES or type(row['line']) is not int or not 1<=row['line']<=1000000 for row in value['frames']):continue
        values.append(value)
    return values


def prepare_owned_forward_graph(root,directory,provider_origin,provider_ca):
    graph=Path(directory)/'forward-app';platform=graph/'ops/platform';host=platform/'host';host.mkdir(parents=True)
    (graph/'package.json').write_text('{"type":"module"}\n');(graph/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
    for source in (root/'ops/platform').glob('*.mjs'):
        destination=platform/source.name
        if source.name in ('frontend-release-adapters.mjs','p2-recovery-frontend-observation.mjs'):shutil.copyfile(source,destination)
        else:destination.symlink_to(source)
    shim="import sys,ssl,re\nsys.path.insert(0,"+repr(str(root/'ops/platform/host'))+")\nimport frontend_probe,vercel\nvercel.API_ORIGIN="+repr(provider_origin)+"\noriginal_ssl=ssl.create_default_context\nssl.create_default_context=lambda *args,**kwargs: original_ssl(cafile="+repr(str(provider_ca))+")\noriginal_probe=frontend_probe.ProbeClient.request\nfrontend_probe.DEPLOYMENT_URL=re.compile(re.escape(vercel.API_ORIGIN))\ndef mapped_probe(self,url,*args,**kwargs):\n    assert url=='https://owned.vercel.app'\n    return original_probe(self,vercel.API_ORIGIN,*args,**kwargs)\nfrontend_probe.ProbeClient.request=mapped_probe\n"
    bridge_directory=Path(directory)/'bridge-failures';bridge_directory.mkdir(mode=0o700)
    bridge_codes=owned_bridge_guard_codes(root)
    projection=("import os,json,traceback,urllib.error,ssl\nfrom pathlib import Path\n"+
        "OWNED_BRIDGE_SOURCE_FILES="+repr(OWNED_BRIDGE_SOURCE_FILES)+"\nOWNED_BRIDGE_ERROR_KINDS="+repr(OWNED_BRIDGE_ERROR_KINDS)+"\n"+
        inspect.getsource(owned_bridge_diagnostic)+"\n")
    failure=("\ntry:actual.main()\nexcept BaseException as error:\n"+
        "    diagnostic=owned_bridge_diagnostic(error,"+repr(bridge_codes)+","+repr(str(root))+")\n"+
        "    descriptor=os.open("+repr(str(bridge_directory))+"+'/'+str(os.getpid())+'.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\n"+
        "    try:os.write(descriptor,json.dumps(diagnostic,separators=(',',':')).encode());os.fsync(descriptor)\n"+
        "    finally:os.close(descriptor)\n    raise SystemExit(1)\n")
    for name in ('p2_recovery_frontend_observation','frontend_release_adapters'):
        (host/(name+'.py')).write_text(shim+projection+'import '+name+' as actual\n'+failure)
    return graph,platform,bridge_directory,bridge_codes


OWNED_NODE_GUARD_CODES=frozenset(('P2_RECOVERY_CURRENT_DATABASE_REFUSED','P2_RECOVERY_RUNTIME_CREDENTIAL_REFUSED',
    'P2_RECOVERY_RUNTIME_CREDENTIAL_CLEANUP_UNCERTAIN','P2_RECOVERY_FRONTEND_SESSION_FAILED_REQUIRES_REVIEW','P2_RECOVERY_FRONTEND_RECHECK_REFUSED'))
OWNED_NODE_SOURCE_FILES=frozenset(('ops/platform/p2-recovery-current-probe.mjs','ops/platform/p2-recovery-frontend-observation.mjs',
    'ops/platform/frontend-release-adapters.mjs','ops/platform/test-p2-recovery-owned.mjs'))


def owned_node_diagnostics(stderr):
    result=[]
    for line in stderr.splitlines():
        if not 0<len(line)<=8192:continue
        try:value=json.loads(line)
        except (ValueError,TypeError):continue
        if not isinstance(value,dict) or set(value)!={'status','phase','stage','kind','guardCode','checkpoint','frames'} or value.get('status')!='OWNED_P2_RECOVERY_NODE_DIAGNOSTIC':continue
        if any(type(value[key]) is not str for key in ('phase','stage','kind','guardCode','checkpoint')):continue
        if value['phase'] not in OWNED_CHILD_PHASES or value['stage'] not in ('build-bridge','mutation-checkpoint','composed-source-bridge','composed-checkpoint') or value['kind'] not in ('Error','AssertionError','TypeError','RangeError','SyntaxError','unknown'):continue
        if value['guardCode'] not in OWNED_NODE_GUARD_CODES|{'unknown'} or value['checkpoint'] not in ('runtime-credential','runtime-physical-session','forward-brand','forward-mode','unknown'):continue
        if not isinstance(value['frames'],list) or len(value['frames'])>12:continue
        if any(not isinstance(row,dict) or set(row)!={'source','file','line','column'} or row['source'] not in ('frontend','frontend-fixture') or type(row['file']) is not str or row['file'] not in OWNED_NODE_SOURCE_FILES or type(row['line']) is not int or not 1<=row['line']<=1000000 or type(row['column']) is not int or not 1<=row['column']<=100000 for row in value['frames']):continue
        result.append(value)
        if len(result)>=8:break
    return result


def child_failure_diagnostic(result, source_roots, forward_mode):
    stderr = result.stderr if isinstance(result.stderr,str) else ''
    stdout = result.stdout if isinstance(result.stdout,str) else ''
    phase = 'unknown'
    for line in stderr.splitlines():
        if not 0 < len(line) <= 4096:continue
        try:value=json.loads(line)
        except (ValueError,TypeError):continue
        if isinstance(value,dict) and set(value)=={'status','phase'} and value.get('status')=='OWNED_P2_RECOVERY_PHASE' and value.get('phase') in OWNED_CHILD_PHASES:
            phase=value['phase']
    kind = 'unknown'
    match=re.search(r'(?:^|\n)(AssertionError|TypeError|RangeError|SyntaxError|ReferenceError|Error)(?:\b|\[)',stderr)
    if match:kind=match.group(1)
    code='unknown'
    for match in re.finditer(r"(?:code\s*:\s*['\"]|Error\s*\[)([A-Z0-9_]+)",stderr):
        if match.group(1) in OWNED_CHILD_ERROR_CODES:
            code=match.group(1);break
    frames=[]
    for source,directory in source_roots.items():
        if source not in ('frontend','frontend-fixture','course','community'):continue
        prefix=str(Path(directory).resolve())
        pattern=re.escape(prefix)+r'/((?:ops|src|drizzle)/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|py)):(\d{1,8}):(\d{1,6})'
        for match in re.finditer(pattern,stderr):
            file,line,column=match.groups()
            if len(file)>256 or '..' in Path(file).parts or not (Path(prefix)/file).is_file():continue
            frame={'source':source,'file':file,'line':int(line),'column':int(column)}
            if frame not in frames and len(frames)<12:frames.append(frame)
    returncode=result.returncode if type(result.returncode) is int else None
    signal_name=None
    if returncode is not None and returncode<0:
        try:signal_name=signal.Signals(-returncode).name
        except ValueError:pass
        if signal_name not in ('SIGABRT','SIGKILL','SIGTERM','SIGSEGV','SIGBUS','SIGILL','SIGFPE','SIGXCPU','SIGXFSZ'):signal_name=None
    return {'version':1,'status':'OWNED_P2_RECOVERY_CHILD_DIAGNOSTIC','fixture':'forward' if forward_mode else 'current',
        'phase':phase,'nodeErrors':owned_node_diagnostics(stderr),'exitStatus':returncode,'signal':signal_name,'errorKind':kind,'errorCode':code,'frames':frames,
        'stdoutBytes':len(stdout.encode('utf8')),'stderrBytes':len(stderr.encode('utf8')),'rawChildOutputRetained':False}


def report_child_failure(result, source_roots, forward_mode, bridge_directory=None, bridge_codes=frozenset()):
    diagnostic=child_failure_diagnostic(result,source_roots,forward_mode)
    diagnostic["bridgeErrors"]=read_owned_bridge_diagnostics(bridge_directory,bridge_codes)
    encoded=json.dumps(diagnostic,separators=(',',':'))
    while len(encoded.encode('utf8'))>8192 and diagnostic['bridgeErrors']:
        diagnostic['bridgeErrors'].pop(0);encoded=json.dumps(diagnostic,separators=(',',':'))
    while len(encoded.encode('utf8'))>8192 and diagnostic['nodeErrors']:
        diagnostic['nodeErrors'].pop(0);encoded=json.dumps(diagnostic,separators=(',',':'))
    if len(encoded.encode('utf8'))>8192:raise ValueError('OWNED_CHILD_DIAGNOSTIC_BOUND_REFUSED')
    print('OWNED_P2_RECOVERY_CHILD_FAILED',file=sys.stderr,flush=True)
    print(encoded,file=sys.stderr,flush=True)


def run_owned_composed_diagnostic_controls(node,root,connections,bridge_directory,bridge_codes):
    graph=Path(connections['forwardFixture']['graph'])
    if list(Path(bridge_directory).iterdir()):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_EMPTY_START_REQUIRED')
    receipts=[]
    for mode in ('python-source-guard','node-pre-spawn','node-checkpoint','node-message-collision'):
        packet={**connections,'ownedComposedDiagnosticControl':mode}
        result=subprocess.run([node,'--import',str(Path(root)/'node_modules/tsx/dist/loader.mjs'),str(Path(root)/'ops/platform/test-p2-recovery-owned.mjs')],
            cwd=root,env=child_environment(P2_RECOVERY_OWNED_TEST='true',P2_RECOVERY_OWNED_CONNECTIONS=json.dumps(packet)),capture_output=True,text=True,timeout=60)
        output=io.StringIO()
        with contextlib.redirect_stderr(output):report_child_failure(result,{'frontend':root,'frontend-fixture':graph.parent.parent},True,bridge_directory,bridge_codes)
        lines=output.getvalue().splitlines();value=json.loads(lines[1])
        if result.returncode!=1 or result.stdout or value['phase']!='forward-composed-failure-control':raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_CHILD_REFUSAL_REQUIRED')
        if mode=='python-source-guard':
            if not any(row['guardCode']=='P2_FORWARD_CONCLUSIVE_FAILED_BUILD_REQUIRED' for error in value['bridgeErrors'] for row in error['chain']):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_PYTHON_SOURCE_REQUIRED')
        elif mode=='node-message-collision':
            if value['bridgeErrors'] or not value['nodeErrors'] or any(error['guardCode']!='unknown' for error in value['nodeErrors']):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_UNBOUND_COLLISION_REFUSED')
        elif value['bridgeErrors'] or not any(error['guardCode']==('P2_RECOVERY_CURRENT_DATABASE_REFUSED' if mode=='node-checkpoint' else 'P2_RECOVERY_FRONTEND_RECHECK_REFUSED') and error['frames'] for error in value['nodeErrors']):
            raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_NODE_SOURCE_REQUIRED')
        encoded=json.dumps(value)
        if any(secret and secret in encoded for secret in (connections.get('password'),connections.get('frontend'),'owned-token-marker')):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_PRIVATE_VALUE_REFUSED')
        receipts.append(value)
        # These are only this control's source-created private diagnostics. Do
        # not let intentional refusals masquerade as a later unexpected failure.
        for path in Path(bridge_directory).iterdir():
            if path.is_symlink() or not re.fullmatch(r'[1-9][0-9]{0,9}\.json',path.name):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_CONTROL_PATH_REFUSED')
            path.unlink()
    return receipts


forward_mode=sys.argv[1:]==['--forward-brand']
if os.environ.get('P2_RECOVERY_OWNED_TEST') != 'true' or (len(sys.argv) != 1 and not forward_mode):
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
provider_fixture=None;foreign_fixture=None;proxy=None;bridge_directory=None;bridge_codes=frozenset()
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
    if forward_mode:
        foreign_fixture=type('ForeignFixture',(Fixture,),{'started':False})
        foreign_fixture.setUpClass()
        foreign_fixture.sql("CREATE ROLE recovery_runtime LOGIN NOINHERIT PASSWORD '"+Fixture.password+"';")
        foreign_route_flag=Fixture.root/'foreign-runtime-route'
        class Route(socketserver.BaseRequestHandler):
            def handle(self):
                backend=socket.create_connection(('127.0.0.1',foreign_fixture.port if foreign_route_flag.exists() else Fixture.port))
                try:
                    while True:
                        readable,_,_=select.select([self.request,backend],[],[],30)
                        if not readable:return
                        for source in readable:
                            raw=source.recv(65536)
                            if not raw:return
                            (backend if source is self.request else self.request).sendall(raw)
                except OSError:pass
                finally:backend.close()
        class Proxy(socketserver.ThreadingTCPServer):daemon_threads=True
        proxy=Proxy(('127.0.0.1',0),Route);proxy_thread=threading.Thread(target=proxy.serve_forever,daemon=True);proxy_thread.start()
        connections['frontend']=connections['frontend'].replace(':'+str(Fixture.port)+'/',':'+str(proxy.server_address[1])+'/')
        trusted_ca=Fixture.root/'trusted-owned-clusters.pem';trusted_ca.write_bytes(Fixture.cert.read_bytes()+foreign_fixture.cert.read_bytes())
        sys.path.insert(0,str(root/'ops/platform/host'))
        import p2_recovery_test as forward_tests
        forward_tests.RecoveryForwardBuildTests.setUpClass()
        provider_fixture=forward_tests.RecoveryForwardBuildTests('test_reviewed_failed_build_creates_one_same_source_deployment_and_actual_private_probe')
        provider_fixture.setUp()
        physical={'host':'127.0.0.1','port':proxy.server_address[1],'database':'postgres','user':'recovery_creator','serverMajor':major}
        provider_fixture.database['target']=physical
        target_hash=hashlib.sha256(json.dumps({'environment':'staging',**physical},separators=(',',':')).encode()).hexdigest()
        provider_fixture.context['plan']['targetSha256']=target_hash;provider_fixture.context['bindings']['targetSha256']=target_hash
        original_bootstrap=provider_fixture.bootstrap_context
        def physical_bootstrap():
            original_bootstrap()
            provider_fixture.context['writerTarget']={'environment':'staging','targetSha256':target_hash,**physical,'user':'recovery_runtime'}
            provider_fixture.context['frontendRuntimeDatabaseUrl']=url('recovery_runtime','postgres').replace(':'+str(Fixture.port)+'/',':'+str(proxy.server_address[1])+'/')
        provider_fixture.bootstrap_context=physical_bootstrap
        provider_fixture.prepare_forward()
        provider_fixture.runtime_fault_flag=str(Fixture.root/'runtime-credential-fault-active');provider_fixture.runtime_fault_calls=0
        # The existing host component fixture creates placeholder current/API
        # inputs. They have not been used by a builder. In this distinct test
        # mode, only actual Node current-readback results are first published.
        for path in Path(provider_fixture.context['directory']).glob('*.json'):path.unlink()
        graph,platform,bridge_directory,bridge_codes=prepare_owned_forward_graph(root,Fixture.root,provider_fixture.origin,forward_tests.provider_fixture.vercel_test.VercelControlTests.cert)
        connections['forwardFixture']={'context':provider_fixture.context,'graph':str(platform),'runtimeFaultFlag':provider_fixture.runtime_fault_flag,'foreignRouteFlag':str(foreign_route_flag)}
        before_control=len(provider_fixture.calls)
        run_owned_composed_diagnostic_controls(node,root,connections,bridge_directory,bridge_codes)
        if any(row['method']!='GET' for row in provider_fixture.calls[before_control:]):raise ValueError('OWNED_COMPOSED_DIAGNOSTIC_GET_ONLY_REQUIRED')
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
        environment=child_environment(NODE_EXTRA_CA_CERTS=str(trusted_ca if forward_mode else Fixture.cert),P2_RECOVERY_OWNED_TEST='true',P2_RECOVERY_OWNED_CONNECTIONS=json.dumps(connections))
        if set(environment)&set(poison):
            raise ValueError('OWNED_AMBIENT_ENVIRONMENT_LEAKED')
        result=subprocess.run([node,'--import',str(root/'node_modules/tsx/dist/loader.mjs'),str(root/'ops/platform/test-p2-recovery-owned.mjs')],cwd=root,env=environment,capture_output=True,text=True)
        if sentinel.exists():
            raise ValueError('OWNED_AMBIENT_NODE_OPTION_EXECUTED')
        if len(result.stdout)+len(result.stderr)>1_000_000:
            raise ValueError('OWNED_RECOVERY_TEST_OUTPUT_LIMIT')
        if result.returncode:
            diagnostic_roots={'frontend':root,**api_roots}
            if forward_mode:diagnostic_roots['frontend-fixture']=graph
            report_child_failure(result,diagnostic_roots,forward_mode,bridge_directory,bridge_codes)
        else:
            if forward_mode:
                if provider_fixture.runtime_fault_calls!=0:raise ValueError('OWNED_RUNTIME_CREDENTIAL_FAULT_PROVIDER_CALL')
                calls=provider_fixture.calls[provider_fixture.before_calls:]
                creates=[row for row in calls if row['method']=='POST' and row['path'].split('?',1)[0]=='/v13/deployments']
                promotions=[row for row in calls if row['method']=='POST' and '/promote/' in row['path']]
                if len(creates)!=1 or len(promotions)!=1 or creates[0]['body']['meta'].get('lashRecoveryActionId')!='reviewed-forward':
                    raise ValueError('OWNED_FORWARD_EXCLUSIVE_POST_COUNT_REFUSED')
                final_post=max(index for index,row in enumerate(calls) if row['method']!='GET')
                if not all(row['method']=='GET' for row in calls[final_post+1:]) or len(calls[final_post+1:])<10:
                    raise ValueError('OWNED_FORWARD_SHARED_READ_INTERVAL_REFUSED')
                provider_fixture.preserved()
            lines=result.stdout.splitlines()
            if len(lines)!=1:
                raise ValueError('OWNED_RECOVERY_SINGLE_SOURCE_RECEIPT_REQUIRED')
            value=json.loads(lines[0])
            expected_status='OWNED_P2_RECOVERY_FORWARD_SOURCE_CHECKS_PASS' if forward_mode else 'OWNED_P2_RECOVERY_DATABASE_SOURCE_CHECKS_PASS'
            if not isinstance(value,dict) or value.get('status')!=expected_status or value.get('childEnvironmentAllowlistEnforced') is not True:
                raise ValueError('OWNED_RECOVERY_SOURCE_RECEIPT_MISSING')
            value.pop('childEnvironmentAllowlistEnforced')
            if forward_mode:value['runtimeCredentialFaultProviderCalls']=provider_fixture.runtime_fault_calls
            print(json.dumps({**value,'status':'OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS' if forward_mode else 'OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS','environmentIsolation':{
                'nodeOptionsPositiveControlExecuted':True,'poisonedParentEnvironment':True,'ambientNodeOptionsExecuted':False,
                'ambientConfigVariablesAbsent':True,'childEnvironmentAllowlistEnforced':True}}),flush=True)
    finally:
        for key,value in original.items():
            if value is None:os.environ.pop(key,None)
            else:os.environ[key]=value
    raise SystemExit(result.returncode)
finally:
    if provider_fixture is not None:
        provider_fixture.tearDown();forward_tests.RecoveryForwardBuildTests.tearDownClass()
    if proxy is not None:
        proxy.shutdown();proxy.server_close();proxy_thread.join(2)
    if foreign_fixture is not None:foreign_fixture.cleanup()
    Fixture.cleanup()
