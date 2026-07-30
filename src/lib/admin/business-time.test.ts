import assert from "node:assert/strict";
import test from "node:test";

import {
  addCalendarDays,
  getBusinessDateRange,
  getBusinessRollingDateRange,
  getBusinessTodayRange,
} from "./business-time";

test("today uses Toronto local midnight boundaries across DST", () => {
  const range = getBusinessTodayRange(
    new Date("2026-03-08T16:00:00.000Z"),
    "America/Toronto",
  );

  assert.equal(range.from, "2026-03-08");
  assert.equal(range.to, "2026-03-08");
  assert.equal(range.start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-03-09T04:00:00.000Z");
});

test("rolling periods have explicit inclusive dates and exclusive upper bounds", () => {
  const range = getBusinessRollingDateRange(
    new Date("2026-07-29T18:00:00.000Z"),
    "America/Toronto",
    30,
  );

  assert.equal(range.from, "2026-06-30");
  assert.equal(range.to, "2026-07-29");
  assert.equal(range.start.toISOString(), "2026-06-30T04:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-07-30T04:00:00.000Z");
});

test("calendar arithmetic validates impossible dates", () => {
  assert.equal(addCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.throws(
    () => getBusinessDateRange("2026-02-30", "2026-03-01", "UTC"),
    /valid calendar date/,
  );
});
