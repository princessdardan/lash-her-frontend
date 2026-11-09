"""Failure-only containment of the source-selected replacement API runtime."""
import json
import os
from pathlib import Path
import re
import subprocess

import migrate
import p2_prior_gateway
import p2_release_supervisor as supervisor
import release as runtime
import staging_admission
import staging_state


INTENT = 'p2-frontend-replacement-runtime-intent.json'
REVIEW = 'p2-frontend-replacement-runtime-review.json'
RECEIPT = 'p2-frontend-replacement-runtime-containment.json'
LABEL = 'io.lash-her.replacement-write'
PROJECT = 'lash-her-staging'
HELPER = r'lash-p2-profiled-current-image-check-[a-f0-9]{32}'
ID = re.compile(r'[a-f0-9]{64}')
REFUSED = 'P2_REPLACEMENT_RUNTIME_CONTAINMENT_REFUSED'
require = migrate.demand
READBACK_FAILURE = (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError)


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r'(?!0+$)[a-f0-9]{64}', value) is not None


def replacement_write_label(reviewed_plan_sha256):
    require(_digest(reviewed_plan_sha256), REFUSED)
    return f'{LABEL}={reviewed_plan_sha256}'


def _binding(initial, plan):
    from p2_frontend_replacement_parent import PROFILE, WRITE_MODE
    migrate.require_profile(PROFILE, initial, plan)
    release_id = plan['releaseId']
    require(initial.get('mode') == WRITE_MODE and initial.get('environment') == plan.get('environment') == 'staging' and
            isinstance(release_id, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', release_id) and
            migrate.source_commit(plan.get('sourceCommit')) and plan['sourceCommit'] == initial.get('sourceCommit') and
            _digest(plan.get('candidateSha256')) and plan['candidateSha256'] == initial.get('candidateSha256') and
            all(_digest(value) for value in (plan.get('targetSha256'), initial.get('reviewedPlanSha256'),
                                             initial.get('runtimeReviewSha256'))), REFUSED)
    return {'version': 1, 'qualificationTargetProfile': PROFILE, 'environment': 'staging', 'releaseId': release_id,
            'sourceCommit': plan['sourceCommit'], 'candidateSha256': plan['candidateSha256'], 'targetSha256': plan['targetSha256'],
            'reviewedPlanSha256': initial['reviewedPlanSha256'], 'runtimeReviewSha256': initial['runtimeReviewSha256'],
            'trafficAuthorized': False}


def verify_runtime_intent(initial, plan, directory, *, configuration_sha256, api_job_sha256=None, postflight_sha256=None):
    from p2_frontend_replacement_parent import WRITTEN_OBSERVATION, canonical, private_record
    from qualification_target_profile import decode_qualification_target_json
    binding = _binding(initial, plan)
    raw_review = private_record(directory, REVIEW)
    review = decode_qualification_target_json(raw_review, 'carrier')
    intent = decode_qualification_target_json(private_record(directory, INTENT), 'carrier')
    require(type(review) is dict and migrate.file_hash(raw_review) == binding['runtimeReviewSha256'] and
            ('configuration' not in initial or review.get('configuration') == initial['configuration']) and
            type(intent) is dict and set(intent) == {*binding, 'status', 'apiJobSha256', 'configurationSha256',
                    'postflightSha256'} and
            canonical({key: intent[key] for key in binding}) == canonical(binding) and
            intent['status'] == 'P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED' and
            type(intent['apiJobSha256']) is dict and set(intent['apiJobSha256']) == set(migrate.SERVICES) and
            review.get('apiJobSha256') == intent['apiJobSha256'] and review.get('configurationSha256') == configuration_sha256 and
            all(_digest(digest) for digest in intent['apiJobSha256'].values()) and
            (api_job_sha256 is None or intent['apiJobSha256'] == api_job_sha256) and
            type(configuration_sha256) is dict and set(configuration_sha256) == set(staging_state.CONFIGURATION_FILES) and
            all(_digest(digest) for digest in configuration_sha256.values()) and intent['configurationSha256'] == configuration_sha256 and
            (postflight_sha256 is None or intent['postflightSha256'] == postflight_sha256) and
            intent['postflightSha256'] == migrate.file_hash(private_record(directory, WRITTEN_OBSERVATION, 8192)), REFUSED)
    return intent


def _helper_rows(run, pattern, label=None):
    query = ['docker', 'container', 'ls', '--all', '--no-trunc', '--filter', f'name=^/{pattern}$']
    if label is not None:
        query += ['--filter', f'label={label}']
    output = run([*query, '--format', '{{.ID}}|{{.Names}}'], 15).splitlines()
    require(len(output) <= 32, REFUSED)
    rows = {}
    for line in output:
        identity, separator, name = line.partition('|')
        require(separator == '|' and ID.fullmatch(identity) and re.fullmatch(pattern, name) and name not in rows, REFUSED)
        rows[name] = identity
    require(len(set(rows.values())) == len(rows), REFUSED)
    return rows


def _remove_helper(run, name, identity, label):
    actual = run(['docker', 'inspect', '--format', '{{.Name}}|{{index .Config.Labels "' + LABEL + '"}}', identity], 10)
    require(actual == '/' + name + '|' + label.split('=', 1)[1], REFUSED)
    run(['docker', 'rm', '--force', identity], 30)


def cleanup_named_replacement_helper(run, name, release_id, label):
    """Normal path cleanup cannot delete a same-name foreign container."""
    require(re.fullmatch(HELPER, name) or name in {f'lash-migrate-{service}-{release_id}' for service in migrate.SERVICES},
            REFUSED)
    pattern = re.escape(name)
    for actual, identity in _helper_rows(run, pattern, label).items():
        try:
            _remove_helper(run, actual, identity, label)
        except READBACK_FAILURE:
            # Docker --rm may win the race between inventory and explicit
            # cleanup. Only an exact fresh absence can discharge the error.
            if _helper_rows(run, pattern):
                raise
    require(not _helper_rows(run, pattern), REFUSED)


def _reconcile_helpers(run, release_id, label):
    failures, collisions = [], []
    patterns = [(re.escape(f'lash-migrate-{service}-{release_id}'), True) for service in migrate.SERVICES]
    for pattern, exact in [*patterns, (HELPER, False)]:
        try:
            for name, identity in _helper_rows(run, pattern, label).items():
                try:
                    _remove_helper(run, name, identity, label)
                except READBACK_FAILURE:
                    failures.append(name)
        except READBACK_FAILURE:
            failures.append(pattern)
        try:
            if _helper_rows(run, pattern, label):
                failures.append(pattern)
            elif exact:
                collisions.extend(_helper_rows(run, pattern))
        except READBACK_FAILURE:
            failures.append(pattern)
    return not failures, sorted(set(collisions))


def _verify_snapshot(initial, selected, attempt, snapshot, configuration_sha256):
    from qualification_target_profile import decode_qualification_target_json
    require(attempt == attempt.resolve() and snapshot == snapshot.resolve(), REFUSED)
    staging_state.outside_checkout(snapshot)
    candidate = migrate.read_input(attempt / 'migration-input', 'release.candidate.json')
    require(staging_state.configuration_hashes(snapshot) == configuration_sha256 and
            'sha256:' + migrate.file_hash(migrate.read_input(snapshot, 'compose.yaml')) == selected['runtime']['composeSha256'] and
            migrate.file_hash(candidate) == initial['candidateSha256'] and
            decode_qualification_target_json(candidate, 'carrier') == selected,
            REFUSED)


def _compose_inventory(run, snapshot, selected, snapshot_verified):
    labels = ('{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|'
              '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|'
              '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|'
              '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
    output = run(['docker', 'container', 'ls', '--all', '--no-trunc', '--filter',
                  f'label=com.docker.compose.project={PROJECT}', '--format', '{{.ID}}'], 15).splitlines()
    require(len(output) <= 32 and len(set(output)) == len(output) and all(ID.fullmatch(identity) for identity in output), REFUSED)
    members, unknown, image_ids = {}, 0, {}
    for identity in output:
        try:
            actual = run(['docker', 'inspect', '--format', labels, identity], 10).split('|')
            require(len(actual) == 8 and actual[0] == identity and actual[3] in ('true', 'false') and
                    actual[4] == PROJECT and actual[5] in runtime.SERVICES and snapshot_verified and
                    actual[6:] == [str(snapshot), str(snapshot / 'compose.yaml')], REFUSED)
            service = actual[5]
            image = selected['artifacts'][runtime.IMAGE_KEYS[service]]['image']
            require(actual[2] == image, REFUSED)
            if image not in image_ids:
                image_ids[image] = run(['docker', 'image', 'inspect', '--platform', 'linux/amd64', '--format', '{{.Id}}', image], 10)
            require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_ids[image]) and
                    actual[1] in (image_ids[image], image.split('@')[1]), REFUSED)
            if service == 'gateway':
                mounted = p2_prior_gateway._mounted_configuration(identity, lambda args, _env, timeout: run(args, timeout), lambda: None)
                require(mounted == snapshot, REFUSED)
            members[identity] = {'service': service, 'running': actual[3] == 'true'}
        except READBACK_FAILURE:
            unknown += 1
    return members, unknown


