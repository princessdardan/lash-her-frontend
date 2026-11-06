"""Dormant S05 host component. No production authority or network adapter exists.

The public stage always refuses before inspecting its arguments or doing I/O.
Private helpers are data codecs, filesystem observations and replay models only.
They cannot construct a stage, authenticate a provider event, prove prior fsync,
qualify drain, or dispatch an HTTP request.
"""
import copy
import datetime as dt
import hashlib
import json
import math
import os
import re
import stat
import struct
import threading

__all__ = ["P2QMuxCaptureStage", "MuxCaptureError", "MuxCaptureUnavailable"]
JOINT_SCHEMA_SHA256 = "c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a"
PRODUCTION_ARM_AVAILABLE = False
SENDER_ACTIVATION_AVAILABLE = False
CAPTURE_ROOT = "/run/lash-her-p2q-mux-private/capture-root"
GATEWAY_CAPTURE_ROOT = "/mux-capture"
REPLAY_PATH = "/course/v1/webhooks/mux"


class MuxCaptureError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class MuxCaptureUnavailable(MuxCaptureError):
    pass


def _unavailable():
    raise MuxCaptureUnavailable("P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE")


class P2QMuxCaptureStage:
    """An unavailable entry, not a JSON/callback/test-issuer capability factory."""
    def __init__(self, *ignored, **ignored_keywords):
        _unavailable()

    def arm(self, *ignored, **ignored_keywords):
        _unavailable()

    def observe_capture(self, *ignored, **ignored_keywords):
        _unavailable()

    def open_authoring_window(self, *ignored, **ignored_keywords):
        _unavailable()

    def close_authoring_window(self, *ignored, **ignored_keywords):
        _unavailable()

    def authorize_case(self, *ignored, **ignored_keywords):
        _unavailable()

    def send_next(self, *ignored, **ignored_keywords):
        _unavailable()

    def open_replay_window(self, *ignored, **ignored_keywords):
        _unavailable()

    def close_replay_window(self, *ignored, **ignored_keywords):
        _unavailable()

    def finish(self, *ignored, **ignored_keywords):
        _unavailable()

    def abort(self, *ignored, **ignored_keywords):
        # No real stage can have been armed here. This is not a containment ACK.
        _unavailable()


_SAFE = 9_007_199_254_740_991
_SHA = re.compile(r"[a-f0-9]{64}\Z")
_ACTION = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_PROFILE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_PROVIDER = re.compile(r"[A-Za-z0-9_-]{1,255}\Z")
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
_REQUEST = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_RFC = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})\Z", re.ASCII)
_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z", re.ASCII)
_ROUTE = re.compile(r"/v1/[A-Za-z0-9_{}/-]{1,127}\Z")
_MAGIC = b"P2QMCAP1"
_KINDS = {
    "privateCommit": "P2Q_MUX_CAPTURE_COMMITTED", "safeCapture": "P2Q_MUX_CAPTURE_OBSERVED",
    "safeSendStarted": "P2Q_MUX_SEND_STARTED", "privateIntent": "P2Q_MUX_REPLAY_INTENT",
    "replayObservation": "P2Q_MUX_REPLAY_OBSERVED", "globalRequest": "P2Q_MUX_ADMITTED_REQUEST_OBSERVED",
    "windowSummary": "P2Q_MUX_GLOBAL_WINDOW_OBSERVED", "lease": "p2q-mux-controlled-capture-v2",
}
_OPS = ("ARM", "OPEN_AUTHORING_WINDOW", "CLOSE_AUTHORING_WINDOW", "OBSERVE_CAPTURE", "AUTHORIZE_CASE",
        "OPEN_REPLAY_WINDOW", "SEND_NEXT", "CLOSE_REPLAY_WINDOW", "FINISH", "ABORT")
_CASES = {"D1": (("video.asset.track.ready",), (0,)),
          "R1": (("video.asset.track.ready", "video.asset.track.deleted"), (1, 0)),
          "A1": (("video.asset.track.ready",), (0,))}
