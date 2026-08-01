import "server-only";

import {
  SQL,
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import type {
  SquareGetPaymentResponse,
  SquarePaymentsClient,
} from "@/lib/payments/square/payments-client";
import {
  createServicePaymentAlertLogger,
  type ServicePaymentAlertLogger,
} from "@/lib/booking/payments/service-payment-alerts";
import { STALE_CHARGE_PENDING_MS } from "@/lib/booking/payments/service-no-show-invoice";
import {
  appointmentHolds,
  appointments,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  bookingPolicyAcceptances,
  bookingSavedPaymentMethods,
  bookingSquareCustomers,
  checkoutOrders,
  checkoutPaymentEvents,
  type CalendarFinalizationStatus,
  type CheckoutOrderPurpose,
  type NoShowChargeStatus,
  type PaymentEventProcessingStatus,
} from "@/lib/private-db/schema";

export interface ServiceReconciliationFinding {
  category:
    | "confirmed_booking_without_no_show_invoice"
    | "square_payment_pending_too_long"
    | "paid_booking_not_booked"
    | "failed_no_show_charge"
    | "booked_without_saved_payment_method"
    | "booked_without_policy_acceptance"
    | "booked_without_no_show_charge_record"
    | "no_show_charge_failed_not_alerted"
    | "square_invoice_payment_event_not_reconciled"
    | "payment_amount_currency_customer_mismatch"
    | "no_show_charge_pending_too_long"
    | "operational_appointment_calendar_pending_too_long"
    | "operational_appointment_without_captured_payment"
    | "captured_payment_without_operational_appointment"
    | "authorized_payment_pending_capture"
    | "authorized_payment_provider_state_unverified"
    | "authorized_payment_provider_terminal_mismatch"
    | "authorized_payment_provider_evidence_mismatch"
    | "provider_completed_payment_evidence_mismatch"
    | "provider_completed_payment_without_operational_appointment";
  appointmentId?: string;
  paymentAttemptId?: string;
  holdId?: string;
  orderId?: string;
  noShowChargeRecordId?: string;
  status?: NoShowChargeStatus;
  eventId?: string;
  processingStatus?: PaymentEventProcessingStatus;
  savedPaymentMethodId?: string;
  policyAcceptanceId?: string;
  mismatchType?: "amount_currency" | "customer" | "card" | "hold_record_link";
  providerStatus?: string;
  severity: "warning" | "error";
}

export interface ServiceReconciliationSummary {
  findings: ServiceReconciliationFinding[];
  ok: boolean;
  checkedAt: string;
}

export interface ServiceReconciliationRepository {
  findAuthorizedOperationalPayments(now: Date): Promise<
    Array<{
      amountCents: number;
      currency: string;
      holdId: string;
      idempotencyKey: string;
      paymentAttemptId: string;
      referenceId: string;
      squareCustomerId: string;
      squareOrderId?: string;
      squarePaymentId: string;
      squareTeamMemberId?: string;
    }>
  >;
  recordProviderCompletedOperationalPayment(input: {
    amountCents: number;
    currency: string;
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squareOrderId?: string;
    squarePaymentId: string;
  }): Promise<void>;
  markOperationalPaymentFailed(input: {
    holdId: string;
    now: Date;
    reason: string;
  }): Promise<void>;
  markOperationalPaymentRefundRequired(input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    providerEvidence: "cancellation_unconfirmed" | "completed";
    reason: string;
    squarePaymentId: string;
  }): Promise<void>;
  markOperationalPaymentTerminated(input: {
    holdId: string;
    idempotencyKey: string;
    now: Date;
    squarePaymentId: string;
    status: "cancelled" | "failed";
  }): Promise<"cancelled" | "failed" | "capture_preserved" | "not_found">;
  findCapturedPaymentsWithoutOperationalAppointment(
    now: Date,
  ): Promise<Array<{ holdId?: string; paymentAttemptId: string }>>;
  findConfirmedBookingsWithoutNoShowInvoice(
    now: Date,
  ): Promise<Array<{ holdId: string }>>;
  findSquarePaymentsPendingTooLong(
    now: Date,
  ): Promise<Array<{ holdId: string; orderId?: string }>>;
  findPaidBookingsNotBooked(
    now: Date,
  ): Promise<Array<{ holdId: string; orderId?: string }>>;
  findOperationalAppointmentsPendingCalendar(
    now: Date,
  ): Promise<Array<{ appointmentId: string; holdId?: string }>>;
  findOperationalAppointmentsWithoutCapturedPayment(
    now: Date,
  ): Promise<Array<{ appointmentId: string; holdId?: string }>>;
  findFailedNoShowCharges(
    now: Date,
  ): Promise<Array<{ holdId: string; orderId?: string }>>;
  findBookedAppointmentsWithoutSavedPaymentMethod(
    now: Date,
  ): Promise<Array<{ holdId: string }>>;
  findBookedAppointmentsWithoutPolicyAcceptance(
    now: Date,
  ): Promise<Array<{ holdId: string }>>;
  findBookedAppointmentsWithoutNoShowChargeRecord(
    now: Date,
  ): Promise<Array<{ holdId: string }>>;
  findNoShowChargeFailedNotAlerted(now: Date): Promise<
    Array<{
      holdId: string;
      noShowChargeRecordId: string;
      status: NoShowChargeStatus;
    }>
  >;
  findNoShowChargesPendingTooLong(now: Date): Promise<
    Array<{
      holdId: string;
      noShowChargeRecordId: string;
      status: NoShowChargeStatus;
    }>
  >;
  findSquareInvoicePaymentEventsNotReconciled(now: Date): Promise<
    Array<{
      eventId: string;
      noShowChargeRecordId: string;
      processingStatus: PaymentEventProcessingStatus;
    }>
  >;
  findAmountCurrencyCustomerMismatches(now: Date): Promise<
    Array<{
      holdId: string;
      noShowChargeRecordId: string;
      savedPaymentMethodId?: string;
      policyAcceptanceId?: string;
      mismatchType:
        | "amount_currency"
        | "customer"
        | "card"
        | "hold_record_link";
    }>
  >;
}

