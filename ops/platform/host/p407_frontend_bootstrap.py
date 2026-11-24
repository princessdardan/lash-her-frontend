#!/usr/bin/env python3
"""Bootstrap and independently verify only the isolated P4-07 Lightsail Frontend DB."""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path

import migrate
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json

PROFILE = STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
HOST_ROOT = Path("/var/lib/lash-her/p4-07/postgres")
RELEASE_LOCK = Path("/run/lock/lash-her-release.lock")
CONTAINER = "lash-her-p4-07-postgres"
NETWORK = "lash-her-p4-07-db"
RUNNER = "lash-her-p4-07-frontend-migration"
RUNNER_UID = 65532
HBA_SHA256 = "496079c3d66ced0951bff1b8ce64c996dd3bb3f4a69af0a1993a845b896e0dfb"
TARGET = {
    "host": "p4-07-db.lashher.com", "port": 5432, "database": "lash_her_p407_frontend",
    "user": "lash_her_p407_frontend_migration", "runtimeRole": "lash_her_p407_frontend_runtime",
    "serverMajor": 18,
}
WITNESS_NAMES = ("databaseOid", "migrationRoleOid", "runtimeRoleOid", "systemIdentifier")
REFUSED = "P407_ISOLATED_FRONTEND_REFUSED"


def expect(condition):
    migrate.demand(condition, REFUSED)


def command(*args, stdin=None, private_env=None, seconds=20):
    # The operator sends an isolated URL only on stdin. Never copy stderr,
    # argv, environment, or credential input into an operator receipt.
    result = subprocess.run(args, input=stdin, capture_output=True, timeout=seconds, check=False,
                            env={"PATH": os.defpath + ":/usr/local/bin", **(private_env or {})})
    expect(result.returncode == 0)
    return result.stdout


def private_path(path):
    expect(path.is_absolute() and path.resolve(strict=True) == path and "," not in str(path) and
           all(not (parent / ".git").exists() for parent in (path, *path.parents)))
    migrate.private_directory(path)


def frontend_bundle(bundle):
    release = migrate.read_json(bundle, "release.candidate.json", expected_profile=PROFILE)
    approval = release["sourceApproval"]
    expect(release["environment"] == "staging" and
           re.fullmatch(r"p4-07-[a-z0-9-]{1,58}", release["releaseId"]) and
           release["integration"]["state"] == "passed" and
           approval["mode"] == "single-operator-dispatch" and approval["operatorGithubUserId"] == "8996309")
    for service, repository in (("frontend", "lash-her-frontend"), ("course", "lash-her-course-api"),
                                ("community", "lash-her-community-api")):
        source = release["sources"][service]
        expect(source["repository"] == f"https://github.com/princessdardan/{repository}.git" and
               migrate.source_commit(source["commit"]) and source["requiredChecks"] == "passed")
    # Only Frontend is selected. API artifact identities stay in the reviewed
    # candidate, but neither API database is addressed by these bundles.
    return release, migrate.frontend_plan(bundle, release, expected_profile=PROFILE)


def checked_inputs(bootstrap_bundle, current_bundle, backup_sha):
    release, bootstrap = frontend_bundle(bootstrap_bundle)
    current_release, current = frontend_bundle(current_bundle)
    job, read_job = bootstrap["job"], current["job"]
    target, read_target = job["target"], read_job["target"]
    expect(release["releaseId"] == current_release["releaseId"] and
           release["environment"] == current_release["environment"] == "staging" and
           release["releaseId"].startswith("p4-07-") and
           job["sourceCommit"] != read_job["sourceCommit"] and bootstrap["image"] != current["image"] and
           all(target.get(key) == value for key, value in TARGET.items()) and
           target["allowEmptyBootstrap"] is True and bool(target["approvedPendingTags"]) and
           read_target == (target | {"allowEmptyBootstrap": False, "approvedPendingTags": []}) and
           read_job == (job | {"target": read_target, "sourceCommit": read_job["sourceCommit"],
                               "migrationImageDigest": read_job["migrationImageDigest"]}) and
           job["recoveryRef"] == f"p4-07/lightsail/empty-schema/{backup_sha}")
    return release, bootstrap, current_release, current


def verify_host():
    expect(os.getuid() == 0 and HOST_ROOT.resolve(strict=True) == HOST_ROOT)
    migrate.private_directory(HOST_ROOT)
    expect(migrate.file_hash(migrate.read_input(HOST_ROOT, "pg_hba.conf")) == HBA_SHA256)
    expect(command("docker", "port", CONTAINER, "5432/tcp").strip() == b"127.0.0.1:5432")
    expect(not command("ss", "-H", "-ltn", "sport", "=", ":443").strip())
    database, = json.loads(command("docker", "inspect", CONTAINER))
    expect(database["State"]["Running"] is True and database["Config"]["Labels"]["lash.candidate"] == "p4-07" and
           any(mount["Source"] == str(HOST_ROOT / "pg_hba.conf") and mount["Destination"] == "/p407-pg_hba.conf"
               and mount["RW"] is False for mount in database["Mounts"]))
    bridge, = json.loads(command("docker", "network", "inspect", NETWORK))
    members = [(item["Name"], item["IPv4Address"]) for item in bridge["Containers"].values()]
    expect(bridge["Labels"]["lash.candidate"] == "p4-07" and
           [item["Subnet"] for item in bridge["IPAM"]["Config"]] == ["172.29.40.0/24"] and
           members == [(CONTAINER, "172.29.40.2/24")])


