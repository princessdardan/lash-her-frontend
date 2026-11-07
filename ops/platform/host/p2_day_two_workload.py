"""Read-only workload observation for the existing profiled staging deployment."""

import copy
import http.client
import re
import secrets
import ssl
import urllib.error
import urllib.request

import frontend_probe
from frontend_release_adapters import LockedClient, LockedProbe
import migrate
import p2_canonical_browser_origin as canonical
import p2_lifecycle_native as native
from qualification_target_profile import decode_qualification_target_json, resolve_qualification_target_profile
import vercel


_PATH = "/api/internal/release-probe"
_MODE = "phase2-day-two-workload"
_MAX_BODY = 65_536
_CHECK = "gateway-course-catalog-p2"
_FIELDS = {
    "version", "status", "challenge", "environment", "projectId", "sourceCommit", "gatewayOrigin",
    "checks", "durationMs", "contractPhase", "featureControls", "writerAdmissionBinding",
}
_SHA = re.compile(r"[a-f0-9]{64}")
demand = migrate.demand


def _bearer(value):
    demand(isinstance(value, str) and 0 < len(value) <= 8192, "P2_DAY_TWO_CRON_BEARER_REQUIRED")
    value = value.strip()
    demand(bool(value) and all(32 < ord(char) < 127 for char in value), "P2_DAY_TWO_CRON_BEARER_REQUIRED")
    return value


class _WorkloadProbe:
    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, url, bearer, bypass, challenge):
        demand(isinstance(url, str) and frontend_probe.DEPLOYMENT_URL.fullmatch(url), "P2_DAY_TWO_FIXED_ORIGIN_REQUIRED")
        request = urllib.request.Request(url + _PATH, method="GET", headers={
            "Authorization": "Bearer " + bearer, "X-Vercel-Protection-Bypass": bypass,
            "X-Lash-Release-Mode": _MODE, "X-Lash-Release-Challenge": challenge,
            "Accept": "application/json", "Cache-Control": "no-cache",
        })
        try:
            with self._opener.open(request, timeout=20) as response:
                headers = response.headers
                cache = headers.get_all("Cache-Control", [])
                directives = sorted(item.strip().lower() for item in cache[0].split(",")) if len(cache) == 1 else []
                demand(response.status == 200 and len(headers.get_all("Content-Type", [])) == 1 and
                    headers.get_content_type() == "application/json" and headers.get_content_charset() in (None, "utf-8") and
                    directives == ["no-store", "private"] and not headers.get_all("Set-Cookie") and
                    headers.get_all("Content-Encoding", []) in ([], ["identity"]), "P2_DAY_TWO_WORKLOAD_RESPONSE_REFUSED")
                length = headers.get_all("Content-Length", [])
                demand(not length or len(length) == 1 and re.fullmatch(r"[0-9]{1,5}", length[0]) and
                    0 < int(length[0]) <= _MAX_BODY, "P2_DAY_TWO_WORKLOAD_RESPONSE_BOUND")
                raw = response.read(_MAX_BODY + 1)
                demand(0 < len(raw) <= _MAX_BODY and (not length or len(raw) == int(length[0])),
                    "P2_DAY_TWO_WORKLOAD_RESPONSE_BOUND")
                return decode_qualification_target_json(raw, "carrier")
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("P2_DAY_TWO_WORKLOAD_REQUEST_FAILED") from None
        except (OSError, ValueError, http.client.HTTPException):
            raise ValueError("P2_DAY_TWO_WORKLOAD_REQUEST_FAILED") from None


