"""Actual owned Node failure diagnostics, never a configured database."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import ssl
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'ops/platform/test-p2-recovery-owned.py'
NS={'json':json,'os':os,'Path':Path,'re':re,'sys':sys,'signal':signal,'ast':ast,'traceback':traceback,'urllib':urllib,'ssl':ssl}
NAMES={'OWNED_CHILD_PHASES','OWNED_CHILD_ERROR_CODES','child_environment','child_failure_diagnostic','report_child_failure','OWNED_BRIDGE_SOURCE_FILES','OWNED_BRIDGE_ERROR_KINDS','owned_bridge_guard_codes','owned_bridge_diagnostic','read_owned_bridge_diagnostics'}
NODES=[node for node in ast.parse(SOURCE.read_text()).body if isinstance(node,(ast.FunctionDef,ast.Assign)) and
    (node.name if isinstance(node,ast.FunctionDef) else node.targets[0].id) in NAMES]
exec(compile(ast.Module(body=NODES,type_ignores=[]),str(SOURCE),'exec'),NS)


class OwnedRecoveryDiagnosticsTests(unittest.TestCase):
    def result(self,stderr='',stdout='',returncode=1):return subprocess.CompletedProcess(['owned-source-only'],returncode,stdout,stderr)
    def diagnostic(self,result,forward=True):return NS['child_failure_diagnostic'](result,{'frontend':ROOT},forward)
    def emitted(self,result):
        output=io.StringIO()
        with contextlib.redirect_stderr(output):NS['report_child_failure'](result,{'frontend':ROOT},True)
        lines=output.getvalue().splitlines();self.assertEqual(lines[0],'OWNED_P2_RECOVERY_CHILD_FAILED')
        return output.getvalue(),json.loads(lines[1])

    def test_phase_error_and_source_relative_frames_exclude_private_values(self):
        raw='\n'.join([json.dumps({'status':'OWNED_P2_RECOVERY_PHASE','phase':'frontend-connect'}),
            'AssertionError: postgresql://private-user:PRIVATE_PASSWORD@private.invalid/db SELECT PRIVATE_SQL',
            'actual: PRIVATE_EXPECTED, expected: PRIVATE_ENV',"code: 'ERR_ASSERTION'",
            ' at '+str(ROOT/'ops/platform/test-p2-recovery-owned.mjs')+':27:7',
            json.dumps({'status':'OWNED_P2_RECOVERY_PHASE','phase':'forward-new-build-probe-promote'})])
        encoded,value=self.emitted(self.result(raw,'PRIVATE_STDOUT'))
        self.assertEqual(value['phase'],'forward-new-build-probe-promote');self.assertEqual(value['errorKind'],'AssertionError')
        self.assertEqual(value['errorCode'],'ERR_ASSERTION')
        self.assertEqual(value['frames'],[{'source':'frontend','file':'ops/platform/test-p2-recovery-owned.mjs','line':27,'column':7}])
        for secret in ('PRIVATE_PASSWORD','PRIVATE_SQL','PRIVATE_EXPECTED','PRIVATE_ENV','PRIVATE_STDOUT','postgresql://','private.invalid',str(ROOT)):
            self.assertNotIn(secret,encoded)
        self.assertFalse(value['rawChildOutputRetained'])

    def test_unknown_values_and_outside_paths_stay_unknown(self):
        raw='TypeError: PRIVATE_MESSAGE\ncode: PRIVATE_CODE\n at /private/secret/PRIVATE_PATH.mjs:1:1\n'+json.dumps({'status':'OWNED_P2_RECOVERY_PHASE','phase':'PRIVATE_PHASE'})
        value=self.diagnostic(self.result(raw),False)
        self.assertEqual(value['phase'],'unknown');self.assertEqual(value['errorCode'],'unknown');self.assertEqual(value['frames'],[])
        self.assertEqual(value['fixture'],'current');self.assertNotIn('PRIVATE_',json.dumps(value))

    def test_signal_and_last_phase_survive_missing_error_text(self):
        value=self.diagnostic(self.result(json.dumps({'status':'OWNED_P2_RECOVERY_PHASE','phase':'forward-source-scope'})+'\n',returncode=-9))
        self.assertEqual(value['signal'],'SIGKILL');self.assertEqual(value['exitStatus'],-9)
        self.assertEqual(value['phase'],'forward-source-scope');self.assertEqual(value['errorKind'],'unknown')

    def test_extra_phase_fields_refuse_and_frame_count_is_bounded(self):
        raw=json.dumps({'status':'OWNED_P2_RECOVERY_PHASE','phase':'forward-result','secret':'PRIVATE_SECRET'})+'\n'
        raw+='\n'.join(' at '+str(ROOT/'ops/platform/test-p2-recovery-owned.mjs')+':'+str(index+1)+':1'for index in range(100))
        encoded,value=self.emitted(self.result(raw));self.assertEqual(len(value['frames']),12);self.assertEqual(value['phase'],'unknown')
        self.assertLess(len(encoded.encode()),8192);self.assertNotIn('PRIVATE_SECRET',encoded)

    def test_child_environment_never_inherits_ambient_credentials(self):
        with patch.dict(os.environ,{'NODE_OPTIONS':'PRIVATE_LOADER','DATABASE_URL':'PRIVATE_DB','VERCEL_TOKEN':'PRIVATE_PROVIDER','PGPASSWORD':'PRIVATE_PASSWORD'},clear=False):
            value=NS['child_environment'](P2_RECOVERY_OWNED_TEST='true')
        self.assertFalse(set(value)&{'NODE_OPTIONS','DATABASE_URL','VERCEL_TOKEN','PGPASSWORD'});self.assertNotIn('PRIVATE_',json.dumps(value))

    def test_actual_source_guard_and_suppressed_http_cause_survive_without_private_text(self):
        import migrate
        allowed=NS['owned_bridge_guard_codes'](ROOT)
        self.assertIn('FRONTEND_WORKLOAD_VERIFICATION_FAILED',allowed)
        try:
            try:raise urllib.error.HTTPError('https://PRIVATE_HOST.invalid/PRIVATE_PATH',401,'PRIVATE_MESSAGE',{},None)
            except urllib.error.HTTPError as inner:
                inner.close()
                migrate.demand(False,'FRONTEND_WORKLOAD_VERIFICATION_FAILED')
        except ValueError as error:value=NS['owned_bridge_diagnostic'](error,allowed,ROOT)
        encoded=json.dumps(value)
        self.assertEqual(value['chain'][0]['guardCode'],'FRONTEND_WORKLOAD_VERIFICATION_FAILED')
        self.assertEqual(value['chain'][1]['httpStatus'],401)
        self.assertTrue(any(row['file']=='ops/platform/host/migrate.py' for row in value['frames']))
        for private in ('PRIVATE_HOST','PRIVATE_PATH','PRIVATE_MESSAGE','https://',str(ROOT)):
            self.assertNotIn(private,encoded)

    def test_unknown_uppercase_messages_and_unselected_source_frames_are_not_guard_codes(self):
        error=ValueError('PRIVATE_UPPERCASE_CANARY')
        value=NS['owned_bridge_diagnostic'](error,NS['owned_bridge_guard_codes'](ROOT),ROOT)
        self.assertEqual(value['chain'][0]['guardCode'],'unknown');self.assertEqual(value['frames'],[])
        self.assertNotIn('PRIVATE_',json.dumps(value))

    def test_bridge_record_reader_refuses_extra_keys_unknown_codes_booleans_and_symlinks(self):
        allowed=NS['owned_bridge_guard_codes'](ROOT)
        value=NS['owned_bridge_diagnostic'](ValueError('FRONTEND_WORKLOAD_VERIFICATION_FAILED'),allowed,ROOT)
        with tempfile.TemporaryDirectory(prefix='owned-recovery-diagnostic-') as path:
            directory=Path(path);file=directory/'123.json';file.write_text(json.dumps(value))
            self.assertEqual(NS['read_owned_bridge_diagnostics'](directory,allowed),[value])
            for changed in ({**value,'raw':'PRIVATE_RAW'}, {**value,'chain':[{**value['chain'][0],'guardCode':'PRIVATE_CODE'}]},
                    {**value,'chain':[{**value['chain'][0],'httpStatus':True}]}):
                file.write_text(json.dumps(changed));self.assertEqual(NS['read_owned_bridge_diagnostics'](directory,allowed),[])
            file.unlink();target=directory/'private';target.write_text(json.dumps(value));file.symlink_to(target)
            self.assertEqual(NS['read_owned_bridge_diagnostics'](directory,allowed),[])

    def test_actual_inner_source_failure_retains_phase_and_frame_without_canaries(self):
        node='/Users/dardan/.nvm/versions/node/v24.18.0/bin/node' if Path('/Users/dardan/.nvm/versions/node/v24.18.0/bin/node').exists() else 'node'
        private={'serverMajor':18,'frontend':'postgresql://canary-user:CANARY_PASSWORD@canary-private-host.invalid/never-connect','password':'CANARY_OTHER_SECRET'}
        environment=NS['child_environment'](P2_RECOVERY_OWNED_TEST='true',P2_RECOVERY_OWNED_CONNECTIONS=json.dumps(private))
        result=subprocess.run([node,str(ROOT/'ops/platform/test-p2-recovery-owned.mjs')],cwd=ROOT,env=environment,capture_output=True,text=True,timeout=20)
        self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'');self.assertIn('canary-private-host.invalid',result.stderr)
        encoded,value=self.emitted(result)
        self.assertEqual(value['phase'],'boot');self.assertEqual(value['errorKind'],'AssertionError');self.assertEqual(value['errorCode'],'ERR_ASSERTION')
        self.assertTrue(value['frames']);self.assertTrue(all(frame['file']=='ops/platform/test-p2-recovery-owned.mjs'for frame in value['frames']))
        for secret in ('CANARY_PASSWORD','CANARY_OTHER_SECRET','canary-private-host.invalid','postgresql://',str(ROOT)):self.assertNotIn(secret,encoded)


if __name__=='__main__':unittest.main()
