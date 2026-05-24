import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolvePaidTrainingBookingContext,
  resolveTrainingIntroCallEligibility,
} from "./paid-training-context";
import type { PendingTrainingEnrollmentRecord } from "@/lib/commerce/training-enrollment-store";
import type { BookingRequestInput } from "./types";

const baseRequest: BookingRequestInput = {
  bookingType: "in-person-appointment",
  start: "2026-05-12T14:00:00.000Z",
  name: "Client Name",
  email: " client-entered@example.com ",
  phone: "555-555-5555",
  answers: [],
  marketingOptIn: false,
  idempotencyKey: "booking-request-1",
};

const pendingEnrollment: PendingTrainingEnrollmentRecord = {
  checkoutEmail: "checkout@example.com",
  checkoutOrder: {
    amountCents: 149900,
    checkoutTokenHash: "checkout-token-hash",
    calendarEventId: null,
    calendarFinalizationStatus: "not_required",
    createdAt: new Date("2026-05-10T00:00:00.000Z"),
    currency: "CAD",
    customerEmail: "checkout@example.com",
    customerName: "Client Name",
    deletedAt: null,
    failedAt: null,
    finalizedAt: null,
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
    paymentProvider: "helcim",
    providerCheckoutId: null,
    providerMetadata: null,
    providerOrderId: null,
    providerPaymentId: null,
    providerStatus: null,
    purpose: "training",
    redactedAt: null,
    secretTokenCiphertext: "v1:encrypted",
    squareLocationId: null,
    squarePaymentLinkId: null,
    squarePaymentLinkUrl: null,
    squareTipAmountCents: null,
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
  staffAlertedAt: null,
  tokenExpiresAt: new Date("2099-05-24T00:00:00.000Z"),
};

test("resolvePaidTrainingBookingContext preserves public booking input without scheduling token", async () => {
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

test("resolvePaidTrainingBookingContext verifies scheduling token and matching route slug", async () => {
  const result = await resolvePaidTrainingBookingContext(
    {
      ...baseRequest,
      email: "client-entered@example.com",
      paidSchedulingToken: " raw-token ",
      paidTrainingSlug: " lash-training ",
    },
    async ({ schedulingToken }) => {
      assert.equal(schedulingToken, "raw-token");
      return pendingEnrollment;
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.input.bookingType, "training-call");
    assert.equal(result.input.email, "checkout@example.com");
    assert.equal(result.input.paidSchedulingToken, "raw-token");
    assert.equal(result.input.paidTrainingSlug, "lash-training");
    assert.deepEqual(result.context, {
      checkoutEmail: "checkout@example.com",
      enrollmentId: "training-enrollment-1",
      programTitle: "Lash Training Program",
      publicOrderId: "LH-TRAINING-123",
      schedulingToken: "raw-token",
    });
  }
});

test("resolveTrainingIntroCallEligibility rejects missing scheduling token", async () => {
  const result = await resolveTrainingIntroCallEligibility(
    { programSlug: "lash-training", schedulingToken: " " },
    async () => pendingEnrollment,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.error, "We could not verify this training scheduling link.");
    assert.deepEqual(result.fieldErrors, { schedulingToken: "Valid training scheduling link is required" });
  }
});

test("resolveTrainingIntroCallEligibility returns generic failure for expired, used, unpaid, scheduled, or missing token state", async () => {
  const scenarios = [
    null,
    { ...pendingEnrollment, tokenExpiresAt: new Date("2026-05-09T00:00:00.000Z") },
    { ...pendingEnrollment, checkoutOrder: { ...pendingEnrollment.checkoutOrder, status: "pending" } },
  ] as const;

  for (const enrollment of scenarios) {
    const result = await resolveTrainingIntroCallEligibility(
      { now: new Date("2026-05-10T00:00:00.000Z"), programSlug: "lash-training", schedulingToken: "raw-token" },
      async () => enrollment,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "We could not verify this training scheduling link.");
      assert.equal(result.fieldErrors, undefined);
    }
  }
});

test("resolveTrainingIntroCallEligibility returns generic failure for wrong route slug", async () => {
  const result = await resolveTrainingIntroCallEligibility(
    { programSlug: "other-program", schedulingToken: "raw-token" },
    async () => pendingEnrollment,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.error, "We could not verify this training scheduling link.");
    assert.equal(result.fieldErrors, undefined);
  }
});

test("resolveTrainingIntroCallEligibility accepts valid token and derives checkout email server-side", async () => {
  const result = await resolveTrainingIntroCallEligibility(
    { programSlug: "lash-training", schedulingToken: " raw-token " },
    async ({ schedulingToken }) => {
      assert.equal(schedulingToken, "raw-token");
      return pendingEnrollment;
    },
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.context.checkoutEmail, "checkout@example.com");
    assert.equal(result.context.schedulingToken, "raw-token");
  }
});
