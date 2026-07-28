import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { resolveBookingModelVersion } from "@/lib/booking/booking-model-version";
import type { BookingHoldRecord, BookingHoldState } from "@/lib/booking/holds";
import type {
  ChargeAndStoreRepository,
  ChargeAndStoreBookingResult,
} from "@/lib/booking/payments/service-charge-and-store";
import {
  appointmentHolds,
  bookingNoShowChargeRecords,
  bookingPaymentAttempts,
  bookingPolicyAcceptances,
  bookingResourceReservations,
  bookingSavedPaymentMethods,
  bookingSquareCustomers,
} from "@/lib/private-db/schema";

import { createAppointmentFinalizationRepository } from "./appointment-finalization-repository";
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
  const appointmentFinalization = createAppointmentFinalizationRepository(db);

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

        const bookingModelVersion = resolveBookingModelVersion(row);

        const metadata = (row.reconciliationMetadata ?? {}) as Record<
          string,
          unknown
        >;

        const confirmation = metadata.chargeAndStoreConfirmation as
          | Extract<ChargeAndStoreBookingResult, { ok: true }>
          | undefined;
        if (confirmation !== undefined) {
          return { status: "confirmed", confirmation, holdId: row.id };
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

        // Provider-observed capture is committed before appointment
        // projection. A retry must resume that projection even when the
        // appointment transaction previously failed.
        if (
          bookingModelVersion === 2 &&
          row.status !== "refund_required" &&
          row.finalizationStatus !== "refund_required"
        ) {
          const [capturedAttempt] = await tx
            .select({
              amountCents: bookingPaymentAttempts.amountCents,
              currency: bookingPaymentAttempts.currency,
              idempotencyKey: bookingPaymentAttempts.idempotencyKey,
              providerOrderId: bookingPaymentAttempts.providerOrderId,
              providerPaymentId: bookingPaymentAttempts.providerPaymentId,
            })
            .from(bookingPaymentAttempts)
            .where(
              and(
                eq(bookingPaymentAttempts.holdId, row.id),
                eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
                eq(bookingPaymentAttempts.paymentProvider, "square"),
                eq(bookingPaymentAttempts.status, "captured"),
              ),
            )
            .orderBy(desc(bookingPaymentAttempts.createdAt))
            .limit(1);

          if (capturedAttempt?.providerPaymentId != null) {
            const [savedCard] =
              row.savedPaymentMethodId === null
                ? []
                : await tx
                    .select({
                      brand: bookingSavedPaymentMethods.cardBrand,
                      expMonth: bookingSavedPaymentMethods.cardExpMonth,
                      expYear: bookingSavedPaymentMethods.cardExpYear,
                      last4: bookingSavedPaymentMethods.cardLast4,
                    })
                    .from(bookingSavedPaymentMethods)
                    .where(
                      eq(
                        bookingSavedPaymentMethods.id,
                        row.savedPaymentMethodId,
                      ),
                    )
                    .limit(1);

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
                "Hold not found when claiming captured charge-and-store finalization",
              );
            }

            return {
              status: "captured_pending_finalization",
              card: {
                brand: savedCard?.brand ?? undefined,
                expMonth: savedCard?.expMonth ?? undefined,
                expYear: savedCard?.expYear ?? undefined,
                last4: savedCard?.last4 ?? undefined,
              },
              hold: toBookingHoldRecord(updated),
              payment: {
                amountCents: capturedAttempt.amountCents,
                currency: capturedAttempt.currency,
                idempotencyKey: capturedAttempt.idempotencyKey,
                squareOrderId: capturedAttempt.providerOrderId ?? undefined,
                squarePaymentId: capturedAttempt.providerPaymentId,
                status: "COMPLETED",
              },
            };
          }
        }

        if (
          bookingModelVersion === 2 &&
          row.status !== "refund_required" &&
          row.finalizationStatus !== "refund_required"
        ) {
          const [authorizedAttempt] = await tx
            .select({
              amountCents: bookingPaymentAttempts.amountCents,
              currency: bookingPaymentAttempts.currency,
              idempotencyKey: bookingPaymentAttempts.idempotencyKey,
              providerMetadata: bookingPaymentAttempts.providerMetadata,
              providerOrderId: bookingPaymentAttempts.providerOrderId,
              providerPaymentId: bookingPaymentAttempts.providerPaymentId,
              squareTeamMemberId: bookingPaymentAttempts.squareTeamMemberId,
            })
            .from(bookingPaymentAttempts)
            .where(
              and(
                eq(bookingPaymentAttempts.holdId, row.id),
                eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
                eq(bookingPaymentAttempts.paymentProvider, "square"),
                eq(bookingPaymentAttempts.status, "authorized"),
              ),
            )
            .orderBy(desc(bookingPaymentAttempts.createdAt))
            .limit(1);

          if (authorizedAttempt?.providerPaymentId != null) {
            const prerequisitesAreDurable =
              row.savedPaymentMethodId !== null &&
              row.policyAcceptanceId !== null &&
              row.noShowChargeRecordId !== null &&
              row.squareCustomerId !== null &&
              row.squareCardId !== null &&
              row.cardOnFileStatus === "ready";

            // Authorization is only written immediately before capture, after
            // every card/no-show prerequisite. If that invariant is ever
            // violated, fail closed instead of returning to CreatePayment.
            if (!prerequisitesAreDurable) {
              return { status: "unavailable" };
            }

            const [savedCard] = await tx
              .select({
                brand: bookingSavedPaymentMethods.cardBrand,
                expMonth: bookingSavedPaymentMethods.cardExpMonth,
                expYear: bookingSavedPaymentMethods.cardExpYear,
                last4: bookingSavedPaymentMethods.cardLast4,
              })
              .from(bookingSavedPaymentMethods)
              .where(
                eq(bookingSavedPaymentMethods.id, row.savedPaymentMethodId!),
              )
              .limit(1);

            if (savedCard === undefined) {
              return { status: "unavailable" };
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
                "Hold not found when claiming authorized charge-and-store payment",
              );
            }

            const versionToken =
              typeof authorizedAttempt.providerMetadata?.squareVersionToken ===
              "string"
                ? authorizedAttempt.providerMetadata.squareVersionToken
                : undefined;

            return {
              status: "authorized_pending_capture",
              card: {
                brand: savedCard.brand ?? undefined,
                expMonth: savedCard.expMonth ?? undefined,
                expYear: savedCard.expYear ?? undefined,
                last4: savedCard.last4 ?? undefined,
              },
              hold: toBookingHoldRecord(updated),
              payment: {
                amountCents: authorizedAttempt.amountCents,
                captureLeaseId:
                  row.captureLeaseId ?? "missing-operational-capture-lease",
                currency: authorizedAttempt.currency,
                idempotencyKey: authorizedAttempt.idempotencyKey,
                squareOrderId: authorizedAttempt.providerOrderId ?? undefined,
                squarePaymentId: authorizedAttempt.providerPaymentId,
                status: "APPROVED",
                squareTeamMemberId:
                  authorizedAttempt.squareTeamMemberId ?? undefined,
                versionToken,
              },
            };
          }
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

    async prepareOperationalPaymentIntent(input) {
      if (
        input.leaseExpiresAt <= input.now ||
        input.requestBodyHash.length === 0 ||
        input.sourceIdHash.length === 0
      ) {
        throw new TypeError("Invalid operational payment intent");
      }

      return db.transaction(async (tx) => {
        const [candidateHold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1);
        if (candidateHold === undefined) {
          return { status: "unavailable" } as const;
        }

        const expectedResourceIds = readExpectedReservedResourceIds(
          candidateHold.offeringSnapshot,
        );
        for (const resourceId of expectedResourceIds) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${resourceId}::text, 0))`,
          );
        }

        const [hold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");
        if (
          hold === undefined ||
          resolveBookingModelVersion(hold) !== 2 ||
          hold.status !== "held" ||
          hold.finalizationStatus !== "pending"
        ) {
          return { status: "unavailable" } as const;
        }

        const reservations = await tx
          .select()
          .from(bookingResourceReservations)
          .where(eq(bookingResourceReservations.holdId, hold.id))
          .for("update");
        if (
          !reservationsMatchExpectedResources(
            reservations,
            expectedResourceIds,
            input.now,
          )
        ) {
          return { status: "unavailable" } as const;
        }

        const [pendingAttempt] = await tx
          .select()
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, hold.id),
              eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
              eq(bookingPaymentAttempts.paymentProvider, "square"),
              eq(bookingPaymentAttempts.status, "pending"),
            ),
          )
          .orderBy(desc(bookingPaymentAttempts.createdAt))
          .limit(1)
          .for("update");

        const existingIntent = readSquareRequestIntent(
          pendingAttempt?.providerMetadata,
        );
        const requestMatches =
          pendingAttempt !== undefined &&
          pendingAttempt.amountCents === input.amountCents &&
          pendingAttempt.currency === input.currency.trim().toUpperCase() &&
          existingIntent?.requestBodyHash === input.requestBodyHash &&
          existingIntent.sourceIdHash === input.sourceIdHash &&
          existingIntent.squareCustomerId === input.squareCustomerId &&
          existingIntent.referenceId === input.referenceId &&
          (existingIntent.squareTeamMemberId ?? undefined) ===
            input.squareTeamMemberId &&
          (existingIntent.verificationTokenHash ?? undefined) ===
            input.verificationTokenHash;
        const captureLeaseId =
          hold.captureLeaseId !== null &&
          hold.captureLeaseExpiresAt !== null &&
          hold.captureLeaseExpiresAt > input.now
            ? hold.captureLeaseId
            : randomUUID();
        const protectedUntil = new Date(
          Math.max(hold.expiresAt.getTime(), input.leaseExpiresAt.getTime()),
        );

        await tx
          .update(appointmentHolds)
          .set({
            captureLeaseExpiresAt: protectedUntil,
            captureLeaseId,
            expiresAt: protectedUntil,
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, hold.id));
        await tx
          .update(bookingResourceReservations)
          .set({ expiresAt: protectedUntil, updatedAt: input.now })
          .where(
            and(
              eq(bookingResourceReservations.holdId, hold.id),
              eq(bookingResourceReservations.kind, "hold"),
              eq(bookingResourceReservations.state, "active"),
            ),
          );

        if (pendingAttempt !== undefined && !requestMatches) {
          return {
            idempotencyKey: pendingAttempt.idempotencyKey,
            status: "changed_request",
          } as const;
        }

        if (pendingAttempt !== undefined) {
          return {
            captureLeaseId,
            idempotencyKey: pendingAttempt.idempotencyKey,
            reused: true,
            status: "ready",
          } as const;
        }

        const [attempt] = await tx
          .insert(bookingPaymentAttempts)
          .values({
            amountCents: input.amountCents,
            createdAt: input.now,
            currency: input.currency.trim().toUpperCase(),
            holdId: hold.id,
            idempotencyKey: input.idempotencyKeyCandidate,
            operation: "square_charge_and_store",
            paymentProvider: "square",
            providerMetadata: {
              squareRequestIntent: {
                createdAt: input.now.toISOString(),
                referenceId: input.referenceId,
                requestBodyHash: input.requestBodyHash,
                sourceIdHash: input.sourceIdHash,
                squareCustomerId: input.squareCustomerId,
                squareTeamMemberId: input.squareTeamMemberId,
                verificationTokenHash: input.verificationTokenHash,
                version: 1,
              },
            },
            squareTeamMemberId: input.squareTeamMemberId,
            status: "pending",
            updatedAt: input.now,
          })
          .returning();
        if (attempt === undefined) {
          throw new Error("Failed to persist operational payment intent");
        }

        return {
          captureLeaseId,
          idempotencyKey: attempt.idempotencyKey,
          reused: false,
          status: "ready",
        } as const;
      });
    },

    async terminateOperationalPaymentIntent(input) {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: appointmentHolds.id })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");
        const [attempt] = await tx
          .select()
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, input.holdId),
              eq(bookingPaymentAttempts.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
          .for("update");

        if (attempt === undefined) return false;
        if (attempt.status === input.status) return true;
        if (attempt.status !== "pending") return false;

        const [updated] = await tx
          .update(bookingPaymentAttempts)
          .set({
            failedAt: input.status === "failed" ? input.now : undefined,
            status: input.status,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(bookingPaymentAttempts.id, attempt.id),
              eq(bookingPaymentAttempts.status, "pending"),
            ),
          )
          .returning({ id: bookingPaymentAttempts.id });

        return updated !== undefined;
      });
    },

    async validateOperationalCaptureLease(input) {
      if (input.leaseExpiresAt <= input.now) return false;

      return db.transaction(async (tx) => {
        const [candidateHold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1);
        if (candidateHold === undefined) return false;
        const expectedResourceIds = readExpectedReservedResourceIds(
          candidateHold.offeringSnapshot,
        );
        for (const resourceId of expectedResourceIds) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${resourceId}::text, 0))`,
          );
        }

        const [hold] = await tx
          .select()
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");
        const [attempt] = await tx
          .select()
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, input.holdId),
              eq(bookingPaymentAttempts.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
          .for("update");
        if (
          hold === undefined ||
          hold.captureLeaseId !== input.captureLeaseId ||
          hold.captureLeaseExpiresAt === null ||
          hold.captureLeaseExpiresAt <= input.now ||
          attempt === undefined ||
          attempt.status !== "authorized" ||
          attempt.providerPaymentId !== input.squarePaymentId
        ) {
          return false;
        }

        const reservations = await tx
          .select()
          .from(bookingResourceReservations)
          .where(eq(bookingResourceReservations.holdId, hold.id))
          .for("update");
        if (
          !reservationsMatchExpectedResources(
            reservations,
            expectedResourceIds,
            input.now,
          )
        ) {
          return false;
        }

        const protectedUntil = new Date(
          Math.max(hold.expiresAt.getTime(), input.leaseExpiresAt.getTime()),
        );
        await tx
          .update(appointmentHolds)
          .set({
            captureLeaseExpiresAt: protectedUntil,
            expiresAt: protectedUntil,
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, hold.id));
        await tx
          .update(bookingResourceReservations)
          .set({ expiresAt: protectedUntil, updatedAt: input.now })
          .where(
            and(
              eq(bookingResourceReservations.holdId, hold.id),
              eq(bookingResourceReservations.kind, "hold"),
              eq(bookingResourceReservations.state, "active"),
            ),
          );

        return true;
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

    async recordCapturedOperationalPayment(input) {
      await appointmentFinalization.recordPaymentAttempt({
        amountCents: input.amountCents,
        capturedAt: input.now,
        currency: input.currency,
        holdId: input.holdId,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerOrderId: input.squareOrderId,
        providerPaymentId: input.squarePaymentId,
        status: "captured",
      });

      await appointmentFinalization.confirmOperationalAppointment({
        calendar: { status: "pending" },
        holdId: input.holdId,
        holdOutcome: "paid_pending_booking",
        now: input.now,
        payment: {
          amountCents: input.amountCents,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          operation: "square_charge_and_store",
          paymentProvider: "square",
          providerOrderId: input.squareOrderId,
          providerPaymentId: input.squarePaymentId,
        },
        source: "square_charge_and_store",
      });
    },

    async recordAuthorizedOperationalPayment(input) {
      const result = await appointmentFinalization.recordPaymentAttempt({
        amountCents: input.amountCents,
        authorizationEligibility: "square_charge_and_store_pre_capture",
        authorizedAt: input.now,
        currency: input.currency,
        holdId: input.holdId,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
        operation: "square_charge_and_store",
        paymentProvider: "square",
        providerMetadata:
          input.versionToken === undefined
            ? undefined
            : { squareVersionToken: input.versionToken },
        providerOrderId: input.squareOrderId,
        providerPaymentId: input.squarePaymentId,
        status: "authorized",
      });

      return { bookingModelVersion: result.bookingModelVersion };
    },

    async markHoldBooked(input) {
      const finalization =
        await appointmentFinalization.confirmOperationalAppointment({
          calendar: {
            providerEventId: input.googleEventId,
            status: "synced",
          },
          holdId: input.holdId,
          holdOutcome: "booked",
          now: input.now,
          source: "square_charge_and_store",
          terminal: {
            confirmation: input.confirmation,
            kind: "charge_and_store",
          },
        });

      if (finalization.bookingModelVersion === 2) {
        return toBookingHoldRecord(finalization.hold);
      }

      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
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
          return toBookingHoldRecord(locked);
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
      const finalization =
        await appointmentFinalization.confirmOperationalAppointment({
          calendar: {
            errorCode: "calendar_finalization_failed",
            reason: input.reason,
            status: "manual_followup",
          },
          holdId: input.holdId,
          holdOutcome: "manual_followup",
          now: input.now,
          source: "square_charge_and_store",
          terminal: {
            confirmation: input.confirmation,
            kind: "charge_and_store",
          },
        });

      if (finalization.bookingModelVersion === 2) {
        return toBookingHoldRecord(finalization.hold);
      }

      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
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
          return toBookingHoldRecord(locked);
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

    async markAuthorizedOperationalPaymentTerminated(input) {
      return db.transaction(async (tx) => {
        const [hold] = await tx
          .select({
            bookingModelVersion: appointmentHolds.bookingModelVersion,
            id: appointmentHolds.id,
          })
          .from(appointmentHolds)
          .where(eq(appointmentHolds.id, input.holdId))
          .limit(1)
          .for("update");

        if (hold === undefined || resolveBookingModelVersion(hold) === 1) {
          return "not_found" as const;
        }

        const [attempt] = await tx
          .select()
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, input.holdId),
              eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
              eq(bookingPaymentAttempts.paymentProvider, "square"),
              input.idempotencyKey === undefined
                ? eq(
                    bookingPaymentAttempts.providerPaymentId,
                    input.squarePaymentId,
                  )
                : or(
                    eq(
                      bookingPaymentAttempts.providerPaymentId,
                      input.squarePaymentId,
                    ),
                    and(
                      eq(
                        bookingPaymentAttempts.idempotencyKey,
                        input.idempotencyKey,
                      ),
                      isNull(bookingPaymentAttempts.providerPaymentId),
                    ),
                  ),
              inArray(bookingPaymentAttempts.status, [
                "pending",
                "authorized",
                "captured",
                "refunded",
                "failed",
                "cancelled",
              ]),
            ),
          )
          .orderBy(desc(bookingPaymentAttempts.createdAt))
          .limit(1)
          .for("update");

        if (
          attempt === undefined ||
          (attempt.providerPaymentId !== null &&
            attempt.providerPaymentId !== input.squarePaymentId)
        ) {
          return "not_found" as const;
        }
        if (attempt.status === "captured" || attempt.status === "refunded") {
          return "capture_preserved" as const;
        }
        if (attempt.status === input.status) {
          return input.status;
        }
        if (attempt.status !== "pending" && attempt.status !== "authorized") {
          return "not_found" as const;
        }

        const [terminated] = await tx
          .update(bookingPaymentAttempts)
          .set({
            failedAt: input.status === "failed" ? input.now : undefined,
            providerPaymentId:
              attempt.providerPaymentId ?? input.squarePaymentId,
            status: input.status,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(bookingPaymentAttempts.id, attempt.id),
              inArray(bookingPaymentAttempts.status, ["pending", "authorized"]),
            ),
          )
          .returning({ id: bookingPaymentAttempts.id });

        return terminated === undefined
          ? ("capture_preserved" as const)
          : input.status;
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

        const [authorizedAttempt] = await tx
          .select({ id: bookingPaymentAttempts.id })
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, input.holdId),
              eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
              eq(bookingPaymentAttempts.paymentProvider, "square"),
              eq(bookingPaymentAttempts.status, "authorized"),
            ),
          )
          .limit(1)
          .for("update");

        // Terminal charge-and-store states must never be overwritten by a
        // stale retry or a late failure/cancel path. Checking both the status
        // and the reconciliation metadata protects against races where one
        // path updates the status and another path updates metadata.
        const terminalStatuses = new Set([
          "booked",
          "manual_followup",
          // V2 sets this only in the same transaction that creates the
          // authoritative appointment and captured payment attempt. A stale
          // failure path must never make that already-paid hold retryable.
          "paid_pending_booking",
          "refund_required",
          "refunded",
          "manual_rebooked",
          "paid_unbookable_rebooking_pending",
        ]);
        if (
          terminalStatuses.has(locked.status) ||
          authorizedAttempt !== undefined ||
          metadata.chargeAndStoreConfirmation !== undefined ||
          metadata.chargeAndStoreRefundRequired !== undefined ||
          metadata.authoritativeAppointment !== undefined
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
            finalizationStatus: appointmentHolds.finalizationStatus,
            reconciliationMetadata: appointmentHolds.reconciliationMetadata,
            status: appointmentHolds.status,
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

        const [activeAttempt] = await tx
          .select({
            id: bookingPaymentAttempts.id,
            idempotencyKey: bookingPaymentAttempts.idempotencyKey,
            providerPaymentId: bookingPaymentAttempts.providerPaymentId,
            status: bookingPaymentAttempts.status,
          })
          .from(bookingPaymentAttempts)
          .where(
            and(
              eq(bookingPaymentAttempts.holdId, input.holdId),
              eq(bookingPaymentAttempts.operation, "square_charge_and_store"),
              eq(bookingPaymentAttempts.paymentProvider, "square"),
              inArray(bookingPaymentAttempts.status, ["pending", "authorized"]),
            ),
          )
          .orderBy(desc(bookingPaymentAttempts.createdAt))
          .limit(1)
          .for("update");

        const providerEvidenceMatchesActiveAttempt =
          activeAttempt !== undefined &&
          (activeAttempt.providerPaymentId === input.squarePaymentId ||
            (activeAttempt.providerPaymentId === null &&
              input.idempotencyKey !== undefined &&
              activeAttempt.idempotencyKey === input.idempotencyKey));

        const confirmation = metadata.chargeAndStoreConfirmation as
          | Extract<ChargeAndStoreBookingResult, { ok: true }>
          | undefined;
        if (
          hold.status === "booked" ||
          hold.status === "manual_followup" ||
          hold.status === "paid_pending_booking" ||
          hold.status === "manual_rebooked" ||
          hold.status === "paid_unbookable_rebooking_pending" ||
          hold.status === "refunded" ||
          hold.finalizationStatus === "booked" ||
          hold.finalizationStatus === "manual_review" ||
          hold.finalizationStatus === "paid_calendar_pending" ||
          hold.finalizationStatus === "manual_rebooked" ||
          hold.finalizationStatus === "paid_unbookable_rebooking_pending" ||
          hold.finalizationStatus === "refunded" ||
          (activeAttempt !== undefined &&
            (input.providerEvidence === undefined ||
              !providerEvidenceMatchesActiveAttempt)) ||
          confirmation !== undefined ||
          metadata.authoritativeAppointment !== undefined
        ) {
          return {
            status: "booking_outcome_preserved",
            ...(confirmation === undefined ? {} : { confirmation }),
          } as const;
        }

        if (metadata.chargeAndStoreRefundRequired !== undefined) {
          return { status: "refund_required" } as const;
        }

        if (
          activeAttempt !== undefined &&
          providerEvidenceMatchesActiveAttempt &&
          input.providerEvidence !== undefined
        ) {
          await tx
            .update(bookingPaymentAttempts)
            .set({
              authorizedAt:
                input.providerEvidence === "cancellation_unconfirmed"
                  ? activeAttempt.status === "authorized"
                    ? undefined
                    : input.now
                  : undefined,
              capturedAt:
                input.providerEvidence === "completed" ? input.now : undefined,
              providerPaymentId:
                activeAttempt.providerPaymentId ?? input.squarePaymentId,
              status:
                input.providerEvidence === "completed"
                  ? "captured"
                  : "authorized",
              updatedAt: input.now,
            })
            .where(eq(bookingPaymentAttempts.id, activeAttempt.id));
        }

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
                providerEvidence: input.providerEvidence,
                reason: input.reason,
                markedAt: input.now.toISOString(),
              },
            },
            updatedAt: input.now,
          })
          .where(eq(appointmentHolds.id, input.holdId));

        return { status: "refund_required" } as const;
      });
    },
  };
}

