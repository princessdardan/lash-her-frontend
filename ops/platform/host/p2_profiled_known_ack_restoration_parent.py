"""Profiled interrupted known-ACK preflight and guarded host restoration."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
from contextlib import nullcontext

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import p2_certification_parent as certification
import p2_known_ack_interrupted_restoration as interrupted
import p2_lifecycle_native as native
import p2_prior_gateway as prior
import release as runtime
import staging_state
import vercel
from frontend_release_adapters import LockedClient
from p2_release_broker import Broker, LOCK, MAXIMUM
from p2_source_closure import (
    CERTIFICATION_OBSERVER, PROFILED_INTERRUPTED_MODE as MODE, private_observer_program,
    verify_profiled_current_source_closure,
)
from qualification_target_profile import decode_qualification_target_json

require = migrate.demand
INITIAL_FIELDS = frozenset({
    'version','qualificationTargetProfile','mode','environment','sourceCommit','sourceSha256','sourceClosureSha256',
    'hostMachineId','bundle','configuration','results','candidate','candidateSha256','apiJobSha256','configurationSha256',
    'targetSha256','inventorySha256','inventory','owner','frontendJob','frontendBaseline','restorationActionId','recoveryActionId',
    'interruptedRestoration','receiverTargets','priorGatewayReference','originalCertificationPlanSha256',
    'originalCertificationPlanBytesSha256','operationId','reviewedPlan','originalCertificationPlan',
})
FALSE_FIELDS = ('frontendSqlApplied','sqlReplayAllowed','rolePreparationAllowed','loginChangeAllowed','frontendBuildAllowed',
                'frontendPromotionAllowed','admissionOpeningAllowed','nativeSchedulesEnabled','trafficAuthorized',
                'liveExecutionEligible','releaseAccepted')
PLAN_FIELDS = frozenset({
    'version','qualificationTargetProfile','mode','environment','restorationActionId','originalReleaseId','sourceCommit',
    'operatorSourceCommit','candidateSha256','apiJobSha256','configurationSha256','inventorySha256','targetSha256','hostMachineId',
    'originalCertificationPlanSha256','originalCertificationPlanBytesSha256','frontendPlan','configurationInputDirectory','interruptedRestoration','receiverTargets',
    'requestedFrontier','runtimeStages','runtimeReplacements','maximumSeconds',*FALSE_FIELDS,
})
IDENTITY_FIELDS = ('candidateSha256','apiJobSha256','configurationSha256','inventorySha256','targetSha256','hostMachineId',
                   'restorationActionId','originalCertificationPlanSha256','originalCertificationPlanBytesSha256',
                   'interruptedRestoration','receiverTargets')
PRIVATE_FIELDS = frozenset({'confirmation', 'credentials', 'vercelToken'})
GUARD_FIELDS = frozenset({'_guardLayout', '_guardObserverSource', '_guardObserverProgram', '_guardLockDescriptor'})
FRONTEND_CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
API_CREDENTIALS = {'course': 'COURSE_STAGING_DATABASE_URL', 'community': 'COMMUNITY_STAGING_DATABASE_URL'}
ACTION_PREFIX = 'p2-profiled-known-ack-restoration-'
TERMINAL = 'p2-profiled-known-ack-interrupted-restoration-outcome.json'
SESSION_CLOSED = 'p2-profiled-interrupted-frontend-session-closed.json'
_AUTHORITY_ISSUER = object()

# The supervisor and runtime validate exact source types even when this file
# is invoked as the fixed Python entrypoint.
if __name__ == '__main__':
    require('p2_profiled_known_ack_restoration_parent' not in sys.modules,
            'P2_PROFILED_INTERRUPTED_FIXED_MODULE_REQUIRED')
    sys.modules['p2_profiled_known_ack_restoration_parent'] = sys.modules[__name__]


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'), sort_keys=True).encode()


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None and value != '0' * 64


def _action(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value) is not None


def _plan_body_hash(value):
    return _sha(_canonical({key: item for key,item in value.items() if key != 'planSha256'}))


def _raw_original(initial, expected):
    raw = base64.b64decode(initial['originalCertificationPlan'], validate=True)
    require(0 < len(raw) <= 65_536 and base64.b64encode(raw).decode() == initial['originalCertificationPlan'] and
            _sha(raw) == initial['originalCertificationPlanBytesSha256'], 'P2_PROFILED_INTERRUPTED_ORIGINAL_PLAN_BYTES_REQUIRED')
    original = decode_qualification_target_json(raw, 'carrier')
    vercel.require_record_profile(expected, original, original.get('nativePlan'), original.get('knownAckRecovery'))
    require(set(original) == certification.PROFILED_PLAN_FIELDS | {'knownAckRecovery','knownAckReceiverTargets','knownAckConfigurationInputDirectory'} and
            original['planSha256'] == initial['originalCertificationPlanSha256'] == _plan_body_hash(original),
            'P2_PROFILED_INTERRUPTED_ORIGINAL_PLAN_HASH_REQUIRED')
    return original


def _requested_frontier(selection, results):
    from p2_known_ack_interrupted_restoration import CAUSAL_FILES, REPLACEMENT_FILES
    causal, replacement = selection['causalReceiptSha256'], selection['replacementReceiptSha256']
    require(type(causal) is dict and set(causal) == set(CAUSAL_FILES) | {'reconciliation-observed.json'} and
            all(_digest(value) for value in causal.values()) and type(replacement) is dict and
            set(replacement) == set(REPLACEMENT_FILES) and all(value is None or _digest(value) for value in replacement.values()) and
            _digest(replacement['known-ack-replacement-intent.json']), 'P2_PROFILED_INTERRUPTED_RECEIPT_PINS_REQUIRED')
    completed, active = 0, False
    for index in range(5):
        intent, observed = (replacement[f'known-ack-stage-{index}-{kind}.json'] for kind in ('intent','observed'))
        require(observed is None or intent is not None, 'P2_PROFILED_INTERRUPTED_STAGE_PREFIX_REQUIRED')
        if intent is not None:
            require(not active and completed == index, 'P2_PROFILED_INTERRUPTED_STAGE_PREFIX_REQUIRED')
            active = observed is None
            completed += not active
    require((replacement['known-ack-gateway-replacement-started.json'] is not None) == (completed == 5),
            'P2_PROFILED_INTERRUPTED_AMBIGUOUS_GATEWAY_FRONTIER')
    reference = selection['priorGatewayReference']
    guard = Path(results) / ('p2-profiled-current-certification-' + selection['originalCertificationActionId'])
    earlier = certification.PROFILED_RELEASE_ROOT / ('p2-profiled-known-ack-' + selection['originalRecoveryActionId'])
    permitted = {str(guard), *(str(guard / label) for label in ('prior-gateway-after-quiescence','prior-gateway-broker-fallback'))}
    if completed < 5:
        permitted.add(str(earlier))
    require(type(reference) is dict and set(reference) == {'kind','stopReceiptDirectory','stopReceiptSha256'} and
            reference['kind'] == 'stopped-current-candidate' and reference['stopReceiptDirectory'] in permitted and
            _digest(reference['stopReceiptSha256']), 'P2_PROFILED_INTERRUPTED_SOURCE_STOP_REFERENCE_REQUIRED')
    return 'replacement-stopped-zero' if completed == 5 else 'original-stopped-one'


def validate_profiled_interrupted_packet(initial):
    """Check the exact source-owned wire without reading credentials or host state."""
    expected = certification._profiled_context()
    require(type(initial) is dict and set(initial) == INITIAL_FIELDS and initial['mode'] == MODE and
            initial['environment'] == 'staging' and migrate.source_commit(initial['sourceCommit']) and
            _action(initial['restorationActionId']) and initial['recoveryActionId'] == initial['restorationActionId'] and
            all(_digest(initial[key]) for key in ('candidateSha256','targetSha256','inventorySha256','sourceClosureSha256',
                                                 'originalCertificationPlanSha256','originalCertificationPlanBytesSha256')),
            'P2_PROFILED_INTERRUPTED_PACKET_REQUIRED')
    candidate, selection, plan = (initial[key] for key in ('candidate','interruptedRestoration','reviewedPlan'))
    migrate.candidate_profile(candidate, expected)
    vercel.require_record_profile(expected, initial, selection, plan, initial['inventory'])
    hashes, api = initial['configurationSha256'], initial['apiJobSha256']
    require(type(hashes) is dict and set(hashes) == set(staging_state.CONFIGURATION_FILES) and
            type(api) is dict and set(api) == {'course','community'} and
            all(_digest(value) for value in (*hashes.values(), *api.values())), 'P2_PROFILED_INTERRUPTED_CONFIG_PINS_REQUIRED')
    require(set(selection) == {'version','qualificationTargetProfile','mode','restorationActionId','originalCertificationActionId',
            'originalRecoveryActionId','originalOperatorSourceCommit','causalReceiptSha256','replacementReceiptSha256','priorGatewayReference'} and
            selection['mode'] == MODE and selection['restorationActionId'] == initial['restorationActionId'] and
            all(_action(selection[key]) for key in ('originalCertificationActionId','originalRecoveryActionId')) and
            len({candidate['releaseId'],initial['restorationActionId'],selection['originalCertificationActionId'],selection['originalRecoveryActionId']}) == 4 and
            migrate.source_commit(selection['originalOperatorSourceCommit']) and selection['priorGatewayReference'] == initial['priorGatewayReference'],
            'P2_PROFILED_INTERRUPTED_SELECTION_REQUIRED')
    require(set(plan) == PLAN_FIELDS and plan['mode'] == MODE and plan['environment'] == 'staging' and
            all(_canonical(plan[key]) == _canonical(initial[key]) for key in IDENTITY_FIELDS) and
            plan['originalReleaseId'] == candidate['releaseId'] and plan['sourceCommit'] == candidate['sources']['frontend']['commit'] and
            plan['operatorSourceCommit'] == initial['sourceCommit'] and plan['runtimeStages'] == 5 and
            type(plan['runtimeReplacements']) is int and plan['runtimeReplacements'] == 1 and
            plan['maximumSeconds'] == 900 and all(plan[key] is False for key in FALSE_FIELDS) and
            plan['requestedFrontier'] == _requested_frontier(selection, initial['results']), 'P2_PROFILED_INTERRUPTED_REVIEWED_PLAN_REQUIRED')
    original = _raw_original(initial, expected)
    require(original['mode'] == 'known-ack-recovery' and original['environment'] == 'staging' and original['startState'] == 'already-closed' and
            original['sourceCommit'] == plan['sourceCommit'] and original['operatorSourceCommit'] == selection['originalOperatorSourceCommit'] and
            original['certificationActionId'] == selection['originalCertificationActionId'] and original['originalReleaseId'] == candidate['releaseId'] and
            original['knownAckRecovery']['recoveryActionId'] == selection['originalRecoveryActionId'] and
            all(original[key] == initial[key] for key in ('candidateSha256','targetSha256','apiJobSha256','inventorySha256')) and
            original['configurationCanonicalSha256'] == _sha(_canonical(hashes)) and
            original['knownAckReceiverTargets'] == initial['receiverTargets'], 'P2_PROFILED_INTERRUPTED_ORIGINAL_PLAN_REQUIRED')
    certification._profiled_known_ack_selection(original, None, expected)
    require(initial['configuration'] == plan['configurationInputDirectory'] == original['knownAckConfigurationInputDirectory'],
            'P2_PROFILED_INTERRUPTED_ORIGINAL_CONFIGURATION_PATH_REQUIRED')
    native = original['nativePlan']
    migrate.require_profile(expected,native['target'])
    require(native['planSha256'] == _plan_body_hash(native) and type(native['initialEpoch']) is str and
            re.fullmatch(r'[1-9][0-9]{0,17}',native['initialEpoch']) and
            type(initial['operationId']) is str and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',initial['operationId']),
            'P2_PROFILED_INTERRUPTED_FRESH_FRONTEND_SELECTION_REQUIRED')
    frontend = {'version':2,'qualificationTargetProfile':expected,'mode':MODE,'environment':'staging','startState':'already-closed',
        'certificationActionId':initial['restorationActionId'],'originalCertificationActionId':selection['originalCertificationActionId'],
        'originalReleaseId':candidate['releaseId'],'sourceCommit':plan['sourceCommit'],'candidateSha256':initial['candidateSha256'],
        'targetSha256':initial['targetSha256'],'apiJobSha256':api,**migrate.contract_identity(candidate),
        'configurationCanonicalSha256':_sha(_canonical(hashes)), 'nativePlan':native,'initialEpoch':str(int(native['initialEpoch'])+2),
        'operationId':initial['operationId'],'reconciliationSha256':selection['causalReceiptSha256']['settlement.json']}
    require(plan['frontendPlan'] == {**frontend,'planSha256':_sha(_canonical(frontend))},
            'P2_PROFILED_INTERRUPTED_FRESH_FRONTEND_PLAN_CHANGED')
    return plan, original


def prepare_profiled_interrupted_input(initial, source):
    plan, original = validate_profiled_interrupted_packet(initial)
    expected = certification._profiled_context()
    source = Path(source)
    require(source == certification.PROFILED_OPERATOR_ROOT / initial['sourceCommit'] and source == source.resolve() and
            certification.PROFILED_MACHINE_ID.read_text().strip() == initial['hostMachineId'],
            'P2_PROFILED_INTERRUPTED_INSTALLED_SOURCE_OR_HOST_REQUIRED')
    verify_profiled_current_source_closure(initial, source)
    paths = [Path(initial[key]) for key in ('bundle','configuration','results')]
    for path in paths:
        require(path.is_absolute() and certification.PROFILED_RELEASE_ROOT in path.parents and path == path.resolve() and
                ',' not in str(path), 'P2_PROFILED_INTERRUPTED_HOST_PATH_REQUIRED')
        staging_state.outside_checkout(path)
    bundle, configuration, _ = paths
    selected, jobs, runtime_plan, _ = runtime.make_plan(bundle, configuration, source / 'ops/platform/compose.yaml', expected_profile=expected)
    inventory = initial['inventory']
    job = jobs['frontend']['job']
    native = original['nativePlan']
    producer = inventory.get('runtimeProducerSha256')
    producers = [row for row in inventory['producers'] if row['producerSha256'] == producer]
    restoration = inventory['restoration']
    require(selected == initial['candidate'] and _sha(migrate.read_input(bundle,'release.candidate.json')) == initial['candidateSha256'] and
            migrate.profiled_current_job_hashes(bundle) == initial['apiJobSha256'] and
            job == initial['frontendJob'] and decode_qualification_target_json(jobs['frontend']['schema'],'carrier') == initial['frontendBaseline'] and
            job['target']['approvedPendingTags'] == [] and job['target']['allowEmptyBootstrap'] is False and
            certification.frontend_target_sha256(job['target']) == initial['targetSha256'] and
            _sha(certification._profiled_compact(inventory)) == initial['inventorySha256'] and inventory['owner'] == initial['owner'] == native['owner'] and
            len(producers) == 1 and native['producer'] == {'producerSha256':producer,'role':producers[0]['role']} and
            native['producer']['role']['name'] == job['target']['runtimeRole'] and restoration['providerIngress'] == 'keep-retired' and
            all(restoration.get(key) is False for key in ('newWork','recovery','nativeSchedulesEnabled')) and
            inventory['targetSha256'] == initial['targetSha256'] and inventory['admissionMode'] == 'existing' and
            runtime_plan['hostMachineId'] == initial['hostMachineId'] and staging_state.configuration_hashes(configuration) == initial['configurationSha256'],
            'P2_PROFILED_INTERRUPTED_ACTUAL_RELEASE_INPUT_REQUIRED')
    for service, target in initial['receiverTargets'].items():
        receiver = jobs[service]['job']
        require(target['user'] == receiver['runtimeRole'] and all(target[key] == receiver['target'][key] for key in ('host','port','database','serverMajor')),
                'P2_PROFILED_INTERRUPTED_ACTUAL_RECEIVER_TARGET_REQUIRED')
    return plan, original, selected, jobs


def verify_profiled_interrupted_retained(initial, plan, selected, jobs, verify):
    """Read actual stopped-lineage and retained B bytes under the caller's held host lock."""
    from p2_known_ack_interrupted_restoration import load_profiled_retained
    expected = certification._profiled_context()
    verify()
    retained = load_profiled_retained(initial, selected, jobs, verify, expected_profile=expected)
    require(retained['frontier'] == plan['requestedFrontier'], 'P2_PROFILED_INTERRUPTED_ACTUAL_FRONTIER_CHANGED')
    verify()
    return retained


