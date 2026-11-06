"""Owned component tests: no provider, database, sender, mount or ARM proof."""
import copy
import datetime as dt
import json
import os
import pickle
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from ops.platform.host import p2q_mux_capture as mux


ATTEMPT = "11111111-1111-4111-8111-111111111111"
LESSON = "22222222-2222-4222-8222-222222222222"
OTHER = "33333333-3333-4333-8333-333333333333"
REQUEST = "44444444-4444-4444-8444-444444444444"
T = int(dt.datetime(2026, 11, 6, 12, tzinfo=dt.timezone.utc).timestamp())
BASE = "2026-11-06T12:00:00.000Z"
CAPTURE = "2026-11-06T12:00:01.000Z"
SEND = "2026-11-06T12:00:03.000Z"
OBSERVE = "2026-11-06T12:00:04.000Z"


def lease(case="D1"):
    value = {"version": 2, "kind": mux._KINDS["lease"], "actionId": "owned-action", "caseId": case,
             "qualificationTargetProfile": {"version": 1, "id": "unregistered-owned", "sha256": "a" * 64},
             "issuedAt": BASE, "expiresAt": "2026-11-06T12:02:00.000Z",
             "maxCaptures": 2 if case == "R1" else 1, "maxReplayPosts": 2 if case == "R1" else 1,
             "selection": {"environmentId": "env_owned", "lessonId": LESSON, "attemptId": ATTEMPT,
                           "generation": 1, "assetId": "asset_owned", "uploadId": "upload_owned"},
             "captureRootIdentity": {"device": "0", "inode": "1"},
             "actionDirectoryIdentity": {"device": "0", "inode": "2"}}
    for key in mux._KEYS["lease"]:
        if key.endswith("Sha256"):
            value[key] = "b" * 64
    return value


def capture(selected, slot=0):
    event = {"id": "event_" + str(slot), "type": mux._CASES[selected["caseId"]][0][slot],
             "createdAt": "2026-11-06T12:00:00.00000000" + str(slot + 1) + "Z", "objectId": "track_owned",
             **{key: selected["selection"][key] for key in ("environmentId", "assetId", "attemptId", "lessonId", "generation")}}
    return {"version": 2, "kind": mux._KINDS["safeCapture"], "leaseSha256": mux._hash(mux._encode("lease", selected)),
            "slot": slot, "event": event, "requestId": REQUEST if slot == 0 else "55555555-5555-4555-8555-555555555555", "headerTimestamp": T, "capturedAt": CAPTURE,
            "monotonicNanoseconds": str(100 + slot), "managedResponse": {"id": ATTEMPT, "lessonId": LESSON, "status": "ready"},
            "localResponseFinished": True}


def material(row):
    event = row["event"]
    body = {"id": event["id"], "type": event["type"], "created_at": event["createdAt"],
            "environment": {"id": event["environmentId"]}, "data": {"id": event["objectId"], "asset_id": event["assetId"],
            "passthrough": "lash-her-course:" + event["environmentId"] + ":" + event["attemptId"]},
            "unused": "private-body-canary-\u2603"}
    return mux._PrivateMaterial(("t=" + str(T) + ",v1=" + "a" * 64).encode(), b"application/json",
                                json.dumps(body, ensure_ascii=False, indent=2).encode())


def commit(row, private):
    raw = mux._envelope(private.signature, private.content_type, private.body)
    value = {**copy.deepcopy(row), "kind": mux._KINDS["privateCommit"], "rawEnvelopeSha256": mux._hash(raw), "rawEnvelopeBytes": len(raw)}
    return value, raw


def replay(row, started):
    return {"version": 2, "kind": mux._KINDS["replayObservation"], "leaseSha256": row["leaseSha256"],
            "sequence": started["sequence"], "captureSlot": row["slot"], "sendStartedSha256": mux._hash(mux._encode("safeSendStarted", started)),
            "requestId": OTHER if started["sequence"] == 0 else "66666666-6666-4666-8666-666666666666", "event": copy.deepcopy(row["event"]), "headerTimestamp": row["headerTimestamp"],
            "observedAt": OBSERVE, "monotonicNanoseconds": "200", "managedResponse": copy.deepcopy(row["managedResponse"]),
            "localResponseFinished": True}


