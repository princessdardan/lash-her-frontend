"""Closed qualification-target profile parsing for platform host operations."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from pathlib import Path
from types import MappingProxyType
from typing import Any


QUALIFICATION_TARGET_PROFILE_REFUSED = "QUALIFICATION_TARGET_PROFILE_REFUSED"
QUALIFICATION_TARGET_PROFILE_UNKNOWN = "QUALIFICATION_TARGET_PROFILE_UNKNOWN"
QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH = "QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH"
QUALIFICATION_TARGET_PROFILE_REQUIRED = "QUALIFICATION_TARGET_PROFILE_REQUIRED"
QUALIFICATION_TARGET_PROFILE_MISMATCH = "QUALIFICATION_TARGET_PROFILE_MISMATCH"
QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED = "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED"
QUALIFICATION_TARGET_OBSERVATION_MISMATCH = "QUALIFICATION_TARGET_OBSERVATION_MISMATCH"

_RAW_BOUNDS = MappingProxyType({
    "registry": 131_072,
    "carrier": 2_000_000,
    "private-packet": 24_000_000,
})
_MAX_DEPTH = 128
_MAX_SAFE_INTEGER = (1 << 53) - 1
_PROFILE_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z", re.ASCII)
_RAW64 = re.compile(r"[a-f0-9]{64}\Z", re.ASCII)
_CANONICAL_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z", re.ASCII)
_MAPPING_PROXY_TYPE = type(MappingProxyType({}))

_CURRENT_CANONICAL = (
    b'{"environment":"staging","frontend":{"canonicalOrigin":"https://staging.lashher.com",'
    b'"projectId":"prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM","teamId":"team_2Hrn5eMZyZxfAWdmYvyKi9t3",'
    b'"workloadEnvironment":"production"},"gateway":{"publicOrigin":"https://api-staging.lashher.com"},'
    b'"id":"staging-current","kind":"existing-staging","selectionPolicy":"existing-staging-v1",'
    b'"version":1}'
)
_CURRENT_SHA256 = "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba"
_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "qualification-target-profiles.json"


class QualificationTargetProfileError(ValueError):
    """A sanitized, nonsecret qualification-target profile refusal."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _NumberToken:
    __slots__ = ("raw",)

    def __init__(self, raw: str):
        self.raw = raw


class _ObjectPairs(list):
    pass


def _raise(code: str = QUALIFICATION_TARGET_PROFILE_REFUSED) -> None:
    raise QualificationTargetProfileError(code)


def _constant_refusal(_value: str) -> None:
    _raise()


def _raw_bytes(raw: str | bytes | bytearray, bound: int) -> bytes:
    if type(raw) is str:
        try:
            encoded = raw.encode("utf-8", "strict")
            if encoded.decode("utf-8", "strict") != raw:
                _raise()
        except UnicodeError as error:
            raise QualificationTargetProfileError(QUALIFICATION_TARGET_PROFILE_REFUSED) from error
    elif type(raw) in (bytes, bytearray):
        encoded = bytes(raw)
    else:
        _raise()
    if not encoded or len(encoded) > bound or encoded.startswith(b"\xef\xbb\xbf"):
        _raise()
    return encoded


def _number(token: _NumberToken, force_canonical_integer: bool) -> int | float:
    raw = token.raw
    if force_canonical_integer:
        if _CANONICAL_INTEGER.fullmatch(raw) is None:
            _raise()
        value = int(raw)
        if value > _MAX_SAFE_INTEGER:
            _raise()
        return value
    if "." not in raw and "e" not in raw.lower():
        return int(raw)
    value = float(raw)
    if not math.isfinite(value):
        _raise()
    return value


def _validate_unicode_scalar(value: str) -> str:
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise QualificationTargetProfileError(QUALIFICATION_TARGET_PROFILE_REFUSED) from error
    return value


def _convert_json(
    value: Any,
    *,
    kind: str,
    depth: int = 0,
    force_canonical_integer: bool = False,
    profile_object: bool = False,
) -> Any:
    if isinstance(value, _NumberToken):
        return _number(value, kind == "registry" or force_canonical_integer)
    if isinstance(value, _ObjectPairs):
        current_depth = depth + 1
        if current_depth > _MAX_DEPTH:
            _raise()
        result: dict[str, Any] = {}
        for key, child in value:
            _validate_unicode_scalar(key)
            if key in result:
                _raise()
            if profile_object and key == "version" and not isinstance(child, _NumberToken):
                _raise()
            result[key] = _convert_json(
                child,
                kind=kind,
                depth=current_depth,
                force_canonical_integer=profile_object and key == "version",
                profile_object=key == "qualificationTargetProfile",
            )
        return result
    if type(value) is list:
        current_depth = depth + 1
        if current_depth > _MAX_DEPTH:
            _raise()
        return [_convert_json(child, kind=kind, depth=current_depth) for child in value]
    if type(value) is str:
        return _validate_unicode_scalar(value)
    return value


def decode_qualification_target_json(raw: str | bytes | bytearray, kind: str) -> Any:
    """Decode bounded JSON while retaining duplicate-key and numeric-token guarantees."""

    if type(kind) is not str or kind not in _RAW_BOUNDS:
        _raise()
    encoded = _raw_bytes(raw, _RAW_BOUNDS[kind])
    try:
        text = encoded.decode("utf-8", "strict")
        parsed = json.loads(
            text,
            object_pairs_hook=_ObjectPairs,
            parse_int=_NumberToken,
            parse_float=_NumberToken,
            parse_constant=_constant_refusal,
        )
        return _convert_json(parsed, kind=kind)
    except QualificationTargetProfileError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError, TypeError, ValueError) as error:
        raise QualificationTargetProfileError(QUALIFICATION_TARGET_PROFILE_REFUSED) from error