def plan_retained(initial, source, plan, selected, jobs):
    import fcntl
    import os
    import stat
    from p2_release_broker import LOCK
    fd = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(fd)
        def verify():
            actual = LOCK.lstat()
            require(stat.S_ISREG(actual.st_mode) and actual.st_uid == 0 and not actual.st_mode & 0o077 and
                    (actual.st_dev,actual.st_ino) == (identity.st_dev,identity.st_ino), 'P2_PROFILED_INTERRUPTED_PLAN_LOCK_CHANGED')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            verify_profiled_current_source_closure(initial, source)
        retained = verify_profiled_interrupted_retained(initial, plan, selected, jobs, verify)
        return {'actualFrontier':retained['frontier'],'retainedGatewayObserved':True}
    finally:
        os.close(fd)


def _read_receipt(value):
    require(type(value) is str and 0 < len(value) <= MAXIMUM, 'P2_PROFILED_INTERRUPTED_PROTOCOL_RECEIPT_REQUIRED')
    raw = base64.b64decode(value, validate=True)
    require(0 < len(raw) <= 2_000_000 and base64.b64encode(raw).decode() == value,
            'P2_PROFILED_INTERRUPTED_PROTOCOL_RECEIPT_REQUIRED')
    result = decode_qualification_target_json(raw, 'carrier')
    require(type(result) is dict, 'P2_PROFILED_INTERRUPTED_PROTOCOL_RECEIPT_REQUIRED')
    return result


