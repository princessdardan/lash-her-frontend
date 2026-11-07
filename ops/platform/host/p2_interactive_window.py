"""Private authority and gateway fence for one reviewed browser epoch."""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
import time

import migrate
import p2_interactive_ingress as ingress
import p2_lifecycle_native as native
from frontend_release_adapters import LockedClient


_SOURCE = Path(__file__).resolve()
_SOURCE_KEY = "ops/platform/host/p2_interactive_window.py"
_STAGES = {"identity", "authoring", "media", "learning", "paid-grant", "lifecycle"}
_GATEWAY_STAGES = {"authoring", "media", "learning", "paid-grant"}
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
_SHA = re.compile(r"[a-f0-9]{64}")
_SOURCE_SHA = re.compile(r"[a-f0-9]{40}")
_EPOCH = re.compile(r"[1-9][0-9]{0,17}")
_DEPLOYMENT = re.compile(r"https://([a-z0-9][a-z0-9-]*\.vercel\.app)")
_TARGET = re.compile(r"/course/v1/[A-Za-z0-9/_-]+(?:\?[!$%&'()*+,./:;=?@\[\]_~A-Za-z0-9-]+)?")
_EMPTY = hashlib.sha256(b"").hexdigest()
_MAX_STATE = 16_384
_GATEWAY_GID = 65532
_ZERO = {"newWork": 0, "recovery": 0}
demand = migrate.demand