def _exact_dict(value: Any, keys: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        _raise()
    return value


def _printable_ascii(value: Any) -> bool:
    return type(value) is str and all(0x20 <= ord(character) <= 0x7E for character in value)


def _validate_current_definition(value: Any) -> dict[str, Any]:
    definition = _exact_dict(
        value,
        {"environment", "frontend", "gateway", "id", "kind", "selectionPolicy", "version"},
    )
    frontend = _exact_dict(
        definition["frontend"],
        {"canonicalOrigin", "projectId", "teamId", "workloadEnvironment"},
    )
    gateway = _exact_dict(definition["gateway"], {"publicOrigin"})
    scalar_strings = (
        definition["environment"],
        definition["id"],
        definition["kind"],
        definition["selectionPolicy"],
        frontend["canonicalOrigin"],
        frontend["projectId"],
        frontend["teamId"],
        frontend["workloadEnvironment"],
        gateway["publicOrigin"],
    )
    if not all(_printable_ascii(item) for item in scalar_strings) or type(definition["version"]) is not int:
        _raise()
    expected = json.loads(_CURRENT_CANONICAL)
    if definition != expected:
        _raise(QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED)
    return definition


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _freeze(value: Any) -> Any:
    if type(value) is dict:
        return MappingProxyType({key: _freeze(child) for key, child in value.items()})
    if type(value) is list:
        return tuple(_freeze(child) for child in value)
    return value


def _read_fixed_registry() -> bytes:
    flags = os.O_RDONLY | os.O_NONBLOCK
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        _raise()
    descriptor = None
    try:
        descriptor = os.open(_REGISTRY_PATH, flags | nofollow)
        before = os.fstat(descriptor)
        bound = _RAW_BOUNDS["registry"]
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > bound:
            _raise()
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(65_536, remaining))
            if not chunk:
                _raise()
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            _raise()
        after = os.fstat(descriptor)
        if (
            after.st_dev != before.st_dev
            or after.st_ino != before.st_ino
            or after.st_mode != before.st_mode
            or after.st_size != before.st_size
        ):
            _raise()
        return b"".join(chunks)
    except QualificationTargetProfileError:
        raise
    except OSError as error:
        raise QualificationTargetProfileError(QUALIFICATION_TARGET_PROFILE_REFUSED) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _load_registry() -> tuple[dict[str, tuple[str, Any]], Any]:
    raw = _read_fixed_registry()
    registry = decode_qualification_target_json(raw, "registry")
    envelope = _exact_dict(registry, {"version", "profiles"})
    profiles = envelope["profiles"]
    if type(envelope["version"]) is not int or envelope["version"] != 1 or type(profiles) is not list:
        _raise()
    if len(profiles) != 1:
        _raise(QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED)
    definition = _validate_current_definition(profiles[0])
    canonical = _canonical(definition)
    digest = hashlib.sha256(canonical).hexdigest()
    if len(_CURRENT_CANONICAL) != 371 or canonical != _CURRENT_CANONICAL or digest != _CURRENT_SHA256:
        _raise(QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH)
    frozen = _freeze(definition)
    return {"staging-current": (digest, frozen)}, frozen


_REGISTRY, _STAGING_CURRENT_DEFINITION = _load_registry()
STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE = MappingProxyType({
    "version": 1,
    "id": "staging-current",
    "sha256": _CURRENT_SHA256,
})


def parse_qualification_target_profile_ref(value: Any) -> Any:
    """Validate and resolve a closed profile reference without granting live authority."""

    if type(value) not in (dict, _MAPPING_PROXY_TYPE) or set(value) != {"version", "id", "sha256"}:
        _raise()
    version, profile_id, digest = value["version"], value["id"], value["sha256"]
    if type(version) is not int or version != 1 or type(profile_id) is not str or type(digest) is not str:
        _raise()
    if _PROFILE_ID.fullmatch(profile_id) is None or _RAW64.fullmatch(digest) is None or digest == "0" * 64:
        _raise()
    registered = _REGISTRY.get(profile_id)
    if registered is None:
        _raise(QUALIFICATION_TARGET_PROFILE_UNKNOWN)
    if digest != registered[0]:
        _raise(QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH)
    return MappingProxyType({"version": 1, "id": profile_id, "sha256": digest})


def resolve_qualification_target_profile(ref: Any) -> Any:
    parsed = parse_qualification_target_profile_ref(ref)
    return _REGISTRY[parsed["id"]][1]


def require_qualification_target_profile(expected: Any, *carriers: Any) -> Any:
    verified = parse_qualification_target_profile_ref(expected)
    if not carriers:
        _raise(QUALIFICATION_TARGET_PROFILE_REQUIRED)
    for carrier in carriers:
        if type(carrier) is not dict or "qualificationTargetProfile" not in carrier:
            _raise(QUALIFICATION_TARGET_PROFILE_REQUIRED)
        actual = parse_qualification_target_profile_ref(carrier["qualificationTargetProfile"])
        if dict(actual) != dict(verified):
            _raise(QUALIFICATION_TARGET_PROFILE_MISMATCH)
    return verified


__all__ = [
    "QualificationTargetProfileError",
    "STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE",
    "decode_qualification_target_json",
    "parse_qualification_target_profile_ref",
    "resolve_qualification_target_profile",
    "require_qualification_target_profile",
]
