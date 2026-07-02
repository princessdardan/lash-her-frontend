import assert from "node:assert/strict";
import test from "node:test";

import {
  parseVerifiedSquareWebhook,
  type VerifiedSquareWebhookEvent,
} from "@/lib/booking/square-webhook";
import type {
  NoShowChargeRecordDetail,
  NoShowInvoiceRepository,
} from "./service-no-show-invoice";

import {
  finalizeNoShowCharge,
  type NoShowChargeFinalizerRepository,
  type NoShowChargeProviderReader,
} from "./service-no-show-charge-finalizer";
import { createServicePaymentAlertLogger } from "./service-payment-alerts";

const now = new Date("2026-06-20T12:00:00.000Z");

function makeRecord(
  overrides: Partial<NoShowChargeRecordDetail> = {},
): NoShowChargeRecordDetail {
  return {
    id: "noshow-record-1",
    status: "charge_pending",
    maxChargeCents: 10000,
    currency: "CAD",
    squareInvoiceId: "sq-invoice-1",
    squareOrderId: "sq-order-1",
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<VerifiedSquareWebhookEvent> = {},
): VerifiedSquareWebhookEvent {
  return {
    eventId: "evt-1",
    eventType: "invoice.payment_made",
    payloadSanitized: {
      event_id: "evt-1",
      type: "invoice.payment_made",
      data: {
        id: "sq-invoice-1",
        object: {
          invoice: { id: "sq-invoice-1" },
          payment: { id: "sq-payment-1" },
        },
      },
    },
    ...overrides,
  };
}

interface TestNoShowRepository
  extends
    NoShowChargeFinalizerRepository,
    Pick<NoShowInvoiceRepository, "updateNoShowChargeRecord"> {
  readonly events: unknown[];
  readonly finalizations: unknown[];
  readonly stored: NoShowChargeRecordDetail | null;
  readonly updates: unknown[];
}

function makeRepository(
  record: NoShowChargeRecordDetail | null,
  overrides: Partial<TestNoShowRepository> = {},
): TestNoShowRepository {
  let stored: NoShowChargeRecordDetail | null = record;
  const events: unknown[] = [];
  const finalizations: unknown[] = [];
  const updates: unknown[] = [];

  return {
    async findNoShowChargeRecordBySquareInvoiceId() {
      return stored;
    },
    async findNoShowChargeRecordBySquareOrderId() {
      return stored;
    },
    async findNoShowChargeRecordBySquarePaymentId() {
      return stored;
    },
    async findNoShowChargeEventByProviderEventId() {
      return null;
    },
    async updateNoShowChargeRecord(input) {
      updates.push(input);
      if (stored === null) {
        throw new Error("No-show charge record not found");
      }
      stored = {
        ...stored,
        status: input.status ?? stored.status,
        squarePaymentId: input.squarePaymentId ?? stored.squarePaymentId,
        providerStatus: input.providerStatus ?? stored.providerStatus,
        providerFailureReason:
          input.providerFailureReason ?? stored.providerFailureReason,
      };
      return { id: stored.id, status: stored.status };
    },
    async finalizeNoShowChargeRecord(input) {
      if (stored === null) {
        throw new Error("No-show charge record not found");
      }
      // Atomic compare-and-set guard: never overwrite a terminal row.
      if (stored.status === "charged" || stored.status === "charge_failed") {
        throw new Error("No-show charge record is already terminal");
      }

      finalizations.push(input);
      updates.push({
        noShowChargeRecordId: input.noShowChargeRecordId,
        status: input.status,
        squarePaymentId: input.squarePaymentId,
        providerStatus: input.providerStatus,
        providerFailureReason: input.providerFailureReason,
        providerMetadata: input.providerMetadata,
        chargedAt: input.chargedAt,
      });
      events.push({
        eventId: input.event.eventId,
        eventType: input.event.eventType,
        noShowChargeRecordId: input.noShowChargeRecordId,
        status: input.event.status,
        providerPaymentId: input.event.providerPaymentId,
        providerInvoiceId: input.event.providerInvoiceId,
        providerOrderId: input.event.providerOrderId,
        payloadSanitized: input.event.payloadSanitized,
        processedAt: input.event.processedAt,
        processingStatus: input.event.processingStatus,
      });
      stored = {
        ...stored,
        status: input.status ?? stored.status,
        squarePaymentId: input.squarePaymentId ?? stored.squarePaymentId,
        providerStatus: input.providerStatus ?? stored.providerStatus,
        providerFailureReason:
          input.providerFailureReason ?? stored.providerFailureReason,
      };
    },
    async recordNoShowChargeWebhookEvent(input) {
      events.push(input);
    },
    get stored() {
      return stored;
    },
    get events() {
      return events;
    },
    get finalizations() {
      return finalizations;
    },
    get updates() {
      return updates;
    },
    ...overrides,
  };
}

function makeAlerts() {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logWarn: (...args: unknown[]) => calls.push(args),
    logError: (...args: unknown[]) => calls.push(args),
  });
  return { alerts, calls };
}

