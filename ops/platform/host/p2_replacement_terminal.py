"""Exact replacement runtime, provider and terminal receipt joins."""
import json
from pathlib import Path

import migrate
import p2_prior_gateway
from p2_profiled_current_parent import PROOF_FIELDS, WORKLOAD_FIELDS
import release as runtime
import staging_state
import vercel


FRONTEND_STATUS = 'P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED'
TERMINAL_STATUS = 'P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION'
INTENT_STATUS = 'P2_FRONTEND_REPLACEMENT_WRITE_COMMIT_INTENT'
INTENT = 'p2-frontend-replacement-write-commit-intent.json'
TERMINAL = 'p2-frontend-replacement-write-outcome.json'
PROVIDER_FILES = ('frontend-deployment-proof.json', 'frontend-workload-outcome.json', 'frontend-promotion-outcome.json')
NODE_FILES = ('frontend-job-outcome.json', 'frontend-continuation-completed.json', 'frontend-release-outcome.json')
SESSION_CLOSED = 'frontend-session-closed.json'
FALSE_FLAGS = ('frontendSqlReplayed', 'historicalProviderClosureClaimed', 'oldP200Qualified',
               'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted')
PROVENANCE = ('postflightSha256', 'reviewedPlanSha256', 'runtimeReviewSha256', 'runtimeOutcomeSha256', 'migrationOutcomeSha256')


def release_base(initial, plan, review, selected, postflight, api):
    from p2_frontend_replacement_parent import PROFILE
    return {'version': 2, 'qualificationTargetProfile': PROFILE, 'environment': 'staging',
            'releaseId': plan['releaseId'], 'sourceCommit': plan['sourceCommit'], 'targetSha256': plan['targetSha256'],
            'candidateSha256': plan['candidateSha256'], 'configurationSha256': review['configurationSha256'],
            'postflightSha256': migrate.file_hash(postflight), 'reviewedPlanSha256': initial['reviewedPlanSha256'],
            'runtimeReviewSha256': initial['runtimeReviewSha256'],
            'runtimeOutcomeSha256': migrate.file_hash(api['runtimeRaw']), 'migrationOutcomeSha256': migrate.file_hash(api['migrationRaw']),
            'frontendSqlApplied': True, **dict.fromkeys(FALSE_FLAGS, False), **migrate.contract_identity(selected)}


def exact_receipt(raw, maximum=65_536):
    from p2_frontend_replacement_parent import PROFILE, REFUSED, require
    from qualification_target_profile import decode_qualification_target_json
    require(type(raw) is bytes and 0 < len(raw) <= maximum and raw.endswith(b'\n'), REFUSED)
    value = decode_qualification_target_json(raw, 'carrier')
    require(type(value) is dict and type(value.get('version')) is int and value['version'] == 2, REFUSED)
    migrate.require_profile(PROFILE, value)
    return value


