import "server-only";

import {
  createDrizzleOperationalBookingConfigurationRepository,
  type OperationalBookingConfigurationRepository,
} from "@/lib/private-db/booking-configuration-repository";
import type { TService } from "@/types";

import {
  getServiceBookingModelMode,
  type ServiceBookingModelMode,
} from "./model-mode";
import {
  toPublicBookingOffering,
  type PublicBookingOffering,
  type PublicServiceBookingModel,
} from "./offering";

export interface PublicBookingCatalog {
  offerings: PublicBookingOffering[] | undefined;
  serviceBookingModels: Record<string, PublicServiceBookingModel>;
  services: TService[];
}

/**
 * Resolves the global catalog service by service. Dual mode exposes a service
 * only when it has a usable V2 offering or no active V2 intent and can safely
 * use the V1 fallback. Active-but-unhealthy V2 intent never falls back to V1.
 */
export async function loadPublicBookingCatalog(input: {
  mode?: ServiceBookingModelMode;
  now?: Date;
  repository?: OperationalBookingConfigurationRepository;
  services: TService[];
}): Promise<PublicBookingCatalog> {
  const now = input.now ?? new Date();
  const mode = input.mode ?? getServiceBookingModelMode();

  if (mode === "legacy") {
    return {
      offerings: undefined,
      serviceBookingModels: Object.fromEntries(
        input.services.map((service) => [service.slug, "legacy"] as const),
      ),
      services: input.services,
    };
  }

  const repository =
    input.repository ??
    createDrizzleOperationalBookingConfigurationRepository();
  const paths = await Promise.all(
    input.services.map(async (service) => {
      const offerings = await loadPublicOperationalOfferings({
        mode,
        now,
        repository,
        sanityServiceId: service._id,
        servicePublicSlug: service.slug,
      });

      if (offerings === undefined) {
        return { kind: "legacy" as const, service };
      }

      const matchingOfferings = offerings.filter(
        (offering) => offering.serviceSlug === service.slug,
      );

      return matchingOfferings.length > 0
        ? {
            kind: "operational" as const,
            offerings: matchingOfferings,
            service,
          }
        : { kind: "unavailable" as const, service };
    }),
  );
  const availablePaths = paths.filter((path) => path.kind !== "unavailable");
  const operationalOfferings = availablePaths.flatMap((path) =>
    path.kind === "operational" ? path.offerings : [],
  );
  const hasUnavailableOperationalIntent = paths.some(
    (path) => path.kind === "unavailable",
  );

  return {
    offerings:
      operationalOfferings.length > 0 ||
      mode === "operational" ||
      hasUnavailableOperationalIntent
        ? operationalOfferings
        : undefined,
    serviceBookingModels: Object.fromEntries(
      availablePaths.map((path) => [path.service.slug, path.kind] as const),
    ),
    services: availablePaths.map((path) => path.service),
  };
}

export async function loadPublicOperationalOfferings(
  input: {
    mode?: ServiceBookingModelMode;
    now?: Date;
    repository?: OperationalBookingConfigurationRepository;
    sanityServiceId?: string;
    servicePublicSlug?: string;
  } = {},
): Promise<PublicBookingOffering[] | undefined> {
  const now = input.now ?? new Date();
  const mode = input.mode ?? getServiceBookingModelMode();

  if (mode === "legacy") {
    return undefined;
  }

  const repository =
    input.repository ??
    createDrizzleOperationalBookingConfigurationRepository();
  const operationalOfferings = input.servicePublicSlug
    ? repository.listActiveOfferingsByServicePublicSlug
      ? await repository.listActiveOfferingsByServicePublicSlug({
          now,
          servicePublicSlug: input.servicePublicSlug,
        })
      : (await repository.listActiveOfferings({ now })).filter(
          (offering) => offering.service.publicSlug === input.servicePublicSlug,
        )
    : input.sanityServiceId
      ? await repository.listActiveOfferingsBySanityServiceId({
          now,
          sanityServiceId: input.sanityServiceId,
        })
      : await repository.listActiveOfferings({ now });
  const publicOfferings = operationalOfferings.flatMap((offering) => {
    const projected = toPublicBookingOffering(offering);
    return projected === null ? [] : [projected];
  });

  if (publicOfferings.length === 0) {
    const hasOperationalIntent = await repository.hasActiveOfferingIntent({
      now,
      ...(input.sanityServiceId
        ? { sanityServiceId: input.sanityServiceId }
        : {}),
      ...(input.servicePublicSlug
        ? { servicePublicSlug: input.servicePublicSlug }
        : {}),
    });

    if (hasOperationalIntent || mode === "operational") {
      return [];
    }
  }

  // Only a truly absent V2 intent in dual mode leaves BookingFlow on its
  // unchanged V1 path. Unhealthy/invalid V2 intent returns an empty V2 set,
  // while read failures propagate so outages cannot switch booking models.
  return publicOfferings.length > 0 ? publicOfferings : undefined;
}
