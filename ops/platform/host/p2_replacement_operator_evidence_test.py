import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import migrate
import p2_replacement_operator_evidence as evidence


class ReplacementOperatorEvidenceTest(unittest.TestCase):
    def test_reads_only_original_receipts_for_bound_action(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            results = root / 'results'
            results.mkdir(mode=0o700)
            release_id = 'owned-replacement'
            action = results / ('p2-profiled-replacement-write-' + release_id)
            action.mkdir(mode=0o700)
            runtime = results / ('runtime-profiled-frontend-replacement-' + release_id)
            runtime.mkdir(mode=0o700)
            identity = {'version': 1, 'qualificationTargetProfile': evidence.PROFILE, 'environment': 'staging',
                        'releaseId': release_id, 'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64}
            migrate.write_json(action, 'reviewed-plan.json', {**identity, 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED'})
            plan_sha = migrate.file_hash((action / 'reviewed-plan.json').read_bytes())
            request = {**identity, 'reviewedPlanSha256': plan_sha, 'results': str(results)}
            terminal = 'p2-frontend-replacement-write-outcome.json'
            raw = b'{ "owned" : true }\n'
            migrate.write_exact_bytes(action, terminal, raw)
            close_prepared = 'p2-frontend-replacement-close-prepared.json'
            migrate.write_exact_bytes(action, close_prepared, raw)
            migrate.write_exact_bytes(runtime, 'runtime-outcome.json', raw)
            migrate.write_exact_bytes(action, 'frontend-role-credentials.json', b'{}\n')
            with patch.object(evidence, 'ROOT', root):
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': terminal}), raw)
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': close_prepared}), raw)
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': 'runtime-outcome.json'}), raw)
                for changed in ({'reviewedPlanSha256': 'f' * 64}, {'candidateSha256': 'f' * 64},
                                {'name': 'frontend-role-credentials.json'}, {'name': '../' + terminal}):
                    with self.subTest(changed=changed), self.assertRaises(ValueError):
                        evidence.read_replacement_evidence({**request, 'name': terminal, **changed})
                (action / terminal).unlink()
                (action / terminal).symlink_to(runtime / 'runtime-outcome.json')
                with self.assertRaises(ValueError):
                    evidence.read_replacement_evidence({**request, 'name': terminal})

    def successor_fixture(self, kind):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        results = root / 'results'
        results.mkdir(mode=0o700)
        scope = {'qualificationTargetProfile': evidence.PROFILE, 'environment': 'staging', 'releaseId': 'owned-replacement',
                 'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64}
        original = results / ('p2-profiled-replacement-write-' + scope['releaseId'])
        original.mkdir(mode=0o700)
        migrate.write_json(original, 'reviewed-plan.json', {'version': 1, **scope, 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED'})
        plan_sha = migrate.file_hash((original / 'reviewed-plan.json').read_bytes())
        descriptor = {'version': 1, 'kind': 'frontend-replacement', 'qualificationTargetProfile': evidence.PROFILE,
                      'reviewedPlanSha256': plan_sha, 'runtimeReviewSha256': '1' * 64, 'postflightSha256': '2' * 64,
                      'frontendSessionClosedSha256': '3' * 64, 'frontendDatabaseReceiptSha256': '4' * 64,
                      'databaseOid': '20001', 'migrationRoleOid': '20002', 'predecessorRuntimeRole': 'owned_predecessor',
                      'administrativeLogins': [{'name': 'owned_admin', 'oid': '20003'}]}
        configuration = {'runtime.json': 'c' * 64, 'gateway.json': 'd' * 64}
        target = 'e' * 64
        terminal = {'version': 2, **scope, 'status': 'P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION',
                    **{key: value for key, value in descriptor.items() if key.endswith('Sha256')},
                    'targetSha256': target, 'configurationSha256': configuration, 'frontendSessionClosed': True,
                    'frontendSqlApplied': True, 'frontendSqlReplayed': False, 'trafficAuthorized': False, 'releaseAccepted': False}
        original_terminal = original / 'p2-frontend-replacement-write-outcome.json'
        migrate.write_json(original, original_terminal.name, terminal)
        pins = {'originalReleasePlanSha256': plan_sha,
                'originalReleaseReceiptSha256': migrate.file_hash(original_terminal.read_bytes())}
        action_id = 'owned-certification' if kind == 'known-ack' else 'owned-restoration'
        directory = results / (evidence.SUCCESSOR_PREFIXES[kind] + action_id)
        directory.mkdir(mode=0o700)
        receipt = {'version': 2, **scope, **pins, 'status': evidence.SUCCESSOR_STATUS, 'kind': kind, 'actionId': action_id,
                   'runtimeActionId': 'owned-recovery' if kind == 'known-ack' else action_id, 'hostMachineId': 'f' * 32,
                   'replacementRelease': descriptor, 'targetSha256': target, 'frontendEpoch': '12',
                   'configurationCanonicalSha256': migrate.file_hash(json.dumps(configuration, sort_keys=True,
                       separators=(',', ':')).encode()), 'terminalSha256': '5' * 64,
                   'runtimeReceiptSha256': ('6' if kind == 'known-ack' else '5') * 64, 'frontendSessionClosedSha256': '7' * 64,
                   'runtimeInventorySha256': '8' * 64, 'gatewayProcessSha256': '9' * 64}
        request = {'version': 1, **scope, **pins, 'results': str(results), 'operation': evidence.SUCCESSOR_OPERATION,
                   'kind': kind, 'actionId': action_id}
        return root, directory, original_terminal, request, receipt

    def test_successor_requests_preserve_original_guardian_bytes(self):
        for kind in evidence.SUCCESSOR_PREFIXES:
            with self.subTest(kind=kind):
                root, directory, _, request, receipt = self.successor_fixture(kind)
                raw = (json.dumps(receipt, indent=2) + '\n').encode()
                migrate.write_exact_bytes(directory, evidence.SUCCESSOR_RECEIPT, raw)
                with patch.object(evidence, 'ROOT', root):
                    self.assertEqual(evidence.read_replacement_evidence(request), raw)

    def test_successor_requests_refuse_wrong_operation_binding_or_original_receipt(self):
        root, directory, original_terminal, request, receipt = self.successor_fixture('known-ack')
        migrate.write_json(directory, evidence.SUCCESSOR_RECEIPT, receipt)
        with patch.object(evidence, 'ROOT', root):
            for changed in ({'name': evidence.SUCCESSOR_RECEIPT}, {'operation': 'read-file'}, {'results': str(root)},
                            {'kind': 'other'}, {'actionId': '../' + request['actionId']}, {'candidateSha256': 'f' * 64},
                            {'sourceCommit': 'f' * 40}, {'originalReleaseReceiptSha256': 'f' * 64},
                            {'originalReleasePlanSha256': 'f' * 64}):
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    evidence.read_replacement_evidence({**request, **changed})
            raw = original_terminal.read_bytes()
            original_terminal.write_bytes(raw.replace(b'"frontendSqlApplied": true', b'"frontendSqlApplied": false'))
            with self.assertRaises(ValueError):
                evidence.read_replacement_evidence(request)

    def test_successor_requests_refuse_unbound_or_nonprivate_guardian_receipt(self):
        root, directory, _, request, receipt = self.successor_fixture('interrupted-known-ack')
        path = directory / evidence.SUCCESSOR_RECEIPT
        with patch.object(evidence, 'ROOT', root):
            for changed in ({'status': 'P2_REPLACEMENT_SUCCESSOR_RUNTIME_PREPARED'}, {'actionId': 'another-action'},
                            {'sourceCommit': 'f' * 40}, {'runtimeActionId': 'different-action'},
                            {'configurationCanonicalSha256': 'f' * 64}, {'runtimeReceiptSha256': 'f' * 64},
                            {'unexpected': True}, {'replacementRelease': {**receipt['replacementRelease'], 'postflightSha256': 'f' * 64}}):
                migrate.write_json(directory, path.name, {**receipt, **changed})
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    evidence.read_replacement_evidence(request)
                path.unlink()
            migrate.write_json(directory, path.name, receipt)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                evidence.read_replacement_evidence(request)
            path.rename(directory / 'other.json')
            path.symlink_to(directory / 'other.json')
            with self.assertRaises(ValueError):
                evidence.read_replacement_evidence(request)


if __name__ == '__main__':
    unittest.main()
