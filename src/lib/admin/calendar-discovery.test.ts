import assert from "node:assert/strict";
import test from "node:test";

import {
  canGoogleCalendarAcceptBookings,
  canGoogleCalendarContributeBusy,
  getCalendarAssignmentAccessError,
} from "./calendar-capabilities";

test("only writer and owner calendars can receive bookings", () => {
  assert.equal(canGoogleCalendarAcceptBookings("owner"), true);
  assert.equal(canGoogleCalendarAcceptBookings("writer"), true);
  assert.equal(canGoogleCalendarAcceptBookings("reader"), false);
  assert.equal(canGoogleCalendarAcceptBookings("freeBusyReader"), false);
});

test("reader and free-busy calendars can contribute conflicts", () => {
  assert.equal(canGoogleCalendarContributeBusy("freeBusyReader"), true);
  assert.equal(canGoogleCalendarContributeBusy("reader"), true);
  assert.equal(canGoogleCalendarContributeBusy("writer"), true);
  assert.equal(canGoogleCalendarContributeBusy("owner"), true);
  assert.equal(canGoogleCalendarContributeBusy("none"), false);
});

test("every assignment must be discoverable and booking calendars must be writable", () => {
  assert.match(getCalendarAssignmentAccessError({
    acceptsBookings: false,
    accessRole: null,
  }) ?? "", /not available/);
  assert.equal(getCalendarAssignmentAccessError({
    acceptsBookings: false,
    accessRole: "freeBusyReader",
  }), null);
  assert.match(getCalendarAssignmentAccessError({
    acceptsBookings: true,
    accessRole: "reader",
  }) ?? "", /writer or owner/);
  assert.equal(getCalendarAssignmentAccessError({
    acceptsBookings: true,
    accessRole: "writer",
  }), null);
});
