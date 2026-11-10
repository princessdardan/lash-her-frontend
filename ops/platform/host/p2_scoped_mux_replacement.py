"""Join source-owned staging Mux replacement and expiry observations."""

from datetime import datetime, timezone
from pathlib import Path
import re

import migrate
from p2_scoped_mux import _PROFILE, _canonical, _hash, _require, profiled_course_query
from p2_scoped_mux_readiness import (P2HeldMuxReadStage, READY_SELECT, _digest, readiness_parameters,
                                     require_held_receipt, require_ready_row, validate_selection as validate_ready)


_SOURCE = Path(__file__).resolve()
_SOURCE_KEY = "ops/platform/host/p2_scoped_mux_replacement.py"
MODE = "mux-replacement-evidence"
BEFORE = "superseded-before-expiry"
AFTER = "cleanup-after-expiry"
STATUS = {BEFORE: "P2_SCOPED_MUX_SUPERSEDED_BEFORE_EXPIRY", AFTER: "P2_SCOPED_MUX_CLEANED_AFTER_EXPIRY"}
MARKER = "p2-mux-evidence-guard-verified.json"
_UPLOAD = "P2_INTERACTIVE_MEDIA_JOINED"
_READY = "P2_SCOPED_MUX_READY_OBSERVED"
_PLAYBACK = "P2_INTERACTIVE_LESSON_RESUME_JOINED"
_ACTION = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
_INSTANT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,6}Z")
_LINKS = ("playback", "predecessorReady", "replacementUpload")
_OLD_FIELDS = ("attemptId", "generation", "environmentId", "uploadId", "assetId", "playbackIdSha256")
_TIMES = ("observedAt", "supersededAt", "lastTokenExpiresAt", "deletedAt")

# The successor uses the existing strict current-ready selection. The old row
# can be retained as a tombstone. Timestamp text is fixed UTC and neither raw
# playback ID nor any token is selected.
_PAIR_QUERY = profiled_course_query("WITH successor AS (" + READY_SELECT + ''')
 SELECT to_jsonb(s) AS successor, a.id::text AS "attemptId", a.generation,
        a.provider_environment_id AS "environmentId", a.mux_upload_id AS "uploadId", a.mux_asset_id AS "assetId",
        encode(sha256(convert_to(a.mux_playback_id,'UTF8')),'hex') AS "playbackIdSha256",
        to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt",
        to_char(a.superseded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "supersededAt",
        to_char(a.last_token_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastTokenExpiresAt",
        to_char(a.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "deletedAt",
        a.recovery_lease_owner IS NOT NULL OR a.recovery_lease_until IS NOT NULL AS "leasePresent",
        a.last_error_code AS "lastErrorCode", a.is_current AS "isCurrent", a.managed_by_course AS "managedByCourse"
   FROM successor s JOIN public.video_assets a ON a.lesson_id = s."lessonId"::uuid
  WHERE a.id = $8::uuid AND a.generation < s.generation AND a.is_current IS FALSE AND a.managed_by_course IS TRUE
    AND a.provider_environment_id = s."environmentId" AND a.superseded_at IS NOT NULL
    AND a.last_token_expires_at IS NOT NULL''')


def _valid_ref(value):
    return (type(value) is dict and set(value) == {"actionId", "hostTerminalSha256"} and
            type(value["actionId"]) is str and _ACTION.fullmatch(value["actionId"]) and
            _digest(value["hostTerminalSha256"]))


def validate_selection(value):
    _require(type(value) is dict and set(value) == {"stage", "predecessor", "successor", "beforeExpiry", *_LINKS} and
             type(value["stage"]) is str and value["stage"] in STATUS and all(_valid_ref(value[key]) for key in _LINKS) and
             (value["beforeExpiry"] is None if value["stage"] == BEFORE else _valid_ref(value["beforeExpiry"])),
             "P2_MUX_REPLACEMENT_SELECTION_REQUIRED")
    old, new = (validate_ready(value[key]) for key in ("predecessor", "successor"))
    refs = [value[key]["actionId"] for key in (*_LINKS, "beforeExpiry") if value[key] is not None]
    _require(len(set(refs)) == len(refs) and
             all(old[key] == new[key] for key in ("courseId", "lessonId", "environmentId")) and
             all(old[key] != new[key] for key in ("attemptId", "uploadId", "assetId", "playbackIdSha256")) and
             old["generation"] < new["generation"], "P2_MUX_REPLACEMENT_PAIR_REQUIRED")
    return value


