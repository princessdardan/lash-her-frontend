import "server-only";

import { eq } from "drizzle-orm";

import type { BookingHoldRecord, BookingHoldState } from "@/lib/booking/holds";
import type {
  ChargeAndStoreRepository,
  ChargeAndStoreBookingResult,
} from "@/lib/booking/payments/service-charge-and-store";
import {
  appointmentHolds,
  bookingNoShowChargeRecords,
  bookingPolicyAcceptances,
  bookingSavedPaymentMethods,
  bookingSquareCustomers,
} from "@/lib/private-db/schema";

import { getPrivateDb } from "./client";

const IN_PROGRESS_MARKER_TTL_MS = 30_000;

function isActiveInProgressMarker(
  inProgress: unknown,
  now: Date,
): { active: false } | { active: true; idempotencyKey?: string } {
  if (inProgress === null || typeof inProgress !== "object") {
    return { active: false };
  }

  const marker = inProgress as { startedAt?: string; idempotencyKey?: string };
  if (marker.startedAt === undefined) {
    return { active: false };
  }

  const startedAt = new Date(marker.startedAt).getTime();
  if (Number.isNaN(startedAt)) {
    return { active: false };
  }

  if (now.getTime() - startedAt >= IN_PROGRESS_MARKER_TTL_MS) {
    return { active: false };
  }

  return { active: true, idempotencyKey: marker.idempotencyKey };
}

