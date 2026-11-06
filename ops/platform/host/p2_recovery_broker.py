"""Recovery hooks for the shared supervised broker; no second flock or SQL apply."""
import base64
import json
from pathlib import Path
import threading
import migrate
import release as runtime
import staging_admission
import staging_state
from p2_release_broker import Broker, PhysicalObserver, LOCK, decode
from p2_recovery_runtime import P2RecoveryRuntime
from p2_recovery_scope import P2RecoveryScope

require = migrate.demand


class P2RecoveryPhysicalObserver(PhysicalObserver):
    """Shared transport runs the source-selected recovery observer bytes.

    The parent factory supplies the fixed private recovery program and hash.
    No module paths, callable claims or held JSON arrive from operator input.
    """
    pass


class P2RecoveryBroker(Broker):
    def action_id(self):
        return self.initial['recoveryActionId']

    def directory_name(self):
        return 'p2-recovery-' + self.action_id()

    def terminal_filename(self):
        return 'p2-recovery-outcome.json'

    def select_release(self, initial):
        selected, jobs, plan, compose = runtime.make_plan(Path(initial['bundle']), Path(initial['configuration']), self.source / 'ops/platform/compose.yaml')
        require(initial.get('recoveryActionId') != selected['releaseId'] and migrate.source_commit(initial.get('sourceCommit')) and
                selected == initial['candidate'] and selected['environment'] == 'staging' and selected.get('contractPhase') == 'p2' and
                initial.get('confirmation') == 'staging/' + initial['recoveryActionId'] and
                initial.get('originalReleaseId') == selected['releaseId'] and set(jobs) == {'frontend','course','community'}, 'P2_RECOVERY_ORIGINAL_CANDIDATE_REQUIRED')
        require(migrate.file_hash(json.dumps(initial['configurationSha256'],separators=(',',':'),ensure_ascii=False).encode()) == initial.get('configurationBindingSha256'), 'P2_RECOVERY_REVIEWED_CONFIGURATION_REQUIRED')
        require(initial.get('frontendMode','reuse-retained-ready') in ('reuse-retained-ready','reviewed-new-build') and
            (initial.get('frontendMode')!='reviewed-new-build' or initial.get('forwardReason') in ('prior-build-failed','prior-build-canceled','retained-ready-probe-expired')),'P2_RECOVERY_FRONTEND_MODE_REFUSED')
        return selected, jobs, plan, compose

    def arm(self, request):
        self.check()
        require(self.worker is None and self.scope is None and self.closing_at is None, 'P2_RECOVERY_ALREADY_ARMED')
        raw, receipt = decode(request['receipt'])
        probe = request['probe']
        require(probe.get('job') == self.jobs['frontend']['job'] and probe.get('baseline') == json.loads(self.jobs['frontend']['schema']) and
                probe.get('receipt') == receipt and probe.get('owner') == self.initial['owner'] and probe.get('targetSha256') == self.initial['targetSha256'] and
                receipt.get('retiredLogins') == self.initial['historicalLogins']['retiredLogins'] and receipt.get('producers') == self.initial['producers'] and
                receipt.get('recoveryActionId') == self.action_id() and receipt.get('originalReceiptSha256') == self.initial['originalReceiptSha256'], 'P2_RECOVERY_FRESH_PROBE_BINDING_REQUIRED')
        self.frontend_raw = raw
        self.safety({'operation': 'armed', 'probe': probe})
        self.observer = P2RecoveryPhysicalObserver(self.selected, probe, self.source,
            self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], program=self.observer_program,
            program_sha256=self.initial['sourceSha256']['ops/platform/p2-recovery-current-probe.mjs'])
        self.observer.start(self.abort)
        self.scope = P2RecoveryScope(self.lock_fd, LOCK, self.check, receipt, self.initial['candidateSha256'],
            recovery_action_id=self.action_id(), release=self.selected, jobs=self.jobs, configuration_sha256=self.initial['configurationSha256'])
        self.armed_probe = probe

    def start(self, identity, request):
        self.check()
        require(self.scope is not None and self.worker is None and request.get('probe') == self.armed_probe and
                base64.b64decode(request['receipt'],validate=True) == self.frontend_raw, 'P2_RECOVERY_ARMED_CURRENT_PROOF_REQUIRED')
        def worker():
            try:
                directory = Path(self.initial['results']) / ('runtime-recovery-' + self.action_id())
                directory.mkdir(mode=0o700)
                restore = P2RecoveryRuntime(self.scope, self.selected, self.jobs, Path(self.initial['configuration']), directory,
                    self.source / 'ops/platform/compose.yaml', self.source)
                outcome = restore.restore()
                self.runtime_snapshot, self.ready = restore.snapshot, outcome
                self.check(); self.send(identity, 'API_READY', receipt=outcome)
            except BaseException:
                self.abort(); self.send(identity,'P2_RECOVERY_RUNTIME_FAILED')
            finally:
                self.worker_done.set()
        self.worker = threading.Thread(target=worker, daemon=True); self.worker.start()

    def admit_certification(self):
        # Normal broker frontend-verified calls this hook. Recovery keeps both
        # gateway categories closed until each deliberate FE boundary is proven.
        self.check()
        require(self.promoted is not None, 'P2_RECOVERY_FRONTEND_REQUIRED')

    def restore_gateway(self, flags):
        self.check()
        require(self.promoted is not None and set(flags) == {'newWork','recovery'} and all(type(value) is bool for value in flags.values()) and
                (not flags['newWork'] or flags['recovery']), 'P2_RECOVERY_GATEWAY_STAGE_REFUSED')
        host = staging_admission.Host(self.selected, self.runtime_snapshot, self.vercel)
        before = host.state()
        require(all(before['uncertain'][key] == 0 for key in ('newWork','recovery')), 'P2_RECOVERY_GATEWAY_UNCERTAIN')
        digest = staging_admission.persist_state(self.runtime_snapshot, {'releaseId': self.selected['releaseId'], 'candidateSha256': self.initial['candidateSha256']},
            'p2-recovery-' + self.action_id(), new_work=flags['newWork'], recovery=flags['recovery'])
        after = host.state()
        require(after.get('sha256') == digest and all(after.get(key) is value for key,value in flags.items()), 'P2_RECOVERY_GATEWAY_STAGE_UNVERIFIED')
        self.gateway_flags = dict(flags)
        return {'status': 'P2_RECOVERY_GATEWAY_STAGE_VERIFIED', 'admissionStateSha256': digest, **flags}

    def finish_receipts(self, value):
        require(self.closing_at is not None and not self.finished, 'P2_RECOVERY_CLOSE_NOT_PREPARED')
        raw, outcome = decode(value['recovery'])
        require(outcome.get('status') == 'P2_STAGING_RECOVERY_RESTORATION_VERIFIED' and outcome.get('recoveryActionId') == self.action_id() and
                outcome.get('originalReleaseId') == self.selected['releaseId'] and outcome.get('candidateSha256') == self.initial['candidateSha256'] and
                outcome.get('sourceCommit') == self.selected['sources']['frontend']['commit'] and outcome.get('admissionRestored') is True and
                outcome.get('originalReceiptSha256') == self.initial['originalReceiptSha256'] and outcome.get('originalFrontendTerminalRecreated') is False and
                outcome.get('sqlReplayed') is False and outcome.get('frontendMode','reuse-retained-ready')==self.initial.get('frontendMode','reuse-retained-ready') and
                outcome.get('failedBuildForwardAction')==('COMPLETED' if self.initial.get('frontendMode')=='reviewed-new-build' else 'OPEN'), 'P2_RECOVERY_TERMINAL_BINDING_REFUSED')
        require(self.worker_done.is_set() and not self.failed.is_set() and self.promoted is not None and getattr(self,'gateway_flags',None) == {'newWork':True,'recovery':True}, 'P2_RECOVERY_RUNTIME_NOT_READY')
        migrate.write_json(self.directory, 'p2-recovery-frontend-verification.json', outcome)
        self.finished = True; self.released.set()
        self.outcome.update(outcome, operatorSourceCommit=self.initial['sourceCommit'], recoveryVerificationSha256=migrate.file_hash(raw), frontendCurrentReceiptSha256=migrate.file_hash(self.frontend_raw),
                            g2Accepted=False, wholeReleaseAccepted=False)
        return self.outcome

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_PROTOCOL_ID_REFUSED')
        self.check()
        if self.scope is not None:
            self.scope.require_configuration(Path(self.initial['configuration']))
            if self.runtime_snapshot is not None:
                self.scope.require_configuration(self.runtime_snapshot)
        token = runtime._command_scope.set(self.scope) if self.scope is not None else None
        try:
            if operation == 'arm-recovery':
                self.arm(value); self.send(identity,'RECOVERY_ARMED')
            elif operation == 'recovery-gateway-stage':
                proof = self.observer.probe('observe')
                flags = value.get('flags')
                require(isinstance(flags, dict) and proof.get('admission', {}).get('uncertain') == 0 and
                        all(proof['admission'].get(key) is flag for key,flag in flags.items()), 'P2_RECOVERY_ACTUAL_FRONTEND_ADMISSION_REQUIRED')
                self.send(identity, 'GATEWAY_STAGE_VERIFIED', receipt=self.restore_gateway(flags))
            elif operation == 'finish':
                self.send(identity, 'P2_RECOVERY_JOINED', receipt=self.finish_receipts(value))
            elif operation == 'commit':
                require(self.finished and not self.failed.is_set() and self.worker_done.is_set(), 'P2_RECOVERY_JOIN_REQUIRED')
                require(runtime.check_containers(self.selected,self.runtime_snapshot) == self.ready['containers'], 'P2_RECOVERY_RUNTIME_CHANGED')
                migrate.write_json(self.directory,self.terminal_filename(),self.outcome)
                self.safety({'operation':'committed','sha256':migrate.file_hash(migrate.read_input(self.directory,self.terminal_filename()))})
                self.committed.set(); self.send(identity,'COMMITTED',receipt=self.outcome); return False
            else:
                return super().command(value)
            return True
        finally:
            if token is not None:
                runtime._command_scope.reset(token)
