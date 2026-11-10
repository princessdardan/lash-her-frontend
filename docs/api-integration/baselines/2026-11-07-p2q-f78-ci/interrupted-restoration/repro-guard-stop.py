"""Exact B retained writers + stop command + C physical inventory predicate.

Run on the frozen 72be frontend checkout with no live endpoints. Compose and
Docker inspection are modeled by the original owned tests. No authorization is
created and no replacement command is issued.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / 'ops/platform/host'))
import migrate
import p2_prior_gateway as prior
import p2_profiled_known_ack_runtime as current
import p2_known_ack_interrupted_restoration_test as retained_test

def run(frontier, stop_all):
    fixture = retained_test.ProfiledRetainedChainTests()
    fixture.setUp()
    try:
        b = fixture.fixture
        if frontier == 'replacement-stopped-zero':
            fixture.component.restore()
            # B's projected Docker command confirms the complete five-stage prior runtime.
            # Those are original B effects, never C replacement effects.
        b_replacements = sum('up' in command for command in b.calls)
        original_before = prior.capture_before_stop(
            {key: fixture.initial[key] for key in ('candidateSha256','configurationSha256','hostMachineId')}
            | {'certificationActionId': fixture.cert_id},
            fixture.selected, fixture.stop_dir, b.scope.verify, expected_profile=b.profile)
        stop_counts = []
        if stop_all:
            def stop_command(args, **_options):
                if args[1] == 'ps':
                    rows = [(service, row) for service, items in b.model.items() for row in items
                            if row['State']['Running']]
                    value = ''.join(row['Id'] + ' ' + service + '\n' for service,row in rows)
                elif args[1] == 'stop':
                    ids = set(args[4:])
                    for rows in b.model.values():
                        for row in rows:
                            if row['Id'] in ids:
                                row['State'].update(Running=False, Pid=0)
                    stop_counts.append(len(ids))
                    value = ''
                else:
                    raise AssertionError('Unexpected suspend command')
                return subprocess.CompletedProcess(args, 0, stdout=value, stderr='')
            migrate.suspend_runtime('staging', {}, _runner=stop_command)
        else:
            b.model['gateway'][0]['State'].update(Running=False, Pid=0)
        prior.retain_ordered_stop(original_before, fixture.stop_dir, b.scope.verify, expected_profile=b.profile)
        fixture.refresh_pins()
        retained = fixture.load()
        assert retained['frontier'] == frontier

        # Exercise actual starting-inventory method on the verified, source-shaped DTO.
        # Prepare only the exact hardware/read-only projections the constructor caches.
        boundary = object.__new__(current.ProfiledInterruptedKnownAckBoundary)
        boundary.retained = retained
        boundary.stopped_gateway = retained['stoppedGateway']
        boundary.old_configuration = retained['oldMountedDirectory']
        boundary.replacement_configuration = retained['replacementSnapshot']
        boundary._reading_starting_processes = True
        boundary.selected = fixture.selected
        boundary.expected_profile = b.profile
        boundary.parent = b.scope
        boundary.image_ids = {}
        boundary.expected_environments = {}
        boundary._cache_environment(boundary.old_configuration)
        if boundary.replacement_configuration.exists():
            boundary._cache_environment(boundary.replacement_configuration)
        def observe():
            try:
                rows = boundary._read_actual_starting_processes()
                assert len(rows) == 10
                return 'accepted'
            except ValueError as error:
                return str(error)
        outcome = observe()
        # Isolate the next independent predicate by applying only the correct
        # stopped projection to the diagnostic boundary, not to source bytes
        # or to the verified loader result.
        boundary.stopped_gateway = copy.deepcopy(retained['stoppedGateway'])
        boundary.stopped_gateway['process'].update(running=False, pid=0)
        after_gateway_projection = observe()
        assert sum('up' in command for command in b.calls) == b_replacements
        return {'frontier': frontier, 'sourceWholeRuntimeStopped': stop_all,
                'stoppedServices': sum(stop_counts), 'startingInventory': outcome,
                'cReplacementCommands': 0, 'afterDiagnosticGatewayProjection': after_gateway_projection}
    finally:
        fixture.doCleanups()

if __name__ == '__main__':
    results = [run(frontier, stop_all) for frontier in ('original-stopped-one', 'replacement-stopped-zero')
               for stop_all in (False,True)]
    for result in results:
        assert result['startingInventory'] == ('P2_KNOWN_ACK_RUNTIME_NOT_HEALTHY' if result['sourceWholeRuntimeStopped'] else 'P2_PROFILED_INTERRUPTED_STOPPED_GATEWAY_PROCESS_REQUIRED'), result
        assert result['afterDiagnosticGatewayProjection'] == ('P2_KNOWN_ACK_RUNTIME_NOT_HEALTHY' if result['sourceWholeRuntimeStopped'] else 'accepted'), result
    print(json.dumps({'version':1,'status':'CONFIRMED_SOURCE_COMPOSITION_REFUSAL','results':results,
                      'actualDocker':False,'providerTouched':False}))
