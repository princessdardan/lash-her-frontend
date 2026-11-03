"""Fresh-host bootstrap and pinned image preparation for reviewed staging recovery.

No application process, SQL or provider mutation is available here. Registry
authentication is confined to a temporary private Docker configuration and stdin.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

import bootstrap
import migrate
import native_qualification
import recreation_files
import release as runtime
import runtime_actions
import staging_rollback
import staging_restore
import staging_state

demand = migrate.demand
ORIGINAL_MACHINE = "ec265c34b9fbf4d051aecfa185362c0a"
MARKER = b"Host preparation complete; application release and Docker forwarding controls are still required.\n"
SSH_POLICY = b"PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n"
CURRENT_IMAGE_KEYS = {"gateway", "courseRuntime", "communityRuntime", "frontendMigration", "courseMigration", "communityMigration"}


def initialization(command=runtime.command, read_file=staging_restore.host_file):
    command(["cloud-init", "status", "--wait"], runtime.SAFE_ENV, 600)
    demand(read_file("/opt/lash-her/host-prepared") == MARKER
           and read_file("/etc/ssh/sshd_config.d/00-lash-her.conf") == SSH_POLICY, "RECREATION_EXACT_INITIALIZATION_REQUIRED")
    ssh = dict(line.split(" ", 1) for line in command(["/usr/sbin/sshd", "-T"], runtime.SAFE_ENV).splitlines() if " " in line)
    demand(all(ssh.get(key) == "no" for key in ("passwordauthentication", "kbdinteractiveauthentication", "permitrootlogin")),
           "RECREATION_EFFECTIVE_SSH_POLICY_REQUIRED")
    firewall = command(["ufw", "status", "numbered"], runtime.SAFE_ENV)
    rules = [re.sub(r"\s+", " ", match.group(1)).strip() for line in firewall.splitlines()
             if (match := re.fullmatch(r"\[\s*\d+\]\s+(.+)", line.strip()))]
    demand(firewall.startswith("Status: active\n") and len(rules) == 2
           and set(rules) == {"22/tcp ALLOW IN 99.239.200.211", "443/tcp ALLOW IN Anywhere"}, "RECREATION_EXACT_HOST_FIREWALL_REQUIRED")
    return {"status": "RECREATION_INITIALIZATION_VERIFIED", "passwordAuthentication": False,
            "rootLogin": False, "sshIpv4Source": "99.239.200.211/32", "ipv6IngressAllowed": False}


def bootstrap_fresh(machine, output, reviewed_lock_sha256):
    demand(machine != ORIGINAL_MACHINE, "RECREATION_BOOTSTRAP_REQUIRES_NEW_MACHINE")
    runtime.assert_host({"hostMachineId": machine})
    result = initialization()
    lock, actual_sha = bootstrap.load_lock(Path(__file__).with_name("packages.lock.json"))
    demand(actual_sha == reviewed_lock_sha256, "RECREATION_REVIEWED_PACKAGE_LOCK_REQUIRED")
    routes = json.loads(runtime.command(["ip", "-json", "route", "show", "default"], runtime.SAFE_ENV))
    demand(isinstance(routes, list) and routes and isinstance(routes[0].get("dev"), str), "RECREATION_PUBLIC_INTERFACE_REQUIRED")
    plan = bootstrap.make_plan(lock, actual_sha, routes[0]["dev"])
    migrate.write_json(output, "bootstrap-started.json", {"hostMachineId": machine, "lockSha256": actual_sha, "initialization": result})
    receipt = bootstrap.apply(plan, actual_sha)
    demand(receipt.get("lockSha256") == actual_sha and receipt.get("applicationDeployed") is False, "RECREATION_ACTUAL_BOOTSTRAP_RECEIPT_REQUIRED")
    return {"status": "RECREATION_FRESH_BOOTSTRAP_COMPLETE", "hostMachineId": machine, "lockSha256": actual_sha,
            "forwardingSha256": receipt["forwardingSha256"], "applicationStarted": False, "migrationsExecuted": False}


def image_references(bundle, configuration, compose, candidate_sha256, database_receipts, runtime_receipts,
                     compatibility_directory=None, previous_sha256=None, proof_sha256=None):
    selected, _jobs, _plan, _compose = staging_state.retained_state(bundle, configuration, database_receipts,
        runtime_receipts, compose, candidate_sha256)
    refs = {key: value["image"] for key, value in selected["artifacts"].items()}
    demand(set(refs) == CURRENT_IMAGE_KEYS,
           "RECREATION_SIX_CURRENT_IMAGES_REQUIRED")
    if compatibility_directory is not None:
        previous, _execution = staging_rollback.compatibility(compatibility_directory, previous_sha256, proof_sha256, selected)
        refs.update({"previous-" + key: previous["images"][key] for key in staging_rollback.RUNTIME_KEYS})
    demand(all(re.fullmatch(r"ghcr\.io/princessdardan/lash-her-platform-[a-z-]+@sha256:[a-f0-9]{64}", image)
               for image in refs.values()) and len(set(refs.values())) == len(refs), "RECREATION_EXACT_PUBLISHED_IMAGE_REFERENCES_REQUIRED")
    return refs


def _run(args, environment, payload=None, timeout=60):
    return subprocess.run(args, env=environment, input=payload, capture_output=True, timeout=timeout)


def inspect_image(reference, environment):
    template = '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}'
    value = _run(["docker", "image", "inspect", "--format", template, reference], environment)
    if value.returncode != 0:
        # Refuse daemon errors as missing images rather than authenticating or
        # pulling on an ambiguous engine state. Docker's exact not-found marker
        # contains only the already reviewed reference; arbitrary output is not
        # returned to the parent or retained in common evidence.
        demand(value.returncode == 1 and value.stderr.decode(errors="replace").strip()
               == "Error response from daemon: No such image: " + reference, "RECREATION_IMAGE_INSPECTION_REQUIRES_REVIEW")
        return None
    demand(len(value.stdout) <= 65_536, "RECREATION_IMAGE_INSPECTION_BOUND_REQUIRED")
    image = json.loads(value.stdout)
    demand(image.get("os") == "linux" and image.get("architecture") == "amd64"
           and re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("id", ""))
           and reference in (image.get("repoDigests") or []), "RECREATION_CACHED_IMAGE_IDENTITY_REQUIRED")
    return {"reference": reference, "imageId": image["id"], "os": "linux", "architecture": "amd64"}


def cache_images(references, output, username=None, token=None):
    demand(isinstance(references, dict) and set(references) in (CURRENT_IMAGE_KEYS,
           CURRENT_IMAGE_KEYS | {"previous-" + key for key in staging_rollback.RUNTIME_KEYS})
           and len(set(references.values())) == len(references)
           and all(isinstance(ref, str) and re.fullmatch(r"ghcr\.io/princessdardan/lash-her-platform-[a-z-]+@sha256:[a-f0-9]{64}", ref)
                   for ref in references.values()), "RECREATION_FIXED_IMAGE_SET_REQUIRED")
    environment = dict(runtime.SAFE_ENV)
    info = _run(["docker", "info", "--format", "{{.OSType}}|{{.Architecture}}"], environment)
    demand(info.returncode == 0 and info.stdout.strip() in (b"linux|x86_64", b"linux|amd64"), "RECREATION_LINUX_AMD64_ENGINE_REQUIRED")
    known = {name: inspect_image(reference, environment) for name, reference in references.items()}
    missing = [name for name in references if known[name] is None]
    intent = {"images": references, "missing": missing, "registryAuthenticationNeeded": bool(missing), "applicationStarted": False}
    migrate.write_json(output, "image-cache-started.json", intent)
    outcome = {**intent, "status": "RECREATION_IMAGE_CACHE_REQUIRES_REVIEW", "registryConfigurationRemoved": False}
    try:
        if missing:
            demand(username == "princessdardan" and isinstance(token, str) and 0 < len(token) <= 16_384
                   and all(32 < ord(c) < 127 for c in token), "RECREATION_PRIVATE_GHCR_READ_BINDINGS_REQUIRED")
            with tempfile.TemporaryDirectory(prefix="lash-ghcr-read-", dir=output) as directory:
                os.chmod(directory, 0o700)
                private_env = {**environment, "DOCKER_CONFIG": directory}
                login = _run(["docker", "login", "ghcr.io", "--username", username, "--password-stdin"], private_env, token.encode())
                demand(login.returncode == 0, "RECREATION_REGISTRY_LOGIN_REQUIRES_REVIEW")
                for name in missing:
                    pulled = _run(["docker", "pull", "--platform", "linux/amd64", references[name]], private_env, timeout=300)
                    demand(pulled.returncode == 0, "RECREATION_EXACT_IMAGE_PULL_REQUIRES_REVIEW")
                    known[name] = inspect_image(references[name], private_env)
                    demand(known[name] is not None, "RECREATION_PULLED_IMAGE_IDENTITY_REQUIRED")
            outcome["registryConfigurationRemoved"] = not any(output.glob("lash-ghcr-read-*"))
        else:
            outcome["registryConfigurationRemoved"] = True
        demand(outcome["registryConfigurationRemoved"], "RECREATION_REGISTRY_CONFIGURATION_REMAINS")
        # Observe again without the temporary auth directory or ambient token.
        actual = {name: inspect_image(reference, environment) for name, reference in references.items()}
        demand(actual == known and all(actual.values()), "RECREATION_FINAL_IMAGE_CACHE_MISMATCH")
        outcome.update(status="RECREATION_EXACT_IMAGES_CACHED", actualImages=actual)
        return outcome
    except BaseException as error:
        outcome["failureCode"] = runtime_actions.safe_code(error)
        outcome["registryConfigurationRemoved"] = not any(output.glob("lash-ghcr-read-*"))
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "image-cache-outcome.json", outcome)


def execute(value, lock_path=Path("/run/lock/lash-her-release.lock")):
    demand(isinstance(value, dict) and value.get("version") == 1 and value.get("environment") == "staging"
           and value.get("operation") in ("bootstrap", "cache-current", "cache-compatible"), "RECREATION_PREPARATION_FIXED_STAGING_OPERATION_REQUIRED")
    action = value.get("action")
    root = recreation_files.action_root(action)
    machine = value.get("expectedMachineId")
    demand(isinstance(machine, str) and re.fullmatch(r"[a-f0-9]{32}", machine) and machine != "0" * 32,
           "RECREATION_PREPARATION_EXACT_MACHINE_REQUIRED")
    demand(value.get("confirmation") == "staging/" + action + "/" + value["operation"], "EXPLICIT_RECREATION_PREPARATION_CONFIRMATION_REQUIRED")
    demand(machine != ORIGINAL_MACHINE if value["operation"] in ("bootstrap", "cache-current") else machine == ORIGINAL_MACHINE,
           "RECREATION_PREPARATION_PHASE_MACHINE_MISMATCH")
    demand(os.geteuid() == 0 and sys.platform == "linux", "RECREATION_PREPARATION_ROOT_LINUX_REQUIRED")
    runtime.assert_host({"hostMachineId": machine})
    staging_state.outside_checkout(root)
    output = root / ("prepare-" + value["operation"])
    demand(not output.exists(), "RECREATION_PREPARATION_EXCLUSIVE_OUTPUT_REQUIRED")
    with lock_path.open("a+") as lock:
        native_qualification.acquire_release_lock(lock)
        output.mkdir(mode=0o700)
        outcome = {"status": "RECREATION_PREPARATION_REQUIRES_REVIEW", "operation": value["operation"],
                   "hostMachineId": machine, "applicationStarted": False, "migrationsExecuted": False}
        try:
            if value["operation"] == "bootstrap":
                result = bootstrap_fresh(machine, output, value["packageLockSha256"])
            else:
                paths = root / "inputs"
                compatibility = value["operation"] == "cache-compatible"
                refs = image_references(paths / "bundle", paths / "configuration", paths / "compose.yaml", value["candidate_sha256"],
                    paths / "database-receipts", paths / "runtime-receipts", paths / "compatibility" if compatibility else None,
                    value.get("previous_sha256"), value.get("proof_sha256"))
                result = cache_images(refs, output, value.get("registryUsername"), value.get("registryReadToken"))
            outcome.update(result)
            return result
        except BaseException as error:
            outcome["failureCode"] = runtime_actions.safe_code(error)
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(output, "preparation-outcome.json", outcome)


def main():
    def interrupted(_signum, _frame):
        raise SystemExit(130)
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        raw = sys.stdin.buffer.read(100_001)
        demand(len(raw) <= 100_000, "RECREATION_PREPARATION_INPUT_BOUND_REQUIRED")
        result = execute(json.loads(raw))
        print(json.dumps({"status": result["status"], "applicationStarted": False, "migrationsExecuted": False,
                          "credentialValuesDisplayed": False}))
    except BaseException as error:
        print(json.dumps({"status": "RECREATION_PREPARATION_REQUIRES_REVIEW", "failureCode": runtime_actions.safe_code(error)}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
