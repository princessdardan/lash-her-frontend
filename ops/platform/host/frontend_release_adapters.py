"""Private child of the locked Node coordinator; no standalone release authority.

Reuses the existing verified provider/probe components. Every request obtains a
fresh liveness checkpoint from the parent. No provider error body or private
runtime value is written to stdout/common receipts.
"""
import json
import hashlib
import hmac
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.parse

import frontend_probe
import frontend_resend_retirement
import frontend_square_retirement
import frontend_sanity_fencing
import frontend_google_fencing
import frontend_crm_shipping_retirement
import frontend_gateway_observation
import migrate
import p2_certification_profile
import vercel

demand = migrate.demand
MAXIMUM = 2_000_000
STATES = ("QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED")
RELATED_PRODUCTION_PROJECT = "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy"
BOOTSTRAP_FLAGS = ("INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
    "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
    "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED")


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
        try:
            return self.client.request(method, path, body)
        finally:
            self.verify()


class LockedProbe:
    def __init__(self, verify, client=None):
        self.verify, self.client = verify, client or frontend_probe.ProbeClient()

    def request(self, *args, **kwargs):
        self.verify()
        try:
            return self.client.request(*args, **kwargs)
        finally:
            self.verify()


def wait_for_supported_retirement(task, denied, verify, seconds):
    """Read only while the existing operator retires the selected credential.

    The same private client instance is retained. Access denial never substitutes
    for the subsequent selected refresh/effect verification.
    """
    demand(type(seconds) is int and 1 <= seconds <= 300, "RETIREMENT_OBSERVATION_BUDGET_REFUSED")
    deadline = time.monotonic() + seconds
    while True:
        verify()
        try:
            task()
        except denied:
            verify()
            return
        demand(time.monotonic() < deadline, "SUPPORTED_CONSOLE_RETIREMENT_NOT_OBSERVED")
        time.sleep(min(1, max(0, deadline - time.monotonic())))


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
            "actionId": plan["actionId"], "sourceCommit": commit, "targetSha256": plan["targetSha256"],
            **migrate.contract_identity(release)}


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


def retired_deployments(context, attempt):
    if attempt is None:
        return []
    path = attempt.parent / "vercel" / "historical-deployments-outcome.json"
    if not path.exists():
        return []
    value, selected = migrate.read_json(path.parent, path.name), identity(context)
    if value.get("status") != "STAGING_HISTORICAL_INGRESS_RETIRED":
        return []
    reviewed = context["bindings"].get("deploymentRetirement") or {}
    demand(all(value.get(key) == selected[key] for key in ("environment", "actionId", "sourceCommit", "targetSha256", "projectId")) and
        value.get("deletedDeploymentIds") == reviewed.get("retireDeploymentIds"), "VERCEL_RETIREMENT_RECEIPT_REFUSED")
    for deployment_id in value["deletedDeploymentIds"]:
        receipt = migrate.read_json(path.parent, f"historical-{deployment_id}-deleted.json")
        demand(receipt.get("state") == "DELETED" and receipt.get("deploymentId") == deployment_id and
            all(receipt.get(key) == selected[key] for key in ("actionId", "sourceCommit", "targetSha256", "projectId")), "VERCEL_RETIREMENT_RECEIPT_REFUSED")
    return value["deletedDeploymentIds"]


def repository_project_inventory(client):
    # Official CLI50 fetchPaginated contract: v9/projects returns projects plus
    # pagination.next; request every team page and inspect only repo metadata.
    projects, seen, cursor = [], set(), None
    for _page in range(100):
        suffix = "" if cursor is None else "&until=" + str(cursor)
        value = client.request("GET", "/v9/projects?limit=100" + suffix)
        rows, pagination = value.get("projects"), value.get("pagination")
        demand(isinstance(rows, list) and len(rows) <= 100 and isinstance(pagination, dict) and
            type(pagination.get("count")) is int and pagination["count"] == len(rows), "REPOSITORY_PROJECT_PAGINATION_REFUSED")
        for row in rows:
            demand(isinstance(row, dict) and isinstance(row.get("id"), str) and re.fullmatch(r"prj_[A-Za-z0-9]+", row["id"]) and
                row["id"] not in seen and len(seen) < 4096 and row.get("accountId") == vercel.TEAM, "REPOSITORY_PROJECT_METADATA_REFUSED")
            seen.add(row["id"])
            link = row.get("link") or {}
            demand(isinstance(link, dict), "REPOSITORY_PROJECT_METADATA_REFUSED")
            if link.get("type") == "github" and str(link.get("repoId")) == vercel.REPOSITORY_ID:
                projects.append(row["id"])
        following = pagination.get("next")
        if following is None:
            return sorted(projects)
        demand(type(following) is int and following > 0 and rows and (cursor is None or following < cursor), "REPOSITORY_PROJECT_PAGINATION_REFUSED")
        cursor = following
    raise ValueError("REPOSITORY_PROJECT_INVENTORY_LIMIT")


def related_retirements(context, attempt):
    if attempt is None or not (attempt / "related-preview-retirements-outcome.json").exists():
        return []
    receipt = migrate.read_json(attempt, "related-preview-retirements-outcome.json")
    selected = identity(context)
    demand(all(receipt.get(key) == selected[key] for key in ("actionId", "sourceCommit", "targetSha256")) and
        receipt.get("status") == "STAGING_RELATED_PREVIEW_INGRESS_RETIRED", "RELATED_PREVIEW_RECEIPT_REFUSED")
    expected = sorted(identifier for project in context["bindings"].get("relatedProjects", []) for identifier in project["retirePreviewDeploymentIds"])
    demand(receipt.get("deletedDeploymentIds") == expected, "RELATED_PREVIEW_RECEIPT_REFUSED")
    return expected


def observe_related_projects(context, client, attempt=None):
    retired, observations = related_retirements(context, attempt), []
    for project in context["bindings"].get("relatedProjects", []):
        demand(project["projectId"] == RELATED_PRODUCTION_PROJECT, "RELATED_PROJECT_SCOPE_REFUSED")
        state = vercel.promotion_state(client, project["projectId"])
        first = deployment_inventory(client, project["projectId"])
        second = deployment_inventory(client, project["projectId"])
        after = vercel.promotion_state(client, project["projectId"])
        demand(first == second and state == after, "RELATED_PROJECT_CHANGED_DURING_OBSERVATION")
        expected = [row for row in project["deployments"] if row["deploymentId"] not in retired]
        observations.append({"projectId": project["projectId"], "deployments": first, "projectState": state,
            "reviewedInventoryMatches": first == expected, "paginationComplete": True,
            "productionTargetMutationsAuthorized": False, "nativeScheduleMutationsAuthorized": False})
    return observations


