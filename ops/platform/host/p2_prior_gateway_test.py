"""Owned real gateway HTTPS/process checks; Docker identity transport is projected."""
import copy
import fcntl
import shutil
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.request
import p2_prior_gateway as gate
import migrate

NODE = '/Users/dardan/.nvm/versions/node/v24.18.0/bin/node' if Path('/Users/dardan/.nvm/versions/node/v24.18.0/bin/node').exists() else 'node'
PROGRAM = r'''
import {readFileSync} from 'node:fs';import {createServer,request} from 'node:https';import {createInterface}from'node:readline';
const {createGateway}=await import(process.argv[1]);const {createOperationsServer}=await import(process.argv[2]);
const file=process.argv[3],cfg=JSON.parse(readFileSync(file)),host=process.argv[4];let mode='ok',pending;
const upstream=createServer({key:readFileSync(host+'/key.pem'),cert:readFileSync(host+'/cert.pem')},(_req,res)=>{if(mode==='drop')res.destroy();else if(mode==='hold')pending=res;else res.end('{}');});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const live={...cfg,issuer:'https://oidc.vercel.com/test-team',audience:'https://vercel.com/test-team',subject:'owner:test-team:project:test-project:environment:production',ownerId:'team_test',environment:'production',publicHost:'localhost.localdomain',courseOrigin:'https://127.0.0.1:'+upstream.address().port,tlsKeyFile:host+'/key.pem',tlsCertFile:host+'/cert.pem',upstreamCaFile:host+'/cert.pem',admission:{...cfg.admission,file:host+'/admission/state.json'}};
const actual=createGateway(live,{verify:async()=>({})});await new Promise(r=>actual.server.listen(0,'127.0.0.1',r));
const ops=createOperationsServer(actual.counters,{},actual.admissionState);await new Promise(r=>ops.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({port:ops.address().port,pid:process.pid}));
const send=()=>new Promise(resolve=>{const r=request({hostname:'127.0.0.1',port:actual.server.address().port,path:'/course/v1/internal/accounts/commands',method:'POST',servername:'localhost.localdomain',ca:readFileSync(host+'/cert.pem'),headers:{host:'localhost.localdomain','x-lash-workload-token':'owned-proof',authorization:'Bearer owned.jwt'}},res=>{res.resume();res.on('end',()=>resolve());res.on('error',()=>resolve());});r.on('error',()=>resolve());r.end('{}');});
for await(const line of createInterface({input:process.stdin})){const command=JSON.parse(line);if(command.mode){mode=command.mode;if(mode==='hold'){void send();while(!pending)await new Promise(r=>setTimeout(r,1));}else await send();}if(command.release&&pending){pending.end('{}');pending=null;await new Promise(r=>setTimeout(r,5));}console.log(JSON.stringify(actual.admissionState()));}
'''

class PriorGatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='owned-prior-gateway-');self.root=Path(self.tmp.name).resolve();self.root.chmod(0o700)
        self.configuration=self.root/'configuration';self.configuration.mkdir(mode=0o700);(self.configuration/'admission').mkdir(mode=0o700)
        self.output=self.root/'p2-recovery-owned';self.output.mkdir(mode=0o700)
        self.image='ghcr.io/princessdardan/lash-her-platform-gateway@sha256:'+'3'*64
        self.selected={'environment':'staging','releaseId':'owned-selected','workload':{'projectId':'prj_test'},'artifacts':{'gateway':{'image':self.image}}}
        self.binding={'releaseId':'owned-selected','candidateSha256':'2'*64,'hostMachineId':'1'*32}
        for name,value in [('runtime.json',{'environment':'staging','releaseId':'owned-selected','hostMachineId':'1'*32}),('gateway.json',{'appEnv':'staging','projectId':'prj_test','admission':{'file':'/admission/state.json','releaseId':'owned-selected','candidateSha256':'2'*64}})]:
            (self.configuration/name).write_text(json.dumps(value));(self.configuration/name).chmod(0o600)
        self.initial={'candidateSha256':'2'*64,'hostMachineId':'1'*32,'recoveryActionId':'owned','configurationSha256':{name:migrate.file_hash((self.configuration/name).read_bytes())for name in ('runtime.json','gateway.json')}}
        self.save_open()
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:localhost.localdomain,IP:127.0.0.1','-keyout',str(self.configuration/'key.pem'),'-out',str(self.configuration/'cert.pem')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        source=Path(__file__).resolve().parents[2]/'gateway';self.child=subprocess.Popen([NODE,'--input-type=module','-e',PROGRAM,(source/'server.mjs').as_uri(),(source/'operations.mjs').as_uri(),str(self.configuration/'gateway.json'),str(self.configuration)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={key:os.environ[key]for key in ('PATH','HOME','LANG')if key in os.environ})
        line=self.child.stdout.readline()
        if not line:raise AssertionError(self.child.stderr.read())
        ready=json.loads(line);self.assertEqual(ready['pid'],self.child.pid);self.port=ready['port']
        self.identity='a'*64;self.started='2026-11-06T00:00:00.000000000Z';self.running=True;self.present=True;self.restart=0;self.bad_mount=False;self.commands=[];self.verifications=0
        self.patch=patch.object(gate,'ROOT',self.root);self.patch.start()
        self.descriptors=[]
    def tearDown(self):
        self.patch.stop()
        if self.child.poll()is None:self.child.terminate();self.child.wait(5)
        for stream in (self.child.stdin,self.child.stdout,self.child.stderr):stream.close()
        for descriptor in self.descriptors:os.close(descriptor)
        self.tmp.cleanup()
    def save_open(self):
        migrate_state={'version':1,'environment':'staging','releaseId':self.binding['releaseId'],'candidateSha256':self.binding['candidateSha256'],'actionId':'owned-open','newWork':True,'recovery':True}
        path=self.configuration/'admission/state.json';path.write_text(json.dumps(migrate_state));path.chmod(0o644)
    def verify(self):self.verifications+=1;self.assertTrue(self.child.poll() is None if self.running else self.child.poll() is not None)
    def control(self,value):self.child.stdin.write(json.dumps(value)+'\n');self.child.stdin.flush();return json.loads(self.child.stdout.readline())
    def command(self,args,_env,_timeout):
        self.commands.append(args)
        if args[1:3]==['container','ls']:return self.identity if self.present else ''
        if args[1:3]==['image','inspect']:return 'sha256:'+'3'*64
        if args[1]=='inspect' and args[3]==gate.PROCESS_FIELDS:return '|'.join(['sha256:'+'3'*64,str(self.running).lower(),str(self.child.pid if self.running else 0),self.started,str(self.restart),'lash-her-staging','gateway'])
        if args[1]=='inspect' and args[3]=='{{json .Mounts}}':return json.dumps([{'Destination':dest,'Source':str(source),'Type':'bind','RW':self.bad_mount}for dest,source in(('/config/gateway.json',self.configuration/'gateway.json'),('/admission',self.configuration/'admission'))])
        if args[1]=='inspect':return 'sha256:'+'3'*64+'|true|healthy|lash-her-staging|gateway'
        if args[1]=='exec':
            with urllib.request.urlopen('http://127.0.0.1:'+str(self.port)+'/admission')as result:return result.read().decode()
        raise AssertionError('unexpected Docker command')
    def observe(self):return gate.observe_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
    def prepare(self,clock=time):return gate.prepare_prior_gateway(self.initial,self.selected,self.output,self.verify,self.command,lambda _:None,clock)
    def test_actual_https_admission_is_closed_before_source_opaque_stage_authority(self):
        boundary=self.prepare();self.assertIs(type(boundary),gate.PriorGatewayBoundary)
        state=self.observe()['admission'];self.assertFalse(state['newWork']);self.assertFalse(state['recovery']);self.assertEqual(state['uncertain'],{'newWork':0,'recovery':0})
        boundary.before_stage(('community-api','course-api'))
        self.assertGreater(self.verifications,20)
        with self.assertRaisesRegex(ValueError,'SOURCE_AUTHORITY'):gate.PriorGatewayBoundary({},self.initial,self.selected,self.verify,self.command,lambda _:None,{})
    def test_actual_https_lost_ack_is_sticky_and_refuses_every_recreation(self):
        state=self.control({'mode':'drop'});self.assertEqual(state['active']['recovery'],0);self.assertEqual(state['uncertain']['recovery'],1)
        with self.assertRaisesRegex(ValueError,'UNCERTAIN'):self.prepare()
        retained=json.loads((self.output/'prior-gateway-boundary.json').read_text());self.assertEqual(retained['observation']['admission']['uncertain']['recovery'],1)
        self.assertFalse(any('up'in args or 'restart'in args for args in self.commands))
    def test_actual_inflight_request_drains_both_categories_before_authority(self):
        self.assertEqual(self.control({'mode':'hold'})['active']['recovery'],1)
        owner=self
        class Clock:
            def monotonic(self):return time.monotonic()
            def sleep(self,_seconds):owner.control({'release':True})
        boundary=self.prepare(Clock());self.assertEqual(boundary.observation['admission']['active'],{'newWork':0,'recovery':0})
    def test_process_mount_counter_and_missing_gateway_drift_never_mean_zero(self):
        self.bad_mount=True
        with self.assertRaisesRegex(ValueError,'READONLY_MOUNT'):self.observe()
        self.bad_mount=False;boundary=self.prepare();self.restart=1
        with self.assertRaisesRegex(ValueError,'BOUNDARY_CHANGED'):boundary.before_stage(('community-api','course-api'))
        self.restart=0;self.present=False
        with self.assertRaisesRegex(ValueError,'ABSENT_UNKNOWN'):self.observe()
    def test_source_ordered_stop_proof_preserves_zero_and_refuses_uncertain_or_missing(self):
        before=gate.capture_before_stop(self.initial,self.selected,self.output,self.verify,self.command,lambda _:None)
        self.child.terminate();self.child.wait(5);self.running=False
        stopped=gate.retain_ordered_stop(before,self.output,self.verify,self.command)
        self.assertEqual(stopped['status'],'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED')
        self.initial['priorGatewayReference']={'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),'stopReceiptSha256':migrate.file_hash((self.output/gate.STOPPED).read_bytes())}
        boundary=gate.prepare_prior_gateway(self.initial,self.selected,self.root,self.verify,self.command,lambda _:None)
        self.assertTrue(boundary.stopped);boundary.before_stage(('community-api','course-api'))
        self.initial['priorGatewayReference']['stopReceiptSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'RECEIPT_CHANGED'):gate.prepare_prior_gateway(self.initial,self.selected,self.configuration,self.verify,self.command,lambda _:None)
    def test_source_stop_receipt_cannot_turn_actual_uncertainty_into_zero(self):
        self.control({'mode':'drop'});before=gate.capture_before_stop(self.initial,self.selected,self.output,self.verify,self.command,lambda _:None)
        self.child.terminate();self.child.wait(5);self.running=False;gate.retain_ordered_stop(before,self.output,self.verify,self.command)
        self.initial['priorGatewayReference']={'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),'stopReceiptSha256':migrate.file_hash((self.output/gate.STOPPED).read_bytes())}
        observed=gate.observe_stopped_prior_gateway(self.initial,self.selected,self.verify,self.command)
        self.assertEqual(observed['admission']['uncertain']['recovery'],1)
        with self.assertRaisesRegex(ValueError,'STOP_PROOF'):gate.prepare_prior_gateway(self.initial,self.selected,self.root,self.verify,self.command,lambda _:None)


    def test_retained_original_p1_candidate_and_eight_service_receipt_qualify_only_actual_gateway(self):
        import release_test
        fixture=release_test.RuntimeReleaseTests();fixture.setUp()
        try:
            fixture.fixture.add_frontend()
            fixture.fixture.release['artifacts']['gateway']['image']=self.image
            fixture.fixture.save()
            bundle=self.root/'prior-bundle';shutil.copytree(fixture.bundle,bundle)
            for name in ('runtime.json','gateway.json','course-tls.json','community-tls.json'):
                shutil.copyfile(fixture.configuration/name,self.configuration/name)
            shutil.copyfile(fixture.compose,self.configuration/'compose.yaml')
            candidate_sha=migrate.file_hash((bundle/'release.candidate.json').read_bytes())
            gateway=json.loads((self.configuration/'gateway.json').read_bytes())
            gateway['admission']={'file':'/admission/state.json','releaseId':'test-release','candidateSha256':candidate_sha}
            (self.configuration/'gateway.json').write_text(json.dumps(gateway))
            self.binding.update(releaseId='test-release',candidateSha256=candidate_sha);self.save_open()
            args=list(self.child.args);self.child.terminate();self.child.wait(5)
            for stream in (self.child.stdin,self.child.stdout,self.child.stderr):stream.close()
            self.child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            self.port=json.loads(self.child.stdout.readline())['port'];self.restart=1
            receipt_directory=self.root/'prior-runtime';receipt_directory.mkdir(mode=0o700)
            services=('community-api','course-api','community-tls','course-tls','course-snapshot','community-worker','course-publisher','gateway')
            migrate.write_json(receipt_directory,'runtime-outcome.json',{'status':'API_RUNTIME_READY','phase':'completed','environment':'staging',
                'releaseId':'test-release','candidateSha256':candidate_sha,'containers':[{'service':name,'containerId':self.identity if name=='gateway' else format(index+1,'064x'),
                    'image':self.image if name=='gateway' else 'owned-prior-service'}for index,name in enumerate(services)]})
            self.initial['priorGatewayReference']={'kind':'retained-runtime','candidateDirectory':str(bundle),'configurationDirectory':str(self.configuration),
                'runtimeReceiptDirectory':str(receipt_directory),'candidateSha256':candidate_sha,
                'runtimeReceiptSha256':migrate.file_hash((receipt_directory/'runtime-outcome.json').read_bytes())}
            boundary=self.prepare();self.assertEqual(boundary.observation['binding']['releaseId'],'test-release')
            self.assertEqual(boundary.observation['binding']['candidateSha256'],candidate_sha)
            self.assertEqual(len(json.loads((receipt_directory/'runtime-outcome.json').read_bytes())['containers']),8)
            self.assertNotIn('contractPhase',fixture.fixture.release)
            del self.initial['priorGatewayReference']
            with self.assertRaisesRegex(ValueError,'RETAINED_REFERENCE_REQUIRED'):self.observe()
        finally:fixture.tearDown()

    def stop_proof(self):
        before=gate.capture_before_stop(self.initial,self.selected,self.output,self.verify,self.command,lambda _:None)
        self.child.terminate();self.child.wait(5);self.running=False
        gate.retain_ordered_stop(before,self.output,self.verify,self.command)
        self.initial['priorGatewayReference']={'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),
            'stopReceiptSha256':migrate.file_hash((self.output/gate.STOPPED).read_bytes())}
        return before

    def test_absent_gateway_requires_latest_exact_stop_pointer_and_pending_newer_refuses(self):
        before=self.stop_proof();self.present=False
        actual=gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        self.assertEqual(actual,before['observation'])
        pointer=(self.root/'.p2-gateway-lineage.json').read_bytes()
        (self.root/'.p2-gateway-lineage.json').unlink()
        with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        (self.root/'.p2-gateway-lineage.json').write_bytes(pointer);(self.root/'.p2-gateway-lineage.json').chmod(0o600)
        gate._remember(self.initial,before['observation'],'replacement-in-progress',expectedCandidateSha256='2'*64)
        with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        newer=copy.deepcopy(before['observation']);newer['process']['containerId']='b'*64
        gate._remember(self.initial,newer)
        with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        self.present=True
        with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)

    def test_present_stopped_gateway_rejects_same_process_pending_refused_or_running_lineage(self):
        before=self.stop_proof()
        stopped_pointer=json.loads((self.root/'.p2-gateway-lineage.json').read_bytes())
        self.assertTrue(self.present)
        self.assertEqual(gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None),before['observation'])
        for state in ('replacement-in-progress','preparation-refused','running-observed'):
            with self.subTest(state=state):
                extra={'expectedCandidateSha256':self.initial['candidateSha256']} if state=='replacement-in-progress' else {}
                gate._remember(self.initial,before['observation'],state,**extra)
                with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
                    gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        gate._write_lineage(stopped_pointer)
        self.assertEqual(gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None),before['observation'])
        for field,value in (('binding',{**stopped_pointer['binding'],'gatewayConfigurationSha256':'f'*64}),
                            ('stopReceiptDirectory',str(self.configuration)),('stopReceiptSha256','f'*64)):
            with self.subTest(field=field):
                gate._write_lineage({**stopped_pointer,field:value})
                with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
                    gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        gate._write_lineage(stopped_pointer)
        (self.root/'.p2-gateway-lineage.json').unlink()
        # Source-issued ordered stop always publishes a latest pointer. Its
        # deletion/loss stays unknown even with the stopped object present.
        with self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)

    def test_noop_gateway_stage_cannot_mark_old_process_as_completed_replacement(self):
        boundary=self.prepare()
        for stage in gate.runtime.STAGES[:-1]:
            boundary.before_stage(stage);boundary.after_stage(stage)
        boundary.before_stage(('gateway',))
        old=self.observe()
        with self.assertRaisesRegex(ValueError,'REPLACEMENT_NEW_CONTAINER'):
            boundary.after_stage(('gateway',))
        self.assertFalse(boundary.replacement_finished)
        self.assertEqual(boundary.stage_index,4)
        self.assertEqual(self.observe()['process'],old['process'])
        pointer=json.loads((self.root/'.p2-gateway-lineage.json').read_bytes())
        self.assertEqual(pointer['state'],'replacement-in-progress')
        self.assertEqual(pointer['process'],old['process'])

    def test_default_readonly_transport_does_not_reenter_the_mutation_scope(self):
        class MutationScope:
            def run(self,*_args,**_kwargs):raise AssertionError('readonly observation reentered mutation scope')
        token=gate.runtime._command_scope.set(MutationScope())
        try:
            with patch.object(gate,'_command',side_effect=self.command),patch.object(gate.runtime,'assert_host',side_effect=lambda _target:self.assertIsNone(gate.runtime._command_scope.get())):
                actual=gate.observe_prior_gateway(self.initial,self.selected,self.verify)
            self.assertTrue(actual['admission']['newWork'])
            self.assertIsInstance(gate.runtime._command_scope.get(),MutationScope)
        finally:gate.runtime._command_scope.reset(token)

    def test_readonly_preflight_keeps_eligible_admission_open_and_does_not_write_pointer(self):
        before=(self.configuration/'admission/state.json').read_bytes()
        actual=gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)
        self.assertTrue(actual['admission']['newWork']);self.assertTrue(actual['admission']['recovery'])
        self.assertEqual((self.configuration/'admission/state.json').read_bytes(),before)
        self.assertFalse((self.root/'.p2-gateway-lineage.json').exists())
        self.assertEqual(list(self.output.iterdir()),[])

    def test_observation_failure_retains_last_actual_counters_and_unknown_cannot_be_stop_zero(self):
        self.control({'mode':'drop'});last=self.observe();calls=0
        def changed(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls>1:raise ValueError('OWNED_ACK_READ_LOST')
            return last
        with patch.object(gate,'observe_prior_gateway',side_effect=changed):
            before=gate.capture_before_stop(self.initial,self.selected,self.output,self.verify,self.command,lambda _:None)
        self.assertEqual(before['status'],'PRIOR_GATEWAY_PRESTOP_UNKNOWN')
        self.assertEqual(before['observation']['admission']['uncertain']['recovery'],1)
        self.child.terminate();self.child.wait(5);self.running=False
        gate.retain_ordered_stop(before,self.output,self.verify,self.command)
        self.initial['priorGatewayReference']={'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),
            'stopReceiptSha256':migrate.file_hash((self.output/gate.STOPPED).read_bytes())}
        with self.assertRaisesRegex(ValueError,'STOP_PROOF'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)


    def test_unknown_operations_counters_keep_actual_process_and_cannot_be_retired(self):
        original=self.command
        def unavailable(args,*rest):
            if args[1]=='exec':raise ValueError('OWNED_OPERATIONS_UNAVAILABLE')
            return original(args,*rest)
        before=gate.capture_before_stop(self.initial,self.selected,self.output,self.verify,unavailable,lambda _:None)
        self.assertEqual(before['status'],'PRIOR_GATEWAY_PRESTOP_UNKNOWN')
        self.assertEqual(before['observation']['process']['pid'],self.child.pid)
        self.assertEqual(before['observation']['binding']['configurationDirectory'],str(self.configuration))
        self.assertIsNone(before['observation']['admission'])
        self.assertFalse(gate._zero(before['observation']))


    def guard_containment(self):
        import p2_release_supervisor as supervisor
        calls=[]
        class Observer:
            def __init__(self,*_args,**_kwargs):pass
            def probe(self,operation):calls.append('frontend-'+operation)
        def stop(*_args):
            # The actual old gateway was observed/closed before any process stop.
            retained=json.loads((self.output/gate.BEFORE_STOP).read_bytes())
            self.assertEqual(retained['observation']['process']['pid'],self.child.pid)
            calls.append('runtime-stop');self.child.terminate();self.child.wait(5);self.running=False
        initial={**self.initial,'candidate':self.selected,'results':str(self.root),
            'credentials':{'FRONTEND_STAGING_MIGRATION_DATABASE_URL':'synthetic-owned-only'},
            'sourceSha256':{'ops/platform/p2-recovery-current-probe.mjs':'f'*64},
            '_guardLayout':supervisor.RECOVERY_LAYOUT,'_guardObserverSource':'ops/platform/p2-recovery-current-probe.mjs'}
        with patch.object(supervisor,'verify_guard_boundary',side_effect=lambda *_:self.verify()),patch.object(supervisor,'private_observer_program',return_value=self.root/'owned-program'),patch.object(supervisor,'PhysicalObserver',Observer),patch.object(supervisor.runtime,'command',return_value=''),patch.object(gate,'_command',side_effect=self.command),patch.object(supervisor.runtime,'assert_host'),patch.object(supervisor.migrate,'suspend_runtime',side_effect=stop),patch.object(supervisor,'cleanup_recovery_current_containers'):
            result=supervisor.fail_closed(initial,{'owned':True},self.root)
        self.assertEqual(calls,['frontend-fence','runtime-stop'])
        self.assertTrue(result['runtimeStopped']);self.assertTrue(result['gatewayAdmissionAcknowledged'])
        self.assertEqual(result['priorGatewayStopReceiptDirectory'],str(self.output))
        self.assertEqual(result['priorGatewayStopReceiptSha256'],migrate.file_hash((self.output/gate.STOPPED).read_bytes()))
        self.initial['priorGatewayReference']={'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),
            'stopReceiptSha256':result['priorGatewayStopReceiptSha256']}
        return result

    def test_independent_guard_uses_actual_mounted_gateway_and_preserves_zero_stop_chain(self):
        result=self.guard_containment()
        self.assertEqual(result['priorGatewayBeforeStop']['observation']['binding']['configurationDirectory'],str(self.configuration))
        self.assertFalse((self.root/'runtime-recovery-owned/configuration').exists())
        self.assertEqual(gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)['admission']['uncertain'],{'newWork':0,'recovery':0})

    def test_independent_guard_retains_actual_sticky_uncertainty_across_real_stop(self):
        self.control({'mode':'drop'});result=self.guard_containment()
        self.assertEqual(result['priorGatewayBeforeStop']['observation']['admission']['uncertain']['recovery'],1)
        self.assertEqual(result['priorGatewayOrderedStop']['status'],'PRIOR_GATEWAY_ORDERED_STOP_OBSERVED')
        with self.assertRaisesRegex(ValueError,'STOP_PROOF'):
            gate.preflight_prior_gateway(self.initial,self.selected,self.verify,self.command,lambda _:None)

    def recovery_scope(self):
        from p2_recovery_scope import P2RecoveryScope
        self.selected.update(contractPhase='p2',phase2ContractManifestSha256='sha256:'+'e'*64)
        fields={'environment':'staging','releaseId':self.selected['releaseId'],'sourceCommit':'a'*40,'migrationImageDigest':'sha256:'+'d'*64,
            'sqlArtifactSha256':'c'*64,'schemaBaselineSha256':'b'*64,'contractManifestSha256':'f'*64,
            'contractPhase':'p2','phase2ContractManifestSha256':'sha256:'+'e'*64}
        target={'host':'owned.invalid','port':5432,'database':'owned','user':'owned_owner','serverMajor':16}
        jobs={'frontend':{'job':{**fields,'target':target}},'course':{},'community':{}}
        receipt={**fields,'target':target,'status':'P2_RECOVERY_DATABASE_CURRENT','service':'frontend','migrationMode':'recovery-current-only',
            'candidateSha256':self.initial['candidateSha256'],'recoveryActionId':'owned','oldLoginsDenied':True,'oldRoleSessions':0,
            'sqlReplayed':False,'originalFrontendTerminalRecreated':False,'trafficAuthorized':False,'after':[{'owned':True}],
            'schemaVerified':True,'runtimeRoleVerified':True,'originalReceiptSha256':{'job-outcome.json':None}}
        lock=self.root/'actual-environment.lock';descriptor=os.open(lock,os.O_RDWR|os.O_CREAT,0o600);self.descriptors.append(descriptor)
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return P2RecoveryScope(descriptor,lock,self.verify,receipt,self.initial['candidateSha256'],recovery_action_id='owned',
            release=self.selected,jobs=jobs,configuration_sha256=None)

    def test_uncertain_prior_gateway_blocks_real_runtime_before_api_probes_snapshots_or_up(self):
        from p2_recovery_runtime import P2RecoveryRuntime
        scope=self.recovery_scope();self.control({'mode':'drop'})
        component=P2RecoveryRuntime(scope,self.selected,scope.jobs,self.configuration,self.output,self.root/'compose.yaml',self.root)
        with patch.object(component,'verify_api_current') as api,patch.object(gate.runtime,'snapshot_configuration') as snapshot,patch.object(component,'command') as mutate:
            with self.assertRaisesRegex(ValueError,'UNCERTAIN'):scope.bind_prior_gateway(self.prepare())
            with self.assertRaisesRegex(ValueError,'NOT_PREPARED'):component.restore()
            api.assert_not_called();snapshot.assert_not_called();mutate.assert_not_called()
        self.assertEqual(self.observe()['admission']['uncertain']['recovery'],1)
        self.assertFalse(any('up'in item or 'run'in item for item in self.commands))

    def test_real_runtime_stages_hold_actual_prior_zero_until_gateway_last_and_new_process(self):
        from p2_recovery_runtime import P2RecoveryRuntime
        compose=self.root/'compose.yaml';compose.write_text('owned-compose')
        self.selected['runtime']={'composeSha256':'sha256:'+migrate.file_hash(compose.read_bytes())}
        for key in ('courseRuntime','courseMigration','communityRuntime','communityMigration'):
            self.selected['artifacts'][key]={'image':'ghcr.io/owned/'+key+'@sha256:'+'f'*64}
        scope=self.recovery_scope();boundary=self.prepare();scope.bind_prior_gateway(boundary)
        output=self.root/'runtime-output';output.mkdir(mode=0o700)
        component=P2RecoveryRuntime(scope,self.selected,scope.jobs,self.configuration,output,compose,self.root)
        stages=[];prior_pid=self.child.pid
        def snapshot(_source,destination,*_args):shutil.copytree(self.configuration,destination)
        def execute(args,*_args,**_kwargs):
            if 'up'in args:
                stage=tuple(args[args.index('90')+1:]);stages.append(stage)
                if stage==('gateway',):
                    self.child.terminate();self.child.wait(5)
                    original=list(self.child.args);new_configuration=component.snapshot
                    for stream in (self.child.stdin,self.child.stdout,self.child.stderr):stream.close()
                    original[-2:]=[str(new_configuration/'gateway.json'),str(new_configuration)]
                    self.child=subprocess.Popen(original,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                    ready=json.loads(self.child.stdout.readline());self.port=ready['port'];self.configuration=new_configuration
                    self.identity='b'*64;self.started='2026-11-06T01:00:00.000000000Z'
                else:self.assertEqual(self.observe()['admission']['uncertain'],{'newWork':0,'recovery':0})
            if 'release-probe.mjs'in args:return json.dumps({'status':'API_RUNTIME_BOUNDARIES_PASS','checks':sorted(gate.runtime.PROBE_CHECKS)})
            return ''
        containers=[{'service':name}for name in gate.runtime.SERVICES]
        with patch.object(component,'verify_api_current',return_value={'status':'owned-current-API-proof-fixture'}),patch.object(gate.runtime,'snapshot_configuration',side_effect=snapshot),patch.object(gate.runtime,'preflight'),patch.object(component,'command',side_effect=execute),patch.object(gate.runtime,'check_containers',return_value=containers):
            outcome=component.restore()
        self.assertEqual(stages,gate.runtime.STAGES);self.assertNotEqual(self.child.pid,prior_pid)
        self.assertEqual(boundary.current['process']['pid'],self.child.pid);self.assertEqual(boundary.stage_index,5)
        self.assertEqual(outcome['status'],'P2_RECOVERY_API_RUNTIME_READY')
        self.assertFalse(outcome['sqlReplayed']);self.assertFalse(outcome['rolePreparationRepeated'])
        # The old boundary proof cannot silently follow another restart.
        self.restart=1
        with self.assertRaisesRegex(ValueError,'REPLACED_PROCESS_CHANGED'):scope.verify()

if __name__=='__main__':unittest.main()
