#!/usr/bin/env python3
"""Fixed profiled current-only recovery broker.

The release parent owns the actual host flock, frontend observer, API runner and
close protocol. This subclass only selects the closed recovery disposition,
retains original evidence and verifies GET-only frontend/API recovery results.
"""
import copy
import base64
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
from uuid import uuid4

if __name__ == '__main__':
    previous = sys.modules.get('p2_profiled_current_recovery')
    if previous is not None and previous is not sys.modules[__name__]:
        raise SystemExit('P2_PROFILED_CURRENT_RECOVERY_MODULE_IDENTITY_REFUSED')
    sys.modules['p2_profiled_current_recovery'] = sys.modules[__name__]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate
import release as runtime
import current_databases
import vercel
from p2_profiled_current_parent import (
    COMMON, FALSE_FIELDS, LOCK, MAXIMUM, PROFILE, PROGRAM,
    P2ProfiledCurrentBroker, P2ProfiledCurrentPhysicalObserver,
    decode_profiled, encoded, require, require_profiled, sha,
)
from p2_profiled_current_scope import P2ProfiledCurrentScope
from qualification_target_profile import decode_qualification_target_json

MODE = 'p2-profiled-current-recovery'
PREFIX = 'p2-profiled-current-recovery-'
OP = 'profiled-current-recovery'
STATUS = 'PROFILED_CURRENT_RECOVERY'
TERMINAL = 'P2_PROFILED_CURRENT_RECOVERED_FENCED'
TERMINAL_NAME = 'p2-profiled-current-recovery-outcome.json'
DISPOSITIONS = frozenset(('restore-current-runtime', 'reconcile-frontend-get-first',
                          'reconcile-frontend-lost-build-get-first', 'resume-approved-api-suffix'))
ORIGINAL_NAMES = ('candidate', 'frontendDatabase', 'frontendContinuationStarted', 'apiMigrationOutcome',
                  'apiRuntimeOutcome', 'frontendBuildOutcome', 'frontendPromotionStarted', 'frontendWorkloadOutcome')
LOST_BUILD_NAMES = ('deployStarted', 'buildStarted', 'buildIntent')
LAYOUT = {'actionIdKey': 'recoveryActionId', 'receiptPrefix': PREFIX,
          'runtimePrefix': 'runtime-profiled-current-recovery-',
          'migrationPrefix': 'migration-profiled-current-recovery-',
          'terminalName': TERMINAL_NAME, 'terminalStatus': TERMINAL}


def valid_digest(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) and value != '0' * 64


class P2ProfiledCurrentRecoveryPhysicalObserver(P2ProfiledCurrentPhysicalObserver):
    """Same source-fixed observer program and physical checks as release."""
    pass


