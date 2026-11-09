"""Source-owned profiled interrupted known-ACK runtime transition.

Retained records select one of two reviewed stopped gateway frontiers. They do
not authorize a runtime mutation. The exact fresh broker consumes a process-
local one-use authority, and every command remains registered on its fresh
P2CertificationScope. No migration or role entrypoint is reachable here.
"""

import copy
import json
from pathlib import Path
import re
import threading
import time
import weakref

import migrate
import release as runtime
import staging_admission
from p2_known_ack_loss import (KnownAckLossBoundary, _same_process, _source_command,
                               _zero, canonical, digest, replacement_release_pins)
from p2_recovery_runtime import P2RecoveryRuntime
from p2_release_scope import P2ReleaseScope


require = migrate.demand
FRONTIERS = ('original-stopped-one', 'replacement-stopped-zero')
INTENT = 'profiled-interrupted-runtime-intent.json'
GATEWAY_INTENT = 'profiled-interrupted-gateway-replacement-started.json'
OUTCOME = 'profiled-interrupted-runtime-outcome.json'
_BOUNDARIES = weakref.WeakSet()


def _profile():
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    return migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)


def _profile_fields(expected):
    return {'version': 2, 'qualificationTargetProfile': expected}


def _action(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', value)


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)


def _retained_shape(value):
    keys = {'selection', 'plan', 'values', 'stages', 'originalGateway', 'stoppedGateway',
            'frontier', 'inputDirectory', 'oldMountedDirectory', 'replacementDirectory',
            'replacementSnapshot', 'activeStage', 'completedStages', 'oldProcesses',
            'observedProcesses', 'originalSource', 'originalSourceManifest',
            'originalFaultReceiptSha256', 'originalAuxiliarySha256'}
    require(isinstance(value, dict) and set(value) == keys and value.get('frontier') in FRONTIERS,
            'P2_PROFILED_INTERRUPTED_RETAINED_SHAPE_REQUIRED')
    require(all(isinstance(value[name], Path) and value[name].is_absolute() for name in
                ('inputDirectory', 'oldMountedDirectory', 'replacementDirectory',
                 'replacementSnapshot', 'originalSource')),
            'P2_PROFILED_INTERRUPTED_RETAINED_PATH_REQUIRED')
    completed = [tuple(stage) for stage in value['completedStages']] if isinstance(value['completedStages'], list) else []
    require(isinstance(value['completedStages'], list) and
            all(stage in runtime.STAGES for stage in completed) and
            len(set(completed)) == len(completed) and
            completed == runtime.STAGES[:len(completed)],
            'P2_PROFILED_INTERRUPTED_COMPLETED_STAGE_PREFIX_REQUIRED')
    active = value['activeStage']
    require(active is None or (len(completed) < len(runtime.STAGES) and tuple(active) in runtime.STAGES and
            tuple(active) == runtime.STAGES[len(value['completedStages'])]),
            'P2_PROFILED_INTERRUPTED_ACTIVE_STAGE_REQUIRED')
    require(isinstance(value['observedProcesses'], dict) and
            set(value['observedProcesses']) == set(runtime.SERVICES),
            'P2_PROFILED_INTERRUPTED_PROCESS_SET_REQUIRED')
    process_fields = {'containerId', 'imageId', 'pid', 'startedAt', 'restartCount', 'running'}
    require(all(isinstance(row, dict) and set(row) == process_fields and
                isinstance(row['containerId'], str) and re.fullmatch(r'[a-f0-9]{12,64}', row['containerId']) and
                isinstance(row['imageId'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId']) and
                type(row['pid']) is int and row['pid'] >= 0 and isinstance(row['startedAt'], str) and row['startedAt'] and
                type(row['restartCount']) is int and row['restartCount'] >= 0 and type(row['running']) is bool
                for row in value['observedProcesses'].values()),
            'P2_PROFILED_INTERRUPTED_PROCESS_SHAPE_REQUIRED')
    return value


def _authority_record(record, broker, retained, expected):
    fields = {'version', 'qualificationTargetProfile', 'status', 'restorationActionId',
              'candidateSha256', 'frontier', 'originalStopReceiptSha256',
              'originalCausalReceiptSha256'}
    require(isinstance(record, dict) and set(record) == fields and
            type(record['version']) is int and record['version'] == 2 and
            record['qualificationTargetProfile'] == expected and
            record['status'] == 'P2_PROFILED_INTERRUPTED_RUNTIME_AUTHORIZED' and
            record['restorationActionId'] == broker.action_id() and
            record['candidateSha256'] == broker.initial['candidateSha256'] and
            record['frontier'] == retained['frontier'] and
            record['originalStopReceiptSha256'] ==
                retained['selection']['priorGatewayReference']['stopReceiptSha256'] and
            record['originalCausalReceiptSha256'] ==
                retained['selection']['causalReceiptSha256'] and
            _digest(record['originalStopReceiptSha256']) and
            isinstance(record['originalCausalReceiptSha256'], dict) and
            all(_digest(value) for value in record['originalCausalReceiptSha256'].values()),
            'P2_PROFILED_INTERRUPTED_AUTHORITY_BINDING_REQUIRED')
    return copy.deepcopy(record)


class ProfiledInterruptedKnownAckBoundary(KnownAckLossBoundary):
    """Exact current-process transition under a fresh certification scope."""

    def __init__(self, broker, record, retained):
        from p2_certification_parent import P2CertificationScope
        from p2_profiled_known_ack_restoration_parent import P2ProfiledInterruptedKnownAckBroker

        expected = _profile()
        require(type(broker) is P2ProfiledInterruptedKnownAckBroker and
                type(broker.scope) is P2CertificationScope and
                broker.scope._expected_profile == expected,
                'P2_PROFILED_INTERRUPTED_FRESH_CERTIFICATION_SCOPE_REQUIRED')
        self.broker, self.parent, self.expected_profile = broker, broker.scope, expected
        self.action = broker.action_id()
        require(_action(self.action), 'P2_PROFILED_INTERRUPTED_ACTION_REQUIRED')
        self.record = copy.deepcopy(record)
        self.retained = copy.deepcopy(_retained_shape(retained))
        self.record = _authority_record(self.record, broker, self.retained, expected)
        self.selected, self.jobs = copy.deepcopy(broker.selected), copy.deepcopy(broker.jobs)
        migrate.candidate_profile(self.selected, expected)
        self.parent.require_release(self.selected, self.jobs)
        self.parent.require_frontend(self.selected, self.jobs['frontend'])
        self.input_configuration = Path(self.retained['inputDirectory'])
        self.old_configuration = Path(self.retained['oldMountedDirectory'])
        self.replacement_configuration = Path(self.retained['replacementSnapshot'])
        require(self.input_configuration == Path(broker.configuration) and
                (not self.retained['completedStages'] and self.retained['activeStage'] is None and
                 self.retained['frontier'] == 'original-stopped-one' or
                 self.replacement_configuration.is_dir()),
                'P2_PROFILED_INTERRUPTED_CONFIGURATION_BINDING_REQUIRED')
        self.output = Path(broker.directory) / 'runtime-interrupted'
        self.snapshot = self.output / 'configuration'
        require(Path(broker.directory).name == 'p2-profiled-known-ack-restoration-' + self.action and
                not self.output.exists() and not self.output.is_symlink(),
                'P2_PROFILED_INTERRUPTED_FIXED_OUTPUT_REQUIRED')
        self.output.mkdir(mode=0o700)
        self.compose_file = Path(broker.source) / 'ops/platform/compose.yaml'
        self.compose_bytes = migrate.read_input(self.compose_file.parent, self.compose_file.name)
        require(self.selected['runtime']['composeSha256'] == 'sha256:' + digest(self.compose_bytes),
                'P2_PROFILED_INTERRUPTED_COMPOSE_SOURCE_REQUIRED')
        self.initial = {key: copy.deepcopy(broker.initial[key]) for key in
                        ('candidateSha256', 'hostMachineId', 'configurationSha256')}
        self.initial.update(recoveryActionId=self.action, **_profile_fields(expected))
        self.command = _source_command(self.parent)
        self.stage_index, self.stage_active, self.stage_deadline = 0, None, None
        self.snapshot_bound = False
        self.finished = False
        self.new_gateway = None
        self.new_rows, self.new_metadata = {}, {}
        self.expected_environments, self.image_ids = {}, {}
        self.stage_receipt_sha256 = {}
        self.mutex = threading.RLock()
        self._cache_environment(self.old_configuration)
        if self.replacement_configuration.exists():
            self._cache_environment(self.replacement_configuration)
        self.stopped_gateway = copy.deepcopy(self.retained['stoppedGateway'])
        self.old_gateway = copy.deepcopy(self.retained['originalGateway'])
        self._require_stopped_frontier()
        self._reading_starting_processes = True
        self.old_metadata = self._read_actual_starting_processes()
        self._reading_starting_processes = False
        self.source_missing = {service for service, value in self.old_metadata.items() if value is None}
        self.old_rows = {service: ({'service': service, 'containerId': value['containerId']}
                                   if value is not None else None)
                         for service, value in self.old_metadata.items()}
        _BOUNDARIES.add(self)
        self._retain(INTENT, {
            'status': 'P2_PROFILED_INTERRUPTED_RUNTIME_INTENT',
            'restorationActionId': self.action,
            'candidateSha256': self.initial['candidateSha256'],
            'frontier': self.retained['frontier'],
            'authoritySha256': digest(canonical(self.record)),
            'stages': [list(stage) for stage in runtime.STAGES],
            'sourceConfiguration': str(self.input_configuration),
            'snapshot': str(self.snapshot),
        })
        self.verify()

    def _retain(self, name, value):
        record = {**value, **_profile_fields(self.expected_profile)}
        migrate.write_json(self.output, name, record)
        raw = migrate.read_input(self.output, name)
        require(json.loads(raw) == record, 'P2_PROFILED_INTERRUPTED_STAGE_READBACK_REQUIRED')
        self.stage_receipt_sha256[name] = digest(raw)
        return record

    def _require_stopped_frontier(self):
        import p2_prior_gateway as prior

        reference = self.retained['selection'].get('priorGatewayReference')
        require(isinstance(reference, dict), 'P2_PROFILED_INTERRUPTED_STOP_REFERENCE_REQUIRED')
        initial = {**self.initial, 'priorGatewayReference': reference}
        observed = prior.observe_stopped_prior_gateway(
            initial, self.selected, self.parent.verify, self.command,
            expected_profile=self.expected_profile)
        require(observed == self.stopped_gateway and prior._closed_observed(observed) and
                _zero(observed['admission']['active']),
                'P2_PROFILED_INTERRUPTED_EXACT_STOPPED_GATEWAY_REQUIRED')
        uncertain = observed['admission']['uncertain']
        if self.retained['frontier'] == 'original-stopped-one':
            require(_same_process(observed, self.old_gateway) and
                    uncertain == {'newWork': 0, 'recovery': 1},
                    'P2_PROFILED_INTERRUPTED_STOPPED_ONE_REQUIRED')
        else:
            require(not _same_process(observed, self.old_gateway) and
                    uncertain == {'newWork': 0, 'recovery': 0},
                    'P2_PROFILED_INTERRUPTED_STOPPED_ZERO_REQUIRED')
        self.stopped_initial = initial

    def _configuration_for(self, service, identifier):
        observed = self.retained['observedProcesses'][service]
        if identifier == observed.get('containerId'):
            completed = {name for stage in self.retained['completedStages'] for name in stage}
            return self.replacement_configuration if service in completed else self.old_configuration
        starting = (getattr(self, 'old_metadata', {}).get(service) or {}).get('containerId')
        if self._reading_starting_processes or identifier == starting:
            return self.replacement_configuration
        return self.snapshot

    def _validate_actual(self, value, service, *, healthy):
        configuration = self._configuration_for(service, value['Id'])
        self._validate_container(value, service, configuration, healthy=healthy)
        return self._public_process(value)

    def _read_actual_starting_processes(self):
        grouped = self._inventory()
        active = set(self.retained['activeStage'] or ())
        result = {}
        for service in runtime.SERVICES:
            ids = grouped[service]
            if service == 'gateway':
                require(len(ids) == 1, 'P2_PROFILED_INTERRUPTED_STOPPED_GATEWAY_INVENTORY_REQUIRED')
                value = self._inspect(ids[0])
                actual = self._validate_actual(value, service, healthy=False)
                stopped = {**self.stopped_gateway['process'], 'running': False, 'pid': 0}
                require(actual == stopped and actual['running'] is False and type(actual['pid']) is int,
                        'P2_PROFILED_INTERRUPTED_STOPPED_GATEWAY_PROCESS_REQUIRED')
                result[service] = actual
                continue
            require(len(ids) == 1 or service in active and len(ids) == 0,
                    'P2_PROFILED_INTERRUPTED_EXACT_STARTING_INVENTORY_REQUIRED')
            if not ids:
                result[service] = None
                continue
            value = self._inspect(ids[0])
            actual = self._validate_actual(value, service, healthy=False)
            require(actual['running'] is False and type(actual['pid']) is int and actual['pid'] == 0,
                    'P2_PROFILED_INTERRUPTED_SOURCE_RUNTIME_NOT_STOPPED')
            retained = {**self.retained['observedProcesses'][service], 'running': False, 'pid': 0}
            if service not in active:
                require(actual == retained, 'P2_PROFILED_INTERRUPTED_RETAINED_PROCESS_CHANGED')
            else:
                require(actual == retained or
                        actual['containerId'] != retained['containerId'] and actual['restartCount'] == 0,
                        'P2_PROFILED_INTERRUPTED_ACTIVE_PROCESS_REQUIRED')
            result[service] = actual
        return result

    def _verify_broker(self):
        from p2_profiled_known_ack_restoration_parent import P2ProfiledInterruptedKnownAckBroker

        require(type(self.broker) is P2ProfiledInterruptedKnownAckBroker and
                self.broker.scope is self.parent,
                'P2_PROFILED_INTERRUPTED_PARENT_CHANGED')
        self.parent.require_release(self.selected, self.jobs)
        self.parent.require_configuration(self.input_configuration)
        self.parent.require_frontend(self.selected, self.jobs['frontend'])
        self.broker.verify_original()
        self.broker.reader.snapshot()
        self.broker.require_native_off()
        for name, pin in self.stage_receipt_sha256.items():
            require(digest(migrate.read_input(self.output, name)) == pin,
                    'P2_PROFILED_INTERRUPTED_STAGE_RECEIPT_CHANGED')

    def verify(self):
        with self.mutex:
            require(self in _BOUNDARIES, 'P2_PROFILED_INTERRUPTED_BOUNDARY_REQUIRED')
            self._verify_broker()
            if not self.finished and self.stage_active != ('gateway',):
                self._require_stopped_frontier()
            elif self.stage_active == ('gateway',):
                import p2_prior_gateway as prior
                require(hasattr(self, 'pending_lineage') and prior._read_lineage() == self.pending_lineage and
                        GATEWAY_INTENT in self.stage_receipt_sha256,
                        'P2_PROFILED_INTERRUPTED_PENDING_GATEWAY_REQUIRED')
            require(self.stage_active is None or time.monotonic() < self.stage_deadline,
                    'P2_PROFILED_INTERRUPTED_STAGE_EXPIRED')
            grouped = self._inventory()
            active = set(self.stage_active or ())
            for service in runtime.SERVICES:
                ids = grouped[service]
                expected = self.new_metadata.get(service, self.old_metadata[service])
                if service in active:
                    require(len(ids) <= (1 if expected is None else 2),
                            'P2_PROFILED_INTERRUPTED_EXTRA_TRANSITION_REPLICA')
                    for identifier in ids:
                        value = self._inspect(identifier)
                        actual = self._validate_actual(value, service, healthy=False)
                        if expected is None:
                            require(actual['restartCount'] == 0,
                                    'P2_PROFILED_INTERRUPTED_ACTIVE_PROCESS_CHANGED')
                        else:
                            require(actual == expected or actual['containerId'] != expected['containerId'] and
                                    actual['restartCount'] == 0,
                                    'P2_PROFILED_INTERRUPTED_ACTIVE_PROCESS_CHANGED')
                else:
                    if expected is None:
                        require(service in self.source_missing and not ids and service not in self.new_metadata,
                                'P2_PROFILED_INTERRUPTED_MISSING_ACTIVE_PROCESS_CHANGED')
                        continue
                    require(len(ids) == 1 and (ids[0] == expected['containerId'] or
                            expected['containerId'].startswith(ids[0])), 'P2_PROFILED_INTERRUPTED_PROCESS_SET_CHANGED')
                    healthy = service in self.new_metadata
                    require(self._validate_actual(self._inspect(ids[0]), service, healthy=healthy) == expected,
                            'P2_PROFILED_INTERRUPTED_PROCESS_CHANGED')
            if self.finished:
                import p2_prior_gateway as prior
                actual = prior.observe_prior_gateway(
                    self.initial, self.selected, self.parent.verify, self.command,
                    expected_profile=self.expected_profile)
                require(actual == self.new_gateway and prior._closed_observed(actual) and prior._zero(actual),
                        'P2_PROFILED_INTERRUPTED_NEW_GATEWAY_CHANGED')

    def bind_snapshot(self, snapshot):
        with self.mutex:
            require(not self.snapshot_bound and snapshot == self.snapshot,
                    'P2_PROFILED_INTERRUPTED_EXACT_SNAPSHOT_REQUIRED')
            self.parent.require_configuration(snapshot)
            require(migrate.read_input(snapshot, 'compose.yaml') == self.compose_bytes,
                    'P2_PROFILED_INTERRUPTED_RENDERED_COMPOSE_CHANGED')
            self.snapshot_bound = True
            self.verify()

    def before_stage(self, stage):
        with self.mutex:
            self.verify()
            require(self.snapshot_bound and self.stage_active is None and
                    self.stage_index < len(runtime.STAGES) and tuple(stage) == runtime.STAGES[self.stage_index] and
                    not self.finished, 'P2_PROFILED_INTERRUPTED_FIXED_STAGE_ORDER_REQUIRED')
            self._cache_environment(self.snapshot)
            self.stage_active, self.stage_deadline = tuple(stage), time.monotonic() + 120
            self._retain('profiled-interrupted-stage-' + str(self.stage_index) + '-intent.json', {
                'status': 'P2_PROFILED_INTERRUPTED_STAGE_INTENT', 'stage': list(stage),
                'restorationActionId': self.action, 'candidateSha256': self.initial['candidateSha256'],
                'maximumSeconds': 120, 'authoritySha256': digest(canonical(self.record)),
            })
            if tuple(stage) == ('gateway',):
                import p2_prior_gateway as prior
                self._require_stopped_frontier()
                prior._remember(self.initial, self.stopped_gateway, 'replacement-in-progress',
                                expectedCandidateSha256=self.initial['candidateSha256'])
                self.pending_lineage = prior._read_lineage()
                require(self.pending_lineage == {
                    'protocol': prior.PROTOCOL, 'state': 'replacement-in-progress',
                    'actionId': self.action, 'candidateSha256': self.initial['candidateSha256'],
                    'process': self.stopped_gateway['process'], 'binding': self.stopped_gateway['binding'],
                    'expectedCandidateSha256': self.initial['candidateSha256'],
                }, 'P2_PROFILED_INTERRUPTED_PENDING_LINEAGE_REQUIRED')
                self._retain(GATEWAY_INTENT, {
                    'status': 'P2_PROFILED_INTERRUPTED_GATEWAY_REPLACEMENT_STARTED',
                    'restorationActionId': self.action,
                    'candidateSha256': self.initial['candidateSha256'],
                    'frontier': self.retained['frontier'],
                    'stoppedProcess': self.old_metadata['gateway'],
                    'pendingLineage': self.pending_lineage,
                })

    def after_stage(self, stage):
        with self.mutex:
            require(self.stage_active == tuple(stage) and time.monotonic() < self.stage_deadline,
                    'P2_PROFILED_INTERRUPTED_FINITE_STAGE_REQUIRED')
            grouped = self._inventory()
            observed = {}
            for service in stage:
                require(len(grouped[service]) == 1,
                        'P2_PROFILED_INTERRUPTED_EXACT_NEW_REPLICA_REQUIRED')
                value = self._inspect(grouped[service][0])
                self._validate_container(value, service, self.snapshot, healthy=True)
                actual = self._public_process(value)
                previous = self.old_metadata.get(service)
                require(actual['restartCount'] == 0 and
                        (previous is None or actual['containerId'] != previous['containerId']),
                        'P2_PROFILED_INTERRUPTED_DISTINCT_NEW_PROCESS_REQUIRED')
                self.new_metadata[service] = actual
                self.new_rows[service] = {'service': service, 'containerId': actual['containerId']}
                observed[service] = actual
            if tuple(stage) == ('gateway',):
                import p2_prior_gateway as prior
                require(prior._read_lineage() == self.pending_lineage,
                        'P2_PROFILED_INTERRUPTED_PENDING_LINEAGE_CHANGED')
                actual = prior.observe_prior_gateway(
                    self.initial, self.selected, self.parent.verify, self.command,
                    expected_profile=self.expected_profile)
                require(actual['process'] == observed['gateway'] and
                        actual['process']['containerId'] != self.stopped_gateway['process']['containerId'] and
                        actual['binding']['configurationDirectory'] == str(self.snapshot) and
                        prior._closed_observed(actual) and prior._zero(actual),
                        'P2_PROFILED_INTERRUPTED_NEW_GATEWAY_CLOSED_ZERO_REQUIRED')
                prior._remember(self.initial, actual)
                running = prior._read_lineage()
                require(running == {
                    'protocol': prior.PROTOCOL, 'state': 'running-observed',
                    'actionId': self.action, 'candidateSha256': self.initial['candidateSha256'],
                    'process': actual['process'], 'binding': actual['binding'],
                }, 'P2_PROFILED_INTERRUPTED_RUNNING_LINEAGE_REQUIRED')
                self.new_gateway, self.finished = actual, True
            index = self.stage_index
            self.stage_active, self.stage_deadline = None, None
            self.stage_index += 1
            self.verify()
            self._retain('profiled-interrupted-stage-' + str(index) + '-observed.json', {
                'status': 'P2_PROFILED_INTERRUPTED_STAGE_OBSERVED', 'stage': list(stage),
                'restorationActionId': self.action, 'newProcesses': observed,
            })


class ProfiledInterruptedKnownAckScope(P2ReleaseScope):
    """Typed view over the fresh certification scope; it owns no descriptor."""

    def __init__(self, parent, boundary):
        from p2_certification_parent import P2CertificationScope
        require(type(parent) is P2CertificationScope and
                type(boundary) is ProfiledInterruptedKnownAckBoundary and boundary in _BOUNDARIES and
                boundary.parent is parent, 'P2_PROFILED_INTERRUPTED_EXACT_TYPED_SCOPE_REQUIRED')
        self.parent, self.boundary = parent, boundary
        self.descriptor, self.path, self.identity = parent.descriptor, parent.path, parent.identity
        self.receipt, self.candidate_sha256 = copy.deepcopy(parent.receipt), parent.candidate_sha256
        self.release, self.jobs = copy.deepcopy(parent.release), copy.deepcopy(parent.jobs)
        self.configuration_sha256 = copy.deepcopy(parent.configuration_sha256)
        self.recovery_action_id = boundary.action
        self.expected_profile = boundary.expected_profile
        self.revoked, self.processes, self.mutations = parent.revoked, parent.processes, parent.mutations
        self.closed = False
        self.verify()

    def verify(self):
        self.parent.verify()
        self.boundary.verify()

    def require_release(self, release, jobs):
        self.parent.require_release(release, jobs)
        self.verify()

    def require_configuration(self, directory):
        self.parent.require_configuration(directory)
        self.verify()

    def require_frontend(self, release, info):
        value = self.parent.require_frontend(release, info)
        self.verify()
        return value

    def require_prior_gateway(self):
        self.verify()

    def initialize_runtime(self, snapshot, release):
        self.verify()
        require(snapshot == self.boundary.snapshot and release == self.release,
                'P2_PROFILED_INTERRUPTED_EXACT_RUNTIME_REQUIRED')
        self.boundary.bind_snapshot(snapshot)
        gateway = json.loads(migrate.read_input(snapshot, 'gateway.json'))
        require(gateway.get('admission') == {
            'file': '/admission/state.json', 'releaseId': release['releaseId'],
            'candidateSha256': self.candidate_sha256,
        }, 'P2_PROFILED_INTERRUPTED_NEW_ADMISSION_BINDING_REQUIRED')
        staging_admission.persist_state(
            snapshot, {'releaseId': release['releaseId'], 'candidateSha256': self.candidate_sha256},
            'p2-profiled-known-ack-restoration-' + self.recovery_action_id,
            new_work=False, recovery=False)

    def before_runtime_stage(self, stage):
        self.boundary.before_stage(stage)

    def after_runtime_stage(self, stage):
        self.boundary.after_stage(stage)

    def run(self, *args, **kwargs):
        self.verify()
        try:
            return self.parent.run(*args, **kwargs)
        finally:
            self.verify()

    def revoke(self):
        raise ValueError('P2_PROFILED_INTERRUPTED_PARENT_SCOPE_NOT_OWNED')

    def close(self):
        raise ValueError('P2_PROFILED_INTERRUPTED_PARENT_SCOPE_NOT_OWNED')


class ProfiledInterruptedKnownAckRuntime(P2RecoveryRuntime):
    """Five source-fixed runtime stages with fresh FE and API proof joins."""

    def __init__(self, scope):
        require(type(scope) is ProfiledInterruptedKnownAckScope and
                scope.boundary in _BOUNDARIES,
                'P2_PROFILED_INTERRUPTED_RUNTIME_SCOPE_REQUIRED')
        scope.verify()
        boundary = scope.boundary
        self.scope, self.selected, self.jobs = scope, boundary.selected, boundary.jobs
        self.release_pins = replacement_release_pins(scope.parent.certification_plan, scope.expected_profile)
        retained_pins = replacement_release_pins(boundary.retained['values']['recovery-intent.json']['intent'], scope.expected_profile)
        require(canonical(self.release_pins) == canonical(retained_pins),
                'P2_PROFILED_INTERRUPTED_RUNTIME_ORIGINAL_RELEASE_CHANGED')
        self.configuration, self.output = boundary.input_configuration, boundary.output
        self.compose_file, self.source = boundary.compose_file, Path(boundary.broker.source)
        self.snapshot = None
        self.api_before = None

    def _read_current_apis(self):
        outcome = self.scope.boundary.broker._read_api_current(self.output / 'current-api-before')
        self._require_api_outcome(outcome)
        self.api_before = copy.deepcopy(outcome)
        return copy.deepcopy(outcome['databases'])

    def _require_api_outcome(self, outcome):
        require(isinstance(outcome, dict) and outcome.get('version') == 2 and
                outcome.get('qualificationTargetProfile') == self.scope.expected_profile and
                outcome.get('status') == 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED' and
                outcome.get('phase') == 'completed' and
                outcome.get('releaseId') == self.selected['releaseId'] and
                outcome.get('candidateSha256') == self.scope.candidate_sha256 and
                set(outcome.get('databases', {})) == {'course', 'community'} and
                outcome.get('migrationsExecuted') is False and
                outcome.get('frontendSqlApplied') is False and
                outcome.get('trafficAuthorized') is False,
                'P2_PROFILED_INTERRUPTED_FRESH_API_PROOF_REQUIRED')

    def restore(self):
        boundary = self.scope.boundary
        with boundary.mutex:
            require(not getattr(boundary, 'runtime_attempted', False),
                    'P2_PROFILED_INTERRUPTED_RUNTIME_ALREADY_ATTEMPTED')
            boundary.runtime_attempted = True
        self.scope.parent.require_frontend(self.selected, self.jobs['frontend'])
        boundary.broker.reader.snapshot()
        boundary.broker.require_native_off()
        result = self._restore(expected_profile=self.scope.expected_profile)
        require(boundary.finished and boundary.stage_index == len(runtime.STAGES),
                'P2_PROFILED_INTERRUPTED_ALL_STAGES_REQUIRED')
        after = boundary.broker._read_api_current(self.output / 'current-api-after')
        self._require_api_outcome(after)
        require(after == self.api_before, 'P2_PROFILED_INTERRUPTED_API_PROOF_CHANGED')
        self.scope.parent.require_frontend(self.selected, self.jobs['frontend'])
        boundary.broker.reader.snapshot()
        boundary.broker.require_native_off()
        self.scope.verify()
        outcome = {
            **result,
            **migrate.contract_identity(self.selected),
            **_profile_fields(self.scope.expected_profile),
            **self.release_pins,
            'status': 'P2_PROFILED_INTERRUPTED_RUNTIME_RESTORED_FENCED',
            'restorationActionId': self.scope.recovery_action_id,
            'frontier': boundary.retained['frontier'],
            'stoppedGateway': {**boundary.stopped_gateway, 'process': boundary.old_metadata['gateway']},
            'newGateway': boundary.new_gateway,
            'currentApiDatabasesAfter': after['databases'],
            'frontendJournalSha256': self.scope.receipt['journalSha256'],
            'runtimeReplacements': 1,
            'sqlReplayed': False,
            'migrationsExecuted': False,
            'rolePreparationRepeated': False,
            'frontendSqlApplied': False,
            'nativeDisabled': True,
            'newWorkOpened': False,
            'recoveryOpened': False,
            'trafficAuthorized': False,
            'readinessReceiptSha256': digest(migrate.read_input(
                self.output, 'p2-recovery-runtime-ready.json')),
        }
        migrate.write_json(self.output, OUTCOME, outcome)
        return outcome


def prepare_profiled_interrupted_runtime(broker, authority, retained):
    """Consume the exact parent authority and return one fixed runtime."""
    from p2_profiled_known_ack_restoration_parent import (
        P2ProfiledInterruptedKnownAckBroker,
        consume_profiled_interrupted_runtime_authority,
    )

    require(type(broker) is P2ProfiledInterruptedKnownAckBroker,
            'P2_PROFILED_INTERRUPTED_SOURCE_BROKER_REQUIRED')
    record = consume_profiled_interrupted_runtime_authority(authority, broker)
    boundary = ProfiledInterruptedKnownAckBoundary(broker, record, retained)
    scope = ProfiledInterruptedKnownAckScope(broker.scope, boundary)
    return ProfiledInterruptedKnownAckRuntime(scope)
