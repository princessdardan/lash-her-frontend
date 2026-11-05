"""Exact staging hook suspension and exhaustive accepted-delivery readback.

No public/editorial mutations, token management endpoint, replay, production
project, secret logging, or assumption that disabling a hook empties its queue.
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
PROJECT = "7o23yrvk"
DATASET = "staging-2026-05-10"
PREFIX = "/v2026-03-24/hooks/projects/" + PROJECT
ORIGIN = "https://" + PROJECT + ".api.sanity.io"
ID = r"[A-Za-z0-9_-]{1,192}"


class AuthenticationDenied(ValueError):
    pass


class Client:
    def __init__(self, token):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token), "SANITY_PRIVATE_CREDENTIAL_REQUIRED")
        self._token = token
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, method, path, body=None):
        read = method == "GET" and body is None and (path == PREFIX or
            re.fullmatch(PREFIX + rf"/{ID}(/(messages|attempts)\?limit=25&offset=[0-9]{{1,6}})?", path))
        disable = method == "PATCH" and re.fullmatch(PREFIX + "/" + ID, path) and body == {"isDisabledByUser": True}
        demand(read or disable, "SANITY_STAGING_REQUEST_SCOPE_REFUSED")
        request = urllib.request.Request(ORIGIN + path, method=method, data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                demand(response.status == 200 and len(raw) <= 2_000_000, "SANITY_RESPONSE_REFUSED")
                value = json.loads(raw)
                demand(isinstance(value, (list, dict)), "SANITY_RESPONSE_REFUSED")
                return value
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            if status == 401:
                raise AuthenticationDenied("SANITY_AUTHENTICATION_DENIED") from None
            raise ValueError("SANITY_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("SANITY_REQUEST_FAILED_REQUIRES_REVIEW") from None


def hook(row, reviewed):
    demand(isinstance(row, dict), "SANITY_HOOK_REFUSED")
    url = urllib.parse.urlsplit(row.get("url", ""))
    query = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
    demand(isinstance(row.get("id"), str) and re.fullmatch(ID, row["id"]) and row.get("projectId") == PROJECT and
        row.get("dataset") == DATASET and row.get("type") == "document" and row.get("httpMethod", "POST") == "POST" and
        type(row.get("isDisabled")) is bool and type(row.get("isDisabledByUser")) is bool and
        url.scheme == "https" and url.hostname == "staging.lashher.com" and url.port is None and not url.username and not url.password and
        not url.fragment and url.path in ("/api/revalidate", "/api/webhooks/sanity/inventory-sync") and
        (not query or len(query) == 1 and query[0][0] == "x-vercel-protection-bypass" and query[0][1]), "SANITY_HOOK_STAGING_BINDING_REFUSED")
    expected = next((item for item in reviewed["hooks"] if item["hookId"] == row["id"]), None)
    demand(expected is not None and expected["path"] == url.path, "SANITY_REVIEWED_HOOK_BINDING_REFUSED")
    return {"hookId": row["id"], "path": url.path, "disabled": row["isDisabled"], "disabledByUser": row["isDisabledByUser"]}


def inventory(client, reviewed):
    demand(reviewed.get("projectId") == PROJECT and reviewed.get("dataset") == DATASET and isinstance(reviewed.get("hooks"), list),
        "SANITY_DEDICATED_STAGING_BINDING_REQUIRED")
    rows = client.request("GET", PREFIX)
    demand(isinstance(rows, list) and len(rows) <= 4096, "SANITY_HOOK_INVENTORY_REFUSED")
    result = sorted((hook(row, reviewed) for row in rows), key=lambda row: row["hookId"])
    demand([row["hookId"] for row in result] == sorted(item["hookId"] for item in reviewed["hooks"]), "SANITY_REVIEWED_HOOK_INVENTORY_CHANGED")
    return result


def pages(client, hook_id, resource):
    result, seen = [], set()
    for offset in range(0, 16_384, 25):
        rows = client.request("GET", PREFIX + "/" + hook_id + "/" + resource + "?limit=25&offset=" + str(offset))
        demand(isinstance(rows, list) and len(rows) <= 25, "SANITY_DELIVERY_PAGE_REFUSED")
        for row in rows:
            item = row.get("id") if isinstance(row, dict) else None
            demand(isinstance(item, str) and re.fullmatch(ID, item) and item not in seen and row.get("projectId") == PROJECT and
                row.get("hookId") == hook_id, "SANITY_DELIVERY_ID_REFUSED")
            seen.add(item)
            result.append(row)
        if len(rows) < 25:
            return result
    raise ValueError("SANITY_DELIVERY_INVENTORY_LIMIT")


def deliveries(client, reviewed):
    result = []
    for selected in reviewed["hooks"]:
        hook_id = selected["hookId"]
        attempts = pages(client, hook_id, "attempts")
        active = 0
        for row in attempts:
            demand(type(row.get("inProgress")) is bool, "SANITY_ATTEMPT_STATE_REFUSED")
            active += row["inProgress"]
        messages = []
        for row in pages(client, hook_id, "messages"):
            demand(row.get("dataset") == DATASET and isinstance(row.get("status"), str), "SANITY_MESSAGE_SCOPE_REFUSED")
            code = row.get("resultCode")
            demand(code is None or type(code) is int and 100 <= code <= 599, "SANITY_MESSAGE_RESULT_REFUSED")
            # Documented HTTP delivery policy: 2xx succeeds; 4xx other than
            # 429 is undeliverable. Explicit cancellation is terminal too.
            terminal = row["status"] == "canceled" or row["status"] in ("success", "delivered", "failure", "failed") and \
                code is not None and (200 <= code <= 299 or 400 <= code <= 499 and code != 429)
            messages.append({"messageId": row["id"], "status": row["status"], "resultCode": code, "terminal": terminal})
        result.append({"hookId": hook_id, "activeAttempts": active,
            "messages": sorted(messages, key=lambda row: row["messageId"]),
            "unresolvedEffects": sum(not row["terminal"] for row in messages)})
    return sorted(result, key=lambda row: row["hookId"])


def observe(client, retired, reviewed):
    first = inventory(client, reviewed), deliveries(client, reviewed)
    second = inventory(client, reviewed), deliveries(client, reviewed)
    demand(first == second, "SANITY_HOOK_OR_DELIVERY_INVENTORY_CHANGED")
    denied = False
    try:
        inventory(retired, reviewed)
    except AuthenticationDenied:
        denied = True
    return {"provider": "sanity", "projectId": PROJECT, "dataset": DATASET, "hooks": first[0], "deliveries": first[1],
        "hookInventoryComplete": True, "deliveryPaginationComplete": True, "retiredCredentialDenied": denied,
        "activeExecutions": sum(row["activeAttempts"] for row in first[1]),
        "uncertainEffects": sum(row["unresolvedEffects"] for row in first[1])}


def suspend(client, retired, reviewed, selected, attempt):
    before = inventory(client, reviewed)
    demand(before == inventory(client, reviewed) == inventory(retired, reviewed), "SANITY_OLD_CREDENTIAL_SCOPE_UNVERIFIED")
    initial = {**selected, "status": "SANITY_HOOK_SUSPENSION_REQUIRES_REVIEW", "hooks": before, "uncertainHookId": None}
    migrate.write_json(attempt, "sanity-hook-suspension-started.json", initial)
    try:
        for row in before:
            if not row["disabledByUser"]:
                initial["uncertainHookId"] = row["hookId"]
                client.request("PATCH", PREFIX + "/" + row["hookId"], {"isDisabledByUser": True})
            actual = hook(client.request("GET", PREFIX + "/" + row["hookId"]), reviewed)
            demand(actual["disabled"] and actual["disabledByUser"], "SANITY_DISABLE_READBACK_UNVERIFIED")
            migrate.write_json(attempt, "sanity-hook-" + row["hookId"] + "-disabled.json", {**selected, **actual})
            initial["uncertainHookId"] = None
        initial.update(status="SANITY_HOOKS_DISABLED_CREDENTIAL_RETIREMENT_PENDING", hooks=inventory(client, reviewed))
        return initial
    finally:
        migrate.write_json(attempt, "sanity-hook-suspension-outcome.json", initial)