class P2ProfiledCurrentRecoveryBroker(P2ProfiledCurrentBroker):
    MODE, PREFIX, OP, STATUS, TERMINAL, TERMINAL_NAME = MODE, PREFIX, OP, STATUS, TERMINAL, TERMINAL_NAME
    EXTRA_REQUIRED_INITIAL_FIELDS = frozenset((
        'recoveryActionId', 'originalReleaseId', 'disposition', 'originalReceiptSha256', 'apiJobSha256'))
    EXTRA_OPTIONAL_INITIAL_FIELDS = frozenset(('approvedApiSuffix', 'recoveryApiJobSha256', 'lostBuildReceiptSha256'))

    def action_id(self):
        return self.initial['recoveryActionId']

    def initialize(self):
        super().initialize()
        pins, release_id = self.initial['originalReceiptSha256'], self.selected['releaseId']
        paths = {
            'candidate': (self.bundle, 'release.candidate.json'),
            'frontendDatabase': (self.results / ('p2-profiled-current-' + release_id), 'frontend-original-database-receipt.json'),
            'frontendContinuationStarted': (self.results / ('p2-profiled-current-' + release_id), 'frontend-continuation-started.json'),
            'apiMigrationOutcome': (self.results / release_id, 'migration-outcome.json'),
            'apiRuntimeOutcome': (self.results / ('runtime-' + release_id), 'runtime-outcome.json'),
        }
        require(all(key not in pins or sha(migrate.read_input(directory, name)) == pins[key]
                    for key, (directory, name) in paths.items()) and
                all(key in paths for key in pins if key in ORIGINAL_NAMES[:5]),
                'P2_PROFILED_CURRENT_ORIGINAL_HOST_RECEIPTS_REQUIRED')
        self.original_started_directory = self.results / ('p2-profiled-current-' + release_id)
        started_raw = migrate.read_input(self.original_started_directory, 'p2-profiled-current-started.json')
        started = decode_qualification_target_json(started_raw, 'carrier')
        require_profiled(started)
        require(started.get('status') == 'P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW' and
                started.get('releaseId') == release_id and started.get('sourceCommit') == self.initial['sourceCommit'] and
                started.get('candidateSha256') == self.initial['candidateSha256'] and
                started.get('configurationSha256') == self.initial['configurationSha256'] and
                started.get('targetSha256') == self.initial['targetSha256'] and
                started.get('inventorySha256') == self.initial['inventorySha256'] and
                started.get('apiJobSha256') == self.initial['apiJobSha256'],
                'P2_PROFILED_CURRENT_ORIGINAL_STARTED_BINDING_REQUIRED')
        self.original_started_raw = started_raw

    def check(self):
        super().check()
        if hasattr(self, 'original_started_raw'):
            require(migrate.read_input(self.original_started_directory, 'p2-profiled-current-started.json') == self.original_started_raw,
                    'P2_PROFILED_CURRENT_ORIGINAL_STARTED_CHANGED')
        if hasattr(self, 'derived_bundle'):
            require(sha(migrate.read_input(self.derived_bundle, 'release.candidate.json')) == self.initial['candidateSha256'] and
                    all(sha(migrate.read_input(self.derived_bundle / 'jobs', service + '.json')) ==
                        self.initial['recoveryApiJobSha256'][service] for service in ('course', 'community')) and
                    all(sha(migrate.read_input(self.original_bundle / 'jobs', service + '.json')) ==
                        self.initial['apiJobSha256'][service] for service in ('course', 'community')),
                    'P2_PROFILED_CURRENT_RECOVERY_JOB_BYTES_CHANGED')
        if hasattr(self, 'lost_build_observation'):
            raw = migrate.read_input(self.directory, 'frontend-lost-build-observation.json')
            require(sha(raw) == self.lost_build_observation_sha256 and
                    decode_qualification_target_json(raw, 'carrier') == self.lost_build_observation,
                    'P2_PROFILED_CURRENT_LOST_BUILD_OBSERVATION_CHANGED')

    def record_base(self, status):
        value = super().record_base(status)
        value.update(recoveryActionId=self.action_id(), originalReleaseId=self.selected['releaseId'],
                     disposition=self.initial['disposition'],
                     apiJobSha256=copy.deepcopy(self.initial['apiJobSha256']),
                     originalReceiptSha256=copy.deepcopy(self.initial['originalReceiptSha256']))
        if self.initial['disposition'] == 'resume-approved-api-suffix':
            value['recoveryApiJobSha256'] = copy.deepcopy(self.initial['recoveryApiJobSha256'])
        if self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first':
            value['lostBuildReceiptSha256'] = copy.deepcopy(self.initial['lostBuildReceiptSha256'])
        return value

    def select_release(self, initial):
        selected, jobs, plan, compose = super().select_release(initial)
        receipts = initial.get('originalReceiptSha256')
        api_jobs = initial.get('apiJobSha256')
        require(type(initial.get('recoveryActionId')) is str and
                re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', initial['recoveryActionId']) and
                initial['recoveryActionId'] != selected['releaseId'] and
                initial.get('originalReleaseId') == selected['releaseId'] and
                initial.get('disposition') in DISPOSITIONS and
                type(api_jobs) is dict and tuple(sorted(api_jobs)) == ('community', 'course') and
                all(valid_digest(value) for value in api_jobs.values()) and
                type(receipts) is dict and tuple(receipts) == ORIGINAL_NAMES[:len(receipts)] and
                ((initial.get('disposition') == 'resume-approved-api-suffix' and
                  len(receipts) in (3, 4, len(ORIGINAL_NAMES))) or
                 (initial.get('disposition') == 'restore-current-runtime' and
                  len(receipts) in (3, 4, 5, len(ORIGINAL_NAMES))) or
                 (initial.get('disposition') == 'reconcile-frontend-lost-build-get-first' and len(receipts) == 5) or
                 (initial.get('disposition') == 'reconcile-frontend-get-first' and
                  len(receipts) == len(ORIGINAL_NAMES))) and
                all(valid_digest(value) for value in receipts.values()),
                'P2_PROFILED_CURRENT_RECOVERY_BINDING_REQUIRED')
        suffix = initial.get('approvedApiSuffix')
        recovery_hashes = initial.get('recoveryApiJobSha256')
        if initial['disposition'] == 'resume-approved-api-suffix':
            require(type(suffix) is dict and set(suffix) == {'course', 'community'} and
                    all(type(value) is list and all(type(tag) is str and re.fullmatch(r'\d{4}_[a-z0-9_]+', tag)
                                                    for tag in value) for value in suffix.values()) and
                    sum(len(value) for value in suffix.values()) > 0,
                    'P2_PROFILED_CURRENT_API_SUFFIX_REQUIRED')
            require(type(recovery_hashes) is dict and tuple(sorted(recovery_hashes)) == ('community', 'course') and
                    all(valid_digest(value) for value in recovery_hashes.values()) and
                    all(jobs[name]['job']['target'].get('allowEmptyBootstrap') is False and
                        len(suffix[name]) <= len(jobs[name]['job']['target']['approvedPendingTags']) and
                        (not suffix[name] or jobs[name]['job']['target']['approvedPendingTags'][-len(suffix[name]):] == suffix[name])
                        for name in ('course', 'community')),
                    'P2_PROFILED_CURRENT_API_SUFFIX_JOB_MISMATCH')
        else:
            require(suffix is None and recovery_hashes is None, 'P2_PROFILED_CURRENT_API_SUFFIX_REFUSED')
        lost = initial.get('lostBuildReceiptSha256')
        if initial['disposition'] == 'reconcile-frontend-lost-build-get-first':
            require(type(lost) is dict and tuple(lost) in (LOST_BUILD_NAMES, (*LOST_BUILD_NAMES, 'buildOutcome')) and
                    all(valid_digest(value) for value in lost.values()),
                    'P2_PROFILED_CURRENT_LOST_BUILD_RECEIPTS_REQUIRED')
        else:
            require(lost is None, 'P2_PROFILED_CURRENT_LOST_BUILD_RECEIPTS_REFUSED')
        return selected, jobs, plan, compose

    def create_scope(self, receipt):
        return P2ProfiledCurrentScope(self.lock_fd, LOCK, self.check, receipt,
            self.initial['candidateSha256'], release=self.selected, jobs=self.jobs,
            configuration_sha256=self.initial['configurationSha256'], recovery_action_id=self.action_id())

    def prepare_api_suffix(self):
        require(self.initial['disposition'] == 'resume-approved-api-suffix' and self.scope is not None and
                self.prior_gateway is None and self.worker is None and not hasattr(self, 'derived_bundle'),
                'P2_PROFILED_CURRENT_API_SUFFIX_STAGE_REFUSED')
        self.check()
        original_bundle, original_jobs = self.bundle, copy.deepcopy(self.jobs)
        derived_bundle = self.directory / 'api-suffix-bundle'
        derived_bundle.mkdir(mode=0o700)
        for name in ('jobs', 'schema'):
            (derived_bundle / name).mkdir(mode=0o700)
        for relative in ('release.candidate.json', 'jobs/frontend.json', 'schema/frontend.json',
                         'schema/course.json', 'schema/community.json'):
            raw = migrate.read_input(original_bundle, relative)
            target = derived_bundle / relative
            migrate.write_exact_bytes(target.parent, target.name, raw)
        derived_jobs, proofs = copy.deepcopy(original_jobs), {}
        for service in ('course', 'community'):
            approved = self.initial['approvedApiSuffix'][service]
            original = original_jobs[service]['job']['target']['approvedPendingTags']
            require(len(approved) <= len(original) and (not approved or original[-len(approved):] == approved),
                    'P2_PROFILED_CURRENT_API_SUFFIX_NOT_APPROVED')
            job = copy.deepcopy(original_jobs[service]['job'])
            job['target']['approvedPendingTags'] = copy.deepcopy(approved)
            job['target']['allowEmptyBootstrap'] = False
            migrate.write_exact_bytes(derived_bundle / 'jobs', service + '.json', encoded(job) + b'\n')
            raw = migrate.read_input(derived_bundle / 'jobs', service + '.json')
            require(sha(raw) == self.initial['recoveryApiJobSha256'][service],
                    'P2_PROFILED_CURRENT_API_SUFFIX_JOB_HASH_MISMATCH')
            derived_jobs[service]['job'] = job
            lineage_input = self.directory / ('api-suffix-' + service + '-input')
            lineage_input.mkdir(mode=0o700)
            migrate.write_exact_bytes(lineage_input, 'target.json', encoded(job['target']) + b'\n')
            if os.geteuid() == 0:
                os.chown(lineage_input / 'target.json', 65532, 65532); os.chown(lineage_input, 65532, 65532)
            container = 'lash-p2-profiled-current-api-check-' + service + '-' + uuid4().hex
            env = dict(runtime.SAFE_ENV)
            env.update(DATABASE_TARGET='staging', STAGING_DATABASE_URL=os.environ[service.upper() + '_STAGING_DATABASE_URL'],
                       PGOPTIONS='-c search_path=pg_catalog,public')
            args = ['docker', 'run', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--name', container,
                    '--network', 'bridge', '--interactive', '--read-only', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--user', '65532:65532', '--memory', '256m',
                    '--cpus', '0.5', '--pids-limit', '64', '--env', 'DATABASE_TARGET', '--env', 'STAGING_DATABASE_URL',
                    '--env', 'PGOPTIONS', '--mount',
                    'type=bind,src=' + str(lineage_input.resolve()) + ',dst=/check/input,readonly',
                    '--entrypoint', 'node', derived_jobs[service]['image'],
                    'dist-migration/scripts/check-migration-lineage.js', '--target-file-profiled-current',
                    '/check/input/target.json']
            try:
                result = self.scope.run(args, env=env, capture_output=True, timeout=120)
                require(result.returncode == 0, 'P2_PROFILED_CURRENT_API_SUFFIX_LINEAGE_REFUSED')
                proof = decode_qualification_target_json(result.stdout, 'carrier')
                require_profiled(proof)
                require(proof.get('service') == derived_jobs[service]['service'] and
                        proof.get('environment') == 'staging' and proof.get('pendingTags') == approved and
                        type(proof.get('appliedCount')) is int and proof['appliedCount'] > 0,
                        'P2_PROFILED_CURRENT_API_SUFFIX_LINEAGE_REFUSED')
                migrate.write_exact_bytes(self.directory, 'api-suffix-' + service + '-lineage.json', result.stdout)
                proofs[service] = sha(result.stdout)
            finally:
                self.scope.run(['docker', 'rm', '--force', container], env=runtime.SAFE_ENV, timeout=30)
                inventory = self.scope.run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$',
                    '--format', '{{.ID}}'], env=runtime.SAFE_ENV, capture_output=True, timeout=30)
                require(inventory.returncode == 0 and not inventory.stdout.strip(),
                        'P2_PROFILED_CURRENT_API_SUFFIX_CHECK_CLEANUP_REFUSED')
        selected, checked_jobs, _plan, _compose = runtime.make_plan(derived_bundle, self.configuration,
            self.source / 'ops/platform/compose.yaml', expected_profile=PROFILE)
        require(selected == self.selected and checked_jobs == derived_jobs,
                'P2_PROFILED_CURRENT_API_SUFFIX_DERIVED_BUNDLE_REFUSED')
        old_scope = self.scope; old_scope.revoke()
        require(not getattr(old_scope, 'cleanup_uncertain', False), 'P2_PROFILED_CURRENT_API_SUFFIX_SCOPE_REVOKE_REFUSED')
        self.original_bundle, self.original_jobs = original_bundle, original_jobs
        self.jobs, self.derived_bundle = derived_jobs, derived_bundle
        self.derived_api_job_sha256 = copy.deepcopy(self.initial['recoveryApiJobSha256'])
        self.scope = self.create_scope(old_scope.receipt)
        self.scope.bind_runtime_parent(self)
        self.api_suffix_lineage_sha256 = proofs
        return {**self.record_base('P2_PROFILED_CURRENT_API_SUFFIX_PREPARED'),
                'migrationsExecuted': False, 'trafficAuthorized': False,
                'lineageReceiptSha256': copy.deepcopy(proofs)}

    def start_runtime(self, identity):
        require(self.scope is not None and self.prior_gateway is not None and self.worker is None,
                'P2_PROFILED_CURRENT_RECOVERY_RUNTIME_STAGE_REFUSED')

        def worker():
            try:
                if self.initial['disposition'] == 'resume-approved-api-suffix':
                    result = runtime.execute(self.derived_bundle, self.configuration, self.results,
                        self.source / 'ops/platform/compose.yaml', True,
                        'staging/' + self.selected['releaseId'], LOCK,
                        expected_profile=PROFILE, _profiled_current_scope=self.scope)
                else:
                    require(getattr(self, 'current_database_proof', None) is not None,
                            'P2_PROFILED_CURRENT_API_READ_ONLY_PROOF_REQUIRED')
                    result = runtime.restore_profiled_current_runtime(self.bundle, self.configuration, self.results,
                        self.source / 'ops/platform/compose.yaml', self.current_database_proof,
                        expected_profile=PROFILE, _profiled_current_scope=self.scope)
                require(not self.failed.is_set() and self.runtime_released.is_set() and
                        result == self.ready and result.get('status') == 'API_RUNTIME_READY',
                        'P2_PROFILED_CURRENT_RECOVERY_CONTINUATION_REQUIRED')
                self.runtime_result = result
            except BaseException:
                self.abort()
                self.send(identity, self.STATUS + '_API_STAGE_FAILED')
            finally:
                self.worker_done.set()

        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    def verify_current_apis(self):
        require(self.initial['disposition'] != 'resume-approved-api-suffix' and self.scope is not None and
                self.prior_gateway is None and self.worker is None and not hasattr(self, 'current_database_proof'),
                'P2_PROFILED_CURRENT_API_READ_ONLY_STAGE_REFUSED')
        self.check()
        checker = self.source / 'ops/platform/host/database_current.mjs'
        output = self.results / ('current-databases-profiled-current-recovery-' + self.action_id())
        credentials = {'course': os.environ['COURSE_STAGING_DATABASE_URL'],
                       'community': os.environ['COMMUNITY_STAGING_DATABASE_URL']}
        proof = current_databases.check_all(self.selected, self.jobs, output, credentials, checker,
            self.initial['sourceSha256']['ops/platform/host/database_current.mjs'], expected_profile=PROFILE,
            _profiled_current_scope=self.scope)
        raw = migrate.read_input(output, 'current-databases-outcome.json')
        receipt = decode_qualification_target_json(raw, 'carrier')
        require(receipt.get('status') == 'CURRENT_DATABASES_READ_ONLY_VERIFIED' and
                receipt.get('migrationsExecuted') is False and receipt.get('trafficAuthorized') is False,
                'P2_PROFILED_CURRENT_API_READ_ONLY_PROOF_REQUIRED')
        self.current_database_proof, self.current_database_output = proof, output
        self.current_database_raw = raw
        return copy.deepcopy(receipt)

    def runtime_ready(self, attempt, prior_attempt, snapshot, selected, outcome):
        self.check()
        require_profiled(outcome)
        require(selected == self.selected and outcome.get('status') == 'API_RUNTIME_READY' and
                outcome.get('candidateSha256') == self.initial['candidateSha256'] and
                outcome.get('configurationSha256') == self.initial['configurationSha256'] and
                outcome.get('sourceCommit') == self.initial['sourceCommit'] and
                all(outcome.get(key) is False for key in FALSE_FIELDS),
                'P2_PROFILED_CURRENT_API_READY_REQUIRED')
        migrate.require_contract_identity(self.selected, outcome)
        runtime_raw = migrate.read_input(attempt, 'runtime-outcome.json')
        if self.initial['disposition'] == 'resume-approved-api-suffix':
            prior_raw = migrate.read_input(prior_attempt, 'migration-outcome.json')
            prior = decode_qualification_target_json(prior_raw, 'carrier')
            require_profiled(prior); migrate.require_contract_identity(self.selected, prior)
            require(outcome.get('migrationOutcomeSha256') == sha(prior_raw) and
                    prior.get('status') == 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN' and
                    prior.get('candidateSha256') == self.initial['candidateSha256'] and
                    prior.get('databaseReceiptSha256', {}).get('frontend') == sha(self.frontend_raw),
                    'P2_PROFILED_CURRENT_DURABLE_RUNTIME_REQUIRED')
            self.migration_attempt, self.api_migration_raw = prior_attempt, prior_raw
            prior_field = {'migrationOutcome': base64.b64encode(prior_raw).decode()}
        else:
            prior_raw = self.current_database_raw
            prior = decode_qualification_target_json(prior_raw, 'carrier')
            require_profiled(prior); migrate.require_contract_identity(self.selected, prior)
            require(outcome.get('currentDatabasesOutcomeSha256') == sha(prior_raw) and
                    Path(prior_attempt) == self.current_database_output,
                    'P2_PROFILED_CURRENT_DURABLE_RUNTIME_REQUIRED')
            prior_field = {'currentDatabasesOutcome': base64.b64encode(prior_raw).decode()}
        require(decode_qualification_target_json(runtime_raw, 'carrier') == outcome,
                'P2_PROFILED_CURRENT_DURABLE_RUNTIME_REQUIRED')
        self.runtime_snapshot, self.ready, self.api_attempt = snapshot, copy.deepcopy(outcome), attempt
        self.api_runtime_raw = runtime_raw
        self.send(self.arm_identity, self.STATUS + '_API_READY', receipt=outcome,
                  runtimeOutcome=base64.b64encode(runtime_raw).decode(), **prior_field)
        while not self.runtime_released.wait(0.1):
            self.check()
        self.check()
        frontend_pending = len(self.initial['originalReceiptSha256']) < len(ORIGINAL_NAMES)
        require(not self.failed.is_set() and
                (self.promoted is not None if not frontend_pending else
                 getattr(self, 'api_suffix_resumed', False) if self.initial['disposition'] == 'resume-approved-api-suffix'
                 else self.initial['disposition'] == 'restore-current-runtime' and getattr(self, 'runtime_current', False)
                 or self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first' and
                 getattr(self, 'runtime_current', False) and hasattr(self, 'lost_build_observation')),
                'P2_PROFILED_CURRENT_FRONTEND_REQUIRED')

    def _require_current_api(self):
        self.check()
        require(self.ready is not None and self.api_attempt is not None,
                'P2_PROFILED_CURRENT_RECOVERY_API_NOT_READY')
        runtime_receipt = migrate.read_json(self.api_attempt, 'runtime-outcome.json', expected_profile=PROFILE)
        prior_path = (self.migration_attempt if self.initial['disposition'] == 'resume-approved-api-suffix'
                      else self.current_database_output)
        prior_name = ('migration-outcome.json' if self.initial['disposition'] == 'resume-approved-api-suffix'
                      else 'current-databases-outcome.json')
        prior_receipt = migrate.read_json(prior_path, prior_name, expected_profile=PROFILE)
        required_status = ('API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN'
                           if self.initial['disposition'] == 'resume-approved-api-suffix'
                           else 'CURRENT_DATABASES_READ_ONLY_VERIFIED')
        require(runtime_receipt == self.ready and runtime_receipt.get('status') == 'API_RUNTIME_READY' and
                prior_receipt.get('status') == required_status and
                prior_receipt.get('candidateSha256', self.initial['candidateSha256']) == self.initial['candidateSha256'] and
                all(runtime_receipt.get(key) is False for key in FALSE_FIELDS),
                'P2_PROFILED_CURRENT_RECOVERY_API_CURRENT_REQUIRED')
        return runtime_receipt, prior_receipt

    def reconcile_frontend(self, value):
        self._require_current_api()
        require(self.promoted is None and self.closing_at is None,
                'P2_PROFILED_CURRENT_RECOVERY_FRONTEND_ALREADY_BOUND')
        observation, proof = value['observation'], value['proof']
        require_profiled(observation, proof)
        original_pins_sha256 = sha(encoded(dict(sorted(self.initial['originalReceiptSha256'].items()))))
        require(type(observation) is dict and observation.get('status') == 'P2_PROFILED_CURRENT_FRONTEND_CURRENT' and
                observation.get('getFirst') is True and observation.get('newProviderPost') is False and
                observation.get('ambiguous') is False and observation.get('originalEffectReconciled') is
                (self.initial['disposition'] == 'reconcile-frontend-get-first') and
                observation.get('releaseId') == self.selected['releaseId'] and
                observation.get('sourceCommit') == self.initial['sourceCommit'] and
                observation.get('candidateSha256') == self.initial['candidateSha256'] and
                observation.get('configurationSha256') == self.initial['configurationSha256'] and
                observation.get('targetSha256') == self.initial['targetSha256'] and
                observation.get('proof') == proof and
                observation.get('originalReceiptSha256') == original_pins_sha256 and
                observation.get('workloadReceiptSha256') == proof.get('workloadReceiptSha256'),
                'P2_PROFILED_CURRENT_RECOVERY_FRONTEND_CURRENT_REQUIRED')
        P2ProfiledCurrentBroker.verify_frontend(self, proof, value['workload'])
        self.recovery_frontend_observation = copy.deepcopy(observation)
        return self.record_base('P2_PROFILED_CURRENT_FRONTEND_CURRENT')

    def observe_lost_build(self, observation):
        self._require_current_api()
        require(self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first' and
                self.promoted is None and self.closing_at is None and not hasattr(self, 'lost_build_observation'),
                'P2_PROFILED_CURRENT_LOST_BUILD_STAGE_REFUSED')
        require_profiled(observation)
        optional = ('buildOutcomeSha256',) if 'buildOutcome' in self.initial['lostBuildReceiptSha256'] else ()
        fields = {'version', 'qualificationTargetProfile', 'status', 'environment', 'actionId', 'releaseId', 'sourceCommit',
                  'candidateSha256', 'configurationSha256', 'targetSha256', 'projectId', 'deploymentId', 'previousDeploymentId',
                  'lostBuildReceiptSha256', 'deployStartedSha256', 'buildStartedSha256', 'buildIntentSha256', *optional,
                  'getFirst', 'newProviderPost', 'ambiguous', 'deploymentEffectObserved', 'frontendActionPending',
                  'originalBuildAckObserved', 'providerMutationReplayed', 'buildReadyVerified', 'workloadVerified',
                  'aliasQualificationVerified', 'promotionVerified', 'cronQualificationVerified', 'trafficAuthorized',
                  'releaseAccepted'}
        pins = self.initial['lostBuildReceiptSha256']
        require(set(observation) == fields and type(observation.get('version')) is int and observation['version'] == 2 and
                observation.get('status') == 'P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED' and
                observation.get('environment') == 'staging' and observation.get('actionId') == self.selected['releaseId'] and
                observation.get('releaseId') == self.selected['releaseId'] and observation.get('sourceCommit') == self.initial['sourceCommit'] and
                observation.get('candidateSha256') == self.initial['candidateSha256'] and
                observation.get('configurationSha256') == self.initial['configurationSha256'] and
                observation.get('targetSha256') == self.initial['targetSha256'] and
                observation.get('projectId') == self.selected['workload']['projectId'] and
                type(observation.get('deploymentId')) is str and re.fullmatch(r'dpl_[A-Za-z0-9]+', observation['deploymentId']) and
                (observation.get('previousDeploymentId') is None or type(observation['previousDeploymentId']) is str and
                 re.fullmatch(r'dpl_[A-Za-z0-9]+', observation['previousDeploymentId'])) and
                observation.get('deploymentId') != observation.get('previousDeploymentId') and
                observation.get('lostBuildReceiptSha256') == sha(encoded(dict(sorted(pins.items())))) and
                observation.get('deployStartedSha256') == pins['deployStarted'] and
                observation.get('buildStartedSha256') == pins['buildStarted'] and
                observation.get('buildIntentSha256') == pins['buildIntent'] and
                ('buildOutcome' not in pins or observation.get('buildOutcomeSha256') == pins['buildOutcome']) and
                observation.get('getFirst') is True and observation.get('newProviderPost') is False and
                observation.get('ambiguous') is False and observation.get('deploymentEffectObserved') is True and
                observation.get('frontendActionPending') is True and
                all(observation.get(key) is False for key in ('originalBuildAckObserved', 'providerMutationReplayed',
                    'buildReadyVerified', 'workloadVerified', 'aliasQualificationVerified', 'promotionVerified',
                    'cronQualificationVerified', 'trafficAuthorized', 'releaseAccepted')),
                'P2_PROFILED_CURRENT_LOST_BUILD_OBSERVATION_REFUSED')
        raw = encoded(observation)
        self.retain('frontend-lost-build-observation.json', raw)
        self.lost_build_observation = copy.deepcopy(observation)
        self.lost_build_observation_sha256 = sha(raw)
        return {**self.record_base('P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_RETAINED'),
                'observationSha256': self.lost_build_observation_sha256}

    def resume_api_suffix(self):
        require(self.initial['disposition'] == 'resume-approved-api-suffix',
                'P2_PROFILED_CURRENT_API_SUFFIX_REFUSED')
        runtime_receipt, migration_receipt = self._require_current_api()
        for service in ('course', 'community'):
            approved = self.initial['approvedApiSuffix'][service]
            receipt_raw = migrate.read_input(self.migration_attempt / service, 'database-receipt.json')
            require(migration_receipt.get('databaseReceiptSha256', {}).get(service) == sha(receipt_raw),
                    'P2_PROFILED_CURRENT_API_SUFFIX_UNVERIFIED')
            receipt = decode_qualification_target_json(receipt_raw, 'carrier')
            require_profiled(receipt)
            lineage_raw = migrate.read_input(self.directory, 'api-suffix-' + service + '-lineage.json')
            lineage = decode_qualification_target_json(lineage_raw, 'carrier')
            require_profiled(lineage)
            require(self.jobs[service]['job']['target']['approvedPendingTags'] == approved and
                    self.api_suffix_lineage_sha256[service] == sha(lineage_raw) and
                    lineage.get('pendingTags') == approved and
                    lineage.get('appliedCount') == receipt.get('preAppliedCount') and
                    receipt.get('applyStarted') is bool(approved) and receipt.get('applyCompleted') is bool(approved) and
                    type(receipt.get('preAppliedCount')) is int and type(receipt.get('postAppliedCount')) is int and
                    receipt['postAppliedCount'] - receipt['preAppliedCount'] == len(approved) and
                    receipt.get('failureCode') is None,
                    'P2_PROFILED_CURRENT_API_SUFFIX_UNVERIFIED')
        self.api_suffix_resumed = True
        self.runtime_released.set()
        return {**self.record_base('P2_PROFILED_CURRENT_API_SUFFIX_RESUMED'),
                'runtimeReceiptSha256': sha(self.api_runtime_raw),
                'migrationReceiptSha256': sha(self.api_migration_raw)}

    def runtime_restored(self):
        runtime_receipt, prior_receipt = self._require_current_api()
        self._runtime_readback()
        self.runtime_current = True
        if (len(self.initial['originalReceiptSha256']) < len(ORIGINAL_NAMES) and
                self.initial['disposition'] in ('restore-current-runtime', 'reconcile-frontend-lost-build-get-first')):
            if self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first':
                require(hasattr(self, 'lost_build_observation'), 'P2_PROFILED_CURRENT_LOST_BUILD_OBSERVATION_REQUIRED')
            self._require_native_schedules_off()
            self.runtime_released.set()
        return {**self.record_base('P2_PROFILED_CURRENT_RUNTIME_RESTORED'),
                'runtimeReceiptSha256': sha(self.api_runtime_raw),
                **({'migrationReceiptSha256': sha(self.api_migration_raw)}
                   if self.initial['disposition'] == 'resume-approved-api-suffix'
                   else {'currentDatabasesReceiptSha256': sha(self.current_database_raw)})}

    def verify_api_receipts(self):
        require(migrate.read_input(self.api_attempt, 'runtime-outcome.json') == self.api_runtime_raw,
                'P2_PROFILED_CURRENT_RUNTIME_RECEIPT_CHANGED')
        if self.initial['disposition'] == 'resume-approved-api-suffix':
            require(migrate.read_input(self.migration_attempt, 'migration-outcome.json') == self.api_migration_raw,
                    'P2_PROFILED_CURRENT_RUNTIME_RECEIPT_CHANGED')
        else:
            require(migrate.read_input(self.current_database_output, 'current-databases-outcome.json') == self.current_database_raw,
                    'P2_PROFILED_CURRENT_RUNTIME_RECEIPT_CHANGED')

    def _require_native_schedules_off(self):
        self.check()
        state = vercel.project_state(self.vercel, self.selected['workload']['projectId'])
        self.check()
        require(state == {'projectId': self.selected['workload']['projectId'],
                          'productionDeploymentId': state.get('productionDeploymentId'),
                          'cronsEnabled': False},
                'P2_PROFILED_CURRENT_NATIVE_SCHEDULES_NOT_CLOSED')
        if hasattr(self, 'lost_build_observation'):
            require(state['productionDeploymentId'] == self.lost_build_observation['previousDeploymentId'],
                    'P2_PROFILED_CURRENT_LOST_BUILD_PRIOR_TARGET_CHANGED')

    def prepare_close(self):
        if self.promoted is not None:
            return super().prepare_close()
        self.check()
        require(len(self.initial['originalReceiptSha256']) < len(ORIGINAL_NAMES) and
                ((self.initial['disposition'] == 'resume-approved-api-suffix' and getattr(self, 'api_suffix_resumed', False)) or
                 self.initial['disposition'] == 'restore-current-runtime' or
                 self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first' and hasattr(self, 'lost_build_observation')) and
                getattr(self, 'runtime_current', False) and
                self.closing_at is None and self.session_closed_proof is None,
                'P2_PROFILED_CURRENT_FRONTEND_ACTION_PENDING_REQUIRED')
        self._require_native_schedules_off()
        self._runtime_readback()
        self.runtime_released.set()
        require(self.worker_done.wait(10) and not self.failed.is_set(), 'P2_PROFILED_CURRENT_RUNTIME_TAIL_UNVERIFIED')
        self.check(); self.verify_api_receipts(); self.observer.probe('verify-schema'); self.observer.stop()
        self.scope.begin_close(); self.closing_at = time.monotonic()

    def finish_receipts(self, value):
        self.check()
        frontend_pending = self.promoted is None
        require(self.session_closed_proof is not None and not self.finished and self.worker_done.is_set() and
                getattr(self, 'runtime_current', False) and
                (self.promoted is not None or len(self.initial['originalReceiptSha256']) < len(ORIGINAL_NAMES) and
                 ((self.initial['disposition'] == 'resume-approved-api-suffix' and getattr(self, 'api_suffix_resumed', False)) or
                  self.initial['disposition'] == 'restore-current-runtime' or
                  self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first' and hasattr(self, 'lost_build_observation'))),
                'P2_PROFILED_CURRENT_RECOVERY_SESSION_CLOSURE_REQUIRED')
        terminal_raw, terminal = decode_profiled(value['terminal'])
        completed_raw, completed = decode_profiled(value['continuationCompleted'])
        outcome_raw, outcome = decode_profiled(value['recovery'])
        require(terminal.get('status') == 'DATABASE_VERIFIED' and terminal.get('phase') == 'completed' and
                terminal.get('readOnlyVerified') is True and terminal.get('failureCode') is None and
                all(terminal.get(key) == self.scope.receipt.get(key)
                    for key in (*COMMON, 'target', 'migrationMode', 'trafficAuthorized')),
                'P2_PROFILED_CURRENT_RECOVERY_LATE_TERMINAL_REQUIRED')
        require(completed == {**self.continuation_started, 'status': 'FRONTEND_CONTINUATION_COMPLETED'},
                'P2_PROFILED_CURRENT_RECOVERY_COMPLETED_CONTINUATION_REQUIRED')
        expected = self.record_base(TERMINAL)
        require(outcome.get('status') == TERMINAL and
                all(outcome.get(key) == selected for key, selected in expected.items()) and
                outcome.get('frontendTerminalSha256') == sha(terminal_raw) and
                outcome.get('frontendContinuationCompletedSha256') == sha(completed_raw) and
                outcome.get('runtimeCurrent') is True and
                outcome.get('frontendCurrentVerified') is (not frontend_pending) and
                outcome.get('frontendActionPending') is frontend_pending and
                outcome.get('apiSuffixResumed') is (self.initial['disposition'] == 'resume-approved-api-suffix') and
                outcome.get('frontendEffectReconciled') is
                (self.initial['disposition'] == 'reconcile-frontend-get-first') and
                outcome.get('frontendBuildEffectObserved') is
                (self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first') and
                (self.initial['disposition'] != 'reconcile-frontend-lost-build-get-first' or
                 outcome.get('frontendBuildEffectObservationSha256') == self.lost_build_observation_sha256) and
                all(outcome.get(key) is False for key in
                    ('frontendSqlApplied', 'rolePreparationAuthorized', 'historicalLoginsRestored',
                     'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted')),
                'P2_PROFILED_CURRENT_RECOVERY_OUTCOME_REQUIRED')
        if self.promoted is not None:
            self._frontend_readback(self.promoted)
        else:
            self._require_native_schedules_off()
        self._runtime_readback()
        for name, raw in (('frontend-job-outcome.json', terminal_raw),
                          ('frontend-continuation-completed.json', completed_raw),
                          ('profiled-current-recovery-outcome.json', outcome_raw)):
            self.retain(name, raw)
        self.outcome = {**expected,
            'frontendDatabaseReceiptSha256': sha(self.frontend_raw),
            'frontendTerminalSha256': sha(terminal_raw),
            'frontendContinuationCompletedSha256': sha(completed_raw),
            'frontendSessionClosedSha256': self.raw_pins['frontend-session-closed.json'],
            **({'frontendWorkloadReceiptSha256': self.promoted['workloadReceiptSha256']}
               if self.promoted is not None else {}),
            'apiRuntimeReceiptSha256': sha(migrate.read_input(self.api_attempt, 'runtime-outcome.json')),
            **({'migrationOutcomeSha256': sha(migrate.read_input(self.migration_attempt, 'migration-outcome.json'))}
               if self.initial['disposition'] == 'resume-approved-api-suffix' else
               {'currentDatabasesOutcomeSha256': sha(self.current_database_raw)}),
            'runtimeCurrent': True,
            'apiSuffixResumed': self.initial['disposition'] == 'resume-approved-api-suffix',
            'frontendEffectReconciled': self.initial['disposition'] == 'reconcile-frontend-get-first',
            'frontendBuildEffectObserved': self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first',
            **({'frontendBuildEffectObservationSha256': self.lost_build_observation_sha256}
               if self.initial['disposition'] == 'reconcile-frontend-lost-build-get-first' else {}),
            'frontendCurrentVerified': not frontend_pending, 'frontendActionPending': frontend_pending}
        self.finished = True
        return copy.deepcopy(self.outcome)

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_PROTOCOL_ID_REFUSED')
        suffix = operation.removeprefix(self.OP + '-') if type(operation) is str and operation.startswith(self.OP + '-') else operation
        fields = {'check': (), 'prepare-prior-gateway': (), 'verify-api-current': (), 'prepare-api-suffix': (),
            'arm': ('receipt', 'continuationStarted', 'probe'),
            'reconcile-frontend': ('observation', 'proof', 'workload'), 'observe-lost-build': ('observation',),
            'resume-api-suffix': (), 'runtime-restored': (), 'prepare-close': (),
            'session-closed': (), 'finish': ('terminal', 'continuationCompleted', 'recovery'), 'commit': ()}
        require(suffix in fields and (operation in ('check', 'commit') or operation == self.OP + '-' + suffix) and
                set(value) == {'id', 'operation', *fields[suffix]}, 'P2_PROFILED_CURRENT_RECOVERY_PROTOCOL_REFUSED')
        self.check()
        self.last_command = time.monotonic()
        token = runtime._command_scope.set(self.scope) if self.scope is not None and self.closing_at is None else None
        try:
            if suffix == 'check':
                self.send(identity, 'HELD')
            elif suffix == 'arm':
                self.arm(identity, value)
                self.send(identity, self.STATUS + '_ARMED')
            elif suffix == 'prepare-prior-gateway':
                receipt = self.prepare_prior_gateway()
                self.send(identity, self.STATUS + '_PRIOR_GATEWAY_PREPARED', receipt=receipt)
                self.start_runtime(self.arm_identity)
            elif suffix == 'verify-api-current':
                self.send(identity, self.STATUS + '_API_CURRENT_VERIFIED', receipt=self.verify_current_apis())
            elif suffix == 'prepare-api-suffix':
                self.send(identity, self.STATUS + '_API_SUFFIX_PREPARED', receipt=self.prepare_api_suffix())
            elif suffix == 'reconcile-frontend':
                self.send(identity, self.STATUS + '_FRONTEND_RECONCILED', receipt=self.reconcile_frontend(value))
            elif suffix == 'observe-lost-build':
                self.send(identity, self.STATUS + '_LOST_BUILD_OBSERVED', receipt=self.observe_lost_build(value['observation']))
            elif suffix == 'resume-api-suffix':
                self.send(identity, self.STATUS + '_API_SUFFIX_RESUMED', receipt=self.resume_api_suffix())
            elif suffix == 'runtime-restored':
                self.send(identity, self.STATUS + '_RUNTIME_RESTORED', receipt=self.runtime_restored())
            elif suffix == 'prepare-close':
                self.prepare_close()
                self.send(identity, self.STATUS + '_CLOSE_PREPARED')
            elif suffix == 'session-closed':
                self.send(identity, self.STATUS + '_SESSION_CLOSED', receipt=self.frontend_session_closed())
            elif suffix == 'finish':
                self.send(identity, self.STATUS + '_JOINED', receipt=self.finish_receipts(value))
            elif suffix == 'commit':
                require(self.finished and self.worker_done.is_set() and self.session_closed_proof is not None,
                        'P2_PROFILED_CURRENT_RECOVERY_JOIN_REQUIRED')
                self.verify_api_receipts()
                if self.promoted is not None:
                    self._frontend_readback(self.promoted)
                else:
                    self._require_native_schedules_off()
                self._runtime_readback()
                self.scope.verify_close()
                migrate.write_json(self.directory, self.terminal_filename(), self.outcome)
                digest = sha(migrate.read_input(self.directory, self.terminal_filename()))
                self.safety({'operation': 'committed', 'sha256': digest})
                self.committed.set()
                self.send(identity, 'COMMITTED', receipt=copy.deepcopy(self.outcome))
                return False
        finally:
            if token is not None:
                runtime._command_scope.reset(token)
        return True


def main():
    from p2_release_supervisor import supervise
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'),
            'P2_PROFILED_CURRENT_RECOVERY_INITIAL_REFUSED')
    initial = decode_qualification_target_json(raw, 'private-packet')
    require(type(initial) is dict and type(initial.get('version')) is int and initial['version'] == 2 and
            initial.get('mode') == MODE, 'P2_PROFILED_CURRENT_RECOVERY_FIXED_MODE_REQUIRED')
    require_profiled(initial)
    supervise(initial, broker_type=P2ProfiledCurrentRecoveryBroker,
              observer_type=P2ProfiledCurrentRecoveryPhysicalObserver,
              observer_source=PROGRAM, layout=LAYOUT)


if __name__ == '__main__':
    for item, code in ((signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
        signal.signal(item, lambda *_args, code=code: (_ for _ in ()).throw(SystemExit(code)))
    try:
        main()
    except BaseException:
        print('P2_PROFILED_CURRENT_RECOVERY_FAILED_REQUIRES_REVIEW', file=sys.stderr)
        raise SystemExit(1)
