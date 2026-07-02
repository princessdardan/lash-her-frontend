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
import { STALE_CHARGE_PENDING_MS } from "@/lib/booking/payments/service-no-show-invoice";
import {
  appointmentHolds,
  bookingNoShowChargeRecords,
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
    | "no_show_charge_pending_too_long";
  holdId?: string;
  orderId?: string;
  noShowChargeRecordId?: string;
  status?: NoShowChargeStatus;
  eventId?: string;
  processingStatus?: PaymentEventProcessingStatus;
  savedPaymentMethodId?: string;
  policyAcceptanceId?: string;
  mismatchType?: "amount_currency" | "customer" | "card" | "hold_record_link";
  severity: "warning" | "error";
}

export interface ServiceReconciliationSummary {
  findings: ServiceReconciliationFinding[];
  ok: boolean;
  checkedAt: string;
}

export interface ServiceReconciliationRepository {
  findConfirmedBookingsWithoutNoShowInvoice(
    now: Date,
  ): Promise<Array<{ holdId: string }>>;
  findSquarePaymentsPendingTooLong(
    now: Date,
  ): Promise<Array<{ holdId: string; orderId?: string }>>;
  findPaidBookingsNotBooked(
    now: Date,
  ): Promise<Array<{ holdId: string; orderId?: string }>>;
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
  findNoShowChargeFailedNotAlerted(
    now: Date,
  ): Promise<
    Array<{
      holdId: string;
      noShowChargeRecordId: string;
      status: NoShowChargeStatus;
    }>
  >;
  findNoShowChargesPendingTooLong(
    now: Date,
  ): Promise<
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
      ] = await Promise.all([
        dependencies.repository.findConfirmedBookingsWithoutNoShowInvoice(now),
        dependencies.repository.findSquarePaymentsPendingTooLong(now),
        dependencies.repository.findPaidBookingsNotBooked(now),
        dependencies.repository.findFailedNoShowCharges(now),
        dependencies.repository.findBookedAppointmentsWithoutSavedPaymentMethod(
          now,
        ),
        dependencies.repository.findBookedAppointmentsWithoutPolicyAcceptance(
          now,
        ),
        dependencies.repository.findBookedAppointmentsWithoutNoShowChargeRecord(
          now,
        ),
        dependencies.repository.findNoShowChargeFailedNotAlerted(now),
        dependencies.repository.findNoShowChargesPendingTooLong(now),
        dependencies.repository.findSquareInvoicePaymentEventsNotReconciled(
          now,
        ),
        dependencies.repository.findAmountCurrencyCustomerMismatches(now),
      ]);

      const findings: ServiceReconciliationFinding[] = [
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
      ];

      return {
        findings,
        ok: findings.length === 0,
        checkedAt: now.toISOString(),
      };
    },
  };
}

export default async function runServiceReconciliationMonitor(input?: {
  now?: Date;
}): Promise<ServiceReconciliationSummary> {
  const monitor = createServiceReconciliationMonitor({
    repository: createDrizzleServiceReconciliationRepository(),
  });

  return monitor.run(input);
}

export function createDrizzleServiceReconciliationRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): ServiceReconciliationRepository {
  return {
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
}
