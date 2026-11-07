"""Profiled interrupted known-ACK operator preflight and fixed host inputs."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import p2_certification_parent as certification
import release as runtime
import staging_state
import vercel
from p2_source_closure import PROFILED_INTERRUPTED_MODE as MODE, verify_profiled_current_source_closure
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
        'targetSha256':initial['targetSha256'],**migrate.contract_identity(candidate),
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


def main():
    import os
    require(sys.argv[1:] in (['--plan-profiled-current'],['--plan-retained-profiled-current']) and
            sys.platform == 'linux' and os.geteuid() == 0,
            'P2_PROFILED_INTERRUPTED_FIXED_LINUX_PLAN_REQUIRED')
    raw = sys.stdin.buffer.read(4_000_001)
    require(0 < len(raw) <= 4_000_000, 'P2_PROFILED_INTERRUPTED_PACKET_REQUIRED')
    initial = decode_qualification_target_json(raw, 'private-packet')
    source = Path(__file__).resolve().parents[3]
    plan, _, selected, jobs = prepare_profiled_interrupted_input(initial, source)
    retained = plan_retained(initial,source,plan,selected,jobs) if sys.argv[1] == '--plan-retained-profiled-current' else {}
    print(json.dumps({'version':2,'qualificationTargetProfile':certification._profiled_context(),
        'status':'P2_PROFILED_INTERRUPTED_INPUT_VERIFIED','restorationActionId':plan['restorationActionId'],
        'candidateSha256':plan['candidateSha256'],'frontendPlanSha256':plan['frontendPlan']['planSha256'],
        'requestedFrontier':plan['requestedFrontier'],**retained,'executionEligible':False,'trafficAuthorized':False}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('P2_PROFILED_INTERRUPTED_INPUT_REFUSED', file=sys.stderr)
        raise SystemExit(1)
