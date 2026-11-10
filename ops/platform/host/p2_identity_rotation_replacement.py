"""Physical custody for the fixed profiled replacement rotation parent."""

import base64
import copy
import json
from pathlib import Path
import re
import subprocess
import threading
import time
from uuid import uuid4

import migrate
import p2_certification_parent as certification
import p2_release_supervisor as supervisor
from p2_replacement_successor import verify_replacement_runtime_before_arm
from p2_source_closure import private_observer_program
import release as runtime

REFUSED = 'P2_ROTATION_REPLACEMENT_PHYSICAL_CUSTODY_REFUSED'
CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
API_CREDENTIALS = {'course': 'COURSE_STAGING_DATABASE_URL', 'community': 'COMMUNITY_STAGING_DATABASE_URL'}
SHARED_FIELDS = ('qualificationTargetProfile', 'environment', 'sourceCommit', 'sourceSha256', 'sourceClosureSha256',
                 'hostMachineId', 'bundle', 'configuration', 'results', 'candidate', 'candidateSha256',
                 'configurationSha256')
WRITER_FLAG = '--profiled-replacement-rotation-writer-scope'
WRITER_STATUS = 'P2_ROTATION_WRITER_SCOPE_VERIFIED'
WRITER_OPERATION_FIELDS = {'id', 'epoch', 'kind', 'state', 'producer_sha256', 'source_sha', 'role_oid',
                           'completed_at', 'reconciliation_sha256'}
MAXIMUM_AUTH_SECONDS = 300
MAXIMUM_AUTH_WINDOWS = 3
MAXIMUM_WRITER_OPERATIONS = 32
MANAGED_MODE = 'p2-identity-key-rotation'
MANAGED_PLAN_STATUS = 'P2_IDENTITY_ROTATION_MANAGED_PLANNED'
AUTHENTICATION_PHASES = ('overlap', 'current-only', 'post-removal')
CONFIGURATION_PHASES = ('baseline', 'overlap', 'current-only')
IDENTITY_PROFILES = ('course-learner', 'course-admin', 'community-member', 'community-admin')
GUARD_FIELDS = {'_guardLayout', '_guardObserverSource', '_guardObserverProgram', '_guardLockDescriptor', '_guardPid'}
MANAGED_INITIAL_FIELDS = {*SHARED_FIELDS, 'version', 'mode', 'rotationActionId', 'rotationPlan', 'frontendCustody',
    'confirmation', 'credentials', 'vercelToken', 'scopedCronSecret', 'nativePlan', 'baselineConfigurationRecordSha256',
    'rotationConfiguration', 'privateRotationConfigurationSha256', 'expectedFeatureControls',
    'expectedWriterAdmissionBinding', 'operatorProgramSha256', 'rotationBrowserProgramSha256', 'gatewayHost',
    'certification', 'targetSha256', 'owner', 'producers'}
MANAGED_PLAN_FALSE = ('sqlAuthorized', 'rolePreparationAuthorized', 'loginChangeAuthorized', 'trafficAuthorized',
    'communityMemberFeatureAdded', 'newPublicEndpoint', 'keyRemovalVerified', 'releaseAccepted', 'liveEligible')
MANAGED_PLAN_FIELDS = {'version', 'qualificationTargetProfile', 'environment', 'status', 'actionId', 'candidateSha256',
    'hostMachineId', 'sourceCommit', 'originalReleaseId', 'courseId', 'subjects', 'configuration', 'featureControls',
    'writerAdmissionBinding', 'targetSha256', 'operatorSourceClosureSha256', 'candidateObjectSha256',
    'replacementLeasePlanSha256', 'frontendCustodyPlanSha256', 'readyReceiptSha256', 'nativePlanSha256',
    'initialEpoch', 'finalEpoch', 'authenticationWindows', 'bindingSha256', *MANAGED_PLAN_FALSE}
require = migrate.demand


def _closed(epoch):
    require(type(epoch) is str and re.fullmatch(r'[1-9][0-9]{0,17}', epoch), REFUSED)
    return {'epoch': epoch, 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}


