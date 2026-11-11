"""Exercise the real forked recovery guardian against disposable effect fixtures."""
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
import migrate
import p2_frontend_replacement_parent as parent
import p2_release_broker as broker_module
import p2_release_supervisor as supervisor
import p2_replacement_runtime_review as runtime_review
import p2_replacement_terminal as terminal
import p2_replacement_terminal_test as terminal_fixture

retained = terminal_fixture.retained


def encoded(raw):
    return base64.b64encode(raw).decode()


class OwnedRecoveryGuardian(unittest.TestCase):
    provider_fixture = terminal_fixture.ReplacementTerminalTests.provider_fixture
    provider_readback = terminal_fixture.ReplacementTerminalTests.provider_readback

    def setUp(self):
        self.assertEqual(sys.platform, "linux")
        self.assertEqual(os.geteuid(), 0)
        terminal_fixture.ReplacementTerminalTests.setUp(self)

    def test_resumed_guard_reaps_then_publishes_with_both_backend_observations(self):
        self.exercise("success")

    def test_resumed_guard_disconnect_contains_without_replaying_frontend(self):
        self.exercise("disconnect")

    def test_resumed_guard_refuses_original_as_the_fresh_backend(self):
        self.exercise("stale")

    def exercise(self, scenario):
        original = {path.name: path.read_bytes() for path in self.write_directory.iterdir() if path.is_file()}
        fresh = {**self.probe, "marker": "e" * 64, "backendPid": self.probe["backendPid"] + 1,
                 "backendStart": "2026-11-09T21:52:00.000000Z"}
        fresh_raw = retained({**json.loads(self.raw_observation), **{key: fresh[key] for key in parent.PROBE_IDENTITY}})
        source_root = self.root
        action = self.results / "owned-recovery"
        directory = action / self.write_directory.name
        attempt = action / self.attempt.name
        migration = action / self.migration.name
        staged_runtime, staged_migrations = self.root / "owned-ready-runtime", self.root / "owned-ready-migrations"
        self.attempt.rename(staged_runtime)
        self.migration.rename(staged_migrations)
        recovery_review = retained({"actionId": action.name, "originalDirectory": str(self.write_directory),
                                    "originalEvidenceSha256": {}})
        initial = {**self.initial, "results": str(action), "operatorSourceCommit": "e" * 40,
                   "recoveryReviewBytes": encoded(recovery_review), "recoveryReviewSha256": migrate.file_hash(recovery_review),
                   "confirmation": self.initial["confirmation"] + "/recover/" + migrate.file_hash(recovery_review)}
        write_intent = "2" * 64
        written_request = {**self.operator_evidence, "writeIntentSha256": write_intent}
        copies = {name: retained(parent.write_observer_receipt(initial, self.probe, self.raw_observation, status))
                  for name, status in ((parent.WRITTEN_OBSERVER_STARTED, "WRITTEN_STARTED"),
                                       (parent.WRITTEN_OBSERVER_RETURNED, "WRITTEN_RETURNED"))}
        recovery = {"actionId": action.name, "probe": self.probe, "physical": self.raw_observation, "written": self.written_raw,
                    "request": written_request, "packet": self.packet, "copies": copies,
                    "custody": {"armReceiptSha256": "3" * 64, "emptyCatalogReceipt": self.empty_boundary}}
        lock = self.root / "owned-guardian.lock"
        lock_fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.addCleanup(os.close, lock_fd)
        incoming, send = os.pipe()
        receive, outgoing = os.pipe()
        child = os.fork()
        if child == 0:
            for fd in (send, receive, lock_fd):
                os.close(fd)
            sys.stdin, sys.stdout = os.fdopen(incoming), os.fdopen(outgoing, "w")
            guardian_pid = os.getpid()

            def lock_held():
                with lock.open("rb") as competitor, self.assertRaises(BlockingIOError):
                    fcntl.flock(competitor.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            def observe(_initial, _image, probe):
                self.assertEqual(os.getpid(), guardian_pid)
                self.assertEqual(probe, fresh)
                lock_held()
                return fresh_raw

            def runtime_worker(broker):
                self.assertNotEqual(os.getpid(), guardian_pid)
                self.assertEqual(broker.fresh_probe, fresh)
                self.assertEqual(broker.probe, self.probe)
                self.assertEqual(broker.written_request, self.packet)
                lock_held()
                staged_runtime.rename(attempt)
                staged_migrations.rename(migration)
                for name in ("frontend-original-database-receipt.json", "frontend-continuation-started.json",
                             "frontend-replacement-written-observation.json"):
                    migrate.write_exact_bytes(directory, name, original[name])
                broker.scope = Mock()
                broker.observer = Mock(stop_event=threading.Event())
                try:
                    broker.replacement_runtime_ready(attempt, migration, attempt / "configuration", self.candidate, json.loads(self.runtime_raw))
                except ValueError:
                    if not broker.failed.is_set():
                        raise
                finally:
                    broker.observer.stop_event.set()
                    broker.worker_done.set()

            def verify_closure(_initial, _image, selected, probe, physical):
                self.assertEqual(os.getpid(), guardian_pid)
                self.assertEqual((selected, probe, physical), (recovery, fresh, fresh_raw))
                lock_held()
                return {"ownedFreshBackend": probe["backendPid"], "ownedOriginalBackend": selected["probe"]["backendPid"],
                        "freshPhysicalSha256": migrate.file_hash(physical), "backendAbsent": True}

            def contain(_initial, _plan, _candidate, results, _review, reaped):
                self.assertEqual(os.getpid(), guardian_pid)
                self.assertEqual(results, directory)
                self.assertTrue(reaped)
                lock_held()
                if (directory / parent.RUNTIME_INTENT).is_file():
                    migrate.write_json(directory, "owned-containment.json", {"workerReaped": True})

            try:
                with contextlib.ExitStack() as stack:
                    replacements = (patch.object(parent, "LOCK", lock), patch.object(supervisor, "LOCK", lock), patch.object(broker_module, "LOCK", lock),
                      patch.object(parent, "prepare", return_value=(self.plan_raw, self.plan, self.probe_base, self.image, directory)),
                      patch.object(supervisor, "_verify_guard_source"), patch.object(parent.ReplacementArmBroker, "require_source_closure"),
                      patch.object(runtime_review, "prepare_runtime_review", return_value=self.review),
                      patch.object(parent, "prepare_recovery_evidence", return_value=recovery),
                      patch.object(parent, "verify_original_recovery_frontier", side_effect=lambda *_args: lock_held()),
                      patch.object(parent, "verify_bundle"), patch.object(parent, "observe", side_effect=observe),
                      patch.object(parent, "require_write_custody", return_value=({}, write_intent, self.raw_observation)),
                      patch.object(parent, "run_replacement_image", return_value=self.closed_raw),
                      patch.object(parent, "observe_recovery_closed", side_effect=verify_closure),
                      patch.object(parent, "contain_runtime_if_started", side_effect=contain),
                      patch.object(parent, "contain_replacement_write", side_effect=AssertionError("frontend write abort reached")),
                      patch.object(parent, "remove_container", return_value=False),
                      patch.object(parent.ReplacementWriteBroker, "run_replacement_runtime", runtime_worker),
                      patch.object(parent.ReplacementWriteBroker, "verify_replacement_runtime", parent.ReplacementWriteBroker.check),
                      patch.object(parent.ReplacementWriteBroker, "verify_replacement_gateway_closed"),
                      patch.object(terminal, "verify_runtime"), self.provider_readback())
                    for replacement in replacements:
                        stack.enter_context(replacement)
                    parent.qualify_replacement_write_frontier(initial, source_root)
            except BaseException:
                os._exit(1)
            os._exit(0)

        os.close(incoming)
        os.close(outgoing)
        reaped = False
        try:
            with os.fdopen(send, "wb") as commands, os.fdopen(receive, "rb", buffering=0) as responses:
                def receive_frame():
                    self.assertTrue(select.select([responses], [], [], 15)[0], "no response from owned recovery guard")
                    line = responses.readline()
                    return json.loads(line) if line else None

                def request(request_id, operation, **fields):
                    commands.write(parent.encoded({"id": request_id, "operation": operation, **fields}) + b"\n")
                    commands.flush()
                    return receive_frame()

                self.assertEqual(receive_frame(), {"id": 0, "status": "LOCKED"})
                resumed = request(1, "resume-replacement-written", probe=self.probe if scenario == "stale" else fresh)
                if scenario == "stale":
                    if resumed is not None:
                        self.assertEqual(resumed["status"], "P2_HOST_STAGE_FAILED")
                else:
                    postflight = migrate.file_hash(self.written_raw)
                    self.assertEqual(resumed, {"id": 1, "status": "REPLACEMENT_WRITTEN_RESUMED", "postflightSha256": postflight})
                    self.assertEqual((directory / parent.RECOVERY_PHYSICAL).read_bytes(), fresh_raw)
                    self.assertEqual((directory / parent.WRITTEN_OBSERVATION).read_bytes(), self.written_raw)
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    ready = request(2, "start-replacement-runtime", postflightSha256=postflight)
                    self.assertEqual(ready, {"id": 2, "status": "REPLACEMENT_API_RUNTIME_READY",
                                             "runtimeOutcomeSha256": migrate.file_hash(self.runtime_raw),
                                             "migrationOutcomeSha256": migrate.file_hash(self.migration_raw)})
                    if scenario == "success":
                        proof_sha = migrate.file_hash(self.provider_raw[0])
                        provider = dict(zip(("proof", "workload", "promotion"), map(encoded, self.provider_raw)))
                        self.assertEqual(request(3, "verify-replacement-frontend", **provider),
                                         {"id": 3, "status": "REPLACEMENT_FRONTEND_VERIFIED", "proofSha256": proof_sha})
                        self.assertEqual(request(4, "prepare-replacement-close"), {"id": 4, "status": "REPLACEMENT_CLOSE_PREPARED"})
                        self.assertEqual(request(5, "observe-replacement-closed"), {"id": 5, "status": "REPLACEMENT_SESSION_CLOSED",
                                                                                  "sessionClosedSha256": migrate.file_hash(self.closed_raw)})
                        self.assertFalse((directory / terminal.TERMINAL).exists())
                        joined = request(6, "finish-replacement", **dict(zip(("terminal", "continuationCompleted", "releaseOutcome"),
                                                                            map(encoded, self.node_raw))))
                        self.assertEqual(joined["status"], "REPLACEMENT_JOINED")
                        self.assertEqual(request(7, "commit"), {"id": 7, "status": "COMMITTED",
                                                                 "commitIntentSha256": joined["commitIntentSha256"]})
                    commands.close()
                    if scenario != "success":
                        failure = receive_frame()
                        if failure is not None:
                            self.assertEqual(failure["status"], "P2_HOST_STAGE_FAILED")
            _, status = os.waitpid(child, 0)
            reaped = True
            self.assertEqual(os.waitstatus_to_exitcode(status), 0 if scenario == "success" else 1)
            self.assertEqual({path.name: path.read_bytes() for path in self.write_directory.iterdir() if path.is_file()}, original)
            self.assertEqual((directory / terminal.TERMINAL).exists(), scenario == "success")
            self.assertEqual((directory / "owned-containment.json").exists(), scenario == "disconnect")
            self.assertFalse((directory / parent.WRITE_CONTAINMENT).exists())
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if not reaped:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)


if __name__ == "__main__":
    unittest.main()
