import type {
  BookingNoShowProviderMetadata,
  NoShowChargeStatus,
} from "@/lib/private-db/schema";
import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_PERCENTAGE,
  SERVICE_BOOKING_HST_TAX_NAME,
  SERVICE_BOOKING_HST_TAX_UID,
} from "@/lib/booking/service-tax-policy";
import type {
  SquareCreateInvoiceRequest,
  SquareCreateInvoiceResponse,
  SquareCreateOrderRequest,
  SquareCreateOrderResponse,
  SquareGetInvoiceResponse,
  SquareInvoicesClient,
  SquarePublishInvoiceRequest,
  SquarePublishInvoiceResponse,
} from "@/lib/payments/square/invoice-client";

import { type ServicePaymentAlertLogger } from "./service-payment-alerts";

export interface CreateDraftNoShowInvoiceInput {
  cardId: string;
  chargeableAmountCents?: number;
  customerEmail: string;
  customerId: string;
  holdId: string;
  idempotencyKey: string;
  maxChargeCents: number;
  noShowChargeRecordId: string;
  providerMetadata?: BookingNoShowProviderMetadata;
  serviceDescription: string;
}

export interface NoShowChargeRecord {
  id: string;
  status: NoShowChargeStatus;
}

export interface NoShowChargeRecordDetail {
  id: string;
  status: NoShowChargeStatus;
  squareInvoiceId?: string;
  squareOrderId?: string;
  squarePaymentId?: string;
  squareCardId?: string;
  squareCustomerId?: string;
  savedPaymentMethodId?: string;
  policyAcceptanceId?: string;
  maxChargeCents: number;
  currency: string;
  providerStatus?: string;
  providerFailureReason?: string;
  providerMetadata?: BookingNoShowProviderMetadata;
  updatedAt?: Date;
  adminActionAt?: Date;
  adminOperatorId?: string;
  adminReason?: string;
  adminEligibilityCheckedAt?: Date;
}

export interface NoShowChargeAttempt {
  id: string;
  noShowChargeRecordId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  status?: string;
  squarePaymentId?: string;
  squareInvoiceId?: string;
  failureReason?: string;
  processedAt?: Date;
}

export interface CreateDraftNoShowInvoiceRepository {
  updateNoShowChargeRecord(input: {
    noShowChargeRecordId: string;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: BookingNoShowProviderMetadata;
    chargedAt?: Date;
    updatedAt?: Date;
  }): Promise<NoShowChargeRecord>;
}

export interface NoShowChargeAttemptClaimResult {
  attempt: NoShowChargeAttempt;
  isOwner: boolean;
  record: NoShowChargeRecordDetail;
}

export interface NoShowInvoiceRepository extends CreateDraftNoShowInvoiceRepository {
  getNoShowChargeRecordById(
    noShowChargeRecordId: string,
  ): Promise<NoShowChargeRecordDetail | null>;
  recordNoShowAdminAction(input: {
    noShowChargeRecordId: string;
    operatorId: string;
    reason: string;
    now: Date;
  }): Promise<{ recorded: boolean }>;
  findNoShowChargeAttempt(input: {
    noShowChargeRecordId: string;
    idempotencyKey: string;
  }): Promise<NoShowChargeAttempt | null>;
  createNoShowChargeAttempt(input: {
    noShowChargeRecordId: string;
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    status: string;
    now: Date;
  }): Promise<NoShowChargeAttempt>;
  updateNoShowChargeAttempt(input: {
    attemptId: string;
    status?: string;
    squarePaymentId?: string;
    squareInvoiceId?: string;
    failureReason?: string;
    processedAt?: Date;
  }): Promise<NoShowChargeAttempt>;
  claimNoShowChargeAttempt(input: {
    noShowChargeRecordId: string;
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    now: Date;
  }): Promise<NoShowChargeAttemptClaimResult>;
  recoverStaleNoShowChargePending(input: {
    noShowChargeRecordId: string;
    now: Date;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
  }): Promise<NoShowChargeRecordDetail | null>;
  updateNoShowChargeRecordIfNotTerminal(input: {
    noShowChargeRecordId: string;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: BookingNoShowProviderMetadata;
    chargedAt?: Date;
  }): Promise<NoShowChargeRecord>;
  updateNoShowChargeRecordIfExpectedState(input: {
    noShowChargeRecordId: string;
    expectedStatus: NoShowChargeStatus;
    expectedProviderStatus?: string;
    expectedSquareInvoiceId?: string;
    expectedUpdatedAt?: Date;
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: BookingNoShowProviderMetadata;
    chargedAt?: Date;
  }): Promise<NoShowChargeRecord>;
}

export interface CreateDraftNoShowInvoiceDependencies {
  locationId: string;
  repository: CreateDraftNoShowInvoiceRepository;
  squareInvoices: SquareInvoicesClient;
}

export interface CreateDraftNoShowInvoiceResult {
  squareInvoiceId: string;
  squareOrderId: string;
  status: "provider_draft_created";
}