interface MockProviderReader {
  getInvoice(
    invoiceId: string,
  ): Promise<{
    invoice: { id: string; status: string; order_id: string; version: number };
  }>;
  getPayment(paymentId: string): Promise<{
    payment: {
      id: string;
      status?: string;
      amount_money?: { amount?: number; currency?: string };
      customer_id?: string;
      source_type?: string;
      card_details?: { card?: { id: string } };
      order_id?: string;
    };
  }>;
}

function makeProviderReader(
  overrides: Partial<MockProviderReader> = {},
): NoShowChargeProviderReader {
  return {
    async getInvoice() {
      return {
        invoice: {
          id: "sq-invoice-1",
          status: "PAID",
          order_id: "sq-order-1",
          version: 2,
        },
      };
    },
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
    ...overrides,
  } as unknown as NoShowChargeProviderReader;
}

function matchingProviderReader(
  record: NoShowChargeRecordDetail | null,
): NoShowChargeProviderReader {
  if (record === null) {
    return makeProviderReader();
  }

  return makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: {
            amount: record.maxChargeCents,
            currency: record.currency,
          },
          customer_id: record.squareCustomerId,
          source_type: record.squareCardId ? "CARD" : undefined,
          card_details: record.squareCardId
            ? { card: { id: record.squareCardId } }
            : undefined,
          order_id: record.squareOrderId,
        },
      };
    },
  });
}

test("invoice paid maps to local no-show record by squareInvoiceId and marks charged", async () => {
  const record = makeRecord({ status: "charge_pending" });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();
  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    { event: makeEvent({ paymentId: "sq-payment-1" }) },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.duplicateEvent, false);
  assert.equal(result.retryable, false);
  assert.equal(result.status, "charged");
  assert.equal(result.noShowChargeRecordId, "noshow-record-1");
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.events.length, 1);
  assert.equal(calls.length, 0);
});

test("payment made maps to local no-show record by squarePaymentId and marks charged", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-payment-made",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-payment-made",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: makeProviderReader({
        async getPayment() {
          return {
            payment: {
              id: "sq-payment-1",
              status: "COMPLETED",
              amount_money: { amount: 10000, currency: "CAD" },
              order_id: "sq-order-1",
            },
          };
        },
      }),
    },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-1");
  assert.equal(calls.length, 0);
});

test("payment created resolves by squareOrderId when squarePaymentId is not yet known", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareInvoiceId: undefined,
    squareOrderId: "sq-order-1",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquarePaymentId() {
      return null;
    },
    async findNoShowChargeRecordBySquareOrderId() {
      return record;
    },
  });
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-payment-created-order",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-payment-created-order",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: matchingProviderReader(record),
    },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(result.noShowChargeRecordId, record.id);
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-1");
  assert.equal(calls.length, 0);
});

test("payment updated resolves by squareOrderId when squarePaymentId is not yet known", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareInvoiceId: undefined,
    squareOrderId: "sq-order-1",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquarePaymentId() {
      return null;
    },
    async findNoShowChargeRecordBySquareOrderId() {
      return record;
    },
  });
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-payment-updated-order",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-payment-updated-order",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: matchingProviderReader(record),
    },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(result.noShowChargeRecordId, record.id);
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-1");
  assert.equal(calls.length, 0);
});

test("payment failed maps to charge_failed and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: {
            amount: record.maxChargeCents,
            currency: record.currency,
          },
          order_id: record.squareOrderId,
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-payment-failed",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-payment-failed",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charge_failed");
  assert.equal(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 1);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "no_show_charge_failed");
  assert.equal(payload.severity, "warning");
});

