import assert from "node:assert/strict";
import test from "node:test";

import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";

import {
  createSquarePaymentFinalizer,
  type SquareEventRecordInput,
  type SquarePaymentFinalizerRepository,
} from "./square-payment-finalizer";
import type {
  FinalizeAppointmentPaymentForOrderInput,
  FinalizePaidBookingResult,
} from "./finalizer";
import { createMockSquareClient } from "./square-mock-client";
import type { SquareCreatePaymentLinkRequest } from "./square-client";

function createEnv() {
  return {
    accessToken: "access-token",
    environment: "sandbox" as const,
    helcimLegacyCutoffAt: null,
    locationId: "loc_123",
    serviceBookingReturnUrl: "https://example.com/api/booking/square/return",
    serviceBookingWebhookUrl: "https://example.com/api/webhooks/square",
    webhookSignatureKey: "signature-key",
  };
}

function createPaymentLinkRequest(): SquareCreatePaymentLinkRequest {
  return {
    checkout_options: {
      allow_tipping: true,
      redirect_url: "https://example.com/api/booking/square/return",
    },
    idempotency_key: "sq-idempotency-1",
    order: {
      location_id: "loc_123",
      line_items: [
        {
          base_price_money: { amount: 5000, currency: "CAD" },
          name: "Classic Fill deposit",
          quantity: "1",
        },
      ],
      reference_id: "lh-sq-local",
    },
  };
}

function createStatefulSquareFinalizerRepository() {
  const processedEvents = new Set<string>();
  const finalizedOrders = new Set<string>();
  const paidOrders = new Set<string>();
  const counts = {
    bookingFinalizations: 0,
    eventRecords: 0,
    paidTransitions: 0,
  };

  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent(input) {
      if (input.eventId === undefined) {
        return { duplicate: false };
      }

      if (processedEvents.has(input.eventId)) {
        return { duplicate: true, processingStatus: "processed" };
      }

      processedEvents.add(input.eventId);
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "mock-square-order-1",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      if (input.eventId !== undefined) {
        counts.eventRecords += 1;
      }

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar(input) {
      if (paidOrders.has(input.order.orderId)) {
        return;
      }

      paidOrders.add(input.order.orderId);
      counts.paidTransitions += 1;
    },
  };

  return {
    counts,
    repository,
    async finalizeAppointmentPaymentForOrder(
      input: FinalizeAppointmentPaymentForOrderInput,
    ): Promise<FinalizePaidBookingResult> {
      if (finalizedOrders.has(input.order.orderId)) {
        const bookedResult = {
          ok: true,
          eventId: "calendar-event-1",
          status: "booked",
        } satisfies FinalizePaidBookingResult;

        return bookedResult;
      }

      finalizedOrders.add(input.order.orderId);
      counts.bookingFinalizations += 1;
      const bookedResult = {
        ok: true,
        eventId: "calendar-event-1",
        status: "booked",
      } satisfies FinalizePaidBookingResult;

      return bookedResult;
    },
  };
}

