import json
import base64
import copy
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import p2_lifecycle_persistence_probe as probe
from p2_lifecycle_persistence_scope import (
    CurrentLifecyclePersistenceScope, PERSISTENCE_PROGRAM_CHUNK, PERSISTENCE_PROGRAM_LOADER,
    PERSISTENCE_PROGRAM_MAXIMUM, persistence_program_arguments,
)


class PersistenceProbeTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[3]

    def test_private_program_is_exact_source_bound_and_has_fixed_entry(self):
        program = probe.private_program(self.source)
        self.assertLessEqual(len(program), PERSISTENCE_PROGRAM_MAXIMUM)
        self.assertIn(b"runPrivatePersistenceProbeFromStdin", program)
        self.assertEqual(program, probe.private_program(self.source))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory).resolve()
            for name in sorted(set(probe.PROGRAM_FILES) | set(probe.identity_probe.SOURCE_ANCHORS)):
                target = destination / name; target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.source / name, target)
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
        reviewed['plan']['operatorSourceSha256'] = probe._source_manifest_digest(reviewed['operatorSourceFiles'], ref)
        reviewed['programSha256'] = probe._hash(probe.private_program(self.source, ref))
        return ref, reviewed

    def test_profiled_reviewed_plan_and_raw_source_receipts_require_the_explicit_registered_ref(self):
        ref, reviewed = self.profiled_reviewed()
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(probe, 'ROOT', Path(directory).resolve()):
            reviewed['privateDirectory'] = str(Path(directory).resolve() / 'owned')
            self.assertEqual(probe._reviewed(reviewed, ref)['plan']['version'], 2)
            map_digest = copy.deepcopy(reviewed)
            map_digest['plan']['operatorSourceSha256'] = probe._hash(probe._canonical(map_digest['operatorSourceFiles']))
            self.assertNotEqual(map_digest['plan']['operatorSourceSha256'], reviewed['plan']['operatorSourceSha256'])
            with self.assertRaisesRegex(Exception, 'SOURCE_BINDING_REQUIRED'):
                probe._reviewed(map_digest, ref)
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

    def test_current_source_programs_embed_the_fixed_profile_dependency_with_lane_specific_arguments(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        legacy = probe.private_program(self.source)
        current = probe.private_program(self.source, ref)
        self.assertNotEqual(current, legacy)
        self.assertIn(b'runPrivatePersistenceProbeFromStdin({', current)
        self.assertIn(ref['id'].encode(), current)
        self.assertEqual(current, probe.private_program(self.source, ref))

    def test_v1_and_v2_private_programs_are_self_contained_and_run_the_actual_stdin_entry(self):
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        ref = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        for expected in (None, ref):
            program = probe.private_program(self.source, expected)
            args = persistence_program_arguments(program)
            self.assertEqual(args[:5], ['node', '--input-type=module', '--eval', PERSISTENCE_PROGRAM_LOADER, '--'])
            self.assertTrue(all(0 < len(chunk) <= PERSISTENCE_PROGRAM_CHUNK for chunk in args[5:]))
            self.assertEqual("".join(args[5:]).encode("ascii"), program)
            encoded = program.split(b'import("data:text/javascript;base64,', 1)[1].split(b'")', 1)[0]
            module = base64.b64decode(encoded, validate=True)
            self.assertIn(b'export async function runPrivatePersistenceProbeFromStdin(', module)
            self.assertEqual(program, probe.private_program(self.source, expected))
            payload = {} if expected is None else {'qualificationTargetProfile': ref, 'target': {'qualificationTargetProfile': ref}}
            invoked = subprocess.run(args, input=json.dumps(payload).encode(), capture_output=True, timeout=10)
            self.assertEqual(invoked.returncode, 1, invoked.stderr)
            result = json.loads(invoked.stdout)
            self.assertEqual(result['version'], 1); self.assertEqual(result['status'], 'P2_LIFECYCLE_PERSISTENCE_PRIVATE_REFUSED')
            self.assertEqual(result['check'], 'private-child-mode')

    def test_private_program_refuses_oversized_argument_total(self):
        read = probe._read
        extra = b"\n// " + b"x" * 160_000
        def selected(source, name, bound=524_288):
            return read(source, name, bound) + (extra if name == probe.PROGRAM_FILES[1] else b"")
        with mock.patch.object(probe, '_read', side_effect=selected):
            with self.assertRaisesRegex(ValueError, 'P2_PERSISTENCE_PRIVATE_PROGRAM_ARGUMENT_BOUND'):
                probe.private_program(self.source)
        with self.assertRaisesRegex(ValueError, 'P2_PERSISTENCE_PRIVATE_PROGRAM_ARGUMENT_BOUND'):
            persistence_program_arguments(b"x" * (PERSISTENCE_PROGRAM_MAXIMUM + 1))

    def test_profiled_reviewed_source_accepts_544_while_legacy_stays_at_512(self):
        ref, reviewed = self.profiled_reviewed()
        files = reviewed['operatorSourceFiles']
        while len(files) < 544:
            files[f'ops/platform/harness/profiled-bound-{len(files)}.mjs'] = 'a' * 64
        reviewed['plan']['operatorSourceSha256'] = probe._source_manifest_digest(files, ref)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(probe, 'ROOT', Path(directory).resolve()):
            reviewed['privateDirectory'] = str(Path(directory).resolve() / 'owned')
            probe._reviewed(reviewed, ref)
            files['ops/platform/harness/profiled-overflow.mjs'] = 'b' * 64
            reviewed['plan']['operatorSourceSha256'] = probe._source_manifest_digest(files, ref)
            with self.assertRaisesRegex(Exception, 'SOURCE_BINDING_REQUIRED'):
                probe._reviewed(reviewed, ref)

    def test_profiled_source_closure_uses_the_named_current_verifier_not_the_legacy_512_reader(self):
        ref, reviewed = self.profiled_reviewed()
        expected = probe._source_manifest_digest(reviewed['operatorSourceFiles'], ref)
        with mock.patch.object(probe.identity_probe, 'source_closure', side_effect=AssertionError('legacy closure used')), \
                mock.patch('p2_source_closure.verify_profiled_current_source_closure', return_value=expected) as verify:
            self.assertEqual(probe._source_closure(self.source, reviewed, ref), reviewed['operatorSourceFiles'])
        selected, root = verify.call_args.args
        self.assertEqual(selected['mode'], 'p2-bounded-certification-profiled-current')
        self.assertEqual(selected['sourceClosureSha256'], expected); self.assertEqual(root, self.source)

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
            entry_digest = copy.deepcopy(reviewed)
            entry_digest['plan']['operatorSourceSha256'] = probe._hash(json.dumps(sorted(files.items()), separators=(',', ':')).encode())
            with self.assertRaisesRegex(Exception, 'SOURCE_BINDING_REQUIRED'):
                probe._reviewed(entry_digest)
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
            "--env", "DOTENV_CONFIG_QUIET=true", "1" * 64, "node", "--input-type=module", "--eval",
            PERSISTENCE_PROGRAM_LOADER, "--", "fixed-program"]
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
                mock.patch.object(probe, '_source_closure', return_value=reviewed['operatorSourceFiles']), \
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

    def scoped_persistence_fixture(self, directory, stage):
        from p2_certification_parent import (
            P2CertificationScope, P2ProfiledCertificationBroker, _canonical, _profiled_plan_hash,
        )
        ref, reviewed = self.profiled_reviewed()
        reviewed['privateDirectory'] = str(directory / 'private')
        plan = reviewed['plan']
        source = plan['sources']['frontend']
        release_id = plan['releaseId']
        selected = {'releaseId': release_id}
        witness = {'stage': stage, 'userId': '00000000-0000-4000-8000-000000000001',
            'originalEmail': 'owned-private@example.invalid', 'exportCommand': {'commandId': 'owned-export'},
            'attemptIds': [], 'grantIds': [], 'streamIds': [], 'inboxEventIds': []}
        private = {'frontendRuntimeDatabaseUrl': 'postgresql://owned-private-canary', 'witness': witness}
        identity = {'version': 2, 'qualificationTargetProfile': ref, 'environment': 'staging',
            'releaseId': release_id, 'sourceCommit': source}
        original = {**identity, 'status': 'P2_PROFILED_CURRENT_READY_FOR_CERTIFICATION',
            'candidateSha256': plan['candidateSha256'], 'frontendWorkloadReceiptSha256': 'c' * 64,
            'trafficAuthorized': False, 'releaseAccepted': False}
        promotion = {**identity, 'status': 'FRONTEND_DOMAINS_PROMOTED', 'phase': 'completed',
            'frontendDomainsPromoted': True, 'trafficAuthorized': False}
        original_raw, promotion_raw = (json.dumps(value).encode() + b'\n' for value in (original, promotion))
        plan.update(originalReleaseSha256=probe._hash(original_raw), frontendDeploymentSha256=probe._hash(promotion_raw))
        cert = {'mode': 'lifecycle-persistence', 'startState': 'already-closed', 'initialEpoch': '3',
            'scopedAction': {'stage': stage, 'subjectBindingSha256': probe._subject_binding(witness)},
            'persistenceReaderEligible': True, 'persistenceReviewedSha256': probe._hash(_canonical(reviewed)),
            'sourceCommit': source, 'operatorSourceCommit': source, 'candidateSha256': plan['candidateSha256'],
            'configurationCanonicalSha256': plan['configurationSha256'], 'originalReleaseId': release_id,
            'operatorSourceClosureSha256': plan['operatorSourceSha256'], 'certificationActionId': 'owned-certification',
            'runtimeInventorySha256': probe._hash(_canonical(reviewed['containers'])),
            'originalReleaseReceiptSha256': plan['originalReleaseSha256'],
            'readyReceiptSha256': {'frontend-promotion-outcome.json': plan['frontendDeploymentSha256']}}
        jobs = {name: {'job': {'target': {'serverMajor': target['serverMajor']}}, 'image': 'owned-' + name}
                for name, target in plan['targets'].items()}
        output = directory / 'api'
        output.mkdir()
        databases, job_hashes = {}, {}
        for name in ('course', 'community'):
            path = output / (name + '-input')
            path.mkdir()
            raw_job = json.dumps(jobs[name]['job']).encode()
            (path / 'job.json').write_bytes(raw_job)
            job_hashes[name] = probe._hash(raw_job)
            path = output / name
            path.mkdir()
            migrate.write_json(path, 'database-receipt.json', {**identity, 'manifestSha256': job_hashes[name]})
            databases[name] = {'image': jobs[name]['image'], 'jobSha256': job_hashes[name],
                'receiptSha256': probe._hash((path / 'database-receipt.json').read_bytes())}
        cert['apiJobSha256'] = job_hashes
        cert['planSha256'] = _profiled_plan_hash(cert)
        scope = object.__new__(P2CertificationScope)
        scope._expected_profile, scope.certification_plan, scope.candidate_sha256 = ref, cert, plan['candidateSha256']
        scope.require_release, scope.require_configuration, scope.verify = mock.Mock(), mock.Mock(), mock.Mock()
        target = plan['targets']['frontend']
        scope.require_frontend = mock.Mock(return_value={'runtime': {'name': target['runtimeRole'], 'oid': target['runtimeRoleOid']}})
        frontend = {'epoch': '3', 'newWork': False, 'recovery': False, 'active': 0, 'uncertain': 0}
        gateway = {'faultLeasePresent': False, 'admission': {'valid': True, 'newWork': False, 'recovery': False,
            'active': {'newWork': 0, 'recovery': 0}, 'uncertain': {'newWork': 0, 'recovery': 0}}}
        scope._physical_observer = mock.Mock()
        scope._physical_observer.probe.return_value = {'admission': frontend}
        outcome = {**identity, 'status': 'P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED', 'phase': 'completed',
            'migrationsExecuted': False, 'frontendSqlApplied': False, 'trafficAuthorized': False,
            'candidateSha256': plan['candidateSha256'], 'certificationActionId': cert['certificationActionId'], 'databases': databases}
        migrate.write_json(output, 'certification-current-databases-outcome.json', outcome)
        proof = probe.current_databases.CertificationCurrentDatabaseProof(probe.current_databases._CERTIFICATION_PROOF_AUTHORITY,
            scope, selected, jobs, output, outcome)
        broker = object.__new__(P2ProfiledCertificationBroker)
        broker.scope, broker.observer, broker.api_proof = scope, scope._physical_observer, proof
        broker.guard_arm_verified = broker.external_armed = True
        broker.bundle, broker.configuration, broker.source = directory / 'bundle', directory / 'configuration', self.source
        broker.selected, broker.jobs, broker.runtime_current = selected, jobs, copy.deepcopy(reviewed['containers'])
        broker.check, broker.require_scoped_native_off = mock.Mock(), mock.Mock()
        broker._gateway_current = mock.Mock(return_value=gateway)
        broker.initial = {'persistenceReviewed': reviewed, 'persistencePrivate': private, 'certificationPlan': copy.deepcopy(cert),
            'sourceClosureSha256': plan['operatorSourceSha256'], 'sourceSha256': reviewed['operatorSourceFiles'],
            'candidateSha256': plan['candidateSha256'], 'hostMachineId': plan['hostMachineId'],
            'originalReleaseReceipt': base64.b64encode(original_raw).decode(),
            'readyReceipts': {'frontend-promotion-outcome.json': base64.b64encode(promotion_raw).decode()}}
        return broker, private, frontend, gateway, output

    def replacement_persistence_fixture(self, directory):
        from p2_certification_parent import _canonical, _profiled_plan_hash
        from p2_replacement_terminal import FALSE_FLAGS, TERMINAL_STATUS
        broker, private, _frontend, _gateway, _output = self.scoped_persistence_fixture(directory, 'capture-export-ready')
        initial, scope = broker.initial, broker.scope
        reviewed, cert = initial['persistenceReviewed'], scope.certification_plan
        plan = reviewed['plan']
        configuration = {'runtime.json': '1' * 64, 'gateway.json': '2' * 64}
        plan['configurationSha256'] = cert['configurationCanonicalSha256'] = probe._hash(probe._canonical(configuration))
        ref = scope._expected_profile
        source = cert['sourceCommit']
        target = plan['targets']['frontend']
        native = {'owner': {'name': 'owned_owner', 'oid': '51'},
                  'producer': {'producerSha256': '5' * 64, 'role': {'name': target['runtimeRole'], 'oid': target['runtimeRoleOid']}},
                  'deploymentId': 'dpl_ownedReplacement', 'projectId': 'prj_owned'}
        descriptor = {'version': 1, 'kind': 'frontend-replacement', 'qualificationTargetProfile': ref,
                      'reviewedPlanSha256': '3' * 64, 'runtimeReviewSha256': '4' * 64, 'postflightSha256': '6' * 64,
                      'frontendSessionClosedSha256': '7' * 64, 'frontendDatabaseReceiptSha256': '8' * 64,
                      'databaseOid': '50', 'migrationRoleOid': '52', 'predecessorRuntimeRole': 'owned_prior', 'administrativeLogins': []}
        contract = {'contractPhase': 'p2', 'phase2ContractManifestSha256': 'sha256:' + 'd' * 64}
        cert.update(replacementRelease=descriptor, targetSha256='9' * 64, nativePlan=native,
                    originalReleasePlanSha256=descriptor['reviewedPlanSha256'], **contract)
        promotion = {**json.loads(base64.b64decode(initial['readyReceipts']['frontend-promotion-outcome.json'])),
                     'projectId': native['projectId'], 'deploymentId': native['deploymentId'], 'gatewayTrafficAuthorized': False}
        from p2_lifecycle_suspension_evidence import READY_FILES
        identity = {key: promotion[key] for key in ('version', 'qualificationTargetProfile', 'environment', 'releaseId',
                                                   'sourceCommit', 'projectId', 'deploymentId')}
        feature = {'INTEGRATION_CHECKOUT_ENABLED': False}
        writer = {'mode': 'enforce', 'targetSha256': cert['targetSha256'],
                  'producerSha256': native['producer']['producerSha256'], 'sourceCommit': source,
                  'roleName': native['producer']['role']['name']}
        ready = {name: {**identity} for name in READY_FILES}
        ready['frontend-promotion-outcome.json'] = promotion
        ready['frontend-workload-outcome.json'].update(status='FRONTEND_VERIFIED', featureControls=feature,
                                                       writerAdmissionBinding=writer, trafficAuthorized=False, nativeSchedulerVerified=False)
        ready_raw = {name: json.dumps(value).encode() + b'\n' for name, value in ready.items()}
        promotion_raw = ready_raw['frontend-promotion-outcome.json']
        cert['readyReceiptSha256'] = {name: probe._hash(raw) for name, raw in ready_raw.items()}
        plan['frontendDeploymentSha256'] = cert['readyReceiptSha256']['frontend-promotion-outcome.json'] = probe._hash(promotion_raw)
        workload_sha = cert['readyReceiptSha256']['frontend-workload-outcome.json']
        original = {'version': 2, 'qualificationTargetProfile': ref, 'status': TERMINAL_STATUS, 'environment': 'staging',
                    'releaseId': plan['releaseId'], 'sourceCommit': source, 'candidateSha256': plan['candidateSha256'],
                    'targetSha256': cert['targetSha256'], 'configurationSha256': configuration,
                    **{key: value for key, value in descriptor.items() if key.endswith('Sha256')},
                    'frontendSessionClosed': True, 'migrationMode': 'apply-forward', 'frontendSqlApplied': True,
                    'owner': native['owner'], 'runtime': native['producer']['role'], 'producerSha256': native['producer']['producerSha256'],
                    'deploymentId': native['deploymentId'], 'frontendWorkloadReceiptSha256': workload_sha,
                    'frontendPromotionReceiptSha256': probe._hash(promotion_raw), **dict.fromkeys(FALSE_FLAGS, False), **contract}
        original_raw = json.dumps(original).encode() + b'\n'
        def attest(raw):
            probe.demand(raw == original_raw, "OWNED_GUARDIAN_TERMINAL_CHANGED")
            return copy.deepcopy(original)
        scope.require_replacement_original = mock.Mock(side_effect=attest)
        initial['readyReceipts'] = {name: base64.b64encode(raw).decode() for name, raw in ready_raw.items()}

        def bind_original(raw):
            plan['originalReleaseSha256'] = cert['originalReleaseReceiptSha256'] = probe._hash(raw)
            cert['persistenceReviewedSha256'] = probe._hash(_canonical(reviewed))
            cert['planSha256'] = _profiled_plan_hash(cert)
            initial['certificationPlan'] = copy.deepcopy(cert)
            initial['originalReleaseReceipt'] = base64.b64encode(raw).decode()
            return {'originalReleaseReceipt': initial['originalReleaseReceipt'],
                    'frontendDeploymentRecord': initial['readyReceipts']['frontend-promotion-outcome.json']}

        return broker, private, reviewed, original, original_raw, bind_original

    def test_replacement_evidence_requires_held_lifecycle_stage_and_exact_guardian_terminal(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            with mock.patch.object(probe, 'ROOT', directory):
                broker, private, reviewed, _original, raw, bind_original = self.replacement_persistence_fixture(directory)
                evidence = bind_original(raw)
                ref, scope = broker.scope._expected_profile, broker.scope
                for selected_profile in (None, ref):
                    with self.assertRaisesRegex(Exception, 'ORIGINAL_RELEASE_RECEIPT_REQUIRED'):
                        probe._release_evidence(reviewed, evidence, selected_profile)
                with self.assertRaisesRegex(Exception, 'REPLACEMENT_HELD_SCOPE_REQUIRED'):
                    probe.HeldCertificationPersistenceScope.release_evidence(scope, reviewed, evidence, ref)
                component = probe.P2ScopedLifecyclePersistenceStage(broker)
                result = {'version': 2, 'qualificationTargetProfile': ref, 'status': probe.SCOPED_PERSISTENCE_STATUS['capture-export-ready'],
                          'readOnly': True, 'providerTouched': False, 'releaseAccepted': False}
                with mock.patch.object(probe, 'execute_profiled', return_value=result) as reader:
                    self.assertIs(component.observe(), result)
                    self.assertEqual(reader.call_args.args[5], evidence)
                    self.assertIs(reader.call_args.args[6], scope)
                    self.assertEqual(reader.call_args.kwargs['_scoped_stage'], component)
                scope.require_replacement_original.assert_called_once_with(raw)
                self.assertEqual(private, {})

    def test_replacement_evidence_refuses_review_rehash_and_wrong_join_before_reader(self):
        changes = {
            'rehashed original': lambda _original, raw: raw + b' ',
            'wrong deployment': lambda original, raw: original.update(deploymentId='dpl_other') or raw,
            'wrong provenance': lambda original, raw: original.update(postflightSha256='0' * 64) or raw,
            'sql replay': lambda original, raw: original.update(frontendSqlReplayed=True) or raw,
            'historical claim': lambda original, raw: original.update(historicalProviderClosureClaimed=True) or raw,
        }
        for name, mutate in changes.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp).resolve()
                with mock.patch.object(probe, 'ROOT', directory):
                    broker, private, _reviewed, original, raw, bind_original = self.replacement_persistence_fixture(directory)
                    selected = mutate(original, raw)
                    bind_original(selected)
                    component = probe.P2ScopedLifecyclePersistenceStage(broker)
                    with mock.patch.object(probe, 'execute_profiled') as reader:
                        with self.assertRaises(probe.PersistenceFailure):
                            component.observe()
                        reader.assert_not_called()
                    broker.scope.require_replacement_original.assert_called_once_with(selected)
                    self.assertEqual(private, {})

    def test_replacement_suspension_evidence_uses_exact_browser_or_worker_plan(self):
        import p2_lifecycle_suspension_evidence as suspension
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            with mock.patch.object(probe, 'ROOT', directory):
                broker, _private, reviewed, original, raw, bind_original = self.replacement_persistence_fixture(directory)
                bind_original(raw)
                cert, ref = broker.scope.certification_plan, broker.scope._expected_profile
                workload = json.loads(base64.b64decode(broker.initial['readyReceipts']['frontend-workload-outcome.json']))
                plan = {'releaseId': original['releaseId'], 'sourceCommit': original['sourceCommit'],
                        'deploymentId': original['deploymentId'], 'configurationRecordSha256': original['frontendWorkloadReceiptSha256'],
                        'featureControls': workload['featureControls'], 'writerAdmissionBinding': workload['writerAdmissionBinding']}
                plan_sha = suspension.digest(suspension.canonical(plan))
                carrier = {key: broker.initial[key] for key in ('originalReleaseReceipt', 'readyReceipts')}
                for mode in ('browser-pending', 'direct-worker'):
                    with self.subTest(mode=mode):
                        cert.update(mode=mode, browserPlanSha256=plan_sha, workerPlan={'suspensionPlanSha256': plan_sha})
                        result = suspension._release_evidence(broker.scope, reviewed, plan, carrier, ref)
                        self.assertEqual(result['originalReleaseReceiptSha256'], probe._hash(raw))
                        with self.assertRaisesRegex(ValueError, 'REPLACEMENT_HELD_PLAN_REQUIRED'):
                            suspension._release_evidence(broker.scope, reviewed, {**plan, 'deploymentId': 'dpl_wrong'}, carrier, ref)
                cert['mode'] = 'known-ack-recovery'
                with self.assertRaisesRegex(ValueError, 'REPLACEMENT_HELD_PLAN_REQUIRED'):
                    suspension._release_evidence(broker.scope, reviewed, plan, carrier, ref)
                self.assertEqual(broker.scope.require_replacement_original.call_args_list, [mock.call(raw), mock.call(raw)])

    def test_replacement_direct_worker_requires_attempted_stage_bound_to_scope_and_review(self):
        from p2_lifecycle_worker_evidence import P2LifecycleWorkerEvidenceStage
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp).resolve()
            with mock.patch.object(probe, 'ROOT', directory):
                broker, _private, reviewed, _original, raw, bind_original = self.replacement_persistence_fixture(directory)
                evidence = bind_original(raw)
                scope, ref = broker.scope, broker.scope._expected_profile
                scope.certification_plan.update(mode='direct-worker', workerPlan={'actionId': 'owned-worker'})
                worker = object.__new__(P2LifecycleWorkerEvidenceStage)
                worker.scope, worker.expected_profile, worker.reviewed = scope, ref, reviewed
                worker.plan = copy.deepcopy(scope.certification_plan['workerPlan'])
                worker.invocation_attempted = True
                worker.invocation = {'status': 'P2_DIRECT_WORKER_HTTP_OBSERVED', 'httpStatus': 200}
                resolve = probe.HeldCertificationPersistenceScope.release_evidence
                with self.assertRaisesRegex(ValueError, 'REPLACEMENT_HELD_SCOPE_REQUIRED'):
                    resolve(scope, reviewed, evidence, ref)
                self.assertEqual(resolve(scope, reviewed, evidence, ref, worker_stage=worker)['originalReleaseReceipt'], raw)
                worker.invocation['httpStatus'] = 503
                with self.assertRaisesRegex(ValueError, 'REPLACEMENT_HELD_SCOPE_REQUIRED'):
                    resolve(scope, reviewed, evidence, ref, worker_stage=worker)
                worker.invocation['httpStatus'] = 200
                worker.reviewed = {**reviewed, 'probeId': 'different'}
                with self.assertRaisesRegex(ValueError, 'REPLACEMENT_HELD_SCOPE_REQUIRED'):
                    resolve(scope, reviewed, evidence, ref, worker_stage=worker)
                scope.require_replacement_original.assert_called_once_with(raw)
                worker.reviewed = reviewed
                worker.database_proof, worker.selected, worker.jobs = broker.api_proof, broker.selected, broker.jobs
                worker.bundle, worker.configuration, worker.source = broker.bundle, broker.configuration, broker.source
                command = {'userId': '00000000-0000-4000-8000-000000000001', 'commandId': 'owned-command', 'accountVersion': 1}
                worker.prior = {'pendingRecord': {'pending': {'command': command}}}
                private = {'frontendRuntimeDatabaseUrl': 'owned-private-url', 'witness': {'version': 1, 'environment': 'staging',
                           'stage': 'lifecycle-account', 'userId': command['userId'],
                           'selectedCommand': {'commandId': 'wrong-command', 'accountVersion': 1}}}
                with mock.patch.object(probe, '_make_plan_details', return_value=({}, worker.selected, worker.jobs, {})), \
                        mock.patch.object(runtime, 'assert_host') as runtime_check:
                    with self.assertRaises(probe.PersistenceFailure):
                        probe.execute_profiled(worker.bundle, worker.configuration, reviewed, worker.source, private,
                            evidence, scope, worker.database_proof, expected_profile=ref, _worker_stage=worker)
                    runtime_check.assert_not_called()
                self.assertEqual(private['frontendRuntimeDatabaseUrl'], '')

    def test_scoped_stage_uses_exact_broker_scope_proof_and_retained_bytes_once(self):
        for stage, status in probe.SCOPED_PERSISTENCE_STATUS.items():
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp).resolve()
                with mock.patch.object(probe, 'ROOT', directory):
                    broker, private, _frontend, _gateway, _output = self.scoped_persistence_fixture(directory, stage)
                    component = probe.P2ScopedLifecyclePersistenceStage(broker)
                    result = {'version': 2, 'qualificationTargetProfile': broker.scope._expected_profile,
                        'status': status, 'readOnly': True, 'providerTouched': False, 'releaseAccepted': False}
                    def execute(*args, **options):
                        self.assertIs(args[4], private)
                        self.assertIn('owned-private-canary', private['frontendRuntimeDatabaseUrl'])
                        self.assertEqual(args[5], {'originalReleaseReceipt': broker.initial['originalReleaseReceipt'],
                            'frontendDeploymentRecord': broker.initial['readyReceipts']['frontend-promotion-outcome.json']})
                        self.assertIs(args[6], broker.scope)
                        self.assertIs(args[7], broker.api_proof)
                        self.assertEqual(options, {'expected_profile': broker.scope._expected_profile, '_scoped_stage': component})
                        component._require_closed(broker.scope)
                        return result
                    with mock.patch.object(probe, 'execute_profiled', side_effect=execute) as reader:
                        self.assertIs(component.observe(), result)
                        with self.assertRaisesRegex(probe.PersistenceFailure, 'already-attempted'):
                            component.observe()
                        reader.assert_called_once()
                    self.assertEqual(private, {})
                    self.assertNotIn('persistencePrivate', broker.initial)
                    self.assertEqual(broker.require_scoped_native_off.call_count, 2)
                    self.assertNotIn('owned-private', json.dumps(result))

    def test_scoped_stage_refuses_drift_and_burns_private_input_before_any_reader(self):
        changes = {
            'witness-subject': lambda broker, private, _fe, _gw, _path: private['witness'].update(originalEmail='different@example.invalid'),
            'witness-stage': lambda broker, private, _fe, _gw, _path: private['witness'].update(stage='verify-delete'),
            'unarmed': lambda broker, _private, _fe, _gw, _path: setattr(broker, 'guard_arm_verified', False),
            'reviewed-carrier': lambda broker, _private, _fe, _gw, _path: broker.initial['persistenceReviewed'].update(probeId='other-review'),
            'scope-plan': lambda broker, _private, _fe, _gw, _path: broker.scope.certification_plan.update(initialEpoch='4'),
            'promotion-bytes': lambda broker, _private, _fe, _gw, _path: broker.initial['readyReceipts'].update(
                {'frontend-promotion-outcome.json': base64.b64encode(b'{}').decode()}),
            'api-proof-copy': lambda broker, _private, _fe, _gw, _path: setattr(broker, 'api_proof', {'status': 'copied'}),
            'api-proof-bytes': lambda broker, _private, _fe, _gw, path: (path / 'course/database-receipt.json').write_bytes(b'{}'),
            'frontend-recovery': lambda broker, _private, fe, _gw, _path: fe.update(recovery=True),
            'frontend-uncertain': lambda broker, _private, fe, _gw, _path: fe.update(uncertain=1),
            'gateway-active': lambda broker, _private, _fe, gw, _path: gw['admission']['active'].update(recovery=1),
            'gateway-counter-type': lambda broker, _private, _fe, gw, _path: gw['admission']['uncertain'].update(newWork=False),
            'gateway-fault-lease': lambda broker, _private, _fe, gw, _path: gw.update(faultLeasePresent=True),
            'native-state-unknown': lambda broker, _private, _fe, _gw, _path: setattr(
                broker.require_scoped_native_off, 'side_effect', ValueError('owned-private-native-error')),
        }
        for name, change in changes.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp).resolve()
                with mock.patch.object(probe, 'ROOT', directory), mock.patch.object(probe, 'execute_profiled') as reader:
                    fixture = self.scoped_persistence_fixture(directory, 'capture-export-ready')
                    broker, private = fixture[:2]
                    component = probe.P2ScopedLifecyclePersistenceStage(broker)
                    change(*fixture)
                    with self.assertRaises(probe.PersistenceFailure) as refusal:
                        component.observe()
                    self.assertNotIn('owned-private', str(refusal.exception.public_receipt))
                    with self.assertRaisesRegex(probe.PersistenceFailure, 'already-attempted'):
                        component.observe()
                    self.assertNotIn('persistencePrivate', broker.initial)
                    self.assertEqual(private, {})
                    reader.assert_not_called()

    def test_scoped_stage_disallows_legacy_or_unreviewed_actions(self):
        from types import SimpleNamespace
        from p2_certification_parent import P2CertificationBroker
        for broker in (SimpleNamespace(), object.__new__(P2CertificationBroker)):
            with self.assertRaisesRegex(ValueError, 'SCOPED_PARENT_REQUIRED'):
                probe.P2ScopedLifecyclePersistenceStage(broker)
        with tempfile.TemporaryDirectory() as temp:
            broker, *_ = self.scoped_persistence_fixture(Path(temp).resolve(), 'capture-export-ready')
            broker.scope.certification_plan['scopedAction']['stage'] = 'lifecycle-account'
            with self.assertRaisesRegex(ValueError, 'SCOPED_ACTION_REQUIRED'):
                probe.P2ScopedLifecyclePersistenceStage(broker)

    def test_scoped_stage_rechecks_gateway_before_publishing_private_record(self):
        original_read_text = Path.read_text
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(probe, 'ROOT', Path(temp).resolve()):
            directory = Path(temp).resolve()
            broker, private, _frontend, gateway, _output = self.scoped_persistence_fixture(directory, 'capture-export-ready')
            reviewed = broker.initial['persistenceReviewed']
            def read_text(path, *args, **kwargs):
                return reviewed['plan']['hostMachineId'] if str(path) == '/etc/machine-id' else original_read_text(path, *args, **kwargs)
            def observe(*_args, **_kwargs):
                gateway['admission']['uncertain']['recovery'] = 1
                return {'receipt': {}, 'witness': {}, 'privateEvidence': None}
            with mock.patch.object(Path, 'read_text', read_text), \
                    mock.patch.object(probe, '_make_plan_details', return_value=({}, broker.selected, broker.jobs, {})), \
                    mock.patch.object(probe, '_source_closure', return_value=reviewed['operatorSourceFiles']), \
                    mock.patch.object(probe.identity_probe, '_configuration_hash', return_value=reviewed['plan']['configurationSha256']), \
                    mock.patch.object(runtime, 'assert_host'), \
                    mock.patch.object(runtime, 'check_containers', return_value=reviewed['containers']), \
                    mock.patch.object(probe, 'observe_with_scope', side_effect=observe) as reader, \
                    mock.patch.object(probe, '_retain') as retain:
                component = probe.P2ScopedLifecyclePersistenceStage(broker)
                with self.assertRaisesRegex(probe.PersistenceFailure, 'scoped-stage-refused'):
                    component.observe()
                reader.assert_called_once()
                retain.assert_not_called()
            self.assertEqual(private, {})
            self.assertFalse((directory / 'private').exists())

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
