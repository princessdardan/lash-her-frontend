import assert from "node:assert/strict";
import test from "node:test";

import {
  parseBookingCalendarIds,
} from "./calendar-ids";

test("parseBookingCalendarIds returns single ID unchanged", () => {
  assert.deepEqual(parseBookingCalendarIds("primary"), ["primary"]);
});

test("parseBookingCalendarIds splits comma-separated IDs", () => {
  assert.deepEqual(
    parseBookingCalendarIds("primary, second@example.com, third-calendar"),
    ["primary", "second@example.com", "third-calendar"],
  );
});

test("parseBookingCalendarIds trims whitespace around IDs", () => {
  assert.deepEqual(
    parseBookingCalendarIds("  primary  ,  second@example.com  ,  third  "),
    ["primary", "second@example.com", "third"],
  );
});

test("parseBookingCalendarIds ignores empty entries", () => {
  assert.deepEqual(
    parseBookingCalendarIds("primary,,second@example.com, ,third"),
    ["primary", "second@example.com", "third"],
  );
});

test("parseBookingCalendarIds accepts settings object", () => {
  assert.deepEqual(
    parseBookingCalendarIds({ calendarId: "primary, second" } as import("./types").BookingSettings),
    ["primary", "second"],
  );
});

test("parseBookingCalendarIds returns empty array for empty string", () => {
  assert.deepEqual(parseBookingCalendarIds(""), []);
});

test("parseBookingCalendarIds returns empty array for whitespace-only string", () => {
  assert.deepEqual(parseBookingCalendarIds("   ,  ,  "), []);
});


