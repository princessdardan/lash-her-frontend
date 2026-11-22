"""Build-only P4-05 bindings for an already-reviewed isolated staging release."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

import migrate
import vercel

demand = vercel.demand
HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
DB_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,62}")
SITE_HOSTS = {"lashher.com", "www.lashher.com", "staging.lashher.com",
              "api.lashher.com", "api-staging.lashher.com"}
PRIVATE_INPUTS = {
    key: "P4_05_" + key for key in (
        "DATABASE_URL", "KV_REST_API_TOKEN", "INTERNAL_SERVICE_JWT_SECRET",
        "SQUARE_ACCESS_TOKEN", "SQUARE_WEBHOOK_SIGNATURE_KEY",
        "COURSE_PURCHASE_RECOVERY_SECRET",
    )
}
RUNTIME_ONLY = {
    "INTERNAL_SERVICE_JWT_SECRET", "COURSE_PURCHASE_RECOVERY_SECRET",
}
HOLD = {
    "LASH_RELEASE_SCHEDULER_PROFILE": "off",
    "LASH_RELEASE_SCHEDULER_QUALIFICATION": "false",
    "FRONTEND_WRITER_ADMISSION_MODE": "off",
    "CUSTOMER_AUTH_ENABLED": "false",
    "INTEGRATION_CHECKOUT_ENABLED": "false",
    "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED": "false",
    "INTEGRATION_CUSTOMER_ACCESS_ENABLED": "false",
    "INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED": "false",
    "INTEGRATION_COURSE_READS_ENABLED": "false",
    "INTEGRATION_COURSE_AUTHORING_ENABLED": "false",
    "INTEGRATION_COMMUNITY_READS_ENABLED": "false",
    "INTEGRATION_COMMUNITY_WRITES_ENABLED": "false",
    "INTEGRATION_COMMUNITY_MEDIA_ENABLED": "false",
    "SQUARE_COMMERCE_ENABLED": "false",
    "SERVICE_BOOKING_SQUARE_ENABLED": "false",
    "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED": "false",
    "HIGHLEVEL_SYNC_ENABLED": "false",
    "HIGHLEVEL_MARKETING_ENABLED": "false",
    "CHITCHATS_SHIPPING_ENABLED": "false",
    "CHITCHATS_CHECKOUT_ENABLED": "false",
    "MANUAL_PRODUCT_CHECKOUT_ENABLED": "false",
    "PAYMENT_GATEWAY_MODE": "live",
}


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _url(value, code):
    demand(isinstance(value, str) and value and not any(c.isspace() for c in value)
           and "\\" not in value, code)
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        raise ValueError(code) from None
    demand(_matches(HOST, parsed.hostname), code)
    return parsed


def _https(value, path, code):
    url = _url(value, code)
    demand(url.scheme == "https" and not url.username and not url.password and url.port is None
           and url.path == path and value == f"https://{url.hostname}{path}"
           and url.hostname not in SITE_HOSTS, code)
    return value


def _policy(plan):
    policy = plan.get("courseSalesPolicy")
    code = "P4_05_SINGLE_TEST_TAX_POLICY_REQUIRED"
    demand(isinstance(policy, dict) and set(policy) == {"version", "markets"}
           and _matches(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", policy.get("version"))
           and isinstance(policy.get("markets"), list) and len(policy["markets"]) == 1, code)
    market = policy["markets"][0]
    demand(isinstance(market, dict) and set(market) == {"country", "region", "behavior", "disclosure", "classifications"}
           and market.get("country") == "CA" and _matches(r"[A-Z]{2}", market.get("region"))
           and market.get("behavior") in ("inclusive", "exclusive")
           and _matches(r"[^\x00-\x1f\x7f]{1,2000}", market.get("disclosure"))
           and market["disclosure"].strip() == market["disclosure"]
           and isinstance(market.get("classifications"), dict)
           and len(market["classifications"]) == 1, code)
    classification, rule = next(iter(market["classifications"].items()))
    demand(classification == plan.get("courseClassification")
           and _matches(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", classification)
           and isinstance(rule, dict) and set(rule) in ({"taxCode", "rateBasisPoints"},
                                                        {"taxCode", "rateBasisPoints", "zeroReason"})
           and _matches(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", rule.get("taxCode"))
           and type(rule.get("rateBasisPoints")) is int and 0 <= rule["rateBasisPoints"] <= 10000
           and (rule["rateBasisPoints"] == 0) == ("zeroReason" in rule), code)
    if "zeroReason" in rule:
        demand(rule["zeroReason"] in ("product_exempt", "zero_rated", "reduced_rated"), code)
    return json.dumps(policy, sort_keys=True, separators=(",", ":"))


def _reviewed_bindings(release, plan, database_receipt):
    environment, project_id, commit = vercel.release_identity(release)
    identity = {"projectId": project_id, "sourceCommit": commit, "releaseId": release["releaseId"]}
    demand(environment == "staging" and all(plan.get(key) == value for key, value in identity.items()),
           "P4_05_CANDIDATE_IDENTITY_REFUSED")
    target = plan.get("database")
    database_code = "P4_05_FRONTEND_DATABASE_RECEIPT_REFUSED"
    demand(isinstance(target, dict) and set(target) == {"runtimeHost", "verificationHost", "name", "runtimeRole"}
           and _matches(HOST, target.get("runtimeHost"))
           and _matches(HOST, target.get("verificationHost")) and _matches(DB_NAME, target.get("name"))
           and _matches(DB_NAME, target.get("runtimeRole"))
           and database_receipt.get("status") == "DATABASE_VERIFIED"
           and database_receipt.get("service") == "frontend"
           and database_receipt.get("environment") == "staging"
           and database_receipt.get("releaseId") == release["releaseId"]
           and database_receipt.get("sourceCommit") == commit
           and database_receipt.get("migrationMode") == "verify-current-only"
           and database_receipt.get("readOnlyVerified") is True
           and database_receipt.get("trafficAuthorized") is False, database_code)
    verified = database_receipt.get("target")
    demand(isinstance(verified, dict) and verified.get("host") == target["verificationHost"]
           and verified.get("port") == 5432 and verified.get("database") == target["name"]
           and _matches(DB_NAME, verified.get("user")) and verified["user"] != target["runtimeRole"], database_code)
    square = plan.get("square")
    demand(isinstance(square, dict) and _matches(r"sandbox-[A-Za-z0-9_-]{8,120}", square.get("applicationId"))
           and _matches(r"[A-Za-z0-9]{8,64}", square.get("locationId")), "P4_05_SQUARE_SANDBOX_REQUIRED")
    return {
        **HOLD,
        "STAGING_RELEASE_COMMIT": commit,
        "STAGING_MIGRATION_VERIFIED_COMMIT": commit,
        "API_GATEWAY_STAGING_ORIGIN": _https(plan.get("gatewayOrigin"), "", "P4_05_ISOLATED_GATEWAY_REQUIRED"),
        "KV_REST_API_URL": _https(plan.get("redisOrigin"), "", "P4_05_ISOLATED_REDIS_REQUIRED"),
        "SQUARE_ENVIRONMENT": "sandbox",
        "SQUARE_APPLICATION_ID": square["applicationId"],
        "SQUARE_LOCATION_ID": square["locationId"],
        "SQUARE_SERVICE_BOOKING_WEBHOOK_URL": _https(square.get("notificationUrl"), "/api/webhooks/square",
                                                   "P4_05_ISOLATED_SQUARE_CALLBACK_REQUIRED"),
        "COURSE_SALES_POLICY": _policy(plan),
    }


def deployment_bindings(release, plan, database_receipt, private_environment):
    """Resolve reviewed public pins and runtime-only secret inputs in memory."""
    binding = _reviewed_bindings(release, plan, database_receipt)
    target = plan["database"]
    for key, private_key in PRIVATE_INPUTS.items():
        value = private_environment.get(private_key)
        demand(isinstance(value, str) and 0 < len(value) <= 4096
               and all(32 < ord(c) < 127 for c in value) and not value.startswith("{{resolve:"),
               "P4_05_PRIVATE_BINDING_REQUIRED_" + key)
        binding[key] = value
    demand(len(binding["COURSE_PURCHASE_RECOVERY_SECRET"]) >= 32
           and len(binding["INTERNAL_SERVICE_JWT_SECRET"]) >= 32, "P4_05_CANDIDATE_AUTH_REQUIRED")
    database_code = "P4_05_FRONTEND_DATABASE_RECEIPT_REFUSED"
    database = _url(binding["DATABASE_URL"], database_code)
    demand(database.scheme in ("postgres", "postgresql") and database.hostname == target["runtimeHost"]
           and database.port in (None, 5432) and unquote(database.username or "") == target["runtimeRole"]
           and database.password and database.path == "/" + target["name"]
           and database.query == "sslmode=verify-full" and not database.fragment, database_code)
    return binding


def stage_candidate(client, release, plan, database_receipt, private_environment, attempt, timeout=900):
    """Call from the reviewed isolated release context after target and database verification."""
    binding = deployment_bindings(release, plan, database_receipt, private_environment)
    build = {key: value for key, value in binding.items() if key not in RUNTIME_ONLY}
    return vercel._stage_frontend(client, release, attempt, timeout, p4_05_bindings=(binding, build))


def _load_review(bundle, plan_file, receipt_file):
    release, jobs = migrate.make_plan(bundle)
    plan = migrate.read_json(plan_file.parent, plan_file.name)
    receipt = migrate.read_json(receipt_file.parent, receipt_file.name)
    public = _reviewed_bindings(release, plan, receipt)
    shared = migrate.read_json(Path(__file__).parents[2] / "staging", "first-release.json")
    shared_hosts = {shared["frontendDatabase"]["pooledHost"], shared["frontendDatabase"]["directHost"]}
    database = plan["database"]
    demand(not shared_hosts.intersection((database["runtimeHost"], database["verificationHost"]))
           and urlsplit(public["KV_REST_API_URL"]).hostname != shared["redis"]["hostname"],
           "P4_05_SHARED_STAGING_TARGET_REFUSED")
    frontend = jobs.get("frontend", {}).get("job", {})
    wanted = frontend.get("target", {})
    demand(wanted.get("approvedPendingTags") == []
           and wanted.get("runtimeRole") == database["runtimeRole"]
           and all(key in frontend and frontend[key] == receipt.get(key) for key in (
               "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
               "schemaBaselineSha256", "contractManifestSha256",
           ))
           and all(key in wanted and wanted[key] == receipt["target"].get(key) for key in (
               "host", "port", "database", "user", "serverMajor",
           )), "P4_05_PINNED_FRONTEND_VERIFICATION_REQUIRED")
    summary = {
        "status": "P4_05_BINDING_PLAN",
        "releaseId": release["releaseId"],
        "projectId": vercel.PROJECTS["staging"],
        "sourceCommit": public["STAGING_RELEASE_COMMIT"],
        "target": "production",
        "autoAssignCustomDomains": False,
        "bindingKeys": sorted(public.keys() | PRIVATE_INPUTS.keys()),
        "operatorEnvironmentKeys": sorted(PRIVATE_INPUTS.values()),
        "isolatedDatabase": database,
        "trafficAuthorized": False,
        "promotionAuthorized": False,
    }
    return release, plan, receipt, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("bindings", type=Path)
    parser.add_argument("database_receipt", type=Path)
    parser.add_argument("--attempt", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args()
    try:
        release, plan, receipt, summary = _load_review(args.bundle, args.bindings, args.database_receipt)
        if not args.apply:
            print(json.dumps(summary))
            return
        demand(args.confirm == f'staging/{release["releaseId"]}' and args.attempt is not None,
               "P4_05_EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED")
        migrate.private_directory(args.attempt)
        # A dedicated build never runs shared migrations or the existing
        # scheduler/probe/promote flow. Serialize with that flow on the host.
        lock = os.open("/run/lock/lash-her-release.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            outcome = stage_candidate(vercel.Client(os.environ.get("VERCEL_TOKEN")),
                                      release, plan, receipt, os.environ, args.attempt)
        finally:
            os.close(lock)
        print(json.dumps(outcome))
    except (AttributeError, KeyError, OSError, TypeError, ValueError) as error:
        code = str(error) if isinstance(error, ValueError) else ""
        parser.exit(1, (code if re.fullmatch(r"(?:P4_05|VERCEL)_[A-Z0-9_]+", code)
                        else "P4_05_BINDING_OPERATION_REFUSED") + "\n")


if __name__ == "__main__":
    main()
