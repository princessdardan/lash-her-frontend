"""Owned process/flock and closed protocol tests. No Docker or provider calls."""
import base64
import fcntl
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import p2_identity_probe_scope as identity_scope
import p2_lifecycle_receiver_negative as action
import p2_scoped_lifecycle_receiver_negatives as scoped
from p2_lifecycle_receiver_scope import CurrentLifecycleReceiverScope
import release as runtime


class ReceiverScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="owned-lifecycle-receiver-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.reviewed = {"containers": [{"service": name, "containerId": str(index) * 64}
            for index, name in enumerate(("gateway", "course-api", "community-api"), 1)]}
        self.patchers = [patch.object(identity_scope, "LOCK", self.root / "lock"), patch.object(identity_scope.sys, "platform", "linux"),
            patch.object(identity_scope.os, "geteuid", return_value=0)]
        for patcher in self.patchers:
            patcher.start(); self.addCleanup(patcher.stop)
        selected = {"environment": "staging", "artifacts": {name: {"image": "owned-fixed-image"}
            for name in ("gateway", "courseRuntime", "courseMigration", "communityRuntime", "communityMigration")}}
        self.scope = CurrentLifecycleReceiverScope(selected, self.reviewed, self.root, b"fixed persistence", b"fixed receiver", lambda: None)
        self.addCleanup(lambda: None if self.scope.closed else self.scope.close())

    def args(self, mode="post", service="course"):
        container = "gateway" if mode == "post" else service + "-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == container)
        return ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
            identifier, "node", "--input-type=module", "--eval", "fixed receiver"]

    def test_real_independent_process_cannot_take_continuously_held_flock(self):
        script = "import fcntl,sys;f=open(sys.argv[1],'a+');\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);print('OPEN')\nexcept BlockingIOError:print('HELD')"
        def other():
            return subprocess.check_output([sys.executable, "-I", "-c", script, str(self.root / "lock")], text=True).strip()
        self.assertEqual(other(), "HELD")
        payload = {"mode": "post", "environment": "staging", "service": "course", "case": "exact-replay"}
        self.scope._allowed(self.args(), json.dumps(payload).encode(), runtime.SAFE_ENV)
        self.assertEqual(other(), "HELD")
        self.scope.close(); self.assertEqual(other(), "OPEN")

    def test_gap_generic_command_foreign_runtime_and_unclosed_env_are_refused(self):
        payload = {"mode": "post", "environment": "staging", "service": "course", "case": "exact-replay"}
        for change in ({"case": "future-gap"}, {"case": "delete"}, {"service": "other"}, {"environment": "production"}):
            with self.assertRaises(ValueError):
                self.scope._allowed(self.args(), json.dumps({**payload, **change}).encode(), runtime.SAFE_ENV)
        for args, env in ((["docker", "stop", "1" * 64], runtime.SAFE_ENV), (self.args()[:-1] + ["arbitrary code"], runtime.SAFE_ENV),
                (self.args(), {**runtime.SAFE_ENV, "NODE_OPTIONS": "--import=foreign"})):
            with self.assertRaises(ValueError):
                self.scope._allowed(args, json.dumps(payload).encode(), env)

    def test_exact_runtime_binding_child_is_added_without_migration_or_admission_commands(self):
        for service in ("course", "community"):
            payload = {"mode": "runtime-binding", "environment": "staging", "service": service}
            self.scope._allowed(self.args("runtime-binding", service), json.dumps(payload).encode(), runtime.SAFE_ENV)
        for args in (["docker", "compose", "up"], ["psql", "-c", "UPDATE state SET status='active'"]):
            with self.assertRaises(ValueError):
                self.scope._allowed(args, None, runtime.SAFE_ENV)

    def test_source_change_prevents_next_child_and_retains_flock_until_close(self):
        self.scope.verify_inputs = lambda: (_ for _ in ()).throw(ValueError("SOURCE_CHANGED"))
        with patch.object(identity_scope.subprocess, "Popen") as child:
            with self.assertRaises(ValueError):
                self.scope.run_receiver({"mode": "post", "environment": "staging", "service": "course", "case": "exact-replay"})
            child.assert_not_called()
        file = open(self.root / "lock", "a+")
        self.addCleanup(file.close)
        with self.assertRaises(BlockingIOError):
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_private_record_exclusive_mode_no_overwrite_and_no_credentials_required(self):
        directory = self.root / "private"; directory.mkdir(mode=0o700)
        digest = action._write_private(directory, "intent.json", {"case": "exact-replay", "hash": "1" * 64})
        self.assertEqual(len(digest), 64); self.assertEqual((directory / "intent.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            action._write_private(directory, "intent.json", {"overwrite": True})
        self.assertNotIn("overwrite", (directory / "intent.json").read_text())

    def test_main_packet_refusal_never_echoes_private_input(self):
        script = Path(action.__file__)
        for payload in (b"PRIVATE-MARKER", json.dumps({"token": "PRIVATE-MARKER"}).encode(), b"x" * 262145):
            result = subprocess.run([sys.executable, "-I", "-B", str(script)], input=payload, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1); self.assertEqual(result.stderr, b""); self.assertNotIn(b"PRIVATE-MARKER", result.stdout)
            self.assertEqual(json.loads(result.stdout)["status"], "P2_LIFECYCLE_RECEIVER_ACTION_REFUSED")


class ReceiverOrchestrationTests(unittest.TestCase):
    def run_action(self, mutate_after_post=None):
        with tempfile.TemporaryDirectory(prefix="owned-receiver-orchestration-") as temporary:
            root = Path(temporary); root.chmod(0o700)
            node = "/Users/dardan/.nvm/versions/node/v24.18.0/bin/node" if sys.platform == "darwin" else "node"
            fixture = Path(__file__).parents[1] / "p2-lifecycle-receiver-negatives.fixture.mjs"
            script = "import{receiverWitnessFixture}from" + json.dumps(fixture.as_uri()) + ";console.log(JSON.stringify(receiverWitnessFixture()))"
            witness = json.loads(subprocess.check_output([node, "--input-type=module", "--eval", script]))
            observed = {name: {"commands": [{"command_id": witness["command"]["commandId"]}]} for name in ("frontend", "course", "community")}
            observed["frontend"]["command"] = [{"command": {"version": 1, "commandId": witness["command"]["commandId"], "userId": witness["userId"],
                "accountVersion": witness["command"]["accountVersion"], "action": "suspend", "issuedAt": witness["command"]["issuedAt"]}}]
            outcome_sha = action._hash(action._canonical(witness))
            reviewed = {"version": 1, "environment": "staging", "profile": action.PROFILE, "actionId": "owned-case", "programSha256": "f" * 64,
                "privateDirectory": str(root / "private"), "persistence": {"plan": {"candidateSha256": witness["candidateSha256"],
                    "configurationSha256": witness["configurationSha256"]}, "containers": [{"service": name} for name in ("gateway", "course-api", "community-api")]}}
            private = {"frontendRuntimeDatabaseUrl": "owned-private-not-a-real-url", "witness": {"stage": "lifecycle-account"}}
            configuration = root / "configuration"; configuration.mkdir(mode=0o700)
            (configuration / "tls/gateway").mkdir(parents=True)
            for name in ("course-api.env", "community-api.env", "gateway.json", "tls/gateway/ca.pem"):
                path = configuration / name; path.write_text("owned nonsecret fixture"); path.chmod(0o600)
            calls, posts, scopes = [], [], []

            class Scope:
                closed = False
                def __init__(self, *args):
                    scopes.append(self)
                def verify(self):
                    calls.append("verify")
                def close(self):
                    self.closed = True; calls.append("close")
                def inventory(self, *args):
                    return reviewed["persistence"]["containers"]
                def run(self, args, **kwargs):
                    return subprocess.CompletedProcess(args, 0, b"unix:///var/run/docker.sock\n" if args[1] == "context" else b"linux/amd64\n", b"")
                def run_receiver(self, payload):
                    if payload["mode"] == "runtime-binding":
                        receipt = {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", "service": payload["service"],
                            "bindingSha256": payload["bindingSha256"], "runtimeConfigurationVerified": True, "globallyReadOnly": True, "releaseAccepted": False}
                    else:
                        posts.append((payload["service"], payload["case"]))
                        assert payload["case"] in action.CASES
                        assert (root / "private" / (payload["service"] + "-" + payload["case"] + "-intent.json")).is_file()
                        calls.append("post")
                        receipt = {"version": 1, "status": "P2_LIFECYCLE_RECEIVER_CASE_PASS", "service": payload["service"], "case": payload["case"],
                            "bindingSha256": payload["bindingSha256"], "witnessSha256": outcome_sha, "httpStatus": 200 if payload["case"] == "exact-replay" else 409,
                            "result": "duplicate" if payload["case"] == "exact-replay" else "idempotency_conflict" if payload["case"] == "changed-replay" else "account_version_conflict",
                            "domainStatePreservationRequiresReadback": True, "globallyReadOnly": False, "oidcVerified": False, "releaseAccepted": False}
                    return subprocess.CompletedProcess([], 0, json.dumps(receipt).encode(), b"")

            def observe(*args, **kwargs):
                calls.append("observe")
                result = {"witness": copy.deepcopy(witness), "receipt": {"witnessSha256": outcome_sha}, "observations": copy.deepcopy(observed)}
                if mutate_after_post is not None and len(posts) == mutate_after_post:
                    result["witness"]["domainSnapshots"]["course"]["digest"] = "e" * 64
                return result
            original_read = Path.read_text
            def read(path, *args, **kwargs):
                return "owned-machine" if str(path) == "/etc/machine-id" else original_read(path, *args, **kwargs)
            with patch.object(action, "validate_reviewed"), patch.object(action, "make_plan", return_value=({}, {})), \
                    patch.object(action, "private_program", return_value=b"fixed-code"), patch.object(runtime, "make_plan", return_value=({}, {}, {"hostMachineId": "owned-machine"}, None)), \
                    patch.object(Path, "read_text", read), patch.object(action, "CurrentLifecycleReceiverScope", Scope), \
                    patch.object(action.identity, "_one_container"), patch.object(runtime, "environment_values", return_value={
                        "COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET": "owned-synthetic-key" * 4, "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET": "owned-synthetic-key" * 4}), \
                    patch.object(action.persistence, "observe_with_scope", side_effect=observe), patch.object(action.persistence, "private_program", return_value=b"fixed-select-code"):
                if mutate_after_post is None:
                    result = action.execute(root, configuration, reviewed, root, private, "staging/owned-case")
                    self.assertEqual(len(result["cases"]), 6)
                    self.assertEqual(result["openCases"], action.open_cases())
                    self.assertTrue((root / "private/outcome.json").is_file())
                else:
                    with self.assertRaisesRegex(ValueError, "P2_RECEIVER_DOMAIN_STATE_CHANGED"):
                        action.execute(root, configuration, reviewed, root, private, "staging/owned-case")
                    self.assertEqual(len(posts), mutate_after_post)
                    self.assertFalse((root / "private/outcome.json").exists())
            self.assertTrue(scopes[0].closed)
            self.assertEqual(private["frontendRuntimeDatabaseUrl"], "")
            return calls, posts

    def test_actual_controller_orders_durable_intent_before_post_and_fresh_readback_after_every_case(self):
        calls, posts = self.run_action()
        self.assertEqual(posts, [(service, case) for service in ("course", "community") for case in action.CASES])
        filtered = [item for item in calls if item in ("observe", "post")]
        self.assertEqual(filtered, [item for _ in posts for item in ("observe", "post", "observe")])

    def test_changed_domain_stops_without_next_post_or_automatic_repair(self):
        self.run_action(mutate_after_post=2)


class ProfiledReceiverCaseTests(unittest.TestCase):
    def setUp(self):
        from p2_certification_parent import P2CertificationScope
        from p2_lifecycle_worker_evidence import P2LifecycleWorkerEvidenceStage, canonical
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE

        temporary = tempfile.TemporaryDirectory(prefix="owned-scoped-receiver-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.source = Path(action.__file__).resolve().parents[3]
        self.profile = dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        self.positive_sha = "d" * 64
        files = (action.PROGRAM, scoped.HOST_PROGRAM, scoped.LAUNCHER_PROGRAM, action.WITNESS_PROGRAM, action.TARGET_PROFILE_PROGRAM)
        manifest = {path: action._hash((self.source / path).read_bytes()) for path in files}
        worker = self.worker = P2LifecycleWorkerEvidenceStage.__new__(P2LifecycleWorkerEvidenceStage)
        scope = self.scope = P2CertificationScope.__new__(P2CertificationScope)
        worker.scope, worker.expected_profile, scope._expected_profile = scope, self.profile, self.profile
        worker.source = self.source
        worker.directory = self.directory / "worker"
        worker.directory.mkdir(mode=0o700)
        worker.configuration = self.directory / "reviewed-original"
        worker.configuration.mkdir()
        (worker.configuration / "tls/gateway").mkdir(parents=True)
        (worker.configuration / "gateway.json").write_bytes(b"owned gateway configuration")
        (worker.configuration / "tls/gateway/ca.pem").write_bytes(b"owned gateway CA")
        self.active_configuration = self.directory / "current-only"
        self.active_configuration.mkdir()
        for service in ("course", "community"):
            file = self.active_configuration / (service + "-api.env")
            file.write_bytes(b"owned env")
            file.chmod(0o600)

        lstat = Path.lstat

        def owned_env_stat(path):
            actual = lstat(path)
            if path.parent == self.active_configuration and path.suffix == ".env":
                return SimpleNamespace(st_mode=actual.st_mode, st_uid=0)
            return actual

        owner = patch.object(Path, "lstat", owned_env_stat)
        owner.start()
        self.addCleanup(owner.stop)
        worker.reviewed = {"operatorSourceFiles": manifest, "plan": {"owned": "profiled", "qualificationTargetProfile": self.profile}}
        worker.selected = worker.jobs = {}
        worker.database_proof = object()
        worker.witness_record_sha256 = self.positive_sha
        worker.invocation_attempted = True
        worker.invocation = {"status": "P2_DIRECT_WORKER_HTTP_OBSERVED", "httpStatus": 200, "workerInvokedAt": "2026-11-09T00:01:00.000Z"}
        worker._boundary = Mock(return_value={"epoch": "9", "newWork": False, "recovery": False, "active": 0, "uncertain": 0})
        worker.inventory = [{"service": service, "containerId": str(index) * 64}
            for index, service in enumerate(("gateway", "course-api", "community-api"), 1)]
        command_id, user_id = "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000022"
        issued = "2026-11-09T00:00:00.000Z"
        command = {"version": 1, "commandId": command_id, "userId": user_id, "accountVersion": 2, "action": "suspend", "issuedAt": issued}
        command_sha = action._hash(action._canonical(command))
        worker.prior = {"pendingRecord": {"pending": {"command": command}}, "releaseEvidence": {"owned": "prior-release-pins"}}
        worker.plan = {"actionId": "owned-worker", "receiverNegatives": {"profile": scoped.SCOPED_PROFILE,
            "sourceSha256": manifest[action.PROGRAM], "hostSourceSha256": manifest[scoped.HOST_PROGRAM]},
            "canonicalCommandSha256": command_sha,
            "gatewayConfigurationSha256": action._hash((worker.configuration / "gateway.json").read_bytes()),
            "sourceProgramSha256": action._hash((self.source / "ops/platform/p2-lifecycle-worker-evidence.mjs").read_bytes()),
            "candidateSha256": "1" * 64, "configurationSha256": "2" * 64, "sourceCommit": "3" * 40,
            "targetSha256": "4" * 64, "pendingRecordSha256": "5" * 64}
        scope.certification_plan = {"mode": "direct-worker", "certificationActionId": "owned-worker",
            "workerPlan": copy.deepcopy(worker.plan), "workerPlanSha256": action._hash(canonical(worker.plan)), "initialEpoch": "7"}
        scope.verify = Mock()
        scope.runtime_mount_configuration = Mock(return_value=self.active_configuration)
        self.witness = {"profile": "lifecycle-account-v1", "userId": user_id,
            "command": {"commandId": command_id, "accountVersion": 2, "action": "suspend", "issuedAt": issued, "canonicalSha256": command_sha},
            "frontend": {"status": "suspended", "latestCommandId": command_id, "laterCommandCount": 0, "pendingOrDeliveringCount": 0,
                "deliveries": [{"status": "acknowledged", "leaseId": None, "leaseUntil": None, "acknowledgedAt": issued}
                               for _ in range(2)]},
            "receivers": {service: {"status": "suspended", "latestCommandId": command_id} for service in ("course", "community")}}
        self.witness_sha = action._hash(action._canonical(self.witness))
        self.observations = {name: {"commands": [{"command_id": command_id}]} for name in ("frontend", "course", "community")}
        self.observations["frontend"]["command"] = [{"command": command}]
        self.posts = []
        self.read_count = 0
        self.drift = False
        self.lose_reply = False
        self.retained = {"recordSha256": self.positive_sha, "record": {"priorRecordSha256": None, "witness": self.witness,
                         "receipt": {"witnessSha256": self.witness_sha}}}
        scope.run = Mock(side_effect=self.child)
        self.config = {"COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET": "owned-course-private-fixture",
                       "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET": "owned-community-private-fixture"}
        self.read_retained_capture = action.persistence.load_retained_capture
        for patcher in (patch.object(scoped, "private_program", return_value=b"owned exact profiled child"),
                patch.object(action.persistence, "load_retained_capture", side_effect=lambda *args, **kwargs: copy.deepcopy(self.retained)),
                patch.object(action.persistence, "HeldCertificationPersistenceScope", return_value=object()),
                patch.object(action.persistence, "observe_with_scope", side_effect=self.observe),
                patch.object(action.runtime, "environment_values", return_value=self.config)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def observe(self, reviewed, private, scope, url, *, expected_profile):
        self.assertEqual(reviewed, self.worker.reviewed["plan"])
        self.assertEqual(url, "owned-private-runtime-url")
        self.assertEqual(expected_profile, self.profile)
        self.assertEqual(private["selectedCommand"]["commandId"], self.witness["command"]["commandId"])
        self.read_count += 1
        observations = copy.deepcopy(self.observations)
        observations["frontend"]["now"] = str(self.read_count)
        if self.drift and self.posts:
            observations["community"]["commands"].append({"command_id": "owned-unexpected"})
        return {"witness": copy.deepcopy(self.witness), "receipt": {"witnessSha256": self.witness_sha},
                "observations": observations}

    def child(self, args, *, input, env, timeout, capture_output):
        payload = json.loads(input)
        service = payload["service"]
        self.assertEqual(env, runtime.SAFE_ENV)
        self.assertEqual(timeout, 20)
        self.assertTrue(capture_output)
        self.assertEqual(payload["qualificationTargetProfile"], self.profile)
        fields = {key: payload[key] for key in ("version", "qualificationTargetProfile", "bindingSha256", "service")}
        if payload["mode"] == "runtime-binding":
            self.assertEqual(args[9], "2" * 64 if service == "course" else "3" * 64)
            self.assertEqual(payload["runtimeEnvironment"], self.config)
            result = {**fields, "status": "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND", "runtimeConfigurationVerified": True,
                      "globallyReadOnly": True, "releaseAccepted": False}
        else:
            self.assertEqual(args[9], "1" * 64)
            case = payload["case"]
            intent = self.worker.directory / "receiver-negatives" / f"{service}-{case}-intent.json"
            self.assertTrue(intent.is_file())
            self.assertFalse(json.loads(intent.read_bytes())["automaticReplayAllowed"])
            self.posts.append((service, case))
            if self.lose_reply:
                raise TimeoutError("owned response lost")
            status, code = {"exact-replay": (200, "duplicate"), "changed-replay": (409, "idempotency_conflict"),
                            "stale-restore": (409, "account_version_conflict"), "future-gap": (409, "account_version_conflict")}[case]
            self.assertEqual(payload["freshCommandId"] is not None, case in ("stale-restore", "future-gap"))
            self.assertEqual(payload["witness"], self.witness)
            self.assertEqual(payload["secret"], self.config[service.upper() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET"])
            result = {**fields, "status": "P2_LIFECYCLE_RECEIVER_CASE_PASS", "case": case, "httpStatus": status,
                      "result": code, "witnessSha256": self.witness_sha, "domainStatePreservationRequiresReadback": True,
                      "globallyReadOnly": False, "oidcVerified": False, "releaseAccepted": False}
        return subprocess.CompletedProcess(args, 0, action._canonical(result) + b"\n", b"")

    def start(self):
        self.stage = scoped.P2ScopedLifecycleReceiverNegatives(self.worker)
        return self.stage

    def composed_broker(self):
        """Use real dispatch, worker retention, receiver orchestration and fsync.

        The already-armed lease, completed worker invocation and denials,
        mounted runtime, database snapshots, and child HTTP are projections.
        """
        from p2_certification_parent import P2ProfiledCertificationBroker

        worker = self.worker
        worker.denials = {"course": {"status": "owned-course-denial"},
                          "community": {"status": "owned-community-denial"}}
        command = worker.prior["pendingRecord"]["pending"]["command"]
        private = {"stage": "lifecycle-account", "userId": command["userId"],
                   "selectedCommand": {"commandId": command["commandId"], "accountVersion": command["accountVersion"]}}
        positive = {**self.retained["record"], "version": 2, "qualificationTargetProfile": self.profile,
                    "stage": "lifecycle-account", "subjectBindingSha256": action.persistence._subject_binding(private),
                    "contextSha256": action.persistence._context_binding(worker.reviewed["plan"]), "privateEvidence": None}
        worker.witness_record_sha256 = action.persistence._retain(worker.directory, "lifecycle-account", positive)
        action.persistence.load_retained_capture.side_effect = self.read_retained_capture
        broker = P2ProfiledCertificationBroker.__new__(P2ProfiledCertificationBroker)
        broker.check = Mock()
        broker.external_armed = True
        broker.initial = {"certificationPlan": self.scope.certification_plan}
        broker.worker_stage = worker
        return broker

    def broker_command(self, broker, operation, **fields):
        return broker.worker_operation(operation, {"id": 1, "operation": operation, **fields})

    def composed_worker_record(self, receiver_negatives):
        worker = self.worker
        command = worker.prior["pendingRecord"]["pending"]["command"]
        return {**{key: worker.plan[key] for key in ("candidateSha256", "configurationSha256", "sourceCommit",
                    "targetSha256", "pendingRecordSha256", "sourceProgramSha256")},
                "version": 2, "qualificationTargetProfile": self.profile, "status": "P2_DIRECT_LIFECYCLE_WORKER_JOINED",
                "bindingSha256": self.scope.certification_plan["workerPlanSha256"],
                "commandId": command["commandId"], "accountVersion": command["accountVersion"], "action": command["action"],
                "workerInvokedAt": worker.invocation["workerInvokedAt"], "invocation": worker.invocation,
                "nativeScheduleEnabled": False, "nativeInvocationQualified": False,
                "lifecyclePrivateRecordSha256": worker.witness_record_sha256,
                "receiverDenials": worker.denials, "receiverDeniedCount": 2, "receiverDeniedHttpCount": 1,
                "frontendActive": 0, "frontendUncertain": 0, "releaseAccepted": False,
                "receiverNegatives": receiver_negatives}

    def retain_composed_worker(self, broker, record):
        raw = action._canonical(record) + b"\n"
        return self.broker_command(broker, "worker-retain", record=record, sourceArtifact=base64.b64encode(raw).decode()), raw

    def test_broker_dispatch_joins_eight_receiver_cases_to_the_actual_retained_worker(self):
        from p2_certification_parent import P2CertificationBroker

        broker = self.composed_broker()
        with self.assertRaisesRegex(ValueError, "RECEIVER_NEGATIVE_INPUT_REFUSED"):
            self.broker_command(broker, "worker-receiver-negative-next", runtimeUrl="owned-private-runtime-url", case="future-gap")
        self.assertFalse(hasattr(self.worker, "_receiver_negative_stage"))
        self.scope.run.assert_not_called()

        rows = [self.broker_command(broker, "worker-receiver-negative-next", runtimeUrl="owned-private-runtime-url")
                for _ in scoped.CASE_ORDER]
        self.assertEqual(self.posts, list(scoped.CASE_ORDER))
        self.assertEqual(self.read_count, 16)
        self.assertIs(type(self.worker._receiver_negative_stage), scoped.P2ScopedLifecycleReceiverNegatives)
        joined = self.broker_command(broker, "worker-receiver-negatives-joined")
        self.assertEqual(joined["cases"], rows)
        self.assertEqual(joined["positiveWitnessSha256"],
                         action._hash((self.worker.directory / "lifecycle-account.json").read_bytes()))
        joined_file = self.worker.directory / "receiver-negatives" / "receiver-negatives-joined.json"
        self.assertEqual(joined["privateRecordSha256"], action._hash(joined_file.read_bytes()))

        record = self.composed_worker_record(joined)
        joined_worker = self.worker.directory / "joined-worker.json"
        foreign = {**record, "receiverNegatives": {**joined, "privateRecordSha256": "a" * 64}}
        with self.assertRaisesRegex(ValueError, "WORKER_RECEIVER_NEGATIVE_JOIN_REQUIRED"):
            self.retain_composed_worker(broker, foreign)
        self.assertFalse(joined_worker.exists())
        retained, source_raw = self.retain_composed_worker(broker, record)
        machine_raw = joined_worker.read_bytes()
        self.assertEqual(json.loads(machine_raw)["record"], record)
        self.assertEqual(retained["privateRecordSha256"], action._hash(machine_raw))
        self.assertEqual(broker.worker_source_sha256, action._hash(source_raw))
        P2CertificationBroker._require_worker_outcome(broker, {"version": 2, "qualificationTargetProfile": self.profile,
            "status": "P2_CERTIFICATION_DIRECT_WORKER_JOINED", "workerPlanSha256": record["bindingSha256"],
            "workerSourceArtifactSha256": action._hash(source_raw), "workerMachineArtifactSha256": action._hash(machine_raw)})
        for raw in (source_raw, machine_raw, joined_file.read_bytes()):
            self.assertNotIn(b"owned-private-runtime-url", raw)
            self.assertNotIn(b"owned-course-private-fixture", raw)

    def test_broker_dispatch_cannot_replay_or_retain_after_lost_receiver_response(self):
        broker = self.composed_broker()
        self.lose_reply = True
        next_case = lambda: self.broker_command(broker, "worker-receiver-negative-next", runtimeUrl="owned-private-runtime-url")
        with self.assertRaisesRegex(TimeoutError, "owned response lost"):
            next_case()
        stage = self.worker._receiver_negative_stage
        for operation in (next_case,
                lambda: self.broker_command(broker, "worker-receiver-negatives-joined"),
                lambda: self.retain_composed_worker(broker, self.composed_worker_record({}))):
            with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
                operation()
        self.assertIs(self.worker._receiver_negative_stage, stage)
        self.assertEqual(self.posts, [("course", "exact-replay")])
        self.assertEqual([path.name for path in stage.directory.iterdir()], ["course-exact-replay-intent.json"])
        self.assertFalse((self.worker.directory / "joined-worker.json").exists())
        self.assertFalse(hasattr(broker, "worker_retained"))

    def test_eight_ordered_cases_with_fresh_brackets_and_durable_idempotent_join(self):
        stage = self.start()
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.require_joined()
        rows = [stage.observe_next("owned-private-runtime-url") for _ in scoped.CASE_ORDER]
        self.assertEqual(self.posts, list(scoped.CASE_ORDER))
        self.assertEqual(self.read_count, 16)
        self.assertEqual([row["httpStatus"] for row in rows], [200, 409, 409, 409] * 2)
        self.assertEqual([row["beforeWitnessSha256"] for row in rows], [self.witness_sha] * 8)
        self.assertEqual([row["afterWitnessSha256"] for row in rows], [self.witness_sha] * 8)
        self.assertTrue(all(row["quotaWritesExcluded"] and not row["globallyReadOnly"] for row in rows))
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.observe_next("owned-private-runtime-url")
        summary = stage.require_joined()
        self.assertEqual(stage.require_joined(), summary)
        self.assertEqual(summary["cases"], rows)
        self.assertEqual(summary["positiveWitnessSha256"], self.positive_sha)
        self.assertEqual(summary["openCases"], [])
        terminal = stage.directory / "receiver-negatives-joined.json"
        self.assertEqual(action._hash(terminal.read_bytes()), summary["privateRecordSha256"])
        self.assertEqual(len(list(stage.directory.iterdir())), 25)
        retained = b"".join(path.read_bytes() for path in stage.directory.iterdir())
        self.assertNotIn(b"owned-private-runtime-url", retained)
        self.assertNotIn(b"owned-course-private-fixture", retained)
        terminal.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.require_joined()
        self.assertEqual(self.posts, list(scoped.CASE_ORDER))

    def test_retained_positive_refuses_before_any_child(self):
        stage = self.start()
        self.retained["recordSha256"] = "e" * 64
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.observe_next("owned-private-runtime-url")
        self.scope.run.assert_not_called()
        self.assertEqual(self.posts, [])
        self.assertEqual(list(stage.directory.iterdir()), [])

    def test_incorrect_closed_epoch_refuses_before_positive_read_or_child(self):
        stage = self.start()
        self.worker._boundary.return_value["epoch"] = "10"
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.observe_next("owned-private-runtime-url")
        action.persistence.load_retained_capture.assert_not_called()
        self.scope.run.assert_not_called()
        self.assertEqual(list(stage.directory.iterdir()), [])

    def test_lost_post_receipt_keeps_only_intent_and_cannot_replay_or_advance(self):
        stage = self.start()
        self.lose_reply = True
        with self.assertRaises(TimeoutError):
            stage.observe_next("owned-private-runtime-url")
        for operation in (lambda: stage.observe_next("owned-private-runtime-url"), stage.require_joined):
            with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
                operation()
        self.assertEqual(self.posts, [("course", "exact-replay")])
        self.assertEqual([p.name for p in stage.directory.iterdir()], ["course-exact-replay-intent.json"])

    def test_unexpected_domain_change_retains_http_without_publishing_success(self):
        stage = self.start()
        self.drift = True
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.observe_next("owned-private-runtime-url")
        self.assertEqual(self.read_count, 2)
        self.assertEqual(sorted(p.name for p in stage.directory.iterdir()),
                         ["course-exact-replay-http.json", "course-exact-replay-intent.json"])
        with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
            stage.require_joined()

    def test_drift_between_completed_cases_refuses_before_second_intent_or_post(self):
        stage = self.start()
        stage.observe_next("owned-private-runtime-url")
        retained = sorted(path.name for path in stage.directory.iterdir())
        self.drift = True
        for operation in (lambda: stage.observe_next("owned-private-runtime-url"), stage.require_joined):
            with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
                operation()
        self.assertEqual(self.posts, [("course", "exact-replay")])
        self.assertEqual(self.read_count, 3)
        self.assertEqual(sorted(path.name for path in stage.directory.iterdir()), retained)

    def test_missing_opt_in_legacy_or_future_gap_never_creates_authority(self):
        stage = self.start()
        for case in ("exact-replay", "future-gap"):
            with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
                stage._child("course", {"mode": "post", "case": case}, "irrelevant")
        self.scope.run.assert_not_called()
        for worker in ({}, self.worker):
            if worker is self.worker:
                self.worker.plan.pop("receiverNegatives")
            with self.assertRaisesRegex(ValueError, "SCOPED_RECEIVER_NEGATIVES_REFUSED"):
                scoped.P2ScopedLifecycleReceiverNegatives(worker)


if __name__ == "__main__":
    unittest.main()