export interface ServiceReconciliationMonitorDependencies {
  alerts?: ServicePaymentAlertLogger;
  providerPayments?: Pick<SquarePaymentsClient, "getPayment"> &
    Partial<Pick<SquarePaymentsClient, "cancelPayment">>;
  repository: ServiceReconciliationRepository;
}

const PENDING_PAYMENT_THRESHOLD_MS = 30 * 60 * 1000;
const PAID_NOT_BOOKED_THRESHOLD_MS = 15 * 60 * 1000;
const CHARGE_FAILED_ALERT_THRESHOLD_MS = 5 * 60 * 1000;
const BOOKED_CALENDAR_STATUSES: CalendarFinalizationStatus[] = [
  "not_required",
  "booked",
  "manual_rebooked",
];
const APPOINTMENT_CHECKOUT_ORDER_PURPOSES: CheckoutOrderPurpose[] = [
  "appointment_deposit",
  "appointment_full",
  "appointment_custom_partial",
];

async function runReconciliationCheck<T>(
  checkName: keyof ServiceReconciliationRepository,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`Reconciliation check "${String(checkName)}" failed`, {
      cause: error,
    });
  }
}

function handledNoShowPaymentEventExists(): SQL {
  return sql`
    (select 1
     from ${checkoutPaymentEvents}
     where ${checkoutPaymentEvents.noShowChargeRecordId} = ${bookingNoShowChargeRecords.id}
     and ${checkoutPaymentEvents.processingStatus} in ('processed', 'duplicate', 'ignored', 'failed'))
  `;
}