test("Square finalizer dedupes duplicate webhook event IDs before Square fetch", async () => {
  const eventProcessingStatuses = new Map<string, "processed" | "received">();
  let bookingFinalizations = 0;
  let paidTransitions = 0;
  let squareFetches = 0;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent(input) {
      if (input.eventId === undefined) {
        return { duplicate: false };
      }

      const processingStatus = eventProcessingStatuses.get(input.eventId);

      if (processingStatus !== undefined) {
        return { duplicate: true, processingStatus };
      }

      eventProcessingStatuses.set(input.eventId, "received");
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      if (
        input.eventId !== undefined &&
        input.processingStatus === "processed"
      ) {
        eventProcessingStatuses.set(input.eventId, "processed");
      }

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      paidTransitions += 1;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      bookingFinalizations += 1;
      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        squareFetches += 1;
        return { order: { id: "order_123" } };
      },
      async getPayment() {
        squareFetches += 1;
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  await finalizer({
    event: {
      eventId: "evt_123",
      eventType: "payment.updated",
      orderId: "order_123",
      paymentId: "pay_123",
      payloadSanitized: {},
    },
    source: "webhook",
  });
  const duplicateResult = await finalizer({
    event: {
      eventId: "evt_123",
      eventType: "payment.updated",
      orderId: "order_123",
      paymentId: "pay_123",
      payloadSanitized: {},
    },
    source: "webhook",
  });

  assert.equal(duplicateResult.status, "duplicate");
  assert.equal(duplicateResult.duplicateEvent, true);
  assert.equal(squareFetches, 1);
  assert.equal(paidTransitions, 1);
  assert.equal(bookingFinalizations, 1);
});

test("Square finalizer retries booking confirmation email for processed duplicate webhook events", async () => {
  const sentBookingEmails: string[] = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: true, processingStatus: "processed" };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: "pay_123",
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "paid",
      };
    },
    async recordSquareEvent() {
      throw new Error(
        "Processed duplicate recovery must not rewrite Square events",
      );
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error(
        "Processed duplicate recovery must not rewrite paid state",
      );
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error(
        "Processed duplicate recovery must not refinalize the booking",
      );
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async (orderId) => {
      sentBookingEmails.push(orderId);
    },
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Processed duplicate recovery must not fetch Square");
      },
      async getPayment() {
        throw new Error("Processed duplicate recovery must not fetch Square");
      },
    }),
  });

  const result = await finalizer({
    event: {
      eventId: "evt_processed_duplicate",
      eventType: "payment.updated",
      orderId: "order_123",
      paymentId: "pay_123",
      payloadSanitized: {},
    },
    source: "webhook",
  });

  assert.deepEqual(result, {
    duplicateEvent: true,
    finalized: false,
    status: "duplicate",
  });
  assert.deepEqual(sentBookingEmails, ["lh-sq-local"]);
});

test("Square finalizer retries duplicate webhook event IDs that are not terminal processed", async () => {
  const eventProcessingStatuses = new Map<string, "processed" | "received">();
  let bookingFinalizations = 0;
  let paidTransitions = 0;
  let squareFetches = 0;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent(input) {
      if (input.eventId === undefined) {
        return { duplicate: false };
      }

      const processingStatus = eventProcessingStatuses.get(input.eventId);

      if (processingStatus !== undefined) {
        return { duplicate: true, processingStatus };
      }

      eventProcessingStatuses.set(input.eventId, "received");
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      if (
        input.eventId !== undefined &&
        input.processingStatus === "processed"
      ) {
        eventProcessingStatuses.set(input.eventId, "processed");
      }

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      paidTransitions += 1;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      bookingFinalizations += 1;
      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        squareFetches += 1;

        if (squareFetches === 1) {
          throw new Error("Transient Square fetch failure");
        }

        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });
  const event = {
    eventId: "evt_retryable",
    eventType: "payment.updated",
    orderId: "order_123",
    paymentId: "pay_123",
    payloadSanitized: {},
  };

  await assert.rejects(
    () => finalizer({ event, source: "webhook" }),
    /Transient Square fetch failure/,
  );
  const retryResult = await finalizer({ event, source: "webhook" });

  assert.equal(retryResult.status, "booked");
  assert.equal(retryResult.duplicateEvent, false);
  assert.equal(squareFetches, 2);
  assert.equal(paidTransitions, 1);
  assert.equal(bookingFinalizations, 1);
});

test("Square finalizer handles webhook before return on the shared mock payment", async () => {
  const store = createPaymentMockStore({
    now: new Date("2026-05-23T12:00:00.000Z"),
  });
  const client = createMockSquareClient({ scenario: "webhook", store });
  const created = await client.createPaymentLink(createPaymentLinkRequest());
  const harness = createStatefulSquareFinalizerRepository();
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder:
      harness.finalizeAppointmentPaymentForOrder,
    getEnv: createEnv,
    repository: harness.repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => client,
  });

  const webhookResult = await finalizer({
    event: {
      eventId: "evt_webhook_first",
      eventType: "payment.updated",
      orderId: created.payment_link.order_id,
      paymentId: "mock-square-payment-1",
      payloadSanitized: {},
    },
    source: "webhook",
  });
  const returnResult = await finalizer({
    paymentId: "mock-square-payment-1",
    source: "return",
  });

  assert.equal(webhookResult.status, "booked");
  assert.equal(returnResult.status, "booked");
  assert.equal(harness.counts.paidTransitions, 1);
  assert.equal(harness.counts.bookingFinalizations, 1);
  assert.equal(harness.counts.eventRecords, 1);
});

