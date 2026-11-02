#!/usr/bin/env python3
"""Explicit operator migration execution; no source builds or traffic activation."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile

SERVICES = {
    "course": ("lash-her-course-api", "courseMigration", "courseRuntime"),
    "community": ("lash-her-community-api", "communityMigration", "communityRuntime"),
}
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")


def demand(ok, code):
    if not ok:
        raise ValueError(code)


def digest(value):
    return isinstance(value, str) and DIGEST.fullmatch(value) and value != "sha256:" + "0" * 64


def source_commit(value):
    return isinstance(value, str) and COMMIT.fullmatch(value) and value != "0" * 40


def read_input(root, relative, maximum=2_000_000):
    parts = Path(relative).parts
    demand(parts and not Path(relative).is_absolute() and ".." not in parts, "INPUT_PATH_REFUSED")
    file = root
    for part in parts:
        file = file / part
        demand(not file.is_symlink(), "INPUT_SYMLINK_REFUSED")
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        demand(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum, "INPUT_FILE_REFUSED")
        chunks, count = [], 0
        while count <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
        demand(count <= maximum, "INPUT_FILE_REFUSED")
        return b"".join(chunks)
    finally:
        os.close(fd)


def read_json(root, relative):
    return json.loads(read_input(root, relative))


def file_hash(value):
    return hashlib.sha256(value).hexdigest()


def private_directory(directory):
    info = directory.lstat()
    demand(stat.S_ISDIR(info.st_mode) and not directory.is_symlink() and info.st_uid == os.getuid()
           and info.st_mode & 0o077 == 0, "PRIVATE_DIRECTORY_REQUIRED")


def write_json(directory, name, value):
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", closefd=False) as output:
            json.dump(value, output)
            output.write("\n")
            output.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def make_plan(bundle):
    demand(bundle.is_dir() and not bundle.is_symlink(), "BUNDLE_DIRECTORY_REQUIRED")
    release = read_json(bundle, "release.candidate.json")
    environment, release_id = release.get("environment"), release.get("releaseId")
    demand(release.get("version") == 2 and environment in ("staging", "production")
           and isinstance(release_id, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", release_id), "RELEASE_IDENTITY_REFUSED")
    demand(digest(release.get("contractManifestSha256")) and release.get("integration", {}).get("state") == "passed", "QUALIFIED_CANDIDATE_REQUIRED")
    approval = release.get("sourceApproval", {})
    demand(approval.get("mode") == "single-operator-dispatch" and approval.get("operatorGithubUserId") == "8996309", "SOURCE_CI_RECEIPT_REQUIRED")
    for name, repository in (("frontend", "lash-her-frontend"), ("course", "lash-her-course-api"), ("community", "lash-her-community-api")):
        source = release.get("sources", {}).get(name, {})
        demand(source.get("repository") == f"https://github.com/princessdardan/{repository}.git"
               and source_commit(source.get("commit")) and source.get("requiredChecks") == "passed", "EXACT_PASSING_SOURCES_REQUIRED")
    jobs = {}
    for name, (service, migration_key, runtime_key) in SERVICES.items():
        job = read_json(bundle, f"jobs/{name}.json")
        images = {}
        for key, suffix in ((migration_key, "migration"), (runtime_key, "runtime")):
            artifact = release.get("artifacts", {}).get(key, {})
            image = artifact.get("image", "")
            prefix = f"ghcr.io/princessdardan/lash-her-platform-{name}-{suffix}@"
            demand(isinstance(image, str) and image.startswith(prefix) and digest(image[len(prefix):])
                   and artifact.get("scan") == "passed" and digest(artifact.get("sbomSha256"))
                   and digest(artifact.get("provenanceSha256")), "VERIFIED_IMMUTABLE_IMAGES_REQUIRED")
            images[suffix] = image
        target = job.get("target", {})
        demand(job.get("kind") == "operator-migration" and job.get("schemaVersion") == 1 and job.get("operator") == "Dardan"
               and job.get("environment") == environment and job.get("releaseId") == release_id
               and target.get("service") == service and target.get("environment") == environment
               and job.get("sourceCommit") == release["sources"][name]["commit"]
               and job.get("migrationImageDigest") == images["migration"].split("@")[1]
               and job.get("runtimeImageDigest") == images["runtime"].split("@")[1]
               and job.get("contractSha256") == release["contractManifestSha256"].removeprefix("sha256:"), "JOB_CANDIDATE_MISMATCH")
        demand(isinstance(target.get("host"), str) and re.fullmatch(r"[a-z0-9.-]+", target["host"])
               and "-pooler" not in target["host"] and all(isinstance(target.get(key), str)
               and re.fullmatch(r"[A-Za-z0-9_-]+", target[key]) for key in ("database", "user"))
               and isinstance(target.get("approvedPendingTags"), list) and all(isinstance(tag, str)
               and re.fullmatch(r"[0-9]{4}_[a-z0-9_]+", tag) for tag in target["approvedPendingTags"]), "SAFE_TARGET_IDENTITY_REQUIRED")
        schema = read_input(bundle, f"schema/{name}.json")
        demand(file_hash(schema) == job.get("schemaBaselineSha256"), "SCHEMA_BASELINE_HASH_MISMATCH")
        if environment == "production":
            staging = job.get("stagingVerification", {})
            demand(isinstance(staging, dict) and staging.get("receiptRef") == f"staging/{name}", "STAGING_RECEIPT_REQUIRED")
            previous = read_json(bundle, f"staging/{name}/database-receipt.json")
            outcome = read_json(bundle, f"staging/{name}/job-outcome.json")
            demand(previous.get("status") == "DATABASE_VERIFIED" and previous.get("environment") == "staging"
                   and previous.get("service") == service and previous.get("failureCode") is None
                   and outcome.get("status") == "DATABASE_VERIFIED", "PASSING_STAGING_MIGRATION_REQUIRED")
            for key in ("sourceCommit", "migrationImageDigest", "runtimeImageDigest", "contractSha256"):
                demand(previous.get(key) == staging.get(key) == job.get(key), "STAGING_ARTIFACT_MISMATCH")
            demand(previous.get("artifactSha256") == staging.get("artifactSha256") == target.get("artifactSha256"), "STAGING_SQL_ARTIFACT_MISMATCH")
        jobs[name] = {"job": job, "schema": schema, "image": images["migration"]}
    if environment == "production":
        acceptance = read_json(bundle, "staging/acceptance.json")
        demand(acceptance.get("status") == "STAGING_VERIFIED" and acceptance.get("environment") == "staging"
               and acceptance.get("contractManifestSha256") == release["contractManifestSha256"], "STAGING_ACCEPTANCE_REQUIRED")
        for name in ("frontend", "course", "community"):
            demand(acceptance.get("sources", {}).get(name, {}).get("commit") == release["sources"][name]["commit"], "STAGING_SOURCE_MISMATCH")
        for key in ("gateway", "courseMigration", "courseRuntime", "communityMigration", "communityRuntime"):
            demand(acceptance.get("artifacts", {}).get(key, {}).get("image") == release.get("artifacts", {}).get(key, {}).get("image")
                   and isinstance(release.get("artifacts", {}).get(key, {}).get("image"), str), "STAGING_IMAGE_MISMATCH")
        demand(all(acceptance.get("checks", {}).get(name) == "passed" for name in
                   ("application-smoke", "workload-oidc", "worker-recovery", "database-lineage")), "STAGING_APPLICATION_CHECKS_REQUIRED")
        recovery = read_json(bundle, "recovery.json")
        demand(recovery.get("environment") == "production" and recovery.get("operator") == "Dardan", "PRODUCTION_RECOVERY_REVIEW_REQUIRED")
        for name, info in jobs.items():
            item = recovery.get("databases", {}).get(name, {})
            demand(item.get("host") == info["job"]["target"].get("host") and item.get("database") == info["job"]["target"].get("database")
                   and isinstance(item.get("backupRef"), str) and item["backupRef"]
                   and isinstance(item.get("restoreRehearsalRef"), str) and item["restoreRehearsalRef"], "PRODUCTION_RECOVERY_TARGET_MISMATCH")
    return release, jobs


def docker_arguments(image, input_directory, receipt_directory, environment, release_id, user, name, checking=False):
    args = ["docker", "run", "--rm", "--name", name, "--network", "none" if checking else "bridge",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", user,
            "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128", "--tmpfs", "/tmp:size=32m,mode=1777",
            "--mount", f"type=bind,src={input_directory},dst=/run/release-input,readonly"]
    args += ["--entrypoint", "node", image, "dist-migration/scripts/run-operator-migration.js"] if checking else [
        "--mount", f"type=bind,src={receipt_directory},dst=/run/release-receipts",
        "--env", "DATABASE_TARGET", "--env", "STAGING_DATABASE_URL" if environment == "staging" else "PROD_DATABASE_URL",
        "--entrypoint", "node", image, "dist-migration/scripts/run-operator-migration.js"]
    args += ["--check" if checking else "--execute", "/run/release-input/job.json", "/run/release-input/schema.json"]
    if not checking:
        args += ["--confirm", f"{environment}/{release_id}", "/run/release-receipts"]
    return args


def suspend_runtime(environment, env):
    project = f"lash-her-{environment}"
    inventory = subprocess.run(["docker", "ps", "--filter", f"label=com.docker.compose.project={project}",
                                "--format", '{{.ID}} {{.Label "com.docker.compose.service"}}'],
                               check=True, capture_output=True, text=True, env=env, timeout=30)
    allowed = {"gateway", "course-api", "course-tls", "course-publisher", "course-snapshot", "community-api", "community-tls", "community-worker"}
    ids = []
    lines = inventory.stdout.splitlines()
    demand(len(lines) <= 32, "RUNTIME_INVENTORY_REFUSED")
    for line in lines:
        parts = line.split()
        demand(len(parts) == 2 and re.fullmatch(r"[a-f0-9]{12,64}", parts[0]) and parts[1] in allowed, "RUNTIME_INVENTORY_REFUSED")
        ids.append(parts[0])
    if ids:
        subprocess.run(["docker", "stop", "--time", "30", *ids], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, timeout=60)
    remaining = subprocess.run(["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"],
                               check=True, capture_output=True, text=True, env=env, timeout=30)
    demand(not remaining.stdout.strip(), "WRITERS_NOT_SUSPENDED")
    return ids


def execute(bundle, results, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock")):
    release, jobs = make_plan(bundle)
    environment, release_id = release["environment"], release["releaseId"]
    plan = {"releaseId": release_id, "environment": environment, "operator": "Dardan", "operation": "migrations-only",
            "targets": {name: {"host": info["job"]["target"].get("host"), "database": info["job"]["target"].get("database"),
                               "pendingTags": info["job"]["target"].get("approvedPendingTags"), "image": info["image"]} for name, info in jobs.items()},
            "trafficAuthorized": False, "credentialsRead": False, "maintenanceRequired": True}
    if not apply:
        return plan
    demand(confirmation == f"{environment}/{release_id}", "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
    private_directory(results)
    for directory in (results.resolve(), bundle.resolve()):
        demand(not any((parent / ".git").exists() for parent in (directory, *directory.parents)), "RELEASE_ARTIFACTS_OUTSIDE_CHECKOUT_REQUIRED")
    demand("," not in str(results.resolve()) and "," not in str(bundle.resolve()), "MOUNT_PATH_REFUSED")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        demand(stat.S_ISREG(os.fstat(lock_fd).st_mode) and os.fstat(lock_fd).st_uid == os.getuid(), "RELEASE_LOCK_REFUSED")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempt = results / release_id
        attempt.mkdir(mode=0o700)  # Existing/uncertain attempts never overwrite or retry.
        write_json(attempt, "started.json", plan)
        write_json(attempt, "candidate.json", release)
        outcome = {"status": "FAILED_REQUIRES_REVIEW", "releaseId": release_id, "environment": environment, "trafficAuthorized": False}
        base_env = {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG") if key in os.environ}
        uid, gid = (65532, 65532) if os.getuid() == 0 else (os.getuid(), os.getgid())
        prepared = []
        try:
            for name, info in jobs.items():
                outcome["phase"] = f"image-preflight-{name}"
                inputs, receipts = attempt / f"{name}-input", attempt / name
                inputs.mkdir(mode=0o700); receipts.mkdir(mode=0o700)
                write_json(inputs, "job.json", info["job"])
                (inputs / "schema.json").write_bytes(info["schema"])
                for file in inputs.iterdir():
                    file.chmod(0o400)
                    if os.getuid() == 0:
                        os.chown(file, uid, gid)
                if os.getuid() == 0:
                    os.chown(inputs, uid, gid); os.chown(receipts, uid, gid)
                prepared.append((name, info, inputs, receipts))
                subprocess.run(["docker", "pull", info["image"]], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=180)
                args = docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), environment, release_id, f"{uid}:{gid}", f"lash-check-{name}-{release_id}", True)
                subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=30)
            # Validate every job in its exact migration image before database credentials are read.
            outcome["phase"] = "credential-validation"
            key = "STAGING_DATABASE_URL" if environment == "staging" else "PROD_DATABASE_URL"
            credentials = {name: os.environ.get(f"{name.upper()}_{key}") for name in jobs}
            demand(all(credentials.values()), "NAMED_MIGRATION_CREDENTIAL_REQUIRED")
            outcome["phase"] = "suspend-runtime"
            outcome["stoppedRuntimeContainers"] = suspend_runtime(environment, base_env)
            outcome["runtimeResumed"] = False
            for name, info, inputs, receipts in prepared:
                outcome["phase"] = f"apply-{name}"
                env = {**base_env, "DATABASE_TARGET": environment, key: credentials[name]}
                container_name = f"lash-migrate-{name}-{release_id}"
                args = docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), environment, release_id, f"{uid}:{gid}", container_name)
                log_fd = os.open(receipts / "container.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    subprocess.run(args, check=True, stdout=log_fd, stderr=log_fd, env=env, timeout=1260)
                finally:
                    os.close(log_fd)
                    # Also cleans up a container left running by a timed-out/interrupted Docker CLI.
                    subprocess.run(["docker", "rm", "--force", container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=30)
                    inventory = subprocess.run(["docker", "container", "ls", "--all", "--filter", f"name=^/{container_name}$", "--format", "{{.ID}}"],
                                               check=True, capture_output=True, text=True, env=base_env, timeout=30)
                    demand(not inventory.stdout.strip(), "MIGRATION_CONTAINER_CLEANUP_UNVERIFIED")
                receipt = read_json(receipts, "database-receipt.json")
                terminal = read_json(receipts, "job-outcome.json")
                demand(receipt.get("status") == "DATABASE_VERIFIED" and terminal.get("status") == "DATABASE_VERIFIED"
                       and receipt.get("environment") == environment and receipt.get("releaseId") == release_id
                       and receipt.get("service") == SERVICES[name][0] and receipt.get("failureCode") is None, "MIGRATION_OUTCOME_REFUSED")
                for field in ("sourceCommit", "migrationImageDigest", "runtimeImageDigest", "contractSha256", "schemaBaselineSha256"):
                    demand(receipt.get(field) == info["job"].get(field), "MIGRATION_RECEIPT_BINDING_REFUSED")
            outcome["status"] = "DATABASES_VERIFIED"
            outcome["phase"] = "completed"
            outcome["candidateSha256"] = file_hash(read_input(attempt, "candidate.json"))
            outcome["databaseReceiptSha256"] = {name: file_hash(read_input(receipts, "database-receipt.json")) for name, _info, _inputs, receipts in prepared}
            return outcome
        except BaseException as error:
            outcome["status"] = "FAILED_REQUIRES_REVIEW"
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "EXECUTION_OR_INPUT_FAILURE"
            raise
        finally:
            write_json(attempt, "migration-outcome.json", outcome)
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(signum, _frame):
        raise SystemExit(130 if signum == signal.SIGINT else 143)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    lock = Path(tempfile.gettempdir()) / f"lash-her-release-{os.getuid()}.lock" if sys.platform == "darwin" else Path("/run/lock/lash-her-release.lock")
    try:
        print(json.dumps(execute(args.bundle, args.results, args.apply, args.confirm, lock)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print(json.dumps({"status": "MIGRATION_RELEASE_REFUSED", "reviewRequired": True, "trafficAuthorized": False}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