export interface ChargeNoShowInvoiceInput {
  amountCents: number;
  idempotencyKey: string;
  noShowChargeRecordId: string;
  operatorId?: string;
  reason?: string;
}

export type ChargeNoShowInvoiceStatus =
  | "charge_pending"
  | "charged"
  | "charge_failed"
  | "manual_followup";

export interface ChargeNoShowInvoiceResult {
  chargeStatus: ChargeNoShowInvoiceStatus;
  noShowChargeRecordId: string;
  squarePaymentId?: string;
  failureReason?: string;
}

export interface ChargeNoShowInvoiceDependencies {
  repository: NoShowInvoiceRepository;
  squareInvoices: SquareInvoicesClient;
  alerts: ServicePaymentAlertLogger;
  now?: Date;
}

export class NoShowInvoiceSquareApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoShowInvoiceSquareApiError";
  }
}

export class NoShowInvoiceBlockedError extends Error {
  constructor(
    message: string,
    public context?: {
      squareInvoiceId?: string;
      squareOrderId?: string;
      providerStatus?: string;
    },
  ) {
    super(message);
    this.name = "NoShowInvoiceBlockedError";
  }
}

export class NoShowInvoicePersistenceError extends Error {
  constructor(
    message: string,
    public context?: {
      squareInvoiceId?: string;
      squareOrderId?: string;
      deleteFailed?: boolean;
      providerStatus?: string;
    },
  ) {
    super(message);
    this.name = "NoShowInvoicePersistenceError";
  }
}

export class NoShowInvoiceChargeError extends Error {
  constructor(
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = "NoShowInvoiceChargeError";
  }
}

export class NoShowInvoiceAmountError extends Error {
  constructor(
    message: string,
    public context?: { allowedAmountCents: number },
  ) {
    super(message);
    this.name = "NoShowInvoiceAmountError";
  }
}

export const NO_SHOW_REASON_MAX_LENGTH = 500;
export const CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u001F\\u007F]");
export const OPERATOR_ID_PATTERN = /^[a-zA-Z0-9._:@-]{2,120}$/;
export const STALE_CHARGE_PENDING_MS = 15 * 60 * 1000;

export function validateNoShowAdminAction(input: {
  operatorId: string;
  reason: string;
}): { operatorId: string; reason: string } {
  const operatorId = input.operatorId.trim();
  if (!OPERATOR_ID_PATTERN.test(operatorId)) {
    throw new NoShowInvoiceChargeError(
      "Invalid no-show admin operator identity",
    );
  }

  const reason = input.reason.trim();
  if (
    reason.length === 0 ||
    reason.length > NO_SHOW_REASON_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(reason)
  ) {
    throw new NoShowInvoiceChargeError("Invalid no-show admin reason");
  }

  return { operatorId, reason };
}

export interface NoShowChargeAmountSnapshot {
  fullBookedServiceAmountCents: number;
  fullBookedServiceTaxCents?: number;
  fullBookedServiceTotalCents?: number;
  paidAtBookingCents: number;
  paidAtBookingTaxCents?: number;
  paidAtBookingTotalCents?: number;
  remainingBalanceCents: number;
  remainingBalanceTaxCents?: number;
  remainingBalanceWithTaxCents?: number;
}

export function getNoShowAllowedChargeAmountCents(
  record: Pick<NoShowChargeRecordDetail, "maxChargeCents" | "providerMetadata">,
): number {
  const snapshot = record.providerMetadata?.amountSnapshot as
    | NoShowChargeAmountSnapshot
    | undefined;

  if (
    snapshot !== undefined &&
    typeof snapshot === "object" &&
    snapshot !== null &&
    typeof snapshot.remainingBalanceWithTaxCents === "number" &&
    Number.isInteger(snapshot.remainingBalanceWithTaxCents) &&
    snapshot.remainingBalanceWithTaxCents >= 0
  ) {
    return snapshot.remainingBalanceWithTaxCents;
  }

  if (
    snapshot !== undefined &&
    typeof snapshot === "object" &&
    snapshot !== null &&
    typeof snapshot.remainingBalanceCents === "number" &&
    Number.isInteger(snapshot.remainingBalanceCents) &&
    snapshot.remainingBalanceCents >= 0
  ) {
    return snapshot.remainingBalanceCents;
  }

  return record.maxChargeCents;
}

