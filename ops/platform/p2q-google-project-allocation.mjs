// Source-selected Google project creation/capture. No case is registered yet.
import * as fs from 'node:fs';
import * as https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {dirname,join,relative,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {P2Q_GOOGLE_PROJECT_CAPTURE_CASES} from './source-policy.mjs';

const OWNER_UID=0,CASE_ROOT='/var/lib/lash-her/p2q/google-projects';
const PROGRAM=fileURLToPath(import.meta.url),SOURCE_ROOT=resolve(dirname(PROGRAM),'../..');
const HOST='cloudresourcemanager.googleapis.com',MAX_RAW=262144,MAX_TOTAL=4_000_000,MAX_RESPONSES=64;
const UMASK_WRAPPER='import os,sys\nos.umask(0o077)\nos.execve(sys.argv[1],sys.argv[1:],dict(os.environ))\n';
const NETRC_MARKER=Buffer.from('# Source-owned empty netrc: no authentication entries.\n');
const SDK_CA_RELATIVE='lib/third_party/certifi/cacert.pem';
const SUFFIX=/\.(?:py|mjs|json|yaml|yml|service|timer|sh|guard)$/u;
const flags=Object.freeze({allocationAuthorityIssued:false,firstUseAuthorized:false,administrativeBoundaryComplete:false,
  recoveryBoundaryComplete:false,profileRegistered:false,oauthClientCreated:false});
const codes=new Set(['CASE_UNREGISTERED','CASE_REFUSED','AMBIENT_OVERRIDE_REFUSED','SOURCE_REQUIRED','TOOLCHAIN_REQUIRED','PRIVATE_DIRECTORY_REQUIRED',
  'PRIVATE_FILE_REQUIRED','PRIVATE_FILE_BOUND','PRIVATE_WRITE_FAILED','CASE_ALREADY_BURNED','PRINCIPAL_CLAIM_REQUIRES_REVIEW','AUTH_TTY_REQUIRED','AUTH_COMMAND_FAILED','AUTH_PRINCIPAL_REQUIRED',
  'AUTH_TOKEN_REQUIRED','HTTP_UNCERTAIN','HTTP_BOUND','HTTP_STATUS_REFUSED','RESPONSE_REFUSED','EXISTING_PROJECT_REQUIRES_REVIEW',
  'CREATE_ALREADY_EXISTS','OPERATION_ERROR','OPERATION_REQUIRED','PROJECT_REQUIRED','IAM_REQUIRED','OBSERVATION_UNKNOWN','ORIGINAL_INTENT_REQUIRED']);
function error(code){const e=new Error('P2Q_GOOGLE_'+code);e.code=e.message;return e;}
function demand(value,code){if(!value)throw error(code);}
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const encoded=v=>Buffer.from(JSON.stringify(canonical(v))+'\n');
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const projectId=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(v);
const account=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9._+-]{0,126}@[a-z0-9.-]+\.[a-z]{2,63}$/u.test(v)&&!v.endsWith('.gserviceaccount.com');
const projectName=v=>typeof v==='string'&&/^projects\/[1-9][0-9]{0,18}$/u.test(v)&&BigInt(v.slice(9))<=9223372036854775807n;
function closed(v,keys){demand(v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&
  keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');}),'CASE_REFUSED');}
function parse(raw){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw error('RESPONSE_REFUSED');}}
function privatePath(path){demand(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path,'PRIVATE_DIRECTORY_REQUIRED');}
function directory(path,privateMode=false){
  privatePath(path);let current='/';
  for(const part of path.split('/').filter(Boolean)){current=join(current,part);const s=fs.lstatSync(current);
    demand(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===OWNER_UID&&(s.mode&0o022)===0,'PRIVATE_DIRECTORY_REQUIRED');}
  if(privateMode)demand((fs.lstatSync(path).mode&0o777)===0o700,'PRIVATE_DIRECTORY_REQUIRED');
}
function syncDirectory(path){const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function readFile(path,max,privateMode=false,allowEmpty=false){
  if(privateMode)directory(dirname(path),true);
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(fd);demand(s.isFile()&&s.uid===OWNER_UID&&s.nlink===1&&(privateMode?(s.mode&0o777)===0o600:(s.mode&0o022)===0),'PRIVATE_FILE_REQUIRED');
    demand((allowEmpty||s.size>0)&&s.size<=max,'PRIVATE_FILE_BOUND');const bytes=Buffer.alloc(s.size+1);let n=0,count;
    while((count=fs.readSync(fd,bytes,n,bytes.length-n,null))>0)n+=count;
    const after=fs.fstatSync(fd);demand(n===s.size&&after.size===s.size&&after.ino===s.ino&&after.dev===s.dev&&after.mtimeMs===s.mtimeMs&&after.ctimeMs===s.ctimeMs,'PRIVATE_FILE_REQUIRED');
    return bytes.subarray(0,n);
  }finally{fs.closeSync(fd);}
}
function writeFile(path,raw){
  demand(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=MAX_RAW,'PRIVATE_FILE_BOUND');
  let fd;try{directory(dirname(path),true);fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.fchmodSync(fd,0o600);let n=0;while(n<raw.length){const count=fs.writeSync(fd,raw,n,raw.length-n);demand(count>0,'PRIVATE_WRITE_FAILED');n+=count;}
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;syncDirectory(dirname(path));demand(readFile(path,MAX_RAW,true).equals(raw),'PRIVATE_WRITE_FAILED');
  }catch{throw error('PRIVATE_WRITE_FAILED');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function casePlan(value,actionId){
  closed(value,['version','actionId','programSha256','project','principal','bootstrapQuotaProject','caseRoot','toolchain']);
  demand(value.version===1&&value.actionId===actionId&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(actionId)&&sha(value.programSha256)&&value.caseRoot===CASE_ROOT,'CASE_REFUSED');
  closed(value.project,['projectId','displayName','labels','parent']);const p=value.project;
  demand(projectId(p.projectId)&&typeof p.displayName==='string'&&/^[A-Za-z0-9'" !-]{4,30}$/u.test(p.displayName)&&
    (p.parent===null||typeof p.parent==='string'&&/^(?:organizations|folders)\/[1-9][0-9]{0,18}$/u.test(p.parent)),'CASE_REFUSED');
  demand(p.labels&&Object.getPrototypeOf(p.labels)===Object.prototype&&Object.keys(p.labels).length<=64&&Object.entries(p.labels).every(([k,v])=>
    /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(k)&&typeof v==='string'&&(v===''||/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(v))),'CASE_REFUSED');
  closed(value.principal,['path','sha256']);privatePath(value.principal.path);demand(sha(value.principal.sha256)&&
    value.principal.path.startsWith('/run/lash-her-p2q-private/')&&!value.principal.path.startsWith(CASE_ROOT+'/'),'CASE_REFUSED');
  demand(value.bootstrapQuotaProject===null||projectId(value.bootstrapQuotaProject)&&value.bootstrapQuotaProject!==p.projectId,'CASE_REFUSED');
  closed(value.toolchain,['sdk','python','launcher']);
  for(const key of ['sdk','python']){const t=value.toolchain[key];closed(t,key==='sdk'?['root','device','inode','closureSha256','approvedSymlinks']:['root','device','inode','closureSha256','approvedSymlinks','executable']);
    privatePath(t.root);demand(typeof t.device==='string'&&/^\d+$/u.test(t.device)&&typeof t.inode==='string'&&/^[1-9]\d*$/u.test(t.inode)&&sha(t.closureSha256),'CASE_REFUSED');}
  privatePath(value.toolchain.python.executable);
  for(const root of [value.toolchain.sdk.root,value.toolchain.python.root])demand(root!=='/'&&root!==CASE_ROOT&&!root.startsWith(CASE_ROOT+'/')&&!CASE_ROOT.startsWith(root+'/')&&
    value.principal.path!==root&&!value.principal.path.startsWith(root+'/')&&!root.startsWith(dirname(value.principal.path)+'/'),'CASE_REFUSED');
  closed(value.toolchain.launcher,['relativePath','sha256']);demand(value.toolchain.launcher.relativePath==='bin/gcloud'&&sha(value.toolchain.launcher.sha256),'CASE_REFUSED');
  return Object.freeze(structuredClone(value));
}
function cleanAmbient(environment){
  demand(!Object.keys(environment).some(k=>/^(?:CLOUDSDK_|GCLOUD_|GOOGLE_|GCE_|GCP_|PYTHON|VIRTUAL_ENV$|BROWSER$|NODE_|NETRC$|OPENSSL_|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$|HTTPLIB2_|SSL|LD_|DYLD_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu.test(k)||/CREDENTIAL|ACCESS.?TOKEN|IMPERSONAT/iu.test(k)),'AMBIENT_OVERRIDE_REFUSED');
}
function sourceObservation(plan){
  demand(digest(readFile(PROGRAM,2_000_000))===plan.programSha256,'SOURCE_REQUIRED');
  const git=args=>execFileSync('/usr/bin/git',['-c','safe.directory='+SOURCE_ROOT,'-C',SOURCE_ROOT,...args],{encoding:'utf8',timeout:10000,maxBuffer:16_000_000,
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},stdio:['ignore','pipe','pipe']});
  demand(git(['status','--porcelain','--untracked-files=no']).trim()==='','SOURCE_REQUIRED');const head=git(['rev-parse','--verify','HEAD^{commit}']).trim();demand(/^[a-f0-9]{40}$/u.test(head),'SOURCE_REQUIRED');
  const entries=git(['ls-files','-s','-z','--','ops']).split('\0').filter(Boolean).map(line=>{const match=/^100(?:644|755) ([a-f0-9]{40}) 0\t(ops\/[^\0]+)$/u.exec(line);demand(match,'SOURCE_REQUIRED');return {blob:match[1],path:match[2]};}).filter(x=>SUFFIX.test(x.path));
  demand(entries.length>0&&entries.length<=512,'SOURCE_REQUIRED');let total=0;const records=[];
  for(const item of entries){demand(!item.path.split('/').includes('..'),'SOURCE_REQUIRED');const raw=readFile(join(SOURCE_ROOT,item.path),2_000_000);total+=raw.length;demand(total<=41_000_000,'SOURCE_REQUIRED');
    demand(createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex')===item.blob,'SOURCE_REQUIRED');records.push([item.path,digest(raw)]);}
  demand(git(['rev-parse','--verify','HEAD^{commit}']).trim()===head&&git(['status','--porcelain','--untracked-files=no']).trim()==='','SOURCE_REQUIRED');
  return {sourceCommit:head,sourceClosureSha256:digest(encoded(records.sort())),sourceFiles:records.length};
}
function physicalTree(root,approved){
  demand(approved&&Object.getPrototypeOf(approved)===Object.prototype&&Object.keys(approved).length<=128&&Object.entries(approved).every(([k,v])=>
    k!==''&&!isAbsolute(k)&&relative(root,resolve(root,k))===k&&typeof v==='string'&&v!==''&&!isAbsolute(v)&&!v.includes('\0')),'TOOLCHAIN_REQUIRED');
  directory(root);const records=[];let bytes=0;
  const record=value=>{demand(records.length<100000,'TOOLCHAIN_REQUIRED');records.push(value);};
  const found=new Set();
  function target(path,seen=new Set()){
    demand(path===root||path.startsWith(root+'/'),'TOOLCHAIN_REQUIRED');let current=root;const parts=relative(root,path).split('/').filter(Boolean);
    for(let i=0;i<parts.length;i++){current=join(current,parts[i]);const s=fs.lstatSync(current);if(s.isSymbolicLink()){
      const key=relative(root,current),text=fs.readlinkSync(current);demand(Object.hasOwn(approved,key)&&approved[key]===text&&!isAbsolute(text)&&!seen.has(current)&&seen.size<16,'TOOLCHAIN_REQUIRED');
      const next=new Set(seen);next.add(current);return target(resolve(dirname(current),text,...parts.slice(i+1)),next);
    }}return current;
  }
  function walk(path){const parent=fs.lstatSync(path);record([relative(root,path)||'.','directory',String(parent.dev),String(parent.ino),parent.mode&0o777]);
    for(const item of fs.readdirSync(path).sort()){const name=join(path,item),s=fs.lstatSync(name);demand(s.uid===OWNER_UID,'TOOLCHAIN_REQUIRED');
    if(s.isSymbolicLink()){const key=relative(root,name),text=fs.readlinkSync(name);demand(Object.hasOwn(approved,key)&&approved[key]===text,'TOOLCHAIN_REQUIRED');found.add(key);
      const resolved=target(name);demand(!(fs.lstatSync(resolved).isDirectory()&&(dirname(name)===resolved||dirname(name).startsWith(resolved+'/'))),'TOOLCHAIN_REQUIRED');
      record([key,'symlink',String(s.dev),String(s.ino),text,relative(root,resolved)]);
    }else{demand((s.mode&0o022)===0,'TOOLCHAIN_REQUIRED');if(s.isDirectory())walk(name);else{demand(s.isFile()&&records.length<100000,'TOOLCHAIN_REQUIRED');
      const raw=readFile(name,128_000_000,false,true);bytes+=raw.length;demand(bytes<=2_000_000_000,'TOOLCHAIN_REQUIRED');record([relative(root,name),String(s.dev),String(s.ino),s.mode&0o777,raw.length,digest(raw)]);}}
  }}
  walk(root);demand(records.length>0&&Object.keys(approved).length===found.size,'TOOLCHAIN_REQUIRED');return digest(encoded(records));
}
function verifyToolchain(plan){
  for(const key of ['sdk','python']){const t=plan.toolchain[key],s=fs.lstatSync(t.root);demand(String(s.dev)===t.device&&String(s.ino)===t.inode&&physicalTree(t.root,t.approvedSymlinks)===t.closureSha256,'TOOLCHAIN_REQUIRED');}
  const launcher=join(plan.toolchain.sdk.root,'bin/gcloud'),python=plan.toolchain.python.executable;
  demand(python.startsWith(plan.toolchain.python.root+'/')&&(fs.lstatSync(python).mode&0o111)!==0&&(fs.lstatSync(launcher).mode&0o111)!==0&&digest(readFile(launcher,2_000_000))===plan.toolchain.launcher.sha256,'TOOLCHAIN_REQUIRED');
}
function isolationIdentity(path){
  const marker=join(path,'sdk.netrc'),empty=join(path,'empty-ca');directory(empty,true);
  demand(readFile(marker,1024,true).equals(NETRC_MARKER)&&fs.readdirSync(empty).length===0,'PRIVATE_FILE_REQUIRED');
  const m=fs.lstatSync(marker),d=fs.lstatSync(empty);
  return {netrcDevice:String(m.dev),netrcInode:String(m.ino),emptyCaDevice:String(d.dev),emptyCaInode:String(d.ino)};
}
class PrivateCase {
  constructor(plan,mode){
    directory(CASE_ROOT,true);this.path=join(CASE_ROOT,plan.actionId);this.total=0;this.count=0;this.mode=mode;
    if(mode==='create'){try{fs.mkdirSync(this.path,{mode:0o700});syncDirectory(CASE_ROOT);}catch{throw error('CASE_ALREADY_BURNED');}}
    directory(this.path,true);this.identity=fs.lstatSync(this.path);this.parentIdentity=fs.lstatSync(CASE_ROOT);this.planSha256=digest(encoded(plan));
    const identity={rootDevice:String(this.parentIdentity.dev),rootInode:String(this.parentIdentity.ino),caseDevice:String(this.identity.dev),caseInode:String(this.identity.ino)};
    if(mode==='create'){
      for(const name of ['config','xdg','tmp','responses','empty-ca']){fs.mkdirSync(join(this.path,name),{mode:0o700});syncDirectory(this.path);}
      writeFile(join(this.path,'sdk.netrc'),NETRC_MARKER);this.isolation=isolationIdentity(this.path);
      this.write('case.json',encoded({version:1,actionId:plan.actionId,planSha256:this.planSha256,programSha256:plan.programSha256,identity,isolation:this.isolation}));}
    else{const record=parse(this.read('case.json'));this.isolation=isolationIdentity(this.path);
      demand(record.version===1&&record.actionId===plan.actionId&&record.planSha256===this.planSha256&&record.programSha256===plan.programSha256&&isDeepStrictEqual(record.identity,identity)&&isDeepStrictEqual(record.isolation,this.isolation),'ORIGINAL_INTENT_REQUIRED');
      const response=fs.readdirSync(join(this.path,'responses'));this.count=response.filter(x=>x.endsWith('.raw')).length;for(const name of response){const s=fs.lstatSync(join(this.path,'responses',name));this.total+=s.size;}
      // A deliberate GET-only reconciliation uses a fresh empty private auth config.
      demand(!fs.existsSync(join(this.path,'config')),'AUTH_PRINCIPAL_REQUIRED');fs.mkdirSync(join(this.path,'config'),{mode:0o700});syncDirectory(this.path);}
  }
  verify(){directory(CASE_ROOT,true);directory(this.path,true);const s=fs.lstatSync(this.path),p=fs.lstatSync(CASE_ROOT);demand(s.dev===this.identity.dev&&s.ino===this.identity.ino&&p.dev===this.parentIdentity.dev&&p.ino===this.parentIdentity.ino,'PRIVATE_DIRECTORY_REQUIRED');
    if(this.isolation)demand(isDeepStrictEqual(isolationIdentity(this.path),this.isolation),'PRIVATE_FILE_REQUIRED');}
  write(name,raw){this.verify();demand(/^(?:[a-z0-9-]+\.json|responses\/[0-9]{3}-[a-z-]+\.(?:raw|json))$/u.test(name),'PRIVATE_FILE_REQUIRED');writeFile(join(this.path,name),raw);}
  read(name){this.verify();demand(/^[a-z0-9-]+\.json$/u.test(name),'PRIVATE_FILE_REQUIRED');return readFile(join(this.path,name),MAX_RAW,true);}
  response(kind,status,raw){demand(/^[a-z-]+$/u.test(kind)&&Number.isInteger(status)&&status>=100&&status<=599&&Buffer.isBuffer(raw),'RESPONSE_REFUSED');
    demand(raw.length>0&&raw.length<=MAX_RAW&&this.total+raw.length<=MAX_TOTAL&&this.count<MAX_RESPONSES,'HTTP_BOUND');
    const stem='responses/'+String(this.count++).padStart(3,'0')+'-'+kind;this.total+=raw.length;
    this.write(stem+'.raw',raw);this.write(stem+'.json',encoded({version:1,kind,status,bytes:raw.length}));return parse(readFile(join(this.path,stem+'.raw'),MAX_RAW,true));}
  readResponse(kind){this.verify();const names=fs.readdirSync(join(this.path,'responses')).filter(n=>n.endsWith('-'+kind+'.json'));demand(names.length===1,'ORIGINAL_INTENT_REQUIRED');
    const info=parse(readFile(join(this.path,'responses',names[0]),MAX_RAW,true));demand(info.kind===kind&&info.status===200,'ORIGINAL_INTENT_REQUIRED');const raw=readFile(join(this.path,'responses',names[0].replace(/\.json$/u,'.raw')),MAX_RAW,true);return {value:parse(raw),rawSha256:digest(raw)};}
}
function principal(plan){directory(dirname(plan.principal.path),true);const raw=readFile(plan.principal.path,4096,true);demand(digest(raw)===plan.principal.sha256,'AUTH_PRINCIPAL_REQUIRED');
  const value=parse(raw);closed(value,['version','principal']);demand(value.version===1&&account(value.principal),'AUTH_PRINCIPAL_REQUIRED');return value.principal;}
function verifySdkInputs(plan,store){
  store.verify();const ca=join(plan.toolchain.sdk.root,SDK_CA_RELATIVE),modules=join(plan.toolchain.python.root,'lib/openssl/ossl-modules');
  directory(dirname(ca));readFile(ca,2_000_000);directory(modules);demand(fs.readdirSync(modules).length===0,'TOOLCHAIN_REQUIRED');
  const nullDevice=fs.lstatSync('/dev/null');demand(nullDevice.isCharacterDevice()&&!nullDevice.isSymbolicLink()&&nullDevice.uid===0,'TOOLCHAIN_REQUIRED');
}
function childEnvironment(plan,store){return {PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',XDG_CONFIG_HOME:join(store.path,'xdg'),XDG_CACHE_HOME:join(store.path,'tmp'),TMPDIR:join(store.path,'tmp'),
  NETRC:join(store.path,'sdk.netrc'),OPENSSL_CONF:'/dev/null',OPENSSL_MODULES:join(plan.toolchain.python.root,'lib/openssl/ossl-modules'),
  SSL_CERT_FILE:join(plan.toolchain.sdk.root,SDK_CA_RELATIVE),REQUESTS_CA_BUNDLE:join(plan.toolchain.sdk.root,SDK_CA_RELATIVE),SSL_CERT_DIR:join(store.path,'empty-ca'),
  HTTPLIB2_CA_CERTS:join(plan.toolchain.sdk.root,SDK_CA_RELATIVE),CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION:'false',
  CLOUDSDK_CONFIG:join(store.path,'config'),CLOUDSDK_PYTHON:plan.toolchain.python.executable,CLOUDSDK_PYTHON_ARGS:'-B -s',
  CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE:join(plan.toolchain.sdk.root,SDK_CA_RELATIVE),
  CLOUDSDK_CORE_DISABLE_USAGE_REPORTING:'true',CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK:'true',CLOUDSDK_CORE_LOG_HTTP:'false',
  CLOUDSDK_CORE_DISABLE_FILE_LOGGING:'true',CLOUDSDK_CORE_CHECK_GCE_METADATA:'false',NO_GCE_CHECK:'true',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};}
function cliArgs(kind,expected){
  if(kind==='login')return ['auth','login',expected,'--no-launch-browser','--brief','--verbosity=none'];
  if(kind==='list')return ['auth','list','--format=json(account,status)','--verbosity=none'];
  if(kind==='token')return ['auth','print-access-token',expected,'--verbosity=none'];
  if(kind==='revoke')return ['auth','revoke',expected,'--quiet','--verbosity=none'];
  throw error('AUTH_COMMAND_FAILED');
}
async function cli(plan,store,kind,expected){
  const interactive=kind==='login';demand(!interactive||process.stdin.isTTY===true&&process.stdout.isTTY===true&&process.stderr.isTTY===true,'AUTH_TTY_REQUIRED');
  verifySdkInputs(plan,store);
  return new Promise((accept,reject)=>{const child=spawn(plan.toolchain.python.executable,['-I','-B','-S','-c',UMASK_WRAPPER,join(plan.toolchain.sdk.root,'bin/gcloud'),...cliArgs(kind,expected)],
    {cwd:store.path,env:childEnvironment(plan,store),stdio:interactive?'inherit':['ignore','pipe','pipe'],shell:false});
    let output=Buffer.alloc(0),failed=false;const stop=()=>{failed=true;child.kill('SIGKILL');};const timer=setTimeout(stop,interactive?300000:15000);
    if(!interactive){child.stdout.on('data',part=>{if(output.length+part.length>16384)stop();else output=Buffer.concat([output,part]);});let n=0;child.stderr.on('data',part=>{n+=part.length;if(n>16384)stop();});}
    child.once('error',()=>{clearTimeout(timer);reject(error('AUTH_COMMAND_FAILED'));});child.once('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(error('AUTH_COMMAND_FAILED'));else accept(output);});});
}
function assertPrincipal(raw,expected,empty=false){const rows=parse(raw);demand(Array.isArray(rows)&&rows.length===(empty?0:1)&&rows.every(row=>{
  closed(row,['account','status']);return row.account===expected&&row.status==='ACTIVE'&&account(row.account); }),'AUTH_PRINCIPAL_REQUIRED');}
function route(kind,name){
  if(kind==='search'){demand(projectId(name),'PROJECT_REQUIRED');return ['GET','/v3/projects:search?query='+encodeURIComponent('projectId:'+name)+'&pageSize=100'];}
  if(kind==='preflight'){demand(projectId(name),'PROJECT_REQUIRED');return ['GET','/v3/projects/'+name];}
  if(kind==='create')return ['POST','/v3/projects'];
  if(kind==='operation'){demand(typeof name==='string'&&name.length<=512&&/^operations\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(name)&&!name.split('/').some(s=>s==='.'||s==='..'),'OPERATION_REQUIRED');return ['GET','/v3/'+name];}
  demand(projectName(name),'PROJECT_REQUIRED');if(kind==='project')return ['GET','/v3/'+name];if(kind==='iam')return ['POST','/v3/'+name+':getIamPolicy'];throw error('HTTP_STATUS_REFUSED');
}
async function request(plan,kind,name,token,body){
  const [method,path]=route(kind,name),raw=body===undefined?undefined:encoded(body);demand(typeof token==='string'&&/^[A-Za-z0-9._~+\/-]{16,8192}$/u.test(token),'AUTH_TOKEN_REQUIRED');
  return new Promise((accept,reject)=>{let settled=false,timer;const fail=()=>{if(!settled){settled=true;clearTimeout(timer);reject(error('HTTP_UNCERTAIN'));}};
    const req=https.request({protocol:'https:',hostname:HOST,port:443,path,method,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',
      headers:{Authorization:'Bearer '+token,Accept:'application/json',...(plan.bootstrapQuotaProject===null?{}:{'X-Goog-User-Project':plan.bootstrapQuotaProject}),
        ...(raw?{'Content-Type':'application/json','Content-Length':raw.length}:{})}},res=>{
      const chunks=[];let n=0;res.on('data',part=>{n+=part.length;if(n>MAX_RAW){res.destroy();fail();}else chunks.push(part);});
      res.once('error',fail);res.once('aborted',fail);res.once('end',()=>{if(!res.complete){fail();return;}if(!settled){settled=true;clearTimeout(timer);accept({status:res.statusCode,raw:Buffer.concat(chunks)});}});});
    timer=setTimeout(()=>{req.destroy();fail();},15000);req.setTimeout(15000,()=>{req.destroy();fail();});req.once('error',fail);if(raw)req.write(raw);req.end();});
}
function creationBody(plan){const {parent,...body}=plan.project;return parent===null?body:{...body,parent};}
function operation(value,expectedName){
  demand(value&&typeof value==='object'&&typeof value.name==='string','OPERATION_REQUIRED');route('operation',value.name);if(expectedName)demand(value.name===expectedName,'OPERATION_REQUIRED');
  demand(value.done===undefined||typeof value.done==='boolean','OPERATION_REQUIRED');demand(!value.error,'OPERATION_ERROR');
  if(value.done===true){demand(value.response&&typeof value.response==='object'&&value.response['@type']==='type.googleapis.com/google.cloud.resourcemanager.v3.Project','OPERATION_REQUIRED');return {name:value.name,project:value.response};}
  demand(value.response===undefined,'OPERATION_REQUIRED');return {name:value.name,project:null};
}
function project(value,plan,notBefore,notAfter,expectedName){
  const p=plan.project;demand(value&&projectName(value.name)&&value.projectId===p.projectId&&value.displayName===p.displayName&&value.state==='ACTIVE'&&
    (value.parent??null)===p.parent&&isDeepStrictEqual(value.labels??{},p.labels)&&value.deleteTime===undefined,'PROJECT_REQUIRED');
  if(expectedName)demand(value.name===expectedName,'PROJECT_REQUIRED');
  const stamp=typeof value.createTime==='string'&&/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/u.exec(value.createTime);
  demand(stamp&&Number.isFinite(Date.parse(value.createTime))&&new Date(Date.parse(stamp[1]+'.000Z')).toISOString().slice(0,19)===stamp[1]&&
    Date.parse(value.createTime)>=Date.parse(notBefore)-30000&&Date.parse(value.createTime)<=Date.parse(notAfter)+30000,'PROJECT_REQUIRED');return value.name;
}
function iam(value,expected){
  demand(value&&[1,3].includes(value.version??1)&&Array.isArray(value.bindings)&&value.bindings.length===1,'IAM_REQUIRED');const b=value.bindings[0];
  demand(b&&b.role==='roles/owner'&&b.condition===undefined&&Array.isArray(b.members)&&b.members.length===1&&b.members[0]==='user:'+expected&&
    (value.auditConfigs===undefined||Array.isArray(value.auditConfigs)&&value.auditConfigs.length===0),'IAM_REQUIRED');
}
function safeCode(e){return e&&typeof e.code==='string'&&e.code.startsWith('P2Q_GOOGLE_')&&codes.has(e.code.slice(11))?e.code:'P2Q_GOOGLE_OBSERVATION_UNKNOWN';}
function receipt(plan,status,details){return Object.freeze({version:1,actionId:plan.actionId,projectId:plan.project.projectId,status,...flags,...details});}
function productionRuntime(plan,store){let baseline;
  const verify=()=>{store.verify();principal(plan);verifyToolchain(plan);verifySdkInputs(plan,store);const current=sourceObservation(plan);if(baseline)demand(isDeepStrictEqual(current,baseline),'SOURCE_REQUIRED');else baseline=current;return current;};
  return {now:()=>new Date().toISOString(),wait:()=>new Promise(r=>setTimeout(r,2000)),verify,
  command:(kind,expected)=>{verify();return cli(plan,store,kind,expected);},http:(kind,name,token,body)=>request(plan,kind,name,token,body),
  principal:()=>principal(plan),
};}
async function cleanup(store,rt,expected,loginAttempted){
  if(!loginAttempted)return true;try{await rt.verify();assertPrincipal(await rt.command('list',expected),expected);await rt.verify();await rt.command('revoke',expected);
    await rt.verify();assertPrincipal(await rt.command('list',expected),expected,true);await rt.verify();const config=join(store.path,'config');directory(config,true);
    function inspect(path){for(const name of fs.readdirSync(path)){const p=join(path,name),s=fs.lstatSync(p);demand(!s.isSymbolicLink()&&s.uid===OWNER_UID,'PRIVATE_FILE_REQUIRED');if(s.isDirectory())inspect(p);else demand(s.isFile(),'PRIVATE_FILE_REQUIRED');}}
    inspect(config);fs.rmSync(config,{recursive:true});syncDirectory(store.path);return true;
  }catch{return false;}
}
async function execute(plan,mode,store,rt){
  let expected,loginAttempted=false,postAttempted=false,acknowledged=false,observed=null,source,code=null,status='P2Q_GOOGLE_REQUIRES_REVIEW';
  let requestCount=0,creationPosts=0,readPosts=0,originalIntent,operationName;
  async function call(kind,name,body){await rt.verify();assertPrincipal(await rt.command('list',expected),expected);
    const raw=await rt.command('token',expected);let token=new TextDecoder('utf-8',{fatal:true}).decode(raw).trim();demand(/^[A-Za-z0-9._~+\/-]{16,8192}$/u.test(token),'AUTH_TOKEN_REQUIRED');
    assertPrincipal(await rt.command('list',expected),expected);await rt.verify();
    if(kind==='create'){postAttempted=true;creationPosts++;}if(kind==='iam')readPosts++;requestCount++;
    let response;try{response=await rt.http(kind,name,token,body);}finally{token=undefined;}
    // Raw bytes and their status are durable before any JSON is interpreted.
    const value=store.response(kind,response.status,response.raw);await rt.verify();
    if(response.status===409&&kind==='create')throw error('CREATE_ALREADY_EXISTS');
    if(response.status!==200&&!(kind==='preflight'&&response.status===404))throw error('HTTP_STATUS_REFUSED');return {status:response.status,value,rawSha256:digest(response.raw)};
  }
  try{
    source=await rt.verify();expected=rt.principal();demand(account(expected),'AUTH_PRINCIPAL_REQUIRED');
    if(mode==='create')store.write('source.json',encoded(source));
    else{demand(isDeepStrictEqual(parse(store.read('source.json')),source),'SOURCE_REQUIRED');originalIntent=parse(store.read('create-intent.json'));const burn=parse(store.read('create-started.json'));
      demand(originalIntent.version===1&&originalIntent.planSha256===store.planSha256&&originalIntent.programSha256===plan.programSha256&&
        isDeepStrictEqual(originalIntent.body,creationBody(plan))&&burn.intentSha256===digest(store.read('create-intent.json')),'ORIGINAL_INTENT_REQUIRED');}
    loginAttempted=true;await rt.command('login',expected);assertPrincipal(await rt.command('list',expected),expected);
    if(mode==='create'){
      const pre=await call('preflight',plan.project.projectId);demand(pre.status===404,'EXISTING_PROJECT_REQUIRES_REVIEW');
      const found=(await call('search',plan.project.projectId)).value;demand(found&&Array.isArray(found.projects??[])&&(found.projects??[]).length===0&&!found.nextPageToken,'EXISTING_PROJECT_REQUIRES_REVIEW');
      originalIntent={version:1,actionId:plan.actionId,planSha256:store.planSha256,programSha256:plan.programSha256,startedAt:rt.now(),body:creationBody(plan)};
      const intent=encoded(originalIntent);store.write('create-intent.json',intent);store.write('create-started.json',encoded({version:1,intentSha256:digest(intent)}));
      let response;try{response=await call('create',null,creationBody(plan));}catch(e){if(safeCode(e)!=='P2Q_GOOGLE_HTTP_UNCERTAIN')throw e;code=safeCode(e);}
      if(response){demand(response.value&&typeof response.value.name==='string','OPERATION_REQUIRED');route('operation',response.value.name);operationName=response.value.name;
        store.write('create-ack.json',encoded({version:1,operationName,intentSha256:digest(intent),rawSha256:response.rawSha256}));acknowledged=true;
        observed=operation(response.value).project;}
    }else{
      try{const ack=parse(store.read('create-ack.json')),raw=store.readResponse('create');demand(ack.intentSha256===digest(store.read('create-intent.json'))&&ack.rawSha256===raw.rawSha256,'ORIGINAL_INTENT_REQUIRED');
        const result=operation(raw.value,ack.operationName);acknowledged=true;operationName=result.name;observed=result.project;
      }catch(e){if(fs.existsSync(join(store.path,'create-ack.json')))throw e;}
    }
    if(operationName){for(let i=0;observed===null&&i<24;i++){await rt.wait();observed=operation((await call('operation',operationName)).value,operationName).project;}}
    else{for(let i=0;i<12&&observed===null;i++){const found=(await call('search',plan.project.projectId)).value;
      demand(found&&Array.isArray(found.projects??[])&&(found.projects??[]).length<=1&&!found.nextPageToken,'OBSERVATION_UNKNOWN');
      if(found.projects?.length)observed=found.projects[0];else await rt.wait();}}
    demand(observed!==null,'OBSERVATION_UNKNOWN');const name=project(observed,plan,originalIntent.startedAt,rt.now());
    const current=(await call('project',name)).value;project(current,plan,originalIntent.startedAt,rt.now(),name);iam((await call('iam',name,{options:{requestedPolicyVersion:3}})).value,expected);
    const last=(await call('project',name)).value;project(last,plan,originalIntent.startedAt,rt.now(),name);
    demand(isDeepStrictEqual(current,last),'PROJECT_REQUIRED');
    status=acknowledged?'P2Q_GOOGLE_ORIGINAL_CREATE_OBSERVED':'P2Q_GOOGLE_RECONCILED_CURRENT_NOT_ORIGINAL_CREATION';
    if(!acknowledged&&code===null)code='P2Q_GOOGLE_OBSERVATION_UNKNOWN';
  }catch(e){code=safeCode(e);}
  const cleaned=await cleanup(store,rt,expected,loginAttempted);
  const result=receipt(plan,status,{code,creationPostAttempted:postAttempted,creationPostCount:creationPosts,readPostCount:readPosts,requestCount,
    originalCreationAcknowledged:acknowledged,creationOutcome:acknowledged?'ORIGINAL_ACK_OBSERVED':'UNKNOWN',credentialCleanupVerified:cleaned,custodyIncomplete:!cleaned,
    planSha256:store.planSha256,programSha256:plan.programSha256,sourceCommit:source?.sourceCommit??null,
    searchIsGlobalAbsenceProof:false,iamIsCompleteControlProof:false,requiresOwnerReview:code!==null||!cleaned});
  try{store.write('outcome-'+randomBytes(8).toString('hex')+'.json',encoded(result));}catch{return receipt(plan,'P2Q_GOOGLE_REQUIRES_REVIEW',{...result,status:'P2Q_GOOGLE_REQUIRES_REVIEW',code:'P2Q_GOOGLE_PRIVATE_WRITE_FAILED',requiresOwnerReview:true});}
  return result;
}
function principalClaim(plan,expected){
  directory(CASE_ROOT,true);const path=join(CASE_ROOT,'principal-'+digest(Buffer.from(expected))+'.claim.json');
  const bytes=encoded({version:1,actionId:plan.actionId,claimNonce:randomBytes(32).toString('hex'),planSha256:digest(encoded(plan))});
  try{writeFile(path,bytes);}catch{throw error('PRINCIPAL_CLAIM_REQUIRES_REVIEW');}
  // No PID reuse heuristic, time expiry or stale-file deletion. An uncertain
  // holder needs a separate reviewed recovery boundary, which is absent here.
  return ()=>{demand(readFile(path,MAX_RAW,true).equals(bytes),'PRINCIPAL_CLAIM_REQUIRES_REVIEW');fs.unlinkSync(path);syncDirectory(CASE_ROOT);};
}
function claimMayClose(result){return result.code===null&&result.originalCreationAcknowledged===true&&result.requiresOwnerReview===false&&result.credentialCleanupVerified===true&&result.custodyIncomplete===false;}
async function run(actionId,mode){
  // Compiled policy is empty. No file, environment, auth, child or network read
  // may occur before exact source-registry selection.
  demand(typeof actionId==='string'&&Object.hasOwn(P2Q_GOOGLE_PROJECT_CAPTURE_CASES,actionId),'CASE_UNREGISTERED');
  const plan=casePlan(P2Q_GOOGLE_PROJECT_CAPTURE_CASES[actionId],actionId);cleanAmbient(process.env);
  demand(process.geteuid?.()===OWNER_UID,'PRIVATE_DIRECTORY_REQUIRED');sourceObservation(plan);verifyToolchain(plan);
  if(mode==='create')demand(!fs.existsSync(join(CASE_ROOT,plan.actionId)),'CASE_ALREADY_BURNED');
  const releaseClaim=principalClaim(plan,principal(plan));let store,result;
  try{store=new PrivateCase(plan,mode);result=await execute(plan,mode,store,productionRuntime(plan,store));
    if(claimMayClose(result)){releaseClaim();return {...result,principalSerialization:'exclusive-private-claim',holderRecoveryRequired:false};}
  }catch(e){if(!store)throw e;result=receipt(plan,'P2Q_GOOGLE_REQUIRES_REVIEW',{code:safeCode(e),requiresOwnerReview:true,custodyIncomplete:true});}
  return {...result,principalSerialization:'exclusive-private-claim',holderRecoveryRequired:true};
}
export async function allocateP2qGoogleProject(actionId){try{demand(arguments.length===1,'CASE_REFUSED');return await run(actionId,'create');}catch(e){throw error(safeCode(e).slice(11));}}
export async function reconcileP2qGoogleProject(actionId){try{demand(arguments.length===1,'CASE_REFUSED');return await run(actionId,'reconcile');}catch(e){throw error(safeCode(e).slice(11));}}
