#!/usr/bin/env python3
"""Fixed profiled current-only recovery broker.

The release parent owns the actual host flock, frontend observer, API runner and
close protocol. This subclass only selects the closed recovery disposition,
retains original evidence and verifies GET-only frontend/API recovery results.
"""
import copy
import json
from pathlib import Path
import re
import signal
import sys
import threading
import time

if __name__ == '__main__':
    previous = sys.modules.get('p2_profiled_current_recovery')
    if previous is not None and previous is not sys.modules[__name__]:
        raise SystemExit('P2_PROFILED_CURRENT_RECOVERY_MODULE_IDENTITY_REFUSED')
    sys.modules['p2_profiled_current_recovery'] = sys.modules[__name__]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate
import release as runtime
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
DISPOSITIONS = frozenset(('restore-current-runtime', 'reconcile-frontend-get-first', 'resume-approved-api-suffix'))
ORIGINAL_NAMES = ('candidate', 'frontendDatabase', 'frontendContinuationStarted', 'apiMigrationOutcome',
                  'apiRuntimeOutcome', 'frontendBuildOutcome', 'frontendPromotionStarted', 'frontendWorkloadOutcome')
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
        'recoveryActionId', 'originalReleaseId', 'disposition', 'originalReceiptSha256'))
    EXTRA_OPTIONAL_INITIAL_FIELDS = frozenset(('approvedApiSuffix',))

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
        require(all(sha(migrate.read_input(directory, name)) == pins[key]
                    for key, (directory, name) in paths.items()),
                'P2_PROFILED_CURRENT_ORIGINAL_HOST_RECEIPTS_REQUIRED')

    def record_base(self, status):
        value = super().record_base(status)
        value.update(recoveryActionId=self.action_id(), originalReleaseId=self.selected['releaseId'],
                     disposition=self.initial['disposition'],
                     originalReceiptSha256=copy.deepcopy(self.initial['originalReceiptSha256']))
        return value

    def select_release(self, initial):
        selected, jobs, plan, compose = super().select_release(initial)
        receipts = initial.get('originalReceiptSha256')
        require(type(initial.get('recoveryActionId')) is str and
                re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', initial['recoveryActionId']) and
                initial['recoveryActionId'] != selected['releaseId'] and
                initial.get('originalReleaseId') == selected['releaseId'] and
                initial.get('disposition') in DISPOSITIONS and
                type(receipts) is dict and tuple(receipts) == ORIGINAL_NAMES and
                all(valid_digest(value) for value in receipts.values()),
                'P2_PROFILED_CURRENT_RECOVERY_BINDING_REQUIRED')
        suffix = initial.get('approvedApiSuffix')
        if initial['disposition'] == 'resume-approved-api-suffix':
            require(type(suffix) is dict and set(suffix) == {'course', 'community'} and
                    all(type(value) is list and all(type(tag) is str and re.fullmatch(r'\d{4}_[a-z0-9_]+', tag)
                                                    for tag in value) for value in suffix.values()),
                    'P2_PROFILED_CURRENT_API_SUFFIX_REQUIRED')
        else:
            require(suffix is None, 'P2_PROFILED_CURRENT_API_SUFFIX_REFUSED')
        return selected, jobs, plan, compose

    def create_scope(self, receipt):
        return P2ProfiledCurrentScope(self.lock_fd, LOCK, self.check, receipt,
            self.initial['candidateSha256'], release=self.selected, jobs=self.jobs,
            configuration_sha256=self.initial['configurationSha256'], recovery_action_id=self.action_id())

    def start_runtime(self, identity):
        require(self.scope is not None and self.prior_gateway is not None and self.worker is None,
                'P2_PROFILED_CURRENT_RECOVERY_RUNTIME_STAGE_REFUSED')

        def worker():
            try:
                result = runtime.execute(self.bundle, self.configuration, self.results,
                    self.source / 'ops/platform/compose.yaml', True,
                    'staging/' + self.selected['releaseId'], LOCK,
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

    def _require_current_api(self):
        self.check()
        require(self.ready is not None and self.api_attempt is not None and self.migration_attempt is not None,
                'P2_PROFILED_CURRENT_RECOVERY_API_NOT_READY')
        runtime_receipt = migrate.read_json(self.api_attempt, 'runtime-outcome.json', expected_profile=PROFILE)
        migration_receipt = migrate.read_json(self.migration_attempt, 'migration-outcome.json', expected_profile=PROFILE)
        require(runtime_receipt == self.ready and runtime_receipt.get('status') == 'API_RUNTIME_READY' and
                migration_receipt.get('status') == 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN' and
                migration_receipt.get('candidateSha256') == self.initial['candidateSha256'] and
                all(runtime_receipt.get(key) is False for key in FALSE_FIELDS),
                'P2_PROFILED_CURRENT_RECOVERY_API_CURRENT_REQUIRED')
        return runtime_receipt, migration_receipt

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

    def resume_api_suffix(self):
        require(self.initial['disposition'] == 'resume-approved-api-suffix',
                'P2_PROFILED_CURRENT_API_SUFFIX_REFUSED')
        runtime_receipt, migration_receipt = self._require_current_api()
        require(migration_receipt.get('approvedApiSuffix') == self.initial['approvedApiSuffix'] and
                migration_receipt.get('committedPrefixReplayed') is False and
                migration_receipt.get('frontendSqlApplied') is False,
                'P2_PROFILED_CURRENT_API_SUFFIX_UNVERIFIED')
        self.api_suffix_resumed = True
        return {**self.record_base('P2_PROFILED_CURRENT_API_SUFFIX_RESUMED'),
                'runtimeReceiptSha256': sha(encoded(runtime_receipt)),
                'migrationReceiptSha256': sha(encoded(migration_receipt))}

    def runtime_restored(self):
        runtime_receipt, migration_receipt = self._require_current_api()
        self._runtime_readback()
        self.runtime_current = True
        return {**self.record_base('P2_PROFILED_CURRENT_RUNTIME_RESTORED'),
                'runtimeReceiptSha256': sha(encoded(runtime_receipt)),
                'migrationReceiptSha256': sha(encoded(migration_receipt))}

    def finish_receipts(self, value):
        self.check()
        require(self.session_closed_proof is not None and not self.finished and self.worker_done.is_set() and
                getattr(self, 'runtime_current', False) and self.promoted is not None,
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
                outcome.get('apiSuffixResumed') is (self.initial['disposition'] == 'resume-approved-api-suffix') and
                outcome.get('frontendEffectReconciled') is
                (self.initial['disposition'] == 'reconcile-frontend-get-first') and
                all(outcome.get(key) is False for key in
                    ('frontendSqlApplied', 'rolePreparationAuthorized', 'historicalLoginsRestored',
                     'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted')),
                'P2_PROFILED_CURRENT_RECOVERY_OUTCOME_REQUIRED')
        self._frontend_readback(self.promoted)
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
            'frontendWorkloadReceiptSha256': self.promoted['workloadReceiptSha256'],
            'apiRuntimeReceiptSha256': sha(migrate.read_input(self.api_attempt, 'runtime-outcome.json')),
            'migrationOutcomeSha256': sha(migrate.read_input(self.migration_attempt, 'migration-outcome.json')),
            'runtimeCurrent': True,
            'apiSuffixResumed': self.initial['disposition'] == 'resume-approved-api-suffix',
            'frontendEffectReconciled': self.initial['disposition'] == 'reconcile-frontend-get-first'}
        self.finished = True
        return copy.deepcopy(self.outcome)

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_PROTOCOL_ID_REFUSED')
        suffix = operation.removeprefix(self.OP + '-') if type(operation) is str and operation.startswith(self.OP + '-') else operation
        fields = {'check': (), 'prepare-prior-gateway': (), 'arm': ('receipt', 'continuationStarted', 'probe'),
            'reconcile-frontend': ('observation', 'proof', 'workload'), 'resume-api-suffix': (), 'runtime-restored': (), 'prepare-close': (),
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
            elif suffix == 'reconcile-frontend':
                self.send(identity, self.STATUS + '_FRONTEND_RECONCILED', receipt=self.reconcile_frontend(value))
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
                self._frontend_readback(self.promoted)
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
