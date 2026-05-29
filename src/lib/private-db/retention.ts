import "server-only";

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";

import {
  appointmentHolds,
  checkoutOrders,
  checkoutPaymentEvents,
  marketingConsentEvents,
  marketingContacts,
  marketingContactSubmissions,
  trainingEnrollments,
  type AppointmentHoldStatus,
  type CalendarFinalizationStatus,
  type CheckoutOrderStatus,
  type TrainingEnrollmentSchedulingStatus,
} from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTED_TEXT = "[redacted]";

const CHECKOUT_ORDER_TERMINAL_STATUSES = [
  "paid",
  "verification_failed",
  "cancelled",
  "refunded",
] as const satisfies readonly CheckoutOrderStatus[];
const CHECKOUT_ORDER_TERMINAL_STATUSES_FOR_QUERY = [...CHECKOUT_ORDER_TERMINAL_STATUSES];

const RESOLVED_CALENDAR_FINALIZATION_STATUSES = [
  "not_required",
  "booked",
  "manual_rebooked",
  "refunded",
  "failed",
] as const satisfies readonly CalendarFinalizationStatus[];
const RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY = [...RESOLVED_CALENDAR_FINALIZATION_STATUSES];

const APPOINTMENT_HOLD_ABANDONED_STATUSES = [
  "held",
  "payment_pending",
  "expired",
  "payment_failed",
  "released",
] as const satisfies readonly AppointmentHoldStatus[];
const APPOINTMENT_HOLD_ABANDONED_STATUSES_FOR_QUERY = [...APPOINTMENT_HOLD_ABANDONED_STATUSES];

const APPOINTMENT_HOLD_TERMINAL_STATUSES = [
  "booked",
  "booking_failed",
  "expired",
  "manual_rebooked",
  "payment_failed",
  "refunded",
  "released",
] as const satisfies readonly AppointmentHoldStatus[];
const APPOINTMENT_HOLD_TERMINAL_STATUSES_FOR_QUERY = [...APPOINTMENT_HOLD_TERMINAL_STATUSES];

const TRAINING_ENROLLMENT_TERMINAL_STATUSES = [
  "expired",
  "scheduled",
] as const satisfies readonly TrainingEnrollmentSchedulingStatus[];
const TRAINING_ENROLLMENT_TERMINAL_STATUSES_FOR_QUERY = [...TRAINING_ENROLLMENT_TERMINAL_STATUSES];

const REDACTED_APPOINTMENT_CUSTOMER = {
  email: REDACTED_TEXT,
  name: REDACTED_TEXT,
  phone: REDACTED_TEXT,
};

export function getTerminalAppointmentHoldRedactionValues(now: Date) {
  return {
    bookingConfirmationEmailClaimedUntil: null,
    bookingConfirmationEmailLastError: null,
    customerSnapshot: REDACTED_APPOINTMENT_CUSTOMER,
    failureMetadata: null,
    failureReason: null,
    finalizationReason: null,
    manualReviewReason: null,
    reconciliationMetadata: null,
    squarePaymentLinkUrl: null,
    updatedAt: now,
  };
}

const REDACTED_MARKETING_SUBMISSION_PAYLOAD = {
  redacted: true,
  redactedBy: "private-data-retention",
};

export const PRIVATE_DATA_RETENTION_WINDOWS = {
  checkoutOrders: {
    redactAfterDays: 395,
    softDeleteAfterDays: 2555,
    purgeAfterDeletedDays: 30,
  },
  checkoutPaymentEvents: {
    scrubPayloadAfterDays: 90,
    deleteAfterDays: 730,
  },
  appointmentHolds: {
    deleteAbandonedAfterDays: 30,
    redactTerminalAfterDays: 180,
    deleteTerminalAfterDays: 730,
  },
  trainingEnrollments: {
    expireSchedulingTokensAfterDays: 0,
    redactAfterDays: 395,
    deleteAfterDays: 2555,
  },
  marketingContacts: {
    redactProfileAfterInactiveDays: 730,
    deleteUnsubscribedAfterDays: 2555,
  },
  marketingContactSubmissions: {
    deleteNonConsentingAfterDays: 180,
    redactConsentingAfterDays: 395,
  },
  marketingConsentEvents: {
    deleteAfterDays: 2555,
  },
} as const;

