"""Prepare or run the single reviewed staging Course schema/draft action."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from uuid import uuid4

ROOT = Path("/var/lib/lash-her")
POSTGRES = ROOT / "staging-postgres-v1"
ACTIVE = ROOT / "staging-lightsail-api-runtime-v1"
PRIOR = ROOT / "staging-lightsail-api-bootstrap-v1/course"
RESULT = ROOT / "releases/staging/p3-lightsail-synthetic-v1"
LOCK = Path("/run/lock/lash-her-release.lock")
DEPLOYMENT = "dpl_9GgjzYYycirPaHKLJnupLXhSBaHb"
RELEASE = "p3-lightsail-synthetic-v1"
NETWORK = "lash-her-staging-postgres_course_database"
COMMUNITY_NETWORK = "lash-her-staging-postgres_community_database"
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "DOCKER_CONTEXT": "default"}
INPUTS = {"job.json", "schema.json", "predecessor-schema.json", "fixture.json", "review.json"}
TAG = "0022_legacy_course_imports"


def require(condition, code):
    if not condition:
        raise ValueError(code)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def docker(*args):
    result = subprocess.run(["docker", *args], env=ENV, capture_output=True, text=True, check=False, timeout=25)
    require(result.returncode == 0, "STAGING_DOCKER_CHECK_REFUSED")
    return result.stdout.strip()


def emit(status, **values):
    print(json.dumps({"status": status, "productionTarget": False, "trafficAuthorized": False, **values}, separators=(",", ":")), flush=True)


def containers(project):
    raw = docker("ps", "-a", "--no-trunc", "--filter", "label=com.docker.compose.project=" + project,
                 "--format", '{{.ID}} {{.State}} {{.Label "com.docker.compose.service"}}')
    records = [line.split() for line in raw.splitlines()]
    require(all(len(row) == 3 and re.fullmatch(r"[a-f0-9]{64}", row[0]) for row in records), "STAGING_CONTAINER_LIST_REFUSED")
    values = {service: (identity, state) for identity, state, service in records}
    require(len(records) == len(values), "STAGING_DUPLICATE_SERVICE")
    return values


def baseline():
    switch = json.loads((ACTIVE / "public-switch-receipt.json").read_bytes())
    require(switch["status"] == "STAGING_LIGHTSAIL_PUBLIC_SWITCH_VERIFIED" and switch["productionTarget"] is False
            and switch["deploymentId"] == DEPLOYMENT, "STAGING_SWITCH_RECEIPT_REFUSED")
    active = containers("lash-her-staging-pg-candidate")
    retained = containers("lash-her-staging")
    require(set(active) == {"course-api", "community-api", "course-tls", "community-tls", "gateway"}
            and all(state == "running" for _, state in active.values())
            and active["gateway"] == (switch["gateway"], "running"), "STAGING_ACTIVE_STACK_REFUSED")
    require(len(retained) == 10 and retained["gateway"] == (switch["rollbackGateway"], "exited")
            and all(state == "running" for service, (_, state) in retained.items() if service != "gateway"), "STAGING_ROLLBACK_STACK_REFUSED")
    review = json.loads((ACTIVE / "review.json").read_bytes())
    retained_ids = {service: identity for service, (identity, _) in retained.items()}
    require(sha(json.dumps(retained_ids, sort_keys=True).encode()) == review["retainedContainersSha256"], "STAGING_ROLLBACK_IDS_CHANGED")
    state = json.loads((ACTIVE / "configuration/admission/state.json").read_bytes())
    require(state["environment"] == "staging" and state["newWork"] is False and state["recovery"] is False
            and state.get("version") == 1, "STAGING_ADMISSION_MUST_BE_CLOSED")
    pg = containers("lash-her-staging-postgres")
    require(set(pg) == {"postgres"} and pg["postgres"][1] == "running", "STAGING_POSTGRES_CONTAINER_REFUSED")
    settings = json.loads(docker("inspect", pg["postgres"][0]))[0]
    require(settings["State"]["Health"]["Status"] == "healthy" and not settings["HostConfig"]["PortBindings"]
            and set(settings["NetworkSettings"]["Networks"]) == {NETWORK, COMMUNITY_NETWORK}, "STAGING_POSTGRES_BOUNDARY_REFUSED")
    network = json.loads(docker("network", "inspect", NETWORK))[0]
    require(network["Internal"] is True and network["Labels"]["com.docker.compose.project"] == "lash-her-staging-postgres",
            "STAGING_COURSE_NETWORK_REFUSED")
    predecessor_receipt = (PRIOR / "receipts/database-receipt.json").read_bytes()
    predecessor = json.loads(predecessor_receipt)
    prior_schema = (PRIOR / "inputs/schema.json").read_bytes()
    require(sha(predecessor_receipt) == switch["migrationReceipts"]["course"] and predecessor["status"] == "DATABASE_VERIFIED"
            and predecessor["postAppliedCount"] == 22 and predecessor["environment"] == "staging"
            and sha(prior_schema) == predecessor["schemaBaselineSha256"], "STAGING_PREDECESSOR_REFUSED")
    return {"active": active, "retained": retained, "postgres": pg, "predecessorSchemaSha256": sha(prior_schema),
            "predecessorReceiptSha256": sha(predecessor_receipt), "frontendDeployment": DEPLOYMENT}


def write_files(directory, inputs):
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)
    for name, value in inputs.items():
        file = directory / name
        with file.open("x", encoding="utf-8") as stream:
            stream.write(value)
        os.chown(file, 65532, 65532)
        file.chmod(0o400)


def container(mode, image, directory, review_hash, results=None):
    name = RELEASE + "-" + uuid4().hex[:12]
    args = ["docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64", "--name", name,
            "--network", "none" if mode == "plan" else NETWORK, "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true", "--user", "65532:65532", "--memory", "256m",
            "--cpus", "0.5", "--pids-limit", "64", "--mount", f"type=bind,src={directory},dst=/review,readonly"]
    env = ENV.copy()
    if mode != "plan":
        value = (POSTGRES / "secrets/course-migration").read_text().removesuffix("\n")
        require(re.fullmatch(r"[0-9a-f]{64}", value), "STAGING_CREDENTIAL_REFUSED")
        env["STAGING_DATABASE_URL"] = ("postgresql://lash_her_course_staging_migration:" + value +
                                      "@course-postgres-staging:5432/lash_her_course_staging?sslmode=verify-full")
        args += ["--env", "STAGING_DATABASE_URL", "--env", "DATABASE_TARGET=staging",
                 "--env", "NODE_EXTRA_CA_CERTS=/run/pg-ca.crt",
                 "--mount", f"type=bind,src={POSTGRES}/tls/ca.crt,dst=/run/pg-ca.crt,readonly"]
    if results:
        args += ["--mount", f"type=bind,src={results},dst=/receipts"]
    args += ["--entrypoint", "node", image, "dist-migration/scripts/run-lightsail-synthetic-import.js", mode, "/review", review_hash]
    if results:
        args += ["/receipts"]
    try:
        run = subprocess.run(args, env=env, capture_output=True, text=True, timeout=1230 if results else 40)
    finally:
        subprocess.run(["docker", "rm", "-f", name], env=ENV, capture_output=True, timeout=15)
        require(docker("ps", "-aq", "--filter", "name=^/" + name + "$") == "", "STAGING_JOB_CLEANUP_REFUSED")
    if run.returncode != 0:
        code = "STAGING_IMPORT_CONTAINER_REFUSED"
        try:
            reported = json.loads(run.stderr.strip().splitlines()[-1]).get("code", "")
            if re.fullmatch(r"[A-Z_]{3,100}", reported):
                code = reported
        except (ValueError, IndexError, AttributeError):
            pass
        raise ValueError(code)
    record = json.loads(run.stdout)
    expected = {"plan": "STAGING_SYNTHETIC_IMPORT_INPUT_VERIFIED", "preflight": "STAGING_SYNTHETIC_IMPORT_PREFLIGHT_VERIFIED",
                "apply": "STAGING_SYNTHETIC_DRAFT_IMPORTED"}
    require(record["status"] == expected[mode] and record["reviewSha256"] == review_hash
            and record["productionTarget"] is False and record["trafficAuthorized"] is False, "STAGING_IMPORT_RECEIPT_REFUSED")
    return record


def main():
    mode, machine, *selection = sys.argv[1:]
    require(mode in {"baseline", "plan", "apply"} and os.geteuid() == 0 and
            Path("/etc/machine-id").read_text().strip() == machine and re.fullmatch(r"[a-f0-9]{32}", machine), "STAGING_MACHINE_REFUSED")
    os.umask(0o077)
    with os.fdopen(os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW), "rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = baseline()
        require(not RESULT.exists() and not RESULT.is_symlink(), "STAGING_ACTION_ALREADY_EXISTS")
        if mode == "baseline":
            require(not selection, "STAGING_ARGUMENTS_REFUSED")
            emit("STAGING_PHASE3_BASELINE_VERIFIED", active=len(original["active"]), retainedRunning=9,
                 retainedGateway="standby", admission="closed", frontendDeployment=DEPLOYMENT,
                 predecessorSchemaSha256=original["predecessorSchemaSha256"])
            return
        require(len(selection) == (2 if mode == "apply" else 1) and re.fullmatch(r"[a-f0-9]{64}", selection[0]), "STAGING_ARGUMENTS_REFUSED")
        review_hash = selection[0]
        raw = sys.stdin.buffer.read(5_000_001)
        require(len(raw) <= 5_000_000, "STAGING_REVIEW_SIZE_REFUSED")
        packet = json.loads(raw)
        require(set(packet) == {"inputs", "plan"} and set(packet["inputs"]) == INPUTS, "STAGING_REVIEW_INPUTS_REFUSED")
        inputs, plan = packet["inputs"], packet["plan"]
        require(sha(inputs["review.json"].encode()) == review_hash == plan["reviewSha256"] and plan["releaseId"] == RELEASE
                and plan["productionTarget"] is False and plan["trafficAuthorized"] is False
                and plan["pendingTags"] == [TAG] and sha(inputs["predecessor-schema.json"].encode()) == original["predecessorSchemaSha256"],
                "STAGING_REVIEW_BINDING_REFUSED")
        image = plan["migrationImage"]
        require(re.fullmatch(r"ghcr\.io/princessdardan/lash-her-platform-course-migration@sha256:[a-f0-9]{64}", image), "STAGING_IMAGE_REFUSED")
        job = json.loads(inputs["job.json"])
        require(job["migrationImageDigest"] == image.split("@")[1] and job["environment"] == "staging", "STAGING_JOB_IMAGE_REFUSED")
        image_metadata = json.loads(docker("image", "inspect", image))[0]
        require(image_metadata["Architecture"] == "amd64" and image_metadata["Os"] == "linux" and image in image_metadata["RepoDigests"]
                and image_metadata["Config"]["Labels"]["com.lashher.source.revision"] == job["sourceCommit"], "STAGING_IMAGE_SOURCE_REFUSED")
        with tempfile.TemporaryDirectory(prefix="phase3-review-", dir="/var/tmp") as workspace:
            directory = Path(workspace) / "inputs"
            write_files(directory, inputs)
            container("plan", image, directory, review_hash)
            proof = container("preflight", image, directory, review_hash)
            require(baseline() == original, "STAGING_BASELINE_CHANGED")
            seal = sha(json.dumps({"proof": proof, "baseline": original, "image": image}, sort_keys=True).encode())
            emit("STAGING_PHASE3_PLAN_VERIFIED", planSha256=seal, course=proof, activeServices=5, retainedRunning=9)
            if mode == "plan":
                return
            require(selection[1] == seal and LOCK.stat().st_ino == os.fstat(lock.fileno()).st_ino, "STAGING_REVIEWED_PREFLIGHT_REQUIRED")
            RESULT.mkdir(mode=0o700)
            durable_inputs = RESULT / "inputs"
            write_files(durable_inputs, inputs)
            receipts = RESULT / "receipts"
            receipts.mkdir(mode=0o700)
            os.chown(receipts, 65532, 65532)
            imported = container("apply", image, durable_inputs, review_hash, receipts)
            require(baseline() == original, "STAGING_BASELINE_CHANGED")
            emit("STAGING_PHASE3_DRAFT_IMPORTED", course=imported, planSha256=seal, resultDirectory=str(RESULT))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch(r"[A-Z_]{3,100}", str(error)) else type(error).__name__
        emit("STAGING_PHASE3_REQUIRES_REVIEW", code=code)
        sys.exit(1)