export async function createServiceBookingPaymentRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<ChargeAndStoreRepository> {
  return {
    async claimPaymentAttempt(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(appointmentHolds)
          .where(
            eq(
              appointmentHolds.paymentSessionReference,
              input.paymentSessionReference,
            ),
          )
          .limit(1)
          .for("update");

        if (row === undefined) {
          return { status: "unavailable" };
        }

        const metadata = (row.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        const confirmation = metadata.chargeAndStoreConfirmation as
          | Extract<ChargeAndStoreBookingResult, { ok: true }>
          | undefined;
        if (confirmation !== undefined) {
          return { status: "confirmed", confirmation };
        }

        // Refund-required is a terminal state: subsequent confirmation attempts
        // should not be allowed to reclaim the hold.
        const refundRequired = metadata.chargeAndStoreRefundRequired as
          | { squarePaymentId?: string; reason?: string; markedAt?: string }
          | undefined;
        if (refundRequired !== undefined) {
          return { status: "unavailable" };
        }

        const markerCheck = isActiveInProgressMarker(
          metadata.chargeAndStoreInProgress,
          input.now,
        );
        if (markerCheck.active) {
          return { status: "in_progress" };
        }

        const [updated] = await tx
          .update(appointmentHolds)
          .set({
            reconciliationMetadata: {
              ...metadata,
              chargeAndStoreInProgress: {
                startedAt: input.now.toISOString(),
                idempotencyKey: input.idempotencyKey,
              },
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, row.id))
          .returning();

        if (updated === undefined) {
          throw new Error(
            "Hold not found when marking charge-and-store confirmation in progress",
          );
        }

        return { status: "available", hold: toBookingHoldRecord(updated) };
      });
    },

    async persistCustomerAndSelection(input) {
      const [row] = await db
        .select({
          offeringSnapshot: appointmentHolds.offeringSnapshot,
        })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, input.holdId))
        .limit(1);

      if (row === undefined) {
        throw new Error(
          "Hold not found when persisting customer and selection",
        );
      }

      const offeringSnapshot = row.offeringSnapshot as Record<string, unknown>;

      await db
        .update(appointmentHolds)
        .set({
          customerSnapshot: {
            name: input.customer.name,
            email: input.customer.email,
            phone: input.customer.phone,
          },
          offeringSnapshot: {
            ...offeringSnapshot,
            selectedPayment: input.payment,
            customerStatus: "captured",
            paymentStatus: "selected",
          },
          updatedAt: input.now,
        })
        .where(eq(appointmentHolds.id, input.holdId));
    },

    async persistPolicyAcceptance(input) {
      return db.transaction(async (tx) => {
        // Retry-safe: a prior partial attempt may have already created the
        // acceptance and unlinked it from the hold. Reuse the existing row
        // instead of failing on the unique holdId constraint.
        let [row] = await tx
          .insert(bookingPolicyAcceptances)
          .values({
            holdId: input.holdId,
            policyType: "service_no_show",
            policyVersion: input.policyVersion,
            policyTextHash: input.policyTextHash,
            acceptedAt: input.now,
            maxChargeCents: input.maxChargeCents,
            currency: input.currency,
            ipHash: input.ipHash,
            userAgentHash: input.userAgentHash,
            customerEmail: input.customerEmail,
            customerName: input.customerName,
            createdAt: input.now,
          })
          .onConflictDoNothing({ target: bookingPolicyAcceptances.holdId })
          .returning();

        if (row === undefined) {
          [row] = await tx
            .select()
            .from(bookingPolicyAcceptances)
            .where(eq(bookingPolicyAcceptances.holdId, input.holdId))
            .limit(1);
        }

        if (row === undefined) {
          throw new Error("Failed to persist or retrieve policy acceptance");
        }

        const [hold] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (hold === undefined) {
          throw new Error("Hold not found when linking policy acceptance");
        }

        const metadata = (hold.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        await tx
          .update(appointmentHolds)
          .set({
            policyAcceptanceId: row.id,
            reconciliationMetadata: {
              ...metadata,
              chargeAndStorePolicyAcceptance: {
                policyAcceptanceId: row.id,
                acceptedAt: input.now.toISOString(),
              },
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId));

        return { id: row.id };
      });
    },

    async findSquareCustomerByEmail(email) {
      const normalized = email.toLowerCase().trim();
      const [row] = await db
        .select({
          id: bookingSquareCustomers.id,
          squareCustomerId: bookingSquareCustomers.squareCustomerId,
        })
        .from(bookingSquareCustomers)
        .where(eq(bookingSquareCustomers.emailNormalized, normalized))
        .limit(1);

      return row ?? null;
    },

    async persistSquareCustomer(input) {
      const normalized = input.email.toLowerCase().trim();
      const [row] = await db
        .insert(bookingSquareCustomers)
        .values({
          emailNormalized: normalized,
          customerName: input.name,
          phoneNormalized: input.phone,
          squareCustomerId: input.squareCustomerId,
          lastUsedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();

      if (row === undefined) {
        throw new Error("Failed to persist Square customer");
      }

      return { id: row.id, squareCustomerId: row.squareCustomerId };
    },

    async persistSavedPaymentMethod(input) {
      // The ChargeAndStoreRepository interface does not receive a hold id here,
      // so the hold row is updated with the saved payment method id later when
      // the no-show charge record is created (which does receive the hold id).
      const [row] = await db
        .insert(bookingSavedPaymentMethods)
        .values({
          customerId: input.squareCustomerRecordId,
          squareCardId: input.squareCardId,
          cardBrand: input.brand,
          cardLast4: input.last4,
          cardExpMonth: input.expMonth,
          cardExpYear: input.expYear,
          status: "active",
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: bookingSavedPaymentMethods.squareCardId,
          set: { updatedAt: input.now },
        })
        .returning();

      if (row === undefined) {
        throw new Error("Failed to persist saved payment method");
      }

      return {
        id: row.id,
        brand: row.cardBrand ?? undefined,
        expMonth: row.cardExpMonth ?? undefined,
        expYear: row.cardExpYear ?? undefined,
        last4: row.cardLast4 ?? undefined,
        squareCardId: row.squareCardId,
      };
    },

    async updateNoShowChargeRecord(input) {
      const set: Record<string, unknown> = {
        updatedAt: input.updatedAt ?? new Date(),
      };

      if (input.status !== undefined) {
        set.status = input.status;
      }
      if (input.squareInvoiceId !== undefined) {
        set.squareInvoiceId = input.squareInvoiceId;
      }
      if (input.squareOrderId !== undefined) {
        set.squareOrderId = input.squareOrderId;
      }
      if (input.squarePaymentId !== undefined) {
        set.squarePaymentId = input.squarePaymentId;
      }
      if (input.providerStatus !== undefined) {
        set.providerStatus = input.providerStatus;
      }
      if (input.providerFailureReason !== undefined) {
        set.providerFailureReason = input.providerFailureReason;
      }
      if (input.providerMetadata !== undefined) {
        set.providerMetadata = input.providerMetadata;
      }
      if (input.chargedAt !== undefined) {
        set.chargedAt = input.chargedAt;
      }

      const [row] = await db
        .update(bookingNoShowChargeRecords)
        .set(set)
        .where(eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId))
        .returning();

      if (row === undefined) {
        throw new Error("No-show charge record not found");
      }

      return { id: row.id, status: row.status };
    },

    async createNoShowChargeRecord(input) {
      return db.transaction(async (tx) => {
        // Atomic upsert: on conflict by holdId, align the no-show record with
        // the current input so the hold's foreign keys can never diverge from
        // the no-show row they reference.
        const [row] = await tx
          .insert(bookingNoShowChargeRecords)
          .values({
            holdId: input.holdId,
            savedPaymentMethodId: input.savedPaymentMethodId,
            policyAcceptanceId: input.policyAcceptanceId,
            squareCustomerId: input.squareCustomerId,
            squareCardId: input.squareCardId,
            maxChargeCents: input.maxChargeCents,
            currency: input.currency,
            status: input.status,
            providerMetadata: input.providerMetadata,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: bookingNoShowChargeRecords.holdId,
            set: {
              savedPaymentMethodId: input.savedPaymentMethodId,
              policyAcceptanceId: input.policyAcceptanceId,
              squareCustomerId: input.squareCustomerId,
              squareCardId: input.squareCardId,
              maxChargeCents: input.maxChargeCents,
              currency: input.currency,
              status: input.status,
              providerMetadata: input.providerMetadata,
              updatedAt: input.now,
            },
          })
          .returning();

        if (row === undefined) {
          throw new Error("Failed to create no-show charge record");
        }

        await tx
          .update(appointmentHolds)
          .set({
            // All payment-related foreign keys are set together here because
            // persistSavedPaymentMethod does not receive a hold id.
            noShowChargeRecordId: row.id,
            savedPaymentMethodId: input.savedPaymentMethodId,
            policyAcceptanceId: input.policyAcceptanceId,
            squareCustomerId: input.squareCustomerId,
            squareCardId: input.squareCardId,
            cardOnFileStatus: "ready",
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId));

        return { id: row.id, status: input.status };
      });
    },

    async markHoldBooked(input) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
            savedPaymentMethodId: appointmentHolds.savedPaymentMethodId,
            policyAcceptanceId: appointmentHolds.policyAcceptanceId,
            noShowChargeRecordId: appointmentHolds.noShowChargeRecordId,
            squareCustomerId: appointmentHolds.squareCustomerId,
            squareCardId: appointmentHolds.squareCardId,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (locked === undefined) {
          throw new Error("Hold not found when marking booked");
        }

        const metadata = (locked.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        const existingConfirmation = metadata.chargeAndStoreConfirmation as
          | { ok: true }
          | undefined;
        if (existingConfirmation !== undefined) {
          throw new Error(
            "Terminal charge-and-store confirmation already exists",
          );
        }

        const [row] = await tx
          .update(appointmentHolds)
          .set({
            status: "booked",
            bookedAt: input.now,
            googleEventId: input.googleEventId,
            savedPaymentMethodId: locked.savedPaymentMethodId,
            policyAcceptanceId: locked.policyAcceptanceId,
            noShowChargeRecordId: locked.noShowChargeRecordId,
            squareCustomerId: locked.squareCustomerId,
            squareCardId: locked.squareCardId,
            cardOnFileStatus: "ready",
            finalizationStatus: "booked",
            reconciliationMetadata: {
              ...metadata,
              chargeAndStoreConfirmation: input.confirmation,
              chargeAndStoreInProgress: undefined,
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId))
          .returning();

        if (row === undefined) {
          throw new Error("Hold not found when marking booked");
        }

        return toBookingHoldRecord(row);
      });
    },

    async markHoldManualFollowup(input) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
            savedPaymentMethodId: appointmentHolds.savedPaymentMethodId,
            policyAcceptanceId: appointmentHolds.policyAcceptanceId,
            noShowChargeRecordId: appointmentHolds.noShowChargeRecordId,
            squareCustomerId: appointmentHolds.squareCustomerId,
            squareCardId: appointmentHolds.squareCardId,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (locked === undefined) {
          throw new Error("Hold not found when marking manual follow-up");
        }

        const metadata = (locked.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        const existingConfirmation = metadata.chargeAndStoreConfirmation as
          | { ok: true }
          | undefined;
        if (existingConfirmation !== undefined) {
          throw new Error(
            "Terminal charge-and-store confirmation already exists",
          );
        }

        const [row] = await tx
          .update(appointmentHolds)
          .set({
            status: "manual_followup",
            manualFollowupAt: input.now,
            savedPaymentMethodId: locked.savedPaymentMethodId,
            policyAcceptanceId: locked.policyAcceptanceId,
            noShowChargeRecordId: locked.noShowChargeRecordId,
            squareCustomerId: locked.squareCustomerId,
            squareCardId: locked.squareCardId,
            cardOnFileStatus: "ready",
            failureReason: input.reason,
            finalizationStatus: "manual_review",
            reconciliationMetadata: {
              ...metadata,
              chargeAndStoreConfirmation: input.confirmation,
              chargeAndStoreInProgress: undefined,
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId))
          .returning();

        if (row === undefined) {
          throw new Error("Hold not found when marking manual follow-up");
        }

        return toBookingHoldRecord(row);
      });
    },

    async markHoldPaymentFailed(input) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            status: appointmentHolds.status,
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (locked === undefined) {
          return;
        }

        const metadata = (locked.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        // Terminal charge-and-store states must never be overwritten by a
        // stale retry or a late failure/cancel path. Checking both the status
        // and the reconciliation metadata protects against races where one
        // path updates the status and another path updates metadata.
        const terminalStatuses = new Set([
          "booked",
          "manual_followup",
          "refund_required",
        ]);
        if (
          terminalStatuses.has(locked.status) ||
          metadata.chargeAndStoreConfirmation !== undefined ||
          metadata.chargeAndStoreRefundRequired !== undefined
        ) {
          return;
        }

        await tx
          .update(appointmentHolds)
          .set({
            status: "payment_failed",
            paymentFailedAt: input.now,
            failureReason: input.reason,
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId));
      });
    },

    async markHoldRefundRequired(input) {
      return db.transaction(async (tx) => {
        const [hold] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (hold === undefined) {
          throw new Error("Hold not found when marking refund required");
        }

        const metadata = (hold.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        await tx
          .update(appointmentHolds)
          .set({
            status: "refund_required",
            squarePaymentId: input.squarePaymentId,
            failureReason: input.reason,
            finalizationStatus: "refund_required",
            manualReviewReason: input.reason,
            reconciliationMetadata: {
              ...metadata,
              // Clear any active in-progress marker and record the terminal
              // refund-required state privately in metadata. The provider id is
              // kept in metadata (and the squarePaymentId column) and is never
              // returned to clients.
              chargeAndStoreInProgress: undefined,
              chargeAndStoreRefundRequired: {
                squarePaymentId: input.squarePaymentId,
                reason: input.reason,
                markedAt: input.now.toISOString(),
              },
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId));
      });
    },
  };
}