export function createServiceReconciliationMonitor(
  dependencies: ServiceReconciliationMonitorDependencies,
): {
  run(input?: { now?: Date }): Promise<ServiceReconciliationSummary>;
} {
  return {
    async run(input): Promise<ServiceReconciliationSummary> {
      const now = input?.now ?? new Date();

      const [
        authorizedOperationalPayments,
        confirmedWithoutNoShowInvoice,
        squarePaymentsPendingTooLong,
        paidBookingsNotBooked,
        failedNoShowCharges,
        bookedWithoutSavedPaymentMethod,
        bookedWithoutPolicyAcceptance,
        bookedWithoutNoShowChargeRecord,
        noShowChargeFailedNotAlerted,
        noShowChargesPendingTooLong,
        squareInvoicePaymentEventsNotReconciled,
        amountCurrencyCustomerMismatches,
        operationalAppointmentsPendingCalendar,
        operationalAppointmentsWithoutCapturedPayment,
        capturedPaymentsWithoutOperationalAppointment,
      ] = await Promise.all([
        runReconciliationCheck("findAuthorizedOperationalPayments", () =>
          dependencies.repository.findAuthorizedOperationalPayments(now),
        ),
        runReconciliationCheck(
          "findConfirmedBookingsWithoutNoShowInvoice",
          () =>
            dependencies.repository.findConfirmedBookingsWithoutNoShowInvoice(
              now,
            ),
        ),
        runReconciliationCheck("findSquarePaymentsPendingTooLong", () =>
          dependencies.repository.findSquarePaymentsPendingTooLong(now),
        ),
        runReconciliationCheck("findPaidBookingsNotBooked", () =>
          dependencies.repository.findPaidBookingsNotBooked(now),
        ),
        runReconciliationCheck("findFailedNoShowCharges", () =>
          dependencies.repository.findFailedNoShowCharges(now),
        ),
        runReconciliationCheck(
          "findBookedAppointmentsWithoutSavedPaymentMethod",
          () =>
            dependencies.repository.findBookedAppointmentsWithoutSavedPaymentMethod(
              now,
            ),
        ),
        runReconciliationCheck(
          "findBookedAppointmentsWithoutPolicyAcceptance",
          () =>
            dependencies.repository.findBookedAppointmentsWithoutPolicyAcceptance(
              now,
            ),
        ),
        runReconciliationCheck(
          "findBookedAppointmentsWithoutNoShowChargeRecord",
          () =>
            dependencies.repository.findBookedAppointmentsWithoutNoShowChargeRecord(
              now,
            ),
        ),
        runReconciliationCheck("findNoShowChargeFailedNotAlerted", () =>
          dependencies.repository.findNoShowChargeFailedNotAlerted(now),
        ),
        runReconciliationCheck("findNoShowChargesPendingTooLong", () =>
          dependencies.repository.findNoShowChargesPendingTooLong(now),
        ),
        runReconciliationCheck(
          "findSquareInvoicePaymentEventsNotReconciled",
          () =>
            dependencies.repository.findSquareInvoicePaymentEventsNotReconciled(
              now,
            ),
        ),
        runReconciliationCheck("findAmountCurrencyCustomerMismatches", () =>
          dependencies.repository.findAmountCurrencyCustomerMismatches(now),
        ),
        runReconciliationCheck(
          "findOperationalAppointmentsPendingCalendar",
          () =>
            dependencies.repository.findOperationalAppointmentsPendingCalendar(
              now,
            ),
        ),
        runReconciliationCheck(
          "findOperationalAppointmentsWithoutCapturedPayment",
          () =>
            dependencies.repository.findOperationalAppointmentsWithoutCapturedPayment(
              now,
            ),
        ),
        runReconciliationCheck(
          "findCapturedPaymentsWithoutOperationalAppointment",
          () =>
            dependencies.repository.findCapturedPaymentsWithoutOperationalAppointment(
              now,
            ),
        ),
      ]);

      const authorizedPaymentFindings =
        await reconcileAuthorizedOperationalPayments({
          attempts: authorizedOperationalPayments,
          dependencies,
          now,
        });

      const findings: ServiceReconciliationFinding[] = [
        ...authorizedPaymentFindings,
        ...confirmedWithoutNoShowInvoice.map(
          (row): ServiceReconciliationFinding => ({
            category: "confirmed_booking_without_no_show_invoice",
            holdId: row.holdId,
            severity: "warning",
          }),
        ),
        ...squarePaymentsPendingTooLong.map(
          (row): ServiceReconciliationFinding => ({
            category: "square_payment_pending_too_long",
            holdId: row.holdId,
            orderId: row.orderId,
            severity: "error",
          }),
        ),
        ...paidBookingsNotBooked.map(
          (row): ServiceReconciliationFinding => ({
            category: "paid_booking_not_booked",
            holdId: row.holdId,
            orderId: row.orderId,
            severity: "error",
          }),
        ),
        ...failedNoShowCharges.map(
          (row): ServiceReconciliationFinding => ({
            category: "failed_no_show_charge",
            holdId: row.holdId,
            orderId: row.orderId,
            severity: "error",
          }),
        ),
        ...bookedWithoutSavedPaymentMethod.map(
          (row): ServiceReconciliationFinding => ({
            category: "booked_without_saved_payment_method",
            holdId: row.holdId,
            severity: "warning",
          }),
        ),
        ...bookedWithoutPolicyAcceptance.map(
          (row): ServiceReconciliationFinding => ({
            category: "booked_without_policy_acceptance",
            holdId: row.holdId,
            severity: "warning",
          }),
        ),
        ...bookedWithoutNoShowChargeRecord.map(
          (row): ServiceReconciliationFinding => ({
            category: "booked_without_no_show_charge_record",
            holdId: row.holdId,
            severity: "warning",
          }),
        ),
        ...noShowChargeFailedNotAlerted.map(
          (row): ServiceReconciliationFinding => ({
            category: "no_show_charge_failed_not_alerted",
            holdId: row.holdId,
            noShowChargeRecordId: row.noShowChargeRecordId,
            status: row.status,
            severity: "error",
          }),
        ),
        ...noShowChargesPendingTooLong.map(
          (row): ServiceReconciliationFinding => ({
            category: "no_show_charge_pending_too_long",
            holdId: row.holdId,
            noShowChargeRecordId: row.noShowChargeRecordId,
            status: row.status,
            severity: "error",
          }),
        ),
        ...squareInvoicePaymentEventsNotReconciled.map(
          (row): ServiceReconciliationFinding => ({
            category: "square_invoice_payment_event_not_reconciled",
            eventId: row.eventId,
            noShowChargeRecordId: row.noShowChargeRecordId,
            processingStatus: row.processingStatus,
            severity: "warning",
          }),
        ),
        ...amountCurrencyCustomerMismatches.map(
          (row): ServiceReconciliationFinding => ({
            category: "payment_amount_currency_customer_mismatch",
            holdId: row.holdId,
            noShowChargeRecordId: row.noShowChargeRecordId,
            savedPaymentMethodId: row.savedPaymentMethodId,
            policyAcceptanceId: row.policyAcceptanceId,
            mismatchType: row.mismatchType,
            severity: "error",
          }),
        ),
        ...operationalAppointmentsPendingCalendar.map(
          (row): ServiceReconciliationFinding => ({
            appointmentId: row.appointmentId,
            category: "operational_appointment_calendar_pending_too_long",
            holdId: row.holdId,
            severity: "error",
          }),
        ),
        ...operationalAppointmentsWithoutCapturedPayment.map(
          (row): ServiceReconciliationFinding => ({
            appointmentId: row.appointmentId,
            category: "operational_appointment_without_captured_payment",
            holdId: row.holdId,
            severity: "error",
          }),
        ),
        ...capturedPaymentsWithoutOperationalAppointment.map(
          (row): ServiceReconciliationFinding => ({
            category: "captured_payment_without_operational_appointment",
            holdId: row.holdId,
            paymentAttemptId: row.paymentAttemptId,
            severity: "error",
          }),
        ),
      ];

      return {
        findings,
        ok: findings.length === 0,
        checkedAt: now.toISOString(),
      };
    },
  };
}