function readExpectedReservedResourceIds(
  offeringSnapshot: Record<string, unknown>,
): string[] {
  const resourceIds = offeringSnapshot.reservedResourceIds;
  const expectedCount = offeringSnapshot.reservedResourceCount;
  if (
    !Array.isArray(resourceIds) ||
    resourceIds.length === 0 ||
    !resourceIds.every(
      (resourceId): resourceId is string =>
        typeof resourceId === "string" && resourceId.length > 0,
    ) ||
    !Number.isInteger(expectedCount) ||
    expectedCount !== resourceIds.length ||
    new Set(resourceIds).size !== resourceIds.length
  ) {
    throw new Error("Operational hold has an invalid reserved-resource set");
  }

  return [...resourceIds].sort((first, second) => first.localeCompare(second));
}

function reservationsMatchExpectedResources(
  reservations: Array<typeof bookingResourceReservations.$inferSelect>,
  expectedResourceIds: string[],
  now: Date,
): boolean {
  const actualResourceIds = reservations
    .map((reservation) => reservation.resourceId)
    .sort((first, second) => first.localeCompare(second));

  return (
    reservations.length === expectedResourceIds.length &&
    reservations.every(
      (reservation) =>
        reservation.kind === "hold" &&
        reservation.state === "active" &&
        reservation.expiresAt !== null &&
        reservation.expiresAt > now,
    ) &&
    actualResourceIds.every(
      (resourceId, index) => resourceId === expectedResourceIds[index],
    )
  );
}

