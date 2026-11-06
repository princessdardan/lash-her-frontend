"""Read-only historical Chit Chats quote, cache and draft reconciliation.

The host supplies a locked staging client and private, actual repeatable-read SQL
rows. Raw destinations, provider bodies and job payloads never leave normalization.
No writes, ambient credentials, provider replay, cleanup or activation are exposed.
"""
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from functools import wraps
import hashlib
import json
import re

import frontend_crm_shipping_retirement as shipping

MAXIMUM_ROWS = 4096
C07_SOURCE = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6"
C07_PROBE_BLOBS = {
    "src/lib/shipping/flat-rate-refresh.ts": "b2aef69e61cebe3209afd2772eb897522b93fb9603ecc98f681dfb0795114d83",
    "src/lib/shipping/flat-rate-zones.ts": "93134cc887608ee6b0c47172c2cbdd3b4500f39245adf5a2f04f622b6167ee62",
    "src/lib/shipping/chitchats-client.ts": "0b1dbff35cb5350649757e3588833ae78104423b1e51e88e6bac2bf2ab476da1",
}
FAMILIES = ("chitchats.drafts", "chitchats.postage", "chitchats.refunds", "chitchats.tracking")
JOB_TYPES = {"create", "quote_refresh", "purchase", "tracking", "refund", "delete", "cleanup", "replacement_prepare", "address_replace", "notification"}
DRAFT_STATES = {"unpaid", "pending"}
QUOTE_STATES = {"quoted", "payment_pending", "ready_for_staff"}
DELETE_CODES = {"provider_deleted", "provider_deleted_reconciled", "provider_not_found"}
ZONES = {"ca_on": ("Toronto", "ON", "M5V 2T6", "CA"), "ca_qc_atlantic": ("Montreal", "QC", "H2Y 1C6", "CA"),
    "ca_prairies": ("Calgary", "AB", "T2P 1J9", "CA"), "ca_bc": ("Vancouver", "BC", "V6B 1A1", "CA"),
    "ca_north": ("Whitehorse", "YT", "Y1A 2C6", "CA"), "us_northeast": ("New York", "NY", "10001", "US"),
    "us_midwest": ("Chicago", "IL", "60601", "US"), "us_south": ("Atlanta", "GA", "30303", "US"), "us_west": ("Los Angeles", "CA", "90012", "US")}
PARCELS = {"xs": (250, 20, 15, 3), "s": (500, 25, 18, 4), "m": (1000, 30, 22, 6),
    "l": (2000, 34, 24, 8), "xl": (3000, 36, 26, 12), "xxl": (4500, 40, 30, 18)}
demand = shipping.demand
sha = shipping.snapshot_sha256


def _safe_errors(function):
    @wraps(function)
    def safe(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError, UnicodeError) as error:
            message = str(error)
            if re.fullmatch(r"(?:CHITCHATS_TRANSIENT|CRM_SHIPPING|CHITCHATS_CLIENT)_[A-Z0-9_]+", message):
                raise ValueError(message) from None
            raise ValueError("CHITCHATS_TRANSIENT_OBSERVATION_REFUSED") from None
    return safe


def _review(value):
    shipping.review("chitchats", value)
    demand(isinstance(value.get("sourceCommit"), str) and re.fullmatch(r"[a-f0-9]{40}", value["sourceCommit"]) and
        all(shipping.digest(value.get(key)) for key in ("sourceInventorySha256", "requirementsSha256")), "CHITCHATS_TRANSIENT_SOURCE_BINDING_REQUIRED")
    return value


def read_only_request(method, path, body, reviewed):
    """Narrow transport seam; caller retains the fixed staging origin/credentials.
    Detail IDs must belong to the reviewed complete current provider inventory.
    """
    _review(reviewed)
    prefix = "/api/v1/clients/" + reviewed["clientId"] + "/shipments"
    return method == "GET" and body is None and bool(path == prefix + "/count" or
        re.fullmatch(re.escape(prefix) + r"\?limit=100&page=([1-9][0-9]{0,2})", path) or
        path in (prefix + "/" + identifier for identifier in reviewed["expectedProviderShipmentIds"]))