async function reconcileAuthorizedOperationalPayments(input: {
  attempts: Awaited<
    ReturnType<
      ServiceReconciliationRepository["findAuthorizedOperationalPayments"]
    >
  >;
  dependencies: ServiceReconciliationMonitorDependencies;
  now: Date;
}): Promise<ServiceReconciliationFinding[]> {
  const findings: ServiceReconciliationFinding[] = [];

  for (const attempt of input.attempts) {
    if (input.dependencies.providerPayments === undefined) {
      findings.push({
        category: "authorized_payment_provider_state_unverified",
        holdId: attempt.holdId,
        paymentAttemptId: attempt.paymentAttemptId,
        severity: "error",
      });
      continue;
    }

    let providerResponse: SquareGetPaymentResponse;
    try {
      providerResponse = await input.dependencies.providerPayments.getPayment(
        attempt.squarePaymentId,
      );
    } catch {
      findings.push({
        category: "authorized_payment_provider_state_unverified",
        holdId: attempt.holdId,
        paymentAttemptId: attempt.paymentAttemptId,
        severity: "error",
      });
      continue;
    }

    const payment = providerResponse.payment;
    const providerStatus = payment.status.trim().toUpperCase();
    const evidenceMatches = providerPaymentMatchesAuthorizedAttempt(
      payment,
      attempt,
    );
    if (providerStatus === "COMPLETED") {
      if (!evidenceMatches) {
        await markReconciliationRefundRequired({
          attempt,
          dependencies: input.dependencies,
          now: input.now,
          providerEvidence: "completed",
          reason:
            "Provider-completed Square payment evidence did not match the immutable operational attempt; refund required",
        });
        findings.push({
          category: "provider_completed_payment_evidence_mismatch",
          holdId: attempt.holdId,
          paymentAttemptId: attempt.paymentAttemptId,
          providerStatus,
          severity: "error",
        });
        continue;
      }

      try {
        await input.dependencies.repository.recordProviderCompletedOperationalPayment(
          {
            amountCents: attempt.amountCents,
            currency: attempt.currency,
            holdId: attempt.holdId,
            idempotencyKey: attempt.idempotencyKey,
            now: input.now,
            squareOrderId: payment.order_id ?? attempt.squareOrderId,
            squarePaymentId: payment.id,
          },
        );
      } catch {
        findings.push({
          category:
            "provider_completed_payment_without_operational_appointment",
          holdId: attempt.holdId,
          paymentAttemptId: attempt.paymentAttemptId,
          providerStatus,
          severity: "error",
        });
      }
      continue;
    }

    if (providerStatus === "APPROVED" && !evidenceMatches) {
      await cancelMismatchedAuthorization({
        attempt,
        dependencies: input.dependencies,
        now: input.now,
      });
      findings.push({
        category: "authorized_payment_provider_evidence_mismatch",
        holdId: attempt.holdId,
        paymentAttemptId: attempt.paymentAttemptId,
        providerStatus,
        severity: "error",
      });
      continue;
    }

    if (["CANCELED", "FAILED", "DECLINED"].includes(providerStatus)) {
      try {
        const outcome =
          await input.dependencies.repository.markOperationalPaymentTerminated({
            holdId: attempt.holdId,
            idempotencyKey: attempt.idempotencyKey,
            now: input.now,
            squarePaymentId: attempt.squarePaymentId,
            status: providerStatus === "CANCELED" ? "cancelled" : "failed",
          });
        if (outcome === "cancelled" || outcome === "failed") {
          await input.dependencies.repository.markOperationalPaymentFailed({
            holdId: attempt.holdId,
            now: input.now,
            reason: `Square reports the operational authorization as ${providerStatus}`,
          });
        }
      } catch (error) {
        await alertReconciliationFailure(
          input.dependencies,
          "Failed to persist terminal Square authorization evidence",
          attempt,
          error,
        );
      }
      findings.push({
        category: "authorized_payment_provider_terminal_mismatch",
        holdId: attempt.holdId,
        paymentAttemptId: attempt.paymentAttemptId,
        providerStatus,
        severity: "error",
      });
      continue;
    }

    findings.push({
      category: "authorized_payment_pending_capture",
      holdId: attempt.holdId,
      paymentAttemptId: attempt.paymentAttemptId,
      providerStatus,
      severity: "error",
    });
  }

  return findings;
}

async function cancelMismatchedAuthorization(input: {
  attempt: Awaited<
    ReturnType<
      ServiceReconciliationRepository["findAuthorizedOperationalPayments"]
    >
  >[number];
  dependencies: ServiceReconciliationMonitorDependencies;
  now: Date;
}): Promise<void> {
  await (input.dependencies.alerts ?? defaultAlerts).alert({
    category: "stuck_payment_state",
    severity: "error",
    message:
      "Reconciliation found a Square authorization that did not match immutable operational payment evidence",
    context: {
      holdId: input.attempt.holdId,
      paymentAttemptId: input.attempt.paymentAttemptId,
      squarePaymentId: input.attempt.squarePaymentId,
    },
  });

  try {
    const cancelPayment = input.dependencies.providerPayments?.cancelPayment;
    if (cancelPayment !== undefined) {
      const cancellation = await cancelPayment(input.attempt.squarePaymentId);
      if (
        cancellation.payment.id === input.attempt.squarePaymentId &&
        cancellation.payment.status.trim().toUpperCase() === "CANCELED"
      ) {
        const outcome =
          await input.dependencies.repository.markOperationalPaymentTerminated({
            holdId: input.attempt.holdId,
            idempotencyKey: input.attempt.idempotencyKey,
            now: input.now,
            squarePaymentId: input.attempt.squarePaymentId,
            status: "cancelled",
          });
        if (outcome === "cancelled") {
          await input.dependencies.repository.markOperationalPaymentFailed({
            holdId: input.attempt.holdId,
            now: input.now,
            reason:
              "Square authorization evidence mismatch; cancellation confirmed",
          });
          return;
        }
      }
    }
  } catch (error) {
    await alertReconciliationFailure(
      input.dependencies,
      "Failed to cancel a mismatched Square authorization during reconciliation",
      input.attempt,
      error,
    );
  }

  await markReconciliationRefundRequired({
    attempt: input.attempt,
    dependencies: input.dependencies,
    now: input.now,
    providerEvidence: "cancellation_unconfirmed",
    reason:
      "Square authorization evidence mismatch and cancellation could not be confirmed; manual follow-up required",
  });
}

