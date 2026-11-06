"""Source-issued known-ACK recorder. No counter reset or ordinary zero gate.

The only constructor authority is the fixed live certification broker and its
actual fault-stage instance. Source integration hooks must call this BEFORE the
fault arm. Retained JSON is evidence, never a constructor capability.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid
import weakref

import migrate
import release as runtime
from p2_certification_fault import P2CertificationFaultStage
from p2_release_scope import P2ReleaseScope

ROOT=Path('/var/lib/lash-her/releases/staging')
MODULE='ops/platform/p2-known-ack-loss-probe.mjs'
require=migrate.demand
_ISSUER=object()
_AUTHORIZATIONS=weakref.WeakKeyDictionary()


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(value):return hashlib.sha256(value).hexdigest()

def _zero(value):return value=={'newWork':0,'recovery':0}
def _same_process(first,second):return first['process']==second['process'] and first['binding']==second['binding']

def _source_command(scope):
    def run(args,env,timeout):
        result=scope.run(args,env=env,timeout=timeout,capture_output=True,check=True)
        require(not result.stderr and len(result.stdout)<=262144,'P2_KNOWN_ACK_HOST_OUTPUT_REQUIRED')
        return result.stdout.decode().strip()
    return run


class KnownAckLossRecoveryAuthorization:
    def __init__(self,issuer,recorder,record):
        require(issuer is _ISSUER,'P2_KNOWN_ACK_SOURCE_ISSUER_REQUIRED')
        self._recorder=recorder
        self._record=copy.deepcopy(record)
        self._used=False
        _AUTHORIZATIONS[self]={'recorder':recorder,'record':copy.deepcopy(record),'used':False}


def require_known_ack_loss_authorization(value,scope,recovery_action_id):
    """Fresh same-process validation. A copied receipt can never invoke this."""
    state=_AUTHORIZATIONS.get(value) if type(value) is KnownAckLossRecoveryAuthorization else None
    require(state is not None and state['recorder'].scope is scope and not state['used'] and
        recovery_action_id==state['record']['recoveryActionId'],'P2_KNOWN_ACK_OPAQUE_AUTHORIZATION_REQUIRED')
    state['recorder']._verify_authorization(state['record'])
    return copy.deepcopy(state['record'])


def consume_known_ack_loss_authorization(value,scope,recovery_action_id):
    """Only a fixed typed replacement scope may call this, exactly once.

    This is deliberately not an ordinary PriorGatewayBoundary. No serialized
    receipt or counter claim can be consumed by the ordinary zero factory.
    """
    record=require_known_ack_loss_authorization(value,scope,recovery_action_id)
    _AUTHORIZATIONS[value]['used']=True;value._used=True
    return record


class P2KnownAckLossRecorder:
    def __init__(self,broker,recovery_action_id,receiver_targets):
        # Lazy fixed source imports avoid making ordinary/recovery dispatch load
        # this module, and do not let JSON select a broker implementation.
        from p2_certification_parent import P2CertificationBroker
        from p2_prior_gateway import observe_prior_gateway
        selection=broker.initial['certificationPlan'].get('knownAckRecovery') if type(broker) is P2CertificationBroker else None
        require(type(broker) is P2CertificationBroker and broker.external_armed and isinstance(broker.scope,P2ReleaseScope) and
            type(broker.fault_stage) is P2CertificationFaultStage and broker.fault_stage.scope is broker.scope and
            broker.initial['certificationPlan']['mode']=='known-ack-recovery' and broker.native_enable_attempted is False and
            broker.fault_stage.arm_called is False and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',recovery_action_id or '') and
            recovery_action_id not in (broker.action_id(),broker.selected['releaseId']) and isinstance(selection,dict) and
            set(selection)=={'version','recoveryActionId','intent','intentSha256'} and selection['version']==1 and selection['recoveryActionId']==recovery_action_id and
            digest(canonical(selection['intent']))==selection['intentSha256'],'P2_KNOWN_ACK_BEFORE_FAULT_SOURCE_PARENT_REQUIRED')
        fault_plan=broker.fault_stage.plan
        plan={**copy.deepcopy(fault_plan),'nativePlan':copy.deepcopy(broker.initial['nativePlan'])}
        require(plan['mode']=='drop-after-ack' and plan['sourceCommit']==plan['operatorSourceCommit'] and plan['nativePlanSha256']==plan['nativePlan']['planSha256'] and
            len(plan['nativePlan']['commandWitnesses'])==1 and plan['nativePlan']['commandWitnesses'][0]['action']=='suspend','P2_KNOWN_ACK_ONE_SAME_SOURCE_SUSPENSION_REQUIRED')
        self.broker,self.scope,self.plan=broker,broker.scope,copy.deepcopy(plan)
        self.fault_plan=copy.deepcopy(fault_plan)
        self.recovery_action_id=recovery_action_id
        self.selection=copy.deepcopy(selection)
        require(selection['intent']==replacement_intent(broker.initial['certificationPlan'],recovery_action_id),'P2_KNOWN_ACK_REVIEWED_IMMUTABLE_REPLACEMENT_INTENT_REQUIRED')
        self.observe_gateway=observe_prior_gateway
        self.command=copy.deepcopy(plan['nativePlan']['commandWitnesses'][0])
        self.window_epoch=str(int(plan['nativePlan']['initialEpoch'])+1)
        self.receiver_targets=copy.deepcopy(receiver_targets)
        require(set(receiver_targets)=={'course','community'} and all(re.fullmatch(r'[1-9][0-9]{0,9}',value.get('roleOid','')) for value in receiver_targets.values()),
            'P2_KNOWN_ACK_REVIEWED_RECEIVER_ROLES_REQUIRED')
        for service,target in receiver_targets.items():
            job=broker.jobs[service]['job']
            require(all(target[key]==job['target'][key] for key in ('host','port','database','serverMajor')) and target['user']==job['runtimeRole'],
                'P2_KNOWN_ACK_REVIEWED_RECEIVER_TARGET_REQUIRED')
        self.source_sha256=digest(migrate.read_input(broker.source,MODULE))
        require(self.source_sha256==broker.initial['sourceSha256'][MODULE],'P2_KNOWN_ACK_EXACT_READER_SOURCE_REQUIRED')
        self.window_started=None;self.deadline=None;self.domain=None;self.settlement=None
        self.request_evidence=None
        self.directory=ROOT/('p2-known-ack-loss-'+broker.action_id())
        require(os.geteuid()==0 and self.directory.resolve()==self.directory and not any(path.is_symlink() for path in (self.directory,*self.directory.parents)),
            'P2_KNOWN_ACK_PRIVATE_ROOT_REQUIRED')
        migrate.private_directory(ROOT);self.directory.mkdir(mode=0o700)
        self._retain('recovery-intent.json',self.selection)
        self.baseline_gateway=self._gateway()
        require(self.baseline_gateway['admission']['newWork'] is False and self.baseline_gateway['admission']['recovery'] is True and
            _zero(self.baseline_gateway['admission']['active']) and _zero(self.baseline_gateway['admission']['uncertain']),'P2_KNOWN_ACK_BASELINE_ZERO_REQUIRED')
        self.baseline=self._snapshot()
        validate_baseline(self.plan,self.baseline)
        self.baseline_sha256=self._retain('baseline.json',{'status':'P2_KNOWN_ACK_BASELINE_RETAINED','plan':self.plan,'sourceModuleSha256':self.source_sha256,
            'candidateSha256':broker.initial['candidateSha256'],'gateway':self.baseline_gateway,'databases':self.baseline,'recoveryActionId':recovery_action_id})

    def _verify(self):
        require(self.broker.scope is self.scope and self.broker.fault_stage.plan==self.fault_plan and self.broker.initial['nativePlan']==self.plan['nativePlan'] and
            self.broker.initial['certificationPlan']['knownAckRecovery']==self.selection,'P2_KNOWN_ACK_SOURCE_INSTANCE_CHANGED')
        self.scope.require_frontend(self.broker.selected,self.broker.jobs['frontend']);self.scope.require_configuration(self.broker.configuration)
        require(digest(migrate.read_input(self.broker.source,MODULE))==self.source_sha256,'P2_KNOWN_ACK_READER_CHANGED')

    def _gateway(self):
        self._verify()
        value=self.observe_gateway(self.broker.initial,self.broker.selected,self.scope.verify,command=_source_command(self.scope))
        require(value['binding']['candidateSha256']==self.broker.initial['candidateSha256'] and value['binding']['configurationDirectory']==str(self.broker.configuration),
            'P2_KNOWN_ACK_CURRENT_CANDIDATE_REQUIRED')
        return value

    def _sql(self,service):
        self._verify();broker=self.broker
        payload={'version':1,'service':service,'commandId':self.command['commandId'],'accountVersion':self.command['accountVersion'],
            'commandSha256':self.plan['commandSha256'],'windowEpoch':self.window_epoch}
        if service=='frontend':
            payload.update(target=broker.jobs['frontend']['job']['target'],owner=broker.initial['owner'],marker=broker.armed_probe['marker'],
                backendPid=broker.armed_probe['backendPid'],backendStart=broker.armed_probe['backendStart'],targetSha256=self.plan['targetSha256'])
            identifier='lash-p2-certification-observer-'+uuid.uuid4().hex
            args=['docker','run','--rm','--name',identifier,'--interactive','--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
                '--memory','128m','--pids-limit','64','--env','FRONTEND_STAGING_MIGRATION_DATABASE_URL','--mount',f'type=bind,src={broker.source/MODULE},dst=/app/p2-known-ack-loss-probe.mjs,readonly',
                '--entrypoint','node',broker.selected['artifacts']['frontendMigration']['image'],'/app/p2-known-ack-loss-probe.mjs']
            environment={**runtime.SAFE_ENV,'FRONTEND_STAGING_MIGRATION_DATABASE_URL':broker.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL']}
        else:
            payload['target']=self.receiver_targets[service]
            identifier=next(row['containerId'] for row in broker.runtime_current if row['service']==service+'-api')
            args=['docker','exec','-i','--workdir','/app','--env','NODE_OPTIONS=--max-old-space-size=96','--env','DOTENV_CONFIG_QUIET=true',identifier,
                'node','--input-type=module','--eval',migrate.read_input(broker.source,MODULE).decode()+'\n']
            # ESM eval resolves pg from the actual /app image. No data-module
            # bare-import resolution or caller-selected loader is involved.
            args[-1]+='\ntry{console.log(JSON.stringify(await observeKnownAckSql(JSON.parse(readFileSync(0)),{getUrl:()=>process.env.DATABASE_URL})))}catch{console.error("P2_KNOWN_ACK_READ_REFUSED");process.exitCode=1}'
            environment=runtime.SAFE_ENV
        try:
            result=self.scope.run(args,env=environment,input=canonical(payload),capture_output=True,timeout=20,check=True)
            require(not result.stderr and 0<len(result.stdout)<=65536,'P2_KNOWN_ACK_PRIVATE_SQL_OUTPUT_REQUIRED')
            value=json.loads(result.stdout)
            require(value.get('status')=='P2_KNOWN_ACK_SQL_CURRENT' and value.get('service')==service and value.get('readOnly') is True,'P2_KNOWN_ACK_PRIVATE_SQL_READBACK_REQUIRED')
            self._verify();return value
        finally:
            if service=='frontend':
                self.scope.run(['docker','rm','--force',identifier],env=runtime.SAFE_ENV,timeout=15,capture_output=True,check=False)

    def _snapshot(self,allow_pending=False):
        first=self._sql('frontend');receivers={service:self._sql(service) for service in ('course','community')};last=self._sql('frontend')
        if first!=last:
            require(allow_pending,'P2_KNOWN_ACK_FRONTEND_CHANGED_DURING_RECEIVER_READ')
            validate_frontend_scope(self.plan,first);validate_frontend_scope(self.plan,last)
            return None
        return {'frontend':first,**receivers}

    def _retain(self,name,record):
        migrate.private_directory(self.directory);migrate.write_json(self.directory,name,record)
        return digest(migrate.read_input(self.directory,name))

    def start_native_window(self):
        self._verify();require(self.deadline is None and self.broker.native_expected is True,'P2_KNOWN_ACK_SOURCE_NATIVE_START_REQUIRED')
        self.window_started=time.monotonic();self.deadline=self.window_started+self.plan['nativePlan']['windowSeconds']

    def observe_domain(self):
        self._verify();require(self.deadline is not None and time.monotonic()<=self.deadline and self.broker.native_expected is True,'P2_KNOWN_ACK_BOUNDED_NATIVE_WINDOW_REQUIRED')
        gateway=self._gateway();require(_same_process(self.baseline_gateway,gateway),'P2_KNOWN_ACK_OLD_PROCESS_CHANGED')
        effects=self.broker.fault_stage.effects();snapshot=self._snapshot(allow_pending=True)
        after=self._gateway();require(_same_process(gateway,after) and time.monotonic()<=self.deadline,'P2_KNOWN_ACK_WINDOW_OR_PROCESS_CHANGED')
        if snapshot is None:return {'status':'P2_KNOWN_ACK_DOMAIN_PENDING'}
        value=validate_domain(self.plan,self.baseline,snapshot,gateway,effects)
        if value is None:return {'status':'P2_KNOWN_ACK_DOMAIN_PENDING'}
        if self.domain is None:
            self.domain={'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','gateway':gateway,'databases':snapshot,'effect':effects[0],**value}
            self.domain_sha256=self._retain('domain.json',self.domain)
        return {'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','domainSha256':self.domain_sha256}

    def retain_request_details(self,encoded):
        self._verify();require(self.domain is not None and self.request_evidence is None and self.deadline is not None and time.monotonic()<=self.deadline and
            self.broker.native_expected is True,'P2_KNOWN_ACK_IN_WINDOW_REQUEST_DETAILS_REQUIRED')
        from p2_release_broker import decode
        raw,artifact=decode(encoded)
        # Reuse the existing exact finite schema, source/project/producer/epoch
        # and explicit reviewer checks. Its ordinary all-completed qualification
        # remains false for the deliberately uncertain first request.
        observed=self.broker._request_evidence(encoded,{'operations':self.domain['databases']['frontend']['operations']})
        require(observed['authority']=='operator-recorded-request-details' and observed['artifactSha256']==digest(raw),
            'P2_KNOWN_ACK_ACTUAL_REQUEST_DETAILS_REQUIRED')
        validate_request_operations(self.plan,artifact,self.domain['databases']['frontend']['operations'])
        self.request_evidence={'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','artifactSha256':digest(raw),'domainSha256':self.domain_sha256,
            'provenance':observed,'originalArtifact':artifact}
        self.request_sha256=self._retain('request-details.json',self.request_evidence)
        return {'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','requestDetailsSha256':self.request_sha256}

    def prepare_reconciliation(self):
        self._verify();require(self.domain is not None and self.request_evidence is not None and self.broker.native_expected is False and self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_TIMELY_DOMAIN_PROOF_REQUIRED')
        gateway=self._gateway();actual=self._snapshot()
        require(_same_process(self.baseline_gateway,gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
            actual['frontend']['admission']['newWork'] is False and actual['frontend']['admission']['recovery'] is False,'P2_KNOWN_ACK_CLOSED_SETTLEMENT_REQUIRED')
        proof=validate_domain(self.plan,self.baseline,actual,gateway,[self.domain['effect']],closed=True)
        require(proof is not None and proof['operationId']==self.domain['operationId'],'P2_KNOWN_ACK_EXACT_SETTLEMENT_OPERATION_REQUIRED')
        validate_request_operations(self.plan,self.request_evidence['originalArtifact'],actual['frontend']['operations'])
        self.settlement={'status':'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT','recoveryActionId':self.recovery_action_id,'domainSha256':self.domain_sha256,
            'baselineSha256':self.baseline_sha256,'requestDetailsSha256':self.request_sha256,
            'operationId':self.domain['operationId'],'epoch':actual['frontend']['admission']['epoch'],'gateway':gateway,'databases':actual}
        self.settlement_sha256=self._retain('settlement.json',self.settlement)
        return {'operationId':self.domain['operationId'],'epoch':actual['frontend']['admission']['epoch'],'evidenceSha256':self.settlement_sha256}

    def authorize_replacement(self):
        self._verify();require(self.settlement is not None,'P2_KNOWN_ACK_SOURCE_SETTLEMENT_REQUIRED')
        record={'version':1,'status':'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED','recoveryActionId':self.recovery_action_id,'candidateSha256':self.broker.initial['candidateSha256'],
            'originalGateway':self.baseline_gateway,'domainSha256':self.domain_sha256,'settlementSha256':self.settlement_sha256,
            'baselineSha256':self.baseline_sha256,'requestDetailsSha256':self.request_sha256,'sourceModuleSha256':self.source_sha256,
            'recoveryIntentSha256':self.selection['intentSha256'],
            'operatorSourceClosureSha256':self.broker.initial['sourceClosureSha256'],'certificationActionId':self.broker.action_id(),
            'operationId':self.domain['operationId'],'ordinaryClosedZeroGate':False,'sqlReplayAllowed':False,'roleChangeAllowed':False}
        self._verify_authorization(record);self._retain('replacement-authorization.json',record)
        return KnownAckLossRecoveryAuthorization(_ISSUER,self,record)

    def _verify_authorization(self,record):
        self._verify();require(self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_NATIVE_OFF_REQUIRED')
        require(json.loads(migrate.read_input(self.directory,'recovery-intent.json'))==self.selection,'P2_KNOWN_ACK_RECOVERY_INTENT_CHANGED')
        for name,key in (('baseline.json','baselineSha256'),('domain.json','domainSha256'),('request-details.json','requestDetailsSha256'),('settlement.json','settlementSha256')):
            require(digest(migrate.read_input(self.directory,name))==record[key],'P2_KNOWN_ACK_ORIGINAL_RECEIPT_CHANGED')
        gateway=self._gateway();actual=self._snapshot();front=actual['frontend'];admission=front['admission']
        require(_same_process(self.baseline_gateway,gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
            _zero(gateway['admission']['active']) and gateway['admission']['uncertain']=={'newWork':0,'recovery':1} and
            admission['newWork'] is False and admission['recovery'] is False and admission['active']==admission['uncertain']==0,'P2_KNOWN_ACK_GLOBAL_ZERO_AND_OLD_ONE_REQUIRED')
        selected=[row for row in front['operations'] if row['id']==record['operationId']]
        require(len(selected)==1 and selected[0]['state']=='completed' and selected[0]['reconciliation_sha256']==record['settlementSha256'],'P2_KNOWN_ACK_SPECIFIC_SETTLED_OPERATION_REQUIRED')
        validate_settled(self.plan,self.settlement['databases'],actual,record['operationId'],record['settlementSha256'])


def replacement_intent(cert,recovery_action_id):
    """Fixed source projection displayed before apply, never a policy override."""
    return {'version':1,'recoveryActionId':recovery_action_id,'certificationActionId':cert['certificationActionId'],
        **{key:cert[key] for key in ('candidateSha256','sourceCommit','operatorSourceCommit','targetSha256','configurationSha256','gatewayProcessSha256')},
        'profile':'known-ack-same-session-ordered-replacement-v1','runtimeReplacements':1,'nativeWindowSeconds':cert['nativePlan']['windowSeconds'],
        'sqlReplayAllowed':False,'roleChangeAllowed':False,'ordinaryClosedZeroGate':False,'automaticFailureRecoveryAllowed':False}


def validate_baseline(plan,snapshot):
    front=snapshot['frontend'];admission=front['admission'];command=plan['nativePlan']['commandWitnesses'][0]
    validate_frontend_scope(plan,front)
    require(admission=={'epoch':plan['nativePlan']['initialEpoch'],'newWork':False,'recovery':True,'active':0,'uncertain':0} and
        front['exports']==front['later']==0 and front['operations']==[] and len(front['outstanding'])==2 and len(front['deliveries'])==2,
        'P2_KNOWN_ACK_COMPLETE_ZERO_BASELINE_REQUIRED')
    require(all(row['command_id']==command['commandId'] and row['status']=='pending' and row['attempts']==0 and row['ready'] is True and
        all(row[key] is None for key in ('lease_id','lease_until','acknowledged_at')) for row in front['outstanding']) and
        {row['receiver'] for row in front['outstanding']}=={'course','community'} and
        all(snapshot[service]['command'] is None for service in ('course','community')),'P2_KNOWN_ACK_UNTOUCHED_SELECTED_COMMAND_REQUIRED')


def validate_receiver_set(plan,snapshot):
    front=snapshot['frontend'];require(front['commandSha256']==plan['commandSha256'] and front['exports']==front['later']==0 and front['outstanding']==[],
        'P2_KNOWN_ACK_NO_OTHER_WORK_REQUIRED')
    require(len(front['deliveries'])==2 and {row['receiver'] for row in front['deliveries']}=={'course','community'} and all(row['status']=='acknowledged' and row['acknowledged_at'] is not None and
        row['lease_id'] is None and row['lease_until'] is None and row['attempts']==(2 if row['receiver']==plan['receiver'] else 1) for row in front['deliveries']),
        'P2_KNOWN_ACK_NORMAL_REPLAY_BOTH_ACKS_REQUIRED')
    for service in ('course','community'):
        row=snapshot[service]['command']
        require(row is not None and row['userBindingSha256']==front['userBindingSha256'] and row['accountVersion']==front['accountVersion'] and
            row['commandSha256']==plan['commandSha256'] and row['acceptedAt'] is not None and row['accountStatus']=='suspended','P2_KNOWN_ACK_CANONICAL_RECEIVER_REQUIRED')


def validate_frontend_scope(plan,front):
    native=plan['nativePlan'];operations=front['operations'];admission=front['admission']
    require(front['commandSha256']==plan['commandSha256'] and front['commandId']==native['commandWitnesses'][0]['commandId'] and
        front['accountVersion']==native['commandWitnesses'][0]['accountVersion'] and front['accountStatus']=='suspended' and front['exports']==front['later']==0 and
        admission['newWork'] is False and admission['active'] in (0,1) and admission['uncertain'] in (0,1) and len(operations)<=4,
        'P2_KNOWN_ACK_UNRELATED_EFFECT_REFUSED')
    require(all(row['producer_sha256']==native['producer']['producerSha256'] and row['source_sha']==native['sourceCommit'] and row['role_oid']==native['producer']['role']['oid'] and
        row['epoch']==str(int(native['initialEpoch'])+1) and row['kind']=='recovery' and row['state'] in ('active','uncertain','completed') and row['reconciliation_sha256'] is None for row in operations),
        'P2_KNOWN_ACK_UNRELATED_OPERATION_REFUSED')
    require(sum(row['state']=='active' for row in operations)==admission['active'] and sum(row['state']=='uncertain' for row in operations)==admission['uncertain'],
        'P2_KNOWN_ACK_GLOBAL_OPERATION_SCOPE_REQUIRED')


def validate_request_operations(plan,artifact,operations):
    require(isinstance(artifact,dict) and isinstance(artifact.get('observations'),list),'P2_KNOWN_ACK_REQUEST_ARTIFACT_REQUIRED')
    actual=[]
    for row in artifact['observations']:
        require(isinstance(row.get('admittedLogLine'),str),'P2_KNOWN_ACK_ALL_REQUESTS_MUST_BE_JOINED')
        event=json.loads(row['admittedLogLine']);actual.append((event['operationId'],row['httpStatus']))
    require(len(actual)==len(operations) and len({value[0] for value in actual})==len(actual) and all(
        (row['id'],503 if row['state']=='uncertain' else 200) in actual and row['state'] in ('uncertain','completed') for row in operations),
        'P2_KNOWN_ACK_EXACT_NATIVE_REQUEST_OPERATION_JOIN_REQUIRED')


def validate_settled(plan,before,actual,operation_id,settlement_sha256):
    """Only the selected uncertainty may become completed with this receipt.

    No new operation, receiver receipt, epoch, command, attempt or unrelated
    reconciliation may be hidden by a later global zero count.
    """
    validate_receiver_set(plan,actual)
    front=actual['frontend'];prior=before['frontend']
    require(prior['admission']['active']==0 and prior['admission']['uncertain']==1 and
        front['admission']=={**prior['admission'],'uncertain':0} and front['admission']['newWork'] is False and front['admission']['recovery'] is False and
        all(front[key]==prior[key] for key in ('commandId','accountVersion','accountStatus','commandSha256','userBindingSha256')) and
        all(actual[service]==before[service] for service in ('course','community')),'P2_KNOWN_ACK_SETTLED_CONTEXT_CHANGED')
    old=prior['operations'];rows=front['operations']
    require(sum(row['id']==operation_id for row in old)==1 and len(rows)==len(old) and len({row['id'] for row in rows})==len(rows) and {row['id'] for row in rows}=={row['id'] for row in old},
        'P2_KNOWN_ACK_SETTLED_OPERATION_SET_CHANGED')
    for row in rows:
        expected=next(value for value in old if value['id']==row['id'])
        if row['id']==operation_id:
            require(expected['state']=='uncertain' and row['state']=='completed' and row['completed_at'] is not None and row['reconciliation_sha256']==settlement_sha256 and
                all(row[key]==value for key,value in expected.items() if key not in ('state','completed_at','reconciliation_sha256')),
                'P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_RECEIPT_REQUIRED')
        else:require(row==expected,'P2_KNOWN_ACK_UNRELATED_OPERATION_CHANGED')


def validate_domain(plan,baseline,snapshot,gateway,effects,closed=False):
    front=snapshot['frontend'];admission=front['admission'];operations=front['operations'];native=plan['nativePlan']
    validate_baseline(plan,baseline);validate_frontend_scope(plan,front)
    require(gateway['admission']['newWork'] is False and gateway['admission']['active']['newWork']==0 and gateway['admission']['active']['recovery'] in (0,1) and gateway['admission']['uncertain'] in ({'newWork':0,'recovery':0},{'newWork':0,'recovery':1}) and
        front['exports']==front['later']==0 and len(effects)<=1 and len(operations)<=4,'P2_KNOWN_ACK_UNRELATED_EFFECT_REFUSED')
    require(admission['recovery'] is (not closed) and gateway['admission']['recovery'] is (not closed),'P2_KNOWN_ACK_STAGE_STATE_REQUIRED')
    require(all(row['producer_sha256']==native['producer']['producerSha256'] and row['source_sha']==native['sourceCommit'] and row['role_oid']==native['producer']['role']['oid'] and
        row['epoch']==str(int(native['initialEpoch'])+1) and row['kind']=='recovery' and row['reconciliation_sha256'] is None for row in operations),'P2_KNOWN_ACK_UNRELATED_OPERATION_REFUSED')
    unknown=[row for row in operations if row['state']=='uncertain'];completed=[row for row in operations if row['state']=='completed']
    if admission['active'] or not _zero(gateway['admission']['active']) or not effects or not unknown or not completed:return None
    require(len(unknown)==1 and admission['uncertain']==1 and gateway['admission']['uncertain']=={'newWork':0,'recovery':1},'P2_KNOWN_ACK_EXACT_ONE_REQUIRED')
    effect=effects[0]
    require(effect['mode']=='drop-after-ack' and effect['receiver']==plan['receiver'] and effect['sourceWitnessSha256']==plan['commandSha256'] and effect['upstreamReceiptVerified'] is True and
        effect['upstreamStarted'] is True and effect['upstreamStatus']==200 and effect['downstreamBytesStarted'] is False and
        effect['downstreamDisposition']=='dropped-before-any-response-bytes','P2_KNOWN_ACK_EXACT_TYPED_EFFECT_REQUIRED')
    if front['outstanding']:return None
    validate_receiver_set(plan,snapshot)
    require(any(row['started_at']>unknown[0]['started_at'] and row['completed_at'] is not None for row in completed),'P2_KNOWN_ACK_NORMAL_REPLAY_OPERATION_REQUIRED')
    return {'operationId':unknown[0]['id']}
