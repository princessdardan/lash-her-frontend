"""Restore the exact10-service P2 runtime after read-only current API proofs.

No migration/role preparation API is reachable here. The inherited typed scope
registers every child; its independent supervisor revokes/reaps on process loss.
"""
import json
import os
from pathlib import Path
from uuid import uuid4
import migrate
import release as runtime
import staging_state
from p2_recovery_scope import P2RecoveryScope


class P2RecoveryRuntime:
    def __init__(self, scope, selected, jobs, configuration, output, compose_file, source):
        migrate.demand(type(scope) is P2RecoveryScope, 'P2_ACTUAL_RECOVERY_SCOPE_REQUIRED')
        self.scope, self.selected, self.jobs = scope, selected, jobs
        self.configuration, self.output, self.compose_file, self.source = map(Path, (configuration, output, compose_file, source))
        self.snapshot = None

    def command(self, args, env, timeout=30, *, input=None):
        return self.scope.run(args, env=env, input=input, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()

    def verify_api_current(self, name, directory):
        migrate.demand(name in ('course', 'community'), 'P2_RECOVERY_API_SCOPE_REQUIRED')
        info = self.jobs[name]
        external, internal = migrate.credential_names(name, 'staging')
        credential = os.environ.get(external)
        migrate.demand(isinstance(credential, str) and credential, 'P2_RECOVERY_NAMED_API_CREDENTIAL_REQUIRED')
        program = self.source / 'ops/platform/p2-recovery-api-current-probe.mjs'
        payload = {'version': 1, 'service': info['service'], 'job': info['job'], 'schemaBytes': info['schema'].decode(),
                   'candidateSha256': self.scope.candidate_sha256, 'recoveryActionId': self.scope.recovery_action_id}
        container = 'lash-p2-recovery-current-' + name + '-' + uuid4().hex
        args = ['docker', 'run', '--rm', '--name', container, '--interactive', '--network', 'host', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '64', '--env', internal,
                '--mount', f'type=bind,src={program},dst=/app/p2-recovery-api-current-probe.mjs,readonly',
                '--entrypoint', 'node', info['image'], '/app/p2-recovery-api-current-probe.mjs']
        try:
            raw = self.command(args, {**runtime.SAFE_ENV, internal: credential}, 60, input=json.dumps(payload))
            migrate.demand(len(raw) <= 16384, 'P2_RECOVERY_API_RECEIPT_BOUNDS')
            proof = json.loads(raw)
            keys = ('environment', 'releaseId', 'sourceCommit', 'migrationImageDigest', 'runtimeImageDigest', 'schemaBaselineSha256', 'contractSha256')
            migrate.demand(proof.get('status') == 'P2_RECOVERY_API_DATABASE_CURRENT' and proof.get('service') == info['service'] and
                all(proof.get(key) == info['job'].get(key) for key in keys) and proof.get('candidateSha256') == self.scope.candidate_sha256 and
                proof.get('recoveryActionId') == self.scope.recovery_action_id and proof.get('readOnlyVerified') is True and
                proof.get('schemaVerified') is True and proof.get('runtimeRoleVerified') is True and proof.get('pendingTags') == [] and
                proof.get('sqlReplayed') is False, 'P2_RECOVERY_CURRENT_API_REQUIRED')
            migrate.require_contract_identity(self.selected,proof)
            migrate.write_json(directory, name + '-current-database.json', proof)
            return proof
        finally:
            # Scope.run registers all commands, including cleanup. On revocation
            # the independent supervisor owns final container cleanup/stopping.
            self.scope.run(['docker','rm','--force',container],env=runtime.SAFE_ENV,timeout=30,check=False,capture_output=True,text=True)
            migrate.demand(not self.command(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + container + '$', '--format', '{{.ID}}'], runtime.SAFE_ENV, 15), 'P2_RECOVERY_API_CONTAINER_CLEANUP_UNVERIFIED')

    def restore(self):
        self.scope.require_release(self.selected, self.jobs)
        self.scope.require_configuration(self.configuration)
        self.scope.require_frontend(self.selected, self.jobs['frontend'])
        migrate.private_directory(self.output)
        verified = {name: self.verify_api_current(name, self.output) for name in ('course', 'community')}
        self.scope.verify()
        snapshot = self.output / 'configuration'
        compose = migrate.read_input(self.compose_file.parent, self.compose_file.name)
        migrate.demand(self.selected['runtime']['composeSha256'] == 'sha256:' + migrate.file_hash(compose), 'P2_RECOVERY_COMPOSE_CHANGED')
        runtime.snapshot_configuration(self.configuration, snapshot, self.selected, self.jobs, compose)
        self.snapshot = snapshot
        self.scope.initialize_runtime(snapshot, self.selected)
        prefix, env = runtime.compose_command(snapshot, 'staging'), runtime.runtime_environment(self.selected, snapshot)
        # Source-selected preflight must remain under the same registered runner.
        token = runtime._command_scope.set(self.scope)
        try:
            runtime.preflight(self.selected, snapshot, self.jobs)
            for stage in runtime.STAGES:
                self.scope.require_configuration(self.configuration)
                self.command([*prefix, 'up', '--detach', '--no-deps', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '90', *stage], env, 120)
            probe = json.loads(self.command([*prefix, 'exec', '-T', 'gateway', 'node', 'release-probe.mjs'], env, 30))
            migrate.demand(probe.get('status') == 'API_RUNTIME_BOUNDARIES_PASS' and set(probe.get('checks', [])) == runtime.PROBE_CHECKS, 'P2_RECOVERY_RUNTIME_BOUNDARIES_REQUIRED')
            containers = runtime.check_containers(self.selected, snapshot)
            migrate.demand(len(containers) == 10 and {item['service'] for item in containers} == set(runtime.SERVICES), 'P2_RECOVERY_TEN_SERVICES_REQUIRED')
        finally:
            runtime._command_scope.reset(token)
        self.scope.verify()
        outcome = {'status': 'P2_RECOVERY_API_RUNTIME_READY', 'environment': 'staging', 'releaseId': self.selected['releaseId'],
                   'recoveryActionId': self.scope.recovery_action_id, 'candidateSha256': self.scope.candidate_sha256,
                   'apiDatabases': verified, 'containers': containers, 'boundaryChecks': probe['checks'],
                   'sqlReplayed': False, 'rolePreparationRepeated': False, 'trafficAuthorized': False}
        migrate.write_json(self.output, 'p2-recovery-runtime-ready.json', outcome)
        return outcome
