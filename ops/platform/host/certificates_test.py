import fcntl
import json
import os
from pathlib import Path
import stat
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

import certificates


class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.patch = patch.object(certificates, "DATA", self.root)
        self.patch.start()
        self.configuration = {"version": 1, "environment": "staging", "publicHost": certificates.HOST,
                              "hostMachineId": "a" * 32, "releaseRoot": str(self.root / "releases/staging"),
                              "acmeState": str(self.root / "acme-staging"), "privateCaState": str(self.root / "private-tls-staging"),
                              "accountEmail": "operator@example.invalid"}
        self.lock = self.root / "release.lock"
        self.selected, self.running, self.calls = {}, {}, []
        for service in certificates.SERVICES:
            leaf = "gateway" if service == "gateway" else service.split("-")[0]
            directory = self.root / "releases/staging/current/tls" / leaf
            directory.mkdir(parents=True, mode=0o700)
            for name in ("cert.pem", "key.pem"):
                certificates.save_private(directory / name, ("old-" + service + "-" + name).encode())
            identity = str(len(self.selected) + 1) * 64
            self.selected[service] = {"id": identity, "directory": directory}
            self.running[identity] = True
        for directory in (Path(self.configuration["privateCaState"]), Path(self.configuration["acmeState"])):
            directory.mkdir(mode=0o700)
        self.ca = Path(self.configuration["privateCaState"]) / "ca.pem"
        certificates.save_private(self.ca, b"owned-ca")
        certificates.save_private(self.ca.with_suffix(".key"), b"owned-ca-key")
        self.selected["gateway"]["directory"].joinpath("ca.pem").write_bytes(b"owned-ca")
        self.selected["gateway"]["directory"].parent.joinpath("ca.pem").write_bytes(b"owned-ca")
        self.due = set()
        self.ca_days = 365
        self.fail = None
        self.failure_used = False
        self.served = []

    def tearDown(self):
        self.patch.stop()
        self.temporary.cleanup()

    def expiry(self, file):
        if file == self.ca:
            return time.time() + self.ca_days * 86400
        value = file.read_bytes()
        near = any(value.startswith(("old-" + service + "-").encode()) for service in self.due)
        return time.time() + (2 if near else 90) * 86400

    def command(self, args, timeout=15):
        self.calls.append(args)
        if args[:2] == ["dpkg-query", "-W"]:
            return b"4.9.1-2ubuntu0.24.04.3"
        if args[:2] == ["docker", "stop"]:
            self.running[args[-1]] = False
            if self.fail == "ambiguous-stop" and not self.failure_used:
                self.failure_used = True
                raise subprocess.TimeoutExpired(args, 40)
        elif args[:2] == ["docker", "start"]:
            if self.fail == "restart" and not self.failure_used:
                self.failure_used = True
                raise ValueError("owned restart failure")
            self.running[args[-1]] = True
        elif args[:2] == ["docker", "inspect"]:
            return b"true" if self.running[args[-1]] else b"false"
        elif args[0] == "/usr/bin/lego":
            directory = Path(self.configuration["acmeState"]) / "certificates"
            directory.mkdir(mode=0o700, exist_ok=True)
            for suffix in ("crt", "key"):
                certificates.save_private(directory / (certificates.HOST + "." + suffix), ("new-gateway-" + suffix).encode())
            if self.fail == "issued-then-timeout":
                raise subprocess.TimeoutExpired(args, 180)
        elif args[:2] == ["openssl", "req"]:
            certificates.save_private(Path(args[args.index("-keyout") + 1]), b"new-peer-key")
            certificates.save_private(Path(args[args.index("-out") + 1]), b"owned-request")
        elif args[:3] == ["openssl", "x509", "-req"]:
            certificates.save_private(Path(args[args.index("-out") + 1]), b"new-peer-certificate")
        else:
            raise AssertionError("Unexpected command")
        return b""

    def verify_pair(self, certificate, _key, _hostname, _authority=None, existing=False):
        if self.fail == "new-pair" and not existing:
            raise ValueError("owned invalid new pair")

    def verify_served(self, service, _certificate, _authority):
        self.served.append(service)
        if self.fail == "served" and not self.failure_used:
            self.failure_used = True
            raise ValueError("owned wrong served certificate")

    def execute(self, apply=True, confirmation="staging/certificate-renewal"):
        with patch.object(certificates.runtime, "assert_host"), \
             patch.object(certificates, "inventory", return_value=self.selected), \
             patch.object(certificates, "private_file"), \
             patch.object(certificates, "expiry", side_effect=self.expiry), \
             patch.object(certificates, "verify_pair", side_effect=self.verify_pair), \
             patch.object(certificates, "verify_served", side_effect=self.verify_served), \
             patch.object(certificates, "command", side_effect=self.command):
            return certificates.execute(self.configuration, apply, confirmation, self.lock)

    def outcome(self):
        paths = list((self.root / "certificate-renewals-staging").glob("*/outcome.json"))
        self.assertEqual(len(paths), 1)
        return json.loads(paths[0].read_text())

    def assert_previous_pairs(self):
        for service in self.due:
            directory = self.selected[service]["directory"]
            for name in ("cert.pem", "key.pem"):
                self.assertEqual((directory / name).read_bytes(), ("old-" + service + "-" + name).encode())
        self.assertTrue(all(self.running.values()))

    def test_plan_acquires_no_credentials_and_runs_no_command(self):
        result = self.execute(False)
        self.assertFalse(result["credentialsRead"])
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / "certificate-renewals-staging").exists())

    def test_wrong_target_or_confirmation_refuses_early(self):
        self.configuration["environment"] = "production"
        with self.assertRaisesRegex(ValueError, "CERTIFICATE_TARGET"):
            self.execute()
        self.configuration["environment"] = "staging"
        with self.assertRaisesRegex(ValueError, "EXPLICIT_CERTIFICATE"):
            self.execute(confirmation="production/certificate-renewal")
        self.assertEqual(self.calls, [])

    def test_real_release_lock_contention_skips_before_private_inputs(self):
        with self.lock.open("a+") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.execute()
        self.assertEqual(result["status"], "TLS_RENEWAL_SKIPPED_RELEASE_BUSY")
        self.assertEqual(self.calls, [])

    def test_current_certificates_never_stop_containers_or_contact_acme(self):
        self.assertEqual(self.execute()["status"], "TLS_CERTIFICATES_CURRENT")
        self.assertEqual(self.calls, [])

    def test_expiring_public_and_peer_pairs_are_renewed_with_scoped_restart(self):
        self.due = {"gateway", "course-tls"}
        result = self.execute()
        self.assertEqual(result["status"], "TLS_CERTIFICATES_RENEWED")
        self.assertEqual(set(result["renewed"]), self.due)
        self.assertEqual(set(self.served), self.due)
        self.assertTrue(all(self.running.values()))
        unaffected = self.selected["community-tls"]["id"]
        self.assertFalse(any(args[:2] in (["docker", "stop"], ["docker", "start"]) and args[-1] == unaffected for args in self.calls))
        self.assertFalse((self.root / "certificate-renewals-staging/in-progress.json").exists())
        for path in (self.root / "certificate-renewals-staging").rglob("*.pem"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_private_only_renewal_never_contacts_acme_or_stops_gateway(self):
        self.due = {"community-tls"}
        self.execute()
        self.assertFalse(any(args[0] == "/usr/bin/lego" for args in self.calls))
        self.assertFalse(any(self.selected["gateway"]["id"] in args for args in self.calls))

    def test_ca_rotation_is_required_before_leaf_could_outlive_it(self):
        self.due = {"course-tls"}; self.ca_days = 60
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assertFalse(any(args[:2] == ["docker", "stop"] for args in self.calls))
        self.assert_previous_pairs()

    def test_ambiguous_stop_is_reconciled_without_calling_acme(self):
        self.due = {"gateway"}; self.fail = "ambiguous-stop"
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assert_previous_pairs()
        self.assertFalse(any(args[0] == "/usr/bin/lego" for args in self.calls))
        self.assertTrue(self.outcome()["runtimeRecovered"])

    def test_issued_then_timed_out_keeps_live_old_pair_and_retains_review_marker(self):
        self.due = {"gateway"}; self.fail = "issued-then-timeout"
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assert_previous_pairs()
        self.assertTrue((self.root / "certificate-renewals-staging/in-progress.json").exists())
        calls = len(self.calls)
        with self.assertRaisesRegex(ValueError, "PREVIOUS_CERTIFICATE_ATTEMPT"):
            self.execute()
        self.assertEqual(len(self.calls), calls)

    def test_invalid_new_pair_restarts_old_without_installing(self):
        self.due = {"gateway"}; self.fail = "new-pair"
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assert_previous_pairs()

    def test_partial_pair_replacement_failure_restores_both_old_files(self):
        self.due = {"gateway"}
        original = certificates.replace_file
        count = 0
        def replace(path, value):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("owned interrupted key replacement")
            return original(path, value)
        with patch.object(certificates, "replace_file", side_effect=replace):
            with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
                self.execute()
        self.assert_previous_pairs()
        self.assertTrue(self.outcome()["previousPairsRestored"])

    def test_failed_restart_restores_previous_configuration(self):
        self.due = {"gateway"}; self.fail = "restart"
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assert_previous_pairs()
        self.assertTrue(self.outcome()["runtimeRecovered"])

    def test_served_pair_failure_restores_previous_configuration(self):
        self.due = {"gateway"}; self.fail = "served"
        with self.assertRaisesRegex(ValueError, "REQUIRES_REVIEW"):
            self.execute()
        self.assert_previous_pairs()
        self.assertTrue(self.outcome()["runtimeRecovered"])

    def test_ca_mismatch_refuses_before_certificate_or_container_changes(self):
        (self.selected["gateway"]["directory"] / "ca.pem").write_bytes(b"different-ca")
        with self.assertRaisesRegex(ValueError, "ACTIVE_PRIVATE_CA_MISMATCH"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_inventory_binds_exact_project_images_mounts_ports_and_shared_release(self):
        payloads = {}
        for service, item in self.selected.items():
            payloads[service] = {"Id": item["id"], "State": {"Running": True}, "Config": {
                "Labels": {"com.docker.compose.project": "lash-her-staging", "com.docker.compose.service": service},
                "Image": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "a" * 64},
                "HostConfig": {"PortBindings": {"8443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "443"}]} if service == "gateway" else {}},
                "Mounts": [{"Type": "bind", "RW": False, "Destination": "/tls", "Source": str(item["directory"])}]}
        def inventory_command(args, timeout=15):
            if args[:2] == ["docker", "ps"]:
                service = args[-1].rsplit("=", 1)[1]
                return self.selected[service]["id"].encode()
            service = next(name for name, item in self.selected.items() if item["id"] == args[-1])
            return json.dumps([payloads[service]]).encode()
        with patch.object(certificates, "command", side_effect=inventory_command), patch.object(certificates, "private_file"):
            self.assertEqual(certificates.inventory(self.configuration), self.selected)
            for mutate in (
                lambda item: item["Config"].update(Image="gateway:latest"),
                lambda item: item["Config"]["Labels"].update({"com.docker.compose.project": "lash-her-production"}),
                lambda item: item["State"].update(Running=False),
                lambda item: item["Mounts"][0].update(RW=True),
                lambda item: item["Mounts"][0].update(Source="/etc/tls/gateway"),
                lambda item: item["HostConfig"]["PortBindings"].update({"8443/tcp": [{"HostIp": "::", "HostPort": "443"}]}),
            ):
                before = json.loads(json.dumps(payloads["gateway"]))
                mutate(payloads["gateway"])
                with self.assertRaises(ValueError):
                    certificates.inventory(self.configuration)
                payloads["gateway"] = before


class OpenSslPairTests(unittest.TestCase):
    def setUp(self):
        # The executor runs only on Linux. On macOS the system /usr/bin/openssl
        # is LibreSSL; use the installed OpenSSL3 for owned compatibility tests.
        self.openssl = shutil.which("openssl")
        self.environment = patch.dict(certificates.SAFE_ENV, {"PATH": str(Path(self.openssl).parent) + os.pathsep + certificates.SAFE_ENV["PATH"]})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()

    def test_actual_key_mismatch_wrong_hostname_and_untrusted_ca_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in ("expected", "other"):
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "45",
                                "-keyout", str(root / (name + ".key")), "-out", str(root / (name + ".pem")),
                                "-subj", "/CN=course-tls", "-addext", "subjectAltName=DNS:course-tls"],
                               capture_output=True, check=True)
            certificates.verify_pair(root / "expected.pem", root / "expected.key", "course-tls", root / "expected.pem")
            self.assertGreater(certificates.expiry(root / "expected.pem"), time.time() + 44 * 86400)
            with self.assertRaisesRegex(ValueError, "KEY_MISMATCH"):
                certificates.verify_pair(root / "expected.pem", root / "other.key", "course-tls", root / "expected.pem")
            for hostname, authority in (("community-tls", "expected"), ("course-tls", "other")):
                with self.assertRaises(ValueError):
                    certificates.verify_pair(root / "expected.pem", root / "expected.key", hostname, root / (authority + ".pem"))

    def test_atomic_replacement_preserves_permissions_and_private_paths_refuse_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            file = root / "key.pem"; certificates.save_private(file, b"old")
            file.chmod(0o400)
            certificates.replace_file(file, b"new")
            self.assertEqual(file.read_bytes(), b"new")
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o400)
            with patch.object(certificates, "DATA", root):
                certificates.private_file(file, {os.getuid()})
                alias = root / "alias.pem"; alias.symlink_to(file)
                with self.assertRaisesRegex(ValueError, "SYMLINK"):
                    certificates.private_file(alias, {os.getuid()})

    def test_real_tls_handshake_verifies_the_actual_served_leaf(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for name in ("served", "different"):
                subprocess.run([self.openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "45",
                                "-keyout", str(root / (name + ".key")), "-out", str(root / (name + ".pem")),
                                "-subj", "/CN=course-tls", "-addext", "subjectAltName=DNS:course-tls"],
                               capture_output=True, check=True)
            authority = root / "ca.pem"
            authority.write_bytes((root / "served.pem").read_bytes() + (root / "different.pem").read_bytes())
            original_connect = socket.create_connection
            for expected in ("served", "different"):
                with socket.socket() as listener:
                    listener.bind(("127.0.0.1", 0)); listener.listen()
                    port = listener.getsockname()[1]
                    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    context.load_cert_chain(root / "served.pem", root / "served.key")
                    def serve():
                        connection, _ = listener.accept()
                        try:
                            with context.wrap_socket(connection, server_side=True):
                                pass
                        except ssl.SSLError:
                            connection.close()
                    worker = threading.Thread(target=serve, daemon=True); worker.start()
                    def connect(address, timeout):
                        self.assertEqual(address, ("172.29.10.20", 8443))
                        return original_connect(("127.0.0.1", port), timeout)
                    with patch.object(certificates.socket, "create_connection", side_effect=connect), \
                         patch.object(certificates.time, "monotonic", side_effect=[0, 31]):
                        if expected == "served":
                            certificates.verify_served("course-tls", root / (expected + ".pem"), authority)
                        else:
                            with self.assertRaisesRegex(ValueError, "SERVED_CERTIFICATE_UNVERIFIED"):
                                certificates.verify_served("course-tls", root / (expected + ".pem"), authority)
                    worker.join(timeout=2)
                    self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