def validate_managed_rotation_initial(initial):
    """Reject any projection beyond the exact source-owned v2 handoff."""
    expected = certification._profiled_context()
    require(type(initial) is dict and set(initial) - GUARD_FIELDS == MANAGED_INITIAL_FIELDS and
            type(initial['version']) is int and initial['version'] == 2 and initial['mode'] == MANAGED_MODE and
            initial['environment'] == 'staging', REFUSED)
    rotation, review = initial['rotationPlan'], initial['frontendCustody']
    require(type(rotation) is dict and set(rotation) == MANAGED_PLAN_FIELDS and type(rotation['version']) is int and
            rotation['version'] == 2 and rotation['status'] == MANAGED_PLAN_STATUS and
            all(rotation[key] is False for key in MANAGED_PLAN_FALSE) and
            type(review) is dict and set(review) == certification.PROFILED_INITIAL_FIELDS and
            all(certification._canonical(initial[key]) == certification._canonical(review[key]) for key in SHARED_FIELDS),
            REFUSED)
    plan = review['certificationPlan']
    require(type(plan) is dict and plan.get('mode') == 'contain-native' and plan.get('startState') == 'already-closed' and
            type(plan.get('nativePlan')) is dict and plan.get('replacementRelease') is not None and
            type(review['inventory']) is dict and type(initial['certification']) is dict, REFUSED)
    native = plan['nativePlan']
    migrate.require_profile(expected, initial, rotation, review, plan, native)
    require(all(rotation[key] == initial[key] == review[key] for key in
                ('environment', 'candidateSha256', 'sourceCommit', 'hostMachineId', 'targetSha256')) and
            type(initial['rotationActionId']) is str and re.fullmatch(r'p2-key-rotation-[a-z0-9-]{1,40}', initial['rotationActionId']) and
            rotation['actionId'] == initial['rotationActionId'] == review['certificationActionId'] == plan['certificationActionId'] and
            rotation['originalReleaseId'] == plan['originalReleaseId'] == initial['candidate']['releaseId'] and
            initial['confirmation'] == 'staging/' + initial['rotationActionId'] and
            initial['owner'] == review['owner'] == native['owner'] and
            initial['producers'] == review['inventory']['producers'] == [native['producer']] and
            initial['certification'] == review['certification'] and initial['nativePlan'] == native and
            initial['expectedFeatureControls'] == rotation['featureControls'] == native['featureControls'] ==
                initial['certification']['featureControls'] and
            initial['expectedWriterAdmissionBinding'] == rotation['writerAdmissionBinding'] == native['writerAdmissionBinding'] ==
                review['expectedWriterAdmissionBinding'] and
            initial['baselineConfigurationRecordSha256'] == native['configurationRecordSha256'] and
            rotation['frontendCustodyPlanSha256'] == plan['planSha256'] and rotation['nativePlanSha256'] == native['planSha256'] and
            rotation['readyReceiptSha256'] == plan['readyReceiptSha256'] and
            rotation['candidateObjectSha256'] == plan['candidateObjectSha256'] and
            rotation['operatorSourceClosureSha256'] == initial['sourceClosureSha256'] and
            certification._profiled_digest(rotation['replacementLeasePlanSha256']) and
            rotation['bindingSha256'] == migrate.file_hash(certification._canonical({
                key: value for key, value in rotation.items() if key != 'bindingSha256'})), REFUSED)
    _closed(plan['initialEpoch'])
    start = int(plan['initialEpoch'])
    windows = [{'phase': phase, 'beforeEpoch': str(start + 2 * index), 'openEpoch': str(start + 2 * index + 1),
                'closedEpoch': str(start + 2 * index + 2)} for index, phase in enumerate(AUTHENTICATION_PHASES)]
    require(rotation['initialEpoch'] == plan['initialEpoch'] and rotation['authenticationWindows'] == windows and
            rotation['finalEpoch'] == windows[-1]['closedEpoch'], REFUSED)
    _closed(rotation['finalEpoch'])
    uuid = r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
    require(type(rotation['courseId']) is str and re.fullmatch(uuid, rotation['courseId']) and
            type(rotation['subjects']) is dict and set(rotation['subjects']) == set(IDENTITY_PROFILES) and
            all(type(value) is str and re.fullmatch(uuid, value) for value in rotation['subjects'].values()) and
            len(set(rotation['subjects'].values())) == len(IDENTITY_PROFILES), REFUSED)
    configuration, private = rotation['configuration'], initial['privateRotationConfigurationSha256']
    root = initial['rotationConfiguration']
    require(type(root) is str and root.startswith('/var/lib/lash-her/releases/staging/') and ',' not in root and
            type(configuration) is dict and type(private) is dict and
            set(configuration) == set(private) == set(CONFIGURATION_PHASES), REFUSED)
    for phase in CONFIGURATION_PHASES:
        selected = configuration[phase]
        require(type(selected) is dict and set(selected) == {'sha256', 'privateRef'} and
                selected['privateRef'] == str(Path(root) / phase) and
                certification._profiled_digest(selected['sha256']) and certification._profiled_digest(private[phase]) and
                selected['sha256'] != private[phase], REFUSED)
    require(len({value['sha256'] for value in configuration.values()}) == len(set(private.values())) == 3 and
            type(initial['credentials']) is dict and set(initial['credentials']) == {CREDENTIAL, *API_CREDENTIALS.values()} and
            all(type(value) is str and 0 < len(value) <= 16_384 for value in initial['credentials'].values()) and
            type(initial['scopedCronSecret']) is str and re.fullmatch(r'[!-~]{32,8192}', initial['scopedCronSecret']) and
            type(initial['vercelToken']) is str and re.fullmatch(r'[!-~]{1,8192}', initial['vercelToken']), REFUSED)
    return expected


