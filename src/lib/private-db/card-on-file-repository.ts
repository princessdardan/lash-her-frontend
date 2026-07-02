import "server-only";

import { and, eq, isNull, lt, notInArray } from "drizzle-orm";

import type { BookingHoldRecord, BookingHoldState } from "@/lib/booking/holds";
import type {
  NoShowChargeAttempt,
  NoShowChargeAttemptClaimResult,
  NoShowChargeRecordDetail,
} from "@/lib/booking/payments/service-no-show-invoice";
import {
  NoShowInvoiceAmountError,
  STALE_CHARGE_PENDING_MS,
  getNoShowAllowedChargeAmountCents,
} from "@/lib/booking/payments/service-no-show-invoice";
import {
  appointmentHolds,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingPolicyAcceptances,
  bookingSavedPaymentMethods,
  bookingSquareCustomers,
  checkoutPaymentEvents,
  type BookingNoShowProviderMetadata,
  type NoShowChargeStatus,
} from "@/lib/private-db/schema";

import type {
  BeginCardOnFileConfirmationResult,
  CardOnFileProgressCheckpoint,
  CardOnFileRepository,
  ExistingCardOnFileConfirmation,
} from "../booking/payments/service-card-on-file";
import type { NoShowChargeFinalizerRepository } from "../booking/payments/service-no-show-charge-finalizer";
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

export async function createCardOnFileDrizzleRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<CardOnFileRepository & NoShowChargeFinalizerRepository> {
  return {
    async beginCardOnFileConfirmation(
      input,
    ): Promise<BeginCardOnFileConfirmationResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(appointmentHolds)
          .where(
            input.paymentSessionReference !== undefined
              ? eq(
                  appointmentHolds.paymentSessionReference,
                  input.paymentSessionReference,
                )
              : eq(
                  appointmentHolds.publicReference,
                  input.publicReference ?? "",
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

        // Terminal confirmation is hold-scoped, not idempotency-key-scoped.
        const confirmation = metadata.cardOnFileConfirmation as
          | ExistingCardOnFileConfirmation
          | undefined;
        if (confirmation !== undefined) {
          return { status: "confirmed", confirmation };
        }

        // Hold-wide in-progress marker blocks all submissions for this hold.
        const markerCheck = isActiveInProgressMarker(
          metadata.cardOnFileInProgress,
          input.now,
        );
        if (markerCheck.active) {
          return { status: "in_progress" };
        }

        // Backwards compatibility: old per-idempotency-key markers also block.
        const legacyInProgress = (metadata.cardOnFileInProgress ??
          {}) as Record<string, { startedAt?: string }>;
        const hasLegacyActive = Object.entries(legacyInProgress).some(
          ([, marker]) =>
            marker?.startedAt !== undefined &&
            input.now.getTime() - new Date(marker.startedAt).getTime() <
              IN_PROGRESS_MARKER_TTL_MS,
        );
        if (hasLegacyActive) {
          return { status: "in_progress" };
        }

        const [updated] = await tx
          .update(appointmentHolds)
          .set({
            reconciliationMetadata: {
              ...metadata,
              cardOnFileInProgress: {
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
            "Hold not found when marking card-on-file confirmation in progress",
          );
        }

        return { status: "available", hold: toBookingHoldRecord(updated) };
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

    async findSavedPaymentMethodBySquareCardId(squareCardId) {
      const [row] = await db
        .select({
          id: bookingSavedPaymentMethods.id,
          cardBrand: bookingSavedPaymentMethods.cardBrand,
          cardLast4: bookingSavedPaymentMethods.cardLast4,
          cardExpMonth: bookingSavedPaymentMethods.cardExpMonth,
          cardExpYear: bookingSavedPaymentMethods.cardExpYear,
          squareCardId: bookingSavedPaymentMethods.squareCardId,
        })
        .from(bookingSavedPaymentMethods)
        .where(eq(bookingSavedPaymentMethods.squareCardId, squareCardId))
        .limit(1);

      if (row === undefined) return null;

      return {
        id: row.id,
        brand: row.cardBrand ?? undefined,
        expMonth: row.cardExpMonth ?? undefined,
        expYear: row.cardExpYear ?? undefined,
        last4: row.cardLast4 ?? undefined,
        squareCardId: row.squareCardId,
      };
    },

    async persistSavedPaymentMethod(input) {
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

    async findPolicyAcceptanceForHold(holdId) {
      const [row] = await db
        .select({ id: bookingPolicyAcceptances.id })
        .from(bookingPolicyAcceptances)
        .where(eq(bookingPolicyAcceptances.holdId, holdId))
        .limit(1);

      return row ?? null;
    },

    async persistPolicyAcceptance(input) {
      const [row] = await db
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
        .returning();

      if (row === undefined) {
        throw new Error("Failed to persist policy acceptance");
      }

      return { id: row.id };
    },

    async findNoShowChargeRecordForHold(holdId: string) {
      const [row] = await db
        .select({
          id: bookingNoShowChargeRecords.id,
          status: bookingNoShowChargeRecords.status,
        })
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.holdId, holdId))
        .limit(1);

      return row ?? null;
    },

    async createNoShowChargeRecord(input) {
      const [row] = await db
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
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();

      if (row === undefined) {
        throw new Error("Failed to create no-show charge record");
      }

      return { id: row.id, status: row.status };
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

    async updateNoShowChargeRecordIfExpectedState(input) {
      const set: Record<string, unknown> = { updatedAt: new Date() };

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

      const conditions = [
        eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
        eq(bookingNoShowChargeRecords.status, input.expectedStatus),
      ];

      if (input.expectedProviderStatus !== undefined) {
        conditions.push(
          eq(
            bookingNoShowChargeRecords.providerStatus,
            input.expectedProviderStatus,
          ),
        );
      }
      if (input.expectedSquareInvoiceId !== undefined) {
        conditions.push(
          eq(
            bookingNoShowChargeRecords.squareInvoiceId,
            input.expectedSquareInvoiceId,
          ),
        );
      }
      if (input.expectedUpdatedAt !== undefined) {
        conditions.push(
          eq(bookingNoShowChargeRecords.updatedAt, input.expectedUpdatedAt),
        );
      }

      const [row] = await db
        .update(bookingNoShowChargeRecords)
        .set(set)
        .where(and(...conditions))
        .returning();

      if (row === undefined) {
        throw new Error(
          "No-show charge record not found or is no longer in the expected state",
        );
      }

      return { id: row.id, status: row.status };
    },

    async updateNoShowChargeRecordIfNotTerminal(input) {
      const set: Record<string, unknown> = { updatedAt: new Date() };

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
        .where(
          and(
            eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
            notInArray(bookingNoShowChargeRecords.status, [
              "charged",
              "charge_failed",
            ]),
          ),
        )
        .returning();

      if (row === undefined) {
        throw new Error(
          "No-show charge record not found or is already in a terminal state",
        );
      }

      return { id: row.id, status: row.status };
    },

    async getNoShowChargeRecordById(
      noShowChargeRecordId,
    ): Promise<NoShowChargeRecordDetail | null> {
      const [row] = await db
        .select()
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.id, noShowChargeRecordId))
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        status: row.status,
        squareInvoiceId: row.squareInvoiceId ?? undefined,
        squareOrderId: row.squareOrderId ?? undefined,
        squarePaymentId: row.squarePaymentId ?? undefined,
        squareCardId: row.squareCardId ?? undefined,
        squareCustomerId: row.squareCustomerId ?? undefined,
        savedPaymentMethodId: row.savedPaymentMethodId ?? undefined,
        policyAcceptanceId: row.policyAcceptanceId ?? undefined,
        maxChargeCents: row.maxChargeCents,
        currency: row.currency,
        providerStatus: row.providerStatus ?? undefined,
        providerFailureReason: row.providerFailureReason ?? undefined,
        providerMetadata:
          (row.providerMetadata as BookingNoShowProviderMetadata | null) ??
          undefined,
        updatedAt: row.updatedAt ?? undefined,
      };
    },

    async recordNoShowAdminAction(input) {
      return db.transaction(async (tx) => {
        const [record] = await tx
          .select({
            adminActionAt: bookingNoShowChargeRecords.adminActionAt,
            adminOperatorId: bookingNoShowChargeRecords.adminOperatorId,
            adminReason: bookingNoShowChargeRecords.adminReason,
            adminEligibilityCheckedAt:
              bookingNoShowChargeRecords.adminEligibilityCheckedAt,
          })
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId))
          .limit(1)
          .for("update");

        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }

        // Replay/non-owner protection: never overwrite an existing admin audit.
        if (
          record.adminActionAt !== null ||
          record.adminOperatorId !== null ||
          record.adminReason !== null ||
          record.adminEligibilityCheckedAt !== null
        ) {
          return { recorded: false };
        }

        const [updated] = await tx
          .update(bookingNoShowChargeRecords)
          .set({
            adminActionAt: input.now,
            adminEligibilityCheckedAt: input.now,
            adminOperatorId: input.operatorId,
            adminReason: input.reason,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
              isNull(bookingNoShowChargeRecords.adminActionAt),
              isNull(bookingNoShowChargeRecords.adminOperatorId),
              isNull(bookingNoShowChargeRecords.adminReason),
              isNull(bookingNoShowChargeRecords.adminEligibilityCheckedAt),
            ),
          )
          .returning();

        if (updated === undefined) {
          throw new Error(
            "No-show charge record not found when recording admin action",
          );
        }

        return { recorded: true };
      });
    },

    async findNoShowChargeAttempt({ noShowChargeRecordId, idempotencyKey }) {
      const [row] = await db
        .select()
        .from(bookingNoShowChargeAttempts)
        .where(
          and(
            eq(
              bookingNoShowChargeAttempts.noShowChargeRecordId,
              noShowChargeRecordId,
            ),
            eq(bookingNoShowChargeAttempts.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (row === undefined) {
        return null;
      }

      return toNoShowChargeAttempt(row);
    },

    async createNoShowChargeAttempt(input) {
      const [row] = await db
        .insert(bookingNoShowChargeAttempts)
        .values({
          noShowChargeRecordId: input.noShowChargeRecordId,
          idempotencyKey: input.idempotencyKey,
          amountCents: input.amountCents,
          currency: input.currency,
          status: input.status,
          createdAt: input.now,
        })
        .returning();

      if (row === undefined) {
        throw new Error("Failed to create no-show charge attempt");
      }

      return toNoShowChargeAttempt(row);
    },

    async updateNoShowChargeAttempt(input) {
      const set: Record<string, unknown> = {};

      if (input.status !== undefined) {
        set.status = input.status;
      }
      if (input.squarePaymentId !== undefined) {
        set.squarePaymentId = input.squarePaymentId;
      }
      if (input.squareInvoiceId !== undefined) {
        set.squareInvoiceId = input.squareInvoiceId;
      }
      if (input.failureReason !== undefined) {
        set.failureReason = input.failureReason;
      }
      if (input.processedAt !== undefined) {
        set.processedAt = input.processedAt;
      }

      const [row] = await db
        .update(bookingNoShowChargeAttempts)
        .set(set)
        .where(eq(bookingNoShowChargeAttempts.id, input.attemptId))
        .returning();

      if (row === undefined) {
        throw new Error("No-show charge attempt not found");
      }

      return toNoShowChargeAttempt(row);
    },

    async claimNoShowChargeAttempt(
      input,
    ): Promise<NoShowChargeAttemptClaimResult> {
      return db.transaction(async (tx) => {
        const [record] = await tx
          .select()
          .from(bookingNoShowChargeRecords)
          .where(eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId))
          .limit(1)
          .for("update");

        if (record === undefined) {
          throw new Error("No-show charge record not found");
        }

        const [existingAttempt] = await tx
          .select()
          .from(bookingNoShowChargeAttempts)
          .where(
            and(
              eq(
                bookingNoShowChargeAttempts.noShowChargeRecordId,
                input.noShowChargeRecordId,
              ),
              eq(
                bookingNoShowChargeAttempts.idempotencyKey,
                input.idempotencyKey,
              ),
            ),
          )
          .limit(1);

        if (existingAttempt !== undefined) {
          return {
            attempt: toNoShowChargeAttempt(existingAttempt),
            isOwner: false,
            record: toNoShowChargeRecordDetail(record),
          };
        }

        const recordDetail = toNoShowChargeRecordDetail(record);

        if (
          input.amountCents !== getNoShowAllowedChargeAmountCents(recordDetail)
        ) {
          throw new NoShowInvoiceAmountError(
            `Amount ${input.amountCents} does not match allowed charge ${getNoShowAllowedChargeAmountCents(recordDetail)} ${record.currency}`,
            {
              allowedAmountCents:
                getNoShowAllowedChargeAmountCents(recordDetail),
            },
          );
        }

        let status: string;
        let isOwner = false;
        let squarePaymentId: string | null = null;
        let failureReason: string | null = null;
        let recordStatus: NoShowChargeStatus | undefined;
        let providerStatus: string | null = null;

        if (record.status === "provider_draft_created") {
          status = "charge_pending";
          isOwner = true;
          recordStatus = "charge_pending";
          providerStatus = "publish_pending";
        } else if (record.status === "charge_pending") {
          status = "charge_pending";
        } else if (record.status === "charged") {
          status = "charged";
          squarePaymentId = record.squarePaymentId;
        } else if (record.status === "charge_failed") {
          status = "charge_failed";
          failureReason = record.providerFailureReason;
        } else {
          status = "manual_followup";
        }

        const [attemptRow] = await tx
          .insert(bookingNoShowChargeAttempts)
          .values({
            noShowChargeRecordId: input.noShowChargeRecordId,
            idempotencyKey: input.idempotencyKey,
            amountCents: input.amountCents,
            currency: input.currency,
            status,
            squarePaymentId,
            failureReason,
            createdAt: input.now,
          })
          .returning();

        if (attemptRow === undefined) {
          throw new Error("Failed to create no-show charge attempt");
        }

        if (recordStatus !== undefined) {
          await tx
            .update(bookingNoShowChargeRecords)
            .set({
              status: recordStatus,
              providerStatus,
              updatedAt: input.now,
            })
            .where(
              eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
            );
        }

        return {
          attempt: toNoShowChargeAttempt(attemptRow),
          isOwner,
          record: toNoShowChargeRecordDetail(record),
        };
      });
    },

    async recoverStaleNoShowChargePending(input) {
      return db.transaction(async (tx) => {
        const staleThreshold = new Date(
          input.now.getTime() - STALE_CHARGE_PENDING_MS,
        );

        const conditions = [
          eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
          eq(bookingNoShowChargeRecords.status, "charge_pending"),
          eq(bookingNoShowChargeRecords.providerStatus, "publish_pending"),
          lt(bookingNoShowChargeRecords.updatedAt, staleThreshold),
        ];

        if (input.expectedSquareInvoiceId !== undefined) {
          conditions.push(
            eq(
              bookingNoShowChargeRecords.squareInvoiceId,
              input.expectedSquareInvoiceId,
            ),
          );
        }
        if (input.expectedUpdatedAt !== undefined) {
          conditions.push(
            eq(bookingNoShowChargeRecords.updatedAt, input.expectedUpdatedAt),
          );
        }

        const [record] = await tx
          .select()
          .from(bookingNoShowChargeRecords)
          .where(and(...conditions))
          .limit(1)
          .for("update");

        if (record === undefined) {
          return null;
        }

        const [updated] = await tx
          .update(bookingNoShowChargeRecords)
          .set({
            status: "provider_draft_created",
            providerStatus: "DRAFT",
            updatedAt: input.now,
          })
          .where(and(...conditions))
          .returning();

        if (updated === undefined) {
          return null;
        }

        return toNoShowChargeRecordDetail(updated);
      });
    },

    async loadCardOnFileProgress(
      holdId: string,
    ): Promise<CardOnFileProgressCheckpoint | null> {
      const [row] = await db
        .select({
          reconciliationMetadata: appointmentHolds.reconciliationMetadata,
        })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, holdId))
        .limit(1);

      if (row === undefined) return null;

      const metadata = (row.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const progress = metadata.cardOnFileProgress as
        | CardOnFileProgressCheckpoint
        | undefined;
      return progress ?? null;
    },

    async saveCardOnFileProgress(input: {
      holdId: string;
      progress: Partial<CardOnFileProgressCheckpoint>;
      now: Date;
    }): Promise<void> {
      const [row] = await db
        .select({
          reconciliationMetadata: appointmentHolds.reconciliationMetadata,
        })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, input.holdId))
        .limit(1);

      if (row === undefined) {
        throw new Error("Hold not found when saving card-on-file progress");
      }

      const metadata = (row.reconciliationMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const existing = (metadata.cardOnFileProgress ??
        {}) as CardOnFileProgressCheckpoint;

      await db
        .update(appointmentHolds)
        .set({
          reconciliationMetadata: {
            ...metadata,
            cardOnFileProgress: { ...existing, ...input.progress },
          },
          updatedAt: input.now,
        })
        .where(eq(appointmentHolds.id, input.holdId));
    },

    async markHoldBookedWithConfirmation(input) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
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

        // Compare-and-set: never overwrite an existing terminal confirmation.
        const existingConfirmation = metadata.cardOnFileConfirmation as
          | ExistingCardOnFileConfirmation
          | undefined;
        if (existingConfirmation !== undefined) {
          throw new Error("Terminal card-on-file confirmation already exists");
        }

        // Do not finalize if another active attempt owns the in-progress marker.
        const markerCheck = isActiveInProgressMarker(
          metadata.cardOnFileInProgress,
          input.now,
        );
        if (
          markerCheck.active &&
          markerCheck.idempotencyKey !== undefined &&
          markerCheck.idempotencyKey !== input.idempotencyKey
        ) {
          throw new Error(
            "Hold is locked by another card-on-file confirmation attempt",
          );
        }

        const [row] = await tx
          .update(appointmentHolds)
          .set({
            status: "booked",
            bookedAt: input.now,
            googleEventId: input.googleEventId,
            savedPaymentMethodId: input.savedPaymentMethodId,
            policyAcceptanceId: input.policyAcceptanceId,
            noShowChargeRecordId: input.noShowChargeRecordId,
            squareCustomerId: input.squareCustomerId,
            squareCardId: input.squareCardId,
            cardOnFileStatus: input.noShowChargeStatus,
            finalizationStatus: "booked",
            reconciliationMetadata: {
              ...metadata,
              cardOnFileConfirmation: input.confirmation,
              cardOnFileInProgress: undefined,
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

    async markHoldManualFollowupWithConfirmation(input) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
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

        // Compare-and-set: never overwrite an existing terminal confirmation.
        const existingConfirmation = metadata.cardOnFileConfirmation as
          | ExistingCardOnFileConfirmation
          | undefined;
        if (existingConfirmation !== undefined) {
          throw new Error("Terminal card-on-file confirmation already exists");
        }

        // Do not finalize if another active attempt owns the in-progress marker.
        const markerCheck = isActiveInProgressMarker(
          metadata.cardOnFileInProgress,
          input.now,
        );
        if (
          markerCheck.active &&
          markerCheck.idempotencyKey !== undefined &&
          markerCheck.idempotencyKey !== input.idempotencyKey
        ) {
          throw new Error(
            "Hold is locked by another card-on-file confirmation attempt",
          );
        }

        const [row] = await tx
          .update(appointmentHolds)
          .set({
            status: "manual_followup",
            manualFollowupAt: input.now,
            savedPaymentMethodId: input.savedPaymentMethodId,
            policyAcceptanceId: input.policyAcceptanceId,
            noShowChargeRecordId: input.noShowChargeRecordId,
            squareCustomerId: input.squareCustomerId,
            squareCardId: input.squareCardId,
            cardOnFileStatus: input.noShowChargeStatus,
            failureReason: input.reason,
            finalizationStatus: "manual_review",
            reconciliationMetadata: {
              ...metadata,
              cardOnFileConfirmation: input.confirmation,
              cardOnFileInProgress: undefined,
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

    async findNoShowChargeRecordBySquareInvoiceId(squareInvoiceId) {
      const [row] = await db
        .select()
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.squareInvoiceId, squareInvoiceId))
        .limit(1);

      return row === undefined ? null : toNoShowChargeRecordDetail(row);
    },

    async findNoShowChargeRecordBySquarePaymentId(squarePaymentId) {
      const [row] = await db
        .select()
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.squarePaymentId, squarePaymentId))
        .limit(1);

      return row === undefined ? null : toNoShowChargeRecordDetail(row);
    },

    async findNoShowChargeRecordBySquareOrderId(squareOrderId) {
      const [row] = await db
        .select()
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.squareOrderId, squareOrderId))
        .limit(1);

      return row === undefined ? null : toNoShowChargeRecordDetail(row);
    },

    async findNoShowChargeEventByProviderEventId(eventId) {
      const [row] = await db
        .select({
          noShowChargeRecordId: checkoutPaymentEvents.noShowChargeRecordId,
          processingStatus: checkoutPaymentEvents.processingStatus,
        })
        .from(checkoutPaymentEvents)
        .where(
          and(
            eq(checkoutPaymentEvents.paymentProvider, "square"),
            eq(checkoutPaymentEvents.providerEventId, eventId),
          ),
        )
        .limit(1);

      if (row === undefined || row.noShowChargeRecordId === null) {
        return null;
      }

      return {
        noShowChargeRecordId: row.noShowChargeRecordId,
        processingStatus: row.processingStatus,
      };
    },

    async finalizeNoShowChargeRecord(input) {
      return db.transaction(async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() };

        if (input.status !== undefined) {
          set.status = input.status;
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

        const [updated] = await tx
          .update(bookingNoShowChargeRecords)
          .set(set)
          .where(
            and(
              eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId),
              notInArray(bookingNoShowChargeRecords.status, [
                "charged",
                "charge_failed",
              ]),
            ),
          )
          .returning();

        if (updated === undefined) {
          throw new Error(
            "No-show charge record not found or is already in a terminal state",
          );
        }

        await tx.insert(checkoutPaymentEvents).values({
          eventType: input.event.eventType,
          noShowChargeRecordId: input.noShowChargeRecordId,
          paymentProvider: "square",
          payloadSanitized: input.event.payloadSanitized,
          processedAt: input.event.processedAt,
          processingStatus: input.event.processingStatus,
          providerCheckoutId: input.event.providerInvoiceId,
          providerEventId: input.event.eventId,
          providerOrderId: input.event.providerOrderId,
          providerPaymentId: input.event.providerPaymentId,
          status: input.event.status,
        });
      });
    },

    async recordNoShowChargeWebhookEvent(input) {
      await db
        .insert(checkoutPaymentEvents)
        .values({
          eventType: input.eventType,
          noShowChargeRecordId: input.noShowChargeRecordId,
          paymentProvider: "square",
          payloadSanitized: input.payloadSanitized,
          processedAt: input.processedAt,
          processingStatus: input.processingStatus,
          providerCheckoutId: input.providerInvoiceId,
          providerEventId: input.eventId,
          providerOrderId: input.providerOrderId,
          providerPaymentId: input.providerPaymentId,
          status: input.status,
        })
        .onConflictDoNothing({
          target: [
            checkoutPaymentEvents.paymentProvider,
            checkoutPaymentEvents.providerEventId,
          ],
        });
    },
  };
}

