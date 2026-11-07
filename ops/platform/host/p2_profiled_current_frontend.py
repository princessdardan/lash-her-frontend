"""Source-selected fixed-current frontend deployment and GET-only recovery.

The parent owns the live database/session guard. This child requests a fresh
checkpoint before every provider request and retains a durable intent before
every mutation. Provider error bodies and private values never enter output.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import sys
import time
from pathlib import Path

import frontend_probe
import migrate
import vercel
from qualification_target_profile import (
    STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as PROFILE,
    require_qualification_target_profile,
    resolve_qualification_target_profile,
)

demand = migrate.demand
MAXIMUM = 2_000_000
FEATURES = frontend_probe.FEATURE_CONTROL_NAMES
FALSE_FIELDS = ("frontendSqlApplied", "historicalProviderClosureClaimed", "oldP200Qualified",
                "nativeSchedulesEnabled", "trafficAuthorized", "releaseAccepted")
CONFIGURATION_NAMES = {
    "runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
    "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem",
    "tls/course/cert.pem", "tls/community/key.pem", "tls/community/cert.pem", "course-api.env",
    "course-publisher.env", "course-snapshot.env", "community-api.env", "community-worker.env",
    "course-media.env", "course-export-cleanup.env",
}
PIN_NAMES = {
    "frontendBuildOutcome": "frontend-build-outcome.json",
    "frontendPromotionStarted": "frontend-promotion-started.json",
    "frontendWorkloadOutcome": "frontend-workload-outcome.json",
}
LOST_BUILD_PIN_NAMES = frozenset({"deployStarted", "buildStarted", "buildIntent"})
BUILD_BODY_KEYS = ["autoAssignCustomDomains", "gitSource", "meta", "name", "project", "target"]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def json_sha(value):
    return sha(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())


def pins_sha(value):
    return sha(json.dumps({key: value[key] for key in sorted(value)}, separators=(",", ":"), ensure_ascii=False).encode())


def checkpoint():
    checkpoint.sequence += 1
    print(json.dumps({"type": "checkpoint", "id": checkpoint.sequence}, separators=(",", ":")), flush=True)
    raw = sys.stdin.buffer.readline(8193)
    demand(0 < len(raw) <= 8192, "PARENT_CHECKPOINT_REFUSED")
    value = json.loads(raw)
    demand(value == {"type": "continue", "id": checkpoint.sequence}, "PARENT_CHECKPOINT_REFUSED")


checkpoint.sequence = 0


def private_directory(value):
    directory = Path(value)
    migrate.private_directory(directory)
    demand(directory.is_absolute() and directory.resolve() == directory and
           not any((parent / ".git").exists() for parent in (directory, *directory.parents)),
           "PROFILED_CURRENT_PRIVATE_DIRECTORY_REFUSED")
    return directory


def child_directory(parent, name):
    selected = parent / name
    if not selected.exists():
        selected.mkdir(mode=0o700)
    migrate.private_directory(selected)
    return selected


def existing_child(parent, name):
    return private_directory(parent / name)


def profile_context(context):
    expected = dict(PROFILE)
    resolve_qualification_target_profile(expected)
    require_qualification_target_profile(expected, context, context.get("plan"), context.get("candidate"),
                                         context.get("candidate", {}).get("frontendMigration"), context.get("job"),
                                         context.get("job", {}).get("target"))
    candidate, job, plan = context["candidate"], context["job"], context["plan"]
    demand(candidate.get("version") == 3 and job.get("version") == 2 and plan.get("version") == 2 and
           candidate.get("environment") == job.get("environment") == plan.get("environment") == "staging" and
           candidate.get("releaseId") == job.get("releaseId") and
           candidate.get("sources", {}).get("frontend", {}).get("commit") == job.get("sourceCommit") and
           candidate.get("contractPhase") == "p2" and
           isinstance(candidate.get("phase2ContractManifestSha256"), str) and
           re.fullmatch(r"sha256:[a-f0-9]{64}", candidate["phase2ContractManifestSha256"]) and
           candidate["phase2ContractManifestSha256"] != "sha256:" + "0" * 64,
           "PROFILED_CURRENT_SOURCE_CONTEXT_REFUSED")
    return expected, plan, candidate, job


class GuardedClient:
    """Checkpoint all I/O and durably name each mutation before it occurs."""

    def __init__(self, client, attempt, verify=checkpoint, read_only=False):
        self.client, self.attempt, self.verify, self.read_only, self.sequence = client, attempt, verify, read_only, 0

    def request(self, method, path, body=None):
        if method in ("POST", "PATCH", "DELETE"):
            demand(not self.read_only, "RECOVERY_PROVIDER_MUTATION_REFUSED")
            self.sequence += 1
            migrate.write_json(self.attempt, f"provider-mutation-intent-{self.sequence:03d}.json", {
                "version": 2, "qualificationTargetProfile": dict(PROFILE), "sequence": self.sequence,
                "method": method, "pathSha256": sha(path.encode()),
                # Retain only structure. Environment values include private
                # credentials and must not acquire a durable derived digest.
                "bodyKeys": sorted(body) if isinstance(body, dict) and
                    all(isinstance(key, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key) for key in body) else None,
                "providerMutationCompleted": False, "trafficAuthorized": False,
            })
        self.verify()
        return self.client.request(method, path, body)


def release_identity(context):
    expected, plan, candidate, job = profile_context(context)
    environment, project_id, source_commit = vercel.release_identity(candidate, expected_profile=expected)
    demand(environment == "staging" and plan.get("actionId") == candidate["releaseId"] and
           plan.get("sourceCommit") == source_commit and context.get("inventorySha256") == json_sha(plan) and
           context.get("candidateSha256") and re.fullmatch(r"[a-f0-9]{64}", context["candidateSha256"]) and
           isinstance(context.get("configurationSha256"), dict) and set(context["configurationSha256"]) == CONFIGURATION_NAMES and
           all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64
               for value in context["configurationSha256"].values()), "PROFILED_CURRENT_RELEASE_BINDING_REFUSED")
    controls, writer = context.get("expectedFeatureControls"), context.get("writerAdmissionBinding")
    demand(frontend_probe.valid_feature_controls(controls) and frontend_probe.valid_writer_admission_binding(writer) and
           writer.get("targetSha256") == plan.get("targetSha256") and writer.get("sourceCommit") == source_commit and
           writer.get("roleName") == context.get("bootstrapRuntimeTarget", {}).get("user"),
           "PROFILED_CURRENT_RUNTIME_CONFIGURATION_REFUSED")
    bindings = context.get("bindings")
    demand(isinstance(bindings, dict) and json_sha(bindings.get("gatewayObservation")) ==
           plan.get("restoration", {}).get("gatewayBindingSha256"), "PROFILED_CURRENT_GATEWAY_BINDING_REFUSED")
    return expected, plan, candidate, job, project_id, controls, writer


def configure_runtime(client, context, attempt, project_id, controls, writer):
    target, runtime_url = context["bootstrapRuntimeTarget"], context.get("frontendRuntimeDatabaseUrl")
    demand(isinstance(runtime_url, str) and 0 < len(runtime_url) <= 16_384 and "\n" not in runtime_url and "\r" not in runtime_url,
           "PROFILED_CURRENT_RUNTIME_DATABASE_REFUSED")
    variables = [(key, "true" if value else "false", "plain") for key, value in controls.items()] + [
        ("STAGING_RELEASE_COMMIT", context["candidate"]["sources"]["frontend"]["commit"], "plain"),
        ("STAGING_MIGRATION_VERIFIED_COMMIT", context["candidate"]["sources"]["frontend"]["commit"], "plain"),
        ("LASH_P2_CERTIFICATION_SCHEDULES", "account-lifecycle", "plain"),
        ("FRONTEND_WRITER_ADMISSION_MODE", "enforce", "plain"),
        ("FRONTEND_WRITER_ADMISSION_TARGET_JSON", json.dumps(target, separators=(",", ":")), "plain"),
        ("FRONTEND_WRITER_PRODUCER_SHA256", writer["producerSha256"], "plain"),
        ("FRONTEND_WRITER_ADMISSION_DATABASE_URL", runtime_url, "sensitive"),
        ("DATABASE_URL", runtime_url, "sensitive"),
    ]
    migrate.write_json(attempt, "p2-current-configuration-started.json", {
        "version": 2, "qualificationTargetProfile": dict(PROFILE), "projectId": project_id,
        "configurationSha256": context["configurationSha256"], "featureControls": controls,
        "writerAdmissionBinding": writer, "trafficAuthorized": False,
    })
    for key, value, kind in variables:
        response = client.request("POST", f"/v10/projects/{project_id}/env?upsert=true", {
            "key": key, "value": value, "type": kind, "target": ["production"], "gitBranch": None,
            "customEnvironmentIds": [], "comment": "Profiled current frontend " + context["candidate"]["releaseId"],
        })
        created = response.get("created")
        demand(response.get("failed") == [] and isinstance(created, dict) and created.get("key") == key and
               created.get("type") == kind and created.get("target") == ["production"] and
               not created.get("gitBranch") and not created.get("customEnvironmentIds"),
               "PROFILED_CURRENT_CONFIGURATION_UNVERIFIED")
    rows = client.request("GET", f"/v10/projects/{project_id}/env?decrypt=false").get("envs")
    demand(isinstance(rows, list), "PROFILED_CURRENT_CONFIGURATION_UNVERIFIED")
    for key, value, kind in variables:
        found = [row for row in rows if row.get("key") == key and row.get("target") == ["production"] and
                 not row.get("gitBranch") and not row.get("customEnvironmentIds")]
        demand(len(found) == 1 and found[0].get("type") == kind and
               (kind == "sensitive" or found[0].get("value") == value), "PROFILED_CURRENT_CONFIGURATION_UNVERIFIED")


def observe_release(context, client, attempt):
    expected, plan, candidate, _job, project_id, controls, writer = release_identity(context)
    staged = vercel._staged_identity(candidate, attempt, expected_profile=expected)
    deployment = vercel.deployment_state(client, staged["deploymentId"], project_id,
                                         staged["sourceCommit"], staged["releaseId"])
    state = vercel.promotion_state(client, project_id)
    intent = migrate.read_json(attempt, "frontend-promotion-started.json", expected_profile=expected)
    alias = state.get("aliasJob")
    demand(deployment["readyState"] == "READY" and state.get("cronsEnabled") is False and
           state.get("productionDeploymentId") == staged["deploymentId"] and isinstance(alias, dict) and
           alias.get("jobStatus") == "succeeded" and alias.get("type") == "promote" and
           alias.get("toDeploymentId") == staged["deploymentId"] and
           alias.get("requestedAt") > intent.get("previousAliasRequestedAt", 0) and
           all(intent.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit", "releaseId",
                                                          "deploymentId", "previousDeploymentId")),
           "PROFILED_CURRENT_PROMOTION_UNVERIFIED")
    raw = migrate.read_input(attempt, "frontend-workload-outcome.json")
    workload = migrate.read_json(attempt, "frontend-workload-outcome.json", expected_profile=expected)
    require_qualification_target_profile(expected, workload)
    demand(workload.get("version") == 2 and workload.get("status") == "FRONTEND_VERIFIED" and
           all(workload.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId")) and
           workload.get("contractPhase") == "p2" and workload.get("phase2ContractManifestSha256") ==
           candidate.get("phase2ContractManifestSha256") and workload.get("featureControls") == controls and
           workload.get("writerAdmissionBinding") == writer, "PROFILED_CURRENT_WORKLOAD_UNVERIFIED")
    project = vercel._project(client, project_id)
    cron, expected_cron = project.get("crons") or {}, {"path": "/api/cron/account-lifecycle", "schedule": "* * * * *",
        "host": deployment["url"].removeprefix("https://")}
    definitions = cron.get("definitions")
    demand((project.get("targets") or {}).get("production", {}).get("id") == staged["deploymentId"] and
           cron.get("deploymentId") == staged["deploymentId"] and cron.get("disabledAt") is not None and
           isinstance(definitions, list) and len(definitions) == 1 and
           all(definitions[0].get(key) == value for key, value in expected_cron.items()),
           "PROFILED_CURRENT_SCHEDULE_UNVERIFIED")
    outcome = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
        "status": "P2_PROFILED_CURRENT_FRONTEND_VERIFIED", "environment": "staging",
        "actionId": candidate["releaseId"], "releaseId": candidate["releaseId"], "sourceCommit": staged["sourceCommit"],
        "targetSha256": plan["targetSha256"], "candidateSha256": context["candidateSha256"],
        "configurationSha256": context["configurationSha256"], "contractPhase": "p2",
        "phase2ContractManifestSha256": candidate["phase2ContractManifestSha256"], "projectId": project_id,
        "deploymentId": staged["deploymentId"], "readyState": "READY", "aliasJobState": "succeeded",
        "aliasDeploymentId": staged["deploymentId"], "aliasJobDeploymentId": staged["deploymentId"],
        "aliasJobMatchesIntent": True, "aliasJobType": "promote", "workloadVerified": True,
        "workloadReceiptSha256": sha(raw), "configurationRecordSha256": sha(raw), "featureControls": controls,
        "writerAdmissionBinding": writer, "certificationSchedule": {**expected_cron, "deploymentId": staged["deploymentId"],
            "nativeEnabled": False, "definitionsSha256": sha(json.dumps(definitions, separators=(",", ":")).encode())},
        "admissionNewWork": False, "admissionRecovery": False,
        **{key: False for key in FALSE_FIELDS}}
    return outcome


def deploy(context, verify=checkpoint):
    """Mutating release path. The fixed call graph contains every mutation."""
    expected, plan, candidate, _job, project_id, controls, writer = release_identity(context)
    parent = private_directory(context["directory"])
    attempt, private = child_directory(parent, "vercel"), child_directory(parent, "vercel-private")
    client = GuardedClient(vercel.Client(context["vercelToken"]), attempt, verify)
    migrate.write_json(attempt, "p2-profiled-current-deploy-started.json", {
        "version": 2, "qualificationTargetProfile": dict(PROFILE), "environment": "staging",
        "releaseId": candidate["releaseId"], "sourceCommit": plan["sourceCommit"],
        "candidateSha256": context["candidateSha256"], "configurationSha256": context["configurationSha256"],
        "trafficAuthorized": False,
    })
    vercel.disable_schedules(client, candidate, expected_profile=expected)
    configure_runtime(client, context, attempt, project_id, controls, writer)
    gateway_host = resolve_qualification_target_profile(expected)["gateway"]["publicOrigin"].removeprefix("https://")
    frontend_probe.prepare(client, candidate, private, attempt, gateway_host,
                           scheduler_qualification=False, expected_profile=expected)
    vercel.stage_frontend(client, candidate, attempt, expected_profile=expected)
    vercel.promote_frontend(client, candidate, attempt,
        lambda release, _deployment: frontend_probe.verify(client, release, attempt, private,
            expected_feature_controls=controls, expected_writer_admission_binding=writer,
            expected_profile=expected), expected_profile=expected)
    return observe_release(context, client, attempt)


def observe(context, verify=checkpoint):
    """Release readback only; it never creates a missing provider effect."""
    release_identity(context)
    parent = private_directory(context["directory"])
    attempt = existing_child(parent, "vercel")
    client = GuardedClient(vercel.Client(context["vercelToken"]), attempt, verify, read_only=True)
    return observe_release(context, client, attempt)


def recovery_context(initial, provider):
    expected = dict(PROFILE)
    resolve_qualification_target_profile(expected)
    plan, candidate, job = initial.get("plan"), initial.get("candidate"), initial.get("job")
    require_qualification_target_profile(expected, initial, plan, candidate, candidate.get("frontendMigration"), job, job.get("target"), provider)
    pins = initial.get("originalReceiptSha256")
    demand(plan.get("version") == 2 and plan.get("mode") == "p2-profiled-current-recovery" and
           plan.get("environment") == "staging" and plan.get("disposition") in
           ("restore-current-runtime", "reconcile-frontend-get-first", "resume-approved-api-suffix") and
           candidate.get("version") == 3 and job.get("version") == 2 and
           candidate.get("releaseId") == job.get("releaseId") == plan.get("originalReleaseId") and
           candidate.get("sources", {}).get("frontend", {}).get("commit") == job.get("sourceCommit") == plan.get("sourceCommit") and
           candidate.get("sources", {}).get("frontend", {}).get("repository") == "https://github.com/princessdardan/lash-her-frontend.git" and
           candidate.get("sources", {}).get("frontend", {}).get("requiredChecks") == "passed" and
           candidate.get("workload", {}).get("projectId") == "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" and
           candidate.get("workload", {}).get("environment") == "production" and candidate.get("contractPhase") == "p2" and
           isinstance(candidate.get("phase2ContractManifestSha256"), str) and
           re.fullmatch(r"sha256:[a-f0-9]{64}", candidate["phase2ContractManifestSha256"]) and
           job.get("environment") == "staging" and job.get("target", {}).get("approvedPendingTags") == [] and
           job.get("target", {}).get("allowEmptyBootstrap") is False and
           isinstance(plan.get("configurationSha256"), dict) and set(plan["configurationSha256"]) == CONFIGURATION_NAMES and
           all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64
               for value in plan["configurationSha256"].values()) and
           isinstance(pins, dict) and set(pins) == {
               "candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome", "apiRuntimeOutcome",
               "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"} and
           all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64 for value in pins.values()) and
           set(provider) in ({"version", "qualificationTargetProfile", "vercelToken", "bindings", "originalDirectory"},
                             {"version", "qualificationTargetProfile", "vercelToken", "bindings", "originalDirectory", "frontendRuntimeDatabaseUrl"}) and
           provider.get("version") == 2 and isinstance(provider.get("vercelToken"), str) and
           0 < len(provider["vercelToken"]) <= 8192 and isinstance(provider.get("bindings"), dict),
           "PROFILED_CURRENT_RECOVERY_CONTEXT_REFUSED")
    return expected, plan, candidate, job, pins


def matching_deployments(client, project_id, source_commit, release_id):
    matches, seen, cursor = [], set(), None
    for _page in range(100):
        suffix = "" if cursor is None else "&until=" + str(cursor)
        value = client.request("GET", f"/v7/deployments?projectId={project_id}&limit=100" + suffix)
        rows, pagination = value.get("deployments"), value.get("pagination")
        demand(isinstance(rows, list) and len(rows) <= 100 and isinstance(pagination, dict) and
               type(pagination.get("count")) is int and pagination["count"] == len(rows),
               "PROFILED_CURRENT_DEPLOYMENT_INVENTORY_REFUSED")
        for row in rows:
            deployment_id = row.get("uid", row.get("id"))
            git, meta = row.get("gitSource") or {}, row.get("meta") or {}
            demand(isinstance(deployment_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id) and
                   deployment_id not in seen and isinstance(git, dict) and isinstance(meta, dict),
                   "PROFILED_CURRENT_DEPLOYMENT_INVENTORY_REFUSED")
            seen.add(deployment_id)
            selected_source = git.get("sha", meta.get("githubCommitSha"))
            demand(selected_source is None or isinstance(selected_source, str) and
                   re.fullmatch(r"[a-f0-9]{40}", selected_source), "PROFILED_CURRENT_DEPLOYMENT_INVENTORY_REFUSED")
            if selected_source == source_commit and meta.get("lashReleaseId") == release_id and row.get("target") == "production":
                matches.append(deployment_id)
        following = pagination.get("next")
        if following is None:
            return matches
        demand(type(following) is int and following > 0 and rows and (cursor is None or following < cursor),
               "PROFILED_CURRENT_DEPLOYMENT_INVENTORY_REFUSED")
        cursor = following
    raise ValueError("PROFILED_CURRENT_DEPLOYMENT_INVENTORY_REFUSED")


def lost_build_context(initial, provider):
    """Validate the source-owned carrier without selecting the provider effect."""
    expected = dict(PROFILE)
    resolve_qualification_target_profile(expected)
    demand(isinstance(initial, dict) and isinstance(provider, dict),
           "PROFILED_CURRENT_LOST_BUILD_CONTEXT_REFUSED")
    plan, candidate, job = initial.get("plan"), initial.get("candidate"), initial.get("job")
    demand(all(isinstance(value, dict) for value in (plan, candidate, job)),
           "PROFILED_CURRENT_LOST_BUILD_CONTEXT_REFUSED")
    require_qualification_target_profile(expected, initial, plan, candidate,
                                         candidate.get("frontendMigration"), job, job.get("target"), provider)
    pins = initial.get("lostBuildReceiptSha256")
    keys = set(pins) if isinstance(pins, dict) else set()
    demand(initial.get("version") == 2 and plan.get("version") == 2 and plan.get("mode") == "p2-profiled-current-recovery" and
           plan.get("environment") == "staging" and
           plan.get("disposition") == "reconcile-frontend-lost-build-get-first" and
           candidate.get("version") == 3 and job.get("version") == 2 and
           candidate.get("releaseId") == job.get("releaseId") == plan.get("originalReleaseId") and
           candidate.get("sources", {}).get("frontend", {}).get("commit") ==
           job.get("sourceCommit") == plan.get("sourceCommit") and
           candidate.get("sources", {}).get("frontend", {}).get("repository") ==
           "https://github.com/princessdardan/lash-her-frontend.git" and
           candidate.get("sources", {}).get("frontend", {}).get("requiredChecks") == "passed" and
           candidate.get("workload", {}).get("projectId") == "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" and
           candidate.get("workload", {}).get("environment") == "production" and
           candidate.get("contractPhase") == "p2" and
           isinstance(candidate.get("phase2ContractManifestSha256"), str) and
           re.fullmatch(r"sha256:[a-f0-9]{64}", candidate["phase2ContractManifestSha256"]) and
           candidate["phase2ContractManifestSha256"] != "sha256:" + "0" * 64 and
           job.get("environment") == "staging" and job.get("target", {}).get("approvedPendingTags") == [] and
           job.get("target", {}).get("allowEmptyBootstrap") is False and
           isinstance(plan.get("candidateSha256"), str) and re.fullmatch(r"[a-f0-9]{64}", plan["candidateSha256"]) and
           plan["candidateSha256"] != "0" * 64 and isinstance(plan.get("targetSha256"), str) and
           re.fullmatch(r"[a-f0-9]{64}", plan["targetSha256"]) and plan["targetSha256"] != "0" * 64 and
           isinstance(plan.get("configurationSha256"), dict) and set(plan["configurationSha256"]) == CONFIGURATION_NAMES and
           all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64
               for value in plan["configurationSha256"].values()) and
           plan.get("lostBuildReceiptSha256") == pins and
           keys in (LOST_BUILD_PIN_NAMES, LOST_BUILD_PIN_NAMES | {"buildOutcome"}) and
           all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64
               for value in pins.values()) and
           set(provider) in ({"version", "qualificationTargetProfile", "vercelToken", "bindings", "originalDirectory"},
                             {"version", "qualificationTargetProfile", "vercelToken", "bindings", "originalDirectory",
                              "frontendRuntimeDatabaseUrl"}) and
           provider.get("version") == 2 and isinstance(provider.get("vercelToken"), str) and
           0 < len(provider["vercelToken"]) <= 8192 and all(32 < ord(char) < 127 for char in provider["vercelToken"]) and
           isinstance(provider.get("bindings"), dict),
           "PROFILED_CURRENT_LOST_BUILD_CONTEXT_REFUSED")
    demand("verify" not in initial, "PROFILED_CURRENT_LOST_BUILD_CONTEXT_REFUSED")
    environment, project_id, source_commit = vercel.release_identity(candidate, expected_profile=expected)
    demand(environment == "staging" and project_id == candidate["workload"]["projectId"] and
           source_commit == plan["sourceCommit"], "PROFILED_CURRENT_LOST_BUILD_CONTEXT_REFUSED")
    return expected, plan, candidate, job, pins, project_id, source_commit


def _receipt(attempt, name, expected_sha, expected):
    raw = migrate.read_input(attempt, name)
    demand(sha(raw) == expected_sha, "PROFILED_CURRENT_LOST_BUILD_RECEIPT_MISMATCH")
    value = json.loads(raw)
    require_qualification_target_profile(expected, value)
    demand(isinstance(value, dict), "PROFILED_CURRENT_LOST_BUILD_RECEIPT_REFUSED")
    return raw, value


def _exists(path):
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def observe_lost_build_post_ack(initial, provider, verify=checkpoint):
    """Observe one lost-build POST effect without replaying or qualifying it.

    This path proves only that the provider inventory contains one deployment
    matching the fixed build intent. It does not recover an acknowledgement or
    establish readiness, workload, promotion, alias, cron, traffic or release.
    """
    demand(callable(verify), "PROFILED_CURRENT_LOST_BUILD_CHECKPOINT_REQUIRED")
    expected, plan, candidate, _job, pins, project_id, source_commit = lost_build_context(initial, provider)
    parent = private_directory(provider["originalDirectory"])
    attempt = existing_child(parent, "vercel")
    _deploy_raw, deploy = _receipt(attempt, "p2-profiled-current-deploy-started.json", pins["deployStarted"], expected)
    _build_raw, build = _receipt(attempt, "frontend-build-started.json", pins["buildStarted"], expected)
    deploy_keys = {"version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit",
                   "candidateSha256", "configurationSha256", "trafficAuthorized"}
    build_keys = {"version", "qualificationTargetProfile", "environment", "projectId", "sourceCommit", "releaseId",
                  "previousDeploymentId", "trafficAuthorized", "promotionAuthorized"}
    demand(set(deploy) == deploy_keys and deploy.get("version") == 2 and deploy.get("environment") == "staging" and
           deploy.get("releaseId") == candidate["releaseId"] and deploy.get("sourceCommit") == plan["sourceCommit"] and
           deploy.get("candidateSha256") == plan["candidateSha256"] and
           deploy.get("configurationSha256") == plan["configurationSha256"] and deploy.get("trafficAuthorized") is False,
           "PROFILED_CURRENT_LOST_BUILD_DEPLOY_RECEIPT_REFUSED")
    previous = build.get("previousDeploymentId")
    demand(set(build) == build_keys and build.get("version") == 2 and build.get("environment") == "staging" and
           build.get("projectId") == project_id and build.get("sourceCommit") == source_commit == plan["sourceCommit"] and
           build.get("releaseId") == candidate["releaseId"] and build.get("trafficAuthorized") is False and
           build.get("promotionAuthorized") is False and
           (previous is None or isinstance(previous, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", previous)),
           "PROFILED_CURRENT_LOST_BUILD_STARTED_REFUSED")
    intent_matches, pinned_intents = [], []
    for path in attempt.iterdir():
        if not path.name.startswith("provider-mutation-intent-"):
            continue
        demand(re.fullmatch(r"provider-mutation-intent-[0-9]{3}\.json", path.name),
               "PROFILED_CURRENT_LOST_BUILD_INTENT_REFUSED")
        raw = migrate.read_input(attempt, path.name)
        value = json.loads(raw)
        require_qualification_target_profile(expected, value)
        demand(isinstance(value, dict) and set(value) == {"version", "qualificationTargetProfile", "sequence", "method",
               "pathSha256", "bodyKeys", "providerMutationCompleted", "trafficAuthorized"} and
               type(value.get("sequence")) is int and 1 <= value["sequence"] <= 999 and
               path.name == f"provider-mutation-intent-{value['sequence']:03d}.json" and value.get("version") == 2,
               "PROFILED_CURRENT_LOST_BUILD_INTENT_REFUSED")
        is_build = value.get("method") == "POST" and value.get("pathSha256") == sha(b"/v13/deployments") and \
            value.get("bodyKeys") == BUILD_BODY_KEYS and value.get("providerMutationCompleted") is False and \
            value.get("trafficAuthorized") is False
        if is_build:
            intent_matches.append((raw, value))
        if sha(raw) == pins["buildIntent"]:
            pinned_intents.append((raw, value))
    demand(len(intent_matches) == 1 and len(pinned_intents) == 1 and intent_matches[0][0] == pinned_intents[0][0],
           "PROFILED_CURRENT_LOST_BUILD_INTENT_REFUSED")
    outcome_path = attempt / "frontend-build-outcome.json"
    if "buildOutcome" in pins:
        _outcome_raw, outcome = _receipt(attempt, outcome_path.name, pins["buildOutcome"], expected)
        demand(set(outcome) == build_keys | {"status", "phase", "failureCode"} and
               all(outcome.get(key) == build.get(key) for key in build_keys) and
               outcome.get("status") == "FRONTEND_BUILD_FAILED_REQUIRES_REVIEW" and outcome.get("phase") == "create" and
               outcome.get("failureCode") == "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW",
               "PROFILED_CURRENT_LOST_BUILD_OUTCOME_REFUSED")
    else:
        demand(not _exists(outcome_path), "PROFILED_CURRENT_LOST_BUILD_OUTCOME_REFUSED")
    for name in ("frontend-build-created.json", "frontend-promotion-started.json", "frontend-promotion-outcome.json",
                 "frontend-workload-outcome.json"):
        demand(not _exists(attempt / name), "PROFILED_CURRENT_LOST_BUILD_LATER_RECEIPT_REFUSED")
    demand(not any(path.name.startswith("frontend-promotion-observation-") for path in attempt.iterdir()),
           "PROFILED_CURRENT_LOST_BUILD_LATER_RECEIPT_REFUSED")
    client = GuardedClient(vercel.Client(provider["vercelToken"]), attempt, verify, read_only=True)
    expected_project = {"projectId": project_id, "productionDeploymentId": previous, "cronsEnabled": False}
    before = vercel.project_state(client, project_id)
    demand(before == expected_project, "PROFILED_CURRENT_LOST_BUILD_PRIOR_TARGET_CHANGED")
    matches = matching_deployments(client, project_id, source_commit, candidate["releaseId"])
    demand(len(matches) == 1, "PROFILED_CURRENT_LOST_BUILD_EFFECT_AMBIGUOUS")
    deployment_id = matches[0]
    deployment = vercel.deployment_state(client, deployment_id, project_id, source_commit, candidate["releaseId"])
    demand(deployment.get("deploymentId") == deployment_id and deployment.get("projectId") == project_id and
           deployment.get("sourceCommit") == source_commit,
           "PROFILED_CURRENT_LOST_BUILD_EFFECT_UNVERIFIED")
    demand(vercel.project_state(client, project_id) == before,
           "PROFILED_CURRENT_LOST_BUILD_PRIOR_TARGET_CHANGED")
    result = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
        "status": "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED", "environment": "staging",
        "actionId": candidate["releaseId"], "releaseId": candidate["releaseId"], "sourceCommit": source_commit,
        "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"],
        "targetSha256": plan["targetSha256"], "projectId": project_id, "deploymentId": deployment_id,
        "previousDeploymentId": previous, "lostBuildReceiptSha256": pins_sha(pins),
        "deployStartedSha256": pins["deployStarted"], "buildStartedSha256": pins["buildStarted"],
        "buildIntentSha256": pins["buildIntent"],
        **({"buildOutcomeSha256": pins["buildOutcome"]} if "buildOutcome" in pins else {}),
        "getFirst": True, "newProviderPost": False, "ambiguous": False, "deploymentEffectObserved": True,
        "frontendActionPending": True, "originalBuildAckObserved": False, "providerMutationReplayed": False,
        "buildReadyVerified": False, "workloadVerified": False, "aliasQualificationVerified": False,
        "promotionVerified": False, "cronQualificationVerified": False, "trafficAuthorized": False,
        "releaseAccepted": False}
    return result


def verify_current_workload(deployment, staged, private, project, workload, verify):
    bypass = frontend_probe._automation_bypass(project)
    challenge = secrets.token_hex(32)
    verify()
    observed = frontend_probe.ProbeClient().request(deployment["url"], private["secret"], bypass, challenge, mode="phase2")
    verify()
    demand(type(observed.get("version")) is int and observed["version"] == 1 and
           observed.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and observed.get("challenge") == challenge and
           observed.get("checks") == ["gateway-course-catalog-p2"] and observed.get("contractPhase") == "p2" and
           observed.get("featureControls") == workload.get("featureControls") and
           observed.get("writerAdmissionBinding") == workload.get("writerAdmissionBinding") and
           observed.get("gatewayOrigin") == private.get("gatewayOrigin") and
           all(observed.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit")) and
           int(time.time() * 1000) < private["expiresAt"], "PROFILED_CURRENT_RECOVERY_LIVE_WORKLOAD_UNVERIFIED")


def observe_recovery(initial, provider, verify=checkpoint):
    """GET-first recovery selected only by a source-owned broker carrier.

    No caller path, program name, callback, workload proof or provider response
    can authorize a POST. The returned workload is the exact pinned raw receipt.
    """
    expected, plan, candidate, _job, pins = recovery_context(initial, provider)
    parent = private_directory(provider["originalDirectory"])
    attempt = existing_child(parent, "vercel")
    for key, name in PIN_NAMES.items():
        demand(sha(migrate.read_input(attempt, name)) == pins[key], "PROFILED_CURRENT_ORIGINAL_RECEIPT_MISMATCH")
    client = GuardedClient(vercel.Client(provider["vercelToken"]), attempt, verify, read_only=True)
    environment, project_id, source_commit = vercel.release_identity(candidate, expected_profile=expected)
    staged = vercel._staged_identity(candidate, attempt, expected_profile=expected)
    # A matching current effect is unique across the bounded project inventory.
    matches = matching_deployments(client, project_id, source_commit, candidate["releaseId"])
    demand(matches == [staged["deploymentId"]],
           "PROFILED_CURRENT_DEPLOYMENT_EFFECT_AMBIGUOUS")
    deployment = vercel.deployment_state(client, staged["deploymentId"], project_id, source_commit, candidate["releaseId"])
    state = vercel.promotion_state(client, project_id)
    intent = migrate.read_json(attempt, "frontend-promotion-started.json", expected_profile=expected)
    alias = state.get("aliasJob")
    demand(environment == "staging" and deployment.get("readyState") == "READY" and state.get("cronsEnabled") is False and
           state.get("productionDeploymentId") == staged["deploymentId"] and isinstance(alias, dict) and
           alias.get("jobStatus") == "succeeded" and alias.get("type") == "promote" and
           alias.get("toDeploymentId") == staged["deploymentId"] and alias.get("requestedAt") > intent.get("previousAliasRequestedAt", 0),
           "PROFILED_CURRENT_RECOVERY_EFFECT_UNVERIFIED")
    private = frontend_probe._private_input(private_directory(parent / "vercel-private"), staged, expected_profile=expected)
    raw = migrate.read_input(attempt, "frontend-workload-outcome.json")
    workload = migrate.read_json(attempt, "frontend-workload-outcome.json", expected_profile=expected)
    require_qualification_target_profile(expected, workload)
    demand(workload.get("version") == 2 and workload.get("status") == "FRONTEND_VERIFIED" and
           all(workload.get(key) == staged[key] for key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId")) and
           workload.get("contractPhase") == "p2" and frontend_probe.valid_feature_controls(workload.get("featureControls")) and
           frontend_probe.valid_writer_admission_binding(workload.get("writerAdmissionBinding")),
           "PROFILED_CURRENT_RECOVERY_WORKLOAD_UNVERIFIED")
    project = vercel._project(client, project_id)
    verify_current_workload(deployment, staged, private, project, workload, verify)
    cron = project.get("crons") or {}
    demand((project.get("targets") or {}).get("production", {}).get("id") == staged["deploymentId"] and
           cron.get("deploymentId") == staged["deploymentId"] and cron.get("disabledAt") is not None,
           "PROFILED_CURRENT_RECOVERY_SCHEDULE_UNVERIFIED")
    expected_cron = {"path": "/api/cron/account-lifecycle", "schedule": "* * * * *",
                     "host": deployment["url"].removeprefix("https://")}
    definitions = cron.get("definitions")
    demand(isinstance(definitions, list) and len(definitions) == 1 and
           all(definitions[0].get(key) == value for key, value in expected_cron.items()),
           "PROFILED_CURRENT_RECOVERY_SCHEDULE_UNVERIFIED")
    proof = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
        "status": "P2_PROFILED_CURRENT_FRONTEND_VERIFIED", "environment": "staging",
        "actionId": candidate["releaseId"], "releaseId": candidate["releaseId"], "sourceCommit": source_commit,
        "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"],
        "targetSha256": plan["targetSha256"], "contractPhase": "p2",
        "phase2ContractManifestSha256": candidate["phase2ContractManifestSha256"], "projectId": project_id,
        "deploymentId": staged["deploymentId"], "readyState": "READY", "aliasJobState": "succeeded",
        "aliasDeploymentId": staged["deploymentId"], "aliasJobDeploymentId": staged["deploymentId"],
        "aliasJobMatchesIntent": True, "aliasJobType": "promote", "workloadVerified": True,
        "workloadReceiptSha256": sha(raw), "configurationRecordSha256": sha(raw),
        "featureControls": workload["featureControls"], "writerAdmissionBinding": workload["writerAdmissionBinding"],
        "certificationSchedule": {**expected_cron, "deploymentId": staged["deploymentId"], "nativeEnabled": False,
            "definitionsSha256": sha(json.dumps(definitions, separators=(",", ":")).encode())},
        "admissionNewWork": False, "admissionRecovery": False, **{key: False for key in FALSE_FIELDS}}
    result = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
        "status": "P2_PROFILED_CURRENT_FRONTEND_CURRENT", "environment": "staging",
        "actionId": candidate["releaseId"], "releaseId": candidate["releaseId"], "sourceCommit": source_commit,
        "candidateSha256": plan["candidateSha256"], "configurationSha256": plan["configurationSha256"],
        "targetSha256": plan["targetSha256"], "projectId": project_id, "deploymentId": staged["deploymentId"],
        "workloadReceiptSha256": sha(raw), "configurationRecordSha256": sha(raw), "getFirst": True,
        "newProviderPost": False, "ambiguous": False,
        "originalEffectReconciled": plan["disposition"] == "reconcile-frontend-get-first",
        "originalReceiptSha256": pins_sha(pins), "admissionNewWork": False, "admissionRecovery": False,
        "proof": proof, **{key: False for key in FALSE_FIELDS}}
    return {"observation": result, "proof": proof, "workload": raw}


def main():
    try:
        resolve_qualification_target_profile(PROFILE)
        raw = sys.stdin.buffer.readline(MAXIMUM + 1)
        demand(0 < len(raw) <= MAXIMUM, "PROFILED_CURRENT_FRONTEND_INPUT_REFUSED")
        context = json.loads(raw)
        operation = context.get("operation")
        if operation == "deploy":
            result = deploy(context)
        elif operation == "observe":
            result = observe(context)
        elif operation == "recovery-observe":
            provider = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
                        "vercelToken": context["vercelToken"], "originalDirectory": context["originalDirectory"],
                        "bindings": context["bindings"]}
            result = observe_recovery(context, provider)["observation"]
        elif operation == "recovery-observe-lost-build":
            provider = {"version": 2, "qualificationTargetProfile": dict(PROFILE),
                        "vercelToken": context["vercelToken"], "originalDirectory": context["originalDirectory"],
                        "bindings": context["bindings"]}
            result = observe_lost_build_post_ack(context, provider)
        else:
            raise ValueError("PROFILED_CURRENT_FRONTEND_OPERATION_REFUSED")
        print(json.dumps({"type": "result", "value": result}, separators=(",", ":")), flush=True)
    except BaseException:
        print('{"type":"error","code":"P2_PROFILED_CURRENT_FRONTEND_REVIEW_REQUIRED"}', flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
