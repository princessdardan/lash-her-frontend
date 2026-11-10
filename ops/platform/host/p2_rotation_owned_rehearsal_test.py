#!/usr/bin/env python3
"""Offline Linux child for managed rotation and successor-consumer rehearsals."""
from contextlib import ExitStack
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit


ROOT = Path('/var/lib/lash-her/releases/staging')
CREDENTIAL = 'FRONTEND_STAGING_MIGRATION_DATABASE_URL'
OBSERVER = 'ops/platform/p2-certification-current-probe.mjs'
CONTAINMENT_ENTRY = 'ops/platform/p2-frontend-live-probe.mjs'
CORE = 'ops/platform/p2-recovery-current-probe.mjs'
FLAGS = {'--profiled-replacement', '--profiled-replacement-rotation-writer-scope',
         '--profiled-replacement-rotation-guard-fence'}
INITIAL_MAXIMUM = 4_000_000
REAL_RUN = subprocess.run
ROTATION_PROBE = 'ops/platform/p2-identity-key-rotation.mjs'
DEPLOYMENTS = {
    'overlap': ('dpl_OwnedOverlap', 'https://owned-overlap.vercel.app'),
    'current-only': ('dpl_OwnedCurrentOnly', 'https://owned-current-only.vercel.app'),
}
OWNED_PRIVATE_PROBE = r'''
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { captureRotationTokens, observeCourseRotation, observeCommunityRotation } = await import(pathToFileURL(process.argv[1]));
const { input, environment } = JSON.parse(readFileSync(0, 'utf8'));
const prefix = input.profile.toUpperCase().replaceAll('-', '_');
const keys = [environment[`${prefix}_JWT_CURRENT_SECRET`], environment[`${prefix}_JWT_PREVIOUS_SECRET`]].filter(Boolean);
const authenticate = token => {
  const [header, payload, signature] = token.split('.');
  if (!keys.some(key => createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url') === signature)) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  return claims.sub === input.subject && claims.exp * 1000 > Date.now() ? claims : null;
};
let value;
if (input.mode === 'rotation-capture') {
  value = captureRotationTokens(input);
} else if (input.mode === 'rotation-course-http') {
  value = await observeCourseRotation(input, { ca: readFileSync(process.argv[2]), read(path, token) {
    const admin = input.profile === 'course-admin';
    if (path !== `/v1/${admin ? 'admin' : 'student'}/courses/${input.courseId}`) throw new Error('Owned path refused');
    const claims = authenticate(token);
    const status = !claims ? 401 : admin && !claims.capabilities?.includes('course-editor') ? 403 : 200;
    return { status, requestId: randomUUID(), observedAt: new Date().toISOString() };
  } });
} else {
  value = await observeCommunityRotation(input, { environment, loadVerifier: async () => ({
    configured: { env: environment, resolveCommunityUserRuntime: env => env },
    implementation: { createCommunityUserVerifier: () => ({
      verifyMember: authorization => authenticate(authorization.slice(7)),
      verifyAdmin(authorization) {
        const claims = authenticate(authorization.slice(7));
        return claims?.capabilities?.includes('community-moderator') ? claims : null;
      },
    }) },
  }) });
}
process.stdout.write(JSON.stringify(value));
'''


def demand(condition, code='P2_OWNED_REHEARSAL_INPUT_REFUSED'):
    if not condition:
        raise ValueError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class InitialReplay:
    def __init__(self, raw, rest):
        self.raw, self.rest = raw, rest

    def readline(self, size):
        if self.raw is None:
            return self.rest.readline(size)
        raw, self.raw = self.raw, None
        return raw[:size]