def global_row(selected, ordinal=0, category="newWork"):
    return {"version": 2, "kind": mux._KINDS["globalRequest"], "leaseSha256": mux._hash(mux._encode("lease", selected)),
            "ordinal": ordinal, "requestId": f"{ordinal:08x}-4444-4444-8444-444444444444", "category": category,
            "service": "course", "method": "POST", "routeTemplate": "/v1/admin/lessons/{id}/captions",
            "startedAt": CAPTURE, "finishedAt": OBSERVE, "upstreamAttempted": True, "upstreamStatus": 200,
            "localResponseFinished": True}


def window(selected, rows=None):
    records = rows if rows is not None else []
    return {"version": 2, "kind": mux._KINDS["windowSummary"], "leaseSha256": mux._hash(mux._encode("lease", selected)),
            "startedAt": BASE, "closedAt": "2026-11-06T12:00:05.000Z", "admittedTotalsBefore": {"newWork": 2, "recovery": 3},
            "admittedTotalsAfter": {"newWork": 2 + sum(row["category"] == "newWork" for row in records),
                                    "recovery": 3 + sum(row["category"] == "recovery" for row in records)},
            "records": records, "observationFailures": 0}


def media(selected):
    s = selected["selection"]
    return {"id": s["attemptId"], "lessonId": s["lessonId"], "generation": s["generation"], "managedByCourse": True,
            "providerEnvironmentId": s["environmentId"], "uploadId": s["uploadId"], "assetId": s["assetId"], "status": "ready",
            "isCurrent": True, "deletedAt": None, "supersededAt": None, "lastTokenExpiresAt": None,
            "captionTracks": [{"id": "track_owned", "status": "ready"}]}


class UnavailableTests(unittest.TestCase):
    def test_public_constructor_and_all_operations_refuse_before_inspection_or_io(self):
        class Poison:
            def __getattribute__(self, _key):
                raise AssertionError("argument inspection")
        with mock.patch.object(mux.os, "open", side_effect=AssertionError("IO")):
            for args in ((), (None,), ({"qualificationTargetProfile": lease()["qualificationTargetProfile"], "authorized": True},), (Poison(),)):
                with self.assertRaises(mux.MuxCaptureUnavailable) as error:
                    mux.P2QMuxCaptureStage(*args, factory=lambda: True)
                self.assertEqual(error.exception.code, "P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE")
            instance = object.__new__(mux.P2QMuxCaptureStage)
            with mock.patch.object(mux, "PRODUCTION_ARM_AVAILABLE", True), mock.patch.object(mux, "SENDER_ACTIVATION_AVAILABLE", True):
                methods = [name for name in vars(mux.P2QMuxCaptureStage) if not name.startswith("__")]
                self.assertEqual(len(methods), 10)
                for name in methods:
                    with self.assertRaises(mux.MuxCaptureUnavailable):
                        getattr(instance, name)(Poison(), authorized=True, callback=lambda: True)

    def test_only_dormant_public_exports_no_issuer_network_or_query_interface(self):
        self.assertEqual(mux.__all__, ["P2QMuxCaptureStage", "MuxCaptureError", "MuxCaptureUnavailable"])
        self.assertEqual(mux._request_shape(), {"method": "POST", "path": "/course/v1/webhooks/mux", "signatureRenewed": False,
                                               "networkDispatchAvailable": False})


