#!/usr/bin/env python3
"""Fixed SSH-side P2 release broker; the actual host flock outlives all stages."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import select
import stat
import subprocess
import sys
import threading
import time
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
from p2_release_scope import P2ReleaseScope
import staging_admission
import p2_prior_gateway
import staging_state
import vercel
import frontend_gateway_observation
from p2_certification_profile import require_profile, RUNTIME_FLAGS
from p2_source_closure import verify_source_closure, verify_profiled_current_source_closure, private_observer_program

MAXIMUM = 4_000_000
LOCK = Path('/run/lock/lash-her-release.lock')
require = migrate.demand


def decode(raw):
    require(isinstance(raw, str) and len(raw) <= MAXIMUM, 'P2_RECEIPT_REQUIRED')
    value = base64.b64decode(raw, validate=True)
    require(0 < len(value) <= 2_000_000, 'P2_RECEIPT_BOUNDS_REFUSED')
    parsed = json.loads(value)
    require(isinstance(parsed, dict), 'P2_RECEIPT_OBJECT_REQUIRED')
    return value, parsed


class PhysicalObserver:
    def __init__(self, selected, request, source, credential, *, program=None, program_sha256=None):
        self.selected, self.request, self.source, self.credential = selected, request, source, credential
        self.stop_event, self.failure = threading.Event(), None
        self.last_verified = 0
        self.thread = None
        self.program = program
        self.program_sha256 = program_sha256

    def probe(self, operation):
        program = self.program or self.source / 'ops/platform/p2-frontend-live-probe.mjs'
        if self.program_sha256 is not None:
            require(migrate.file_hash(program.read_bytes()) == self.program_sha256, 'P2_PRIVATE_OBSERVER_CHANGED')
        image = self.selected['artifacts']['frontendMigration']['image']
        env = {**runtime.SAFE_ENV, 'FRONTEND_STAGING_MIGRATION_DATABASE_URL': self.credential}
        name = 'lash-p2-observer-' + uuid4().hex
        args = ['docker', 'run', '--rm', '--name', name, '--interactive', '--network', 'host', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64',
                '--env', 'FRONTEND_STAGING_MIGRATION_DATABASE_URL', '--mount',
                f'type=bind,src={program},dst=/app/ops/platform/p2-frontend-live-probe.mjs,readonly',
                '--entrypoint', 'node', image, 'ops/platform/p2-frontend-live-probe.mjs']
        try:
            result = subprocess.run(args, input=json.dumps({**self.request, 'operation': operation}),
                                    capture_output=True, text=True, env=env, timeout=30, check=True)
        finally:
            subprocess.run(['docker', 'rm', '--force', name], env=runtime.SAFE_ENV,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
            remaining = runtime.command(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'], runtime.SAFE_ENV, 15)
            require(not remaining, 'P2_OBSERVER_CONTAINER_CLEANUP_UNVERIFIED')
            if self.program_sha256 is not None:
                require(migrate.file_hash(program.read_bytes()) == self.program_sha256, 'P2_PRIVATE_OBSERVER_CHANGED')
        require(len(result.stdout) <= 8192, 'P2_OBSERVER_OUTPUT_REFUSED')
        value = json.loads(result.stdout)
        expected = 'P2_FRONTEND_ADMISSION_CLOSED' if operation == 'fence' else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED'
        require(value.get('status') == expected, 'P2_PHYSICAL_OBSERVATION_REFUSED')
        if operation != 'fence':
            require(value.get('marker') == self.request['marker'] and value.get('backendPid') == self.request['backendPid']
                    and value.get('sourceCommit') == self.request['job']['sourceCommit'], 'P2_PHYSICAL_OBSERVATION_BINDING_REFUSED')
        return value

    def start(self, failed):
        self.probe('verify-schema')
        self.last_verified = time.monotonic()
        def observe():
            while not self.stop_event.wait(1):
                try:
                    self.probe('observe')
                    self.last_verified = time.monotonic()
                except BaseException:
                    self.failure = True
                    failed()
                    return
        self.thread = threading.Thread(target=observe, daemon=True)
        self.thread.start()

    def verify(self):
        require(not self.failure and 0 <= time.monotonic() - self.last_verified < 35,
                'P2_FRONTEND_PHYSICAL_SESSION_LOST')

    def stop(self):
        self.stop_event.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(32)
            require(not self.thread.is_alive(), 'P2_OBSERVER_CLEANUP_UNVERIFIED')


class Broker:
    def __init__(self, initial, output, *, shared_lock_fd=None, safety_write=None, guard_read=None,
                 observer_type=PhysicalObserver, observer_source='ops/platform/p2-frontend-live-probe.mjs'):
        self.emit, self.initial = output, initial
        self.observer_type, self.observer_source = observer_type, observer_source
        self.failed, self.released, self.worker_done = threading.Event(), threading.Event(), threading.Event()
        self.output_lock = threading.Lock()
        self.observer = self.scope = self.worker = None
        self.runtime_snapshot = self.ready = self.promoted = None
        self.closing_at = None
        self.finished = False
        self.committed = threading.Event()
        self.operation_active = threading.Lock()
        self.last_command = time.monotonic()
        self.lock_fd = None
        self.shared_lock_fd, self.safety_write, self.guard_read = shared_lock_fd, safety_write, guard_read
        self.safety_mutex, self.guard_alive = threading.Lock(), guard_read is not None
        self.last_guard = time.monotonic()
        self.guard_pulsed = threading.Event()
        if guard_read is not None:
            os.set_blocking(guard_read, False)
        self.outcome = {'status': 'P2_RELEASE_FAILED_REQUIRES_REVIEW', 'trafficAuthorized': False,
                        'releaseAccepted': False, 'sqlReplayAuthorized': False, 'productionChanged': False}

    def send(self, identity, status, **data):
        with self.output_lock:
            self.emit({'id': identity, 'status': status, **data})

    def safety(self, value):
        require(self.safety_write is not None and self.guard_alive, 'P2_INDEPENDENT_GUARD_REQUIRED')
        raw = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        require(len(raw) <= MAXIMUM, 'P2_SAFETY_INPUT_BOUNDS')
        with self.safety_mutex:
            while raw:
                count = os.write(self.safety_write, raw)
                require(count > 0, 'P2_GUARD_CHANNEL_CLOSED')
                raw = raw[count:]

    def start_guard_health(self):
        def guard_health():
            while not self.committed.wait(0.1):
                try:
                    readable, _, _ = select.select([self.guard_read], [], [], 0.1)
                    if readable:
                        require(os.read(self.guard_read, 65536), 'P2_INDEPENDENT_GUARD_DIED')
                        self.last_guard = time.monotonic()
                        self.guard_pulsed.set()
                    require(time.monotonic() - self.last_guard < 3, 'P2_INDEPENDENT_GUARD_HEALTH_LOST')
                except BlockingIOError:
                    continue
                except BaseException:
                    self.guard_alive = False; self.abort(); return
        threading.Thread(target=guard_health, daemon=True).start()

    def action_id(self):
        return self.initial['candidate']['releaseId']

    def directory_name(self):
        return 'p2-' + self.action_id()

    def terminal_filename(self):
        return 'p2-release-outcome.json'

    def select_release(self, initial):
        selected, jobs, plan, compose = runtime.make_plan(self.bundle, self.configuration, self.source / 'ops/platform/compose.yaml')
        require(selected == initial['candidate'] and selected.get('contractPhase') == 'p2'
                and selected['sources']['frontend']['commit'] == initial['sourceCommit'] and selected['environment'] == 'staging'
                and set(jobs) == {'frontend', 'course', 'community'}
                and jobs['frontend']['job']['target']['approvedPendingTags'], 'P2_CANDIDATE_BINDING_REFUSED')
        return selected, jobs, plan, compose

    def initialize(self):
        p = self.initial
        require(self.shared_lock_fd is not None and self.safety_write is not None and self.guard_read is not None,
                'P2_INDEPENDENT_SUPERVISOR_REQUIRED')
        self.start_guard_health()
        require(self.guard_pulsed.wait(5) and self.guard_alive, 'P2_INDEPENDENT_GUARD_HANDSHAKE_REQUIRED')
        require(p.get('version') == 1 and p.get('environment') == 'staging' and os.geteuid() == 0,
                'P2_SELECTED_ROOT_HOST_REQUIRED')
        commit = p.get('sourceCommit')
        require(migrate.source_commit(commit), 'P2_EXACT_SOURCE_REQUIRED')
        self.source = Path(__file__).resolve().parents[3]
        require(str(self.source) == '/opt/lash-her/operators/' + commit, 'P2_INSTALLED_SOURCE_REQUIRED')
        self.require_source_closure(p)
        for key in ('bundle', 'configuration', 'results'):
            value = Path(p[key])
            require(value.is_absolute() and str(value.resolve()) == str(value) and
                    str(value).startswith('/var/lib/lash-her/releases/staging/') and ',' not in str(value),
                    'P2_PRIVATE_HOST_PATH_REFUSED')
            migrate.private_directory(value)
        self.bundle, self.configuration, self.results = (Path(p[key]) for key in ('bundle', 'configuration', 'results'))
        self.selected, self.jobs, self.plan, _ = self.select_release(p)
        require(migrate.file_hash(migrate.read_input(self.bundle, 'release.candidate.json')) == p.get('candidateSha256'), 'P2_CANDIDATE_BYTES_CHANGED')
        require(self.selected == p['candidate'] and self.selected.get('contractPhase') == 'p2'
                and self.selected['environment'] == 'staging' and self.plan['hostMachineId'] == p['hostMachineId']
                and set(self.jobs) == {'frontend', 'course', 'community'}, 'P2_CANDIDATE_BINDING_REFUSED')
        runtime.assert_host(self.plan)
        require_profile(p.get('certification'))
        for service, flags in RUNTIME_FLAGS.items():
            values = runtime.environment_values(migrate.read_input(self.configuration, service + '.env', 65536), 'staging', service, self.jobs)
            require(all(values.get(key) == value for key, value in flags.items()), 'P2_CERTIFICATION_RUNTIME_FLAGS_REQUIRED')
        require(staging_state.configuration_hashes(self.configuration) == p['configurationSha256'], 'P2_CONFIGURATION_CHANGED')
        require(p.get('confirmation') == 'staging/' + self.action_id(), 'P2_EXPLICIT_START_REQUIRED')
        credentials = p.get('credentials', {})
        require(set(credentials) == {'FRONTEND_STAGING_MIGRATION_DATABASE_URL', 'COURSE_STAGING_DATABASE_URL', 'COMMUNITY_STAGING_DATABASE_URL'}
                and all(isinstance(v, str) and 0 < len(v) <= 16384 for v in credentials.values()), 'P2_NAMED_CREDENTIALS_REQUIRED')
        for key, value in credentials.items():
            os.environ[key] = value
        self.vercel = vercel.Client(p['vercelToken'])
        self.lock_fd = self.shared_lock_fd
        info = os.fstat(self.lock_fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, 'P2_ACTUAL_HOST_LOCK_REQUIRED')
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock_info = info
        self.directory = self.results / self.directory_name()
        self.directory.mkdir(mode=0o700)
        self.observer_program = private_observer_program(p, self.directory / 'private-source')
        self.outcome.update(environment='staging', releaseId=self.selected['releaseId'], sourceCommit=commit,
                            candidateSha256=p['candidateSha256'])
        self.outcome.update(migrate.contract_identity(self.selected))
        migrate.write_json(self.directory, 'p2-release-started.json', self.outcome)
        self.check()
        self.prior_gateway = None
        self.prior_gateway_preflight = self.preflight_prior_gateway()
        migrate.write_json(self.directory, 'prior-gateway-preflight.json', self.prior_gateway_preflight)
        def parent_watch():
            while not self.committed.wait(1):
                if self.failed.is_set():
                    return
                try:
                    self.safety({'operation': 'alive'})
                except BaseException:
                    self.guard_alive = False; self.abort(); return
                if time.monotonic() - self.last_command > 45:
                    self.abort()
                    return
        self.parent_watch = threading.Thread(target=parent_watch, daemon=True)
        self.parent_watch.start()

    def check(self):
        require(not self.failed.is_set(), 'P2_BROKER_FAILED')
        self.require_source_closure()
        try:
            pulse = os.read(self.guard_read, 65536)
            require(pulse, 'P2_INDEPENDENT_GUARD_DIED')
            self.last_guard = time.monotonic()
        except BlockingIOError:
            pass
        require(self.guard_alive and time.monotonic() - self.last_guard < 3, 'P2_INDEPENDENT_GUARD_LOST')
        info, actual = os.fstat(self.lock_fd), os.lstat(LOCK)
        require(info.st_ino == actual.st_ino == self.lock_info.st_ino and info.st_dev == actual.st_dev == self.lock_info.st_dev
                and stat.S_ISREG(actual.st_mode) and actual.st_uid == 0 and not actual.st_mode & 0o077,
                'P2_HOST_ENVIRONMENT_LOCK_CHANGED')
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if self.observer and self.closing_at is None:
            self.observer.verify()
        if self.closing_at is not None and not self.finished:
            require(time.monotonic() - self.closing_at < 10, 'P2_FRONTEND_CLOSE_TIMEOUT')

    def preflight_prior_gateway(self):
        return p2_prior_gateway.preflight_prior_gateway(self.initial, self.selected, self.check)

    def prepare_prior_gateway(self):
        self.check()
        require(self.worker is None and self.scope is None and self.closing_at is None and self.prior_gateway is None, 'P2_PRIOR_GATEWAY_ALREADY_PREPARED')
        self.prior_gateway = p2_prior_gateway.prepare_prior_gateway(self.initial, self.selected, self.directory, self.check)
        return {'status':'PRIOR_GATEWAY_CLOSED_ZERO','candidateSha256':self.initial['candidateSha256'],'observation':self.prior_gateway.observation}

    def start(self, identity, request):
        self.check()
        require(self.worker is None and self.closing_at is None, 'P2_API_STAGE_ALREADY_STARTED')
        require(self.initial.get('rolePreparation') is None or hasattr(self, 'roles_proof'), 'P2_OBSERVED_ROLES_REQUIRED_BEFORE_API_STAGE')
        raw, receipt = decode(request['receipt'])
        require(request['probe']['job'] == self.jobs['frontend']['job'] and request['probe']['receipt'] == receipt,
                'P2_PROBE_RECEIPT_BINDING_REFUSED')
        require(request['probe'].get('baseline') == json.loads(self.jobs['frontend']['schema'])
                and request['probe'].get('owner') == self.initial.get('owner')
                and request['probe'].get('targetSha256') == self.initial.get('targetSha256'), 'P2_PROBE_PLAN_BINDING_REFUSED')
        self.frontend_raw = raw
        self.safety({'operation': 'armed', 'probe': request['probe']})
        self.observer = self.observer_type(self.selected, request['probe'], self.source,
                                        self.initial['credentials']['FRONTEND_STAGING_MIGRATION_DATABASE_URL'], program=self.observer_program,
                                        program_sha256=self.initial['sourceSha256'][self.observer_source])
        self.observer.start(self.abort)
        self.scope = P2ReleaseScope(self.lock_fd, LOCK, self.check, receipt, self.outcome['candidateSha256'],
                                    release=self.selected, jobs=self.jobs, configuration_sha256=self.initial['configurationSha256'])
        self.scope.require_frontend(self.selected, self.jobs['frontend'])
        self.scope.bind_prior_gateway(self.prior_gateway)
        def ready(attempt, migration_attempt, snapshot, selected, outcome):
            require(selected == self.selected and outcome.get('status') == 'API_RUNTIME_READY', 'P2_API_READY_BINDING_REFUSED')
            self.runtime_snapshot, self.ready = snapshot, outcome
            self.api_attempt, self.migration_attempt = attempt, migration_attempt
            self.check()
            self.send(identity, 'API_READY', receipt=outcome)
            while not self.released.wait(0.2):
                self.check()
            require(not self.failed.is_set() and self.finished, 'P2_FRONTEND_COMPLETION_REQUIRED')
        def worker():
            try:
                runtime.execute(self.bundle, self.configuration, self.results, self.source / 'ops/platform/compose.yaml',
                                True, self.initial['confirmation'], LOCK, after_runtime_ready=ready, _p2_scope=self.scope)
            except BaseException:
                self.abort()
                self.send(identity, 'P2_API_STAGE_FAILED')
            finally:
                self.worker_done.set()
        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    def verify_promoted(self, proof, workload_raw):
        self.check()
        require(self.ready is not None and proof.get('version') == 1 and proof.get('actionId') == self.selected['releaseId']
                and proof.get('sourceCommit') == self.selected['sources']['frontend']['commit']
                and proof.get('projectId') == self.selected['workload']['projectId'] and proof.get('readyState') == 'READY'
                and proof.get('aliasJobState') == 'succeeded' and proof.get('aliasDeploymentId') == proof.get('deploymentId')
                and proof.get('workloadVerified') is True and proof.get('nativeSchedulesEnabled') is False,
                'P2_COMPATIBLE_FRONTEND_PROOF_REQUIRED')
        raw, workload = decode(workload_raw)
        require(migrate.file_hash(raw) == proof.get('workloadReceiptSha256') and workload.get('status') == 'FRONTEND_VERIFIED'
                and all(workload.get(key) == proof.get(key) for key in ('deploymentId', 'projectId', 'sourceCommit'))
                and workload.get('releaseId') == self.selected['releaseId'] and workload.get('contractPhase') == 'p2'
                and workload.get('phase2ContractManifestSha256') == self.selected['phase2ContractManifestSha256']
                and workload.get('featureControls') == self.initial['certification']['featureControls'],
                'P2_IMMUTABLE_FEATURE_PROFILE_REQUIRED')
        require(workload.get('writerAdmissionBinding') == self.initial['expectedWriterAdmissionBinding']
                and proof.get('writerAdmissionBinding') == workload['writerAdmissionBinding']
                and proof.get('configurationRecordSha256') == proof['workloadReceiptSha256'],
                'P2_IMMUTABLE_WRITER_BINDING_REQUIRED')
        state = vercel.deployment_state(self.vercel, proof['deploymentId'], proof['projectId'], proof['sourceCommit'], proof['actionId'])
        project = vercel._project(self.vercel, proof['projectId'])
        require(state['readyState'] == 'READY' and (project.get('targets') or {}).get('production', {}).get('id') == proof['deploymentId']
                and (project.get('crons') or {}).get('disabledAt') is not None, 'P2_ACTUAL_FRONTEND_PROMOTION_REQUIRED')
        cron, schedule = project.get('crons') or {}, proof.get('certificationSchedule') or {}
        expected_schedule = {'path': '/api/cron/account-lifecycle', 'schedule': '* * * * *',
                             'host': state['url'].removeprefix('https://')}
        definitions = cron.get('definitions')
        require(cron.get('deploymentId') == proof['deploymentId'] and isinstance(definitions, list) and len(definitions) == 1
                and all(definitions[0].get(key) == value and schedule.get(key) == value for key, value in expected_schedule.items())
                and schedule.get('deploymentId') == proof['deploymentId'] and schedule.get('nativeEnabled') is False
                and re.fullmatch(r'[a-f0-9]{64}', schedule.get('definitionsSha256', '')) is not None,
                'P2_LIFECYCLE_ONLY_DISABLED_SCHEDULE_REQUIRED')
        require(runtime.check_containers(self.selected, self.runtime_snapshot) == self.ready['containers'], 'P2_RUNTIME_CHANGED')
        self.promoted = proof

    def admit_certification(self):
        require(self.promoted is not None, 'P2_FRONTEND_REQUIRED_BEFORE_ADMISSION')
        self.check()
        binding = {'releaseId': self.selected['releaseId'], 'candidateSha256': self.outcome['candidateSha256']}
        host = staging_admission.Host(self.selected, self.runtime_snapshot, self.vercel)
        observed = host.state()
        require(observed.get('newWork') is False and observed.get('recovery') is False
                and all(observed[category][key] == 0 for category in ('active', 'uncertain')
                        for key in ('newWork', 'recovery')), 'P2_GATEWAY_DRAIN_REQUIRED')
        migrate.write_json(self.directory, 'p2-certification-admission-intent.json', {**self.outcome,
            'profile': self.initial['certification'], 'admission': {'newWork': True, 'recovery': True}})
        acknowledged = staging_admission.persist_state(self.runtime_snapshot, binding,
            'p2-certification-' + self.selected['releaseId'], new_work=True, recovery=True)
        observed = host.state()
        require(observed.get('sha256') == acknowledged and observed.get('newWork') is True
                and observed.get('recovery') is True and all(observed['uncertain'][key] == 0 for key in ('newWork', 'recovery')),
                'P2_CERTIFICATION_ADMISSION_UNVERIFIED')
        migrate.write_json(self.directory, 'p2-certification-admission-verified.json', {
            'status': 'P2_CERTIFICATION_GATEWAY_ADMITTED', 'admissionStateSha256': acknowledged,
            'profile': self.initial['certification'], 'g2Accepted': False, 'nativeSchedulesEnabled': False})

    def failure_profile(self):
        # Fixed source subclasses may select a profile; packet fields cannot.
        return None

    def require_source_closure(self, initial=None):
        checker = (verify_profiled_current_source_closure if self.failure_profile() is not None
                   else verify_source_closure)
        return checker(self.initial if initial is None else initial, self.source)

    def abort(self):
        if self.failed.is_set():
            return
        self.failed.set()
        self.released.set()
        self.outcome.update(status='P2_RELEASE_FAILED_REQUIRES_REVIEW', trafficAuthorized=None,
                            newWorkAuthorized=None, recoveryAuthorized=None)
        if self.scope:
            self.scope.revoked.set()
        if self.guard_alive and self.safety_write is not None:
            try:
                self.safety({'operation': 'abort'})
                return  # the independent guard reaps this entire worker group
            except BaseException:
                self.guard_alive = False
        self.contain_failure_without_guard()

    def contain_failure_without_guard(self):
        """Fixed survivor path; a profiled broker serializes one actual pass."""
        expected = migrate.profile_context(self.failure_profile())
        profile_args = {} if expected is None else {'expected_profile': expected}
        if self.scope:
            try:
                self.scope.revoke()
                if getattr(self.scope, 'cleanup_uncertain', False):
                    self.outcome['workerProcessCleanupUncertain'] = True
            except BaseException:
                self.outcome['workerProcessCleanupUncertain'] = True
            if expected is not None:
                with self.scope.mutations:
                    if any(process.poll() is None for process in self.scope.processes):
                        self.outcome['workerProcessCleanupUncertain'] = True
                        return False  # No containment mutation has started; retain the flock.
        if expected is not None and self.observer:
            try:
                self.observer.stop()
            except BaseException:
                self.outcome['profiledCurrentReadonlyCleanupUncertain'] = True
                return False
        # Closing on loss is allowed; reopening, replay and automatic deployment
        # recovery are never attempted. Failures remain explicit uncertainty.
        if self.observer:
            try:
                self.observer.probe('fence')
                self.outcome['frontendAdmissionClosedOnFailure'] = True
                self.outcome.update(trafficAuthorized=False, newWorkAuthorized=False, recoveryAuthorized=False)
            except BaseException:
                self.outcome['frontendAdmissionClosedOnFailure'] = None
        prior, gateway_directory = None, None
        if self.observer or self.worker:
            try:
                # The independent guard is dead; this survivor still owns the
                # actual flock. No revoked frontend/scope query can block stop.
                def containment_verify():
                    current, opened = os.lstat(LOCK), os.fstat(self.lock_fd)
                    require(stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and not current.st_mode & 0o077 and
                        (current.st_dev,current.st_ino) == (opened.st_dev,opened.st_ino), 'P2_FALLBACK_LOCK_CHANGED')
                    fcntl.flock(self.lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    self.require_source_closure()
                gateway_directory = self.directory / 'prior-gateway-broker-fallback'
                gateway_directory.mkdir(mode=0o700)
                prior = p2_prior_gateway.capture_before_stop(self.initial,self.selected,gateway_directory,containment_verify, **profile_args)
                self.outcome['priorGatewayBeforeStop'] = prior
            except BaseException:
                self.outcome['priorGatewayBeforeStopUnknown'] = True
            try:
                migrate.suspend_runtime('staging', runtime.SAFE_ENV)
                self.outcome['runtimeStopped'] = True
            except BaseException:
                self.outcome['runtimeStopped'] = None
            if prior is not None:
                try:
                    self.outcome['priorGatewayOrderedStop'] = p2_prior_gateway.retain_ordered_stop(prior,gateway_directory,containment_verify, **profile_args)
                except BaseException:
                    self.outcome['priorGatewayOrderedStopUnknown'] = True
        if getattr(self, 'selected', None) and self.worker:
            for name in ('course', 'community'):
                container = 'lash-migrate-' + name + '-' + (self.action_id() if expected is not None else self.selected['releaseId'])
                try:
                    if expected is None:
                        subprocess.run(['docker', 'rm', '--force', container], env=runtime.SAFE_ENV,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
                    else:
                        query = ['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}']
                        if runtime.command(query, runtime.SAFE_ENV, 15):
                            runtime.command(['docker', 'rm', '--force', container], runtime.SAFE_ENV, 30)
                        require(not runtime.command(query, runtime.SAFE_ENV, 15),
                                'PROFILED_CURRENT_FALLBACK_MIGRATION_CONTAINER_REMAINS')
                except BaseException:
                    self.outcome['migrationContainerCleanupUncertain'] = True
            if self.observer_source == 'ops/platform/p2-recovery-current-probe.mjs':
                try:
                    from p2_release_supervisor import cleanup_recovery_current_containers
                    cleanup_recovery_current_containers()
                except BaseException:
                    self.outcome['recoveryCurrentContainerCleanupUncertain'] = True
        if expected is not None:
            try:
                from p2_release_supervisor import cleanup_profiled_current_readonly_containers
                cleanup_profiled_current_readonly_containers()
            except BaseException:
                self.outcome['profiledCurrentReadonlyCleanupUncertain'] = True
        return True  # The bounded pass ran once; unknown effects require review.

    def command(self, value):
        identity, operation = value.get('id'), value.get('operation')
        require(type(identity) is int and 0 < identity < 1_000_000, 'P2_PROTOCOL_ID_REFUSED')
        self.check()
        self.last_command = time.monotonic()
        if operation == 'check':
            self.send(identity, 'HELD')
        elif operation == 'prepare-prior-gateway':
            require(set(value) == {'id','operation'}, 'P2_PRIOR_GATEWAY_EVENT_FIELDS_REFUSED')
            self.send(identity,'PRIOR_GATEWAY_PREPARED',receipt=self.prepare_prior_gateway())
        elif operation == 'roles-prepared':
            require(self.worker is None and self.observer is None and self.initial.get('rolePreparation') is not None
                    and not hasattr(self, 'roles_proof'), 'P2_ROLE_PREPARATION_STAGE_REFUSED')
            proof, plan = value['proof'], self.initial['rolePreparation']
            body = {key: item for key, item in proof.items() if key != 'proofSha256'}
            expected = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            require(proof.get('proofSha256') == expected and proof.get('status') == 'FRONTEND_ROLES_PREPARED'
                    and proof.get('committed') is True and proof.get('runtimeCredentialVerified') is True
                    and all(proof.get(key) == item for key, item in plan.items())
                    and proof.get('environment') == 'staging' and proof.get('owner', {}).get('name') == 'lash_her_frontend_staging_admission_owner_p2'
                    and proof.get('runtime', {}).get('name') == self.jobs['frontend']['job']['target']['runtimeRole']
                    and all(re.fullmatch(r'[1-9][0-9]{0,9}', proof[key].get('oid', '')) and int(proof[key]['oid']) <= 4294967295 for key in ('owner', 'runtime'))
                    and proof['owner']['oid'] != proof['runtime']['oid'],
                    'P2_OBSERVED_ROLE_PROOF_REQUIRED')
            require(proof.get('producers') == [{'producerSha256': producer, 'sourceCommit': plan['sourceCommit'], 'role': proof['runtime']}
                                               for producer in plan['producerSha256']], 'P2_OBSERVED_ROLE_PRODUCERS_REFUSED')
            self.roles_proof = proof
            self.initial['owner'] = proof['owner']
            migrate.write_json(self.directory, 'p2-observed-role-preparation.json', proof)
            self.send(identity, 'ROLES_PREPARED')
        elif operation == 'start-api':
            self.start(identity, value)
        elif operation == 'frontend-verified':
            self.verify_promoted(value['proof'], value['workload'])
            self.admit_certification()
            self.send(identity, 'FRONTEND_VERIFIED')
        elif operation == 'prepare-close':
            require(self.promoted is not None and self.closing_at is None, 'P2_FRONTEND_NOT_VERIFIED')
            self.observer.verify()
            self.observer.stop()
            self.closing_at = time.monotonic()
            self.send(identity, 'FRONTEND_CLOSE_PREPARED')
        elif operation == 'observe-gateway':
            require(self.promoted is not None and self.runtime_snapshot is not None, 'P2_PROMOTED_RUNTIME_REQUIRED')
            observed = frontend_gateway_observation.observe(self.runtime_snapshot, self.initial['gatewayObservation'], self.check)
            self.send(identity, 'GATEWAY_OBSERVED', gateway=observed)
        elif operation == 'finish':
            require(self.closing_at is not None and not self.finished, 'P2_FRONTEND_CLOSE_NOT_PREPARED')
            terminal_raw, terminal = decode(value['terminal'])
            outcome_raw, frontend = decode(value['frontend'])
            require(terminal.get('status') == 'DATABASE_VERIFIED' and terminal.get('phase') == 'completed'
                    and terminal.get('failureCode') is None and frontend.get('databaseVerified') is True
                    and frontend.get('frontendVerified') is True and frontend.get('wholeReleaseAccepted') is False
                    and frontend.get('frontendDomainsPromoted') is True, 'P2_FRONTEND_TERMINAL_REQUIRED')
            for key in ('environment', 'releaseId', 'sourceCommit', 'migrationImageDigest', 'sqlArtifactSha256',
                        'contractManifestSha256', 'schemaBaselineSha256', 'target', 'contractPhase', 'phase2ContractManifestSha256'):
                require(terminal.get(key) == self.scope.receipt.get(key), 'P2_FRONTEND_TERMINAL_BINDING_REFUSED')
            require(frontend.get('actionId') == self.selected['releaseId'] and frontend.get('sourceCommit') == terminal['sourceCommit'],
                    'P2_FRONTEND_OUTCOME_BINDING_REFUSED')
            if hasattr(self, 'roles_proof'):
                require(frontend.get('rolePreparationProofSha256') == self.roles_proof['proofSha256'], 'P2_ROLE_TERMINAL_PROOF_BINDING_REFUSED')
            for name, raw in (('frontend-job-outcome.json', terminal_raw), ('frontend-release-outcome.json', outcome_raw),
                              ('frontend-original-database-receipt.json', self.frontend_raw)):
                with (self.directory / name).open('xb') as stream:
                    os.fchmod(stream.fileno(), 0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            self.finished = True
            self.released.set()
            require(self.worker_done.wait(10) and not self.failed.is_set(), 'P2_RUNTIME_CONTINUATION_UNVERIFIED')
            require(frontend.get('admissionRestored') is True and frontend.get('admissionNewWork') is True
                    and frontend.get('admissionRecovery') is True, 'P2_FRONTEND_ADMISSION_RESTORATION_REQUIRED')
            self.outcome.update(status='P2_STAGING_READY_FOR_CERTIFICATION', trafficAuthorized=True, newWorkAuthorized=True,
                                recoveryAuthorized=True, nativeSchedulesEnabled=False, g2Accepted=False,
                                certificationSchedule=self.promoted['certificationSchedule'], nativeQualification='pending',
                                rolePreparationProofSha256=getattr(self, 'roles_proof', {}).get('proofSha256'),
                                frontendTerminalSha256=migrate.file_hash(terminal_raw),
                                frontendOutcomeSha256=migrate.file_hash(outcome_raw), frontendDatabaseReceiptSha256=migrate.file_hash(self.frontend_raw),
                                apiRuntimeReceiptSha256=migrate.file_hash(migrate.read_input(self.api_attempt, 'runtime-outcome.json')),
                                migrationOutcomeSha256=migrate.file_hash(migrate.read_input(self.migration_attempt, 'migration-outcome.json')))
            self.send(identity, 'P2_RELEASE_JOINED', receipt=self.outcome)
        elif operation == 'commit':
            require(self.finished and not self.failed.is_set() and self.worker_done.is_set(), 'P2_RELEASE_JOIN_REQUIRED')
            require(runtime.check_containers(self.selected, self.runtime_snapshot) == self.ready['containers'], 'P2_RUNTIME_CHANGED')
            migrate.write_json(self.directory, self.terminal_filename(), self.outcome)
            self.safety({'operation': 'committed', 'sha256': migrate.file_hash(migrate.read_input(self.directory, self.terminal_filename()))})
            self.committed.set()
            self.send(identity, 'COMMITTED', receipt=self.outcome)
            return False
        else:
            raise ValueError('P2_PROTOCOL_OPERATION_REFUSED')
        return True

    def close(self, committed=False):
        if not committed:
            self.abort()
            if hasattr(self, 'directory'):
                try:
                    migrate.write_json(self.directory, 'p2-release-failure.json', self.outcome)
                except BaseException:
                    pass
        if self.observer:
            self.observer.stop()
        if self.worker:
            self.worker_done.wait(15)
        if self.scope:
            self.scope.closed = True
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None


def main():
    broker, committed = None, False
    def emit(value):
        text = json.dumps(value, separators=(',', ':'))
        require(len(text) <= MAXIMUM, 'P2_PROTOCOL_OUTPUT_REFUSED')
        print(text, flush=True)
    try:
        first = sys.stdin.buffer.readline(MAXIMUM + 1)
        require(0 < len(first) <= MAXIMUM and first.endswith(b'\n'), 'P2_INITIAL_INPUT_REFUSED')
        broker = Broker(json.loads(first), emit)
        broker.initialize()
        broker.send(0, 'LOCKED')
        while True:
            raw = sys.stdin.buffer.readline(MAXIMUM + 1)
            if not raw:
                break
            require(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'), 'P2_PROTOCOL_INPUT_REFUSED')
            value = json.loads(raw)
            if value.get('operation') == 'check':
                broker.command(value)
            else:
                require(broker.operation_active.acquire(blocking=False), 'P2_CONCURRENT_STAGE_REFUSED')
                def operation(value=value):
                    try:
                        broker.command(value)
                    except BaseException:
                        broker.abort()
                        broker.send(value.get('id'), 'P2_HOST_STAGE_FAILED')
                    finally:
                        broker.operation_active.release()
                threading.Thread(target=operation, daemon=True).start()
        committed = broker.committed.is_set()
        require(committed, 'P2_CONTROLLER_DISCONNECTED')
    except BaseException:
        print('{"status":"P2_HOST_RELEASE_FAILED_REQUIRES_REVIEW"}', file=sys.stderr, flush=True)
        raise SystemExit(1)
    finally:
        if broker:
            broker.close(committed)


if __name__ == '__main__':
    print('P2_INDEPENDENT_SUPERVISOR_REQUIRED', file=sys.stderr)
    raise SystemExit(1)
