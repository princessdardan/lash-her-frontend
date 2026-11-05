"""Concrete isolated-staging credential/ingress retirement, never effect drain.

No CLI, ambient credentials, token creation, sends, contact writes or replay.
Called only by the source-pinned locked frontend provider worker.
"""
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

import migrate
import vercel

ORIGIN = "https://api.resend.com"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
demand = migrate.demand


class AuthenticationDenied(ValueError):
    pass


class Client:
    def __init__(self, token):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token), "RESEND_PRIVATE_CREDENTIAL_REQUIRED")
        self._token = token
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        read = method == "GET" and body is None and (re.fullmatch(rf"/(api-keys|webhooks)\?limit=100(&after={UUID})?", path) or
            re.fullmatch(rf"/(domains|webhooks|emails)/{UUID}", path))
        remove = method == "DELETE" and body is None and re.fullmatch(rf"/api-keys/{UUID}", path)
        disable = method == "PATCH" and re.fullmatch(rf"/webhooks/{UUID}", path) and body == {"status": "disabled"}
        demand(read or remove or disable, "RESEND_REQUEST_SCOPE_REFUSED")
        request = urllib.request.Request(ORIGIN + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                demand(200 <= response.status < 300 and len(raw) <= 2_000_000, "RESEND_RESPONSE_REFUSED")
                value = json.loads(raw)
                demand(isinstance(value, dict), "RESEND_RESPONSE_REFUSED")
                return value
        except urllib.error.HTTPError as error:
            status = error.code; error.close()
            if status == 401:
                raise AuthenticationDenied("RESEND_AUTHENTICATION_DENIED") from None
            raise ValueError("RESEND_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("RESEND_REQUEST_FAILED_REQUIRES_REVIEW") from None


def identifier(value):
    return isinstance(value, str) and re.fullmatch(UUID, value)


def pagination(client, resource):
    demand(resource in ("api-keys", "webhooks"), "RESEND_INVENTORY_SCOPE_REFUSED")
    rows, seen, cursor = [], set(), None
    for _page in range(100):
        value = client.request("GET", "/" + resource + "?limit=100" + ("&after=" + cursor if cursor else ""))
        data = value.get("data")
        demand(value.get("object") == "list" and type(value.get("has_more")) is bool and isinstance(data, list) and len(data) <= 100,
            "RESEND_INVENTORY_PAGE_REFUSED")
        for row in data:
            item = row.get("id") if isinstance(row, dict) else None
            demand(identifier(item) and item not in seen and len(rows) < 4096, "RESEND_INVENTORY_ID_REFUSED")
            rows.append(row); seen.add(item)
        if not value["has_more"]:
            return rows
        demand(data, "RESEND_INVENTORY_CURSOR_REFUSED")
        cursor = data[-1]["id"]
    raise ValueError("RESEND_INVENTORY_LIMIT")


def domain(client, reviewed):
    value = client.request("GET", "/domains/" + reviewed["domainId"])
    demand(value.get("id") == reviewed["domainId"] and value.get("name") == "mail.staging.lashher.com" and
        value.get("status") == "verified", "RESEND_DEDICATED_STAGING_DOMAIN_REFUSED")
    return {"domainId": value["id"], "domainName": value["name"], "domainStatus": value["status"]}


def webhook(client, webhook_id):
    value = client.request("GET", "/webhooks/" + webhook_id)
    # Callback URLs may contain bypass credentials: compare privately and
    # publish only ID/status, never URL/query/secret/provider error bodies.
    endpoint = urllib.parse.urlsplit(value.get("endpoint", ""))
    query = urllib.parse.parse_qsl(endpoint.query, keep_blank_values=True)
    demand(value.get("id") == webhook_id and value.get("status") in ("enabled", "disabled") and
        endpoint.scheme == "https" and endpoint.hostname == "staging.lashher.com" and endpoint.port is None and
        not endpoint.username and not endpoint.password and not endpoint.fragment and endpoint.path == "/api/webhooks/resend" and
        (not query or len(query) == 1 and query[0][0] == "x-vercel-protection-bypass" and query[0][1]) and
        value.get("events") == ["contact.updated"], "RESEND_WEBHOOK_STAGING_BINDING_REFUSED")
    return {"webhookId": webhook_id, "status": value["status"], "events": ["contact.updated"]}


def inventory(client, reviewed):
    selected_domain = domain(client, reviewed)
    keys = sorted(row["id"] for row in pagination(client, "api-keys"))
    hooks = sorted(row["id"] for row in pagination(client, "webhooks"))
    return {**selected_domain, "keyIds": keys, "webhookIds": hooks,
        "webhooks": [webhook(client, item) for item in hooks]}


def known_email_observations(client, reviewed):
    result = []
    for email_id in reviewed["knownEmailIds"]:
        value = client.request("GET", "/emails/" + email_id)
        state = value.get("last_event")
        demand(value.get("id") == email_id and isinstance(state, str) and re.fullmatch(r"[a-z_]{1,40}", state), "RESEND_EMAIL_STATE_REFUSED")
        # Sent message payloads include recipients and content. Retain neither;
        # this is actual state observation, never proof of exhaustive coverage.
        result.append({"emailId": email_id, "lastEvent": state})
    return result


def observe(client, retired_client, reviewed):
    first, second = inventory(client, reviewed), inventory(client, reviewed)
    demand(first == second, "RESEND_INVENTORY_CHANGED_DURING_OBSERVATION")
    old_denied = False
    try:
        domain(retired_client, reviewed)
    except AuthenticationDenied:
        old_denied = True
    return {"status": "STAGING_RESEND_SCOPE_OBSERVED", **first, "retiredCredentialDenied": old_denied,
        "knownEmails": known_email_observations(client, reviewed), "runtimeReplacementBindingVerified": False,
        "historicalWritersFenced": False, "activeExecutions": None, "uncertainEffects": None}


def retire(client, retired_client, reviewed, selected, attempt):
    demand(isinstance(reviewed, dict) and identifier(reviewed.get("domainId")) and identifier(reviewed.get("retiredKeyId")) and
        identifier(reviewed.get("replacementKeyId")) and reviewed["retiredKeyId"] != reviewed["replacementKeyId"] and
        reviewed["domainName"] == "mail.staging.lashher.com", "RESEND_RETIREMENT_BINDING_REFUSED")
    before = inventory(client, reviewed)
    demand(before == inventory(client, reviewed) and before["keyIds"] == reviewed["expectedKeyIds"] and
        before["webhookIds"] == reviewed["webhookIds"] and reviewed["retiredKeyId"] in before["keyIds"] and
        reviewed["replacementKeyId"] in before["keyIds"], "RESEND_REVIEWED_INVENTORY_CHANGED")
    demand(domain(retired_client, reviewed) == domain(client, reviewed), "RESEND_RETIRED_CREDENTIAL_SCOPE_REFUSED")
    outcome = {**selected, "status": "RESEND_RETIREMENT_FAILED_REQUIRES_REVIEW", "domainId": reviewed["domainId"],
        "retiredKeyId": reviewed["retiredKeyId"], "replacementKeyId": reviewed["replacementKeyId"], "disabledWebhookIds": [],
        "keyDeletionAcknowledged": False, "retiredCredentialDenied": False, "uncertainMutation": None,
        "runtimeReplacementBindingVerified": False, "historicalWritersFenced": False, "activeExecutions": None,
        "uncertainEffects": None, "trafficAuthorized": False}
    migrate.write_json(attempt, "resend-retirement-started.json", outcome)
    try:
        for item in before["webhooks"]:
            if item["status"] != "disabled":
                outcome["uncertainMutation"] = "disable-webhook:" + item["webhookId"]
                client.request("PATCH", "/webhooks/" + item["webhookId"], {"status": "disabled"})
            demand(webhook(client, item["webhookId"])["status"] == "disabled", "RESEND_WEBHOOK_DISABLE_UNVERIFIED")
            outcome["disabledWebhookIds"].append(item["webhookId"]); outcome["uncertainMutation"] = None
        # Recheck scope immediately before the one destructive key request.
        demand(sorted(row["id"] for row in pagination(client, "api-keys")) == before["keyIds"], "RESEND_KEY_INVENTORY_DRIFT")
        outcome["uncertainMutation"] = "delete-key:" + reviewed["retiredKeyId"]
        deleted = client.request("DELETE", "/api-keys/" + reviewed["retiredKeyId"])
        demand(deleted.get("object") == "api_key" and deleted.get("id") == reviewed["retiredKeyId"] and deleted.get("deleted") is True,
            "RESEND_KEY_DELETE_ACK_UNVERIFIED")
        outcome["keyDeletionAcknowledged"] = True
        migrate.write_json(attempt, "resend-key-deleted.json", {**selected, "keyId": reviewed["retiredKeyId"], "deleted": True})
        after = observe(client, retired_client, reviewed)
        demand(after["keyIds"] == [key for key in before["keyIds"] if key != reviewed["retiredKeyId"]] and
            after["retiredCredentialDenied"] is True and after["webhookIds"] == reviewed["webhookIds"] and
            all(row["status"] == "disabled" for row in after["webhooks"]), "RESEND_KEY_RETIREMENT_READBACK_UNVERIFIED")
        outcome.update(status="STAGING_RESEND_CREDENTIAL_RETIRED_EFFECTS_UNRESOLVED", retiredCredentialDenied=True,
            uncertainMutation=None, observation=after)
        return outcome
    finally:
        migrate.write_json(attempt, "resend-retirement-outcome.json", outcome)
