#!/usr/bin/env python3
"""Source-owned, bounded Mux callback admission for profiled certification.

This module is not a standalone entry point.  It can only be constructed from
the already-armed profiled certification broker and its live process-local
scope.  The ordinary admission file is restored even when qualification fails.
"""

import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

import migrate
import release as runtime


_SOURCE = Path(__file__).resolve()
_SOURCE_KEY = "ops/platform/host/p2_scoped_mux.py"
_PROFILE_ID = "staging-current"
_PROFILE_SHA256 = "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba"
_PROFILE = {"version": 1, "id": _PROFILE_ID, "sha256": _PROFILE_SHA256}
_ACTION_KEYS = {"attemptId", "generation", "environmentId", "assetId", "uploadId", "eventType"}
_PROVIDER = re.compile(r"[A-Za-z0-9_-]{1,255}")
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
_SHA = re.compile(r"[a-f0-9]{64}")
_EVENTS = {
    "video.upload.asset_created",
    "video.asset.created",
    "video.asset.ready",
    "video.asset.errored",
    "video.asset.deleted",
    "video.asset.track.ready",
    "video.asset.track.deleted",
}
_TRACK_EVENTS = {"video.asset.track.ready", "video.asset.track.deleted"}
_STATUSES = {"pending", "uploading", "processing", "ready", "errored"}
_MAX_WINDOW_MS = 120_000
_MAX_STATE_BYTES = 4096
_MAX_OBSERVATION_BYTES = 16384


_COURSE_QUERY = r'''import pg from "pg";
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
if(Object.keys(input).sort().join(",")!=="attemptId")throw new Error("input");
const client=new pg.Client({connectionString:process.env.STAGING_DATABASE_URL});
try{
 await client.connect();
 await client.query("BEGIN READ ONLY");
 await client.query("SET LOCAL statement_timeout = '10000ms'");
 await client.query("SET LOCAL lock_timeout = '2000ms'");
 await client.query("SET LOCAL search_path = pg_catalog");
 const identity=await client.query("SELECT current_user AS user,current_database() AS database,current_setting('server_version_num')::int AS server_version_num");
 const result=await client.query(`SELECT id::text AS "attemptId",generation,managed_by_course AS "managedByCourse",provider_environment_id AS "environmentId",mux_upload_id AS "uploadId",mux_asset_id AS "assetId",status,is_current AS "isCurrent",deleted_at AS "deletedAt" FROM public.video_assets WHERE id=$1::uuid`,[input.attemptId]);
 await client.query("ROLLBACK");
 process.stdout.write(JSON.stringify({identity:identity.rows[0],rows:result.rows}));
}finally{await client.end().catch(()=>{});}
'''


def _require(condition, code):
    if not condition:
        raise ValueError(code)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _provider(value):
    return type(value) is str and _PROVIDER.fullmatch(value) is not None


def _profile(value):
    return type(value) is dict and value == _PROFILE


