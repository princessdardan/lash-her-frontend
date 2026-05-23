import assert from "node:assert/strict";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  appointmentHolds,
  appointmentHoldStatus,
  calendarFinalizationStatus,
  checkoutOrders,
  checkoutPaymentEvents,
  checkoutOrderPurpose,
  paymentEventProcessingStatus,
  paymentProvider,
} from "./schema";

function getIndexNames(
  table: typeof appointmentHolds | typeof checkoutOrders | typeof checkoutPaymentEvents,
): string[] {
  const names: string[] = [];

  for (const index of getTableConfig(table).indexes) {
    if (typeof index.config.name === "string") {
      names.push(index.config.name);
    }
  }

  return names.sort();
}

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
    "paid_unbookable_rebooking_pending",
    "manual_rebooked",
    "refund_required",
    "refunded",
    "released",
  ]);
});

test("checkout order purpose enum includes custom partial appointment payments", () => {
  assert.deepEqual(checkoutOrderPurpose.enumValues, [
    "product",
    "training",
    "appointment_deposit",
    "appointment_full",
    "appointment_custom_partial",
  ]);
});

test("payment provider enum keeps Helcim compatibility and adds Square", () => {
  assert.deepEqual(paymentProvider.enumValues, ["helcim", "square"]);
});

test("calendar finalization status enum supports rebooking and refund states", () => {
  assert.deepEqual(calendarFinalizationStatus.enumValues, [
    "not_required",
    "pending",
    "paid_calendar_pending",
    "booked",
    "paid_unbookable_rebooking_pending",
    "manual_rebooked",
    "refund_required",
    "refunded",
    "failed",
    "manual_review",
  ]);
});

test("payment event processing status enum supports idempotent webhook handling", () => {
  assert.deepEqual(paymentEventProcessingStatus.enumValues, [
    "received",
    "processed",
    "duplicate",
    "ignored",
    "failed",
  ]);
});

test("checkout orders schema exposes provider and calendar finalization fields", () => {
  const columnNames = Object.keys(checkoutOrders);

  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("providerCheckoutId"));
  assert.ok(columnNames.includes("providerOrderId"));
  assert.ok(columnNames.includes("providerPaymentId"));
  assert.ok(columnNames.includes("providerStatus"));
  assert.ok(columnNames.includes("providerMetadata"));
  assert.ok(columnNames.includes("squarePaymentLinkId"));
  assert.ok(columnNames.includes("squarePaymentLinkUrl"));
  assert.ok(columnNames.includes("squareLocationId"));
  assert.ok(columnNames.includes("squareTipAmountCents"));
  assert.ok(columnNames.includes("calendarFinalizationStatus"));
  assert.ok(columnNames.includes("calendarEventId"));
  assert.ok(columnNames.includes("finalizedAt"));
  assert.ok(columnNames.includes("helcimInvoiceId"));
  assert.ok(columnNames.includes("helcimInvoiceNumber"));
  assert.ok(columnNames.includes("helcimTransactionId"));
});

test("checkout order Helcim invoice fields are retained but provider-specific", () => {
  assert.ok(Object.keys(checkoutOrders).includes("helcimInvoiceId"));
  assert.ok(Object.keys(checkoutOrders).includes("helcimInvoiceNumber"));
  assert.equal(checkoutOrders.helcimInvoiceId.notNull, false);
  assert.equal(checkoutOrders.helcimInvoiceNumber.notNull, false);
  assert.equal(checkoutOrders.helcimTransactionId.notNull, false);
});

test("Square checkout orders can be represented without Helcim invoice identifiers", () => {
  const squareOrder: typeof checkoutOrders.$inferInsert = {
    amountCents: 5000,
    checkoutTokenHash: "square-checkout-token-hash",
    currency: "CAD",
    customerEmail: "client@example.com",
    customerName: "Client Example",
    lineItems: [],
    orderId: "lh-square-order",
    paymentProvider: "square",
    secretTokenCiphertext: "encrypted-square-secret",
    squareLocationId: "LOC123",
    squarePaymentLinkId: "plink_123",
    squarePaymentLinkUrl: "https://square.link/u/example",
    status: "pending",
  };

  assert.equal(squareOrder.helcimInvoiceId, undefined);
  assert.equal(squareOrder.helcimInvoiceNumber, undefined);
  assert.equal(squareOrder.paymentProvider, "square");
});

