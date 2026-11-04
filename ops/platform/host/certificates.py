#!/usr/bin/env python3
"""Renew staging TLS under the release lock, retaining the previous key pairs."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import stat
import subprocess
import tempfile
import time
import uuid

import migrate
import release as runtime

HOST = "api-staging.lashher.com"
PROJECT = "lash-her-staging"
SERVICES = {"gateway": HOST, "course-tls": "course-tls", "community-tls": "community-tls"}
DATA = Path("/var/lib/lash-her")
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "DOCKER_CONTEXT": "default"}
demand = migrate.demand


def command(args, timeout=15):
    # Provider output and key material never enter a receipt or exception string.
    result = subprocess.run(args, env=SAFE_ENV, capture_output=True, timeout=timeout)
    demand(result.returncode == 0 and len(result.stdout) <= 1_000_000, "CERTIFICATE_COMMAND_FAILED")
    return result.stdout


def plan(configuration):
    demand(configuration.get("version") == 1 and configuration.get("environment") == "staging"
           and configuration.get("publicHost") == HOST
           and re.fullmatch(r"[a-f0-9]{32}", configuration.get("hostMachineId", ""))
           and configuration.get("releaseRoot") == str(DATA / "releases/staging")
           and configuration.get("acmeState") == str(DATA / "acme-staging")
           and configuration.get("privateCaState") == str(DATA / "private-tls-staging")
           and isinstance(configuration.get("accountEmail"), str)
           and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", configuration["accountEmail"]), "CERTIFICATE_TARGET_REFUSED")
    return {"operation": "staging-certificate-renewal", "hostMachineId": configuration["hostMachineId"],
            "publicHost": HOST, "services": list(SERVICES), "renewWithinDays": 30,
            "privateLeafLifetimeDays": 90, "credentialsRead": False, "applicationRelease": False}


def private_file(path, owners, root=None):
    demand(path.is_absolute() and path.is_relative_to(root or DATA), "CERTIFICATE_PATH_REFUSED")
    for part in [path, *path.parents]:
        demand(not part.is_symlink(), "CERTIFICATE_SYMLINK_REFUSED")
    info = path.lstat()
    demand(stat.S_ISREG(info.st_mode) and info.st_uid in owners and info.st_mode & 0o077 == 0
           and 0 < info.st_size <= 65_536, "PRIVATE_CERTIFICATE_FILE_REQUIRED")


def expiry(certificate):
    raw = command(["openssl", "x509", "-in", str(certificate), "-noout", "-enddate"]).decode("ascii").strip()
    demand(raw.startswith("notAfter="), "CERTIFICATE_DATE_REFUSED")
    return datetime.datetime.strptime(raw[9:], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc).timestamp()


def verify_pair(certificate, key, hostname, authority=None, existing=False):
    cert_public = command(["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"])
    key_public = command(["openssl", "pkey", "-in", str(key), "-pubout"])
    demand(cert_public == key_public, "CERTIFICATE_KEY_MISMATCH")
    args = ["openssl", "verify", "-purpose", "sslserver", "-verify_hostname", hostname,
            *( ["-no_check_time"] if existing else [] ),
            *( ["-CAfile", str(authority)] if authority else ["-CApath", "/etc/ssl/certs"] ),
            "-untrusted", str(certificate), str(certificate)]
    command(args)


def inventory(configuration):
    selected = {}
    for service in SERVICES:
        ids = command(["docker", "ps", "--all", "--quiet", "--filter", f"label=com.docker.compose.project={PROJECT}",
                       "--filter", f"label=com.docker.compose.service={service}"]).decode().split()
        demand(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{12,64}", ids[0]), "EXACT_TLS_RUNTIME_REQUIRED")
        items = json.loads(command(["docker", "inspect", ids[0]]))
        demand(isinstance(items, list) and len(items) == 1, "TLS_CONTAINER_IDENTITY_REFUSED")
        item = items[0]
        labels = item.get("Config", {}).get("Labels", {})
        demand(item.get("Id", "").startswith(ids[0]) and item.get("State", {}).get("Running") is True
               and labels.get("com.docker.compose.project") == PROJECT and labels.get("com.docker.compose.service") == service
               and re.fullmatch(r"ghcr.io/princessdardan/lash-her-platform-gateway@sha256:[a-f0-9]{64}", item["Config"].get("Image", "")),
               "TLS_CONTAINER_IDENTITY_REFUSED")
        ports = item.get("HostConfig", {}).get("PortBindings") or {}
        demand(ports == ({"8443/tcp": [{"HostIp": "0.0.0.0", "HostPort": "443"}]} if service == "gateway" else {}),
               "TLS_PUBLISHED_PORTS_REFUSED")
        mounts = [mount for mount in item.get("Mounts", []) if mount.get("Destination") == "/tls"]
        demand(len(mounts) == 1 and mounts[0].get("Type") == "bind" and mounts[0].get("RW") is False,
               "READ_ONLY_TLS_BIND_REQUIRED")
        directory = Path(mounts[0].get("Source", ""))
        leaf = "gateway" if service == "gateway" else service.split("-")[0]
        demand(directory.is_absolute() and directory.is_relative_to(Path(configuration["releaseRoot"]))
               and directory.parts[-2:] == ("tls", leaf), "ACTIVE_TLS_DIRECTORY_REFUSED")
        for name in ("cert.pem", "key.pem"):
            private_file(directory / name, {0, 65532})
        selected[service] = {"id": ids[0], "directory": directory}
    demand(len({item["directory"].parent for item in selected.values()}) == 1, "SHARED_ACTIVE_TLS_RELEASE_REQUIRED")
    return selected


def replace_file(path, value):
    info = path.stat()
    fd, temporary = tempfile.mkstemp(prefix=".tls-", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            stream.write(value); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def save_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(value); stream.flush(); os.fsync(stream.fileno())


def verify_served(service, certificate, authority):
    address, port = ("127.0.0.1", 443) if service == "gateway" else (
        "172.29.10.20" if service == "course-tls" else "172.29.10.40", 8443)
    context = ssl.create_default_context(cafile=None if service == "gateway" else str(authority))
    pem = certificate.read_text()
    leaf = pem[:pem.index("-----END CERTIFICATE-----") + len("-----END CERTIFICATE-----")]
    expected = ssl.PEM_cert_to_DER_cert(leaf)
    deadline = time.monotonic() + 30
    while True:
        try:
            with socket.create_connection((address, port), timeout=2) as connection:
                with context.wrap_socket(connection, server_hostname=SERVICES[service]) as secure:
                    demand(secure.getpeercert(binary_form=True) == expected, "SERVED_CERTIFICATE_MISMATCH")
            return
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise ValueError("SERVED_CERTIFICATE_UNVERIFIED") from None
            time.sleep(0.5)


def running(identity):
    return command(["docker", "inspect", "--format", "{{.State.Running}}", identity]).strip() == b"true"


def execute(configuration, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock")):
    result = plan(configuration)
    if not apply:
        return result
    demand(confirmation == "staging/certificate-renewal", "EXPLICIT_CERTIFICATE_ACTION_REQUIRED")
    runtime.assert_host(result)
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"status": "TLS_RENEWAL_SKIPPED_RELEASE_BUSY", "credentialsRead": False}
        state = DATA / "certificate-renewals-staging"
        state.mkdir(mode=0o700, exist_ok=True); migrate.private_directory(state)
        marker = state / "in-progress.json"
        demand(not marker.exists(), "PREVIOUS_CERTIFICATE_ATTEMPT_REQUIRES_REVIEW")
        selected = inventory(configuration)
        ca = Path(configuration["privateCaState"]) / "ca.pem"
        private_file(ca, {0})
        # Peers and clients retain the same CA through ordinary leaf renewal.
        for active_ca in (selected["gateway"]["directory"] / "ca.pem", selected["gateway"]["directory"].parent / "ca.pem"):
            private_file(active_ca, {0, 65532})
            demand(active_ca.read_bytes() == ca.read_bytes(), "ACTIVE_PRIVATE_CA_MISMATCH")
        now = time.time()
        demand(expiry(ca) > now + 30 * 86400, "PRIVATE_CA_ROTATION_REQUIRED")
        due = []
        for service, hostname in SERVICES.items():
            directory = selected[service]["directory"]
            verify_pair(directory / "cert.pem", directory / "key.pem", hostname, None if service == "gateway" else ca, existing=True)
            if expiry(directory / "cert.pem") <= now + 30 * 86400:
                due.append(service)
        if not due:
            return {"status": "TLS_CERTIFICATES_CURRENT", "renewed": [], "servicesStopped": False}
        if "gateway" in due:
            migrate.private_directory(Path(configuration["acmeState"]))
            version = command(["dpkg-query", "-W", "-f=${Version}", "lego"]).decode().strip()
            demand(re.fullmatch(r"4\.9\.1-2ubuntu0\.24\.04\.\d+", version), "REVIEWED_ACME_CLIENT_REQUIRED")
        attempt = state / str(uuid.uuid4()); attempt.mkdir(mode=0o700)
        outcome = {"status": "FAILED_REQUIRES_REVIEW", "publicHost": HOST, "selectedServices": due,
                   "renewed": [], "phase": "prepare", "previousPairsRestored": False, "runtimeRecovered": False}
        for service in due:
            destination = attempt / service; destination.mkdir(mode=0o700)
            directory = selected[service]["directory"]
            for name in ("cert.pem", "key.pem"):
                save_private(destination / ("previous-" + name), (directory / name).read_bytes())
        stopped, changed = [], []
        migrate.write_json(state, "in-progress.json", {"attempt": attempt.name})
        try:
            private_due = [name for name in due if name != "gateway"]
            if private_due:
                ca_key = ca.with_name("ca.key"); private_file(ca_key, {0})
                demand(expiry(ca) > now + 91 * 86400, "PRIVATE_CA_ROTATION_REQUIRED")
                for service in private_due:
                    stage = attempt / service
                    command(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", str(stage / "key.pem"),
                             "-out", str(stage / "request.pem"), "-subj", "/CN=" + service])
                    save_private(stage / "extensions", f"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:{service}\n".encode())
                    command(["openssl", "x509", "-req", "-in", str(stage / "request.pem"), "-CA", str(ca), "-CAkey", str(ca_key),
                             "-set_serial", str(secrets.randbits(159) or 1), "-days", "90", "-sha256", "-extfile", str(stage / "extensions"),
                             "-out", str(stage / "cert.pem")])
                    verify_pair(stage / "cert.pem", stage / "key.pem", service, ca)
            outcome["phase"] = "stop-selected-tls"
            for service in due:
                # Record intent first: a timed-out stop may still take effect.
                stopped.append(service)
                command(["docker", "stop", "--timeout", "30", selected[service]["id"]], 40)
                demand(not running(selected[service]["id"]), "TLS_STOP_UNVERIFIED")
            if "gateway" in due:
                outcome["phase"] = "acme-renewal"
                command(["/usr/bin/lego", "--path", configuration["acmeState"], "--server", "https://acme-v02.api.letsencrypt.org/directory",
                         "--email", configuration["accountEmail"], "--domains", HOST, "--tls", "--tls.port", "443",
                         "renew", "--days", "30", "--no-random-sleep"], 180)
                source = Path(configuration["acmeState"]) / "certificates"
                for name, suffix in (("cert.pem", "crt"), ("key.pem", "key")):
                    file = source / (HOST + "." + suffix); private_file(file, {0})
                    save_private(attempt / "gateway" / name, file.read_bytes())
            outcome["phase"] = "verify-and-install"
            for service in due:
                stage = attempt / service
                verify_pair(stage / "cert.pem", stage / "key.pem", SERVICES[service], None if service == "gateway" else ca)
                demand(expiry(stage / "cert.pem") > time.time() + 30 * 86400, "RENEWED_CERTIFICATE_LIFETIME_REFUSED")
                changed.append(service)
                for name in ("cert.pem", "key.pem"):
                    replace_file(selected[service]["directory"] / name, (stage / name).read_bytes())
            outcome["phase"] = "restart-selected-tls"
            for service in stopped:
                command(["docker", "start", selected[service]["id"]], 40)
                demand(running(selected[service]["id"]), "TLS_RESTART_UNVERIFIED")
                verify_served(service, selected[service]["directory"] / "cert.pem", ca)
            outcome.update(status="TLS_CERTIFICATES_RENEWED", renewed=due, phase="completed", runtimeRecovered=True)
            marker.unlink()
            return outcome
        except BaseException:
            outcome["phase"] = "recovery-required"
            recovered = True
            for service in reversed(stopped):
                try:
                    if service in changed:
                        # Stop again if a later restart failed after an earlier
                        # service started. Never replace an active pair in place.
                        command(["docker", "stop", "--timeout", "30", selected[service]["id"]], 40)
                        demand(not running(selected[service]["id"]), "TLS_STOP_UNVERIFIED")
                        for name in ("cert.pem", "key.pem"):
                            replace_file(selected[service]["directory"] / name, (attempt / service / ("previous-" + name)).read_bytes())
                    if not running(selected[service]["id"]):
                        command(["docker", "start", selected[service]["id"]], 40)
                    demand(running(selected[service]["id"]), "TLS_RECOVERY_UNVERIFIED")
                    verify_served(service, selected[service]["directory"] / "cert.pem", ca)
                except BaseException:
                    recovered = False
            outcome.update(previousPairsRestored=recovered, runtimeRecovered=recovered)
            raise ValueError("CERTIFICATE_RENEWAL_REQUIRES_REVIEW") from None
        finally:
            migrate.write_json(attempt, "outcome.json", outcome)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(_signum, _frame):
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    if args.apply:
        demand(args.configuration == Path("/etc/lash-her/certificates-staging.json"), "PROTECTED_CERTIFICATE_CONFIGURATION_REQUIRED")
        private_file(args.configuration, {0}, Path("/etc/lash-her"))
    configuration = migrate.read_json(args.configuration.parent, args.configuration.name)
    print(json.dumps(execute(configuration, args.apply, args.confirm)))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        raise SystemExit("Certificate maintenance refused or failed; inspect the private host outcome") from None
