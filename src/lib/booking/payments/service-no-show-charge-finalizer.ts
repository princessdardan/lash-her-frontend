import type { NoShowChargeStatus } from "@/lib/private-db/schema";

import type { SquareGetInvoiceResponse } from "@/lib/payments/square/invoice-client";
import type { SquareGetPaymentResponse } from "@/lib/payments/square/payments-client";

import type { VerifiedSquareWebhookEvent } from "../square-webhook";
import type {
  NoShowChargeRecordDetail,
  NoShowInvoiceRepository,
} from "./service-no-show-invoice";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";

export interface NoShowChargeFinalizerResult {
  duplicateEvent: boolean;
  finalized: boolean;
  noShowChargeRecordId?: string;
  retryable: boolean;
  status: "charged" | "charge_failed" | "ignored" | "duplicate";
}

export interface NoShowChargeEventRecord {
  noShowChargeRecordId: string;
  processingStatus: string;
}

export interface NoShowChargeFinalizerRepository {
  findNoShowChargeRecordBySquareInvoiceId(
    squareInvoiceId: string,
  ): Promise<NoShowChargeRecordDetail | null>;
  findNoShowChargeRecordBySquareOrderId(
    squareOrderId: string,
  ): Promise<NoShowChargeRecordDetail | null>;
  findNoShowChargeRecordBySquarePaymentId(
    squarePaymentId: string,
  ): Promise<NoShowChargeRecordDetail | null>;
  findNoShowChargeEventByProviderEventId(
    eventId: string,
  ): Promise<NoShowChargeEventRecord | null>;
  finalizeNoShowChargeRecord(input: {
    noShowChargeRecordId: string;
    status: NoShowChargeStatus;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: Record<string, unknown>;
    chargedAt?: Date;
    event: {
      eventId: string;
      eventType: string;
      status: string;
      providerPaymentId?: string;
      providerInvoiceId?: string;
      providerOrderId?: string;
      payloadSanitized: Record<string, unknown>;
      processedAt: Date;
      processingStatus: "processed" | "failed";
    };
  }): Promise<void>;
  recordNoShowChargeWebhookEvent(input: {
    eventId: string;
    eventType: string;
    noShowChargeRecordId: string;
    status: string;
    providerPaymentId?: string;
    providerInvoiceId?: string;
    providerOrderId?: string;
    payloadSanitized: Record<string, unknown>;
    processedAt: Date;
    processingStatus: "processed" | "failed" | "ignored";
  }): Promise<void>;
}

export interface NoShowChargeProviderReader {
  getInvoice(invoiceId: string): Promise<SquareGetInvoiceResponse>;
  getPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
}

export interface NoShowChargeFinalizerDependencies {
  alerts: ServicePaymentAlertLogger;
  now?: Date;
  providerReader: NoShowChargeProviderReader;
  repository: NoShowChargeFinalizerRepository &
    Pick<NoShowInvoiceRepository, "updateNoShowChargeRecord">;
}

export interface NoShowChargeFinalizerInput {
  event: VerifiedSquareWebhookEvent;
}

const NO_SHOW_CHARGE_EVENT_TYPES = [
  "invoice.payment_made",
  "payment.created",
  "payment.updated",
] as const;

export function isNoShowChargeEventType(eventType: string): boolean {
  return NO_SHOW_CHARGE_EVENT_TYPES.includes(
    eventType as (typeof NO_SHOW_CHARGE_EVENT_TYPES)[number],
  );
}

