import assert from "node:assert/strict";
import test from "node:test";

import {
  getManualFulfillmentConflictToken,
  getManualFulfillmentTransition,
} from "./manual-fulfillment-transition";

test("manual fulfillment conflict token distinguishes same-second updates", () => {
  assert.notEqual(
    getManualFulfillmentConflictToken({
      id: "order-1",
      updatedAt: new Date("2026-08-15T12:00:00.001Z"),
    }),
    getManualFulfillmentConflictToken({
      id: "order-1",
      updatedAt: new Date("2026-08-15T12:00:00.999Z"),
    }),
  );
});

test("pickup completion records an evidence-bearing handoff transition", () => {
  assert.deepEqual(
    getManualFulfillmentTransition({
      action: "pickup_complete",
      carrier: "",
      currentManualStatus: "paid_pending_dispatch",
      currentMode: "manual_pickup",
      currentPaymentStatus: "paid",
      trackingNumber: "",
    }),
    {
      carrier: null,
      eventStatus: "dispatched",
      method: "pickup_handoff",
      orderStatus: "dispatched",
      trackingNumber: null,
    },
  );
});

test("manual dispatch requires carrier and tracking evidence", () => {
  assert.throws(
    () =>
      getManualFulfillmentTransition({
        action: "manual_shipping_dispatch",
        carrier: "",
        currentManualStatus: "paid_pending_dispatch",
        currentMode: "manual_shipping",
        currentPaymentStatus: "paid",
        trackingNumber: "",
      }),
    /requires carrier and tracking evidence/,
  );
});

test("cancellation locks paid fulfillment while refund allocations are pending", () => {
  assert.equal(
    getManualFulfillmentTransition({
      action: "approve_cancellation",
      carrier: "",
      currentManualStatus: "paid_pending_dispatch",
      currentMode: "manual_shipping",
      currentPaymentStatus: "paid",
      trackingNumber: "",
    }).orderStatus,
    "cancelled",
  );
  assert.throws(
    () =>
      getManualFulfillmentTransition({
        action: "manual_shipping_dispatch",
        carrier: "Canada Post",
        currentManualStatus: "cancelled",
        currentMode: "manual_shipping",
        currentPaymentStatus: "paid",
        trackingNumber: "TRACK-1",
      }),
    /terminal or cancellation-locked/,
  );
});

test("conflict token preserves exact database milliseconds", () => {
  assert.equal(
    getManualFulfillmentConflictToken({
      id: "order-id",
      updatedAt: new Date("2026-08-15T12:00:00.499Z"),
    }),
    "order-id:1786795200499",
  );
});
