"""C source/receipt and single-use regressions. No cloud/provider requests."""
import base64
import copy
import json
import os
from pathlib import Path
import select
import subprocess
import threading
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import p2_known_ack_interrupted_restoration as c
import p2_known_ack_loss_test as b
import release_test
from p2_source_closure import REQUIRED, PROFILED_CURRENT_REQUIRED, PROFILED_CERTIFICATION_REQUIRED
import p2_profiled_known_ack_restoration_parent as profiled_c


class ProfiledInterruptedBrokerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.sent, self.safety = [], []
        self.broker = profiled_c.P2ProfiledInterruptedKnownAckBroker(
            {'restorationActionId': 'restore-owned', 'candidateSha256': 'a' * 64}, self.sent.append,
        )
        self.broker.directory = Path(temp.name)
        self.broker.authority = None
        self.broker.runtime_attempted = False
        self.broker.prepared_terminal = None
        self.broker.ready = {'status': 'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED',
                             'candidateSha256': 'a' * 64}
        self.broker.safety = self.safety.append
        for method in ('check', 'verify_original', 'require_native_off', 'verify_prepared'):
            item = patch.object(self.broker, method)
            item.start()
            self.addCleanup(item.stop)

    def test_sends_guard_health_and_aborts_when_controller_stops(self):
        read, write = os.pipe()
        self.addCleanup(os.close, write)
        self.addCleanup(os.close, read)
        broker = profiled_c.P2ProfiledInterruptedKnownAckBroker(
            {'restorationActionId': 'restore-owned'}, self.sent.append, safety_write=write,
        )
        broker.guard_alive = True
        broker.start_parent_watch()
        self.addCleanup(broker.parent_watch.join, 2)
        self.addCleanup(broker.committed.set)
        self.assertTrue(select.select([read], [], [], 4)[0])
        self.assertEqual(json.loads(os.read(read, 4096)), {'operation': 'alive'})
        broker.last_command = time.monotonic() - 46
        self.assertTrue(broker.failed.wait(4))
        broker.parent_watch.join(2)
        self.assertEqual([json.loads(line) for line in os.read(read, 4096).splitlines()],
                         [{'operation': 'alive'}, {'operation': 'abort'}])

    def test_restoration_authority_is_exact_one_use_and_poisoned_before_verification(self):
        broker = self.broker
        broker.retained = {'frontier': 'original-stopped-one', 'selection': {
            'priorGatewayReference': {'stopReceiptSha256': 'b' * 64},
            'causalReceiptSha256': {'settlement.json': 'c' * 64},
        }}
        first = broker.prepare()
        self.assertEqual(first['status'], 'P2_PROFILED_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED')
        authority = broker.authority
        broker.runtime_attempted = True
        with self.assertRaisesRegex(ValueError, 'ONE_USE_AUTHORITY'):
            profiled_c.consume_profiled_interrupted_runtime_authority(authority.record, broker)
        broker.verify_prepared.side_effect = ValueError('fresh scope changed')
        with self.assertRaisesRegex(ValueError, 'fresh scope changed'):
            profiled_c.consume_profiled_interrupted_runtime_authority(authority, broker)
        with self.assertRaisesRegex(ValueError, 'ONE_USE_AUTHORITY'):
            profiled_c.consume_profiled_interrupted_runtime_authority(authority, broker)

    def test_commit_follows_independent_closed_database_observation_and_matching_join(self):
        from p2_profiled_known_ack_runtime import OUTCOME
        broker = self.broker
        broker.runtime_transition = Mock()
        broker.observer = Mock()
        output = broker.directory / 'runtime-interrupted'
        output.mkdir()
        profiled_c.migrate.write_json(output, OUTCOME, broker.ready)
        observed = {'status': 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED'}
        broker.observer.probe.return_value = observed
        broker.command({'id': 1, 'operation': 'prepare-close'})
        broker.observer.stop.assert_called_once_with()
        self.assertEqual(self.sent[-1]['status'], 'INTERRUPTED_CLOSE_PREPARED')
        broker.command({'id': 2, 'operation': 'check'})
        self.assertEqual(self.sent[-1], {'id': 2, 'status': 'HELD'})
        with self.assertRaisesRegex(ValueError, 'JOIN_REQUIRED'):
            broker.command({'id': 3, 'operation': 'commit'})
        with self.assertRaisesRegex(ValueError, 'PREPARED_TERMINAL'):
            broker.command({'id': 4, 'operation': 'finish', 'restoration': 'e30='})
        broker.observer.probe.assert_not_called()
        encoded = base64.b64encode(json.dumps(broker.ready).encode()).decode()
        request = {'id': 5, 'operation': 'finish', 'restoration': encoded}
        broker.observer.probe.side_effect = ValueError('frontend lease remains')
        with self.assertRaisesRegex(ValueError, 'frontend lease remains'):
            broker.command(request)
        self.assertFalse((broker.directory / profiled_c.SESSION_CLOSED).exists())
        self.assertFalse((broker.directory / profiled_c.TERMINAL).exists())
        broker.observer.probe.side_effect = None
        broker.command(request)
        self.assertEqual(self.sent[-1]['receipt'], broker.ready)
        self.assertEqual(json.loads((broker.directory / profiled_c.SESSION_CLOSED).read_bytes()), observed)
        broker.command({'id': 6, 'operation': 'commit'})
        raw = (broker.directory / profiled_c.TERMINAL).read_bytes()
        self.assertEqual(self.safety, [{'operation': 'committed', 'sha256': profiled_c._sha(raw)}])
        self.assertEqual(json.loads(raw), self.sent[-1]['receipt'])
        self.assertTrue(broker.committed.is_set())


def selection():
    return {'version':1,'mode':c.MODE,'restorationActionId':'restore-new','originalCertificationActionId':'cert-old','originalRecoveryActionId':'replace-old',
      'originalOperatorSourceCommit':'b'*40,'causalReceiptSha256':dict.fromkeys(c.CAUSAL_FILES,'a'*64),
      'replacementReceiptSha256':{name:'a'*64 if name=='known-ack-replacement-intent.json' else None for name in c.REPLACEMENT_FILES},
      'priorGatewayReference':{'kind':'stopped-current-candidate','stopReceiptDirectory':'/var/lib/lash-her/releases/staging/p2-certification-replace-old','stopReceiptSha256':'a'*64}}


class OriginalSourceBoundsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.operators = Path(self.temp.name).resolve() / 'operators'
        self.commit = 'b' * 40
        self.source = self.operators / self.commit
        self.source.mkdir(parents=True)
        self.manifest = {}
        for name in sorted(REQUIRED):
            self.write(name, b'owned source')
        patcher = patch.object(c, 'OPERATORS', self.operators)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, name, raw):
        target = self.source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        self.manifest[name] = c.sha(raw)

    def observe(self):
        return c.original_source(self.commit, c.sha(c.canonical(sorted(self.manifest.items()))))

    def test_actual_original_source_accepts_512_and_refuses_513_and_wrong_digest(self):
        while len(self.manifest) < 512:
            self.write(f'ops/platform/owned-count-{len(self.manifest)}.mjs', b'owned source')
        source, manifest = self.observe()
        self.assertEqual(source, self.source)
        self.assertEqual(len(manifest), 512)
        self.assertEqual(manifest, self.manifest)
        with self.assertRaisesRegex(ValueError, 'SOURCE_CLOSURE_DIGEST_REQUIRED'):
            c.original_source(self.commit, '0' * 64)
        self.write('ops/platform/owned-overflow.mjs', b'owned source')
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_SOURCE_BOUNDS'):
            self.observe()

    def test_actual_original_source_retains_two_mb_per_file_bound(self):
        self.write('ops/platform/owned-size.mjs', b'x' * 2_000_000)
        self.observe()
        self.write('ops/platform/owned-size.mjs', b'x' * 2_000_001)
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_SOURCE_PERMISSIONS'):
            self.observe()

    def test_actual_original_source_retains_41mb_decoded_bound(self):
        remaining = 41_000_000 - sum((self.source / name).stat().st_size for name in self.manifest)
        index = 0
        while remaining:
            name = f'ops/platform/owned-bytes-{index}.mjs'
            size = min(remaining, 2_000_000)
            self.write(name, b'x' * size)
            remaining -= size
            index += 1
        self.observe()
        self.write(name, (self.source / name).read_bytes() + b'x')
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_SOURCE_BOUNDS'):
            self.observe()