def read_api(initial, plan, review, selected, directory, written, postflight):
    from p2_frontend_replacement_parent import REFUSED, require, private_record, unbase64
    from p2_replacement_runtime_containment import verify_runtime_intent
    from qualification_target_profile import decode_qualification_target_json
    verify_runtime_intent(initial, plan, directory, configuration_sha256=review['configurationSha256'],
                          api_job_sha256=review['apiJobSha256'], postflight_sha256=migrate.file_hash(postflight))
    results, release_id = Path(initial['results']), plan['releaseId']
    attempt = results / ('runtime-profiled-frontend-replacement-' + release_id)
    migration = results / ('migration-profiled-frontend-replacement-' + release_id)
    snapshot = attempt / 'configuration'
    for path in (attempt, migration, snapshot):
        require(path == path.resolve(), REFUSED)
        staging_state.outside_checkout(path)
    runtime_raw = private_record(attempt, 'runtime-outcome.json')
    migration_raw = private_record(migration, 'migration-outcome.json')
    observed, migrated = exact_receipt(runtime_raw), exact_receipt(migration_raw)
    candidate = migrate.read_input(attempt / 'migration-input', 'release.candidate.json')
    require(migrate.file_hash(candidate) == plan['candidateSha256'] and
            candidate == migrate.read_input(migration, 'candidate.json') and
            decode_qualification_target_json(candidate, 'carrier') == selected and
            staging_state.configuration_hashes(snapshot) == review['configurationSha256'] and
            'sha256:' + migrate.file_hash(migrate.read_input(snapshot, 'compose.yaml')) == selected['runtime']['composeSha256'], REFUSED)
    database, started = unbase64(written['databaseReceipt'], 65_536), unbase64(written['continuationStarted'], 8192)
    original_names = ('frontend-original-database-receipt.json', 'frontend-continuation-started.json',
                      'frontend-replacement-written-observation.json')
    migration_names = ('database-receipt.json', 'frontend-continuation-started.json', 'frontend-replacement-written-observation.json')
    for name, copy_name, raw in zip(original_names, migration_names, (database, started, postflight)):
        require(private_record(directory, name) == raw and private_record(migration / 'frontend', copy_name) == raw, REFUSED)
    for service in migrate.SERVICES:
        name = f'jobs/{service}.json'
        raw = migrate.read_input(Path(initial['bundle']), name)
        require(migrate.file_hash(raw) == review['apiJobSha256'][service] and
                raw == migrate.read_input(attempt / 'migration-input', name) and
                raw == migrate.read_input(migration / (service + '-input'), 'job.json'), REFUSED)
    for value in (observed, migrated):
        migrate.require_contract_identity(selected, value)
        require(value.get('phase') == 'completed' and value.get('environment') == 'staging' and
                value.get('releaseId') == release_id and value.get('candidateSha256') == plan['candidateSha256'] and
                value.get('frontendSqlApplied') is True and value.get('frontendMigrationMode') == 'apply-forward' and
                value.get('frontendReadOnlyVerified') is False and
                all(value.get(key) is False for key in FALSE_FLAGS) and
                value.get('frontendReplacementReadbackSha256') == migrate.file_hash(postflight) and
                value.get('frontendContinuationStartedSha256') == migrate.file_hash(started), REFUSED)
    pins = migrated.get('databaseReceiptSha256')
    require(type(pins) is dict and set(pins) == {'frontend', *migrate.SERVICES} and
            pins['frontend'] == migrate.file_hash(database) and
            all(migrate.file_hash(migrate.read_input(migration, f'{service}/database-receipt.json')) == pins[service]
                for service in migrate.SERVICES) and
            migrated['status'] == 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN' and
            observed['status'] == 'API_RUNTIME_READY' and observed.get('sourceCommit') == plan['sourceCommit'] and
            observed.get('configurationSha256') == review['configurationSha256'] and
            observed.get('migrationOutcomeSha256') == migrate.file_hash(migration_raw), REFUSED)
    return {'runtimeRaw': runtime_raw, 'migrationRaw': migration_raw, 'outcome': observed, 'snapshot': snapshot}


def verify_runtime(initial, selected, api, verify):
    from p2_frontend_replacement_parent import PROFILE, REFUSED, match, require
    verify()
    snapshot = api['snapshot']
    containers = runtime.check_containers(selected, snapshot, expected_profile=PROFILE)
    require(containers == api['outcome']['containers'], REFUSED)
    gateways = [row['containerId'] for row in containers if row['service'] == 'gateway']
    require(len(gateways) == 1 and match(gateways[0], r'[a-f0-9]{12,64}') and
            p2_prior_gateway._mounted_configuration(gateways[0], runtime.command, verify) == snapshot, REFUSED)
    value = json.loads(runtime.command(['docker', 'exec', gateways[0], 'node', '--input-type=module', '--eval',
        'const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(1);process.stdout.write(await r.text())'],
        runtime.SAFE_ENV, 5))
    raw = migrate.read_input(snapshot, 'admission/state.json', 8192)
    state = json.loads(raw)
    require(type(state) is dict and state.get('environment') == 'staging' and state.get('releaseId') == selected['releaseId'] and
            state.get('candidateSha256') == initial['candidateSha256'] and state.get('newWork') is False and state.get('recovery') is False and
            type(value) is dict and value.get('valid') is True and value.get('sha256') == migrate.file_hash(raw) and
            value.get('newWork') is False and value.get('recovery') is False and all(
                type(value.get(field)) is dict and set(value[field]) == {'newWork', 'recovery'} and
                all(type(count) is int and count == 0 for count in value[field].values()) for field in ('active', 'uncertain')), REFUSED)
    verify()


