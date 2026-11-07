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
import threading
import uuid
import weakref
from datetime import datetime,timedelta,timezone

import migrate
import release as runtime
import vercel
from p2_certification_fault import P2CertificationFaultStage
from p2_release_scope import P2ReleaseScope

ROOT=Path('/var/lib/lash-her/releases/staging')
MODULE='ops/platform/p2-known-ack-loss-probe.mjs'
GATEWAY_STARTED='known-ack-gateway-replacement-started.json'
HOST_MODULE='ops/platform/host/p2_known_ack_loss.py'
require=migrate.demand
_ISSUER=object()
_PROFILED_ISSUER=object()
_AUTHORIZATIONS=weakref.WeakKeyDictionary()
_AUTHORIZATION_LOCK=threading.Lock()
_BOUNDARIES=weakref.WeakSet()
_BOUNDARY_ISSUER=object()
_PROFILED_BOUNDARY_ISSUER=object()
UNAVAILABLE_STAGES=(('community-api','course-api'),('community-tls','course-tls'),('gateway',))
MOUNTS={'gateway':{'/config/gateway.json':'gateway.json','/admission':'admission','/tls':'tls/gateway'},
    'course-tls':{'/config/course-tls.json':'course-tls.json','/tls':'tls/course'},'community-tls':{'/config/community-tls.json':'community-tls.json','/tls':'tls/community'},
    'course-publisher':{'/tls/ca.pem':'tls/ca.pem'},'community-api':{'/tls/ca.pem':'tls/ca.pem'},'community-worker':{'/tls/ca.pem':'tls/ca.pem'}}


def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(value):return hashlib.sha256(value).hexdigest()

def _zero(value):return value=={'newWork':0,'recovery':0}
def _same_process(first,second):return first['process']==second['process'] and first['binding']==second['binding']

def _profile_record(expected_profile):
    return {} if expected_profile is None else {'version':2,'qualificationTargetProfile':expected_profile}

def _profile_arguments(source):
    expected=getattr(source,'expected_profile',None)
    return {} if expected is None else {'expected_profile':expected}

def _delivery_receipts(frontend):
    # Readiness is a clock-derived observation. The ACK identity is not.
    return [{key:value for key,value in row.items() if key!='ready'} for row in frontend['deliveries']]

def _source_command(scope):
    def run(args,env,timeout):
        result=scope.run(args,env=env,timeout=timeout,capture_output=True,check=True)
        require(not result.stderr and len(result.stdout)<=262144,'P2_KNOWN_ACK_HOST_OUTPUT_REQUIRED')
        return result.stdout.decode().strip()
    return run


class KnownAckLossRecoveryAuthorization:
    def __init__(self,issuer,recorder,record):
        require(issuer is _ISSUER or issuer is _PROFILED_ISSUER,'P2_KNOWN_ACK_SOURCE_ISSUER_REQUIRED')
        self._recorder=recorder
        self._record=copy.deepcopy(record)
        self._used=False
        with _AUTHORIZATION_LOCK:
            _AUTHORIZATIONS[self]={'issuer':issuer,'recorder':recorder,'record':copy.deepcopy(record),'state':'unused'}


def _authorization(value,scope,recovery_action_id,issuer=_ISSUER):
    """Call only while holding the private registry mutex."""
    state=_AUTHORIZATIONS.get(value) if type(value) is KnownAckLossRecoveryAuthorization else None
    require(state is not None and state['issuer'] is issuer and state['recorder'].scope is scope and state['state']=='unused' and
        recovery_action_id==state['record']['recoveryActionId'],'P2_KNOWN_ACK_OPAQUE_AUTHORIZATION_REQUIRED')
    return state


def require_known_ack_loss_authorization(value,scope,recovery_action_id):
    """Fresh same-process validation. A copied receipt can never invoke this."""
    with _AUTHORIZATION_LOCK:state=_authorization(value,scope,recovery_action_id)
    state['recorder']._verify_authorization(state['record'])
    with _AUTHORIZATION_LOCK:
        require(_authorization(value,scope,recovery_action_id) is state,'P2_KNOWN_ACK_AUTHORIZATION_CHANGED')
        return copy.deepcopy(state['record'])


def consume_known_ack_loss_authorization(value,scope,recovery_action_id):
    """Only a fixed typed replacement scope may call this, exactly once.

    This is deliberately not an ordinary PriorGatewayBoundary. No serialized
    receipt or counter claim can be consumed by the ordinary zero factory.
    """
    return _consume_authorization(value,scope,recovery_action_id,_ISSUER)


def _consume_authorization(value,scope,recovery_action_id,issuer,*,recorder=None):
    with _AUTHORIZATION_LOCK:
        state=_authorization(value,scope,recovery_action_id,issuer)
        require(recorder is None or state['recorder'] is recorder,'P2_KNOWN_ACK_OPAQUE_AUTHORIZATION_REQUIRED')
        # Reserve before any verifier I/O. A failed or interrupted verification
        # is an attempted consumption and never restores unused authority.
        state['state']='consuming';value._used=True
    try:
        if issuer is _PROFILED_ISSUER:state['recorder']._verify_profiled_authorization(state['record'])
        else:state['recorder']._verify_authorization(state['record'])
    except BaseException:
        with _AUTHORIZATION_LOCK:state['state']='poisoned'
        raise
    with _AUTHORIZATION_LOCK:
        require(state['state']=='consuming','P2_KNOWN_ACK_CONSUMPTION_STATE_REQUIRED')
        state['state']='used'
        return copy.deepcopy(state['record'])