class OwnedPlatform:
    def __init__(self, initial, source, runtime, prior, observer_source, *, consumer):
        self.initial, self.source, self.runtime, self.prior = initial, source, runtime, prior
        self.observer_source = observer_source
        self.selected = initial['candidate']
        self.consumer = consumer
        self.custody = initial if consumer else initial['frontendCustody']
        self.plan = self.custody['certificationPlan']
        self.configuration = Path(initial['configuration'])
        rotation_action = self.plan['rotationSuccessor']['actionId'] if consumer else initial['rotationActionId']
        demand(re.fullmatch(r'p2-key-rotation-[a-z0-9-]{1,40}', rotation_action))
        self.action_directory = Path(initial['results']) / ('p2-identity-key-rotation-' + rotation_action)
        self.credential = initial['credentials'][CREDENTIAL]
        self.node = shutil.which('node')
        self.ca = Path(os.environ['NODE_EXTRA_CA_CERTS'])
        demand(self.node and self.ca.is_absolute() and self.ca.is_file())
        self.external_state = Path(initial['results']) / 'owned-rotation-platform-state.json'
        if consumer:
            demand(self.read_state() == {'runtime': 'current-only', 'frontend': 'current-only', 'stopped': False})
        else:
            self.write_state({'runtime': 'baseline', 'frontend': 'baseline', 'stopped': False}, initial=True)

    def write_state(self, state, *, initial=False):
        # Docker and Vercel are external to the broker in production. The
        # independently forked guard must see the same projected phase here.
        path = self.external_state if initial else self.external_state.with_suffix('.next')
        with path.open('x') as stream:
            json.dump(state, stream)
        path.chmod(0o600)
        if not initial:
            path.replace(self.external_state)

    def read_state(self):
        return json.loads(self.external_state.read_bytes())

    def update_state(self, **changes):
        self.write_state({**self.read_state(), **changes})

    @property
    def containers(self):
        phase = self.read_state()['runtime']
        return [{
            'service': service,
            'containerId': digest(('p2-owned-container:' + service +
                                   (':' + phase if phase != 'baseline' and service in ('course-api', 'community-api') else '')).encode()),
            'image': self.selected['artifacts'][self.runtime.IMAGE_KEYS[service]]['image'],
            'health': 'none' if service.endswith('-tls') else 'healthy',
        } for service in self.runtime.SERVICES]

    @property
    def gateway(self):
        return next(row for row in self.containers if row['service'] == 'gateway')

    @property
    def runtime_stopped(self):
        return self.read_state()['stopped']

    def deployment(self):
        phase = self.read_state()['frontend']
        native = self.plan['nativePlan']
        if phase == 'baseline':
            deployment_id, url, workload = (native[key] for key in ('deploymentId', 'deploymentUrl', 'configurationRecordSha256'))
        else:
            deployment_id, url = DEPLOYMENTS[phase]
            workload = digest((self.action_directory / f'frontend-{phase}' / 'frontend-workload-outcome.json').read_bytes())
        if self.consumer:
            demand(phase == 'current-only')
            successor = json.loads(base64.b64decode(self.initial['rotationSuccessorReceipt'], validate=True))
            configuration_sha = successor['configurationSha256']
        else:
            configuration_sha = self.initial['rotationPlan']['configuration'][phase]['sha256']
        return {'phase': phase, 'deploymentId': deployment_id, 'deploymentUrl': url,
                'sourceCommit': self.initial['sourceCommit'], 'workloadReceiptSha256': workload,
                'configurationSha256': configuration_sha}

    def write_frontend_ready(self, phase, previous):
        import migrate
        from p2_certification_parent import READY_FILES

        deployment_id, url = DEPLOYMENTS[phase]
        attempt = self.action_directory / f'frontend-{phase}'
        attempt.mkdir(mode=0o700)
        native = self.plan['nativePlan']
        base = {'version': 2, 'qualificationTargetProfile': self.initial['qualificationTargetProfile'],
                'environment': 'staging', 'projectId': native['projectId'], 'sourceCommit': native['sourceCommit'],
                'releaseId': self.selected['releaseId'], 'previousDeploymentId': previous['deploymentId']}
        closed = {'trafficAuthorized': False, 'promotionAuthorized': False}
        deployed = {'deploymentId': deployment_id}
        previous_alias = 1 if phase == 'overlap' else 2
        promoting = {**deployed, 'previousAliasRequestedAt': previous_alias}
        records = (
            closed,
            {**closed, **deployed},
            {**closed, **deployed, 'status': 'FRONTEND_STAGED', 'phase': 'completed', 'url': url, 'readyState': 'READY'},
            {**deployed, 'status': 'FRONTEND_VERIFIED', 'phase': 'completed', 'trafficAuthorized': False,
             'nativeSchedulerVerified': False, 'checks': ['frontend-server-gateway-course-catalog-p2'],
             **migrate.contract_identity(self.selected), 'featureControls': native['featureControls'],
             'writerAdmissionBinding': native['writerAdmissionBinding']},
            promoting,
            {**promoting, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed', 'trafficAuthorized': False,
             'gatewayTrafficAuthorized': False, 'frontendDomainsPromoted': True, 'aliasRequestedAt': previous_alias + 1},
        )
        for name, record in zip(READY_FILES, records, strict=True):
            migrate.write_json(attempt, name, {**base, **record})

    # This rehearsal starts at the rotation boundary. The predecessor rollout
    # and API migration bundle are projections. The actual frontend job and
    # baseline below are independently verified by the live PostgreSQL observer.
    def migration_bundle(self, bundle, *, expected_profile):
        demand(bundle == Path(self.initial['bundle']) and expected_profile == self.initial['qualificationTargetProfile'])
        candidate = (bundle / 'release.candidate.json').read_bytes()
        demand(digest(candidate) == self.initial['candidateSha256'] and json.loads(candidate) == self.selected)
        jobs = {}
        for name in ('course', 'community'):
            path = bundle / 'jobs' / f'{name}.json'
            if path.is_file():
                raw = path.read_bytes()
                schema = (bundle / 'schema' / f'{name}.json').read_bytes()
                job = json.loads(raw)
                demand(digest(raw) == self.custody['apiJobSha256'][name] and digest(schema) == job['schemaBaselineSha256'])
                jobs[name] = {'service': job['target']['service'], 'job': job, 'schema': schema,
                              'image': self.selected['artifacts'][name + 'Migration']['image']}
            else:
                demand(not self.consumer)
                jobs[name] = {'service': name}
        jobs['frontend'] = {'job': self.custody['frontendJob'], 'schema': json.dumps(self.custody['frontendBaseline']).encode(),
                            'frontend': True}
        return self.selected, jobs

    def api_job_hashes(self, bundle):
        demand(bundle == Path(self.initial['bundle']))
        if self.consumer:
            return {name: digest((bundle / 'jobs' / f'{name}.json').read_bytes()) for name in ('course', 'community')}
        return self.custody['apiJobSha256']

    def runtime_bundle(self, bundle, configuration, compose_file, *, expected_profile):
        demand(configuration == self.configuration and compose_file == self.source / 'ops/platform/compose.yaml')
        selected, jobs = self.migration_bundle(bundle, expected_profile=expected_profile)
        return selected, jobs, {'publicHost': self.initial.get('gatewayHost'), 'hostMachineId': self.initial['hostMachineId']}, compose_file.read_bytes()

    def predecessor_review(self, review, source):
        demand(review == self.custody and source == self.source and
               digest(base64.b64decode(review['originalReleaseReceipt'], validate=True)) == self.plan['originalReleaseReceiptSha256'])
        return {'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED',
                'originalReleasePlanHashHostVerified': True,
                'hostOriginalReleaseReceiptSha256': self.plan['originalReleaseReceiptSha256'],
                'planSha256': self.plan['planSha256'], 'replacementRelease': self.plan['replacementRelease'],
                'successorRuntime': self.plan.get('successorRuntime'),
                **dict.fromkeys(('executionEligible', 'providerTouched', 'admissionChanged', 'releaseAccepted'), False)}

    def predecessor_terminal(self, initial, plan, selected, results, expected, *, source):
        # The fixture starts after a projected original rollout. The caller
        # has already checked both READY sets and remapped to the predecessor.
        # Pin the retained raw predecessor files without inventing its SQL log.
        from p2_frontend_replacement_parent import private_record
        from p2_replacement_terminal import TERMINAL, exact_receipt

        demand(self.consumer and source == self.source and selected == self.selected and
               str(results) == self.initial['results'] and expected == self.initial['qualificationTargetProfile'] and
               initial['configuration'] == self.initial['configuration'])
        directory = results / ('p2-profiled-replacement-write-' + selected['releaseId'])
        raw = private_record(directory, TERMINAL)
        reviewed = private_record(directory, 'reviewed-plan.json')
        predecessor = exact_receipt(raw)
        hashes, native = plan['readyReceiptSha256'], plan['nativePlan']
        demand(base64.b64encode(raw).decode() == initial['originalReleaseReceipt'] and
               digest(raw) == plan['originalReleaseReceiptSha256'] and
               digest(reviewed) == plan['originalReleasePlanSha256'] == predecessor['reviewedPlanSha256'] and
               native['deploymentId'] == predecessor['deploymentId'] and
               hashes['frontend-workload-outcome.json'] == predecessor['frontendWorkloadReceiptSha256'] and
               hashes['frontend-promotion-outcome.json'] == predecessor['frontendPromotionReceiptSha256'])
        return digest(raw), True

    def runtime_flags(self, raw, environment, service, _jobs, *, expected_profile):
        from p2_certification_profile import RUNTIME_FLAGS

        demand(raw == (self.configuration / (service + '.env')).read_bytes() and environment == 'staging' and
               expected_profile == self.initial['qualificationTargetProfile'])
        if self.consumer and service == 'course-api':
            from p2_identity_key_rotation_adapter import _env

            values = _env(raw)
            demand(values.get('MUX_ENVIRONMENT_ID') == self.plan['scopedAction']['environmentId'])
            return values
        return RUNTIME_FLAGS[service]

    def gateway_reference(self, initial, selected, configuration, identity, *, expected_profile):
        demand(selected == self.selected and configuration == self.configuration and identity == self.gateway['containerId'] and
               expected_profile == self.initial['qualificationTargetProfile'] and initial['candidateSha256'] == self.initial['candidateSha256'])
        return {'releaseId': selected['releaseId'], 'candidateSha256': initial['candidateSha256'],
                'configurationDirectory': str(configuration)}

    def _observer(self, args, **kwargs):
        mount_prefix = 'type=bind,src='
        mounted = [args[i + 1] for i, option in enumerate(args[:-1]) if option == '--mount']
        flag = args[-1]
        containment = self.consumer and flag == '--profiled-replacement-guard-fence'
        entry = CONTAINMENT_ENTRY if containment else OBSERVER
        demand(len(mounted) == 2 and args[-4:] == ['node', self.selected['artifacts']['frontendMigration']['image'],
                                                  entry, flag] and (flag in FLAGS or containment) and
               kwargs.get('env', {}).get(CREDENTIAL) == self.credential and isinstance(kwargs.get('input'), str),
               'P2_OWNED_REHEARSAL_OBSERVER_SCOPE_REFUSED')
        for mount, filename, destination in zip(mounted, (OBSERVER, CORE), (entry, CORE), strict=True):
            suffix = f',dst=/app/{destination},readonly'
            demand(mount.startswith(mount_prefix) and mount.endswith(suffix) and
                   Path(mount[len(mount_prefix):-len(suffix)]).read_bytes() == (self.source / filename).read_bytes(),
                   'P2_OWNED_REHEARSAL_OBSERVER_BYTES_REFUSED')
        return REAL_RUN([self.node, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', str(self.observer_source / OBSERVER), flag],
                        **{**kwargs, 'env': {'PATH': os.environ['PATH'], 'NODE_EXTRA_CA_CERTS': str(self.ca),
                                             CREDENTIAL: self.credential}})

    def mounted_root(self, service):
        phase = self.read_state()['runtime']
        if phase != 'baseline' and service in ('course-api', 'community-api'):
            return self.action_directory / f'runtime-{phase}'
        return self.configuration

    def mounted_files(self, service):
        relative = {
            'gateway': {'/config/gateway.json': 'gateway.json', '/admission': 'admission', '/tls': 'tls/gateway'},
            'course-tls': {'/config/course-tls.json': 'course-tls.json', '/tls': 'tls/course'},
            'community-tls': {'/config/community-tls.json': 'community-tls.json', '/tls': 'tls/community'},
            'course-publisher': {'/tls/ca.pem': 'tls/ca.pem'},
            'community-worker': {'/tls/ca.pem': 'tls/ca.pem'},
            'community-api': {'/tls/ca.pem': 'tls/ca.pem'},
        }
        root = self.mounted_root(service)
        return [{'Destination': destination, 'Source': str(root / name), 'Type': 'bind', 'RW': False}
                for destination, name in relative.get(service, {}).items()]

    def inspect_container(self, identity, fields):
        import docker_inspect

        container = next(row for row in self.containers if row['containerId'] == identity)
        service, image = container['service'], container['image']
        running = 'false' if self.runtime_stopped else 'true'
        if fields == self.prior.PROCESS_FIELDS:
            demand(service == 'gateway')
            return '|'.join((image.split('@')[1], running, '0' if self.runtime_stopped else '4242',
                             '2026-01-01T00:00:00.000000000Z', '0', 'lash-her-staging', service))
        if fields == docker_inspect.RUNTIME_FIELDS:
            return '|'.join((image.split('@')[1], running, container['health'], 'lash-her-staging', service))
        if fields == '{{json .Mounts}}':
            return json.dumps(self.mounted_files(service))
        if fields == '{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}':
            return 'true|' + json.dumps(self.mounted_files(service))
        if fields == '{{.State.Pid}}|{{.State.StartedAt}}|{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}':
            pid = 4200 + self.runtime.SERVICES.index(service)
            return f'{pid}|2026-01-01T00:00:00.000000000Z|true|' + json.dumps(self.mounted_files(service))
        demand(fields == ('{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|'
                          '{{index .Config.Labels "com.docker.compose.project.config_files"}}'))
        root = self.mounted_root(service)
        return '|'.join((image, str(root), str(root / 'compose.yaml')))

    def inspect_gateway_fault(self, args):
        from p2_certification_fault import GATEWAY_OBSERVER, MODULE

        demand(args == ['docker', 'exec', '--workdir', '/app', self.gateway['containerId'], 'node',
                        '--input-type=module', '--eval', GATEWAY_OBSERVER])
        directory = (self.configuration / 'admission').lstat()
        admission = self.gateway_admission(self.configuration, {'releaseId': self.selected['releaseId'],
            'candidateSha256': self.initial['candidateSha256']}, lambda: None, None, None)['admission']
        return json.dumps({'version': 1, 'status': 'P2_FAULT_GATEWAY_CURRENT', 'processSha256': self.plan['gatewayProcessSha256'],
                           'gatewayConfigurationSha256': self.plan['gatewayConfigurationSha256'],
                           'faultModuleSha256': digest((self.source / MODULE).read_bytes()), 'faultLeasePresent': False,
                           'admissionDirectory': {'device': str(directory.st_dev), 'inode': str(directory.st_ino)},
                           'admission': {**admission, 'valid': True}})

    def api_current(self, args, payload):
        import migrate

        prefix, suffix = 'type=bind,src=', ',dst=/check/input,readonly'
        mount = args[args.index('--mount') + 1]
        demand(self.consumer and mount.startswith(prefix) and mount.endswith(suffix))
        directory = Path(mount[len(prefix):-len(suffix)])
        service = directory.name.removesuffix('-input')
        demand(service in ('course', 'community') and directory.name == service + '-input' and
               directory == directory.resolve() and ROOT in directory.parents and
               args[-5:] == [self.selected['artifacts'][service + 'Migration']['image'], '/check/input/current.mjs',
                             '--profiled-current', '/check/input/job.json', '/check/input/schema.json'] and
               json.loads(payload) == {'connectionUrl': self.initial['credentials'][service.upper() + '_STAGING_DATABASE_URL']})
        job_raw = (directory / 'job.json').read_bytes()
        job = json.loads(job_raw)
        target = job['target']
        checker = digest((directory / 'current.mjs').read_bytes())
        schema = digest((directory / 'schema.json').read_bytes())
        demand(checker == self.initial['sourceSha256']['ops/platform/host/database_current.mjs'] and
               schema == job['schemaBaselineSha256'] and digest(job_raw) == self.plan['apiJobSha256'][service])
        return {'version': 2, 'qualificationTargetProfile': self.initial['qualificationTargetProfile'],
                **migrate.contract_identity(self.selected), 'status': 'CURRENT_API_DATABASE_READ_ONLY_PASS',
                'environment': 'staging', 'migrationsExecuted': False, 'pendingTags': [], 'appliedCount': 1,
                'service': target['service'], 'checks': ['selected-image-operator-role-policy'],
                'transportVerifier': 'selected-image/hasVerifiedMigrationTransport', 'checkerSha256': checker,
                'manifestSha256': digest(job_raw), 'schemaBaselineSha256': schema, 'artifactSha256': target['artifactSha256'],
                'target': {key: target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}}

    def mux_query(self, args, payload):
        from p2_scoped_mux_readiness import _READY_QUERY, readiness_parameters

        action = self.plan['scopedAction']
        job = json.loads((Path(self.initial['bundle']) / 'jobs/course.json').read_bytes())
        target = job['target']
        demand(self.consumer and args[-4:] == [self.selected['artifacts']['courseMigration']['image'],
               '--input-type=module', '--eval', _READY_QUERY] and json.loads(payload) == {
                   'parameters': readiness_parameters(action), 'connectionUrl': self.initial['credentials']['COURSE_STAGING_DATABASE_URL'],
                   'target': target})
        return {'identity': {'user': target['user'], 'database': target['database'], 'server_version_num': target['serverMajor'] * 10000,
                             'read_only': 'on', 'search_path': 'pg_catalog'},
                'rows': [{**action, 'status': 'ready', 'isCurrent': True, 'managedByCourse': True}]}

    def run(self, args, **kwargs):
        demand(type(args) is list and args and args[0] == 'docker', 'P2_OWNED_REHEARSAL_DOCKER_COMMAND_REFUSED')
        if args[1] == 'run':
            if self.consumer and args[-4] == '/check/input/current.mjs':
                output = json.dumps(self.api_current(args, kwargs.get('input'))) + '\n'
            elif self.consumer and args[-3:-1] == ['--input-type=module', '--eval']:
                output = json.dumps(self.mux_query(args, kwargs.get('input'))) + '\n'
            else:
                return self._observer(args, **kwargs)
        elif args[:4] == ['docker', 'context', 'inspect', 'default']:
            output = 'unix:///var/run/docker.sock\n'
        elif args[1:3] == ['version', '--format']:
            output = 'linux/amd64\n'
        elif args[:3] == ['docker', 'container', 'ls']:
            if any(item.startswith('name=') for item in args):
                output = ''
            else:
                demand('label=com.docker.compose.project=lash-her-staging' in args)
                rows = [self.gateway] if 'label=com.docker.compose.service=gateway' in args else self.containers
                output = '\n'.join(row['containerId'] for row in rows) + '\n'
        elif args[:3] == ['docker', 'inspect', '--format']:
            demand(len(args) == 5)
            output = self.inspect_container(args[-1], args[-2]) + '\n'
        elif args[:7] == ['docker', 'image', 'inspect', '--platform', 'linux/amd64', '--format', '{{.Id}}']:
            demand(len(args) == 8 and args[-1] in {row['image'] for row in self.containers})
            output = args[-1].split('@')[1] + '\n'
        elif args[:2] == ['docker', 'compose']:
            snapshot = self.mounted_root('course-api')
            prefix = self.runtime.compose_command(snapshot, 'staging')
            demand(args[:-4] == prefix and args[-4:-1] == ['ps', '--all', '--quiet'])
            output = next(row['containerId'] for row in self.containers if row['service'] == args[-1]) + '\n'
        elif args[:2] == ['docker', 'exec']:
            output = self.inspect_gateway_fault(args) + '\n'
        elif args[:2] == ['docker', 'ps']:
            demand('label=com.docker.compose.project=lash-her-staging' in args)
            output = ('' if self.runtime_stopped else ''.join(f"{row['containerId']} {row['service']}\n" for row in self.containers))
        elif args[:3] == ['docker', 'stop', '--timeout']:
            demand(set(args[4:]) == {row['containerId'] for row in self.containers})
            self.update_state(stopped=True)
            output = ''
        else:
            demand(args[:3] == ['docker', 'rm', '--force'] and len(args) == 4 and args[3].startswith('lash-p2-'))
            output = ''
        return subprocess.CompletedProcess(args, 0, output, '')

    def certification_scope_run(self, scope, args, *, timeout, check=False, capture_output=False, text=False, input=None, **options):
        # The fixture supplies responses instead of creating Docker children.
        # Keep both physical-session checks around the same command boundary.
        scope.verify()
        result = self.run(args, timeout=timeout, check=check, capture_output=capture_output, text=text, input=input, **options)
        scope.verify()
        if not text:
            result.stdout, result.stderr = result.stdout.encode(), result.stderr.encode()
        return result

    def gateway_admission(self, configuration, binding, verify, _command, _assert_host):
        verify()
        demand(configuration == self.configuration and not self.runtime_stopped)
        raw = (configuration / 'admission' / 'state.json').read_bytes()
        state = json.loads(raw)
        demand(all(state[key] == binding[key] for key in ('releaseId', 'candidateSha256')) and
               state['newWork'] is False and state['recovery'] is False)
        zero = {'newWork': 0, 'recovery': 0}
        return {'admission': {'version': 1, 'sha256': digest(raw), 'newWork': False, 'recovery': False,
                              'active': zero, 'uncertain': zero}}

    def prearm_docker(self, initial, source, selected, expected, configuration, verify):
        verify()
        demand(initial['candidateSha256'] == self.initial['candidateSha256'] and source == self.source and
               selected == self.selected and expected == self.initial['qualificationTargetProfile'] and
               configuration == self.configuration and not self.runtime_stopped)
        self.prior.observe_prior_gateway(initial, selected, verify, expected_profile=expected)
        return self.containers, None, self.plan['gatewayProcessSha256']

    def vercel_request(self, method, path, body=None):
        import p2_canonical_browser_origin as canonical
        import vercel

        demand(method == 'GET' and body is None, 'P2_OWNED_REHEARSAL_VERCEL_COMMAND_REFUSED')
        native = self.plan['nativePlan']
        project = native['projectId']
        deployment = self.deployment()
        deployment_id, url = deployment['deploymentId'], deployment['deploymentUrl'].removeprefix('https://')
        if path in (f'/v9/projects/{project}', f'/v9/projects/{project}?rollbackInfo=true'):
            return {'id': project, 'accountId': vercel.TEAM, 'link': {'type': 'github', 'repoId': vercel.REPOSITORY_ID},
                    'targets': {'production': {'id': deployment_id}},
                    'crons': {'disabledAt': 1, 'deploymentId': deployment_id,
                              'definitions': [{**native['schedule'], 'host': url}]},
                    'protectionBypass': {'owned-fixture-bypass': {'scope': 'automation-bypass'}}}
        if path == f'/v13/deployments/{deployment_id}?withGitRepoInfo=true':
            return {'id': deployment_id, 'projectId': project, 'target': 'production', 'url': url, 'readyState': 'READY',
                    'gitSource': {'type': 'github', 'repoId': vercel.REPOSITORY_ID, 'sha': self.initial['sourceCommit']},
                    'meta': {'lashReleaseId': self.selected['releaseId']}}
        demand(path == f'/v4/aliases/{canonical.HOST}?projectId={project}', 'P2_OWNED_REHEARSAL_VERCEL_COMMAND_REFUSED')
        return {'alias': canonical.HOST, 'projectId': project, 'deploymentId': deployment_id,
                'deployment': {'id': deployment_id, 'url': url}}

    def workload_probe(self, origin, bearer, bypass, challenge, *, canonical_origin):
        import p2_canonical_browser_origin as canonical
        from qualification_target_profile import resolve_qualification_target_profile

        deployment_url = self.deployment()['deploymentUrl']
        demand(type(canonical_origin) is bool and (canonical_origin or self.consumer) and
               origin == (canonical.ORIGIN if canonical_origin else deployment_url) and bearer == self.initial['scopedCronSecret'] and
               bypass == 'owned-fixture-bypass' and re.fullmatch(r'[a-f0-9]{64}', challenge))
        native = self.plan['nativePlan']
        profile = resolve_qualification_target_profile(self.initial['qualificationTargetProfile'])
        result = {'version': 1, 'status': 'FRONTEND_WORKLOAD_PROBE_PASS', 'challenge': challenge, 'environment': 'staging',
                  'projectId': native['projectId'], 'sourceCommit': native['sourceCommit'], 'gatewayOrigin': profile['gateway']['publicOrigin'],
                  'checks': ['gateway-course-catalog-p2'], 'durationMs': 0, 'contractPhase': 'p2',
                  'featureControls': native['featureControls'], 'writerAdmissionBinding': native['writerAdmissionBinding']}
        if canonical_origin:
            result.update(authenticationOrigins=canonical.AUTHENTICATION_ORIGINS, deploymentUrl=deployment_url.removeprefix('https://'))
        return result

    def rotation_adapter(self, scope, selected, jobs, rotation_configuration, configuration, output, compose,
                         client, _gateway_host, source, _program_sha256):
        import migrate
        from p2_identity_key_rotation_adapter import (PHASES, P2IdentityRotationHostAdapter, RotationConfigurationSet,
                                                      _runtime_phase_hash)
        from staging_state import CONFIGURATION_FILES
        import vercel

        demand(selected == self.selected and source == self.source and configuration == self.configuration and
               compose == self.source / 'ops/platform/compose.yaml' and output.parent == Path(self.initial['results']) and
               jobs.keys() == {'frontend', 'course', 'community'} and
               rotation_configuration == Path(self.initial['rotationConfiguration']))
        adapter = P2IdentityRotationHostAdapter.__new__(P2IdentityRotationHostAdapter)
        adapter.scope, adapter.output = scope, output
        phase_directories = [(rotation_configuration / phase).is_dir() for phase in PHASES]
        full_configuration = all(phase_directories)
        if full_configuration:
            adapter.configurations = RotationConfigurationSet(rotation_configuration, scope.rotation_configuration_sha256,
                                                              scope.private_rotation_configuration_sha256)
        else:
            demand(not any(phase_directories))
            adapter.configurations = SimpleNamespace(hashes=scope.rotation_configuration_sha256,
                                                    directory=lambda phase: rotation_configuration / phase)

        def snapshot(phase):
            demand(full_configuration and phase in ('overlap', 'current-only'))
            reviewed = adapter.configurations.directory(phase)
            destination = output / f'runtime-{phase}'
            if not destination.exists():
                destination.mkdir(mode=0o700)
                for filename in (*CONFIGURATION_FILES, 'compose.yaml'):
                    target = destination / filename
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    raw = compose.read_bytes() if filename == 'compose.yaml' else migrate.read_input(reviewed, filename, 65_536)
                    migrate.write_exact_bytes(target.parent, target.name, raw)
            demand(_runtime_phase_hash(destination) == adapter.configurations.runtime_private_hashes[phase] and
                   migrate.read_input(destination, 'compose.yaml', 65_536) == compose.read_bytes())
            return destination

        def runtime_phase(phase):
            scope.verify()
            demand(phase == self.read_state()['runtime'] and not self.runtime_stopped)
            if full_configuration:
                if phase == 'baseline':
                    demand(_runtime_phase_hash(configuration) == adapter.configurations.runtime_private_hashes['baseline'])
                else:
                    snapshot(phase)
            return adapter.configurations.hashes[phase]

        def public_containers():
            return [{key: row[key] for key in ('service', 'containerId', 'image')} for row in self.containers]

        def recreate_apis(phase):
            demand(phase in ('overlap', 'current-only') and (phase == 'overlap' or full_configuration))
            runtime_phase('baseline' if phase == 'overlap' else 'overlap')
            demand(self.read_state()['frontend'] == ('baseline' if phase == 'overlap' else 'current-only'))
            if full_configuration:
                snapshot(phase)
            self.update_state(runtime=phase)

        def rollout_frontend(phase, feature_controls, writer_binding):
            scope.verify()
            demand(phase in ('overlap', 'current-only') and (phase == 'overlap' or full_configuration) and
                   self.read_state() == {'runtime': 'overlap', 'frontend': 'baseline' if phase == 'overlap' else 'overlap',
                                         'stopped': False} and
                   feature_controls == self.initial['expectedFeatureControls'] and writer_binding == self.initial['expectedWriterAdmissionBinding'])
            self.write_frontend_ready(phase, self.deployment())
            self.update_state(frontend=phase)

        def private_child(phase, service, payload):
            runtime_phase(phase)
            profile = payload['profile']
            if payload['mode'] == 'rotation-capture':
                demand(phase == 'overlap' and service == 'gateway')
            else:
                demand(service == ('gateway' if profile.startswith('course-') else 'community-api'))
            api_service = 'course-api' if profile.startswith('course-') else 'community-api'
            environment = adapter.configurations.api[phase][api_service]
            result = REAL_RUN([self.node, '--input-type=module', '--eval', OWNED_PRIVATE_PROBE,
                               str(source / ROTATION_PROBE), str(snapshot(phase) / 'tls/ca.pem')],
                              input=json.dumps({'input': payload, 'environment': environment}), capture_output=True,
                              text=True, env={'PATH': os.environ['PATH']}, timeout=15, check=False)
            demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout.encode()) <= 131_072,
                   'P2_OWNED_REHEARSAL_PRIVATE_PROBE_REFUSED')
            return json.loads(result.stdout)

        def frontend_deployment(phase):
            scope.verify()
            current = self.deployment()
            demand(current['phase'] == phase)
            return current

        def runtime_guard_containers(value):
            demand(value == public_containers())
            return self.containers

        def continuous(phase, containers):
            runtime_phase(phase)
            demand(containers == self.containers)

        def observe_frontend(phase):
            deployment = frontend_deployment(phase)
            state = vercel.promotion_state(client, self.initial['nativePlan']['projectId'])
            demand(state['productionDeploymentId'] == deployment['deploymentId'] and state['cronsEnabled'] is False and
                   state['aliasJob'] is None)
            return {'configurationSha256': deployment['configurationSha256'], 'deploymentId': deployment['deploymentId'],
                    'cronsEnabled': False, 'aliasJobActive': False}

        def closed(phase):
            runtime_phase(phase)
            self.gateway_admission(self.configuration, {'releaseId': self.selected['releaseId'],
                                                        'candidateSha256': self.initial['candidateSha256']}, scope.verify, None, None)
            observe_frontend(self.deployment()['phase'])
            return {'gatewayAdmissionClosed': True, 'gatewayActive': 0, 'gatewayUncertain': 0, 'nativeSchedulesEnabled': False}

        adapter.recreate_apis, adapter.rollout_frontend = recreate_apis, rollout_frontend
        adapter.frontend_deployment, adapter.observe_frontend_configuration = frontend_deployment, observe_frontend
        adapter._snapshot, adapter._private_child = snapshot, private_child
        adapter.observe_api_configuration = lambda phase: {'configurationSha256': runtime_phase(phase),
                                                           'containers': self.containers, 'runtimeVerified': True}
        adapter.observe_runtime_boundary = lambda phase: {'configurationSha256': runtime_phase(phase), 'containers': public_containers(),
            'nativeSchedulesEnabled': False, 'businessSchedulesEnabled': False, 'courseCurrent': True, 'communityCurrent': True,
            'boundaryChecks': sorted(self.runtime.PROBE_CHECKS)}
        adapter.runtime_guard_containers, adapter.observe_continuous_runtime = runtime_guard_containers, continuous
        adapter.observe_closed_gateway_and_native = closed
        return adapter


