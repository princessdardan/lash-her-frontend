import "server-only";

import { eq } from "drizzle-orm";

import {
  bookingServices,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

interface LockedService {
  ownerProviderId: string | null;
}

export async function runServiceOfferingOwnershipMutation<T>(
  tx: AdminWriteTransaction,
  input: {
    mutate: (service: LockedService) => Promise<T>;
    serviceId: string;
    updatedByAdminUserId?: string;
  },
): Promise<T> {
  const [service] = await tx
    .select({
      id: bookingServices.id,
      ownerProviderId: bookingServices.ownerProviderId,
    })
    .from(bookingServices)
    .where(eq(bookingServices.id, input.serviceId))
    .limit(1)
    .for("update");
  if (!service) throw new Error("Booking service not found");

  const result = await input.mutate(service);
  const providers = await tx
    .selectDistinct({ providerId: bookingServiceOfferings.providerId })
    .from(bookingServiceOfferings)
    .where(eq(bookingServiceOfferings.serviceId, service.id))
    .limit(2);
  const ownerProviderId =
    providers.length === 1 ? providers[0].providerId : null;

  await tx
    .update(bookingServices)
    .set({
      ownerProviderId,
      updatedAt: new Date(),
      ...(input.updatedByAdminUserId
        ? { updatedByAdminUserId: input.updatedByAdminUserId }
        : {}),
    })
    .where(eq(bookingServices.id, service.id));

  return result;
}