async function markReconciliationRefundRequired(input: {
  attempt: Awaited<
    ReturnType<
      ServiceReconciliationRepository["findAuthorizedOperationalPayments"]
    >
  >[number];
  dependencies: ServiceReconciliationMonitorDependencies;
  now: Date;
  providerEvidence: "cancellation_unconfirmed" | "completed";
  reason: string;
}): Promise<void> {
  await (input.dependencies.alerts ?? defaultAlerts).alert({
    category: "stuck_payment_state",
    severity: "error",
    message: input.reason,
    context: {
      holdId: input.attempt.holdId,
      paymentAttemptId: input.attempt.paymentAttemptId,
      squarePaymentId: input.attempt.squarePaymentId,
    },
  });

  try {
    await input.dependencies.repository.markOperationalPaymentRefundRequired({
      holdId: input.attempt.holdId,
      idempotencyKey: input.attempt.idempotencyKey,
      now: input.now,
      providerEvidence: input.providerEvidence,
      reason: input.reason,
      squarePaymentId: input.attempt.squarePaymentId,
    });
  } catch (error) {
    await alertReconciliationFailure(
      input.dependencies,
      "Failed to persist operational payment manual follow-up state",
      input.attempt,
      error,
    );
  }
}

async function alertReconciliationFailure(
  dependencies: ServiceReconciliationMonitorDependencies,
  message: string,
  attempt: Awaited<
    ReturnType<
      ServiceReconciliationRepository["findAuthorizedOperationalPayments"]
    >
  >[number],
  error: unknown,
): Promise<void> {
  await (dependencies.alerts ?? defaultAlerts).alert({
    category: "stuck_payment_state",
    severity: "error",
    message,
    context: {
      error: error instanceof Error ? error.message : "Unknown error",
      holdId: attempt.holdId,
      paymentAttemptId: attempt.paymentAttemptId,
      squarePaymentId: attempt.squarePaymentId,
    },
  });
}

const defaultAlerts = createServicePaymentAlertLogger({});

function providerPaymentMatchesAuthorizedAttempt(
  payment: SquareGetPaymentResponse["payment"],
  attempt: Awaited<
    ReturnType<
      ServiceReconciliationRepository["findAuthorizedOperationalPayments"]
    >
  >[number],
): boolean {
  return (
    payment.id === attempt.squarePaymentId &&
    payment.amount_money.amount === attempt.amountCents &&
    payment.amount_money.currency.trim().toUpperCase() ===
      attempt.currency.trim().toUpperCase() &&
    payment.customer_id === attempt.squareCustomerId &&
    payment.reference_id === attempt.referenceId &&
    (payment.team_member_id ?? undefined) === attempt.squareTeamMemberId
  );
}

