"""Typed current-only staging scope. JSON receipts never construct this object."""
import copy
from contextvars import ContextVar
import fcntl
import os
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
