import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchBookingModel,
  isOperationalBooking,
  resolveBookingModelVersion,
  UnsupportedBookingModelVersionError,
} from "./booking-model-version";

test("missing and null versions remain on the legacy path", () => {
  assert.equal(resolveBookingModelVersion({}), 1);
  assert.equal(resolveBookingModelVersion({ bookingModelVersion: null }), 1);
  assert.equal(isOperationalBooking({ bookingModelVersion: 1 }), false);
});

test("version 2 uses the operational path", () => {
  assert.equal(isOperationalBooking({ bookingModelVersion: 2 }), true);
  assert.equal(
    dispatchBookingModel(
      { bookingModelVersion: 2 },
      { legacy: () => "legacy", operational: () => "operational" },
    ),
    "operational",
  );
});

test("unknown explicit versions fail closed", () => {
  assert.throws(
    () => resolveBookingModelVersion({ bookingModelVersion: 3 }),
    UnsupportedBookingModelVersionError,
  );
});
