import base64
import contextlib
import fcntl
import json
import io
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import migrate
import p2_frontend_replacement_parent as parent
import p2_release_broker as broker_module
import p2_release_supervisor as supervisor
from p2_source_closure import MANAGED_REPLACEMENT_CATALOG, MANAGED_REPLACEMENT_SOURCE_REQUIRED


class ReplacementArmTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.bundle = self.root / 'bundle'
        (self.bundle / 'jobs').mkdir(parents=True)
        (self.bundle / 'schema').mkdir()
        self.results = self.root / 'results'
        self.results.mkdir(mode=0o700)
        self.release_id = 'owned-replacement'
        self.commit = 'a' * 40
        self.image_digest = 'sha256:' + 'b' * 64
        self.image = 'ghcr.io/princessdardan/lash-her-platform-frontend-migration@' + self.image_digest
        target = {'host': 'replacement.neon.tech', 'port': 5432, 'database': 'replacement', 'user': 'owner',
                  'runtimeRole': 'frontend_runtime', 'serverMajor': 18}
        predecessor = {**target, 'host': 'predecessor.neon.tech', 'runtimeRole': 'old_runtime'}
        self.target_sha = migrate.file_hash(parent.encoded({'environment': 'staging',
            **{key: target[key] for key in ('host', 'port', 'database', 'user', 'serverMajor')}}))
        self.job = {'releaseId': self.release_id, 'sourceCommit': self.commit, 'migrationImageDigest': self.image_digest,
                    'sqlArtifactSha256': 'c' * 64, 'schemaBaselineSha256': 'd' * 64,
                    'contractManifestSha256': 'sha256:' + 'e' * 64, 'phase2ContractManifestSha256': 'sha256:' + 'f' * 64,
                    'recoveryRef': 'staging/replacement', 'target': {**target, 'allowEmptyBootstrap': True,
                                                                     'approvedPendingTags': ['0001_fixture']}}
        self.candidate = {'environment': 'staging', 'contractPhase': 'p2', 'releaseId': self.release_id,
                          'sources': {'frontend': {'commit': self.commit}}}
        self.baseline = {'version': 1, 'serverMajor': 18, 'catalog': {'relations': []}}
        self.raw_baseline = parent.encoded(self.baseline) + b'\n'
        self.probe_base = {'version': 1, 'qualificationTargetProfile': parent.PROFILE,
                           'operation': 'verify-pre-bootstrap-lock', 'candidate': self.candidate, 'job': self.job,
                           'baseline': self.baseline, 'predecessorTarget': predecessor, 'targetSha256': self.target_sha,
                           'databaseOid': '42', 'migrationRoleOid': '43'}
        self.probe = {**self.probe_base, 'marker': '9' * 64, 'backendPid': 313,
                      'backendStart': '2026-11-09T21:51:00.000000Z'}
        self.raw_observation = parent.encoded({
            **{key: self.probe[key] for key in ('version', 'qualificationTargetProfile', 'operation', 'targetSha256',
                                               'databaseOid', 'migrationRoleOid', *parent.PROBE_IDENTITY)},
            'status': 'P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED', 'environment': 'staging',
            'releaseId': self.release_id, 'sourceCommit': self.commit, 'readOnlyVerified': True,
            'authorityIssued': False, 'trafficAuthorized': False,
        }) + b'\n'
        candidate_path = self.bundle / 'release.candidate.json'
        job_path = self.bundle / 'jobs/frontend.json'
        candidate_path.write_bytes(parent.encoded(self.candidate) + b'\n')
        job_path.write_bytes(parent.encoded(self.job) + b'\n')
        (self.bundle / 'schema/frontend.json').write_bytes(self.raw_baseline)
        self.plan = {'version': 1, 'qualificationTargetProfile': parent.PROFILE, 'environment': 'staging',
                     'operation': 'profiled-frontend-replacement', 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED',
                     'releaseId': self.release_id, 'sourceCommit': self.commit, 'reviewSha256': '1' * 64,
                     'targetSha256': self.target_sha, 'candidateSha256': migrate.file_hash(candidate_path.read_bytes()),
                     'frontendJobSha256': migrate.file_hash(job_path.read_bytes()),
                     'schemaBaselineFileSha256': migrate.file_hash(self.raw_baseline),
                     **{key: self.job[key] for key in ('migrationImageDigest', 'sqlArtifactSha256', 'schemaBaselineSha256',
                                                       'contractManifestSha256', 'phase2ContractManifestSha256')},
                     'predecessor': {'provider': {}, 'target': predecessor, 'lineageSha256': '3' * 64,
                                     'deploymentId': 'dpl_prior', 'recoveryRef': 'prior', 'databaseOid': '22',
                                     'loginRoleOid': '23', 'sourceCommit': self.commit, 'observedAt': '2026-11-01',
                                     'appliedCount': 1, 'appliedPrefixSha256': '5' * 64, 'pendingTags': ['0001_fixture'],
                                     'phase2ContractManifestSha256': self.job['phase2ContractManifestSha256']},
                     'replacement': {'provider': {}, 'databaseOid': '42', 'migrationRoleOid': '43', 'administrativeLogins': [],
                                     'recoveryRef': self.job['recoveryRef'], 'target': target,
                                     'approvedPendingTags': ['0001_fixture']},
                     'replacementObserved': False, 'releaseAccepted': False, **parent.NO_AUTHORITY}
        self.plan_raw = parent.encoded(self.plan) + b'\n'
        review = migrate.file_hash(self.plan_raw)
        self.initial = {'version': 1, 'mode': parent.MODE, 'qualificationTargetProfile': parent.PROFILE,
                        'environment': 'staging', 'sourceCommit': self.commit, 'sourceSha256': {},
                        'sourceClosureSha256': '7' * 64, 'hostMachineId': '8' * 32, 'bundle': str(self.bundle),
                        'results': str(self.results), 'candidateSha256': self.plan['candidateSha256'],
                        'reviewedPlanBytes': base64.b64encode(self.plan_raw).decode(), 'reviewedPlanSha256': review,
                        'confirmation': 'staging/' + self.release_id + '/replacement-arm/' + review,
                        'credentials': {parent.CREDENTIAL: 'private-fixture-url'}}
        self.directory = self.results / (parent.LAYOUT['receiptPrefix'] + self.release_id)
        self.write_initial = {**self.initial, 'mode': parent.WRITE_MODE,
                              'confirmation': 'staging/' + self.release_id + '/replacement-write/' + review}
        self.write_directory = self.results / (supervisor.PROFILED_REPLACEMENT_WRITE_LAYOUT['receiptPrefix'] + self.release_id)
        self.empty_boundary = {'version': 1, 'status': 'FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED',
                               'target': target, 'predecessorTarget': predecessor, 'databaseOid': '42',
                               'migrationRoleOid': '43', 'administrativeLogins': [],
                               'catalogScope': 'postgresql-16-18-stock-replacement-v1',
                               'zeroCatalogCounts': dict.fromkeys(sorted(parent.EMPTY_CATALOG_COUNTERS), 0),
                               'observedAt': '2026-11-09T21:51:00.000Z', 'readOnlyVerified': True,
                               'completeDatabaseEmptyProven': False, 'authorityIssued': False}
        prefix = [{'tag': '0001_fixture', 'hash': 'a' * 64, 'folderMillis': 1762725060000}]
        self.raw_abort = parent.encoded({
            **json.loads(self.raw_observation), 'operation': 'observe-after-replacement-abort',
            'status': 'P2_FRONTEND_REPLACEMENT_ABORT_OBSERVED',
            'physicalObservationSha256': migrate.file_hash(self.raw_observation), 'observedAt': self.empty_boundary['observedAt'],
            'backendTerminated': True, 'originalBackendAbsent': True, 'originalLocksAbsent': True,
            'observationLockReleased': True, 'journalPresent': True, 'appliedPrefix': prefix,
            'appliedPrefixSha256': migrate.file_hash(parent.encoded(prefix)), 'replayAuthorized': False,
        }) + b'\n'

    def managed_inputs(self, *, writing=True):
        target = self.plan['replacement']['target']
        provider = {'kind': 'neon', 'projectId': 'owned-project', 'branchId': 'br-owned',
                    'endpointId': 'ep-owned', 'directHost': target['host']}
        admins = [{'name': 'cloud_admin', 'oid': '10'}, {'name': 'neon_service', 'oid': '16395'}]
        catalog = {'version': 1, 'id': parent.MANAGED_CATALOG_ID, 'provider': provider, 'target': target,
                   'databaseOid': '42', 'migrationRoleOid': '43', 'administrativeLogins': admins,
                   'roles': [], 'memberships': [], 'defaultAcl': [], 'dependencies': [], 'sharedDependencies': [],
                   'databaseAclBefore': [], 'databaseAclAfter': [],
                   'expectedNonzeroCatalogCounts': dict(parent.MANAGED_CATALOG_COUNTS)}
        catalog_file = self.root / MANAGED_REPLACEMENT_CATALOG
        catalog_file.parent.mkdir(parents=True)
        raw = parent.encoded(catalog) + b'\n'
        catalog_file.write_bytes(raw)
        sha = migrate.file_hash(raw)
        ref = {'id': catalog['id'], 'sha256': sha}
        plan = {**self.plan, 'replacement': {**self.plan['replacement'], 'provider': provider,
                                            'administrativeLogins': admins, 'managedCatalog': ref}}
        plan_raw = parent.encoded(plan) + b'\n'
        review = migrate.file_hash(plan_raw)
        mode = 'write' if writing else 'arm'
        initial = {**(self.write_initial if writing else self.initial),
                   'sourceSha256': {**dict.fromkeys(MANAGED_REPLACEMENT_SOURCE_REQUIRED, '4' * 64),
                                    MANAGED_REPLACEMENT_CATALOG: sha},
                   'reviewedPlanBytes': base64.b64encode(plan_raw).decode(), 'reviewedPlanSha256': review,
                   'confirmation': 'staging/' + self.release_id + '/replacement-' + mode + '/' + review}
        boundary = {key: value for key, value in self.empty_boundary.items() if key != 'zeroCatalogCounts'}
        boundary.update(administrativeLogins=admins, catalogScope=parent.MANAGED_CATALOG_SCOPE, managedCatalog=ref,
                        catalogCounts={**self.empty_boundary['zeroCatalogCounts'], **catalog['expectedNonzeroCatalogCounts']})
        return initial, plan, plan_raw, boundary, catalog_file

    def test_checked_in_managed_catalog_projects_the_exact_host_boundary(self):
        source = Path(__file__).resolve().parents[3]
        manifest = {name: migrate.file_hash((source / name).read_bytes()) for name in MANAGED_REPLACEMENT_SOURCE_REQUIRED}
        baseline = json.loads((source / MANAGED_REPLACEMENT_CATALOG).read_bytes())
        ref = {'id': baseline['id'], 'sha256': manifest[MANAGED_REPLACEMENT_CATALOG]}
        bindings = {key: baseline[key] for key in ('provider', 'target', 'databaseOid', 'migrationRoleOid', 'administrativeLogins')}
        plan = {**self.plan, 'replacement': {**self.plan['replacement'], **bindings, 'managedCatalog': ref}}
        target = {**self.probe['job']['target'], **bindings['target']}
        probe = {**self.probe, 'job': {**self.probe['job'], 'target': target},
                 'databaseOid': baseline['databaseOid'], 'migrationRoleOid': baseline['migrationRoleOid']}
        boundary = {key: value for key, value in self.empty_boundary.items() if key != 'zeroCatalogCounts'}
        boundary.update({key: bindings[key] for key in ('target', 'databaseOid', 'migrationRoleOid', 'administrativeLogins')})
        boundary.update(catalogScope=parent.MANAGED_CATALOG_SCOPE, managedCatalog=ref,
                        catalogCounts={**self.empty_boundary['zeroCatalogCounts'], **baseline['expectedNonzeroCatalogCounts']})
        self.assertEqual(parent.empty_catalog_receipt({'sourceSha256': manifest}, plan, probe, boundary, source=source),
                         parent.encoded(boundary) + b'\n')

    def test_managed_plan_binds_approved_catalog_without_widening_the_physical_probe(self):
        initial, plan, plan_raw, _boundary, _catalog_file = self.managed_inputs(writing=False)
        installed = Path('/opt/lash-her/operators') / self.commit
        jobs = {'frontend': {'job': self.job, 'schema': self.raw_baseline, 'image': self.image}}
        read_catalog = parent.read_managed_replacement_catalog
        with (patch.object(parent.runtime, 'assert_host'), patch.object(parent, 'verify_profiled_current_source_closure'),
              patch.object(parent, 'exact_host_directory', side_effect=Path),
              patch.object(migrate, 'make_plan', return_value=(self.candidate, jobs)),
              patch.object(parent, 'read_managed_replacement_catalog',
                           side_effect=lambda supplied, _source, sha: read_catalog(supplied, self.root, sha)) as read):
            self.assertEqual(parent.prepare(initial, installed),
                             (plan_raw, plan, self.probe_base, self.image, self.directory))
            read.assert_called_once_with(initial, installed, plan['replacement']['managedCatalog']['sha256'])

    def test_managed_receipt_requires_exact_source_bound_scope_and_counts(self):
        initial, plan, _plan_raw, boundary, catalog_file = self.managed_inputs()
        self.assertEqual(parent.empty_catalog_receipt(initial, plan, self.probe, boundary, source=self.root),
                         parent.encoded(boundary) + b'\n')
        for variant in (self.empty_boundary, {**boundary, 'zeroCatalogCounts': self.empty_boundary['zeroCatalogCounts']},
                        {**boundary, 'catalogScope': self.empty_boundary['catalogScope']},
                        {**boundary, 'managedCatalog': {**boundary['managedCatalog'], 'sha256': '6' * 64}},
                        {**boundary, 'administrativeLogins': []}, {**boundary, 'completeDatabaseEmptyProven': True},
                        {**boundary, 'catalogCounts': {**boundary['catalogCounts'], 'pg_class': 1}},
                        {**boundary, 'catalogCounts': {**boundary['catalogCounts'], 'pg_type': 1}},
                        {**boundary, 'catalogCounts': {key: value for key, value in boundary['catalogCounts'].items() if key != 'pg_type'}},
                        {**boundary, 'catalogCounts': {**boundary['catalogCounts'], 'pg_default_acl': 0}},
                        {**boundary, 'catalogCounts': {**boundary['catalogCounts'], 'pg_class': False}}):
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.empty_catalog_receipt(initial, plan, self.probe, variant, source=self.root)
        with self.assertRaisesRegex(ValueError, parent.REFUSED):
            parent.empty_catalog_receipt(self.initial, self.plan, self.probe, boundary, source=self.root)
        for probe in ({**self.probe, 'databaseOid': '44'}, {**self.probe, 'migrationRoleOid': '44'}):
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.empty_catalog_receipt(initial, plan, probe, boundary, source=self.root)
        for change in ({'provider': {**plan['replacement']['provider'], 'endpointId': 'ep-other'}},
                       {'target': {**plan['replacement']['target'], 'serverMajor': 17}},
                       {'databaseOid': '44'}, {'migrationRoleOid': '44'},
                       {'administrativeLogins': [{'name': 'cloud_admin', 'oid': '11'}]},
                       {'administrativeLogins': list(reversed(plan['replacement']['administrativeLogins']))},
                       {'managedCatalog': {**boundary['managedCatalog'], 'id': 'other-catalog'}}):
            changed_plan = {**plan, 'replacement': {**plan['replacement'], **change}}
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.empty_catalog_receipt(initial, changed_plan, self.probe, boundary, source=self.root)
        with self.assertRaisesRegex(ValueError, 'CATALOG_SOURCE_REQUIRED'):
            parent.empty_catalog_receipt({**initial, 'sourceSha256': {}}, plan, self.probe, boundary, source=self.root)
        catalog_file.write_bytes(catalog_file.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'CATALOG_SOURCE_CHANGED'):
            parent.empty_catalog_receipt(initial, plan, self.probe, boundary, source=self.root)

    def test_guard_rechecks_managed_bytes_after_observing_the_exact_held_backend(self):
        initial, plan, plan_raw, boundary, catalog_file = self.managed_inputs()
        self.write_directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.write_directory, 'reviewed-plan.json', plan_raw)
        cancelled = threading.Event()
        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(parent, 'observe', return_value=self.raw_observation) as observe):
            parent.verify_and_retain(initial, plan, self.probe_base, self.image, self.write_directory,
                                     self.root, self.probe, cancelled)
            arm_sha = migrate.file_hash((self.write_directory / parent.ARM).read_bytes())
            request = {'armReceiptSha256': arm_sha, 'emptyCatalogReceipt': boundary}
            def changed_catalog(*_args):
                catalog_file.write_bytes(catalog_file.read_bytes() + b' ')
                return self.raw_observation
            observe.side_effect = changed_catalog
            with self.assertRaisesRegex(ValueError, 'CATALOG_SOURCE_CHANGED'):
                parent.verify_and_retain_write_custody(initial, plan, self.probe_base, self.image,
                    self.write_directory, self.root, self.probe, request, cancelled)
            self.assertTrue((self.write_directory / parent.WRITE_OBSERVER_RETURNED).is_file())
            self.assertFalse((self.write_directory / parent.WRITE_BOUNDARY).exists())
            self.assertFalse((self.write_directory / parent.WRITE_INTENT).exists())

    def test_managed_write_custody_rejoins_exact_retained_bytes(self):
        initial, plan, plan_raw, boundary, _catalog_file = self.managed_inputs()
        self.write_directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.write_directory, 'reviewed-plan.json', plan_raw)
        cancelled = threading.Event()
        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(parent, 'observe', return_value=self.raw_observation) as observe):
            parent.verify_and_retain(initial, plan, self.probe_base, self.image, self.write_directory,
                                     self.root, self.probe, cancelled)
            arm_sha = migrate.file_hash((self.write_directory / parent.ARM).read_bytes())
            request = {'armReceiptSha256': arm_sha, 'emptyCatalogReceipt': boundary}
            parent.verify_and_retain_write_custody(initial, plan, self.probe_base, self.image,
                self.write_directory, self.root, self.probe, request, cancelled)
        self.assertEqual(observe.call_count, 2)
        receipt, _intent, physical = parent.require_write_custody(initial, plan, self.probe, self.write_directory,
            arm_sha, boundary, source=self.root)
        self.assertEqual(physical, self.raw_observation)
        self.assertEqual(receipt['emptyCatalogReceiptSha256'], migrate.file_hash(parent.encoded(boundary) + b'\n'))
        self.assertTrue(all(receipt[key] is False for key in parent.NO_AUTHORITY))

    def test_exact_review_and_confirmation(self):
        self.assertEqual(parent.reviewed_plan(self.initial), (self.plan_raw, self.plan))
        for update in ({'reviewedPlanSha256': '1' * 64}, {'confirmation': 'staging/owned-replacement'},
                       {'sourceCommit': '1' * 40}, {'version': True}, {'credentials': {}}, {'extra': 1}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                parent.reviewed_plan({**self.initial, **update})
        with self.assertRaisesRegex(ValueError, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED'):
            supervisor.supervise(self.initial)

    def test_write_review_cannot_enter_installed_read_only_or_generic_cli(self):
        self.assertEqual(parent.reviewed_plan(self.write_initial, mode=parent.WRITE_MODE), (self.plan_raw, self.plan))
        for initial, mode in ((self.write_initial, parent.MODE), (self.initial, parent.WRITE_MODE),
                              ({**self.write_initial, 'confirmation': self.initial['confirmation']}, parent.WRITE_MODE)):
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.reviewed_plan(initial, mode=mode)
        with self.assertRaisesRegex(ValueError, 'P2_FIXED_SOURCE_DISPATCH_REQUIRED'):
            supervisor.supervise(self.write_initial)
        data = io.TextIOWrapper(io.BytesIO(parent.encoded(self.write_initial) + b'\n'))
        with (patch.object(parent.sys, 'argv', ['parent.py', '--supervise-pre-bootstrap']),
              patch.object(parent.sys, 'platform', 'linux'), patch.object(parent.os, 'geteuid', return_value=0),
              patch.object(parent.sys, 'stdin', data), patch.object(parent.os, 'open') as opened):
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.main()
            opened.assert_not_called()

    def test_installed_write_dispatch_requires_full_review_and_exact_confirmation(self):
        runtime_raw = b'{}\n'
        runtime_sha = migrate.file_hash(runtime_raw)
        reviewed = {**self.write_initial, 'runtimeReviewBytes': base64.b64encode(runtime_raw).decode(),
                    'runtimeReviewSha256': runtime_sha, 'vercelToken': 'owned-provider-token',
                    'confirmation': self.write_initial['confirmation'] + '/' + runtime_sha,
                    'credentials': {**self.write_initial['credentials'], **dict.fromkeys(parent.API_CREDENTIALS, 'owned-migration-credential')}}
        def dispatch(initial):
            data = io.TextIOWrapper(io.BytesIO(parent.encoded(initial) + b'\n'))
            with (patch.object(parent.sys, 'argv', ['parent.py', '--supervise-replacement-write']),
                  patch.object(parent.sys, 'platform', 'linux'), patch.object(parent.os, 'geteuid', return_value=0),
                  patch.object(parent.sys, 'stdin', data)):
                parent.main()
        with patch.object(parent, 'qualify_replacement_write_frontier') as supervise:
            for initial in (self.initial, self.write_initial, {**reviewed, 'confirmation': self.write_initial['confirmation']},
                            {key: value for key, value in reviewed.items() if key != 'vercelToken'}):
                with self.assertRaisesRegex(ValueError, parent.REFUSED):
                    dispatch(initial)
                supervise.assert_not_called()
            dispatch(reviewed)
            supervise.assert_called_once()
            self.assertEqual(supervise.call_args.args[0], reviewed)

    def test_bundle_raw_bytes_match_probe_and_review(self):
        source = Path('/opt/lash-her/operators') / self.commit
        jobs = {'frontend': {'job': self.job, 'schema': self.raw_baseline, 'image': self.image}}
        with (patch.object(parent.runtime, 'assert_host'), patch.object(parent, 'verify_profiled_current_source_closure'),
              patch.object(parent, 'exact_host_directory', side_effect=Path),
              patch.object(migrate, 'make_plan', return_value=(self.candidate, jobs))):
            prepared = parent.prepare(self.initial, source)
            self.assertEqual(prepared, (self.plan_raw, self.plan, self.probe_base, self.image, self.directory))
            file = self.bundle / 'schema/frontend.json'
            file.write_bytes(self.raw_baseline + b' ')
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.prepare(self.initial, source)

    def test_observer_uses_exact_packaged_entry_and_owned_cleanup(self):
        result = subprocess.CompletedProcess([], 0, stdout=self.raw_observation)
        with (patch.object(parent.subprocess, 'run', return_value=result) as execute,
              patch.object(parent, 'remove_container') as cleanup):
            self.assertEqual(parent.observe(self.initial, self.image, self.probe), self.raw_observation)
            args = execute.call_args.args[0]
            options = execute.call_args.kwargs
            self.assertEqual(args[-3:], [self.image, 'ops/platform/frontend-image.mjs', '--observe-replacement-lock'])
            self.assertIn('--pull=never', args)
            self.assertIn('--read-only', args)
            self.assertNotIn('--mount', args)
            self.assertNotIn(self.initial['credentials'][parent.CREDENTIAL], args)
            self.assertEqual(options['env'][parent.CREDENTIAL], self.initial['credentials'][parent.CREDENTIAL])
            cleanup.assert_called_once_with(parent.container_name(self.initial, self.probe), self.initial['reviewedPlanSha256'])
        for name, value in (('backendPid', True), ('databaseOid', '44'), ('authorityIssued', True), ('marker', '2' * 64)):
            changed = json.loads(self.raw_observation)
            changed[name] = value
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.observation(self.probe, parent.encoded(changed))

    def test_abort_uses_exact_packaged_entry_and_retains_prefix_without_replay(self):
        self.write_directory.mkdir(mode=0o700)
        with (patch.object(supervisor, 'verify_guard_lock') as verify,
              patch.object(parent, 'run_bounded_image', return_value=self.raw_abort) as execute,
              patch.object(parent, 'remove_container', return_value=False) as cleanup):
            for _ in range(2):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
            args = execute.call_args.args[0]
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(verify.call_count, 4)
            self.assertEqual(args[-3:], [self.image, 'ops/platform/frontend-image.mjs', '--abort-replacement'])
            self.assertIn('--pull=never', args)
            self.assertIn('--read-only', args)
            self.assertNotIn('--mount', args)
            self.assertNotIn(self.initial['credentials'][parent.CREDENTIAL], args)
            packet = json.loads(execute.call_args.args[1])
            self.assertEqual(packet, {'probe': self.probe, 'physicalObservation': base64.b64encode(self.raw_observation).decode()})
            observe_name = parent.container_name(self.write_initial, self.probe)
            abort_name = parent.container_name(self.write_initial, self.probe, aborting=True)
            self.assertEqual([call.args for call in cleanup.call_args_list],
                             [(name, self.initial['reviewedPlanSha256']) for name in (observe_name, abort_name, abort_name)])
        self.assertEqual((self.write_directory / parent.ABORT_OBSERVATION).read_bytes(), self.raw_abort)
        retained = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertEqual(retained['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW')
        self.assertTrue(retained['backendClosureVerified'])
        self.assertTrue(retained['observerContainerAbsent'])
        self.assertTrue(retained['abortContainerAbsent'])
        self.assertEqual(retained['appliedPrefixCount'], 1)
        self.assertFalse(retained['automaticReplayAuthorized'])
        for name, value in (('backendPid', 32), ('appliedPrefixSha256', 'f' * 64),
                            ('originalLocksAbsent', 1), ('replayAuthorized', True)):
            changed = {**json.loads(self.raw_abort), name: value}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.abort_result(self.plan, self.probe, self.raw_observation, parent.encoded(changed) + b'\n')

    def test_uncertain_abort_refuses_without_automatic_repeat(self):
        self.write_directory.mkdir(mode=0o700)
        with (patch.object(supervisor, 'verify_guard_lock'),
              patch.object(parent, 'remove_container', return_value=False),
              patch.object(parent, 'run_replacement_image', side_effect=ValueError('owned-uncertain')) as run):
            with self.assertRaisesRegex(ValueError, 'owned-uncertain'):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
            self.assertEqual(run.call_count, 1)
        retained = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertEqual(retained['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN')
        self.assertFalse(retained['backendClosureVerified'])
        self.assertFalse(retained['automaticReplayAuthorized'])

    def test_prior_abort_attempt_reconciles_container_without_relaunch(self):
        self.write_directory.mkdir(mode=0o700)
        attempt = {**parent.receipt_base(self.write_initial, self.plan, 'P2_FRONTEND_REPLACEMENT_ABORT_ATTEMPT'),
                   'physicalObservationSha256': migrate.file_hash(self.raw_observation), 'automaticReplayAuthorized': False}
        migrate.write_json(self.write_directory, parent.ABORT_ATTEMPT, attempt)
        with (patch.object(supervisor, 'verify_guard_lock'),
              patch.object(parent, 'remove_container', side_effect=[False, True]) as cleanup,
              patch.object(parent, 'run_replacement_image') as run):
            with self.assertRaises(FileNotFoundError):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
            run.assert_not_called()
            self.assertEqual(cleanup.call_args.args[0], parent.container_name(self.write_initial, self.probe, aborting=True))
        retained = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertTrue(retained['abortContainerAbsent'])
        self.assertFalse(retained['backendClosureVerified'])

    def test_abort_receipt_survives_unknown_helper_cleanup(self):
        self.write_directory.mkdir(mode=0o700)
        with (patch.object(supervisor, 'verify_guard_lock'),
              patch.object(parent, 'remove_container', side_effect=[False, False, ValueError('owned-uncertain')]),
              patch.object(parent, 'run_replacement_image', return_value=self.raw_abort)):
            with self.assertRaisesRegex(ValueError, 'owned-uncertain'):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation)
        self.assertEqual((self.write_directory / parent.ABORT_OBSERVATION).read_bytes(), self.raw_abort)
        retained = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertTrue(retained['backendClosureVerified'])
        self.assertFalse(retained['abortContainerAbsent'])
        self.assertEqual(retained['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN')

    def test_unreaped_broker_retains_uncertainty_without_abort(self):
        self.write_directory.mkdir(mode=0o700)
        with (patch.object(supervisor, 'verify_guard_lock'),
              patch.object(parent, 'remove_container') as cleanup,
              patch.object(parent, 'run_replacement_image') as run):
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.contain_replacement_write(self.write_initial, self.plan, self.image, self.write_directory,
                                                 self.probe, self.raw_observation, process_reconciled=False)
            cleanup.assert_not_called()
            run.assert_not_called()
        retained = json.loads((self.write_directory / parent.WRITE_CONTAINMENT).read_bytes())
        self.assertFalse(retained['processScopeReconciled'])
        self.assertFalse(retained['backendClosureVerified'])

    def test_packaged_abort_stdout_is_bounded(self):
        packet = b'input' * 8_000
        exact = parent.run_bounded_image([sys.executable, '-c', 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())'],
                                         packet, {})
        self.assertEqual(exact, packet)
        with self.assertRaisesRegex(ValueError, parent.REFUSED):
            parent.run_bounded_image([sys.executable, '-c',
                                      'import sys; sys.stdin.buffer.read(); sys.stdout.buffer.write(b"x" * 70_000)'],
                                     b'input', {})

    def test_arm_ready_and_review_bytes_are_bound(self):
        self.directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.directory, 'reviewed-plan.json', self.plan_raw)
        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(parent, 'observe', return_value=self.raw_observation)):
            parent.verify_and_retain(self.initial, self.plan, self.probe_base, self.image,
                                     self.directory, self.root, self.probe, threading.Event())
        armed, arm_sha = parent.require_arm(self.initial, self.plan, self.probe, self.directory)
        self.assertEqual(base64.b64decode(armed['physicalObservation']), self.raw_observation)
        self.assertEqual(arm_sha, migrate.file_hash((self.directory / parent.ARM).read_bytes()))
        self.assertEqual((self.directory / parent.READY).stat().st_mode & 0o777, 0o600)
        terminal = parent.terminal_receipt(self.initial, self.plan, armed, arm_sha)
        self.assertFalse(terminal['backendClosureVerified'])
        self.assertTrue(all(terminal[key] is False for key in parent.NO_AUTHORITY))
        with self.assertRaises(FileExistsError):
            migrate.write_json(self.directory, parent.ARM, {})
        (self.directory / 'reviewed-plan.json').write_bytes(self.plan_raw + b' ')
        with self.assertRaisesRegex(ValueError, parent.REFUSED):
            parent.require_arm(self.initial, self.plan, self.probe, self.directory)

    def test_write_custody_requires_same_backend_and_exact_zero_catalog(self):
        self.write_directory.mkdir(mode=0o700)
        migrate.write_exact_bytes(self.write_directory, 'reviewed-plan.json', self.plan_raw)
        with (patch.object(supervisor, 'verify_guard_boundary'),
              patch.object(parent, 'observe', return_value=self.raw_observation) as observe):
            parent.verify_and_retain(self.write_initial, self.plan, self.probe_base, self.image,
                                     self.write_directory, self.root, self.probe, threading.Event())
            arm_sha = migrate.file_hash((self.write_directory / parent.ARM).read_bytes())
            request = {'armReceiptSha256': arm_sha, 'emptyCatalogReceipt': self.empty_boundary}
            for changed in ({**request, 'armReceiptSha256': '2' * 64},
                            {**request, 'emptyCatalogReceipt': {**self.empty_boundary, 'authorityIssued': True}},
                            {**request, 'emptyCatalogReceipt': {**self.empty_boundary, 'zeroCatalogCounts': {}}},
                            {**request, 'emptyCatalogReceipt': {**self.empty_boundary, 'zeroCatalogCounts': {
                                **self.empty_boundary['zeroCatalogCounts'], 'pg_class': False}}},
                            {**request, 'emptyCatalogReceipt': {**self.empty_boundary, 'zeroCatalogCounts': {
                                **self.empty_boundary['zeroCatalogCounts'], 'pg_type': 1}}},
                            {**request, 'emptyCatalogReceipt': {**self.empty_boundary, 'zeroCatalogCounts': {
                                key: value for key, value in self.empty_boundary['zeroCatalogCounts'].items() if key != 'pg_type'}}}):
                with self.assertRaisesRegex(ValueError, parent.REFUSED):
                    parent.verify_and_retain_write_custody(self.write_initial, self.plan, self.probe_base, self.image,
                        self.write_directory, self.root, self.probe, changed, threading.Event())
            mismatched = self.root / 'mismatched-observer'
            mismatched.mkdir(mode=0o700)
            for record in ('reviewed-plan.json', parent.ARM, parent.READY):
                migrate.write_exact_bytes(mismatched, record, (self.write_directory / record).read_bytes())
            observe.return_value = self.raw_observation + b' '
            with self.assertRaisesRegex(ValueError, parent.REFUSED):
                parent.verify_and_retain_write_custody(self.write_initial, self.plan, self.probe_base, self.image,
                    mismatched, self.root, self.probe, request, threading.Event())
            self.assertFalse((mismatched / parent.WRITE_INTENT).exists())
            self.assertTrue((mismatched / parent.WRITE_OBSERVER_RETURNED).is_file())
            observe.return_value = self.raw_observation
            parent.verify_and_retain_write_custody(self.write_initial, self.plan, self.probe_base, self.image,
                self.write_directory, self.root, self.probe, request, threading.Event())
        receipt, intent, physical = parent.require_write_custody(self.write_initial, self.plan, self.probe,
            self.write_directory, arm_sha, self.empty_boundary)
        self.assertEqual(physical, self.raw_observation)
        self.assertEqual(intent, migrate.file_hash((self.write_directory / parent.WRITE_INTENT).read_bytes()))
        self.assertTrue(all(receipt[key] is False for key in parent.NO_AUTHORITY))
        self.assertFalse(receipt['automaticReplayAuthorized'])
        for retained in (parent.WRITE_BOUNDARY, parent.WRITE_INTENT, parent.WRITE_READY):
            self.assertEqual((self.write_directory / retained).stat().st_mode & 0o777, 0o600)
        (self.write_directory / parent.WRITE_BOUNDARY).write_bytes(parent.encoded(self.empty_boundary))
        with self.assertRaisesRegex(ValueError, parent.REFUSED):
            parent.require_write_custody(self.write_initial, self.plan, self.probe, self.write_directory, arm_sha, self.empty_boundary)

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_live_flock_and_heartbeats_outlast_slow_independent_observer(self):
        self.exercise_live_guard()

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_late_bundle_drift_preserves_intent_and_refuses_terminal(self):
        self.exercise_live_guard(change_bundle=True)

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_write_grant_drift_contains_after_broker_reap_with_flock_held(self):
        self.exercise_live_guard(change_bundle=True, writing=True)

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_surviving_write_broker_contains_after_guard_death(self):
        self.exercise_live_guard(writing=True, kill_guard='after-reply')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_surviving_write_broker_contains_guard_death_before_ready(self):
        self.exercise_live_guard(writing=True, kill_guard='before-ready')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_surviving_write_broker_contains_guard_death_after_ready_before_reply(self):
        self.exercise_live_guard(writing=True, kill_guard='before-reply')

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'owned Linux root flock fixture')
    def test_surviving_write_broker_holds_flock_until_guard_reparenting(self):
        self.exercise_live_guard(writing=True, kill_guard='after-reply', delay_reparent=True)

    def exercise_live_guard(self, change_bundle=False, writing=False, kill_guard=None, delay_reparent=False):
        lock = self.root / 'owned-host.lock'
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        fd = os.open(lock, flags, 0o600)
        self.addCleanup(os.close, fd)
        operator_input, send = os.pipe()
        receive, operator_output = os.pipe()
        initial = self.write_initial if writing else self.initial
        directory = self.write_directory if writing else self.directory
        stage_marker = self.root / 'fixture-ready-to-kill-guard'
        observation_count = 0
        child = os.fork()
        if child == 0:
            os.close(send)
            os.close(receive)
            os.close(fd)
            sys.stdin = os.fdopen(operator_input)
            sys.stdout = os.fdopen(operator_output, 'w')
            guard_pid = os.getpid()
            actual_parent = os.getppid
            reparent_observed_at = None

            def staged_parent():
                nonlocal reparent_observed_at
                observed = actual_parent()
                if not delay_reparent or os.getpid() == guard_pid or observed == guard_pid:
                    return observed
                if reparent_observed_at is None:
                    reparent_observed_at = time.monotonic()
                if time.monotonic() - reparent_observed_at < 0.35:
                    return guard_pid
                return observed

            def slow_observer(*_args):
                nonlocal observation_count
                observation_count += 1
                if kill_guard == 'before-ready' and observation_count == 2:
                    stage_marker.touch()
                    time.sleep(5)
                if writing and observation_count == 2 or not writing and not change_bundle:
                    time.sleep(3.4)  # Longer than the broker's 3-second guard heartbeat limit.
                return self.raw_observation
            def abort_image(action, image, probe, *, abort_observation):
                self.assertEqual(action['mode'], parent.WRITE_MODE)
                self.assertEqual(image, self.image)
                self.assertEqual(probe, self.probe)
                self.assertEqual(abort_observation, self.raw_observation)
                nested = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(nested, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(nested)
                return self.raw_abort

            real_require_custody = parent.require_write_custody
            def staged_custody(*args):
                result = real_require_custody(*args)
                if kill_guard == 'before-reply':
                    stage_marker.touch()
                    time.sleep(5)
                return result
            try:
                with (patch.object(parent, 'LOCK', lock), patch.object(supervisor, 'LOCK', lock),
                      patch.object(broker_module, 'LOCK', lock),
                      patch.object(parent, 'prepare', return_value=(self.plan_raw, self.plan, self.probe_base, self.image, directory)),
                      patch.object(supervisor, '_verify_guard_source'),
                      patch.object(parent.ReplacementArmBroker, 'require_source_closure'),
                      patch.object(parent, 'observe', side_effect=slow_observer),
                      patch.object(parent.os, 'getppid', side_effect=staged_parent),
                      patch.object(parent, 'require_write_custody', side_effect=staged_custody),
                      patch.object(parent, 'run_replacement_image', side_effect=abort_image),
                      patch.object(parent, 'remove_container', return_value=False)):
                    if writing:
                        parent.qualify_replacement_write_frontier(initial, self.root)
                    else:
                        parent.supervise_replacement_arm(initial, self.root)
            except BaseException:
                os._exit(1)
            os._exit(0)
        os.close(operator_input)
        os.close(operator_output)
        reaped = False
        try:
            with os.fdopen(send, 'wb') as output, os.fdopen(receive, 'rb', buffering=0) as input_file:
                def response():
                    self.assertTrue(select.select([input_file], [], [], 12)[0], 'no owned host response')
                    return json.loads(input_file.readline())
                def send_frame(value):
                    output.write(parent.encoded(value) + b'\n')
                    output.flush()
                def wait_for_flock():
                    deadline = time.monotonic() + 8
                    while True:
                        try:
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            return
                        except BlockingIOError:
                            self.assertLess(time.monotonic(), deadline, 'owned survivor did not release the host flock')
                            time.sleep(0.05)
                self.assertEqual(response(), {'id': 0, 'status': 'LOCKED'})
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                send_frame({'id': 1, 'operation': 'arm-replacement', 'probe': self.probe})
                ready = response()
                self.assertEqual(ready['status'], 'REPLACEMENT_ARMED')
                self.assertEqual(ready['armReceiptSha256'], migrate.file_hash((directory / parent.ARM).read_bytes()))
                send_frame({'id': 2, 'operation': 'check'})
                self.assertEqual(response(), {'id': 2, 'status': 'LOCKED'})
                if writing:
                    self.assertFalse((directory / parent.WRITE_INTENT).exists())
                    send_frame({'id': 3, 'operation': 'authorize-replacement-write',
                                'armReceiptSha256': ready['armReceiptSha256'], 'emptyCatalogReceipt': self.empty_boundary})
                    if kill_guard in ('before-ready', 'before-reply'):
                        deadline = time.monotonic() + 8
                        while not stage_marker.exists():
                            self.assertLess(time.monotonic(), deadline, 'owned fixture did not reach exact write boundary')
                            time.sleep(0.02)
                        self.assertEqual((directory / parent.WRITE_READY).exists(), kill_guard == 'before-reply')
                        self.assertTrue((directory / parent.WRITE_OBSERVER_STARTED).is_file())
                        self.assertEqual((directory / parent.WRITE_OBSERVER_RETURNED).exists(), kill_guard == 'before-reply')
                    else:
                        acknowledged = response()
                        self.assertEqual(acknowledged['status'], 'REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED')
                        self.assertEqual(acknowledged['writeIntentSha256'],
                                         migrate.file_hash((directory / parent.WRITE_INTENT).read_bytes()))
                        self.assertTrue(all(acknowledged['receipt'][key] is False for key in parent.NO_AUTHORITY))
                        self.assertTrue((directory / parent.WRITE_READY).is_file())
                        self.assertFalse((directory / parent.WRITE_CONTAINMENT).exists())
                else:
                    send_frame({'id': 3, 'operation': 'commit'})
                    terminal = response()
                    self.assertEqual(terminal['status'], 'COMMITTED')
                    self.assertEqual(terminal['receipt']['armReceiptSha256'], ready['armReceiptSha256'])
                    self.assertFalse((directory / parent.TERMINAL).exists())
                    self.assertEqual(json.loads((directory / parent.COMMIT_INTENT).read_bytes())['status'], parent.INTENT_STATUS)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if change_bundle:
                    (self.bundle / 'schema/frontend.json').write_bytes(self.raw_baseline + b' ')
                if kill_guard:
                    os.kill(child, signal.SIGKILL)
                    wait_for_flock()  # Keep operator stdin open during failure containment.
                    self.assertTrue(select.select([input_file], [], [], 2)[0])
                    failed_response = input_file.readline()
                    if failed_response:
                        self.assertEqual(json.loads(failed_response), {'id': 3, 'status': 'P2_HOST_STAGE_FAILED'})
                        self.assertEqual(input_file.read(1), b'')
            _, status = os.waitpid(child, 0)
            reaped = True
            self.assertEqual(os.waitstatus_to_exitcode(status), -signal.SIGKILL if kill_guard else 1 if change_bundle or writing else 0)
            self.assertEqual((directory / parent.TERMINAL).exists(), not change_bundle and not writing)
            wait_for_flock()
            if writing:
                self.assertEqual((directory / parent.ABORT_OBSERVATION).read_bytes(), self.raw_abort)
                contained = json.loads((directory / parent.WRITE_CONTAINMENT).read_bytes())
                if kill_guard == 'before-ready':
                    self.assertEqual(contained['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINMENT_UNCERTAIN')
                    self.assertFalse(contained['processScopeReconciled'])
                    self.assertFalse(contained['observerLauncherReconciled'])
                    self.assertFalse(contained['observerContainerAbsent'])
                    self.assertTrue(contained['backendClosureVerified'])
                else:
                    self.assertEqual(contained['status'], 'P2_FRONTEND_REPLACEMENT_WRITE_CONTAINED_REQUIRES_REVIEW')
                    self.assertTrue(contained['processScopeReconciled'])
                self.assertEqual(contained['appliedPrefixCount'], 1)
                self.assertFalse(contained['automaticReplayAuthorized'])
                self.assertFalse((directory / parent.COMMIT_INTENT).exists())
        finally:
            if not reaped:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)


if __name__ == '__main__':
    unittest.main()