export const PRIVATE_DATA_RETENTION_TABLE_WINDOWS = [
  {
    table: "checkout_orders",
    action: "redact customer identity, checkout tokens, shipping address, and provider metadata",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.redactAfterDays,
    basis: "terminal order timestamp",
  },
  {
    table: "checkout_orders",
    action: "soft-delete redacted terminal orders",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.softDeleteAfterDays,
    basis: "terminal order timestamp",
  },
  {
    table: "checkout_orders",
    action: "purge soft-deleted orders after a grace period",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.purgeAfterDeletedDays,
    basis: "deleted_at",
  },
  {
    table: "checkout_payment_events",
    action: "scrub stored webhook payload fields",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.scrubPayloadAfterDays,
    basis: "created_at",
  },
  {
    table: "checkout_payment_events",
    action: "delete old payment-event rows",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.deleteAfterDays,
    basis: "created_at",
  },
  {
    table: "appointment_holds",
    action: "delete abandoned holds with no checkout order",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteAbandonedAfterDays,
    basis: "expires_at",
  },
  {
    table: "appointment_holds",
    action: "redact customer snapshot and operational free-text fields on terminal holds",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.redactTerminalAfterDays,
    basis: "terminal hold timestamp",
  },
  {
    table: "appointment_holds",
    action: "delete old terminal holds",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteTerminalAfterDays,
    basis: "terminal hold timestamp",
  },
  {
    table: "training_enrollments",
    action: "expire unused scheduling tokens",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.expireSchedulingTokensAfterDays,
    basis: "token_expires_at",
  },
  {
    table: "training_enrollments",
    action: "redact checkout email, scheduling token, and retry error details",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.redactAfterDays,
    basis: "terminal enrollment timestamp",
  },
  {
    table: "training_enrollments",
    action: "delete old terminal enrollment rows",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.deleteAfterDays,
    basis: "terminal enrollment timestamp",
  },
  {
    table: "marketing_contacts",
    action: "redact inactive contact profile fields while keeping email for active consent/suppression",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.marketingContacts.redactProfileAfterInactiveDays,
    basis: "last_consented_at",
  },
  {
    table: "marketing_contacts",
    action: "delete old unsubscribed contacts",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.marketingContacts.deleteUnsubscribedAfterDays,
    basis: "unsubscribed_at",
  },
  {
    table: "marketing_contact_submissions",
    action: "delete non-consenting submissions",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSubmissions.deleteNonConsentingAfterDays,
    basis: "submitted_at",
  },
  {
    table: "marketing_contact_submissions",
    action: "redact consenting submission identity and payload fields",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSubmissions.redactConsentingAfterDays,
    basis: "submitted_at",
  },
  {
    table: "marketing_consent_events",
    action: "delete old consent-event evidence",
    windowDays: PRIVATE_DATA_RETENTION_WINDOWS.marketingConsentEvents.deleteAfterDays,
    basis: "occurred_at",
  },
] as const;

export type PrivateDataRetentionOperation =
  | "appointmentHoldsAbandonedDeleted"
  | "appointmentHoldsDeleted"
  | "appointmentHoldsRedacted"
  | "checkoutOrdersPurged"
  | "checkoutOrdersRedacted"
  | "checkoutOrdersSoftDeleted"
  | "checkoutPaymentEventsDeleted"
  | "checkoutPaymentEventsPayloadScrubbed"
  | "marketingConsentEventsDeleted"
  | "marketingContactsProfileRedacted"
  | "marketingContactsUnsubscribedDeleted"
  | "marketingContactSubmissionsConsentingRedacted"
  | "marketingContactSubmissionsNonConsentingDeleted"
  | "trainingEnrollmentsDeleted"
  | "trainingEnrollmentsRedacted"
  | "trainingSchedulingTokensExpired";

export interface PrivateDataRetentionOperationResult {
  count: number;
  cutoff: string;
  operation: PrivateDataRetentionOperation;
  table: string;
}

export interface PrivateDataRetentionCleanupSummary {
  operations: PrivateDataRetentionOperationResult[];
  runAt: string;
  totalAffected: number;
}

