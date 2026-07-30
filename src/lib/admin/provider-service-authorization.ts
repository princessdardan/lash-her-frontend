import type { AdminActor } from "./types";
import { AdminAuthError } from "./types";

export function hasGlobalProviderServiceAccess(actor: AdminActor): boolean {
  return actor.user.role === "owner" || actor.user.role === "admin";
}

export function canAccessProviderResource(
  actor: AdminActor,
  primaryResourceId: string,
): boolean {
  return (
    hasGlobalProviderServiceAccess(actor) ||
    actor.bookingProviderResourceIds.includes(primaryResourceId)
  );
}

export function assertProviderResourceAccess(
  actor: AdminActor,
  primaryResourceId: string,
): void {
  if (!canAccessProviderResource(actor, primaryResourceId)) {
    throw new AdminAuthError("forbidden");
  }
}

export function assertProviderOwnedServiceAccess(
  actor: AdminActor,
  input: {
    ownerProviderId: string | null;
    ownerProviderPrimaryResourceId: string | null;
    targetProviderId?: string;
  },
): void {
  if (hasGlobalProviderServiceAccess(actor)) {
    return;
  }

  if (
    !input.ownerProviderId ||
    !input.ownerProviderPrimaryResourceId ||
    (input.targetProviderId !== undefined &&
      input.ownerProviderId !== input.targetProviderId)
  ) {
    throw new AdminAuthError("forbidden");
  }

  assertProviderResourceAccess(actor, input.ownerProviderPrimaryResourceId);
}

export function assertProviderOfferingAccess(
  actor: AdminActor,
  input: {
    ownerProviderId: string | null;
    providerId: string;
    providerPrimaryResourceId: string;
  },
): void {
  if (hasGlobalProviderServiceAccess(actor)) {
    return;
  }

  if (
    input.ownerProviderId !== null &&
    input.ownerProviderId !== input.providerId
  ) {
    throw new AdminAuthError("forbidden");
  }

  assertProviderResourceAccess(actor, input.providerPrimaryResourceId);
}