test("Square finalizer handles return before webhook on the shared mock payment", async () => {
  const store = createPaymentMockStore({
    now: new Date("2026-05-23T12:00:00.000Z"),
  });
  const client = createMockSquareClient({ scenario: "webhook", store });
  const created = await client.createPaymentLink(createPaymentLinkRequest());
  const harness = createStatefulSquareFinalizerRepository();
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder:
      harness.finalizeAppointmentPaymentForOrder,
    getEnv: createEnv,
    repository: harness.repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => client,
  });

  const returnResult = await finalizer({
    paymentId: "mock-square-payment-1",
    source: "return",
  });
  const webhookResult = await finalizer({
    event: {
      eventId: "evt_return_first",
      eventType: "payment.updated",
      orderId: created.payment_link.order_id,
      paymentId: "mock-square-payment-1",
      payloadSanitized: {},
    },
    source: "webhook",
  });

  assert.equal(returnResult.status, "booked");
  assert.equal(webhookResult.status, "booked");
  assert.equal(harness.counts.paidTransitions, 1);
  assert.equal(harness.counts.bookingFinalizations, 1);
  assert.equal(harness.counts.eventRecords, 1);
});

test("Square browser return does not finalize an unpaid server-side payment", async () => {
  let recordedPaidState = false;
  let recordedFailedState = false;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentFailed() {
      recordedFailedState = true;
    },
    async recordSquarePaymentPendingCalendar() {
      recordedPaidState = true;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Unpaid Square payment must not finalize a booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "PENDING",
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_123", source: "return" });

  assert.equal(result.status, "unpaid");
  assert.equal(result.finalized, false);
  assert.equal(recordedFailedState, false);
  assert.equal(recordedPaidState, false);
});

test("Square finalizer releases terminal failed payments from active hold inventory", async () => {
  const recordedFailures: unknown[] = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentFailed(input) {
      recordedFailures.push({
        orderId: input.order.orderId,
        paymentId: input.payment.id,
        providerOrderId: input.providerOrderId,
        status: input.payment.status,
      });
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Failed Square payments must not be persisted as paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Failed Square payments must not finalize bookings");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_failed_123",
            order_id: "order_123",
            status: "FAILED",
          },
        };
      },
    }),
  });

  const result = await finalizer({
    paymentId: "pay_failed_123",
    source: "return",
  });

  assert.equal(result.status, "unpaid");
  assert.equal(result.finalized, false);
  assert.deepEqual(recordedFailures, [
    {
      orderId: "lh-sq-local",
      paymentId: "pay_failed_123",
      providerOrderId: "order_123",
      status: "FAILED",
    },
  ]);
});

