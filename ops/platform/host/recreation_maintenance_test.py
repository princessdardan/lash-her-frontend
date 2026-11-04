from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import migrate
import recreation_maintenance as maintenance
import certificate_invocation_test


class MaintenanceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.inputs = self.root / "inputs"; self.inputs.mkdir(mode=0o700)
        self.material = self.inputs / "maintenance"; self.material.mkdir(mode=0o700)
        self.config = {"version": 1, "environment": "staging", "hostMachineId": maintenance.recreation_prepare.ORIGINAL_MACHINE,
            "publicHost": maintenance.certificates.HOST, "releaseRoot": "/var/lib/lash-her/releases/staging",
            "acmeState": "/var/lib/lash-her/acme-staging", "privateCaState": "/var/lib/lash-her/private-tls-staging",
            "accountEmail": "owned-operator@example.invalid"}
        migrate.write_json(self.material, "certificates-staging.json", self.config)
        self.save("maintenance/private-ca/ca.pem", b"owned-public-ca")
        self.save("maintenance/private-ca/ca.key", b"owned-private-ca-fixture")
        self.save("configuration/tls/ca.pem", b"owned-public-ca")
        self.save("configuration/tls/gateway/cert.pem", b"owned-public-server-certificate")
        self.save("configuration/tls/gateway/key.pem", b"owned-private-server-fixture")
        acme = "maintenance/acme-staging/"
        self.save(acme + "certificates/" + maintenance.certificates.HOST + ".crt", b"owned-public-server-certificate")
        self.save(acme + "certificates/" + maintenance.certificates.HOST + ".key", b"owned-private-server-fixture")
        for name in ("accounts/test/account.json", "accounts/test/keys/account.key", "accounts/test/registration.json",
                     "certificates/extra.crt", "certificates/extra.json"):
            self.save(acme + name, b"owned-existing-account-or-certificate-state")
        self.output = self.root / "output"; self.output.mkdir(mode=0o700)
        self.data = self.root / "data"
        self.unit_dir = self.root / "units"
        self.config_path = self.root / "etc/certificates-staging.json"
        self.canonical = self.root / "opt/ops"; self.canonical.parent.mkdir(mode=0o700)
        self.source_root = self.root / "sources"
        self.source = self.source_root / ("a" * 40) / "ops"
        platform = self.source / "platform"; platform.mkdir(mode=0o700, parents=True)
        for name in (*maintenance.staging_retire.TIMERS, *maintenance.staging_retire.SERVICES):
            (platform / name).write_bytes((Path(maintenance.__file__).parents[1] / name).read_bytes())
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def save(self, name, raw):
        file = self.inputs / name; maintenance.recreation_files.private_parents(file)
        file.write_bytes(raw); file.chmod(0o600)

    def command(self, args, env, timeout=30):
        self.calls.append(args)
        if args[0] == "dpkg-query":
            return maintenance.LEGO_VERSION
        if args[:2] == ["systemd-analyze", "verify"]:
            self.assertTrue(all(Path(p).is_file() for p in args[2:]))
        return ""

    def patches(self):
        stack = ExitStack()
        for name, value in (("DATA", self.data), ("CONFIG", self.config_path), ("UNITS", self.unit_dir),
                            ("CANONICAL_OPS", self.canonical), ("SOURCE_ROOT", self.source_root)):
            stack.enter_context(patch.object(maintenance, name, value))
        stack.enter_context(patch.object(maintenance.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(maintenance.certificates, "command", return_value=b"owned-public-key"))
        stack.enter_context(patch.object(maintenance.staging_retire, "unit_state", side_effect=lambda unit:
            {"ActiveState": "inactive", "UnitFileState": "disabled" if unit.endswith(".timer") else "static"}))
        return stack

    def test_held_private_copies_are_restored_with_new_binding_and_timers_stay_disabled(self):
        with self.patches():
            result = maintenance.install(self.inputs, "2" * 32, self.source, self.output)
        self.assertEqual(result["status"], "RECREATION_MAINTENANCE_INSTALLED_DISABLED")
        self.assertEqual(result["existingAcmeFilesRestored"], 7)
        self.assertFalse(result["newAccountCreated"])
        self.assertFalse(result["timersEnabled"])
        self.assertEqual(json.loads(self.config_path.read_text())["hostMachineId"], "2" * 32)
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.canonical.resolve(), self.source)
        self.assertFalse(any("enable" in args or "start" in args for args in self.calls))
        self.assertFalse(any("owned-private" in file.read_text() for file in self.output.iterdir()))

    def test_changed_runtime_pair_or_ca_refuses_before_copy_or_apt(self):
        file = self.inputs / "configuration/tls/gateway/key.pem"; file.write_bytes(b"different-owned-key")
        with self.patches(), self.assertRaisesRegex(ValueError, "PAIR_MISMATCH"):
            maintenance.install(self.inputs, "2" * 32, self.source, self.output)
        self.assertFalse(self.data.exists()); self.assertEqual(self.calls, [])

    def test_acme_symlink_and_existing_destination_refuse_without_overwrite(self):
        acme = self.material / "acme-staging"
        (acme / "alias.pem").symlink_to(self.inputs / "configuration/tls/gateway/key.pem")
        with self.patches(), self.assertRaisesRegex(ValueError, "ACME_SYMLINK"):
            maintenance.install(self.inputs, "2" * 32, self.source, self.output)
        (acme / "alias.pem").unlink()
        self.config_path.parent.mkdir(); self.config_path.write_bytes(b"existing-protected-config")
        with self.patches(), self.assertRaisesRegex(ValueError, "FRESH_MAINTENANCE_DESTINATIONS"):
            maintenance.install(self.inputs, "2" * 32, self.source, self.output)
        self.assertEqual(self.config_path.read_bytes(), b"existing-protected-config")

    def test_private_ca_key_mismatch_stops_before_unit_install_or_enable(self):
        with self.patches(), patch.object(maintenance.certificates, "command", side_effect=[b"public-a", b"public-b"]), \
                self.assertRaisesRegex(ValueError, "PRIVATE_CA_KEY_MISMATCH"):
            maintenance.install(self.inputs, "2" * 32, self.source, self.output)
        self.assertFalse(self.canonical.exists())
        self.assertFalse(self.unit_dir.exists())
        self.assertFalse(any("enable" in args for args in self.calls))


class MaintenanceActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.inputs = self.root / "inputs"; (self.inputs / "database-receipts").mkdir(parents=True, mode=0o700)
        migrate.write_json(self.inputs / "database-receipts", "candidate.json", {"owned": "candidate"})
        restored = self.root / "restore"; (restored / "native-qualification").mkdir(parents=True, mode=0o700)
        self.plan = {"candidateSha256": "a" * 64, "migrationOutcomeSha256": "b" * 64,
            "originalHostMachineId": maintenance.recreation_prepare.ORIGINAL_MACHINE,
            "originalContainers": [{"containerId": "old-" + str(i)} for i in range(8)]}
        self.containers = [{"containerId": hashlib.sha256(str(i).encode()).hexdigest()} for i in range(8)]
        self.ready = {"status": "API_RUNTIME_RESTORED_FOR_QUALIFICATION", "phase": "completed", "hostMachineId": "2" * 32,
            "environment": "staging", "releaseId": "test-release", "trafficAuthorized": False, "releaseAccepted": False,
            "candidateSha256": "a" * 64, "migrationOutcomeSha256": "b" * 64, "containers": self.containers}
        migrate.write_json(restored, "runtime-outcome.json", self.ready)
        self.qualification = {"status": "NATIVE_WINDOW_CLOSED_AWAITING_PROVIDER_EVIDENCE", "hostMachineId": "2" * 32,
            "releaseId": "test-release", "restoredRuntimeReceiptSha256": hashlib.sha256((restored / "runtime-outcome.json").read_bytes()).hexdigest(),
            "nativeSchedulesDisabled": True, "nativeWindow": {"disabledAndDrained": True}, "frontendDeploymentId": "dpl_owned"}
        self.qual_file = restored / "native-qualification/qualification-outcome.json"
        self.qual_file.write_text(json.dumps(self.qualification)); self.qual_file.chmod(0o600)
        self.output = self.root / "output"; self.output.mkdir(mode=0o700)
        self.config = self.root / "etc/config.json"; self.config.parent.mkdir(mode=0o700)
        migrate.write_json(self.config.parent, self.config.name, {"hostMachineId": "2" * 32})
        self.calls, self.timer_states = [], {}
        self.certificate_status = "TLS_CERTIFICATES_CURRENT"
        self.invocation = "c" * 32
        self.fail_second_timer = False

    def tearDown(self):
        self.temp.cleanup()

    def command(self, args, env, timeout=30):
        self.calls.append(args)
        if args[:3] == ["systemctl", "show", "--value"]:
            return "d" * 32
        if args[:2] == ["systemctl", "show"]:
            return "Result=success\nExecMainStatus=0\nActiveState=inactive"
        if args[0] == "journalctl":
            records = certificate_invocation_test.fixture(self.invocation, 40 if self.invocation == "d" * 32 else 100)
            records[1]["MESSAGE"] = json.dumps({"status": self.certificate_status, "renewed": [], "servicesStopped": False})
            return "\n".join(map(json.dumps, records))
        if args[:3] == ["systemctl", "enable", "--now"]:
            if self.fail_second_timer and len(self.timer_states) == 1:
                raise ValueError("OWNED_ENABLE_AMBIGUOUS")
            self.timer_states[args[-1]] = True
        if args[:3] == ["systemctl", "disable", "--now"]:
            self.timer_states[args[-1]] = False
        return ""

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(maintenance, "CONFIG", self.config))
        stack.enter_context(patch.object(maintenance.staging_state, "retained_state", return_value=({"releaseId": "test-release"}, {}, self.plan, b"")))
        stack.enter_context(patch.object(maintenance.runtime, "check_containers", return_value=self.containers))
        stack.enter_context(patch.object(maintenance.staging_restore, "check_provider"))
        stack.enter_context(patch.object(maintenance.certificates, "plan"))
        stack.enter_context(patch.object(maintenance, "current_certificate_check"))
        stack.enter_context(patch.object(maintenance.runtime, "command", side_effect=self.command))
        stack.enter_context(patch.object(maintenance.time, "monotonic_ns", return_value=50_000))
        stack.enter_context(patch.object(maintenance.certificate_invocation, "current_boot_id", return_value=certificate_invocation_test.BOOT))
        stack.enter_context(patch.object(maintenance.staging_retire, "unit_state", side_effect=lambda name:
            {"ActiveState": "active" if self.timer_states.get(name) else "inactive", "UnitFileState": "enabled" if self.timer_states.get(name) else "disabled"}))
        return stack

    def execute(self):
        with self.patches():
            return maintenance.activate(self.inputs, "2" * 32, self.root, self.output, object())

    def test_actual_new_noop_invocation_precedes_both_timer_enables_and_never_accepts_release(self):
        result = self.execute()
        self.assertEqual(result["status"], "RECREATION_MAINTENANCE_ACTIVE")
        self.assertEqual(result["certificateUnitInvocationId"], self.invocation)
        self.assertFalse(result["renewalPerformed"])
        self.assertFalse(result["releaseAccepted"])
        journal_index = next(i for i, args in enumerate(self.calls) if args[0] == "journalctl")
        self.assertTrue(all(i > journal_index for i, args in enumerate(self.calls) if "enable" in args))

    def test_busy_or_stale_certificate_unit_cannot_enable_timers(self):
        self.certificate_status = "TLS_RENEWAL_SKIPPED_RELEASE_BUSY"
        with self.assertRaisesRegex(ValueError, "CURRENT_CERTIFICATE_NOOP"):
            self.execute()
        self.assertFalse(self.timer_states)
        # Use a new private output for the second deliberate owned attempt.
        self.output = self.root / "output-second"; self.output.mkdir(mode=0o700)
        self.certificate_status = "TLS_CERTIFICATES_CURRENT"; self.invocation = "d" * 32
        with self.assertRaisesRegex(ValueError, "ACTUAL_CERTIFICATE_UNIT"):
            self.execute()
        self.assertFalse(self.timer_states)

    def test_partial_timer_enable_is_disabled_without_an_automatic_retry(self):
        self.fail_second_timer = True
        with self.assertRaisesRegex(ValueError, "OWNED_ENABLE_AMBIGUOUS"):
            self.execute()
        self.assertTrue(all(value is False for value in self.timer_states.values()))
        self.assertEqual(sum("enable" in args for args in self.calls), 2)
        self.assertEqual(sum("disable" in args for args in self.calls), 2)

    def test_changed_runtime_receipt_or_undrained_qualification_refuses_before_unit_start(self):
        self.qualification["nativeWindow"]["disabledAndDrained"] = False
        self.qual_file.write_text(json.dumps(self.qualification))
        with self.assertRaisesRegex(ValueError, "ACTUAL_RESTORED_QUALIFICATION"):
            self.execute()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
