import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";
  import { createHmac } from "node:crypto";

  import { createHelcimWebhookPostHandler, resolveHelcimWebhookGatewayForRequest } from "./src/app/api/webhooks/card-transactions/route.ts";
  import { buildMockHelcimWebhook, signMockHelcimWebhook } from "./src/lib/commerce/helcim-mock-gateway.ts";

  const verifierToken = Buffer.from("webhook-secret-key").toString("base64");

  function createSignature(id, timestamp, body) {
    return createHmac("sha256", Buffer.from(verifierToken, "base64"))
      .update(id + "." + timestamp + "." + body, "utf8")
      .digest("base64");
  }

  function createRequest(body, signature) {
    const id = "webhook-route-test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedSignature = signature ?? "v1," + createSignature(id, timestamp, body);

    return new Request("http://localhost:3000/api/webhooks/card-transactions", {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-signature": signedSignature,
        "webhook-timestamp": timestamp,
      },
      body,
    });
  }

  async function runScenario({
    finalizeAppointmentPaymentForOrder,
    getCardTransaction,
    getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
    getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice,
    recordEvent,
    sendBookingConfirmationEmailForOrder,
    sendProductOrderConfirmationEmailForOrder,
    sendTrainingPaymentNotificationEmailsIfNeeded,
  }) {
    const recorded = [];
    const finalizedBookings = [];
    const sentBookingEmails = [];
    const sentProductEmails = [];
    const trainingNotifications = [];
    const markedStaffAlerts = [];
    const sentEmails = [];
    const handler = createHelcimWebhookPostHandler({
      finalizeAppointmentPaymentForOrder: async (input) => {
        finalizedBookings.push(input);
        if (finalizeAppointmentPaymentForOrder) {
          return finalizeAppointmentPaymentForOrder(input);
        }
        return { ok: true, eventId: "calendar-event-1", status: "booked" };
      },
      getCardTransaction,
      getVerifierToken: () => verifierToken,
      getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: async (input) => {
        if (getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice) {
          return getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice(input);
        }
        return null;
      },
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async (input) => {
        if (!getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing) {
          return null;
        }

        const notification = await getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing(input);
        if (notification) {
          trainingNotifications.push(notification);
        }
        return notification;
      },
      recordEvent: async (event) => {
        recorded.push(event);
        if (recordEvent) {
          const result = await recordEvent(event);
          if (typeof result === "boolean") {
            return { matchedOrder: null, paid: false, recorded: result };
          }
          return result;
        }
        return { matchedOrder: null, paid: false, recorded: true };
      },
      sendBookingConfirmationEmailForOrder: async (orderId) => {
        sentBookingEmails.push(orderId);
        if (sendBookingConfirmationEmailForOrder) {
          await sendBookingConfirmationEmailForOrder(orderId);
        }
      },
      sendProductOrderConfirmationEmailForOrder: async (orderId) => {
        sentProductEmails.push(orderId);
        if (sendProductOrderConfirmationEmailForOrder) {
          await sendProductOrderConfirmationEmailForOrder(orderId);
        }
      },
      sendTrainingPaymentNotificationEmailsIfNeeded: async (input) => {
        sentEmails.push({
          customerEmail: input.enrollment.checkoutOrder.customerEmail,
          customerName: input.enrollment.checkoutOrder.customerName,
          orderId: input.enrollment.checkoutOrder.orderId,
          paymentProvider: input.paymentProvider,
          programTitle: input.enrollment.programSnapshot.title,
          schedulingUrl: input.schedulingUrl,
        });
        if (input.enrollment.staffAlertedAt === null) {
          markedStaffAlerts.push({ enrollmentId: input.enrollment.enrollmentId });
        }
        if (sendTrainingPaymentNotificationEmailsIfNeeded) {
          await sendTrainingPaymentNotificationEmailsIfNeeded(input);
        }
      },
    });

    return { finalizedBookings, handler, trainingNotifications, markedStaffAlerts, recorded, sentBookingEmails, sentEmails, sentProductEmails };
  }
`;

test("Helcim webhook route rejects invalid signatures before persistence", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => ({ status: "APPROVED" }),
    });

    const response = await handler(createRequest(body, "v1,bad-signature"));

    assert.equal(response.status, 401);
    assert.equal(recorded.length, 0);
  `);
});