class CodecTests(unittest.TestCase):
    def test_canonical_metadata_exact_closed_bytes_and_raw_duplicates(self):
        golden = b'{"operation":"ARM","version":2}\n'
        self.assertEqual(mux._encode("wireFrame", {"version": 2, "operation": "ARM"}), golden)
        self.assertEqual(mux._decode("wireFrame", golden), {"version": 2, "operation": "ARM"})
        for raw in (golden[:-1], b' {"operation":"ARM","version":2}\n', b'{"version":2,"operation":"ARM"}\n',
                    b'{"operation":"ARM","version":2,"version":2}\n', b'{"operation":"ARM","versi\\u006fn":2,"version":2}\n',
                    b'{"operation":"ARM","version":2.0}\n', b'{"operation":"ARM","version":2e0}\n',
                    b'{"operation":"ARM","version":-0}\n', b'{"operation":"ARM","version":true}\n',
                    b'{"operation":"ARM","version":NaN}\n', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises(mux.MuxCaptureError):
                mux._decode("wireFrame", raw)
        for kind in (None, [], {}, 2, "missing"):
            with self.assertRaises(mux.MuxCaptureError):
                mux._validate(kind, {})
        with self.assertRaises(mux.MuxCaptureError):
            mux._encode("wireFrame", {"version": 2, "operation": "ARM", "authority": True})

    def test_joint_profile_ref_nonzero_syntax_is_not_registry_authority(self):
        value = lease()
        self.assertEqual(mux.JOINT_SCHEMA_SHA256, "c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a")
        self.assertEqual(mux._decode("lease", mux._encode("lease", value)), value)
        for change in ({"sha256": "0" * 64}, {"id": "9bad"}, {"version": True}, {"version": 1.0}, {"extra": 1}):
            bad = copy.deepcopy(value); bad["qualificationTargetProfile"].update(change)
            with self.assertRaises(mux.MuxCaptureError):
                mux._encode("lease", bad)
        value["candidateSha256"] = "0" * 64
        mux._encode("lease", value)  # Ordinary data hash grammar unchanged, no acceptance.

    def test_lease_fixed_cases_slots_bounds_and_no_extra_selector(self):
        for case in ("D1", "R1", "A1"):
            value = lease(case); mux._encode("lease", value)
            for key, replacement in (("maxCaptures", 0), ("maxReplayPosts", 3), ("expiresAt", BASE),
                                      ("expiresAt", "2026-11-06T12:02:00.001Z")):
                bad = copy.deepcopy(value); bad[key] = replacement
                with self.assertRaises(mux.MuxCaptureError):
                    mux._encode("lease", bad)
            for key in ("trackId", "eventTypes", "Bids", "slotOrder"):
                bad = copy.deepcopy(value); bad["selection"][key] = []
                with self.assertRaises(mux.MuxCaptureError):
                    mux._encode("lease", bad)

    def test_time_calendar_offsets_nanoseconds_and_equal_instant_refusal(self):
        self.assertLess(mux._instant("2026-11-06T12:00:00.000000001Z"), mux._instant("2026-11-06T12:00:00.000000002Z"))
        self.assertEqual(mux._instant("2026-11-06T12:00:00.000000001Z"), mux._instant("2026-11-06T13:00:00.000000001+01:00"))
        for value in ("0000-01-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-11-06T24:00:00Z", "2026-11-06T12:60:00Z",
                      "2026-11-06T12:00:60Z", "2026-11-06T12:00:00+24:00", "2026-11-06T12:00:00.1234567890Z"):
            with self.assertRaises(mux.MuxCaptureError):
                mux._instant(value)
        selected = lease("R1"); rows = [capture(selected, i) for i in range(2)]
        mux._ReplayBurnModel(selected, rows)
        for key, replacement in (("id", rows[0]["event"]["id"]), ("objectId", "foreign_track"),
                                  ("createdAt", "2026-11-06T13:00:00.000000001+01:00")):
            bad = copy.deepcopy(rows); bad[1]["event"][key] = replacement
            with self.assertRaises(mux.MuxCaptureError):
                mux._ReplayBurnModel(selected, bad)

    def test_binary_envelope_preserves_raw_bytes_and_caps(self):
        selected = lease(); row = capture(selected); private = material(row)
        raw = mux._envelope(private.signature, private.content_type, private.body)
        decoded = mux._decode_envelope(raw)
        self.assertEqual(decoded.body, private.body)
        self.assertNotIn("private-body-canary", repr(decoded))
        with self.assertRaises(mux.MuxCaptureError):
            pickle.dumps(decoded)
        decoded.clear(); self.assertEqual(bytes(decoded.body), b"")
        self.assertEqual(len(mux._envelope(b"s" * 1024, b"c" * 128, b"b" * 65536)), 66708)
        self.assertEqual(len(mux._envelope(b"s", b"c", b"b")), 23)
        for values in ((b"", b"c", b"b"), (b"s" * 1025, b"c", b"b"), (b"s", b"c" * 129, b"b"),
                       (b"s", b"c", b"b" * 65537), (b"s\n", b"c", b"b"), (b"s", b"\xff", b"b")):
            with self.assertRaises(mux.MuxCaptureError):
                mux._envelope(*values)
        for malformed in (raw[:-1], b"BADMAGIC" + raw[8:], raw + b"x"):
            with self.assertRaises(mux.MuxCaptureError):
                mux._decode_envelope(malformed)

    def test_private_raw_metadata_join_and_safe_projection_never_hash_private_record(self):
        selected = lease(); row = capture(selected); private = material(row)
        mux._join_raw_event(private, row["event"])
        record, raw = commit(row, private); safe = mux._safe_capture(record)
        self.assertEqual(safe, row)
        safe_bytes = mux._encode("safeCapture", safe)
        self.assertNotIn(record["rawEnvelopeSha256"].encode(), safe_bytes)
        self.assertNotIn(b"rawEnvelope", safe_bytes)
        self.assertNotEqual(mux._hash(safe_bytes), mux._hash(mux._encode("privateCommit", record)))
        for field in ("id", "type", "createdAt", "environmentId", "objectId", "assetId", "attemptId"):
            bad = copy.deepcopy(row["event"])
            bad[field] = "foreign" if field not in ("createdAt", "type", "attemptId") else (
                "2026-11-06T12:00:00Z" if field == "createdAt" else "video.asset.track.deleted" if field == "type" else OTHER)
            with self.assertRaises(mux.MuxCaptureError):
                mux._join_raw_event(private, bad)
        deleted = capture(lease("R1"), 1); p = material(deleted); body = json.loads(p.body); del body["data"]["passthrough"]
        p.body[:] = json.dumps(body).encode(); mux._join_raw_event(p, deleted["event"])
        p.body[:] = b'{"id":"a","id":"a"}'
        with self.assertRaises(mux.MuxCaptureError):
            mux._join_raw_event(p, deleted["event"])
        self.assertEqual(mux._decode_envelope(raw).body, private.body)


class ReplayTests(unittest.TestCase):
    def test_fixed_reverse_order_separate_slots_and_one_use(self):
        selected = lease("R1"); rows = [capture(selected, i) for i in range(2)]
        model = mux._ReplayBurnModel(selected, rows)
        for slot in (1, 0):
            started = model.reserve(SEND, 3000)
            self.assertEqual(started["captureSlot"], slot)
            with self.assertRaises(mux.MuxCaptureError):
                model.reserve(SEND, 3000)
            observation = replay(rows[slot], started)
            model.observe(observation["requestId"], observation)
        self.assertEqual(model.summary()["states"], ["OBSERVED", "OBSERVED"])
        self.assertFalse(model.summary()["liveSendAuthorized"])
        self.assertFalse(model.summary()["startedDurabilityQualified"])
        with self.assertRaises(mux.MuxCaptureError):
            model.reserve(SEND, 3000)

    def test_atomic_model_burn_only_one_thread_can_reserve(self):
        selected = lease(); model = mux._ReplayBurnModel(selected, [capture(selected)])
        results = []
        def reserve():
            try:
                model.reserve(SEND, 3000); results.append("reserved")
            except mux.MuxCaptureError:
                results.append("refused")
        threads = [threading.Thread(target=reserve) for _ in range(8)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(results.count("reserved"), 1)
        self.assertEqual(model.summary()["reservedSlots"], 1)

    def test_lost_or_colliding_response_and_temporal_drift_poison_without_reissue(self):
        selected = lease(); row = capture(selected)
        for mode in ("lost", "id", "collision", "event", "hash", "monotonic", "before", "expired"):
            model = mux._ReplayBurnModel(selected, [row]); started = model.reserve(SEND, 3000)
            observation = replay(row, started)
            if mode == "lost":
                model.lose()
            else:
                if mode == "id": observation["requestId"] = REQUEST
                if mode == "collision": observation["requestId"] = row["requestId"]
                if mode == "event": observation["event"]["id"] = "foreign"
                if mode == "hash": observation["sendStartedSha256"] = "0" * 64
                if mode == "monotonic": observation["monotonicNanoseconds"] = "99"
                if mode == "before": observation["observedAt"] = CAPTURE
                if mode == "expired": observation["observedAt"] = selected["expiresAt"]
                with self.assertRaises(mux.MuxCaptureError):
                    model.observe(observation["requestId"] if mode == "collision" else OTHER, observation)
            self.assertTrue(model.summary()["unknown"])
            self.assertEqual(model.summary()["states"], ["UNKNOWN"])
            with self.assertRaises(mux.MuxCaptureError):
                model.reserve(SEND, 3000)

    def test_both_budgets_fixed_no_header_renewal_or_callback_sender(self):
        selected = lease(); row = capture(selected)
        self.assertTrue(mux._assess_send_budget(selected, row, "2026-11-06T12:01:45.000Z", 105000)["budgetSufficient"])
        self.assertFalse(mux._assess_send_budget(selected, row, "2026-11-06T12:01:45.001Z", 105001)["budgetSufficient"])
        self.assertFalse(mux._assess_send_budget(selected, row, SEND, 105001)["budgetSufficient"])
        for value in (True, float("nan"), float("inf"), -1):
            with self.assertRaises(mux.MuxCaptureError): mux._assess_send_budget(selected, row, SEND, value)
        for timestamp in (T + 2, T - 301):
            bad = copy.deepcopy(row); bad["headerTimestamp"] = timestamp
            with self.assertRaises(mux.MuxCaptureError): mux._assess_send_budget(selected, bad, SEND, 3000)
        # Original t+300 can be earlier than the lease deadline; no re-signing.
        row["headerTimestamp"] = T - 250
        p = material(row); p.signature[:] = ("t=" + str(T - 250) + ",v1=" + "a" * 64).encode()
        model = mux._ReplayBurnModel(selected, [row]); started = model.reserve(SEND, 3000)
        raw = mux._format_private_intent(selected, row, started, p)
        intent = mux._decode("privateIntent", raw)
        self.assertEqual(intent["expiresAt"], "2026-11-06T12:00:50.000Z")
        self.assertEqual(intent["originalHeaderTimestamp"], T - 250)
        self.assertIn(b"expectedEnvelopeSha256", raw)
        self.assertNotIn(b"expectedEnvelopeSha256", mux._encode("safeSendStarted", started))


class LedgerProjectionTests(unittest.TestCase):
    def test_coverage_consistency_never_drain_or_provider_queue_authority(self):
        selected = lease()
        for records in ([], [global_row(selected)], [global_row(selected), global_row(selected, 1, "recovery")]):
            out = mux._assess_window(selected, window(selected, records))
            self.assertTrue(out["coverageConsistent"])
            self.assertFalse(out["actualDrainQualified"]); self.assertFalse(out["providerQueueQualified"])
            self.assertFalse(out["authorityIssued"])
        for key in ("closedAt", "admittedTotalsBefore", "admittedTotalsAfter"):
            value = window(selected); value[key] = None
            self.assertFalse(mux._assess_window(selected, value)["coverageConsistent"])
        for mutate in (lambda value: value.update(observationFailures=1),
                       lambda value: value["admittedTotalsAfter"].update(newWork=99),
                       lambda value: value["records"][0].update(finishedAt=None, localResponseFinished=None),
                       lambda value: value["records"][0].update(localResponseFinished=False)):
            value = window(selected, [global_row(selected)]); mutate(value)
            self.assertFalse(mux._assess_window(selected, value)["coverageConsistent"])

    def test_direct_codec_refuses_cross_row_and_impossible_source_metadata(self):
        selected = lease(); row = capture(selected)
        row["managedResponse"]["id"] = OTHER
        with self.assertRaises(mux.MuxCaptureError): mux._encode("safeCapture", row)
        for mutate in (lambda value: value.update(upstreamAttempted=False),
                       lambda value: value.update(finishedAt=None)):
            value = global_row(selected); mutate(value)
            with self.assertRaises(mux.MuxCaptureError): mux._encode("globalRequest", value)
        for mutate in (lambda value: value["records"][0].update(leaseSha256="0" * 64),
                       lambda value: value["records"][0].update(startedAt="2026-11-06T11:59:59.000Z"),
                       lambda value: value["records"][0].update(startedAt="2026-11-06T12:00:06.000Z", finishedAt="2026-11-06T12:00:07.000Z")):
            value = window(selected, [global_row(selected)]); mutate(value)
            with self.assertRaises(mux.MuxCaptureError): mux._encode("windowSummary", value)

    def test_ledger_slot_count_per_record_and_aggregate_caps_are_conjunctive(self):
        selected = lease(); row = global_row(selected)
        self.assertLess(len(mux._encode("globalRequest", row)), 768)
        for key, replacement in (("ordinal", True), ("method", "GET"), ("routeTemplate", "/v1/path?token=private"), ("upstreamStatus", 600)):
            bad = copy.deepcopy(row); bad[key] = replacement
            with self.assertRaises(mux.MuxCaptureError): mux._encode("globalRequest", bad)
        repeated = window(selected, [row, copy.deepcopy(row)])
        with self.assertRaises(mux.MuxCaptureError): mux._encode("windowSummary", repeated)
        # All 64 individual rows fit their cap; the summary is still too large.
        rows = [global_row(selected, i) for i in range(64)]
        for item in rows: mux._encode("globalRequest", item)
        with self.assertRaises(mux.MuxCaptureError): mux._encode("windowSummary", window(selected, rows))
        with self.assertRaises(mux.MuxCaptureError): mux._encode("windowSummary", window(selected, rows + [row]))
        safe = capture(selected)
        self.assertGreater(mux._safe_stage_size([("safeCapture", safe)]), 0)
        with self.assertRaises(mux.MuxCaptureError): mux._safe_stage_size([("lease", selected)] * 256)
        private, _raw = commit(safe, material(safe))
        with self.assertRaises(mux.MuxCaptureError): mux._safe_stage_size([("privateCommit", private)])

    def test_exact_safe_stage_byte_limit_and_one_byte_overflow(self):
        selected = lease()
        unit = len(mux._encode("lease", selected))
        records = [("lease", copy.deepcopy(selected)) for _ in range(196606 // unit)]
        size = mux._safe_stage_size(records)
        while 196608 - size > 255 - len(selected["selection"]["assetId"]):
            records.append(("wireFrame", {"version": 2, "operation": "ARM"}))
            size = mux._safe_stage_size(records)
        records[0][1]["selection"]["assetId"] += "x" * (196608 - size)
        self.assertEqual(mux._safe_stage_size(records), 196608)
        records[0][1]["selection"]["assetId"] += "x"
        with self.assertRaises(mux.MuxCaptureError): mux._safe_stage_size(records)

    def test_d1_r1_projection_only_and_track_order_nonsemantic(self):
        selected = lease(); row = media(selected); row["captionTracks"].append({"id": "other", "status": "ready"})
        after = copy.deepcopy(row); after["captionTracks"].reverse()
        out = mux._reduce_media_projection(selected, [capture(selected)], [row], [after])
        self.assertTrue(out["projectionConsistent"])
        for key in ("actualReadOnlyDatabaseQualified", "providerReconciliationQualified", "ordinaryUiLineageQualified", "actualPlaybackAuthorizationQualified", "authorityIssued"):
            self.assertFalse(out[key])
        changed = copy.deepcopy(after); changed["captionTracks"][0]["status"] = "errored"
        self.assertFalse(mux._reduce_media_projection(selected, [capture(selected)], [row], [changed])["projectionConsistent"])
        selected = lease("R1"); captures = [capture(selected, i) for i in range(2)]; row = media(selected)
        row["captionTracks"] = []
        self.assertTrue(mux._reduce_media_projection(selected, captures, [row], [row])["projectionConsistent"])
        row["captionTracks"] = [{"id": "track_owned", "status": "ready"}]
        self.assertFalse(mux._reduce_media_projection(selected, captures, [row], [row])["projectionConsistent"])

    def test_a1_requires_retained_a_and_newer_managed_current_b_without_ui_or_playback_claim(self):
        selected = lease("A1"); old = media(selected); old.update(isCurrent=False, lastTokenExpiresAt="2026-11-06T12:10:00Z", supersededAt=BASE)
        new = copy.deepcopy(old); new.update(id=OTHER, generation=2, isCurrent=True, assetId="asset_B", lastTokenExpiresAt=None, supersededAt=None)
        rows = [old, new]; out = mux._reduce_media_projection(selected, [capture(selected)], rows, rows)
        self.assertTrue(out["projectionConsistent"]); self.assertFalse(out["ordinaryUiLineageQualified"])
        for field, replacement in (("managedByCourse", False), ("providerEnvironmentId", "foreign"), ("assetId", "asset_owned")):
            bad = copy.deepcopy(rows); bad[1][field] = replacement
            self.assertFalse(mux._reduce_media_projection(selected, [capture(selected)], bad, bad)["projectionConsistent"])
        for bad in ([], [old, {**new, "generation": 1}], [old, {**new, "rawPayload": "private"}]):
            with self.assertRaises(mux.MuxCaptureError): mux._reduce_media_projection(selected, [capture(selected)], bad, bad)


class SpoolObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="p2q-mux-host-owned-")
        self.base = Path(self.temp.name); self.root = self.base / "capture-root"; self.root.mkdir(mode=0o770); self.root.chmod(0o770)
        self.selected = lease(); self.action = self.root / self.selected["actionId"]; self.action.mkdir(mode=0o770); self.action.chmod(0o770)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.selected["captureRootIdentity"] = mux._file_identity(os.fstat(self.fd))
        self.selected["actionDirectoryIdentity"] = mux._file_identity(os.stat(self.action))
        self.row = capture(self.selected); self.private = material(self.row); self.record, self.raw = commit(self.row, self.private)
        for name, data in (("capture-0.private", self.raw), ("capture-0.committed.json", mux._encode("privateCommit", self.record))):
            path = self.action / name; path.write_bytes(data); path.chmod(0o600)
        # Owned macOS UID/GID projection only. Production constants are root/65532.
        self.patches = [mock.patch.object(mux, key, value) for key, value in (("_HOST_UID", os.getuid()), ("_GATEWAY_UID", os.getuid()), ("_GATEWAY_GID", os.getgid()))]
        for patch in self.patches: patch.start()

    def tearDown(self):
        for patch in reversed(self.patches): patch.stop()
        os.close(self.fd); self.temp.cleanup()

    def test_actual_owned_descriptor_reads_and_fsync_observation_are_not_historic_ack_or_mount_proof(self):
        out = mux._inspect_capture(self.fd, self.selected, 0)
        self.assertEqual(out["safeCapture"], self.row); self.assertEqual(out["material"].body, self.private.body)
        self.assertTrue(out["currentFsyncObserved"]); self.assertTrue(out["observationOnly"])
        for key in ("historicProducerFsyncQualified", "fixedRuntimeMountQualified", "authorityIssued"):
            self.assertFalse(out[key])
        out["material"].clear()

    def test_wrong_inode_permission_owner_slot_hash_and_raw_metadata_refuse(self):
        for change in ("inode", "mode", "uid", "slot", "hash", "body"):
            with self.subTest(change=change):
                selected = copy.deepcopy(self.selected)
                if change == "inode": selected["captureRootIdentity"]["inode"] = "1"
                if change == "mode": self.root.chmod(0o777)
                patch = mock.patch.object(mux, "_GATEWAY_UID", os.getuid() + 1) if change == "uid" else mock.patch.object(mux, "_GATEWAY_UID", os.getuid())
                record = copy.deepcopy(self.record); raw = self.raw
                if change == "hash": record["rawEnvelopeSha256"] = "0" * 64
                if change == "body":
                    p = material(self.row); p.body[:] = b"{}"; record, raw = commit(self.row, p)
                (self.action / "capture-0.private").write_bytes(raw)
                (self.action / "capture-0.committed.json").write_bytes(mux._encode("privateCommit", record))
                with patch, self.assertRaises(mux.MuxCaptureError):
                    mux._inspect_capture(self.fd, selected, 1 if change == "slot" else 0)
                self.root.chmod(0o770)
        with self.assertRaises(mux.MuxCaptureError): mux._read_fixed(self.fd, "foreign", 10)

    def test_symlink_fifo_and_oversize_are_refused_without_blocking(self):
        raw = self.action / "capture-0.private"
        for mode in ("symlink", "fifo", "oversize"):
            raw.unlink()
            if mode == "symlink": raw.symlink_to(self.action / "capture-0.committed.json")
            elif mode == "fifo": os.mkfifo(raw, mode=0o600)
            else: raw.write_bytes(b"x" * 66709); raw.chmod(0o600)
            with self.assertRaises(mux.MuxCaptureError): mux._inspect_capture(self.fd, self.selected, 0)

    def test_fsync_or_readback_loss_never_returns_material_or_success(self):
        with mock.patch.object(mux.os, "fsync", side_effect=OSError("fixture-only-private-canary")):
            with self.assertRaises(mux.MuxCaptureError) as error:
                mux._inspect_capture(self.fd, self.selected, 0)
            self.assertEqual(str(error.exception), "P2Q_MUX_SPOOL_OBSERVATION_UNKNOWN")
        original = mux._read_fixed; decode = mux._decode_envelope; reads = 0; held = []
        def decoded(raw):
            value = decode(raw); held.append(value); return value
        def drift(fd, name, maximum):
            nonlocal reads
            result = original(fd, name, maximum); reads += 1
            if reads == 3: return result + b" "
            return result
        with mock.patch.object(mux, "_read_fixed", side_effect=drift), mock.patch.object(mux, "_decode_envelope", side_effect=decoded), self.assertRaises(mux.MuxCaptureError):
            mux._inspect_capture(self.fd, self.selected, 0)
        self.assertEqual(len(held), 1)
        self.assertEqual(bytes(held[0].body), b"")


if __name__ == "__main__":
    unittest.main()
