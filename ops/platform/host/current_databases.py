"""Run selected images' current-state checks. No API migration entrypoint exists here."""
import copy
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



_PROFILED_PROOF_AUTHORITY = object()


class ProfiledCurrentDatabaseProof:
    """Process-local result from the actual current-only checker, not JSON authority."""
    def __init__(self, authority, scope, selected, jobs, output, outcome):
        demand(authority is _PROFILED_PROOF_AUTHORITY, "PROFILED_CURRENT_DATABASE_PRODUCER_REQUIRED")
        self._scope, self._output = scope, output
        self._selected, self._jobs = copy.deepcopy(selected), copy.deepcopy(jobs)
        self._outcome = copy.deepcopy(outcome)
        self._sha256 = migrate.file_hash(migrate.read_input(output, "current-databases-outcome.json"))


def read_profiled_current_proof(proof, scope, selected, jobs, *, expected_profile):
    expected = migrate.profile_context(expected_profile)
    demand(expected is not None and type(proof) is ProfiledCurrentDatabaseProof and proof._scope is scope
           and proof._selected == selected and proof._jobs == jobs, "PROFILED_CURRENT_DATABASE_PROOF_REQUIRED")
    scope.require_release(selected, jobs)
    scope.require_frontend(selected, jobs["frontend"])
    outcome = migrate.read_json(proof._output, "current-databases-outcome.json", expected_profile=expected)
    migrate.require_profile(expected, outcome)
    raw = migrate.read_input(proof._output, "current-databases-outcome.json")
    demand(migrate.file_hash(raw) == proof._sha256 and outcome == proof._outcome
           and outcome.get("status") == "CURRENT_DATABASES_READ_ONLY_VERIFIED"
           and outcome.get("phase") == "completed" and outcome.get("migrationsExecuted") is False
           and outcome.get("frontendSqlApplied") is False and outcome.get("trafficAuthorized") is False
           and outcome.get("candidateSha256") == scope.candidate_sha256
           and outcome.get("releaseId") == selected["releaseId"]
           and set(outcome.get("databases", {})) == set(jobs), "PROFILED_CURRENT_DATABASE_PROOF_CHANGED")
    for name, identity in outcome["databases"].items():
        record = migrate.read_input(proof._output / name, "database-receipt.json")
        demand(identity.get("image") == jobs[name]["image"] and identity.get("receiptSha256") == migrate.file_hash(record),
               "PROFILED_CURRENT_DATABASE_RECEIPT_CHANGED")
        if name == "frontend":
            frontend_raw, started_raw = scope.frontend_current_receipt_bytes()
            demand(record == frontend_raw and migrate.read_input(proof._output / name, "frontend-continuation-started.json") == started_raw,
                   "PROFILED_CURRENT_FRONTEND_PROOF_CHANGED")
        else:
            job_raw = scope.api_job_bytes(name)
            receipt = migrate.read_json(proof._output / name, "database-receipt.json", expected_profile=expected)
            demand(receipt.get("manifestSha256") == migrate.file_hash(job_raw),
                   "PROFILED_CURRENT_DATABASE_JOB_BYTES_CHANGED")
    scope.verify()
    return proof._output, outcome


_CERTIFICATION_PROOF_AUTHORITY = object()


class CertificationCurrentDatabaseProof:
    """Process-local API-current proof produced inside a certification scope."""
    def __init__(self, authority, scope, selected, jobs, output, outcome):
        demand(authority is _CERTIFICATION_PROOF_AUTHORITY, "P2_CERTIFICATION_API_PRODUCER_REQUIRED")
        self._scope, self._output = scope, output
        self._selected, self._jobs = copy.deepcopy(selected), copy.deepcopy(jobs)
        self._outcome = copy.deepcopy(outcome)
        self._sha256 = migrate.file_hash(migrate.read_input(output, "certification-current-databases-outcome.json"))


# These reviewed modules only correct the managed Neon role reads in the
# selected staging release's pre-existing API migration images.
_FIRST_OWNER_ROLE_POLICIES = {
    "course": ("95963723a4955cc42b845d0aaf1152c2e2ac8535", "b3db0c423e6aa40e3b5af875621c1447eb994969",
               "c653df952440a765f67cb09028c2479923c112e1da10c97ed2a15e5ad224f7ea"),
    "community": ("8141533249f6c59a59e67e8663907c2f108c1d34", "0a9d8f6c7f856ebeeaa076c8e23a0dfc0b0a8e8c",
                  "92c3fdbad1851de64037089089ebd409603d1c9fd31ba45eb3e7529df5024f15"),
}