def _operation_hash(value):
    # Exact source JSON subset. JSON.stringify emits UTF-8 unicode, not Python's
    # ensure_ascii representation. Reject unsafe-number/nonstandard-key inputs
    # rather than claiming equality under a different canonicalizer.
    def supported(item):
        if item is None or type(item) in (bool, str):
            return True
        if type(item) is int:
            return abs(item) <= 9007199254740991
        if isinstance(item, list):
            return all(supported(part) for part in item)
        if isinstance(item, dict):
            return len({key.lower() for key in item if isinstance(key, str)}) == len(item) and all(isinstance(key, str) and re.fullmatch(r"[a-z][A-Za-z0-9]*", key) and supported(part) for key, part in item.items())
        return False
    def ordered(item):
        if isinstance(item, dict):
            return {key: ordered(item[key]) for key in sorted(item, key=lambda key: key.lower())}
        if isinstance(item, list):
            return [ordered(part) for part in item]
        return item
    if not supported(value):
        return None
    return hashlib.sha256(json.dumps(ordered(value), separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def database_queries(reviewed):
    """Private rows only. Execute all SELECTs in one READ ONLY REPEATABLE READ
    transaction before/after the provider reads; compare normalized snapshots.
    LIMIT includes an overflow sentinel: 4097 rows always refuses, never truncates.
    These tables have no tenant column; all Chit Chats rows are conservatively
    selected, including unattached quotes and superseded/replacement generations.
    """
    _review(reviewed)
    return [
        ("shipments", "SELECT id::text, order_id::text, public_reference, provider_shipment_id, provider_status, status::text, state_version, flat_rate, purpose::text, supersedes_shipment_id::text, quote_fingerprint, quote_expires_at::text, selected_postage_type, actual_purchase_total_cents, provider_cost_currency, purchased_at::text, signature_requested, destination, package_snapshot, customs_lines, rates, raw_shipment, created_at::text, updated_at::text FROM product_shipments WHERE provider='chitchats' ORDER BY id LIMIT 4097", []),
        ("jobs", "SELECT j.id::text, j.shipment_id::text, j.type::text, j.status::text, j.state_version, encode(sha256(convert_to(j.idempotency_key,'UTF8')),'hex') AS idempotency_sha256, j.attempt_count, j.operation_payload_hash, j.payload, j.outcome_unknown, (j.lease_owner IS NOT NULL) AS lease_owner_present, j.lease_expires_at::text, j.available_at::text, j.next_attempt_at::text, j.outcome_code, j.completed_at::text, j.created_at::text, j.updated_at::text FROM product_shipment_jobs j JOIN product_shipments s ON s.id=j.shipment_id WHERE s.provider='chitchats' ORDER BY j.id LIMIT 4097", []),
        ("rateCache", "SELECT id::text, zone_id, size_bucket_id, country_code, postage_type, amount_cents, currency, delivery_max_business_days, insured, tracked, computed_at::text, created_at::text, updated_at::text FROM shipping_rate_cache ORDER BY id LIMIT 4097", []),
        ("events", "SELECT e.id::text, e.shipment_id::text, encode(sha256(convert_to(e.fingerprint,'UTF8')),'hex') AS fingerprint_sha256, e.provider_status, e.normalized_status::text, e.occurred_at::text, e.created_at::text FROM product_shipment_events e JOIN product_shipments s ON s.id=e.shipment_id WHERE s.provider='chitchats' ORDER BY e.id LIMIT 4097", []),
    ]


COLUMNS = {
    "shipments": "id order_id public_reference provider_shipment_id provider_status status state_version flat_rate purpose supersedes_shipment_id quote_fingerprint quote_expires_at selected_postage_type actual_purchase_total_cents provider_cost_currency purchased_at signature_requested destination package_snapshot customs_lines rates raw_shipment created_at updated_at",
    "jobs": "id shipment_id type status state_version idempotency_sha256 attempt_count operation_payload_hash payload outcome_unknown lease_owner_present lease_expires_at available_at next_attempt_at outcome_code completed_at created_at updated_at",
    "rateCache": "id zone_id size_bucket_id country_code postage_type amount_cents currency delivery_max_business_days insured tracked computed_at created_at updated_at",
    "events": "id shipment_id fingerprint_sha256 provider_status normalized_status occurred_at created_at",
}


def _text_hash(value):
    return hashlib.sha256(value.encode()).hexdigest() if isinstance(value, str) else None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = Decimal(str(value))
        return format(number.normalize(), 'f') if number.is_finite() else None
    except InvalidOperation:
        return None


def _body(value, provider=False):
    """Private comparison projection; hash text (including every customs field)
    without persisting names, addresses, email, label URLs or raw provider data.
    Missing required data stays null and cannot satisfy a draft-body receipt.
    """
    if not isinstance(value, dict):
        return None
    recipient = value if provider else value.get("destination", {})
    package = value if provider else value.get("package_snapshot", {})
    if not isinstance(recipient, dict) or not isinstance(package, dict):
        return None
    pairs = [("to_name", "name"), ("to_address_1", "line1"), ("to_address_2", "line2"), ("to_city", "city"),
        ("to_province_code", "province"), ("to_postal_code", "postalCode"), ("to_country_code", "countryCode"),
        ("to_phone", "phone"), ("to_email", "email")]
    result = {left: _text_hash(recipient.get(left if provider else right) or "") for left, right in pairs}
    result.update({"package_type": package.get("package_type" if provider else "packageType") if package.get("package_type" if provider else "packageType") in {"parcel", "letter", "envelope", "thick_envelope", "card"} else None,
        "weight_unit": value.get("weight_unit") if provider else "g", "size_unit": value.get("size_unit") if provider else "cm"})
    for left, right in (("weight", "totalWeightGrams"), ("size_x", "lengthCm"), ("size_y", "widthCm"), ("size_z", "heightCm")):
        result[left] = _number(package.get(left if provider else right))
    return result


def _customs(lines, provider=False):
    if not isinstance(lines, list):
        return None
    output = []
    for line in lines:
        if not isinstance(line, dict):
            return None
        result = {}
        for left, right in (("description", "description"), ("hs_tariff_code", "hsTariffCode"), ("sku_code", "sku"), ("origin_country", "countryOfOrigin"),
            ("manufacturer_contact", "manufacturerName"), ("manufacturer_street", "manufacturerAddress"), ("manufacturer_city", "manufacturerCity"),
            ("manufacturer_province_code", "manufacturerProvinceCode"), ("manufacturer_postal_code", "manufacturerPostalCode"), ("manufacturer_country_code", "manufacturerCountryCode")):
            result[left] = _text_hash(line.get(left if provider else right) or "")
        result.update(quantity=_number(line.get("quantity")), weight=_number(line.get("weight" if provider else "unitWeightGrams")),
            valueCents=shipping._money(line.get("value_amount")) if provider else line.get("unitValueCents") if type(line.get("unitValueCents")) is int else None,
            weightUnit="g" if not provider or line.get("weight_unit") == "g" else None, currency="cad" if not provider or line.get("currency_code") in ("cad", "CAD") else None)
        output.append(result)
    return output


@_safe_errors
def normalize_snapshot(actual_rows):
    demand(isinstance(actual_rows, dict) and set(actual_rows) == set(COLUMNS), "CHITCHATS_TRANSIENT_PRIVATE_SNAPSHOT_REQUIRED")
    result = {}
    for kind, rows in actual_rows.items():
        demand(isinstance(rows, list) and len(rows) <= MAXIMUM_ROWS and all(isinstance(row, dict) and set(row) == set(COLUMNS[kind].split()) for row in rows), "CHITCHATS_TRANSIENT_COLUMN_OR_LIMIT_REFUSED")
        demand(all(shipping.identifier(row.get("id")) for row in rows) and len({row["id"] for row in rows}) == len(rows), "CHITCHATS_TRANSIENT_ROW_ID_REFUSED")
        safe = []
        for row in rows:
            item = deepcopy(row)
            if kind == "shipments":
                demand(shipping.identifier(row.get("public_reference")) and (row["provider_shipment_id"] is None or shipping.identifier(row["provider_shipment_id"])) and
                    type(row["state_version"]) is int and row["state_version"] > 0 and type(row["flat_rate"]) is bool and type(row["signature_requested"]) is bool, "CHITCHATS_TRANSIENT_REFERENCE_REFUSED")
                item["body"] = _body(row)
                item["stored_provider_body"] = _body(row["raw_shipment"], True)
                item["customs"] = _customs(row["customs_lines"])
                lines = row["customs_lines"]
                item["description_sha256"] = _text_hash(", ".join(line["description"] for line in lines)[:255]) if isinstance(lines, list) and all(isinstance(line, dict) and isinstance(line.get("description"), str) for line in lines) else None
                item["cross_border"] = row["destination"].get("countryCode") != "CA" if isinstance(row["destination"], dict) else None
                for key in ("destination", "package_snapshot", "customs_lines", "rates", "raw_shipment"):
                    item[key + "_sha256"] = sha(item.pop(key))
                item["quote_fingerprint_sha256"] = _text_hash(item.pop("quote_fingerprint"))
                item["selected_postage_type_sha256"] = _text_hash(item.pop("selected_postage_type"))
            elif kind == "jobs":
                payload = item.pop("payload")
                code = item.pop("outcome_code")
                item["outcome_code_sha256"] = _text_hash(code)
                item["outcome_code"] = code if code in DELETE_CODES else None
                item["payload_sha256"] = _operation_hash(payload) or sha(payload)
                item["payload_matches_stored_hash"] = isinstance(payload, dict) and _operation_hash(payload) == row["operation_payload_hash"]
                # Source payload numbers/booleans only. Other fields remain
                # hash-bound without being forwarded into any receipt.
                item["intent"] = {key: payload.get(key) for key in ("merchandiseValueCents", "atRiskValueCents", "signatureRequested", "expectedShipmentStateVersion")
                    if isinstance(payload, dict) and (type(payload.get(key)) in (int, bool) or payload.get(key) is None)}
            elif kind == "rateCache":
                item["postage_type_sha256"] = _text_hash(item.pop("postage_type"))
                item["zone_id_sha256"] = _text_hash(item.pop("zone_id"))
                item["size_bucket_id_sha256"] = _text_hash(item.pop("size_bucket_id"))
            safe.append(item)
        result[kind] = sorted(safe, key=lambda item: item["id"])
    shipment_ids = {row["id"] for row in result["shipments"]}
    demand(all(row["shipment_id"] in shipment_ids for kind in ("jobs", "events") for row in result[kind]), "CHITCHATS_TRANSIENT_ORPHAN_DATABASE_RECEIPT")
    return result


def _source_requirements(reviewed, verified):
    demand(isinstance(verified, dict) and verified.get("version") == 1 and verified.get("status") == "FRONTEND_HISTORICAL_SOURCE_VERIFIED" and
        all(verified.get(key) == reviewed[key] for key in ("sourceCommit", "sourceInventorySha256", "requirementsSha256")), "CHITCHATS_TRANSIENT_VERIFIED_SOURCE_REQUIRED")
    families = verified.get("providerFamilies")
    demand(isinstance(families, list), "CHITCHATS_TRANSIENT_SOURCE_FAMILIES_REQUIRED")
    selected = [row for row in families if isinstance(row, dict) and row.get("familyId") in FAMILIES and row.get("provider") in (None, "chitchats")]
    demand({row.get("familyId") for row in selected} == set(FAMILIES) and len(selected) == len(FAMILIES), "CHITCHATS_TRANSIENT_SOURCE_FAMILY_COVERAGE_REQUIRED")
    for row in selected:
        demand(row.get("sourceDisposition") in ("reachable", "absent-from-verified-source") and isinstance(row.get("untrackedPotentialRequests"), list) and
            isinstance(row.get("annotations"), list), "CHITCHATS_TRANSIENT_SOURCE_FAMILY_REFUSED")
    draft = next(row for row in selected if row["familyId"] == "chitchats.drafts")
    annotations = {row.get("file"): row.get("sha256") for row in draft["annotations"] if isinstance(row, dict)}
    profile_known = all(annotations.get(file) == digest for file, digest in C07_PROBE_BLOBS.items())
    # Independent audited fact: C07 has untracked POST -> best-effort DELETE.
    # A caller false flag, current config, cache timestamp or stable list cannot
    # override it. Later source profiles must positively describe their gaps.
    c07 = reviewed["sourceCommit"] == C07_SOURCE or profile_known
    if c07:
        demand(draft["sourceDisposition"] == "reachable" and bool(draft["untrackedPotentialRequests"]), "CHITCHATS_TRANSIENT_C07_UNTRACKED_GAP_REQUIRED")
    closures = verified.get("capabilityClosures", [])
    demand(isinstance(closures, list), "CHITCHATS_TRANSIENT_SOURCE_CLOSURES_REFUSED")
    closed, required = {}, {}
    def ids(rows):
        demand(isinstance(rows, list) and all(isinstance(item, dict) and isinstance(item.get("requirementId"), str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,192}", item["requirementId"]) for item in rows), "CHITCHATS_TRANSIENT_SOURCE_REQUIREMENT_REFUSED")
        return {item["requirementId"] for item in rows}
    global_ids = ids(verified.get("sqlCredentialRequirements", []))
    for family in selected:
        family_id = family["familyId"]
        required[family_id] = global_ids | set().union(*(ids(family.get(key, [])) for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests")))
        matches = [item for item in closures if isinstance(item, dict) and item.get("familyId") == family_id]
        demand(len(matches) <= 1, "CHITCHATS_TRANSIENT_DUPLICATE_SOURCE_CLOSURE")
        if matches:
            closure = matches[0]
            demand(closure.get("disposition") in ("no-capability-observed", "absent-from-verified-source") and
                isinstance(closure.get("requirementIds"), list) and closure["requirementIds"] == sorted(required[family_id]) and
                isinstance(closure.get("evidenceIds"), list) and bool(closure["evidenceIds"]) and closure["evidenceIds"] == sorted(set(closure["evidenceIds"])) and
                all(shipping.digest(item) for item in closure["evidenceIds"]), "CHITCHATS_TRANSIENT_SOURCE_CLOSURE_COVERAGE_REFUSED")
            demand(closure["disposition"] != "absent-from-verified-source" or family["sourceDisposition"] == "absent-from-verified-source", "CHITCHATS_TRANSIENT_SOURCE_CLOSURE_DISPOSITION_REFUSED")
            closed[family_id] = {key: deepcopy(closure[key]) for key in ("familyId", "disposition", "requirementIds", "evidenceIds")}
        elif family["sourceDisposition"] == "absent-from-verified-source":
            # Source absence alone cannot erase a credential capable of having
            # accepted historical requests; original SQL provenance is required.
            required[family_id].add(family_id + ".original-capability-closure")
    return selected, profile_known, closed, required


def _safe_remote(row):
    demand(isinstance(row, dict) and shipping.identifier(row.get("id")) and isinstance(row.get("status"), str) and re.fullmatch(r"[a-z_]{1,40}", row["status"]), "CHITCHATS_TRANSIENT_PROVIDER_RESPONSE_REFUSED")
    # Unknown order references are hashed, never echoed as arbitrary provider text.
    return {"id": row["id"], "status": row["status"], "orderReferenceSha256": _text_hash(row.get("order_id")),
        "postageTypeSha256": _text_hash(row.get("postage_type")), "purchaseCents": shipping._money(row.get("purchase_amount")),
        "declaredValueCents": shipping._money(row.get("value")), "currency": row.get("value_currency") if row.get("value_currency") in ("cad", "CAD", "usd", "USD") else None,
        "body": _body(row, True), "signatureRequested": row.get("is_signature_requested"), "insuranceRequested": row.get("is_insurance_requested"),
        "customs": _customs(row.get("line_items"), True), "descriptionSha256": _text_hash(row.get("description")),
        "packageContents": "merchandise" if row.get("package_contents") == "merchandise" else None, "orderStore": "other" if row.get("order_store") == "other" else None}


def _inventory(client, reviewed):
    prefix = "/api/v1/clients/" + reviewed["clientId"] + "/shipments"
    before = client.request("GET", prefix + "/count")
    count = before.get("count") if isinstance(before, dict) else None
    demand(type(count) is int and 0 <= count <= MAXIMUM_ROWS, "CHITCHATS_TRANSIENT_PROVIDER_COUNT_REFUSED")
    summaries = {}
    for page in range(1, 43):
        value = client.request("GET", prefix + "?limit=100&page=" + str(page))
        rows = value if isinstance(value, list) else value.get("shipments") if isinstance(value, dict) else None
        demand(isinstance(rows, list) and len(rows) <= 100, "CHITCHATS_TRANSIENT_PROVIDER_PAGE_REFUSED")
        for row in rows:
            item = _safe_remote(row)
            demand(item["id"] not in summaries and len(summaries) < MAXIMUM_ROWS, "CHITCHATS_TRANSIENT_PROVIDER_DUPLICATE_OR_LIMIT")
            summaries[item["id"]] = item
        if len(rows) < 100:
            break
    else:
        raise ValueError("CHITCHATS_TRANSIENT_PROVIDER_PAGINATION_LIMIT")
    demand(client.request("GET", prefix + "/count") == before and len(summaries) == count and sorted(summaries) == reviewed["expectedProviderShipmentIds"], "CHITCHATS_TRANSIENT_PROVIDER_INVENTORY_MISMATCH")
    for identifier, summary in summaries.items():
        value = client.request("GET", prefix + "/" + identifier)
        detail = _safe_remote(value.get("shipment") if isinstance(value, dict) else None)
        demand(summary == detail, "CHITCHATS_TRANSIENT_PROVIDER_DETAIL_CHANGED")
    return summaries


def _settled(job):
    return (job["type"] in JOB_TYPES and job["status"] == "succeeded" and job["outcome_unknown"] is False and
        job["lease_owner_present"] is False and job["lease_expires_at"] is None and job["completed_at"] is not None and
        job["payload_matches_stored_hash"] and shipping.digest(job["idempotency_sha256"]) and type(job["attempt_count"]) is int and job["attempt_count"] > 0 and
        type(job["state_version"]) is int and job["state_version"] > 0)


def _body_complete(body):
    return isinstance(body, dict) and all(body.get(key) is not None for key in body) and all(body.get(key) != _text_hash("") for key in ("to_name", "to_address_1", "to_city", "to_province_code", "to_postal_code", "to_country_code")) and body["weight_unit"] == "g" and body["size_unit"] == "cm" and all(
        body[key] is not None and Decimal(body[key]) > 0 for key in ("weight", "size_x", "size_y", "size_z"))


def _probe_body(reference, remote):
    for zone, destination in ZONES.items():
        for bucket, parcel in PARCELS.items():
            if _text_hash(f"flat-rate-probe-{zone}-{bucket}") != reference:
                continue
            city, province, postal, country = destination
            weight, x, y, z = parcel
            body = _body({"destination": {"name": "Lash Her Rate Probe", "line1": "100 Main Street", "city": city, "province": province, "postalCode": postal,
                "countryCode": country, "phone": "4165550100", "email": "shipping-rates@lashher.com"}, "package_snapshot": {"packageType": "parcel", "totalWeightGrams": weight, "lengthCm": x, "widthCm": y, "heightCm": z}})
            customs = _customs([{"description": "Beauty merchandise", "quantity": 1, "unitValueCents": 6000, "unitWeightGrams": weight, "countryOfOrigin": "CA", "hsTariffCode": "3304200000", "sku": "PROBE-" + bucket.upper()}])
            match = (remote["body"] == body and remote["declaredValueCents"] == 6000 and remote["currency"] in ("cad", "CAD") and
                remote["signatureRequested"] is False and remote["insuranceRequested"] is True and remote["descriptionSha256"] == _text_hash("Beauty merchandise") and
                remote["packageContents"] == "merchandise" and remote["orderStore"] == "other" and
                (country == "CA" or remote["customs"] == customs))
            return {"zoneId": zone, "sizeBucketId": bucket, "bodyMatchesAuditedProbe": match}
    return None


@_safe_errors
def observe_scoped_effects(privateLockedClient, reviewed, actualRows, verifiedSourceRequirements):
    _review(reviewed)
    families, profile_known, closures, required = _source_requirements(reviewed, verifiedSourceRequirements)
    actual = normalize_snapshot(actualRows)
    providers = _inventory(privateLockedClient, reviewed)
    jobs = {row["id"]: row for row in actual["jobs"]}
    by_shipment = {}
    for job in jobs.values():
        by_shipment.setdefault(job["shipment_id"], []).append(job)
    receipts, seen = [], set()
    for row in actual["shipments"]:
        related = by_shipment.get(row["id"], [])
        settled = bool(related) and all(_settled(job) for job in related)
        candidates = [remote for remote in providers.values() if remote["orderReferenceSha256"] == _text_hash(row["public_reference"])]
        remote = candidates[0] if len(candidates) == 1 else None
        item = row["provider_shipment_id"]
        exact = remote is not None and item == remote["id"]
        if remote is not None:
            seen.add(remote["id"])
        outcome = "unresolved-intent-or-provider-receipt"
        deferred = False
        if exact and settled:
            normalized = shipping.ACKNOWLEDGED_SHIPMENT_STATES.get(remote["status"])
            if (normalized and normalized == row["status"] and shipping.ACKNOWLEDGED_SHIPMENT_STATES.get(row["provider_status"]) == normalized and
                remote["postageTypeSha256"] == row["selected_postage_type_sha256"] and type(row["actual_purchase_total_cents"]) is int and
                remote["purchaseCents"] == row["actual_purchase_total_cents"] and row["provider_cost_currency"] == "CAD" and row["purchased_at"] is not None and
                any(job["type"] in ("purchase", "tracking", "refund") for job in related)):
                outcome, deferred = "acknowledged-purchased-shipment", normalized not in ("delivered", "voided")
            elif (remote["status"] in DRAFT_STATES and row["status"] in QUOTE_STATES and row["provider_status"] in DRAFT_STATES and row["purchased_at"] is None and
                remote["purchaseCents"] in (None, 0) and _body_complete(row["body"]) and row["body"] == remote["body"] == row["stored_provider_body"] and
                remote["signatureRequested"] == row["signature_requested"] and remote["insuranceRequested"] is True and remote["currency"] in ("cad", "CAD") and
                remote["packageContents"] == "merchandise" and remote["orderStore"] == "other" and remote["descriptionSha256"] == row["description_sha256"] and
                row["description_sha256"] is not None and (row["cross_border"] is False or row["cross_border"] is True and row["customs"] is not None and row["customs"] == remote["customs"]) and any(job["type"] in ("create", "quote_refresh") and
                    remote["declaredValueCents"] in (job["intent"].get("merchandiseValueCents"), job["intent"].get("atRiskValueCents")) and remote["declaredValueCents"] is not None for job in related)):
                outcome, deferred = "acknowledged-unpurchased-quote-draft", True
        elif not candidates and row["status"] == "abandoned" and settled and any(job["type"] in ("delete", "cleanup") and job["outcome_code"] in DELETE_CODES for job in related):
            # Requires positive persisted deletion result as well as full inventory;
            # never treats provider absence alone as the deletion receipt.
            outcome = "acknowledged-draft-deletion"
        elif row["flat_rate"] is True and item is None and not candidates and not related and row["status"] in QUOTE_STATES and row["purchased_at"] is None and row["raw_shipment_sha256"] == sha(None):
            # Pure local cache quote has never acquired provider work. The
            # untracked cache refresher's separate source gap is retained below.
            outcome = "local-flat-rate-quote-without-provider-intent"
        receipts.append({"recordId": row["id"], "databaseRowSha256": sha(row), "providerId": remote["id"] if remote else item,
            "providerStatus": remote["status"] if remote else None, "classification": outcome, "reconciled": outcome != "unresolved-intent-or-provider-receipt",
            "deferredCompatibleWork": deferred, "operationIds": sorted(job["id"] for job in related)})
    for identifier in sorted(set(providers) - seen):
        remote = providers[identifier]
        probe = _probe_body(remote["orderReferenceSha256"], remote) if profile_known else None
        receipts.append({"providerId": identifier, "providerObservationSha256": sha(remote), "providerStatus": remote["status"],
            "classification": "source-matching-unreceipted-rate-probe" if probe and probe["bodyMatchesAuditedProbe"] else "unmapped-provider-object",
            "reconciled": False, "unresolvedReason": "no-durable-request-intent-or-completion-receipt", "probe": probe})
    job_receipts = [{"recordId": row["id"], "shipmentId": row["shipment_id"], "databaseRowSha256": sha(row), "type": row["type"] if row["type"] in JOB_TYPES else "unknown",
        "idempotencySha256": row["idempotency_sha256"], "payloadSha256": row["payload_sha256"], "settled": _settled(row)} for row in jobs.values()]
    gaps = [{"familyId": row["familyId"], "reason": "source-allows-requests-without-an-exhaustive-durable-intent-receipt" if row["untrackedPotentialRequests"] else "original-source-configuration-and-credential-closure-missing",
        "missingRequirementIds": sorted(item["requirementId"] for item in row["untrackedPotentialRequests"]) if row["untrackedPotentialRequests"] else sorted(required[row["familyId"]])}
        for row in families if row["familyId"] not in closures and (row["untrackedPotentialRequests"] or row["sourceDisposition"] == "absent-from-verified-source")]
    covered = sorted({item["requirementId"] for row in families for item in row.get("sqlIntentRequirements", [])} |
        {item for closure in closures.values() for item in closure["requirementIds"]})
    missing = sorted({item for gap in gaps for item in gap["missingRequirementIds"]})
    # A complete current list is a consistency check, not a historical request
    # completion oracle. Pre-acknowledgement requests may not be visible yet.
    demand(providers == _inventory(privateLockedClient, reviewed), "CHITCHATS_TRANSIENT_PROVIDER_CHANGED_DURING_OBSERVATION")
    known_unknown = sum(not row["reconciled"] for row in receipts) + sum(not row["settled"] for row in job_receipts)
    active = sum(row["status"] == "processing" or row["lease_owner_present"] or row["lease_expires_at"] is not None for row in jobs.values())
    return {"provider": "chitchats", "status": "STAGING_CHITCHATS_TRANSIENT_EFFECTS_OBSERVED", "clientId": reviewed["clientId"],
        "sourceCommit": reviewed["sourceCommit"], "sourceInventorySha256": reviewed["sourceInventorySha256"], "requirementsSha256": reviewed["requirementsSha256"],
        "transientDatabaseSnapshotSha256": sha(actual), "providerInventorySha256": sha(providers), "providerInventoryComplete": True,
        "coveredFamilyIds": sorted(row["familyId"] for row in families), "coveredRequirementIds": covered, "missingRequirementIds": missing,
        "capabilityClosures": [closures[key] for key in sorted(closures)], "effects": receipts, "operations": job_receipts, "rateCacheReceipts": [{"recordId": row["id"], "databaseRowSha256": sha(row), "isRequestCompletionReceipt": False} for row in actual["rateCache"]],
        "eventReceipts": [{"recordId": row["id"], "databaseRowSha256": sha(row)} for row in actual["events"]], "sourceGaps": gaps,
        "knownActiveExecutions": active, "knownUncertainEffects": known_unknown, "activeExecutions": active if not gaps else None,
        "uncertainEffects": known_unknown if not gaps else None, "deferredCompatibleWorkRequired": any(row.get("deferredCompatibleWork") for row in receipts),
        "futurePollingAuthorized": False, "historicalWritersFenced": False, "trafficAuthorized": False}
