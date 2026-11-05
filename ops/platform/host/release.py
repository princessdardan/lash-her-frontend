#!/usr/bin/env python3
"""One operator action for API migrations and runtime startup; plan by default."""
import argparse
import copy
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

import migrate
import docker_inspect

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
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def make_plan(bundle, configuration, compose_file):
    release, jobs = migrate.make_plan(bundle)
    target = migrate.read_json(configuration, "runtime.json")
    environment, release_id = release["environment"], release["releaseId"]
    demand(target.get("version") == 1 and target.get("environment") == environment
           and target.get("releaseId") == release_id, "RUNTIME_TARGET_MISMATCH")
    demand(isinstance(target.get("hostMachineId"), str) and re.fullmatch(r"[a-f0-9]{32}", target["hostMachineId"])
           and target["hostMachineId"] != "0" * 32, "EXACT_DEPLOYMENT_HOST_REQUIRED")
    for field in ("previousReleaseRef", "maintenanceRef"):
        demand(isinstance(target.get(field), str) and re.fullmatch(r"[A-Za-z0-9_./:-]{1,200}", target[field]), "RECOVERY_MAINTENANCE_REFERENCE_REQUIRED")
    runtime = release.get("runtime", {})
    compose = migrate.read_input(compose_file.parent, compose_file.name)
    demand(runtime.get("composeSha256") == "sha256:" + migrate.file_hash(compose), "PINNED_COMPOSE_REQUIRED")
    gateway = migrate.read_json(configuration, "gateway.json")
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
    return release, jobs, plan, compose