def _first_owner_role_policies(scope, selected, jobs):
    plan = scope.certification_plan
    action = plan.get("scopedAction", {})
    if not ("supplementalOperatorCommit" in plan and plan.get("mode") == "interactive-browser"
            and action.get("stage") == "identity" and {"firstOwnerDiscovery", "firstOwner"}.intersection(action)):
        return {}
    if selected.get("releaseId") != "p1-43067769975-1":
        return {}
    demand(selected.get("environment") == "staging" and "replacementRelease" in plan
           and scope.candidate_sha256 == "eefe3d6e41d94a1d885a1d9198bfbac381d4227ee7dbd5a6dbe7ee74602280ba",
           "P2_CERTIFICATION_STAGING_ROLE_POLICY_SCOPE_REFUSED")
    directory = scope._profiled_broker.results / "certification-readonly-api-role-policy"
    migrate.private_directory(directory)
    policies = {}
    for name, (image_source, policy_source, digest) in _FIRST_OWNER_ROLE_POLICIES.items():
        demand(jobs[name]["job"]["sourceCommit"] == selected["sources"][name]["commit"] == image_source,
               "P2_CERTIFICATION_STAGING_ROLE_POLICY_SOURCE_REFUSED")
        raw = migrate.read_input(directory, name + ".mjs", 65_536)
        demand(migrate.file_hash(raw) == digest, "P2_CERTIFICATION_STAGING_ROLE_POLICY_BYTES_CHANGED")
        policies[name] = (raw, {"sourceCommit": policy_source, "sha256": digest})
    return policies


def read_certification_api_proof(proof, scope, selected, jobs, *, expected_profile):
    """Re-read a certification API proof while its exact held scope remains live."""
    from p2_certification_parent import P2CertificationScope
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE

    expected = migrate.profile_context(expected_profile)
    fixed = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    demand(expected == fixed and type(scope) is P2CertificationScope
           and type(proof) is CertificationCurrentDatabaseProof and proof._scope is scope
           and proof._selected == selected and proof._jobs == jobs,
           "P2_CERTIFICATION_API_PROOF_REQUIRED")
    scope.require_release(selected, jobs)
    scope.require_frontend(selected, jobs["frontend"])
    raw = migrate.read_input(proof._output, "certification-current-databases-outcome.json")
    outcome = migrate.read_json(proof._output, "certification-current-databases-outcome.json",
                                expected_profile=expected)
    migrate.require_profile(expected, outcome)
    demand(migrate.file_hash(raw) == proof._sha256 and outcome == proof._outcome
           and outcome.get("status") == "P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED"
           and outcome.get("phase") == "completed" and outcome.get("migrationsExecuted") is False
           and outcome.get("frontendSqlApplied") is False and outcome.get("trafficAuthorized") is False
           and outcome.get("candidateSha256") == scope.candidate_sha256
           and outcome.get("releaseId") == selected["releaseId"]
           and outcome.get("certificationActionId") == scope.certification_plan["certificationActionId"]
           and set(outcome.get("databases", {})) == {"course", "community"},
           "P2_CERTIFICATION_API_PROOF_CHANGED")
    pins = scope.certification_plan.get("apiJobSha256")
    demand(type(pins) is dict and set(pins) == {"course", "community"},
           "P2_CERTIFICATION_API_JOB_PINS_REQUIRED")
    policies = _first_owner_role_policies(scope, selected, jobs)
    for name, identity in outcome["databases"].items():
        job_raw = migrate.read_input(proof._output / (name + "-input"), "job.json")
        if name in policies:
            raw, pin = policies[name]
            demand(identity.get("readOnlyRolePolicy") == pin and
                   migrate.read_input(proof._output / (name + "-input"), "operator-role-policy.mjs") == raw,
                   "P2_CERTIFICATION_STAGING_ROLE_POLICY_BYTES_CHANGED")
        else:
            demand("readOnlyRolePolicy" not in identity, "P2_CERTIFICATION_STAGING_ROLE_POLICY_SCOPE_REFUSED")
        receipt_raw = migrate.read_input(proof._output / name, "database-receipt.json")
        receipt = migrate.read_json(proof._output / name, "database-receipt.json", expected_profile=expected)
        demand(migrate.file_hash(job_raw) == pins[name]
               and receipt.get("manifestSha256") == pins[name]
               and identity.get("image") == jobs[name]["image"]
               and identity.get("jobSha256") == pins[name]
               and identity.get("receiptSha256") == migrate.file_hash(receipt_raw),
               "P2_CERTIFICATION_API_RECEIPT_CHANGED")
    scope.require_frontend(selected, jobs["frontend"])
    scope.verify()
    return proof._output, outcome


