import copy
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import bootstrap


class BootstrapPolicyTests(unittest.TestCase):
    def setUp(self):
        self.lock, self.sha = bootstrap.load_lock(Path(__file__).with_name("packages.lock.json"))

    def test_plan_has_no_execution_or_secret_side_effect(self):
        with patch.object(bootstrap, "command", side_effect=AssertionError("Plan executed a command")):
            plan = bootstrap.make_plan(self.lock, self.sha, "ens5")
        self.assertFalse(plan["applicationDeploy"])
        self.assertFalse(plan["secretFetch"])
        self.assertEqual(plan["lockSha256"], self.sha)
        self.assertEqual(len(plan["packages"]), 5)
        self.assertEqual(plan["daemon"]["firewall-backend"], "iptables")
        self.assertFalse(plan["daemon"]["userland-proxy"])

    def test_firewall_uses_pre_docker_filter_and_original_destination(self):
        script = bootstrap.forwarding_script("ens5")
        ipv4, ipv6 = script.split("ip6tables-restore", 1)
        self.assertIn("-I DOCKER-USER 1 -j LASH-HER-INGRESS", ipv4)
        self.assertIn("--dport 8443", ipv4)
        self.assertIn("--ctorigdstport 443", ipv4)
        self.assertNotIn("-j ACCEPT", script)
        self.assertLess(ipv4.index("--ctstate ESTABLISHED,RELATED"), ipv4.index("-i ens5 -j DROP"))
        self.assertIn("-I FORWARD 1 -j LASH-HER-INGRESS", ipv6)
        self.assertIn("-i ens5 -j DROP", ipv6)
        self.assertNotIn("--dport", ipv6)
        self.assertNotIn("-F FORWARD", script)
        self.assertNotIn("-F DOCKER-USER", script)
        self.assertLess(ipv4.index("$remove_ipv4"), ipv4.index("-I DOCKER-USER 1"))
        self.assertLess(ipv6.index("$remove_ipv6"), ipv6.index("-I FORWARD 1"))
        subprocess.run(["sh", "-n"], input=script, text=True, check=True, capture_output=True)

    def test_interface_cannot_inject_commands_or_select_private_bridge(self):
        for interface in ["lo", "docker0", "br-private", "veth123", "ens5;id", "eth0\ntrue", "$(id)", "", "a" * 16]:
            with self.subTest(interface=interface), self.assertRaises(ValueError):
                bootstrap.forwarding_script(interface)

    def test_alternate_ipv6_uplink_cannot_escape_forwarding_policy(self):
        bootstrap.validate_routes([{"dev": "ens5"}], [], "ens5")
        bootstrap.validate_routes([{"dev": "ens5"}], [{"dev": "ens5"}], "ens5")
        for ipv4, ipv6 in [([], []), ([{"dev": "ens6"}], []), ([{"dev": "ens5"}], [{"dev": "ens6"}])]:
            with self.assertRaises(ValueError):
                bootstrap.validate_routes(ipv4, ipv6, "ens5")

    def test_apply_without_exact_reviewed_hash_fails_before_execution(self):
        plan = bootstrap.make_plan(self.lock, self.sha, "ens5")
        with patch.object(bootstrap, "command", side_effect=AssertionError("Unreviewed apply executed")):
            for value in [None, "0" * 64, self.sha + "x"]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    bootstrap.apply(plan, value)

    def test_apply_on_wrong_platform_fails_before_execution(self):
        plan = bootstrap.make_plan(self.lock, self.sha, "ens5")
        with patch.object(bootstrap.platform, "system", return_value="Darwin"), patch.object(bootstrap, "command", side_effect=AssertionError("Wrong host executed")):
            with self.assertRaises(ValueError):
                bootstrap.apply(plan, self.sha)

    def test_package_identity_and_hash_are_closed(self):
        import json
        import tempfile
        for modify in [
            lambda lock: lock.update(architecture="arm64"),
            lambda lock: lock["packages"].pop(),
            lambda lock: lock["packages"][0].update(url="https://example.invalid/docker.deb"),
            lambda lock: lock["packages"][0].update(sha256="not-a-digest"),
            lambda lock: lock["packages"][0].update(version="29; id"),
        ]:
            value = copy.deepcopy(self.lock)
            modify(value)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory, "lock.json")
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    bootstrap.load_lock(path)


if __name__ == "__main__":
    unittest.main()
