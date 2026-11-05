"""Selected staging Google OAuth/Calendar and isolated legacy Redis controls.

No client-management API is invented. The operator disables selected old client
secrets in Google Auth Platform; this module checks actual invalid_client and
successful replacement refreshes. Grant revocation is the documented endpoint.
"""
import hashlib
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

import migrate
import vercel

demand = migrate.demand
OAUTH = "https://oauth2.googleapis.com"
USERINFO = "https://openidconnect.googleapis.com"
CALENDAR = "https://www.googleapis.com"
REDIS = "https://tidy-monarch-236694.upstash.io"
CLIENTS = {
    "identity": "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com",
    "calendar": "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com",
}
LEGACY_KEYS = ("booking:google-refresh-token:production", "booking:google-refresh-token")
STATE_PREFIX = "booking:calendar-oauth-state:"


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Transport:
    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def send(self, origin, path, headers, body=None):
        request = urllib.request.Request(origin + path, headers=headers, data=body, method="GET" if body is None else "POST")
        try:
            with self._opener.open(request, timeout=30) as response:
                raw = response.read(2_000_001)
                demand(200 <= response.status < 300 and len(raw) <= 2_000_000, "GOOGLE_RESPONSE_REFUSED")
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = error.read(65_537)
                value = json.loads(raw) if len(raw) <= 65_536 else {}
                code = value.get("error") if isinstance(value, dict) else None
                # Retain only the documented OAuth error, never error bodies,
                # descriptions, URLs, tokens, calendar content or profile data.
                if status in (400, 401) and code in ("invalid_client", "invalid_grant", "invalid_token"):
                    return status, {"error": code}
            except (ValueError, TypeError):
                pass
            finally:
                error.close()
            raise ValueError("GOOGLE_REQUEST_FAILED_REQUIRES_REVIEW") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("GOOGLE_REQUEST_FAILED_REQUIRES_REVIEW") from None