test("Square finalizer does not bind a Square payment to a mismatched local return order ID", async () => {
  const findInputs: unknown[] = [];
  let recordedFailedState = false;
  let recordedPaidState = false;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder(input) {
      findInputs.push(input);

      if (input.localOrderId === "lh-sq-victim") {
        return {
          amountCents: 5000,
          id: "victim-order-db-id",
          orderId: "lh-sq-victim",
          providerOrderId: "order_victim",
          providerPaymentId: null,
          purpose: "appointment_deposit",
          squareLocationId: "loc_123",
          status: "pending",
        };
      }

      return null;
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentFailed() {
      recordedFailedState = true;
    },
    async recordSquarePaymentPendingCalendar() {
      recordedPaidState = true;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Mismatched Square payments must not finalize bookings");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_attacker_123",
            order_id: "order_attacker",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({
    orderId: "lh-sq-victim",
    paymentId: "pay_attacker_123",
    source: "return",
  });

  assert.deepEqual(findInputs, [
    {
      providerOrderId: "order_attacker",
      providerPaymentId: "pay_attacker_123",
    },
  ]);
  assert.equal(result.status, "ignored");
  assert.equal(result.finalized, false);
  assert.equal(result.reason, "Local Square order not found");
  assert.equal(recordedFailedState, false);
  assert.equal(recordedPaidState, false);
});

test("Square finalizer updates a claimed webhook event to processed after verified payment", async () => {
  const eventStates: Array<{ processingStatus: string; status?: string }> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent(input) {
      eventStates.push({
        processingStatus: input.processingStatus,
        status: input.status,
      });
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      eventStates.push({
        processingStatus: input.processingStatus,
        status: input.status,
      });
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {},
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async (input) => {
      assert.deepEqual(input, {
        order: {
          _id: "order-db-id",
          amount: 50,
          currency: "CAD",
          orderId: "lh-sq-local",
          purpose: "appointment_deposit",
        },
        source: "webhook",
        transactionId: "pay_123",
      });

      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({
    event: {
      eventId: "evt_123",
      eventType: "payment.updated",
      orderId: "order_123",
      paymentId: "pay_123",
      payloadSanitized: {},
    },
    source: "webhook",
  });

  assert.equal(result.status, "booked");
  assert.equal(result.bookingFinalizationStatus, "booked");
  assert.deepEqual(eventStates, [
    { processingStatus: "received", status: "received" },
    { processingStatus: "processed", status: "paid_calendar_pending" },
  ]);
});

test("Square finalizer invokes booking finalization after paid persistence", async () => {
  const operationOrder: string[] = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 7500,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_full",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      operationOrder.push("square-event-processed");
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      operationOrder.push("paid-calendar-pending");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async (input) => {
      assert.deepEqual(operationOrder, ["paid-calendar-pending"]);
      operationOrder.push("booking-finalized");
      assert.equal(input.source, "return");
      assert.equal(input.transactionId, "pay_123");
      assert.deepEqual(input.order, {
        _id: "order-db-id",
        amount: 75,
        currency: "CAD",
        orderId: "lh-sq-local",
        purpose: "appointment_full",
      });
      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 7500, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_123", source: "return" });

  assert.equal(result.status, "booked");
  assert.equal(result.bookingFinalizationStatus, "booked");
  assert.deepEqual(operationOrder, [
    "paid-calendar-pending",
    "booking-finalized",
    "square-event-processed",
  ]);
});

test("Square finalizer surfaces paid unbookable rebooking status from booking finalization", async () => {
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {},
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => ({
      ok: false,
      error: "The selected appointment time became unavailable after payment.",
      status: "paid_unbookable_rebooking_pending",
    }),
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_123",
            order_id: "order_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_123", source: "return" });

  assert.equal(result.status, "paid_calendar_pending");
  assert.equal(
    result.bookingFinalizationStatus,
    "paid_unbookable_rebooking_pending",
  );
});

test("Square finalizer treats mock delayed capture APPROVED payments as paid under current rules", async () => {
  const store = createPaymentMockStore({
    now: new Date("2026-05-23T12:00:00.000Z"),
  });
  const client = createMockSquareClient({ scenario: "delayed_capture", store });
  const created = await client.createPaymentLink({
    idempotency_key: "delayed-capture-idempotency",
    order: {
      location_id: "loc_123",
      line_items: [
        {
          name: "Classic Fill deposit",
          quantity: "1",
          base_price_money: { amount: 5000, currency: "CAD" },
        },
      ],
      reference_id: "lh-sq-local",
    },
  });
  const operationOrder: string[] = [];
  const recordedEvents: Array<{ providerStatus?: string; status?: string }> =
    [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: created.payment_link.order_id ?? null,
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedEvents.push({
        providerStatus: input.providerStatus,
        status: input.status,
      });
      operationOrder.push("square-event-processed");
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar(input) {
      assert.equal(input.payment.status, "APPROVED");
      operationOrder.push("paid-calendar-pending");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async (input) => {
      assert.equal(input.transactionId, "mock-square-payment-1");
      assert.equal(input.order.orderId, "lh-sq-local");
      operationOrder.push("booking-finalized");
      return { ok: true, eventId: "calendar-event-1", status: "booked" };
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => client,
  });

  const result = await finalizer({
    paymentId: "mock-square-payment-1",
    source: "return",
  });

  assert.equal(result.status, "booked");
  assert.equal(result.bookingFinalizationStatus, "booked");
  assert.deepEqual(operationOrder, [
    "paid-calendar-pending",
    "booking-finalized",
    "square-event-processed",
  ]);
  assert.deepEqual(recordedEvents, [
    { providerStatus: "APPROVED", status: "paid_calendar_pending" },
  ]);
});

test("Square finalizer reconciles taxed service booking amount and keeps tip separate", async () => {
  let paidTransitionTipAmount: number | undefined;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar(input) {
      paidTransitionTipAmount = input.tipAmountCents;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => ({
      ok: true,
      eventId: "calendar-event-1",
      status: "booked",
    }),
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5650, currency: "CAD" },
            id: "pay_taxed_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
            tip_money: { amount: 1500, currency: "CAD" },
            total_money: { amount: 7150, currency: "CAD" },
          },
        };
      },
    }),
  });

  const result = await finalizer({
    paymentId: "pay_taxed_123",
    source: "return",
  });

  assert.equal(result.status, "booked");
  assert.equal(result.finalized, true);
  assert.equal(paidTransitionTipAmount, 1500);
});