test("checkout payment events schema exposes provider event dedupe fields", () => {
  const columnNames = Object.keys(checkoutPaymentEvents);

  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("providerEventId"));
  assert.ok(columnNames.includes("providerCheckoutId"));
  assert.ok(columnNames.includes("providerOrderId"));
  assert.ok(columnNames.includes("providerPaymentId"));
  assert.ok(columnNames.includes("providerStatus"));
  assert.ok(columnNames.includes("payloadHash"));
  assert.ok(columnNames.includes("payloadSanitized"));
  assert.ok(columnNames.includes("processingStatus"));
  assert.ok(columnNames.includes("processedAt"));
  assert.ok(columnNames.includes("helcimTransactionId"));
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
  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("squarePaymentLinkId"));
  assert.ok(columnNames.includes("squarePaymentLinkUrl"));
  assert.ok(columnNames.includes("squareCheckoutId"));
  assert.ok(columnNames.includes("squarePaymentId"));
  assert.ok(columnNames.includes("squareOrderId"));
  assert.ok(columnNames.includes("googleEventId"));
  assert.ok(columnNames.includes("finalizationStatus"));
  assert.ok(columnNames.includes("finalizationReason"));
  assert.ok(columnNames.includes("manualReviewStatus"));
  assert.ok(columnNames.includes("manualReviewReason"));
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

test("provider-aware unique indexes guard duplicate event and calendar correlation", () => {
  assert.deepEqual(getIndexNames(checkoutPaymentEvents), [
    "checkout_payment_events_idempotency_key_idx",
    "checkout_payment_events_provider_event_idx",
  ]);

  assert.ok(getIndexNames(checkoutOrders).includes("checkout_orders_calendar_event_id_idx"));
  assert.ok(getIndexNames(appointmentHolds).includes("appointment_holds_google_event_id_idx"));
});

test("Square provider indexes guard duplicate checkout, order, and payment IDs", () => {
  assert.ok(getIndexNames(checkoutOrders).includes("checkout_orders_provider_checkout_idx"));
  assert.ok(getIndexNames(checkoutOrders).includes("checkout_orders_provider_order_idx"));
  assert.ok(getIndexNames(checkoutOrders).includes("checkout_orders_provider_payment_idx"));
  assert.ok(getIndexNames(appointmentHolds).includes("appointment_holds_square_payment_link_id_idx"));
  assert.ok(getIndexNames(appointmentHolds).includes("appointment_holds_square_checkout_id_idx"));
  assert.ok(getIndexNames(appointmentHolds).includes("appointment_holds_square_payment_id_idx"));
  assert.ok(getIndexNames(appointmentHolds).includes("appointment_holds_square_order_id_idx"));
});

test("rebooking-first hold state can be represented before Calendar correlation", () => {
  const rebookingState = "paid_unbookable_rebooking_pending" satisfies
    typeof appointmentHoldStatus.enumValues[number];
  const finalizationState = "paid_unbookable_rebooking_pending" satisfies
    typeof calendarFinalizationStatus.enumValues[number];

  assert.equal(rebookingState, "paid_unbookable_rebooking_pending");
  assert.equal(finalizationState, "paid_unbookable_rebooking_pending");
  assert.ok(Object.keys(appointmentHolds).includes("googleEventId"));
});

test("appointment holds schema does not define raw payment token or card fields", () => {
  const columnNameText = Object.keys(appointmentHolds).join(" ").toLowerCase();

  assert.equal(columnNameText.includes("card"), false);
  assert.equal(columnNameText.includes("cvv"), false);
  assert.equal(columnNameText.includes("cvc"), false);
  assert.equal(columnNameText.includes("token"), false);
  assert.equal(columnNameText.includes("secret"), false);
});
