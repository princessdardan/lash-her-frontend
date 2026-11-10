"""Read-only verification of a reviewed replacement runtime continuation."""

import base64
from pathlib import Path
import re

import migrate
import p2_prior_gateway
from p2_certification_fault import frontend_target_sha256
from p2_certification_profile import RUNTIME_FLAGS, require_profile as require_certification_profile
from p2_source_closure import PROFILED_REPLACEMENT_WRITE_MODE
import release as runtime
import staging_state
from qualification_target_profile import (
    STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE,
    decode_qualification_target_json,
)


REFUSED = 'P2_REPLACEMENT_RUNTIME_REVIEW_REFUSED'
STAGING_ROOT = Path('/var/lib/lash-her/releases/staging')
PROFILE = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
MAXIMUM = 65_536
FIELDS = frozenset((
    'version', 'qualificationTargetProfile', 'environment', 'releaseId', 'sourceCommit',
    'candidateSha256', 'targetSha256', 'reviewedPlanSha256', 'hostMachineId', 'configuration',
    'configurationSha256', 'apiJobSha256', 'certification', 'producerSha256',
))
TARGET_FIELDS = ('host', 'port', 'database', 'user', 'runtimeRole', 'serverMajor')


def require(condition):
    migrate.demand(condition, REFUSED)


def digest(value):
    return type(value) is str and re.fullmatch(r'(?!0+$)[a-f0-9]{64}', value) is not None


def private_staging_directory(value):
    require(type(value) is str and 0 < len(value) <= 4096 and ',' not in value and
            all(32 <= ord(character) < 127 for character in value))
    path = Path(value)
    require(str(path) == value and path == path.resolve() and STAGING_ROOT in path.parents)
    staging_state.outside_checkout(path)
    return path


