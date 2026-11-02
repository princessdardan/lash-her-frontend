#!/usr/bin/env python3
"""Fresh Ubuntu host preparation. Plan by default; no application/secret delivery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import urllib.request

PACKAGES = {"docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin"}
DAEMON = {"firewall-backend": "iptables", "iptables": True, "ip6tables": True,
          "userland-proxy": False, "live-restore": True, "log-driver": "local",
          "log-opts": {"max-size": "10m", "max-file": "3"}}
EXECUTABLE = "/usr/local/libexec/lash-her-forwarding"
DROPIN = "/etc/systemd/system/docker.service.d/20-lash-her-forwarding.conf"
RECEIPT = "/var/lib/lash-her/host-bootstrap.json"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def load_lock(path):
    raw = path.read_bytes()
    lock = json.loads(raw)
    if (lock.get("version"), lock.get("os"), lock.get("release"), lock.get("architecture")) != (1, "ubuntu", "24.04", "amd64"):
        raise ValueError("Unsupported bootstrap target")
    packages = lock.get("packages", [])
    if len(packages) != len(PACKAGES) or {p.get("name") for p in packages} != PACKAGES:
        raise ValueError("Exact Docker package set required")
    for package in packages:
        name = package["name"]
        if not isinstance(package.get("version"), str) or not re.fullmatch(r"[0-9][0-9A-Za-z:.+~_-]{0,100}", package["version"]):
            raise ValueError("Invalid package version")
        if not re.fullmatch(r"[0-9a-f]{64}", package.get("sha256", "")):
            raise ValueError("Package SHA256 required")
        prefix = "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/"
        filename = package.get("url", "").removeprefix(prefix)
        if not package.get("url", "").startswith(prefix) or not re.fullmatch(re.escape(name) + r"_[0-9A-Za-z.+~_-]+_amd64\.deb", filename):
            raise ValueError("Pinned official package URL required")
    return lock, digest(raw)


def forwarding_script(interface):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,14}", interface) or interface == "lo" or interface.startswith(("br-", "docker", "veth")):
        raise ValueError("Explicit public interface required")
    # DNAT is already applied at DOCKER-USER. Match both original and translated
    # ports; RETURN leaves Docker's own network/port rules in force.
    return f"""#!/bin/sh