def retire_related_previews(context, client, attempt):
    selected = identity(context)
    bootstrap = observe_compatible(context, client, attempt.parent / "vercel-bootstrap")
    demand(bootstrap.get("bootstrapAdmissionVerified") is True and bootstrap.get("workloadVerified") is True and
        bootstrap.get("nativeSchedulesEnabled") is False, "ADMISSION_BOOTSTRAP_REQUIRED_FOR_RELATED_PREVIEWS")
    proof = context.get("relatedPreviewBindings")
    expected = [(project, identifier) for project in context["bindings"].get("relatedProjects", []) for identifier in project["retirePreviewDeploymentIds"]]
    demand(expected and isinstance(proof, list) and len(proof) == len(expected), "RELATED_PREVIEW_BINDINGS_REQUIRED")
    expected_projects = sorted([selected["projectId"], *[row["projectId"] for row in context["bindings"].get("relatedProjects", [])]])
    demand(repository_project_inventory(client) == expected_projects, "REPOSITORY_PROJECT_INVENTORY_DRIFT")
    observations = observe_related_projects(context, client)
    demand(all(row["reviewedInventoryMatches"] for row in observations), "RELATED_PREVIEW_INVENTORY_DRIFT")
    outcome = {**selected, "status": "RELATED_PREVIEW_RETIREMENT_REQUIRES_REVIEW", "deletedDeploymentIds": [],
        "uncertainDeploymentId": None, "productionTargetMutationsAuthorized": False, "nativeScheduleMutationsAuthorized": False}
    migrate.write_json(attempt, "related-preview-retirements-started.json", outcome)
    try:
        for project, identifier in expected:
            demand(project["projectId"] == RELATED_PRODUCTION_PROJECT, "RELATED_PROJECT_SCOPE_REFUSED")
            row = next(row for row in project["deployments"] if row["deploymentId"] == identifier)
            binding = [entry for entry in proof if entry.get("projectId") == project["projectId"] and entry.get("deploymentId") == identifier]
            demand(row["target"] == "preview" and len(binding) == 1 and binding[0].get("sourceCommit") == row["sourceCommit"],
                "RELATED_PRODUCTION_TARGET_RETIREMENT_REFUSED")
            state = vercel.promotion_state(client, project["projectId"])
            original = next(value for value in observations if value["projectId"] == project["projectId"])
            demand(state == original["projectState"] and identifier != state["productionDeploymentId"], "RELATED_PRODUCTION_STATE_CHANGED")
            inventory = deployment_inventory(client, project["projectId"])
            demand(inventory == [entry for entry in project["deployments"] if entry["deploymentId"] not in outcome["deletedDeploymentIds"]],
                "RELATED_PREVIEW_INVENTORY_DRIFT")
            detail = client.request("GET", f"/v13/deployments/{identifier}?withGitRepoInfo=true")
            git = detail.get("gitSource") or {}
            # REST lists historically encode nonproduction targets as null.
            # Normalize only after proving project/source/repository identity.
            demand(detail.get("projectId") == project["projectId"] and detail.get("target") in (None, "preview") and
                detail.get("id") == identifier and git.get("sha") == row["sourceCommit"] and git.get("type") == "github" and
                str(git.get("repoId")) == vercel.REPOSITORY_ID, "RELATED_PREVIEW_SOURCE_BINDING_REFUSED")
            outcome["uncertainDeploymentId"] = identifier
            deleted = client.request("DELETE", "/v13/deployments/" + identifier)
            demand(deleted.get("state") == "DELETED" and deleted.get("uid") == identifier, "RELATED_PREVIEW_DELETE_ACK_UNVERIFIED")
            migrate.write_json(attempt, "related-" + identifier + "-deleted.json", {**selected, **binding[0], "state": "DELETED"})
            outcome["deletedDeploymentIds"].append(identifier); outcome["uncertainDeploymentId"] = None
            demand(vercel.promotion_state(client, project["projectId"]) == original["projectState"], "RELATED_PRODUCTION_STATE_CHANGED")
        for project in context["bindings"].get("relatedProjects", []):
            expected_rows = [row for row in project["deployments"] if row["deploymentId"] not in outcome["deletedDeploymentIds"]]
            demand(deployment_inventory(client, project["projectId"]) == deployment_inventory(client, project["projectId"]) == expected_rows,
                "RELATED_PREVIEW_ABSENCE_UNVERIFIED")
        outcome.update(status="STAGING_RELATED_PREVIEW_INGRESS_RETIRED", deletedDeploymentIds=sorted(outcome["deletedDeploymentIds"]))
        return outcome
    finally:
        migrate.write_json(attempt, "related-preview-retirements-outcome.json", outcome)


def observe_vercel(context, client, attempt=None):
    selected = identity(context)
    before = vercel.promotion_state(client, selected["projectId"])
    first = deployment_inventory(client, selected["projectId"])
    second = deployment_inventory(client, selected["projectId"])
    after = vercel.promotion_state(client, selected["projectId"])
    demand(first == second and before == after, "VERCEL_PROVIDER_CHANGED_DURING_INVENTORY")
    retired = retired_deployments(context, attempt)
    expected = [row for row in context["bindings"]["deployments"] if row["deploymentId"] not in retired]
    known_ids = {row["deploymentId"] for row in expected}
    # One build created by this action may appear after the reviewed initial
    # inventory. Verify it through the existing exact source/project binding.
    staged, build = [], action_build(context, attempt)
    attempts = [attempt] if attempt is not None else []
    if attempt is not None and attempt.name != "vercel-bootstrap":
        attempts.append(attempt.parent / "vercel-bootstrap")
    for source_attempt in attempts:
        action = action_build(context, source_attempt)
        if action is not None and action["status"] == "FRONTEND_STAGED":
            item = vercel._staged_identity(context["candidate"], source_attempt)
            state = vercel.deployment_state(client, item["deploymentId"], item["projectId"], item["sourceCommit"], item["releaseId"])
            if state["readyState"] == "READY":
                staged.append(item)
    baseline = [row for row in first if row["deploymentId"] in known_ids]
    extras = [row for row in first if row["deploymentId"] not in known_ids]
    inventory_matches = baseline == expected and all(any(row["deploymentId"] == item["deploymentId"] and
        row["sourceCommit"] == selected["sourceCommit"] for item in staged) for row in extras)
    original = context["bindings"]["projectState"]
    allowed_current = [original["productionDeploymentId"]] + [item["deploymentId"] for item in staged]
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
              "historicalIngressRetiredDeploymentIds": retired,
              "aliasJobActive": alias is not None and alias["jobStatus"] in ("pending", "in-progress")}
    if "relatedProjects" in context["bindings"] or any(row.get("sourceConfiguration") for row in context["bindings"].get("historicalRuntimeBindings", [])):
        projects = repository_project_inventory(client)
        demand(projects == repository_project_inventory(client), "REPOSITORY_PROJECT_INVENTORY_DRIFT")
        expected_projects = sorted([selected["projectId"], *[row["projectId"] for row in context["bindings"].get("relatedProjects", [])]])
        result["repositoryProjectIds"] = projects
        result["reviewedInventoryMatches"] = result["reviewedInventoryMatches"] and projects == expected_projects
    related = observe_related_projects(context, client, attempt)
    result["relatedProjects"] = related
    result["reviewedInventoryMatches"] = result["reviewedInventoryMatches"] and all(row["reviewedInventoryMatches"] for row in related)
    result["historicalIngressRetiredDeploymentIds"] += related_retirements(context, attempt)
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


def write_source_pins(context, client, attempt, receipt_sha, receipt_kind):
    selected = identity(context)
    outcome = {**selected, "status": "SOURCE_PINS_FAILED_REQUIRES_REVIEW", "receiptSha256": receipt_sha, "receiptKind": receipt_kind,
               "configuredKeys": [], "trafficAuthorized": False}
    migrate.write_json(attempt, "source-pins-started.json", outcome)
    keys = ("STAGING_RELEASE_COMMIT", "STAGING_MIGRATION_VERIFIED_COMMIT")
    try:
        for key in keys:
            value = client.request("POST", f'/v10/projects/{selected["projectId"]}/env?upsert=true', {
                "key": key, "value": selected["sourceCommit"], "type": "plain", "target": ["production"],
                "gitBranch": None, "customEnvironmentIds": [], "comment": "Verified frontend source " + selected["actionId"]})
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


def configure_pending_source_pins(context, client, attempt, parent_directory):
    selected = identity(context)
    database = context["database"]
    raw = migrate.read_input(parent_directory, "database-receipt.json")
    stored = json.loads(raw)
    migrate.require_contract_identity(context["candidate"], database, stored)
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
    return write_source_pins(context, client, attempt, migrate.file_hash(raw), "verified-pending-application-sql")