def reviewed_bytes(initial):
    value, expected = initial['runtimeReviewBytes'], initial['runtimeReviewSha256']
    require(digest(expected) and type(value) is str and 0 < len(value) <= 4 * ((MAXIMUM + 2) // 3))
    raw = base64.b64decode(value, validate=True)
    require(0 < len(raw) <= MAXIMUM and base64.b64encode(raw).decode('ascii') == value and migrate.file_hash(raw) == expected)
    return raw


def _prepare_runtime_review(initial, plan, source, probe):
    require(type(plan) is dict and type(probe) is dict)
    review = decode_qualification_target_json(reviewed_bytes(initial), 'carrier')
    require(type(review) is dict and set(review) in (FIELDS, FIELDS | {'priorGatewayReference'}) and
            type(review['version']) is int and review['version'] == 1 and
            initial['mode'] == PROFILED_REPLACEMENT_WRITE_MODE and
            type(probe.get('version')) is int and probe['version'] == 1 and probe['operation'] == 'verify-pre-bootstrap-lock' and
            review['environment'] == initial['environment'] == plan['environment'] == 'staging')
    migrate.require_profile(PROFILE, initial, plan, probe, review)
    require(review['releaseId'] == plan['releaseId'] and
            review['sourceCommit'] == plan['sourceCommit'] == initial['sourceCommit'] and
            migrate.source_commit(review['sourceCommit']) and
            review['candidateSha256'] == plan['candidateSha256'] == initial['candidateSha256'] and
            review['targetSha256'] == plan['targetSha256'] == probe['targetSha256'] and
            review['reviewedPlanSha256'] == initial['reviewedPlanSha256'] and
            all(digest(review[key]) for key in ('candidateSha256', 'targetSha256', 'reviewedPlanSha256', 'producerSha256')) and
            review['hostMachineId'] == initial['hostMachineId'] and type(review['hostMachineId']) is str and
            re.fullmatch(r'(?!0+$)[a-f0-9]{32}', review['hostMachineId']) is not None)
    require_certification_profile(review['certification'])
    if 'priorGatewayReference' in review:
        require(type(review['priorGatewayReference']) is dict)
        p2_prior_gateway._validate_reference(review)
        for key, value in review['priorGatewayReference'].items():
            if key.endswith('Directory'):
                require(str(Path(value)) == value and STAGING_ROOT in Path(value).parents)
    for key, names in (('apiJobSha256', migrate.SERVICES), ('configurationSha256', staging_state.CONFIGURATION_FILES)):
        pins = review[key]
        require(type(pins) is dict and set(pins) == set(names) and all(digest(value) for value in pins.values()))

    configuration = private_staging_directory(review['configuration'])
    bundle = private_staging_directory(initial['bundle'])
    require(configuration != bundle and configuration not in bundle.parents and bundle not in configuration.parents)
    require(staging_state.configuration_hashes(configuration) == review['configurationSha256'])
    require(migrate.profiled_current_job_hashes(bundle) == review['apiJobSha256'])
    source = Path(source)
    require(source == source.resolve())
    selected, jobs, runtime_plan, _compose = runtime.make_plan(
        bundle, configuration, source / 'ops/platform/compose.yaml', expected_profile=PROFILE)
    require(set(jobs) == {*migrate.SERVICES, 'frontend'} and selected == probe['candidate'] and
            selected['environment'] == 'staging' and selected['contractPhase'] == 'p2' and
            selected['releaseId'] == review['releaseId'] and
            selected['sources']['frontend']['commit'] == review['sourceCommit'] and
            runtime_plan['hostMachineId'] == review['hostMachineId'])
    frontend = jobs['frontend']
    job, replacement = frontend['job'], plan['replacement']
    target = job['target']
    require(job == probe['job'] and decode_qualification_target_json(frontend['schema'], 'carrier') == probe['baseline'] and
            {key: target[key] for key in TARGET_FIELDS} == replacement['target'] and
            frontend_target_sha256(target) == review['targetSha256'] and
            target['allowEmptyBootstrap'] is True and bool(target['approvedPendingTags']) and
            target['approvedPendingTags'] == replacement['approvedPendingTags'] and
            probe['predecessorTarget'] == plan['predecessor']['target'] and
            probe['databaseOid'] == replacement['databaseOid'] and probe['migrationRoleOid'] == replacement['migrationRoleOid'])
    for name, value, pin in (
        ('release.candidate.json', selected, review['candidateSha256']),
        ('jobs/frontend.json', job, plan['frontendJobSha256']),
        ('schema/frontend.json', probe['baseline'], plan['schemaBaselineFileSha256']),
        *((f'jobs/{service}.json', jobs[service]['job'], pin) for service, pin in review['apiJobSha256'].items()),
    ):
        raw = migrate.read_input(bundle, name)
        require(migrate.file_hash(raw) == pin and decode_qualification_target_json(raw, 'carrier') == value)

    runtime.validate_snapshot_source(configuration, selected, jobs, expected_profile=PROFILE)
    gateway = migrate.read_json(configuration, 'gateway.json', expected_profile=PROFILE)
    require(gateway.get('admission') == {'file': '/admission/state.json', 'releaseId': review['releaseId'],
                                        'candidateSha256': review['candidateSha256']})
    for service, flags in RUNTIME_FLAGS.items():
        values = runtime.environment_values(migrate.read_input(configuration, service + '.env', 65_536),
                                            'staging', service, jobs, expected_profile=PROFILE)
        require(all(values.get(key) == value for key, value in flags.items()))
    require(staging_state.configuration_hashes(configuration) == review['configurationSha256'] and
            migrate.profiled_current_job_hashes(bundle) == review['apiJobSha256'])
    return review


def prepare_runtime_review(initial, plan, source, probe):
    """Return reviewed metadata only. Its presence grants no runtime authority."""
    try:
        require(type(initial) is dict)
        if 'runtimeReviewBytes' not in initial and 'runtimeReviewSha256' not in initial:
            return None
        return _prepare_runtime_review(initial, plan, source, probe)
    except (OSError, ValueError, TypeError, KeyError):
        # Runtime configuration validation may parse secret-bearing env values.
        raise ValueError(REFUSED) from None
