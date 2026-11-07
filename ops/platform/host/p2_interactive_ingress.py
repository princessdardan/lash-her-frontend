"""Read-only proof that the selected staging ingress is not public.

This leaf does not enable admission, change deployment protection, create a
bypass, or authorize interactive work. The source-owned parent supplies the
existing provider client and fixed staging-current lifecycle context.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import ssl
import urllib.error
import urllib.request

import migrate
import p2_canonical_browser_origin as canonical
import p2_lifecycle_native as native
import vercel


demand = migrate.demand
_DIRECT_DEPLOYMENT = re.compile(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app")
_BYPASS_SECRET = re.compile(r"[!-~]{1,8192}")
_MAX_DENIAL_BODY = 65_536
_BROWSER_PATHS = (
    "/",
    "/sign-in",
    "/admin/sign-in",
    "/api/customer-auth/session",
    "/api/auth/session",
    "/api/customer-auth/callback/google",
    "/api/customer-auth/callback/resend",
    "/api/auth/callback/google",
)
_AUTHORING_PATHS = ("/admin/courses", "/api/admin/courses")
_COURSE_ID = r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
_AUTHORING_DETAIL_PATH = re.compile(rf"(?:/admin/courses|/api/admin/courses)/{_COURSE_ID}")
_PUBLICATION_READINESS_PATH = re.compile(rf"/api/admin/courses/{_COURSE_ID}/publication-readiness")
_QUIZ_PATH = re.compile(rf"/api/admin/lessons/{_COURSE_ID}/quiz")
_COURSE_SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
_PUBLIC_COURSE_PATH = re.compile(rf"/courses/{_COURSE_SLUG}")
_LEARNER_COURSE_PATH = re.compile(rf"/academy/courses/{_COURSE_ID}")
_LEARNER_LESSON_PATH = re.compile(rf"/academy/courses/{_COURSE_ID}/lessons/{_COURSE_ID}")
_LEARNER_LESSON_FLIGHT_PATH = re.compile(_LEARNER_LESSON_PATH.pattern + r"\?_rsc")
_LEARNER_COURSE_API_PATH = re.compile(rf"/api/academy/courses/{_COURSE_ID}")
_LEARNER_LESSON_API_PATH = re.compile(rf"/api/academy/lessons/{_COURSE_ID}(?:/playback|/progress|/quiz(?:/attempts)?)?")
_LEARNER_PROGRESS_API_PATH = re.compile(rf"/api/academy/progress\?(?:courseId|lessonId)={_COURSE_ID}")
_PAID_GRANT_PATH = re.compile(rf"/admin/courses/{_COURSE_ID}/manual-grants")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _protection(project):
    sso = project.get("ssoProtection")
    demand(type(sso) is dict and set(sso) == {"deploymentType"} and
           sso["deploymentType"] == "all", "P2_INTERACTIVE_ALL_DEPLOYMENTS_PROTECTION_REQUIRED")
    bypasses = project.get("protectionBypass")
    demand(type(bypasses) is dict and bypasses, "P2_INTERACTIVE_AUTOMATION_BYPASS_REQUIRED")
    for secret, value in bypasses.items():
        demand(type(secret) is str and _BYPASS_SECRET.fullmatch(secret) is not None and
               type(value) is dict and set(value) == {"createdAt", "createdBy", "scope"} and
               type(value["createdAt"]) is int and value["createdAt"] > 0 and
               type(value["createdBy"]) is str and 0 < len(value["createdBy"]) <= 256 and
               value["scope"] == "automation-bypass",
               "P2_INTERACTIVE_PROTECTION_BYPASS_SCOPE_REFUSED")
    return {"method": "vercel-authentication", "scope": "all-deployments",
            "automationBypassScope": "automation-bypass", "automationBypassCount": len(bypasses)}


class UnauthenticatedIngressClient:
    """Credential-free, no-proxy, no-cookie, no-redirect HTTPS denial probe."""

    def __init__(self):
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, origin, path="/"):
        demand(type(origin) is str and (origin == canonical.ORIGIN or _DIRECT_DEPLOYMENT.fullmatch(origin)),
               "P2_INTERACTIVE_INGRESS_ORIGIN_REFUSED")
        demand(type(path) is str and (path in _BROWSER_PATHS + _AUTHORING_PATHS or _AUTHORING_DETAIL_PATH.fullmatch(path) or
                                     _PUBLICATION_READINESS_PATH.fullmatch(path) or _QUIZ_PATH.fullmatch(path) or
                                     len(path) <= 129 and _PUBLIC_COURSE_PATH.fullmatch(path) or _LEARNER_COURSE_PATH.fullmatch(path) or
                                     _LEARNER_COURSE_API_PATH.fullmatch(path) or _LEARNER_LESSON_API_PATH.fullmatch(path) or
                                     _LEARNER_LESSON_PATH.fullmatch(path) or _LEARNER_LESSON_FLIGHT_PATH.fullmatch(path) or
                                     _LEARNER_PROGRESS_API_PATH.fullmatch(path) or _PAID_GRANT_PATH.fullmatch(path)),
               "P2_INTERACTIVE_INGRESS_PATH_REFUSED")
        url = origin + path
        flight = _LEARNER_LESSON_FLIGHT_PATH.fullmatch(path) is not None
        headers = {"accept": "text/x-component" if flight else "text/html,application/xhtml+xml",
                   "cache-control": "no-cache"}
        if flight:
            headers["RSC"] = "1"
        request = urllib.request.Request(url, method="GET", headers=headers)
        try:
            with self._opener.open(request, timeout=20 if path == "/" else 5) as response:
                response.read(_MAX_DENIAL_BODY + 1)
            raise ValueError("P2_INTERACTIVE_UNAUTHENTICATED_INGRESS_NOT_DENIED")
        except urllib.error.HTTPError as error:
            try:
                raw = error.read(_MAX_DENIAL_BODY + 1)
                demand(error.code in (401, 403) and error.geturl() == url and
                       error.headers.get("location") is None and len(raw) <= _MAX_DENIAL_BODY,
                       "P2_INTERACTIVE_UNAUTHENTICATED_INGRESS_NOT_DENIED")
                return {"status": error.code, "redirected": False}
            finally:
                error.close()
        except ValueError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ValueError("P2_INTERACTIVE_UNAUTHENTICATED_INGRESS_UNOBSERVED") from None


def observe(context, client, canonical_probe=None, *, expected_profile=None):
    """Prove selected alias and direct deployment deny credential-free GETs."""
    expected = migrate.profile_context(expected_profile)
    demand(expected is not None, "QUALIFICATION_TARGET_PROFILE_REQUIRED")
    plan = native.identity(context, expected_profile=expected)
    candidate = context["candidate"]
    demand(plan["projectId"] == canonical.PROJECT and plan["deploymentUrl"] != canonical.ORIGIN,
           "P2_INTERACTIVE_INGRESS_TARGET_REFUSED")

    before_project = vercel._project(client, canonical.PROJECT)
    protection = _protection(before_project)
    canonical_proof = canonical.observe(context, client, canonical_probe, expected_profile=expected)
    demand(canonical_proof.get("version") == 2 and
           canonical_proof.get("qualificationTargetProfile") == expected and
           canonical_proof.get("status") == "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED" and
           canonical_proof.get("projectId") == canonical.PROJECT and
           canonical_proof.get("deploymentId") == plan["deploymentId"] and
           canonical_proof.get("deploymentUrl") == plan["deploymentUrl"] and
           canonical_proof.get("browserOrigin") == canonical.ORIGIN and
           canonical_proof.get("sourceCommit") == plan["sourceCommit"] and
           canonical_proof.get("releaseId") == plan["actionId"] and
           canonical_proof.get("candidateSha256") == plan["candidateSha256"] and
           canonical_proof.get("phase2ContractManifestSha256") ==
               candidate["phase2ContractManifestSha256"] and
           canonical_proof.get("workloadChallengeVerified") is True and
           canonical_proof.get("aliasRedirect") is False,
           "P2_INTERACTIVE_CANONICAL_PROOF_REFUSED")

    requester = UnauthenticatedIngressClient()
    alias_denial = requester.request(canonical.ORIGIN)
    deployment_denial = requester.request(plan["deploymentUrl"])
    demand(alias_denial in ({"status": 401, "redirected": False}, {"status": 403, "redirected": False}) and
           deployment_denial in ({"status": 401, "redirected": False}, {"status": 403, "redirected": False}),
           "P2_INTERACTIVE_UNAUTHENTICATED_INGRESS_NOT_DENIED")

    after_project = vercel._project(client, canonical.PROJECT)
    demand(after_project.get("ssoProtection") == before_project.get("ssoProtection") and
           after_project.get("protectionBypass") == before_project.get("protectionBypass") and
           _protection(after_project) == protection,
           "P2_INTERACTIVE_PROTECTION_CHANGED")
    return {"version": 2, "qualificationTargetProfile": copy.deepcopy(expected),
            "status": "P2_INTERACTIVE_INGRESS_READ_ONLY_VERIFIED", "environment": "staging",
            "teamId": vercel.TEAM, "projectId": canonical.PROJECT,
            "deploymentId": plan["deploymentId"], "deploymentUrl": plan["deploymentUrl"],
            "browserOrigin": canonical.ORIGIN, "sourceCommit": plan["sourceCommit"],
            "releaseId": plan["actionId"], "candidateSha256": plan["candidateSha256"],
            "phase2ContractManifestSha256": candidate["phase2ContractManifestSha256"],
            "canonicalBrowserProofSha256": _digest(canonical_proof), **protection,
            "aliasUnauthenticatedStatus": alias_denial["status"],
            "deploymentUnauthenticatedStatus": deployment_denial["status"],
            "redirectFollowed": False, "selectedOriginPublicExceptionObserved": False,
            "automationBypassCustodyVerified": False, "singleOperatorBypassHandlingVerified": False,
            "interactiveNewWorkAuthorized": False, "trafficAuthorized": False, "releaseAccepted": False}


def observe_selected_protection(context, client, *, expected_profile):
    """Recheck protected endpoints independently of a retained probe secret."""
    return _observe_selected_protection(context, client, expected_profile, browser=False)


def observe_browser_protection(context, client, *, expected_profile):
    """Check the fixed browser sign-in ingress without replaying a callback."""
    return _observe_selected_protection(context, client, expected_profile, browser=True)


def observe_authoring_protection(context, client, *, expected_profile, course_id=None, publication_readiness=False,
                                 quiz_lesson_id=None):
    """Check the protected authoring page and its exact same-origin endpoint."""
    demand(course_id is None or type(course_id) is str and re.fullmatch(_COURSE_ID, course_id),
           "P2_INTERACTIVE_AUTHORING_COURSE_ID_REQUIRED")
    demand(publication_readiness is False or publication_readiness is True and course_id is not None,
           "P2_INTERACTIVE_AUTHORING_READINESS_COURSE_REQUIRED")
    demand(quiz_lesson_id is None or course_id is not None and type(quiz_lesson_id) is str and
           re.fullmatch(_COURSE_ID, quiz_lesson_id), "P2_INTERACTIVE_AUTHORING_QUIZ_LESSON_REQUIRED")
    paths = _AUTHORING_PATHS if course_id is None else tuple(f"{path}/{course_id}" for path in _AUTHORING_PATHS)
    if publication_readiness:
        paths += (f"/api/admin/courses/{course_id}/publication-readiness",)
    if quiz_lesson_id is not None:
        paths += (f"/api/admin/lessons/{quiz_lesson_id}/quiz",)
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def observe_learning_protection(context, client, *, expected_profile, course_id, slug):
    demand(type(course_id) is str and re.fullmatch(_COURSE_ID, course_id) and type(slug) is str and
           len(slug) <= 120 and re.fullmatch(_COURSE_SLUG, slug), "P2_INTERACTIVE_LEARNING_COURSE_REQUIRED")
    return _observe_selected_protection(context, client, expected_profile, browser=True,
                                        paths=(f"/courses/{slug}", f"/academy/courses/{course_id}"))


def observe_paid_grant_protection(context, client, *, expected_profile, course_id):
    demand(type(course_id) is str and re.fullmatch(_COURSE_ID, course_id), "P2_INTERACTIVE_PAID_GRANT_COURSE_REQUIRED")
    return _observe_selected_protection(context, client, expected_profile, browser=True,
                                        paths=(f"/admin/courses/{course_id}/manual-grants",))


def observe_learner_access_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LEARNER_ACCESS_TARGET_REQUIRED")
    lesson = f"/api/academy/lessons/{lesson_id}"
    paths = (f"/academy/courses/{course_id}", f"/api/academy/courses/{course_id}", lesson, f"{lesson}/playback",
             f"/api/academy/progress?lessonId={lesson_id}", f"{lesson}/quiz", f"{lesson}/quiz/attempts")
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def observe_lesson_entry_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LESSON_ENTRY_TARGET_REQUIRED")
    course = f"/academy/courses/{course_id}"
    lesson = f"/api/academy/lessons/{lesson_id}"
    paths = (course, f"{course}/lessons/{lesson_id}", f"/api{course}", f"/api/academy/progress?courseId={course_id}",
             lesson, f"/api/academy/progress?lessonId={lesson_id}", f"{lesson}/quiz", f"{lesson}/quiz/attempts",
             f"{lesson}/playback", f"{lesson}/progress")
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def observe_lesson_denial_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LESSON_DENIAL_TARGET_REQUIRED")
    document = f"/academy/courses/{course_id}/lessons/{lesson_id}"
    lesson = f"/api/academy/lessons/{lesson_id}"
    paths = (document, f"{document}?_rsc", lesson, f"{lesson}/playback",
             f"/api/academy/progress?lessonId={lesson_id}", f"{lesson}/quiz", f"{lesson}/quiz/attempts")
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def observe_lesson_assessment_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LESSON_ASSESSMENT_TARGET_REQUIRED")
    document = f"/academy/courses/{course_id}/lessons/{lesson_id}"
    lesson = f"/api/academy/lessons/{lesson_id}"
    paths = (document, f"{lesson}/playback", f"/api/academy/progress?lessonId={lesson_id}", f"{lesson}/progress", f"{lesson}/quiz/attempts")
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def observe_lesson_resume_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LESSON_RESUME_TARGET_REQUIRED")
    document = f"/academy/courses/{course_id}/lessons/{lesson_id}"
    lesson = f"/api/academy/lessons/{lesson_id}"
    return _observe_selected_protection(context, client, expected_profile, browser=True,
                                       paths=(document, f"{lesson}/playback", f"{lesson}/progress"))


def observe_lesson_restore_protection(context, client, *, expected_profile, course_id, lesson_id):
    demand(all(type(value) is str and re.fullmatch(_COURSE_ID, value) for value in (course_id, lesson_id)),
           "P2_INTERACTIVE_LESSON_RESTORE_TARGET_REQUIRED")
    document = f"/academy/courses/{course_id}/lessons/{lesson_id}"
    lesson = f"/api/academy/lessons/{lesson_id}"
    paths = (document, f"{document}?_rsc", lesson, f"{lesson}/playback", f"/api/academy/progress?lessonId={lesson_id}",
             f"{lesson}/progress", f"{lesson}/quiz", f"{lesson}/quiz/attempts")
    return _observe_selected_protection(context, client, expected_profile, browser=True, paths=paths)


def _observe_selected_protection(context, client, expected_profile, *, browser, paths=None):
    expected = migrate.profile_context(expected_profile)
    demand(expected is not None, "QUALIFICATION_TARGET_PROFILE_REQUIRED")
    plan = native.identity(context, expected_profile=expected)
    demand(plan["projectId"] == canonical.PROJECT and plan["deploymentUrl"] != canonical.ORIGIN,
           "P2_INTERACTIVE_INGRESS_TARGET_REFUSED")
    metadata = native.observe_metadata(context, client, expected_profile=expected)
    demand(metadata["nativeEnabled"] is False, "P2_INTERACTIVE_NATIVE_MUST_BE_DISABLED")
    alias = canonical._alias(client, plan)
    before = vercel._project(client, canonical.PROJECT)
    protection = _protection(before)
    requester = UnauthenticatedIngressClient()
    observations = []
    for path in paths or (_BROWSER_PATHS if browser else ("/",)):
        alias_denial = requester.request(canonical.ORIGIN, path)
        deployment_denial = requester.request(plan["deploymentUrl"], path)
        demand(all(denial in ({"status": 401, "redirected": False}, {"status": 403, "redirected": False})
                   for denial in (alias_denial, deployment_denial)),
               "P2_INTERACTIVE_UNAUTHENTICATED_INGRESS_NOT_DENIED")
        observations.append({"path": path, "aliasUnauthenticatedStatus": alias_denial["status"],
                             "deploymentUnauthenticatedStatus": deployment_denial["status"]})
    after = vercel._project(client, canonical.PROJECT)
    demand(canonical._alias(client, plan) == alias and
           native.observe_metadata(context, client, expected_profile=expected) == metadata and
           _protection(after) == protection and
           after.get("protectionBypass") == before.get("protectionBypass"),
           "P2_INTERACTIVE_PROTECTION_CHANGED")
    result = {"version": 2, "qualificationTargetProfile": expected,
            "projectId": canonical.PROJECT, "deploymentId": plan["deploymentId"], "sourceCommit": plan["sourceCommit"],
            "releaseId": plan["actionId"], "candidateSha256": plan["candidateSha256"], **protection,
            "releaseAccepted": False, "trafficAuthorized": False}
    if browser:
        return {**result, "status": "P2_BROWSER_PROTECTION_OBSERVED", "environment": "staging",
                "browserOrigin": canonical.ORIGIN, "deploymentUrl": plan["deploymentUrl"],
                "requestMethod": "GET", "endpointDenials": observations, "redirectFollowed": False,
                "nativeEnabled": False, "automationBypassCustodyVerified": False,
                "interactiveNewWorkAuthorized": False}
    return {**result, "status": "P2_SELECTED_PROTECTION_OBSERVED",
            "aliasUnauthenticatedStatus": observations[0]["aliasUnauthenticatedStatus"],
            "deploymentUnauthenticatedStatus": observations[0]["deploymentUnauthenticatedStatus"]}
