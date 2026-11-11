import base64
import copy
import json
from unittest import TestCase
from unittest.mock import patch

import migrate
from p2_certification_profile import PROFILE as CERTIFICATION, RUNTIME_FLAGS
import p2_replacement_runtime_review as review
import release
import release_test
import staging_state


def raw(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


class ReplacementRuntimeReviewTests(TestCase):
    def setUp(self):
        fixture = release_test.RuntimeReleaseTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        self.root = fixture.root.resolve()
        self.bundle = fixture.bundle.resolve()
        self.configuration = fixture.configuration.resolve()
        self.source = self.root / 'installed-source'
        self.compose = self.source / 'ops/platform/compose.yaml'
        self.compose.parent.mkdir(parents=True)
        self.compose.write_bytes(fixture.compose.read_bytes())
        for target, field in ((review, 'STAGING_ROOT'), (review.p2_prior_gateway, 'ROOT')):
            root = patch.object(target, field, self.root)
            root.start()
            self.addCleanup(root.stop)

        fixture.fixture.add_frontend()
        profile = fixture.fixture.profiled()
        for carrier in (fixture.fixture.release, fixture.fixture.release['frontendMigration'], *fixture.fixture.jobs.values()):
            carrier.update(contractPhase='p2', phase2ContractManifestSha256='sha256:' + 'e' * 64)
        fixture.fixture.save()
        fixture.target.update(version=2, qualificationTargetProfile=profile)
        fixture.save('runtime.json', fixture.target)
        candidate_sha = migrate.file_hash(migrate.read_input(self.bundle, 'release.candidate.json'))
        fixture.gateway.update(ownerId='team_2Hrn5eMZyZxfAWdmYvyKi9t3', projectId='prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM',
                               publicHost='api-staging.lashher.com',
                               admission={'file': '/admission/state.json', 'releaseId': 'test-release',
                                          'candidateSha256': candidate_sha})
        fixture.save('gateway.json', fixture.gateway)
        for service, flags in RUNTIME_FLAGS.items():
            path = self.configuration / (service + '.env')
            with path.open('a') as stream:
                stream.writelines(f'{name}={value}\n' for name, value in flags.items())

        candidate, jobs, _, _ = release.make_plan(self.bundle, self.configuration, self.compose, expected_profile=profile)
        frontend = jobs['frontend']
        target = {key: frontend['job']['target'][key] for key in review.TARGET_FIELDS}
        predecessor = {**target, 'host': 'predecessor.example.invalid', 'runtimeRole': 'previous_runtime'}
        target_sha = review.frontend_target_sha256(target)
        self.plan = {'qualificationTargetProfile': profile, 'environment': 'staging', 'releaseId': candidate['releaseId'],
                     'sourceCommit': candidate['sources']['frontend']['commit'], 'candidateSha256': candidate_sha,
                     'targetSha256': target_sha,
                     'frontendJobSha256': migrate.file_hash(migrate.read_input(self.bundle, 'jobs/frontend.json')),
                     'schemaBaselineFileSha256': migrate.file_hash(frontend['schema']),
                     'replacement': {'target': target, 'approvedPendingTags': frontend['job']['target']['approvedPendingTags'],
                                     'databaseOid': '41', 'migrationRoleOid': '42'},
                     'predecessor': {'target': predecessor}}
        self.probe = {'version': 1, 'operation': 'verify-pre-bootstrap-lock', 'qualificationTargetProfile': profile,
                      'candidate': candidate, 'job': frontend['job'],
                      'baseline': json.loads(frontend['schema']), 'targetSha256': target_sha, 'predecessorTarget': predecessor,
                      'databaseOid': '41', 'migrationRoleOid': '42'}
        self.initial = {'mode': review.PROFILED_REPLACEMENT_WRITE_MODE, 'qualificationTargetProfile': profile,
                        'environment': 'staging', 'sourceCommit': self.plan['sourceCommit'], 'candidateSha256': candidate_sha,
                        'reviewedPlanSha256': migrate.file_hash(raw(self.plan)), 'hostMachineId': fixture.target['hostMachineId'],
                        'bundle': str(self.bundle), 'credentials': {
                            'FRONTEND_STAGING_MIGRATION_DATABASE_URL': 'owned-frontend-database',
                            'COURSE_STAGING_DATABASE_URL': 'owned-course-database',
                            'COMMUNITY_STAGING_DATABASE_URL': 'owned-community-database',
                        }}
        self.review = {'version': 1, **{key: self.plan[key] for key in ('qualificationTargetProfile', 'environment', 'releaseId',
                                                                     'sourceCommit', 'candidateSha256', 'targetSha256')},
                       **{key: self.initial[key] for key in ('reviewedPlanSha256', 'hostMachineId')},
                       'configuration': str(self.configuration), 'configurationSha256': staging_state.configuration_hashes(self.configuration),
                       'apiJobSha256': migrate.profiled_current_job_hashes(self.bundle), 'certification': CERTIFICATION,
                       'producerSha256': '9' * 64}

    def envelope(self, payload=None, **extra):
        body = raw(self.review) if payload is None else payload
        return {**self.initial, 'runtimeReviewBytes': base64.b64encode(body).decode('ascii'),
                'runtimeReviewSha256': migrate.file_hash(body), **extra}

    def prepare(self, initial=None, probe=None):
        with patch.object(release, 'command', side_effect=AssertionError('unexpected external command')):
            return review.prepare_runtime_review(initial if initial is not None else self.envelope(),
                                                 self.plan, self.source, probe if probe is not None else self.probe)

    def assert_refused(self, initial=None, probe=None):
        with self.assertRaisesRegex(ValueError, f'^{review.REFUSED}$'):
            self.prepare(initial, probe)

    def test_optional_without_inputs_and_exact_read_only_acceptance(self):
        self.assertIsNone(self.prepare(self.initial))
        before = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        selected = self.prepare()
        self.assertEqual(selected, self.review)
        self.assertNotIn('private-fixture', json.dumps(selected))
        self.assertEqual({path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}, before)

    def test_optional_staging_cron_secret_requires_exact_review_and_private_carrier(self):
        secret = 'owned-staging-cron-secret-' + 'x' * 32
        supplied = {**self.review, 'initializeStagingCronSecret': True}
        selected = self.envelope(raw(supplied), credentials={**self.initial['credentials'],
            review.CRON_CREDENTIAL: secret})
        self.assertEqual(self.prepare(selected), supplied)
        for initial in (
            self.envelope(raw(supplied)),
            self.envelope(raw(supplied), credentials={**self.initial['credentials'], review.CRON_CREDENTIAL: 'short'}),
            self.envelope(raw({**self.review, 'initializeStagingCronSecret': False}),
                          credentials={**self.initial['credentials'], review.CRON_CREDENTIAL: secret}),
            self.envelope(credentials={**self.initial['credentials'], review.CRON_CREDENTIAL: secret}),
            self.envelope(raw(supplied), credentials={**self.initial['credentials'], review.CRON_CREDENTIAL: secret,
                                                      'UNEXPECTED_PRIVATE': 'owned'}),
        ):
            self.assert_refused(initial)

    def test_refuses_bad_carrier_scope_and_extra_fields(self):
        encoded = self.envelope()
        cases = [
            {**self.initial, 'runtimeReviewBytes': encoded['runtimeReviewBytes']},
            {**self.initial, 'runtimeReviewSha256': encoded['runtimeReviewSha256']},
            {**encoded, 'runtimeReviewBytes': encoded['runtimeReviewBytes'] + '\n'},
            {**encoded, 'runtimeReviewSha256': '1' * 64},
            {**encoded, 'mode': 'p2-profiled-frontend-replacement-arm'},
            self.envelope(raw({**self.review, 'version': True})),
            self.envelope(raw({**self.review, 'hostMachineId': '9' * 32})),
            self.envelope(raw({**self.review, 'reviewedPlanSha256': '9' * 64})),
            self.envelope(raw({**self.review, 'producerSha256': '0' * 64})),
            self.envelope(raw({**self.review, 'credentials': {}})),
            self.envelope(raw(self.review).replace(b'"version":1', b'"version":1,"version":1', 1)),
        ]
        for index, initial in enumerate(cases):
            with self.subTest(case=index):
                self.assert_refused(initial)

    def test_refuses_stale_jobs_configuration_compose_and_scope(self):
        for path in (self.bundle / 'jobs/community.json', self.configuration / 'course-tls.json', self.compose):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b' ')
                self.assert_refused()
                path.write_bytes(original)
        self.assert_refused(probe={**self.probe, 'migrationRoleOid': '43'})
        old_job = copy.deepcopy(self.probe['job'])
        old_job['target']['approvedPendingTags'] = []
        self.assert_refused(probe={**self.probe, 'job': old_job})

    def test_refuses_unsafe_configuration_even_with_matching_hashes(self):
        for filename, update in (
            ('course-media.env', lambda value: value.replace(b'MUX_MEDIA_RECOVERY_ENABLED=true', b'MUX_MEDIA_RECOVERY_ENABLED=false')),
            ('course-publisher.env', lambda value: value.replace(b'runtime_role:private-fixture', b'migration_role:private-fixture')),
            ('gateway.json', lambda value: raw({**json.loads(value), 'admission': None})),
        ):
            with self.subTest(file=filename):
                path = self.configuration / filename
                original = path.read_bytes()
                path.write_bytes(update(original))
                supplied = {**self.review, 'configurationSha256': staging_state.configuration_hashes(self.configuration)}
                self.assert_refused(self.envelope(raw(supplied)))
                path.write_bytes(original)
        alias = self.root / 'configuration-alias'
        alias.symlink_to(self.configuration, target_is_directory=True)
        self.assert_refused(self.envelope(raw({**self.review, 'configuration': str(alias)})))

    def test_only_accepts_existing_prior_reference_shape(self):
        prior = self.root / 'prior'
        prior.mkdir(mode=0o700)
        reference = {'kind': 'stopped-current-candidate', 'stopReceiptDirectory': str(prior), 'stopReceiptSha256': 'a' * 64}
        supplied = {**self.review, 'priorGatewayReference': reference}
        self.assertEqual(self.prepare(self.envelope(raw(supplied))), supplied)
        for value in (None, {**reference, 'zeroActive': True}, {**reference, 'stopReceiptDirectory': str(prior) + '/'}):
            self.assert_refused(self.envelope(raw({**self.review, 'priorGatewayReference': value})))