class RetainedChainTests(unittest.TestCase):
    def setUp(self):
        f=release_test.RuntimeReleaseTests()
        with patch.object(tempfile,'tempdir',str(Path(tempfile.gettempdir()).resolve())):f.setUp()
        self.addCleanup(f.tearDown);self.root=f.root;self.f=f
        operators=self.root/'operators';operators.mkdir();self.old_source=operators/('b'*40);self.old_source.mkdir()
        manifest={};actual=Path(__file__).resolve().parents[3]
        # Gateway frontier eligibility is tied to the actual approved original
        # helper. A newer current helper must never inherit that source pin.
        original_frontier=subprocess.run(['git','-c','safe.directory='+str(actual),'-C',str(actual),'show',
            '91d44bd24d2df64901f7cb3f243580834707eb98:'+c.B_FRONTIER_MODULE],
            check=True,capture_output=True,timeout=10).stdout
        self.assertEqual(c.sha(original_frontier),c.B_FRONTIER_SHA256)
        for name in sorted(REQUIRED|{c.known.MODULE,c.B_FRONTIER_MODULE}):
            raw=original_frontier if name==c.B_FRONTIER_MODULE else (actual/name).read_bytes()
            target=self.old_source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw);target.chmod(0o444);manifest[name]=c.sha(raw)
        closure=c.sha(c.canonical(sorted(manifest.items())))
        self.causal=self.root/'p2-known-ack-loss-cert-old';self.causal.mkdir(mode=0o700)
        self.replacement=self.root/'p2-certification-replace-old';self.replacement.mkdir(mode=0o700)
        self.original=self.root/'p2-certification-cert-old';self.original.mkdir(mode=0o700)
        self.selected={**f.fixture.release,'environment':'staging','contractPhase':'p2','sources':{'frontend':{'commit':'b'*40}}}
        self.jobs=c.migrate.make_plan(f.bundle)[1]
        plan,baseline,domain,gateway,effects=b.fixture();plan.update(candidateSha256='a'*64,sourceCommit='b'*40,operatorSourceCommit='b'*40,targetSha256='c'*64)
        config=c.staging_state.configuration_hashes(f.configuration);plan['configurationSha256']=c.sha(c.canonical(config))
        targets={name:{**{key:info['job']['target'][key] for key in ('host','port','database')},'serverMajor':16,'user':name+'_runtime','roleOid':'1'} for name,info in self.jobs.items() if name in ('course','community')}
        plan['nativePlan'].update(version=1,windowSeconds=180,projectId='prj_owned',deploymentId='dpl_owned',planSha256='d'*64,targetSha256='c'*64)
        process={'containerId':'1'*64,'imageId':'sha256:'+'2'*64,'pid':19,'running':True,'startedAt':'owned-start','restartCount':0}
        plan.update(version=1,environment='staging',maxMatches=1,leaseMilliseconds=120000,mode='drop-after-ack',nativePlanSha256='d'*64,stageId='owned-stage',profile='lifecycle-known-command-v1',gatewayProcessSha256=c.sha(c.canonical(process)))
        effects[0].update(version=1,status='P2_TRANSPORT_FAULT_INJECTED',environment='staging',profile=plan['profile'],stageId=plan['stageId'],
          candidateSha256='a'*64,configurationSha256=plan['configurationSha256'],gatewayProcessSha256=plan['gatewayProcessSha256'],gatewayImageSha256=self.selected['artifacts']['gateway']['image'].split(':')[-1])
        plan.update(gatewayConfigurationSha256=config['gateway.json'],gatewayImageSha256=self.selected['artifacts']['gateway']['image'].split(':')[-1])
        command=plan['nativePlan']['commandWitnesses'][0]
        lease={'version':1,'environment':'staging','profile':plan['profile'],'stageId':plan['stageId'],'candidateSha256':'a'*64,
          'configurationSha256':plan['configurationSha256'],'gatewayConfigurationSha256':plan['gatewayConfigurationSha256'],
          'gatewayProcessSha256':plan['gatewayProcessSha256'],'gatewayImageSha256':plan['gatewayImageSha256'],'mode':'drop-after-ack','receiver':plan['receiver'],
          'releaseId':self.selected['releaseId'],'sourceWitnessSha256':plan['commandSha256'],'issuedAt':'2026-11-06T01:00:00.000Z','expiresAt':'2026-11-06T01:02:00.000Z','maxMatches':1,
          'record':{'commandId':command['commandId'],'accountVersion':int(command['accountVersion']),'canonicalSha256':plan['commandSha256']}}
        effects[0]['leaseSha256']=c.sha(c.canonical(lease)+b'\n');fault=self.original/'fault';fault.mkdir(mode=0o700)
        (fault/'fault-arm-intent.json').write_bytes(c.canonical({'version':1,'stageId':plan['stageId'],'leaseSha256':effects[0]['leaseSha256'],'lease':lease})+b'\n')
        (fault/'fault-arm-observed.json').write_bytes(c.canonical({'version':1,'status':'P2_FAULT_LEASE_ARMED','stageId':plan['stageId'],'leaseSha256':effects[0]['leaseSha256'],
          'expiresAt':lease['expiresAt'],'maxMatches':1,'gatewayProcessSha256':plan['gatewayProcessSha256']})+b'\n')
        original_processes={name:{**process,'containerId':format(index+2,'064x'),'pid':20+index} for index,name in enumerate(c.runtime.SERVICES)}
        original_processes['gateway']=process
        ready=[{'service':name,'containerId':original_processes[name]['containerId'],'image':self.selected['artifacts'][c.runtime.IMAGE_KEYS[name]]['image'],
          'health':'none' if name.endswith('-tls') else 'healthy'} for name in c.runtime.SERVICES]
        (self.original/'p2-certification-current-ready.json').write_bytes(c.canonical({'status':'P2_CERTIFICATION_CURRENT_READY','apiDatabases':{},'containers':ready,'sqlReplayed':False,'runtimeReplaced':False})+b'\n')
        gateway.update(status='PRIOR_GATEWAY_OBSERVED',process=process,binding={'candidateSha256':'a'*64,'configurationDirectory':str(f.configuration)})
        initial_gateway=copy.deepcopy(gateway);initial_gateway['admission']['uncertain']['recovery']=0
        closed_gateway=copy.deepcopy(gateway);closed_gateway['admission']['recovery']=False;self.gateway=closed_gateway
        before=copy.deepcopy(domain);before['frontend']['admission'].update(epoch='4',recovery=False);self.before=before
        cert={**plan,'configurationSha256':c.sha(json.dumps(config,separators=(',',':')).encode()),'certificationActionId':'cert-old',
          'gatewayProcessSha256':plan['gatewayProcessSha256'],'runtimeInventorySha256':c.sha(c.canonical(ready)),'operatorSourceClosureSha256':closure,
          'knownAckConfigurationInputDirectory':str(f.configuration),'knownAckReceiverTargets':targets}
        intent={'version':1,'recoveryActionId':'replace-old','intent':c.known.replacement_intent(cert,'replace-old')}
        intent['intentSha256']=c.sha(c.canonical(intent['intent']))
        values={'recovery-intent.json':intent,'baseline.json':{'status':'P2_KNOWN_ACK_BASELINE_RETAINED','candidateSha256':'a'*64,'recoveryActionId':'replace-old',
          'sourceModuleSha256':manifest[c.known.MODULE],'plan':plan,'gateway':initial_gateway,'databases':baseline},
          'domain.json':{'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','operationId':domain['frontend']['operations'][0]['id'],'gateway':gateway,'databases':domain,'effect':effects[0]}}
        artifact={'version':1,'kind':'operator-recorded-request-details','reviewerGithubUserId':'8996309','certificationActionId':'cert-old','nativePlanSha256':'d'*64,
          'windowEpoch':'3','recordedAt':'2026-11-06T01:00:05.000Z','observations':[]}
        for i,row in enumerate(domain['frontend']['operations']):
            event={'version':1,'status':'P2_LIFECYCLE_CRON_ADMITTED','environment':'staging','projectId':'prj_owned','operationId':row['id'],'producerSha256':'c'*64,
              'sourceCommit':'b'*40,'epoch':'3','kind':'recovery','targetSha256':'c'*64}
            artifact['observations'].append({'version':1,'kind':'vercel-native-request-details','reviewerGithubUserId':'8996309','projectId':'prj_owned','deploymentId':'dpl_owned',
              'path':c.native.PATH,'method':'GET','providerRequestTypeFilter':'cron','providerRequestId':'owned-'+str(i),'startedAt':'2026-11-06T01:00:00.000Z',
              'completedAt':'2026-11-06T01:00:04.000Z','httpStatus':503 if row['state']=='uncertain' else 200,'logScope':'this-provider-request-details','admittedLogLine':json.dumps(event)})
        raw=c.canonical(artifact)+b'\n';(self.original/'p2-certification-operator-request-details.json').write_bytes(raw)
        values['request-details.json']={'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','artifactSha256':c.sha(raw),'originalArtifact':artifact,
          'domainSha256':self.write('domain.json',values['domain.json']),'provenance':{'qualified':False,'authority':'operator-recorded-request-details','artifactSha256':c.sha(raw),'requestCount':2,'automaticProviderEvidence':False}}
        pins={name:self.write(name,values[name]) for name in c.CAUSAL_FILES[:4]}
        values['settlement.json']={'status':'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT','recoveryActionId':'replace-old','domainSha256':pins['domain.json'],
          'baselineSha256':pins['baseline.json'],'requestDetailsSha256':pins['request-details.json'],'operationId':domain['frontend']['operations'][0]['id'],'epoch':'4','gateway':closed_gateway,'databases':before}
        pins['settlement.json']=self.write('settlement.json',values['settlement.json'])
        values['replacement-authorization.json']={'version':1,'ordinaryClosedZeroGate':False,'sqlReplayAllowed':False,'roleChangeAllowed':False,'status':'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED','candidateSha256':'a'*64,'certificationActionId':'cert-old','recoveryActionId':'replace-old',
          'recoveryIntentSha256':intent['intentSha256'],'operatorSourceClosureSha256':closure,'baselineSha256':pins['baseline.json'],'domainSha256':pins['domain.json'],
          'requestDetailsSha256':pins['request-details.json'],'settlementSha256':pins['settlement.json'],'originalGateway':initial_gateway,
          'operationId':domain['frontend']['operations'][0]['id'],'sourceModuleSha256':manifest[c.known.MODULE]}
        pins['replacement-authorization.json']=self.write('replacement-authorization.json',values['replacement-authorization.json'])
        self.values=values;self.selection=selection();self.selection['causalReceiptSha256']=pins
        intent={'status':'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT','authorization':values['replacement-authorization.json'],'recoveryIntent':intent,
          'stages':[list(s) for s in c.runtime.STAGES],'unavailableStages':[list(s) for s in c.known.UNAVAILABLE_STAGES],'oldProcesses':original_processes}
        raw=c.canonical(intent)+b'\n';(self.replacement/'known-ack-replacement-intent.json').write_bytes(raw)
        self.selection['replacementReceiptSha256']['known-ack-replacement-intent.json']=c.sha(raw);self.selection['priorGatewayReference']['stopReceiptDirectory']=str(self.replacement)
        self.initial={'candidateSha256':'a'*64,'targetSha256':'c'*64,'configuration':str(f.configuration),'configurationSha256':config,'receiverTargets':targets,'interruptedRestoration':self.selection}
        for item in (patch.object(c,'ROOT',self.root),patch.object(c,'OPERATORS',operators),patch.object(c.prior,'observe_stopped_prior_gateway',return_value=self.gateway)):
            item.start();self.addCleanup(item.stop)

    def write(self,name,value):
        raw=c.canonical(value)+b'\n';(self.causal/name).write_bytes(raw);return c.sha(raw)

    def load(self):return c.load_retained(self.initial,self.selected,self.jobs,lambda:None)

    def repin_chain(self):
        values=self.values;pins=self.selection['causalReceiptSha256']
        values['recovery-intent.json']['intentSha256']=c.sha(c.canonical(values['recovery-intent.json']['intent']))
        for name in ('recovery-intent.json','baseline.json','domain.json'):pins[name]=self.write(name,values[name])
        values['request-details.json']['domainSha256']=pins['domain.json'];pins['request-details.json']=self.write('request-details.json',values['request-details.json'])
        for name,key in (('baseline.json','baselineSha256'),('domain.json','domainSha256'),('request-details.json','requestDetailsSha256')):values['settlement.json'][key]=pins[name]
        pins['settlement.json']=self.write('settlement.json',values['settlement.json'])
        auth=values['replacement-authorization.json'];auth['recoveryIntentSha256']=values['recovery-intent.json']['intentSha256']
        for name,key in (('baseline.json','baselineSha256'),('domain.json','domainSha256'),('request-details.json','requestDetailsSha256'),('settlement.json','settlementSha256')):auth[key]=pins[name]
        pins['replacement-authorization.json']=self.write('replacement-authorization.json',auth)
        path=self.replacement/'known-ack-replacement-intent.json';replacement=json.loads(path.read_bytes());replacement.update(authorization=auth,recoveryIntent=values['recovery-intent.json'])
        raw=c.canonical(replacement)+b'\n';path.write_bytes(raw);self.selection['replacementReceiptSha256'][path.name]=c.sha(raw)
        c.read_pinned(self.causal,pins);c.read_pinned(self.replacement,self.selection['replacementReceiptSha256'])

    def test_all_original_B_predicates_reject_otherwise_valid_repinned_chains(self):
        original=copy.deepcopy(self.values);original_selection=copy.deepcopy(self.selection)
        cases=('fault-mode','command-action','extra-command','native-plan-sha','inner-version','inner-boolean-version','gateway-process-sha','consistent-process-sha','runtime-inventory-sha','receiver-targets-sha','canonical-config-sha','boolean-backend-count','boolean-gateway-count')
        for kind in cases:
            self.values=copy.deepcopy(original);self.selection=copy.deepcopy(original_selection);self.initial['interruptedRestoration']=self.selection
            plan=self.values['baseline.json']['plan'];intent=self.values['recovery-intent.json']['intent']
            if kind=='fault-mode':plan['mode']='503-before-upstream'
            elif kind=='command-action':plan['nativePlan']['commandWitnesses'][0]['action']='restore'
            elif kind=='extra-command':plan['nativePlan']['commandWitnesses'].append(copy.deepcopy(plan['nativePlan']['commandWitnesses'][0]))
            elif kind=='native-plan-sha':plan['nativePlanSha256']='f'*64
            elif kind=='inner-version':intent['version']=2
            elif kind=='inner-boolean-version':intent['version']=True
            elif kind=='gateway-process-sha':intent['gatewayProcessSha256']='f'*64
            elif kind=='consistent-process-sha':intent['gatewayProcessSha256']=plan['gatewayProcessSha256']=self.values['domain.json']['effect']['gatewayProcessSha256']='f'*64
            elif kind=='runtime-inventory-sha':intent['runtimeInventorySha256']='f'*64
            elif kind=='receiver-targets-sha':intent['receiverTargetsSha256']='f'*64
            elif kind=='canonical-config-sha':plan['configurationSha256']='f'*64
            elif kind=='boolean-backend-count':self.values['baseline.json']['databases']['course']['backend']['eligible']['outbox']=False
            else:self.values['baseline.json']['gateway']['admission']['active']['newWork']=False
            self.repin_chain()
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.load()
        self.values=original;self.selection=original_selection;self.initial['interruptedRestoration']=self.selection;self.repin_chain();self.load()

    def test_original_lease_environment_and_profile_reject_valid_repinned_chains(self):
        self.load()
        fault=self.original/'fault'
        original_files={name:(fault/name).read_bytes() for name in ('fault-arm-intent.json','fault-arm-observed.json')}
        original=copy.deepcopy(self.values)
        for key,value in (('environment','production'),('profile','foreign-profile-v1')):
            self.values=copy.deepcopy(original)
            arm=json.loads(original_files['fault-arm-intent.json']);arm['lease'][key]=value
            arm['leaseSha256']=c.sha(c.canonical(arm['lease'])+b'\n')
            observed=json.loads(original_files['fault-arm-observed.json']);observed['leaseSha256']=arm['leaseSha256']
            (fault/'fault-arm-intent.json').write_bytes(c.canonical(arm)+b'\n')
            (fault/'fault-arm-observed.json').write_bytes(c.canonical(observed)+b'\n')
            self.values['domain.json']['effect']['leaseSha256']=arm['leaseSha256'];self.repin_chain()
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'P2_INTERRUPTED_ORIGINAL_FAULT_LEASE_REQUIRED'):self.load()
        for name,raw in original_files.items():(fault/name).write_bytes(raw)
        self.values=original;self.repin_chain();self.load()
        self.values['baseline.json']['plan']['environment']='production';self.repin_chain()
        with self.assertRaisesRegex(ValueError,'P2_INTERRUPTED_ORIGINAL_PROCESS_EFFECT_REQUIRED'):self.load()

    def test_valid_fresh_map_cannot_replace_original19_even_at_missing_API_frontier(self):
        auth=self.values['replacement-authorization.json'];name='known-ack-stage-0-intent.json'
        raw=c.canonical({'status':'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT','stage':list(c.runtime.STAGES[0]),'recoveryActionId':'replace-old','maximumSeconds':120,
          'candidateSha256':'a'*64,'authorizationReceiptSha256':c.sha(c.canonical(auth))})+b'\n'
        (self.replacement/name).write_bytes(raw);self.selection['replacementReceiptSha256'][name]=c.sha(raw)
        self.assertEqual(self.load()['activeStage'],c.runtime.STAGES[0])
        path=self.f.configuration/'course-api.env';old=path.read_bytes();path.write_bytes(old+b'OWNED_HARMLESS_CONFIG_DRIFT=1\n')
        self.initial['configurationSha256']=c.staging_state.configuration_hashes(self.f.configuration)
        with patch.object(c.prior,'observe_stopped_prior_gateway') as stopped,self.assertRaisesRegex(ValueError,'ORIGINAL_CONFIGURATION_REQUIRED'):self.load()
        stopped.assert_not_called()
        path.write_bytes(old);self.initial['configurationSha256']=c.staging_state.configuration_hashes(self.f.configuration);self.load()

    def test_complete_source_chain_keeps_one_without_issuing_a_capability(self):
        retained=self.load();self.assertEqual(retained['originalGateway']['admission']['uncertain'],{'newWork':0,'recovery':1});self.assertEqual(retained['completedStages'],[])

    def test_every_original_missing_or_mutated_receipt_and_new_unpinned_stage_refuses(self):
        for name in c.CAUSAL_FILES:
            path=self.causal/name;raw=path.read_bytes();path.write_text('{}')
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'RECEIPT_CHANGED'):self.load()
            path.write_bytes(raw)
        path=self.replacement/'known-ack-stage-0-intent.json';path.write_text('{}')
        with self.assertRaisesRegex(ValueError,'ABSENCE_CHANGED'):self.load()
        path.unlink();self.load()

    def test_new_deadline_does_not_rebase_settlement_receiver_or_unrelated_effects(self):
        retained=self.load();actual=copy.deepcopy(self.before);actual['frontend']['admission']['uncertain']=0
        actual['frontend']['operations'][0].update(state='completed',completed_at='2026-11-06T01:00:06.000Z',reconciliation_sha256=self.selection['causalReceiptSha256']['settlement.json'])
        for service in ('course','community'):actual[service]['backend']['deadline']='2026-11-07T00:00:00.000Z'
        c.validate_fresh_settled(retained,actual)
        for kind in ('extra-operation','wrong-settlement','later-command','backend-effect','backend-eligible','selected-receiver'):
            bad=copy.deepcopy(actual)
            if kind=='extra-operation':bad['frontend']['operations'].append(copy.deepcopy(bad['frontend']['operations'][1]))
            elif kind=='wrong-settlement':bad['frontend']['operations'][0]['reconciliation_sha256']='f'*64
            elif kind=='later-command':bad['frontend']['later']=1
            elif kind=='backend-effect':bad['course']['backend']['snapshotSha256']='f'*64
            elif kind=='backend-eligible':bad['community']['backend']['eligible']['repairs']=1
            else:bad['community']['command']['acceptedAt']='2026-11-06T01:00:09.000Z'
            with self.subTest(kind=kind),self.assertRaises(ValueError):c.validate_fresh_settled(retained,bad)

    def test_raw_details_and_original_source_are_not_replaceable(self):
        path=self.old_source/c.known.MODULE;raw=path.read_bytes();path.chmod(0o600);path.write_bytes(raw+b'\n')
        with self.assertRaises(ValueError):self.load()
        path.write_bytes(raw);path.chmod(0o444);self.load()
        (self.original/'p2-certification-operator-request-details.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'REQUEST_BYTES'):self.load()

    def test_foreign_unknown_or_zero_old_gateway_cannot_reuse_one_proof(self):
        for kind in ('zero','foreign','active'):
            bad=copy.deepcopy(self.gateway)
            if kind=='zero':bad['admission']['uncertain']['recovery']=0
            elif kind=='foreign':bad['process']['containerId']='f'*64
            else:bad['admission']['active']['recovery']=1
            with patch.object(c.prior,'observe_stopped_prior_gateway',return_value=bad),self.subTest(kind=kind),self.assertRaises(ValueError):self.load()

    def test_original_gateway_intent_without_readback_cannot_prove_no_lost_newer_generation(self):
        authorization=self.values['replacement-authorization.json']
        for index,stage in enumerate(c.runtime.STAGES):
            begin={'status':'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT','stage':list(stage),'candidateSha256':'a'*64,
                   'recoveryActionId':'replace-old','maximumSeconds':120,'authorizationReceiptSha256':c.sha(c.canonical(authorization))}
            name='known-ack-stage-'+str(index)+'-intent.json';raw=c.canonical(begin)+b'\n';(self.replacement/name).write_bytes(raw)
            self.selection['replacementReceiptSha256'][name]=c.sha(raw)
            if index<4:
                end={'status':'P2_KNOWN_ACK_RUNTIME_STAGE_OBSERVED','stage':list(stage),'recoveryActionId':'replace-old','newProcesses':dict.fromkeys(stage,{})}
                name='known-ack-stage-'+str(index)+'-observed.json';raw=c.canonical(end)+b'\n';(self.replacement/name).write_bytes(raw)
                self.selection['replacementReceiptSha256'][name]=c.sha(raw)
        # Current reviewed helper can prove pre-command absence with the exact
        # old stop; old/changed helper bytes cannot inherit that proof.
        self.assertEqual(self.load()['activeStage'],('gateway',))
        original=c.original_source
        def old_helper(*args):
            directory,manifest=original(*args);return directory,{**manifest,c.B_FRONTIER_MODULE:'f'*64}
        with patch.object(c,'original_source',side_effect=old_helper),self.assertRaisesRegex(ValueError,'GATEWAY_FRONTIER_UNKNOWN'):self.load()
        marker=self.replacement/c.B_GATEWAY_MARKER;marker.write_text('{}')
        with self.assertRaisesRegex(ValueError,'ABSENCE_CHANGED'):self.load()
        marker.unlink();self.load()
        # Source raw observer errors remain authoritative even if a marker was
        # deleted after a pending write or the current pointer was lost.
        for state in ('pending','missing','contradictory'):
            with self.subTest(state=state),patch.object(c.prior,'observe_stopped_prior_gateway',side_effect=ValueError('PRIOR_GATEWAY_LATEST_STOP_LINEAGE_REQUIRED')),self.assertRaisesRegex(ValueError,'LATEST_STOP_LINEAGE'):self.load()


class ProfiledRetainedChainTests(unittest.TestCase):
    """Use the actual B recorder/boundary writers and projected runtime I/O."""

    def setUp(self, replacement=False):
        fixture = b.ProfiledKnownAckSourceTests(); fixture.setUp(replacement=replacement); self.addCleanup(fixture.doCleanups)
        self.fixture = fixture; broker = fixture.broker; profile = fixture.profile; self.fields = fixture.fields
        self.root = b.source.ROOT; self.selected = broker.selected; self.jobs = broker.jobs
        self.cert = self.root / ('p2-profiled-current-certification-' + broker.action_id())
        self.cert.mkdir(mode=0o700); broker.directory = self.cert
        prefix = 'migration-profiled-frontend-replacement-' if replacement else ''
        release = self.root / (prefix + self.selected['releaseId']); release.mkdir(mode=0o700)
        c.migrate.write_exact_bytes(release, 'candidate.json', fixture.candidate_raw)
        actual_capture, actual_stopped = c.prior.capture_before_stop, c.prior.observe_stopped_prior_gateway
        actual_reference = c.prior._reference
        source_commit = self.selected['sources']['frontend']['commit']
        operators = self.root / 'operators'; installed = operators / source_commit
        names = REQUIRED | PROFILED_CURRENT_REQUIRED | PROFILED_CERTIFICATION_REQUIRED | {c.known.HOST_MODULE, c.known.MODULE,
            'ops/platform/host/p2_prior_gateway.py', 'ops/platform/host/p2_certification_fault.py', 'ops/gateway/p2-certification-fault.mjs'}
        manifest = {}
        for name in sorted(names):
            raw = c.migrate.read_input(broker.source, name)
            file = installed / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(raw); file.chmod(0o444)
            manifest[name] = c.sha(raw)
        closure = c.sha(c.canonical(sorted(manifest.items())))
        broker.initial['sourceSha256'] = manifest; broker.initial['sourceClosureSha256'] = closure
        cert = broker.initial['certificationPlan']; fault = broker.fault_stage.plan; native = broker.initial['nativePlan']
        native.update(environment='staging', actionId=self.selected['releaseId'],
                      phase2ContractManifestSha256=self.selected['phase2ContractManifestSha256'], target=fixture.scope.receipt['target'])
        native['planSha256'] = c.sha(c.canonical({key: value for key, value in native.items() if key != 'planSha256'}))
        fault.update(environment='staging', actionId=self.selected['releaseId'], maxMatches=1, leaseMilliseconds=120000,
                     nativePlanSha256=native['planSha256'], operatorSourceClosureSha256=closure)
        cert['operatorSourceClosureSha256'] = closure
        cert['configurationSha256'] = c.sha(b.parent._profiled_compact(broker.initial['configurationSha256']))
        if replacement:
            for field in b.parent.PROFILED_PLAN_FIELDS: cert.setdefault(field, None)
            cert['readyReceiptSha256'] = {'frontend-workload-outcome.json': 'a' * 64}
        rows = [{'service': name, 'containerId': format(index + 1, '064x'),
                 'image': self.selected['artifacts'][c.runtime.IMAGE_KEYS[name]]['image'],
                 'health': 'none' if name.endswith('-tls') else 'healthy'} for index, name in enumerate(c.runtime.SERVICES)]
        cert['runtimeInventorySha256'] = c.sha(c.canonical(rows))
        intent = c.known.replacement_intent(cert, fixture.recovery, expected_profile=profile)
        cert['knownAckRecovery'] = {**self.fields, 'recoveryActionId': fixture.recovery, 'intent': intent, 'intentSha256': c.sha(c.canonical(intent))}
        cert['planSha256'] = b.parent._profiled_plan_hash(cert)
        fixture.scope.certification_plan = copy.deepcopy(cert)
        fixture.scope.receipt['planSha256'] = cert['planSha256']
        fixture.scope._physical_observer.request.update(plan=cert, receipt=fixture.scope.receipt)
        candidate_hash = broker.initial['candidateSha256']
        fixture.gateway['binding'].update(releaseId=self.selected['releaseId'], hostMachineId='1' * 32,
            gatewayImage=self.selected['artifacts']['gateway']['image'],
            runtimeConfigurationSha256=broker.initial['configurationSha256']['runtime.json'])
        mount = broker.configuration / 'admission'; mount.mkdir(mode=0o755)
        self.fault_dir = self.cert / 'fault'; self.fault_dir.mkdir(mode=0o700)
        command = native['commandWitnesses'][0]
        lease = {'version': 1, **{key: fault[key] for key in ('environment', 'profile', 'stageId', 'candidateSha256', 'configurationSha256',
            'gatewayConfigurationSha256', 'gatewayProcessSha256', 'gatewayImageSha256', 'mode', 'receiver')},
            'releaseId': self.selected['releaseId'], 'sourceWitnessSha256': fault['commandSha256'],
            'issuedAt': '2026-11-06T01:00:00.000Z', 'expiresAt': '2026-11-06T01:02:00.000Z', 'maxMatches': 1,
            'record': {'commandId': command['commandId'], 'accountVersion': int(command['accountVersion']), 'canonicalSha256': fault['commandSha256']}}
        lease_sha = c.sha(c.canonical(lease) + b'\n'); broker.fault_stage.lease_sha256 = lease_sha
        broker.fault_stage.effects.return_value[0]['leaseSha256'] = lease_sha
        self.write(self.fault_dir, 'fault-arm-intent.json', {**self.fields, 'stageId': fault['stageId'], 'leaseSha256': lease_sha,
            'admissionDirectoryDevice': mount.stat().st_dev, 'admissionDirectoryInode': mount.stat().st_ino, 'lease': lease})
        self.write(self.fault_dir, 'fault-arm-observed.json', {**self.fields, 'status': 'P2_FAULT_LEASE_ARMED', 'stageId': fault['stageId'],
            'leaseSha256': lease_sha, 'expiresAt': lease['expiresAt'], 'maxMatches': 1, 'gatewayProcessSha256': fault['gatewayProcessSha256']})
        self.component = fixture.replacement_fixture()
        self.replacement = fixture.boundary.output; self.causal = broker.known_ack_recorder.directory
        _, api = b.parent.check_profiled_certification_apis(fixture.scope, broker.jobs, broker.source, broker.bundle, self.cert / 'current-api',
            dict.fromkeys(('course', 'community'), 'owned-private-input'), manifest, expected_profile=profile)
        self.write(self.cert, 'p2-certification-current-ready.json', {'status': 'P2_CERTIFICATION_CURRENT_READY', 'apiDatabases': api,
            'containers': rows, 'sqlReplayed': False, 'runtimeReplaced': False})
        pins = c.known.replacement_release_pins(cert, profile)
        self.write(self.cert, 'p2-profiled-certification-input-verified.json', {**self.fields, 'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED',
            'environment': 'staging', 'releaseId': self.selected['releaseId'], 'certificationActionId': broker.action_id(),
            'sourceCommit': source_commit, 'candidateSha256': candidate_hash, 'targetSha256': cert['targetSha256'],
            'planSha256': cert['planSha256'], 'originalReleasePlanHashHostVerified': True,
            **({**pins, 'readyReceiptSha256': cert['readyReceiptSha256'],
                'hostOriginalReleaseReceiptSha256': pins['originalReleaseReceiptSha256']} if replacement else {})})
        self.initial = {**self.fields, 'mode': c.PROFILED_MODE, 'environment': 'staging', 'recoveryActionId': 'new-profiled-c',
            'candidateSha256': candidate_hash, 'bundle': str(broker.bundle), 'results': str(self.root),
            'configuration': cert['knownAckConfigurationInputDirectory'], 'configurationSha256': broker.initial['configurationSha256'],
            'targetSha256': cert['targetSha256'], 'hostMachineId': '1' * 32, 'apiJobSha256': cert['apiJobSha256'],
            'receiverTargets': fixture.receiver_targets, 'originalCertificationPlanSha256': cert['planSha256'],
            'originalCertificationPlanBytesSha256': '1' * 64, 'operationId': broker.known_ack_recorder.domain['operationId']}
        if replacement:
            from p2_frontend_replacement_parent import RUNTIME_REVIEW
            from p2_replacement_terminal import TERMINAL
            raw = c.canonical(cert) + b'\n'
            terminal = base64.b64decode(broker.initial['originalReleaseReceipt'], validate=True)
            self.initial.update(reviewedPlan=pins, inventory={'certification':{'owned':'fixture'}},
                originalReleaseReceipt=broker.initial['originalReleaseReceipt'],
                originalCertificationPlan=base64.b64encode(raw).decode(), originalCertificationPlanBytesSha256=c.sha(raw))
            self.guardian = self.root / ('p2-profiled-replacement-write-' + self.selected['releaseId'])
            self.guardian.mkdir(mode=0o700)
            c.migrate.write_exact_bytes(self.guardian, RUNTIME_REVIEW, b.replacement_runtime_review_fixture(profile))
            c.migrate.write_exact_bytes(self.guardian, TERMINAL, terminal)
        self.cert_id, self.recovery_id, self.source_commit = broker.action_id(), fixture.recovery, source_commit
        self.stop_dir = self.cert / 'prior-gateway-after-quiescence'
        self.stop_dir.mkdir(mode=0o700)
        patches = (patch.object(c, 'ROOT', self.root), patch.object(c, 'OPERATORS', operators),
            patch.object(c.prior, 'capture_before_stop', actual_capture), patch.object(c.prior, 'observe_stopped_prior_gateway', actual_stopped),
            patch.object(c.prior, '_reference', actual_reference),
            patch.object(c.prior, '_inventory', side_effect=lambda *_: [fixture.model['gateway'][0]['Id']]),
            patch.object(c.prior, '_mounted_configuration', side_effect=lambda *_: Path(next(row['Source'] for row in
                fixture.model['gateway'][0]['Mounts'] if row['Destination'] == '/admission')).parent),
            patch.object(c.prior, '_close', side_effect=lambda *_args, **kwargs: fixture.gateway_read(expected_profile=kwargs['expected_profile'])))
        for item in patches:
            item.start(); self.addCleanup(item.stop)

    @staticmethod
    def write(directory, name, value):
        c.migrate.write_json(directory, name, value)

    def stop(self):
        profile = self.fixture.profile
        original_guard = {key: self.initial[key] for key in ('candidateSha256', 'configurationSha256', 'hostMachineId')}
        before = c.prior.capture_before_stop({**original_guard, 'certificationActionId': self.cert_id}, self.selected, self.stop_dir,
            self.fixture.scope.verify, expected_profile=profile)
        self.fixture.model['gateway'][0]['State'].update(Running=False, Pid=0)
        c.prior.retain_ordered_stop(before, self.stop_dir, self.fixture.scope.verify, expected_profile=profile)

    def refresh_pins(self):
        def pin(directory, name):
            path = directory / name
            return c.sha(path.read_bytes()) if path.exists() else None
        self.initial['interruptedRestoration'] = {**self.fields, 'mode': c.PROFILED_MODE, 'restorationActionId': 'new-profiled-c',
            'originalCertificationActionId': self.cert_id, 'originalRecoveryActionId': self.recovery_id,
            'originalOperatorSourceCommit': self.source_commit,
            'causalReceiptSha256': {name: pin(self.causal, name) for name in c.PROFILED_CAUSAL_FILES},
            'replacementReceiptSha256': {name: pin(self.replacement, name) for name in c.REPLACEMENT_FILES},
            'priorGatewayReference': {'kind': 'stopped-current-candidate', 'stopReceiptDirectory': str(self.stop_dir),
                                      'stopReceiptSha256': pin(self.stop_dir, c.prior.STOPPED)}}

    def load(self):
        return c.load_profiled_retained(self.initial, self.selected, self.jobs, self.fixture.scope.verify,
                                        expected_profile=self.fixture.profile)

    def test_exact_intent_and_stopped_original_one_do_not_issue_authority(self):
        self.stop(); self.refresh_pins(); evidence = self.load()
        self.assertEqual(evidence['frontier'], 'original-stopped-one')
        self.assertEqual(evidence['activeStage'], None); self.assertEqual(evidence['completedStages'], [])
        self.assertEqual(evidence['stoppedGateway']['admission']['uncertain'], {'newWork': 0, 'recovery': 1})
        self.assertEqual(len(evidence['observedProcesses']), 10)
        self.assertFalse(any('up' in call for call in self.fixture.calls))

    def test_replacement_zero_requires_the_actual_latest_process_and_durable_marker(self):
        outcome = self.component.restore(); self.stop(); self.refresh_pins(); evidence = self.load()
        self.assertEqual(evidence['frontier'], 'replacement-stopped-zero')
        self.assertEqual(evidence['stoppedGateway']['process'], outcome['newGateway']['process'])
        self.assertEqual(evidence['completedStages'], list(c.runtime.STAGES))
        marker = self.replacement / c.B_GATEWAY_MARKER; original = marker.read_bytes()
        value = json.loads(original); value['pendingLineage']['expectedCandidateSha256'] = 'f' * 64
        marker.write_bytes(c.canonical(value) + b'\n'); self.refresh_pins()
        with self.assertRaisesRegex(ValueError, 'DURABLE_GATEWAY_FRONTIER_REQUIRED'): self.load()
        marker.unlink(); self.refresh_pins()
        with self.assertRaisesRegex(ValueError, 'LATEST_STOPPED_ONE_REQUIRED'): self.load()

    def test_active_gateway_intent_without_command_requires_original_source_and_latest_one(self):
        capture = c.prior.capture_before_stop
        def lose_before_stop(initial, selected, output, *args, **options):
            if output == self.replacement:
                raise ValueError('OWNED_LOST_BEFORE_OLD_STOP')
            return capture(initial, selected, output, *args, **options)
        with patch.object(c.prior, 'capture_before_stop', side_effect=lose_before_stop):
            with self.assertRaisesRegex(ValueError, 'OWNED_LOST_BEFORE_OLD_STOP'): self.component.restore()
        self.stop(); self.refresh_pins(); evidence = self.load()
        self.assertEqual(evidence['activeStage'], ('gateway',))
        self.assertEqual(evidence['frontier'], 'original-stopped-one')
        with patch.object(c, 'PROFILED_B_FRONTIER_SHA256', 'f' * 64):
            with self.assertRaisesRegex(ValueError, 'GATEWAY_FRONTIER_UNKNOWN'): self.load()
        c.prior._remember({**self.initial, 'recoveryActionId': self.recovery_id}, evidence['originalGateway'],
            'replacement-in-progress', expectedCandidateSha256=self.initial['candidateSha256'])
        with self.assertRaisesRegex(ValueError, 'LATEST_STOP_LINEAGE_REQUIRED'): self.load()

    def test_candidate_jobs_lease_and_original_plan_require_actual_bytes(self):
        self.stop(); self.refresh_pins()
        for path, code in ((self.fixture.candidate_file, 'EXACT_ORIGINAL_CANDIDATE_REQUIRED'),
                           (Path(self.initial['bundle']) / 'jobs/course.json', 'EXACT_ORIGINAL_API_JOB_REQUIRED')):
            raw = path.read_bytes(); path.write_bytes(raw + b'\n')
            with self.assertRaisesRegex(ValueError, code): self.load()
            path.write_bytes(raw)
        self.initial['originalCertificationPlanSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_INPUT_REQUIRED'): self.load()
        path = self.fault_dir / 'fault-arm-intent.json'; value = json.loads(path.read_bytes()); value['admissionDirectoryInode'] += 1
        path.write_bytes(c.canonical(value) + b'\n')
        self.initial['originalCertificationPlanSha256'] = self.fixture.broker.initial['certificationPlan']['planSha256']
        with self.assertRaisesRegex(ValueError, 'FAULT_MOUNT_REQUIRED'): self.load()

    def test_rehashed_reconciliation_cannot_wash_original_uncertainty(self):
        self.stop()
        reconcile = self.causal / 'reconciliation-observed.json'
        authorization = self.causal / 'replacement-authorization.json'
        intent = self.replacement / 'known-ack-replacement-intent.json'
        record = json.loads(reconcile.read_bytes()); record['oldGatewayUncertain']['recovery'] = 0
        reconcile.write_bytes(c.canonical(record) + b'\n')
        auth = json.loads(authorization.read_bytes()); auth['reconciliationObservedSha256'] = c.sha(reconcile.read_bytes())
        authorization.write_bytes(c.canonical(auth) + b'\n')
        value = json.loads(intent.read_bytes()); value.update(authorization=auth, authorizationRawSha256=c.sha(authorization.read_bytes()))
        intent.write_bytes(c.canonical(value) + b'\n'); self.refresh_pins()
        with self.assertRaisesRegex(ValueError, 'CAUSAL_CONTEXT_REQUIRED'): self.load()

    def test_replacement_interruption_rejoins_exact_original_guardian_and_causal_pins(self):
        from p2_frontend_replacement_parent import RUNTIME_REVIEW
        from p2_replacement_terminal import TERMINAL
        fixture = ProfiledRetainedChainTests(); fixture.setUp(replacement=True); self.addCleanup(fixture.doCleanups)
        fixture.component.restore(); fixture.stop(); fixture.refresh_pins()
        pins = fixture.initial['reviewedPlan']

        def rejoin(carrier, original, selected, results, profile):
            self.assertEqual(carrier['configuration'], str(fixture.fixture.broker.configuration))
            self.assertEqual(carrier['certification'], {'owned': 'fixture'})
            self.assertEqual(original, fixture.fixture.broker.initial['certificationPlan'])
            self.assertEqual(selected, fixture.selected)
            self.assertEqual(results, fixture.root)
            raw = base64.b64decode(carrier['originalReleaseReceipt'], validate=True)
            self.assertEqual(raw, (fixture.guardian / TERMINAL).read_bytes())
            self.assertEqual(profile, fixture.fixture.profile)
            return c.sha(raw), True

        with patch.object(b.parent, '_profiled_replacement_original_terminal', side_effect=rejoin) as join:
            evidence = fixture.load()
            self.assertEqual(evidence['frontier'], 'replacement-stopped-zero')
            self.assertEqual(evidence['originalAuxiliarySha256']['originalReplacementRelease'][TERMINAL],
                             pins['originalReleaseReceiptSha256'])
            join.assert_called_once()
            review = fixture.guardian / RUNTIME_REVIEW
            review.write_bytes(review.read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'ORIGINAL_REPLACEMENT_REVIEW_CHANGED'): fixture.load()
            join.assert_called_once()


class AuthorityTests(unittest.TestCase):
    def test_registry_rejects_json_copy_foreign_parent_and_second_consumption(self):
        broker=c.InterruptedKnownAckRestorationBroker.__new__(c.InterruptedKnownAckRestorationBroker);broker.verify_prepared=lambda:True
        for value in ({'status':'P2_INTERRUPTED_NEW_SOURCE_AUTHORITY'},object()):
            with self.assertRaises(ValueError):c.consume_authorization(value,broker)
        with self.assertRaises(ValueError):c.InterruptedKnownAckRestorationAuthorization(object(),broker,{})
        value=c.InterruptedKnownAckRestorationAuthorization(c._ISSUER,broker,{'fixture':'registry-only'})
        with self.assertRaises(ValueError):c.consume_authorization(copy.copy(value),broker)
        self.assertEqual(c.consume_authorization(value,broker),{'fixture':'registry-only'})
        with self.assertRaises(ValueError):c.consume_authorization(value,broker)

    def test_concurrent_reservation_and_failed_verification_never_reissue(self):
        broker=c.InterruptedKnownAckRestorationBroker.__new__(c.InterruptedKnownAckRestorationBroker);entered=threading.Event();released=threading.Event();results=[]
        def verify():entered.set();self.assertTrue(released.wait(2))
        broker.verify_prepared=verify;value=c.InterruptedKnownAckRestorationAuthorization(c._ISSUER,broker,{})
        def consume():
            try:c.consume_authorization(value,broker);results.append('used')
            except ValueError:results.append('refused')
        first=threading.Thread(target=consume);first.start();self.assertTrue(entered.wait(1));second=threading.Thread(target=consume);second.start();second.join(1)
        self.assertEqual(results,['refused']);released.set();first.join(1);self.assertCountEqual(results,['refused','used'])
        broker.verify_prepared=lambda:(_ for _ in ()).throw(ValueError('ACTUAL_NEW_LEASE_LOST'));value=c.InterruptedKnownAckRestorationAuthorization(c._ISSUER,broker,{})
        with self.assertRaisesRegex(ValueError,'LEASE_LOST'):c.consume_authorization(value,broker)
        with self.assertRaises(ValueError):c.consume_authorization(value,broker)

    def test_native_attempt_evidence_survives_unknown_or_enabled_readback(self):
        import vercel
        initial={'interruptedRestoration':selection(),'candidate':{},'vercelToken':'owned-private-only'}
        baseline={'plan':{'nativePlan':{'projectId':'prj_owned'}}}
        with patch.object(c,'root_path',return_value=Path('/owned')),patch.object(c,'read_pinned',return_value={'baseline.json':baseline}),patch.object(vercel,'Client') as client:
            for readback in ({'nativeEnabled':True},{'nativeEnabled':False}):
                with self.subTest(readback=readback),patch.object(c.native,'observe_metadata',side_effect=[{'nativeEnabled':True},readback]):
                    value=c.contain_interrupted_native(initial,None,None)
                    self.assertTrue(value['nativeDisableAttempted'])
                    self.assertIs(value['nativeDisabled'],True if readback['nativeEnabled'] is False else None)
            self.assertEqual(client.return_value.request.call_count,2)

    def test_actual_isolated_main_entry_reaches_platform_guard_with_single_class_identity(self):
        import subprocess
        import sys
        program=r"""
import io,json,runpy,sys
from pathlib import Path
path=Path(sys.argv[1]);sys.path.insert(0,str(path.parent))
import migrate
original=migrate.demand;refusals=[]
def observe(ok,code):
    if not ok:refusals.append(code)
    return original(ok,code)
migrate.demand=observe
sys.stdin=io.TextIOWrapper(io.BytesIO((json.dumps({'mode':'known-ack-interrupted-restoration','environment':'staging','candidate':{'releaseId':'owned'},'recoveryActionId':'restore-new'})+'\n').encode()))
try:runpy.run_path(str(path),run_name='__main__')
except SystemExit:pass
print(json.dumps(refusals))
"""
        result=subprocess.run([sys.executable,'-I','-B','-c',program,str(Path(c.__file__).resolve())],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0)
        import os
        expected='P2_INSTALLED_GUARD_SOURCE_REQUIRED' if os.geteuid()==0 and sys.platform=='linux' else 'P2_LINUX_ROOT_GUARD_REQUIRED'
        self.assertEqual(json.loads(result.stdout),[expected])

    def test_closed_source_dispatch_has_a_distinct_fenced_terminal(self):
        import p2_release_supervisor as s
        initial={'candidate':{'releaseId':'original'},'mode':c.MODE,'recoveryActionId':'restore-new'}
        options={'broker_type':c.InterruptedKnownAckRestorationBroker,'observer_type':c.InterruptedRestorationPhysicalObserver,'observer_source':'ops/platform/p2-recovery-current-probe.mjs',
                 'layout':s.C_LAYOUT,'native_containment':c.contain_interrupted_native}
        with patch.object(s.os,'geteuid',return_value=1):
            with self.assertRaisesRegex(ValueError,'LINUX_ROOT'):s.supervise(initial,**options)
        for change in ({'native_containment':lambda *_:{}},{'layout':s.RECOVERY_LAYOUT},{'observer_type':c.PhysicalObserver},{'broker_type':c.Broker}):
            with self.subTest(change=tuple(change)),self.assertRaisesRegex(ValueError,'FIXED_SOURCE_DISPATCH'):s.supervise(initial,**{**options,**change})
        self.assertEqual(s.C_LAYOUT['terminalStatus'],'P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED')


class FallbackContainmentTests(unittest.TestCase):
    """Actual scope/flock/child reaping; fixed provider/Docker projections."""
    def run_case(self, active=False, native_failed=False, delete_failed=False, alive=False):
        import fcntl
        import os
        import subprocess
        import p2_release_broker as shared
        import p2_release_supervisor as supervisor
        from p2_release_scope import P2ReleaseScope
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();lock=root/'host-lock';fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            child=subprocess.Popen(['python3','-I','-c','import time;time.sleep(30)'])
            scope=P2ReleaseScope(fd,lock,lambda:None,{'fixture':'fallback'})
            scope.processes.add(child)
            broker=c.InterruptedKnownAckRestorationBroker({'candidate':{'releaseId':'owned'},'candidateSha256':'a'*64},lambda _:None)
            broker.scope=scope;broker.observer=__import__('types').SimpleNamespace(probe=lambda _:None)
            broker.source=root;broker.directory=root/'action';broker.directory.mkdir();broker.lock_fd=fd
            broker.selected={'releaseId':'owned'};broker.armed_probe={'fixture':'armed'};broker.worker=object() if active else None
            broker.guard_alive=alive;broker.safety_write=3 if alive else None
            events=[];remaining={'lash-p2-recovery-current-':['a'*12],'lash-p2-certification-observer-':['b'*12]}
            def reaped():
                self.assertTrue(scope.revoked.is_set());self.assertIsNotNone(child.poll())
            def native(*_args):
                reaped();events.append('native')
                if native_failed:raise ValueError('OWNED_NATIVE_UNKNOWN')
                return {'nativeDisabled':True,'nativeDisableAttempted':True}
            def command(args,*_args):
                reaped()
                if args[1:3]==['container','ls']:
                    prefix=next(name for name in remaining if any(name in str(value) for value in args));events.append(prefix);return '\n'.join(remaining[prefix])
                self.assertEqual(args[1:3],['rm','--force'])
                if delete_failed and args[-1]=='a'*12:raise ValueError('OWNED_DELETE_UNKNOWN')
                for ids in remaining.values():
                    if args[-1] in ids:ids.remove(args[-1])
                return ''
            try:
                with patch.object(shared,'LOCK',lock),patch.object(shared,'verify_source_closure'),patch.object(c.prior,'capture_before_stop',side_effect=ValueError('OWNED_CAPTURE_UNKNOWN')),\
                     patch.object(c.migrate,'suspend_runtime',side_effect=lambda *_:events.append('stop')),patch.object(c,'contain_interrupted_native',side_effect=native),\
                     patch.object(c.runtime,'command',side_effect=command),patch.object(broker,'safety',side_effect=lambda _:events.append('delegate')),patch.object(shared.subprocess,'run'):
                    broker.abort()
                    if alive:
                        self.assertEqual(events,['delegate']);self.assertIsNone(child.poll());return
                    reaped();self.assertIn('native',events)
                    for name in remaining:self.assertIn(name,events)
                    self.assertLess(events.index('stop'),events.index('native'))
                    self.assertIs(broker.outcome['nativeDisabled'],None if native_failed else True)
                    if delete_failed:self.assertTrue(broker.outcome['recoveryCurrentContainerCleanupUncertain'])
                    old=copy.deepcopy(broker.outcome);count=len(events);broker.abort();self.assertEqual(len(events),count);self.assertEqual(broker.outcome,old)
            finally:
                if child.poll() is None:child.kill()
                child.wait();os.close(fd)

    def synchronized_case(self, unreaped=False, delegated=False):
        import fcntl
        import os
        import subprocess
        import p2_release_broker as shared
        import p2_release_supervisor as supervisor
        from p2_release_scope import P2ReleaseScope
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();lock=root/'lock';fd=os.open(lock,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            child=subprocess.Popen(['python3','-I','-c','import time;time.sleep(30)'])
            scope=P2ReleaseScope(fd,lock,lambda:None,{});scope.processes.add(child)
            broker=c.InterruptedKnownAckRestorationBroker({'candidate':{'releaseId':'owned'}},lambda _:None)
            broker.scope=scope;broker.observer=__import__('types').SimpleNamespace(probe=lambda _:None,stop=lambda:None)
            broker.source=root;broker.directory=root/'action';broker.directory.mkdir();broker.lock_fd=fd;broker.selected={'releaseId':'owned'};broker.armed_probe={}
            entered=threading.Event();release=threading.Event();cleaned=threading.Event();closed=threading.Event();events=[]
            actual_revoke=scope.revoke
            def revoke():
                entered.set()
                if unreaped:raise ValueError('OWNED_KILL_WAIT_FAILED')
                self.assertTrue(release.wait(3));actual_revoke()
            def native(*_):
                events.append('native');cleaned.set()
                return {'nativeDisabled':True,'nativeDisableAttempted':False}
            def fixed(name):
                self.assertIsNotNone(child.poll());self.assertEqual(os.fstat(fd).st_ino,lock.stat().st_ino);events.append(name)
            try:
                with patch.object(shared,'LOCK',lock),patch.object(scope,'revoke',side_effect=revoke),patch.object(c.prior,'capture_before_stop',side_effect=ValueError('OWNED_CAPTURE_UNKNOWN')),\
                     patch.object(c.migrate,'suspend_runtime'),patch.object(c,'contain_interrupted_native',side_effect=native),patch.object(supervisor,'cleanup_recovery_current_containers'),\
                     patch.object(broker,'fixed_failure_containment',side_effect=fixed),patch.object(broker,'safety'):
                    if delegated:
                        broker.guard_alive=True;broker.safety_write=3;broker.abort();self.assertIsNone(child.poll());broker.guard_alive=False
                    failure=threading.Thread(target=broker.abort);failure.start();self.assertTrue(entered.wait(2))
                    def close():broker.close();closed.set()
                    closer=threading.Thread(target=close);closer.start()
                    self.assertFalse(closed.wait(0.1));self.assertEqual(os.fstat(fd).st_ino,lock.stat().st_ino)
                    if not unreaped:self.assertFalse(cleaned.is_set());release.set()
                    failure.join(3);self.assertFalse(failure.is_alive())
                    if unreaped:
                        self.assertFalse(closed.wait(0.1));self.assertFalse(broker.outcome['workerProcessesQuiesced']);self.assertIsNone(broker.outcome['runtimeStopped'])
                        child.kill();child.wait()
                    closer.join(3);self.assertFalse(closer.is_alive());self.assertTrue(closed.is_set())
                    with self.assertRaises(OSError):os.fstat(fd)
                    if unreaped:self.assertIn('p2-interrupted-surviving-broker-after-quiescence.json',events)
                    if delegated:self.assertIn('p2-interrupted-surviving-broker-containment.json',events)
            finally:
                release.set()
                if child.poll() is None:child.kill()
                child.wait()
                if broker.lock_fd is not None:os.close(fd)

    def test_concurrent_close_cannot_pass_blocked_parent_reaping(self):self.synchronized_case()
    def test_unreaped_mutator_retains_actual_fd_until_definitive_exit(self):self.synchronized_case(unreaped=True)
    def test_delegated_abort_then_guard_death_still_reaps_and_contains(self):self.synchronized_case(delegated=True)

    def test_guard_loss_while_armed_before_worker_reaps_and_cleans_both_namespaces(self):self.run_case()
    def test_active_guard_loss_reaps_before_native_and_namespace_cleanup(self):self.run_case(active=True)
    def test_failed_native_and_delete_readbacks_preserve_unknown_and_other_cleanup(self):self.run_case(native_failed=True,delete_failed=True)
    def test_live_guard_keeps_single_containment_owner(self):self.run_case(alive=True)


class TransitionTests(unittest.TestCase):
    """Actual inherited flock and B/C guards; Docker/provider transport projected."""
    save=b.KnownTransitionTests.save
    add_frontend=b.KnownTransitionTests.add_frontend
    metadata=b.KnownTransitionTests.metadata
    remember=b.KnownTransitionTests.remember
    def docker(self,args):
        if 'up' in args and tuple(args[args.index('90')+1:]) == ('gateway',):
            self.assertEqual(self.lineage['state'],'replacement-in-progress');self.replace(('gateway',));return ''
        return b.KnownTransitionTests.docker(self,args)
    gateway=b.KnownTransitionTests.gateway
    capture_stop=b.KnownTransitionTests.capture_stop
    retain_stop=b.KnownTransitionTests.retain_stop
    replace=b.KnownTransitionTests.replace

    def setUp(self):
        import p2_recovery_test as recovery
        with patch.object(tempfile,'tempdir',str(Path(tempfile.gettempdir()).resolve())):b.KnownTransitionTests.setUp(self)
        self.addCleanup(b.KnownTransitionTests.tearDown,self)
        self.b_boundary=self.boundary
        # A first completed B stage is genuinely generated by the B source
        # guard, then all services are source-stop projected for process loss.
        stage=c.runtime.STAGES[0];self.b_boundary.before_stage(stage);self.replace(stage);self.b_boundary.after_stage(stage)
        for rows in self.model.values():
            for row in rows:row['State'].update(Running=False,Pid=0)
        raw=recovery.RecoveryScopeTests.recovery(self,{'journalSha256':'e'*64})
        raw.configuration_sha256=self.scope.configuration_sha256
        original_run=raw.run
        def run(args,**kwargs):
            if args[0]!='docker':return original_run(args,**kwargs)
            raw.verify();self.calls.append(list(args));result=self.docker(args);raw.verify()
            text=result if isinstance(result,str) else json.dumps(result)
            return __import__('subprocess').CompletedProcess(args,0,stdout=text if kwargs.get('text') else text.encode(),stderr='' if kwargs.get('text') else b'')
        raw.run=run
        broker=c.InterruptedKnownAckRestorationBroker.__new__(c.InterruptedKnownAckRestorationBroker)
        broker.scope=broker.raw_scope=raw;broker.selected=raw.release;broker.jobs=raw.jobs;broker.source=self.root
        broker.initial={'candidateSha256':'a'*64,'configurationSha256':raw.configuration_sha256,'results':str(self.root),'recoveryActionId':'separate-recovery'}
        broker.directory=self.root/'c-action';broker.directory.mkdir(mode=0o700)
        broker.reader=__import__('types').SimpleNamespace(deadline=__import__('time').monotonic()+900,snapshot=lambda:{})
        broker.verify_prepared=lambda:raw.verify();broker.verify_original=lambda:raw.verify();broker.require_native_off=lambda:None
        broker.observer=__import__('types').SimpleNamespace(probe=lambda _:{'admission':{'epoch':'4','newWork':False,'recovery':False,'active':0,'uncertain':0}})
        original=json.loads((self.b_boundary.output/'known-ack-replacement-intent.json').read_text())
        retained={'originalGateway':self.old_gateway,'inputDirectory':self.configuration,'replacementDirectory':self.b_boundary.output,
          'selection':{'priorGatewayReference':{'kind':'stopped-current-candidate'},'causalReceiptSha256':{'settlement.json':'e'*64}},
          'oldProcesses':original['oldProcesses'],'activeStage':None,'stages':{'known-ack-stage-0-observed.json':json.loads((self.b_boundary.output/'known-ack-stage-0-observed.json').read_text())},
          'values':{'settlement.json':{'epoch':'4'}}}
        value=c.InterruptedKnownAckRestorationAuthorization(c._ISSUER,broker,{'fixture':'transition-only'})
        self.boundary=c.InterruptedRestorationBoundary(broker,raw,retained,value)
        self.snapshot=self.boundary.snapshot
        self.snapshot.mkdir(mode=0o700)
        for name in c.staging_state.CONFIGURATION_FILES:
            path=self.snapshot/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((self.configuration/name).read_bytes());path.chmod(0o600)
        (self.snapshot/'compose.yaml').write_bytes((self.root/'ops/platform/compose.yaml').read_bytes())
        self.c_scope=c.InterruptedRestorationScope(raw,self.boundary)
        self.c_broker=broker
        def remember(initial,observation,state='running-observed',**extra):self.lineage={'state':state,'process':copy.deepcopy(observation['process']),'binding':copy.deepcopy(observation['binding']),**extra}
        item=patch.object(c.prior,'_remember',side_effect=remember);item.start();self.addCleanup(item.stop)
        def next_generation(stage):
            for service in stage:self.model[service]=[self.metadata(service,2000+c.runtime.SERVICES.index(service),self.snapshot)]
        self.replace=next_generation

    def test_new_typed_five_stage_restore_preserves_historical_one_and_proves_new_zero(self):
        component=c.InterruptedRestorationRuntime(self.c_scope);order=[]
        def current(name,directory):order.append(('current',name));return {'status':'P2_RECOVERY_API_DATABASE_CURRENT'}
        def snapshot(_source,destination,*_):self.assertEqual(destination,self.snapshot);(destination/'admission').mkdir()
        with patch.object(component,'verify_api_current',side_effect=current),patch.object(c.runtime,'snapshot_configuration',side_effect=snapshot),\
             patch.object(c.runtime,'preflight',return_value=None),patch('staging_admission.persist_state',return_value='a'*64):
            result=component.restore()
        self.assertEqual(len(result['containers']),10);self.assertEqual(self.boundary.stage_index,5);self.assertTrue(self.boundary.finished)
        self.assertNotEqual(self.boundary.new_gateway['process']['containerId'],self.old_gateway['process']['containerId'])
        self.assertEqual(self.old_gateway['admission']['uncertain'],{'newWork':0,'recovery':1});self.assertEqual(self.boundary.new_gateway['admission']['uncertain'],{'newWork':0,'recovery':0})
        self.assertEqual(order,[('current','course'),('current','community')]);self.assertFalse(any('--execute' in args for args in self.calls))

    def test_new_scope_lease_drift_extra_process_and_changed_input_refuse_before_service_start(self):
        count=sum('up' in args for args in self.calls)
        self.model['course-api'].append(copy.deepcopy(self.model['course-api'][0]))
        with self.assertRaises(ValueError):self.boundary.before_stage(c.runtime.STAGES[0])
        self.model['course-api'].pop();self.boundary.verify()
        self.c_broker.observer.probe=lambda _:{'admission':{'epoch':'4','newWork':False,'recovery':False,'active':0,'uncertain':1}}
        with self.assertRaises(ValueError):self.boundary.before_stage(c.runtime.STAGES[0])
        self.assertEqual(sum('up' in args for args in self.calls),count)

    def test_same_gateway_or_uncertain_new_gateway_can_never_finish(self):
        for stage in c.runtime.STAGES[:-1]:self.boundary.before_stage(stage);self.replace(stage);self.boundary.after_stage(stage)
        self.boundary.before_stage(('gateway',));old=copy.deepcopy(self.model['gateway']);self.model['gateway'][0]['State'].update(Running=True,Pid=555)
        with self.assertRaises(ValueError):self.boundary.after_stage(('gateway',))
        self.model['gateway']=old;self.replace(('gateway',))
        with patch.object(c.prior,'observe_prior_gateway',return_value={**self.gateway(),'admission':{'newWork':False,'recovery':False,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':1}}}):
            with self.assertRaises(ValueError):self.boundary.after_stage(('gateway',))