export interface PrivateDataRetentionCleanupRepository {
  deleteAbandonedAppointmentHolds(input: RetentionCutoffInput): Promise<number>;
  deleteCheckoutPaymentEvents(input: RetentionCutoffInput): Promise<number>;
  deleteMarketingConsentEvents(input: RetentionCutoffInput): Promise<number>;
  deleteNonConsentingMarketingSubmissions(input: RetentionCutoffInput): Promise<number>;
  deleteTerminalAppointmentHolds(input: RetentionCutoffInput): Promise<number>;
  deleteTerminalTrainingEnrollments(input: RetentionCutoffInput): Promise<number>;
  deleteUnsubscribedMarketingContacts(input: RetentionCutoffInput): Promise<number>;
  expireTrainingSchedulingTokens(input: RetentionCutoffInput): Promise<number>;
  purgeSoftDeletedCheckoutOrders(input: RetentionCutoffInput): Promise<number>;
  redactCheckoutOrders(input: RetentionCutoffInput): Promise<number>;
  redactConsentingMarketingSubmissions(input: RetentionCutoffInput): Promise<number>;
  redactInactiveMarketingContacts(input: RetentionCutoffInput): Promise<number>;
  redactTerminalAppointmentHolds(input: RetentionCutoffInput): Promise<number>;
  redactTerminalTrainingEnrollments(input: RetentionCutoffInput): Promise<number>;
  scrubCheckoutPaymentEventPayloads(input: RetentionCutoffInput): Promise<number>;
  softDeleteCheckoutOrders(input: RetentionCutoffInput): Promise<number>;
}

export interface PrivateDataRetentionCutoffs {
  appointmentHoldAbandonedDeleteCutoff: Date;
  appointmentHoldDeleteCutoff: Date;
  appointmentHoldRedactCutoff: Date;
  checkoutOrderPurgeCutoff: Date;
  checkoutOrderRedactCutoff: Date;
  checkoutOrderSoftDeleteCutoff: Date;
  marketingConsentEventDeleteCutoff: Date;
  marketingContactProfileRedactCutoff: Date;
  marketingContactUnsubscribedDeleteCutoff: Date;
  marketingSubmissionConsentingRedactCutoff: Date;
  marketingSubmissionNonConsentingDeleteCutoff: Date;
  paymentEventDeleteCutoff: Date;
  paymentEventPayloadScrubCutoff: Date;
  trainingEnrollmentDeleteCutoff: Date;
  trainingEnrollmentRedactCutoff: Date;
  trainingTokenExpiryCutoff: Date;
}

interface RetentionCutoffInput {
  cutoff: Date;
  now: Date;
}

interface RetentionStep {
  cutoff: Date;
  operation: PrivateDataRetentionOperation;
  run: (input: RetentionCutoffInput) => Promise<number>;
  table: string;
}

export function getPrivateDataRetentionCutoffs(now: Date): PrivateDataRetentionCutoffs {
  return {
    appointmentHoldAbandonedDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteAbandonedAfterDays,
    ),
    appointmentHoldDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteTerminalAfterDays,
    ),
    appointmentHoldRedactCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.redactTerminalAfterDays,
    ),
    checkoutOrderPurgeCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.purgeAfterDeletedDays,
    ),
    checkoutOrderRedactCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.redactAfterDays,
    ),
    checkoutOrderSoftDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.checkoutOrders.softDeleteAfterDays,
    ),
    marketingConsentEventDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.marketingConsentEvents.deleteAfterDays,
    ),
    marketingContactProfileRedactCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.marketingContacts.redactProfileAfterInactiveDays,
    ),
    marketingContactUnsubscribedDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.marketingContacts.deleteUnsubscribedAfterDays,
    ),
    marketingSubmissionConsentingRedactCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSubmissions.redactConsentingAfterDays,
    ),
    marketingSubmissionNonConsentingDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.marketingContactSubmissions.deleteNonConsentingAfterDays,
    ),
    paymentEventDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.deleteAfterDays,
    ),
    paymentEventPayloadScrubCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.scrubPayloadAfterDays,
    ),
    trainingEnrollmentDeleteCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.deleteAfterDays,
    ),
    trainingEnrollmentRedactCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.redactAfterDays,
    ),
    trainingTokenExpiryCutoff: subtractDays(
      now,
      PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.expireSchedulingTokensAfterDays,
    ),
  };
}

