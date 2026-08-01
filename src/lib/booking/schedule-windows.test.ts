import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAvailabilityWindowsFromHours,
  buildResourceAvailabilityWindows,
  type BuildResourceAvailabilityWindowsInput,
} from "./schedule-windows";
import type { CalendarEventWindow } from "./types";

function ranges(windows: CalendarEventWindow[]): Array<[string, string]> {
  return windows.map((window) => [
    window.start.toISOString(),
    window.end.toISOString(),
  ]);
}

function build(
  input: Partial<BuildResourceAvailabilityWindowsInput> &
    Pick<BuildResourceAvailabilityWindowsInput, "horizonEnd" | "now">,
): CalendarEventWindow[] {
  return buildResourceAvailabilityWindows({
    exceptions: [],
    recurringWindows: [],
    timezone: "UTC",
    ...input,
  });
}

test("buildResourceAvailabilityWindows supports recurring split shifts", () => {
  const windows = build({
    now: new Date("2026-07-06T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-07T00:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 1, startsAt: "09:00", endsAt: "12:00" },
      { isoWeekday: 1, startsAt: "13:00", endsAt: "17:00" },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-06T09:00:00.000Z", "2026-07-06T12:00:00.000Z"],
    ["2026-07-06T13:00:00.000Z", "2026-07-06T17:00:00.000Z"],
  ]);
});

test("unavailable exceptions subtract closures and take precedence", () => {
  const windows = build({
    now: new Date("2026-07-06T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-07T00:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 1, startsAt: "09:00", endsAt: "17:00" },
    ],
    exceptions: [
      {
        kind: "available",
        start: new Date("2026-07-06T11:00:00.000Z"),
        end: new Date("2026-07-06T14:00:00.000Z"),
      },
      {
        kind: "unavailable",
        start: new Date("2026-07-06T12:00:00.000Z"),
        end: new Date("2026-07-06T13:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-06T09:00:00.000Z", "2026-07-06T12:00:00.000Z"],
    ["2026-07-06T13:00:00.000Z", "2026-07-06T17:00:00.000Z"],
  ]);
});

test("available exceptions can open time outside the recurring schedule", () => {
  const windows = build({
    now: new Date("2026-07-07T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-08T00:00:00.000Z"),
    exceptions: [
      {
        kind: "available",
        start: new Date("2026-07-07T15:00:00.000Z"),
        end: new Date("2026-07-07T18:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-07T15:00:00.000Z", "2026-07-07T18:00:00.000Z"],
  ]);
});

test("effective dates are inclusive and limit recurring windows", () => {
  const windows = build({
    now: new Date("2026-07-06T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-28T00:00:00.000Z"),
    recurringWindows: [
      {
        isoWeekday: 1,
        startsAt: "09:00",
        endsAt: "10:00",
        effectiveFrom: "2026-07-13",
        effectiveUntil: "2026-07-20",
      },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-13T09:00:00.000Z", "2026-07-13T10:00:00.000Z"],
    ["2026-07-20T09:00:00.000Z", "2026-07-20T10:00:00.000Z"],
  ]);
});

test("merge, subtraction, and ordering are deterministic", () => {
  const recurringWindows = [
    { isoWeekday: 1 as const, startsAt: "10:00", endsAt: "17:00" },
    { isoWeekday: 1 as const, startsAt: "09:00", endsAt: "12:00" },
  ];
  const exceptions = [
    {
      kind: "unavailable" as const,
      start: new Date("2026-07-06T12:00:00.000Z"),
      end: new Date("2026-07-06T13:00:00.000Z"),
    },
    {
      kind: "available" as const,
      start: new Date("2026-07-06T08:00:00.000Z"),
      end: new Date("2026-07-06T10:00:00.000Z"),
    },
  ];
  const input = {
    now: new Date("2026-07-06T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-07T00:00:00.000Z"),
  };

  const forward = build({ ...input, recurringWindows, exceptions });
  const reversed = build({
    ...input,
    recurringWindows: [...recurringWindows].reverse(),
    exceptions: [...exceptions].reverse(),
  });

  assert.deepEqual(ranges(forward), [
    ["2026-07-06T08:00:00.000Z", "2026-07-06T12:00:00.000Z"],
    ["2026-07-06T13:00:00.000Z", "2026-07-06T17:00:00.000Z"],
  ]);
  assert.deepEqual(ranges(reversed), ranges(forward));
  assert.deepEqual(
    reversed.map((window) => window.id),
    forward.map((window) => window.id),
  );
});

test("all availability is clipped to now and the horizon", () => {
  const windows = build({
    now: new Date("2026-07-06T10:00:00.000Z"),
    horizonEnd: new Date("2026-07-06T12:00:00.000Z"),
    exceptions: [
      {
        kind: "available",
        start: new Date("2026-07-06T08:00:00.000Z"),
        end: new Date("2026-07-06T15:00:00.000Z"),
      },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-06T10:00:00.000Z", "2026-07-06T12:00:00.000Z"],
  ]);
});

test("Toronto spring DST nonexistent local boundaries fail closed", () => {
  const windows = build({
    timezone: "America/Toronto",
    now: new Date("2026-03-08T05:00:00.000Z"),
    horizonEnd: new Date("2026-03-09T04:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 7, startsAt: "02:30", endsAt: "03:30" },
    ],
  });

  assert.deepEqual(windows, []);
});

test("Toronto fall DST repeated opening uses the later instant", () => {
  const windows = build({
    timezone: "America/Toronto",
    now: new Date("2026-11-01T04:00:00.000Z"),
    horizonEnd: new Date("2026-11-02T05:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 7, startsAt: "01:00", endsAt: "03:00" },
    ],
  });

  assert.deepEqual(ranges(windows), [
    ["2026-11-01T06:00:00.000Z", "2026-11-01T08:00:00.000Z"],
  ]);
});

test("Toronto fall DST interval wholly inside the repeated hour fails closed", () => {
  const windows = build({
    timezone: "America/Toronto",
    now: new Date("2026-11-01T04:00:00.000Z"),
    horizonEnd: new Date("2026-11-02T05:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 7, startsAt: "01:00", endsAt: "01:30" },
    ],
  });

  assert.deepEqual(windows, []);
});

test("invalid local times and timezones fail closed", () => {
  const input = {
    now: new Date("2026-07-06T00:00:00.000Z"),
    horizonEnd: new Date("2026-07-07T00:00:00.000Z"),
    recurringWindows: [
      { isoWeekday: 1 as const, startsAt: "25:00", endsAt: "26:00" },
    ],
  };

  assert.deepEqual(build(input), []);
  assert.deepEqual(build({ ...input, timezone: "Invalid/Timezone" }), []);
});

test("buildAvailabilityWindowsFromHours preserves V1 global-hours behavior", () => {
  const windows = buildAvailabilityWindowsFromHours({
    now: new Date("2026-07-06T13:00:00.000Z"),
    horizonEnd: new Date("2026-07-07T04:00:00.000Z"),
    settings: {
      timezone: "America/Toronto",
      hoursOfOperation: [
        {
          day: "monday",
          isOpen: true,
          opensAt: "10:00",
          closesAt: "18:00",
        },
        {
          day: "tuesday",
          isOpen: false,
          opensAt: "10:00",
          closesAt: "18:00",
        },
      ],
    },
  });

  assert.deepEqual(ranges(windows), [
    ["2026-07-06T14:00:00.000Z", "2026-07-06T22:00:00.000Z"],
  ]);
  assert.deepEqual(windows.map((window) => window.id), ["monday-2026-7-6"]);
});
