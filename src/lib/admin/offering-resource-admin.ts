import "server-only";

import { and, eq } from "drizzle-orm";

import {
  bookingResources,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export async function assignOfferingResourceInTransaction(
  tx: AdminWriteTransaction,
  input: { isRequired: boolean; offeringId: string; resourceId: string },
): Promise<{ id: string }> {
  const [[offering], [resource]] = await Promise.all([
    tx
      .select({
        id: bookingServiceOfferings.id,
        primaryResourceId: bookingServiceOfferings.primaryResourceId,
      })
      .from(bookingServiceOfferings)
      .where(eq(bookingServiceOfferings.id, input.offeringId))
      .limit(1)
      .for("update"),
    tx
      .select({ id: bookingResources.id, kind: bookingResources.kind })
      .from(bookingResources)
      .where(eq(bookingResources.id, input.resourceId))
      .limit(1)
      .for("update"),
  ]);
  if (offering === undefined) throw new Error("Service offering not found");
  if (resource === undefined) throw new Error("Booking resource not found");
  if (offering.primaryResourceId === resource.id) {
    throw new Error("The primary provider resource is already required");
  }

  const [relationship] = await tx
    .insert(bookingServiceOfferingResources)
    .values({
      isRequired: input.isRequired,
      offeringId: offering.id,
      resourceId: resource.id,
      role: resource.kind,
    })
    .onConflictDoUpdate({
      target: [
        bookingServiceOfferingResources.offeringId,
        bookingServiceOfferingResources.resourceId,
      ],
      set: { isRequired: input.isRequired, role: resource.kind },
    })
    .returning({ id: bookingServiceOfferingResources.id });
  if (relationship === undefined) {
    throw new Error("Offering resource assignment was not saved");
  }
  return relationship;
}

export async function removeOfferingResourceInTransaction(
  tx: AdminWriteTransaction,
  input: { offeringId: string; resourceId: string },
): Promise<{ id: string }> {
  // Relationship removal is snapshot-safe: existing holds and appointments
  // retain their immutable resource snapshots and reservation rows. Only
  // future holds stop requiring this resource.
  const [relationship] = await tx
    .select({ id: bookingServiceOfferingResources.id })
    .from(bookingServiceOfferingResources)
    .where(
      and(
        eq(bookingServiceOfferingResources.offeringId, input.offeringId),
        eq(bookingServiceOfferingResources.resourceId, input.resourceId),
      ),
    )
    .limit(1)
    .for("update");
  if (relationship === undefined) {
    throw new Error("Offering resource assignment was not found");
  }
  await tx
    .delete(bookingServiceOfferingResources)
    .where(eq(bookingServiceOfferingResources.id, relationship.id));
  return relationship;
}
