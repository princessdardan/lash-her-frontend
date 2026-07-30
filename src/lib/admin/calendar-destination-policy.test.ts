import assert from "node:assert/strict";
import test from "node:test";

import {
  getBookingDestinationChangeError,
  getBookingDestinationDisableError,
  getCalendarConnectionDisableError,
  type BookingDestinationSnapshot,
} from "./calendar-destination-policy";

const currentDestination: BookingDestinationSnapshot = {
  assignmentId: "assignment-current",
  connectionId: "connection-current",
  providerCalendarId: "calendar-current",
};

test("a resource can receive its first booking destination", () => {
  assert.equal(
    getBookingDestinationChangeError({
      acceptsBookings: true,
      confirmedReplacementAssignmentId: null,
      currentDestination: null,
      requestedConnectionId: "connection-new",
      requestedProviderCalendarId: "calendar-new",
    }),
    null,
  );
});

test("saving the current destination is idempotent but demoting it is blocked", () => {
  assert.equal(
    getBookingDestinationChangeError({
      acceptsBookings: true,
      confirmedReplacementAssignmentId: null,
      currentDestination,
      requestedConnectionId: currentDestination.connectionId,
      requestedProviderCalendarId: currentDestination.providerCalendarId,
    }),
    null,
  );
  assert.match(
    getBookingDestinationChangeError({
      acceptsBookings: false,
      confirmedReplacementAssignmentId: null,
      currentDestination,
      requestedConnectionId: currentDestination.connectionId,
      requestedProviderCalendarId: currentDestination.providerCalendarId,
    }) ?? "",
    /Move the booking destination/,
  );
});

test("a different destination requires confirmation of the exact current row", () => {
  const input = {
    acceptsBookings: true,
    currentDestination,
    requestedConnectionId: "connection-new",
    requestedProviderCalendarId: "calendar-new",
  };

  assert.match(
    getBookingDestinationChangeError({
      ...input,
      confirmedReplacementAssignmentId: null,
    }) ?? "",
    /Confirm the existing booking destination replacement/,
  );
  assert.equal(
    getBookingDestinationChangeError({
      ...input,
      confirmedReplacementAssignmentId: currentDestination.assignmentId,
    }),
    null,
  );
  assert.match(
    getBookingDestinationChangeError({
      ...input,
      confirmedReplacementAssignmentId: "assignment-stale",
    }) ?? "",
    /changed/,
  );
});

test("a duplicate confirmed submission is stale after the destination moves", () => {
  assert.match(
    getBookingDestinationChangeError({
      acceptsBookings: true,
      confirmedReplacementAssignmentId: "assignment-previous",
      currentDestination: {
        assignmentId: "assignment-new",
        connectionId: "connection-new",
        providerCalendarId: "calendar-new",
      },
      requestedConnectionId: "connection-new",
      requestedProviderCalendarId: "calendar-new",
    }) ?? "",
    /changed/,
  );
});

test("active booking destinations cannot be disabled", () => {
  assert.match(
    getBookingDestinationDisableError({
      acceptsBookings: true,
      status: "active",
    }) ?? "",
    /Move the booking destination/,
  );
  assert.equal(
    getBookingDestinationDisableError({
      acceptsBookings: false,
      status: "active",
    }),
    null,
  );
  assert.equal(
    getBookingDestinationDisableError({
      acceptsBookings: true,
      status: "disabled",
    }),
    null,
  );
});

test("connections report every resource whose destination must move", () => {
  assert.equal(getCalendarConnectionDisableError([]), null);
  assert.equal(
    getCalendarConnectionDisableError(["Room A", "Dardan", "Room A"]),
    "Move the booking destination for Room A and Dardan before disabling this Google account",
  );
});