def _instant(value):
    _require(type(value) is str and _INSTANT.fullmatch(value), "P2_MUX_REPLACEMENT_TIMESTAMP_REQUIRED")
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def _guard_receipt(plan, terminal, committed):
    from p2_certification_parent import _profiled_resume_binding

    return {"version": 2, "qualificationTargetProfile": _PROFILE, "status": "P2_MUX_EVIDENCE_GUARD_VERIFIED",
            "certificationActionId": plan["certificationActionId"], "caseStatus": terminal["caseStatus"],
            "hostTerminalSha256": committed, "releaseBinding": _profiled_resume_binding(plan)}


def retain_guard(initial, terminal, committed):
    """Called only after independent terminal validation and child reaping."""
    from p2_release_supervisor import _profiled_certification_directory

    migrate.write_json(_profiled_certification_directory(initial), MARKER,
                       _guard_receipt(initial["certificationPlan"], terminal, committed))


def _prior(plan, results, ref, expected_status):
    from p2_certification_parent import _RESUME_GUARD_RECEIPT, _profiled_host_receipt, _profiled_resume_binding
    from p2_release_supervisor import PROFILED_CERTIFICATION_LAYOUT as layout

    action_id = ref["actionId"]
    _require(action_id not in (plan["certificationActionId"], plan["originalReleaseId"]),
             "P2_MUX_REPLACEMENT_PRIOR_ACTION_REQUIRED")
    directory = results / (layout["receiptPrefix"] + action_id)
    terminal, digest = _profiled_host_receipt(directory, layout["terminalName"], _PROFILE)
    joined, _ = _profiled_host_receipt(directory, "p2-scoped-case-joined.json", _PROFILE)
    playback = expected_status == _PLAYBACK
    marker, _ = _profiled_host_receipt(directory, _RESUME_GUARD_RECEIPT if playback else MARKER, _PROFILE)
    release_binding = _profiled_resume_binding(plan)
    _require(digest == ref["hostTerminalSha256"] == marker.get("hostTerminalSha256") and
             terminal.get("status") == layout["terminalStatus"] and
             all(item.get("certificationActionId") == action_id for item in (terminal, joined, marker)) and
             terminal.get("caseStatus") == joined.get("status") == expected_status and
             terminal.get("caseOutcomeSha256") == _hash(_canonical(joined)) and
             terminal.get("planSha256") == joined.get("planSha256") and
             marker.get("releaseBinding") == release_binding and
             (marker.get("status") == "P2_INTERACTIVE_LESSON_RESUME_GUARD_VERIFIED" and
              marker.get("planSha256") == terminal["planSha256"] if playback else
              marker.get("status") == "P2_MUX_EVIDENCE_GUARD_VERIFIED" and marker.get("caseStatus") == expected_status),
             "P2_MUX_REPLACEMENT_PRIOR_GUARD_REQUIRED")
    return joined


def prior_evidence(plan, results):
    selected = validate_selection(plan["scopedAction"])
    old, new = selected["predecessor"], selected["successor"]
    playback = _prior(plan, results, selected["playback"], _PLAYBACK)
    predecessor = _prior(plan, results, selected["predecessorReady"], _READY)
    upload = _prior(plan, results, selected["replacementUpload"], _UPLOAD)
    _require(all(playback.get(key) == old[key] for key in ("courseId", "lessonId", "playbackIdSha256")) and
             predecessor.get("scopedAction") == old and upload.get("operation") == "upload-video-and-observe-callback" and
             upload.get("currentVideoAssetId") == old["attemptId"] and upload.get("uploadSent") is True and
             all(upload.get(key) == new[key] for key in ("attemptId", "generation", "environmentId", "uploadId", "courseId", "lessonId")) and
             type(upload.get("upload")) is dict and upload["upload"].get("assetId") == new["assetId"] and
             _digest(upload["upload"].get("callbackReceiptSha256")), "P2_MUX_REPLACEMENT_LINEAGE_REQUIRED")
    expires = _instant(playback.get("playbackExpiresAt"))
    _require(predecessor.get("databaseIdentitySha256") and _digest(predecessor["databaseIdentitySha256"]),
             "P2_MUX_REPLACEMENT_PRIOR_DATABASE_REQUIRED")
    if selected["stage"] == BEFORE:
        return expires, predecessor["databaseIdentitySha256"], None
    before = _prior(plan, results, selected["beforeExpiry"], STATUS[BEFORE])
    _require(before.get("scopedAction") == {**selected, "stage": BEFORE, "beforeExpiry": None} and
             before.get("databaseIdentitySha256") == predecessor["databaseIdentitySha256"],
             "P2_MUX_REPLACEMENT_BEFORE_BINDING_REQUIRED")
    validate_observation(before["scopedAction"], before["observation"], expires, None)
    return expires, predecessor["databaseIdentitySha256"], before["observation"]