export async function finalizeNoShowCharge(
  input: NoShowChargeFinalizerInput,
  dependencies: NoShowChargeFinalizerDependencies,
): Promise<NoShowChargeFinalizerResult> {
  const { event } = input;
  const { repository, alerts } = dependencies;
  const now = dependencies.now ?? new Date();

  const existingEvent = await repository.findNoShowChargeEventByProviderEventId(
    event.eventId,
  );
  if (existingEvent !== null) {
    return {
      duplicateEvent: true,
      finalized: true,
      noShowChargeRecordId: existingEvent.noShowChargeRecordId,
      retryable: false,
      status: "duplicate",
    };
  }

  const invoiceId =
    event.eventType === "invoice.payment_made"
      ? getEventInvoiceId(event)
      : undefined;
  const paymentId = event.paymentId;

  if (invoiceId === undefined && paymentId === undefined) {
    await alertUnknownProviderEvent(alerts, event, invoiceId, paymentId);
    return {
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    };
  }

  let record: NoShowChargeRecordDetail | null = null;

  if (invoiceId !== undefined) {
    record =
      await repository.findNoShowChargeRecordBySquareInvoiceId(invoiceId);
  }

  if (record === null && paymentId !== undefined) {
    record =
      await repository.findNoShowChargeRecordBySquarePaymentId(paymentId);
  }

  if (record === null && event.orderId !== undefined) {
    record = await repository.findNoShowChargeRecordBySquareOrderId(
      event.orderId,
    );
  }

  if (record === null) {
    await alertUnknownProviderEvent(alerts, event, invoiceId, paymentId);
    return {
      duplicateEvent: false,
      finalized: false,
      retryable: false,
      status: "ignored",
    };
  }

  const outcome = resolveOutcome(event, invoiceId, paymentId);

  if (outcome.kind === "ignored") {
    await repository.recordNoShowChargeWebhookEvent({
      eventId: event.eventId,
      eventType: event.eventType,
      noShowChargeRecordId: record.id,
      status: "ignored",
      providerPaymentId: paymentId,
      providerInvoiceId: invoiceId,
      providerOrderId: event.orderId,
      payloadSanitized: event.payloadSanitized,
      processedAt: now,
      processingStatus: "ignored",
    });

    return {
      duplicateEvent: false,
      finalized: false,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "ignored",
    };
  }

  if (isDuplicateTerminalOutcome(record, outcome, invoiceId, paymentId)) {
    return {
      duplicateEvent: true,
      finalized: true,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "duplicate",
    };
  }

  if (isConflictingTerminalOutcome(record, outcome)) {
    await recordIgnoredProviderEvent(repository, {
      event,
      invoiceId,
      paymentId,
      noShowChargeRecordId: record.id,
      now,
    });
    await alerts.alert({
      category: "no_show_charge_provider_mismatch",
      severity: "error",
      message:
        "Square no-show webhook conflicts with terminal local charge status",
      context: {
        eventId: event.eventId,
        localStatus: record.status,
        noShowChargeRecordId: record.id,
        outcome: outcome.kind,
        reason: "terminal_status_conflict",
      },
    });
    return {
      duplicateEvent: false,
      finalized: false,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "ignored",
    };
  }

  const factsResult = await fetchProviderFacts(
    event,
    invoiceId,
    dependencies.providerReader,
  );

  if (!factsResult.ok) {
    await recordIgnoredProviderEvent(repository, {
      event,
      invoiceId,
      paymentId,
      noShowChargeRecordId: record.id,
      now,
    });
    await alerts.alert({
      category: "no_show_charge_provider_mismatch",
      severity: "error",
      message: "Square no-show webhook did not match local charge invariants",
      context: {
        eventId: event.eventId,
        noShowChargeRecordId: record.id,
        reason: factsResult.reason,
      },
    });
    return {
      duplicateEvent: false,
      finalized: false,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "ignored",
    };
  }

  const validation = validateProviderMatch(
    record,
    event,
    factsResult.facts,
    outcome.kind,
    invoiceId,
    paymentId,
  );

  if (!validation.ok) {
    await recordIgnoredProviderEvent(repository, {
      event,
      invoiceId,
      paymentId,
      noShowChargeRecordId: record.id,
      now,
    });
    await alerts.alert({
      category: "no_show_charge_provider_mismatch",
      severity: "error",
      message: "Square no-show webhook did not match local charge invariants",
      context: {
        eventId: event.eventId,
        noShowChargeRecordId: record.id,
        reason: validation.reason,
      },
    });
    return {
      duplicateEvent: false,
      finalized: false,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "ignored",
    };
  }

  const update = buildRecordUpdate(record, outcome, paymentId, now);
  await repository.finalizeNoShowChargeRecord({
    ...update,
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      status: outcome.kind === "failed" ? "charge_failed" : "charged",
      providerPaymentId: paymentId,
      providerInvoiceId: invoiceId,
      providerOrderId: event.orderId,
      payloadSanitized: event.payloadSanitized,
      processedAt: now,
      processingStatus: outcome.kind === "failed" ? "failed" : "processed",
    },
  });

  if (outcome.kind === "failed") {
    alerts.alert({
      category: "no_show_charge_failed",
      severity: "warning",
      message: "Square no-show charge failed",
      context: {
        eventId: event.eventId,
        eventType: event.eventType,
        invoiceId,
        noShowChargeRecordId: record.id,
        paymentId,
        providerStatus: outcome.providerStatus,
      },
    });

    return {
      duplicateEvent: false,
      finalized: true,
      noShowChargeRecordId: record.id,
      retryable: false,
      status: "charge_failed",
    };
  }

  return {
    duplicateEvent: false,
    finalized: true,
    noShowChargeRecordId: record.id,
    retryable: false,
    status: "charged",
  };
}

