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
        demand(type(path) is str and path in _BROWSER_PATHS, "P2_INTERACTIVE_INGRESS_PATH_REFUSED")
        url = origin + path
        request = urllib.request.Request(url, method="GET", headers={
            "accept": "text/html,application/xhtml+xml", "cache-control": "no-cache"})
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


def _observe_selected_protection(context, client, expected_profile, *, browser):
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
    for path in _BROWSER_PATHS if browser else ("/",):
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
