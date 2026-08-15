import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarCoverageComplete,
  expectedOntarioClosureDates,
} from "./calendar-validation";

test("calendar coverage requires exact Ontario holiday kinds for all 21 months", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  const coverageStartsOn = "2026-08-15";
  const coverageEndsOn = "2028-05-15";
  const closureDates = [2026, 2027, 2028]
    .flatMap((year) => [...expectedOntarioClosureDates(year)])
    .filter((date) => date >= coverageStartsOn && date <= coverageEndsOn)
    .map((date) => ({
      date,
      kind: "ontario_holiday",
      label: `Ontario statutory/observed closure ${date}`,
    }));
  closureDates.push({
    date: "2027-08-06",
    kind: "branch_closure",
    label: "Reviewed branch closure",
  });

  assert.equal(
    calendarCoverageComplete(
      { coverageStartsOn, coverageEndsOn, closureDates },
      now,
    ),
    true,
  );

  const firstHoliday = closureDates.find(
    (entry) => entry.kind === "ontario_holiday",
  )!;
  const wrongKind = closureDates.map((entry) =>
    entry === firstHoliday ? { ...entry, kind: "branch_closure" } : entry,
  );
  assert.equal(
    calendarCoverageComplete(
      { coverageStartsOn, coverageEndsOn, closureDates: wrongKind },
      now,
    ),
    false,
  );
});

test("Christmas and Boxing Day observations do not invent extra closure days", () => {
  assert.deepEqual(
    [...expectedOntarioClosureDates(2021)].filter((date) =>
      date.startsWith("2021-12-"),
    ),
    ["2021-12-25", "2021-12-26", "2021-12-27", "2021-12-28"],
  );
  assert.deepEqual(
    [...expectedOntarioClosureDates(2022)].filter((date) =>
      date.startsWith("2022-12-"),
    ),
    ["2022-12-25", "2022-12-26", "2022-12-27"],
  );
});
