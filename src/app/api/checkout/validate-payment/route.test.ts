import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createValidatePaymentPostHandler } from "./src/app/api/checkout/validate-payment/route.ts";

  const pendingOrder = {
    _id: "checkout-order-row-1",
    amount: 1130,
    currency: "CAD",
    customerEmail: "client@example.com",
    customerName: "Client Name",
    helcimInvoiceId: 4242,
    helcimInvoiceNumber: "INV-4242",
    orderId: "lh-order-123",
    secretToken: "checkout-secret-token",
    purpose: "product",
    lineItems: [
      {
        description: "Signature Lash Set",
        productId: "signature-lash-set",
        quantity: 1,
        sku: "LASH-SIGNATURE",
        totalCents: 100000,
        unitPriceCents: 100000,
      },
      {
        description: "Aftercare Kit",
        productId: "aftercare-kit",
        quantity: 2,
        sku: "CARE-KIT",
        totalCents: 13000,
        unitPriceCents: 6500,
      },
    ],
  };

  const approvedPaymentData = {
    amount: "1130.00",
    approved: true,
    currency: "CAD",
    invoiceId: "4242",
    invoiceNumber: "INV-4242",
    transactionId: "txn-verified-123",
  };

  function createRequest(body) {
    return new Request("http://localhost:3000/api/checkout/validate-payment", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async function runScenario({
    finalizeAppointmentPaymentForOrder,
    getAppointmentHoldByCheckoutOrderPublicId,
    getPendingOrderByCheckoutToken,
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
    markOrderPaid,
    markOrderVerificationFailed,
    markTrainingEnrollmentStaffAlerted,
    persistVerifiedPayment,
    sendProductOrderConfirmationEmail,
    getOrIssueTrainingSchedulingTokenForPaidOrder,
    sendTrainingPaymentNotificationEmails,
    verifyHelcimPayment,
  } = {}) {
    const errors = [];
    const finalizedBookings = [];
    const markedFailedOrders = [];
    const markedPaidOrders = [];
    const markedStaffAlerts = [];
    const operationOrder = [];
    const sentEmails = [];
    const sentProductEmails = [];

    const handler = createValidatePaymentPostHandler({
      finalizeAppointmentPaymentForOrder: async (input) => {
        finalizedBookings.push(input);
        if (finalizeAppointmentPaymentForOrder) {
          return finalizeAppointmentPaymentForOrder(input);
        }
        return { ok: true, eventId: "calendar-event-1", status: "booked" };
      },
      getAppointmentHoldByCheckoutOrderPublicId: async (orderId) => {
        if (getAppointmentHoldByCheckoutOrderPublicId) {
          return getAppointmentHoldByCheckoutOrderPublicId(orderId);
        }
        return null;
      },
      getPendingOrderByCheckoutToken: async (checkoutToken) => {
        if (getPendingOrderByCheckoutToken) {
          return getPendingOrderByCheckoutToken(checkoutToken);
        }
        return pendingOrder;
      },
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async (orderId) => {
        if (getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId) {
          return getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(orderId);
        }
        return null;
      },
      getOrIssueTrainingSchedulingTokenForPaidOrder: async (orderId) => {
        if (getOrIssueTrainingSchedulingTokenForPaidOrder) {
          return getOrIssueTrainingSchedulingTokenForPaidOrder(orderId);
        }
        return null;
      },
      logError: (message, context) => {
        errors.push({ context, message });
      },
      markOrderPaid: async (orderId, transactionId) => {
        markedPaidOrders.push({ orderId, transactionId });
        operationOrder.push("mark-paid");
        if (markOrderPaid) {
          await markOrderPaid(orderId, transactionId);
        }
      },
      markOrderVerificationFailed: async (orderId) => {
        markedFailedOrders.push(orderId);
        if (markOrderVerificationFailed) {
          await markOrderVerificationFailed(orderId);
        }
      },
      markTrainingEnrollmentStaffAlerted: async (input) => {
        markedStaffAlerts.push(input);
        if (markTrainingEnrollmentStaffAlerted) {
          return markTrainingEnrollmentStaffAlerted(input);
        }
        return true;
      },
      persistVerifiedPayment: async (input) => {
        if (persistVerifiedPayment) {
          return persistVerifiedPayment(input);
        }
        await input.markPaid(input.orderId, input.transactionId);
        operationOrder.push("persisted");
        return true;
      },
      sendProductOrderConfirmationEmail: async (input) => {
        operationOrder.push("product-email");
        sentProductEmails.push(input);
        if (sendProductOrderConfirmationEmail) {
          await sendProductOrderConfirmationEmail(input);
        }
      },
      sendTrainingPaymentNotificationEmails: async (input) => {
        sentEmails.push(input);
        if (sendTrainingPaymentNotificationEmails) {
          await sendTrainingPaymentNotificationEmails(input);
        }
      },
      verifyHelcimPayment: (input) => {
        if (verifyHelcimPayment) {
          return verifyHelcimPayment(input);
        }
        return { ok: true, transactionId: "txn-verified-123" };
      },
    });

    return { errors, finalizedBookings, handler, markedFailedOrders, markedPaidOrders, markedStaffAlerts, operationOrder, sentEmails, sentProductEmails };
  }
`;

test("checkout payment validation rejects invalid request bodies before lookup", () => {
  runRouteScenario(`
    let lookupCount = 0;
    const { handler, markedPaidOrders } = await runScenario({
      getPendingOrderByCheckoutToken: async () => {
        lookupCount += 1;
        return pendingOrder;
      },
    });

    const response = await handler(createRequest({ data: approvedPaymentData, hash: "hash" }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request body" });
    assert.equal(lookupCount, 0);
    assert.equal(markedPaidOrders.length, 0);
  `);
});

test("checkout payment validation returns not found for missing pending order", () => {
  runRouteScenario(`
    const { handler, markedFailedOrders } = await runScenario({
      getPendingOrderByCheckoutToken: async () => null,
    });

    const response = await handler(createRequest({
      checkoutToken: "missing-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Checkout session not found" });
    assert.equal(markedFailedOrders.length, 0);
  `);
});

test("checkout payment validation rejects invalid hashes and marks order failed", () => {
  runRouteScenario(`
    const { handler, markedFailedOrders } = await runScenario({
      verifyHelcimPayment: () => ({ ok: false, reason: "invalid_hash" }),
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "bad-hash",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Payment could not be verified" });
    assert.deepEqual(markedFailedOrders, ["lh-order-123"]);
  `);
});

test("checkout payment validation marks order failed for payment mismatches", () => {
  runRouteScenario(`
    const { handler, markedFailedOrders, markedPaidOrders } = await runScenario({
      verifyHelcimPayment: () => ({ ok: false, reason: "wrong_amount" }),
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: { ...approvedPaymentData, amount: "1.00" },
      hash: "hash",
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(markedFailedOrders, ["lh-order-123"]);
    assert.equal(markedPaidOrders.length, 0);
  `);
});

test("checkout payment validation sends product confirmation email after persisted success", () => {
  runRouteScenario(`
    const { handler, markedPaidOrders, operationOrder, sentProductEmails } = await runScenario();

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-order-123",
      redirectUrl: "/products/confirmation?order=lh-order-123",
    });
    assert.deepEqual(markedPaidOrders, [{ orderId: "lh-order-123", transactionId: "txn-verified-123" }]);
    assert.deepEqual(operationOrder, ["mark-paid", "persisted", "product-email"]);
    assert.deepEqual(sentProductEmails, [{
      currency: "CAD",
      customerEmail: "client@example.com",
      customerName: "Client Name",
      lineItems: pendingOrder.lineItems,
      orderId: "lh-order-123",
      totalAmount: 1130,
    }]);
  `);
});


test("checkout payment validation finalizes appointment payments after persistence", () => {
  runRouteScenario(`
    const appointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_deposit",
    };
    const { finalizedBookings, handler, operationOrder, sentEmails, sentProductEmails } = await runScenario({
      getPendingOrderByCheckoutToken: async () => appointmentOrder,
      getAppointmentHoldByCheckoutOrderPublicId: async () => ({
        offeringSnapshot: { slug: "signature-lash-set" },
      }),
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: true,
        eventId: "calendar-event-appointment",
        status: "booked",
      }),
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => {
        throw new Error("training branch should not run");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      bookingStatus: "booked",
      eventId: "calendar-event-appointment",
      orderId: "lh-order-123",
      redirectUrl: "/services/signature-lash-set/booking/confirmation?order=lh-order-123",
    });
    assert.equal(finalizedBookings.length, 1);
    assert.equal(finalizedBookings[0].order.orderId, "lh-order-123");
    assert.equal(finalizedBookings[0].source, "client_validation");
    assert.equal(finalizedBookings[0].transactionId, "txn-verified-123");
    assert.deepEqual(operationOrder, ["mark-paid", "persisted"]);
    assert.equal(sentProductEmails.length, 0);
    assert.equal(sentEmails.length, 0);
  `);
});

test("checkout payment validation finalizes custom partial appointment payments after persistence", () => {
  runRouteScenario(`
    const appointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_custom_partial",
    };
    const { finalizedBookings, handler, operationOrder, sentEmails, sentProductEmails } = await runScenario({
      getPendingOrderByCheckoutToken: async () => appointmentOrder,
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: true,
        eventId: "calendar-event-appointment",
        status: "booked",
      }),
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => {
        throw new Error("training branch should not run");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.equal(finalizedBookings.length, 1);
    assert.equal(finalizedBookings[0].order.purpose, "appointment_custom_partial");
    assert.deepEqual(operationOrder, ["mark-paid", "persisted"]);
    assert.equal(sentProductEmails.length, 0);
    assert.equal(sentEmails.length, 0);
  `);
});

test("checkout payment validation falls back to service confirmation resolver for unsafe appointment snapshot slugs", () => {
  runRouteScenario(`
    const appointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_full",
    };
    const { handler } = await runScenario({
      getPendingOrderByCheckoutToken: async () => appointmentOrder,
      getAppointmentHoldByCheckoutOrderPublicId: async () => ({
        offeringSnapshot: { slug: "../admin" },
      }),
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: true,
        eventId: "calendar-event-appointment",
        status: "booked",
      }),
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      bookingStatus: "booked",
      eventId: "calendar-event-appointment",
      orderId: "lh-order-123",
      redirectUrl: "/services/booking/confirmation?order=lh-order-123",
    });
  `);
});


test("checkout payment validation can confirm an already-paid appointment order", () => {
  runRouteScenario(`
    const paidAppointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_deposit",
    };
    const { finalizedBookings, handler, operationOrder, sentEmails, sentProductEmails } = await runScenario({
      getPendingOrderByCheckoutToken: async () => paidAppointmentOrder,
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: true,
        eventId: "calendar-event-existing",
        status: "booked",
      }),
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      bookingStatus: "booked",
      eventId: "calendar-event-existing",
      orderId: "lh-order-123",
      redirectUrl: "/services/booking/confirmation?order=lh-order-123",
    });
    assert.equal(finalizedBookings.length, 1);
    assert.deepEqual(operationOrder, ["mark-paid", "persisted"]);
    assert.equal(sentProductEmails.length, 0);
    assert.equal(sentEmails.length, 0);
  `);
});

test("checkout payment validation preserves paid appointment order when finalization fails", () => {
  runRouteScenario(`
    const appointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_full",
    };
    const { errors, finalizedBookings, handler, operationOrder, sentEmails, sentProductEmails } = await runScenario({
      getPendingOrderByCheckoutToken: async () => appointmentOrder,
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: false,
        error: "Calendar unavailable",
        status: "booking_failed",
      }),
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => {
        throw new Error("training branch should not run");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      bookingStatus: "booking_failed",
      error: "Payment received; booking requires manual follow-up",
      orderId: "lh-order-123",
      redirectUrl: "/services/booking/confirmation?order=lh-order-123",
    });
    assert.equal(finalizedBookings.length, 1);
    assert.deepEqual(operationOrder, ["mark-paid", "persisted"]);
    assert.equal(sentProductEmails.length, 0);
    assert.equal(sentEmails.length, 0);
    assert.deepEqual(errors, [{
      context: { error: "Calendar unavailable", orderId: "lh-order-123", status: "booking_failed" },
      message: "[checkout] Appointment booking finalization failed",
    }]);
  `);
});

test("checkout payment validation does not redirect while appointment finalization is already in progress", () => {
  runRouteScenario(`
    const appointmentOrder = {
      ...pendingOrder,
      purpose: "appointment_full",
    };
    const { errors, finalizedBookings, handler, operationOrder } = await runScenario({
      getPendingOrderByCheckoutToken: async () => appointmentOrder,
      finalizeAppointmentPaymentForOrder: async () => ({
        ok: false,
        error: "Booking finalization is already in progress.",
        status: "finalization_pending",
      }),
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => {
        throw new Error("training branch should not run");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      bookingStatus: "finalization_pending",
      error: "Payment received; booking confirmation is still in progress",
      orderId: "lh-order-123",
    });
    assert.equal(finalizedBookings.length, 1);
    assert.deepEqual(operationOrder, ["mark-paid", "persisted"]);
    assert.deepEqual(errors, [{
      context: {
        error: "Booking finalization is already in progress.",
        orderId: "lh-order-123",
        status: "finalization_pending",
      },
      message: "[checkout] Appointment booking finalization failed",
    }]);
  `);
});

test("checkout payment validation returns 500 when verified payment persistence fails", () => {
  runRouteScenario(`
    const { handler, markedPaidOrders, sentProductEmails } = await runScenario({
      persistVerifiedPayment: async () => false,
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Payment verified but order could not be recorded",
    });
    assert.equal(markedPaidOrders.length, 0);
    assert.equal(sentProductEmails.length, 0);
  `);
});

test("checkout payment validation logs product email failures without blocking success", () => {
  runRouteScenario(`
    const { errors, handler, sentProductEmails } = await runScenario({
      sendProductOrderConfirmationEmail: async () => {
        throw new Error("Resend unavailable");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-order-123",
      redirectUrl: "/products/confirmation?order=lh-order-123",
    });
    assert.equal(sentProductEmails.length, 1);
    assert.deepEqual(errors, [{
      context: { error: "Resend unavailable", orderId: "lh-order-123" },
      message: "[checkout] Product order confirmation email failed",
    }]);
  `);
});

test("checkout payment validation sends token-only training schedule URL", () => {
  runRouteScenario(`
    const { handler, markedStaffAlerts, sentEmails } = await runScenario({
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: {
          customerEmail: "client@example.com",
          customerName: "Client Name",
          orderId: "lh-order-123",
        },
        enrollmentId: "training-enrollment-1",
        productSnapshot: {
          currency: "CAD",
          id: "product-training-full",
          priceCents: 113000,
          sku: "TRAINING-FULL",
          title: "Lash Training Full Payment",
        },
        programSnapshot: {
          id: "program-lash-training",
          slug: "lash-training",
          title: "Lash Training Program",
        },
        staffAlertedAt: null,
        tokenExpiresAt: null,
      }),
      getOrIssueTrainingSchedulingTokenForPaidOrder: async (orderId) => {
        assert.equal(orderId, "lh-order-123");
        return {
          checkoutEmail: "client@example.com",
          checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-order-123" },
          enrollmentId: "training-enrollment-1",
          productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 113000, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
          programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
          schedulingToken: "schedule-token-123",
          staffAlertedAt: null,
          tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
        };
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-order-123",
      redirectUrl: "/training-programs/lash-training/schedule?token=schedule-token-123",
    });
    assert.deepEqual(sentEmails, [{
      customerEmail: "client@example.com",
      customerName: "Client Name",
      orderId: "lh-order-123",
      programTitle: "Lash Training Program",
      schedulingUrl: "http://localhost:3000/training-programs/lash-training/schedule?token=schedule-token-123",
    }]);
    assert.equal(sentEmails[0].schedulingUrl.includes("order="), false);
    assert.equal(sentEmails[0].schedulingUrl.includes("email="), false);
    assert.deepEqual(markedStaffAlerts, [{ enrollmentId: "training-enrollment-1" }]);
  `);
});

test("checkout payment validation reuses active training scheduling tokens on duplicate validation", () => {
  runRouteScenario(`
    const { handler, markedStaffAlerts, sentEmails } = await runScenario({
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-order-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 113000, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
        programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
        staffAlertedAt: new Date("2026-05-10T00:30:00.000Z"),
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      getOrIssueTrainingSchedulingTokenForPaidOrder: async (orderId) => {
        assert.equal(orderId, "lh-order-123");
        return {
          checkoutEmail: "client@example.com",
          checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-order-123" },
          enrollmentId: "training-enrollment-1",
          productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 113000, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
          programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
          schedulingToken: "existing-schedule-token-123",
          staffAlertedAt: new Date("2026-05-10T00:30:00.000Z"),
          tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
        };
      },
    });

    const response = await handler(createRequest({ checkoutToken: "checkout-token", data: approvedPaymentData, hash: "hash" }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-order-123",
      redirectUrl: "/training-programs/lash-training/schedule?token=existing-schedule-token-123",
    });
    assert.deepEqual(sentEmails, []);
    assert.deepEqual(markedStaffAlerts, []);
  `);
});

test("checkout payment validation logs training email failures without blocking success", () => {
  runRouteScenario(`
    const { errors, handler, markedStaffAlerts, sentEmails, sentProductEmails } = await runScenario({
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: {
          customerEmail: "client@example.com",
          customerName: "Client Name",
          orderId: "lh-order-123",
        },
        enrollmentId: "training-enrollment-1",
        productSnapshot: {
          currency: "CAD",
          id: "product-training-full",
          priceCents: 113000,
          sku: "TRAINING-FULL",
          title: "Lash Training Full Payment",
        },
        programSnapshot: {
          id: "program-lash-training",
          slug: "lash-training",
          title: "Lash Training Program",
        },
        staffAlertedAt: null,
        tokenExpiresAt: null,
      }),
      getOrIssueTrainingSchedulingTokenForPaidOrder: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-order-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 113000, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
        programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
        schedulingToken: "schedule-token-123",
        staffAlertedAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      sendTrainingPaymentNotificationEmails: async () => {
        throw new Error("Resend unavailable");
      },
    });

    const response = await handler(createRequest({
      checkoutToken: "checkout-token",
      data: approvedPaymentData,
      hash: "hash",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-order-123",
      redirectUrl: "/training-programs/lash-training/schedule?token=schedule-token-123",
    });
    assert.equal(sentProductEmails.length, 0);
    assert.deepEqual(sentEmails, [{
      customerEmail: "client@example.com",
      customerName: "Client Name",
      orderId: "lh-order-123",
      programTitle: "Lash Training Program",
      schedulingUrl: "http://localhost:3000/training-programs/lash-training/schedule?token=schedule-token-123",
    }]);
    assert.deepEqual(markedStaffAlerts, [{ enrollmentId: "training-enrollment-1" }]);
    assert.deepEqual(errors, [{
      context: { error: "Resend unavailable", orderId: "lh-order-123" },
      message: "[checkout] Training payment notification email failed",
    }]);
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