def verify_provider(raw, base, selected, plan, review, written, client, verify):
    from p2_frontend_replacement_parent import PROFILE, REFUSED, canonical, match, require
    _, workload_raw, promotion_raw = raw
    proof, workload, promotion = (exact_receipt(value) for value in raw)
    environment, project_id, source_commit = vercel.release_identity(selected, expected_profile=PROFILE)
    identity = {'environment': environment, 'projectId': project_id, 'releaseId': base['releaseId'],
                'sourceCommit': source_commit, 'deploymentId': proof.get('deploymentId')}
    deployment = identity['deploymentId']
    previous = promotion.get('previousDeploymentId')
    require(match(deployment, r'dpl_[A-Za-z0-9]+') and match(previous, r'dpl_[A-Za-z0-9]+') and
            previous == plan['predecessor']['deploymentId'] and previous != deployment, REFUSED)
    fields = {*PROOF_FIELDS, *PROVENANCE, 'frontendSqlReplayed', 'frontendPromotionReceiptSha256'}
    writer = {'mode': 'enforce', 'targetSha256': base['targetSha256'], 'producerSha256': written['producerSha256'],
              'sourceCommit': source_commit, 'roleName': written['runtime']['name']}
    require(set(proof) == fields and set(workload) == WORKLOAD_FIELDS and
            all(canonical(proof.get(key)) == canonical(value) for key, value in base.items()) and
            all(all(value.get(key) == selected_value for key, selected_value in identity.items())
                for value in (proof, workload, promotion)) and
            proof['status'] == FRONTEND_STATUS and proof['actionId'] == base['releaseId'] and proof['readyState'] == 'READY' and
            proof['aliasJobState'] == 'succeeded' and proof['aliasJobType'] == 'promote' and
            proof['aliasDeploymentId'] == proof['aliasJobDeploymentId'] == deployment and
            proof['aliasJobMatchesIntent'] is True and proof['workloadVerified'] is True and
            proof['admissionNewWork'] is False and proof['admissionRecovery'] is False and
            proof['frontendPromotionReceiptSha256'] == migrate.file_hash(promotion_raw) and
            proof['workloadReceiptSha256'] == proof['configurationRecordSha256'] == migrate.file_hash(workload_raw) and
            workload['status'] == 'FRONTEND_VERIFIED' and workload['phase'] == 'completed' and
            workload['trafficAuthorized'] is False and workload['nativeSchedulerVerified'] is False and
            workload['previousDeploymentId'] == previous and workload['checks'] == ['frontend-server-gateway-course-catalog-p2'] and
            canonical(proof['featureControls']) == canonical(workload['featureControls']) == canonical(review['certification']['featureControls']) and
            proof['writerAdmissionBinding'] == workload['writerAdmissionBinding'] == writer, REFUSED)
    migrate.require_contract_identity(selected, workload, proof)
    old, requested = promotion.get('previousAliasRequestedAt'), promotion.get('aliasRequestedAt')
    require(set(promotion) == {*identity, 'version', 'qualificationTargetProfile', 'previousDeploymentId',
                'previousAliasRequestedAt', 'aliasRequestedAt', 'status', 'phase', 'trafficAuthorized',
                'gatewayTrafficAuthorized', 'frontendDomainsPromoted'} and
            type(old) is int and type(requested) is int and 0 <= old < requested and
            promotion['status'] == 'FRONTEND_DOMAINS_PROMOTED' and promotion['phase'] == 'completed' and
            promotion['trafficAuthorized'] is False and promotion['gatewayTrafficAuthorized'] is False and
            promotion['frontendDomainsPromoted'] is True, REFUSED)
    verify()
    state = vercel.deployment_state(client, deployment, project_id, source_commit, base['releaseId'])
    project = vercel._project(client, project_id, rollback_info=True)
    alias, cron = project.get('lastAliasRequest'), project.get('crons') or {}
    require(state.get('readyState') == 'READY' and (project.get('targets') or {}).get('production', {}).get('id') == deployment and
            type(alias) is dict and alias.get('type') == 'promote' and alias.get('jobStatus') == 'succeeded' and
            alias.get('toDeploymentId') == deployment and type(alias.get('requestedAt')) is int and
            alias['requestedAt'] == requested and cron.get('disabledAt') is not None and cron.get('deploymentId') == deployment, REFUSED)
    definitions, schedule = cron.get('definitions'), proof.get('certificationSchedule')
    expected = {'path': '/api/cron/account-lifecycle', 'schedule': '* * * * *', 'host': state['url'].removeprefix('https://')}
    require(type(definitions) is list and len(definitions) == 1 and type(definitions[0]) is dict and
            type(schedule) is dict and set(schedule) == {*expected, 'deploymentId', 'nativeEnabled', 'definitionsSha256'} and
            all(definitions[0].get(key) == value and schedule.get(key) == value for key, value in expected.items()) and
            schedule['deploymentId'] == deployment and schedule['nativeEnabled'] is False and
            schedule['definitionsSha256'] == migrate.file_hash(json.dumps(definitions, separators=(',', ':')).encode()), REFUSED)
    verify()
    return proof


