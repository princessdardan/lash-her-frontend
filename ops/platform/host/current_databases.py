"""Run selected images' current-state checks. No API migration entrypoint exists here."""
import json
import os
from pathlib import Path
import re
import subprocess
from uuid import uuid4

import migrate
import release as runtime
import staging_state

demand = migrate.demand


def _run(args, environment, payload=None, timeout=120):
    return subprocess.run(args, env=environment, input=payload, capture_output=True, timeout=timeout)


def safe_diagnostics(result):
    markers = []
    for raw in (result.stdout, result.stderr):
        for line in raw.decode("utf8", errors="replace").splitlines():
            if line == "FRONTEND_PACKAGED_SOURCE_REFUSED":
                markers.append(line)
            try:
                value = json.loads(line)
            except (ValueError, TypeError):
                continue
            if isinstance(value, dict):
                for key in ("status", "code"):
                    marker = value.get(key)
                    if isinstance(marker, str) and re.fullmatch(r"(?:FRONTEND_|CURRENT_)[A-Z0-9_]{1,90}", marker):
                        markers.append(marker)
    return {"exitCode": result.returncode, "markers": sorted(set(markers))}


def check_all(selected, jobs, output, credentials, checker, checker_sha256, environment=None):
    """Read-only DB inspection; credentials go only to their individual one-shot.

    Frontend reuses its qualified verify-current-only entrypoint. API images run
    the separate read-only checker over private stdin, never the migration CLI.
    Images must already be cached by the reviewed parent.
    """
    demand(selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"},
           "CURRENT_DATABASES_THREE_STAGING_TARGETS_REQUIRED")
    for info in jobs.values():
        migrate.require_contract_identity(selected, info["job"])
    demand(set(credentials) == set(jobs) and all(isinstance(value, str) and value for value in credentials.values()),
           "CURRENT_DATABASES_NAMED_PRIVATE_CREDENTIALS_REQUIRED")
    demand(jobs["frontend"]["job"]["target"].get("approvedPendingTags") == [],
           "CURRENT_DATABASES_FRONTEND_CURRENT_ONLY_REQUIRED")
    raw_checker = migrate.read_input(checker.parent, checker.name, 65_536)
    demand(migrate.file_hash(raw_checker) == checker_sha256, "CURRENT_DATABASES_CHECKER_HASH_MISMATCH")
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and "," not in str(output.resolve()), "CURRENT_DATABASES_FRESH_PRIVATE_OUTPUT_REQUIRED")
    base = dict(runtime.SAFE_ENV) if environment is None else dict(environment)
    demand(set(base).issubset({"PATH", "HOME", "DOCKER_CONTEXT", "DOCKER_HOST"})
           and ("DOCKER_HOST" not in base or base["DOCKER_HOST"].startswith("unix:///")), "CURRENT_DATABASES_LOCAL_ENGINE_REQUIRED")
    output.mkdir(mode=0o700)
    uid, gid = (65532, 65532) if os.getuid() == 0 else (os.getuid(), os.getgid())
    records = {}
    outcome = {"status": "CURRENT_DATABASES_REQUIRES_REVIEW", "releaseId": selected["releaseId"], "environment": "staging",
               "checkerSha256": checker_sha256, "migrationsExecuted": False, "trafficAuthorized": False}
    outcome.update(migrate.contract_identity(selected))
    try:
        for name in ("frontend", "course", "community"):
            info = jobs[name]
            inputs, receipts = output / (name + "-input"), output / name
            inputs.mkdir(mode=0o700); receipts.mkdir(mode=0o700)
            migrate.write_json(inputs, "job.json", info["job"])
            (inputs / "schema.json").write_bytes(info["schema"])
            if name == "frontend":
                migrate.write_json(inputs, "candidate.json", selected)
            else:
                (inputs / "current.mjs").write_bytes(raw_checker)
            for file in inputs.iterdir():
                file.chmod(0o400)
                if os.getuid() == 0:
                    os.chown(file, uid, gid)
            if os.getuid() == 0:
                os.chown(inputs, uid, gid); os.chown(receipts, uid, gid)
            container = "lash-current-" + name + "-" + uuid4().hex
            environment = dict(base)
            payload = None
            if name == "frontend":
                args = migrate.docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), "staging", selected["releaseId"],
                                                f"{uid}:{gid}", container, frontend=True)
                args[2:2] = ["--pull", "never", "--platform", "linux/amd64"]
                environment["FRONTEND_STAGING_MIGRATION_DATABASE_URL"] = credentials[name]
            else:
                args = ["docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64", "--name", container, "--network", "bridge", "--interactive",
                        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", f"{uid}:{gid}",
                        "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
                        "--mount", f"type=bind,src={inputs.resolve()},dst=/check/input,readonly",
                        "--entrypoint", "node", info["image"], "/check/input/current.mjs", "/check/input/job.json", "/check/input/schema.json"]
                payload = json.dumps({"connectionUrl": credentials[name]}).encode()
            outcome["phase"] = name + "-read-only-current"
            try:
                result = _run(args, environment, payload)
                if result.returncode:
                    for name_of_stream, raw in (("stdout", result.stdout), ("stderr", result.stderr)):
                        file = receipts / ("private-" + name_of_stream + ".bin")
                        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, "wb") as stream:
                            stream.write(raw)
                    outcome["failureDiagnostics"] = safe_diagnostics(result)
                demand(result.returncode == 0, "CURRENT_DATABASES_CONTAINER_CHECK_FAILED")
                if name == "frontend":
                    record = migrate.read_json(receipts, "database-receipt.json")
                    terminal = migrate.read_json(receipts, "job-outcome.json")
                    migrate.require_contract_identity(selected, record, terminal)
                    demand(record.get("status") == terminal.get("status") == "DATABASE_VERIFIED"
                           and record.get("readOnlyVerified") is True and terminal.get("readOnlyVerified") is True
                           and record.get("applied") == [] and record.get("migrationMode") == "verify-current-only"
                           and record.get("releaseId") == selected["releaseId"] and record.get("environment") == "staging"
                           and record.get("schemaVerified") is True and record.get("runtimeRoleVerified") is True
                           and all(record.get(key) == terminal.get(key) == info["job"][key] for key in
                                   ("sourceCommit", "migrationImageDigest", "schemaBaselineSha256", "sqlArtifactSha256", "contractManifestSha256"))
                           and record.get("target") == {key: info["job"]["target"][key] for key in ("host", "port", "database", "user", "serverMajor")},
                           "CURRENT_DATABASES_FRONTEND_READ_ONLY_PROOF_REQUIRED")
                else:
                    record = json.loads(result.stdout)
                    migrate.require_contract_identity(selected, record)
                    demand(record.get("status") == "CURRENT_API_DATABASE_READ_ONLY_PASS" and record.get("environment") == "staging"
                           and record.get("migrationsExecuted") is False and record.get("pendingTags") == []
                           and record.get("service") == info["service"] and type(record.get("appliedCount")) is int and record["appliedCount"] > 0
                           and record.get("transportVerifier") == "selected-image/hasVerifiedMigrationTransport"
                           and record.get("checkerSha256") == checker_sha256
                           and record.get("manifestSha256") == migrate.file_hash(migrate.read_input(inputs, "job.json"))
                           and record.get("schemaBaselineSha256") == info["job"]["schemaBaselineSha256"]
                           and record.get("artifactSha256") == info["job"]["target"]["artifactSha256"]
                           and record.get("target") == {key: info["job"]["target"][key] for key in ("host", "port", "database", "user", "serverMajor")},
                           "CURRENT_DATABASES_API_READ_ONLY_PROOF_REQUIRED")
                    migrate.write_json(receipts, "database-receipt.json", record)
                records[name] = {"image": info["image"], "receiptSha256": migrate.file_hash(migrate.read_input(receipts, "database-receipt.json"))}
            finally:
                _run(["docker", "rm", "--force", container], base, timeout=20)
                remaining = _run(["docker", "container", "ls", "--all", "--filter", f"name=^/{container}$", "--format", "{{.ID}}"], base, timeout=20)
                demand(remaining.returncode == 0 and not remaining.stdout.strip(), "CURRENT_DATABASES_CONTAINER_CLEANUP_UNVERIFIED")
        outcome.update(status="CURRENT_DATABASES_READ_ONLY_VERIFIED", phase="completed", databases=records)
        return outcome
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", code) else "CURRENT_DATABASES_READ_ONLY_CHECK_FAILED"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "current-databases-outcome.json", outcome)