test("finalizer uses atomic repository method for charged outcome", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareOrderId: "sq-order-atomic",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-atomic",
        eventType: "payment.created",
        paymentId: "sq-payment-atomic",
        orderId: "sq-order-atomic",
        payloadSanitized: {
          event_id: "evt-atomic",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-atomic",
                order_id: "sq-order-atomic",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: makeProviderReader({
        async getPayment() {
          return {
            payment: {
              id: "sq-payment-atomic",
              status: "COMPLETED",
              amount_money: { amount: 10000, currency: "CAD" },
              order_id: "sq-order-atomic",
            },
          };
        },
      }),
    },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(repo.finalizations.length, 1);
  const finalization = repo.finalizations[0] as {
    noShowChargeRecordId: string;
    status: string;
    squarePaymentId?: string;
    event: { eventId: string; status: string; providerOrderId?: string };
  };
  assert.equal(finalization.noShowChargeRecordId, record.id);
  assert.equal(finalization.status, "charged");
  assert.equal(finalization.squarePaymentId, "sq-payment-atomic");
  assert.equal(finalization.event.eventId, "evt-atomic");
  assert.equal(finalization.event.status, "charged");
  assert.equal(finalization.event.providerOrderId, "sq-order-atomic");
  assert.equal(repo.updates.length, 1);
  assert.equal(repo.events.length, 1);
  assert.equal(calls.length, 0);
});

test("atomic finalization failure does not leave separate update or event", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareOrderId: "sq-order-atomic-fail",
  });
  let callCount = 0;
  const repo = makeRepository(record, {
    async finalizeNoShowChargeRecord() {
      callCount++;
      throw new Error("atomic finalize failed");
    },
  });
  const { alerts } = makeAlerts();

  await assert.rejects(
    () =>
      finalizeNoShowCharge(
        {
          event: makeEvent({
            eventId: "evt-atomic-fail",
            eventType: "payment.created",
            paymentId: "sq-payment-atomic-fail",
            orderId: "sq-order-atomic-fail",
            payloadSanitized: {
              event_id: "evt-atomic-fail",
              type: "payment.created",
              data: {
                object: {
                  payment: {
                    id: "sq-payment-atomic-fail",
                    order_id: "sq-order-atomic-fail",
                    status: "COMPLETED",
                  },
                },
              },
            },
          }),
        },
        {
          repository: repo,
          alerts,
          now,
          providerReader: makeProviderReader({
            async getPayment() {
              return {
                payment: {
                  id: "sq-payment-atomic-fail",
                  status: "COMPLETED",
                  amount_money: { amount: 10000, currency: "CAD" },
                  order_id: "sq-order-atomic-fail",
                },
              };
            },
          }),
        },
      ),
    /atomic finalize failed/,
  );

  assert.equal(callCount, 1);
  assert.equal(repo.updates.length, 0);
  assert.equal(repo.events.length, 0);
  assert.equal(repo.finalizations.length, 0);
});

test("unknown invoice/payment records sanitized event as ignored and alerts warning", async () => {
  const repo = makeRepository(null);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-unknown",
        payloadSanitized: {
          event_id: "evt-unknown",
          type: "invoice.payment_made",
          data: { id: "unknown-invoice" },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader: makeProviderReader() },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.duplicateEvent, false);
  assert.equal(result.retryable, false);
  assert.equal(result.status, "ignored");
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "no_show_charge_unknown_provider_event");
  assert.equal(payload.severity, "warning");
});

test("duplicate webhook event is idempotent", async () => {
  const record = makeRecord({
    status: "charged",
    squarePaymentId: "sq-payment-1",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeEventByProviderEventId() {
      return { noShowChargeRecordId: record.id, processingStatus: "processed" };
    },
  });
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    { event: makeEvent({ eventId: "evt-duplicate" }) },
    { repository: repo, alerts, now, providerReader: makeProviderReader() },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.duplicateEvent, true);
  assert.equal(result.status, "duplicate");
  assert.equal(result.noShowChargeRecordId, record.id);
  assert.equal(repo.updates.length, 0);
  assert.equal(calls.length, 0);
});

test("retryable DB lookup failures are surfaced as thrown errors", async () => {
  const repo = makeRepository(null, {
    async findNoShowChargeRecordBySquareInvoiceId() {
      throw new Error("database unavailable");
    },
  });
  const { alerts } = makeAlerts();

  await assert.rejects(
    () =>
      finalizeNoShowCharge(
        { event: makeEvent() },
        { repository: repo, alerts, now, providerReader: makeProviderReader() },
      ),
    /database unavailable/,
  );
});