test("Square finalizer rejects no-tax payment amount for a taxed service booking order", async () => {
  const recordedStatuses: Array<string | undefined> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedStatuses.push(input.status);
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("No-tax mismatch must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("No-tax mismatch must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_no_tax_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({
    paymentId: "pay_no_tax_123",
    source: "return",
  });

  assert.equal(result.status, "ignored");
  assert.equal(
    result.reason,
    "Square payment amount or currency did not match local order",
  );
  assert.ok(recordedStatuses.includes("amount_or_currency_mismatch"));
});

test("Square finalizer rejects paid payment when amount_money is missing even if total_money matches", async () => {
  const recordedEvents: Array<{
    amountCents?: number;
    currency?: string;
    status?: string;
  }> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedEvents.push({
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
      });
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Missing amount_money must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Missing amount_money must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            id: "pay_missing_amount_123",
            order_id: "order_123",
            status: "COMPLETED",
            tip_money: { amount: 1500, currency: "CAD" },
            total_money: { amount: 5000, currency: "CAD" },
          },
        };
      },
    }),
  });

  const result = await finalizer({
    paymentId: "pay_missing_amount_123",
    source: "return",
  });

  assert.equal(result.status, "ignored");
  assert.equal(result.finalized, false);
  assert.equal(
    result.reason,
    "Square payment amount or currency did not match local order",
  );
  assert.deepEqual(recordedEvents, [
    {
      amountCents: undefined,
      currency: undefined,
      status: "amount_or_currency_mismatch",
    },
  ]);
});

test("Square finalizer does not persist pending verification for missing local-looking order IDs", async () => {
  const calledSquareOrderIds: string[] = [];
  const recordedEvents: Array<{
    orderId?: string;
    processingStatus: string;
    status: string;
  }> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder(input) {
      if (input.localOrderId === "lh-sq-missing") {
        return null;
      }

      return null;
    },
    async recordSquareEvent(input) {
      recordedEvents.push({
        orderId: input.orderId,
        processingStatus: input.processingStatus,
        status: input.status ?? "unknown",
      });

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Missing local order must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Missing local order must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder(orderId) {
        calledSquareOrderIds.push(orderId);

        if (orderId.startsWith("lh-sq-")) {
          throw new Error("Square getOrder must not receive a local order ID");
        }

        return { order: { id: orderId } };
      },
      async getPayment() {
        throw new Error("Payment lookup must not occur without a payment ID");
      },
    }),
  });

  const result = await finalizer({
    orderId: "lh-sq-missing",
    source: "return",
  });

  assert.equal(
    calledSquareOrderIds.some((id) => id.startsWith("lh-sq-")),
    false,
  );
  assert.notEqual(result.status, "pending_verification");
  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(result.reason, "Square payment could not be resolved");
  assert.equal(
    recordedEvents.some((event) => event.status === "pending_verification"),
    false,
  );
});