test("Helcim webhook route returns retryable status when transaction detail fetch fails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => {
        throw new Error("Helcim unavailable");
      },
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.equal(recorded.length, 0);
  `);
});

test("Helcim webhook route returns retryable status when private persistence fails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, recorded } = await runScenario({
      getCardTransaction: async () => ({
        amount: "123.45",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => {
        throw new Error("Private DB unavailable");
      },
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].payloadRedacted, {
      amount: "123.45",
      currency: "CAD",
      invoiceNumber: "INV-4242",
      status: "APPROVED",
      transactionId: "25764674",
    });
  `);
});

test("Helcim webhook route uses mock gateway to enrich sparse card transaction webhooks", () => {
  runRouteScenario(`
    process.env.PAYMENT_GATEWAY_MODE = "mock";
    process.env.PAYMENT_MOCK_DEFAULT_SCENARIO = "success";
    delete process.env.VERCEL_ENV;
    process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN = verifierToken;

    const seedRequest = new Request("http://localhost:3000/api/webhooks/card-transactions", { method: "POST" });
    const gateway = await resolveHelcimWebhookGatewayForRequest(seedRequest);
    const invoice = await gateway.createInvoice({
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Webhook mock seed",
      lineItems: [{ sku: "LASH", description: "Lash Set", quantity: 1, price: 75 }],
    });
    await gateway.initializePay({
      paymentType: "purchase",
      amount: 75,
      currency: "CAD",
      invoiceNumber: invoice.invoiceNumber,
    });

    const webhook = buildMockHelcimWebhook({ transactionId: "mock_helcim_txn_1" });
    const signedHeaders = signMockHelcimWebhook({
      headers: webhook.headers,
      rawBody: webhook.rawBody,
      verifierToken,
    });
    const recorded = [];
    const handler = createHelcimWebhookPostHandler({
      finalizeAppointmentPaymentForOrder: async () => ({ ok: true, eventId: "calendar-event-1", status: "booked" }),
      getCardTransaction: async (transactionId, request) => {
        const selectedGateway = await resolveHelcimWebhookGatewayForRequest(request);
        return selectedGateway.getCardTransaction(transactionId);
      },
      getVerifierToken: () => verifierToken,
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async () => null,
      getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: async () => null,
      recordEvent: async (event) => {
        recorded.push(event);
        return { matchedOrder: null, paid: false, recorded: true };
      },
      sendBookingConfirmationEmailForOrder: async () => {},
      sendProductOrderConfirmationEmailForOrder: async () => {},
      sendTrainingPaymentNotificationEmailsIfNeeded: async () => {},
    });
    const response = await handler(new Request("http://localhost:3000/api/webhooks/card-transactions", {
      method: "POST",
      headers: {
        "webhook-id": signedHeaders.id,
        "webhook-signature": signedHeaders.signature,
        "webhook-timestamp": signedHeaders.timestamp,
      },
      body: webhook.rawBody,
    }));

    assert.equal(response.status, 200);
    assert.equal(recorded[0].helcimTransactionId, "mock_helcim_txn_1");
    assert.equal(recorded[0].helcimInvoiceNumber, "MOCK-INV-1");
    assert.equal(recorded[0].status, "APPROVED");
    assert.deepEqual(recorded[0].payloadRedacted.invoiceNumber, "MOCK-INV-1");
  `);
});

test("Helcim webhook route rejects request mock controls unless mock mode is enabled", () => {
  runRouteScenario(`
    await assert.rejects(
      resolveHelcimWebhookGatewayForRequest(new Request("http://localhost:3000/api/webhooks/card-transactions", {
        method: "POST",
        headers: { "x-lash-payment-mock-scenario": "success" },
      })),
      /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/,
    );

    process.env.PAYMENT_GATEWAY_MODE = "live";

    await assert.rejects(
      resolveHelcimWebhookGatewayForRequest(new Request("http://localhost:3000/api/webhooks/card-transactions?mockPaymentScenario=success", {
        method: "POST",
      })),
      /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/,
    );
  `);
});