export async function createDraftNoShowInvoice(
  input: CreateDraftNoShowInvoiceInput,
  dependencies: CreateDraftNoShowInvoiceDependencies,
): Promise<CreateDraftNoShowInvoiceResult> {
  const amountSnapshot = buildNoShowChargeAmountSnapshot(input);
  const providerMetadata = {
    ...input.providerMetadata,
    amountSnapshot,
  } satisfies BookingNoShowProviderMetadata;
  const enrichedInput = {
    ...input,
    providerMetadata,
  };
  const orderRequest = buildOrderRequest(
    enrichedInput,
    dependencies.locationId,
  );

  let orderResponse: SquareCreateOrderResponse;
  try {
    orderResponse = await dependencies.squareInvoices.createOrder(orderRequest);
  } catch (error) {
    throw new NoShowInvoiceSquareApiError(
      error instanceof Error ? error.message : "Square order creation failed",
    );
  }

  const invoiceRequest = buildInvoiceRequest(
    enrichedInput,
    dependencies.locationId,
    orderResponse.order.id,
  );

  let invoiceResponse: SquareCreateInvoiceResponse;
  try {
    invoiceResponse =
      await dependencies.squareInvoices.createInvoice(invoiceRequest);
  } catch (error) {
    // The order was already created, so a provider reference exists.
    // Local fallback is not safe here; record the order id for manual
    // follow-up if possible, then block booking.
    const providerRefs = {
      squareOrderId: orderResponse.order.id,
      providerStatus: "invoice_creation_failed",
    };

    try {
      await dependencies.repository.updateNoShowChargeRecord({
        noShowChargeRecordId: input.noShowChargeRecordId,
        status: "manual_followup",
        ...providerRefs,
      });
    } catch {
      // Persistence failed, but a provider order id still exists.
      // Block booking regardless so staff can reconcile the orphan.
    }

    throw new NoShowInvoiceBlockedError(
      error instanceof Error ? error.message : "Square invoice creation failed",
      providerRefs,
    );
  }

  if (invoiceResponse.invoice.status !== "DRAFT") {
    // Square created an invoice but it is not in the expected DRAFT state.
    // Provider references exist and must be durably recorded for staff review;
    // this is not a fallback-eligible provider creation failure.
    const providerRefs = {
      squareInvoiceId: invoiceResponse.invoice.id,
      squareOrderId: orderResponse.order.id,
      providerStatus: invoiceResponse.invoice.status,
    };

    try {
      await dependencies.repository.updateNoShowChargeRecord({
        noShowChargeRecordId: input.noShowChargeRecordId,
        status: "manual_followup",
        ...providerRefs,
      });
    } catch (error) {
      throw new NoShowInvoiceBlockedError(
        error instanceof Error
          ? `Unexpected Square invoice status ${invoiceResponse.invoice.status} and failed to persist provider refs: ${error.message}`
          : `Unexpected Square invoice status ${invoiceResponse.invoice.status}`,
        providerRefs,
      );
    }

    throw new NoShowInvoiceBlockedError(
      `Unexpected Square invoice status: ${invoiceResponse.invoice.status}`,
      providerRefs,
    );
  }

  // Persist provider references immediately so webhook/event finalizers can
  // correlate this no-show charge record with Square later.
  const providerRefs = {
    squareInvoiceId: invoiceResponse.invoice.id,
    squareOrderId: orderResponse.order.id,
    providerStatus: invoiceResponse.invoice.status,
    providerMetadata: {
      ...enrichedInput.providerMetadata,
      squareInvoiceVersion: invoiceResponse.invoice.version,
    } satisfies BookingNoShowProviderMetadata,
  };

  try {
    await dependencies.repository.updateNoShowChargeRecord({
      noShowChargeRecordId: input.noShowChargeRecordId,
      status: "provider_draft_created",
      ...providerRefs,
    });
  } catch (error) {
    // Best-effort: delete the DRAFT invoice so we don't leave an orphaned
    // Square charge instrument if local persistence fails.
    let deleteFailed = false;
    try {
      await dependencies.squareInvoices.deleteInvoice(
        invoiceResponse.invoice.id,
        invoiceResponse.invoice.version,
      );
    } catch {
      deleteFailed = true;
    }

    throw new NoShowInvoicePersistenceError(
      error instanceof Error
        ? error.message
        : "Failed to persist Square draft invoice references",
      { ...providerRefs, deleteFailed },
    );
  }

  return {
    status: "provider_draft_created",
    squareInvoiceId: invoiceResponse.invoice.id,
    squareOrderId: orderResponse.order.id,
  };
}

