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


def contract_identity(value):
    """Additive P2 identity; absence preserves the original P1 contract schema."""
    demand(isinstance(value, dict), "CONTRACT_IDENTITY_REFUSED")
    keys = ("contractPhase", "phase2ContractManifestSha256")
    if not any(key in value for key in keys):
        return {}
    demand(all(key in value for key in keys) and value["contractPhase"] == "p2" and
           digest(value["phase2ContractManifestSha256"]), "P2_CONTRACT_IDENTITY_REQUIRED")
    return {key: value[key] for key in keys}


def require_contract_identity(expected, *actual, code="P2_CONTRACT_BINDING_MISMATCH"):
    selected = contract_identity(expected)
    demand(all(contract_identity(value) == selected for value in actual), code)
    return selected


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
    # Publish only complete, fsynced bytes and retain exclusive/no-overwrite
    # semantics. A failed directory sync must not leave our success file visible.
    fd, temporary = tempfile.mkstemp(prefix=f".{name}.", dir=directory)
    temporary = Path(temporary)
    linked = False
    try:
        with os.fdopen(fd, "w", closefd=False) as output:
            json.dump(value, output)
            output.write("\n")
            output.flush()
            os.fsync(fd)
        os.link(temporary, directory / name, follow_symlinks=False)
        linked = True
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        if linked:
            # Only remove this invocation's inode, never a pre-existing record.
            try:
                if (directory / name).lstat().st_ino == os.fstat(fd).st_ino:
                    (directory / name).unlink()
            except OSError:
                pass
        raise
    finally:
        os.close(fd)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass  # A private temporary-file cleanup failure cannot revoke durable output.