def main():
    demand(sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').is_file() and
           len(sys.argv) == 3 and sys.argv[1] in ('--supervisor', '--consumer'), 'P2_OWNED_REHEARSAL_ISOLATION_REQUIRED')
    consumer = sys.argv[1] == '--consumer'
    interfaces = {name for _, name in socket.if_nameindex()}
    demand('lo' in interfaces and all(not int((Path('/sys/class/net') / name / 'flags').read_text(), 16) & 1
                                       for name in interfaces - {'lo'}) and
           not Path('/proc/net/route').read_text().splitlines()[1:] and
           all(row.split()[-1] == 'lo' for row in Path('/proc/net/ipv6_route').read_text().splitlines()),
           'P2_OWNED_REHEARSAL_ISOLATION_REQUIRED')
    source = Path(sys.argv[2])
    demand(re.fullmatch(r'/opt/lash-her/operators/[a-f0-9]{40}', str(source)) and source == source.resolve())
    sys.path.insert(0, str(source / 'ops/platform/host'))
    sys.dont_write_bytecode = True
    import migrate
    import p2_certification_parent as certification
    import p2_identity_key_rotation_parent as rotation
    import p2_prior_gateway as prior
    import p2_replacement_successor as replacement
    import release as runtime
    from qualification_target_profile import decode_qualification_target_json

    raw = sys.stdin.buffer.readline(INITIAL_MAXIMUM + 1)
    demand(0 < len(raw) <= INITIAL_MAXIMUM and raw.endswith(b'\n'))
    initial = decode_qualification_target_json(raw, 'private-packet')
    demand(type(initial) is dict and initial.get('sourceCommit') == source.name and initial.get('version') == 2)
    if consumer:
        plan = initial['certificationPlan']
        demand(initial.get('mode') == certification.PROFILED_CERTIFICATION_MODE and plan.get('mode') == 'mux-readiness' and
               plan.get('initialEpoch') == '7' and 'rotationSuccessor' in plan and
               plan['scopedAction']['environmentId'] == 'owned-mux-environment')
    else:
        demand(initial.get('mode') == 'p2-identity-key-rotation')
    for key in ('configuration', 'results', 'bundle') + (() if consumer else ('rotationConfiguration',)):
        path = Path(initial[key])
        demand(ROOT in path.parents and path == path.resolve())
    credential = urlsplit(initial['credentials'][CREDENTIAL])
    demand(credential.scheme in ('postgres', 'postgresql') and credential.hostname in ('localhost', '127.0.0.1'))
    observer_source = Path(os.environ.get('P2_ROTATION_OWNED_NODE_SOURCE', str(source))).resolve()
    for filename in (OBSERVER, CORE):
        demand((observer_source / filename).read_bytes() == (source / filename).read_bytes())
    platform = OwnedPlatform(initial, source, runtime, prior, observer_source, consumer=consumer)
    with ExitStack() as patches:
        patches.enter_context(patch.object(rotation.vercel, 'Client', lambda _token: SimpleNamespace(request=platform.vercel_request)))
        patches.enter_context(patch.object(rotation.day_two_workload, '_WorkloadProbe',
                                           lambda: SimpleNamespace(request=platform.workload_probe)))
        patches.enter_context(patch.object(prior.frontend_gateway_observation, 'observe', platform.gateway_admission))
        patches.enter_context(patch.object(prior, '_reference', platform.gateway_reference))
        patches.enter_context(patch.object(migrate, 'make_plan', platform.migration_bundle))
        patches.enter_context(patch.object(migrate, 'profiled_current_job_hashes', platform.api_job_hashes))
        patches.enter_context(patch.object(runtime, 'make_plan', platform.runtime_bundle))
        patches.enter_context(patch.object(runtime, 'environment_values', platform.runtime_flags))
        # Only the projected staging runtime's architecture is fixed to amd64.
        patches.enter_context(patch.object(runtime, 'platform', SimpleNamespace(machine=lambda: 'x86_64')))
        if consumer:
            def run_scoped(scope, *args, **kwargs):
                return platform.certification_scope_run(scope, *args, **kwargs)

            patches.enter_context(patch.object(certification, '_profiled_replacement_original_terminal', platform.predecessor_terminal))
            patches.enter_context(patch.object(certification.P2CertificationScope, 'run', run_scoped))
        else:
            patches.enter_context(patch.object(rotation, 'P2IdentityRotationHostAdapter', platform.rotation_adapter))
            patches.enter_context(patch.object(replacement, '_observe', platform.prearm_docker))
            patches.enter_context(patch.object(certification, 'prepare_profiled_current_certification_input', platform.predecessor_review))
        patches.enter_context(patch.object(subprocess, 'run', platform.run))
        patches.enter_context(patch.object(sys, 'stdin', SimpleNamespace(buffer=InitialReplay(raw, sys.stdin.buffer))))
        patches.enter_context(patch.object(sys, 'argv', [sys.argv[0], '--supervisor-profiled-current' if consumer else '--supervisor']))
        observed_exceptions = set()

        def trace_error(frame, event, value):
            filename = frame.f_code.co_filename
            if event == 'exception' and (filename.startswith(str(source)) or consumer and filename == __file__):
                kind, error, _ = value
                code = str(error)
                if re.fullmatch(r'[A-Z][A-Z0-9_]{4,100}', code):
                    print(code, Path(filename).name, frame.f_lineno, file=sys.stderr)
                elif consumer and kind in (AssertionError, AttributeError, subprocess.CalledProcessError, FileNotFoundError,
                                           IndexError, KeyError, NameError, StopIteration, TypeError, ValueError):
                    location = kind, Path(filename).name, frame.f_lineno
                    if location not in observed_exceptions and len(observed_exceptions) < 12:
                        observed_exceptions.add(location)
                        print('P2_OWNED_REHEARSAL_EXCEPTION_' + kind.__name__.upper(), *location[1:], file=sys.stderr)
            return trace_error

        threading.settrace(trace_error)
        sys.settrace(trace_error)
        try:
            (certification if consumer else rotation).main()
        finally:
            sys.settrace(None)
            threading.settrace(None)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        # Keep diagnostic values bounded and never print a packet or subprocess input.
        code = str(error)
        print(code if re.fullmatch(r'P2_[A-Z0-9_]+', code) else type(error).__name__, file=sys.stderr)
        raise SystemExit(1) from None