def check_certification_apis(selected, jobs, output, credentials, checker, checker_sha256,
                             api_job_bytes, environment=None, *, expected_profile,
                             _certification_scope):
    """Check Course and Community through their selected images without FE SQL.

    The exact certification scope owns the process boundary and its already-held
    frontend/native witness. This function never starts a frontend runner and
    never invokes an API migration entrypoint.
    """
    from p2_certification_parent import P2CertificationScope
    from qualification_target_profile import (STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE,
                                                decode_qualification_target_json)

    expected = migrate.profile_context(expected_profile)
    fixed = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    scope = _certification_scope
    demand(expected == fixed and type(scope) is P2CertificationScope,
           "P2_CERTIFICATION_API_SCOPE_REQUIRED")
    scope.require_release(selected, jobs)
    scope.require_frontend(selected, jobs["frontend"])
    migrate.candidate_profile(selected, expected)
    demand(selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"},
           "P2_CERTIFICATION_THREE_STAGING_TARGETS_REQUIRED")
    for info in jobs.values():
        migrate.require_contract_identity(selected, info["job"])
        migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    frontend_target = jobs["frontend"]["job"]["target"]
    original_tags = frontend_target.get("approvedPendingTags")
    if "replacementRelease" in scope.certification_plan:
        # The exact held scope verified that the original apply-forward job
        # and current database agree. The API checker still runs read-only.
        demand(frontend_target.get("allowEmptyBootstrap") is True
               and type(original_tags) is list and bool(original_tags),
               "P2_CERTIFICATION_FRONTEND_REPLACEMENT_JOB_REQUIRED")
    else:
        demand(original_tags == [], "P2_CERTIFICATION_FRONTEND_CURRENT_ONLY_REQUIRED")
    demand(set(credentials) == {"course", "community"}
           and all(isinstance(value, str) and value for value in credentials.values()),
           "P2_CERTIFICATION_NAMED_PRIVATE_CREDENTIALS_REQUIRED")
    pins = scope.certification_plan.get("apiJobSha256")
    demand(type(pins) is dict and set(pins) == {"course", "community"}
           and set(api_job_bytes) == {"course", "community"},
           "P2_CERTIFICATION_API_JOB_PINS_REQUIRED")
    for name in ("course", "community"):
        raw = api_job_bytes[name]
        demand(type(raw) is bytes and 0 < len(raw) <= 2_000_000 and migrate.file_hash(raw) == pins[name],
               "P2_CERTIFICATION_API_JOB_BYTES_CHANGED")
        decoded = decode_qualification_target_json(raw, "carrier")
        demand(decoded == jobs[name]["job"], "P2_CERTIFICATION_API_JOB_BYTES_CHANGED")
    policies = _first_owner_role_policies(scope, selected, jobs)
    raw_checker = migrate.read_input(checker.parent, checker.name, 65_536)
    demand(migrate.file_hash(raw_checker) == checker_sha256,
           "P2_CERTIFICATION_DATABASE_CHECKER_HASH_MISMATCH")
    staging_state.outside_checkout(output.parent)
    demand(not output.exists() and "," not in str(output.resolve()),
           "P2_CERTIFICATION_FRESH_PRIVATE_OUTPUT_REQUIRED")
    base = dict(runtime.SAFE_ENV) if environment is None else dict(environment)
    demand(set(base).issubset({"PATH", "HOME", "DOCKER_CONTEXT", "DOCKER_HOST"})
           and ("DOCKER_HOST" not in base or base["DOCKER_HOST"].startswith("unix:///")),
           "P2_CERTIFICATION_LOCAL_ENGINE_REQUIRED")
    output.mkdir(mode=0o700)
    uid, gid = (65532, 65532) if os.getuid() == 0 else (os.getuid(), os.getgid())
    records = {}
    outcome = {
        "version": 2,
        "qualificationTargetProfile": expected,
        "status": "P2_CERTIFICATION_API_DATABASES_REQUIRES_REVIEW",
        "phase": "initial",
        "releaseId": selected["releaseId"],
        "environment": "staging",
        "certificationActionId": scope.certification_plan["certificationActionId"],
        "candidateSha256": scope.candidate_sha256,
        "checkerSha256": checker_sha256,
        "migrationsExecuted": False,
        "frontendSqlApplied": False,
        "trafficAuthorized": False,
    }
    outcome.update(migrate.contract_identity(selected))
    try:
        for name in ("course", "community"):
            scope.require_frontend(selected, jobs["frontend"])
            info = jobs[name]
            inputs, receipts = output / (name + "-input"), output / name
            inputs.mkdir(mode=0o700); receipts.mkdir(mode=0o700)
            migrate.write_exact_bytes(inputs, "job.json", api_job_bytes[name])
            (inputs / "schema.json").write_bytes(info["schema"])
            (inputs / "current.mjs").write_bytes(raw_checker)
            policy = policies.get(name)
            if policy is not None:
                (inputs / "operator-role-policy.mjs").write_bytes(policy[0])
            for file in inputs.iterdir():
                file.chmod(0o400)
                if os.getuid() == 0:
                    os.chown(file, uid, gid)
            if os.getuid() == 0:
                os.chown(inputs, uid, gid)
            container = "lash-p2-certification-api-check-" + name + "-" + uuid4().hex
            args = ["docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64",
                    "--name", container, "--network", "bridge", "--interactive", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                    "--user", f"{uid}:{gid}", "--memory", "256m", "--cpus", "0.5",
                    "--pids-limit", "64",
                    "--mount", f"type=bind,src={inputs.resolve()},dst=/check/input,readonly"]
            if policy is not None:
                args += ["--mount", f"type=bind,src={inputs / 'operator-role-policy.mjs'},"
                         "dst=/app/dist-migration/src/db/operator-migration.js,readonly"]
            args += ["--entrypoint", "node", info["image"], "/check/input/current.mjs",
                     "--profiled-current", "/check/input/job.json", "/check/input/schema.json"]
            payload = json.dumps({"connectionUrl": credentials[name]}).encode()
            outcome["phase"] = name + "-read-only-current"
            try:
                result = scope.run(args, env=base, input=payload, capture_output=True, timeout=120)
                if result.returncode:
                    for stream_name, raw in (("stdout", result.stdout), ("stderr", result.stderr)):
                        file = receipts / ("private-" + stream_name + ".bin")
                        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, "wb") as stream:
                            stream.write(raw)
                    outcome["failureDiagnostics"] = safe_diagnostics(result)
                demand(result.returncode == 0, "P2_CERTIFICATION_DATABASE_CONTAINER_CHECK_FAILED")
                record = decode_qualification_target_json(result.stdout, "carrier")
                migrate.require_profile(expected, record)
                demand(type(record.get("version")) is int and record["version"] == 2
                       and type(record.get("checks")) is list
                       and "selected-image-operator-role-policy" in record["checks"],
                       "P2_CERTIFICATION_NATIVE_ROLE_POLICY_PROOF_REQUIRED")
                migrate.require_contract_identity(selected, record)
                demand(record.get("status") == "CURRENT_API_DATABASE_READ_ONLY_PASS"
                       and record.get("environment") == "staging"
                       and record.get("migrationsExecuted") is False and record.get("pendingTags") == []
                       and record.get("service") == info["service"]
                       and type(record.get("appliedCount")) is int and record["appliedCount"] > 0
                       and record.get("transportVerifier") == "selected-image/hasVerifiedMigrationTransport"
                       and record.get("checkerSha256") == checker_sha256
                       and record.get("manifestSha256") == pins[name]
                       and record.get("schemaBaselineSha256") == info["job"]["schemaBaselineSha256"]
                       and record.get("artifactSha256") == info["job"]["target"]["artifactSha256"]
                       and record.get("target") == {key: info["job"]["target"][key]
                                                       for key in ("host", "port", "database", "user", "serverMajor")},
                       "P2_CERTIFICATION_API_READ_ONLY_PROOF_REQUIRED")
                migrate.write_exact_bytes(receipts, "database-receipt.json", result.stdout)
                records[name] = {"image": info["image"], "jobSha256": pins[name],
                                 "receiptSha256": migrate.file_hash(result.stdout)}
                if policy is not None:
                    records[name]["readOnlyRolePolicy"] = policy[1]
            finally:
                scope.run(["docker", "rm", "--force", container], env=base,
                          capture_output=True, timeout=20)
                remaining = scope.run(["docker", "container", "ls", "--all", "--filter",
                                       f"name=^/{container}$", "--format", "{{.ID}}"],
                                      env=base, capture_output=True, timeout=20)
                demand(remaining.returncode == 0 and not remaining.stdout.strip(),
                       "P2_CERTIFICATION_DATABASE_CONTAINER_CLEANUP_UNVERIFIED")
        scope.require_frontend(selected, jobs["frontend"])
        scope.verify()
        outcome.update(status="P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED",
                       phase="completed", databases=records)
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = (code if isinstance(error, ValueError)
                                  and re.fullmatch(r"[A-Z0-9_]{1,100}", code)
                                  else "P2_CERTIFICATION_API_DATABASES_READ_ONLY_CHECK_FAILED")
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "certification-current-databases-outcome.json", outcome)
    return CertificationCurrentDatabaseProof(_CERTIFICATION_PROOF_AUTHORITY, scope, selected, jobs, output, outcome)


