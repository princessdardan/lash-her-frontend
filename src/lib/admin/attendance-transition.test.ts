import assert from "node:assert/strict";
import test from "node:test";

import { getAttendanceTransitionError } from "./attendance-transition";

const now = new Date("2026-07-10T18:00:00.000Z");

test("attendance can be recorded for a confirmed appointment after it ends", () => {
  assert.equal(getAttendanceTransitionError({
    currentStatus: "confirmed",
    nextStatus: "completed",
    now,
    selectedEnd: new Date("2026-07-10T17:59:59.000Z"),
  }), null);
});

test("attendance cannot be recorded before the appointment ends", () => {
  assert.match(getAttendanceTransitionError({
    currentStatus: "confirmed",
    nextStatus: "no_show",
    now,
    selectedEnd: new Date("2026-07-10T18:00:01.000Z"),
  }) ?? "", /after the appointment end time/);
});

test("attendance cannot replace another terminal status", () => {
  assert.match(getAttendanceTransitionError({
    currentStatus: "cancelled",
    nextStatus: "completed",
    now,
    selectedEnd: new Date("2026-07-10T17:00:00.000Z"),
  }) ?? "", /Only confirmed appointments/);
});
