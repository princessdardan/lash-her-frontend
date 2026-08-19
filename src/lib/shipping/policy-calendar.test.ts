import assert from "node:assert/strict";
import test from "node:test";
import { addCoverageHours, computeShippingDeadlines } from "./policy-calendar";

const settings = {
  timezone: "America/Toronto",
  orderCutoff: "14:00:00",
  coverageStartsAt: "09:00:00",
  coverageEndsAt: "17:00:00",
  beforeCutoffHandoffBusinessDays: 1,
  afterCutoffHandoffBusinessDays: 2,
  autoRefundBusinessDays: 2,
};

test("computes pre-cutoff, weekend, holiday, and automatic-refund deadlines", () => {
  const closedDates = new Set(["2026-08-17"]);
  const beforeCutoff = computeShippingDeadlines({
    clearedAt: new Date("2026-08-14T17:00:00.000Z"),
    settings,
    closedDates,
  });
  assert.equal(
    beforeCutoff.handoffDeadlineAt.toISOString(),
    "2026-08-18T21:00:00.000Z",
  );
  assert.equal(
    beforeCutoff.autoRefundDeadlineAt.toISOString(),
    "2026-08-20T21:00:00.000Z",
  );

  const weekend = computeShippingDeadlines({
    clearedAt: new Date("2026-08-15T16:00:00.000Z"),
    settings,
    closedDates: new Set(),
  });
  assert.equal(
    weekend.handoffDeadlineAt.toISOString(),
    "2026-08-18T21:00:00.000Z",
  );
});

test("uses the Toronto offset after a DST boundary", () => {
  const result = computeShippingDeadlines({
    clearedAt: new Date("2026-10-30T17:00:00.000Z"),
    settings,
    closedDates: new Set(),
  });
  assert.equal(
    result.handoffDeadlineAt.toISOString(),
    "2026-11-02T22:00:00.000Z",
  );
});

test("coverage-hour escalation pauses overnight and on weekends", () => {
  const result = addCoverageHours({
    from: new Date("2026-08-14T20:00:00.000Z"),
    coverageHours: 4,
    settings,
    closedDates: new Set(),
  });
  assert.equal(result.toISOString(), "2026-08-17T16:00:00.000Z");
});
