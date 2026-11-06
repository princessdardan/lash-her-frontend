"""Observation-only first-install host collector. Never an absent-gateway permit.

A future allocation/control factory must independently qualify original first
use. This module cannot construct release, migration or provider authority.
"""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

LOCK_PATH=Path('/run/lock/lash-her-release.lock')
STAGING_ROOT=Path('/var/lib/lash-her/releases/staging')
MACHINE_ID=Path('/etc/machine-id')
DOCKER='/usr/bin/docker'
ENVIRONMENT={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'}


def require(value,code):
    if not value:
        raise ValueError(code)


def profile(request):
    require(type(request) is dict and set(request)=={'version','operation','qualificationTargetProfile','candidate','job','actionId'} and
            type(request['version']) is int and request['version']==1 and request['operation']=='observe' and
            re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',request['actionId'] or ''),'P2Q_FIRST_INSTALL_HOST_REQUEST_REFUSED')
    try:
        from qualification_target_profile import require_qualification_target_profile,resolve_qualification_target_profile
    except ImportError:
        raise ValueError('P2Q_FIRST_INSTALL_PROFILE_REGISTRY_REQUIRED') from None
    ref=require_qualification_target_profile(request['qualificationTargetProfile'],request['candidate'],request['job'])
    definition=resolve_qualification_target_profile(ref)
    require(definition['kind']=='isolated-allocated' and definition['selectionPolicy']=='isolated-allocated-v1' and definition['environment']=='staging',
            'QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED')
    require(request['candidate'].get('version')==3 and request['candidate'].get('environment')=='staging' and
            request['job'].get('version')==2 and request['job'].get('environment')=='staging' and
            request['candidate']['releaseId']==request['job']['releaseId'] and
            request['candidate']['sources']['frontend']['commit']==request['job']['sourceCommit'],'P2Q_FIRST_INSTALL_SOURCE_BINDING_REQUIRED')
    return ref


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()


def command(arguments):
    result=subprocess.run([DOCKER,*arguments],stdin=subprocess.DEVNULL,capture_output=True,timeout=15,env=ENVIRONMENT)
    require(result.returncode==0 and len(result.stdout)<=65536,'P2Q_FIRST_INSTALL_DOCKER_OBSERVATION_REQUIRED')
    return result.stdout.decode('utf8')


def machine():
    info=MACHINE_ID.lstat()
    require(stat.S_ISREG(info.st_mode) and not MACHINE_ID.is_symlink() and 0<info.st_size<=128,'P2Q_FIRST_INSTALL_MACHINE_ID_REQUIRED')
    value=MACHINE_ID.read_text().strip()
    require(re.fullmatch(r'[a-f0-9]{32}',value) and value!='0'*32,'P2Q_FIRST_INSTALL_MACHINE_ID_REQUIRED')
    return value


def retained_metadata():
    root=STAGING_ROOT.lstat()
    require(stat.S_ISDIR(root.st_mode) and not STAGING_ROOT.is_symlink() and root.st_uid==os.getuid() and not root.st_mode&0o022,
            'P2Q_FIRST_INSTALL_STAGING_ROOT_REQUIRED')
    require(not (STAGING_ROOT/'.p2-gateway-lineage.json').exists(),'P2Q_FIRST_INSTALL_PRIOR_LINEAGE_PRESENT')
    rows=[]
    for current,directories,files in os.walk(STAGING_ROOT,followlinks=False):
        for name in sorted(directories+files):
            path=Path(current)/name;info=path.lstat()
            require(not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) and info.st_uid==os.getuid(),
                    'P2Q_FIRST_INSTALL_UNKNOWN_HOST_ENTRY')
            rows.append((path.relative_to(STAGING_ROOT).as_posix(),'directory' if stat.S_ISDIR(info.st_mode) else 'file',info.st_dev,info.st_ino))
            require(len(rows)<=4096,'P2Q_FIRST_INSTALL_HOST_INVENTORY_BOUND')
    # Metadata only. Configuration/credential bytes are never read or hashed.
    return {'rootDevice':root.st_dev,'rootInode':root.st_ino,'entryCount':len(rows),'metadataSha256':hashlib.sha256(canonical(sorted(rows))).hexdigest()}


class HostObservation:
    def __init__(self,request):
        self.ref=copy.deepcopy(profile(request))  # Before descriptor, process or Docker work.
        self.request=copy.deepcopy(request);self.fd=None;self.active=False

    def __enter__(self):
        self.fd=os.open(LOCK_PATH,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(self.fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'P2Q_FIRST_INSTALL_HOST_LOCK_REQUIRED')
            fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.lock_identity=(info.st_dev,info.st_ino);self.active=True
            self.baseline=copy.deepcopy(self._observe());return self
        except BaseException:
            self.active=False;os.close(self.fd);self.fd=None;raise

    def _observe(self):
        require(self.active and self.fd is not None,'P2Q_FIRST_INSTALL_HOST_OBSERVATION_CLOSED')
        current,opened=LOCK_PATH.lstat(),os.fstat(self.fd)
        require(stat.S_ISREG(current.st_mode) and not LOCK_PATH.is_symlink() and current.st_uid==os.getuid() and not current.st_mode&0o077 and
                (current.st_dev,current.st_ino)==(opened.st_dev,opened.st_ino)==self.lock_identity,'P2Q_FIRST_INSTALL_HOST_LOCK_CHANGED')
        fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        identity=machine();metadata=retained_metadata()
        daemon=json.loads(command(['info','--format','{{json .ID}}']))
        require(type(daemon) is str and re.fullmatch(r'[A-Za-z0-9:_-]{1,200}',daemon),'P2Q_FIRST_INSTALL_DOCKER_ID_REQUIRED')
        containers=command(['ps','-aq','--no-trunc']).splitlines()
        require(len(containers)==0,'P2Q_FIRST_INSTALL_EXISTING_CONTAINER')
        require(machine()==identity and retained_metadata()==metadata,'P2Q_FIRST_INSTALL_HOST_OBSERVATION_DRIFT')
        return {'version':1,'status':'P2Q_FIRST_INSTALL_HOST_OBSERVED_NO_CONTAINERS','qualificationTargetProfile':copy.deepcopy(self.ref),'actionId':self.request['actionId'],
                'releaseId':self.request['candidate']['releaseId'],'sourceCommit':self.request['job']['sourceCommit'],'hostMachineId':identity,
                'observerPid':os.getpid(),'lockDevice':current.st_dev,'lockInode':current.st_ino,'dockerDaemonId':daemon,'dockerContainerCount':0,
                'retainedMetadata':metadata,'observationOnly':True,'firstUseAuthorized':False,'creationControlProven':False,'credentialDeliveryHistoryProven':False,
                'providerBeforeUseProven':False,'migrationAuthorized':False,'rolePreparationAuthorized':False}

    def observe(self):
        value=self._observe()
        require(value==self.baseline,'P2Q_FIRST_INSTALL_HOST_OBSERVATION_DRIFT')
        return value

    def __exit__(self,*_error):
        self.active=False
        if self.fd is not None:os.close(self.fd);self.fd=None


def main():
    request=json.loads(sys.stdin.readline())
    with HostObservation(request) as observation:
        print(json.dumps(observation.observe()),flush=True)
        for line in sys.stdin:
            value=json.loads(line)
            require(type(value) is dict and set(value)=={'operation'} and value['operation'] in ('check','close'),'P2Q_FIRST_INSTALL_HOST_OPERATION_REFUSED')
            if value['operation']=='close':return
            print(json.dumps(observation.observe()),flush=True)


if __name__=='__main__':
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    try:main()
    except BaseException:
        print(json.dumps({'status':'P2Q_FIRST_INSTALL_HOST_OBSERVATION_REFUSED','firstUseAuthorized':False}),file=sys.stderr)
        raise SystemExit(1)
