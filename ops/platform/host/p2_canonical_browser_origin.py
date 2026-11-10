"""Source-parent-only fixed staging alias and protected workload observation.

No alias assignment, arbitrary origin, Host override, probe renewal, or standalone
apply. The legacy probe keeps its one-hour credential. The profiled day-two
observer shares only the fixed alias readback and public receipt projection.
"""
import datetime
import hashlib
import json
import secrets
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import frontend_probe
import migrate
import p2_lifecycle_native as native
import vercel

ORIGIN = "https://staging.lashher.com"
HOST = "staging.lashher.com"
PROJECT = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM"
AUTHENTICATION_ORIGINS = {"customerOrigin": ORIGIN, "adminOrigin": ORIGIN, "adminRedirectProxyOrigin": None, "customerRedirectProxyEnabled": False}
demand = migrate.demand


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


class CanonicalBrowserProbeClient:
    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, url, secret, bypass, challenge):
        demand(url == ORIGIN and isinstance(secret, str) and isinstance(bypass, str)
            and isinstance(challenge, str) and len(challenge) == 64, "P2_CANONICAL_PROBE_FIXED_ORIGIN_REQUIRED")
        request = urllib.request.Request(ORIGIN+"/api/internal/release-probe", method="GET", headers={
            "authorization": "Bearer "+secret, "x-vercel-protection-bypass": bypass,
            "x-lash-release-challenge": challenge, "x-lash-release-mode": "phase2-auth-origins", "accept": "application/json", "cache-control": "no-cache"})
        try:
            with self._opener.open(request, timeout=20) as response:
                demand(response.status == 200 and response.headers.get_content_type() == "application/json"
                    and all(value in response.headers.get("cache-control", "").lower() for value in ("private", "no-store")), "P2_CANONICAL_PROBE_RESPONSE_REFUSED")
                raw = response.read(65537)
                demand(0 < len(raw) <= 65536, "P2_CANONICAL_PROBE_RESPONSE_BOUND")
                result = json.loads(raw)
                demand(isinstance(result, dict), "P2_CANONICAL_PROBE_RESPONSE_REFUSED")
                return result
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("P2_CANONICAL_WORKLOAD_REQUEST_FAILED") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("P2_CANONICAL_WORKLOAD_REQUEST_FAILED") from None


def _alias(client, plan):
    # Official GET /v4/aliases/{idOrAlias}: required alias/projectId/deploymentId.
    # Read the single approved hostname, never list/select a caller's alias.
    value = client.request("GET", "/v4/aliases/"+HOST+"?projectId="+PROJECT)
    demand(value.get("alias") == HOST and value.get("projectId") == PROJECT and value.get("deploymentId") == plan["deploymentId"]
        and value.get("deletedAt") is None and value.get("redirect") in (None, "")
        and value.get("redirectStatusCode") is None and value.get("microfrontends") is None,
        "P2_CANONICAL_ALIAS_BINDING_REFUSED")
    deployed = value.get("deployment")
    demand(deployed is None or isinstance(deployed, dict) and deployed.get("id") == plan["deploymentId"]
        and deployed.get("url") == plan["deploymentUrl"].removeprefix("https://"), "P2_CANONICAL_ALIAS_DEPLOYMENT_REFUSED")
    return {"alias": HOST, "projectId": PROJECT, "deploymentId": plan["deploymentId"],
        "redirect": False, "deleted": False, "microfrontends": False}


def observe(context, client, probe=None, *, expected_profile=None):
    expected = migrate.profile_context(expected_profile)
    plan = native.identity(context, expected_profile=expected)
    candidate = context["candidate"]
    demand(plan["projectId"] == PROJECT and context.get("configurationRecordSha256") == plan["configurationRecordSha256"],
        "P2_CANONICAL_REVIEWED_CONFIGURATION_REQUIRED")
    before = native.observe_metadata(context, client, expected_profile=expected)
    demand(before.get("nativeEnabled") is False, "P2_CANONICAL_NATIVE_MUST_BE_DISABLED")
    alias = _alias(client, plan)
    private_identity = {**vercel.profile_fields(candidate, expected), "environment": "staging",
                        "projectId": PROJECT, "sourceCommit": plan["sourceCommit"],
                        "releaseId": plan["actionId"]}
    private = frontend_probe._private_input(Path(context["privateProbeDirectory"]), private_identity,
                                            expected_profile=expected)
    project = vercel._project(client, PROJECT)
    challenge = secrets.token_hex(32)
    result = (probe or CanonicalBrowserProbeClient()).request(ORIGIN, private["secret"], frontend_probe._automation_bypass(project), challenge)
    demand(result.get("version") == 1 and result.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS" and result.get("challenge") == challenge
        and result.get("environment") == "staging" and result.get("projectId") == PROJECT and result.get("sourceCommit") == plan["sourceCommit"]
        and result.get("contractPhase") == "p2" and result.get("gatewayOrigin") == private["gatewayOrigin"]
        and result.get("checks") == ["gateway-course-catalog-p2"]
        and isinstance(result.get("authenticationOrigins"), dict) and result["authenticationOrigins"] == AUTHENTICATION_ORIGINS
        and result["authenticationOrigins"].get("customerRedirectProxyEnabled") is False
        and frontend_probe.valid_feature_controls(result.get("featureControls")) and result["featureControls"] == plan["featureControls"]
        and frontend_probe.valid_writer_admission_binding(result.get("writerAdmissionBinding")) and result["writerAdmissionBinding"] == plan["writerAdmissionBinding"],
        "P2_CANONICAL_WORKLOAD_BINDING_REFUSED")
    demand(_alias(client, plan) == alias
           and native.observe_metadata(context, client, expected_profile=expected) == before,
           "P2_CANONICAL_PROVIDER_CHANGED")
    # Re-read the existing private input at the final boundary; never extend it.
    final_private = frontend_probe._private_input(Path(context["privateProbeDirectory"]), private_identity,
                                                  expected_profile=expected)
    demand(final_private == private, "P2_CANONICAL_PRIVATE_INPUT_CHANGED")
    return _receipt(candidate, plan, result, alias, expected)


def _receipt(candidate, plan, result, alias, expected):
    profile_fields = ({} if expected is None else
                      {**vercel.profile_fields(candidate, expected), "candidateSha256": plan["candidateSha256"],
                       "phase2ContractManifestSha256": candidate["phase2ContractManifestSha256"]})
    return {**profile_fields, "version": 2 if expected is not None else 1,
        "status": "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED", "environment": "staging", "browserOrigin": ORIGIN,
        "projectId": PROJECT, "deploymentId": plan["deploymentId"], "deploymentUrl": plan["deploymentUrl"], "sourceCommit": plan["sourceCommit"],
        "releaseId": plan["actionId"], "configurationRecordSha256": plan["configurationRecordSha256"],
        "featureControls": result["featureControls"], "writerAdmissionBinding": result["writerAdmissionBinding"],
        "authenticationOrigins": result["authenticationOrigins"],
        "aliasReadbackSha256": _digest(alias), "protectedWorkloadSha256": _digest(result), "aliasReadbacks": 2,
        "aliasRedirect": False, "workloadChallengeVerified": True, "tlsVerified": True, "probeExpiryExtended": False,
        "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "releaseAccepted": False}