class P2KnownAckLossRecorder:
    expected_profile=None

    def __init__(self,broker,recovery_action_id,receiver_targets,*,expected_profile=None):
        # Lazy fixed source imports avoid making ordinary/recovery dispatch load
        # this module, and do not let JSON select a broker implementation.
        from p2_certification_parent import P2CertificationBroker, P2CertificationScope, P2ProfiledCertificationBroker
        from p2_prior_gateway import observe_prior_gateway
        self.expected_profile=migrate.profile_context(expected_profile)
        profiled=self.expected_profile is not None
        broker_type=P2ProfiledCertificationBroker if profiled else P2CertificationBroker
        require(type(broker) is broker_type and broker.certification_profile()==self.expected_profile,
            'P2_KNOWN_ACK_BEFORE_FAULT_SOURCE_PARENT_REQUIRED')
        cert=broker.initial['certificationPlan'];selection=cert.get('knownAckRecovery')
        profile=_profile_record(self.expected_profile)
        require(broker.external_armed and isinstance(broker.scope,P2ReleaseScope) and
            (not profiled or type(broker.scope) is P2CertificationScope and broker.scope._expected_profile==self.expected_profile) and
            type(broker.fault_stage) is P2CertificationFaultStage and broker.fault_stage.scope is broker.scope and
            cert['mode']=='known-ack-recovery' and broker.native_enable_attempted is False and
            broker.fault_stage.arm_called is False and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',recovery_action_id or '') and
            recovery_action_id not in (broker.action_id(),broker.selected['releaseId']) and isinstance(selection,dict) and
            set(selection)=={'version','recoveryActionId','intent','intentSha256'}|set(profile) and
            type(selection['version']) is int and selection['version']==(2 if profiled else 1) and selection['recoveryActionId']==recovery_action_id and
            digest(canonical(selection['intent']))==selection['intentSha256'],'P2_KNOWN_ACK_BEFORE_FAULT_SOURCE_PARENT_REQUIRED')
        fault_plan=broker.fault_stage.plan
        plan={**copy.deepcopy(fault_plan),'nativePlan':copy.deepcopy(broker.initial['nativePlan'])}
        vercel.require_record_profile(self.expected_profile,cert,selection,selection['intent'],fault_plan,plan['nativePlan'])
        if profiled:
            require(broker.fault_stage.expected_profile==self.expected_profile and cert['nativePlan']==plan['nativePlan'] and
                all(fault_plan[key]==cert[key] for key in ('candidateSha256','candidateObjectSha256','sourceCommit','operatorSourceCommit',
                    'targetSha256','gatewayProcessSha256','gatewayConfigurationSha256','operatorSourceClosureSha256')) and
                fault_plan['configurationSha256']==cert['configurationCanonicalSha256'] and
                all(fault_plan[key]==cert['faultSelection'][key] for key in ('stageId','receiver','commandSha256')) and
                cert['faultSelection']['commandIndex']==0,'P2_KNOWN_ACK_PROFILED_FAULT_CONTEXT_REQUIRED')
        require(plan['mode']=='drop-after-ack' and plan['sourceCommit']==plan['operatorSourceCommit'] and plan['nativePlanSha256']==plan['nativePlan']['planSha256'] and
            len(plan['nativePlan']['commandWitnesses'])==1 and plan['nativePlan']['commandWitnesses'][0]['action']=='suspend','P2_KNOWN_ACK_ONE_SAME_SOURCE_SUSPENSION_REQUIRED')
        self.broker,self.scope,self.plan=broker,broker.scope,copy.deepcopy(plan)
        self.fault_stage=broker.fault_stage
        self.fault_plan=copy.deepcopy(fault_plan)
        self.recovery_action_id=recovery_action_id
        self.selection=copy.deepcopy(selection)
        require(selection['intent']==replacement_intent(cert,recovery_action_id,expected_profile=self.expected_profile),
            'P2_KNOWN_ACK_REVIEWED_IMMUTABLE_REPLACEMENT_INTENT_REQUIRED')
        self.configuration_input=validate_known_configuration_input(cert['knownAckConfigurationInputDirectory'],
            broker.configuration,broker.selected,broker.jobs,broker.initial['configurationSha256'],expected_profile=self.expected_profile)
        self.scope.require_configuration(self.configuration_input)
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
        if profiled:
            require(receiver_targets==cert['knownAckReceiverTargets'] and all(set(target)=={'host','port','database','serverMajor','user','roleOid'}
                for target in receiver_targets.values()),'P2_KNOWN_ACK_REVIEWED_RECEIVER_TARGET_REQUIRED')
        self.source_sha256=digest(migrate.read_input(broker.source,MODULE))
        require(self.source_sha256==broker.initial['sourceSha256'][MODULE],'P2_KNOWN_ACK_EXACT_READER_SOURCE_REQUIRED')
        if profiled:self._verify()
        self.window_started=None;self.deadline=None;self.domain=None;self.settlement=None
        remaining=broker.initial['certificationPlan']['maximumSeconds']-(time.monotonic()-broker.certification_started)
        require(0<remaining<=900,'P2_KNOWN_ACK_BOUNDED_PARENT_REQUIRED')
        self.backend_deadline=(datetime.now(timezone.utc)+timedelta(seconds=remaining)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.request_evidence=None
        self.reconciliation_attempted=False
        self.reconciliation_observed_sha256=None
        self.profiled_replacement_attempted=False
        self.directory=ROOT/('p2-known-ack-loss-'+broker.action_id())
        require(os.geteuid()==0 and self.directory.resolve()==self.directory and not any(path.is_symlink() for path in (self.directory,*self.directory.parents)),
            'P2_KNOWN_ACK_PRIVATE_ROOT_REQUIRED')
        migrate.private_directory(ROOT);self.directory.mkdir(mode=0o700)
        self.intent_receipt_sha256=self._retain('recovery-intent.json',self.selection)
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
        self.scope.require_configuration(self.configuration_input)
        require(digest(migrate.read_input(self.broker.source,MODULE))==self.source_sha256,'P2_KNOWN_ACK_READER_CHANGED')
        if self.expected_profile is not None:self._verify_profiled_context()

    def _verify_profiled_context(self):
        from current_databases import read_certification_api_proof
        from qualification_target_profile import decode_qualification_target_json
        broker=self.broker;cert=broker.initial['certificationPlan']
        require(broker.fault_stage is self.fault_stage and cert==self.scope.certification_plan and
            broker.initial['sourceClosureSha256']==cert['operatorSourceClosureSha256'] and
            broker.initial['configurationSha256']==self.scope.configuration_sha256,
            'P2_KNOWN_ACK_PROFILED_SOURCE_CONTEXT_CHANGED')
        raw=migrate.read_input(broker.bundle,'release.candidate.json')
        selected=decode_qualification_target_json(raw,'carrier')
        migrate.candidate_profile(selected,self.expected_profile)
        require(digest(raw)==broker.initial['candidateSha256']==cert['candidateSha256']==self.scope.candidate_sha256 and
            selected==broker.selected and digest(canonical(selected))==cert['candidateObjectSha256'],
            'P2_KNOWN_ACK_EXACT_ORIGINAL_CANDIDATE_REQUIRED')
        read_certification_api_proof(broker.api_proof,self.scope,broker.selected,broker.jobs,expected_profile=self.expected_profile)

    def _gateway(self,*,require_disarmed=False):
        self._verify()
        options={} if self.expected_profile is None else {'expected_profile':self.expected_profile}
        value=self.observe_gateway(self.broker.initial,self.broker.selected,self.scope.verify,command=_source_command(self.scope),**options)
        require(value['binding']['candidateSha256']==self.broker.initial['candidateSha256'] and value['binding']['configurationDirectory']==str(self.broker.configuration),
            'P2_KNOWN_ACK_CURRENT_CANDIDATE_REQUIRED')
        if self.expected_profile is not None:
            actual=self.broker._gateway_current()
            require(value['process']['containerId']==self.fault_stage.gateway['containerId'] and
                value['binding']['gatewayConfigurationSha256']==actual['gatewayConfigurationSha256']==self.fault_plan['gatewayConfigurationSha256'] and
                actual['processSha256']==self.fault_plan['gatewayProcessSha256'] and
                (not require_disarmed or actual['faultLeasePresent'] is False and
                    all(actual['admission'].get(key)==value['admission'][key] for key in ('newWork','recovery','active','uncertain'))),
                'P2_KNOWN_ACK_PROFILED_OLD_GATEWAY_REQUIRED')
        return value

    def _sql(self,service,selected_user_binding=None):
        self._verify();broker=self.broker
        profile=_profile_arguments(self)
        payload={'version':1,'service':service,'commandId':self.command['commandId'],'accountVersion':self.command['accountVersion'],
            'commandSha256':self.plan['commandSha256'],'windowEpoch':self.window_epoch,'backendDeadline':self.backend_deadline}
        if service=='frontend':
            payload.update(target=broker.jobs['frontend']['job']['target'],owner=broker.initial['owner'],marker=broker.armed_probe['marker'],
                backendPid=broker.armed_probe['backendPid'],backendStart=broker.armed_probe['backendStart'],targetSha256=self.plan['targetSha256'])
            if profile:
                payload['target']={key:payload['target'][key] for key in ('host','port','database','user','serverMajor')}
            identifier='lash-p2-certification-observer-'+uuid.uuid4().hex
            args=['docker','run','--rm','--name',identifier,'--interactive','--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
                '--memory','128m','--pids-limit','64','--env','FRONTEND_STAGING_MIGRATION_DATABASE_URL','--mount',f'type=bind,src={broker.source/MODULE},dst=/app/p2-known-ack-loss-probe.mjs,readonly',
                '--entrypoint','node',broker.selected['artifacts']['frontendMigration']['image'],'/app/p2-known-ack-loss-probe.mjs']
            environment={**runtime.SAFE_ENV,'FRONTEND_STAGING_MIGRATION_DATABASE_URL':broker.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL']}
        else:
            payload['target']=self.receiver_targets[service]
            payload['selectedUserBindingSha256']=selected_user_binding or self.baseline['frontend']['userBindingSha256']
            require(re.fullmatch(r'[a-f0-9]{64}',payload['selectedUserBindingSha256'] or ''),'P2_KNOWN_ACK_FRONTEND_USER_BINDING_REQUIRED')
            values=runtime.environment_values(migrate.read_input(self.configuration_input,service+'-api.env'),'staging',service+'-api',broker.jobs,**profile)
            identifier='lash-p2-certification-observer-'+uuid.uuid4().hex
            args=['docker','run','--rm','--name',identifier,'--interactive','--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
                '--memory','128m','--pids-limit','64','--env','NODE_ENV=production','--env','DATABASE_TARGET=staging','--env','STAGING_DATABASE_URL',
                '--mount',f'type=bind,src={broker.source/MODULE},dst=/app/p2-known-ack-loss-probe.mjs,readonly',
                '--entrypoint','node',broker.selected['artifacts'][service+'Runtime']['image'],'/app/p2-known-ack-loss-probe.mjs']
            environment={**runtime.SAFE_ENV,'STAGING_DATABASE_URL':values['STAGING_DATABASE_URL']}
        if profile:args[2:2]=['--pull','never']
        try:
            result=self.scope.run(args,env=environment,input=canonical(payload),capture_output=True,timeout=20,check=True)
            require(not result.stderr and 0<len(result.stdout)<=65536,'P2_KNOWN_ACK_PRIVATE_SQL_OUTPUT_REQUIRED')
            value=json.loads(result.stdout)
            require(value.get('status')=='P2_KNOWN_ACK_SQL_CURRENT' and value.get('service')==service and value.get('readOnly') is True,'P2_KNOWN_ACK_PRIVATE_SQL_READBACK_REQUIRED')
            if profile:
                require(type(value.get('version')) is int and value['version']==1 and value.get('commandId')==self.command['commandId'] and
                    (service=='frontend' or value.get('roleOid')==self.receiver_targets[service]['roleOid']),
                    'P2_KNOWN_ACK_PROFILED_SQL_READBACK_REQUIRED')
            self._verify();return value
        finally:
            self.scope.run(['docker','rm','--force',identifier],env=runtime.SAFE_ENV,timeout=15,capture_output=True,check=False)

    def _snapshot(self,allow_pending=False):
        first=self._sql('frontend');receivers={service:self._sql(service,first['userBindingSha256']) for service in ('course','community')};last=self._sql('frontend')
        if first!=last:
            require(allow_pending,'P2_KNOWN_ACK_FRONTEND_CHANGED_DURING_RECEIVER_READ')
            validate_frontend_scope(self.plan,first);validate_frontend_scope(self.plan,last)
            return None
        value={'frontend':first,**receivers}
        validate_backend_idle(value,getattr(self,'baseline',None))
        return value

    def verify_backend_idle(self):
        self._verify()
        value={service:self._sql(service) for service in ('course','community')}
        validate_backend_idle(value,self.baseline)
        return value

    def _retain(self,name,record):
        migrate.private_directory(self.directory)
        migrate.write_json(self.directory,name,{**record,**_profile_record(self.expected_profile)})
        return digest(migrate.read_input(self.directory,name))

    def start_native_window(self):
        self._verify();require(self.deadline is None and self.broker.native_expected is True,'P2_KNOWN_ACK_SOURCE_NATIVE_START_REQUIRED')
        if self.expected_profile is not None:
            require(self.fault_stage.arm_called is True and re.fullmatch(r'[a-f0-9]{64}',self.fault_stage.lease_sha256 or ''),
                'P2_KNOWN_ACK_PROFILED_FAULT_ARM_REQUIRED')
        self.window_started=time.monotonic();self.deadline=self.window_started+self.plan['nativePlan']['windowSeconds']

    def observe_domain(self):
        self._verify();require(self.deadline is not None and time.monotonic()<=self.deadline and self.broker.native_expected is True,'P2_KNOWN_ACK_BOUNDED_NATIVE_WINDOW_REQUIRED')
        gateway=self._gateway();require(_same_process(self.baseline_gateway,gateway),'P2_KNOWN_ACK_OLD_PROCESS_CHANGED')
        effects=self.broker.fault_stage.effects();snapshot=self._snapshot(allow_pending=True)
        after=self._gateway();require(_same_process(gateway,after) and time.monotonic()<=self.deadline,'P2_KNOWN_ACK_WINDOW_OR_PROCESS_CHANGED')
        profile=_profile_record(self.expected_profile)
        if self.expected_profile is not None:
            require(all(type(effect.get('version')) is int and effect['version']==1 and 'qualificationTargetProfile' not in effect and
                effect.get('environment')=='staging' and effect.get('status')=='P2_TRANSPORT_FAULT_INJECTED' and
                effect.get('leaseSha256')==self.fault_stage.lease_sha256 and
                all(effect.get(key)==self.fault_plan[key] for key in ('profile','stageId','candidateSha256','configurationSha256',
                    'gatewayProcessSha256','gatewayImageSha256','mode','receiver')) for effect in effects),
                'P2_KNOWN_ACK_PROFILED_RAW_EFFECT_REQUIRED')
        if snapshot is None:return {**profile,'status':'P2_KNOWN_ACK_DOMAIN_PENDING'}
        value=validate_domain(self.plan,self.baseline,snapshot,gateway,effects)
        if value is None:return {**profile,'status':'P2_KNOWN_ACK_DOMAIN_PENDING'}
        if self.domain is None:
            self.domain={'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','gateway':gateway,'databases':snapshot,'effect':effects[0],**value}
            self.domain_sha256=self._retain('domain.json',self.domain)
        return {**profile,'status':'P2_KNOWN_ACK_DOMAIN_SETTLED_IN_WINDOW','domainSha256':self.domain_sha256}

    def retain_request_details(self,encoded):
        self._verify();require(self.domain is not None and self.request_evidence is None and self.deadline is not None and time.monotonic()<=self.deadline and
            self.broker.native_expected is True,'P2_KNOWN_ACK_IN_WINDOW_REQUEST_DETAILS_REQUIRED')
        from p2_release_broker import decode
        raw,artifact=decode(encoded)
        if self.expected_profile is not None:
            from qualification_target_profile import decode_qualification_target_json
            artifact=decode_qualification_target_json(raw,'carrier')
        # Reuse the existing exact finite schema, source/project/producer/epoch
        # and explicit reviewer checks. Its ordinary all-completed qualification
        # remains false for the deliberately uncertain first request.
        observed=self.broker._request_evidence(encoded,{'operations':self.domain['databases']['frontend']['operations']})
        require(observed['authority']=='operator-recorded-request-details' and observed['artifactSha256']==digest(raw),
            'P2_KNOWN_ACK_ACTUAL_REQUEST_DETAILS_REQUIRED')
        validate_request_operations(self.plan,artifact,self.domain['databases']['frontend']['operations'])
        if self.expected_profile is not None:
            versions=[artifact['version'],*(row['version'] for row in artifact['observations']),
                *(decode_qualification_target_json(row['admittedLogLine'],'carrier')['version'] for row in artifact['observations'])]
            require(all(type(version) is int and version==1 for version in versions),'P2_KNOWN_ACK_ORIGINAL_REQUEST_WIRE_REQUIRED')
        self.request_evidence={'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','artifactSha256':digest(raw),'domainSha256':self.domain_sha256,
            'provenance':observed,'originalArtifact':artifact}
        self.request_sha256=self._retain('request-details.json',self.request_evidence)
        return {**_profile_record(self.expected_profile),'status':'P2_KNOWN_ACK_REQUEST_DETAILS_JOINED','requestDetailsSha256':self.request_sha256}

    def prepare_reconciliation(self):
        self._verify();require(self.domain is not None and self.request_evidence is not None and self.broker.native_expected is False and self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_TIMELY_DOMAIN_PROOF_REQUIRED')
        if self.expected_profile is not None:
            require(self.settlement is None,'P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_ALREADY_PREPARED')
            self._verify_profiled_prefix()
        options={} if self.expected_profile is None else {'require_disarmed':True}
        gateway=self._gateway(**options);actual=self._snapshot()
        require(_same_process(self.baseline_gateway,gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
            actual['frontend']['admission']['newWork'] is False and actual['frontend']['admission']['recovery'] is False,'P2_KNOWN_ACK_CLOSED_SETTLEMENT_REQUIRED')
        proof=validate_domain(self.plan,self.baseline,actual,gateway,[self.domain['effect']],closed=True)
        require(proof is not None and proof['operationId']==self.domain['operationId'],'P2_KNOWN_ACK_EXACT_SETTLEMENT_OPERATION_REQUIRED')
        validate_request_operations(self.plan,self.request_evidence['originalArtifact'],actual['frontend']['operations'])
        if self.expected_profile is not None:
            observed=self.domain['databases'];frontend=actual['frontend']
            require(frontend['admission']['epoch']==str(int(self.window_epoch)+1) and
                frontend['operations']==observed['frontend']['operations'] and
                _delivery_receipts(frontend)==_delivery_receipts(observed['frontend']) and
                all(actual[service]==observed[service] for service in ('course','community')),
                'P2_KNOWN_ACK_PROFILED_IN_WINDOW_RECEIPTS_CHANGED')
            require(self._gateway(**options)==gateway,'P2_KNOWN_ACK_PROFILED_OLD_GATEWAY_CHANGED')
        self.settlement={'status':'P2_KNOWN_ACK_SPECIFIC_OPERATION_SETTLEMENT','recoveryActionId':self.recovery_action_id,'domainSha256':self.domain_sha256,
            'baselineSha256':self.baseline_sha256,'requestDetailsSha256':self.request_sha256,
            'operationId':self.domain['operationId'],'epoch':actual['frontend']['admission']['epoch'],'gateway':gateway,'databases':actual}
        self.settlement_sha256=self._retain('settlement.json',self.settlement)
        return {**_profile_record(self.expected_profile),'operationId':self.domain['operationId'],'epoch':actual['frontend']['admission']['epoch'],
            'evidenceSha256':self.settlement_sha256}

    def _verify_profiled_prefix(self):
        require(digest(migrate.read_input(self.directory,'recovery-intent.json'))==self.intent_receipt_sha256 and
            digest(migrate.read_input(self.broker.directory,'p2-certification-operator-request-details.json'))==self.request_evidence['artifactSha256'],
            'P2_KNOWN_ACK_ORIGINAL_RECEIPT_CHANGED')
        for name,pin in (('baseline.json',self.baseline_sha256),('domain.json',self.domain_sha256),('request-details.json',self.request_sha256)):
            require(digest(migrate.read_input(self.directory,name))==pin,'P2_KNOWN_ACK_ORIGINAL_RECEIPT_CHANGED')

    def confirm_reconciliation(self):
        """Observe the one settled frontend operation under the original held scope."""
        require(self.expected_profile is not None and self.settlement is not None and not self.reconciliation_attempted,
            'P2_KNOWN_ACK_PROFILED_CONFIRMATION_REQUIRED')
        self.reconciliation_attempted=True
        record={**_profile_record(self.expected_profile),'status':'P2_KNOWN_ACK_RECONCILIATION_OBSERVED_FENCED',
            'operationId':self.domain['operationId'],'baselineSha256':self.baseline_sha256,'domainSha256':self.domain_sha256,
            'requestDetailsSha256':self.request_sha256,'settlementSha256':self.settlement_sha256,
            'frontendGlobalClosedZero':True,'oldGatewayUncertain':{'newWork':0,'recovery':1},
            'runtimeReplaced':False,'ordinaryClosedZeroGate':False}
        observation=self._verify_settlement(record)
        observed_sha=self._retain('reconciliation-observed.json',{**record,**observation,'recoveryActionId':self.recovery_action_id,
            'candidateSha256':self.broker.initial['candidateSha256'],'certificationActionId':self.broker.action_id(),
            'recoveryIntentReceiptSha256':self.intent_receipt_sha256,'sourceModuleSha256':self.source_sha256,
            'operatorSourceClosureSha256':self.broker.initial['sourceClosureSha256']})
        self.reconciliation_observed_sha256=observed_sha
        return {**record,'reconciliationObservedSha256':observed_sha}

    def _replacement_record(self):
        return {'version':1,**_profile_record(self.expected_profile),'status':'P2_KNOWN_ACK_REPLACEMENT_AUTHORIZED',
            'recoveryActionId':self.recovery_action_id,'candidateSha256':self.broker.initial['candidateSha256'],
            'originalGateway':self.baseline_gateway,'domainSha256':self.domain_sha256,'settlementSha256':self.settlement_sha256,
            'baselineSha256':self.baseline_sha256,'requestDetailsSha256':self.request_sha256,'sourceModuleSha256':self.source_sha256,
            'recoveryIntentSha256':self.selection['intentSha256'],
            'operatorSourceClosureSha256':self.broker.initial['sourceClosureSha256'],'certificationActionId':self.broker.action_id(),
            'operationId':self.domain['operationId'],'ordinaryClosedZeroGate':False,'sqlReplayAllowed':False,'roleChangeAllowed':False}

    def authorize_replacement(self):
        require(self.expected_profile is None,'P2_KNOWN_ACK_PROFILED_REPLACEMENT_UNAVAILABLE')
        self._verify();require(self.settlement is not None,'P2_KNOWN_ACK_SOURCE_SETTLEMENT_REQUIRED')
        record=self._replacement_record()
        self._verify_authorization(record);self._retain('replacement-authorization.json',record)
        return KnownAckLossRecoveryAuthorization(_ISSUER,self,record)

    def authorize_profiled_replacement(self):
        require(self.expected_profile is not None and self.broker.known_ack_recorder is self and
            self.reconciliation_observed_sha256 is not None and not self.profiled_replacement_attempted,
            'P2_KNOWN_ACK_PROFILED_REPLACEMENT_CONFIRMATION_REQUIRED')
        self.profiled_replacement_attempted=True
        record={**self._replacement_record(),'reconciliationObservedSha256':self.reconciliation_observed_sha256,
            'recoveryIntentReceiptSha256':self.intent_receipt_sha256}
        self._verify_profiled_authorization(record)
        self.profiled_authorization_sha256=self._retain('replacement-authorization.json',record)
        return KnownAckLossRecoveryAuthorization(_PROFILED_ISSUER,self,record)

    def _verify_profiled_authorization(self,record):
        require(self.expected_profile is not None and self.broker.known_ack_recorder is self and
            digest(migrate.read_input(self.directory,'reconciliation-observed.json'))==
            record['reconciliationObservedSha256']==self.reconciliation_observed_sha256,
            'P2_KNOWN_ACK_PROFILED_RECONCILIATION_CHANGED')
        self._verify_settlement(record)

    def _verify_authorization(self,record):
        require(self.expected_profile is None,'P2_KNOWN_ACK_PROFILED_REPLACEMENT_UNAVAILABLE')
        self._verify_settlement(record)

    def _verify_settlement(self,record):
        self._verify();require(self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_NATIVE_OFF_REQUIRED')
        if self.expected_profile is not None:
            require(self.broker.native_expected is False,'P2_KNOWN_ACK_NATIVE_OFF_REQUIRED')
            self._verify_profiled_prefix()
        require(json.loads(migrate.read_input(self.directory,'recovery-intent.json'))==self.selection,'P2_KNOWN_ACK_RECOVERY_INTENT_CHANGED')
        for name,key in (('baseline.json','baselineSha256'),('domain.json','domainSha256'),('request-details.json','requestDetailsSha256'),('settlement.json','settlementSha256')):
            require(digest(migrate.read_input(self.directory,name))==record[key],'P2_KNOWN_ACK_ORIGINAL_RECEIPT_CHANGED')
        options={} if self.expected_profile is None else {'require_disarmed':True}
        gateway=self._gateway(**options);actual=self._snapshot()
        require(_same_process(self.baseline_gateway,gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
            _zero(gateway['admission']['active']) and gateway['admission']['uncertain']=={'newWork':0,'recovery':1},
            'P2_KNOWN_ACK_GLOBAL_ZERO_AND_OLD_ONE_REQUIRED')
        self._verify_settled_snapshot(record,actual)
        if self.expected_profile is not None:
            require(self._gateway(**options)==gateway,'P2_KNOWN_ACK_PROFILED_OLD_GATEWAY_CHANGED')
        return {'gateway':gateway,'databases':actual}

    def _verify_settled_snapshot(self,record,actual):
        front=actual['frontend'];admission=front['admission']
        require(admission['newWork'] is False and admission['recovery'] is False and admission['active']==admission['uncertain']==0,
            'P2_KNOWN_ACK_GLOBAL_ZERO_AND_OLD_ONE_REQUIRED')
        selected=[row for row in front['operations'] if row['id']==record['operationId']]
        require(len(selected)==1 and selected[0]['state']=='completed' and selected[0]['reconciliation_sha256']==record['settlementSha256'],'P2_KNOWN_ACK_SPECIFIC_SETTLED_OPERATION_REQUIRED')
        validate_settled(self.plan,self.settlement['databases'],actual,record['operationId'],record['settlementSha256'])
        if self.expected_profile is not None:
            require(_delivery_receipts(front)==_delivery_receipts(self.settlement['databases']['frontend']),
                'P2_KNOWN_ACK_PROFILED_IN_WINDOW_RECEIPTS_CHANGED')


def replacement_intent(cert,recovery_action_id,*,expected_profile=None):
    """Fixed source projection displayed before apply, never a policy override."""
    expected=migrate.profile_context(expected_profile)
    vercel.require_record_profile(expected,cert,cert['nativePlan'])
    return {'version':1,**_profile_record(expected),'recoveryActionId':recovery_action_id,'certificationActionId':cert['certificationActionId'],
        **{key:cert[key] for key in ('candidateSha256','sourceCommit','operatorSourceCommit','targetSha256','configurationSha256','gatewayProcessSha256','runtimeInventorySha256','operatorSourceClosureSha256')},
        'configurationInputDirectory':cert['knownAckConfigurationInputDirectory'],'nativePlanSha256':cert['nativePlan']['planSha256'],'receiverTargetsSha256':digest(canonical(cert['knownAckReceiverTargets'])),
        'profile':'known-ack-same-session-ordered-replacement-v1','runtimeReplacements':1,'nativeWindowSeconds':cert['nativePlan']['windowSeconds'],
        'sqlReplayAllowed':False,'roleChangeAllowed':False,'ordinaryClosedZeroGate':False,'automaticFailureRecoveryAllowed':False}


def validate_known_configuration_input(directory,mounted,selected,jobs,expected,*,expected_profile=None):
    """Current P2 snapshot_configuration copies every selected byte unchanged.

    Earlier restoration transforms, if any, must already have their retained
    root-owned configuration-input output. This mode never normalizes a raw
    historical input or trusts a caller equivalence assertion.
    """
    import staging_state
    directory=Path(directory)
    require(directory.is_absolute() and ROOT in directory.parents and directory==directory.resolve() and
        not any(path.is_symlink() for path in (directory,*directory.parents)),'P2_KNOWN_ACK_REVIEWED_ROOT_CONFIGURATION_INPUT_REQUIRED')
    options={} if expected_profile is None else {'expected_profile':expected_profile}
    runtime.validate_snapshot_source(directory,selected,jobs,**options)
    require(staging_state.configuration_hashes(directory)==expected==staging_state.configuration_hashes(mounted),
        'P2_KNOWN_ACK_RENDERED_CONFIGURATION_BYTES_DIFFER')
    return directory


def validate_backend_idle(snapshot,baseline=None):
    fields={'course':{'outbox','snapshots','media','exports','retention'},
        'community':{'repairs','reconciliations','exports','reconciliationSchedule','retentionSchedule'}}
    projections={'course':{'control','outbox','operations','snapshots','snapshotItems','streams','media','exports','lifecycleCommands','lifecycleStates'},
        'community':{'repairs','reconciliations','operations','projections','inbox','tombstones','baselines','sourceItems','exports','lifecycleCommands','lifecycleStates'}}
    for service,expected in fields.items():
        value=snapshot[service].get('backend')
        require(isinstance(value,dict) and set(value)=={'version','status','deadline','eligible','rowCounts','snapshotSha256','selectedLifecycleCommand','selectedLifecycleState'} and
            value['version']==1 and value['status']=='P2_KNOWN_ACK_BACKEND_OBSERVED' and isinstance(value['deadline'],str) and
            set(value['eligible'])==expected and all(type(count) is int and count==0 for count in value['eligible'].values()) and
            set(value['rowCounts'])==projections[service] and all(type(count) is int and 0<=count<=1000 for count in value['rowCounts'].values()) and
            re.fullmatch(r'[a-f0-9]{64}',value['snapshotSha256'] or ''),'P2_KNOWN_ACK_UNRELATED_BACKEND_WORK_REFUSED')
        if baseline is not None:
            before=baseline[service]['backend'];changing={'selectedLifecycleCommand','selectedLifecycleState'}
            require({key:item for key,item in value.items() if key not in changing}=={key:item for key,item in before.items() if key not in changing},'P2_KNOWN_ACK_BACKEND_PROJECTION_CHANGED')
            known,state=value['selectedLifecycleCommand'],value['selectedLifecycleState']
            if known is None:require(snapshot[service]['command'] is None and state==before['selectedLifecycleState'],'P2_KNOWN_ACK_UNDECLARED_SELECTED_STATE_CHANGED')
            else:
                command=snapshot[service]['command']
                front=snapshot.get('frontend',baseline['frontend'])
                require(command is not None and known=={'commandId':front['commandId'],'userBindingSha256':command['userBindingSha256'],
                    'accountVersion':command['accountVersion'],'action':'suspend','commandSha256':command['commandSha256'],'acceptedAt':command['acceptedAt']} and
                    isinstance(state,dict) and set(state)=={'userBindingSha256','accountVersion','status','updatedAt'} and state['userBindingSha256']==command['userBindingSha256'] and
                    state['accountVersion']==command['accountVersion'] and state['status']=='suspended' and state['updatedAt']==known['acceptedAt'],
                    'P2_KNOWN_ACK_SELECTED_SOURCE_TRANSITION_REQUIRED')


def validate_baseline(plan,snapshot):
    validate_backend_idle(snapshot)
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
        admission['newWork'] is False and admission['active'] in (0,1) and admission['uncertain'] in (0,1) and len(operations)<=2 and len({row['id'] for row in operations})==len(operations),
        'P2_KNOWN_ACK_UNRELATED_EFFECT_REFUSED')
    require(all(row['producer_sha256']==native['producer']['producerSha256'] and row['source_sha']==native['sourceCommit'] and row['role_oid']==native['producer']['role']['oid'] and
        row['epoch']==str(int(native['initialEpoch'])+1) and row['kind']=='recovery' and row['state'] in ('active','uncertain','completed') and row['reconciliation_sha256'] is None for row in operations),
        'P2_KNOWN_ACK_UNRELATED_OPERATION_REFUSED')
    require(sum(row['state']=='active' for row in operations)==admission['active'] and sum(row['state']=='uncertain' for row in operations)==admission['uncertain'],
        'P2_KNOWN_ACK_GLOBAL_OPERATION_SCOPE_REQUIRED')


def validate_request_operations(plan,artifact,operations):
    require(isinstance(artifact,dict) and isinstance(artifact.get('observations'),list) and len(operations)==2 and
        sorted(row['state'] for row in operations)==['completed','uncertain'],'P2_KNOWN_ACK_REQUEST_ARTIFACT_REQUIRED')
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
    validate_backend_idle(actual,before);validate_receiver_set(plan,actual)
    front=actual['frontend'];prior=before['frontend']
    require(prior['admission']['active']==0 and prior['admission']['uncertain']==1 and
        front['admission']=={**prior['admission'],'uncertain':0} and front['admission']['newWork'] is False and front['admission']['recovery'] is False and
        all(front[key]==prior[key] for key in ('commandId','accountVersion','accountStatus','commandSha256','userBindingSha256')) and
        all(actual[service]==before[service] for service in ('course','community')),'P2_KNOWN_ACK_SETTLED_CONTEXT_CHANGED')
    old=prior['operations'];rows=front['operations']
    require(len(old)==len(rows)==2 and sorted(row['state'] for row in old)==['completed','uncertain'] and
        sum(row['id']==operation_id for row in old)==1 and len({row['id'] for row in rows})==len(rows) and {row['id'] for row in rows}=={row['id'] for row in old},
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
    validate_baseline(plan,baseline);validate_backend_idle(snapshot,baseline);validate_frontend_scope(plan,front)
    require(gateway['admission']['newWork'] is False and gateway['admission']['active']['newWork']==0 and gateway['admission']['active']['recovery'] in (0,1) and gateway['admission']['uncertain'] in ({'newWork':0,'recovery':0},{'newWork':0,'recovery':1}) and
        front['exports']==front['later']==0 and len(effects)<=1 and len(operations)<=4,'P2_KNOWN_ACK_UNRELATED_EFFECT_REFUSED')
    require(admission['recovery'] is (not closed) and gateway['admission']['recovery'] is (not closed),'P2_KNOWN_ACK_STAGE_STATE_REQUIRED')
    require(all(row['producer_sha256']==native['producer']['producerSha256'] and row['source_sha']==native['sourceCommit'] and row['role_oid']==native['producer']['role']['oid'] and
        row['epoch']==str(int(native['initialEpoch'])+1) and row['kind']=='recovery' and row['reconciliation_sha256'] is None for row in operations),'P2_KNOWN_ACK_UNRELATED_OPERATION_REFUSED')
    unknown=[row for row in operations if row['state']=='uncertain'];completed=[row for row in operations if row['state']=='completed']
    if admission['active'] or not _zero(gateway['admission']['active']) or not effects or not unknown or not completed:return None
    require(len(unknown)==len(completed)==1 and len(operations)==2 and admission['uncertain']==1 and gateway['admission']['uncertain']=={'newWork':0,'recovery':1},'P2_KNOWN_ACK_EXACT_ONE_REQUIRED')
    effect=effects[0]
    require(effect['mode']=='drop-after-ack' and effect['receiver']==plan['receiver'] and effect['sourceWitnessSha256']==plan['commandSha256'] and effect['upstreamReceiptVerified'] is True and
        effect['upstreamStarted'] is True and effect['upstreamStatus']==200 and effect['downstreamBytesStarted'] is False and
        effect['downstreamDisposition']=='dropped-before-any-response-bytes','P2_KNOWN_ACK_EXACT_TYPED_EFFECT_REQUIRED')
    if front['outstanding']:return None
    validate_receiver_set(plan,snapshot)
    require(any(row['started_at']>unknown[0]['started_at'] and row['completed_at'] is not None for row in completed),'P2_KNOWN_ACK_NORMAL_REPLAY_OPERATION_REQUIRED')
    return {'operationId':unknown[0]['id']}


def _private_environment(values):
    require(isinstance(values,list) and all(isinstance(value,str) and '=' in value for value in values),'P2_KNOWN_ACK_CONTAINER_ENVIRONMENT_REQUIRED')
    parsed=[value.split('=',1) for value in values]
    require(len({key for key,_ in parsed})==len(parsed),'P2_KNOWN_ACK_DUPLICATE_CONTAINER_ENVIRONMENT')
    return dict(parsed)


class KnownAckLossBoundary:
    """One exact source transition, never an ordinary zero boundary.

    All process commands remain registered with the original certification
    scope. Docker environment bytes stay private and are never receipt hashes.
    """
    def __init__(self,issuer,broker,authorization):
        profiled=type(self) is ProfiledKnownAckLossBoundary
        require(issuer is (_PROFILED_BOUNDARY_ISSUER if profiled else _BOUNDARY_ISSUER),'P2_KNOWN_ACK_BOUNDARY_SOURCE_REQUIRED')
        self.broker,self.parent=broker,broker.scope
        self.recorder=broker.known_ack_recorder
        self.expected_profile=self.recorder.expected_profile if profiled else None
        self.action=self.recorder.recovery_action_id
        self.record=(_consume_authorization(authorization,self.parent,self.action,_PROFILED_ISSUER,recorder=self.recorder)
            if profiled else consume_known_ack_loss_authorization(authorization,self.parent,self.action))
        self.selected,self.jobs=copy.deepcopy(broker.selected),copy.deepcopy(broker.jobs)
        self.old_configuration=broker.configuration
        self.input_configuration=self.recorder.configuration_input
        prefix='p2-profiled-known-ack-' if profiled else 'p2-certification-'
        self.output=ROOT/(prefix+self.action)
        self.runtime_output=self.output/'runtime-known-ack'
        self.snapshot=self.runtime_output/'configuration'
        self.snapshot_bound=False
        self.compose_bytes=migrate.read_input(broker.source,'ops/platform/compose.yaml')
        require(self.selected['runtime']['composeSha256']=='sha256:'+digest(self.compose_bytes),'P2_KNOWN_ACK_EXACT_COMPOSE_SOURCE_REQUIRED')
        self.initial={key:copy.deepcopy(broker.initial[key]) for key in ('candidateSha256','hostMachineId','configurationSha256')}
        self.initial['recoveryActionId']=self.action
        if profiled:
            self.initial.update(_profile_record(self.expected_profile))
            require(len({self.old_configuration,self.input_configuration,self.snapshot})==3,
                'P2_KNOWN_ACK_DISTINCT_SOURCE_CONFIGURATION_REQUIRED')
            self.authorization_raw_sha256=digest(migrate.read_input(self.recorder.directory,'replacement-authorization.json'))
            require(self.authorization_raw_sha256==self.recorder.profiled_authorization_sha256,'P2_KNOWN_ACK_PROFILED_AUTHORIZATION_BYTES_CHANGED')
            self.stage_receipt_sha256={}
            self.runtime_attempted=False
        self.output.mkdir(mode=0o700)
        self.runtime_output.mkdir(mode=0o700)
        self.command=_source_command(self.parent)
        self.old_gateway=copy.deepcopy(self.recorder._gateway())
        if profiled:
            from p2_prior_gateway import _closed_observed
            require(_same_process(self.old_gateway,self.record['originalGateway']) and _closed_observed(self.old_gateway) and
                _zero(self.old_gateway['admission']['active']) and self.old_gateway['admission']['uncertain']=={'newWork':0,'recovery':1},
                'P2_KNOWN_ACK_PROFILED_OLD_ONE_CHANGED')
        self.stage_index=0;self.stage_active=None;self.stage_deadline=None;self.finished=False
        self.gateway_frontier_ready=False;self.gateway_started_sha256=None;self.pending_lineage=None;self.running_lineage=None
        self.started=False;self.new_gateway=None;self.new_rows={};self.new_metadata={}
        self.mutex=threading.RLock();self.expected_environments={};self.image_ids={}
        self.old_rows={row['service']:copy.deepcopy(row) for row in broker.runtime_current}
        self.old_metadata={};self._cache_environment(self.old_configuration)
        for service,row in self.old_rows.items():
            actual=self._inspect(row['containerId']);self._validate_container(actual,service,self.old_configuration,healthy=True)
            expected=next(value for value in broker.process_snapshot if value['service']==service)
            require(str(actual['State']['Pid'])==expected['pid'] and actual['State']['StartedAt']==expected['startedAt'],
                'P2_KNOWN_ACK_ORIGINAL_PROCESS_CHANGED')
            self.old_metadata[service]=self._public_process(actual)
        if profiled:
            require(self.old_metadata['gateway']==self.old_gateway['process'],'P2_KNOWN_ACK_PROFILED_OLD_GATEWAY_IDENTITY_REQUIRED')
        _BOUNDARIES.add(self)
        self._retain_stage('known-ack-replacement-intent.json',{'status':'P2_KNOWN_ACK_ORDERED_REPLACEMENT_INTENT',
            'authorization':self.record,'recoveryIntent':self.recorder.selection,'oldProcesses':self.old_metadata,
            'stages':[list(value) for value in runtime.STAGES],'unavailableStages':[list(value) for value in UNAVAILABLE_STAGES],
            **({'authorizationRawSha256':self.authorization_raw_sha256,'configurationSha256':self.initial['configurationSha256'],
                'configurationPaths':{'input':str(self.input_configuration),'oldMounted':str(self.old_configuration),'newMounted':str(self.snapshot)}} if profiled else {})})

    def _retain_stage(self,name,record):
        profile=_profile_arguments(self)
        fields={} if not profile else {**_profile_record(self.expected_profile),'candidateSha256':self.record['candidateSha256'],
            'recoveryActionId':self.action}
        value={**record,**fields}
        migrate.write_json(self.output,name,value)
        if profile:
            raw=migrate.read_input(self.output,name)
            require(json.loads(raw)==value,'P2_KNOWN_ACK_PROFILED_STAGE_READBACK_REQUIRED')
            self.stage_receipt_sha256[name]=digest(raw)

    def _read_json(self,args,env=runtime.SAFE_ENV,timeout=15):
        value=self.parent.run(args,env=env,timeout=timeout,capture_output=True,check=True)
        require(not value.stderr and 0<len(value.stdout)<=2_000_000,'P2_KNOWN_ACK_PRIVATE_DOCKER_READ_REQUIRED')
        return json.loads(value.stdout)

    def _inspect(self,identifier):
        require(re.fullmatch(r'[a-f0-9]{12,64}',identifier or ''),'P2_KNOWN_ACK_EXACT_CONTAINER_ID_REQUIRED')
        return self._read_json(['docker','inspect','--format','{{json .}}',identifier])

    def _cache_environment(self,configuration):
        if str(configuration) in self.expected_environments:return
        env=runtime.runtime_environment(self.selected,configuration,**_profile_arguments(self))
        model=self._read_json([*runtime.compose_command(configuration,'staging'),'config','--format','json'],env)
        require(set(model.get('services',{}))==set(runtime.SERVICES),'P2_KNOWN_ACK_EXACT_COMPOSE_SERVICES_REQUIRED')
        values={}
        for service in runtime.SERVICES:
            image=self.selected['artifacts'][runtime.IMAGE_KEYS[service]]['image']
            image_record=self._read_json(['docker','image','inspect','--platform','linux/amd64','--format','{{json .}}',image])
            self.image_ids[image]=image_record['Id'];image_values=image_record['Config'].get('Env') or []
            configured=model['services'][service].get('environment') or {}
            require(isinstance(configured,dict) and all(isinstance(key,str) and isinstance(value,str) for key,value in configured.items()),'P2_KNOWN_ACK_SOURCE_ENVIRONMENT_REQUIRED')
            values[service]={**_private_environment(image_values or []),**configured}
        self.expected_environments[str(configuration)]=values

    @staticmethod
    def _public_process(value):
        return {'containerId':value['Id'],'imageId':value['Image'],'pid':value['State']['Pid'],'startedAt':value['State']['StartedAt'],
            'restartCount':value['RestartCount'],'running':value['State']['Running']}

    def _validate_container(self,value,service,configuration,healthy):
        expected=self.selected['artifacts'][runtime.IMAGE_KEYS[service]]['image']
        require(value['Config']['Image']==expected and value['Image']==self.image_ids[expected] and value['HostConfig']['ReadonlyRootfs'] is True and
            value['Config']['Labels'].get('com.docker.compose.project')=='lash-her-staging' and value['Config']['Labels'].get('com.docker.compose.service')==service and
            _private_environment(value['Config']['Env'])==self.expected_environments[str(configuration)][service],
            'P2_KNOWN_ACK_IMAGE_ENVIRONMENT_OR_SERVICE_DRIFT')
        mounted={}
        for mount in value['Mounts']:
            destination=mount.get('Destination')
            if mount.get('Type')=='tmpfs' and destination=='/tmp':continue
            require(destination not in mounted and destination in MOUNTS.get(service,{}) and mount.get('Type')=='bind' and mount.get('RW') is False and
                mount.get('Source')==str(configuration/MOUNTS[service][destination]),'P2_KNOWN_ACK_RUNTIME_MOUNT_DRIFT')
            mounted[destination]=mount['Source']
        require(set(mounted)==set(MOUNTS.get(service,{})),'P2_KNOWN_ACK_RUNTIME_MOUNT_MISSING')
        if healthy:
            health=(value['State'].get('Health') or {}).get('Status','none')
            require(value['State']['Running'] is True and type(value['State']['Pid']) is int and value['State']['Pid']>0 and
                health==('none' if service.endswith('-tls') else 'healthy'),'P2_KNOWN_ACK_RUNTIME_NOT_HEALTHY')

    def _inventory(self):
        raw=self.parent.run(['docker','container','ls','--all','--filter','label=com.docker.compose.project=lash-her-staging',
            '--format','{{.ID}}|{{.Label "com.docker.compose.service"}}'],env=runtime.SAFE_ENV,timeout=15,capture_output=True,check=True)
        require(not raw.stderr and len(raw.stdout)<=32768,'P2_KNOWN_ACK_FINITE_RUNTIME_INVENTORY_REQUIRED')
        grouped={service:[] for service in runtime.SERVICES}
        for line in raw.stdout.decode().splitlines():
            fields=line.split('|');require(len(fields)==2 and fields[1] in grouped,'P2_KNOWN_ACK_UNEXPECTED_RUNTIME_SERVICE')
            grouped[fields[1]].append(fields[0])
        return grouped

    def verify(self):
        with self.mutex:
            profile=_profile_arguments(self)
            require(self in _BOUNDARIES and self.broker.scope is self.parent and self.broker.known_ack_recorder is self.recorder,'P2_KNOWN_ACK_SOURCE_BOUNDARY_CHANGED')
            self.parent.require_release(self.selected,self.jobs);self.parent.require_configuration(self.old_configuration);self.parent.require_configuration(self.input_configuration)
            require(migrate.read_input(self.broker.source,'ops/platform/compose.yaml')==self.compose_bytes,'P2_KNOWN_ACK_COMPOSE_SOURCE_CHANGED')
            if self.snapshot_bound:
                self.parent.require_configuration(self.snapshot)
                require(migrate.read_input(self.snapshot,'compose.yaml')==self.compose_bytes,'P2_KNOWN_ACK_RENDERED_COMPOSE_CHANGED')
            if hasattr(self,'stopped_sha256'):
                import p2_prior_gateway as prior
                require(digest(migrate.read_input(self.output,prior.STOPPED))==self.stopped_sha256 and
                    digest(migrate.read_input(self.output,prior.BEFORE_STOP))==self.before_stop_sha256,'P2_KNOWN_ACK_STOP_RECEIPT_CHANGED')
            if self.gateway_started_sha256 is not None:
                require(digest(migrate.read_input(self.output,GATEWAY_STARTED))==self.gateway_started_sha256,'P2_KNOWN_ACK_GATEWAY_START_MARKER_CHANGED')
            frontend=self.broker.observer.probe('observe');actual=frontend['admission']
            require(actual['newWork'] is False and actual['recovery'] is False and actual['active']==actual['uncertain']==0 and
                actual['epoch']==self.recorder.settlement['epoch'],'P2_KNOWN_ACK_PHYSICAL_CLOSED_ZERO_REQUIRED')
            if profile:
                self.recorder._verify_profiled_context()
                vercel.require_record_profile(self.expected_profile,frontend)
                require(self.broker.known_ack_boundary is self and frontend['journalSha256']==self.parent.receipt['journalSha256'] and
                    frontend['targetSha256']==self.recorder.plan['targetSha256'] and
                    digest(migrate.read_input(self.recorder.directory,'replacement-authorization.json'))==self.authorization_raw_sha256,
                    'P2_KNOWN_ACK_PROFILED_FRONTEND_OR_AUTHORITY_CHANGED')
                for name,pin in self.stage_receipt_sha256.items():
                    require(digest(migrate.read_input(self.output,name))==pin,'P2_KNOWN_ACK_PROFILED_STAGE_RECEIPT_CHANGED')
            require(self.stage_active is None or time.monotonic()<self.stage_deadline,'P2_KNOWN_ACK_RUNTIME_STAGE_EXPIRED')
            inventory=self._inventory()
            for service,ids in inventory.items():
                active=self.stage_active is not None and service in self.stage_active
                expected=self.new_rows.get(service,self.old_rows[service]);metadata=self.new_metadata.get(service,self.old_metadata[service])
                if not active:require(ids==[expected['containerId']] or len(ids)==1 and expected['containerId'].startswith(ids[0]),'P2_KNOWN_ACK_UNRELATED_RUNTIME_ID_DRIFT')
                else:require(len(ids)<=2,'P2_KNOWN_ACK_EXTRA_TRANSITION_REPLICA')
                for identifier in ids:
                    value=self._inspect(identifier);old=value['Id']==self.old_rows[service]['containerId']
                    configuration=self.old_configuration if old else self.snapshot
                    self._validate_container(value,service,configuration,healthy=not active)
                    observed=self._public_process(value)
                    if not active:require(observed==metadata,'P2_KNOWN_ACK_UNRELATED_PROCESS_DRIFT')
                    elif old:require(all(observed[key]==self.old_metadata[service][key] for key in ('containerId','imageId','startedAt','restartCount')),
                        'P2_KNOWN_ACK_OLD_TRANSITION_PROCESS_DRIFT')
                    else:require(observed['restartCount']==0,'P2_KNOWN_ACK_NEW_PROCESS_RESTARTED')
            import p2_prior_gateway as prior
            if self.finished:
                gateway=prior.observe_prior_gateway(self.initial,self.selected,self.parent.verify,self.command,**profile)
                require(_same_process(gateway,self.new_gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
                    _zero(gateway['admission']['active']) and _zero(gateway['admission']['uncertain']),'P2_KNOWN_ACK_NEW_GATEWAY_DRIFT')
                require(prior._read_lineage()==self.running_lineage,'P2_KNOWN_ACK_NEW_RUNNING_LINEAGE_CHANGED')
            elif self.stage_active!=('gateway',):
                gateway=prior.observe_prior_gateway(self.initial,self.selected,self.parent.verify,self.command,**profile)
                require(_same_process(gateway,self.old_gateway) and gateway['admission']['newWork'] is False and gateway['admission']['recovery'] is False and
                    _zero(gateway['admission']['active']) and gateway['admission']['uncertain']=={'newWork':0,'recovery':1},'P2_KNOWN_ACK_OLD_ONE_CHANGED')
            elif hasattr(self,'stopped_sha256'):
                require(self.gateway_frontier_ready and self.gateway_started_sha256 is not None and prior._read_lineage()==self.pending_lineage,
                    'P2_KNOWN_ACK_PENDING_REPLACEMENT_REQUIRED')

    def bind_snapshot(self,snapshot):
        with self.mutex:
            self.verify();require(not self.snapshot_bound and not self.started and snapshot==self.snapshot,'P2_KNOWN_ACK_EXACT_NEW_SNAPSHOT_REQUIRED')
            self.parent.require_configuration(snapshot)
            require(migrate.read_input(snapshot,'compose.yaml')==self.compose_bytes,'P2_KNOWN_ACK_RENDERED_COMPOSE_CHANGED')
            self.snapshot_bound=True;self.verify()

    def before_stage(self,stage):
        with self.mutex:
            profile=_profile_arguments(self)
            self.verify();require(self.snapshot_bound and self.stage_active is None and self.stage_index<len(runtime.STAGES) and tuple(stage)==runtime.STAGES[self.stage_index] and not self.finished,
                'P2_KNOWN_ACK_FIXED_STAGE_ORDER_REQUIRED')
            self.recorder.verify_backend_idle()
            self._cache_environment(self.snapshot)
            with self.broker.native_mutex:
                require(self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_PRESTAGE_FULL_PROFILE_REQUIRED')
            self.stage_active=tuple(stage);self.stage_deadline=time.monotonic()+120;self.started=True
            self._retain_stage('known-ack-stage-'+str(self.stage_index)+'-intent.json',{'status':'P2_KNOWN_ACK_RUNTIME_STAGE_INTENT','stage':list(stage),
                'recoveryActionId':self.action,'maximumSeconds':120,'candidateSha256':self.record['candidateSha256'],'authorizationReceiptSha256':digest(canonical(self.record))})
            if tuple(stage)==('gateway',):
                import p2_prior_gateway as prior
                self.before_stop=prior.capture_before_stop(self.initial,self.selected,self.output,self.parent.verify,self.command,**profile)
                require(self.before_stop['status']=='PRIOR_GATEWAY_PRESTOP_OBSERVED' and _same_process(self.old_gateway,self.before_stop['observation']) and
                    self.before_stop['observation']['admission']['uncertain']=={'newWork':0,'recovery':1} and _zero(self.before_stop['observation']['admission']['active']),
                    'P2_KNOWN_ACK_ORIGINAL_ONE_PRESTOP_REQUIRED')
                if profile:
                    vercel.require_record_profile(self.expected_profile,self.before_stop)
                    require(prior._closed_observed(self.before_stop['observation']) and self.before_stop['actionId']==self.action and
                        self.before_stop['candidateSha256']==self.initial['candidateSha256'],
                        'P2_KNOWN_ACK_PROFILED_PRESTOP_CLOSED_REQUIRED')
                self.parent.run(['docker','stop','--time','10',self.old_gateway['process']['containerId']],env=runtime.SAFE_ENV,timeout=30,capture_output=True,check=True)
                stopped=prior.retain_ordered_stop(self.before_stop,self.output,self.parent.verify,self.command,**profile)
                require(stopped['status']=='PRIOR_GATEWAY_ORDERED_STOP_OBSERVED','P2_KNOWN_ACK_ORDERED_STOP_REQUIRED')
                if profile:
                    vercel.require_record_profile(self.expected_profile,stopped)
                    require(stopped['actionId']==self.action and stopped['candidateSha256']==self.initial['candidateSha256'],
                        'P2_KNOWN_ACK_PROFILED_STOP_BINDING_REQUIRED')
                self.stopped_initial={**self.initial,'priorGatewayReference':{'kind':'stopped-current-candidate','stopReceiptDirectory':str(self.output),
                    'stopReceiptSha256':digest(migrate.read_input(self.output,prior.STOPPED))}}
                observed=prior.observe_stopped_prior_gateway(self.stopped_initial,self.selected,self.parent.verify,self.command,**profile)
                require(_same_process(self.old_gateway,observed) and observed['admission']['uncertain']=={'newWork':0,'recovery':1},'P2_KNOWN_ACK_STOPPED_ONE_RECEIPT_REQUIRED')
                self.stopped_sha256=digest(migrate.read_input(self.output,prior.STOPPED));self.before_stop_sha256=digest(migrate.read_input(self.output,prior.BEFORE_STOP))
                self.stop_lineage=prior._read_lineage()
                require(isinstance(self.stop_lineage,dict) and self.stop_lineage.get('state')=='stopped-observed','P2_KNOWN_ACK_SOURCE_STOP_LINEAGE_REQUIRED')
                # This durable frontier precedes return to the inherited Compose
                # up. An uncertain write/ACK can never be read as old stopped1.
                prior._remember(self.initial,self.old_gateway,'replacement-in-progress',expectedCandidateSha256=self.initial['candidateSha256'])
                pending=prior._read_lineage()
                require(pending=={'protocol':prior.PROTOCOL,'state':'replacement-in-progress','actionId':self.action,
                    'candidateSha256':self.initial['candidateSha256'],'process':self.old_gateway['process'],'binding':self.old_gateway['binding'],
                    'expectedCandidateSha256':self.initial['candidateSha256']},'P2_KNOWN_ACK_PENDING_LINEAGE_READBACK_REQUIRED')
                self.pending_lineage=copy.deepcopy(pending)
                helper_sha=digest(migrate.read_input(self.broker.source,HOST_MODULE))
                require(helper_sha==self.broker.initial['sourceSha256'][HOST_MODULE],'P2_KNOWN_ACK_INSTALLED_HELPER_REQUIRED')
                marker={'version':1,'status':'P2_KNOWN_ACK_GATEWAY_REPLACEMENT_STARTED',
                    'recoveryActionId':self.action,'candidateSha256':self.initial['candidateSha256'],
                    'operatorSourceClosureSha256':self.record['operatorSourceClosureSha256'],'sourceModuleSha256':helper_sha,
                    'authorizationReceiptSha256':digest(canonical(self.record)),'beforeStopSha256':self.before_stop_sha256,'orderedStopSha256':self.stopped_sha256,
                    'oldProcess':self.old_gateway['process'],'oldBinding':self.old_gateway['binding'],'sourceStopLineage':self.stop_lineage,'pendingLineage':pending}
                if profile:marker.update(_profile_record(self.expected_profile))
                self._retain_stage(GATEWAY_STARTED,marker)
                marker_raw=migrate.read_input(self.output,GATEWAY_STARTED)
                require(json.loads(marker_raw)==marker,'P2_KNOWN_ACK_GATEWAY_START_READBACK_REQUIRED')
                self.gateway_started_sha256=digest(marker_raw)
                self.gateway_frontier_ready=True;self.verify()

    def verify_healthy_boundary(self):
        # Only these literal, actively held stages can interrupt the catalog.
        # A failed full probe never selects this branch.
        with self.mutex:
            profile=_profile_arguments(self)
            self.verify()
            self.recorder.verify_backend_idle()
            with self.broker.native_mutex:
                if self.stage_active in UNAVAILABLE_STAGES:
                    import p2_lifecycle_native as native
                    import frontend_probe
                    from frontend_release_adapters import LockedClient
                    context=self.broker._native_context();plan=context['plan']
                    identity=self.broker._probe_identity() if profile else {'environment':'staging','projectId':plan['projectId'],
                        'sourceCommit':plan['sourceCommit'],'releaseId':plan['actionId']}
                    private=frontend_probe._private_input(Path(context['privateProbeDirectory']),identity,**profile)
                    require(private==self.broker.initial['privateProbe'],'P2_KNOWN_ACK_ORIGINAL_PROBE_CHANGED')
                    observed=native.observe_metadata(context,LockedClient(self.broker.vercel,self.broker.check),**profile)
                else:observed=self.broker._native_observe()
                require(observed['nativeEnabled'] is False,'P2_KNOWN_ACK_NATIVE_MUST_REMAIN_OFF')
            return {'stage':list(self.stage_active) if self.stage_active is not None else None,'stageIndex':self.stage_index,
                'catalogUnavailableStage':self.stage_active in UNAVAILABLE_STAGES,'nativeEnabled':False}

    def after_stage(self,stage):
        with self.mutex:
            profile=_profile_arguments(self)
            require(self.stage_active==tuple(stage) and time.monotonic()<self.stage_deadline,'P2_KNOWN_ACK_FINITE_STARTED_STAGE_REQUIRED')
            inventory=self._inventory()
            for service in stage:
                require(len(inventory[service])==1,'P2_KNOWN_ACK_EXACT_NEW_REPLICA_REQUIRED')
                value=self._inspect(inventory[service][0]);self._validate_container(value,service,self.snapshot,healthy=True)
                require(value['Id']!=self.old_rows[service]['containerId'] and value['RestartCount']==0,'P2_KNOWN_ACK_DIFFERENT_NEW_PROCESS_REQUIRED')
                self.new_rows[service]={'service':service,'containerId':value['Id'],'image':value['Config']['Image'],
                    'health':(value['State'].get('Health') or {}).get('Status','none')}
                self.new_metadata[service]=self._public_process(value)
            if tuple(stage)==('gateway',):
                import p2_prior_gateway as prior
                actual=prior.observe_prior_gateway(self.initial,self.selected,self.parent.verify,self.command,**profile)
                require(actual['process']['containerId']!=self.old_gateway['process']['containerId'] and actual['binding']['configurationDirectory']==str(self.snapshot) and
                    actual['admission']['newWork'] is False and actual['admission']['recovery'] is False and _zero(actual['admission']['active']) and _zero(actual['admission']['uncertain']),
                    'P2_KNOWN_ACK_NEW_GATEWAY_CLOSED_ZERO_REQUIRED')
                if profile:
                    require(actual['process']==self.new_metadata['gateway'] and actual['binding']['candidateSha256']==self.initial['candidateSha256'],
                        'P2_KNOWN_ACK_PROFILED_NEW_GATEWAY_IDENTITY_REQUIRED')
                prior._remember(self.initial,actual)
                self.running_lineage=prior._read_lineage()
                require(self.running_lineage=={'protocol':prior.PROTOCOL,'state':'running-observed','actionId':self.action,
                    'candidateSha256':self.initial['candidateSha256'],'process':actual['process'],'binding':actual['binding']},
                    'P2_KNOWN_ACK_NEW_RUNNING_LINEAGE_REQUIRED')
                self.new_gateway=actual;self.finished=True
            self.stage_active=None;self.stage_deadline=None;self.stage_index+=1
            self.verify()
            self.recorder.verify_backend_idle()
            with self.broker.native_mutex:
                require(self.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_POSTSTAGE_FULL_PROFILE_REQUIRED')
            self._retain_stage('known-ack-stage-'+str(self.stage_index-1)+'-observed.json',{'status':'P2_KNOWN_ACK_RUNTIME_STAGE_OBSERVED','stage':list(stage),
                'recoveryActionId':self.action,'newProcesses':{name:self.new_metadata[name] for name in stage}})


def issue_known_ack_loss_boundary(broker,authorization):
    from p2_certification_parent import P2CertificationBroker
    require(type(broker) is P2CertificationBroker and broker.initial['certificationPlan']['mode']=='known-ack-recovery' and
        broker.known_ack_recorder is not None,'P2_KNOWN_ACK_FIXED_SOURCE_CONSUMER_REQUIRED')
    return KnownAckLossBoundary(_BOUNDARY_ISSUER,broker,authorization)


class ProfiledKnownAckLossBoundary(KnownAckLossBoundary):
    """The same fixed transitions under an explicit profiled certification scope."""


def issue_profiled_known_ack_loss_boundary(broker,authorization):
    from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker
    require(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope and
        broker.initial['certificationPlan']['mode']=='known-ack-recovery' and
        type(broker.known_ack_recorder) is P2KnownAckLossRecorder and broker.known_ack_recorder.broker is broker and
        broker.known_ack_recorder.expected_profile==broker.certification_profile()==broker.scope._expected_profile,
        'P2_KNOWN_ACK_PROFILED_SOURCE_CONSUMER_REQUIRED')
    return ProfiledKnownAckLossBoundary(_PROFILED_BOUNDARY_ISSUER,broker,authorization)


class KnownAckRecoveryScope(P2ReleaseScope):
    """Typed adapter for the original scope; no new lock or child registry."""
    def __init__(self,boundary):
        profiled=type(self) is ProfiledKnownAckRecoveryScope
        boundary_type=ProfiledKnownAckLossBoundary if profiled else KnownAckLossBoundary
        require(type(boundary) is boundary_type and boundary in _BOUNDARIES,'P2_KNOWN_ACK_EXACT_BOUNDARY_REQUIRED')
        self.boundary,self.parent=boundary,boundary.parent
        self.descriptor,self.path,self.identity=self.parent.descriptor,self.parent.path,self.parent.identity
        self.receipt,self.candidate_sha256=copy.deepcopy(self.parent.receipt),self.parent.candidate_sha256
        self.release,self.jobs=copy.deepcopy(self.parent.release),copy.deepcopy(self.parent.jobs)
        self.configuration_sha256=copy.deepcopy(self.parent.configuration_sha256)
        self.recovery_action_id=boundary.action
        self.verify()

    def verify(self):
        self.parent.verify();require(self.boundary in _BOUNDARIES and self.boundary.parent is self.parent,'P2_KNOWN_ACK_PARENT_SCOPE_CHANGED');self.boundary.verify()

    def require_release(self,release,jobs):self.parent.require_release(release,jobs);self.verify()
    def require_configuration(self,directory):self.parent.require_configuration(directory);self.verify()
    def require_frontend(self,release,info):
        result=self.parent.require_frontend(release,info);self.verify();return result
    def require_prior_gateway(self):self.verify()
    def before_runtime_stage(self,stage):self.verify();self.boundary.before_stage(stage)
    def after_runtime_stage(self,stage):self.boundary.after_stage(stage);self.verify()

    def run(self,*args,**kwargs):
        self.verify()
        try:return self.parent.run(*args,**kwargs)
        finally:self.verify()

    def initialize_runtime(self,snapshot,release):
        import staging_admission
        self.verify();require(snapshot==self.boundary.snapshot and release==self.release,'P2_KNOWN_ACK_EXACT_SNAPSHOT_REQUIRED')
        self.boundary.bind_snapshot(snapshot)
        gateway=json.loads(migrate.read_input(snapshot,'gateway.json'))
        require(gateway.get('admission')=={'file':'/admission/state.json','releaseId':release['releaseId'],'candidateSha256':self.candidate_sha256},
            'P2_KNOWN_ACK_NEW_ADMISSION_BINDING_REQUIRED')
        staging_admission.persist_state(snapshot,{'releaseId':release['releaseId'],'candidateSha256':self.candidate_sha256},
            'p2-known-ack-'+self.recovery_action_id,new_work=False,recovery=False)

    def revoke(self):raise ValueError('P2_KNOWN_ACK_PARENT_SCOPE_NOT_OWNED')
    def close(self):raise ValueError('P2_KNOWN_ACK_PARENT_SCOPE_NOT_OWNED')


from p2_recovery_runtime import P2RecoveryRuntime


class KnownAckRecoveryRuntime(P2RecoveryRuntime):
    """Reuse the fixed restore implementation after exact known authority.

    The ordinary runtime constructor and ordinary scopes stay unchanged. This
    constructor supplies the same complete field set after source validation.
    """
    def __init__(self,scope):
        profiled=type(self) is ProfiledKnownAckRecoveryRuntime
        scope_type=ProfiledKnownAckRecoveryScope if profiled else KnownAckRecoveryScope
        require(type(scope) is scope_type and scope.boundary in _BOUNDARIES,'P2_KNOWN_ACK_ACTUAL_RECOVERY_SCOPE_REQUIRED')
        scope.verify();boundary=scope.boundary
        self.scope,self.selected,self.jobs=scope,boundary.selected,boundary.jobs
        self.configuration,self.output,self.compose_file,self.source=boundary.input_configuration,boundary.runtime_output,boundary.broker.source/'ops/platform/compose.yaml',boundary.broker.source
        self.snapshot=None

    def restore(self):
        result=super().restore()
        boundary=self.scope.boundary;require(boundary.finished and boundary.stage_index==len(runtime.STAGES),'P2_KNOWN_ACK_COMPLETE_ORDERED_REPLACEMENT_REQUIRED')
        after=self.output/'current-api-after';after.mkdir(mode=0o700)
        current={name:self.verify_api_current(name,after) for name in ('course','community')}
        boundary.verify()
        with boundary.broker.native_mutex:
            require(boundary.broker._native_observe()['nativeEnabled'] is False,'P2_KNOWN_ACK_FINAL_PROTECTED_PROFILE_REQUIRED')
        outcome={**result,**migrate.contract_identity(self.selected),'status':'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED',
            'originalGateway':boundary.old_gateway,'newGateway':boundary.new_gateway,'currentApiDatabasesAfter':current,
            'ordinaryClosedZeroGate':False,'originalGatewayUncertaintyPreserved':True,'frontendOperationId':boundary.record['operationId'],
            'recoveryIntentSha256':boundary.record['recoveryIntentSha256'],'runtimeReplacements':1,'nativeDisabled':True,'trafficAuthorized':False,
            'gatewayReplacementStartedSha256':boundary.gateway_started_sha256,
            'readinessReceiptSha256':digest(migrate.read_input(self.output,'p2-recovery-runtime-ready.json'))}
        migrate.write_json(self.output,'known-ack-runtime-outcome.json',outcome);return outcome


class ProfiledKnownAckRecoveryScope(KnownAckRecoveryScope):
    """All runtime commands remain registered on the held certification scope."""


class ProfiledKnownAckRecoveryRuntime(KnownAckRecoveryRuntime):
    """Use the selected images' read-only API checker on the original raw jobs."""
    def _profiled_apis(self,name):
        from current_databases import read_certification_api_proof
        from p2_certification_parent import check_profiled_certification_apis
        boundary=self.scope.boundary;broker=boundary.broker;profile=boundary.expected_profile
        self.scope.verify()
        credentials={name:broker.initial['credentials'][name.upper()+'_STAGING_DATABASE_URL'] for name in ('course','community')}
        directory=self.output/name
        proof,outcome=check_profiled_certification_apis(boundary.parent,self.jobs,self.source,broker.bundle,directory,
            credentials,broker.initial['sourceSha256'],expected_profile=profile)
        _,retained=read_certification_api_proof(proof,boundary.parent,self.selected,self.jobs,expected_profile=profile)
        require(retained==outcome,'P2_KNOWN_ACK_PROFILED_API_CURRENT_CHANGED')
        self.scope.verify()
        return outcome,digest(migrate.read_input(directory,'certification-current-databases-outcome.json'))

    def _read_current_apis(self):
        self.before_apis,self.before_apis_sha256=self._profiled_apis('current-api-before')
        return self.before_apis['databases']

    def restore(self):
        boundary=self.scope.boundary
        with boundary.mutex:
            require(not boundary.runtime_attempted,'P2_KNOWN_ACK_PROFILED_RUNTIME_ALREADY_ATTEMPTED')
            boundary.runtime_attempted=True
        result=self._restore(expected_profile=boundary.expected_profile)
        require(boundary.finished and boundary.stage_index==len(runtime.STAGES),'P2_KNOWN_ACK_COMPLETE_ORDERED_REPLACEMENT_REQUIRED')
        after,after_sha=self._profiled_apis('current-api-after')
        require(after==self.before_apis,'P2_KNOWN_ACK_PROFILED_API_CURRENT_CHANGED')
        recorder=boundary.recorder
        recorder._verify_settled_snapshot(boundary.record,recorder._snapshot())
        boundary.verify_healthy_boundary()
        outcome={**result,**migrate.contract_identity(self.selected),'status':'P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED',
            'originalGateway':boundary.old_gateway,'newGateway':boundary.new_gateway,'currentApiDatabasesAfter':after['databases'],
            'currentApiBeforeReceiptSha256':self.before_apis_sha256,'currentApiAfterReceiptSha256':after_sha,
            'frontendJournalSha256':boundary.parent.receipt['journalSha256'],
            'ordinaryClosedZeroGate':False,'originalGatewayUncertaintyPreserved':True,'frontendOperationId':boundary.record['operationId'],
            'recoveryIntentSha256':boundary.record['recoveryIntentSha256'],'runtimeReplacements':1,'nativeDisabled':True,'trafficAuthorized':False,
            'gatewayReplacementStartedSha256':boundary.gateway_started_sha256,
            'readinessReceiptSha256':digest(migrate.read_input(self.output,'p2-recovery-runtime-ready.json'))}
        migrate.write_json(self.output,'known-ack-runtime-outcome.json',outcome)
        return outcome