def make_plan(bundle):
    demand(bundle.is_dir() and not bundle.is_symlink(), "BUNDLE_DIRECTORY_REQUIRED")
    release = read_json(bundle, "release.candidate.json")
    environment, release_id = release.get("environment"), release.get("releaseId")
    demand(release.get("version") == 2 and environment in ("staging", "production")
           and isinstance(release_id, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", release_id), "RELEASE_IDENTITY_REFUSED")
    demand(digest(release.get("contractManifestSha256")) and release.get("integration", {}).get("state") == "passed", "QUALIFIED_CANDIDATE_REQUIRED")
    contract_identity(release)
    approval = release.get("sourceApproval", {})
    demand(approval.get("mode") == "single-operator-dispatch" and approval.get("operatorGithubUserId") == "8996309", "SOURCE_CI_RECEIPT_REQUIRED")
    for name, repository in (("frontend", "lash-her-frontend"), ("course", "lash-her-course-api"), ("community", "lash-her-community-api")):
        source = release.get("sources", {}).get(name, {})
        demand(source.get("repository") == f"https://github.com/princessdardan/{repository}.git"
               and source_commit(source.get("commit")) and source.get("requiredChecks") == "passed", "EXACT_PASSING_SOURCES_REQUIRED")
    jobs = {}
    for name, (service, migration_key, runtime_key) in SERVICES.items():
        job = read_json(bundle, f"jobs/{name}.json")
        require_contract_identity(release, job)
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
            require_contract_identity(release, previous, outcome)
            demand(previous.get("status") == "DATABASE_VERIFIED" and previous.get("environment") == "staging"
                   and previous.get("service") == service and previous.get("failureCode") is None
                   and outcome.get("status") == "DATABASE_VERIFIED", "PASSING_STAGING_MIGRATION_REQUIRED")
            for key in ("sourceCommit", "migrationImageDigest", "runtimeImageDigest", "contractSha256"):
                demand(previous.get(key) == staging.get(key) == job.get(key), "STAGING_ARTIFACT_MISMATCH")
            demand(previous.get("artifactSha256") == staging.get("artifactSha256") == target.get("artifactSha256"), "STAGING_SQL_ARTIFACT_MISMATCH")
        jobs[name] = {"job": job, "schema": schema, "image": images["migration"], "service": service}
    if "frontendMigration" in release.get("artifacts", {}) or (bundle / "jobs/frontend.json").exists():
        jobs["frontend"] = frontend_plan(bundle, release)
    if environment == "production":
        acceptance = read_json(bundle, "staging/acceptance.json")
        require_contract_identity(release, acceptance)
        demand(acceptance.get("status") == "STAGING_VERIFIED" and acceptance.get("environment") == "staging"
               and acceptance.get("contractManifestSha256") == release["contractManifestSha256"], "STAGING_ACCEPTANCE_REQUIRED")
        for name in ("frontend", "course", "community"):
            demand(acceptance.get("sources", {}).get(name, {}).get("commit") == release["sources"][name]["commit"], "STAGING_SOURCE_MISMATCH")
        for key in ("gateway", "courseMigration", "courseRuntime", "communityMigration", "communityRuntime", *(("frontendMigration",) if "frontend" in jobs else ())):
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


def frontend_plan(bundle, release):
    job = read_json(bundle, "jobs/frontend.json")
    artifact = release["artifacts"].get("frontendMigration", {})
    image, prefix = artifact.get("image", ""), "ghcr.io/princessdardan/lash-her-platform-frontend-migration@"
    demand(isinstance(image, str) and image.startswith(prefix) and digest(image[len(prefix):])
           and artifact.get("scan") == "passed" and digest(artifact.get("sbomSha256")) and digest(artifact.get("provenanceSha256")), "VERIFIED_FRONTEND_IMAGE_REQUIRED")
    target, source = job.get("target", {}), release.get("frontendMigration", {})
    require_contract_identity(release, source, job)
    demand(job.get("version") == 1 and job.get("operator") == "Dardan" and job.get("environment") == release["environment"]
           and job.get("releaseId") == release["releaseId"] and job.get("sourceCommit") == source.get("sourceCommit") == release["sources"]["frontend"]["commit"]
           and job.get("migrationImageDigest") == image.split("@")[1] and job.get("contractManifestSha256") == source.get("contractManifestSha256") == release["contractManifestSha256"]
           and isinstance(job.get("sqlArtifactSha256"), str) and re.fullmatch(r"[a-f0-9]{64}", job["sqlArtifactSha256"])
           and job["sqlArtifactSha256"] == source.get("sqlArtifactSha256"), "FRONTEND_JOB_CANDIDATE_MISMATCH")
    demand(isinstance(target.get("host"), str) and re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", target["host"]) and "-pooler" not in target["host"]
           and all(isinstance(target.get(key), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,63}", target[key]) for key in ("database", "user", "runtimeRole"))
           and target["user"] != target["runtimeRole"] and target.get("serverMajor") in (16, 18)
           and isinstance(target.get("port"), int) and 0 < target["port"] < 65536
           and isinstance(target.get("allowEmptyBootstrap"), bool) and isinstance(target.get("approvedPendingTags"), list)
           and all(isinstance(tag, str) and re.fullmatch(r"[0-9]{4}_[a-z0-9_]+", tag) for tag in target["approvedPendingTags"]), "FRONTEND_TARGET_MISMATCH")
    schema = read_input(bundle, "schema/frontend.json")
    baseline = json.loads(schema)
    canonical = json.dumps(baseline, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    demand(file_hash(canonical) == job.get("schemaBaselineSha256") == source.get("schemaBaselines", {}).get(str(target["serverMajor"]))
           and baseline.get("version") == 1 and baseline.get("serverMajor") == target["serverMajor"]
           and baseline.get("sqlArtifactSha256") == job["sqlArtifactSha256"], "FRONTEND_SCHEMA_BINDING_REFUSED")
    # The packaged CLI independently checks the full schema and production
    # receipt bindings during network-disabled preflight before any credential.
    return {"job": job, "schema": schema, "image": image, "service": "frontend", "frontend": True}


def credential_names(name, environment):
    if name == "frontend":
        key = "FRONTEND_STAGING_MIGRATION_DATABASE_URL" if environment == "staging" else "FRONTEND_PROD_MIGRATION_DATABASE_URL"
        return key, key
    key = "STAGING_DATABASE_URL" if environment == "staging" else "PROD_DATABASE_URL"
    return f"{name.upper()}_{key}", key


def docker_arguments(image, input_directory, receipt_directory, environment, release_id, user, name, checking=False, frontend=False):
    args = ["docker", "run", "--rm", "--name", name, "--network", "none" if checking else "bridge",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", user,
            "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128", "--tmpfs", "/tmp:size=32m,mode=1777",
            "--mount", f"type=bind,src={input_directory},dst=/run/release-input,readonly"]
    if not checking:
        args += ["--mount", f"type=bind,src={receipt_directory},dst=/run/release-receipts"]
        if frontend:
            args += ["--env", credential_names("frontend", environment)[1]]
        else:
            args += ["--env", "DATABASE_TARGET", "--env", credential_names("course", environment)[1]]
    args += ["--entrypoint", "node", image, "ops/platform/frontend-image.mjs" if frontend else "dist-migration/scripts/run-operator-migration.js",
             "--check" if checking else "--execute"]
    if frontend:
        args += ["/run/release-input/candidate.json"]
    args += ["/run/release-input/job.json", "/run/release-input/schema.json"]
    if not checking:
        args += ["--confirm", f"{environment}/{release_id}", "/run/release-receipts"]
    return args


def suspend_runtime(environment, env):
    project = f"lash-her-{environment}"
    inventory = subprocess.run(["docker", "ps", "--filter", f"label=com.docker.compose.project={project}",
                                "--format", '{{.ID}} {{.Label "com.docker.compose.service"}}'],
                               check=True, capture_output=True, text=True, env=env, timeout=30)
    allowed = {"gateway", "course-api", "course-tls", "course-publisher", "course-snapshot", "community-api", "community-tls", "community-worker", "course-media", "course-export-cleanup"}
    ids = []
    long_grace = False
    lines = inventory.stdout.splitlines()
    demand(len(lines) <= 32, "RUNTIME_INVENTORY_REFUSED")
    for line in lines:
        parts = line.split()
        demand(len(parts) == 2 and re.fullmatch(r"[a-f0-9]{12,64}", parts[0]) and parts[1] in allowed, "RUNTIME_INVENTORY_REFUSED")
        ids.append(parts[0])
        long_grace = long_grace or parts[1] in ("course-media", "course-export-cleanup")
    if ids:
        grace = 60 if long_grace else 30
        subprocess.run(["docker", "stop", "--timeout", str(grace), *ids], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, timeout=grace + 30)
    remaining = subprocess.run(["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"],
                               check=True, capture_output=True, text=True, env=env, timeout=30)
    demand(not remaining.stdout.strip(), "WRITERS_NOT_SUSPENDED")
    return ids


def execute(bundle, results, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock"), after_migrations=None, docker_env=None, before_frontend_migration=None, _p2_scope=None):
    release, jobs = make_plan(bundle)
    environment, release_id = release["environment"], release["releaseId"]
    frontend_read_only = "frontend" in jobs and jobs["frontend"]["job"]["target"]["approvedPendingTags"] == []
    plan = {"releaseId": release_id, "environment": environment, "operator": "Dardan", "operation": "migrations-only",
            "targets": {name: {"host": info["job"]["target"].get("host"), "database": info["job"]["target"].get("database"),
                               "pendingTags": info["job"]["target"].get("approvedPendingTags"), "image": info["image"]} for name, info in jobs.items()},
            "trafficAuthorized": False, "credentialsRead": False, "maintenanceRequired": True}
    plan.update(contract_identity(release))
    if "frontend" in jobs:
        plan.update(frontendMigrationMode="verify-current-only" if frontend_read_only else "apply-forward",
                    frontendProducerSuspensionRequired=not frontend_read_only)
    if not apply:
        return plan
    demand(confirmation == f"{environment}/{release_id}", "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
    private_directory(results)
    for directory in (results.resolve(), bundle.resolve()):
        demand(not any((parent / ".git").exists() for parent in (directory, *directory.parents)), "RELEASE_ARTIFACTS_OUTSIDE_CHECKOUT_REQUIRED")
    demand("," not in str(results.resolve()) and "," not in str(bundle.resolve()), "MOUNT_PATH_REFUSED")
    # Only the fixed P2 broker can pass a process-local scope retaining its real
    # flock and live frontend PostgreSQL observer. The public CLI has no option.
    if _p2_scope is not None:
        from p2_release_scope import P2ReleaseScope
        demand(isinstance(_p2_scope, P2ReleaseScope) and "frontend" in jobs
               and before_frontend_migration is None, "P2_PROCESS_LOCAL_SCOPE_REQUIRED")
        _p2_scope.require_frontend(release, jobs["frontend"])
    lock_fd = (_p2_scope.descriptor if _p2_scope is not None else
               os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600))
    try:
        demand(stat.S_ISREG(os.fstat(lock_fd).st_mode) and os.fstat(lock_fd).st_uid == os.getuid(), "RELEASE_LOCK_REFUSED")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempt = results / release_id
        attempt.mkdir(mode=0o700)  # Existing/uncertain attempts never overwrite or retry.
        write_json(attempt, "started.json", plan)
        write_json(attempt, "candidate.json", release)
        outcome = {"status": "FAILED_REQUIRES_REVIEW", "releaseId": release_id, "environment": environment, "trafficAuthorized": False}
        outcome.update(contract_identity(release))
        base_env = dict(docker_env) if docker_env is not None else {
            key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG") if key in os.environ}
        uid, gid = (65532, 65532) if os.getuid() == 0 else (os.getuid(), os.getgid())
        prepared = []
        try:
            for name, info in jobs.items():
                if _p2_scope is not None:
                    _p2_scope.verify()
                outcome["phase"] = f"image-preflight-{name}"
                inputs, receipts = attempt / f"{name}-input", attempt / name
                inputs.mkdir(mode=0o700); receipts.mkdir(mode=0o700)
                write_json(inputs, "job.json", info["job"])
                if info.get("frontend"):
                    write_json(inputs, "candidate.json", release)
                (inputs / "schema.json").write_bytes(info["schema"])
                for file in inputs.iterdir():
                    file.chmod(0o400)
                    if os.getuid() == 0:
                        os.chown(file, uid, gid)
                if os.getuid() == 0:
                    os.chown(inputs, uid, gid); os.chown(receipts, uid, gid)
                prepared.append((name, info, inputs, receipts))
                runner = _p2_scope.run if _p2_scope is not None else subprocess.run
                runner(["docker", "pull", info["image"]], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=180)
                args = docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), environment, release_id, f"{uid}:{gid}", f"lash-check-{name}-{release_id}", True, info.get("frontend", False))
                runner(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=30)
            # Validate every job in its exact migration image before database credentials are read.
            outcome["phase"] = "credential-validation"
            credentials = {name: os.environ.get(credential_names(name, environment)[0]) for name in jobs
                           if name != "frontend" or _p2_scope is None}
            demand(all(credentials.values()), "NAMED_MIGRATION_CREDENTIAL_REQUIRED")
            if _p2_scope is not None:
                _p2_scope.require_frontend(release, jobs["frontend"])
            elif "frontend" in jobs and (not frontend_read_only or before_frontend_migration is not None):
                outcome["phase"] = "frontend-producer-suspension"
                # Vercel writers/schedules are outside Docker. Only the reviewed
                # full release coordinator can suspend/drain and verify them;
                # no JSON flag, shell hook or standalone CLI can assert this.
                demand(before_frontend_migration is not None, "FRONTEND_QUIESCENCE_COORDINATOR_REQUIRED")
                quiescence = before_frontend_migration(release, attempt)
                demand(isinstance(quiescence, dict) and quiescence.get("status") == "FRONTEND_PRODUCERS_SUSPENDED"
                       and quiescence.get("environment") == environment
                       and isinstance(release.get("workload", {}).get("projectId"), str)
                       and re.fullmatch(r"prj_[A-Za-z0-9]+", release["workload"]["projectId"])
                       and quiescence.get("projectId") == release.get("workload", {}).get("projectId"), "FRONTEND_QUIESCENCE_IDENTITY_REFUSED")
                # Keep provider responses/credentials out of the common receipt.
                write_json(attempt, "frontend-quiescence.json", {key: quiescence[key] for key in ("status", "environment", "projectId")})
            if frontend_read_only:
                # A current frontend must prove schema/lineage/roles through its
                # read-only image session before any API database is changed.
                # An empty reviewed list alone never establishes a no-op.
                prepared.sort(key=lambda item: item[0] != "frontend")
            outcome["phase"] = "suspend-runtime"
            outcome["stoppedRuntimeContainers"] = suspend_runtime(environment, base_env)
            outcome["runtimeResumed"] = False
            for name, info, inputs, receipts in prepared:
                if _p2_scope is not None:
                    _p2_scope.verify()
                    if name == "frontend":
                        # SQL already committed in the still-held Node session.
                        # Preserve that original stage; do not fabricate its
                        # terminal receipt, invoke SQL again or reacquire PG.
                        receipt = _p2_scope.require_frontend(release, info)
                        write_json(receipts, "database-receipt.json", receipt)
                        write_json(receipts, "frontend-continuation-open.json", {
                            "status": "FRONTEND_CONTINUATION_STILL_OPEN", "environment": environment,
                            "releaseId": release_id, "sqlReplayed": False, "trafficAuthorized": False})
                        continue
                outcome["phase"] = f"apply-{name}"
                env = {**base_env, credential_names(name, environment)[1]: credentials[name],
                       **({} if info.get("frontend") else {"DATABASE_TARGET": environment})}
                container_name = f"lash-migrate-{name}-{release_id}"
                args = docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), environment, release_id, f"{uid}:{gid}", container_name, frontend=info.get("frontend", False))
                log_fd = os.open(receipts / "container.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    runner = _p2_scope.run if _p2_scope is not None else subprocess.run
                    runner(args, check=True, stdout=log_fd, stderr=log_fd, env=env, timeout=1260)
                finally:
                    os.close(log_fd)
                    # Also cleans up a container left running by a timed-out/interrupted Docker CLI.
                    subprocess.run(["docker", "rm", "--force", container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=base_env, timeout=30)
                    inventory = subprocess.run(["docker", "container", "ls", "--all", "--filter", f"name=^/{container_name}$", "--format", "{{.ID}}"],
                                               check=True, capture_output=True, text=True, env=base_env, timeout=30)
                    demand(not inventory.stdout.strip(), "MIGRATION_CONTAINER_CLEANUP_UNVERIFIED")
                receipt = read_json(receipts, "database-receipt.json")
                terminal = read_json(receipts, "job-outcome.json")
                require_contract_identity(release, info["job"], receipt, terminal)
                demand(receipt.get("status") == "DATABASE_VERIFIED" and terminal.get("status") == "DATABASE_VERIFIED"
                       and receipt.get("environment") == environment and receipt.get("releaseId") == release_id
                       and receipt.get("service") == info["service"] and receipt.get("failureCode") is None and terminal.get("failureCode") is None, "MIGRATION_OUTCOME_REFUSED")
                fields = ("sourceCommit", "migrationImageDigest", "sqlArtifactSha256", "contractManifestSha256", "schemaBaselineSha256") if info.get("frontend") else (
                    "sourceCommit", "migrationImageDigest", "runtimeImageDigest", "contractSha256", "schemaBaselineSha256")
                for field in fields:
                    demand(receipt.get(field) == info["job"].get(field), "MIGRATION_RECEIPT_BINDING_REFUSED")
                    if info.get("frontend"):
                        demand(terminal.get(field) == receipt.get(field), "FRONTEND_TERMINAL_BINDING_REFUSED")
                if info.get("frontend"):
                    demand(receipt.get("schemaVerified") is True and receipt.get("runtimeRoleVerified") is True
                           and terminal.get("environment") == environment and terminal.get("releaseId") == release_id
                           and terminal.get("service") == "frontend" and terminal.get("target") == receipt.get("target"), "FRONTEND_POSTFLIGHT_REQUIRED")
                    if frontend_read_only:
                        demand(receipt.get("migrationMode") == terminal.get("migrationMode") == "verify-current-only"
                               and receipt.get("readOnlyVerified") is True and terminal.get("readOnlyVerified") is True
                               and receipt.get("applied") == [], "FRONTEND_READ_ONLY_VERIFICATION_REQUIRED")
                        outcome["frontendMigrationMode"] = "verify-current-only"
                        outcome["frontendReadOnlyVerified"] = True
            outcome["status"] = ("API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN" if _p2_scope is not None
                                 else "DATABASES_VERIFIED")
            outcome["phase"] = "completed"
            outcome["candidateSha256"] = file_hash(read_input(attempt, "candidate.json"))
            outcome["databaseReceiptSha256"] = {name: file_hash(read_input(receipts, "database-receipt.json")) for name, _info, _inputs, receipts in prepared}
        except BaseException as error:
            outcome["status"] = "FAILED_REQUIRES_REVIEW"
            code = str(error)
            outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "EXECUTION_OR_INPUT_FAILURE"
            raise
        finally:
            write_json(attempt, "migration-outcome.json", outcome)
        # A reviewed in-process runtime coordinator may continue only after the
        # database stage's terminal receipt is durable, while this flock remains
        # held. There is no command/JSON/environment hook or CLI bypass.
        if after_migrations is not None:
            return after_migrations(attempt, release, outcome)
        return outcome
    finally:
        if _p2_scope is None:
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