function readSquareRequestIntent(value: unknown):
  | {
      referenceId: string;
      requestBodyHash: string;
      sourceIdHash: string;
      squareCustomerId: string;
      squareTeamMemberId?: string;
      verificationTokenHash?: string;
    }
  | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const intent = (value as Record<string, unknown>).squareRequestIntent;
  if (intent === null || typeof intent !== "object") return undefined;
  const record = intent as Record<string, unknown>;
  if (
    typeof record.referenceId !== "string" ||
    typeof record.requestBodyHash !== "string" ||
    typeof record.sourceIdHash !== "string" ||
    typeof record.squareCustomerId !== "string" ||
    (record.squareTeamMemberId !== undefined &&
      typeof record.squareTeamMemberId !== "string") ||
    (record.verificationTokenHash !== undefined &&
      typeof record.verificationTokenHash !== "string")
  ) {
    return undefined;
  }

  return {
    referenceId: record.referenceId,
    requestBodyHash: record.requestBodyHash,
    sourceIdHash: record.sourceIdHash,
    squareCustomerId: record.squareCustomerId,
    ...(record.squareTeamMemberId === undefined
      ? {}
      : { squareTeamMemberId: record.squareTeamMemberId }),
    ...(record.verificationTokenHash === undefined
      ? {}
      : { verificationTokenHash: record.verificationTokenHash }),
  };
}

function toBookingHoldRecord(
  row: typeof appointmentHolds.$inferSelect,
): BookingHoldRecord {
  return {
    bookingModelVersion: row.bookingModelVersion,
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
    calendarAssignmentId: row.calendarAssignmentId,
    googleCalendarId: row.googleCalendarId,
    occupiedEnd: row.occupiedEnd,
    occupiedStart: row.occupiedStart,
    primaryResourceId: row.primaryResourceId,
    providerId: row.providerId,
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
    squareTeamMemberId: row.squareTeamMemberId,
  };
}
