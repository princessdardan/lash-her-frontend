import json
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


class PersistenceProbeTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parents[3]

    def test_private_program_is_exact_source_bound_and_has_fixed_entry(self):
        program = probe.private_program(self.source)
        self.assertLess(len(program), 131_072)
        self.assertIn(b"runPrivatePersistenceProbeFromStdin", program)
        self.assertEqual(program, probe.private_program(self.source))
        closure = probe.identity_probe.source_closure(self.source)
        self.assertIn(probe.PROGRAM_FILES[0], closure)
        self.assertIn(probe.PROGRAM_FILES[1], closure)

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