export function createPrivateDataRetentionCleanup(
  repository: PrivateDataRetentionCleanupRepository,
): (input?: { now?: Date }) => Promise<PrivateDataRetentionCleanupSummary> {
  return async function runPrivateDataRetentionCleanupWithRepository(input = {}) {
    const now = input.now ?? new Date();
    const cutoffs = getPrivateDataRetentionCutoffs(now);
    const steps = getRetentionSteps(repository, cutoffs);
    const operations: PrivateDataRetentionOperationResult[] = [];

    for (const step of steps) {
      const count = await step.run({ cutoff: step.cutoff, now });
      operations.push({
        count,
        cutoff: step.cutoff.toISOString(),
        operation: step.operation,
        table: step.table,
      });
    }

    return {
      operations,
      runAt: now.toISOString(),
      totalAffected: operations.reduce((sum, operation) => sum + operation.count, 0),
    };
  };
}

export function getSoftDeletedCheckoutOrderPurgePredicate(
  cutoff: Date,
  paymentEventDeleteCutoff: Date,
  trainingEnrollmentDeleteCutoff: Date,
  appointmentHoldDeleteCutoff: Date,
) {
  return and(
    isNotNull(checkoutOrders.deletedAt),
    lte(checkoutOrders.deletedAt, cutoff),
    inArray(checkoutOrders.calendarFinalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY),
    notExists(sql`
      (select 1
      from ${checkoutPaymentEvents}
      where ${checkoutPaymentEvents.orderId} = ${checkoutOrders.id}
      and ${checkoutPaymentEvents.createdAt} > ${paymentEventDeleteCutoff}
      )
    `),
    notExists(sql`
      (select 1
      from ${trainingEnrollments}
      where ${trainingEnrollments.checkoutOrderId} = ${checkoutOrders.id}
      and (
        ${notInArray(trainingEnrollments.schedulingStatus, TRAINING_ENROLLMENT_TERMINAL_STATUSES_FOR_QUERY)}
        or ${terminalTrainingEnrollmentTimestamp()} > ${trainingEnrollmentDeleteCutoff}
      )
      )
    `),
    notExists(sql`
      (select 1
      from ${appointmentHolds}
      where ${appointmentHolds.checkoutOrderId} = ${checkoutOrders.id}
      and (
        ${notInArray(appointmentHolds.status, APPOINTMENT_HOLD_TERMINAL_STATUSES_FOR_QUERY)}
        or ${notInArray(appointmentHolds.finalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY)}
        or ${terminalAppointmentHoldTimestamp()} > ${appointmentHoldDeleteCutoff}
      )
      )
    `),
  );
}

export function getTerminalAppointmentHoldDeletePredicate(cutoff: Date) {
  return and(
    inArray(appointmentHolds.status, APPOINTMENT_HOLD_TERMINAL_STATUSES_FOR_QUERY),
    inArray(appointmentHolds.finalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY),
    lte(terminalAppointmentHoldTimestamp(), cutoff),
  );
}

export function getTerminalAppointmentHoldRedactionPredicate(cutoff: Date) {
  return and(
    inArray(appointmentHolds.status, APPOINTMENT_HOLD_TERMINAL_STATUSES_FOR_QUERY),
    inArray(appointmentHolds.finalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY),
    ne(sql`${appointmentHolds.customerSnapshot}->>'email'`, REDACTED_TEXT),
    lte(terminalAppointmentHoldTimestamp(), cutoff),
  );
}

export async function runPrivateDataRetentionCleanup(input: { now?: Date } = {}): Promise<PrivateDataRetentionCleanupSummary> {
  return createPrivateDataRetentionCleanup(createDrizzlePrivateDataRetentionRepository())(input);
}

