import fcntl
import json
import os
import sys
import threading
import unittest
from unittest.mock import patch

import migrate
import p2_certification_parent as certification
import p2_frontend_replacement_parent as replacement
import p2_release_supervisor as supervisor
import p2_replacement_terminal as terminal
import p2_replacement_terminal_test as terminal_fixture


class ReplacementCertificationTests(unittest.TestCase):
    def setUp(self):
        terminal_fixture.ReplacementTerminalTests.setUp(self)
        self.cert_plan = {'environment': 'staging', 'sourceCommit': self.commit, 'targetSha256': self.target_sha,
                          'candidateSha256': self.plan['candidateSha256'], 'originalReleaseId': self.release_id,
                          'certificationActionId': 'owned-certification', 'mode': 'contain-native', 'initialEpoch': '1',
                          'nativePlan': {'deploymentId': self.deployment, 'owner': self.owner,
                                         'producer': {'producerSha256': self.producer, 'role': self.runtime},
                                         'target': {**self.database['target'], 'qualificationTargetProfile': replacement.PROFILE}},
                          'originalReleasePlanSha256': self.initial['reviewedPlanSha256'],
                          'readyReceiptSha256': {name: migrate.file_hash(raw) for name, raw in zip(terminal.PROVIDER_FILES[1:], self.provider_raw[1:])},
                          'replacementRelease': {'version': 1, 'kind': 'frontend-replacement',
                            'qualificationTargetProfile': replacement.PROFILE, 'reviewedPlanSha256': self.initial['reviewedPlanSha256'],
                            'runtimeReviewSha256': self.initial['runtimeReviewSha256'], 'postflightSha256': migrate.file_hash(self.written_raw),
                            'frontendSessionClosedSha256': migrate.file_hash(self.closed_raw),
                            'frontendDatabaseReceiptSha256': migrate.file_hash(self.database_raw),
                            'databaseOid': self.probe['databaseOid'], 'migrationRoleOid': self.probe['migrationRoleOid'],
                            'predecessorRuntimeRole': self.probe['predecessorTarget']['runtimeRole'], 'administrativeLogins': self.admins}}
        self.descriptor = self.cert_plan['replacementRelease']
        self.cert_initial = {**{key: self.initial[key] for key in ('hostMachineId', 'bundle', 'results', 'candidateSha256')},
                             'environment': 'staging', 'qualificationTargetProfile': replacement.PROFILE,
                             'configuration': str(self.snapshot), 'configurationSha256': self.review['configurationSha256'],
                             'apiJobSha256': self.review['apiJobSha256'], 'certification': self.review['certification'],
                             'owner': self.owner, 'targetSha256': self.target_sha, 'candidate': self.candidate,
                             'mode': certification.PROFILED_CERTIFICATION_MODE, 'sourceCommit': self.commit,
                             'certificationActionId': self.cert_plan['certificationActionId'], 'certificationPlan': self.cert_plan,
                             'inventory': {'replacementRelease': self.descriptor, 'producers': [self.cert_plan['nativePlan']['producer']]},
                             '_guardLayout': supervisor.PROFILED_CERTIFICATION_LAYOUT,
                             'frontendJob': self.job, 'frontendBaseline': self.baseline}
        self.cert_plan['planSha256'] = certification._profiled_plan_hash(self.cert_plan)
        self.install_original_receipts()

    def provider_fixture(self):
        terminal_fixture.ReplacementTerminalTests.provider_fixture(self)

    def install_original_receipts(self):
        migrate.write_exact_bytes(self.write_directory, 'reviewed-plan.json', self.plan_raw)
        with (patch.object(supervisor, 'verify_guard_boundary'), patch.object(replacement, 'observe', return_value=self.raw_observation)):
            replacement.verify_and_retain(self.initial, self.plan, self.probe_base, self.image, self.write_directory,
                                          self.root, self.probe, threading.Event())
            arm_sha = migrate.file_hash((self.write_directory / replacement.ARM).read_bytes())
            replacement.verify_and_retain_write_custody(self.initial, self.plan, self.probe_base, self.image,
                self.write_directory, self.root, self.probe, {'armReceiptSha256': arm_sha,
                'emptyCatalogReceipt': self.empty_boundary}, threading.Event())
        for name, stage in ((replacement.WRITTEN_OBSERVER_STARTED, 'WRITTEN_STARTED'),
                            (replacement.WRITTEN_OBSERVER_RETURNED, 'WRITTEN_RETURNED'),
                            (replacement.CLOSED_OBSERVER_STARTED, 'CLOSED_STARTED'),
                            (replacement.CLOSED_OBSERVER_RETURNED, 'CLOSED_RETURNED')):
            migrate.write_json(self.write_directory, name, replacement.write_observer_receipt(
                self.initial, self.probe, self.raw_observation, stage))
        for name, raw in zip((*terminal.PROVIDER_FILES, *terminal.NODE_FILES, terminal.SESSION_CLOSED),
                             (*self.provider_raw, *self.node_raw, self.closed_raw)):
            migrate.write_exact_bytes(self.write_directory, name, raw)
        outcome = terminal.join_terminal(self.base, self.packet, self.provider_raw, self.node_raw, self.closed_raw,
                                        status=terminal.TERMINAL_STATUS)
        migrate.write_json(self.write_directory, terminal.INTENT, {**outcome, 'status': terminal.INTENT_STATUS})
        migrate.write_json(self.write_directory, terminal.TERMINAL, outcome)
        raw = (self.write_directory / terminal.TERMINAL).read_bytes()
        self.cert_plan['originalReleaseReceiptSha256'] = migrate.file_hash(raw)
        self.cert_initial['originalReleaseReceipt'] = terminal_fixture.base64_bytes(raw)

    def original(self):
        return certification._profiled_original_terminal(self.cert_initial, self.cert_plan, self.candidate,
                                                         self.results, replacement.PROFILE)

    def test_rejoins_original_guardian_apply_forward_receipts_without_external_effects(self):
        with (patch.object(terminal.vercel.Client, 'request', side_effect=AssertionError('provider request')),
              patch.object(certification.subprocess, 'run', side_effect=AssertionError('container call'))):
            self.assertEqual(self.original(), (self.cert_plan['originalReleaseReceiptSha256'], True))
        terminal_path = self.write_directory / terminal.TERMINAL
        terminal_path.write_bytes(terminal_path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'TERMINAL_BYTES_CHANGED'):
            self.original()

    def test_refuses_wrong_runtime_mount_role_and_original_sql_receipt(self):
        with patch.dict(self.cert_initial, configuration=str(self.snapshot.parent)), self.assertRaisesRegex(ValueError, 'RUNTIME_MOUNT'):
            self.original()
        with patch.dict(self.descriptor, migrationRoleOid='99'), self.assertRaisesRegex(ValueError, 'TARGET_CHANGED'):
            self.original()
        path = self.write_directory / 'frontend-original-database-receipt.json'
        path.write_bytes(path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'RECEIPT_BYTES_CHANGED'):
            self.original()

    def guard_probe(self):
        profiled = {'qualificationTargetProfile': replacement.PROFILE}
        job = {**self.job, **profiled, 'version': 2, 'target': {**self.job['target'], **profiled}}
        plan = self.cert_plan
        plan.update(**profiled, version=2)
        receipt = {**profiled, 'version': 2, 'status': 'P2_CERTIFICATION_DATABASE_CURRENT', 'service': 'frontend',
            'releaseId': self.release_id, 'sourceCommit': self.commit, 'contractPhase': self.candidate['contractPhase'],
            'phase2ContractManifestSha256': self.candidate['phase2ContractManifestSha256'],
            **{key: plan[key] for key in ('certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')},
            'target': plan['nativePlan']['target'], 'owner': self.owner, 'runtime': self.runtime,
            'sqlReplayed': False, 'trafficAuthorized': False, 'schemaVerified': True, 'runtimeRoleVerified': True,
            'replacementRelease': self.descriptor, 'effectiveLoginBoundaryVerified': True, 'predecessorRuntimeRoleAbsent': True,
            'admission': {'epoch': '1', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}}
        probe = {**profiled, 'version': 2, 'marker': '7' * 64, 'backendPid': 321,
                 'backendStart': '2026-11-09T21:51:00.000000Z', 'job': job, 'baseline': self.baseline,
                 'owner': self.owner, 'producers': self.cert_initial['inventory']['producers'],
                 'plan': plan, 'receipt': receipt, 'replacementRelease': self.descriptor}
        return probe, {'job': job, 'schema': self.raw_baseline}

    def test_guard_refuses_cross_mode_and_historical_claims(self):
        probe, job_info = self.guard_probe()
        supervisor._validate_profiled_certification_arm(self.cert_initial, probe, job_info)
        for changed in ({'historicalLogins': {}}, {'backendStart': 'not-a-backend-start'},
                        {'replacementRelease': {**self.descriptor, 'databaseOid': '17'}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                supervisor._validate_profiled_certification_arm(self.cert_initial, {**probe, **changed}, job_info)
        for changed in ({'oldLoginsDenied': True}, {'predecessorRuntimeRoleAbsent': False}, {'effectiveLoginBoundaryVerified': 1}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                supervisor._validate_profiled_certification_arm(self.cert_initial,
                    {**probe, 'receipt': {**probe['receipt'], **changed}}, job_info)
        with patch.dict(self.cert_plan, mode='known-ack-recovery'), self.assertRaises(ValueError):
            supervisor._validate_profiled_certification_arm(self.cert_initial, probe, job_info)

    def test_held_scope_exposes_only_the_original_rejoined_terminal_bytes(self):
        probe, info = self.guard_probe()
        probe['job'].update(contractPhase=self.candidate['contractPhase'])
        probe['receipt'].update({key: probe['job'][key] for key in (
            'environment', 'migrationImageDigest', 'sqlArtifactSha256', 'schemaBaselineSha256', 'contractManifestSha256')})
        probe['receipt'].update(after=self.database['after'], witness={'owned': True})
        probe['receipt']['journalSha256'] = migrate.file_hash(certification._profiled_compact(probe['receipt']['after']))
        probe['receipt']['witnessSha256'] = migrate.file_hash(certification._profiled_compact(probe['receipt']['witness']))
        self.cert_plan['configurationCanonicalSha256'] = migrate.file_hash(certification._canonical(self.review['configurationSha256']))
        self.cert_plan['contractPhase'] = self.candidate['contractPhase']
        self.cert_plan['phase2ContractManifestSha256'] = self.candidate['phase2ContractManifestSha256']
        self.cert_plan['planSha256'] = certification._profiled_plan_hash(self.cert_plan)
        probe['receipt']['planSha256'] = self.cert_plan['planSha256']
        observer = object.__new__(certification.P2CertificationPhysicalObserver)
        observer._expected_profile, observer._interrupted, observer._replacement = replacement.PROFILE, False, self.descriptor
        observer.selected, observer.request = self.candidate, probe
        observer.verify = lambda: None
        lock = self.root / 'scope-owned-lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = (self.write_directory / terminal.TERMINAL).read_bytes()
        with patch.object(migrate, 'candidate_profile'), patch.object(migrate, 'require_job_profile'):
            scope = certification.P2CertificationScope(fd, lock, lambda: None, probe['receipt'], self.cert_initial['candidateSha256'],
                release=self.candidate, jobs={'frontend': info}, configuration_sha256=self.review['configurationSha256'],
                certification_plan=self.cert_plan, expected_profile=replacement.PROFILE, physical_observer=observer,
                original_replacement_receipt=original)
            self.assertEqual(scope.require_replacement_original(original), json.loads(original))
            with self.assertRaisesRegex(ValueError, 'TERMINAL_BYTES_CHANGED'):
                scope.require_replacement_original(original + b' ')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_independent_guard_probes_under_actual_flock_before_arming(self):
        lock = self.root / 'owned-lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        probe, _ = self.guard_probe()
        directory = self.results / ('p2-profiled-current-certification-' + self.cert_plan['certificationActionId'])
        directory.mkdir(mode=0o700)
        initial = {**self.cert_initial, '_guardLockDescriptor': fd,
                   'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture'},
                   'sourceSha256': {certification.OBSERVER: 'c' * 64}}
        phases = []

        def readback(operation):
            with lock.open('rb') as contender, self.assertRaises(BlockingIOError):
                fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            phases.append(operation)
            return {'replacementRelease': self.descriptor, 'effectiveLoginBoundaryVerified': True,
                    'predecessorRuntimeRoleAbsent': True}

        with (patch.object(supervisor, 'LOCK', lock), patch.object(supervisor, '_verify_guard_source'),
              patch.object(supervisor, 'private_observer_program', return_value=self.root / 'owned-observer'),
              patch.object(certification, 'P2CertificationPhysicalObserver') as observer):
            observer.return_value.probe.side_effect = readback
            for operation in ('verify-schema', 'verify-closed'):
                self.assertEqual(supervisor._observe_profiled_replacement_certification(initial, probe, self.root, operation)
                                 ['replacementRelease'], self.descriptor)
        self.assertEqual(phases, ['verify-schema', 'verify-closed'])


if __name__ == '__main__':
    unittest.main()