function readSquareRequestIntent(value: unknown): {
  squareCustomerId: string;
} | null {
  if (!isRecord(value) || !isRecord(value.squareRequestIntent)) return null;
  const squareCustomerId = value.squareRequestIntent.squareCustomerId;
  return typeof squareCustomerId === "string" && squareCustomerId.length > 0
    ? { squareCustomerId }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default async function runServiceReconciliationMonitor(input?: {
  now?: Date;
}): Promise<ServiceReconciliationSummary> {
  const [
    { createSquarePaymentsClient },
    { getSquareServiceBookingRuntimeEnv },
  ] = await Promise.all([
    import("@/lib/payments/square/payments-client"),
    import("@/lib/booking/square-runtime"),
  ]);
  const squareEnv = getSquareServiceBookingRuntimeEnv();
  const monitor = createServiceReconciliationMonitor({
    providerPayments:
      squareEnv === null ? undefined : createSquarePaymentsClient(squareEnv),
    repository: createDrizzleServiceReconciliationRepository(),
  });

  return monitor.run(input);
}

export function createDrizzleServiceReconciliationRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): ServiceReconciliationRepository {
  let paymentRepositoryPromise:
    | ReturnType<
        (typeof import("@/lib/private-db/service-booking-payment-repository"))["createServiceBookingPaymentRepository"]
      >
    | undefined;
  return {
    async findAuthorizedOperationalPayments() {
      const rows = await db
        .select({
          amountCents: bookingPaymentAttempts.amountCents,
          currency: bookingPaymentAttempts.currency,
          holdId: bookingPaymentAttempts.holdId,
          idempotencyKey: bookingPaymentAttempts.idempotencyKey,
          paymentAttemptId: bookingPaymentAttempts.id,
          providerMetadata: bookingPaymentAttempts.providerMetadata,
          referenceId: appointmentHolds.publicReference,
          squareOrderId: bookingPaymentAttempts.providerOrderId,
          squarePaymentId: bookingPaymentAttempts.providerPaymentId,
          squareTeamMemberId: bookingPaymentAttempts.squareTeamMemberId,
        })
        .from(bookingPaymentAttempts)
        .innerJoin(
          appointmentHolds,
          eq(appointmentHolds.id, bookingPaymentAttempts.holdId),
        )
        .where(
          and(
            eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
            eq(bookingPaymentAttempts.paymentProvider, "square"),
            eq(bookingPaymentAttempts.status, "authorized"),
            isNull(bookingPaymentAttempts.appointmentId),
            isNotNull(bookingPaymentAttempts.providerPaymentId),
          ),
        );

      return rows.flatMap((row) => {
        if (row.holdId === null || row.squarePaymentId === null) return [];
        const intent = readSquareRequestIntent(row.providerMetadata);
        if (intent === null) return [];
        return [
          {
            amountCents: row.amountCents,
            currency: row.currency,
            holdId: row.holdId,
            idempotencyKey: row.idempotencyKey,
            paymentAttemptId: row.paymentAttemptId,
            referenceId: row.referenceId,
            squareCustomerId: intent.squareCustomerId,
            squareOrderId: row.squareOrderId ?? undefined,
            squarePaymentId: row.squarePaymentId,
            squareTeamMemberId: row.squareTeamMemberId ?? undefined,
          },
        ];
      });
    },
    async recordProviderCompletedOperationalPayment(input) {
      const paymentRepository = await getPaymentRepository();
      if (paymentRepository.recordCapturedOperationalPayment === undefined) {
        throw new Error("Operational captured-payment writer is unavailable");
      }
      await paymentRepository.recordCapturedOperationalPayment(input);
    },
    async markOperationalPaymentFailed(input) {
      const paymentRepository = await getPaymentRepository();
      await paymentRepository.markHoldPaymentFailed(input);
    },
    async markOperationalPaymentRefundRequired(input) {
      const paymentRepository = await getPaymentRepository();
      await paymentRepository.markHoldRefundRequired(input);
    },
    async markOperationalPaymentTerminated(input) {
      const paymentRepository = await getPaymentRepository();
      if (
        paymentRepository.markAuthorizedOperationalPaymentTerminated ===
        undefined
      ) {
        throw new Error("Operational payment terminal writer is unavailable");
      }
      return paymentRepository.markAuthorizedOperationalPaymentTerminated(
        input,
      );
    },
    async findCapturedPaymentsWithoutOperationalAppointment(now) {
      const threshold = new Date(now.getTime() - PAID_NOT_BOOKED_THRESHOLD_MS);
      const rows = await db
        .select({
          holdId: bookingPaymentAttempts.holdId,
          paymentAttemptId: bookingPaymentAttempts.id,
        })
        .from(bookingPaymentAttempts)
        .where(
          and(
            eq(bookingPaymentAttempts.status, "captured"),
            isNull(bookingPaymentAttempts.appointmentId),
            lt(bookingPaymentAttempts.updatedAt, threshold),
          ),
        );

      return rows.map((row) => ({
        holdId: row.holdId ?? undefined,
        paymentAttemptId: row.paymentAttemptId,
      }));
    },
    // Phase 1 schema additions (saved Square card, no-show invoice) will populate these checks.
    async findConfirmedBookingsWithoutNoShowInvoice() {
      const rows = await db
        .select({
          holdId: appointmentHolds.id,
        })
        .from(appointmentHolds)
        .innerJoin(
          bookingNoShowChargeRecords,
          eq(
            appointmentHolds.noShowChargeRecordId,
            bookingNoShowChargeRecords.id,
          ),
        )
        .where(
          and(
            eq(appointmentHolds.status, "booked"),
            eq(appointmentHolds.paymentProvider, "square"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(bookingNoShowChargeRecords.squareInvoiceId),
            ne(bookingNoShowChargeRecords.status, "manual_followup"),
          ),
        );

      return rows.map((row) => ({ holdId: row.holdId }));
    },

    async findSquarePaymentsPendingTooLong(now) {
      const threshold = new Date(now.getTime() - PENDING_PAYMENT_THRESHOLD_MS);

      const rows = await db
        .select({
          holdId: appointmentHolds.id,
          orderId: appointmentHolds.checkoutOrderPublicId,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.paymentProvider, "square"),
            eq(appointmentHolds.status, "payment_pending"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(appointmentHolds.squarePaymentLinkId),
            lt(appointmentHolds.updatedAt, threshold),
          ),
        );

      return rows.map((row) => ({
        holdId: row.holdId,
        orderId: row.orderId ?? undefined,
      }));
    },

    async findPaidBookingsNotBooked(now) {
      const threshold = new Date(now.getTime() - PAID_NOT_BOOKED_THRESHOLD_MS);

      const rows = await db
        .select({
          holdId: appointmentHolds.id,
          orderId: checkoutOrders.orderId,
        })
        .from(checkoutOrders)
        .innerJoin(
          appointmentHolds,
          eq(appointmentHolds.checkoutOrderId, checkoutOrders.id),
        )
        .where(
          and(
            eq(checkoutOrders.status, "paid"),
            eq(checkoutOrders.paymentProvider, "square"),
            inArray(
              checkoutOrders.purpose,
              APPOINTMENT_CHECKOUT_ORDER_PURPOSES,
            ),
            notInArray(
              checkoutOrders.calendarFinalizationStatus,
              BOOKED_CALENDAR_STATUSES,
            ),
            lt(checkoutOrders.paidAt, threshold),
            eq(appointmentHolds.paymentProvider, "square"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(appointmentHolds.squarePaymentLinkId),
          ),
        );

      return rows.map((row) => ({
        holdId: row.holdId,
        orderId: row.orderId ?? undefined,
      }));
    },

    async findOperationalAppointmentsPendingCalendar(now) {
      const threshold = new Date(now.getTime() - PAID_NOT_BOOKED_THRESHOLD_MS);
      const rows = await db
        .select({
          appointmentId: appointments.id,
          holdId: appointments.sourceHoldId,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.origin, "online"),
            inArray(appointments.paymentStatus, ["paid", "partially_paid"]),
            inArray(appointments.calendarSyncStatus, [
              "pending",
              "retryable_failed",
            ]),
            lt(appointments.updatedAt, threshold),
          ),
        );

      return rows.map((row) => ({
        appointmentId: row.appointmentId,
        holdId: row.holdId ?? undefined,
      }));
    },

    async findOperationalAppointmentsWithoutCapturedPayment(now) {
      const threshold = new Date(now.getTime() - PAID_NOT_BOOKED_THRESHOLD_MS);
      const rows = await db
        .select({
          appointmentId: appointments.id,
          holdId: appointments.sourceHoldId,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.origin, "online"),
            inArray(appointments.paymentStatus, ["paid", "partially_paid"]),
            lt(appointments.updatedAt, threshold),
            notExists(
              db
                .select({ id: bookingPaymentAttempts.id })
                .from(bookingPaymentAttempts)
                .where(
                  and(
                    eq(bookingPaymentAttempts.appointmentId, appointments.id),
                    eq(bookingPaymentAttempts.status, "captured"),
                  ),
                ),
            ),
          ),
        );

      return rows.map((row) => ({
        appointmentId: row.appointmentId,
        holdId: row.holdId ?? undefined,
      }));
    },

    async findFailedNoShowCharges(now) {
      // Records that are stale, have no provider failure reason, and have no
      // evidence of a handled webhook event are surfaced by
      // findNoShowChargeFailedNotAlerted instead. Exclude them here so the two
      // categories never emit duplicate findings for the same record.
      const threshold = new Date(
        now.getTime() - CHARGE_FAILED_ALERT_THRESHOLD_MS,
      );

      const rows = await db
        .select({
          holdId: bookingNoShowChargeRecords.holdId,
          orderId: bookingNoShowChargeRecords.squareOrderId,
        })
        .from(bookingNoShowChargeRecords)
        .where(
          and(
            eq(bookingNoShowChargeRecords.status, "charge_failed"),
            or(
              gte(bookingNoShowChargeRecords.updatedAt, threshold),
              isNotNull(bookingNoShowChargeRecords.providerFailureReason),
              exists(handledNoShowPaymentEventExists()),
            ),
          ),
        );

      return rows.map((row) => ({
        holdId: row.holdId,
        orderId: row.orderId ?? undefined,
      }));
    },

    async findBookedAppointmentsWithoutSavedPaymentMethod() {
      const rows = await db
        .select({
          holdId: appointmentHolds.id,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.status, "booked"),
            eq(appointmentHolds.paymentProvider, "square"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(appointmentHolds.savedPaymentMethodId),
          ),
        );

      return rows.map((row) => ({ holdId: row.holdId }));
    },

    async findBookedAppointmentsWithoutPolicyAcceptance() {
      const rows = await db
        .select({
          holdId: appointmentHolds.id,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.status, "booked"),
            eq(appointmentHolds.paymentProvider, "square"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(appointmentHolds.policyAcceptanceId),
          ),
        );

      return rows.map((row) => ({ holdId: row.holdId }));
    },

    async findBookedAppointmentsWithoutNoShowChargeRecord() {
      const rows = await db
        .select({
          holdId: appointmentHolds.id,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.status, "booked"),
            eq(appointmentHolds.paymentProvider, "square"),
            isNotNull(appointmentHolds.cardOnFileStatus),
            isNull(appointmentHolds.noShowChargeRecordId),
          ),
        );

      return rows.map((row) => ({ holdId: row.holdId }));
    },

    async findNoShowChargeFailedNotAlerted(now) {
      // Alerting is not durably persisted. A stale charge_failed record should only be
      // flagged as not-yet-alerted when it has no providerFailureReason and no evidence
      // of a related handled webhook event. Webhook-driven failures can update the record
      // and alert without creating a failed attempt row, so providerFailureReason or a
      // processed/duplicate/ignored/failed event is treated as handled.
      const threshold = new Date(
        now.getTime() - CHARGE_FAILED_ALERT_THRESHOLD_MS,
      );

      const rows = await db
        .select({
          holdId: bookingNoShowChargeRecords.holdId,
          noShowChargeRecordId: bookingNoShowChargeRecords.id,
          status: bookingNoShowChargeRecords.status,
        })
        .from(bookingNoShowChargeRecords)
        .where(
          and(
            eq(bookingNoShowChargeRecords.status, "charge_failed"),
            lt(bookingNoShowChargeRecords.updatedAt, threshold),
            isNull(bookingNoShowChargeRecords.providerFailureReason),
            notExists(handledNoShowPaymentEventExists()),
          ),
        );

      return rows;
    },

    async findNoShowChargesPendingTooLong(now) {
      const threshold = new Date(now.getTime() - STALE_CHARGE_PENDING_MS);

      const rows = await db
        .select({
          holdId: bookingNoShowChargeRecords.holdId,
          noShowChargeRecordId: bookingNoShowChargeRecords.id,
          status: bookingNoShowChargeRecords.status,
        })
        .from(bookingNoShowChargeRecords)
        .where(
          and(
            eq(bookingNoShowChargeRecords.status, "charge_pending"),
            eq(bookingNoShowChargeRecords.providerStatus, "publish_pending"),
            lt(bookingNoShowChargeRecords.updatedAt, threshold),
          ),
        );

      return rows;
    },

    async findSquareInvoicePaymentEventsNotReconciled() {
      const rows = await db
        .select({
          eventId: checkoutPaymentEvents.id,
          noShowChargeRecordId: checkoutPaymentEvents.noShowChargeRecordId,
          processingStatus: checkoutPaymentEvents.processingStatus,
        })
        .from(checkoutPaymentEvents)
        .where(
          and(
            eq(checkoutPaymentEvents.paymentProvider, "square"),
            isNotNull(checkoutPaymentEvents.noShowChargeRecordId),
            notInArray(checkoutPaymentEvents.processingStatus, [
              "processed",
              "duplicate",
              "ignored",
              "failed",
            ]),
          ),
        );

      return rows.map((row) => ({
        eventId: row.eventId,
        noShowChargeRecordId: row.noShowChargeRecordId as string,
        processingStatus: row.processingStatus,
      }));
    },

    async findAmountCurrencyCustomerMismatches() {
      const [amountCurrencyRows, customerRows, cardRows, linkRows] =
        await Promise.all([
          db
            .select({
              holdId: bookingNoShowChargeRecords.holdId,
              noShowChargeRecordId: bookingNoShowChargeRecords.id,
              policyAcceptanceId: bookingPolicyAcceptances.id,
            })
            .from(bookingNoShowChargeRecords)
            .innerJoin(
              bookingPolicyAcceptances,
              eq(
                bookingNoShowChargeRecords.policyAcceptanceId,
                bookingPolicyAcceptances.id,
              ),
            )
            .where(
              and(
                isNotNull(bookingNoShowChargeRecords.policyAcceptanceId),
                or(
                  and(
                    isNotNull(bookingNoShowChargeRecords.maxChargeCents),
                    isNotNull(bookingPolicyAcceptances.maxChargeCents),
                    ne(
                      bookingNoShowChargeRecords.maxChargeCents,
                      bookingPolicyAcceptances.maxChargeCents,
                    ),
                  ),
                  and(
                    isNotNull(bookingNoShowChargeRecords.currency),
                    isNotNull(bookingPolicyAcceptances.currency),
                    ne(
                      bookingNoShowChargeRecords.currency,
                      bookingPolicyAcceptances.currency,
                    ),
                  ),
                ),
              ),
            ),

          db
            .select({
              holdId: bookingNoShowChargeRecords.holdId,
              noShowChargeRecordId: bookingNoShowChargeRecords.id,
              savedPaymentMethodId: bookingSavedPaymentMethods.id,
            })
            .from(bookingNoShowChargeRecords)
            .innerJoin(
              bookingSavedPaymentMethods,
              eq(
                bookingNoShowChargeRecords.savedPaymentMethodId,
                bookingSavedPaymentMethods.id,
              ),
            )
            .innerJoin(
              bookingSquareCustomers,
              eq(
                bookingSavedPaymentMethods.customerId,
                bookingSquareCustomers.id,
              ),
            )
            .where(
              and(
                isNotNull(bookingNoShowChargeRecords.squareCustomerId),
                isNotNull(bookingSquareCustomers.squareCustomerId),
                ne(
                  bookingNoShowChargeRecords.squareCustomerId,
                  bookingSquareCustomers.squareCustomerId,
                ),
              ),
            ),

          db
            .select({
              holdId: bookingNoShowChargeRecords.holdId,
              noShowChargeRecordId: bookingNoShowChargeRecords.id,
              savedPaymentMethodId: bookingSavedPaymentMethods.id,
            })
            .from(bookingNoShowChargeRecords)
            .innerJoin(
              bookingSavedPaymentMethods,
              eq(
                bookingNoShowChargeRecords.savedPaymentMethodId,
                bookingSavedPaymentMethods.id,
              ),
            )
            .where(
              and(
                isNotNull(bookingNoShowChargeRecords.squareCardId),
                isNotNull(bookingSavedPaymentMethods.squareCardId),
                ne(
                  bookingNoShowChargeRecords.squareCardId,
                  bookingSavedPaymentMethods.squareCardId,
                ),
              ),
            ),

          db
            .select({
              holdId: appointmentHolds.id,
              noShowChargeRecordId: bookingNoShowChargeRecords.id,
              savedPaymentMethodId: appointmentHolds.savedPaymentMethodId,
              policyAcceptanceId: appointmentHolds.policyAcceptanceId,
            })
            .from(appointmentHolds)
            .innerJoin(
              bookingNoShowChargeRecords,
              eq(
                appointmentHolds.noShowChargeRecordId,
                bookingNoShowChargeRecords.id,
              ),
            )
            .where(
              or(
                ne(appointmentHolds.id, bookingNoShowChargeRecords.holdId),
                and(
                  isNotNull(appointmentHolds.savedPaymentMethodId),
                  isNotNull(bookingNoShowChargeRecords.savedPaymentMethodId),
                  ne(
                    appointmentHolds.savedPaymentMethodId,
                    bookingNoShowChargeRecords.savedPaymentMethodId,
                  ),
                ),
                and(
                  isNotNull(appointmentHolds.policyAcceptanceId),
                  isNotNull(bookingNoShowChargeRecords.policyAcceptanceId),
                  ne(
                    appointmentHolds.policyAcceptanceId,
                    bookingNoShowChargeRecords.policyAcceptanceId,
                  ),
                ),
              ),
            ),
        ]);

      const amountCurrency = amountCurrencyRows.map((row) => ({
        holdId: row.holdId,
        mismatchType: "amount_currency" as const,
        noShowChargeRecordId: row.noShowChargeRecordId,
        policyAcceptanceId: row.policyAcceptanceId,
      }));

      const customer = customerRows.map((row) => ({
        holdId: row.holdId,
        mismatchType: "customer" as const,
        noShowChargeRecordId: row.noShowChargeRecordId,
        savedPaymentMethodId: row.savedPaymentMethodId,
      }));

      const card = cardRows.map((row) => ({
        holdId: row.holdId,
        mismatchType: "card" as const,
        noShowChargeRecordId: row.noShowChargeRecordId,
        savedPaymentMethodId: row.savedPaymentMethodId,
      }));

      const link = linkRows.map((row) => ({
        holdId: row.holdId,
        mismatchType: "hold_record_link" as const,
        noShowChargeRecordId: row.noShowChargeRecordId,
        savedPaymentMethodId: row.savedPaymentMethodId ?? undefined,
        policyAcceptanceId: row.policyAcceptanceId ?? undefined,
      }));

      return [...amountCurrency, ...customer, ...card, ...link];
    },
  };

  async function getPaymentRepository() {
    if (paymentRepositoryPromise === undefined) {
      const { createServiceBookingPaymentRepository } =
        await import("@/lib/private-db/service-booking-payment-repository");
      paymentRepositoryPromise = createServiceBookingPaymentRepository(db);
    }
    return paymentRepositoryPromise;
  }
}
