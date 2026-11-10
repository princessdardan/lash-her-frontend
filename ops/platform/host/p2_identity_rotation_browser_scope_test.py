#!/usr/bin/env python3
import copy
import hashlib
import hmac
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from uuid import UUID

import migrate
import p2_identity_rotation_browser_scope as browser
from p2_identity_key_rotation_adapter import P2IdentityRotationScope
from p2_identity_key_rotation_parent import P2IdentityRotationBroker


class BrowserScopeTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.broker = broker = P2IdentityRotationBroker.__new__(P2IdentityRotationBroker)
        self.scope = scope = P2IdentityRotationScope.__new__(P2IdentityRotationScope)
        broker.scope, broker.directory = scope, self.directory
        broker.selected = scope.release = {"environment": "staging"}
        broker.jobs = scope.jobs = {"frontend": {"job": {}}}
        self.customer = "18387698-b30a-4eef-9ad7-60f58ede2e68"
        self.admin = "aabbccdd-abcd-4bbb-8bbb-aabbccddeeff"
        self.course = "feebbeed-abcd-4111-8111-ffeebbccbbaa"
        self.secret = "owned-fixture-signing-material-" + "z" * 32
        self.deployment_url = "https://owned-vercel-project.vercel.app"
        scope.action_id, scope.binding_sha256, scope.source_commit = "p2-key-rotation-owned", "b" * 64, "a" * 40
        scope.candidate_sha256 = "c" * 64
        scope.browser_program_sha256 = broker.browser_program_sha256 = "d" * 64
        self.runtime = {"producerSha256": "e" * 64, "role": {"name": "runtime", "oid": "1234"}}
        self.recovery = {"producerSha256": "f" * 64, "role": {"name": "recovery", "oid": "1235"}}
        scope.receipt = {"admissionEpoch": "3", "producers": [self.runtime, self.recovery]}
        broker.initial = {"rotationActionId": scope.action_id, "targetSha256": "9" * 64,
                          "nativePlan": {"producer": self.runtime}, "rotationPlan": {
            "actionId": scope.action_id, "bindingSha256": scope.binding_sha256, "sourceCommit": scope.source_commit,
            "candidateSha256": scope.candidate_sha256, "subjects": {"course-learner": self.customer, "course-admin": self.admin},
            "courseId": self.course, "configuration": {"overlap": {"sha256": "1" * 64}, "current-only": {"sha256": "2" * 64}}}}
        self.host_held = self.db_held = True
        broker.check, scope.verify = self.check_host, self.check_db
        self.admission = self.admission_state("3")
        self.producers, self.operations = [self.runtime, self.recovery], {}
        broker.adapter = types.SimpleNamespace(frontend_deployment=self.deployment)
        broker.observe_rotation_browser_writer_scope = self.observe_writer_scope
        broker.observer = types.SimpleNamespace(probe=lambda operation: {"admission": copy.deepcopy(self.admission)})
        self.wall, self.monotonic = 1_800_000_000, 150
        wall = patch.object(browser.time, "time", side_effect=lambda: self.wall)
        monotonic = patch.object(browser.time, "monotonic", side_effect=lambda: self.monotonic)
        for clock in (wall, monotonic):
            clock.start()
            self.addCleanup(clock.stop)
        self.controller = browser.P2IdentityRotationBrowserScope(broker, self.secret)

    def check_host(self):
        if not self.host_held:
            raise ValueError("owned-host-lost")

    def test_managed_lease_uses_the_exact_probe_registry_and_nested_closed_epoch(self):
        self.scope.receipt = {"version": 2, "admission": self.admission_state("3")}
        self.broker.armed_probe = {"producers": [self.runtime, self.recovery], "receipt": copy.deepcopy(self.scope.receipt)}
        managed = browser.P2IdentityRotationBrowserScope(self.broker, self.secret)
        self.assertEqual(managed.closed_epoch, "3")
        self.assertEqual(managed.original, [self.runtime, self.recovery])
        self.broker.armed_probe["receipt"]["admission"]["recovery"] = True
        with self.assertRaisesRegex(ValueError, "REPLACEMENT_PROBE_REQUIRED"):
            browser.P2IdentityRotationBrowserScope(self.broker, self.secret)

    def check_db(self):
        if not self.db_held:
            raise ValueError("owned-db-lost")

    def deployment(self, phase):
        return {"deploymentId": "dpl_owned" + phase.replace("-", ""), "deploymentUrl": self.deployment_url,
                "sourceCommit": self.scope.source_commit,
                "configurationSha256": self.broker.initial["rotationPlan"]["configuration"][phase]["sha256"]}

    @staticmethod
    def admission_state(epoch, opened=False):
        return {"epoch": epoch, "newWork": opened, "recovery": opened, "active": 0, "uncertain": 0}

    def observe_writer_scope(self, epoch):
        return {"admission": copy.deepcopy(self.admission), "producers": copy.deepcopy(self.producers),
                "operations": copy.deepcopy(self.operations.get(epoch, []))}

    def window(self, phase="overlap", kind="authentication", challenge="3"):
        selection = self.deployment("current-only" if phase == "post-removal" else phase)
        return {"version": 1, "actionId": self.scope.action_id, "bindingSha256": self.scope.binding_sha256,
                "phase": phase, "kind": kind, "maximumSeconds": browser.PURPOSES[kind],
                "source": {"challenge": challenge * 64, "bindingSha256": self.scope.binding_sha256,
                           "browserProgramSha256": self.scope.browser_program_sha256},
                "deploymentId": selection["deploymentId"], "configurationSha256": selection["configurationSha256"],
                "sourceCommit": self.scope.source_commit, "candidateSha256": self.scope.candidate_sha256,
                "browserOrigin": browser.ORIGIN, "canonicalAliasReadbackSha256": "4" * 64,
                "canonicalProtectedWorkloadSha256": "5" * 64}

    def open(self, epoch):
        self.admission = self.admission_state(epoch, True)
        self.producers = [self.controller.interactive]

    def close(self, opened, closed):
        self.admission = self.admission_state(closed)
        self.producers = [self.recovery, self.runtime]  # Registry sort order does not grant authority.
        self.operations[opened] = [
            {"id": str(UUID(int=index + 1, version=4)), "epoch": opened, "kind": kind, "state": "completed",
             "producer_sha256": self.controller.interactive["producerSha256"], "source_sha": self.scope.source_commit,
             "role_oid": self.runtime["role"]["oid"], "completed_at": "2027-01-15T08:00:01.000Z", "reconciliation_sha256": None}
            for index, kind in enumerate(["new-work"] * 5 + ["recovery"] * 2)
        ]

    def assert_cookie(self, cookie, permit, selector):
        version, epoch, stage, started, expires, nonce, actual, signature = cookie.split(".")
        self.assertEqual((version, epoch, stage, int(started), int(expires), actual),
                         ("v2", permit["epoch"], permit["stage"], self.wall, permit["expires"], selector))
        self.assertRegex(nonce, r"^[a-f0-9]{32}$")
        host = self.deployment_url.removeprefix("https://")
        body = cookie.rsplit(".", 1)[0]
        expected = f"lash-her:p2q:interactive:browser:v1\n{host}\n{self.scope.source_commit}\n{self.broker.initial['targetSha256']}\n{body}"
        self.assertEqual(signature, hmac.new(self.secret.encode(), expected.encode(), hashlib.sha256).hexdigest())

    def authenticate(self, window):
        timing = self.controller.prepare(window)
        self.open(timing["permitEpoch"])
        permit = self.controller.take_private_authentication_permits(window)
        self.close(timing["permitEpoch"], timing["closedEpoch"])
        return timing, permit, self.controller.retain_closed(window)

    def signer(self, window):
        timing = self.controller.prepare(window)
        permit = self.controller.take_private_signer_permit(window)
        return timing, permit, self.controller.retain_closed(window)

    def test_all_three_ordered_authentication_windows_issue_bound_once_only_private_permits(self):
        for phase, challenge, start in zip(browser.EVIDENCE_PHASES, "678", (3, 5, 7)):
            auth = self.window(phase, challenge=challenge)
            timing, permit, retained = self.authenticate(auth)
            self.assertEqual(timing, {"beforeEpoch": str(start), "permitEpoch": str(start + 1), "closedEpoch": str(start + 2)})
            self.assertEqual(set(permit), {"stage", "epoch", "expires", "customerCookie", "adminCookie"})
            self.assert_cookie(permit["customerCookie"], permit, b"p2q-rot-cust-v1\0".hex() + self.customer.replace("-", ""))
            self.assert_cookie(permit["adminCookie"], permit, b"p2q-rot-admn-v1\0".hex() + self.admin.replace("-", ""))
            self.assertEqual(permit["expires"], self.wall + 300)
            self.assertEqual(retained["operationCounts"], {"new-work": 5, "recovery": 2})
            signer = self.window(phase, "signer-read", challenge)
            timing, read, receipt = self.signer(signer)
            self.assertEqual(timing, dict.fromkeys(("beforeEpoch", "permitEpoch", "closedEpoch"), str(start + 2)))
            self.assertEqual(set(read), {"stage", "epoch", "expires", "adminCookie"})
            self.assertEqual(read["stage"], "rotation-admin")
            self.assert_cookie(read["adminCookie"], read, (self.admin + self.course).replace("-", ""))
            self.assertEqual(read["expires"], self.wall + 60)
            self.assertEqual(receipt["operationCounts"], {"new-work": 0, "recovery": 0})
            for window, record in ((auth, retained), (signer, receipt)):
                name = f"browser-{phase}-{window['kind']}-writer-scope.json"
                self.assertEqual(record, migrate.read_json(self.directory, name))
                content = (self.directory / name).read_text()
                for item in (self.secret, self.customer, self.admin, permit["customerCookie"], permit["adminCookie"], read["adminCookie"]):
                    self.assertNotIn(item, content)
        with self.assertRaisesRegex(ValueError, "WINDOW_ORDER"):
            self.controller.prepare(self.window())

    def test_refuses_stale_challenges_unreviewed_deployments_and_unguarded_authority(self):
        with self.assertRaisesRegex(ValueError, "WINDOW_ORDER"):
            self.controller.prepare(self.window("current-only"))
        for field, value in (("actionId", "wrong"), ("candidateSha256", "0" * 64),
                             ("browserOrigin", "https://lashher.com"), ("maximumSeconds", 301)):
            with self.assertRaisesRegex(ValueError, "WINDOW_REFUSED"):
                self.controller.prepare({**self.window(), field: value})
        with self.assertRaisesRegex(ValueError, "DEPLOYMENT_REFUSED"):
            self.controller.prepare({**self.window(), "deploymentId": "dpl_unreviewed"})
        self.db_held = False
        with self.assertRaisesRegex(ValueError, "owned-db-lost"):
            self.controller.prepare(self.window())
        self.db_held = True
        self.host_held = False
        with self.assertRaisesRegex(ValueError, "owned-host-lost"):
            self.controller.prepare(self.window())
        self.host_held = True
        self.authenticate(self.window())
        with self.assertRaisesRegex(ValueError, "CHALLENGE_CHANGED"):
            self.controller.prepare(self.window(kind="signer-read", challenge="6"))
        self.signer(self.window(kind="signer-read"))
        with self.assertRaisesRegex(ValueError, "CHALLENGE_REPLAY"):
            self.controller.prepare(self.window("current-only"))

    def test_only_exact_open_epoch_and_interactive_producer_can_issue_authentication_once(self):
        window = self.window()
        timing = self.controller.prepare(window)
        epoch = timing["permitEpoch"]
        with self.assertRaisesRegex(ValueError, "READBACK_REFUSED"):
            self.controller.take_private_authentication_permits(window)
        self.open(epoch)
        self.producers += [self.runtime]
        with self.assertRaisesRegex(ValueError, "READBACK_REFUSED"):
            self.controller.take_private_authentication_permits(window)
        self.producers = [self.controller.interactive]
        self.admission["recovery"] = False
        with self.assertRaisesRegex(ValueError, "READBACK_REFUSED"):
            self.controller.take_private_authentication_permits(window)
        self.admission["recovery"] = True
        self.controller.take_private_authentication_permits(window)
        with self.assertRaisesRegex(ValueError, "PERMIT_REFUSED"):
            self.controller.take_private_authentication_permits(window)
        self.close(epoch, timing["closedEpoch"])
        self.controller.retain_closed(window)
        with self.assertRaisesRegex(ValueError, "CLOSE_REFUSED"):
            self.controller.retain_closed(window)

    def unretained_authentication(self):
        window = self.window()
        timing = self.controller.prepare(window)
        epoch = timing["permitEpoch"]
        self.open(epoch)
        self.controller.take_private_authentication_permits(window)
        self.close(epoch, timing["closedEpoch"])
        return window, epoch

    def test_unverified_close_preserves_pending_scope_and_writes_no_receipt(self):
        window, _ = self.unretained_authentication()
        self.admission["uncertain"] = 1
        with self.assertRaisesRegex(ValueError, "READBACK_REFUSED"):
            self.controller.retain_closed(window)
        self.admission["uncertain"] = 0
        with self.assertRaisesRegex(ValueError, "CLOSE_REFUSED"):
            self.controller.retain_closed(window)
        self.assertFalse(list(self.directory.glob("*writer-scope.json")))
        self.assertTrue(list(self.directory.glob("*writer-intent.json")))
        self.assertEqual(self.controller.closed_epoch, "3")

    def test_reconciled_operation_cannot_be_used_as_authentication_evidence(self):
        window, epoch = self.unretained_authentication()
        self.operations[epoch][0]["reconciliation_sha256"] = "1" * 64
        with self.assertRaisesRegex(ValueError, "OPERATION_REFUSED"):
            self.controller.retain_closed(window)

    def test_missing_operation_cannot_be_replaced_by_closed_zero(self):
        window, epoch = self.unretained_authentication()
        self.operations[epoch].pop(0)
        with self.assertRaisesRegex(ValueError, "OPERATION_COUNTS_REFUSED"):
            self.controller.retain_closed(window)

    def test_durable_prepare_refuses_reusing_action_after_controller_loss(self):
        self.controller.prepare(self.window())
        restarted = browser.P2IdentityRotationBrowserScope(self.broker, self.secret)
        with self.assertRaises(FileExistsError):
            restarted.prepare(self.window())

    def test_signer_remains_closed_and_cannot_retain_any_writer(self):
        self.authenticate(self.window())
        signer = self.window(kind="signer-read")
        timing = self.controller.prepare(signer)
        self.assertEqual(timing["beforeEpoch"], timing["closedEpoch"])
        self.controller.take_private_signer_permit(signer)
        self.operations[timing["closedEpoch"]] = copy.deepcopy(self.operations["4"])
        for row in self.operations[timing["closedEpoch"]]:
            row["epoch"] = timing["closedEpoch"]
        with self.assertRaisesRegex(ValueError, "OPERATION_COUNTS_REFUSED"):
            self.controller.retain_closed(signer)

    def test_permit_expires_on_monotonic_time_and_requires_independent_observer_agreement(self):
        window = self.window()
        timing = self.controller.prepare(window)
        self.open(timing["permitEpoch"])
        self.broker.observer.probe = lambda operation: {"admission": self.admission_state(timing["permitEpoch"])}
        with self.assertRaisesRegex(ValueError, "READBACK_REFUSED"):
            self.controller.take_private_authentication_permits(window)
        self.broker.observer.probe = lambda operation: {"admission": self.admission}
        self.monotonic += 271
        with self.assertRaisesRegex(ValueError, "PERMIT_EXPIRED"):
            self.controller.take_private_authentication_permits(window)


if __name__ == "__main__":
    unittest.main()
