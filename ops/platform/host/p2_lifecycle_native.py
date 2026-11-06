"""Lifecycle-only staging native controls. No CLI credentials or business cron profile.

The reviewed parent supplies its existing private provider/probe context and
actual host-lock verifier. This module never runs or synthesizes a cron request.
"""
import secrets
from pathlib import Path

import frontend_probe
import migrate
import vercel

PATH = "/api/cron/account-lifecycle"
SCHEDULE = "* * * * *"
demand = migrate.demand


def identity(context):
    candidate, plan = context["candidate"], context["plan"]
    environment, project, commit = vercel.release_identity(candidate)
    demand(environment == "staging" and project == vercel.PROJECTS["staging"]
           and plan.get("version") == 1 and plan.get("environment") == "staging"
           and plan.get("projectId") == project and plan.get("sourceCommit") == commit
           and plan.get("actionId") == candidate["releaseId"] and candidate.get("contractPhase") == "p2"
           and plan.get("phase2ContractManifestSha256") == candidate.get("phase2ContractManifestSha256")
           and plan.get("schedule") == {"path": PATH, "schedule": SCHEDULE}
           and plan.get("finalDisposition") == "disabled-and-admission-closed", "P2_NATIVE_PLAN_REFUSED")
    return plan


def observe_metadata(context, client):
    plan = identity(context)
    state = vercel.deployment_state(client, plan["deploymentId"], plan["projectId"], plan["sourceCommit"], plan["actionId"])
    project = vercel._project(client, plan["projectId"])
    cron = project.get("crons") or {}
    definitions = cron.get("definitions")
    demand(state["readyState"] == "READY" and state["url"] == plan["deploymentUrl"]
           and (project.get("targets") or {}).get("production", {}).get("id") == plan["deploymentId"]
           and cron.get("deploymentId") == plan["deploymentId"] and isinstance(definitions, list) and len(definitions) == 1
           and definitions[0].get("path") == PATH and definitions[0].get("schedule") == SCHEDULE
           and definitions[0].get("host") == plan["deploymentUrl"].removeprefix("https://"), "P2_NATIVE_EXACT_DEFINITION_REQUIRED")
    return {"projectId": plan["projectId"], "deploymentId": plan["deploymentId"], "sourceCommit": plan["sourceCommit"],
            "deploymentUrl": state["url"], "schedule": {"path": PATH, "schedule": SCHEDULE}, "nativeEnabled": cron.get("disabledAt") is None,
            "providerQueuedInvocations": None, "providerActiveInvocations": None, "cancellationVerified": False}


def observe(context, client, probe=None):
    """Authenticated actual ten-control P2 profile; never the old off profile."""
    plan = identity(context)
    metadata = observe_metadata(context, client)
    project = vercel._project(client, plan["projectId"])
    configuration = context.get("configurationRecordSha256")
    demand(configuration == plan["configurationRecordSha256"], "P2_NATIVE_CONFIGURATION_RECORD_REQUIRED")
    private = frontend_probe._private_input(Path(context["privateProbeDirectory"]), {
        "environment": "staging", "projectId": plan["projectId"], "sourceCommit": plan["sourceCommit"], "releaseId": plan["actionId"]})
    challenge = secrets.token_hex(32)
    result = (probe or frontend_probe.ProbeClient()).request(metadata["deploymentUrl"], private["secret"], frontend_probe._automation_bypass(project), challenge, mode="phase2")
    demand(result.get("version") == 1 and result.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and result.get("challenge") == challenge
           and result.get("environment") == "staging" and result.get("projectId") == plan["projectId"] and result.get("sourceCommit") == plan["sourceCommit"]
           and result.get("gatewayOrigin") == private["gatewayOrigin"] and result.get("contractPhase") == "p2"
           and result.get("checks") == ["gateway-course-catalog-p2"]
           and frontend_probe.valid_feature_controls(result.get("featureControls")) and result["featureControls"] == plan["featureControls"], "P2_NATIVE_RUNTIME_PROFILE_UNVERIFIED")
    binding = result.get("writerAdmissionBinding")
    demand(isinstance(binding, dict) and binding == plan["writerAdmissionBinding"], "P2_NATIVE_RUNTIME_ADMISSION_BINDING_UNVERIFIED")
    normalized = {**metadata, "configurationRecordSha256": configuration, "featureControls": result["featureControls"], "writerAdmissionBinding": binding}
    return normalized


def set_enabled(context, client, enabled, attempt, verify, probe=None):
    """One explicit toggle, durable intent/readback; unknown mutation is not retried."""
    demand(type(enabled) is bool and callable(verify), "P2_NATIVE_EXPLICIT_TOGGLE_REQUIRED")
    plan = identity(context)
    verify()
    # Disable does not depend on a healthy gateway/probe or unexpired probe
    # credential. It still requires the exact selected project/deployment/cron.
    before = observe(context, client, probe) if enabled else observe_metadata(context, client)
    demand(before["nativeEnabled"] is not enabled, "P2_NATIVE_TOGGLE_PRECONDITION_REFUSED")
    name = "enable" if enabled else "disable"
    migrate.private_directory(attempt)
    intent = {"version": 1, "actionId": plan["actionId"], "projectId": plan["projectId"], "deploymentId": plan["deploymentId"],
              "sourceCommit": plan["sourceCommit"], "planSha256": plan["planSha256"], "operation": name,
              "schedule": plan["schedule"], "nativeEnabledRequested": enabled, "migrationAuthorized": False}
    record_failed = False
    try:
        migrate.write_json(attempt, f"p2-native-{name}-intent.json", intent)
    except BaseException:
        if enabled:
            raise
        # The reviewed plan mandates disable as containment. Lost later
        # recording must not prevent removing temporary native capability.
        record_failed = True
    outcome = {**intent, "status": "P2_NATIVE_TOGGLE_REQUIRES_REVIEW", "mutationOutcome": "not-started"}
    try:
        verify()
        outcome["mutationOutcome"] = "unknown"
        client.request("PATCH", f'/v1/projects/{plan["projectId"]}/crons', {"enabled": enabled})
        after = observe(context, client, probe) if enabled else observe_metadata(context, client)
        demand(after["nativeEnabled"] is enabled, "P2_NATIVE_TOGGLE_READBACK_UNVERIFIED")
        verify()
        outcome.update(status="P2_NATIVE_TOGGLE_OBSERVED", mutationOutcome="observed", observation=after, recordLoss=record_failed)
        return outcome
    finally:
        migrate.write_json(attempt, f"p2-native-{name}-outcome.json", outcome)