def check_all(selected, jobs, output, credentials, checker, checker_sha256, environment=None, *, expected_profile=None,
              _profiled_current_scope=None):
    """Read-only DB inspection; credentials go only to their individual one-shot.

    Frontend reuses its qualified verify-current-only entrypoint. API images run
    the separate read-only checker over private stdin, never the migration CLI.
    Images must already be cached by the reviewed parent.
    """
    expected = migrate.profile_context(expected_profile)
    if _profiled_current_scope is not None:
        from p2_profiled_current_scope import P2ProfiledCurrentScope
        demand(expected is not None and type(_profiled_current_scope) is P2ProfiledCurrentScope,
               "PROFILED_CURRENT_DATABASE_SCOPE_REQUIRED")
        _profiled_current_scope.require_release(selected, jobs)
        demand("frontend" in jobs, "PROFILED_CURRENT_FRONTEND_PROOF_REQUIRED")
        _profiled_current_scope.require_frontend(selected, jobs["frontend"])
    migrate.candidate_profile(selected, expected)
    demand(selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"},
           "CURRENT_DATABASES_THREE_STAGING_TARGETS_REQUIRED")
    for info in jobs.values():
        migrate.require_contract_identity(selected, info["job"])
        migrate.require_job_profile(expected, info["job"], frontend=info.get("frontend", False))
    credential_names = set(jobs) if _profiled_current_scope is None else {"course", "community"}
    demand(set(credentials) == credential_names and all(isinstance(value, str) and value for value in credentials.values()),
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
    if expected is not None:
        outcome.update(version=2, qualificationTargetProfile=expected)
    if _profiled_current_scope is not None:
        outcome.update(candidateSha256=_profiled_current_scope.candidate_sha256,
                       frontendSqlApplied=False, frontendProofHeld=True)

    def run(args, environment, payload=None, timeout=120):
        if _profiled_current_scope is None:
            return _run(args, environment, payload, timeout)
        return _profiled_current_scope.run(args, env=environment, input=payload, capture_output=True, timeout=timeout)

    try:
        for name in ("frontend", "course", "community"):
            info = jobs[name]
            if name == "frontend" and _profiled_current_scope is not None:
                # The original FE session already holds the migration/nonce
                # locks. Never launch a second runner or synthesize its terminal.
                outcome["phase"] = "frontend-held-current-proof"
                _profiled_current_scope.require_frontend(selected, info)
                raw, started = _profiled_current_scope.frontend_current_receipt_bytes()
                receipts = output / name
                receipts.mkdir(mode=0o700)
                migrate.write_exact_bytes(receipts, "database-receipt.json", raw)
                migrate.write_exact_bytes(receipts, "frontend-continuation-started.json", started)
                records[name] = {"image": info["image"], "receiptSha256": migrate.file_hash(raw)}
                continue
            inputs, receipts = output / (name + "-input"), output / name
            inputs.mkdir(mode=0o700); receipts.mkdir(mode=0o700)
            if _profiled_current_scope is None:
                migrate.write_json(inputs, "job.json", info["job"])
            else:
                migrate.write_exact_bytes(inputs, "job.json", _profiled_current_scope.api_job_bytes(name))
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
                os.chown(inputs, uid, gid)
                if _profiled_current_scope is None:
                    os.chown(receipts, uid, gid)
            prefix = "lash-current-" if _profiled_current_scope is None else "lash-p2-profiled-current-api-check-"
            container = prefix + name + "-" + uuid4().hex
            environment = dict(base)
            payload = None
            if name == "frontend":
                args = migrate.docker_arguments(info["image"], inputs.resolve(), receipts.resolve(), "staging", selected["releaseId"],
                                                f"{uid}:{gid}", container, frontend=True, expected_profile=expected)
                args[2:2] = ["--pull", "never", "--platform", "linux/amd64"]
                environment["FRONTEND_STAGING_MIGRATION_DATABASE_URL"] = credentials[name]
            else:
                args = ["docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64", "--name", container, "--network", "bridge", "--interactive",
                        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", f"{uid}:{gid}",
                        "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
                        "--mount", f"type=bind,src={inputs.resolve()},dst=/check/input,readonly",
                        "--entrypoint", "node", info["image"], "/check/input/current.mjs",
                        *([] if expected is None else ["--profiled-current"]), "/check/input/job.json", "/check/input/schema.json"]
                payload = json.dumps({"connectionUrl": credentials[name]}).encode()
            outcome["phase"] = name + "-read-only-current"
            try:
                result = run(args, environment, payload)
                if result.returncode:
                    for name_of_stream, raw in (("stdout", result.stdout), ("stderr", result.stderr)):
                        file = receipts / ("private-" + name_of_stream + ".bin")
                        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, "wb") as stream:
                            stream.write(raw)
                    outcome["failureDiagnostics"] = safe_diagnostics(result)
                demand(result.returncode == 0, "CURRENT_DATABASES_CONTAINER_CHECK_FAILED")
                if name == "frontend":
                    record = migrate.read_json(receipts, "database-receipt.json", expected_profile=expected)
                    terminal = migrate.read_json(receipts, "job-outcome.json", expected_profile=expected)
                    migrate.require_receipt_profile(expected, "frontend", record, terminal)
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
                    if expected is None:
                        record = json.loads(result.stdout)
                    else:
                        from qualification_target_profile import decode_qualification_target_json
                        record = decode_qualification_target_json(result.stdout, "carrier")
                    migrate.require_profile(expected, record)
                    if expected is not None:
                        demand(type(record.get("version")) is int and record["version"] == 2,
                               "QUALIFICATION_TARGET_PROFILE_REQUIRED")
                        demand(type(record.get("checks")) is list and
                               "selected-image-operator-role-policy" in record["checks"],
                               "CURRENT_DATABASES_NATIVE_ROLE_POLICY_PROOF_REQUIRED")
                    else:
                        demand(record.get("version") != 2, "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED")
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
                    if _profiled_current_scope is None:
                        migrate.write_json(receipts, "database-receipt.json", record)
                    else:
                        migrate.write_exact_bytes(receipts, "database-receipt.json", result.stdout)
                records[name] = {"image": info["image"], "receiptSha256": migrate.file_hash(migrate.read_input(receipts, "database-receipt.json"))}
            finally:
                run(["docker", "rm", "--force", container], base, timeout=20)
                remaining = run(["docker", "container", "ls", "--all", "--filter", f"name=^/{container}$", "--format", "{{.ID}}"], base, timeout=20)
                demand(remaining.returncode == 0 and not remaining.stdout.strip(), "CURRENT_DATABASES_CONTAINER_CLEANUP_UNVERIFIED")
        if _profiled_current_scope is not None:
            _profiled_current_scope.verify()
        outcome.update(status="CURRENT_DATABASES_READ_ONLY_VERIFIED", phase="completed", databases=records)
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", code) else "CURRENT_DATABASES_READ_ONLY_CHECK_FAILED"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(output, "current-databases-outcome.json", outcome)
    if _profiled_current_scope is not None:
        return ProfiledCurrentDatabaseProof(_PROFILED_PROOF_AUTHORITY, _profiled_current_scope, selected, jobs, output, outcome)
    return outcome