function createDrizzlePrivateDataRetentionRepository(): PrivateDataRetentionCleanupRepository {
  return {
    async deleteAbandonedAppointmentHolds({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(appointmentHolds)
        .where(
          and(
            inArray(appointmentHolds.status, APPOINTMENT_HOLD_ABANDONED_STATUSES_FOR_QUERY),
            isNull(appointmentHolds.checkoutOrderId),
            lte(appointmentHolds.expiresAt, cutoff),
          ),
        )
        .returning({ id: appointmentHolds.id });

      return deleted.length;
    },

    async deleteCheckoutPaymentEvents({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(checkoutPaymentEvents)
        .where(lte(checkoutPaymentEvents.createdAt, cutoff))
        .returning({ id: checkoutPaymentEvents.id });

      return deleted.length;
    },

    async deleteMarketingConsentEvents({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(marketingConsentEvents)
        .where(lte(marketingConsentEvents.occurredAt, cutoff))
        .returning({ id: marketingConsentEvents.id });

      return deleted.length;
    },

    async deleteNonConsentingMarketingSubmissions({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(marketingContactSubmissions)
        .where(
          and(
            eq(marketingContactSubmissions.consentChoice, "not_opted_in"),
            lte(marketingContactSubmissions.submittedAt, cutoff),
          ),
        )
        .returning({ id: marketingContactSubmissions.id });

      return deleted.length;
    },

    async deleteTerminalAppointmentHolds({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(appointmentHolds)
        .where(getTerminalAppointmentHoldDeletePredicate(cutoff))
        .returning({ id: appointmentHolds.id });

      return deleted.length;
    },

    async deleteTerminalTrainingEnrollments({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(trainingEnrollments)
        .where(
          and(
            inArray(trainingEnrollments.schedulingStatus, TRAINING_ENROLLMENT_TERMINAL_STATUSES_FOR_QUERY),
            lte(terminalTrainingEnrollmentTimestamp(), cutoff),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return deleted.length;
    },

    async deleteUnsubscribedMarketingContacts({ cutoff }) {
      const deleted = await getPrivateDb()
        .delete(marketingContacts)
        .where(
          and(
            isNotNull(marketingContacts.unsubscribedAt),
            lte(marketingContacts.unsubscribedAt, cutoff),
          ),
        )
        .returning({ id: marketingContacts.id });

      return deleted.length;
    },

    async expireTrainingSchedulingTokens({ cutoff, now }) {
      const updated = await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          schedulingStatus: "expired",
          schedulingTokenHash: null,
          trainingEmailClaimedUntil: null,
          trainingEmailLastError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(trainingEnrollments.schedulingStatus, "pending"),
            isNotNull(trainingEnrollments.schedulingTokenHash),
            isNotNull(trainingEnrollments.tokenExpiresAt),
            isNull(trainingEnrollments.tokenUsedAt),
            lte(trainingEnrollments.tokenExpiresAt, cutoff),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return updated.length;
    },

    async purgeSoftDeletedCheckoutOrders({ cutoff, now }) {
      const deleted = await getPrivateDb()
        .delete(checkoutOrders)
        .where(
          getSoftDeletedCheckoutOrderPurgePredicate(
            cutoff,
            subtractDays(now, PRIVATE_DATA_RETENTION_WINDOWS.checkoutPaymentEvents.deleteAfterDays),
            subtractDays(now, PRIVATE_DATA_RETENTION_WINDOWS.trainingEnrollments.deleteAfterDays),
            subtractDays(now, PRIVATE_DATA_RETENTION_WINDOWS.appointmentHolds.deleteTerminalAfterDays),
          ),
        )
        .returning({ id: checkoutOrders.id });

      return deleted.length;
    },

    async redactCheckoutOrders({ cutoff, now }) {
      const updated = await getPrivateDb()
        .update(checkoutOrders)
        .set({
          checkoutTokenHash: sql`'redacted:' || ${checkoutOrders.id}::text`,
          customerEmail: REDACTED_TEXT,
          customerName: REDACTED_TEXT,
          productConfirmationEmailClaimedUntil: null,
          productConfirmationEmailLastError: null,
          providerMetadata: null,
          redactedAt: now,
          secretTokenCiphertext: REDACTED_TEXT,
          shippingAddress: null,
          squarePaymentLinkUrl: null,
          updatedAt: now,
        })
        .where(
          and(
            isNull(checkoutOrders.redactedAt),
            inArray(checkoutOrders.status, CHECKOUT_ORDER_TERMINAL_STATUSES_FOR_QUERY),
            inArray(checkoutOrders.calendarFinalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY),
            lte(terminalCheckoutOrderTimestamp(), cutoff),
          ),
        )
        .returning({ id: checkoutOrders.id });

      return updated.length;
    },

    async redactConsentingMarketingSubmissions({ cutoff }) {
      const updated = await getPrivateDb()
        .update(marketingContactSubmissions)
        .set({
          email: REDACTED_TEXT,
          emailNormalized: sql`'redacted:' || ${marketingContactSubmissions.id}::text`,
          instagram: null,
          name: null,
          payload: REDACTED_MARKETING_SUBMISSION_PAYLOAD,
          phone: null,
          sourcePath: null,
        })
        .where(
          and(
            ne(marketingContactSubmissions.consentChoice, "not_opted_in"),
            ne(marketingContactSubmissions.email, REDACTED_TEXT),
            lte(marketingContactSubmissions.submittedAt, cutoff),
          ),
        )
        .returning({ id: marketingContactSubmissions.id });

      return updated.length;
    },

    async redactInactiveMarketingContacts({ cutoff }) {
      const updated = await getPrivateDb()
        .update(marketingContacts)
        .set({
          instagram: null,
          name: null,
          phone: null,
          updatedAt: sql`greatest(${marketingContacts.updatedAt}, now())`,
        })
        .where(
          and(
            lte(marketingContacts.lastConsentedAt, cutoff),
            or(
              isNotNull(marketingContacts.instagram),
              isNotNull(marketingContacts.name),
              isNotNull(marketingContacts.phone),
            ),
          ),
        )
        .returning({ id: marketingContacts.id });

      return updated.length;
    },

    async redactTerminalAppointmentHolds({ cutoff, now }) {
      const updated = await getPrivateDb()
        .update(appointmentHolds)
        .set(getTerminalAppointmentHoldRedactionValues(now))
        .where(getTerminalAppointmentHoldRedactionPredicate(cutoff))
        .returning({ id: appointmentHolds.id });

      return updated.length;
    },

    async redactTerminalTrainingEnrollments({ cutoff, now }) {
      const updated = await getPrivateDb()
        .update(trainingEnrollments)
        .set({
          checkoutEmail: REDACTED_TEXT,
          schedulingTokenHash: null,
          trainingEmailClaimedUntil: null,
          trainingEmailLastError: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(trainingEnrollments.schedulingStatus, TRAINING_ENROLLMENT_TERMINAL_STATUSES_FOR_QUERY),
            ne(trainingEnrollments.checkoutEmail, REDACTED_TEXT),
            lte(terminalTrainingEnrollmentTimestamp(), cutoff),
          ),
        )
        .returning({ id: trainingEnrollments.id });

      return updated.length;
    },

    async scrubCheckoutPaymentEventPayloads({ cutoff }) {
      const updated = await getPrivateDb()
        .update(checkoutPaymentEvents)
        .set({
          message: null,
          payloadRedacted: null,
          payloadSanitized: null,
        })
        .where(
          and(
            lte(checkoutPaymentEvents.createdAt, cutoff),
            or(
              isNotNull(checkoutPaymentEvents.message),
              isNotNull(checkoutPaymentEvents.payloadRedacted),
              isNotNull(checkoutPaymentEvents.payloadSanitized),
            ),
          ),
        )
        .returning({ id: checkoutPaymentEvents.id });

      return updated.length;
    },

    async softDeleteCheckoutOrders({ cutoff, now }) {
      const updated = await getPrivateDb()
        .update(checkoutOrders)
        .set({
          deletedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            isNull(checkoutOrders.deletedAt),
            isNotNull(checkoutOrders.redactedAt),
            inArray(checkoutOrders.status, CHECKOUT_ORDER_TERMINAL_STATUSES_FOR_QUERY),
            inArray(checkoutOrders.calendarFinalizationStatus, RESOLVED_CALENDAR_FINALIZATION_STATUSES_FOR_QUERY),
            lte(terminalCheckoutOrderTimestamp(), cutoff),
          ),
        )
        .returning({ id: checkoutOrders.id });

      return updated.length;
    },
  };
}

function getRetentionSteps(
  repository: PrivateDataRetentionCleanupRepository,
  cutoffs: PrivateDataRetentionCutoffs,
): RetentionStep[] {
  return [
    {
      cutoff: cutoffs.trainingTokenExpiryCutoff,
      operation: "trainingSchedulingTokensExpired",
      run: repository.expireTrainingSchedulingTokens,
      table: "training_enrollments",
    },
    {
      cutoff: cutoffs.appointmentHoldAbandonedDeleteCutoff,
      operation: "appointmentHoldsAbandonedDeleted",
      run: repository.deleteAbandonedAppointmentHolds,
      table: "appointment_holds",
    },
    {
      cutoff: cutoffs.appointmentHoldRedactCutoff,
      operation: "appointmentHoldsRedacted",
      run: repository.redactTerminalAppointmentHolds,
      table: "appointment_holds",
    },
    {
      cutoff: cutoffs.checkoutOrderRedactCutoff,
      operation: "checkoutOrdersRedacted",
      run: repository.redactCheckoutOrders,
      table: "checkout_orders",
    },
    {
      cutoff: cutoffs.checkoutOrderSoftDeleteCutoff,
      operation: "checkoutOrdersSoftDeleted",
      run: repository.softDeleteCheckoutOrders,
      table: "checkout_orders",
    },
    {
      cutoff: cutoffs.paymentEventPayloadScrubCutoff,
      operation: "checkoutPaymentEventsPayloadScrubbed",
      run: repository.scrubCheckoutPaymentEventPayloads,
      table: "checkout_payment_events",
    },
    {
      cutoff: cutoffs.paymentEventDeleteCutoff,
      operation: "checkoutPaymentEventsDeleted",
      run: repository.deleteCheckoutPaymentEvents,
      table: "checkout_payment_events",
    },
    {
      cutoff: cutoffs.trainingEnrollmentRedactCutoff,
      operation: "trainingEnrollmentsRedacted",
      run: repository.redactTerminalTrainingEnrollments,
      table: "training_enrollments",
    },
    {
      cutoff: cutoffs.trainingEnrollmentDeleteCutoff,
      operation: "trainingEnrollmentsDeleted",
      run: repository.deleteTerminalTrainingEnrollments,
      table: "training_enrollments",
    },
    {
      cutoff: cutoffs.appointmentHoldDeleteCutoff,
      operation: "appointmentHoldsDeleted",
      run: repository.deleteTerminalAppointmentHolds,
      table: "appointment_holds",
    },
    {
      cutoff: cutoffs.checkoutOrderPurgeCutoff,
      operation: "checkoutOrdersPurged",
      run: repository.purgeSoftDeletedCheckoutOrders,
      table: "checkout_orders",
    },
    {
      cutoff: cutoffs.marketingSubmissionNonConsentingDeleteCutoff,
      operation: "marketingContactSubmissionsNonConsentingDeleted",
      run: repository.deleteNonConsentingMarketingSubmissions,
      table: "marketing_contact_submissions",
    },
    {
      cutoff: cutoffs.marketingSubmissionConsentingRedactCutoff,
      operation: "marketingContactSubmissionsConsentingRedacted",
      run: repository.redactConsentingMarketingSubmissions,
      table: "marketing_contact_submissions",
    },
    {
      cutoff: cutoffs.marketingContactProfileRedactCutoff,
      operation: "marketingContactsProfileRedacted",
      run: repository.redactInactiveMarketingContacts,
      table: "marketing_contacts",
    },
    {
      cutoff: cutoffs.marketingConsentEventDeleteCutoff,
      operation: "marketingConsentEventsDeleted",
      run: repository.deleteMarketingConsentEvents,
      table: "marketing_consent_events",
    },
    {
      cutoff: cutoffs.marketingContactUnsubscribedDeleteCutoff,
      operation: "marketingContactsUnsubscribedDeleted",
      run: repository.deleteUnsubscribedMarketingContacts,
      table: "marketing_contacts",
    },
  ];
}

function terminalCheckoutOrderTimestamp() {
  return sql<Date>`coalesce(${checkoutOrders.paidAt}, ${checkoutOrders.failedAt}, ${checkoutOrders.updatedAt}, ${checkoutOrders.createdAt})`;
}

function terminalAppointmentHoldTimestamp() {
  return sql<Date>`coalesce(${appointmentHolds.bookedAt}, ${appointmentHolds.releasedAt}, ${appointmentHolds.expiredAt}, ${appointmentHolds.paymentFailedAt}, ${appointmentHolds.bookingFailedAt}, ${appointmentHolds.manualFollowupAt}, ${appointmentHolds.paidAt}, ${appointmentHolds.updatedAt}, ${appointmentHolds.createdAt})`;
}

function terminalTrainingEnrollmentTimestamp() {
  return sql<Date>`coalesce(${trainingEnrollments.scheduledAt}, ${trainingEnrollments.tokenUsedAt}, ${trainingEnrollments.tokenExpiresAt}, ${trainingEnrollments.updatedAt}, ${trainingEnrollments.createdAt})`;
}

function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}
