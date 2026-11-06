"""Offline root-side receiver and systemd checks in a disposable container.

Requires a read-only root filesystem, writable /tmp and /opt/lash-her tmpfs,
network disabled, no credentials, and the public platform source at /source.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def main():
    assert os.geteuid() == 0
    platform = Path("/source/ops/platform")
    source = (platform / "recreation_ssh.mjs").read_text()
    header = json.loads('"' + re.search(r'const header = "(.*?)";', source).group(1) + '"')
    program = header + re.search(r"const sourceInstall = header \+ `([\s\S]*?)`;", source).group(1)
    compile(program, "reviewed-source-receiver", "exec")
    code = b"export const owned = true;\n"
    import base64
    payload = {"commit": "1" * 40, "files": [{"path": "ops/owned.mjs", "sha256": hashlib.sha256(code).hexdigest(),
        "data": base64.b64encode(code).decode()}]}
    environment = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}
    records = []
    def receiver(success=True, marker=None):
        result = subprocess.run(["python3", "-B", "-c", program], input=json.dumps(payload).encode(),
                                capture_output=True, env=environment, timeout=15)
        if success:
            assert result.returncode == 0, "OWNED_PUBLIC_RECEIVER_FAILED"
            return json.loads(result.stdout)
        assert result.returncode != 0 and marker.encode() in result.stderr, "OWNED_SOURCE_REFUSAL_NOT_OBSERVED"
    first = receiver()
    assert first["status"] == "EXACT_OPERATOR_SOURCE_INSTALLED"
    records.append("fresh-public-source-installed")
    target = Path("/opt/lash-her/operators") / payload["commit"] / "ops/owned.mjs"
    before = target.stat().st_mtime_ns
    assert receiver()["existingSourceVerified"] is True and target.stat().st_mtime_ns == before
    records.append("identical-public-source-reused-read-only")
    target.write_bytes(b"owned deliberate corruption")
    receiver(False, "EXISTING_SOURCE_HASH_MISMATCH")
    assert target.read_bytes() == b"owned deliberate corruption"
    records.append("changed-source-refused-without-overwrite")
    target.write_bytes(code)
    extra = target.with_name("unreviewed.mjs"); extra.write_bytes(b"owned extra file")
    receiver(False, "UNREVIEWED_EXISTING_SOURCE_REFUSED"); extra.unlink()
    records.append("unreviewed-source-refused")
    cache = target.parent / "__pycache__"; cache.mkdir(mode=0o755)
    (cache / "owned.cpython-312.pyc").write_bytes(b"owned disposable bytecode fixture")
    assert receiver()["existingSourceVerified"] is True
    records.append("owned-python-cache-permitted")
    alias = target.with_name("alias.mjs"); alias.symlink_to(target)
    receiver(False, "EXISTING_SOURCE_SYMLINK_REFUSED"); alias.unlink()
    records.append("source-symlink-refused")
    target.parent.chmod(0o777)
    receiver(False, "ROOT_OWNED_EXISTING_SOURCE_REQUIRED"); target.parent.chmod(0o755)
    records.append("writable-source-directory-refused")
    # Exercise the real fixed receiver above the former 16 MB source bound.
    # All entries are public synthetic source; validation precedes any writes.
    large = b'x' * 1_500_000
    payload = {"commit": "2" * 40, "files": [{"path": f"ops/owned-{index}.mjs",
        "sha256": hashlib.sha256(large).hexdigest(), "data": base64.b64encode(large).decode()}
        for index in range(12)]}
    assert receiver()["files"] == 12
    assert receiver()["existingSourceVerified"] is True
    records.append("bounded-public-source-above-sixteen-megabytes-installed-and-rechecked")
    payload["commit"] = "3" * 40
    large = b'x' * 2_000_000
    payload["files"] = [{"path": f"ops/owned-{index}.mjs", "sha256": hashlib.sha256(large).hexdigest(),
        "data": base64.b64encode(large).decode()} for index in range(21)]
    receiver(False, "SOURCE_HASH_REFUSED")
    assert not (Path("/opt/lash-her/operators") / payload["commit"]).exists()
    records.append("public-source-over-forty-megabytes-refused-before-installation")
    units = Path("/tmp/recreation-systemd-owned"); units.mkdir(mode=0o700)
    (units / "docker.service").write_text("[Service]\nType=oneshot\nExecStart=/bin/true\n")
    names = ["lash-her-watchdog.service", "lash-her-watchdog.timer", "lash-her-certificates-staging.service", "lash-her-certificates-staging.timer"]
    result = subprocess.run(["systemd-analyze", "verify", *(str(platform / name) for name in names)],
        env={**environment, "SYSTEMD_UNIT_PATH": str(units) + ":/usr/lib/systemd/system:/lib/systemd/system"}, capture_output=True, timeout=30)
    assert result.returncode == 0, "OWNED_SYSTEMD_UNITS_INVALID"
    records.append("four-systemd-units-verified-with-owned-docker-dependency")
    print(json.dumps({"status": "OWNED_RECREATION_CONTROLS_PASS", "checks": records, "passed": len(records),
        "publicReceiverSha256": hashlib.sha256(program.encode()).hexdigest(), "providerContacted": False,
        "actualStagingChanged": False, "ownedDockerDependencyFixture": True}))


if __name__ == "__main__":
    main()
