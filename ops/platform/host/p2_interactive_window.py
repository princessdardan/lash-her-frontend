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
_ISSUE_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_EMPTY = hashlib.sha256(b"").hexdigest()
_MAX_STATE = 16_384
_GATEWAY_GID = 65532
_ZERO = {"newWork": 0, "recovery": 0}
CLOSED_BROWSER_STAGES = frozenset(("identity", "lifecycle"))
SCOPED_GATEWAY_BROWSER_STAGES = frozenset(("authoring", "learning", "paid-grant"))
EXECUTABLE_BROWSER_STAGES = CLOSED_BROWSER_STAGES | SCOPED_GATEWAY_BROWSER_STAGES
_CREATE_DRAFT = "create-draft"
_EDIT_DRAFT = "edit-and-stale-draft"
_CREATE_CURRICULUM = "create-curriculum"
_REORDER_CURRICULUM = "reorder-and-stale-curriculum"
_QUALIFY_PUBLICATION = "qualify-publication"
_SAVE_QUIZ_REVISION = "save-quiz-revision"
_ARCHIVE_PAID_COURSE = "archive-paid-course"
_REPUBLISH_PAID_COURSE = "republish-paid-course"
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
    stage = _browser_stage(plan).upper().replace("-", "_")
    return f"P2_INTERACTIVE_{stage}_{disposition}"


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
    if stage == "learning":
        return _learning_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == "paid-grant":
        return _paid_grant_case_evidence(plan, action, evidence, gateway_artifact)
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
    if operation == _ARCHIVE_PAID_COURSE:
        return (("GET", course, 2, 200), ("PATCH", course, 1, 200))
    if operation == _REPUBLISH_PAID_COURSE:
        published = action["outcome"] == "published"
        rows = (("GET", course, 3 if published else 2, 200), ("PATCH", course, 1, 200),
                ("GET", f"{course}/publication-readiness", 1, 200))
        return rows + (("PATCH", course, 1, 200),) if published else rows
    if operation == _SAVE_QUIZ_REVISION:
        quiz = f'/course/v1/admin/lessons/{action["lessonId"]}/quiz'
        prior = 404 if action["quizRevision"] == 0 else 200
        return (("GET", course, 2, 200), ("GET", quiz, 1, prior), ("PUT", quiz, 1, 200))
    if operation == _QUALIFY_PUBLICATION:
        readiness = ("GET", f"{course}/publication-readiness", 1, 200)
        if action["outcome"] == "published":
            return (("GET", course, 2, 200), readiness, ("PATCH", course, 1, 200))
        return (("GET", course, 1, 200), readiness)
    if operation == _CREATE_CURRICULUM:
        return (("GET", course, 2, 200), ("POST", f"/course/v1{_curriculum_path(action)}", 1, 201))
    method, target = ("POST", f"/course/v1{_curriculum_path(action)}") if operation == _REORDER_CURRICULUM else ("PATCH", course)
    return (("GET", course, 3, 200), (method, target, 1, 200), (method, target, 1, 409))


def _gateway_sequences(plan):
    stage = plan["scopedAction"]["stage"]
    if stage == "learning":
        prefix = ((0, 200), (1, 403), (2, 201))
        return (prefix + ((1, 200), (3, 200)), prefix + ((3, 200), (1, 200)))
    if stage == "paid-grant":
        return (((0, 200), (1, 200), (0, 200), (2, 201), (1, 200), (3, 200), (0, 200)),)
    selected = plan["scopedAction"]["authoringAction"]
    requests = _authoring_requests(selected)
    order = {
        _CREATE_DRAFT: [0, 1],
        _CREATE_CURRICULUM: [0, 1, 0],
        _EDIT_DRAFT: [0, 0, 1, 0, 2],
        _REORDER_CURRICULUM: [0, 0, 1, 0, 2],
        _QUALIFY_PUBLICATION: [0, 1, 2, 0] if selected.get("outcome") == "published" else [0, 1],
        _SAVE_QUIZ_REVISION: [0, 1, 2, 0],
        _ARCHIVE_PAID_COURSE: [0, 1, 0],
        _REPUBLISH_PAID_COURSE: [0, 1, 0, 2, 3, 0] if selected.get("outcome") == "published" else [0, 1, 0, 2],
    }[selected["operation"]]
    return (tuple((index, requests[index][3]) for index in order),)


