"""Private provider operations for the reviewed parent release coordinator.

No CLI or ambient credentials: the parent supplies its private runtime token.
Staging a build never authorizes traffic, promotion or database migration.
"""
import json
import re
import ssl
import time
import urllib.error
import urllib.request

import migrate

TEAM = "team_2Hrn5eMZyZxfAWdmYvyKi9t3"
PROJECTS = {"staging": "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", "production": "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy"}
REPOSITORY_ID = "1114139712"
API_ORIGIN = "https://api.vercel.com"
MAX_RESPONSE = 2_000_000
demand = migrate.demand


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class Client:
    def __init__(self, token):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token), "VERCEL_PRIVATE_TOKEN_REQUIRED")
        self._token = token
        # No ambient proxy, alternate API URL, disabled TLS or redirect can
        # forward this token to a different host. Never serialize this object.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                                  urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        staging_env_delete = (re.fullmatch(rf"/v9/projects/{PROJECTS['staging']}/env/([A-Za-z0-9_-]{{1,128}})", path)
                              if method == "DELETE" and body is None and isinstance(path, str) else None)
        demand((method in ("GET", "POST", "PATCH") or method == "DELETE" and body is None and
                isinstance(path, str) and (staging_env_delete or re.fullmatch(r"/v13/deployments/dpl_[A-Za-z0-9]+", path))) and isinstance(path, str)
               and re.fullmatch(r"/v[0-9]+/[A-Za-z0-9_/?=&.-]+", path), "VERCEL_REQUEST_REFUSED")
        separator = "&" if "?" in path else "?"
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(API_ORIGIN + path + separator + "teamId=" + TEAM, data=data, method=method,
                    headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=30) as response:
                demand(200 <= response.status < 300, "VERCEL_RESPONSE_REFUSED")
                raw = response.read(MAX_RESPONSE + 1)
                demand(len(raw) <= MAX_RESPONSE, "VERCEL_RESPONSE_TOO_LARGE")
                # Promotion's documented 201/202 acknowledgement has no body.
                # It only starts observation; it is never proof of promotion.
                # All other responses still require a bounded JSON object.
                if (not raw and method == "POST" and response.status in (201, 202)
                        and any(re.fullmatch(rf"/v10/projects/{project}/promote/dpl_[A-Za-z0-9]+", path)
                                for project in PROJECTS.values())):
                    return {}
                value = json.loads(raw)
                if staging_env_delete:
                    # Vercel documents both an object and an array. A reviewed
                    # ID selects one record and only its metadata leaves here.
                    removed = value if isinstance(value, list) else [value]
                    demand(response.status == 200 and len(removed) == 1 and isinstance(removed[0], dict) and
                           removed[0].get("id") == staging_env_delete[1] and isinstance(removed[0].get("key"), str) and
                           re.fullmatch(r"[A-Z][A-Z0-9_]*", removed[0]["key"]), "VERCEL_ENV_DELETE_ACK_REFUSED")
                    return {"id": removed[0]["id"], "key": removed[0]["key"]}
                demand(isinstance(value, dict), "VERCEL_RESPONSE_REFUSED")
                return value
        except urllib.error.HTTPError as error:
            error.close()
            raise ValueError("VERCEL_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            # Provider error bodies, URLs and exception strings can contain
            # credentials. Do not include them in common receipts or logs.
            raise ValueError("VERCEL_REQUEST_FAILED_REQUIRES_REVIEW") from None


def profile_fields(release, expected_profile=None):
    """Only an explicit fixed source argument selects the current profile."""
    expected = migrate.profile_context(expected_profile)
    migrate.candidate_profile(release, expected)
    return {} if expected is None else {"version": 2, "qualificationTargetProfile": expected}


def require_record_profile(expected_profile, *records):
    expected = migrate.profile_context(expected_profile)
    migrate.require_profile(expected, *records)
    if expected is not None:
        demand(all(type(row.get("version")) is int and row["version"] == 2 for row in records),
               "QUALIFICATION_TARGET_PROFILE_REQUIRED")


def release_identity(release, *, expected_profile=None):
    fields = profile_fields(release, expected_profile)
    environment = release.get("environment")
    demand(environment in PROJECTS and release.get("version") == (3 if fields else 2)
           and release.get("workload", {}).get("projectId") == PROJECTS[environment]
           and release.get("workload", {}).get("environment") == "production", "VERCEL_RELEASE_TARGET_REFUSED")
    source = release.get("sources", {}).get("frontend", {})
    commit = source.get("commit", "")
    demand(source.get("repository") == "https://github.com/princessdardan/lash-her-frontend.git"
           and source.get("requiredChecks") == "passed" and isinstance(commit, str)
           and re.fullmatch(r"[a-f0-9]{40}", commit) and commit != "0" * 40
           and isinstance(release.get("releaseId"), str)
           and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", release["releaseId"]), "VERCEL_RELEASE_SOURCE_REFUSED")
    return environment, PROJECTS[environment], commit


def _project(client, project_id, rollback_info=False):
    demand(project_id in PROJECTS.values(), "VERCEL_PROJECT_REFUSED")
    suffix = "?rollbackInfo=true" if rollback_info else ""
    value = client.request("GET", f"/v9/projects/{project_id}{suffix}")
    link = value.get("link") or {}
    demand(value.get("id") == project_id and value.get("accountId") == TEAM
           and isinstance(link, dict) and link.get("type") == "github" and str(link.get("repoId")) == REPOSITORY_ID,
           "VERCEL_PROJECT_IDENTITY_REFUSED")
    targets = value.get("targets") or {}
    demand(isinstance(targets, dict), "VERCEL_PRODUCTION_TARGET_REFUSED")
    current = targets.get("production")
    demand(current is None or isinstance(current, dict), "VERCEL_PRODUCTION_TARGET_REFUSED")
    current_id = None if current is None else current.get("id")
    demand(current_id is None or isinstance(current_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", current_id), "VERCEL_PRODUCTION_TARGET_REFUSED")
    cron = value.get("crons")
    demand(cron is None or isinstance(cron, dict), "VERCEL_CRON_STATE_REFUSED")
    disabled = None if cron is None else cron.get("disabledAt")
    demand(disabled is None or type(disabled) is int and disabled > 0, "VERCEL_CRON_STATE_REFUSED")
    return value


def project_state(client, project_id):
    value = _project(client, project_id)
    current = (value.get("targets") or {}).get("production")
    disabled = (value.get("crons") or {}).get("disabledAt")
    # Deliberately omit env, protection bypasses, git credentials and provider
    # metadata from the returned state. No API response is written to disk.
    return {"projectId": project_id, "productionDeploymentId": None if current is None else current.get("id"),
            "cronsEnabled": disabled is None}


def disable_schedules(client, release, *, expected_profile=None):
    environment, project_id, _commit = release_identity(release, expected_profile=expected_profile)
    before = project_state(client, project_id)
    if before["cronsEnabled"]:
        client.request("PATCH", f"/v1/projects/{project_id}/crons", {"enabled": False})
    after = project_state(client, project_id)
    demand(after["cronsEnabled"] is False and after["productionDeploymentId"] == before["productionDeploymentId"],
           "VERCEL_CRON_DISABLE_UNVERIFIED")
    # Cancelling future schedules does not establish termination/draining of
    # running invocations, callbacks, old deployment URLs or other writers.
    return {**profile_fields(release, expected_profile), "status": "NATIVE_SCHEDULES_DISABLED", "environment": environment, "projectId": project_id,
            "previouslyEnabled": before["cronsEnabled"], "frontendQuiescenceVerified": False}


def deployment_state(client, deployment_id, project_id, commit, release_id):
    demand(isinstance(deployment_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id), "VERCEL_DEPLOYMENT_ID_REFUSED")
    value = client.request("GET", f"/v13/deployments/{deployment_id}?withGitRepoInfo=true")
    source = value.get("gitSource") or {}
    meta = value.get("meta") or {}
    url = value.get("url")
    demand(value.get("id") == deployment_id and value.get("projectId") == project_id
           and value.get("target") == "production" and isinstance(source, dict) and source.get("type") == "github"
           and str(source.get("repoId")) == REPOSITORY_ID and source.get("sha") == commit
           and isinstance(meta, dict) and meta.get("lashReleaseId") == release_id
           and isinstance(url, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*\.vercel\.app", url), "VERCEL_DEPLOYMENT_BINDING_REFUSED")
    state = value.get("readyState")
    demand(state in ("QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED"), "VERCEL_DEPLOYMENT_STATE_REFUSED")
    return {"deploymentId": deployment_id, "projectId": project_id, "sourceCommit": commit,
            "url": "https://" + url, "readyState": state}


def stage_frontend(client, release, attempt, timeout=900, *, expected_profile=None):
    """Remote build from pinned Git source; preserve the current production target.

    Call only after the parent's locked migrations/runtime checks. This is an
    in-process component, not an independently approved deployment entrypoint.
    A failed or ambiguous POST is never automatically repeated.
    """
    environment, project_id, commit = release_identity(release, expected_profile=expected_profile)
    demand(type(timeout) is int and 1 <= timeout <= 1800, "VERCEL_BUILD_TIMEOUT_REFUSED")
    migrate.private_directory(attempt)
    before = project_state(client, project_id)
    demand(before["cronsEnabled"] is False, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
    intent = {**profile_fields(release, expected_profile), "environment": environment, "projectId": project_id, "sourceCommit": commit,
              "releaseId": release["releaseId"], "previousDeploymentId": before["productionDeploymentId"],
              "trafficAuthorized": False, "promotionAuthorized": False}
    # Exclusive durable intent precedes the network mutation. A timeout or
    # lost POST response requires inventory/reconciliation, not another build.
    migrate.write_json(attempt, "frontend-build-started.json", intent)
    outcome = {**intent, "status": "FRONTEND_BUILD_FAILED_REQUIRES_REVIEW", "phase": "create"}
    try:
        created = client.request("POST", "/v13/deployments", {
            "name": "lash-her-frontend-staging" if environment == "staging" else "lash-her-frontend",
            "project": project_id, "target": "production", "autoAssignCustomDomains": False,
            "gitSource": {"type": "github", "repoId": REPOSITORY_ID, "ref": "staging" if environment == "staging" else "main", "sha": commit},
            "meta": {"lashReleaseId": release["releaseId"]},
        })
        deployment_id = created.get("id")
        demand(isinstance(deployment_id, str) and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id), "VERCEL_DEPLOYMENT_ID_REFUSED")
        outcome["deploymentId"] = deployment_id
        migrate.write_json(attempt, "frontend-build-created.json", {**intent, "deploymentId": deployment_id})
        deadline = time.monotonic() + timeout
        outcome["phase"] = "build"
        while True:
            state = deployment_state(client, deployment_id, project_id, commit, release["releaseId"])
            demand(state["readyState"] not in ("ERROR", "CANCELED"), "VERCEL_BUILD_FAILED_REQUIRES_REVIEW")
            # Detect provider drift or an unrelated promotion before declaring
            # this build staged. Never silently roll back somebody else's work.
            current = project_state(client, project_id)
            demand(current == {**before, "cronsEnabled": False}, "VERCEL_PROJECT_CHANGED_DURING_BUILD")
            if state["readyState"] == "READY":
                outcome.update(state)
                outcome["status"], outcome["phase"] = "FRONTEND_STAGED", "completed"
                return outcome
            demand(time.monotonic() < deadline, "VERCEL_BUILD_OBSERVATION_TIMED_OUT")
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "VERCEL_BUILD_FAILURE"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(attempt, "frontend-build-outcome.json", outcome)


def promotion_state(client, project_id):
    """Selected provider job state; never return raw project/environment data."""
    # The provider omits lastAliasRequest unless rollbackInfo is requested.
    value = _project(client, project_id, rollback_info=True)
    rolling = value.get("rollingRelease")
    demand(rolling is None or isinstance(rolling, dict) and rolling.get("enabled") is False,
           "VERCEL_ROLLING_RELEASE_REQUIRES_REVIEW")
    job = value.get("lastAliasRequest")
    demand(job is None or isinstance(job, dict), "VERCEL_ALIAS_JOB_REFUSED")
    if job is not None:
        demand(job.get("jobStatus") in ("pending", "in-progress", "succeeded", "failed", "skipped")
               and type(job.get("requestedAt")) is int and job["requestedAt"] > 0
               and isinstance(job.get("toDeploymentId"), str)
               and re.fullmatch(r"dpl_[A-Za-z0-9]+", job["toDeploymentId"])
               and job.get("type") in ("promote", "rollback"), "VERCEL_ALIAS_JOB_REFUSED")
    current = (value.get("targets") or {}).get("production")
    return {"projectId": project_id, "productionDeploymentId": None if current is None else current.get("id"),
            "cronsEnabled": (value.get("crons") or {}).get("disabledAt") is None,
            "aliasJob": None if job is None else {key: job[key] for key in ("jobStatus", "requestedAt", "toDeploymentId", "type")}}


def _staged_identity(release, attempt, *, expected_profile=None):
    environment, project_id, commit = release_identity(release, expected_profile=expected_profile)
    staged = migrate.read_json(attempt, "frontend-build-outcome.json")
    require_record_profile(expected_profile, staged)
    demand(isinstance(staged, dict) and staged.get("status") == "FRONTEND_STAGED" and staged.get("readyState") == "READY"
           and staged.get("environment") == environment and staged.get("projectId") == project_id
           and staged.get("sourceCommit") == commit and staged.get("releaseId") == release["releaseId"]
           and staged.get("trafficAuthorized") is False and staged.get("promotionAuthorized") is False
           and isinstance(staged.get("deploymentId"), str)
           and re.fullmatch(r"dpl_[A-Za-z0-9]+", staged["deploymentId"])
           and (staged.get("previousDeploymentId") is None or isinstance(staged["previousDeploymentId"], str)
                and re.fullmatch(r"dpl_[A-Za-z0-9]+", staged["previousDeploymentId"]))
           and staged["deploymentId"] != staged.get("previousDeploymentId"), "VERCEL_STAGED_BUILD_REQUIRED")
    return {**profile_fields(release, expected_profile),
            **{key: staged.get(key) for key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId", "previousDeploymentId")}}


def _observe_promotion(client, release, attempt, intent, timeout, *, expected_profile=None):
    release_identity(release, expected_profile=expected_profile)
    require_record_profile(expected_profile, intent)
    outcome = {**intent, "status": "FRONTEND_PROMOTION_REQUIRES_REVIEW", "phase": "observe",
               "trafficAuthorized": False, "gatewayTrafficAuthorized": False, "frontendDomainsPromoted": None}
    try:
        deadline = time.monotonic() + timeout
        while True:
            deployment = deployment_state(client, intent["deploymentId"], intent["projectId"], intent["sourceCommit"], intent["releaseId"])
            demand(deployment["readyState"] == "READY", "VERCEL_PROMOTION_DEPLOYMENT_NOT_READY")
            current = promotion_state(client, intent["projectId"])
            demand(current["cronsEnabled"] is False, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
            demand(current["productionDeploymentId"] in (intent["previousDeploymentId"], intent["deploymentId"]),
                   "VERCEL_PROJECT_CHANGED_DURING_PROMOTION")
            job = current["aliasJob"]
            if job is not None and job["requestedAt"] > intent["previousAliasRequestedAt"]:
                demand(job["type"] == "promote" and job["toDeploymentId"] == intent["deploymentId"],
                       "VERCEL_UNRELATED_ALIAS_JOB")
                demand(job["jobStatus"] not in ("failed", "skipped"), "VERCEL_PROMOTION_FAILED_REQUIRES_REVIEW")
                if job["jobStatus"] == "succeeded" and current["productionDeploymentId"] == intent["deploymentId"]:
                    outcome.update(status="FRONTEND_DOMAINS_PROMOTED", phase="completed", frontendDomainsPromoted=True,
                                   aliasRequestedAt=job["requestedAt"])
                    return outcome
            demand(time.monotonic() < deadline, "VERCEL_PROMOTION_OBSERVATION_TIMED_OUT")
            time.sleep(min(2, max(0, deadline - time.monotonic())))
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "VERCEL_PROMOTION_FAILURE"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        # Each observation is retained separately; resuming never overwrites
        # the original mutation outcome or repeats the promotion request.
        sequence = 0
        while (attempt / f"frontend-promotion-observation-{sequence}.json").exists():
            sequence += 1
        migrate.write_json(attempt, f"frontend-promotion-observation-{sequence}.json", outcome)


def observe_frontend_promotion(client, release, attempt, timeout=180, *, expected_profile=None):
    """Read-only continuation after a timeout or uncertain promotion response."""
    demand(type(timeout) is int and 1 <= timeout <= 1800, "VERCEL_PROMOTION_TIMEOUT_REFUSED")
    migrate.private_directory(attempt)
    identity = _staged_identity(release, attempt, expected_profile=expected_profile)
    stored = migrate.read_json(attempt, "frontend-promotion-started.json")
    require_record_profile(expected_profile, stored)
    demand(isinstance(stored, dict) and all(stored.get(key) == value for key, value in identity.items())
           and type(stored.get("previousAliasRequestedAt")) is int and stored["previousAliasRequestedAt"] >= 0,
           "VERCEL_PROMOTION_INTENT_REFUSED")
    intent = {**identity, "previousAliasRequestedAt": stored["previousAliasRequestedAt"]}
    return _observe_promotion(client, release, attempt, intent, timeout, expected_profile=expected_profile)


def promote_frontend(client, release, attempt, verify_frontend, timeout=180, *, expected_profile=None):
    """Promote the staged Production build after the parent's live verification.

    The full coordinator retains the release lock, producer suspension and
    gateway maintenance throughout this operation. No standalone CLI, automatic
    rollback, cron enabling or gateway write admission is provided here.
    """
    demand(type(timeout) is int and 1 <= timeout <= 1800, "VERCEL_PROMOTION_TIMEOUT_REFUSED")
    demand(callable(verify_frontend), "FRONTEND_LIVE_VERIFICATION_REQUIRED")
    migrate.private_directory(attempt)
    identity = _staged_identity(release, attempt, expected_profile=expected_profile)
    before = promotion_state(client, identity["projectId"])
    demand(before["cronsEnabled"] is False, "VERCEL_SCHEDULE_SUSPENSION_REQUIRED")
    demand(before["productionDeploymentId"] == identity["previousDeploymentId"], "VERCEL_PROJECT_CHANGED_BEFORE_PROMOTION")
    prior = before["aliasJob"]
    demand(prior is None or prior["jobStatus"] in ("succeeded", "failed", "skipped"), "VERCEL_ALIAS_JOB_ALREADY_ACTIVE")
    deployment = deployment_state(client, identity["deploymentId"], identity["projectId"], identity["sourceCommit"], identity["releaseId"])
    demand(deployment["readyState"] == "READY", "VERCEL_PROMOTION_DEPLOYMENT_NOT_READY")
    try:
        verified = verify_frontend(release, deployment)
    except BaseException:
        raise ValueError("FRONTEND_LIVE_VERIFICATION_FAILED") from None
    require_record_profile(expected_profile, verified)
    demand(isinstance(verified, dict) and verified.get("status") == "FRONTEND_VERIFIED"
           and all(verified.get(key) == identity[key] for key in ("environment", "projectId", "sourceCommit", "releaseId", "deploymentId")),
           "FRONTEND_LIVE_VERIFICATION_REQUIRED")
    # Verification may take time. Refuse provider drift before the only POST.
    demand(promotion_state(client, identity["projectId"]) == before, "VERCEL_PROJECT_CHANGED_BEFORE_PROMOTION")
    intent = {**identity, "previousAliasRequestedAt": 0 if prior is None else prior["requestedAt"]}
    migrate.write_json(attempt, "frontend-promotion-started.json", intent)
    outcome = {**intent, "status": "FRONTEND_PROMOTION_REQUIRES_REVIEW", "phase": "request",
               "trafficAuthorized": False, "gatewayTrafficAuthorized": False, "frontendDomainsPromoted": None}
    try:
        client.request("POST", f"/v10/projects/{identity['projectId']}/promote/{identity['deploymentId']}", {})
        outcome["phase"] = "observe"
        outcome = _observe_promotion(client, release, attempt, intent, timeout, expected_profile=expected_profile)
        return outcome
    except BaseException as error:
        code = str(error)
        outcome["failureCode"] = code if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,80}", code) else "VERCEL_PROMOTION_FAILURE"
        raise ValueError(outcome["failureCode"]) from None
    finally:
        migrate.write_json(attempt, "frontend-promotion-outcome.json", outcome)