test("invoice payment_made with mismatched amount is ignored and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-mismatch-amount",
        paymentId: "sq-payment-1",
        payloadSanitized: {
          event_id: "evt-mismatch-amount",
          type: "invoice.payment_made",
          data: {
            id: "sq-invoice-1",
            object: {
              invoice: { id: "sq-invoice-1" },
              payment: {
                id: "sq-payment-1",
                amount_money: { amount: 12000, currency: "CAD" },
                customer_id: "cust-1",
                card_details: { card: { id: "ccof-1" } },
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: makeProviderReader({
        async getPayment() {
          return {
            payment: {
              id: "sq-payment-1",
              status: "COMPLETED",
              amount_money: { amount: 12000, currency: "CAD" },
              customer_id: "cust-1",
              source_type: "CARD",
              card_details: { card: { id: "ccof-1" } },
              order_id: "sq-order-1",
            },
          };
        },
      }),
    },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "amount_mismatch");
});

test("payment completed with matching amount currency customer and card marks charged", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-match-payment",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-match-payment",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
                amount_money: { amount: 12500, currency: "CAD" },
                customer_id: "cust-1",
                card_details: { card: { id: "ccof-1" } },
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: matchingProviderReader(record),
    },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(calls.length, 0);
});

test("payment completed with mismatched currency is ignored and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    currency: "CAD",
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-mismatch-currency",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-mismatch-currency",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
                amount_money: { amount: 12500, currency: "USD" },
                customer_id: "cust-1",
                card_details: { card: { id: "ccof-1" } },
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: makeProviderReader({
        async getPayment() {
          return {
            payment: {
              id: "sq-payment-1",
              status: "COMPLETED",
              amount_money: { amount: 12500, currency: "USD" },
              customer_id: "cust-1",
              source_type: "CARD",
              card_details: { card: { id: "ccof-1" } },
              order_id: "sq-order-1",
            },
          };
        },
      }),
    },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "currency_mismatch");
});

test("payment completed with mismatched customer is ignored and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-mismatch-customer",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-mismatch-customer",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
                amount_money: { amount: 12500, currency: "CAD" },
                customer_id: "cust-2",
                card_details: { card: { id: "ccof-1" } },
              },
            },
          },
        },
      }),
    },
    {
      repository: repo,
      alerts,
      now,
      providerReader: makeProviderReader({
        async getPayment() {
          return {
            payment: {
              id: "sq-payment-1",
              status: "COMPLETED",
              amount_money: { amount: 12500, currency: "CAD" },
              customer_id: "cust-2",
              source_type: "CARD",
              card_details: { card: { id: "ccof-1" } },
              order_id: "sq-order-1",
            },
          };
        },
      }),
    },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "customer_mismatch");
});

test("payment completed with mismatched card is ignored and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-2" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-mismatch-card",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-mismatch-card",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
                amount_money: { amount: 12500, currency: "CAD" },
                customer_id: "cust-1",
                card_details: { card: { id: "ccof-2" } },
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "card_mismatch");
});

test("invoice paid with sanitized webhook payload detects card mismatch from fetched payment facts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const rawPayload = JSON.stringify({
    event_id: "evt-sanitized-card",
    type: "invoice.payment_made",
    data: {
      id: "sq-invoice-1",
      object: {
        invoice: { id: "sq-invoice-1" },
        payment: {
          id: "sq-payment-1",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          card_details: { card: { id: "ccof-1" } },
        },
      },
    },
  });
  const event = parseVerifiedSquareWebhook(rawPayload);

  const sanitizedPayment = (
    event.payloadSanitized.data as {
      object?: { payment?: { card_details?: unknown } };
    }
  )?.object?.payment;
  assert.equal(sanitizedPayment?.card_details, "[redacted]");

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-2" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    { event },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "card_mismatch");
});

test("success finalization requires amount from fetched payment facts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-missing-amount",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-missing-amount",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "missing_amount");
});

test("success finalization requires currency from fetched payment facts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000 },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-missing-currency",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-missing-currency",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "missing_currency");
});

test("success finalization requires customer from fetched payment facts when local record has a customer", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squareCustomerId: "cust-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-missing-customer",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-missing-customer",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "missing_customer");
});

test("success finalization requires card from fetched payment facts when local record has a card", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          source_type: "CARD",
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-missing-card",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-missing-card",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "missing_card");
});

test("payment ID mismatch does not finalize or overwrite local squarePaymentId", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: "sq-payment-original",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-payment-mismatch",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-payment-mismatch",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-original");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "payment_id_mismatch");
});

