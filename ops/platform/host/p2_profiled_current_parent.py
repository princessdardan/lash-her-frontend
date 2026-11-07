#!/usr/bin/env python3
"""Fixed, fenced current-profile parent. No frontend SQL or admission opening."""
import base64
from contextlib import nullcontext
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time
from uuid import uuid4

if __name__ == '__main__':
    # Exact supervisor dispatch must see the same class objects as this entry.
    previous = sys.modules.get('p2_profiled_current_parent')
    if previous is not None and previous is not sys.modules[__name__]:
        raise SystemExit('P2_PROFILED_CURRENT_MODULE_IDENTITY_REFUSED')
    sys.modules['p2_profiled_current_parent'] = sys.modules[__name__]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate
import release as runtime
import staging_state
import vercel
from p2_certification_profile import require_profile, RUNTIME_FLAGS
from p2_release_broker import Broker, PhysicalObserver, LOCK, MAXIMUM
from p2_profiled_current_scope import P2ProfiledCurrentScope, PROFILE, COMMON, require_profiled
from p2_source_closure import private_observer_program
from qualification_target_profile import decode_qualification_target_json

require = migrate.demand
PROGRAM = 'ops/platform/p2-profiled-current-probe.mjs'
FRONTEND_PROVIDER_BINDINGS = frozenset((
    'CUSTOMER_AUTH_URL', 'CUSTOMER_AUTH_SECRET', 'CUSTOMER_AUTH_GOOGLE_ID',
    'CUSTOMER_AUTH_GOOGLE_SECRET', 'CUSTOMER_AUTH_RESEND_KEY', 'CUSTOMER_AUTH_EMAIL_FROM',
    'COURSE_LEARNER_JWT_CURRENT_SECRET', 'COURSE_ADMIN_JWT_CURRENT_SECRET',
    'COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET', 'COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET',
))
ADMIN_ORIGIN_BINDINGS = frozenset(('AUTH_URL', 'NEXTAUTH_URL'))
FALSE_FIELDS = ('frontendSqlApplied', 'historicalProviderClosureClaimed', 'oldP200Qualified',
                'nativeSchedulesEnabled', 'trafficAuthorized', 'releaseAccepted')
PROOF_FIELDS = frozenset(('version', 'qualificationTargetProfile', 'status', 'environment', 'actionId',
    'releaseId', 'sourceCommit', 'targetSha256', 'candidateSha256', 'configurationSha256', 'contractPhase',
    'phase2ContractManifestSha256', 'projectId', 'deploymentId', 'readyState', 'aliasJobState', 'aliasDeploymentId',
    'aliasJobDeploymentId', 'aliasJobMatchesIntent', 'aliasJobType', 'workloadVerified', 'workloadReceiptSha256',
    'configurationRecordSha256', 'featureControls', 'writerAdmissionBinding', 'certificationSchedule',
    'admissionNewWork', 'admissionRecovery', *FALSE_FIELDS))
WORKLOAD_FIELDS = frozenset(('version', 'qualificationTargetProfile', 'environment', 'projectId', 'sourceCommit',
    'releaseId', 'deploymentId', 'previousDeploymentId', 'status', 'phase', 'trafficAuthorized',
    'nativeSchedulerVerified', 'checks', 'contractPhase', 'phase2ContractManifestSha256', 'featureControls',
    'writerAdmissionBinding'))
