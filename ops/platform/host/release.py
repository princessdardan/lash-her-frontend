#!/usr/bin/env python3
"""One operator action for API migrations and runtime startup; plan by default."""
import argparse
import copy
import contextvars
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import docker_inspect

_command_scope = contextvars.ContextVar("p2_runtime_command_scope", default=None)
_profiled_current_migration = contextvars.ContextVar("profiled_current_migration_continuation", default=None)


def profiled_current_migration_continuation(scope):
    """Only the fixed runtime parent installs this in-process continuation."""
    selected = _profiled_current_migration.get()
    return selected[1] if selected is not None and selected[0] is scope else None


STAGES = [("community-api", "course-api"), ("community-tls", "course-tls"),
          ("course-snapshot", "community-worker", "course-media", "course-export-cleanup"), ("course-publisher",), ("gateway",)]
SERVICES = tuple(service for stage in STAGES for service in stage)
ENV_FILES = ("course-api", "course-publisher", "course-snapshot", "community-api", "community-worker", "course-media", "course-export-cleanup")
TLS_FILES = ("tls/ca.pem", "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem",
             "tls/course/key.pem", "tls/course/cert.pem", "tls/community/key.pem", "tls/community/cert.pem")
CONFIG_FILES = ("gateway.json", "course-tls.json", "community-tls.json")
PROBE_CHECKS = {"public-tls-missing-workload-denied", "public-metrics-hidden", "private-course-tls-catalog",
                "private-application-credential-required", "private-community-peer-denied"}
IMAGE_KEYS = {"gateway": "gateway", "course-tls": "gateway", "community-tls": "gateway",
              "course-api": "courseRuntime", "course-publisher": "courseRuntime", "course-snapshot": "courseRuntime",
              "course-media": "courseRuntime", "course-export-cleanup": "courseRuntime",
              "community-api": "communityRuntime", "community-worker": "communityRuntime"}
NODE_CONFIG_CHECKS = {
    "course-api": 'await import("./dist/config/env.js")',
    "course-media": 'const m=await import("./dist/config/mux-media-process-env.js");m.parseMuxMediaProcessEnv()',
    "course-export-cleanup": 'const m=await import("./dist/config/account-export-process-env.js");m.parseAccountExportProcessEnv()',
    "course-publisher": 'const m=await import("./dist/config/community-process-env.js");m.parseCommunityPublisherProcessEnv()',
    "course-snapshot": 'const m=await import("./dist/config/community-process-env.js");m.parseCommunitySnapshotWorkerProcessEnv()',
    "community-api": 'await import("./dist/config/env.js")',
    "community-worker": 'await import("./dist/config/env.js")',
}
SAFE_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "DOCKER_CONTEXT": "default"}
demand = migrate.demand


