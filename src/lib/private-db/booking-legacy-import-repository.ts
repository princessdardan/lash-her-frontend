import "server-only";

import { eq, sql } from "drizzle-orm";

import type { LegacyBookingImportPlan } from "@/lib/booking/operations/legacy-import-plan";

import { getPrivateDb } from "./client";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingResources,
  bookingResourceSchedules,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferings,
} from "./schema";

export interface LegacyBookingImportResult {
  offeringCount: number;
  providerId: string;
  resourceId: string;
  scheduleCount: number;
  serviceCount: number;
}

/**
 * Idempotently stages legacy Sanity booking configuration in PostgreSQL.
 * New resources/providers/services/offerings remain draft until the owner has
 * connected a canonical calendar and confirms readiness in Admin.
 */
export async function importLegacyBookingConfiguration(input: {
  actorAdminUserId?: string;
  plan: LegacyBookingImportPlan;
  db?: ReturnType<typeof getPrivateDb>;
}): Promise<LegacyBookingImportResult> {
  const db = input.db ?? getPrivateDb();
  const now = new Date();
  const actorColumns = input.actorAdminUserId
    ? {
        createdByAdminUserId: input.actorAdminUserId,
        updatedByAdminUserId: input.actorAdminUserId,
      }
    : {};

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('lash-her:legacy-booking-import', 0))`,
    );
    await tx
      .insert(bookingBusinessSettings)
      .values({
        ...input.plan.businessSettings,
        singletonKey: "default",
        ...(input.actorAdminUserId
          ? { updatedByAdminUserId: input.actorAdminUserId }
          : {}),
      })
      .onConflictDoNothing({ target: bookingBusinessSettings.singletonKey });

    const [resource] = await tx
      .insert(bookingResources)
      .values({
        ...input.plan.resource,
        ...actorColumns,
        status: "draft",
      })
      .onConflictDoUpdate({
        target: bookingResources.resourceKey,
        set: {
          name: input.plan.resource.name,
          timezone: input.plan.resource.timezone,
          updatedAt: now,
          ...(input.actorAdminUserId
            ? { updatedByAdminUserId: input.actorAdminUserId }
            : {}),
        },
      })
      .returning({ id: bookingResources.id });

    if (!resource) throw new Error("Legacy provider resource was not imported");

    const [provider] = await tx
      .insert(bookingProviders)
      .values({
        ...input.plan.provider,
        ...actorColumns,
        primaryResourceId: resource.id,
        status: "draft",
      })
      .onConflictDoUpdate({
        target: bookingProviders.providerKey,
        set: {
          displayName: input.plan.provider.displayName,
          primaryResourceId: resource.id,
          publicSlug: input.plan.provider.publicSlug,
          updatedAt: now,
          ...(input.actorAdminUserId
            ? { updatedByAdminUserId: input.actorAdminUserId }
            : {}),
        },
      })
      .returning({ id: bookingProviders.id });

    if (!provider) throw new Error("Legacy provider was not imported");

    const [existingSchedule] = await tx
      .select({ id: bookingResourceSchedules.id })
      .from(bookingResourceSchedules)
      .where(eq(bookingResourceSchedules.resourceId, resource.id))
      .limit(1);
    let scheduleCount = 0;

    if (!existingSchedule) {
      const schedules = await tx
        .insert(bookingResourceSchedules)
        .values(
          input.plan.schedules.map((schedule) => ({
            ...schedule,
            ...actorColumns,
            resourceId: resource.id,
            status: "active" as const,
          })),
        )
        .returning({ id: bookingResourceSchedules.id });
      scheduleCount = schedules.length;
    }

    for (const offeringPlan of input.plan.offerings) {
      const [service] = await tx
        .insert(bookingServices)
        .values({
          ...offeringPlan.service,
          ...actorColumns,
          status: "draft",
        })
        .onConflictDoUpdate({
          target: bookingServices.serviceKey,
          set: {
            displayTitle: offeringPlan.service.displayTitle,
            publicSlug: offeringPlan.service.publicSlug,
            sanityDocumentId: offeringPlan.service.sanityDocumentId,
            updatedAt: now,
            ...(input.actorAdminUserId
              ? { updatedByAdminUserId: input.actorAdminUserId }
              : {}),
          },
        })
        .returning({ id: bookingServices.id });

      if (!service) throw new Error("Legacy service was not imported");

      const [offering] = await tx
        .insert(bookingServiceOfferings)
        .values({
          bufferAfterMinutes: offeringPlan.bufferAfterMinutes,
          bufferBeforeMinutes: offeringPlan.bufferBeforeMinutes,
          depositAmountCents: offeringPlan.depositAmountCents,
          durationMinutes: offeringPlan.durationMinutes,
          fullPriceCents: offeringPlan.fullPriceCents,
          offeringKey: offeringPlan.offeringKey,
          primaryResourceId: resource.id,
          providerId: provider.id,
          serviceId: service.id,
          slotIntervalMinutes: offeringPlan.slotIntervalMinutes,
          status: "draft",
          ...actorColumns,
        })
        .onConflictDoUpdate({
          target: bookingServiceOfferings.offeringKey,
          set: {
            bufferAfterMinutes: offeringPlan.bufferAfterMinutes,
            bufferBeforeMinutes: offeringPlan.bufferBeforeMinutes,
            depositAmountCents: offeringPlan.depositAmountCents,
            durationMinutes: offeringPlan.durationMinutes,
            fullPriceCents: offeringPlan.fullPriceCents,
            primaryResourceId: resource.id,
            providerId: provider.id,
            serviceId: service.id,
            slotIntervalMinutes: offeringPlan.slotIntervalMinutes,
            updatedAt: now,
            ...(input.actorAdminUserId
              ? { updatedByAdminUserId: input.actorAdminUserId }
              : {}),
          },
        })
        .returning({ id: bookingServiceOfferings.id });

      if (!offering) throw new Error("Legacy service offering was not imported");

      for (const [displayOrder, addOn] of offeringPlan.addOns.entries()) {
        await tx
          .insert(bookingServiceOfferingAddOns)
          .values({
            ...addOn,
            displayOrder,
            offeringId: offering.id,
            status: "active",
          })
          .onConflictDoUpdate({
            target: [
              bookingServiceOfferingAddOns.offeringId,
              bookingServiceOfferingAddOns.addOnKey,
            ],
            set: {
              description: addOn.description,
              displayOrder,
              durationDeltaMinutes: addOn.durationDeltaMinutes,
              name: addOn.name,
              priceCents: addOn.priceCents,
              status: "active",
              updatedAt: now,
            },
          });
      }
    }

    return {
      offeringCount: input.plan.offerings.length,
      providerId: provider.id,
      resourceId: resource.id,
      scheduleCount,
      serviceCount: input.plan.offerings.length,
    };
  });
}