def configure_bootstrap(context, client, attempt, parent_directory):
    selected = identity(context)
    raw = migrate.read_input(parent_directory, "frontend-preapplication-schema.json")
    receipt, reviewed = json.loads(raw), context["plan"]["bootstrapCompatibility"]
    demand(receipt == context.get("preapplicationSchema") and receipt.get("status") == "FRONTEND_PREAPPLICATION_SCHEMA_VERIFIED"
        and all(receipt.get(key) == selected[key] for key in ("environment", "actionId", "sourceCommit", "targetSha256"))
        and all(receipt.get(key) == reviewed[key] for key in ("schemaCatalogSha256", "appliedLineageSha256", "appliedCount", "validationEvidenceSha256"))
        and receipt.get("applicationSqlApplied") is False and receipt.get("migrationAuthorized") is False,
        "PREAPPLICATION_SCHEMA_RECEIPT_REQUIRED")
    write_source_pins(context, client, attempt, migrate.file_hash(raw), "verified-preapplication-schema-only")
    target = context["writerTarget"]
    demand(target.get("environment") == "staging" and target.get("targetSha256") == selected["targetSha256"], "BOOTSTRAP_RUNTIME_TARGET_REQUIRED")
    variables = [(key, "false", "plain") for key in BOOTSTRAP_FLAGS] + [
        ("LASH_P2_CERTIFICATION_SCHEDULES", "off", "plain"),
        ("FRONTEND_WRITER_ADMISSION_MODE", "enforce", "plain"),
        ("FRONTEND_WRITER_ADMISSION_TARGET_JSON", json.dumps(target, separators=(",", ":")), "plain"),
        ("FRONTEND_WRITER_PRODUCER_SHA256", reviewed["runtimeProducerSha256"], "plain"),
        ("FRONTEND_WRITER_ADMISSION_DATABASE_URL", context["frontendRuntimeDatabaseUrl"], "sensitive"),
        ("DATABASE_URL", context["frontendRuntimeDatabaseUrl"], "sensitive")]
    if context["bindings"].get("resendRetirement") is not None:
        reviewed_resend = context["bindings"]["resendRetirement"]
        demand(isinstance(context.get("resendReplacementToken"), str), "RESEND_BOOTSTRAP_REPLACEMENT_REQUIRED")
        variables.extend([("RESEND_API_KEY", context["resendReplacementToken"], "sensitive"),
            ("LASH_RELEASE_RESEND_DOMAIN_ID", reviewed_resend["domainId"], "plain"),
            ("LASH_RELEASE_RESEND_DOMAIN_NAME", reviewed_resend["domainName"], "plain")])
    if context["bindings"].get("squareRetirement") is not None:
        reviewed_square = context["bindings"]["squareRetirement"]
        demand(isinstance(context.get("squareReplacementToken"), str), "SQUARE_BOOTSTRAP_REPLACEMENT_REQUIRED")
        variables.extend([("SQUARE_ACCESS_TOKEN", context["squareReplacementToken"], "sensitive"),
            ("SQUARE_ENVIRONMENT", "sandbox", "plain"), ("SQUARE_LOCATION_ID", reviewed_square["locationId"], "plain"),
            ("SQUARE_APPLICATION_ID", reviewed_square["applicationId"], "plain"),
            ("LASH_RELEASE_SQUARE_MERCHANT_ID", reviewed_square["merchantId"], "plain")])
    if context["bindings"].get("googleRetirement") is not None:
        variables.extend([("AUTH_GOOGLE_ID", frontend_google_fencing.CLIENTS["identity"], "plain"),
            ("AUTH_GOOGLE_SECRET", context["googleIdentityReplacementSecret"], "sensitive"),
            ("GOOGLE_CLIENT_ID", frontend_google_fencing.CLIENTS["calendar"], "plain"),
            ("GOOGLE_CLIENT_SECRET", context["googleCalendarReplacementSecret"], "sensitive")])
        if context["bindings"]["googleRetirement"].get("legacyCalendarSha256") is not None:
            variables.append(("GOOGLE_CALENDAR_ID", context["googleLegacyCalendarId"], "sensitive"))
    outcome = {**selected, "status": "BOOTSTRAP_CONFIGURATION_REQUIRES_REVIEW", "configuredKeys": [], "trafficAuthorized": False}
    migrate.write_json(attempt, "bootstrap-configuration-started.json", outcome)
    try:
        for key, value, kind in variables:
            result = client.request("POST", f'/v10/projects/{selected["projectId"]}/env?upsert=true', {
                "key": key, "value": value, "type": kind, "target": ["production"], "gitBranch": None,
                "customEnvironmentIds": [], "comment": "Closed admission bootstrap " + selected["actionId"]})
            created = result.get("created")
            demand(result.get("failed") == [] and isinstance(created, dict) and created.get("key") == key and created.get("type") == kind
                and created.get("target") == ["production"] and not created.get("gitBranch") and not created.get("customEnvironmentIds"),
                "BOOTSTRAP_CONFIGURATION_UNVERIFIED")
        readback = client.request("GET", f'/v10/projects/{selected["projectId"]}/env?decrypt=false').get("envs")
        demand(isinstance(readback, list), "BOOTSTRAP_CONFIGURATION_UNVERIFIED")
        for key, value, kind in variables:
            rows = [row for row in readback if row.get("key") == key and row.get("target") == ["production"] and
                not row.get("gitBranch") and not row.get("customEnvironmentIds")]
            demand(len(rows) == 1 and rows[0].get("type") == kind and (kind == "sensitive" or rows[0].get("value") == value),
                "BOOTSTRAP_CONFIGURATION_UNVERIFIED")
        outcome.update(status="BOOTSTRAP_CONFIGURATION_VERIFIED", configuredKeys=[key for key, _value, _kind in variables])
        return outcome
    finally:
        migrate.write_json(attempt, "bootstrap-configuration-outcome.json", outcome)


def verify_bootstrap(context, client, attempt, private, probe):
    identity_value = vercel._staged_identity(context["candidate"], attempt)
    receipt = context["preapplicationSchema"]
    outcome = {**identity_value, "status": "FRONTEND_VERIFICATION_REQUIRES_REVIEW", "bootstrapAdmissionVerified": False,
        "trafficAuthorized": False, "schemaCatalogSha256": receipt["schemaCatalogSha256"],
        "appliedLineageSha256": receipt["appliedLineageSha256"]}
    try:
        state = vercel.deployment_state(client, identity_value["deploymentId"], identity_value["projectId"], identity_value["sourceCommit"], identity_value["releaseId"])
        credential = frontend_probe._private_input(private, identity_value)
        project = vercel._project(client, identity_value["projectId"])
        demand(state["readyState"] == "READY" and (project.get("targets") or {}).get("production", {}).get("id") == identity_value["previousDeploymentId"]
            and (project.get("crons") or {}).get("disabledAt") is not None, "BOOTSTRAP_PROBE_PROJECT_CHANGED")
        challenge = secrets.token_hex(32)
        observed = probe.request(state["url"], credential["secret"], frontend_probe._automation_bypass(project), challenge, "admission-bootstrap")
        admission = observed.get("admission") or {}
        demand(observed.get("version") == 1 and observed.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and observed.get("challenge") == challenge
            and observed.get("checks") == ["gateway-course-catalog", "frontend-admission-bootstrap"]
            and all(observed.get(key) == identity_value[key] for key in ("environment", "projectId", "sourceCommit"))
            and observed.get("gatewayOrigin") == credential["gatewayOrigin"] and observed.get("schemaCatalogSha256") == receipt["schemaCatalogSha256"]
            and observed.get("featureControls") == {key: False for key in BOOTSTRAP_FLAGS}
            and admission.get("environment") == "staging" and admission.get("targetSha256") == context["plan"]["targetSha256"]
            and admission.get("producerSha256") == context["plan"]["bootstrapCompatibility"]["runtimeProducerSha256"]
            and admission.get("sourceCommit") == identity_value["sourceCommit"] and admission.get("newWork") is False and admission.get("recovery") is False
            and admission.get("epoch") == context["admissionObservation"]["epoch"], "BOOTSTRAP_ADMISSION_PROBE_UNVERIFIED")
        outcome.update(status="FRONTEND_VERIFIED", bootstrapAdmissionVerified=True, checks=observed["checks"])
        if migrate.contract_identity(context["candidate"]).get("contractPhase") == "p2":
            outcome.update(**migrate.contract_identity(context["candidate"]), featureControls=observed["featureControls"])
        return outcome
    finally:
        migrate.write_json(attempt, "frontend-workload-outcome.json", outcome)


