"""Private child of the locked Node coordinator; no standalone release authority.

Reuses the existing verified provider/probe components. Every request obtains a
fresh liveness checkpoint from the parent. No provider error body or private
runtime value is written to stdout/common receipts.
"""
import json
from pathlib import Path
import re
import sys

import frontend_probe
import migrate
import vercel

demand = migrate.demand
MAXIMUM = 2_000_000
STATES = ("QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED")


def checkpoint():
    checkpoint.sequence += 1
    print(json.dumps({"type": "checkpoint", "id": checkpoint.sequence}), flush=True)
    raw = sys.stdin.buffer.readline(1025)
    demand(0 < len(raw) <= 1024, "PARENT_LOCK_CHECKPOINT_LOST")
    value = json.loads(raw)
    demand(value == {"type": "continue", "id": checkpoint.sequence}, "PARENT_LOCK_CHECKPOINT_REFUSED")


checkpoint.sequence = 0


class LockedClient:
    def __init__(self, client, verify):
        self.client, self.verify = client, verify

    def request(self, method, path, body=None):
        self.verify()
        result = self.client.request(method, path, body)
        self.verify()
        return result


class LockedProbe:
    def __init__(self, verify, client=None):
        self.verify, self.client = verify, client or frontend_probe.ProbeClient()

    def request(self, *args):
        self.verify()
        value = self.client.request(*args)
        self.verify()
        return value


def identity(context):
    plan, release, binding = context["plan"], context["candidate"], context["bindings"]
    environment, project_id, commit = vercel.release_identity(release)
    demand(environment == "staging" and environment == plan.get("environment") == binding.get("environment")
           and release["releaseId"] == plan.get("actionId") == binding.get("actionId")
           and commit == plan.get("sourceCommit") == binding.get("sourceCommit")
           and binding.get("targetSha256") == plan.get("targetSha256")
           and project_id == binding.get("projectId") == vercel.PROJECTS["staging"]
           and binding.get("teamId") == vercel.TEAM and binding.get("repositoryId") == vercel.REPOSITORY_ID,
           "FRONTEND_PROVIDER_ACTION_BINDING_REFUSED")
    return {"version": 1, "environment": environment, "projectId": project_id,
            "actionId": plan["actionId"], "sourceCommit": commit, "targetSha256": plan["targetSha256"]}


