"""Typed post-SQL scope, retaining the inherited actual host flock and observer."""
import copy
import json
import re
from p2_release_scope import P2ReleaseScope
import migrate


class P2RecoveryScope(P2ReleaseScope):
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256, *, recovery_action_id, release, jobs, configuration_sha256):
        migrate.demand(isinstance(recovery_action_id, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', recovery_action_id)
                       and recovery_action_id != release['releaseId'], 'P2_DISTINCT_RECOVERY_ACTION_REQUIRED')
        self.recovery_action_id = recovery_action_id
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256,
                         release=release, jobs=jobs, configuration_sha256=configuration_sha256)
        self.require_frontend(release, jobs['frontend'])

    def require_frontend(self, release, info):
        self.verify()
        job, receipt = info['job'], self.receipt
        keys = ('environment', 'releaseId', 'sourceCommit', 'migrationImageDigest', 'sqlArtifactSha256',
                'schemaBaselineSha256', 'contractManifestSha256', 'contractPhase', 'phase2ContractManifestSha256')
        expected_target = {key: job['target'][key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}
        migrate.demand(release == self.release and info == self.jobs['frontend'] and
            release['environment'] == 'staging' and release.get('contractPhase') == 'p2' and
            all(receipt.get(key) == job.get(key) and receipt.get(key) is not None for key in keys) and
            receipt.get('status') == 'P2_RECOVERY_DATABASE_CURRENT' and receipt.get('migrationMode') == 'recovery-current-only' and
            receipt.get('recoveryActionId') == self.recovery_action_id and receipt.get('candidateSha256') == self.candidate_sha256 and
            receipt.get('service') == 'frontend' and receipt.get('target') == expected_target and
            receipt.get('schemaVerified') is True and receipt.get('runtimeRoleVerified') is True and
            receipt.get('oldLoginsDenied') is True and receipt.get('oldRoleSessions') == 0 and
            receipt.get('sqlReplayed') is False and receipt.get('originalFrontendTerminalRecreated') is False and
            receipt.get('trafficAuthorized') is False and receipt.get('failureCode') is None and
            isinstance(receipt.get('after'), list) and bool(receipt['after']) and
            isinstance(receipt.get('originalReceiptSha256'), dict), 'P2_FRESH_RECOVERY_DATABASE_PROOF_REQUIRED')
        return copy.deepcopy(receipt)

    def initialize_runtime(self,snapshot,release):
        import staging_admission
        self.verify()
        gateway=json.loads((snapshot/'gateway.json').read_bytes())
        migrate.demand(gateway.get('admission')=={'file':'/admission/state.json','releaseId':release['releaseId'],'candidateSha256':self.candidate_sha256},'P2_RECOVERY_GATEWAY_BINDING_REQUIRED')
        staging_admission.persist_state(snapshot,{'releaseId':release['releaseId'],'candidateSha256':self.candidate_sha256},
            'p2-recovery-'+self.recovery_action_id,new_work=False,recovery=False)
