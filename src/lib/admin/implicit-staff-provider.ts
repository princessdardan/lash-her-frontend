import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import {
  adminUserResources,
  bookingBusinessSettings,
  bookingProviders,
  bookingResources,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

const DEFAULT_TIMEZONE = "America/Toronto";

export async function createImplicitStaffProvider(
  tx: AdminWriteTransaction,
  input: {
    adminUserId: string;
    createdByAdminUserId: string | null;
    displayName: string | null;
    email: string;
  },
): Promise<{ providerId: string; resourceId: string }> {
  const [settings] = await tx
    .select({ timezone: bookingBusinessSettings.timezone })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);
  const name = getImplicitProviderName(input.displayName, input.email);
  const key = getImplicitProviderKey(input.adminUserId);
  const [resource] = await tx
    .insert(bookingResources)
    .values({
      createdByAdminUserId: input.createdByAdminUserId,
      kind: "provider",
      name,
      resourceKey: key,
      status: "draft",
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
      updatedByAdminUserId: input.createdByAdminUserId,
    })
    .returning({ id: bookingResources.id });

  const [provider] = await tx
    .insert(bookingProviders)
    .values({
      createdByAdminUserId: input.createdByAdminUserId,
      displayName: name,
      primaryResourceId: resource.id,
      providerKey: key,
      publicSlug: getImplicitProviderSlug(name, input.adminUserId),
      status: "draft",
      updatedByAdminUserId: input.createdByAdminUserId,
    })
    .returning({ id: bookingProviders.id });

  await tx.insert(adminUserResources).values({
    adminUserId: input.adminUserId,
    bookingResourceId: resource.id,
    createdByAdminUserId: input.createdByAdminUserId,
  });

  return { providerId: provider.id, resourceId: resource.id };
}

export async function syncImplicitStaffProviderName(
  tx: AdminWriteTransaction,
  input: {
    adminUserId: string;
    displayName: string | null;
    email: string;
  },
): Promise<void> {
  const name = getImplicitProviderName(input.displayName, input.email);
  const assignedProviderResources = await tx
    .select({ id: adminUserResources.bookingResourceId })
    .from(adminUserResources)
    .innerJoin(
      bookingResources,
      eq(bookingResources.id, adminUserResources.bookingResourceId),
    )
    .where(
      and(
        eq(adminUserResources.adminUserId, input.adminUserId),
        eq(bookingResources.kind, "provider"),
      ),
    );
  const resourceIds = assignedProviderResources.map((resource) => resource.id);
  if (resourceIds.length === 0) return;

  await tx
    .update(bookingResources)
    .set({ name, updatedAt: new Date() })
    .where(inArray(bookingResources.id, resourceIds));
  await tx
    .update(bookingProviders)
    .set({ displayName: name, updatedAt: new Date() })
    .where(inArray(bookingProviders.primaryResourceId, resourceIds));
}

export function getImplicitProviderKey(adminUserId: string): string {
  return `staff-${adminUserId.toLowerCase().replaceAll("-", "")}`;
}

export function getImplicitProviderName(
  displayName: string | null | undefined,
  email: string,
): string {
  const name = displayName?.trim();
  if (name) return name;

  const emailName = email.trim().split("@", 1)[0]?.trim();
  return emailName || "Team member";
}

export function getImplicitProviderSlug(
  name: string,
  adminUserId: string,
): string {
  const normalizedName = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = adminUserId.toLowerCase().replaceAll("-", "").slice(0, 8);

  return `${normalizedName || "team-member"}-${suffix}`;
}