class Client:
    def __init__(self, kind, secret, verify):
        demand(kind in CLIENTS and isinstance(secret, str) and 0 < len(secret) <= 8192 and all(32 < ord(c) < 127 for c in secret)
            and callable(verify), "GOOGLE_SELECTED_CLIENT_REQUIRED")
        self.kind, self._secret, self.verify, self.transport = kind, secret, verify, Transport()

    def refresh(self, token):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and "\n" not in token, "GOOGLE_PRIVATE_GRANT_REQUIRED")
        self.verify()
        result = self.transport.send(OAUTH, "/token", {"Content-Type": "application/x-www-form-urlencoded"},
            urllib.parse.urlencode({"client_id": CLIENTS[self.kind], "client_secret": self._secret,
                "refresh_token": token, "grant_type": "refresh_token"}).encode())
        self.verify()
        return result

    def profile(self, access):
        self.verify()
        status, value = self.transport.send(USERINFO, "/v1/userinfo", {"Authorization": "Bearer " + access})
        self.verify()
        demand(status == 200 and isinstance(value, dict) and isinstance(value.get("sub"), str) and re.fullmatch(r"[0-9]{1,40}", value["sub"]),
            "GOOGLE_GRANT_OWNER_UNVERIFIED")
        return sha(value["sub"])

    def revoke(self, token):
        self.verify()
        status, _value = self.transport.send(OAUTH, "/revoke", {"Content-Type": "application/x-www-form-urlencoded"},
            urllib.parse.urlencode({"token": token}).encode())
        self.verify()
        demand(status == 200, "GOOGLE_GRANT_REVOCATION_ACK_UNVERIFIED")

    def events(self, access, calendar_id):
        demand(self.kind == "calendar" and isinstance(calendar_id, str) and 0 < len(calendar_id) <= 1024, "GOOGLE_CALENDAR_SCOPE_REFUSED")
        rows, seen, page, tokens = [], set(), None, set()
        for _ in range(100):
            path = "/calendar/v3/calendars/" + urllib.parse.quote(calendar_id, safe="") + "/events?maxResults=2500&showDeleted=true&singleEvents=false"
            if page:
                path += "&pageToken=" + urllib.parse.quote(page, safe="")
            self.verify()
            status, value = self.transport.send(CALENDAR, path, {"Authorization": "Bearer " + access})
            self.verify()
            demand(status == 200 and isinstance(value, dict) and isinstance(value.get("items"), list) and len(value["items"]) <= 2500,
                "GOOGLE_EVENT_PAGE_REFUSED")
            for row in value["items"]:
                event_id = row.get("id") if isinstance(row, dict) else None
                demand(isinstance(event_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", event_id) and event_id not in seen and len(rows) < 16384,
                    "GOOGLE_EVENT_ID_REFUSED")
                seen.add(event_id)
                private = row.get("extendedProperties", {}).get("private", {})
                demand(isinstance(private, dict) and row.get("status") in ("confirmed", "tentative", "cancelled") and
                    (row.get("etag") is None or isinstance(row["etag"], str) and 0 < len(row["etag"]) <= 1024 and
                     all(32 <= ord(char) < 127 for char in row["etag"])), "GOOGLE_EVENT_STATE_REFUSED")
                rows.append({"eventId": event_id, "etag": row.get("etag"), "status": row.get("status"),
                    "bookingHoldId": private.get("lashHerBookingHoldId"), "checkoutOrderId": private.get("lashHerCheckoutOrderId")})
            page = value.get("nextPageToken")
            if page is None:
                return sorted(rows, key=lambda row: row["eventId"])
            demand(isinstance(page, str) and 0 < len(page) <= 8192 and page not in tokens and value["items"], "GOOGLE_EVENT_CURSOR_REFUSED")
            tokens.add(page)
        raise ValueError("GOOGLE_EVENT_INVENTORY_LIMIT")


class LegacyRedis:
    def __init__(self, token, verify):
        demand(isinstance(token, str) and 0 < len(token) <= 8192 and all(32 < ord(c) < 127 for c in token) and callable(verify),
            "GOOGLE_ISOLATED_REDIS_REQUIRED")
        self._token, self.verify, self.transport = token, verify, Transport()

    def command(self, command):
        read = isinstance(command, list) and (len(command) == 2 and command[0] == "GET" and command[1] in LEGACY_KEYS or
            len(command) == 6 and command[0] == "SCAN" and isinstance(command[1], str) and command[1].isdigit() and
            command[2:] == ["MATCH", STATE_PREFIX + "*", "COUNT", "100"])
        remove = isinstance(command, list) and len(command) == 2 and command[0] == "DEL" and isinstance(command[1], str) and \
            re.fullmatch(re.escape(STATE_PREFIX) + r"[A-Za-z0-9_-]{20,128}", command[1])
        demand(read or remove, "GOOGLE_REDIS_COMMAND_SCOPE_REFUSED")
        self.verify()
        status, value = self.transport.send(REDIS, "/", {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"},
            json.dumps(command).encode())
        self.verify()
        demand(status == 200 and isinstance(value, dict) and "error" not in value and "result" in value, "GOOGLE_REDIS_RESPONSE_REFUSED")
        return value["result"]

    def snapshot(self):
        grants = []
        for key in LEGACY_KEYS:
            value = self.command(["GET", key])
            # Upstash's historical JS client can JSON-encode string values.
            if isinstance(value, str) and value.startswith('"'):
                value = json.loads(value)
            demand(value is None or isinstance(value, str) and 0 < len(value) <= 8192, "GOOGLE_LEGACY_GRANT_VALUE_REFUSED")
            grants.append({"grantId": key, "refreshToken": value})
        keys, seen, cursor, cursors = [], set(), "0", set()
        for _ in range(100):
            value = self.command(["SCAN", cursor, "MATCH", STATE_PREFIX + "*", "COUNT", "100"])
            demand(isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0].isdigit() and isinstance(value[1], list),
                "GOOGLE_REDIS_SCAN_REFUSED")
            for key in value[1]:
                demand(isinstance(key, str) and re.fullmatch(re.escape(STATE_PREFIX) + r"[A-Za-z0-9_-]{20,128}", key) and len(keys) < 4096,
                    "GOOGLE_REDIS_STATE_KEY_REFUSED")
                if key not in seen:
                    seen.add(key); keys.append(key)
            cursor = value[0]
            if cursor == "0":
                return {"grants": grants, "stateKeys": sorted(keys)}
            demand(cursor not in cursors, "GOOGLE_REDIS_CURSOR_REPEATED")
            cursors.add(cursor)
        raise ValueError("GOOGLE_REDIS_SCAN_LIMIT")


def access(client, token, owner):
    status, value = client.refresh(token)
    demand(status == 200 and isinstance(value, dict) and isinstance(value.get("access_token"), str) and value.get("token_type", "").lower() == "bearer"
        and client.profile(value["access_token"]) == owner, "GOOGLE_REPLACEMENT_OR_GRANT_OWNER_UNVERIFIED")
    return value["access_token"]


def secret_denied(client, token):
    status, value = client.refresh(token)
    return status in (400, 401) and value == {"error": "invalid_client"}


def database_transition(reviewed, actual):
    before, current = reviewed.get("databaseBeforeSnapshot"), actual["snapshot"]
    demand(isinstance(before, dict) and canonical(actual["events"]) == canonical(current.get("events")) and canonical(before) == reviewed["databaseSnapshotSha256"] and
        before.get("connections") == current.get("connections") and before.get("assignments") == current.get("assignments"),
        "GOOGLE_IMMUTABLE_DATABASE_BINDING_CHANGED")
    previous = {(row["recordKind"], row["recordId"]): row for row in before["events"]}
    present = {(row["recordKind"], row["recordId"]): row for row in current["events"]}
    demand(len(previous) == len(before["events"]) and len(present) == len(current["events"]) and set(previous) <= set(present),
        "GOOGLE_DECLARED_EVENT_INVENTORY_CHANGED")
    pending = {key: row for key, row in previous.items() if row["status"] in ("pending", "paid_calendar_pending", "retryable_failed")}
    changed = []
    for key, row in previous.items():
        after = present[key]
        if row == after:
            continue
        demand(key in pending and all(after.get(field) == row.get(field) for field in ("recordKind", "recordId", "calendarSha256")) and
            (row["eventId"] is None or after["eventId"] == row["eventId"]) and after["eventId"] is not None and
            after["status"] in ("synced", "deleted", "booked", "manual_rebooked"), "GOOGLE_UNDECLARED_EVENT_TRANSITION")
        changed.append({"recordKind": key[0], "recordId": key[1], "beforeStatus": row["status"], "afterStatus": after["status"]})
    for key in set(present) - set(previous):
        row = present[key]
        origin = ("appointment-hold", row.get("originHoldId"))
        checkout = ("checkout-order", row.get("checkoutOrderId"))
        ancestor = present.get(origin) if origin in pending else present.get(checkout) if checkout in pending else None
        demand(row["recordKind"] == "appointment-calendar-event" and ancestor is not None and
            row["calendarSha256"] == ancestor["calendarSha256"] and row["eventId"] == ancestor["eventId"] and row["status"] == "synced",
            "GOOGLE_NEW_UNDECLARED_EFFECT_REFUSED")
        changed.append({"recordKind": key[0], "recordId": key[1], "beforeStatus": None, "afterStatus": row["status"]})
    # Changed rows remain provisional until reconcile_events() independently
    # matches their exact provider event/etag/outcome or immutable hold metadata.
    return {"beforeSnapshotSha256": reviewed["databaseSnapshotSha256"], "currentSnapshotSha256": canonical(current),
        "declaredTransitions": changed}


def observe_clients(replacements, retired, reviewed, private):
    result = []
    for selected in reviewed["clients"]:
        kind = selected["kind"]
        token = private["verificationGrants"][kind]
        access(replacements[kind], token, selected["verificationOwnerSha256"])
        result.append({"kind": kind, "clientId": CLIENTS[kind], "replacementRefreshVerified": True,
            "retiredSecretDenied": secret_denied(retired[kind], token)})
    return result


def reconcile_events(client, private, reviewed, actual, after_retirement=False):
    result = []
    for selected in reviewed["calendars"]:
        grant = next((row for row in actual["grants"] if row["grantId"] == selected["grantId"]), None)
        if selected["grantId"] == "verification:calendar":
            token = private["verificationGrants"]["calendar"]
            owner = next(row for row in reviewed["clients"] if row["kind"] == "calendar")["verificationOwnerSha256"]
        else:
            demand(grant is not None, "GOOGLE_CALENDAR_OBSERVER_GRANT_REQUIRED")
            token = grant["refreshToken"]
            owner = next(row for row in reviewed["grants"] if row["grantId"] == grant["grantId"])["ownerSha256"]
        if after_retirement:
            token = private.get("calendarObserverGrants", {}).get(selected["grantId"], private["verificationGrants"]["calendar"])
        bearer = access(client, token, owner)
        calendar_id = actual["calendars"].get(selected["calendarSha256"])
        demand(isinstance(calendar_id, str) and sha(calendar_id) == selected["calendarSha256"], "GOOGLE_ACTUAL_CALENDAR_BINDING_REQUIRED")
        first, second = client.events(bearer, calendar_id), client.events(bearer, calendar_id)
        demand(first == second, "GOOGLE_CALENDAR_EVENTS_CHANGED")
        rows = [row for row in actual["events"] if row["calendarSha256"] == selected["calendarSha256"]]
        expected = {}
        for row in rows:
            expected.setdefault(row["eventId"], []).append(row)
        # The selected staging Calendar is an affected operational scope. Lack
        # of private booking metadata cannot prove an unacknowledged legacy
        # event unrelated; every provider event must be accounted for.
        owned = first
        effects = []
        for row in owned:
            stored_rows = expected.get(row["eventId"], [])
            matches = bool(stored_rows) and all(
                stored["etag"] is not None and stored["etag"] == row["etag"] and stored["status"] in ("synced", "deleted") and
                row["status"] == ("cancelled" if stored["status"] == "deleted" else "confirmed") or
                stored.get("recordKind") in ("appointment-hold", "checkout-order") and stored["status"] in ("booked", "manual_rebooked") and
                row["status"] == "confirmed" and row["bookingHoldId" if stored["recordKind"] == "appointment-hold" else "checkoutOrderId"] == stored["recordId"]
                for stored in stored_rows)
            effects.append({"eventId": row["eventId"], "etag": row["etag"], "status": row["status"], "storedOutcomeConsistent": matches})
        missing = len(set(expected) - {row["eventId"] for row in owned})
        result.append({"calendarSha256": selected["calendarSha256"], "paginationComplete": True, "events": effects,
            "unresolvedEffects": missing + sum(not row["storedOutcomeConsistent"] for row in effects)})
    return result


def retire_grants(replacements, retired, redis, reviewed, private, actual, selected, attempt):
    """Closed recovery stage only; a shared preserved owner refuses before revoke."""
    demand(reviewed.get("projectId") == "lash-her-staging-20261022" and reviewed.get("projectNumber") == "185770842371",
        "GOOGLE_STAGING_DATABASE_BINDING_REQUIRED")
    transition = database_transition(reviewed, actual)
    migrate.write_json(attempt, "google-database-current-retirement.json", {**selected,
        "snapshot": actual["snapshot"], "transition": transition})
    # Both actual secrets must be usable before the supported console rotation.
    # Keep these exact private Client instances in memory throughout observation;
    # an arbitrary invalid string cannot be substituted after this preflight.
    for binding in reviewed["clients"]:
        kind = binding["kind"]
        for client in (replacements[kind], retired[kind]):
            access(client, private["verificationGrants"][kind], binding["verificationOwnerSha256"])
    migrate.write_json(attempt, "google-clients-before-retirement.json", {**selected,
        "sourceBindingSha256": reviewed["sourceBindingSha256"], "clients": reviewed["clients"], "bothSecretsRefreshVerified": True})
    clients = [{"kind": row["kind"], "clientId": CLIENTS[row["kind"]], "replacementRefreshVerified": True,
        "retiredSecretDenied": False} for row in reviewed["clients"]]
    legacy = redis.snapshot()
    if any(row["refreshToken"] is not None for row in legacy["grants"]):
        demand(reviewed.get("legacyCalendarSha256") is not None and any(row["calendarSha256"] == reviewed["legacyCalendarSha256"] for row in reviewed["calendars"]),
            "GOOGLE_LEGACY_DEFAULT_CALENDAR_BINDING_REQUIRED")
    nonsecret_legacy = {"grants": [{"grantId": row["grantId"], "present": row["refreshToken"] is not None} for row in legacy["grants"]],
        "stateKeySha256": sorted(sha(key) for key in legacy["stateKeys"])}
    redis_before = reviewed.get("redisBeforeSnapshot")
    demand(isinstance(redis_before, dict) and canonical(redis_before) == reviewed["redisSnapshotSha256"] and
        nonsecret_legacy["grants"] == redis_before.get("grants") and
        set(nonsecret_legacy["stateKeySha256"]) <= set(redis_before.get("stateKeySha256", [])), "GOOGLE_REDIS_SNAPSHOT_BINDING_REFUSED")
    grants = [*actual["grants"], *(row for row in legacy["grants"] if row["refreshToken"] is not None)]
    demand(sorted(row["grantId"] for row in grants) == sorted(row["grantId"] for row in reviewed["grants"]), "GOOGLE_COMPLETE_GRANT_INVENTORY_REQUIRED")
    resolved = []
    for row in grants:
        binding = next(item for item in reviewed["grants"] if item["grantId"] == row["grantId"])
        access(replacements["calendar"], row["refreshToken"], binding["ownerSha256"])
        resolved.append((row, binding))
    preserved = {binding["ownerSha256"] for _row, binding in resolved if binding["disposition"] == "preserve"}
    demand(not any(binding["ownerSha256"] in preserved for _row, binding in resolved if binding["disposition"] == "retire"),
        "GOOGLE_PROJECT_WIDE_REVOCATION_WOULD_AFFECT_PRESERVED_GRANT")
    effects = reconcile_events(replacements["calendar"], private, reviewed, {**actual, "grants": grants})
    demand(all(row["unresolvedEffects"] == 0 for row in effects), "GOOGLE_ACCEPTED_EVENTS_REQUIRE_RECONCILIATION")
    outcome = {**selected, "provider": "google", "status": "GOOGLE_GRANT_RETIREMENT_REQUIRES_REVIEW", "clients": clients,
        "databaseTransition": transition,
        "continuationScope": "isolated-redis/calendar-oauth-state-only",
        "databaseSnapshotSha256": reviewed["databaseSnapshotSha256"], "redisSnapshotSha256": reviewed["redisSnapshotSha256"],
        "events": effects, "retiredGrantIds": [], "preservedGrantIds": sorted(row["grantId"] for row, binding in resolved if binding["disposition"] == "preserve"),
        "uncertainGrantId": None, "uncertainOAuthStateSha256": None, "pendingOAuthContinuations": len(legacy["stateKeys"]), "activeExecutions": None, "uncertainEffects": None}
    migrate.write_json(attempt, "google-retirement-started.json", outcome)
    try:
        deadline = time.monotonic() + 300
        recorded_clients = set()
        while True:
            clients = observe_clients(replacements, retired, reviewed, private)
            outcome["clients"] = clients
            for row in clients:
                if row["retiredSecretDenied"] and row["kind"] not in recorded_clients:
                    migrate.write_json(attempt, "google-client-" + row["kind"] + "-retired.json", {**selected, **row})
                    recorded_clients.add(row["kind"])
            if all(row["retiredSecretDenied"] for row in clients):
                break
            demand(time.monotonic() < deadline, "GOOGLE_SUPPORTED_CONSOLE_SECRET_RETIREMENT_UNVERIFIED")
            time.sleep(1)
        # Google's documented revoke affects the owner's entire project grant,
        # including other clients. One request per owner avoids unnecessary
        # repeated revocations; every selected stored grant still gets denial.
        owners = set()
        for row, binding in resolved:
            if binding["disposition"] == "preserve":
                continue
            outcome["uncertainGrantId"] = row["grantId"]
            if binding["ownerSha256"] not in owners:
                replacements["calendar"].revoke(row["refreshToken"])
                owners.add(binding["ownerSha256"])
            status, value = replacements["calendar"].refresh(row["refreshToken"])
            demand(status == 400 and value == {"error": "invalid_grant"}, "GOOGLE_RETIRED_GRANT_DENIAL_UNVERIFIED")
            outcome["retiredGrantIds"].append(row["grantId"])
            migrate.write_json(attempt, "google-grant-" + sha(row["grantId"]) + "-retired.json", {**selected, "grantId": row["grantId"], "ownerSha256": binding["ownerSha256"], "refreshDenied": True})
            outcome["uncertainGrantId"] = None
        for key in legacy["stateKeys"]:
            outcome["uncertainOAuthStateSha256"] = sha(key)
            acknowledgement = redis.command(["DEL", key])
            demand(acknowledgement in (0, 1), "GOOGLE_CONTINUATION_DELETE_ACK_UNVERIFIED")
            migrate.write_json(attempt, "google-oauth-state-" + sha(key) + "-closed.json", {**selected,
                "stateKeySha256": sha(key), "deleteAcknowledgement": acknowledgement})
            outcome["uncertainOAuthStateSha256"] = None
        after = redis.snapshot()
        demand(not after["stateKeys"] and [{"grantId": row["grantId"], "present": row["refreshToken"] is not None} for row in after["grants"]] == nonsecret_legacy["grants"],
            "GOOGLE_CONTINUATION_OR_LEGACY_GRANT_DRIFT")
        outcome.update(status="GOOGLE_SELECTED_GRANTS_RETIRED_CONTINUATIONS_CLOSED", pendingOAuthContinuations=0,
            uncertainGrantId=None, uncertainEffects=0)
        return outcome
    finally:
        migrate.write_json(attempt, "google-retirement-outcome.json", outcome)


def observe(replacements, retired, redis, reviewed, private, actual):
    transition = database_transition(reviewed, actual)
    clients = observe_clients(replacements, retired, reviewed, private)
    first, second = redis.snapshot(), redis.snapshot()
    demand(first == second, "GOOGLE_LEGACY_REDIS_CHANGED")
    grants = [*actual["grants"], *(row for row in first["grants"] if row["refreshToken"] is not None)]
    demand(sorted(row["grantId"] for row in grants) == sorted(row["grantId"] for row in reviewed["grants"]), "GOOGLE_COMPLETE_GRANT_INVENTORY_REQUIRED")
    observations = []
    for row in grants:
        selected = next(item for item in reviewed["grants"] if item["grantId"] == row["grantId"])
        status, value = replacements["calendar"].refresh(row["refreshToken"])
        if selected["disposition"] == "retire":
            verified = status == 400 and value == {"error": "invalid_grant"}
        else:
            verified = status == 200 and isinstance(value.get("access_token"), str) and \
                replacements["calendar"].profile(value["access_token"]) == selected["ownerSha256"]
        observations.append({"grantId": row["grantId"], "disposition": selected["disposition"], "stateVerified": verified})
    effects = reconcile_events(replacements["calendar"], private, reviewed, {**actual, "grants": grants}, after_retirement=True)
    return {"provider": "google", "status": "GOOGLE_STAGING_SCOPES_OBSERVED", "clients": clients, "grants": observations,
        "databaseTransition": transition,
        "continuationScope": "isolated-redis/calendar-oauth-state-only",
        "events": effects, "redisPaginationComplete": True, "pendingOAuthContinuations": len(first["stateKeys"]),
        "databaseSnapshotSha256": reviewed["databaseSnapshotSha256"], "activeExecutions": None,
        "uncertainEffects": sum(not row["stateVerified"] for row in observations) + sum(row["unresolvedEffects"] for row in effects) +
            sum(not row["retiredSecretDenied"] for row in clients) + len(first["stateKeys"])}