def deploy_admission(context, client, attempt, parent_directory, probe):
    observed = observe_vercel(context, client, attempt)
    demand(observed["reviewedInventoryMatches"] and observed["reviewedProjectMatches"], "VERCEL_REVIEWED_INVENTORY_CHANGED")
    demand(observed["projectState"]["cronsEnabled"] is False and not observed["aliasJobActive"], "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
    demand(context.get("gatewayHost") == context["bindings"].get("gatewayHost"), "REVIEWED_FRONTEND_GATEWAY_BINDING_REQUIRED")
    private = Path(context["privateConfigurationDirectory"]) / "admission-bootstrap"
    if not private.exists():
        private.mkdir(mode=0o700)
    frontend_probe._private_configuration(private)
    configure_bootstrap(context, client, attempt, parent_directory)
    frontend_probe.prepare(client, context["candidate"], private, attempt, context["gatewayHost"], scheduler_qualification=False)
    vercel.stage_frontend(client, context["candidate"], attempt)
    return vercel.promote_frontend(client, context["candidate"], attempt,
        lambda _release, _deployment: verify_bootstrap(context, client, attempt, private, probe))


def retire_deployments(context, client, attempt):
    selected = identity(context)
    reviewed = context["bindings"].get("deploymentRetirement")
    demand(isinstance(reviewed, dict) and reviewed.get("preserveBootstrapDeployment") is True and
        isinstance(reviewed.get("retireDeploymentIds"), list) and reviewed["retireDeploymentIds"], "VERCEL_EXACT_RETIREMENT_PLAN_REQUIRED")
    bootstrap_attempt = attempt.parent / "vercel-bootstrap"
    # Preserve the now-current, source-bound, actual protected-probe-qualified
    # admission deployment. Old C07 cannot count as this recovery boundary.
    bootstrap = observe_compatible(context, client, bootstrap_attempt)
    demand(bootstrap.get("bootstrapAdmissionVerified") is True and bootstrap.get("workloadVerified") is True and
        bootstrap.get("aliasJobMatchesIntent") is True and bootstrap.get("aliasJobState") == "succeeded" and
        bootstrap.get("aliasDeploymentId") == bootstrap.get("deploymentId") and bootstrap.get("nativeSchedulesEnabled") is False,
        "ADMISSION_COMPATIBLE_BOOTSTRAP_REQUIRED_BEFORE_RETIREMENT")
    protected_id = bootstrap["deploymentId"]
    retired, preserved = reviewed["retireDeploymentIds"], reviewed.get("preserveDeploymentIds", [])
    originals = context["bindings"]["deployments"]
    demand(protected_id not in retired and len(set(retired + preserved)) == len(originals) and
        sorted(retired + preserved) == sorted(row["deploymentId"] for row in originals), "VERCEL_RETIREMENT_PARTITION_REFUSED")
    observed = observe_vercel(context, client, attempt)
    demand(observed["reviewedInventoryMatches"] and observed["reviewedProjectMatches"] and not observed["aliasJobActive"],
        "VERCEL_REVIEWED_INVENTORY_CHANGED")
    before = observed["projectState"]
    expected = observed["deployments"]
    outcome = {**selected, "status": "HISTORICAL_RETIREMENT_FAILED_REQUIRES_REVIEW", "deletedDeploymentIds": [],
        "preservedDeploymentIds": sorted(preserved + [protected_id]), "uncertainDeploymentId": None,
        "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None, "trafficAuthorized": False}
    migrate.write_json(attempt, "historical-deployments-started.json", {**outcome, "retireDeploymentIds": retired})
    try:
        for deployment_id in retired:
            demand(deployment_id != before["productionDeploymentId"] and deployment_id not in preserved, "VERCEL_CURRENT_OR_RECOVERY_RETIREMENT_REFUSED")
            demand(vercel.promotion_state(client, selected["projectId"]) == before and
                deployment_inventory(client, selected["projectId"]) == expected, "VERCEL_RETIREMENT_PROVIDER_DRIFT")
            bound = next(row for row in originals if row["deploymentId"] == deployment_id)
            detail = client.request("GET", f"/v13/deployments/{deployment_id}?withGitRepoInfo=true")
            git = detail.get("gitSource") or {}
            demand(detail.get("id") == deployment_id and detail.get("projectId") == selected["projectId"] and
                isinstance(git, dict) and git.get("type") == "github" and str(git.get("repoId")) == vercel.REPOSITORY_ID and
                bound["sourceCommit"] is not None and git.get("sha") == bound["sourceCommit"], "VERCEL_HISTORICAL_SOURCE_BINDING_REFUSED")
            outcome["uncertainDeploymentId"] = deployment_id
            value = client.request("DELETE", f"/v13/deployments/{deployment_id}")
            demand(value.get("state") == "DELETED" and value.get("uid") == deployment_id, "VERCEL_HISTORICAL_DELETE_ACK_UNVERIFIED")
            migrate.write_json(attempt, f"historical-{deployment_id}-deleted.json", {**selected, "deploymentId": deployment_id, "state": "DELETED"})
            outcome["deletedDeploymentIds"].append(deployment_id); outcome["uncertainDeploymentId"] = None
            expected = [row for row in expected if row["deploymentId"] != deployment_id]
        first, second = deployment_inventory(client, selected["projectId"]), deployment_inventory(client, selected["projectId"])
        demand(first == second == expected and vercel.promotion_state(client, selected["projectId"]) == before, "VERCEL_RETIREMENT_ABSENCE_UNVERIFIED")
        outcome.update(status="STAGING_HISTORICAL_INGRESS_RETIRED", remainingInventorySha256=migrate.file_hash(json.dumps(first, separators=(",", ":")).encode()))
        return outcome
    finally:
        migrate.write_json(attempt, "historical-deployments-outcome.json", outcome)


def verify_resend_runtime(context, client, attempt, probe):
    bootstrap_attempt = attempt.parent / "vercel-bootstrap"
    observed = observe_compatible(context, client, bootstrap_attempt)
    demand(observed.get("bootstrapAdmissionVerified") is True and observed.get("workloadVerified") is True and
        observed.get("aliasJobMatchesIntent") is True and observed.get("aliasDeploymentId") == observed.get("deploymentId") and
        observed.get("aliasJobState") == "succeeded", "RESEND_ADMISSION_BOOTSTRAP_REQUIRED")
    staged = vercel._staged_identity(context["candidate"], bootstrap_attempt)
    private = frontend_probe._private_input(Path(context["privateConfigurationDirectory"]) / "admission-bootstrap", staged)
    project = vercel._project(client, staged["projectId"])
    state = vercel.deployment_state(client, staged["deploymentId"], staged["projectId"], staged["sourceCommit"], staged["releaseId"])
    challenge = secrets.token_hex(32)
    value = probe.request(state["url"], private["secret"], frontend_probe._automation_bypass(project), challenge, "resend-binding")
    reviewed = context["bindings"]["resendRetirement"]
    demand(value.get("version") == 1 and value.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and value.get("challenge") == challenge and
        all(value.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit")) and
        value.get("gatewayOrigin") == private["gatewayOrigin"] and
        value.get("checks") == ["gateway-course-catalog", "frontend-admission-bootstrap", "resend-binding"] and
        value.get("resendBinding") == {"domainId": reviewed["domainId"], "domainName": reviewed["domainName"], "domainStatus": "verified"} and
        value.get("featureControls") == {key: False for key in BOOTSTRAP_FLAGS} and
        value.get("admission", {}).get("targetSha256") == context["plan"]["targetSha256"] and
        value.get("admission", {}).get("sourceCommit") == staged["sourceCommit"] and
        value.get("admission", {}).get("producerSha256") == context["plan"]["bootstrapCompatibility"]["runtimeProducerSha256"] and
        value.get("admission", {}).get("epoch") == context["admissionObservation"]["epoch"] and
        value.get("admission", {}).get("newWork") is False and value.get("admission", {}).get("recovery") is False,
        "RESEND_RUNTIME_REPLACEMENT_BINDING_UNVERIFIED")
    return {**identity(context), "status": "STAGING_RESEND_RUNTIME_BINDING_VERIFIED", "deploymentId": staged["deploymentId"],
        "domainId": reviewed["domainId"], "domainName": reviewed["domainName"], "runtimeReplacementBindingVerified": True,
        "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None, "trafficAuthorized": False}


def verify_square_runtime(context, client, attempt, probe):
    bootstrap_attempt = attempt.parent / "vercel-bootstrap"
    observed = observe_compatible(context, client, bootstrap_attempt)
    demand(observed.get("bootstrapAdmissionVerified") is True and observed.get("workloadVerified") is True and
        observed.get("aliasJobMatchesIntent") is True and observed.get("aliasDeploymentId") == observed.get("deploymentId") and
        observed.get("aliasJobState") == "succeeded", "SQUARE_ADMISSION_BOOTSTRAP_REQUIRED")
    staged = vercel._staged_identity(context["candidate"], bootstrap_attempt)
    private = frontend_probe._private_input(Path(context["privateConfigurationDirectory"]) / "admission-bootstrap", staged)
    project = vercel._project(client, staged["projectId"])
    state = vercel.deployment_state(client, staged["deploymentId"], staged["projectId"], staged["sourceCommit"], staged["releaseId"])
    challenge = secrets.token_hex(32)
    value = probe.request(state["url"], private["secret"], frontend_probe._automation_bypass(project), challenge, "square-binding")
    reviewed = context["bindings"]["squareRetirement"]
    demand(value.get("version") == 1 and value.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and value.get("challenge") == challenge and
        all(value.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit")) and
        value.get("gatewayOrigin") == private["gatewayOrigin"] and
        value.get("checks") == ["gateway-course-catalog", "frontend-admission-bootstrap", "square-binding"] and
        value.get("squareBinding") == {"environment": "sandbox", "locationId": reviewed["locationId"], "merchantId": reviewed["merchantId"], "applicationId": reviewed["applicationId"], "currency": "CAD", "country": "CA", "locationStatus": "ACTIVE"} and
        value.get("featureControls") == {key: False for key in BOOTSTRAP_FLAGS} and
        value.get("admission", {}).get("targetSha256") == context["plan"]["targetSha256"] and
        value.get("admission", {}).get("sourceCommit") == staged["sourceCommit"] and
        value.get("admission", {}).get("producerSha256") == context["plan"]["bootstrapCompatibility"]["runtimeProducerSha256"] and
        value.get("admission", {}).get("epoch") == context["admissionObservation"]["epoch"] and
        value.get("admission", {}).get("newWork") is False and value.get("admission", {}).get("recovery") is False,
        "SQUARE_RUNTIME_REPLACEMENT_BINDING_UNVERIFIED")
    return {**identity(context), "status": "STAGING_SQUARE_RUNTIME_BINDING_VERIFIED", "deploymentId": staged["deploymentId"],
        "locationId": reviewed["locationId"], "merchantId": reviewed["merchantId"], "applicationId": reviewed["applicationId"], "runtimeReplacementBindingVerified": True,
        "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None, "trafficAuthorized": False}


def verify_google_runtime(context, client, attempt, probe):
    bootstrap_attempt = attempt.parent / "vercel-bootstrap"
    observed = observe_compatible(context, client, bootstrap_attempt)
    demand(observed.get("bootstrapAdmissionVerified") is True and observed.get("workloadVerified") is True and
        observed.get("aliasJobMatchesIntent") is True and observed.get("aliasDeploymentId") == observed.get("deploymentId") and
        observed.get("aliasJobState") == "succeeded", "GOOGLE_ADMISSION_BOOTSTRAP_REQUIRED")
    staged = vercel._staged_identity(context["candidate"], bootstrap_attempt)
    private = frontend_probe._private_input(Path(context["privateConfigurationDirectory"]) / "admission-bootstrap", staged)
    project = vercel._project(client, staged["projectId"])
    state = vercel.deployment_state(client, staged["deploymentId"], staged["projectId"], staged["sourceCommit"], staged["releaseId"])
    challenge = secrets.token_hex(32)
    value = probe.request(state["url"], private["secret"], frontend_probe._automation_bypass(project), challenge, "google-binding")
    google = value.get("googleBinding", {})
    demand(value.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and value.get("challenge") == challenge and
        all(value.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit")) and
        value.get("gatewayOrigin") == private["gatewayOrigin"] and
        value.get("checks") == ["gateway-course-catalog", "frontend-admission-bootstrap", "google-binding"] and
        value.get("featureControls") == {key: False for key in BOOTSTRAP_FLAGS} and
        value.get("admission", {}).get("epoch") == context["admissionObservation"]["epoch"] and
        value.get("admission", {}).get("targetSha256") == context["plan"]["targetSha256"] and
        value.get("admission", {}).get("sourceCommit") == staged["sourceCommit"] and
        value.get("admission", {}).get("producerSha256") == context["plan"]["bootstrapCompatibility"]["runtimeProducerSha256"] and
        value.get("admission", {}).get("newWork") is False and value.get("admission", {}).get("recovery") is False and
        google.get("projectId") == "lash-her-staging-20261022" and google.get("projectNumber") == "185770842371",
        "GOOGLE_RUNTIME_REPLACEMENT_BINDING_UNVERIFIED")
    for kind, client_id in frontend_google_fencing.CLIENTS.items():
        selected = google.get(kind, {})
        expected = hmac.new(context["google" + kind.capitalize() + "ReplacementSecret"].encode(),
            ("lash-her:frontend-google-binding:v1:" + kind + ":" + challenge).encode(), hashlib.sha256).hexdigest()
        demand(selected.get("clientId") == client_id and isinstance(selected.get("proof"), str) and hmac.compare_digest(selected["proof"], expected),
            "GOOGLE_RUNTIME_PRIVATE_EQUALITY_UNVERIFIED")
    demand(google["calendar"].get("calendarIdSha256") == context["bindings"]["googleRetirement"]["legacyCalendarSha256"],
        "GOOGLE_RUNTIME_DEFAULT_CALENDAR_BINDING_UNVERIFIED")
    # The challenge and proof are private, transient comparison material. Never
    # write them or a credential-derived digest into reviewed/common receipts.
    return {**identity(context), "status": "STAGING_GOOGLE_ADMIN_AND_CALENDAR_RUNTIME_BINDING_VERIFIED", "deploymentId": staged["deploymentId"],
        "identityClientId": frontend_google_fencing.CLIENTS["identity"], "calendarClientId": frontend_google_fencing.CLIENTS["calendar"],
        "runtimeReplacementBindingVerified": True, "customerIdentityBindingVerified": False}


def compatible_feature_controls(context):
    selected = context["candidate"]
    profile = context["plan"].get("certification")
    if profile is not None:
        demand(migrate.contract_identity(selected).get("contractPhase") == "p2", "P2_CERTIFICATION_CONTRACT_REQUIRED")
        return p2_certification_profile.require_profile(profile)["featureControls"]
    return {key: False for key in BOOTSTRAP_FLAGS}


def compatible_writer_admission_binding(context):
    if migrate.contract_identity(context["candidate"]).get("contractPhase") != "p2":
        return None
    target = context.get("writerTarget") or {}
    result = {"mode": "enforce", "targetSha256": context["plan"]["targetSha256"],
        "producerSha256": context["plan"].get("runtimeProducerSha256") or (context["plan"].get("bootstrapCompatibility") or {}).get("runtimeProducerSha256"),
        "sourceCommit": context["plan"]["sourceCommit"], "roleName": target.get("user")}
    demand(target.get("environment") == "staging" and target.get("targetSha256") == result["targetSha256"] and
        frontend_probe.valid_writer_admission_binding(result), "P2_REVIEWED_WRITER_ADMISSION_BINDING_REQUIRED")
    return result


def require_runtime_database_binding(context):
    try:
        target, raw = context["writerTarget"], context["frontendRuntimeDatabaseUrl"]
        url = urllib.parse.urlsplit(raw)
        demand(url.scheme in ("postgres", "postgresql") and url.hostname == target["host"] and (url.port or 5432) == target["port"] and
            urllib.parse.unquote(url.path) == "/" + target["database"] and urllib.parse.unquote(url.username or "") == target["user"] and
            bool(url.password) and not url.fragment and urllib.parse.parse_qsl(url.query, keep_blank_values=True) == [("sslmode", "verify-full")],
            "P2_RUNTIME_DATABASE_BINDING_REQUIRED")
        return raw
    except (KeyError, TypeError, ValueError):
        raise ValueError("P2_RUNTIME_DATABASE_BINDING_REQUIRED") from None


def configure_compatible_features(context, client, attempt):
    # Only the reviewed post-SQL certification profile may enable these flags.
    # The bootstrap build remains all-false and project native crons stay off.
    controls = compatible_feature_controls(context)
    if migrate.contract_identity(context["candidate"]).get("contractPhase") != "p2":
        return
    selected = identity(context)
    expected_writer = compatible_writer_admission_binding(context)
    runtime_url = require_runtime_database_binding(context)
    variables = [(key, "true" if value else "false", "plain") for key, value in controls.items()] + [
        ("LASH_P2_CERTIFICATION_SCHEDULES", "account-lifecycle" if context["plan"].get("certification") else "off", "plain"),
        ("FRONTEND_WRITER_ADMISSION_MODE", "enforce", "plain"),
        ("FRONTEND_WRITER_ADMISSION_TARGET_JSON", json.dumps(context["writerTarget"], separators=(",", ":")), "plain"),
        ("FRONTEND_WRITER_PRODUCER_SHA256", expected_writer["producerSha256"], "plain"),
        ("FRONTEND_WRITER_ADMISSION_DATABASE_URL", runtime_url, "sensitive"), ("DATABASE_URL", runtime_url, "sensitive")]
    outcome = {**selected, "status": "P2_FEATURE_CONFIGURATION_REQUIRES_REVIEW", "featureControls": controls,
        "nativeSchedulesEnabled": False, "expectedWriterAdmissionBinding": expected_writer, "trafficAuthorized": False}
    migrate.write_json(attempt, "certification-features-started.json", outcome)
    try:
        demand(vercel.promotion_state(client, selected["projectId"])["cronsEnabled"] is False, "P2_NATIVE_SCHEDULES_MUST_REMAIN_OFF")
        for key, value, kind in variables:
            result = client.request("POST", f'/v10/projects/{selected["projectId"]}/env?upsert=true', {
                "key": key, "value": value, "type": kind, "target": ["production"], "gitBranch": None,
                "customEnvironmentIds": [], "comment": "Reviewed P2 staging certification " + selected["actionId"]})
            row = result.get("created")
            demand(result.get("failed") == [] and isinstance(row, dict) and row.get("key") == key and row.get("type") == kind
                and row.get("target") == ["production"] and not row.get("gitBranch") and not row.get("customEnvironmentIds"),
                "P2_FEATURE_CONFIGURATION_UNVERIFIED")
        rows = client.request("GET", f'/v10/projects/{selected["projectId"]}/env?decrypt=false').get("envs")
        demand(isinstance(rows, list), "P2_FEATURE_CONFIGURATION_UNVERIFIED")
        for key, value, kind in variables:
            found = [row for row in rows if row.get("key") == key and row.get("target") == ["production"] and
                not row.get("gitBranch") and not row.get("customEnvironmentIds")]
            demand(len(found) == 1 and found[0].get("type") == kind and (kind == "sensitive" or found[0].get("value") == value),
                "P2_FEATURE_CONFIGURATION_UNVERIFIED")
        demand(vercel.promotion_state(client, selected["projectId"])["cronsEnabled"] is False, "P2_NATIVE_SCHEDULES_MUST_REMAIN_OFF")
        outcome["status"] = "P2_FEATURE_CONFIGURATION_VERIFIED"
    finally:
        migrate.write_json(attempt, "certification-features-outcome.json", outcome)


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
    if migrate.contract_identity(context["candidate"]).get("contractPhase") == "p2":
        compatible_writer_admission_binding(context)
        require_runtime_database_binding(context)
    configure_pending_source_pins(context, client, attempt, parent_directory)
    configure_compatible_features(context, client, attempt)
    frontend_probe.prepare(client, context["candidate"], private, attempt, context["gatewayHost"], scheduler_qualification=False)
    vercel.stage_frontend(client, context["candidate"], attempt)
    return vercel.promote_frontend(client, context["candidate"], attempt,
        lambda release, _deployment: frontend_probe.verify(client, release, attempt, private, probe,
            expected_feature_controls=compatible_feature_controls(context) if migrate.contract_identity(release).get("contractPhase") == "p2" else None,
            expected_writer_admission_binding=compatible_writer_admission_binding(context)))


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
        if workload.get("contractPhase") == "p2":
            migrate.require_contract_identity(context["candidate"], workload)
            controls = {key: False for key in BOOTSTRAP_FLAGS} if workload.get("bootstrapAdmissionVerified") is True else compatible_feature_controls(context)
            outcome["workloadVerified"] = outcome["workloadVerified"] and workload.get("featureControls") == controls
            outcome["featureControls"] = workload.get("featureControls")
            if workload.get("bootstrapAdmissionVerified") is not True:
                expected_writer = compatible_writer_admission_binding(context)
                outcome["workloadVerified"] = outcome["workloadVerified"] and workload.get("writerAdmissionBinding") == expected_writer
                outcome["writerAdmissionBinding"] = workload.get("writerAdmissionBinding")
                # This is the actual source-produced nonsecret runtime-config
                # observation, already bound to this exact deployed workload.
                outcome["configurationRecordSha256"] = migrate.file_hash(raw)
        if workload.get("bootstrapAdmissionVerified") is True:
            outcome.update(bootstrapAdmissionVerified=True, schemaCatalogSha256=workload.get("schemaCatalogSha256"),
                appliedLineageSha256=workload.get("appliedLineageSha256"))
    if context["plan"].get("certification") is not None and outcome.get("bootstrapAdmissionVerified") is not True and outcome["workloadVerified"]:
        p2_certification_profile.require_profile(context["plan"]["certification"])
        project = vercel._project(client, selected["projectId"])
        cron = project.get("crons") or {}
        expected = {"path": "/api/cron/account-lifecycle", "schedule": "* * * * *", "host": state["url"].removeprefix("https://")}
        definitions = cron.get("definitions")
        demand((project.get("targets") or {}).get("production", {}).get("id") == staged["deploymentId"] and
            cron.get("deploymentId") == staged["deploymentId"] and cron.get("disabledAt") is not None and
            isinstance(definitions, list) and len(definitions) == 1 and
            all(definitions[0].get(key) == value for key, value in expected.items()), "P2_EXACT_DEPLOYMENT_LIFECYCLE_SCHEDULE_REQUIRED")
        outcome["certificationSchedule"] = {**expected, "deploymentId": staged["deploymentId"], "nativeEnabled": False,
            "definitionsSha256": migrate.file_hash(json.dumps(definitions, separators=(",", ":")).encode())}
    # Admission values are supplied only after the parent's actual post-SQL
    # closed-ledger observation; provider metadata cannot observe the ledger.
    controls = context.get("admissionObservation")
    if isinstance(controls, dict) and type(controls.get("active")) is int and controls["active"] >= 0 and type(controls.get("uncertain")) is int and controls["uncertain"] >= 0 and type(controls.get("newWork")) is bool and type(controls.get("recovery")) is bool:
        outcome.update(admissionNewWork=controls.get("newWork"), admissionRecovery=controls.get("recovery"))
    return outcome


def execute(context, client, verify, probe=None):
    selected = identity(context)
    parent = Path(context["directory"])
    migrate.private_directory(parent)
    demand(not any((p / ".git").exists() for p in (parent.resolve(), *parent.resolve().parents)), "PROVIDER_RECEIPTS_OUTSIDE_CHECKOUT_REQUIRED")
    operation = context["operation"]
    attempt = parent / ("vercel-bootstrap" if operation in ("deploy-admission", "observe-admission") else "vercel")
    if not attempt.exists():
        attempt.mkdir(mode=0o700)
    migrate.private_directory(attempt)
    locked = LockedClient(client, verify)
    source_attempt = attempt
    if context.get("originalDirectory") is not None:
        demand(operation in ("observe-vercel", "observe-retired-capabilities", "observe-compatible", "observe-admission", "observe-resend", "observe-resend-effects", "observe-square", "observe-sanity", "observe-google", "observe-highlevel", "observe-chitchats"), "RECOVERY_PROVIDER_MUTATION_REFUSED")
        original = Path(context["originalDirectory"])
        migrate.private_directory(original)
        source_attempt = original / attempt.name
        if source_attempt.exists():
            migrate.private_directory(source_attempt)
    if operation == "observe-provider-effects":
        import frontend_scoped_provider_client
        import frontend_square_financial_scope
        import frontend_resend_marketing_scope
        import frontend_highlevel_history
        import frontend_chitchats_transient_effects
        modules = {"square": frontend_square_financial_scope, "resend": frontend_resend_marketing_scope,
            "highlevel": frontend_highlevel_history, "chitchats": frontend_chitchats_transient_effects}
        scope = context["providerEffectScope"]
        provider, reviewed = scope["provider"], context["scopedReviewed"]
        demand(provider in modules and any(row == scope for row in context["bindings"].get("providerEffectScopes", [])),
            "REVIEWED_PROVIDER_EFFECT_SCOPE_REQUIRED")
        module = modules[provider]
        requirements = context["scopedSourceRequirements"]
        demand(all(isinstance(requirements.get(key), list) for key in ("unresolvedFrontendSqlFamilyIds", "unresolvedExternalCapabilityFamilyIds", "unresolvedFamilyIds")),
            "PROVIDER_EFFECT_SCOPED_RESIDUAL_CHANNELS_REQUIRED")
        demand(all(scope[key] == requirements[key] for key in ("sourceCommit", "surfaceSha256", "sourceInventorySha256", "requirementsSha256")),
            "PROVIDER_EFFECT_SOURCE_BINDING_REFUSED")
        class UnavailableReadClient:
            def request(self, *_args, **_kwargs):
                raise ValueError("SELECTED_PROVIDER_READ_CREDENTIAL_UNAVAILABLE")
        token = context.get("scopedReplacementToken")
        client = LockedClient(frontend_scoped_provider_client.Client(provider, token, reviewed, module.read_only_request), verify) if token else UnavailableReadClient()
        verify()
        if provider in ("resend", "chitchats"):
            result = module.observe_scoped_effects(client, reviewed, context["scopedActual"], requirements, before=context["scopedBefore"])
        else:
            result = module.observe_scoped_effects(client, reviewed, context["scopedActual"], requirements)
        verify()
        return {**selected, "provider": provider, "surfaceSha256": scope["surfaceSha256"],
            "sourceCommit": requirements["sourceCommit"], "configurationRecordSha256": requirements["configurationRecordSha256"],
            "provenanceSha256": requirements["provenanceSha256"], **result}
    if operation == "observe-restoration":
        reviewed = context["bindings"].get("gatewayObservation")
        demand(reviewed is not None, "RESTORATION_GATEWAY_BINDING_REQUIRED")
        gateway = frontend_gateway_observation.observe(context["gatewayRuntimeDirectory"], reviewed, verify)
        frontend = observe_compatible(context, locked, source_attempt)
        return {**selected, "status": "FRONTEND_RESTORATION_BOUNDARY_OBSERVED", "gateway": gateway, "frontend": frontend}
    if operation == "observe-vercel":
        return observe_vercel(context, locked, source_attempt)
    if operation == "suspend-schedules":
        return suspend_schedules(context, locked, attempt)
    if operation == "deploy-compatible":
        return deploy_compatible(context, locked, attempt, parent, LockedProbe(verify, probe))
    if operation == "deploy-admission":
        return deploy_admission(context, locked, attempt, parent, LockedProbe(verify, probe))
    if operation == "retire-deployments":
        return retire_deployments(context, locked, attempt)
    if operation == "retire-related-previews":
        return retire_related_previews(context, locked, attempt)
    if operation == "observe-retired-capabilities":
        providers = {}
        for provider, module, probe_binding in (("square", frontend_square_retirement, frontend_square_retirement.binding),
                ("resend", frontend_resend_retirement, frontend_resend_retirement.domain)):
            reviewed_scope = context["bindings"].get(provider + "Retirement")
            if reviewed_scope is None:
                continue
            replacement_client = LockedClient(module.Client(context[provider + "ReplacementToken"]), verify)
            retired_client = LockedClient(module.Client(context[provider + "RetiredToken"]), verify)
            probe_binding(replacement_client, reviewed_scope)
            denied = False
            try:
                probe_binding(retired_client, reviewed_scope)
            except module.AuthenticationDenied:
                denied = True
            ingress_denied = False
            if provider == "square":
                ingress_denied = frontend_square_retirement.webhook(replacement_client)["enabled"] is False
            else:
                ingress_denied = all(frontend_resend_retirement.webhook(replacement_client, identifier)["status"] == "disabled"
                    for identifier in reviewed_scope["webhookIds"])
            providers[provider] = {"provider": provider, "historicalCapabilitiesDenied": denied and ingress_denied,
                "retiredCredentialDenied": denied, "replacementReadVerified": True, "rawInvocationCount": None}
        reviewed_highlevel = context["bindings"].get("highlevelRetirement")
        if reviewed_highlevel is not None:
            replacement_highlevel = LockedClient(frontend_crm_shipping_retirement.Client("highlevel", context["highlevelReplacementToken"], reviewed_highlevel), verify)
            retired_highlevel = LockedClient(frontend_crm_shipping_retirement.Client("highlevel", context["highlevelRetiredToken"], reviewed_highlevel), verify)
            replacement_highlevel.request("GET", "/locations/" + reviewed_highlevel["locationId"])
            denied = False
            try:
                retired_highlevel.request("GET", "/locations/" + reviewed_highlevel["locationId"])
            except frontend_crm_shipping_retirement.AuthenticationDenied:
                denied = True
            # Accepted original refresh denial and ingress drain remain bound
            # by the immutable strict fence; never replay its refresh grant.
            providers["highlevel"] = {"provider": "highlevel", "historicalCapabilitiesDenied": denied,
                "replacementReadVerified": True, "rawInvocationCount": None}
        reviewed = context["bindings"].get("googleRetirement")
        if reviewed is not None:
            replacements = {kind: frontend_google_fencing.Client(kind, context["google" + kind.title() + "ReplacementSecret"], verify) for kind in ("identity", "calendar")}
            retired = {kind: frontend_google_fencing.Client(kind, context["google" + kind.title() + "RetiredSecret"], verify) for kind in ("identity", "calendar")}
            for client in replacements.values():
                frontend_google_fencing.calibrate_client(client)
            rows = frontend_google_fencing.observe_clients(replacements, retired, reviewed, {"verificationGrants": {}})
            providers["google"] = {"provider": "google", "clients": rows, "historicalCapabilitiesDenied": all(row["retiredSecretDenied"] and
                row["replacementClientAuthenticationVerified"] for row in rows), "rawInvocationCount": None}
        reviewed = context["bindings"].get("chitchatsRetirement")
        if reviewed is not None:
            replacement = LockedClient(frontend_crm_shipping_retirement.Client("chitchats", context["chitchatsReplacementToken"], reviewed), verify)
            retired = LockedClient(frontend_crm_shipping_retirement.Client("chitchats", context["chitchatsRetiredToken"], reviewed), verify)
            path = "/api/v1/clients/" + reviewed["clientId"] + "/shipments/count"
            value = replacement.request("GET", path)
            demand(isinstance(value, dict) and type(value.get("count")) is int and value["count"] >= 0, "CHITCHATS_CURRENT_REPLACEMENT_READ_UNVERIFIED")
            denied = False
            try:
                retired.request("GET", path)
            except frontend_crm_shipping_retirement.AuthenticationDenied:
                denied = True
            providers["chitchats"] = {"provider": "chitchats", "clientId": reviewed["clientId"], "historicalCapabilitiesDenied": denied,
                "replacementReadVerified": True, "currentProviderObjectCount": value["count"], "rawInvocationCount": None}
        reviewed = context["bindings"].get("sanityRetirement")
        if reviewed is not None:
            replacement = LockedClient(frontend_sanity_fencing.Client(context["sanityReplacementToken"]), verify)
            retired = LockedClient(frontend_sanity_fencing.Client(context["sanityRetiredToken"]), verify)
            value = frontend_sanity_fencing.observe(replacement, retired, reviewed)
            providers["sanity"] = {**value, "historicalCapabilitiesDenied": all(row["disabled"] and row["disabledByUser"] for row in value["hooks"]) and
                value["activeExecutions"] == 0 and value["uncertainEffects"] == 0}
        return {**selected, "status": "HISTORICAL_PROVIDER_CAPABILITIES_OBSERVED", "providers": providers}
    crm_shipping = re.fullmatch(r"(suspend|verify|retire|observe)-(highlevel|chitchats)", operation)
    if crm_shipping:
        task, provider = crm_shipping.groups()
        reviewed = context["bindings"].get(provider + "Retirement")
        demand(reviewed is not None, "REVIEWED_CRM_SHIPPING_RETIREMENT_REQUIRED")
        replacement = LockedClient(frontend_crm_shipping_retirement.Client(provider, context[provider + "ReplacementToken"], reviewed), verify)
        refresh = context.get("highlevelRetiredRefreshCredentials") if provider == "highlevel" and task in ("verify", "retire") else None
        retired = LockedClient(frontend_crm_shipping_retirement.Client(provider, context[provider + "RetiredToken"], reviewed, refresh_credentials=refresh), verify)
        actual = context["crmShippingActual"]
        if task == "observe":
            return {**selected, **frontend_crm_shipping_retirement.observe_retirement(provider, replacement, retired, reviewed, actual, selected, source_attempt)}
        admission = context.get("admissionObservation", {})
        demand(admission.get("newWork") is False, "CRM_SHIPPING_NEW_WORK_MUST_BE_CLOSED")
        if task == "suspend":
            return frontend_crm_shipping_retirement.suspend(provider, replacement, retired, reviewed, actual, selected, attempt)
        demand(admission.get("recovery") is False and admission.get("ledgerDrained") is True, "CRM_SHIPPING_RECOVERY_MUST_BE_CLOSED_DRAINED")
        if task == "retire":
            before = migrate.read_json(attempt, provider + "-retirement-before.json")
            demand(before.get("retiredCredentialWasUsable") is True and all(before.get(key) == value for key, value in selected.items()),
                "CRM_SHIPPING_PRE_RETIREMENT_RECEIPT_REQUIRED")
            migrate.write_json(attempt, provider + "-console-observation-started.json", {**selected, "provider": provider})
            probe_path = "/locations/" + reviewed["locationId"] if provider == "highlevel" else "/api/v1/clients/" + reviewed["clientId"] + "/shipments/count"
            wait_for_supported_retirement(lambda: retired.request("GET", probe_path), frontend_crm_shipping_retirement.AuthenticationDenied,
                verify, context["retirementObservationSeconds"])
        return frontend_crm_shipping_retirement.verify_retirement(provider, replacement, retired, reviewed, actual, selected, attempt)
    if operation in ("retire-google", "observe-google"):
        reviewed = context["bindings"].get("googleRetirement")
        demand(reviewed is not None, "REVIEWED_GOOGLE_RETIREMENT_REQUIRED")
        replacements, retired = {}, {}
        for kind in ("identity", "calendar"):
            title = kind.capitalize()
            replacements[kind] = frontend_google_fencing.Client(kind, context["google" + title + "ReplacementSecret"], verify)
            retired[kind] = frontend_google_fencing.Client(kind, context["google" + title + "RetiredSecret"], verify)
        redis = frontend_google_fencing.LegacyRedis(context["googleLegacyRedisToken"], verify)
        if operation == "observe-google":
            return {**selected, **frontend_google_fencing.observe(replacements, retired, redis, reviewed, context["googlePrivate"], context["googleActual"])}
        admission = context.get("admissionObservation", {})
        demand(admission.get("newWork") is False and admission.get("recovery") is False and admission.get("ledgerDrained") is True,
            "GOOGLE_GRANT_RETIREMENT_REQUIRES_CLOSED_DRAINED_RECOVERY")
        runtime = verify_google_runtime(context, locked, attempt, LockedProbe(verify, probe))
        migrate.write_json(attempt, "google-runtime-before-retirement.json", runtime)
        outcome = frontend_google_fencing.retire_grants(replacements, retired, redis, reviewed, context["googlePrivate"], context["googleActual"], selected, attempt)
        runtime = verify_google_runtime(context, locked, attempt, LockedProbe(verify, probe))
        migrate.write_json(attempt, "google-runtime-after-retirement.json", runtime)
        return {**outcome, "runtimeReplacementBindingVerified": True, "customerIdentityBindingVerified": False}
    if operation in ("verify-square", "retire-square", "observe-square", "suspend-square"):
        reviewed = context["bindings"].get("squareRetirement")
        demand(reviewed is not None, "REVIEWED_SQUARE_SANDBOX_RETIREMENT_REQUIRED")
        replacement = LockedClient(frontend_square_retirement.Client(context["squareReplacementToken"]), verify)
        retired = LockedClient(frontend_square_retirement.Client(context["squareRetiredToken"]), verify)
        if operation == "observe-square":
            return {**selected, **frontend_square_retirement.observe(replacement, retired, reviewed, context["squareEffects"])}
        runtime = verify_square_runtime(context, locked, attempt, LockedProbe(verify, probe))
        if operation in ("suspend-square", "retire-square"):
            demand(frontend_square_retirement.binding(retired, reviewed) == frontend_square_retirement.binding(replacement, reviewed),
                "SQUARE_OLD_CREDENTIAL_SCOPE_UNVERIFIED")
            migrate.write_json(attempt, "square-runtime-before-retirement.json", {**runtime, "retiredCredentialWasUsable": True})
            before = frontend_square_retirement.webhook(replacement)
            migrate.write_json(attempt, "square-callback-suspension-started.json", {**selected, "webhookId": before["webhookId"], "previouslyEnabled": before["enabled"]})
            if before["enabled"]:
                replacement.request("PUT", "/v2/webhooks/subscriptions/" + before["webhookId"], {"subscription": {"enabled": False}})
            after = frontend_square_retirement.webhook(replacement)
            demand(after == {**before, "enabled": False}, "SQUARE_CALLBACK_DISABLE_READBACK_UNVERIFIED")
            migrate.write_json(attempt, "square-callback-suspension-verified.json", {**selected, **after})
            if operation == "suspend-square":
                return {**selected, **after, "status": "SQUARE_SANDBOX_CALLBACK_DISABLED_DASHBOARD_RETIREMENT_PENDING", "activeExecutions": None, "uncertainEffects": None}
            wait_for_supported_retirement(lambda: frontend_square_retirement.binding(retired, reviewed),
                frontend_square_retirement.AuthenticationDenied, verify, context["retirementObservationSeconds"])
        previous = migrate.read_json(attempt, "square-runtime-before-retirement.json")
        demand(all(previous.get(key) == runtime[key] for key in ("actionId", "sourceCommit", "targetSha256", "deploymentId", "locationId", "merchantId", "applicationId")) and
            previous.get("retiredCredentialWasUsable") is True, "SQUARE_PRE_RETIREMENT_RUNTIME_EVIDENCE_REQUIRED")
        outcome = frontend_square_retirement.verify_retirement(replacement, retired, reviewed, context["squareEffects"], selected, attempt)
        verified = verify_square_runtime(context, locked, attempt, LockedProbe(verify, probe))
        migrate.write_json(attempt, "square-runtime-binding-verified.json", verified)
        return {**outcome, "runtimeReplacementBindingVerified": True}
    if operation in ("suspend-sanity", "observe-sanity"):
        reviewed = context["bindings"].get("sanityRetirement")
        demand(reviewed is not None, "REVIEWED_SANITY_RETIREMENT_REQUIRED")
        replacement = LockedClient(frontend_sanity_fencing.Client(context["sanityReplacementToken"]), verify)
        retired = LockedClient(frontend_sanity_fencing.Client(context["sanityRetiredToken"]), verify)
        if operation == "observe-sanity":
            return {**selected, **frontend_sanity_fencing.observe(replacement, retired, reviewed)}
        return frontend_sanity_fencing.suspend(replacement, retired, reviewed, selected, attempt)
    if operation in ("retire-resend", "observe-resend", "observe-resend-effects"):
        reviewed = context["bindings"].get("resendRetirement")
        demand(reviewed is not None, "REVIEWED_RESEND_RETIREMENT_REQUIRED")
        replacement = LockedClient(frontend_resend_retirement.Client(context["resendReplacementToken"]), verify)
        retired = LockedClient(frontend_resend_retirement.Client(context["resendRetiredToken"]), verify)
        if operation == "observe-resend-effects":
            return {**selected, **frontend_resend_retirement.accepted_email_effects(replacement, reviewed)}
        if operation == "observe-resend":
            return {**selected, **frontend_resend_retirement.observe(replacement, retired, reviewed)}
        # The protected runtime must be usable before destructive retirement,
        # and must still succeed after the old token is actually denied.
        verify_resend_runtime(context, locked, attempt, LockedProbe(verify, probe))
        outcome = frontend_resend_retirement.retire(replacement, retired, reviewed, selected, attempt)
        verified = verify_resend_runtime(context, locked, attempt, LockedProbe(verify, probe))
        migrate.write_json(attempt, "resend-runtime-binding-verified.json", verified)
        return {**outcome, "runtimeReplacementBindingVerified": True}
    if operation in ("observe-compatible", "observe-admission"):
        result = observe_compatible(context, locked, source_attempt)
        if operation == "observe-compatible" and (source_attempt.parent / "vercel-bootstrap").exists():
            result["bootstrapFrontend"] = observe_compatible(context, locked, source_attempt.parent / "vercel-bootstrap")
        return result
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