def _guard_context(initial, armed, source):
    from p2_release_supervisor import require_profiled_interrupted_guard_arm
    review = {key: initial[key] for key in INITIAL_FIELDS}
    plan, _, selected, _ = prepare_profiled_interrupted_input(review, source)
    require_profiled_interrupted_guard_arm(initial, armed)
    return plan, selected


def contain_profiled_interrupted_native(initial, armed, source):
    result = {'nativeDisabled': None, 'nativeDisableAttempted': False}
    try:
        plan, selected = _guard_context(initial, armed, source)
        context = {'candidate': selected, 'plan': plan['frontendPlan']['nativePlan']}
        expected = certification._profiled_context()
        client = vercel.Client(initial['vercelToken'])
        if native.observe_metadata(context, client, expected_profile=expected)['nativeEnabled']:
            result['nativeDisableAttempted'] = True
            client.request('PATCH', f"/v1/projects/{context['plan']['projectId']}/crons", {'enabled': False})
        if native.observe_metadata(context, client, expected_profile=expected)['nativeEnabled'] is False:
            result['nativeDisabled'] = True
    except Exception:
        pass
    return result


def contain_profiled_interrupted_frontend(initial, armed, source):
    result = {'frontendAdmissionClosed': None, 'frontendCloseAttempted': False}
    try:
        _, selected = _guard_context(initial, armed, source)
        expected = certification._profiled_context()
        directory = Path(initial['results']) / (ACTION_PREFIX + initial['restorationActionId'])
        certification.cache_certification_core(initial, source, expected_profile=expected)
        program = private_observer_program(initial, directory / 'guard-frontend-source')
        observer = certification.P2CertificationPhysicalObserver(
            selected, armed, source, initial['credentials'][FRONTEND_CREDENTIAL],
            program=program, program_sha256=initial['sourceSha256'][CERTIFICATION_OBSERVER],
            expected_profile=expected, interrupted=True,
        )
        observer.probe('verify-closed')
        result['frontendAdmissionClosed'] = True
    except Exception:
        pass
    return result