def _instant(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write_all(descriptor, raw):
    view = memoryview(raw)
    while view:
        written = os.write(descriptor, view)
        _require(written > 0, "P2_SCOPED_MUX_ADMISSION_WRITE_REQUIRED")
        view = view[written:]
    os.fsync(descriptor)


class P2ScopedMuxStage:
    """One process-local scoped callback window owned by a reviewed controller."""

    def __init__(self, broker):
        # Lazy imports avoid making this module another broker entry point.
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        _require(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope,
                 "P2_SCOPED_MUX_PROFILED_CERTIFICATION_PARENT_REQUIRED")
        self.broker, self.scope = broker, broker.scope
        self.plan = broker.initial["certificationPlan"]
        _require(broker.certification_profile() == _PROFILE and self.scope._expected_profile == _PROFILE and
                 self.plan.get("mode") == "mux-callback-recovery" and broker.external_armed is True,
                 "P2_SCOPED_MUX_SOURCE_MODE_REQUIRED")
        self.action = self._validate_action(self.plan.get("scopedAction"))
        _require(type(self.plan.get("maximumSeconds")) is int and self.plan["maximumSeconds"] == 300,
                 "P2_SCOPED_MUX_BOUNDED_PLAN_REQUIRED")
        source_hashes = broker.initial.get("sourceSha256")
        _require(type(source_hashes) is dict and source_hashes.get(_SOURCE_KEY) == _hash(_SOURCE.read_bytes()),
                 "P2_SCOPED_MUX_INSTALLED_SOURCE_REQUIRED")
        _require(os.geteuid() == 0, "P2_SCOPED_MUX_ROOT_HOST_REQUIRED")
        self._state = "new"
        self._opened_at = None
        self._deadline = None
        self._scoped_raw = None
        self._scoped_sha256 = None
        self._original_raw = None
        self._original_sha256 = None
        self._managed_before = None
        self._observed = None
        self._admission_fd = os.dup(broker.admission_fd)
        try:
            self._preflight()
        except BaseException:
            os.close(self._admission_fd)
            self._admission_fd = None
            raise

    @staticmethod
    def _validate_action(value):
        _require(type(value) is dict and set(value) == _ACTION_KEYS and
                 type(value["attemptId"]) is str and _UUID.fullmatch(value["attemptId"]) is not None and
                 type(value["generation"]) is int and 1 <= value["generation"] <= 2_147_483_647 and
                 _provider(value["environmentId"]) and value["eventType"] in _EVENTS and
                 (value["assetId"] is None or _provider(value["assetId"])) and
                 (value["uploadId"] is None or _provider(value["uploadId"])),
                 "P2_SCOPED_MUX_ACTION_REQUIRED")
        upload = value["eventType"] == "video.upload.asset_created"
        track = value["eventType"] in _TRACK_EVENTS
        _require((not upload or value["uploadId"] is not None) and (not track or value["assetId"] is not None),
                 "P2_SCOPED_MUX_EVENT_BINDING_REQUIRED")
        return copy.deepcopy(value)

    def _check(self):
        self.broker.check()
        self.scope.require_frontend(self.broker.selected, self.broker.jobs["frontend"])
        self.scope.require_configuration(self.broker.configuration)
        _require(self.broker._runtime_processes() == self.broker.process_snapshot,
                 "P2_SCOPED_MUX_RUNTIME_PROCESS_CHANGED")
        _require(self.broker._native_observe().get("nativeEnabled") is False,
                 "P2_SCOPED_MUX_NATIVE_OFF_REQUIRED")

    def _frontend_closed(self):
        admission = self.broker.observer.probe("witness")["admission"]
        _require(type(admission) is dict and set(admission) == {"epoch", "newWork", "recovery", "active", "uncertain"} and
                 admission["newWork"] is False and admission["recovery"] is False and
                 admission["active"] == 0 and admission["uncertain"] == 0,
                 "P2_SCOPED_MUX_FRONTEND_CLOSED_REQUIRED")
        return copy.deepcopy(admission)

    def _gateway_observation(self):
        observe = getattr(self.broker, "_gateway_observation", None)
        _require(callable(observe), "P2_SCOPED_MUX_GATEWAY_OBSERVER_REQUIRED")
        value = observe()
        _require(type(value) is dict and value.get("status") == "P2_FAULT_GATEWAY_CURRENT" and
                 value.get("processSha256") == self.plan["gatewayProcessSha256"] and
                 value.get("gatewayConfigurationSha256") == self.plan["gatewayConfigurationSha256"] and
                 value.get("admissionDirectory") == {"device": str(os.fstat(self._admission_fd).st_dev),
                                                      "inode": str(os.fstat(self._admission_fd).st_ino)},
                 "P2_SCOPED_MUX_EXACT_GATEWAY_REQUIRED")
        return value

    def _storage_identity(self):
        opened = os.fstat(self._admission_fd)
        path = self.broker.configuration / "admission"
        current = os.stat(path, follow_symlinks=False)
        _require(stat.S_ISDIR(opened.st_mode) and stat.S_ISDIR(current.st_mode) and
                 opened.st_uid == current.st_uid == 0 and not opened.st_mode & 0o022 and
                 (opened.st_dev, opened.st_ino) == (current.st_dev, current.st_ino) ==
                 (self.broker.admission_identity.st_dev, self.broker.admission_identity.st_ino),
                 "P2_SCOPED_MUX_ROOT_ADMISSION_MOUNT_REQUIRED")
        return opened

    def _read_state(self):
        descriptor = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self._admission_fd)
        try:
            info = os.fstat(descriptor)
            _require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
                     0 < info.st_size <= _MAX_STATE_BYTES, "P2_SCOPED_MUX_ADMISSION_FILE_REQUIRED")
            raw = os.read(descriptor, _MAX_STATE_BYTES + 1)
            _require(len(raw) == info.st_size, "P2_SCOPED_MUX_ADMISSION_READ_REQUIRED")
            return raw
        finally:
            os.close(descriptor)

    def _replace_state(self, raw, label):
        _require(type(raw) is bytes and 0 < len(raw) <= _MAX_STATE_BYTES and
                 re.fullmatch(r"[a-z0-9-]{1,64}", label), "P2_SCOPED_MUX_ADMISSION_BYTES_REQUIRED")
        name = ".p2-scoped-mux-" + label + "-" + uuid.uuid4().hex
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644,
                             dir_fd=self._admission_fd)
        try:
            os.fchmod(descriptor, 0o644)
            _write_all(descriptor, raw)
            os.replace(name, "state.json", src_dir_fd=self._admission_fd, dst_dir_fd=self._admission_fd)
            os.fsync(self._admission_fd)
        finally:
            os.close(descriptor)
            try:
                os.unlink(name, dir_fd=self._admission_fd)
            except FileNotFoundError:
                pass

    def _ordinary_closed(self, value):
        expected = {"actionId", "candidateSha256", "environment", "newWork", "recovery", "releaseId", "version"}
        _require(type(value) is dict and set(value) == expected and value["version"] == 1 and
                 value["environment"] == "staging" and value["releaseId"] == self.broker.selected["releaseId"] and
                 value["candidateSha256"] == self.broker.initial["candidateSha256"] and
                 type(value["actionId"]) is str and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value["actionId"]) and
                 value["newWork"] is False and value["recovery"] is False,
                 "P2_SCOPED_MUX_INITIAL_CLOSED_STATE_REQUIRED")
        return value

    def _managed_attempt(self, phase="current"):
        _require(phase in ("before", "after", "current"), "P2_SCOPED_MUX_MANAGED_PHASE_REQUIRED")
        info = self.broker.jobs["course"]
        job = info["job"]
        credential = self.broker.initial["credentials"]["COURSE_STAGING_DATABASE_URL"]
        _require(type(credential) is str and credential and info["image"] == self.broker.selected["artifacts"]["courseMigration"]["image"],
                 "P2_SCOPED_MUX_COURSE_IMAGE_REQUIRED")
        container = "lash-p2-scoped-mux-course-" + uuid.uuid4().hex
        args = ["docker", "run", "--rm", "--name", container, "--interactive", "--network", "host", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
                "--env", "STAGING_DATABASE_URL", "--entrypoint", "node", info["image"], "--input-type=module", "--eval", _COURSE_QUERY]
        try:
            result = self.scope.run(args, env={**runtime.SAFE_ENV, "STAGING_DATABASE_URL": credential},
                                    input=json.dumps({"attemptId": self.action["attemptId"]}), text=True,
                                    timeout=30, check=True, capture_output=True)
            _require(not result.stderr and 0 < len(result.stdout.encode()) <= _MAX_OBSERVATION_BYTES,
                     "P2_SCOPED_MUX_COURSE_QUERY_REQUIRED")
            value = json.loads(result.stdout)
            target = job["target"]
            identity = value.get("identity")
            rows = value.get("rows")
            _require(type(identity) is dict and set(identity) == {"user", "database", "server_version_num"} and
                     identity["user"] == target["user"] and identity["database"] == target["database"] and
                     type(identity["server_version_num"]) is int and identity["server_version_num"] // 10000 == target["serverMajor"] and
                     type(rows) is list and len(rows) == 1, "P2_SCOPED_MUX_COURSE_DATABASE_REQUIRED")
            row = rows[0]
            keys = {"attemptId", "generation", "managedByCourse", "environmentId", "uploadId", "assetId",
                    "status", "isCurrent", "deletedAt"}
            upload_asset = self.action["eventType"] == "video.upload.asset_created"
            asset_matches = row["assetId"] == self.action["assetId"]
            if upload_asset and phase == "after" and self.action["assetId"] is None:
                asset_matches = _provider(row["assetId"])
            _require(type(row) is dict and set(row) == keys and row["attemptId"] == self.action["attemptId"] and
                     row["generation"] == self.action["generation"] and row["managedByCourse"] is True and
                     row["environmentId"] == self.action["environmentId"] and row["uploadId"] == self.action["uploadId"] and
                     asset_matches and row["status"] in _STATUSES and
                     type(row["isCurrent"]) is bool and row["deletedAt"] is None,
                     "P2_SCOPED_MUX_MANAGED_ATTEMPT_REQUIRED")
            return {"row": row, "rowSha256": _hash(_canonical(row)),
                    "databaseIdentitySha256": _hash(_canonical(identity))}
        finally:
            self.scope.run(["docker", "rm", "--force", container], env=runtime.SAFE_ENV, timeout=30,
                           check=False, capture_output=True, text=True)
            remaining = self.scope.run(["docker", "container", "ls", "--all", "--filter", "name=^/" + container + "$",
                                        "--format", "{{.ID}}"], env=runtime.SAFE_ENV, timeout=15,
                                       check=True, capture_output=True, text=True)
            _require(not remaining.stdout, "P2_SCOPED_MUX_COURSE_QUERY_CONTAINER_REMAINS")

    def _preflight(self):
        self._check()
        frontend = self._frontend_closed()
        storage = self._storage_identity()
        process_rows = [row for row in self.broker.process_snapshot if row["service"] == "gateway"]
        runtime_rows = [row for row in self.broker.runtime_current if row["service"] == "gateway"]
        _require(len(process_rows) == len(runtime_rows) == 1 and
                 process_rows[0]["containerId"] == runtime_rows[0]["containerId"] and
                 process_rows[0]["mounts"].get("/admission") == str(self.broker.configuration / "admission") and
                 runtime_rows[0]["image"] == self.broker.selected["artifacts"]["gateway"]["image"],
                 "P2_SCOPED_MUX_LOCKED_GATEWAY_PROCESS_REQUIRED")
        gateway = self._gateway_observation()
        admission = gateway.get("admission")
        _require(type(admission) is dict and admission.get("valid") is True and admission.get("newWork") is False and
                 admission.get("recovery") is False and all(admission.get(group, {}).get(key) == 0
                 for group in ("active", "uncertain") for key in ("newWork", "recovery")) and
                 gateway.get("admissionDirectory") == {"device": str(storage.st_dev), "inode": str(storage.st_ino)},
                 "P2_SCOPED_MUX_INITIAL_GATEWAY_CLOSED_REQUIRED")
        raw = self._read_state()
        try:
            ordinary = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("P2_SCOPED_MUX_INITIAL_STATE_REQUIRED") from None
        self._ordinary_closed(ordinary)
        known_encodings = (_canonical(ordinary), (json.dumps(ordinary, sort_keys=True) + "\n").encode())
        _require(raw in known_encodings and admission.get("sha256") == _hash(raw),
                 "P2_SCOPED_MUX_INITIAL_STATE_BYTES_REQUIRED")
        self._original_raw, self._original_sha256 = raw, _hash(raw)
        self._managed_before = self._managed_attempt("before")
        self._initial_frontend = frontend
        self._gateway_process_sha256 = gateway["processSha256"]
        self._mount = {"device": str(storage.st_dev), "inode": str(storage.st_ino)}

    def _base_receipt(self, status):
        return {"version": 2, "qualificationTargetProfile": copy.deepcopy(_PROFILE), "status": status,
                "environment": "staging", "actionId": self.broker.action_id(),
                "releaseId": self.broker.selected["releaseId"],
                "sourceCommit": self.broker.selected["sources"]["frontend"]["commit"],
                "operatorSourceCommit": self.broker.initial["sourceCommit"],
                "candidateSha256": self.broker.initial["candidateSha256"], "scopedAction": copy.deepcopy(self.action),
                "gatewayProcessSha256": self._gateway_process_sha256, "admissionDirectory": copy.deepcopy(self._mount),
                "originalStateSha256": self._original_sha256, "managedRowSha256": self._managed_before["rowSha256"],
                "databaseIdentitySha256": self._managed_before["databaseIdentitySha256"],
                "ordinaryNewWorkAuthorized": False, "ordinaryRecoveryAuthorized": False,
                "nativeSchedulesEnabled": False, "trafficAuthorized": False, "releaseAccepted": False}

    def _scoped_marker(self):
        gateway = self._gateway_observation()
        admission = gateway.get("admission")
        expected = {"valid", "sha256", "version", "environment", "releaseId", "candidateSha256", "actionId",
                    "newWork", "recovery", "muxCallbackActive", "active", "uncertain", "muxCallbackEvidence"}
        _require(type(admission) is dict and set(admission) == expected and admission["valid"] is False and
                 admission["sha256"] == self._scoped_sha256 and admission["version"] == 2 and
                 admission["environment"] == "staging" and admission["releaseId"] == self.broker.selected["releaseId"] and
                 admission["candidateSha256"] == self.broker.initial["candidateSha256"] and
                 admission["actionId"] == self.broker.action_id() and admission["newWork"] is None and
                 admission["recovery"] is None and admission["muxCallbackActive"] is True,
                 "P2_SCOPED_MUX_GATEWAY_MARKER_REQUIRED")
        for group in ("active", "uncertain"):
            _require(type(admission[group]) is dict and set(admission[group]) == {"newWork", "recovery"} and
                     all(type(value) is int and 0 <= value <= 128 for value in admission[group].values()),
                     "P2_SCOPED_MUX_GATEWAY_COUNTER_REQUIRED")
        evidence = admission["muxCallbackEvidence"]
        _require(type(evidence) is dict and set(evidence) == {"admitted", "managedAcks"} and
                 type(evidence["admitted"]) is int and 0 <= evidence["admitted"] <= 16 and
                 type(evidence["managedAcks"]) is list and len(evidence["managedAcks"]) <= 16,
                 "P2_SCOPED_MUX_GATEWAY_EVIDENCE_REQUIRED")
        seen = set()
        for row in evidence["managedAcks"]:
            _require(type(row) is dict and set(row) == {"requestId", "eventId", "upstreamStatus"} and
                     _provider(row["requestId"]) and _provider(row["eventId"]) and row["upstreamStatus"] == 200 and
                     (row["requestId"], row["eventId"]) not in seen, "P2_SCOPED_MUX_MANAGED_ACK_REQUIRED")
            seen.add((row["requestId"], row["eventId"]))
        _require(evidence["admitted"] >= len(evidence["managedAcks"]),
                 "P2_SCOPED_MUX_MANAGED_ACK_COUNT_REQUIRED")
        return copy.deepcopy(admission)

    @staticmethod
    def _marker_disposition(marker):
        evidence = marker["muxCallbackEvidence"]
        active = sum(marker["active"].values())
        uncertain = sum(marker["uncertain"].values())
        complete = evidence["admitted"] > 0 and evidence["admitted"] == len(evidence["managedAcks"])
        if uncertain:
            return "uncertain"
        if active or not complete:
            return "waiting"
        return "observed"

    def open(self):
        _require(self._state == "new", "P2_SCOPED_MUX_OPEN_ORDER_REQUIRED")
        self._check()
        self._frontend_closed()
        self._storage_identity()
        milliseconds = int(time.time() * 1000)
        duration = min(self.plan["maximumSeconds"] * 1000, _MAX_WINDOW_MS)
        callback = {**copy.deepcopy(self.action), "issuedAt": _instant(milliseconds),
                    "expiresAt": _instant(milliseconds + duration),
                    "gatewayProcessSha256": self._gateway_process_sha256,
                    "mountDevice": self._mount["device"], "mountInode": self._mount["inode"]}
        state = {"version": 2, "environment": "staging", "releaseId": self.broker.selected["releaseId"],
                 "candidateSha256": self.broker.initial["candidateSha256"], "actionId": self.broker.action_id(),
                 "newWork": False, "recovery": False, "muxCallback": callback}
        raw = _canonical(state)
        _require(len(raw) <= _MAX_STATE_BYTES, "P2_SCOPED_MUX_STATE_BOUNDS")
        self._scoped_raw, self._scoped_sha256 = raw, _hash(raw)
        self._opened_at, self._deadline = time.monotonic(), time.monotonic() + duration / 1000
        self._replace_state(raw, "open")
        try:
            _require(self._read_state() == raw, "P2_SCOPED_MUX_STATE_READBACK_REQUIRED")
            marker = self._scoped_marker()
        except BaseException:
            self._replace_state(self._original_raw, "rollback")
            self._state = "closed"
            raise
        self._state = "open"
        disposition = self._marker_disposition(marker)
        return {**self._base_receipt("P2_SCOPED_MUX_OPENED"), "scopedStateSha256": self._scoped_sha256,
                "issuedAt": callback["issuedAt"], "expiresAt": callback["expiresAt"],
                "muxCallbackActive": marker["muxCallbackActive"],
                "admitted": marker["muxCallbackEvidence"]["admitted"],
                "managedAckCount": len(marker["muxCallbackEvidence"]["managedAcks"]),
                "effectAlreadyVisible": disposition == "observed", "effectObserved": False}

    def observe(self):
        now = time.monotonic()
        _require(self._state == "open" and self._observed is None and now < self._deadline,
                 "P2_SCOPED_MUX_OBSERVE_ORDER_REQUIRED")
        self._check()
        self._frontend_closed()
        _require(self._read_state() == self._scoped_raw, "P2_SCOPED_MUX_STATE_CHANGED")
        marker = self._scoped_marker()
        disposition = self._marker_disposition(marker)
        evidence = marker["muxCallbackEvidence"]
        waiting = {**self._base_receipt("P2_SCOPED_MUX_WAITING" if disposition == "waiting" else
                                       "P2_SCOPED_MUX_UNCERTAIN"),
                   "scopedStateSha256": self._scoped_sha256, "admitted": evidence["admitted"],
                   "managedAckCount": len(evidence["managedAcks"]),
                   "active": copy.deepcopy(marker["active"]), "uncertain": copy.deepcopy(marker["uncertain"]),
                   "effectObserved": False, "gatewayEffectDrained": False}
        if disposition != "observed":
            return waiting
        managed = self._managed_attempt("after")
        _require(managed["rowSha256"] != "0" * 64, "P2_SCOPED_MUX_MANAGED_EFFECT_REQUIRED")
        acknowledgments = evidence["managedAcks"]
        self._observed = {**self._base_receipt("P2_SCOPED_MUX_EFFECT_OBSERVED"),
                          "scopedStateSha256": self._scoped_sha256,
                          "managedRowSha256": managed["rowSha256"],
                          "managedRowChanged": managed["rowSha256"] != self._managed_before["rowSha256"],
                          "managedAckCount": len(acknowledgments),
                          "managedAcksSha256": _hash(_canonical(acknowledgments)),
                          "effectObserved": True, "gatewayEffectDrained": True}
        return copy.deepcopy(self._observed)

    def close(self):
        _require(self._state == "open", "P2_SCOPED_MUX_CLOSE_ORDER_REQUIRED")
        # Closure is unconditional once the source-owned file was installed.
        # It deliberately does not depend on the scoped lease still being live.
        current = self._read_state()
        _require(current == self._scoped_raw, "P2_SCOPED_MUX_UNRELATED_STATE_PRESERVED")
        self._replace_state(self._original_raw, "close")
        self._state = "closed"
        _require(self._read_state() == self._original_raw, "P2_SCOPED_MUX_CLOSED_STATE_READBACK_REQUIRED")
        self._check()
        deadline = time.monotonic() + 5
        while True:
            gateway = self._gateway_observation()["admission"]
            _require(type(gateway) is dict and gateway.get("valid") is True and gateway.get("sha256") == self._original_sha256 and
                     gateway.get("newWork") is False and gateway.get("recovery") is False and
                     gateway.get("uncertain") == {"newWork": 0, "recovery": 0}, "P2_SCOPED_MUX_CLOSE_DRAIN_REQUIRED")
            if gateway.get("active") == {"newWork": 0, "recovery": 0}:
                break
            _require(time.monotonic() < deadline, "P2_SCOPED_MUX_CLOSE_DRAIN_REQUIRED")
            time.sleep(0.1)
            self._check()
        _require(self._observed is not None, "P2_SCOPED_MUX_EFFECT_NOT_OBSERVED")
        managed = self._managed_attempt("after")
        _require(managed["rowSha256"] == self._observed["managedRowSha256"], "P2_SCOPED_MUX_EFFECT_CHANGED_BEFORE_CLOSE")
        frontend = self._frontend_closed()
        return {**self._base_receipt("P2_SCOPED_MUX_CLOSED"), "scopedStateSha256": self._scoped_sha256,
                "managedRowSha256": self._observed["managedRowSha256"],
                "managedRowChanged": self._observed["managedRowChanged"],
                "managedAckCount": self._observed["managedAckCount"],
                "managedAcksSha256": self._observed["managedAcksSha256"],
                "frontendAdmission": frontend, "gatewayAdmissionClosed": True,
                "effectObserved": True, "gatewayEffectDrained": True}

    def __del__(self):
        descriptor = getattr(self, "_admission_fd", None)
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
            self._admission_fd = None


if __name__ == "__main__":
    print(json.dumps({"version": 2, "status": "P2_SCOPED_MUX_SOURCE_PARENT_REQUIRED",
                      "standaloneActivationEligible": False, "mutationsPerformed": False,
                      "trafficAuthorized": False, "releaseAccepted": False}, separators=(",", ":")))
