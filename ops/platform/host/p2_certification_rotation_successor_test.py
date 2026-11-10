"""Exercise certification readback against the actual guardian receipt producer."""
import base64
from contextlib import ExitStack
import shutil
import unittest
from unittest.mock import patch

import migrate
import p2_certification_rotation_successor as consumer
import p2_identity_rotation_successor_test as guardian_fixture
from p2_identity_key_rotation_parent import JOINED_RECEIPT, SESSION_CLOSED_RECEIPT
from p2_release_supervisor import ROTATION_LAYOUT
from p2_replacement_terminal import TERMINAL_STATUS


class RotationSuccessorCertificationTest(unittest.TestCase):
    def setUp(self):
        fixture = guardian_fixture.SuccessorTest()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        fixture.results.chmod(0o700)
        self.fixture = fixture
        evidence_root = patch.object(consumer.evidence, 'ROOT', fixture.root)
        evidence_root.start()
        self.addCleanup(evidence_root.stop)
        scope = {'version': 1, 'qualificationTargetProfile': fixture.profile, 'environment': 'staging',
                 'releaseId': fixture.selected_release, 'sourceCommit': fixture.plan['sourceCommit'],
                 'candidateSha256': fixture.plan['candidateSha256']}
        original = fixture.custody_directory
        reviewed = self.rewrite(original / 'reviewed-plan.json', {
            **scope, 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED', 'replacement': {'managedCatalog': {'id': 'owned'}}})
        reviewed_hash = migrate.file_hash(reviewed)
        original_terminal = self.rewrite(original / consumer.rotation.REPLACEMENT_TERMINAL, {
            **scope, 'version': 2, 'status': TERMINAL_STATUS, 'frontendSqlApplied': True,
            'frontendSqlReplayed': False, 'frontendSessionClosed': True, 'trafficAuthorized': False, 'releaseAccepted': False,
            'targetSha256': fixture.review['targetSha256'], 'configurationSha256': fixture.initial['configurationSha256'],
            'reviewedPlanSha256': reviewed_hash})
        descriptor = {'version': 1, 'kind': 'frontend-replacement', 'qualificationTargetProfile': fixture.profile,
                      'reviewedPlanSha256': reviewed_hash, 'runtimeReviewSha256': '1' * 64, 'postflightSha256': '2' * 64,
                      'frontendSessionClosedSha256': '3' * 64, 'frontendDatabaseReceiptSha256': '4' * 64,
                      'databaseOid': '20001', 'migrationRoleOid': '20002', 'predecessorRuntimeRole': 'owned_prior',
                      'administrativeLogins': []}
        fixture.review.update(replacementRelease=descriptor, originalReleasePlanSha256=reviewed_hash,
                              originalReleaseReceiptSha256=migrate.file_hash(original_terminal))
        encoded_original = base64.b64encode(original_terminal).decode('ascii')
        fixture.initial.update(originalReleaseReceipt=encoded_original)
        fixture.initial['frontendCustody'].update(originalReleaseReceipt=encoded_original)
        fixture.closed.update(version=2)
        closed = self.rewrite(fixture.directory / SESSION_CLOSED_RECEIPT, fixture.closed)
        fixture.terminal.update(version=2, qualificationTargetProfile=fixture.profile, environment='staging', frontendFinalEpoch='22',
                                frontendSessionCloseReceiptSha256=migrate.file_hash(closed))
        fixture.committed = migrate.file_hash(self.rewrite(fixture.directory / JOINED_RECEIPT, fixture.terminal))
        self.rewrite(fixture.directory / ROTATION_LAYOUT['terminalName'], fixture.terminal)
        self.receipt = fixture.run_join()
        self.path = fixture.directory / consumer.rotation.RECEIPT
        raw = self.path.read_bytes()
        self.plan = {**fixture.review, 'certificationActionId': 'owned-certification', 'environment': 'staging', 'initialEpoch': '23',
                     'configurationCanonicalSha256': migrate.file_hash(consumer.rotation._canonical(fixture.initial['configurationSha256'])),
                     'rotationSuccessor': {'kind': consumer.KIND, 'actionId': fixture.action,
                                           'bindingSha256': fixture.plan['bindingSha256'], 'receiptSha256': migrate.file_hash(raw)},
                     'runtimeInventorySha256': self.receipt['runtimeInventorySha256'], 'readyReceiptSha256': fixture.ready_hashes,
                     'nativePlan': {'deploymentId': fixture.deployment, 'deploymentUrl': fixture.deployment_url,
                                    'configurationRecordSha256': fixture.ready_hashes['frontend-workload-outcome.json']}}
        self.initial = {**fixture.initial['frontendCustody'], 'certificationActionId': self.plan['certificationActionId'],
                        'certificationPlan': self.plan, 'targetSha256': self.plan['targetSha256'],
                        'rotationSuccessorReceipt': base64.b64encode(raw).decode('ascii'),
                        'readyReceipts': {name: base64.b64encode((fixture.ready / name).read_bytes()).decode('ascii')
                                          for name in fixture.ready_hashes}}

    @staticmethod
    def rewrite(path, value):
        path.unlink()
        migrate.write_json(path.parent, path.name, value)
        return path.read_bytes()

    def read(self):
        fixture = self.fixture
        return consumer.require_rotation_successor_runtime(self.initial, self.plan, fixture.selected,
                                                          fixture.results, fixture.source, fixture.profile)

    def test_rejoins_guardian_bytes_and_exact_current_frontend_ready(self):
        fixture = self.fixture
        selection = self.read()
        self.assertEqual(selection.predecessor_configuration, fixture.original)
        self.assertEqual(selection.current_only_configuration, fixture.current)
        self.assertEqual(selection.current_only_configuration_sha256, self.receipt['currentOnlyRuntimeConfigurationSha256'])
        self.assertEqual(selection.frontend, self.receipt['frontend'])
        self.assertEqual(selection.inventory, fixture.inventories['current-only'])
        self.assertEqual(selection.frontend_epoch, '22')
        self.plan['initialEpoch'] = '21'
        with self.assertRaisesRegex(ValueError, consumer.REFUSED):
            self.read()
        self.plan['initialEpoch'] = '22'
        self.initial['readyReceipts']['frontend-build-started.json'] = 'e30K'
        with self.assertRaisesRegex(ValueError, consumer.REFUSED):
            self.read()

    def test_refuses_changed_successor_original_or_inventory_receipt_bytes(self):
        fixture = self.fixture
        paths = (self.path, fixture.custody_directory / consumer.rotation.REPLACEMENT_TERMINAL,
                 fixture.directory / 'host-runtime-current-only-inventory.json')
        for path in paths:
            with self.subTest(path=path.name):
                raw = path.read_bytes()
                path.write_bytes(raw + b'\n')
                with self.assertRaises(ValueError):
                    self.read()
                path.write_bytes(raw)

    def test_refuses_current_phase_byte_drift_and_noncanonical_mount(self):
        fixture = self.fixture
        path = fixture.current / 'course-api.env'
        raw = path.read_bytes()
        path.write_bytes(raw + b'\n')
        with self.assertRaisesRegex(ValueError, consumer.REFUSED):
            self.read()
        path.write_bytes(raw)
        moved = fixture.directory / 'relocated-current'
        fixture.current.rename(moved)
        fixture.current.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.read()

    def test_historical_predecessor_must_match_guardian_hash_and_derived_mount(self):
        fixture = self.fixture
        prior = fixture.results / 'owned-historical' / 'configuration'
        shutil.copytree(fixture.original, prior)
        prior.chmod(0o700)
        historical = {'kind': 'known-ack', 'actionId': 'owned-prior', 'runtimeActionId': 'owned-prior-runtime',
                      'receiptSha256': '6' * 64}
        raw = self.rewrite(self.path, self.receipt | {'predecessorSuccessorReceiptSha256': historical['receiptSha256']})
        self.initial['rotationSuccessorReceipt'] = base64.b64encode(raw).decode('ascii')
        self.plan['rotationSuccessor']['receiptSha256'] = migrate.file_hash(raw)
        with self.assertRaisesRegex(ValueError, consumer.REFUSED):
            self.read()
        self.plan['rotationSuccessor']['predecessorRuntime'] = historical
        with patch.object(consumer.replacement, 'require_successor_runtime_provenance', return_value=(prior, '16')) as previous:
            with self.assertRaisesRegex(ValueError, consumer.REFUSED):
                self.read()
            self.initial['configuration'] = str(prior)
            self.assertEqual(self.read().predecessor_configuration, prior)
            self.assertEqual(previous.call_args.args[1]['runtimeInventorySha256'], self.receipt['predecessorRuntimeInventorySha256'])
            self.assertEqual(previous.call_args.args[1]['successorRuntime'], historical)
            historical['receiptSha256'] = '8' * 64
            with self.assertRaisesRegex(ValueError, consumer.REFUSED):
                self.read()

    def test_fresh_mixed_observation_uses_held_callback_and_refuses_mount_or_admission_drift(self):
        fixture = self.fixture
        selection = self.read()
        for drift in (None, 'labels', 'mount', 'uncertain'):
            with self.subTest(drift=drift), ExitStack() as stack:
                fixture.mock_readbacks(stack, changed=drift)
                checks = []
                verify = lambda: checks.append('held')
                if drift is None:
                    consumer.observe_rotation_successor_runtime(self.initial, fixture.source, selection, verify)
                    self.assertGreater(len(checks), 2)
                else:
                    with self.assertRaises(ValueError):
                        consumer.observe_rotation_successor_runtime(self.initial, fixture.source, selection, verify)

    def test_fresh_observation_refuses_drift_after_docker_read(self):
        fixture = self.fixture
        selection = self.read()

        def drift(*_arguments, verify_lock):
            verify_lock()
            (fixture.current / 'course-api.env').write_text('changed\n')

        with patch.object(consumer.rotation, '_observe_mixed_runtime', side_effect=drift), self.assertRaises(ValueError):
            consumer.observe_rotation_successor_runtime(self.initial, fixture.source, selection, lambda: None)


if __name__ == '__main__':
    unittest.main()