test("Helcim webhook route rejects request mock controls in production", () => {
  runRouteScenario(`
    process.env.VERCEL_ENV = "production";

    await assert.rejects(
      resolveHelcimWebhookGatewayForRequest(new Request("http://localhost:3000/api/webhooks/card-transactions", {
        method: "POST",
        headers: { "x-lash-payment-mock-scenario": "success" },
      })),
      /Payment mock mode is not allowed in production/,
    );
  `);
});

test("Helcim webhook route does not send product confirmation for training orders", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, sentProductEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: {
          _id: "checkout-order-training",
          amount: 1499,
          currency: "CAD",
          helcimInvoiceId: 4242,
          helcimInvoiceNumber: "INV-TRAINING-4242",
          orderId: "lh-training-123",
          paymentProvider: "helcim",
          purpose: "training",
        },
        paid: true,
        recorded: true,
      }),
      sendProductOrderConfirmationEmailForOrder: async () => {
        throw new Error("Training orders must not send product confirmations");
      },
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.deepEqual(sentProductEmails, []);
  `);
});

test("Helcim webhook route recovers missing training notification and sends payment emails", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, trainingNotifications, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async (input) => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: {
          customerEmail: "client@example.com",
          customerName: "Client Name",
          orderId: "lh-training-123",
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
        studentPaymentEmailSentAt: null,
        tokenExpiresAt: null,
      }),
      getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: async (input) => {
        assert.deepEqual(input, { helcimInvoiceId: undefined, helcimInvoiceNumber: "INV-TRAINING-4242" });
        return {
          checkoutEmail: "client@example.com",
          checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-training-123" },
          enrollmentId: "training-enrollment-1",
          productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 149900, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
          programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
          schedulingToken: "webhook-token-123",
          staffAlertedAt: null,
          studentPaymentEmailSentAt: null,
          tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
        };
      },
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.equal(trainingNotifications.length, 1);
    assert.deepEqual(sentEmails, [
      {
        customerEmail: "client@example.com",
        customerName: "Client Name",
        orderId: "lh-training-123",
        paymentProvider: "helcim",
        programTitle: "Lash Training Program",
        schedulingUrl: "http://localhost:3000/training-programs/lash-training/schedule?token=webhook-token-123",
      },
    ]);
    assert.deepEqual(markedStaffAlerts, [{ enrollmentId: "training-enrollment-1" }]);
  `);
});


test("Helcim webhook route returns retryable status when training token issuance is unavailable", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-training-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 149900, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
        programSnapshot: { id: "program-lash-training", slug: "lash-training", title: "Lash Training Program" },
        staffAlertedAt: null,
        studentPaymentEmailSentAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: async () => null,
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.deepEqual(sentEmails, []);
    assert.deepEqual(markedStaffAlerts, []);
  `);
});

test("Helcim webhook route returns retryable status when training program slug is missing", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-training-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 149900, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
        programSnapshot: { id: "program-lash-training", slug: "", title: "Lash Training Program" },
        staffAlertedAt: null,
        studentPaymentEmailSentAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: async () => ({
        checkoutEmail: "client@example.com",
        checkoutOrder: { customerEmail: "client@example.com", customerName: "Client Name", orderId: "lh-training-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { currency: "CAD", id: "product-training-full", priceCents: 149900, sku: "TRAINING-FULL", title: "Lash Training Full Payment" },
        programSnapshot: { id: "program-lash-training", slug: "", title: "Lash Training Program" },
        schedulingToken: "webhook-token-123",
        staffAlertedAt: null,
        studentPaymentEmailSentAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      }),
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 503);
    assert.deepEqual(sentEmails, []);
    assert.deepEqual(markedStaffAlerts, []);
  `);
});