test("order ID mismatch does not finalize or overwrite local squarePaymentId", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareOrderId: "sq-order-local",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquareInvoiceId() {
      return null;
    },
    async findNoShowChargeRecordBySquarePaymentId() {
      return null;
    },
  });
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-different",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-order-mismatch",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-different",
        payloadSanitized: {
          event_id: "evt-order-mismatch",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-different",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.stored?.squarePaymentId, undefined);
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "order_id_mismatch");
});

test("invoice ID mismatch does not finalize or overwrite local squarePaymentId", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squareInvoiceId: "sq-invoice-local",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquareInvoiceId() {
      return record;
    },
  });
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getInvoice() {
      return {
        invoice: {
          id: "sq-invoice-1",
          status: "PAID",
          order_id: "sq-order-1",
          version: 2,
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    { event: makeEvent({ eventId: "evt-invoice-mismatch" }) },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.stored?.squarePaymentId, undefined);
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "invoice_id_mismatch");
});

test("failed payment with mismatched order ID does not mark record charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareOrderId: "sq-order-local",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquareInvoiceId() {
      return null;
    },
    async findNoShowChargeRecordBySquarePaymentId() {
      return null;
    },
  });
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-different",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-failed-mismatch",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-different",
        payloadSanitized: {
          event_id: "evt-failed-mismatch",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-different",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "order_id_mismatch");
});

test("payment completed with matching fetched provider facts marks charged", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-match-fetched",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-match-fetched",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-1");
  assert.equal(calls.length, 0);
});

test("webhook COMPLETED with provider PENDING does not finalize charged", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "PENDING",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-webhook-completed-provider-pending",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-webhook-completed-provider-pending",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charged");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "provider_status_not_successful");
});

test("webhook FAILED with provider COMPLETED does not finalize charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-webhook-failed-provider-completed",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-webhook-failed-provider-completed",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "provider_status_not_failed");
});

test("webhook CANCELED with provider PENDING does not finalize charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-canceled",
          status: "PENDING",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-webhook-canceled-provider-pending",
        eventType: "payment.updated",
        paymentId: "sq-payment-canceled",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-webhook-canceled-provider-pending",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-canceled",
                order_id: "sq-order-1",
                status: "CANCELED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "provider_status_not_failed");
});

test("failed event with same order but mismatched customer does not finalize charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-attacker",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-failed-mismatched-customer",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-failed-mismatched-customer",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "customer_mismatch");
});

test("failed event with same order but mismatched card does not finalize charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-attacker" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-failed-mismatched-card",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-failed-mismatched-card",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "card_mismatch");
});

test("failed event with matching provider facts finalizes charge_failed", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-failed-matching",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-failed-matching",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charge_failed");
  assert.equal(repo.stored?.status, "charge_failed");
  assert.equal(repo.finalizations.length, 1);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
  };
  assert.equal(payload.category, "no_show_charge_failed");
  assert.equal(payload.severity, "warning");
});

test("incoming failed webhook does not overwrite already-charged terminal record", async () => {
  const record = makeRecord({
    status: "charged",
    squarePaymentId: "sq-payment-1",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-failed",
          status: "FAILED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-charged-to-failed",
        eventType: "payment.updated",
        paymentId: "sq-payment-failed",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-charged-to-failed",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-failed",
                order_id: "sq-order-1",
                status: "FAILED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-1");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "terminal_status_conflict");
});