type FinalizerOutcome =
  | { kind: "success"; providerStatus: string }
  | { kind: "failed"; providerStatus: string; reason: string }
  | { kind: "ignored" };

function resolveOutcome(
  event: VerifiedSquareWebhookEvent,
  invoiceId: string | undefined,
  paymentId: string | undefined,
): FinalizerOutcome {
  if (event.eventType === "invoice.payment_made") {
    const invoiceStatus = getEventInvoiceStatus(event);
    return { kind: "success", providerStatus: invoiceStatus ?? "PAID" };
  }

  if (paymentId === undefined) {
    return { kind: "ignored" };
  }

  const paymentStatus = getPaymentStatus(event);

  if (paymentStatus === "COMPLETED") {
    return { kind: "success", providerStatus: "COMPLETED" };
  }

  if (paymentStatus === "FAILED" || paymentStatus === "CANCELED") {
    return {
      kind: "failed",
      providerStatus: paymentStatus,
      reason: `Square payment status ${paymentStatus}`,
    };
  }

  return { kind: "ignored" };
}

function buildRecordUpdate(
  record: NoShowChargeRecordDetail,
  outcome: Exclude<FinalizerOutcome, { kind: "ignored" }>,
  paymentId: string | undefined,
  now: Date,
): {
  noShowChargeRecordId: string;
  status: NoShowChargeStatus;
  squarePaymentId?: string;
  providerStatus?: string;
  providerFailureReason?: string;
  providerMetadata?: Record<string, unknown>;
  chargedAt?: Date;
} {
  const base = {
    noShowChargeRecordId: record.id,
    providerStatus: outcome.providerStatus,
    providerMetadata: {
      ...(record.providerMetadata ?? {}),
      ...(paymentId ? { squarePaymentId: paymentId } : {}),
    },
  };

  if (outcome.kind === "failed") {
    return {
      ...base,
      status: "charge_failed",
      providerFailureReason: outcome.reason,
    };
  }

  return {
    ...base,
    status: "charged",
    squarePaymentId: paymentId,
    chargedAt: now,
  };
}

function isDuplicateTerminalOutcome(
  record: NoShowChargeRecordDetail,
  outcome: Exclude<FinalizerOutcome, { kind: "ignored" }>,
  invoiceId: string | undefined,
  paymentId: string | undefined,
): boolean {
  if (outcome.kind === "success" && record.status === "charged") {
    return (
      (invoiceId !== undefined && record.squareInvoiceId === invoiceId) ||
      (paymentId !== undefined && record.squarePaymentId === paymentId)
    );
  }

  if (outcome.kind === "failed" && record.status === "charge_failed") {
    return paymentId !== undefined && record.squarePaymentId === paymentId;
  }

  return false;
}

function isConflictingTerminalOutcome(
  record: NoShowChargeRecordDetail,
  outcome: Exclude<FinalizerOutcome, { kind: "ignored" }>,
): boolean {
  const terminalStatuses: NoShowChargeStatus[] = ["charged", "charge_failed"];
  if (!terminalStatuses.includes(record.status)) {
    return false;
  }

  if (record.status === "charged" && outcome.kind === "failed") {
    return true;
  }

  if (record.status === "charge_failed" && outcome.kind === "success") {
    return true;
  }

  return false;
}