class _RuntimeAuthority:
    def __init__(self, issuer, broker, record):
        require(issuer is _AUTHORITY_ISSUER, 'P2_PROFILED_INTERRUPTED_AUTHORITY_ISSUER_REQUIRED')
        self.broker, self.record = broker, copy.deepcopy(record)


def consume_profiled_interrupted_runtime_authority(authority, broker):
    require(type(broker) is P2ProfiledInterruptedKnownAckBroker and type(authority) is _RuntimeAuthority and
            authority is broker.authority and authority.broker is broker and broker.runtime_attempted,
            'P2_PROFILED_INTERRUPTED_ONE_USE_AUTHORITY_REQUIRED')
    broker.authority = None
    broker.verify_prepared()
    return copy.deepcopy(authority.record)


class _ProfiledFreshSettledReader(interrupted.FreshSettledReader):
    def __init__(self, broker, scope, retained):
        self.expected_profile = broker.certification_profile()
        super().__init__(broker, scope, retained)


class P2ProfiledInterruptedKnownAckBroker(Broker):
    """One read-only frontend lease and one fenced runtime replacement."""

    def certification_profile(self):
        return certification._profiled_context()

    def failure_profile(self):
        return self.certification_profile()

    def action_id(self):
        return self.initial['restorationActionId']

    def terminal_filename(self):
        return TERMINAL

    def initialize(self):
        self.guard_arm_verified = self.runtime_attempted = self.fallback_complete = False
        self.failure_lock = threading.RLock()
        self.authority = self.reader = self.armed_probe = self.runtime_transition = self.prepared_terminal = None
        initial = self.initial
        require(set(initial) == INITIAL_FIELDS | PRIVATE_FIELDS | GUARD_FIELDS and
                initial['confirmation'] == 'staging/' + self.action_id() and
                self.shared_lock_fd is not None and self.shared_lock_fd == initial['_guardLockDescriptor'] and
                self.safety_write is not None and self.guard_read is not None and os.geteuid() == 0 and
                self.observer_type is certification.P2CertificationPhysicalObserver and self.observer_source == CERTIFICATION_OBSERVER,
                'P2_PROFILED_INTERRUPTED_FIXED_GUARDED_START_REQUIRED')
        self.start_parent_watch()
        self.source = Path(__file__).resolve().parents[3]
        review = {key: initial[key] for key in INITIAL_FIELDS}
        self.plan, _, self.selected, self.jobs = prepare_profiled_interrupted_input(review, self.source)
        self.bundle, self.configuration, self.results = (Path(initial[key]) for key in ('bundle', 'configuration', 'results'))
        credentials = initial['credentials']
        require(type(credentials) is dict and set(credentials) == {FRONTEND_CREDENTIAL, *API_CREDENTIALS.values()} and
                all(type(value) is str and 0 < len(value) <= 16384 for value in credentials.values()),
                'P2_PROFILED_INTERRUPTED_CREDENTIALS_REQUIRED')
        self.vercel = vercel.Client(initial['vercelToken'])
        runtime.assert_host({'hostMachineId': initial['hostMachineId']})
        self.lock_fd = self.shared_lock_fd
        self.lock_info = os.fstat(self.lock_fd)
        self.deadline = time.monotonic() + self.plan['maximumSeconds']
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, 'P2_INDEPENDENT_GUARD_HANDSHAKE_REQUIRED')
        self.retained = verify_profiled_interrupted_retained(initial, self.plan, self.selected, self.jobs, self.check)
        self.require_native_off()
        self.directory = self.results / (ACTION_PREFIX + self.action_id())
        self.directory.mkdir(mode=0o700)
        certification.cache_certification_core(initial, self.source, expected_profile=self.certification_profile())
        self.observer_program = private_observer_program(initial, self.directory / 'private-source')
        self.outcome.update(version=2, qualificationTargetProfile=self.certification_profile(),
                            restorationActionId=self.action_id(), candidateSha256=initial['candidateSha256'])
        self.check()

    def check(self):
        require(time.monotonic() < self.deadline, 'P2_PROFILED_INTERRUPTED_ACTION_DEADLINE')
        super().check()

    def _receipt(self, status, **fields):
        return {'version': 2, 'qualificationTargetProfile': self.certification_profile(), 'status': status,
                'restorationActionId': self.action_id(), 'candidateSha256': self.initial['candidateSha256'], **fields}

    def require_native_off(self):
        context = {'candidate': self.selected, 'plan': self.retained['plan']['nativePlan']}
        require(native.observe_metadata(context, LockedClient(self.vercel, self.check),
                expected_profile=self.certification_profile())['nativeEnabled'] is False,
                'P2_PROFILED_INTERRUPTED_NATIVE_MUST_ALREADY_BE_OFF')

    def verify_original(self):
        self.check()
        retained, initial = self.retained, self.initial
        profile = self.certification_profile()
        selection, auxiliary = retained['selection'], retained['originalAuxiliarySha256']
        cert_id = selection['originalCertificationActionId']
        cert_directory = self.results / ('p2-profiled-current-certification-' + cert_id)
        causal = interrupted.ROOT / ('p2-known-ack-loss-' + cert_id)
        replacement = retained['replacementDirectory']
        require(interrupted._profiled_files(causal, selection['causalReceiptSha256'], profile) == retained['values'] and
                interrupted._profiled_files(replacement, selection['replacementReceiptSha256'], profile) == retained['stages'],
                'P2_PROFILED_INTERRUPTED_CAUSAL_OR_STAGE_CHANGED')
        stop_directory = Path(selection['priorGatewayReference']['stopReceiptDirectory'])
        stop = auxiliary['stop']
        pins = [
            (stop_directory, prior.BEFORE_STOP, stop['beforeSha256']),
            (stop_directory, prior.STOPPED, stop['stopSha256']),
            (cert_directory, 'p2-profiled-certification-input-verified.json', auxiliary['inputVerifiedSha256']),
            (cert_directory, 'p2-certification-current-ready.json', auxiliary['readySha256']),
            (cert_directory, 'p2-certification-operator-request-details.json', auxiliary['operatorRequestSha256']),
            (cert_directory / 'current-api', 'certification-current-databases-outcome.json', auxiliary['apiCurrentSha256']),
            (cert_directory, 'p2-profiled-current-certification-outcome.json', None),
        ]
        if 'originalStopSha256' in stop:
            pins.extend(((replacement, prior.BEFORE_STOP, stop['originalBeforeSha256']),
                         (replacement, prior.STOPPED, stop['originalStopSha256'])))
        pins.extend((cert_directory / 'fault', name, pin) for name, pin in retained['originalFaultReceiptSha256'].items())
        pins.extend((cert_directory if name == 'known-ack-replacement-joined.json' else replacement / 'runtime-known-ack',
                     name, pin) for name, pin in auxiliary['completion'].items())
        for directory, name, pin in pins:
            path = directory / name
            if pin is None:
                require(not path.exists() and not path.is_symlink(), 'P2_PROFILED_INTERRUPTED_ORIGINAL_ABSENCE_CHANGED')
            else:
                require(_sha(migrate.read_input(directory, name, 2_000_000)) == pin,
                        'P2_PROFILED_INTERRUPTED_ORIGINAL_RECEIPT_CHANGED')
        source, manifest = interrupted.original_source(selection['originalOperatorSourceCommit'],
            retained['values']['replacement-authorization.json']['operatorSourceClosureSha256'], expected_profile=profile)
        require((source, manifest) == (retained['originalSource'], retained['originalSourceManifest']),
                'P2_PROFILED_INTERRUPTED_ORIGINAL_SOURCE_CHANGED')
        configurations = [retained['inputDirectory'], retained['oldMountedDirectory']]
        replacement_configuration = retained['replacementSnapshot']
        if (retained['activeStage'] is not None or retained['completedStages'] or replacement_configuration.exists() or
                replacement_configuration.is_symlink()):
            configurations.append(replacement_configuration)
        for directory in configurations:
            require(directory == directory.resolve() and staging_state.configuration_hashes(directory) == initial['configurationSha256'],
                    'P2_PROFILED_INTERRUPTED_ORIGINAL_CONFIGURATION_CHANGED')

    def _read_api_current(self, directory):
        credentials = {name: self.initial['credentials'][key] for name, key in API_CREDENTIALS.items()}
        _, outcome = certification.check_profiled_certification_apis(
            self.scope, self.jobs, self.source, self.bundle, directory, credentials, self.initial['sourceSha256'],
            expected_profile=self.certification_profile(),
        )
        return outcome

    def verify_prepared(self):
        require(type(self.scope) is certification.P2CertificationScope and self.reader is not None and self.guard_arm_verified,
                'P2_PROFILED_INTERRUPTED_FRESH_SCOPE_REQUIRED')
        self.scope.verify()
        self.verify_original()
        self.reader.snapshot()
        self.require_native_off()

    def _accept_guard_arm(self, probe):
        from p2_release_supervisor import require_profiled_interrupted_guard_arm
        self.safety({'operation': 'armed', 'probe': probe})
        deadline = time.monotonic() + 10
        while True:
            self.check()
            try:
                require_profiled_interrupted_guard_arm(self.initial, probe)
                self.guard_arm_verified = True
                return
            except FileNotFoundError:
                require(time.monotonic() < deadline, 'P2_PROFILED_INTERRUPTED_GUARD_ARM_TIMEOUT')
                time.sleep(0.05)

    def arm(self, request):
        require(self.observer is None, 'P2_PROFILED_INTERRUPTED_ALREADY_ARMED')
        self.verify_original()
        receipt, probe = _read_receipt(request['receipt']), request['probe']
        frontend_plan = self.plan['frontendPlan']
        job = self.jobs['frontend']
        inventory = self.initial['inventory']
        require(type(probe) is dict and probe.get('receipt') == receipt and probe.get('plan') == frontend_plan and
                probe.get('owner') == self.initial['owner'] and probe.get('job') == job['job'] and
                probe.get('baseline') == decode_qualification_target_json(job['schema'], 'carrier') and
                probe.get('historicalLogins') == inventory['historicalLogins'] and probe.get('producers') == inventory['producers'],
                'P2_PROFILED_INTERRUPTED_FRONTEND_RECEIPT_REQUIRED')
        self.armed_probe = copy.deepcopy(probe)
        self.observer = self.observer_type(
            self.selected, probe, self.source, self.initial['credentials'][FRONTEND_CREDENTIAL],
            program=self.observer_program, program_sha256=self.initial['sourceSha256'][self.observer_source],
            expected_profile=self.certification_profile(), interrupted=True,
        )
        self.observer.start(self.abort)
        self.scope = certification.P2CertificationScope(
            self.lock_fd, LOCK, self.check, receipt, self.initial['candidateSha256'],
            release=self.selected, jobs=self.jobs, configuration_sha256=self.initial['configurationSha256'],
            certification_plan=frontend_plan, expected_profile=self.certification_profile(), physical_observer=self.observer,
        )
        self._accept_guard_arm(probe)
        self.reader = _ProfiledFreshSettledReader(self, self.scope, self.retained)
        self.verify_prepared()
        self.api_before = self._read_api_current(self.directory / 'arm-current-api')['databases']
        self.verify_prepared()
        migrate.write_json(self.directory, 'p2-profiled-interrupted-frontend-current.json', receipt)
        return self._receipt('P2_PROFILED_INTERRUPTED_FRESH_CURRENT_READY', apiDatabases=self.api_before, authorityIssued=False)

    def prepare(self):
        require(self.authority is None and not self.runtime_attempted, 'P2_PROFILED_INTERRUPTED_ALREADY_PREPARED')
        self.verify_prepared()
        selection = self.retained['selection']
        record = self._receipt('P2_PROFILED_INTERRUPTED_RUNTIME_AUTHORIZED', frontier=self.retained['frontier'],
                               originalStopReceiptSha256=selection['priorGatewayReference']['stopReceiptSha256'],
                               originalCausalReceiptSha256=selection['causalReceiptSha256'])
        migrate.write_json(self.directory, 'p2-profiled-interrupted-authority-prepared.json', record)
        self.authority = _RuntimeAuthority(_AUTHORITY_ISSUER, self, record)
        return self._receipt('P2_PROFILED_INTERRUPTED_NEW_TYPED_BOUNDARY_PREPARED', authoritySha256=_sha(_canonical(record)))

    def restore_runtime(self):
        from p2_profiled_known_ack_runtime import prepare_profiled_interrupted_runtime
        require(self.authority is not None and not self.runtime_attempted, 'P2_PROFILED_INTERRUPTED_EXPLICIT_RESTORE_REQUIRED')
        self.runtime_attempted = True
        self.runtime_transition = prepare_profiled_interrupted_runtime(self, self.authority, self.retained)
        self.ready = self.runtime_transition.restore()
        require(self.ready['apiDatabases'] == self.ready['currentApiDatabasesAfter'] == self.api_before,
                'P2_PROFILED_INTERRUPTED_API_PROOF_CHANGED_SINCE_ARM')
        return self.ready

    def prepare_close(self):
        require(self.ready is not None and self.prepared_terminal is None, 'P2_PROFILED_INTERRUPTED_RUNTIME_NOT_READY')
        self.runtime_transition.scope.verify()
        self.prepared_terminal = copy.deepcopy(self.ready)
        self.verify_runtime_receipt()
        migrate.write_json(self.directory, 'p2-profiled-interrupted-close-prepared.json', self.prepared_terminal)
        # The operator still owns the fresh physical lease. Stop the polling
        # thread before it releases that lease to avoid a false failure.
        self.closing_at = time.monotonic()
        self.observer.stop()
        self.check()
        return self.prepared_terminal

    def verify_runtime_receipt(self):
        from p2_profiled_known_ack_runtime import OUTCOME
        raw = migrate.read_input(self.directory / 'runtime-interrupted', OUTCOME)
        require(_canonical(decode_qualification_target_json(raw, 'carrier')) == _canonical(self.prepared_terminal),
                'P2_PROFILED_INTERRUPTED_RUNTIME_RECEIPT_CHANGED')

    def finish(self, value):
        require(self.closing_at is not None and not self.finished and
                _canonical(_read_receipt(value['restoration'])) == _canonical(self.prepared_terminal),
                'P2_PROFILED_INTERRUPTED_PREPARED_TERMINAL_REQUIRED')
        self.verify_original()
        self.verify_runtime_receipt()
        observed = self.observer.probe('verify-closed')
        self.require_native_off()
        self.check()
        migrate.write_json(self.directory, SESSION_CLOSED, observed)
        self.closed_receipt_sha256 = _sha(migrate.read_input(self.directory, SESSION_CLOSED))
        self.finished = True
        return self.prepared_terminal

    def commit(self):
        require(self.finished and not self.committed.is_set(), 'P2_PROFILED_INTERRUPTED_JOIN_REQUIRED')
        self.verify_original()
        self.require_native_off()
        self.verify_runtime_receipt()
        require(_sha(migrate.read_input(self.directory, SESSION_CLOSED)) == self.closed_receipt_sha256,
                'P2_PROFILED_INTERRUPTED_CLOSURE_RECEIPT_CHANGED')
        migrate.write_json(self.directory, self.terminal_filename(), self.prepared_terminal)
        raw = migrate.read_input(self.directory, self.terminal_filename())
        self.safety({'operation': 'committed', 'sha256': _sha(raw)})
        self.committed.set()
        return self.prepared_terminal

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000 and type(operation) is str,
                'P2_PROFILED_INTERRUPTED_PROTOCOL_REQUIRED')
        self.last_command = time.monotonic()
        self.check()
        keys = {'id', 'operation'}
        if operation == 'check' and set(value) == keys:
            self.send(identity, 'HELD')
            return
        handlers = {
            'arm-interrupted-restoration': (keys | {'probe', 'receipt'}, 'INTERRUPTED_RESTORATION_ARMED', lambda: self.arm(value)),
            'prepare-interrupted-restoration': (keys, 'INTERRUPTED_RESTORATION_PREPARED', self.prepare),
            'restore-runtime': (keys, 'INTERRUPTED_RUNTIME_READY', self.restore_runtime),
            'prepare-close': (keys, 'INTERRUPTED_CLOSE_PREPARED', self.prepare_close),
            'finish': (keys | {'restoration'}, 'INTERRUPTED_RESTORATION_JOINED', lambda: self.finish(value)),
            'commit': (keys, 'COMMITTED', self.commit),
        }
        require(operation in handlers and set(value) == handlers[operation][0],
                'P2_PROFILED_INTERRUPTED_SOURCE_OPERATION_NOT_INSTALLED')
        _, status, handler = handlers[operation]
        self.send(identity, status, receipt=handler())

    def _children_quiesced(self):
        if self.operation_active.locked():
            return False
        if self.scope is None:
            return True
        with self.scope.mutations:
            return all(process.poll() is not None for process in self.scope.processes)

    def contain_failure_without_guard(self):
        # The close path waits for all in-process mutations and observers
        # before invoking the source-owned fallback under the held host lock.
        return False

    def _contain_reaped_failure(self):
        from p2_release_supervisor import contain_profiled_interrupted_after_reap
        self.outcome['workerProcessesQuiesced'] = True
        try:
            contain_profiled_interrupted_after_reap(
                self.initial, self.armed_probe, self.source, self.outcome,
                contain_profiled_interrupted_native, contain_profiled_interrupted_frontend,
            )
        except Exception:
            self.outcome['fallbackContainmentUncertain'] = True

    def close(self, committed=False):
        from p2_release_supervisor import sticky_cleanup_signals
        signals = sticky_cleanup_signals() if threading.current_thread() is threading.main_thread() else nullcontext()
        with signals:
            if not committed:
                self.abort()
            if self.observer:
                self.observer.stop_event.set()
            while not self._children_quiesced():
                if self.scope:
                    try:
                        self.scope.revoke()
                    except Exception:
                        self.outcome['workerProcessCleanupUncertain'] = True
                time.sleep(0.1)
            if self.observer:
                self.observer.stop()
            if not committed and not self.guard_alive and self.guard_arm_verified:
                self._contain_reaped_failure()
            super().close(committed)