class ReplacementRotationPhysicalObserver(certification.P2CertificationPhysicalObserver):
    """Observe only the exact original scope or the scoped authentication transition."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        require(self._replacement is not None and self.request['plan']['mode'] == 'contain-native', REFUSED)
        self._state_lock = threading.RLock()
        self._allowed = ((self.request['plan']['initialEpoch'], 'ordinary'),)
        self._opened_epochs = set()
        self._deadline = None

    def transition(self, before_epoch, opening, maximum_seconds=None):
        _closed(before_epoch)
        require(type(opening) is bool, REFUSED)
        after = str(int(before_epoch) + 1)
        _closed(after)
        before_registry, after_registry = ('ordinary', 'interactive') if opening else ('interactive', 'ordinary')
        with self._state_lock:
            require(self._allowed == ((before_epoch, before_registry),), REFUSED)
            if opening:
                require(type(maximum_seconds) is int and 0 < maximum_seconds <= MAXIMUM_AUTH_SECONDS and
                        len(self._opened_epochs) < MAXIMUM_AUTH_WINDOWS, REFUSED)
                self._opened_epochs.add(after)
                self._deadline = time.monotonic() + maximum_seconds
            self._allowed = ((before_epoch, before_registry), (after, after_registry))
        return after

    def exact(self, epoch, new_work, maximum_seconds=None):
        _closed(epoch)
        require(type(new_work) is bool, REFUSED)
        target = (epoch, 'interactive' if new_work else 'ordinary')
        with self._state_lock:
            require(target == self._allowed[-1], REFUSED)
            if new_work:
                require(type(maximum_seconds) is int and 0 < maximum_seconds <= MAXIMUM_AUTH_SECONDS and
                        self._deadline is not None and time.monotonic() <= self._deadline, REFUSED)
                self._deadline = min(self._deadline, time.monotonic() + maximum_seconds)
            else:
                self._deadline = None
            self._allowed = (target,)

    def probe(self, operation):
        if operation != 'observe':
            require(operation in ('verify-schema', 'verify-closed'), REFUSED)
            return super().probe(operation)
        with self._state_lock:
            epoch, registry = next((state for state in self._allowed if state[1] == 'interactive'), self._allowed[-1])
            return self._writer_readback(epoch, registry)

    def observe_writer_scope(self, operation_epoch):
        _closed(operation_epoch)
        with self._state_lock:
            requested = int(operation_epoch)
            choices = set()
            for epoch, registry in self._allowed:
                current = int(epoch)
                if requested == current:
                    choices.add(registry)
                elif registry == 'ordinary' and (requested == current + 1 or
                        requested == current - 1 and operation_epoch in self._opened_epochs):
                    choices.add('interactive')
            require(len(choices) == 1, REFUSED)
            observed = self._writer_readback(operation_epoch, choices.pop())
        return {'admission': observed['admission'], 'producers': observed['writerScope']['producers'],
                'operations': observed['writerScope']['operations']}

    def _writer_readback(self, operation_epoch, operation_registry):
        require(migrate.file_hash(certification._profiled_compact(self.request)) == self._request_sha256, REFUSED)
        selection = {'operationEpoch': operation_epoch, 'operationRegistry': operation_registry}
        return self._writer_result(self._run_writer_observer(selection), selection)

    def _run_writer_observer(self, selection):
        payload = json.dumps({**self.request, 'operation': 'writer-scope', 'writerScope': selection})
        program = self.program
        require(len(payload.encode()) <= 2_000_000 and migrate.file_hash(program.read_bytes()) == self.program_sha256 and
                isinstance(certification._core, bytes) and
                migrate.read_input(self.source, certification.CORE) == certification._core, REFUSED)
        core = certification._cache_core(program.parent)
        name = 'lash-p2-certification-observer-' + uuid4().hex
        entry = certification.OBSERVER
        image = self.selected['artifacts']['frontendMigration']['image']
        args = ['docker', 'run', '--rm', '--pull', 'never', '--name', name, '--interactive', '--network', 'host',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m',
                '--pids-limit', '64', '--env', CREDENTIAL, '--mount', f'type=bind,src={program},dst=/app/{entry},readonly',
                '--mount', f'type=bind,src={core},dst=/app/{certification.CORE},readonly',
                '--entrypoint', 'node', image, entry, WRITER_FLAG]
        try:
            result = subprocess.run(args, input=payload, capture_output=True, text=True,
                                    env={**runtime.SAFE_ENV, CREDENTIAL: self.credential}, timeout=30, check=True)
        finally:
            subprocess.run(['docker', 'rm', '--force', name], env=runtime.SAFE_ENV,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
            require(not runtime.command(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$',
                                         '--format', '{{.ID}}'], runtime.SAFE_ENV, 15), REFUSED)
        require(not result.stderr and 0 < len(result.stdout.encode()) <= 2_000_000 and
                migrate.file_hash(program.read_bytes()) == self.program_sha256 and core.read_bytes() == certification._core, REFUSED)
        return result.stdout

    def _producers(self, registry):
        plan = self.request['plan']
        if registry == 'interactive':
            producer = migrate.file_hash(
                "\n".join(('lash-her:p2q:interactive-producer:v1', plan['sourceCommit'], plan['targetSha256'])).encode())
            role = plan['nativePlan']['producer']['role']
            return [{'producerSha256': producer, 'role': {'name': role['name'], 'oid': role['oid']}}]
        return [{'producerSha256': row['producerSha256'], 'role': {'name': row['role']['name'], 'oid': row['role']['oid']}}
                for row in self.request['producers']]

    def _writer_result(self, raw, selection):
        value = certification._profiled_record(raw, self._expected_profile)
        request, receipt, plan = self.request, self.request['receipt'], self.request['plan']
        required = {'version', 'qualificationTargetProfile', 'status', 'environment', 'releaseId', 'sourceCommit',
                    'targetSha256', 'marker', 'backendPid', 'backendStart', 'admission', 'journalSha256', 'writerScope',
                    *certification.REPLACEMENT_PROOF_FIELDS}
        require(set(value) == required and value['status'] == WRITER_STATUS and value['environment'] == 'staging' and
                all(value[key] == request[key] for key in ('marker', 'backendPid', 'backendStart')) and
                type(value['backendPid']) is int and
                all(value[key] == request['job'][key] for key in ('releaseId', 'sourceCommit')) and
                value['targetSha256'] == plan['targetSha256'] and value['journalSha256'] == receipt['journalSha256'], REFUSED)
        certification.require_certification_replacement_proof(value, self._replacement)
        admission, witness = value['admission'], value['writerScope']
        require(type(admission) is dict and set(admission) == {'epoch', 'newWork', 'recovery', 'active', 'uncertain'} and
                type(witness) is dict and set(witness) == {'currentEpoch', 'operationEpoch', 'currentRegistry',
                    'operationRegistry', 'operations', 'producers', 'registrySha256'} and
                all(witness[key] == item for key, item in selection.items()) and
                witness['currentEpoch'] == admission['epoch'] and
                (admission['epoch'], witness['currentRegistry']) in self._allowed, REFUSED)
        interactive = witness['currentRegistry'] == 'interactive'
        require(admission['newWork'] is interactive and admission['recovery'] is interactive and
                type(admission['active']) is int and 0 <= admission['active'] <= (2 if interactive else 0) and
                type(admission['uncertain']) is int and admission['uncertain'] == 0 and
                (not interactive or self._deadline is not None and time.monotonic() <= self._deadline), REFUSED)
        current_epoch, operation_epoch = int(admission['epoch']), int(selection['operationEpoch'])
        difference = operation_epoch - current_epoch
        require((difference == 0 and selection['operationRegistry'] == witness['currentRegistry']) or
                (not interactive and selection['operationRegistry'] == 'interactive' and
                 (difference == 1 or difference == -1 and selection['operationEpoch'] in self._opened_epochs)), REFUSED)
        expected_producers = self._producers(witness['currentRegistry'])
        require(certification._canonical(witness['producers']) == certification._canonical(expected_producers) and
                witness['registrySha256'] == migrate.file_hash(certification._profiled_compact(expected_producers)), REFUSED)
        producers = {row['producerSha256']: row['role']['oid'] for row in self._producers(selection['operationRegistry'])}
        operations = witness['operations']
        require(type(operations) is list and len(operations) <= MAXIMUM_WRITER_OPERATIONS and
                all(type(row) is dict and set(row) == WRITER_OPERATION_FIELDS and
                    type(row['id']) is str and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', row['id']) and
                    row['epoch'] == selection['operationEpoch'] and row['kind'] in ('new-work', 'recovery') and
                    row['source_sha'] == plan['sourceCommit'] and type(row['producer_sha256']) is str and
                    row['producer_sha256'] in producers and
                    row['role_oid'] == producers[row['producer_sha256']] and row['reconciliation_sha256'] is None and
                    (row['state'] == 'completed' and type(row['completed_at']) is str and
                     re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', row['completed_at'])
                     or row['state'] == 'active' and row['completed_at'] is None) for row in operations) and
                len({row['id'] for row in operations}) == len(operations) and
                sum(row['state'] == 'active' for row in operations) == admission['active'] and
                (difference <= 0 or not operations), REFUSED)
        return value


class ReplacementRotationCustody:
    """Join a reviewed replacement to fresh, scoped frontend and API readbacks."""

    def __init__(self, initial, source, *, lock_fd, directory):
        source, directory = Path(source), Path(directory)
        expected = certification._profiled_context()
        review = initial.get('frontendCustody')
        rotation = initial.get('rotationPlan')
        require(type(initial.get('version')) is int and initial['version'] == 2 and
                type(review) is dict and set(review) == certification.PROFILED_INITIAL_FIELDS and
                type(rotation) is dict and initial.get('environment') == 'staging' and
                all(field in initial and review[field] == initial[field] for field in SHARED_FIELDS) and
                review['certificationActionId'] == initial.get('rotationActionId') == rotation.get('actionId') and
                all(rotation.get(key) == review[key] for key in ('sourceCommit', 'candidateSha256', 'hostMachineId')) and
                type(lock_fd) is int and lock_fd >= 0 and
                initial.get('_guardLockDescriptor', lock_fd) == lock_fd and
                directory.is_absolute() and directory == directory.resolve() and directory.parent == Path(review['results']),
                REFUSED)
        plan = review['certificationPlan']
        require(type(plan) is dict and plan.get('mode') == 'contain-native' and plan.get('startState') == 'already-closed' and
                'replacementRelease' in plan and 'historicalLogins' not in plan and
                plan.get('faultSelection') is None and 'knownAckRecovery' not in plan and 'scopedAction' not in plan, REFUSED)
        native_plan = plan.get('nativePlan')
        require(type(native_plan) is dict and native_plan.get('commandWitnesses') == [] and
                native_plan.get('initialEpoch') == plan.get('initialEpoch') and
                'providerQueuedInventory' in native_plan and native_plan['providerQueuedInventory'] is None and
                all(native_plan.get(key) is False for key in ('automaticReplayAllowed', 'migrationAuthorized', 'wholeReleaseAccepted')),
                REFUSED)
        migrate.require_profile(expected, initial, review, plan)
        _closed(plan.get('initialEpoch'))
        credentials = initial.get('credentials')
        require(type(credentials) is dict and all(type(credentials.get(key)) is str and 0 < len(credentials[key]) <= 16_384
                for key in (CREDENTIAL, *API_CREDENTIALS.values())), REFUSED)

        self.source, self.directory, self.expected = source, directory, expected
        self._review = copy.deepcopy(review)
        self._credentials = {key: credentials[key] for key in (CREDENTIAL, *API_CREDENTIALS.values())}
        self._plan = self._review['certificationPlan']
        self._guard = {**self._review, 'credentials': {CREDENTIAL: credentials[CREDENTIAL]},
                       '_guardLayout': supervisor.PROFILED_CERTIFICATION_LAYOUT, '_guardLockDescriptor': lock_fd,
                       '_guardObserverSource': certification.OBSERVER}
        self._scope = None
        self._armed_probe_sha = None
        self._verify_review()
        self._selected, self._jobs = migrate.make_plan(Path(review['bundle']), expected_profile=expected)
        require(self._selected == review['candidate'] and set(self._jobs) == {'frontend', 'course', 'community'}, REFUSED)
        certification.cache_certification_core(self._review, source, expected_profile=expected)

    def _verify(self):
        supervisor.verify_guard_boundary(self._guard, self.source)

    def _verify_review(self):
        self._verify()
        verified = certification.prepare_profiled_current_certification_input(self._review, self.source)
        require(verified.get('status') == 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED' and
                verified.get('originalReleasePlanHashHostVerified') is True and
                verified.get('hostOriginalReleaseReceiptSha256') == self._plan['originalReleaseReceiptSha256'] and
                verified.get('planSha256') == self._plan['planSha256'] and
                verified.get('replacementRelease') == self._plan['replacementRelease'] and
                verified.get('successorRuntime') == self._plan.get('successorRuntime') and
                all(verified.get(key) is False for key in ('executionEligible', 'providerTouched', 'admissionChanged', 'releaseAccepted')),
                REFUSED)
        self._verify()

    def validate_arm_probe(self, probe):
        self._verify()
        supervisor._validate_profiled_certification_arm(self._guard, probe, self._jobs['frontend'])

    def _observer(self, probe, directory, *, writer=False):
        self.validate_arm_probe(probe)
        program_bytes = migrate.read_input(self.source, certification.OBSERVER)
        program_sha = self._review['sourceSha256'][certification.OBSERVER]
        require(migrate.file_hash(program_bytes) == program_sha, REFUSED)
        program = private_observer_program({**self._guard, '_guardObserverProgram': program_bytes},
                                           self.directory / directory)
        observer_type = ReplacementRotationPhysicalObserver if writer else certification.P2CertificationPhysicalObserver
        return observer_type(self._selected, probe, self.source, self._credentials[CREDENTIAL],
                             program=program, program_sha256=program_sha, expected_profile=self.expected)

    def _observe(self, observer, operation, epoch):
        self._verify()
        observed = observer.probe(operation)
        expected_status = ('P2_CERTIFICATION_FRONTEND_SESSION_CLOSED' if operation == 'verify-closed'
                           else 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED')
        require(observed.get('status') == expected_status and
                certification._canonical(observed.get('admission')) == certification._canonical(_closed(epoch)), REFUSED)
        self._verify()
        return observed

    def _probe_sha(self, probe):
        return migrate.file_hash(certification._profiled_compact(probe))

    def verify_arm(self, probe):
        """Independently verify the physical session and the selected closed runtime."""
        require(self._armed_probe_sha is None, REFUSED)
        probe = copy.deepcopy(probe)
        self._verify_review()
        observer = self._observer(probe, 'guard-replacement-verify-schema')
        observed = self._observe(observer, 'verify-schema', self._plan['initialEpoch'])
        verify_replacement_runtime_before_arm(self._guard, self.source)
        self._verify()
        self._armed_probe_sha = self._probe_sha(probe)
        return observed

    def open_scope(self, probe, abort):
        """Start the broker's exact profiled observer and create its typed API scope."""
        require(self._scope is None and callable(abort), REFUSED)
        probe = copy.deepcopy(probe)
        probe_sha = self._probe_sha(probe)
        require(self._armed_probe_sha in (None, probe_sha), REFUSED)
        observer = self._observer(probe, 'rotation-replacement-observer', writer=True)
        try:
            observer.start(abort)
            scope = certification.P2CertificationScope(self._guard['_guardLockDescriptor'], supervisor.LOCK,
                self._verify, observer.request['receipt'], self._review['candidateSha256'],
                release=self._selected, jobs=self._jobs, configuration_sha256=self._review['configurationSha256'],
                certification_plan=self._plan, expected_profile=self.expected, physical_observer=observer,
                original_replacement_receipt=base64.b64decode(self._review['originalReleaseReceipt'], validate=True))
        except BaseException:
            observer.stop()
            raise
        self._scope = scope
        self._armed_probe_sha = probe_sha
        return scope

    @property
    def scope_observer(self):
        require(self._scope is not None, REFUSED)
        return self._scope._physical_observer

    def observe_writer_scope(self, probe, operation_epoch):
        require(self._scope is not None and self._armed_probe_sha == self._probe_sha(probe), REFUSED)
        self._scope.verify()
        observed = self.scope_observer.observe_writer_scope(operation_epoch)
        self._scope.verify()
        return observed

    def check_apis(self, scope, output):
        """Run the fixed read-only API checks under the broker's held physical scope."""
        output = Path(output)
        require(self._scope is not None and scope is self._scope and output.is_absolute() and
                output == output.resolve() and output.parent == self.directory, REFUSED)
        credentials = {name: self._credentials[key] for name, key in API_CREDENTIALS.items()}
        return certification.check_profiled_certification_apis(scope, self._jobs, self.source, Path(self._review['bundle']),
            output, credentials, self._review['sourceSha256'], expected_profile=self.expected)

    def verify_closed(self, probe, expected_epoch):
        """Read a fresh zero-admission boundary after the owner session and broker exit."""
        _closed(expected_epoch)
        probe = copy.deepcopy(probe)
        require(self._armed_probe_sha == self._probe_sha(probe) and
                int(expected_epoch) >= int(self._plan['initialEpoch']), REFUSED)
        self._verify_review()
        observer = self._observer(probe, 'guard-replacement-verify-closed')
        return self._observe(observer, 'verify-closed', expected_epoch)


def prepare_replacement_rotation_custody(initial, source, *, lock_fd, directory):
    return ReplacementRotationCustody(initial, source, lock_fd=lock_fd, directory=directory)
