import "server-only";

import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";

import { lockSquareAttributionInvariantShared } from "@/lib/admin/square-attribution-invariant";
import type { ResolvedOperationalBooking } from "@/lib/booking/operations/offering";
import type { BookingAnswerInput } from "@/lib/booking/types";

import { getPrivateDb } from "./client";
import {
  appointmentHolds,
  bookingPaymentAttempts,
  bookingBusinessSettings,
  bookingProviders,
  bookingResourceReservations,
  bookingServiceOfferingResources,
  type AppointmentHoldCustomerSnapshot,
  type PaymentProvider,
} from "./schema";

const ACTIVE_HOLD_STATUSES = [
  "held",
  "payment_pending",
  "paid_pending_booking",
] as const;

export interface CreateV2BookingHoldInput {
  answers?: BookingAnswerInput[];
  booking: ResolvedOperationalBooking;
  customer: AppointmentHoldCustomerSnapshot;
  expiresAt: Date;
  legacyOfferingId?: string;
  marketingOptInLabel: string;
  now: Date;
  paymentProvider?: PaymentProvider;
  paymentSessionReference?: string;
  publicReference?: string;
}

export type CreateV2BookingHoldResult =
  | {
      ok: true;
      hold: typeof appointmentHolds.$inferSelect;
      resourceIds: string[];
    }
  | {
      ok: false;
      reason: "slot_conflict" | "square_team_attribution_required";
    };

export interface BookingReservationBusyWindow {
  appointmentId: string | null;
  end: Date;
  holdId: string | null;
  id: string;
  kind: "hold" | "appointment" | "block";
  resourceId: string;
  scheduleExceptionId: string | null;
  start: Date;
}

export interface BookingReservationRepository {
  createV2Hold(
    input: CreateV2BookingHoldInput,
  ): Promise<CreateV2BookingHoldResult>;
  listActiveBusyWindows(input: {
    now: Date;
    resourceId: string;
    timeMax: Date;
    timeMin: Date;
  }): Promise<BookingReservationBusyWindow[]>;
  releaseReservationsForHold(input: {
    holdId: string;
    now: Date;
    reason: string;
  }): Promise<number>;
}

export function createDrizzleBookingReservationRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): BookingReservationRepository {
  return {
    async createV2Hold(input) {
      validateCreateInput(input);

      try {
        return await db.transaction(async (tx) => {
          await lockSquareAttributionInvariantShared(tx);

          const [[settings], [provider]] = await Promise.all([
            tx
              .select({
                required: bookingBusinessSettings.requireSquareTeamAttribution,
              })
              .from(bookingBusinessSettings)
              .where(eq(bookingBusinessSettings.singletonKey, "default"))
              .limit(1),
            tx
              .select({
                squareTeamMemberId: bookingProviders.squareTeamMemberId,
                squareTeamMemberStatus: bookingProviders.squareTeamMemberStatus,
                squareTeamMemberVerifiedAt:
                  bookingProviders.squareTeamMemberVerifiedAt,
              })
              .from(bookingProviders)
              .where(eq(bookingProviders.id, input.booking.providerId))
              .limit(1),
          ]);
          const squareTeamMemberId =
            provider?.squareTeamMemberId !== null &&
            provider?.squareTeamMemberId !== undefined &&
            provider.squareTeamMemberStatus === "active" &&
            provider.squareTeamMemberVerifiedAt !== null
              ? provider.squareTeamMemberId
              : null;
          if (
            settings?.required === true &&
            (squareTeamMemberId === null ||
              input.booking.squareTeamMemberId !== squareTeamMemberId)
          ) {
            return {
              ok: false,
              reason: "square_team_attribution_required",
            } as const;
          }

          const requiredResourceRows = await tx
            .select({
              resourceId: bookingServiceOfferingResources.resourceId,
            })
            .from(bookingServiceOfferingResources)
            .where(
              and(
                eq(
                  bookingServiceOfferingResources.offeringId,
                  input.booking.offeringId,
                ),
                eq(bookingServiceOfferingResources.isRequired, true),
              ),
            );
          const resourceIds = sortUniqueResourceIds([
            input.booking.resourceId,
            ...requiredResourceRows.map((row) => row.resourceId),
          ]);

          for (const resourceId of resourceIds) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${resourceId}::text, 0))`,
            );
          }

          const expiredReservationRows = await tx
            .select({ holdId: bookingResourceReservations.holdId })
            .from(bookingResourceReservations)
            .where(
              and(
                inArray(bookingResourceReservations.resourceId, resourceIds),
                eq(bookingResourceReservations.kind, "hold"),
                eq(bookingResourceReservations.state, "active"),
                isNotNull(bookingResourceReservations.holdId),
                isNotNull(bookingResourceReservations.expiresAt),
                lte(bookingResourceReservations.expiresAt, input.now),
                notExists(
                  tx
                    .select({ id: appointmentHolds.id })
                    .from(appointmentHolds)
                    .where(
                      and(
                        eq(
                          appointmentHolds.id,
                          bookingResourceReservations.holdId,
                        ),
                        gt(appointmentHolds.captureLeaseExpiresAt, input.now),
                      ),
                    ),
                ),
                notExists(
                  tx
                    .select({ id: bookingPaymentAttempts.id })
                    .from(bookingPaymentAttempts)
                    .where(
                      and(
                        eq(
                          bookingPaymentAttempts.holdId,
                          bookingResourceReservations.holdId,
                        ),
                        eq(
                          bookingPaymentAttempts.operation,
                          "square_charge_and_store",
                        ),
                        inArray(bookingPaymentAttempts.status, [
                          "authorized",
                          "captured",
                        ]),
                      ),
                    ),
                ),
              ),
            );
          const expiredHoldIds = sortUniqueResourceIds(
            expiredReservationRows.flatMap((row) =>
              row.holdId === null ? [] : [row.holdId],
            ),
          );

          if (expiredHoldIds.length > 0) {
            await tx
              .update(appointmentHolds)
              .set({
                expiredAt: input.now,
                status: "expired",
                updatedAt: input.now,
              })
              .where(
                and(
                  inArray(appointmentHolds.id, expiredHoldIds),
                  inArray(appointmentHolds.status, [...ACTIVE_HOLD_STATUSES]),
                ),
              );

            await tx
              .update(bookingResourceReservations)
              .set({
                releaseReason: "hold_expired",
                releasedAt: input.now,
                state: "released",
                updatedAt: input.now,
              })
              .where(
                and(
                  inArray(bookingResourceReservations.holdId, expiredHoldIds),
                  eq(bookingResourceReservations.kind, "hold"),
                  eq(bookingResourceReservations.state, "active"),
                ),
              );
          }

          const [hold] = await tx
            .insert(appointmentHolds)
            .values({
              bookingModelVersion: 2,
              bookingType: "in-person-appointment",
              calendarAssignmentId: input.booking.calendar.assignmentId,
              configurationVersion: input.booking.configurationVersion,
              createdAt: input.now,
              customerSnapshot: { ...input.customer },
              expiresAt: input.expiresAt,
              googleCalendarId: input.booking.calendar.calendarId,
              occupiedEnd: input.booking.occupiedEnd,
              occupiedStart: input.booking.occupiedStart,
              offeringId:
                input.legacyOfferingId ??
                input.booking.serviceSnapshot.sanityDocumentId ??
                input.booking.offeringKey,
              offeringSnapshot: createOfferingSnapshot(
                input.booking,
                input.answers ?? [],
                input.marketingOptInLabel,
                resourceIds,
              ),
              paymentProvider: input.paymentProvider ?? "square",
              paymentSessionReference:
                input.paymentSessionReference ??
                generatePaymentSessionReference(),
              primaryResourceId: input.booking.resourceId,
              providerId: input.booking.providerId,
              providerSnapshot: { ...input.booking.providerSnapshot },
              squareTeamMemberId,
              publicReference:
                input.publicReference ?? generateAppointmentHoldReference(),
              selectedEnd: input.booking.selectedEnd,
              selectedStart: input.booking.selectedStart,
              serviceOfferingId: input.booking.offeringId,
              status: "held",
              timezone: input.booking.timezone,
              updatedAt: input.now,
            })
            .returning();

          await tx.insert(bookingResourceReservations).values(
            resourceIds.map((resourceId) => ({
              createdAt: input.now,
              expiresAt: input.expiresAt,
              holdId: hold.id,
              kind: "hold" as const,
              occupiedEnd: input.booking.occupiedEnd,
              occupiedStart: input.booking.occupiedStart,
              resourceId,
              state: "active" as const,
              updatedAt: input.now,
            })),
          );

          return { ok: true, hold, resourceIds };
        });
      } catch (error) {
        if (getPostgresErrorCode(error) === "23P01") {
          return { ok: false, reason: "slot_conflict" };
        }

        throw error;
      }
    },

    async listActiveBusyWindows(input) {
      return db
        .select({
          appointmentId: bookingResourceReservations.appointmentId,
          end: bookingResourceReservations.occupiedEnd,
          holdId: bookingResourceReservations.holdId,
          id: bookingResourceReservations.id,
          kind: bookingResourceReservations.kind,
          resourceId: bookingResourceReservations.resourceId,
          scheduleExceptionId: bookingResourceReservations.scheduleExceptionId,
          start: bookingResourceReservations.occupiedStart,
        })
        .from(bookingResourceReservations)
        .where(
          and(
            eq(bookingResourceReservations.resourceId, input.resourceId),
            eq(bookingResourceReservations.state, "active"),
            lt(bookingResourceReservations.occupiedStart, input.timeMax),
            gt(bookingResourceReservations.occupiedEnd, input.timeMin),
            or(
              ne(bookingResourceReservations.kind, "hold"),
              gt(bookingResourceReservations.expiresAt, input.now),
              exists(
                db
                  .select({ id: appointmentHolds.id })
                  .from(appointmentHolds)
                  .where(
                    and(
                      eq(
                        appointmentHolds.id,
                        bookingResourceReservations.holdId,
                      ),
                      gt(appointmentHolds.captureLeaseExpiresAt, input.now),
                    ),
                  ),
              ),
              exists(
                db
                  .select({ id: bookingPaymentAttempts.id })
                  .from(bookingPaymentAttempts)
                  .where(
                    and(
                      eq(
                        bookingPaymentAttempts.holdId,
                        bookingResourceReservations.holdId,
                      ),
                      eq(
                        bookingPaymentAttempts.operation,
                        "square_charge_and_store",
                      ),
                      inArray(bookingPaymentAttempts.status, [
                        "authorized",
                        "captured",
                      ]),
                    ),
                  ),
              ),
            ),
          ),
        );
    },

    async releaseReservationsForHold(input) {
      const released = await db
        .update(bookingResourceReservations)
        .set({
          releaseReason: input.reason,
          releasedAt: input.now,
          state: "released",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(bookingResourceReservations.holdId, input.holdId),
            eq(bookingResourceReservations.kind, "hold"),
            eq(bookingResourceReservations.state, "active"),
          ),
        )
        .returning({ id: bookingResourceReservations.id });

      return released.length;
    },
  };
}

function createOfferingSnapshot(
  booking: ResolvedOperationalBooking,
  answers: BookingAnswerInput[],
  marketingOptInLabel: string,
  reservedResourceIds: string[],
): Record<string, unknown> {
  const addOnPrice = booking.pricing.addOnPriceCents / 100;
  const depositAmount = booking.pricing.depositAmountCents / 100;
  const fullPrice = booking.pricing.fullPriceCents / 100;

  return {
    answers: answers.map((answer) => ({ ...answer })),
    bookingModelVersion: 2,
    configurationVersion: booking.configurationVersion,
    currency: booking.pricing.currency,
    customerStatus: "pending",
    durationMinutes: booking.durationMinutes,
    marketingOptInLabel: marketingOptInLabel.trim(),
    offeringId: booking.offeringId,
    offeringKey: booking.offeringKey,
    operationalPricing: { ...booking.pricing },
    paymentStatus: "pending",
    pricing: {
      addOnPrice,
      currency: booking.pricing.currency,
      customAmountMaximum: fullPrice,
      customAmountMinimum: depositAmount,
      depositAmount,
      fullPrice,
    },
    provider: { ...booking.providerSnapshot },
    reservedResourceCount: reservedResourceIds.length,
    reservedResourceIds: [...reservedResourceIds],
    ...(booking.selectedAddOn
      ? {
          operationalSelectedAddOn: { ...booking.selectedAddOn },
          selectedAddOn: {
            currency: booking.pricing.currency,
            description: booking.selectedAddOn.description,
            key: booking.selectedAddOn.key,
            name: booking.selectedAddOn.name,
            price: addOnPrice,
          },
        }
      : {}),
    service: { ...booking.serviceSnapshot },
    ...(booking.serviceSnapshot.publicSlug
      ? { serviceSlug: booking.serviceSnapshot.publicSlug }
      : {}),
    title: `${booking.serviceSnapshot.displayTitle} with ${booking.providerSnapshot.displayName}`,
  };
}

function generateAppointmentHoldReference(): string {
  return `hold_${nanoid(12)}`;
}

function generatePaymentSessionReference(): string {
  return `pay_sess_${nanoid(16)}`;
}

function getPostgresErrorCode(error: unknown): string | null {
  let candidate: unknown = error;

  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") {
      return null;
    }

    if (
      "code" in candidate &&
      typeof (candidate as { code?: unknown }).code === "string"
    ) {
      return (candidate as { code: string }).code;
    }

    candidate = "cause" in candidate ? candidate.cause : null;
  }

  return null;
}

function sortUniqueResourceIds(resourceIds: string[]): string[] {
  return [...new Set(resourceIds)].sort((first, second) =>
    first.localeCompare(second),
  );
}

function validateCreateInput(input: CreateV2BookingHoldInput): void {
  const { booking } = input;

  if (
    booking.bookingModelVersion !== 2 ||
    !isValidDate(input.now) ||
    !isValidDate(input.expiresAt) ||
    input.expiresAt <= input.now ||
    !isValidDate(booking.selectedStart) ||
    !isValidDate(booking.selectedEnd) ||
    booking.selectedEnd <= booking.selectedStart ||
    !isValidDate(booking.occupiedStart) ||
    !isValidDate(booking.occupiedEnd) ||
    booking.occupiedEnd <= booking.occupiedStart ||
    booking.occupiedStart > booking.selectedStart ||
    booking.occupiedEnd < booking.selectedEnd ||
    booking.offeringId.length === 0 ||
    booking.providerId.length === 0 ||
    booking.resourceId.length === 0 ||
    booking.calendar.assignmentId.length === 0 ||
    booking.calendar.calendarId.length === 0 ||
    booking.calendar.calendarId === "primary" ||
    typeof input.marketingOptInLabel !== "string" ||
    input.marketingOptInLabel.trim().length === 0 ||
    !Number.isInteger(booking.configurationVersion) ||
    booking.configurationVersion <= 0
  ) {
    throw new Error("Invalid V2 booking hold input");
  }
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}
