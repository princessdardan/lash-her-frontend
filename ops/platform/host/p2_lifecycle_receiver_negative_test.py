"""Owned process/flock and closed protocol tests. No Docker or provider calls."""
import fcntl
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import p2_identity_probe_scope as identity_scope
import p2_lifecycle_receiver_negative as action
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


if __name__ == "__main__":
    unittest.main()