def deployment_metadata(row):
    demand(isinstance(row, dict), "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    deployment_id = row.get("uid", row.get("id"))
    demand(isinstance(deployment_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id)
           and (row.get("uid") is None or row.get("id") is None or row["uid"] == row["id"]), "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    git, meta = row.get("gitSource") or {}, row.get("meta") or {}
    demand(isinstance(git, dict) and isinstance(meta, dict), "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    source = git.get("sha", meta.get("githubCommitSha"))
    demand(source is None or isinstance(source, str) and re.fullmatch(r"[a-f0-9]{40}", source) and source != "0" * 40,
           "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    demand(git.get("sha") is None or meta.get("githubCommitSha") is None or git["sha"] == meta["githubCommitSha"],
           "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    target, created, url = row.get("target"), row.get("createdAt", row.get("created")), row.get("url")
    state = row.get("state", row.get("readyState"))
    demand(target in (None, "preview", "production") and type(created) is int and created > 0 and state in STATES
           and (url is None or isinstance(url, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*\.vercel\.app", url)),
           "VERCEL_DEPLOYMENT_METADATA_REFUSED")
    return {"deploymentId": deployment_id, "sourceCommit": source, "target": target or "preview",
            "createdAt": created, "url": url, "state": state}


def deployment_inventory(client, project_id):
    rows, seen, cursor = [], set(), None
    for _page in range(100):
        suffix = "" if cursor is None else "&until=" + str(cursor)
        value = client.request("GET", f"/v7/deployments?projectId={project_id}&limit=100" + suffix)
        page, pagination = value.get("deployments"), value.get("pagination")
        demand(isinstance(page, list) and len(page) <= 100 and isinstance(pagination, dict)
               and type(pagination.get("count")) is int and pagination["count"] == len(page), "VERCEL_DEPLOYMENT_PAGINATION_REFUSED")
        for row in page:
            selected = deployment_metadata(row)
            demand(selected["deploymentId"] not in seen and len(rows) < 4096, "VERCEL_DEPLOYMENT_INVENTORY_REFUSED")
            seen.add(selected["deploymentId"]); rows.append(selected)
        following = pagination.get("next")
        if following is None:
            return sorted(rows, key=lambda row: row["deploymentId"])
        demand(type(following) is int and following > 0 and page and (cursor is None or following < cursor),
               "VERCEL_DEPLOYMENT_PAGINATION_REFUSED")
        cursor = following
    raise ValueError("VERCEL_DEPLOYMENT_INVENTORY_LIMIT")


def action_build(context, attempt):
    """Retain an unsuccessful build as evidence, never as a staged identity."""
    if attempt is None or not (attempt / "frontend-build-outcome.json").exists():
        return None
    raw = migrate.read_input(attempt, "frontend-build-outcome.json")
    value = json.loads(raw)
    selected = identity(context)
    demand(isinstance(value, dict) and value.get("environment") == selected["environment"]
           and value.get("projectId") == selected["projectId"] and value.get("sourceCommit") == selected["sourceCommit"]
           and value.get("releaseId") == selected["actionId"] and value.get("trafficAuthorized") is False
           and value.get("promotionAuthorized") is False
           and value.get("status") in ("FRONTEND_STAGED", "FRONTEND_BUILD_FAILED_REQUIRES_REVIEW"),
           "VERCEL_BUILD_RECEIPT_BINDING_REFUSED")
    deployment_id = value.get("deploymentId")
    demand(deployment_id is None or isinstance(deployment_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id),
           "VERCEL_BUILD_RECEIPT_BINDING_REFUSED")
    return {"status": value["status"], "deploymentId": deployment_id, "receiptSha256": migrate.file_hash(raw)}


def observe_vercel(context, client, attempt=None):
    selected = identity(context)
    before = vercel.promotion_state(client, selected["projectId"])
    first = deployment_inventory(client, selected["projectId"])
    second = deployment_inventory(client, selected["projectId"])
    after = vercel.promotion_state(client, selected["projectId"])
    demand(first == second and before == after, "VERCEL_PROVIDER_CHANGED_DURING_INVENTORY")
    expected = context["bindings"]["deployments"]
    known_ids = {row["deploymentId"] for row in expected}
    # One build created by this action may appear after the reviewed initial
    # inventory. Verify it through the existing exact source/project binding.
    staged, build = None, action_build(context, attempt)
    if build is not None and build["status"] == "FRONTEND_STAGED":
        staged = vercel._staged_identity(context["candidate"], attempt)
        state = vercel.deployment_state(client, staged["deploymentId"], staged["projectId"], staged["sourceCommit"], staged["releaseId"])
        if state["readyState"] != "READY":
            staged = None
    baseline = [row for row in first if row["deploymentId"] in known_ids]
    extras = [row for row in first if row["deploymentId"] not in known_ids]
    inventory_matches = baseline == expected and (not extras or staged is not None and len(extras) == 1
           and extras[0]["deploymentId"] == staged["deploymentId"] and extras[0]["sourceCommit"] == selected["sourceCommit"])
    original = context["bindings"]["projectState"]
    allowed_current = [original["productionDeploymentId"]] + ([staged["deploymentId"]] if staged else [])
    project_matches = after["productionDeploymentId"] in allowed_current
    cron_matches = after["cronsEnabled"] == original["nativeSchedulesEnabled"]
    if not cron_matches and after["cronsEnabled"] is False and attempt is not None and (attempt / "native-schedules-outcome.json").exists():
        disabled = migrate.read_json(attempt, "native-schedules-outcome.json")
        cron_matches = disabled.get("status") == "NATIVE_SCHEDULES_DISABLED" and disabled.get("actionId") == selected["actionId"] and disabled.get("projectId") == selected["projectId"]
    alias = after["aliasJob"]
    result = {**selected, "status": "VERCEL_STAGING_METADATA_OBSERVED", "projectState": after, "deployments": first,
              "projectPaginationComplete": True, "databaseBindingsVerified": False, "providerBindingsVerified": False,
              "reviewedInventoryMatches": inventory_matches, "reviewedProjectMatches": project_matches and cron_matches,
              "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None,
              "actionBuild": build,
              "aliasJobActive": alias is not None and alias["jobStatus"] in ("pending", "in-progress")}
    return result


def suspend_schedules(context, client, attempt):
    selected = identity(context)
    observed = observe_vercel(context, client, attempt)
    demand(observed["reviewedInventoryMatches"] and observed["reviewedProjectMatches"], "VERCEL_REVIEWED_INVENTORY_CHANGED")
    demand(not observed["aliasJobActive"], "VERCEL_ALIAS_JOB_ALREADY_ACTIVE")
    migrate.write_json(attempt, "native-schedules-started.json", {**selected, "status": "NATIVE_SCHEDULE_SUSPENSION_STARTED", "trafficAuthorized": False})
    outcome = {**selected, "status": "FAILED_REQUIRES_REVIEW", "historicalWritersFenced": False, "activeExecutions": None,
               "uncertainEffects": None, "trafficAuthorized": False}
    try:
        result = vercel.disable_schedules(client, context["candidate"])
        outcome.update(status=result["status"], previouslyEnabled=result["previouslyEnabled"], nativeSchedulesEnabled=False)
        return outcome
    finally:
        migrate.write_json(attempt, "native-schedules-outcome.json", outcome)


def configure_pending_source_pins(context, client, attempt, parent_directory):
    selected = identity(context)
    database = context["database"]
    raw = migrate.read_input(parent_directory, "database-receipt.json")
    stored = json.loads(raw)
    fields = ("version", "service", "environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
              "schemaBaselineSha256", "contractManifestSha256", "target", "after", "applied")
    demand(all(stored.get(key) == database.get(key) and stored.get(key) is not None for key in fields)
           and stored.get("status") == database.get("status") == "DATABASE_VERIFIED"
           and stored.get("sourceCommit") == selected["sourceCommit"] and stored.get("releaseId") == selected["actionId"]
           and stored.get("environment") == "staging" and stored.get("service") == "frontend"
           and stored.get("migrationMode") == "apply-forward" and stored.get("schemaVerified") is True
           and stored.get("runtimeRoleVerified") is True and stored.get("failureCode") is None,
           "LOCKED_PENDING_FRONTEND_DATABASE_RECEIPT_REQUIRED")
    target = stored["target"]
    target_hash = migrate.file_hash(json.dumps({"environment": "staging", **{key: target.get(key) for key in
        ("host", "port", "database", "user", "serverMajor")}}, separators=(",", ":")).encode())
    demand(target_hash == selected["targetSha256"], "LOCKED_FRONTEND_DATABASE_TARGET_BINDING_REFUSED")
    outcome = {**selected, "status": "SOURCE_PINS_FAILED_REQUIRES_REVIEW", "databaseReceiptSha256": migrate.file_hash(raw),
               "configuredKeys": [], "trafficAuthorized": False}
    migrate.write_json(attempt, "source-pins-started.json", outcome)
    keys = ("STAGING_RELEASE_COMMIT", "STAGING_MIGRATION_VERIFIED_COMMIT")
    try:
        for key in keys:
            value = client.request("POST", f'/v10/projects/{selected["projectId"]}/env?upsert=true', {
                "key": key, "value": selected["sourceCommit"], "type": "plain", "target": ["production"],
                "gitBranch": None, "customEnvironmentIds": [], "comment": "Verified pending frontend SQL " + selected["actionId"]})
            created = value.get("created")
            demand(value.get("failed") == [] and isinstance(created, dict) and created.get("key") == key
                   and created.get("target") == ["production"] and created.get("type") == "plain"
                   and not created.get("gitBranch") and not created.get("customEnvironmentIds"), "SOURCE_PIN_WRITE_UNVERIFIED")
        readback = client.request("GET", f'/v10/projects/{selected["projectId"]}/env?decrypt=false').get("envs")
        demand(isinstance(readback, list), "SOURCE_PIN_READBACK_UNVERIFIED")
        for key in keys:
            rows = [row for row in readback if row.get("key") == key and "production" in row.get("target", [])
                    and not row.get("gitBranch") and not row.get("customEnvironmentIds")]
            demand(len(rows) == 1 and rows[0].get("type") == "plain" and rows[0].get("value") == selected["sourceCommit"], "SOURCE_PIN_READBACK_UNVERIFIED")
        outcome.update(status="SOURCE_PINS_CONFIGURED", configuredKeys=list(keys))
        return outcome
    finally:
        migrate.write_json(attempt, "source-pins-outcome.json", outcome)


def deploy_compatible(context, client, attempt, parent_directory, probe=None):
    selected = identity(context)
    observed = observe_vercel(context, client, attempt)
    demand(observed["reviewedInventoryMatches"] and observed["reviewedProjectMatches"], "VERCEL_REVIEWED_INVENTORY_CHANGED")
    demand(observed["projectState"]["cronsEnabled"] is False and not observed["aliasJobActive"], "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
    private = Path(context["privateConfigurationDirectory"])
    demand(context.get("gatewayHost") == context["bindings"].get("gatewayHost"), "REVIEWED_FRONTEND_GATEWAY_BINDING_REQUIRED")
    frontend_probe._private_configuration(private)
    # This source-only component does not establish historical fencing. The
    # parent must already hold its complete live-qualified drain before entry.
    configure_pending_source_pins(context, client, attempt, parent_directory)
    frontend_probe.prepare(client, context["candidate"], private, attempt, context["gatewayHost"], scheduler_qualification=False)
    vercel.stage_frontend(client, context["candidate"], attempt)
    return vercel.promote_frontend(client, context["candidate"], attempt,
        lambda release, _deployment: frontend_probe.verify(client, release, attempt, private, probe))


def observe_compatible(context, client, attempt):
    selected = identity(context)
    current = vercel.promotion_state(client, selected["projectId"])
    outcome = {**selected, "deploymentId": None, "readyState": None, "aliasJobState": None,
               "aliasDeploymentId": current["productionDeploymentId"], "nativeSchedulesEnabled": current["cronsEnabled"],
               "workloadVerified": False, "workloadReceiptSha256": None}
    if current["productionDeploymentId"] is not None:
        raw_current = client.request("GET", f'/v13/deployments/{current["productionDeploymentId"]}?withGitRepoInfo=true')
        git = raw_current.get("gitSource") or {}
        demand(raw_current.get("id") == current["productionDeploymentId"] and raw_current.get("projectId") == selected["projectId"]
               and isinstance(git, dict) and git.get("type") == "github" and str(git.get("repoId")) == vercel.REPOSITORY_ID
               and isinstance(git.get("sha"), str) and re.fullmatch(r"[a-f0-9]{40}", git["sha"])
               and raw_current.get("readyState") in STATES, "VERCEL_CURRENT_DEPLOYMENT_BINDING_REFUSED")
        outcome.update(currentDeploymentId=current["productionDeploymentId"], currentDeploymentSourceCommit=git["sha"], currentDeploymentReadyState=raw_current["readyState"])
    build = action_build(context, attempt)
    outcome["actionBuild"] = build
    if build is None:
        return outcome
    if build["status"] != "FRONTEND_STAGED":
        if build["deploymentId"] is not None:
            outcome["unstagedActionDeployment"] = vercel.deployment_state(client, build["deploymentId"], selected["projectId"],
                selected["sourceCommit"], selected["actionId"])
        # A lost create response has no trusted deployment ID. The separately
        # retained project inventory reports any extras without guessing which
        # request created them or issuing a replacement build.
        return outcome
    staged = vercel._staged_identity(context["candidate"], attempt)
    state = vercel.deployment_state(client, staged["deploymentId"], staged["projectId"], staged["sourceCommit"], staged["releaseId"])
    alias = current["aliasJob"]
    outcome.update(deploymentId=state["deploymentId"], readyState=state["readyState"], aliasJobState=None if alias is None else alias["jobStatus"])
    outcome["aliasJobDeploymentId"] = None if alias is None else alias["toDeploymentId"]
    outcome["aliasJobType"] = None if alias is None else alias["type"]
    outcome["aliasJobMatchesIntent"] = False
    if alias is not None and (attempt / "frontend-promotion-started.json").exists():
        intent = migrate.read_json(attempt, "frontend-promotion-started.json")
        outcome["aliasJobMatchesIntent"] = (all(intent.get(key) == staged[key] for key in
            ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId", "previousDeploymentId"))
            and type(intent.get("previousAliasRequestedAt")) is int and alias["requestedAt"] > intent["previousAliasRequestedAt"]
            and alias["toDeploymentId"] == staged["deploymentId"] and alias["type"] == "promote")
    workload_path = attempt / "frontend-workload-outcome.json"
    if workload_path.exists():
        raw = migrate.read_input(attempt, workload_path.name)
        workload = json.loads(raw)
        outcome["workloadVerified"] = workload.get("status") == "FRONTEND_VERIFIED" and all(
            workload.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId"))
        outcome["workloadReceiptSha256"] = migrate.file_hash(raw)
    # Admission values are supplied only after the parent's actual post-SQL
    # closed-ledger observation; provider metadata cannot observe the ledger.
    controls = context.get("admissionObservation")
    if isinstance(controls, dict) and controls.get("ledgerDrained") is True and controls.get("active") == 0 and controls.get("uncertain") == 0:
        outcome.update(admissionNewWork=controls.get("newWork"), admissionRecovery=controls.get("recovery"))
    return outcome


def execute(context, client, verify, probe=None):
    selected = identity(context)
    parent = Path(context["directory"])
    migrate.private_directory(parent)
    demand(not any((p / ".git").exists() for p in (parent.resolve(), *parent.resolve().parents)), "PROVIDER_RECEIPTS_OUTSIDE_CHECKOUT_REQUIRED")
    attempt = parent / "vercel"
    if not attempt.exists():
        attempt.mkdir(mode=0o700)
    migrate.private_directory(attempt)
    locked = LockedClient(client, verify)
    operation = context["operation"]
    source_attempt = attempt
    if context.get("originalDirectory") is not None:
        demand(operation in ("observe-vercel", "observe-compatible"), "RECOVERY_PROVIDER_MUTATION_REFUSED")
        original = Path(context["originalDirectory"])
        migrate.private_directory(original)
        source_attempt = original / "vercel"
        if source_attempt.exists():
            migrate.private_directory(source_attempt)
    if operation == "observe-vercel":
        return observe_vercel(context, locked, source_attempt)
    if operation == "suspend-schedules":
        return suspend_schedules(context, locked, attempt)
    if operation == "deploy-compatible":
        return deploy_compatible(context, locked, attempt, parent, LockedProbe(verify, probe))
    if operation == "observe-compatible":
        return observe_compatible(context, locked, source_attempt)
    raise ValueError("FRONTEND_PROVIDER_OPERATION_REFUSED")


def main():
    try:
        raw = sys.stdin.buffer.readline(MAXIMUM + 1)
        demand(0 < len(raw) <= MAXIMUM, "FRONTEND_PROVIDER_INPUT_REFUSED")
        context = json.loads(raw)
        identity(context)
        # Credential is consumed only inside the private child process; no
        # ambient environment, provider URL override or token argument exists.
        client = vercel.Client(context["vercelToken"])
        result = execute(context, client, checkpoint)
        print(json.dumps({"type": "result", "value": result}, separators=(",", ":")), flush=True)
    except BaseException:
        print('{"type":"error","code":"FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED"}', flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