def browser_gateway_receipt(plan, artifact):
    common = browser_receipt(plan, "GATEWAY_OBSERVED")
    fields = set(common) | {"epoch", "gatewayStateSha256", "gatewayAcknowledgements", "gatewayActive", "gatewayUncertain"}
    demand(common["stage"] in SCOPED_GATEWAY_BROWSER_STAGES and type(artifact) is dict and set(artifact) == fields and
           _receipt_sha({key: artifact[key] for key in common}) == _receipt_sha(common) and
           artifact["epoch"] == str(int(plan["initialEpoch"]) + 1) and _digest(artifact["gatewayStateSha256"]) and
           all(type(artifact[key]) is int and artifact[key] == 0 for key in ("gatewayActive", "gatewayUncertain")),
           browser_status(plan, "GATEWAY_ARTIFACT_REQUIRED"))
    sequences = _gateway_sequences(plan)
    rows = artifact["gatewayAcknowledgements"]
    demand(type(rows) is list and len(rows) == len(sequences[0]) and all(
               _closed_fields(row, "requestId proofRequestId requestIndex upstreamStatus") and
               _matches(_UUID, row["requestId"]) and _matches(_UUID, row["proofRequestId"]) and
               type(row["requestIndex"]) is int and type(row["upstreamStatus"]) is int for row in rows) and
           len({row["requestId"] for row in rows}) == len({row["proofRequestId"] for row in rows}) == len(rows) and
           tuple((row["requestIndex"], row["upstreamStatus"]) for row in rows) in sequences,
           browser_status(plan, "ACKNOWLEDGEMENTS_REQUIRED"))
    return {**artifact, "gatewayEvidenceSha256": _receipt_sha(artifact)}


