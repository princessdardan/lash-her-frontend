import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const bookingServiceSource = readFileSync(new URL("./booking-service.ts", import.meta.url), "utf8");

test("createBooking resolves offering-specific config when an offering slug is present", () => {
  assert.match(bookingServiceSource, /loaders\.getBookingOfferingBySlug\(offeringSlug\)/);
  assert.match(bookingServiceSource, /bookingType: offering\.bookingType/);
  assert.match(bookingServiceSource, /offeringSlug: offering\.slug/);
  assert.match(bookingServiceSource, /toOfferingBookingTypeConfig\(settings, offering\)/);
  assert.match(bookingServiceSource, /minimumLeadTimeHours = offering\?\.minimumLeadTimeHoursOverride \?\? settings\.minimumLeadTimeHours/);
});

test("createBooking blocks effective in-person appointment scheduling before calendar insertion", () => {
  assert.match(bookingServiceSource, /if \(validationInput\.bookingType === "in-person-appointment"\) \{/);
  assert.match(bookingServiceSource, /In-person appointments require secure payment before confirmation\./);
  assert.ok(
    bookingServiceSource.indexOf("validationInput.bookingType === \"in-person-appointment\"") <
      bookingServiceSource.indexOf("insertGoogleCalendarBooking"),
  );
});

test("createBooking rechecks offering availability against active holds", () => {
  assert.match(bookingServiceSource, /listActiveAppointmentHolds\(\{/);
  assert.match(bookingServiceSource, /offeringId: offering\._id/);
  assert.match(bookingServiceSource, /getActiveHoldBusyEvents\(\{ holds, now \}\)/);
  assert.match(bookingServiceSource, /busyEvents: \[\.\.\.busyEvents, \.\.\.activeHoldBusyEvents\]/);
});

test("createBooking still refreshes paid training context before scheduling", () => {
  assert.match(bookingServiceSource, /if \(validation\.data\.paidSchedulingToken !== undefined\)/);
  assert.match(bookingServiceSource, /markTrainingEnrollmentScheduled\(\{/);
  assert.match(bookingServiceSource, /schedulingToken: paidTrainingContext\.schedulingToken/);
});

test("createBooking keeps unexpected failures generic", () => {
  const catchBlockStart = bookingServiceSource.indexOf("console.error(\"[createBooking] Booking failed:\"");
  const genericErrorIndex = bookingServiceSource.indexOf(
    "Something went wrong while creating your booking. Please try again.",
    catchBlockStart,
  );

  assert.notEqual(catchBlockStart, -1);
  assert.notEqual(genericErrorIndex, -1);
});
