"""Private authority and gateway fence for one reviewed browser epoch."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
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
_LEARNER_ACCESS = "learner-access"
_LESSON_ENTRY = "lesson-entry"
_LESSON_DENIAL = "lesson-denial"
_ASSESSMENT = "lesson-assessment"
_RESUME = "lesson-resume"
_PAID_REVOKE = "paid-revoke"
_STAGES = {"identity", "authoring", "media", "learning", "paid-grant", _PAID_REVOKE, _LEARNER_ACCESS, _LESSON_ENTRY, _LESSON_DENIAL, _ASSESSMENT, _RESUME, "lifecycle"}
_GATEWAY_STAGES = {"authoring", "media", "learning", "paid-grant", _PAID_REVOKE, _LEARNER_ACCESS, _LESSON_ENTRY, _LESSON_DENIAL, _ASSESSMENT, _RESUME}
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
_SHA = re.compile(r"[a-f0-9]{64}")
_ANSWER_KEY = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}")
_LESSON_SELECTOR = re.compile(r"[a-f0-9]{96}")
_UTC_MILLISECONDS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
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
SCOPED_GATEWAY_BROWSER_STAGES = frozenset(("authoring", "learning", "paid-grant", _PAID_REVOKE, _LEARNER_ACCESS, _LESSON_ENTRY, _LESSON_DENIAL, _ASSESSMENT, _RESUME))
EXECUTABLE_BROWSER_STAGES = CLOSED_BROWSER_STAGES | SCOPED_GATEWAY_BROWSER_STAGES
_CREATE_DRAFT = "create-draft"
_EDIT_DRAFT = "edit-and-stale-draft"
_CREATE_CURRICULUM = "create-curriculum"
_REORDER_CURRICULUM = "reorder-and-stale-curriculum"
_QUALIFY_PUBLICATION = "qualify-publication"
_SAVE_QUIZ_REVISION = "save-quiz-revision"
_ARCHIVE_PAID_COURSE = "archive-paid-course"
_REPUBLISH_PAID_COURSE = "republish-paid-course"
_LEARNER_ACCESS_OUTCOMES = {
    "allowed": (200, (None,)),
    "archived": (410, ("course_archived",)),
    "draft": (404, ("not_found",)),
    "restricted": (403, ("access_required", "access_revoked")),
}
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
    if stage == _PAID_REVOKE:
        return _paid_revoke_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == _LEARNER_ACCESS:
        return _learner_access_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == _LESSON_ENTRY:
        return _lesson_entry_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == _LESSON_DENIAL:
        return _lesson_denial_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == _ASSESSMENT:
        return _assessment_case_evidence(plan, action, evidence, gateway_artifact)
    if stage == _RESUME:
        return _resume_case_evidence(plan, action, evidence, gateway_artifact)
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
        if plan["scopedAction"]["learningAction"]["operation"] == "replay-free-enrollment":
            return (((0, 200), (1, 200), (2, 200)), ((1, 200), (0, 200), (2, 200)))
        prefix = ((0, 200), (1, 403), (2, 201))
        return (prefix + ((1, 200), (3, 200)), prefix + ((3, 200), (1, 200)))
    if stage == "paid-grant":
        return (((0, 200), (1, 200), (0, 200), (2, 201), (1, 200), (3, 200), (0, 200)),)
    if stage == _PAID_REVOKE:
        return (tuple((index, 200) for index in (0, 1, 0, 2, 3, 1, 2, 0)),)
    if stage == _LEARNER_ACCESS:
        status, _ = _LEARNER_ACCESS_OUTCOMES[plan["scopedAction"]["learnerAccessAction"]["outcome"]]
        return tuple(tuple((index, status) for index in order) for order in
                     ((0, 1, 0, 2, 3, 4, 5, 6), (1, 0, 0, 2, 3, 4, 5, 6)))
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


def _valid_gateway_acknowledgements(plan, rows):
    acknowledgements = tuple((row["requestIndex"], row["upstreamStatus"]) for row in rows)
    stage = plan["scopedAction"]["stage"]
    if stage == _LESSON_ENTRY:
        indices = [index for index, _ in acknowledgements]
        return (len(acknowledgements) == 9 and all(status == 200 for _, status in acknowledgements) and
                sorted(indices[:2]) == [0, 1] and sorted(indices[2:7]) == [0, 2, 3, 4, 5] and
                sorted(indices[7:]) == [6, 7])
    if stage == _LESSON_DENIAL:
        indices = [index for index, _ in acknowledgements]
        return (len(acknowledgements) == 15 and all(status == 403 for _, status in acknowledgements) and
                sorted(indices[:5]) == sorted(indices[5:10]) == [0, 1, 2, 3, 4] and
                indices[10:] == [1, 5, 2, 3, 4])
    if stage == _ASSESSMENT:
        indices = [index for index, _ in acknowledgements]
        return (len(acknowledgements) == 11 and
                all(status == (404 if index == 5 else 200) for index, status in acknowledgements) and
                sorted(indices[:5]) == [0, 1, 2, 3, 4] and sorted(indices[5:7]) == [5, 6] and
                indices[7:] == [7, 2, 8, 2])
    if stage == _RESUME:
        indices = [index for index, _ in acknowledgements]
        return (len(acknowledgements) == 10 and all(status == 200 for _, status in acknowledgements) and
                sorted(indices[:5]) == [0, 1, 2, 3, 4] and sorted(indices[5:7]) == [5, 6] and
                indices[7:] == [7, 8, 9])
    return acknowledgements in _gateway_sequences(plan)


def browser_gateway_receipt(plan, artifact):
    common = browser_receipt(plan, "GATEWAY_OBSERVED")
    fields = set(common) | {"epoch", "gatewayStateSha256", "gatewayAcknowledgements", "gatewayActive", "gatewayUncertain"}
    demand(common["stage"] in SCOPED_GATEWAY_BROWSER_STAGES and type(artifact) is dict and set(artifact) == fields and
           _receipt_sha({key: artifact[key] for key in common}) == _receipt_sha(common) and
           artifact["epoch"] == str(int(plan["initialEpoch"]) + 1) and _digest(artifact["gatewayStateSha256"]) and
           all(type(artifact[key]) is int and artifact[key] == 0 for key in ("gatewayActive", "gatewayUncertain")),
           browser_status(plan, "GATEWAY_ARTIFACT_REQUIRED"))
    rows = artifact["gatewayAcknowledgements"]
    maximum_rows = {_LESSON_DENIAL: 15, _ASSESSMENT: 11, _RESUME: 10}.get(common["stage"], 9)
    demand(type(rows) is list and len(rows) <= maximum_rows and all(
               _closed_fields(row, "requestId proofRequestId requestIndex upstreamStatus") and
               _matches(_UUID, row["requestId"]) and _matches(_UUID, row["proofRequestId"]) and
               type(row["requestIndex"]) is int and type(row["upstreamStatus"]) is int for row in rows) and
           len({row["requestId"] for row in rows}) == len({row["proofRequestId"] for row in rows}) == len(rows) and
           _valid_gateway_acknowledgements(plan, rows),
           browser_status(plan, "ACKNOWLEDGEMENTS_REQUIRED"))
    return {**artifact, "gatewayEvidenceSha256": _receipt_sha(artifact)}


def _valid_community_activation(delivery, transition_id):
    return (_closed_fields(delivery, "streamId streamVersion eventId canonicalDigest state") and
            all(_matches(_UUID, delivery[key]) for key in ("streamId", "eventId")) and
            type(delivery["streamVersion"]) is int and delivery["streamVersion"] == 1 and
            _digest(delivery["canonicalDigest"]) and delivery["state"] == "active" and
            (transition_id is None or delivery["eventId"] == transition_id))


def _learning_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["learningAction"]
    replay = selected["operation"] == "replay-free-enrollment"
    prior = selected["prior"] if replay else None
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
           body["source"] == "free" and body["status"] == "active" and body["idempotentReplay"] is replay and
           (not replay or all(body[key] == prior[key] for key in ("grantId", "enrollmentId"))),
           "P2_INTERACTIVE_LEARNING_ENROLLMENT_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} transitionId communityDelivery readOnly") and witness["readOnly"] is True and
           witness["idempotentReplay"] is replay and _matches(_UUID, witness["transitionId"]) and
           all(witness[key] == value for key, value in body.items()), "P2_INTERACTIVE_LEARNING_COURSE_WITNESS_REQUIRED")
    delivery = witness["communityDelivery"]
    demand(_valid_community_activation(delivery, witness["transitionId"]) and
           (not replay or witness["transitionId"] == prior["eventId"] and
            all(delivery[key] == prior[key] for key in ("streamId", "canonicalDigest"))),
           "P2_INTERACTIVE_LEARNING_COMMUNITY_DELIVERY_REQUIRED")
    joined_operation = {"operation": selected["operation"]} if replay else {}
    return {**{key: body[key] for key in ("courseId", "grantId", "enrollmentId")}, "slug": selected["slug"],
            "actorId": action["actorId"], **joined_operation, "transitionId": witness["transitionId"],
            "communityDelivery": delivery, "gatewayPostRequestId": post_id,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _paid_grant_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["paidGrantAction"]
    second = "priorGrantId" in selected
    prior = {"priorGrantId": selected["priorGrantId"]} if second else {}
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
           (not second or body["grantId"] != selected["priorGrantId"]) and
           type(body["courseRevision"]) is int and body["courseRevision"] == selected["revision"],
           "P2_INTERACTIVE_PAID_GRANT_BODY_REQUIRED")
    witness_fields = f"{fields} enrollmentId transitionId communityDelivery readOnly" + (" priorGrantId" if second else "")
    demand(_closed_fields(witness, witness_fields) and witness["readOnly"] is True and
           _matches(_UUID, witness["enrollmentId"]) and
           (witness["transitionId"] is None and witness["priorGrantId"] == selected["priorGrantId"] if second else
            _matches(_UUID, witness["transitionId"])) and
           type(witness["courseRevision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_PAID_GRANT_COURSE_WITNESS_REQUIRED")
    delivery = witness["communityDelivery"]
    demand(_valid_community_activation(delivery, witness["transitionId"]), "P2_INTERACTIVE_PAID_GRANT_COMMUNITY_DELIVERY_REQUIRED")
    return {**body, "actorId": action["actorId"], "enrollmentId": witness["enrollmentId"],
            "transitionId": witness["transitionId"], **prior, "communityDelivery": delivery, "gatewayPostRequestId": post_id,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _paid_revoke_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["paidRevokeAction"]
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_PAID_REVOKE_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    post_id = gateway["gatewayAcknowledgements"][4]["requestId"]
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    pathname = f'/api/admin/courses/{selected["courseId"]}/manual-grants/revoke'
    demand(_closed_fields(browser, "method pathname status requestId body") and browser["method"] == "POST" and
           browser["pathname"] == pathname and type(browser["status"]) is int and browser["status"] == 200 and
           browser["requestId"] == post_id, "P2_INTERACTIVE_PAID_REVOKE_RESPONSE_REQUIRED")
    body = browser["body"]
    fields = "courseId userId grantId commandId courseRevision"
    demand(_closed_fields(body, fields) and all(body[key] == selected[key] for key in ("courseId", "userId", "grantId")) and
           _matches(_UUID, body["commandId"]) and type(body["courseRevision"]) is int and body["courseRevision"] == selected["revision"],
           "P2_INTERACTIVE_PAID_REVOKE_BODY_REQUIRED")
    remaining = selected["remainingAccess"]
    demand(_closed_fields(witness, f"{fields} remainingAccess transitionId communityDelivery readOnly") and witness["readOnly"] is True and
           witness["remainingAccess"] is remaining and
           (witness["transitionId"] is None if remaining else _matches(_UUID, witness["transitionId"])) and
           type(witness["courseRevision"]) is int and all(witness[key] == value for key, value in body.items()),
           "P2_INTERACTIVE_PAID_REVOKE_COURSE_WITNESS_REQUIRED")
    delivery = witness["communityDelivery"]
    demand(_closed_fields(delivery, "streamId streamVersion eventId canonicalDigest state independentActiveCount independentActiveSha256") and
           all(_matches(_UUID, delivery[key]) for key in ("streamId", "eventId")) and
           type(delivery["streamVersion"]) is int and 1 <= delivery["streamVersion"] <= 2_147_483_647 and
           all(_digest(delivery[key]) for key in ("canonicalDigest", "independentActiveSha256")) and
           type(delivery["independentActiveCount"]) is int and 1 <= delivery["independentActiveCount"] <= 4096 and
           delivery["state"] == ("active" if remaining else "revoked") and
           (remaining or delivery["eventId"] == witness["transitionId"]),
           "P2_INTERACTIVE_PAID_REVOKE_COMMUNITY_DELIVERY_REQUIRED")
    return {**body, "actorId": action["actorId"], "operation": selected["operation"], "remainingAccess": remaining,
            "transitionId": witness["transitionId"], "communityDelivery": delivery, "gatewayPostRequestId": post_id,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _learner_access_paths(selection, prefix):
    lesson_id = selection["lessonId"]
    lesson = f"{prefix}/lessons/{lesson_id}"
    return (f'{prefix}/courses/{selection["courseId"]}', lesson, f"{lesson}/playback",
            f"{prefix}/progress?lessonId={lesson_id}", f"{lesson}/quiz", f"{lesson}/quiz/attempts")


def _learner_access_case_evidence(plan, action, evidence, gateway_artifact):
    selected = action["learnerAccessAction"]
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LEARNER_ACCESS_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    demand(_closed_fields(browser, "page reads body"), "P2_INTERACTIVE_LEARNER_ACCESS_BROWSER_RESPONSE_REQUIRED")
    page = browser["page"]
    allowed = selected["outcome"] == "allowed"
    demand(_closed_fields(page, "pathname status lessonLink") and page["pathname"] == f'/academy/courses/{selected["courseId"]}' and
           type(page["status"]) is int and page["status"] == 200 and page["lessonLink"] is allowed,
           "P2_INTERACTIVE_LEARNER_ACCESS_PAGE_REQUIRED")
    reads = browser["reads"]
    paths = _learner_access_paths(selected, "/api/academy")
    status, codes = _LEARNER_ACCESS_OUTCOMES[selected["outcome"]]
    demand(type(reads) is list and len(reads) == len(paths) and all(
        _closed_fields(row, "target status requestId code") and row["target"] == path and
        type(row["status"]) is int and row["status"] == status and row["requestId"] == ack["requestId"] and row["code"] in codes
        for row, path, ack in zip(reads, paths, gateway["gatewayAcknowledgements"][2:])),
        "P2_INTERACTIVE_LEARNER_ACCESS_READS_REQUIRED")
    fields = "courseId lessonId outcome"
    body = browser["body"]
    demand(_closed_fields(body, fields) and all(body[key] == selected[key] for key in fields.split()),
           "P2_INTERACTIVE_LEARNER_ACCESS_BODY_REQUIRED")
    demand(_closed_fields(witness, f"{fields} actorId grantId revision effectiveAccess readOnly") and
           witness["readOnly"] is True and witness["effectiveAccess"] is allowed and witness["actorId"] == action["actorId"] and
           type(witness["revision"]) is int and all(witness[key] == selected[key] for key in ("grantId", "revision")) and
           all(witness[key] == value for key, value in body.items()), "P2_INTERACTIVE_LEARNER_ACCESS_COURSE_WITNESS_REQUIRED")
    return {**body, "actorId": action["actorId"], "operation": selected["operation"], "grantId": selected["grantId"],
            "revision": selected["revision"], "effectiveAccess": allowed, "browserResponseSha256": _receipt_sha(browser),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _lesson_expiry(value):
    if not _matches(_UTC_MILLISECONDS, value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return None


def _lesson_entry_case_evidence(plan, action, evidence, gateway_artifact):
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LESSON_ENTRY_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    request_ids = {row["requestIndex"]: row["requestId"] for row in gateway["gatewayAcknowledgements"][7:]}
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    selected = action["lessonEntryAction"]
    course_id, lesson_id, grant_id = (selected[key] for key in ("courseId", "lessonId", "grantId"))
    demand(_closed_fields(browser, "page playback progress"), "P2_INTERACTIVE_LESSON_ENTRY_BROWSER_RESPONSE_REQUIRED")
    page, playback, progress = (browser[key] for key in ("page", "playback", "progress"))
    demand(_closed_fields(page, "pathname flight") and page["flight"] is True and
           page["pathname"] == f"/academy/courses/{course_id}/lessons/{lesson_id}",
           "P2_INTERACTIVE_LESSON_ENTRY_PAGE_REQUIRED")
    demand(_closed_fields(playback, "requestId expiresAt thumbnailExpiresAt lifetimeMs") and
           playback["requestId"] == request_ids[6] and
           type(playback["lifetimeMs"]) is int and 590_000 <= playback["lifetimeMs"] <= 601_000,
           "P2_INTERACTIVE_LESSON_ENTRY_PLAYBACK_REQUIRED")
    expiry, thumbnail_expiry = (_lesson_expiry(playback[key]) for key in ("expiresAt", "thumbnailExpiresAt"))
    demand(expiry is not None and thumbnail_expiry is not None and
           abs(expiry - thumbnail_expiry) <= timedelta(milliseconds=601_000 - playback["lifetimeMs"]),
           "P2_INTERACTIVE_LESSON_ENTRY_PLAYBACK_REQUIRED")
    demand(_closed_fields(progress, "requestId progressId enrollmentId revision") and
           progress["requestId"] == request_ids[7] and all(_matches(_UUID, progress[key]) for key in ("progressId", "enrollmentId")) and
           type(progress["revision"]) is int and progress["revision"] == 1,
           "P2_INTERACTIVE_LESSON_ENTRY_PROGRESS_REQUIRED")
    joined = {"actorId": action["actorId"], "courseId": course_id, "lessonId": lesson_id, "grantId": grant_id,
              **{key: progress[key] for key in ("progressId", "enrollmentId", "revision")},
              "playbackExpiresAt": max(playback["expiresAt"], playback["thumbnailExpiresAt"])}
    demand(_closed_fields(witness, "actorId courseId lessonId grantId progressId enrollmentId revision playbackExpiresAt readOnly") and
           witness["readOnly"] is True and type(witness["revision"]) is int and
           all(witness[key] == value for key, value in joined.items()), "P2_INTERACTIVE_LESSON_ENTRY_COURSE_WITNESS_REQUIRED")
    return {**joined, "operation": selected["operation"], "playbackGatewayRequestId": request_ids[6],
            "progressGatewayRequestId": request_ids[7], "browserResponseSha256": _receipt_sha(browser),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _lesson_denial_case_evidence(plan, action, evidence, gateway_artifact):
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LESSON_DENIAL_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    selected = action["lessonDenialAction"]
    course_id, lesson_id = selected["courseId"], selected["lessonId"]
    demand(_closed_fields(browser, "page reads"), "P2_INTERACTIVE_LESSON_DENIAL_BROWSER_RESPONSE_REQUIRED")
    page, acks = browser["page"], gateway["gatewayAcknowledgements"]
    document_id = next(row["requestId"] for row in acks[:5] if row["requestIndex"] == 0)
    flight_id = next(row["requestId"] for row in acks[5:10] if row["requestIndex"] == 0)
    demand(_closed_fields(page, "pathname documentStatus flightStatus documentRequestId flightRequestId") and
           page["pathname"] == f"/academy/courses/{course_id}/lessons/{lesson_id}" and
           all(type(page[key]) is int and page[key] == 200 for key in ("documentStatus", "flightStatus")) and
           page["documentRequestId"] == document_id and page["flightRequestId"] == flight_id,
           "P2_INTERACTIVE_LESSON_DENIAL_PAGE_REQUIRED")
    reads = browser["reads"]
    paths = _learner_access_paths(selected, "/api/academy")[1:]
    demand(type(reads) is list and len(reads) == len(paths) and all(
        _closed_fields(row, "target status requestId code") and row["target"] == path and
        type(row["status"]) is int and row["status"] == 403 and row["requestId"] == ack["requestId"] and
        row["code"] == "access_required"
        for row, path, ack in zip(reads, paths, acks[10:])),
        "P2_INTERACTIVE_LESSON_DENIAL_READS_REQUIRED")
    joined = {"actorId": action["actorId"], "courseId": course_id, "lessonId": lesson_id,
              "enrolledActorId": selected["enrolledActorId"], "grantId": selected["grantId"]}
    demand(_closed_fields(witness, "actorId courseId lessonId enrolledActorId grantId effectiveAccess readOnly") and
           witness["effectiveAccess"] is False and witness["readOnly"] is True and
           all(witness[key] == value for key, value in joined.items()), "P2_INTERACTIVE_LESSON_DENIAL_COURSE_WITNESS_REQUIRED")
    return {**joined, "operation": selected["operation"], "effectiveAccess": False,
            "browserResponseSha256": _receipt_sha(browser), "courseWitnessSha256": _receipt_sha(witness),
            "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _assessment_case_evidence(plan, action, evidence, gateway_artifact):
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LESSON_ASSESSMENT_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    acks = gateway["gatewayAcknowledgements"]
    render_ids = {row["requestIndex"]: row["requestId"] for row in acks[5:7]}
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    selected = action["assessmentAction"]
    course_id, lesson_id, grant_id, quiz_revision = (selected[key] for key in ("courseId", "lessonId", "grantId", "quizRevision"))
    demand(_closed_fields(browser, "page playback started attempts"), "P2_INTERACTIVE_LESSON_ASSESSMENT_BROWSER_RESPONSE_REQUIRED")
    page, playback, started, attempts = (browser[key] for key in ("page", "playback", "started", "attempts"))
    demand(_closed_fields(page, "pathname status") and page["pathname"] == f"/academy/courses/{course_id}/lessons/{lesson_id}" and
           type(page["status"]) is int and page["status"] == 200 and _closed_fields(playback, "requestId status") and
           playback["requestId"] == render_ids[5] and type(playback["status"]) is int and playback["status"] == 404,
           "P2_INTERACTIVE_LESSON_ASSESSMENT_PAGE_REQUIRED")
    demand(_closed_fields(started, "requestId progressId enrollmentId revision") and started["requestId"] == render_ids[6] and
           all(_matches(_UUID, started[key]) for key in ("progressId", "enrollmentId")) and type(started["revision"]) is int and
           started["revision"] == 1, "P2_INTERACTIVE_LESSON_ASSESSMENT_STARTED_REQUIRED")
    demand(type(attempts) is list and len(attempts) == 2, "P2_INTERACTIVE_LESSON_ASSESSMENT_ATTEMPTS_REQUIRED")
    for index, row in enumerate(attempts):
        passed = index == 1
        demand(_closed_fields(row, "requestId payloadRequestId attemptId quizRevisionId quizRevision correctCount totalCount passed completed createdAt progress") and
               row["requestId"] == acks[7 + index * 2]["requestId"] and
               all(_matches(_UUID, row[key]) for key in ("payloadRequestId", "attemptId", "quizRevisionId")) and row["payloadRequestId"][14] == "4" and
               type(row["quizRevision"]) is int and row["quizRevision"] == quiz_revision and
               type(row["totalCount"]) is int and row["totalCount"] == len(selected["failAnswers"]) and
               type(row["correctCount"]) is int and 0 <= row["correctCount"] <= row["totalCount"] and
               row["passed"] is passed and row["completed"] is passed and _lesson_expiry(row["createdAt"]) is not None,
               "P2_INTERACTIVE_LESSON_ASSESSMENT_ATTEMPTS_REQUIRED")
        progress = row["progress"]
        demand(_closed_fields(progress, "requestId progressId enrollmentId revision completedAt completedQuizRevision") and
               progress["requestId"] == acks[8 + index * 2]["requestId"] and
               all(progress[key] == started[key] for key in ("progressId", "enrollmentId")) and
               type(progress["revision"]) is int and progress["revision"] == 2 + index and
               progress["completedAt"] == (row["createdAt"] if passed else None) and
               type(progress["completedQuizRevision"]) is (int if passed else type(None)) and
               progress["completedQuizRevision"] == (quiz_revision if passed else None),
               "P2_INTERACTIVE_LESSON_ASSESSMENT_PROGRESS_REQUIRED")
    failed, passed = attempts
    identifiers = [row["requestId"] for row in acks] + [row[key] for row in attempts for key in ("payloadRequestId", "attemptId")]
    demand(failed["quizRevisionId"] == passed["quizRevisionId"] and failed["createdAt"] <= passed["createdAt"] and
           failed["correctCount"] < passed["correctCount"] and len(set(identifiers)) == len(identifiers),
           "P2_INTERACTIVE_LESSON_ASSESSMENT_ATTEMPTS_REQUIRED")
    joined = {"actorId": action["actorId"], "courseId": course_id, "lessonId": lesson_id, "grantId": grant_id,
              "quizRevision": quiz_revision, "enrollmentId": started["enrollmentId"], "progressId": started["progressId"],
              "attemptIds": [row["attemptId"] for row in attempts], "progressRevision": 3}
    demand(_closed_fields(witness, "actorId courseId lessonId grantId quizRevision enrollmentId progressId attemptIds progressRevision readOnly") and
           witness["readOnly"] is True and all(type(witness[key]) is int for key in ("quizRevision", "progressRevision")) and
           all(witness[key] == value for key, value in joined.items()), "P2_INTERACTIVE_LESSON_ASSESSMENT_COURSE_WITNESS_REQUIRED")
    return {**joined, "operation": selected["operation"], "browserResponseSha256": _receipt_sha(browser),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


def _resume_case_evidence(plan, action, evidence, gateway_artifact):
    demand(_closed_fields(evidence, "browserResponse courseWitness"), "P2_INTERACTIVE_LESSON_RESUME_EVIDENCE_REQUIRED")
    gateway = browser_gateway_receipt(plan, gateway_artifact)
    request_ids = {row["requestIndex"]: row["requestId"] for row in gateway["gatewayAcknowledgements"][5:]}
    browser, witness = evidence["browserResponse"], evidence["courseWitness"]
    selected = action["resumeAction"]
    course_id, lesson_id, grant_id = (selected[key] for key in ("courseId", "lessonId", "grantId"))
    demand(_closed_fields(browser, "page playback started writes media"), "P2_INTERACTIVE_LESSON_RESUME_BROWSER_RESPONSE_REQUIRED")
    page, playback, started, writes, media = (browser[key] for key in ("page", "playback", "started", "writes", "media"))
    demand(_closed_fields(page, "pathname status") and page["pathname"] == f"/academy/courses/{course_id}/lessons/{lesson_id}" and
           type(page["status"]) is int and page["status"] == 200, "P2_INTERACTIVE_LESSON_RESUME_PAGE_REQUIRED")
    demand(_closed_fields(playback, "requestId expiresAt thumbnailExpiresAt lifetimeMs playbackIdSha256") and
           playback["requestId"] == request_ids[5] and _digest(playback["playbackIdSha256"]) and
           type(playback["lifetimeMs"]) is int and 590_000 <= playback["lifetimeMs"] <= 601_000,
           "P2_INTERACTIVE_LESSON_RESUME_PLAYBACK_REQUIRED")
    expiry, thumbnail_expiry = (_lesson_expiry(playback[key]) for key in ("expiresAt", "thumbnailExpiresAt"))
    demand(expiry is not None and thumbnail_expiry is not None and
           abs(expiry - thumbnail_expiry) <= timedelta(milliseconds=601_000 - playback["lifetimeMs"]),
           "P2_INTERACTIVE_LESSON_RESUME_PLAYBACK_REQUIRED")
    demand(_closed_fields(started, "requestId progressId enrollmentId revision") and started["requestId"] == request_ids[6] and
           all(_matches(_UUID, started[key]) for key in ("progressId", "enrollmentId")) and type(started["revision"]) is int and
           started["revision"] == 1, "P2_INTERACTIVE_LESSON_RESUME_STARTED_REQUIRED")
    position_fields = ("resumePositionSeconds", "submittedMaxPositionSeconds", "maxPositionSeconds")
    demand(type(writes) is list and len(writes) == 3 and all(
        _closed_fields(row, "requestId expectedProgressRevision revision resumePositionSeconds submittedMaxPositionSeconds maxPositionSeconds") and
        row["requestId"] == request_ids[7 + index] and type(row["expectedProgressRevision"]) is int and
        row["expectedProgressRevision"] == index + 1 and type(row["revision"]) is int and row["revision"] == index + 2 and
        all(_safe_integer(row[key]) for key in position_fields) and
        row["maxPositionSeconds"] == max(row["resumePositionSeconds"], row["submittedMaxPositionSeconds"])
        for index, row in enumerate(writes)), "P2_INTERACTIVE_LESSON_RESUME_WRITES_REQUIRED")
    heartbeat, paused, rewound = writes
    demand(10 <= heartbeat["resumePositionSeconds"] <= 12 and heartbeat["submittedMaxPositionSeconds"] == heartbeat["resumePositionSeconds"] and
           13 <= paused["resumePositionSeconds"] <= 16 and
           max(heartbeat["maxPositionSeconds"], paused["resumePositionSeconds"] - 1) <= paused["submittedMaxPositionSeconds"] <= paused["resumePositionSeconds"] and
           rewound["resumePositionSeconds"] == paused["resumePositionSeconds"] - 10 and
           rewound["submittedMaxPositionSeconds"] == rewound["maxPositionSeconds"] == paused["maxPositionSeconds"],
           "P2_INTERACTIVE_LESSON_RESUME_POSITIONS_REQUIRED")
    demand(_closed_fields(media, "durationSeconds videoWidth heartbeatSeconds pausedSeconds rewoundSeconds manifestObserved segmentObserved") and
           all(_safe_integer(media[key]) for key in
               ("durationSeconds", "videoWidth", "heartbeatSeconds", "pausedSeconds", "rewoundSeconds")) and
           media["durationSeconds"] >= 22 and media["videoWidth"] > 0 and
           heartbeat["resumePositionSeconds"] <= media["heartbeatSeconds"] <= heartbeat["resumePositionSeconds"] + 1 and
           media["pausedSeconds"] == paused["resumePositionSeconds"] and media["rewoundSeconds"] == rewound["resumePositionSeconds"] and
           media["manifestObserved"] is True and media["segmentObserved"] is True, "P2_INTERACTIVE_LESSON_RESUME_MEDIA_REQUIRED")
    joined = {"actorId": action["actorId"], "courseId": course_id, "lessonId": lesson_id, "grantId": grant_id,
              **{key: started[key] for key in ("enrollmentId", "progressId")},
              **{key: rewound[key] for key in ("revision", "resumePositionSeconds", "maxPositionSeconds")},
              "playbackExpiresAt": max(playback["expiresAt"], playback["thumbnailExpiresAt"]),
              "playbackIdSha256": playback["playbackIdSha256"]}
    demand(_closed_fields(witness, "actorId courseId lessonId grantId enrollmentId progressId revision resumePositionSeconds maxPositionSeconds playbackExpiresAt playbackIdSha256 readOnly") and
           witness["readOnly"] is True and all(type(witness[key]) is int for key in ("revision", "resumePositionSeconds", "maxPositionSeconds")) and
           all(witness[key] == value for key, value in joined.items()), "P2_INTERACTIVE_LESSON_RESUME_COURSE_WITNESS_REQUIRED")
    return {**joined, "operation": selected["operation"], "playbackGatewayRequestId": request_ids[5], "startedGatewayRequestId": request_ids[6],
            "positionGatewayRequestIds": [row["requestId"] for row in writes], "browserResponseSha256": _receipt_sha(browser),
            "courseWitnessSha256": _receipt_sha(witness), "gatewayEvidenceSha256": gateway["gatewayEvidenceSha256"]}


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
    if plan["scopedAction"]["stage"] in (_LEARNER_ACCESS, _LESSON_DENIAL):
        demand(_closed_fields(witness, "commands deliveries orderViolations operations") and
               all(value == [] for value in witness.values()), browser_status(plan, "READ_ONLY_LEDGER_REQUIRED"))
        return 0
    demand(_closed_fields(witness, "commands deliveries orderViolations operations") and
           witness["commands"] == witness["deliveries"] == witness["orderViolations"] == [] and
           type(witness["operations"]) is list and 0 < len(witness["operations"]) <= 4096,
           browser_status(plan, "LEDGER_REQUIRED"))
    operations = witness["operations"]
    if plan["scopedAction"]["stage"] == _LESSON_ENTRY:
        demand(len(operations) == 1, browser_status(plan, "SINGLE_NEW_WORK_REQUIRED"))
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
    if plan["scopedAction"]["stage"] == _ASSESSMENT:
        demand(len(operations) == 3 and all(row["kind"] == "new-work" for row in operations),
               browser_status(plan, "THREE_NEW_WORK_REQUIRED"))
    if plan["scopedAction"]["stage"] == _RESUME:
        demand(len(operations) == 4 and all(row["kind"] == "new-work" for row in operations),
               browser_status(plan, "FOUR_NEW_WORK_REQUIRED"))
    return len(operations)


def _assessment_answers(answers):
    return (type(answers) is list and 1 <= len(answers) <= 100 and
            all(_closed_fields(answer, "questionId optionId") and
                all(_matches(_ANSWER_KEY, answer[key]) for key in ("questionId", "optionId")) for answer in answers) and
            len({answer["questionId"] for answer in answers}) == len(answers))


def validate_interactive_action(action):
    lifecycle = type(action) is dict and action.get("stage") == "lifecycle"
    identity = type(action) is dict and action.get("stage") == "identity"
    authoring = type(action) is dict and action.get("stage") == "authoring"
    learning = type(action) is dict and action.get("stage") == "learning"
    paid_grant = type(action) is dict and action.get("stage") == "paid-grant"
    paid_revoke = type(action) is dict and action.get("stage") == _PAID_REVOKE
    learner_access = type(action) is dict and action.get("stage") == _LEARNER_ACCESS
    lesson_entry = type(action) is dict and action.get("stage") == _LESSON_ENTRY
    lesson_denial = type(action) is dict and action.get("stage") == _LESSON_DENIAL
    assessment = type(action) is dict and action.get("stage") == _ASSESSMENT
    resume = type(action) is dict and action.get("stage") == _RESUME
    fields = {"stage", "actorId", "requests", "windowSeconds"}
    if lifecycle:
        fields.add("frontendAction")
    if authoring:
        fields.add("authoringAction")
    if learning:
        fields.add("learningAction")
    if paid_grant:
        fields.add("paidGrantAction")
    if paid_revoke:
        fields.add("paidRevokeAction")
    if learner_access:
        fields.add("learnerAccessAction")
    if lesson_entry:
        fields.add("lessonEntryAction")
    if lesson_denial:
        fields.add("lessonDenialAction")
    if assessment:
        fields.add("assessmentAction")
    if resume:
        fields.add("resumeAction")
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
        replay = type(selection) is dict and selection.get("operation") == "replay-free-enrollment"
        fields = "operation courseId slug idempotencyKey" + (" prior" if replay else "")
        demand(_closed_fields(selection, fields) and
               (replay or selection["operation"] == "enroll-free-course") and _matches(_UUID, selection["courseId"]) and
               _matches(_SLUG, selection["slug"]) and len(selection["slug"]) <= 120 and
               _matches(_UUID, selection["idempotencyKey"]), "P2_INTERACTIVE_LEARNING_ENROLLMENT_SELECTION_REQUIRED")
        if replay:
            prior = selection["prior"]
            demand(_closed_fields(prior, "grantId enrollmentId eventId streamId canonicalDigest") and
                   all(_matches(_UUID, prior[key]) for key in ("grantId", "enrollmentId", "eventId", "streamId")) and
                   _digest(prior["canonicalDigest"]), "P2_INTERACTIVE_LEARNING_REPLAY_PRIOR_REQUIRED")
        course = f'/course/v1/student/courses/{selection["courseId"]}'
        digest = _receipt_sha({"idempotencyKey": selection["idempotencyKey"]})
        detail = {"method": "GET", "target": course, "bodySha256": _EMPTY, "uses": 1 if replay else 2}
        progress = {"method": "GET", "target": f'/course/v1/student/progress?courseId={selection["courseId"]}',
                    "bodySha256": _EMPTY, "uses": 1}
        enroll = {"method": "POST", "target": f"{course}/enrollments", "bodySha256": digest, "uses": 1}
        expected = [detail, progress, enroll] if replay else [
            {"method": "GET", "target": f'/course/v1/courses/{selection["slug"]}', "bodySha256": _EMPTY, "uses": 1},
            detail, enroll, progress,
        ]
        demand(requests == expected, "P2_INTERACTIVE_LEARNING_ENROLLMENT_REQUESTS_REQUIRED")
    if paid_grant:
        selection = action["paidGrantAction"]
        second = type(selection) is dict and "priorGrantId" in selection
        fields = "operation courseId userId revision idempotencyKey reasonSha256" + (" priorGrantId" if second else "")
        demand(_closed_fields(selection, fields) and (not second or _matches(_UUID, selection["priorGrantId"])) and
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
    if paid_revoke:
        selection = action["paidRevokeAction"]
        demand(_closed_fields(selection, "operation courseId userId grantId revision idempotencyKey reasonSha256 remainingAccess") and
               selection["operation"] == "revoke-paid-grant" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "userId", "grantId", "idempotencyKey")) and
               type(selection["revision"]) is int and 1 <= selection["revision"] <= 2_147_483_647 and
               _digest(selection["reasonSha256"]) and selection["reasonSha256"] != _EMPTY and
               type(selection["remainingAccess"]) is bool, "P2_INTERACTIVE_PAID_REVOKE_SELECTION_REQUIRED")
        entitlements = "/course/v1/admin/entitlements"
        command_query = f'idempotencyKey=owner-paid-revoke%3A{selection["idempotencyKey"]}&limit=2'
        grant_query = f'grantId={selection["grantId"]}&userId={selection["userId"]}&courseId={selection["courseId"]}&limit=2'
        expected = (
            ("GET", f'/course/v1/admin/courses/{selection["courseId"]}', 3),
            ("GET", f"{entitlements}/commands?{command_query}", 2),
            ("GET", f"{entitlements}/grants?{grant_query}", 2),
            ("POST", f"{entitlements}/revocations", 1),
        )
        demand(tuple((row["method"], row["target"], row["uses"]) for row in requests) == expected and
               _digest(requests[3]["bodySha256"]) and requests[3]["bodySha256"] != _EMPTY,
               "P2_INTERACTIVE_PAID_REVOKE_REQUESTS_REQUIRED")
    if learner_access:
        selection = action["learnerAccessAction"]
        demand(_closed_fields(selection, "operation courseId lessonId grantId revision outcome") and
               selection["operation"] == "observe-paid-access" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "lessonId", "grantId")) and
               type(selection["revision"]) is int and 1 <= selection["revision"] <= 2_147_483_647 and
               type(selection["outcome"]) is str and selection["outcome"] in _LEARNER_ACCESS_OUTCOMES,
               "P2_INTERACTIVE_LEARNER_ACCESS_SELECTION_REQUIRED")
        course, *lesson = _learner_access_paths(selection, "/course/v1/student")
        targets = [course, f'/course/v1/student/progress?courseId={selection["courseId"]}', *lesson]
        demand(requests == [{"method": "GET", "target": target, "bodySha256": _EMPTY, "uses": 2 if index == 0 else 1}
                            for index, target in enumerate(targets)], "P2_INTERACTIVE_LEARNER_ACCESS_REQUESTS_REQUIRED")
    if lesson_entry:
        selection = action["lessonEntryAction"]
        demand(_closed_fields(selection, "operation courseId lessonId grantId") and selection["operation"] == "open-lesson" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "lessonId", "grantId")),
               "P2_INTERACTIVE_LESSON_ENTRY_SELECTION_REQUIRED")
        course, lesson_id = selection["courseId"], selection["lessonId"]
        student = "/course/v1/student"
        lesson = f"{student}/lessons/{lesson_id}"
        targets = [f"{student}/courses/{course}", f"{student}/progress?courseId={course}", lesson,
                   f"{student}/progress?lessonId={lesson_id}", f"{lesson}/quiz", f"{lesson}/quiz/attempts", f"{lesson}/playback"]
        expected = [{"method": "GET", "target": target, "bodySha256": _EMPTY, "uses": 2 if index == 0 else 1}
                    for index, target in enumerate(targets)]
        expected.append({"method": "POST", "target": f"{lesson}/progress",
                         "bodySha256": _hash(b'{"event":"lesson_started","expectedProgressRevision":0}'), "uses": 1})
        demand(requests == expected, "P2_INTERACTIVE_LESSON_ENTRY_REQUESTS_REQUIRED")
    if lesson_denial:
        selection = action["lessonDenialAction"]
        demand(_closed_fields(selection, "operation courseId lessonId enrolledActorId grantId") and
               selection["operation"] == "deny-cross-account" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "lessonId", "enrolledActorId", "grantId")) and
               selection["enrolledActorId"] != action["actorId"], "P2_INTERACTIVE_LESSON_DENIAL_SELECTION_REQUIRED")
        course, lesson, playback, progress, quiz, attempts = _learner_access_paths(selection, "/course/v1/student")
        targets = (course, lesson, progress, quiz, attempts, playback)
        demand(requests == [{"method": "GET", "target": target, "bodySha256": _EMPTY, "uses": uses}
                            for target, uses in zip(targets, (2, 3, 3, 3, 3, 1))],
               "P2_INTERACTIVE_LESSON_DENIAL_REQUESTS_REQUIRED")
    if assessment:
        selection = action["assessmentAction"]
        demand(_closed_fields(selection, "operation courseId lessonId grantId quizRevision failAnswers passAnswers") and
               selection["operation"] == "fail-then-pass" and all(_matches(_UUID, selection[key]) for key in ("courseId", "lessonId", "grantId")) and
               type(selection["quizRevision"]) is int and 1 <= selection["quizRevision"] <= 2_147_483_647,
               "P2_INTERACTIVE_LESSON_ASSESSMENT_SELECTION_REQUIRED")
        fail, passed = selection["failAnswers"], selection["passAnswers"]
        demand(_assessment_answers(fail) and _assessment_answers(passed) and fail != passed and
               [row["questionId"] for row in fail] == [row["questionId"] for row in passed],
               "P2_INTERACTIVE_LESSON_ASSESSMENT_ANSWERS_REQUIRED")
        course, lesson, playback, progress, quiz, attempts = _learner_access_paths(selection, "/course/v1/student")
        expected = [{"method": "GET", "target": target, "bodySha256": _EMPTY, "uses": 3 if index == 2 else 1}
                    for index, target in enumerate((course, lesson, progress, quiz, attempts, playback))]
        expected.append({"method": "POST", "target": f"{lesson}/progress", "uses": 1,
                         "bodySha256": _hash(b'{"event":"lesson_started","expectedProgressRevision":0}')})
        for answers in (fail, passed):
            normalized = [{key: answer[key] for key in ("questionId", "optionId")} for answer in answers]
            body = json.dumps({"quizRevision": selection["quizRevision"], "answers": normalized}, separators=(",", ":")).encode()
            expected.append({"method": "POST", "target": attempts, "uses": 1, "bodySha256": _hash(body)})
        demand(requests == expected, "P2_INTERACTIVE_LESSON_ASSESSMENT_REQUESTS_REQUIRED")
    if resume:
        selection = action["resumeAction"]
        demand(_closed_fields(selection, "operation courseId lessonId grantId") and selection["operation"] == "play-and-rewind" and
               all(_matches(_UUID, selection[key]) for key in ("courseId", "lessonId", "grantId")),
               "P2_INTERACTIVE_LESSON_RESUME_SELECTION_REQUIRED")
        course, lesson, playback, progress, quiz, attempts = _learner_access_paths(selection, "/course/v1/student")
        expected = [{"method": "GET", "target": target, "bodySha256": _EMPTY, "uses": 1}
                    for target in (course, lesson, progress, quiz, attempts, playback)]
        progress_bodies = [{"event": "lesson_started", "expectedProgressRevision": 0}]
        progress_bodies.extend({"expectedProgressRevision": revision} for revision in (1, 2, 3))
        expected.extend({"method": "POST", "target": f"{lesson}/progress", "uses": 1,
                         "bodySha256": _hash(json.dumps(body, separators=(",", ":")).encode())} for body in progress_bodies)
        demand(requests == expected, "P2_INTERACTIVE_LESSON_RESUME_REQUESTS_REQUIRED")
    return copy.deepcopy(action)


def _selection_sha(action):
    lesson_field = {_LESSON_ENTRY: "lessonEntryAction", _LESSON_DENIAL: "lessonDenialAction", _ASSESSMENT: "assessmentAction",
                    _RESUME: "resumeAction"}.get(action["stage"])
    if lesson_field:
        selected = action[lesson_field]
        return (action["actorId"] + selected["courseId"] + selected["lessonId"]).replace("-", "")
    if action["stage"] == _LEARNER_ACCESS:
        return (action["actorId"] + action["learnerAccessAction"]["lessonId"]).replace("-", "")
    key_field = {"learning": "learningAction", "paid-grant": "paidGrantAction", _PAID_REVOKE: "paidRevokeAction"}.get(action["stage"])
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
    selector = _LESSON_SELECTOR if stage in (_LESSON_ENTRY, _LESSON_DENIAL, _ASSESSMENT, _RESUME) else _SHA
    demand(_matches(selector, selection_sha) if stage in EXECUTABLE_BROWSER_STAGES else selection_sha is None,
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
        paid_course = self.action.get("paidGrantAction") or self.action.get("paidRevokeAction")
        learner_access = self.action.get("learnerAccessAction")
        lesson_entry = self.action.get("lessonEntryAction")
        lesson_denial = self.action.get("lessonDenialAction")
        assessment = self.action.get("assessmentAction")
        resume = self.action.get("resumeAction")
        protect = ingress.observe_authoring_protection if authoring else ingress.observe_browser_protection
        paths = {"course_id": authoring["courseId"]} if authoring and authoring["operation"] != _CREATE_DRAFT else {}
        if learning:
            protect = ingress.observe_learning_protection
            paths = {"course_id": learning["courseId"], "slug": learning["slug"]}
        if paid_course:
            protect = ingress.observe_paid_grant_protection
            paths = {"course_id": paid_course["courseId"]}
        if learner_access:
            protect = ingress.observe_learner_access_protection
            paths = {"course_id": learner_access["courseId"], "lesson_id": learner_access["lessonId"]}
        if lesson_entry:
            protect = ingress.observe_lesson_entry_protection
            paths = {"course_id": lesson_entry["courseId"], "lesson_id": lesson_entry["lessonId"]}
        if lesson_denial:
            protect = ingress.observe_lesson_denial_protection
            paths = {"course_id": lesson_denial["courseId"], "lesson_id": lesson_denial["lessonId"]}
        if assessment:
            protect = ingress.observe_lesson_assessment_protection
            paths = {"course_id": assessment["courseId"], "lesson_id": assessment["lessonId"]}
        if resume:
            protect = ingress.observe_lesson_resume_protection
            paths = {"course_id": resume["courseId"], "lesson_id": resume["lessonId"]}
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