def _learning_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["learningAction"]
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LEARNING_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    post_id = gateway["gatewayAcknowledgements"][2]["requestId"]
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    academy = f'/academy/courses/{selected["courseId"]}'
    demand(_closed_fields(browser, "method pathname status requestId academyPath body") and
           browser["method"] == "POST" and browser["pathname"] == f"/api{academy}/enrollments" and
           type(browser["status"]) is int and browser["status"] == 200 and browser["requestId"] == post_id and
           browser["academyPath"] == academy, "P2_INTERACTIVE_LEARNING_ENROLLMENT_RESPONSE_REQUIRED")
    body = browser["body"]
    fields = "courseId grantId enrollmentId source status idempotentReplay"
    demand(_closed_fields(body, fields) and body["courseId"] == selected["courseId"] and
           all(_matches(_UUID, body[key]) for key in ("grantId", "enrollmentId")) and
           body["source"] == "free" and body["status"] == "active" and body["idempotentReplay"] is False,
           "P2_INTERACTIVE_LEARNING_ENROLLMENT_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} transitionId readOnly") and witness["readOnly"] is True and
           witness["idempotentReplay"] is False and _matches(_UUID, witness["transitionId"]) and
           all(witness[key] == value for key, value in body.items()), "P2_INTERACTIVE_LEARNING_COURSE_WITNESS_REQUIRED")
    return {**{key: body[key] for key in ("courseId", "grantId", "enrollmentId")}, "slug": selected["slug"],
            "actorId": action["actorId"], "transitionId": witness["transitionId"], "gatewayPostRequestId": post_id,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _paid_grant_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["paidGrantAction"]
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_PAID_GRANT_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    post_id = gateway["gatewayAcknowledgements"][3]["requestId"]
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    pathname = f'/api/admin/courses/{selected["courseId"]}/manual-grants'
    demand(_closed_fields(browser, "method pathname status requestId body") and browser["method"] == "POST" and
           browser["pathname"] == pathname and type(browser["status"]) is int and browser["status"] == 200 and
           browser["requestId"] == post_id, "P2_INTERACTIVE_PAID_GRANT_RESPONSE_REQUIRED")
    body = browser["body"]
    fields = "courseId userId commandId grantId courseRevision"
    demand(_closed_fields(body, fields) and all(body[key] == selected[key] for key in ("courseId", "userId")) and
           all(_matches(_UUID, body[key]) for key in ("commandId", "grantId")) and
           type(body["courseRevision"]) is int and body["courseRevision"] == selected["revision"],
           "P2_INTERACTIVE_PAID_GRANT_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} enrollmentId transitionId readOnly") and witness["readOnly"] is True and
           all(_matches(_UUID, witness[key]) for key in ("enrollmentId", "transitionId")) and
           type(witness["courseRevision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_PAID_GRANT_COURSE_WITNESS_REQUIRED")
    return {**body, "actorId": action["actorId"], "enrollmentId": witness["enrollmentId"],
            "transitionId": witness["transitionId"], "gatewayPostRequestId": post_id,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _authoring_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["authoringAction"]
    reordering = selected["operation"] == _REORDER_CURRICULUM
    editing = selected["operation"] == _EDIT_DRAFT
    browser_key = "browserResponses" if editing or reordering else "browserResponse"
    demand(_closed_fields(evidence, f"{browser_key} courseWitness"), "P2_INTERACTIVE_AUTHORING_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    mutations = [row["requestId"] for row in gateway["gatewayAcknowledgements"] if row["requestIndex"] > 0]
    response, witness = evidence[browser_key], evidence["courseWitness"]
    if selected["operation"] == _QUALIFY_PUBLICATION:
        return _publication_case_evidence(action, response, witness, gateway, mutations)
    if selected["operation"] == _SAVE_QUIZ_REVISION:
        return _quiz_case_evidence(action, response, witness, gateway, mutations)
    if selected["operation"] == _ARCHIVE_PAID_COURSE:
        return _archive_case_evidence(action, response, witness, gateway, mutations[0])
    if selected["operation"] == _REPUBLISH_PAID_COURSE:
        return _republish_case_evidence(action, response, witness, gateway, mutations)
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


def _correlated_browser_response(item, method, pathname, status, request_id):
    return (_closed_fields(item, "method pathname status requestId") and item["method"] == method and
            item["pathname"] == pathname and type(item["status"]) is int and item["status"] == status and
            item["requestId"] == request_id)


def _archive_case_evidence(action, response, witness, gateway, patch_id):
    selected = action["authoringAction"]
    pathname = f'/api/admin/courses/{selected["courseId"]}'
    demand(_closed_fields(response, "method pathname status requestId body warningObserved cancelObservedWithoutMutation") and
           response["method"] == "PATCH" and response["pathname"] == pathname and type(response["status"]) is int and
           response["status"] == 200 and response["requestId"] == patch_id and
           response["warningObserved"] is True and response["cancelObservedWithoutMutation"] is True,
           "P2_INTERACTIVE_AUTHORING_ARCHIVE_RESPONSE_REQUIRED")
    body = response["body"]
    fields = "courseId slug revision status"
    demand(_closed_fields(body, fields) and body["courseId"] == selected["courseId"] and body["slug"] == selected["slug"] and
           type(body["revision"]) is int and body["revision"] == selected["revision"] + 1 and body["status"] == "archived",
           "P2_INTERACTIVE_AUTHORING_ARCHIVE_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} userId grantId historyPreserved readOnly") and witness["readOnly"] is True and
           witness["historyPreserved"] is True and type(witness["revision"]) is int and
           all(witness[key] == value for key, value in body.items()) and
           all(witness[key] == selected[key] for key in ("userId", "grantId")), "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    return {**{key: selected[key] for key in ("operation", "courseId", "slug", "userId", "grantId")}, "actorId": action["actorId"],
            "revision": body["revision"], "gatewayPatchRequestId": patch_id, "browserResponseSha256": _receipt_sha(response),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _republish_case_evidence(action, response, witness, gateway, request_ids):
    selected = action["authoringAction"]
    published = selected["outcome"] == "published"
    fields = "draft readiness body publication" if published else "draft readiness body"
    demand(_closed_fields(response, fields), "P2_INTERACTIVE_AUTHORING_REPUBLISH_EVIDENCE_REQUIRED")
    detail = f'/api/admin/courses/{selected["courseId"]}'
    observed = (("draft", "PATCH", detail), ("readiness", "GET", f"{detail}/publication-readiness"))
    if published:
        observed += (("publication", "PATCH", detail),)
    for (key, method, pathname), request_id in zip(observed, request_ids):
        demand(_correlated_browser_response(response[key], method, pathname, 200, request_id),
               "P2_INTERACTIVE_AUTHORING_REPUBLISH_RESPONSE_REQUIRED")
    body = response["body"]
    fields = "courseId slug revision status issueCodes"
    demand(_closed_fields(body, fields) and body["courseId"] == selected["courseId"] and body["slug"] == selected["slug"] and
           type(body["revision"]) is int and body["revision"] == selected["revision"] + (2 if published else 1) and
           body["status"] == ("published" if published else "draft") and body["issueCodes"] == selected["issueCodes"],
           "P2_INTERACTIVE_AUTHORING_REPUBLISH_BODY_REQUIRED")
    effective_access = published and selected["expectedAccess"]
    demand(_closed_fields(witness, f"{fields} userId grantId historyPreserved effectiveAccess readOnly") and
           witness["readOnly"] is True and witness["historyPreserved"] is True and witness["effectiveAccess"] is effective_access and
           type(witness["revision"]) is int and all(witness[key] == value for key, value in body.items()) and
           all(witness[key] == selected[key] for key in ("userId", "grantId")), "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    patch = {"gatewayPatchRequestId": request_ids[2]} if published else {}
    return {**{key: selected[key] for key in ("operation", "courseId", "slug", "userId", "grantId", "outcome", "issueCodes")},
            "actorId": action["actorId"], "revision": body["revision"], "effectiveAccess": effective_access,
            "draftGatewayRequestId": request_ids[0], "readinessGatewayRequestId": request_ids[1], **patch,
            "browserResponseSha256": _receipt_sha(response), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _quiz_case_evidence(action, response, witness, gateway, request_ids):
    selected = action["authoringAction"]
    demand(_closed_fields(response, "prior save body"), "P2_INTERACTIVE_AUTHORING_QUIZ_EVIDENCE_REQUIRED")
    pathname = f'/api/admin/lessons/{selected["lessonId"]}/quiz'
    prior = 404 if selected["quizRevision"] == 0 else 200
    demand(_correlated_browser_response(response["prior"], "GET", pathname, prior, request_ids[0]) and
           _correlated_browser_response(response["save"], "PUT", pathname, 200, request_ids[1]),
           "P2_INTERACTIVE_AUTHORING_QUIZ_RESPONSE_REQUIRED")
    body = response["body"]
    fields = "courseId slug lessonId quizId revision quizRevision documentSha256"
    demand(_closed_fields(body, fields) and
           all(body[key] == selected[key] for key in ("courseId", "slug", "lessonId", "documentSha256")) and
           _matches(_UUID, body["quizId"]) and all(type(body[key]) is int and body[key] == selected[key] + 1
                                                 for key in ("revision", "quizRevision")),
           "P2_INTERACTIVE_AUTHORING_QUIZ_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} readOnly") and witness["readOnly"] is True and
           all(type(witness[key]) is int for key in ("revision", "quizRevision")) and
           all(witness[key] == value for key, value in body.items()), "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    return {**body, "operation": selected["operation"], "actorId": action["actorId"],
            "priorGatewayRequestId": request_ids[0], "gatewayPutRequestId": request_ids[1],
            "browserResponseSha256": _receipt_sha(response), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _publication_case_evidence(action, response, witness, gateway, request_ids):
    selected = action["authoringAction"]
    published = selected["outcome"] == "published"
    fields = "readiness body publication" if published else "readiness body"
    demand(_closed_fields(response, fields), "P2_INTERACTIVE_AUTHORING_PUBLICATION_EVIDENCE_REQUIRED")
    detail = f'/api/admin/courses/{selected["courseId"]}'
    observed = (("readiness", "GET", f"{detail}/publication-readiness"),)
    if published:
        observed += (("publication", "PATCH", detail),)
    for (key, method, pathname), request_id in zip(observed, request_ids):
        demand(_correlated_browser_response(response[key], method, pathname, 200, request_id),
               "P2_INTERACTIVE_AUTHORING_PUBLICATION_RESPONSE_REQUIRED")
    body = response["body"]
    fields = "courseId slug revision status issueCodes"
    demand(_closed_fields(body, fields) and body["courseId"] == selected["courseId"] and body["slug"] == selected["slug"] and
           type(body["revision"]) is int and body["revision"] == selected["revision"] + int(published) and
           body["status"] == ("published" if published else "draft") and body["issueCodes"] == selected["issueCodes"],
           "P2_INTERACTIVE_AUTHORING_PUBLICATION_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} readOnly") and witness["readOnly"] is True and
           type(witness["revision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_AUTHORING_COURSE_WITNESS_REQUIRED")
    patch = {"gatewayPatchRequestId": request_ids[1]} if published else {}
    return {**{key: selected[key] for key in ("operation", "courseId", "slug", "outcome", "issueCodes")},
            "actorId": action["actorId"], "revision": body["revision"], "readinessGatewayRequestId": request_ids[0], **patch,
            "browserResponseSha256": _receipt_sha(response), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


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
    learning = type(action) is dict and action.get("stage") == "learning"
    paid_grant = type(action) is dict and action.get("stage") == "paid-grant"
    fields = {"stage", "actorId", "requests", "windowSeconds"}
    if lifecycle:
        fields.add("frontendAction")
    if authoring:
        fields.add("authoringAction")
    if learning:
        fields.add("learningAction")
    if paid_grant:
        fields.add("paidGrantAction")
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
        if operation in (_EDIT_DRAFT, _QUALIFY_PUBLICATION, _SAVE_QUIZ_REVISION, _ARCHIVE_PAID_COURSE,
                         _REPUBLISH_PAID_COURSE, *_CURRICULUM_OPERATIONS):
            fields += " courseId revision"
        if operation in _CURRICULUM_OPERATIONS:
            fields += " kind parentId"
        if operation == _CREATE_CURRICULUM:
            fields += " childSlug"
        if operation in (_QUALIFY_PUBLICATION, _REPUBLISH_PAID_COURSE):
            fields += " outcome issueCodes"
        if operation == _SAVE_QUIZ_REVISION:
            fields += " lessonId quizRevision documentSha256"
        if operation in (_ARCHIVE_PAID_COURSE, _REPUBLISH_PAID_COURSE):
            fields += " userId grantId"
        if operation == _REPUBLISH_PAID_COURSE:
            fields += " expectedAccess"
        demand(_closed_fields(selected_authoring, fields) and
               operation in (_CREATE_DRAFT, _EDIT_DRAFT, _QUALIFY_PUBLICATION, _SAVE_QUIZ_REVISION,
                             _ARCHIVE_PAID_COURSE, _REPUBLISH_PAID_COURSE, *_CURRICULUM_OPERATIONS) and
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
        if operation in (_QUALIFY_PUBLICATION, _REPUBLISH_PAID_COURSE):
            outcome, codes = selected_authoring["outcome"], selected_authoring["issueCodes"]
            demand(type(codes) is list and
                   (codes == [] if outcome == "published" else outcome == "blocked" and 1 <= len(codes) <= 16 and
                    all(_matches(_ISSUE_CODE, code) for code in codes) and codes == sorted(set(codes))),
                   "P2_INTERACTIVE_AUTHORING_PUBLICATION_SELECTION_REQUIRED")
        if operation == _SAVE_QUIZ_REVISION:
            demand(_matches(_UUID, selected_authoring["lessonId"]) and type(selected_authoring["quizRevision"]) is int and
                   0 <= selected_authoring["quizRevision"] <= 2_147_483_646 and _digest(selected_authoring["documentSha256"]) and
                   selected_authoring["documentSha256"] != _EMPTY,
                   "P2_INTERACTIVE_AUTHORING_QUIZ_SELECTION_REQUIRED")
        if operation in (_ARCHIVE_PAID_COURSE, _REPUBLISH_PAID_COURSE):
            demand(all(_matches(_UUID, selected_authoring[key]) for key in ("userId", "grantId")),
                   "P2_INTERACTIVE_AUTHORING_ARCHIVE_SELECTION_REQUIRED")
        if operation == _REPUBLISH_PAID_COURSE:
            demand(selected_authoring["revision"] <= 2_147_483_645 and type(selected_authoring["expectedAccess"]) is bool,
                   "P2_INTERACTIVE_AUTHORING_REPUBLISH_SELECTION_REQUIRED")
        expected = _authoring_requests(selected_authoring)
        mutations = [row["bodySha256"] for row in requests if row["method"] != "GET"]
        demand(len(requests) == len(expected) and all(
                   (row["method"], row["target"], row["uses"]) == (method, target, uses)
                   for row, (method, target, uses, _) in zip(requests, expected)) and
               all(_digest(digest) and digest != _EMPTY for digest in mutations) and len(set(mutations)) == len(mutations),
               "P2_INTERACTIVE_AUTHORING_DRAFT_REQUIRED")
        if operation == _QUALIFY_PUBLICATION and selected_authoring["outcome"] == "published":
            reviewed_body = {"expectedRevision": selected_authoring["revision"], "status": "published"}
            demand(requests[2]["bodySha256"] == _receipt_sha(reviewed_body), "P2_INTERACTIVE_AUTHORING_PUBLICATION_DIGEST_REQUIRED")
        if operation == _ARCHIVE_PAID_COURSE:
            reviewed_body = {"expectedRevision": selected_authoring["revision"], "status": "archived"}
            demand(requests[1]["bodySha256"] == _receipt_sha(reviewed_body), "P2_INTERACTIVE_AUTHORING_ARCHIVE_DIGEST_REQUIRED")
        if operation == _REPUBLISH_PAID_COURSE:
            revision = selected_authoring["revision"]
            demand(requests[1]["bodySha256"] == _receipt_sha({"expectedRevision": revision, "status": "draft"}) and
                   (selected_authoring["outcome"] != "published" or
                    requests[3]["bodySha256"] == _receipt_sha({"expectedRevision": revision + 1, "status": "published"})),
                   "P2_INTERACTIVE_AUTHORING_REPUBLISH_DIGEST_REQUIRED")
    if learning:
        selection = action["learningAction"]
        demand(_closed_fields(selection, "operation courseId slug idempotencyKey") and
               selection["operation"] == "enroll-free-course" and _matches(_UUID, selection["courseId"]) and
               _matches(_SLUG, selection["slug"]) and len(selection["slug"]) <= 120 and
               _matches(_UUID, selection["idempotencyKey"]), "P2_INTERACTIVE_LEARNING_ENROLLMENT_SELECTION_REQUIRED")
        course = f'/course/v1/student/courses/{selection["courseId"]}'
        digest = _receipt_sha({"idempotencyKey": selection["idempotencyKey"]})
        expected = [
            {"method": "GET", "target": f'/course/v1/courses/{selection["slug"]}', "bodySha256": _EMPTY, "uses": 1},
            {"method": "GET", "target": course, "bodySha256": _EMPTY, "uses": 2},
            {"method": "POST", "target": f"{course}/enrollments", "bodySha256": digest, "uses": 1},
            {"method": "GET", "target": f'/course/v1/student/progress?courseId={selection["courseId"]}',
             "bodySha256": _EMPTY, "uses": 1},
        ]
        demand(requests == expected, "P2_INTERACTIVE_LEARNING_ENROLLMENT_REQUESTS_REQUIRED")
    if paid_grant:
        selection = action["paidGrantAction"]
        demand(_closed_fields(selection, "operation courseId userId revision idempotencyKey reasonSha256") and
               selection["operation"] == "grant-paid-access" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "userId", "idempotencyKey")) and
               type(selection["revision"]) is int and 1 <= selection["revision"] <= 2_147_483_647 and
               _digest(selection["reasonSha256"]) and selection["reasonSha256"] != _EMPTY,
               "P2_INTERACTIVE_PAID_GRANT_SELECTION_REQUIRED")
        entitlements = "/course/v1/admin/entitlements"
        query = f'idempotencyKey=owner-paid%3A{selection["idempotencyKey"]}&limit=2'
        grants_query = f'userId={selection["userId"]}&courseId={selection["courseId"]}&{query}'
        expected = (
            ("GET", f'/course/v1/admin/courses/{selection["courseId"]}', 3),
            ("GET", f"{entitlements}/commands?{query}", 2),
            ("POST", f"{entitlements}/grants", 1),
            ("GET", f"{entitlements}/grants?{grants_query}", 1),
        )
        demand(tuple((row["method"], row["target"], row["uses"]) for row in requests) == expected and
               _digest(requests[2]["bodySha256"]) and requests[2]["bodySha256"] != _EMPTY,
               "P2_INTERACTIVE_PAID_GRANT_REQUESTS_REQUIRED")
    return copy.deepcopy(action)


def _selection_sha(action):
    key_field = {"learning": "learningAction", "paid-grant": "paidGrantAction"}.get(action["stage"])
    if key_field:
        return (action["actorId"] + action[key_field]["idempotencyKey"]).replace("-", "")
    if action["stage"] == "authoring":
        authoring = action["authoringAction"]
        prefix = {
            _CREATE_DRAFT: "7032712d617574686f72696e672d7631",
            _EDIT_DRAFT: "7032712d617574682d656469742d7631",
            _CREATE_CURRICULUM: "7032712d617574682d6e65772d763100",
            _REORDER_CURRICULUM: "7032712d617574682d736f72742d7631",
            _QUALIFY_PUBLICATION: ("7032712d617574682d7075622d763100" if authoring.get("outcome") == "published" else
                                   "7032712d617574682d7264792d763100"),
            _SAVE_QUIZ_REVISION: "7032712d617574682d7175697a2d7631",
            _ARCHIVE_PAID_COURSE: "7032712d617574682d6172632d763100",
            _REPUBLISH_PAID_COURSE: ("7032712d617574682d7265702d763100" if authoring.get("outcome") == "published" else
                                     "7032712d617574682d72626c2d763100"),
        }[authoring["operation"]]
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
        learning = self.action.get("learningAction")
        paid_grant = self.action.get("paidGrantAction")
        protect = ingress.observe_authoring_protection if authoring else ingress.observe_browser_protection
        paths = {"course_id": authoring["courseId"]} if authoring and authoring["operation"] != _CREATE_DRAFT else {}
        if learning:
            protect = ingress.observe_learning_protection
            paths = {"course_id": learning["courseId"], "slug": learning["slug"]}
        if paid_grant:
            protect = ingress.observe_paid_grant_protection
            paths = {"course_id": paid_grant["courseId"]}
        if authoring and authoring["operation"] in (_QUALIFY_PUBLICATION, _REPUBLISH_PAID_COURSE):
            paths["publication_readiness"] = True
        if authoring and authoring["operation"] == _SAVE_QUIZ_REVISION:
            paths["quiz_lesson_id"] = authoring["lessonId"]
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

    def observe_browser_gateway(self):
        demand(self.action["stage"] in SCOPED_GATEWAY_BROWSER_STAGES and self._permit_issued,
               browser_status(self.plan, "PERMIT_REQUIRED"))
        rows = self.collect_gateway_effects()
        if self.action.get("authoringAction", {}).get("operation") == _CREATE_DRAFT:
            rows.sort(key=lambda row: row["requestIndex"])
        artifact = {**browser_receipt(self.plan, "GATEWAY_OBSERVED"), "epoch": str(int(self.plan["initialEpoch"]) + 1),
                    "gatewayStateSha256": self._scoped_sha, "gatewayActive": 0, "gatewayUncertain": 0,
                    "gatewayAcknowledgements": rows}
        receipt = browser_gateway_receipt(self.plan, artifact)
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