def main():
    args = sys.argv[1:]
    guarded = args == ['--supervisor-profiled-current']
    require((guarded or args in (['--plan-profiled-current'],['--plan-retained-profiled-current'])) and
            sys.platform == 'linux' and os.geteuid() == 0,
            'P2_PROFILED_INTERRUPTED_FIXED_LINUX_ENTRY_REQUIRED')
    raw = sys.stdin.buffer.readline(MAXIMUM + 1) if guarded else sys.stdin.buffer.read(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and (not guarded or raw.endswith(b'\n')),
            'P2_PROFILED_INTERRUPTED_PACKET_REQUIRED')
    initial = decode_qualification_target_json(raw, 'private-packet')
    source = Path(__file__).resolve().parents[3]
    if guarded:
        from p2_release_supervisor import PROFILED_INTERRUPTED_LAYOUT, supervise
        require(set(initial) == INITIAL_FIELDS | PRIVATE_FIELDS and initial['mode'] == MODE,
                'P2_PROFILED_INTERRUPTED_FIXED_PRIVATE_PACKET_REQUIRED')
        validate_profiled_interrupted_packet({key: initial[key] for key in INITIAL_FIELDS})
        supervise(initial, broker_type=P2ProfiledInterruptedKnownAckBroker,
                  observer_type=certification.P2CertificationPhysicalObserver, observer_source=CERTIFICATION_OBSERVER,
                  layout=PROFILED_INTERRUPTED_LAYOUT, native_containment=contain_profiled_interrupted_native,
                  frontend_containment=contain_profiled_interrupted_frontend)
        return
    plan, _, selected, jobs = prepare_profiled_interrupted_input(initial, source)
    retained = plan_retained(initial,source,plan,selected,jobs) if args == ['--plan-retained-profiled-current'] else {}
    print(json.dumps({'version':2,'qualificationTargetProfile':certification._profiled_context(),
        'status':'P2_PROFILED_INTERRUPTED_INPUT_VERIFIED','restorationActionId':plan['restorationActionId'],
        'candidateSha256':plan['candidateSha256'],'frontendPlanSha256':plan['frontendPlan']['planSha256'],
        'requestedFrontier':plan['requestedFrontier'],**retained,'executionEligible':False,'trafficAuthorized':False}, separators=(',', ':')))


if __name__ == '__main__':
    def interrupt(signum, _frame):
        raise SystemExit(128 + signum)

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, interrupt)
    try:
        main()
    except BaseException:
        print('P2_PROFILED_INTERRUPTED_INPUT_REFUSED', file=sys.stderr)
        raise SystemExit(1)