test("Square finalizer returns pending verification for local order IDs without payment IDs", async () => {
  const calledSquareOrderIds: string[] = [];
  const recordedEvents: Array<{
    orderId?: string;
    processingStatus: string;
    status: string;
  }> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder(input) {
      if (input.localOrderId === "lh-sq-local") {
        return {
          amountCents: 5000,
          id: "order-db-id",
          orderId: "lh-sq-local",
          providerOrderId: "square-order-123",
          providerPaymentId: null,
          purpose: "appointment_deposit",
          squareLocationId: "loc_123",
          status: "pending",
        };
      }

      return null;
    },
    async recordSquareEvent(input) {
      recordedEvents.push({
        orderId: input.orderId,
        processingStatus: input.processingStatus,
        status: input.status ?? "unknown",
      });

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Unresolved local order must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Unresolved local order must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder(orderId) {
        calledSquareOrderIds.push(orderId);

        if (orderId === "lh-sq-local") {
          throw new Error("Square getOrder must not receive a local order ID");
        }

        return { order: { id: orderId } };
      },
      async getPayment() {
        throw new Error("Payment lookup must not occur without a payment ID");
      },
    }),
  });

  const result = await finalizer({ orderId: "lh-sq-local", source: "return" });

  assert.equal(calledSquareOrderIds.includes("lh-sq-local"), false);
  assert.equal(result.finalized, false);
  assert.equal(result.status, "pending_verification");
  assert.deepEqual(recordedEvents, [
    {
      orderId: "lh-sq-local",
      processingStatus: "ignored",
      status: "pending_verification",
    },
  ]);
});

test("Square finalizer deduplicates eventless pending verification records by deterministic idempotency key", async () => {
  const insertedEventInputs: unknown[] = [];
  let insertDuplicateCount = 0;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder(input) {
      if (input.localOrderId === "lh-sq-local") {
        return {
          amountCents: 5000,
          id: "order-db-id",
          orderId: "lh-sq-local",
          providerOrderId: "square-order-123",
          providerPaymentId: null,
          purpose: "appointment_deposit",
          squareLocationId: "loc_123",
          status: "pending",
        };
      }

      return null;
    },
    async recordSquareEvent(input) {
      insertedEventInputs.push(input);

      if (input.idempotencyKey === undefined) {
        return { duplicate: false };
      }

      if (
        insertedEventInputs.filter(
          (i) =>
            (i as SquareEventRecordInput).idempotencyKey ===
            input.idempotencyKey,
        ).length > 1
      ) {
        insertDuplicateCount += 1;
        return { duplicate: true };
      }

      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Unresolved local order must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Unresolved local order must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Square getOrder must not receive a local order ID");
      },
      async getPayment() {
        throw new Error("Payment lookup must not occur without a payment ID");
      },
    }),
  });

  const firstResult = await finalizer({
    orderId: "lh-sq-local",
    source: "return",
  });
  const secondResult = await finalizer({
    orderId: "lh-sq-local",
    source: "return",
  });

  assert.equal(firstResult.status, "pending_verification");
  assert.equal(secondResult.status, "pending_verification");
  assert.equal(insertedEventInputs.length, 2);
  assert.equal(insertDuplicateCount, 1);
  assert.equal(
    (insertedEventInputs[0] as SquareEventRecordInput).idempotencyKey,
    "square:return:pending_verification:287c1475c915572e42e9984d1cf15978",
  );
});

test("Square finalizer reconciles taxed service booking amount and keeps tip separate", async () => {
  let paidTransitionTipAmount: number | undefined;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar(input) {
      paidTransitionTipAmount = input.tipAmountCents;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => ({ ok: true, eventId: "calendar-event-1", status: "booked" }),
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5650, currency: "CAD" },
            id: "pay_taxed_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
            tip_money: { amount: 1500, currency: "CAD" },
            total_money: { amount: 7150, currency: "CAD" },
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_taxed_123", source: "return" });

  assert.equal(result.status, "booked");
  assert.equal(result.finalized, true);
  assert.equal(paidTransitionTipAmount, 1500);
});

