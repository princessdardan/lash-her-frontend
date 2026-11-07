"""Typed current-only staging scope. JSON receipts never construct this object."""
import copy
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
        require_profiled(release, jobs['frontend']['job'], jobs['frontend']['job']['target'], receipt)
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256,
                         release=release, jobs=jobs, configuration_sha256=configuration_sha256)
        self.require_frontend(release, jobs['frontend'])

    @property
    def recovery_action_id(self):
        return self._recovery_action_id

    def verify(self):
        migrate.demand(self.close_deadline is None, 'P2_PROFILED_CURRENT_CLOSE_ONLY')
        super().verify()

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
        migrate.demand(isinstance(parent, P2ProfiledCurrentBroker) and parent.scope is self,
                       'P2_PROFILED_CURRENT_SOURCE_PARENT_REQUIRED')
        # Source class method, never a callback or callable decoded from input.
        return P2ProfiledCurrentBroker.runtime_ready(parent, attempt, migration_attempt, snapshot, selected, outcome)

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