function toBookingHoldRecord(
  row: typeof appointmentHolds.$inferSelect,
): BookingHoldRecord {
  return {
    id: row.id,
    publicReference: row.publicReference,
    paymentSessionReference: row.paymentSessionReference,
    state: row.status as BookingHoldState,
    expiresAt: row.expiresAt,
    selectedStart: row.selectedStart,
    selectedEnd: row.selectedEnd,
    offeringId: row.offeringId,
    offeringSnapshot: row.offeringSnapshot,
    customer: row.customerSnapshot,
    googleEventId: row.googleEventId,
    payment: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    timezone: row.timezone,
    bookingType: row.bookingType as "in-person-appointment",
    reconciliationMetadata: row.reconciliationMetadata,
    bookedAt: row.bookedAt,
    bookingFailedAt: row.bookingFailedAt,
    checkoutOrderId: row.checkoutOrderId,
    checkoutOrderPublicId: row.checkoutOrderPublicId,
    expiredAt: row.expiredAt,
    failureMetadata: row.failureMetadata,
    failureReason: row.failureReason,
    finalizationReason: row.finalizationReason,
    finalizationStatus: row.finalizationStatus,
    helcimInvoiceId: row.helcimInvoiceId,
    helcimInvoiceNumber: row.helcimInvoiceNumber,
    helcimTransactionId: row.helcimTransactionId,
    manualFollowupAt: row.manualFollowupAt,
    manualReviewReason: row.manualReviewReason,
    manualReviewStatus: row.manualReviewStatus,
    paidAt: row.paidAt,
    paymentProvider: row.paymentProvider,
    paymentFailedAt: row.paymentFailedAt,
    releasedAt: row.releasedAt,
    squareCheckoutId: row.squareCheckoutId,
    squareOrderId: row.squareOrderId,
    squarePaymentId: row.squarePaymentId,
    squarePaymentLinkId: row.squarePaymentLinkId,
    squarePaymentLinkUrl: row.squarePaymentLinkUrl,
  };
}