LAYOUT = {'actionIdKey': 'releaseId', 'receiptPrefix': 'p2-profiled-current-',
          'runtimePrefix': 'runtime-', 'terminalName': 'p2-profiled-current-outcome.json',
          'terminalStatus': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION'}


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def decode_profiled(value):
    require(type(value) is str and 0 < len(value) <= MAXIMUM, 'P2_PROFILED_CURRENT_RECEIPT_REQUIRED')
    raw = base64.b64decode(value, validate=True)
    parsed = decode_qualification_target_json(raw, 'carrier')
    require(type(parsed) is dict and type(parsed.get('version')) is int and parsed['version'] == 2,
            'P2_PROFILED_CURRENT_RECEIPT_REQUIRED')
    require_profiled(parsed)
    return raw, parsed


def retain_raw(directory, name, raw):
    require(type(raw) is bytes and 0 < len(raw) <= 2_000_000, 'P2_PROFILED_CURRENT_RECEIPT_BOUNDS')
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(descriptor, view)
            require(count > 0, 'P2_PROFILED_CURRENT_RECEIPT_WRITE_FAILED')
            view = view[count:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    require(migrate.read_input(directory, name) == raw, 'P2_PROFILED_CURRENT_RECEIPT_CHANGED')


class P2ProfiledCurrentPhysicalObserver(PhysicalObserver):
    def probe(self, operation):
        require(operation in ('verify-schema', 'observe', 'fence', 'verify-closed'),
                'P2_PROFILED_CURRENT_PROBE_OPERATION_REFUSED')
        require_profiled(self.selected, self.request, self.request['job'], self.request['job']['target'], self.request['receipt'])
        require(type(self.request.get('version')) is int and self.request['version'] == 2 and
                self.request['job']['target']['approvedPendingTags'] == [], 'P2_PROFILED_CURRENT_PROBE_BINDING_REFUSED')
        program = self.program or self.source / PROGRAM
        require(self.program_sha256 is not None and sha(program.read_bytes()) == self.program_sha256,
                'P2_PRIVATE_OBSERVER_CHANGED')
        name = 'lash-p2-profiled-current-observer-' + uuid4().hex
        image = self.selected['artifacts']['frontendMigration']['image']
        env = {**runtime.SAFE_ENV, 'FRONTEND_STAGING_MIGRATION_DATABASE_URL': self.credential}
        args = ['docker', 'run', '--rm', '--name', name, '--interactive', '--network', 'host', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64',
                '--env', 'FRONTEND_STAGING_MIGRATION_DATABASE_URL', '--mount',
                f'type=bind,src={program},dst=/app/{PROGRAM},readonly', '--entrypoint', 'node', image, PROGRAM]
        try:
            result = subprocess.run(args, input=encoded({**self.request, 'operation': operation}),
                                    capture_output=True, env=env, timeout=30, check=True)
        finally:
            subprocess.run(['docker', 'rm', '--force', name], env=runtime.SAFE_ENV, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=15, check=False)
            remaining = runtime.command(['docker', 'container', 'ls', '--all', '--filter',
                'name=^/' + name + '$', '--format', '{{.ID}}'], runtime.SAFE_ENV, 15)
            require(not remaining, 'P2_OBSERVER_CONTAINER_CLEANUP_UNVERIFIED')
            require(sha(program.read_bytes()) == self.program_sha256, 'P2_PRIVATE_OBSERVER_CHANGED')
        require(len(result.stdout) <= 8192, 'P2_OBSERVER_OUTPUT_REFUSED')
        value = decode_qualification_target_json(result.stdout, 'carrier')
        require_profiled(value)
        expected = {'fence': 'P2_PROFILED_CURRENT_ADMISSION_CLOSED',
                    'verify-closed': 'P2_PROFILED_CURRENT_SESSION_CLOSED'}.get(operation, 'P2_PROFILED_CURRENT_PHYSICAL_LOCK_VERIFIED')
        common = {'version', 'qualificationTargetProfile', 'status', 'environment', 'releaseId', 'sourceCommit', 'targetSha256'}
        fields = {'fence': common, 'verify-closed': common | {'originalBackendPid', 'originalBackendStart', 'backendAbsent',
            'migrationLockReleased', 'nonceLockReleased', 'admission'}}.get(operation, common | {'marker', 'backendPid', 'backendStart', 'admission'})
        require(set(value) == fields and type(value.get('version')) is int and value['version'] == 2 and value.get('status') == expected and
            value.get('environment') == 'staging' and value.get('releaseId') == self.selected['releaseId'] and
            value.get('sourceCommit') == self.request['job']['sourceCommit'] and
            value.get('targetSha256') == self.request['targetSha256'], 'P2_PROFILED_CURRENT_PHYSICAL_OBSERVATION_REFUSED')
        if operation == 'fence':
            # The fixed fence proves its control-row close, not global drain.
            return value
        if operation == 'verify-closed':
            require(value.get('originalBackendPid') == self.request['backendPid'] and
                value.get('originalBackendStart') == self.request['backendStart'] and
                all(value.get(key) is True for key in ('backendAbsent', 'migrationLockReleased', 'nonceLockReleased')),
                'P2_PROFILED_CURRENT_SESSION_STILL_OPEN')
        else:
            require(all(value.get(key) == self.request[key] for key in ('marker', 'backendPid', 'backendStart')),
                    'P2_PROFILED_CURRENT_PHYSICAL_OBSERVATION_REFUSED')
        admission = value.get('admission')
        require(type(admission) is dict and set(admission) == {'epoch', 'newWork', 'recovery', 'active', 'uncertain'} and
            admission.get('newWork') is False and admission.get('recovery') is False and
            all(type(admission.get(key)) is int and admission[key] >= 0 for key in ('active', 'uncertain')) and
            type(admission.get('epoch')) is str and re.fullmatch(r'[1-9][0-9]{0,18}', admission['epoch']),
            'P2_PROFILED_CURRENT_CLOSED_ADMISSION_REQUIRED')
        require(admission['epoch'] == self.expected_epoch and admission['active'] == admission['uncertain'] == 0,
                'P2_PROFILED_CURRENT_CLOSED_ADMISSION_REQUIRED')
        return value


class P2ProfiledCurrentBroker(Broker):
    MODE = 'p2-profiled-current-release'
    PREFIX = 'p2-profiled-current-'
    OP = 'profiled-current'
    STATUS = 'PROFILED_CURRENT'
    TERMINAL = LAYOUT['terminalStatus']
    TERMINAL_NAME = LAYOUT['terminalName']
    EXTRA_REQUIRED_INITIAL_FIELDS = frozenset()
    EXTRA_OPTIONAL_INITIAL_FIELDS = frozenset()

    def __init__(self, initial, output, *, shared_lock_fd=None, safety_write=None, guard_read=None,
                 observer_type=P2ProfiledCurrentPhysicalObserver, observer_source=PROGRAM):
        require(issubclass(observer_type, P2ProfiledCurrentPhysicalObserver) and observer_source == PROGRAM,
                'P2_PROFILED_CURRENT_FIXED_OBSERVER_REQUIRED')
        super().__init__(initial, output, shared_lock_fd=shared_lock_fd, safety_write=safety_write,
                         guard_read=guard_read, observer_type=observer_type, observer_source=observer_source)
        self.runtime_released = threading.Event()
        self.armed_probe = self.arm_identity = self.session_closed_proof = None
        self.raw_pins = {}
        self.api_job_sha256 = None
        self.failure_lock = threading.RLock()
        self.fallback_started = False
        self.outcome.update(version=2, qualificationTargetProfile=copy.deepcopy(PROFILE),
                            **{key: False for key in FALSE_FIELDS})

    def directory_name(self):
        return self.PREFIX + self.action_id()

    def terminal_filename(self):
        return self.TERMINAL_NAME

    def failure_profile(self):
        return copy.deepcopy(PROFILE)

    def registered_children_quiesced(self):
        if self.scope is None:
            return True
        try:
            with self.scope.mutations:
                return all(process.poll() is not None for process in self.scope.processes)
        except BaseException:
            return False

    def contain_failure_without_guard(self):
        with self.failure_lock:
            if self.fallback_started:
                return
            thread = self.observer.thread if self.observer is not None else None
            if thread is not None and thread is not threading.current_thread() and thread.is_alive():
                # The observer may be entering abort itself. Never join it
                # under the same lock it needs in order to finish.
                return
            if self.scope is not None:
                try:
                    self.scope.revoke()
                except BaseException:
                    self.outcome['workerProcessCleanupUncertain'] = True
            if not self.registered_children_quiesced():
                self.outcome.update(workerProcessCleanupUncertain=True, workerProcessesQuiesced=False,
                                    runtimeStopped=None)
                return
            self.fallback_started = True
            # This is the fixed source cleanup after revocation, not a runtime
            # command through the revoked frontend session or mutation scope.
            token = runtime._command_scope.set(None)
            try:
                result = super().contain_failure_without_guard()
                if result is False:
                    # The shared helper guarantees no mutation before False.
                    self.fallback_started = False
                else:
                    self.outcome['workerProcessesQuiesced'] = True
            except BaseException:
                self.outcome['profiledCurrentContainmentUncertain'] = True
            finally:
                runtime._command_scope.reset(token)

    def abort(self):
        with self.failure_lock:
            if self.observer is not None:
                self.observer.stop_event.set()
            try:
                super().abort()
            finally:
                self.runtime_released.set()
        # The first abort may have delegated to a then-healthy guard. If the
        # observer was still alive, wait outside the lock before the only pass.
        if not self.guard_alive:
            if self.observer is not None:
                try:
                    self.observer.stop()
                except BaseException:
                    self.outcome['profiledCurrentReadonlyCleanupUncertain'] = True
            self.contain_failure_without_guard()

    def close(self, committed=False):
        from p2_release_supervisor import sticky_cleanup_signals
        signals = sticky_cleanup_signals() if threading.current_thread() is threading.main_thread() else nullcontext()
        with signals:
            if not committed:
                self.abort()
            # Do not hold failure_lock while waiting on workers that may be
            # unwinding through abort(). The actual host flock stays open.
            while (self.operation_active.locked() or not self.registered_children_quiesced() or
                   self.worker is not None and not self.worker_done.is_set()):
                if not committed and not self.guard_alive:
                    self.abort()
                time.sleep(0.1)
            if self.observer is not None:
                self.observer.stop_event.set()
                thread = self.observer.thread
                if thread is not None and thread is not threading.current_thread():
                    while thread.is_alive():
                        thread.join(0.1)
            with self.failure_lock:
                if not committed and not self.guard_alive:
                    self.contain_failure_without_guard()
                require(self.registered_children_quiesced(), 'P2_PROFILED_CURRENT_CHILD_CLEANUP_UNVERIFIED')
                super().close(committed)

    def send(self, identity, status, **data):
        require(len(encoded({'id': identity, 'status': status, **data})) <= MAXIMUM,
                'P2_PROFILED_CURRENT_FRAME_BOUNDS')
        super().send(identity, status, **data)

    def record_base(self, status):
        return {'version': 2, 'qualificationTargetProfile': copy.deepcopy(PROFILE), 'status': status,
            'environment': 'staging', 'releaseId': self.selected['releaseId'],
            'sourceCommit': self.selected['sources']['frontend']['commit'],
            'candidateSha256': self.initial['candidateSha256'], 'configurationSha256': copy.deepcopy(self.initial['configurationSha256']),
            'targetSha256': self.initial['targetSha256'], 'inventorySha256': self.initial['inventorySha256'],
            **migrate.contract_identity(self.selected), **{key: False for key in FALSE_FIELDS}}

    def select_release(self, initial):
        selected, jobs, plan, compose = runtime.make_plan(self.bundle, self.configuration,
            self.source / 'ops/platform/compose.yaml', expected_profile=PROFILE)
        require_profiled(initial, selected, jobs['frontend']['job'], jobs['frontend']['job']['target'])
        require(selected == initial['candidate'] and selected.get('environment') == 'staging' and
            selected.get('contractPhase') == 'p2' and selected['sources']['frontend']['commit'] == initial['sourceCommit'] and
            set(jobs) == {'frontend', 'course', 'community'} and jobs['frontend']['job']['target']['approvedPendingTags'] == [],
            'P2_PROFILED_CURRENT_CANDIDATE_REQUIRED')
        return selected, jobs, plan, compose

    def initialize(self):
        p = self.initial
        required = {'version', 'qualificationTargetProfile', 'mode', 'environment', 'sourceCommit', 'sourceSha256',
            'sourceClosureSha256', 'hostMachineId', 'candidate', 'candidateSha256', 'bundle', 'configuration', 'results',
            'configurationSha256', 'confirmation', 'credentials', 'vercelToken', 'frontendJob', 'frontendBaseline',
            'targetSha256', 'owner', 'certification', 'expectedWriterAdmissionBinding', 'gatewayObservation',
            'inventory', 'inventorySha256', 'reviewedPlanSha256', 'apiJobSha256'}
        # The supervisor adds its fixed private process fields after decoding.
        required |= self.EXTRA_REQUIRED_INITIAL_FIELDS
        guard_keys = {'_guardLayout', '_guardObserverSource', '_guardObserverProgram', '_guardLockDescriptor'}
        public_keys = set(p) - guard_keys
        require(required <= public_keys <= required | {'priorGatewayReference'} | self.EXTRA_OPTIONAL_INITIAL_FIELDS and
            type(p.get('version')) is int and p['version'] == 2 and p.get('mode') == self.MODE and
            p.get('environment') == 'staging', 'P2_PROFILED_CURRENT_INITIAL_REFUSED')
        require_profiled(p, p['candidate'], p['frontendJob'], p['frontendJob']['target'], p['inventory'])
        restoration = p['inventory'].get('restoration')
        require_profiled(restoration)
        require(p['frontendJob']['target']['approvedPendingTags'] == [] and p['inventory'].get('admissionMode') == 'existing' and
            type(restoration) is dict and set(restoration) == {'version', 'qualificationTargetProfile', 'recovery', 'newWork',
                'nativeSchedulesEnabled', 'providerIngress', 'gatewayBindingSha256'} and
            type(restoration['version']) is int and restoration['version'] == 2 and
            all(restoration[key] is False for key in ('recovery', 'newWork', 'nativeSchedulesEnabled')) and
            restoration['providerIngress'] == 'keep-retired' and type(restoration['gatewayBindingSha256']) is str and
            re.fullmatch(r'[a-f0-9]{64}', restoration['gatewayBindingSha256']) and restoration['gatewayBindingSha256'] != '0' * 64,
            'P2_PROFILED_CURRENT_FENCED_MODE_REQUIRED')
        require(sha(encoded(p['inventory'])) == p['inventorySha256'] and
            type(p['inventory'].get('expectedEpoch')) is str and re.fullmatch(r'[1-9][0-9]{0,17}', p['inventory']['expectedEpoch']) and
            all(type(p.get(key)) is str and re.fullmatch(r'[a-f0-9]{64}', p[key]) and p[key] != '0' * 64
                for key in ('candidateSha256', 'targetSha256', 'reviewedPlanSha256')), 'P2_PROFILED_CURRENT_PLAN_BINDING_REQUIRED')
        api_pins = p['apiJobSha256']
        require(type(api_pins) is dict and set(api_pins) == {'course', 'community'} and
                all(type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) and value != '0' * 64
                    for value in api_pins.values()), 'P2_PROFILED_CURRENT_API_JOB_PINS_REQUIRED')
        require(self.shared_lock_fd is not None and self.safety_write is not None and self.guard_read is not None,
                'P2_INDEPENDENT_SUPERVISOR_REQUIRED')
        require(os.geteuid() == 0 and migrate.source_commit(p['sourceCommit']), 'P2_SELECTED_ROOT_HOST_REQUIRED')
        self.source = Path(__file__).resolve().parents[3]
        require(str(self.source) == '/opt/lash-her/operators/' + p['sourceCommit'], 'P2_INSTALLED_SOURCE_REQUIRED')
        self.require_source_closure(p)
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, 'P2_INDEPENDENT_GUARD_HANDSHAKE_REQUIRED')
        for key in ('bundle', 'configuration', 'results'):
            path = Path(p[key])
            require(path.is_absolute() and str(path.resolve()) == str(path) and
                str(path).startswith('/var/lib/lash-her/releases/staging/') and ',' not in str(path), 'P2_PRIVATE_HOST_PATH_REFUSED')
            migrate.private_directory(path)
        self.bundle, self.configuration, self.results = (Path(p[key]) for key in ('bundle', 'configuration', 'results'))
        self.api_job_sha256 = copy.deepcopy(api_pins)
        self.verify_api_job_inputs()
        self.selected, self.jobs, self.plan, _ = self.select_release(p)
        require(migrate.file_hash(migrate.read_input(self.bundle, 'release.candidate.json')) == p['candidateSha256'] and
            self.jobs['frontend']['job'] == p['frontendJob'] and json.loads(self.jobs['frontend']['schema']) == p['frontendBaseline'] and
            self.plan['hostMachineId'] == p['hostMachineId'], 'P2_PROFILED_CURRENT_REVIEWED_INPUTS_CHANGED')
        runtime.assert_host(self.plan)
        require_profile(p['certification'])
        for service, flags in RUNTIME_FLAGS.items():
            values = runtime.environment_values(migrate.read_input(self.configuration, service + '.env', 65536),
                                                 'staging', service, self.jobs, expected_profile=PROFILE)
            require(all(values.get(key) == value for key, value in flags.items()), 'P2_CERTIFICATION_RUNTIME_FLAGS_REQUIRED')
        require(staging_state.configuration_hashes(self.configuration) == p['configurationSha256'] and
            p['confirmation'] == 'staging/' + self.action_id(), 'P2_PROFILED_CURRENT_CONFIGURATION_REQUIRED')
        credentials = p['credentials']
        require(type(credentials) is dict and set(credentials) == {'FRONTEND_STAGING_MIGRATION_DATABASE_URL',
            'COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL'} and
            all(type(value) is str and 0 < len(value) <= 16384 for value in credentials.values()), 'P2_NAMED_CREDENTIALS_REQUIRED')
        for key, value in credentials.items():
            os.environ[key] = value
        self.vercel = vercel.Client(p['vercelToken'])
        self.lock_fd = self.shared_lock_fd
        info, actual = os.fstat(self.lock_fd), os.lstat(LOCK)
        require(stat.S_ISREG(actual.st_mode) and actual.st_uid == 0 and not actual.st_mode & 0o077 and
            (info.st_dev, info.st_ino) == (actual.st_dev, actual.st_ino), 'P2_ACTUAL_HOST_LOCK_REQUIRED')
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock_info = info
        self.directory = self.results / self.directory_name()
        self.directory.mkdir(mode=0o700)
        self.observer_program = private_observer_program(p, self.directory / 'private-source')
        self.outcome.update(self.record_base('P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW'))
        migrate.write_json(self.directory, 'p2-profiled-current-started.json',
                           {**self.outcome, 'apiJobSha256': copy.deepcopy(self.api_job_sha256)})
        self.check()
        self.preflight_frontend_bindings()
        self.prior_gateway = None
        self.prior_gateway_preflight = self.preflight_prior_gateway()
        migrate.write_json(self.directory, 'prior-gateway-preflight.json', self.prior_gateway_preflight)
        def parent_watch():
            while not self.committed.wait(1):
                if self.failed.is_set():
                    return
                try:
                    self.safety({'operation': 'alive'})
                    require(time.monotonic() - self.last_command < 45, 'P2_CONTROLLER_HEALTH_LOST')
                except BaseException:
                    self.abort()
                    return
        self.parent_watch = threading.Thread(target=parent_watch, daemon=True)
        self.parent_watch.start()

    def check(self):
        super().check()
        if self.api_job_sha256 is not None:
            self.verify_api_job_inputs()
        if hasattr(self, 'configuration'):
            require(staging_state.configuration_hashes(self.configuration) == self.initial['configurationSha256'],
                    'P2_CONFIGURATION_CHANGED')
        for name, expected in self.raw_pins.copy().items():
            require(sha(migrate.read_input(self.directory, name)) == expected, 'P2_PROFILED_CURRENT_RETAINED_BYTES_CHANGED')
        if self.closing_at is not None and not self.committed.is_set():
            self.scope.verify_close()

    def verify_api_job_inputs(self):
        require(self.api_job_sha256 is not None and migrate.profiled_current_job_hashes(self.bundle) == self.api_job_sha256,
                'P2_PROFILED_CURRENT_API_JOB_BYTES_CHANGED')

    def preflight_prior_gateway(self):
        import p2_prior_gateway
        return p2_prior_gateway.preflight_prior_gateway(self.initial, self.selected, self.check, expected_profile=PROFILE)

    def preflight_frontend_bindings(self):
        # Recovery can restore the fenced API runtime after incomplete frontend
        # setup. Only a new release needs these bindings before arming.
        if type(self) is not P2ProfiledCurrentBroker:
            return
        _, project, _ = vercel.release_identity(self.selected, expected_profile=PROFILE)
        response = self.vercel.request('GET', f'/v10/projects/{project}/env?decrypt=false')
        rows = response.get('envs')
        require(type(rows) is list and len(rows) <= 512 and all(type(row) is dict for row in rows),
                'P2_PROFILED_CURRENT_FRONTEND_BINDING_METADATA_REQUIRED')
        accepted_names = FRONTEND_PROVIDER_BINDINGS | ADMIN_ORIGIN_BINDINGS
        names = [row['key'] for row in rows
                 if type(row.get('key')) is str and row['key'] in accepted_names
                 and type(row.get('target')) is list and 'production' in row['target']
                 and not row.get('gitBranch') and not row.get('customEnvironmentIds')]
        names_set = set(names)
        require(len(names) == len(names_set) and FRONTEND_PROVIDER_BINDINGS <= names_set and
                names_set & ADMIN_ORIGIN_BINDINGS, 'P2_PROFILED_CURRENT_FRONTEND_BINDINGS_REQUIRED')
        self.check()
        receipt = {**self.record_base('P2_PROFILED_CURRENT_FRONTEND_BINDING_NAMES_VERIFIED'),
                   'projectId': project, 'vercelTarget': 'production', 'names': sorted(names_set),
                   'valuesVerified': False, 'providerSignInVerified': False}
        self.retain('frontend-binding-preflight.json', encoded(receipt) + b'\n')

    def retain(self, name, raw):
        retain_raw(self.directory, name, raw)
        self.raw_pins[name] = sha(raw)

    def arm(self, identity, request):
        self.check()
        require(self.scope is None and self.worker is None and self.closing_at is None and self.prior_gateway is None,
                'P2_PROFILED_CURRENT_ALREADY_ARMED')
        raw, receipt = decode_profiled(request['receipt'])
        started_raw, started = decode_profiled(request['continuationStarted'])
        require(started.get('status') == 'FRONTEND_CONTINUATION_STARTED' and started.get('databaseVerified') is True and
            all(started.get(key) == receipt.get(key) for key in (*COMMON, 'target', 'migrationMode', 'trafficAuthorized')),
            'P2_PROFILED_CURRENT_CONTINUATION_REQUIRED')
        probe = request['probe']
        require_profiled(probe)
        require(set(probe) == {'version', 'qualificationTargetProfile', 'operation', 'marker', 'backendPid', 'backendStart',
            'job', 'receipt', 'baseline', 'targetSha256', 'owner'} and type(probe['version']) is int and probe['version'] == 2 and
            probe['operation'] == 'verify-schema' and probe['job'] == self.jobs['frontend']['job'] and probe['receipt'] == receipt and
            probe['baseline'] == json.loads(self.jobs['frontend']['schema']) and probe['owner'] == self.initial['owner'] and
            probe['targetSha256'] == self.initial['targetSha256'] and type(probe['backendPid']) is int and probe['backendPid'] > 0 and
            type(probe['backendStart']) is str and 0 < len(probe['backendStart']) <= 128 and
            type(probe['marker']) is str and re.fullmatch(r'[a-f0-9]{64}', probe['marker']) and probe['marker'] != '0' * 64,
            'P2_PROFILED_CURRENT_PROBE_BINDING_REFUSED')
        # Validate the current-only receipt before even starting the observer.
        self.scope = self.create_scope(receipt)
        self.frontend_raw, self.continuation_started_raw, self.continuation_started = raw, started_raw, started
        self.retain('frontend-original-database-receipt.json', raw)
        self.retain('frontend-continuation-started.json', started_raw)
        observer = self.observer_type(self.selected, probe, self.source,
            self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], program=self.observer_program,
            program_sha256=self.initial['sourceSha256'][PROGRAM])
        observer.expected_epoch = self.initial['inventory']['expectedEpoch']
        # A forged/stale receipt cannot arm destructive containment. Qualify
        # the actual live backend first; only then let the independent guard
        # fence/stop an already admitted runtime on process loss.
        observer.start(self.abort)
        self.observer = observer
        self.check()
        self.safety({'operation': 'armed', 'probe': probe})
        self.armed_probe, self.arm_identity = copy.deepcopy(probe), identity
        self.scope.bind_runtime_parent(self)

    def create_scope(self, receipt):
        return P2ProfiledCurrentScope(self.lock_fd, LOCK, self.check, receipt, self.initial['candidateSha256'],
            release=self.selected, jobs=self.jobs, configuration_sha256=self.initial['configurationSha256'])

    def prepare_prior_gateway(self):
        require(self.scope is not None and self.armed_probe is not None, 'P2_PROFILED_CURRENT_OBSERVER_REQUIRED')
        self.check()
        require(self.worker is None and self.prior_gateway is None and self.closing_at is None,
                'P2_PRIOR_GATEWAY_ALREADY_PREPARED')
        import p2_prior_gateway
        self.prior_gateway = p2_prior_gateway.prepare_prior_gateway(self.initial, self.selected, self.directory, self.check,
                                                                   expected_profile=PROFILE)
        self.scope.bind_prior_gateway(self.prior_gateway)
        return self.record_base('PRIOR_GATEWAY_CLOSED_ZERO')

    def start_runtime(self, identity):
        require(self.scope is not None and self.prior_gateway is not None and self.worker is None,
                'P2_PROFILED_CURRENT_RUNTIME_STAGE_REFUSED')
        def worker():
            try:
                result = runtime.execute(self.bundle, self.configuration, self.results, self.source / 'ops/platform/compose.yaml',
                    True, self.initial['confirmation'], LOCK, expected_profile=PROFILE, _profiled_current_scope=self.scope)
                require(not self.failed.is_set() and self.runtime_released.is_set() and type(result) is dict and
                    self.ready is not None and result == self.ready,
                    'P2_PROFILED_CURRENT_CONTINUATION_REQUIRED')
                self.runtime_result = result
            except BaseException:
                self.abort()
                self.send(identity, self.STATUS + '_API_STAGE_FAILED')
            finally:
                self.worker_done.set()
        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    def runtime_ready(self, attempt, migration_attempt, snapshot, selected, outcome):
        self.check()
        require_profiled(outcome)
        require(selected == self.selected and outcome.get('status') == 'API_RUNTIME_READY' and
            outcome.get('candidateSha256') == self.initial['candidateSha256'] and
            outcome.get('configurationSha256') == self.initial['configurationSha256'] and
            outcome.get('sourceCommit') == self.initial['sourceCommit'] and
            outcome.get('environment') == 'staging' and outcome.get('releaseId') == self.selected['releaseId'] and
            all(outcome.get(key) is False for key in FALSE_FIELDS), 'P2_PROFILED_CURRENT_API_READY_REQUIRED')
        migrate.require_contract_identity(self.selected, outcome)
        runtime_raw = migrate.read_input(attempt, 'runtime-outcome.json')
        migration_raw = migrate.read_input(migration_attempt, 'migration-outcome.json')
        migration = decode_qualification_target_json(migration_raw, 'carrier')
        require_profiled(migration)
        migrate.require_contract_identity(self.selected, migration)
        require(decode_qualification_target_json(runtime_raw, 'carrier') == outcome and
            outcome.get('migrationOutcomeSha256') == sha(migration_raw) and
            migration.get('status') == 'API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN' and
            migration.get('candidateSha256') == self.initial['candidateSha256'] and
            migration.get('environment') == 'staging' and migration.get('releaseId') == self.selected['releaseId'] and
            migration.get('databaseReceiptSha256', {}).get('frontend') == sha(self.frontend_raw),
                'P2_PROFILED_CURRENT_DURABLE_RUNTIME_REQUIRED')
        self.runtime_snapshot, self.ready = snapshot, copy.deepcopy(outcome)
        self.api_attempt, self.migration_attempt = attempt, migration_attempt
        self.api_runtime_raw, self.api_migration_raw = runtime_raw, migration_raw
        self.send(self.arm_identity, self.STATUS + '_API_READY', receipt=outcome,
                  migrationOutcome=base64.b64encode(migration_raw).decode(),
                  runtimeOutcome=base64.b64encode(runtime_raw).decode())
        while not self.runtime_released.wait(0.1):
            self.check()
        self.check()
        require(not self.failed.is_set() and self.promoted is not None, 'P2_PROFILED_CURRENT_FRONTEND_REQUIRED')

    def _runtime_readback(self):
        require(self.ready is not None and runtime.check_containers(self.selected, self.runtime_snapshot,
            expected_profile=PROFILE) == self.ready['containers'], 'P2_RUNTIME_CHANGED')
        value = json.loads(runtime.command([*runtime.compose_command(self.runtime_snapshot, 'staging'),
            'exec', '-T', 'gateway', 'node', '--input-type=module', '--eval',
            'const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(1);process.stdout.write(await r.text())'],
            runtime.runtime_environment(self.selected, self.runtime_snapshot, expected_profile=PROFILE), 5))
        admission_raw = migrate.read_input(self.runtime_snapshot, 'admission/state.json')
        admission = json.loads(admission_raw)
        require(value.get('valid') is True and value.get('newWork') is False and value.get('recovery') is False and
            value.get('sha256') == sha(admission_raw) and admission.get('environment') == 'staging' and
            admission.get('releaseId') == self.selected['releaseId'] and
            admission.get('candidateSha256') == self.initial['candidateSha256'] and
            admission.get('newWork') is False and admission.get('recovery') is False and
            all(type(value.get(category, {}).get(key)) is int and value[category][key] == 0
                for category in ('active', 'uncertain') for key in ('newWork', 'recovery')),
            'P2_PROFILED_CURRENT_GATEWAY_NOT_CLOSED_ZERO')

    def verify_frontend(self, proof, workload):
        self.check()
        require(self.promoted is None and self.closing_at is None and self.ready is not None,
                'P2_PROFILED_CURRENT_FRONTEND_STAGE_REFUSED')
        raw, observed = decode_profiled(workload)
        require_profiled(proof)
        require(set(proof) in (PROOF_FIELDS, PROOF_FIELDS | {'evidenceSha256'}) and set(observed) == WORKLOAD_FIELDS and
            ('evidenceSha256' not in proof or type(proof['evidenceSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', proof['evidenceSha256'])) and
            type(proof.get('version')) is int and proof['version'] == 2 and proof.get('releaseId') == self.selected['releaseId'] and
            proof.get('actionId') == self.selected['releaseId'] and proof.get('status') == 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED' and
            proof.get('sourceCommit') == self.initial['sourceCommit'] and proof.get('environment') == 'staging' and
            proof.get('candidateSha256') == self.initial['candidateSha256'] and proof.get('configurationSha256') == self.initial['configurationSha256'] and
            proof.get('targetSha256') == self.initial['targetSha256'] and proof.get('projectId') == self.selected['workload']['projectId'] and
            proof.get('readyState') == 'READY' and proof.get('aliasJobState') == 'succeeded' and
            proof.get('aliasDeploymentId') == proof.get('deploymentId') and proof.get('workloadVerified') is True and
            proof.get('aliasJobDeploymentId') == proof['deploymentId'] and proof.get('aliasJobMatchesIntent') is True and
            proof.get('aliasJobType') == 'promote' and all(proof.get(key) is False for key in (*FALSE_FIELDS, 'admissionNewWork', 'admissionRecovery')) and
            sha(raw) == proof.get('workloadReceiptSha256') and
            proof.get('configurationRecordSha256') == sha(raw) and observed.get('status') == 'FRONTEND_VERIFIED' and
            observed.get('phase') == 'completed' and observed.get('trafficAuthorized') is False and
            observed.get('nativeSchedulerVerified') is False and observed.get('checks') == ['frontend-server-gateway-course-catalog-p2'] and
            all(observed.get(key) == proof.get(key) for key in ('releaseId', 'sourceCommit', 'environment', 'projectId', 'deploymentId')) and
            observed.get('featureControls') == self.initial['certification']['featureControls'] and
            proof.get('featureControls') == observed['featureControls'] and
            observed.get('writerAdmissionBinding') == self.initial['expectedWriterAdmissionBinding'] and
            proof.get('writerAdmissionBinding') == observed['writerAdmissionBinding'], 'P2_PROFILED_CURRENT_WORKLOAD_REQUIRED')
        migrate.require_contract_identity(self.selected, observed, proof)
        self._frontend_readback(proof)
        self._runtime_readback()
        self.promoted = copy.deepcopy(proof)
        self.retain('frontend-workload-outcome.json', raw)
        self.retain('frontend-deployment-proof.json', encoded(proof))

    def _frontend_readback(self, proof):
        state = vercel.deployment_state(self.vercel, proof['deploymentId'], proof['projectId'],
                                        proof['sourceCommit'], self.selected['releaseId'])
        project = vercel._project(self.vercel, proof['projectId'], rollback_info=True)
        alias = project.get('lastAliasRequest')
        require(state['readyState'] == 'READY' and (project.get('targets') or {}).get('production', {}).get('id') == proof['deploymentId'] and
            (project.get('crons') or {}).get('disabledAt') is not None and type(alias) is dict and
            alias.get('type') == 'promote' and alias.get('jobStatus') == 'succeeded' and alias.get('toDeploymentId') == proof['deploymentId'] and
            type(alias.get('requestedAt')) is int and alias['requestedAt'] > 0, 'P2_ACTUAL_FRONTEND_PROMOTION_REQUIRED')
        cron, schedule = project.get('crons') or {}, proof.get('certificationSchedule') or {}
        definitions = cron.get('definitions')
        expected = {'path': '/api/cron/account-lifecycle', 'schedule': '* * * * *', 'host': state['url'].removeprefix('https://')}
        require(type(schedule) is dict and set(schedule) == {*expected, 'deploymentId', 'nativeEnabled', 'definitionsSha256'} and
            cron.get('deploymentId') == proof['deploymentId'] and type(definitions) is list and len(definitions) == 1 and
            all(definitions[0].get(key) == value and schedule.get(key) == value for key, value in expected.items()) and
            schedule.get('deploymentId') == proof['deploymentId'] and schedule.get('nativeEnabled') is False and
            schedule.get('definitionsSha256') == sha(json.dumps(definitions, separators=(',', ':')).encode()),
            'P2_LIFECYCLE_ONLY_DISABLED_SCHEDULE_REQUIRED')

    def prepare_close(self):
        self.check()
        require(self.promoted is not None and self.closing_at is None and self.session_closed_proof is None,
                'P2_PROFILED_CURRENT_FRONTEND_NOT_VERIFIED')
        self._frontend_readback(self.promoted)
        self._runtime_readback()
        # Complete the API-only durable tail while the original FE observer is
        # still live. No ordinary runtime command runs in close-only phase.
        self.runtime_released.set()
        require(self.worker_done.wait(10) and not self.failed.is_set(), 'P2_PROFILED_CURRENT_RUNTIME_TAIL_UNVERIFIED')
        self.check()
        self.verify_api_receipts()
        self.observer.probe('verify-schema')
        self.observer.stop()
        self.scope.begin_close()
        self.closing_at = time.monotonic()

    def verify_api_receipts(self):
        require(migrate.read_input(self.api_attempt, 'runtime-outcome.json') == self.api_runtime_raw and
            migrate.read_input(self.migration_attempt, 'migration-outcome.json') == self.api_migration_raw,
            'P2_PROFILED_CURRENT_RUNTIME_RECEIPT_CHANGED')

    def frontend_session_closed(self):
        self.check()
        require(self.closing_at is not None and self.session_closed_proof is None and not self.finished,
                'P2_PROFILED_CURRENT_CLOSE_NOT_PREPARED')
        value = self.scope.run_close_probe(self.observer)
        self.retain('frontend-session-closed.json', encoded(value))
        self.session_closed_proof = value
        return value

    def finish_receipts(self, value):
        self.check()
        require(self.session_closed_proof is not None and not self.finished and self.worker_done.is_set(),
                'P2_PROFILED_CURRENT_SESSION_CLOSURE_REQUIRED')
        terminal_raw, terminal = decode_profiled(value['terminal'])
        completed_raw, completed = decode_profiled(value['continuationCompleted'])
        outcome_raw, outcome = decode_profiled(value['releaseOutcome'])
        require(terminal.get('status') == 'DATABASE_VERIFIED' and terminal.get('phase') == 'completed' and
            terminal.get('readOnlyVerified') is True and terminal.get('failureCode') is None and
            all(terminal.get(key) == self.scope.receipt.get(key) for key in (*COMMON, 'target', 'migrationMode', 'trafficAuthorized')),
            'P2_PROFILED_CURRENT_LATE_FRONTEND_TERMINAL_REQUIRED')
        require(completed == {**self.continuation_started, 'status': 'FRONTEND_CONTINUATION_COMPLETED'},
                'P2_PROFILED_CURRENT_COMPLETED_CONTINUATION_REQUIRED')
        require(outcome.get('status') == 'P2_PROFILED_CURRENT_FRONTEND_VERIFIED' and
            all(outcome.get(key) == expected for key, expected in self.record_base(outcome['status']).items()) and
            outcome.get('deploymentProofSha256') == sha(encoded(self.promoted)), 'P2_PROFILED_CURRENT_RELEASE_OUTCOME_REQUIRED')
        self._frontend_readback(self.promoted)
        self._runtime_readback()
        self.verify_api_receipts()
        self.check()
        for name, raw in (('frontend-job-outcome.json', terminal_raw), ('frontend-continuation-completed.json', completed_raw),
                          ('frontend-release-outcome.json', outcome_raw)):
            self.retain(name, raw)
        self.outcome = {**self.record_base(self.TERMINAL),
            'frontendDatabaseReceiptSha256': sha(self.frontend_raw),
            'frontendTerminalSha256': sha(terminal_raw), 'frontendContinuationCompletedSha256': sha(completed_raw),
            'frontendReleaseOutcomeSha256': sha(outcome_raw),
            'frontendSessionClosedSha256': self.raw_pins['frontend-session-closed.json'],
            'frontendWorkloadReceiptSha256': self.promoted['workloadReceiptSha256'],
            'apiRuntimeReceiptSha256': sha(migrate.read_input(self.api_attempt, 'runtime-outcome.json')),
            'migrationOutcomeSha256': sha(migrate.read_input(self.migration_attempt, 'migration-outcome.json'))}
        self.finished = True
        return copy.deepcopy(self.outcome)

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_PROTOCOL_ID_REFUSED')
        suffix = operation.removeprefix(self.OP + '-') if type(operation) is str and operation.startswith(self.OP + '-') else operation
        fields = {'check': (), 'prepare-prior-gateway': (), 'arm': ('receipt', 'continuationStarted', 'probe'),
            'frontend-verified': ('proof', 'workload'), 'prepare-close': (), 'session-closed': (),
            'finish': ('terminal', 'continuationCompleted', 'releaseOutcome'), 'commit': ()}
        require(suffix in fields and (operation in ('check', 'commit') or operation == self.OP + '-' + suffix) and
            set(value) == {'id', 'operation', *fields[suffix]}, 'P2_PROFILED_CURRENT_PROTOCOL_REFUSED')
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
            elif suffix == 'frontend-verified':
                self.verify_frontend(value['proof'], value['workload'])
                self.send(identity, self.STATUS + '_FRONTEND_VERIFIED')
            elif suffix == 'prepare-close':
                self.prepare_close()
                self.send(identity, self.STATUS + '_CLOSE_PREPARED')
            elif suffix == 'session-closed':
                self.send(identity, self.STATUS + '_SESSION_CLOSED', receipt=self.frontend_session_closed())
            elif suffix == 'finish':
                self.send(identity, self.STATUS + '_JOINED', receipt=self.finish_receipts(value))
            elif suffix == 'commit':
                require(self.finished and self.worker_done.is_set() and self.session_closed_proof is not None,
                        'P2_PROFILED_CURRENT_RELEASE_JOIN_REQUIRED')
                self._frontend_readback(self.promoted)
                self._runtime_readback()
                self.verify_api_receipts()
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
    require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_PROFILED_CURRENT_INITIAL_REFUSED')
    initial = decode_qualification_target_json(raw, 'private-packet')
    require(type(initial) is dict and type(initial.get('version')) is int and initial['version'] == 2 and
            initial.get('mode') == P2ProfiledCurrentBroker.MODE, 'P2_PROFILED_CURRENT_FIXED_MODE_REQUIRED')
    require_profiled(initial)
    supervise(initial, broker_type=P2ProfiledCurrentBroker, observer_type=P2ProfiledCurrentPhysicalObserver,
              observer_source=PROGRAM, layout=LAYOUT)


if __name__ == '__main__':
    for item, code in ((signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
        signal.signal(item, lambda *_args, code=code: (_ for _ in ()).throw(SystemExit(code)))
    try:
        main()
    except BaseException:
        print('P2_PROFILED_CURRENT_FAILED_REQUIRES_REVIEW', file=sys.stderr)
        raise SystemExit(1)