export async function chargeNoShowInvoice(
  input: ChargeNoShowInvoiceInput,
  dependencies: ChargeNoShowInvoiceDependencies,
): Promise<ChargeNoShowInvoiceResult> {
  const now = dependencies.now ?? new Date();
  const { repository, squareInvoices, alerts } = dependencies;

  let record = await repository.getNoShowChargeRecordById(
    input.noShowChargeRecordId,
  );

  if (record === null) {
    throw new NoShowInvoiceChargeError("No-show charge record not found");
  }

  // v1 automated charge supports only the exact remaining balance (or the
  // original max charge for legacy records without an amount snapshot).
  const allowedAmountCents = getNoShowAllowedChargeAmountCents(record);
  if (input.amountCents !== allowedAmountCents) {
    throw new NoShowInvoiceAmountError(
      `Amount ${input.amountCents} does not match allowed charge ${allowedAmountCents} ${record.currency}`,
      { allowedAmountCents },
    );
  }

  if (input.operatorId === undefined || input.reason === undefined) {
    throw new NoShowInvoiceChargeError(
      "No-show admin operator and reason are required",
    );
  }

  const { operatorId, reason } = validateNoShowAdminAction({
    operatorId: input.operatorId,
    reason: input.reason,
  });

  // Stale charge_pending recovery: a prior publish may have failed to complete
  // locally (network/webhook gap). Before any new publish, consult Square for
  // the authoritative invoice state. Only reclaim rows that have been stuck in
  // publish_pending long enough to avoid racing an in-flight publish.
  let recoveredFromStale = false;
  if (isStaleChargePending(record, now)) {
    // All stale fallback writes use strict compare-and-set against the exact
    // stale state we just read. This prevents a concurrent recovery, webhook,
    // or new publish attempt from being overwritten.
    const staleExpectedState = {
      expectedStatus: "charge_pending" as const,
      expectedProviderStatus: "publish_pending",
      expectedSquareInvoiceId: record.squareInvoiceId,
      expectedUpdatedAt: record.updatedAt,
    };

    if (record.squareInvoiceId === undefined) {
      const reason =
        "Cannot recover stale no-show charge: missing Square invoice reference";

      try {
        await repository.updateNoShowChargeRecordIfExpectedState({
          noShowChargeRecordId: record.id,
          ...staleExpectedState,
          status: "manual_followup",
          providerFailureReason: reason,
        });
      } catch (error) {
        const persistenceReason =
          error instanceof Error
            ? error.message
            : "Failed to persist manual follow-up for missing provider reference";
        await alerts.alert({
          category: "no_show_charge_persistence_failed",
          severity: "error",
          message:
            "Could not persist manual follow-up for stale no-show charge missing provider reference",
          context: {
            noShowChargeRecordId: record.id,
            reason: persistenceReason,
          },
        });

        return {
          chargeStatus: "manual_followup",
          noShowChargeRecordId: record.id,
          failureReason: persistenceReason,
        };
      }

      await alerts.alert({
        category: "no_show_charge_missing_provider_reference",
        severity: "error",
        message: reason,
        context: { noShowChargeRecordId: record.id },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: reason,
      };
    }

    let invoiceResponse: SquareGetInvoiceResponse;
    try {
      invoiceResponse = await squareInvoices.getInvoice(record.squareInvoiceId);
    } catch (error) {
      const lookupReason =
        error instanceof Error ? error.message : "Square invoice lookup failed";

      try {
        await repository.updateNoShowChargeRecordIfExpectedState({
          noShowChargeRecordId: record.id,
          ...staleExpectedState,
          status: "manual_followup",
          providerFailureReason: lookupReason,
        });
      } catch (persistenceError) {
        const persistenceReason =
          persistenceError instanceof Error
            ? persistenceError.message
            : "Failed to persist manual follow-up for stale no-show lookup failure";
        await alerts.alert({
          category: "no_show_charge_persistence_failed",
          severity: "error",
          message:
            "Could not persist manual follow-up for stale no-show lookup failure",
          context: {
            noShowChargeRecordId: record.id,
            squareInvoiceId: record.squareInvoiceId,
            reason: persistenceReason,
          },
        });

        return {
          chargeStatus: "manual_followup",
          noShowChargeRecordId: record.id,
          failureReason: persistenceReason,
        };
      }

      await alerts.alert({
        category: "no_show_charge_recovery_lookup_failed",
        severity: "warning",
        message: "Could not look up stale no-show invoice state",
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          reason: lookupReason,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: lookupReason,
      };
    }

    const invoiceStatus = invoiceResponse.invoice.status;

    if (invoiceStatus === "DRAFT") {
      const fetchedInvoiceVersion = invoiceResponse.invoice.version;
      const recovered = await repository.recoverStaleNoShowChargePending({
        noShowChargeRecordId: record.id,
        now,
        expectedSquareInvoiceId: record.squareInvoiceId,
        expectedUpdatedAt: record.updatedAt,
      });
      if (recovered !== null) {
        record = recovered;
        recoveredFromStale = true;

        if (fetchedInvoiceVersion !== undefined) {
          const updatedMetadata = {
            ...(record.providerMetadata ?? {}),
            squareInvoiceVersion: fetchedInvoiceVersion,
          };
          try {
            await repository.updateNoShowChargeRecordIfExpectedState({
              noShowChargeRecordId: record.id,
              expectedStatus: "provider_draft_created",
              expectedProviderStatus: "DRAFT",
              expectedSquareInvoiceId: record.squareInvoiceId,
              expectedUpdatedAt: now,
              providerMetadata: updatedMetadata,
            });
          } catch (error) {
            const persistenceReason =
              error instanceof Error
                ? error.message
                : "Failed to persist fetched Square invoice version";
            await alerts.alert({
              category: "no_show_charge_persistence_failed",
              severity: "error",
              message:
                "Could not persist fetched Square invoice version during stale recovery",
              context: {
                noShowChargeRecordId: record.id,
                squareInvoiceId: record.squareInvoiceId,
                reason: persistenceReason,
              },
            });
          }

          record = {
            ...record,
            providerMetadata: updatedMetadata,
          };
        }
      }
    } else if (invoiceStatus === "PAID") {
      // Stale PAID invoices cannot be auto-finalized safely: invoice status and
      // a payment id alone are not authoritative payment facts. Route to durable
      // manual follow-up so staff reconcile through the validated finalizer path.
      const paymentId = (invoiceResponse.invoice as { payment_id?: string })
        .payment_id;
      const manualReason =
        "Stale no-show invoice is PAID but cannot be auto-finalized without full payment validation";

      try {
        await repository.updateNoShowChargeRecordIfExpectedState({
          noShowChargeRecordId: record.id,
          ...staleExpectedState,
          status: "manual_followup",
          providerStatus: invoiceStatus,
          providerFailureReason: manualReason,
        });
      } catch (error) {
        const persistenceReason =
          error instanceof Error
            ? error.message
            : "Failed to persist manual follow-up for stale no-show PAID invoice";
        await alerts.alert({
          category: "no_show_charge_persistence_failed",
          severity: "error",
          message:
            "Could not persist manual follow-up for stale no-show PAID invoice",
          context: {
            noShowChargeRecordId: record.id,
            squareInvoiceId: record.squareInvoiceId,
            squarePaymentId:
              typeof paymentId === "string" ? paymentId : undefined,
            reason: persistenceReason,
          },
        });

        return {
          chargeStatus: "manual_followup",
          noShowChargeRecordId: record.id,
          failureReason: persistenceReason,
        };
      }

      await alerts.alert({
        category: "no_show_charge_paid_requires_manual_validation",
        severity: "warning",
        message: manualReason,
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          providerStatus: invoiceStatus,
          squarePaymentId:
            typeof paymentId === "string" ? paymentId : undefined,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: manualReason,
      };
    } else if (isTerminalFailureStatus(invoiceStatus)) {
      const failureReason = `Square invoice is in terminal status ${invoiceStatus}`;
      try {
        await repository.updateNoShowChargeRecordIfExpectedState({
          noShowChargeRecordId: record.id,
          ...staleExpectedState,
          status: "charge_failed",
          providerStatus: invoiceStatus,
          providerFailureReason: failureReason,
        });
      } catch (error) {
        const persistenceReason =
          error instanceof Error
            ? error.message
            : "Failed to persist Square terminal failure";
        await alerts.alert({
          category: "no_show_charge_persistence_failed",
          severity: "error",
          message:
            "Stale no-show invoice recovery found terminal status but persistence failed",
          context: {
            noShowChargeRecordId: record.id,
            squareInvoiceId: record.squareInvoiceId,
            providerStatus: invoiceStatus,
            reason: persistenceReason,
          },
        });

        return {
          chargeStatus: "manual_followup",
          noShowChargeRecordId: record.id,
          failureReason: persistenceReason,
        };
      }

      await alerts.alert({
        category: "no_show_charge_failed",
        severity: "warning",
        message: failureReason,
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          providerStatus: invoiceStatus,
        },
      });

      return {
        chargeStatus: "charge_failed",
        noShowChargeRecordId: record.id,
        failureReason,
      };
    } else {
      // Non-terminal non-DRAFT status (UNPAID, PAYMENT_PENDING, etc.): the
      // publish is still in flight. Do not retry and risk a duplicate charge.
      return {
        chargeStatus: "charge_pending",
        noShowChargeRecordId: record.id,
      };
    }
  }

  // Record audit before any state transition or provider action. If audit
  // persistence fails the record stays in its current state and no Square
  // publish is attempted. The repository uses compare-and-set/no-overwrite
  // semantics, so a replay or concurrent request sees { recorded: false }.
  const adminResult = await repository.recordNoShowAdminAction({
    noShowChargeRecordId: input.noShowChargeRecordId,
    operatorId,
    reason,
    now,
  });

  if (!adminResult.recorded) {
    // Audit already exists from a prior request. Return the existing attempt
    // state for this idempotency key when available. After a stale recovery we
    // intentionally allow a new publish attempt with a fresh idempotency key,
    // because the prior publish never completed locally and Square confirms the
    // invoice is still DRAFT.
    const existingAttempt = await repository.findNoShowChargeAttempt({
      noShowChargeRecordId: input.noShowChargeRecordId,
      idempotencyKey: input.idempotencyKey,
    });

    if (existingAttempt !== null) {
      return resultFromAttempt(input.noShowChargeRecordId, existingAttempt);
    }

    if (!recoveredFromStale) {
      throw new NoShowInvoiceChargeError(
        "No-show admin action already recorded",
      );
    }
  }

  // Atomic claim: only one caller transitions provider_draft_created -> charge_pending
  // and owns the Square publish. Same idempotency key returns the existing attempt;
  // a different key while charge_pending returns charge_pending without a second publish.
  const claimResult = await repository.claimNoShowChargeAttempt({
    noShowChargeRecordId: input.noShowChargeRecordId,
    idempotencyKey: input.idempotencyKey,
    amountCents: input.amountCents,
    currency: record.currency,
    now,
  });

  if (!claimResult.isOwner) {
    return resultFromAttempt(input.noShowChargeRecordId, claimResult.attempt);
  }

  const attempt = claimResult.attempt;
  const invoiceVersion = getInvoiceVersion(record);

  if (record.squareInvoiceId === undefined || invoiceVersion === undefined) {
    const reason = "No Square draft invoice reference available for publish";
    await repository.updateNoShowChargeAttempt({
      attemptId: attempt.id,
      status: "manual_followup",
      failureReason: reason,
      processedAt: now,
    });
    try {
      await repository.updateNoShowChargeRecordIfExpectedState({
        noShowChargeRecordId: record.id,
        expectedStatus: "charge_pending",
        expectedProviderStatus: "publish_pending",
        expectedUpdatedAt: now,
        ...(record.squareInvoiceId !== undefined
          ? { expectedSquareInvoiceId: record.squareInvoiceId }
          : {}),
        status: "manual_followup",
        providerFailureReason: reason,
      });
    } catch (error) {
      const persistenceReason =
        error instanceof Error
          ? error.message
          : "Failed to persist manual follow-up for missing no-show provider reference";
      await alerts.alert({
        category: "no_show_charge_persistence_failed",
        severity: "error",
        message:
          "Could not persist manual follow-up for missing no-show provider reference",
        context: {
          noShowChargeRecordId: record.id,
          reason: persistenceReason,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: persistenceReason,
      };
    }

    await alerts.alert({
      category: "no_show_charge_failed",
      severity: "warning",
      message: "Cannot publish no-show invoice: missing provider reference",
      context: {
        noShowChargeRecordId: record.id,
        reason,
      },
    });

    return {
      chargeStatus: "manual_followup",
      noShowChargeRecordId: record.id,
      failureReason: reason,
    };
  }

  // Post-publish record updates always use strict compare-and-set against the
  // charge_pending/publish_pending snapshot that this request created. A
  // concurrent webhook finalizer or stale recovery can move the row to a
  // terminal state while Square publish is in flight; the CAS write refuses to
  // overwrite it and the catch path returns manual_followup.
  if (record === null) {
    throw new NoShowInvoiceChargeError("No-show charge record not found");
  }

  async function finalizeRecord(updates: {
    status?: NoShowChargeStatus;
    squareInvoiceId?: string;
    squareOrderId?: string;
    squarePaymentId?: string;
    providerStatus?: string;
    providerFailureReason?: string;
    providerMetadata?: BookingNoShowProviderMetadata;
    chargedAt?: Date;
  }): Promise<NoShowChargeRecord> {
    return repository.updateNoShowChargeRecordIfExpectedState({
      noShowChargeRecordId: record!.id,
      expectedStatus: "charge_pending",
      expectedProviderStatus: "publish_pending",
      expectedSquareInvoiceId: record!.squareInvoiceId,
      expectedUpdatedAt: now,
      ...updates,
    });
  }

  let publishResponse: SquarePublishInvoiceResponse;
  try {
    const publishRequest: SquarePublishInvoiceRequest = {
      idempotency_key: input.idempotencyKey,
      version: invoiceVersion,
    };
    publishResponse = await squareInvoices.publishInvoice(
      record.squareInvoiceId,
      publishRequest,
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Square invoice publish failed";
    await alerts.alert({
      category: "no_show_publish_unknown",
      severity: "warning",
      message: "Square no-show invoice publish attempt did not complete",
      context: {
        noShowChargeRecordId: record.id,
        squareInvoiceId: record.squareInvoiceId,
        reason,
      },
    });

    return {
      chargeStatus: "charge_pending",
      noShowChargeRecordId: record.id,
    };
  }

  const status = publishResponse.invoice.status;
  const paymentId = (publishResponse.invoice as { payment_id?: string })
    .payment_id;

  if (status === "PAID" && typeof paymentId === "string") {
    try {
      await repository.updateNoShowChargeAttempt({
        attemptId: attempt.id,
        status: "charged",
        squarePaymentId: paymentId,
        squareInvoiceId: record.squareInvoiceId,
        processedAt: now,
      });
      await finalizeRecord({
        status: "charged",
        squarePaymentId: paymentId,
        providerStatus: status,
        chargedAt: now,
      });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Failed to persist Square charge result";
      await alerts.alert({
        category: "no_show_charge_finalize_failed",
        severity: "error",
        message: "Square charged no-show invoice but local persistence failed",
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          squarePaymentId: paymentId,
          reason,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: reason,
      };
    }

    return {
      chargeStatus: "charged",
      noShowChargeRecordId: record.id,
      squarePaymentId: paymentId,
    };
  }

  if (status === "PAID" && paymentId === undefined) {
    const manualReason =
      "Square published no-show invoice as PAID without a payment id and cannot be auto-finalized";
    try {
      await repository.updateNoShowChargeAttempt({
        attemptId: attempt.id,
        status: "charge_pending",
        squareInvoiceId: record.squareInvoiceId,
        processedAt: now,
      });
      await finalizeRecord({
        status: "manual_followup",
        providerStatus: status,
        providerFailureReason: manualReason,
      });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Failed to persist Square PAID-without-payment-id result";
      await alerts.alert({
        category: "no_show_charge_finalize_failed",
        severity: "error",
        message:
          "Square published no-show invoice as PAID without payment id but local persistence failed",
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          providerStatus: status,
          reason,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: reason,
      };
    }

    await alerts.alert({
      category: "no_show_charge_paid_without_payment_id",
      severity: "warning",
      message: manualReason,
      context: {
        noShowChargeRecordId: record.id,
        squareInvoiceId: record.squareInvoiceId,
        providerStatus: status,
      },
    });

    return {
      chargeStatus: "manual_followup",
      noShowChargeRecordId: record.id,
      failureReason: manualReason,
    };
  }

  if (isTerminalFailureStatus(status)) {
    const reason = `Square invoice publish returned terminal status ${status}`;
    try {
      await repository.updateNoShowChargeAttempt({
        attemptId: attempt.id,
        status: "charge_failed",
        failureReason: reason,
        squareInvoiceId: record.squareInvoiceId,
        processedAt: now,
      });
      await finalizeRecord({
        status: "charge_failed",
        providerStatus: status,
        providerFailureReason: reason,
      });
    } catch (error) {
      const persistenceReason =
        error instanceof Error
          ? error.message
          : "Failed to persist Square terminal failure result";
      await alerts.alert({
        category: "no_show_charge_persistence_failed",
        severity: "error",
        message:
          "No-show invoice publish resulted in a terminal failure status but local persistence failed",
        context: {
          noShowChargeRecordId: record.id,
          squareInvoiceId: record.squareInvoiceId,
          providerStatus: status,
          reason: persistenceReason,
        },
      });

      return {
        chargeStatus: "manual_followup",
        noShowChargeRecordId: record.id,
        failureReason: persistenceReason,
      };
    }

    await alerts.alert({
      category: "no_show_charge_failed",
      severity: "warning",
      message: "No-show invoice publish resulted in a terminal failure status",
      context: {
        noShowChargeRecordId: record.id,
        squareInvoiceId: record.squareInvoiceId,
        providerStatus: status,
        reason,
      },
    });

    return {
      chargeStatus: "charge_failed",
      noShowChargeRecordId: record.id,
      failureReason: reason,
    };
  }

  // Ambiguous non-terminal provider statuses (UNPAID, SCHEDULED, PAYMENT_PENDING,
  // PARTIALLY_PAID, unknown) remain pending until a webhook or reconciliation
  // updates the record. Do not treat them as a definitive failure.
  try {
    await repository.updateNoShowChargeAttempt({
      attemptId: attempt.id,
      status: "charge_pending",
      squareInvoiceId: record.squareInvoiceId,
      processedAt: now,
    });
    await finalizeRecord({
      status: "charge_pending",
      providerStatus: status,
    });
  } catch (error) {
    const persistenceReason =
      error instanceof Error
        ? error.message
        : "Failed to persist Square pending status result";
    await alerts.alert({
      category: "no_show_charge_persistence_failed",
      severity: "error",
      message: `No-show invoice publish returned non-final status ${status} but local persistence failed`,
      context: {
        noShowChargeRecordId: record.id,
        squareInvoiceId: record.squareInvoiceId,
        providerStatus: status,
        reason: persistenceReason,
      },
    });

    return {
      chargeStatus: "charge_pending",
      noShowChargeRecordId: record.id,
      failureReason: persistenceReason,
    };
  }

  await alerts.alert({
    category: "no_show_charge_pending_reconciliation",
    severity: "warning",
    message: `No-show invoice publish returned non-final status ${status}; awaiting reconciliation`,
    context: {
      noShowChargeRecordId: record.id,
      squareInvoiceId: record.squareInvoiceId,
      providerStatus: status,
    },
  });

  return {
    chargeStatus: "charge_pending",
    noShowChargeRecordId: record.id,
  };
}

function isTerminalFailureStatus(status: string): boolean {
  return status === "CANCELED" || status === "FAILED";
}

export function isStaleChargePending(
  record: Pick<
    NoShowChargeRecordDetail,
    "status" | "providerStatus" | "updatedAt"
  >,
  now: Date,
): boolean {
  if (
    record.status !== "charge_pending" ||
    record.providerStatus !== "publish_pending"
  ) {
    return false;
  }

  if (record.updatedAt === undefined) {
    return false;
  }

  return now.getTime() - record.updatedAt.getTime() >= STALE_CHARGE_PENDING_MS;
}

function resultFromAttempt(
  noShowChargeRecordId: string,
  attempt: NoShowChargeAttempt,
): ChargeNoShowInvoiceResult {
  if (attempt.status === "charged") {
    return {
      chargeStatus: "charged",
      noShowChargeRecordId,
      squarePaymentId: attempt.squarePaymentId,
    };
  }

  if (attempt.status === "charge_failed") {
    return {
      chargeStatus: "charge_failed",
      noShowChargeRecordId,
      failureReason: attempt.failureReason,
    };
  }

  if (attempt.status === "charge_pending") {
    return {
      chargeStatus: "charge_pending",
      noShowChargeRecordId,
    };
  }

  return {
    chargeStatus: "manual_followup",
    noShowChargeRecordId,
  };
}

function getInvoiceVersion(
  record: NoShowChargeRecordDetail,
): number | undefined {
  const metadata = record.providerMetadata ?? {};
  const version = metadata.squareInvoiceVersion;

  if (typeof version === "number") {
    return version;
  }

  return undefined;
}

function buildNoShowChargeAmountSnapshot(
  input: CreateDraftNoShowInvoiceInput,
): NoShowChargeAmountSnapshot {
  const existingSnapshot = input.providerMetadata?.amountSnapshot as
    | NoShowChargeAmountSnapshot
    | undefined;
  const chargeableAmountCents =
    input.chargeableAmountCents ?? input.maxChargeCents;
  const fullBookedQuote = calculateServiceBookingHstQuote(input.maxChargeCents);
  const paidAtBookingCents = Math.max(
    0,
    input.maxChargeCents - chargeableAmountCents,
  );
  const paidAtBookingTaxCents =
    paidAtBookingCents > 0
      ? calculateServiceBookingHstQuote(paidAtBookingCents).taxAmountCents
      : 0;
  const remainingQuote = calculateServiceBookingHstQuote(chargeableAmountCents);

  return {
    ...existingSnapshot,
    fullBookedServiceAmountCents: input.maxChargeCents,
    paidAtBookingCents,
    remainingBalanceCents: chargeableAmountCents,
    fullBookedServiceTaxCents: fullBookedQuote.taxAmountCents,
    fullBookedServiceTotalCents: fullBookedQuote.expectedAmountCents,
    paidAtBookingTaxCents,
    paidAtBookingTotalCents: paidAtBookingCents + paidAtBookingTaxCents,
    remainingBalanceTaxCents: remainingQuote.taxAmountCents,
    remainingBalanceWithTaxCents: remainingQuote.expectedAmountCents,
  };
}

function buildOrderRequest(
  input: CreateDraftNoShowInvoiceInput,
  locationId: string,
): SquareCreateOrderRequest {
  const chargeableAmountCents =
    input.chargeableAmountCents ?? input.maxChargeCents;
  const paidAtBookingCents = Math.max(
    0,
    input.maxChargeCents - chargeableAmountCents,
  );
  const discounts =
    paidAtBookingCents > 0
      ? [
          {
            amount_money: {
              amount: paidAtBookingCents,
              currency: "CAD",
            },
            name: "Paid at booking",
            scope: "ORDER" as const,
            type: "FIXED_AMOUNT" as const,
            uid: "paid-at-booking",
          },
        ]
      : undefined;

  return {
    idempotency_key: input.idempotencyKey,
    order: {
      location_id: locationId,
      reference_id: input.holdId,
      source: { name: "Lash Her Booking No-Show" },
      metadata: {
        noShowChargeRecordId: input.noShowChargeRecordId,
        holdId: input.holdId,
      },
      ...(discounts !== undefined ? { discounts } : {}),
      line_items: [
        {
          applied_taxes: [{ tax_uid: SERVICE_BOOKING_HST_TAX_UID }],
          name: input.serviceDescription,
          quantity: "1",
          base_price_money: {
            amount: input.maxChargeCents,
            currency: "CAD",
          },
        },
      ],
      taxes: [
        {
          name: SERVICE_BOOKING_HST_TAX_NAME,
          percentage: SERVICE_BOOKING_HST_PERCENTAGE,
          scope: "LINE_ITEM",
          type: "ADDITIVE",
          uid: SERVICE_BOOKING_HST_TAX_UID,
        },
      ],
    },
  };
}

function buildInvoiceRequest(
  input: CreateDraftNoShowInvoiceInput,
  locationId: string,
  orderId: string,
): SquareCreateInvoiceRequest {
  return {
    idempotency_key: input.idempotencyKey,
    invoice: {
      order_id: orderId,
      location_id: locationId,
      primary_recipient: {
        customer_id: input.customerId,
      },
      accepted_payment_methods: { card: true },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: formatInvoiceDueDate(new Date()),
          automatic_payment_source: "CARD_ON_FILE",
          card_id: input.cardId,
        },
      ],
      delivery_method: "EMAIL",
    },
  };
}

function formatInvoiceDueDate(date: Date): string {
  const dueDate = new Date(date);
  dueDate.setUTCDate(dueDate.getUTCDate() + 30);

  const year = dueDate.getUTCFullYear();
  const month = String(dueDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dueDate.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