def _close_gateway(run, initial, selected, snapshot, members, result):
    gateways = [identity for identity, value in members.items() if value['service'] == 'gateway']
    require(len(gateways) <= 1, REFUSED)
    binding = {'releaseId': selected['releaseId'], 'candidateSha256': initial['candidateSha256']}
    gateway = migrate.read_json(snapshot, 'gateway.json')
    require(gateway.get('admission') == {'file': '/admission/state.json', **binding}, REFUSED)
    admission = snapshot / 'admission'
    if not gateways and not os.path.lexists(admission):
        return
    digest = staging_admission.persist_state(snapshot, binding, 'p2-replacement-failed-' + selected['releaseId'],
                                            new_work=False, recovery=False)
    result['closedGatewayAdmissionSha256'] = digest
    if gateways and members[gateways[0]]['running']:
        response = json.loads(run(['docker', 'exec', gateways[0], 'node', '--input-type=module', '--eval',
            'const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(1);process.stdout.write(await r.text())'], 5))
        require(type(response) is dict and response.get('valid') is True and response.get('sha256') == digest and response.get('newWork') is False and
                response.get('recovery') is False and all(
                    type(response.get(field)) is dict and set(response[field]) == {'newWork', 'recovery'} and
                    all(type(count) is int and count >= 0 for count in response[field].values())
                    for field in ('active', 'uncertain')), REFUSED)
        result['gatewayAdmissionAcknowledged'] = True
        result['gatewayObservedCounts'] = {field: response[field] for field in ('active', 'uncertain')}