function toNoShowChargeAttempt(
  row: typeof bookingNoShowChargeAttempts.$inferSelect,
): NoShowChargeAttempt {
  return {
    id: row.id,
    noShowChargeRecordId: row.noShowChargeRecordId!,
    idempotencyKey: row.idempotencyKey!,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status ?? undefined,
    squarePaymentId: row.squarePaymentId ?? undefined,
    squareInvoiceId: row.squareInvoiceId ?? undefined,
    failureReason: row.failureReason ?? undefined,
    processedAt: row.processedAt ?? undefined,
  };
}

function toNoShowChargeRecordDetail(
  row: typeof bookingNoShowChargeRecords.$inferSelect,
): NoShowChargeRecordDetail {
  return {
    id: row.id,
    status: row.status,
    squareInvoiceId: row.squareInvoiceId ?? undefined,
    squareOrderId: row.squareOrderId ?? undefined,
    squarePaymentId: row.squarePaymentId ?? undefined,
    squareCardId: row.squareCardId ?? undefined,
    squareCustomerId: row.squareCustomerId ?? undefined,
    savedPaymentMethodId: row.savedPaymentMethodId ?? undefined,
    policyAcceptanceId: row.policyAcceptanceId ?? undefined,
    maxChargeCents: row.maxChargeCents,
    currency: row.currency,
    providerStatus: row.providerStatus ?? undefined,
    providerFailureReason: row.providerFailureReason ?? undefined,
    providerMetadata:
      (row.providerMetadata as BookingNoShowProviderMetadata | null) ??
      undefined,
    updatedAt: row.updatedAt ?? undefined,
    adminActionAt: row.adminActionAt ?? undefined,
    adminOperatorId: row.adminOperatorId ?? undefined,
    adminReason: row.adminReason ?? undefined,
    adminEligibilityCheckedAt: row.adminEligibilityCheckedAt ?? undefined,
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