def join_terminal(base, written, provider_raw, node_raw, session_closed, *, status):
    from p2_frontend_replacement_parent import REFUSED, canonical, require, unbase64
    terminal, completed, release = (exact_receipt(raw) for raw in node_raw)
    started = exact_receipt(unbase64(written['continuationStarted'], 8192))
    expected_terminal = {key: value for key, value in started.items() if key not in ('status', 'databaseVerified')}
    proof_sha = migrate.file_hash(provider_raw[0])
    require(canonical(terminal) == canonical({**expected_terminal, 'status': 'DATABASE_VERIFIED',
                'phase': 'completed', 'readOnlyVerified': False}) and
            canonical(completed) == canonical({**started, 'status': 'FRONTEND_CONTINUATION_COMPLETED'}) and
            canonical(release) == canonical({**base, 'status': FRONTEND_STATUS, 'deploymentProofSha256': proof_sha}), REFUSED)
    return {**base, 'status': status, 'frontendSessionClosed': True, 'migrationMode': 'apply-forward',
            'deploymentId': exact_receipt(provider_raw[0])['deploymentId'],
            'owner': written['owner'], 'runtime': written['runtime'], 'producerSha256': written['producerSha256'],
            'frontendDatabaseReceiptSha256': migrate.file_hash(unbase64(written['databaseReceipt'], 65_536)),
            'frontendContinuationStartedSha256': migrate.file_hash(unbase64(written['continuationStarted'], 8192)),
            'frontendDeploymentProofSha256': proof_sha, 'frontendWorkloadReceiptSha256': migrate.file_hash(provider_raw[1]),
            'frontendPromotionReceiptSha256': migrate.file_hash(provider_raw[2]), 'frontendTerminalSha256': migrate.file_hash(node_raw[0]),
            'frontendContinuationCompletedSha256': migrate.file_hash(node_raw[1]), 'frontendReleaseOutcomeSha256': migrate.file_hash(node_raw[2]),
            'frontendSessionClosedSha256': migrate.file_hash(session_closed)}