def validate_observation(selected, row, expires, before):
    _require(type(row) is dict and set(row) == {"successor", "leasePresent", "lastErrorCode", "isCurrent", "managedByCourse",
                                                  *_OLD_FIELDS, *_TIMES} and
             all(row[key] == selected["predecessor"][key] for key in _OLD_FIELDS) and type(row["generation"]) is int and
             row["isCurrent"] is False and row["managedByCourse"] is True and type(row["leasePresent"]) is bool, "P2_MUX_REPLACEMENT_OLD_ROW_REQUIRED")
    require_ready_row(selected["successor"], row["successor"])
    observed, superseded, stored_expiry = (_instant(row[key]) for key in _TIMES[:3])
    _require(stored_expiry == expires and superseded <= observed,
             "P2_MUX_REPLACEMENT_AUTHORIZATION_EXPIRY_REQUIRED")
    if selected["stage"] == BEFORE:
        _require(before is None and observed < stored_expiry and row["deletedAt"] is None,
                 "P2_MUX_REPLACEMENT_PRE_EXPIRY_RETENTION_REQUIRED")
        # Never retain an unexpected provider error string.
        _require(row["lastErrorCode"] is None, "P2_MUX_REPLACEMENT_PRE_EXPIRY_RECONCILIATION_REQUIRED")
    else:
        _require(type(before) is dict and row["supersededAt"] == before["supersededAt"] and
                 row["lastTokenExpiresAt"] == before["lastTokenExpiresAt"] and
                 superseded <= _instant(before["observedAt"]) < stored_expiry <= _instant(row["deletedAt"]) <= observed and
                 row["leasePresent"] is False and row["lastErrorCode"] is None,
                 "P2_MUX_REPLACEMENT_POST_EXPIRY_CLEANUP_REQUIRED")


def require_receipt(plan, receipt, prior, gateway_admission=None):
    selected = validate_selection(plan["scopedAction"])
    require_held_receipt(plan, receipt, STATUS[selected["stage"]], {"observation"}, gateway_admission)
    expires, database, before = prior
    _require(receipt["databaseIdentitySha256"] == database, "P2_MUX_REPLACEMENT_DATABASE_CHANGED")
    validate_observation(selected, receipt["observation"], expires, before)


class P2ScopedMuxReplacementStage(P2HeldMuxReadStage):
    def __init__(self, broker):
        super().__init__(broker, mode=MODE, source_key=_SOURCE_KEY, source=_SOURCE)
        self.action = validate_selection(self.plan["scopedAction"])

    def observe(self):
        fence = self._begin()
        prior = prior_evidence(self.plan, self.broker.results)
        old, new = self.action["predecessor"], self.action["successor"]
        worker = self._environment("course-media")
        _require(worker.get("MUX_ENVIRONMENT_ID") == new["environmentId"] and
                 all(worker.get(key) == "true" for key in ("MUX_MEDIA_RECOVERY_ENABLED", "MUX_MEDIA_CLEANUP_ENABLED")),
                 "P2_MUX_REPLACEMENT_CLEANUP_WORKER_REQUIRED")
        row, identity = self._query(_PAIR_QUERY, [*readiness_parameters(new), old["attemptId"]], new["environmentId"])
        validate_observation(self.action, row, prior[0], prior[2])
        receipt = self._finish(fence, STATUS[self.action["stage"]], {**identity, "observation": row})
        require_receipt(self.plan, receipt, prior)
        return receipt
