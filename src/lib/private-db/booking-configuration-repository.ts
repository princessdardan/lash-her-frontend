import "server-only";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";

import type {
  OperationalBookingAddOn,
  OperationalBookingOffering,
  OperationalRecordStatus,
} from "@/lib/booking/operations/offering";

import { getPrivateDb } from "./client";
import {
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferings,
} from "./schema";

interface BookingOfferingRow {
  bookingHorizonDays: number | null;
  bookingType: string;
  bufferAfterMinutes: number;
  bufferBeforeMinutes: number;
  calendarAssignmentId: string;
  calendarConnectionId: string;
  currency: string;
  depositAmountCents: number;
  displayOrder: number;
  durationMinutes: number;
  fullPriceCents: number;
  id: string;
  minimumLeadTimeHours: number | null;
  offeringKey: string;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
  providerPublicSlug: string | null;
  providerSquareTeamMemberId: string | null;
  providerSquareTeamMemberStatus: "active" | "inactive" | "missing" | null;
  providerSquareTeamMemberVerifiedAt: Date | null;
  providerStatus: OperationalRecordStatus;
  providerCalendarId: string;
  publicSummary: string | null;
  publicTitle: string | null;
  resourceId: string;
  resourceKey: string;
  resourceName: string;
  resourceStatus: OperationalRecordStatus;
  resourceTimezone: string;
  serviceDisplayTitle: string;
  serviceId: string;
  serviceKey: string;
  servicePublicSlug: string | null;
  serviceSanityDocumentId: string | null;
  serviceStatus: OperationalRecordStatus;
  slotIntervalMinutes: number;
  status: OperationalRecordStatus;
  version: number;
}

export interface BookingConfigurationDefaults {
  bookingHorizonDays: number;
  minimumLeadTimeHours: number;
  requireSquareTeamAttribution: boolean;
}

export interface OperationalBookingConfigurationRepository {
  findActiveOfferingById(input: {
    id: string;
    now: Date;
  }): Promise<OperationalBookingOffering | null>;
  hasActiveOfferingIntent(input: {
    now: Date;
    sanityServiceId?: string;
    servicePublicSlug?: string;
  }): Promise<boolean>;
  listActiveOfferings(input: {
    now: Date;
  }): Promise<OperationalBookingOffering[]>;
  listActiveOfferingsByServicePublicSlug?: (input: {
    now: Date;
    servicePublicSlug: string;
  }) => Promise<OperationalBookingOffering[]>;
  listActiveOfferingsBySanityServiceId(input: {
    now: Date;
    sanityServiceId: string;
    servicePublicSlug?: string;
  }): Promise<OperationalBookingOffering[]>;
}

export function createDrizzleOperationalBookingConfigurationRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): OperationalBookingConfigurationRepository {
  return {
    async findActiveOfferingById(input) {
      if (!isUuid(input.id)) {
        return null;
      }

      const defaults = await loadDefaults();
      const rows = await selectActiveOfferingRows({
        id: input.id,
        now: input.now,
        requireSquareTeamAttribution: defaults.requireSquareTeamAttribution,
      });

      return hydrateOfferings(rows, defaults).then(
        (offerings) => offerings[0] ?? null,
      );
    },
    async hasActiveOfferingIntent(input) {
      const filters = [
        eq(bookingServiceOfferings.status, "active"),
        or(
          isNull(bookingServiceOfferings.effectiveFrom),
          lte(bookingServiceOfferings.effectiveFrom, input.now),
        ),
        or(
          isNull(bookingServiceOfferings.effectiveUntil),
          gt(bookingServiceOfferings.effectiveUntil, input.now),
        ),
      ];

      if (input.sanityServiceId && input.servicePublicSlug) {
        filters.push(
          or(
            eq(bookingServices.sanityDocumentId, input.sanityServiceId),
            eq(bookingServices.publicSlug, input.servicePublicSlug),
          )!,
        );
      } else if (input.sanityServiceId) {
        filters.push(
          eq(bookingServices.sanityDocumentId, input.sanityServiceId),
        );
      } else if (input.servicePublicSlug) {
        filters.push(eq(bookingServices.publicSlug, input.servicePublicSlug));
      }

      const [row] = await db
        .select({ id: bookingServiceOfferings.id })
        .from(bookingServiceOfferings)
        .innerJoin(
          bookingServices,
          eq(bookingServices.id, bookingServiceOfferings.serviceId),
        )
        .where(and(...filters))
        .limit(1);

      return row !== undefined;
    },
    async listActiveOfferings(input) {
      const defaults = await loadDefaults();
      const rows = await selectActiveOfferingRows({
        now: input.now,
        requireSquareTeamAttribution: defaults.requireSquareTeamAttribution,
      });

      return hydrateOfferings(rows, defaults);
    },
    async listActiveOfferingsByServicePublicSlug(input) {
      const defaults = await loadDefaults();
      const rows = await selectActiveOfferingRows({
        now: input.now,
        requireSquareTeamAttribution: defaults.requireSquareTeamAttribution,
        servicePublicSlug: input.servicePublicSlug,
      });

      return hydrateOfferings(rows, defaults);
    },
    async listActiveOfferingsBySanityServiceId(input) {
      const defaults = await loadDefaults();
      const rows = await selectActiveOfferingRows({
        now: input.now,
        requireSquareTeamAttribution: defaults.requireSquareTeamAttribution,
        sanityServiceId: input.sanityServiceId,
        servicePublicSlug: input.servicePublicSlug,
      });

      return hydrateOfferings(rows, defaults);
    },
  };

  async function loadDefaults(): Promise<BookingConfigurationDefaults> {
    const [row] = await db
      .select({
        bookingHorizonDays: bookingBusinessSettings.bookingHorizonDays,
        minimumLeadTimeHours: bookingBusinessSettings.minimumLeadTimeHours,
        requireSquareTeamAttribution:
          bookingBusinessSettings.requireSquareTeamAttribution,
      })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1);

    return (
      row ?? {
        bookingHorizonDays: 30,
        minimumLeadTimeHours: 24,
        requireSquareTeamAttribution: false,
      }
    );
  }

  async function selectActiveOfferingRows(input: {
    id?: string;
    now: Date;
    requireSquareTeamAttribution: boolean;
    sanityServiceId?: string;
    servicePublicSlug?: string;
  }): Promise<BookingOfferingRow[]> {
    const filters = [
      eq(bookingServiceOfferings.status, "active"),
      eq(bookingServices.status, "active"),
      eq(bookingProviders.status, "active"),
      eq(bookingResources.status, "active"),
      eq(bookingResourceCalendarAssignments.status, "active"),
      eq(bookingResourceCalendarAssignments.acceptsBookings, true),
      eq(bookingCalendarConnections.status, "active"),
      or(
        isNull(bookingServiceOfferings.effectiveFrom),
        lte(bookingServiceOfferings.effectiveFrom, input.now),
      ),
      or(
        isNull(bookingServiceOfferings.effectiveUntil),
        gt(bookingServiceOfferings.effectiveUntil, input.now),
      ),
    ];

    if (input.requireSquareTeamAttribution) {
      filters.push(
        isNotNull(bookingProviders.squareTeamMemberId),
        eq(bookingProviders.squareTeamMemberStatus, "active"),
        isNotNull(bookingProviders.squareTeamMemberVerifiedAt),
      );
    }

    if (input.id) {
      filters.push(eq(bookingServiceOfferings.id, input.id));
    }

    if (input.sanityServiceId) {
      filters.push(eq(bookingServices.sanityDocumentId, input.sanityServiceId));
    }

    if (input.servicePublicSlug) {
      filters.push(eq(bookingServices.publicSlug, input.servicePublicSlug));
    }

    return db
      .select({
        bookingHorizonDays: bookingServiceOfferings.bookingHorizonDays,
        bookingType: bookingServiceOfferings.bookingType,
        bufferAfterMinutes: bookingServiceOfferings.bufferAfterMinutes,
        bufferBeforeMinutes: bookingServiceOfferings.bufferBeforeMinutes,
        calendarAssignmentId: bookingResourceCalendarAssignments.id,
        calendarConnectionId:
          bookingResourceCalendarAssignments.calendarConnectionId,
        currency: bookingServiceOfferings.currency,
        depositAmountCents: bookingServiceOfferings.depositAmountCents,
        displayOrder: bookingServiceOfferings.displayOrder,
        durationMinutes: bookingServiceOfferings.durationMinutes,
        fullPriceCents: bookingServiceOfferings.fullPriceCents,
        id: bookingServiceOfferings.id,
        minimumLeadTimeHours: bookingServiceOfferings.minimumLeadTimeHours,
        offeringKey: bookingServiceOfferings.offeringKey,
        providerDisplayName: bookingProviders.displayName,
        providerId: bookingProviders.id,
        providerKey: bookingProviders.providerKey,
        providerPublicSlug: bookingProviders.publicSlug,
        providerSquareTeamMemberId: bookingProviders.squareTeamMemberId,
        providerSquareTeamMemberStatus: bookingProviders.squareTeamMemberStatus,
        providerSquareTeamMemberVerifiedAt:
          bookingProviders.squareTeamMemberVerifiedAt,
        providerStatus: bookingProviders.status,
        providerCalendarId:
          bookingResourceCalendarAssignments.providerCalendarId,
        publicSummary: bookingServiceOfferings.publicSummary,
        publicTitle: bookingServiceOfferings.publicTitle,
        resourceId: bookingResources.id,
        resourceKey: bookingResources.resourceKey,
        resourceName: bookingResources.name,
        resourceStatus: bookingResources.status,
        resourceTimezone: bookingResources.timezone,
        serviceDisplayTitle: bookingServices.displayTitle,
        serviceId: bookingServices.id,
        serviceKey: bookingServices.serviceKey,
        servicePublicSlug: bookingServices.publicSlug,
        serviceSanityDocumentId: bookingServices.sanityDocumentId,
        serviceStatus: bookingServices.status,
        slotIntervalMinutes: bookingServiceOfferings.slotIntervalMinutes,
        status: bookingServiceOfferings.status,
        version: bookingServiceOfferings.version,
      })
      .from(bookingServiceOfferings)
      .innerJoin(
        bookingServices,
        eq(bookingServices.id, bookingServiceOfferings.serviceId),
      )
      .innerJoin(
        bookingProviders,
        eq(bookingProviders.id, bookingServiceOfferings.providerId),
      )
      .innerJoin(
        bookingResources,
        eq(bookingResources.id, bookingServiceOfferings.primaryResourceId),
      )
      .innerJoin(
        bookingResourceCalendarAssignments,
        eq(
          bookingResourceCalendarAssignments.resourceId,
          bookingServiceOfferings.primaryResourceId,
        ),
      )
      .innerJoin(
        bookingCalendarConnections,
        eq(
          bookingCalendarConnections.id,
          bookingResourceCalendarAssignments.calendarConnectionId,
        ),
      )
      .where(and(...filters))
      .orderBy(
        asc(bookingServiceOfferings.displayOrder),
        asc(bookingProviders.displayOrder),
      );
  }

  async function hydrateOfferings(
    rows: BookingOfferingRow[],
    defaults: BookingConfigurationDefaults,
  ): Promise<OperationalBookingOffering[]> {
    if (rows.length === 0) {
      return [];
    }

    const addOnRows = await db
      .select({
        addOnKey: bookingServiceOfferingAddOns.addOnKey,
        description: bookingServiceOfferingAddOns.description,
        durationDeltaMinutes: bookingServiceOfferingAddOns.durationDeltaMinutes,
        name: bookingServiceOfferingAddOns.name,
        offeringId: bookingServiceOfferingAddOns.offeringId,
        priceCents: bookingServiceOfferingAddOns.priceCents,
        status: bookingServiceOfferingAddOns.status,
      })
      .from(bookingServiceOfferingAddOns)
      .where(
        inArray(
          bookingServiceOfferingAddOns.offeringId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(bookingServiceOfferingAddOns.displayOrder));
    const addOnsByOffering = new Map<string, OperationalBookingAddOn[]>();

    for (const addOn of addOnRows) {
      if (addOn.status !== "active") {
        continue;
      }

      const list = addOnsByOffering.get(addOn.offeringId) ?? [];
      list.push({
        description: addOn.description ?? "",
        durationDeltaMinutes: addOn.durationDeltaMinutes,
        key: addOn.addOnKey,
        name: addOn.name,
        priceCents: addOn.priceCents,
        status: "active",
      });
      addOnsByOffering.set(addOn.offeringId, list);
    }

    return rows.flatMap((row) => {
      if (
        row.bookingType !== "in-person-appointment" ||
        row.currency !== "CAD"
      ) {
        return [];
      }

      return [
        {
          addOns: addOnsByOffering.get(row.id) ?? [],
          bookingType: "in-person-appointment" as const,
          bufferAfterMinutes: row.bufferAfterMinutes,
          bufferBeforeMinutes: row.bufferBeforeMinutes,
          calendar: {
            assignmentId: row.calendarAssignmentId,
            calendarId: row.providerCalendarId,
            connectionId: row.calendarConnectionId,
          },
          currency: "CAD" as const,
          depositAmountCents: row.depositAmountCents,
          displayOrder: row.displayOrder,
          durationMinutes: row.durationMinutes,
          fullPriceCents: row.fullPriceCents,
          horizonDays: row.bookingHorizonDays ?? defaults.bookingHorizonDays,
          id: row.id,
          minimumLeadTimeHours:
            row.minimumLeadTimeHours ?? defaults.minimumLeadTimeHours,
          offeringKey: row.offeringKey,
          ...(row.publicSummary ? { publicSummary: row.publicSummary } : {}),
          ...(row.publicTitle ? { publicTitle: row.publicTitle } : {}),
          provider: {
            displayName: row.providerDisplayName,
            id: row.providerId,
            providerKey: row.providerKey,
            ...(row.providerPublicSlug
              ? { publicSlug: row.providerPublicSlug }
              : {}),
            ...(row.providerSquareTeamMemberId &&
            row.providerSquareTeamMemberStatus === "active" &&
            row.providerSquareTeamMemberVerifiedAt
              ? { squareTeamMemberId: row.providerSquareTeamMemberId }
              : {}),
            status: row.providerStatus,
          },
          resource: {
            id: row.resourceId,
            name: row.resourceName,
            resourceKey: row.resourceKey,
            status: row.resourceStatus,
            timezone: row.resourceTimezone,
          },
          service: {
            displayTitle: row.serviceDisplayTitle,
            hasEditorialDetail: Boolean(row.serviceSanityDocumentId?.trim()),
            id: row.serviceId,
            ...(row.servicePublicSlug
              ? { publicSlug: row.servicePublicSlug }
              : {}),
            ...(row.serviceSanityDocumentId
              ? { sanityDocumentId: row.serviceSanityDocumentId }
              : {}),
            serviceKey: row.serviceKey,
            status: row.serviceStatus,
          },
          slotIntervalMinutes: row.slotIntervalMinutes,
          status: row.status,
          version: row.version,
        },
      ];
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
