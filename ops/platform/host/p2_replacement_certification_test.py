import fcntl
import json
import os
import subprocess
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
        plan['nativePlan'].update(**profiled, version=2)
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
        with patch.dict(self.cert_plan, mode='known-ack-recovery'):
            supervisor._validate_profiled_certification_arm(self.cert_initial, probe, job_info)
        current = {**self.cert_initial, 'certificationPlan': {key: value for key, value in self.cert_plan.items() if key != 'replacementRelease'}}
        with self.assertRaises(ValueError):
            supervisor._validate_profiled_certification_arm(current, probe, job_info)

    def interrupted_probe(self):
        probe, info = self.guard_probe()
        frontend = {**self.cert_plan, 'mode': supervisor.PROFILED_INTERRUPTED_MODE, 'startState': 'already-closed'}
        frontend['planSha256'] = certification._profiled_plan_hash(frontend)
        probe['plan'] = frontend
        probe['receipt'].update(planSha256=frontend['planSha256'], journalSha256='4' * 64, witnessSha256='5' * 64)
        operator = 'd' * 40
        reviewed = {'sourceCommit': self.commit, 'operatorSourceCommit': operator, 'frontendPlan': frontend,
                    **{key: frontend[key] for key in certification.REPLACEMENT_LINEAGE_FIELDS}}
        initial = {**self.cert_initial, '_guardLayout': supervisor.PROFILED_INTERRUPTED_LAYOUT,
                   'mode': supervisor.PROFILED_INTERRUPTED_MODE, 'sourceCommit': operator,
                   'restorationActionId': frontend['certificationActionId'], 'reviewedPlan': reviewed}
        return initial, probe, info

    def test_interrupted_guard_requires_replacement_probe_and_original_review_lineage(self):
        initial, probe, info = self.interrupted_probe()
        supervisor._validate_profiled_interrupted_arm(initial, probe, info)
        bad = {**initial['reviewedPlan'], 'originalReleaseReceiptSha256': '9' * 64}
        with self.assertRaisesRegex(ValueError, 'REPLACEMENT_LINEAGE_CHANGED'):
            supervisor._validate_profiled_interrupted_arm({**initial, 'reviewedPlan': bad}, probe, info)
        history = {key: value for key, value in probe.items() if key != 'replacementRelease'}
        with self.assertRaisesRegex(ValueError, 'GUARD_PROBE_REQUIRED'):
            supervisor._validate_profiled_interrupted_arm(initial, {**history, 'historicalLogins': {}}, info)
        record = supervisor._profiled_interrupted_arm_record(initial, probe)
        self.assertEqual(record['replacementRelease'], self.descriptor)
        self.assertEqual(record['operatorSourceCommit'], initial['sourceCommit'])
        self.assertEqual(record['sourceCommit'], self.commit)

    def test_interrupted_closed_and_runtime_receipts_preserve_replacement_provenance(self):
        initial, probe, _ = self.interrupted_probe()
        directory = self.results / (supervisor.PROFILED_INTERRUPTED_LAYOUT['receiptPrefix'] + initial['restorationActionId'])
        directory.mkdir(mode=0o700)
        closed = {'version': 2, 'qualificationTargetProfile': replacement.PROFILE,
                  'status': 'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED', 'environment': 'staging',
                  'releaseId': self.release_id, 'sourceCommit': self.commit, 'targetSha256': self.target_sha,
                  **{key: probe[key] for key in ('marker', 'backendPid', 'backendStart')},
                  **{key: probe['receipt'][key] for key in ('admission', 'journalSha256', 'witnessSha256',
                      *certification.REPLACEMENT_PROOF_FIELDS)},
                  'backendAbsent': True, 'migrationLockReleased': True, 'nonceLockReleased': True}
        migrate.write_json(directory, supervisor.PROFILED_INTERRUPTED_FRONTEND_CLOSED, closed)
        self.assertEqual(supervisor.require_profiled_interrupted_frontend_closed(initial, probe), closed)
        (directory / supervisor.PROFILED_INTERRUPTED_FRONTEND_CLOSED).write_text(
            json.dumps({**closed, 'predecessorRuntimeRoleAbsent': False}))
        with self.assertRaisesRegex(ValueError, 'REPLACEMENT_BOUNDARY_REQUIRED'):
            supervisor.require_profiled_interrupted_frontend_closed(initial, probe)

        plan = initial['reviewedPlan']['frontendPlan']
        lineage = {key: plan[key] for key in certification.REPLACEMENT_LINEAGE_FIELDS}
        certification.require_certification_replacement_lineage(plan, lineage)
        for key in lineage:
            altered = {name: value for name, value in lineage.items() if name != key}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'REPLACEMENT_LINEAGE_CHANGED'):
                certification.require_certification_replacement_lineage(plan, altered)

    def test_interrupted_observer_dispatches_only_fixed_replacement_readback(self):
        _, probe, _ = self.interrupted_probe()
        program, core = (self.root / relative for relative in (certification.OBSERVER, certification.CORE))
        program.parent.mkdir(parents=True, exist_ok=True)
        program.write_bytes(b'owned observer\n')
        core.write_bytes(b'owned core\n')
        expected = {'version': 2, 'qualificationTargetProfile': replacement.PROFILE,
                    'status': 'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED', 'environment': 'staging',
                    'releaseId': self.release_id, 'sourceCommit': self.commit, 'targetSha256': self.target_sha,
                    **{key: probe[key] for key in ('marker', 'backendPid', 'backendStart')},
                    **{key: probe['receipt'][key] for key in ('admission', 'journalSha256', 'witnessSha256',
                       *certification.REPLACEMENT_PROOF_FIELDS)}}
        candidate = {**self.candidate, 'artifacts': {'frontendMigration': {'image': self.image}}}
        args = (candidate, probe, self.root, 'owned-fixture')
        options = {'program': program, 'program_sha256': migrate.file_hash(program.read_bytes()),
                   'expected_profile': replacement.PROFILE}

        def command(argv, **kwargs):
            if argv[1] == 'run':
                self.assertEqual(argv[-2:], [certification.OBSERVER, '--profiled-replacement-known-ack-interrupted'])
                self.assertEqual(json.loads(kwargs['input']), {**probe, 'operation': 'verify-schema'})
                return subprocess.CompletedProcess(argv, 0, json.dumps(expected), '')
            self.assertEqual(argv[1:3], ['rm', '--force'])
            return subprocess.CompletedProcess(argv, 0, '', '')

        with (patch.object(migrate, 'candidate_profile'), patch.object(migrate, 'require_job_profile'),
              patch.object(certification, '_core', core.read_bytes()), patch.object(certification, '_cache_core', return_value=core),
              patch.object(certification.runtime, 'command', return_value=''),
              patch.object(certification.subprocess, 'run', side_effect=command) as process):
            with self.assertRaisesRegex(ValueError, 'PHYSICAL_REQUEST_REQUIRED'):
                certification.P2CertificationPhysicalObserver(*args, **options)
            observer = certification.P2CertificationPhysicalObserver(*args, **options, interrupted=True)
            with self.assertRaisesRegex(ValueError, 'READ_ONLY_OBSERVER_REQUIRED'):
                observer.probe('fence')
            self.assertFalse(process.called)
            self.assertEqual(observer.probe('verify-schema'), expected)
            expected['admission'] = {**expected['admission'], 'uncertain': 1}
            with self.assertRaisesRegex(ValueError, 'INITIAL_CLOSED_BOUNDARY_REQUIRED'):
                observer.probe('verify-schema')

    def test_replacement_known_ack_emergency_fence_preserves_uncertainty(self):
        probe, _ = self.guard_probe()
        with patch.dict(self.cert_plan, mode='known-ack-recovery'):
            directory = self.results / ('p2-profiled-current-certification-' + self.cert_plan['certificationActionId'])
            directory.mkdir(mode=0o700)
            initial = {**self.cert_initial, 'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture'},
                       'candidate': {**self.candidate, 'artifacts': {'frontendMigration': {'image': self.image}}}}
            value = {'version': 2, 'qualificationTargetProfile': replacement.PROFILE,
                     'status': 'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_CLOSED', 'environment': 'staging',
                     'releaseId': self.release_id,
                     **{key: self.cert_plan[key] for key in ('sourceCommit', 'certificationActionId', 'candidateSha256', 'targetSha256', 'planSha256')},
                     **{key: probe['receipt'][key] for key in certification.REPLACEMENT_PROOF_FIELDS},
                     'epoch': '3', 'admissionChanged': True, 'frontendAdmissionClosed': True, 'sqlReplayed': False,
                     'releaseAccepted': False,
                     'knownAckLedger': {'active': 0, 'uncertain': 1, 'closedZero': False}}
            raw = json.dumps(value) + '\n'
            with (patch.object(certification, '_profiled_guard_context', return_value=replacement.PROFILE),
                  patch.object(certification, 'private_observer_program', return_value=self.root / 'owned-program'),
                  patch.object(certification, '_cache_core', return_value=self.root / 'owned-core'),
                  patch.object(certification.runtime, 'command', return_value=''),
                  patch.object(certification.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, raw, '')) as process):
                observed = certification.contain_profiled_certification_frontend(initial, probe, self.root)
            self.assertEqual(observed, {'frontendAdmissionClosed': True, 'frontendCloseAttempted': True})
            self.assertIn('--profiled-replacement-guard-fence', process.call_args_list[0].args[0])
            self.assertEqual((directory / 'p2-known-ack-guard-frontend-ledger.json').read_bytes(), raw.encode())

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
            for interrupted in (False, True):
                with self.subTest(interrupted=interrupted):
                    if interrupted:
                        initial, probe, _ = self.interrupted_probe()
                    else:
                        probe, _ = self.guard_probe()
                        initial = self.cert_initial
                    layout = supervisor.fixed_layout(initial)
                    (self.results / (layout['receiptPrefix'] + supervisor.action_id(initial))).mkdir(mode=0o700)
                    initial = {**initial, '_guardLockDescriptor': fd,
                               'credentials': {'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-fixture'},
                               'sourceSha256': {certification.OBSERVER: 'c' * 64}}
                    for operation in ('verify-schema', 'verify-closed'):
                        self.assertEqual(supervisor._observe_profiled_replacement_certification(initial, probe, self.root, operation)
                                         ['replacementRelease'], self.descriptor)
                        self.assertIs(observer.call_args.kwargs['interrupted'], interrupted)
        self.assertEqual(phases, ['verify-schema', 'verify-closed'] * 2)


if __name__ == '__main__':
    unittest.main()
