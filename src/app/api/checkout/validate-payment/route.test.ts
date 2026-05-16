import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createValidatePaymentPostHandler } from "./src/app/api/checkout/validate-payment/route.ts";

  const pendingOrder = {
    _id: "checkout-order-row-1",
    amount: 1130,
    currency: "CAD",
    helcimInvoiceId: 4242,
    helcimInvoiceNumber: "INV-4242",
    orderId: "lh-order-123",
    secretToken: "checkout-secret-token",
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
    getPendingOrderByCheckoutToken,
    issueTrainingSchedulingTokenForPaidOrder,
    markOrderPaid,
    markOrderVerificationFailed,
    markTrainingEnrollmentStaffAlerted,
    persistVerifiedPayment,
    sendTrainingPaymentNotificationEmails,
    verifyHelcimPayment,
  } = {}) {
    const errors = [];
    const markedFailedOrders = [];
    const markedPaidOrders = [];
    const markedStaffAlerts = [];
    const sentEmails = [];

    const handler = createValidatePaymentPostHandler({
      getPendingOrderByCheckoutToken: async (checkoutToken) => {
        if (getPendingOrderByCheckoutToken) {
          return getPendingOrderByCheckoutToken(checkoutToken);
        }
        return pendingOrder;
      },
      issueTrainingSchedulingTokenForPaidOrder: async (orderId) => {
        if (issueTrainingSchedulingTokenForPaidOrder) {
          return issueTrainingSchedulingTokenForPaidOrder(orderId);
        }
        return null;
      },
      logError: (message, context) => {
        errors.push({ context, message });
      },
      markOrderPaid: async (orderId, transactionId) => {
        markedPaidOrders.push({ orderId, transactionId });
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
          await markTrainingEnrollmentStaffAlerted(input);
        }
      },
      persistVerifiedPayment: async (input) => {
        if (persistVerifiedPayment) {
          return persistVerifiedPayment(input);
        }
        await input.markPaid(input.orderId, input.transactionId);
        return true;
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

    return { errors, handler, markedFailedOrders, markedPaidOrders, markedStaffAlerts, sentEmails };
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

test("checkout payment validation returns product confirmation URL after success", () => {
  runRouteScenario(`
    const { handler, markedPaidOrders } = await runScenario();

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
  `);
});

test("checkout payment validation returns 500 when verified payment persistence fails", () => {
  runRouteScenario(`
    const { handler, markedPaidOrders } = await runScenario({
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
  `);
});

test("checkout payment validation logs training email failures without blocking success", () => {
  runRouteScenario(`
    const { errors, handler, markedStaffAlerts, sentEmails } = await runScenario({
      issueTrainingSchedulingTokenForPaidOrder: async () => ({
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
        schedulingToken: "training-schedule-token",
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
      redirectUrl: "/training-programs/lash-training/confirmation?order=lh-order-123&token=training-schedule-token",
    });
    assert.deepEqual(sentEmails, [{
      customerEmail: "client@example.com",
      customerName: "Client Name",
      orderId: "lh-order-123",
      programTitle: "Lash Training Program",
      schedulingUrl: "http://localhost:3000/booking?type=training-call&token=training-schedule-token",
    }]);
    assert.equal(markedStaffAlerts.length, 0);
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
