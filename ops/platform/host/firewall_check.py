"""Kernel rule rehearsal inside an owned network-none NET_ADMIN test container."""
import subprocess

from bootstrap import forwarding_script


def command(args):
    return subprocess.run(args, text=True, capture_output=True, check=True, timeout=10).stdout


command(["iptables", "-N", "DOCKER-USER"])
command(["iptables", "-A", "FORWARD", "-j", "DOCKER-USER"])
script = forwarding_script("ens5")
for attempt in range(3):
    if attempt:
        # Simulate another Docker rule being inserted ahead of the old IPv6
        # hook at daemon restart. The transaction must restore first position.
        command(["ip6tables", "-I", "FORWARD", "1", "-j", "ACCEPT"])
    subprocess.run(["sh"], input=script, text=True, check=True, capture_output=True, timeout=20)
    ipv4 = command(["iptables", "-S", "DOCKER-USER"]).splitlines()
    ipv6 = [line for line in command(["ip6tables", "-S", "FORWARD"]).splitlines() if line.startswith("-A ")]
    assert ipv4.count("-A DOCKER-USER -j LASH-HER-INGRESS") == 1
    assert ipv4[1] == "-A DOCKER-USER -j LASH-HER-INGRESS"
    assert ipv6[0] == "-A FORWARD -j LASH-HER-INGRESS"
    assert ipv6.count("-A FORWARD -j LASH-HER-INGRESS") == 1
    policy4 = command(["iptables", "-S", "LASH-HER-INGRESS"])
    policy6 = command(["ip6tables", "-S", "LASH-HER-INGRESS"])
    assert "--ctorigdstport 443" in policy4 and "--dport 8443" in policy4
    assert "-i ens5 -j DROP" in policy4 and "-i ens5 -j DROP" in policy6
    assert "--dport" not in policy6
print("Isolated IPv4/IPv6 kernel rule creation and repeated restart ordering passed")
