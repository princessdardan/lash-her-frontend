"""Run the actual Python profile observer using a projected Docker launcher."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback
from unittest.mock import patch

source = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source / 'ops/platform/host'))
import migrate
import migrate_test
import p2_certification_parent as cert
from p2_source_closure import TYPES

def sanitized_failure(kind, value, trace):
    import re
    message = str(value)
    code = message if re.fullmatch(r'P2_[A-Z0-9_]{1,100}',message) else None
    frames = [item for item in traceback.extract_tb(trace) if Path(item.filename).name in (
        'physical-host-bridge.py','p2_certification_parent.py','p2_source_closure.py','migrate.py')]
    print(json.dumps({'kind':kind.__name__,'code':code,'frames':[
        [Path(item.filename).name,item.lineno] for item in frames[-4:]]}),file=sys.stderr)
sys.excepthook = sanitized_failure

packet = json.load(sys.stdin)
probe, operation = packet['probe'], packet['operation']
assert operation in ('verify-schema','witness','verify-closed')
assert os.environ.get('NODE_EXTRA_CA_CERTS')
real_run = subprocess.run
node = sys.argv[2]
assert Path(node).is_absolute() and Path(node).name == 'node'
credential = packet['ownedCredential']
from urllib.parse import urlsplit
assert urlsplit(credential).hostname == '127.0.0.1'
fixture = migrate_test.MigrationDriverTests()
fixture.setUp()
try:
    fixture.add_frontend()
    profile = fixture.profiled()
    assert profile == probe['qualificationTargetProfile']
    program = source / cert.OBSERVER
    program_sha = migrate.file_hash(program.read_bytes())
    manifest = {path.relative_to(source).as_posix():migrate.file_hash(path.read_bytes())
                for path in (source / 'ops').rglob('*') if path.is_file() and path.suffix in TYPES}
    closure = migrate.file_hash(json.dumps(sorted(manifest.items()), separators=(',', ':')).encode())
    cert.cache_certification_core({'version':2,'qualificationTargetProfile':profile,
        'mode':'p2-profiled-known-ack-interrupted-restoration','sourceSha256':manifest,'sourceClosureSha256':closure},
        source,expected_profile=profile)
    with tempfile.TemporaryDirectory(prefix='p2q-owned-host-observer-') as tmp:
        private = Path(tmp)
        observer_program = private / program.name
        observer_program.write_bytes(program.read_bytes())
        observer = cert.P2CertificationPhysicalObserver(
            fixture.release, probe, source, credential, program=observer_program, program_sha256=program_sha,
            expected_profile=profile, interrupted=True,
        )
        requests = []
        def runner(args, **options):
            if args[:3] == ['docker','rm','--force']:
                assert args[3] == requests[-1]['container']
                return subprocess.CompletedProcess(args, 0)
            assert args[:5] == ['docker','run','--rm','--pull','never']
            assert args[-2:] == [cert.OBSERVER,'--profiled-known-ack-interrupted']
            assert '--network' in args and args[args.index('--network')+1] == 'host'
            assert '--read-only' in args and options['env']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'] == credential
            request = json.loads(options['input'])
            assert request == {**probe,'operation':operation}
            requests.append({'container':args[args.index('--name')+1],'operation':operation})
            return real_run([node,'--experimental-strip-types',str(program),'--profiled-known-ack-interrupted'],
                env={'PATH':os.environ['PATH'],'NODE_EXTRA_CA_CERTS':os.environ['NODE_EXTRA_CA_CERTS'],
                     'FRONTEND_STAGING_MIGRATION_DATABASE_URL':credential},
                input=options['input'],capture_output=True,text=True,timeout=30,check=True)
        with patch.object(cert.subprocess,'run',runner), patch.object(cert.runtime,'command',return_value=''):
            try:
                result = observer.probe(operation)
                expected_status = ('P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' if operation=='verify-closed'
                                   else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED')
                assert result['status'] == expected_status
                print(json.dumps({'status':expected_status,'operation':operation,
                    'backendPid':result['backendPid'],'journalSha256':result['journalSha256'],
                    'witnessSha256':result['witnessSha256'],'physicalClosed':result.get('backendAbsent') is True}))
            except subprocess.CalledProcessError as error:
                assert operation == 'verify-closed' and error.returncode == 1
                print(json.dumps({'status':'P2_PROFILED_INTERRUPTED_OWNED_CLOSURE_REFUSED','operation':operation}))
        assert len(requests) == 1
finally:
    fixture.tearDown()
