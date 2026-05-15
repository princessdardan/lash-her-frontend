import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePaidTrainingBookingContext } from "./paid-training-context";
import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { BookingRequestInput } from "./types";

const baseRequest: BookingRequestInput = {
  bookingType: "in-person-appointment",
  start: "2026-05-12T14:00:00.000Z",
  name: "Client Name",
  email: " Client@Example.com ",
  phone: "555-555-5555",
  answers: [],
  marketingOptIn: false,
  idempotencyKey: "booking-request-1",
};

const pendingEnrollment: PendingTrainingEnrollmentRecord = {
  checkoutEmail: "client@example.com",
  checkoutOrder: {
    amountCents: 149900,
    checkoutTokenHash: "checkout-token-hash",
    createdAt: new Date("2026-05-10T00:00:00.000Z"),
    currency: "CAD",
    customerEmail: "client@example.com",
    customerName: "Client Name",
    deletedAt: null,
    failedAt: null,
    helcimInvoiceId: 4242,
    helcimInvoiceNumber: "INV-4242",
    helcimTransactionId: "txn-paid-123",
    id: "checkout-order-1",
    lineItems: [
      {
        description: "Lash Training Full Program",
        productId: "lash-training",
        quantity: 1,
        sku: "TRAINING-FULL",
        totalCents: 149900,
        unitPriceCents: 149900,
      },
    ],
    orderId: "LH-TRAINING-123",
    paidAt: new Date("2026-05-10T00:10:00.000Z"),
    redactedAt: null,
    secretTokenCiphertext: "v1:encrypted",
    status: "paid",
    updatedAt: new Date("2026-05-10T00:10:00.000Z"),
  },
  enrollmentId: "training-enrollment-1",
  productSnapshot: {
    currency: "CAD",
    id: "product-training-full",
    priceCents: 149900,
    sku: "TRAINING-FULL",
    title: "Lash Training Full Payment",
  },
  programSnapshot: {
    id: "program-lash-training",
    slug: "lash-training",
    title: "Lash Training Program",
  },
  tokenExpiresAt: new Date("2026-05-24T00:10:00.000Z"),
};

test("resolvePaidTrainingBookingContext preserves public booking input without token", async () => {
  let lookupCalled = false;
  const result = await resolvePaidTrainingBookingContext(baseRequest, async () => {
    lookupCalled = true;
    return pendingEnrollment;
  });

  assert.equal(result.ok, true);
  assert.equal(lookupCalled, false);

  if (result.ok) {
    assert.equal(result.context, null);
    assert.equal(result.input.bookingType, "in-person-appointment");
  }
});

test("resolvePaidTrainingBookingContext forces paid token bookings to training-call", async () => {
  const result = await resolvePaidTrainingBookingContext(
    { ...baseRequest, paidSchedulingToken: " paid-token " },
    async ({ schedulingToken }) => {
      assert.equal(schedulingToken, "paid-token");
      return pendingEnrollment;
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.input.bookingType, "training-call");
    assert.deepEqual(result.context, {
      enrollmentId: "training-enrollment-1",
      programTitle: "Lash Training Program",
      publicOrderId: "LH-TRAINING-123",
    });
  }
});

test("resolvePaidTrainingBookingContext rejects checkout email mismatch", async () => {
  const result = await resolvePaidTrainingBookingContext(
    {
      ...baseRequest,
      email: "other@example.com",
      paidSchedulingToken: "paid-token",
    },
    async () => pendingEnrollment,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.fieldErrors?.email, "Use the same email address used at checkout");
  }
});
