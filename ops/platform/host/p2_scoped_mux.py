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
_RESERVATION_KEYS = {"courseId", "lessonId", "courseRevision", "attemptId", "uploadId", "generation", "environmentId",
                     "status", "isCurrent", "readOnly"}
_PROVIDER = re.compile(r"[A-Za-z0-9_-]{1,255}")
_UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
_SHA = re.compile(r"[a-f0-9]{64}")
_EPOCH = re.compile(r"[1-9][0-9]{0,17}")
_UPLOAD_EVENT = "video.upload.asset_created"
_EVENTS = {
    _UPLOAD_EVENT,
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
_ZERO = {"newWork": 0, "recovery": 0}


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

_ONE_SHOT_COURSE_QUERY = r'''import { Client } from "/app/node_modules/pg/esm/index.mjs";
import { directMigrationConnection, hasVerifiedMigrationTransport } from "/app/dist-migration/src/db/migration-lineage.js";
try {
 const chunks=[];let length=0;
 for await(const chunk of process.stdin){length+=chunk.length;if(length>16384)throw Error();chunks.push(chunk);}
 const {attemptId,connectionUrl,target}=JSON.parse(Buffer.concat(chunks));
 if(new URL(connectionUrl).search!=="?sslmode=verify-full")throw Error();
 const client=new Client({...directMigrationConnection(connectionUrl,target),enableChannelBinding:true,
    options:"-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=2000"});
 let disconnected=false,identity,rows;
 client.on("error",()=>{disconnected=true;});
 try {
    await client.connect();
    if(!hasVerifiedMigrationTransport(client,target.host))throw Error();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    [identity]=(await client.query(`SELECT current_user AS "user",current_database() AS database,
        current_setting('server_version_num')::int AS server_version_num,
        current_setting('transaction_read_only') AS read_only,current_setting('search_path') AS search_path`)).rows;
    if(identity?.read_only!=="on"||identity.search_path!=="pg_catalog")throw Error();
    ({rows}=await client.query(`SELECT a.id::text AS "attemptId",l.id::text AS "lessonId",c.id::text AS "courseId",
        c.revision AS "courseRevision",a.generation,a.managed_by_course AS "managedByCourse",
        a.provider_environment_id AS "environmentId",a.mux_upload_id AS "uploadId",a.mux_asset_id AS "assetId",
        a.status,a.is_current AS "isCurrent",a.deleted_at::text AS "deletedAt",a.superseded_at::text AS "supersededAt",
        a.recovery_attempts AS "recoveryAttempts",a.recovery_lease_owner IS NOT NULL AS "recoveryLeasePresent",
        a.recovery_next_attempt_at::text AS "wakeAt",a.last_error_code AS "lastErrorCode"
      FROM public.video_assets a JOIN public.lessons l ON l.id=a.lesson_id
      JOIN public.modules m ON m.id=l.module_id JOIN public.courses c ON c.id=m.course_id
      WHERE a.id=$1::uuid AND c.status='draft' AND l.archived_at IS NULL AND m.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM public.video_assets later WHERE later.lesson_id=l.id AND later.generation>a.generation)`,[attemptId]));
    await client.query("ROLLBACK");
    if(!hasVerifiedMigrationTransport(client,target.host))throw Error();
 }finally{await client.end();}
 if(disconnected)throw Error();
 process.stdout.write(JSON.stringify({identity,rows})+"\n");
}catch{process.stderr.write("P2_SCOPED_MUX_COURSE_QUERY_REFUSED\n");process.exitCode=1;}
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

    def __init__(self, broker, *, reservation=None, expires_at=None):
        # Lazy imports avoid making this module another broker entry point.
        from p2_certification_parent import P2CertificationScope, P2ProfiledCertificationBroker

        _require(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope,
                 "P2_SCOPED_MUX_PROFILED_CERTIFICATION_PARENT_REQUIRED")
        self.broker, self.scope = broker, broker.scope
        self.plan = broker.initial["certificationPlan"]
        self._one_shot = reservation is not None
        _require(broker.certification_profile() == _PROFILE and self.scope._expected_profile == _PROFILE and
                 broker.external_armed is True and
                 (self.plan.get("mode") == "interactive-browser" and broker.guard_arm_verified is True if self._one_shot
                  else self.plan.get("mode") == "mux-callback-recovery" and expires_at is None),
                 "P2_SCOPED_MUX_SOURCE_MODE_REQUIRED")
        self._reservation = None
        if self._one_shot:
            from p2_interactive_window import media_upload_selected, validate_interactive_plan_action

            scoped = validate_interactive_plan_action(self.plan)
            _require(media_upload_selected(self.plan) and self.plan.get("startState") == "already-closed" and
                     type(self.plan.get("initialEpoch")) is str and _EPOCH.fullmatch(self.plan["initialEpoch"]) is not None and
                     int(self.plan["initialEpoch"]) <= 10**18 - 3 and
                     type(expires_at) is int and time.time() < expires_at <= time.time() + 300,
                     "P2_SCOPED_MUX_ONE_SHOT_WINDOW_REQUIRED")
            self._reservation = self._validate_reservation(reservation, scoped["mediaAction"])
            self._expires_at = expires_at
            self.action = self._validate_action({
                **{key: reservation[key] for key in ("attemptId", "generation", "environmentId", "uploadId")},
                "assetId": None, "eventType": _UPLOAD_EVENT,
            })
        else:
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
        self._original_metadata = None
        self._original_sha256 = None
        self._managed_before = None
        self._observed = None
        self._observed_managed = None
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
        upload = value["eventType"] == _UPLOAD_EVENT
        track = value["eventType"] in _TRACK_EVENTS
        _require((not upload or value["uploadId"] is not None) and (not track or value["assetId"] is not None),
                 "P2_SCOPED_MUX_EVENT_BINDING_REQUIRED")
        return copy.deepcopy(value)

    @staticmethod
    def _validate_reservation(value, selected):
        _require(type(value) is dict and set(value) == _RESERVATION_KEYS and
                 all(value[key] == selected[key] for key in ("courseId", "lessonId")) and
                 type(value["courseRevision"]) is int and value["courseRevision"] == selected["revision"] + 1 and
                 type(value["attemptId"]) is str and _UUID.fullmatch(value["attemptId"]) is not None and
                 value["attemptId"] != selected["currentVideoAssetId"] and type(value["generation"]) is int and
                 1 <= value["generation"] <= 2_147_483_647 and _provider(value["environmentId"]) and
                 _provider(value["uploadId"]) and value["status"] == "uploading" and
                 value["isCurrent"] is (selected["currentVideoAssetId"] is None) and value["readOnly"] is True,
                 "P2_SCOPED_MUX_ONE_SHOT_RESERVATION_REQUIRED")
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
        if self._one_shot:
            _require(admission["epoch"] == str(int(self.plan["initialEpoch"]) + 2) and
                     all(type(admission[key]) is int for key in ("active", "uncertain")),
                     "P2_SCOPED_MUX_ONE_SHOT_FRONTEND_EPOCH_REQUIRED")
        return copy.deepcopy(admission)

    def _gateway_observation(self):
        observe = getattr(self.broker, "_gateway_observation", None)
        _require(callable(observe), "P2_SCOPED_MUX_GATEWAY_OBSERVER_REQUIRED")
        value = observe()
        _require(type(value) is dict and value.get("status") == "P2_FAULT_GATEWAY_CURRENT" and
                 value.get("processSha256") == self.plan["gatewayProcessSha256"] and
                 value.get("gatewayConfigurationSha256") == self.plan["gatewayConfigurationSha256"] and
                 (not self._one_shot or value.get("faultLeasePresent") is False) and
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

    def _read_state(self, *, with_metadata=False):
        descriptor = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self._admission_fd)
        try:
            info = os.fstat(descriptor)
            _require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
                     0 < info.st_size <= _MAX_STATE_BYTES, "P2_SCOPED_MUX_ADMISSION_FILE_REQUIRED")
            raw = os.read(descriptor, _MAX_STATE_BYTES + 1)
            _require(len(raw) == info.st_size, "P2_SCOPED_MUX_ADMISSION_READ_REQUIRED")
            if with_metadata:
                _require(info.st_nlink == 1 and not stat.S_IMODE(info.st_mode) & 0o7000 and len(raw) == info.st_size,
                         "P2_SCOPED_MUX_ADMISSION_FILE_REQUIRED")
                return raw, stat.S_IMODE(info.st_mode), info.st_gid
            return raw
        finally:
            os.close(descriptor)

    def _replace_state(self, raw, label, *, mode=0o644, gid=None):
        _require(type(raw) is bytes and 0 < len(raw) <= _MAX_STATE_BYTES and
                 re.fullmatch(r"[a-z0-9-]{1,64}", label), "P2_SCOPED_MUX_ADMISSION_BYTES_REQUIRED")
        name = ".p2-scoped-mux-" + label + "-" + uuid.uuid4().hex
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644,
                             dir_fd=self._admission_fd)
        try:
            if gid is not None:
                os.fchown(descriptor, 0, gid)
            os.fchmod(descriptor, mode)
            _write_all(descriptor, raw)
            os.replace(name, "state.json", src_dir_fd=self._admission_fd, dst_dir_fd=self._admission_fd)
            os.fsync(self._admission_fd)
        finally:
            os.close(descriptor)
            try:
                os.unlink(name, dir_fd=self._admission_fd)
            except FileNotFoundError:
                pass

    def _restore_original(self, label):
        if self._one_shot:
            mode, gid = self._original_metadata
            self._replace_state(self._original_raw, label, mode=mode, gid=gid)
            _require(self._read_state(with_metadata=True) == (self._original_raw, mode, gid),
                     "P2_SCOPED_MUX_CLOSED_STATE_READBACK_REQUIRED")
        else:
            self._replace_state(self._original_raw, label)

    def _ordinary_closed(self, value):
        expected = {"actionId", "candidateSha256", "environment", "newWork", "recovery", "releaseId", "version"}
        _require(type(value) is dict and set(value) == expected and value["version"] == 1 and
                 value["environment"] == "staging" and value["releaseId"] == self.broker.selected["releaseId"] and
                 value["candidateSha256"] == self.broker.initial["candidateSha256"] and
                 type(value["actionId"]) is str and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value["actionId"]) and
                 value["newWork"] is False and value["recovery"] is False,
                 "P2_SCOPED_MUX_INITIAL_CLOSED_STATE_REQUIRED")
        return value

    def _managed_attempt(self, phase="current", *, asset_id=None, prior=None):
        _require(phase in ("before", "after", "current"), "P2_SCOPED_MUX_MANAGED_PHASE_REQUIRED")
        info = self.broker.jobs["course"]
        job = info["job"]
        credential = self.broker.initial["credentials"]["COURSE_STAGING_DATABASE_URL"]
        _require(type(credential) is str and credential and info["image"] == self.broker.selected["artifacts"]["courseMigration"]["image"],
                 "P2_SCOPED_MUX_COURSE_IMAGE_REQUIRED")
        payload = {"attemptId": self.action["attemptId"]}
        if self._one_shot:
            container = "lash-p2-certification-api-check-course-" + uuid.uuid4().hex
            args = ["docker", "run", "--rm", "--pull", "never", "--platform", "linux/amd64", "--name", container,
                    "--interactive", "--network", "bridge", "--read-only", "--cap-drop", "ALL",
                    "--security-opt", "no-new-privileges:true", "--user", "65532:65532", "--memory", "256m",
                    "--cpus", "0.5", "--pids-limit", "64", "--entrypoint", "node", info["image"], "--input-type=module",
                    "--eval", _ONE_SHOT_COURSE_QUERY]
            environment = runtime.SAFE_ENV
            payload.update(connectionUrl=credential, target=job["target"])
        else:
            container = "lash-p2-scoped-mux-course-" + uuid.uuid4().hex
            args = ["docker", "run", "--rm", "--name", container, "--interactive", "--network", "host", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
                    "--env", "STAGING_DATABASE_URL", "--entrypoint", "node", info["image"], "--input-type=module", "--eval", _COURSE_QUERY]
            environment = {**runtime.SAFE_ENV, "STAGING_DATABASE_URL": credential}
        payload = json.dumps(payload)
        _require(len(payload.encode()) <= _MAX_OBSERVATION_BYTES, "P2_SCOPED_MUX_COURSE_QUERY_INPUT_REQUIRED")
        try:
            result = self.scope.run(args, env=environment, input=payload, text=True,
                                    timeout=30, check=True, capture_output=True)
            _require(not result.stderr and 0 < len(result.stdout.encode()) <= _MAX_OBSERVATION_BYTES,
                     "P2_SCOPED_MUX_COURSE_QUERY_REQUIRED")
            if self._one_shot:
                from qualification_target_profile import decode_qualification_target_json

                value = decode_qualification_target_json(result.stdout, "carrier")
                _require(type(value) is dict and set(value) == {"identity", "rows"},
                         "P2_SCOPED_MUX_COURSE_QUERY_REQUIRED")
            else:
                value = json.loads(result.stdout)
            target = job["target"]
            identity = value.get("identity")
            rows = value.get("rows")
            identity_keys = {"user", "database", "server_version_num"}
            if self._one_shot:
                identity_keys |= {"read_only", "search_path"}
            _require(type(identity) is dict and set(identity) == identity_keys and
                     identity["user"] == target["user"] and identity["database"] == target["database"] and
                     type(identity["server_version_num"]) is int and identity["server_version_num"] // 10000 == target["serverMajor"] and
                     (not self._one_shot or identity["read_only"] == "on" and identity["search_path"] == "pg_catalog") and
                     type(rows) is list and len(rows) == 1, "P2_SCOPED_MUX_COURSE_DATABASE_REQUIRED")
            row = rows[0]
            keys = {"attemptId", "generation", "managedByCourse", "environmentId", "uploadId", "assetId", "status", "isCurrent", "deletedAt"}
            if self._one_shot:
                keys |= {"courseId", "lessonId", "courseRevision", "supersededAt", "recoveryAttempts", "recoveryLeasePresent", "wakeAt", "lastErrorCode"}
            _require(type(row) is dict and set(row) == keys and row["attemptId"] == self.action["attemptId"] and
                     type(row["generation"]) is int and row["generation"] == self.action["generation"] and row["managedByCourse"] is True and
                     row["environmentId"] == self.action["environmentId"] and row["uploadId"] == self.action["uploadId"] and
                     row["status"] in _STATUSES and type(row["isCurrent"]) is bool and row["deletedAt"] is None,
                     "P2_SCOPED_MUX_MANAGED_ATTEMPT_REQUIRED")
            if self._one_shot:
                self._one_shot_managed_attempt(row, phase, asset_id, prior)
            else:
                asset_matches = row["assetId"] == self.action["assetId"]
                if self.action["eventType"] == _UPLOAD_EVENT and phase == "after" and self.action["assetId"] is None:
                    asset_matches = _provider(row["assetId"])
                _require(asset_matches, "P2_SCOPED_MUX_MANAGED_ATTEMPT_REQUIRED")
            return {"row": row, "rowSha256": _hash(_canonical(row)),
                    "databaseIdentitySha256": _hash(_canonical(identity))}
        finally:
            self.scope.run(["docker", "rm", "--force", container], env=runtime.SAFE_ENV, timeout=30,
                           check=False, capture_output=True, text=True)
            remaining = self.scope.run(["docker", "container", "ls", "--all", "--filter", "name=^/" + container + "$",
                                        "--format", "{{.ID}}"], env=runtime.SAFE_ENV, timeout=15,
                                       check=True, capture_output=True, text=True)
            _require(not remaining.stdout, "P2_SCOPED_MUX_COURSE_QUERY_CONTAINER_REMAINS")

    def _one_shot_managed_attempt(self, row, phase, asset_id, prior):
        reservation = self._reservation
        _require(all(row[key] == reservation[key] for key in ("courseId", "lessonId", "courseRevision")) and
                 type(row["courseRevision"]) is int and row["supersededAt"] is None and
                 type(row["recoveryAttempts"]) is int and 0 <= row["recoveryAttempts"] <= 2_147_483_647 and
                 type(row["recoveryLeasePresent"]) is bool and type(row["wakeAt"]) is str and 0 < len(row["wakeAt"]) <= 64 and
                 (row["lastErrorCode"] is None or _provider(row["lastErrorCode"])) and row["lastErrorCode"] != "PROVIDER_OWNERSHIP_MISMATCH",
                 "P2_SCOPED_MUX_ONE_SHOT_MANAGED_LINEAGE_REQUIRED")
        if phase == "before":
            _require(row["assetId"] is None and row["status"] == "uploading" and row["isCurrent"] is reservation["isCurrent"],
                     "P2_SCOPED_MUX_ONE_SHOT_RESERVATION_CHANGED")
            return
        _require(phase == "after" and _provider(asset_id) and type(prior) is dict and
                 (row["assetId"] is None or row["assetId"] == asset_id) and
                 row["status"] in ("uploading", "processing", "ready", "errored") and
                 (row["status"] != "ready" or row["assetId"] == asset_id and row["isCurrent"] is True) and
                 (prior["assetId"] is None or prior["assetId"] == row["assetId"]) and
                 (not prior["isCurrent"] or row["isCurrent"]) and
                 (row["isCurrent"] == prior["isCurrent"] or row["status"] == "ready") and
                 (prior["status"] != "ready" or row["status"] in ("ready", "errored")) and
                 row["recoveryAttempts"] >= prior["recoveryAttempts"],
                 "P2_SCOPED_MUX_ONE_SHOT_MANAGED_LINEAGE_REQUIRED")
        # Course's webhook wakes this row. Asset adoption and status promotion
        # belong to the worker and may be visible before either held readback.
        changed = any(row[key] != prior[key] for key in ("assetId", "status", "isCurrent"))
        _require(not changed or prior["recoveryLeasePresent"] or row["recoveryAttempts"] > prior["recoveryAttempts"],
                 "P2_SCOPED_MUX_ONE_SHOT_MANAGED_WORKER_RACE_UNPROVED")

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
        if self._one_shot:
            from current_databases import read_certification_api_proof

            read_certification_api_proof(self.broker.api_proof, self.scope, self.broker.selected, self.broker.jobs,
                                         expected_profile=_PROFILE)
            raw, mode, gid = self._read_state(with_metadata=True)
            self._original_metadata = (mode, gid)
        else:
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
                "nativeSchedulesEnabled": False, "trafficAuthorized": False, "releaseAccepted": False,
                **({"oneShot": True} if self._one_shot else {})}

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
        evidence = self._require_gateway_evidence(admission["muxCallbackEvidence"])
        if self._one_shot:
            _require(all(admission[group]["newWork"] == 0 and admission[group]["recovery"] <= evidence["admitted"]
                         for group in ("active", "uncertain")),
                     "P2_SCOPED_MUX_ONE_SHOT_COUNTER_REQUIRED")
        return copy.deepcopy(admission)

    def _require_gateway_evidence(self, evidence):
        maximum = 1 if self._one_shot else 16
        _require(type(evidence) is dict and set(evidence) == {"admitted", "managedAcks"} and
                 type(evidence["admitted"]) is int and 0 <= evidence["admitted"] <= maximum and
                 type(evidence["managedAcks"]) is list and len(evidence["managedAcks"]) <= maximum,
                 "P2_SCOPED_MUX_GATEWAY_EVIDENCE_REQUIRED")
        seen = set()
        fields = {"requestId", "eventId", "upstreamStatus"} | ({"assetId"} if self._one_shot else set())
        for row in evidence["managedAcks"]:
            _require(type(row) is dict and set(row) == fields and _provider(row["requestId"]) and _provider(row["eventId"]) and
                     type(row["upstreamStatus"]) is int and row["upstreamStatus"] == 200 and
                     (not self._one_shot or _UUID.fullmatch(row["requestId"]) is not None and _provider(row["assetId"])) and
                     (row["requestId"], row["eventId"]) not in seen, "P2_SCOPED_MUX_MANAGED_ACK_REQUIRED")
            seen.add((row["requestId"], row["eventId"]))
        _require(evidence["admitted"] >= len(evidence["managedAcks"]),
                 "P2_SCOPED_MUX_MANAGED_ACK_COUNT_REQUIRED")
        return evidence

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
        if self._one_shot:
            _require(self._read_state(with_metadata=True) == (self._original_raw, *self._original_metadata),
                     "P2_SCOPED_MUX_UNRELATED_STATE_PRESERVED")
            duration = min(duration, self._expires_at * 1000 - milliseconds)
            _require(duration > 0, "P2_SCOPED_MUX_ONE_SHOT_WINDOW_EXPIRED")
        callback = {**copy.deepcopy(self.action), "issuedAt": _instant(milliseconds),
                    "expiresAt": _instant(milliseconds + duration),
                    "gatewayProcessSha256": self._gateway_process_sha256,
                    "mountDevice": self._mount["device"], "mountInode": self._mount["inode"],
                    **({"oneShot": True} if self._one_shot else {})}
        state = {"version": 2, "environment": "staging", "releaseId": self.broker.selected["releaseId"],
                 "candidateSha256": self.broker.initial["candidateSha256"], "actionId": self.broker.action_id(),
                 "newWork": False, "recovery": False, "muxCallback": callback}
        raw = _canonical(state)
        _require(len(raw) <= _MAX_STATE_BYTES, "P2_SCOPED_MUX_STATE_BOUNDS")
        self._scoped_raw, self._scoped_sha256 = raw, _hash(raw)
        self._opened_at, self._deadline = time.monotonic(), time.monotonic() + duration / 1000
        if not self._one_shot:
            self._replace_state(raw, "open")
        try:
            if self._one_shot:
                self._replace_state(raw, "open")
            _require(self._read_state() == raw, "P2_SCOPED_MUX_STATE_READBACK_REQUIRED")
            marker = self._scoped_marker()
            if self._one_shot:
                _require(marker["muxCallbackActive"] is True and marker["muxCallbackEvidence"]["admitted"] == 0 and
                         time.monotonic() < self._deadline and time.time() * 1000 < milliseconds + duration,
                         "P2_SCOPED_MUX_ONE_SHOT_ARM_REQUIRED")
        except BaseException:
            if self._one_shot:
                current = self._read_state(with_metadata=True)
                if current[0] == raw:
                    self._restore_original("rollback")
                else:
                    _require(current == (self._original_raw, *self._original_metadata), "P2_SCOPED_MUX_UNRELATED_STATE_PRESERVED")
            else:
                self._restore_original("rollback")
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
        acknowledgments = evidence["managedAcks"]
        if self._one_shot:
            managed = self._managed_attempt("after", asset_id=acknowledgments[0]["assetId"], prior=self._managed_before["row"])
            _require(managed["databaseIdentitySha256"] == self._managed_before["databaseIdentitySha256"],
                     "P2_SCOPED_MUX_ONE_SHOT_MANAGED_LINEAGE_REQUIRED")
            self._observed_managed = managed
        else:
            managed = self._managed_attempt("after")
        _require(managed["rowSha256"] != "0" * 64, "P2_SCOPED_MUX_MANAGED_EFFECT_REQUIRED")
        self._observed = {**self._base_receipt("P2_SCOPED_MUX_EFFECT_OBSERVED"),
                          "scopedStateSha256": self._scoped_sha256,
                          "managedRowSha256": managed["rowSha256"],
                          "managedRowChanged": managed["rowSha256"] != self._managed_before["rowSha256"],
                          "managedAckCount": len(acknowledgments),
                          "managedAcksSha256": _hash(_canonical(acknowledgments)),
                          "effectObserved": True, "gatewayEffectDrained": True,
                          **(self._one_shot_ack_fields(acknowledgments[0], managed["row"]) if self._one_shot else {})}
        return copy.deepcopy(self._observed)

    @staticmethod
    def _one_shot_ack_fields(ack, row):
        return {"admitted": 1, **{key: ack[key] for key in ("requestId", "eventId", "assetId")},
                "managedAssetId": row["assetId"], "managedStatus": row["status"], "wakeTransactionAcknowledged": True}

    def close(self):
        _require(self._state == "open", "P2_SCOPED_MUX_CLOSE_ORDER_REQUIRED")
        # Closure is unconditional once the source-owned file was installed.
        # It deliberately does not depend on the scoped lease still being live.
        current = self._read_state()
        _require(current == self._scoped_raw, "P2_SCOPED_MUX_UNRELATED_STATE_PRESERVED")
        self._restore_original("close")
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
        final = {}
        if self._one_shot:
            ordinary = json.loads(self._original_raw)
            _require(_canonical({key: gateway.get(key) for key in ordinary}) == _canonical(ordinary) and
                     all(_canonical(gateway[group]) == _canonical(_ZERO) for group in ("active", "uncertain")),
                     "P2_SCOPED_MUX_ONE_SHOT_FINAL_STATE_REQUIRED")
            receipt = gateway.get("muxCallbackFinal")
            _require(type(receipt) is dict and set(receipt) == {"scopedStateSha256", "admitted", "managedAcks"} and
                     receipt["scopedStateSha256"] == self._scoped_sha256,
                     "P2_SCOPED_MUX_ONE_SHOT_FINAL_EVIDENCE_REQUIRED")
            evidence = self._require_gateway_evidence({key: receipt[key] for key in ("admitted", "managedAcks")})
            acks = evidence["managedAcks"]
            _require(evidence["admitted"] == len(acks) == 1 and _hash(_canonical(acks)) == self._observed["managedAcksSha256"],
                     "P2_SCOPED_MUX_ONE_SHOT_FINAL_ACK_REQUIRED")
            managed = self._managed_attempt("after", asset_id=acks[0]["assetId"], prior=self._observed_managed["row"])
            _require(managed["databaseIdentitySha256"] == self._managed_before["databaseIdentitySha256"] and
                     self._read_state(with_metadata=True) == (self._original_raw, *self._original_metadata),
                     "P2_SCOPED_MUX_ONE_SHOT_FINAL_OWNERSHIP_REQUIRED")
            final = {**self._one_shot_ack_fields(acks[0], managed["row"]), "gatewayStateSha256": gateway["sha256"],
                     "gatewayStateRestored": True}
            self._check()
        else:
            managed = self._managed_attempt("after")
            _require(managed["rowSha256"] == self._observed["managedRowSha256"], "P2_SCOPED_MUX_EFFECT_CHANGED_BEFORE_CLOSE")
        frontend = self._frontend_closed()
        return {**self._base_receipt("P2_SCOPED_MUX_CLOSED"), "scopedStateSha256": self._scoped_sha256,
                "managedRowSha256": managed["rowSha256"],
                "managedRowChanged": managed["rowSha256"] != self._managed_before["rowSha256"],
                "managedAckCount": self._observed["managedAckCount"],
                "managedAcksSha256": self._observed["managedAcksSha256"],
                "frontendAdmission": frontend, "gatewayAdmissionClosed": True,
                "effectObserved": True, "gatewayEffectDrained": True, **final}

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
