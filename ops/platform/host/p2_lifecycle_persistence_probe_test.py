import json
import base64
import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import p2_lifecycle_persistence_probe as probe
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope
from p2_certification_parent_test import legacy_source_fixture


class PersistenceProbeTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[3]

    def test_private_program_is_exact_source_bound_and_has_fixed_entry(self):
        program = probe.private_program(self.source)
        self.assertLess(len(program), 131_072)
        self.assertIn(b"runPrivatePersistenceProbeFromStdin", program)
        self.assertEqual(program, probe.private_program(self.source))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory).resolve()
            legacy_source_fixture(self.source, destination)
            closure = probe.identity_probe.source_closure(destination)
        self.assertIn(probe.PROGRAM_FILES[0], closure)
        self.assertIn(probe.PROGRAM_FILES[1], closure)

    def profiled_reviewed(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        result = subprocess.run(['node', '--input-type=module', '-e',
            'import {receiverReviewedFixture} from "./ops/platform/p2-lifecycle-receiver-negatives.fixture.mjs";'
            'process.stdout.write(JSON.stringify(receiverReviewedFixture().persistence));'],
            cwd=self.source, capture_output=True, check=True, timeout=10)
        ref, reviewed = copy.deepcopy(dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)), json.loads(result.stdout)
        reviewed.update(version=2, qualificationTargetProfile=copy.deepcopy(ref))
        reviewed['plan'].update(version=2, qualificationTargetProfile=copy.deepcopy(ref))
        for target in reviewed['plan']['targets'].values():
            target['qualificationTargetProfile'] = copy.deepcopy(ref)
        for name in probe.identity_probe.SOURCE_ANCHORS:
            reviewed['operatorSourceFiles'].setdefault(name, 'd' * 64)
        reviewed['plan']['operatorSourceSha256'] = probe._hash(probe._canonical(reviewed['operatorSourceFiles']))
        reviewed['programSha256'] = probe._hash(probe.private_program(self.source, ref))
        return ref, reviewed

    def test_profiled_reviewed_plan_and_raw_source_receipts_require_the_explicit_registered_ref(self):
        ref, reviewed = self.profiled_reviewed()
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(probe, 'ROOT', Path(directory).resolve()):
            reviewed['privateDirectory'] = str(Path(directory).resolve() / 'owned')
            self.assertEqual(probe._reviewed(reviewed, ref)['plan']['version'], 2)
            for change in [lambda value: value.pop('qualificationTargetProfile'),
                           lambda value: value['plan']['targets']['course'].pop('qualificationTargetProfile'),
                           lambda value: value.update(qualificationTargetProfile={**ref, 'sha256': 'f' * 64})]:
                changed = copy.deepcopy(reviewed); change(changed)
                with self.assertRaises(Exception):
                    probe._reviewed(changed, ref)
            with self.assertRaises(Exception):
                probe._reviewed(reviewed)
        common = {'version': 2, 'qualificationTargetProfile': ref, 'environment': 'staging',
                  'releaseId': reviewed['plan']['releaseId'], 'sourceCommit': reviewed['plan']['sources']['frontend']}
        raw = {
            'originalReleaseReceipt': (json.dumps({**common, 'status': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
                'candidateSha256': reviewed['plan']['candidateSha256'], 'frontendWorkloadReceiptSha256': 'b' * 64,
                'trafficAuthorized': False, 'releaseAccepted': False}) + '\n').encode(),
            'frontendDeploymentRecord': (json.dumps({**common, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed',
                'frontendDomainsPromoted': True, 'trafficAuthorized': False}) + '\n').encode(),
        }
        reviewed['plan']['originalReleaseSha256'] = probe._hash(raw['originalReleaseReceipt'])
        reviewed['plan']['frontendDeploymentSha256'] = probe._hash(raw['frontendDeploymentRecord'])
        encoded = {name: base64.b64encode(value).decode() for name, value in raw.items()}
        actual = probe._release_evidence(reviewed, encoded, ref)
        self.assertEqual(actual, raw)
        changed = dict(encoded); changed['frontendDeploymentRecord'] = base64.b64encode(b'{"version":1}\n').decode()
        with self.assertRaises(Exception):
            probe._release_evidence(reviewed, changed, ref)
        wrong = json.dumps({**common, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed',
            'frontendDomainsPromoted': False, 'trafficAuthorized': False}).encode()
        semantic = copy.deepcopy(reviewed)
        semantic['plan']['frontendDeploymentSha256'] = probe._hash(wrong)
        changed = dict(encoded); changed['frontendDeploymentRecord'] = base64.b64encode(wrong).decode()
        with self.assertRaisesRegex(Exception, 'FRONTEND_PROMOTION_RECEIPT_REQUIRED'):
            probe._release_evidence(semantic, changed, ref)

    def test_profiled_private_program_source_selects_current_without_changing_legacy_bytes(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        legacy = probe.private_program(self.source)
        current = probe.private_program(self.source, ref)
        self.assertNotEqual(current, legacy)
        self.assertIn(b'runPrivatePersistenceProbeFromStdin({', current)
        self.assertIn(ref['id'].encode(), current)
        self.assertEqual(current, probe.private_program(self.source, ref))

    def test_reviewed_source_accepts_512_and_refuses_513_with_valid_digests(self):
        result = subprocess.run(['node', '--input-type=module', '-e',
            'import {receiverReviewedFixture} from "./ops/platform/p2-lifecycle-receiver-negatives.fixture.mjs";'
            'process.stdout.write(JSON.stringify(receiverReviewedFixture().persistence));'],
            cwd=self.source, capture_output=True, check=True, timeout=10)
        reviewed = json.loads(result.stdout)
        files = reviewed['operatorSourceFiles']
        for name in probe.identity_probe.SOURCE_ANCHORS:
            files.setdefault(name, 'a' * 64)
        while len(files) < 512:
            files[f'ops/platform/owned-bound-{len(files)}.mjs'] = 'a' * 64
        reviewed['plan']['operatorSourceSha256'] = probe._hash(probe._canonical(files))
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(probe, 'ROOT', Path(directory).resolve()):
            reviewed['privateDirectory'] = str(Path(directory).resolve() / 'owned')
            probe._reviewed(reviewed)
            files['ops/platform/owned-overflow.mjs'] = 'b' * 64
            reviewed['plan']['operatorSourceSha256'] = probe._hash(probe._canonical(files))
            with self.assertRaisesRegex(Exception, 'SOURCE_BINDING_REQUIRED'):
                probe._reviewed(reviewed)

    def test_documented_isolated_entry_loads_fixed_local_modules(self):
        result = subprocess.run([sys.executable, "-I", "-u", str(Path(probe.__file__))], input=b"", capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(b"ModuleNotFoundError", result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "P2_LIFECYCLE_PERSISTENCE_REFUSED")

    def test_subject_binding_covers_private_original_email_without_emitting_it(self):
        base = {"stage": "capture-delete-baseline", "userId": "00000000-0000-4000-8000-000000000001",
            "originalEmail": "owned@example.invalid", "exportCommand": {"commandId": "00000000-0000-4000-8000-000000000002", "accountVersion": 1},
            "attemptIds": ["00000000-0000-4000-8000-000000000003"], "grantIds": ["00000000-0000-4000-8000-000000000004"],
            "streamIds": ["00000000-0000-4000-8000-000000000005"], "inboxEventIds": ["00000000-0000-4000-8000-000000000006"]}
        first = probe._subject_binding(base)
        changed = dict(base, originalEmail="wrong@example.invalid")
        self.assertNotEqual(first, probe._subject_binding(changed))
        self.assertNotIn(base["originalEmail"], first)

    def test_scope_accepts_only_exact_selected_container_program_and_private_stdin(self):
        scope = object.__new__(CurrentLifecyclePersistenceScope)
        scope.reviewed = {"containers": [
            {"service": "course-api", "containerId": "1" * 64, "image": "sha256:" + "1" * 64, "health": "healthy"},
            {"service": "community-api", "containerId": "2" * 64, "image": "sha256:" + "2" * 64, "health": "healthy"}]}
        scope.persistence_program = b"fixed-program"
        payload = json.dumps({"version": 1, "mode": "frontend", "environment": "staging"}).encode()
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=128",
            "--env", "DOTENV_CONFIG_QUIET=true", "1" * 64, "node", "--input-type=module", "--eval", "fixed-program"]
        scope._allowed(args, payload, runtime.SAFE_ENV)
        with self.assertRaises(Exception):
            scope._allowed(args[:-1] + ["changed"], payload, runtime.SAFE_ENV)
        with self.assertRaises(Exception):
            scope._allowed(args, json.dumps({"mode": "shell", "environment": "staging"}).encode(), runtime.SAFE_ENV)

    def test_common_failure_contains_no_private_child_details(self):
        failure = probe.PersistenceFailure("persistence-current-stage-refused").public_receipt
        self.assertEqual(sorted(failure), sorted(["version", "status", "check", "readOnly", "providerTouched", "releaseAccepted"]))
        self.assertNotIn("database", json.dumps(failure).lower())

    def test_selected_jobs_targets_images_and_host_are_exactly_joined(self):
        images = {"gateway": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "1" * 64,
            "courseRuntime": "ghcr.io/princessdardan/lash-her-platform-course-runtime@sha256:" + "2" * 64,
            "communityRuntime": "ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:" + "3" * 64}
        selected = {"environment": "staging", "contractPhase": "p2", "releaseId": "owned",
            "sources": {name: {"commit": digit * 40} for name, digit in (("frontend", "a"), ("course", "b"), ("community", "c"))},
            "artifacts": {name: {"image": image} for name, image in images.items()}}
        jobs = {}
        targets = {}
        for index, service in enumerate(("frontend", "course", "community"), 10):
            selected_target = {"host": service + ".example.invalid", "port": 5432, "database": service + "_staging"}
            job = {"target": selected_target, "runtimeRole": service + "_runtime"}
            if service == "frontend":
                selected_target.update({"runtimeRole": service + "_runtime", "serverMajor": 18})
            target = {**selected_target, "runtimeRole": service + "_runtime", "runtimeRoleOid": str(index), "serverMajor": 18}
            target["targetSha256"] = probe._target_hash(service, target)
            targets[service] = target
            jobs[service] = {"job": job}
        containers = [{"service": service, "containerId": format(index + 1, "064x"),
            "image": selected["artifacts"][runtime.IMAGE_KEYS[service]]["image"], "health": "none" if service.endswith("-tls") else "healthy"}
            for index, service in enumerate(runtime.SERVICES)]
        reviewed = {"plan": {"releaseId": "owned", "hostMachineId": "d" * 32,
            "sources": {name: value["commit"] for name, value in selected["sources"].items()}, "targets": targets,
            "containerImages": {"course": images["courseRuntime"], "community": images["communityRuntime"]}}, "containers": containers}
        probe._join_selected(reviewed, selected, jobs, {"hostMachineId": "d" * 32})
        targets["course"]["database"] = "changed"
        with self.assertRaises(Exception):
            probe._join_selected(reviewed, selected, jobs, {"hostMachineId": "d" * 32})

    def test_profiled_join_requires_candidate3_job2_and_every_target_ref(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, resolve_qualification_target_profile
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        definition = resolve_qualification_target_profile(ref)
        images = {"gateway": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "1" * 64,
            "courseRuntime": "ghcr.io/princessdardan/lash-her-platform-course-runtime@sha256:" + "2" * 64,
            "communityRuntime": "ghcr.io/princessdardan/lash-her-platform-community-runtime@sha256:" + "3" * 64}
        selected = {"version": 3, "qualificationTargetProfile": copy.deepcopy(ref), "environment": "staging",
            "contractPhase": "p2", "releaseId": "owned",
            "sourceApproval": {"qualificationTargetProfile": copy.deepcopy(ref)},
            "integration": {"qualificationTargetProfile": copy.deepcopy(ref)},
            "workload": {"qualificationTargetProfile": copy.deepcopy(ref), "projectId": definition['frontend']['projectId'],
                "environment": definition['frontend']['workloadEnvironment']},
            "approval": {"qualificationTargetProfile": copy.deepcopy(ref)},
            "sources": {name: {"commit": digit * 40, "qualificationTargetProfile": copy.deepcopy(ref)}
                for name, digit in (("frontend", "a"), ("course", "b"), ("community", "c"))},
            "artifacts": {name: {"image": image} for name, image in images.items()}}
        jobs, targets = {}, {}
        for index, service in enumerate(("frontend", "course", "community"), 10):
            selected_target = {"host": service + ".example.invalid", "port": 5432, "database": service + "_staging",
                "qualificationTargetProfile": copy.deepcopy(ref)}
            job = {"qualificationTargetProfile": copy.deepcopy(ref), "target": selected_target,
                "runtimeRole": service + "_runtime"}
            if service == "frontend":
                job["version"] = 2
                selected_target.update({"runtimeRole": service + "_runtime", "serverMajor": 18})
            else:
                job["schemaVersion"] = 2; selected_target["schemaVersion"] = 2
            target = {"host": selected_target["host"], "port": 5432, "database": selected_target["database"],
                "runtimeRole": service + "_runtime", "runtimeRoleOid": str(index), "serverMajor": 18,
                "qualificationTargetProfile": copy.deepcopy(ref)}
            target["targetSha256"] = probe._target_hash(service, target)
            targets[service] = target; jobs[service] = {"job": job, "frontend": service == "frontend"}
        containers = [{"service": service, "containerId": format(index + 1, "064x"),
            "image": selected["artifacts"][runtime.IMAGE_KEYS[service]]["image"],
            "health": "none" if service.endswith("-tls") else "healthy"}
            for index, service in enumerate(runtime.SERVICES)]
        reviewed = {"plan": {"releaseId": "owned", "hostMachineId": "d" * 32,
            "sources": {name: value["commit"] for name, value in selected["sources"].items()}, "targets": targets,
            "containerImages": {"course": images["courseRuntime"], "community": images["communityRuntime"]}},
            "containers": containers}
        runtime_plan = {"hostMachineId": "d" * 32, "qualificationTargetProfile": copy.deepcopy(ref)}
        probe._join_selected(reviewed, selected, jobs, runtime_plan, ref)
        changed = copy.deepcopy(jobs); changed['community']['job']['target'].pop('qualificationTargetProfile')
        with self.assertRaisesRegex(Exception, 'QUALIFICATION_TARGET_PROFILE'):
            probe._join_selected(reviewed, selected, changed, runtime_plan, ref)

    def test_owned_scope_brackets_receiver_reads_with_stable_frontend(self):
        scope = object.__new__(CurrentLifecyclePersistenceScope)
        modes = []
        scope.runtime_bound = True
        scope.verify = lambda: None
        scope.verify_runtime = lambda: None
        scope.run_persistence = lambda mode, _payload: modes.append(mode) or object()
        values = [
            {"service": "frontend", "observation": {"now": "2026-11-06T00:00:00.000Z", "state": "fixed"}},
            {"service": "course", "observation": {"state": "fixed"}},
            {"service": "community", "observation": {"state": "fixed"}},
            {"service": "frontend", "observation": {"now": "2026-11-06T00:00:01.000Z", "state": "fixed"}},
            {"witness": {"private": True}, "privateEvidence": None, "receipt": {"status": "fixed"}},
        ]
        plan = {"targets": {name: {} for name in ("frontend", "course", "community")}}
        with mock.patch.object(probe, "_parse_child", side_effect=values):
            result = probe.observe_with_scope(plan, {}, scope, "private-url")
        self.assertEqual(modes, ["frontend", "course", "community", "frontend", "combine"])
        self.assertEqual(result["observations"]["frontend"]["state"], "fixed")

        changed = list(values)
        changed[3] = {"service": "frontend", "observation": {"now": "2026-11-06T00:00:01.000Z", "state": "changed"}}
        modes.clear()
        with mock.patch.object(probe, "_parse_child", side_effect=changed), self.assertRaises(Exception):
            probe.observe_with_scope(plan, {}, scope, "private-url")

    def test_profiled_owned_scope_keeps_ref_on_every_private_child_and_sanitizes_observations(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        scope = object.__new__(probe.HeldCertificationPersistenceScope)
        scope.runtime_bound = True; scope.verify = lambda: None; scope.verify_runtime = lambda: None
        payloads = []
        def run(mode, payload):
            payloads.append(copy.deepcopy(payload))
            if mode == 'combine':
                value = {'version': 2, 'qualificationTargetProfile': ref,
                         'status': 'P2_LIFECYCLE_PERSISTENCE_PRIVATE_COMBINED', 'readOnly': True,
                         'witness': {}, 'privateEvidence': None, 'receipt': {'status': 'fixed'}}
            else:
                value = {'version': 2, 'qualificationTargetProfile': ref,
                         'status': 'P2_LIFECYCLE_PERSISTENCE_PRIVATE_OBSERVATION', 'readOnly': True,
                         'service': mode, 'observation': {'state': 'fixed'}}
            return subprocess.CompletedProcess([], 0, json.dumps(value).encode(), b'')
        scope.run_persistence = run
        target = {'qualificationTargetProfile': ref}
        plan = {'version': 2, 'qualificationTargetProfile': ref,
                'targets': {name: copy.deepcopy(target) for name in ('frontend', 'course', 'community')}}
        result = probe.observe_with_scope(plan, {}, scope, 'private-url', expected_profile=ref)
        self.assertEqual(result['receipt'], {'status': 'fixed'})
        self.assertEqual(len(payloads), 5)
        self.assertTrue(all(value['version'] == 2 and value['qualificationTargetProfile'] == ref for value in payloads))

    def test_certification_reader_reuses_exact_parent_scope_and_current_database_proof(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        from p2_certification_parent import P2CertificationScope
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        parent = object.__new__(P2CertificationScope)
        parent.require_release = mock.Mock(); parent.require_frontend = mock.Mock(); parent.require_configuration = mock.Mock()
        parent.run = mock.Mock(return_value=subprocess.CompletedProcess([], 0, b'{}', b''))
        selected, jobs, proof = {'releaseId': 'owned'}, {'frontend': {}}, object()
        reviewed = {'containers': [{'service': service, 'containerId': format(index + 1, '064x'),
            'image': 'owned@sha256:' + 'a' * 64, 'health': 'none' if service.endswith('-tls') else 'healthy'}
            for index, service in enumerate(runtime.SERVICES)]}
        verify_inputs = mock.Mock()
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(probe.current_databases, 'read_certification_api_proof') as read_proof:
            held = probe.HeldCertificationPersistenceScope(parent, selected, jobs, reviewed, Path(directory), self.source,
                proof, ref, verify_inputs)
            with mock.patch.object(runtime, 'check_containers', return_value=reviewed['containers']) as containers:
                held.bind_runtime()
            containers.assert_called_once_with(selected, Path(directory), expected_profile=ref)
            read_proof.assert_called()
            parent.require_release.assert_called_with(selected, jobs)
            verify_inputs.assert_called()
            with self.assertRaisesRegex(ValueError, 'PARENT_LOCK_NOT_OWNED'):
                held.close()

    def test_profiled_execution_binds_source_receipts_and_excludes_private_identity(self):
        from p2_certification_parent import P2CertificationScope
        ref, reviewed = self.profiled_reviewed()
        original_email = 'private-owner@example.invalid'
        witness = {'stage': 'capture-export-ready', 'userId': '00000000-0000-4000-8000-000000000001',
                   'originalEmail': original_email,
                   'exportCommand': {'commandId': '00000000-0000-4000-8000-000000000002', 'accountVersion': 1},
                   'attemptIds': ['00000000-0000-4000-8000-000000000003'],
                   'grantIds': ['00000000-0000-4000-8000-000000000004'],
                   'streamIds': ['00000000-0000-4000-8000-000000000005'],
                   'inboxEventIds': ['00000000-0000-4000-8000-000000000006']}
        private = {'frontendRuntimeDatabaseUrl': 'postgresql://private-never-retained', 'witness': witness}
        common = {'version': 2, 'qualificationTargetProfile': ref, 'environment': 'staging',
                  'releaseId': reviewed['plan']['releaseId'], 'sourceCommit': reviewed['plan']['sources']['frontend']}
        raw = {
            'originalReleaseReceipt': (json.dumps({**common, 'status': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
                'candidateSha256': reviewed['plan']['candidateSha256'], 'frontendWorkloadReceiptSha256': 'b' * 64,
                'trafficAuthorized': False, 'releaseAccepted': False}) + '\n').encode(),
            'frontendDeploymentRecord': (json.dumps({**common, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed',
                'frontendDomainsPromoted': True, 'trafficAuthorized': False}) + '\n').encode(),
        }
        reviewed['plan']['originalReleaseSha256'] = probe._hash(raw['originalReleaseReceipt'])
        reviewed['plan']['frontendDeploymentSha256'] = probe._hash(raw['frontendDeploymentRecord'])
        evidence = {name: base64.b64encode(value).decode() for name, value in raw.items()}
        selected, jobs, runtime_plan, proof = {'releaseId': 'owned'}, {'frontend': {}}, {}, object()
        parent = object.__new__(P2CertificationScope)
        parent.require_release = mock.Mock(); parent.require_frontend = mock.Mock(); parent.require_configuration = mock.Mock()
        parent.run = mock.Mock()
        reviewed['plan']['hostMachineId'] = '1' * 32
        combined = {'witness': {'private': 'retained-only'}, 'privateEvidence': None,
                    'receipt': {'version': 1, 'status': 'P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED', 'readOnly': True}}
        original_read_text = Path.read_text
        def read_text(path, *args, **kwargs):
            return '1' * 32 if str(path) == '/etc/machine-id' else original_read_text(path, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(probe, 'ROOT', Path(directory).resolve()), \
                mock.patch.object(Path, 'read_text', read_text), \
                mock.patch.object(probe, '_make_plan_details', return_value=({}, selected, jobs, runtime_plan)), \
                mock.patch.object(probe.current_databases, 'read_certification_api_proof') as read_proof, \
                mock.patch.object(probe.identity_probe, 'source_closure', return_value=reviewed['operatorSourceFiles']), \
                mock.patch.object(probe.identity_probe, '_configuration_hash', return_value=reviewed['plan']['configurationSha256']), \
                mock.patch.object(runtime, 'assert_host'), \
                mock.patch.object(runtime, 'check_containers', return_value=reviewed['containers']), \
                mock.patch.object(probe, 'observe_with_scope', return_value=combined), \
                mock.patch.object(probe, '_retain', return_value='9' * 64):
            reviewed['privateDirectory'] = str(Path(directory).resolve() / 'private')
            result = probe.execute_profiled(directory, directory, reviewed, self.source, private, evidence,
                parent, proof, expected_profile=ref)
        self.assertEqual(result['version'], 2); self.assertEqual(result['qualificationTargetProfile'], ref)
        self.assertNotIn(original_email, json.dumps(result)); self.assertNotIn('postgresql://', json.dumps(result))
        self.assertEqual(private['frontendRuntimeDatabaseUrl'], '')
        self.assertGreaterEqual(read_proof.call_count, 1)

    def test_profiled_execution_sanitizes_early_refusal_and_drops_private_url(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        private = {'frontendRuntimeDatabaseUrl': 'postgresql://private-never-retained', 'witness': {}}
        with self.assertRaises(probe.PersistenceFailure) as failure:
            probe.execute_profiled(None, None, {}, self.source, private, {}, None, None,
                expected_profile=dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE))
        self.assertEqual(failure.exception.public_receipt['check'], 'persistence-profiled-current-stage-refused')
        self.assertEqual(private['frontendRuntimeDatabaseUrl'], '')

    def test_exclusive_private_records_chain_from_retained_bytes(self):
        with tempfile.TemporaryDirectory() as parent:
            os.chmod(parent, 0o700)
            directory = Path(parent) / "case"
            plan = {"candidateSha256": "2" * 64}
            record = {"version": 1, "stage": "capture-export-ready", "subjectBindingSha256": "1" * 64,
                "contextSha256": probe._context_binding(plan), "witness": {}, "privateEvidence": {}, "receipt": {}, "priorRecordSha256": None}
            retained = probe._retain(directory, "capture-export-ready", record)
            loaded = probe.load_retained_capture(plan, directory, "capture-export-ready", "1" * 64)
            actual, digest = loaded["record"], loaded["recordSha256"]
            self.assertEqual(digest, retained)
            self.assertEqual(actual, record)
            with self.assertRaises(Exception):
                probe.load_retained_capture({"candidateSha256": "3" * 64}, directory, "capture-export-ready", "1" * 64)
            with self.assertRaises(FileExistsError):
                probe._retain(directory, "capture-export-ready", record)


if __name__ == "__main__":
    unittest.main()
