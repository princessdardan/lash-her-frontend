import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";
  import { createHmac } from "node:crypto";

  import { createHelcimWebhookPostHandler } from "./src/app/api/webhooks/card-transactions/route.ts";

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
    markTrainingEnrollmentStaffAlerted,
    recordEvent,
    sendTrainingPaymentNotificationEmails,
  }) {
    const recorded = [];
    const finalizedBookings = [];
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
      markTrainingEnrollmentStaffAlerted: async (input) => {
        markedStaffAlerts.push(input);
        if (markTrainingEnrollmentStaffAlerted) {
          return markTrainingEnrollmentStaffAlerted(input);
        }
        return true;
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
      sendTrainingPaymentNotificationEmails: async (input) => {
        sentEmails.push(input);
        if (sendTrainingPaymentNotificationEmails) {
          await sendTrainingPaymentNotificationEmails(input);
        }
      },
    });

    return { finalizedBookings, handler, trainingNotifications, markedStaffAlerts, recorded, sentEmails };
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
        tokenExpiresAt: null,
      }),
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
        programTitle: "Lash Training Program",
        schedulingUrl: "http://localhost:3000/booking?type=training-call&order=lh-training-123",
      },
    ]);
    assert.deepEqual(markedStaffAlerts, [{ enrollmentId: "training-enrollment-1" }]);
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
