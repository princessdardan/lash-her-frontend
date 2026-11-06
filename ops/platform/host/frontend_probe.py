"""Private release-only frontend workload probe; no CLI or cron-secret reads."""
import json
import os
import re
import secrets
import ssl
import time
import urllib.error
import urllib.request

import migrate
import vercel

LIFETIME_MS = 3_600_000
DEPLOYMENT_URL = re.compile(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app")
PRIVATE_FILE = "frontend-probe-private.json"
demand = migrate.demand
FEATURE_CONTROL_NAMES = (
    "INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
    "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
    "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
)


def valid_feature_controls(value):
    return isinstance(value, dict) and set(value) == set(FEATURE_CONTROL_NAMES) and all(type(item) is bool for item in value.values())


def _private_configuration(directory):
    migrate.private_directory(directory)
    demand(not any((parent / ".git").exists() for parent in (directory.resolve(), *directory.resolve().parents)),
           "PRIVATE_PROBE_OUTSIDE_CHECKOUT_REQUIRED")


def prepare(client, release, private_configuration, attempt, gateway_host, scheduler_qualification=False):
    """Called by the locked parent before its pinned frontend build.

    Use the existing project, not an additional secret service or operator
    credential. Keep the generated value in private configuration only. The
    provider and common outcome contain separate scoped metadata.
    """
    environment, project_id, commit = vercel.release_identity(release)
    demand(type(scheduler_qualification) is bool and (not scheduler_qualification or environment == "staging"),
           "SCHEDULER_QUALIFICATION_REQUIRES_STAGING")
    demand(isinstance(gateway_host, str) and re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", gateway_host), "FRONTEND_PROBE_GATEWAY_REFUSED")
    _private_configuration(private_configuration)
    migrate.private_directory(attempt)
    demand(private_configuration.resolve() != attempt.resolve(), "SEPARATE_PRIVATE_PROBE_CONFIGURATION_REQUIRED")
    before = vercel.project_state(client, project_id)
    demand(before["cronsEnabled"] is False, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
    identity = {"environment": environment, "projectId": project_id, "sourceCommit": commit, "releaseId": release["releaseId"]}
    expires = int(time.time() * 1000) + LIFETIME_MS
    private = {**identity, "secret": secrets.token_hex(32), "expiresAt": expires, "gatewayOrigin": "https://" + gateway_host}
    outcome = {**identity, "status": "FRONTEND_PROBE_PREPARATION_REQUIRES_REVIEW", "phase": "private-input",
               "expiresAt": expires, "trafficAuthorized": False, "cronSecretRead": False,
               "schedulerQualification": scheduler_qualification}
    # Durable private input precedes every provider mutation. Never include it
    # in the common receipts or print the returned provider environment data.
    migrate.write_json(private_configuration, PRIVATE_FILE, private)
    migrate.write_json(attempt, "frontend-probe-started.json", outcome)
    try:
        origin_name = "API_GATEWAY_PRODUCTION_ORIGIN" if environment == "production" else "API_GATEWAY_STAGING_ORIGIN"
        variables = [("LASH_RELEASE_PROBE_SECRET", private["secret"], "sensitive"),
                     ("LASH_RELEASE_PROBE_EXPIRES_AT", str(expires), "plain"),
                     ("LASH_RELEASE_SCHEDULER_QUALIFICATION", "true" if scheduler_qualification else "false", "plain"),
                     (origin_name, private["gatewayOrigin"], "plain")]
        for key, value, kind in variables:
            outcome["phase"] = "configure-probe"
            result = client.request("POST", f"/v10/projects/{project_id}/env?upsert=true", {
                "key": key, "value": value, "type": kind, "target": ["production"],
                "gitBranch": None, "customEnvironmentIds": [], "comment": "Managed frontend release probe " + release["releaseId"],
            })
            created = result.get("created")
            demand(result.get("failed") == [] and isinstance(created, dict) and created.get("key") == key
                   and created.get("target") == ["production"] and created.get("type") == kind
                   and not created.get("gitBranch") and not created.get("customEnvironmentIds"), "FRONTEND_PROBE_CONFIGURATION_UNVERIFIED")
        demand(vercel.project_state(client, project_id) == before, "VERCEL_PROJECT_CHANGED_DURING_PROBE_PREPARATION")
        outcome.update(status="FRONTEND_PROBE_CONFIGURED", phase="completed", configuredKeys=[item[0] for item in variables])
        return outcome
    except BaseException:
        raise ValueError("FRONTEND_PROBE_PREPARATION_FAILED_REVIEW_REQUIRED") from None
    finally:
        migrate.write_json(attempt, "frontend-probe-preparation.json", outcome)


def _private_input(directory, identity):
    _private_configuration(directory)
    info = (directory / PRIVATE_FILE).lstat()
    demand(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "PRIVATE_PROBE_CREDENTIAL_REQUIRED")
    value = json.loads(migrate.read_input(directory, PRIVATE_FILE, 8192))
    now = int(time.time() * 1000)
    demand(isinstance(value, dict) and all(value.get(key) == identity[key] for key in ("environment", "projectId", "sourceCommit", "releaseId"))
           and isinstance(value.get("secret"), str) and re.fullmatch(r"[a-f0-9]{64}", value["secret"])
           and isinstance(value.get("gatewayOrigin"), str) and re.fullmatch(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)+", value["gatewayOrigin"])
           and type(value.get("expiresAt")) is int and now < value["expiresAt"] <= now + LIFETIME_MS,
           "FRONTEND_PROBE_PRIVATE_BINDING_REFUSED")
    return value


class ProbeClient:
    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
                                                  urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, url, secret, bypass, challenge, mode=None):
        demand(isinstance(url, str) and DEPLOYMENT_URL.fullmatch(url), "FRONTEND_PROBE_ORIGIN_REFUSED")
        demand(mode in (None, "admission-bootstrap", "resend-binding", "square-binding", "google-binding", "phase2"), "FRONTEND_PROBE_MODE_REFUSED")
        request = urllib.request.Request(url + "/api/internal/release-probe", method="GET", headers={
            "Authorization": "Bearer " + secret, "x-vercel-protection-bypass": bypass,
            "x-lash-release-challenge": challenge, "Accept": "application/json", "Cache-Control": "no-cache",
            **({"x-lash-release-mode": mode} if mode is not None else {}),
        })
        try:
            with self._opener.open(request, timeout=20) as response:
                demand(response.status == 200 and response.headers.get_content_type() == "application/json"
                       and "no-store" in response.headers.get("Cache-Control", "").lower(), "FRONTEND_PROBE_RESPONSE_REFUSED")
                raw = response.read(65_537)
                demand(len(raw) <= 65_536, "FRONTEND_PROBE_RESPONSE_TOO_LARGE")
                result = json.loads(raw)
                demand(isinstance(result, dict), "FRONTEND_PROBE_RESPONSE_REFUSED")
                return result
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("FRONTEND_PROBE_REQUEST_FAILED") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("FRONTEND_PROBE_REQUEST_FAILED") from None


def _automation_bypass(project):
    bypasses = project.get("protectionBypass")
    demand(isinstance(bypasses, dict), "FRONTEND_PROBE_PROTECTION_ACCESS_REQUIRED")
    bypass = next((key for key, value in bypasses.items() if isinstance(value, dict) and value.get("scope") == "automation-bypass"
                   and isinstance(key, str) and 0 < len(key) <= 8192 and all(32 < ord(c) < 127 for c in key)), None)
    demand(bypass is not None, "FRONTEND_PROBE_PROTECTION_ACCESS_REQUIRED")
    return bypass


def verify(client, release, attempt, private_configuration, probe_client=None, expected_feature_controls=None):
    """A real HTTP callback for promote_frontend, not a success-file input.

    The selected deployment must execute its server-only SDK transport and
    validate the gateway's Course catalog response. Native scheduling and full
    release acceptance remain independent checks.
    """
    identity = vercel._staged_identity(release, attempt)
    outcome = {**identity, "status": "FRONTEND_VERIFICATION_REQUIRES_REVIEW", "phase": "deployment-binding",
               "trafficAuthorized": False, "nativeSchedulerVerified": False}
    try:
        phase2 = "contractPhase" in release or "phase2ContractManifestSha256" in release
        demand((not phase2 and expected_feature_controls is None) or (phase2 and valid_feature_controls(expected_feature_controls)),
               "FRONTEND_FEATURE_PROFILE_REFUSED")
        demand(not phase2 or (release.get("contractPhase") == "p2"
               and isinstance(release.get("phase2ContractManifestSha256"), str)
               and re.fullmatch(r"sha256:[a-f0-9]{64}", release["phase2ContractManifestSha256"])
               and release["phase2ContractManifestSha256"] != "sha256:" + "0" * 64
               and identity["environment"] == "staging"), "FRONTEND_PHASE2_PROBE_BINDING_REQUIRED")
        state = vercel.deployment_state(client, identity["deploymentId"], identity["projectId"], identity["sourceCommit"], identity["releaseId"])
        demand(state["readyState"] == "READY", "VERCEL_PROMOTION_DEPLOYMENT_NOT_READY")
        private = _private_input(private_configuration, identity)
        project = vercel._project(client, identity["projectId"])
        demand((project.get("targets") or {}).get("production", {}).get("id") == identity["previousDeploymentId"]
               and (project.get("crons") or {}).get("disabledAt") is not None, "FRONTEND_PROBE_PROJECT_CHANGED")
        bypass = _automation_bypass(project)
        outcome["phase"] = "workload-request"
        challenge = secrets.token_hex(32)
        requester = probe_client or ProbeClient()
        observed = requester.request(state["url"], private["secret"], bypass, challenge, mode="phase2") if phase2 else requester.request(state["url"], private["secret"], bypass, challenge)
        demand(type(observed.get("version")) is int and observed["version"] == 1 and observed.get("status") == "FRONTEND_WORKLOAD_PROBE_PASS"
               and observed.get("challenge") == challenge and observed.get("checks") == ["gateway-course-catalog-p2" if phase2 else "gateway-course-catalog"]
               and (not phase2 or (observed.get("contractPhase") == "p2" and valid_feature_controls(observed.get("featureControls"))
                   and observed["featureControls"] == expected_feature_controls))
               and observed.get("gatewayOrigin") == private.get("gatewayOrigin")
               and all(observed.get(key) == identity[key] for key in ("environment", "projectId", "sourceCommit"))
               and int(time.time() * 1000) < private["expiresAt"], "FRONTEND_WORKLOAD_PROBE_UNVERIFIED")
        outcome.update(status="FRONTEND_VERIFIED", phase="completed", checks=["frontend-server-gateway-course-catalog-p2" if phase2 else "frontend-server-gateway-course-catalog"])
        if phase2:
            outcome.update(contractPhase="p2", phase2ContractManifestSha256=release["phase2ContractManifestSha256"],
                           featureControls=observed["featureControls"])
        return outcome
    except BaseException:
        raise ValueError("FRONTEND_WORKLOAD_VERIFICATION_FAILED") from None
    finally:
        migrate.write_json(attempt, "frontend-workload-outcome.json", outcome)
