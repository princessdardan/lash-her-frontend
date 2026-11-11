"""Typed current-only staging scope. JSON receipts never construct this object."""
import copy
from contextvars import ContextVar
import fcntl
import os
from pathlib import Path
import re
import stat
import time

import migrate
from p2_release_scope import P2ReleaseScope
from qualification_target_profile import (
    STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE,
    require_qualification_target_profile,
)

PROFILE = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
COMMON = ('environment', 'releaseId', 'sourceCommit', 'migrationImageDigest',
          'sqlArtifactSha256', 'schemaBaselineSha256', 'contractManifestSha256',
          'contractPhase', 'phase2ContractManifestSha256')
TARGET = ('host', 'port', 'database', 'user', 'serverMajor')
_suspending_runtime = ContextVar('profiled_current_suspending_runtime', default=None)


def require_profiled(*carriers):
    return dict(require_qualification_target_profile(PROFILE, *carriers))


class P2ProfiledCurrentScope(P2ReleaseScope):
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256, *,
                 release, jobs, configuration_sha256, recovery_action_id=None):
        migrate.demand(recovery_action_id is None or type(recovery_action_id) is str and
            re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', recovery_action_id) and
            recovery_action_id != release.get('releaseId'), 'P2_PROFILED_CURRENT_RECOVERY_ACTION_REQUIRED')
        self._recovery_action_id = recovery_action_id
        self.close_deadline = None
        self.runtime_parent = None
        self.runtime_suspension_started = False
        require_profiled(release, jobs['frontend']['job'], jobs['frontend']['job']['target'], receipt)
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256,
                         release=release, jobs=jobs, configuration_sha256=configuration_sha256)
        self.require_frontend(release, jobs['frontend'])

    @property
    def recovery_action_id(self):
        return self._recovery_action_id

    def verify(self):
        migrate.demand(self.close_deadline is None, 'P2_PROFILED_CURRENT_CLOSE_ONLY')
        if _suspending_runtime.get() is self:
            boundary = self.prior_gateway
            migrate.demand(boundary is not None and boundary.api_suspension_started and
                           not boundary.api_suspension_finished, 'P2_PROFILED_CURRENT_STOP_STAGE_REQUIRED')
            # The old gateway is being stopped, so its normal live probe
            # cannot succeed. Keep the physical frontend and host checks.
            super()._verify_session()
            return
        super().verify()

    def suspend_api_runtime(self, environment, env):
        migrate.demand(environment == self.release['environment'] == 'staging' and
                       _suspending_runtime.get() is None and not self.runtime_suspension_started,
                       'P2_PROFILED_CURRENT_STOP_STAGE_REQUIRED')
        self.verify()
        self.require_prior_gateway()
        self.runtime_suspension_started = True
        if self.prior_gateway.stopped:
            # A qualified earlier stop may have removed the gateway. Keep its
            # latest ordered proof while stopping any remaining API services.
            stopped = migrate.suspend_runtime(environment, env, _runner=self.run)
            self.verify()
            return stopped
        self.before_api_suspension()
        token = _suspending_runtime.set(self)
        try:
            stopped = migrate.suspend_runtime(environment, env, _runner=self.run)
        finally:
            _suspending_runtime.reset(token)
        self.after_api_suspension()
        return stopped

    def require_frontend(self, release, info):
        self.verify()
        job, receipt = info['job'], self.receipt
        require_profiled(release, job, job['target'], receipt)
        migrate.demand(release == self.release and info == self.jobs['frontend'] and
            type(release.get('version')) is int and release['version'] == 3 and
            type(job.get('version')) is int and job['version'] == 2 and
            type(receipt.get('version')) is int and receipt['version'] == 2 and
            release.get('environment') == 'staging' and release.get('contractPhase') == 'p2' and
            job['target'].get('approvedPendingTags') == [] and
            all(receipt.get(key) == job.get(key) and job.get(key) is not None for key in COMMON) and
            receipt.get('status') == 'DATABASE_VERIFIED' and receipt.get('service') == 'frontend' and
            receipt.get('migrationMode') == 'verify-current-only' and receipt.get('readOnlyVerified') is True and
            receipt.get('schemaVerified') is True and receipt.get('runtimeRoleVerified') is True and
            receipt.get('trafficAuthorized') is False and receipt.get('failureCode') is None and
            receipt.get('applied') == [] and isinstance(receipt.get('after'), list) and bool(receipt['after']) and
            receipt.get('before') == receipt['after'] and
            receipt.get('target') == {key: job['target'][key] for key in TARGET},
            'P2_PROFILED_CURRENT_FRONTEND_RECEIPT_REQUIRED')
        return copy.deepcopy(receipt)

    def bind_runtime_parent(self, parent):
        from p2_profiled_current_parent import P2ProfiledCurrentBroker
        self.verify()
        migrate.demand(isinstance(parent, P2ProfiledCurrentBroker) and parent.scope is self and
            parent.lock_fd == self.descriptor and parent.selected == self.release and
            parent.jobs == self.jobs and self.runtime_parent is None,
            'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        self.runtime_parent = parent

    def runtime_ready(self, attempt, migration_attempt, snapshot, selected, outcome):
        from p2_profiled_current_parent import P2ProfiledCurrentBroker
        self.verify()
        parent = self.runtime_parent
        migrate.demand(parent is not None and parent.scope is self,
                       'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        # Source class method, never a callback or callable decoded from input.
        if type(parent) is P2ProfiledCurrentBroker:
            migrate.demand(self.recovery_action_id is None, 'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
            return P2ProfiledCurrentBroker.runtime_ready(parent, attempt, migration_attempt, snapshot, selected, outcome)
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker
        migrate.demand(type(parent) is P2ProfiledCurrentRecoveryBroker and self.recovery_action_id == parent.action_id(),
                       'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        return P2ProfiledCurrentRecoveryBroker.runtime_ready(parent, attempt, migration_attempt, snapshot, selected, outcome)

    def api_job_bytes(self, name):
        from p2_profiled_current_parent import P2ProfiledCurrentBroker
        from p2_profiled_current_recovery import P2ProfiledCurrentRecoveryBroker
        from qualification_target_profile import decode_qualification_target_json
        self.verify()
        parent = self.runtime_parent
        migrate.demand(name in ('course', 'community') and type(parent) in
                       (P2ProfiledCurrentBroker, P2ProfiledCurrentRecoveryBroker)
                       and parent.scope is self, 'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        bundle, pins = parent.bundle, parent.initial['apiJobSha256']
        if type(parent) is P2ProfiledCurrentRecoveryBroker:
            migrate.demand(self.recovery_action_id == P2ProfiledCurrentRecoveryBroker.action_id(parent),
                           'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
            if parent.initial['disposition'] == 'resume-approved-api-suffix':
                bundle, pins = getattr(parent, 'derived_bundle', None), getattr(parent, 'derived_api_job_sha256', None)
                migrate.demand(bundle == parent.directory / 'api-suffix-bundle'
                               and type(pins) is dict and pins == parent.initial['recoveryApiJobSha256']
                               and migrate.file_hash(migrate.read_input(parent.bundle, f'jobs/{name}.json'))
                                   == parent.initial['apiJobSha256'][name],
                               'P2_PROFILED_CURRENT_API_JOB_BYTES_CHANGED')
        else:
            migrate.demand(self.recovery_action_id is None, 'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        raw = migrate.read_input(bundle, f'jobs/{name}.json')
        migrate.demand(migrate.file_hash(raw) == pins[name]
                       and decode_qualification_target_json(raw, 'carrier') == self.jobs[name]['job'],
                       'P2_PROFILED_CURRENT_API_JOB_BYTES_CHANGED')
        self.verify()
        return raw

    def frontend_current_receipt_bytes(self):
        from p2_profiled_current_parent import P2ProfiledCurrentBroker
        self.verify()
        parent = self.runtime_parent
        migrate.demand(isinstance(parent, P2ProfiledCurrentBroker) and parent.scope is self,
                       'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        database = migrate.read_input(parent.directory, 'frontend-original-database-receipt.json')
        started = migrate.read_input(parent.directory, 'frontend-continuation-started.json')
        migrate.demand(database == parent.frontend_raw and started == parent.continuation_started_raw,
                       'P2_PROFILED_CURRENT_RETAINED_BYTES_CHANGED')
        self.verify()
        return database, started

    def begin_close(self, seconds=10):
        migrate.demand(type(seconds) is int and seconds == 10,
                       'P2_PROFILED_CURRENT_CLOSE_BUDGET_REFUSED')
        with self.mutations:
            self.verify()
            migrate.demand(not self.processes and not getattr(self, 'cleanup_uncertain', False),
                           'P2_PROFILED_CURRENT_WORKER_NOT_QUIESCED')
            self.close_deadline = time.monotonic() + seconds

    def verify_close(self):
        migrate.demand(not self.closed and not self.revoked.is_set() and self.close_deadline is not None and
            time.monotonic() < self.close_deadline, 'P2_PROFILED_CURRENT_CLOSE_WINDOW_LOST')
        current, opened = os.lstat(self.path), os.fstat(self.descriptor)
        migrate.demand(stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and not current.st_mode & 0o077 and
            (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino) ==
            (self.identity.st_dev, self.identity.st_ino), 'P2_ENVIRONMENT_LOCK_IDENTITY_CHANGED')
        fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def run_close_probe(self, observer):
        from p2_profiled_current_parent import P2ProfiledCurrentPhysicalObserver
        self.verify_close()
        migrate.demand(isinstance(observer, P2ProfiledCurrentPhysicalObserver) and
            observer.selected == self.release and observer.request.get('receipt') == self.receipt and
            observer.request.get('job') == self.jobs['frontend']['job'],
            'P2_PROFILED_CURRENT_CLOSE_OBSERVER_REQUIRED')
        # Subclasses may select only the same fixed observer program. Do not
        # dispatch an overridden method or an operator-supplied command.
        observed = P2ProfiledCurrentPhysicalObserver.probe(observer, 'verify-closed')
        self.verify_close()
        return observed


def _replacement_producer_bytes(probe, physical, database_raw, started_raw, postflight_raw, owner, runtime, producer, administrative_logins):
    import p2_frontend_replacement_parent as replacement
    from qualification_target_profile import decode_qualification_target_json

    database, started, postflight = (
        decode_qualification_target_json(raw, 'carrier') for raw in (database_raw, started_raw, postflight_raw)
    )
    require_profiled(database, started, postflight)
    require = migrate.demand
    job, target = probe['job'], probe['job']['target']
    require(all(type(role) is dict and set(role) == {'name', 'oid'} and replacement.oid(role['oid'])
                for role in (owner, runtime)) and owner['name'] == 'lash_her_frontend_staging_admission_owner_p2' and
            runtime['name'] == target['runtimeRole'] and
            len({owner['oid'], runtime['oid'], probe['migrationRoleOid']}) == 3 and replacement.digest(producer),
            'P2_REPLACEMENT_ROLE_BINDING_REFUSED')
    base = {'version': 2, 'qualificationTargetProfile': PROFILE, 'service': 'frontend',
            **{key: job[key] for key in COMMON}, 'operator': 'Dardan', 'migrationMode': 'apply-forward',
            'target': {key: target[key] for key in TARGET}, 'recoveryRef': job['recoveryRef'], 'trafficAuthorized': False}
    require(replacement.canonical(started) == replacement.canonical({
        **base, 'status': 'FRONTEND_CONTINUATION_STARTED', 'databaseVerified': True}),
        'P2_REPLACEMENT_CONTINUATION_RECEIPT_REFUSED')
    require(type(database) is dict and set(database) == {*base, 'status', 'before', 'after', 'applied',
                'schemaVerified', 'runtimeRoleVerified', 'readOnlyVerified'} and
            all(replacement.canonical(database[key]) == replacement.canonical(value) for key, value in base.items()) and
            database['status'] == 'DATABASE_VERIFIED' and database['before'] == [] and
            database['schemaVerified'] is True and database['runtimeRoleVerified'] is True and
            database['readOnlyVerified'] is False, 'P2_REPLACEMENT_DATABASE_RECEIPT_REFUSED')
    tags, after, applied = target['approvedPendingTags'], database['after'], database['applied']
    require(bool(tags) and target.get('allowEmptyBootstrap') is True and len(set(tags)) == len(tags) and
            type(after) is list and type(applied) is list and len(after) == len(applied) == len(tags),
            'P2_REPLACEMENT_JOURNAL_RECEIPT_REFUSED')
    previous = 0
    for tag, row, migration in zip(tags, after, applied):
        require(type(row) is dict and set(row) == {'hash', 'created_at'} and replacement.digest(row['hash']) and
                replacement.match(row['created_at'], r'[1-9][0-9]{0,18}') and
                previous < int(row['created_at']) <= (1 << 53) - 1 and
                migration == {'tag': tag, 'hash': row['hash']}, 'P2_REPLACEMENT_JOURNAL_RECEIPT_REFUSED')
        previous = int(row['created_at'])
    observed = replacement.observation(probe, physical)
    expected = {**observed, 'status': 'P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED',
                'operation': 'verify-replacement-written', 'physicalObservationSha256': migrate.file_hash(physical),
                'databaseReceiptSha256': migrate.file_hash(database_raw), 'continuationStartedSha256': migrate.file_hash(started_raw),
                'owner': owner, 'runtime': runtime, 'producerSha256': producer, 'appliedMigrationCount': len(tags),
                'epoch': '1', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0,
                'schemaVerified': True, 'runtimeRoleVerified': True,
                'administrativeLogins': sorted(administrative_logins, key=lambda role: role['name']),
                'effectiveLoginBoundaryVerified': True}
    require(replacement.canonical(postflight) == replacement.canonical(expected),
            'P2_REPLACEMENT_INDEPENDENT_POSTFLIGHT_REFUSED')
    return database


class P2ProfiledReplacementScope(P2ProfiledCurrentScope):
    """Fixed apply-forward continuation. Only the source broker can construct it."""

    _guard_written_observation = 'p2-frontend-replacement-written-observation.json'
    _frontend_records = ('frontend-original-database-receipt.json', 'frontend-continuation-started.json',
                         'frontend-replacement-written-observation.json')

    def __init__(self, parent, *, postflight_raw, database_raw, started_raw, owner, runtime, producer_sha256,
                 api_job_sha256, configuration_sha256):
        import p2_frontend_replacement_parent as replacement
        from p2_replacement_runtime_containment import replacement_write_label, verify_runtime_intent
        from staging_state import CONFIGURATION_FILES
        require = migrate.demand
        require(type(parent) is replacement.ReplacementWriteBroker and parent.initial['mode'] == replacement.WRITE_MODE and
                getattr(parent, 'scope', None) is None and parent.probe is not None and parent.write_observation is not None,
                'P2_REPLACEMENT_SOURCE_PARENT_REQUIRED')
        require(type(api_job_sha256) is dict and set(api_job_sha256) == set(migrate.SERVICES) and
                all(replacement.digest(value) for value in api_job_sha256.values()) and
                type(configuration_sha256) is dict and set(configuration_sha256) == set(CONFIGURATION_FILES) and
                all(replacement.digest(value) for value in configuration_sha256.values()),
                'P2_REPLACEMENT_RUNTIME_REVIEW_REQUIRED')
        self.bundle, self.directory = Path(parent.initial['bundle']), parent.directory
        release, jobs = migrate.make_plan(self.bundle, expected_profile=PROFILE)
        probe = parent.probe
        replacement.verify_bundle(self.bundle, parent.plan, probe)
        require(set(jobs) == {*migrate.SERVICES, 'frontend'} and release == probe['candidate'] and
                jobs['frontend']['job'] == probe['job'] and
                parent.initial['candidateSha256'] == parent.plan['candidateSha256'] and
                parent.initial['sourceCommit'] == parent.plan['sourceCommit'] == probe['job']['sourceCommit'] and
                migrate.profiled_current_job_hashes(self.bundle) == api_job_sha256,
                'P2_REPLACEMENT_RUNTIME_INPUTS_CHANGED')
        require(all(type(raw) is bytes and 0 < len(raw) <= maximum and raw.endswith(b'\n')
                    for raw, maximum in ((postflight_raw, 8192), (database_raw, 65_536), (started_raw, 8192))),
                'P2_REPLACEMENT_RECEIPT_BYTES_REFUSED')
        require(replacement.private_record(self.directory, self._guard_written_observation, 8192) == postflight_raw,
                'P2_REPLACEMENT_GUARD_READBACK_CHANGED')
        verify_runtime_intent(parent.initial, parent.plan, self.directory, configuration_sha256=configuration_sha256,
                              api_job_sha256=api_job_sha256, postflight_sha256=migrate.file_hash(postflight_raw))
        receipt = _replacement_producer_bytes(probe, parent.write_observation, database_raw, started_raw,
                                               postflight_raw, owner, runtime, producer_sha256,
                                               parent.plan['replacement']['administrativeLogins'])
        self.api_job_sha256 = copy.deepcopy(api_job_sha256)
        self.runtime_cleanup_label = replacement_write_label(parent.initial['reviewedPlanSha256'])
        self.original_frontend_bytes = (database_raw, started_raw, postflight_raw)
        recovery = getattr(parent, 'recovery', None)
        super().__init__(parent.lock_fd, replacement.LOCK, lambda: replacement.ReplacementWriteBroker.verify_replacement_runtime(parent),
                         receipt, parent.initial['candidateSha256'], release=release, jobs=jobs,
                         configuration_sha256=configuration_sha256,
                         recovery_action_id=recovery['actionId'] if recovery is not None else None)
        self.runtime_parent = parent
        for name, raw in zip(self._frontend_records, self.original_frontend_bytes):
            migrate.write_exact_bytes(self.directory, name, raw)

    def require_frontend(self, release, info):
        migrate.demand(release == self.release and info == self.jobs['frontend'],
                       'P2_REPLACEMENT_FRONTEND_INPUTS_CHANGED')
        return P2ReleaseScope.require_frontend(self, release, info)

    def _require_parent(self):
        from p2_frontend_replacement_parent import ReplacementWriteBroker
        self.verify()
        parent = self.runtime_parent
        migrate.demand(type(parent) is ReplacementWriteBroker and parent.scope is self and parent.lock_fd == self.descriptor,
                       'P2_REPLACEMENT_SOURCE_PARENT_REQUIRED')
        return parent

    def run(self, args, **options):
        from p2_frontend_replacement_parent import ReplacementWriteBroker
        if len(args) > 1 and args[0] == 'docker' and (
            args[1] in ('run', 'stop', 'start', 'restart', 'kill') or
            args[1] == 'compose' and any(verb in args[2:] for verb in ('up', 'start', 'stop', 'down', 'restart', 'kill'))
        ):
            ReplacementWriteBroker.verify_replacement_mutation(self._require_parent())
        return super().run(args, **options)

    def api_job_bytes(self, name):
        from qualification_target_profile import decode_qualification_target_json
        self._require_parent()
        migrate.demand(name in migrate.SERVICES, 'P2_REPLACEMENT_API_JOB_REQUIRED')
        raw = migrate.read_input(self.bundle, f'jobs/{name}.json')
        migrate.demand(migrate.file_hash(raw) == self.api_job_sha256[name] and
                       decode_qualification_target_json(raw, 'carrier') == self.jobs[name]['job'],
                       'P2_REPLACEMENT_API_JOB_BYTES_CHANGED')
        self.verify()
        return raw

    def frontend_replacement_receipt_bytes(self):
        import p2_frontend_replacement_parent as replacement
        self._require_parent()
        raw = tuple(replacement.private_record(self.directory, name, 65_536) for name in self._frontend_records)
        migrate.demand(raw == self.original_frontend_bytes, 'P2_REPLACEMENT_RETAINED_BYTES_CHANGED')
        migrate.demand(replacement.private_record(self.directory, self._guard_written_observation, 8192) == raw[2],
                       'P2_REPLACEMENT_GUARD_READBACK_CHANGED')
        self.verify()
        return raw

    def api_role_policy_supplement(self, name):
        parent = self._require_parent()
        recovery = getattr(parent, 'recovery', None)
        if recovery is None or 'rolePolicySupplement' not in recovery:
            return None
        migrate.demand(self.recovery_action_id == recovery['actionId'] and self.prior_gateway is not None and
                       self.prior_gateway.stopped and name in migrate.SERVICES,
                       'REPLACEMENT_RECOVERY_ROLE_POLICY_ARTIFACT_REFUSED')
        pin, raw = migrate.read_replacement_role_policy_artifact(
            parent.initial, recovery, name, self.release['sources'][name]['commit'])
        self.verify()
        return pin, raw

    def runtime_ready(self, attempt, migration_attempt, snapshot, selected, outcome):
        from p2_frontend_replacement_parent import ReplacementWriteBroker
        return ReplacementWriteBroker.replacement_runtime_ready(
            self._require_parent(), attempt, migration_attempt, snapshot, selected, outcome)

    def cleanup_runtime_helper(self, name, env):
        from p2_replacement_runtime_containment import cleanup_named_replacement_helper

        def run(args, timeout):
            return self.run(args, timeout=timeout, check=True, capture_output=True, text=True, env=env).stdout.strip()

        cleanup_named_replacement_helper(run, name, self.release['releaseId'], self.runtime_cleanup_label)