def _matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def _canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _instant(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_interactive_action(action):
    lifecycle = type(action) is dict and action.get("stage") == "lifecycle"
    fields = {"stage", "actorId", "requests", "windowSeconds"} | ({"frontendAction"} if lifecycle else set())
    demand(type(action) is dict and set(action) == fields and
           type(action["stage"]) is str and action["stage"] in _STAGES and
           type(action["windowSeconds"]) is int and 30 <= action["windowSeconds"] <= 300 and
           type(action["requests"]) is list and
           (action["actorId"] is None if action["stage"] == "identity" else _matches(_UUID, action["actorId"])),
           "P2_INTERACTIVE_ACTION_REQUIRED")
    gateway = action["stage"] in _GATEWAY_STAGES
    requests = action["requests"]
    demand(1 <= len(requests) <= 16 if gateway else requests == [], "P2_INTERACTIVE_REQUESTS_REQUIRED")
    if lifecycle:
        frontend = action["frontendAction"]
        demand(type(frontend) is dict and set(frontend) == {"actorKind", "userId", "operation"} and
               _matches(_UUID, frontend["userId"]) and
               (frontend["operation"] in ("suspend", "restore", "export", "delete") if frontend["actorKind"] == "admin" else
                frontend["actorKind"] == "customer" and frontend["userId"] == action["actorId"] and
                frontend["operation"] in ("export", "delete", "preferences-on", "preferences-off")),
               "P2_INTERACTIVE_FRONTEND_ACTION_REQUIRED")
    selected = set()
    for row in requests:
        demand(type(row) is dict and set(row) == {"method", "target", "bodySha256", "uses"} and
               type(row["method"]) is str and row["method"] in {"GET", "POST", "PATCH", "PUT", "DELETE"} and
               _matches(_TARGET, row["target"]) and len(row["target"]) <= 512 and
               "//" not in row["target"].split("?", 1)[0] and
               _matches(_SHA, row["bodySha256"]) and (row["method"] != "GET" or row["bodySha256"] == _EMPTY) and
               type(row["uses"]) is int and 1 <= row["uses"] <= 4, "P2_INTERACTIVE_REQUEST_REQUIRED")
        identity = (row["method"], row["target"], row["bodySha256"])
        demand(identity not in selected, "P2_INTERACTIVE_DUPLICATE_REQUEST")
        selected.add(identity)
    return copy.deepcopy(action)


def _lifecycle_selection_sha(action):
    if action["stage"] != "lifecycle":
        return None
    selected = action["frontendAction"]
    return _hash(json.dumps([selected["actorKind"], action["actorId"], selected["userId"], selected["operation"]],
                            separators=(",", ":")).encode())


def _material(secret, deployment, source, target, epoch, stage, starts, duration, nonce, selection_sha=None):
    match = _DEPLOYMENT.fullmatch(deployment) if type(deployment) is str else None
    demand(match is not None and _matches(re.compile(r"[!-~]{32,8192}"), secret) and
           _matches(_SOURCE_SHA, source) and _matches(_SHA, target) and _matches(_EPOCH, epoch) and
           type(stage) is str and stage in _STAGES and
           type(starts) is int and 1_000_000_000 <= starts < 9_999_999_700 and
           type(duration) is int and 30 <= duration <= 300 and _matches(re.compile(r"[a-f0-9]{32}"), nonce),
           "P2_INTERACTIVE_PRIVATE_BINDING_REQUIRED")
    demand(_matches(_SHA, selection_sha) if stage == "lifecycle" else selection_sha is None,
           "P2_INTERACTIVE_FRONTEND_BINDING_REQUIRED")
    host = match.group(1)
    ends = starts + duration
    body = (f"v2.{epoch}.{stage}.{starts}.{ends}.{nonce}.{selection_sha}" if selection_sha is not None else
            f"v1.{epoch}.{stage}.{starts}.{ends}.{nonce}")

    def sign(value):
        return hmac.digest(secret.encode(), value.encode(), "sha256").hex()

    binding = f"{host}\n{source}\n{target}"
    signature = sign(f"lash-her:p2q:interactive:browser:v1\n{binding}\n{body}")
    key = sign(f"lash-her:p2q:interactive:gateway-key:v1\n{binding}\n{epoch}\n{stage}\n{nonce}") if stage in _GATEWAY_STAGES else None
    return f"{body}.{signature}", key, host, ends


def _closed(admission):
    return type(admission) is dict and admission.get("version") == 1 and admission.get("valid") is True and all(
        admission.get(flag) is False for flag in ("newWork", "recovery")) and all(
        admission.get(counter) == _ZERO for counter in ("active", "uncertain"))


class P2InteractiveWindow:
    def __init__(self, broker):
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        demand(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope and
               broker.external_armed is True and broker.guard_arm_verified is True and os.geteuid() == 0,
               "P2_INTERACTIVE_GUARDED_PARENT_REQUIRED")
        plan = broker.initial["certificationPlan"]
        demand(plan["mode"] == "interactive-browser" and plan["startState"] == "already-closed" and
               plan["maximumSeconds"] == 300 and
               broker.initial["sourceSha256"].get(_SOURCE_KEY) == _hash(_SOURCE.read_bytes()),
               "P2_INTERACTIVE_INSTALLED_PLAN_REQUIRED")
        self.broker, self.plan = broker, plan
        self.action = validate_interactive_action(plan["scopedAction"])
        self._private_cookie = None
        self._scoped_sha = None
        self._expires = 0
        self._state = "new"
        self._original = None

    def _check(self):
        self.broker.check()
        self.broker.scope.require_frontend(self.broker.selected, self.broker.jobs["frontend"])
        self.broker.scope.require_configuration(self.broker.configuration)

    def _mount(self):
        fd = self.broker.admission_fd
        opened = os.fstat(fd)
        selected = self.broker.admission_identity
        current = os.stat(self.broker.configuration / "admission", follow_symlinks=False)
        demand(stat.S_ISDIR(opened.st_mode) and stat.S_ISDIR(current.st_mode) and opened.st_uid == current.st_uid == 0 and
               not (opened.st_mode | current.st_mode) & 0o022 and
               (opened.st_dev, opened.st_ino) == (selected.st_dev, selected.st_ino) == (current.st_dev, current.st_ino),
               "P2_INTERACTIVE_ADMISSION_MOUNT_CHANGED")
        return fd, opened

    def _read(self):
        directory, _ = self._mount()
        fd = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(fd)
            demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022 and
                   0 < info.st_size <= _MAX_STATE, "P2_INTERACTIVE_STATE_FILE_REQUIRED")
            raw = stream.read(_MAX_STATE + 1)
            demand(len(raw) == info.st_size, "P2_INTERACTIVE_STATE_READ_REQUIRED")
            return raw, stat.S_IMODE(info.st_mode), info.st_gid

    def _replace(self, raw, mode, group):
        directory, _ = self._mount()
        name = ".p2-interactive-" + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchown(stream.fileno(), 0, group)
                os.fchmod(stream.fileno(), mode)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, "state.json", src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass

    def _gateway(self):
        observed = self.broker._gateway_observation()
        _, mount = self._mount()
        demand(observed["processSha256"] == self.plan["gatewayProcessSha256"] and
               observed["gatewayConfigurationSha256"] == self.plan["gatewayConfigurationSha256"] and
               observed["admissionDirectory"] == {"device": str(mount.st_dev), "inode": str(mount.st_ino)} and
               observed["faultLeasePresent"] is False, "P2_INTERACTIVE_GATEWAY_CHANGED")
        return observed["admission"]

    def prepare(self):
        self._check()
        demand(self._state == "new", "P2_INTERACTIVE_PREPARE_ORDER_REQUIRED")
        frontend = self.broker.observer.probe("observe")["admission"]
        demand(frontend == {"epoch": self.plan["initialEpoch"], "newWork": False, "recovery": False,
                            "active": 0, "uncertain": 0}, "P2_INTERACTIVE_FRONTEND_START_REQUIRED")
        proof = ingress.observe_browser_protection(self.broker._native_context(),
            LockedClient(self.broker.vercel, self.broker.check), **self.broker.profile_arguments())
        ordinary = self._gateway()
        self._original = self._read()
        demand(_closed(ordinary) and ordinary["sha256"] == _hash(self._original[0]) and
               ordinary["releaseId"] == self.broker.selected["releaseId"] and
               ordinary["candidateSha256"] == self.broker.initial["candidateSha256"],
               "P2_INTERACTIVE_ORDINARY_GATEWAY_REQUIRED")
        self._state = "prepared"
        return proof

    def open_gateway(self):
        self._check()
        demand(self._state == "prepared" and self._read() == self._original and _closed(self._gateway()),
               "P2_INTERACTIVE_GATEWAY_OPEN_ORDER_REQUIRED")
        demand(self.broker.observer.probe("observe")["admission"] ==
               {"epoch": self.plan["initialEpoch"], "newWork": False, "recovery": False, "active": 0, "uncertain": 0},
               "P2_INTERACTIVE_GATEWAY_FRONTEND_START_REQUIRED")
        now = int(time.time())
        nonce = secrets.token_hex(16)
        epoch = str(int(self.plan["initialEpoch"]) + 1)
        remaining = math.floor(self.broker.certification_started + self.plan["maximumSeconds"] - time.monotonic()) - 10
        duration = min(self.action["windowSeconds"], remaining)
        cookie, key, host, expiry = _material(self.broker.initial["scopedCronSecret"], self.plan["nativePlan"]["deploymentUrl"],
            self.plan["sourceCommit"], self.plan["targetSha256"], epoch, self.action["stage"], now, duration, nonce,
            _lifecycle_selection_sha(self.action))
        if self.action["stage"] in _GATEWAY_STAGES:
            _, mount = self._mount()
            interactive = {"actorId": self.action["actorId"], "stage": self.action["stage"], "epoch": epoch,
                "frontendSourceCommit": self.plan["sourceCommit"], "deploymentHost": host, "issuedAt": _instant(now),
                "expiresAt": _instant(expiry), "nonce": nonce, "gatewayProcessSha256": self.plan["gatewayProcessSha256"],
                "mountDevice": str(mount.st_dev), "mountInode": str(mount.st_ino), "key": key, "requests": self.action["requests"]}
            state = {"version": 3, "environment": "staging", "releaseId": self.broker.selected["releaseId"],
                "candidateSha256": self.broker.initial["candidateSha256"], "actionId": self.broker.action_id(),
                "newWork": False, "recovery": False, "interactive": interactive}
            raw = _canonical(state)
            demand(len(raw) <= _MAX_STATE, "P2_INTERACTIVE_STATE_TOO_LARGE")
            self._scoped_sha = _hash(raw)
            try:
                self._replace(raw, 0o640, _GATEWAY_GID)
                demand(self._read() == (raw, 0o640, _GATEWAY_GID), "P2_INTERACTIVE_STATE_READBACK_REQUIRED")
                self._scoped_gateway()
            except BaseException:
                if _hash(self._read()[0]) == self._scoped_sha:
                    self._replace(*self._original)
                self._state = "fenced"
                raise
        self._private_cookie, self._expires = cookie, expiry
        self._state = "opened"
        return {"stage": self.action["stage"], "epoch": epoch, "expiresAt": _instant(expiry),
                "gatewayScoped": self._scoped_sha is not None}

    def _scoped_gateway(self):
        gateway = self._gateway()
        demand(gateway.get("version") == 3 and gateway.get("valid") is False and gateway.get("interactiveActive") is True and
               gateway.get("sha256") == self._scoped_sha and gateway.get("actionId") == self.broker.action_id() and
               gateway.get("newWork") is None and gateway.get("recovery") is None,
               "P2_INTERACTIVE_GATEWAY_MARKER_REQUIRED")
        return gateway

    def take_private_browser_permit(self):
        self._check()
        demand(self._state == "opened" and self._private_cookie is not None and time.time() < self._expires,
               "P2_INTERACTIVE_PERMIT_NOT_AVAILABLE")
        epoch = str(int(self.plan["initialEpoch"]) + 1)
        frontend = self.broker.observer.probe("observe")["admission"]
        demand(frontend == {"epoch": epoch, "newWork": True, "recovery": True, "active": 0, "uncertain": 0},
               "P2_INTERACTIVE_FRONTEND_WINDOW_REQUIRED")
        if self._scoped_sha is not None:
            self._scoped_gateway()
        metadata = native.observe_metadata(self.broker._native_context(),
            LockedClient(self.broker.vercel, self.broker.check), **self.broker.profile_arguments())
        demand(metadata["nativeEnabled"] is False, "P2_INTERACTIVE_NATIVE_SCHEDULER_REQUIRED_OFF")
        cookie, self._private_cookie = self._private_cookie, None
        return {"stage": self.action["stage"], "epoch": epoch, "expires": self._expires, "cookie": cookie}

    def collect_gateway_effects(self):
        self._check()
        demand(self._state == "opened" and self._private_cookie is None and time.time() < self._expires,
               "P2_INTERACTIVE_EFFECT_ORDER_REQUIRED")
        if self._scoped_sha is None:
            demand(self._read() == self._original and _closed(self._gateway()), "P2_INTERACTIVE_ORDINARY_GATEWAY_CHANGED")
            return []
        gateway = self._scoped_gateway()
        evidence = gateway["interactiveEvidence"]
        requests = self.action["requests"]
        total = sum(row["uses"] for row in requests)
        demand(gateway["active"] == gateway["uncertain"] == _ZERO and
               type(evidence) is dict and set(evidence) == {"admitted", "acknowledged"} and
               type(evidence["admitted"]) is int and evidence["admitted"] == total and
               type(evidence["acknowledged"]) is list and len(evidence["acknowledged"]) == total,
               "P2_INTERACTIVE_COMPLETE_GATEWAY_EFFECTS_REQUIRED")
        counts, seen, proof_seen = [0] * len(requests), set(), set()
        for row in evidence["acknowledged"]:
            demand(type(row) is dict and set(row) == {"requestId", "proofRequestId", "requestIndex", "upstreamStatus"} and
                   _matches(_UUID, row["requestId"]) and row["requestId"] not in seen and
                   _matches(_UUID, row["proofRequestId"]) and row["proofRequestId"] not in proof_seen and
                   type(row["requestIndex"]) is int and 0 <= row["requestIndex"] < len(requests) and
                   type(row["upstreamStatus"]) is int and
                   (200 <= row["upstreamStatus"] <= 299 or 400 <= row["upstreamStatus"] <= 499),
                   "P2_INTERACTIVE_ACKNOWLEDGEMENT_REQUIRED")
            seen.add(row["requestId"])
            proof_seen.add(row["proofRequestId"])
            counts[row["requestIndex"]] += 1
        demand(counts == [row["uses"] for row in requests], "P2_INTERACTIVE_ACKNOWLEDGEMENT_COUNTS_REQUIRED")
        return copy.deepcopy(evidence["acknowledged"])

    def fence_gateway(self):
        demand(self._state == "opened", "P2_INTERACTIVE_FENCE_ORDER_REQUIRED")
        self._private_cookie = None
        if self._scoped_sha is not None:
            demand(_hash(self._read()[0]) == self._scoped_sha, "P2_INTERACTIVE_UNRELATED_STATE_PRESERVED")
            self._replace(*self._original)
        self._state = "fenced"
        demand(self._read() == self._original, "P2_INTERACTIVE_CLOSED_STATE_READBACK_REQUIRED")

    def verify_gateway_fenced(self):
        self._check()
        demand(self._state == "fenced" and self._read() == self._original, "P2_INTERACTIVE_FENCE_REQUIRED")
        gateway = self._gateway()
        demand(_closed(gateway) and gateway["sha256"] == _hash(self._original[0]),
               "P2_INTERACTIVE_GATEWAY_DRAIN_REQUIRED")
        return {"gatewayAdmissionClosed": True, "gatewayActive": 0, "gatewayUncertain": 0}

    def verify_fenced(self):
        gateway = self.verify_gateway_fenced()
        physical = self.broker.observer.probe("witness")
        frontend = physical["admission"]
        operations = physical["witness"]["operations"]
        demand(frontend == {"epoch": str(int(self.plan["initialEpoch"]) + 2),
                            "newWork": False, "recovery": False, "active": 0, "uncertain": 0} and
               type(operations) is list and all(type(row) is dict and row.get("state") == "completed" and
                                              "reconciliation_sha256" in row and row["reconciliation_sha256"] is None
                                              for row in operations),
               "P2_INTERACTIVE_FRONTEND_DRAIN_REQUIRED")
        return {**gateway, "frontendAdmission": copy.deepcopy(frontend), "frontendOperationCount": len(operations)}