def database_witness(expect_empty):
    observed = json.loads(command("docker", "exec", "--user", "postgres", CONTAINER, "psql", "-XAtq",
         "--set", "ON_ERROR_STOP=on", "--dbname", TARGET["database"], "--command", """
        set default_transaction_read_only=on;
        select json_build_object(
          'databaseOid',(select oid::text from pg_database where datname=current_database()),
          'migrationRoleOid','lash_her_p407_frontend_migration'::regrole::oid::text,
          'runtimeRoleOid','lash_her_p407_frontend_runtime'::regrole::oid::text,
          'systemIdentifier',(select system_identifier::text from pg_control_system()),
          'readOnly',current_setting('transaction_read_only')='on',
          'major',current_setting('server_version_num')::int/10000,
          'journalPresent',to_regclass('drizzle.__drizzle_migrations') is not null,
          'empty',to_regnamespace('drizzle') is null and not exists(select 1 from pg_class
            where relnamespace='public'::regnamespace and relkind in ('r','p','v','m','f','S')),
          'sessions',(select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()),
          'hbaErrors',(select count(*) from pg_hba_file_rules where error is not null))"""))
    expect(observed["readOnly"] is True and observed["major"] == 18 and observed["sessions"] == 0 and
           observed["hbaErrors"] == 0 and observed["journalPresent"] is not expect_empty and
           (not expect_empty or observed["empty"] is True))
    return {"version": 1, **{key: observed[key] for key in WITNESS_NAMES}}


def container_base(image, inputs, release_id):
    return ["docker", "run", "--rm", "--pull", "never", "--name", RUNNER, "--label", f"lash.p407.attempt={release_id}", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--user", f"{RUNNER_UID}:{RUNNER_UID}", "--memory", "256m", "--cpus", "0.5",
            "--pids-limit", "32", "--mount", f"type=bind,src={inputs},dst=/input,readonly",
            "--entrypoint", "node"], [image, "ops/platform/frontend-image.mjs"]


def stop_owned_runner(release_id, image):
    try:
        running, = json.loads(command("docker", "inspect", RUNNER))
        config = running["Config"]
        if config["Image"] == image and config["Labels"].get("lash.p407.attempt") == release_id:
            command("docker", "stop", "--time", "5", running["Id"])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        # The runner may already have removed itself. If the host cannot
        # confirm cleanup, the attempt remains failed and requires inspection.
        pass


def stage_inputs(directory, bundle, release, job, witness):
    candidate_input = migrate.read_input(bundle, "release.candidate.json")
    job_input = migrate.read_input(bundle, "jobs/frontend.json")
    expect(decode_qualification_target_json(candidate_input, "carrier") == release and
           decode_qualification_target_json(job_input, "carrier") == job["job"])
    directory.mkdir(mode=0o700)
    for name, data in (
        ("candidate.json", candidate_input),
        ("job.json", job_input),
        ("schema.json", job["schema"]),
        ("witness.json", (json.dumps(witness) + "\n").encode()),
    ):
        migrate.write_exact_bytes(directory, name, data)
        os.chown(directory / name, RUNNER_UID, RUNNER_UID)
    os.chown(directory, RUNNER_UID, RUNNER_UID)


