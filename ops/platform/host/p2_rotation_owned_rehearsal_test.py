#!/usr/bin/env python3
"""Offline Linux child for the managed rotation ARM/disconnect rehearsal."""
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
CORE = 'ops/platform/p2-recovery-current-probe.mjs'
FLAGS = {'--profiled-replacement', '--profiled-replacement-rotation-writer-scope',
         '--profiled-replacement-rotation-guard-fence'}
INITIAL_MAXIMUM = 4_000_000
REAL_RUN = subprocess.run


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
    def __init__(self, initial, source, runtime, prior, observer_source):
        self.initial, self.source, self.runtime, self.prior = initial, source, runtime, prior
        self.observer_source = observer_source
        self.selected = initial['candidate']
        self.custody = initial['frontendCustody']
        self.plan = self.custody['certificationPlan']
        self.configuration = Path(initial['configuration'])
        self.containers = [{
            'service': service, 'containerId': digest(('p2-owned-container:' + service).encode()),
            'image': self.selected['artifacts'][runtime.IMAGE_KEYS[service]]['image'],
            'health': 'none' if service.endswith('-tls') else 'healthy',
        } for service in runtime.SERVICES]
        self.gateway = next(row for row in self.containers if row['service'] == 'gateway')
        self.credential = initial['credentials'][CREDENTIAL]
        self.node = shutil.which('node')
        self.ca = Path(os.environ['NODE_EXTRA_CA_CERTS'])
        self.runtime_stopped = False
        demand(self.node and self.ca.is_absolute() and self.ca.is_file())

    # This rehearsal starts at the rotation boundary. The predecessor rollout
    # and API migration bundle are projections. The actual frontend job and
    # baseline below are independently verified by the live PostgreSQL observer.
    def migration_bundle(self, bundle, *, expected_profile):
        demand(bundle == Path(self.initial['bundle']) and expected_profile == self.initial['qualificationTargetProfile'])
        candidate = (bundle / 'release.candidate.json').read_bytes()
        demand(digest(candidate) == self.initial['candidateSha256'] and json.loads(candidate) == self.selected)
        jobs = {service: {'service': service} for service in ('course', 'community')}
        jobs['frontend'] = {'job': self.custody['frontendJob'], 'schema': json.dumps(self.custody['frontendBaseline']).encode(),
                            'frontend': True}
        return self.selected, jobs

    def api_job_hashes(self, bundle):
        demand(bundle == Path(self.initial['bundle']))
        return self.custody['apiJobSha256']

    def runtime_bundle(self, bundle, configuration, compose_file, *, expected_profile):
        demand(configuration == self.configuration and compose_file == self.source / 'ops/platform/compose.yaml')
        selected, jobs = self.migration_bundle(bundle, expected_profile=expected_profile)
        return selected, jobs, {'publicHost': self.initial['gatewayHost'], 'hostMachineId': self.initial['hostMachineId']}, compose_file.read_bytes()

    def predecessor_review(self, review, source):
        demand(review == self.custody and source == self.source and
               digest(base64.b64decode(review['originalReleaseReceipt'], validate=True)) == self.plan['originalReleaseReceiptSha256'])
        return {'status': 'P2_PROFILED_CURRENT_CERTIFICATION_INPUT_VERIFIED',
                'originalReleasePlanHashHostVerified': True,
                'hostOriginalReleaseReceiptSha256': self.plan['originalReleaseReceiptSha256'],
                'planSha256': self.plan['planSha256'], 'replacementRelease': self.plan['replacementRelease'],
                'successorRuntime': self.plan.get('successorRuntime'),
                **dict.fromkeys(('executionEligible', 'providerTouched', 'admissionChanged', 'releaseAccepted'), False)}

    def runtime_flags(self, raw, environment, service, _jobs, *, expected_profile):
        from p2_certification_profile import RUNTIME_FLAGS

        demand(raw == (self.configuration / (service + '.env')).read_bytes() and environment == 'staging' and
               expected_profile == self.initial['qualificationTargetProfile'])
        return RUNTIME_FLAGS[service]

    def gateway_reference(self, initial, selected, configuration, identity, *, expected_profile):
        demand(selected == self.selected and configuration == self.configuration and identity == self.gateway['containerId'] and
               expected_profile == self.initial['qualificationTargetProfile'] and initial['candidateSha256'] == self.initial['candidateSha256'])
        return {'releaseId': selected['releaseId'], 'candidateSha256': initial['candidateSha256'],
                'configurationDirectory': str(configuration)}

    def _observer(self, args, **kwargs):
        mount_prefix = 'type=bind,src='
        mounted = [args[i + 1] for i, option in enumerate(args[:-1]) if option == '--mount']
        demand(len(mounted) == 2 and args[-4:] == ['node', self.selected['artifacts']['frontendMigration']['image'],
                                                  OBSERVER, args[-1]] and args[-1] in FLAGS and
               kwargs.get('env', {}).get(CREDENTIAL) == self.credential and isinstance(kwargs.get('input'), str),
               'P2_OWNED_REHEARSAL_OBSERVER_SCOPE_REFUSED')
        for mount, filename in zip(mounted, (OBSERVER, CORE)):
            suffix = f',dst=/app/{filename},readonly'
            demand(mount.startswith(mount_prefix) and mount.endswith(suffix) and
                   Path(mount[len(mount_prefix):-len(suffix)]).read_bytes() == (self.source / filename).read_bytes(),
                   'P2_OWNED_REHEARSAL_OBSERVER_BYTES_REFUSED')
        return REAL_RUN([self.node, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', str(self.observer_source / OBSERVER), args[-1]],
                        **{**kwargs, 'env': {'PATH': os.environ['PATH'], 'NODE_EXTRA_CA_CERTS': str(self.ca),
                                             CREDENTIAL: self.credential}})

    def run(self, args, **kwargs):
        demand(type(args) is list and args and args[0] == 'docker', 'P2_OWNED_REHEARSAL_DOCKER_COMMAND_REFUSED')
        if args[1] == 'run':
            return self._observer(args, **kwargs)
        if args[:4] == ['docker', 'context', 'inspect', 'default']:
            output = 'unix:///var/run/docker.sock\n'
        elif args[1:3] == ['version', '--format']:
            output = 'linux/amd64\n'
        elif args[:3] == ['docker', 'container', 'ls']:
            if any(item.startswith('name=') for item in args):
                output = ''
            else:
                demand('label=com.docker.compose.project=lash-her-staging' in args and
                       'label=com.docker.compose.service=gateway' in args)
                output = self.gateway['containerId'] + '\n'
        elif args[:3] == ['docker', 'inspect', '--format']:
            demand(args[-1] == self.gateway['containerId'])
            if args[-2] == self.prior.PROCESS_FIELDS:
                image = self.gateway['image'].split('@')[1]
                output = '|'.join((image, 'false' if self.runtime_stopped else 'true',
                                   '0' if self.runtime_stopped else '4242', '2026-01-01T00:00:00.000000000Z',
                                   '0', 'lash-her-staging', 'gateway')) + '\n'
            else:
                demand(args[-2] == '{{json .Mounts}}')
                output = json.dumps([{'Destination': destination, 'Source': str(self.configuration / relative),
                                      'Type': 'bind', 'RW': False} for destination, relative in
                                     (('/config/gateway.json', 'gateway.json'), ('/admission', 'admission'))]) + '\n'
        elif args[:2] == ['docker', 'ps']:
            demand('label=com.docker.compose.project=lash-her-staging' in args)
            output = ('' if self.runtime_stopped else ''.join(f"{row['containerId']} {row['service']}\n" for row in self.containers))
        elif args[:3] == ['docker', 'stop', '--timeout']:
            demand(set(args[4:]) == {row['containerId'] for row in self.containers})
            self.runtime_stopped, output = True, ''
        else:
            demand(args[:3] == ['docker', 'rm', '--force'] and len(args) == 4 and args[3].startswith('lash-p2-'))
            output = ''
        return subprocess.CompletedProcess(args, 0, output, '')

    def gateway_admission(self, configuration, binding, verify, _command, _assert_host):
        verify()
        demand(configuration == self.configuration and not self.runtime_stopped)
        raw = (configuration / 'admission' / 'state.json').read_bytes()
        state = json.loads(raw)
        demand(all(state[key] == binding[key] for key in ('releaseId', 'candidateSha256')) and
               state['newWork'] is False and state['recovery'] is False)
        zero = {'newWork': 0, 'recovery': 0}
        return {'admission': {'sha256': digest(raw), 'newWork': False, 'recovery': False,
                              'active': zero, 'uncertain': zero}}

    def prearm_docker(self, initial, source, selected, expected, configuration, verify):
        verify()
        demand(initial['candidateSha256'] == self.initial['candidateSha256'] and source == self.source and
               selected == self.selected and expected == self.initial['qualificationTargetProfile'] and
               configuration == self.configuration and not self.runtime_stopped)
        self.prior.observe_prior_gateway(initial, selected, verify, expected_profile=expected)
        return self.containers, None, self.plan['gatewayProcessSha256']

    def canonical_origin(self, context, client, _bearer, *, expected_profile):
        client.verify()
        demand(context['candidate'] == self.selected and context['plan'] == self.initial['nativePlan'] and
               expected_profile == self.initial['qualificationTargetProfile'])
        return {'browserOrigin': 'https://staging.lashher.com', 'deploymentId': context['plan']['deploymentId']}

    def rotation_adapter(self, scope, selected, jobs, rotation_configuration, configuration, output, compose,
                         _client, _gateway_host, source, _program_sha256):
        demand(selected == self.selected and source == self.source and configuration == self.configuration and
               compose == self.source / 'ops/platform/compose.yaml' and output.parent == Path(self.initial['results']) and
               jobs.keys() == {'frontend', 'course', 'community'} and
               rotation_configuration == Path(self.initial['rotationConfiguration']))
        public = [{key: row[key] for key in ('service', 'containerId', 'image')} for row in self.containers]

        def baseline(phase):
            scope.verify()
            demand(phase == 'baseline' and not self.runtime_stopped)
            return scope.rotation_configuration_sha256[phase]

        def runtime_guard_containers(value):
            demand(value == public)
            return self.containers

        def continuous(phase, containers):
            baseline(phase)
            demand(containers == self.containers)

        def closed(phase):
            baseline(phase)
            return {'gatewayAdmissionClosed': True, 'gatewayActive': 0, 'gatewayUncertain': 0, 'nativeSchedulesEnabled': False}

        return SimpleNamespace(observe_runtime_boundary=lambda phase: {'configurationSha256': baseline(phase), 'containers': public},
                               runtime_guard_containers=runtime_guard_containers, observe_continuous_runtime=continuous,
                               observe_closed_gateway_and_native=closed,
                               observe_frontend_configuration=lambda phase: {'configurationSha256': baseline(phase),
                                   'deploymentId': self.initial['nativePlan']['deploymentId']})


def main():
    demand(sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').is_file() and
           len(sys.argv) == 3 and sys.argv[1] == '--supervisor', 'P2_OWNED_REHEARSAL_ISOLATION_REQUIRED')
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
    for key in ('configuration', 'results', 'bundle', 'rotationConfiguration'):
        path = Path(initial[key])
        demand(ROOT in path.parents and path == path.resolve())
    credential = urlsplit(initial['credentials'][CREDENTIAL])
    demand(credential.scheme in ('postgres', 'postgresql') and credential.hostname in ('localhost', '127.0.0.1'))
    observer_source = Path(os.environ.get('P2_ROTATION_OWNED_NODE_SOURCE', str(source))).resolve()
    for filename in (OBSERVER, CORE):
        demand((observer_source / filename).read_bytes() == (source / filename).read_bytes())
    platform = OwnedPlatform(initial, source, runtime, prior, observer_source)
    with ExitStack() as patches:
        patches.enter_context(patch.object(rotation, 'LIVE_ELIGIBLE', True))
        patches.enter_context(patch.object(rotation, 'P2IdentityRotationHostAdapter', platform.rotation_adapter))
        patches.enter_context(patch.object(rotation.day_two_workload, 'observe_browser_origin', platform.canonical_origin))
        patches.enter_context(patch.object(replacement, '_observe', platform.prearm_docker))
        patches.enter_context(patch.object(prior.frontend_gateway_observation, 'observe', platform.gateway_admission))
        patches.enter_context(patch.object(prior, '_reference', platform.gateway_reference))
        patches.enter_context(patch.object(migrate, 'make_plan', platform.migration_bundle))
        patches.enter_context(patch.object(migrate, 'profiled_current_job_hashes', platform.api_job_hashes))
        patches.enter_context(patch.object(runtime, 'make_plan', platform.runtime_bundle))
        patches.enter_context(patch.object(runtime, 'environment_values', platform.runtime_flags))
        # Only the projected staging runtime's architecture is fixed to amd64.
        patches.enter_context(patch.object(runtime, 'platform', SimpleNamespace(machine=lambda: 'x86_64')))
        patches.enter_context(patch.object(certification, 'prepare_profiled_current_certification_input', platform.predecessor_review))
        patches.enter_context(patch.object(subprocess, 'run', platform.run))
        patches.enter_context(patch.object(sys, 'stdin', SimpleNamespace(buffer=InitialReplay(raw, sys.stdin.buffer))))
        patches.enter_context(patch.object(sys, 'argv', [sys.argv[0], '--supervisor']))
        def trace_error(frame, event, value):
            if event == 'exception' and frame.f_code.co_filename.startswith(str(source)):
                code = str(value[1])
                if re.fullmatch(r'[A-Z][A-Z0-9_]{4,100}', code):
                    print(code, Path(frame.f_code.co_filename).name, frame.f_lineno, file=sys.stderr)
            return trace_error

        threading.settrace(trace_error)
        sys.settrace(trace_error)
        try:
            rotation.main()
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