test("incoming paid webhook does not overwrite already-failed terminal record", async () => {
  const record = makeRecord({
    status: "charge_failed",
    squarePaymentId: "sq-payment-failed",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-failed-to-charged",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-failed-to-charged",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.stored?.status, "charge_failed");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-failed");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "terminal_status_conflict");
});

test("invoice payment_made with non-paid fetched invoice status is ignored and alerts", async () => {
  const record = makeRecord({
    status: "charge_pending",
    maxChargeCents: 12500,
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getInvoice() {
      return {
        invoice: {
          id: "sq-invoice-1",
          status: "CANCELED",
          order_id: "sq-order-1",
          version: 2,
        },
      };
    },
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          status: "COMPLETED",
          amount_money: { amount: 12500, currency: "CAD" },
          customer_id: "cust-1",
          source_type: "CARD",
          card_details: { card: { id: "ccof-1" } },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-invoice-non-paid",
        paymentId: "sq-payment-1",
        payloadSanitized: {
          event_id: "evt-invoice-non-paid",
          type: "invoice.payment_made",
          data: {
            id: "sq-invoice-1",
            object: {
              invoice: { id: "sq-invoice-1" },
              payment: { id: "sq-payment-1" },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.notEqual(repo.stored?.status, "charged");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.severity, "error");
  assert.equal(payload.context.reason, "invoice_status_not_paid");
});

test("success finalization requires authoritative fetched payment status", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-1",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-missing-fetched-status",
        eventType: "payment.created",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-missing-fetched-status",
          type: "payment.created",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "missing_provider_status");
});

test("fetched payment id mismatch with webhook payment id does not finalize", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record);
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getPayment() {
      return {
        payment: {
          id: "sq-payment-fetched-different",
          status: "COMPLETED",
          amount_money: { amount: 10000, currency: "CAD" },
          order_id: "sq-order-1",
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-fetched-payment-mismatch",
        eventType: "payment.updated",
        paymentId: "sq-payment-1",
        orderId: "sq-order-1",
        payloadSanitized: {
          event_id: "evt-fetched-payment-mismatch",
          type: "payment.updated",
          data: {
            object: {
              payment: {
                id: "sq-payment-1",
                order_id: "sq-order-1",
                status: "COMPLETED",
              },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "payment_id_mismatch");
});

test("fetched invoice id mismatch with webhook invoice id does not finalize", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squareInvoiceId: "sq-invoice-1",
    squarePaymentId: undefined,
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquareInvoiceId() {
      return record;
    },
  });
  const { alerts, calls } = makeAlerts();

  const providerReader = makeProviderReader({
    async getInvoice() {
      return {
        invoice: {
          id: "sq-invoice-fetched-different",
          status: "PAID",
          order_id: "sq-order-1",
          version: 2,
        },
      };
    },
  });

  const result = await finalizeNoShowCharge(
    {
      event: makeEvent({
        eventId: "evt-fetched-invoice-mismatch",
        paymentId: "sq-payment-1",
        payloadSanitized: {
          event_id: "evt-fetched-invoice-mismatch",
          type: "invoice.payment_made",
          data: {
            id: "sq-invoice-1",
            object: {
              invoice: { id: "sq-invoice-1" },
              payment: { id: "sq-payment-1" },
            },
          },
        },
      }),
    },
    { repository: repo, alerts, now, providerReader },
  );

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(repo.finalizations.length, 0);
  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    category: string;
    severity: string;
    context: { reason: string };
  };
  assert.equal(payload.category, "no_show_charge_provider_mismatch");
  assert.equal(payload.context.reason, "invoice_id_mismatch");
});

test("finalizer fails closed when record becomes terminal between read and atomic write", async () => {
  const record = makeRecord({
    status: "charge_pending",
    squarePaymentId: undefined,
    squareOrderId: "sq-order-race",
  });
  const repo = makeRepository(record, {
    async findNoShowChargeRecordBySquarePaymentId() {
      // Simulate the pre-check view: the record was pending when we read it.
      return { ...record, status: "charge_pending" };
    },
    async findNoShowChargeRecordBySquareOrderId() {
      return { ...record, status: "charge_pending" };
    },
  });
  const { alerts } = makeAlerts();

  // Simulate a concurrent finalization that made the stored row terminal.
  await repo.updateNoShowChargeRecord({
    noShowChargeRecordId: record.id,
    status: "charged",
    squarePaymentId: "sq-payment-concurrent",
  });

  await assert.rejects(
    () =>
      finalizeNoShowCharge(
        {
          event: makeEvent({
            eventId: "evt-race",
            eventType: "payment.created",
            paymentId: "sq-payment-race",
            orderId: "sq-order-race",
            payloadSanitized: {
              event_id: "evt-race",
              type: "payment.created",
              data: {
                object: {
                  payment: {
                    id: "sq-payment-race",
                    order_id: "sq-order-race",
                    status: "COMPLETED",
                  },
                },
              },
            },
          }),
        },
        {
          repository: repo,
          alerts,
          now,
          providerReader: makeProviderReader({
            async getPayment() {
              return {
                payment: {
                  id: "sq-payment-race",
                  status: "COMPLETED",
                  amount_money: { amount: 10000, currency: "CAD" },
                  order_id: "sq-order-race",
                },
              };
            },
          }),
        },
      ),
    /terminal/,
  );

  assert.equal(repo.stored?.status, "charged");
  assert.equal(repo.stored?.squarePaymentId, "sq-payment-concurrent");
  assert.equal(repo.finalizations.length, 0);
});
