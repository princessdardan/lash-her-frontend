"""Effective SSH policy after recovery from a changing operator public IP.

The Lightsail edge owns the public IPv4 /32 source filter. UFW still denies
private-network SSH and every IPv6 ingress path. Password and root login remain
disabled. Never infer an edge rule from this host-only observation.
"""
import re

import migrate

POLICY = "provider-ipv4-source-v2"
RULES = (
    "22/tcp DENY IN 10.0.0.0/8",
    "22/tcp DENY IN 172.16.0.0/12",
    "22/tcp DENY IN 192.168.0.0/16",
    "22/tcp ALLOW IN Anywhere",
    "443/tcp ALLOW IN Anywhere",
)


def verify_firewall(text):
    rules = tuple(re.sub(r"\s+", " ", match.group(1)).strip() for line in text.splitlines()
                  if (match := re.fullmatch(r"\[\s*\d+\]\s+(.+)", line.strip())))
    migrate.demand(text.startswith("Status: active\n") and rules == RULES,
                   "RECOVERY_EXACT_HOST_FIREWALL_REQUIRED")
    return {"policy": POLICY, "publicSshSourceFilter": "Lightsail-edge/operator-ipv4-32",
            "privateNetworkSshDenied": True, "ipv6IngressAllowed": False,
            "providerRulesIndependentlyRequired": True}
