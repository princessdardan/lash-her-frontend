"""Dedicated sandbox readback after the existing operator retires a PAT.

No OAuth revocation, token introspection, payment/refund creation, cancellation,
credential creation, production origin, or ambient credential resolution.
"""
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

import migrate
import vercel

demand = migrate.demand
ORIGIN = "https://connect.squareupsandbox.com"
LOCATION = "LE2H76M5V90AM"
WEBHOOK = "wbhk_b8cf77ce0a5142b38b93715c05ede7d5"
API_VERSION = "2026-05-20"
ID = r"[A-Za-z0-9_-]{1,192}"


class AuthenticationDenied(ValueError):
    pass


class Client:
    def __init__(self, token):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token), "SQUARE_PRIVATE_CREDENTIAL_REQUIRED")
        self._token = token
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        read = method == "GET" and body is None and (path == "/v2/locations/" + LOCATION or
            re.fullmatch(rf"/v2/(payments|refunds)/{ID}", path) or path == "/v2/webhooks/subscriptions/" + WEBHOOK)
        disable = method == "PUT" and path == "/v2/webhooks/subscriptions/" + WEBHOOK and body == {"subscription": {"enabled": False}}
        demand(read or disable, "SQUARE_SANDBOX_REQUEST_SCOPE_REFUSED")
        request = urllib.request.Request(ORIGIN + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self._token, "Square-Version": API_VERSION, "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                demand(200 <= response.status < 300 and len(raw) <= 2_000_000, "SQUARE_RESPONSE_REFUSED")
                value = json.loads(raw)
                demand(isinstance(value, dict) and not value.get("errors"), "SQUARE_RESPONSE_REFUSED")
                return value
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = error.read(65_537)
                errors = json.loads(raw).get("errors") if len(raw) <= 65_536 else None
                denied = status == 401 and isinstance(errors, list) and len(errors) > 0 and all(
                    isinstance(item, dict) and item.get("code") == "UNAUTHORIZED" and item.get("category") == "AUTHENTICATION_ERROR" for item in errors)
            except (ValueError, TypeError, AttributeError):
                denied = False
            finally:
                error.close()
            if denied:
                raise AuthenticationDenied("SQUARE_SANDBOX_AUTHENTICATION_DENIED") from None
            raise ValueError("SQUARE_SANDBOX_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("SQUARE_SANDBOX_REQUEST_FAILED_REQUIRES_REVIEW") from None


def binding(client, reviewed):
    value = client.request("GET", "/v2/locations/" + LOCATION).get("location")
    demand(isinstance(value, dict) and value.get("id") == LOCATION and value.get("merchant_id") == reviewed["merchantId"] and
        value.get("status") == "ACTIVE" and value.get("currency") == "CAD" and value.get("country") == "CA", "SQUARE_SANDBOX_LOCATION_REFUSED")
    return {"locationId": LOCATION, "merchantId": reviewed["merchantId"], "currency": "CAD", "country": "CA", "locationStatus": "ACTIVE"}


def webhook(client):
    value = client.request("GET", "/v2/webhooks/subscriptions/" + WEBHOOK).get("subscription")
    demand(isinstance(value, dict), "SQUARE_SANDBOX_WEBHOOK_REFUSED")
    url = urllib.parse.urlsplit(value.get("notification_url", ""))
    query = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
    events = value.get("event_types")
    demand(value.get("id") == WEBHOOK and type(value.get("enabled")) is bool and value.get("api_version") == API_VERSION and
        url.scheme == "https" and url.hostname == "staging.lashher.com" and url.port is None and not url.username and not url.password and
        url.path == "/api/webhooks/square" and not url.fragment and
        (not query or len(query) == 1 and query[0][0] == "x-vercel-protection-bypass" and query[0][1]) and
        isinstance(events, list) and events and len(events) == len(set(events)) and all(
            isinstance(event, str) and re.fullmatch(r"[a-z_]+\.[a-z_]+", event) for event in events), "SQUARE_SANDBOX_WEBHOOK_REFUSED")
    # The provider response also contains signing material. Retain neither it
    # nor callback URLs, request bodies, buyer names/card data, or credentials.
    return {"webhookId": WEBHOOK, "enabled": value["enabled"], "apiVersion": API_VERSION, "events": sorted(events)}


def effects(client, reviewed, actual_rows):
    result = []
    demand(isinstance(actual_rows, list) and len(actual_rows) == len(reviewed["effects"]), "SQUARE_ACTUAL_DATABASE_EFFECTS_REQUIRED")
    for selected, actual in zip(reviewed["effects"], actual_rows):
        demand(selected["recordKind"] == actual.get("recordKind") and selected["recordId"] == actual.get("recordId") and
            selected["databaseRowSha256"] == actual.get("databaseRowSha256"), "SQUARE_DATABASE_EFFECT_BINDING_REFUSED")
        summary = {key: actual[key] for key in ("recordKind", "recordId", "databaseRowSha256", "idempotencySha256", "providerId", "providerKind", "databaseStatus")}
        summary.update(immutableMatch=False, storedOutcomeConsistent=False, providerStatus=None)
        if actual["providerId"] is None:
            summary["unresolvedReason"] = "provider-id-unrecorded-no-safe-idempotency-lookup"
            result.append(summary)
            continue
        demand(re.fullmatch(ID, actual["providerId"]) is not None and actual["providerKind"] in ("payment", "refund"), "SQUARE_EFFECT_ID_REFUSED")
        value = client.request("GET", "/v2/" + ("payments/" if actual["providerKind"] == "payment" else "refunds/") + actual["providerId"]).get(actual["providerKind"])
        demand(isinstance(value, dict) and value.get("id") == actual["providerId"], "SQUARE_EFFECT_READBACK_REFUSED")
        status = value.get("status")
        demand(isinstance(status, str) and re.fullmatch(r"[A-Z_]{1,40}", status), "SQUARE_EFFECT_STATUS_REFUSED")
        matches = value.get("location_id") == LOCATION and value.get("amount_money") == {"amount": actual["amountCents"], "currency": "CAD"}
        if actual["providerKind"] == "payment":
            matches = matches and value.get("application_details", {}).get("application_id") == reviewed["applicationId"]
            if actual.get("referenceId") is not None:
                matches = matches and value.get("reference_id") == actual["referenceId"]
            if actual.get("providerOrderId") is not None:
                matches = matches and value.get("order_id") == actual["providerOrderId"]
            consistent = (actual["databaseStatus"], status) in (("captured", "COMPLETED"), ("failed", "FAILED"), ("cancelled", "CANCELED"))
        else:
            matches = matches and value.get("payment_id") == actual["originalPaymentId"]
            consistent = (actual["databaseStatus"], status) in (("succeeded", "COMPLETED"), ("failed", "FAILED"), ("rejected", "REJECTED"))
        summary.update(providerStatus=status, immutableMatch=matches, storedOutcomeConsistent=matches and consistent)
        if not summary["storedOutcomeConsistent"]:
            summary["unresolvedReason"] = "immutable-effect-mismatch" if not matches else "provider-and-database-outcome-not-terminal-and-equal"
        result.append(summary)
    return result


def observe(replacement, retired, reviewed, actual_rows):
    demand(reviewed.get("environment") == "sandbox" and reviewed.get("credentialKind") == "personal-access-token" and
        reviewed.get("locationId") == LOCATION and reviewed.get("apiVersion") == API_VERSION and reviewed.get("webhookIds") == [WEBHOOK], "SQUARE_SANDBOX_REVIEW_REQUIRED")
    first = binding(replacement, reviewed), webhook(replacement)
    second = binding(replacement, reviewed), webhook(replacement)
    demand(first == second, "SQUARE_SANDBOX_SCOPE_CHANGED")
    denied = False
    try:
        binding(retired, reviewed)
    except AuthenticationDenied:
        denied = True
    observations = effects(replacement, reviewed, actual_rows)
    return {"status": "SQUARE_SANDBOX_OBSERVED", **first[0], "webhooks": [first[1]], "retiredCredentialDenied": denied,
        "knownEffects": observations, "knownUnresolvedEffects": sum(not row["storedOutcomeConsistent"] for row in observations),
        "activeExecutions": None, "uncertainEffects": None, "historicalWritersFenced": False, "runtimeReplacementBindingVerified": False}


def verify_retirement(replacement, retired, reviewed, actual_rows, selected, attempt):
    # PAT regeneration/retirement is performed by the existing operator through
    # the provider dashboard. This component verifies actual denial afterwards;
    # it cannot infer success from an operator checkbox or supplied screenshot.
    initial = {**selected, "status": "SQUARE_SANDBOX_RETIREMENT_REQUIRES_REVIEW", "trafficAuthorized": False,
        "runtimeReplacementBindingVerified": False, "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None}
    migrate.write_json(attempt, "square-retirement-verification-started.json", initial)
    try:
        observed = observe(replacement, retired, reviewed, actual_rows)
        demand(observed["retiredCredentialDenied"] and all(not row["enabled"] for row in observed["webhooks"]), "SQUARE_DASHBOARD_RETIREMENT_OR_DISABLED_CALLBACK_UNVERIFIED")
        initial.update(observed, status="STAGING_SQUARE_CREDENTIAL_DENIED_KNOWN_EFFECTS_OBSERVED")
        return initial
    finally:
        migrate.write_json(attempt, "square-retirement-verification-outcome.json", initial)