test("Helcim webhook route finalizes approved appointment webhook after event persistence", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { finalizedBookings, handler } = await runScenario({
      getCardTransaction: async () => ({
        amount: "75.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-APPT-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: {
          _id: "checkout-order-row-1",
          amount: 75,
          currency: "CAD",
          helcimInvoiceId: 4242,
          helcimInvoiceNumber: "INV-APPT-4242",
          orderId: "lh-appointment-123",
          paymentProvider: "helcim",
          purpose: "appointment_deposit",
        },
        paid: true,
        recorded: true,
      }),
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.equal(finalizedBookings.length, 1);
    assert.equal(finalizedBookings[0].order.orderId, "lh-appointment-123");
    assert.equal(finalizedBookings[0].source, "webhook");
    assert.equal(finalizedBookings[0].transactionId, "25764674");
  `);
});

test("Helcim webhook route finalizes duplicate paid appointment events", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { finalizedBookings, handler } = await runScenario({
      getCardTransaction: async () => ({
        amount: "75.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-APPT-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: {
          _id: "checkout-order-row-1",
          amount: 75,
          currency: "CAD",
          helcimInvoiceId: 4242,
          helcimInvoiceNumber: "INV-APPT-4242",
          orderId: "lh-appointment-123",
          paymentProvider: "helcim",
          purpose: "appointment_deposit",
        },
        paid: true,
        recorded: false,
      }),
    });

    assert.equal((await handler(createRequest(body))).status, 200);
    assert.equal(finalizedBookings.length, 1);
    assert.equal(finalizedBookings[0].order.orderId, "lh-appointment-123");
  `);
});

test("Helcim webhook route finalizes approved custom partial appointment webhooks", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { finalizedBookings, handler } = await runScenario({
      getCardTransaction: async () => ({
        amount: "100.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-APPT-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: {
          _id: "checkout-order-row-1",
          amount: 100,
          currency: "CAD",
          helcimInvoiceId: 4242,
          helcimInvoiceNumber: "INV-APPT-4242",
          orderId: "lh-appointment-123",
          paymentProvider: "helcim",
          purpose: "appointment_custom_partial",
        },
        paid: true,
        recorded: true,
      }),
    });

    assert.equal((await handler(createRequest(body))).status, 200);
    assert.equal(finalizedBookings.length, 1);
    assert.equal(finalizedBookings[0].order.purpose, "appointment_custom_partial");
  `);
});

test("Helcim webhook route does not finalize Square appointment orders matched by legacy identifiers", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { finalizedBookings, handler } = await runScenario({
      getCardTransaction: async () => ({
        amount: "75.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-APPT-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: {
          _id: "checkout-order-row-square",
          amount: 75,
          currency: "CAD",
          helcimInvoiceId: null,
          helcimInvoiceNumber: null,
          orderId: "lh-square-appointment-123",
          paymentProvider: "square",
          purpose: "appointment_deposit",
        },
        paid: true,
        recorded: true,
      }),
      finalizeAppointmentPaymentForOrder: async () => {
        throw new Error("Square service rows must not enter Helcim appointment finalization");
      },
    });

    assert.equal((await handler(createRequest(body))).status, 200);
    assert.equal(finalizedBookings.length, 0);
  `);
});

test("Helcim webhook route does not finalize unmatched appointment events", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { finalizedBookings, handler } = await runScenario({
      getCardTransaction: async () => ({
        amount: "75.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-APPT-4242",
        status: "APPROVED",
      }),
      recordEvent: async () => ({
        matchedOrder: null,
        paid: false,
        recorded: true,
      }),
    });

    assert.equal((await handler(createRequest(body))).status, 200);
    assert.equal(finalizedBookings.length, 0);
  `);
});

test("Helcim webhook route does not send duplicate training emails when notification is already recorded", () => {
  runRouteScenario(`
    const body = JSON.stringify({ id: "25764674", type: "cardTransaction" });
    const { handler, trainingNotifications, markedStaffAlerts, sentEmails } = await runScenario({
      getCardTransaction: async () => ({
        amount: "1499.00",
        currency: "CAD",
        id: 25764674,
        invoiceNumber: "INV-TRAINING-4242",
        status: "APPROVED",
      }),
      getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: async () => null,
      recordEvent: async () => true,
    });

    const response = await handler(createRequest(body));

    assert.equal(response.status, 200);
    assert.equal(trainingNotifications.length, 0);
    assert.equal(sentEmails.length, 0);
    assert.equal(markedStaffAlerts.length, 0);
  `);
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  delete env.PAYMENT_GATEWAY_MODE;
  delete env.PAYMENT_MOCK_DEFAULT_SCENARIO;
  delete env.VERCEL_ENV;

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
