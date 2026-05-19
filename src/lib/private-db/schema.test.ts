import assert from "node:assert/strict";
import test from "node:test";

import {
  appointmentHolds,
  appointmentHoldStatus,
} from "./schema";

test("appointment hold status enum matches booking lifecycle states", () => {
  assert.deepEqual(appointmentHoldStatus.enumValues, [
    "held",
    "payment_pending",
    "paid_pending_booking",
    "booked",
    "expired",
    "payment_failed",
    "booking_failed",
    "manual_followup",
    "released",
  ]);
});

test("appointment holds schema exposes required lifecycle and reconciliation fields", () => {
  const columnNames = Object.keys(appointmentHolds);

  assert.ok(columnNames.includes("id"));
  assert.ok(columnNames.includes("publicReference"));
  assert.ok(columnNames.includes("offeringId"));
  assert.ok(columnNames.includes("offeringSnapshot"));
  assert.ok(columnNames.includes("bookingType"));
  assert.ok(columnNames.includes("customerSnapshot"));
  assert.ok(columnNames.includes("selectedStart"));
  assert.ok(columnNames.includes("selectedEnd"));
  assert.ok(columnNames.includes("timezone"));
  assert.ok(columnNames.includes("status"));
  assert.ok(columnNames.includes("expiresAt"));
  assert.ok(columnNames.includes("checkoutOrderId"));
  assert.ok(columnNames.includes("checkoutOrderPublicId"));
  assert.ok(columnNames.includes("helcimInvoiceId"));
  assert.ok(columnNames.includes("helcimInvoiceNumber"));
  assert.ok(columnNames.includes("helcimTransactionId"));
  assert.ok(columnNames.includes("googleEventId"));
  assert.ok(columnNames.includes("failureReason"));
  assert.ok(columnNames.includes("failureMetadata"));
  assert.ok(columnNames.includes("reconciliationMetadata"));
  assert.ok(columnNames.includes("releasedAt"));
  assert.ok(columnNames.includes("paidAt"));
  assert.ok(columnNames.includes("bookedAt"));
  assert.ok(columnNames.includes("expiredAt"));
  assert.ok(columnNames.includes("paymentFailedAt"));
  assert.ok(columnNames.includes("bookingFailedAt"));
  assert.ok(columnNames.includes("manualFollowupAt"));
  assert.ok(columnNames.includes("createdAt"));
  assert.ok(columnNames.includes("updatedAt"));
});

test("appointment holds schema does not define raw payment token or card fields", () => {
  const columnNameText = Object.keys(appointmentHolds).join(" ").toLowerCase();

  assert.equal(columnNameText.includes("card"), false);
  assert.equal(columnNameText.includes("cvv"), false);
  assert.equal(columnNameText.includes("cvc"), false);
  assert.equal(columnNameText.includes("token"), false);
  assert.equal(columnNameText.includes("secret"), false);
});
