import unittest

import ssh_access


class SshAccessTests(unittest.TestCase):
    def text(self, rules=None):
        return "Status: active\n\n" + "\n".join("[ %d] %s" % (i + 1, rule) for i, rule in enumerate(rules or ssh_access.RULES)) + "\n"

    def test_exact_ordered_ipv4_host_policy_requires_separate_provider_filter(self):
        value = ssh_access.verify_firewall(self.text())
        self.assertTrue(value["privateNetworkSshDenied"])
        self.assertTrue(value["providerRulesIndependentlyRequired"])
        self.assertFalse(value["ipv6IngressAllowed"])

    def test_private_denials_cannot_follow_allow_or_be_omitted(self):
        for rules in (ssh_access.RULES[1:], (*ssh_access.RULES[3:], *ssh_access.RULES[:3]),
                      (*ssh_access.RULES, "22/tcp ALLOW IN Anywhere (v6)"),
                      (*ssh_access.RULES, "4000/tcp ALLOW IN Anywhere")):
            with self.assertRaisesRegex(ValueError, "EXACT_HOST_FIREWALL"):
                ssh_access.verify_firewall(self.text(rules))
        with self.assertRaisesRegex(ValueError, "EXACT_HOST_FIREWALL"):
            ssh_access.verify_firewall(self.text().replace("Status: active", "Status: inactive"))


if __name__ == "__main__":
    unittest.main()