test("Square finalizer rejects no-tax payment amount for a taxed service booking order", async () => {
  const recordedStatuses: Array<string | undefined> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedStatuses.push(input.status);
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("No-tax mismatch must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("No-tax mismatch must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_no_tax_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_no_tax_123", source: "return" });

  assert.equal(result.status, "ignored");
  assert.equal(result.reason, "Square payment amount or currency did not match local order");
  assert.ok(recordedStatuses.includes("amount_or_currency_mismatch"));
});

test("Square finalizer rejects paid payment when amount_money is missing even if total_money matches", async () => {
  const recordedEvents: Array<{ amountCents?: number; currency?: string; status?: string }> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5000,
        id: "order-db-id",
        orderId: "lh-sq-local",
        providerOrderId: "order_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedEvents.push({
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
      });
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("Missing amount_money must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("Missing amount_money must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            id: "pay_missing_amount_123",
            order_id: "order_123",
            status: "COMPLETED",
            tip_money: { amount: 1500, currency: "CAD" },
            total_money: { amount: 5000, currency: "CAD" },
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_missing_amount_123", source: "return" });

  assert.equal(result.status, "ignored");
  assert.equal(result.finalized, false);
  assert.equal(result.reason, "Square payment amount or currency did not match local order");
  assert.deepEqual(recordedEvents, [
    {
      amountCents: undefined,
      currency: undefined,
      status: "amount_or_currency_mismatch",
    },
  ]);
});

test("Square finalizer records mock Square amount and currency mismatches as ignored failures", async () => {
  const mismatchCases = [
    {
      amountCents: 4900,
      currency: "CAD",
      expectedAmount: 4900,
      expectedCurrency: "CAD",
    },
    {
      amountCents: 5000,
      currency: "USD",
      expectedAmount: 5000,
      expectedCurrency: "USD",
    },
  ];

  for (const mismatchCase of mismatchCases) {
    const store = createPaymentMockStore({
      now: new Date("2026-05-23T12:00:00.000Z"),
    });
    const client = createMockSquareClient({
      amountCents: mismatchCase.amountCents,
      currency: mismatchCase.currency,
      scenario: "success",
      store,
    });
    const created = await client.createPaymentLink({
      idempotency_key: `idempotency-${mismatchCase.currency}-${mismatchCase.amountCents}`,
      order: {
        location_id: "loc_123",
        line_items: [
          {
            name: "Classic Fill deposit",
            quantity: "1",
            base_price_money: { amount: 5000, currency: "CAD" },
          },
        ],
        reference_id: "lh-sq-local",
      },
    });
    const recordedEvents: Array<{
      amountCents?: number;
      currency?: string;
      status?: string;
    }> = [];
    const repository: SquarePaymentFinalizerRepository = {
      async claimSquareEvent() {
        return { duplicate: false };
      },
      async findSquareOrder() {
        return {
          amountCents: 5000,
          id: "order-db-id",
          orderId: "lh-sq-local",
          providerOrderId: created.payment_link.order_id ?? null,
          providerPaymentId: null,
          purpose: "appointment_deposit",
          squareLocationId: "loc_123",
          status: "pending",
        };
      },
      async recordSquareEvent(input) {
        recordedEvents.push({
          amountCents: input.amountCents,
          currency: input.currency,
          status: input.status,
        });
        return { duplicate: false };
      },
      async recordSquarePaymentPendingCalendar() {
        throw new Error(
          "Mismatched Square payments must not be persisted as paid",
        );
      },
    };
    const finalizer = createSquarePaymentFinalizer({
      finalizeAppointmentPaymentForOrder: async () => {
        throw new Error(
          "Mismatched Square payments must not finalize bookings",
        );
      },
      getEnv: createEnv,
      repository,
      sendBookingConfirmationEmailForOrder: async () => {},
      squareClientFactory: () => client,
    });

    const result = await finalizer({
      paymentId: "mock-square-payment-1",
      source: "return",
    });

    assert.equal(result.status, "ignored");
    assert.equal(
      result.reason,
      "Square payment amount or currency did not match local order",
    );
    assert.deepEqual(recordedEvents, [
      {
        amountCents: mismatchCase.expectedAmount,
        currency: mismatchCase.expectedCurrency,
        status: "amount_or_currency_mismatch",
      },
    ]);
  }
});
