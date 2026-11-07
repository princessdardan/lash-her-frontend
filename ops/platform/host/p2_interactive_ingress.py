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

    def request(self, origin):
        demand(type(origin) is str and (origin == canonical.ORIGIN or _DIRECT_DEPLOYMENT.fullmatch(origin)),
               "P2_INTERACTIVE_INGRESS_ORIGIN_REFUSED")
        url = origin + "/"
        request = urllib.request.Request(url, method="GET", headers={
            "accept": "text/html,application/xhtml+xml", "cache-control": "no-cache"})
        try:
            with self._opener.open(request, timeout=20) as response:
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