set -eu
iptables --wait 10 -S DOCKER-USER >/dev/null
remove_ipv4=''
if iptables --wait 10 -C DOCKER-USER -j LASH-HER-INGRESS 2>/dev/null; then remove_ipv4='-D DOCKER-USER -j LASH-HER-INGRESS'; fi
iptables-restore --wait 10 --noflush <<IPV4
*filter
:LASH-HER-INGRESS - [0:0]
-F LASH-HER-INGRESS
-A LASH-HER-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A LASH-HER-INGRESS -i {interface} -p tcp --dport 8443 -m conntrack --ctstate NEW --ctorigdstport 443 -j RETURN
-A LASH-HER-INGRESS -i {interface} -j DROP
-A LASH-HER-INGRESS -j RETURN
$remove_ipv4
-I DOCKER-USER 1 -j LASH-HER-INGRESS
COMMIT
IPV4
remove_ipv6=''
if ip6tables --wait 10 -C FORWARD -j LASH-HER-INGRESS 2>/dev/null; then remove_ipv6='-D FORWARD -j LASH-HER-INGRESS'; fi
ip6tables-restore --wait 10 --noflush <<IPV6
*filter
:LASH-HER-INGRESS - [0:0]
-F LASH-HER-INGRESS
-A LASH-HER-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A LASH-HER-INGRESS -i {interface} -j DROP
-A LASH-HER-INGRESS -j RETURN
$remove_ipv6
-I FORWARD 1 -j LASH-HER-INGRESS
COMMIT
IPV6
"""


def make_plan(lock, lock_hash, interface):
    script = forwarding_script(interface)
    dropin = f"[Service]\nExecStartPost={EXECUTABLE}\n"
    return {"version": 1, "lockSha256": lock_hash, "target": "ubuntu-24.04-amd64",
            "publicInterface": interface, "packages": lock["packages"], "daemon": DAEMON,
            "forwardingScript": script, "forwardingSha256": digest(script.encode()),
            "systemdDropIn": dropin, "applicationDeploy": False, "secretFetch": False}


def command(args, **options):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=300, **options).stdout.strip()


def validate_routes(ipv4, ipv6, interface):
    if not ipv4 or {route.get("dev") for route in ipv4} != {interface} or not {route.get("dev") for route in ipv6}.issubset({interface}):
        raise ValueError("Every IPv4/IPv6 default route must use the selected public interface")


def write_owned(path, content, mode):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with path.open("x") as stream:
        stream.write(content)
    path.chmod(mode)


def apply(plan, reviewed_hash):
    if not reviewed_hash or reviewed_hash != plan["lockSha256"]:
        raise ValueError("Apply requires the reviewed exact package-lock SHA256")
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64") or os.geteuid() != 0:
        raise ValueError("Apply requires root on the selected Linux AMD64 host")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "ubuntu" or release.get("VERSION_ID", "").strip('"') != "24.04":
        raise ValueError("Apply requires Ubuntu 24.04")
    # Bootstrap is intentionally limited to a fresh host. Refuse upgrades or
    # overwriting operator configuration rather than weakening an existing host.
    for path in ["/etc/docker/daemon.json", EXECUTABLE, DROPIN, RECEIPT, "/var/lib/docker", "/var/lib/containerd"]:
        if Path(path).exists():
            raise ValueError("Existing Docker/configuration detected; use a reviewed maintenance procedure")
    installed = command(["dpkg-query", "-W", "-f=${binary:Package}\\n"])
    if {line.split(":")[0] for line in installed.splitlines()} & (PACKAGES | {"docker.io", "containerd", "runc", "podman-docker"}):
        raise ValueError("Conflicting/existing container packages detected")
    routes = json.loads(command(["ip", "-json", "route", "show", "default"]))
    routes6 = json.loads(command(["ip", "-6", "-json", "route", "show", "default"]))
    validate_routes(routes, routes6, plan["publicInterface"])
    if not Path("/sys/class/net", plan["publicInterface"]).exists():
        raise ValueError("Public interface does not exist")
    command(["apt-get", "update"])
    command(["apt-get", "install", "-y", "--no-install-recommends", "ca-certificates", "iptables", "iproute2", "util-linux"])
    with tempfile.TemporaryDirectory(prefix="lash-her-bootstrap-") as directory:
        downloaded = []
        for package in plan["packages"]:
            target = Path(directory, package["url"].rsplit("/", 1)[1])
            # Explicit URL/hash; disallow redirects and an unbounded download.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs):
                    raise ValueError("Package redirect refused")
            with urllib.request.build_opener(NoRedirect).open(package["url"], timeout=30) as response, target.open("xb") as stream:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 150 * 1024 * 1024:
                        raise ValueError("Package exceeds download bound")
                    stream.write(chunk)
            if digest(target.read_bytes()) != package["sha256"]:
                raise ValueError("Downloaded package hash mismatch")
            if command(["dpkg-deb", "-f", str(target), "Package"]) != package["name"] or command(["dpkg-deb", "-f", str(target), "Version"]) != package["version"] or command(["dpkg-deb", "-f", str(target), "Architecture"]) != "amd64":
                raise ValueError("Downloaded package identity mismatch")
            downloaded.append(str(target))
        write_owned("/etc/docker/daemon.json", json.dumps(DAEMON, indent=2) + "\n", 0o644)
        write_owned(EXECUTABLE, plan["forwardingScript"], 0o755)
        write_owned(DROPIN, plan["systemdDropIn"], 0o644)
        command(["systemctl", "daemon-reload"])
        command(["apt-get", "install", "-y", "--no-install-recommends", *downloaded])
    command(["systemctl", "enable", "--now", "docker"])
    command([EXECUTABLE])
    command(["docker", "info", "--format", "{{.ServerVersion}}"])
    versions = {p["name"]: command(["dpkg-query", "-W", "-f=${Version}", p["name"]]) for p in plan["packages"]}
    if versions != {p["name"]: p["version"] for p in plan["packages"]}:
        raise ValueError("Installed package version mismatch")
    # Active rules are included in the receipt. External reachability, restart
    # and host-recreation evidence still require rehearsal.
    rules = {family: command([binary, "--wait", "10", "-S", "LASH-HER-INGRESS"]) for family, binary in [("ipv4", "iptables"), ("ipv6", "ip6tables")]}
    receipt = {"version": 1, "lockSha256": plan["lockSha256"], "forwardingSha256": plan["forwardingSha256"], "packages": versions, "rules": rules,
               "publicInterface": plan["publicInterface"], "externalBoundaryVerified": False, "applicationDeployed": False}
    write_owned(RECEIPT, json.dumps(receipt, indent=2) + "\n", 0o600)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("packages.lock.json"))
    parser.add_argument("--public-interface", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--lock-sha256")
    args = parser.parse_args()
    lock, lock_hash = load_lock(args.lock)
    plan = make_plan(lock, lock_hash, args.public_interface)
    print(json.dumps(apply(plan, args.lock_sha256) if args.apply else plan, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        # Subprocess/network exceptions may embed host configuration. Retain
        # diagnostics locally through normal operator logs, never print values.
        raise SystemExit("Host bootstrap refused or failed; inspect the host locally before retrying") from None