def observe(context, client, cron_secret, *, expected_profile):
    """Challenge the immutable deployment while the parent keeps its guard held."""
    expected = migrate.profile_context(expected_profile)
    demand(expected is not None, "QUALIFICATION_TARGET_PROFILE_REQUIRED")
    demand(isinstance(client, LockedClient) and callable(client.verify), "P2_DAY_TWO_GUARDED_CLIENT_REQUIRED")
    bearer = _bearer(cron_secret)
    demand(type(context) is dict and type(context.get("candidate")) is dict and type(context.get("plan")) is dict,
        "P2_DAY_TWO_WORKLOAD_CONTEXT_REQUIRED")
    selected = {key: copy.deepcopy(context.get(key)) for key in ("candidate", "plan", "configurationRecordSha256")}
    plan = native.identity(selected, expected_profile=expected)
    candidate = selected["candidate"]
    contract = migrate.contract_identity(candidate)
    definition = resolve_qualification_target_profile(expected)
    gateway = definition["gateway"]["publicOrigin"]
    binding, controls = plan.get("writerAdmissionBinding"), plan.get("featureControls")
    configuration = selected["configurationRecordSha256"]
    producer = plan.get("producer")
    demand(plan.get("projectId") == canonical.PROJECT and isinstance(plan.get("deploymentUrl"), str) and
        frontend_probe.DEPLOYMENT_URL.fullmatch(plan["deploymentUrl"]) and isinstance(configuration, str) and
        _SHA.fullmatch(configuration) and configuration != "0" * 64 and configuration == plan.get("configurationRecordSha256") and
        frontend_probe.valid_feature_controls(controls) and frontend_probe.valid_writer_admission_binding(binding) and
        binding["sourceCommit"] == plan["sourceCommit"] and binding["targetSha256"] == plan.get("targetSha256") and
        type(producer) is dict and type(producer.get("role")) is dict and
        binding["producerSha256"] == producer.get("producerSha256") and binding["roleName"] == producer["role"].get("name"),
        "P2_DAY_TWO_WORKLOAD_PLAN_REFUSED")

    before = native.observe_metadata(selected, client, expected_profile=expected)
    demand(before["nativeEnabled"] is False, "P2_DAY_TWO_NATIVE_MUST_BE_DISABLED")
    project = vercel._project(client, plan["projectId"])
    target = (project.get("targets") or {}).get("production") or {}
    demand(target.get("id") == plan["deploymentId"] and (project.get("crons") or {}).get("disabledAt") is not None,
        "P2_DAY_TWO_PROVIDER_CHANGED")
    bypass = frontend_probe._automation_bypass(project)
    alias = canonical._alias(client, plan)
    challenge = secrets.token_hex(32)
    result = LockedProbe(client.verify, _WorkloadProbe()).request(before["deploymentUrl"], bearer, bypass, challenge)
    demand(type(result) is dict and set(result) == _FIELDS and type(result["version"]) is int and result["version"] == 1 and
        result["status"] == "FRONTEND_WORKLOAD_PROBE_PASS" and result["challenge"] == challenge and
        result["environment"] == "staging" and result["projectId"] == plan["projectId"] and
        result["sourceCommit"] == plan["sourceCommit"] and result["gatewayOrigin"] == gateway and
        result["checks"] == [_CHECK] and result["contractPhase"] == "p2" and
        type(result["durationMs"]) is int and 0 <= result["durationMs"] <= 2**53 - 1 and
        frontend_probe.valid_feature_controls(result["featureControls"]) and result["featureControls"] == controls and
        frontend_probe.valid_writer_admission_binding(result["writerAdmissionBinding"]) and result["writerAdmissionBinding"] == binding,
        "P2_DAY_TWO_WORKLOAD_BINDING_REFUSED")
    demand(canonical._alias(client, plan) == alias and native.observe_metadata(selected, client, expected_profile=expected) == before,
        "P2_DAY_TWO_PROVIDER_CHANGED")

    metadata = {key: before[key] for key in (
        "version", "qualificationTargetProfile", "environment", "releaseId", "candidateSha256", "projectId", "deploymentId",
        "deploymentUrl", "sourceCommit", "schedule", "nativeEnabled", "providerQueuedInvocations", "providerActiveInvocations",
        "cancellationVerified",
    )}
    return {
        **metadata, **contract, "status": "P2_DAY_TWO_WORKLOAD_OBSERVED", "configurationRecordSha256": configuration,
        "gatewayOrigin": gateway, "checks": [_CHECK], "featureControls": controls, "writerAdmissionBinding": binding,
        "durationMs": result["durationMs"], "aliasReadbacks": 2, "workloadChallengeVerified": True,
        "tlsVerified": True, "readOnly": True, "releaseAccepted": False,
    }