_EVENT_KEYS = "id type createdAt environmentId objectId assetId attemptId lessonId generation".split()
_CAPTURE_KEYS = "version kind leaseSha256 slot event requestId headerTimestamp capturedAt monotonicNanoseconds managedResponse localResponseFinished".split()
_KEYS = {
    "profileRef": "version id sha256".split(), "directoryIdentity": ["device", "inode"],
    "selection": "environmentId lessonId attemptId generation assetId uploadId".split(),
    "lease": ("version kind actionId caseId qualificationTargetProfile candidateSha256 operatorSourceClosureSha256 planSha256 "
              "configurationSha256 gatewayConfigurationSha256 gatewayProcessSha256 gatewayImageSha256 courseImageSha256 "
              "sourceWitnessSha256 issuedAt expiresAt maxCaptures maxReplayPosts selection captureRootIdentity actionDirectoryIdentity").split(),
    "event": _EVENT_KEYS, "managedResponse": ["id", "lessonId", "status"],
    "privateCommit": [*_CAPTURE_KEYS, "rawEnvelopeSha256", "rawEnvelopeBytes"], "safeCapture": _CAPTURE_KEYS,
    "safeSendStarted": "version kind leaseSha256 sequence captureSlot captureObservationSha256 createdAt".split(),
    "privateIntent": ("version kind leaseSha256 sequence captureSlot sendStartedSha256 expectedEnvelopeSha256 eventId "
                      "originalHeaderTimestamp issuedAt expiresAt").split(),
    "replayObservation": ("version kind leaseSha256 sequence captureSlot sendStartedSha256 requestId event headerTimestamp "
                          "observedAt monotonicNanoseconds managedResponse localResponseFinished").split(),
    "globalRequest": ("version kind leaseSha256 ordinal requestId category service method routeTemplate startedAt finishedAt "
                      "upstreamAttempted upstreamStatus localResponseFinished").split(),
    "admittedTotals": ["newWork", "recovery"],
    "windowSummary": ("version kind leaseSha256 startedAt closedAt admittedTotalsBefore admittedTotalsAfter records observationFailures").split(),
    "wireFrame": ["version", "operation"],
}
_GATEWAY_UID = 65532
_GATEWAY_GID = 65532
_HOST_UID = 0
_RAW_NAMES = ("capture-0.private", "capture-1.private")
_COMMIT_NAMES = ("capture-0.committed.json", "capture-1.committed.json")


def _need(condition, code="P2Q_MUX_DATA_REFUSED"):
    if not condition:
        raise MuxCaptureError(code)


def _int(value, low=0, high=_SAFE):
    return type(value) is int and low <= value <= high