def command(args, env, timeout=30):
    # Provider/container errors can contain credentials. Never print or retain
    # unfiltered command output; callers consume only selected structured fields.
    scope = _command_scope.get()
    runner = scope.run if scope is not None else subprocess.run
    return runner(args, env=env, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def _runtime_target_profile(target, release, expected):
    migrate.require_profile(expected, target)
    demand(target.get("version") == (1 if expected is None else 2) and target.get("environment") == release["environment"]
           and target.get("releaseId") == release["releaseId"], "RUNTIME_TARGET_MISMATCH")
    if expected is not None:
        demand(type(target.get("version")) is int and set(target) == {
            "version", "environment", "releaseId", "hostMachineId", "previousReleaseRef", "maintenanceRef", "qualificationTargetProfile"},
            "QUALIFICATION_TARGET_PROFILE_REQUIRED")


def make_plan(bundle, configuration, compose_file, *, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    release, jobs = migrate.make_plan(bundle, expected_profile=expected)
    target = migrate.read_json(configuration, "runtime.json", expected_profile=expected)
    _runtime_target_profile(target, release, expected)
    environment, release_id = release["environment"], release["releaseId"]
    demand(isinstance(target.get("hostMachineId"), str) and re.fullmatch(r"[a-f0-9]{32}", target["hostMachineId"])
           and target["hostMachineId"] != "0" * 32, "EXACT_DEPLOYMENT_HOST_REQUIRED")
    for field in ("previousReleaseRef", "maintenanceRef"):
        demand(isinstance(target.get(field), str) and re.fullmatch(r"[A-Za-z0-9_./:-]{1,200}", target[field]), "RECOVERY_MAINTENANCE_REFERENCE_REQUIRED")
    runtime = release.get("runtime", {})
    compose = migrate.read_input(compose_file.parent, compose_file.name)
    demand(runtime.get("composeSha256") == "sha256:" + migrate.file_hash(compose), "PINNED_COMPOSE_REQUIRED")
    gateway = migrate.read_json(configuration, "gateway.json", expected_profile=expected)
    migrate.require_profile(None, gateway)  # Profile metadata belongs only to the host wrapper.
    if expected is not None:
        from qualification_target_profile import resolve_qualification_target_profile
        definition = resolve_qualification_target_profile(expected)
        demand(gateway.get("ownerId") == definition["frontend"]["teamId"] and
               gateway.get("projectId") == definition["frontend"]["projectId"] and
               "https://" + gateway.get("publicHost", "") == definition["gateway"]["publicOrigin"],
               "QUALIFICATION_TARGET_OBSERVATION_MISMATCH")
    demand(gateway.get("appEnv") == environment and gateway.get("environment") == "production"
           and gateway.get("projectId") == release.get("workload", {}).get("projectId") and gateway.get("maintenance") is True
           and isinstance(gateway.get("publicHost"), str) and re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", gateway["publicHost"])
           and gateway.get("courseOrigin") == "https://course-tls:8443"
           and gateway.get("communityOrigin") in (None, "https://community-tls:8443")
           and gateway.get("tlsKeyFile") == "/tls/key.pem" and gateway.get("tlsCertFile") == "/tls/cert.pem"
           and gateway.get("upstreamCaFile") == "/tls/ca.pem", "GATEWAY_TARGET_MISMATCH")
    for name in ("course", "community"):
        policy = runtime.get("privateTlsPolicies", {}).get(name)
        demand(isinstance(policy, dict) and migrate.read_json(configuration, f"{name}-tls.json") == policy, "PINNED_PRIVATE_POLICY_REQUIRED")
    for key, suffix in (("gateway", "gateway"), ("courseRuntime", "course-runtime"), ("communityRuntime", "community-runtime")):
        artifact = release.get("artifacts", {}).get(key, {})
        prefix = f"ghcr.io/princessdardan/lash-her-platform-{suffix}@"
        image = artifact.get("image", "")
        demand(isinstance(image, str) and image.startswith(prefix) and migrate.digest(image[len(prefix):])
               and artifact.get("scan") == "passed" and migrate.digest(artifact.get("sbomSha256"))
               and migrate.digest(artifact.get("provenanceSha256")), "VERIFIED_RUNTIME_IMAGES_REQUIRED")
    plan = {"operation": "api-migrations-and-runtime", "environment": environment, "releaseId": release_id,
            "operator": "Dardan", "hostMachineId": target["hostMachineId"], "publicHost": gateway["publicHost"],
            "images": {key: release["artifacts"][key]["image"] for key in ("gateway", "courseRuntime", "communityRuntime")},
            "databaseTargets": {name: {key: info["job"]["target"].get(key) for key in ("host", "database", "approvedPendingTags")} for name, info in jobs.items()},
            "previousReleaseRef": target["previousReleaseRef"], "maintenanceRef": target["maintenanceRef"],
            "stages": STAGES, "credentialsRead": False, "trafficAuthorized": False, "frontendPromotionAuthorized": False}
    plan.update(migrate.contract_identity(release))
    if expected is not None:
        plan.update(version=2, qualificationTargetProfile=expected)
    return release, jobs, plan, compose


def assert_host(target):
    demand(sys.platform == "linux" and platform.machine() in ("x86_64", "amd64") and os.geteuid() == 0, "RELEASE_REQUIRES_SELECTED_LINUX_ROOT_HOST")
    machine = Path("/etc/machine-id").read_text().strip()
    demand(machine == target["hostMachineId"], "DEPLOYMENT_HOST_MISMATCH")
    endpoint = command(["docker", "context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'], SAFE_ENV)
    demand(endpoint == "unix:///var/run/docker.sock", "LOCAL_DOCKER_ENGINE_REQUIRED")
    demand(command(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], SAFE_ENV) == "linux/amd64", "AMD64_LINUX_ENGINE_REQUIRED")


def environment_values(raw, environment, service, jobs, *, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    if expected is not None:
        for info in jobs.values():
            migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    text = raw.decode("utf8")
    demand("\x00" not in text and "\r" not in text, "RAW_ENV_FILE_REQUIRED")
    values = {}
    selected = "STAGING_DATABASE_URL" if environment == "staging" else "PROD_DATABASE_URL"
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        demand(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in values
               and not any(ord(character) < 32 or ord(character) == 127 for character in value), "RAW_ENV_FILE_REQUIRED")
        demand(not key.startswith(("AWS_", "GITHUB_", "GH_", "VERCEL_", "DOCKER_", "COMPOSE_", "LD_"))
               and not key.startswith(("PG", "SSL_")) and (not key.startswith("NODE_") or key == "NODE_ENV")
               and key not in ("PATH", "HOME")
               and ("DATABASE_URL" not in key or key == selected)
               and "MIGRATION" not in key, "RUNTIME_CREDENTIAL_SCOPE_REFUSED")
        values[key] = value
    worker_keys = {
        "course-media": {"MUX_TOKEN_ID", "MUX_TOKEN_SECRET", "MUX_ENVIRONMENT_ID", "MUX_MEDIA_RECOVERY_ENABLED", "MUX_MEDIA_CLEANUP_ENABLED", "MUX_MEDIA_RECOVERY_POLL_INTERVAL_MS"},
        "course-export-cleanup": {"COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED", "COURSE_ACCOUNT_EXPORT_CLEANUP_POLL_MS"},
    }
    if service in worker_keys:
        demand(set(values).issubset({"NODE_ENV", "DATABASE_TARGET", selected} | worker_keys[service]), "WORKER_CREDENTIAL_SCOPE_REFUSED")
    name = "course" if service.startswith("course-") else "community"
    target = jobs[name]["job"]["target"]
    role = jobs[name]["job"].get("runtimeRole")
    selector = "prod" if environment == "production" and name == "course" else environment
    demand(values.get("DATABASE_TARGET") == selector and values.get("NODE_ENV", "production") == "production", "RUNTIME_ENVIRONMENT_MISMATCH")
    url = urlsplit(values.get(selected, ""))
    demand(url.scheme in ("postgres", "postgresql") and url.hostname == target["host"]
           and (url.port or 5432) == target.get("port", 5432) and unquote(url.path) == "/" + target["database"]
           and isinstance(role, str) and role != target["user"] and unquote(url.username or "") == role
           and bool(url.password) and not url.fragment and parse_qsl(url.query, keep_blank_values=True) == [("sslmode", "verify-full")], "RUNTIME_DATABASE_TARGET_OR_TLS_REFUSED")
    return values


def validate_snapshot_source(source, release, jobs, *, expected_profile=None):
    """Validate private input before an operation can pause or write fixtures.

    Running snapshots have container-owned TLS/config files. They are not
    reusable operator inputs; select the retained root-owned input instead.
    """
    expected = migrate.candidate_profile(release, expected_profile)
    if expected is not None:
        _profiled_snapshot_inputs(source, release, jobs, expected)
    migrate.private_directory(source)
    for relative in ("runtime.json", *CONFIG_FILES, *TLS_FILES, *(f"{service}.env" for service in ENV_FILES)):
        raw = migrate.read_input(source, relative, 65_536)
        info = (source / relative).stat()
        demand(info.st_uid == os.getuid(), "CONFIGURATION_OWNER_REQUIRED")
        if relative.endswith((".env", "key.pem")):
            demand(info.st_mode & 0o077 == 0, "PRIVATE_CREDENTIAL_FILE_REQUIRED")
        if relative.endswith(".env"):
            environment_values(raw, release["environment"], relative[:-4], jobs, expected_profile=expected)


def snapshot_configuration(source, destination, release, jobs, compose, *, expected_profile=None):
    expected = migrate.candidate_profile(release, expected_profile)
    if expected is not None:
        _profiled_snapshot_inputs(source, release, jobs, expected)
    migrate.private_directory(source)
    destination.mkdir(mode=0o700)
    files = ("runtime.json", *CONFIG_FILES, *TLS_FILES, *(f"{service}.env" for service in ENV_FILES))
    for relative in files:
        raw = migrate.read_input(source, relative, 65_536)
        info = (source / relative).stat()
        demand(info.st_uid == os.getuid(), "CONFIGURATION_OWNER_REQUIRED")
        if relative.endswith((".env", "key.pem")):
            demand(info.st_mode & 0o077 == 0, "PRIVATE_CREDENTIAL_FILE_REQUIRED")
        if relative.endswith(".env"):
            environment_values(raw, release["environment"], relative[:-4], jobs, expected_profile=expected)
        file = destination / relative
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        file.write_bytes(raw)
        file.chmod(0o600)
    demand((destination / "tls/ca.pem").read_bytes() == (destination / "tls/gateway/ca.pem").read_bytes(), "SHARED_PRIVATE_CA_REQUIRED")
    (destination / "compose.yaml").write_bytes(compose)
    (destination / "compose.yaml").chmod(0o600)
    # Directory binding exposes atomic host admission changes without restart.
    (destination / "admission").mkdir(mode=0o755)
    # Each container receives only its own TLS directory/config. Env files are
    # read by the host Compose process, never mounted into other services.
    for path in [*(destination / "tls").rglob("*"), *(destination / name for name in CONFIG_FILES)]:
        path.chmod(0o500 if path.is_dir() else 0o400)
        if os.getuid() == 0:
            os.chown(path, 65532, 65532)


def _profiled_snapshot_inputs(source, release, jobs, expected):
    target = migrate.read_json(source, "runtime.json", expected_profile=expected)
    _runtime_target_profile(target, release, expected)
    for info in jobs.values():
        migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))


def snapshot_bundle(source, destination, release, jobs, *, expected_profile=None):
    expected = migrate.candidate_profile(release, expected_profile)
    if expected is not None:
        for info in jobs.values():
            migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    destination.mkdir(mode=0o700)
    if expected is None:
        migrate.write_json(destination, "release.candidate.json", release)
    else:
        migrate.write_exact_bytes(destination, "release.candidate.json", migrate.read_input(source, "release.candidate.json"))
    for name, info in jobs.items():
        (destination / "jobs").mkdir(mode=0o700, exist_ok=True)
        (destination / "schema").mkdir(mode=0o700, exist_ok=True)
        if expected is None:
            migrate.write_json(destination / "jobs", f"{name}.json", info["job"])
        else:
            migrate.write_exact_bytes(destination / "jobs", f"{name}.json", migrate.read_input(source, f"jobs/{name}.json"))
        path = destination / f"schema/{name}.json"
        path.write_bytes(info["schema"]); path.chmod(0o600)
    if release["environment"] == "production":
        for relative in ("staging/acceptance.json", "recovery.json", *(f"staging/{name}/{file}" for name in jobs for file in ("database-receipt.json", "job-outcome.json"))):
            path = destination / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(migrate.read_input(source, relative)); path.chmod(0o600)
    copied_release, copied_jobs = migrate.make_plan(destination, expected_profile=expected)
    demand(copied_release == release and copied_jobs == jobs, "MIGRATION_SNAPSHOT_MISMATCH")


def compose_command(snapshot, environment):
    return ["docker", "compose", "--env-file", "/dev/null", "--project-directory", str(snapshot),
            "--project-name", f"lash-her-{environment}", "-f", str(snapshot / "compose.yaml")]


def runtime_environment(release, snapshot, *, expected_profile=None):
    migrate.candidate_profile(release, expected_profile)
    return {**SAFE_ENV, "APP_ENV": release["environment"], "RELEASE_DIR": str(snapshot),
            **{key: release["artifacts"][artifact]["image"] for key, artifact in (
                ("GATEWAY_IMAGE", "gateway"), ("COURSE_RUNTIME_IMAGE", "courseRuntime"), ("COURSE_MIGRATION_IMAGE", "courseMigration"),
                ("COMMUNITY_RUNTIME_IMAGE", "communityRuntime"), ("COMMUNITY_MIGRATION_IMAGE", "communityMigration"))}}


def configuration_container(arguments):
    from p2_profiled_current_scope import P2ProfiledCurrentScope
    scope = _command_scope.get()
    profiled = type(scope) is P2ProfiledCurrentScope
    name = ("lash-p2-profiled-current-image-check-" if profiled else "lash-config-") + uuid4().hex
    try:
        image_options = ["--pull", "never", "--platform", "linux/amd64"] if profiled else []
        return command([*arguments[:2], "--name", name, *image_options, *arguments[2:]], SAFE_ENV)
    finally:
        runner = scope.run if profiled else subprocess.run
        runner(["docker", "rm", "--force", name], env=SAFE_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        remaining = command(["docker", "container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.ID}}"], SAFE_ENV)
        demand(not remaining, "CONFIGURATION_CONTAINER_CLEANUP_UNVERIFIED")


def preflight(release, snapshot, jobs, pull=True, *, expected_profile=None):
    expected = migrate.candidate_profile(release, expected_profile)
    if expected is not None:
        for info in jobs.values():
            migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    demand(type(pull) is bool, "EXPLICIT_IMAGE_PREFLIGHT_MODE_REQUIRED")
    env = runtime_environment(release, snapshot, expected_profile=expected)
    for key in ("gateway", "courseRuntime", "communityRuntime"):
        image = release["artifacts"][key]["image"]
        if pull:
            command(["docker", "pull", image], SAFE_ENV, 180)
        else:
            identity = command(["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image], SAFE_ENV)
            demand(re.fullmatch(r"sha256:[a-f0-9]{64}", identity), "CACHED_RUNTIME_IMAGE_REQUIRED")
    # Avoid serialized/interpolation-escaped secret values from `compose config`.
    # Merge each already-validated raw file with its pinned public overrides.
    model = json.loads(command([*compose_command(snapshot, release["environment"]), "config", "--no-env-resolution", "--format", "json"], env))
    demand(set(model.get("services", {})) == set(SERVICES), "DEFAULT_RUNTIME_TOPOLOGY_REQUIRED")
    for service in SERVICES:
        demand(model["services"][service].get("image") == release["artifacts"][IMAGE_KEYS[service]]["image"], "COMPOSE_IMAGE_MISMATCH")
    for service in ENV_FILES:
        if service in ("course-media", "course-export-cleanup"):
            public_overrides = {"NODE_ENV": "production", "PORT": "4003" if service == "course-media" else "4004", "NODE_OPTIONS": "--max-old-space-size=128"}
            demand(model["services"][service].get("environment") == public_overrides, "WORKER_PUBLIC_OVERRIDES_REFUSED")
        values = {**environment_values(migrate.read_input(snapshot, f"{service}.env", 65_536), release["environment"], service,
                                      jobs, expected_profile=expected),
                  **model["services"][service]["environment"]}
        demand(isinstance(values, dict) and all(isinstance(value, str) and "\n" not in value and "\x00" not in value for value in values.values()), "RESOLVED_ENVIRONMENT_REFUSED")
        file = snapshot / f"{service}.resolved.env"
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
        configuration_container(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                 "--memory", "128m", "--pids-limit", "64", "--env-file", str(file), "--entrypoint", "node",
                 release["artifacts"][IMAGE_KEYS[service]]["image"], "--input-type=module", "--eval", NODE_CONFIG_CHECKS[service]])
    image = release["artifacts"]["gateway"]["image"]
    for service, module, expression in (("gateway", "server.mjs", "createGateway(c).server"),
                                        ("course", "private-tls.mjs", "createPrivateTlsProxy(c)"),
                                        ("community", "private-tls.mjs", "createPrivateTlsProxy(c)")):
        config_name = "gateway.json" if service == "gateway" else f"{service}-tls.json"
        source = f'import {{readFileSync}} from "node:fs"; import * as m from "./{module}"; const c=JSON.parse(readFileSync("/config/input.json","utf8")); const {{createGateway,createPrivateTlsProxy}}=m; {expression}.close();'
        configuration_container(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                 "--memory", "128m", "--pids-limit", "64", "--mount", f"type=bind,src={snapshot / config_name},dst=/config/input.json,readonly",
                 "--mount", f"type=bind,src={snapshot / 'tls' / service},dst=/tls,readonly", "--entrypoint", "node", image,
                 "--input-type=module", "--eval", source])


def check_containers(release, snapshot, *, expected_profile=None):
    expected = migrate.candidate_profile(release, expected_profile)
    env = runtime_environment(release, snapshot, expected_profile=expected)
    prefix = compose_command(snapshot, release["environment"])
    metadata = []
    for service in SERVICES:
        ids = command([*prefix, "ps", "--all", "--quiet", service], env).split()
        demand(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{12,64}", ids[0]), "EXACT_RUNTIME_REPLICA_REQUIRED")
        identity = release["artifacts"][IMAGE_KEYS[service]]["image"]
        local = command(["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", identity], SAFE_ENV)
        fields = docker_inspect.RUNTIME_FIELDS
        actual = command(["docker", "inspect", "--format", fields, ids[0]], SAFE_ENV).split("|")
        demand(len(actual) == 5 and actual[0] in (local, identity.split("@")[1]) and actual[1] == "true"
               and actual[2] == ("none" if service.endswith("-tls") else "healthy")
               and actual[3:] == [f'lash-her-{release["environment"]}', service], "RUNTIME_HEALTH_OR_IDENTITY_REFUSED")
        metadata.append({"service": service, "containerId": ids[0], "image": identity, "health": actual[2]})
    return metadata



def _runtime_scope(expected, apply, legacy_scope, profiled_scope, before, after):
    if expected is None:
        demand(profiled_scope is None, "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED")
        return legacy_scope
    demand(legacy_scope is None and before is None and after is None,
           "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED")
    if not apply:
        demand(profiled_scope is None, "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED")
        return None
    demand(profiled_scope is not None, "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED")
    from p2_profiled_current_scope import P2ProfiledCurrentScope
    demand(type(profiled_scope) is P2ProfiledCurrentScope, "PROFILED_CURRENT_PROCESS_LOCAL_SCOPE_REQUIRED")
    profiled_scope.verify()
    return profiled_scope


def _execute(bundle, configuration, results, compose_file, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock"), before_frontend_migration=None, after_runtime_ready=None, _p2_scope=None, *, expected_profile=None, _profiled_current_scope=None, _current_database_proof=None):
    expected = migrate.profile_context(expected_profile)
    active_scope = _runtime_scope(expected, apply, _p2_scope, _profiled_current_scope,
                                  before_frontend_migration, after_runtime_ready)
    release, jobs, plan, compose = make_plan(bundle, configuration, compose_file, expected_profile=expected)
    verified_current = None
    if _current_database_proof is not None:
        demand(apply and _profiled_current_scope is not None and _profiled_current_scope.recovery_action_id is not None,
               "PROFILED_CURRENT_RUNTIME_RESTORE_SCOPE_REQUIRED")
        import current_databases
        verified_current = current_databases.read_profiled_current_proof(
            _current_database_proof, _profiled_current_scope, release, jobs, expected_profile=expected)
    if active_scope is not None:
        active_scope.require_release(release, jobs)
        active_scope.require_configuration(configuration)
    if not apply:
        return plan
    if _profiled_current_scope is not None:
        demand("frontend" in jobs and jobs["frontend"]["job"]["target"]["approvedPendingTags"] == [],
               "PROFILED_CURRENT_FRONTEND_CURRENT_ONLY_REQUIRED")
        active_scope.require_frontend(release, jobs["frontend"])
        after_runtime_ready = active_scope.runtime_ready
    demand(confirmation == f'{release["environment"]}/{release["releaseId"]}', "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
    demand(after_runtime_ready is None or callable(after_runtime_ready), "RUNTIME_CONTINUATION_REQUIRED")
    assert_host(plan)
    migrate.private_directory(results)
    for directory in (results.resolve(), configuration.resolve(), bundle.resolve()):
        demand(not any((parent / ".git").exists() for parent in (directory, *directory.parents)), "PRIVATE_RUNTIME_OUTSIDE_CHECKOUT_REQUIRED")
        demand("," not in str(directory), "MOUNT_PATH_REFUSED")
    attempt = (migrate.profiled_current_attempt(_profiled_current_scope, results, release, "runtime")
               if _profiled_current_scope is not None else results / f'runtime-{release["releaseId"]}')
    attempt.mkdir(mode=0o700)
    migrate.write_json(attempt, "started.json", plan)
    snapshot = attempt / "configuration"
    outcome = {"status": "FAILED_REQUIRES_REVIEW", "environment": release["environment"], "releaseId": release["releaseId"],
               "trafficAuthorized": False, "frontendPromotionAuthorized": False, "releaseAccepted": False,
               "realVercelOidcVerified": False, "externalIngressVerified": False, "phase": "configuration-preflight"}
    outcome.update(migrate.contract_identity(release))
    if _profiled_current_scope is not None:
        outcome.update(version=2, qualificationTargetProfile=expected, frontendSqlApplied=False,
                       sourceCommit=release["sources"]["frontend"]["commit"],
                       candidateSha256=migrate.file_hash(migrate.read_input(bundle, "release.candidate.json")),
                       configurationSha256=copy.deepcopy(active_scope.configuration_sha256),
                       historicalProviderClosureClaimed=False, oldP200Qualified=False, nativeSchedulesEnabled=False)

    def start_runtime(migration_attempt, verified_release, database_outcome):
        # Invoked only after durable database success, while migrate.execute
        # holds the release/watchdog lock. No second approval step is needed.
        try:
            expected_database_status = ("CURRENT_DATABASES_READ_ONLY_VERIFIED" if verified_current is not None else
                                        "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN" if active_scope is not None else
                                        "DATABASES_VERIFIED")
            if active_scope is not None:
                active_scope.require_frontend(release, jobs["frontend"])
            demand(verified_release == release and database_outcome.get("status") == expected_database_status, "DATABASE_STAGE_BINDING_REFUSED")
            migrate.require_contract_identity(release, database_outcome)
            migrate.require_profile(expected, database_outcome)
            if _profiled_current_scope is not None:
                demand(database_outcome.get("candidateSha256") == outcome["candidateSha256"]
                       and database_outcome.get("frontendSqlApplied") is False,
                       "PROFILED_CURRENT_DURABLE_DATABASE_STAGE_REQUIRED")
                if verified_current is not None:
                    demand(database_outcome.get("frontendProofHeld") is True
                           and database_outcome.get("migrationsExecuted") is False,
                           "PROFILED_CURRENT_READ_ONLY_DATABASE_STAGE_REQUIRED")
                else:
                    demand(database_outcome.get("frontendReadOnlyVerified") is True,
                           "PROFILED_CURRENT_DURABLE_DATABASE_STAGE_REQUIRED")
            outcome["phase"] = "runtime-startup"
            prefix, env = compose_command(snapshot, release["environment"]), runtime_environment(release, snapshot, expected_profile=expected)
            for stage in STAGES:
                if active_scope is not None:
                    active_scope.before_runtime_stage(stage)
                outcome["phase"] = "start-" + "+".join(stage)
                command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "90", *stage], env, 120)
                if active_scope is not None:
                    active_scope.after_runtime_stage(stage)
            outcome["phase"] = "runtime-boundary-probes"
            probe = json.loads(command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], env, 30))
            demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and isinstance(probe.get("checks"), list)
                   and len(probe["checks"]) == 5 and set(probe["checks"]) == PROBE_CHECKS, "RUNTIME_BOUNDARY_CHECKS_REQUIRED")
            outcome["containers"] = check_containers(release, snapshot, expected_profile=expected)
            if active_scope is not None:
                active_scope.verify()
            outcome["boundaryChecks"] = probe["checks"]
            if verified_current is not None:
                outcome["currentDatabasesOutcomeSha256"] = migrate.file_hash(migrate.read_input(
                    migration_attempt, "current-databases-outcome.json"))
                outcome["migrationsExecuted"] = False
            else:
                outcome["migrationOutcomeSha256"] = migrate.file_hash(migrate.read_input(migration_attempt, "migration-outcome.json"))
            outcome["candidateSha256"] = database_outcome["candidateSha256"]
            outcome["phase"], outcome["status"] = "completed", "API_RUNTIME_READY"
            migrate.write_json(attempt, "runtime-outcome.json", outcome)
            if after_runtime_ready is not None:
                # The reviewed parent owns provider coordination, real workload
                # verification and its separate release outcome. Stay inside
                # migrate.execute's flock for that entire continuation. The API
                # receipt remains an API-only result, never release acceptance.
                ready = copy.deepcopy(outcome)
                outcome["phase"] = "frontend-coordination"
                after_runtime_ready(attempt, migration_attempt, snapshot,
                                    copy.deepcopy(verified_release), ready)
                outcome["phase"] = "completed"
            return outcome
        except BaseException:
            if outcome["phase"] == "completed":
                outcome["phase"] = "retain-runtime-receipt"
            outcome["status"] = "FAILED_REQUIRES_REVIEW"
            if _profiled_current_scope is not None:
                # The source guard stops runtime after revoking and reaping
                # this worker. Starting a second stop here would race it.
                outcome["runtimeStopped"] = None
            else:
                try:
                    migrate.suspend_runtime(release["environment"], SAFE_ENV)
                    outcome["runtimeStopped"] = True
                except BaseException:
                    outcome["runtimeStopped"] = False
            raise

    try:
        immutable_bundle = attempt / "migration-input"
        snapshot_bundle(bundle, immutable_bundle, release, jobs, expected_profile=expected)
        if _profiled_current_scope is not None:
            demand(migrate.file_hash(migrate.read_input(immutable_bundle, "release.candidate.json")) == active_scope.candidate_sha256,
                   "PROFILED_CURRENT_ORIGINAL_CANDIDATE_CHANGED")
        snapshot_configuration(configuration, snapshot, release, jobs, compose, expected_profile=expected)
        if active_scope is not None:
            active_scope.require_release(release, jobs)
            active_scope.require_configuration(snapshot)
            active_scope.initialize_runtime(snapshot, release)
        checked_release, checked_jobs, checked_plan, _ = make_plan(immutable_bundle, snapshot, snapshot / "compose.yaml", expected_profile=expected)
        demand(checked_release == release and checked_jobs == jobs and checked_plan == plan, "RUNTIME_CONFIGURATION_CHANGED")
        preflight(release, snapshot, jobs, pull=verified_current is None, expected_profile=expected)
        if verified_current is not None:
            # Rejoin the immutable producer receipts under the still-held FE
            # and host locks. This path never calls the migration executor.
            current_directory, current_outcome = current_databases.read_profiled_current_proof(
                _current_database_proof, _profiled_current_scope, release, jobs, expected_profile=expected)
            outcome["phase"] = "suspend-runtime-for-current-restore"
            active_scope.suspend_api_runtime(release["environment"], SAFE_ENV)
            return start_runtime(current_directory, release, current_outcome)
        outcome["phase"] = "migrations"
        continuation_token = _profiled_current_migration.set((_profiled_current_scope, start_runtime)) if _profiled_current_scope is not None else None
        try:
            return migrate.execute(immutable_bundle, results, True, confirmation, lock_path, after_migrations=start_runtime, docker_env=SAFE_ENV,
                                   before_frontend_migration=before_frontend_migration, _p2_scope=_p2_scope,
                                   expected_profile=expected, _profiled_current_scope=_profiled_current_scope)
        finally:
            if continuation_token is not None:
                _profiled_current_migration.reset(continuation_token)
    except BaseException as error:
        outcome["status"] = "FAILED_REQUIRES_REVIEW"
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "RUNTIME_OR_INPUT_FAILURE"
        migrate.write_json(attempt, "runtime-outcome.json" if not (attempt / "runtime-outcome.json").exists() else "runtime-failure.json", outcome)
        raise


def execute(bundle, configuration, results, compose_file, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock"), before_frontend_migration=None, after_runtime_ready=None, _p2_scope=None, *, expected_profile=None, _profiled_current_scope=None):
    expected = migrate.profile_context(expected_profile)
    active_scope = _runtime_scope(expected, apply, _p2_scope, _profiled_current_scope,
                                  before_frontend_migration, after_runtime_ready)
    token = _command_scope.set(active_scope)
    try:
        return _execute(bundle, configuration, results, compose_file, apply, confirmation, lock_path,
                        before_frontend_migration, after_runtime_ready, _p2_scope, expected_profile=expected,
                        _profiled_current_scope=_profiled_current_scope)
    finally:
        _command_scope.reset(token)


def restore_profiled_current_runtime(bundle, configuration, results, compose_file, proof, *,
                                     expected_profile, _profiled_current_scope):
    """Fixed recovery-only runtime restoration from the actual read-only proof."""
    expected = migrate.profile_context(expected_profile)
    import current_databases
    demand(type(proof) is current_databases.ProfiledCurrentDatabaseProof,
           "PROFILED_CURRENT_DATABASE_PROOF_REQUIRED")
    scope = _runtime_scope(expected, True, None, _profiled_current_scope, None, None)
    demand(expected is not None and scope is not None and scope.recovery_action_id is not None,
           "PROFILED_CURRENT_RUNTIME_RESTORE_SCOPE_REQUIRED")
    selected = scope.release
    scope.require_release(selected, scope.jobs)
    token = _command_scope.set(scope)
    try:
        return _execute(bundle, configuration, results, compose_file, True, 'staging/' + selected['releaseId'],
                        scope.path, expected_profile=expected, _profiled_current_scope=scope,
                        _current_database_proof=proof)
    finally:
        _command_scope.reset(token)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--profiled-current", action="store_true")
    args = parser.parse_args()
    expected = None
    if args.profiled_current:
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    def interrupted(signum, _frame):
        raise SystemExit(130 if signum == signal.SIGINT else 143)
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        print(json.dumps(execute(args.bundle, args.configuration, args.results, Path(__file__).parents[1] / "compose.yaml", args.apply, args.confirm,
                                 expected_profile=expected)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print('{"status":"API_RELEASE_REFUSED","trafficAuthorized":false,"reviewRequired":true}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