def verify_receipts(directory, job, read_only):
    receipt = migrate.read_json(directory, "database-receipt.json", expected_profile=PROFILE)
    outcome = migrate.read_json(directory, "job-outcome.json", expected_profile=PROFILE)
    migrate.require_receipt_profile(PROFILE, "frontend", receipt, outcome)
    keys = ("releaseId", "environment", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
            "schemaBaselineSha256", "contractManifestSha256", "recoveryRef")
    expected_target = {key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")}
    for record in (receipt, outcome):
        expect(all(record.get(key) == job[key] for key in keys) and record.get("target") == expected_target and
               record.get("status") == "DATABASE_VERIFIED" and record.get("trafficAuthorized") is False and
               record.get("service") == "frontend" and record.get("readOnlyVerified") is read_only and
               record.get("migrationMode") == ("verify-current-only" if read_only else "apply-forward"))
        migrate.require_contract_identity(job, record)
    expect(receipt.get("schemaVerified") is True and receipt.get("runtimeRoleVerified") is True)
    if read_only:
        expect(receipt["applied"] == [] and bool(receipt["before"]) and receipt["before"] == receipt["after"])
    else:
        expect(receipt["before"] == [] and [entry["tag"] for entry in receipt["applied"]] ==
               job["target"]["approvedPendingTags"])
    return receipt


def run(bootstrap_bundle, current_bundle, review, backup, results, confirmation):
    for directory in (bootstrap_bundle, current_bundle, review.parent, backup.parent, results):
        private_path(directory)
    raw_review = migrate.read_json(review.parent, review.name, expected_profile=PROFILE)
    expect(set(raw_review) == {"databaseIdentity", "bootstrap", "verification", "backupSha256"} and
           re.fullmatch(r"[a-f0-9]{64}", raw_review["backupSha256"]) and
           migrate.file_hash(migrate.read_input(backup.parent, backup.name)) == raw_review["backupSha256"])
    release, bootstrap, current_release, current = checked_inputs(bootstrap_bundle, current_bundle, raw_review["backupSha256"])
    release_id = release["releaseId"]
    expect(confirmation == f"staging/{release_id}/p4-07")
    for key, info in (("bootstrap", bootstrap), ("verification", current)):
        expect(raw_review[key] == {name: info["job"][name] for name in ("sourceCommit", "migrationImageDigest")})
    with ExitStack() as stack:
        for path in (RELEASE_LOCK, HOST_ROOT / "bootstrap.lock"):
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            stack.callback(os.close, fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verify_host()
        witness = database_witness(expect_empty=True)
        expect(witness == raw_review["databaseIdentity"])
        attempt = results / release_id
        attempt.mkdir(mode=0o700)
        operations = []
        for action, bundle, candidate, info in (
            ("bootstrap", bootstrap_bundle, release, bootstrap),
            ("verify-current", current_bundle, current_release, current),
        ):
            inputs, receipts = attempt / f"{action}-input", attempt / action
            stage_inputs(inputs, bundle, candidate, info, witness)
            receipts.mkdir(mode=0o700)
            os.chown(receipts, RUNNER_UID, RUNNER_UID)
            base, entry = container_base(info["image"], inputs, release_id)
            files = ["/input/candidate.json", "/input/job.json", "/input/schema.json"]
            command(*base, "--network", "none", *entry, "--check-profiled-current", *files, seconds=40)
            operations.append((action, receipts, base, entry, files, info))
        # Read a single isolated credential after both immutable input checks.
        # The outer asm-exec launcher supplies it over stdin, not local files.
        credential = sys.stdin.buffer.read(4097)
        expect(0 < len(credential) < 4097 and not any(value < 33 or value > 126 for value in credential))
        verified = []
        for action, receipts, base, entry, files, info in operations:
            verify_host()
            expect(database_witness(expect_empty=action == "bootstrap") == witness)
            is_bootstrap = action == "bootstrap"
            mode = "--execute-p407-bootstrap" if is_bootstrap else "--execute-profiled-current"
            transport = ["-i"] if is_bootstrap else ["--env", "FRONTEND_STAGING_MIGRATION_DATABASE_URL"]
            witness_input = ["/input/witness.json"] if is_bootstrap else []
            secret_env = None if is_bootstrap else {"FRONTEND_STAGING_MIGRATION_DATABASE_URL": credential.decode("ascii")}
            try:
                command(*base, *transport, "--network", NETWORK, "--ip", "172.29.40.11",
                        "--mount", f"type=bind,src={receipts},dst=/receipts", *entry,
                        mode, *files, "--confirm", f"staging/{release_id}",
                        "/receipts", *witness_input, stdin=credential if is_bootstrap else None,
                        private_env=secret_env, seconds=1250)
            except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
                stop_owned_runner(release_id, info["image"])
                raise
            verify_host()
            expect(database_witness(expect_empty=False) == witness)
            verified.append(verify_receipts(receipts, info["job"], action == "verify-current"))
        expect(verified[0]["after"] == verified[1]["after"])
        migrate.write_json(attempt, "isolated-bootstrap-outcome.json", {
            "status": "P407_ISOLATED_FRONTEND_VERIFIED", "releaseId": release_id,
            "bootstrapSource": raw_review["bootstrap"], "verificationSource": raw_review["verification"],
            "trafficAuthorized": False,
        })
        return attempt / "verify-current"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("bootstrap_bundle", "current_bundle", "review", "backup", "results"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--confirm", required=True)
    args = parser.parse_args()
    try:
        receipts = run(args.bootstrap_bundle, args.current_bundle, args.review, args.backup, args.results, args.confirm)
    except (OSError, TypeError, ValueError, KeyError, subprocess.SubprocessError):
        parser.exit(1, REFUSED + "\n")
    print(json.dumps({"status": "P407_ISOLATED_FRONTEND_VERIFIED", "readOnlyReceipts": str(receipts),
                      "trafficAuthorized": False}))


if __name__ == "__main__":
    main()
