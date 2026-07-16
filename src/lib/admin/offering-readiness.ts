import type { BookingConfigurationStatus } from "@/lib/private-db/schema";

export interface OfferingActivationReadiness {
  activeAddOnsArePubliclyValid: boolean;
  hasActiveBookingCalendar: boolean;
  hasActiveWeeklySchedule: boolean;
  provider: {
    displayName: string;
    primaryResourceId: string;
    publicSlug: string | null;
    status: BookingConfigurationStatus;
  };
  resource: {
    id: string;
    status: BookingConfigurationStatus;
  };
  requiredSecondaryResources: Array<{
    hasActiveWeeklySchedule: boolean;
    name: string;
    status: BookingConfigurationStatus;
  }>;
  service: {
    publicSlug: string | null;
    sanityDocumentId: string | null;
    status: BookingConfigurationStatus;
  };
}

export interface PublicAddOnReadiness {
  addOnKey: string;
  description: string | null;
  durationDeltaMinutes: number;
  name: string;
  priceCents: number;
}

export function getOfferingActivationBlockers(
  readiness: OfferingActivationReadiness,
): string[] {
  const blockers: string[] = [];

  if (readiness.provider.status !== "active") blockers.push("activate the provider");
  if (!readiness.provider.displayName.trim()) blockers.push("add the provider display name");
  if (!readiness.provider.publicSlug?.trim()) blockers.push("link the provider public slug");
  if (readiness.resource.status !== "active") blockers.push("activate the primary resource");
  if (readiness.provider.primaryResourceId !== readiness.resource.id) {
    blockers.push("repair the provider primary-resource link");
  }
  if (readiness.service.status !== "active") blockers.push("activate the service");
  if (!readiness.service.sanityDocumentId?.trim()) blockers.push("link the Sanity service document");
  if (!readiness.service.publicSlug?.trim()) blockers.push("link the service public slug");
  if (!readiness.hasActiveWeeklySchedule) blockers.push("add an active weekly schedule");
  if (!readiness.hasActiveBookingCalendar) blockers.push("assign an active booking calendar");
  for (const resource of readiness.requiredSecondaryResources) {
    if (resource.status !== "active") {
      blockers.push(`activate required resource ${resource.name}`);
    }
    if (!resource.hasActiveWeeklySchedule) {
      blockers.push(
        `add an active weekly schedule for required resource ${resource.name}`,
      );
    }
  }
  if (!readiness.activeAddOnsArePubliclyValid) {
    blockers.push("complete every active add-on name, key, description, price, and duration");
  }

  return blockers;
}

export function isPublicAddOnReady(addOn: PublicAddOnReadiness): boolean {
  return addOn.addOnKey.trim().length > 0
    && addOn.name.trim().length > 0
    && Boolean(addOn.description?.trim())
    && Number.isSafeInteger(addOn.priceCents)
    && addOn.priceCents > 0
    && Number.isSafeInteger(addOn.durationDeltaMinutes)
    && addOn.durationDeltaMinutes >= 0;
}