def contain_replacement_runtime_after_reap(initial, plan, selected, directory, *, configuration_sha256, worker_reaped):
    """Use retained identities and actual Docker readback. Never rerun a mutation."""
    from p2_frontend_replacement_parent import canonical, private_record
    from qualification_target_profile import decode_qualification_target_json

    binding = _binding(initial, plan)
    migrate.require_profile(binding['qualificationTargetProfile'], selected)
    release_id = binding['releaseId']
    results = Path(initial['results'])
    require(results == results.resolve() and directory == results / ('p2-profiled-replacement-write-' + release_id) and
            directory == directory.resolve() and type(worker_reaped) is bool and
            selected.get('releaseId') == release_id and selected.get('environment') == 'staging' and
            selected.get('sources', {}).get('frontend', {}).get('commit') == binding['sourceCommit'], REFUSED)
    supervisor.verify_guard_lock(initial)
    staging_state.outside_checkout(directory)
    uncertain, observed = ('P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_UNCERTAIN',
                           'P2_FRONTEND_REPLACEMENT_RUNTIME_CONTAINMENT_OBSERVED_REQUIRES_REVIEW')
    result = {**binding, 'status': uncertain, 'workerProcessesReaped': worker_reaped, 'runtimeIntentVerified': False,
              'snapshot': 'unobserved', 'ownedHelpersAbsent': False, 'foreignMigrationNames': [], 'replacementRuntimeStopped': False,
              'ownedRuntimeContainersStopped': False, 'unboundProjectContainers': None, 'closedGatewayAdmissionSha256': None,
              'gatewayAdmissionAcknowledged': None, 'gatewayObservedCounts': None, 'daemonOperationCompletionVerified': False,
              'frontendSqlReplayed': False, 'automaticReplayAuthorized': False, 'releaseAccepted': False}
    if os.path.lexists(directory / RECEIPT):
        retained = decode_qualification_target_json(private_record(directory, RECEIPT), 'carrier')
        require(type(retained) is dict and set(retained) == set(result) and
                canonical({key: retained[key] for key in binding}) == canonical(binding) and
                retained['status'] in (uncertain, observed) and all(retained[key] is False for key in (
                    'daemonOperationCompletionVerified', 'frontendSqlReplayed', 'automaticReplayAuthorized', 'releaseAccepted')), REFUSED)
        return retained

    def run(args, timeout):
        supervisor.verify_guard_lock(initial)
        require(runtime._command_scope.get() is None, REFUSED)
        output = runtime.command(args, runtime.SAFE_ENV, timeout)
        supervisor.verify_guard_lock(initial)
        return output

    try:
        if not worker_reaped:
            return result
        try:
            verify_runtime_intent(initial, plan, directory, configuration_sha256=configuration_sha256)
            result['runtimeIntentVerified'] = True
        except (OSError, ValueError):
            pass  # Reviewed in-memory identities still allow scoped containment.
        label = replacement_write_label(binding['reviewedPlanSha256'])
        _, result['foreignMigrationNames'] = _reconcile_helpers(run, release_id, label)
        attempt = results / ('runtime-profiled-frontend-replacement-' + release_id)
        snapshot = attempt / 'configuration'
        verified = False
        if not os.path.lexists(snapshot):
            result['snapshot'] = 'absent'
        else:
            try:
                _verify_snapshot(initial, selected, attempt, snapshot, configuration_sha256)
                verified = True
            except (OSError, ValueError, KeyError):
                pass
            result['snapshot'] = 'verified' if verified else 'unknown'
        before, unbound = _compose_inventory(run, snapshot, selected, verified)
        result['unboundProjectContainers'] = unbound
        if verified:
            try:
                supervisor.verify_guard_lock(initial)
                _verify_snapshot(initial, selected, attempt, snapshot, configuration_sha256)
                _close_gateway(run, initial, selected, snapshot, before, result)
            except READBACK_FAILURE:
                result['gatewayAdmissionAcknowledged'] = False
        running = sorted(identity for identity, value in before.items() if value['running'])
        stop_refused = False
        if running:
            try:
                _verify_snapshot(initial, selected, attempt, snapshot, configuration_sha256)
                grace = 60 if any(before[identity]['service'] in ('course-media', 'course-export-cleanup') for identity in running) else 30
                run(['docker', 'stop', '--timeout', str(grace), *running], grace + 30)
            except READBACK_FAILURE:
                stop_refused = True
        after, unbound_after = _compose_inventory(run, snapshot, selected, verified)
        result['unboundProjectContainers'] = max(unbound, unbound_after)
        if verified:
            try:
                _verify_snapshot(initial, selected, attempt, snapshot, configuration_sha256)
            except READBACK_FAILURE:
                result['snapshot'] = 'unknown'
        result['ownedRuntimeContainersStopped'] = not stop_refused and set(after) <= set(before) and not any(
            row['running'] for row in after.values())
        result['replacementRuntimeStopped'] = (result['snapshot'] != 'unknown' and result['ownedRuntimeContainersStopped']
                                               and not unbound_after)
        # A daemon launch already in flight can materialize while Compose is
        # being stopped. Require a fresh, scoped reconciliation of helpers.
        result['ownedHelpersAbsent'], late_collisions = _reconcile_helpers(run, release_id, label)
        result['foreignMigrationNames'] = sorted(set(result['foreignMigrationNames']) | set(late_collisions))
        supervisor.verify_guard_lock(initial)
        observed_counts = result['gatewayObservedCounts'] or {}
        if (result['runtimeIntentVerified'] and result['snapshot'] != 'unknown' and result['ownedHelpersAbsent'] and
                not result['foreignMigrationNames'] and result['replacementRuntimeStopped'] and not result['unboundProjectContainers'] and
                result['gatewayAdmissionAcknowledged'] is not False and
                not any(count for category in observed_counts.values() for count in category.values())):
            result['status'] = observed
        return result
    except READBACK_FAILURE:
        return result
    finally:
        migrate.write_json(directory, RECEIPT, result)