function alertUnknownProviderEvent(
  alerts: ServicePaymentAlertLogger,
  event: VerifiedSquareWebhookEvent,
  invoiceId: string | undefined,
  paymentId: string | undefined,
): void {
  alerts.alert({
    category: "no_show_charge_unknown_provider_event",
    severity: "warning",
    message: "Square webhook event did not match a no-show charge record",
    context: {
      eventId: event.eventId,
      eventType: event.eventType,
      invoiceId,
      orderId: event.orderId,
      paymentId,
    },
  });
}

function getEventInvoiceId(
  event: VerifiedSquareWebhookEvent,
): string | undefined {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.id) ?? getText(data?.id) ?? undefined;
}

function getEventInvoiceStatus(
  event: VerifiedSquareWebhookEvent,
): string | undefined {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.status) ?? undefined;
}

function getPaymentStatus(
  event: VerifiedSquareWebhookEvent,
): string | undefined {
  const data = getRecord(event.payloadSanitized.data);
  const object = getRecord(data?.object);
  const payment = getRecord(object?.payment);

  return getText(payment?.status) ?? undefined;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface ProviderFacts {
  amountCents?: number;
  currency?: string;
  customerId?: string;
  cardId?: string;
  sourceType?: string;
  status?: string;
  invoiceStatus?: string;
  paymentOrderId?: string;
  invoiceOrderId?: string;
  paymentId?: string;
  invoiceId?: string;
}

async function fetchProviderFacts(
  event: VerifiedSquareWebhookEvent,
  invoiceId: string | undefined,
  providerReader: NoShowChargeProviderReader,
): Promise<{ ok: true; facts: ProviderFacts } | { ok: false; reason: string }> {
  const facts: ProviderFacts = {};

  if (event.paymentId !== undefined) {
    try {
      const response = await providerReader.getPayment(event.paymentId);
      const payment = response.payment;

      facts.amountCents = payment.amount_money?.amount;
      facts.currency = payment.amount_money?.currency;
      facts.customerId = payment.customer_id;
      facts.sourceType = payment.source_type;
      facts.cardId = payment.card_details?.card?.id;
      facts.status = payment.status;
      facts.paymentOrderId = payment.order_id;
      facts.paymentId = payment.id;
    } catch (error) {
      if (isSquareNotFoundError(error)) {
        return { ok: false, reason: "payment_not_found" };
      }

      throw error;
    }
  }

  if (invoiceId !== undefined) {
    try {
      const response = await providerReader.getInvoice(invoiceId);

      facts.invoiceStatus = response.invoice.status;
      facts.invoiceOrderId = response.invoice.order_id;
      facts.invoiceId = response.invoice.id;
    } catch (error) {
      if (isSquareNotFoundError(error)) {
        return { ok: false, reason: "invoice_not_found" };
      }

      throw error;
    }
  }

  return { ok: true, facts };
}

function isSquareNotFoundError(error: unknown): boolean {
  return error instanceof Error && /status 404/.test(error.message);
}

async function recordIgnoredProviderEvent(
  repository: NoShowChargeFinalizerRepository,
  input: {
    event: VerifiedSquareWebhookEvent;
    invoiceId: string | undefined;
    noShowChargeRecordId: string;
    now: Date;
    paymentId: string | undefined;
  },
): Promise<void> {
  await repository.recordNoShowChargeWebhookEvent({
    eventId: input.event.eventId,
    eventType: input.event.eventType,
    noShowChargeRecordId: input.noShowChargeRecordId,
    status: "ignored",
    providerPaymentId: input.paymentId,
    providerInvoiceId: input.invoiceId,
    providerOrderId: input.event.orderId,
    payloadSanitized: input.event.payloadSanitized,
    processedAt: input.now,
    processingStatus: "ignored",
  });
}

function validateProviderMatch(
  record: NoShowChargeRecordDetail,
  event: VerifiedSquareWebhookEvent,
  facts: ProviderFacts,
  outcomeKind: "success" | "failed",
  invoiceId: string | undefined,
  paymentId: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (
    invoiceId !== undefined &&
    record.squareInvoiceId !== undefined &&
    invoiceId !== record.squareInvoiceId
  ) {
    return { ok: false, reason: "invoice_id_mismatch" };
  }

  if (
    paymentId !== undefined &&
    record.squarePaymentId !== undefined &&
    paymentId !== record.squarePaymentId
  ) {
    return { ok: false, reason: "payment_id_mismatch" };
  }

  // Cross-validate authoritative fetched resource IDs against webhook and local references.
  if (facts.paymentId !== undefined) {
    if (paymentId !== undefined && facts.paymentId !== paymentId) {
      return { ok: false, reason: "payment_id_mismatch" };
    }

    if (
      record.squarePaymentId !== undefined &&
      facts.paymentId !== record.squarePaymentId
    ) {
      return { ok: false, reason: "payment_id_mismatch" };
    }
  }

  if (facts.invoiceId !== undefined) {
    if (invoiceId !== undefined && facts.invoiceId !== invoiceId) {
      return { ok: false, reason: "invoice_id_mismatch" };
    }

    if (
      record.squareInvoiceId !== undefined &&
      facts.invoiceId !== record.squareInvoiceId
    ) {
      return { ok: false, reason: "invoice_id_mismatch" };
    }
  }

  if (
    event.orderId !== undefined &&
    record.squareOrderId !== undefined &&
    event.orderId !== record.squareOrderId
  ) {
    return { ok: false, reason: "order_id_mismatch" };
  }

  if (
    facts.paymentOrderId !== undefined &&
    record.squareOrderId !== undefined &&
    facts.paymentOrderId !== record.squareOrderId
  ) {
    return { ok: false, reason: "payment_order_id_mismatch" };
  }

  if (
    facts.invoiceOrderId !== undefined &&
    record.squareOrderId !== undefined &&
    facts.invoiceOrderId !== record.squareOrderId
  ) {
    return { ok: false, reason: "invoice_order_id_mismatch" };
  }

  // Authoritative provider status must be compatible with the terminal outcome;
  // webhook payload status alone must not drive finalization.
  if (outcomeKind === "success") {
    if (paymentId !== undefined) {
      if (facts.status === undefined) {
        return { ok: false, reason: "missing_provider_status" };
      }

      if (!isSuccessfulProviderStatus(facts.status)) {
        return { ok: false, reason: "provider_status_not_successful" };
      }
    } else if (
      facts.status !== undefined &&
      !isSuccessfulProviderStatus(facts.status)
    ) {
      return { ok: false, reason: "provider_status_not_successful" };
    }

    if (invoiceId !== undefined) {
      if (facts.invoiceStatus === undefined) {
        return { ok: false, reason: "missing_invoice_status" };
      }

      if (!isSuccessfulProviderStatus(facts.invoiceStatus)) {
        return { ok: false, reason: "invoice_status_not_paid" };
      }
    }
  }

  if (outcomeKind === "failed") {
    if (facts.status === undefined) {
      return { ok: false, reason: "missing_provider_status" };
    }

    if (!isFailedProviderStatus(facts.status)) {
      return { ok: false, reason: "provider_status_not_failed" };
    }
  }

  const financialMatch = validateFinancialProviderMatch(record, facts);
  if (!financialMatch.ok) {
    return financialMatch;
  }

  return { ok: true };
}

function isSuccessfulProviderStatus(status: string): boolean {
  return ["APPROVED", "COMPLETED", "PAID"].includes(status);
}

function isFailedProviderStatus(status: string): boolean {
  return ["CANCELED", "FAILED"].includes(status);
}

function validateFinancialProviderMatch(
  record: NoShowChargeRecordDetail,
  facts: ProviderFacts,
): { ok: true } | { ok: false; reason: string } {
  if (facts.amountCents === undefined) {
    return { ok: false, reason: "missing_amount" };
  }

  if (facts.amountCents !== record.maxChargeCents) {
    return { ok: false, reason: "amount_mismatch" };
  }

  if (facts.currency === undefined) {
    return { ok: false, reason: "missing_currency" };
  }

  if (facts.currency !== record.currency) {
    return { ok: false, reason: "currency_mismatch" };
  }

  if (record.squareCustomerId !== undefined) {
    if (facts.customerId === undefined) {
      return { ok: false, reason: "missing_customer" };
    }

    if (facts.customerId !== record.squareCustomerId) {
      return { ok: false, reason: "customer_mismatch" };
    }
  }

  if (record.squareCardId !== undefined) {
    if (facts.cardId === undefined) {
      return { ok: false, reason: "missing_card" };
    }

    if (facts.cardId !== record.squareCardId) {
      return { ok: false, reason: "card_mismatch" };
    }
  }

  return { ok: true };
}