def assert_host(target):
    demand(sys.platform == "linux" and platform.machine() in ("x86_64", "amd64") and os.geteuid() == 0, "RELEASE_REQUIRES_SELECTED_LINUX_ROOT_HOST")
    machine = Path("/etc/machine-id").read_text().strip()
    demand(machine == target["hostMachineId"], "DEPLOYMENT_HOST_MISMATCH")
    endpoint = command(["docker", "context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'], SAFE_ENV)
    demand(endpoint == "unix:///var/run/docker.sock", "LOCAL_DOCKER_ENGINE_REQUIRED")
    demand(command(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], SAFE_ENV) == "linux/amd64", "AMD64_LINUX_ENGINE_REQUIRED")


def environment_values(raw, environment, service, jobs):
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


def validate_snapshot_source(source, release, jobs):
    """Validate private input before an operation can pause or write fixtures.

    Running snapshots have container-owned TLS/config files. They are not
    reusable operator inputs; select the retained root-owned input instead.
    """
    migrate.private_directory(source)
    for relative in ("runtime.json", *CONFIG_FILES, *TLS_FILES, *(f"{service}.env" for service in ENV_FILES)):
        raw = migrate.read_input(source, relative, 65_536)
        info = (source / relative).stat()
        demand(info.st_uid == os.getuid(), "CONFIGURATION_OWNER_REQUIRED")
        if relative.endswith((".env", "key.pem")):
            demand(info.st_mode & 0o077 == 0, "PRIVATE_CREDENTIAL_FILE_REQUIRED")
        if relative.endswith(".env"):
            environment_values(raw, release["environment"], relative[:-4], jobs)


def snapshot_configuration(source, destination, release, jobs, compose):
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
            environment_values(raw, release["environment"], relative[:-4], jobs)
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


def snapshot_bundle(source, destination, release, jobs):
    destination.mkdir(mode=0o700)
    migrate.write_json(destination, "release.candidate.json", release)
    for name, info in jobs.items():
        (destination / "jobs").mkdir(mode=0o700, exist_ok=True)
        (destination / "schema").mkdir(mode=0o700, exist_ok=True)
        migrate.write_json(destination / "jobs", f"{name}.json", info["job"])
        path = destination / f"schema/{name}.json"
        path.write_bytes(info["schema"]); path.chmod(0o600)
    if release["environment"] == "production":
        for relative in ("staging/acceptance.json", "recovery.json", *(f"staging/{name}/{file}" for name in jobs for file in ("database-receipt.json", "job-outcome.json"))):
            path = destination / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(migrate.read_input(source, relative)); path.chmod(0o600)
    copied_release, copied_jobs = migrate.make_plan(destination)
    demand(copied_release == release and copied_jobs == jobs, "MIGRATION_SNAPSHOT_MISMATCH")


def compose_command(snapshot, environment):
    return ["docker", "compose", "--env-file", "/dev/null", "--project-directory", str(snapshot),
            "--project-name", f"lash-her-{environment}", "-f", str(snapshot / "compose.yaml")]


def runtime_environment(release, snapshot):
    return {**SAFE_ENV, "APP_ENV": release["environment"], "RELEASE_DIR": str(snapshot),
            **{key: release["artifacts"][artifact]["image"] for key, artifact in (
                ("GATEWAY_IMAGE", "gateway"), ("COURSE_RUNTIME_IMAGE", "courseRuntime"), ("COURSE_MIGRATION_IMAGE", "courseMigration"),
                ("COMMUNITY_RUNTIME_IMAGE", "communityRuntime"), ("COMMUNITY_MIGRATION_IMAGE", "communityMigration"))}}


def configuration_container(arguments):
    name = "lash-config-" + uuid4().hex
    try:
        return command([*arguments[:2], "--name", name, *arguments[2:]], SAFE_ENV)
    finally:
        subprocess.run(["docker", "rm", "--force", name], env=SAFE_ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        remaining = command(["docker", "container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.ID}}"], SAFE_ENV)
        demand(not remaining, "CONFIGURATION_CONTAINER_CLEANUP_UNVERIFIED")


def preflight(release, snapshot, jobs, pull=True):
    demand(type(pull) is bool, "EXPLICIT_IMAGE_PREFLIGHT_MODE_REQUIRED")
    env = runtime_environment(release, snapshot)
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
            expected = {"NODE_ENV": "production", "PORT": "4003" if service == "course-media" else "4004", "NODE_OPTIONS": "--max-old-space-size=128"}
            demand(model["services"][service].get("environment") == expected, "WORKER_PUBLIC_OVERRIDES_REFUSED")
        values = {**environment_values(migrate.read_input(snapshot, f"{service}.env", 65_536), release["environment"], service,
                                      jobs),
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


def check_containers(release, snapshot):
    env = runtime_environment(release, snapshot)
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


def execute(bundle, configuration, results, compose_file, apply=False, confirmation=None, lock_path=Path("/run/lock/lash-her-release.lock"), before_frontend_migration=None, after_runtime_ready=None):
    release, jobs, plan, compose = make_plan(bundle, configuration, compose_file)
    if not apply:
        return plan
    demand(confirmation == f'{release["environment"]}/{release["releaseId"]}', "EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
    demand(after_runtime_ready is None or callable(after_runtime_ready), "RUNTIME_CONTINUATION_REQUIRED")
    assert_host(plan)
    migrate.private_directory(results)
    for directory in (results.resolve(), configuration.resolve(), bundle.resolve()):
        demand(not any((parent / ".git").exists() for parent in (directory, *directory.parents)), "PRIVATE_RUNTIME_OUTSIDE_CHECKOUT_REQUIRED")
        demand("," not in str(directory), "MOUNT_PATH_REFUSED")
    attempt = results / f'runtime-{release["releaseId"]}'
    attempt.mkdir(mode=0o700)
    migrate.write_json(attempt, "started.json", plan)
    snapshot = attempt / "configuration"
    outcome = {"status": "FAILED_REQUIRES_REVIEW", "environment": release["environment"], "releaseId": release["releaseId"],
               "trafficAuthorized": False, "frontendPromotionAuthorized": False, "releaseAccepted": False,
               "realVercelOidcVerified": False, "externalIngressVerified": False, "phase": "configuration-preflight"}
    outcome.update(migrate.contract_identity(release))

    def start_runtime(migration_attempt, verified_release, database_outcome):
        # Invoked only after durable database success, while migrate.execute
        # holds the release/watchdog lock. No second approval step is needed.
        try:
            demand(verified_release == release and database_outcome.get("status") == "DATABASES_VERIFIED", "DATABASE_STAGE_BINDING_REFUSED")
            migrate.require_contract_identity(release, database_outcome)
            outcome["phase"] = "runtime-startup"
            prefix, env = compose_command(snapshot, release["environment"]), runtime_environment(release, snapshot)
            for stage in STAGES:
                outcome["phase"] = "start-" + "+".join(stage)
                command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "90", *stage], env, 120)
            outcome["phase"] = "runtime-boundary-probes"
            probe = json.loads(command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], env, 30))
            demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and isinstance(probe.get("checks"), list)
                   and len(probe["checks"]) == 5 and set(probe["checks"]) == PROBE_CHECKS, "RUNTIME_BOUNDARY_CHECKS_REQUIRED")
            outcome["containers"] = check_containers(release, snapshot)
            outcome["boundaryChecks"] = probe["checks"]
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
            try:
                migrate.suspend_runtime(release["environment"], SAFE_ENV)
                outcome["runtimeStopped"] = True
            except BaseException:
                outcome["runtimeStopped"] = False
            raise

    try:
        immutable_bundle = attempt / "migration-input"
        snapshot_bundle(bundle, immutable_bundle, release, jobs)
        snapshot_configuration(configuration, snapshot, release, jobs, compose)
        checked_release, checked_jobs, checked_plan, _ = make_plan(immutable_bundle, snapshot, snapshot / "compose.yaml")
        demand(checked_release == release and checked_jobs == jobs and checked_plan == plan, "RUNTIME_CONFIGURATION_CHANGED")
        preflight(release, snapshot, jobs)
        outcome["phase"] = "migrations"
        return migrate.execute(immutable_bundle, results, True, confirmation, lock_path, after_migrations=start_runtime, docker_env=SAFE_ENV,
                               before_frontend_migration=before_frontend_migration)
    except BaseException as error:
        outcome["status"] = "FAILED_REQUIRES_REVIEW"
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "RUNTIME_OR_INPUT_FAILURE"
        migrate.write_json(attempt, "runtime-outcome.json" if not (attempt / "runtime-outcome.json").exists() else "runtime-failure.json", outcome)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("results", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    def interrupted(signum, _frame):
        raise SystemExit(130 if signum == signal.SIGINT else 143)
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        print(json.dumps(execute(args.bundle, args.configuration, args.results, Path(__file__).parents[1] / "compose.yaml", args.apply, args.confirm)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print('{"status":"API_RELEASE_REFUSED","trafficAuthorized":false,"reviewRequired":true}', file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
