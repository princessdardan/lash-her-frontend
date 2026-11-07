"""Private authority and gateway fence for one reviewed browser epoch."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import time

import migrate
import p2_interactive_ingress as ingress
import p2_lifecycle_native as native
from frontend_release_adapters import LockedClient


_SOURCE = Path(__file__).resolve()
_SOURCE_KEY = "ops/platform/host/p2_interactive_window.py"
_STAGES = {"identity", "authoring", "media", "learning", "paid-grant", "lifecycle"}
_GATEWAY_STAGES = {"authoring", "media", "learning", "paid-grant"}
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
_SHA = re.compile(r"[a-f0-9]{64}")
_SOURCE_SHA = re.compile(r"[a-f0-9]{40}")
_EPOCH = re.compile(r"[1-9][0-9]{0,17}")
_NONCE = re.compile(r"[a-f0-9]{32}")
_DEPLOYMENT = re.compile(r"https://([a-z0-9][a-z0-9-]*\.vercel\.app)")
_TARGET = re.compile(r"/course/v1/[A-Za-z0-9/_-]+(?:\?[!$%&'()*+,./:;=?@\[\]_~A-Za-z0-9-]+)?")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_EMPTY = hashlib.sha256(b"").hexdigest()
_MAX_STATE = 16_384
_GATEWAY_GID = 65532
_ZERO = {"newWork": 0, "recovery": 0}
CLOSED_BROWSER_STAGES = frozenset(("identity", "lifecycle"))
EXECUTABLE_BROWSER_STAGES = CLOSED_BROWSER_STAGES | {"authoring"}
_CREATE_DRAFT = "create-draft"
_EDIT_DRAFT = "edit-and-stale-draft"
_CREATE_CURRICULUM = "create-curriculum"
_REORDER_CURRICULUM = "reorder-and-stale-curriculum"
_CURRICULUM_OPERATIONS = (_CREATE_CURRICULUM, _REORDER_CURRICULUM)
_BROWSER_SOURCE = "ops/platform/p2-lifecycle-browser-recorder.mjs"
_BROWSER_LAUNCHER = b"\nawait runP2LifecycleBrowserChild();\n"
demand = migrate.demand


def _matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def _canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _instant(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _digest(value):
    return _matches(_SHA, value) and value != "0" * 64


def _closed_fields(value, fields):
    return type(value) is dict and set(value) == set(fields.split())


def _safe_integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**53 - 1


def _receipt_sha(value):
    return _hash(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())


def _browser_stage(plan):
    stage = plan["scopedAction"]["stage"]
    demand(type(stage) is str and stage in EXECUTABLE_BROWSER_STAGES, "P2_INTERACTIVE_BROWSER_STAGE_REQUIRED")
    return stage


def browser_artifact(plan, artifact):
    return f"p2-interactive-{_browser_stage(plan)}-{artifact}.json"


def browser_evidence_limit(plan):
    authoring = plan["scopedAction"].get("authoringAction", {})
    return 96 * 1024 if authoring.get("operation") == _REORDER_CURRICULUM else 8192


def browser_status(plan, disposition):
    return f"P2_INTERACTIVE_{_browser_stage(plan).upper()}_{disposition}"


def verify_browser_controller(initial, source):
    plan, controller = initial["certificationPlan"], initial.get("interactiveController")
    _browser_stage(plan)
    demand(plan.get("mode") == "interactive-browser" and
           _closed_fields(controller, "challenge bindingSha256 browserProgramSha256") and
           all(_digest(value) for value in controller.values()) and controller["bindingSha256"] == plan["planSha256"],
           "P2_INTERACTIVE_CONTROLLER_BINDING_REQUIRED")
    raw = migrate.read_input(source, _BROWSER_SOURCE)
    demand(_hash(raw) == initial["sourceSha256"].get(_BROWSER_SOURCE) and
           _hash(raw + _BROWSER_LAUNCHER) == controller["browserProgramSha256"],
           "P2_INTERACTIVE_BROWSER_SOURCE_BINDING_REQUIRED")
    return controller["browserProgramSha256"]


def browser_receipt(plan, disposition):
    return {"version": 2, "qualificationTargetProfile": plan["qualificationTargetProfile"],
            "status": browser_status(plan, disposition), "certificationActionId": plan["certificationActionId"],
            "planSha256": plan["planSha256"], "stage": _browser_stage(plan)}


def browser_case_evidence(plan, evidence, *, gateway_artifact=None):
    action = validate_interactive_action(plan["scopedAction"])
    stage = _browser_stage(plan)
    if stage == "authoring":
        return _authoring_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == "lifecycle":
        return _lifecycle_case_evidence(action, evidence)
    demand(_closed_fields(evidence, "browserIdentity identityWitness"), "P2_INTERACTIVE_IDENTITY_EVIDENCE_REQUIRED")
    identity, witness = evidence["browserIdentity"], evidence["identityWitness"]
    demand(_closed_fields(identity, "actorKind actorId sessionVerified") and identity["sessionVerified"] is True and
           _matches(_UUID, identity["actorId"]), "P2_INTERACTIVE_IDENTITY_SESSION_REQUIRED")
    enrollment = action.get("identityEnrollment")
    actor = action["identityActor"] if enrollment is None else {"actorKind": "customer", "actorId": identity["actorId"]}
    owner = actor["actorKind"] == "admin"
    demand(all(identity[key] == value for key, value in actor.items()), "P2_INTERACTIVE_IDENTITY_SESSION_REQUIRED")
    fields = "actorKind actorId actorActive " + ("ownerMappingVerified" if owner else "liveSessionCount")
    if enrollment is not None:
        fields += " provider providerLinkCount"
    demand(_closed_fields(witness, fields) and witness["actorActive"] is True and
           all(witness[key] == value for key, value in actor.items()), "P2_INTERACTIVE_IDENTITY_WITNESS_REQUIRED")
    if enrollment is not None:
        provider = enrollment["provider"]
        demand(type(witness["liveSessionCount"]) is int and witness["liveSessionCount"] == 1 and
               witness["provider"] == provider and type(witness["providerLinkCount"]) is int and
               witness["providerLinkCount"] == (1 if provider == "google" else 0),
               "P2_INTERACTIVE_IDENTITY_ENROLLMENT_WITNESS_REQUIRED")
    else:
        demand(witness["ownerMappingVerified"] is True if owner else _safe_integer(witness["liveSessionCount"], 1),
               "P2_INTERACTIVE_IDENTITY_WITNESS_REQUIRED")
    return {**actor, "context": "owner" if owner else "learner", "browserIdentitySha256": _receipt_sha(identity),
            "identityWitnessSha256": _receipt_sha(witness)}


def _curriculum_path(action):
    path = (f'/admin/courses/{action["courseId"]}/modules' if action["kind"] == "module" else
            f'/admin/modules/{action["parentId"]}/lessons')
    return f"{path}/reorder" if action["operation"] == _REORDER_CURRICULUM else path


def _authoring_requests(action):
    operation = action["operation"]
    if operation == _CREATE_DRAFT:
        return (("GET", "/course/v1/admin/courses?limit=100", 1, 200), ("POST", "/course/v1/admin/courses", 1, 201))
    course = f'/course/v1/admin/courses/{action["courseId"]}'
    if operation == _CREATE_CURRICULUM:
        return (("GET", course, 2, 200), ("POST", f"/course/v1{_curriculum_path(action)}", 1, 201))
    method, target = ("POST", f"/course/v1{_curriculum_path(action)}") if operation == _REORDER_CURRICULUM else ("PATCH", course)
    return (("GET", course, 3, 200), (method, target, 1, 200), (method, target, 1, 409))


def authoring_gateway_receipt(plan, artifact):
    common = browser_receipt(plan, "GATEWAY_OBSERVED")
    fields = set(common) | {"epoch", "gatewayStateSha256", "gatewayAcknowledgements", "gatewayActive", "gatewayUncertain"}
    demand(common["stage"] == "authoring" and type(artifact) is dict and set(artifact) == fields and
           _receipt_sha({key: artifact[key] for key in common}) == _receipt_sha(common) and
           artifact["epoch"] == str(int(plan["initialEpoch"]) + 1) and _digest(artifact["gatewayStateSha256"]) and
           all(type(artifact[key]) is int and artifact[key] == 0 for key in ("gatewayActive", "gatewayUncertain")),
           "P2_INTERACTIVE_AUTHORING_GATEWAY_ARTIFACT_REQUIRED")
    selected = plan["scopedAction"]["authoringAction"]
    requests = _authoring_requests(selected)
    rows = artifact["gatewayAcknowledgements"]
    demand(type(rows) is list and len(rows) == sum(row[2] for row in requests) and all(
               _closed_fields(row, "requestId proofRequestId requestIndex upstreamStatus") and
               _matches(_UUID, row["requestId"]) and _matches(_UUID, row["proofRequestId"]) and
               type(row["requestIndex"]) is int and 0 <= row["requestIndex"] < len(requests) and
               type(row["upstreamStatus"]) is int and row["upstreamStatus"] == requests[row["requestIndex"]][3]
               for row in rows) and
           len({row["requestId"] for row in rows}) == len({row["proofRequestId"] for row in rows}) == len(rows),
           "P2_INTERACTIVE_AUTHORING_ACKNOWLEDGEMENTS_REQUIRED")
    indices = [row["requestIndex"] for row in rows]
    expected_order = {
        _CREATE_DRAFT: [0, 1],
        _CREATE_CURRICULUM: [0, 1, 0],
        _EDIT_DRAFT: [0, 0, 1, 0, 2],
        _REORDER_CURRICULUM: [0, 0, 1, 0, 2],
    }[selected["operation"]]
    demand(indices == expected_order,
           "P2_INTERACTIVE_AUTHORING_ACKNOWLEDGEMENTS_REQUIRED")
    return {**artifact, "gatewayEvidenceSha256": _receipt_sha(artifact)}


def _authoring_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["authoringAction"]
    reordering = selected["operation"] == _REORDER_CURRICULUM
    editing = selected["operation"] == _EDIT_DRAFT
    browser_key = "browserResponses" if editing or reordering else "browserResponse"
    demand(_closed_fields(evidence, f"{browser_key} courseWitness"), "P2_INTERACTIVE_AUTHORING_EVIDENCE_REQUIRED")
    gateway = authoring_gateway_receipt(plan, gateway_artifact)
    mutations = [row["requestId"] for row in gateway["gatewayAcknowledgements"] if row["requestIndex"] > 0]
    response, witness = evidence[browser_key], evidence["courseWitness"]
    if reordering:
        return _curriculum_case_evidence(action, response, witness, gateway, mutations)
    if selected["operation"] == _CREATE_CURRICULUM:
        return _curriculum_create_case_evidence(action, response, witness, gateway, mutations[0])
    browser = response
    pathname = "/api/admin/courses"
    method, revision = "POST", 1
    if editing:
        demand(_closed_fields(response, "winner stale"), "P2_INTERACTIVE_AUTHORING_EVIDENCE_REQUIRED")
        browser, stale = response["winner"], response["stale"]
        pathname += f'/{selected["courseId"]}'
        method, revision = "PATCH", selected["revision"] + 1
        demand(_closed_fields(stale, "method pathname status requestId outcome dirtyInputPreserved") and
               stale["method"] == method and stale["pathname"] == pathname and type(stale["status"]) is int and
               stale["status"] == 409 and stale["requestId"] == mutations[1] and stale["outcome"] == "conflict" and
               stale["dirtyInputPreserved"] is True, "P2_INTERACTIVE_AUTHORING_STALE_RESPONSE_REQUIRED")
    demand(_closed_fields(browser, "method pathname status requestId body") and browser["method"] == method and
           browser["pathname"] == pathname and type(browser["status"]) is int and browser["status"] == 200 and
           browser["requestId"] == mutations[0], "P2_INTERACTIVE_AUTHORING_BROWSER_RESPONSE_REQUIRED")
    body = browser["body"]
    demand(_closed_fields(body, "courseId slug revision status") and _matches(_UUID, body["courseId"]) and
           (not editing or body["courseId"] == selected["courseId"]) and body["slug"] == selected["slug"] and
           type(body["revision"]) is int and body["revision"] == revision and
           body["status"] == "draft", "P2_INTERACTIVE_AUTHORING_BROWSER_BODY_REQUIRED")
    demand(_closed_fields(witness, "courseId slug revision status readOnly") and witness["readOnly"] is True and
           type(witness["revision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    observed = ({"gatewayPatchRequestIds": mutations, "browserResponsesSha256": _receipt_sha(response)} if editing else
                {"gatewayPostRequestId": mutations[0], "browserResponseSha256": _receipt_sha(browser)})
    return {"operation": selected["operation"], "slug": selected["slug"], "actorId": action["actorId"],
            "courseId": body["courseId"], "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"], **observed}


def _curriculum_create_case_evidence(action, response, witness, gateway, mutation_id):
    selected = action["authoringAction"]
    pathname = f"/api{_curriculum_path(selected)}"
    demand(_closed_fields(response, "method pathname status requestId body") and response["method"] == "POST" and
           response["pathname"] == pathname and type(response["status"]) is int and response["status"] == 200 and
           response["requestId"] == mutation_id, "P2_INTERACTIVE_AUTHORING_CURRICULUM_RESPONSE_REQUIRED")
    body = response["body"]
    fields = "courseId parentId kind itemId slug revision"
    demand(_closed_fields(body, fields) and all(body[key] == selected[key] for key in ("courseId", "parentId", "kind")) and
           _matches(_UUID, body["itemId"]) and body["slug"] == selected["childSlug"] and
           type(body["revision"]) is int and body["revision"] == selected["revision"] + 1,
           "P2_INTERACTIVE_AUTHORING_CURRICULUM_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} readOnly") and witness["readOnly"] is True and
           type(witness["revision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    return {**{key: selected[key] for key in ("operation", "courseId", "slug", "kind", "parentId", "childSlug")},
            "actorId": action["actorId"], "itemId": body["itemId"], "revision": body["revision"],
            "gatewayPostRequestId": mutation_id, "browserResponseSha256": _receipt_sha(response),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _curriculum_case_evidence(action, response, witness, gateway, mutations):
    selected = action["authoringAction"]
    demand(_closed_fields(response, "winner stale"), "P2_INTERACTIVE_AUTHORING_EVIDENCE_REQUIRED")
    winner, stale = response["winner"], response["stale"]
    pathname = f"/api{_curriculum_path(selected)}"
    common = "method pathname status requestId keyboardActivated"
    demand(_closed_fields(winner, f"{common} body") and _closed_fields(stale, f"{common} outcome") and
           all(item["method"] == "POST" and item["pathname"] == pathname and type(item["status"]) is int and
               item["status"] == status and item["requestId"] == request_id and item["keyboardActivated"] is True
               for item, status, request_id in zip((winner, stale), (200, 409), mutations)) and stale["outcome"] == "conflict",
           "P2_INTERACTIVE_AUTHORING_REORDER_RESPONSES_REQUIRED")
    body = winner["body"]
    fields = "courseId parentId kind revision ids"
    demand(_closed_fields(body, fields) and all(body[key] == selected[key] for key in ("courseId", "parentId", "kind")) and
           type(body["revision"]) is int and body["revision"] == selected["revision"] + 1 and
           type(body["ids"]) is list and 3 <= len(body["ids"]) <= 1000 and all(_matches(_UUID, value) for value in body["ids"]) and
           len(set(body["ids"])) == len(body["ids"]), "P2_INTERACTIVE_AUTHORING_REORDER_BODY_REQUIRED")
    winner_body = {"expectedCourseRevision": selected["revision"], "ids": body["ids"]}
    demand(_receipt_sha(winner_body) == action["requests"][1]["bodySha256"], "P2_INTERACTIVE_AUTHORING_REORDER_ORDER_REFUSED")
    demand(_closed_fields(witness, f"{fields} readOnly") and witness["readOnly"] is True and
           type(witness["revision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    return {**{key: selected[key] for key in ("operation", "courseId", "slug", "kind", "parentId")}, "actorId": action["actorId"],
            "gatewayPostRequestIds": mutations, "browserResponsesSha256": _receipt_sha(response),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _lifecycle_case_evidence(action, evidence):
    demand(_closed_fields(evidence, "browserResponse lifecycleWitness"), "P2_INTERACTIVE_LIFECYCLE_EVIDENCE_REQUIRED")
    selection = {**action["frontendAction"], "actorId": action["actorId"]}
    actor, user, operation = (selection[key] for key in ("actorKind", "userId", "operation"))
    preferences = operation in ("preferences-on", "preferences-off")
    pathname = f"/api/admin/customer-accounts/{user}/commands" if actor == "admin" else (
        "/api/account/preferences" if preferences else "/api/account/commands")
    browser, witness = evidence["browserResponse"], evidence["lifecycleWitness"]
    status = 200 if preferences else 202
    demand(_closed_fields(browser, "method pathname status requestId body") and browser["method"] == "POST" and
           browser["pathname"] == pathname and type(browser["status"]) is int and browser["status"] == status and
           _matches(_UUID, browser["requestId"]), "P2_INTERACTIVE_LIFECYCLE_BROWSER_RESPONSE_REQUIRED")
    body = browser["body"]
    demand((_closed_fields(body, "saved") and body["saved"] is True) if preferences else (
           _closed_fields(body, "commandId action accountVersion status") and _matches(_UUID, body["commandId"]) and
           body["action"] == operation and _safe_integer(body["accountVersion"], 1) and body["status"] == "pending"),
           "P2_INTERACTIVE_LIFECYCLE_BROWSER_BODY_REQUIRED")
    demand(_closed_fields(witness, "version status actorKind actorId userId operation requestId httpStatus baselineSha256 "
                           "frontendStatus accountVersion sessionsBefore sessionsAfter learningUpdates commandId deliveries "
                           "pendingOrDeliveringCount observedAt readOnly") and
           type(witness["version"]) is int and witness["version"] == 1 and
           witness["status"] == "P2_INTERACTIVE_LIFECYCLE_CASE_OBSERVED" and witness["readOnly"] is True and
           all(witness[key] == value for key, value in selection.items()) and witness["requestId"] == browser["requestId"] and
           type(witness["httpStatus"]) is int and witness["httpStatus"] == status and _digest(witness["baselineSha256"]) and
           all(_safe_integer(witness[key]) for key in ("accountVersion", "sessionsBefore", "sessionsAfter",
                                                       "pendingOrDeliveringCount")) and
           type(witness["learningUpdates"]) is bool and
           _matches(re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"), witness["observedAt"]),
           "P2_INTERACTIVE_LIFECYCLE_WITNESS_REQUIRED")
    datetime.strptime(witness["observedAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    frontend, before, after = (witness[key] for key in ("frontendStatus", "sessionsBefore", "sessionsAfter"))
    if preferences:
        demand(witness["commandId"] is None and witness["deliveries"] == [] and frontend == "active" and
               before == after and after > 0 and witness["learningUpdates"] is (operation == "preferences-on"),
               "P2_INTERACTIVE_LIFECYCLE_PREFERENCES_WITNESS_REQUIRED")
    else:
        deliveries = witness["deliveries"]
        demand(witness["commandId"] == body["commandId"] and witness["accountVersion"] == body["accountVersion"] and
               witness["pendingOrDeliveringCount"] >= 2 and type(deliveries) is list and len(deliveries) == 2 and all(
                   _closed_fields(row, "receiver status attempts") and row["receiver"] == receiver and
                   row["status"] == "pending" and type(row["attempts"]) is int and row["attempts"] == 0
                   for row, receiver in zip(deliveries, ("course", "community"))),
               "P2_INTERACTIVE_LIFECYCLE_COMMAND_WITNESS_REQUIRED")
        if operation == "export":
            demand(frontend in ("active", "suspended") and before == after and
                   (actor == "admin" or frontend == "active" and after > 0), "P2_INTERACTIVE_LIFECYCLE_EXPORT_WITNESS_REQUIRED")
        elif operation == "delete":
            demand(frontend == "deleted" and after == 0 and witness["learningUpdates"] is False,
                   "P2_INTERACTIVE_LIFECYCLE_DELETE_WITNESS_REQUIRED")
        else:
            demand(frontend == "suspended" and after == 0 and (operation != "restore" or before == 0),
                   "P2_INTERACTIVE_LIFECYCLE_SUSPENSION_WITNESS_REQUIRED")
    return {**selection, "browserResponseSha256": _receipt_sha(browser), "lifecycleWitnessSha256": _receipt_sha(witness)}


def require_browser_ledger(plan, witness):
    demand(_closed_fields(witness, "commands deliveries orderViolations operations") and
           witness["commands"] == witness["deliveries"] == witness["orderViolations"] == [] and
           type(witness["operations"]) is list and 0 < len(witness["operations"]) <= 4096,
           browser_status(plan, "LEDGER_REQUIRED"))
    operations = witness["operations"]
    epoch = str(int(plan["initialEpoch"]) + 1)
    producer = _hash(f'lash-her:p2q:interactive-producer:v1\n{plan["sourceCommit"]}\n{plan["targetSha256"]}'.encode())
    demand(all(_closed_fields(row, "id epoch kind state producer_sha256 source_sha role_oid completed_at reconciliation_sha256") and
               _matches(_UUID, row["id"]) and row["epoch"] == epoch and row["source_sha"] == plan["sourceCommit"] and
               row["producer_sha256"] == producer and row["role_oid"] == plan["nativePlan"]["producer"]["role"]["oid"] and
               row["kind"] in ("new-work", "recovery") and row["state"] == "completed" and
               type(row["completed_at"]) is str and row["reconciliation_sha256"] is None for row in operations) and
           len({row["id"] for row in operations}) == len(operations) and
           any(row["kind"] == "new-work" for row in operations),
           browser_status(plan, "COMPLETED_NEW_WORK_REQUIRED"))
    return len(operations)


def validate_interactive_action(action):
    lifecycle = type(action) is dict and action.get("stage") == "lifecycle"
    identity = type(action) is dict and action.get("stage") == "identity"
    authoring = type(action) is dict and action.get("stage") == "authoring"
    fields = {"stage", "actorId", "requests", "windowSeconds"}
    if lifecycle:
        fields.add("frontendAction")
    if authoring:
        fields.add("authoringAction")
    enrollment = identity and "identityEnrollment" in action
    if identity:
        fields.add("identityEnrollment" if enrollment else "identityActor")
    demand(type(action) is dict and set(action) == fields and
           type(action["stage"]) is str and action["stage"] in _STAGES and
           type(action["windowSeconds"]) is int and 30 <= action["windowSeconds"] <= 300 and
           type(action["requests"]) is list and
           (action["actorId"] is None if identity else _matches(_UUID, action["actorId"])),
           "P2_INTERACTIVE_ACTION_REQUIRED")
    gateway = action["stage"] in _GATEWAY_STAGES
    requests = action["requests"]
    demand(1 <= len(requests) <= 16 if gateway else requests == [], "P2_INTERACTIVE_REQUESTS_REQUIRED")
    if lifecycle:
        frontend = action["frontendAction"]
        demand(type(frontend) is dict and set(frontend) == {"actorKind", "userId", "operation"} and
               _matches(_UUID, frontend["userId"]) and
               (frontend["operation"] in ("suspend", "restore", "export", "delete") if frontend["actorKind"] == "admin" else
                frontend["actorKind"] == "customer" and frontend["userId"] == action["actorId"] and
                frontend["operation"] in ("export", "delete", "preferences-on", "preferences-off")),
               "P2_INTERACTIVE_FRONTEND_ACTION_REQUIRED")
    if enrollment:
        selected_enrollment = action["identityEnrollment"]
        demand(_closed_fields(selected_enrollment, "provider emailSha256 nonce") and
               selected_enrollment["provider"] in ("google", "resend") and _digest(selected_enrollment["emailSha256"]) and
               _matches(_NONCE, selected_enrollment["nonce"]) and selected_enrollment["nonce"] != "0" * 32,
               "P2_INTERACTIVE_IDENTITY_ENROLLMENT_REQUIRED")
    elif identity:
        actor = action["identityActor"]
        demand(_closed_fields(actor, "actorKind actorId") and actor["actorKind"] in ("admin", "customer") and
               _matches(_UUID, actor["actorId"]), "P2_INTERACTIVE_IDENTITY_ACTOR_REQUIRED")
    selected = set()
    for row in requests:
        demand(type(row) is dict and set(row) == {"method", "target", "bodySha256", "uses"} and
               type(row["method"]) is str and row["method"] in {"GET", "POST", "PATCH", "PUT", "DELETE"} and
               _matches(_TARGET, row["target"]) and len(row["target"]) <= 512 and
               "//" not in row["target"].split("?", 1)[0] and
               _matches(_SHA, row["bodySha256"]) and (row["method"] != "GET" or row["bodySha256"] == _EMPTY) and
               type(row["uses"]) is int and 1 <= row["uses"] <= 4, "P2_INTERACTIVE_REQUEST_REQUIRED")
        identity = (row["method"], row["target"], row["bodySha256"])
        demand(identity not in selected, "P2_INTERACTIVE_DUPLICATE_REQUEST")
        selected.add(identity)
    if authoring:
        selected_authoring = action["authoringAction"]
        operation = selected_authoring.get("operation") if type(selected_authoring) is dict else None
        fields = "operation slug"
        if operation in (_EDIT_DRAFT, *_CURRICULUM_OPERATIONS):
            fields += " courseId revision"
        if operation in _CURRICULUM_OPERATIONS:
            fields += " kind parentId"
        if operation == _CREATE_CURRICULUM:
            fields += " childSlug"
        demand(_closed_fields(selected_authoring, fields) and operation in (_CREATE_DRAFT, _EDIT_DRAFT, *_CURRICULUM_OPERATIONS) and
               _matches(_SLUG, selected_authoring["slug"]) and len(selected_authoring["slug"]) <= 120,
               "P2_INTERACTIVE_AUTHORING_DRAFT_REQUIRED")
        if operation != _CREATE_DRAFT:
            demand(_matches(_UUID, selected_authoring["courseId"]) and type(selected_authoring["revision"]) is int and
                   1 <= selected_authoring["revision"] <= 2_147_483_646, "P2_INTERACTIVE_AUTHORING_DRAFT_REQUIRED")
        if operation in _CURRICULUM_OPERATIONS:
            kind, parent = selected_authoring["kind"], selected_authoring["parentId"]
            demand(kind in ("module", "lesson") and _matches(_UUID, parent) and
                   (kind == "lesson" or parent == selected_authoring["courseId"]), "P2_INTERACTIVE_AUTHORING_CURRICULUM_SELECTION_REQUIRED")
        if operation == _CREATE_CURRICULUM:
            child = selected_authoring["childSlug"]
            demand(_matches(_SLUG, child) and len(child) <= 120, "P2_INTERACTIVE_AUTHORING_CHILD_SLUG_REQUIRED")
        expected = _authoring_requests(selected_authoring)
        mutations = [row["bodySha256"] for row in requests[1:]]
        demand(len(requests) == len(expected) and all(
                   (row["method"], row["target"], row["uses"]) == (method, target, uses)
                   for row, (method, target, uses, _) in zip(requests, expected)) and
               all(_digest(digest) and digest != _EMPTY for digest in mutations) and len(set(mutations)) == len(mutations),
               "P2_INTERACTIVE_AUTHORING_DRAFT_REQUIRED")
    return copy.deepcopy(action)


def _selection_sha(action):
    if action["stage"] == "authoring":
        prefix = {
            _CREATE_DRAFT: "7032712d617574686f72696e672d7631",
            _EDIT_DRAFT: "7032712d617574682d656469742d7631",
            _CREATE_CURRICULUM: "7032712d617574682d6e65772d763100",
            _REORDER_CURRICULUM: "7032712d617574682d736f72742d7631",
        }[action["authoringAction"]["operation"]]
        return prefix + action["actorId"].replace("-", "")
    if action["stage"] == "identity":
        if "identityEnrollment" in action:
            enrollment = action["identityEnrollment"]
            return ("a1" if enrollment["provider"] == "google" else "a2") + enrollment["emailSha256"][:62]
        actor = action["identityActor"]
        if actor["actorKind"] == "customer":
            # Hex for "p2q-customer-v1" and a null byte, then the reviewed UUID.
            return "7032712d637573746f6d65722d763100" + actor["actorId"].replace("-", "")
        return _receipt_sha(["identity", actor["actorKind"]])
    if action["stage"] == "lifecycle":
        selected = action["frontendAction"]
        return _receipt_sha([selected["actorKind"], action["actorId"], selected["userId"], selected["operation"]])
    return None


def _material(secret, deployment, source, target, epoch, stage, starts, duration, nonce, selection_sha=None):
    match = _DEPLOYMENT.fullmatch(deployment) if type(deployment) is str else None
    demand(match is not None and _matches(re.compile(r"[!-~]{32,8192}"), secret) and
           _matches(_SOURCE_SHA, source) and _matches(_SHA, target) and _matches(_EPOCH, epoch) and
           type(stage) is str and stage in _STAGES and
           type(starts) is int and 1_000_000_000 <= starts < 9_999_999_700 and
           type(duration) is int and 30 <= duration <= 300 and _matches(_NONCE, nonce),
           "P2_INTERACTIVE_PRIVATE_BINDING_REQUIRED")
    demand(_matches(_SHA, selection_sha) if stage in EXECUTABLE_BROWSER_STAGES else selection_sha is None,
           "P2_INTERACTIVE_FRONTEND_BINDING_REQUIRED")
    host = match.group(1)
    ends = starts + duration
    body = (f"v2.{epoch}.{stage}.{starts}.{ends}.{nonce}.{selection_sha}" if selection_sha is not None else
            f"v1.{epoch}.{stage}.{starts}.{ends}.{nonce}")

    def sign(value):
        return hmac.digest(secret.encode(), value.encode(), "sha256").hex()

    binding = f"{host}\n{source}\n{target}"
    signature = sign(f"lash-her:p2q:interactive:browser:v1\n{binding}\n{body}")
    key = sign(f"lash-her:p2q:interactive:gateway-key:v1\n{binding}\n{epoch}\n{stage}\n{nonce}") if stage in _GATEWAY_STAGES else None
    return f"{body}.{signature}", key, host, ends


def _closed(admission):
    return type(admission) is dict and type(admission.get("version")) is int and admission["version"] == 1 and admission.get("valid") is True and all(
        admission.get(flag) is False for flag in ("newWork", "recovery")) and all(
        type(admission.get(counter)) is dict and set(admission[counter]) == set(_ZERO) and all(
            type(value) is int and value == 0 for value in admission[counter].values())
        for counter in ("active", "uncertain"))


class P2InteractiveWindow:
    def __init__(self, broker):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        demand(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope and
               broker.external_armed is True and broker.guard_arm_verified is True and os.geteuid() == 0,
               "P2_INTERACTIVE_GUARDED_PARENT_REQUIRED")
        plan = broker.initial["certificationPlan"]
        demand(plan["mode"] == "interactive-browser" and plan["startState"] == "already-closed" and
               plan["maximumSeconds"] == 300 and
               broker.initial["sourceSha256"].get(_SOURCE_KEY) == _hash(_SOURCE.read_bytes()),
               "P2_INTERACTIVE_INSTALLED_PLAN_REQUIRED")
        self.broker, self.plan = broker, plan
        self.action = validate_interactive_action(plan["scopedAction"])
        self._private_cookie = None
        self._permit_issued = False
        self._scoped_sha = None
        self._expires = 0
        self._state = "new"
        self._original = None

    def _check(self):
        self.broker.check()
        self.broker.scope.require_frontend(self.broker.selected, self.broker.jobs["frontend"])
        self.broker.scope.require_configuration(self.broker.configuration)

    def _mount(self):
        fd = self.broker.admission_fd
        opened = os.fstat(fd)
        selected = self.broker.admission_identity
        current = os.stat(self.broker.configuration / "admission", follow_symlinks=False)
        demand(stat.S_ISDIR(opened.st_mode) and stat.S_ISDIR(current.st_mode) and opened.st_uid == current.st_uid == 0 and
               not (opened.st_mode | current.st_mode) & 0o022 and
               (opened.st_dev, opened.st_ino) == (selected.st_dev, selected.st_ino) == (current.st_dev, current.st_ino),
               "P2_INTERACTIVE_ADMISSION_MOUNT_CHANGED")
        return fd, opened

    def _read(self):
        directory, _ = self._mount()
        fd = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(fd)
            demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022 and
                   0 < info.st_size <= _MAX_STATE, "P2_INTERACTIVE_STATE_FILE_REQUIRED")
            raw = stream.read(_MAX_STATE + 1)
            demand(len(raw) == info.st_size, "P2_INTERACTIVE_STATE_READ_REQUIRED")
            return raw, stat.S_IMODE(info.st_mode), info.st_gid

    def _replace(self, raw, mode, group):
        directory, _ = self._mount()
        name = ".p2-interactive-" + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchown(stream.fileno(), 0, group)
                os.fchmod(stream.fileno(), mode)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, "state.json", src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass

    def _gateway(self):
        observed = self.broker._gateway_observation()
        _, mount = self._mount()
        demand(observed["processSha256"] == self.plan["gatewayProcessSha256"] and
               observed["gatewayConfigurationSha256"] == self.plan["gatewayConfigurationSha256"] and
               observed["admissionDirectory"] == {"device": str(mount.st_dev), "inode": str(mount.st_ino)} and
               observed["faultLeasePresent"] is False, "P2_INTERACTIVE_GATEWAY_CHANGED")
        return observed["admission"]

    def verify_ordinary_gateway(self):
        gateway = self._gateway()
        original = self._original
        current = self._read()
        demand(_closed(gateway) and (original is None or current == original) and
               gateway["sha256"] == _hash(current[0]) and
               gateway["releaseId"] == self.broker.selected["releaseId"] and
               gateway["candidateSha256"] == self.broker.initial["candidateSha256"],
               "P2_INTERACTIVE_ORDINARY_GATEWAY_CHANGED")
        return gateway

    def prepare(self):
        self._check()
        demand(self._state == "new", "P2_INTERACTIVE_PREPARE_ORDER_REQUIRED")
        frontend = self.broker.observer.probe("observe")["admission"]
        demand(frontend == {"epoch": self.plan["initialEpoch"], "newWork": False, "recovery": False,
                            "active": 0, "uncertain": 0}, "P2_INTERACTIVE_FRONTEND_START_REQUIRED")
        authoring = self.action.get("authoringAction")
        protect = ingress.observe_authoring_protection if authoring else ingress.observe_browser_protection
        paths = {"course_id": authoring["courseId"]} if authoring and authoring["operation"] != _CREATE_DRAFT else {}
        proof = protect(self.broker._native_context(),
            LockedClient(self.broker.vercel, self.broker.check), **self.broker.profile_arguments(), **paths)
        ordinary = self._gateway()
        self._original = self._read()
        demand(_closed(ordinary) and ordinary["sha256"] == _hash(self._original[0]) and
               ordinary["releaseId"] == self.broker.selected["releaseId"] and
               ordinary["candidateSha256"] == self.broker.initial["candidateSha256"],
               "P2_INTERACTIVE_ORDINARY_GATEWAY_REQUIRED")
        self._state = "prepared"
        return proof

    def open_gateway(self):
        self._check()
        demand(self._state == "prepared", "P2_INTERACTIVE_GATEWAY_OPEN_ORDER_REQUIRED")
        self.verify_ordinary_gateway()
        demand(self.broker.observer.probe("observe")["admission"] ==
               {"epoch": self.plan["initialEpoch"], "newWork": False, "recovery": False, "active": 0, "uncertain": 0},
               "P2_INTERACTIVE_GATEWAY_FRONTEND_START_REQUIRED")
        now = int(time.time())
        enrollment = self.action.get("identityEnrollment")
        nonce = enrollment["nonce"] if enrollment is not None else secrets.token_hex(16)
        epoch = str(int(self.plan["initialEpoch"]) + 1)
        remaining = math.floor(self.broker.certification_started + self.plan["maximumSeconds"] - time.monotonic()) - 10
        duration = min(self.action["windowSeconds"], remaining)
        cookie, key, host, expiry = _material(self.broker.initial["scopedCronSecret"], self.plan["nativePlan"]["deploymentUrl"],
            self.plan["sourceCommit"], self.plan["targetSha256"], epoch, self.action["stage"], now, duration, nonce,
            _selection_sha(self.action))
        if self.action["stage"] in _GATEWAY_STAGES:
            _, mount = self._mount()
            interactive = {"actorId": self.action["actorId"], "stage": self.action["stage"], "epoch": epoch,
                "frontendSourceCommit": self.plan["sourceCommit"], "deploymentHost": host, "issuedAt": _instant(now),
                "expiresAt": _instant(expiry), "nonce": nonce, "gatewayProcessSha256": self.plan["gatewayProcessSha256"],
                "mountDevice": str(mount.st_dev), "mountInode": str(mount.st_ino), "key": key, "requests": self.action["requests"]}
            state = {"version": 3, "environment": "staging", "releaseId": self.broker.selected["releaseId"],
                "candidateSha256": self.broker.initial["candidateSha256"], "actionId": self.broker.action_id(),
                "newWork": False, "recovery": False, "interactive": interactive}
            raw = _canonical(state)
            demand(len(raw) <= _MAX_STATE, "P2_INTERACTIVE_STATE_TOO_LARGE")
            self._scoped_sha = _hash(raw)
            try:
                self._replace(raw, 0o640, _GATEWAY_GID)
                demand(self._read() == (raw, 0o640, _GATEWAY_GID), "P2_INTERACTIVE_STATE_READBACK_REQUIRED")
                self._scoped_gateway()
            except BaseException:
                if _hash(self._read()[0]) == self._scoped_sha:
                    self._replace(*self._original)
                self._state = "fenced"
                raise
        self._private_cookie, self._expires = cookie, expiry
        self._state = "opened"
        return {"stage": self.action["stage"], "epoch": epoch, "expiresAt": _instant(expiry),
                "gatewayScoped": self._scoped_sha is not None}

    def _scoped_gateway(self):
        gateway = self._gateway()
        raw, mode, group = self._read()
        demand(type(gateway.get("version")) is int and gateway["version"] == 3 and
               gateway.get("valid") is False and gateway.get("interactiveActive") is True and
               gateway.get("sha256") == self._scoped_sha and gateway.get("actionId") == self.broker.action_id() and
               gateway.get("newWork") is None and gateway.get("recovery") is None and
               gateway.get("releaseId") == self.broker.selected["releaseId"] and
               gateway.get("candidateSha256") == self.broker.initial["candidateSha256"] and
               (_hash(raw), mode, group) == (self._scoped_sha, 0o640, _GATEWAY_GID),
               "P2_INTERACTIVE_GATEWAY_MARKER_REQUIRED")
        return gateway

    def verify_gateway_boundary(self):
        if self._state == "opened" and self._scoped_sha is not None:
            return self._scoped_gateway()
        return self.verify_ordinary_gateway()

    def take_private_browser_permit(self):
        self._check()
        demand(self._state == "opened" and self._private_cookie is not None and time.time() < self._expires,
               "P2_INTERACTIVE_PERMIT_NOT_AVAILABLE")
        epoch = str(int(self.plan["initialEpoch"]) + 1)
        frontend = self.broker.observer.probe("observe")["admission"]
        demand(frontend == {"epoch": epoch, "newWork": True, "recovery": True, "active": 0, "uncertain": 0},
               "P2_INTERACTIVE_FRONTEND_WINDOW_REQUIRED")
        if self._scoped_sha is not None:
            self._scoped_gateway()
        elif self.action["stage"] in CLOSED_BROWSER_STAGES:
            self.verify_ordinary_gateway()
        metadata = native.observe_metadata(self.broker._native_context(),
            LockedClient(self.broker.vercel, self.broker.check), **self.broker.profile_arguments())
        demand(metadata["nativeEnabled"] is False, "P2_INTERACTIVE_NATIVE_SCHEDULER_REQUIRED_OFF")
        cookie, self._private_cookie = self._private_cookie, None
        self._permit_issued = True
        return {"stage": self.action["stage"], "epoch": epoch, "expires": self._expires, "cookie": cookie}

    def collect_gateway_effects(self):
        self._check()
        demand(self._state == "opened" and self._private_cookie is None and time.time() < self._expires,
               "P2_INTERACTIVE_EFFECT_ORDER_REQUIRED")
        if self._scoped_sha is None:
            demand(self._read() == self._original and _closed(self._gateway()), "P2_INTERACTIVE_ORDINARY_GATEWAY_CHANGED")
            return []
        gateway = self._scoped_gateway()
        evidence = gateway["interactiveEvidence"]
        requests = self.action["requests"]
        total = sum(row["uses"] for row in requests)
        demand(gateway["active"] == gateway["uncertain"] == _ZERO and
               type(evidence) is dict and set(evidence) == {"admitted", "acknowledged"} and
               type(evidence["admitted"]) is int and evidence["admitted"] == total and
               type(evidence["acknowledged"]) is list and len(evidence["acknowledged"]) == total,
               "P2_INTERACTIVE_COMPLETE_GATEWAY_EFFECTS_REQUIRED")
        counts, seen, proof_seen = [0] * len(requests), set(), set()
        for row in evidence["acknowledged"]:
            demand(type(row) is dict and set(row) == {"requestId", "proofRequestId", "requestIndex", "upstreamStatus"} and
                   _matches(_UUID, row["requestId"]) and row["requestId"] not in seen and
                   _matches(_UUID, row["proofRequestId"]) and row["proofRequestId"] not in proof_seen and
                   type(row["requestIndex"]) is int and 0 <= row["requestIndex"] < len(requests) and
                   type(row["upstreamStatus"]) is int and
                   (200 <= row["upstreamStatus"] <= 299 or 400 <= row["upstreamStatus"] <= 499),
                   "P2_INTERACTIVE_ACKNOWLEDGEMENT_REQUIRED")
            seen.add(row["requestId"])
            proof_seen.add(row["proofRequestId"])
            counts[row["requestIndex"]] += 1
        demand(counts == [row["uses"] for row in requests], "P2_INTERACTIVE_ACKNOWLEDGEMENT_COUNTS_REQUIRED")
        return copy.deepcopy(evidence["acknowledged"])

    def observe_authoring_gateway(self):
        demand(self.action["stage"] == "authoring" and self._permit_issued, "P2_INTERACTIVE_AUTHORING_PERMIT_REQUIRED")
        rows = self.collect_gateway_effects()
        if self.action["authoringAction"]["operation"] == _CREATE_DRAFT:
            rows.sort(key=lambda row: row["requestIndex"])
        artifact = {**browser_receipt(self.plan, "GATEWAY_OBSERVED"), "epoch": str(int(self.plan["initialEpoch"]) + 1),
                    "gatewayStateSha256": self._scoped_sha, "gatewayActive": 0, "gatewayUncertain": 0,
                    "gatewayAcknowledgements": rows}
        receipt = authoring_gateway_receipt(self.plan, artifact)
        migrate.write_json(self.broker.directory, browser_artifact(self.plan, "gateway"), artifact)
        return receipt

    def fence_gateway(self):
        demand(self._state == "opened", "P2_INTERACTIVE_FENCE_ORDER_REQUIRED")
        self._private_cookie = None
        if self._scoped_sha is not None:
            demand(_hash(self._read()[0]) == self._scoped_sha, "P2_INTERACTIVE_UNRELATED_STATE_PRESERVED")
            self._replace(*self._original)
        self._state = "fenced"
        demand(self._read() == self._original, "P2_INTERACTIVE_CLOSED_STATE_READBACK_REQUIRED")

    def verify_gateway_fenced(self):
        self._check()
        demand(self._state == "fenced" and self._read() == self._original, "P2_INTERACTIVE_FENCE_REQUIRED")
        gateway = self._gateway()
        demand(_closed(gateway) and gateway["sha256"] == _hash(self._original[0]),
               "P2_INTERACTIVE_GATEWAY_DRAIN_REQUIRED")
        return {"gatewayAdmissionClosed": True, "gatewayActive": 0, "gatewayUncertain": 0}

    def verify_fenced(self, *, retain=False):
        gateway = self.verify_gateway_fenced()
        physical = self.broker.observer.probe("witness")
        frontend = physical["admission"]
        operations = physical["witness"]["operations"]
        demand(frontend == {"epoch": str(int(self.plan["initialEpoch"]) + 2),
                            "newWork": False, "recovery": False, "active": 0, "uncertain": 0} and
               type(operations) is list and all(type(row) is dict and row.get("state") == "completed" and
                                              "reconciliation_sha256" in row and row["reconciliation_sha256"] is None
                                              for row in operations),
               "P2_INTERACTIVE_FRONTEND_DRAIN_REQUIRED")
        if retain:
            demand(self._permit_issued, browser_status(self.plan, "PERMIT_REQUIRED"))
            require_browser_ledger(self.plan, physical["witness"])
            migrate.write_json(self.broker.directory, browser_artifact(self.plan, "ledger"), physical["witness"])
        return {**gateway, "frontendAdmission": copy.deepcopy(frontend), "frontendOperationCount": len(operations)}