def _match(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def _one(value, allowed):
    return type(value) is str and value in allowed


def _closed(value, kind):
    _need(type(value) is dict and all(type(key) is str for key in value) and set(value) == set(_KEYS[kind]))


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _canonical(value):
    def check(item, depth=0):
        _need(depth <= 32)
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            _need(-_SAFE <= item <= _SAFE)
        elif type(item) is str:
            _need(all(ord(char) < 128 for char in item))
        elif type(item) is list:
            for child in item:
                check(child, depth + 1)
        elif type(item) is dict:
            _need(all(type(key) is str and key.isascii() for key in item))
            for child in item.values():
                check(child, depth + 1)
        else:
            _need(False)
    check(value)
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf8")


def _instant(value):
    """Preserved RFC3339 value -> exact integer nanoseconds, without rounding."""
    _need(type(value) is str and len(value) <= 40)
    match = _RFC.fullmatch(value)
    _need(match is not None)
    year, month, day, hour, minute, second = map(int, match.groups()[:6])
    _need(1 <= year <= 9999 and hour <= 23 and minute <= 59 and second <= 59)
    try:
        ordinal = dt.date(year, month, day).toordinal() - dt.date(1970, 1, 1).toordinal()
    except ValueError:
        raise MuxCaptureError("P2Q_MUX_DATA_REFUSED") from None
    zone, offset = match.group(8), 0
    if zone != "Z":
        zh, zm = int(zone[1:3]), int(zone[4:6])
        _need(zh <= 23 and zm <= 59)
        offset = (zh * 3600 + zm * 60) * (1 if zone[0] == "+" else -1)
    fraction = int((match.group(7) or "").ljust(9, "0"))
    return ((ordinal * 86400 + hour * 3600 + minute * 60 + second - offset) * 1_000_000_000) + fraction


def _milliseconds(value):
    _need(_match(_UTC, value))
    return _instant(value) // 1_000_000


def _iso(milliseconds):
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    try:
        value = epoch + dt.timedelta(milliseconds=milliseconds)
    except (ValueError, OverflowError):
        raise MuxCaptureError("P2Q_MUX_DATA_REFUSED") from None
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _decimal(value, maximum=40, positive=False):
    return _match(_DECIMAL, value) and len(value) <= maximum and (not positive or value != "0")


def _validate(kind, value):
    _need(type(kind) is str and kind in _KEYS)
    _closed(value, kind)
    if kind == "profileRef":
        _need(_int(value["version"], 1, 1) and _match(_PROFILE, value["id"]) and
              _match(_SHA, value["sha256"]) and value["sha256"] != "0" * 64)
        return value
    if kind == "directoryIdentity":
        _need(_decimal(value["device"]) and _decimal(value["inode"], positive=True))
        return value
    if kind == "selection":
        _need(all(_match(_PROVIDER, value[key]) for key in ("environmentId", "assetId")) and
              all(_match(_UUID, value[key]) for key in ("lessonId", "attemptId")) and _int(value["generation"], 1, 2_147_483_647)
              and (value["uploadId"] is None or _match(_PROVIDER, value["uploadId"])))
        return value
    if kind == "event":
        _need(_one(value["type"], ("video.asset.track.ready", "video.asset.track.deleted")))
        _instant(value["createdAt"])
        _need(all(_match(_PROVIDER, value[key]) for key in ("id", "environmentId", "objectId", "assetId")) and
              all(_match(_UUID, value[key]) for key in ("attemptId", "lessonId")) and _int(value["generation"], 1, 2_147_483_647))
        return value
    if kind == "managedResponse":
        _need(_match(_UUID, value["id"]) and _match(_UUID, value["lessonId"]) and
              _one(value["status"], ("pending", "uploading", "processing", "ready", "errored")))
        return value
    if kind == "admittedTotals":
        _need(all(_int(item) for item in value.values()))
        return value
    _need(_int(value["version"], 2, 2))
    if kind == "wireFrame":
        _need(type(value["operation"]) is str and value["operation"] in _OPS)
        return value
    _need(type(value["kind"]) is str and value["kind"] == _KINDS[kind])
    for key, item in value.items():
        if key.endswith("Sha256"):
            _need(_match(_SHA, item))
    if kind == "lease":
        _need(_match(_ACTION, value["actionId"]) and type(value["caseId"]) is str and value["caseId"] in _CASES)
        _validate("profileRef", value["qualificationTargetProfile"])
        _validate("selection", value["selection"])
        for name in ("captureRootIdentity", "actionDirectoryIdentity"):
            _validate("directoryIdentity", value[name])
        count = len(_CASES[value["caseId"]][0])
        _need(_int(value["maxCaptures"], count, count) and _int(value["maxReplayPosts"], count, count))
        _need(0 < _milliseconds(value["expiresAt"]) - _milliseconds(value["issuedAt"]) <= 120000)
    elif kind in ("safeCapture", "privateCommit", "replayObservation"):
        for name in ("slot",) if kind != "replayObservation" else ("sequence", "captureSlot"):
            _need(_int(value[name], 0, 1))
        _validate("event", value["event"])
        _validate("managedResponse", value["managedResponse"])
        _need(value["managedResponse"]["id"] == value["event"]["attemptId"] and
              value["managedResponse"]["lessonId"] == value["event"]["lessonId"])
        _need(_match(_REQUEST, value["requestId"]) and _int(value["headerTimestamp"], 1, _SAFE // 1000) and
              _decimal(value["monotonicNanoseconds"], 30) and value["localResponseFinished"] is True)
        _milliseconds(value["observedAt"] if kind == "replayObservation" else value["capturedAt"])
        if kind == "privateCommit":
            _need(_int(value["rawEnvelopeBytes"], 23, 66708))
    elif kind in ("safeSendStarted", "privateIntent"):
        _need(_int(value["sequence"], 0, 1) and _int(value["captureSlot"], 0, 1))
        if kind == "safeSendStarted":
            _milliseconds(value["createdAt"])
        else:
            _need(_match(_PROVIDER, value["eventId"]) and _int(value["originalHeaderTimestamp"], 1, _SAFE // 1000))
            _need(_milliseconds(value["expiresAt"]) > _milliseconds(value["issuedAt"]))
    elif kind == "globalRequest":
        _need(_int(value["ordinal"], 0, 63) and _match(_REQUEST, value["requestId"]) and _one(value["category"], ("newWork", "recovery"))
              and _one(value["service"], ("course", "community")) and _one(value["method"], ("POST", "PUT", "PATCH", "DELETE"))
              and _match(_ROUTE, value["routeTemplate"]) and type(value["upstreamAttempted"]) is bool
              and (value["upstreamStatus"] is None or _int(value["upstreamStatus"], 100, 599))
              and (value["localResponseFinished"] is None or type(value["localResponseFinished"]) is bool))
        _need((value["upstreamAttempted"] or value["upstreamStatus"] is None) and
              (value["finishedAt"] is not None or value["localResponseFinished"] is not True))
        started = _milliseconds(value["startedAt"])
        if value["finishedAt"] is not None:
            _need(_milliseconds(value["finishedAt"]) >= started)
    elif kind == "windowSummary":
        start = _milliseconds(value["startedAt"])
        if value["closedAt"] is not None:
            _need(_milliseconds(value["closedAt"]) >= start)
        for name in ("admittedTotalsBefore", "admittedTotalsAfter"):
            if value[name] is not None:
                _validate("admittedTotals", value[name])
        _need(type(value["records"]) is list and len(value["records"]) <= 64 and _int(value["observationFailures"]))
        for index, row in enumerate(value["records"]):
            _validate("globalRequest", row)
            _need(row["ordinal"] == index and len(_canonical(row)) <= 768 and row["leaseSha256"] == value["leaseSha256"] and
                  _milliseconds(row["startedAt"]) >= start and
                  (value["closedAt"] is None or _milliseconds(row["startedAt"]) <= _milliseconds(value["closedAt"])))
        _need(len({row["requestId"] for row in value["records"]}) == len(value["records"]))
    return value


def _limit(kind):
    return 8192 if kind in ("lease", "privateIntent") else 768 if kind == "globalRequest" else 16384


def _encode(kind, value):
    _validate(kind, value)
    raw = _canonical(value)
    _need(len(raw) <= _limit(kind))
    return raw


def _decode(kind, raw):
    _need(type(kind) is str and kind in _KEYS)
    _need(type(raw) in (str, bytes, bytearray))
    try:
        original = raw.encode("utf8") if type(raw) is str else bytes(raw)
        _need(0 < len(original) <= _limit(kind))
        def pairs(items):
            result = {}
            for key, item in items:
                _need(key not in result)
                result[key] = item
            return result
        def reject(_value):
            raise MuxCaptureError("P2Q_MUX_DATA_REFUSED")
        value = json.loads(original.decode("utf8"), object_pairs_hook=pairs, parse_float=reject, parse_constant=reject)
        _need(_encode(kind, value) == original)
        return value
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError):
        raise MuxCaptureError("P2Q_MUX_DATA_REFUSED") from None


class _PrivateMaterial:
    __slots__ = ("signature", "content_type", "body")

    def __init__(self, signature, content_type, body):
        _need(all(type(item) in (bytes, bytearray) for item in (signature, content_type, body)))
        self.signature, self.content_type, self.body = map(bytearray, (signature, content_type, body))

    def __repr__(self):
        return "<private Mux material; redacted; not authority>"

    def __getstate__(self):
        raise MuxCaptureError("P2Q_MUX_PRIVATE_SERIALIZATION_REFUSED")

    def clear(self):
        for value in (self.signature, self.content_type, self.body):
            value[:] = b"\0" * len(value)
            value.clear()


def _envelope(signature, content_type, body):
    _need(all(type(item) in (bytes, bytearray) for item in (signature, content_type, body)))
    _need(1 <= len(signature) <= 1024 and 1 <= len(content_type) <= 128 and 1 <= len(body) <= 65536)
    try:
        for header in (signature, content_type):
            text = bytes(header).decode("utf8")
            _need(not any(ord(char) < 32 or ord(char) == 127 for char in text))
    except UnicodeError:
        raise MuxCaptureError("P2Q_MUX_ENVELOPE_REFUSED") from None
    return _MAGIC + struct.pack(">III", len(signature), len(content_type), len(body)) + bytes(signature) + bytes(content_type) + bytes(body)


def _decode_envelope(raw):
    _need(type(raw) in (bytes, bytearray) and 23 <= len(raw) <= 66708, "P2Q_MUX_ENVELOPE_REFUSED")
    _need(raw[:8] == _MAGIC, "P2Q_MUX_ENVELOPE_REFUSED")
    a, b, c = struct.unpack(">III", raw[8:20])
    _need(a + b + c + 20 == len(raw), "P2Q_MUX_ENVELOPE_REFUSED")
    signature, content_type, body = raw[20:20+a], raw[20+a:20+a+b], raw[20+a+b:]
    _need(_envelope(signature, content_type, body) == raw, "P2Q_MUX_ENVELOPE_REFUSED")
    return _PrivateMaterial(signature, content_type, body)


def _header_timestamp(signature):
    _need(type(signature) in (bytes, bytearray))
    try:
        parts = bytes(signature).decode("ascii").split(",")
        stamps = [item[2:] for item in parts if item.startswith("t=")]
        _need(len(stamps) == 1 and _match(_DECIMAL, stamps[0]) and _int(int(stamps[0]), 1, _SAFE // 1000))
        _need(all(item.startswith("t=") or re.fullmatch(r"v1=[a-f0-9]{64}", item) for item in parts)
              and any(item.startswith("v1=") for item in parts))
        return int(stamps[0])
    except (UnicodeError, ValueError):
        raise MuxCaptureError("P2Q_MUX_SIGNATURE_DATA_REFUSED") from None


def _safe_capture(commit):
    _validate("privateCommit", commit)
    safe = {key: copy.deepcopy(commit[key]) for key in _CAPTURE_KEYS}
    safe["kind"] = _KINDS["safeCapture"]
    _encode("safeCapture", safe)
    return safe


def _join_raw_event(material, event):
    """Private raw-field consistency, NOT provider signature authentication."""
    _need(type(material) is _PrivateMaterial and type(material.body) is bytearray)
    _validate("event", event)
    def pairs(items):
        value = {}
        for key, item in items:
            _need(key not in value)
            value[key] = item
        return value
    try:
        raw = json.loads(bytes(material.body).decode("utf8"), object_pairs_hook=pairs)
        _need(type(raw) is dict and type(raw.get("environment")) is dict and type(raw.get("data")) is dict)
        data = raw["data"]
        _need(raw.get("id") == event["id"] and raw.get("type") == event["type"] and
              raw.get("created_at") == event["createdAt"] and raw["environment"].get("id") == event["environmentId"] and
              data.get("id") == event["objectId"] and data.get("asset_id") == event["assetId"])
        marker = "lash-her-course:" + event["environmentId"] + ":" + event["attemptId"]
        _need(data.get("passthrough") == marker if event["type"] == "video.asset.track.ready"
              else "passthrough" not in data or data["passthrough"] == marker)
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError):
        raise MuxCaptureError("P2Q_MUX_RAW_EVENT_REFUSED") from None


def _join_capture(lease, capture):
    _encode("lease", lease)
    _encode("safeCapture", capture)
    types = _CASES[lease["caseId"]][0]
    _need(capture["leaseSha256"] == _hash(_encode("lease", lease)) and capture["slot"] < len(types))
    event, selected = capture["event"], lease["selection"]
    _need(event["type"] == types[capture["slot"]] and all(event[key] == selected[key] for key in
          ("environmentId", "lessonId", "attemptId", "generation", "assetId")))
    _need(capture["managedResponse"]["id"] == selected["attemptId"] and capture["managedResponse"]["lessonId"] == selected["lessonId"])
    captured = _milliseconds(capture["capturedAt"])
    _need(_milliseconds(lease["issuedAt"]) <= captured < _milliseconds(lease["expiresAt"]) and
          0 <= captured - capture["headerTimestamp"] * 1000 <= 300000)


def _assess_send_budget(lease, capture, now_iso, elapsed_ms):
    _join_capture(lease, capture)
    _need(type(elapsed_ms) in (int, float) and math.isfinite(elapsed_ms) and elapsed_ms >= 0)
    now = _milliseconds(now_iso)
    _need(now >= _milliseconds(lease["issuedAt"]) and now >= _milliseconds(capture["capturedAt"]))
    header_left = capture["headerTimestamp"] * 1000 + 300000 - now
    stage_left = min(_milliseconds(lease["expiresAt"]) - now, 120000 - elapsed_ms)
    return {"componentOnly": True, "liveSendAuthorized": False,
            "budgetSufficient": min(header_left, stage_left) >= 15000,
            "remainingMilliseconds": max(0, math.floor(min(header_left, stage_left)))}


def _assess_window(lease, summary):
    _encode("lease", lease)
    _encode("windowSummary", summary)
    lease_sha = _hash(_encode("lease", lease))
    _need(summary["leaseSha256"] == lease_sha and all(row["leaseSha256"] == lease_sha for row in summary["records"]))
    before, after, records = summary["admittedTotalsBefore"], summary["admittedTotalsAfter"], summary["records"]
    complete = summary["closedAt"] is not None and before is not None and after is not None and summary["observationFailures"] == 0
    if complete:
        start, end = _milliseconds(summary["startedAt"]), _milliseconds(summary["closedAt"])
        complete = _milliseconds(lease["issuedAt"]) <= start <= end <= _milliseconds(lease["expiresAt"])
        complete = complete and all(after[key] - before[key] == sum(row["category"] == key for row in records) for key in before)
        complete = complete and all(row["finishedAt"] is not None and row["localResponseFinished"] is True and
            start <= _milliseconds(row["startedAt"]) <= _milliseconds(row["finishedAt"]) <= end for row in records)
    return {"componentOnly": True, "coverageConsistent": bool(complete), "observedRequests": len(records),
            "actualDrainQualified": False, "providerQueueQualified": False, "authorityIssued": False}


def _file_identity(info):
    return {"device": str(info.st_dev), "inode": str(info.st_ino)}


def _directory(fd, identity):
    _need(type(fd) is int and fd >= 0)
    info = os.fstat(fd)
    _need(stat.S_ISDIR(info.st_mode) and info.st_uid == _HOST_UID and info.st_gid == _GATEWAY_GID and
          stat.S_IMODE(info.st_mode) == 0o770 and _file_identity(info) == identity, "P2Q_MUX_DIRECTORY_CHANGED")
    return info


def _stable(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read_fixed(fd, name, maximum):
    _need(type(fd) is int and fd >= 0 and type(name) is str and name in (*_RAW_NAMES, *_COMMIT_NAMES),
          "P2Q_MUX_FIXED_FILE_REQUIRED")
    _need(type(maximum) is int and maximum == (66708 if name in _RAW_NAMES else 16384), "P2Q_MUX_FIXED_FILE_REQUIRED")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    descriptor = os.open(name, flags, dir_fd=fd)
    try:
        before = os.fstat(descriptor)
        _need(stat.S_ISREG(before.st_mode) and before.st_uid == _GATEWAY_UID and before.st_gid == _GATEWAY_GID and
              stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= maximum, "P2Q_MUX_PRIVATE_FILE_REFUSED")
        chunks, total = [], 0
        while total <= maximum:
            chunk = os.read(descriptor, min(65536, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk); total += len(chunk)
        _need(total == before.st_size and total <= maximum and _stable(before) == _stable(os.fstat(descriptor)),
              "P2Q_MUX_PRIVATE_FILE_CHANGED")
        os.fsync(descriptor)
        _need(_stable(before) == _stable(os.stat(name, dir_fd=fd, follow_symlinks=False)), "P2Q_MUX_PRIVATE_FILE_CHANGED")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _inspect_capture(root_fd, lease, slot):
    """Observe fixed files using actual descriptors; this is NOT ARM authority.

    No path argument/URL/client/query/verifier callback exists. The future live
    parent must independently bind the fixed mount, outer0700 parent and source.
    """
    _encode("lease", lease)
    _need(_int(slot, 0, len(_CASES[lease["caseId"]][0]) - 1))
    action_fd, material = None, None
    try:
        _directory(root_fd, lease["captureRootIdentity"])
        action_fd = os.open(lease["actionId"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        _directory(action_fd, lease["actionDirectoryIdentity"])
        commit_raw = _read_fixed(action_fd, _COMMIT_NAMES[slot], 16384)
        commit = _decode("privateCommit", commit_raw)
        raw = _read_fixed(action_fd, _RAW_NAMES[slot], 66708)
        _need(commit["slot"] == slot and commit["rawEnvelopeBytes"] == len(raw) and commit["rawEnvelopeSha256"] == _hash(raw))
        safe = _safe_capture(commit); _join_capture(lease, safe)
        material = _decode_envelope(raw)
        _need(_header_timestamp(material.signature) == safe["headerTimestamp"])
        _join_raw_event(material, safe["event"])
        _need(_read_fixed(action_fd, _COMMIT_NAMES[slot], 16384) == commit_raw and
              _read_fixed(action_fd, _RAW_NAMES[slot], 66708) == raw, "P2Q_MUX_PRIVATE_FILE_CHANGED")
        os.fsync(action_fd); os.fsync(root_fd)
        _directory(root_fd, lease["captureRootIdentity"])
        _directory(action_fd, lease["actionDirectoryIdentity"])
        _need(_file_identity(os.stat(lease["actionId"], dir_fd=root_fd, follow_symlinks=False)) == lease["actionDirectoryIdentity"])
        return {"safeCapture": safe, "material": material, "observationOnly": True, "currentFsyncObserved": True,
                "historicProducerFsyncQualified": False, "fixedRuntimeMountQualified": False, "authorityIssued": False}
    except OSError:
        if material is not None:
            material.clear()
        raise MuxCaptureError("P2Q_MUX_SPOOL_OBSERVATION_UNKNOWN") from None
    except BaseException:
        if material is not None:
            material.clear()
        raise
    finally:
        if action_fd is not None:
            os.close(action_fd)


class _ReplayBurnModel:
    """One-process DATA model. No source issuer, durable-start ACK or HTTP sender."""
    def __init__(self, lease, captures):
        self._lease = _decode("lease", _encode("lease", lease))
        count = len(_CASES[self._lease["caseId"]][0])
        _need(type(captures) is list and len(captures) == count)
        self._captures = [_decode("safeCapture", _encode("safeCapture", row)) for row in captures]
        for slot, row in enumerate(self._captures):
            _join_capture(self._lease, row); _need(row["slot"] == slot)
        _need(len({row["requestId"] for row in self._captures}) == count)
        if count == 2:
            first, second = [row["event"] for row in self._captures]
            _need(first["id"] != second["id"] and first["objectId"] == second["objectId"] and
                  _instant(first["createdAt"]) < _instant(second["createdAt"]))
        self._next, self._poisoned, self._pending, self._states = 0, False, None, []
        self._request_ids = {row["requestId"] for row in self._captures}
        self._mutex = threading.Lock()

    def __repr__(self):
        return "<component replay model; no authority or sender>"

    def reserve(self, now_iso, elapsed_ms):
        with self._mutex:
            order = _CASES[self._lease["caseId"]][1]
            _need(not self._poisoned and self._pending is None and self._next < len(order), "P2Q_MUX_REPLAY_MODEL_BURNED")
            sequence, slot = self._next, order[self._next]
            capture = self._captures[slot]
            _need(_assess_send_budget(self._lease, capture, now_iso, elapsed_ms)["budgetSufficient"], "P2Q_MUX_SEND_BUDGET_EXHAUSTED")
            self._next += 1  # Burn before formatting/return; no reset or decode path.
            self._states.append("STARTED")
            try:
                started = {"version": 2, "kind": _KINDS["safeSendStarted"], "leaseSha256": capture["leaseSha256"],
                           "sequence": sequence, "captureSlot": slot, "captureObservationSha256": _hash(_encode("safeCapture", capture)),
                           "createdAt": now_iso}
                raw = _encode("safeSendStarted", started)
                self._pending = (sequence, slot, _hash(raw), now_iso)
                return copy.deepcopy(started)
            except BaseException:
                self._states[-1] = "UNKNOWN"; self._poisoned = True
                raise

    def observe(self, response_request_id, observation):
        with self._mutex:
            _need(not self._poisoned and self._pending is not None, "P2Q_MUX_REPLAY_MODEL_BURNED")
            try:
                _encode("replayObservation", observation)
                sequence, slot, started_sha, started_at = self._pending
                capture = self._captures[slot]
                _need(_match(_REQUEST, response_request_id) and observation["requestId"] == response_request_id and
                      response_request_id not in self._request_ids and
                      observation["sequence"] == sequence and observation["captureSlot"] == slot and
                      observation["sendStartedSha256"] == started_sha and observation["leaseSha256"] == capture["leaseSha256"] and
                      observation["event"] == capture["event"] and observation["headerTimestamp"] == capture["headerTimestamp"] and
                      observation["managedResponse"] == capture["managedResponse"], "P2Q_MUX_REPLAY_JOIN_UNKNOWN")
                observed = _milliseconds(observation["observedAt"])
                _need(_milliseconds(started_at) <= observed < _milliseconds(self._lease["expiresAt"]) and
                      0 <= observed - capture["headerTimestamp"] * 1000 <= 300000 and
                      int(observation["monotonicNanoseconds"]) >= int(capture["monotonicNanoseconds"]),
                      "P2Q_MUX_REPLAY_JOIN_UNKNOWN")
                self._request_ids.add(response_request_id)
                self._states[sequence] = "OBSERVED"; self._pending = None
            except BaseException:
                self._states[self._pending[0]] = "UNKNOWN"; self._poisoned = True
                raise

    def lose(self):
        with self._mutex:
            if self._pending is not None:
                self._states[self._pending[0]] = "UNKNOWN"
            self._poisoned = True

    def summary(self):
        with self._mutex:
            return {"componentOnly": True, "liveSendAuthorized": False, "startedDurabilityQualified": False,
                    "reservedSlots": self._next, "states": list(self._states), "unknown": self._poisoned}


def _format_private_intent(lease, capture, started, material):
    """Format private data only. No intent publication, signature issuance or POST."""
    _join_capture(lease, capture)
    _encode("safeSendStarted", started)
    _need(type(material) is _PrivateMaterial)
    order = _CASES[lease["caseId"]][1]
    sequence = started["sequence"]
    _need(sequence < len(order) and started["captureSlot"] == order[sequence] == capture["slot"] and
          started["captureObservationSha256"] == _hash(_encode("safeCapture", capture)) and started["leaseSha256"] == capture["leaseSha256"])
    _need(_header_timestamp(material.signature) == capture["headerTimestamp"])
    _join_raw_event(material, capture["event"])
    _need(_milliseconds(lease["issuedAt"]) <= _milliseconds(started["createdAt"]) and
          _milliseconds(capture["capturedAt"]) <= _milliseconds(started["createdAt"]))
    intent = {"version": 2, "kind": _KINDS["privateIntent"], "leaseSha256": capture["leaseSha256"],
              "sequence": sequence, "captureSlot": capture["slot"], "sendStartedSha256": _hash(_encode("safeSendStarted", started)),
              "expectedEnvelopeSha256": _hash(_envelope(material.signature, material.content_type, material.body)),
              "eventId": capture["event"]["id"], "originalHeaderTimestamp": capture["headerTimestamp"],
              "issuedAt": started["createdAt"], "expiresAt": _iso(min(_milliseconds(lease["expiresAt"]), capture["headerTimestamp"] * 1000 + 300000))}
    return bytearray(_encode("privateIntent", intent))


def _request_shape():
    # The future actual source-held adapter supplies TLS/origin privately. This
    # component intentionally has no host/URL/socket/client/callback parameter.
    return {"method": "POST", "path": REPLAY_PATH, "signatureRenewed": False, "networkDispatchAvailable": False}


def _safe_stage_size(records):
    """Conjunctive safe-record/aggregate data limits, never a parent response."""
    safe_kinds = {"lease", "safeCapture", "safeSendStarted", "replayObservation", "globalRequest", "windowSummary", "wireFrame"}
    _need(type(records) is list and len(records) <= 196608)
    values = []
    for item in records:
        _need(type(item) is tuple and len(item) == 2 and type(item[0]) is str and item[0] in safe_kinds)
        values.append(_decode(item[0], _encode(item[0], item[1])))
    size = len(_canonical(values))
    _need(size <= 196608)
    return size


_MEDIA_KEYS = ("id lessonId generation managedByCourse providerEnvironmentId uploadId assetId status isCurrent "
               "deletedAt supersededAt lastTokenExpiresAt captionTracks").split()


def _media_rows(rows, selection):
    """Validate source-shaped video_assets projections, not actual DB authority."""
    _need(type(rows) is list and 0 < len(rows) <= 4096)
    _validate("selection", selection)
    identities, generations = set(), set()
    for row in rows:
        _need(type(row) is dict and all(type(key) is str for key in row) and set(row) == set(_MEDIA_KEYS) and
              _match(_UUID, row["id"]) and row["id"] not in identities)
        identities.add(row["id"])
        _need(_match(_UUID, row["lessonId"]) and row["lessonId"] == selection["lessonId"] and _int(row["generation"], 1, 2_147_483_647) and
              type(row["managedByCourse"]) is bool and type(row["isCurrent"]) is bool and
              _one(row["status"], ("pending", "uploading", "processing", "ready", "errored")))
        _need(row["generation"] not in generations)
        generations.add(row["generation"])
        for key in ("providerEnvironmentId", "uploadId", "assetId"):
            _need(row[key] is None or _match(_PROVIDER, row[key]))
        for key in ("deletedAt", "supersededAt", "lastTokenExpiresAt"):
            if row[key] is not None:
                _instant(row[key])
        _need(type(row["captionTracks"]) is list and len(row["captionTracks"]) <= 4096)
        tracks = set()
        for track in row["captionTracks"]:
            _need(type(track) is dict and all(type(key) is str for key in track) and set(track) == {"id", "status"} and
                  _match(_PROVIDER, track["id"]) and track["id"] not in tracks and _one(track["status"], ("preparing", "ready", "errored", "deleted")))
            tracks.add(track["id"])
    normalized = copy.deepcopy(rows)
    for row in normalized:
        row["captionTracks"].sort(key=lambda track: track["id"])
    return normalized


def _reduce_media_projection(lease, captures, before_rows, after_rows):
    """Covered state only; excludes allowed scheduling/timestamps/raw_payload.

    No query/session/provider callback exists. Callers cannot turn these input
    rows into verified observations, ordinary-UI lineage, or stage authority.
    """
    model = _ReplayBurnModel(lease, captures)
    del model
    selected = lease["selection"]
    before = _media_rows(before_rows, selected); after = _media_rows(after_rows, selected)
    same_rows = sorted(before, key=lambda row: row["id"]) == sorted(after, key=lambda row: row["id"])
    candidates = [row for row in after if row["id"] == selected["attemptId"]]
    consistent = same_rows and len(candidates) == 1
    if consistent:
        row = candidates[0]
        consistent = row["managedByCourse"] and row["providerEnvironmentId"] == selected["environmentId"] and row["generation"] == selected["generation"] and \
            row["assetId"] == selected["assetId"] and row["uploadId"] == selected["uploadId"] and row["deletedAt"] is None and row["status"] == "ready"
        currents = [item for item in after if item["isCurrent"]]
        consistent = consistent and len(currents) == 1
        track_id = captures[0]["event"]["objectId"]
        active_tracks = {track["id"] for track in row["captionTracks"] if track["status"] != "deleted"}
        if lease["caseId"] == "D1":
            consistent = consistent and row["isCurrent"] and any(track["id"] == track_id and track["status"] == "ready" for track in row["captionTracks"])
        elif lease["caseId"] == "R1":
            consistent = consistent and row["isCurrent"] and track_id not in active_tracks
        else:
            consistent = consistent and not row["isCurrent"] and row["lastTokenExpiresAt"] is not None and \
                currents[0]["id"] != row["id"] and currents[0]["generation"] == max(item["generation"] for item in after) and \
                currents[0]["generation"] > row["generation"] and currents[0]["status"] == "ready" and currents[0]["deletedAt"] is None and \
                currents[0]["managedByCourse"] and currents[0]["providerEnvironmentId"] == selected["environmentId"] and \
                currents[0]["assetId"] is not None and currents[0]["assetId"] != row["assetId"]
    return {"componentOnly": True, "projectionConsistent": bool(consistent), "coveredRows": len(after),
            "actualReadOnlyDatabaseQualified": False, "providerReconciliationQualified": False,
            "ordinaryUiLineageQualified": False, "actualPlaybackAuthorizationQualified": False, "authorityIssued": False}
